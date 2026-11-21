//! End-to-end wiring tests for the remote-screen front door.
//!
//! Each test runs the real `multicc-gateway` binary, so the request travels the
//! production dispatch: `forward::dispatch` claims `/ws/remote-screen`,
//! `app::claim`/`app::handle` claim and answer `/api/remote-screen`, and
//! `event_routes` recognises the remote screen's own annotation screenshots.
//! The child behind all three surfaces is the fake `multicc-remote`
//! (`examples/remote_child_fixture.rs`); a `--node` test also runs the Node
//! fixture (`tests/fixtures/upstream.js`) so it can prove a request did *not*
//! reach Node.
//!
//! What they pin:
//! * `GET /api/remote-screen/...` reaches the Rust forwarder (fixture echo, not
//!   503, not forwarded to Node);
//! * `/ws/remote-screen` refuses a ticketless public peer with 4003 and bridges
//!   a ticketed one;
//! * `POST /api/annotation-live` answers an own-shot without calling the Node
//!   host, and still calls it for a non-own-shot path;
//! * a stop signal drains the `multicc-remote` child (its stdin lifeline sees
//!   EOF and it exits) instead of leaking an orphan;
//! * the HTTP forwarder and the WS bridge share one child (one spawn).

mod common;

use common::fixture;
use serde_json::Value;
use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
#[cfg(unix)]
use std::process::ExitStatus;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream as TokioTcp;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, http::HeaderValue, Message},
    MaybeTlsStream, WebSocketStream,
};

const GATEWAY_BIN: &str = env!("CARGO_BIN_EXE_multicc-gateway");
const UPSTREAM: &str = include_str!("fixtures/upstream.js");
const TOKEN: &str = "wiring-token";

type Ws = WebSocketStream<MaybeTlsStream<TokioTcp>>;

fn node_binary() -> String {
    std::env::var("MULTICC_TEST_NODE").unwrap_or_else(|_| "node".to_string())
}

fn unique(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "multicc-gateway-wiring-{}-{tag}-{nanos}",
        std::process::id()
    ))
}

fn free_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.local_addr().unwrap().port()
}

struct Gateway {
    dir: PathBuf,
    state: PathBuf,
    home: PathBuf,
    port: u16,
    child: Child,
}

impl Gateway {
    /// `--node` against the Node fixture; `MULTICC_REMOTE_BIN` points at the
    /// fake `multicc-remote` so the front door spawns it on demand.
    fn start_node(tag: &str, extra: &[(&str, String)]) -> Self {
        for _ in 0..5 {
            match Self::try_spawn(tag, true, extra) {
                Some(gateway) => return gateway,
                None => continue,
            }
        }
        panic!("could not find a free public port after 5 attempts");
    }

    /// `--no-node`: no Node child exists, but the front door still owns its
    /// `multicc-remote` child and a local auth runtime (from `ACCESS_TOKEN`), so
    /// tickets and the gated routes work without Node.
    fn start_no_node(tag: &str, extra: &[(&str, String)]) -> Self {
        Self::try_spawn(tag, false, extra).expect("--no-node spawn")
    }

    fn try_spawn(tag: &str, with_node: bool, extra: &[(&str, String)]) -> Option<Self> {
        let dir = unique(tag);
        let state = dir.join("state");
        let home = dir.join("home");
        let empty = dir.join("empty-path");
        fs::create_dir_all(&state).unwrap();
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&empty).unwrap();
        fs::write(dir.join("server.js"), if with_node { UPSTREAM } else { "" }).unwrap();
        let remote_bin = fixture();
        let log = fs::File::create(dir.join("gateway.log")).unwrap();
        let port = if with_node { free_port() } else { 0 };

