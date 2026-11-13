//! Integration coverage for the voice-gateway routes retired from
//! `src/routes/voice-gateway.js` and answered by the Rust front door
//! (`native/gateway/src/app/voice_gateway.rs`):
//!
//!   GET/HEAD/OPTIONS     /api/voice-gateways            (+ /api/v1)
//!   GET/HEAD/PUT/DELETE  /api/directories/:id/voice-gateway (+ /api/v1)
//!   OPTIONS              both directory paths
//!
//! The Node process here is only the protocol fixture (PROXY v1 + auth
//! control): it answers `POST /api/__host/voice-gateway` from
//! `FIXTURE_HOST_SCRIPT` and appends every body to
//! `voice-gateway-calls.jsonl`. Status tables, bodies, the ACP launch block,
//! the id decode and the 503s are Rust and are what these tests assert.

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
const NOTE: &str = "Qwen generic ACP 的第三层会话工具会被忽略；任务只由 MultiCC Commander 路由。";

fn unique(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "multicc-gateway-voice-{}-{tag}-{nanos}",
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

    fn voice_calls(&self) -> Vec<Value> {
        self.calls("voice-gateway-calls.jsonl")
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

fn launch() -> Value {
    json!({
        "command": "/usr/local/bin/node",
        "script": "/pkg/src/voice/multicc-acp-agent.mjs",
        "baseUrl": "http://127.0.0.1:3000"
    })
}

fn acp(directory: &str) -> Value {
    json!({
        "protocol": "acp-v1-stdio",
        "command": "/usr/local/bin/node",
        "args": ["/pkg/src/voice/multicc-acp-agent.mjs", "--directory-id", directory],
        "env": { "MULTICC_BASE_URL": "http://127.0.0.1:3000" },
        "note": NOTE
    })
}

fn gateway_dto(directory: &str, id: &str) -> Value {
    json!({
        "id": id,
        "directoryId": directory,
        "type": "voice_gateway",
        "provider": "qwen-audio-agent",
        "enabled": true,
        "commanderSessionId": "sess-1",
        "commanderLabel": "main",
        "binding": {
            "ready": true,
            "code": "ok",
            "canonicalCommanderSessionId": "sess-1"
        },
        "createdAt": "2026-01-01T00:00:00.000Z",
        "updatedAt": "2026-01-01T00:00:00.000Z"
    })
}

/// The same DTO with `acp` last, exactly like `withLaunch`.
fn gateway_with_acp(directory: &str, id: &str) -> Value {
    let mut value = gateway_dto(directory, id);
    value
        .as_object_mut()
        .unwrap()
        .insert("acp".into(), acp(directory));
    value
}

fn script(value: Value) -> Value {
    json!({ "voiceGateway": value })
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
    r#"{"error":"语音网关接口尚未就绪，请更新原生模块","code":"rust_backend_unavailable"}"#
        .to_string()
}

// ── list ────────────────────────────────────────────────────────────────────

#[test]
fn list_legacy_appends_acp_last_and_sets_no_store() {
    let gateway = Gateway::start(
        "list",
        script(json!({
            "launch": launch(),
            "gateways": [
                gateway_dto("dir-1", "gw-1"),
                gateway_dto("dir-2", "gw-2")
            ]
        })),
    );
    let response = gateway.get("/api/voice-gateways");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.header("cache-control"), Some("no-store"));
    assert_eq!(
        response.body,
        text(&json!({
            "ok": true,
            "gateways": [
                gateway_with_acp("dir-1", "gw-1"),
                gateway_with_acp("dir-2", "gw-2")
            ]
        }))
    );
    assert_eq!(gateway.voice_calls(), vec![json!({ "op": "list" })]);
    // One trailing slash and mixed-case literal segments are the same route.
    let slash = gateway.get("/api/Voice-Gateways/");
    assert_eq!(slash.status, 200);
    assert_eq!(slash.body, response.body);
}

#[test]
fn list_v1_skips_acp_and_wraps_the_api_metadata() {
    let gateway = Gateway::start(
        "list-v1",
        script(json!({
            "launch": launch(),
            "gateways": [gateway_dto("dir-1", "gw-1")]
        })),
    );
    let response = gateway.get("/api/v1/voice-gateways");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.header("cache-control"), Some("no-store"));
    assert_eq!(
        response.body,
        text(&json!({
            "ok": true,
            "gateways": [gateway_dto("dir-1", "gw-1")],
            "apiVersion": "v1",
            "requestId": "diff-req-1",
            "correlationId": "diff-req-1"
        }))
    );
}

