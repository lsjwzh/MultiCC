//! Integration coverage for the 13 session-admin routes retired from
//! `src/routes/session-admin.js` and answered by the Rust front door
//! (`native/gateway/src/app/session_admin.rs`):
//!
//!   GET|HEAD /api/v1/sessions, /api/v1/sessions/:id,
//!            /api/v1/directories/:id/workspace
//!   GET|HEAD /api/sessions, /api/sessions/:id
//!   POST     /api/sessions/:id/{reclassify,mark-task-done,mark-goal-achieved}
//!   POST     /api/reclassify-all
//!   GET|HEAD /api/directories/:id/sessions, /api/directories/:id/workspace
//!   POST     /api/debug/classify/:id, GET|HEAD /api/debug/classify-test-cases
//!
//! The Node process here is only the protocol fixture (PROXY v1 + auth
//! control): it answers `POST /api/__host/session-admin` from
//! `FIXTURE_HOST_SCRIPT` and appends every payload to
//! `session-admin-calls.jsonl`. The records Map, the classify state machine and
//! the chat history stay in Node by design.

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
        "multicc-gateway-session-admin-{}-{tag}-{nanos}",
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

    fn calls(&self) -> Vec<Value> {
        fs::read_to_string(self.state.join("session-admin-calls.jsonl"))
            .unwrap_or_default()
            .lines()
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn exchange(
        &self,
        method: &str,
        url: &str,
        body: Option<&str>,
        extra: &[(&str, &str)],
    ) -> Response {
        let mut host = "localhost";
        let mut request_id = "admin-req-1";
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

    fn post(&self, url: &str) -> Response {
        self.exchange("POST", url, Some("{}"), &[])
    }

    fn post_json(&self, url: &str, body: &Value) -> Response {
        self.exchange("POST", url, Some(&body.to_string()), &[])
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

fn v1_error_order() -> Vec<&'static str> {
    vec![
        "ok",
        "error",
        "code",
        "apiVersion",
        "requestId",
        "correlationId",
    ]
}

fn public_dto_keys() -> Vec<&'static str> {
    vec![
        "id",
        "dirId",
        "type",
        "cli",
        "kind",
        "label",
        "model",
        "effectiveModel",
        "effort",
        "effectiveEffort",
        "agent",
        "provider",
        "providerSelection",
        "experimentalMode",
        "subagent",
        "autoCommit",
        "createdAt",
        "lastActivity",
        "clients",
        "active",
        "workspaceState",
        "lastWorkAt",
        "hibernatedAt",
        "mergeState",
        "unattended",
    ]
}

#[test]
fn options_allow_headers_match_the_retired_express_routes() {
    let gateway = Gateway::start("options", json!({}));
    for (url, allow) in [
        ("/api/v1/sessions", "GET,HEAD"),
        ("/api/v1/sessions/s1", "GET,HEAD"),
        ("/api/v1/directories/d1/workspace", "GET,HEAD"),
        ("/api/sessions", "GET,HEAD"),
        ("/api/sessions/s1", "GET,HEAD,PATCH,DELETE"),
        ("/api/sessions/s1/reclassify", "POST"),
        ("/api/sessions/s1/mark-task-done", "POST"),
        ("/api/sessions/s1/mark-goal-achieved", "POST"),
        ("/api/reclassify-all", "POST"),
        ("/api/directories/d1/sessions", "GET,HEAD,POST"),
        ("/api/directories/d1/workspace", "GET,HEAD"),
        ("/api/debug/classify/s1", "POST"),
        ("/api/debug/classify-test-cases", "GET,HEAD"),
    ] {
        let response = gateway.options(url);
        assert_eq!(response.status, 200, "{url} {}", response.body);
        assert_eq!(response.header("allow"), Some(allow), "{url}");
        assert_eq!(response.body, allow, "{url}");
        assert_eq!(
            response.header("content-type"),
            Some("text/html; charset=utf-8"),
            "{url}"
        );
    }
    // Literal segments match case-insensitively and one trailing slash is
    // fine. The `/api/` prefix itself is case-sensitive across the whole front
    // door (see `App::claim`), so `/API/...` stays with Node.
    let slash = gateway.options("/api/sessions/");
    assert_eq!(slash.header("allow"), Some("GET,HEAD"));
    // Only the guarded preflights hit the host (the `app.use` layer runs before
    // the automatic Allow responder); every other path answers in the front
    // door.
    let calls = gateway.calls();
    assert_eq!(calls.len(), 5, "{calls:?}");
    assert!(
        calls
            .iter()
            .all(|call| call["op"] == json!("guard-record") && call["method"] == json!("OPTIONS")),
        "{calls:?}"
    );
}

#[test]
fn internal_execution_slots_are_fail_closed_in_both_404_shapes() {
    let guard = json!({
        "record": {"id": "slot-1", "taskExecutionSlot": true, "kind": "chat"},
        "internal": true,
        "taskStateWritable": true,
    });
    let gateway = Gateway::start(
        "guard",
        json!({"sessionAdmin": {"ops": {"guard-record": guard}}}),
    );
    let v1 = gateway.get("/api/v1/sessions/slot-1");
    assert_eq!(v1.status, 404, "{}", v1.body);
    assert_eq!(v1.json()["code"], json!("session_not_found"));
    assert_eq!(v1.json()["apiVersion"], json!("v1"));
    assert_eq!(v1.json()["requestId"], json!("admin-req-1"));
    assert_key_order(&v1.body, &v1_error_order());

    for url in [
        "/api/sessions/slot-1",
        "/api/sessions/slot-1/reclassify",
        "/api/sessions/slot-1/mark-task-done",
        "/api/sessions/slot-1/mark-goal-achieved",
    ] {
        let response = if url == "/api/sessions/slot-1" {
            gateway.get(url)
        } else {
            gateway.post(url)
        };
        assert_eq!(response.status, 404, "{url} {}", response.body);
        assert_eq!(
            response.json(),
            json!({"error": "session not found"}),
            "{url}"
        );
    }

    // The guard is `app.use` middleware: it also answers OPTIONS, before the
    // automatic Allow row exists.
    for url in ["/api/sessions/slot-1", "/api/v1/sessions/slot-1"] {
        let response = gateway.options(url);
        assert_eq!(response.status, 404, "{url} {}", response.body);
        assert_eq!(response.header("allow"), None, "{url}");
    }
    assert_eq!(
        gateway.options("/api/v1/sessions/slot-1").json()["code"],
        json!("session_not_found")
    );
    assert_eq!(
        gateway.options("/api/sessions/slot-1").json(),
        json!({"error": "session not found"})
    );

    // No business op ran; every denial is one host `guard-record` call.
    let calls = gateway.calls();
    assert!(
        calls.iter().all(|call| call["op"] == json!("guard-record")),
        "{calls:?}"
    );
    assert_eq!(calls.len(), 9);
    assert_eq!(calls[0]["method"], json!("GET"));
    assert_eq!(calls[1]["method"], json!("GET"));
    assert_eq!(calls[5]["method"], json!("OPTIONS"));
    assert_eq!(calls[0]["id"], json!("slot-1"));
}

#[test]
fn v1_list_projects_the_public_dto_and_skips_unlisted_records() {
    let gateway = Gateway::start(
        "v1-list",
        json!({"sessionAdmin": {
            "records": [
                ["s1", {"id": "s1", "dirId": "d1", "kind": "chat", "cli": "claude"}],
                ["s2", {"id": "s2", "type": "aux"}],
                ["s3", {"id": "s3", "taskExecutionSlot": true}],
                ["s4", {"id": "s4", "taskBoundTaskId": "t1"}],
            ],
            "ops": {
                "v1-dto": [{"runtime": {
                    "effectiveModel": "m1",
                    "lastActivity": 1000,
                    "clients": 2,
                    "active": true,
                }}],
            },
        }}),
    );
    let response = gateway.get("/api/v1/sessions");
    assert_eq!(response.status, 200, "{}", response.body);
    let body = response.json();
    assert_eq!(body["count"], json!(1));
    assert_eq!(body["apiVersion"], json!("v1"));
    assert_eq!(body["requestId"], json!("admin-req-1"));
    assert_eq!(body["correlationId"], json!("admin-req-1"));
    let session = &body["sessions"][0];
    assert_eq!(session["id"], json!("s1"));
    assert_eq!(session["type"], json!("session"));
    assert_eq!(session["effectiveModel"], json!("m1"));
    assert_eq!(session["lastActivity"], json!("1970-01-01T00:00:01.000Z"));
    assert_eq!(session["clients"], json!(2));
    assert_eq!(session["active"], json!(true));
    assert_eq!(session["autoCommit"], json!(true));
    assert_key_order(&response.body, &["sessions", "count", "apiVersion"]);
    let positions: Vec<usize> = public_dto_keys()
        .iter()
        .map(|key| response.body.find(&format!("\"{key}\":")).unwrap_or(0))
        .collect();
    let mut sorted = positions.clone();
    sorted.sort_unstable();
    assert_eq!(positions, sorted, "DTO key order in {}", response.body);
    assert_eq!(
        gateway.calls(),
        vec![
            json!({"op": "records"}),
            json!({"op": "v1-dto", "items": [{
                "id": "s1",
                "record": {"id": "s1", "dirId": "d1", "kind": "chat", "cli": "claude"},
            }]}),
        ]
    );
}

#[test]
fn v1_detail_admits_task_bound_sessions_but_not_hidden_types() {
    let gateway = Gateway::start(
        "v1-detail",
        json!({"sessionAdmin": {
            "ops": {
                "guard-record": {
                    "record": {"id": "s1", "taskBoundTaskId": "t1", "kind": "chat", "cli": "claude"},
                    "internal": false,
                    "taskStateWritable": true,
                },
                "v1-dto": [{"runtime": {"effort": 1}}],
            },
        }}),
    );
    let response = gateway.get("/api/v1/sessions/s1");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.json()["session"]["id"], json!("s1"));
    assert_eq!(response.json()["apiVersion"], json!("v1"));

    let hidden = Gateway::start(
        "v1-detail-hidden",
        json!({"sessionAdmin": {
            "ops": {"guard-record": {
                "record": {"id": "g1", "type": "gateway"},
                "internal": false,
                "taskStateWritable": true,
            }},
        }}),
    );
    let response = hidden.get("/api/v1/sessions/g1");
    assert_eq!(response.status, 404, "{}", response.body);
    assert_eq!(response.json()["code"], json!("session_not_found"));
    assert_key_order(&response.body, &v1_error_order());
}

