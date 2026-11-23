//! `/ws/remote-screen`: the front door terminates the client upgrade and
//! bridges the socket to the loopback `multicc-remote` child owned by
//! [`crate::remote_child::RemoteChild`]. This retires the WS half of
//! `src/remote-screen-rust.js` (`attach`/`attachH264`/`attachRfb`); the HTTP
//! half already lives in [`crate::app::remote_screen`].
//!
//! The behavioural oracle is `src/remote-screen-rust.js` lines 350–495 and
//! docs/remote-screen-process.md §4. In order:
//!
//! 1. Admission runs in the kernel (`multicc_core::ws_admission`). This is a
//!    sessionless path, so `addressedSessionId` is null and only the first
//!    `plan()` is taken — no session record, no second plan. A refused plan is
//!    carried out after the 101 the same way `send_refusal` does it: the
//!    socket is already upgraded, so the refusal is a close frame.
//! 2. `x-multicc-remote-secret`, `mode=h264` and the ticket/token query strip
//!    are what [`upstream_path`] reproduces: `ticket`/`token` never reach the
//!    child (they are this hop's credentials).
//! 3. The child is started through [`RemoteChild::ensure`]; a start failure or
//!    a dial failure closes the client with 1011 `remote-unavailable`, exactly
//!    like `ensureStarted().then(..., () => safeClose(1011, ...))`.
//! 4. Client frames that arrive before the upstream is open are queued and
//!    byte counted; crossing 1 MiB closes with 1013 `queue-overflow` (§4.2).
//! 5. Every frame heading to the client goes through
//!    [`multicc_core::ws_backpressure`] with the kernel's own defaults — the
//!    shared connection router installed that wrapper on **every** accepted
//!    socket, so the bridge is only byte-equivalent with it in front of the
//!    client sink (see the `ws_machines` header note).
//! 6. Backpressure: the client's real backlog is the in-flight frame plus the
//!    kernel queue. Above 64 KiB the upstream reader is paused; a 15 ms poll
//!    resumes it once the backlog falls under 16 KiB. "Pause" here means the
//!    bridge stops polling `up_reader`, which lets TCP back up to the child.
//! 7. Close codes cross in both directions through [`sendable_close_code`]:
//!    3000–4999 pass through, the sendable 1xxx set passes through, and
//!    everything else (1005/1006 and the reserved ranges) becomes 1011.
//! 8. When the ready child exits, every bridge closes the client with 1011
//!    `remote-unavailable` and drops the upstream (`closeForwards`).

use std::net::IpAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::{
    body::Body,
    http::{Request, Response, StatusCode},
};
use futures_util::{stream::SplitSink, SinkExt, StreamExt};
use hyper_util::rt::TokioIo;
use multicc_core::auth_runtime::{self, Request as AuthRequest, Response as AuthResponse};
use multicc_core::auth_security;
use multicc_core::http_gate::{self, NodeHeaders};
use multicc_core::network_policy::env_enabled;
use multicc_core::ws_admission::{self, Facts};
use multicc_core::ws_backpressure::{Limits, Options, Payload, Transport, Wrapper};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_tungstenite::{
    tungstenite::{
        client::IntoClientRequest,
        http::HeaderValue,
        protocol::{Role, WebSocketConfig},
        Message,
    },
    WebSocketStream,
};

use crate::app::App;
use crate::remote_child::{Ready, RemoteChild};
use crate::ws_machines::{close_frame, message};

/// The one path this module claims: an exact match, not a prefix.
pub const PATH: &str = "/ws/remote-screen";

/// `maxPayload`-free but finite: the largest single frame the child may send.
const MAX_PAYLOAD: usize = 48 * 1024 * 1024;

/// The close-state constants the kernel and the client sink use.
const REMOTE_UNAVAILABLE: (u16, &str) = (1011, "remote-unavailable");
const QUEUE_OVERFLOW: (u16, &str) = (1013, "queue-overflow");
const UPSTREAM_CLOSED: (u16, &str) = (1011, "upstream-closed");

/// `SENDABLE_CLOSE` from the JS: the 1xxx codes that may appear on the wire.
const SENDABLE_CLOSE: [u16; 12] = [
    1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014,
];

