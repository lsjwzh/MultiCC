//! Integration coverage for `GET/HEAD/OPTIONS /api/token-usage/by-role`
//! against the real `multicc-gateway` binary, retired from the `mountRoutes` of
//! `src/routes/token-usage.js`.
//!
//! The Node process here is only the protocol fixture (PROXY v1 + auth
//! control): it answers `/api/__host/token-usage` from the JSON script the test
//! writes (`FIXTURE_HOST_SCRIPT`) and appends every request it received to
//! `token-usage-calls.jsonl`. The query semantics, the empty-snapshot fallback,
//! status codes, headers and error body are Rust and are what these tests
//! assert.

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

/// `EMPTY_ROLE_SNAPSHOT` in src/routes/token-usage.js.
const EMPTY_SNAPSHOT: &str = r#"{"main":null,"sub":null,"subByProvider":[]}"#;
/// `PUBLIC_USAGE_ERROR` in src/routes/token-usage.js.
const PUBLIC_ERROR: &str = r#"{"error":"Token usage is temporarily unavailable"}"#;

fn unique(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "multicc-gateway-token-usage-by-role-{}-{tag}-{nanos}",
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

    /// `Err((log, retryable))`. `free_port` only reserves `127.0.0.1`, while the
    /// gateway binds `0.0.0.0`; parallel tests can hand the same ephemeral port
    /// to two gateways, so a bind failure is retried with a fresh port instead
    /// of failing the run.
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

    /// Every `POST /api/__host/token-usage` body the fixture received, in order.
    fn host_calls(&self) -> Vec<Value> {
        fs::read_to_string(self.state.join("token-usage-calls.jsonl"))
            .unwrap_or_default()
            .lines()
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn exchange(&self, method: &str, url: &str) -> Response {
        let request = format!(
            "{method} {url} HTTP/1.1\r\nHost: localhost\r\nX-Request-Id: diff-req-1\r\nConnection: close\r\n\r\n"
        );
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

    fn request(&self, method: &str, url: &str) -> Response {
        self.exchange(method, url)
    }

    fn get(&self, url: &str) -> Response {
        self.exchange("GET", url)
    }
}

impl Drop for Gateway {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.dir);
    }
}

/// A realistic `roleTokenTracker.snapshot()` value, written in the field order
/// the Node tracker emits: `main`, `mainByProvider`, `sub`, `subByProvider`.
fn sample_snapshot() -> Value {
    json!({
        "main": {
            "inputTokens": 1200,
            "outputTokens": 340,
            "cacheWrite": 50,
            "cacheRead": 900,
        },
        "mainByProvider": [
            {
                "provider": "anthropic",
                "inputTokens": 1000,
                "outputTokens": 300,
                "cacheWrite": 40,
                "cacheRead": 800,
            },
            {
                "provider": "codex",
                "inputTokens": 200,
                "outputTokens": 40,
                "cacheWrite": 10,
                "cacheRead": 100,
            },
        ],
        "sub": {
            "inputTokens": 75,
            "outputTokens": 12,
            "cacheWrite": 0,
            "cacheRead": 5,
        },
        "subByProvider": [
            {
                "provider": "anthropic",
                "inputTokens": 75,
                "outputTokens": 12,
                "cacheWrite": 0,
                "cacheRead": 5,
            },
        ],
    })
}

fn assert_weak_etag(response: &Response) {
    let etag = response.header("etag").expect("ETag header");
    assert!(
        etag.starts_with("W/\"") && etag.ends_with('"') && etag.len() > 4,
        "not a weak ETag: {etag:?}"
    );
}

#[test]
fn snapshot_hit_returns_the_scripted_snapshot() {
    let snapshot = sample_snapshot();
    let gateway = Gateway::start(
        "snapshot-hit",
        json!({ "tokenUsage": { "snapshots": { "sess-1": snapshot } } }),
    );
    let response = gateway.get("/api/token-usage/by-role?session=sess-1");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(
        response.header("content-type"),
        Some("application/json; charset=utf-8")
    );
    assert_weak_etag(&response);
    // Exact bytes, including the field order the tracker emits.
    let expected = r#"{"main":{"inputTokens":1200,"outputTokens":340,"cacheWrite":50,"cacheRead":900},"mainByProvider":[{"provider":"anthropic","inputTokens":1000,"outputTokens":300,"cacheWrite":40,"cacheRead":800},{"provider":"codex","inputTokens":200,"outputTokens":40,"cacheWrite":10,"cacheRead":100}],"sub":{"inputTokens":75,"outputTokens":12,"cacheWrite":0,"cacheRead":5},"subByProvider":[{"provider":"anthropic","inputTokens":75,"outputTokens":12,"cacheWrite":0,"cacheRead":5}]}"#;
    assert_eq!(response.body, expected);
    assert_eq!(response.json(), snapshot);
    let expected_length = response.body.len().to_string();
    assert_eq!(
        response.header("content-length"),
        Some(expected_length.as_str())
    );
    assert_eq!(
        gateway.host_calls(),
        vec![json!({ "op": "snapshot", "session": "sess-1" })]
    );
}

