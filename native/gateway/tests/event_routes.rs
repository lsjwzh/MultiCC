//! Integration coverage for the fifteen events & triggers routes against the
//! real `multicc-gateway` binary:
//!
//!   GET|HEAD /api/events/catalog        GET|HEAD /api/events/recent
//!   GET|HEAD /api/event-triggers        GET|HEAD /api/event-rules
//!   POST     /api/event-rules           PUT      /api/event-rules/:id
//!   DELETE   /api/event-rules/:id       POST     /api/events/test
//!   GET|HEAD /api/sessions/:id/triggers POST     /api/sessions/:id/triggers
//!   PUT      /api/sessions/:id/triggers/:tid
//!   DELETE   /api/sessions/:id/triggers/:tid
//!   POST     /api/sessions/:id/triggers/:tid/test
//!   GET|HEAD /api/annotation-live       POST     /api/annotation-live
//!
//! The Node process here is only the protocol fixture (PROXY v1 + auth
//! control): it answers `POST /api/__host/events` from `script.events.ops[op]`
//! (appending every payload to `events-calls.jsonl`) and the
//! `publicSessionAccessGuard` round trip from
//! `script.sessionAdmin.ops['guard-record:<id>']` (appending to
//! `session-admin-calls.jsonl`). Path matching (case-insensitive literals,
//! automatic OPTIONS), parameter decoding, query/body reads, every status map,
//! the DTO envelopes and key order, the guard's fail-closed 404, ETag/304/gzip
//! and the 503 surface are Rust and are what these tests assert. The byte
//! comparison against the frozen Node handlers lives in
//! docs/rust-migration/differential/event-routes.js.

use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use flate2::read::GzDecoder;
use serde_json::{json, Value};

const GATEWAY_BIN: &str = env!("CARGO_BIN_EXE_multicc-gateway");
const FIXTURE_JS: &str = include_str!("fixtures/upstream.js");
const TOKEN: &str = "secret-token-1";
const JSON: &str = "application/json; charset=utf-8";
const HTML: &str = "text/html; charset=utf-8";
const UNAVAILABLE: &str = "事件与触发器接口尚未就绪，请更新原生模块";

fn unique(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "multicc-gateway-events-{}-{tag}-{nanos}",
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
    raw_body: Vec<u8>,
}

impl Response {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.raw_body).into_owned()
    }
    fn json(&self) -> Value {
        serde_json::from_str(&self.text()).unwrap_or_else(|error| {
            panic!("not JSON ({error}): {}", self.text());
        })
    }
    fn etag(&self) -> String {
        self.header("etag")
            .unwrap_or_else(|| panic!("no ETag on {}", self.status))
            .to_string()
    }
    fn gunzip(&self) -> String {
        assert_eq!(self.header("content-encoding"), Some("gzip"));
        let mut text = String::new();
        GzDecoder::new(&self.raw_body[..])
            .read_to_string(&mut text)
            .expect("valid gzip body");
        text
    }
}

struct Gateway {
    dir: PathBuf,
    state: PathBuf,
    port: u16,
    child: Child,
}

impl Gateway {
    fn start(tag: &str) -> Self {
        let dir = unique(tag);
        let data = dir.join("data");
        let home = dir.join("home");
        let state = dir.join("state");
        for path in [&dir, &data, &home, &state] {
            fs::create_dir_all(path).unwrap();
        }
        fs::write(dir.join("server.js"), FIXTURE_JS).unwrap();
        let script_path = dir.join("host-script.json");
        fs::write(
            &script_path,
            json!({ "events": { "ops": {} }, "sessionAdmin": { "ops": {} } }).to_string(),
        )
        .unwrap();
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
            .env("TZ", "UTC")
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

    /// Replace the script the fixture reads per host-port request.
    fn set_script(&self, script: Value) {
        fs::write(self.dir.join("host-script.json"), script.to_string()).unwrap();
    }

    /// Script the events port and (optionally) the guard port in one world.
    fn world(&self, events_ops: Value, guard_ops: Value) {
        self.set_script(json!({
            "events": { "ops": events_ops },
            "sessionAdmin": { "ops": guard_ops },
        }));
    }

    /// One recorded session for the guard round trip (`internal: false`).
    fn record(&self, id: &str, triggers: Value) {
        let mut record = serde_json::Map::new();
        record.insert("id".to_string(), json!(id));
        if !triggers.is_null() {
            record.insert("triggers".to_string(), triggers);
        }
        let mut ops = serde_json::Map::new();
        ops.insert(
            format!("guard-record:{id}"),
            json!({ "record": Value::Object(record), "internal": false, "taskStateWritable": true }),
        );
        self.world(json!({}), Value::Object(ops));
    }

    /// The same session, but an internal execution slot.
    fn internal_slot(&self, id: &str) {
        let mut ops = serde_json::Map::new();
        ops.insert(
            format!("guard-record:{id}"),
            json!({ "record": { "id": id }, "internal": true, "taskStateWritable": false }),
        );
        self.world(json!({}), Value::Object(ops));
    }

    fn host_down(&self) {
        self.set_script(json!({ "hostDown": true }));
    }

    /// Every `POST /api/__host/events` body the fixture received, in order.
    fn host_calls(&self) -> Vec<Value> {
        fs::read_to_string(self.state.join("events-calls.jsonl"))
            .unwrap_or_default()
            .lines()
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    /// Every guard round trip, in order.
    fn guard_calls(&self) -> Vec<Value> {
        fs::read_to_string(self.state.join("session-admin-calls.jsonl"))
            .unwrap_or_default()
            .lines()
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_str(line).unwrap())
            .filter(|call: &Value| call["op"] == json!("guard-record"))
            .collect()
    }

    fn truncate_logs(&self) {
        let _ = fs::remove_file(self.state.join("events-calls.jsonl"));
        let _ = fs::remove_file(self.state.join("session-admin-calls.jsonl"));
    }

    fn exchange(
        &self,
        method: &str,
        url: &str,
        body: Option<&str>,
        extra: &[(&str, &str)],
    ) -> Response {
        let mut lines = String::new();
        let mut length = None;
        for &(name, value) in extra {
            if name.eq_ignore_ascii_case("content-type") {
                lines.push_str("Content-Type: application/json\r\n");
            } else if name.eq_ignore_ascii_case("content-length") {
                continue;
            } else {
                lines.push_str(&format!("{name}: {value}\r\n"));
            }
        }
        if let Some(body) = body {
            lines.push_str("Content-Type: application/json\r\n");
            length = Some(body.len());
        }
        let request = format!(
            "{method} {url} HTTP/1.1\r\nHost: localhost\r\nX-Request-Id: diff-req-1\r\n\
             {lines}Content-Length: {}\r\nConnection: close\r\n\r\n",
            length.unwrap_or(0)
        );
        let mut request = request.into_bytes();
        if let Some(body) = body {
            request.extend_from_slice(body.as_bytes());
        }
        // The gateway's port is probed and released before it binds, so a
        // parallel run can briefly steer a fresh connection at another
        // listener that resets it. Replay only when nothing was read.
        let mut raw = Vec::new();
        for attempt in 0..4 {
            let mut stream = TcpStream::connect(("127.0.0.1", self.port)).expect("connect gateway");
            stream
                .set_read_timeout(Some(Duration::from_secs(30)))
                .unwrap();
            stream.write_all(&request).unwrap();
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
            raw_body: raw[split + 4..].to_vec(),
        }
    }

    fn get(&self, url: &str) -> Response {
        self.exchange("GET", url, None, &[])
    }
    fn get_with(&self, url: &str, extra: &[(&str, &str)]) -> Response {
        self.exchange("GET", url, None, extra)
    }
    fn head(&self, url: &str) -> Response {
        self.exchange("HEAD", url, None, &[])
    }
    fn options(&self, url: &str) -> Response {
        self.exchange("OPTIONS", url, None, &[])
    }
    fn post(&self, url: &str, body: Option<&str>) -> Response {
        self.exchange("POST", url, body, &[])
    }
    fn put(&self, url: &str, body: Option<&str>) -> Response {
        self.exchange("PUT", url, body, &[])
    }
    fn delete(&self, url: &str) -> Response {
        self.exchange("DELETE", url, None, &[])
    }
}

impl Drop for Gateway {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.dir);
    }
}

