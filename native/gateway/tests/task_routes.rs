#![recursion_limit = "256"]

//! Integration coverage for the 16 task-surface routes retired from
//! `src/routes/task-planning.js`, `src/routes/task-board.js`,
//! `src/routes/task-search.js`, `src/routes/task-goal.js`,
//! `src/routes/task-graph.js` and `src/task-shell/attribution-settings.js`,
//! answered by the Rust front door (`native/gateway/src/app/task_routes.rs`).
//! The Node process here is only the protocol fixture: it answers
//! `POST /api/__host/task-routes` from `FIXTURE_HOST_SCRIPT` and appends every
//! payload to `task-routes-calls.jsonl`, so the tests can assert what the front
//! door asked the runtime to do, and in which order.

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
const JSON_TYPE: &str = "application/json; charset=utf-8";

fn unique(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "multicc-gateway-task-routes-{}-{tag}-{nanos}",
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
        fs::read_to_string(self.state.join("task-routes-calls.jsonl"))
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
        extra: &[(&str, &str)],
        body: Option<&str>,
    ) -> Response {
        let payload = body.unwrap_or("");
        let mut request =
            format!("{method} {url} HTTP/1.1\r\nHost: localhost\r\nX-Request-Id: task-req-1\r\n");
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
    fn head(&self, url: &str) -> Response {
        self.exchange("HEAD", url, &[], None)
    }
    fn options(&self, url: &str) -> Response {
        self.exchange("OPTIONS", url, &[], None)
    }
    fn send(&self, method: &str, url: &str, body: &Value) -> Response {
        self.exchange(method, url, &[], Some(&body.to_string()))
    }
    fn post(&self, url: &str, body: &Value) -> Response {
        self.send("POST", url, body)
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

fn world(ops: Value) -> Value {
    json!({ "taskRoutes": { "ops": ops } })
}

// ── planning ────────────────────────────────────────────────────────────────

#[test]
fn planning_create_forwards_the_body_and_builds_the_envelope() {
    let gateway = Gateway::start(
        "planning-create",
        world(json!({
            "planning-create": ok(json!({"task": {"id": "t1", "title": "A"}, "revision": 7}))
        })),
    );
    let response = gateway.post(
        "/api/task-board/tasks",
        &json!({"title": "A", "dirId": "d1"}),
    );
    assert_eq!(response.status, 200);
    assert_eq!(
        response.body,
        r#"{"ok":true,"task":{"id":"t1","title":"A"},"revision":7}"#
    );
    assert_eq!(response.header("content-type"), Some(JSON_TYPE));
    let calls = gateway.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["op"], "planning-create");
    assert_eq!(calls[0]["body"], json!({"title": "A", "dirId": "d1"}));
    assert!(calls[0].get("taskId").is_none());
}

#[test]
fn planning_update_and_its_alias_share_one_op_and_decode_the_param() {
    let gateway = Gateway::start(
        "planning-update",
        world(json!({
            "planning-update:t/1": ok(json!({"task": {"id": "t/1"}, "revision": 3}))
        })),
    );
    let update = gateway.post(
        "/api/task-board/tasks/t%2F1/update",
        &json!({"expectedRevision": 2}),
    );
    assert_eq!(update.status, 200);
    assert_eq!(
        update.body,
        r#"{"ok":true,"task":{"id":"t/1"},"revision":3}"#
    );
    let alias = gateway.post("/api/task-board/tasks/t%2F1/planning", &json!({}));
    assert_eq!(alias.status, 200);
    let calls = gateway.calls();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0]["op"], "planning-update");
    assert_eq!(
        calls[0]["taskId"], "t/1",
        "the path param is percent-decoded like Express"
    );
    assert_eq!(calls[1]["op"], "planning-update");
    assert_eq!(calls[1]["taskId"], "t/1", "the alias is the same handler");
    assert_eq!(calls[1]["body"], json!({}));
}

