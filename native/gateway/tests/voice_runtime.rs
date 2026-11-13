//! Integration coverage for the voice runtime routes retired from
//! `src/routes/voice-gateway-global.js` and `src/routes/qwen-audio-runtime.js`
//! and answered by the Rust front door
//! (`native/gateway/src/app/voice_runtime.rs`):
//!
//!   GET|HEAD|PUT|DELETE  /api/voice-gateway                      (+ /api/v1)
//!   GET|HEAD             /api/voice-gateway/runtime
//!   POST                 /api/voice-gateway/restart
//!   POST                 /api/voice-gateway/launch
//!   GET|HEAD             /api/voice-gateway/launch/:launchId
//!   GET|HEAD             /api/voice-runtime
//!   POST                 /api/voice-runtime/install
//!   GET|HEAD             /api/directories/:id/voice-gateway/runtime
//!   POST                 /api/directories/:id/voice-gateway/restart
//!
//! The Node process here is only the protocol fixture (PROXY v1 + auth
//! control): it answers `POST /api/__host/voice-runtime` from
//! `FIXTURE_HOST_SCRIPT` and appends every body to
//! `voice-runtime-calls.jsonl`. Status tables, bodies, the launch URL, the
//! loopback flag, the Fleet projection and the 503s are Rust and are what
//! these tests assert.

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

fn unique(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "multicc-gateway-voice-runtime-{}-{tag}-{nanos}",
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
    body: String,
    raw_body: Vec<u8>,
}

impl Response {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }
    fn json(&self) -> Value {
        serde_json::from_str(&self.body).expect("JSON response")
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

    /// `Err((log, retryable))`. `free_port` only reserves `127.0.0.1`, while the
    /// gateway binds `0.0.0.0`; a bind failure is retried with a fresh port.
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

    /// Every body the fixture received on one host port, in order.
    fn raw_calls(&self, file: &str) -> Vec<String> {
        fs::read_to_string(self.state.join(file))
            .unwrap_or_default()
            .lines()
            .filter(|line| !line.is_empty())
            .map(str::to_string)
            .collect()
    }

    fn calls(&self, file: &str) -> Vec<Value> {
        self.raw_calls(file)
            .iter()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn runtime_calls(&self) -> Vec<Value> {
        self.calls("voice-runtime-calls.jsonl")
    }

    fn fixture_requests(&self) -> Vec<Value> {
        self.calls("requests.log")
    }

    /// Whether the protocol fixture (standing in for the whole Node server)
    /// saw this request — i.e. the front door did not claim it.
    fn forwarded(&self, method: &str, url: &str) -> bool {
        self.fixture_requests().iter().any(|entry| {
            entry["method"].as_str() == Some(method) && entry["url"].as_str() == Some(url)
        })
    }

    fn request(
        &self,
        method: &str,
        url: &str,
        body: Option<&Value>,
        extra: &[(&str, &str)],
    ) -> Response {
        let mut host = "localhost";
        let mut request_id = "diff-req-1";
        let mut lines = String::new();
        for &(name, value) in extra {
            if name.eq_ignore_ascii_case("host") {
                host = value;
            } else if name.eq_ignore_ascii_case("x-request-id") {
                request_id = value;
            } else {
                lines.push_str(name);
                lines.push_str(": ");
                lines.push_str(value);
                lines.push_str("\r\n");
            }
        }
        let payload = body
            .map(|value| serde_json::to_string(value).unwrap())
            .unwrap_or_default();
        if body.is_some() {
            lines.push_str("Content-Type: application/json\r\n");
            lines.push_str(&format!("Content-Length: {}\r\n", payload.len()));
        }
        let request = format!(
            "{method} {url} HTTP/1.1\r\nHost: {host}\r\nX-Request-Id: {request_id}\r\n\
             {lines}Connection: close\r\n\r\n{payload}"
        );
        let mut raw = Vec::new();
        for attempt in 0..4 {
            let mut stream = TcpStream::connect(("127.0.0.1", self.port)).expect("connect gateway");
            stream
                .set_read_timeout(Some(Duration::from_secs(30)))
                .unwrap();
            stream.write_all(request.as_bytes()).unwrap();
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
        let raw_body = raw[split + 4..].to_vec();
        Response {
            status,
            headers,
            body: String::from_utf8_lossy(&raw_body).into_owned(),
            raw_body,
        }
    }

    fn get(&self, url: &str) -> Response {
        self.request("GET", url, None, &[])
    }

    fn head(&self, url: &str) -> Response {
        self.request("HEAD", url, None, &[])
    }

    fn options(&self, url: &str) -> Response {
        self.request("OPTIONS", url, None, &[])
    }

    fn post(&self, url: &str, body: &Value) -> Response {
        self.request("POST", url, Some(body), &[])
    }

    fn put(&self, url: &str, body: &Value) -> Response {
        self.request("PUT", url, Some(body), &[])
    }

    fn delete(&self, url: &str) -> Response {
        self.request("DELETE", url, None, &[])
    }
}

impl Drop for Gateway {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.dir);
    }
}

