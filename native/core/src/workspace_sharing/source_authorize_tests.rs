//! `fleetSharingRuntime.authorizeRequest` (`source::authorize`): the published
//! grant answers path-scoped plans inside the VM, and a session plan is
//! resolved against the live member ids the host port reads — never a cached
//! authorization result. Every failure is a refusal, and a refusal never costs
//! a host read.
use super::*;
use crate::js;
use std::sync::{Arc, Mutex};

fn fixture(expires_at: f64) -> (std::path::PathBuf, Arc<Store>) {
    let root = std::env::temp_dir().join(format!(
        "multicc-source-authorize-{}",
        super::super::random(12).unwrap()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let file = root.join("shares.json");
    std::fs::write(
        &file,
        format!(
            r#"{{"shares":{{"token":{{"token":"token","fleetId":"live","accessGrant":"grant","expiresAt":{expires_at}}}}}}}"#
        ),
    )
    .unwrap();
    (root, Arc::new(Store::open_source(file).unwrap()))
}

fn input(path: &str) -> V {
    V::object(vec![
        ("token", "token".into()),
        ("grant", "grant".into()),
        ("method", "GET".into()),
        ("pathname", V::string(path)),
    ])
}

/// A host context that must not be consulted.
fn absent() -> impl Fn(String) -> std::future::Ready<Option<String>> {
    |_: String| {
        panic!("unexpected host read");
        #[allow(unreachable_code)]
        std::future::ready(None)
    }
}

#[tokio::test]
async fn directory_and_global_plans_are_decided_without_the_host() {
    let (_root, store) = fixture(9_000_000_000_000.0);
    for path in [
        "/api/directories/live/sessions",
        "/api/providers",
        "/api/agent-presets",
        "/api/fleet-shares/token/state",
    ] {
        assert_eq!(
            authorize(&store, input(path), &absent()).await.unwrap(),
            V::Bool(true),
            "{path}"
        );
    }
    // Another workspace is a denial, not a broader match, and still local.
    assert_eq!(
        authorize(&store, input("/api/directories/other/sessions"), &absent())
            .await
            .unwrap(),
        V::Bool(false)
    );
}

#[tokio::test]
async fn session_plans_resolve_against_live_membership() {
    let (_root, store) = fixture(9_000_000_000_000.0);
    let seen = Arc::new(Mutex::new(Vec::new()));
    let members = Arc::new(Mutex::new(V::Array(vec![])));
    let context = {
        let seen = Arc::clone(&seen);
        let members = Arc::clone(&members);
        move |request: String| {
            let seen = Arc::clone(&seen);
            let members = Arc::clone(&members);
            async move {
                seen.lock().unwrap().push(request);
                let snapshot = V::object(vec![("members", members.lock().unwrap().clone())]);
                Some(js::json_stringify(&snapshot).unwrap())
            }
        }
    };
    // The published grant names a workspace, never a session: membership is the
    // live answer, so the same request is a refusal until the member appears.
    assert_eq!(
        authorize(&store, input("/api/sessions/s-1"), &context)
            .await
            .unwrap(),
        V::Bool(false)
    );
    *members.lock().unwrap() = V::Array(vec![V::object(vec![("id", V::string("s-1"))])]);
    assert_eq!(
        authorize(&store, input("/api/sessions/s-1"), &context)
            .await
            .unwrap(),
        V::Bool(true)
    );
    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 2);
    for request in seen.iter() {
        assert_eq!(
            js::json_parse(request).unwrap(),
            V::object(vec![
                ("id", V::string("live")),
                ("membersOnly", V::Bool(true)),
            ])
        );
    }
}

#[tokio::test]
async fn a_failed_membership_read_is_a_refusal_not_an_allow() {
    let (_root, store) = fixture(9_000_000_000_000.0);
    let down = |_: String| async { None };
    let error = authorize(&store, input("/api/sessions/s-1"), &down)
        .await
        .unwrap_err();
    assert_eq!(error.code, "WORKSPACE_SHARING_INTERNAL");
    assert_eq!(error.status, 500);
}

#[tokio::test]
async fn expired_wrong_or_revoked_shares_never_read_the_host() {
    // Expired: the record no longer answers a plan.
    let (_root, expired) = fixture(1_000.0);
    assert_eq!(
        authorize(&expired, input("/api/directories/live/sessions"), &absent())
            .await
            .unwrap(),
        V::Bool(false)
    );

    let (_root, store) = fixture(9_000_000_000_000.0);
    // A grant that does not parse against the published secret.
    let mut wrong = input("/api/directories/live/sessions");
    put(&mut wrong, "grant", V::string("other"));
    assert_eq!(
        authorize(&store, wrong, &absent()).await.unwrap(),
        V::Bool(false)
    );
    // Unknown token.
    let mut unknown = input("/api/directories/live/sessions");
    put(&mut unknown, "token", V::string("other"));
    assert_eq!(
        authorize(&store, unknown, &absent()).await.unwrap(),
        V::Bool(false)
    );

    // Revoked after publish: the same live request is now refused.
    store
        .mutate(
            "revokeShare",
            &V::object(vec![
                ("id", V::string("live")),
                ("token", V::string("token")),
            ]),
            clock(None),
        )
        .unwrap();
    assert_eq!(
        authorize(&store, input("/api/directories/live/sessions"), &absent())
            .await
            .unwrap(),
        V::Bool(false)
    );
    assert_eq!(
        authorize(&store, input("/api/sessions/s-1"), &absent())
            .await
            .unwrap(),
        V::Bool(false)
    );
}
