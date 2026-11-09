//! Source administration uses the existing Store, never another file owner.
//! Its authenticated stream is separate from authentication/ticket RPCs.
use super::{reply, Store};
use crate::auth_runtime::AuthRuntime;
use crate::{auth_control as wire, js::JsValue as V};
use serde::{Deserialize, Serialize};
use std::{
    io,
    sync::{Arc, Mutex},
};

#[derive(Serialize, Deserialize)]
pub enum Request {
    List {
        id: String,
    },
    Revoke {
        id: String,
        token: String,
    },
    Create {
        id: String,
        options: String,
    },
    Authorize {
        input: String,
    },
    Import {
        input: String,
    },
    Ticket {
        revision: u64,
        input: String,
    },
    State {
        token: String,
        grant: Option<String>,
    },
}

fn now() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}
fn internal() -> super::Error {
    super::Error::new("WORKSPACE_SHARING_INTERNAL", "工作区分享操作失败", 500)
}

async fn read_state<F, Fut>(
    store: &Store,
    token: String,
    grant: Option<String>,
    context: &F,
) -> super::Result<V>
where
    F: Fn(String) -> Fut,
    Fut: std::future::Future<Output = Option<String>>,
{
    super::source::read_state(
        store,
        V::object(vec![
            ("token", V::string(&token)),
            (
                "grant",
                grant.map(|s| V::string(&s)).unwrap_or(V::Undefined),
            ),
        ]),
        context,
        None,
    )
    .await
}