/// Member order in a serialized JSON body (serde_json's `preserve_order` is
/// unified across the workspace) without depending on how the test crate
/// serializes its own `Value`s.
fn order(text: &str, needles: &[&str]) {
    let mut last = 0;
    for needle in needles {
        let at = text
            .find(needle)
            .unwrap_or_else(|| panic!("missing {needle} in {text}"));
        assert!(at >= last, "out of order {needle} in {text}");
        last = at;
    }
}

fn assert_unavailable(response: &Response) {
    assert_eq!(response.status, 503, "{}", response.text());
    assert_eq!(
        response.json(),
        json!({ "error": UNAVAILABLE, "code": "rust_backend_unavailable" })
    );
}

// ── Express's automatic OPTIONS ─────────────────────────────────────────────

#[test]
fn options_answers_every_registered_path() {
    let gateway = Gateway::start("options");
    gateway.world(json!({}), json!({}));
    let cases = [
        ("/api/events/catalog", "GET,HEAD"),
        ("/api/events/recent", "GET,HEAD"),
        ("/api/event-triggers", "GET,HEAD"),
        ("/api/event-rules", "GET,HEAD,POST"),
        ("/api/event-rules/r1", "PUT,DELETE"),
        ("/api/events/test", "POST"),
        ("/api/sessions/s1/triggers", "GET,HEAD,POST"),
        ("/api/sessions/s1/triggers/t1", "PUT,DELETE"),
        ("/api/sessions/s1/triggers/t1/test", "POST"),
        ("/api/annotation-live", "GET,HEAD,POST"),
    ];
    for (path, allow) in cases {
        let response = gateway.options(path);
        assert_eq!(response.status, 200, "OPTIONS {path}");
        assert_eq!(response.header("allow"), Some(allow), "OPTIONS {path}");
        assert_eq!(
            response.header("content-type"),
            Some(HTML),
            "OPTIONS {path}"
        );
        assert_eq!(response.text(), allow, "OPTIONS {path} body");
    }
    // Literal segments match case-insensitively (the `/api/` mount prefix is
    // compared literally, as in every migrated cluster).
    let upper = gateway.options("/api/EVENTS/CATALOG/");
    assert_eq!(upper.status, 200);
    assert_eq!(upper.header("allow"), Some("GET,HEAD"));
    // Only the trigger paths run the `publicSessionAccessGuard` first.
    let guarded: Vec<Value> = gateway.guard_calls();
    assert!(!guarded.is_empty());
    assert!(guarded
        .iter()
        .all(|call| call["method"] == json!("OPTIONS")));
    // An unregistered path is not ours: it falls through to the Node child
    // (the fixture's plain-text fallback), never to this cluster's responder.
    let unknown = gateway.options("/api/events");
    assert_eq!(unknown.status, 200);
    assert_eq!(unknown.text(), "ok");
    assert_eq!(unknown.header("allow"), None);
}

#[test]
fn options_for_an_internal_slot_is_the_same_404() {
    let gateway = Gateway::start("options-internal");
    gateway.internal_slot("slot-1");
    for url in [
        "/api/sessions/slot-1/triggers",
        "/api/sessions/slot-1/triggers/t1",
        "/api/sessions/slot-1/triggers/t1/test",
    ] {
        let response = gateway.options(url);
        assert_eq!(response.status, 404, "OPTIONS {url}");
        assert_eq!(
            response.json(),
            json!({ "error": "session not found" }),
            "OPTIONS {url}"
        );
        assert_eq!(response.header("allow"), None, "OPTIONS {url}");
    }
}

