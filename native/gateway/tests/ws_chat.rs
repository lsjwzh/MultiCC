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
        .parent()
        .and_then(Path::parent)
        .expect("repository root")
        .to_path_buf()
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
configuration=
read_configuration=no
for arg in "$@"; do
    if [ "$read_configuration" = yes ]; then
        configuration=$arg
        read_configuration=no
    fi
    case "$arg" in
        --resume=*) resume=yes ;;
        --mcp-config) read_configuration=yes ;;
    esac
done
ask_user() {
    url=$(printf '%s\n' "$configuration" | /usr/bin/sed -n 's/.*"url":"\([^"]*\)".*/\1/p')
    auth=$(printf '%s\n' "$configuration" | /usr/bin/sed -n 's/.*"Authorization":"\([^"]*\)".*/\1/p')
    /usr/bin/curl --noproxy '*' --silent --show-error --max-time 5 \
        -H "Authorization: $auth" -H 'Content-Type: application/json' \
        -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"wait_for_user_answer","arguments":{"question":"Which workspace?","options":["local","remote"]}}}' "$url"
}
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
        *'"type":"user"'*'"text":"ask"'*)
            response=$(ask_user)
            case "$response" in
                *'waiting_reply_signal_recorded'*)
                    printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"result":"Which workspace?","usage":{}}' ;;
                *)
                    printf '%s\n' '{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["question tool failed"]}' ;;
            esac
            ;;
        *'"type":"user"'*'"text":"fail"'*)
            printf '%s\n' '{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["fixture upstream timeout"]}'
            ;;
        *'"type":"user"'*'"text":"provider-test"'*)
            case "$ANTHROPIC_AUTH_TOKEN:$ANTHROPIC_API_KEY" in
                proxy-route_*:)
                    response=$(/usr/bin/curl --noproxy '*' --silent --show-error --max-time 5 \
                        -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN" \
                        -H 'Content-Type: application/json' \
                        -d '{"model":"sonnet","messages":[]}' "$ANTHROPIC_BASE_URL/v1/messages") ;;
                *) response='invalid child credentials' ;;
            esac
            case "$response" in
                '{"echo":"[REDACTED_PROVIDER_ROUTE]","text":"中文"}')
                    printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"result":"自定义线路","usage":{}}' ;;
                *) printf '%s\n' '{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["provider fixture response did not match"]}' ;;
            esac
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
        Self::start_native_with_path("")
    }

    fn start_native_with_path(path: &str) -> Self {
        use std::os::unix::fs::PermissionsExt;
        let nonce = multicc_core::random_id::random_uuid_v4().unwrap();
        let dir = std::env::temp_dir().join(format!(
            "multicc-ws-chat-native-{}-{nonce}",
            std::process::id()
        ));
        let state = dir.join("state");
        let work = dir.join("work");
        let shell_work = dir.join("shell-work");
        let binary = dir.join("claude-fixture");
        fs::create_dir_all(&state).unwrap();
        fs::create_dir_all(&work).unwrap();
        fs::create_dir_all(&shell_work).unwrap();
        let shell_work = shell_work.canonicalize().unwrap();
        fs::write(&binary, NATIVE_CLAUDE).unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(
            state.join("sessions.json"),
            serde_json::json!([{
                "id":"native", "kind":"chat", "type":"gateway", "cwd":work, "cli":"claude",
            }, {
                "id":"internal", "kind":"chat", "taskExecutionSlot":true, "cli":"claude",
            }, {
                "id":"bound", "kind":"chat", "cli":"claude", "dirId":"fixture-dir", "taskBoundTaskId":"tsk_bound",
                "worktreePath":shell_work, "branch":"multicc/bound", "workspaceState":"awake"
            }])
            .to_string(),
        )
        .unwrap();
        let ledger = state.join("task-shells.sqlite");
        let mut tasks =
            multicc_core::task_store::TaskStore::open(ledger.to_str().unwrap()).unwrap();
        for (kind, id, row) in [
            (
                "shell",
                "shell-bound",
                serde_json::json!({"id":"shell-bound","sourceSessionId":"bound",
             "dirId":"fixture-dir","currentTaskId":"tsk_bound","defaultTaskId":"tsk_bound","standalone":true,"cursorVersion":0}),
            ),
            (
                "task",
                "tsk_bound",
                serde_json::json!({"id":"tsk_bound","sessionId":"bound","ownerShellId":"shell-bound",
             "dirId":"fixture-dir","title":"bound task","ready":true,"taskFirst":true}),
            ),
            (
                "link",
                "shell-bound:tsk_bound",
                serde_json::json!({"shellId":"shell-bound","taskId":"tsk_bound"}),
            ),
            (
                "workspace:record",
                "ws_bound",
                serde_json::json!({"id":"ws_bound","dirId":"fixture-dir",
             "path":shell_work,"branch":"multicc/bound","residency":"resident"}),
            ),
            (
                "workspace:binding",
                "bound",
                serde_json::json!({"sessionId":"bound","workspaceId":"ws_bound"}),
            ),
        ] {
            tasks
                .run(
                    &serde_json::json!({"op":"set","kind":kind,"id":id,"body":row.to_string()})
                        .to_string(),
                )
                .unwrap();
        }
        drop(tasks);
        Self::launch_native(dir, state, path)
    }

    fn restart_native(&mut self) {
        if self.child.try_wait().unwrap().is_none() {
            self.child.kill().unwrap();
            self.child.wait().unwrap();
        }
        let mut next = Self::launch_native(self.dir.clone(), self.state.clone(), "");
        std::mem::swap(self, &mut next);
        // Drop the old process handle without removing the reused state.
        next.dir = PathBuf::new();
    }

    fn launch_native(dir: PathBuf, state: PathBuf, path: &str) -> Self {
        let binary = dir.join("claude-fixture");
        let log = fs::File::create(dir.join("gateway.log")).unwrap();
        let executable =
            std::env::var_os("MULTICC_WS_CHAT_PROOF_GATEWAY").unwrap_or_else(|| GATEWAY_BIN.into());
        let child = Command::new(executable)
            .arg("serve")
            .arg("--cwd")
            .arg(&dir)
            .arg("--no-node")
            .arg("--ephemeral-loopback")
            .env_clear()
            .env("ACCESS_TOKEN", "gateway-chat-fixture-token")
            .env("PATH", path)
            .env("HOME", &state)
            .env("MULTICC_DATA_DIR", &state)
            .env("MULTICC_CLAUDE_BIN", &binary)
            .env("CODEX_BIN", dir.join("codex-fixture"))
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
fn native_shell_request(gateway: &Gateway, method: &str, path: &str, body: Value) -> (u16, Value) {
    let body = if body.is_null() {
        String::new()
    } else {
        body.to_string()
    };
    let reply = gateway.raw(&format!(
        "{method} {path} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer gateway-chat-fixture-token\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    ));
    let (head, body) = reply.split_once("\r\n\r\n").expect("HTTP response");
    let status = head
        .split_ascii_whitespace()
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    (status, serde_json::from_str(body).expect(&reply))
}

#[cfg(unix)]
fn shell_fixture_row(gateway: &Gateway, kind: &str, id: &str, row: Value) {
    let ledger = gateway.state.join("task-shells.sqlite");
    let mut store = multicc_core::task_store::TaskStore::open(ledger.to_str().unwrap()).unwrap();
    store
        .run(
            &serde_json::json!({"op":"set","kind":kind,"id":id,"body":row.to_string()}).to_string(),
        )
        .unwrap();
}

#[cfg(unix)]
fn mutate_native_records(gateway: &Gateway, apply: impl FnOnce(&mut Vec<Value>)) {
    use multicc_core::{durable_state, js};
    let file = gateway.state.join("sessions.json");
    let mut data = durable_state::load_or_recover(&file)
        .unwrap()
        .map(|v| js::to_serde(&v))
        .unwrap_or_else(|| Value::Array(Vec::new()));
    apply(data.as_array_mut().expect("sessions.json array"));
    durable_state::save(&file, "sessions", &js::from_serde(&data)).unwrap();
}

#[cfg(unix)]
fn add_native_record(gateway: &Gateway, record: Value) {
    mutate_native_records(gateway, |records| records.push(record));
}

#[cfg(unix)]
#[tokio::test]
async fn native_shell_registration_is_idempotent_and_rolls_back_an_identity_conflict() {
    let gateway = Gateway::start_native();
    add_native_record(
        &gateway,
        serde_json::json!({"id":"empty","kind":"chat","dirId":"fixture-dir","cli":"claude","label":"Empty"}),
    );
    add_native_record(
        &gateway,
        serde_json::json!({"id":"conflict","kind":"chat","dirId":"fixture-dir","cli":"claude","taskBoundTaskId":"tsk_bound"}),
    );
    let post = |id: &str| {
        native_shell_request(
            &gateway,
            "POST",
            "/api/task-shells",
            serde_json::json!({"sessionId":id}),
        )
    };
    let (status, first) = post("empty");
    assert_eq!(status, 200, "{first}");
    assert_eq!(first["currentTaskId"], first["defaultTaskId"]);
    assert_eq!(first["tasks"][0]["sessionId"], "empty");
    assert_eq!(first["receipts"], serde_json::json!([]));
    assert_eq!(post("empty"), (200, first.clone()));
    let path = format!("/api/task-shells/{}", first["id"].as_str().unwrap());
    assert_eq!(
        native_shell_request(&gateway, "GET", &path, Value::Null),
        (200, first)
    );

    let (status, rejected) = post("conflict");
    assert_eq!(status, 409, "{rejected}");
    assert_eq!(rejected["code"], "task_identity_mismatch");
    let id = multicc_core::task_shell::chat::source_shell_id("conflict");
    let (status, absent) = native_shell_request(
        &gateway,
        "GET",
        &format!("/api/task-shells/{id}"),
        Value::Null,
    );
    assert_eq!(status, 404, "{absent}");
    assert_eq!(absent["code"], "shell_not_found");
}

#[cfg(unix)]
#[tokio::test]
async fn native_shell_routes_from_another_session_and_replays_the_target_receipt() {
    let gateway = Gateway::start_native();
    let work = gateway.dir.join("other-worktree");
    fs::create_dir(&work).unwrap();
    let work = work.canonicalize().unwrap();
    add_native_record(
        &gateway,
        serde_json::json!({"id":"other","kind":"chat","dirId":"fixture-dir","cli":"claude",
        "taskBoundTaskId":"tsk_other","workspaceState":"awake","worktreePath":work,"branch":"multicc/other"}),
    );
    for (kind, id, row) in [
        (
            "shell",
            "shell-bound",
            serde_json::json!({"id":"shell-bound","sourceSessionId":"bound","dirId":"fixture-dir",
            "currentTaskId":"tsk_other","defaultTaskId":"tsk_other","standalone":false,"cursorVersion":1}),
        ),
        (
            "task",
            "tsk_other",
            serde_json::json!({"id":"tsk_other","sessionId":"other","ownerShellId":"shell-bound",
            "ready":true,"taskFirst":true,"dirId":"fixture-dir","title":"Other"}),
        ),
        (
            "link",
            "shell-bound:tsk_other",
            serde_json::json!({"shellId":"shell-bound","taskId":"tsk_other"}),
        ),
        (
            "workspace:record",
            "ws_other",
            serde_json::json!({"id":"ws_other","dirId":"fixture-dir","path":work,
            "branch":"multicc/other","residency":"resident"}),
        ),
        (
            "workspace:binding",
            "other",
            serde_json::json!({"sessionId":"other","workspaceId":"ws_other"}),
        ),
    ] {
        shell_fixture_row(&gateway, kind, id, row);
    }
    let select = |task, version| {
        native_shell_request(
            &gateway,
            "POST",
            "/api/task-shells/shell-bound/select-target",
            serde_json::json!({"taskId":task,"expectedCursorVersion":version}),
        )
    };
    let (status, stale) = select("tsk_bound", 0);
    assert_eq!(status, 409, "{stale}");
    assert_eq!(stale["code"], "stale_shell_cursor");
    assert_eq!(select("tsk_other", 1).1["changed"], false);
    let mut source = gateway
        .connect_with("/ws/chat?session=bound&shell=shell-bound", &[])
        .await;
    let mut target = gateway
        .connect_with("/ws/chat?session=other&shell=shell-bound", &[])
        .await;
    until(&mut source, "session_queue").await;
    until(&mut target, "session_queue").await;
    let send =
        r#"{"type":"user_message","taskShell":true,"clientMsgId":"cross-1","text":"across"}"#;
    send_text(&mut source, send).await;
    let receipt = until(&mut source, "task_shell_routed").await;
    assert_eq!(receipt["taskId"], "tsk_other");
    assert_eq!(receipt["sessionId"], "other");
    assert_eq!(
        until(&mut target, "chat_msg_meta").await["message"]["content"],
        "across"
    );
    until(&mut target, "stream_end").await;
    until(&mut target, "session_queue").await;
    send_text(&mut source, send).await;
    assert_eq!(until(&mut source, "task_shell_routed").await, receipt);
    assert!(!gateway.state.join("chat_history/bound.json").exists());
}

#[cfg(unix)]
#[tokio::test]
async fn native_scope_reports_verified_reference_and_refuses_wrong_owner_or_corrupt_data() {
    use multicc_core::{js, task_shell::reference};
    let gateway = Gateway::start_native();
    let history = [
        js::from_serde(
            &serde_json::json!({"id":"u","role":"user","content":"source question","turnId":"t"}),
        ),
        js::from_serde(
            &serde_json::json!({"id":"a","role":"assistant","content":"verified source reply","turnId":"t"}),
        ),
    ];
    let mut snapshot = js::to_serde(&reference::snapshot(
        &js::JsValue::from("tsk_source"),
        &history,
        None,
        12_000,
    ));
    let hash = snapshot["hash"].as_str().unwrap().to_owned();
    shell_fixture_row(&gateway, "snapshot", &hash, snapshot.clone());
    shell_fixture_row(
        &gateway,
        "receipt",
        "sr_trace",
        serde_json::json!({"id":"sr_trace",
        "taskId":"tsk_bound","shellId":"shell-bound","contextSeedSnapshotIds":[hash]}),
    );
    let fetch = |id| {
        native_shell_request(
            &gateway,
            "GET",
            &format!("/api/sessions/{id}/context?traceId=sr_trace&includeMessages=1"),
            Value::Null,
        )
    };
    let (status, report) = fetch("bound");
    assert_eq!(status, 200, "{report}");
    assert_eq!(report["sources"][0]["taskId"], "tsk_source");
    assert_eq!(report["sources"][0]["messageCount"], 2);
    assert_eq!(fetch("native").0, 404);
    snapshot["messages"][1]["content"] = serde_json::json!("tampered");
    snapshot["hash"] = serde_json::json!("bad-digest");
    shell_fixture_row(&gateway, "snapshot", "bad-digest", snapshot);
    shell_fixture_row(
        &gateway,
        "receipt",
        "sr_trace",
        serde_json::json!({"id":"sr_trace",
        "taskId":"tsk_bound","shellId":"shell-bound","contextSeedSnapshotIds":["bad-digest"]}),
    );
    let (status, refusal) = fetch("bound");
    assert_eq!(status, 409, "{refusal}");
    assert_eq!(refusal["code"], "snapshot_unverified");
}

#[cfg(unix)]
#[tokio::test]
async fn native_http_delivery_retries_and_conflicts_share_the_chat_receipt() {
    let gateway = Gateway::start_native();
    let mut socket = gateway
        .connect_with("/ws/chat?session=bound&shell=shell-bound", &[])
        .await;
    until(&mut socket, "session_queue").await;
    let post = |body| {
        native_shell_request(
            &gateway,
            "POST",
            "/api/task-shells/shell-bound/messages",
            body,
        )
    };
    let body = serde_json::json!({"clientMsgId":"http-1","text":"hold"});
    let (status, first) = post(body.clone());
    assert_eq!(status, 200, "{first}");
    let turn = until(&mut socket, "stream_start").await["turnId"].clone();
    until(&mut socket, "stream_event").await;
    gateway.assert_native_process_tree();
    assert_eq!(post(body), (200, first.clone()));
    let retry = format!(
        "/api/task-shells/shell-bound/receipts/{}/retry",
        first["receiptId"].as_str().unwrap()
    );
    assert_eq!(
        native_shell_request(&gateway, "POST", &retry, serde_json::json!({})),
        (200, first)
    );
    let (status, conflict) = post(serde_json::json!({"clientMsgId":"http-1","text":"changed"}));
    assert_eq!(status, 409, "{conflict}");
    assert_eq!(conflict["code"], "idempotency_conflict");
    let (status, stale) = post(
        serde_json::json!({"clientMsgId":"http-cancel","intent":"cancel","text":"","taskId":"tsk_bound","turnId":"wrong"}),
    );
    assert_eq!(status, 409, "{stale}");
    assert_eq!(stale["code"], "stale_control");
    let (status, cancelled) = post(
        serde_json::json!({"clientMsgId":"http-cancel-ok","intent":"cancel","text":"","taskId":"tsk_bound","turnId":turn}),
    );
    assert_eq!(status, 200, "{cancelled}");
    until(&mut socket, "stream_end").await;
}

#[cfg(unix)]
#[tokio::test]
async fn native_http_failed_receipt_retries_after_repair_and_restart() {
    let mut gateway = Gateway::start_native();
    assert_eq!(
        native_shell_request(&gateway, "GET", "/readyz", Value::Null).0,
        200
    );
    let records = gateway.state.join("sessions.json");
    let set_bound_cli = |cli: &str| {
        use multicc_core::{durable_state, js::JsValue, quota_guard};
        let mut data = durable_state::load_or_recover(&records).unwrap().unwrap();
        let JsValue::Array(rows) = &mut data else {
            panic!("expected session records")
        };
        let bound = rows
            .iter_mut()
            .find(|row| row.get("id") == Some(&JsValue::from("bound")))
            .unwrap();
        quota_guard::set(bound, "cli", JsValue::from(cli));
        durable_state::save(&records, "sessions", &data).unwrap();
    };
    set_bound_cli("codex");
    let (status, rejected) = native_shell_request(
        &gateway,
        "POST",
        "/api/task-shells/shell-bound/messages",
        serde_json::json!({"clientMsgId":"retry-repair","text":"after repair"}),
    );
    assert_eq!(status, 409, "{rejected}");
    assert_eq!(rejected["code"], "chat_route_unavailable");
    let receipt = rejected["receiptId"].as_str().unwrap();
    let tasks = multicc_core::task_store::TaskStore::open(
        gateway.state.join("task-shells.sqlite").to_str().unwrap(),
    )
    .unwrap();
    assert_eq!(
        tasks.delivery_record("receipt", receipt).unwrap()["status"],
        "failed"
    );
    drop(tasks);
    set_bound_cli("claude");
    gateway.restart_native();
    let mut socket = gateway
        .connect_with("/ws/chat?session=bound&shell=shell-bound", &[])
        .await;
    until(&mut socket, "session_queue").await;
    let retry = format!("/api/task-shells/shell-bound/receipts/{receipt}/retry");
    let (status, accepted) = native_shell_request(&gateway, "POST", &retry, serde_json::json!({}));
    assert_eq!(status, 200, "{accepted}");
    assert_eq!(accepted["receiptId"], receipt);
    until(&mut socket, "stream_end").await;
    until(&mut socket, "session_queue").await;
    assert_eq!(
        native_shell_request(&gateway, "POST", &retry, serde_json::json!({})),
        (200, accepted)
    );
    let mut replay = gateway
        .connect_with("/ws/chat?session=bound&shell=shell-bound", &[])
        .await;
    let history = until(&mut replay, "chat_history").await;
    assert_eq!(
        history["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|row| row["content"] == "after repair")
            .count(),
        1
    );
}

#[cfg(unix)]
#[tokio::test]
async fn native_http_new_task_materializes_and_injects_verified_reference() {
    use multicc_core::{js, task_shell::reference};
    let gateway = Gateway::start_native_with_path("/usr/bin:/bin");
    let repo = gateway.dir.join("http-project");
    fs::create_dir(&repo).unwrap();
    let repo = repo.canonicalize().unwrap();
    for args in [
        vec!["init", "-b", "main"],
        vec![
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "-c",
            "commit.gpgSign=false",
            "commit",
            "--allow-empty",
            "-m",
            "fixture",
        ],
    ] {
        let output = Command::new("git")
            .current_dir(&repo)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    fs::write(
        gateway.state.join("directories.json"),
        serde_json::json!([{"id":"fixture-dir","path":repo,"baseBranch":"main"}]).to_string(),
    )
    .unwrap();
    shell_fixture_row(
        &gateway,
        "shell",
        "shell-bound",
        serde_json::json!({"id":"shell-bound","sourceSessionId":"bound","dirId":"fixture-dir","currentTaskId":"tsk_bound","defaultTaskId":"tsk_bound","standalone":false,"cursorVersion":0}),
    );
    let history = vec![
        js::from_serde(
            &serde_json::json!({"id":"ref-u","role":"user","content":"reference question","taskId":"tsk_bound","turnId":"ref-t"}),
        ),
        js::from_serde(
            &serde_json::json!({"id":"ref-a","role":"assistant","content":"verified imported context","taskId":"tsk_bound","turnId":"ref-t"}),
        ),
    ];
    fs::create_dir_all(gateway.state.join("chat_history")).unwrap();
    fs::write(
        gateway.state.join("chat_history/bound.json"),
        history
            .iter()
            .map(js::json_stringify_or_undefined)
            .collect::<Vec<_>>()
            .join("\n")
            + "\n",
    )
    .unwrap();
    let expected = reference::snapshot(&js::JsValue::from("tsk_bound"), &history, None, 12_000);
    let fixture = fs::read_to_string(gateway.dir.join("claude-fixture")).unwrap();
    fs::write(gateway.dir.join("claude-fixture"),fixture.replace("        *'\"type\":\"user\"'*)","        *'\"type\":\"user\"'*)\n            printf '%s\\n' \"$line\" >> \"$HOME/provider-input\"" )).unwrap();
    let (status, result) = native_shell_request(
        &gateway,
        "POST",
        "/api/task-shells/shell-bound/messages",
        serde_json::json!({"clientMsgId":"new-http","text":"new task","newTask":true,"contextTaskIds":["tsk_bound"]}),
    );
    assert_eq!(status, 200, "{result}");
    let id = result["sessionId"].as_str().unwrap();
    let target = repo.join(".multicc-worktrees").join(id);
    let deadline = Instant::now() + Duration::from_secs(30);
    let input = loop {
        if let Ok(text) = fs::read_to_string(gateway.state.join("provider-input")) {
            break text;
        }
        assert!(
            Instant::now() < deadline,
            "provider input did not arrive; accepted={result}; worktree_exists={}; gateway log:\n{}",
            target.is_dir(),
            fs::read_to_string(gateway.dir.join("gateway.log")).unwrap()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    assert!(target.is_dir());
    assert!(input.contains("verified imported context"), "{input}");
    assert!(input.contains(
        expected
            .get("hash")
            .and_then(|v| if let js::JsValue::String(s) = v {
                Some(s.to_string_lossy())
            } else {
                None
            })
            .unwrap()
            .as_str()
    ));
    let output = Command::new("git")
        .current_dir(&target)
        .args(["branch", "--show-current"])
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8(output.stdout).unwrap().trim(),
        format!("multicc/{id}")
    );
    let (status, trace) = native_shell_request(
        &gateway,
        "GET",
        &format!(
            "/api/sessions/{id}/context?traceId={}",
            result["receiptId"].as_str().unwrap()
        ),
        Value::Null,
    );
    assert_eq!(status, 200, "{trace}");
    assert_eq!(trace["sources"][0]["taskId"], "tsk_bound");
}

#[cfg(unix)]
#[tokio::test]
async fn native_restart_drains_durable_pending_work_without_a_connected_client() {
    use multicc_core::{orchestration_retention::RetentionPolicy, orchestration_store::Store};
    let mut gateway = Gateway::start_native();
    gateway.child.kill().unwrap();
    gateway.child.wait().unwrap();
    let file = gateway.state.join("orchestration.sqlite");
    let mut queue = Store::open(
        file.to_str().unwrap(),
        None,
        100,
        RetentionPolicy::default(),
    )
    .unwrap();
    let request = serde_json::json!({"sessionId":"bound","text":"background recovery","source":"task-shell",
        "idempotencyKey":"restart-receipt","hostAdmission":true,"initialState":{
            "pendingQuestion":null,"activeTurn":null,"category":{"classifyState":"D","recoveryRecordType":null}},
        "options":{"taskId":"tsk_bound","taskSource":"task-shell","taskStart":true,"taskShellReceiptId":"restart-receipt",
            "clientMsgId":"restart-receipt","nativeShellWork":true,"originContinue":true}});
    let result = queue
        .request(
            "scheduleAdmit",
            &serde_json::json!({"expectedRevision":0,"requestJson":request.to_string(),"now":100}),
        )
        .unwrap();
    let result: Value = serde_json::from_str(result["resultJson"].as_str().unwrap()).unwrap();
    assert_eq!(result["ok"], true, "{result}");
    drop(queue);
    assert_eq!(
        multicc_core::orchestration_store::chat_queue_snapshot(&file, "bound")
            .unwrap()
            .get("queued"),
        Some(&multicc_core::js::JsValue::Number(1.0))
    );
    shell_fixture_row(
        &gateway,
        "receipt",
        "restart-receipt",
        serde_json::json!({"id":"restart-receipt","taskId":"tsk_bound",
        "shellId":"shell-bound","status":"accepted","nativeAdmission":true,"result":{"ok":true,"sessionId":"bound","taskId":"tsk_bound","receiptId":"restart-receipt","decision":"continue"},"payload":{"intent":"work","text":"background recovery"}}),
    );
    gateway.restart_native();
    let history = gateway.state.join("chat_history/bound.json");
    let deadline = Instant::now() + Duration::from_secs(8);
    let transcript = loop {
        if let Ok(text) = fs::read_to_string(&history) {
            if text.contains("首次回复") {
                break text;
            }
        }
        assert!(
            Instant::now() < deadline,
            "{}\nqueue={:?}\nadmission={result}\nhistory={:?}",
            fs::read_to_string(gateway.dir.join("gateway.log")).unwrap(),
            multicc_core::orchestration_store::chat_queue_snapshot(&file, "bound"),
            fs::read_to_string(&history)
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    assert_eq!(transcript.matches("background recovery").count(), 2);
    // Wait for the committed queue release, then prove another restart is inert.
    loop {
        let queue = multicc_core::orchestration_store::chat_queue_snapshot(&file, "bound").unwrap();
        if queue.get("state") == Some(&multicc_core::js::JsValue::from("idle")) {
            break;
        }
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    gateway.restart_native();
    assert_eq!(fs::read_to_string(&history).unwrap(), transcript);
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
    let records = multicc_core::js::to_serde(
        &multicc_core::durable_state::load_or_recover(&gateway.state.join("sessions.json"))
            .unwrap()
            .unwrap(),
    );
    let native_id = records
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == "native")
        .unwrap()["cliSessionId"]
        .as_str()
        .unwrap();
    let history = gateway
        .state
        .join(".claude/projects/fixture")
        .join(format!("{native_id}.jsonl"));
    fs::create_dir_all(history.parent().unwrap()).unwrap();
    fs::write(&history, "{\"message\":{\"content\":[{\"type\":\"thinking\",\"thinking\":\" \"},{\"type\":\"text\",\"text\":\"kept\"}]}}\n").unwrap();
    let binary = gateway.dir.join("claude-fixture");
    let script = fs::read_to_string(&binary).unwrap();
    let guard = format!("if /usr/bin/grep -q '\"thinking\"' \"$HOME/.claude/projects/fixture/{native_id}.jsonl\"; then exit 91; fi\nread_configuration=no");
    fs::write(binary, script.replacen("read_configuration=no", &guard, 1)).unwrap();
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
    text(
        &mut socket,
        r#"{"type":"session_queue","event":"snapshot","state":"idle","queued":0,"items":[],"freezeReason":null,"active":null,"apiVersion":"v1"}"#,
    )
    .await;
    native_turn(&mut socket, "first", "首次回复").await;
    assert_eq!(
        fs::read_to_string(&history).unwrap(),
        "{\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"kept\"}]}}\n"
    );
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
    native_frame(&mut socket, "session_queue").await;
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
    native_frame(&mut socket, "session_queue").await;
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

#[cfg(unix)]
const NATIVE_CODEX: &str = r#"#!/bin/sh
[ -z "${ACCESS_TOKEN:-}" ] || exit 91
printf '%s\n' "$$" > "$HOME/codex-fixture.pid"
if [ "$1" = exec ]; then
    resume=no
    for arg in "$@"; do [ "$arg" = resume ] && resume=yes; done
    IFS= read -r prompt
    printf '%s\n' '{"type":"thread.started","thread_id":"codex-fixture-exec"}'
    if [ "$resume" = yes ]; then
        reply='标准续轮'; input=16; cache=6; output=4
    else
        reply='标准首轮'; input=8; cache=3; output=2
    fi
    printf '{"type":"item.completed","item":{"id":"reply","type":"agent_message","text":"%s"}}\n' "$reply"
    printf '{"type":"turn.completed","usage":{"input_tokens":%s,"cached_input_tokens":%s,"output_tokens":%s}}\n' "$input" "$cache" "$output"
    exit 0
fi
[ "$1 $2 $3" = 'app-server --listen stdio://' ] || exit 90
endpoint=
for arg in "$@"; do
    case "$arg" in
        model_providers.multicc_native.base_url=*)
            endpoint=$(printf '%s\n' "$arg" | /usr/bin/sed -n 's/^[^=]*="\([^"]*\)"$/\1/p') ;;
    esac
done
resume=no
while IFS= read -r line; do
    id=$(printf '%s\n' "$line" | /usr/bin/sed -n 's/.*"id":\([0-9]*\).*/\1/p')
    case "$line" in
        *'"method":"initialize"'*) printf '{"id":%s,"result":{"userAgent":"codex/0.164.0"}}\n' "$id" ;;
        *'"method":"thread/start"'*)
            printf '{"id":%s,"result":{"thread":{"id":"codex-fixture-thread"}}}\n' "$id" ;;
        *'"method":"thread/resume"'*'"threadId":"codex-fixture-thread"'*)
            resume=yes
            printf '{"id":%s,"result":{"thread":{"id":"codex-fixture-thread"}}}\n' "$id" ;;
        *'"method":"thread/resume"'*)
            printf '{"id":%s,"error":{"message":"no rollout found for thread id"}}\n' "$id" ;;
        *'"method":"turn/start"'*)
            /usr/bin/grep -q '"cliSessionId"[[:space:]]*:[[:space:]]*"codex-fixture-thread"' "$HOME/sessions.json" || exit 92
            printf '{"id":%s,"result":{"turn":{"id":"turn-fixture"}}}\n' "$id"
            printf '%s\n' '{"method":"turn/started","params":{"threadId":"codex-fixture-thread","turn":{"id":"turn-fixture"}}}'
            case "$line" in
                *'"text":"hold"'*) reply='等待取消'; complete=no ;;
                *'"text":"managed"'*)
                    [ -n "$endpoint" ] && [ -n "$MULTICC_CODEX_ROUTE_KEY" ] && [ ! -e "$CODEX_HOME/auth.json" ] || exit 93
                    response=$(/usr/bin/curl --noproxy '*' --silent --show-error --max-time 5 -H "Authorization: Bearer $MULTICC_CODEX_ROUTE_KEY" -H 'Content-Type: application/json' -d '{"model":"fixture-model","input":[],"stream":false}' "$endpoint/responses")
                    [ "$response" = '{"echo":"[REDACTED_PROVIDER_ROUTE]","text":"ok"}' ] || exit 94
                    reply='已走托管代理'; complete=yes ;;
                *'"text":"fail"'*)
                    printf '%s\n' '{"method":"turn/completed","params":{"threadId":"codex-fixture-thread","turn":{"id":"turn-fixture","status":"failed","error":{"message":"fixture Codex upstream timeout"}}}}'
                    continue ;;
                *) complete=yes; if [ "$resume" = yes ]; then reply='沿用上下文'; else reply='首次回复'; fi ;;
            esac
            printf '{"method":"item/agentMessage/delta","params":{"threadId":"codex-fixture-thread","itemId":"msg","delta":"%s"}}\n' "$reply"
            [ "$complete" = yes ] || continue
            printf '{"method":"item/completed","params":{"threadId":"codex-fixture-thread","item":{"id":"msg","type":"agentMessage","text":"%s"}}}\n' "$reply"
            printf '%s\n' '{"method":"thread/tokenUsage/updated","params":{"threadId":"codex-fixture-thread","turnId":"turn-fixture","tokenUsage":{"last":{"inputTokens":8,"cachedInputTokens":3,"outputTokens":2}}}}'
            printf '%s\n' '{"method":"turn/completed","params":{"threadId":"codex-fixture-thread","turn":{"id":"turn-fixture","status":"completed"}}}'
            ;;
    esac
