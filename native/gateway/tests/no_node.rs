//! `serve --no-node`: the front door runs with no Node child at all.
//!
//! These tests start the real `multicc-gateway` binary with an empty `PATH`
//! (nothing named `node` is reachable), `--no-node --ephemeral-loopback`, and
//! prove the frozen contract (docs/gateway.md §8.1):
//!
//! * the process stays up and logs the listening port;
//! * a Rust-owned route that needs no host port answers 200;
//! * a claimed Rust route that needs the authentication snapshot (owned by the
//!   Node child) fails closed at once with 503 `node_runtime_absent`, naming
//!   the missing auth state rather than the forwarded-route text;
//! * every request that would have gone to Node fails closed, immediately,
//!   with 503 `node_runtime_absent` — ordinary HTTP and WebSocket upgrades;
//! * a route that needs the Node host port fails at once with its existing
//!   503 `rust_backend_unavailable` shape;
//! * SIGINT/SIGTERM (and the stdin lifeline) stop it with exit code 0;
//! * `--node` and `--no-node` are mutually exclusive and one of them is
//!   mandatory (exit code 2 with the documented text).

use std::fs;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const GATEWAY_BIN: &str = env!("CARGO_BIN_EXE_multicc-gateway");

const NODE_ABSENT_BODY: &str = concat!(
    r#"{"error":"This route is served by the Node runtime, which this front door was started without (--no-node).","#,
    r#""code":"node_runtime_absent"}"#
);
/// A claimed route still needs the authentication snapshot, and that state is
/// held by the Node child; the refusal says so instead of pretending the
/// request would have been forwarded.
const AUTH_ABSENT_BODY: &str = concat!(
    r#"{"error":"Authentication state is held by the Node runtime, which this front door was started without (--no-node).","#,
    r#""code":"node_runtime_absent"}"#
);
const MISSING_RUNTIME: &str = "[multicc-gateway] serve needs --no-node (Rust-only, unmigrated routes fail closed) or --node <node executable>";

fn unique(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "multicc-gateway-no-node-{}-{tag}-{nanos}",
        std::process::id()
    ))
}

/// Windows needs its system variables even in a cleared environment (Winsock
/// reads SystemRoot, and the CRT reads TEMP/TMP); none of them exist elsewhere.
const WINDOWS_ENV: &[&str] = &[
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
];

struct Gateway {
    dir: PathBuf,
    port: u16,
    child: Child,
}

impl Gateway {
    fn start(tag: &str) -> Self {
        Self::start_with(tag, false)
    }

    fn start_with(tag: &str, stdin_lifeline: bool) -> Self {
        let dir = unique(tag);
        // The `--no-node` runtime still derives its package root from
        // `<cwd>/server.js`; the file only needs to exist for that.
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("server.js"), "").unwrap();
        let home = dir.join("home");
        let empty_path = dir.join("empty-path");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&empty_path).unwrap();
        let log = fs::File::create(dir.join("gateway.log")).unwrap();
        let mut command = Command::new(GATEWAY_BIN);
        command
            .arg("serve")
            .arg("--cwd")
            .arg(&dir)
            .arg("--no-node")
            .arg("--ephemeral-loopback")
            .env_clear()
            // No directory named `node` is reachable from this PATH.
            .env("PATH", &empty_path)
            .env("HOME", &home)
            .env("TMPDIR", &home)
            .env("MULTICC_GATEWAY_TEST_ROUTES", "1")
            .stdin(if stdin_lifeline {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::null())
            .stderr(Stdio::from(log));
        if stdin_lifeline {
            command.arg("--stdin-lifeline");
        }
        for key in WINDOWS_ENV {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        let child = command.spawn().expect("spawn multicc-gateway --no-node");
        let deadline = Instant::now() + Duration::from_secs(20);
        let port = loop {
            if let Some(found) = parse_listening(&Self::read_log(&dir)) {
                break found;
            }
            assert!(
                Instant::now() < deadline,
                "gateway never logged a listening port\n--- log ---\n{}",
                Self::read_log(&dir)
            );
            std::thread::sleep(Duration::from_millis(20));
        };
        Gateway { dir, port, child }
    }

    fn read_log(dir: &Path) -> String {
        fs::read_to_string(dir.join("gateway.log")).unwrap_or_default()
    }

    fn log(&self) -> String {
        Self::read_log(&self.dir)
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

    fn request(&self, request: &str) -> Response {
        let mut client = self.connect();
        client.write_all(request.as_bytes()).unwrap();
        let mut raw = Vec::new();
        client.read_to_end(&mut raw).unwrap();
        Response::parse(&raw)
    }

    fn get(&self, path: &str) -> Response {
        self.request(&format!(
            "GET {path} HTTP/1.1\r\nHost: test\r\nConnection: close\r\n\r\n"
        ))
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

    fn header(&self, name: &str) -> Option<String> {
        self.header_text.lines().skip(1).find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.trim()
                .eq_ignore_ascii_case(name)
                .then(|| value.trim().to_string())
        })
    }
}

fn assert_node_absent(response: &Response, what: &str) {
    assert_eq!(response.status, 503, "{what}: {}", response.text());
    assert_eq!(
        response.header("content-type").as_deref(),
        Some("application/json"),
        "{what}: content type"
    );
    assert_eq!(
        response.header("connection").as_deref(),
        Some("close"),
        "{what}: the client connection must be closed and not reused"
    );
    assert_eq!(response.text(), NODE_ABSENT_BODY, "{what}: body");
}

