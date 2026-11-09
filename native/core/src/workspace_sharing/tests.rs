use super::*;
use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    thread,
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    root: PathBuf,
    store: Arc<Store>,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "multicc-sharing-core-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        let store =
            Arc::new(Store::open(root.join("shares.json"), root.join("external.json")).unwrap());
        Self { root, store }
    }
    fn create(&self, max: f64) -> V {
        self.store
            .mutate(
                "createShare",
                &V::object(vec![
                    ("id", "workspace".into()),
                    ("directory", true.into()),
                    (
                        "options",
                        V::object(vec![
                            ("password", "password".into()),
                            ("maxAccesses", max.into()),
                        ]),
                    ),
                ]),
                1000.0,
            )
            .unwrap()
    }
    fn verify(&self, token: &V) -> VerifiedAccess {
        self.store
            .verify_password(
                &V::object(vec![
                    ("token", token.clone()),
                    ("password", "password".into()),
                ]),
                1000.0,
            )
            .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
#[test]
fn split_owners_reject_cross_domain_operations_without_writes() {
    let f = Fixture::new();
    let source = Store::open_source(f.root.join("source.json")).unwrap();
    let external = Store::open_external(f.root.join("imported.json")).unwrap();
    assert!(source.query("listExternal", &V::Null, 0.0).is_err());
    assert!(source
        .mutate("removeExternal", &V::string("x"), 0.0)
        .is_err());
    assert!(external.query("listShares", &V::Null, 0.0).is_err());
    assert!(external.mutate("createShare", &V::Null, 0.0).is_err());
    assert!(external.verify_password(&V::Null, 0.0).is_err());
    assert_eq!(
        source.query("listShares", &V::Null, 0.0).unwrap(),
        V::Array(vec![])
    );
    assert_eq!(
        external.query("listExternal", &V::Null, 0.0).unwrap(),
        V::Array(vec![])
    );
    assert_eq!(fs::read_dir(&f.root).unwrap().count(), 0);
}

#[test]
fn password_proofs_are_one_use_and_owner_bound() {
    let f = Fixture::new();
    let other = Fixture::new();
    let record = f.create(3.0);
    let proof = f.verify(get(&record, "token"));
    assert!(other.store.consume_access(proof, true, 1000.0).is_err());
    let proof = f.verify(get(&record, "token"));
    let authorized = f.store.consume_access(proof, true, 1000.0).unwrap();
    // The proof is moved into consume_access; there is no serializable proof
    // handle to replay, and the old string-dispatch bridge is gone.
    assert!(f.store.mutate("consumeAccess", &V::Null, 1000.0).is_err());
    assert!(grant_valid(get(&authorized, "grant")));
    let reopened = Store::open(f.root.join("shares.json"), f.root.join("external.json")).unwrap();
    assert_eq!(
        get(
            &array(
                &reopened
                    .query("listShares", &"workspace".into(), 1000.0)
                    .unwrap()
            )[0],
            "accessCount"
        ),
        &1.0.into()
    );
}

#[tokio::test]
async fn native_import_preserves_commit_order_and_recovers_after_context_failures() {
    use std::sync::atomic::AtomicU8;
    let f = Fixture::new();
    let record = f.create(20.0);
    let token = get(&record, "token").clone();
    let input = V::object(vec![
        ("token", token.clone()),
        ("password", "password".into()),
    ]);
    let mode = AtomicU8::new(0);
    let directory = |id: String| {
        assert_eq!(id, "workspace");
        let mode = mode.load(Ordering::SeqCst);
        let store = Arc::clone(&f.store);
        let token = token.clone();
        async move {
            match mode {
                0 => None,
                1 => std::future::pending().await,
                2 => Some(false),
                7 => {
                    store
                        .mutate(
                            "revokeShare",
                            &V::object(vec![("id", "workspace".into()), ("token", token)]),
                            1000.0,
                        )
                        .unwrap();
                    Some(true)
                }
                _ => Some(true),
            }
        }
    };
    let context = |request: String| {
        assert_eq!(request, r#"{"id":"workspace"}"#);
        let mode = mode.load(Ordering::SeqCst);
        async move {
            match mode {
                3 => None,
                4 => Some("invalid json".into()),
                5 => std::future::pending().await,
                6 => Some(r#"{"directory":{"id":"workspace"},"members":[]}"#.into()),
                _ => panic!("pre-commit errors must not read members"),
            }
        }
    };
    for (state, expected, count) in [
        (0, 500, 0.0),
        (1, 500, 0.0),
        (2, 404, 0.0),
        (3, 500, 1.0),
        (4, 500, 2.0),
        (5, 500, 3.0),
        (6, 200, 4.0),
    ] {
        mode.store(state, Ordering::SeqCst);
        let result = source::import(
            Arc::clone(&f.store),
            input.clone(),
            &directory,
            &context,
            Some(1000.0),
        )
        .await;
        assert_eq!(result.err().map(|e| e.status).unwrap_or(200), expected);
        let reopened = Store::open_source(f.root.join("shares.json")).unwrap();
        let rows = reopened
            .query("listShares", &"workspace".into(), 1000.0)
            .unwrap();
        assert_eq!(get(&array(&rows)[0], "accessCount"), &count.into());
    }
    mode.store(7, Ordering::SeqCst);
    assert_eq!(
        source::import(
            Arc::clone(&f.store),
            input,
            &directory,
            &context,
            Some(1000.0)
        )
        .await
        .unwrap_err()
        .code,
        "SHARE_NOT_FOUND"
    );
}

#[test]
fn revocation_between_password_and_consume_is_final() {
    let f = Fixture::new();
    let record = f.create(3.0);
    let token = get(&record, "token");
    let proof = f.verify(token);
    f.store
        .mutate(
            "revokeShare",
            &V::object(vec![("id", "workspace".into()), ("token", token.clone())]),
            1000.0,
        )
        .unwrap();
    let err = f.store.consume_access(proof, true, 1000.0).unwrap_err();
    assert_eq!(err.code, "SHARE_NOT_FOUND");
    assert_eq!(
        f.store
            .query("listShares", &"workspace".into(), 1000.0)
            .unwrap(),
        V::Array(vec![])
    );
}

#[test]
fn concurrent_workers_share_one_durable_budget() {
    let f = Fixture::new();
    let record = f.create(1.0);
    let token = get(&record, "token");
    let proofs: Vec<_> = (0..4).map(|_| f.verify(token)).collect();
    let threads: Vec<_> = proofs
        .into_iter()
        .map(|proof| {
            let store = f.store.clone();
            thread::spawn(move || store.consume_access(proof, true, 1000.0))
        })
        .collect();
    let results: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert!(results
        .into_iter()
        .filter_map(|r| r.err())
        .all(|e| e.code == "SHARE_EXHAUSTED"));
}

#[test]
fn missing_directory_consumes_no_budget_and_write_failure_publishes_nothing() {
    let f = Fixture::new();
    let record = f.create(3.0);
    let token = get(&record, "token");
    let proof = f.verify(token);
    assert_eq!(
        f.store
            .consume_access(proof, false, 1000.0)
            .unwrap_err()
            .code,
        "FLEET_NOT_FOUND"
    );
    let path = f.root.join("shares.json");
    fs::remove_file(&path).unwrap();
    fs::create_dir(&path).unwrap();
    let proof = f.verify(token);
    assert!(f.store.consume_access(proof, true, 1000.0).is_err());
    let list = f
        .store
        .query("listShares", &"workspace".into(), 1000.0)
        .unwrap();
    assert_eq!(get(&array(&list)[0], "accessCount"), &0.0.into());
}