pub async fn serve<F, Fut, C, CFuture>(
    store: Arc<Store>,
    port: u16,
    capability: String,
    directory_exists: F,
    context: C,
    auth: Option<Arc<Mutex<AuthRuntime>>>,
) where
    F: Fn(String) -> Fut,
    Fut: std::future::Future<Output = Option<bool>>,
    C: Fn(String) -> CFuture,
    CFuture: std::future::Future<Output = Option<String>>,
{
    // One failure owner per mounted native source, retained across reconnects.
    let access = Arc::new(super::access::Gate::default());
    loop {
        if let Ok(mut stream) = tokio::net::TcpStream::connect(("127.0.0.1", port)).await {
            let _ = stream.set_nodelay(true);
            if matches!(
                tokio::time::timeout(wire::TIMEOUT, wire::connect(&mut stream, &capability)).await,
                Ok(Ok(()))
            ) {
                while let Ok(request) = wire::read_chunks::<Request>(&mut stream).await {
                    let async_result = match &request {
                        Request::Ticket { revision, input } => {
                            Some(match crate::js::json_parse(input) {
                                Ok(input) => {
                                    super::source::issue_ticket(
                                        &store,
                                        auth.as_deref(),
                                        *revision,
                                        input,
                                        &context,
                                    )
                                    .await
                                }
                                Err(_) => Err(internal()),
                            })
                        }
                        Request::State { token, grant } => {
                            Some(read_state(&store, token.clone(), grant.clone(), &context).await)
                        }
                        Request::Import { input } => Some(match crate::js::json_parse(input) {
                            Ok(input) => {
                                super::source::admitted_import(
                                    &access,
                                    Arc::clone(&store),
                                    input,
                                    &directory_exists,
                                    &context,
                                )
                                .await
                            }
                            Err(_) => Err(internal()),
                        }),
                        _ => None,
                    };
                    if let Some(result) = async_result {
                        let response = reply(result);
                        if !matches!(
                            tokio::time::timeout(
                                wire::TIMEOUT,
                                wire::write_chunks(&mut stream, &response)
                            )
                            .await,
                            Ok(Ok(()))
                        ) {
                            break;
                        }
                        continue;
                    }
                    // Fresh lookup from the host's authoritative directory map.
                    // No snapshot cache, JS request/response, or business policy.
                    // A timed-out lookup must not initiate a later mutation.
                    let directory = match &request {
                        Request::Create { id, .. } => {
                            tokio::time::timeout(wire::TIMEOUT, directory_exists(id.clone()))
                                .await
                                .ok()
                                .flatten()
                        }
                        _ => Some(false),
                    };
                    let owner = Arc::clone(&store);
                    // Password/file workers never run on the JS thread or the
                    // authentication RPC executor. Reads see published state.
                    let response = tokio::task::spawn_blocking(move || {
                        let now = now();
                        reply(match request {
                            Request::Create { id, options } => match directory {
                                Some(exists) => match crate::js::json_parse(&options) {
                                    Ok(options) => owner.mutate(
                                        "createShare",
                                        &V::object(vec![
                                            ("id", V::string(&id)),
                                            ("options", options),
                                            ("directory", exists.into()),
                                        ]),
                                        now,
                                    ),
                                    Err(_) => Err(super::Error::new(
                                        "WORKSPACE_SHARING_INTERNAL",
                                        "工作区分享操作失败",
                                        500,
                                    )),
                                },
                                None => Err(super::Error::new(
                                    "WORKSPACE_SHARING_INTERNAL",
                                    "工作区分享操作失败",
                                    500,
                                )),
                            },
                            Request::List { id } => owner.query("listShares", &V::string(&id), now),
                            Request::Revoke { id, token } => owner.mutate(
                                "revokeShare",
                                &V::object(vec![
                                    ("id", V::string(&id)),
                                    ("token", V::string(&token)),
                                ]),
                                now,
                            ),
                            Request::Authorize { input } => crate::js::json_parse(&input)
                                .map_err(|_| internal())
                                .and_then(|input| owner.query("authorizePlan", &input, now)),
                            Request::State { .. }
                            | Request::Import { .. }
                            | Request::Ticket { .. } => unreachable!(),
                        })
                    })
                    .await;
                    let Ok(response) = response else {
                        break;
                    };
                    if !matches!(
                        tokio::time::timeout(
                            wire::TIMEOUT,
                            wire::write_chunks(&mut stream, &response)
                        )
                        .await,
                        Ok(Ok(()))
                    ) {
                        break;
                    }
                }
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}

pub fn decode(response: &str) -> io::Result<super::Result<V>> {
    let result = crate::js::json_parse(response).map_err(|_| io::ErrorKind::InvalidData)?;
    match super::get(&result, "ok") {
        V::Bool(true) => Ok(Ok(super::get(&result, "value").clone())),
        V::Bool(false) => {
            let error = super::get(&result, "error");
            Ok(Err(super::Error {
                code: super::text(super::get(error, "code")),
                message: crate::js::js_to_string(super::get(error, "message")),
                status: super::number(super::get(error, "status")) as u16,
                metadata: super::get(error, "metadata").clone(),
            }))
        }
        _ => Err(io::ErrorKind::InvalidData.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU8, Ordering};

    #[tokio::test]
    async fn import_reconnect_retains_window_and_does_not_replay_lost_response() {
        let root = std::env::temp_dir().join(format!(
            "multicc-import-control-{}",
            super::super::random(12).unwrap()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let store = Arc::new(Store::open_source(root.join("shares.json")).unwrap());
        let share = store
            .mutate(
                "createShare",
                &V::object(vec![
                    ("id", "live".into()),
                    ("directory", true.into()),
                    ("options", V::object(vec![("password", "password".into())])),
                ]),
                now(),
            )
            .unwrap();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let start = || {
            tokio::spawn(serve(
                Arc::clone(&store),
                listener.local_addr().unwrap().port(),
                "fixture-capability".into(),
                |_| async { Some(true) },
                |_| async { Some(r#"{"directory":{"id":"live"},"members":[]}"#.into()) },
                None,
            ))
        };
        let connect = || async {
            let (mut stream, _) = listener.accept().await.unwrap();
            wire::accept(&mut stream, "fixture-capability")
                .await
                .unwrap();
            stream
        };
        let request = |password: &str| Request::Import {
            input: crate::js::json::json_encode_wire(&V::object(vec![
                ("token", super::super::get(&share, "token").clone()),
                ("password", V::string(password)),
                ("ip", "real-peer".into()),
            ]))
            .unwrap(),
        };
        let actor = start();
        let mut stream = connect().await;
        for index in 0..11 {
            if index == 5 {
                drop(stream);
                stream = connect().await;
            }
            wire::write_chunks(&mut stream, &request("x"))
                .await
                .unwrap();
            let encoded: String = wire::read_chunks(&mut stream).await.unwrap();
            assert_eq!(
                decode(&encoded).unwrap().unwrap_err().status,
                if index < 10 { 403 } else { 429 }
            );
        }
        actor.abort();
        let _ = actor.await;
        drop(stream);
        // Only a new mounted owner resets this in-memory failure window.
        let actor = start();
        let mut stream = connect().await;
        wire::write_chunks(&mut stream, &request("x"))
            .await
            .unwrap();
        let encoded: String = wire::read_chunks(&mut stream).await.unwrap();
        assert_eq!(decode(&encoded).unwrap().unwrap_err().status, 403);
        wire::write_chunks(&mut stream, &request("password"))
            .await
            .unwrap();
        drop(stream); // A lost response must not cause the owner to replay the import.
        let mut stream = connect().await;
        wire::write_chunks(&mut stream, &Request::List { id: "live".into() })
            .await
            .unwrap();
        let encoded: String = wire::read_chunks(&mut stream).await.unwrap();
        let rows = decode(&encoded).unwrap().unwrap();
        assert_eq!(
            super::super::get(&super::super::array(&rows)[0], "accessCount"),
            &1.0.into()
        );
        actor.abort();
        let _ = actor.await;
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn state_rechecks_authority_after_context_and_contains_failed_context() {
        let root = std::env::temp_dir().join(format!(
            "multicc-state-control-{}",
            super::super::random(12).unwrap()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("shares.json");
        std::fs::write(&file, r#"{"shares":{"token":{"token":"token","fleetId":"live","accessGrant":"grant","expiresAt":9000000000000}}}"#).unwrap();
        let store = Arc::new(Store::open_source(file).unwrap());
        let mode = Arc::new(AtomicU8::new(0));
        let context = |request: String| {
            let mode = Arc::clone(&mode);
            let store = Arc::clone(&store);
            async move {
                assert_eq!(request, r#"{"id":"live"}"#);
                match mode.load(Ordering::SeqCst) {
                    0 => Some(r#"{"directory":{"id":"live","name":"fresh"},"members":[]}"#.into()),
                    1 => None,
                    2 => Some("not json".into()),
                    3 => std::future::pending().await,
                    4 => Some(r#"{"directory":null,"members":[]}"#.into()),
                    _ => {
                        store
                            .mutate(
                                "revokeShare",
                                &V::object(vec![
                                    ("id", V::string("live")),
                                    ("token", V::string("token")),
                                ]),
                                now(),
                            )
                            .unwrap();
                        Some(r#"{"directory":{"id":"live"},"members":[]}"#.into())
                    }
                }
            }
        };
        let absent = |_: String| async {
            panic!("unauthorized input must never read host state");
            #[allow(unreachable_code)]
            None
        };
        assert_eq!(
            read_state(&store, "token".into(), Some("wrong".into()), &absent)
                .await
                .unwrap_err()
                .status,
            403
        );
        for (state, expected) in [
            (0, 200),
            (1, 500),
            (2, 500),
            (3, 500),
            (4, 404),
            (0, 200),
            (5, 404),
        ] {
            mode.store(state, Ordering::SeqCst);
            let response = read_state(&store, "token".into(), Some("grant".into()), &context).await;
            assert_eq!(response.err().map(|e| e.status).unwrap_or(200), expected);
        }
        assert_eq!(
            read_state(&store, "token".into(), Some("grant".into()), &absent)
                .await
                .unwrap_err()
                .status,
            404
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn create_reads_live_context_and_timed_out_context_never_mutates() {
        let root = std::env::temp_dir().join(format!(
            "multicc-source-control-{}",
            super::super::random(12).unwrap()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let store = Arc::new(Store::open_source(root.join("shares.json")).unwrap());
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let mode = Arc::new(AtomicU8::new(0));
        let read_mode = Arc::clone(&mode);
        let actor = tokio::spawn(serve(
            Arc::clone(&store),
            listener.local_addr().unwrap().port(),
            "fixture-capability".into(),
            move |_| {
                let mode = Arc::clone(&read_mode);
                async move {
                    match mode.load(Ordering::SeqCst) {
                        0 => Some(false),
                        1 => Some(true),
                        2 => None,
                        _ => std::future::pending::<Option<bool>>().await,
                    }
                }
            },
            |_| async { None },
            None,
        ));
        let (mut stream, _) = listener.accept().await.unwrap();
        wire::accept(&mut stream, "fixture-capability")
            .await
            .unwrap();
        let request = Request::Create {
            id: "live".into(),
            options: format!(
                "{{\"password\":\"fixture-password\",\"ignored\":\"{}\"}}",
                "x".repeat(100000)
            ),
        };
        for (state, expected) in [(0, 404), (2, 500), (3, 500), (1, 200), (0, 404)] {
            mode.store(state, Ordering::SeqCst);
            wire::write_chunks(&mut stream, &request).await.unwrap();
            let encoded: String = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                wire::read_chunks(&mut stream),
            )
            .await
            .unwrap()
            .unwrap();
            let status = decode(&encoded)
                .unwrap()
                .err()
                .map(|e| e.status)
                .unwrap_or(200);
            assert_eq!(status, expected);
        }
        assert_eq!(
            super::super::array(&store.query("listShares", &V::string("live"), 0.0).unwrap()).len(),
            1
        );
        actor.abort();
        let _ = actor.await;
        drop(stream);
        std::fs::remove_dir_all(root).unwrap();
    }
}
