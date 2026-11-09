use super::*;

fn fixture() -> (std::path::PathBuf, Arc<Store>, Arc<Mutex<AuthRuntime>>) {
    let root = std::env::temp_dir().join(format!(
        "multicc-source-ticket-{}",
        super::super::random(12).unwrap()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let file = root.join("shares.json");
    std::fs::write(&file, r#"{"shares":{"token":{"token":"token","fleetId":"live","accessGrant":"grant","expiresAt":9000000000000}}}"#).unwrap();
    (
        root,
        Arc::new(Store::open_source(file).unwrap()),
        Arc::new(Mutex::new(AuthRuntime::new("secret".into()))),
    )
}
fn input(path: &str, session: V) -> V {
    V::object(vec![
        ("token", "token".into()),
        ("grant", "grant".into()),
        ("pathname", path.into()),
        ("sessionId", session),
        ("directoryId", "live".into()),
    ])
}
fn revoke(store: &Store) {
    store
        .mutate(
            "revokeShare",
            &V::object(vec![("id", "live".into()), ("token", "token".into())]),
            clock(None),
        )
        .unwrap();
}

#[tokio::test]
async fn native_ticket_authority_does_not_read_members_for_workspace_or_invalid_scope() {
    let (root, store, auth) = fixture();
    let absent = |_: String| async {
        panic!("unexpected host read");
        #[allow(unreachable_code)]
        None
    };
    assert_eq!(
        issue_ticket(
            &store,
            None,
            0,
            input("/ws/workspace", V::Undefined),
            &absent
        )
        .await
        .unwrap_err()
        .status,
        501
    );
    let result = issue_ticket(
        &store,
        Some(&auth),
        0,
        input("/ws/workspace", V::Undefined),
        &absent,
    )
    .await
    .unwrap();
    let record = auth
        .lock()
        .unwrap()
        .tickets
        .take(&text(get(&result, "ticket")))
        .unwrap();
    assert_eq!(record.path, "/ws/workspace");
    let Metadata::Native(metadata) = record.metadata else {
        panic!("must retain a native value")
    };
    assert_eq!(get(&metadata, "fleetDirectoryId"), &V::string("live"));
    let mut wrong = input("/ws/chat", "session".into());
    put(&mut wrong, "grant", "wrong".into());
    assert_eq!(
        issue_ticket(&store, Some(&auth), 0, wrong, &absent)
            .await
            .unwrap_err()
            .status,
        403
    );
    for path in ["/ws/test", "//host", "/ws/chat?x=1", "/WS/CHAT", ""] {
        assert_eq!(
            issue_ticket(
                &store,
                Some(&auth),
                0,
                input(path, "session".into()),
                &absent
            )
            .await
            .unwrap_err()
            .status,
            403
        );
    }
    revoke(&store);
    assert_eq!(
        issue_ticket(
            &store,
            Some(&auth),
            0,
            input("/ws/workspace", V::Null),
            &absent
        )
        .await
        .unwrap_err()
        .status,
        403
    );
    assert_eq!(auth.lock().unwrap().tickets.len(), 0);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn native_ticket_rechecks_revocation_rotation_shutdown_and_failed_member_reads() {
    for mode in 0..8 {
        let (root, store, auth) = fixture();
        let context = |request: String| {
            let store = Arc::clone(&store);
            let auth = Arc::clone(&auth);
            async move {
                assert_eq!(request, r#"{"id":"live","membersOnly":true}"#);
                match mode {
                    0 => return Some(r#"{"members":[]}"#.into()),
                    1 => revoke(&store),
                    2 => auth.lock().unwrap().set_secret("new".into()).unwrap(),
                    3 => auth.lock().unwrap().shutting_down = true,
                    4 => return None,
                    5 => return Some("malformed".into()),
                    6 => return std::future::pending().await,
                    _ => (),
                }
                Some(r#"{"members":[{"id":"session"}]}"#.into())
            }
        };
        let result = issue_ticket(
            &store,
            Some(&auth),
            0,
            input("/ws/chat", "session".into()),
            &context,
        )
        .await;
        if mode == 7 {
            assert!(result.is_ok());
            assert_eq!(auth.lock().unwrap().tickets.len(), 1);
        } else {
            assert_eq!(
                result.unwrap_err().status,
                match mode {
                    0 | 1 => 403,
                    2 | 3 => 503,
                    _ => 500,
                }
            );
            assert_eq!(auth.lock().unwrap().tickets.len(), 0);
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[tokio::test]
async fn native_ticket_membership_is_unbounded_and_metadata_preserves_js_strings() {
    let (root, store, auth) = fixture();
    let session = V::String(js::JsString::from_units(vec![0x4e2d, 0xd800]));
    let context = |_: String| {
        let mut members = vec![V::object(vec![("id", "other".into())]); 501];
        members.push(V::object(vec![("id", session.clone())]));
        async move { js::json::json_encode_wire(&V::object(vec![("members", V::Array(members))])) }
    };
    let result = issue_ticket(
        &store,
        Some(&auth),
        0,
        input("/", session.clone()),
        &context,
    )
    .await
    .unwrap();
    let mut state = auth.lock().unwrap();
    let key = text(get(&result, "ticket"));
    let record = state.tickets.take(&key).unwrap();
    assert!(state.tickets.take(&key).is_none());
    let Metadata::Native(metadata) = record.metadata else {
        panic!("native metadata expected")
    };
    assert_eq!(get(&metadata, "fleetSessionId"), &session);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn native_ticket_commit_and_revocation_publication_have_one_order() {
    let (root, store, _) = fixture();
    let owner = Arc::clone(&store);
    let (begun, receive) = std::sync::mpsc::channel();
    let (done, finished) = std::sync::mpsc::channel();
    let mut worker = None;
    store
        .with_websocket_authority(&input("/ws/workspace", V::Null), clock(None), || {
            worker = Some(std::thread::spawn(move || {
                begun.send(()).unwrap();
                revoke(&owner);
                done.send(()).unwrap();
            }));
            receive.recv().unwrap();
            assert!(finished
                .recv_timeout(std::time::Duration::from_millis(30))
                .is_err());
            Ok(())
        })
        .unwrap();
    finished
        .recv_timeout(std::time::Duration::from_secs(2))
        .unwrap();
    worker.unwrap().join().unwrap();
    assert_eq!(
        store
            .with_websocket_authority(
                &input("/ws/workspace", V::Null),
                clock(None),
                || -> Result<()> { panic!("revoked ticket must not commit") }
            )
            .unwrap_err()
            .status,
        403
    );
    std::fs::remove_dir_all(root).unwrap();
}
