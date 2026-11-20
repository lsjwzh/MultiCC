//! `/ws/chat` through the real front door: the gateway terminates every client
//! WebSocket and the chat engine is the real Node bridge client
//! (`src/ws/gateway-chat-bridge.js`) running the scripted engine in
//! `fixtures/chat-bridge-node.js`. Nothing here is mocked: the bytes cross the
//! public listener, the Rust frame pump, the private bridge stream and the Node
//! codec, and come back the same way.
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::net::TcpStream as TokioTcp;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{
        client::IntoClientRequest,
        error::Error as WsError,
        protocol::{frame::coding::CloseCode, CloseFrame},
        Message,
    },
    MaybeTlsStream, WebSocketStream,
};

const GATEWAY_BIN: &str = env!("CARGO_BIN_EXE_multicc-gateway");
const FIXTURE: &str = include_str!("fixtures/chat-bridge-node.js");

type Ws = WebSocketStream<MaybeTlsStream<TokioTcp>>;

fn node_binary() -> String {
    std::env::var("MULTICC_TEST_NODE").unwrap_or_else(|_| "node".to_string())
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("repository root")
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

struct Gateway {
    dir: PathBuf,
    state: PathBuf,
    port: u16,
    child: Child,
}

impl Drop for Gateway {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.dir);
    }
}

impl Gateway {
    fn start(tag: &str, mode: &str) -> Gateway {
        // free_port() releases its probe and tests run in parallel, so another
        // front door may take the number first: retry on a fresh port.
        for _ in 0..5 {
            let mut gateway = Gateway::spawn(tag, mode);
            if gateway.wait_ready() {
                return gateway;
            }
        }
        panic!("could not find a free public port for the gateway after 5 attempts");
    }

    fn spawn(tag: &str, mode: &str) -> Gateway {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "multicc-ws-chat-test-{}-{tag}-{nanos}",
            std::process::id()
        ));
        let state = dir.join("state");
        fs::create_dir_all(&state).unwrap();
        fs::write(dir.join("server.js"), FIXTURE).unwrap();
        let port = free_port();
        let log = fs::File::create(dir.join("gateway.log")).unwrap();
        let mut command = Command::new(GATEWAY_BIN);
        command
            .arg("serve")
            .arg("--cwd")
            .arg(&dir)
            .arg("--node")
            .arg(node_binary())
            .arg("server.js")
            .env_clear()
            .env(
                "PATH",
                std::env::var_os("PATH").unwrap_or_else(|| "/usr/local/bin:/usr/bin:/bin".into()),
            )
            .env("PORT", port.to_string())
            .env("MULTICC_GATEWAY_UPSTREAM_WAIT_MS", "3000")
            .env("MULTICC_GATEWAY_BACKOFF_SCALE", "0.01")
            .env("MULTICC_REPO_ROOT", repo_root())
            .env("FIXTURE_MODE", mode)
            .env("FIXTURE_STATE_DIR", &state)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::from(log));
        for key in [
            "HOME",
            "TMPDIR",
            "SystemRoot",
            "SYSTEMROOT",
            "windir",
            "TEMP",
            "TMP",
            "USERPROFILE",
            "APPDATA",
            "LOCALAPPDATA",
            "PATHEXT",
            "ComSpec",
        ] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        let child = command.spawn().expect("spawn multicc-gateway");
        Gateway {
            dir,
            state,
            port,
            child,
        }
    }

    fn log(&self) -> String {
        fs::read_to_string(self.dir.join("gateway.log")).unwrap_or_default()
    }

    fn wait_ready(&mut self) -> bool {
        let deadline = Instant::now() + Duration::from_secs(15);
        while !self.state.join("ready").exists() {
            if self.child.try_wait().unwrap().is_some() && self.log().contains("cannot bind") {
                return false;
            }
            if Instant::now() >= deadline {
                panic!("gateway/fixture never became ready\n{}", self.log());
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        true
    }

    fn run(&self) -> u32 {
        fs::read_to_string(self.state.join("runs"))
            .ok()
            .and_then(|text| text.trim().parse().ok())
            .unwrap_or(0)
    }

    /// The JSON lines the Node engine appended to `closed.log`.
    fn events(&self) -> Vec<Value> {
        fs::read_to_string(self.state.join("closed.log"))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).expect("closed.log line"))
            .collect()
    }

    async fn event(&self, kind: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(found) = self.events().into_iter().find(|e| e["event"] == kind) {
                return found;
            }
            assert!(
                Instant::now() < deadline,
                "no `{kind}` event; saw {:?}\n{}",
                self.events(),
                self.log()
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// Upgrades `/ws/chat`, retrying while the front door still answers 503
    /// (Node has not finished dialling the bridge yet).
    async fn connect_with(&self, path: &str, headers: &[(&str, &str)]) -> Ws {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let mut request = format!("ws://127.0.0.1:{}{path}", self.port)
                .into_client_request()
                .unwrap();
            for (name, value) in headers {
                request.headers_mut().append(
                    tokio_tungstenite::tungstenite::http::HeaderName::from_bytes(name.as_bytes())
                        .unwrap(),
                    value.parse().unwrap(),
                );
            }
            match connect_async(request).await {
                Ok((socket, _)) => return socket,
                Err(WsError::Http(response)) if response.status() == 503 => {
                    assert!(
                        Instant::now() < deadline,
                        "still 503 after 15 s\n{}",
                        self.log()
                    );
                    tokio::time::sleep(Duration::from_millis(30)).await;
                }
                Err(error) => panic!("upgrade failed: {error}\n{}", self.log()),
            }
        }
    }

    async fn connect(&self) -> Ws {
        self.connect_with("/ws/chat?session=s", &[]).await
    }

    /// Sends raw bytes and returns everything the front door wrote back.
    fn raw(&self, request: &str) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", self.port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        stream.write_all(request.as_bytes()).unwrap();
        let mut out = Vec::new();
        let _ = stream.read_to_end(&mut out);
        String::from_utf8_lossy(&out).into_owned()
    }
}