// ── Fixtures ────────────────────────────────────────────────────────────────

fn script(value: Value) -> Value {
    json!({ "voiceRuntime": value })
}

fn text(value: &Value) -> String {
    serde_json::to_string(value).unwrap()
}

/// `{ok:false,error,code,apiVersion,requestId,correlationId}` for the default
/// request id `diff-req-1` (the test sends `X-Request-Id`; correlation falls
/// back to it).
fn error_body(error: &str, code: &str) -> String {
    format!(
        r#"{{"ok":false,"error":"{error}","code":"{code}","apiVersion":"v1","requestId":"diff-req-1","correlationId":"diff-req-1"}}"#
    )
}

/// The standard stale-host answer.
fn unavailable_body() -> String {
    r#"{"error":"语音运行时接口尚未就绪，请更新原生模块","code":"rust_backend_unavailable"}"#
        .to_string()
}

fn gateway_dto() -> Value {
    json!({
        "configured": true,
        "enabled": true,
        "provider": "qwen-audio-agent",
        "commanderSessionId": "sess-1"
    })
}

fn status_with_url() -> Value {
    json!({
        "scope": "global",
        "state": "running",
        "desired": true,
        "url": "http://127.0.0.1:4123/"
    })
}

fn runtime_status() -> Value {
    json!({ "installed": true, "state": "ready", "version": "1.2.3" })
}

// ── global get/put/remove ───────────────────────────────────────────────────

#[test]
fn global_get_returns_the_control_plane_facts() {
    let gateway = Gateway::start(
        "global-get",
        script(json!({
            "gateway": gateway_dto(),
            "legacy": [{ "id": "legacy-1" }],
            "baseUrl": "http://192.168.1.5:3000"
        })),
    );
    let response = gateway.get("/api/voice-gateway");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.header("cache-control"), Some("no-store"));
    assert_eq!(
        response.body,
        text(&json!({
            "ok": true,
            "gateway": gateway_dto(),
            "legacy": [{ "id": "legacy-1" }],
            "baseUrl": "http://192.168.1.5:3000"
        }))
    );
    assert_eq!(gateway.runtime_calls(), vec![json!({ "op": "globalGet" })]);

    let head = gateway.head("/api/voice-gateway");
    assert_eq!(head.status, 200);
    assert!(head.raw_body.is_empty());
    assert_eq!(
        head.header("content-length"),
        response.header("content-length")
    );
    assert_eq!(head.header("etag"), response.header("etag"));

    // One trailing slash and mixed-case literals are the same route.
    let mixed = gateway.get("/api/Voice-Gateway/");
    assert_eq!(mixed.status, 200);
    assert_eq!(mixed.body, response.body);

    let v1 = gateway.get("/api/v1/voice-gateway");
    assert_eq!(v1.status, 200);
    assert_eq!(
        v1.body,
        text(&json!({
            "ok": true,
            "gateway": gateway_dto(),
            "legacy": [{ "id": "legacy-1" }],
            "baseUrl": "http://192.168.1.5:3000",
            "apiVersion": "v1",
            "requestId": "diff-req-1",
            "correlationId": "diff-req-1"
        }))
    );
}

#[test]
fn global_put_answers_201_created_and_projects_the_options() {
    let gateway = Gateway::start("global-put", script(json!({ "gateway": gateway_dto() })));
    let response = gateway.put(
        "/api/voice-gateway",
        &json!({
            "enabled": false,
            "provider": null,
            "commanderSessionId": null,
            "autoInstall": true,
            "ignored": 1
        }),
    );
    assert_eq!(response.status, 201, "{}", response.body);
    assert_eq!(response.header("cache-control"), Some("no-store"));
    assert_eq!(
        response.body,
        text(&json!({ "ok": true, "created": true, "gateway": gateway_dto() }))
    );
    // Key order is part of the host contract: absent keys never appear, null
    // survives and only the three options are projected.
    assert_eq!(
        gateway.raw_calls("voice-runtime-calls.jsonl"),
        vec![
            r#"{"op":"globalPut","options":{"enabled":false,"provider":null,"commanderSessionId":null},"autoInstall":true}"#
                .to_string()
        ]
    );

    // v1 wraps the same payload in the metadata envelope.
    let v1 = gateway.put("/api/v1/voice-gateway", &json!({}));
    assert_eq!(v1.status, 201);
    assert_eq!(
        v1.body,
        text(&json!({
            "ok": true,
            "created": true,
            "gateway": gateway_dto(),
            "apiVersion": "v1",
            "requestId": "diff-req-1",
            "correlationId": "diff-req-1"
        }))
    );
}

