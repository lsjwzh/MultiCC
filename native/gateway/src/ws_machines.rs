//! The production WebSocket host for `/ws/machines/<machineId>`: the front
//! door terminates the upgrade itself and bridges the socket to the paired
//! machine. Retires `src/ws/machines.js` (frozen oracle
//! `tests/helpers/legacy-ws-machines.js`, SHA-256
//! `239bbad4a6dd66e96c0fefdf874a5fbdd70920b3c06e9be92f5a01343cb9d451`).
//!
//! This is the first production WS path the gateway owns end to end, and it
//! is the only one with no shared state: the bridge holds one client socket,
//! one upstream socket and nothing else. The chat host still lives in Node
//! because it owns the turn engine, the snapshot/replay buffers and the CLI
//! lanes.
//!
//! What the retired module did, in the order it did it:
//!
//! 1. The `ws` no-server listener answered the handshake, so a malformed
//!    upgrade was refused with an HTTP response and never reached the ticket
//!    table. [`crate::ws_handshake::plan`] reproduces those bytes.
//! 2. On the `connection` event the one-use ticket was redeemed for the
//!    request path. A ticket without a `machineId`, one whose id does not
//!    match the path, or one with no pinned address closed the (already
//!    upgraded) socket with 4003 `电脑连接票据无效`.
//! 3. The upstream socket was dialled with the ticket's pinned addresses, a
//!    10s handshake budget, a 48 MiB payload ceiling and no redirects. The
//!    durable pairing credential never reaches this layer; the one-use URL
//!    carries its own ticket.
//! 4. Client frames that arrived while the upstream was still connecting were
//!    queued and byte-counted; crossing 1 MiB failed the bridge.
//! 5. Every send checked that the target was open and that its buffered
//!    amount was at or under 8 MiB; otherwise the bridge failed.
//! 6. A failure dropped the upstream and closed the client with 1011
//!    `电脑实时连接中断`. An upstream close closed the client with the
//!    upstream's 4003 or else 1012 `电脑连接已关闭`. A client close dropped
//!    the upstream.
//!
//! One rule is not visible in that module: the shared connection router
//! installed the native send wrapper on **every** socket it accepted
//! (`src/ws/native-queue.js`, before the machines branch ran), so frames
//! heading to the client went through [`multicc_core::ws_backpressure`] —
//! queueing, `type`-keyed coalescing and the 1013 slow-client cut included.
//! The bridge is only byte-equivalent with that kernel in front of the client
//! sink, so it runs here too, with the kernel's own defaults.
//!
//! `bufferedAmount` maps to the bytes of the frame the writer task has not
//! finished yet. The kernel keeps at most one frame in flight, which is also
//! what Node's wrapper measured at `flush()` time.

use std::sync::Arc;
use std::time::Duration;

use axum::{
    body::Body,
    http::{Request, Response, StatusCode},
};
use futures_util::{SinkExt, StreamExt};
use hyper_util::rt::TokioIo;
use multicc_core::auth_runtime::{Request as AuthRequest, Response as AuthResponse};
use multicc_core::ws_backpressure::{Limits, Options, Payload, Transport, Wrapper};
use tokio::net::TcpStream;
use tokio_tungstenite::{
    tungstenite::{
        protocol::{frame::coding::CloseCode, CloseFrame, Role, WebSocketConfig},
        Message,
    },
    WebSocketStream,
};

use crate::{app::App, ws_handshake};

/// Every path the retired module claimed: `url.pathname.startsWith(...)`.
pub const PREFIX: &str = "/ws/machines/";

/// `handshakeTimeout: 10000`.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// `maxPayload: 48 * 1024 * 1024`.
const MAX_PAYLOAD: usize = 48 * 1024 * 1024;
/// The byte ceiling for frames queued while the upstream is still connecting.
const PENDING_LIMIT: usize = 1024 * 1024;
/// `target.bufferedAmount > 8 * 1024 * 1024`.
const BUFFERED_LIMIT: usize = 8 * 1024 * 1024;

