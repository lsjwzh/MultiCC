//! Integration coverage for the sixteen docs / memory / memo / directory-events
//! routes against the real `multicc-gateway` binary:
//!
//!   GET|HEAD /api/docs-registry         POST     /api/docs-registry
//!   PATCH    /api/docs-registry/:id     DELETE   /api/docs-registry/:id
//!   POST     /api/docs-registry/:id/start
//!   POST     /api/docs-registry/:id/stop
//!   GET|HEAD /api/docs-registry/:id/log
//!   GET|HEAD /api/memory/graph          GET|HEAD /api/memory/tree
//!   GET|HEAD /api/memory/file           PUT      /api/memory/file
//!   DELETE   /api/memory/file
//!   GET|HEAD /api/directories/:id/memo  PUT      /api/directories/:id/memo
//!   POST     /api/directories/:id/memo/send
//!   GET|HEAD /api/directories/:id/events
//!
//! The Node process here is only the protocol fixture (PROXY v1 + auth
//! control): it answers `POST /api/__host/docs-memory` from
//! `script.docsMemory.ops[op]` (appending every payload to
//! `docs-memory-calls.jsonl`) and every unclaimed path from its plain-text
//! fallback. Path matching (case-insensitive literals, one optional trailing
//! slash, automatic OPTIONS), parameter decoding, query/body reads, the memo
//! error envelope, the memory-store `rel` verdict, the DTO envelopes and their
//! key order, ETag/304/gzip and the 503 surface are Rust and are what these
//! tests assert. The byte comparison against the frozen Node handlers lives in
//! docs/rust-migration/differential/docs-memory-routes.js.

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
const TEXT: &str = "text/plain; charset=utf-8";
const UNAVAILABLE: &str = "文档与记忆接口尚未就绪，请更新原生模块";
const INVALID_REL: &str = "invalid rel (must be a *.md under the memory store)";

