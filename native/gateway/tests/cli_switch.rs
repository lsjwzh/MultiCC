//! Integration coverage for `POST /api/sessions/:id/switch-cli`, retired from
//! `src/cli/switch-runtime.js` and answered by the Rust front door
//! (`native/gateway/src/app/cli_switch.rs`, policy in
//! `multicc_core::cli_switch_runtime`).
//!
//! The Node process here is only the protocol fixture (PROXY v1 + auth
//! control): it answers `POST /api/__host/cli-switch` from
//! `FIXTURE_HOST_SCRIPT` and appends every body to `cli-switch-calls.jsonl`, so
//! a test can prove the four entry refusals never triggered a side effect.
//!
//! The front door evaluates `manualGate` itself; the whole post-gate handler is
//! one host `switch` round trip (the `preparations` Map and the signature are
//! TOCTOU protection that must stay in one process). The frozen Node handler is
//! compared byte for byte in docs/rust-migration/differential/cli-switch.js.

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
const SUPPORTED: &[&str] = &["claude", "codex", "opencode"];

fn unique(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "multicc-gateway-cli-switch-{}-{tag}-{nanos}",
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
    /// gateway binds `0.0.0.0`; parallel tests can hand the same ephemeral port
    /// to two gateways, so a bind failure is retried with a fresh port instead
    /// of failing the run.
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

    fn calls(&self, file: &str) -> Vec<Value> {
        fs::read_to_string(self.state.join(file))
            .unwrap_or_default()
            .lines()
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn switch_calls(&self) -> Vec<Value> {
        self.calls("cli-switch-calls.jsonl")
    }

    fn host_ops(&self) -> Vec<String> {
        self.switch_calls()
            .iter()
            .filter_map(|call| call["op"].as_str().map(str::to_string))
            .collect()
    }

    fn fixture_requests(&self) -> Vec<Value> {
        self.calls("requests.log")
    }

    /// Whether the protocol fixture saw this request — i.e. the front door did
    /// not claim it.
    fn forwarded(&self, method: &str, url: &str) -> bool {
        self.fixture_requests().iter().any(|entry| {
            entry["method"].as_str() == Some(method) && entry["url"].as_str() == Some(url)
        })
    }

    fn exchange(
        &self,
        method: &str,
        url: &str,
        content_type: Option<&str>,
        body: Option<&str>,
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
        let mut request =
            format!("{method} {url} HTTP/1.1\r\nHost: {host}\r\nX-Request-Id: {request_id}\r\n");
        if let Some(content_type) = content_type {
            request.push_str(&format!("Content-Type: {content_type}\r\n"));
        }
        if let Some(body) = body {
            request.push_str(&format!("Content-Length: {}\r\n", body.len()));
        }
        request.push_str(&lines);
        request.push_str("Connection: close\r\n\r\n");
        if let Some(body) = body {
            request.push_str(body);
        }
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
        Response {
            status,
            headers,
            body: String::from_utf8_lossy(&raw[split + 4..]).into_owned(),
        }
    }

    fn post(&self, url: &str, body: &Value) -> Response {
        self.exchange(
            "POST",
            url,
            Some("application/json"),
            Some(&body.to_string()),
            &[],
        )
    }

    fn options(&self, url: &str) -> Response {
        self.exchange("OPTIONS", url, None, None, &[])
    }
}

impl Drop for Gateway {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.dir);
    }
}

// ── fixtures ────────────────────────────────────────────────────────────────

/// A chat session projection, the shape `sessionFacts` sends to `manualGate`.
fn session(id: &str, extra: Value) -> Value {
    let mut value = json!({
        "id": id,
        "type": "chat",
        "kind": "chat",
        "cli": "claude",
        "label": format!("Label {id}"),
        "pendingConfiguration": null,
    });
    if let (Some(object), Value::Object(extra)) = (value.as_object_mut(), extra) {
        for (key, item) in extra {
            object.insert(key, item);
        }
    }
    value
}

fn facts(_id: &str, session: Value) -> Value {
    json!({
        "ok": true,
        "exists": true,
        "internalSlot": false,
        "session": session,
        "supported": SUPPORTED,
    })
}

fn script(answers: Value) -> Value {
    json!({ "cliSwitch": { "answers": answers } })
}

// ── tests ───────────────────────────────────────────────────────────────────