#[test]
fn global_put_update_is_200() {
    let gateway = Gateway::start(
        "global-put-update",
        script(json!({
            "answers": {
                "globalPut": { "ok": true, "created": false, "gateway": gateway_dto() }
            }
        })),
    );
    let response = gateway.put("/api/voice-gateway", &json!({ "enabled": true }));
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.json()["created"], json!(false));
}

#[test]
fn global_put_rejects_a_non_boolean_auto_install_before_the_host() {
    let gateway = Gateway::start("global-put-precheck", script(json!({})));
    for (path, expected) in [
        (
            "/api/voice-gateway",
            r#"{"ok":false,"error":"voice_gateway_auto_install_invalid"}"#.to_string(),
        ),
        (
            "/api/v1/voice-gateway",
            error_body(
                "voice_gateway_auto_install_invalid",
                "voice_gateway_auto_install_invalid",
            ),
        ),
    ] {
        for value in [json!("yes"), json!(1), json!(null), json!([])] {
            let response = gateway.put(path, &json!({ "autoInstall": value }));
            assert_eq!(response.status, 400, "{path} {value}");
            assert_eq!(response.body, expected, "{path} {value}");
        }
    }
    assert!(gateway.runtime_calls().is_empty());
}

#[test]
fn global_put_failure_uses_the_code_table() {
    let gateway = Gateway::start(
        "global-put-failure",
        script(json!({
            "answers": { "globalPut": { "ok": false, "code": "voice_gateway_provider_invalid" } }
        })),
    );
    let response = gateway.put("/api/voice-gateway", &json!({}));
    assert_eq!(response.status, 400, "{}", response.body);
    assert_eq!(
        response.body,
        r#"{"ok":false,"error":"voice_gateway_provider_invalid"}"#
    );
    let v1 = gateway.put("/api/v1/voice-gateway", &json!({}));
    assert_eq!(
        v1.body,
        error_body(
            "voice_gateway_provider_invalid",
            "voice_gateway_provider_invalid"
        )
    );
}

#[test]
fn global_remove_never_sets_cache_control() {
    let gateway = Gateway::start("global-remove", script(json!({})));
    let response = gateway.delete("/api/voice-gateway");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.header("cache-control"), None);
    assert_eq!(response.body, r#"{"ok":true,"removed":true}"#);
    assert_eq!(
        gateway.runtime_calls(),
        vec![json!({ "op": "globalRemove" })]
    );

    let v1 = gateway.delete("/api/v1/voice-gateway");
    assert_eq!(
        v1.body,
        text(&json!({
            "ok": true,
            "removed": true,
            "apiVersion": "v1",
            "requestId": "diff-req-1",
            "correlationId": "diff-req-1"
        }))
    );
}

#[test]
fn global_remove_failure_keeps_a_body_without_cache_control() {
    let gateway = Gateway::start(
        "global-remove-failure",
        script(json!({
            "answers": { "globalRemove": { "ok": false, "code": "voice_gateway_not_found" } }
        })),
    );
    let response = gateway.delete("/api/voice-gateway");
    assert_eq!(response.status, 404);
    assert_eq!(response.header("cache-control"), None);
    assert_eq!(
        response.body,
        r#"{"ok":false,"error":"voice_gateway_not_found"}"#
    );
}

// ── global runtime / restart ────────────────────────────────────────────────

#[test]
fn global_runtime_strips_the_raw_url() {
    let gateway = Gateway::start(
        "global-runtime",
        script(json!({ "status": status_with_url() })),
    );
    let response = gateway.get("/api/voice-gateway/runtime");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.header("cache-control"), Some("no-store"));
    assert_eq!(
        response.body,
        text(&json!({
            "ok": true,
            "runtime": { "scope": "global", "state": "running", "desired": true }
        }))
    );
    assert_eq!(
        gateway.runtime_calls(),
        vec![json!({ "op": "globalRuntime" })]
    );

    let v1 = gateway.get("/api/v1/voice-gateway/runtime");
    assert_eq!(v1.json()["apiVersion"], json!("v1"));
    assert!(
        v1.json()["runtime"].get("url").is_none(),
        "the raw child URL must never be projected"
    );
}