#[test]
fn head_matches_get_without_a_body() {
    let gateway = Gateway::start(
        "head",
        script(json!({
            "launch": launch(),
            "gateways": [gateway_dto("dir-1", "gw-1")]
        })),
    );
    let full = gateway.get("/api/voice-gateways");
    let head = gateway.head("/api/voice-gateways");
    assert_eq!(head.status, 200);
    assert!(head.raw_body.is_empty(), "HEAD has no body");
    assert_eq!(head.header("content-length"), full.header("content-length"));
    assert_eq!(head.header("etag"), full.header("etag"));
}

// ── inspect ─────────────────────────────────────────────────────────────────

#[test]
fn inspect_decodes_the_id_and_appends_acp() {
    let gateway = Gateway::start(
        "inspect",
        script(json!({
            "launch": launch(),
            "gateway": gateway_dto("My Dir", "gw-1")
        })),
    );
    let response = gateway.get("/api/directories/My%20Dir/voice-gateway");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.header("cache-control"), Some("no-store"));
    assert_eq!(
        response.body,
        text(&json!({
            "ok": true,
            "gateway": gateway_with_acp("My Dir", "gw-1")
        }))
    );
    assert_eq!(
        gateway.voice_calls(),
        vec![json!({ "op": "inspect", "id": "My Dir" })]
    );
    // A percent-encoded slash decodes like decodeURIComponent.
    let encoded = gateway.get("/api/v1/directories/My%20Dir%2Fsub/voice-gateway");
    assert_eq!(encoded.status, 200, "{}", encoded.body);
    assert_eq!(
        gateway.voice_calls().last().cloned().unwrap(),
        json!({ "op": "inspect", "id": "My Dir/sub" })
    );
}

#[test]
fn inspect_v1_keeps_the_gateway_dto_verbatim() {
    let gateway = Gateway::start(
        "inspect-v1",
        script(json!({
            "launch": launch(),
            "gateway": gateway_dto("dir-1", "gw-1")
        })),
    );
    let response = gateway.get("/api/v1/directories/dir-1/voice-gateway");
    assert_eq!(
        response.body,
        text(&json!({
            "ok": true,
            "gateway": gateway_dto("dir-1", "gw-1"),
            "apiVersion": "v1",
            "requestId": "diff-req-1",
            "correlationId": "diff-req-1"
        }))
    );
}

#[test]
fn failure_codes_follow_the_status_table_and_gateway_ids_rule() {
    let gateway = Gateway::start(
        "failures",
        script(json!({
            "answers": {
                "inspect:missing-dir": { "ok": false, "code": "directory_not_found" },
                "inspect:missing-gw": { "ok": false, "code": "voice_gateway_not_found" },
                "inspect:ambiguous": {
                    "ok": false,
                    "code": "voice_gateway_ambiguous",
                    "gatewayIds": ["gw-1", "gw-2"]
                },
                "ensure:owned": { "ok": false, "code": "commander_binding_is_host_owned" },
                "ensure:provider": { "ok": false, "code": "voice_gateway_provider_invalid" },
                "ensure:enabled": { "ok": false, "code": "voice_gateway_enabled_invalid" },
                "ensure:required": { "ok": false, "code": "directory_required" },
                "ensure:missing-dir": { "ok": false, "code": "directory_not_found" },
                "remove:none": { "ok": false, "code": "voice_gateway_not_found" }
            }
        })),
    );

    for (id, status) in [("missing-dir", 404), ("missing-gw", 404)] {
        let response = gateway.get(&format!("/api/directories/{id}/voice-gateway"));
        assert_eq!(response.status, status, "{id}: {}", response.body);
        let code = response.json()["error"].as_str().unwrap().to_string();
        assert_eq!(
            response.body,
            json!({ "ok": false, "error": code }).to_string()
        );
    }

    // Legacy 409 keeps gatewayIds; v1 never does.
    let response = gateway.get("/api/directories/ambiguous/voice-gateway");
    assert_eq!(response.status, 409);
    assert_eq!(
        response.body,
        r#"{"ok":false,"error":"voice_gateway_ambiguous","gatewayIds":["gw-1","gw-2"]}"#
    );
    let response = gateway.get("/api/v1/directories/ambiguous/voice-gateway");
    assert_eq!(response.status, 409);
    assert_eq!(
        response.body,
        error_body("voice_gateway_ambiguous", "voice_gateway_ambiguous")
    );

    for (id, status) in [
        ("owned", 400),
        ("provider", 400),
        ("enabled", 400),
        ("required", 400),
        ("missing-dir", 404),
    ] {
        let response = gateway.put(&format!("/api/directories/{id}/voice-gateway"), &json!({}));
        assert_eq!(response.status, status, "{id}: {}", response.body);
        assert_eq!(
            response.json()["ok"],
            json!(false),
            "{id}: {}",
            response.body
        );
    }
    let response = gateway.delete("/api/directories/none/voice-gateway");
    assert_eq!(response.status, 404);
    assert_eq!(
        response.body,
        r#"{"ok":false,"error":"voice_gateway_not_found"}"#
    );
}