#[test]
fn v1_workspace_lifts_the_facts_and_filters_by_the_raw_param() {
    let gateway = Gateway::start(
        "v1-workspace",
        json!({"sessionAdmin": {
            "records": [
                ["s1", {"id": "s1", "dirId": "d1", "kind": "chat"}],
                ["s2", {"id": "s2", "dirId": "d2", "kind": "chat"}],
            ],
            "ops": {
                "directory": {"id": "d1", "name": "Repo", "path": "/repo"},
                "directory:gone": null,
                "workspace-dto": [{"runtime": {"clients": 3}, "facts": {
                    "status": "running",
                    "lastActivity": 5000,
                    "pendingNotes": 2,
                    "summary": "did things",
                    "summaryAt": 4000,
                    "classifyState": "P",
                    "goal": "ship it",
                    "taskShortCode": "T-1",
                    "phase": "coding",
                }, "invalid": null}],
            },
        }}),
    );
    let response = gateway.get("/api/v1/directories/d1/workspace");
    assert_eq!(response.status, 200, "{}", response.body);
    let body = response.json();
    let workspace = &body["workspace"];
    assert_eq!(workspace["directory"], json!({"id": "d1", "label": "Repo"}));
    assert_eq!(workspace["count"], json!(1));
    let entry = &workspace["sessions"][0];
    assert_eq!(entry["session"]["id"], json!("s1"));
    assert_eq!(entry["status"], json!("running"));
    assert_eq!(entry["statusUpdatedAt"], json!("1970-01-01T00:00:05.000Z"));
    assert_eq!(entry["pendingNotes"], json!(2));
    assert_eq!(entry["summary"], json!("did things"));
    assert_eq!(entry["classifyState"], json!("P"));
    assert_eq!(entry["goal"], json!("ship it"));
    assert_eq!(entry["phase"], json!("coding"));
    assert!(entry["session"]["taskShortCode"].is_string());
    assert_key_order(
        &response.body,
        &[
            "session",
            "status",
            "statusUpdatedAt",
            "runStartedAt",
            "runEndedAt",
            "pendingNotes",
            "summary",
            "summaryAt",
            "classifyState",
            "goal",
            "phase",
        ],
    );
    let calls = gateway.calls();
    assert_eq!(calls[0], json!({"op": "directory", "id": "d1"}));
    assert_eq!(calls[1], json!({"op": "records"}));
    assert_eq!(calls[2]["op"], json!("workspace-dto"));
    assert_eq!(calls[2]["items"].as_array().unwrap().len(), 1);
    assert_eq!(calls[2]["items"][0]["id"], json!("s1"));

    let missing = gateway.get("/api/v1/directories/gone/workspace");
    assert_eq!(missing.status, 404);
    assert_eq!(missing.json()["code"], json!("directory_not_found"));
    assert_key_order(&missing.body, &v1_error_order());
}

