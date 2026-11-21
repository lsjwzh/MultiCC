//! End-to-end tests for `ws_remote_screen`: the real `RemoteScreenWs::handle`
//! is mounted in a hyper server (the same server hyper uses inside the front
//! door) and bridges to the fake `multicc-remote` from
//! `examples/remote_child_fixture.rs`, which speaks a minimal WebSocket server
//! in `FIXTURE_WS` mode.
//!
//! Admission runs the real kernel: a local peer is admitted, a public peer is
//! refused, and a public peer carrying a valid one-use ticket is admitted —
//! which pins that the ticket is consumed for `/ws/remote-screen` and not some
//! other path.

use std::convert::Infallible;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::http::Request;
use futures_util::{SinkExt, StreamExt};
use hyper::server::conn::http1;
use hyper_util::rt::TokioIo;
use tokio::net::{TcpListener, TcpStream as TokioTcp};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{protocol::CloseFrame, Message},
    MaybeTlsStream, WebSocketStream,
};

use multicc_core::auth_runtime::{Request as AuthRequest, Response as AuthResponse};
use multicc_core::network_policy::NetworkPolicy;
use multicc_gateway::app::App;
use multicc_gateway::args::ServeOptions;
use multicc_gateway::remote_child::{Config, RemoteChild};
use multicc_gateway::ws_remote_screen::{RemoteScreenWs, Tuning};

mod common;

use common::fixture;

type Ws = WebSocketStream<MaybeTlsStream<TokioTcp>>;

const LOCAL: IpAddr = IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1));
const REMOTE: IpAddr = IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8));
const SECRET: &str = "fixture-secret";

fn temp_dir(tag: &str) -> PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_micros())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!(
        "multicc-ws-remote-{tag}-{}-{stamp}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("temp dir");
    dir
}

fn child(tag: &str, env: &[(&str, &str)]) -> Arc<RemoteChild> {
    child_with_ready_timeout(tag, env, Duration::from_millis(2000))
}

fn child_with_ready_timeout(
    tag: &str,
    env: &[(&str, &str)],
    ready_timeout: Duration,
) -> Arc<RemoteChild> {
    let dir = temp_dir(tag);
    let mut config = Config::new(dir.join("remote-screen"));
    config.binary = Some(fixture());
    config.ready_timeout = ready_timeout;
    config.restart_base = Duration::from_millis(20);
    config.restart_max = Duration::from_millis(200);
    config.stable_reset = Duration::from_millis(200);
    config.shutdown_grace = Duration::from_millis(500);
    config.env = env
        .iter()
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect();
    Arc::new(RemoteChild::new(config))
}

/// A child that cannot start: the unavailable path.
fn missing_child(tag: &str) -> Arc<RemoteChild> {
    let dir = temp_dir(tag);
    let mut config = Config::new(dir.join("remote-screen"));
    config.binary = Some(dir.join("no-such-binary"));
    config.ready_timeout = Duration::from_millis(500);
    config.restart_base = Duration::from_millis(20);
    config.restart_max = Duration::from_millis(200);
    Arc::new(RemoteChild::new(config))
}

/// A real `App` with a locally owned auth runtime, so tickets can be issued
/// and redeemed without a Node child.
fn app(token: &str) -> Arc<App> {
    let dir = temp_dir("app");
    let options = ServeOptions {
        cwd: dir,
        node: None,
        script: "server.js".to_string(),
        script_args: Vec::new(),
        stdin_lifeline: false,
        ephemeral_loopback: false,
    };
    let policy = NetworkPolicy {
        host: "127.0.0.1".to_string(),
        port: 0,
        development: false,
        allow_remote: false,
        access_token: String::new(),
        lan_only: false,
    };
    let app = Arc::new(App::from_env(&options, &policy));
    app.auth
        .install_local(token.to_string())
        .expect("local auth");
    app
}

async fn issue_ticket(app: &App, path: &str) -> String {
    match app
        .auth
        .request(AuthRequest::IssueTicket {
            revision: 0,
            path: path.to_string(),
            metadata: serde_json::json!({}),
        })
        .await
        .expect("issue ticket")
    {
        AuthResponse::Ticket { ticket, .. } => ticket,
        _ => panic!("ticket refused"),
    }
}

