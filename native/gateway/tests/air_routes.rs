#![recursion_limit = "256"]

//! Integration coverage for the 17 Air task-board routes retired from
//! `src/workspace/air-routes.js` and answered by the Rust front door
//! (`native/gateway/src/app/air_routes.rs`). The Node process here is only the
//! protocol fixture: it answers `POST /api/__host/air` from
//! `FIXTURE_HOST_SCRIPT` and appends every payload to `air-calls.jsonl`, so the
//! tests can assert what the front door asked the runtime to do.

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
        "multicc-gateway-air-{}-{tag}-{nanos}",
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
        fs::read_to_string(self.state.join("air-calls.jsonl"))
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
            format!("{method} {url} HTTP/1.1\r\nHost: localhost\r\nX-Request-Id: air-req-1\r\n");
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
    fn get_with(&self, url: &str, extra: &[(&str, &str)]) -> Response {
        self.exchange("GET", url, extra, None)
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

fn refused(code: &str, status: i64, message: &str) -> Value {
    json!({ "ok": false, "error": { "code": code, "status": status, "message": message } })
}

const SNAPSHOT_BODY: &str =
    r#"{"b":1.5,"ok":true,"tasks":[{"id":"tsk_1","extra":null}],"a":[1,2]}"#;

const SYNC_BODY: &str = r#"{"events":[],"cursor":"epoch:1","taskStats":{"all":{"total":2}},"checkedAt":0,"degraded":false}"#;
const PAGE_BODY: &str = r#"{"ok":true,"revision":1,"page":1,"pages":1,"total":0,"tasks":[]}"#;

/// One scripted answer per host op, keyed the way the fixture resolves them.
fn world() -> Value {
    let ops = json!({
        "sync": ok(json!({"events": [], "cursor": "epoch:1",
            "taskStats": {"all": {"total": 2}}, "checkedAt": 0, "degraded": false})),
        "page": ok(json!({"ok": true, "revision": 1, "page": 1, "pages": 1,
            "total": 0, "tasks": []})),
        "snapshot": ok(json!({"body": SNAPSHOT_BODY, "etag": "W/\"snap-1\""})),
        "reclaim": ok(json!({"kind": "reclaimed",
            "result": {"ok": true, "considered": 3, "hibernated": 2}})),
        "resolve": ok(json!({"taskId": "tsk_1", "dirId": "dir_1"})),
        "create-task": ok(json!({"task": {"id": "tsk_new"}, "dirId": "dir_1"})),
        "task-detail-scope:tsk_1": ok(json!({"ok":true,"task":{"id":"tsk_1"},"sessionId":"s","messageScope":{"sessionIds":["s"]}})),
        "task-detail-scope:tsk/1": ok(json!({"ok":true,"task":{"id":"tsk/1"},"messageScope":{}})),
        "task-open": ok(json!({"ok": true, "taskId": "tsk_1", "readOnly": false,
            "sessionId": "s1", "configuration": null, "roleBindings": null, "session": null})),
        "reconcile": ok(json!([{"artifactId": "report", "state": "published"}])),
        "roles": ok(json!([{"roleId": "reviewer", "memberId": "m_1"}])),
        "pins-read": ok(json!(["tsk_1", "tsk_2"])),
        "pins-replace": ok(json!(["tsk_1"])),
        "pins-toggle": ok(json!(["tsk_2"])),
        "todos-read": ok(json!(["tsk_3"])),
        "todos-replace": ok(json!(["tsk_3", "tsk_4"])),
        "todos-toggle": ok(json!(["tsk_4"])),
        "todos-ignore": ok(json!({"ignored": true, "taskIds": []}))
    });
    json!({ "air": { "ops": ops } })
}

#[test]
fn snapshot_forwards_the_host_body_and_etag_without_reserializing() {
    let gateway = Gateway::start("snapshot", world());
    let snapshot = gateway.get("/api/air");
    assert_eq!(snapshot.status, 200);
    // Byte for byte: key order, 1.5 and null all survive, so nothing parsed and
    // re-serialized the 4s hot path body.
    assert_eq!(snapshot.body, SNAPSHOT_BODY);
    assert_eq!(snapshot.header("etag"), Some("W/\"snap-1\""));
    assert_eq!(
        snapshot.header("content-type"),
        Some("application/json; charset=utf-8")
    );
    assert_eq!(snapshot.header("vary"), Some("Accept-Encoding"));
    assert_eq!(
        snapshot.header("content-length").map(str::to_string),
        Some(SNAPSHOT_BODY.len().to_string())
    );
    let calls = gateway.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["op"], "snapshot");
    assert!(
        calls[0].get("ifNoneMatch").is_none(),
        "an unconditional request forwards no header: {}",
        calls[0]
    );

    // The node-side ETag decides the 304; the tag itself is forwarded verbatim.
    let conditional = gateway.get_with("/api/air", &[("If-None-Match", "W/\"snap-1\"")]);
    assert_eq!(conditional.status, 304);
    assert_eq!(conditional.body, "");
    assert_eq!(conditional.header("etag"), Some("W/\"snap-1\""));
    assert_eq!(conditional.header("content-type"), None);
    assert_eq!(conditional.header("content-length"), None);
    assert_eq!(gateway.calls().len(), 2, "a 304 still costs one round trip");
    assert_eq!(gateway.calls()[1]["ifNoneMatch"], "W/\"snap-1\"");

    let star = gateway.get_with("/api/air", &[("If-None-Match", "*")]);
    assert_eq!(star.status, 304);

    let head = gateway.head("/api/air");
    assert_eq!(head.status, 200);
    assert_eq!(head.body, "");
    assert_eq!(head.header("etag"), Some("W/\"snap-1\""));
    assert_eq!(
        head.header("content-length").map(str::to_string),
        Some(SNAPSHOT_BODY.len().to_string()),
        "HEAD keeps the GET Content-Length"
    );
    assert_eq!(head.header("content-encoding"), None);
}