const TICKET_INVALID: (u16, &str) = (4003, "电脑连接票据无效");
const BRIDGE_BROKEN: (u16, &str) = (1011, "电脑实时连接中断");
const UPSTREAM_CLOSED: (u16, &str) = (1012, "电脑连接已关闭");

/// The upstream socket is either plain TCP or TLS, so the handshake runs over
/// a boxed stream instead of `MaybeTlsStream` (whose TLS variant exists only
/// behind a `tokio-tungstenite` TLS feature this build does not enable).
pub trait Io: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send {}
impl<T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send> Io for T {}

pub fn claims(path: &str) -> bool {
    path.starts_with(PREFIX)
}

/// The admission facts a redeemed ticket has to carry, already validated.
struct Admission {
    url: String,
    addresses: Vec<(String, u8)>,
}

/// `!ticket?.machineId || url.pathname !== ... || !ticket.upstream?.addresses?.length`.
///
/// The host port only ever mints a string `machineId`, so a non-string id is
/// refused rather than coerced.
fn admit(metadata: &serde_json::Value, path: &str) -> Option<Admission> {
    let machine_id = metadata.get("machineId")?.as_str()?;
    if machine_id.is_empty() || path != format!("{PREFIX}{machine_id}") {
        return None;
    }
    let upstream = metadata.get("upstream")?;
    let addresses = upstream.get("addresses")?.as_array()?;
    if addresses.is_empty() {
        return None;
    }
    let pinned: Vec<(String, u8)> = addresses
        .iter()
        .filter_map(|entry| {
            let address = entry.get("address")?.as_str()?.to_string();
            let family = entry.get("family")?.as_u64()? as u8;
            Some((address, family))
        })
        .collect();
    if pinned.len() != addresses.len() {
        return None;
    }
    Some(Admission {
        url: upstream.get("url")?.as_str()?.to_string(),
        addresses: pinned,
    })
}

fn config() -> WebSocketConfig {
    WebSocketConfig::default()
        .max_frame_size(Some(MAX_PAYLOAD))
        .max_message_size(Some(MAX_PAYLOAD))
}

/// `new WebSocket(url, { lookup, handshakeTimeout, maxPayload, followRedirects: false })`.
///
/// The pinned answers replace DNS entirely: the host name is never resolved
/// here, so the socket can only reach an address the ticket authorised. The
/// addresses are tried in the order the ticket lists them, and the whole dial
/// — including TLS and the WebSocket handshake — shares the 10s budget.
async fn dial(admission: &Admission) -> Result<WebSocketStream<Box<dyn Io>>, &'static str> {
    let url = url::Url::parse(&admission.url).map_err(|_| "upstream url")?;
    let tls = match url.scheme() {
        "wss" => true,
        "ws" => false,
        _ => return Err("upstream scheme"),
    };
    let port = url
        .port_or_known_default()
        .or(if tls { Some(443) } else { Some(80) })
        .ok_or("upstream port")?;
    let host = url.host_str().ok_or("upstream host")?.to_string();
    let mut last = "upstream unreachable";
    for (address, _family) in &admission.addresses {
        let target = match format!("{address}:{port}").parse::<std::net::SocketAddr>() {
            Ok(target) => target,
            Err(_) => {
                last = "pinned address";
                continue;
            }
        };
        let stream = match TcpStream::connect(target).await {
            Ok(stream) => stream,
            Err(_) => {
                last = "upstream unreachable";
                continue;
            }
        };
        let _ = stream.set_nodelay(true);
        let stream: Box<dyn Io> = if tls {
            match crate::ws_tls::connect(stream, &host).await {
                Ok(stream) => Box::new(stream),
                Err(reason) => {
                    last = reason;
                    continue;
                }
            }
        } else {
            Box::new(stream)
        };
        match tokio_tungstenite::client_async_with_config(url.as_str(), stream, Some(config()))
            .await
        {
            Ok((socket, _response)) => return Ok(socket),
            Err(_) => last = "upstream handshake",
        }
    }
    Err(last)
}