#[test]
fn snapshot_miss_returns_the_empty_snapshot() {
    let gateway = Gateway::start(
        "snapshot-miss",
        json!({ "tokenUsage": { "snapshots": { "other": sample_snapshot() } } }),
    );
    let response = gateway.get("/api/token-usage/by-role?session=absent");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.body, EMPTY_SNAPSHOT);
    assert_eq!(
        response.header("content-type"),
        Some("application/json; charset=utf-8")
    );
    assert_eq!(
        gateway.host_calls(),
        vec![json!({ "op": "snapshot", "session": "absent" })]
    );
}

#[test]
fn ledger_is_answered_verbatim_with_its_key_order() {
    // Keys are deliberately not alphabetical, so a reordering map would fail.
    let ledger = json!({
        "2026-11-11": {
            "main": { "anthropic": { "inputTokens": 10, "outputTokens": 4 } },
            "sub": { "codex": { "inputTokens": 3, "outputTokens": 1 } },
        },
        "2026-11-10": {},
    });
    let gateway = Gateway::start(
        "ledger",
        json!({ "tokenUsage": { "ledger": ledger.clone() } }),
    );
    let response = gateway.get("/api/token-usage/by-role");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.body, ledger.to_string());
    assert_eq!(response.json(), ledger);
    assert_eq!(gateway.host_calls(), vec![json!({ "op": "ledger" })]);
}

#[test]
fn empty_and_absent_session_both_read_the_ledger() {
    let ledger = json!({ "2026-11-11": { "main": {} } });
    let gateway = Gateway::start(
        "ledger-empty",
        json!({ "tokenUsage": { "ledger": ledger.clone() } }),
    );
    // `?session=` is falsy in JS, exactly like a missing key.
    let empty = gateway.get("/api/token-usage/by-role?session=");
    assert_eq!(empty.status, 200, "{}", empty.body);
    assert_eq!(empty.body, ledger.to_string());
    let absent = gateway.get("/api/token-usage/by-role");
    assert_eq!(absent.status, 200, "{}", absent.body);
    assert_eq!(absent.body, ledger.to_string());
    assert_eq!(
        gateway.host_calls(),
        vec![json!({ "op": "ledger" }), json!({ "op": "ledger" })]
    );
}

#[test]
fn array_and_object_session_forms_answer_empty_without_a_host_call() {
    let gateway = Gateway::start(
        "session-shapes",
        json!({ "tokenUsage": { "snapshots": { "a": sample_snapshot() } } }),
    );
    // Repeated keys and bracketed keys arrive as a qs array/object. They are
    // truthy, but `Map#get(object)` never matches a string key.
    for url in [
        "/api/token-usage/by-role?session=a&session=b",
        "/api/token-usage/by-role?session%5B%5D=a",
        "/api/token-usage/by-role?session%5Bk%5D=a",
    ] {
        let response = gateway.get(url);
        assert_eq!(response.status, 200, "{url}: {}", response.body);
        assert_eq!(response.body, EMPTY_SNAPSHOT, "{url}");
        assert_eq!(
            response.header("content-type"),
            Some("application/json; charset=utf-8"),
            "{url}"
        );
    }
    assert!(
        gateway.host_calls().is_empty(),
        "an array/object session needs no host call: {:?}",
        gateway.host_calls()
    );
}

#[test]
fn percent_encoded_session_is_decoded_once() {
    let gateway = Gateway::start(
        "encoded",
        json!({ "tokenUsage": { "snapshots": { "a b/c": sample_snapshot() } } }),
    );
    // `%20` and `%2F` decode; `+` is qs's space.
    let escaped = gateway.get("/api/token-usage/by-role?session=a%20b%2Fc");
    assert_eq!(escaped.status, 200, "{}", escaped.body);
    assert_eq!(escaped.body, sample_snapshot().to_string());
    let plus = gateway.get("/api/token-usage/by-role?session=a+b");
    assert_eq!(plus.status, 200, "{}", plus.body);
    assert_eq!(plus.body, EMPTY_SNAPSHOT);
    assert_eq!(
        gateway.host_calls(),
        vec![
            json!({ "op": "snapshot", "session": "a b/c" }),
            json!({ "op": "snapshot", "session": "a b" }),
        ]
    );
}