#[test]
fn planning_refusals_use_the_kernel_ladder_but_keep_host_statuses() {
    let gateway = Gateway::start(
        "planning-refusals",
        world(json!({
            "planning-update:t1": ok(json!({"outcome": {
                "error": "revision_conflict", "expectedRevision": 3, "actualRevision": 4}})),
            "planning-update:t2": ok(json!({"reply": {"status": 409, "body": {"error": "task_busy"}}})),
            "planning-update:t3": ok(json!({"outcome": {"error": "task_not_found"}})),
            "planning-update:t4": ok(json!({"outcome": {"error": "persistence_failed"}})),
            "planning-update:t5": ok(json!({"outcome": {"error": "something_new"}})),
            "planning-update:t6": ok(json!({"reply": {
                "status": 409, "body": {"error": "directory_not_found"}}}))
        })),
    );
    let conflict = gateway.post("/api/task-board/tasks/t1/update", &json!({}));
    assert_eq!(conflict.status, 409);
    assert_eq!(
        conflict.body,
        r#"{"error":"revision_conflict","expectedRevision":3,"actualRevision":4}"#
    );

    // A refusal the retired handler sent itself keeps its own status: the
    // kernel ladder would have said 400 for an unknown code.
    let busy = gateway.post("/api/task-board/tasks/t2/update", &json!({}));
    assert_eq!(busy.status, 409);
    assert_eq!(busy.body, r#"{"error":"task_busy"}"#);

    let missing = gateway.post("/api/task-board/tasks/t3/update", &json!({}));
    assert_eq!(missing.status, 404);
    assert_eq!(missing.body, r#"{"error":"task_not_found"}"#);

    let disk = gateway.post("/api/task-board/tasks/t4/update", &json!({}));
    assert_eq!(disk.status, 500);

    let unknown = gateway.post("/api/task-board/tasks/t5/update", &json!({}));
    assert_eq!(unknown.status, 400);

    let directory = gateway.post("/api/task-board/tasks/t6/update", &json!({}));
    assert_eq!(directory.status, 409);
    assert_eq!(directory.body, r#"{"error":"directory_not_found"}"#);
    assert_eq!(gateway.calls().len(), 6);
}

#[test]
fn planning_rename_and_move_stay_on_their_own_ports() {
    let gateway = Gateway::start(
        "planning-tails",
        world(json!({
            "planning-rename:t1": ok(json!({"task": {"id": "t1", "title": "B"}, "revision": 8})),
            "planning-move:t1": ok(json!({"task": {"id": "t1"}, "revision": 9}))
        })),
    );
    let rename = gateway.post("/api/task-board/tasks/t1/title", &json!({"title": "B"}));
    assert_eq!(
        rename.body,
        r#"{"ok":true,"task":{"id":"t1","title":"B"},"revision":8}"#
    );
    let moved = gateway.post(
        "/api/task-board/tasks/t1/move",
        &json!({"workflowStage": "done"}),
    );
    assert_eq!(moved.body, r#"{"ok":true,"task":{"id":"t1"},"revision":9}"#);
    let calls = gateway.calls();
    assert_eq!(calls[0]["op"], "planning-rename");
    assert_eq!(calls[1]["op"], "planning-move");
    assert_eq!(calls[1]["body"], json!({"workflowStage": "done"}));
}

// ── retention ───────────────────────────────────────────────────────────────

#[test]
fn retention_preview_reorders_with_the_shared_comparator() {
    let gateway = Gateway::start(
        "retention-preview",
        world(json!({
            "retention-preview:d1": ok(json!({
                "limit": 20, "count": 3, "maxBatch": 100,
                "entries": [
                    {"id": "t2", "title": "B", "at": 300},
                    {"id": "t1", "title": "A", "at": 100}
                ],
                "idOrder": ["t2", "t1"]
            }))
        })),
    );
    let response = gateway.get("/api/task-board/directories/d1/retention");
    assert_eq!(response.status, 200);
    assert_eq!(
        response.body,
        r#"{"ok":true,"limit":20,"count":3,"maxBatch":100,"tasks":[{"id":"t1","title":"A","lastInteractionAt":100},{"id":"t2","title":"B","lastInteractionAt":300}]}"#
    );
    assert_key_order(
        &response.body,
        &["ok", "limit", "count", "maxBatch", "tasks"],
    );
    assert_key_order(&response.body, &["id", "title", "lastInteractionAt"]);
    let calls = gateway.calls();
    assert_eq!(calls[0]["op"], "retention-preview");
    assert_eq!(calls[0]["dirId"], "d1");
}

#[test]
fn retention_refusals_are_reply_passthroughs() {
    let gateway = Gateway::start(
        "retention-refusals",
        world(json!({
            "retention-preview:d1": ok(json!({"reply": {"status": 404,
                "body": {"ok": false, "code": "directory_not_found"}}})),
            "retention-preview:d2": ok(json!({"reply": {"status": 503,
                "body": {"ok": false, "code": "task_inventory_unavailable"}}})),
            "retention-delete:d1": ok(json!({"reply": {"status": 400,
                "body": {"ok": false, "code": "invalid_selection"}}})),
            "retention-delete:d2": ok(json!({"deleted": ["t1"],
                "skipped": [{"id": "t2", "reason": "no_longer_eligible"}],
                "count": 2, "limit": 20}))
        })),
    );
    let missing = gateway.get("/api/task-board/directories/d1/retention");
    assert_eq!(missing.status, 404);
    assert_eq!(missing.body, r#"{"ok":false,"code":"directory_not_found"}"#);
    let unwired = gateway.get("/api/task-board/directories/d2/retention");
    assert_eq!(unwired.status, 503);
    assert_eq!(
        unwired.body,
        r#"{"ok":false,"code":"task_inventory_unavailable"}"#
    );

    let invalid = gateway.post(
        "/api/task-board/directories/d1/retention",
        &json!({"taskIds": "t1"}),
    );
    assert_eq!(invalid.status, 400);
    assert_eq!(invalid.body, r#"{"ok":false,"code":"invalid_selection"}"#);
    let calls = gateway.calls();
    assert_eq!(calls[2]["op"], "retention-delete");
    assert_eq!(calls[2]["dirId"], "d1");
    assert_eq!(calls[2]["taskIds"], "t1");

    let deleted = gateway.post(
        "/api/task-board/directories/d2/retention",
        &json!({"taskIds": ["t1", "t2"]}),
    );
    assert_eq!(deleted.status, 200);
    assert_eq!(
        deleted.body,
        r#"{"ok":true,"deleted":["t1"],"skipped":[{"id":"t2","reason":"no_longer_eligible"}],"count":2,"limit":20}"#
    );
}

// ── task status / delete / relocate / chat-session ──────────────────────────

#[test]
fn status_rejects_an_unknown_status_before_touching_the_store() {
    let gateway = Gateway::start("status-invalid", world(json!({})));
    for body in [
        json!({}),
        json!({"status": "ACTIVE"}),
        json!({"status": "deleted"}),
        json!({"status": ["active", "done"]}),
    ] {
        let response = gateway.post("/api/task-board/tasks/t1/status", &body);
        assert_eq!(response.status, 400, "{body}");
        assert_eq!(response.body, r#"{"error":"invalid_status"}"#, "{body}");
    }
    assert!(
        gateway.calls().is_empty(),
        "the status gate never reaches Node"
    );
    // `String(['active'])` is 'active', so a one-element array is allowed.
    let array = gateway.post(
        "/api/task-board/tasks/t1/status",
        &json!({"status": ["active"]}),
    );
    assert_eq!(
        array.status, 503,
        "no scripted op: the host is the next step"
    );
}

#[test]
fn status_forwards_the_rendered_reply() {
    let gateway = Gateway::start(
        "status-reply",
        world(json!({
            "task-status:t1": ok(json!({"reply": {"status": 200, "body": {
                "ok": true, "releasedSession": false, "releasedSessions": 0,
                "task": {"id": "t1"}, "revision": 4}}})),
            "task-status:t2": ok(json!({"reply": {"status": 409,
                "body": {"error": "task_shell_route_required"}}})),
            "task-delete:t1": ok(json!({"reply": {"status": 200,
                "body": {"ok": true, "deleted": true, "taskIds": ["t1"]}}})),
            "task-relocate:t1": ok(json!({"reply": {"status": 400,
                "body": {"error": "dirId required"}}})),
            "task-chat-session:t1": ok(json!({"reply": {"status": 501,
                "body": {"error": "chat_session_unavailable"}}}))
        })),
    );
    let status = gateway.post(
        "/api/task-board/tasks/t1/status",
        &json!({"status": "done", "expectedRevision": 3}),
    );
    assert_eq!(status.status, 200);
    assert_eq!(
        status.body,
        r#"{"ok":true,"releasedSession":false,"releasedSessions":0,"task":{"id":"t1"},"revision":4}"#
    );
    let refused = gateway.post(
        "/api/task-board/tasks/t2/status",
        &json!({"status": "active"}),
    );
    assert_eq!(refused.status, 409);
    assert_eq!(refused.body, r#"{"error":"task_shell_route_required"}"#);

    let deleted = gateway.send(
        "DELETE",
        "/api/task-board/tasks/t1",
        &json!({"force": true}),
    );
    assert_eq!(deleted.status, 200);
    assert_eq!(
        deleted.body,
        r#"{"ok":true,"deleted":true,"taskIds":["t1"]}"#
    );
    let relocated = gateway.post("/api/task-board/tasks/t1/relocate", &json!({}));
    assert_eq!(relocated.status, 400);
    assert_eq!(relocated.body, r#"{"error":"dirId required"}"#);
    let chat = gateway.post("/api/task-board/tasks/t1/chat-session", &json!({}));
    assert_eq!(chat.status, 501);
    assert_eq!(chat.body, r#"{"error":"chat_session_unavailable"}"#);

    let calls = gateway.calls();
    assert_eq!(calls.len(), 5);
    assert_eq!(calls[0]["op"], "task-status");
    assert_eq!(
        calls[0]["body"],
        json!({"status": "done", "expectedRevision": 3})
    );
    assert_eq!(calls[2]["op"], "task-delete");
    assert_eq!(calls[2]["body"], json!({"force": true}));
    assert_eq!(calls[3]["op"], "task-relocate");
    assert_eq!(calls[4]["op"], "task-chat-session");
    assert_eq!(calls[4]["taskId"], "t1");
}

// ── board search ────────────────────────────────────────────────────────────

#[test]
fn board_search_answers_empty_and_too_long_without_a_round_trip() {
    let gateway = Gateway::start(
        "search-short-circuit",
        world(json!({"search-board:hello": ok(json!({"results": []}))})),
    );
    let empty = gateway.get("/api/task-board/search");
    assert_eq!(empty.status, 200);
    assert_eq!(
        empty.body,
        r#"{"ok":true,"query":"","count":0,"results":[]}"#
    );
    let blank = gateway.get("/api/task-board/search?q=%20%20");
    assert_eq!(
        blank.body,
        r#"{"ok":true,"query":"","count":0,"results":[]}"#
    );
    let long = gateway.get(&format!("/api/task-board/search?q={}", "a".repeat(201)));
    assert_eq!(long.status, 400);
    assert_eq!(long.body, r#"{"error":"query_too_long","maxLength":200}"#);
    assert!(gateway.calls().is_empty());
    let exact = gateway.get(&format!("/api/task-board/search?q={}", "a".repeat(200)));
    assert_eq!(exact.status, 503, "200 characters is still a search");
    assert_eq!(gateway.calls().len(), 1);
}

#[test]
fn board_search_forwards_the_normalized_options() {
    let gateway = Gateway::start(
        "search-options",
        world(json!({
            "search-board:hello": ok(json!({"results": [{"taskId": "t1", "score": 3.5}]}))
        })),
    );
    let response = gateway.get(
        "/api/task-board/search?q=%20hello%20&limit=999&dirId=%20d1%20&dirIds=a,b&statuses=done&minScore=2.5",
    );
    assert_eq!(response.status, 200);
    assert_eq!(
        response.body,
        r#"{"ok":true,"query":"hello","count":1,"results":[{"taskId":"t1","score":3.5}]}"#
    );
    let calls = gateway.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["op"], "search-board");
    assert_eq!(calls[0]["query"], "hello");
    assert_eq!(calls[0]["limit"], 50, "limit clamps to MAX_LIMIT");
    assert_eq!(calls[0]["dirId"], "d1", "dirId is trimmed");
    assert_eq!(calls[0]["dirIds"], json!(["a", "b"]));
    assert_eq!(calls[0]["statuses"], json!(["done"]));
    assert_eq!(calls[0]["minScore"], 2.5);
}

#[test]
fn board_search_defaults_and_failures() {
    let gateway = Gateway::start(
        "search-defaults",
        world(json!({
            "search-board:hello": ok(json!({"reply": {"status": 503,
                "body": {"error": "task_board_unavailable"}}})),
            "search-board:zero": ok(json!({"results": []}))
        })),
    );
    let response = gateway.get("/api/task-board/search?q=hello&limit=0&minScore=abc");
    assert_eq!(response.status, 503);
    assert_eq!(response.body, r#"{"error":"task_board_unavailable"}"#);
    let call = gateway.calls().pop().unwrap();
    assert_eq!(call["limit"], 20, "a non-positive limit falls back to 20");
    assert_eq!(call["minScore"], 0.0, "Number('abc') || 0");
    assert!(call.get("dirId").is_none());
    assert!(call.get("dirIds").is_none());
    assert!(call.get("statuses").is_none());
    let ok = gateway.get("/api/task-board/search?query=zero");
    assert_eq!(
        ok.body,
        r#"{"ok":true,"query":"zero","count":0,"results":[]}"#
    );
}

#[test]
fn board_search_repeated_params_join_like_express() {
    let gateway = Gateway::start(
        "search-repeated",
        world(json!({"search-board:a,b": ok(json!({"results": []}))})),
    );
    let response = gateway.get("/api/task-board/search?q=a&q=b&dirIds=x&dirIds=y");
    assert_eq!(response.status, 200);
    let call = gateway.calls().pop().unwrap();
    assert_eq!(call["query"], "a,b");
    assert_eq!(call["dirIds"], json!(["x", "y"]));
}

// ── message search ──────────────────────────────────────────────────────────

#[test]
fn message_search_reports_an_unavailable_index_before_validating() {
    let gateway = Gateway::start(
        "messages-unavailable",
        world(json!({"search-messages-scope": ok(json!({"unavailable": true}))})),
    );
    let response = gateway.get("/api/search/messages");
    assert_eq!(response.status, 503);
    assert_eq!(response.body, r#"{"error":"message_search_unavailable"}"#);
    let calls = gateway.calls();
    assert_eq!(calls.len(), 1, "only the scope probe runs");
    assert_eq!(calls[0]["op"], "search-messages-scope");
}

#[test]
fn message_search_empty_too_long_and_filter_too_long() {
    let gateway = Gateway::start(
        "messages-validation",
        world(json!({"search-messages-scope": ok(json!({"warming": true}))})),
    );
    let empty = gateway.get("/api/search/messages");
    assert_eq!(empty.status, 200);
    assert_eq!(
        empty.body,
        r#"{"ok":true,"query":"","count":0,"results":[],"warming":true}"#
    );
    let long = gateway.get(&format!("/api/search/messages?q={}", "a".repeat(201)));
    assert_eq!(long.status, 400);
    assert_eq!(long.body, r#"{"error":"query_too_long","maxLength":200}"#);
    let filter = gateway.get(&format!(
        "/api/search/messages?q=x&dirId={}",
        "d".repeat(201)
    ));
    assert_eq!(filter.status, 400);
    assert_eq!(
        filter.body,
        r#"{"error":"filter_too_long","maxLength":200}"#
    );
    let task_filter = gateway.get(&format!(
        "{}{}",
        "/api/search/messages?q=x&taskId=",
        "t".repeat(201)
    ));
    assert_eq!(task_filter.status, 400);
    let calls = gateway.calls();
    assert_eq!(calls.len(), 4, "each request probes the scope once");
    assert!(
        calls
            .iter()
            .all(|call| call["op"] == "search-messages-scope"),
        "validation never reaches the index"
    );
}

#[test]
fn message_search_builds_the_envelope_and_forwards_the_filters() {
    let gateway = Gateway::start(
        "messages-success",
        world(json!({
            "search-messages-scope": ok(json!({"warming": false})),
            "search-messages:hi": ok(json!({"results": [
                {"sessionId": "s1", "messageId": "m1", "kind": "user", "updatedAt": 5,
                 "score": 1.5, "taskIds": ["t1"], "snippet": {"text": "hi"}}
            ]}))
        })),
    );
    let response = gateway.get(
        "/api/search/messages?q=hi&limit=5&role=user&kinds=assistant&session=s1&sessions=s2&dirId=d1&taskId=t1",
    );
    assert_eq!(response.status, 200);
    assert_eq!(
        response.body,
        r#"{"ok":true,"query":"hi","count":1,"mode":"message","warming":false,"results":[{"sessionId":"s1","messageId":"m1","kind":"user","updatedAt":5,"score":1.5,"taskIds":["t1"],"snippet":{"text":"hi"}}]}"#
    );
    assert_key_order(
        &response.body,
        &["ok", "query", "count", "mode", "warming", "results"],
    );
    let call = gateway.calls().pop().unwrap();
    assert_eq!(call["op"], "search-messages");
    assert_eq!(call["query"], "hi");
    assert_eq!(call["limit"], 5);
    assert_eq!(call["kinds"], json!(["user"]), "role wins over kinds");
    assert_eq!(call["refIds"], json!(["s1"]), "session wins over sessions");
    assert_eq!(call["dirId"], "d1");
    assert_eq!(call["taskId"], "t1");
}

#[test]
fn message_search_index_failure_is_503() {
    let gateway = Gateway::start(
        "messages-failure",
        world(json!({
            "search-messages-scope": ok(json!({"warming": false})),
            "search-messages:x": ok(json!({"reply": {"status": 503,
                "body": {"error": "message_search_unavailable"}}}))
        })),
    );
    let response = gateway.get("/api/search/messages?q=x");
    assert_eq!(response.status, 503);
    assert_eq!(response.body, r#"{"error":"message_search_unavailable"}"#);
}

// ── mark-achieved ───────────────────────────────────────────────────────────

#[test]
fn mark_achieved_requires_a_task_id_without_a_round_trip() {
    let gateway = Gateway::start("mark-required", world(json!({})));
    for body in [json!({}), json!({"taskId": "   "}), json!({"taskId": 5})] {
        let response = gateway.post("/api/air/tasks/mark-achieved", &body);
        assert_eq!(response.status, 400, "{body}");
        assert_eq!(
            response.body,
            r#"{"ok":false,"code":"task_id_required","message":"taskId is required"}"#
        );
    }
    assert!(gateway.calls().is_empty());
}

#[test]
fn mark_achieved_eligibility_ladder() {
    let gateway = Gateway::start(
        "mark-ladder",
        world(json!({
            "mark-achieved-facts:gone": ok(json!({"unavailable": true})),
            "mark-achieved-facts:none": ok(json!({"found": false, "sessionId": null})),
            "mark-achieved-facts:done": ok(json!({"found": true, "goalState": "achieved",
                "classifyState": "D", "streaming": false, "sessionId": "s1"})),
            "mark-achieved-facts:live": ok(json!({"found": true, "goalState": "interact",
                "classifyState": "D", "streaming": true, "sessionId": "s1"})),
            "mark-achieved-facts:t1": ok(json!({"found": true, "goalState": "interact",
                "classifyState": "D", "streaming": false, "sessionId": "s1"})),
            "mark-achieved-write:t1": ok(json!({"ok": true, "taskId": "t1"}))
        })),
    );
    let unwired = gateway.post("/api/air/tasks/mark-achieved", &json!({"taskId": "gone"}));
    assert_eq!(unwired.status, 501);
    assert_eq!(
        unwired.body,
        r#"{"ok":false,"code":"task_state_unavailable","message":"task state writes unavailable"}"#
    );
    let missing = gateway.post("/api/air/tasks/mark-achieved", &json!({"taskId": "none"}));
    assert_eq!(missing.status, 404);
    assert_eq!(
        missing.body,
        r#"{"ok":false,"code":"task_not_found","message":"任务不存在"}"#
    );
    let not_applicable = gateway.post("/api/air/tasks/mark-achieved", &json!({"taskId": "done"}));
    assert_eq!(not_applicable.status, 409);
    assert_eq!(
        not_applicable.body,
        r#"{"ok":false,"code":"mark_achieved_not_applicable","message":"只有需要交互的任务才能标记达成目标"}"#
    );
    let streaming = gateway.post("/api/air/tasks/mark-achieved", &json!({"taskId": "live"}));
    assert_eq!(streaming.status, 409);
    assert_eq!(
        streaming.body,
        r#"{"ok":false,"code":"task_streaming","message":"任务正在执行，无法标记达成目标"}"#
    );

    let done = gateway.post("/api/air/tasks/mark-achieved", &json!({"taskId": " t1 "}));
    assert_eq!(done.status, 200);
    assert_eq!(
        done.body,
        r#"{"ok":true,"taskId":"t1","goalState":"achieved"}"#
    );
    let calls = gateway.calls();
    // facts for gone/none/done/live/t1 then one write, in that order.
    assert_eq!(calls.len(), 6);
    assert_eq!(calls[4]["op"], "mark-achieved-facts");
    assert_eq!(calls[4]["taskId"], "t1", "taskId is trimmed");
    assert_eq!(calls[5]["op"], "mark-achieved-write");
    assert_eq!(calls[5]["taskId"], "t1");
    assert_eq!(calls[5]["sessionId"], "s1");
}

#[test]
fn mark_achieved_write_failure_keeps_the_retired_catch_shape() {
    let gateway = Gateway::start(
        "mark-write-failure",
        world(json!({
            "mark-achieved-facts:t1": ok(json!({"found": true, "goalState": "interact",
                "classifyState": "D", "streaming": false, "sessionId": "s1"})),
            "mark-achieved-write:t1": ok(json!({"reply": {"status": 500, "body": {
                "ok": false, "code": "mark_achieved_failed", "message": "Request failed"}}}))
        })),
    );
    let response = gateway.post("/api/air/tasks/mark-achieved", &json!({"taskId": "t1"}));
    assert_eq!(response.status, 500);
    assert_eq!(
        response.body,
        r#"{"ok":false,"code":"mark_achieved_failed","message":"Request failed"}"#
    );
}

#[test]
fn mark_achieved_does_not_shadow_air_or_other_task_routes() {
    let gateway = Gateway::start(
        "mark-shadow",
        world(json!({
            "mark-achieved-facts:none": ok(json!({"found": false, "sessionId": null}))
        })),
    );
    // Air keeps `GET /api/air/tasks/:id`, which already covered the literal
    // looking `mark-achieved` before this migration; a GET never comes here.
    gateway.get("/api/air/tasks/mark-achieved");
    gateway.get("/api/air/tasks/t1");
    assert!(gateway.calls().is_empty(), "GET is Air's");
    // The collection POST is Air's too: no task id means no mark-achieved.
    gateway.post("/api/air/tasks", &json!({}));
    gateway.post("/api/air/tasks/t1", &json!({}));
    assert!(
        gateway.calls().is_empty(),
        "Air has no POST /api/air/tasks/:id"
    );
    // Only the literal POST lands here.
    let post = gateway.post("/api/air/tasks/mark-achieved", &json!({"taskId": "none"}));
    assert_eq!(post.status, 404);
    assert_eq!(
        post.body,
        r#"{"ok":false,"code":"task_not_found","message":"任务不存在"}"#
    );
    assert_eq!(gateway.calls().len(), 1);
}

// ── task graph / attribution ────────────────────────────────────────────────

fn graph() -> Value {
    json!({
        "nodes": [{"id": "t1", "kind": "task"}],
        "edges": [],
        "meta": {
            "dirId": "all", "projects": [], "taskCount": 1, "shellCount": 0,
            "nodeCount": 1, "edgeCount": 0, "truncated": false, "maxNodes": 800
        }
    })
}

#[test]
fn task_graph_appends_duration_ms_last_and_defaults_the_dir() {
    let gateway = Gateway::start(
        "task-graph",
        world(json!({
            "task-graph:all": ok(json!({"graph": graph()})),
            "task-graph:d1": ok(json!({"graph": graph()}))
        })),
    );
    let response = gateway.get("/api/task-graph");
    assert_eq!(response.status, 200);
    assert_key_order(
        &response.body,
        &[
            "nodes",
            "edges",
            "meta",
            "dirId",
            "projects",
            "taskCount",
            "shellCount",
            "nodeCount",
            "edgeCount",
            "truncated",
            "maxNodes",
            "durationMs",
        ],
    );
    let parsed = response.json();
    assert!(parsed["meta"]["durationMs"].is_number());
    assert_eq!(parsed["meta"]["dirId"], "all");
    let calls = gateway.calls();
    assert_eq!(calls[0]["op"], "task-graph");
    assert_eq!(calls[0]["dirId"], "all");

    let scoped = gateway.get("/api/task-graph?dirId=d1");
    assert_eq!(scoped.status, 200);
    let calls = gateway.calls();
    assert_eq!(calls[1]["dirId"], "d1");

    // `req.query.dirId` truthiness: an empty value means "all".
    gateway.get("/api/task-graph?dirId=");
    assert_eq!(gateway.calls().pop().unwrap()["dirId"], "all");
}

#[test]
fn task_graph_build_failure_is_a_500_reply() {
    let gateway = Gateway::start(
        "task-graph-failure",
        world(json!({
            "task-graph:all": ok(json!({"reply": {"status": 500,
                "body": {"error": "task graph build failed"}}}))
        })),
    );
    let response = gateway.get("/api/task-graph");
    assert_eq!(response.status, 500);
    assert_eq!(response.body, r#"{"error":"task graph build failed"}"#);
}

#[test]
fn attribution_reads_the_live_mode() {
    let gateway = Gateway::start(
        "attribution",
        world(json!({"attribution-mode": ok(json!({"mode": "suggest"}))})),
    );
    let response = gateway.get("/api/settings/task-attribution");
    assert_eq!(response.status, 200);
    assert_eq!(
        response.body,
        r#"{"mode":"suggest","modes":["off","shadow","suggest","auto"],"default":"suggest"}"#
    );
    assert_eq!(gateway.calls()[0]["op"], "attribution-mode");
    let head = gateway.head("/api/settings/task-attribution");
    assert_eq!(head.status, 200);
    assert_eq!(head.body, "");
    assert_eq!(
        head.header("content-length").map(str::to_string),
        Some("80".to_string()),
        "HEAD keeps the GET Content-Length"
    );
}

// ── OPTIONS and the host boundary ───────────────────────────────────────────

#[test]
fn options_answers_the_express_union() {
    let gateway = Gateway::start("options", world(json!({})));
    for (path, allow) in [
        ("/api/task-board/tasks", "POST"),
        ("/api/task-board/tasks/t1", "DELETE"),
        ("/api/task-board/tasks/t1/update", "POST"),
        ("/api/task-board/tasks/t1/status", "POST"),
        ("/api/task-board/directories/d1/retention", "GET,HEAD,POST"),
        ("/api/task-board/search", "GET,HEAD"),
        ("/api/search/messages", "GET,HEAD"),
        ("/api/air/tasks/mark-achieved", "POST,GET,HEAD"),
        ("/api/task-graph", "GET,HEAD"),
        // The host-write POST (host-ops cluster) was registered before the task
        // surface GET, so Express unions them as POST first.
        ("/api/settings/task-attribution", "POST,GET,HEAD"),
    ] {
        let response = gateway.options(path);
        assert_eq!(response.status, 200, "OPTIONS {path}");
        assert_eq!(response.header("allow"), Some(allow), "OPTIONS {path}");
        assert_eq!(
            response.header("content-type"),
            Some("text/html; charset=utf-8"),
            "OPTIONS {path}"
        );
        assert_eq!(response.body, allow, "OPTIONS {path} body");
    }
    // session-git's tails answer their own OPTIONS first.
    let merge = gateway.options("/api/task-board/tasks/t1/merge");
    assert_eq!(merge.header("allow"), Some("POST"));
    // Unclaimed paths still reach Node.
    for path in ["/api/task-board/tasks/t1/unknown-tail", "/api/task-board"] {
        let response = gateway.options(path);
        assert_eq!(response.text_body(), "ok", "OPTIONS {path}");
        assert_eq!(response.header("allow"), None, "OPTIONS {path}");
    }
    assert!(gateway.calls().is_empty());
}

#[test]
fn a_broken_host_port_is_the_documented_503() {
    let gateway = Gateway::start(
        "host-down",
        json!({ "taskRoutes": { "hostDown": true, "ops": {} } }),
    );
    for (method, path, body) in [
        ("GET", "/api/task-graph", None),
        ("GET", "/api/settings/task-attribution", None),
        (
            "POST",
            "/api/task-board/tasks/t1/title",
            Some(json!({"title": "x"})),
        ),
    ] {
        let response = match body {
            Some(body) => gateway.send(method, path, &body),
            None => gateway.get(path),
        };
        assert_eq!(response.status, 503, "{method} {path}");
        let parsed = response.json();
        assert_eq!(
            parsed["code"], "rust_backend_unavailable",
            "{method} {path}"
        );
        assert!(parsed["error"].is_string(), "{method} {path}");
    }
}

#[test]
fn path_matching_follows_express_case_and_slash_rules() {
    let gateway = Gateway::start(
        "path-rules",
        world(json!({"attribution-mode": ok(json!({"mode": "off"}))})),
    );
    let trailing = gateway.get("/api/settings/task-attribution/");
    assert_eq!(trailing.status, 200);
    let upper = gateway.get("/api/SETTINGS/TASK-ATTRIBUTION");
    assert_eq!(upper.status, 200, "literal segments are case-insensitive");
    let prefix = gateway.get("/API/settings/task-attribution");
    assert_eq!(prefix.body, "ok", "the /api/ prefix is case-sensitive");
    let empty = gateway.post("/api/task-board/tasks//title", &json!({}));
    assert_eq!(empty.body, "ok", "empty segments never match");
    let undecodable = gateway.post("/api/task-board/tasks/%zz/title", &json!({}));
    assert_eq!(
        undecodable.status, 400,
        "malformed escapes are a decode error"
    );
    assert_eq!(gateway.calls().len(), 2, "the bad paths never reach Node");
}

impl Response {
    fn text_body(&self) -> &str {
        self.body.as_str()
    }
}