/// Everything the bridge times or sizes, injectable so tests shrink it. The
/// defaults are the JS constants.
#[derive(Clone, Copy, Debug)]
pub struct Tuning {
    /// `QUEUE_LIMIT_BYTES`: the pre-upstream queue ceiling (1 MiB).
    pub queue_limit: usize,
    /// `CLIENT_HIGH_WATER`: pause the upstream above this backlog (64 KiB).
    pub high_water: usize,
    /// `CLIENT_LOW_WATER`: resume the upstream below this backlog (16 KiB).
    pub low_water: usize,
    /// `BACKPRESSURE_POLL_MS`: how often the backlog is re-checked (15 ms).
    pub poll: Duration,
}

impl Default for Tuning {
    fn default() -> Self {
        Self {
            queue_limit: 1024 * 1024,
            high_water: 64 * 1024,
            low_water: 16 * 1024,
            poll: Duration::from_millis(15),
        }
    }
}

/// The front-door host for `/ws/remote-screen`. Holds the one supervisor the
/// HTTP routes share; the `App` gains no field.
pub struct RemoteScreenWs {
    child: Arc<RemoteChild>,
    tuning: Tuning,
}

impl RemoteScreenWs {
    pub fn new(child: Arc<RemoteChild>) -> Self {
        Self {
            child,
            tuning: Tuning::default(),
        }
    }

    /// Test constructor: same bridge, shortened timers/high water.
    pub fn with_tuning(child: Arc<RemoteChild>, tuning: Tuning) -> Self {
        Self { child, tuning }
    }

    /// The retired `urlObj.pathname === '/ws/remote-screen'` exact match.
    pub fn claims(path: &str) -> bool {
        path == PATH
    }

    pub async fn handle(
        &self,
        app: Arc<App>,
        peer: IpAddr,
        mut request: Request<Body>,
    ) -> Response<Body> {
        let header = |name| {
            request
                .headers()
                .get(name)
                .and_then(|value| value.to_str().ok())
        };
        let plan = crate::ws_handshake::plan(&crate::ws_handshake::Request {
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
        let upgrade = hyper::upgrade::on(&mut request);
        let child = Arc::clone(&self.child);
        let tuning = self.tuning;
        tokio::spawn(async move {
            let Ok(upgraded) = upgrade.await else { return };
            let _connected = app.ws_clients.enter();
            let client = WebSocketStream::from_raw_socket(
                TokioIo::new(upgraded),
                Role::Server,
                Some(config()),
            )
            .await;
            serve(app, peer, request, client, child, tuning).await;
        });
        builder
            .status(StatusCode::SWITCHING_PROTOCOLS)
            .body(Body::empty())
            .expect("handshake response")
    }
}

fn config() -> WebSocketConfig {
    WebSocketConfig::default()
        .max_frame_size(Some(MAX_PAYLOAD))
        .max_message_size(Some(MAX_PAYLOAD))
}

/// A refusal plan carried out on the already-upgraded socket, the same subset
/// `ws_chat_native::send_refusal` handles for a sessionless path.
async fn refuse<S>(socket: &mut WebSocketStream<S>, steps: Vec<ws_admission::Step>)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    for step in steps {
        if let ws_admission::Step::Close { code, reason } = step {
            let frame = match code {
                Some(code) => close_frame(code, reason.unwrap_or("")),
                None => Message::Close(None),
            };
            let _ = socket.send(frame).await;
            let _ = SinkExt::close(socket).await;
            break;
        }
    }
}

/// `sendableCloseCode`: 3000–4999 pass through, the sendable 1xxx set passes
/// through, everything else (local-state 1005/1006/1015 and reserved ranges)
/// becomes 1011 so the client reconnects.
fn sendable_close_code(code: u16) -> u16 {
    if (3000..=4999).contains(&code) {
        return code;
    }
    if SENDABLE_CLOSE.contains(&code) {
        return code;
    }
    1011
}

/// `clipReason`: over 100 code units becomes the first 99 plus an ellipsis.
/// The extra byte cap keeps the reason inside a control frame's 125-byte
/// payload when a multi-byte upstream reason would otherwise overflow it.
fn clip_reason(reason: &str) -> String {
    let clipped: String = if reason.chars().count() > 100 {
        let head: String = reason.chars().take(99).collect();
        format!("{head}…")
    } else {
        reason.to_string()
    };
    if clipped.len() <= 123 {
        return clipped;
    }
    let mut cut = 123;
    while cut > 0 && !clipped.is_char_boundary(cut) {
        cut -= 1;
    }
    clipped[..cut].to_string()
}

/// `upstreamPath(req, mode)`: strip `ticket`/`token`, and set `mode=h264` only
/// when it is `h264` and the parameter is absent (unreachable in practice: the
/// h264 caller always carried `mode=h264`, so the existing value is kept).
fn upstream_path(raw_query: &str, mode: &str) -> String {
    let mut pairs: Vec<(String, String)> = url::form_urlencoded::parse(raw_query.as_bytes())
        .into_owned()
        .collect();
    pairs.retain(|(key, _)| key != "ticket" && key != "token");
    if mode == "h264" && !pairs.iter().any(|(key, _)| key == "mode") {
        pairs.push(("mode".to_string(), "h264".to_string()));
    }
    let query = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(
            pairs
                .iter()
                .map(|(key, value)| (key.as_str(), value.as_str())),
        )
        .finish();
    if query.is_empty() {
        PATH.to_string()
    } else {
        format!("{PATH}?{query}")
    }
}

/// The client sink as the backpressure kernel sees it: a one-slot outbox the
/// driver loop drains into the writer task, plus the close/terminate decisions.
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

/// The write half handed to the writer task. `Frame` carries a message the
/// kernel decided to send; `Close` flushes and closes the socket.
enum WriteCmd {
    Frame(Message),
    Close,
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis() as f64)
        .unwrap_or(0.0)
}

