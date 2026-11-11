//! Integration coverage for `GET/HEAD/OPTIONS /api/subagent-defaults` and
//! `POST/OPTIONS /api/subagent-defaults/sync` against the real
//! `multicc-gateway` binary.
//!
//! The Node process is the shared protocol fixture: it speaks PROXY v1, serves
//! the auth control bridge, and answers the host port from a JSON script the
//! test writes (`FIXTURE_HOST_SCRIPT`). Everything that used to live in
//! `src/routes/subagent-defaults.js` — parsing, validation, planning, response
//! assembly, error mapping — is Rust and is what these tests assert. The frozen
//! Node route is compared byte for byte in
//! docs/rust-migration/differential/subagent-defaults.js.

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
        "multicc-gateway-subagent-defaults-{}-{tag}-{nanos}",
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
        let gateway = Self {
            dir,
            state,
            port,
            child,
        };
        let deadline = Instant::now() + Duration::from_secs(15);
        while !gateway.state.join("ready").exists() {
            assert!(
                Instant::now() < deadline,
                "gateway never became ready\n{}",
                gateway.log()
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        gateway
    }

    fn log(&self) -> String {
        fs::read_to_string(self.dir.join("gateway.log")).unwrap_or_default()
    }

    fn host_calls(&self) -> Vec<Value> {
        fs::read_to_string(self.state.join("host-calls.jsonl"))
            .unwrap_or_default()
            .lines()
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn exchange(&self, method: &str, url: &str, body: Option<&Value>) -> Response {
        let mut stream = TcpStream::connect(("127.0.0.1", self.port)).expect("connect gateway");
        stream
            .set_read_timeout(Some(Duration::from_secs(30)))
            .unwrap();
        let payload = body.map(|value| value.to_string()).unwrap_or_default();
        let mut request = format!(
            "{method} {url} HTTP/1.1\r\nHost: localhost\r\nX-Request-Id: diff-req-1\r\nConnection: close\r\n"
        );
        if body.is_some() {
            request.push_str(&format!(
                "Content-Type: application/json\r\nContent-Length: {}\r\n",
                payload.len()
            ));
        }
        request.push_str("\r\n");
        request.push_str(&payload);
        stream.write_all(request.as_bytes()).unwrap();
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).unwrap();
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
        self.exchange("GET", url, None)
    }

    fn post(&self, url: &str, body: Value) -> Response {
        self.exchange("POST", url, Some(&body))
    }
}