#[test]
fn snapshot_keeps_express_freshness_beyond_the_explicit_match() {
    let gateway = Gateway::start("fresh", world());
    // `conditionalBody` only matches the exact tag, but a strong form of the
    // same weak tag still goes through Express's own `fresh()` and becomes 304.
    let strong = gateway.get_with("/api/air", &[("If-None-Match", "\"snap-1\"")]);
    assert_eq!(strong.status, 304);
    assert_eq!(strong.header("etag"), Some("W/\"snap-1\""));
    let other = gateway.get_with("/api/air", &[("If-None-Match", "W/\"snap-2\"")]);
    assert_eq!(other.status, 200);
    assert_eq!(other.body, SNAPSHOT_BODY);
}

#[test]
fn task_detail_is_conditional_and_decodes_the_param() {
    let gateway = Gateway::start("detail", world());
    let dir = gateway.dir.join("data/chat_history");
    fs::create_dir(&dir).unwrap();
    let tool = "界".repeat(16000);
    let rows = (0..60)
        .map(|i| {
            json!({"id":format!("m{i}"),"role":"assistant","heldResultId":i,"ts":i,
        "content":if i==59 {tool.as_str()} else {"text"}})
            .to_string()
        })
        .collect::<Vec<_>>()
        .join("\n");
    fs::write(dir.join("s.json"), rows).unwrap();
    let url = "/api/air/tasks/tsk_1";
    let plain = gateway.get(url);
    assert_eq!(plain.status, 200, "{}", plain.body);
    let json = plain.json();
    assert_eq!(json["messages"].as_array().unwrap().len(), 50);
    assert_eq!(json["messages"][49]["truncated"], true);
    assert_eq!(json["messages"][49]["contentOriginalLength"], tool.len());
    assert!(json.get("messageScope").is_none());
    assert_eq!(json["hasMore"], true);
    assert_eq!(json["before"], "s:m10");
    let tag = plain.header("etag").unwrap();
    let second = gateway.get_with(url, &[("If-None-Match", tag)]);
    assert_eq!(second.status, 304);
    assert!(second.body.is_empty());
    let older = gateway.get_with(
        &format!("{url}?before=s%3Am10&limit=15"),
        &[("If-None-Match", tag)],
    );
    assert_eq!(older.status, 200);
    assert_eq!(older.json()["messages"].as_array().unwrap().len(), 10);
    assert_eq!(older.json()["hasMore"], false);
    assert_eq!(
        gateway.get(&format!("{url}?messageId=s%3Am59")).json()["message"]["content"],
        tool
    );
    assert_eq!(gateway.get(&format!("{url}?messageId=other")).status, 404);
    assert_eq!(
        gateway.get("/api/air/tasks/tsk%2F1").json()["task"]["id"],
        "tsk/1"
    );
    assert_eq!(gateway.calls().last().unwrap()["taskId"], "tsk/1");
    assert!(gateway
        .calls()
        .iter()
        .all(|v| v["op"] == "task-detail-scope"));
    let count = gateway.calls().len();
    assert_eq!(gateway.get("/api/air/tasks/%zz").status, 400);
    assert_eq!(gateway.calls().len(), count);
}

