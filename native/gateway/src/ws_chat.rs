//! The production WebSocket host for `/ws/chat`: the front door terminates the
//! upgrade and owns the client socket for its whole life. The chat engine is
//! still the Node child, which sees each client as a virtual socket over the
//! chat bridge (`chat_bridge.rs`).
//!
//! What lives here, and what does not:
//!
//! - Here: the handshake bytes (`ws_handshake::plan`, the same planner the
//!   machines bridge uses), the frame transport in both directions, control
//!   frames (client pings are answered, pongs are reported), the close
//!   handshake with the 30 s grace `ws` gave it, and the abrupt end when Node
//!   or the bridge is lost.
//! - Not here: admission, session resolution, history, the send queue and its
//!   coalescing, the heartbeat schedule, the replay buffer. Node still decides
//!   all of those and drives this socket through `Command`s. A refused client
//!   therefore still sees what it always saw: 101, then a close frame.
//!
//! The writer is a task of its own. A client that stops reading blocks its
//! writes; `Terminate` and the end of the bridge must still take effect, so
//! the main loop never awaits a write.
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::{
    body::Body,
    http::{response::Builder, HeaderMap, Request, Response, StatusCode},
};
use futures_util::{SinkExt, StreamExt};
use hyper_util::rt::TokioIo;
use multicc_core::chat_bridge::OpenInfo;
use tokio::sync::mpsc;
use tokio_tungstenite::{
    tungstenite::{
        error::{CapacityError, Error as WsError},
        protocol::{frame::coding::CloseCode, CloseFrame, Role, WebSocketConfig},
        Message,
    },
    WebSocketStream,
};

use crate::{
    app::App,
    chat_bridge::{ChatBridge, Command, Session},
    ws_handshake,
};

pub const PATH: &str = "/ws/chat";

/// `ws`'s default `maxPayload`, which the retired Node server ran with.
const MAX_PAYLOAD: usize = 100 * 1024 * 1024;
/// How long a started close handshake waits for the client's reply (`ws`
/// `closeTimeout`).
const CLOSE_GRACE: Duration = Duration::from_secs(30);
/// How long the reply to a client-initiated close may take to flush.
const REPLY_GRACE: Duration = Duration::from_secs(5);
/// How long frames already queued get to leave before a terminate drops the
/// socket.
const TERMINATE_GRACE: Duration = Duration::from_millis(250);

pub fn claims(path: &str) -> bool {
    path == PATH
}

fn config() -> WebSocketConfig {
    WebSocketConfig::default()
        .max_frame_size(Some(MAX_PAYLOAD))
        .max_message_size(Some(MAX_PAYLOAD))
}

/// Headers the way Node's `IncomingMessage` exposes them: names lower case,
/// values decoded as latin1, repeated headers joined (`; ` for `cookie`) or
/// dropped after the first (the list `http.IncomingMessage` discards).
pub fn node_headers(headers: &HeaderMap) -> Vec<(String, String)> {
    const KEEP_FIRST: [&str; 18] = [
        "age",
        "authorization",
        "content-length",
        "content-type",
        "etag",
        "expires",
        "from",
        "host",
        "if-modified-since",
        "if-unmodified-since",
        "last-modified",
        "location",
        "max-forwards",
        "proxy-authorization",
        "referer",
        "retry-after",
        "server",
        "user-agent",
    ];
    let mut out: Vec<(String, String)> = Vec::new();
    for name in headers.keys() {
        let mut values = headers.get_all(name).iter().map(|value| {
            value
                .as_bytes()
                .iter()
                .map(|&byte| byte as char)
                .collect::<String>()
        });
        let key = name.as_str().to_ascii_lowercase();
        let Some(first) = values.next() else { continue };
        let joined = if KEEP_FIRST.contains(&key.as_str()) {
            first
        } else {
            let separator = if key == "cookie" { "; " } else { ", " };
            values.fold(first, |mut acc, value| {
                acc.push_str(separator);
                acc.push_str(&value);
                acc
            })
        };
        out.push((key, joined));
    }
    out
}