#[test]
fn legacy_list_prepends_the_aux_entry_and_keeps_its_key_order() {
    let gateway = Gateway::start(
        "legacy-list",
        json!({"sessionAdmin": {
            "records": [["s1", {"id": "s1", "dirId": "d1", "kind": "chat", "cli": "codex"}]],
            "ops": {
                "list-dto": [{
                    "runtime": {"effectiveModel": "gpt", "effectiveEffort": "high", "sessionCwd": "/w",
                                "chatActive": true, "chatClients": 1},
                    "providerSelection": null,
                    "cliStates": [],
                    "pendingCliHandoff": null,
                }],
                "aux-entry": {"available": true, "present": true, "entry": {
                    "id": "aux",
                    "cwd": "/aux",
                    "createdAt": "2026-01-01T00:00:00.000Z",
                    "lastActivity": "2026-01-02T00:00:00.000Z",
                    "clients": 1,
                    "active": false,
                    "type": "aux",
                    "label": "AI Assistant",
                    "auxStatus": "idle",
                }},
            },
        }}),
    );
    let response = gateway.get("/api/sessions");
    assert_eq!(response.status, 200, "{}", response.body);
    let body = response.json();
    let list = body.as_array().unwrap();
    assert_eq!(list.len(), 2);
    assert_eq!(list[0]["id"], json!("aux"));
    assert_key_order(
        &response.body,
        &[
            "id",
            "cwd",
            "createdAt",
            "lastActivity",
            "clients",
            "active",
            "type",
            "label",
            "auxStatus",
        ],
    );
    let entry = &list[1];
    assert_eq!(entry["id"], json!("s1"));
    assert_eq!(entry["cli"], json!("codex"));
    assert_eq!(entry["cwd"], json!("/w"));
    assert_eq!(entry["active"], json!(true));
    assert_eq!(entry["clients"], json!(1));
    assert_eq!(entry["autoCommit"], json!(true));
}

