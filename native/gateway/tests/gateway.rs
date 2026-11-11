//! End-to-end tests for the Rust front door. Each test runs the real
//! `multicc-gateway` binary against a Node fixture that parses the PROXY line
//! itself and then speaks ordinary HTTP; nothing here depends on
//! src/gateway-child.js.

use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::Value;

const GATEWAY_BIN: &str = env!("CARGO_BIN_EXE_multicc-gateway");
const FIXTURE: &str = include_str!("fixtures/upstream.js");

fn node_binary() -> String {
    std::env::var("MULTICC_TEST_NODE").unwrap_or_else(|_| "node".to_string())
}

fn unique(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "multicc-gateway-test-{}-{tag}-{nanos}",
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
    port: u16,
    child: Child,
}

impl Gateway {
    fn start(tag: &str, mode: &str, extra: &[(&str, String)]) -> Self {
        // free_port() releases its probe, and tests run in parallel: another
        // front door may take that number as its internal port first. That is
        // a harness race (production keeps the public port bound), so retry
        // on a fresh port instead of failing the test.
        Self::start_with(tag, mode, extra, false)
    }

    /// Like `start`, but our parent holds the gateway's stdin
    /// (`--stdin-lifeline`); drop `child.stdin` to ask it to stop.
    fn start_with(tag: &str, mode: &str, extra: &[(&str, String)], lifeline: bool) -> Self {
        Self::start_files(tag, mode, extra, &[], lifeline)
    }

    /// Like `start_with`, with `files` written into the package directory
    /// (the gateway's cwd, next to the fixture's server.js) first.
    fn start_files(
        tag: &str,
        mode: &str,
        extra: &[(&str, String)],
        files: &[(&str, String)],
        lifeline: bool,
    ) -> Self {
        for _ in 0..5 {
            let mut gateway = Self::spawn(tag, mode, extra, files, None, lifeline);
            if gateway.wait_ready_unless_port_taken() {
                return gateway;
            }
        }
        panic!("could not find a free public port for the gateway after 5 attempts");
    }