// ── put ─────────────────────────────────────────────────────────────────────

#[test]
fn put_created_is_201_and_update_is_200() {
    let gateway = Gateway::start(
        "put",
        script(json!({
            "launch": launch(),
            "gateway": gateway_dto("dir-1", "gw-1"),
            "answers": {
                "ensure:dir-2": {
                    "ok": true,
                    "created": false,
                    "gateway": gateway_dto("dir-2", "gw-2"),
                    "launch": launch()
                }
            }
        })),
    );

    let response = gateway.put("/api/directories/dir-1/voice-gateway", &json!({}));
    assert_eq!(response.status, 201, "{}", response.body);
    assert_eq!(response.header("cache-control"), Some("no-store"));
    assert_eq!(
        response.body,
        text(&json!({
            "ok": true,
            "created": true,
            "gateway": gateway_with_acp("dir-1", "gw-1")
        }))
    );

    let response = gateway.put("/api/directories/dir-2/voice-gateway", &json!({}));
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.json()["created"], json!(false));

    // v1 drops the ACP block and appends the metadata envelope.
    let response = gateway.put("/api/v1/directories/dir-1/voice-gateway", &json!({}));
    assert_eq!(response.status, 201);
    assert_eq!(
        response.body,
        text(&json!({
            "ok": true,
            "created": true,
            "gateway": gateway_dto("dir-1", "gw-1"),
            "apiVersion": "v1",
            "requestId": "diff-req-1",
            "correlationId": "diff-req-1"
        }))
    );
}

#[test]
fn put_options_only_carry_keys_the_body_sent() {
    let gateway = Gateway::start(
        "put-options",
        script(json!({
            "launch": launch(),
            "gateway": gateway_dto("dir-1", "gw-1")
        })),
    );
    let response = gateway.put(
        "/api/directories/dir-1/voice-gateway",
        &json!({
            "enabled": false,
            "provider": null,
            "commanderSessionId": null,
            "autoInstall": true
        }),
    );
    assert_eq!(response.status, 201, "{}", response.body);
    // Key order is part of the host contract: the host distinguishes undefined
    // from null, so absent keys never appear and null survives.
    assert_eq!(
        gateway.raw_calls("voice-gateway-calls.jsonl"),
        vec![
            r#"{"op":"ensure","id":"dir-1","options":{"enabled":false,"provider":null,"commanderSessionId":null},"autoInstall":true}"#
                .to_string()
        ]
    );

    // Non-object bodies behave like `{}`.
    let response = gateway.put("/api/directories/dir-1/voice-gateway", &json!([1, 2]));
    assert_eq!(response.status, 201, "{}", response.body);
    assert_eq!(
        gateway.voice_calls().last().cloned().unwrap(),
        json!({ "op": "ensure", "id": "dir-1", "options": {}, "autoInstall": false })
    );
}