#[test]
fn legacy_list_reports_the_aux_runtime_failure_like_the_node_handler() {
    let gateway = Gateway::start(
        "legacy-list-aux-down",
        json!({"sessionAdmin": {"ops": {"aux-entry": {"available": false}}}}),
    );
    let response = gateway.get("/api/sessions");
    assert_eq!(response.status, 500, "{}", response.body);
    let body = response.json();
    assert_eq!(body["error"], json!("internal_error"));
    assert_eq!(body["code"], json!("internal_error"));
    assert_key_order(&response.body, &v1_error_order());
}

#[test]
fn legacy_detail_orders_the_presenter_fields() {
    let gateway = Gateway::start(
        "legacy-detail",
        json!({"sessionAdmin": {
            "ops": {
                "guard-record": {
                    "record": {"id": "s1", "kind": "chat", "cli": "claude", "label": "L"},
                    "internal": false,
                    "taskStateWritable": true,
                },
                "detail-dto": {
                    "runtime": {
                        "cwd": "/w",
                        "createdAt": "2026-01-01T00:00:00.000Z",
                        "lastActivity": 10,
                        "clients": 1,
                        "active": true,
                        "mergeState": {"ahead": 1, "behind": 0, "dirty": false, "mergeReady": true, "rebaseInProgress": false},
                        "effectiveModel": "opus",
                        "effectiveEffort": "max",
                        "subagent": null,
                    },
                    "providerSelection": null,
                    "providerBaseUrl": "https://api.example",
                    "cliStates": [],
                    "cliAvailability": [],
                    "pendingCliHandoff": null,
                },
                "guard-record:gone": {"record": null, "internal": false, "taskStateWritable": true},
            },
        }}),
    );
    let response = gateway.get("/api/sessions/s1");
    assert_eq!(response.status, 200, "{}", response.body);
    let body = response.json();
    assert_eq!(body["id"], json!("s1"));
    assert_eq!(body["providerBaseUrl"], json!("https://api.example"));
    assert_eq!(body["streaming"], json!(true));
    assert_eq!(body["autoContinue"], json!(true));
    assert_eq!(body["autoCommit"], json!(true));
    assert_key_order(
        &response.body,
        &[
            "id",
            "cwd",
            "createdAt",
            "lastActivity",
            "clients",
            "active",
            "mergeState",
            "cli",
            "type",
            "model",
            "effectiveModel",
            "effort",
            "effectiveEffort",
            "agent",
            "rolePrompt",
            "rolePresetId",
            "memory",
            "provider",
            "providerSelection",
            "providerBaseUrl",
            "cliAccounts",
            "experimentalMode",
            "subagent",
            "cliStates",
            "cliAvailability",
            "pendingCliHandoff",
            "pendingConfiguration",
            "streaming",
            "autoContinue",
            "autoCommit",
            "taskBoundTaskId",
            "dirId",
            "label",
        ],
    );
    let missing = gateway; // keep the gateway alive past the assertion block
    let absent = missing.get("/api/sessions/gone");
    assert_eq!(absent.status, 404, "{}", absent.body);
    assert_eq!(absent.json(), json!({"error": "Session not found"}));
}

fn record_guard(record: Value) -> Value {
    json!({
        "guard-record": {
            "record": record,
            "internal": false,
            "taskStateWritable": true,
        }
    })
}

