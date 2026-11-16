#![recursion_limit = "256"]

//! Integration coverage for the plugin cluster retired from
//! `src/routes/plugins.js` and answered by the Rust front door
//! (`native/gateway/src/app/plugins.rs` + `multicc_core::plugin_routes`):
//! `POST /api/channels/recheck` and `GET|HEAD /plugins/:id/*`.
//!
//! The Node process here is only the protocol fixture: it answers
//! `POST /api/__host/plugins` from `FIXTURE_HOST_SCRIPT.plugins` and appends
//! every payload to `plugins-calls.jsonl`, so each test asserts exactly which
//! `findPlugin`/`channelStillActive` calls the front door made and what it
//! rendered from the answers. The plugin tree the fixture's `findPlugin`
//! points at is a real directory (ui subtree, a file outside it, an escaping
//! symlink), because the realpath and containment decisions are the front
//! door's own.
//!
//! `hostDown` drops the internal socket (the `--no-node`/stale-module 503).
//! The locality branch needs a peer that is authenticated but not local:
//! `X-Forwarded-For` makes `isLocalRequest` false while the token satisfies the
//! ordinary gate.

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
const UNAVAILABLE: &str = "插件接口尚未就绪，请更新原生模块";
const FILE_CACHE_CONTROL: &str = "no-store, no-cache, must-revalidate";

fn unique(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "multicc-gateway-plugins-{}-{tag}-{nanos}",
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
    bytes: Vec<u8>,
}

impl Response {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }
    fn body(&self) -> String {
        String::from_utf8_lossy(&self.bytes).into_owned()
    }
    fn json(&self) -> Value {
        serde_json::from_slice(&self.bytes)
            .unwrap_or_else(|_| panic!("JSON response: {}", self.body()))
    }
}

/// One real plugin tree both the front door and the fixture's `findPlugin`
/// point at. Lives in its own temp directory, removed on drop.
struct Tree {
    root: PathBuf,
}

impl Tree {
    fn new(tag: &str) -> Self {
        let root = unique(tag);
        for dir in ["demo/ui/sub", "demo/ui/dir", "flat", "nested/web/app"] {
            fs::create_dir_all(root.join(dir)).unwrap();
        }
        let write = |path: &str, bytes: &[u8]| fs::write(root.join(path), bytes).unwrap();
        write(
            "demo/ui/index.html",
            b"<!doctype html><title>demo zh</title>\n",
        );
        write("demo/ui/app.js", b"console.log(\"app\");\n");
        write("demo/ui/style.CSS", b"body{color:red}\n");
        write("demo/ui/data.json", b"{\"a\":1}\n");
        write(
            "demo/ui/logo.svg",
            b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>\n",
        );
        write(
            "demo/ui/pic.png",
            &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 255],
        );
        write("demo/ui/favicon.ico", &[0, 0, 1, 0, 1, 0]);
        write("demo/ui/archive.bin", &[1, 2, 3, 4]);
        write("demo/ui/noext", b"no extension\n");
        write("demo/ui/empty.txt", b"");
        write("demo/ui/sub/deep.html", b"<p>deep</p>\n");
        write("demo/ui/中文 name.html", b"<p>unicode</p>\n");
        write("demo/ui/app b.js", b"// space\n");
        write(
            "demo/plugin.json",
            b"{\"id\":\"demo\",\"ui\":\"ui/index.html\"}\n",
        );
        write("demo/secret.txt", b"outside the UI subtree\n");
        write("outside.txt", b"outside the plugin dir\n");
        write("flat/index.html", b"<p>flat</p>\n");
        write(
            "flat/plugin.json",
            b"{\"id\":\"flat\",\"ui\":\"index.html\"}\n",
        );
        write("nested/web/app/index.html", b"<p>nested</p>\n");
        write("nested/web/other.js", b"outside the declared ui dir\n");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.join("outside.txt"), root.join("demo/ui/escape.txt"))
                .unwrap();
            std::os::unix::fs::symlink(
                root.join("demo/secret.txt"),
                root.join("demo/ui/to-secret.txt"),
            )
            .unwrap();
            std::os::unix::fs::symlink(root.join("demo/ui/app.js"), root.join("demo/ui/alias.js"))
                .unwrap();
        }
        Self { root }
    }

    fn dir(&self, name: &str) -> String {
        self.root.join(name).to_string_lossy().into_owned()
    }
}

