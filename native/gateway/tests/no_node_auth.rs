//! `serve --no-node` owns the authentication runtime itself when `.env`
//! supplies a usable `ACCESS_TOKEN` (docs/gateway.md §8.1).
//!
//! These tests start the real `multicc-gateway` binary with an empty `PATH`
//! (nothing named `node` is reachable) and `--no-node --ephemeral-loopback`.
//! With a token, a native route that needs the snapshot must behave exactly
//! like it does under `--node` (measured against
//! `native/gateway/tests/fixtures/upstream.js`: the same 403
//! `AUTH_REQUIRED` / 200 shapes). With no token, or one the private protocol
//! cannot represent, the old 503 `node_runtime_absent` refusal stays and a
//! diagnostic line is written to stderr.

use std::fs;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
#[cfg(unix)]
use std::process::ExitStatus;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::Value;

const GATEWAY_BIN: &str = env!("CARGO_BIN_EXE_multicc-gateway");

const NODE_ABSENT_BODY: &str = concat!(
    r#"{"error":"This route is served by the Node runtime, which this front door was started without (--no-node).","#,
    r#""code":"node_runtime_absent"}"#
);
/// No Node child and no usable local token: the snapshot has no owner.
const AUTH_ABSENT_BODY: &str = concat!(
    r#"{"error":"Authentication state is held by the Node runtime, which this front door was started without (--no-node).","#,
    r#""code":"node_runtime_absent"}"#
);
const TOKEN: &str = "local-secret-123";