#[test]
fn oversized_expansion_streams_one_record_and_honors_etag() {
    let gateway = Gateway::start("stream", world());
    let dir = gateway.dir.join("data/chat_history");
    fs::create_dir(&dir).unwrap();
    let output = "x".repeat(16 * 1024 * 1024 + 1);
    fs::write(
        dir.join("s.json"),
        json!({"id":"huge","role":"assistant","tools":[{"result":output}]}).to_string(),
    )
    .unwrap();
    let url = "/api/air/tasks/tsk_1?messageId=s%3Ahuge";
    let expanded = gateway.get(url);
    assert_eq!(expanded.status, 200);
    assert_eq!(expanded.json()["message"]["tools"][0]["result"], output);
    let cached = gateway.get_with(url, &[("If-None-Match", expanded.header("etag").unwrap())]);
    assert_eq!(cached.status, 304);
    assert!(cached.body.is_empty());
}

#[test]
fn resolve_forwards_the_query_and_builds_the_redirect_url() {
    let gateway = Gateway::start("resolve", world());
    let hit = gateway.get("/api/air/resolve?task=tsk_1");
    assert_eq!(hit.status, 200);
    assert_eq!(
        hit.body,
        "{\"ok\":true,\"taskId\":\"tsk_1\",\"url\":\"/air?task=tsk_1&dir=dir_1\"}"
    );
    assert_eq!(gateway.calls()[0]["op"], "resolve");
    assert_eq!(gateway.calls()[0]["task"], "tsk_1");

    gateway.get("/api/air/resolve?task=a&task=b");
    let repeated = gateway.calls().pop().unwrap();
    assert_eq!(
        repeated["task"],
        json!(["a", "b"]),
        "qs repeats stay arrays"
    );

    gateway.get("/api/air/resolve?session=s1&shell=sh%2F1");
    let scoped = gateway.calls().pop().unwrap();
    assert_eq!(scoped["session"], "s1");
    assert_eq!(scoped["shell"], "sh/1");
    assert!(scoped.get("task").is_none(), "absent keys stay absent");

    let mut script = world();
    script["air"]["ops"]["resolve"] = ok(json!({}));
    let empty = Gateway::start("resolve-empty", script);
    let miss = empty.get("/api/air/resolve");
    assert_eq!(miss.status, 200);
    assert_eq!(miss.body, "{\"ok\":true,\"url\":\"/air\"}");
}