impl Drop for Gateway {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn claude_route() -> Value {
    json!({ "providerId": "sub-claude", "model": "claude-haiku-4-5" })
}

fn session(id: &str, extra: Value) -> Value {
    let mut base = json!({
        "id": id,
        "name": id,
        "cli": "claude",
        "kind": "chat",
        "type": null,
        "ephemeral": false,
        "loginFlow": null,
        "provider": "main",
        "subagent": null,
        "pending": false,
    });
    for (key, value) in extra.as_object().into_iter().flatten() {
        base[key] = value.clone();
    }
    base
}

fn base_script() -> Value {
    json!({
        "subagent": { "claude": claude_route(), "codex": null },
        "sessions": [
            session("apply-me", json!({})),
            session("same", json!({ "subagent": { "providerId": "sub-claude", "model": "claude-haiku-4-5", "inherited": true } })),
            session("own", json!({ "subagent": { "providerId": "main", "model": "own-model" } })),
            session("busy", json!({ "pending": true })),
            session("rejected", json!({})),
        ],
        "facts": { "sub-claude": { "valid": true, "proxyable": false, "official": false } },
        "patches": {
            "busy": { "deferred": true },
            "rejected": { "status": 400, "detail": "session patch rejected" },
        },
    })
}

#[test]
fn get_returns_the_normalized_stored_defaults() {
    let gateway = Gateway::start("get", base_script());
    let response = gateway.get("/api/subagent-defaults");
    assert_eq!(response.status, 200);
    assert_eq!(
        response.json(),
        json!({
            "ok": true,
            "defaults": { "claude": claude_route(), "codex": null },
        })
    );
    assert_eq!(
        response.header("content-type"),
        Some("application/json; charset=utf-8")
    );
    assert_eq!(gateway.host_calls(), vec![json!({ "op": "state" })]);
}

#[test]
fn malformed_stored_defaults_collapse_to_null() {
    for stored in [json!("oops"), json!([1, 2]), json!({ "claude": 7 })] {
        let gateway = Gateway::start("get-hostile", {
            let mut script = base_script();
            script["subagent"] = stored;
            script
        });
        let response = gateway.get("/api/subagent-defaults");
        assert_eq!(response.status, 200);
        assert_eq!(
            response.json(),
            json!({ "ok": true, "defaults": { "claude": null, "codex": null } })
        );
    }
}

#[test]
fn dry_run_plans_every_bucket_without_writing() {
    let gateway = Gateway::start("dry-run", base_script());
    let response = gateway.post(
        "/api/subagent-defaults/sync",
        json!({ "cli": "claude", "subagent": claude_route(), "dryRun": true }),
    );
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(
        response.json(),
        json!({
            "ok": true,
            "dryRun": true,
            "family": "claude",
            "subagent": claude_route(),
            "defaults": { "claude": claude_route(), "codex": null },
            "counts": { "applied": 1, "deferred": 1, "unchanged": 1, "skipped": 1, "kept": 1 },
            "sessions": [
                { "sessionId": "apply-me", "sessionName": "apply-me", "cli": "claude", "outcome": "applied" },
                { "sessionId": "busy", "sessionName": "busy", "cli": "claude", "outcome": "deferred" },
                { "sessionId": "rejected", "sessionName": "rejected", "cli": "claude", "outcome": "skipped",
                  "reason": "patch_rejected", "detail": "session patch rejected" },
                { "sessionId": "same", "sessionName": "same", "cli": "claude", "outcome": "unchanged" },
                { "sessionId": "own", "sessionName": "own", "cli": "claude", "outcome": "kept" },
            ],
            "truncated": false,
        })
    );
    assert!(
        !gateway.state.join("persisted.json").exists(),
        "a dry run must not persist defaults"
    );
    let patches: Vec<Value> = fs::read_to_string(gateway.state.join("patches.jsonl"))
        .unwrap_or_default()
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert!(patches.iter().all(|patch| patch["dryRun"] == json!(true)));
    assert_eq!(
        patches.len(),
        3,
        "apply-me, busy and rejected are previewed"
    );
}

#[test]
fn apply_persists_first_and_moves_only_sessions_without_an_own_route() {
    let gateway = Gateway::start("apply", base_script());
    let response = gateway.post(
        "/api/subagent-defaults/sync",
        json!({ "cli": "claude", "subagent": claude_route() }),
    );
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(
        response.json()["counts"],
        json!({ "applied": 1, "deferred": 1, "unchanged": 1, "skipped": 1, "kept": 1 })
    );
    assert_eq!(
        fs::read_to_string(gateway.state.join("persisted.json")).unwrap(),
        json!({ "claude": claude_route(), "codex": null }).to_string()
    );
    let calls = gateway.host_calls();
    // Persist lands before the first patch, and every patch carries the target
    // route plus `subagentInherited` semantics decided by the host shim.
    let persist = calls
        .iter()
        .position(|call| call["op"] == json!("persist"))
        .expect("persist call");
    let first_patch = calls
        .iter()
        .position(|call| call["op"] == json!("patch"))
        .expect("patch call");
    assert!(persist < first_patch);
    assert!(calls
        .iter()
        .filter(|call| call["op"] == json!("patch"))
        .all(|call| call["subagent"] == claude_route()));
}

#[test]
fn clearing_the_default_sends_a_null_patch_target() {
    let gateway = Gateway::start("clear", base_script());
    let response = gateway.post(
        "/api/subagent-defaults/sync",
        json!({ "cli": "claude", "subagent": null }),
    );
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.json()["subagent"], Value::Null);
    assert_eq!(
        response.json()["defaults"],
        json!({ "claude": null, "codex": null })
    );
    assert!(gateway
        .host_calls()
        .iter()
        .filter(|call| call["op"] == json!("patch"))
        .all(|call| call["subagent"].is_null()));
}