#[test]
fn reclassify_skips_settled_turns_and_enqueues_long_replies() {
    let settled = Gateway::start(
        "reclassify-settled",
        json!({"sessionAdmin": {"ops": {
            "guard-record": record_guard(json!({"id": "s1", "kind": "chat"}))["guard-record"].clone(),
            "task-state": {"classifyState": "W", "goal": "g", "phase": "p", "goalState": null},
        }}}),
    );
    let response = settled.post("/api/sessions/s1/reclassify");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.json()["skipped"], json!(true));
    assert_eq!(response.json()["classifyState"], json!("W"));
    assert_eq!(
        response.json()["note"],
        json!("会话状态为 W，跳过重判（需用户发新消息触发，或 ?force=true 强制）")
    );
    assert_eq!(
        settled
            .calls()
            .iter()
            .map(|call| call["op"].clone())
            .collect::<Vec<_>>(),
        vec![json!("guard-record"), json!("task-state")]
    );

    let forced = Gateway::start(
        "reclassify-forced",
        json!({"sessionAdmin": {"ops": {
            "guard-record": record_guard(json!({"id": "s1", "kind": "chat"}))["guard-record"].clone(),
            "task-state": {"classifyState": "W"},
            "reply": "",
        }}}),
    );
    let short = forced.post("/api/sessions/s1/reclassify?force=true");
    assert_eq!(short.status, 400, "{}", short.body);
    assert_eq!(
        short.json(),
        json!({"error": "no assistant reply to classify against"})
    );

    forced.exchange(
        "POST",
        "/api/sessions/s1/reclassify?force=TRUE",
        Some("{}"),
        &[],
    );
    let calls = forced.calls();
    // The last pass asked for the reply and stopped (it is empty).
    assert_eq!(calls[calls.len() - 1]["op"], json!("reply"));
}

#[test]
fn reclassify_enqueues_a_classifiable_reply() {
    let reply = "a".repeat(25);
    let gateway = Gateway::start(
        "reclassify-ok",
        json!({"sessionAdmin": {"ops": {
            "guard-record": record_guard(json!({"id": "s1", "kind": "chat"}))["guard-record"].clone(),
            "task-state": {"classifyState": "P"},
            "reply": reply,
        }}}),
    );
    let response = gateway.post("/api/sessions/s1/reclassify");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.json()["ok"], json!(true));
    assert_eq!(
        response.json()["note"],
        json!("reclassify enqueued; 状态更新会通过 WS 异步到达")
    );
    let calls = gateway.calls();
    assert_eq!(calls.len(), 4);
    assert_eq!(calls[3]["op"], json!("enqueue"));
    assert_eq!(calls[3]["id"], json!("s1"));
    assert_eq!(calls[3]["reply"], json!(reply));
}

#[test]
fn mark_task_done_maps_terminal_streaming_and_the_dispatch_call() {
    let terminal = Gateway::start(
        "mark-done-terminal",
        json!({"sessionAdmin": {"ops": {
            "guard-record": record_guard(json!({"id": "s1", "kind": "chat"}))["guard-record"].clone(),
            "task-state": {"classifyState": "D"},
        }}}),
    );
    let response = terminal.post("/api/sessions/s1/mark-task-done");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(
        response.json(),
        json!({
            "ok": true, "alreadySucceeded": true, "alreadyDone": true,
            "classifyState": "D", "turnOutcome": "succeeded",
        })
    );

    let streaming = Gateway::start(
        "mark-done-streaming",
        json!({"sessionAdmin": {"ops": {
            "guard-record": record_guard(json!({"id": "s1", "kind": "chat"}))["guard-record"].clone(),
            "task-state": {"classifyState": "W"},
            "chat-flag": {"exists": true, "streaming": true},
        }}}),
    );
    let response = streaming.post("/api/sessions/s1/mark-task-done");
    assert_eq!(response.status, 409, "{}", response.body);
    assert_eq!(
        response.json(),
        json!({"error": "session is streaming", "note": "会话正在执行，无法标记执行成功"})
    );

    let done = Gateway::start(
        "mark-done-ok",
        json!({"sessionAdmin": {"ops": {
            "guard-record": record_guard(json!({"id": "s1", "kind": "chat"}))["guard-record"].clone(),
            "task-state": {"classifyState": "W", "goal": "ship", "phase": "coding"},
            "chat-flag": {"exists": true, "streaming": false},
        }}}),
    );
    let response = done.post("/api/sessions/s1/mark-task-done");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(
        response.json(),
        json!({"ok": true, "classifyState": "D", "turnOutcome": "succeeded"})
    );
    let calls = done.calls();
    assert_eq!(
        calls[calls.len() - 1],
        json!({
            "op": "dispatch-state",
            "id": "s1",
            "goal": "ship",
            "phase": "coding",
            "isTerminal": false,
        })
    );
}