/// Mount `RemoteScreenWs::handle` in a hyper server and return its address.
/// `peer` is what the front door would receive from the PROXY line; the test
/// pins it so admission is exercised both ways.
async fn serve(screen: Arc<RemoteScreenWs>, app: Arc<App>, peer: IpAddr) -> SocketAddr {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                return;
            };
            let screen = Arc::clone(&screen);
            let app = Arc::clone(&app);
            tokio::spawn(async move {
                let service =
                    hyper::service::service_fn(move |request: Request<hyper::body::Incoming>| {
                        let screen = Arc::clone(&screen);
                        let app = Arc::clone(&app);
                        async move {
                            let (parts, body) = request.into_parts();
                            let request = Request::from_parts(parts, Body::new(body));
                            let response = screen.handle(app, peer, request).await;
                            Ok::<_, Infallible>(response)
                        }
                    });
                let _ = http1::Builder::new()
                    .serve_connection(TokioIo::new(stream), service)
                    .with_upgrades()
                    .await;
            });
        }
    });
    addr
}

async fn connect(addr: SocketAddr, query: &str) -> Ws {
    let url = format!("ws://{addr}/ws/remote-screen{query}");
    let (ws, _) = connect_async(url.as_str()).await.expect("connect");
    ws
}

/// The next data message within `dur`, ignoring ping/pong.
async fn next_data(ws: &mut Ws, dur: Duration) -> Option<Message> {
    let deadline = Instant::now() + dur;
    loop {
        let left = deadline.checked_duration_since(Instant::now())?;
        match tokio::time::timeout(left, ws.next()).await {
            Ok(Some(Ok(message))) if message.is_text() || message.is_binary() => {
                return Some(message)
            }
            Ok(Some(Ok(Message::Close(_)))) | Ok(None) | Ok(Some(Err(_))) | Err(_) => return None,
            _ => {}
        }
    }
}

/// The close frame (code, reason) within `dur`.
async fn next_close(ws: &mut Ws, dur: Duration) -> Option<(u16, String)> {
    let deadline = Instant::now() + dur;
    loop {
        let left = deadline.checked_duration_since(Instant::now())?;
        match tokio::time::timeout(left, ws.next()).await {
            Ok(Some(Ok(Message::Close(frame)))) => {
                let code = frame.as_ref().map(|f| u16::from(f.code)).unwrap_or(1005);
                let reason = frame
                    .as_ref()
                    .map(|f| f.reason.as_str().to_string())
                    .unwrap_or_default();
                return Some((code, reason));
            }
            Ok(Some(Ok(_))) => {}
            _ => return None,
        }
    }
}

fn read_stat(path: &std::path::Path) -> Option<u64> {
    std::fs::read_to_string(path).ok()?.trim().parse().ok()
}