// ── reads ──────────────────────────────────────────────────────────────────

#[test]
fn catalog_is_pure_and_keeps_the_retired_key_order() {
    let gateway = Gateway::start("catalog");
    let response = gateway.get("/api/events/catalog");
    assert_eq!(response.status, 200);
    assert_eq!(response.header("content-type"), Some(JSON));
    let text = response.text();
    order(
        &text,
        &["\"events\"", "\"aliases\"", "\"actions\"", "\"clis\""],
    );
    let body = response.json();
    let clis: Vec<&str> = body["clis"]
        .as_array()
        .unwrap()
        .iter()
        .map(|cli| cli.as_str().unwrap())
        .collect();
    assert!(clis.contains(&"claude"));
    assert!(
        !clis.contains(&"claude-exp"),
        "aliases are filtered: {clis:?}"
    );
    assert_eq!(
        body["actions"],
        json!(["inject-prompt", "webhook", "notify", "channel"])
    );
    assert_eq!(body["events"][0], json!("task.running"));
    assert_eq!(
        body["aliases"]["task.attention"],
        json!(["task.needs_interaction", "task.waiting_user", "task.failed"])
    );
    // No host state was needed, so nothing was asked of it.
    assert!(gateway.host_calls().is_empty());
    // HEAD is the GET branch with its body dropped.
    let head = gateway.head("/api/events/catalog");
    assert_eq!(head.status, 200);
    assert!(head.raw_body.is_empty());
    // A weak ETag and the conditional 304 behave like Express.
    let etag = response.etag();
    let not_modified = gateway.get_with("/api/events/catalog", &[("If-None-Match", &etag)]);
    assert_eq!(not_modified.status, 304);
    assert!(not_modified.raw_body.is_empty());
}

#[test]
fn recent_passes_the_clamped_limit_to_the_host() {
    let gateway = Gateway::start("recent");
    gateway.world(
        json!({ "recent": { "events": [{ "eventId": "e1" }], "runs": [], "chains": [] } }),
        json!({}),
    );
    let response = gateway.get("/api/events/recent");
    assert_eq!(response.status, 200);
    assert_eq!(
        response.json(),
        json!({ "events": [{ "eventId": "e1" }], "runs": [], "chains": [] })
    );
    order(&response.text(), &["\"events\"", "\"runs\"", "\"chains\""]);

    let cases = [
        ("/api/events/recent?limit=500", 200),
        ("/api/events/recent?limit=abc", 50),
        ("/api/events/recent?limit=0", 1),
        ("/api/events/recent?limit=3abc", 3),
        ("/api/events/recent?limit=-4", 1),
    ];
    for (url, limit) in cases {
        let response = gateway.get(url);
        assert_eq!(response.status, 200, "{url}");
        let calls = gateway.host_calls();
        assert_eq!(
            calls.last(),
            Some(&json!({ "op": "recent", "limit": limit })),
            "{url}"
        );
    }
    // HEAD never reaches the host with a body of its own.
    let head = gateway.head("/api/events/recent");
    assert_eq!(head.status, 200);
    assert!(head.raw_body.is_empty());
}

#[test]
fn list_reads_wrap_the_host_answers() {
    let gateway = Gateway::start("lists");
    let items = json!([{ "id": "t1", "type": "post-turn" }]);
    let rules = json!([{ "id": "r1", "type": "event" }]);
    gateway.world(json!({ "list-all": items, "rules-list": rules }), json!({}));
    let triggers = gateway.get("/api/event-triggers");
    assert_eq!(triggers.status, 200);
    assert_eq!(triggers.json(), json!({ "items": items }));
    let event_rules = gateway.get("/api/event-rules");
    assert_eq!(event_rules.status, 200);
    assert_eq!(event_rules.json(), json!({ "rules": rules }));
    assert_eq!(
        gateway.host_calls(),
        vec![json!({ "op": "list-all" }), json!({ "op": "rules-list" })]
    );
    // HEAD on both.
    assert_eq!(gateway.head("/api/event-triggers").status, 200);
    assert_eq!(gateway.head("/api/event-rules").status, 200);
    // A body over the gzip threshold is compressed on GET, not on HEAD.
    let big = "x".repeat(4000);
    gateway.world(json!({ "list-all": [{ "id": big }] }), json!({}));
    let compressed = gateway.get_with("/api/event-triggers", &[("Accept-Encoding", "gzip")]);
    assert_eq!(compressed.status, 200);
    assert_eq!(compressed.header("content-encoding"), Some("gzip"));
    let body: Value = serde_json::from_str(&compressed.gunzip()).unwrap();
    assert_eq!(body["items"][0]["id"], json!(big));
    let head = gateway.head("/api/event-triggers");
    assert_eq!(head.header("content-encoding"), None);
}

// ── global event rules ─────────────────────────────────────────────────────