#[test]
fn host_down_is_the_public_500() {
    let gateway = Gateway::start("host-down", json!({ "hostDown": true, "tokenUsage": {} }));
    for url in [
        "/api/token-usage/by-role?session=sess-1",
        "/api/token-usage/by-role",
    ] {
        let response = gateway.get(url);
        assert_eq!(response.status, 500, "{url}: {}", response.body);
        assert_eq!(
            response.header("content-type"),
            Some("application/json; charset=utf-8"),
            "{url}"
        );
        assert_eq!(response.body, PUBLIC_ERROR, "{url}");
    }
    // Both attempts reached the fixture; the failure was the destroyed socket.
    assert_eq!(
        gateway.host_calls(),
        vec![
            json!({ "op": "snapshot", "session": "sess-1" }),
            json!({ "op": "ledger" }),
        ]
    );
}

#[test]
fn host_failure_answer_is_the_public_500() {
    let gateway = Gateway::start("host-down-false", json!({ "tokenUsage": { "down": true } }));
    for url in [
        "/api/token-usage/by-role?session=sess-1",
        "/api/token-usage/by-role",
    ] {
        let response = gateway.get(url);
        assert_eq!(response.status, 500, "{url}: {}", response.body);
        assert_eq!(response.body, PUBLIC_ERROR, "{url}");
    }
}

#[test]
fn options_and_head_follow_the_express_shape() {
    let snapshot = sample_snapshot();
    let gateway = Gateway::start(
        "options-head",
        json!({ "tokenUsage": { "snapshots": { "sess-1": snapshot.clone() } } }),
    );
    let options = gateway.request("OPTIONS", "/api/token-usage/by-role");
    assert_eq!(options.status, 200);
    assert_eq!(options.header("allow"), Some("GET,HEAD"));
    assert_eq!(options.body, "GET,HEAD");

    let get = gateway.get("/api/token-usage/by-role?session=sess-1");
    assert_eq!(get.status, 200, "{}", get.body);
    let head = gateway.request("HEAD", "/api/token-usage/by-role?session=sess-1");
    assert_eq!(head.status, 200);
    assert_eq!(head.body, "");
    assert_eq!(head.header("etag"), get.header("etag"));
    assert_eq!(head.header("content-type"), get.header("content-type"));
    assert_eq!(head.header("content-length"), get.header("content-length"));
    // The handler still ran for the HEAD request.
    assert_eq!(
        gateway.host_calls(),
        vec![
            json!({ "op": "snapshot", "session": "sess-1" }),
            json!({ "op": "snapshot", "session": "sess-1" }),
        ]
    );
}

#[test]
fn path_matching_is_literal_case_insensitive_and_one_trailing_slash() {
    let snapshot = sample_snapshot();
    let gateway = Gateway::start(
        "path",
        json!({ "tokenUsage": { "snapshots": { "sess-1": snapshot.clone() } } }),
    );
    // Literal segments are case-insensitive and one trailing slash is accepted.
    let claimed = gateway.get("/api/token-usage/By-Role/?session=sess-1");
    assert_eq!(claimed.status, 200, "{}", claimed.body);
    assert_eq!(claimed.body, snapshot.to_string());

    // None of these are claimed; the fixture's echo fallback answers `ok`, so
    // the by-role shape never appears.
    for (method, url) in [
        ("GET", "/api/token-usage/by-role/x"),
        ("GET", "/API/token-usage/by-role"),
        ("POST", "/api/token-usage/by-role"),
        ("GET", "/api/token-usage/by-role//"),
    ] {
        let response = gateway.request(method, url);
        assert_eq!(response.status, 200, "{method} {url}: {}", response.body);
        assert_eq!(response.body, "ok", "{method} {url} was answered in Rust");
        assert_eq!(
            response.header("content-type"),
            Some("text/plain"),
            "{method} {url}"
        );
    }
    // Only the claimed request crossed the host port.
    assert_eq!(
        gateway.host_calls(),
        vec![json!({ "op": "snapshot", "session": "sess-1" })]
    );
}

#[test]
fn host_call_payloads_are_exact_and_ordered() {
    let gateway = Gateway::start(
        "payloads",
        json!({ "tokenUsage": { "snapshots": { "s1": sample_snapshot() } } }),
    );
    for url in [
        "/api/token-usage/by-role?session=s1",
        "/api/token-usage/by-role",
        "/api/token-usage/by-role?session=",
        "/api/token-usage/by-role?session=s%2F2",
    ] {
        let response = gateway.get(url);
        assert_eq!(response.status, 200, "{url}: {}", response.body);
    }
    let calls = gateway.host_calls();
    assert_eq!(
        calls,
        vec![
            json!({ "op": "snapshot", "session": "s1" }),
            json!({ "op": "ledger" }),
            json!({ "op": "ledger" }),
            json!({ "op": "snapshot", "session": "s/2" }),
        ]
    );
    // Nothing beyond `op` (and `session` for a snapshot) is ever sent.
    for call in &calls {
        let keys = call.as_object().unwrap().len();
        let expected = if call["op"] == "snapshot" { 2 } else { 1 };
        assert_eq!(keys, expected, "unexpected host payload: {call}");
    }
}