done
"#;

#[cfg(unix)]
async fn native_codex_turn(
    socket: &mut Ws,
    prompt: &str,
    expected: &str,
    provider: &str,
    model: &str,
) {
    send_text(
        socket,
        &serde_json::json!({"type":"user_message","text":prompt,"clientMsgId":prompt}).to_string(),
    )
    .await;
    let ack = native_frame(socket, "session_queue").await;
    assert_eq!(ack["event"], "queued");
    assert_eq!(ack["queued"], false);
    assert_eq!(ack["clientMsgId"], prompt);
    assert_eq!(ack["message"], prompt);
    assert_eq!(ack["items"], serde_json::json!([]));
    let meta = native_frame(socket, "chat_msg_meta").await;
    assert_eq!(meta["clientMsgId"], prompt);
    assert_eq!(meta["message"]["content"], prompt);
    assert_eq!(native_frame(socket, "notify").await["state"], "running");
    let start = native_frame(socket, "stream_start").await;
    assert_eq!(meta["message"]["turnId"], start["turnId"]);
    let route = native_frame(socket, "provider_route_event").await;
    assert_eq!(route["routePhase"], "selected");
    assert_eq!(route["protocol"], "openai_responses");
    assert_eq!(route["providerId"], provider);
    assert_eq!(route["model"], model);
    assert_eq!(route["turnId"], start["turnId"]);
    let answer = native_frame(socket, "assistant").await;
    assert_eq!(answer["message"]["content"][0]["text"], expected);
    assert_eq!(answer["routeAttemptId"], route["routeAttemptId"]);
    assert_eq!(
        native_frame(socket, "chat_msg_meta").await["role"],
        "assistant"
    );
    let windows = native_frame(socket, "provider_token_stats").await;
    assert_eq!(windows["routeAttemptId"], route["routeAttemptId"]);
    assert!(windows["windows"]["today"]["turnCount"].as_u64().unwrap() > 0);
    let role = native_frame(socket, "role_token_stats").await;
    assert_eq!(role["role"]["main"]["inputTokens"], 5);
    assert_eq!(role["role"]["mainByProvider"][0]["providerId"], provider);
    assert_eq!(role["role"]["mainByProvider"][0]["model"], model);
    let result = native_frame(socket, "result").await;
    assert_eq!(result["routeAttemptId"], route["routeAttemptId"]);
    assert_eq!(result["usage"]["total_tokens"], 10);
    assert_eq!(result.get("total_cost_usd"), Some(&Value::Null));
    assert_eq!(result["modelAttribution"]["providerId"], provider);
    assert!(result["durationMs"].is_number());
    assert!(result["timeline"]["spans"]
        .as_array()
        .unwrap()
        .iter()
        .any(|span| span["k"] == "output"));
    assert_eq!(
        native_frame(socket, "provider_route_event").await["routePhase"],
        "succeeded"
    );
    assert_eq!(native_frame(socket, "notify").await["state"], "succeeded");
    native_frame(socket, "stream_end").await;
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn native_codex_chat_persists_the_thread_reconnects_and_cancels_without_node() {
    use std::os::unix::fs::PermissionsExt;
    let mut gateway = Gateway::start_native();
    let binary = gateway.dir.join("codex-fixture");
    fs::write(&binary, NATIVE_CODEX).unwrap();
    fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
    let record = |id: &str| {
        serde_json::json!({"id":id,"kind":"chat","type":"gateway",
        "cwd":gateway.dir.join("work"),"cli":"codex-exp"})
    };
    add_native_record(&gateway, record("codex-native"));
    let mut managed = record("codex-managed");
    managed["provider"] = Value::from("fixture-provider");
    add_native_record(&gateway, managed);
    let mut missing = record("codex-missing");
    missing["cliSessionId"] = Value::from("missing-fixture-thread");
    add_native_record(&gateway, missing);

    let path = "/ws/chat?session=codex-native";
    let mut socket = gateway.connect_with(path, &[]).await;
    let init = native_frame(&mut socket, "system").await;
    assert_eq!(init["cli"], "codex-exp");
    assert_eq!(init["cliAvailability"]["codex-exp"]["available"], true);
    assert_eq!(init["providerId"], Value::Null);
    assert_eq!(init["providerName"], Value::Null);
    assert_eq!(init["effectiveEffort"], "xhigh");
    for frame in ["background_tasks", "unattended_state", "session_queue"] {
        native_frame(&mut socket, frame).await;
    }
    native_codex_turn(
        &mut socket,
        "first",
        "首次回复",
        "codex-official",
        "_default_",
    )
    .await;
    drop(socket);
    gateway.restart_native();
    let mut socket = gateway.connect_with(path, &[]).await;
    assert_eq!(
        native_frame(&mut socket, "system").await["is_streaming"],
        false
    );
    let page = native_frame(&mut socket, "chat_history").await;
    assert_eq!(page["messages"][1]["content"], "首次回复");
    assert_eq!(page["messages"][1]["usage"]["input_tokens"], 5);
    assert_eq!(page["messages"][1]["usage"]["cache_read_input_tokens"], 3);
    assert!(page["messages"][1]["durationMs"].is_number());
    assert!(page["messages"][1]["timeline"]["spans"].is_array());
    assert_eq!(page["tokenUsage"]["consumedInputTokens"], 8);
    for frame in ["background_tasks", "unattended_state", "session_queue"] {
        native_frame(&mut socket, frame).await;
    }
    native_codex_turn(
        &mut socket,
        "second",
        "沿用上下文",
        "codex-official",
        "_default_",
    )
    .await;

    send_text(&mut socket, r#"{"type":"user_message","text":"hold"}"#).await;
    native_frame(&mut socket, "chat_msg_meta").await;
    assert_eq!(
        native_frame(&mut socket, "notify").await["state"],
        "running"
    );
    native_frame(&mut socket, "stream_start").await;
    let selected = native_frame(&mut socket, "provider_route_event").await;
    assert_eq!(selected["protocol"], "openai_responses");
    let active = native_frame(&mut socket, "assistant").await;
    assert_eq!(active["message"]["content"][0]["text"], "等待取消");
    let child_pid: i32 = fs::read_to_string(gateway.state.join("codex-fixture.pid"))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    gateway.assert_native_process_tree();
    drop(socket);

    let mut socket = gateway.connect_with(path, &[]).await;
    assert_eq!(
        native_frame(&mut socket, "system").await["is_streaming"],
        true
    );
    let history = native_frame(&mut socket, "chat_history").await;
    let messages = history["messages"].as_array().unwrap();
    assert_eq!(messages.last().unwrap()["content"], "等待取消");
    for frame in ["background_tasks", "unattended_state", "session_queue"] {
        native_frame(&mut socket, frame).await;
    }
    send_text(
        &mut socket,
        r#"{"type":"cancel","operationId":"cancel-codex"}"#,
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
    assert_eq!(
        native_frame(&mut socket, "notify").await["state"],
        "cancelled"
    );
    native_frame(&mut socket, "stream_end").await;
    assert_eq!(unsafe { libc::kill(child_pid, 0) }, -1);
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ESRCH)
    );

    send_text(&mut socket, r#"{"type":"user_message","text":"fail"}"#).await;
    native_frame(&mut socket, "chat_msg_meta").await;
    assert_eq!(
        native_frame(&mut socket, "notify").await["state"],
        "running"
    );
    native_frame(&mut socket, "stream_start").await;
    native_frame(&mut socket, "provider_route_event").await;
    let error = native_frame(&mut socket, "error").await;
    assert_eq!(error["code"], "chat_provider_error");
    assert_eq!(error["error"], "fixture Codex upstream timeout");
    assert_eq!(
        native_frame(&mut socket, "provider_route_event").await["routePhase"],
        "failed"
    );
    native_frame(&mut socket, "stream_end").await;

    let mut managed = gateway
        .connect_with("/ws/chat?session=codex-managed", &[])
        .await;
    for frame in [
        "system",
        "background_tasks",
        "unattended_state",
        "session_queue",
    ] {
        native_frame(&mut managed, frame).await;
    }
    send_text(
        &mut managed,
        r#"{"type":"user_message","text":"do not start"}"#,
    )
    .await;
    assert_eq!(
        native_frame(&mut managed, "error").await["code"],
        "chat_provider_unavailable"
    );

    let mut missing = gateway
        .connect_with("/ws/chat?session=codex-missing", &[])
        .await;
    for frame in [
        "system",
        "background_tasks",
        "unattended_state",
        "session_queue",
    ] {
        native_frame(&mut missing, frame).await;
    }
    send_text(
        &mut missing,
        r#"{"type":"user_message","text":"resume existing thread"}"#,
    )
    .await;
    for frame in [
        "chat_msg_meta",
        "notify",
        "stream_start",
        "provider_route_event",
    ] {
        native_frame(&mut missing, frame).await;
    }
    let error = native_frame(&mut missing, "error").await;
    assert!(error["error"]
        .as_str()
        .unwrap()
        .contains("no rollout found for thread id"));
    assert_eq!(
        native_frame(&mut missing, "provider_route_event").await["routePhase"],
        "failed"
    );
    native_frame(&mut missing, "stream_end").await;
    let records =
        multicc_core::durable_state::load_or_recover(&gateway.state.join("sessions.json"))
            .unwrap()
            .unwrap();
    let records = multicc_core::js::to_serde(&records);
    let stored = records
        .as_array()
        .unwrap()
        .iter()
        .find(|record| record["id"] == "codex-missing")
        .unwrap();
    assert_eq!(stored["cliSessionId"], "missing-fixture-thread");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn native_codex_exec_and_fixed_provider_run_through_real_websocket() {
    use axum::{http::HeaderMap, routing::post, Router};
    use std::os::unix::fs::PermissionsExt;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    const KEY: &str = "fixture-unshared-provider-credential";
    let requests = Arc::new(AtomicUsize::new(0));
    let upstream_count = requests.clone();
    let upstream = Router::new().route(
        "/v1/responses",
        post(
            move |headers: HeaderMap, axum::Json(body): axum::Json<Value>| {
                let requests = upstream_count.clone();
                async move {
                    assert_eq!(headers["authorization"], format!("Bearer {KEY}"));
                    assert_eq!(body["model"], "fixture-model");
                    requests.fetch_add(1, Ordering::Relaxed);
                    (
                        [("content-type", "application/json")],
                        format!("{{\"echo\":\"{KEY}\",\"text\":\"ok\"}}"),
                    )
                }
            },
        ),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = listener.local_addr().unwrap();
    let upstream = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
    let gateway = Gateway::start_native();
    let binary = gateway.dir.join("codex-fixture");
    fs::write(&binary, NATIVE_CODEX).unwrap();
    fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
    let row = |id: &str, cli: &str, provider: Value| {
        serde_json::json!({
            "id":id,"kind":"chat","type":"gateway","cwd":gateway.dir.join("work"),"cli":cli,"provider":provider
        })
    };
    add_native_record(&gateway, row("codex-exec", "codex", Value::Null));
    add_native_record(&gateway, row("codex-legacy", "codex", Value::Null));
    add_native_record(
        &gateway,
        row("codex-fixed", "codex-exp", Value::from("provider-fixture")),
    );
    fs::write(gateway.state.join("providers.json"), serde_json::json!([{
        "id":"provider-fixture","appType":"codex","name":"托管线路","settingsConfig":{
            "auth":{"OPENAI_API_KEY":KEY},
            "config":format!("model = \"fixture-model\"\nmodel_provider = \"custom\"\n[model_providers.custom]\nbase_url = \"http://{endpoint}/v1\"\nwire_api = \"responses\"\n")
        }
    }]).to_string()).unwrap();

    let mut socket = gateway
        .connect_with("/ws/chat?session=codex-exec", &[])
        .await;
    let init = native_frame(&mut socket, "system").await;
    assert_eq!(init["cli"], "codex");
    assert_eq!(init["providerId"], "codex-official");
    let empty = native_frame(&mut socket, "chat_history").await;
    assert_eq!(empty["tokenUsage"]["turnCount"], 0);
    for frame in ["background_tasks", "unattended_state", "session_queue"] {
        native_frame(&mut socket, frame).await;
    }
    native_codex_turn(
        &mut socket,
        "first",
        "标准首轮",
        "codex-official",
        "_default_",
    )
    .await;
    native_codex_turn(
        &mut socket,
        "second",
        "标准续轮",
        "codex-official",
        "_default_",
    )
    .await;
    let mut reopened = gateway
        .connect_with("/ws/chat?session=codex-exec", &[])
        .await;
    let init = native_frame(&mut reopened, "system").await;
    assert_eq!(init["providerTokenWindows"]["all"]["turnCount"], 2);
    let history = native_frame(&mut reopened, "chat_history").await;
    assert_eq!(history["tokenUsage"]["turnCount"], 2);
    assert_eq!(history["tokenUsage"]["inputTokens"], 16);
    assert_eq!(history["messages"][3]["usage"]["total_tokens"], 10);
    assert!(history["messages"][3].get("usageCumulative").is_none());
    let saved = multicc_core::chat_history_file::read_transcript(
        &gateway.state.join("chat_history/codex-exec.json"),
    )
    .unwrap();
    assert_eq!(
        multicc_core::js::to_serde(&saved[3])["usageCumulative"]["total_tokens"],
        20
    );

    fs::write(
        gateway.state.join("chat_history/codex-legacy.json"),
        serde_json::json!([
            {"role":"assistant","content":"旧首轮","usage":{"input_tokens":8,"cached_input_tokens":3,"output_tokens":2}},
            {"role":"assistant","content":"旧续轮","usage":{"input_tokens":16,"cached_input_tokens":6,"output_tokens":4}},
        ]).to_string(),
    ).unwrap();
    let mut legacy = gateway
        .connect_with("/ws/chat?session=codex-legacy", &[])
        .await;
    native_frame(&mut legacy, "system").await;
    let history = native_frame(&mut legacy, "chat_history").await;
    assert_eq!(history["tokenUsage"]["inputTokens"], 16);
    assert_eq!(history["messages"][1]["usage"]["total_tokens"], 10);

    let mut routed = gateway
        .connect_with("/ws/chat?session=codex-fixed", &[])
        .await;
    let init = native_frame(&mut routed, "system").await;
    assert_eq!(init["providerName"], "托管线路");
    assert_eq!(init["effectiveModel"], "fixture-model");
    until(&mut routed, "session_queue").await;
    native_codex_turn(
        &mut routed,
        "managed",
        "已走托管代理",
        "provider-fixture",
        "fixture-model",
    )
    .await;
    assert_eq!(requests.load(Ordering::Relaxed), 1);
    let history = fs::read_to_string(gateway.state.join("chat_history/codex-fixed.json")).unwrap();
    assert!(history.contains("已走托管代理"));
    assert!(!history.contains(KEY));
    upstream.abort();
}

#[cfg(unix)]
async fn until(socket: &mut Ws, expected: &str) -> Value {
    for _ in 0..64 {
        let Message::Text(frame) = next_data(socket).await else {
            panic!("expected {expected}");
        };
        let value: Value = serde_json::from_str(&frame).unwrap();
        if value["type"] == expected {
            return value;
        }
        assert_ne!(value["type"], "error", "{value}");
    }
    panic!("expected {expected}");
}

#[cfg(unix)]
#[tokio::test]
async fn native_question_replays_after_restart_and_answer_is_idempotent() {
    let mut gateway = Gateway::start_native();
    let path = "/ws/chat?session=native";
    let mut socket = gateway.connect_with(path, &[]).await;
    until(&mut socket, "session_queue").await;
    send_text(
        &mut socket,
        r#"{"type":"user_message","text":"ask","clientMsgId":"ask-1"}"#,
    )
    .await;
    let turn = until(&mut socket, "stream_start").await;
    let question = until(&mut socket, "user_input_required").await;
    assert_eq!(question["turnId"], turn["turnId"]);
    assert_eq!(question["question"], "Which workspace?");
    assert_eq!(question["options"], serde_json::json!(["local", "remote"]));
    until(&mut socket, "stream_end").await;
    drop(socket);

    gateway.restart_native();
    let mut socket = gateway.connect_with(path, &[]).await;
    assert_eq!(until(&mut socket, "user_input_required").await, question);
    until(&mut socket, "session_queue").await;

    send_text(
        &mut socket,
        r#"{"type":"user_message","text":"wrong","userInputRequestId":"obsolete"}"#,
    )
    .await;
    assert_eq!(
        native_frame(&mut socket, "error").await["code"],
        "stale_control"
    );
    let answer = serde_json::json!({"type":"user_message","text":"local","clientMsgId":"answer-1",
        "userInputRequestId":question["requestId"]})
    .to_string();
    send_text(&mut socket, &answer).await;
    let resolved = until(&mut socket, "user_input_resolved").await;
    assert_eq!(resolved["requestId"], question["requestId"]);
    until(&mut socket, "stream_end").await;
    send_text(&mut socket, &answer).await;
    assert_eq!(
        native_frame(&mut socket, "chat_msg_meta").await["clientMsgId"],
        "answer-1"
    );
    send_text(&mut socket, r#"{"type":"ping"}"#).await;
    native_frame(&mut socket, "pong").await;

    let mut replay = gateway.connect_with(path, &[]).await;
    let history = until(&mut replay, "chat_history").await;
    let rows = history["messages"].as_array().unwrap();
    assert_eq!(
        rows.iter().filter(|row| row["content"] == "local").count(),
        1
    );
    assert!(!rows.iter().any(|row| row["content"] == "wrong"));
    let settled = until(&mut replay, "user_input_resolved").await;
    assert_eq!(settled["requestId"], question["requestId"]);
    assert_eq!(settled["replay"], true);
}

#[cfg(unix)]
#[tokio::test]
async fn native_question_dismisses_through_http_and_replays_settlement() {
    let gateway = Gateway::start_native();
    let path = "/ws/chat?session=native";
    let mut socket = gateway.connect_with(path, &[]).await;
    until(&mut socket, "session_queue").await;
    send_text(
        &mut socket,
        r#"{"type":"user_message","text":"ask","clientMsgId":"ask-dismiss"}"#,
    )
    .await;
    let question = until(&mut socket, "user_input_required").await;
    until(&mut socket, "stream_end").await;

    let post = |session: &str| {
        let body = serde_json::json!({"requestId":question["requestId"]}).to_string();
        gateway.raw(&format!(
            "POST /api/sessions/{session}/user-input/dismiss HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer gateway-chat-fixture-token\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        ))
    };
    let hidden = post("internal");
    assert!(hidden.starts_with("HTTP/1.1 404"), "{hidden}");
    let response = post("native");
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    assert!(
        response.contains(r#""resolution":"dismissed""#),
        "{response}"
    );
    let event = until(&mut socket, "user_input_resolved").await;
    assert_eq!(event["requestId"], question["requestId"]);
    assert_eq!(event["resolution"], "dismissed");
    let response = post("native");
    assert!(response.contains(r#""duplicate":true"#), "{response}");

    let mut replay = gateway.connect_with(path, &[]).await;
    let event = until(&mut replay, "user_input_resolved").await;
    assert_eq!(event["requestId"], question["requestId"]);
    assert_eq!(event["replay"], true);
}

#[cfg(unix)]
#[tokio::test]
async fn native_replay_imports_the_legacy_question_before_accepting_input() {
    let gateway = Gateway::start_native();
    let pending = serde_json::json!({
        "requestId":"old-question","turnId":"old-turn","question":"Reuse the old workspace?",
        "resolved":false,"options":["yes","no"]
    });
    fs::write(
        gateway.state.join("orchestration.json"),
        serde_json::json!({
            "schemaVersion":4,"revision":1,"updatedAt":1,"nextOutboxSequence":1,
            "sessionWorkStateV1":{"native":{"version":7,
                "pendingQuestionJson":pending.to_string(),"activeTurnJson":"null",
                "categoryJson":r#"{"classifyState":"W","userInputSignalTurnId":"old-turn"}"#}},
            "waits":{},"outbox":{},"operations":{},"tasks":{},"sessionSchedules":{}
        })
        .to_string(),
    )
    .unwrap();
    let mut socket = gateway.connect_with("/ws/chat?session=native", &[]).await;
    let replay = until(&mut socket, "user_input_required").await;
    assert_eq!(replay["requestId"], pending["requestId"]);
    assert_eq!(replay["question"], pending["question"]);
    until(&mut socket, "session_queue").await;
    send_text(&mut socket, r#"{"type":"user_message","text":"yes","userInputRequestId":"old-question","clientMsgId":"old-answer"}"#).await;
    let settled = until(&mut socket, "user_input_resolved").await;
    assert_eq!(settled["requestId"], "old-question");
    until(&mut socket, "stream_end").await;
}

#[cfg(unix)]
#[tokio::test]
async fn native_task_shell_answer_uses_the_durable_receipt() {
    let mut gateway = Gateway::start_native();
    let path = "/ws/chat?session=bound&shell=shell-bound";
    let mut socket = gateway.connect_with(path, &[]).await;
    until(&mut socket, "session_queue").await;
    send_text(
        &mut socket,
        r#"{"type":"user_message","text":"ask","clientMsgId":"ask-1","taskShell":true}"#,
    )
    .await;
    until(&mut socket, "task_shell_routed").await;
    let question = until(&mut socket, "user_input_required").await;
    assert_eq!(question["taskId"], "tsk_bound");
    until(&mut socket, "stream_end").await;
    until(&mut socket, "session_queue").await;

    drop(socket);
    gateway.restart_native();
    let mut socket = gateway.connect_with(path, &[]).await;
    assert_eq!(until(&mut socket, "user_input_required").await, question);
    until(&mut socket, "session_queue").await;

    let answer = serde_json::json!({"type":"user_message","text":"local","clientMsgId":"shell-answer",
        "taskShell":true,"taskId":"tsk_bound","turnId":question["turnId"],
        "userInputRequestId":question["requestId"]});
    let mut obsolete = answer.clone();
    obsolete["turnId"] = serde_json::json!("obsolete");
    send_text(&mut socket, &obsolete.to_string()).await;
    assert_eq!(
        native_frame(&mut socket, "error").await["code"],
        "stale_control"
    );
    send_text(&mut socket, &answer.to_string()).await;
    let settled = until(&mut socket, "user_input_resolved").await;
    assert_eq!(settled["requestId"], question["requestId"]);
    let receipt = until(&mut socket, "task_shell_routed").await;
    assert_eq!(receipt["decision"], "answer");
    until(&mut socket, "stream_end").await;
    until(&mut socket, "session_queue").await;
    send_text(&mut socket, &answer.to_string()).await;
    assert_eq!(until(&mut socket, "task_shell_routed").await, receipt);
}

#[cfg(unix)]
#[tokio::test]
async fn native_task_shell_claims_new_work_and_releases_writer_before_the_next_turn() {
    let gateway = Gateway::start_native();
    let path = "/ws/chat?session=bound&shell=shell-bound";
    let mut socket = gateway.connect_with(path, &[]).await;
    until(&mut socket, "session_queue").await;

    let hold = r#"{"type":"user_message","taskShell":true,"clientMsgId":"bound-1","text":"hold"}"#;
    send_text(&mut socket, hold).await;
    let routed = until(&mut socket, "task_shell_routed").await;
    assert_eq!(routed["decision"], "continue");
    assert_eq!(routed["taskId"], "tsk_bound");
    let turn = until(&mut socket, "stream_start").await["turnId"].clone();
    until(&mut socket, "stream_event").await;
    gateway.assert_native_process_tree();

    send_text(
        &mut socket,
        r#"{"type":"user_message","taskShell":true,"clientMsgId":"bound-2","text":"second"}"#,
    )
    .await;
    assert_eq!(
        until(&mut socket, "task_shell_routed").await["decision"],
        "queued"
    );
    drop(socket);
    let mut socket = gateway.connect_with(path, &[]).await;
    assert_eq!(until(&mut socket, "system").await["turnId"], turn);
    until(&mut socket, "session_queue").await;

    let cancel = serde_json::json!({"type":"cancel","taskShell":true,"clientMsgId":"bound-cancel","turnId":turn}).to_string();
    send_text(&mut socket, &cancel).await;
    assert_eq!(
        until(&mut socket, "task_shell_routed").await["decision"],
        "cancel"
    );
    let resumed = until(&mut socket, "stream_start").await;
    assert_ne!(resumed["turnId"], turn);
    until(&mut socket, "result").await;
    until(&mut socket, "stream_end").await;
    until(&mut socket, "session_queue").await;

    send_text(&mut socket, hold).await;
    assert_eq!(until(&mut socket, "task_shell_routed").await, routed);
    // An idempotent replay must never launch a second copy of the old prompt.
    send_text(&mut socket, r#"{"type":"ping"}"#).await;
    assert_eq!(native_frame(&mut socket, "pong").await["type"], "pong");
    drop(socket);
    let mut socket = gateway.connect_with(path, &[]).await;
    let history = until(&mut socket, "chat_history").await;
    let messages = history["messages"].as_array().unwrap();
    assert_eq!(
        messages.iter().filter(|row| row["role"] == "user").count(),
        2
    );
    assert!(messages.iter().any(|row| row["cancelled"] == true));
    assert!(messages.iter().any(|row| row["content"] == "首次回复"));
    for row in messages {
        assert_eq!(row["taskId"], "tsk_bound");
        assert!(row["deliveryId"].is_string());
    }
    let mut tasks = multicc_core::task_store::TaskStore::open(
        gateway.state.join("task-shells.sqlite").to_str().unwrap(),
    )
    .unwrap();
    tasks
        .writer_lease_assert_empty(&serde_json::json!({"workspaceId":"ws_bound"}))
        .unwrap();
    let lease = tasks
        .run(r#"{"op":"get","kind":"workspace:lease","id":"ws_bound"}"#)
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&lease).unwrap()["state"],
        "released"
    );
    for (id, expected) in [(&turn, "cancelled"), (&resumed["turnId"], "succeeded")] {
        let request = serde_json::json!({"op":"get","kind":"task-first:run-result","id":id});
        let result: Value =
            serde_json::from_str(&tasks.run(&request.to_string()).unwrap()).unwrap();
        assert_eq!(result["taskId"], "tsk_bound");
        assert_eq!(result["outcome"], expected);
        assert_eq!(result["evidencePersisted"], true);
    }
}

#[cfg(unix)]
#[tokio::test]
async fn native_task_shell_routes_configured_provider_without_child_credentials() {
    use axum::{body::Body, http::HeaderMap, routing::post, Router};
    const KEY: &str = "fixture-unshared-api-key";
    let app = Router::new().route(
        "/fixture/v1/messages",
        post(|headers: HeaderMap, body: String| async move {
            assert_eq!(headers["x-api-key"], KEY);
            assert!(!headers.contains_key("authorization"));
            assert_eq!(
                serde_json::from_str::<Value>(&body).unwrap()["model"],
                "fixture-model"
            );
            let chunks = [
                &b"{\"echo\":\"fixture-unshared-"[..],
                &b"api-key\",\"text\":\"\xe4"[..],
                &b"\xb8\xad\xe6\x96\x87\"}"[..],
            ];
            let frames = futures_util::stream::iter(chunks.map(|bytes| {
                Ok::<_, std::convert::Infallible>(axum::body::Bytes::from_static(bytes))
            }));
            (
                [("content-type", "application/json")],
                Body::from_stream(frames),
            )
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = listener.local_addr().unwrap();
    let upstream = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let gateway = Gateway::start_native();
    mutate_native_records(&gateway, |sessions| {
        let bound = sessions
            .iter_mut()
            .find(|row| row["id"] == "bound")
            .unwrap();
        bound["provider"] = Value::from("provider-fixture");
    });
    fs::write(
        gateway.state.join("providers.json"),
        serde_json::json!([{
            "id":"provider-fixture","name":"隔离线路","appType":"claude","settingsConfig":{"env":{
                "ANTHROPIC_BASE_URL":format!("http://{endpoint}/fixture"),"ANTHROPIC_API_KEY":KEY,
                "ANTHROPIC_DEFAULT_SONNET_MODEL":"fixture-model"
            }}
        }])
        .to_string(),
    )
    .unwrap();
    let mut socket = gateway
        .connect_with("/ws/chat?session=bound&shell=shell-bound", &[])
        .await;
    until(&mut socket, "session_queue").await;
    send_text(&mut socket, r#"{"type":"user_message","taskShell":true,"clientMsgId":"provider-1","text":"provider-test"}"#).await;
    native_frame(&mut socket, "task_shell_routed").await;
    native_frame(&mut socket, "chat_msg_meta").await;
    let running = native_frame(&mut socket, "notify").await;
    assert_eq!(running["state"], "running");
    assert_eq!(running["taskId"], "tsk_bound");
    let start = native_frame(&mut socket, "stream_start").await;
    let selected = native_frame(&mut socket, "provider_route_event").await;
    assert_eq!(selected["providerId"], "provider-fixture");
    assert_eq!(selected["providerName"], "隔离线路");
    assert_eq!(selected["model"], "fixture-model");
    assert_eq!(selected["turnId"], start["turnId"]);
    let result = until(&mut socket, "result").await;
    assert_eq!(result["providerId"], "provider-fixture");
    until(&mut socket, "stream_end").await;
    until(&mut socket, "session_queue").await;
    let history = fs::read_to_string(gateway.state.join("chat_history/bound.json")).unwrap();
    assert!(history.contains("自定义线路"));
    assert!(!history.contains(KEY));
    upstream.abort();
    assert!(upstream.await.unwrap_err().is_cancelled());
}

#[cfg(unix)]
#[tokio::test]
async fn native_planned_task_materializes_before_using_the_selected_provider() {
    use axum::{http::HeaderMap, routing::post, Router};
    use std::sync::atomic::{AtomicUsize, Ordering};

    const KEY: &str = "fixture-unshared-api-key";
    let calls = std::sync::Arc::new(AtomicUsize::new(0));
    let entered = std::sync::Arc::new(tokio::sync::Notify::new());
    let respond = std::sync::Arc::new(tokio::sync::Notify::new());
    let handler_calls = calls.clone();
    let handler_entered = entered.clone();
    let handler_respond = respond.clone();
    let upstream_app = Router::new().route(
        "/fixture/v1/messages",
        post(move |headers: HeaderMap, body: String| {
            let handler_calls = handler_calls.clone();
            let entered = handler_entered.clone();
            let respond = handler_respond.clone();
            async move {
                assert_eq!(headers["x-api-key"], KEY);
                assert_eq!(
                    serde_json::from_str::<Value>(&body).unwrap()["model"],
                    "selected-model"
                );
                handler_calls.fetch_add(1, Ordering::Relaxed);
                entered.notify_one();
                respond.notified().await;
                r#"{"echo":"fixture-unshared-api-key","text":"中文"}"#
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = listener.local_addr().unwrap();
    let upstream = tokio::spawn(async move { axum::serve(listener, upstream_app).await.unwrap() });
    let gateway = Gateway::start_native_with_path("/usr/bin:/bin");
    let repo = gateway.dir.join("project");
    fs::create_dir(&repo).unwrap();
    let repo = repo.canonicalize().unwrap();
    let git = |cwd: &Path, args: &[&str]| {
        let output = Command::new("git")
            .current_dir(cwd)
            .args(args)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    };
    git(&repo, &["init", "-b", "main"]);
    git(
        &repo,
        &[
            "-c",
            "user.name=Rust Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "-c",
            "commit.gpgSign=false",
            "commit",
            "--allow-empty",
            "-m",
            "fixture",
        ],
    );
    let expected_head = git(&repo, &["rev-parse", "HEAD"]);
    let worktree = repo.join(".multicc-worktrees/bound");
    let ledger = gateway.state.join("task-shells.sqlite");
    let mut tasks = multicc_core::task_store::TaskStore::open(ledger.to_str().unwrap()).unwrap();
    tasks
        .run(r#"{"op":"remove","kind":"workspace:binding","id":"bound"}"#)
        .unwrap();
    tasks
        .run(r#"{"op":"remove","kind":"workspace:record","id":"ws_bound"}"#)
        .unwrap();
    drop(tasks);
    mutate_native_records(&gateway, |sessions| {
        let bound = sessions
            .iter_mut()
            .find(|row| row["id"] == "bound")
            .unwrap();
        bound["workspaceState"] = Value::from("planned");
        bound["worktreePath"] = serde_json::json!(worktree);
        bound["provider"] = Value::from("unselected");
        bound["providerSelection"] = serde_json::json!({"version":1,"mode":"auto","protocol":"anthropic",
            "sticky":true,"candidates":[{"providerId":"unselected","priority":20},{"providerId":"selected","priority":10}]});
    });
    fs::write(
        gateway.state.join("directories.json"),
        serde_json::json!([
        {"id":"fixture-dir","path":repo,"baseBranch":"main"}])
        .to_string(),
    )
    .unwrap();
    fs::write(gateway.state.join("providers.json"), serde_json::json!([
        {"id":"selected","name":"Chosen","appType":"claude","settingsConfig":{"env":{
            "ANTHROPIC_BASE_URL":format!("http://{endpoint}/fixture"),"ANTHROPIC_API_KEY":KEY,
            "ANTHROPIC_DEFAULT_SONNET_MODEL":"selected-model"
        }}},
        {"id":"unselected","name":"Manual fallback","appType":"claude","settingsConfig":{"env":{
            "ANTHROPIC_BASE_URL":format!("http://{endpoint}/wrong"),"ANTHROPIC_API_KEY":"wrong-key",
            "ANTHROPIC_DEFAULT_SONNET_MODEL":"unselected-model"
        }}}
    ]).to_string()).unwrap();
    let path = "/ws/chat?session=bound&shell=shell-bound";
    let mut socket = gateway.connect_with(path, &[]).await;
    let init = native_frame(&mut socket, "system").await;
    assert_eq!(init["providerSelection"]["mode"], "auto");
    until(&mut socket, "session_queue").await;
    assert!(!worktree.exists());
    send_text(&mut socket, r#"{"type":"user_message","taskShell":true,"clientMsgId":"planned-1","text":"provider-test"}"#).await;
    until(&mut socket, "task_shell_routed").await;
    let start = until(&mut socket, "stream_start").await;
    assert_eq!(start["taskId"], "tsk_bound");
    assert_eq!(git(&worktree, &["rev-parse", "HEAD"]), expected_head);
    assert_eq!(
        git(&worktree, &["branch", "--show-current"]),
        "multicc/bound"
    );
    assert!(git(&repo, &["status", "--porcelain", "--untracked-files=all"]).is_empty());
    let route = until(&mut socket, "provider_route_event").await;
    assert_eq!(route["providerId"], "selected");
    assert_eq!(route["model"], "selected-model");
    tokio::time::timeout(Duration::from_secs(5), entered.notified())
        .await
        .unwrap();
    gateway.assert_native_process_tree();
    respond.notify_one();
    assert_eq!(until(&mut socket, "result").await["providerId"], "selected");
    until(&mut socket, "stream_end").await;
    until(&mut socket, "session_queue").await;
    assert_eq!(calls.load(Ordering::Relaxed), 1);
    let mut socket = gateway.connect_with(path, &[]).await;
    assert_eq!(
        until(&mut socket, "system").await["cwd"],
        serde_json::json!(worktree)
    );
    let page = until(&mut socket, "chat_history").await;
    assert!(page.to_string().contains("自定义线路"));
    assert!(!page.to_string().contains(KEY));
    upstream.abort();
    assert!(upstream.await.unwrap_err().is_cancelled());
}

#[cfg(unix)]
#[tokio::test]
async fn native_reconnect_keeps_distinct_ids_for_legacy_messages() {
    async fn replay_legacy_page() -> Value {
        let gateway = Gateway::start_native();
        let transcript = gateway.state.join("chat_history");
        fs::create_dir(&transcript).unwrap();
        fs::write(
            transcript.join("native.json"),
            r#"[{"role":"user","content":"same","ts":12},{"role":"user","content":"same","ts":12}]"#,
        )
        .unwrap();
        let mut socket = gateway.connect_with("/ws/chat?session=native", &[]).await;
        native_frame(&mut socket, "system").await;
        native_frame(&mut socket, "chat_history").await
    }
    let first = replay_legacy_page().await;
    let messages = first["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 2);
    assert!(messages[0]["id"].as_str().is_some());
    assert_ne!(messages[0]["id"], messages[1]["id"]);

    assert_eq!(replay_legacy_page().await, first);
}
