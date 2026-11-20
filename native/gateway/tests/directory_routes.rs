//! Integration coverage for the thirteen directory / onboarding / ui-layout
//! routes against the real `multicc-gateway` binary:
//!
//!   GET|HEAD /api/fs/list               GET|HEAD|POST /api/directories
//!   POST     /api/onboarding/sample-workspace
//!   PUT      /api/directories/order
//!   PATCH    /api/directories/:id       DELETE   /api/directories/:id
//!   POST     /api/directories/:id/push
//!   GET|HEAD /api/directories/:id/uncommitted
//!   POST     /api/directories/:id/commit
//!   GET|HEAD /api/ui-layout             PUT      /api/ui-layout/dir-order
//!   PUT      /api/ui-layout/session-order/:dirId
//!
//! The Node process here is only the protocol fixture (PROXY v1 + auth
//! control): it answers `POST /api/__host/directory` from
//! `script.directory.ops[op]` (appending every payload to
//! `directory-calls.jsonl`) and every unclaimed path with its plain `ok`
//! fallback. Path matching (case-insensitive literals, one optional trailing
//! slash, automatic OPTIONS), parameter decoding, the `isHomeOrAbove` verdict
//! over host-resolved realpaths, the browse filter/order/cap, DTO envelopes
//! and their member order, the reorder merge, the layout prune rules, the git
//! effect sequences the kernel asks for and the 503 surface are Rust and are
//! what these tests assert. The byte comparison against the frozen Node
//! handlers lives in docs/rust-migration/differential/directory-routes.js.

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
const JSON: &str = "application/json; charset=utf-8";
const HTML: &str = "text/html; charset=utf-8";
const UNAVAILABLE: &str = "目录与布局接口尚未就绪，请更新原生模块";