#[test]
fn a_no_node_front_door_serves_rust_routes_and_fails_node_routes_closed() {
    let gateway = Gateway::start("serve");
    let log = gateway.log();
    assert!(
        log.contains(
            "node runtime disabled (--no-node): routes not owned by Rust answer 503 node_runtime_absent"
        ),
        "missing the documented log line:\n{log}"
    );
    assert!(
        !log.contains("node started"),
        "no child may be spawned:\n{log}"
    );

    // Rust-owned, does not need the host port.
    let native = gateway.get("/__gateway_test/native");
    assert_eq!(native.status, 200, "{}", native.text());
    assert_eq!(
        native.text(),
        "multicc-gateway: answered by the rust front door\n"
    );

    // Ordinary HTTP that the router would forward to Node.
    assert_node_absent(&gateway.get("/api/not-owned-by-rust"), "http fallback");

    // The same request as a WebSocket upgrade: still refused immediately.
    let upgrade = gateway.request(
        "GET /ws/meta HTTP/1.1\r\nHost: test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\
         Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
    );
    assert_node_absent(&upgrade, "websocket upgrade");

    // Nothing was ever spawned, so the process is still alive.
    assert!(!log.contains("cannot start"));
}

#[test]
fn a_claimed_route_that_needs_the_node_auth_runtime_fails_closed_at_once() {
    let gateway = Gateway::start("auth-runtime");
    // A real native claim (`app::claim`) that runs after the auth snapshot.
    let started = Instant::now();
    let response = gateway.get("/api/claude/models");
    let elapsed = started.elapsed();
    assert_eq!(response.status, 503, "{}", response.text());
    assert_eq!(
        response.header("content-type").as_deref(),
        Some("application/json"),
        "auth-runtime refusal: content type"
    );
    assert_eq!(
        response.header("connection").as_deref(),
        Some("close"),
        "auth-runtime refusal: the client connection must be closed"
    );
    assert_eq!(
        response.text(),
        AUTH_ABSENT_BODY,
        "auth-runtime refusal: body"
    );
    assert!(
        elapsed < Duration::from_secs(1),
        "the auth-runtime refusal took {elapsed:?}; it must not wait for the 3s control-stream timeout"
    );
}

#[test]
fn a_host_port_route_fails_at_once_instead_of_waiting_for_the_budget() {
    let gateway = Gateway::start("host-port");
    let started = Instant::now();
    let response = gateway.get("/__gateway_test/host-port");
    let elapsed = started.elapsed();
    assert_eq!(response.status, 503, "{}", response.text());
    assert!(
        response
            .text()
            .contains("\"code\":\"rust_backend_unavailable\""),
        "host-port routes keep their existing shape: {}",
        response.text()
    );
    assert!(
        elapsed < Duration::from_secs(2),
        "host-port call took {elapsed:?}; it must not wait for the 60s budget"
    );
}

#[cfg(unix)]
#[test]
fn sigterm_stops_a_no_node_front_door_with_exit_code_zero() {
    let mut gateway = Gateway::start("sigterm");
    // Make sure it is actually serving before signalling.
    let _ = gateway.get("/__gateway_test/native");
    let pid = gateway.child.id() as libc::pid_t;
    assert_eq!(unsafe { libc::kill(pid, libc::SIGTERM) }, 0);
    let status = gateway
        .wait_exit(Duration::from_secs(10))
        .expect("gateway should exit on SIGTERM");
    assert_eq!(status.code(), Some(0), "SIGTERM must exit 0");
}

#[test]
fn closing_the_stdin_lifeline_stops_a_no_node_front_door_with_exit_code_zero() {
    let mut gateway = Gateway::start_with("stdin-lifeline", true);
    let _ = gateway.get("/__gateway_test/native");
    drop(gateway.child.stdin.take());
    let status = gateway
        .wait_exit(Duration::from_secs(10))
        .expect("gateway should exit when its stdin lifeline closes");
    assert_eq!(status.code(), Some(0), "stdin EOF must exit 0");
    assert!(
        gateway
            .log()
            .contains("stdin closed by our parent; no node to stop"),
        "missing the no-node lifeline log line:\n{}",
        gateway.log()
    );
}

fn run_gateway(args: &[&str], dir: &Path) -> (ExitStatus, String) {
    let mut command = Command::new(GATEWAY_BIN);
    // `--cwd` must come before any bare script token, which ends option
    // parsing: `serve --cwd <dir> <rest…>`.
    match args.split_first() {
        Some((subcommand, rest)) => {
            command.arg(subcommand).arg("--cwd").arg(dir).args(rest);
        }
        None => {
            command.args(args);
        }
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let output = command.output().expect("run multicc-gateway");
    (
        output.status,
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

#[test]
fn the_runtime_mode_must_be_exactly_one_of_node_and_no_node() {
    let dir = unique("cli");
    fs::create_dir_all(&dir).unwrap();

    let (status, stderr) = run_gateway(&["serve"], &dir);
    assert_eq!(status.code(), Some(2), "neither mode: {stderr}");
    assert!(
        stderr.contains(MISSING_RUNTIME),
        "neither mode must print the documented text: {stderr}"
    );

    let (status, stderr) = run_gateway(&["serve", "--no-node", "--node", "node"], &dir);
    assert_eq!(status.code(), Some(2), "both modes: {stderr}");
    assert!(
        stderr.contains("not both"),
        "both modes must name the conflict: {stderr}"
    );

    let (status, stderr) = run_gateway(&["serve", "--no-node", "server.js"], &dir);
    assert_eq!(status.code(), Some(2), "--no-node with a script: {stderr}");
    assert!(
        stderr.contains("takes no script or arguments"),
        "--no-node must reject script arguments: {stderr}"
    );

    let _ = fs::remove_dir_all(&dir);
}
