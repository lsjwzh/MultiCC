//! Test-only live integration of the Rust handshake, ticket owner and registry.
//!
//! This is deliberately not the `/ws/chat` host. It is registered only with
//! `MULTICC_GATEWAY_TEST_ROUTES=1`, and exercises one chat-style ping through
//! the real HTTP listener without publishing a second production WS owner.
use std::sync::Arc;

use axum::{
    body::Body,
    extract::Extension,
    http::{Request, Response, StatusCode},
};
use futures_util::{SinkExt, StreamExt};
use hyper_util::rt::TokioIo;
use multicc_core::auth_runtime::{Request as AuthRequest, Response as AuthResponse};
use tokio_tungstenite::{
    tungstenite::{
        protocol::{frame::coding::CloseCode, CloseFrame, Role},
        Message,
    },
    WebSocketStream,
};

use crate::{
    app::App,
    ws_chat_hub::ChatHub,
    ws_handshake,
    ws_registry::{Frame, Registry},
};

pub const PATH: &str = "/__gateway_test/ws";

fn probe_event(kind: &str) -> hyper::body::Bytes {
    use multicc_core::js::JsValue;
    let payload = JsValue::object(vec![("type", JsValue::string(kind))]);
    let context = JsValue::object(Vec::<(&str, JsValue)>::new());
    let envelope =
        multicc_core::api_contract::ws_envelope(&payload, &context).expect("probe event");
    multicc_core::js::json_stringify(&envelope)
        .expect("probe JSON")
        .into()
}

fn dispatch_probe(registry: &Registry, id: u64, bytes: &[u8]) -> bool {
    let text = String::from_utf8_lossy(bytes);
    let Ok(input) = multicc_core::js::json_parse(&text) else {
        return true;
    };
    let message_type = match input.get("type") {
        Some(multicc_core::js::JsValue::String(value)) => value.to_string_lossy(),
        _ => String::new(),
    };
    if message_type == "test_broadcast" {
        return registry
            .broadcast_from(id, Frame::Text(probe_event("test_broadcast")))
            .is_ok();
    }
    if matches!(
        multicc_core::chat_ws_control::action(&message_type, ""),
        multicc_core::chat_ws_control::Action::Pong
    ) {
        let _ = registry.dispatch(id, Frame::Text(probe_event("pong")));
    }
    true
}

