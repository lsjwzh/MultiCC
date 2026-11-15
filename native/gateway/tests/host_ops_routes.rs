#![recursion_limit = "256"]

//! Integration coverage for the 40 host-and-system-operation routes retired
//! from `src/routes/{server-restart-route,update-route,developer-tools,
//! macos-privacy,ops-terminal,host-write,host-power,skill-sync,doctor,
//! env-doctor}.js`, answered by the Rust front door
//! (`native/gateway/src/app/host_ops_routes.rs`; matching rules in
//! `multicc_core::host_ops_routes`).
//!
//! The Node process here is only the protocol fixture: it answers
//! `POST /api/__host/host-ops` with `{ ok: true, value }` from
//! `FIXTURE_HOST_SCRIPT.hostOps.ops` and appends every payload to
//! `host-ops-calls.jsonl`, so each test asserts exactly what the front door
//! asked Node to do — op name, decoded path parameters, the query subset, the
//! request body Express would have parsed, and the locality fact.
//!
//! Two process-level routes (`POST /api/restart`, `POST /api/update`) are only
//! *validated* by the front door: the detached launcher stays in the host, and
//! the fixture never spawns anything, so the whole branch is safe to drive.
//!
//! Three areas prove the split rather than the payload:
//!
//! * `/api/sessions/:id/doctor` is behind `publicSessionAccessGuard`, which is
//!   answered from the session-admin host port *before* the handler and before
//!   `OPTIONS`; an internal execution slot is a 404 and never reaches the host.
//! * The shared `OPTIONS` paths (`/api/system/ops-run`, the two
//!   `install-git` methods, the unlock-password pair, and the four settings
//!   paths another cluster also reads) must produce Express's unioned `Allow`.
//! * A host that refuses the connection is the 503 `rust_backend_unavailable`;
//!   a handler that threw is the 500 envelope, rebuilt from the DTO without the
//!   thrown message.

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
        "multicc-gateway-host-ops-{}-{tag}-{nanos}",
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

    fn lines(&self, name: &str) -> Vec<Value> {
        fs::read_to_string(self.state.join(name))
            .unwrap_or_default()
            .lines()
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    /// Every payload the front door sent the host-ops port.
    fn calls(&self) -> Vec<Value> {
        self.lines("host-ops-calls.jsonl")
    }

    fn session_admin_calls(&self) -> Vec<Value> {
        self.lines("session-admin-calls.jsonl")
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
        for (name, value) in extra {
            request.push_str(&format!("{name}: {value}\r\n"));
        }
        if body.is_some() {
            request.push_str("Content-Type: application/json\r\n");
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
            stream.write_all(payload).unwrap();
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
    fn head(&self, url: &str) -> Response {
        self.exchange("HEAD", url, &[], None)
    }
    fn options(&self, url: &str) -> Response {
        self.exchange("OPTIONS", url, &[], None)
    }
    fn delete(&self, url: &str) -> Response {
        self.exchange("DELETE", url, &[], None)
    }
    fn send(&self, method: &str, url: &str, body: &Value) -> Response {
        self.exchange(method, url, &[], Some(body.to_string().as_bytes()))
    }
    fn get_with(&self, url: &str, extra: &[(&str, &str)]) -> Response {
        self.exchange("GET", url, extra, None)
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
    json!({ "hostOps": { "ops": ops } })
}

/// An external, authenticated peer: the forwarding header makes the front
/// door's locality fact false, and the token satisfies the ordinary gate.
fn external<'a>() -> Vec<(&'static str, &'a str)> {
    vec![("X-Forwarded-For", EXTERNAL_IP), ("X-Access-Token", TOKEN)]
}

fn ops_sent(calls: &[Value]) -> Vec<String> {
    calls
        .iter()
        .map(|call| call["op"].as_str().unwrap().to_string())
        .collect()
}

// ── process-level：restart / update ─────────────────────────────────────────

#[test]
fn restart_relays_the_accepted_dto_and_passes_the_local_fact() {
    let gateway = Gateway::start(
        "restart",
        world(json!({
            "restart": relay(202, json!({ "ok": true, "restarting": true, "id": "host-req-1" })),
        })),
    );
    let response = gateway.send("POST", "/api/restart", &json!({}));
    assert_eq!(response.status, 202, "{}", gateway.log());
    assert_key_order(&response.body, &["ok", "restarting", "id"]);

    let calls = gateway.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["op"], "restart");
    assert_eq!(calls[0]["method"], "POST");
    assert_eq!(calls[0]["originalUrl"], "/api/restart");
    assert_eq!(calls[0]["local"], true);
    assert_eq!(calls[0]["requestId"], "host-req-1");
    assert_eq!(calls[0]["body"], json!({}));
    assert_eq!(calls[0]["query"], json!({}));
}

#[test]
fn desktop_shutdown_and_update_are_distinct_ops() {
    let gateway = Gateway::start(
        "shutdown-update",
        world(json!({
            "desktop-shutdown": relay(200, json!({ "ok": true })),
            "update": relay(202, json!({ "ok": true, "targetVersion": "2.99.0" })),
        })),
    );
    assert_eq!(
        gateway
            .send("POST", "/api/desktop-shutdown", &json!({}))
            .status,
        200
    );
    let response = gateway.send("POST", "/api/update", &json!({ "version": "2.99.0" }));
    assert_eq!(response.status, 202);
    assert_key_order(&response.body, &["ok", "targetVersion"]);
    assert_eq!(
        ops_sent(&gateway.calls()),
        vec!["desktop-shutdown", "update"]
    );
    assert_eq!(gateway.calls()[1]["body"], json!({ "version": "2.99.0" }));
}

#[test]
fn update_status_reads_are_relayed_with_head() {
    let gateway = Gateway::start(
        "update-status",
        world(json!({
            "update-status": relay(200, json!({
                "currentVersion": "2.14.0",
                "targetVersion": "2.15.0",
                "updateAvailable": true,
            })),
        })),
    );
    let response = gateway.get("/api/update/status");
    assert_eq!(response.status, 200);
    assert_key_order(
        &response.body,
        &["currentVersion", "targetVersion", "updateAvailable"],
    );

    let head = gateway.head("/api/update/status");
    assert_eq!(head.status, 200);
    assert_eq!(head.body, "");

    let calls = gateway.calls();
    assert_eq!(ops_sent(&calls), vec!["update-status", "update-status"]);
    assert_eq!(calls[1]["method"], "HEAD");
}

// ── developer tools ─────────────────────────────────────────────────────────

#[test]
fn developer_tools_probe_and_installs() {
    let gateway = Gateway::start(
        "developer-tools",
        world(json!({
            "developer-tools-status": relay(200, json!({ "xcode": { "installed": true }, "git": { "installed": true } })),
            "developer-tools-install": relay(202, json!({ "ok": true, "started": "xcode" })),
            "developer-tools-install-git-status": relay(200, json!({ "running": false })),
            "developer-tools-install-git": relay(202, json!({ "ok": true, "started": "git" })),
        })),
    );
    assert_eq!(gateway.get("/api/system/developer-tools").status, 200);
    assert_eq!(
        gateway
            .send(
                "POST",
                "/api/system/developer-tools/install",
                &json!({ "tool": "xcode" })
            )
            .status,
        202
    );
    assert_eq!(
        gateway
            .get("/api/system/developer-tools/install-git")
            .status,
        200
    );
    assert_eq!(
        gateway
            .send(
                "POST",
                "/api/system/developer-tools/install-git",
                &json!({})
            )
            .status,
        202
    );
    assert_eq!(
        ops_sent(&gateway.calls()),
        vec![
            "developer-tools-status",
            "developer-tools-install",
            "developer-tools-install-git-status",
            "developer-tools-install-git",
        ]
    );
}

// ── macos privacy / agent install ───────────────────────────────────────────

#[test]
fn macos_privacy_reads_relay_the_no_store_header_and_the_locality_fact() {
    let gateway = Gateway::start(
        "macos-privacy",
        world(json!({
            "disk-access": relay(200, json!({ "granted": true })),
            "disk-access-open": relay(200, json!({ "opened": true })),
            "agent-permissions": {
                "status": 200,
                "body": { "accessibility": true, "screenRecording": false },
                "headers": [["Cache-Control", "no-store"]],
            },
            "agent-permissions-open": relay(200, json!({ "opened": "accessibility" })),
            "agent-permissions-restart": relay(202, json!({ "ok": true })),
            "agent-install": {
                "status": 200,
                "body": { "installed": true },
                "headers": [["Cache-Control", "no-store"]],
            },
            "agent-install-replace": relay(200, json!({ "ok": true })),
        })),
    );
    assert_eq!(gateway.get("/api/system/disk-access").status, 200);
    assert_eq!(
        gateway
            .send("POST", "/api/system/disk-access/open", &json!({}))
            .status,
        200
    );

    let permissions = gateway.get("/api/system/agent-permissions");
    assert_eq!(permissions.status, 200);
    assert_eq!(permissions.header("cache-control"), Some("no-store"));

    // Same route from an external peer: the front door decides `local=false`
    // and the host fabricates a non-loopback socket address from that fact.
    gateway.get_with("/api/system/agent-permissions", &external());
    let calls = gateway.calls();
    let last = calls.last().unwrap();
    assert_eq!(last["op"], "agent-permissions");
    assert_eq!(last["local"], false);
    // The earlier loopback read is the same op with `local=true`.
    assert_eq!(calls[calls.len() - 2]["local"], true);

    assert_eq!(
        gateway
            .send(
                "POST",
                "/api/system/agent-permissions/open",
                &json!({ "target": "accessibility" })
            )
            .status,
        200
    );
    assert_eq!(
        gateway
            .send("POST", "/api/system/agent-permissions/restart", &json!({}))
            .status,
        202
    );
    let install = gateway.get("/api/system/agent-install");
    assert_eq!(install.header("cache-control"), Some("no-store"));
    assert_eq!(
        gateway
            .send(
                "POST",
                "/api/system/agent-install/replace",
                &json!({ "path": "/tmp/Agent.app" })
            )
            .status,
        200
    );
    assert!(ops_sent(&gateway.calls()).contains(&"agent-install-replace".to_string()));
}

// ── repair terminal ─────────────────────────────────────────────────────────

#[test]
fn ops_terminal_forwards_the_from_offset_and_keeps_job_state_in_the_host() {
    let gateway = Gateway::start(
        "ops-terminal",
        world(json!({
            "ops-env": relay(200, json!({ "platform": "darwin", "shell": "/bin/zsh" })),
            "ops-run-status": relay(200, json!({ "running": true, "lines": ["a"], "hasMore": false })),
            "ops-run-start": relay(202, json!({ "ok": true, "running": true })),
            "ops-run-stop": relay(200, json!({ "ok": true, "running": false })),
        })),
    );
    assert_eq!(gateway.get("/api/system/ops-env").status, 200);

    assert_eq!(
        gateway
            .send("POST", "/api/system/ops-run", &json!({ "command": "ls" }))
            .status,
        202
    );
    let status = gateway.get("/api/system/ops-run?from=5");
    assert_eq!(status.status, 200);
    assert_key_order(&status.body, &["running", "lines", "hasMore"]);
    assert_eq!(
        gateway
            .send("POST", "/api/system/ops-run/stop", &json!({}))
            .status,
        200
    );

    let calls = gateway.calls();
    assert_eq!(
        ops_sent(&calls),
        vec!["ops-env", "ops-run-start", "ops-run-status", "ops-run-stop"]
    );
    // `GET /api/system/ops-run` is the only route here that reads a query key,
    // and the front door forwards exactly that subset.
    assert_eq!(calls[2]["method"], "GET");
    assert_eq!(calls[2]["query"], json!({ "from": "5" }));
}

// ── settings / tunnel / power ───────────────────────────────────────────────

#[test]
fn settings_and_tunnel_ops_decode_the_provider_segment() {
    let gateway = Gateway::start(
        "settings-tunnel",
        world(json!({
            "settings-notify": relay(200, json!({ "ok": true })),
            "settings-tunnel": relay(200, json!({ "enabled": true })),
            "tunnel-restart": relay(202, json!({ "ok": true })),
            "tunnel-sakurafrp-public-url": relay(200, json!({ "url": "https://x.example" })),
            "tunnel-funnel": relay(200, json!({ "enabled": false })),
            "settings-access-token": relay(200, json!({ "ok": true })),
        })),
    );
    assert_eq!(
        gateway
            .send("POST", "/api/settings/notify", &json!({ "barkKey": "k" }))
            .status,
        200
    );
    assert_eq!(
        gateway
            .send("POST", "/api/settings/tunnel", &json!({ "mode": "funnel" }))
            .status,
        200
    );
    assert_eq!(
        gateway
            .send("POST", "/api/tunnel/restart/natapp", &json!({}))
            .status,
        202
    );
    // A percent-encoded space and a percent-encoded slash both stay inside the
    // single matcher segment; `decodeURIComponent` runs in Rust, and the host
    // receives the decoded token, never a new path segment.
    assert_eq!(
        gateway
            .send("POST", "/api/tunnel/restart/a%20b", &json!({}))
            .status,
        202
    );
    assert_eq!(
        gateway
            .send("POST", "/api/tunnel/restart/a%2Fb", &json!({}))
            .status,
        202
    );
    assert_eq!(
        gateway
            .send("POST", "/api/tunnel/sakurafrp/public-url", &json!({}))
            .status,
        200
    );
    assert_eq!(
        gateway
            .send("POST", "/api/tunnel/funnel", &json!({ "enabled": false }))
            .status,
        200
    );
    assert_eq!(
        gateway
            .send(
                "POST",
                "/api/settings/access-token",
                &json!({ "token": "t" })
            )
            .status,
        200
    );

    let calls = gateway.calls();
    let restarts: Vec<&Value> = calls
        .iter()
        .filter(|call| call["op"] == "tunnel-restart")
        .collect();
    assert_eq!(restarts.len(), 3);
    assert_eq!(restarts[0]["provider"], "natapp");
    assert_eq!(restarts[1]["provider"], "a b");
    assert_eq!(restarts[2]["provider"], "a/b");
    // A `..` in the provider slot is still one opaque token: the retired
    // handler validates it against a whitelist, it is never a path.
    assert_eq!(
        gateway
            .send(
                "POST",
                "/api/tunnel/restart/..%2F..%2Fetc%2Fpasswd",
                &json!({})
            )
            .status,
        202
    );
    assert_eq!(
        gateway.calls().last().unwrap()["provider"],
        "../../etc/passwd"
    );
}

#[test]
fn power_routes_share_the_unlock_password_post_and_delete() {
    let gateway = Gateway::start(
        "power",
        world(json!({
            "settings-power": relay(200, json!({ "ok": true })),
            "settings-power-auto-unlock": relay(200, json!({ "enabled": true })),
            "settings-power-unlock-password-set": relay(200, json!({ "ok": true })),
            "settings-power-unlock-password-clear": relay(200, json!({ "ok": true })),
            "settings-power-unlock-password-authorize": relay(200, json!({ "authorized": true })),
            "settings-task-attribution": relay(200, json!({ "ok": true })),
        })),
    );
    assert_eq!(
        gateway
            .send("POST", "/api/settings/power", &json!({ "keepAwake": true }))
            .status,
        200
    );
    assert_eq!(
        gateway
            .send(
                "POST",
                "/api/settings/power/auto-unlock",
                &json!({ "enabled": true })
            )
            .status,
        200
    );
    // The password itself must never come back: only the DTO the host built.
    let set = gateway.send(
        "POST",
        "/api/settings/power/unlock-password",
        &json!({ "password": "hunter2" }),
    );
    assert_eq!(set.status, 200);
    assert!(!set.body.contains("hunter2"));
    assert_eq!(
        gateway.delete("/api/settings/power/unlock-password").status,
        200
    );
    assert_eq!(
        gateway
            .send(
                "POST",
                "/api/settings/power/unlock-password/authorize",
                &json!({})
            )
            .status,
        200
    );
    assert_eq!(
        gateway
            .send(
                "POST",
                "/api/settings/task-attribution",
                &json!({ "enabled": true })
            )
            .status,
        200
    );

    let calls = gateway.calls();
    assert_eq!(
        ops_sent(&calls),
        vec![
            "settings-power",
            "settings-power-auto-unlock",
            "settings-power-unlock-password-set",
            "settings-power-unlock-password-clear",
            "settings-power-unlock-password-authorize",
            "settings-task-attribution",
        ]
    );
    assert_eq!(calls[3]["method"], "DELETE");
    assert_eq!(calls[2]["body"], json!({ "password": "hunter2" }));
}

// ── skill sync / environment doctor / session doctor ────────────────────────

#[test]
fn skill_sync_and_the_two_doctor_run_families() {
    let gateway = Gateway::start(
        "doctor-runs",
        world(json!({
            "skill-sync-status": relay(200, json!({ "running": false, "lastRun": null })),
            "skill-sync-run": relay(202, json!({ "ok": true, "running": true })),
            "env-doctor-start": relay(202, json!({ "ok": true, "runId": "env-1" })),
            "env-doctor-run": relay(200, json!({ "ok": true, "status": "done" })),
            "env-doctor-cancel": relay(200, json!({ "ok": true, "cancelled": true })),
            "doctor-run": relay(200, json!({ "ok": true, "status": "done" })),
            "doctor-cancel": relay(200, json!({ "ok": true, "cancelled": true })),
        })),
    );
    assert_eq!(gateway.get("/api/skill-sync/status").status, 200);
    assert_eq!(
        gateway
            .send("POST", "/api/skill-sync/run", &json!({ "all": true }))
            .status,
        202
    );
    assert_eq!(
        gateway
            .send("POST", "/api/system/env-doctor", &json!({}))
            .status,
        202
    );
    assert_eq!(gateway.get("/api/system/env-doctor/env%201").status, 200);
    assert_eq!(
        gateway
            .send("POST", "/api/system/env-doctor/env%201/cancel", &json!({}))
            .status,
        200
    );
    assert_eq!(gateway.get("/api/doctor/runs/abc").status, 200);
    assert_eq!(
        gateway
            .send("POST", "/api/doctor/runs/abc/cancel", &json!({}))
            .status,
        200
    );

    let calls = gateway.calls();
    assert_eq!(
        ops_sent(&calls),
        vec![
            "skill-sync-status",
            "skill-sync-run",
            "env-doctor-start",
            "env-doctor-run",
            "env-doctor-cancel",
            "doctor-run",
            "doctor-cancel",
        ]
    );
    assert_eq!(calls[3]["runId"], "env 1");
    assert_eq!(calls[4]["runId"], "env 1");
    assert_eq!(calls[5]["runId"], "abc");
    assert_eq!(calls[6]["runId"], "abc");
}

#[test]
fn session_doctor_guard_refuses_internal_slots_before_the_host() {
    let gateway = Gateway::start(
        "session-doctor-guard",
        json!({
            "hostOps": { "ops": json!({
                "session-doctor-start": relay(202, json!({ "ok": true, "runId": "doc-1" })),
                "session-doctor-list": relay(200, json!({ "ok": true, "runs": [] })),
            }) },
            "sessionAdmin": { "ops": json!({
                "guard-record:s1": { "record": { "id": "s1" }, "internal": true, "taskStateWritable": true },
                "guard-record:s2": { "record": { "id": "s2" }, "internal": false, "taskStateWritable": true },
            }) },
        }),
    );

    // An internal execution slot is a 404 for the handler, for the read, and
    // for `OPTIONS` — the guard layer runs before all three.
    for method in ["POST", "GET", "OPTIONS"] {
        let response = gateway.exchange(method, "/api/sessions/s1/doctor", &[], None);
        assert_eq!(response.status, 404, "{method}: {}", gateway.log());
        assert_eq!(response.json(), json!({ "error": "session not found" }));
    }
    assert!(gateway.calls().is_empty(), "guard refusal reached the host");
    assert_eq!(gateway.session_admin_calls().len(), 3);

    let start = gateway.send(
        "POST",
        "/api/sessions/s2/doctor",
        &json!({ "kind": "quick" }),
    );
    assert_eq!(start.status, 202, "{}", gateway.log());
    assert_key_order(&start.body, &["ok", "runId"]);
    assert_eq!(gateway.get("/api/sessions/s2/doctor").status, 200);

    let calls = gateway.calls();
    assert_eq!(
        ops_sent(&calls),
        vec!["session-doctor-start", "session-doctor-list"]
    );
    assert_eq!(calls[0]["id"], "s2");
    assert_eq!(calls[1]["id"], "s2");
    assert_eq!(calls[1]["method"], "GET");
}

// ── OPTIONS union ───────────────────────────────────────────────────────────

#[test]
fn allow_header_covers_every_shared_path() {
    let gateway = Gateway::start("allow", json!({ "hostOps": { "ops": {} } }));
    let cases = [
        ("/api/restart", "POST"),
        ("/api/update/status", "GET,HEAD"),
        ("/api/system/developer-tools/install-git", "GET,HEAD,POST"),
        ("/api/system/disk-access", "GET,HEAD"),
        // This cluster registers both methods on one path.
        ("/api/system/ops-run", "GET,HEAD,POST"),
        ("/api/settings/power/unlock-password", "POST,DELETE"),
        // The host-read cluster also registers the GET on these.
        ("/api/settings/power", "GET,HEAD,POST"),
        ("/api/settings/tunnel", "GET,HEAD,POST"),
        ("/api/tunnel/funnel", "GET,HEAD,POST"),
        ("/api/settings/access-token", "GET,HEAD,POST"),
        // …and the task surface registers the GET on this one.
        ("/api/settings/task-attribution", "POST,GET,HEAD"),
        ("/api/sessions/s9/doctor", "POST,GET,HEAD"),
    ];
    for (path, allow) in cases {
        let response = gateway.options(path);
        assert_eq!(response.status, 200, "{path}: {}", gateway.log());
        assert_eq!(response.header("allow"), Some(allow), "{path}");
    }
    assert!(gateway.calls().is_empty(), "OPTIONS reached the host");
}

// ── failure surface ─────────────────────────────────────────────────────────

#[test]
fn unreachable_host_is_the_registered_503() {
    let gateway = Gateway::start("host-down", json!({ "hostOps": { "hostDown": true } }));
    let response = gateway.send("POST", "/api/restart", &json!({}));
    assert_eq!(response.status, 503);
    assert_key_order(&response.body, &["error", "code"]);
    let body = response.json();
    assert_eq!(body["error"], "宿主与系统操作接口尚未就绪，请更新原生模块");
    assert_eq!(body["code"], "rust_backend_unavailable");
}

#[test]
fn a_handler_that_threw_is_the_500_envelope_without_the_thrown_message() {
    let gateway = Gateway::start(
        "threw",
        world(json!({
            "restart": {
                "threw": true,
                "status": 500,
                "code": "restart_failed",
                "message": "restart_failed",
            },
        })),
    );
    let response = gateway.send("POST", "/api/restart", &json!({}));
    assert_eq!(response.status, 500);
    assert_key_order(&response.body, &["ok", "error", "code", "requestId"]);
    assert!(!response.body.contains("stack"));
    assert!(!response.body.contains("/Users/"));
    assert_eq!(response.json()["requestId"], "host-req-1");
}

#[test]
fn a_host_that_answered_non_200_is_the_500() {
    let gateway = Gateway::start("host-500", json!({ "hostOps": { "fail": ["restart"] } }));
    let response = gateway.send("POST", "/api/restart", &json!({}));
    assert_eq!(response.status, 500);
    // The host answered but the operation threw: Express's `safeErrorHandler`
    // envelope, never the child's own text and never the 503 (which is only
    // for "we never got an answer").
    assert_key_order(&response.body, &["ok", "error", "code", "requestId"]);
    let body = response.json();
    assert_eq!(body["ok"], false);
    assert_eq!(body["error"], "internal_error");
    assert_eq!(body["code"], "internal_error");
    assert_eq!(body["requestId"], "host-req-1");
}

#[test]
fn a_bare_handler_reply_has_no_body_and_no_content_type() {
    let gateway = Gateway::start(
        "bare",
        world(json!({ "restart": { "status": 500, "bare": true } })),
    );
    let response = gateway.send("POST", "/api/restart", &json!({}));
    assert_eq!(response.status, 500);
    assert_eq!(response.body, "");
    assert_eq!(response.header("content-type"), None);
    assert_eq!(response.header("content-length"), Some("0"));
}