#[test]
fn rules_post_walks_the_retired_decision_tree() {
    let gateway = Gateway::start("rules-post");
    // 1. The global table limit is read before validation.
    gateway.world(
        json!({ "rules-state": { "count": 100, "id": "u", "createdAt": "t" } }),
        json!({}),
    );
    let full = gateway.post("/api/event-rules", Some("{}"));
    assert_eq!(full.status, 400);
    assert_eq!(full.json(), json!({ "error": "too many global rules" }));
    assert_eq!(gateway.host_calls(), vec![json!({ "op": "rules-state" })]);

    // 2. Schema refusals never mutate anything.
    gateway.world(
        json!({ "rules-state": { "count": 0, "id": "u", "createdAt": "t" } }),
        json!({}),
    );
    gateway.truncate_logs();
    let empty = gateway.post("/api/event-rules", Some("{}"));
    assert_eq!(empty.status, 400);
    assert_eq!(
        empty.json(),
        json!({ "error": "on requires 1-10 event patterns" })
    );
    let unknown = gateway.post("/api/event-rules", Some("{\"on\":[\"bogus.event\"]}"));
    assert_eq!(unknown.status, 400);
    assert_eq!(
        unknown.json(),
        json!({ "error": "unknown event pattern: bogus.event" })
    );
    assert_eq!(
        gateway.host_calls(),
        vec![
            json!({ "op": "rules-state" }),
            json!({ "op": "rules-state" })
        ]
    );

    // 3. A channel action owes the recipient check before the write.
    gateway.world(
        json!({
            "rules-state": { "count": 0, "id": "u", "createdAt": "t" },
            "check-channels": { "problem": "channel recipient is not installed" },
        }),
        json!({}),
    );
    gateway.truncate_logs();
    let refused = gateway.post(
        "/api/event-rules",
        Some("{\"on\":[\"task.done\"],\"action\":{\"kind\":\"channel\",\"plugin\":\"p\",\"target\":\"t\"}}"),
    );
    assert_eq!(refused.status, 400);
    assert_eq!(
        refused.json(),
        json!({ "error": "channel recipient is not installed" })
    );
    assert_eq!(
        gateway.host_calls(),
        vec![
            json!({ "op": "rules-state" }),
            json!({ "op": "check-channels", "rule": {
                "id": "u", "type": "event", "scope": "global", "name": "", "enabled": true,
                "once": false, "on": ["task.done"], "filter": {},
                "action": { "kind": "channel", "plugin": "p", "target": "t", "message": "" },
                "then": [], "cooldownMs": 0, "mode": "inject", "createdAt": "t",
            }}),
        ]
    );

    // 4. Success uses the id/createdAt the host generated with the count.
    let expected = json!({
        "id": "uuid-1",
        "type": "event",
        "scope": "global",
        "name": "n",
        "enabled": true,
        "once": false,
        "on": ["task.done"],
        "filter": {},
        "action": { "kind": "inject-prompt", "prompt": "go" },
        "then": [],
        "cooldownMs": 60_000,
        "mode": "inject",
        "createdAt": "2026-01-01T00:00:00.000Z",
    });
    gateway.world(
        json!({
            "rules-state": { "count": 2, "id": "uuid-1", "createdAt": "2026-01-01T00:00:00.000Z" },
            "rules-add": {},
        }),
        json!({}),
    );
    gateway.truncate_logs();
    let created = gateway.post(
        "/api/event-rules",
        Some("{\"on\":[\"task.done\"],\"name\":\"n\",\"action\":{\"kind\":\"inject-prompt\",\"prompt\":\"go\"}}"),
    );
    assert_eq!(created.status, 200, "{}", created.text());
    assert_eq!(created.header("content-type"), Some(JSON));
    assert_eq!(created.json(), expected);
    order(
        &created.text(),
        &[
            "\"id\"",
            "\"type\"",
            "\"scope\"",
            "\"name\"",
            "\"enabled\"",
            "\"once\"",
            "\"on\"",
            "\"filter\"",
            "\"action\"",
            "\"then\"",
            "\"cooldownMs\"",
            "\"mode\"",
            "\"createdAt\"",
        ],
    );
    assert_eq!(
        gateway.host_calls(),
        vec![
            json!({ "op": "rules-state" }),
            json!({ "op": "rules-add", "rule": expected }),
        ]
    );
}

#[test]
fn rule_put_merges_onto_the_stored_rule_and_keeps_stamps() {
    let gateway = Gateway::start("rules-put");
    let old = json!({
        "id": "r1",
        "type": "event",
        "scope": "global",
        "name": "old",
        "enabled": true,
        "once": false,
        "on": ["task.done"],
        "filter": {},
        "action": { "kind": "inject-prompt", "prompt": "old" },
        "then": [],
        "cooldownMs": 60_000,
        "mode": "inject",
        "createdAt": "2026-01-01T00:00:00.000Z",
        "lastFiredAt": "2026-02-01T00:00:00.000Z",
        "firedAt": "2026-02-01T00:00:00.000Z",
    });
    gateway.world(
        json!({ "rules-get": { "found": true, "rule": old }, "rules-replace": { "found": true } }),
        json!({}),
    );
    let response = gateway.put("/api/event-rules/r1", Some("{\"name\":\"new\"}"));
    assert_eq!(response.status, 200, "{}", response.text());
    let body = response.json();
    assert_eq!(body["name"], json!("new"));
    assert_eq!(body["createdAt"], json!("2026-01-01T00:00:00.000Z"));
    assert_eq!(body["lastFiredAt"], json!("2026-02-01T00:00:00.000Z"));
    assert_eq!(body["firedAt"], json!("2026-02-01T00:00:00.000Z"));
    assert_eq!(body["action"]["prompt"], json!("old"));
    let calls = gateway.host_calls();
    assert_eq!(calls[0], json!({ "op": "rules-get", "id": "r1" }));
    assert_eq!(calls[1]["op"], json!("rules-replace"));
    assert_eq!(calls[1]["id"], json!("r1"));
    assert_eq!(calls[1]["rule"], body);

    // The id is decoded exactly like an Express param.
    let sparse = gateway.put("/api/event-rules/r%201", Some("{\"name\":\"new\"}"));
    assert_eq!(sparse.status, 200, "{}", sparse.text());
    let calls = gateway.host_calls();
    assert_eq!(
        calls[calls.len() - 2],
        json!({ "op": "rules-get", "id": "r 1" })
    );
    // A malformed escape is the Express 400, before the host is asked.
    let before = gateway.host_calls().len();
    let malformed = gateway.put("/api/event-rules/%E0%A4%A", Some("{}"));
    assert_eq!(malformed.status, 400);
    assert_eq!(malformed.json()["code"], json!("request_error"));
    assert_eq!(gateway.host_calls().len(), before);

    // A missing rule is a 404 and writes nothing.
    gateway.world(json!({ "rules-get": { "found": false } }), json!({}));
    gateway.truncate_logs();
    let missing = gateway.put("/api/event-rules/nope", Some("{\"name\":\"x\"}"));
    assert_eq!(missing.status, 404);
    assert_eq!(missing.json(), json!({ "error": "not found" }));
    assert_eq!(
        gateway.host_calls(),
        vec![json!({ "op": "rules-get", "id": "nope" })]
    );

    // Validation failures on the merged body never reach rules-replace.
    gateway.world(
        json!({ "rules-get": { "found": true, "rule": old } }),
        json!({}),
    );
    gateway.truncate_logs();
    let invalid = gateway.put("/api/event-rules/r1", Some("{\"on\":[]}"));
    assert_eq!(invalid.status, 400);
    assert_eq!(
        invalid.json(),
        json!({ "error": "on requires 1-10 event patterns" })
    );
    assert_eq!(
        gateway.host_calls(),
        vec![json!({ "op": "rules-get", "id": "r1" })]
    );

    // A rule that vanished between the read and the write is the same 404.
    gateway.world(
        json!({ "rules-get": { "found": true, "rule": old }, "rules-replace": { "found": false } }),
        json!({}),
    );
    let raced = gateway.put("/api/event-rules/r1", Some("{\"name\":\"new\"}"));
    assert_eq!(raced.status, 404);
    assert_eq!(raced.json(), json!({ "error": "not found" }));
}