fn unique(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "multicc-gateway-directory-{}-{tag}-{nanos}",
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
            json!({ "directory": { "ops": {} } }).to_string(),
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

    /// Script every `directory` host op in one world.
    fn world(&self, ops: Value) {
        self.set_script(json!({ "directory": { "ops": ops } }));
    }

    fn host_down(&self) {
        self.set_script(json!({ "directory": { "hostDown": true } }));
    }

    /// Every `POST /api/__host/directory` body the fixture received, in order.
    fn host_calls(&self) -> Vec<Value> {
        fs::read_to_string(self.state.join("directory-calls.jsonl"))
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
        let _ = fs::remove_file(self.state.join("directory-calls.jsonl"));
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

// ── Express's automatic OPTIONS ─────────────────────────────────────────────

#[test]
fn options_answers_every_registered_path() {
    let gateway = Gateway::start("options");
    let cases = [
        ("/api/fs/list", "GET,HEAD"),
        ("/api/directories", "GET,HEAD,POST"),
        ("/api/onboarding/sample-workspace", "POST"),
        ("/api/directories/order", "PUT,PATCH,DELETE"),
        ("/api/directories/d1", "PATCH,DELETE"),
        ("/api/directories/d1/push", "POST"),
        ("/api/directories/d1/uncommitted", "GET,HEAD"),
        ("/api/directories/d1/commit", "POST"),
        ("/api/ui-layout", "GET,HEAD"),
        ("/api/ui-layout/dir-order", "PUT"),
        ("/api/ui-layout/session-order/d1", "PUT"),
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
    // OPTIONS is answered without touching the host.
    assert!(gateway.host_calls().is_empty());
}

#[test]
fn literals_are_case_insensitive_and_accept_one_trailing_slash() {
    let gateway = Gateway::start("literals");
    for url in ["/api/FS/List", "/api/fs/list/", "/api/Fs/list/"] {
        let response = gateway.get(url);
        assert_eq!(response.status, 200, "{url}");
        assert_eq!(response.json()["base"], json!("/base"), "{url}");
    }
    // Two trailing slashes, an empty segment and a case-changed `/api/` prefix
    // are different paths: this cluster releases them to the rest of the app.
    for url in ["/api/fs/list//", "/API/fs/list"] {
        assert_eq!(gateway.get(url).text(), "ok", "{url}");
    }
    let calls = gateway.ops_called();
    assert_eq!(
        calls,
        vec![
            "browse-facts",
            "browse-read",
            "browse-facts",
            "browse-read",
            "browse-facts",
            "browse-read"
        ]
    );
}

#[test]
fn the_literal_order_route_wins_for_put_and_patch_order_is_the_404() {
    let gateway = Gateway::start("order");
    gateway.world(json!({
        "dir-ids": { "ids": ["dir-a", "dir-b"] },
        "dirs-reorder": { "ids": ["dir-b", "dir-a"] },
    }));
    let put = gateway.put(
        "/api/directories/order",
        Some(r#"{"ids":["dir-b","dir-a"]}"#),
    );
    assert_eq!(put.status, 200);
    assert_eq!(put.json(), json!({ "ok": true, "ids": ["dir-b", "dir-a"] }));
    let calls = gateway.host_calls();
    assert_eq!(calls.last().unwrap()["op"], json!("dirs-reorder"));
    assert_eq!(calls.last().unwrap()["order"], json!(["dir-b", "dir-a"]));

    // PATCH has no literal `order` route: the `:id` claim takes it and answers
    // the same 404 an unknown id does.
    gateway.truncate_calls();
    let patch = gateway.patch("/api/directories/order", Some(r#"{"name":"x"}"#));
    assert_eq!(patch.status, 404);
    assert_eq!(
        patch.json(),
        json!({ "code": "not_found", "error": "directory not found" })
    );
    assert_eq!(gateway.ops_called(), vec!["dir-get"]);
}

// ── fs/list: the path-safety verdict and the browse rules ────────────────────

#[test]
fn fs_list_keeps_the_home_and_above_verdict() {
    let gateway = Gateway::start("fs-list");
    let (root, home_parent, home, sibling, work) = if cfg!(windows) {
        (
            r"C:\",
            r"C:\home",
            r"C:\home\me",
            r"C:\home\me2",
            r"C:\work",
        )
    } else {
        ("/", "/home", "/home/me", "/home/me2", "/work")
    };
    for real_base in [home, home_parent, root] {
        let real_home = home;
        gateway.world(json!({
            "browse-facts": {
                "base": real_base, "prefix": "", "baseIsDir": true, "parentIsDir": false,
                "parent": "/", "realBase": real_base, "realHome": real_home,
            },
            "browse-read": { "entries": [], "order": [] },
        }));
        let response = gateway.get("/api/fs/list");
        assert_eq!(response.status, 200, "{real_base}");
        assert_eq!(
            response.json()["selectable"],
            json!(false),
            "{real_base} must not be selectable"
        );
        order(
            &response.text(),
            &["\"base\"", "\"parent\"", "\"selectable\"", "\"entries\""],
        );
    }
    gateway.world(json!({
        "browse-facts": {
            "base": work, "prefix": "", "baseIsDir": true, "parentIsDir": false,
            "parent": root, "realBase": work, "realHome": home,
        },
        "browse-read": { "entries": [], "order": [] },
    }));
    assert_eq!(
        gateway.get("/api/fs/list?path=/work").json()["selectable"],
        json!(true)
    );
    // A sibling of $HOME is not an ancestor: `/home/me2` must stay selectable.
    gateway.world(json!({
        "browse-facts": {
            "base": sibling, "prefix": "", "baseIsDir": true, "parentIsDir": false,
            "parent": home_parent, "realBase": sibling, "realHome": home,
        },
        "browse-read": { "entries": [], "order": [] },
    }));
    assert_eq!(
        gateway.get("/api/fs/list?path=/home/me2").json()["selectable"],
        json!(true)
    );
}

#[test]
fn fs_list_without_an_existing_base_reports_no_parent_and_no_read() {
    let gateway = Gateway::start("fs-missing");
    gateway.world(json!({
        "browse-facts": {
            "base": "/gone", "prefix": "", "baseIsDir": false, "parentIsDir": false,
            "parent": "/", "realBase": "/gone", "realHome": "/home/me",
        },
    }));
    let response = gateway.get("/api/fs/list?path=/gone");
    assert_eq!(response.status, 200);
    assert_eq!(
        response.json(),
        json!({
            "base": "/gone", "parent": null, "selectable": false, "entries": [],
        })
    );
    // No readdir is attempted for a nonexistent path.
    assert_eq!(gateway.ops_called(), vec!["browse-facts"]);
}

#[test]
fn fs_list_filters_orders_and_caps_the_host_permutation() {
    let gateway = Gateway::start("fs-browse");
    gateway.world(json!({
        "browse-facts": {
            "base": "/work", "prefix": "a", "baseIsDir": true, "parentIsDir": false,
            "parent": "/", "realBase": "/work", "realHome": "/home/me",
        },
        "browse-read": {
            "entries": [
                { "name": "beta", "path": "/work/beta", "isDirectory": true, "isSymbolicLink": false, "targetIsDirectory": false },
                { "name": "alpha", "path": "/work/alpha", "isDirectory": true, "isSymbolicLink": false, "targetIsDirectory": false },
                { "name": "alink", "path": "/work/alink", "isDirectory": false, "isSymbolicLink": true, "targetIsDirectory": true },
                { "name": ".hidden", "path": "/work/.hidden", "isDirectory": true, "isSymbolicLink": false, "targetIsDirectory": false },
                { "name": "afile", "path": "/work/afile", "isDirectory": false, "isSymbolicLink": false, "targetIsDirectory": false },
            ],
            "order": [1, 2, 0, 3, 4],
        },
    }));
    let answer = gateway.get("/api/fs/list?path=/work/a").json();
    // The host hands back the localeCompare permutation; the kernel keeps that
    // order, keeps a symlink to a directory, and drops files and dotfiles.
    assert_eq!(
        answer["entries"],
        json!([
            { "name": "alpha", "path": "/work/alpha" },
            { "name": "alink", "path": "/work/alink" },
        ])
    );
    assert_eq!(answer["base"], json!("/work"));
    assert_eq!(answer["parent"], json!("/"));
    // A dotted prefix reveals dotfiles.
    gateway.world(json!({
        "browse-facts": {
            "base": "/work", "prefix": ".h", "baseIsDir": true, "parentIsDir": false,
            "parent": "/", "realBase": "/work", "realHome": "/home/me",
        },
        "browse-read": {
            "entries": [{ "name": ".hidden", "path": "/work/.hidden", "isDirectory": true }],
            "order": [0],
        },
    }));
    let dotted = gateway.get("/api/fs/list?path=/work/.h").json();
    assert_eq!(
        dotted["entries"],
        json!([{ "name": ".hidden", "path": "/work/.hidden" }])
    );
}

// ── directories ─────────────────────────────────────────────────────────────

fn directory_world() -> Value {
    json!({
        "dirs-annotated": {
            "dirs": [
                { "id": "d1", "name": "One", "path": "/work", "createdAt": "2026-01-01T00:00:00.000Z" }
            ],
            "sessions": [[{ "cli": "codex", "kind": "chat" }, { "cli": "", "kind": "" }]],
            "pushStates": [{ "ok": true, "value": {
                "available": true, "hasRemote": true, "branch": "main", "remote": "origin",
                "remoteBranch": "main", "upstream": "origin/main", "upstreamConfigured": true,
                "remoteBranchExists": true, "ahead": 2, "behind": 1, "dirty": 3,
            } }],
        },
    })
}

#[test]
fn directories_list_keeps_the_dto_key_order_and_the_count_fallbacks() {
    let gateway = Gateway::start("dirs-list");
    gateway.world(directory_world());
    let response = gateway.get("/api/directories");
    assert_eq!(response.status, 200);
    let body = response.json();
    assert_eq!(body.as_array().unwrap().len(), 1);
    let entry = body[0].clone();
    order(
        &response.text(),
        &[
            "\"id\"",
            "\"name\"",
            "\"path\"",
            "\"createdAt\"",
            "\"counts\"",
            "\"pushState\"",
        ],
    );
    // 26 counters in declaration order; a session with no cli/kind counts as a
    // claude terminal, exactly like `label()`'s fallbacks.
    assert_eq!(
        entry["counts"],
        json!({
            "claude_terminal": 1, "claude_chat": 0,
            "codex_terminal": 0, "codex_chat": 1,
            "opencode_terminal": 0, "opencode_chat": 0,
            "zcode_terminal": 0, "zcode_chat": 0,
            "qoder_terminal": 0, "qoder_chat": 0,
            "kimi_terminal": 0, "kimi_chat": 0,
            "codebuddy_terminal": 0, "codebuddy_chat": 0,
            "dsh_terminal": 0, "dsh_chat": 0,
            "gemini_terminal": 0, "gemini_chat": 0,
            "grok_terminal": 0, "grok_chat": 0,
            "agy_terminal": 0, "agy_chat": 0,
            "commandcode_terminal": 0, "commandcode_chat": 0,
            "pi_terminal": 0, "pi_chat": 0,
        })
    );
    order(
        &entry.to_string(),
        &[
            "\"available\"",
            "\"hasRemote\"",
            "\"branch\"",
            "\"remote\"",
            "\"remoteBranch\"",
            "\"upstream\"",
            "\"upstreamConfigured\"",
            "\"remoteBranchExists\"",
            "\"ahead\"",
            "\"behind\"",
            "\"dirty\"",
        ],
    );
    assert_eq!(entry["pushState"]["ahead"], json!(2));
    assert_eq!(gateway.ops_called(), vec!["dirs-annotated"]);
}

#[test]
fn a_failed_push_state_uses_the_documented_failure_shape() {
    let gateway = Gateway::start("dirs-push-state");
    gateway.world(json!({
        "dirs-annotated": {
            "dirs": [{ "id": "d1", "name": "One", "path": "/work" }],
            "sessions": [[]],
            "pushStates": [{ "ok": false, "error": "fatal: boom" }],
        },
    }));
    let entry = gateway.get("/api/directories").json()[0].clone();
    assert_eq!(
        entry["pushState"],
        json!({
            "available": false, "hasRemote": false, "ahead": 0, "behind": 0, "reason": "fatal: boom",
        })
    );
    order(
        &entry.to_string(),
        &[
            "\"available\"",
            "\"hasRemote\"",
            "\"ahead\"",
            "\"behind\"",
            "\"reason\"",
        ],
    );
}

#[test]
fn register_answers_the_live_record_and_names_the_remediations() {
    let gateway = Gateway::start("register");
    gateway.world(json!({
        "new-id": { "id": "dir-new-9" },
        "register-commit": { "dir": {
            "id": "dir-new-9", "name": "New", "path": "/work/new",
            "createdAt": "2026-01-01T00:00:00.000Z", "baseBranch": "main", "gitInitialized": true,
        } },
    }));
    let response = gateway.post(
        "/api/directories",
        Some(r#"{"name":"  New  ","path":"/work/new","create":true}"#),
    );
    assert_eq!(response.status, 200, "{}", response.text());
    // The answer is the record the host holds after its readiness probe (it
    // stamps `baseBranch`/`gitInitialized`), not the pre-probe draft.
    assert_eq!(
        response.json(),
        json!({
            "id": "dir-new-9", "name": "New", "path": "/work/new",
            "createdAt": "2026-01-01T00:00:00.000Z", "baseBranch": "main", "gitInitialized": true,
        })
    );
    assert_eq!(
        gateway.ops_called(),
        vec![
            "resolve-path",
            "real-paths",
            "path-facts",
            "find-by-path",
            "new-id",
            "register-add",
            "ensure-ready",
            "register-commit",
        ]
    );

    // Readiness refusals: the host's prose plus either its fix code, or the
    // ops-terminal fallback for a raw `git-error:`.
    let failure_cases = [
        (
            json!({ "ok": false, "reason": "spawn git ENOENT" }),
            json!({ "detail": "Git 不可用", "fix": "fix-git-missing" }),
            json!("fix-git-missing"),
        ),
        (
            json!({ "ok": false, "reason": "git-error: fatal: not writable" }),
            json!({ "detail": "目录初始化失败", "fix": null }),
            json!("open-ops-terminal"),
        ),
    ];
    for (ensure, described, fix) in failure_cases {
        gateway.truncate_calls();
        gateway.world(json!({
            "new-id": { "id": "dir-new-9" },
            "ensure-ready": ensure,
            "dir-reason": described,
        }));
        let refused = gateway.post(
            "/api/directories",
            Some(r#"{"name":"New","path":"/work/new","create":true}"#),
        );
        assert_eq!(refused.status, 400, "{}", refused.text());
        assert_eq!(refused.json()["code"], json!("invalid"));
        assert_eq!(refused.json()["fix"], fix);
        let ops = gateway.ops_called();
        assert!(ops.contains(&"register-rollback".to_string()), "{ops:?}");
        assert_eq!(ops.last().unwrap(), "dir-reason");
    }

    // $HOME (and above) is refused before any filesystem or git effect.
    gateway.truncate_calls();
    gateway.world(json!({
        "real-paths": { "real": ["/home/me"], "home": "/home/me" },
    }));
    let refused = gateway.post("/api/directories", Some(r#"{"name":"Home","path":"~"}"#));
    assert_eq!(refused.status, 400);
    assert_eq!(
        refused.json(),
        json!({ "code": "invalid", "error": "不允许选择 $HOME 或更高层目录" })
    );
    assert_eq!(gateway.ops_called(), vec!["resolve-path", "real-paths"]);

    // A missing path is only created when `create` is truthy.
    gateway.truncate_calls();
    gateway.world(json!({
        "path-facts": { "exists": [false], "isDirectory": [false] },
    }));
    let refused = gateway.post(
        "/api/directories",
        Some(r#"{"name":"New","path":"/work/new"}"#),
    );
    assert_eq!(refused.status, 400);
    assert_eq!(
        refused.json(),
        json!({ "code": "invalid", "error": "path does not exist: /work/new" })
    );
    assert!(!gateway.ops_called().contains(&"mkdirp".to_string()));
}

#[test]
fn sample_workspace_reuse_and_created_files() {
    let gateway = Gateway::start("sample");
    gateway.world(json!({
        "sample-ensure": { "name": "MultiCC 入门示例", "path": "/base/getting-started",
            "createdFiles": ["README.md", "index.html"] },
        "find-by-path": { "found": {
            "id": "d1", "name": "MultiCC 入门示例", "path": "/base/getting-started",
            "createdAt": "2026-01-01T00:00:00.000Z", "sample": true,
        } },
    }));
    let response = gateway.post("/api/onboarding/sample-workspace", None);
    assert_eq!(response.status, 200, "{}", response.text());
    let answer = response.json();
    assert_eq!(answer["reused"], json!(true));
    assert_eq!(answer["createdFiles"], json!(["README.md", "index.html"]));
    order(
        &response.text(),
        &[
            "\"id\"",
            "\"name\"",
            "\"path\"",
            "\"createdAt\"",
            "\"sample\"",
            "\"reused\"",
            "\"createdFiles\"",
        ],
    );
    // A reused directory is not re-registered: no readiness probe ran.
    assert!(!gateway.ops_called().contains(&"ensure-ready".to_string()));
}

#[test]
fn update_keeps_the_partial_mutation_quirks() {
    let gateway = Gateway::start("update");
    // 1. `name` is written before the path is validated, and the failure leaves
    // it applied in memory (never saved) - the retired handler's order.
    gateway.world(json!({
        "dir-get": { "dir": { "id": "d1", "name": "Old", "path": "/work", "createdAt": "2026-01-01T00:00:00.000Z" } },
        "path-facts": { "exists": [false], "isDirectory": [false] },
    }));
    let response = gateway.patch(
        "/api/directories/d1",
        Some(r#"{"name":"New","path":"/gone"}"#),
    );
    assert_eq!(response.status, 400);
    assert_eq!(
        response.json(),
        json!({ "code": "invalid", "error": "path does not exist: /gone" })
    );
    let ops = gateway.ops_called();
    assert_eq!(
        ops,
        vec!["dir-get", "dir-set-name", "resolve-path", "path-facts"],
        "{ops:?}"
    );

    // 2. A readiness failure after a path change does not revert the path.
    gateway.truncate_calls();
    gateway.world(json!({
        "dir-get": { "dir": { "id": "d1", "name": "New", "path": "/moved" } },
        "path-facts": { "exists": [true], "isDirectory": [true] },
        "realpath-equal": { "equal": false },
        "ensure-ready": { "ok": false, "reason": "path-missing" },
        "dir-reason": { "detail": "目录不存在", "fix": null },
    }));
    let response = gateway.patch("/api/directories/d1", Some(r#"{"path":"/moved"}"#));
    assert_eq!(response.status, 400);
    assert_eq!(
        response.json(),
        json!({ "code": "invalid", "error": "目录不存在" })
    );
    let ops = gateway.ops_called();
    assert_eq!(
        ops,
        vec![
            "dir-get",
            "resolve-path",
            "path-facts",
            "real-paths",
            "find-by-path",
            "realpath-equal",
            "dir-set-path",
            "ensure-ready",
            "dir-reason",
        ],
        "{ops:?}"
    );

    // 3. rolePrompt is trimmed, bounded in UTF-16 units, and null clears it.
    gateway.truncate_calls();
    gateway.world(json!({
        "dir-get": { "dir": { "id": "d1", "name": "New", "path": "/work",
            "createdAt": "2026-01-01T00:00:00.000Z", "rolePrompt": "be nice" } },
    }));
    let response = gateway.patch(
        "/api/directories/d1",
        Some(r#"{"rolePrompt":"  be nice  "}"#),
    );
    assert_eq!(response.status, 200);
    assert_eq!(response.json()["rolePrompt"], json!("be nice"));
    let calls = gateway.host_calls();
    let role = calls
        .iter()
        .find(|call| call["op"] == json!("dir-set-role"))
        .unwrap();
    assert_eq!(role["value"], json!("be nice"));
    let too_long = json!({ "rolePrompt": "x".repeat(40001) }).to_string();
    let response = gateway.patch("/api/directories/d1", Some(&too_long));
    assert_eq!(response.status, 400);
    assert_eq!(
        response.json()["error"],
        json!("rolePrompt too long (max 40000)")
    );
    // The update saves once and answers the record re-read from the host.
    let saved = gateway
        .ops_called()
        .iter()
        .filter(|op| *op == "dir-save")
        .count();
    assert_eq!(saved, 1);
}

#[test]
fn delete_cascades_then_commits_the_cross_file_transaction() {
    let gateway = Gateway::start("delete");
    gateway.world(json!({
        "dir-get": { "dir": { "id": "d1", "name": "One", "path": "/work" } },
        "sessions-by-dir": { "sessions": [{ "id": "s1" }, { "id": "s2" }] },
    }));
    let refused = gateway.delete("/api/directories/d1", None);
    assert_eq!(refused.status, 400);
    assert_eq!(
        refused.json(),
        json!({
            "code": "invalid",
            "error": "directory has 2 session(s); pass ?force=1 to delete them too",
            "sessions": ["s1", "s2"],
        })
    );
    assert!(!gateway.ops_called().contains(&"tx-commit".to_string()));

    gateway.truncate_calls();
    let forced = gateway.delete("/api/directories/d1?force=1", None);
    assert_eq!(forced.status, 200);
    assert_eq!(forced.json(), json!({ "ok": true, "removedSessions": 2 }));
    assert_eq!(
        gateway.ops_called(),
        vec![
            "dir-get",
            "sessions-by-dir",
            "destroy-cascade",
            "destroy-cascade",
            "dir-remove",
            "tx-commit",
        ]
    );
    let calls = gateway.host_calls();
    // The session record travels with the cascade so the host does not list the
    // table a second time, and the transaction carries the force flag.
    assert_eq!(calls[2]["session"], json!({ "id": "s1" }));
    assert_eq!(calls[2]["force"], json!(true));
    assert_eq!(calls[5]["op"], json!("tx-commit"));
    assert_eq!(calls[5]["id"], json!("d1"));
    assert_eq!(calls[5]["force"], json!(true));

    // A refused cascade aborts before any removal or transaction.
    gateway.truncate_calls();
    gateway.world(json!({
        "dir-get": { "dir": { "id": "d1", "name": "One", "path": "/work" } },
        "sessions-by-dir": { "sessions": [{ "id": "sess-fail" }] },
        "destroy-cascade": { "result": { "ok": false, "error": "cascade refused" } },
    }));
    let refused = gateway.delete("/api/directories/d1?force=1", None);
    assert_eq!(refused.status, 400);
    assert_eq!(refused.json()["error"], json!("cascade refused"));
    assert!(!gateway.ops_called().contains(&"dir-remove".to_string()));
}

#[test]
fn push_and_commit_quote_the_host_results_and_append_the_events() {
    let gateway = Gateway::start("push");
    gateway.world(json!({
        "dir-get": { "dir": { "id": "d1", "name": "One", "path": "/work", "baseBranch": "main" } },
    }));
    let pushed = gateway.post("/api/directories/d1/push", None);
    assert_eq!(pushed.status, 200, "{}", pushed.text());
    assert_eq!(pushed.json()["pushed"], json!(true));
    order(
        &pushed.text(),
        &["\"ok\"", "\"pushed\"", "\"before\"", "\"after\""],
    );
    assert_eq!(
        gateway.ops_called(),
        vec!["dir-get", "git-push", "events-append"]
    );
    let calls = gateway.host_calls();
    assert_eq!(calls[1]["id"], json!("d1"));
    assert_eq!(calls[2]["kind"], json!("pushed"));
    assert_eq!(calls[2]["text"], json!("1 个提交 → origin/main"));

    // A non-repository answer is an invalid refusal, not a 500.
    gateway.truncate_calls();
    gateway.world(json!({
        "dir-get": { "dir": { "id": "d1", "name": "One", "path": "/work", "baseBranch": "main" } },
        "git-push": { "error": "当前目录没有可推送的分支" },
    }));
    let refused = gateway.post("/api/directories/d1/push", None);
    assert_eq!(refused.status, 400);
    assert_eq!(
        refused.json(),
        json!({ "code": "invalid", "error": "当前目录没有可推送的分支" })
    );
    assert!(!gateway.ops_called().contains(&"events-append".to_string()));

    // commit: dirty 2 -> validate -> run -> invalidate -> re-read
    gateway.truncate_calls();
    gateway.world(json!({
        "dir-get": { "dir": { "id": "d1", "name": "One", "path": "/work", "baseBranch": "main" } },
    }));
    let committed = gateway.post(
        "/api/directories/d1/commit",
        Some(r#"{"message":"chore: tidy"}"#),
    );
    assert_eq!(committed.status, 200, "{}", committed.text());
    assert_eq!(committed.json()["committed"], json!(true));
    order(
        &committed.text(),
        &["\"ok\"", "\"committed\"", "\"pushState\""],
    );
    assert_eq!(
        gateway.ops_called(),
        vec![
            "dir-get",
            "commit-facts",
            "commit-validate",
            "commit-run",
            "events-append"
        ]
    );
    let calls = gateway.host_calls();
    assert_eq!(calls[2]["message"], json!("chore: tidy"));
    let event = calls.last().unwrap();
    assert_eq!(event["kind"], json!("committed"));
    assert_eq!(event["text"], json!("提交 1 个未提交改动"));

    // A clean tree short-circuits before any message or git work.
    gateway.truncate_calls();
    gateway.world(json!({
        "dir-get": { "dir": { "id": "d1", "name": "One", "path": "/work", "baseBranch": "main" } },
        "commit-facts": { "pushState": { "available": true, "hasRemote": false,
            "branch": "main", "ahead": 0, "behind": 0, "dirty": 0, "reason": "no-remote" } },
    }));
    let clean = gateway.post("/api/directories/d1/commit", None);
    assert_eq!(clean.status, 200);
    assert_eq!(clean.json()["committed"], json!(false));
    assert_eq!(gateway.ops_called(), vec!["dir-get", "commit-facts"]);
}

#[test]
fn uncommitted_parses_porcelain_and_trims_only_the_trailing_newline() {
    let gateway = Gateway::start("uncommitted");
    gateway.world(json!({
        "dir-get": { "dir": { "id": "d1", "name": "One", "path": "/work" } },
        "status-porcelain": { "out": " M a.txt\n?? b c.txt\n" },
    }));
    let response = gateway.get("/api/directories/d1/uncommitted");
    assert_eq!(response.status, 200);
    assert_eq!(
        response.json(),
        json!({
            "files": [
                { "status": " M", "path": "a.txt" },
                { "status": "??", "path": "b c.txt" },
            ],
        })
    );
    gateway.world(json!({
        "dir-get": { "dir": { "id": "d1", "name": "One", "path": "/work" } },
        "status-porcelain": { "error": "fatal: not a git repository" },
    }));
    let refused = gateway.get("/api/directories/d1/uncommitted");
    assert_eq!(refused.status, 400);
    assert_eq!(
        refused.json(),
        json!({ "code": "invalid", "error": "fatal: not a git repository" })
    );
}

// ── ui-layout ───────────────────────────────────────────────────────────────

#[test]
fn ui_layout_prunes_against_the_live_ids_and_stamps_the_write() {
    let gateway = Gateway::start("layout");
    gateway.world(json!({
        "layout-load": { "present": true, "corrupt": false, "data": {
            "dirOrder": ["d2", "gone", "d1", "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"],
            "sessionOrder": { "d1": ["s2", "ghost", "s1"], "d3": ["s9"], "gone": ["s1"] },
            "updatedAt": "2026-01-05T00:00:00.000Z",
            "junk": true,
        } },
        "layout-known": { "dirIds": ["d1", "d2"], "sessionIds": { "d1": ["s1", "s2"] } },
    }));
    let response = gateway.get("/api/ui-layout");
    assert_eq!(response.status, 200);
    // Unknown dirs, unknown sessions, an over-long id and unknown top-level
    // keys all prune away.
    assert_eq!(
        response.json()["layout"],
        json!({
            "dirOrder": ["d2", "d1"],
            "sessionOrder": { "d1": ["s2", "s1"] },
            "updatedAt": "2026-01-05T00:00:00.000Z",
        })
    );
    order(
        &response.text(),
        &["\"dirOrder\"", "\"sessionOrder\"", "\"updatedAt\""],
    );

    let writes = gateway.put(
        "/api/ui-layout/dir-order",
        Some(r#"{"order":["d1","gone","d1","d2"]}"#),
    );
    assert_eq!(writes.status, 200, "{}", writes.text());
    assert_eq!(writes.json()["layout"]["dirOrder"], json!(["d1", "d2"]));
    let saved = gateway
        .host_calls()
        .into_iter()
        .find(|call| call["op"] == json!("layout-save"))
        .unwrap();
    assert_eq!(saved["doc"]["dirOrder"], json!(["d1", "d2"]));
    assert!(saved["doc"]["updatedAt"].as_str().unwrap().ends_with('Z'));

    // An empty session list removes the directory's entry; an unknown
    // directory is the plain 404; a non-array is the plain 400.
    gateway.truncate_calls();
    let cleared = gateway.put("/api/ui-layout/session-order/d1", Some(r#"{"order":[]}"#));
    assert_eq!(cleared.status, 200);
    assert_eq!(cleared.json()["layout"]["sessionOrder"], json!({}));
    let unknown = gateway.put(
        "/api/ui-layout/session-order/nope",
        Some(r#"{"order":["s1"]}"#),
    );
    assert_eq!(unknown.status, 404);
    assert_eq!(unknown.json(), json!({ "error": "directory not found" }));
    let bad = gateway.put("/api/ui-layout/dir-order", Some(r#"{"order":"d1"}"#));
    assert_eq!(bad.status, 400);
    assert_eq!(
        bad.json(),
        json!({ "error": "order must be an array of directory ids" })
    );
}

// ── shared express surface ──────────────────────────────────────────────────

#[test]
fn parameter_decoding_and_malformed_escapes() {
    let gateway = Gateway::start("params");
    gateway.world(json!({
        "dir-get": { "dir": { "id": "dir-1", "name": "One", "path": "/work" } },
    }));
    let response = gateway.patch("/api/directories/dir%2D1", Some(r#"{"rolePrompt":"x"}"#));
    assert_eq!(response.status, 200, "{}", response.text());
    assert_eq!(gateway.host_calls()[0]["id"], json!("dir-1"));
    let response = gateway.patch("/api/directories/dir%2", Some(r#"{"rolePrompt":"x"}"#));
    assert_eq!(response.status, 400);
    assert_eq!(response.json()["code"], json!("request_error"));
}

#[test]
fn cluster_does_not_shadow_the_other_directory_routes() {
    let gateway = Gateway::start("shadow");
    // session-admin owns /api/directories/:id/sessions and /workspace;
    // docs-memory owns /memo, /memo/send and /events. None of them may be
    // swallowed by this cluster's `:id` parameter - they answer from their own
    // claim (here: the empty world) and record no directory host call.
    for path in [
        "/api/directories/d1/sessions",
        "/api/directories/d1/workspace",
        // The notes-events route answers 404 for an empty world too, from its
        // own store: the host-call assertion below is what attributes it.
        "/api/directories/d1/events",
    ] {
        let response = gateway.get(path);
        assert_eq!(response.status, 404, "{path}: {}", response.text());
        assert_eq!(
            response.json(),
            json!({ "error": "directory not found" }),
            "{path}"
        );
    }
    // docs-memory owns /memo: it answers from its own store (`{data:null}`).
    let memo = gateway.get("/api/directories/d1/memo");
    assert_eq!(memo.status, 200, "{}", memo.text());
    assert_ne!(memo.json()["error"], json!("directory not found"));
    assert!(gateway.host_calls().is_empty());
    // A GET on a path registered only for PATCH/DELETE falls through to Node.
    assert_eq!(gateway.get("/api/directories/d1").text(), "ok");
    // A trailing segment is nobody's parameter.
    assert_eq!(
        gateway
            .patch("/api/directories/d1/extra", Some("{}"))
            .text(),
        "ok"
    );
    assert!(gateway.host_calls().is_empty());
}

#[test]
fn an_unreachable_host_is_the_documented_503() {
    let gateway = Gateway::start("host-down");
    gateway.host_down();
    let cases: [(&str, &str, Option<&str>); 10] = [
        ("GET", "/api/fs/list", None),
        ("GET", "/api/directories", None),
        (
            "POST",
            "/api/directories",
            Some(r#"{"name":"n","path":"/work"}"#),
        ),
        ("POST", "/api/onboarding/sample-workspace", None),
        ("PUT", "/api/directories/order", Some(r#"{"ids":[]}"#)),
        ("PATCH", "/api/directories/d1", Some("{}")),
        ("DELETE", "/api/directories/d1", None),
        ("POST", "/api/directories/d1/push", None),
        ("GET", "/api/directories/d1/uncommitted", None),
        ("POST", "/api/directories/d1/commit", Some("{}")),
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
    for (method, url, body) in [
        ("GET", "/api/ui-layout", None),
        ("PUT", "/api/ui-layout/dir-order", Some(r#"{"order":[]}"#)),
        (
            "PUT",
            "/api/ui-layout/session-order/d1",
            Some(r#"{"order":[]}"#),
        ),
    ] {
        let response = gateway.exchange(method, url, body, &[]);
        assert_unavailable(&response);
    }
    // Automatic OPTIONS never talks to the host, so it still answers.
    let options = gateway.options("/api/directories");
    assert_eq!(options.status, 200);
    assert_eq!(options.header("allow"), Some("GET,HEAD,POST"));
}

#[test]
fn head_is_covered_by_the_get_routes() {
    let gateway = Gateway::start("head");
    gateway.world(directory_world());
    let head = gateway.head("/api/directories");
    assert_eq!(head.status, 200);
    assert_eq!(head.header("content-type"), Some(JSON));
    assert!(head.raw_body.is_empty(), "HEAD must not send a body");
    let get = gateway.get("/api/directories");
    assert_eq!(
        head.header("content-length"),
        get.header("content-length"),
        "HEAD keeps GET's Content-Length"
    );
    gateway.world(json!({
        "browse-facts": {
            "base": "/base", "prefix": "", "baseIsDir": true, "parentIsDir": false,
            "parent": "/", "realBase": "/base", "realHome": "/home",
        },
        "browse-read": { "entries": [], "order": [] },
    }));
    let head = gateway.head("/api/fs/list");
    assert_eq!(head.status, 200);
    assert!(head.raw_body.is_empty());
}