/// Plans the handshake for `request` and turns the plan into an HTTP response:
/// `Ok(builder)` carries the 101 headers (the caller sets the status and body
/// and returns it after taking the upgrade), `Err(response)` is the refusal
/// the `ws` server would have written. The planner itself stays free of HTTP
/// types so its frozen corpus can be checked, and mutated, on its own.
fn respond(request: &Request<Body>) -> Result<Builder, Box<Response<Body>>> {
    let header = |name| {
        request
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
    };
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
        .and_then(|value| value.parse::<u16>().ok())
        .expect("handshake status");
    let mut builder = Response::builder().status(status);
    for line in lines {
        let (name, value) = line.split_once(": ").expect("handshake header");
        builder = builder.header(name, value);
    }
    if plan.accepted {
        Ok(builder)
    } else {
        Err(Box::new(
            builder
                .body(Body::from(body.to_owned()))
                .expect("handshake response"),
        ))
    }
}

fn close_frame(code: u16, reason: &str) -> Message {
    Message::Close(Some(CloseFrame {
        code: CloseCode::from(code),
        reason: reason.into(),
    }))
}

/// Messages for the writer task.
enum Write {
    /// A frame, with the sequence number Node is waiting to hear about.
    Frame(Message, Option<u32>),
    /// Push out whatever the protocol layer queued by itself: the pong for a
    /// client ping, the reply to a client close.
    Flush,
}

pub async fn handle(
    app: Arc<App>,
    peer: SocketAddr,
    local: SocketAddr,
    mut request: Request<Body>,
) -> Response<Body> {
    let builder = match respond(&request) {
        Ok(builder) => builder,
        Err(refusal) => return *refusal,
    };
    if !app.chat.connected() {
        // No Node generation is live: the same answer an HTTP request gets
        // while the child is starting.
        return crate::forward::error_response(StatusCode::SERVICE_UNAVAILABLE);
    }
    let info = OpenInfo {
        url: request
            .uri()
            .path_and_query()
            .map(|value| value.as_str().to_string())
            .unwrap_or_else(|| request.uri().path().to_string()),
        headers: node_headers(request.headers()),
        remote_address: peer.ip().to_string(),
        remote_port: peer.port(),
        local_address: local.ip().to_string(),
        local_port: local.port(),
    };
    let upgrade = hyper::upgrade::on(&mut request);
    let bridge = Arc::clone(&app.chat);
    tokio::spawn(async move {
        let Ok(upgraded) = upgrade.await else { return };
        let socket =
            WebSocketStream::from_raw_socket(TokioIo::new(upgraded), Role::Server, Some(config()))
                .await;
        let Some(session) = attach(&bridge, info).await else {
            // Node went away between the answer and the upgrade.
            return;
        };
        serve(socket, session).await;
    });
    builder
        .status(StatusCode::SWITCHING_PROTOCOLS)
        .body(Body::empty())
        .expect("handshake response")
}

async fn attach(bridge: &ChatBridge, info: OpenInfo) -> Option<Session> {
    bridge.attach(info).await
}

/// Where a connection ended, for the final frame Node receives.
struct Ended {
    code: u16,
    received: bool,
    sent: bool,
    reason: String,
}

impl Ended {
    fn abrupt() -> Ended {
        Ended {
            code: 1006,
            received: false,
            sent: false,
            reason: String::new(),
        }
    }
}

