#![recursion_limit = "256"]

//! Integration coverage for the 16 session-management routes retired from
//! `src/routes/session-memory.js`, `session-bundle.js`, `session-lifecycle.js`,
//! `session-create.js`, `session-meta.js` and `session-profile.js`, answered by
//! the Rust front door (`native/gateway/src/app/session_routes.rs`).
//!
//! The Node process here is only the protocol fixture: it answers
//! `POST /api/__host/session-routes` with `{ ok: true, value }` from
//! `FIXTURE_HOST_SCRIPT.sessionRoutes.ops` and appends every payload to
//! `session-routes-calls.jsonl`, so the tests can assert what the front door
//! asked the runtime to do, and in which order. The internal execution-slot
//! guard rides the session-admin port; its `guard-record` answers come from
//! `FIXTURE_HOST_SCRIPT.sessionAdmin.ops`.
//!
//! Two routes stay in Node: `GET /api/sessions/:id/bundle.zip` and
//! `POST /api/sessions/import-zip` (a binary zip stream and a raw 160 MB body).
//! They are asserted to forward straight to the child, never touching the host.

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

fn unique(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "multicc-gateway-session-routes-{}-{tag}-{nanos}",
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

    fn wait_for_source(&self) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !self.state.join("source-ready").exists() {
            assert!(
                Instant::now() < deadline,
                "share store never registered\n{}",
                self.log()
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn lines(&self, name: &str) -> Vec<Value> {
        fs::read_to_string(self.state.join(name))
            .unwrap_or_default()
            .lines()
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    /// Every payload the front door sent the session-routes host port.
    fn calls(&self) -> Vec<Value> {
        self.lines("session-routes-calls.jsonl")
    }

    fn session_admin_calls(&self) -> Vec<Value> {
        self.lines("session-admin-calls.jsonl")
    }

    fn authorizations(&self) -> Vec<Value> {
        self.lines("source-authorize.jsonl")
    }

    fn exchange(
        &self,
        method: &str,
        url: &str,
        extra: &[(&str, &str)],
        body: Option<&str>,
    ) -> Response {
        let payload = body.unwrap_or("");
        let mut request = format!(
            "{method} {url} HTTP/1.1\r\nHost: localhost\r\nX-Request-Id: session-req-1\r\n"
        );
        for (name, value) in extra {
            request.push_str(&format!("{name}: {value}\r\n"));
        }
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
        self.exchange("GET", url, &[], None)
    }
    fn options(&self, url: &str) -> Response {
        self.exchange("OPTIONS", url, &[], None)
    }
    fn send(&self, method: &str, url: &str, body: &Value) -> Response {
        self.exchange(method, url, &[], Some(&body.to_string()))
    }
    fn send_with(&self, method: &str, url: &str, body: &Value, extra: &[(&str, &str)]) -> Response {
        self.exchange(method, url, extra, Some(&body.to_string()))
    }
    fn post(&self, url: &str, body: &Value) -> Response {
        self.send("POST", url, body)
    }
    fn delete(&self, url: &str) -> Response {
        self.exchange("DELETE", url, &[], None)
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

/// The `value` the host port answers: the retired handler's `{ status, body }`.
fn relay(status: u16, body: Value) -> Value {
    json!({ "status": status, "body": body })
}

fn world(ops: Value) -> Value {
    json!({ "sessionRoutes": { "ops": ops } })
}

/// The headers `tests/test-auth-locality-isolated.js` sends for a share scope.
fn fleet_headers<'a>(token: &'a str, grant: &'a str) -> Vec<(&'static str, &'a str)> {
    vec![
        ("Host", "dashboard.example.test"),
        ("X-Forwarded-For", EXTERNAL_IP),
        ("X-Multicc-Fleet-Token", token),
        ("X-Multicc-Fleet-Grant", grant),
    ]
}

// ── memory ──────────────────────────────────────────────────────────────────

#[test]
fn memory_get_relays_the_projection_byte_for_byte() {
    let gateway = Gateway::start(
        "memory-get",
        world(json!({
            "memory-get": relay(200, json!({
                "own": { "dir": "/d", "primary": "MEMORY.md", "files": [] },
                "shared": { "dir": "/s", "files": [] },
                "legacy": [],
            }))
        })),
    );
    let response = gateway.get("/api/sessions/s1/memory");
    assert_eq!(response.status, 200, "{}", gateway.log());
    assert_eq!(response.json()["own"]["dir"], json!("/d"));
    // The host's key order survives the round trip, so the ETag matches Node's.
    assert_key_order(&response.body, &["own", "shared", "legacy"]);
    assert_eq!(
        gateway.calls(),
        vec![json!({"op": "memory-get", "method": "GET", "id": "s1", "query": {}, "body": {}})]
    );
}

#[test]
fn memory_rejects_an_unknown_session_with_the_relayed_404() {
    let gateway = Gateway::start(
        "memory-404",
        world(json!({"memory-get": relay(404, json!({"error": "session not found"}))})),
    );
    let response = gateway.get("/api/sessions/missing/memory");
    assert_eq!(response.status, 404);
    assert_eq!(response.json(), json!({"error": "session not found"}));
}

#[test]
fn memory_action_is_a_distinct_four_segment_route() {
    let gateway = Gateway::start(
        "memory-action",
        world(json!({"memory-action": relay(200, json!({"ok": true, "message": "added"}))})),
    );
    let response = gateway.post(
        "/api/sessions/s1/memory/action",
        &json!({"scope": "own", "action": "append", "content": "x"}),
    );
    assert_eq!(response.status, 200);
    let call = gateway.calls().remove(0);
    assert_eq!(call["op"], json!("memory-action"));
    assert_eq!(call["id"], json!("s1"));
    assert_eq!(call["body"]["action"], json!("append"));
}

// ── lifecycle ───────────────────────────────────────────────────────────────

#[test]
fn session_delete_relays_the_force_query_and_the_cascade_result() {
    let gateway = Gateway::start(
        "session-delete",
        world(json!({
            "session-delete": relay(200, json!({"ok": true, "id": "s1", "forced": true}))
        })),
    );
    let response = gateway.delete("/api/sessions/s1?force=1");
    assert_eq!(response.status, 200);
    assert_eq!(response.json()["forced"], json!(true));
    let call = gateway.calls().remove(0);
    assert_eq!(call["op"], json!("session-delete"));
    assert_eq!(call["method"], json!("DELETE"));
    assert_eq!(call["query"], json!({"force": "1"}));
}

#[test]
fn relocate_restart_and_restart_spawn_pass_their_bodies() {
    let gateway = Gateway::start(
        "lifecycle-writes",
        world(json!({
            "session-relocate": relay(200, json!({"ok": true, "dirId": "d2"})),
            "session-restart": relay(200, json!({"ok": true, "restarted": true})),
            "session-restart-spawn": relay(200, json!({"ok": true, "cancelled": []})),
        })),
    );
    assert_eq!(
        gateway
            .post("/api/sessions/s1/relocate", &json!({"targetDirId": "d2"}))
            .status,
        200
    );
    assert_eq!(
        gateway.post("/api/sessions/s1/restart", &json!({})).status,
        200
    );
    assert_eq!(
        gateway
            .post(
                "/api/sessions/s1/restart-spawn",
                &json!({"reason": "manual"})
            )
            .status,
        200
    );
    let ops: Vec<Value> = gateway
        .calls()
        .into_iter()
        .map(|call| call["op"].clone())
        .collect();
    assert_eq!(
        ops,
        vec![
            json!("session-relocate"),
            json!("session-restart"),
            json!("session-restart-spawn")
        ]
    );
    assert_eq!(gateway.calls()[2]["body"]["reason"], json!("manual"));
}

#[test]
fn vendor_login_terminal_relays_its_session() {
    let gateway = Gateway::start(
        "vendor-login",
        world(json!({
            "vendor-login-terminal": relay(200, json!({"ok": true, "id": "s1", "url": "/?id=s1"}))
        })),
    );
    let response = gateway.post("/api/sessions/s1/vendor-login-terminal", &json!({}));
    assert_eq!(response.status, 200);
    assert_eq!(gateway.calls()[0]["op"], json!("vendor-login-terminal"));
}

// ── create ──────────────────────────────────────────────────────────────────

#[test]
fn agy_login_terminal_resolves_the_account_before_forwarding() {
    let gateway = Gateway::start(
        "agy-login-terminal",
        world(json!({
            "agy-login-terminal": relay(200, json!({"ok": true, "id": "agy-login", "url": "/?id=agy-login"}))
        })),
    );
    // 账号存储只有 native/core 一份：这里直接按磁盘布局造状态。
    let root = gateway.dir.join("home/.multicc/official-accounts/agy");
    fs::create_dir_all(&root).unwrap();
    let id = "0123456789abcdef";
    let account = root.join(format!("{id}.home"));
    fs::create_dir_all(account.join(".gemini")).unwrap();
    fs::write(
        root.join(format!("{id}.json")),
        json!({"id": id, "label": "工作", "createdAt": 1, "source": "created"}).to_string(),
    )
    .unwrap();

    let response = gateway.post(
        &format!("/api/agy/accounts/{id}/login-terminal"),
        &json!({}),
    );
    assert_eq!(response.status, 200);
    assert_eq!(response.json()["id"], json!("agy-login"));
    let call = gateway.calls().remove(0);
    assert_eq!(call["op"], json!("agy-login-terminal"));
    assert_eq!(call["method"], json!("POST"));
    assert_eq!(call["id"], json!(id));
    // 前门已经解析好账号目录，执行体只拿它起 PTY。
    assert_eq!(call["body"]["home"], json!(account.to_string_lossy()));

    // 未知账号与畸形 id 在前门就被拒，绝不落到宿主。
    let unknown = gateway.post(
        "/api/agy/accounts/ffffffffffffffff/login-terminal",
        &json!({}),
    );
    assert_eq!(unknown.status, 404);
    assert_eq!(unknown.json()["error"], json!("unknown account"));
    let bad = gateway.post("/api/agy/accounts/..%2Fetc/login-terminal", &json!({}));
    assert_eq!(bad.status, 400);
    assert_eq!(bad.json()["error"], json!("invalid account id"));
    assert_eq!(gateway.calls().len(), 1, "refusals never reach the host");
}

#[test]
fn role_workers_put_decodes_both_parameters() {
    let gateway = Gateway::start(
        "role-workers",
        world(json!({
            "role-workers-put": relay(410, json!({"ok": false, "code": "role_sessions_retired"}))
        })),
    );
    let response = gateway.send(
        "PUT",
        "/api/directories/d%201/role-workers/p%2Fx",
        &json!({"workers": []}),
    );
    assert_eq!(response.status, 410);
    let call = gateway.calls().remove(0);
    assert_eq!(call["op"], json!("role-workers-put"));
    assert_eq!(call["id"], json!("d 1"));
    assert_eq!(call["presetId"], json!("p/x"));
}

#[test]
fn directory_create_session_is_a_fleet_scoped_write() {
    let gateway = Gateway::start(
        "directory-create-fleet",
        json!({
            "sessionRoutes": { "ops": {
                "directory-create-session": relay(200, json!({"ok": true, "id": "s9"}))
            }},
            "fleet": { "authorize": {
                "/api/directories/shared-workspace/sessions": true,
                "/api/directories/other-workspace/sessions": false,
            }},
        }),
    );
    gateway.wait_for_source();
    let allowed = gateway.send_with(
        "POST",
        "/api/directories/shared-workspace/sessions",
        &json!({"kind": "chat"}),
        &fleet_headers("fleet_share_token", "grant"),
    );
    assert_eq!(allowed.status, 200, "{}\n{}", allowed.body, gateway.log());
    assert_eq!(allowed.json()["id"], json!("s9"));
    // The write reached the host port for the shared workspace only.
    assert_eq!(gateway.calls().len(), 1);
    assert_eq!(gateway.calls()[0]["id"], json!("shared-workspace"));

    let denied = gateway.send_with(
        "POST",
        "/api/directories/other-workspace/sessions",
        &json!({"kind": "chat"}),
        &fleet_headers("fleet_share_token", "grant"),
    );
    assert_eq!(denied.status, 403, "{}\n{}", denied.body, gateway.log());
    assert_eq!(denied.json()["code"], json!("AUTH_REQUIRED"));
    assert_eq!(gateway.calls().len(), 1, "an unauthorized write never ran");
    let asked: Vec<Value> = gateway
        .authorizations()
        .into_iter()
        .map(|input| input["pathname"].clone())
        .collect();
    assert_eq!(
        asked,
        vec![
            json!("/api/directories/shared-workspace/sessions"),
            json!("/api/directories/other-workspace/sessions"),
        ]
    );
}

// ── meta ────────────────────────────────────────────────────────────────────

#[test]
fn notes_post_and_get_and_the_liveness_probe() {
    let gateway = Gateway::start(
        "notes-liveness",
        world(json!({
            "note-create": relay(200, json!({"id": "n1", "body": "hi"})),
            "notes-list": relay(200, json!({"notes": []})),
            "liveness": relay(200, json!({"state": "alive"})),
        })),
    );
    assert_eq!(
        gateway
            .post(
                "/api/sessions/s1/notes",
                &json!({"toSessionId": "s2", "body": "hi"})
            )
            .status,
        200
    );
    assert_eq!(gateway.get("/api/sessions/s1/notes").status, 200);
    let response = gateway.get("/api/sessions/s1/liveness?probe=0");
    assert_eq!(response.status, 200);
    assert_eq!(response.json()["state"], json!("alive"));
    let calls = gateway.calls();
    assert_eq!(
        calls
            .iter()
            .map(|call| call["op"].clone())
            .collect::<Vec<_>>(),
        vec![json!("note-create"), json!("notes-list"), json!("liveness")]
    );
    assert_eq!(calls[2]["query"], json!({"probe": "0"}));
}

// ── profile ─────────────────────────────────────────────────────────────────

#[test]
fn session_patch_relays_the_status_and_body_in_order() {
    let gateway = Gateway::start(
        "session-patch",
        world(json!({
            "session-patch": relay(200, json!({
                "ok": true,
                "session": {"id": "s1", "label": "Renamed"},
                "effectiveModel": "opus",
            }))
        })),
    );
    let response = gateway.send("PATCH", "/api/sessions/s1", &json!({"label": "Renamed"}));
    assert_eq!(response.status, 200);
    assert_eq!(response.json()["session"]["label"], json!("Renamed"));
    assert_key_order(&response.body, &["ok", "session", "effectiveModel"]);
    let call = gateway.calls().remove(0);
    assert_eq!(call["op"], json!("session-patch"));
    assert_eq!(call["method"], json!("PATCH"));
    assert_eq!(call["body"]["label"], json!("Renamed"));
}

#[test]
fn fork_relays_the_forked_session() {
    let gateway = Gateway::start(
        "session-fork",
        world(json!({
            "session-fork": relay(200, json!({"ok": true, "sessionId": "f1", "replayedMessages": 3}))
        })),
    );
    let response = gateway.post("/api/sessions/s1/fork", &json!({"label": "branch"}));
    assert_eq!(response.status, 200);
    assert_eq!(response.json()["sessionId"], json!("f1"));
    assert_eq!(gateway.calls()[0]["op"], json!("session-fork"));
}

// ── bundle ──────────────────────────────────────────────────────────────────

#[test]
fn bundle_export_and_import_relay_json() {
    let gateway = Gateway::start(
        "bundle-json",
        world(json!({
            "bundle-export": relay(200, json!({"ok": true, "salt": "s", "ct": "c", "meta": {}})),
            "bundle-import": relay(200, json!({"ok": true, "mode": "new", "sessionId": "i1"})),
        })),
    );
    let exported = gateway.get("/api/sessions/s1/bundle?passphrase=hex&git=0&context=0");
    assert_eq!(exported.status, 200, "{}", gateway.log());
    assert_eq!(exported.json()["ok"], json!(true));
    let after_export = gateway.calls();
    assert_eq!(after_export.len(), 1);
    assert_eq!(after_export[0]["query"]["passphrase"], json!("hex"));
    assert_eq!(after_export[0]["query"]["git"], json!("0"));

    let imported = gateway.post(
        "/api/sessions/import",
        &json!({"salt": "s", "iv": "i", "ct": "c", "tag": "t", "passphrase": "hex", "dirId": "d1"}),
    );
    assert_eq!(imported.status, 200);
    let after_import = gateway.calls();
    assert_eq!(after_import[1]["op"], json!("bundle-import"));
    assert_eq!(after_import[1]["body"]["dirId"], json!("d1"));
}

#[test]
fn the_two_binary_bundle_routes_forward_to_node() {
    let gateway = Gateway::start("bundle-binary", world(json!({})));
    // Neither route is claimed: the front door forwards them straight to the
    // child and never asks the session-routes host port.
    let zip = gateway.get("/api/sessions/s1/bundle.zip");
    assert_eq!(
        zip.status, 200,
        "the fixture's generic fallback answered; body {:?}",
        zip.body
    );
    let import = gateway.post("/api/sessions/import-zip", &json!({}));
    assert_eq!(import.status, 200, "body {:?}", import.body);
    assert!(
        gateway.calls().is_empty(),
        "binary transports must not reach the host"
    );
    let forwarded: Vec<Value> = gateway
        .lines("requests.log")
        .into_iter()
        .map(|entry| entry["url"].clone())
        .collect();
    assert!(
        forwarded
            .iter()
            .any(|url| url.as_str() == Some("/api/sessions/s1/bundle.zip")),
        "{forwarded:?}"
    );
    assert!(
        forwarded
            .iter()
            .any(|url| url.as_str() == Some("/api/sessions/import-zip")),
        "{forwarded:?}"
    );
}

// ── the guard, the shared paths and OPTIONS ─────────────────────────────────

#[test]
fn an_internal_execution_slot_404s_before_every_handler() {
    let gateway = Gateway::start(
        "internal-slot",
        json!({
            "sessionAdmin": { "ops": {
                "guard-record:s1": {"record": {"id": "s1"}, "internal": true, "taskStateWritable": true}
            }},
            "sessionRoutes": { "ops": {
                "memory-get": relay(200, json!({"should": "never run"})),
                "session-delete": relay(200, json!({"should": "never run"})),
                "session-patch": relay(200, json!({"should": "never run"})),
                "session-restart": relay(200, json!({"should": "never run"})),
            }},
        }),
    );
    for (method, url) in [
        ("GET", "/api/sessions/s1/memory"),
        ("DELETE", "/api/sessions/s1"),
        ("PATCH", "/api/sessions/s1"),
        ("POST", "/api/sessions/s1/restart"),
        ("OPTIONS", "/api/sessions/s1/memory"),
    ] {
        let response = gateway.exchange(method, url, &[], None);
        assert_eq!(
            response.status, 404,
            "{method} {url}: body {:?}",
            response.body
        );
        assert_eq!(
            response.json(),
            json!({"error": "session not found"}),
            "{method} {url}"
        );
    }
    assert!(
        gateway.calls().is_empty(),
        "no business handler runs for an internal slot: {:?}",
        gateway.calls()
    );
}

#[test]
fn automatic_options_unions_match_express() {
    let gateway = Gateway::start("options", world(json!({})));
    for (url, allow) in [
        ("/api/sessions/s1/memory", "GET,HEAD,PUT,DELETE"),
        ("/api/sessions/s1/memory/action", "POST"),
        ("/api/sessions/s1/bundle", "GET,HEAD"),
        ("/api/sessions/s1/relocate", "POST"),
        ("/api/sessions/s1/restart", "POST"),
        ("/api/sessions/s1/restart-spawn", "POST"),
        ("/api/sessions/s1/vendor-login-terminal", "POST"),
        ("/api/sessions/s1/notes", "POST,GET,HEAD"),
        ("/api/sessions/s1/liveness", "GET,HEAD"),
        ("/api/sessions/s1/fork", "POST"),
        ("/api/directories/d1/role-workers/p1", "PUT"),
        // The shared shape: session-admin's GET/HEAD plus this cluster's
        // PATCH (profile) and DELETE (lifecycle).
        ("/api/sessions/s1", "GET,HEAD,PATCH,DELETE"),
        // The import literals also match `/api/sessions/:id`, so their Allow is
        // the whole-app union: session-admin GET/HEAD, profile PATCH, bundle
        // POST, lifecycle DELETE. `import-zip`'s POST stays in Node, but the
        // retired Express app registered it, so the preflight lists it too.
        ("/api/sessions/import", "GET,HEAD,PATCH,POST,DELETE"),
        ("/api/sessions/import-zip", "GET,HEAD,PATCH,POST,DELETE"),
        // session-admin's GET/HEAD then session-create's POST.
        ("/api/directories/d1/sessions", "GET,HEAD,POST"),
    ] {
        let response = gateway.options(url);
        assert_eq!(response.status, 200, "OPTIONS {url}");
        assert_eq!(response.header("allow"), Some(allow), "OPTIONS {url}");
    }
}

#[test]
fn options_on_an_unknown_path_still_forwards_to_node() {
    let gateway = Gateway::start("options-unknown", world(json!({})));
    let response = gateway.options("/api/not-a-route");
    assert_eq!(response.status, 200, "body {:?}", response.body);
    assert!(
        gateway.calls().is_empty(),
        "an unclaimed path must not reach a host port: {:?}",
        gateway.calls()
    );
    let forwarded: Vec<Value> = gateway
        .lines("requests.log")
        .into_iter()
        .map(|entry| entry["url"].clone())
        .collect();
    assert!(
        forwarded
            .iter()
            .any(|url| url.as_str() == Some("/api/not-a-route")),
        "OPTIONS fell through to Node: {forwarded:?}"
    );
}

#[test]
fn the_shared_session_and_directory_paths_stay_with_session_admin() {
    let gateway = Gateway::start(
        "shared-paths",
        json!({
            "sessionAdmin": { "ops": {
                "directory": {"id": "d1", "name": "one"},
            }},
            "sessionRoutes": { "ops": {
                "directory-create-session": relay(200, json!({"ok": true, "id": "s2"})),
                "session-patch": relay(200, json!({"ok": true})),
            }},
        }),
    );
    // GET on the shared directory path is session-admin's; POST is this cluster's.
    let shared = gateway.get("/api/directories/d1/sessions");
    assert_eq!(shared.status, 200, "{}", gateway.log());
    assert_eq!(shared.json()["directory"]["id"], json!("d1"));
    assert!(
        gateway.calls().is_empty(),
        "GET never reached this cluster's host"
    );

    assert_eq!(
        gateway
            .post("/api/directories/d1/sessions", &json!({"kind": "chat"}))
            .status,
        200
    );
    assert_eq!(gateway.calls()[0]["op"], json!("directory-create-session"));

    // GET `/api/sessions/:id` is session-admin's; PATCH is ours. This cluster
    // never claims the former, so the runtime it asks is session-admin's.
    let _ = gateway.get("/api/sessions/s1");
    assert_eq!(
        gateway.calls().len(),
        1,
        "GET /api/sessions/:id must not reach this cluster: {:?}",
        gateway.calls()
    );
    assert!(!gateway.session_admin_calls().is_empty());
    assert_eq!(
        gateway.send("PATCH", "/api/sessions/s1", &json!({})).status,
        200
    );
    assert_eq!(gateway.calls().len(), 2);
}

#[test]
fn host_unreachable_is_a_503() {
    let gateway = Gateway::start("host-down", json!({"sessionRoutes": {"hostDown": true}}));
    let response = gateway.get("/api/sessions/s1/memory");
    assert_eq!(response.status, 503, "body {:?}", response.body);
    assert_eq!(response.json()["code"], json!("rust_backend_unavailable"));
}

#[test]
fn a_thrown_handler_relays_the_safe_error_envelope() {
    let gateway = Gateway::start(
        "thrown",
        world(json!({
            "session-delete": {
                "threw": true,
                "status": 400,
                "code": "task_bound_session",
                "message": "request_error",
            }
        })),
    );
    let response = gateway.delete("/api/sessions/s1");
    assert_eq!(response.status, 400, "body {:?}", response.body);
    let body = response.json();
    assert_eq!(body["ok"], json!(false));
    assert_eq!(body["error"], json!("request_error"));
    assert_eq!(body["code"], json!("task_bound_session"));
    assert_eq!(body["requestId"], json!("session-req-1"));
}