/// The dial for `ws://127.0.0.1:<port><path>`, carrying the internal secret
/// header and no compression. A dial failure is `remote-unavailable`.
async fn dial(ready: &Ready, path: &str) -> Result<WebSocketStream<TcpStream>, ()> {
    let target = format!("ws://127.0.0.1:{}{path}", ready.port);
    let mut request = target.as_str().into_client_request().map_err(|_| ())?;
    let secret = HeaderValue::from_str(&ready.secret).map_err(|_| ())?;
    request
        .headers_mut()
        .insert("x-multicc-remote-secret", secret);
    let stream = TcpStream::connect(("127.0.0.1", ready.port))
        .await
        .map_err(|_| ())?;
    let _ = stream.set_nodelay(true);
    let (socket, _response) =
        tokio_tungstenite::client_async_with_config(request, stream, Some(config()))
            .await
            .map_err(|_| ())?;
    Ok(socket)
}

/// The admission facts for a sessionless WS path. This mirrors
/// `ws_chat_native::auth` but keeps this path's own facts: `path` is this
/// route, `addressedSessionId`/`addressedDirectoryId` are null (the JS
/// `SESSIONLESS_WS_PATHS` branch), and the one-use ticket is consumed for
/// `/ws/remote-screen` — consuming it under another path would refuse a valid
/// ticket.
///
/// The query and headers are owned so no `Request<Body>` reference (whose body
/// is not `Sync`) is held across an `await`.
async fn admission_facts(
    app: &Arc<App>,
    peer: IpAddr,
    query: Vec<(String, String)>,
    headers: NodeHeaders,
) -> Facts {
    let get = |field: &str| param(&query, field);
    let peer_text = peer.to_string();
    let cookies = http_gate::parse_cookies(headers.get("cookie"));
    let cookie = cookies
        .get("multicc_auth")
        .filter(|value| !value.is_empty());
    // Unlike `/ws/chat`, whose `--node` connections are handed to Node for
    // admission, this path is terminated here under both modes. So the
    // credential and the shutdown flag come from whichever side owns the
    // authentication runtime (`Bridge` answers locally under `--no-node` and
    // over the control channel under `--node`). Gating this on `has_local()`
    // would leave `--node` with an empty secret and no redeemed ticket, and
    // every public peer would be refused. A failed read is `None`: an empty
    // secret admits nobody.
    let snapshot = app.auth.snapshot().await.ok();
    let secret = snapshot.as_ref().map_or("", |value| value.secret.as_str());
    let now = auth_runtime::now_ms();
    let mut facts = Facts {
        shutting_down: snapshot.as_ref().is_some_and(|value| value.shutting_down),
        peer_allowed: !app.lan_only || http_gate::is_private_network_address(&peer_text),
        path: PATH.to_string(),
        share_param: get("share").unwrap_or("").to_string(),
        session_param: get("session").map(ToOwned::to_owned),
        addressed_session_id: None,
        addressed_directory_id: None,
        local: http_gate::is_local_request(&peer_text, &headers),
        access_token: !secret.is_empty(),
        has_ticket_param: get("ticket").is_some(),
        allow_legacy_cookie: flag("MULTICC_ALLOW_LEGACY_WS_COOKIE"),
        allow_legacy_token: flag("MULTICC_ALLOW_LEGACY_WS_TOKEN"),
        auth_cookie: cookie.is_some(),
        cookie_valid: cookie
            .is_some_and(|value| auth_security::verify_cookie(secret, value, now as i64)),
        token_valid: auth_security::verify_access_token(secret, get("token")),
        machines_present: true,
        ip: Some(peer_text),
        ..Facts::default()
    };
    // `needs_share_record` is chat-only, so a `share` parameter never reaches
    // the share table on this path.
    if ws_admission::needs_ticket(&facts) {
        let request = AuthRequest::ConsumeTicket {
            ticket: get("ticket").unwrap_or("").to_string(),
            path: PATH.to_string(),
        };
        if let Ok(AuthResponse::Redeemed { metadata, .. }) = app.auth.request(request).await {
            facts.consumed_ticket = ws_admission::ticket_from(&metadata);
        }
        if let Some(id) = facts
            .consumed_ticket
            .as_ref()
            .map(|ticket| &ticket.machine_grant_id)
            .filter(|id| !id.is_empty())
        {
            let root = app.data_root.to_string_lossy().into_owned();
            let id = id.clone();
            facts.machine_active = tokio::task::spawn_blocking(move || {
                multicc_core::machines::grant_active(&root, &id)
            })
            .await
            .unwrap_or(false);
        }
    }
    facts
}