impl Drop for Tree {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn script(tree: &Tree) -> Value {
    json!({
        "plugins": {
            "entries": {
                "demo": { "found": true, "dir": tree.dir("demo"), "ui": "ui/index.html" },
                "flat": { "found": true, "dir": tree.dir("flat"), "ui": "index.html" },
                "nested": { "found": true, "dir": tree.dir("nested"), "ui": "web/app/index.html" },
                // `found:true` for a directory that does not exist: Node's
                // `fs.realpathSync(found.dir)` threw, so the handler 500ed.
                "gone": { "found": true, "dir": tree.dir("no-such-plugin"), "ui": "ui/index.html" },
                // The plugins-host answer for a manifest whose `ui` is a
                // truthy non-string (the retired `path.dirname` TypeError).
                "broken": { "raw": { "ok": false, "error": { "message": "invalid manifest ui" } } },
                // A well-formed `ok` with an unusable field: the front door's
                // own "bad shape" 503.
                "shapeless": { "raw": { "ok": true, "found": true, "dir": 5 } },
            },
            "active": [true, false, true],
        }
    })
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

    /// `Err((log, retryable))`; a bind race on the ephemeral port is retried.
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

    /// Every payload the front door sent the plugin host port.
    fn calls(&self) -> Vec<Value> {
        fs::read_to_string(self.state.join("plugins-calls.jsonl"))
            .unwrap_or_default()
            .lines()
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    /// Whether the protocol fixture (standing in for the whole Node server) saw
    /// this request, that is the front door did not claim it.
    fn forwarded(&self, method: &str, url: &str) -> bool {
        fs::read_to_string(self.state.join("requests.log"))
            .unwrap_or_default()
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .any(|entry| {
                entry["method"].as_str() == Some(method) && entry["url"].as_str() == Some(url)
            })
    }

    fn exchange(
        &self,
        method: &str,
        url: &str,
        extra: &[(&str, &str)],
        body: Option<&[u8]>,
    ) -> Response {
        let payload = body.unwrap_or(b"");
        let mut request = format!(
            "{method} {url} HTTP/1.1\r\nHost: localhost\r\nX-Request-Id: plugins-req-1\r\n"
        );
        let mut has_length = false;
        for (name, value) in extra {
            if name.eq_ignore_ascii_case("content-length")
                || name.eq_ignore_ascii_case("transfer-encoding")
            {
                has_length = true;
            }
            request.push_str(&format!("{name}: {value}\r\n"));
        }
        if body.is_some() && !has_length {
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
            let _ = stream.write_all(payload);
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
            bytes: raw[split + 4..].to_vec(),
        }
    }

    fn get(&self, url: &str, headers: &[(&str, &str)]) -> Response {
        self.exchange("GET", url, headers, None)
    }
    fn head(&self, url: &str, headers: &[(&str, &str)]) -> Response {
        self.exchange("HEAD", url, headers, None)
    }
    fn options(&self, url: &str, headers: &[(&str, &str)]) -> Response {
        self.exchange("OPTIONS", url, headers, None)
    }
    fn post_json(&self, url: &str, headers: &[(&str, &str)], body: &str) -> Response {
        let mut all: Vec<(&str, &str)> = vec![("Content-Type", "application/json")];
        all.extend_from_slice(headers);
        self.exchange("POST", url, &all, Some(body.as_bytes()))
    }
}

impl Drop for Gateway {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.dir);
    }
}

/// Loopback peer with no forwarding headers and a credential: local.
fn local() -> Vec<(&'static str, &'static str)> {
    vec![("X-Access-Token", TOKEN)]
}

/// External peer (`X-Forwarded-For` makes the locality fact false) with a
/// credential: authenticated but not local.
fn external() -> Vec<(&'static str, &'static str)> {
    vec![("X-Forwarded-For", EXTERNAL_IP), ("X-Access-Token", TOKEN)]
}