#[test]
fn global_restart_strips_the_url_and_maps_a_throw_to_a_safe_500() {
    let gateway = Gateway::start(
        "global-restart",
        script(json!({ "answers": { "globalRestart": { "status": status_with_url() } } })),
    );
    let response = gateway.post("/api/voice-gateway/restart", &json!({}));
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.header("cache-control"), Some("no-store"));
    assert_eq!(
        response.body,
        text(&json!({
            "ok": true,
            "runtime": { "scope": "global", "state": "running", "desired": true }
        }))
    );

    let gateway = Gateway::start(
        "global-restart-thrown",
        script(json!({
            "answers": {
                "globalRestart": { "thrown": { "code": "disk_full", "message": "no space" } }
            }
        })),
    );
    let response = gateway.post("/api/v1/voice-gateway/restart", &json!({}));
    assert_eq!(response.status, 500, "{}", response.body);
    assert_eq!(response.body, error_body("internal_error", "disk_full"));
    assert_eq!(response.header("cache-control"), None);
}

// ── launch ──────────────────────────────────────────────────────────────────

fn launch_begin_answer(status: Value) -> Value {
    json!({
        "launchBegin": {
            "ok": true,
            "launch": {
                "id": "launch/1",
                "scope": "session",
                "expiresAt": "2026-01-01T00:01:00.000Z",
                "display": { "label": "main" },
                "sourceSessionId": "sess-1"
            },
            "targetSessionId": "sess-target",
            "status": status
        }
    })
}

#[test]
fn launch_issues_a_proxy_url_and_acknowledges_the_host() {
    let gateway = Gateway::start(
        "launch",
        script(json!({
            "answers": {
                "launchBegin": launch_begin_answer(status_with_url())["launchBegin"].clone(),
                "launchEnd": { "ok": true }
            }
        })),
    );
    let response = gateway.post(
        "/api/voice-gateway/launch",
        &json!({ "sourceSessionId": "sess-1", "directory": "ignored" }),
    );
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.header("cache-control"), Some("no-store"));
    assert_eq!(
        response.body,
        text(&json!({
            "ok": true,
            "launch": {
                "url": "/voice-gateway/web/?session=launch%2F1",
                "scope": "session",
                "expiresAt": "2026-01-01T00:01:00.000Z",
                "display": { "label": "main" },
                "transport": { "loopbackOnly": true }
            }
        }))
    );
    // The begin/ack sequence and payloads are exactly the retired handler's.
    assert_eq!(
        gateway.raw_calls("voice-runtime-calls.jsonl"),
        vec![
            r#"{"op":"launchBegin","sourceSessionId":"sess-1"}"#.to_string(),
            r#"{"op":"launchEnd","id":"launch/1","revoke":false,"scope":"session","source":"sess-1","target":"sess-target"}"#.to_string(),
        ]
    );
}

#[test]
fn launch_marks_a_non_loopback_caller_and_wraps_v1() {
    let gateway = Gateway::start(
        "launch-lan",
        script(json!({
            "answers": { "launchBegin": launch_begin_answer(status_with_url())["launchBegin"].clone() }
        })),
    );
    // A non-loopback Host is a remote caller for the auth gate, exactly like
    // Node; the token is the one the gateway was started with.
    let response = gateway.request(
        "POST",
        "/api/v1/voice-gateway/launch",
        Some(&json!({})),
        &[("Host", "example.com:3000"), ("X-Access-Token", TOKEN)],
    );
    assert_eq!(response.status, 200, "{}", response.body);
    let body = response.json();
    assert_eq!(body["launch"]["transport"]["loopbackOnly"], json!(false));
    assert_eq!(body["apiVersion"], json!("v1"));
    assert_eq!(body["requestId"], json!("diff-req-1"));
    // No sourceSessionId key in the body means no key on the wire.
    assert_eq!(gateway.runtime_calls()[0], json!({ "op": "launchBegin" }));
}