#[test]
fn rule_delete_reports_the_removal() {
    let gateway = Gateway::start("rules-delete");
    gateway.world(json!({ "rules-remove": { "removed": true } }), json!({}));
    let deleted = gateway.delete("/api/event-rules/r1");
    assert_eq!(deleted.status, 200);
    assert_eq!(deleted.json(), json!({ "ok": true }));
    assert_eq!(
        gateway.host_calls(),
        vec![json!({ "op": "rules-remove", "id": "r1" })]
    );
    gateway.world(json!({ "rules-remove": { "removed": false } }), json!({}));
    let missing = gateway.delete("/api/event-rules/r2");
    assert_eq!(missing.status, 404);
    assert_eq!(missing.json(), json!({ "error": "not found" }));
}

#[test]
fn events_test_emits_through_the_host_only_for_a_known_type() {
    let gateway = Gateway::start("events-test");
    gateway.world(json!({ "emit": { "eventId": "ev1" } }), json!({}));
    let unknown = gateway.post("/api/events/test", Some("{\"type\":\"bogus\"}"));
    assert_eq!(unknown.status, 400);
    assert_eq!(unknown.json(), json!({ "error": "unknown event type" }));
    // The alias is a subscription pattern, not an emittable type.
    let alias = gateway.post("/api/events/test", Some("{\"type\":\"task.done\"}"));
    assert_eq!(alias.status, 400);
    assert_eq!(alias.json(), json!({ "error": "unknown event type" }));
    let empty = gateway.post("/api/events/test", Some("{}"));
    assert_eq!(empty.status, 400);
    assert!(gateway.host_calls().is_empty());

    gateway.truncate_logs();
    let emitted = gateway.post(
        "/api/events/test",
        Some("{\"type\":\"task.achieved\",\"sessionId\":\"s1\",\"goal\":\"g\",\"goalState\":\"achieved\"}"),
    );
    assert_eq!(emitted.status, 200, "{}", emitted.text());
    assert_eq!(emitted.json(), json!({ "ok": true, "eventId": "ev1" }));
    order(&emitted.text(), &["\"ok\"", "\"eventId\""]);
    assert_eq!(
        gateway.host_calls(),
        vec![json!({
            "op": "emit",
            "event": {
                "type": "task.achieved",
                "sessionId": "s1",
                "goal": "g",
                "goalState": "achieved",
            },
            "type": "task.achieved",
        })]
    );

    // Defaults for a bare emit, and a refused emit serializes `null`.
    gateway.world(json!({ "emit": {} }), json!({}));
    gateway.truncate_logs();
    let bare = gateway.post("/api/events/test", Some("{\"type\":\"task.achieved\"}"));
    assert_eq!(bare.status, 200);
    assert_eq!(bare.json(), json!({ "ok": true, "eventId": null }));
    assert_eq!(
        gateway.host_calls(),
        vec![json!({
            "op": "emit",
            "event": { "type": "task.achieved", "sessionId": null, "goal": "test event", "goalState": null },
            "type": "task.achieved",
        })]
    );
}

// ── session triggers ───────────────────────────────────────────────────────

#[test]
fn trigger_routes_404_an_internal_slot_before_any_business_logic() {
    let gateway = Gateway::start("trigger-internal");
    gateway.internal_slot("slot-1");
    let cases = [
        ("GET", "/api/sessions/slot-1/triggers", None),
        ("POST", "/api/sessions/slot-1/triggers", Some("{}")),
        ("PUT", "/api/sessions/slot-1/triggers/t1", Some("{}")),
        ("DELETE", "/api/sessions/slot-1/triggers/t1", None),
        ("POST", "/api/sessions/slot-1/triggers/t1/test", None),
    ];
    for (method, url, body) in cases {
        let response = gateway.exchange(method, url, body, &[]);
        assert_eq!(response.status, 404, "{method} {url}: {}", response.text());
        assert_eq!(
            response.json(),
            json!({ "error": "session not found" }),
            "{method} {url}"
        );
    }
    // The guard ran for every attempt; no events op was asked of the host,
    // and no side effect happened.
    let guarded = gateway.guard_calls();
    assert_eq!(guarded.len(), 5, "{guarded:?}");
    assert!(guarded.iter().all(|call| call["id"] == json!("slot-1")));
    assert!(
        gateway.host_calls().is_empty(),
        "{:?}",
        gateway.host_calls()
    );

    // A missing session is the same 404 for GET/POST but "not found" for the
    // three :tid routes, exactly like the retired handlers.
    gateway.world(json!({}), json!({}));
    let missing_list = gateway.get("/api/sessions/none/triggers");
    assert_eq!(missing_list.status, 404);
    assert_eq!(missing_list.json(), json!({ "error": "session not found" }));
    let missing_post = gateway.post("/api/sessions/none/triggers", Some("{}"));
    assert_eq!(missing_post.json(), json!({ "error": "session not found" }));
    for (method, url, body) in [
        ("PUT", "/api/sessions/none/triggers/t1", Some("{}")),
        ("DELETE", "/api/sessions/none/triggers/t1", None),
        ("POST", "/api/sessions/none/triggers/t1/test", None),
    ] {
        let response = gateway.exchange(method, url, body, &[]);
        assert_eq!(response.status, 404, "{method} {url}");
        assert_eq!(response.json(), json!({ "error": "not found" }));
    }
    assert!(gateway.host_calls().is_empty());
}

