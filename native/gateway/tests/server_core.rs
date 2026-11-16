#![recursion_limit = "256"]

//! Integration coverage for the server-core cluster retired from `server.js`
//! and `src/health.js` and answered by the Rust front door
//! (`native/gateway/src/app/server_core.rs`):
//! `GET|HEAD /healthz`, `/readyz`, `/metrics` and
//! `GET|HEAD /api/repo-operations/:operationId`.
//!
//! The Node process here is only the protocol fixture: it answers
//! `POST /api/__host/server-core` from `FIXTURE_HOST_SCRIPT.serverCore` and
//! appends every payload to `server-core-calls.jsonl`, so each test asserts
//! exactly the op (and operation id) the front door sent and what it rendered
//! back. `hostDown` makes the fixture drop the internal socket, which is the
//! front door's "native module too old" 503.
//!
//! `/healthz` and `/readyz` are HTTP-entry exemptions; `/metrics` and
//! `/api/repo-operations` are not. The tests drive both an external peer with a
//! token and one without, so the exemptions and the gate are each proven.

use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

const GATEWAY_BIN: &str = env!("CARGO_BIN_EXE_multicc-gateway");
const FIXTURE_JS: &str = include_str!("fixtures/upstream.js");
const TOKEN: &str = "secret-token-1";
const EXTERNAL_IP: &str = "203.0.113.9";
const METRICS_CONTENT_TYPE: &str = "text/plain; charset=utf-8; version=0.0.4";
const UNAVAILABLE: &str = "服务核心接口尚未就绪，请更新原生模块";

fn unique(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "multicc-gateway-server-core-{}-{tag}-{nanos}",
        std::process::id()
    ))
}

fn free_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.local_addr().unwrap().port()
}

struct Response {
    status: u16,
    headers: Vec<(String, String)>,
    bytes: Vec<u8>,
}

impl Response {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }
    fn body(&self) -> String {
        String::from_utf8_lossy(&self.bytes).into_owned()
    }
    fn json(&self) -> Value {
        serde_json::from_slice(&self.bytes)
            .unwrap_or_else(|_| panic!("JSON response: {}", self.body()))
    }
}

struct Gateway {
    dir: PathBuf,
    state: PathBuf,
    port: u16,
    child: Child,
}