#[test]
fn launch_without_a_runtime_url_revokes_and_reports_the_runtime_error() {
    let gateway = Gateway::start(
        "launch-no-url",
        script(json!({
            "answers": {
                "launchBegin": {
                    "ok": true,
                    "launch": {
                        "id": "launch-1",
                        "scope": "global",
                        "expiresAt": "2026-01-01T00:01:00.000Z",
                        "display": null
                    },
                    "targetSessionId": "sess-target",
                    "status": { "state": "stopped", "lastError": { "code": "spawn_failed" } }
                }
            }
        })),
    );
    let response = gateway.post("/api/voice-gateway/launch", &json!({}));
    assert_eq!(response.status, 409, "{}", response.body);
    assert_eq!(response.body, r#"{"ok":false,"error":"spawn_failed"}"#);
    assert_eq!(response.header("cache-control"), None);
    assert_eq!(
        gateway.raw_calls("voice-runtime-calls.jsonl"),
        vec![
            r#"{"op":"launchBegin"}"#.to_string(),
            r#"{"op":"launchEnd","id":"launch-1","revoke":true}"#.to_string(),
        ]
    );

    // A status with no error code falls back to voice_gateway_not_running.
    let gateway = Gateway::start(
        "launch-not-running",
        script(json!({
            "answers": {
                "launchBegin": launch_begin_answer(Value::Null)["launchBegin"].clone()
            }
        })),
    );
    let response = gateway.post("/api/voice-gateway/launch", &json!({}));
    assert_eq!(response.status, 409);
    assert_eq!(
        response.body,
        r#"{"ok":false,"error":"voice_gateway_not_running"}"#
    );
    assert_eq!(
        gateway.runtime_calls().last().cloned().unwrap(),
        json!({ "op": "launchEnd", "id": "launch/1", "revoke": true })
    );
}

#[test]
fn launch_begin_failure_and_throw_follow_the_tables() {
    for (code, status) in [
        ("voice_launch_source_not_found", 404),
        ("voice_launch_source_not_addressable", 400),
        ("voice_launch_expired", 410),
        ("voice_router_not_provisioned", 409),
    ] {
        let gateway = Gateway::start(
            &format!("launch-fail-{status}"),
            script(json!({
                "answers": { "launchBegin": { "ok": false, "code": code } }
            })),
        );
        let response = gateway.post("/api/voice-gateway/launch", &json!({}));
        assert_eq!(response.status, status, "{code}: {}", response.body);
        assert_eq!(response.body, format!(r#"{{"ok":false,"error":"{code}"}}"#));
        assert_eq!(gateway.runtime_calls().len(), 1);
    }

    let gateway = Gateway::start(
        "launch-thrown",
        script(json!({
            "answers": { "launchBegin": { "thrown": { "code": "registry_down", "message": "boom" } } }
        })),
    );
    let response = gateway.post("/api/v1/voice-gateway/launch", &json!({}));
    assert_eq!(response.status, 500, "{}", response.body);
    assert_eq!(response.body, error_body("internal_error", "registry_down"));
    assert_eq!(gateway.runtime_calls().len(), 1);
}

#[test]
fn launch_resolve_decodes_the_id_and_maps_every_code() {
    let gateway = Gateway::start(
        "launch-resolve",
        script(json!({
            "context": { "targetSessionId": "sess-9", "directoryId": "dir-1" },
            "answers": {
                "launchResolve:unknown": { "ok": false, "code": "voice_launch_unknown" },
                "launchResolve:expired": { "ok": false, "code": "voice_launch_expired" },
                "launchResolve:bad": { "ok": false, "code": "voice_launch_scope_invalid" },
                "launchResolve:conflict": { "ok": false, "code": "voice_router_id_conflict" }
            }
        })),
    );
    let response = gateway.get("/api/voice-gateway/launch/My%20Launch");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.header("cache-control"), Some("no-store"));
    assert_eq!(
        response.body,
        text(&json!({
            "ok": true,
            "context": { "targetSessionId": "sess-9", "directoryId": "dir-1" }
        }))
    );
    assert_eq!(
        gateway.runtime_calls().last().cloned().unwrap(),
        json!({ "op": "launchResolve", "launchId": "My Launch" })
    );
    // A percent-encoded slash decodes like decodeURIComponent.
    let encoded = gateway.get("/api/v1/voice-gateway/launch/a%2Fb");
    assert_eq!(encoded.status, 200);
    assert_eq!(
        gateway.runtime_calls().last().cloned().unwrap(),
        json!({ "op": "launchResolve", "launchId": "a/b" })
    );

    for (id, code, status) in [
        ("unknown", "voice_launch_unknown", 404),
        ("expired", "voice_launch_expired", 410),
        ("bad", "voice_launch_scope_invalid", 400),
        ("conflict", "voice_router_id_conflict", 409),
    ] {
        let response = gateway.get(&format!("/api/voice-gateway/launch/{id}"));
        assert_eq!(response.status, status, "{id}: {}", response.body);
        assert_eq!(
            response.body,
            format!(r#"{{"ok":false,"error":"{code}"}}"#),
            "{id}"
        );
    }
    // v1 uses the error DTO and never carries gatewayIds.
    let v1 = gateway.get("/api/v1/voice-gateway/launch/expired");
    assert_eq!(v1.status, 410);
    assert_eq!(
        v1.body,
        error_body("voice_launch_expired", "voice_launch_expired")
    );
}

#[test]
fn malformed_ids_are_400_without_a_host_call() {
    let gateway = Gateway::start("bad-ids", script(json!({})));
    for (method, path) in [
        ("GET", "/api/voice-gateway/launch/%E0%A4%A"),
        ("GET", "/api/v1/voice-gateway/launch/%E0%A4%A"),
        ("GET", "/api/directories/%E0%A4%A/voice-gateway/runtime"),
        ("GET", "/api/v1/directories/%E0%A4%A/voice-gateway/runtime"),
        ("POST", "/api/directories/%E0%A4%A/voice-gateway/restart"),
    ] {
        let response = gateway.request(method, path, None, &[]);
        assert_eq!(response.status, 400, "{method} {path}: {}", response.body);
        assert_eq!(
            response.body,
            error_body("request_error", "request_error"),
            "{method} {path}"
        );
    }
    assert!(gateway.runtime_calls().is_empty());
}

// ── runtime installer and Fleet projections ─────────────────────────────────

#[test]
fn voice_runtime_get_and_install() {
    let gateway = Gateway::start("runtime", script(json!({ "runtime": runtime_status() })));
    let response = gateway.get("/api/voice-runtime");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.header("cache-control"), Some("no-store"));
    assert_eq!(
        response.body,
        text(&json!({ "ok": true, "runtime": runtime_status() }))
    );
    let head = gateway.head("/api/voice-runtime");
    assert_eq!(head.status, 200);
    assert!(head.raw_body.is_empty());
    let v1 = gateway.get("/api/v1/voice-runtime");
    assert_eq!(v1.json()["apiVersion"], json!("v1"));

    let install = gateway.post("/api/voice-runtime/install", &json!({}));
    assert_eq!(install.status, 200, "{}", install.body);
    assert_eq!(install.header("cache-control"), Some("no-store"));
    assert_eq!(
        install.body,
        text(&json!({ "ok": true, "runtime": runtime_status() }))
    );

    let pending = Gateway::start(
        "runtime-install-pending",
        script(json!({
            "answers": {
                "runtimeInstall": {
                    "installed": false,
                    "runtime": { "installed": false, "state": "installing" }
                }
            }
        })),
    );
    let response = pending.post("/api/v1/voice-runtime/install", &json!({}));
    assert_eq!(response.status, 202, "{}", response.body);
    assert_eq!(
        response.body,
        text(&json!({
            "ok": true,
            "runtime": { "installed": false, "state": "installing" },
            "apiVersion": "v1",
            "requestId": "diff-req-1",
            "correlationId": "diff-req-1"
        }))
    );

    let thrown = Gateway::start(
        "runtime-install-thrown",
        script(json!({
            "answers": {
                "runtimeInstall": { "thrown": { "code": "install_failed", "message": "boom" } }
            }
        })),
    );
    let response = thrown.post("/api/voice-runtime/install", &json!({}));
    assert_eq!(response.status, 500, "{}", response.body);
    assert_eq!(
        response.body,
        error_body("internal_error", "install_failed")
    );
}

#[test]
fn fleet_runtime_projects_the_global_child() {
    let gateway = Gateway::start(
        "fleet-runtime",
        script(json!({
            "projectsGlobal": true,
            "status": status_with_url()
        })),
    );
    let response = gateway.get("/api/directories/My%20Dir/voice-gateway/runtime");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.header("cache-control"), Some("no-store"));
    assert_eq!(
        response.body,
        text(&json!({
            "ok": true,
            "runtime": {
                "scope": "global",
                "state": "running",
                "desired": true,
                "url": "http://127.0.0.1:4123/",
                "projectedFrom": "global",
                "requestedDirectoryId": "My Dir"
            }
        }))
    );
    assert_eq!(
        gateway.runtime_calls().last().cloned().unwrap(),
        json!({ "op": "fleetRuntime", "id": "My Dir" })
    );
    let v1 = gateway.get("/api/v1/directories/dir-1/voice-gateway/runtime");
    assert_eq!(v1.json()["apiVersion"], json!("v1"));
}

#[test]
fn fleet_runtime_keeps_the_status_when_the_global_gateway_is_absent() {
    let gateway = Gateway::start(
        "fleet-runtime-local",
        script(json!({
            "projectsGlobal": false,
            "status": { "scope": "directory", "state": "stopped", "url": null }
        })),
    );
    let response = gateway.get("/api/directories/dir-1/voice-gateway/runtime");
    assert_eq!(
        response.body,
        text(&json!({
            "ok": true,
            "runtime": { "scope": "directory", "state": "stopped", "url": null }
        }))
    );
}

#[test]
fn fleet_projection_overrides_an_existing_key_in_place() {
    let gateway = Gateway::start(
        "fleet-projection-order",
        script(json!({
            "projectsGlobal": true,
            "status": {
                "projectedFrom": "stale",
                "state": "running",
                "requestedDirectoryId": "old"
            }
        })),
    );
    let response = gateway.get("/api/directories/dir-9/voice-gateway/runtime");
    assert_eq!(
        response.body,
        text(&json!({
            "ok": true,
            "runtime": {
                "projectedFrom": "global",
                "state": "running",
                "requestedDirectoryId": "dir-9"
            }
        }))
    );
}

#[test]
fn fleet_restart_projects_and_maps_a_throw() {
    let gateway = Gateway::start(
        "fleet-restart",
        script(json!({
            "projectsGlobal": true,
            "status": status_with_url()
        })),
    );
    let response = gateway.post("/api/directories/dir-1/voice-gateway/restart", &json!({}));
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.header("cache-control"), Some("no-store"));
    assert_eq!(
        response.body,
        text(&json!({
            "ok": true,
            "runtime": {
                "scope": "global",
                "state": "running",
                "desired": true,
                "url": "http://127.0.0.1:4123/",
                "projectedFrom": "global",
                "requestedDirectoryId": "dir-1"
            }
        }))
    );
    assert_eq!(
        gateway.runtime_calls().last().cloned().unwrap(),
        json!({ "op": "fleetRestart", "id": "dir-1" })
    );

    let gateway = Gateway::start(
        "fleet-restart-thrown",
        script(json!({
            "answers": {
                "fleetRestart": { "thrown": { "code": "restart_failed", "message": "boom" } }
            }
        })),
    );
    let response = gateway.post("/api/directories/dir-1/voice-gateway/restart", &json!({}));
    assert_eq!(response.status, 500, "{}", response.body);
    assert_eq!(
        response.body,
        error_body("internal_error", "restart_failed")
    );
    // v1 wraps the same safe-error body.
    let v1 = gateway.post(
        "/api/v1/directories/dir-2/voice-gateway/restart",
        &json!({}),
    );
    assert_eq!(v1.status, 500);
    assert_eq!(v1.body, error_body("internal_error", "restart_failed"));
}

