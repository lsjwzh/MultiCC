//! Integration coverage for the provider routes retired from
//! `src/routes/providers.js` and answered by the Rust front door
//! (`native/gateway/src/app/providers.rs`):
//!
//!   GET/HEAD/POST/OPTIONS  /api/providers
//!   GET/HEAD/OPTIONS       /api/providers/stats
//!   POST/OPTIONS           /api/providers/import
//!   PATCH|DELETE/OPTIONS   /api/providers/:appType/:id
//!   POST/OPTIONS           /api/providers/:appType/:id/probe
//!   POST/OPTIONS           /api/providers/:appType/:id/reassign-sessions
//!   POST/OPTIONS           /api/providers/:appType/:id/relay-share
//!   POST/OPTIONS           /api/providers/:appType/:id/relay-models/sync
//!   GET|HEAD/OPTIONS       /api/providers/:appType/:id/relay-import-code
//!   GET|HEAD/DELETE/OPTIONS /api/provider-relay-shares[/:id[/code]]
//!   GET|HEAD/PUT/OPTIONS   /api/provider-defaults
//!
//! The Node process here is only the protocol fixture (PROXY v1 + auth
//! control): it answers `POST /api/__host/providers` from
//! `FIXTURE_HOST_SCRIPT` and appends every payload to
//! `provider-calls.jsonl`. The speed test's loopback hop and the routing test's
//! Jev call are scripted by the same fixture file (`speedtest`, `jev` keys) and
//! logged to `speedtest-calls.jsonl` / `jev-calls.jsonl`.