        let mut command = Command::new(GATEWAY_BIN);
        command
            .arg("serve")
            .arg("--cwd")
            .arg(&dir)
            .env_clear()
            .env("MULTICC_REMOTE_BIN", &remote_bin)
            .env("MULTICC_GATEWAY_UPSTREAM_WAIT_MS", "3000")
            .env("MULTICC_GATEWAY_BACKOFF_SCALE", "0.01")
            .env("FIXTURE_STATE_DIR", &state)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::from(log));
        if with_node {
            command
                .arg("--node")
                .arg(node_binary())
                .arg("server.js")
                .env(
                    "PATH",
                    std::env::var_os("PATH")
                        .unwrap_or_else(|| "/usr/local/bin:/usr/bin:/bin".into()),
                )
                .env("PORT", port.to_string());
        } else {
            command
                .arg("--no-node")
                .arg("--ephemeral-loopback")
                .env("PATH", &empty);
        }
        // Windows needs its system variables even in a cleared environment;
        // HOME/SYSTEMROOT drive the child's `os.homedir()` and Winsock.
        for key in [
            "SystemRoot",
            "SYSTEMROOT",
            "windir",
            "TEMP",
            "TMP",
            "APPDATA",
            "LOCALAPPDATA",
            "PATHEXT",
            "ComSpec",
        ] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        // After the system vars, so the front door's data root is deterministic
        // (the annotation path check depends on it).
        command
            .env("ACCESS_TOKEN", TOKEN)
            .env("HOME", &home)
            .env("USERPROFILE", &home);
        for (key, value) in extra {
            command.env(key, value);
        }

        let child = command.spawn().expect("spawn multicc-gateway");
        let mut gateway = Gateway {
            dir,
            state,
            home,
            port,
            child,
        };
        if with_node {
            // The public listener binds before Node starts, but gated routes
            // need Node's control channel (`state/ready` is its marker).
            if !gateway.wait_for(&gateway.state.join("ready"), Duration::from_secs(15)) {
                if gateway.log().contains("cannot bind") {
                    let _ = gateway.child.kill();
                    let _ = gateway.child.wait();
                    let _ = fs::remove_dir_all(&gateway.dir);
                    return None;
                }
                panic!(
                    "gateway/node never became ready\n--- log ---\n{}",
                    gateway.log()
                );
            }
        } else {
            // `--ephemeral-loopback`: learn the port from the listening line.
            let deadline = Instant::now() + Duration::from_secs(20);
            let port = loop {
                if let Some(port) = parse_listening(&gateway.log()) {
                    break port;
                }
                assert!(
                    gateway.child.try_wait().unwrap().is_none(),
                    "gateway exited before listening\n{}",
                    gateway.log()
                );
                assert!(
                    Instant::now() < deadline,
                    "gateway never listened\n--- log ---\n{}",
                    gateway.log()
                );
                std::thread::sleep(Duration::from_millis(20));
            };
            gateway.port = port;
        }
        Some(gateway)
    }

    fn log(&self) -> String {
        fs::read_to_string(self.dir.join("gateway.log")).unwrap_or_default()
    }

    fn remote_dir(&self) -> PathBuf {
        self.home
            .join(".multicc")
            .join("assist")
            .join("remote-screen")
    }

    fn addr(&self) -> SocketAddr {
        SocketAddr::from(([127, 0, 0, 1], self.port))
    }

    fn connect(&self) -> TcpStream {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match TcpStream::connect(("127.0.0.1", self.port)) {
                Ok(stream) => {
                    stream.set_nodelay(true).unwrap();
                    stream
                        .set_read_timeout(Some(Duration::from_secs(30)))
                        .unwrap();
                    stream
                        .set_write_timeout(Some(Duration::from_secs(30)))
                        .unwrap();
                    return stream;
                }
                Err(error) if Instant::now() < deadline => {
                    let _ = error;
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(error) => panic!("cannot connect to gateway: {error}\n{}", self.log()),
            }
        }
    }

    fn raw(&self, text: &str) -> Response {
        let mut client = self.connect();
        client.write_all(text.as_bytes()).unwrap();
        let mut raw = Vec::new();
        client.read_to_end(&mut raw).unwrap();
        Response::parse(&raw)
    }

    /// Poll a path for existence (the fixture writes markers out of band).
    fn wait_for(&self, path: &Path, limit: Duration) -> bool {
        let deadline = Instant::now() + limit;
        while Instant::now() < deadline {
            if path.exists() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        path.exists()
    }

    /// The Node fixture's request log (one JSON line per request it received).
    fn node_requests(&self) -> Vec<Value> {
        jsonl(&self.state.join("requests.log"))
    }
}

