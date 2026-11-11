//! Integration coverage for the agent resource routes against the real
//! `multicc-gateway` binary:
//!
//!   GET/HEAD/OPTIONS  /api/agent-resources/skills
//!   GET/HEAD/OPTIONS  /api/agent-presets
//!   GET/HEAD/OPTIONS  /api/agent-presets/:id
//!   GET/HEAD/OPTIONS  /api/agent-resources/claude-sessions
//!   DELETE/OPTIONS    /api/agent-resources/claude-sessions/:project/:id
//!   DELETE/OPTIONS    /api/agent-resources/claude-sessions
//!
//! The Node process is the shared protocol fixture: it speaks PROXY v1, serves
//! the auth control bridge, and answers the host port from the JSON script the
//! test writes (`FIXTURE_HOST_SCRIPT`). Routing, query parsing, status codes,
//! headers and response shapes are Rust and are what these tests assert.

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
        "multicc-gateway-agent-resources-{}-{tag}-{nanos}",
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

    fn host_calls(&self, file: &str) -> Vec<Value> {
        fs::read_to_string(self.state.join(file))
            .unwrap_or_default()
            .lines()
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn exchange(&self, method: &str, url: &str, body: Option<&Value>) -> Response {
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
        // The gateway's port is probed and released before it binds, so a
        // parallel run can briefly steer a fresh connection at another
        // listener that resets it. Replay only when nothing was read: a reset
        // after any byte arrived means the response really was cut short.
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

    fn request(&self, method: &str, url: &str, body: Option<&Value>) -> Response {
        self.exchange(method, url, body)
    }

    fn get(&self, url: &str) -> Response {
        self.exchange("GET", url, None)
    }

    fn delete(&self, url: &str) -> Response {
        self.exchange("DELETE", url, None)
    }
}

impl Drop for Gateway {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn family_error() -> Value {
    json!({
        "error": "agent resources interface is not ready",
        "code": "rust_backend_unavailable",
    })
}

fn agent_script(agent: Value) -> Value {
    json!({ "agent": agent })
}

/// An RFC 3339 `toISOString`-shaped timestamp some milliseconds from now.
fn iso_ms_from_now(delta_ms: i64) -> String {
    let now = SystemTime::now();
    let when = if delta_ms >= 0 {
        now + Duration::from_millis(delta_ms as u64)
    } else {
        now - Duration::from_millis((-delta_ms) as u64)
    };
    chrono::DateTime::<chrono::Utc>::from(when).to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[test]
fn skills_answer_carries_the_counts() {
    let skills = json!([
        { "id": "a", "provider": "claude" },
        { "id": "b", "provider": "codex" },
        { "id": "c", "provider": "claude" },
        { "id": "d", "provider": "other" },
        { "id": "e" },
        { "id": "f", "provider": "Claude" },
    ]);
    let gateway = Gateway::start("skills", agent_script(json!({ "skills": skills })));
    let response = gateway.get("/api/agent-resources/skills");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(
        response.header("content-type"),
        Some("application/json; charset=utf-8")
    );
    assert_eq!(
        response.json(),
        json!({
            "skills": skills,
            "counts": { "claude": 2, "codex": 1 },
        })
    );
    assert_eq!(
        gateway.host_calls("agent-calls.jsonl"),
        vec![json!({ "op": "skills" })]
    );
}

#[test]
fn presets_envelope_keeps_order_and_defaults() {
    let script = agent_script(json!({
        "data": {
            "ok": true,
            "version": "2",
            "generatedAt": "2026-01-01T00:00:00.000Z",
            "featured": ["f"],
            "presets": [{ "id": "one" }],
        }
    }));
    let gateway = Gateway::start("presets", script);
    let response = gateway.get("/api/agent-presets");
    assert_eq!(response.status, 200, "{}", response.body);
    // `source` was never supplied, so `JSON.stringify` drops it; `categories`
    // fell back to `[]`; the rest keeps the retired field order.
    assert_eq!(
        response.body,
        "{\"version\":\"2\",\"generatedAt\":\"2026-01-01T00:00:00.000Z\",\
         \"categories\":[],\"featured\":[\"f\"],\"presets\":[{\"id\":\"one\"}]}"
    );
    assert!(response.json().get("source").is_none());
}

#[test]
fn preset_lookup_decodes_the_id_and_maps_404() {
    let preset = json!({
        "id": "my preset",
        "prompt": "hi",
        "defaultProviderId": "p",
        "defaultProviderName": "P",
    });
    let gateway = Gateway::start(
        "preset",
        agent_script(json!({ "presets": { "my preset": preset } })),
    );
    let found = gateway.get("/api/Agent-Presets/my%20preset");
    assert_eq!(found.status, 200, "{}", found.body);
    assert_eq!(
        found.body,
        "{\"id\":\"my preset\",\"prompt\":\"hi\",\"defaultProviderId\":\"p\",\
         \"defaultProviderName\":\"P\"}"
    );

    let missing = gateway.get("/api/agent-presets/absent");
    assert_eq!(missing.status, 404);
    assert_eq!(missing.json(), json!({ "error": "not found" }));

    let calls = gateway.host_calls("agent-calls.jsonl");
    assert_eq!(calls[0], json!({ "op": "preset", "id": "my preset" }));
    assert_eq!(calls[1], json!({ "op": "preset", "id": "absent" }));
}

#[test]
fn presets_unavailable_is_the_retired_500() {
    let gateway = Gateway::start("presets-down", agent_script(json!({ "presetsDown": true })));
    for path in ["/api/agent-presets", "/api/agent-presets/anything"] {
        let response = gateway.get(path);
        assert_eq!(response.status, 500, "{path}");
        assert_eq!(
            response.json(),
            json!({ "error": "agent presets unavailable" })
        );
    }
}

#[test]
fn claude_sessions_report_count_size_and_protected() {
    let sessions = json!([
        { "id": "a", "project": "p", "size": 100, "linked": true },
        { "id": "b", "project": "p", "size": 50 },
        { "id": "c", "project": "p", "size": 25, "linked": false },
    ]);
    let gateway = Gateway::start("sessions", agent_script(json!({ "sessions": sessions })));
    let response = gateway.get("/api/agent-resources/claude-sessions");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(
        response.json(),
        json!({
            "sessions": sessions,
            "count": 3,
            "totalSize": 175,
            "protectedCount": 1,
        })
    );
}

#[test]
fn deleting_one_session_maps_ok_protected_and_missing() {
    let gateway = Gateway::start(
        "session-delete",
        agent_script(json!({
            "remove": {
                "My Project/one": { "ok": true, "freed": 1234 },
                "My Project/prot": { "ok": false, "error": "session is protected" },
                "My Project/miss": { "ok": false, "error": "not found" },
            }
        })),
    );
    let ok = gateway.delete("/api/agent-resources/claude-sessions/My%20Project/one");
    assert_eq!(ok.status, 200, "{}", ok.body);
    assert_eq!(ok.json(), json!({ "ok": true, "freed": 1234 }));

    let protected = gateway.delete("/api/agent-resources/claude-sessions/My%20Project/prot");
    assert_eq!(protected.status, 409);
    assert_eq!(protected.json(), json!({ "error": "session is protected" }));

    let missing = gateway.delete("/api/agent-resources/claude-sessions/My%20Project/miss");
    assert_eq!(missing.status, 404);
    assert_eq!(missing.json(), json!({ "error": "not found" }));

    // The host sees the decoded parameters, not the wire text.
    let calls = gateway.host_calls("agent-calls.jsonl");
    assert_eq!(
        calls,
        vec![
            json!({ "op": "claude-session-delete", "project": "My Project", "id": "one" }),
            json!({ "op": "claude-session-delete", "project": "My Project", "id": "prot" }),
            json!({ "op": "claude-session-delete", "project": "My Project", "id": "miss" }),
        ]
    );
}

#[test]
fn delete_failure_maps_the_retired_500() {
    let gateway = Gateway::start(
        "session-delete-failure",
        agent_script(json!({
            "remove": {
                "p/threw": { "ok": false, "threw": true },
                "p/nonstring": { "ok": false, "error": 7 },
            }
        })),
    );
    for path in [
        "/api/agent-resources/claude-sessions/p/threw",
        "/api/agent-resources/claude-sessions/p/nonstring",
    ] {
        let response = gateway.delete(path);
        assert_eq!(response.status, 500, "{path}");
        assert_eq!(response.json(), json!({ "error": "history delete failed" }));
    }
}

#[test]
fn purge_uses_the_validation_error_for_bad_olderthan() {
    let gateway = Gateway::start("purge-validation", agent_script(json!({})));
    for url in [
        "/api/agent-resources/claude-sessions",
        "/api/agent-resources/claude-sessions?olderThanDays=0",
        "/api/agent-resources/claude-sessions?olderThanDays=-1",
        "/api/agent-resources/claude-sessions?olderThanDays=abc",
    ] {
        let response = gateway.delete(url);
        assert_eq!(response.status, 400, "{url}");
        assert_eq!(
            response.json(),
            json!({ "error": "olderThanDays must be at least 1" })
        );
    }
    // Nothing reached the host before validation.
    assert!(gateway.host_calls("agent-calls.jsonl").is_empty());

    let accepted = gateway.delete("/api/agent-resources/claude-sessions?olderThanDays=2");
    assert_eq!(accepted.status, 200, "{}", accepted.body);
    assert_eq!(
        accepted.json(),
        json!({ "ok": true, "deleted": 0, "freed": 0 })
    );
    let calls = gateway.host_calls("agent-calls.jsonl");
    assert_eq!(calls, vec![json!({ "op": "claude-sessions" })]);
}

#[test]
fn purge_skips_linked_invalid_and_fresh_sessions() {
    let old = iso_ms_from_now(-5 * 24 * 60 * 60 * 1000);
    let fresh = iso_ms_from_now(-60 * 60 * 1000);
    let sessions = json!([
        { "id": "old", "project": "p", "updatedAt": old },
        { "id": "linked", "project": "p", "updatedAt": old, "linked": true },
        { "id": "fresh", "project": "p", "updatedAt": fresh },
        { "id": "garbage", "project": "p", "updatedAt": "garbage" },
        { "id": "missing", "project": "p" },
        { "id": "old2", "project": "q", "updatedAt": old },
    ]);
    let gateway = Gateway::start(
        "purge-skip",
        agent_script(json!({
            "sessions": sessions,
            "remove": {
                "p/old": { "ok": true, "freed": 10 },
                "q/old2": { "ok": true, "freed": 5 },
            }
        })),
    );
    let response = gateway.delete("/api/agent-resources/claude-sessions?olderThanDays=2");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(
        response.json(),
        json!({ "ok": true, "deleted": 2, "freed": 15 })
    );
    assert_eq!(
        gateway.host_calls("agent-calls.jsonl"),
        vec![
            json!({ "op": "claude-sessions" }),
            json!({ "op": "claude-session-delete", "project": "p", "id": "old" }),
            json!({ "op": "claude-session-delete", "project": "q", "id": "old2" }),
        ]
    );
}

#[test]
fn express_options_answers_are_preserved() {
    let gateway = Gateway::start("options", agent_script(json!({})));
    for (path, allow) in [
        ("/api/agent-resources/skills", "GET,HEAD"),
        ("/api/agent-presets", "GET,HEAD"),
        ("/api/agent-presets/anything", "GET,HEAD"),
        ("/api/agent-resources/claude-sessions/proj/abc", "DELETE"),
        // Both a GET and a DELETE route are registered on this exact path.
        ("/api/agent-resources/claude-sessions", "GET,HEAD,DELETE"),
    ] {
        let response = gateway.request("OPTIONS", path, None);
        assert_eq!(response.status, 200, "{path}");
        assert_eq!(response.header("allow"), Some(allow), "{path}");
    }
    // Express answers OPTIONS itself, before any handler runs.
    assert!(gateway.host_calls("agent-calls.jsonl").is_empty());
}

#[test]
fn head_matches_get_without_a_body() {
    let gateway = Gateway::start(
        "head",
        agent_script(json!({ "skills": [{ "id": "a", "provider": "claude" }] })),
    );
    let get = gateway.get("/api/agent-resources/skills");
    let head = gateway.request("HEAD", "/api/agent-resources/skills", None);
    assert_eq!(head.status, 200);
    assert_eq!(head.body, "");
    assert_eq!(head.header("etag"), get.header("etag"));
    assert_eq!(head.header("content-type"), get.header("content-type"));
}

#[test]
fn host_down_answers_the_family_shape() {
    let gateway = Gateway::start("host-down", json!({ "hostDown": true, "agent": {} }));
    for (method, path) in [
        ("GET", "/api/agent-resources/skills"),
        ("GET", "/api/agent-presets"),
        ("GET", "/api/agent-presets/anything"),
        ("GET", "/api/agent-resources/claude-sessions"),
        ("DELETE", "/api/agent-resources/claude-sessions/proj/abc"),
        (
            "DELETE",
            "/api/agent-resources/claude-sessions?olderThanDays=2",
        ),
    ] {
        let response = gateway.request(method, path, None);
        assert_eq!(response.status, 503, "{method} {path}: {}", response.body);
        assert_eq!(response.json(), family_error(), "{method} {path}");
    }
}

#[test]
fn unrelated_paths_still_reach_node() {
    let gateway = Gateway::start("forward", agent_script(json!({})));
    // The fixture answers `ok` for anything it does not serve by name; a
    // claimed path would answer JSON from Rust instead.
    for path in [
        "/api/agent-presets/a/b",
        "/api/agent-resources/claude-sessions/p/id/extra",
        "/api/agent-resources/skills/extra",
        "/api/agent-resources/claude-session",
        "/API/agent-resources/skills",
    ] {
        let response = gateway.get(path);
        assert_eq!(response.status, 200, "{path}: {}", response.body);
        assert_eq!(response.body, "ok", "{path} was answered in Rust");
    }
    assert!(gateway.host_calls("agent-calls.jsonl").is_empty());
}