use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
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
        "multicc-gateway-providers-{}-{tag}-{nanos}",
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
        serde_json::from_str(&self.body).unwrap_or_else(|error| {
            panic!(
                "JSON response: {error}; status {} body {:?}",
                self.status, self.body
            )
        })
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
        Self::start_with_env(tag, script, &[])
    }

    fn start_with_env(tag: &str, script: Value, envs: &[(&str, String)]) -> Self {
        let mut last_log = String::new();
        for attempt in 0..6 {
            match Self::start_once(&format!("{tag}-{attempt}"), &script, envs) {
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

    fn start_once(
        tag: &str,
        script: &Value,
        envs: &[(&str, String)],
    ) -> Result<Self, (String, bool)> {
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
        for (name, value) in envs {
            command.env(name, value);
        }
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

    fn provider_calls(&self) -> Vec<Value> {
        self.calls("provider-calls.jsonl")
    }

    fn fixture_requests(&self) -> Vec<Value> {
        self.calls("requests.log")
    }

    fn forwarded(&self, method: &str, url: &str) -> bool {
        self.fixture_requests().iter().any(|entry| {
            entry["method"].as_str() == Some(method) && entry["url"].as_str() == Some(url)
        })
    }

    fn exchange(
        &self,
        method: &str,
        url: &str,
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
        let payload = body.unwrap_or("");
        let mut request = format!(
            "{method} {url} HTTP/1.1\r\nHost: {host}\r\nX-Request-Id: {request_id}\r\n{lines}"
        );
        if body.is_some() {
            request.push_str("Content-Type: application/json\r\n");
            request.push_str(&format!("Content-Length: {}\r\n", payload.len()));
        }
        request.push_str("Connection: close\r\n\r\n");
        request.push_str(payload);
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

    fn get(&self, url: &str) -> Response {
        self.exchange("GET", url, None, &[])
    }

    fn head(&self, url: &str) -> Response {
        self.exchange("HEAD", url, None, &[])
    }

    fn options(&self, url: &str) -> Response {
        self.exchange("OPTIONS", url, None, &[])
    }

    fn send(&self, method: &str, url: &str, body: &Value) -> Response {
        self.exchange(method, url, Some(&body.to_string()), &[])
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

fn decode_code(code: &str) -> Value {
    let encoded = code.strip_prefix("mcrelay1.").expect("relay code prefix");
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded)
        .expect("base64url payload");
    serde_json::from_slice(&bytes).expect("relay payload JSON")
}

// ── catalog / stats ─────────────────────────────────────────────────────────

#[test]
fn catalog_keeps_the_legacy_body_order_and_query() {
    let facts = json!({
        "ok": true,
        "ccSwitchStatus": { "available": true, "note": "x" },
        "providers": [{ "appType": "claude", "id": "p1", "compatibleClis": ["claude"] }],
        "stats": { "requests": 3 },
        "defaults": { "claude": "p1", "codex": null },
        "limitCacheStaleMs": 5000
    });
    let gateway = Gateway::start(
        "catalog",
        json!({ "providers": { "answers": { "catalog": facts } } }),
    );
    let response = gateway.get("/api/providers?appType=%20claude%20&cli=claude");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_key_order(
        &response.body,
        &[
            "available",
            "ccSwitchAvailable",
            "ccSwitchStatus",
            "providers",
            "defaults",
            "stats",
            "limitCacheStaleMs",
        ],
    );
    assert_eq!(
        gateway.provider_calls(),
        vec![json!({ "op": "catalog", "appType": "claude", "cli": "claude" })]
    );
}

#[test]
fn catalog_omits_cc_switch_available_when_the_host_has_none() {
    let facts = json!({
        "ok": true,
        "ccSwitchStatus": { "note": "x" },
        "providers": [],
        "stats": {},
        "defaults": {},
        "limitCacheStaleMs": null
    });
    let gateway = Gateway::start(
        "catalog-omit",
        json!({ "providers": { "answers": { "catalog": facts } } }),
    );
    let response = gateway.get("/api/providers");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_key_order(
        &response.body,
        &[
            "available",
            "ccSwitchStatus",
            "providers",
            "defaults",
            "stats",
            "limitCacheStaleMs",
        ],
    );
    assert!(
        !response.body.contains("ccSwitchAvailable"),
        "{}",
        response.body
    );
}

#[test]
fn catalog_query_shapes_and_poll_follow_express() {
    let facts = json!({
        "ok": true,
        "providers": [{ "appType": "codex", "id": "account", "isOfficial": true }],
        "stats": {},
        "defaults": {},
        "limitCacheStaleMs": null
    });
    let gateway = Gateway::start(
        "catalog-query",
        json!({ "providers": { "answers": { "catalog": facts } } }),
    );
    // `(req.query.appType || '').trim()` on a qs array/object threw, and the
    // request reached safeErrorHandler before any host call.
    for url in [
        "/api/providers?appType=a&appType=b",
        "/api/providers?appType[x]=1",
        "/api/providers?cli[]=x",
    ] {
        let response = gateway.get(url);
        assert_eq!(response.status, 500, "{url}: {}", response.body);
        let body: Value = serde_json::from_str(&response.body).unwrap();
        assert_eq!(body["error"], json!("internal_error"), "{url}");
        assert_eq!(body["code"], json!("internal_error"), "{url}");
    }
    assert!(gateway.provider_calls().is_empty());
    // Every other poll shape refreshes; only the plain `poll=1` suppresses it.
    for url in [
        "/api/providers?poll=1",
        "/api/providers?poll=2",
        "/api/providers?poll=1&poll=2",
        "/api/providers?poll[x]=1",
    ] {
        let response = gateway.get(url);
        assert_eq!(response.status, 200, "{url}: {}", response.body);
    }
    assert_eq!(
        gateway.provider_calls(),
        vec![
            json!({ "op": "catalog", "appType": "", "cli": "" }),
            json!({ "op": "catalog", "appType": "", "cli": "" }),
            json!({ "op": "catalogRefresh", "providerIds": ["account"] }),
            json!({ "op": "catalog", "appType": "", "cli": "" }),
            json!({ "op": "catalogRefresh", "providerIds": ["account"] }),
            json!({ "op": "catalog", "appType": "", "cli": "" }),
            json!({ "op": "catalogRefresh", "providerIds": ["account"] }),
        ]
    );
}

#[test]
fn stats_returns_the_full_usage_object() {
    let gateway = Gateway::start(
        "stats",
        json!({ "providers": { "answers": { "usageStats": { "ok": true, "stats": { "requests": 7, "tokens": 9 } } } } }),
    );
    let response = gateway.get("/api/providers/stats");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.body, r#"{"requests":7,"tokens":9}"#);
}

// ── import / create / update ────────────────────────────────────────────────

#[test]
fn import_spreads_the_result_and_maps_the_frozen_error_dto() {
    let gateway = Gateway::start(
        "import-ok",
        json!({ "providers": { "answers": { "import": { "ok": true, "result": { "imported": 2, "skipped": 1 } } } } }),
    );
    let response = gateway.send("POST", "/api/providers/import", &json!({}));
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.body, r#"{"ok":true,"imported":2,"skipped":1}"#);

    let failing = Gateway::start(
        "import-fail",
        json!({ "providers": { "answers": { "import": { "ok": false, "error": {
            "message": "cc switch unavailable",
            "code": "CC_SWITCH_MISSING",
            "reason": "token: hidden"
        } } } } }),
    );
    let response = failing.send("POST", "/api/providers/import", &json!({}));
    assert_eq!(response.status, 400, "{}", response.body);
    // The reason is re-sanitized: sensitive text becomes the fallback.
    assert_eq!(
        response.json(),
        json!({
            "error": "cc switch unavailable",
            "code": "CC_SWITCH_MISSING",
            "reason": "provider import failed"
        })
    );
    assert_key_order(&response.body, &["error", "code", "reason"]);
}

#[test]
fn create_sends_the_normalized_payload_and_maps_errors() {
    let gateway = Gateway::start(
        "create",
        json!({ "providers": { "answers": { "create": { "ok": true, "result": { "id": "p1", "appType": "claude", "name": "Line" } } } } }),
    );
    let body = json!({
        "appType": " claude ",
        "name": " Line ",
        "baseUrl": " http://x ",
        "authToken": " tok ",
        "model": " m ",
        "models": ["m"],
        "apiFormat": "anthropic",
        "egressIpAllowlist": [" 1.2.3.4 "],
        "egressBinding": { "pluginId": "pl", "profileId": "pr", "extra": "dropped" },
        "unknown": true
    });
    let response = gateway.send("POST", "/api/providers", &body);
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(
        response.body,
        r#"{"ok":true,"id":"p1","appType":"claude","name":"Line"}"#
    );
    assert_eq!(
        gateway.provider_calls(),
        vec![json!({
            "op": "create",
            "body": {
                "appType": "claude",
                "name": " Line ",
                "baseUrl": "http://x",
                "authToken": "tok",
                "model": "m",
                "models": ["m"],
                "apiFormat": "anthropic",
                "egressIpAllowlist": ["1.2.3.4"],
                "egressBinding": { "pluginId": "pl", "profileId": "pr" }
            }
        })]
    );

    // The trimmed createProvider parameter names the failing trim.
    let response = gateway.send("POST", "/api/providers", &json!({ "appType": ["claude"] }));
    assert_eq!(response.status, 400, "{}", response.body);
    assert_eq!(
        response.json()["error"],
        json!(r#"(req.body.appType || "").trim is not a function"#)
    );
    // Egress parsing runs before the object literal, so its error wins.
    let response = gateway.send(
        "POST",
        "/api/providers",
        &json!({ "appType": 7, "egressIpAllowlist": "1.2.3.4" }),
    );
    assert_eq!(response.status, 400, "{}", response.body);
    assert_eq!(
        response.json()["error"],
        json!("egressIpAllowlist must be an array of IP addresses")
    );
    // Neither failure reached the host.
    assert_eq!(gateway.provider_calls().len(), 1);
}

#[test]
fn update_sends_the_raw_patch_and_answers_ok() {
    let gateway = Gateway::start(
        "update",
        json!({ "providers": { "answers": { "update": { "ok": true } } } }),
    );
    let response = gateway.send(
        "PATCH",
        "/api/providers/Claude/Work%201",
        &json!({
            "name": " Raw ",
            "baseUrl": " http://x ",
            "models": ["a"],
            "apiFormat": null,
            "egressBinding": null
        }),
    );
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.body, r#"{"ok":true}"#);
    assert_eq!(
        gateway.provider_calls(),
        vec![json!({
            "op": "update",
            "appType": "Claude",
            "id": "Work 1",
            "body": {
                "name": " Raw ",
                "baseUrl": " http://x ",
                "models": ["a"],
                "apiFormat": null,
                "egressBinding": null
            }
        })]
    );

    let response = gateway.send(
        "PATCH",
        "/api/providers/claude/p1",
        &json!({ "egressIpAllowlist": ["10.0.0.256"] }),
    );
    assert_eq!(response.status, 400, "{}", response.body);
    assert_eq!(
        response.json()["error"],
        json!("egressIpAllowlist contains an invalid IP address: 10.0.0.256")
    );
}

// ── delete ──────────────────────────────────────────────────────────────────

#[test]
fn delete_walks_the_three_way_decision_tree() {
    let gateway = Gateway::start(
        "delete",
        json!({ "providers": { "answers": {
            "deleteFacts:free": { "ok": true, "references": [], "forceable": true },
            "deleteFacts": { "ok": true, "references": [{ "kind": "session", "id": "s1" }], "forceable": true },
            "deleteExec:free": { "ok": true, "deleteOk": true, "detached": [], "failed": [] },
            "deleteExec:busy": { "ok": true, "deleteOk": true, "detached": [{ "kind": "session", "id": "s1" }], "failed": [] },
            "deleteExec:fail": { "ok": true, "deleteOk": false, "detached": [], "failed": [{ "kind": "session", "id": "s9" }] }
        } } }),
    );
    let response = gateway.exchange("DELETE", "/api/providers/claude/busy", None, &[]);
    assert_eq!(response.status, 409, "{}", response.body);
    assert_key_order(
        &response.body,
        &["error", "code", "references", "forceable"],
    );
    assert_eq!(response.json()["code"], json!("PROVIDER_IN_USE"));

    let response = gateway.exchange("DELETE", "/api/providers/claude/free", None, &[]);
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.body, r#"{"ok":true}"#);

    let response = gateway.exchange("DELETE", "/api/providers/claude/busy?force=TRUE", None, &[]);
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(
        response.body,
        r#"{"ok":true,"forced":true,"detached":[{"kind":"session","id":"s1"}]}"#
    );

    let response = gateway.exchange("DELETE", "/api/providers/claude/fail?force=1", None, &[]);
    assert_eq!(response.status, 409, "{}", response.body);
    assert_key_order(
        &response.body,
        &["error", "code", "references", "detached", "forceable"],
    );
    assert_eq!(response.json()["code"], json!("PROVIDER_DETACH_FAILED"));

    let bodies: Vec<Value> = gateway
        .provider_calls()
        .into_iter()
        .filter(|call| call["op"] == "deleteExec")
        .collect();
    assert_eq!(bodies.len(), 3);
    assert_eq!(bodies[0]["references"], json!([]));
    assert_eq!(bodies[1]["references"][0]["id"], json!("s1"));
}

// ── probe ───────────────────────────────────────────────────────────────────

#[test]
fn probe_checks_existence_before_candidates() {
    let gateway = Gateway::start(
        "probe",
        json!({ "providers": { "answers": {
            "probeFacts:missing": { "ok": true, "exists": false },
            "probeFacts:ok": { "ok": true, "exists": true },
            "probeExec": { "ok": true, "result": {
                "tested": [{ "model": "m1", "error": "token: nope" }],
                "accepted": ["m1"]
            } }
        } } }),
    );
    let response = gateway.send(
        "POST",
        "/api/providers/claude/missing/probe",
        &json!({ "candidates": "not-an-array" }),
    );
    assert_eq!(response.status, 404, "{}", response.body);
    assert_eq!(response.json(), json!({ "error": "provider not found" }));

    let response = gateway.send(
        "POST",
        "/api/providers/claude/ok/probe",
        &json!({ "candidates": "x" }),
    );
    assert_eq!(response.status, 400, "{}", response.body);
    assert_eq!(
        response.json(),
        json!({ "error": "probe candidates must be an array" })
    );

    let many: Vec<String> = (0..21).map(|i| format!("m{i}")).collect();
    let response = gateway.send(
        "POST",
        "/api/providers/claude/ok/probe",
        &json!({ "candidates": many }),
    );
    assert_eq!(response.status, 413, "{}", response.body);

    let response = gateway.send(
        "POST",
        "/api/providers/claude/ok/probe",
        &json!({ "candidates": [" m1 ", "m1", "m2"] }),
    );
    assert_eq!(response.status, 200, "{}", response.body);
    // The host already sanitized the result; the front door passes it through.
    assert_eq!(
        response.json(),
        json!({
            "tested": [{ "model": "m1", "error": "token: nope" }],
            "accepted": ["m1"]
        })
    );
    let exec = gateway
        .provider_calls()
        .into_iter()
        .rfind(|call| call["op"] == "probeExec")
        .unwrap();
    assert_eq!(exec["candidates"], json!(["m1", "m2"]));
}

// ── reassign ────────────────────────────────────────────────────────────────

#[test]
fn reassign_keeps_the_validation_order() {
    let gateway = Gateway::start(
        "reassign",
        json!({ "providers": { "answers": {
            "reassignFacts:missing": { "ok": true, "sourceExists": false, "patchRuntime": true },
            "reassignFacts:src": { "ok": true, "sourceExists": true, "patchRuntime": false },
            "reassignFacts:ok": { "ok": true, "sourceExists": true, "patchRuntime": true },
            "reassignFacts:dry": { "ok": true, "sourceExists": true, "patchRuntime": true },
            "reassignFacts:boom": { "ok": true, "sourceExists": true, "patchRuntime": true },
            "reassignTarget:other": { "ok": true, "target": { "id": "other" } },
            "reassignTarget:none": { "ok": true, "target": null },
            "reassignExec:ok": { "ok": true, "result": { "planned": [{ "sessionId": "s1" }], "applied": 0 } },
            "reassignExec:dry": { "ok": true, "result": { "planned": [], "applied": 0 } },
            "reassignExec:boom": { "ok": false, "error": { "message": "provider reassignment failed" } }
        } } }),
    );
    let response = gateway.send(
        "POST",
        "/api/providers/opencode/x/reassign-sessions",
        &json!({}),
    );
    assert_eq!(response.status, 400, "{}", response.body);
    assert_eq!(response.json(), json!({ "error": "invalid app type" }));

    let response = gateway.send(
        "POST",
        "/api/providers/claude/missing/reassign-sessions",
        &json!({ "targetProviderId": "other" }),
    );
    assert_eq!(response.status, 404, "{}", response.body);

    let response = gateway.send(
        "POST",
        "/api/providers/claude/ok/reassign-sessions",
        &json!({ "targetProviderId": " ok " }),
    );
    assert_eq!(response.status, 400, "{}", response.body);
    assert_eq!(
        response.json(),
        json!({ "error": "target provider must differ from the source" })
    );

    let response = gateway.send(
        "POST",
        "/api/providers/claude/ok/reassign-sessions",
        &json!({}),
    );
    assert_eq!(response.status, 400, "{}", response.body);
    assert_eq!(
        response.json(),
        json!({ "error": "targetProviderId is required" })
    );

    let response = gateway.send(
        "POST",
        "/api/providers/claude/ok/reassign-sessions",
        &json!({ "targetProviderId": "none" }),
    );
    assert_eq!(response.status, 404, "{}", response.body);
    assert_eq!(
        response.json(),
        json!({ "error": "target provider not found" })
    );

    let response = gateway.send(
        "POST",
        "/api/providers/claude/src/reassign-sessions",
        &json!({ "targetProviderId": "other" }),
    );
    assert_eq!(response.status, 409, "{}", response.body);
    assert_eq!(
        response.json(),
        json!({ "error": "session patch runtime unavailable" })
    );

    let response = gateway.send(
        "POST",
        "/api/providers/claude/ok/reassign-sessions",
        &json!({ "targetProviderId": "other" }),
    );
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(
        response.json(),
        json!({ "planned": [{ "sessionId": "s1" }], "applied": 0 })
    );

    let response = gateway.send(
        "POST",
        "/api/providers/claude/dry/reassign-sessions",
        &json!({ "dryRun": "1" }),
    );
    assert_eq!(response.status, 200, "{}", response.body);

    let response = gateway.send(
        "POST",
        "/api/providers/claude/boom/reassign-sessions",
        &json!({ "targetProviderId": "other" }),
    );
    assert_eq!(response.status, 400, "{}", response.body);
    assert_eq!(
        response.json(),
        json!({ "error": "provider reassignment failed" })
    );
}

// ── relay share create ──────────────────────────────────────────────────────

#[test]
fn relay_share_builds_the_code_from_the_host_answer() {
    let gateway = Gateway::start(
        "relay-share",
        json!({ "providers": { "answers": {
            "relayShareFacts:missing": { "ok": true, "provider": null, "summary": {} },
            "relayShareFacts": { "ok": true, "provider": { "name": "Foo" }, "summary": { "model": "m1", "modelOptions": ["m2", "m1"] } },
            "relayShareCreate:tok": { "ok": false, "code": "RELAY_TOKEN_INVALID", "error": { "message": "bad token" } },
            "relayShareCreate:bad": { "ok": false, "error": { "message": "relay share create failed" } },
            "relayShareCreate": { "ok": true, "share": { "id": "share-1" }, "credential": "cred-1" }
        } } }),
    );
    let response = gateway.send(
        "POST",
        "/api/providers/claude/missing/relay-share",
        &json!({ "publicBaseUrl": "https://example.com" }),
    );
    assert_eq!(response.status, 404, "{}", response.body);

    let response = gateway.send(
        "POST",
        "/api/providers/claude/p1/relay-share",
        &json!({ "publicBaseUrl": "ftp://example.com" }),
    );
    assert_eq!(response.status, 400, "{}", response.body);
    assert_eq!(
        response.json(),
        json!({ "error": "publicBaseUrl must be an http(s) URL" })
    );

    let response = gateway.send(
        "POST",
        "/api/providers/claude/p1/relay-share",
        &json!({ "publicBaseUrl": "https://Example.com/base?q=1", "token": "tok", "label": "l" }),
    );
    assert_eq!(response.status, 200, "{}", response.body);
    let body = response.json();
    assert_eq!(body["ok"], json!(true));
    assert_eq!(
        body["baseUrl"],
        json!("https://example.com/claude-proxy/p1/remote")
    );
    assert_eq!(body["share"], json!({ "id": "share-1" }));
    assert_eq!(
        decode_code(body["code"].as_str().unwrap()),
        json!({
            "v": 2,
            "kind": "multicc-relay",
            "name": "Foo · 远程共享",
            "appType": "claude",
            "baseUrl": "https://example.com/claude-proxy/p1/remote",
            "model": "m1",
            "models": ["m1", "m2"],
            "relayShareId": "share-1",
            "authToken": "cred-1"
        })
    );
    let create = gateway
        .provider_calls()
        .into_iter()
        .find(|call| call["op"] == "relayShareCreate")
        .unwrap();
    assert_eq!(
        create,
        json!({
            "op": "relayShareCreate",
            "appType": "claude",
            "id": "p1",
            "providerName": "Foo",
            "publicBaseUrl": "https://example.com",
            "relayBaseUrl": "https://example.com/claude-proxy/p1/remote",
            "token": "tok",
            "label": "l"
        })
    );

    let response = gateway.send(
        "POST",
        "/api/providers/claude/tok/relay-share",
        &json!({ "publicBaseUrl": "https://example.com" }),
    );
    assert_eq!(response.status, 400, "{}", response.body);
    assert_eq!(
        response.json(),
        json!({
            "error": "共享凭据必须为 8–128 位无空格 ASCII 字符",
            "code": "RELAY_TOKEN_INVALID"
        })
    );

    let response = gateway.send(
        "POST",
        "/api/providers/claude/bad/relay-share",
        &json!({ "publicBaseUrl": "https://example.com" }),
    );
    assert_eq!(response.status, 400, "{}", response.body);
    assert_eq!(
        response.json(),
        json!({ "error": "relay share create failed" })
    );
}

// ── relay model sync ────────────────────────────────────────────────────────

#[test]
fn relay_models_sync_maps_every_status() {
    let gateway = Gateway::start(
        "relay-sync",
        json!({ "providers": { "answers": {
            "relayModelsSync:gone": { "ok": true, "found": false, "available": true, "result": null },
            "relayModelsSync:off": { "ok": true, "found": true, "available": false, "result": null },
            "relayModelsSync:notrelay": { "ok": true, "found": true, "available": true, "result": { "ok": false, "reason": "not_relay" } },
            "relayModelsSync:down": { "ok": true, "found": true, "available": true, "result": { "ok": false, "reason": "http_502" } },
            "relayModelsSync": { "ok": true, "found": true, "available": true, "result": { "ok": true, "models": ["m1"] } }
        } } }),
    );
    let cases = [
        ("gone", 404, json!({ "ok": false, "reason": "not_found" })),
        (
            "off",
            503,
            json!({ "ok": false, "reason": "relay_model_sync_unavailable" }),
        ),
        (
            "notrelay",
            400,
            json!({ "ok": false, "reason": "not_relay" }),
        ),
        ("down", 502, json!({ "ok": false, "reason": "http_502" })),
        ("ok", 200, json!({ "ok": true, "models": ["m1"] })),
    ];
    for (id, status, expected) in cases {
        let response = gateway.send(
            "POST",
            &format!("/api/providers/claude/{id}/relay-models/sync"),
            &json!({}),
        );
        assert_eq!(response.status, status, "{id}: {}", response.body);
        assert_eq!(response.json(), expected, "{id}");
    }
}

// ── relay shares inventory ──────────────────────────────────────────────────

#[test]
fn relay_shares_list_and_revoke_and_copy() {
    let gateway = Gateway::start(
        "relay-shares",
        json!({ "providers": { "answers": {
            "relaySharesList": { "ok": true, "shares": [{ "id": "s1" }] },
            "relayShareRevoke:s1": { "ok": true, "share": { "id": "s1" } },
            "relayShareRevoke:gone": { "ok": true, "share": null },
            "relayShareRevoke:bad": { "ok": false, "error": { "message": "relay share revoke failed" } },
            "relayShareCodeFacts:s1": { "ok": true, "found": {
                "ok": true,
                "share": { "id": "s1", "appType": "claude", "providerId": "p1", "relayBaseUrl": "https://h/claude-proxy/p1/remote" },
                "credential": "cred-1"
            }, "provider": { "name": "Foo" }, "summary": { "model": "m1" } },
            "relayShareCodeFacts:notfound": { "ok": true, "found": { "ok": false, "code": "not_found" } },
            "relayShareCodeFacts:revoked": { "ok": true, "found": { "ok": false, "code": "revoked" } },
            "relayShareCodeFacts:legacy": { "ok": true, "found": { "ok": false, "code": "legacy" } },
            "relayShareCodeFacts:nocode": { "ok": true, "found": { "ok": false } },
            "relayShareCodeFacts:nullcode": { "ok": true, "found": { "ok": false, "code": null } },
            "relayShareCodeFacts:noprov": { "ok": true, "found": {
                "ok": true,
                "share": { "id": "s1", "appType": "claude", "providerId": "p1", "relayBaseUrl": "https://h/claude-proxy/p1/remote" },
                "credential": "cred-1"
            }, "provider": null, "summary": {} }
        } } }),
    );
    let response = gateway.get("/api/provider-relay-shares?appType=a&appType=b");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.body, r#"{"shares":[{"id":"s1"}]}"#);
    assert_eq!(
        gateway.provider_calls().first().unwrap(),
        &json!({ "op": "relaySharesList", "appType": ["a", "b"] })
    );

    let response = gateway.exchange("DELETE", "/api/provider-relay-shares/s1", None, &[]);
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.body, r#"{"ok":true,"share":{"id":"s1"}}"#);

    let response = gateway.exchange("DELETE", "/api/provider-relay-shares/gone", None, &[]);
    assert_eq!(response.status, 404, "{}", response.body);

    let response = gateway.exchange("DELETE", "/api/provider-relay-shares/bad", None, &[]);
    assert_eq!(response.status, 500, "{}", response.body);
    assert_eq!(
        response.json(),
        json!({ "error": "relay share revoke failed" })
    );

    let response = gateway.get("/api/provider-relay-shares/s1/code");
    assert_eq!(response.status, 200, "{}", response.body);
    let body = response.json();
    assert_eq!(body["baseUrl"], json!("https://h/claude-proxy/p1/remote"));
    assert_eq!(
        decode_code(body["code"].as_str().unwrap()),
        json!({
            "v": 2,
            "kind": "multicc-relay",
            "name": "Foo · 远程共享",
            "appType": "claude",
            "baseUrl": "https://h/claude-proxy/p1/remote",
            "model": "m1",
            "models": ["m1"],
            "relayShareId": "s1",
            "authToken": "cred-1"
        })
    );

    let cases = [
        ("notfound", 404, "relay share not found"),
        ("revoked", 410, "这条分享已撤销，无法再复制"),
        (
            "legacy",
            409,
            "这条分享创建于旧版本，凭据未留存，无法再复制；请新建一条",
        ),
    ];
    for (id, status, error) in cases {
        let response = gateway.get(&format!("/api/provider-relay-shares/{id}/code"));
        assert_eq!(response.status, status, "{id}: {}", response.body);
        assert_eq!(response.json()["error"], json!(error));
    }

    // `res.json({ error, code: found.code })`: an absent code stays absent,
    // an explicit null survives.
    let response = gateway.get("/api/provider-relay-shares/nocode/code");
    assert_eq!(response.status, 409, "{}", response.body);
    assert_eq!(
        response.body,
        "{\"error\":\"这条分享创建于旧版本，凭据未留存，无法再复制；请新建一条\"}"
    );
    let response = gateway.get("/api/provider-relay-shares/nullcode/code");
    assert_eq!(response.status, 409, "{}", response.body);
    assert_eq!(
        response.body,
        "{\"error\":\"这条分享创建于旧版本，凭据未留存，无法再复制；请新建一条\",\"code\":null}"
    );

    let response = gateway.get("/api/provider-relay-shares/noprov/code");
    assert_eq!(response.status, 404, "{}", response.body);
    assert_eq!(response.json(), json!({ "error": "provider not found" }));
}

// ── relay import code ───────────────────────────────────────────────────────

#[test]
fn relay_import_code_rebuilds_only_relay_lines() {
    let token = "mcr1.abcdefghijklmnop.secret123";
    let gateway = Gateway::start(
        "relay-import",
        json!({ "providers": { "answers": {
            "relayImportFacts:missing": { "ok": true, "provider": null, "summary": {}, "token": "" },
            "relayImportFacts:ok": { "ok": true,
                "provider": { "name": "Foo" },
                "summary": { "name": "Summary", "baseUrl": "https://h/claude-proxy/p1/remote", "model": "m1" },
                "token": token },
            "relayImportFacts:notrelay": { "ok": true,
                "provider": { "name": "Foo" },
                "summary": { "baseUrl": "https://h/v1/gateway", "model": "m1" },
                "token": token },
            "relayImportFacts:wrongpool": { "ok": true,
                "provider": { "name": "Foo" },
                "summary": { "baseUrl": "https://h/codex-proxy/p1", "model": "m1" },
                "token": token }
        } } }),
    );
    let response = gateway.get("/api/providers/claude/missing/relay-import-code");
    assert_eq!(response.status, 404, "{}", response.body);

    let response = gateway.get("/api/providers/claude/ok/relay-import-code");
    assert_eq!(response.status, 200, "{}", response.body);
    let body = response.json();
    assert_eq!(body["baseUrl"], json!("https://h/claude-proxy/p1/remote"));
    assert_eq!(
        decode_code(body["code"].as_str().unwrap()),
        json!({
            "v": 2,
            "kind": "multicc-relay",
            "name": "Foo",
            "appType": "claude",
            "baseUrl": "https://h/claude-proxy/p1/remote",
            "model": "m1",
            "models": ["m1"],
            "relayShareId": "abcdefghijklmnop",
            "authToken": token
        })
    );

    for id in ["notrelay", "wrongpool"] {
        let response = gateway.get(&format!("/api/providers/claude/{id}/relay-import-code"));
        assert_eq!(response.status, 400, "{id}: {}", response.body);
        assert_eq!(
            response.json(),
            json!({ "error": "这不是通过分享码导入的借道线路", "code": "not_relay_import" })
        );
    }
}

// ── provider defaults ───────────────────────────────────────────────────────

#[test]
fn defaults_get_and_put_merge_before_persisting() {
    let gateway = Gateway::start(
        "defaults",
        json!({ "providers": { "answers": {
            "defaultsGet": { "ok": true, "defaults": { "claude": null, "codex": "p2" } },
            "defaultsValidate:claude": { "ok": true, "valid": true, "value": "p1" },
            "defaultsValidate:codex": { "ok": true, "valid": false, "value": null },
            "defaultsPersist": { "ok": true, "defaults": { "claude": "p1", "codex": "p2" } }
        } } }),
    );
    let response = gateway.get("/api/provider-defaults");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.body, r#"{"claude":null,"codex":"p2"}"#);

    let response = gateway.send("PUT", "/api/provider-defaults", &json!({ "claude": "p1" }));
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(
        response.body,
        r#"{"ok":true,"defaults":{"claude":"p1","codex":"p2"}}"#
    );
    let persist = gateway
        .provider_calls()
        .into_iter()
        .find(|call| call["op"] == "defaultsPersist")
        .unwrap();
    assert_eq!(persist["next"], json!({ "claude": "p1", "codex": "p2" }));

    let response = gateway.send("PUT", "/api/provider-defaults", &json!({ "codex": "bad" }));
    assert_eq!(response.status, 400, "{}", response.body);
    assert_eq!(
        response.json(),
        json!({ "error": "invalid codex provider id" })
    );
    let persists = gateway
        .provider_calls()
        .into_iter()
        .filter(|call| call["op"] == "defaultsPersist")
        .count();
    assert_eq!(persists, 1);
}

// ── transport, Express behavior and the claim boundary ──────────────────────

#[test]
fn host_down_is_a_503_and_options_never_touches_the_host() {
    let gateway = Gateway::start("host-down", json!({ "hostDown": true }));
    for (method, url) in [
        ("GET", "/api/providers"),
        ("GET", "/api/providers/stats"),
        ("POST", "/api/providers/import"),
        ("POST", "/api/providers/claude/p1/probe"),
    ] {
        let response = gateway.exchange(method, url, Some("{}"), &[]);
        assert_eq!(response.status, 503, "{method} {url}: {}", response.body);
        assert_eq!(
            response.json(),
            json!({
                "error": "供应商接口尚未就绪，请更新原生模块",
                "code": "rust_backend_unavailable"
            }),
            "{method} {url}"
        );
    }

    // Every handler reached the host before it died (the fixture logs the
    // payload first, then destroys the socket), but OPTIONS must not.
    let calls_before_options = gateway.provider_calls().len();
    assert!(calls_before_options >= 4);

    for (url, allow) in [
        ("/api/providers", "GET,HEAD,POST"),
        ("/api/providers/stats", "GET,HEAD"),
        ("/api/providers/import", "POST"),
        ("/api/providers/claude/p1", "PATCH,DELETE"),
        ("/api/providers/claude/p1/probe", "POST"),
        ("/api/providers/claude/p1/reassign-sessions", "POST"),
        ("/api/providers/claude/p1/relay-share", "POST"),
        ("/api/providers/claude/p1/relay-models/sync", "POST"),
        ("/api/providers/claude/p1/relay-import-code", "GET,HEAD"),
        ("/api/provider-relay-shares", "GET,HEAD"),
        ("/api/provider-relay-shares/s1", "DELETE"),
        ("/api/provider-relay-shares/s1/code", "GET,HEAD"),
        ("/api/provider-defaults", "GET,HEAD,PUT"),
    ] {
        let response = gateway.options(url);
        assert_eq!(response.status, 200, "{url}");
        assert_eq!(response.header("allow"), Some(allow), "{url}");
        assert_eq!(
            response.header("content-type"),
            Some("text/html; charset=utf-8"),
            "{url}"
        );
        assert_eq!(response.body, allow, "{url}");
    }
    assert_eq!(gateway.provider_calls().len(), calls_before_options);
}

#[test]
fn head_matches_get_and_post_only_paths_forward() {
    let gateway = Gateway::start(
        "head-speedtest",
        json!({ "providers": { "answers": { "catalog": {
            "ok": true,
            "ccSwitchStatus": { "available": false },
            "providers": [],
            "stats": {},
            "defaults": {},
            "limitCacheStaleMs": null
        } } } }),
    );
    let full = gateway.get("/api/providers");
    let head = gateway.head("/api/providers");
    assert_eq!(head.status, 200);
    assert!(head.body.is_empty());
    assert_eq!(head.header("etag"), full.header("etag"));

    // The POST-only import path has no HEAD route: Express forwarded it.
    let response = gateway.head("/api/providers/import");
    assert_eq!(response.status, 200);
    assert!(gateway.forwarded("HEAD", "/api/providers/import"));
}

#[test]
fn malformed_params_answer_the_safe_error_dto() {
    let gateway = Gateway::start("decode", json!({}));
    for (method, url) in [
        ("GET", "/api/providers/claude/%E0%A4%A/relay-import-code"),
        ("DELETE", "/api/providers/claude/%E0%A4%A"),
        ("GET", "/api/provider-relay-shares/%E0%A4%A/code"),
    ] {
        let response = gateway.exchange(method, url, None, &[]);
        assert_eq!(response.status, 400, "{method} {url}: {}", response.body);
        assert_eq!(
            response.json()["code"],
            json!("request_error"),
            "{method} {url}"
        );
        assert_key_order(
            &response.body,
            &[
                "ok",
                "error",
                "code",
                "apiVersion",
                "requestId",
                "correlationId",
            ],
        );
    }
}

// ── speed test (POST /api/providers/:appType/:id/speedtest) ─────────────────

#[test]
fn speedtest_official_codex_measures_the_loopback_hop() {
    let gateway = Gateway::start(
        "speed-official-codex",
        json!({
            "providers": { "answers": { "speedtestFacts": {
                "ok": true, "found": true, "kind": "codex", "official": true,
                "summary": { "model": "gpt-5-codex" }
            } } },
            "speedtest": { "status": 200, "body": "{}" }
        }),
    );
    let response = gateway.send(
        "POST",
        "/api/providers/codex/codex-one/speedtest",
        &json!({}),
    );
    assert_eq!(response.status, 200, "{}", response.body);
    let body = response.json();
    assert_eq!(body["ok"], json!(true));
    assert!(body["ms"].is_number());
    assert_eq!(body["status"], json!(200));
    assert_eq!(body["model"], json!("gpt-5-codex"));
    let calls = gateway.calls("speedtest-calls.jsonl");
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["url"], json!("/codex-proxy/codex-one/responses"));
    assert_eq!(calls[0]["headers"]["accept"], json!("text/event-stream"));
    let sent: Value = serde_json::from_str(calls[0]["body"].as_str().unwrap()).unwrap();
    assert_eq!(sent["model"], json!("gpt-5-codex"));
    assert_eq!(sent["stream"], json!(true));
}

#[test]
fn speedtest_third_party_codex_without_http_credentials_reports_the_host_reason() {
    let gateway = Gateway::start(
        "speed-official-oauth",
        json!({
            "providers": { "answers": { "speedtestFacts": {
                "ok": true, "found": true, "kind": "codex", "official": false,
                "canDirect": false, "reason": "OAuth 订阅型 provider 不支持测速"
            } } }
        }),
    );
    let response = gateway.send(
        "POST",
        "/api/providers/codex/oauth-one/speedtest",
        &json!({}),
    );
    assert_eq!(response.status, 200, "{}", response.body);
    let body = response.json();
    assert_eq!(body["ok"], json!(false));
    assert_eq!(body["error"], json!("OAuth 订阅型 provider 不支持测速"));
    assert!(gateway.calls("speedtest-calls.jsonl").is_empty());
}

#[test]
fn speedtest_claude_needs_a_key_or_a_base_url() {
    let gateway = Gateway::start(
        "speed-no-key",
        json!({
            "providers": { "answers": { "speedtestFacts": {
                "ok": true, "found": true, "kind": "claude", "official": false,
                "hasKey": false, "env": {}, "summary": {},
                "fallbackModels": [], "wireDefaultModel": "claude-sonnet-4-5"
            } } }
        }),
    );
    let response = gateway.send("POST", "/api/providers/claude/p1/speedtest", &json!({}));
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.json()["ok"], json!(false));
    assert_eq!(response.json()["error"], json!("缺少 API Key 或 Base URL"));
    assert!(gateway.calls("speedtest-calls.jsonl").is_empty());
}

#[test]
fn speedtest_claude_prefers_the_host_summary_model_and_caps_the_body() {
    let gateway = Gateway::start(
        "speed-claude-model",
        json!({
            "providers": { "answers": { "speedtestFacts": {
                "ok": true, "found": true, "kind": "claude", "official": true,
                "hasKey": true,
                "env": { "ANTHROPIC_BASE_URL": "https://relay.test" },
                "summary": { "model": "", "modelOptions": ["claude-opus-5[1m]", "claude-haiku-4-5"] },
                "fallbackModels": [],
                "wireDefaultModel": "claude-sonnet-4-5"
            } } },
            "speedtest": { "status": 502, "body": "x" }
        }),
    );
    // A 70 KB body is past the 64 KB cap, so the probe answers "too large"
    // without buffering the whole upstream reply.
    let script = json!({
        "providers": { "answers": { "speedtestFacts": {
            "ok": true, "found": true, "kind": "claude", "official": true,
            "hasKey": false,
            "env": { "ANTHROPIC_BASE_URL": "https://relay.test" },
            "summary": { "model": "", "modelOptions": ["claude-opus-5[1m]", "claude-haiku-4-5"] },
            "fallbackModels": [],
            "wireDefaultModel": "claude-sonnet-4-5"
        } } },
        "speedtest": { "status": 502, "body": "x".repeat(70 * 1024) }
    });
    drop(gateway);
    let gateway = Gateway::start("speed-claude-model-large", script);
    let response = gateway.send("POST", "/api/providers/claude/p1/speedtest", &json!({}));
    assert_eq!(response.status, 200, "{}", response.body);
    let body = response.json();
    assert_eq!(body["ok"], json!(false));
    assert_eq!(body["status"], json!(502));
    assert_eq!(body["model"], json!("claude-haiku-4-5"));
    assert_eq!(body["error"], json!("response too large"));
    let calls = gateway.calls("speedtest-calls.jsonl");
    assert_eq!(
        calls[0]["url"],
        json!("/claude-proxy/p1/speedtest/v1/messages?beta=true")
    );
    assert_eq!(
        calls[0]["headers"]["authorization"],
        json!("multicc-speedtest")
    );
    assert_eq!(calls[0]["headers"]["x-api-key"], json!("multicc-speedtest"));
    assert_eq!(calls[0]["headers"]["x-app"], json!("cli"));
    let sent: Value = serde_json::from_str(calls[0]["body"].as_str().unwrap()).unwrap();
    assert_eq!(sent["model"], json!("claude-haiku-4-5"));
    assert_eq!(sent["max_tokens"], json!(1));
    assert!(sent["system"].is_array());
}

#[test]
fn speedtest_unknown_provider_is_a_404_and_options_lists_post() {
    let gateway = Gateway::start(
        "speed-missing",
        json!({ "providers": { "answers": { "speedtestFacts": { "ok": true, "found": false } } } }),
    );
    let response = gateway.send("POST", "/api/providers/claude/nope/speedtest", &json!({}));
    assert_eq!(response.status, 404, "{}", response.body);
    assert_eq!(response.json()["error"], json!("provider not found"));

    let options = gateway.options("/api/providers/claude/nope/speedtest");
    assert_eq!(options.status, 200);
    assert_eq!(options.header("allow"), Some("POST"));
}

// ── GET /api/v1/providers ───────────────────────────────────────────────────

#[test]
fn v1_providers_maps_the_host_list_through_the_dto_and_meta_envelope() {
    let gateway = Gateway::start(
        "v1-providers",
        json!({ "providers": { "answers": { "v1Providers": {
            "ok": true,
            "providers": [
                {
                    "id": "p1", "appType": "claude", "name": "Claude One",
                    "model": "claude-haiku-4-5", "modelOptions": ["claude-haiku-4-5", "claude-haiku-4-5"],
                    "compatibleClis": ["claude", "codex"], "hasToken": true,
                    "source": "ccswitch", "isOfficial": true
                }
            ]
        } } } }),
    );
    let response = gateway.exchange(
        "GET",
        "/api/v1/providers?appType=%20claude%20",
        None,
        &[("x-request-id", "req-v1")],
    );
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(
        gateway.provider_calls(),
        vec![json!({ "op": "v1Providers", "appType": "claude" })]
    );
    let body = response.json();
    assert_eq!(body["count"], json!(1));
    assert_eq!(body["apiVersion"], json!("v1"));
    assert_eq!(body["requestId"], json!("req-v1"));
    assert_key_order(
        &response.body,
        &[
            "providers",
            "count",
            "apiVersion",
            "requestId",
            "correlationId",
        ],
    );
    let dto = &body["providers"][0];
    assert_eq!(dto["id"], json!("p1"));
    assert_eq!(dto["protocol"], json!("anthropic"));
    assert_eq!(dto["wireApi"], json!(null));
    assert_eq!(dto["modelOptions"], json!(["claude-haiku-4-5"]));
    assert_eq!(dto["source"], json!("ccswitch"));
    assert_eq!(dto["hasCredentials"], json!(true));
    assert_eq!(dto["isOfficial"], json!(true));
    assert_key_order(
        &serde_json::to_string(dto).unwrap(),
        &[
            "id",
            "appType",
            "protocol",
            "apiFormat",
            "wireApi",
            "name",
            "source",
            "model",
            "modelOptions",
            "aliasOnly",
            "compatibleClis",
            "hasCredentials",
            "isOfficial",
        ],
    );

    // HEAD answers the same headers with an empty body (same supplied id, so
    // the envelope and therefore the ETag are identical).
    let head = gateway.exchange(
        "HEAD",
        "/api/v1/providers?appType=%20claude%20",
        None,
        &[("x-request-id", "req-v1")],
    );
    assert_eq!(head.status, 200);
    assert!(head.body.is_empty());
    assert_eq!(head.header("etag"), response.header("etag"));

    let options = gateway.options("/api/v1/providers");
    assert_eq!(options.status, 200);
    assert_eq!(options.header("allow"), Some("GET,HEAD"));
}

#[test]
fn v1_providers_only_forwards_the_two_known_app_types() {
    let gateway = Gateway::start(
        "v1-providers-filter",
        json!({ "providers": { "answers": { "v1Providers": { "ok": true, "providers": [] } } } }),
    );
    let response = gateway.get("/api/v1/providers?appType=opencode");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(
        gateway.provider_calls(),
        vec![json!({ "op": "v1Providers" })]
    );
    assert_eq!(response.json()["providers"], json!([]));
    assert_eq!(response.json()["count"], json!(0));
}

#[test]
fn v1_providers_host_failure_is_the_safe_500() {
    let gateway = Gateway::start(
        "v1-providers-fail",
        json!({ "providers": { "answers": { "v1Providers": {
            "ok": false, "error": { "message": "provider list failed <script>" }
        } } } }),
    );
    let response = gateway.get("/api/v1/providers");
    assert_eq!(response.status, 500, "{}", response.body);
    // safeErrorHandler hides the thrown message, exactly like Node.
    assert_eq!(response.json()["error"], json!("internal_error"));
}

// ── POST /api/auto-provider/routing/test ────────────────────────────────────

struct JevStub {
    port: u16,
    requests: Arc<std::sync::Mutex<Vec<Value>>>,
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl JevStub {
    fn start(responses: Vec<(u16, String)>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let requests = Arc::new(std::sync::Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let seen = Arc::clone(&requests);
        let flag = Arc::clone(&stop);
        let handle = std::thread::spawn(move || {
            let mut queue = responses.into_iter();
            while !flag.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((mut socket, _)) => {
                        // The listener is non-blocking so `accept` can poll
                        // `stop`; macOS may hand the flag to the accepted
                        // socket, which would make the first `read` return
                        // WouldBlock before the request arrives.
                        socket.set_nonblocking(false).ok();
                        socket.set_read_timeout(Some(Duration::from_secs(5))).ok();
                        let mut raw = Vec::new();
                        let mut buffer = [0u8; 4096];
                        while !raw.windows(4).any(|window| window == b"\r\n\r\n") {
                            match socket.read(&mut buffer) {
                                Ok(0) => break,
                                Ok(n) => raw.extend_from_slice(&buffer[..n]),
                                Err(_) => break,
                            }
                        }
                        let split = raw
                            .windows(4)
                            .position(|window| window == b"\r\n\r\n")
                            .unwrap_or(raw.len());
                        let head = String::from_utf8_lossy(&raw[..split]).to_string();
                        let length = head
                            .lines()
                            .find_map(|line| {
                                let (name, value) = line.split_once(':')?;
                                name.eq_ignore_ascii_case("content-length")
                                    .then(|| value.trim().parse::<usize>().ok())
                                    .flatten()
                            })
                            .unwrap_or(0);
                        let mut body = raw.get(split + 4..).unwrap_or(&[]).to_vec();
                        while body.len() < length {
                            match socket.read(&mut buffer) {
                                Ok(0) => break,
                                Ok(n) => body.extend_from_slice(&buffer[..n]),
                                Err(_) => break,
                            }
                        }
                        let headers: serde_json::Map<String, Value> = head
                            .lines()
                            .skip(1)
                            .filter_map(|line| line.split_once(':'))
                            .map(|(name, value)| {
                                (
                                    name.trim().to_ascii_lowercase(),
                                    Value::String(value.trim().to_string()),
                                )
                            })
                            .collect();
                        seen.lock().unwrap().push(json!({
                            "head": head.lines().next().unwrap_or_default(),
                            "headers": headers,
                            "body": String::from_utf8_lossy(&body),
                        }));
                        let (status, text) = queue.next().unwrap_or_else(|| {
                            (
                                500,
                                "{\"error\":{\"message\":\"stub exhausted\"}}".to_string(),
                            )
                        });
                        let reason = if status == 200 { "OK" } else { "Error" };
                        let reply = format!(
                            "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\n\
                             Content-Length: {}\r\nConnection: close\r\n\r\n{text}",
                            text.len()
                        );
                        let _ = socket.write_all(reply.as_bytes());
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(_) => break,
                }
            }
        });
        Self {
            port,
            requests,
            stop,
            handle: Some(handle),
        }
    }

    fn url(&self) -> String {
        format!("http://127.0.0.1:{}/jev", self.port)
    }

    fn requests(&self) -> Vec<Value> {
        self.requests.lock().unwrap().clone()
    }
}

impl Drop for JevStub {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = TcpStream::connect(("127.0.0.1", self.port));
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

fn routing_script(verdict: Value) -> Value {
    json!({
        "secret": { "reveal": { "ok": true, "name": "VERCEL_API_KEY", "value": "vck_route_test" } },
        "jev": { "status": 200, "body": verdict.to_string() }
    })
}

fn simple_verdict() -> Value {
    json!({
        "answers": {
            "tier": { "type": "choice", "choice": "t1", "probabilities": { "t1": 0.9, "t2": 0.1 } },
            "complexity": { "type": "score", "score": 0, "probabilities": [0.9, 0.1] }
        },
        "providerMetadata": { "typesafe": { "confidence": { "tier": 0.9, "complexity": 0.9 } } }
    })
}

#[test]
fn routing_test_reads_the_vault_names_the_source_and_returns_the_tier() {
    let jev = JevStub::start(vec![(200, simple_verdict().to_string())]);
    let gateway = Gateway::start_with_env(
        "routing-ok",
        routing_script(simple_verdict()),
        &[("MULTICC_ROUTING_TEST_URL", jev.url())],
    );
    let response = gateway.send("POST", "/api/auto-provider/routing/test", &json!({}));
    assert_eq!(response.status, 200, "{}", response.body);
    let body = response.json();
    assert_eq!(body["ok"], json!(true));
    assert_eq!(body["tier"], json!("t1"));
    assert!(body["latencyMs"].is_number());
    assert_key_order(&response.body, &["ok", "tier", "latencyMs"]);

    let secrets = gateway.calls("secret-calls.jsonl");
    assert_eq!(
        secrets,
        vec![json!({ "op": "reveal", "name": "VERCEL_API_KEY", "source": "routing_test" })]
    );
    let calls = jev.requests();
    assert_eq!(calls.len(), 1);
    assert_eq!(
        calls[0]["headers"]["authorization"],
        json!("Bearer vck_route_test")
    );
    let sent: Value = serde_json::from_str(calls[0]["body"].as_str().unwrap()).unwrap();
    assert!(sent["state"]
        .to_string()
        .contains("把 README 里的一个错别字改掉"));
    assert!(!calls[0]["body"]
        .as_str()
        .unwrap()
        .contains("vck_route_test"));
}

#[test]
fn routing_test_rejects_an_unusable_target_before_reading_the_vault() {
    let jev = JevStub::start(vec![]);
    let gateway = Gateway::start_with_env(
        "routing-400",
        routing_script(simple_verdict()),
        &[("MULTICC_ROUTING_TEST_URL", jev.url())],
    );
    for body in [
        json!({ "apiKeyName": "../etc/passwd" }),
        json!({ "gateway": "anthropic" }),
        json!({ "gateway": "custom", "endpoint": "http://jev.example/v1" }),
    ] {
        let response = gateway.send("POST", "/api/auto-provider/routing/test", &body);
        assert_eq!(response.status, 400, "{body}: {}", response.body);
        let json = response.json();
        assert_eq!(json["code"], json!("invalid_routing_target"));
        assert!(json["detail"].is_string());
        assert!(!response.body.contains("../etc/passwd"));
    }
    assert!(gateway.calls("secret-calls.jsonl").is_empty());
    assert!(jev.requests().is_empty());
}

#[test]
fn routing_test_reports_a_gateway_rejection_with_its_scrubbed_detail() {
    let jev = JevStub::start(vec![(
        401,
        "{\"error\":{\"message\":\"Invalid API key <script>\"}}".to_string(),
    )]);
    let gateway = Gateway::start_with_env(
        "routing-401",
        routing_script(simple_verdict()),
        &[("MULTICC_ROUTING_TEST_URL", jev.url())],
    );
    let response = gateway.send("POST", "/api/auto-provider/routing/test", &json!({}));
    assert_eq!(response.status, 200, "{}", response.body);
    let body = response.json();
    assert_eq!(body["ok"], json!(false));
    assert_eq!(body["code"], json!("jev_http_401"));
    assert_eq!(body["status"], json!(401));
    assert_eq!(body["detail"], json!("Invalid API key <script>"));
}

#[test]
fn routing_test_without_a_vault_entry_is_jev_key_missing() {
    let jev = JevStub::start(vec![]);
    let gateway = Gateway::start_with_env(
        "routing-missing-key",
        json!({ "secret": { "reveal": { "ok": false, "reason": "missing" } } }),
        &[("MULTICC_ROUTING_TEST_URL", jev.url())],
    );
    let response = gateway.send("POST", "/api/auto-provider/routing/test", &json!({}));
    assert_eq!(response.status, 200, "{}", response.body);
    let body = response.json();
    assert_eq!(body["ok"], json!(false));
    assert_eq!(body["code"], json!("jev_key_missing"));
    assert!(jev.requests().is_empty());

    let options = gateway.options("/api/auto-provider/routing/test");
    assert_eq!(options.status, 200);
    assert_eq!(options.header("allow"), Some("POST"));
}

// 余额业务在真实 Rust 前门执行，Node 夹具只回答运行时事实。
#[test]
fn balances_cached_unknown_unsupported_and_virtual_members_keep_their_contracts() {
    let gateway = Gateway::start(
        "balances-contracts",
        json!({ "providerBalance": { "answers": {
            "facts:missing": { "ok":true, "found":false },
            "facts:plain": { "ok":true, "found":true, "provider":{"appType":"claude","id":"plain"}, "target":null },
            "facts:pool": { "ok":true, "found":true, "provider":{"appType":"claude","id":"pool","virtual":true} },
            "virtualMember:pool": { "ok":true, "member":null },
            "cached:plain": { "ok":true, "found":true, "entry":null, "snapshot":{"ok":true,"type":"provider_limit_updated","dto":{"kind":"window"},"bar":{"text":"cached"}} },
            "list": { "ok":true, "providers":[{"appType":"claude","id":"plain","name":"Plain"},{"appType":"claude","id":"missing","name":"Missing"}] }
        }}}),
    );
    let missing = gateway.get("/api/providers/claude/missing/balance");
    assert_eq!(missing.status, 404);
    assert_eq!(missing.json(), json!({"ok":false,"reason":"not_found"}));
    let plain = gateway.get("/api/providers/claude/plain/balance");
    assert_eq!(
        plain.json(),
        json!({"ok":false,"reason":"unsupported","providerId":"plain","appType":"claude"})
    );
    let pool = gateway.get("/api/providers/claude/pool/balance");
    assert_eq!(
        pool.json(),
        json!({"ok":false,"reason":"no_available_member","providerId":"pool","appType":"claude","virtual":true})
    );
    let count = gateway.calls("balance-calls.jsonl").len();
    let cached = gateway.get("/api/providers/claude/plain/balance?cached=1");
    assert_eq!(cached.json()["cached"], true);
    let calls = gateway.calls("balance-calls.jsonl");
    assert_eq!(calls.len(), count + 1);
    assert_eq!(calls.last().unwrap()["op"], "cached");
    let all = gateway.get("/api/providers/balances").json();
    assert_eq!(all["results"][0]["name"], "Plain");
    assert_eq!(all["results"][0]["reason"], "unsupported");
    assert_eq!(all["results"][1]["name"], "Missing");
    assert_eq!(all["results"][1]["reason"], "not_found");
    assert!(!gateway.forwarded("GET", "/api/providers/balances"));
}

#[test]
fn balance_live_success_renders_in_core_without_a_host_render_call() {
    let upstream = JevStub::start(vec![(
        200,
        json!({"ok":true,"dto":{"kind":"balance","available":true,"total":25,"currency":"USD"}})
            .to_string(),
    )]);
    let gateway = Gateway::start(
        "balances-native-render",
        json!({ "providerBalance": { "answers": {
            "facts": { "ok":true, "found":true, "provider":{"appType":"claude","id":"work"},
                "target":{"strategy":"relay-quota","relayUrl":upstream.url(),"apiKey":"fixture-key"},
                "egress":{"allowed":true} },
            "record": { "ok":true }
        }}}),
    );
    let response = gateway.get("/api/providers/claude/work/balance");
    assert_eq!(response.status, 200, "{}", response.body);
    let body = response.json();
    assert_eq!(body["ok"], true);
    assert_eq!(body["bar"]["text"], "$25.00");
    assert_eq!(body["bar"]["color"], "#58a6ff");
    let calls = gateway.calls("balance-calls.jsonl");
    assert!(calls.iter().all(|call| call["op"] != "render"));
    assert_eq!(calls.last().unwrap()["op"], "record");
    assert_eq!(calls.last().unwrap()["result"]["bar"], body["bar"]);
    assert_eq!(upstream.requests().len(), 1);
}

#[test]
fn balance_live_failure_records_failure_and_only_management_returns_stale() {
    let gateway = Gateway::start(
        "balances-stale",
        json!({ "providerBalance": { "answers": {
            "facts": { "ok":true, "found":true, "provider":{"appType":"claude","id":"work"},
                "target":{"strategy":"deepseek-balance"}, "egress":{"allowed":false,"detail":"restricted egress"} },
            "record": { "ok":true },
            "cached": { "ok":true, "found":true, "entry":{"summary":{"kind":"balance","total":12.5},"barText":"余额 12.5","fetchedAt":1700000000000_i64} }
        }}}),
    );
    let stale = gateway.get("/api/providers/claude/work/balance").json();
    assert_eq!(stale["ok"], true);
    assert_eq!(stale["stale"], true);
    assert_eq!(stale["dto"]["kind"], "balance");
    assert_eq!(stale["bar"]["color"], "#8b949e");
    assert!(stale["bar"]["text"]
        .as_str()
        .unwrap()
        .contains("{ago:1700000000000}"));
    let before = gateway.calls("balance-calls.jsonl").len();
    let relay = gateway.get("/claude-proxy/work/remote/quota");
    assert_eq!(relay.header("cache-control"), Some("no-store"));
    assert_eq!(relay.json()["reason"], "fetch_failed");
    assert!(relay.json().get("stale").is_none());
    let calls = gateway.calls("balance-calls.jsonl");
    assert!(!calls[before..].iter().any(|row| row["op"] == "cached"));
    for row in calls.iter().filter(|row| row["op"] == "record") {
        assert_eq!(row["result"]["ok"], false);
    }
    let admission = gateway.calls("relay-calls.jsonl");
    assert_eq!(admission.len(), 1);
    assert_eq!(admission[0]["op"], "admission");
    assert_eq!(
        admission[0]["request"]["path"],
        "/claude-proxy/work/remote/quota"
    );
}

#[test]
fn balance_concurrent_requests_share_one_query_but_later_calls_refresh() {
    let gateway = Gateway::start(
        "balances-dedupe",
        json!({ "providerBalance": { "delayMs":100, "answers": {
            "facts": {"ok":true,"found":true,"provider":{"appType":"claude","id":"plain"},"target":null}
        }}}),
    );
    std::thread::scope(|scope| {
        let first = scope.spawn(|| gateway.get("/api/providers/claude/plain/balance"));
        let second = scope.spawn(|| gateway.get("/api/providers/claude/plain/balance"));
        assert_eq!(first.join().unwrap().json()["reason"], "unsupported");
        assert_eq!(second.join().unwrap().json()["reason"], "unsupported");
    });
    assert_eq!(gateway.calls("balance-calls.jsonl").len(), 1);
    assert_eq!(
        gateway.get("/api/providers/claude/plain/balance").status,
        200
    );
    assert_eq!(gateway.calls("balance-calls.jsonl").len(), 2);
}

#[test]
fn relay_balance_denial_precedes_provider_and_credentials_lookup() {
    let gateway = Gateway::start(
        "balances-denied",
        json!({ "providerRelay": { "answers": {
            "admission": {"allowed":false,"status":403,"body":{"error":"share revoked"},"headers":{}}
        }}}),
    );
    let denied = gateway.send("POST", "/codex-proxy/work/quota", &json!({}));
    assert_eq!(denied.status, 403);
    assert_eq!(denied.json()["error"], "share revoked");
    assert!(gateway.calls("balance-calls.jsonl").is_empty());
}