#[test]
fn mark_goal_achieved_maps_501_409_already_and_success() {
    let read_only = Gateway::start(
        "goal-501",
        json!({"sessionAdmin": {"ops": {"guard-record": {
            "record": {"id": "s1", "kind": "chat"},
            "internal": false,
            "taskStateWritable": false,
        }}}}),
    );
    let response = read_only.post("/api/sessions/s1/mark-goal-achieved");
    assert_eq!(response.status, 501, "{}", response.body);
    assert_eq!(
        response.json(),
        json!({"error": "task state writes unavailable"})
    );

    let waiting = Gateway::start(
        "goal-409",
        json!({"sessionAdmin": {"ops": {
            "guard-record": record_guard(json!({"id": "s1", "kind": "chat"}))["guard-record"].clone(),
            "task-state": {"classifyState": "W"},
        }}}),
    );
    let response = waiting.post("/api/sessions/s1/mark-goal-achieved");
    assert_eq!(response.status, 409, "{}", response.body);
    assert_eq!(response.json()["error"], json!("turn not succeeded"));
    assert_eq!(response.json()["classifyState"], json!("W"));

    let already = Gateway::start(
        "goal-already",
        json!({"sessionAdmin": {"ops": {
            "guard-record": record_guard(json!({"id": "s1", "kind": "chat"}))["guard-record"].clone(),
            "task-state": {"classifyState": "D", "goalState": "achieved"},
        }}}),
    );
    let response = already.post("/api/sessions/s1/mark-goal-achieved");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(
        response.json(),
        json!({"ok": true, "alreadyAchieved": true, "classifyState": "D", "goalState": "achieved"})
    );

    let success = Gateway::start(
        "goal-set",
        json!({"sessionAdmin": {"ops": {
            "guard-record": record_guard(json!({"id": "s1", "kind": "chat"}))["guard-record"].clone(),
            "task-state": {"classifyState": "D", "goalState": "pending"},
        }}}),
    );
    let response = success.post("/api/sessions/s1/mark-goal-achieved");
    assert_eq!(response.status, 200, "{}", response.body);
    let calls = success.calls();
    assert_eq!(
        calls[calls.len() - 1],
        json!({"op": "set-goal-achieved", "id": "s1"})
    );
}

#[test]
fn reclassify_all_filters_and_reports_the_enqueued_ids() {
    let long = "b".repeat(30);
    let gateway = Gateway::start(
        "reclassify-all",
        json!({"sessionAdmin": {
            "records": [
                ["s1", {"id": "s1", "kind": "chat"}],
                ["s2", {"id": "s2", "type": "aux", "kind": "chat"}],
                ["s3", {"id": "s3", "kind": "chat"}],
                ["s4", {"id": "s4", "kind": "chat"}],
            ],
            "ops": {
                "task-state:s1": {"classifyState": "P", "goal": ""},
                "task-state:s2": {"classifyState": "P", "goal": ""},
                "task-state:s3": {"classifyState": "P", "goal": "a real goal"},
                "task-state:s4": {"classifyState": "D", "goal": ""},
                "reply:s1": long,
                "reply:s2": long,
                "reply:s3": long,
                "reply:s4": long,
            },
        }}),
    );
    let response = gateway.post("/api/reclassify-all");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(
        response.json(),
        json!({"ok": true, "count": 1, "ids": ["s1"], "onlyJunk": true})
    );

    let forced = gateway.post_json("/api/reclassify-all", &json!({"onlyJunk": false}));
    assert_eq!(forced.status, 200, "{}", forced.body);
    assert_eq!(
        forced.json(),
        json!({"ok": true, "count": 2, "ids": ["s1", "s3"], "onlyJunk": false})
    );
    let enqueued: Vec<Value> = gateway
        .calls()
        .into_iter()
        .filter(|call| call["op"] == json!("enqueue"))
        .map(|call| call["id"].clone())
        .collect();
    assert_eq!(enqueued, vec![json!("s1"), json!("s1"), json!("s3")]);
}