#[test]
fn sync_and_page_forward_the_query_with_qs_shapes() {
    let gateway = Gateway::start("sync-page", world());

    // Bare bootstrap: no query keys reach the host.
    let bootstrap = gateway.get("/api/air/sync");
    assert_eq!(bootstrap.status, 200);
    assert_eq!(bootstrap.body, SYNC_BODY);
    assert_eq!(
        bootstrap.header("content-type"),
        Some("application/json; charset=utf-8")
    );
    let call = gateway.calls().pop().unwrap();
    assert_eq!(call["op"], "sync");
    assert!(call.get("dayStart").is_none());
    assert!(call.get("cursor").is_none());
    assert!(call.get("include").is_none());

    // Scalar keys forward as strings.
    gateway.get("/api/air/sync?dayStart=5&cursor=epoch%3A1&include=a%2Cb");
    let call = gateway.calls().pop().unwrap();
    assert_eq!(call["dayStart"], "5");
    assert_eq!(call["cursor"], "epoch:1");
    assert_eq!(call["include"], "a,b");

    // qs repeats stay arrays; bracket objects collapse the way the retired
    // handlers' String/Object coercions saw them (an opaque object).
    gateway.get("/api/air/sync?dayStart=1&dayStart=2&cursor[x]=1");
    let call = gateway.calls().pop().unwrap();
    assert_eq!(call["dayStart"], json!(["1", "2"]));
    assert_eq!(call["cursor"], json!({}));

    // Page: every key the projection validates or reads forwards; unknown
    // keys never reached the reader through the retired spread either.
    let page = gateway.get(
        "/api/air/page?status=all&page=2&limit=20&query=x&dirId=d1&sort=visit&dayStart=0&ids=a&ids=b&visits=%7B%22a%22%3A1%7D&foo=bar",
    );
    assert_eq!(page.status, 200);
    assert_eq!(page.body, PAGE_BODY);
    let call = gateway.calls().pop().unwrap();
    assert_eq!(call["op"], "page");
    assert_eq!(call["status"], "all");
    assert_eq!(call["page"], "2");
    assert_eq!(call["limit"], "20");
    assert_eq!(call["ids"], json!(["a", "b"]));
    assert_eq!(call["visits"], "{\"a\":1}");
    assert!(
        call.get("foo").is_none(),
        "unknown keys never reached the reader"
    );
}

#[test]
fn sync_and_page_refusals_head_and_freshness_follow_the_cluster_rules() {
    let mut script = world();
    script["air"]["ops"]["sync"] = refused("air_busy", 503, "busy");
    let gateway = Gateway::start("sync-refused", script);
    let busy = gateway.get("/api/air/sync");
    assert_eq!(busy.status, 503);
    assert_eq!(
        busy.body,
        "{\"ok\":false,\"code\":\"air_busy\",\"message\":\"busy\"}"
    );

    // No status: the generic 500 envelope, the host message never leaks.
    let mut script = world();
    script["air"]["ops"]["page"] =
        json!({ "ok": false, "error": { "message": "read_model_invalid_options" } });
    let gateway = Gateway::start("page-refused", script);
    let failed = gateway.get("/api/air/page");
    assert_eq!(failed.status, 500);
    assert_eq!(
        failed.body,
        "{\"ok\":false,\"code\":\"air_request_failed\",\"message\":\"Request failed\"}"
    );

    // HEAD runs the GET handler and strips only the body.
    let gateway = Gateway::start("sync-head", world());
    let get = gateway.get("/api/air/sync");
    let head = gateway.head("/api/air/sync");
    assert_eq!(head.status, 200);
    assert_eq!(head.body, "");
    assert_eq!(head.header("content-length"), get.header("content-length"));
    assert_eq!(head.header("etag"), get.header("etag"));

    // The res.json freshness check applies to these reads too.
    let etag = get.header("etag").unwrap().to_string();
    let fresh = gateway.get_with("/api/air/sync", &[("If-None-Match", &etag)]);
    assert_eq!(fresh.status, 304);
    assert_eq!(fresh.body, "");
}