/// The client sink as the backpressure kernel sees it: a one-slot outbox the
/// driver loop drains, plus the close/terminate decisions the kernel makes.
#[derive(Default)]
struct ClientSink {
    outbox: Option<(Payload, Options)>,
    close: Option<(u16, String)>,
    terminate: bool,
    buffered: usize,
}

impl Transport for ClientSink {
    fn send(&mut self, payload: &Payload, options: &Options) -> Result<(), String> {
        self.outbox = Some((payload.clone(), options.clone()));
        Ok(())
    }
    fn close(&mut self, code: u16, reason: &str) -> Result<(), String> {
        self.close = Some((code, reason.to_string()));
        Ok(())
    }
    fn terminate(&mut self) {
        self.terminate = true;
    }
    fn buffered_amount(&self) -> usize {
        self.buffered
    }
}

fn message(payload: &Payload, options: &Options) -> Message {
    let binary = match options {
        Options::Binary(value) => *value,
        _ => !matches!(payload, Payload::Text(_)),
    };
    if binary {
        Message::Binary(payload.bytes().to_vec().into())
    } else {
        match payload {
            Payload::Text(text) => Message::Text(text.clone().into()),
            other => Message::Text(String::from_utf8_lossy(other.bytes()).into_owned().into()),
        }
    }
}

fn close_frame(code: u16, reason: &str) -> Message {
    Message::Close(Some(CloseFrame {
        code: CloseCode::from(code),
        reason: reason.into(),
    }))
}

pub async fn handle(app: Arc<App>, mut request: Request<Body>) -> Response<Body> {
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
    if !plan.accepted {
        return builder
            .body(Body::from(body.to_owned()))
            .expect("handshake response");
    }
    let path = request.uri().path().to_string();
    let ticket = request
        .uri()
        .query()
        .and_then(|query| {
            url::form_urlencoded::parse(query.as_bytes())
                .find(|(key, _)| key == "ticket")
                .map(|(_, value)| value.into_owned())
        })
        .unwrap_or_default();
    let upgrade = hyper::upgrade::on(&mut request);
    tokio::spawn(async move {
        let Ok(upgraded) = upgrade.await else { return };
        let client =
            WebSocketStream::from_raw_socket(TokioIo::new(upgraded), Role::Server, Some(config()))
                .await;
        bridge(app, client, path, ticket).await;
    });
    builder
        .status(StatusCode::SWITCHING_PROTOCOLS)
        .body(Body::empty())
        .expect("handshake response")
}