#[test]
fn validation_failures_keep_the_retired_status_and_body() {
    let gateway = Gateway::start("invalid", base_script());
    let unsupported = gateway.post(
        "/api/subagent-defaults/sync",
        json!({ "cli": "opencode", "subagent": claude_route() }),
    );
    assert_eq!(unsupported.status, 400);
    assert_eq!(
        unsupported.json(),
        json!({
            "error": "subagent defaults are only supported by Claude and Codex",
            "code": "unsupported_cli",
        })
    );

    let bad_model = gateway.post(
        "/api/subagent-defaults/sync",
        json!({ "cli": "claude", "subagent": { "providerId": "p", "model": "bad model" } }),
    );
    assert_eq!(bad_model.status, 400);
    assert_eq!(bad_model.json()["code"], json!("invalid_subagent"));

    let unknown_provider = gateway.post(
        "/api/subagent-defaults/sync",
        json!({ "cli": "claude", "subagent": { "providerId": "nope", "model": "m" } }),
    );
    assert_eq!(unknown_provider.status, 400);
    assert_eq!(unknown_provider.json()["code"], json!("invalid_provider"));
    assert!(
        !gateway.state.join("persisted.json").exists(),
        "a rejected plan has no side effects"
    );
}

#[test]
fn a_failed_write_leaves_every_session_alone() {
    let gateway = Gateway::start("save-failed", {
        let mut script = base_script();
        script["persistFail"] = json!(true);
        script
    });
    let response = gateway.post(
        "/api/subagent-defaults/sync",
        json!({ "cli": "claude", "subagent": claude_route() }),
    );
    assert_eq!(response.status, 500);
    assert_eq!(
        response.json(),
        json!({ "error": "无法保存子任务默认线路", "code": "save_failed" })
    );
    assert!(
        !gateway.state.join("patches.jsonl").exists(),
        "no session may be patched after a failed write"
    );
}

#[test]
fn an_unreachable_host_port_answers_the_native_unavailable_shape() {
    let gateway = Gateway::start("host-down", {
        let mut script = base_script();
        script["hostDown"] = json!(true);
        script
    });
    for (method, url, body) in [
        ("GET", "/api/subagent-defaults", None),
        (
            "POST",
            "/api/subagent-defaults/sync",
            Some(json!({ "cli": "claude", "subagent": claude_route() })),
        ),
    ] {
        let response = gateway.exchange(method, url, body.as_ref());
        assert_eq!(response.status, 503, "{method} {url}");
        assert_eq!(
            response.json(),
            json!({
                "error": "子任务默认线路接口尚未就绪，请更新原生模块",
                "code": "rust_backend_unavailable",
            })
        );
    }
}

#[test]
fn express_options_answers_are_preserved() {
    let gateway = Gateway::start("options", base_script());
    let list = gateway.exchange("OPTIONS", "/api/subagent-defaults", None);
    assert_eq!(list.status, 200);
    // The retired route mounted GET on the collection and POST only on /sync.
    assert_eq!(list.header("allow"), Some("GET,HEAD"));
    let sync = gateway.exchange("OPTIONS", "/api/subagent-defaults/sync", None);
    assert_eq!(sync.status, 200);
    assert_eq!(sync.header("allow"), Some("POST"));
}

/// The direct answer a caller sees for `HEAD` is the GET headers without a body.
#[test]
fn head_matches_get_without_a_body() {
    let gateway = Gateway::start("head", base_script());
    let get = gateway.get("/api/subagent-defaults");
    let head = gateway.exchange("HEAD", "/api/subagent-defaults", None);
    assert_eq!(head.status, 200);
    assert_eq!(head.body, "");
    assert_eq!(head.header("content-type"), get.header("content-type"));
    assert_eq!(head.header("etag"), get.header("etag"));
}

/// The constant is part of the contract; a rename must show up here.
#[test]
fn response_cap_is_two_hundred_sessions() {
    let mut script = base_script();
    let sessions: Vec<Value> = (0..205)
        .map(|index| session(&format!("s{index}"), json!({})))
        .collect();
    script["sessions"] = json!(sessions);
    let gateway = Gateway::start("truncate", script);
    let response = gateway.post(
        "/api/subagent-defaults/sync",
        json!({ "cli": "claude", "subagent": claude_route(), "dryRun": true }),
    );
    assert_eq!(response.status, 200);
    let value = response.json();
    assert_eq!(value["counts"]["applied"], json!(205));
    assert_eq!(value["sessions"].as_array().unwrap().len(), 200);
    assert_eq!(value["truncated"], json!(true));
}