fn unique(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "multicc-gateway-no-node-auth-{}-{tag}-{nanos}",
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
    /// Starts a `--no-node` front door. `dotenv` is written to `<cwd>/.env`
    /// (the file `server.js` used to read) before start.
    fn start(tag: &str, dotenv: Option<&str>, extra: &[(&str, &str)]) -> Self {
        let dir = unique(tag);
        fs::create_dir_all(&dir).unwrap();
        // The `--no-node` runtime derives its package root from
        // `<cwd>/server.js`; the file only needs to exist for that.
        fs::write(dir.join("server.js"), "").unwrap();
        if let Some(dotenv) = dotenv {
            fs::write(dir.join(".env"), dotenv).unwrap();
        }
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
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::from(log));
        for (key, value) in extra {
            command.env(key, value);
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

    /// `Host: test` is not a local host, so every request below is judged as a
    /// non-loopback client even though the socket is loopback (the same rule
    /// `--node` applies to the PROXY line's address).
    fn get(&self, path: &str, headers: &[(&str, &str)]) -> Response {
        self.request(&api("GET", path, headers, ""))
    }

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

impl Drop for Gateway {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn api(method: &str, path: &str, headers: &[(&str, &str)], body: &str) -> String {
    // `Connection: close` lets `read_to_end` observe the end of the response.
    let mut raw = format!("{method} {path} HTTP/1.1\r\nHost: test\r\nConnection: close\r\n");
    for (name, value) in headers {
        raw.push_str(&format!("{name}: {value}\r\n"));
    }
    if !body.is_empty() || method == "POST" || method == "PUT" {
        raw.push_str(&format!("Content-Length: {}\r\n", body.len()));
    }
    raw.push_str("\r\n");
    raw.push_str(body);
    raw
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

    fn json(&self) -> Value {
        serde_json::from_slice(&self.body)
            .unwrap_or_else(|error| panic!("not JSON ({error}): {}", self.text()))
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
    assert_eq!(response.text(), NODE_ABSENT_BODY, "{what}: body");
}

fn assert_auth_required(response: &Response, what: &str) {
    assert_eq!(response.status, 403, "{what}: {}", response.text());
    let body: Value = response.json();
    assert_eq!(body["code"], "AUTH_REQUIRED", "{what}: {body}");
    assert!(
        !response.text().contains("node_runtime_absent"),
        "{what}: a local runtime must answer, not refuse: {}",
        response.text()
    );
}

#[test]
fn a_local_access_token_answers_the_same_auth_shapes_as_node() {
    let gateway = Gateway::start("local-token", Some(&format!("ACCESS_TOKEN={TOKEN}\n")), &[]);
    let log = gateway.log();
    assert!(
        log.contains("authentication runtime owned locally (--no-node)"),
        "missing the local-runtime log line:\n{log}"
    );

    // (a) No credential: the same 403 `AUTH_REQUIRED` the `--node` fixture
    // answers for this route (measured 2026-11-16), not a runtime-absent 503.
    let unauthenticated = gateway.get("/api/claude/models", &[]);
    assert_auth_required(&unauthenticated, "no credential");

    // (b) The right token opens a route that only needed the snapshot.
    let authorized = gateway.get("/api/claude/models", &[("X-Access-Token", TOKEN)]);
    assert_eq!(authorized.status, 200, "{}", authorized.text());
    assert_eq!(authorized.json()["source"], "fallback");
    assert!(
        authorized.json()["models"]
            .as_array()
            .is_some_and(|m| !m.is_empty()),
        "expected the model list: {}",
        authorized.text()
    );

    // (c) A wrong token is refused exactly like no credential, and the reply
    // never echoes either token.
    let wrong = gateway.get("/api/claude/models", &[("X-Access-Token", "wrong-token")]);
    assert_auth_required(&wrong, "wrong credential");
    assert!(!wrong.text().contains(TOKEN));
    assert!(!wrong.text().contains("wrong-token"));

    // (d) The WS-ticket route mints from the local table. The ticket branch is
    // the same `auth.rs` handler (`Reply::Ticket`) a `--node` front door runs;
    // the protocol-only upstream fixture answers every issue op with `invalid`,
    // so only the local side can exercise the success shape here.
    let ticket = gateway.request(&api(
        "POST",
        "/api/auth/ws-ticket",
        &[
            ("Content-Type", "application/json"),
            ("X-Access-Token", TOKEN),
        ],
        r#"{"path":"/ws/meta"}"#,
    ));
    assert_eq!(ticket.status, 200, "{}", ticket.text());
    assert_eq!(ticket.header("cache-control").as_deref(), Some("no-store"));
    let body = ticket.json();
    assert_eq!(body["ticket"].as_str().map(str::len), Some(32));
    assert_eq!(body["path"], "/ws/meta");
    assert!(body["expiresAt"].as_f64().is_some_and(|at| at > 0.0));

    // Without the credential the ticket route is still refused.
    let denied_ticket = gateway.request(&api(
        "POST",
        "/api/auth/ws-ticket",
        &[("Content-Type", "application/json")],
        r#"{"path":"/ws/meta"}"#,
    ));
    assert_auth_required(&denied_ticket, "ws-ticket without credential");

    // (e) The fail-closed shapes for everything that still needs Node.
    assert_node_absent(
        &gateway.get("/api/not-owned-by-rust", &[]),
        "forwarded route",
    );
    let host_port = gateway.get("/__gateway_test/host-port", &[]);
    assert_eq!(host_port.status, 503, "{}", host_port.text());
    assert!(
        host_port
            .text()
            .contains("\"code\":\"rust_backend_unavailable\""),
        "host-port shape changed: {}",
        host_port.text()
    );
}

#[cfg(unix)]
#[test]
fn sigterm_stops_a_local_runtime_with_exit_code_zero() {
    // The stop path first publishes `shutting_down` to the local snapshot,
    // then stops accepting and exits. A request that reaches the router in
    // that window answers 503 SERVER_SHUTTING_DOWN, but the process exits
    // immediately after, so a black-box client cannot reliably get scheduled
    // into it; the flag itself is covered by the `auth_control` unit test.
    let mut gateway = Gateway::start(
        "sigterm-local",
        Some(&format!("ACCESS_TOKEN={TOKEN}\n")),
        &[],
    );
    assert_eq!(
        gateway
            .get("/api/claude/models", &[("X-Access-Token", TOKEN)])
            .status,
        200
    );
    let pid = gateway.child.id() as libc::pid_t;
    assert_eq!(unsafe { libc::kill(pid, libc::SIGTERM) }, 0);
    let status = gateway
        .wait_exit(Duration::from_secs(10))
        .expect("gateway should exit on SIGTERM");
    assert_eq!(status.code(), Some(0), "SIGTERM must exit 0");
    assert!(
        gateway
            .log()
            .contains("stop signal received; no node to stop"),
        "missing the documented stop line:\n{}",
        gateway.log()
    );
}

/// The two public server-core probes are the only routes in that cluster whose
/// facts a Rust-only front door owns: with no child there is no
/// `process.uptime()` and no `serviceReady` flag to report, and the front door
/// itself is the process a deployment probes. They must answer with *no*
/// authentication owner too, because they never needed the snapshot.
#[test]
fn the_public_health_probes_answer_without_a_node_child() {
    let gateway = Gateway::start("health-no-token", None, &[]);

    let health = gateway.get("/healthz", &[]);
    assert_eq!(health.status, 200, "{}", health.text());
    assert_eq!(health.header("cache-control").as_deref(), Some("no-store"));
    assert_eq!(
        health.header("content-type").as_deref(),
        Some("application/json; charset=utf-8")
    );
    let body = health.json();
    assert_eq!(body["status"], "ok", "{}", health.text());
    // This process's own uptime: a real number, and small enough that it cannot
    // be a Node fact or an epoch value that leaked in.
    let uptime = body["uptimeSeconds"]
        .as_u64()
        .unwrap_or_else(|| panic!("uptimeSeconds must be a number: {}", health.text()));
    assert!(uptime < 600, "{}", health.text());
    assert_eq!(body["requestId"].as_str().map(str::len), Some(8));
    // Same key order as the retired `src/health.js` response.
    assert!(
        health
            .text()
            .starts_with(r#"{"status":"ok","uptimeSeconds":"#),
        "{}",
        health.text()
    );

    let ready = gateway.get("/readyz", &[]);
    assert_eq!(ready.status, 200, "{}", ready.text());
    assert_eq!(ready.header("cache-control").as_deref(), Some("no-store"));
    assert_eq!(
        ready.text(),
        format!(
            r#"{{"status":"ready","requestId":"{}"}}"#,
            ready.json()["requestId"].as_str().unwrap()
        ),
        "a readiness answer with no child carries no checks key"
    );

    // HEAD keeps the headers and drops the body, like every other route here.
    let head = gateway.request(&api("HEAD", "/healthz", &[], ""));
    assert_eq!(head.status, 200);
    assert!(head.body.is_empty(), "{:?}", head.text());

    // The gated half of the same cluster describes Node state, so it still
    // fails closed on the missing authentication owner.
    let metrics = gateway.get("/metrics", &[]);
    assert_eq!(metrics.status, 503, "{}", metrics.text());
    assert_eq!(metrics.text(), AUTH_ABSENT_BODY);
    let operation = gateway.get("/api/repo-operations/op-1", &[]);
    assert_eq!(operation.status, 503, "{}", operation.text());
    assert_eq!(operation.text(), AUTH_ABSENT_BODY);
    assert!(!gateway.log().contains("panicked"), "{}", gateway.log());
}

/// With a local authentication owner the probes stay public (no credential
/// needed) and keep answering from this process, while the gated routes reach
/// the host port that does not exist and report the cluster's own 503.
#[test]
fn the_health_probes_stay_public_with_a_local_auth_runtime() {
    let gateway = Gateway::start(
        "health-token",
        Some(&format!("ACCESS_TOKEN={TOKEN}\n")),
        &[],
    );

    let health = gateway.get("/healthz", &[]);
    assert_eq!(health.status, 200, "{}", health.text());
    assert_eq!(health.json()["status"], "ok");
    let ready = gateway.get("/readyz", &[]);
    assert_eq!(ready.status, 200, "{}", ready.text());
    assert_eq!(ready.json()["status"], "ready");
    assert!(ready.json().get("checks").is_none(), "{}", ready.text());

    // A credential changes nothing for a public path.
    let credentialed = gateway.get("/healthz", &[("X-Access-Token", TOKEN)]);
    assert_eq!(credentialed.status, 200, "{}", credentialed.text());
    assert_eq!(credentialed.json()["status"], "ok");

    // `/metrics` is gated and its table is the child's: authorized, then 503
    // `rust_backend_unavailable` from the absent host port.
    let metrics = gateway.get("/metrics", &[("X-Access-Token", TOKEN)]);
    assert_eq!(metrics.status, 503, "{}", metrics.text());
    assert!(
        metrics
            .text()
            .contains(r#""code":"rust_backend_unavailable""#),
        "{}",
        metrics.text()
    );
    // Without a credential the same gated route is refused by the gate, not by
    // the missing host port: a non-API GET is Express's login redirect, exactly
    // what `--node` answers (native/gateway/tests/server_core.rs
    // `metrics_requires_authentication`).
    let anonymous_metrics = gateway.get("/metrics", &[]);
    assert_eq!(
        anonymous_metrics.status,
        302,
        "{}",
        anonymous_metrics.text()
    );
    assert!(anonymous_metrics
        .header("location")
        .unwrap_or_default()
        .starts_with("/login"));
}

#[test]
fn a_missing_access_token_keeps_the_original_refusal() {
    let gateway = Gateway::start("no-token", None, &[]);
    let response = gateway.get("/api/claude/models", &[]);
    assert_eq!(response.status, 503, "{}", response.text());
    assert_eq!(
        response.text(),
        AUTH_ABSENT_BODY,
        "the missing-token refusal must not change"
    );
    let log = gateway.log();
    assert!(
        log.contains("no ACCESS_TOKEN for the local authentication runtime"),
        "missing the diagnostic line:\n{log}"
    );
    assert!(
        !log.contains("panicked"),
        "the process must not panic:\n{log}"
    );
    // The process is still alive and serving.
    assert_eq!(gateway.get("/__gateway_test/native", &[]).status, 200);
}

#[test]
fn an_unrepresentable_access_token_fails_closed() {
    // AuthRuntime::validate_secret caps the private control frame at
    // auth_control::MAX_FRAME (64 KiB); a larger token cannot be installed.
    let oversized = "x".repeat(70_000);
    let gateway = Gateway::start(
        "bad-token",
        Some(&format!("ACCESS_TOKEN={oversized}\n")),
        &[],
    );
    let response = gateway.get("/api/claude/models", &[]);
    assert_eq!(response.status, 503, "{}", response.text());
    assert_eq!(response.text(), AUTH_ABSENT_BODY);
    let log = gateway.log();
    assert!(
        log.contains("cannot install the local authentication runtime"),
        "missing the diagnostic line:\n{log}"
    );
    assert!(
        !log.contains("panicked"),
        "the process must not panic:\n{log}"
    );
    assert!(!response.text().contains(&oversized));
    assert_eq!(gateway.get("/__gateway_test/native", &[]).status, 200);
}