fn param<'a>(query: &'a [(String, String)], key: &str) -> Option<&'a str> {
    query
        .iter()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value.as_str())
}

fn flag(name: &str) -> bool {
    std::env::var(name).is_ok_and(|value| env_enabled(&value))
}

/// The writer task: the only place the client socket is written. Keeping the
/// socket write off the driver loop is what lets the loop keep reading the
/// upstream while a slow client blocks — the backlog then grows in the kernel
/// queue and the pause below becomes load-bearing, exactly as in Node.
async fn client_writer<S>(
    mut writer: SplitSink<WebSocketStream<S>, Message>,
    mut commands: mpsc::UnboundedReceiver<WriteCmd>,
    done: mpsc::UnboundedSender<bool>,
) where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    while let Some(command) = commands.recv().await {
        match command {
            WriteCmd::Frame(message) => {
                let ok = writer.send(message).await.is_ok();
                let _ = done.send(ok);
                if !ok {
                    break;
                }
            }
            WriteCmd::Close => {
                let _ = writer.close().await;
                break;
            }
        }
    }
}

/// Queue a close frame followed by a socket close, in order.
fn queue_close(commands: &mpsc::UnboundedSender<WriteCmd>, code: u16, reason: &str) {
    let _ = commands.send(WriteCmd::Frame(close_frame(code, reason)));
    let _ = commands.send(WriteCmd::Close);
}