/// Blocks (polling) until the burst counter holds the same value across three
/// consecutive reads, proving the upstream has stalled (not merely pacing).
async fn wait_plateau(path: &std::path::Path, min: u64, limit: Duration) -> Option<u64> {
    let start = Instant::now();
    let mut previous = None;
    let mut stable = 0;
    while start.elapsed() < limit {
        let value = read_stat(path);
        if value.is_some() && value == previous && value.unwrap_or(0) > min {
            stable += 1;
            if stable >= 3 {
                return value;
            }
        } else {
            stable = 0;
        }
        previous = value;
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
    None
}

async fn wait_growth(path: &std::path::Path, above: u64, limit: Duration) -> Option<u64> {
    let start = Instant::now();
    while start.elapsed() < limit {
        if let Some(value) = read_stat(path) {
            if value > above {
                return Some(value);
            }
        }
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
    None
}

fn requests_file(dir: &std::path::Path) -> String {
    dir.join("requests.jsonl").to_string_lossy().into_owned()
}

// ── tests ───────────────────────────────────────────────────────────────────

#[tokio::test]
async fn rejects_remote_client_without_ticket() {
    let app = app("remote-screen-token");
    let screen = Arc::new(RemoteScreenWs::new(child(
        "reject",
        &[("FIXTURE_WS", "echo")],
    )));
    let addr = serve(screen, app, REMOTE).await;

    let mut ws = connect(addr, "").await;
    let (code, reason) = next_close(&mut ws, Duration::from_secs(5))
        .await
        .expect("a refusal close frame");
    assert_eq!(code, 4003, "reason={reason}");
}

/// A ticket is bound to the path it was issued for. A chat ticket must not open
/// a screen: otherwise anyone who can get a chat ticket could watch and drive
/// the machine.
#[tokio::test]
async fn a_ticket_issued_for_another_path_is_refused() {
    let app = app("remote-screen-token");
    let ticket = issue_ticket(&app, "/ws/chat").await;
    let screen = Arc::new(RemoteScreenWs::new(child(
        "wrong-path",
        &[("FIXTURE_WS", "echo")],
    )));
    let addr = serve(screen, app, REMOTE).await;

    let mut ws = connect(addr, &format!("?ticket={ticket}")).await;
    let (code, reason) = next_close(&mut ws, Duration::from_secs(5))
        .await
        .expect("a refusal close frame");
    assert_eq!(code, 4003, "reason={reason}");
}

/// A ticket is one-use: the first connection spends it, the second is refused.
#[tokio::test]
async fn a_ticket_cannot_be_used_twice() {
    let app = app("remote-screen-token");
    let ticket = issue_ticket(&app, "/ws/remote-screen").await;
    let screen = Arc::new(RemoteScreenWs::new(child(
        "reuse",
        &[("FIXTURE_WS", "echo")],
    )));
    let addr = serve(screen, Arc::clone(&app), REMOTE).await;

    let mut first = connect(addr, &format!("?ticket={ticket}")).await;
    first
        .send(Message::Text("ping".into()))
        .await
        .expect("send text");
    let echoed = next_data(&mut first, Duration::from_secs(5))
        .await
        .expect("the first use is admitted and bridged");
    assert_eq!(echoed, Message::Text("ping".into()));

    let mut second = connect(addr, &format!("?ticket={ticket}")).await;
    let (code, reason) = next_close(&mut second, Duration::from_secs(5))
        .await
        .expect("a refusal close frame");
    assert_eq!(code, 4003, "reason={reason}");
}

/// A made-up ticket string is refused like a missing one.
#[tokio::test]
async fn a_forged_ticket_is_refused() {
    let app = app("remote-screen-token");
    let screen = Arc::new(RemoteScreenWs::new(child(
        "forged",
        &[("FIXTURE_WS", "echo")],
    )));
    let addr = serve(screen, app, REMOTE).await;

    let mut ws = connect(addr, "?ticket=not-a-real-ticket").await;
    let (code, reason) = next_close(&mut ws, Duration::from_secs(5))
        .await
        .expect("a refusal close frame");
    assert_eq!(code, 4003, "reason={reason}");
}

#[tokio::test]
async fn accepts_valid_ticket_from_remote_peer_and_bridges() {
    let app = app("remote-screen-token");
    let ticket = issue_ticket(&app, "/ws/remote-screen").await;
    let screen = Arc::new(RemoteScreenWs::new(child(
        "remote-ticket",
        &[("FIXTURE_WS", "echo")],
    )));
    let addr = serve(Arc::clone(&screen), Arc::clone(&app), REMOTE).await;

    let mut ws = connect(addr, &format!("?ticket={ticket}")).await;
    ws.send(Message::Text("hello".into()))
        .await
        .expect("send text");
    let echoed = next_data(&mut ws, Duration::from_secs(5))
        .await
        .expect("echoed text");
    assert_eq!(echoed, Message::Text("hello".into()));
}

#[tokio::test]
async fn transcode_text_and_binary_with_local_peer() {
    let app = app("remote-screen-token");
    let screen = Arc::new(RemoteScreenWs::new(child(
        "transcode",
        &[("FIXTURE_WS", "echo")],
    )));
    let addr = serve(screen, app, LOCAL).await;

    let mut ws = connect(addr, "").await;

    ws.send(Message::Text("ping".into()))
        .await
        .expect("send text");
    assert_eq!(
        next_data(&mut ws, Duration::from_secs(5)).await,
        Some(Message::Text("ping".into()))
    );

    let payload = vec![0u8, 1, 2, 3, 255];
    ws.send(Message::Binary(payload.clone().into()))
        .await
        .expect("send binary");
    assert_eq!(
        next_data(&mut ws, Duration::from_secs(5)).await,
        Some(Message::Binary(payload.into()))
    );
}

#[tokio::test]
async fn upstream_path_strips_ticket_and_token_and_keeps_the_rest() {
    let app = app("remote-screen-token");
    let ticket = issue_ticket(&app, "/ws/remote-screen").await;
    let dir = temp_dir("path-strip");
    let requests = requests_file(&dir);
    let screen = Arc::new(RemoteScreenWs::new(child(
        "path-strip",
        &[
            ("FIXTURE_WS", "echo"),
            ("FIXTURE_REQUESTS_FILE", requests.as_str()),
        ],
    )));
    let addr = serve(screen, Arc::clone(&app), LOCAL).await;

    // mode is preserved, credentials are stripped, the rest keeps its order.
    let mut ws = connect(
        addr,
        &format!("?ticket={ticket}&token=deadbeef&mode=h264&extra=1"),
    )
    .await;
    ws.send(Message::Text("go".into())).await.expect("send");
    let _ = next_data(&mut ws, Duration::from_secs(5)).await;

    let line = wait_for_line(&requests, Duration::from_secs(5))
        .await
        .expect("a recorded upstream request");
    let record: serde_json::Value = serde_json::from_str(&line).expect("record json");
    assert_eq!(record["target"], "/ws/remote-screen?mode=h264&extra=1");
    assert_eq!(record["secretOk"], serde_json::Value::Bool(true));
    assert_eq!(
        record["headers"]["x-multicc-remote-secret"],
        serde_json::Value::String(SECRET.into())
    );
}

/// Polls a JSONL file until at least one line exists.
async fn wait_for_line(path: &str, limit: Duration) -> Option<String> {
    let start = Instant::now();
    while start.elapsed() < limit {
        if let Ok(text) = std::fs::read_to_string(path) {
            if let Some(line) = text.lines().next() {
                return Some(line.to_string());
            }
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    None
}

#[tokio::test]
async fn pre_upstream_queue_overflows_at_one_mib() {
    // The silent fixture cannot become ready while frames are queued; its
    // longer timeout leaves the queue limit, rather than startup timing, in control.
    let app = app("remote-screen-token");
    let screen = Arc::new(RemoteScreenWs::new(child_with_ready_timeout(
        "overflow",
        &[("FIXTURE_MODE", "silent")],
        Duration::from_secs(20),
    )));
    let addr = serve(screen, app, LOCAL).await;
    let mut ws = connect(addr, "").await;

    // Exactly one frame over 1 MiB, avoiding extra writes after the close.
    for _ in 0..17 {
        if ws
            .send(Message::Binary(vec![b'x'; 64 * 1024].into()))
            .await
            .is_err()
        {
            break;
        }
    }
    let (code, reason) = next_close(&mut ws, Duration::from_secs(6))
        .await
        .expect("queue overflow close");
    assert_eq!(code, 1013, "reason={reason}");
    assert_eq!(reason, "queue-overflow");
}

#[tokio::test]
async fn upstream_close_codes_pass_through_or_become_1011() {
    // (fixture mode, expected client close code)
    let cases = [
        ("close:3000", 3000),
        ("close:4001", 4001),
        ("close-empty", 1011), // empty close frame -> 1005 -> 1011
        ("drop", 1011),        // abrupt EOF -> 1006 -> 1011
    ];
    for (mode, expected) in cases {
        let app = app("remote-screen-token");
        let screen = Arc::new(RemoteScreenWs::new(child(
            &format!("close-{}", expected),
            &[("FIXTURE_WS", mode)],
        )));
        let addr = serve(screen, app, LOCAL).await;
        let mut ws = connect(addr, "").await;
        // `close:<code>` waits for the first frame; harmless for the others.
        let _ = ws.send(Message::Text("x".into())).await;
        let (code, _reason) = next_close(&mut ws, Duration::from_secs(5))
            .await
            .unwrap_or_else(|| panic!("no close for {mode}"));
        assert_eq!(code, expected, "mode={mode}");
    }
}

#[tokio::test]
async fn client_close_is_forwarded_to_upstream() {
    let app = app("remote-screen-token");
    let dir = temp_dir("client-close");
    let events = dir.join("ws-events");
    let events_str = events.to_string_lossy().into_owned();
    let screen = Arc::new(RemoteScreenWs::new(child(
        "client-close",
        &[
            ("FIXTURE_WS", "echo"),
            ("FIXTURE_WS_FILE", events_str.as_str()),
        ],
    )));
    let addr = serve(screen, app, LOCAL).await;

    let mut ws = connect(addr, "").await;
    ws.send(Message::Text("hi".into())).await.expect("send");
    let _ = next_data(&mut ws, Duration::from_secs(5)).await;
    // The retired handler forwards the client's close code to the upstream.
    ws.close(Some(CloseFrame {
        code: 3000.into(),
        reason: "bye".into(),
    }))
    .await
    .expect("close");

    let code = wait_for_event(&events, "close:3000", Duration::from_secs(5)).await;
    assert_eq!(code, Some(3000), "upstream should see close 3000");
}

async fn wait_for_event(path: &std::path::Path, needle: &str, limit: Duration) -> Option<u16> {
    let start = Instant::now();
    while start.elapsed() < limit {
        if let Ok(text) = std::fs::read_to_string(path) {
            if let Some(line) = text.lines().find(|line| *line == needle) {
                return line.strip_prefix("close:")?.parse().ok();
            }
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    None
}

#[tokio::test]
async fn ensure_failure_closes_with_1011() {
    let app = app("remote-screen-token");
    let screen = Arc::new(RemoteScreenWs::new(missing_child("missing")));
    let addr = serve(screen, app, LOCAL).await;

    let mut ws = connect(addr, "").await;
    let (code, reason) = next_close(&mut ws, Duration::from_secs(5))
        .await
        .expect("an unavailable close");
    assert_eq!(code, 1011);
    assert_eq!(reason, "remote-unavailable");
}

#[tokio::test]
async fn child_crash_closes_every_session_with_1011() {
    let app = app("remote-screen-token");
    // The fake remote is ready, then exits ~1s later; every bridge closes.
    let screen = Arc::new(RemoteScreenWs::new(child(
        "crash",
        &[("FIXTURE_WS", "echo"), ("FIXTURE_EXIT_AFTER_MS", "1000")],
    )));
    let addr = serve(screen, app, LOCAL).await;

    let mut first = connect(addr, "").await;
    let mut second = connect(addr, "").await;
    // Prove both are live before the crash.
    first.send(Message::Text("a".into())).await.expect("first");
    second
        .send(Message::Text("b".into()))
        .await
        .expect("second");
    let _ = next_data(&mut first, Duration::from_secs(5)).await;
    let _ = next_data(&mut second, Duration::from_secs(5)).await;

    let (code_a, _) = next_close(&mut first, Duration::from_secs(8))
        .await
        .expect("first crash close");
    let (code_b, _) = next_close(&mut second, Duration::from_secs(8))
        .await
        .expect("second crash close");
    assert_eq!(code_a, 1011);
    assert_eq!(code_b, 1011);
}

#[tokio::test]
async fn backpressure_pauses_the_upstream_then_resumes() {
    let app = app("remote-screen-token");
    let dir = temp_dir("backpressure");
    let stats = dir.join("burst-count");
    let stats_str = stats.to_string_lossy().into_owned();
    let child = child(
        "backpressure",
        &[
            ("FIXTURE_WS", "burst"),
            ("FIXTURE_WS_CHUNK", "4096"),
            ("FIXTURE_WS_STATS_FILE", stats_str.as_str()),
        ],
    );
    let tuning = Tuning {
        queue_limit: 1024 * 1024,
        high_water: 16 * 1024,
        low_water: 4 * 1024,
        poll: Duration::from_millis(5),
    };
    let screen = Arc::new(RemoteScreenWs::with_tuning(child, tuning));
    let addr = serve(screen, app, LOCAL).await;

    // Connect but never read: the client socket backs up, the kernel queue
    // crosses the high water mark, and the upstream reader is paused.
    let (ws, _) = connect_async(format!("ws://{addr}/ws/remote-screen").as_str())
        .await
        .expect("connect");
    let plateau = wait_plateau(&stats, 0, Duration::from_secs(15))
        .await
        .expect("the burst should stall while the client is not reading");
    assert!(plateau > 0);

    // Now drain the client: the backlog falls under the low water mark, the
    // reader resumes, and the burst counter climbs again.
    tokio::spawn(async move {
        let mut ws = ws;
        while let Some(Ok(_)) = ws.next().await {}
    });
    let grown = wait_growth(&stats, plateau, Duration::from_secs(10))
        .await
        .expect("the burst should resume once the client drains");
    assert!(grown > plateau);
}

fn hex_of(data: &[u8]) -> String {
    data.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Polls a capture file until it holds at least `count` lines.
async fn wait_for_lines(
    path: &std::path::Path,
    count: usize,
    limit: Duration,
) -> Option<Vec<String>> {
    let start = Instant::now();
    while start.elapsed() < limit {
        if let Ok(text) = std::fs::read_to_string(path) {
            let lines: Vec<String> = text.lines().map(str::to_string).collect();
            if lines.len() >= count {
                return Some(lines);
            }
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    std::fs::read_to_string(path)
        .ok()
        .map(|text| text.lines().map(str::to_string).collect())
}

/// Frames sent while the child is still starting are queued and flushed in
/// arrival order once the dial completes. The client's first frames are the
/// protocol handshake, so a reorder corrupts the whole session.
#[tokio::test]
async fn pre_open_frames_flush_in_arrival_order() {
    let app = app("remote-screen-token");
    let dir = temp_dir("pre-open-order");
    let capture = dir.join("capture");
    let capture_str = capture.to_string_lossy().into_owned();
    let screen = Arc::new(RemoteScreenWs::new(child(
        "pre-open-order",
        &[
            ("FIXTURE_WS", "echo"),
            ("FIXTURE_READY_DELAY_MS", "800"),
            ("FIXTURE_WS_CAPTURE", capture_str.as_str()),
        ],
    )));
    let addr = serve(screen, app, LOCAL).await;
    let mut ws = connect(addr, "").await;

    let sent: Vec<Vec<u8>> = (0..24u8)
        .map(|index| vec![index, index.wrapping_add(1), 0xff - index])
        .collect();
    for frame in &sent {
        ws.send(Message::Binary(frame.clone().into()))
            .await
            .expect("queue before the upstream opens");
    }

    // Nothing dropped, nothing reordered on the way up: the child sees them
    // in exactly the order the client sent them.
    let lines = wait_for_lines(&capture, sent.len(), Duration::from_secs(8))
        .await
        .expect("captured frames");
    assert_eq!(lines.len(), sent.len());
    for (index, line) in lines.iter().enumerate() {
        assert_eq!(
            line,
            &format!("2:{}", hex_of(&sent[index])),
            "upstream frame {index} out of order"
        );
    }

    // And the echo proves the downstream order matches too.
    for (index, frame) in sent.iter().enumerate() {
        let echoed = next_data(&mut ws, Duration::from_secs(5))
            .await
            .unwrap_or_else(|| panic!("frame {index} never came back"));
        assert_eq!(
            echoed,
            Message::Binary(frame.clone().into()),
            "client frame {index} out of order"
        );
    }
}

/// Golden access units in the wire shape the desktop agent speaks:
/// `[type][u32 length][payload]` (type 2 = keyframe, 3 = delta). Every byte
/// must cross the front door unchanged in both directions.
fn golden_access_units() -> Vec<Vec<u8>> {
    vec![
        vec![
            0x02, 0x00, 0x00, 0x00, 0x0b, 0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0x84, 0x21, 0xff,
            0xfe,
        ],
        vec![
            0x03, 0x00, 0x00, 0x00, 0x07, 0x00, 0x00, 0x00, 0x01, 0x41, 0x9a, 0x00, 0xff,
        ],
        vec![
            0x03, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x01, 0x41, 0x9a, 0x01,
        ],
    ]
}

#[tokio::test]
async fn h264_access_units_cross_the_bridge_byte_for_byte() {
    let app = app("remote-screen-token");
    let dir = temp_dir("h264-bytes");
    let push = dir.join("push.hex");
    let capture = dir.join("capture");
    let golden = golden_access_units();
    let push_text: String = golden
        .iter()
        .map(|unit| format!("{}\n", hex_of(unit)))
        .collect();
    std::fs::write(&push, push_text).expect("push file");
    let push_str = push.to_string_lossy().into_owned();
    let capture_str = capture.to_string_lossy().into_owned();

    let screen = Arc::new(RemoteScreenWs::new(child(
        "h264-bytes",
        &[
            ("FIXTURE_WS", "echo"),
            ("FIXTURE_WS_PUSH_FILE", push_str.as_str()),
            ("FIXTURE_WS_CAPTURE", capture_str.as_str()),
        ],
    )));
    let addr = serve(screen, app, LOCAL).await;

    let mut ws = connect(addr, "?mode=h264").await;

    // Upstream → front door → browser: the pushed frames arrive verbatim.
    for (index, unit) in golden.iter().enumerate() {
        let received = next_data(&mut ws, Duration::from_secs(5))
            .await
            .unwrap_or_else(|| panic!("pushed frame {index} never arrived"));
        assert_eq!(
            received,
            Message::Binary(unit.clone().into()),
            "downstream frame {index} changed"
        );
    }

    // Browser → front door → upstream: the child captured the same bytes.
    for unit in &golden {
        ws.send(Message::Binary(unit.clone().into()))
            .await
            .expect("send upstream");
    }
    let lines = wait_for_lines(&capture, golden.len(), Duration::from_secs(5))
        .await
        .expect("captured frames");
    for (index, unit) in golden.iter().enumerate() {
        assert_eq!(
            lines[index],
            format!("2:{}", hex_of(unit)),
            "upstream frame {index} changed"
        );
    }
}