#[test]
fn triggers_get_returns_the_stored_list() {
    let gateway = Gateway::start("triggers-get");
    let triggers = json!([{ "id": "t1", "type": "post-turn" }]);
    gateway.record("s1", triggers.clone());
    let response = gateway.get("/api/sessions/s1/triggers");
    assert_eq!(response.status, 200);
    assert_eq!(response.json(), json!({ "triggers": triggers }));
    assert_eq!(
        gateway.guard_calls(),
        vec![json!({ "op": "guard-record", "id": "s1", "method": "GET" })]
    );
    assert!(gateway.host_calls().is_empty());
    let head = gateway.head("/api/sessions/s1/triggers");
    assert_eq!(head.status, 200);
    assert!(head.raw_body.is_empty());
    // A record without a list answers an empty array.
    gateway.record("s2", Value::Null);
    let none = gateway.get("/api/sessions/s2/triggers");
    assert_eq!(none.json(), json!({ "triggers": [] }));
}

#[test]
fn triggers_post_validates_then_persists_once() {
    let gateway = Gateway::start("triggers-post");
    let events = json!({
        "identity": { "id": "u2", "createdAt": "2026-03-01T00:00:00.000Z" },
        "trigger-add": {},
    });
    gateway.world(events.clone(), json!({
        "guard-record:s1": { "record": { "id": "s1", "triggers": [] }, "internal": false, "taskStateWritable": true },
    }));
    let created = gateway.post(
        "/api/sessions/s1/triggers",
        Some("{\"type\":\"post-turn\",\"prompt\":\"go\"}"),
    );
    assert_eq!(created.status, 200, "{}", created.text());
    let expected = json!({
        "id": "u2",
        "type": "post-turn",
        "enabled": true,
        "prompt": "go",
        "cooldownMs": 30_000,
        "mode": "inject",
        "createdAt": "2026-03-01T00:00:00.000Z",
    });
    assert_eq!(created.json(), expected);
    order(
        &created.text(),
        &[
            "\"id\"",
            "\"type\"",
            "\"enabled\"",
            "\"prompt\"",
            "\"cooldownMs\"",
            "\"mode\"",
            "\"createdAt\"",
        ],
    );
    assert_eq!(
        gateway.host_calls(),
        vec![
            json!({ "op": "identity" }),
            json!({ "op": "trigger-add", "id": "s1", "trigger": expected, "label": "每轮结束" }),
        ]
    );

    // An unknown type is refused after the identity round trip, before any
    // persistence.
    gateway.truncate_logs();
    let invalid = gateway.post("/api/sessions/s1/triggers", Some("{\"type\":\"bogus\"}"));
    assert_eq!(invalid.status, 400);
    assert_eq!(invalid.json(), json!({ "error": "invalid type" }));
    assert_eq!(gateway.host_calls(), vec![json!({ "op": "identity" })]);

    // A schedule trigger asks the host's cron parser before persisting.
    gateway.world(
        json!({
            "identity": { "id": "u2", "createdAt": "t" },
            "cron-validate": { "valid": false },
        }),
        json!({
            "guard-record:s1": { "record": { "id": "s1", "triggers": [] }, "internal": false, "taskStateWritable": true },
        }),
    );
    gateway.truncate_logs();
    let bad_cron = gateway.post(
        "/api/sessions/s1/triggers",
        Some("{\"type\":\"schedule\",\"cron\":\"nope\"}"),
    );
    assert_eq!(bad_cron.status, 400);
    assert_eq!(
        bad_cron.json(),
        json!({ "error": "invalid cron expression" })
    );
    assert_eq!(
        gateway.host_calls(),
        vec![
            json!({ "op": "identity" }),
            json!({ "op": "cron-validate", "expression": "nope" }),
        ]
    );

    gateway.world(
        json!({
            "identity": { "id": "u2", "createdAt": "t" },
            "cron-validate": { "valid": true },
            "trigger-add": {},
        }),
        json!({
            "guard-record:s1": { "record": { "id": "s1", "triggers": [] }, "internal": false, "taskStateWritable": true },
        }),
    );
    gateway.truncate_logs();
    let scheduled = gateway.post(
        "/api/sessions/s1/triggers",
        Some("{\"type\":\"schedule\",\"cron\":\"0 9 * * *\"}"),
    );
    assert_eq!(scheduled.status, 200, "{}", scheduled.text());
    assert_eq!(scheduled.json()["cron"], json!("0 9 * * *"));
    assert_eq!(
        gateway.host_calls()[..2],
        [
            json!({ "op": "identity" }),
            json!({ "op": "cron-validate", "expression": "0 9 * * *" }),
        ]
    );
    assert_eq!(gateway.host_calls()[2]["op"], json!("trigger-add"));
    assert_eq!(gateway.host_calls()[2]["label"], json!("定时 0 9 * * *"));

    // An event trigger with a channel action is checked before persisting.
    gateway.world(
        json!({
            "identity": { "id": "u2", "createdAt": "t" },
            "check-channels": { "problem": "no such channel" },
        }),
        json!({
            "guard-record:s1": { "record": { "id": "s1", "triggers": [] }, "internal": false, "taskStateWritable": true },
        }),
    );
    gateway.truncate_logs();
    let refused = gateway.post(
        "/api/sessions/s1/triggers",
        Some("{\"type\":\"event\",\"on\":[\"task.done\"],\"action\":{\"kind\":\"channel\",\"plugin\":\"p\",\"target\":\"t\"}}"),
    );
    assert_eq!(refused.status, 400);
    assert_eq!(refused.json(), json!({ "error": "no such channel" }));
    assert_eq!(
        gateway
            .host_calls()
            .iter()
            .map(|call| call["op"].clone())
            .collect::<Vec<_>>(),
        vec![json!("identity"), json!("check-channels")]
    );

    // The write may discover the session went away meanwhile.
    gateway.world(
        json!({
            "identity": { "id": "u2", "createdAt": "t" },
            "trigger-add": { "missing": true },
        }),
        json!({
            "guard-record:s1": { "record": { "id": "s1", "triggers": [] }, "internal": false, "taskStateWritable": true },
        }),
    );
    let gone = gateway.post(
        "/api/sessions/s1/triggers",
        Some("{\"type\":\"post-turn\"}"),
    );
    assert_eq!(gone.status, 404);
    assert_eq!(gone.json(), json!({ "error": "session not found" }));
}