async fn next(ws: &mut Ws) -> Message {
    tokio::time::timeout(Duration::from_secs(20), ws.next())
        .await
        .expect("timed out waiting for a frame")
        .expect("stream ended")
        .expect("frame error")
}

/// Reads until the next data frame, skipping the pings the front door sends.
async fn next_data(ws: &mut Ws) -> Message {
    loop {
        match next(ws).await {
            Message::Ping(_) | Message::Pong(_) => continue,
            other => return other,
        }
    }
}

async fn text(ws: &mut Ws, expected: &str) {
    match next_data(ws).await {
        Message::Text(got) => assert_eq!(got.as_str(), expected),
        other => panic!("expected text {expected:?}, got {other:?}"),
    }
}

async fn send_text(ws: &mut Ws, value: &str) {
    ws.send(Message::Text(value.to_string().into()))
        .await
        .unwrap();
}

/// What a client sees once the socket is gone: no further frame, or an error.
async fn assert_dropped_without_close_frame(ws: &mut Ws) {
    loop {
        match tokio::time::timeout(Duration::from_secs(20), ws.next())
            .await
            .expect("timed out waiting for the connection to end")
        {
            None | Some(Err(_)) => return,
            Some(Ok(Message::Close(frame))) => {
                panic!("a close frame arrived on an abrupt end: {frame:?}")
            }
            Some(Ok(_)) => continue,
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn node_sees_the_request_and_peer_the_way_ws_describes_them() {
    let gateway = Gateway::start("peer", "bridge");
    let mut ws = gateway
        .connect_with(
            "/ws/chat?session=abc&x=%20y",
            &[
                ("Cookie", "a=1"),
                ("Cookie", "b=2"),
                ("X-Custom", "A"),
                ("X-Custom", "B"),
                ("Authorization", "first"),
                ("Authorization", "second"),
            ],
        )
        .await;
    let client_port = match ws.get_ref() {
        MaybeTlsStream::Plain(stream) => stream.local_addr().unwrap().port(),
        _ => unreachable!("plain socket"),
    };
    send_text(&mut ws, "info").await;
    let Message::Text(body) = next_data(&mut ws).await else {
        panic!("info must be text");
    };
    let info: Value = serde_json::from_str(body.as_str()).unwrap();
    assert_eq!(info["url"], "/ws/chat?session=abc&x=%20y");
    assert_eq!(info["method"], "GET");
    assert_eq!(info["headers"]["cookie"], "a=1; b=2");
    assert_eq!(info["headers"]["x-custom"], "A, B");
    assert_eq!(
        info["headers"]["authorization"], "first",
        "Node keeps the first value of a repeated `authorization` header and drops the rest"
    );
    assert_eq!(info["headers"]["upgrade"], "websocket");
    assert_eq!(info["headers"]["sec-websocket-version"], "13");
    assert!(info["headers"]["host"]
        .as_str()
        .unwrap()
        .starts_with("127.0.0.1:"));
    assert_eq!(info["remoteAddress"], "127.0.0.1");
    assert_eq!(info["remotePort"], client_port);
    assert_eq!(info["remoteFamily"], "IPv4");
    assert_eq!(info["localAddress"], "127.0.0.1");
    assert_eq!(info["localPort"], gateway.port);
    assert_eq!(info["readyState"], 1);
    assert_eq!(info["bufferedAmount"], 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn text_and_binary_frames_round_trip_in_order() {
    let gateway = Gateway::start("echo", "bridge");
    let mut ws = gateway.connect().await;
    let mut expected = Vec::new();
    for i in 0..300u32 {
        let message = match i % 4 {
            0 => Message::Binary(vec![(i % 251) as u8; i as usize].into()),
            1 => Message::Text(format!("m{i} \u{4f60}\u{597d}").into()),
            2 => Message::Binary(Vec::new().into()),
            _ => Message::Text(String::new().into()),
        };
        expected.push(message.clone());
        ws.send(message).await.unwrap();
    }
    for want in expected {
        assert_eq!(next_data(&mut ws).await, want);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_burst_of_sends_completes_in_order_and_every_callback_fires() {
    let gateway = Gateway::start("burst", "bridge");
    let mut ws = gateway.connect().await;
    send_text(&mut ws, "burst:2000").await;
    for i in 0..2000 {
        text(&mut ws, &format!("b{i}")).await;
    }
    let Message::Text(done) = next_data(&mut ws).await else {
        panic!("burst summary must be text");
    };
    let done: Value = serde_json::from_str(done.as_str()).unwrap();
    assert_eq!(done["count"], 2000);
    assert_eq!(
        done["peak"], true,
        "bufferedAmount rose while sends were pending"
    );
    let event = gateway.event("burst").await;
    assert_eq!(event["acks"], 2000, "every send callback ran without error");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn large_frames_cross_in_both_directions_byte_for_byte() {
    let gateway = Gateway::start("big", "bridge");
    let mut ws = gateway.connect().await;
    let size = 5 * 1024 * 1024;
    send_text(&mut ws, &format!("big:{size}")).await;
    let Message::Binary(down) = next_data(&mut ws).await else {
        panic!("big frame must be binary");
    };
    assert_eq!(down.len(), size);
    assert!(down.iter().enumerate().all(|(i, b)| *b == (i % 251) as u8));
    let up: Vec<u8> = (0..8 * 1024 * 1024).map(|i| (i % 253) as u8).collect();
    ws.send(Message::Binary(up.clone().into())).await.unwrap();
    let Message::Binary(echoed) = next_data(&mut ws).await else {
        panic!("echo must be binary");
    };
    assert_eq!(echoed.as_ref() as &[u8], up.as_slice());
    let sent = gateway.event("big-sent").await;
    assert_eq!(sent["error"], Value::Null);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn node_close_reaches_the_client_and_the_handshake_completes() {
    let gateway = Gateway::start("close", "bridge");
    let mut ws = gateway.connect().await;
    send_text(&mut ws, "close:4003:Forbidden: no session").await;
    match next_data(&mut ws).await {
        Message::Close(Some(frame)) => {
            assert_eq!(u16::from(frame.code), 4003);
            assert_eq!(frame.reason.as_str(), "Forbidden: no session");
        }
        other => panic!("expected a close frame, got {other:?}"),
    }
    // Reading on lets the client library answer the close; then it ends.
    assert!(matches!(ws.next().await, None | Some(Err(_))));
    let closed = gateway.event("close").await;
    assert_eq!(closed["code"], 4003);
    assert_eq!(closed["reason"], "Forbidden: no session");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_bare_close_carries_no_status_and_is_reported_as_1005() {
    let gateway = Gateway::start("bare", "bridge");
    let mut ws = gateway.connect().await;
    send_text(&mut ws, "close-bare").await;
    assert_eq!(next_data(&mut ws).await, Message::Close(None));
    assert!(matches!(ws.next().await, None | Some(Err(_))));
    let closed = gateway.event("close").await;
    assert_eq!(closed["code"], 1005);
    assert_eq!(closed["reason"], "");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_client_close_is_reported_with_its_status_and_answered() {
    let gateway = Gateway::start("clientclose", "bridge");
    let mut ws = gateway.connect().await;
    ws.close(Some(CloseFrame {
        code: CloseCode::Away,
        reason: "going away".into(),
    }))
    .await
    .unwrap();
    // The server's reply, then the end of the stream.
    let mut saw_reply = false;
    while let Some(item) = ws.next().await {
        if let Ok(Message::Close(Some(frame))) = item {
            assert_eq!(u16::from(frame.code), 1001);
            saw_reply = true;
        }
    }
    assert!(saw_reply, "the close handshake must be answered");
    let closed = gateway.event("close").await;
    assert_eq!(closed["code"], 1001);
    assert_eq!(closed["reason"], "going away");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn terminate_drops_the_connection_without_a_close_frame() {
    let gateway = Gateway::start("terminate", "bridge");
    let mut ws = gateway.connect().await;
    send_text(&mut ws, "terminate").await;
    assert_dropped_without_close_frame(&mut ws).await;
    let closed = gateway.event("close").await;
    assert_eq!(closed["code"], 1006);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pings_work_in_both_directions() {
    let gateway = Gateway::start("ping", "bridge");
    let mut ws = gateway.connect().await;
    // Node pings, the client library pongs on its next read, Node hears it.
    send_text(&mut ws, "ping").await;
    match next(&mut ws).await {
        Message::Ping(payload) => assert!(payload.is_empty()),
        other => panic!("expected the Node ping, got {other:?}"),
    }
    text(&mut ws, "pong").await;
    // The client pings, the front door answers by itself with the payload.
    ws.send(Message::Ping(b"hello".to_vec().into()))
        .await
        .unwrap();
    match next(&mut ws).await {
        Message::Pong(payload) => assert_eq!(payload.as_ref() as &[u8], b"hello"),
        other => panic!("expected the pong, got {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sends_after_close_fail_and_never_reach_the_client() {
    let gateway = Gateway::start("afterclose", "bridge");
    let mut ws = gateway.connect().await;
    send_text(&mut ws, "after-close:5").await;
    match next_data(&mut ws).await {
        Message::Close(Some(frame)) => assert_eq!(frame.reason.as_str(), "bye"),
        other => panic!("expected the close frame first, got {other:?}"),
    }
    let late = gateway.event("after-close").await;
    assert_eq!(late["failures"], 5);
    while let Some(item) = ws.next().await {
        if let Ok(Message::Text(stray)) = item {
            panic!("a send after close reached the client: {stray}");
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn fifty_clients_stay_isolated_from_each_other() {
    let gateway = Gateway::start("fifty", "bridge");
    let first = gateway.connect().await;
    let mut tasks = Vec::new();
    let mut sockets = vec![first];
    for _ in 1..50 {
        sockets.push(gateway.connect().await);
    }
    for (index, mut ws) in sockets.into_iter().enumerate() {
        tasks.push(tokio::spawn(async move {
            for round in 0..20 {
                let body = format!("client{index}-round{round}");
                send_text(&mut ws, &body).await;
                text(&mut ws, &body).await;
            }
            ws
        }));
    }
    for task in tasks {
        task.await.unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_client_that_stops_reading_blocks_nobody_and_can_still_be_dropped() {
    let gateway = Gateway::start("slow", "bridge");
    let mut stalled = gateway.connect().await;
    let mut healthy = gateway.connect().await;
    // 2 x 32 MiB is far beyond what the kernel buffers on a loopback socket,
    // and this client never reads it.
    send_text(&mut stalled, "big:33554432").await;
    send_text(&mut stalled, "big:33554432").await;
    let started = Instant::now();
    for i in 0..50 {
        let body = format!("healthy{i}");
        send_text(&mut healthy, &body).await;
        text(&mut healthy, &body).await;
    }
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "a stalled neighbour slowed a healthy client: {:?}",
        started.elapsed()
    );
    // The stalled client's control frames still get through to Node and take
    // effect although its writer is blocked.
    send_text(&mut stalled, "terminate").await;
    let closed = gateway.event("close").await;
    assert_eq!(closed["code"], 1006);
    send_text(&mut healthy, "still here").await;
    text(&mut healthy, "still here").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn losing_node_ends_clients_abruptly_and_a_new_node_serves_again() {
    let gateway = Gateway::start("crash", "bridge");
    let mut doomed = gateway.connect().await;
    let mut bystander = gateway.connect().await;
    assert_eq!(gateway.run(), 1);
    send_text(&mut doomed, "crash").await;
    assert_dropped_without_close_frame(&mut doomed).await;
    assert_dropped_without_close_frame(&mut bystander).await;
    // The supervisor relaunches Node, which dials the bridge again.
    let deadline = Instant::now() + Duration::from_secs(20);
    while fs::read_to_string(gateway.state.join("ready")).unwrap_or_default() != "2" {
        assert!(
            Instant::now() < deadline,
            "Node was not relaunched\n{}",
            gateway.log()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let mut again = gateway.connect().await;
    send_text(&mut again, "back").await;
    text(&mut again, "back").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn without_a_bridge_the_upgrade_is_a_503_like_any_request_while_node_starts() {
    let gateway = Gateway::start("nobridge", "no-bridge");
    let mut request = format!("ws://127.0.0.1:{}/ws/chat", gateway.port)
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("origin", "http://x".parse().unwrap());
    match connect_async(request).await {
        Err(WsError::Http(response)) => assert_eq!(response.status(), 503),
        other => panic!("expected an HTTP 503, got {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_refused_handshake_is_answered_with_the_planners_status_and_body() {
    use multicc_gateway::ws_handshake::{plan, Request};
    let gateway = Gateway::start("refuse", "bridge");
    // (upgrade, key, version)
    let cases: [(Option<&str>, Option<&str>, Option<&str>); 4] = [
        (Some("websocket"), None, Some("13")),
        (
            Some("websocket"),
            Some("dGhlIHNhbXBsZSBub25jZQ=="),
            Some("7"),
        ),
        (Some("websocket"), Some("dGhlIHNhbXBsZSBub25jZQ=="), None),
        (Some("websocket"), Some("not base64 at all!!"), Some("13")),
    ];
    for (upgrade, key, version) in cases {
        let mut request =
            String::from("GET /ws/chat HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\n");
        if let Some(value) = upgrade {
            request.push_str(&format!("Upgrade: {value}\r\n"));
        }
        if let Some(value) = key {
            request.push_str(&format!("Sec-WebSocket-Key: {value}\r\n"));
        }
        if let Some(value) = version {
            request.push_str(&format!("Sec-WebSocket-Version: {value}\r\n"));
        }
        request.push_str("\r\n");
        let planned = plan(&Request {
            method: "GET",
            upgrade,
            key,
            version,
            protocol: None,
        });
        assert!(!planned.accepted, "case must be a refusal: {request:?}");
        let planned = String::from_utf8(planned.response).unwrap();
        let (planned_head, planned_body) = planned.split_once("\r\n\r\n").unwrap();
        let wire = gateway.raw(&request);
        let (head, body) = wire
            .split_once("\r\n\r\n")
            .unwrap_or_else(|| panic!("no response for {request:?}: {wire:?}"));
        assert_eq!(
            head.lines().next().unwrap(),
            planned_head.lines().next().unwrap(),
            "status line for {request:?}"
        );
        assert_eq!(body, planned_body, "body for {request:?}");
        let lowered = head.to_ascii_lowercase();
        for line in planned_head.lines().skip(1) {
            assert!(
                lowered.contains(&line.to_ascii_lowercase()),
                "header {line:?} missing from {head:?}"
            );
        }
    }
}

#[cfg(unix)]
const NATIVE_CLAUDE: &str = r#"#!/bin/sh
resume=no
for arg in "$@"; do
    case "$arg" in --resume=*) resume=yes ;; esac
done
while IFS= read -r line; do
    case "$line" in
        *'"subtype":"initialize"'*|*'"subtype":"interrupt"'*)
            case "$line" in *'"subtype":"interrupt"'*) printf 'cancelled\n' >> "$HOME/interrupted" ;; esac
            id=$(printf '%s\n' "$line" | /usr/bin/sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
            printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s"}}\n' "$id"
            ;;
        *'"type":"user"'*'"text":"hold"'*)
            printf '%s\n' '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"等待取消"}}}'
            ;;
        *'"type":"user"'*'"text":"fail"'*)
            printf '%s\n' '{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["fixture upstream timeout"]}'
            ;;
        *'"type":"user"'*)
            if [ "$resume" = yes ]; then reply='沿用上下文'; else reply='首次回复'; fi
            printf '{"type":"assistant","message":{"content":[{"type":"text","text":"%s"}]}}\n' "$reply"
            printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0,"usage":{}}'
            ;;
    esac
done
"#;

#[cfg(unix)]
impl Gateway {
    fn start_native() -> Self {
        use std::os::unix::fs::PermissionsExt;
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "multicc-ws-chat-native-{}-{nonce}",
            std::process::id()
        ));
        let state = dir.join("state");
        let work = dir.join("work");
        let binary = dir.join("claude-fixture");
        fs::create_dir_all(&state).unwrap();
        fs::create_dir_all(&work).unwrap();
        fs::write(&binary, NATIVE_CLAUDE).unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(
            state.join("sessions.json"),
            serde_json::json!([{
                "id":"native", "kind":"chat", "type":"gateway", "cwd":work, "cli":"claude",
            }, {
                "id":"internal", "kind":"chat", "taskExecutionSlot":true, "cli":"claude",
            }])
            .to_string(),
        )
        .unwrap();
        let log = fs::File::create(dir.join("gateway.log")).unwrap();
        let child = Command::new(GATEWAY_BIN)
            .arg("serve")
            .arg("--cwd")
            .arg(&dir)
            .arg("--no-node")
            .arg("--ephemeral-loopback")
            .env_clear()
            .env("ACCESS_TOKEN", "gateway-chat-fixture-token")
            .env("PATH", "")
            .env("HOME", &state)
            .env("MULTICC_DATA_DIR", &state)
            .env("MULTICC_CLAUDE_BIN", &binary)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::from(log))
            .spawn()
            .expect("start production gateway");
        let mut gateway = Gateway {
            dir,
            state,
            port: 0,
            child,
        };
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let log = gateway.log();
            if let Some(port) = log.lines().find_map(|line| {
                line.split("listening on 127.0.0.1:")
                    .nth(1)?
                    .split_whitespace()
                    .next()?
                    .parse()
                    .ok()
            }) {
                gateway.port = port;
                break;
            }
            assert!(
                gateway.child.try_wait().unwrap().is_none() && Instant::now() < deadline,
                "{log}"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        gateway
    }

    fn assert_native_process_tree(&self) {
        let output = Command::new("/bin/ps")
            .args(["-A", "-o", "pid=,ppid=,comm="])
            .output()
            .unwrap();
        assert!(output.status.success());
        let output = String::from_utf8_lossy(&output.stdout);
        let rows: Vec<_> = output
            .lines()
            .filter_map(|line| {
                let mut fields = line.split_whitespace();
                Some((
                    fields.next()?.parse::<u32>().ok()?,
                    fields.next()?.parse::<u32>().ok()?,
                    fields.next()?,
                ))
            })
            .collect();
        let mut tree = vec![self.child.id()];
        let mut cursor = 0;
        while let Some(pid) = tree.get(cursor).copied() {
            tree.extend(
                rows.iter()
                    .filter(|(_, parent, _)| *parent == pid)
                    .map(|(child, _, _)| *child),
            );
            cursor += 1;
        }
        assert!(tree.len() >= 2, "provider process was not running");
        println!(
            "隔离监听 127.0.0.1:{}，网关 PID {}",
            self.port,
            self.child.id()
        );
        println!("ps -A -o pid=,ppid=,comm=（网关及其后代）");
        let mut node_count = 0;
        for (pid, parent, command) in rows.into_iter().filter(|row| tree.contains(&row.0)) {
            println!("{pid} {parent} {command}");
            if matches!(
                Path::new(command).file_name().unwrap_or_default().to_str(),
                Some("node" | "nodejs" | "node.exe")
            ) {
                node_count += 1;
            }
        }
        println!("进程树内 Node 进程数 {node_count}");
        assert_eq!(node_count, 0);
    }
}

#[cfg(unix)]
async fn native_frame(socket: &mut Ws, expected_type: &str) -> Value {
    let Message::Text(text) = next_data(socket).await else {
        panic!("expected {expected_type} frame")
    };
    let frame: Value = serde_json::from_str(&text).expect("chat frame JSON");
    assert_eq!(frame["type"], expected_type, "frame {text}");
    assert_eq!(frame["apiVersion"], "v1");
    frame
}

#[cfg(unix)]
async fn native_turn(socket: &mut Ws, prompt: &str, expected: &str) {
    send_text(
        socket,
        &serde_json::json!({"type":"user_message","text":prompt,"clientMsgId":prompt}).to_string(),
    )
    .await;
    let meta = native_frame(socket, "chat_msg_meta").await;
    assert_eq!(meta["message"]["content"], prompt);
    assert_eq!(meta["clientMsgId"], prompt);
    let start = native_frame(socket, "stream_start").await;
    assert_eq!(meta["message"]["turnId"], start["turnId"]);
    let route = native_frame(socket, "provider_route_event").await;
    assert_eq!(route["routePhase"], "selected");
    assert_eq!(route["turnId"], start["turnId"]);
    let answer = native_frame(socket, "assistant").await;
    assert_eq!(answer["message"]["content"][0]["text"], expected);
    assert_eq!(answer["message"]["textSnapshot"], true);
    assert_eq!(answer["providerRouteScope"], "attempt");
    assert_eq!(answer["routeAttemptId"], route["routeAttemptId"]);
    assert_eq!(
        native_frame(socket, "chat_msg_meta").await["role"],
        "assistant"
    );
    native_frame(socket, "result").await;
    assert_eq!(native_frame(socket, "result").await["is_error"], false);
    assert_eq!(
        native_frame(socket, "provider_route_event").await["routePhase"],
        "succeeded"
    );
    text(socket, r#"{"type":"stream_end","apiVersion":"v1"}"#).await;
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn production_no_node_chat_runs_replays_and_cancels_real_provider_processes() {
    let gateway = Gateway::start_native();
    let path = "/ws/chat?session=native";
    let mut socket = gateway.connect_with(path, &[]).await;
    let init = native_frame(&mut socket, "system").await;
    assert_eq!(init["subtype"], "init");
    assert_eq!(init["session_id"], "native");
    assert_eq!(init["is_streaming"], false);
    text(
        &mut socket,
        r#"{"type":"background_tasks","tasks":[],"apiVersion":"v1"}"#,
    )
    .await;
    text(
        &mut socket,
        r#"{"type":"unattended_state","unattended":null,"apiVersion":"v1"}"#,
    )
    .await;
    native_turn(&mut socket, "first", "首次回复").await;
    native_turn(&mut socket, "second", "沿用上下文").await;
    drop(socket);
    let mut socket = gateway.connect_with(path, &[]).await;
    native_frame(&mut socket, "system").await;
    let page = native_frame(&mut socket, "chat_history").await;
    assert_eq!(page["messages"].as_array().unwrap().len(), 4);
    assert_eq!(page["messages"][1]["content"], "首次回复");
    assert_eq!(page["messages"][3]["content"], "沿用上下文");
    native_frame(&mut socket, "background_tasks").await;
    native_frame(&mut socket, "unattended_state").await;
    send_text(
        &mut socket,
        r#"{"type":"user_message","text":"hold","clientMsgId":"held"}"#,
    )
    .await;
    native_frame(&mut socket, "chat_msg_meta").await;
    let start = native_frame(&mut socket, "stream_start").await;
    let route = native_frame(&mut socket, "provider_route_event").await;
    let event = native_frame(&mut socket, "stream_event").await;
    assert_eq!(event["routeAttemptId"], route["routeAttemptId"]);
    drop(socket);
    let mut socket = gateway.connect_with(path, &[]).await;
    let init = native_frame(&mut socket, "system").await;
    assert_eq!(init["is_streaming"], true);
    assert_eq!(init["turnId"], start["turnId"]);
    assert_eq!(
        init["providerRoute"]["routeAttemptId"],
        route["routeAttemptId"]
    );
    let page = native_frame(&mut socket, "chat_history").await;
    assert_eq!(page["messages"][5]["content"], "等待取消");
    assert_eq!(page["messages"][5]["streaming"], true);
    native_frame(&mut socket, "background_tasks").await;
    native_frame(&mut socket, "unattended_state").await;
    gateway.assert_native_process_tree();
    send_text(
        &mut socket,
        r#"{"type":"cancel","operationId":"cancel-held"}"#,
    )
    .await;
    assert_eq!(
        native_frame(&mut socket, "chat_msg_meta").await["role"],
        "assistant"
    );
    assert_eq!(
        native_frame(&mut socket, "provider_route_event").await["routePhase"],
        "released"
    );
    text(&mut socket, r#"{"type":"stream_end","apiVersion":"v1"}"#).await;
    assert_eq!(
        fs::read_to_string(gateway.state.join("interrupted")).unwrap(),
        "cancelled\n"
    );
    send_text(&mut socket, r#"{"type":"user_message","text":"fail"}"#).await;
    native_frame(&mut socket, "chat_msg_meta").await;
    native_frame(&mut socket, "stream_start").await;
    let route = native_frame(&mut socket, "provider_route_event").await;
    let error = native_frame(&mut socket, "error").await;
    assert_eq!(error["code"], "chat_provider_error");
    assert_eq!(error["error"], "fixture upstream timeout");
    assert_eq!(error["routeAttemptId"], route["routeAttemptId"]);
    assert_eq!(
        native_frame(&mut socket, "provider_route_event").await["routePhase"],
        "failed"
    );
    text(&mut socket, r#"{"type":"stream_end","apiVersion":"v1"}"#).await;
    let mut replay = gateway.connect_with(path, &[]).await;
    assert_eq!(
        native_frame(&mut replay, "system").await["is_streaming"],
        false
    );
    let history = native_frame(&mut replay, "chat_history").await;
    let cancelled = &history["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|message| message["cancelled"] == true)
        .expect("cancelled entry");
    assert_eq!(cancelled["content"], "等待取消");
    assert_eq!(cancelled["partial"], true);
    let mut internal = gateway.connect_with("/ws/chat?session=internal", &[]).await;
    text(&mut internal,r#"{"type":"error","error":"Session does not exist.","data":"Session does not exist.\r\n","apiVersion":"v1"}"#).await;
    assert_eq!(next_data(&mut internal).await, Message::Close(None));
}
