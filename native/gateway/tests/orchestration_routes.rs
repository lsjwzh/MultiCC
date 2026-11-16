#![recursion_limit = "256"]

//! Integration coverage for the 23 orchestration and unattended routes retired
//! from `src/routes/{aux-goal,aux-runs,orchestration}.js` and
//! `src/unattended/routes.js`, answered by the Rust front door
//! (`native/gateway/src/app/orchestration_routes.rs`; matching rules in
//! `multicc_core::orchestration_routes`).
//!
//! The Node process here is only the protocol fixture: it answers
//! `POST /api/__host/orchestration` with `{ ok: true, value }` from
//! `FIXTURE_HOST_SCRIPT.orchestration.ops` and appends every payload to
//! `orchestration-calls.jsonl`, so each test asserts exactly what the front door
//! asked Node to do -- op name, decoded path parameters, the query subset, the
//! request body Express would have parsed, the forwarded `Idempotency-Key` and
//! the locality fact.
//!
//! Four areas prove the split rather than the payload:
//!
//! * `GET /api/v1/sessions/:id/waits` is ours and `GET /api/sessions/:id/waits`
//!   is not: the first reaches the host port (behind the **v1** guard envelope),
//!   the second -- and the six other out-of-scope wait/detached routes -- is
//!   forwarded to Node untouched.
//! * Every `/api/sessions/:id/*` route sits behind `publicSessionAccessGuard`,
//!   answered from the session-admin host port *before* the handler and before
//!   `OPTIONS`; an internal execution slot is a 404 (v1 envelope under
//!   `/api/v1/`) and never reaches the orchestration host.
//! * The multi-method paths (`/api/aux/config`, `/api/settings/goal`,
//!   `/api/sessions/:id/unattended`, `.../scheduled-messages`) answer Express's
//!   unioned `Allow`.
//! * A host that refuses the connection is the 503 `rust_backend_unavailable`;
//!   a handler that threw is the 500 envelope, rebuilt without the thrown
//!   message; and no request credential (cookie, authorization, access token)
//!   is ever forwarded to the host port.

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
        "multicc-gateway-orchestration-{}-{tag}-{nanos}",
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

    /// Every payload the front door sent the orchestration host port.
    fn calls(&self) -> Vec<Value> {
        self.lines("orchestration-calls.jsonl")
    }

    fn session_admin_calls(&self) -> Vec<Value> {
        self.lines("session-admin-calls.jsonl")
    }

    /// Every URL the front door forwarded to the child untouched.
    fn forwarded(&self) -> Vec<String> {
        self.lines("requests.log")
            .into_iter()
            .filter_map(|entry| entry["url"].as_str().map(str::to_string))
            .collect()
    }

    fn exchange(
        &self,
        method: &str,
        url: &str,
        extra: &[(&str, &str)],
        body: Option<&[u8]>,
    ) -> Response {
        let payload = body.unwrap_or(b"");
        let mut request = format!("{method} {url} HTTP/1.1\r\nX-Request-Id: host-req-1\r\n");
        if !extra
            .iter()
            .any(|(name, _)| name.eq_ignore_ascii_case("host"))
        {
            request.push_str("Host: localhost\r\n");
        }
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
    json!({ "orchestration": { "ops": ops } })
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

fn sent(gateway: &Gateway, method: &str, url: &str, body: Option<Value>) -> Response {
    match body {
        Some(body) => gateway.send(method, url, &body),
        None => gateway.exchange(method, url, &[], None),
    }
}

/// One row per public route: method, request URL, optional body, expected op.
const ROUTES: &[(&str, &str, bool, &str)] = &[
    ("GET", "/api/aux/status", false, "aux-status"),
    ("GET", "/api/aux/health", false, "aux-health"),
    ("GET", "/api/aux/history?limit=7", false, "aux-history"),
    ("POST", "/api/aux/enqueue", true, "aux-enqueue"),
    ("POST", "/api/aux/cancel", true, "aux-cancel"),
    ("GET", "/api/aux/config", false, "aux-config-get"),
    ("POST", "/api/aux/config", true, "aux-config-post"),
    ("GET", "/api/settings/goal", false, "settings-goal-get"),
    ("POST", "/api/settings/goal", true, "settings-goal-post"),
    ("POST", "/api/goal/precheck", true, "goal-precheck"),
    (
        "GET",
        "/api/sessions/s1/aux-runs",
        false,
        "session-aux-runs",
    ),
    (
        "GET",
        "/api/sessions/s1/aux-runs/r1",
        false,
        "session-aux-run",
    ),
    (
        "GET",
        "/api/sessions/s1/unattended",
        false,
        "unattended-get",
    ),
    (
        "POST",
        "/api/sessions/s1/unattended",
        true,
        "unattended-post",
    ),
    (
        "POST",
        "/api/sessions/s1/scheduled-messages",
        true,
        "scheduled-message-post",
    ),
    (
        "GET",
        "/api/sessions/s1/scheduled-messages",
        false,
        "scheduled-messages-get",
    ),
    (
        "DELETE",
        "/api/sessions/s1/scheduled-messages/m1",
        false,
        "scheduled-message-delete",
    ),
    ("GET", "/api/sessions/s1/tasks", false, "session-tasks"),
    (
        "GET",
        "/api/sessions/s1/dispatches",
        false,
        "session-dispatches",
    ),
    (
        "POST",
        "/api/sessions/s1/user-input/dismiss",
        true,
        "user-input-dismiss",
    ),
    ("GET", "/api/sessions/s1/queue", false, "session-queue"),
    (
        "POST",
        "/api/sessions/s1/queue/action",
        true,
        "session-queue-action",
    ),
    (
        "GET",
        "/api/v1/sessions/s1/waits",
        false,
        "v1-session-waits",
    ),
    // The wait injector and detached set, claimed by the second batch. Kept at
    // the end so the positional assertions below keep their indices.
    ("POST", "/api/sessions/s1/wait", true, "session-wait-post"),
    ("POST", "/api/wait/w1/resolve", true, "wait-resolve"),
    ("GET", "/api/sessions/s1/waits", false, "session-waits"),
    ("DELETE", "/api/wait/w1", false, "wait-cancel"),
    (
        "POST",
        "/api/sessions/s1/run-detached",
        true,
        "run-detached",
    ),
    (
        "GET",
        "/api/sessions/s1/detached",
        false,
        "session-detached",
    ),
    ("GET", "/api/detached/t1", false, "detached-task"),
];

// ── the 30 routes ───────────────────────────────────────────────────────────

#[test]
fn every_one_of_the_30_routes_reaches_its_op() {
    let gateway = Gateway::start("all-routes", json!({ "orchestration": { "ops": {} } }));
    assert_eq!(ROUTES.len(), 30);
    for (method, url, has_body, _) in ROUTES {
        let body = has_body.then(|| json!({ "k": "v" }));
        let response = sent(&gateway, method, url, body);
        assert_eq!(response.status, 200, "{method} {url}: {}", gateway.log());
    }
    let calls = gateway.calls();
    let expected: Vec<&str> = ROUTES.iter().map(|row| row.3).collect();
    assert_eq!(ops_sent(&calls), expected);
    for (call, (method, url, has_body, _)) in calls.iter().zip(ROUTES) {
        assert_eq!(call["method"], *method, "{url}");
        assert_eq!(call["originalUrl"], *url);
        assert_eq!(call["local"], true);
        assert_eq!(call["requestId"], "host-req-1");
        assert_eq!(call["correlationId"], "host-req-1");
        if *has_body {
            assert_eq!(call["body"], json!({ "k": "v" }), "{url}");
        } else {
            assert_eq!(call["body"], json!({}), "{url}");
        }
    }
    assert_eq!(calls[2]["query"], json!({ "limit": "7" }));
    assert_eq!(calls[10]["id"], "s1");
    assert_eq!(calls[11]["runId"], "r1");
    assert_eq!(calls[16]["messageId"], "m1");
    assert_eq!(calls[22]["id"], "s1");
    // The second batch's own parameters: `:wid` and `:taskId` are the only ones
    // in this cluster that are not a session id.
    assert_eq!(calls[23]["id"], "s1");
    assert_eq!(calls[24]["wid"], "w1");
    assert_eq!(calls[24]["id"], Value::Null);
    assert_eq!(calls[25]["id"], "s1");
    assert_eq!(calls[26]["wid"], "w1");
    assert_eq!(calls[27]["id"], "s1");
    assert_eq!(calls[28]["id"], "s1");
    assert_eq!(calls[29]["taskId"], "t1");
}

#[test]
fn head_is_answered_from_the_get_handler() {
    let gateway = Gateway::start(
        "head",
        world(json!({ "aux-status": relay(200, json!({ "running": 0 })) })),
    );
    let head = gateway.head("/api/aux/status");
    assert_eq!(head.status, 200);
    assert_eq!(head.body, "");
    let calls = gateway.calls();
    assert_eq!(calls[0]["op"], "aux-status");
    assert_eq!(calls[0]["method"], "HEAD");
    // POST-only routes do not answer HEAD.
    let refused = gateway.head("/api/aux/enqueue");
    assert!(
        gateway
            .forwarded()
            .iter()
            .any(|url| url == "/api/aux/enqueue"),
        "{refused:?}",
        refused = refused.status
    );
}

#[test]
fn handler_answers_keep_status_key_order_and_headers() {
    let gateway = Gateway::start(
        "relay",
        world(json!({
            "session-queue": relay(200, json!({ "ok": true, "queue": { "state": "running", "queued": [] } })),
            "aux-config-post": relay(400, json!({ "ok": false, "error": "请选择 Provider" })),
            "scheduled-message-post": {
                "status": 201,
                "body": { "ok": true, "duplicate": false, "scheduledMessage": { "id": "m1" } },
                "headers": [["X-Orchestration", "1"]],
            },
        })),
    );
    let queue = gateway.get("/api/sessions/s1/queue");
    assert_eq!(queue.status, 200);
    assert_key_order(&queue.body, &["ok", "queue"]);
    assert!(
        queue.header("etag").is_some(),
        "GET JSON carries Express's ETag"
    );
    let refused = gateway.send("POST", "/api/aux/config", &json!({ "protocol": "x" }));
    assert_eq!(refused.status, 400);
    assert_key_order(&refused.body, &["ok", "error"]);
    let created = gateway.send(
        "POST",
        "/api/sessions/s1/scheduled-messages",
        &json!({ "message": "hi" }),
    );
    assert_eq!(created.status, 201);
    assert_eq!(created.header("x-orchestration"), Some("1"));
    assert_key_order(&created.body, &["ok", "duplicate", "scheduledMessage"]);
}

// ── parameters, query and headers ───────────────────────────────────────────

#[test]
fn path_parameters_are_percent_decoded_and_bad_escapes_are_a_400() {
    let gateway = Gateway::start("params", json!({ "orchestration": { "ops": {} } }));
    assert_eq!(
        gateway.get("/api/sessions/s%201/aux-runs/run%2Fx").status,
        200
    );
    assert_eq!(
        gateway
            .delete("/api/sessions/s%201/scheduled-messages/m%25z")
            .status,
        200
    );
    let calls = gateway.calls();
    assert_eq!(calls[0]["id"], "s 1");
    assert_eq!(calls[0]["runId"], "run/x");
    assert_eq!(calls[1]["id"], "s 1");
    assert_eq!(calls[1]["messageId"], "m%z");
    // The guard decoded the id before asking session-admin.
    assert_eq!(gateway.session_admin_calls()[0]["id"], "s 1");

    let before = gateway.calls().len();
    for url in [
        "/api/sessions/%zz/queue",
        "/api/sessions/s1/aux-runs/%zz",
        "/api/v1/sessions/%E0%A4%A/waits",
    ] {
        let response = gateway.get(url);
        assert_eq!(response.status, 400, "{url}");
    }
    assert_eq!(
        gateway.calls().len(),
        before,
        "a decode failure never reaches the host"
    );
}

#[test]
fn the_query_subset_keeps_its_qs_shape() {
    let gateway = Gateway::start("query", json!({ "orchestration": { "ops": {} } }));
    for url in [
        "/api/sessions/s1/tasks",
        "/api/sessions/s1/tasks?taskIds=a,b",
        "/api/sessions/s1/tasks?taskIds=a&taskIds=b",
        "/api/sessions/s1/tasks?taskIds[]=a&taskIds[]=b",
        "/api/sessions/s1/tasks?taskIds[k]=a",
        "/api/sessions/s1/tasks?taskIds=",
        "/api/sessions/s1/dispatches?relation=owner&activeOnly=false&recentTerminalLimit=5",
        "/api/sessions/s1/dispatches?activeOnly=false&activeOnly=true&other=1",
        "/api/sessions/s1/aux-runs?messageId=m%201&taskId=t&limit=12",
    ] {
        assert_eq!(gateway.get(url).status, 200, "{url}");
    }
    let queries: Vec<Value> = gateway
        .calls()
        .iter()
        .map(|call| call["query"].clone())
        .collect();
    assert_eq!(queries[0], json!({}));
    assert_eq!(queries[1], json!({ "taskIds": "a,b" }));
    assert_eq!(queries[2], json!({ "taskIds": ["a", "b"] }));
    assert_eq!(queries[3], json!({ "taskIds": ["a", "b"] }));
    assert_eq!(queries[4], json!({ "taskIds": {} }));
    assert_eq!(queries[5], json!({ "taskIds": "" }));
    assert_eq!(
        queries[6],
        json!({ "relation": "owner", "activeOnly": "false", "recentTerminalLimit": "5" })
    );
    // An unrelated key is never forwarded; a repeated key is an array.
    assert_eq!(queries[7], json!({ "activeOnly": ["false", "true"] }));
    assert_eq!(
        queries[8],
        json!({ "messageId": "m 1", "taskId": "t", "limit": "12" })
    );
}

#[test]
fn only_the_three_allowlisted_headers_reach_the_host() {
    let gateway = Gateway::start("headers", json!({ "orchestration": { "ops": {} } }));
    let mut headers = external();
    headers.extend([
        ("Idempotency-Key", "idem-7"),
        ("X-Wait-Token", "wait-tok-7"),
        ("Cookie", "multicc_auth=COOKIE-CANARY"),
        ("Authorization", "Bearer BEARER-CANARY"),
    ]);
    let body = json!({ "message": "later", "delaySeconds": 5 }).to_string();
    let response = gateway.exchange(
        "POST",
        "/api/sessions/s1/scheduled-messages",
        &headers,
        Some(body.as_bytes()),
    );
    assert_eq!(response.status, 200, "{}", gateway.log());
    let raw = fs::read_to_string(gateway.state.join("orchestration-calls.jsonl")).unwrap();
    for canary in ["COOKIE-CANARY", "BEARER-CANARY", TOKEN, "multicc_auth"] {
        assert!(!raw.contains(canary), "{canary} leaked to the host: {raw}");
    }
    let calls = gateway.calls();
    // `host` joined the allowlist with the wait injector: the registration
    // answers a `callbackUrl` built from `req.get('host')`, and the front door
    // forwards the client's `Host` unchanged (so does the plain forward path).
    assert_eq!(
        calls[0]["headers"],
        json!({
            "idempotency-key": "idem-7",
            "host": "localhost",
            "x-wait-token": "wait-tok-7",
        })
    );
    assert_eq!(
        calls[0]["local"], false,
        "the locality fact is the real peer's"
    );
    assert_eq!(
        calls[0]["body"],
        json!({ "message": "later", "delaySeconds": 5 })
    );

    // Absent optional headers stay absent; `Host` is always on the wire.
    gateway.send(
        "POST",
        "/api/sessions/s1/queue/action",
        &json!({ "action": "retry", "confirm": true }),
    );
    assert_eq!(
        gateway.calls()[1]["headers"],
        json!({ "host": "localhost" })
    );
}

#[test]
fn the_wait_registration_sees_the_clients_host_for_its_callback_url() {
    // The retired handler built `${req.protocol}://${req.get('host')}/api/wait/
    // <id>/resolve?token=<t>`. Dropping the header would make every callback URL
    // point at `http://undefined/...`, which no caller could ever reach.
    let gateway = Gateway::start("callback-host", json!({ "orchestration": { "ops": {} } }));
    let response = gateway.exchange(
        "POST",
        "/api/sessions/s1/wait",
        &[("Host", "localhost:8443")],
        Some(b"{}"),
    );
    assert_eq!(response.status, 200, "{}", gateway.log());
    let calls = gateway.calls();
    assert_eq!(calls[0]["op"], "session-wait-post");
    assert_eq!(calls[0]["headers"]["host"], "localhost:8443");
}

#[test]
fn a_malformed_body_is_the_json_parser_400_and_never_reaches_the_host() {
    let gateway = Gateway::start("bad-body", json!({ "orchestration": { "ops": {} } }));
    let response = gateway.exchange("POST", "/api/aux/enqueue", &[], Some(b"{bad"));
    assert_eq!(response.status, 400);
    assert!(gateway.calls().is_empty());
}

// ── the waits split ─────────────────────────────────────────────────────────

#[test]
fn both_waits_listings_are_claimed_as_two_different_ops() {
    let gateway = Gateway::start(
        "waits-split",
        json!({
            "orchestration": { "ops": {
                "v1-session-waits": relay(200, json!({ "waits": [], "count": 0, "apiVersion": "v1" })),
                "session-waits": relay(200, json!({ "waits": [], "stats": { "waits": 0 } })),
            } },
        }),
    );
    let v1 = gateway.get("/api/v1/sessions/s1/waits");
    assert_eq!(v1.status, 200);
    assert_key_order(&v1.body, &["waits", "count", "apiVersion"]);
    assert_eq!(gateway.calls().len(), 1);
    assert_eq!(gateway.calls()[0]["op"], "v1-session-waits");

    // The unprefixed listing is ours too now, but it is a different op with a
    // different DTO: it merges the in-process injector's rows into `stats`.
    let legacy = gateway.get("/api/sessions/s1/waits");
    assert_eq!(legacy.status, 200, "{}", legacy.body);
    assert_key_order(&legacy.body, &["waits", "stats"]);
    assert_eq!(gateway.calls().len(), 2);
    assert_eq!(gateway.calls()[1]["op"], "session-waits");
    // Neither reaches Node's own router any more.
    assert!(
        !gateway.forwarded().iter().any(|url| url.contains("/waits")),
        "{:?}",
        gateway.forwarded()
    );
}

#[test]
fn the_wait_and_detached_set_is_claimed_and_never_forwarded() {
    // These seven were the registered out-of-scope set until the second batch.
    // Nothing on these paths may reach Node's own router any more: the module
    // has no public mount left, so a forward would be a plain 404.
    let gateway = Gateway::start("second-batch", json!({ "orchestration": { "ops": {} } }));
    let claimed = [
        ("POST", "/api/sessions/s1/wait", "session-wait-post"),
        ("POST", "/api/wait/w1/resolve", "wait-resolve"),
        ("GET", "/api/sessions/s1/waits", "session-waits"),
        ("DELETE", "/api/wait/w1", "wait-cancel"),
        ("POST", "/api/sessions/s1/run-detached", "run-detached"),
        ("GET", "/api/sessions/s1/detached", "session-detached"),
        ("GET", "/api/detached/t1", "detached-task"),
    ];
    for (method, url, _) in claimed {
        let body = (method == "POST").then(|| json!({}));
        let response = sent(&gateway, method, url, body);
        assert_eq!(response.status, 200, "{method} {url}: {}", gateway.log());
    }
    assert_eq!(
        ops_sent(&gateway.calls()),
        claimed.iter().map(|row| row.2).collect::<Vec<_>>()
    );
    let forwarded = gateway.forwarded();
    for (_, url, _) in claimed {
        assert!(
            !forwarded.iter().any(|seen| seen == url),
            "{url} still reached Node: {forwarded:?}"
        );
    }
    // OPTIONS on every one of them is ours as well.
    for (_, url, _) in claimed {
        let response = gateway.options(url);
        assert_eq!(response.status, 200, "OPTIONS {url}: {}", gateway.log());
    }
    assert_eq!(
        gateway.calls().len(),
        claimed.len(),
        "an OPTIONS reached the host port"
    );
}

// ── the guard ───────────────────────────────────────────────────────────────

fn guarded_world() -> Value {
    json!({
        "orchestration": { "ops": {} },
        "sessionAdmin": { "ops": {
            "guard-record:slot1": { "record": { "id": "slot1" }, "internal": true, "taskStateWritable": true },
            "guard-record:s1": { "record": { "id": "s1" }, "internal": false, "taskStateWritable": true },
        } },
    })
}

#[test]
fn an_internal_execution_slot_404s_before_every_session_scoped_route() {
    let gateway = Gateway::start("internal-slot", guarded_world());
    let mut session_scoped = 0;
    for (method, url, has_body, _) in ROUTES {
        if !url.contains("/sessions/") {
            continue;
        }
        session_scoped += 1;
        let url = url.replace("/s1", "/slot1");
        let body = has_body.then(|| json!({ "action": "retry", "confirm": true }));
        let response = sent(&gateway, method, &url, body);
        assert_eq!(response.status, 404, "{method} {url}: {}", gateway.log());
        if url.starts_with("/api/v1/") {
            let body = response.json();
            assert_eq!(body["ok"], false, "{url}");
            assert_eq!(body["error"], "session not found");
            assert_eq!(body["code"], "session_not_found");
            assert_eq!(body["apiVersion"], "v1");
            assert_eq!(body["requestId"], "host-req-1");
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
        } else {
            assert_eq!(
                response.json(),
                json!({ "error": "session not found" }),
                "{url}"
            );
        }
    }
    assert_eq!(session_scoped, 17);
    assert!(
        gateway.calls().is_empty(),
        "an internal slot reached the host: {:?}",
        gateway.calls()
    );
    assert_eq!(gateway.session_admin_calls().len(), session_scoped);

    // `OPTIONS` is behind the same layer.
    for url in [
        "/api/sessions/slot1/queue",
        "/api/sessions/slot1/scheduled-messages/m1",
        "/api/v1/sessions/slot1/waits",
    ] {
        assert_eq!(gateway.options(url).status, 404, "{url}");
    }
    assert!(gateway.calls().is_empty());

    // A malformed body on an internal slot is still the guard's 404: the guard
    // sits in front of the JSON parser.
    let bad = gateway.exchange(
        "POST",
        "/api/sessions/slot1/queue/action",
        &[],
        Some(b"{bad"),
    );
    assert_eq!(bad.status, 404);
    assert!(gateway.calls().is_empty());

    // An ordinary session passes the guard and reaches the host.
    assert_eq!(gateway.get("/api/sessions/s1/queue").status, 200);
    assert_eq!(gateway.get("/api/v1/sessions/s1/waits").status, 200);
    assert_eq!(
        ops_sent(&gateway.calls()),
        vec!["session-queue", "v1-session-waits"]
    );
}

#[test]
fn the_aux_and_goal_routes_are_not_behind_the_session_guard() {
    let gateway = Gateway::start("unguarded", guarded_world());
    for (method, url, has_body) in [
        ("GET", "/api/aux/status", false),
        ("POST", "/api/goal/precheck", true),
        ("GET", "/api/settings/goal", false),
    ] {
        let body = has_body.then(|| json!({ "task": "x" }));
        assert_eq!(sent(&gateway, method, url, body).status, 200);
    }
    assert!(gateway.session_admin_calls().is_empty());
    assert_eq!(gateway.calls().len(), 3);
}

#[test]
fn a_guard_that_cannot_be_asked_is_the_503() {
    let gateway = Gateway::start(
        "guard-down",
        json!({ "sessionAdmin": { "hostDown": true } }),
    );
    let response = gateway.get("/api/sessions/s1/queue");
    assert_eq!(response.status, 503);
    assert_eq!(response.json()["code"], "rust_backend_unavailable");
    assert!(gateway.calls().is_empty());
}

// ── OPTIONS union ───────────────────────────────────────────────────────────

#[test]
fn allow_header_covers_every_registered_path() {
    let gateway = Gateway::start("allow", json!({ "orchestration": { "ops": {} } }));
    let cases = [
        ("/api/aux/status", "GET,HEAD"),
        ("/api/aux/health", "GET,HEAD"),
        ("/api/aux/history", "GET,HEAD"),
        ("/api/aux/enqueue", "POST"),
        ("/api/aux/cancel", "POST"),
        ("/api/aux/config", "GET,HEAD,POST"),
        ("/api/settings/goal", "GET,HEAD,POST"),
        ("/api/goal/precheck", "POST"),
        ("/api/sessions/s9/aux-runs", "GET,HEAD"),
        ("/api/sessions/s9/aux-runs/r1", "GET,HEAD"),
        ("/api/sessions/s9/unattended", "GET,HEAD,POST"),
        ("/api/sessions/s9/scheduled-messages", "POST,GET,HEAD"),
        ("/api/sessions/s9/scheduled-messages/m1", "DELETE"),
        ("/api/sessions/s9/tasks", "GET,HEAD"),
        ("/api/sessions/s9/dispatches", "GET,HEAD"),
        ("/api/sessions/s9/user-input/dismiss", "POST"),
        ("/api/sessions/s9/queue", "GET,HEAD"),
        ("/api/sessions/s9/queue/action", "POST"),
        ("/api/v1/sessions/s9/waits", "GET,HEAD"),
    ];
    for (path, allow) in cases {
        let response = gateway.options(path);
        assert_eq!(response.status, 200, "{path}: {}", gateway.log());
        assert_eq!(response.header("allow"), Some(allow), "{path}");
        assert_eq!(response.body, allow, "{path}");
    }
    assert!(gateway.calls().is_empty(), "OPTIONS reached the host");
}

// ── write serialization ─────────────────────────────────────────────────────

#[test]
fn aux_enqueue_and_its_cancel_run_concurrently_but_other_writes_serialize() {
    let gateway = Gateway::start(
        "write-lock",
        json!({ "orchestration": { "ops": {}, "delayMs": 1500 } }),
    );
    // enqueue + cancel: the cancel must not queue behind the long enqueue.
    let started = Instant::now();
    std::thread::scope(|scope| {
        scope.spawn(|| gateway.send("POST", "/api/aux/enqueue", &json!({ "prompt": "p" })));
        std::thread::sleep(Duration::from_millis(100));
        scope.spawn(|| gateway.send("POST", "/api/aux/cancel", &json!({ "id": "t1" })));
    });
    let concurrent = started.elapsed();
    assert!(
        concurrent < Duration::from_millis(2800),
        "enqueue and cancel serialized: {concurrent:?}"
    );

    // Two queue actions on the one write lock do serialize.
    let started = Instant::now();
    std::thread::scope(|scope| {
        scope.spawn(|| {
            gateway.send(
                "POST",
                "/api/sessions/s1/queue/action",
                &json!({ "action": "retry", "confirm": true }),
            )
        });
        std::thread::sleep(Duration::from_millis(100));
        scope.spawn(|| {
            gateway.send(
                "POST",
                "/api/sessions/s1/unattended",
                &json!({ "action": "stop" }),
            )
        });
    });
    let serialized = started.elapsed();
    assert!(
        serialized >= Duration::from_millis(2900),
        "two writes ran concurrently: {serialized:?}"
    );
    // Reads are never serialized.
    let started = Instant::now();
    std::thread::scope(|scope| {
        scope.spawn(|| gateway.get("/api/sessions/s1/queue"));
        scope.spawn(|| gateway.get("/api/sessions/s1/tasks"));
    });
    assert!(started.elapsed() < Duration::from_millis(2800));

    // A slow detached start must not block a callback needed by another task.
    let started = Instant::now();
    std::thread::scope(|scope| {
        scope.spawn(|| {
            gateway.send(
                "POST",
                "/api/sessions/s1/run-detached",
                &json!({ "command": "true" }),
            )
        });
        std::thread::sleep(Duration::from_millis(100));
        scope.spawn(|| gateway.send("POST", "/api/wait/w1/resolve", &json!({ "token": "t" })));
    });
    assert!(
        started.elapsed() < Duration::from_millis(2800),
        "detached start blocked callback"
    );
}

// ── failure surface ─────────────────────────────────────────────────────────

#[test]
fn unreachable_host_is_the_registered_503() {
    let gateway = Gateway::start(
        "host-down",
        json!({ "orchestration": { "hostDown": true } }),
    );
    for (method, url, body) in [
        ("GET", "/api/aux/status", None),
        ("POST", "/api/aux/enqueue", Some(json!({ "prompt": "p" }))),
        ("GET", "/api/v1/sessions/s1/waits", None),
        ("POST", "/api/sessions/s1/queue/action", Some(json!({}))),
    ] {
        let response = sent(&gateway, method, url, body);
        assert_eq!(response.status, 503, "{method} {url}");
        assert_key_order(&response.body, &["error", "code"]);
        let body = response.json();
        assert_eq!(body["error"], "编排与无人值守接口尚未就绪，请更新原生模块");
        assert_eq!(body["code"], "rust_backend_unavailable");
    }
}

#[test]
fn a_handler_that_threw_is_the_500_envelope_without_the_thrown_message() {
    let gateway = Gateway::start(
        "threw",
        world(json!({
            "session-queue": {
                "threw": true,
                "status": 500,
                "code": "internal_error",
                "message": "internal_error",
            },
        })),
    );
    let response = gateway.get("/api/sessions/s1/queue");
    assert_eq!(response.status, 500);
    assert_key_order(&response.body, &["ok", "error", "code", "requestId"]);
    assert!(!response.body.contains("stack"));
    assert!(!response.body.contains("/Users/"));
    assert_eq!(response.json()["requestId"], "host-req-1");
}

#[test]
fn a_host_that_answered_non_200_is_the_500() {
    let gateway = Gateway::start(
        "host-500",
        json!({ "orchestration": { "fail": ["aux-status"] } }),
    );
    let response = gateway.get("/api/aux/status");
    assert_eq!(response.status, 500);
    assert_key_order(&response.body, &["ok", "error", "code", "requestId"]);
    let body = response.json();
    assert_eq!(body["ok"], false);
    assert_eq!(body["error"], "internal_error");
    assert_eq!(body["requestId"], "host-req-1");
}

// ── desensitization ─────────────────────────────────────────────────────────

/// Field names that must never appear in any projection this cluster relays
/// (the aux config / goal settings carry model configuration and prompts, never
/// credentials). The front door adds no field of its own, so the scripted
/// projections below prove the relay is verbatim and the host payloads carry no
/// credential-shaped key either.
const FORBIDDEN_FIELDS: &[&str] = &[
    "apiKey",
    "api_key",
    "token",
    "secret",
    "password",
    "authorization",
    "cookie",
    "credential",
    "accessToken",
];

#[test]
fn relayed_projections_and_host_payloads_carry_no_credential_fields() {
    let gateway = Gateway::start(
        "desensitize",
        world(json!({
            "aux-config-get": relay(200, json!({
                "protocol": "anthropic", "providerId": "p1", "model": "m",
                "cliAvailability": { "claude": true, "codex": false },
                "protocols": [{ "id": "anthropic", "name": "Anthropic Messages" }],
                "providersByProtocol": { "anthropic": [{ "id": "p1", "name": "P", "modelOptions": ["m"], "wireApi": "messages", "available": true, "unavailableReason": null, "limit": null }], "openai": [] },
            })),
            "settings-goal-get": relay(200, json!({
                "enabled": true, "minScore": 60, "dimensions": {}, "dimensionLabels": {}, "precheckWaitMs": 180000,
            })),
        })),
    );
    let mut bodies = vec![
        gateway.get("/api/aux/config").body,
        gateway.get("/api/settings/goal").body,
    ];
    let mut headers = external();
    headers.push(("Cookie", "multicc_auth=c"));
    let payload = json!({ "protocol": "anthropic", "providerId": "p1", "model": "m" });
    gateway.exchange(
        "POST",
        "/api/aux/config",
        &headers,
        Some(payload.to_string().as_bytes()),
    );
    bodies.push(fs::read_to_string(gateway.state.join("orchestration-calls.jsonl")).unwrap());
    for text in bodies {
        let lower = text.to_ascii_lowercase();
        for field in FORBIDDEN_FIELDS {
            assert!(
                !lower.contains(&format!("\"{}\":", field.to_ascii_lowercase())),
                "{field} appears in {text}"
            );
        }
    }
}