#[test]
fn trigger_put_replaces_one_trigger() {
    let gateway = Gateway::start("trigger-put");
    let old = json!({
        "id": "t1",
        "type": "post-turn",
        "enabled": true,
        "prompt": "old",
        "cooldownMs": 30_000,
        "mode": "inject",
        "createdAt": "2026-01-01T00:00:00.000Z",
        "lastFiredAt": "2026-02-01T00:00:00.000Z",
        "firedAt": "2026-02-01T00:00:00.000Z",
    });
    gateway.world(
        json!({
            "identity": { "id": "u2", "createdAt": "t" },
            "trigger-replace": {},
        }),
        json!({
            "guard-record:s1": { "record": { "id": "s1", "triggers": [old] }, "internal": false, "taskStateWritable": true },
        }),
    );
    let response = gateway.put("/api/sessions/s1/triggers/t1", Some("{\"prompt\":\"new\"}"));
    assert_eq!(response.status, 200, "{}", response.text());
    let body = response.json();
    assert_eq!(body["prompt"], json!("new"));
    assert_eq!(body["id"], json!("t1"));
    assert_eq!(body["createdAt"], json!("2026-01-01T00:00:00.000Z"));
    assert_eq!(body["lastFiredAt"], json!("2026-02-01T00:00:00.000Z"));
    assert_eq!(body["firedAt"], json!("2026-02-01T00:00:00.000Z"));
    assert_eq!(
        gateway.host_calls(),
        vec![
            json!({ "op": "identity" }),
            json!({ "op": "trigger-replace", "id": "s1", "tid": "t1", "trigger": body }),
        ]
    );

    // A record without an array of triggers is the same `not found`, before
    // anything is decoded or asked of the host.
    gateway.record("s2", Value::Null);
    let before = gateway.host_calls().len();
    let bare = gateway.put("/api/sessions/s2/triggers/t1", Some("{}"));
    assert_eq!(bare.status, 404);
    assert_eq!(bare.json(), json!({ "error": "not found" }));
    assert_eq!(gateway.host_calls().len(), before);

    // An unknown tid is distinguished from a missing session.
    gateway.world(json!({ "identity": { "id": "u2", "createdAt": "t" } }), json!({
        "guard-record:s1": { "record": { "id": "s1", "triggers": [old] }, "internal": false, "taskStateWritable": true },
    }));
    gateway.truncate_logs();
    let missing = gateway.put("/api/sessions/s1/triggers/t9", Some("{}"));
    assert_eq!(missing.status, 404);
    assert_eq!(missing.json(), json!({ "error": "trigger not found" }));
    assert!(gateway.host_calls().is_empty());

    // The host's replacement may refuse (the trigger vanished meanwhile).
    gateway.world(
        json!({
            "identity": { "id": "u2", "createdAt": "t" },
            "trigger-replace": { "error": "trigger not found" },
        }),
        json!({
            "guard-record:s1": { "record": { "id": "s1", "triggers": [old] }, "internal": false, "taskStateWritable": true },
        }),
    );
    let raced = gateway.put("/api/sessions/s1/triggers/t1", Some("{\"prompt\":\"new\"}"));
    assert_eq!(raced.status, 404);
    assert_eq!(raced.json(), json!({ "error": "trigger not found" }));
}

