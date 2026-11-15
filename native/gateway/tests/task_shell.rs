#![recursion_limit = "256"]

//! Integration coverage for the 42 task-shell routes retired from
//! `src/task-shell/routes.js` and answered by the Rust front door
//! (`native/gateway/src/app/task_shell.rs`). The Node process here is only the
//! protocol fixture: it answers `POST /api/__host/task-shell` from
//! `FIXTURE_HOST_SCRIPT` and appends every payload to
//! `task-shell-calls.jsonl`, so the tests can assert what the front door asked
//! the runtime to do (and in which order).

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
        "multicc-gateway-task-shell-{}-{tag}-{nanos}",
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
        fs::read_to_string(self.state.join("task-shell-calls.jsonl"))
            .unwrap_or_default()
            .lines()
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn exchange(&self, method: &str, url: &str, body: Option<&str>) -> Response {
        let payload = body.unwrap_or("");
        let mut request =
            format!("{method} {url} HTTP/1.1\r\nHost: localhost\r\nX-Request-Id: ts-req-1\r\n");
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
        self.exchange("GET", url, None)
    }
    fn head(&self, url: &str) -> Response {
        self.exchange("HEAD", url, None)
    }
    fn options(&self, url: &str) -> Response {
        self.exchange("OPTIONS", url, None)
    }
    fn send(&self, method: &str, url: &str, body: &Value) -> Response {
        self.exchange(method, url, Some(&body.to_string()))
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

fn ok(value: Value) -> Value {
    json!({ "ok": true, "value": value })
}

/// One scripted answer per host op, keyed the way the fixture resolves them.
fn world() -> Value {
    let entry = json!({
        "ok": true,
        "task": { "id": "tsk_1", "title": "Task One" },
        "messages": [
            {"id": "session:m0", "sourceMessageId": "m0", "role": "assistant", "content": "0"},
            {"id": "session:m1", "sourceMessageId": "m1", "role": "assistant", "content": "1"},
            {"id": "session:m2", "sourceMessageId": "m2", "role": "assistant", "content": "2"},
            {"id": "session:m3", "sourceMessageId": "m3", "role": "assistant", "content": "3"},
            {"id": "session:m4", "sourceMessageId": "m4", "role": "assistant", "content": "4"},
            {"id": "session:m5", "sourceMessageId": "m5", "role": "assistant", "content": "5"},
            {"id": "session:m6", "sourceMessageId": "m6", "role": "assistant", "content": "6"}
        ],
        "execution": { "busy": false, "status": "idle" },
        "readOnly": false,
        "url": "/air?task=tsk_1"
    });
    let ops = json!({
        "task-entry": ok(entry),
        "artifacts": ok(json!({"taskId": "tsk_1", "title": "", "items": [{"artifactId": "report"}]})),
        "shell-artifacts-scope": ok(json!({"taskId": "tsk_1"})),
        "fork": ok(json!({"ok": true, "taskId": "tsk_fork"})),
        "task-message": ok(json!({"ok": true, "receiptId": "rc_1", "taskId": "tsk_1"})),
        "context": ok(json!({"traceId": "tr_1", "currentTask": {"taskId": "tsk_1"}})),
        "separation-latest": ok(json!({"state": "pending", "taskId": "tsk_s"})),
        "separation-decide": ok(json!({"ok": true, "state": "accepted"})),
        "open": ok(json!({"id": "sh_1", "currentTaskId": null})),
        "view": ok(json!({"id": "sh_1", "currentTaskId": "tsk_1"})),
        "chat": ok(json!({"shellId": "sh_1", "taskId": "tsk_1"})),
        "shell-history": ok(json!({"messages": [], "hasMore": false})),
        "task-index": ok(json!({"shellId": "sh_1", "tasks": []})),
        "task-operations-list": ok(json!([{"id": "op_1", "status": "queued"}])),
        "task-operations-preview": ok(json!({"previewToken": "pv_1"})),
        "task-operations-apply": ok(json!({"ok": true, "id": "op_1", "status": "applied"})),
        "task-operations-get": ok(json!({"id": "op_1", "status": "applied"})),
        "task-operations-cancel": ok(json!({"id": "op_1", "status": "cancelled"})),
        "task-operations-undo": ok(json!({"id": "op_1", "status": "undone"})),
        "attribution-list": ok(json!([{"id": "d_1"}])),
        "attribution-accept": ok(json!({"ok": true, "id": "d_1", "action": "apply"})),
        "attribution-dismiss": ok(json!({"ok": true, "id": "d_1", "action": "dismiss"})),
        "attribution-defer": ok(json!({"ok": true, "id": "d_1", "action": "defer"})),
        "attribution-undo": ok(json!({"ok": true, "id": "d_1", "action": "undo"})),
        "independent-request": ok(json!({"ok": true, "id": "c_1", "state": "waiting"})),
        "independent-list": ok(json!([{"id": "c_1", "state": "waiting"}])),
        "independent-get": ok(json!({"id": "c_1", "state": "waiting"})),
        "independent-apply": ok(json!({"ok": true, "id": "c_1", "state": "applied"})),
        "independent-cancel": ok(json!({"ok": true, "id": "c_1", "state": "cancelled"})),
        "independent-retry": ok(json!({"ok": true, "id": "c_1", "state": "waiting"})),
        "relations-list": ok(json!([{"id": "r_1", "kind": "blocks"}])),
        "relations-create": ok(json!({"ok": true, "id": "r_1"})),
        "relations-remove": ok(json!({"ok": true, "id": "r_1"})),
        "remove-shell": ok(json!({"ok": true, "removed": true})),
        "links": ok(json!({"ok": true, "taskId": "tsk_1"})),
        "select-target": ok(json!({"ok": true, "changed": true, "cursorVersion": 2})),
        "tasks-resolve": ok(json!({"ok": true, "taskId": "tsk_1"})),
        "detail": ok(json!({"taskId": "tsk_1", "execution": {"busy": true}})),
        "shell-message": ok(json!({"ok": true, "receiptId": "rc_2"})),
        "receipt-retry": ok(json!({"ok": true, "receiptId": "rc_3"}))
    });
    json!({ "taskShell": { "ops": ops } })
}

#[test]
fn task_entry_and_config_answer_from_the_script() {
    let gateway = Gateway::start("entry", world());
    let entry = gateway.get("/api/task-shell-tasks/tsk_1");
    assert_eq!(entry.status, 200);
    assert_eq!(entry.json()["task"]["id"], "tsk_1");
    assert_eq!(gateway.calls()[0]["op"], "task-entry");

    // config never touches the host port.
    let before = gateway.calls().len();
    let config = gateway.get("/api/task-shells/config");
    assert_eq!(config.status, 200);
    assert_eq!(config.body, "{\"enabled\":true}");
    assert_eq!(gateway.calls().len(), before);
}

#[test]
fn task_history_paginates_in_rust_and_appends_the_entry_tail() {
    let gateway = Gateway::start("history", world());
    let latest = gateway.get("/api/task-shell-tasks/tsk_1/history?limit=3");
    assert_eq!(latest.status, 200);
    let latest = latest.json();
    assert_eq!(
        latest["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["sourceMessageId"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["m4", "m5", "m6"]
    );
    assert_eq!(latest["hasMore"], true);
    assert_eq!(latest["task"]["id"], "tsk_1");
    assert_eq!(latest["execution"]["busy"], false);
    assert_eq!(latest["readOnly"], false);

    let body = gateway.get("/api/task-shell-tasks/tsk_1/history?before=session:m4&limit=3");
    assert_eq!(
        body.json()["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["sourceMessageId"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["m1", "m2", "m3"]
    );

    let around = gateway.get("/api/task-shell-tasks/tsk_1/history?around=m0&limit=3");
    let around = around.json();
    assert_eq!(around["found"], true);
    assert_eq!(around["hasNewer"], true);
    // messages, hasMore, found, hasNewer come from the page; task/execution/
    // readOnly are appended after them.
    assert_key_order(
        &gateway
            .get("/api/task-shell-tasks/tsk_1/history?around=m0&limit=3")
            .body,
        &[
            "messages",
            "hasMore",
            "found",
            "hasNewer",
            "task",
            "execution",
            "readOnly",
        ],
    );

    let missing = gateway.get("/api/task-shell-tasks/tsk_1/history?before=missing");
    assert_eq!(missing.json()["found"], false);
}

#[test]
fn artifacts_reuse_the_scope_decision_and_fall_back_when_unbound() {
    let gateway = Gateway::start("artifacts", world());
    let bound = gateway.get("/api/task-shells/sh_1/artifacts");
    assert_eq!(bound.status, 200);
    assert_eq!(bound.json()["items"][0]["artifactId"], "report");
    let calls = gateway.calls();
    assert_eq!(calls[0]["op"], "shell-artifacts-scope");
    assert_eq!(calls[1]["op"], "artifacts");
    assert_eq!(calls[1]["taskId"], "tsk_1");

    let mut script = world();
    script["taskShell"]["ops"]["shell-artifacts-scope"] = ok(json!({}));
    let gateway = Gateway::start("artifacts-empty", script);
    let fallback = gateway.get("/api/task-shells/sh_2/artifacts");
    assert_eq!(fallback.status, 200);
    assert_eq!(
        fallback.body,
        "{\"taskId\":null,\"title\":\"\",\"items\":[]}"
    );
    assert_eq!(
        gateway.calls().len(),
        1,
        "the empty scope never collects artifacts"
    );
}

#[test]
fn session_and_shell_routes_forward_path_body_and_query() {
    let gateway = Gateway::start("forward", world());

    assert_eq!(
        gateway
            .get("/api/sessions/s1/context?include=messages&traceId=tr_9")
            .status,
        200
    );
    let context = gateway.calls().pop().unwrap();
    assert_eq!(context["op"], "context");
    assert_eq!(context["sessionId"], "s1");
    assert_eq!(context["includeMessages"], true);
    assert_eq!(context["traceId"], "tr_9");

    let separation = gateway.get("/api/sessions/s1/task-separation");
    assert_eq!(
        separation.body,
        "{\"ok\":true,\"suggestion\":{\"state\":\"pending\",\"taskId\":\"tsk_s\"}}"
    );
    assert_eq!(gateway.calls().pop().unwrap()["op"], "separation-latest");

    assert_eq!(
        gateway
            .send(
                "POST",
                "/api/sessions/s1/task-separation/g1",
                &json!({"decision": "accept"})
            )
            .status,
        200
    );
    let decide = gateway.calls().pop().unwrap();
    assert_eq!(decide["op"], "separation-decide");
    assert_eq!(decide["suggestionId"], "g1");
    assert_eq!(decide["decision"], "accept");

    assert_eq!(
        gateway
            .send("POST", "/api/task-shells", &json!({"sessionId": "s1"}))
            .status,
        200
    );
    assert_eq!(gateway.calls().pop().unwrap()["sessionId"], "s1");

    assert_eq!(gateway.get("/api/task-shells/sh_1/chat").status, 200);
    assert_eq!(gateway.calls().pop().unwrap()["op"], "chat");

    assert_eq!(
        gateway
            .get("/api/task-shells/sh_1/history?historyScope=archive&limit=4")
            .status,
        200
    );
    let history = gateway.calls().pop().unwrap();
    assert_eq!(history["op"], "shell-history");
    assert_eq!(history["includeHidden"], true);
    assert_eq!(history["limit"], "4");

    assert_eq!(
        gateway
            .get("/api/task-shells/sh_1/task-index?includeEmpty=1")
            .status,
        200
    );
    assert_eq!(gateway.calls().pop().unwrap()["includeEmpty"], true);

    assert_eq!(gateway.get("/api/task-shells/sh_1").status, 200);
    assert_eq!(gateway.calls().pop().unwrap()["op"], "view");
}

#[test]
fn task_operations_wrap_lists_and_forward_the_apply_body() {
    let gateway = Gateway::start("operations", world());
    let listed = gateway.get("/api/task-shells/sh_1/task-operations");
    assert_eq!(
        listed.body,
        "{\"ok\":true,\"operations\":[{\"id\":\"op_1\",\"status\":\"queued\"}]}"
    );

    assert_eq!(gateway.get("/api/task-operations/op_1").status, 200);
    assert_eq!(gateway.calls().pop().unwrap()["operationId"], "op_1");

    assert_eq!(
        gateway
            .send(
                "POST",
                "/api/task-shells/sh_1/task-operations/preview",
                &json!({"turns": [{"turnId": "t1"}], "range": [0, 2], "target": {"taskId": "tsk_x"}})
            )
            .status,
        200
    );
    let preview = gateway.calls().pop().unwrap();
    assert_eq!(preview["op"], "task-operations-preview");
    assert_eq!(preview["turns"][0]["turnId"], "t1");

    assert_eq!(
        gateway
            .send(
                "POST",
                "/api/task-shells/sh_1/task-operations",
                &json!({"clientMsgId": "m1", "queue": true, "expectedRevision": 3, "target": {"taskId": "tsk_x"}})
            )
            .status,
        200
    );
    let apply = gateway.calls().pop().unwrap();
    assert_eq!(apply["op"], "task-operations-apply");
    assert_eq!(apply["queue"], true);
    assert_eq!(apply["expectedRevision"], 3);

    assert_eq!(
        gateway
            .send(
                "POST",
                "/api/task-operations/op_1/cancel",
                &json!({"clientMsgId": "c1"})
            )
            .status,
        200
    );
    assert_eq!(
        gateway.calls().pop().unwrap()["op"],
        "task-operations-cancel"
    );
    assert_eq!(
        gateway
            .send("POST", "/api/task-operations/op_1/undo", &json!({}))
            .status,
        200
    );
    assert_eq!(gateway.calls().pop().unwrap()["op"], "task-operations-undo");
}

#[test]
fn attribution_decisions_wrap_lists_and_map_verbs() {
    let gateway = Gateway::start("attribution", world());
    assert_eq!(
        gateway
            .get("/api/task-shells/sh_1/attribution-decisions?includeHidden=1")
            .body,
        "{\"ok\":true,\"decisions\":[{\"id\":\"d_1\"}]}"
    );
    assert_eq!(gateway.calls().pop().unwrap()["includeHidden"], true);
    for (verb, expected) in [
        ("accept", "attribution-accept"),
        ("dismiss", "attribution-dismiss"),
        ("defer", "attribution-defer"),
        ("undo", "attribution-undo"),
    ] {
        assert_eq!(
            gateway
                .send(
                    "POST",
                    &format!("/api/task-shells/sh_1/attribution-decisions/d_1/{verb}"),
                    &json!({"clientMsgId": "c"})
                )
                .status,
            200
        );
        let call = gateway.calls().pop().unwrap();
        assert_eq!(call["op"], expected);
        assert_eq!(call["decisionId"], "d_1");
    }
}

#[test]
fn continuations_wrap_lists_but_detail_is_raw() {
    let gateway = Gateway::start("continuations", world());
    assert_eq!(
        gateway.get("/api/task-shells/sh_1/task-continuations").body,
        "{\"ok\":true,\"continuations\":[{\"id\":\"c_1\",\"state\":\"waiting\"}]}"
    );
    assert_eq!(
        gateway.get("/api/task-continuations/c_1").body,
        "{\"id\":\"c_1\",\"state\":\"waiting\"}"
    );
    for (suffix, expected) in [
        ("apply", "independent-apply"),
        ("cancel", "independent-cancel"),
        ("retry", "independent-retry"),
    ] {
        assert_eq!(
            gateway
                .send(
                    "POST",
                    &format!("/api/task-continuations/c_1/{suffix}"),
                    &json!({})
                )
                .status,
            200
        );
        assert_eq!(gateway.calls().pop().unwrap()["op"], expected);
    }
}

#[test]
fn relations_wrap_lists_and_forward_edges() {
    let gateway = Gateway::start("relations", world());
    assert_eq!(
        gateway.get("/api/task-shells/sh_1/relations").body,
        "{\"ok\":true,\"relations\":[{\"id\":\"r_1\",\"kind\":\"blocks\"}]}"
    );
    assert_eq!(
        gateway
            .send(
                "POST",
                "/api/task-shells/sh_1/relations",
                &json!({"kind": "blocks", "fromTaskId": "tsk_a", "toTaskId": "tsk_b", "clientMsgId": "c"})
            )
            .status,
        200
    );
    let create = gateway.calls().pop().unwrap();
    assert_eq!(create["op"], "relations-create");
    assert_eq!(create["fromTaskId"], "tsk_a");
    assert_eq!(
        gateway
            .send(
                "POST",
                "/api/task-shells/sh_1/relations/remove",
                &json!({"relationId": "r_1"})
            )
            .status,
        200
    );
    assert_eq!(gateway.calls().pop().unwrap()["relationId"], "r_1");
}

#[test]
fn remaining_shell_writes_forward_their_bodies() {
    let gateway = Gateway::start("writes", world());
    assert_eq!(
        gateway
            .send(
                "POST",
                "/api/task-shell-tasks/tsk_1/fork",
                &json!({"title": "forked"})
            )
            .status,
        200
    );
    let fork = gateway.calls().pop().unwrap();
    assert_eq!(fork["op"], "fork");
    assert_eq!(fork["body"]["title"], "forked");

    assert_eq!(
        gateway
            .send(
                "POST",
                "/api/task-shell-tasks/tsk_1/messages",
                &json!({"text": "hi", "clientMsgId": "m1"})
            )
            .status,
        200
    );
    assert_eq!(gateway.calls().pop().unwrap()["op"], "task-message");

    assert_eq!(
        gateway
            .send("DELETE", "/api/task-shells/sh_1", &json!({}))
            .status,
        200
    );
    assert_eq!(gateway.calls().pop().unwrap()["op"], "remove-shell");

    assert_eq!(
        gateway
            .send(
                "POST",
                "/api/task-shells/sh_1/links",
                &json!({"taskId": "tsk_1"})
            )
            .status,
        200
    );
    assert_eq!(gateway.calls().pop().unwrap()["taskId"], "tsk_1");

    assert_eq!(
        gateway
            .send(
                "POST",
                "/api/task-shells/sh_1/select-target",
                &json!({"taskId": "tsk_1", "expectedCursorVersion": 1})
            )
            .status,
        200
    );
    let select = gateway.calls().pop().unwrap();
    assert_eq!(select["op"], "select-target");
    assert_eq!(select["expectedCursorVersion"], 1);

    assert_eq!(
        gateway
            .send(
                "POST",
                "/api/task-shells/sh_1/tasks/resolve",
                &json!({"taskText": "do it", "title": "T"})
            )
            .status,
        200
    );
    let resolve = gateway.calls().pop().unwrap();
    assert_eq!(resolve["op"], "tasks-resolve");
    assert_eq!(resolve["taskText"], "do it");

    assert_eq!(gateway.get("/api/task-shells/sh_1/tasks/tsk_1").status, 200);
    assert_eq!(gateway.calls().pop().unwrap()["op"], "detail");

    assert_eq!(
        gateway
            .send(
                "POST",
                "/api/task-shells/sh_1/messages",
                &json!({"text": "hi"})
            )
            .status,
        200
    );
    assert_eq!(gateway.calls().pop().unwrap()["op"], "shell-message");

    assert_eq!(
        gateway
            .send(
                "POST",
                "/api/task-shells/sh_1/receipts/r1/retry",
                &json!({})
            )
            .status,
        200
    );
    let retry = gateway.calls().pop().unwrap();
    assert_eq!(retry["op"], "receipt-retry");
    assert_eq!(retry["receiptId"], "r1");

    assert_eq!(
        gateway
            .send(
                "POST",
                "/api/task-shells/sh_1/tasks/tsk_1/independent-continue",
                &json!({"clientMsgId": "c"})
            )
            .status,
        200
    );
    assert_eq!(gateway.calls().pop().unwrap()["op"], "independent-request");
}

#[test]
fn the_error_envelope_and_status_mapping_survive_the_host_port() {
    let mut script = world();
    script["taskShell"]["ops"]["tasks-resolve"] = json!({
        "ok": false,
        "error": {
            "code": "task_not_linked",
            "message": "Task not linked",
            "status": 403,
            "conflicts": ["turn_1"],
            "detail": {"turnId": "turn_1"},
            "receiptId": "rc_9",
            "taskId": "tsk_9",
            "notDelivered": true
        }
    });
    let gateway = Gateway::start("error", script);
    let response = gateway.send(
        "POST",
        "/api/task-shells/sh_1/tasks/resolve",
        &json!({"taskId": "tsk_x"}),
    );
    assert_eq!(response.status, 403);
    assert_key_order(
        &response.body,
        &[
            "ok",
            "code",
            "message",
            "conflicts",
            "detail",
            "receiptId",
            "taskId",
            "notDelivered",
        ],
    );
    let body = response.json();
    assert_eq!(body["ok"], false);
    assert_eq!(body["code"], "task_not_linked");
    assert_eq!(body["conflicts"][0], "turn_1");
    assert_eq!(body["detail"]["turnId"], "turn_1");
    assert_eq!(body["receiptId"], "rc_9");
    assert_eq!(body["notDelivered"], true);

    // A missing status falls back to 500, exactly like `error.status || 500`.
    let mut script = world();
    script["taskShell"]["ops"]["view"] =
        json!({"ok": false, "error": {"code": "boom", "message": "Boom"}});
    let gateway = Gateway::start("error-500", script);
    assert_eq!(gateway.get("/api/task-shells/sh_1").status, 500);
}

#[test]
fn host_down_is_a_503_and_malformed_params_are_a_400() {
    let mut script = world();
    script["taskShell"]["hostDown"] = json!(true);
    let gateway = Gateway::start("host-down", script);
    let response = gateway.get("/api/task-shells/sh_1");
    assert_eq!(response.status, 503);
    assert_eq!(response.json()["code"], "rust_backend_unavailable");

    // A malformed escape never reaches the handler: the front door's request
    // parser refuses it with the shared safe-error DTO, so no parameter
    // decoding happens here at all.
    let gateway = Gateway::start("bad-param", world());
    let response = gateway.get("/api/task-shells/%E0%A4%A");
    assert_eq!(response.status, 400);
    assert_eq!(response.json()["code"], json!("request_error"));
}

#[test]
fn options_allow_and_head_follow_express() {
    let gateway = Gateway::start("options", world());
    for (path, allow) in [
        ("/api/task-shells/config", "GET,HEAD,DELETE"),
        ("/api/task-shells/sh_1", "GET,HEAD,DELETE"),
        ("/api/task-shells/sh_1/task-operations", "GET,HEAD,POST"),
        ("/api/task-shells/sh_1/relations", "GET,HEAD,POST"),
        ("/api/task-shells/sh_1/tasks/resolve", "POST,GET,HEAD"),
        ("/api/task-shells/sh_1/tasks/abc", "GET,HEAD"),
        ("/api/task-shells/sh_1/messages", "POST"),
    ] {
        let response = gateway.options(path);
        assert_eq!(response.status, 200, "{path}");
        assert_eq!(response.header("allow"), Some(allow), "{path}");
        assert_eq!(response.body, allow, "{path}");
    }
    // HEAD is served by the GET layer and carries the Allow-able status.
    assert_eq!(gateway.head("/api/task-shells/sh_1/chat").status, 200);
}

#[test]
fn routes_outside_the_cluster_are_left_to_node() {
    let gateway = Gateway::start("outside", world());
    // The front door must not claim these, so they go to the Node child; the
    // fixture answers every unhandled path with the literal "ok".
    assert_eq!(gateway.get("/api/task-shells").status, 200);
    assert_eq!(gateway.get("/api/task-shells").body, "ok");
    assert_eq!(gateway.get("/api/task-shells/sh_1/tasks").body, "ok");
    assert!(
        gateway.calls().is_empty(),
        "unclaimed paths never reach the host port"
    );
}