pub async fn handle(
    Extension(app): Extension<Arc<App>>,
    Extension(registry): Extension<Arc<Registry>>,
    Extension(hub): Extension<Arc<ChatHub>>,
    mut request: Request<Body>,
) -> Response<Body> {
    let header = |name| request.headers().get(name).and_then(|v| v.to_str().ok());
    let plan = ws_handshake::plan(&ws_handshake::Request {
        method: request.method().as_str(),
        upgrade: header("upgrade"),
        key: header("sec-websocket-key"),
        version: header("sec-websocket-version"),
        protocol: header("sec-websocket-protocol"),
    });
    let raw = String::from_utf8(plan.response).expect("handshake is ASCII");
    let (head, body) = raw.split_once("\r\n\r\n").expect("complete handshake");
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|s| s.parse::<u16>().ok())
        .expect("handshake status");
    let mut builder = Response::builder().status(status);
    for line in lines {
        let (name, value) = line.split_once(": ").expect("handshake header");
        builder = builder.header(name, value);
    }
    if !plan.accepted {
        return builder
            .body(Body::from(body.to_owned()))
            .expect("handshake response");
    }
    let ticket = request
        .uri()
        .query()
        .and_then(|query| {
            url::form_urlencoded::parse(query.as_bytes())
                .find(|(key, _)| key == "ticket")
                .map(|(_, value)| value.into_owned())
        })
        .unwrap_or_default();
    let session = request
        .uri()
        .query()
        .and_then(|query| {
            url::form_urlencoded::parse(query.as_bytes())
                .find(|(key, _)| key == "session")
                .map(|(_, value)| value.into_owned())
        })
        .unwrap_or_default();
    let use_hub = request.uri().query().is_some_and(|query| {
        url::form_urlencoded::parse(query.as_bytes())
            .any(|(key, value)| key == "hub" && value == "1")
    });
    let upgrade = hyper::upgrade::on(&mut request);
    tokio::spawn(async move {
        let Ok(upgraded) = upgrade.await else { return };
        let mut socket =
            WebSocketStream::from_raw_socket(TokioIo::new(upgraded), Role::Server, None).await;
        let authorized = matches!(
            app.auth
                .request(AuthRequest::ConsumeTicket {
                    ticket,
                    path: PATH.into()
                })
                .await,
            Ok(AuthResponse::Redeemed { .. })
        );
        if !authorized {
            let _ = socket
                .send(Message::Close(Some(CloseFrame {
                    code: CloseCode::Library(4003),
                    reason: "Forbidden".into(),
                })))
                .await;
            return;
        }
        if use_hub {
            serve_hub_probe(socket, hub, session).await;
            return;
        }
        let (mut writer, mut reader) = socket.split();
        let Some(mut connection) = registry.register_session(session, 64, 1024 * 1024) else {
            return;
        };
        let id = connection.id;
        loop {
            tokio::select! {
                biased;
                changed = connection.overflow.changed() => {
                    if changed.is_err() { break; }
                    if *connection.overflow.borrow() {
                        let _ = writer.send(Message::Close(Some(CloseFrame {
                            code: CloseCode::Again,
                            reason: "slow client; reconnect to resync".into(),
                        }))).await;
                        break;
                    }
                },
                incoming = reader.next() => match incoming {
                    Some(Ok(Message::Text(text))) => if !dispatch_probe(&registry, id, text.as_bytes()) { break; },
                    Some(Ok(Message::Binary(bytes))) => if !dispatch_probe(&registry, id, &bytes) { break; },
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    _ => {}
                },
                queued = connection.receiver.recv() => match queued {
                    Some(queued) => match queued.frame {
                        Frame::Text(bytes) => {
                            let Ok(text) = String::from_utf8(bytes.to_vec()) else { break };
                            if writer.send(Message::Text(text.into())).await.is_err() { break; }
                        }
                        Frame::Binary(bytes) => if writer.send(Message::Binary(bytes)).await.is_err() { break; },
                        Frame::Close { code, reason } => {
                            let _ = writer.send(Message::Close(Some(CloseFrame { code: code.into(), reason: reason.into() }))).await;
                            break;
                        }
                    },
                    None => break,
                }
            }
        }
    });
    builder
        .status(StatusCode::SWITCHING_PROTOCOLS)
        .body(Body::empty())
        .expect("handshake response")
}

/// Exercises the ordered hub on the test route only; no production chat
/// authentication, history or turn orchestration is implemented here.
async fn serve_hub_probe(
    socket: WebSocketStream<TokioIo<hyper::upgrade::Upgraded>>,
    hub: Arc<ChatHub>,
    session: String,
) {
    let Some(mut attached) = hub.attach(&session, 64, 1024 * 1024) else {
        return;
    };
    let (mut writer, mut reader) = socket.split();
    for event in &attached.replay {
        let Ok(text) = String::from_utf8(event.to_vec()) else {
            return;
        };
        if writer.send(Message::Text(text.into())).await.is_err() {
            return;
        }
    }
    loop {
        tokio::select! {
            biased;
            changed = attached.connection.overflow.changed() => {
                if changed.is_err() { break; }
                if *attached.connection.overflow.borrow() {
                    let _ = writer.send(Message::Close(Some(CloseFrame {
                        code: CloseCode::Again, reason: "slow client; reconnect to resync".into(),
                    }))).await;
                    break;
                }
            },
            incoming = reader.next() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    let parsed = multicc_core::js::json_parse(&text);
                    let kind = parsed.ok().and_then(|v| match v.get("type") {
                        Some(multicc_core::js::JsValue::String(value)) => Some(value.to_string_lossy()),
                        _ => None,
                    }).unwrap_or_default();
                    if kind == "test_replay" {
                        hub.publish(&session, probe_event("test_replay"), true);
                    } else if kind == "ping" {
                        let _ = hub.send(attached.connection.id, Frame::Text(probe_event("pong")));
                    }
                },
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {},
            },
            queued = attached.connection.receiver.recv() => match queued {
                Some(queued) => match queued.frame {
                    Frame::Text(bytes) => {
                        let Ok(text) = String::from_utf8(bytes.to_vec()) else { break };
                        if writer.send(Message::Text(text.into())).await.is_err() { break; }
                    },
                    Frame::Binary(bytes) => if writer.send(Message::Binary(bytes)).await.is_err() { break; },
                    Frame::Close { code, reason } => {
                        let _ = writer.send(Message::Close(Some(CloseFrame { code: code.into(), reason: reason.into() }))).await;
                        break;
                    }
                },
                None => break,
            }
        }
    }
}