impl Gateway {
    fn start(tag: &str, script: Value) -> Self {
        let mut last_log = String::new();
        for attempt in 0..6 {
            match Self::start_once(&format!("{tag}-{attempt}"), &script) {
                Ok(gateway) => return gateway,
                Err((log, retryable)) => {
                    last_log = log;
                    if !retryable {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
        }
        panic!("gateway never became ready\n{last_log}");
    }

    /// `Err((log, retryable))`; a bind race on the ephemeral port is retried.
    fn start_once(tag: &str, script: &Value) -> Result<Self, (String, bool)> {
        let dir = unique(tag);
        let data = dir.join("data");
        let home = dir.join("home");
        let state = dir.join("state");
        for path in [&dir, &data, &home, &state] {
            fs::create_dir_all(path).unwrap();
        }
        let script_path = dir.join("host-script.json");
        fs::write(&script_path, script.to_string()).unwrap();
        fs::write(dir.join("server.js"), FIXTURE_JS).unwrap();
        let port = free_port();
        let log = fs::File::create(dir.join("gateway.log")).unwrap();
        let mut command = Command::new(GATEWAY_BIN);
        command
            .arg("serve")
            .arg("--cwd")
            .arg(&dir)
            .arg("--node")
            .arg(std::env::var("MULTICC_TEST_NODE").unwrap_or_else(|_| "node".to_string()))
            .arg("server.js")
            .env_clear()
            .env(
                "PATH",
                std::env::var_os("PATH").unwrap_or_else(|| "/usr/local/bin:/usr/bin:/bin".into()),
            )
            .env("PORT", port.to_string())
            .env("ACCESS_TOKEN", TOKEN)
            .env("HOME", &home)
            .env("MULTICC_DATA_DIR", &data)
            .env("MULTICC_GATEWAY_UPSTREAM_WAIT_MS", "3000")
            .env("MULTICC_GATEWAY_BACKOFF_SCALE", "0.01")
            .env("FIXTURE_MODE", "echo")
            .env("FIXTURE_STATE_DIR", &state)
            .env("FIXTURE_HOST_SCRIPT", &script_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::from(log));
        for key in [
            "TMPDIR",
            "SystemRoot",
            "SYSTEMROOT",
            "windir",
            "TEMP",
            "TMP",
        ] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        let child = command.spawn().expect("spawn multicc-gateway");
        let mut gateway = Self {
            dir,
            state,
            port,
            child,
        };
        let deadline = Instant::now() + Duration::from_secs(15);
        while !gateway.state.join("ready").exists() {
            if let Ok(Some(status)) = gateway.child.try_wait() {
                let log = gateway.log();
                let retryable = log.contains("EADDRINUSE") || log.contains("cannot bind");
                return Err((format!("{log}\nchild exited: {status}"), retryable));
            }
            if Instant::now() >= deadline {
                return Err((gateway.log(), false));
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        Ok(gateway)
    }

    fn log(&self) -> String {
        fs::read_to_string(self.dir.join("gateway.log")).unwrap_or_default()
    }

    /// Every payload the front door sent the server-core host port.
    fn calls(&self) -> Vec<Value> {
        fs::read_to_string(self.state.join("server-core-calls.jsonl"))
            .unwrap_or_default()
            .lines()
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn ops(&self) -> Vec<String> {
        self.calls()
            .iter()
            .map(|call| call["op"].as_str().unwrap().to_string())
            .collect()
    }

    /// Whether the protocol fixture (standing in for the whole Node server) saw
    /// this request, that is the front door did not claim it.
    fn forwarded(&self, method: &str, url: &str) -> bool {
        fs::read_to_string(self.state.join("requests.log"))
            .unwrap_or_default()
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .any(|entry| {
                entry["method"].as_str() == Some(method) && entry["url"].as_str() == Some(url)
            })
    }

    fn exchange(
        &self,
        method: &str,
        url: &str,
        extra: &[(&str, &str)],
        body: Option<&[u8]>,
    ) -> Response {
        let payload = body.unwrap_or(b"");
        let mut request =
            format!("{method} {url} HTTP/1.1\r\nHost: localhost\r\nX-Request-Id: host-req-1\r\n");
        let mut has_length = false;
        for (name, value) in extra {
            if name.eq_ignore_ascii_case("content-length")
                || name.eq_ignore_ascii_case("transfer-encoding")
            {
                has_length = true;
            }
            request.push_str(&format!("{name}: {value}\r\n"));
        }
        if body.is_some() && !has_length {
            request.push_str(&format!("Content-Length: {}\r\n", payload.len()));
        }
        request.push_str("Connection: close\r\n\r\n");
        let mut raw = Vec::new();
        for attempt in 0..4 {
            let mut stream = TcpStream::connect(("127.0.0.1", self.port)).expect("connect gateway");
            stream
                .set_read_timeout(Some(Duration::from_secs(30)))
                .unwrap();
            stream.write_all(request.as_bytes()).unwrap();
            let _ = stream.write_all(payload);
            raw.clear();
            match stream.read_to_end(&mut raw) {
                Ok(_) => break,
                Err(error)
                    if raw.is_empty()
                        && attempt < 3
                        && matches!(
                            error.kind(),
                            std::io::ErrorKind::ConnectionReset
                                | std::io::ErrorKind::ConnectionAborted
                                | std::io::ErrorKind::BrokenPipe
                        ) =>
                {
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(error) => panic!("gateway exchange failed: {error:?}"),
            }
        }
        let split = raw
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .expect("response headers");
        let head = String::from_utf8_lossy(&raw[..split]);
        let mut lines = head.split("\r\n");
        let status = lines
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .and_then(|code| code.parse().ok())
            .expect("status line");
        let headers = lines
            .filter_map(|line| line.split_once(':'))
            .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_string()))
            .collect();
        Response {
            status,
            headers,
            bytes: raw[split + 4..].to_vec(),
        }
    }

    fn get(&self, url: &str, headers: &[(&str, &str)]) -> Response {
        self.exchange("GET", url, headers, None)
    }
    fn head(&self, url: &str, headers: &[(&str, &str)]) -> Response {
        self.exchange("HEAD", url, headers, None)
    }
    fn options(&self, url: &str, headers: &[(&str, &str)]) -> Response {
        self.exchange("OPTIONS", url, headers, None)
    }
}

impl Drop for Gateway {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn assert_key_order(body: &str, keys: &[&str]) {
    let mut last = 0;
    for key in keys {
        let needle = format!("\"{key}\":");
        let index = body
            .find(&needle)
            .unwrap_or_else(|| panic!("missing {key} in {body}"));
        assert!(index >= last, "{key} is out of order in {body}");
        last = index;
    }
}

/// External peer, authenticated: the forwarding header makes the locality fact
/// false, the token satisfies the ordinary gate.
fn authed() -> Vec<(&'static str, &'static str)> {
    vec![("X-Forwarded-For", EXTERNAL_IP), ("X-Access-Token", TOKEN)]
}

/// External peer with no credential at all: only the exemptions get through.
fn anonymous() -> Vec<(&'static str, &'static str)> {
    vec![("X-Forwarded-For", EXTERNAL_IP)]
}

fn world(core: Value) -> Value {
    json!({ "serverCore": core })
}

fn ready_world() -> Value {
    world(json!({
        "health": { "uptimeSeconds": 42, "ready": true, "checks": { "commanderMigration": { "ready": true } } },
        "metrics": {
            "multicc_ws_clients": 2,
            "multicc_active_turns": 3,
            "multicc_ready": 1,
        },
        "operations": { "op-1": { "id": "op-1", "status": "done", "kind": "merge" } },
    }))
}

// ── /healthz ───────────────────────────────────────────────────────────────

#[test]
fn healthz_renders_the_host_facts_in_order_and_is_public() {
    let gateway = Gateway::start("healthz", ready_world());
    let response = gateway.get("/healthz", &anonymous());
    assert_eq!(response.status, 200, "{}", gateway.log());
    assert_eq!(
        response.header("content-type"),
        Some("application/json; charset=utf-8")
    );
    assert_eq!(response.header("cache-control"), Some("no-store"));
    assert_eq!(
        response.body(),
        r#"{"status":"ok","uptimeSeconds":42,"requestId":"host-req-1"}"#
    );
    assert_key_order(&response.body(), &["status", "uptimeSeconds", "requestId"]);
    assert_eq!(gateway.ops(), vec!["health"]);
    assert!(
        !gateway.forwarded("GET", "/healthz"),
        "the front door must claim it"
    );
}

#[test]
fn healthz_head_keeps_the_length_and_drops_the_body() {
    let gateway = Gateway::start("healthz-head", ready_world());
    let get = gateway.get("/healthz", &anonymous());
    let head = gateway.head("/healthz", &anonymous());
    assert_eq!(head.status, 200);
    assert!(head.bytes.is_empty(), "HEAD body: {}", head.body());
    assert_eq!(head.header("content-length"), get.header("content-length"));
    assert_eq!(head.header("cache-control"), Some("no-store"));
}

#[test]
fn healthz_options_is_public() {
    let gateway = Gateway::start("healthz-options", ready_world());
    let response = gateway.options("/healthz", &anonymous());
    // Express's automatic OPTIONS answer: 200, the Allow list as the body.
    assert_eq!(response.status, 200);
    assert_eq!(response.header("allow"), Some("GET,HEAD"));
    assert_eq!(
        response.header("content-type"),
        Some("text/html; charset=utf-8")
    );
    assert_eq!(response.body(), "GET,HEAD");
    assert!(
        gateway.calls().is_empty(),
        "OPTIONS must not consult the host"
    );
}

#[test]
fn post_healthz_is_not_claimed() {
    let gateway = Gateway::start("healthz-post", ready_world());
    let response = gateway.exchange("POST", "/healthz", &authed(), Some(b"{}"));
    // The fixture stands in for whatever Node does; the point is that no host
    // call was made and the request reached the child.
    assert_eq!(response.status, 200);
    assert!(gateway.forwarded("POST", "/healthz"));
    assert!(gateway.calls().is_empty());
}

// ── /readyz ────────────────────────────────────────────────────────────────

#[test]
fn readyz_appends_checks_after_request_id() {
    let gateway = Gateway::start("readyz-ready", ready_world());
    let response = gateway.get("/readyz", &anonymous());
    assert_eq!(response.status, 200, "{}", gateway.log());
    assert_eq!(response.header("cache-control"), Some("no-store"));
    let body = response.body();
    assert_eq!(
        body,
        r#"{"status":"ready","requestId":"host-req-1","checks":{"commanderMigration":{"ready":true}}}"#
    );
    assert_key_order(&body, &["status", "requestId", "checks"]);
    assert_eq!(gateway.ops(), vec!["health"]);
}

#[test]
fn readyz_not_ready_is_503_and_omits_null_checks() {
    let gateway = Gateway::start(
        "readyz-not-ready",
        world(json!({ "health": { "uptimeSeconds": 7, "ready": false, "checks": null } })),
    );
    let response = gateway.get("/readyz", &anonymous());
    assert_eq!(response.status, 503);
    assert_eq!(
        response.body(),
        r#"{"status":"not_ready","requestId":"host-req-1"}"#
    );
}

#[test]
fn readyz_drops_non_object_checks() {
    let gateway = Gateway::start(
        "readyz-checks-string",
        world(json!({ "health": { "uptimeSeconds": 7, "ready": true, "checks": "nope" } })),
    );
    let response = gateway.get("/readyz", &anonymous());
    assert_eq!(response.status, 200);
    assert_eq!(
        response.body(),
        r#"{"status":"ready","requestId":"host-req-1"}"#
    );
}

// ── /metrics ───────────────────────────────────────────────────────────────

#[test]
fn metrics_renders_sorted_text_with_the_exact_content_type() {
    let gateway = Gateway::start("metrics", ready_world());
    let response = gateway.get("/metrics", &authed());
    assert_eq!(response.status, 200, "{}", gateway.log());
    assert_eq!(response.header("content-type"), Some(METRICS_CONTENT_TYPE));
    assert_eq!(
        response.body(),
        "multicc_active_turns 3\nmulticc_ready 1\nmulticc_ws_clients 2\n"
    );
    assert_eq!(gateway.ops(), vec!["metrics"]);
    assert!(!gateway.forwarded("GET", "/metrics"));
}

#[test]
fn metrics_head_has_no_body() {
    let gateway = Gateway::start("metrics-head", ready_world());
    let get = gateway.get("/metrics", &authed());
    let head = gateway.head("/metrics", &authed());
    assert_eq!(head.status, 200);
    assert!(head.bytes.is_empty(), "HEAD body: {}", head.body());
    assert_eq!(head.header("content-length"), get.header("content-length"));
    assert_eq!(head.header("content-type"), Some(METRICS_CONTENT_TYPE));
}

#[test]
fn metrics_empty_table_is_a_single_newline() {
    let gateway = Gateway::start(
        "metrics-empty",
        world(json!({ "health": { "ready": false }, "metrics": {} })),
    );
    let response = gateway.get("/metrics", &authed());
    assert_eq!(response.status, 200);
    assert_eq!(response.body(), "\n");
}

#[test]
fn metrics_requires_authentication() {
    let gateway = Gateway::start("metrics-auth", ready_world());
    // A non-API GET without a credential is Express's login redirect.
    let response = gateway.get("/metrics", &anonymous());
    assert_eq!(response.status, 302, "{}", gateway.log());
    assert!(response
        .header("location")
        .unwrap_or_default()
        .starts_with("/login"));
    assert!(
        gateway.calls().is_empty(),
        "the gate must run before the host"
    );
}

// ── /api/repo-operations/:operationId ──────────────────────────────────────

#[test]
fn repo_operation_returns_the_operation_json() {
    let gateway = Gateway::start("repo-op", ready_world());
    let response = gateway.get("/api/repo-operations/op-1", &authed());
    assert_eq!(response.status, 200, "{}", gateway.log());
    assert_eq!(
        response.header("content-type"),
        Some("application/json; charset=utf-8")
    );
    assert_eq!(
        response.body(),
        r#"{"id":"op-1","status":"done","kind":"merge"}"#
    );
    let calls = gateway.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["op"], "repoOperation");
    assert_eq!(calls[0]["operationId"], "op-1");
}

#[test]
fn repo_operation_missing_is_404() {
    let gateway = Gateway::start("repo-404", ready_world());
    let response = gateway.get("/api/repo-operations/ghost", &authed());
    assert_eq!(response.status, 404);
    assert_eq!(response.body(), r#"{"error":"operation not found"}"#);
    assert_eq!(gateway.calls()[0]["operationId"], "ghost");
}

#[test]
fn repo_operation_decodes_the_id_before_the_host_call() {
    let gateway = Gateway::start("repo-decode", ready_world());
    let response = gateway.get("/api/repo-operations/op%2D1", &authed());
    assert_eq!(response.status, 200, "{}", gateway.log());
    assert_eq!(gateway.calls()[0]["operationId"], "op-1");
}

#[test]
fn repo_operation_requires_authentication() {
    let gateway = Gateway::start("repo-auth", ready_world());
    let response = gateway.get("/api/repo-operations/op-1", &anonymous());
    assert_eq!(response.status, 403, "{}", gateway.log());
    assert!(gateway.calls().is_empty());
}

#[test]
fn repo_operation_gzip_corpus_round_trips() {
    let long = "z".repeat(2048);
    let gateway = Gateway::start(
        "repo-gzip",
        world(json!({ "operations": { "big": { "id": "big", "note": long } } })),
    );
    let accepted = gateway.get(
        "/api/repo-operations/big",
        &[
            ("X-Forwarded-For", EXTERNAL_IP),
            ("X-Access-Token", TOKEN),
            ("Accept-Encoding", "gzip"),
        ],
    );
    assert_eq!(accepted.status, 200, "{}", gateway.log());
    assert_eq!(accepted.header("content-encoding"), Some("gzip"));
    assert!(accepted
        .header("vary")
        .unwrap_or_default()
        .contains("Accept-Encoding"));
    // gzip bytes for this payload are far below the uncompressed size.
    assert!(
        accepted.bytes.len() < 1024,
        "gzip length {}",
        accepted.bytes.len()
    );

    let plain = gateway.get("/api/repo-operations/big", &authed());
    assert_eq!(plain.status, 200);
    assert_eq!(plain.header("content-encoding"), None);
    assert!(plain
        .header("vary")
        .unwrap_or_default()
        .contains("Accept-Encoding"));
    assert!(plain.bytes.len() > 2048);

    let head = gateway.head(
        "/api/repo-operations/big",
        &[
            ("X-Forwarded-For", EXTERNAL_IP),
            ("X-Access-Token", TOKEN),
            ("Accept-Encoding", "gzip"),
        ],
    );
    assert_eq!(head.status, 200);
    assert!(head.bytes.is_empty());
    assert_eq!(head.header("content-encoding"), None);
}

// ── host failures ──────────────────────────────────────────────────────────

#[test]
fn host_down_answers_the_unavailable_dto_on_every_route() {
    let gateway = Gateway::start("host-down", world(json!({ "hostDown": true })));
    for (url, headers) in [
        ("/healthz", anonymous()),
        ("/readyz", anonymous()),
        ("/metrics", authed()),
        ("/api/repo-operations/op-1", authed()),
    ] {
        let response = gateway.get(url, &headers);
        assert_eq!(response.status, 503, "{url}: {}", gateway.log());
        let body = response.json();
        assert_eq!(body["error"], UNAVAILABLE, "{url}");
        assert_eq!(body["code"], "rust_backend_unavailable", "{url}");
    }
}

#[test]
fn stale_child_shapes_answer_503() {
    // A metrics table with a non-numeric value is a shape this route cannot
    // reproduce, so the front door must refuse instead of guessing.
    let gateway = Gateway::start(
        "stale-shape",
        world(json!({ "metrics": { "multicc_bad": "nope" } })),
    );
    let response = gateway.get("/metrics", &authed());
    assert_eq!(response.status, 503);
    assert_eq!(response.json()["code"], "rust_backend_unavailable");
}

#[test]
fn readiness_requires_boolean_ready() {
    let gateway = Gateway::start(
        "ready-shape",
        world(json!({ "health": { "uptimeSeconds": 1, "ready": "yes" } })),
    );
    let response = gateway.get("/readyz", &anonymous());
    assert_eq!(response.status, 503);
    assert_eq!(response.json()["code"], "rust_backend_unavailable");
}