async fn serve<S>(
    app: Arc<App>,
    peer: IpAddr,
    request: Request<Body>,
    mut client: WebSocketStream<S>,
    child: Arc<RemoteChild>,
    tuning: Tuning,
) where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    // Sessionless path: one plan, no record lookup.
    let raw_query = request.uri().query().unwrap_or("").to_string();
    let query: Vec<(String, String)> = url::form_urlencoded::parse(raw_query.as_bytes())
        .into_owned()
        .collect();
    let headers = NodeHeaders::from_raw(
        request
            .headers()
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_bytes())),
    );
    let facts = admission_facts(&app, peer, query, headers).await;
    let steps = ws_admission::plan(&facts);
    if !steps.contains(&ws_admission::Step::Accept) {
        refuse(&mut client, steps).await;
        return;
    }

    let mode = if url::form_urlencoded::parse(raw_query.as_bytes())
        .any(|(key, value)| key == "mode" && value == "h264")
    {
        "h264"
    } else {
        "rfb"
    };
    let path = upstream_path(&raw_query, mode);
    let mut exits = child.subscribe_exits();
    let (mut writer, mut reader) = client.split();

    // Phase 1: start the child and dial the upstream while queueing whatever
    // the client sends, byte counted against the 1 MiB ceiling (§4.2).
    let mut pending: Vec<Message> = Vec::new();
    let mut pending_bytes = 0_usize;
    let dialling = async {
        let ready = child.ensure().await.map_err(|_| ())?;
        dial(&ready, &path).await
    };
    tokio::pin!(dialling);
    let upstream = loop {
        tokio::select! {
            outcome = &mut dialling => break outcome,
            _notice = exits.recv() => {
                let _ = writer.send(close_frame(REMOTE_UNAVAILABLE.0, REMOTE_UNAVAILABLE.1)).await;
                let _ = writer.close().await;
                return;
            }
            incoming = reader.next() => match incoming {
                Some(Ok(frame)) if frame.is_text() || frame.is_binary() => {
                    pending_bytes += frame.len();
                    if pending_bytes > tuning.queue_limit {
                        let _ = writer.send(close_frame(QUEUE_OVERFLOW.0, QUEUE_OVERFLOW.1)).await;
                        let _ = writer.close().await;
                        return;
                    }
                    pending.push(frame);
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return,
                Some(Ok(_)) => {}
            }
        }
    };
    let mut upstream = match upstream {
        Ok(upstream) => upstream,
        Err(()) => {
            let _ = writer
                .send(close_frame(REMOTE_UNAVAILABLE.0, REMOTE_UNAVAILABLE.1))
                .await;
            let _ = writer.close().await;
            return;
        }
    };
    for frame in pending.drain(..) {
        if upstream.send(frame).await.is_err() {
            let _ = writer
                .send(close_frame(UPSTREAM_CLOSED.0, UPSTREAM_CLOSED.1))
                .await;
            let _ = writer.close().await;
            return;
        }
    }

    let (mut up_writer, mut up_reader) = upstream.split();
    let (commands, command_rx) = mpsc::unbounded_channel::<WriteCmd>();
    let (done_tx, mut done_rx) = mpsc::unbounded_channel::<bool>();
    tokio::spawn(client_writer(writer, command_rx, done_tx));

    // Phase 2: the kernel-fronted bridge.
    let mut kernel = Wrapper::new(Limits::default());
    let mut sink = ClientSink::default();
    let mut in_flight = false;
    let mut paused_until: Option<tokio::time::Instant> = None;
    loop {
        kernel.set_now(now_ms());
        if !in_flight {
            if let Some((payload, options)) = sink.outbox.take() {
                sink.buffered = payload.bytes().len();
                let _ = commands.send(WriteCmd::Frame(message(&payload, &options)));
                in_flight = true;
            }
        }
        if sink.terminate {
            let _ = commands.send(WriteCmd::Close);
            return;
        }
        if let Some((code, reason)) = sink.close.take() {
            queue_close(&commands, code, &reason);
            return;
        }
        let backlog = sink.buffered + kernel.stats().queue_bytes;
        match paused_until {
            None if backlog > tuning.high_water => {
                paused_until = Some(tokio::time::Instant::now() + tuning.poll);
            }
            Some(deadline) if tokio::time::Instant::now() >= deadline => {
                paused_until = if backlog <= tuning.low_water {
                    None
                } else {
                    Some(tokio::time::Instant::now() + tuning.poll)
                };
            }
            _ => {}
        }
        let paused = paused_until.is_some();
        let wake = paused_until.unwrap_or_else(tokio::time::Instant::now);
        tokio::select! {
            _ = tokio::time::sleep_until(wake), if paused => {}
            done = done_rx.recv() => match done {
                Some(ok) => {
                    in_flight = false;
                    sink.buffered = 0;
                    kernel.set_now(now_ms());
                    kernel.complete(if ok { None } else { Some("send") }, &mut sink);
                    let _ = kernel.take_effects();
                }
                None => return,
            },
            _notice = exits.recv() => {
                queue_close(&commands, REMOTE_UNAVAILABLE.0, REMOTE_UNAVAILABLE.1);
                let _ = up_writer.send(close_frame(REMOTE_UNAVAILABLE.0, REMOTE_UNAVAILABLE.1)).await;
                return;
            }
            incoming = reader.next() => match incoming {
                Some(Ok(frame)) if frame.is_text() || frame.is_binary() => {
                    if up_writer.send(frame).await.is_err() {
                        queue_close(&commands, UPSTREAM_CLOSED.0, UPSTREAM_CLOSED.1);
                        return;
                    }
                }
                Some(Ok(Message::Close(frame))) => {
                    let code = frame.as_ref().map(|f| u16::from(f.code)).unwrap_or(1005);
                    let reason = frame.map(|f| clip_reason(f.reason.as_str())).unwrap_or_default();
                    let _ = up_writer.send(close_frame(sendable_close_code(code), &reason)).await;
                    let _ = up_writer.close().await;
                    let _ = commands.send(WriteCmd::Close);
                    return;
                }
                None | Some(Err(_)) => return,
                Some(Ok(_)) => {}
            },
            from_upstream = up_reader.next(), if !paused => match from_upstream {
                Some(Ok(Message::Text(text))) => {
                    kernel.enqueue(Payload::Text(text.as_str().to_string()), Options::Binary(false), None, true, &mut sink);
                    let _ = kernel.take_effects();
                }
                Some(Ok(Message::Binary(bytes))) => {
                    kernel.enqueue(Payload::Buffer(bytes.to_vec()), Options::Binary(true), None, true, &mut sink);
                    let _ = kernel.take_effects();
                }
                Some(Ok(Message::Close(frame))) => {
                    let code = frame.as_ref().map(|f| u16::from(f.code)).unwrap_or(1005);
                    let reason = frame.as_ref().map(|f| clip_reason(f.reason.as_str())).unwrap_or_default();
                    queue_close(&commands, sendable_close_code(code), &reason);
                    let _ = up_writer.close().await;
                    return;
                }
                // Upstream vanished without a close frame: `ws` reports 1006,
                // which `sendableCloseCode` turns into 1011 with no reason.
                None | Some(Err(_)) => {
                    queue_close(&commands, sendable_close_code(1006), "");
                    return;
                }
                Some(Ok(_)) => {}
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The retired `upstreamPath(req, mode)` set `mode=h264` only when the
    /// caller asked for h264 and the parameter was absent. `handle` derives
    /// `mode` from the query, so in production the injection never fires —
    /// but it is still the documented contract and the h264 caller relies on
    /// a `mode` reaching the child either way.
    #[test]
    fn upstream_path_injects_mode_h264_when_absent() {
        assert_eq!(upstream_path("", "h264"), "/ws/remote-screen?mode=h264");
        assert_eq!(
            upstream_path("extra=1", "h264"),
            "/ws/remote-screen?extra=1&mode=h264"
        );
        // An existing mode is kept, not duplicated, whatever its value.
        assert_eq!(
            upstream_path("mode=h264&extra=1", "h264"),
            "/ws/remote-screen?mode=h264&extra=1"
        );
        assert_eq!(
            upstream_path("mode=rfb", "h264"),
            "/ws/remote-screen?mode=rfb"
        );
        // rfb never injects: the processor picks the RFB bridge without a mode.
        assert_eq!(upstream_path("", "rfb"), "/ws/remote-screen");
    }

    #[test]
    fn upstream_path_strips_this_hops_credentials_and_keeps_the_rest() {
        assert_eq!(
            upstream_path("ticket=abc&token=def&mode=h264&extra=1", "h264"),
            "/ws/remote-screen?mode=h264&extra=1"
        );
        // Credential-only queries leave no '?' behind.
        assert_eq!(
            upstream_path("ticket=abc&token=def", "rfb"),
            "/ws/remote-screen"
        );
        // Repeated parameters and their order survive (the child may care).
        assert_eq!(
            upstream_path("a=1&b=2&a=3", "rfb"),
            "/ws/remote-screen?a=1&b=2&a=3"
        );
        // Values that need encoding are round-tripped by the serializer.
        assert_eq!(
            upstream_path("label=a%20b", "rfb"),
            "/ws/remote-screen?label=a+b"
        );
    }

    #[test]
    fn sendable_close_codes_match_the_js_table() {
        for code in [
            1000u16, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014,
        ] {
            assert_eq!(sendable_close_code(code), code, "sendable {code}");
        }
        // Local-state and reserved codes must be replaced, not forwarded.
        for code in [0u16, 1005, 1006, 1015, 1016, 2000, 2999, 3000] {
            let expected = if code == 3000 { 3000 } else { 1011 };
            assert_eq!(sendable_close_code(code), expected, "replaced {code}");
        }
        // The application range 3000–4999 passes through on both ends.
        assert_eq!(sendable_close_code(3000), 3000);
        assert_eq!(sendable_close_code(4999), 4999);
        assert_eq!(sendable_close_code(5000), 1011);
    }

    #[test]
    fn clip_reason_stays_inside_a_control_frame() {
        let long: String = "a".repeat(101);
        let clipped = clip_reason(&long);
        assert_eq!(clipped.chars().count(), 100);
        assert!(clipped.ends_with('…'));
        // Multibyte: 120 'é' is 240 bytes; the 123-byte cap must fall on a
        // char boundary, so the result is 61 whole characters.
        let wide: String = "é".repeat(120);
        let clipped = clip_reason(&wide);
        assert!(clipped.len() <= 123);
        assert_eq!(clipped.chars().count(), 61);
        // Already short: unchanged, multibyte included.
        assert_eq!(clip_reason("bye"), "bye");
        assert_eq!(clip_reason("再见"), "再见");
    }
}