// ── host failures and malformed answers ────────────────────────────────────

#[test]
fn host_unavailable_is_the_standard_503() {
    let gateway = Gateway::start("host-down", script(json!({ "hostDown": true })));
    for (method, path, body) in [
        ("GET", "/api/voice-gateway", None),
        ("PUT", "/api/voice-gateway", Some(json!({}))),
        ("DELETE", "/api/voice-gateway", None),
        ("GET", "/api/voice-gateway/runtime", None),
        ("POST", "/api/voice-gateway/restart", Some(json!({}))),
        ("POST", "/api/voice-gateway/launch", Some(json!({}))),
        ("GET", "/api/voice-gateway/launch/launch-1", None),
        ("GET", "/api/voice-runtime", None),
        ("POST", "/api/voice-runtime/install", Some(json!({}))),
        ("GET", "/api/directories/dir-1/voice-gateway/runtime", None),
        (
            "POST",
            "/api/directories/dir-1/voice-gateway/restart",
            Some(json!({})),
        ),
    ] {
        let response = gateway.request(method, path, body.as_ref(), &[]);
        assert_eq!(response.status, 503, "{method} {path}: {}", response.body);
        assert_eq!(response.body, unavailable_body(), "{method} {path}");
        assert_eq!(response.header("cache-control"), None, "{method} {path}");
    }
}