/// External peer with no credential at all.
fn anonymous() -> Vec<(&'static str, &'static str)> {
    vec![("X-Forwarded-For", EXTERNAL_IP)]
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

fn assert_unavailable(response: &Response) {
    assert_eq!(response.status, 503, "{}", response.body());
    assert_eq!(
        response.header("content-type"),
        Some("application/json; charset=utf-8")
    );
    let body = response.json();
    assert_eq!(body["error"], UNAVAILABLE);
    assert_eq!(body["code"], "rust_backend_unavailable");
}

fn assert_error(response: &Response, status: u16, message: &str) {
    assert_eq!(response.status, status, "{}", response.body());
    assert_eq!(response.json()["error"], message);
}

fn gateway_with_tree(tag: &str) -> (Tree, Gateway) {
    let tree = Tree::new(tag);
    let gateway = Gateway::start(tag, script(&tree));
    (tree, gateway)
}

// ── POST /api/channels/recheck ─────────────────────────────────────────────

#[test]
fn recheck_projects_the_body_and_asks_the_registry_once() {
    let (_tree, gateway) = gateway_with_tree("recheck");
    let response = gateway.post_json(
        "/api/channels/recheck",
        &local(),
        r#"{"items":[
            {"sessionId":"sess-active","category":"attention"},
            {"sessionId":"sess-idle","category":"done"},
            null, 7, "x", true, {"sessionId":11,"category":["x"]}
        ]}"#,
    );
    assert_eq!(response.status, 200, "{}", gateway.log());
    assert_eq!(
        response.header("content-type"),
        Some("application/json; charset=utf-8")
    );
    assert_eq!(response.header("cache-control"), Some("no-store"));
    assert_eq!(
        response.body(),
        r#"{"items":[{"sessionId":"sess-active","category":"attention","active":true},{"sessionId":"sess-idle","category":"done","active":false},{"sessionId":"","category":"","active":true}]}"#
    );
    assert_key_order(&response.body(), &["sessionId", "category", "active"]);

    let calls = gateway.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["op"], "channelStillActive");
    assert_eq!(
        calls[0]["items"],
        json!([
            { "sessionId": "sess-active", "category": "attention" },
            { "sessionId": "sess-idle", "category": "done" },
            { "sessionId": "", "category": "" }
        ])
    );
}