impl Drop for Gateway {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn parse_listening(log: &str) -> Option<u16> {
    const PREFIX: &str = "listening on 127.0.0.1:";
    for line in log.lines() {
        let Some(start) = line.find(PREFIX) else {
            continue;
        };
        let rest = &line[start + PREFIX.len()..];
        let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
        if let Ok(port) = digits.parse() {
            return Some(port);
        }
    }
    None
}

fn jsonl(path: &Path) -> Vec<Value> {
    fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

fn http_request(
    method: &str,
    path: &str,
    host: &str,
    headers: &[(&str, &str)],
    body: &str,
) -> String {
    let mut raw = format!("{method} {path} HTTP/1.1\r\nHost: {host}\r\n");
    for (name, value) in headers {
        raw.push_str(&format!("{name}: {value}\r\n"));
    }
    if !body.is_empty() {
        raw.push_str(&format!("Content-Length: {}\r\n", body.len()));
    }
    raw.push_str("Connection: close\r\n\r\n");
    raw.push_str(body);
    raw
}

struct Response {
    status: u16,
    header_text: String,
    body: Vec<u8>,
}

impl Response {
    fn parse(raw: &[u8]) -> Self {
        let split = raw
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .unwrap_or_else(|| {
                panic!("no header terminator in {:?}", String::from_utf8_lossy(raw))
            });
        let header_text = String::from_utf8_lossy(&raw[..split]).into_owned();
        let status = header_text
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .and_then(|code| code.parse().ok())
            .unwrap_or_else(|| panic!("no status in {header_text:?}"));
        Self {
            status,
            header_text: header_text.to_ascii_lowercase(),
            body: raw[split + 4..].to_vec(),
        }
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    fn json(&self) -> Value {
        serde_json::from_str(&self.text()).expect("json body")
    }

    fn header(&self, name: &str) -> Option<String> {
        self.header_text.lines().skip(1).find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.trim()
                .eq_ignore_ascii_case(name)
                .then(|| value.trim().to_string())
        })
    }
}

// ── WebSocket helpers ───────────────────────────────────────────────────────

/// Connect with an explicit `Host`: a loopback peer carrying a non-local Host is
/// the "public client" admission sees, which is what makes the ticket required.
async fn connect_ws(addr: SocketAddr, query: &str, host: &str) -> Ws {
    let mut request = format!("ws://{addr}/ws/remote-screen{query}")
        .into_client_request()
        .expect("ws request");
    request
        .headers_mut()
        .insert("host", HeaderValue::from_str(host).unwrap());
    let (ws, _) = connect_async(request).await.expect("connect ws");
    ws
}

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

/// Signal-0 liveness probe. Returns true only if `pid` exists and we are
/// allowed to signal it (same-user fixture processes always are), so a false
/// return means the process is genuinely gone — our own reaped child.
#[cfg(unix)]
fn process_alive(pid: libc::pid_t) -> bool {
    // SAFETY: signal 0 performs the permission/existence check without
    // delivering any signal.
    unsafe { libc::kill(pid, 0) == 0 }
}

// ── (a) HTTP reaches the Rust forwarder, not Node ───────────────────────────

#[test]
fn http_remote_screen_reaches_the_rust_forwarder_not_node() {
    let requests = unique("remote-requests");
    let gateway = Gateway::start_node(
        "http",
        &[(
            "FIXTURE_REQUESTS_FILE",
            requests.to_string_lossy().into_owned(),
        )],
    );
    let response = gateway.raw(&http_request(
        "GET",
        "/api/remote-screen/capabilities",
        "box.example.com",
        &[("X-Access-Token", TOKEN)],
        "",
    ));
    assert_eq!(response.status, 200, "{}", gateway.log());
    // The fixture echoes what it received: the original target and method.
    let body = response.json();
    assert_eq!(body["method"], "GET");
    assert_eq!(body["target"], "/api/remote-screen/capabilities");
    // A header only the fixture sets, copied through `x-screen-*`.
    assert_eq!(
        response.header("x-screen-marker").as_deref(),
        Some("fixture")
    );

    // The forwarder really reached the multicast-remote fixture.
    let recorded = jsonl(&requests);
    assert!(
        recorded
            .iter()
            .any(|record| record["target"] == "/api/remote-screen/capabilities"),
        "the fake remote did not receive the forward: {recorded:?}"
    );
    // ...and Node never saw it.
    assert!(
        gateway.node_requests().iter().all(|record| !record["url"]
            .as_str()
            .unwrap_or("")
            .starts_with("/api/remote-screen")),
        "the request was forwarded to Node: {:?}",
        gateway.node_requests()
    );
    let _ = fs::remove_file(&requests);
}

// ── (b) WS admission: ticketless refused, ticketed bridged ──────────────────

#[tokio::test]
async fn ws_remote_screen_refuses_ticketless_and_bridges_a_ticket() {
    let gateway = Gateway::start_no_node("ws", &[("FIXTURE_WS", "echo".to_string())]);
    let addr = gateway.addr();

    // A public (non-local Host) peer with no ticket is refused after the 101.
    let mut refused = connect_ws(addr, "", "box.example.com").await;
    let (code, reason) = next_close(&mut refused, Duration::from_secs(5))
        .await
        .expect("a refusal close frame");
    assert_eq!(code, 4003, "reason={reason}");

    // A ticket issued for this very path (local auth runtime, `--no-node`)
    // admits the same peer and the bridge echoes.
    let ticket_response = gateway.raw(&http_request(
        "POST",
        "/api/auth/ws-ticket",
        &format!("127.0.0.1:{}", gateway.port),
        &[
            ("Content-Type", "application/json"),
            ("X-Access-Token", TOKEN),
        ],
        r#"{"path":"/ws/remote-screen"}"#,
    ));
    assert_eq!(ticket_response.status, 200, "{}", ticket_response.text());
    let ticket = ticket_response.json()["ticket"]
        .as_str()
        .expect("ticket")
        .to_string();

    let mut admitted = connect_ws(addr, &format!("?ticket={ticket}"), "box.example.com").await;
    admitted
        .send(Message::Text("hello".into()))
        .await
        .expect("send text");
    let echoed = next_data(&mut admitted, Duration::from_secs(5))
        .await
        .expect("bridged echo");
    assert_eq!(echoed, Message::Text("hello".into()));
}

/// The production default is `--node`: Node owns the authentication runtime and
/// the front door reaches it over the control channel. A public peer carrying a
/// valid credential must be admitted there exactly as under `--no-node`; the
/// admission facts may not depend on the front door owning a local runtime.
/// (A peer on the loopback host is admitted regardless, which is why only a
/// public `Host` can tell the two apart.)
#[tokio::test]
async fn ws_remote_screen_admits_a_credentialed_public_peer_under_node() {
    let gateway = Gateway::start_node(
        "ws-node",
        &[
            ("FIXTURE_WS", "echo".to_string()),
            ("MULTICC_ALLOW_LEGACY_WS_TOKEN", "1".to_string()),
        ],
    );
    let addr = gateway.addr();

    // Control: no credential is still refused, so a pass below cannot be
    // "everything is admitted".
    let mut refused = connect_ws(addr, "", "box.example.com").await;
    let (code, reason) = next_close(&mut refused, Duration::from_secs(8))
        .await
        .expect("a refusal close frame");
    assert_eq!(code, 4003, "reason={reason}");

    let mut admitted = connect_ws(addr, &format!("?token={TOKEN}"), "box.example.com").await;
    admitted
        .send(Message::Text("hello".into()))
        .await
        .expect("send text");
    let echoed = next_data(&mut admitted, Duration::from_secs(8))
        .await
        .expect("a credentialed public peer must be bridged under --node");
    assert_eq!(echoed, Message::Text("hello".into()));
}

/// The app's path: it asks for a one-use ticket and connects with it. Under
/// `--node` the redemption goes over the control channel to Node, so a public
/// peer's ticket must be redeemed there, once, for this very path. The fixture
/// redeems `fixture-ticket` for `/ws/remote-screen` a single time.
#[tokio::test]
async fn ws_remote_screen_redeems_a_ticket_over_the_control_channel_once() {
    let gateway = Gateway::start_node("ws-node-ticket", &[("FIXTURE_WS", "echo".to_string())]);
    let addr = gateway.addr();

    let mut admitted = connect_ws(addr, "?ticket=fixture-ticket", "box.example.com").await;
    admitted
        .send(Message::Text("hello".into()))
        .await
        .expect("send text");
    let echoed = next_data(&mut admitted, Duration::from_secs(8))
        .await
        .expect("a ticket Node redeems for this path must be bridged under --node");
    assert_eq!(echoed, Message::Text("hello".into()));

    // The same ticket again: Node already spent it, so the front door refuses.
    let mut replay = connect_ws(addr, "?ticket=fixture-ticket", "box.example.com").await;
    let (code, reason) = next_close(&mut replay, Duration::from_secs(8))
        .await
        .expect("a refusal close frame");
    assert_eq!(code, 4003, "reason={reason}");

    // A ticket Node does not know is refused as well.
    let mut forged = connect_ws(addr, "?ticket=not-a-ticket", "box.example.com").await;
    let (code, reason) = next_close(&mut forged, Duration::from_secs(8))
        .await
        .expect("a refusal close frame");
    assert_eq!(code, 4003, "reason={reason}");
}

// ── (c) annotation: own-shot bypasses the Node host; a miss keeps it ─────────

#[test]
fn annotation_own_shot_skips_the_node_host_but_a_miss_keeps_it() {
    let script = unique("host-script");
    fs::write(
        &script,
        r#"{"events":{"ops":{"annotation-relay":{"relayed":1,"results":[{"ok":true,"text":"host"}]}}}}"#,
    )
    .unwrap();
    let gateway = Gateway::start_node(
        "annotation",
        &[
            ("FIXTURE_ANNOTATION", "ok".to_string()),
            ("FIXTURE_HOST_SCRIPT", script.to_string_lossy().into_owned()),
        ],
    );
    let events = gateway.state.join("events-calls.jsonl");
    let dir = gateway.remote_dir();

    // Own shot: `src` resolves inside DIR as `shot-<digits>.png` (the file need
    // not exist). The child answers, the Node host is never asked.
    let own = dir.join("shot-42.png");
    let body = format!(
        r#"{{"sessionId":"s1","src":{},"width":10,"height":10,"kind":"shot","a":null,"b":null}}"#,
        serde_json::to_string(&own.to_string_lossy()).unwrap()
    );
    let response = gateway.raw(&http_request(
        "POST",
        "/api/annotation-live",
        &format!("127.0.0.1:{}", gateway.port),
        &[
            ("Content-Type", "application/json"),
            ("X-Access-Token", TOKEN),
        ],
        &body,
    ));
    assert_eq!(response.status, 200, "{}", response.text());
    let answer = response.json();
    assert_eq!(answer["relayed"], 1, "{}", response.text());
    // The child's fixture answer, not the host's.
    assert_eq!(answer["results"][0]["text"], "done", "{}", response.text());
    // The Node host may see other traffic, but never an annotation relay for a
    // shot the front door recognised as the remote screen's own.
    assert!(
        jsonl(&events)
            .iter()
            .all(|call| call["op"] != "annotation-relay"),
        "the Node host was called for an own-shot: {:?}",
        jsonl(&events)
    );

    // Miss: a `src` outside DIR goes to the Node host exactly as before.
    let outside = gateway.home.join("elsewhere").join("shot-7.png");
    let body = format!(
        r#"{{"sessionId":"s1","src":{},"width":10,"height":10,"kind":"shot","a":null,"b":null}}"#,
        serde_json::to_string(&outside.to_string_lossy()).unwrap()
    );
    let response = gateway.raw(&http_request(
        "POST",
        "/api/annotation-live",
        &format!("127.0.0.1:{}", gateway.port),
        &[
            ("Content-Type", "application/json"),
            ("X-Access-Token", TOKEN),
        ],
        &body,
    ));
    assert_eq!(response.status, 200, "{}", response.text());
    assert_eq!(response.json()["results"][0]["text"], "host");
    let calls = jsonl(&events);
    assert!(
        calls.iter().any(|call| call["op"] == "annotation-relay"),
        "the Node host was not called for a non-own-shot: {calls:?}"
    );
    let _ = fs::remove_file(&script);
}

// ── (d) a stop signal drains the multicast-remote child ─────────────────────

#[cfg(unix)]
#[test]
fn stopping_the_front_door_drains_the_remote_child() {
    // The fixture writes this file once it starts, and `<path>.eof` once its
    // stdin (the front door's lifeline) reaches EOF — proof it exited on its
    // own instead of being killed or orphaned.
    let stdin_file = unique("remote-stdin");
    let pid_file = unique("remote-pid");
    let gateway = Gateway::start_no_node(
        "shutdown",
        &[
            (
                "FIXTURE_STDIN_FILE",
                stdin_file.to_string_lossy().into_owned(),
            ),
            ("FIXTURE_PID_FILE", pid_file.to_string_lossy().into_owned()),
        ],
    );

    // Spawn the child through the real HTTP forward.
    let response = gateway.raw(&http_request(
        "GET",
        "/api/remote-screen/capabilities",
        &format!("127.0.0.1:{}", gateway.port),
        &[],
        "",
    ));
    assert_eq!(response.status, 200, "{}", gateway.log());
    assert!(
        gateway.wait_for(&pid_file, Duration::from_secs(5)),
        "the remote child never started: {}",
        gateway.log()
    );
    let pid: libc::pid_t = fs::read_to_string(&pid_file)
        .expect("read the remote child pid file")
        .trim()
        .parse()
        .expect("the remote child wrote a numeric pid");
    // Process existence (not a log line): the fake remote child is a live
    // process right now, so it must answer a signal-0 liveness probe.
    assert!(
        process_alive(pid),
        "the remote child (pid {pid}) is not running"
    );

    // SAFETY: signalling the gateway process we just spawned.
    unsafe {
        libc::kill(gateway.child.id() as libc::pid_t, libc::SIGTERM);
    }
    let mut gateway = gateway;
    let status = gateway
        .wait_exit(Duration::from_secs(10))
        .expect("the front door did not exit after SIGTERM");
    assert_eq!(status.code(), Some(0), "{}", gateway.log());

    // Process existence, the strongest of the three checks: once the front door
    // is reaped its `shutdown()` has already waited on the child, so the child
    // pid must be gone. A skipped drain would leave the child reparented (still
    // alive at this instant, or at least not reaped by us) and this probe fails.
    assert!(
        !process_alive(pid),
        "the remote child (pid {pid}) outlived the front door:\n{}",
        gateway.log()
    );

    // The fixture also writes `<stdin>.eof` from its own lifeline thread the
    // instant its stdin reaches EOF, *then* exits. Reaching that line means the
    // child saw a clean stdin EOF (the lifeline contract), not a kill.
    let eof = PathBuf::from(format!("{}.eof", stdin_file.to_string_lossy()));
    assert!(
        eof.exists(),
        "the remote child did not exit through its stdin lifeline: {}\n{}",
        eof.display(),
        gateway.log()
    );

    // Drain ordering, visible only in the front-door log: `remote_screen_stopped`
    // is emitted by the shutdown path (a ready child exiting after `stopping` was
    // set). If the drain were skipped the child would still exit via the closed
    // pipe — the pid/`.eof` checks above would pass — but this line could not be
    // produced, so it is what pins the teardown to the explicit shutdown call.
    let log = gateway.log();
    assert!(
        log.contains("remote_screen_stopped"),
        "the front door exited without draining the child: {log}"
    );
    let _ = fs::remove_file(&stdin_file);
    let _ = fs::remove_file(&pid_file);
    let _ = fs::remove_file(&eof);
}

// ── (e) HTTP forwarder and WS bridge share one child ────────────────────────

#[tokio::test]
async fn http_and_ws_share_one_remote_child() {
    let requests = unique("shared-requests");
    let gateway = Gateway::start_no_node(
        "shared",
        &[
            ("FIXTURE_WS", "echo".to_string()),
            (
                "FIXTURE_REQUESTS_FILE",
                requests.to_string_lossy().into_owned(),
            ),
        ],
    );

    // One HTTP forward...
    let response = gateway.raw(&http_request(
        "GET",
        "/api/remote-screen/capabilities",
        &format!("127.0.0.1:{}", gateway.port),
        &[],
        "",
    ));
    assert_eq!(response.status, 200, "{}", gateway.log());

    // ...and one WS bridge, both against the same child.
    let mut ws = connect_ws(gateway.addr(), "", "127.0.0.1").await;
    ws.send(Message::Text("ping".into())).await.expect("send");
    assert_eq!(
        next_data(&mut ws, Duration::from_secs(5)).await,
        Some(Message::Text("ping".into()))
    );

    // A single supervisor means a single spawn (`remote_child` logs one
    // `remote_screen_starting` per start attempt).
    let spawns = gateway.log().matches("remote_screen_starting").count();
    assert_eq!(spawns, 1, "expected one spawn\n{}", gateway.log());

    // Both surfaces reached the one fixture process.
    let recorded = jsonl(&requests);
    assert!(
        recorded
            .iter()
            .any(|record| record["target"] == "/api/remote-screen/capabilities"),
        "no HTTP forward recorded: {recorded:?}"
    );
    assert!(
        recorded.iter().any(|record| record["target"]
            .as_str()
            .is_some_and(|target| target.starts_with("/ws/remote-screen"))),
        "no WS bridge recorded: {recorded:?}"
    );
    let _ = fs::remove_file(&requests);
}

impl Gateway {
    #[cfg(unix)]
    fn wait_exit(&mut self, timeout: Duration) -> Option<ExitStatus> {
        let deadline = Instant::now() + timeout;
        loop {
            match self.child.try_wait().unwrap() {
                Some(status) => return Some(status),
                None if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
                None => return None,
            }
        }
    }
}