fn unique(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "multicc-gateway-docs-memory-{}-{tag}-{nanos}",
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
            json!({ "docsMemory": { "ops": {} } }).to_string(),
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

    /// Script every `docs-memory` host op in one world.
    fn world(&self, ops: Value) {
        self.set_script(json!({ "docsMemory": { "ops": ops } }));
    }

    fn host_down(&self) {
        self.set_script(json!({ "docsMemory": { "hostDown": true } }));
    }

    /// Every `POST /api/__host/docs-memory` body the fixture received, in order.
    fn host_calls(&self) -> Vec<Value> {
        fs::read_to_string(self.state.join("docs-memory-calls.jsonl"))
            .unwrap_or_default()
            .lines()
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn ops_called(&self) -> Vec<String> {
        self.host_calls()
            .iter()
            .map(|call| call["op"].as_str().unwrap_or("").to_string())
            .collect()
    }

    fn truncate_calls(&self) {
        let _ = fs::remove_file(self.state.join("docs-memory-calls.jsonl"));
    }

    /// Wait until the fixture has recorded `op` (a fire-and-forget host call).
    fn wait_for_op(&self, op: &str) {
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if self.ops_called().iter().any(|name| name == op) {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("{op} was never recorded: {:?}", self.ops_called());
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
    fn patch(&self, url: &str, body: Option<&str>) -> Response {
        self.exchange("PATCH", url, body, &[])
    }
    fn delete(&self, url: &str, body: Option<&str>) -> Response {
        self.exchange("DELETE", url, body, &[])
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

fn entry(id: &str, title: &str, url: &str) -> Value {
    json!({
        "id": id,
        "title": title,
        "url": url,
        "kind": "page",
        "source": "agent",
        "createdAt": "2026-01-01T00:00:00.000Z",
    })
}

/// The host facts for a two-entry world, in `docs-facts` array form.
fn facts(session_dir: Value, exists: Value, task_title: Value) -> Value {
    json!({ "sessionDir": session_dir, "exists": exists, "taskTitle": task_title })
}

fn list_world(entries: Value, order: Value, retained: Value, facts: Value) -> Value {
    json!({
        "docs-list": { "entries": entries, "order": order, "retained": retained },
        "docs-facts": facts,
    })
}

// ── Express's automatic OPTIONS ─────────────────────────────────────────────

#[test]
fn options_answers_every_registered_path() {
    let gateway = Gateway::start("options");
    let cases = [
        ("/api/directories/d1/events", "GET,HEAD"),
        ("/api/directories/d1/memo", "GET,HEAD,PUT"),
        ("/api/directories/d1/memo/send", "POST"),
        ("/api/memory/graph", "GET,HEAD"),
        ("/api/memory/tree", "GET,HEAD"),
        ("/api/memory/file", "GET,HEAD,PUT,DELETE"),
        ("/api/docs-registry", "GET,HEAD,POST"),
        ("/api/docs-registry/d1", "PATCH,DELETE"),
        ("/api/docs-registry/d1/start", "POST"),
        ("/api/docs-registry/d1/stop", "POST"),
        ("/api/docs-registry/d1/log", "GET,HEAD"),
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
    // Literal segments match case-insensitively; one trailing slash is fine.
    let upper = gateway.options("/api/MEMORY/FILE/");
    assert_eq!(upper.status, 200);
    assert_eq!(upper.header("allow"), Some("GET,HEAD,PUT,DELETE"));
    // An unregistered path is not ours: it falls through to the Node child's
    // plain-text fallback, never to this cluster's responder.
    for path in ["/api/memory", "/api/docs-registry/d1/log/x"] {
        let response = gateway.options(path);
        assert_eq!(response.status, 200, "OPTIONS {path}");
        assert_eq!(response.text(), "ok", "OPTIONS {path}");
        assert_eq!(response.header("allow"), None, "OPTIONS {path}");
    }
    let empty_segment = gateway.options("/api/docs-registry//log");
    assert_eq!(empty_segment.text(), "ok");
    assert!(gateway.host_calls().is_empty());
}

// ── docs registry ──────────────────────────────────────────────────────────

#[test]
fn docs_list_keeps_fields_and_the_host_ordering() {
    let gateway = Gateway::start("docs-list");
    let pinned = json!({
        "id": "d0", "title": "Pinned", "url": "/docs/pinned", "kind": "page",
        "createdAt": "2026-01-01T00:00:00.000Z", "pinned": true,
    });
    let task = json!({
        "id": "d1", "title": "Task", "url": "https://x.test/a", "kind": "page",
        "createdAt": "2026-01-02T00:00:00.000Z",
        "sessionId": "task-0123456789abcdef0123456789abcdef",
    });
    gateway.world(list_world(
        json!([pinned, task]),
        json!([1, 0]),
        json!([]),
        facts(
            json!([Value::Null, "/p/one/"]),
            json!([Value::Null, Value::Null]),
            json!([Value::Null, "任务甲"]),
        ),
    ));
    let response = gateway.get("/api/docs-registry");
    assert_eq!(response.status, 200);
    assert_eq!(response.header("content-type"), Some(JSON));
    let text = response.text();
    order(
        &text,
        &[
            "\"artifactId\":null",
            "\"taskId\":\"tsk_0123456789abcdef0123456789abcdef\"",
            "\"taskTitle\":\"任务甲\"",
            "\"retained\":false",
            "\"permanent\":false",
            "\"dir\":\"/p/one\"",
            "\"dirName\":\"one\"",
            "\"id\":\"d0\"",
            "\"dir\":null",
            "\"dirName\":\"\"",
        ],
    );
    let body = response.json();
    let views = body.as_array().unwrap();
    assert_eq!(views.len(), 2);
    assert_eq!(views[0]["id"], json!("d1"));
    assert_eq!(views[0]["artifactId"], Value::Null);
    assert_eq!(views[0]["dirName"], json!("one"));
    assert_eq!(views[1]["id"], json!("d0"));
    assert_eq!(views[1]["pinned"], json!(true));
    assert_eq!(views[1]["dir"], Value::Null);
    // The host answered the permutation and the fact batch exactly once each.
    assert_eq!(gateway.ops_called(), vec!["docs-list", "docs-facts"]);
    let calls = gateway.host_calls();
    assert_eq!(
        calls[1]["items"][1],
        json!({
            "sessionId": "task-0123456789abcdef0123456789abcdef",
            "artifactId": null,
            "taskId": "tsk_0123456789abcdef0123456789abcdef",
        })
    );
}

#[test]
fn docs_list_scopes_by_normalized_directory() {
    let gateway = Gateway::start("docs-scope");
    let one =
        json!({ "id": "d0", "title": "One", "url": "/docs/one", "kind": "page", "dir": "/p/one/" });
    let two =
        json!({ "id": "d1", "title": "Two", "url": "/docs/two", "kind": "page", "dir": "/p/two" });
    gateway.world(list_world(
        json!([one, two]),
        json!([0, 1]),
        json!([]),
        facts(
            json!([Value::Null, Value::Null]),
            json!([Value::Null, Value::Null]),
            json!([Value::Null, Value::Null]),
        ),
    ));
    let scoped = gateway.get("/api/docs-registry?dir=/p/one/");
    assert_eq!(scoped.status, 200);
    assert_eq!(scoped.json().as_array().unwrap().len(), 1);
    assert_eq!(scoped.json()[0]["id"], json!("d0"));
    // A worktree path groups under its project.
    let worktree = gateway.get("/api/docs-registry?dir=/p/one/.multicc-worktrees/task-abc");
    assert_eq!(worktree.json().as_array().unwrap().len(), 1);
    // A scoped request that cannot be normalized answers [], never everything.
    assert_eq!(
        gateway.get("/api/docs-registry?dir=relative").json(),
        json!([])
    );
    assert_eq!(gateway.get("/api/docs-registry?dir=").json(), json!([]));
}

#[test]
fn docs_register_prefills_and_validates_before_the_host_write() {
    let gateway = Gateway::start("docs-register");
    gateway.world(json!({
        "docs-task-id": { "taskId": "tsk_1" },
        "docs-dir": { "dir": "/p/one" },
        "docs-register": {
            "entry": {
                "id": "d9", "title": "T", "url": "/docs/new", "kind": "page",
                "source": "agent", "sessionId": "s1", "taskId": "tsk_1", "dir": "/p/one",
            },
            "created": true,
        },
        "docs-list": { "entries": [], "order": [], "retained": [] },
        "docs-facts": facts(json!([Value::Null]), json!([Value::Null]), json!([Value::Null])),
    }));
    let response = gateway.post(
        "/api/docs-registry",
        Some(&json!({ "title": "T", "url": "/docs/new", "sessionId": "s1" }).to_string()),
    );
    assert_eq!(response.status, 201, "{}", response.text());
    assert_eq!(response.json()["id"], json!("d9"));
    assert_eq!(
        gateway.ops_called(),
        vec![
            "docs-task-id",
            "docs-dir",
            "docs-register",
            "docs-facts",
            "docs-list"
        ]
    );
    let calls = gateway.host_calls();
    assert_eq!(calls[0]["sessionId"], json!("s1"));
    assert_eq!(calls[1]["sessionId"], json!("s1"));
    // The sanitized entry the front door hands the host.
    assert_eq!(
        calls[2]["entry"],
        json!({
            "title": "T", "url": "/docs/new", "sessionId": "s1",
            "taskId": "tsk_1", "dir": "/p/one", "kind": "page", "source": "agent",
        })
    );
    // The fact batch is built from the post-sanitize view inputs.
    assert_eq!(
        calls[3]["items"],
        json!([{ "sessionId": "s1", "artifactId": null, "taskId": "tsk_1" }])
    );

    // A missing title never reaches the host write.
    gateway.truncate_calls();
    let invalid = gateway.post(
        "/api/docs-registry",
        Some(&json!({ "url": "/docs/x" }).to_string()),
    );
    assert_eq!(invalid.status, 400);
    assert_eq!(invalid.json(), json!({ "error": "title is required" }));
    assert!(gateway.ops_called().iter().all(|op| op != "docs-register"));

    // A host refusal is a 400 with its message.
    gateway.world(json!({
        "docs-register": { "error": "registry is full (all entries permanent)" },
    }));
    gateway.truncate_calls();
    let refused = gateway.post(
        "/api/docs-registry",
        Some(&json!({ "title": "T", "url": "/docs/new" }).to_string()),
    );
    assert_eq!(refused.status, 400);
    assert_eq!(
        refused.json(),
        json!({ "error": "registry is full (all entries permanent)" })
    );

    // Upsert (created false) is a 200.
    gateway.world(json!({
        "docs-register": {
            "entry": { "id": "d9", "title": "T", "url": "/docs/new", "kind": "page" },
            "created": false,
        },
        "docs-list": { "entries": [], "order": [], "retained": [] },
        "docs-facts": facts(json!([Value::Null]), json!([Value::Null]), json!([Value::Null])),
    }));
    let updated = gateway.post(
        "/api/docs-registry",
        Some(&json!({ "title": "T", "url": "/docs/new" }).to_string()),
    );
    assert_eq!(updated.status, 200);

    // An absolute URL is normalized by the host's WHATWG parser.
    gateway.world(json!({
        "docs-clean-url": { "href": "https://example.test/x" },
        "docs-register": {
            "entry": { "id": "d10", "title": "T", "url": "https://example.test/x", "kind": "page" },
            "created": true,
        },
        "docs-list": { "entries": [], "order": [], "retained": [] },
        "docs-facts": facts(json!([Value::Null]), json!([Value::Null]), json!([Value::Null])),
    }));
    gateway.truncate_calls();
    let absolute = gateway.post(
        "/api/docs-registry",
        Some(&json!({ "title": "T", "url": " https://Example.test:443/x " }).to_string()),
    );
    assert_eq!(absolute.status, 201, "{}", absolute.text());
    let calls = gateway.host_calls();
    let clean = calls
        .iter()
        .find(|call| call["op"] == json!("docs-clean-url"))
        .expect("the host URL verdict was asked");
    assert_eq!(clean["url"], json!("https://Example.test:443/x"));
    let register = calls
        .iter()
        .find(|call| call["op"] == json!("docs-register"))
        .expect("the register write was forwarded");
    assert_eq!(register["entry"]["url"], json!("https://example.test/x"));
}

#[test]
fn docs_patch_merges_validates_and_maps_not_found() {
    let gateway = Gateway::start("docs-patch");
    let stored = json!({
        "id": "d1", "title": "Old", "url": "/docs/old", "kind": "page",
        "note": "keep", "createdAt": "2026-01-01T00:00:00.000Z",
    });
    gateway.world(json!({
        "docs-get": { "found": true, "entry": stored },
        "docs-replace": { "found": true },
        "docs-list": { "entries": [], "order": [], "retained": [] },
        "docs-facts": facts(json!([Value::Null]), json!([Value::Null]), json!([Value::Null])),
    }));
    let response = gateway.patch(
        "/api/docs-registry/d1",
        Some(&json!({ "title": "New", "pinned": true }).to_string()),
    );
    assert_eq!(response.status, 200, "{}", response.text());
    let body = response.json();
    assert_eq!(body["title"], json!("New"));
    assert_eq!(body["note"], json!("keep"));
    assert_eq!(body["pinned"], json!(true));
    assert_eq!(body["artifactId"], Value::Null);
    assert_eq!(body["id"], json!("d1"));
    assert!(body["updatedAt"].as_str().unwrap().ends_with('Z'));
    let text = response.text();
    order(
        &text,
        &["\"note\":\"keep\"", "\"artifactId\":null", "\"updatedAt\":"],
    );
    let calls = gateway.host_calls();
    assert_eq!(calls[0]["op"], json!("docs-get"));
    assert_eq!(calls[0]["id"], json!("d1"));
    assert_eq!(calls[1]["op"], json!("docs-replace"));
    assert_eq!(calls[1]["id"], json!("d1"));
    assert_eq!(calls[1]["entry"]["title"], json!("New"));
    assert!(calls[1]["entry"]["updatedAt"].is_string());

    // Unknown id: 404 before any write.
    gateway.world(json!({ "docs-get": { "found": false, "entry": null } }));
    gateway.truncate_calls();
    let missing = gateway.patch("/api/docs-registry/nope", Some("{}"));
    assert_eq!(missing.status, 404);
    assert_eq!(missing.json(), json!({ "error": "entry not found" }));
    assert_eq!(gateway.ops_called(), vec!["docs-get"]);

    // Invalid merge: 400 before any write.
    gateway.world(json!({
        "docs-get": { "found": true, "entry": stored },
    }));
    gateway.truncate_calls();
    let invalid = gateway.patch(
        "/api/docs-registry/d1",
        Some(&json!({ "title": "" }).to_string()),
    );
    assert_eq!(invalid.status, 400);
    assert_eq!(invalid.json(), json!({ "error": "title is required" }));

    // A malformed percent escape is Express's param decode error.
    let malformed = gateway.patch("/api/docs-registry/%E0%A4%A", Some("{}"));
    assert_eq!(malformed.status, 400);
    assert_eq!(malformed.json()["code"], json!("request_error"));
}

#[test]
fn docs_delete_returns_the_removed_view() {
    let gateway = Gateway::start("docs-delete");
    gateway.world(json!({
        "docs-delete": {
            "found": true,
            "removed": { "id": "d1", "title": "Gone", "url": "/docs/gone", "kind": "page" },
        },
        "docs-list": { "entries": [], "order": [], "retained": [] },
        "docs-facts": facts(json!([Value::Null]), json!([Value::Null]), json!([Value::Null])),
    }));
    let response = gateway.delete("/api/docs-registry/d1", None);
    assert_eq!(response.status, 200, "{}", response.text());
    let text = response.text();
    order(
        &text,
        &[
            "\"ok\":true",
            "\"removed\"",
            "\"id\":\"d1\"",
            "\"dirName\":\"\"",
        ],
    );
    assert_eq!(response.json()["removed"]["title"], json!("Gone"));
    assert_eq!(
        gateway.ops_called(),
        vec!["docs-delete", "docs-facts", "docs-list"]
    );

    gateway.world(json!({ "docs-delete": { "found": false, "removed": null } }));
    let missing = gateway.delete("/api/docs-registry/nope", None);
    assert_eq!(missing.status, 404);
    assert_eq!(missing.json(), json!({ "error": "entry not found" }));
}

#[test]
fn start_and_stop_pass_the_service_lifecycle_through() {
    let gateway = Gateway::start("docs-service");
    let running = json!({
        "id": "svc1", "title": "Dev", "url": "http://127.0.0.1:5173/", "kind": "service",
        "status": "starting", "startCmd": "npm run dev",
    });
    gateway.world(json!({
        "docs-start": { "entry": running },
        "docs-list": { "entries": [], "order": [], "retained": [] },
        "docs-facts": facts(json!([Value::Null]), json!([Value::Null]), json!([Value::Null])),
    }));
    let started = gateway.post("/api/docs-registry/svc1/start", Some("{}"));
    assert_eq!(started.status, 200, "{}", started.text());
    assert_eq!(started.json()["status"], json!("starting"));
    // The retired handler kicked the probe loop after answering.
    gateway.wait_for_op("docs-probe-kick");
    assert_eq!(
        gateway.ops_called(),
        vec!["docs-start", "docs-facts", "docs-list", "docs-probe-kick"]
    );

    gateway.world(json!({ "docs-start": { "error": "already running", "status": 409 } }));
    let conflict = gateway.post("/api/docs-registry/svc1/start", Some("{}"));
    assert_eq!(conflict.status, 409);
    assert_eq!(conflict.json(), json!({ "error": "already running" }));

    gateway.world(json!({ "docs-start": { "error": "no startCmd registered — cannot start", "status": 400 } }));
    let no_command = gateway.post("/api/docs-registry/svc1/start", Some("{}"));
    assert_eq!(no_command.status, 400);
    assert_eq!(
        no_command.json(),
        json!({ "error": "no startCmd registered — cannot start" })
    );

    // A refusal without a status is the 500 default.
    gateway.world(json!({ "docs-start": { "error": "spawn failed" } }));
    let failed = gateway.post("/api/docs-registry/svc1/start", Some("{}"));
    assert_eq!(failed.status, 500);
    assert_eq!(failed.json(), json!({ "error": "spawn failed" }));

    let stopped = json!({
        "id": "svc1", "title": "Dev", "url": "http://127.0.0.1:5173/", "kind": "service",
        "status": "down",
    });
    gateway.world(json!({
        "docs-stop": { "entry": stopped },
        "docs-list": { "entries": [], "order": [], "retained": [] },
        "docs-facts": facts(json!([Value::Null]), json!([Value::Null]), json!([Value::Null])),
    }));
    gateway.truncate_calls();
    let stopping = gateway.post("/api/docs-registry/svc1/stop", Some("{}"));
    assert_eq!(stopping.status, 200, "{}", stopping.text());
    assert_eq!(stopping.json()["status"], json!("down"));
    assert_eq!(
        gateway.ops_called(),
        vec!["docs-stop", "docs-facts", "docs-list"]
    );

    gateway.world(
        json!({ "docs-stop": { "error": "no known pid — nothing to stop", "status": 409 } }),
    );
    let nothing = gateway.post("/api/docs-registry/svc1/stop", Some("{}"));
    assert_eq!(nothing.status, 409);
    assert_eq!(
        nothing.json(),
        json!({ "error": "no known pid — nothing to stop" })
    );

    // Non-lifecycle paths never kick the probe loop.
    gateway.world(list_world(
        json!([]),
        json!([]),
        json!([]),
        facts(json!([]), json!([]), json!([])),
    ));
    gateway.truncate_calls();
    assert_eq!(gateway.get("/api/docs-registry").status, 200);
    assert_eq!(
        gateway.patch("/api/docs-registry/d1", Some("{}")).status,
        404
    );
    assert!(gateway
        .ops_called()
        .iter()
        .all(|op| op != "docs-probe-kick"));
}

#[test]
fn docs_log_is_plain_text_with_the_retired_fallbacks() {
    let gateway = Gateway::start("docs-log");
    gateway.world(json!({ "docs-log": { "found": true, "text": "listening on 5173\n" } }));
    let response = gateway.get("/api/docs-registry/svc1/log");
    assert_eq!(response.status, 200);
    assert_eq!(response.header("content-type"), Some(TEXT));
    assert_eq!(response.text(), "listening on 5173\n");
    let calls = gateway.host_calls();
    assert_eq!(calls[0]["op"], json!("docs-log"));
    assert_eq!(calls[0]["id"], json!("svc1"));

    gateway.world(json!({ "docs-log": { "found": true, "text": "" } }));
    let empty = gateway.get("/api/docs-registry/svc1/log");
    assert_eq!(empty.text(), "(no log yet)");

    gateway.world(json!({ "docs-log": { "found": false, "text": "" } }));
    let missing = gateway.get("/api/docs-registry/nope/log");
    assert_eq!(missing.status, 404);
    assert_eq!(missing.json(), json!({ "error": "entry not found" }));

    // HEAD is the GET branch without a body.
    gateway.world(json!({ "docs-log": { "found": true, "text": "tail\n" } }));
    let head = gateway.head("/api/docs-registry/svc1/log");
    assert_eq!(head.status, 200);
    assert!(head.raw_body.is_empty());
    assert_eq!(head.header("content-length"), Some("5"));
}

// ── memory browser ────────────────────────────────────────────────────────

#[test]
fn memory_graph_and_tree_keep_the_retired_envelopes() {
    let gateway = Gateway::start("memory-graph");
    gateway.world(json!({
        "memory-graph": {
            "data": {
                "nodes": [{ "id": "n1", "kind": "file" }],
                "edges": [{ "from": "n1", "to": "n2" }],
                "projects": [{ "dirId": "d1", "files": 1 }],
                "truncated": true,
            },
            "durationMs": 7,
        },
        "memory-tree": {
            "data": { "files": [{ "rel": "a.md" }], "meta": { "dirCount": 1 } },
            "durationMs": 3,
        },
    }));
    let response = gateway.get("/api/memory/graph");
    assert_eq!(response.status, 200);
    let text = response.text();
    order(
        &text,
        &[
            "\"nodes\"",
            "\"edges\"",
            "\"meta\"",
            "\"dirId\":\"all\"",
            "\"projects\"",
            "\"nodeCount\":1",
            "\"edgeCount\":1",
            "\"truncated\":true",
            "\"maxNodes\":600",
            "\"durationMs\":7",
        ],
    );
    let scoped = gateway.get("/api/memory/graph?dirId=d1");
    assert_eq!(scoped.json()["meta"]["dirId"], json!("d1"));
    let empty = gateway.get("/api/memory/graph?dirId=");
    assert_eq!(empty.json()["meta"]["dirId"], json!("all"));

    let tree = gateway.get("/api/memory/tree");
    assert_eq!(tree.status, 200);
    let tree_text = tree.text();
    order(
        &tree_text,
        &[
            "\"files\"",
            "\"meta\"",
            "\"dirCount\":1",
            "\"durationMs\":3",
        ],
    );

    gateway.world(json!({ "memory-graph": { "error": "graph build failed" } }));
    let failed = gateway.get("/api/memory/graph");
    assert_eq!(failed.status, 500);
    assert_eq!(failed.json(), json!({ "error": "graph build failed" }));

    gateway.world(json!({ "memory-tree": { "error": "tree build failed" } }));
    let tree_failed = gateway.get("/api/memory/tree");
    assert_eq!(tree_failed.status, 500);
    assert_eq!(tree_failed.json(), json!({ "error": "tree build failed" }));
}

#[test]
fn memory_file_paths_are_judged_in_rust_before_the_host_touches_the_disk() {
    let gateway = Gateway::start("memory-paths");
    // Innocent facts: only the requested `rel` differs, so a rejection here is
    // the front door's own traversal verdict, never the scripted host.
    let innocent = json!({
        "root": "/store",
        "resolved": "/store/a.md",
        "rootReal": "/store",
        "ancestorReal": "/store",
        "exists": true,
        "parentExists": true,
        "name": "a.md",
    });
    let bad = [
        "../a.md",
        "p/../../a.md",
        "/etc/a.md",
        "p//a.md",
        "p/./a.md",
        "p\\a.md",
        "a.md%00",
        "a.txt",
        "p/..",
        "%2e%2e%2fa.md",
    ];
    for rel in bad {
        gateway.world(json!({
            "memory-resolve": innocent,
            "memory-read": { "valid": true, "exists": true, "abs": "/store/a.md", "name": "a.md", "content": "x", "mtime": Value::Null },
        }));
        let response = gateway.get(&format!("/api/memory/file?rel={rel}"));
        assert_eq!(response.status, 400, "rel {rel} -> {}", response.text());
        assert_eq!(
            response.json(),
            json!({ "error": INVALID_REL }),
            "rel {rel}"
        );
    }
    // An empty rel never resolves.
    gateway.world(json!({ "memory-resolve": innocent }));
    assert_eq!(gateway.get("/api/memory/file").status, 400);
    // None of those requests reached a file operation.
    assert!(
        gateway.ops_called().iter().all(|op| op == "memory-resolve"),
        "{:?}",
        gateway.ops_called()
    );

    // Facts-based rejections over a well-formed rel.
    let fact_cases = [
        json!({ "root": "/store", "resolved": "/store2/a.md", "rootReal": "/store", "ancestorReal": "/store", "exists": true, "parentExists": true, "name": "a.md" }),
        json!({ "root": "/store", "resolved": "/store", "rootReal": "/store", "ancestorReal": "/store", "exists": true, "parentExists": true, "name": "a.md" }),
        json!({ "root": "/store", "resolved": "/store/a.md", "rootReal": Value::Null, "ancestorReal": "/store", "exists": true, "parentExists": true, "name": "a.md" }),
        json!({ "root": "/store", "resolved": "/store/a.md", "rootReal": "/store", "ancestorReal": "/etc", "exists": true, "parentExists": true, "name": "a.md" }),
    ];
    for answer in fact_cases {
        gateway.world(json!({
            "memory-resolve": answer,
            "memory-read": { "valid": true, "exists": true, "abs": "/store/a.md", "name": "a.md", "content": "x", "mtime": Value::Null },
        }));
        assert_eq!(gateway.get("/api/memory/file?rel=a.md").status, 400);
    }
    assert!(gateway.ops_called().iter().all(|op| op == "memory-resolve"));

    // A valid, existing file is read and assembled into the retired DTO.
    gateway.world(json!({
        "memory-resolve": innocent,
        "memory-read": {
            "valid": true, "exists": true, "abs": "/store/a.md", "name": "a.md",
            "content": "# Hi", "mtime": "2026-01-01T00:00:00.000Z",
        },
    }));
    let response = gateway.get("/api/memory/file?rel=a.md");
    assert_eq!(response.status, 200, "{}", response.text());
    let text = response.text();
    order(
        &text,
        &[
            "\"rel\":\"a.md\"",
            "\"path\":\"/store/a.md\"",
            "\"name\":\"a.md\"",
            "\"content\":\"# Hi\"",
            "\"size\":4",
            "\"tokens\":",
            "\"mtime\":\"2026-01-01T00:00:00.000Z\"",
        ],
    );
    assert!(response.json()["tokens"].as_i64().unwrap() > 0);

    // A missing file is a 404 and never reaches the read op.
    gateway.world(json!({
        "memory-resolve": {
            "root": "/store", "resolved": "/store/a.md", "rootReal": "/store",
            "ancestorReal": "/store", "exists": false, "parentExists": true, "name": "a.md",
        },
        "memory-read": { "valid": true, "exists": false, "abs": "/store/a.md" },
    }));
    gateway.truncate_calls();
    let missing = gateway.get("/api/memory/file?rel=a.md");
    assert_eq!(missing.status, 404);
    assert_eq!(missing.json(), json!({ "error": "file not found" }));
    assert_eq!(gateway.ops_called(), vec!["memory-resolve"]);
}

#[test]
fn memory_file_writes_and_deletes_validate_first() {
    let gateway = Gateway::start("memory-write");
    let facts_answer = json!({
        "root": "/store", "resolved": "/store/a.md", "rootReal": "/store",
        "ancestorReal": "/store", "exists": false, "parentExists": true, "name": "a.md",
    });
    // Content type / size gates run before any host call.
    gateway.world(json!({ "memory-resolve": facts_answer }));
    gateway.truncate_calls();
    let no_content = gateway.put(
        "/api/memory/file",
        Some(&json!({ "rel": "a.md" }).to_string()),
    );
    assert_eq!(no_content.status, 400);
    assert_eq!(
        no_content.json(),
        json!({ "error": "content (string) required" })
    );
    assert!(gateway.host_calls().is_empty());

    let huge = "a".repeat(200_001);
    let too_long = gateway.put(
        "/api/memory/file",
        Some(&json!({ "rel": "a.md", "content": huge }).to_string()),
    );
    assert_eq!(too_long.status, 413);
    assert_eq!(
        too_long.json(),
        json!({ "error": "content too long (max 200000 chars)" })
    );
    assert!(gateway.host_calls().is_empty());

    // A non-string rel reads as the empty rel and is refused by the verdict.
    gateway.truncate_calls();
    let non_string = gateway.put(
        "/api/memory/file",
        Some(&json!({ "rel": 7, "content": "x" }).to_string()),
    );
    assert_eq!(non_string.status, 400);
    assert_eq!(non_string.json(), json!({ "error": INVALID_REL }));
    assert_eq!(gateway.ops_called(), vec!["memory-resolve"]);

    // A missing parent folder is a 400.
    gateway.world(json!({
        "memory-resolve": {
            "root": "/store", "resolved": "/store/deep/a.md", "rootReal": "/store",
            "ancestorReal": "/store", "exists": false, "parentExists": false, "name": "a.md",
        },
    }));
    gateway.truncate_calls();
    let missing_parent = gateway.put(
        "/api/memory/file",
        Some(&json!({ "rel": "deep/a.md", "content": "x" }).to_string()),
    );
    assert_eq!(missing_parent.status, 400);
    assert_eq!(
        missing_parent.json(),
        json!({ "error": "parent folder does not exist" })
    );
    assert_eq!(gateway.ops_called(), vec!["memory-resolve"]);

    // The happy path answers the write DTO.
    gateway.world(json!({
        "memory-resolve": facts_answer,
        "memory-write": { "valid": true, "parentMissing": false, "abs": "/store/a.md", "mtime": "2026-01-02T00:00:00.000Z" },
    }));
    gateway.truncate_calls();
    let written = gateway.put(
        "/api/memory/file",
        Some(&json!({ "rel": "a.md", "content": "# Hi" }).to_string()),
    );
    assert_eq!(written.status, 200, "{}", written.text());
    let text = written.text();
    order(
        &text,
        &[
            "\"ok\":true",
            "\"rel\":\"a.md\"",
            "\"path\":\"/store/a.md\"",
            "\"size\":4",
            "\"tokens\":",
            "\"mtime\":\"2026-01-02T00:00:00.000Z\"",
        ],
    );
    let calls = gateway.host_calls();
    assert_eq!(calls[1]["op"], json!("memory-write"));
    assert_eq!(calls[1]["rel"], json!("a.md"));
    assert_eq!(calls[1]["content"], json!("# Hi"));

    // DELETE prefers the body rel over the query and answers {ok:true}.
    gateway.world(json!({
        "memory-resolve": facts_answer,
        "memory-delete": { "valid": true },
    }));
    gateway.truncate_calls();
    let deleted = gateway.delete(
        "/api/memory/file?rel=query.md",
        Some(&json!({ "rel": "body.md" }).to_string()),
    );
    assert_eq!(deleted.status, 200, "{}", deleted.text());
    assert_eq!(deleted.json(), json!({ "ok": true }));
    let calls = gateway.host_calls();
    assert_eq!(calls[0]["rel"], json!("body.md"));
    assert_eq!(calls[1]["op"], json!("memory-delete"));
    assert_eq!(calls[1]["rel"], json!("body.md"));

    // Without a body rel the query decides.
    gateway.truncate_calls();
    let from_query = gateway.delete("/api/memory/file?rel=query.md", None);
    assert_eq!(from_query.json(), json!({ "ok": true }));
    assert_eq!(gateway.host_calls()[0]["rel"], json!("query.md"));

    // An invalid rel never reaches the delete op.
    gateway.world(json!({
        "memory-resolve": facts_answer,
        "memory-delete": { "valid": true },
    }));
    gateway.truncate_calls();
    let invalid = gateway.delete(
        "/api/memory/file",
        Some(&json!({ "rel": "../x.md" }).to_string()),
    );
    assert_eq!(invalid.status, 400);
    assert_eq!(invalid.json(), json!({ "error": INVALID_REL }));
    assert_eq!(gateway.ops_called(), vec!["memory-resolve"]);
}

// ── memo + directory events ───────────────────────────────────────────────

#[test]
fn memo_routes_answer_data_and_map_domain_refusals() {
    let gateway = Gateway::start("memo");
    gateway.world(json!({
        "memo-read": { "data": { "path": "/memo/d1/memo.md", "text": "hi", "mtime": 1.5, "exists": true } },
        "memo-write": { "data": { "path": "/memo/d1/memo.md", "mtime": 2.5 } },
        "memo-send": { "data": { "ok": true, "sentTo": "s1" } },
    }));
    let read = gateway.get("/api/directories/d1/memo");
    assert_eq!(read.status, 200, "{}", read.text());
    assert_eq!(
        read.json(),
        json!({ "path": "/memo/d1/memo.md", "text": "hi", "mtime": 1.5, "exists": true })
    );
    let calls = gateway.host_calls();
    assert_eq!(calls[0]["op"], json!("memo-read"));
    assert_eq!(calls[0]["directoryId"], json!("d1"));

    let written = gateway.put(
        "/api/directories/d1/memo",
        Some(&json!({ "text": "note" }).to_string()),
    );
    assert_eq!(written.status, 200);
    assert_eq!(written.json()["mtime"], json!(2.5));
    let calls = gateway.host_calls();
    assert_eq!(calls[1]["op"], json!("memo-write"));
    assert_eq!(calls[1]["directoryId"], json!("d1"));
    assert_eq!(calls[1]["text"], json!("note"));

    let sent = gateway.post(
        "/api/directories/d1/memo/send",
        Some(&json!({ "text": "ping", "sessionId": "s1" }).to_string()),
    );
    assert_eq!(sent.status, 200);
    assert_eq!(sent.json(), json!({ "ok": true, "sentTo": "s1" }));
    let calls = gateway.host_calls();
    assert_eq!(calls[2]["op"], json!("memo-send"));
    assert_eq!(calls[2]["directoryId"], json!("d1"));
    assert_eq!(calls[2]["text"], json!("ping"));
    assert_eq!(calls[2]["sessionId"], json!("s1"));

    // A branded refusal becomes the shared error envelope.
    gateway.world(json!({
        "memo-read": { "refused": { "status": 404, "code": "not_found", "message": "directory not found" } },
    }));
    let refused = gateway.get("/api/directories/nope/memo");
    assert_eq!(refused.status, 404);
    let text = refused.text();
    order(
        &text,
        &[
            "\"ok\":false",
            "\"error\":\"directory not found\"",
            "\"code\":\"not_found\"",
            "\"apiVersion\"",
            "\"requestId\":\"diff-req-1\"",
            "\"correlationId\":\"diff-req-1\"",
        ],
    );

    // A 400 refusal keeps its public message and code.
    gateway.world(json!({
        "memo-write": { "refused": { "status": 400, "code": "invalid_request", "message": "memo too long" } },
    }));
    let too_long = gateway.put(
        "/api/directories/d1/memo",
        Some(&json!({ "text": "x" }).to_string()),
    );
    assert_eq!(too_long.status, 400);
    assert_eq!(too_long.json()["error"], json!("memo too long"));
    assert_eq!(too_long.json()["code"], json!("invalid_request"));

    // The parameter is URL-decoded before the host sees it.
    gateway.truncate_calls();
    let decoded = gateway.get("/api/directories/a%2Fb/memo");
    assert_eq!(decoded.status, 200);
    assert_eq!(gateway.host_calls()[0]["directoryId"], json!("a/b"));
}

#[test]
fn directory_events_reads_the_log_or_404s() {
    let gateway = Gateway::start("notes");
    gateway.world(json!({
        "notes-events": { "found": true, "events": [{ "id": "e1", "type": "note" }] },
    }));
    let response = gateway.get("/api/directories/d1/events");
    assert_eq!(response.status, 200);
    assert_eq!(
        response.json(),
        json!({ "events": [{ "id": "e1", "type": "note" }] })
    );
    let calls = gateway.host_calls();
    assert_eq!(calls[0]["op"], json!("notes-events"));
    assert_eq!(calls[0]["directoryId"], json!("d1"));

    gateway.world(json!({ "notes-events": { "found": false, "events": [] } }));
    let missing = gateway.get("/api/directories/nope/events");
    assert_eq!(missing.status, 404);
    assert_eq!(missing.json(), json!({ "error": "directory not found" }));
}

// ── shared express surface ────────────────────────────────────────────────

#[test]
fn cluster_does_not_shadow_the_other_directory_routes() {
    let gateway = Gateway::start("shadow");
    // session-admin owns /api/directories/:id/sessions and /workspace; those
    // paths are not swallowed by this cluster's `directories/:id` parameters
    // and still answer from their own claim (here: the empty session world).
    for path in [
        "/api/directories/d1/sessions",
        "/api/directories/d1/workspace",
    ] {
        let response = gateway.get(path);
        assert_eq!(response.status, 404, "{path}: {}", response.text());
        assert_eq!(
            response.json(),
            json!({ "error": "directory not found" }),
            "{path}"
        );
    }
    // A GET on a path registered only for PATCH/DELETE also falls through.
    assert_eq!(gateway.get("/api/docs-registry/d1").text(), "ok");
    assert_eq!(gateway.get("/api/memory").text(), "ok");
    assert!(gateway.host_calls().is_empty());
}

#[test]
fn etag_head_and_gzip_follow_the_shared_express_contract() {
    let gateway = Gateway::start("express");
    let mut entries = Vec::new();
    let mut session_dir = Vec::new();
    let mut exists = Vec::new();
    let mut task_title = Vec::new();
    for index in 0..20 {
        entries.push(entry(
            &format!("d{index}"),
            &format!("Entry {index} with a long enough title to exceed one kilobyte"),
            &format!("/docs/{index}-with-a-long-enough-path-to-exceed-one-kilobyte"),
        ));
        session_dir.push(Value::Null);
        exists.push(Value::Null);
        task_title.push(Value::Null);
    }
    gateway.world(list_world(
        json!(entries),
        json!((0..20).collect::<Vec<_>>()),
        json!([]),
        facts(json!(session_dir), json!(exists), json!(task_title)),
    ));
    let plain = gateway.get("/api/docs-registry");
    assert_eq!(plain.status, 200);
    let tag = plain.etag();
    assert!(plain.raw_body.len() >= 1024);

    let head = gateway.head("/api/docs-registry");
    assert_eq!(head.status, 200);
    assert!(head.raw_body.is_empty());
    assert_eq!(
        head.header("content-length"),
        Some(plain.raw_body.len().to_string().as_str())
    );

    let conditional = gateway.get_with("/api/docs-registry", &[("If-None-Match", tag.as_str())]);
    assert_eq!(conditional.status, 304);
    assert!(conditional.raw_body.is_empty());

    let gzipped = gateway.get_with(
        "/api/docs-registry",
        &[("Accept-Encoding", "gzip, deflate")],
    );
    assert_eq!(gzipped.status, 200);
    assert_eq!(gzipped.header("content-type"), Some(JSON));
    let text = gzipped.gunzip();
    assert!(text.len() >= 1024);
    // HEAD is never compressed.
    let gzip_head = gateway.exchange(
        "HEAD",
        "/api/docs-registry",
        None,
        &[("Accept-Encoding", "gzip")],
    );
    assert_eq!(gzip_head.header("content-encoding"), None);
}

#[test]
fn an_unreachable_host_is_the_documented_503() {
    let gateway = Gateway::start("host-down");
    gateway.host_down();
    let cases: [(&str, &str, Option<&str>); 8] = [
        ("GET", "/api/docs-registry", None),
        (
            "POST",
            "/api/docs-registry",
            Some("{\"title\":\"t\",\"url\":\"/x\"}"),
        ),
        ("PATCH", "/api/docs-registry/d1", Some("{}")),
        ("DELETE", "/api/docs-registry/d1", None),
        ("GET", "/api/memory/graph", None),
        ("GET", "/api/memory/file?rel=a.md", None),
        ("GET", "/api/directories/d1/memo", None),
        ("GET", "/api/directories/d1/events", None),
    ];
    for (method, url, body) in cases {
        let response = gateway.exchange(method, url, body, &[]);
        assert_unavailable(&response);
        assert_eq!(
            response.header("content-type"),
            Some(JSON),
            "{method} {url}"
        );
    }
    // Automatic OPTIONS never talks to the host, so it still answers.
    let options = gateway.options("/api/docs-registry");
    assert_eq!(options.status, 200);
    assert_eq!(options.header("allow"), Some("GET,HEAD,POST"));
}