#[test]
fn reclaim_reports_hibernation_unavailable_and_spreads_the_result() {
    let mut script = world();
    script["air"]["ops"]["reclaim"] = ok(json!({ "kind": "unavailable" }));
    let gateway = Gateway::start("reclaim-off", script);
    let off = gateway.send("POST", "/api/air/worktrees/reclaim", &json!({}));
    assert_eq!(off.status, 200);
    assert_eq!(
        off.body,
        "{\"ok\":false,\"code\":\"hibernation_unavailable\",\"considered\":0,\"hibernated\":0}"
    );

    let gateway = Gateway::start("reclaim", world());
    let reclaimed = gateway.send(
        "POST",
        "/api/air/worktrees/reclaim",
        &json!({"dirId": "dir_1", "force": true}),
    );
    assert_eq!(reclaimed.status, 200);
    assert_eq!(
        reclaimed.body,
        "{\"ok\":true,\"dirId\":\"dir_1\",\"considered\":3,\"hibernated\":2}"
    );
    let call = gateway.calls().pop().unwrap();
    assert_eq!(call["op"], "reclaim");
    assert_eq!(call["dirId"], "dir_1");
    assert_eq!(call["force"], true);

    // `body.dirId ? String(body.dirId) : null`
    gateway.send("POST", "/api/air/worktrees/reclaim", &json!({"dirId": ""}));
    assert_eq!(gateway.calls().pop().unwrap()["dirId"], Value::Null);
    gateway.send("POST", "/api/air/worktrees/reclaim", &json!({"dirId": 7}));
    assert_eq!(gateway.calls().pop().unwrap()["dirId"], "7");
    gateway.send(
        "POST",
        "/api/air/worktrees/reclaim",
        &json!({"force": "true"}),
    );
    let loose = gateway.calls().pop().unwrap();
    assert_eq!(loose["force"], false, "only an exact true counts");
    assert_eq!(loose["dirId"], Value::Null);
}

#[test]
fn refusals_use_each_routes_own_code_and_message_rule() {
    let mut script = world();
    script["air"]["ops"]["reclaim"] = refused("directory_not_found", 404, "directory not found");
    script["air"]["ops"]["pins-replace"] = refused("pin_limit", 409, "too many pins");
    script["air"]["ops"]["pins-toggle"] = refused("pin_failed", 409, "no such pin");
    script["air"]["ops"]["todos-replace"] = refused("todo_failed", 500, "todo store down");
    script["air"]["ops"]["todos-toggle"] = refused("todo_limit", 409, "too many todos");
    script["air"]["ops"]["todos-ignore"] = refused("ignore_failed", 409, "ignore store down");
    script["air"]["ops"]["snapshot"] = refused("", 500, "boom");
    let gateway = Gateway::start("refuse", script);

    let missing_dir = gateway.send(
        "POST",
        "/api/air/worktrees/reclaim",
        &json!({"dirId": "dir_x"}),
    );
    assert_eq!(missing_dir.status, 404);
    assert_eq!(
        missing_dir.body,
        "{\"ok\":false,\"code\":\"directory_not_found\",\"message\":\"directory not found\"}"
    );

    // The GET collection routes keep the thrown message when a status exists.
    let snapshot = gateway.get("/api/air");
    assert_eq!(snapshot.status, 500);
    assert_eq!(
        snapshot.body,
        "{\"ok\":false,\"code\":\"air_request_failed\",\"message\":\"boom\"}"
    );

    // The POST collections always answer `Request failed`.
    let pins = gateway.send("POST", "/api/air/pins", &json!({"taskIds": ["a"]}));
    assert_eq!(pins.status, 409);
    assert_eq!(
        pins.body,
        "{\"ok\":false,\"code\":\"pin_limit\",\"message\":\"Request failed\"}"
    );
    let todos = gateway.send("POST", "/api/air/todos", &json!({"taskIds": ["a"]}));
    assert_eq!(todos.status, 500);
    assert_eq!(
        todos.body,
        "{\"ok\":false,\"code\":\"todo_failed\",\"message\":\"Request failed\"}"
    );

    let toggle = gateway.send("POST", "/api/air/pins/toggle", &json!({"taskId": "x"}));
    assert_eq!(toggle.status, 409);
    assert_eq!(
        toggle.body,
        "{\"ok\":false,\"code\":\"pin_failed\",\"message\":\"no such pin\"}"
    );
    let todo_toggle = gateway.send("POST", "/api/air/todos/toggle", &json!({"taskId": "x"}));
    assert_eq!(todo_toggle.status, 409);
    let ignore = gateway.send("POST", "/api/air/todos/ignore", &json!({"taskId": "x"}));
    assert_eq!(ignore.status, 409);
    assert_eq!(
        ignore.body,
        "{\"ok\":false,\"code\":\"ignore_failed\",\"message\":\"ignore store down\"}"
    );
    assert_key_order(&ignore.body, &["ok", "code", "message"]);
}