#[test]
fn directory_routes_present_their_own_shapes() {
    let gateway = Gateway::start(
        "directory",
        json!({"sessionAdmin": {
            "records": [
                ["s1", {"id": "s1", "dirId": "d1", "kind": "chat", "cli": "claude"}],
                ["s2", {"id": "s2", "dirId": "d1", "type": "aux"}],
                ["s3", {"id": "s3", "dirId": "d1", "taskBoundTaskId": "t1"}],
            ],
            "ops": {
                "directory": {"id": "d1", "label": "Repo"},
                "directory:gone": null,
                "dir-dto": [
                    {"runtime": {"terminalActive": false, "chatActive": true, "chatClients": 1},
                     "providerSelection": null, "cliStates": [], "pendingCliHandoff": null,
                     "invalid": null},
                    {"runtime": {"terminalActive": false, "chatActive": false},
                     "providerSelection": null, "cliStates": [], "pendingCliHandoff": null,
                     "invalid": {"reason": "missing worktree"}},
                ],
                "workspace-dto": [
                    {"runtime": {"clients": 1},
                     "facts": {"status": "idle", "pendingNotes": 0, "goal": "", "classifyState": "W",
                               "auxUnhealthySince": "2026-01-01T00:00:00.000Z"},
                     "invalid": null},
                ],
            },
        }}),
    );
    let response = gateway.get("/api/directories/d1/sessions");
    assert_eq!(response.status, 200, "{}", response.body);
    let body = response.json();
    assert_eq!(body["directory"], json!({"id": "d1", "label": "Repo"}));
    let sessions = body["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 2, "aux is visible here, task-bound is not");
    assert_eq!(sessions[0]["id"], json!("s1"));
    assert_eq!(sessions[0]["active"], json!(true));
    assert_eq!(sessions[1]["id"], json!("s2"));
    assert_eq!(
        sessions[1]["invalid"],
        json!({"reason": "missing worktree"})
    );
    let entries = &response.body[response.body.find("\"sessions\":").unwrap()..];
    assert_key_order(
        entries,
        &[
            "id",
            "dirId",
            "cli",
            "kind",
            "type",
            "cliSessionId",
            "label",
            "model",
            "effort",
            "effectiveEffort",
            "agent",
            "rolePrompt",
            "rolePresetId",
            "provider",
            "providerSelection",
            "experimentalMode",
            "subagent",
            "cliStates",
            "pendingCliHandoff",
            "pendingConfiguration",
            "createdAt",
            "branch",
            "worktreePath",
            "invalid",
            "mergeState",
            "lastActivity",
            "active",
            "clients",
        ],
    );

    let workspace = gateway.get("/api/directories/d1/workspace");
    assert_eq!(workspace.status, 200, "{}", workspace.body);
    let entry = &workspace.json()["sessions"][0];
    assert_eq!(entry["id"], json!("s1"));
    assert_eq!(entry["status"], json!("idle"));
    assert_eq!(entry["clients"], json!(1));
    assert_eq!(
        entry["auxUnhealthySince"],
        json!("2026-01-01T00:00:00.000Z")
    );
    assert_eq!(entry["goal"], json!(""));
    let fact_rows = &workspace.body[workspace.body.find("\"sessions\":").unwrap()..];
    assert_key_order(
        fact_rows,
        &[
            "id",
            "label",
            "cli",
            "kind",
            "branch",
            "invalid",
            "status",
            "stateSource",
            "currentFile",
            "lastActivity",
            "runStartedAt",
            "runEndedAt",
            "clients",
            "pendingNotes",
            "mergeState",
            "summary",
            "summaryTs",
            "classifyState",
            "goal",
            "taskShortCode",
            "phase",
            "auxUnhealthy",
            "auxUnhealthySince",
        ],
    );

    let missing = gateway.get("/api/directories/gone/sessions");
    assert_eq!(missing.status, 404);
    assert_eq!(missing.json(), json!({"error": "directory not found"}));
    let missing = gateway.get("/api/directories/gone/workspace");
    assert_eq!(missing.status, 404);
    assert_eq!(missing.json(), json!({"error": "directory not found"}));
}

#[test]
fn debug_classify_validates_then_runs_the_classifier() {
    let text = format!("line one\nline two {}", "c".repeat(40));
    let gateway = Gateway::start(
        "debug-classify",
        json!({"sessionAdmin": {"ops": {
            "record": {"id": "s1", "kind": "chat"},
            "history": {"failed": false, "history": [
                {"role": "user", "content": "hi"},
                {"role": "assistant", "content": text, "ts": "2026-11-14T10:00:00.000Z"},
            ]},
            "chat-flag": {"exists": true, "streaming": false},
            "task-state": {"classifyState": "P"},
        }}}),
    );
    let response = gateway.post("/api/debug/classify/s1");
    assert_eq!(response.status, 200, "{}", response.body);
    let body = response.json();
    assert_eq!(body["ok"], json!(true));
    assert_eq!(body["sessionName"], json!("s1"));
    assert_eq!(body["triggered"], json!(true));
    assert!(
        !body["tailPreview"].as_str().unwrap().contains('\n'),
        "newlines become spaces: {}",
        body["tailPreview"]
    );
    assert_eq!(
        body["note"],
        json!("classify enqueued — check server logs for classify RESULT")
    );
    let calls = gateway.calls();
    let run = calls
        .iter()
        .find(|call| call["op"] == json!("run-classify"))
        .unwrap();
    assert_eq!(run["text"], json!(text));
    assert_key_order(
        &response.body,
        &["ok", "sessionName", "triggered", "tailPreview", "note"],
    );

    let no_history = Gateway::start(
        "debug-no-history",
        json!({"sessionAdmin": {"ops": {"record": {"id": "s1", "kind": "chat"}}}}),
    );
    let response = no_history.post("/api/debug/classify/s1");
    assert_eq!(response.status, 400, "{}", response.body);
    assert_eq!(response.json(), json!({"error": "no history"}));

    let short = Gateway::start(
        "debug-short",
        json!({"sessionAdmin": {"ops": {
            "record": {"id": "s1", "kind": "chat"},
            "history": {"failed": false, "history": [
                {"role": "assistant", "content": "too short"},
            ]},
        }}}),
    );
    let response = short.post("/api/debug/classify/s1");
    assert_eq!(response.status, 400, "{}", response.body);
    assert_eq!(
        response.json(),
        json!({"error": "no valid assistant text", "len": 9})
    );

    let inactive = Gateway::start(
        "debug-inactive",
        json!({"sessionAdmin": {"ops": {
            "record": {"id": "s1", "kind": "chat"},
            "history": {"failed": false, "history": [
                {"role": "assistant", "content": "d".repeat(30)},
            ]},
        }}}),
    );
    let response = inactive.post("/api/debug/classify/s1");
    assert_eq!(response.status, 400, "{}", response.body);
    assert_eq!(response.json(), json!({"error": "session not active"}));

    let settled = Gateway::start(
        "debug-settled",
        json!({"sessionAdmin": {"ops": {
            "record": {"id": "s1", "kind": "chat"},
            "history": {"failed": false, "history": [
                {"role": "assistant", "content": "e".repeat(30)},
            ]},
            "chat-flag": {"exists": true},
            "task-state": {"classifyState": "D"},
        }}}),
    );
    let response = settled.post("/api/debug/classify/s1");
    assert_eq!(response.status, 409, "{}", response.body);
    assert_eq!(
        response.json(),
        json!({
            "error": "session is D; use ?force=true to override",
            "classifyState": "D",
        })
    );
}

#[test]
fn debug_test_cases_filter_and_sort_by_last_ts() {
    let gateway = Gateway::start(
        "debug-cases",
        json!({"sessionAdmin": {
            "records": [
                ["a", {"id": "a", "kind": "chat", "label": "A", "summary": "sa",
                       "taskState": {"classifyState": "D", "goal": "ga"}}],
                ["b", {"id": "b", "kind": "chat"}],
                ["c", {"id": "c", "kind": "terminal"}],
                ["d", {"id": "d", "type": "aux", "kind": "chat"}],
            ],
            "ops": {
                "history:a": {"failed": false, "history": [
                    {"role": "assistant", "content": "f".repeat(50), "ts": "2026-01-02T00:00:00.000Z"},
                ]},
                "history:b": {"failed": false, "history": [
                    {"role": "assistant", "content": "g".repeat(50), "ts": "2026-03-01T00:00:00.000Z"},
                ]},
                "history:c": {"failed": false, "history": []},
                "history:d": {"failed": false, "history": []},
            },
        }}),
    );
    let response = gateway.get("/api/debug/classify-test-cases");
    assert_eq!(response.status, 200, "{}", response.body);
    let body = response.json();
    assert_eq!(body["count"], json!(2));
    let cases = body["cases"].as_array().unwrap();
    assert_eq!(cases[0]["sessionId"], json!("b"));
    assert_eq!(cases[1]["sessionId"], json!("a"));
    assert_eq!(cases[1]["label"], json!("A"));
    assert_eq!(cases[1]["classifyState"], json!("D"));
    assert_eq!(cases[1]["goal"], json!("ga"));
    assert_eq!(cases[1]["summary"], json!("sa"));
    assert_eq!(cases[1]["lastTs"], json!("2026-01-02T00:00:00.000Z"));
    assert_eq!(cases[0]["lastAssistantFullTail"], json!("g".repeat(50)));
    assert_key_order(
        &response.body,
        &[
            "sessionId",
            "label",
            "classifyState",
            "goal",
            "summary",
            "lastAssistantTail300",
            "lastAssistantFullTail",
            "lastActivity",
            "lastTs",
        ],
    );
}

#[test]
fn host_failure_is_the_503_shape_and_head_has_no_body() {
    let gateway = Gateway::start("host-down", json!({"sessionAdmin": {"hostDown": true}}));
    let response = gateway.get("/api/sessions");
    assert_eq!(response.status, 503, "{}", response.body);
    let body = response.json();
    assert_eq!(body["code"], json!("rust_backend_unavailable"));
    assert_eq!(body["error"], json!("会话管理接口尚未就绪，请更新原生模块"));
    assert_key_order(&response.body, &["error", "code"]);

    let head = gateway.head("/api/v1/sessions");
    assert_eq!(head.status, 503);
    assert_eq!(head.body, "");
}

#[test]
fn malformed_percent_escape_never_reaches_the_handler() {
    let gateway = Gateway::start("bad-param", json!({}));
    let response = gateway.get("/api/sessions/%E0%A4%A");
    assert_eq!(response.status, 400, "{}", response.body);
    assert_eq!(response.json()["code"], json!("request_error"));
    assert!(gateway.calls().is_empty());
}