#[test]
fn recheck_never_answers_a_non_local_request() {
    let (_tree, gateway) = gateway_with_tree("recheck-local");
    let response = gateway.post_json("/api/channels/recheck", &external(), r#"{"items":[]}"#);
    assert_error(&response, 403, "只接受本机插件的复核请求");
    // The 403 has no Cache-Control: Node set it only after the locality check.
    assert_eq!(response.header("cache-control"), None);
    assert!(gateway.calls().is_empty(), "no host round trip");
}

#[test]
fn recheck_with_nothing_to_check_is_an_empty_answer_and_no_host_call() {
    let (_tree, gateway) = gateway_with_tree("recheck-empty");
    for body in [r#"{"items":[]}"#, r#"{"items":"nope"}"#, "{}"] {
        let response = gateway.post_json("/api/channels/recheck", &local(), body);
        assert_eq!(response.status, 200, "{body}: {}", gateway.log());
        assert_eq!(response.body(), r#"{"items":[]}"#, "{body}");
        assert_eq!(response.header("cache-control"), Some("no-store"));
    }
    assert!(gateway.calls().is_empty(), "the registry is never asked");
}

#[test]
fn recheck_cuts_session_id_at_128_and_category_at_32_units() {
    let (_tree, gateway) = gateway_with_tree("recheck-cut");
    let session = format!("{}😀tail", "a".repeat(127));
    let category = format!("{}😀", "b".repeat(31));
    let body = json!({ "items": [{ "sessionId": session, "category": category }] });
    let response = gateway.post_json("/api/channels/recheck", &local(), &body.to_string());
    assert_eq!(response.status, 200, "{}", gateway.log());
    let text = response.body();
    // The cut left the high surrogate of the emoji: JSON.stringify escapes it.
    assert!(text.contains("\\ud83d"), "{text}");
    assert!(text.ends_with("\"active\":true}]}"), "{text}");

    // The host call carries the lossy UTF-8 form (U+FFFD) of that lone unit.
    let calls = gateway.calls();
    let sent = calls[0]["items"][0]["sessionId"].as_str().unwrap();
    assert_eq!(sent.chars().count(), 128);
    assert!(sent.ends_with('\u{fffd}'), "{sent:?}");
    assert_eq!(
        calls[0]["items"][0]["category"].as_str().unwrap(),
        "b".repeat(31) + "\u{fffd}"
    );
}

#[test]
fn recheck_looks_at_most_at_the_first_two_hundred_items() {
    let (_tree, gateway) = gateway_with_tree("recheck-limit");
    let items: Vec<Value> = (0..201)
        .map(|index| json!({ "sessionId": format!("s{index}"), "category": "done" }))
        .collect();
    let response = gateway.post_json(
        "/api/channels/recheck",
        &local(),
        &json!({ "items": items }).to_string(),
    );
    assert_eq!(response.status, 200, "{}", gateway.log());
    let body = response.body();
    assert_eq!(body.matches("\"sessionId\":").count(), 200);
    assert!(
        !body.contains("\"s200\""),
        "the 201st item is never looked at"
    );
    assert_eq!(gateway.calls()[0]["items"].as_array().unwrap().len(), 200);
}

#[test]
fn recheck_needs_a_parsable_json_body() {
    let (_tree, gateway) = gateway_with_tree("recheck-body");
    let response = gateway.post_json("/api/channels/recheck", &local(), r#"{"items": ["#);
    assert_eq!(response.status, 400, "{}", response.body());
    let body = response.json();
    assert_eq!(body["error"], "request_error");
    assert_eq!(body["code"], "request_error");

    // `JSON.parse("null")` is rejected by body-parser's strict mode.
    let response = gateway.post_json("/api/channels/recheck", &local(), "null");
    assert_eq!(response.status, 400, "{}", response.body());
    assert!(gateway.calls().is_empty());
}

#[test]
fn recheck_only_answers_its_one_method_and_express_path() {
    let (_tree, gateway) = gateway_with_tree("recheck-unclaimed");
    // GET was never registered.
    let response = gateway.get("/api/channels/recheck", &local());
    assert_eq!(response.status, 200, "{}", response.body());
    assert!(gateway.forwarded("GET", "/api/channels/recheck"));
    // The `/api/` prefix is exact-case in this front door.
    let response = gateway.post_json("/API/channels/recheck", &local(), r#"{"items":[]}"#);
    assert!(gateway.forwarded("POST", "/API/channels/recheck"));
    assert_eq!(response.status, 200, "{}", response.body());
    assert!(gateway.calls().is_empty());

    // Express's automatic OPTIONS answer for the POST route.
    let response = gateway.options("/api/channels/recheck", &local());
    assert_eq!(response.status, 200);
    assert_eq!(response.header("allow"), Some("POST"));
    assert_eq!(
        response.header("content-type"),
        Some("text/html; charset=utf-8")
    );
    assert_eq!(response.body(), "POST");
    assert!(gateway.calls().is_empty());
}

#[test]
fn recheck_host_failure_and_bad_answers_are_the_503() {
    let tree = Tree::new("recheck-down");
    let gateway = Gateway::start("recheck-down", json!({ "plugins": { "hostDown": true } }));
    let response = gateway.post_json(
        "/api/channels/recheck",
        &local(),
        r#"{"items":[{"sessionId":"s","category":"c"}]}"#,
    );
    assert_unavailable(&response);

    // A well-formed `{ok:false}` from the registry is unusable too.
    let gateway = Gateway::start(
        "recheck-refuse",
        json!({ "plugins": { "entries": {}, "activeDown": true } }),
    );
    let response = gateway.post_json(
        "/api/channels/recheck",
        &local(),
        r#"{"items":[{"sessionId":"s","category":"c"}]}"#,
    );
    assert_unavailable(&response);

    // Same length and booleans only.
    let gateway = Gateway::start(
        "recheck-short",
        json!({ "plugins": { "answer": { "ok": true, "active": [true] } } }),
    );
    let response = gateway.post_json(
        "/api/channels/recheck",
        &local(),
        r#"{"items":[{"sessionId":"a","category":"c"},{"sessionId":"b","category":"c"}]}"#,
    );
    assert_unavailable(&response);

    let gateway = Gateway::start(
        "recheck-types",
        json!({ "plugins": { "answer": { "ok": true, "active": ["yes"] } } }),
    );
    let response = gateway.post_json(
        "/api/channels/recheck",
        &local(),
        r#"{"items":[{"sessionId":"a","category":"c"}]}"#,
    );
    assert_unavailable(&response);

    drop(tree);
}

// ── GET|HEAD /plugins/:id/* ────────────────────────────────────────────────

#[test]
fn plugin_files_render_the_mime_table_and_cache_headers() {
    let (_tree, gateway) = gateway_with_tree("files-mime");
    let cases = [
        ("index.html", "text/html; charset=utf-8", "<!doctype html>"),
        ("app.js", "text/javascript; charset=utf-8", "console.log"),
        ("style.CSS", "text/css; charset=utf-8", "body{"),
        ("data.json", "application/json; charset=utf-8", "{\"a\":1}"),
        ("logo.svg", "image/svg+xml", "<svg"),
        (
            "archive.bin",
            "application/octet-stream",
            "\u{1}\u{2}\u{3}\u{4}",
        ),
        ("noext", "application/octet-stream", "no extension"),
        ("empty.txt", "application/octet-stream", ""),
    ];
    for (name, content_type, prefix) in cases {
        let url = format!("/plugins/demo/ui/{name}");
        let response = gateway.get(&url, &local());
        assert_eq!(response.status, 200, "{url}: {}", gateway.log());
        assert_eq!(response.header("content-type"), Some(content_type), "{url}");
        assert_eq!(
            response.header("cache-control"),
            Some(FILE_CACHE_CONTROL),
            "{url}"
        );
        assert!(response.header("etag").is_some(), "{url}");
        assert_eq!(
            response.header("content-length"),
            Some(response.bytes.len().to_string().as_str()),
            "{url}"
        );
        assert_eq!(response.header("x-powered-by"), Some("Express"));
        assert!(
            response.body().starts_with(prefix),
            "{url}: {:?}",
            response.body()
        );
    }
    // Binary bodies are not text: check the PNG start byte and ICO table.
    let png = gateway.get("/plugins/demo/ui/pic.png", &local());
    assert_eq!(png.header("content-type"), Some("image/png"));
    assert_eq!(
        png.bytes,
        [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 255]
    );
    let ico = gateway.get("/plugins/demo/ui/favicon.ico", &local());
    assert_eq!(ico.header("content-type"), Some("image/x-icon"));
}

#[test]
fn plugin_files_answer_head_etag_and_conditional_requests() {
    let (_tree, gateway) = gateway_with_tree("files-conditional");
    let get = gateway.get("/plugins/demo/ui/app.js", &local());
    assert_eq!(get.status, 200);
    let etag = get.header("etag").unwrap().to_string();
    assert!(etag.starts_with("W/\""), "{etag}");

    // HEAD: same headers, no body.
    let head = gateway.head("/plugins/demo/ui/app.js", &local());
    assert_eq!(head.status, 200);
    assert!(head.bytes.is_empty(), "HEAD body: {}", head.body());
    assert_eq!(head.header("etag"), Some(etag.as_str()));
    assert_eq!(head.header("content-length"), get.header("content-length"));
    assert_eq!(head.header("cache-control"), Some(FILE_CACHE_CONTROL));

    // If-None-Match hit: 304 without entity headers, Cache-Control kept.
    let fresh = gateway.get(
        "/plugins/demo/ui/app.js",
        &[("X-Access-Token", TOKEN), ("If-None-Match", etag.as_str())],
    );
    assert_eq!(fresh.status, 304);
    assert!(fresh.bytes.is_empty());
    assert_eq!(fresh.header("content-type"), None);
    assert_eq!(fresh.header("content-length"), None);
    assert_eq!(fresh.header("cache-control"), Some(FILE_CACHE_CONTROL));

    // A miss and `*` (the fresh package treats `*` as a hit without an ETag).
    let miss = gateway.get(
        "/plugins/demo/ui/app.js",
        &[("X-Access-Token", TOKEN), ("If-None-Match", "\"nope\"")],
    );
    assert_eq!(miss.status, 200);
    let star = gateway.get(
        "/plugins/demo/ui/app.js",
        &[("X-Access-Token", TOKEN), ("If-None-Match", "*")],
    );
    assert_eq!(star.status, 304);
}

#[test]
fn plugin_files_keep_the_express_options_answer() {
    let (_tree, gateway) = gateway_with_tree("files-options");
    let response = gateway.options("/plugins/demo/ui/app.js", &local());
    assert_eq!(response.status, 200);
    assert_eq!(response.header("allow"), Some("GET,HEAD"));
    assert_eq!(response.body(), "GET,HEAD");
    assert!(gateway.calls().is_empty(), "OPTIONS never asks the host");
}

#[test]
fn plugin_files_resolve_the_ui_subtree() {
    let (_tree, gateway) = gateway_with_tree("files-tree");
    // Outside the UI subtree, including the manifest and the binary.
    assert_error(
        &gateway.get("/plugins/demo/secret.txt", &local()),
        403,
        "只有 UI 子树可访问",
    );
    assert_error(
        &gateway.get("/plugins/demo/plugin.json", &local()),
        403,
        "只有 UI 子树可访问",
    );
    // The UI directory itself is one separator short.
    assert_error(
        &gateway.get("/plugins/demo/ui/", &local()),
        403,
        "只有 UI 子树可访问",
    );
    // Nested traversals in the path.
    assert_eq!(
        gateway.get("/plugins/demo/ui//app.js", &local()).status,
        200
    );
    assert_eq!(
        gateway.get("/plugins/demo/ui/./app.js", &local()).status,
        200
    );
    assert_eq!(
        gateway
            .get("/plugins/demo/ui/sub%5Cdeep.html", &local())
            .status,
        200
    );
    // Query strings are not part of the path.
    assert_eq!(
        gateway
            .get("/plugins/demo/ui/app.js?v=1&x=2", &local())
            .status,
        200
    );

    // A flat UI root (`ui: index.html`) makes the plugin root the UI tree.
    assert_eq!(
        gateway.get("/plugins/flat/index.html", &local()).status,
        200
    );
    let manifest = gateway.get("/plugins/flat/plugin.json", &local());
    assert_eq!(manifest.status, 200);
    assert_eq!(
        manifest.header("content-type"),
        Some("application/json; charset=utf-8")
    );

    // A nested UI entry (`web/app/index.html`) keeps its own subtree.
    assert_eq!(
        gateway
            .get("/plugins/nested/web/app/index.html", &local())
            .status,
        200
    );
    assert_error(
        &gateway.get("/plugins/nested/web/other.js", &local()),
        403,
        "只有 UI 子树可访问",
    );
}

#[test]
fn plugin_files_refuse_traversal_and_escaping_symlinks() {
    let (_tree, gateway) = gateway_with_tree("files-escape");
    for url in [
        "/plugins/demo/",
        "/plugins/demo/ui/../secret.txt",
        "/plugins/demo/%2e%2e/secret.txt",
        "/plugins/demo/%2e%2e%2fsecret.txt",
        "/plugins/demo/%2fetc/passwd",
        "/plugins/demo//etc/passwd",
        "/plugins/demo/ui/a..b",
    ] {
        let response = gateway.get(url, &local());
        assert_error(&response, 400, "非法路径");
    }
    // A symlink that leaves the plugin directory is outside `root + sep`.
    assert_error(
        &gateway.get("/plugins/demo/ui/escape.txt", &local()),
        400,
        "非法路径",
    );
    // One that leaves only the UI subtree is inside the plugin: 403.
    assert_error(
        &gateway.get("/plugins/demo/ui/to-secret.txt", &local()),
        403,
        "只有 UI 子树可访问",
    );
    // One that stays inside the UI subtree is served.
    let alias = gateway.get("/plugins/demo/ui/alias.js", &local());
    assert_eq!(alias.status, 200, "{}", gateway.log());
    assert_eq!(
        alias.header("content-type"),
        Some("text/javascript; charset=utf-8")
    );
}

#[test]
fn plugin_files_answer_the_not_found_family() {
    let (_tree, gateway) = gateway_with_tree("files-missing");
    // Unknown id: the decoded id is interpolated raw.
    assert_error(
        &gateway.get("/plugins/ghost/ui/index.html", &local()),
        404,
        "插件 ghost 不存在",
    );
    assert_error(
        &gateway.get("/plugins/%E5%B9%BD%E7%81%B5/ui/index.html", &local()),
        404,
        "插件 幽灵 不存在",
    );
    // An id with a slash encoded stays one parameter.
    assert_error(
        &gateway.get("/plugins/de%2Fmo/ui/index.html", &local()),
        404,
        "插件 de/mo 不存在",
    );
    // Missing file, a directory, and a directory with a trailing slash.
    assert_error(
        &gateway.get("/plugins/demo/ui/missing.js", &local()),
        404,
        "文件不存在",
    );
    assert_error(
        &gateway.get("/plugins/demo/ui/dir", &local()),
        404,
        "文件不存在",
    );
    assert_error(
        &gateway.get("/plugins/demo/ui/dir/", &local()),
        404,
        "文件不存在",
    );
    // A malformed percent escape is Express's own 400.
    let response = gateway.get("/plugins/demo/ui/%E0%A4%A", &local());
    assert_eq!(response.status, 400, "{}", response.body());
    assert_eq!(response.json()["error"], "request_error");
}

#[test]
fn plugin_files_decode_names_and_match_the_prefix_case_insensitively() {
    let (_tree, gateway) = gateway_with_tree("files-names");
    let unicode = gateway.get("/plugins/demo/ui/%E4%B8%AD%E6%96%87%20name.html", &local());
    assert_eq!(unicode.status, 200, "{}", gateway.log());
    assert_eq!(
        unicode.header("content-type"),
        Some("text/html; charset=utf-8")
    );
    let space = gateway.get("/plugins/demo/ui/app%20b.js", &local());
    assert_eq!(space.status, 200, "{}", gateway.log());
    assert_eq!(
        space.header("content-type"),
        Some("text/javascript; charset=utf-8")
    );
    // The route literal is case-insensitive in Express.
    assert_eq!(gateway.get("/PLUGINS/demo/ui/app.js", &local()).status, 200);
}

#[test]
fn plugin_files_replay_the_retired_500_and_the_host_failure_503() {
    let (_tree, gateway) = gateway_with_tree("files-broken");
    // `fs.realpathSync(found.dir)` threw in the retired handler.
    let gone = gateway.get("/plugins/gone/ui/index.html", &local());
    assert_eq!(gone.status, 500, "{}", gone.body());
    assert_eq!(
        gone.header("content-type"),
        Some("application/json; charset=utf-8")
    );
    assert_eq!(gone.json()["code"], "internal_error");

    // A manifest `ui` that is a truthy non-string threw `path.dirname`.
    let broken = gateway.get("/plugins/broken/ui/index.html", &local());
    assert_eq!(broken.status, 500, "{}", broken.body());
    assert_eq!(broken.json()["code"], "internal_error");

    // A well-formed `ok` with an unusable `dir` is the front door's 503.
    assert_unavailable(&gateway.get("/plugins/shapeless/ui/index.html", &local()));

    let _ = &gateway.calls();
}

#[test]
fn plugin_files_report_a_dead_host_port_as_the_503() {
    let tree = Tree::new("files-down");
    let gateway = Gateway::start("files-down", json!({ "plugins": { "hostDown": true } }));
    assert_unavailable(&gateway.get("/plugins/demo/ui/app.js", &local()));
    // HEAD gets the same status and entity headers, no body.
    let head = gateway.head("/plugins/demo/ui/app.js", &local());
    assert_eq!(head.status, 503);
    assert!(head.bytes.is_empty());
    assert_eq!(
        head.header("content-type"),
        Some("application/json; charset=utf-8")
    );
    assert_eq!(head.header("content-length"), Some("94"));
    drop(tree);
}

#[test]
fn plugin_files_leave_the_unregistered_shapes_to_node() {
    let (_tree, gateway) = gateway_with_tree("files-unclaimed");
    // path-to-regexp's `/plugins/:id/*` needs the second slash: `/plugins/x`
    // never matched and is not the front door's to answer.
    let response = gateway.get("/plugins/demo", &local());
    assert_eq!(response.status, 200, "{}", response.body());
    assert!(gateway.forwarded("GET", "/plugins/demo"));
    // POST was never registered either.
    let response = gateway.exchange("POST", "/plugins/demo/ui/app.js", &local(), Some(b"{}"));
    assert_eq!(response.status, 200, "{}", response.body());
    assert!(gateway.forwarded("POST", "/plugins/demo/ui/app.js"));
    assert!(gateway.calls().is_empty());
}

/// Node's auth gate skips the login for a static extension
/// (`http_entry::public_path`), so a plugin's scripts and styles never needed a
/// session while its page did. Measured against the retired stack with an
/// anonymous remote client: `app.js` 200, `index.html` the login redirect.
/// (An earlier version of this test asserted 302 for `app.js`, which would have
/// broken every plugin UI that loads its own sub-resources.)
#[test]
fn plugin_files_follow_the_public_path_rule_for_anonymous_clients() {
    let (_tree, gateway) = gateway_with_tree("files-gate");

    // Public extension: no login, the file is served and the host was asked.
    let response = gateway.get("/plugins/demo/ui/app.js", &anonymous());
    assert_eq!(response.status, 200, "{}", response.body());
    assert!(
        !gateway.calls().is_empty(),
        "a public path skips the login, not the plugin lookup"
    );

    // The extension is matched case-insensitively by the shared rule, whatever the
    // file system does with case: a file that does not exist under any spelling
    // is a 404 from the plugin rules, never the login redirect. (`style.CSS` is
    // a real file with that spelling.)
    let response = gateway.get("/plugins/demo/ui/nothing-here.JS", &anonymous());
    assert_eq!(response.status, 404, "{}", response.body());
    let response = gateway.get("/plugins/demo/ui/style.CSS", &anonymous());
    assert_eq!(response.status, 200, "{}", response.body());

    // A page is not a static extension: the HTML login redirect, and the gate
    // refuses before the host is asked.
    let (_tree, gateway) = gateway_with_tree("files-gate-page");
    let response = gateway.get("/plugins/demo/ui/index.html", &anonymous());
    assert_eq!(response.status, 302, "{}", response.body());
    assert_eq!(
        response.header("location"),
        Some("/login?redirect=%2Fplugins%2Fdemo%2Fui%2Findex.html")
    );
    assert!(
        gateway.calls().is_empty(),
        "the gate refuses before the host"
    );
}

/// The exemption is only for the login: a public path still goes through the
/// plugin rules (unknown plugin, traversal, outside the UI subtree).
#[test]
fn a_public_extension_is_still_subject_to_the_plugin_rules() {
    let (_tree, gateway) = gateway_with_tree("files-public-rules");
    let missing = gateway.get("/plugins/ghost/ui/app.js", &anonymous());
    assert_eq!(missing.status, 404, "{}", missing.body());
    let traversal = gateway.get("/plugins/demo/ui/..%2fplugin.json", &anonymous());
    assert_eq!(traversal.status, 400, "{}", traversal.body());
    // `.json` is a public extension, `demo/plugin.json` exists but sits outside the
    // declared UI subtree: the login exemption must not become a read of it.
    let outside = gateway.get("/plugins/demo/plugin.json", &anonymous());
    assert_eq!(outside.status, 403, "{}", outside.body());
    assert_eq!(outside.body(), r#"{"error":"只有 UI 子树可访问"}"#);
}

/// The UI containment check is load-bearing: the UI directory itself is one
/// separator short of `uiRoot + sep`, so it is 403, not a directory read. The
/// mutation experiment (make that check always pass) turns this and the two
/// other UI-subtree tests red.
#[test]
fn the_ui_directory_itself_is_never_served() {
    let (_tree, gateway) = gateway_with_tree("files-uiroot");
    let response = gateway.get("/plugins/demo/ui/", &local());
    assert_error(&response, 403, "只有 UI 子树可访问");
    // And a plugin file can never be its own root either.
    let response = gateway.get("/plugins/demo/", &local());
    assert_error(&response, 400, "非法路径");
}