async fn bridge<S>(app: Arc<App>, client: WebSocketStream<S>, path: String, ticket: String)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (mut writer, mut reader) = client.split();
    // The redemption spends the ticket whatever the outcome, exactly like the
    // retired `consumeWsTicket` call.
    let redeemed = app
        .auth
        .request(AuthRequest::ConsumeTicket {
            ticket,
            path: path.clone(),
        })
        .await;
    let admission = match redeemed {
        Ok(AuthResponse::Redeemed { metadata, .. }) => admit(&metadata, &path),
        _ => None,
    };
    let Some(admission) = admission else {
        let _ = writer
            .send(close_frame(TICKET_INVALID.0, TICKET_INVALID.1))
            .await;
        let _ = writer.close().await;
        return;
    };

    // Frames the client sends before the upstream is open are queued, exactly
    // like the retired `queue`/`bytes` pair; crossing 1 MiB fails the bridge.
    let mut pending: Vec<Message> = Vec::new();
    let mut pending_bytes = 0_usize;
    let upstream = {
        // One 10s budget for the whole dial (TCP, TLS and the WebSocket
        // handshake across every pinned address), like `handshakeTimeout` on
        // the single `ws` client the retired module created.
        let dialling = tokio::time::timeout(HANDSHAKE_TIMEOUT, dial(&admission));
        tokio::pin!(dialling);
        loop {
            tokio::select! {
                dialled = &mut dialling => break dialled,
                incoming = reader.next() => match incoming {
                    Some(Ok(frame)) if frame.is_text() || frame.is_binary() => {
                        pending_bytes += frame.len();
                        if pending_bytes > PENDING_LIMIT {
                            let _ = writer.send(close_frame(BRIDGE_BROKEN.0, BRIDGE_BROKEN.1)).await;
                            let _ = writer.close().await;
                            return;
                        }
                        pending.push(frame);
                    }
                    // A client that leaves while the upstream is still being
                    // dialled drops the dial with it (`ws.on('close')`).
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return,
                    Some(Ok(_)) => {}
                },
            }
        }
    };
    let upstream = match upstream {
        Ok(Ok(upstream)) => upstream,
        Ok(Err(_)) | Err(_) => {
            let _ = writer
                .send(close_frame(BRIDGE_BROKEN.0, BRIDGE_BROKEN.1))
                .await;
            let _ = writer.close().await;
            return;
        }
    };
    let (mut up_writer, mut up_reader) = upstream.split();
    for frame in pending.drain(..) {
        if frame.len() > BUFFERED_LIMIT || up_writer.send(frame).await.is_err() {
            let _ = writer
                .send(close_frame(BRIDGE_BROKEN.0, BRIDGE_BROKEN.1))
                .await;
            let _ = writer.close().await;
            return;
        }
    }

    // The client-facing kernel: the same wrapper and defaults the shared
    // router installed on every accepted socket.
    let mut sink = ClientSink::default();
    let mut kernel = Wrapper::new(Limits::default());
    let mut closing: Option<(u16, &'static str)> = None;
    loop {
        kernel.set_now(now_ms());
        // Drain what the last kernel call decided before taking new input.
        if let Some((payload, options)) = sink.outbox.take() {
            sink.buffered = payload.bytes().len();
            let outcome = writer.send(message(&payload, &options)).await;
            sink.buffered = 0;
            kernel.set_now(now_ms());
            let error = outcome.as_ref().err().map(|error| error.to_string());
            kernel.complete(error.as_deref(), &mut sink);
            let _ = kernel.take_effects();
            continue;
        }
        if let Some((code, reason)) = sink.close.take() {
            let _ = writer.send(close_frame(code, &reason)).await;
            let _ = writer.close().await;
            return;
        }
        if sink.terminate {
            return;
        }
        if let Some((code, reason)) = closing.take() {
            let _ = writer.send(close_frame(code, reason)).await;
            let _ = writer.close().await;
            return;
        }
        tokio::select! {
            incoming = reader.next() => match incoming {
                Some(Ok(frame)) if frame.is_text() || frame.is_binary() => {
                    if frame.len() > BUFFERED_LIMIT || up_writer.send(frame).await.is_err() {
                        closing = Some(BRIDGE_BROKEN);
                    }
                }
                // `ws.on('close')` dropped the upstream without a close frame.
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return,
                Some(Ok(_)) => {}
            },
            from_upstream = up_reader.next() => match from_upstream {
                Some(Ok(Message::Text(text))) => {
                    kernel.enqueue(Payload::Text(text.as_str().to_string()), Options::Binary(false), None, true, &mut sink);
                    let _ = kernel.take_effects();
                }
                Some(Ok(Message::Binary(bytes))) => {
                    kernel.enqueue(Payload::Buffer(bytes.to_vec()), Options::Binary(true), None, true, &mut sink);
                    let _ = kernel.take_effects();
                }
                Some(Ok(Message::Close(frame))) => {
                    // `code === 4003 ? 4003 : 1012` — only the code follows the
                    // upstream; the reason is always `电脑连接已关闭`.
                    let code = frame.map(|frame| u16::from(frame.code)).unwrap_or(1005);
                    let code = if code == TICKET_INVALID.0 { TICKET_INVALID.0 } else { UPSTREAM_CLOSED.0 };
                    closing = Some((code, UPSTREAM_CLOSED.1));
                }
                None | Some(Err(_)) => closing = Some(BRIDGE_BROKEN),
                Some(Ok(_)) => {}
            },
        }
    }
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis() as f64)
        .unwrap_or(0.0)
}