#[test]
fn task_ids_validation_happens_before_the_host_call() {
    let gateway = Gateway::start("validate", world());
    for body in [
        json!({"taskIds": "tsk_1"}),
        json!({"taskIds": null}),
        json!({}),
        json!([1, 2]),
    ] {
        for url in ["/api/air/pins", "/api/air/todos"] {
            let response = gateway.send("POST", url, &body);
            assert_eq!(response.status, 400, "{url} {body}");
            assert_eq!(
                response.body,
                "{\"ok\":false,\"code\":\"task_ids_required\",\"message\":\"taskIds 必须是数组\"}"
            );
        }
    }
    assert!(
        gateway.calls().is_empty(),
        "no round trip for a rejected body"
    );
}

#[test]
fn pins_and_todos_round_trip_their_arrays() {
    let gateway = Gateway::start("pins", world());
    assert_eq!(
        gateway.get("/api/air/pins").body,
        "{\"ok\":true,\"taskIds\":[\"tsk_1\",\"tsk_2\"]}"
    );
    assert_eq!(
        gateway
            .send("POST", "/api/air/pins", &json!({"taskIds": ["tsk_1"]}))
            .body,
        "{\"ok\":true,\"taskIds\":[\"tsk_1\"]}"
    );
    assert_eq!(
        gateway
            .send("POST", "/api/air/pins/toggle", &json!({"taskId": "tsk_2"}))
            .body,
        "{\"ok\":true,\"taskIds\":[\"tsk_2\"]}"
    );
    assert_eq!(
        gateway.get("/api/air/todos").body,
        "{\"ok\":true,\"taskIds\":[\"tsk_3\"]}"
    );
    assert_eq!(
        gateway
            .send(
                "POST",
                "/api/air/todos",
                &json!({"taskIds": ["tsk_3", "tsk_4"]})
            )
            .body,
        "{\"ok\":true,\"taskIds\":[\"tsk_3\",\"tsk_4\"]}"
    );
    assert_eq!(
        gateway
            .send("POST", "/api/air/todos/toggle", &json!({"taskId": "tsk_4"}))
            .body,
        "{\"ok\":true,\"taskIds\":[\"tsk_4\"]}"
    );
    // `{ ok: true, ...result }`: the spread follows the leading ok.
    assert_eq!(
        gateway
            .send("POST", "/api/air/todos/ignore", &json!({"taskId": "tsk_5"}))
            .body,
        "{\"ok\":true,\"ignored\":true,\"taskIds\":[]}"
    );

    let calls = gateway.calls();
    let ops: Vec<&str> = calls
        .iter()
        .map(|call| call["op"].as_str().unwrap())
        .collect();
    assert_eq!(
        ops,
        [
            "pins-read",
            "pins-replace",
            "pins-toggle",
            "todos-read",
            "todos-replace",
            "todos-toggle",
            "todos-ignore"
        ]
    );
    assert_eq!(calls[1]["taskIds"], json!(["tsk_1"]));
    assert_eq!(calls[2]["taskId"], "tsk_2");
    assert_eq!(calls[6]["taskId"], "tsk_5");
}