pub async fn serve<S>(socket: WebSocketStream<S>, mut session: Session)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (mut sink, mut stream) = socket.split();
    let (write_tx, mut write_rx) = mpsc::unbounded_channel::<Write>();
    let link = session.link();
    let mut writer = tokio::spawn(async move {
        while let Some(job) = write_rx.recv().await {
            match job {
                Write::Frame(message, seq) => {
                    let outcome = sink.send(message).await;
                    if let Some(seq) = seq {
                        let error = outcome.as_ref().err().map(|e| e.to_string());
                        if link.sent(seq, error).await.is_err() {
                            break;
                        }
                    }
                    if outcome.is_err() {
                        break;
                    }
                }
                Write::Flush => {
                    if sink.flush().await.is_err() {
                        break;
                    }
                }
            }
        }
    });

    let mut close_sent = false;
    let mut deadline: Option<tokio::time::Instant> = None;
    let ended = loop {
        let grace = async {
            match deadline {
                Some(at) => tokio::time::sleep_until(at).await,
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            command = session.commands.recv() => match command {
                // The bridge is gone: the socket is dropped without a close
                // frame and there is no one left to tell.
                None => {
                    writer.abort();
                    return;
                }
                Some(Command::Send { seq, binary, data }) => {
                    if close_sent {
                        let _ = session.link().sent(seq, Some("WebSocket is not open: readyState 2 (CLOSING)".into())).await;
                        continue;
                    }
                    let message = if binary {
                        Message::Binary(data.into())
                    } else {
                        match String::from_utf8(data) {
                            Ok(text) => Message::Text(text.into()),
                            Err(_) => {
                                let _ = session.link().sent(seq, Some("invalid UTF-8 in a text frame".into())).await;
                                continue;
                            }
                        }
                    };
                    let _ = write_tx.send(Write::Frame(message, Some(seq)));
                }
                Some(Command::Ping) => {
                    if !close_sent {
                        let _ = write_tx.send(Write::Frame(Message::Ping(Vec::new().into()), None));
                    }
                }
                Some(Command::Close { code, reason }) => {
                    if !close_sent {
                        close_sent = true;
                        deadline = Some(tokio::time::Instant::now() + CLOSE_GRACE);
                        let message = match code {
                            Some(code) => close_frame(code, &reason),
                            None => Message::Close(None),
                        };
                        let _ = write_tx.send(Write::Frame(message, None));
                    }
                }
                Some(Command::Terminate) => {
                    // `socket.destroy()` still delivers what was already
                    // written: a close frame queued just before (shutdown does
                    // `close(1012)` then `terminate()`) gets its short chance.
                    drop(write_tx);
                    let _ = tokio::time::timeout(TERMINATE_GRACE, &mut writer).await;
                    writer.abort();
                    break Ended::abrupt();
                }
            },
            incoming = stream.next() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    if session.link().message(false, text.as_str().as_bytes().to_vec()).await.is_err() {
                        writer.abort();
                        return;
                    }
                }
                Some(Ok(Message::Binary(bytes))) => {
                    if session.link().message(true, bytes.to_vec()).await.is_err() {
                        writer.abort();
                        return;
                    }
                }
                Some(Ok(Message::Ping(_))) => {
                    let _ = write_tx.send(Write::Flush);
                }
                Some(Ok(Message::Pong(_))) => {
                    if session.link().pong().await.is_err() {
                        writer.abort();
                        return;
                    }
                }
                Some(Ok(Message::Close(frame))) => {
                    // The protocol layer queued the reply; let it out, then
                    // end. `ws` reports 1005 for a close frame with no status.
                    let (code, reason) = match frame {
                        Some(frame) => (u16::from(frame.code), frame.reason.as_str().to_string()),
                        None => (1005, String::new()),
                    };
                    let _ = write_tx.send(Write::Flush);
                    drop(write_tx);
                    let _ = tokio::time::timeout(REPLY_GRACE, &mut writer).await;
                    writer.abort();
                    let _ = session.link().closed(code, true, true, reason).await;
                    return;
                }
                Some(Ok(Message::Frame(_))) => {}
                Some(Err(error)) => {
                    // A protocol violation closes the socket with the status
                    // `ws` would have used, and reports that status.
                    let (code, reason) = match &error {
                        WsError::Capacity(CapacityError::MessageTooLong { .. }) => (1009, "Max payload size exceeded"),
                        WsError::Utf8(_) => (1007, "invalid UTF-8 sequence"),
                        WsError::Protocol(_) => (1002, "protocol error"),
                        _ => break Ended::abrupt(),
                    };
                    let _ = write_tx.send(Write::Frame(close_frame(code, reason), None));
                    drop(write_tx);
                    let _ = tokio::time::timeout(REPLY_GRACE, &mut writer).await;
                    writer.abort();
                    let _ = session.link().closed(code, false, true, reason.to_string()).await;
                    return;
                }
                None => break Ended::abrupt(),
            },
            _ = grace => break Ended::abrupt(),
        }
    };
    writer.abort();
    let _ = session
        .link()
        .closed(ended.code, ended.received, ended.sent, ended.reason)
        .await;
}
