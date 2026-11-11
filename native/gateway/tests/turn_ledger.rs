//! Integration coverage for the terminal turn-ledger diagnostics retired from
//! `src/turn-ledger/runtime.js` and answered by the Rust front door
//! (`native/gateway/src/app/turn_ledger.rs`):
//!
//!   GET/HEAD/OPTIONS  /api/sessions/:id/turn-ledger
//!   GET/HEAD/OPTIONS  /api/sessions/:id/turn-hooks/codex-trust
//!   POST              /api/sessions/:id/turn-hooks/codex-trust
//!
//! The Node process here is only the protocol fixture (PROXY v1 + auth
//! control): it answers `POST /api/__host/turn-ledger` from
//! `script.turnLedger` (`FIXTURE_HOST_SCRIPT`) and appends every request body
//! to `turn-ledger-calls.jsonl`. Path matching, the decoded `:id`, the 409, the
//! snapshot DTO and the 502 are Rust and are what these tests assert.

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

fn unique(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "multicc-gateway-turn-ledger-{}-{tag}-{nanos}",
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
    raw_body: Vec<u8>,
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

    fn set_script(&self, script: Value) {
        fs::write(self.dir.join("host-script.json"), script.to_string()).unwrap();
    }

    /// Every `POST /api/__host/turn-ledger` body the fixture received, in order.
    fn host_calls(&self) -> Vec<Value> {
        fs::read_to_string(self.state.join("turn-ledger-calls.jsonl"))
            .unwrap_or_default()
            .lines()
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn fixture_requests(&self) -> Vec<Value> {
        fs::read_to_string(self.state.join("requests.log"))
            .unwrap_or_default()
            .lines()
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn forwarded(&self, method: &str, url: &str) -> bool {
        self.fixture_requests().iter().any(|entry| {
            entry["method"].as_str() == Some(method) && entry["url"].as_str() == Some(url)
        })
    }

    fn exchange(&self, method: &str, url: &str, extra: &[(&str, &str)]) -> Response {
        let mut host = "localhost";
        let mut request_id = "diff-req-1";
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
        let request = format!(
            "{method} {url} HTTP/1.1\r\nHost: {host}\r\nX-Request-Id: {request_id}\r\n\
             {lines}Connection: close\r\n\r\n"
        );
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
        let raw_body = raw[split + 4..].to_vec();
        Response {
            status,
            headers,
            body: String::from_utf8_lossy(&raw_body).into_owned(),
            raw_body,
        }
    }

    fn request(&self, method: &str, url: &str) -> Response {
        self.exchange(method, url, &[])
    }

    fn get(&self, url: &str) -> Response {
        self.exchange("GET", url, &[])
    }

    fn get_with(&self, url: &str, extra: &[(&str, &str)]) -> Response {
        self.exchange("GET", url, extra)
    }

    fn head(&self, url: &str) -> Response {
        self.exchange("HEAD", url, &[])
    }

    fn options(&self, url: &str) -> Response {
        self.exchange("OPTIONS", url, &[])
    }
}

impl Drop for Gateway {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn gunzip(bytes: &[u8]) -> String {
    let mut text = String::new();
    GzDecoder::new(bytes)
        .read_to_string(&mut text)
        .expect("valid gzip body");
    text
}

const JSON: &str = "application/json; charset=utf-8";

/// The codex launch both sides describe.
fn codex_launch() -> Value {
    json!({
        "epoch": 2, "cli": "codex", "launchedAt": 1700000000000_i64,
        "cwd": "/w/s1", "codexHome": "/h/s1",
    })
}

/// One raw ledger record: the fields the host port carries.
fn record(state: &str, ownership: &str) -> Value {
    json!({
        "sessionId": "s1", "epoch": 2, "cli": "codex", "cliSessionId": "c1", "cliPid": 42,
        "ownership": ownership, "turnId": "t1", "state": state, "evidence": "none",
        "boundary": null, "pendingUserInput": false, "backgroundPending": false,
        "stopPending": true, "promptHead": "Do it", "needsReview": false,
        "lastEventAt": 0, "lastTransitionId": "s1:2:t1:1:E",
    })
}

// ── /turn-ledger ────────────────────────────────────────────────────────────

#[test]
fn ledger_answers_the_shadow_envelope_and_projects_the_snapshot() {
    let gateway = Gateway::start(
        "ledger",
        json!({ "turnLedger": { "launches": { "s1": codex_launch() }, "records": { "s1": record("E", "running") } } }),
    );
    let response = gateway.get("/api/sessions/s1/turn-ledger");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.header("content-type"), Some(JSON));
    assert_eq!(
        response.body,
        concat!(
            r#"{"shadow":true,"#,
            r#""launch":{"epoch":2,"cli":"codex","launchedAt":1700000000000,"cwd":"/w/s1","codexHome":"/h/s1"},"#,
            r#""snapshot":{"sessionId":"s1","epoch":2,"cli":"codex","cliSessionId":"c1","cliPid":42,"#,
            r#""ownership":"running","liveness":{"state":"active","reason":"turn_ledger_running"},"#,
            r#""turnId":"t1","state":"E","evidence":"none","reason":"unknown-interruption","#,
            r#""boundary":null,"pendingUserInput":false,"backgroundPending":false,"stopPending":true,"#,
            r#""promptHead":"Do it","needsReview":false,"lastEventAt":null,"#,
            r#""lastTransitionId":"s1:2:t1:1:E"}}"#,
        )
    );
    assert_eq!(
        gateway.host_calls(),
        vec![json!({ "op": "ledger", "sessionId": "s1" })]
    );

    // A boundary survives as `reason`; a yielding owner projects inactive.
    gateway.set_script(json!({ "turnLedger": {
        "launches": {},
        "records": { "s1": {
            "sessionId": "s1", "epoch": 2, "cli": "codex", "cliSessionId": null, "cliPid": null,
            "ownership": "yielding", "turnId": "t1", "state": "E", "evidence": "none",
            "boundary": "api-error", "pendingUserInput": false, "backgroundPending": false,
            "stopPending": false, "promptHead": null, "needsReview": false,
            "lastEventAt": 1700000000000_i64, "lastTransitionId": null,
        } },
    } }));
    let body = gateway.get("/api/sessions/s1/turn-ledger").json();
    assert_eq!(body["launch"], Value::Null);
    assert_eq!(body["snapshot"]["reason"], json!("api-error"));
    assert_eq!(
        body["snapshot"]["liveness"],
        json!({ "state": "inactive", "reason": "turn_ledger_yielding" })
    );
    assert_eq!(body["snapshot"]["lastEventAt"], json!(1700000000000_i64));
    assert_eq!(
        body["snapshot"]["cliSessionId"],
        Value::Null,
        "a missing field serializes as null"
    );
}

#[test]
fn ledger_without_a_record_or_launch_answers_nulls() {
    let gateway = Gateway::start("ledger-empty", json!({ "turnLedger": {} }));
    let response = gateway.get("/api/sessions/nope/turn-ledger");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(
        response.body,
        r#"{"shadow":true,"launch":null,"snapshot":null}"#
    );

    // An unknown liveness projection for a record with no ownership.
    gateway.set_script(json!({ "turnLedger": { "records": { "nope": {} } } }));
    let body = gateway.get("/api/sessions/nope/turn-ledger/").json();
    assert_eq!(body["snapshot"]["state"], Value::Null);
    assert_eq!(
        body["snapshot"]["liveness"],
        json!({ "state": "unknown", "reason": "turn_ledger_no_evidence" })
    );
    assert_eq!(
        gateway.host_calls(),
        vec![
            json!({ "op": "ledger", "sessionId": "nope" }),
            json!({ "op": "ledger", "sessionId": "nope" }),
        ]
    );
}

// ── /turn-hooks/codex-trust ─────────────────────────────────────────────────

#[test]
fn trust_refuses_a_session_that_is_not_a_launched_codex_terminal() {
    let gateway = Gateway::start(
        "trust-refused",
        json!({ "turnLedger": { "launches": {
            "s2": { "epoch": 1, "cli": "claude", "launchedAt": 1, "cwd": "/w/s2" },
        } } }),
    );
    for url in [
        "/api/sessions/nope/turn-hooks/codex-trust",
        "/api/sessions/s2/turn-hooks/codex-trust",
        "/api/sessions/a%2Fb/turn-hooks/codex-trust",
    ] {
        let response = gateway.get(url);
        assert_eq!(response.status, 409, "{url}: {}", response.body);
        assert_eq!(response.header("content-type"), Some(JSON), "{url}");
        assert_eq!(
            response.body, r#"{"error":"not a launched codex terminal"}"#,
            "{url}"
        );
        let response = gateway.request("POST", url);
        assert_eq!(response.status, 409, "POST {url}: {}", response.body);
    }
    // The refusal never reached the trust op; `SID_RE` failures never asked at
    // all.
    assert_eq!(
        gateway.host_calls(),
        vec![
            json!({ "op": "launch", "sessionId": "nope" }),
            json!({ "op": "launch", "sessionId": "nope" }),
            json!({ "op": "launch", "sessionId": "s2" }),
            json!({ "op": "launch", "sessionId": "s2" }),
        ]
    );
}

#[test]
fn trust_reports_the_scripted_state_and_grant_writes_it() {
    let gateway = Gateway::start(
        "trust",
        json!({ "turnLedger": {
            "launches": { "s1": codex_launch() },
            "trust": { "ok": true, "value": { "state": "untrusted", "total": 1, "trusted": 0 } },
            "grant": { "ok": true, "value": { "state": "trusted", "total": 1, "trusted": 1 } },
        } }),
    );
    let response = gateway.get("/api/sessions/s1/turn-hooks/codex-trust");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(
        response.body,
        r#"{"state":"untrusted","total":1,"trusted":0}"#
    );
    let response = gateway.request("POST", "/api/sessions/s1/turn-hooks/codex-trust/");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(
        response.body,
        r#"{"state":"trusted","total":1,"trusted":1}"#
    );
    assert_eq!(
        gateway.host_calls(),
        vec![
            json!({ "op": "launch", "sessionId": "s1" }),
            json!({ "op": "trust", "write": false, "codexHome": "/h/s1", "cwd": "/w/s1" }),
            json!({ "op": "launch", "sessionId": "s1" }),
            json!({ "op": "trust", "write": true, "codexHome": "/h/s1", "cwd": "/w/s1" }),
        ]
    );
}

#[test]
fn trust_failures_answer_502_and_host_failures_answer_500() {
    let gateway = Gateway::start(
        "trust-failure",
        json!({ "turnLedger": {
            "launches": { "s1": codex_launch() },
            "trust": { "ok": false, "message": "codex app-server timed out" },
            "grant": { "ok": false, "message": "codex app-server exited" },
        } }),
    );
    let response = gateway.get("/api/sessions/s1/turn-hooks/codex-trust");
    assert_eq!(response.status, 502, "{}", response.body);
    assert_eq!(response.header("content-type"), Some(JSON));
    assert_eq!(response.body, r#"{"error":"codex app-server timed out"}"#);
    let response = gateway.request("POST", "/api/sessions/s1/turn-hooks/codex-trust");
    assert_eq!(response.status, 502, "{}", response.body);
    assert_eq!(response.body, r#"{"error":"codex app-server exited"}"#);

    // A malformed trust answer still answers 502 with the fallback message.
    gateway.set_script(
        json!({ "turnLedger": { "launches": { "s1": codex_launch() }, "trust": { "ok": false } } }),
    );
    let response = gateway.get("/api/sessions/s1/turn-hooks/codex-trust");
    assert_eq!(response.status, 502, "{}", response.body);
    assert_eq!(response.body, r#"{"error":"codex app-server failed"}"#);

    // The host port itself gone: the retired handler would have thrown inside
    // the route, so the answer is the generic internal error.
    let gateway = {
        let mut script = json!({ "turnLedger": { "launches": { "s1": codex_launch() } } });
        script["hostDown"] = json!(true);
        gateway.set_script(script);
        gateway
    };
    for url in [
        "/api/sessions/s1/turn-hooks/codex-trust",
        "/api/sessions/s1/turn-ledger",
    ] {
        let response = gateway.get(url);
        assert_eq!(response.status, 500, "{url}: {}", response.body);
        let body = response.json();
        assert_eq!(body["ok"], json!(false), "{url}");
        assert_eq!(body["error"], json!("internal_error"), "{url}");
        assert_eq!(body["code"], json!("internal_error"), "{url}");
    }
}

// ── Express behavior ────────────────────────────────────────────────────────

#[test]
fn options_lists_the_methods_each_path_registers() {
    let gateway = Gateway::start("options", json!({ "turnLedger": {} }));
    let response = gateway.options("/api/sessions/s1/turn-ledger");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.header("allow"), Some("GET,HEAD"));
    assert_eq!(response.body, "GET,HEAD");

    let response = gateway.options("/api/sessions/s1/turn-hooks/codex-trust");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.header("allow"), Some("GET,HEAD,POST"));
    assert_eq!(response.body, "GET,HEAD,POST");
    assert!(
        gateway.host_calls().is_empty(),
        "OPTIONS never asks the host"
    );
}

#[test]
fn head_and_gzip_follow_express() {
    let gateway = Gateway::start(
        "head-gzip",
        json!({ "turnLedger": {
            "launches": { "s1": codex_launch() },
            "records": { "s1": record("P", "running") },
        } }),
    );
    let full = gateway.get("/api/sessions/s1/turn-ledger");
    let head = gateway.head("/api/sessions/s1/turn-ledger");
    assert_eq!(head.status, 200);
    assert!(head.raw_body.is_empty(), "HEAD has no body");
    assert_eq!(head.header("content-length"), full.header("content-length"));
    assert_eq!(head.header("etag"), full.header("etag"));

    // The snapshot body is small, so gzip is negotiated but not applied; Vary
    // is still stamped on every JSON /api response.
    let response = gateway.get_with(
        "/api/sessions/s1/turn-ledger",
        &[("Accept-Encoding", "gzip, deflate")],
    );
    assert_eq!(response.header("vary"), Some("Accept-Encoding"));
    assert_eq!(response.header("content-encoding"), None);
    let compressed = gateway.get_with(
        "/api/sessions/s1/turn-ledger",
        &[("Accept-Encoding", "gzip")],
    );
    assert_eq!(compressed.status, 200);
    assert_eq!(
        gunzip_if_any(&compressed),
        full.body,
        "a compressed body is the same JSON"
    );

    // HEAD on the trust path answers from the GET route.
    gateway.set_script(json!({ "turnLedger": { "launches": { "s1": codex_launch() }, "trust": { "ok": true, "value": { "state": "trusted" } } } }));
    let head = gateway.head("/api/sessions/s1/turn-hooks/codex-trust");
    assert_eq!(head.status, 200);
    assert!(head.raw_body.is_empty());
    assert_eq!(head.header("content-length"), Some("19"));
}

fn gunzip_if_any(response: &Response) -> String {
    if response.header("content-encoding") == Some("gzip") {
        gunzip(&response.raw_body)
    } else {
        response.body.clone()
    }
}

#[test]
fn ids_are_decoded_and_unregistered_shapes_are_forwarded() {
    let gateway = Gateway::start(
        "paths",
        json!({ "turnLedger": {
            "launches": {
                "Abc": { "epoch": 1, "cli": "codex", "launchedAt": 1, "cwd": null, "codexHome": "/h/abc" },
            },
            "records": { "My Session": record("P", "running") },
            "trust": { "ok": true, "value": { "state": "trusted" } },
        } }),
    );
    // The trust path decodes `:id` before the launch table and the `SID_RE`
    // gate see it.
    let response = gateway.get("/api/sessions/%41bc/turn-hooks/codex-trust");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(
        gateway.host_calls(),
        vec![
            json!({ "op": "launch", "sessionId": "Abc" }),
            json!({ "op": "trust", "write": false, "codexHome": "/h/abc", "cwd": null }),
        ]
    );

    // The ledger path has no `SID_RE` gate, so an encoded space reaches the
    // record table as the decoded id. Case-insensitive literals and one
    // optional trailing slash are claimed; everything else falls through to
    // Node.
    let claimed = gateway.get("/api/Sessions/My%20Session/Turn-Ledger/");
    assert_eq!(claimed.status, 200, "{}", claimed.body);
    assert_eq!(claimed.json()["snapshot"]["sessionId"], json!("s1"));
    for (method, url) in [
        ("GET", "/api/sessions/s1/turn-ledger/extra"),
        ("GET", "/api/sessions//turn-ledger"),
        ("GET", "/api/sessions/s1/turn-ledger//"),
        ("POST", "/api/sessions/s1/turn-ledger"),
        ("DELETE", "/api/sessions/s1/turn-hooks/codex-trust"),
        ("GET", "/API/sessions/s1/turn-ledger"),
    ] {
        let response = gateway.request(method, url);
        assert_eq!(response.status, 200, "{method} {url}: {}", response.body);
        assert_eq!(response.body, "ok", "{method} {url} was answered in Rust");
        assert!(
            gateway.forwarded(method, url),
            "{method} {url} never reached Node"
        );
    }
}

#[test]
fn auth_gate_refuses_an_external_host_without_a_token() {
    let gateway = Gateway::start("auth", json!({ "turnLedger": {} }));
    let response = gateway.get_with(
        "/api/sessions/s1/turn-ledger",
        &[("Host", "remote.example.com")],
    );
    assert_eq!(response.status, 403, "{}", response.body);
    let body = response.json();
    assert_eq!(body["error"], json!("Forbidden: not authenticated"));
    assert_eq!(body["code"], json!("AUTH_REQUIRED"));
    assert!(gateway.host_calls().is_empty());
}