#[test]
fn trigger_delete_and_test_have_no_other_side_effects() {
    let gateway = Gateway::start("trigger-delete-test");
    let event = json!({ "id": "t2", "type": "event", "on": ["task.done"] });
    let post_turn = json!({
        "id": "t1", "type": "post-turn", "enabled": false, "prompt": "x",
        "cooldownMs": 30_000, "mode": "inject", "createdAt": "t",
    });
    gateway.world(
        json!({ "trigger-delete": { "error": "trigger not found" } }),
        json!({
            "guard-record:s1": { "record": { "id": "s1", "triggers": [post_turn, event] }, "internal": false, "taskStateWritable": true },
        }),
    );
    let missing = gateway.delete("/api/sessions/s1/triggers/t9");
    assert_eq!(missing.status, 404);
    assert_eq!(missing.json(), json!({ "error": "trigger not found" }));
    assert_eq!(
        gateway.host_calls(),
        vec![json!({ "op": "trigger-delete", "id": "s1", "tid": "t9" })]
    );

    gateway.world(
        json!({ "trigger-delete": {} }),
        json!({
            "guard-record:s1": { "record": { "id": "s1", "triggers": [post_turn, event] }, "internal": false, "taskStateWritable": true },
        }),
    );
    gateway.truncate_logs();
    let deleted = gateway.delete("/api/sessions/s1/triggers/t1");
    assert_eq!(deleted.status, 200);
    assert_eq!(deleted.json(), json!({ "ok": true }));
    assert_eq!(
        gateway.host_calls(),
        vec![json!({ "op": "trigger-delete", "id": "s1", "tid": "t1" })]
    );

    // Event triggers must use /api/events/test.
    gateway.truncate_logs();
    let refused = gateway.post("/api/sessions/s1/triggers/t2/test", None);
    assert_eq!(refused.status, 400);
    assert_eq!(
        refused.json(),
        json!({ "error": "use POST /api/events/test for event rules" })
    );
    assert!(gateway.host_calls().is_empty());

    // A manual run forces enabled and cooldownMs 0, then fires exactly once.
    gateway.world(
        json!({ "trigger-test": {} }),
        json!({
            "guard-record:s1": { "record": { "id": "s1", "triggers": [post_turn, event] }, "internal": false, "taskStateWritable": true },
        }),
    );
    gateway.truncate_logs();
    let fired = gateway.post("/api/sessions/s1/triggers/t1/test", None);
    assert_eq!(fired.status, 200, "{}", fired.text());
    assert_eq!(fired.json(), json!({ "ok": true }));
    let calls = gateway.host_calls();
    assert_eq!(calls.len(), 1, "{calls:?}");
    assert_eq!(calls[0]["op"], json!("trigger-test"));
    assert_eq!(calls[0]["id"], json!("s1"));
    assert_eq!(calls[0]["trigger"]["id"], json!("t1"));
    assert_eq!(calls[0]["trigger"]["enabled"], json!(true));
    assert_eq!(calls[0]["trigger"]["cooldownMs"], json!(0));
}

// ── annotation-live ────────────────────────────────────────────────────────

#[test]
fn annotation_live_reads_the_config_and_relays_the_normalized_payload() {
    let gateway = Gateway::start("annotation");
    gateway.world(
        json!({ "annotation-get": { "config": "/tmp/annotation-live.json", "targets": [{ "url": "http://127.0.0.1:1/a" }] } }),
        json!({}),
    );
    let config = gateway.get("/api/annotation-live");
    assert_eq!(config.status, 200);
    assert_eq!(
        config.json(),
        json!({ "config": "/tmp/annotation-live.json", "targets": [{ "url": "http://127.0.0.1:1/a" }] })
    );
    order(&config.text(), &["\"config\"", "\"targets\""]);
    // This is a plain config read: one round trip, no long wait.
    assert_eq!(
        gateway.host_calls(),
        vec![json!({ "op": "annotation-get" })]
    );

    gateway.world(
        json!({ "annotation-relay": { "relayed": 1, "results": [{ "ok": true, "refresh": false, "text": "done" }] } }),
        json!({}),
    );
    gateway.truncate_logs();
    let relayed = gateway.post(
        "/api/annotation-live",
        Some("{\"sessionId\":\"s1\",\"src\":\"shot.png\",\"width\":\"12\",\"height\":null,\"kind\":\"box\",\"a\":{\"x\":1},\"b\":0}"),
    );
    assert_eq!(relayed.status, 200, "{}", relayed.text());
    assert_eq!(
        relayed.json(),
        json!({ "ok": true, "relayed": 1, "results": [{ "ok": true, "refresh": false, "text": "done" }] })
    );
    order(&relayed.text(), &["\"ok\"", "\"relayed\"", "\"results\""]);
    assert_eq!(
        gateway.host_calls(),
        vec![json!({
            "op": "annotation-relay",
            "payload": {
                "sessionId": "s1",
                "src": "shot.png",
                "width": 12,
                "height": 0,
                "kind": "box",
                "a": { "x": 1 },
                "b": null,
            },
        })]
    );
    let calls = fs::read_to_string(gateway.state.join("events-calls.jsonl")).unwrap();
    order(
        calls.lines().last().unwrap(),
        &[
            "\"sessionId\"",
            "\"src\"",
            "\"width\"",
            "\"height\"",
            "\"kind\"",
            "\"a\"",
            "\"b\"",
        ],
    );

    // JS `Number(x)` semantics: Infinity cannot be serialized, so it is null.
    gateway.truncate_logs();
    let infinite = gateway.post("/api/annotation-live", Some("{\"width\":\"1e999\"}"));
    assert_eq!(infinite.status, 200);
    assert_eq!(
        gateway.host_calls()[0]["payload"],
        json!({ "sessionId": "", "src": "", "width": null, "height": 0, "kind": "", "a": null, "b": null })
    );

    // HEAD is the GET branch.
    gateway.world(
        json!({ "annotation-get": { "config": "", "targets": [] } }),
        json!({}),
    );
    let head = gateway.head("/api/annotation-live");
    assert_eq!(head.status, 200);
    assert!(head.raw_body.is_empty());
}

// ── host unavailable ───────────────────────────────────────────────────────

#[test]
fn an_unreachable_host_is_the_documented_503() {
    let gateway = Gateway::start("host-down");
    gateway.host_down();
    let cases: [(&str, &str, Option<&str>); 8] = [
        ("GET", "/api/events/recent", None),
        ("GET", "/api/event-triggers", None),
        ("GET", "/api/event-rules", None),
        ("POST", "/api/event-rules", Some("{}")),
        ("PUT", "/api/event-rules/r1", Some("{}")),
        ("DELETE", "/api/event-rules/r1", None),
        (
            "POST",
            "/api/events/test",
            Some("{\"type\":\"task.achieved\"}"),
        ),
        ("GET", "/api/annotation-live", None),
    ];
    for (method, url, body) in cases {
        let response = gateway.exchange(method, url, body, &[]);
        assert_unavailable(&response);
    }
    // A rule POST reads the count first, so it never reaches validation.
    let trigger = gateway.get("/api/sessions/s1/triggers");
    assert_unavailable(&trigger);
    // Pure routes keep answering.
    let catalog = gateway.get("/api/events/catalog");
    assert_eq!(catalog.status, 200);
    let options = gateway.options("/api/events/catalog");
    assert_eq!(options.status, 200);
}