#[test]
fn malformed_host_answers_are_503() {
    let gateway = Gateway::start(
        "bad-shape",
        script(json!({
            "answers": {
                "globalGet": { "gateway": gateway_dto() },
                "globalPut": { "ok": true, "created": true },
                "globalRuntime": { "status": "running" },
                "launchBegin": { "ok": true, "launch": { "id": "x" }, "status": {} },
                "launchResolve:bare": { "ok": true },
                "runtimeGet": {},
                "runtimeInstall": { "ok": true, "installed": "yes", "runtime": {} },
                "fleetRuntime:dir-1": { "projectsGlobal": true, "status": null },
                "fleetRestart:dir-1": { "projectsGlobal": "yes", "status": {} }
            }
        })),
    );
    let cases: Vec<(&str, &str, Option<Value>)> = vec![
        ("GET", "/api/voice-gateway", None),
        ("PUT", "/api/voice-gateway", Some(json!({}))),
        ("GET", "/api/voice-gateway/runtime", None),
        ("POST", "/api/voice-gateway/launch", Some(json!({}))),
        ("GET", "/api/voice-gateway/launch/bare", None),
        ("GET", "/api/voice-runtime", None),
        ("POST", "/api/voice-runtime/install", Some(json!({}))),
        ("GET", "/api/directories/dir-1/voice-gateway/runtime", None),
        (
            "POST",
            "/api/directories/dir-1/voice-gateway/restart",
            Some(json!({})),
        ),
    ];
    for (method, path, body) in cases {
        let response = gateway.request(method, path, body.as_ref(), &[]);
        assert_eq!(response.status, 503, "{method} {path}: {}", response.body);
        assert_eq!(response.body, unavailable_body(), "{method} {path}");
    }
}

// ── Express behavior and the claim boundary ────────────────────────────────