#[test]
fn task_create_open_reconcile_and_roles_wrap_their_payloads() {
    let gateway = Gateway::start("tasks", world());

    let created = gateway.send("POST", "/api/air/tasks", &json!({"title": "New"}));
    assert_eq!(created.status, 200);
    assert_eq!(
        created.body,
        "{\"task\":{\"id\":\"tsk_new\"},\"dirId\":\"dir_1\"}"
    );
    assert_eq!(gateway.calls()[0]["op"], "create-task");
    assert_eq!(gateway.calls()[0]["body"], json!({"title": "New"}));

    let open = gateway.get("/api/air/tasks/tsk_1/open");
    assert_eq!(open.status, 200);
    assert_eq!(open.json()["taskId"], "tsk_1");
    assert_eq!(gateway.calls().pop().unwrap()["op"], "task-open");

    let reconcile = gateway.send(
        "POST",
        "/api/air/tasks/tsk_1/delivery/reconcile",
        &json!({}),
    );
    assert_eq!(reconcile.status, 200);
    assert_eq!(
        reconcile.body,
        "{\"ok\":true,\"publications\":[{\"artifactId\":\"report\",\"state\":\"published\"}]}"
    );

    let roles = gateway.send(
        "POST",
        "/api/air/tasks/tsk_1/roles",
        &json!({"roleId": "reviewer"}),
    );
    assert_eq!(roles.status, 200);
    assert_eq!(
        roles.body,
        "{\"ok\":true,\"roleBindings\":[{\"roleId\":\"reviewer\",\"memberId\":\"m_1\"}]}"
    );
    let call = gateway.calls().pop().unwrap();
    assert_eq!(call["op"], "roles");
    assert_eq!(call["taskId"], "tsk_1");
    assert_eq!(call["body"], json!({"roleId": "reviewer"}));
}

#[test]
fn options_and_head_follow_the_express_automation() {
    let gateway = Gateway::start("options", world());
    let snapshot = gateway.options("/api/air");
    assert_eq!(snapshot.status, 200);
    assert_eq!(snapshot.header("allow"), Some("GET,HEAD"));
    assert_eq!(snapshot.body, "GET,HEAD");
    assert_eq!(
        gateway.options("/api/air/pins").header("allow"),
        Some("GET,HEAD,POST")
    );
    assert_eq!(
        gateway.options("/api/air/todos").header("allow"),
        Some("GET,HEAD,POST")
    );
    assert_eq!(
        gateway.options("/api/air/tasks/tsk_1").header("allow"),
        Some("GET,HEAD")
    );
    assert_eq!(
        gateway
            .options("/api/air/tasks/tsk_1/roles")
            .header("allow"),
        Some("POST")
    );
    assert_eq!(
        gateway.options("/api/air/sync").header("allow"),
        Some("GET,HEAD")
    );
    assert_eq!(
        gateway.options("/api/air/page").header("allow"),
        Some("GET,HEAD")
    );
    assert!(
        gateway.calls().is_empty(),
        "OPTIONS never reaches the host port"
    );
}

#[test]
fn a_missing_host_port_is_a_503() {
    let mut script = world();
    script["air"]["hostDown"] = json!(true);
    let gateway = Gateway::start("down", script);
    let down = gateway.get("/api/air");
    assert_eq!(down.status, 503);
    assert_eq!(down.json()["code"], "rust_backend_unavailable");
    let write = gateway.send("POST", "/api/air/pins", &json!({"taskIds": ["a"]}));
    assert_eq!(write.status, 503);
    assert_eq!(write.json()["code"], "rust_backend_unavailable");
}