    fn wait_ready_unless_port_taken(&mut self) -> bool {
        let deadline = Instant::now() + Duration::from_secs(15);
        while !self.state.join("ready").exists() {
            if self.child.try_wait().unwrap().is_some() && self.log().contains("cannot bind") {
                return false;
            }
            if Instant::now() >= deadline {
                panic!(
                    "gateway/fixture never became ready\n--- gateway log ---\n{}",
                    self.log()
                );
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        true
    }

    fn start_on(tag: &str, port: u16) -> Self {
        Self::spawn(tag, "echo", &[], &[], Some(port), false)
    }

    fn spawn(
        tag: &str,
        mode: &str,
        extra: &[(&str, String)],
        files: &[(&str, String)],
        port: Option<u16>,
        lifeline: bool,
    ) -> Self {
        let dir = unique(tag);
        let state = dir.join("state");
        fs::create_dir_all(&state).unwrap();
        fs::write(dir.join("server.js"), FIXTURE).unwrap();
        for (name, content) in files {
            fs::write(dir.join(name), content).unwrap();
        }
        let port = port.unwrap_or_else(free_port);
        let log = fs::File::create(dir.join("gateway.log")).unwrap();
        let mut command = Command::new(GATEWAY_BIN);
        command
            .arg("serve")
            .arg("--cwd")
            .arg(&dir)
            .arg("--node")
            .arg(node_binary())
            .args(lifeline.then_some("--stdin-lifeline"))
            .arg("server.js")
            .env_clear()
            .env(
                "PATH",
                std::env::var_os("PATH").unwrap_or_else(|| "/usr/local/bin:/usr/bin:/bin".into()),
            )
            .env("PORT", port.to_string())
            .env("MULTICC_GATEWAY_UPSTREAM_WAIT_MS", "3000")
            .env("MULTICC_GATEWAY_BACKOFF_SCALE", "0.01")
            .env("FIXTURE_MODE", mode)
            .env("FIXTURE_STATE_DIR", &state)
            .stdin(if lifeline {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::null())
            .stderr(Stdio::from(log));
        // Windows needs its system variables even in a cleared environment
        // (Winsock reads SystemRoot); none of them exist elsewhere.
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
            let value = std::env::var_os(key);
            if let Some(value) = value {
                command.env(key, value);
            }
        }
        for (key, value) in extra {
            command.env(key, value);
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

    fn json_lines(&self, name: &str) -> Vec<Value> {
        fs::read_to_string(self.state.join(name))
            .unwrap_or_default()
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| serde_json::from_str(line).expect("JSON state line"))
            .collect()
    }

    fn connections(&self) -> Vec<Value> {
        self.json_lines("connections.log")
    }

    fn requests(&self) -> Vec<Value> {
        self.json_lines("requests.log")
    }

    fn closed_ids(&self) -> Vec<u64> {
        fs::read_to_string(self.state.join("closed.log"))
            .unwrap_or_default()
            .lines()
            .filter_map(|line| line.trim().parse().ok())
            .collect()
    }

    fn ports(&self) -> Vec<u16> {
        fs::read_to_string(self.state.join("ports.log"))
            .unwrap_or_default()
            .lines()
            .filter_map(|line| line.trim().parse().ok())
            .collect()
    }

    /// Polls state until `predicate` holds (state files are appended by the
    /// fixture in another process, so a just-sent request may not be visible
    /// yet).
    fn wait_for_state(&self, what: &str, predicate: impl Fn(&Gateway) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !predicate(self) {
            assert!(
                Instant::now() < deadline,
                "timed out waiting for {what}\n{}",
                self.log()
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

impl Drop for Gateway {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.dir);
    }
}

// ── HTTP client helpers ─────────────────────────────────────────────────────

struct HttpResponse {
    status: u16,
    /// The header block exactly as it arrived (case included).
    header_text: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl HttpResponse {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(header, _)| header.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).expect("JSON response body")
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

fn read_until(stream: &mut TcpStream, needle: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut byte = [0_u8; 1];
    while !out.ends_with(needle) {
        match stream.read(&mut byte) {
            Ok(0) => break,
            Ok(_) => out.push(byte[0]),
            Err(error) => panic!("read failed: {error}"),
        }
    }
    out
}

fn read_line(stream: &mut TcpStream) -> Vec<u8> {
    read_until(stream, b"\r\n")
}

/// Reads the status line and headers, leaving the body unread.
fn read_response_head(stream: &mut TcpStream) -> HttpResponse {
    let bytes = read_until(stream, b"\r\n\r\n");
    assert!(
        bytes.ends_with(b"\r\n\r\n"),
        "truncated response head: {:?}",
        String::from_utf8_lossy(&bytes)
    );
    let text = String::from_utf8_lossy(&bytes).into_owned();
    let mut lines = text.split("\r\n");
    let status_line = lines.next().unwrap_or_default().to_string();
    let status = status_line
        .split_whitespace()
        .nth(1)
        .unwrap_or_else(|| panic!("no status code in {status_line:?}"))
        .parse()
        .expect("numeric status");
    let mut headers = Vec::new();
    for line in lines {
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            headers.push((name.trim().to_string(), value.trim().to_string()));
        }
    }
    HttpResponse {
        status,
        header_text: text,
        headers,
        body: Vec::new(),
    }
}

/// Reads one chunk of a chunked body; `None` after the terminating chunk.
fn read_chunk(stream: &mut TcpStream) -> Option<Vec<u8>> {
    let line = read_line(stream);
    assert!(!line.is_empty(), "connection closed inside a chunked body");
    let text = String::from_utf8_lossy(&line);
    let size = usize::from_str_radix(text.trim().split(';').next().unwrap_or(""), 16)
        .unwrap_or_else(|_| panic!("bad chunk size line: {text:?}"));
    if size == 0 {
        // Discard trailers up to the blank line.
        loop {
            let trailer = read_line(stream);
            if trailer.is_empty() || trailer == b"\r\n" {
                break;
            }
        }
        return None;
    }
    let mut chunk = vec![0_u8; size + 2];
    stream.read_exact(&mut chunk).expect("chunk data");
    chunk.truncate(size);
    Some(chunk)
}

fn read_chunked_body(stream: &mut TcpStream) -> Vec<u8> {
    let mut body = Vec::new();
    while let Some(chunk) = read_chunk(stream) {
        body.extend_from_slice(&chunk);
    }
    body
}

fn read_response(stream: &mut TcpStream) -> HttpResponse {
    let mut response = read_response_head(stream);
    if matches!(response.status, 101 | 204 | 304) {
        return response;
    }
    let chunked = response
        .header("transfer-encoding")
        .map(|value| value.to_ascii_lowercase().contains("chunked"))
        .unwrap_or(false);
    if chunked {
        response.body = read_chunked_body(stream);
        return response;
    }
    if let Some(length) = response
        .header("content-length")
        .and_then(|value| value.parse::<usize>().ok())
    {
        let mut body = vec![0_u8; length];
        stream.read_exact(&mut body).expect("response body");
        response.body = body;
        return response;
    }
    let mut body = Vec::new();
    stream.read_to_end(&mut body).unwrap();
    response.body = body;
    response
}

fn get(path: &str) -> Vec<u8> {
    format!("GET {path} HTTP/1.1\r\nHost: test\r\n\r\n").into_bytes()
}

fn request(stream: &mut TcpStream, raw: &[u8]) -> HttpResponse {
    stream.write_all(raw).unwrap();
    read_response(stream)
}

fn payload(size: usize) -> Vec<u8> {
    let mut state: u64 = 0x9e37_79b9_7f4a_7c15;
    (0..size)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state >> 24) as u8
        })
        .collect()
}

/// The fixture's deterministic download pattern (period 256 bytes).
fn download_pattern(size: usize) -> Vec<u8> {
    (0..size)
        .map(|index| (index.wrapping_mul(31) + 7) as u8)
        .collect()
}

fn sha256(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn expected_proxy(client_port: u16, gateway_port: u16) -> String {
    format!("PROXY TCP4 127.0.0.1 127.0.0.1 {client_port} {gateway_port}")
}

// ── forwarding ──────────────────────────────────────────────────────────────

#[test]
fn upstream_receives_the_front_doors_own_proxy_header() {
    let gateway = Gateway::start("header", "echo", &[]);
    let mut client = gateway.connect();
    let client_port = client.local_addr().unwrap().port();
    let response = request(&mut client, &get("/proxy"));
    assert_eq!(response.status, 200, "{}", gateway.log());
    let body = response.json();
    assert_eq!(
        body["line"].as_str(),
        Some(expected_proxy(client_port, gateway.port).as_str()),
        "{}",
        gateway.log()
    );
}

#[test]
fn two_requests_on_one_client_connection_share_one_upstream_connection() {
    let gateway = Gateway::start("keepalive", "echo", &[]);
    let mut client = gateway.connect();
    let first = request(&mut client, &get("/one"));
    assert_eq!(first.text(), "one", "{}", gateway.log());
    let second = request(&mut client, &get("/two"));
    assert_eq!(second.text(), "two", "{}", gateway.log());
    gateway.wait_for_state("both requests", |gateway| gateway.requests().len() == 2);
    let connections = gateway.connections();
    assert_eq!(
        connections.len(),
        1,
        "one client connection must own exactly one upstream connection: {connections:?}\n{}",
        gateway.log()
    );
    let requests = gateway.requests();
    assert_eq!(requests[0]["id"], requests[1]["id"]);
}

#[test]
fn two_client_connections_get_two_upstream_connections() {
    let gateway = Gateway::start("two-clients", "echo", &[]);
    let mut first = gateway.connect();
    assert_eq!(request(&mut first, &get("/one")).text(), "one");
    let mut second = gateway.connect();
    assert_eq!(request(&mut second, &get("/one")).text(), "one");
    gateway.wait_for_state("two connections", |gateway| {
        gateway.connections().len() == 2
    });
    let connections = gateway.connections();
    assert_ne!(connections[0]["id"], connections[1]["id"]);
}

#[test]
fn a_node_closed_keep_alive_connection_is_replaced_on_the_next_request() {
    let gateway = Gateway::start("reconnect", "echo", &[]);
    let mut client = gateway.connect();
    // /hangup answers normally, then Node closes the internal connection while
    // the client's keep-alive connection stays open (what a keep-alive timeout
    // looks like from here).
    let first = request(&mut client, &get("/hangup"));
    assert_eq!(first.text(), "ok", "{}", gateway.log());
    let first_id = first_id(&gateway);
    gateway.wait_for_state("node to close the upstream connection", |gateway| {
        gateway.closed_ids().contains(&first_id)
    });
    let second = request(&mut client, &get("/two"));
    assert_eq!(second.text(), "two", "{}", gateway.log());
    gateway.wait_for_state("a replacement connection", |gateway| {
        gateway.connections().len() == 2
    });
    let connections = gateway.connections();
    assert_ne!(
        connections[0]["id"], connections[1]["id"],
        "the replacement upstream must be a new connection with a new PROXY line"
    );
}

fn first_id(gateway: &Gateway) -> u64 {
    gateway.wait_for_state("a recorded connection", |gateway| {
        !gateway.connections().is_empty()
    });
    gateway.connections()[0]["id"].as_u64().unwrap()
}

#[test]
fn eight_megabyte_request_body_round_trips_byte_for_byte() {
    let gateway = Gateway::start("upload", "echo", &[]);
    let mut client = gateway.connect();
    let body = payload(8 * 1024 * 1024);
    let mut head = format!(
        "POST /echo HTTP/1.1\r\nHost: test\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\n\r\n",
        body.len()
    )
    .into_bytes();
    head.extend_from_slice(&body);
    client.write_all(&head).unwrap();
    let response = read_response(&mut client);
    assert_eq!(response.status, 200, "{}", gateway.log());
    assert_eq!(response.body.len(), body.len(), "{}", gateway.log());
    assert_eq!(sha256(&response.body), sha256(&body));
}

#[test]
fn eight_megabyte_response_body_round_trips_byte_for_byte() {
    let gateway = Gateway::start("download", "echo", &[]);
    let mut client = gateway.connect();
    let response = request(&mut client, &get("/bulk-down"));
    assert_eq!(response.status, 200, "{}", gateway.log());
    let expected = download_pattern(8 * 1024 * 1024);
    assert_eq!(response.body.len(), expected.len(), "{}", gateway.log());
    assert_eq!(sha256(&response.body), sha256(&expected));
}

#[test]
fn a_streamed_response_reaches_the_client_before_it_ends() {
    let gateway = Gateway::start("sse", "echo", &[]);
    let mut client = gateway.connect();
    // The fixture sends the first chunk immediately and the second 1.5s later.
    // A buffering front door would deliver nothing for over a second.
    client
        .set_read_timeout(Some(Duration::from_secs(1)))
        .unwrap();
    client.write_all(&get("/sse")).unwrap();
    let head = read_response_head(&mut client);
    assert_eq!(head.status, 200, "{}", gateway.log());
    assert_eq!(head.header("transfer-encoding"), Some("chunked"));
    let first = read_chunk(&mut client).expect("first chunk");
    assert_eq!(first, b"data: first\n\n", "{}", gateway.log());
    // The response is still open; let the rest through at normal timeouts.
    client
        .set_read_timeout(Some(Duration::from_secs(30)))
        .unwrap();
    let second = read_chunk(&mut client).expect("second chunk");
    assert_eq!(second, b"data: second\n\n");
    assert!(read_chunk(&mut client).is_none(), "chunked body must end");
}

#[test]
fn a_custom_request_and_response_header_keeps_its_case() {
    let gateway = Gateway::start("header-case", "echo", &[]);
    let mut client = gateway.connect();
    let raw = b"GET /headers HTTP/1.1\r\nHost: test\r\nX-Custom-Case: Value123\r\n\r\n";
    let response = request(&mut client, raw);
    assert_eq!(response.status, 200, "{}", gateway.log());
    let body = response.json();
    let raw_headers: Vec<String> = body["rawHeaders"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap().to_string())
        .collect();
    let pair = raw_headers
        .windows(2)
        .find(|pair| pair[0] == "X-Custom-Case")
        .expect("the request header must reach node with its original case");
    assert_eq!(pair[1], "Value123");
    assert!(
        response.header_text.contains("X-Response-Case: kept"),
        "response header case changed: {}",
        response.header_text
    );
}

#[test]
fn an_upgrade_response_is_spliced_with_raw_bytes_both_ways() {
    let gateway = Gateway::start("upgrade", "echo", &[]);
    let mut client = gateway.connect();
    client
        .write_all(
            b"GET /upgrade HTTP/1.1\r\nHost: test\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n",
        )
        .unwrap();
    let head = read_response_head(&mut client);
    assert_eq!(head.status, 101, "{}", gateway.log());
    client.write_all(b"raw upgrade bytes").unwrap();
    let mut echo = vec![0_u8; b"raw upgrade bytes".len()];
    client.read_exact(&mut echo).unwrap();
    assert_eq!(echo, b"raw upgrade bytes");
}

#[test]
fn the_env_gated_native_route_is_answered_without_node() {
    let gateway = Gateway::start(
        "native",
        "echo",
        &[("MULTICC_GATEWAY_TEST_ROUTES", "1".to_string())],
    );
    let mut client = gateway.connect();
    let response = request(&mut client, &get("/__gateway_test/native"));
    assert_eq!(response.status, 200, "{}", gateway.log());
    assert_eq!(
        response.text(),
        "multicc-gateway: answered by the rust front door\n"
    );
    // Give a forwarded request every chance to have reached Node.
    std::thread::sleep(Duration::from_millis(200));
    assert!(
        gateway.connections().is_empty(),
        "a native route must not touch node: {:?}",
        gateway.connections()
    );
}

// ── supervision ─────────────────────────────────────────────────────────────

#[test]
fn a_crashed_node_is_relaunched_and_the_next_request_succeeds() {
    // The fixture exits 1 on its first run and serves on the second; the fast
    // BACKOFF_SCALE makes the relaunch immediate.
    let gateway = Gateway::start("crash-restart", "exit-1-once", &[]);
    let mut client = gateway.connect();
    // The front door retries the upstream while the fixture is relaunched.
    let response = request(&mut client, &get("/one"));
    assert_eq!(response.text(), "one", "{}", gateway.log());
    assert!(
        gateway.ports().len() >= 2,
        "the fixture should have run twice: {:?}",
        gateway.ports()
    );
}

#[test]
fn exit_75_relaunches_quickly_on_a_different_internal_port() {
    let gateway = Gateway::start("port-75", "exit-75-once", &[]);
    let mut client = gateway.connect();
    let response = request(&mut client, &get("/one"));
    assert_eq!(response.text(), "one", "{}", gateway.log());
    let ports = gateway.ports();
    assert_eq!(ports.len(), 2, "{ports:?}\n{}", gateway.log());
    assert_ne!(
        ports[0], ports[1],
        "exit 75 must move to a new internal port"
    );
}

#[cfg(unix)]
#[test]
fn node_exits_on_its_own_when_the_front_door_is_killed() {
    let mut gateway = Gateway::start("lifeline", "echo", &[]);
    let pid: libc::pid_t = fs::read_to_string(gateway.state.join("pids.log"))
        .unwrap()
        .lines()
        .next()
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    // SIGKILL: the front door gets no chance to forward anything.
    gateway.child.kill().unwrap();
    gateway.child.wait().unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    // SAFETY: signal 0 only probes whether the pid still exists.
    while unsafe { libc::kill(pid, 0) } == 0 {
        assert!(
            Instant::now() < deadline,
            "node outlived a SIGKILLed front door (orphan pid {pid})"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(unix)]
#[test]
fn sigint_is_forwarded_and_the_front_door_exits_with_the_child() {
    let marker = unique("signal-marker");
    let gateway = Gateway::start(
        "sigint",
        "echo",
        &[("FIXTURE_SIGNAL_MARKER", marker.display().to_string())],
    );
    // SAFETY: signalling the gateway process we just spawned.
    unsafe {
        libc::kill(gateway.child.id() as libc::pid_t, libc::SIGINT);
    }
    let mut gateway = gateway;
    let status = gateway
        .wait_exit(Duration::from_secs(10))
        .expect("the front door did not exit after SIGINT");
    assert_eq!(status.code(), Some(0), "{}", gateway.log());
    assert_eq!(fs::read_to_string(&marker).unwrap_or_default(), "SIGINT");
    assert_eq!(
        gateway.ports().len(),
        1,
        "a stopping front door must not relaunch node"
    );
    let _ = fs::remove_file(marker);
}

#[test]
fn an_unreachable_upstream_gets_a_503_after_the_wait() {
    let gateway = Gateway::start(
        "unreachable",
        "no-listen",
        &[("MULTICC_GATEWAY_UPSTREAM_WAIT_MS", "300".to_string())],
    );
    let mut client = gateway.connect();
    let response = request(&mut client, &get("/one"));
    assert_eq!(response.status, 503, "{}", gateway.log());
    assert_eq!(response.header("retry-after"), Some("2"));
    assert_eq!(response.header("connection"), Some("close"));
}

#[test]
fn an_occupied_public_port_makes_the_front_door_exit_nonzero() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let mut gateway = Gateway::start_on("occupied", port);
    let status = gateway
        .wait_exit(Duration::from_secs(5))
        .expect("the front door should fail fast when the port is taken");
    assert_ne!(status.code(), Some(0), "{}", gateway.log());
    // Supervisors recognise a taken port by Node's errno name.
    assert!(gateway.log().contains("EADDRINUSE"), "{}", gateway.log());
    drop(listener);
}

#[test]
fn closing_its_stdin_stops_node_and_then_the_front_door() {
    let marker = unique("lifeline-marker");
    let mut gateway = Gateway::start_with(
        "stdin-lifeline",
        "echo",
        &[("FIXTURE_SIGNAL_MARKER", marker.display().to_string())],
        true,
    );
    drop(gateway.child.stdin.take());
    let status = gateway
        .wait_exit(Duration::from_secs(10))
        .expect("the front door did not stop after its stdin closed");
    assert_eq!(status.code(), Some(0), "{}", gateway.log());
    assert!(
        gateway.log().contains("stdin closed by our parent"),
        "{}",
        gateway.log()
    );
    // Unix forwards SIGINT; Windows closes Node's own lifeline instead.
    #[cfg(unix)]
    assert_eq!(fs::read_to_string(&marker).unwrap_or_default(), "SIGINT");
    assert_eq!(
        gateway.ports().len(),
        1,
        "a stopping front door must not relaunch node"
    );
    let _ = fs::remove_file(marker);
}

#[test]
fn without_the_flag_a_closed_stdin_changes_nothing() {
    // `nohup` and launchd hand us an stdin that reads EOF at once.
    let gateway = Gateway::start("no-lifeline", "echo", &[]);
    let mut gateway = gateway;
    assert!(
        gateway.wait_exit(Duration::from_millis(600)).is_none(),
        "{}",
        gateway.log()
    );
    let mut client = gateway.connect();
    assert_eq!(request(&mut client, &get("/one")).text(), "one");
}

#[test]
fn node_exiting_zero_on_its_own_stops_the_front_door() {
    let mut gateway = Gateway::start("exit-zero", "exit-0-on-connect", &[]);
    let mut client = gateway.connect();
    // The upstream connection is lazy: a request is what makes it happen.
    let _ = client.write_all(&get("/one"));
    let status = gateway
        .wait_exit(Duration::from_secs(10))
        .expect("a clean exit from node must end the front door");
    assert_eq!(status.code(), Some(0), "{}", gateway.log());
    assert!(
        gateway.log().contains("on its own; stopping"),
        "{}",
        gateway.log()
    );
    assert_eq!(
        gateway.ports().len(),
        1,
        "a clean exit is not a crash: no relaunch"
    );
}

#[test]
fn a_forged_client_proxy_line_never_reaches_node() {
    let gateway = Gateway::start("forged", "echo", &[]);
    let mut client = gateway.connect();
    let forged = b"PROXY TCP4 9.9.9.9 8.8.8.8 1111 2222\r\nGET / HTTP/1.1\r\nHost: test\r\n\r\n";
    client.write_all(forged).unwrap();
    // hyper's HTTP parser rejects the request line; the connection is answered
    // with 400 or simply closed.
    let mut probe = [0_u8; 1];
    match client.read(&mut probe) {
        Ok(0) => {}
        Ok(_) => {
            let mut head = vec![probe[0]];
            head.extend(read_until(&mut client, b"\r\n\r\n"));
            let text = String::from_utf8_lossy(&head);
            assert!(
                text.starts_with("HTTP/1.1 400"),
                "unexpected answer to a forged PROXY line: {text}"
            );
        }
        Err(_) => {}
    }
    std::thread::sleep(Duration::from_millis(200));
    assert!(
        gateway.connections().is_empty(),
        "a forged PROXY line must never reach node: {:?}",
        gateway.connections()
    );
}

#[test]
fn the_version_line_carries_the_protocol_version() {
    let output = Command::new(GATEWAY_BIN).arg("--version").output().unwrap();
    assert!(output.status.success());
    let line = String::from_utf8_lossy(&output.stdout);
    assert!(
        line.starts_with("multicc-gateway 12 "),
        "unexpected --version output: {line:?}"
    );
}

// ── native routes (§8) ──────────────────────────────────────────────────────

fn api(method: &str, path: &str, headers: &[(&str, &str)], body: &str) -> Vec<u8> {
    let mut raw = format!("{method} {path} HTTP/1.1\r\n");
    for (name, value) in headers {
        raw.push_str(&format!("{name}: {value}\r\n"));
    }
    if !body.is_empty() || method == "PUT" || method == "POST" {
        raw.push_str(&format!("Content-Length: {}\r\n", body.len()));
    }
    raw.push_str("\r\n");
    raw.push_str(body);
    raw.into_bytes()
}

const LOCAL: (&str, &str) = ("Host", "localhost");
const JSON_TYPE: (&str, &str) = ("Content-Type", "application/json");

fn preset_json(id: &str, saved_at: i64) -> String {
    format!(
        r#"{{"id":"{id}","name":"{id}","protocol":"anthropic","savedAt":{saved_at},"candidates":[{{"providerId":"a","model":"m"}},{{"providerId":"b","model":"m"}}]}}"#
    )
}

fn presets_body(ids: &[(&str, i64)]) -> String {
    let list: Vec<String> = ids.iter().map(|(id, at)| preset_json(id, *at)).collect();
    format!(r#"{{"presets":[{}]}}"#, list.join(","))
}

fn preset_ids(response: &HttpResponse) -> Vec<String> {
    response.json()["presets"]
        .as_array()
        .expect("presets array")
        .iter()
        .map(|preset| preset["id"].as_str().unwrap().to_string())
        .collect()
}

fn assert_no_node_connection(gateway: &Gateway) {
    std::thread::sleep(Duration::from_millis(200));
    assert!(
        gateway.connections().is_empty(),
        "a native route must not touch node: {:?}",
        gateway.connections()
    );
}

#[test]
fn run_config_presets_are_answered_by_the_front_door_alone() {
    let gateway = Gateway::start("presets", "echo", &[]);
    let mut client = gateway.connect();
    let empty = request(
        &mut client,
        &api("GET", "/api/run-config/presets", &[LOCAL], ""),
    );
    assert_eq!(empty.status, 200, "{}\n{}", empty.text(), gateway.log());
    assert_eq!(empty.text(), r#"{"ok":true,"presets":[]}"#);
    assert_eq!(
        empty.header("content-type"),
        Some("application/json; charset=utf-8")
    );
    assert_eq!(empty.header("vary"), Some("Accept-Encoding"));
    assert_eq!(empty.header("x-multicc-api-version"), Some("v1"));
    assert_eq!(empty.header("x-multicc-request-id").map(str::len), Some(8));
    assert!(empty.header("etag").unwrap().starts_with("W/\""));

    let body = presets_body(&[("one", 1)]);
    let put = request(
        &mut client,
        &api("PUT", "/api/run-config/presets", &[LOCAL, JSON_TYPE], &body),
    );
    assert_eq!(put.status, 200, "{}", put.text());
    assert_eq!(preset_ids(&put), ["one"]);
    let file = gateway.dir.join("run-config-presets.json");
    let written = fs::read_to_string(&file).unwrap();
    assert!(
        written.starts_with("{\n  \"version\": 1,\n  \"presets\": [\n    {\n"),
        "{written}"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    let listed = request(
        &mut client,
        &api("GET", "/api/run-config/presets/", &[LOCAL], ""),
    );
    assert_eq!(preset_ids(&listed), ["one"]);
    let etag = listed.header("etag").unwrap().to_string();
    let cached = request(
        &mut client,
        &api(
            "GET",
            "/api/run-config/presets",
            &[LOCAL, ("If-None-Match", &etag)],
            "",
        ),
    );
    assert_eq!(cached.status, 304);
    assert_eq!(cached.header("content-type"), None);

    let merged = request(
        &mut client,
        &api(
            "POST",
            "/api/run-config/presets/merge",
            &[LOCAL, JSON_TYPE],
            &presets_body(&[("two", 2)]),
        ),
    );
    assert_eq!(merged.status, 200, "{}", merged.text());
    assert_eq!(preset_ids(&merged), ["two", "one"]);

    let options = request(
        &mut client,
        &api("OPTIONS", "/api/run-config/presets", &[LOCAL], ""),
    );
    assert_eq!(options.status, 200);
    assert_eq!(options.header("allow"), Some("GET,HEAD,PUT"));
    assert_eq!(options.text(), "GET,HEAD,PUT");
    assert_no_node_connection(&gateway);
}

#[test]
fn run_config_presets_refuse_bad_bodies_like_express_did() {
    let gateway = Gateway::start("presets-bad", "echo", &[]);
    let mut client = gateway.connect();
    let not_json = request(
        &mut client,
        &api(
            "PUT",
            "/api/run-config/presets",
            &[LOCAL, ("Content-Type", "text/plain")],
            "{}",
        ),
    );
    assert_eq!(not_json.status, 400);
    assert_eq!(
        not_json.text(),
        r#"{"error":"presets 必须是数组","code":"invalid_presets"}"#
    );
    let too_many: Vec<(String, i64)> = (0..101).map(|i| (format!("p{i}"), i)).collect();
    let too_many: Vec<(&str, i64)> = too_many.iter().map(|(id, at)| (id.as_str(), *at)).collect();
    let refused = request(
        &mut client,
        &api(
            "PUT",
            "/api/run-config/presets",
            &[LOCAL, JSON_TYPE],
            &presets_body(&too_many),
        ),
    );
    assert_eq!(refused.status, 400);
    assert_eq!(refused.json()["error"], "presets 最多 100 条");
    for broken in ["{\"presets\":", "\"text\""] {
        let malformed = request(
            &mut client,
            &api(
                "PUT",
                "/api/run-config/presets",
                &[LOCAL, JSON_TYPE],
                broken,
            ),
        );
        assert_eq!(malformed.status, 400, "{broken}");
        let body = malformed.json();
        assert_eq!(body["ok"], false);
        assert_eq!(body["error"], "request_error");
        assert_eq!(body["code"], "request_error");
        assert_eq!(body["apiVersion"], "v1");
        assert_eq!(
            body["requestId"].as_str(),
            malformed.header("x-multicc-request-id")
        );
    }
    assert!(!gateway.dir.join("run-config-presets.json").exists());
    assert_no_node_connection(&gateway);
}

#[test]
fn the_native_auth_gate_refuses_like_the_node_one() {
    let gateway = Gateway::start(
        "presets-auth",
        "echo",
        &[("ACCESS_TOKEN", "secret-token-1".to_string())],
    );
    let mut client = gateway.connect();
    let remote_host = ("Host", "box.example.com");
    let refused = request(
        &mut client,
        &api("GET", "/api/run-config/presets", &[remote_host], ""),
    );
    assert_eq!(refused.status, 403);
    let body = refused.json();
    assert_eq!(body["code"], "AUTH_REQUIRED");
    assert_eq!(body["error"], "Forbidden: not authenticated");
    assert_eq!(body["action"], "login");

    let html = request(
        &mut client,
        &api(
            "GET",
            "/api/run-config/presets?x=1",
            &[remote_host, ("Accept", "text/html,*/*;q=0.8")],
            "",
        ),
    );
    assert_eq!(html.status, 302);
    let location = "/login?redirect=%2Fapi%2Frun-config%2Fpresets%3Fx%3D1";
    assert_eq!(html.header("location"), Some(location));
    assert_eq!(
        html.text(),
        format!("<p>Found. Redirecting to {location}</p>")
    );

    let token = request(
        &mut client,
        &api(
            "GET",
            "/api/run-config/presets",
            &[remote_host, ("X-Access-Token", "secret-token-1")],
            "",
        ),
    );
    assert_eq!(token.status, 200, "{}", token.text());
    // A loopback peer with a local Host needs no credential, as in Node.
    let local = request(
        &mut client,
        &api("GET", "/api/run-config/presets", &[LOCAL], ""),
    );
    assert_eq!(local.status, 200);
    // A forwarding header makes even a loopback peer remote.
    let forwarded = request(
        &mut client,
        &api(
            "GET",
            "/api/run-config/presets",
            &[LOCAL, ("X-Forwarded-For", "1.2.3.4")],
            "",
        ),
    );
    assert_eq!(forwarded.status, 403);
    assert_no_node_connection(&gateway);
}

#[test]
fn live_token_rotation_applies_without_env_file_guessing_or_inheritance() {
    let gateway = Gateway::start_files(
        "presets-token",
        "echo",
        &[],
        &[(
            ".env",
            "ACCESS_TOKEN=old-token-1\nFIXTURE_DOTENV_ONLY=1\n".to_string(),
        )],
        false,
    );
    let mut client = gateway.connect();
    let remote = |token: &str| {
        api(
            "GET",
            "/api/run-config/presets",
            &[("Host", "box.example.com"), ("X-Access-Token", token)],
            "",
        )
    };
    assert_eq!(request(&mut client, &remote("old-token-1")).status, 200);
    // What POST /api/settings/access-token does: rewrite .env, swap memory.
    fs::write(
        gateway.dir.join(".env"),
        "ACCESS_TOKEN=new-token-2\nFIXTURE_DOTENV_ONLY=1\n",
    )
    .unwrap();
    // A persisted write alone is not a successful live state transition.
    assert_eq!(request(&mut client, &remote("old-token-1")).status, 200);
    assert_eq!(
        request(
            &mut client,
            &api("POST", "/fixture/rotate", &[LOCAL], "new-token-2")
        )
        .status,
        200
    );
    assert_eq!(request(&mut client, &remote("old-token-1")).status, 403);
    assert_eq!(request(&mut client, &remote("new-token-2")).status, 200);

    // Node reads .env itself; inheriting the front door's copy would make a
    // relaunched Node keep the old token.
    let env = request(&mut client, &get("/env"));
    assert_eq!(env.status, 200, "{}", gateway.log());
    let env = env.json();
    assert_eq!(env["FIXTURE_DOTENV_ONLY"], Value::Null);
    assert_eq!(env["PORT"], gateway.port.to_string());
}

#[test]
fn a_large_preset_list_is_gzipped_for_clients_that_accept_it() {
    let gateway = Gateway::start("presets-gzip", "echo", &[]);
    let mut client = gateway.connect();
    let ids: Vec<(String, i64)> = (0..20)
        .map(|i| (format!("preset-{i:02}"), 100 + i))
        .collect();
    let ids: Vec<(&str, i64)> = ids.iter().map(|(id, at)| (id.as_str(), *at)).collect();
    let put = request(
        &mut client,
        &api(
            "PUT",
            "/api/run-config/presets",
            &[LOCAL, JSON_TYPE],
            &presets_body(&ids),
        ),
    );
    assert_eq!(put.status, 200, "{}", put.text());
    let plain = put.body.clone();
    assert!(plain.len() >= 1024, "{}", plain.len());
    let gzipped = request(
        &mut client,
        &api(
            "GET",
            "/api/run-config/presets",
            &[LOCAL, ("Accept-Encoding", "gzip, deflate, br")],
            "",
        ),
    );
    assert_eq!(gzipped.header("content-encoding"), Some("gzip"));
    let mut decoded = Vec::new();
    flate2::read::GzDecoder::new(&gzipped.body[..])
        .read_to_end(&mut decoded)
        .unwrap();
    assert_eq!(decoded, plain);
}

#[test]
fn other_methods_on_a_native_path_still_reach_node() {
    let gateway = Gateway::start("presets-other", "echo", &[]);
    let mut client = gateway.connect();
    let response = request(
        &mut client,
        &api("POST", "/api/run-config/presets", &[LOCAL], ""),
    );
    assert_eq!(response.status, 200, "{}", gateway.log());
    assert_eq!(response.text(), "ok");
    gateway.wait_for_state("the forwarded request", |g| !g.connections().is_empty());
}

// ── the download link (§9) ──────────────────────────────────────────────────

/// `encodeURIComponent`.
fn enc(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn get_path(client: &mut TcpStream, path: &str, extra: &[(&str, &str)]) -> HttpResponse {
    let mut headers = vec![LOCAL];
    headers.extend_from_slice(extra);
    let url = format!("/api/download?path={}", enc(path));
    request(client, &api("GET", &url, &headers, ""))
}

// Ported from the Node route tests (tests/test-file-transfer-routes.js) plus
// the Express sendFile/download behavior they relied on.
#[test]
fn downloads_are_answered_by_the_front_door_like_express() {
    let gateway = Gateway::start("download", "echo", &[]);
    let home = gateway.dir.join("home");
    fs::create_dir_all(&home).unwrap();
    let file = home.join("file.txt");
    fs::write(&file, "data").unwrap();
    let file = file.to_str().unwrap().to_string();
    let mut client = gateway.connect();

    let r = request(&mut client, &api("GET", "/api/download", &[LOCAL], ""));
    assert_eq!(
        (r.status, r.text().as_str()),
        (400, r#"{"error":"path required"}"#)
    );
    let r = get_path(&mut client, home.to_str().unwrap(), &[]);
    assert_eq!(
        (r.status, r.text().as_str()),
        (400, r#"{"error":"不能下载目录"}"#)
    );
    let r = get_path(&mut client, &format!("{}/missing", home.display()), &[]);
    assert_eq!(
        (r.status, r.text().as_str()),
        (404, r#"{"error":"文件不存在"}"#)
    );

    // inline=1 → res.sendFile; otherwise res.download.
    let url = format!("/api/download?path={}&inline=1", enc(&file));
    let inline = request(&mut client, &api("GET", &url, &[LOCAL], ""));
    assert_eq!(
        (inline.status, inline.text().as_str()),
        (200, "data"),
        "{}",
        gateway.log()
    );
    assert_eq!(
        inline.header("content-type"),
        Some("text/plain; charset=UTF-8")
    );
    assert_eq!(inline.header("accept-ranges"), Some("bytes"));
    assert_eq!(inline.header("cache-control"), Some("public, max-age=0"));
    assert_eq!(inline.header("content-length"), Some("4"));
    assert!(inline.header("last-modified").unwrap().ends_with(" GMT"));
    assert!(inline.header("content-disposition").is_none());
    let etag = inline.header("etag").unwrap().to_string();
    assert!(etag.starts_with("W/\"4-"), "{etag}");
    let attached = get_path(&mut client, &file, &[]);
    assert_eq!(
        attached.header("content-disposition"),
        Some("attachment; filename=\"file.txt\"")
    );

    // Conditional and range requests (send's rules; golden-tested in core).
    let not_modified = get_path(&mut client, &file, &[("If-None-Match", &etag)]);
    assert_eq!(not_modified.status, 304);
    assert!(not_modified.header("content-type").is_none());
    let partial = get_path(&mut client, &file, &[("Range", "bytes=1-2")]);
    assert_eq!((partial.status, partial.text().as_str()), (206, "at"));
    assert_eq!(partial.header("content-range"), Some("bytes 1-2/4"));
    // 416 goes through safeErrorHandler, which keeps send's headers.
    let unsatisfiable = get_path(&mut client, &file, &[("Range", "bytes=9-")]);
    assert_eq!(unsatisfiable.status, 416);
    assert_eq!(unsatisfiable.header("content-range"), Some("bytes */4"));
    assert_eq!(
        unsatisfiable.header("content-type"),
        Some("text/plain; charset=utf-8")
    );
    assert_eq!(unsatisfiable.header("etag"), Some(etag.as_str()));
    assert_eq!(unsatisfiable.json()["code"], "request_error");
    let mut head_client = gateway.connect();
    head_client
        .write_all(&api(
            "HEAD",
            &format!("/api/download?path={}", enc(&file)),
            &[LOCAL],
            "",
        ))
        .unwrap();
    let head = read_response_head(&mut head_client);
    assert_eq!(
        (head.status, head.header("content-length")),
        (200, Some("4"))
    );

    // A repeated path is an array to qs: the handler's `.trim()` throws.
    let url = format!("/api/download?path={0}&path={0}", enc(&file));
    let twice = request(&mut client, &api("GET", &url, &[LOCAL], ""));
    assert_eq!(
        (twice.status, twice.json()["error"].as_str()),
        (500, Some("internal_error"))
    );

    // The legacy dotfile rule: a file name starting with '.' is a 404.
    let hidden = home.join(".hidden");
    fs::write(&hidden, "x").unwrap();
    let r = get_path(&mut client, hidden.to_str().unwrap(), &[]);
    assert_eq!(
        (r.status, r.json()["error"].as_str()),
        (404, Some("request_error"))
    );

    // Non-latin1 names get the latin1 fallback plus filename*.
    let cjk = home.join("中文 名.png");
    fs::write(&cjk, "png").unwrap();
    let r = get_path(&mut client, cjk.to_str().unwrap(), &[]);
    assert_eq!(r.header("content-type"), Some("image/png"));
    assert_eq!(
        r.header("content-disposition"),
        Some("attachment; filename=\"?? ?.png\"; filename*=UTF-8''%E4%B8%AD%E6%96%87%20%E5%90%8D.png")
    );
    assert_no_node_connection(&gateway);
}

#[test]
fn percent_encoded_download_paths_are_retried_once_decoded() {
    let gateway = Gateway::start("download-decode", "echo", &[]);
    let home = gateway.dir.join("home");
    fs::create_dir_all(&home).unwrap();
    let name = "社媒触达 照片墙.png";
    fs::write(home.join(name), "png").unwrap();
    let mut client = gateway.connect();
    let encoded = format!("{}/{}", home.display(), enc(name));
    let r = get_path(&mut client, &encoded, &[]);
    assert_eq!(
        (r.status, r.text().as_str()),
        (200, "png"),
        "{}",
        gateway.log()
    );

    // A name that literally contains %XX is served as-is, never decoded.
    fs::write(home.join("a%20b.png"), "x").unwrap();
    fs::write(home.join("a b.png"), "y").unwrap();
    let r = get_path(&mut client, &format!("{}/a%20b.png", home.display()), &[]);
    assert_eq!(r.text(), "x");
    // Malformed escapes and still-missing targets stay a plain 404.
    let r = get_path(&mut client, &format!("{}/100%.png", home.display()), &[]);
    assert_eq!(r.status, 404);
    let r = get_path(
        &mut client,
        &format!("{}/%E7%A4%BE.png", home.display()),
        &[],
    );
    assert_eq!(r.status, 404);
}

#[test]
fn a_download_ticket_opens_one_file_for_a_remote_client() {
    let token = "secret-token-1";
    let gateway = Gateway::start("ticket", "echo", &[("ACCESS_TOKEN", token.to_string())]);
    let home = gateway.dir.join("home");
    fs::create_dir_all(&home).unwrap();
    let file = home.join("a b.txt");
    fs::write(&file, "ticketed").unwrap();
    let file = file.to_str().unwrap().to_string();
    let remote = ("Host", "box.example.com");
    let mut client = gateway.connect();

    let r = request(
        &mut client,
        &api(
            "GET",
            &format!("/api/download?path={}", enc(&file)),
            &[remote],
            "",
        ),
    );
    assert_eq!(r.status, 403, "{}", gateway.log());
    let body = format!(
        r#"{{"path":{},"inline":true}}"#,
        serde_json::to_string(&file).unwrap()
    );
    let r = request(
        &mut client,
        &api(
            "POST",
            "/api/auth/download-ticket",
            &[remote, JSON_TYPE],
            &body,
        ),
    );
    assert_eq!(r.status, 403, "issuing needs the normal auth");

    let issued = request(
        &mut client,
        &api(
            "POST",
            "/api/auth/download-ticket",
            &[remote, JSON_TYPE, ("X-Access-Token", token)],
            &body,
        ),
    );
    assert_eq!(issued.status, 200, "{}", issued.text());
    assert_eq!(issued.header("cache-control"), Some("no-store"));
    let issued = issued.json();
    let ticket = issued["ticket"].as_str().unwrap().to_string();
    assert_eq!(ticket.len(), 32);
    let target = issued["target"].as_str().unwrap().to_string();
    let expected_query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("path", &file)
        .append_pair("inline", "1")
        .finish();
    assert_eq!(target, format!("/api/download?{expected_query}"));
    assert!(issued["expiresAt"].as_i64().unwrap() > 0);

    let url = format!("{target}&download_ticket={ticket}");
    for _ in 0..2 {
        let r = request(&mut client, &api("GET", &url, &[remote], ""));
        assert_eq!(
            (r.status, r.text().as_str()),
            (200, "ticketed"),
            "reusable within its TTL"
        );
    }
    let other = format!(
        "/api/download?path={}&download_ticket={ticket}",
        enc("/etc/hosts")
    );
    assert_eq!(
        request(&mut client, &api("GET", &other, &[remote], "")).status,
        403
    );
    let mut head_client = gateway.connect();
    head_client
        .write_all(&api("HEAD", &url, &[remote], ""))
        .unwrap();
    assert_eq!(
        read_response_head(&mut head_client).status,
        403,
        "HEAD never uses a ticket"
    );

    let authed = [remote, JSON_TYPE, ("X-Access-Token", token)];
    let r = request(
        &mut client,
        &api("POST", "/api/auth/download-ticket", &authed, "{}"),
    );
    assert_eq!(
        (r.status, r.text().as_str()),
        (400, r#"{"error":"invalid download target"}"#)
    );
    let big = format!(r#"{{"path":"{}"}}"#, "x".repeat(5000));
    let r = request(
        &mut client,
        &api("POST", "/api/auth/download-ticket", &authed, &big),
    );
    assert_eq!(r.status, 413, "the route's own 4kb parser");
    assert_no_node_connection(&gateway);
}

#[test]
fn upload_temp_files_are_counted_and_cleaned_by_the_front_door() {
    let tmp = unique("uploads-tmp");
    fs::create_dir_all(tmp.join("multicc_dir")).unwrap();
    fs::write(tmp.join("multicc_two"), "12345").unwrap();
    fs::write(tmp.join("multicc_one"), "123").unwrap();
    fs::write(tmp.join("foreign"), "ignored").unwrap();
    // os.tmpdir() uses TEMP on Windows and TMPDIR on Unix, dropping one
    // trailing platform separator.
    let with_separator = format!("{}{}", tmp.display(), std::path::MAIN_SEPARATOR);
    let gateway = Gateway::start(
        "uploads",
        "echo",
        &[
            ("TMPDIR", with_separator.clone()),
            ("TEMP", with_separator.clone()),
            ("TMP", with_separator),
        ],
    );
    let mut client = gateway.connect();
    let stats = request(&mut client, &api("GET", "/api/uploads/stats", &[LOCAL], ""));
    assert_eq!(stats.status, 200, "{}", gateway.log());
    let stats = stats.json();
    assert_eq!(stats["count"], 2);
    assert_eq!(stats["totalSize"], 8);
    assert_eq!(stats["dir"], tmp.to_str().unwrap());
    let names: Vec<_> = stats["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|file| file["name"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(
        names,
        ["multicc_one", "multicc_two"],
        "readdir order is strcmp order"
    );
    assert!(stats["files"][0]["mtime"].as_str().unwrap().ends_with('Z'));

    let r = request(
        &mut client,
        &api("DELETE", "/api/uploads/cleanup", &[LOCAL], ""),
    );
    assert_eq!(r.text(), r#"{"deleted":2,"freed":8}"#);
    assert!(tmp.join("foreign").exists() && tmp.join("multicc_dir").exists());
    let r = request(
        &mut client,
        &api("OPTIONS", "/api/uploads/cleanup", &[LOCAL], ""),
    );
    assert_eq!(
        (r.header("allow"), r.text().as_str()),
        (Some("DELETE"), "DELETE")
    );
    assert_no_node_connection(&gateway);
    let _ = fs::remove_dir_all(tmp);
}

#[test]
fn quota_guard_settings_keep_auth_http_and_matching_contracts() {
    let gateway = Gateway::start(
        "quota-http",
        "echo",
        &[("ACCESS_TOKEN", "quota-token".into())],
    );
    let route = "/api/settings/quota-guard";
    let mut client = gateway.connect();
    let refused = request(
        &mut client,
        &api("GET", route, &[("Host", "outside.example")], ""),
    );
    assert_eq!(refused.status, 403);
    assert_eq!(refused.json()["code"], "AUTH_REQUIRED");
    let authorized = [
        ("Host", "outside.example"),
        ("X-Access-Token", "quota-token"),
    ];
    let saved = request(
        &mut client,
        &api("GET", "/api/Settings/Quota-Guard/", &authorized, ""),
    );
    assert_eq!(saved.status, 200);
    assert_eq!(saved.json()["config"]["weeklyPercent"], 98);
    client
        .write_all(&api("HEAD", route, &authorized, ""))
        .unwrap();
    let head = read_response_head(&mut client);
    assert_eq!(head.status, 200);
    assert_eq!(head.header("etag"), saved.header("etag"));
    assert_eq!(
        head.header("content-length"),
        saved.header("content-length")
    );
    let options = request(&mut client, &api("OPTIONS", route, &authorized, ""));
    assert_eq!(options.text(), "GET,HEAD,PUT");
    assert_eq!(options.header("allow"), Some("GET,HEAD,PUT"));
    let invalid = request(&mut client, &api("PUT", route, &[LOCAL, JSON_TYPE], "{bad"));
    assert_eq!(invalid.status, 400);
    assert!(!gateway.dir.join("quota-guard.json").exists());
    assert_no_node_connection(&gateway);
    // Unsupported methods retain the same fallback behavior as other groups.
    let forwarded = request(&mut client, &api("POST", route, &[LOCAL], ""));
    assert_eq!(forwarded.status, 200);
    assert_eq!(gateway.requests().len(), 1);
}