#[test]
fn options_advertises_the_express_allow_lists() {
    let gateway = Gateway::start("options", script(json!({})));
    for (path, allow) in [
        ("/api/voice-gateway", "GET,HEAD,PUT,DELETE"),
        ("/api/v1/voice-gateway", "GET,HEAD,PUT,DELETE"),
        ("/api/voice-gateway/runtime", "GET,HEAD"),
        ("/api/v1/voice-gateway/runtime", "GET,HEAD"),
        ("/api/voice-gateway/restart", "POST"),
        ("/api/v1/voice-gateway/restart", "POST"),
        ("/api/voice-gateway/launch", "POST"),
        ("/api/v1/voice-gateway/launch", "POST"),
        ("/api/voice-gateway/launch/abc", "GET,HEAD"),
        ("/api/v1/voice-gateway/launch/abc", "GET,HEAD"),
        ("/api/voice-runtime", "GET,HEAD"),
        ("/api/v1/voice-runtime", "GET,HEAD"),
        ("/api/voice-runtime/install", "POST"),
        ("/api/v1/voice-runtime/install", "POST"),
        ("/api/directories/dir-1/voice-gateway/runtime", "GET,HEAD"),
        (
            "/api/v1/directories/dir-1/voice-gateway/runtime",
            "GET,HEAD",
        ),
        ("/api/directories/dir-1/voice-gateway/restart", "POST"),
        ("/api/v1/directories/dir-1/voice-gateway/restart", "POST"),
    ] {
        let response = gateway.options(path);
        assert_eq!(response.status, 200, "{path}");
        assert_eq!(response.header("allow"), Some(allow), "{path}");
        assert_eq!(response.body, allow, "{path}");
    }
    assert!(gateway.runtime_calls().is_empty());
}

#[test]
fn claim_boundary_does_not_swallow_the_previous_batch() {
    let gateway = Gateway::start(
        "boundary",
        json!({
            "voiceRuntime": {
                "status": status_with_url(),
                "answers": {
                    "globalRestart": { "status": status_with_url() }
                }
            },
            "voiceGateway": {
                "launch": {
                    "command": "/usr/local/bin/node",
                    "script": "/pkg/src/voice/multicc-acp-agent.mjs",
                    "baseUrl": "http://127.0.0.1:3000"
                },
                "gateway": {
                    "id": "gw-1",
                    "directoryId": "dir-1",
                    "type": "voice_gateway",
                    "provider": "qwen-audio-agent",
                    "enabled": true,
                    "commanderSessionId": "sess-1",
                    "commanderLabel": "main",
                    "binding": { "ready": true, "code": "ok", "canonicalCommanderSessionId": "sess-1" },
                    "createdAt": "2026-01-01T00:00:00.000Z",
                    "updatedAt": "2026-01-01T00:00:00.000Z"
                }
            }
        }),
    );
    // Neither family was claimed by the other: the four-segment legacy
    // inspect path still goes to the previous batch's Rust route, while the
    // five-segment runtime and restart paths stay here.
    let inspect = gateway.get("/api/directories/dir-1/voice-gateway");
    assert_eq!(inspect.status, 200, "{}", inspect.body);
    assert!(!gateway.forwarded("GET", "/api/directories/dir-1/voice-gateway"));
    let runtime = gateway.get("/api/directories/dir-1/voice-gateway/runtime");
    assert_eq!(runtime.status, 200, "{}", runtime.body);
    assert!(!gateway.forwarded("GET", "/api/directories/dir-1/voice-gateway/runtime"));
    let restart = gateway.post("/api/directories/dir-1/voice-gateway/restart", &json!({}));
    assert_eq!(restart.status, 200, "{}", restart.body);
    assert!(!gateway.forwarded("POST", "/api/directories/dir-1/voice-gateway/restart"));
    // The plural voice-gateways list belongs to the previous batch too.
    let list = gateway.get("/api/voice-gateways");
    assert_eq!(list.status, 200, "{}", list.body);
    assert!(!gateway.forwarded("GET", "/api/voice-gateways"));

    // Deeper paths, a different-case /api prefix and unregistered methods all
    // stay with Node.
    for (method, url) in [
        ("GET", "/api/voice-gateway/launch/a/b"),
        ("GET", "/api/voice-gateway/runtime/x"),
        ("GET", "/API/voice-gateway"),
        ("GET", "/api/v1"),
        ("PATCH", "/api/voice-gateway"),
        ("GET", "/api/voice-gateway/restart"),
        ("GET", "/api/directories/dir-1/voice-gateway/runtime/x"),
    ] {
        let response = gateway.request(method, url, None, &[]);
        assert!(
            gateway.forwarded(method, url),
            "{method} {url} should have been forwarded"
        );
        assert_eq!(response.body, "ok", "{method} {url}");
    }
}