#[test]
fn the_four_manual_gate_refusals_never_reach_a_side_effect_host_op() {
    let gateway = Gateway::start(
        "refusals",
        script(json!({
            "facts:s1": facts("s1", session("s1", json!({}))),
            "facts:s-aux": facts("s-aux", session("s-aux", json!({ "type": "aux" }))),
            "facts:s-gw": facts("s-gw", session("s-gw", json!({ "type": "gateway" }))),
            "facts:s-term": facts("s-term", session("s-term", json!({ "kind": "terminal" }))),
        })),
    );

    let missing = gateway.post(
        "/api/sessions/missing/switch-cli",
        &json!({ "cli": "codex" }),
    );
    assert_eq!(missing.status, 404);
    assert_eq!(missing.json(), json!({ "error": "session not found" }));

    for id in ["s-aux", "s-gw"] {
        let response = gateway.post(
            &format!("/api/sessions/{id}/switch-cli"),
            &json!({ "cli": "codex" }),
        );
        assert_eq!(response.status, 400, "{id}: {}", response.body);
        assert_eq!(
            response.json(),
            json!({ "error": "system session must be switched by its bridge controller" })
        );
    }

    let terminal = gateway.post(
        "/api/sessions/s-term/switch-cli",
        &json!({ "cli": "codex" }),
    );
    assert_eq!(terminal.status, 400);
    assert_eq!(
        terminal.json(),
        json!({ "error": "only chat sessions can switch CLI" })
    );

    let unsupported = gateway.post("/api/sessions/s1/switch-cli", &json!({ "cli": "unknown" }));
    assert_eq!(unsupported.status, 400);
    assert_eq!(
        unsupported.json(),
        json!({ "error": "cli must be one of: claude, codex, opencode" })
    );

    // Only the guard/session lookup left the front door.
    let ops = gateway.host_ops();
    assert_eq!(ops, vec!["facts"; 5], "unexpected side effects: {ops:?}");
}

#[test]
fn internal_execution_slots_are_invisible_for_post_and_options() {
    let gateway = Gateway::start(
        "internal",
        script(json!({
            "facts:slot": {
                "ok": true,
                "exists": true,
                "internalSlot": true,
                "session": session("slot", json!({})),
                "supported": SUPPORTED,
            },
        })),
    );

    let post = gateway.post("/api/sessions/slot/switch-cli", &json!({ "cli": "codex" }));
    assert_eq!(post.status, 404);
    assert_eq!(post.json(), json!({ "error": "session not found" }));

    let options = gateway.options("/api/sessions/slot/switch-cli");
    assert_eq!(options.status, 404);
    assert_eq!(options.json(), json!({ "error": "session not found" }));

    assert_eq!(gateway.host_ops(), vec!["facts", "facts"]);
}

#[test]
fn a_same_cli_request_is_one_noop_round_trip() {
    let gateway = Gateway::start(
        "noop",
        script(json!({
            "facts:s1": facts("s1", session("s1", json!({}))),
            "noop:s1": { "ok": true, "body": { "ok": true, "changed": false, "cli": "claude", "pendingCliHandoff": null } },
        })),
    );

    let response = gateway.post("/api/sessions/s1/switch-cli", &json!({ "cli": "claude" }));
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(
        response.json(),
        json!({ "ok": true, "changed": false, "cli": "claude", "pendingCliHandoff": null })
    );
    assert_eq!(gateway.host_ops(), vec!["facts", "noop"]);
    assert_eq!(
        response.header("content-type"),
        Some("application/json; charset=utf-8")
    );
}

#[test]
fn a_switch_relays_the_host_status_and_body() {
    let gateway = Gateway::start(
        "switch",
        script(json!({
            "facts:s1": facts("s1", session("s1", json!({}))),
            "switch:s1": { "ok": true, "status": 200, "body": { "ok": true, "changed": true, "cli": "codex", "fromCli": "claude" } },
        })),
    );

    let response = gateway.post(
        "/api/sessions/s1/switch-cli",
        &json!({ "cli": "codex", "fresh": "1" }),
    );
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.json()["cli"], "codex");
    assert_eq!(gateway.host_ops(), vec!["facts", "switch"]);
    let switch_call = &gateway.switch_calls()[1];
    assert_eq!(switch_call["targetCli"], "codex");
    // The policy unit is JS truthiness: the string "1" is true.
    assert_eq!(switch_call["fresh"], true);
}

#[test]
fn a_busy_session_is_a_200_queue_and_a_changed_session_is_a_409() {
    let gateway = Gateway::start(
        "queue-conflict",
        script(json!({
            "facts:s1": facts("s1", session("s1", json!({}))),
            "switch:s1": { "ok": true, "status": 200, "body": { "ok": true, "changed": false, "deferred": true, "appliesOn": "next_turn" } },
        })),
    );
    let queued = gateway.post("/api/sessions/s1/switch-cli", &json!({ "cli": "codex" }));
    assert_eq!(queued.status, 200);
    assert_eq!(queued.json()["deferred"], true);

    drop(gateway);

    let gateway = Gateway::start(
        "conflict",
        script(json!({
            "facts:s1": facts("s1", session("s1", json!({}))),
            "switch:s1": { "ok": true, "status": 409, "body": { "error": "Session changed during CLI switch preparation; retry the switch.", "code": "cli_switch_changed" } },
        })),
    );
    let conflict = gateway.post("/api/sessions/s1/switch-cli", &json!({ "cli": "codex" }));
    assert_eq!(conflict.status, 409);
    assert_eq!(conflict.json()["code"], "cli_switch_changed");
}