#[test]
fn put_rejects_a_non_boolean_auto_install_before_the_host() {
    let gateway = Gateway::start(
        "put-precheck",
        script(json!({
            "launch": launch(),
            "gateway": gateway_dto("dir-1", "gw-1")
        })),
    );
    for (path, expected) in [
        (
            "/api/directories/dir-1/voice-gateway",
            r#"{"ok":false,"error":"voice_gateway_auto_install_invalid"}"#.to_string(),
        ),
        (
            "/api/v1/directories/dir-1/voice-gateway",
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
    assert!(gateway.voice_calls().is_empty());
}

// ── delete ──────────────────────────────────────────────────────────────────

#[test]
fn delete_answers_the_host_object_verbatim() {
    let gateway = Gateway::start("delete", script(json!({})));
    let response = gateway.delete("/api/directories/dir-1/voice-gateway");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.header("cache-control"), None);
    assert_eq!(
        response.body,
        r#"{"ok":true,"id":"dir-1","directoryId":"dir-1"}"#
    );
    assert_eq!(
        gateway.voice_calls(),
        vec![json!({ "op": "remove", "id": "dir-1" })]
    );

    let response = gateway.delete("/api/v1/directories/dir-1/voice-gateway");
    assert_eq!(
        response.body,
        text(&json!({
            "ok": true,
            "id": "dir-1",
            "directoryId": "dir-1",
            "apiVersion": "v1",
            "requestId": "diff-req-1",
            "correlationId": "diff-req-1"
        }))
    );
}

// ── host errors ─────────────────────────────────────────────────────────────

#[test]
fn thrown_conflict_is_a_failure_and_other_throws_are_safe_500s() {
    let gateway = Gateway::start(
        "thrown",
        script(json!({
            "answers": {
                "ensure:conflict": { "thrown": { "code": "voice_gateway_id_conflict", "message": "collision" } },
                "ensure:disk": { "thrown": { "code": "disk_full", "message": "no space left" } },
                "ensure:msg": { "thrown": { "message": "no space left" } },
                "remove:disk": { "thrown": { "code": "disk_full", "message": "no space left" } }
            }
        })),
    );

    let response = gateway.put("/api/directories/conflict/voice-gateway", &json!({}));
    assert_eq!(response.status, 409, "{}", response.body);
    assert_eq!(
        response.body,
        r#"{"ok":false,"error":"voice_gateway_id_conflict"}"#
    );

    let response = gateway.put("/api/v1/directories/conflict/voice-gateway", &json!({}));
    assert_eq!(response.status, 409);
    assert_eq!(
        response.body,
        error_body("voice_gateway_id_conflict", "voice_gateway_id_conflict")
    );

    let response = gateway.put("/api/directories/disk/voice-gateway", &json!({}));
    assert_eq!(response.status, 500, "{}", response.body);
    assert_eq!(response.body, error_body("internal_error", "disk_full"));

    // A throw without a code is the plain internal_error DTO.
    let response = gateway.put("/api/directories/msg/voice-gateway", &json!({}));
    assert_eq!(response.status, 500);
    assert_eq!(
        response.body,
        error_body("internal_error", "internal_error")
    );

    let response = gateway.delete("/api/directories/disk/voice-gateway");
    assert_eq!(response.status, 500);
    assert_eq!(response.body, error_body("internal_error", "disk_full"));
}

#[test]
fn host_unavailable_is_the_standard_503() {
    let gateway = Gateway::start("host-down", script(json!({ "hostDown": true })));
    for (method, path) in [
        ("GET", "/api/voice-gateways"),
        ("GET", "/api/directories/dir-1/voice-gateway"),
        ("DELETE", "/api/directories/dir-1/voice-gateway"),
    ] {
        let response = gateway.request(method, path, None, &[]);
        assert_eq!(response.status, 503, "{method} {path}: {}", response.body);
        assert_eq!(response.body, unavailable_body(), "{method} {path}");
        assert_eq!(response.header("cache-control"), None, "{method} {path}");
    }
    let response = gateway.put("/api/directories/dir-1/voice-gateway", &json!({}));
    assert_eq!(response.status, 503);
    assert_eq!(response.body, unavailable_body());
}

#[test]
fn malformed_host_answers_are_503() {
    let gateway = Gateway::start(
        "bad-shape",
        script(json!({
            "answers": {
                "list": { "gateways": "nope", "launch": launch() },
                "inspect:no-gateway": { "ok": true, "gateway": "x", "launch": launch() },
                "inspect:no-launch": { "ok": true, "gateway": gateway_dto("dir-1", "gw-1") },
                "inspect:bad-launch": {
                    "ok": true,
                    "gateway": gateway_dto("dir-1", "gw-1"),
                    "launch": { "command": "node", "script": "x" }
                },
                "inspect:invalid": {},
                "ensure:no-created": {
                    "ok": true,
                    "gateway": gateway_dto("dir-1", "gw-1"),
                    "launch": launch()
                },
                "ensure:thrown-not-object": { "thrown": "boom" },
                "remove:bare-ok": { "ok": true }
            }
        })),
    );

    let cases: Vec<(&str, &str, Option<Value>)> = vec![
        ("GET", "/api/voice-gateways", None),
        ("GET", "/api/directories/no-gateway/voice-gateway", None),
        ("GET", "/api/directories/no-launch/voice-gateway", None),
        ("GET", "/api/directories/bad-launch/voice-gateway", None),
        ("GET", "/api/directories/invalid/voice-gateway", None),
        (
            "PUT",
            "/api/directories/no-created/voice-gateway",
            Some(json!({})),
        ),
        (
            "PUT",
            "/api/directories/thrown-not-object/voice-gateway",
            Some(json!({})),
        ),
        ("DELETE", "/api/directories/bare-ok/voice-gateway", None),
    ];
    for (method, path, body) in cases {
        let response = gateway.request(method, path, body.as_ref(), &[]);
        assert_eq!(response.status, 503, "{method} {path}: {}", response.body);
        assert_eq!(response.body, unavailable_body(), "{method} {path}");
    }

    // One non-object entry in the list is enough.
    let gateway = Gateway::start(
        "bad-list-entry",
        script(json!({
            "answers": { "list": { "gateways": ["x"], "launch": launch() } }
        })),
    );
    let response = gateway.get("/api/voice-gateways");
    assert_eq!(response.status, 503);
    assert_eq!(response.body, unavailable_body());
}

// ── Express behavior and the claim boundary ─────────────────────────────────

#[test]
fn options_advertises_the_express_allow_lists() {
    let gateway = Gateway::start("options", script(json!({})));
    for path in ["/api/voice-gateways", "/api/v1/voice-gateways"] {
        let response = gateway.options(path);
        assert_eq!(response.status, 200, "{path}");
        assert_eq!(response.header("allow"), Some("GET,HEAD"), "{path}");
        assert_eq!(response.body, "GET,HEAD", "{path}");
    }
    for path in [
        "/api/directories/dir-1/voice-gateway",
        "/api/v1/directories/dir-1/voice-gateway",
    ] {
        let response = gateway.options(path);
        assert_eq!(response.status, 200, "{path}");
        assert_eq!(
            response.header("allow"),
            Some("GET,HEAD,PUT,DELETE"),
            "{path}"
        );
        assert_eq!(response.body, "GET,HEAD,PUT,DELETE", "{path}");
    }
    assert!(gateway.voice_calls().is_empty());
}

#[test]
fn malformed_id_escape_is_400_without_a_host_call() {
    let gateway = Gateway::start("bad-id", script(json!({})));
    for path in [
        "/api/directories/%E0%A4%A/voice-gateway",
        "/api/v1/directories/%E0%A4%A/voice-gateway",
    ] {
        let response = gateway.get(path);
        assert_eq!(response.status, 400, "{path}: {}", response.body);
        assert_eq!(
            response.body,
            error_body("request_error", "request_error"),
            "{path}"
        );
    }
    let response = gateway.put(
        "/api/directories/%E0%A4%A/voice-gateway",
        &json!({ "autoInstall": true }),
    );
    assert_eq!(response.status, 400);
    assert!(gateway.voice_calls().is_empty());
}

#[test]
fn claim_boundary_keeps_deeper_paths_and_other_methods_forwarded() {
    let gateway = Gateway::start(
        "boundary",
        script(json!({
            "launch": launch(),
            "gateways": [gateway_dto("dir-1", "gw-1")],
            "gateway": gateway_dto("dir-1", "gw-1")
        })),
    );
    // One trailing slash is claimed, exactly like Express's non-strict routing.
    for path in [
        "/api/voice-gateways/",
        "/api/directories/dir-1/voice-gateway/",
    ] {
        let response = gateway.get(path);
        assert_eq!(response.status, 200, "{path}: {}", response.body);
        assert!(!gateway.forwarded("GET", path), "{path}");
    }
    // Deeper paths, a different case for /api, and unregistered methods still
    // go to Node. `.../voice-gateway/runtime` and `.../restart` now belong to
    // the next batch, so only paths below them stay forwarded here.
    for (method, url) in [
        ("GET", "/api/directories/dir-1/voice-gateway/runtime/extra"),
        ("POST", "/api/directories/dir-1/voice-gateway/restart/extra"),
        ("GET", "/API/voice-gateways"),
        ("POST", "/api/voice-gateways"),
        ("PATCH", "/api/directories/dir-1/voice-gateway"),
        ("GET", "/api/v1"),
    ] {
        let response = gateway.request(method, url, None, &[]);
        assert!(
            gateway.forwarded(method, url),
            "{method} {url} should have been forwarded"
        );
        assert_eq!(response.body, "ok", "{method} {url}");
    }
}