#[test]
fn a_throwing_host_handler_is_a_safe_error_500() {
    let gateway = Gateway::start(
        "throws",
        script(json!({
            "facts:s1": facts("s1", session("s1", json!({}))),
            "switch:s1": {
                "ok": false,
                "status": 500,
                "code": "SESSION_PERSISTENCE_FAILED",
                "detail": "/tmp/sessions.json could not be written",
            },
        })),
    );
    let response = gateway.post("/api/sessions/s1/switch-cli", &json!({ "cli": "codex" }));
    assert_eq!(response.status, 500, "{}", response.body);
    let body = response.json();
    // safeErrorHandler: the generic message, the error's own code, request ids.
    assert_eq!(body["error"], "internal_error");
    assert_eq!(body["code"], "SESSION_PERSISTENCE_FAILED");
    assert!(body["requestId"].is_string(), "{}", response.body);
    assert!(body["correlationId"].is_string(), "{}", response.body);
    // The host's detail goes to the log, never to the client.
    assert!(
        !response.body.contains("sessions.json"),
        "{}",
        response.body
    );
}

#[test]
fn a_legacy_message_only_host_failure_still_hides_the_message() {
    let gateway = Gateway::start(
        "legacy-throw",
        script(json!({
            "facts:s2": facts("s2", session("s2", json!({}))),
            "switch:s2": { "ok": false, "error": { "message": "could not be persisted" } },
        })),
    );
    let response = gateway.post("/api/sessions/s2/switch-cli", &json!({ "cli": "codex" }));
    assert_eq!(response.status, 500, "{}", response.body);
    let body = response.json();
    assert_eq!(body["error"], "internal_error");
    assert_eq!(body["code"], "internal_error");
    assert!(!response.body.contains("could not be persisted"));
}

#[test]
fn an_unreachable_host_port_is_the_documented_503() {
    let gateway = Gateway::start("down", json!({ "cliSwitch": { "hostDown": true } }));
    let response = gateway.post("/api/sessions/s1/switch-cli", &json!({ "cli": "codex" }));
    assert_eq!(response.status, 503, "{}", response.body);
    let body = response.json();
    assert_eq!(body["code"], "rust_backend_unavailable");
    assert_eq!(body["error"], "CLI 切换接口尚未就绪，请更新原生模块");
}

#[test]
fn options_is_post_only_and_other_methods_are_forwarded() {
    let gateway = Gateway::start(
        "methods",
        script(json!({
            "facts:s1": facts("s1", session("s1", json!({}))),
        })),
    );
    let options = gateway.options("/api/sessions/s1/switch-cli");
    assert_eq!(options.status, 200);
    assert_eq!(options.header("allow"), Some("POST"));
    assert_eq!(
        options.header("content-type"),
        Some("text/html; charset=utf-8")
    );
    assert_eq!(options.body, "POST");

    // Only POST was registered. GET/HEAD/PUT/DELETE were never registered, so
    // Express's finalhandler owns them and the front door must pass them on.
    for method in ["GET", "HEAD", "PUT", "DELETE"] {
        let _ = gateway.exchange(method, "/api/sessions/s1/switch-cli", None, None, &[]);
        assert!(
            gateway.forwarded(method, "/api/sessions/s1/switch-cli"),
            "{method} should have been forwarded"
        );
    }
}

#[test]
fn a_malformed_json_body_is_rejected_after_the_guard() {
    let gateway = Gateway::start(
        "bad-json",
        script(json!({
            "facts:s1": facts("s1", session("s1", json!({}))),
        })),
    );
    let response = gateway.exchange(
        "POST",
        "/api/sessions/s1/switch-cli",
        Some("application/json"),
        Some("{"),
        &[],
    );
    assert_eq!(response.status, 400, "{}", response.body);
    assert!(
        response.body.contains("\"error\":\"request_error\""),
        "{}",
        response.body
    );
    assert_eq!(gateway.host_ops(), vec!["facts"]);
}

#[test]
fn the_session_id_is_decoded_like_decode_uri_component() {
    let gateway = Gateway::start(
        "decode",
        script(json!({
            "facts:s 1": facts("s 1", session("s 1", json!({}))),
            "noop:s 1": { "ok": true, "body": { "ok": true, "changed": false, "cli": "claude" } },
        })),
    );
    let response = gateway.post(
        "/api/sessions/s%201/switch-cli",
        &json!({ "cli": "claude" }),
    );
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(gateway.switch_calls()[0]["sessionId"], "s 1");
}

#[test]
fn the_route_literals_match_case_insensitively() {
    let gateway = Gateway::start(
        "case",
        script(json!({
            "facts:s1": facts("s1", session("s1", json!({}))),
            "noop:s1": { "ok": true, "body": { "ok": true, "changed": false, "cli": "claude" } },
        })),
    );
    let response = gateway.post("/api/SESSIONS/s1/Switch-CLI/", &json!({ "cli": "claude" }));
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(gateway.host_ops(), vec!["facts", "noop"]);
}

#[test]
fn a_stale_host_shape_is_a_503_not_a_panic() {
    let gateway = Gateway::start(
        "shape",
        script(json!({
            "facts:s1": { "ok": true, "exists": true },
        })),
    );
    let response = gateway.post("/api/sessions/s1/switch-cli", &json!({ "cli": "codex" }));
    assert_eq!(response.status, 503, "{}", response.body);
    assert_eq!(response.json()["code"], "rust_backend_unavailable");
}
