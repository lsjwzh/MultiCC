//! Integration coverage for the twenty-two quota & pricing routes against the
//! real `multicc-gateway` binary:
//!
//!   GET|HEAD /api/pricing/status   GET|HEAD /api/pricing/lookup
//!   POST     /api/pricing/refresh  GET|HEAD /api/pricing/search
//!   GET|HEAD /api/opencode/quota   POST     /api/opencode/quota/login
//!   GET|HEAD /api/qoder/quota      POST     /api/qoder/quota/login
//!   GET|HEAD /api/qoder/quota/cookies
//!   GET|HEAD /api/codex/quota
//!   GET|HEAD /api/ark/quota        POST     /api/ark/quota/login
//!   POST     /api/ark/quota/install
//!   GET|HEAD /api/kimi/quota       POST     /api/kimi/quota/login
//!   GET|HEAD /api/claude/quota     POST     /api/claude/quota/login
//!   GET|HEAD /api/aliyun/quota     POST     /api/aliyun/quota/login
//!   GET|HEAD /api/quota/bars/idle  GET|HEAD /api/quota/bars/state
//!   POST     /api/quota/bars/refresh
//!
//! The Node process here is only the protocol fixture (PROXY v1 + auth
//! control): it answers `POST /api/__host/quota` from `script.quota.ops[op]`
//! (`FIXTURE_HOST_SCRIPT`) and appends every request body to
//! `quota-calls.jsonl`. Path matching (including Express's case-insensitive
//! routes and automatic OPTIONS), query/body extraction, every status map, the
//! DTO envelopes and key order, ETag/304/gzip and the 503 surface are Rust and
//! are what these tests assert. The online byte comparison against the frozen
//! Node handlers lives in docs/rust-migration/differential/quota-routes.js.

use std::fs;
use std::io::{Read, Write};
use std::net::TcpStream;
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

fn unique(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "multicc-gateway-quota-{}-{tag}-{nanos}",
        std::process::id()
    ))
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
        fs::write(&script_path, json!({ "quota": { "ops": {} } }).to_string()).unwrap();
        let log = fs::File::create(dir.join("gateway.log")).unwrap();
        let mut command = Command::new(GATEWAY_BIN);
        command
            .arg("serve")
            .arg("--cwd")
            .arg(&dir)
            .arg("--ephemeral-loopback")
            .arg("--node")
            .arg(std::env::var("MULTICC_TEST_NODE").unwrap_or_else(|_| "node".to_string()))
            .arg("server.js")
            .env_clear()
            .env(
                "PATH",
                std::env::var_os("PATH").unwrap_or_else(|| "/usr/local/bin:/usr/bin:/bin".into()),
            )
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
        let mut gateway = Self {
            dir,
            state,
            port: 0,
            child,
        };
        let deadline = Instant::now() + Duration::from_secs(15);
        while gateway.port == 0 || !gateway.state.join("ready").exists() {
            let log = gateway.log();
            if let Some(port) = log.lines().find_map(|line| {
                let rest = line.split_once("listening on 127.0.0.1:")?.1;
                rest.chars()
                    .take_while(char::is_ascii_digit)
                    .collect::<String>()
                    .parse()
                    .ok()
            }) {
                gateway.port = port;
            }
            if let Some(status) = gateway.child.try_wait().unwrap() {
                panic!("gateway exited early ({status})\n{log}");
            }
            assert!(
                Instant::now() < deadline,
                "gateway never became ready\n{}",
                log
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

    /// One answer per host op, wrapped as the fixture does.
    fn ops(&self, ops: Value) {
        self.set_script(json!({ "quota": { "ops": ops } }));
    }

    fn ops_down(&self) {
        self.set_script(json!({ "hostDown": true }));
    }

    /// One op whose Node implementation threw (the host answers `{ok:false}`).
    fn fail(&self, op: &str) {
        let mut fail = serde_json::Map::new();
        fail.insert(
            op.to_string(),
            json!({ "code": "EACCES", "message": "denied" }),
        );
        self.set_script(json!({ "quota": { "fail": fail } }));
    }

    /// One answer for one op, with a key that is not a literal.
    fn op(&self, op: &str, answer: Value) {
        let mut ops = serde_json::Map::new();
        ops.insert(op.to_string(), answer);
        self.set_script(json!({ "quota": { "ops": ops } }));
    }

    /// Every `POST /api/__host/quota` body the fixture received, in order.
    fn host_calls(&self) -> Vec<Value> {
        fs::read_to_string(self.state.join("quota-calls.jsonl"))
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
}

impl Drop for Gateway {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn vendor_result(status: &str) -> Value {
    json!({
        "status": status,
        "fetchedAt": 1_700_000_000_000_i64,
        "usage": {
            "rolling": { "status": "ok", "resetInSec": 4_102_444_800_i64, "usagePercent": 21 },
            "weekly": { "status": "ok", "resetInSec": 4_102_444_800_i64, "usagePercent": 33 },
            "monthly": { "status": "ok", "resetInSec": 4_102_444_800_i64, "usagePercent": 44 },
            "useBalance": false
        }
    })
}

fn assert_no_generic_500(response: &Response) {
    if response.status == 500 {
        assert!(
            !response.text().contains("\"code\":\"internal_error\""),
            "unexpected generic 500: {}",
            response.text()
        );
    }
}

// ── Express's automatic OPTIONS ─────────────────────────────────────────────

#[test]
fn options_answers_every_registered_path() {
    let gateway = Gateway::start("options");
    let cases = [
        ("/api/pricing/status", "GET,HEAD"),
        ("/api/pricing/lookup", "GET,HEAD"),
        ("/api/pricing/refresh", "POST"),
        ("/api/pricing/search", "GET,HEAD"),
        ("/api/opencode/quota", "GET,HEAD"),
        ("/api/opencode/quota/login", "POST"),
        ("/api/qoder/quota", "GET,HEAD"),
        ("/api/qoder/quota/login", "POST"),
        ("/api/qoder/quota/cookies", "GET,HEAD"),
        ("/api/codex/quota", "GET,HEAD"),
        ("/api/ark/quota", "GET,HEAD"),
        ("/api/ark/quota/login", "POST"),
        ("/api/ark/quota/install", "POST"),
        ("/api/kimi/quota", "GET,HEAD"),
        ("/api/kimi/quota/login", "POST"),
        ("/api/claude/quota", "GET,HEAD"),
        ("/api/claude/quota/login", "POST"),
        ("/api/aliyun/quota", "GET,HEAD"),
        ("/api/aliyun/quota/login", "POST"),
        ("/api/quota/bars/idle", "GET,HEAD"),
        ("/api/quota/bars/state", "GET,HEAD"),
        ("/api/quota/bars/refresh", "POST"),
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
    // Express matches its route paths case-insensitively.
    let upper = gateway.options("/api/PRICING/STATUS");
    assert_eq!(upper.status, 200);
    assert_eq!(upper.header("allow"), Some("GET,HEAD"));
}

// ── pricing ────────────────────────────────────────────────────────────────

#[test]
fn pricing_reads_wrap_the_host_answer() {
    let gateway = Gateway::start("pricing-reads");
    gateway.ops(json!({
        "pricing.status": { "status": { "loaded": true, "entries": 3 } },
        "pricing.lookup": { "prices": { "a": 1 }, "status": { "loaded": true, "entries": 3 } },
        "pricing.search": { "results": [{ "id": "a" }], "status": { "loaded": true, "entries": 3 } }
    }));

    let status = gateway.get("/api/pricing/status");
    assert_eq!(status.status, 200);
    assert_eq!(status.header("content-type"), Some(JSON));
    assert_eq!(
        status.text(),
        r#"{"ok":true,"status":{"loaded":true,"entries":3}}"#
    );

    // The list is split on commas, trimmed and de-duplicated.
    let lookup = gateway.get("/api/pricing/lookup?models=%20a%20,,b,a");
    assert_eq!(lookup.status, 200);
    assert_eq!(
        lookup.text(),
        r#"{"ok":true,"prices":{"a":1},"status":{"loaded":true,"entries":3}}"#
    );
    let search = gateway.get("/api/pricing/search?q=%20x%20&limit=100");
    assert_eq!(search.status, 200);
    assert_eq!(
        search.text(),
        r#"{"ok":true,"query":"x","count":1,"results":[{"id":"a"}],"status":{"loaded":true,"entries":3}}"#
    );

    // A repeated `models` parameter is an array in JS, never a string, so the
    // list is empty and the refusal happens before the host is asked.
    let repeated = gateway.get("/api/pricing/lookup?models=a&models=b");
    assert_eq!(repeated.status, 400);
    assert_eq!(repeated.json()["error"], json!("models_required"));

    let calls = gateway.host_calls();
    let ops: Vec<&str> = calls
        .iter()
        .map(|call| call["op"].as_str().unwrap())
        .collect();
    assert_eq!(ops, ["pricing.status", "pricing.lookup", "pricing.search"]);
    assert_eq!(calls[1]["models"], json!(["a", "b"]));
    assert_eq!(calls[2]["query"], json!("x"));
    assert_eq!(calls[2]["limit"], json!(50));

    // Express's routing: case-insensitive segments and an optional trailing
    // slash both reach the same handler.
    assert_eq!(gateway.get("/api/PRICING/STATUS").status, 200);
    assert_eq!(gateway.get("/api/pricing/status/").status, 200);

    // An unparsable limit falls back to 20; a missing query searches nothing.
    let defaulted = gateway.get("/api/pricing/search?limit=abc");
    assert_eq!(defaulted.status, 200);
    assert_eq!(gateway.host_calls().last().unwrap()["limit"], json!(20));
    assert_eq!(gateway.host_calls().last().unwrap()["query"], json!(""));
}

#[test]
fn pricing_refusals_never_reach_the_host() {
    let gateway = Gateway::start("pricing-refusals");
    gateway.ops(json!({}));
    let before = gateway.host_calls().len();

    let missing = gateway.get("/api/pricing/lookup");
    assert_eq!(missing.status, 400);
    assert_eq!(
        missing.text(),
        r#"{"ok":false,"error":"models_required","max":50}"#
    );

    let empty = gateway.get("/api/pricing/lookup?models=");
    assert_eq!(empty.status, 400);
    assert_eq!(empty.json()["error"], json!("models_required"));

    let many: Vec<String> = (0..51).map(|index| format!("m{index}")).collect();
    let too_many = gateway.get(&format!("/api/pricing/lookup?models={}", many.join(",")));
    assert_eq!(too_many.status, 400);
    assert_eq!(
        too_many.text(),
        r#"{"ok":false,"error":"too_many_models","max":50}"#
    );

    let long = gateway.get(&format!("/api/pricing/lookup?models={}", "x".repeat(101)));
    assert_eq!(long.status, 400);
    assert_eq!(
        long.text(),
        r#"{"ok":false,"error":"model_too_long","max":100}"#
    );

    // The length cap counts UTF-16 units, like `model.length`.
    let wide = gateway.get(&format!("/api/pricing/lookup?models={}", "额".repeat(101)));
    assert_eq!(wide.status, 400);
    assert_eq!(wide.json()["error"], json!("model_too_long"));

    assert_eq!(gateway.host_calls().len(), before);
}

#[test]
fn pricing_refresh_reads_the_query_then_the_body() {
    let gateway = Gateway::start("pricing-refresh");
    gateway.ops(json!({
        "pricing.refresh": { "status": { "loaded": true, "entries": 3, "fetchedAt": 5 } }
    }));
    let body = r#"{"force":true}"#;

    let by_query = gateway.post("/api/pricing/refresh?force=1", None);
    assert_eq!(by_query.status, 200);
    assert_eq!(
        by_query.text(),
        r#"{"ok":true,"status":{"loaded":true,"entries":3,"fetchedAt":5}}"#
    );
    assert_eq!(gateway.host_calls().last().unwrap()["force"], json!(true));

    let by_body = gateway.post("/api/pricing/refresh", Some(body));
    assert_eq!(by_body.status, 200);
    assert_eq!(gateway.host_calls().last().unwrap()["force"], json!(true));

    // A non-empty query string is truthy in JS and wins over the body, but
    // only the literal "1" turns force on.
    let by_zero = gateway.post("/api/pricing/refresh?force=0", Some(r#"{"force":"1"}"#));
    assert_eq!(by_zero.status, 200);
    assert_eq!(gateway.host_calls().last().unwrap()["force"], json!(false));
    // The body's boolean `true` is the second arm and always counts.
    let by_boolean = gateway.post("/api/pricing/refresh?force=0", Some(body));
    assert_eq!(by_boolean.status, 200);
    assert_eq!(gateway.host_calls().last().unwrap()["force"], json!(true));

    let string_true = gateway.post("/api/pricing/refresh", Some(r#"{"force":"true"}"#));
    assert_eq!(string_true.status, 200);
    assert_eq!(gateway.host_calls().last().unwrap()["force"], json!(false));

    // The retired handler never caught a throwing refresh: safeErrorHandler
    // answered with its generic envelope, and so does the front door.
    gateway.fail("pricing.refresh");
    let failed = gateway.post("/api/pricing/refresh", None);
    assert_eq!(failed.status, 500);
    let body = failed.json();
    assert_eq!(body["ok"], json!(false));
    assert_eq!(body["error"], json!("internal_error"));
    assert_eq!(body["code"], json!("internal_error"));
    assert!(body["apiVersion"].is_string());
}

// ── vendor quota reads ─────────────────────────────────────────────────────

#[test]
fn vendor_quota_statuses_follow_the_retired_maps() {
    let gateway = Gateway::start("vendor-statuses");
    gateway.ops(json!({
        "opencode.quota": { "result": vendor_result("ok") },
        "qoder.quota": { "result": { "status": "needs_login", "error": "qoder login required" } },
        "codex.quota": { "result": { "status": "no_auth", "error": "未找到 ~/.codex/auth.json" } },
        "ark.quota": { "result": { "status": "needs_install", "error": "arkcli not found on PATH" } },
        "kimi.quota": { "result": { "status": "not_configured", "error": "no kimi key" }, "cached": null },
        "aliyun.quota": { "result": { "status": "chrome_unavailable", "error": "no chrome" } }
    }));

    let opencode = gateway.get("/api/opencode/quota");
    assert_eq!(opencode.status, 200);
    let body = opencode.json();
    assert_eq!(body["status"], json!("ok"));
    assert!(!body["bar"]["text"].as_str().unwrap().is_empty());
    // `{...result, bar}` keeps the result's own key order and appends `bar`.
    let text = opencode.text();
    assert_eq!(text.find("\"bar\""), text.rfind("\"bar\""));

    assert_eq!(gateway.get("/api/qoder/quota").status, 401);
    assert_eq!(gateway.get("/api/codex/quota").status, 401);
    assert_eq!(gateway.get("/api/ark/quota").status, 404);
    assert_eq!(gateway.get("/api/kimi/quota").status, 404);
    assert_eq!(gateway.get("/api/aliyun/quota").status, 503);
    // The Aliyun route never carried a bar.
    assert!(gateway.get("/api/aliyun/quota").json().get("bar").is_none());

    // `unavailable` maps to 500 for the bar vendors and to 502 for kimi and
    // aliyun, which have no 500 arm in their retired status maps.
    gateway.ops(json!({
        "opencode.quota": { "result": { "status": "unavailable", "error": "script tags missing" } },
        "kimi.quota": { "result": { "status": "unavailable", "error": "all kimi fetches failed" }, "cached": null },
        "aliyun.quota": { "result": { "status": "unavailable", "error": "console panel missing" } }
    }));
    assert_eq!(gateway.get("/api/kimi/quota").status, 502);
    assert_eq!(gateway.get("/api/aliyun/quota").status, 502);
    assert_eq!(gateway.get("/api/opencode/quota").status, 500);
}

#[test]
fn vendor_quota_failures_render_the_retired_catch_arms() {
    let gateway = Gateway::start("vendor-throws");
    // The host catches every vendor fetcher throw itself and answers a value
    // (`{threw:true}`); only an op that throws around the fetch is a refusal.
    gateway.ops(json!({
        "opencode.quota": { "threw": true },
        "kimi.quota": { "threw": true, "cached": null },
        "aliyun.quota": { "threw": true }
    }));
    let opencode = gateway.get("/api/opencode/quota");
    assert_eq!(opencode.status, 500);
    assert_eq!(
        opencode.json()["error"],
        json!("opencode quota fetch failed")
    );
    assert!(!opencode.text().contains("internal_error"));
    assert!(opencode.json()["bar"].is_object());

    let kimi = gateway.get("/api/kimi/quota?host=API.moonshot.cn");
    assert_eq!(kimi.status, 500);
    assert_eq!(kimi.json()["error"], json!("kimi quota fetch failed"));
    assert!(kimi.json()["bar"].is_object());
    // The route never lowercases (that is the bars route's rule), and a
    // repeated parameter is an array: only a plain string is a selector.
    let call = gateway.host_calls().last().cloned().unwrap();
    assert_eq!(call["op"], json!("kimi.quota"));
    assert_eq!(call["host"], json!("API.moonshot.cn"));
    assert_eq!(call["rawHost"], json!("API.moonshot.cn"));
    assert_eq!(gateway.get("/api/kimi/quota?host=a&host=b").status, 500);
    let repeated = gateway.host_calls().last().cloned().unwrap();
    assert_eq!(repeated["host"], json!(""));
    assert_eq!(repeated["rawHost"], json!(["a", "b"]));

    let aliyun = gateway.get("/api/aliyun/quota");
    assert_eq!(aliyun.status, 500);
    assert_eq!(
        aliyun.text(),
        r#"{"status":"unavailable","error":"aliyun quota fetch failed"}"#
    );
}

#[test]
fn codex_account_selector_resolves_before_the_fetch() {
    let gateway = Gateway::start("codex-account");
    gateway.ops(json!({ "codex.quota": { "result": { "status": "no_auth", "error": "账号不存在" }, "mode": null } }));
    let before = gateway.host_calls().len();

    let disabled = gateway.get("/api/codex/quota?account=acct-1");
    // Without `mode` the front door asks the host; the host decides. A
    // disabled account table and a missing file are the two refusals.
    assert_eq!(disabled.status, 401);
    assert_eq!(gateway.host_calls().len(), before + 1);
    assert_eq!(gateway.host_calls()[before]["account"], json!("acct-1"));

    gateway.ops(json!({ "codex.quota": { "mode": "disabled" } }));
    let refused = gateway.get("/api/codex/quota?account=acct-1");
    assert_eq!(refused.status, 400);
    assert_eq!(
        refused.text(),
        r#"{"status":"unavailable","error":"official accounts not enabled"}"#
    );

    gateway.ops(json!({ "codex.quota": { "mode": "missing" } }));
    let missing = gateway.get("/api/codex/quota?account=acct-9");
    assert_eq!(missing.status, 404);
    assert_eq!(
        missing.text(),
        r#"{"status":"no_auth","error":"账号不存在"}"#
    );

    // The account id is trimmed before it crosses the host port.
    gateway.ops(json!({ "codex.quota": { "result": vendor_result("ok") } }));
    assert_eq!(
        gateway.get("/api/codex/quota?account=%20acct-1%20").status,
        200
    );
    assert_eq!(
        gateway.host_calls().last().unwrap()["account"],
        json!("acct-1")
    );
    assert_eq!(gateway.get("/api/codex/quota").status, 200);
    assert_eq!(gateway.host_calls().last().unwrap()["account"], json!(""));
}

// ── logins ─────────────────────────────────────────────────────────────────

#[test]
fn logins_open_a_window_or_report_the_refusal() {
    let gateway = Gateway::start("logins");
    let cases = [
        ("/api/opencode/quota/login", "opencode.login", "opencode.ai"),
        ("/api/qoder/quota/login", "qoder.login", "qoder.com.cn"),
        ("/api/kimi/quota/login", "kimi.login", "kimi.com"),
        ("/api/claude/quota/login", "claude.login", "claude.ai"),
        ("/api/aliyun/quota/login", "aliyun.login", "阿里云"),
    ];
    for (path, op, needle) in cases {
        gateway.op(op, Value::Null);
        let response = gateway.post(path, None);
        assert_eq!(response.status, 200, "{path}");
        let body = response.json();
        assert_eq!(body["ok"], json!(true));
        assert!(body["message"].as_str().unwrap().contains(needle));
        assert_eq!(gateway.host_calls().last().unwrap()["op"], json!(op));
    }

    // `chrome_unavailable` is the only code that becomes a 503; anything else
    // is a 500 carrying `err.code` (or the fallback) and `err.message`.
    gateway.set_script(json!({ "quota": { "fail": {
        "opencode.login": { "code": "chrome_unavailable", "message": "没有可连的 Chrome" }
    } } }));
    let down = gateway.post("/api/opencode/quota/login", None);
    assert_eq!(down.status, 503);
    assert_eq!(
        down.text(),
        r#"{"ok":false,"error":"chrome_unavailable","message":"没有可连的 Chrome"}"#
    );

    gateway.set_script(json!({ "quota": { "fail": {
        "kimi.login": { "message": "profile is locked" }
    } } }));
    let generic = gateway.post("/api/kimi/quota/login", None);
    assert_eq!(generic.status, 500);
    assert_eq!(
        generic.text(),
        r#"{"ok":false,"error":"login_window_failed","message":"profile is locked"}"#
    );
}

#[test]
fn ark_login_and_install_branch_on_arkcli() {
    let gateway = Gateway::start("ark-login");

    gateway.ops(json!({ "ark.login": { "mode": "needs_install" } }));
    let missing = gateway.post("/api/ark/quota/login", None);
    assert_eq!(missing.status, 404);
    assert_eq!(
        missing.text(),
        r#"{"status":"needs_install","error":"arkcli not found on PATH"}"#
    );

    gateway.ops(json!({ "ark.login": { "status": "started", "pid": 7788 } }));
    let started = gateway.post("/api/ark/quota/login", None);
    assert_eq!(started.status, 200);
    assert_eq!(started.text(), r#"{"status":"started","pid":7788}"#);

    gateway.ops(json!({ "ark.login": { "status": "started", "pid": 0 } }));
    let no_pid = gateway.post("/api/ark/quota/login", None);
    assert_eq!(no_pid.text(), r#"{"status":"started","pid":0}"#);

    gateway.ops(json!({ "ark.login": { "threw": true, "message": "EACCES: permission denied" } }));
    let spawned = gateway.post("/api/ark/quota/login", None);
    assert_eq!(spawned.status, 500);
    assert_eq!(
        spawned.text(),
        r#"{"status":"unavailable","error":"EACCES: permission denied"}"#
    );

    // A locator that throws is not caught by the retired handler at all.
    gateway.fail("ark.login");
    let locator = gateway.post("/api/ark/quota/login", None);
    assert_eq!(locator.status, 500);
    assert_eq!(locator.json()["code"], json!("internal_error"));

    gateway.ops(json!({ "ark.install": { "ok": true } }));
    let installed = gateway.post("/api/ark/quota/install", None);
    assert_eq!(installed.status, 200);
    assert_eq!(installed.text(), r#"{"status":"ok"}"#);

    gateway.ops(json!({ "ark.install": { "ok": false, "error": "npm exit 1" } }));
    let failed = gateway.post("/api/ark/quota/install", None);
    assert_eq!(failed.status, 500);
    assert_eq!(failed.text(), r#"{"status":"error","error":"npm exit 1"}"#);

    // `res.json({status:'error', error: undefined})` drops the member.
    gateway.ops(json!({ "ark.install": { "ok": false } }));
    let silent = gateway.post("/api/ark/quota/install", None);
    assert_eq!(silent.status, 500);
    assert_eq!(silent.text(), r#"{"status":"error"}"#);

    gateway.ops(json!({ "ark.install": { "threw": true, "message": "npm not found" } }));
    let threw = gateway.post("/api/ark/quota/install", None);
    assert_eq!(threw.status, 500);
    assert_eq!(
        threw.text(),
        r#"{"status":"error","error":"npm not found"}"#
    );

    gateway.ops(json!({ "ark.install": { "threw": true, "message": "" } }));
    let fallback = gateway.post("/api/ark/quota/install", None);
    assert_eq!(
        fallback.text(),
        r#"{"status":"error","error":"install failed"}"#
    );
}

#[test]
fn qoder_cookies_return_the_stored_object_or_404() {
    let gateway = Gateway::start("qoder-cookies");
    gateway.ops(json!({ "qoder.cookies": { "saved": { "cookieHeader": "sid=1", "savedAt": 5 } } }));
    let saved = gateway.get("/api/qoder/quota/cookies");
    assert_eq!(saved.status, 200);
    assert_eq!(saved.text(), r#"{"cookieHeader":"sid=1","savedAt":5}"#);

    gateway.ops(json!({ "qoder.cookies": { "saved": null } }));
    let missing = gateway.get("/api/qoder/quota/cookies");
    assert_eq!(missing.status, 404);
    assert_eq!(missing.text(), r#"{"ok":false,"error":"no saved cookies"}"#);

    // A throwing store is not caught by the retired handler.
    gateway.fail("qoder.cookies");
    let threw = gateway.get("/api/qoder/quota/cookies");
    assert_eq!(threw.status, 500);
    assert_eq!(threw.json()["code"], json!("internal_error"));
}

// ── claude usage ───────────────────────────────────────────────────────────

fn claude_usage() -> Value {
    json!({
        "status": "ok",
        "fetchedAt": 1_700_000_000_000_i64,
        "summary": [
            { "window": "1wk", "label": "All models", "usedPercent": 30, "resetMs": 4_102_444_800_000_i64 }
        ]
    })
}

#[test]
fn claude_quota_reads_the_queue_state() {
    let gateway = Gateway::start("claude-quota");
    gateway.ops(json!({
        "claude.quota": { "threw": false, "entry": false, "result": null, "live": null, "nowMs": 1_700_000_000_000_i64 }
    }));
    let idle = gateway.get("/api/claude/quota");
    assert_eq!(idle.status, 200);
    let body = idle.json();
    assert_eq!(body["status"], json!("idle"));
    assert!(body["bar"].is_object());
    // No reading means no recorder call.
    assert_eq!(gateway.host_calls().len(), 1);

    gateway.ops(json!({
        "claude.quota": {
            "threw": false,
            "entry": true,
            "result": { "status": "ok", "fetchedAt": 1_700_000_000_000_i64, "summary": claude_usage()["summary"] },
            "usage": claude_usage(),
            "live": null,
            "nowMs": 1_700_000_000_000_i64
        },
        "claude.record": null
    }));
    let read = gateway.get("/api/claude/quota?session=chat-1&force=1");
    assert_eq!(read.status, 200);
    let body = read.json();
    assert_eq!(body["status"], json!("ok"));
    assert!(body["bar"]["text"].as_str().unwrap().contains('%'));
    let calls = gateway.host_calls();
    assert_eq!(calls[calls.len() - 2]["op"], json!("claude.quota"));
    assert_eq!(calls[calls.len() - 2]["session"], json!("chat-1"));
    assert_eq!(calls[calls.len() - 2]["force"], json!(true));
    // `recordClaude(session, result, bar.text)`
    assert_eq!(calls[calls.len() - 1]["op"], json!("claude.record"));
    assert_eq!(calls[calls.len() - 1]["session"], json!("chat-1"));
    assert_eq!(calls[calls.len() - 1]["text"], body["bar"]["text"]);

    // Only the two documented spellings of force are honoured.
    assert_eq!(
        gateway
            .get("/api/claude/quota?session=chat-1&force=true")
            .status,
        200
    );
    assert_eq!(
        gateway.host_calls().last().unwrap()["op"],
        json!("claude.record")
    );
    let force_call = gateway
        .host_calls()
        .into_iter()
        .rev()
        .find(|call| call["op"] == json!("claude.quota"))
        .unwrap();
    assert_eq!(force_call["force"], json!(true));

    gateway.ops(json!({
        "claude.quota": { "threw": true, "entry": false, "result": null, "live": null, "nowMs": 0 }
    }));
    let threw = gateway.get("/api/claude/quota?session=chat-2");
    assert_eq!(threw.status, 500);
    assert!(threw
        .text()
        .starts_with(r#"{"status":"unavailable","error":"claude quota fetch failed","bar":"#));

    // A chrome-less scrape is a 503 with the fetched status in the body.
    gateway.ops(json!({
        "claude.quota": {
            "threw": false,
            "entry": true,
            "result": { "status": "chrome_unavailable", "error": "no chrome" },
            "live": null,
            "nowMs": 0
        },
        "claude.record": null
    }));
    assert_eq!(gateway.get("/api/claude/quota?session=chat-3").status, 503);
}

// ── quota bars ─────────────────────────────────────────────────────────────

#[test]
fn bars_idle_state_and_refresh() {
    let gateway = Gateway::start("bars");
    gateway.ops(json!({
        "bars.fetch": { "result": vendor_result("ok") },
        "bars.commit": { "cached": { "status": "ok", "updatedAt": 1_700_000_000_000_i64 } },
        "bars.state": { "snapshot": { "status": "ok", "bars": { "opencode": {} }, "updatedAt": 5 } }
    }));

    let idle = gateway.get("/api/quota/bars/idle");
    assert_eq!(idle.status, 200);
    let body = idle.json();
    assert_eq!(body["status"], json!("ok"));
    let bars = body["bars"]
        .as_object()
        .expect("bars is an object keyed by kind");
    assert_eq!(bars.len(), 6);
    for kind in ["opencode", "qoder", "codex", "ark", "kimi", "claude"] {
        assert!(bars.contains_key(kind), "missing idle bar {kind}");
    }
    // idleQuotaBars is a pure kernel: no host call.
    assert_eq!(gateway.host_calls().len(), 0);

    let state = gateway.get("/api/quota/bars/state?session=s1&kind=codex&force=1");
    assert_eq!(state.status, 200);
    assert_eq!(
        state.text(),
        r#"{"status":"ok","bars":{"opencode":{}},"updatedAt":5}"#
    );
    assert_eq!(
        gateway.host_calls().last().unwrap()["op"],
        json!("bars.state")
    );
    // `cache.snapshotFor` takes the whole `requestInput(req)` object (the
    // retired route passed it through untouched), so the host sees kind first
    // and `force` decided.
    assert_eq!(
        gateway.host_calls().last().unwrap()["selector"],
        json!({ "kind": "codex", "session": "s1", "baseUrl": "", "host": "", "force": true })
    );

    // An unknown kind never reaches the host.
    let before = gateway.host_calls().len();
    let invalid = gateway.post("/api/quota/bars/refresh?kind=nope", None);
    assert_eq!(invalid.status, 400);
    assert_eq!(
        invalid.text(),
        r#"{"status":"unavailable","error":"invalid quota bar kind"}"#
    );
    let empty = gateway.post("/api/quota/bars/refresh", None);
    assert_eq!(empty.status, 400);
    assert_eq!(gateway.host_calls().len(), before);

    // A successful refresh fetches, renders, then commits — in that order.
    let refreshed = gateway.post(
        "/api/quota/bars/refresh",
        Some(r#"{"kind":" OPENCODE ","session":" s1 "}"#),
    );
    assert_eq!(refreshed.status, 200);
    let body = refreshed.json();
    assert_eq!(body["status"], json!("ok"));
    assert_eq!(body["fetchedAt"], json!(1_700_000_000_000_i64));
    assert!(body["bar"].is_object());
    assert_eq!(
        body["cached"],
        json!({ "status": "ok", "updatedAt": 1_700_000_000_000_i64 })
    );
    let tail: Vec<Value> = gateway
        .host_calls()
        .into_iter()
        .rev()
        .take(2)
        .rev()
        .collect();
    assert_eq!(tail[0]["op"], json!("bars.fetch"));
    assert_eq!(tail[0]["kind"], json!("opencode"));
    assert_eq!(tail[0]["host"], json!(""));
    assert_eq!(tail[0]["baseUrl"], json!(""));
    assert_eq!(tail[1]["op"], json!("bars.commit"));
    assert_eq!(tail[1]["record"], json!(true));
    assert_eq!(tail[1]["kind"], json!("opencode"));
    assert_eq!(
        tail[1]["selector"],
        json!({ "session": "s1", "baseUrl": "", "host": "" })
    );
}

#[test]
fn bars_refresh_reports_a_failed_fetch() {
    let gateway = Gateway::start("bars-failed");
    gateway.ops(json!({ "bars.fetch": { "threw": true } }));
    let failed = gateway.post("/api/quota/bars/refresh?kind=codex", None);
    assert_eq!(failed.status, 500);
    assert_eq!(
        failed.text(),
        r#"{"status":"unavailable","error":"quota bar refresh failed"}"#
    );

    // The vendor's own non-ok status is kept verbatim, 401 included.
    gateway.ops(json!({
        "bars.fetch": { "result": { "status": "needs_login", "error": "kimi.com login required", "reason": "auth" } },
        "bars.commit": { "cached": null }
    }));
    let refused = gateway.post(
        "/api/quota/bars/refresh",
        Some(r#"{"kind":"kimi","host":"API.Moonshot.CN"}"#),
    );
    assert_eq!(refused.status, 401);
    let body = refused.json();
    assert_eq!(body["status"], json!("needs_login"));
    assert_eq!(body["error"], json!("kimi.com login required"));
    assert_eq!(body["reason"], json!("auth"));
    assert_eq!(
        gateway.host_calls().last().unwrap()["selector"]["host"],
        json!("api.moonshot.cn")
    );
}

// ── the host-down surface ──────────────────────────────────────────────────

#[test]
fn every_route_surfaces_a_dead_host_as_503() {
    let gateway = Gateway::start("host-down");
    gateway.ops_down();
    let cases: [(&str, &str, Option<&str>); 12] = [
        ("GET", "/api/pricing/status", None),
        ("GET", "/api/pricing/lookup?models=a", None),
        ("POST", "/api/pricing/refresh", None),
        ("GET", "/api/opencode/quota", None),
        ("GET", "/api/codex/quota", None),
        ("GET", "/api/ark/quota", None),
        ("GET", "/api/kimi/quota", None),
        ("GET", "/api/claude/quota", None),
        ("GET", "/api/aliyun/quota", None),
        ("POST", "/api/opencode/quota/login", None),
        ("GET", "/api/quota/bars/state?session=s", None),
        ("POST", "/api/quota/bars/refresh?kind=opencode", None),
    ];
    for (method, url, body) in cases {
        let response = gateway.exchange(method, url, body, &[]);
        assert_eq!(response.status, 503, "{method} {url}: {}", response.text());
        let body = response.json();
        assert_eq!(body["code"], json!("rust_backend_unavailable"), "{url}");
        assert!(body["error"].as_str().unwrap().contains("额度"));
    }
    // The pump-free routes still answer: they never needed Node.
    assert_eq!(gateway.get("/api/quota/bars/idle").status, 200);
    assert_eq!(gateway.options("/api/pricing/status").status, 200);
    let invalid = gateway.post("/api/quota/bars/refresh?kind=nope", None);
    assert_eq!(invalid.status, 400);
}

// ── HTTP surface ───────────────────────────────────────────────────────────

#[test]
fn conditionals_gzip_and_head() {
    let gateway = Gateway::start("http-surface");
    gateway.ops(json!({
        "pricing.status": { "status": { "loaded": true, "entries": 3 } }
    }));
    let first = gateway.get("/api/pricing/status");
    assert_eq!(first.status, 200);
    let etag = first.etag();
    assert!(etag.starts_with("W/\""), "weak ETag: {etag}");

    let conditional = gateway.get_with("/api/pricing/status", &[("If-None-Match", &etag)]);
    assert_eq!(conditional.status, 304);
    assert!(conditional.raw_body.is_empty());
    assert_eq!(conditional.header("etag"), Some(etag.as_str()));

    let star = gateway.get_with("/api/pricing/status", &[("If-None-Match", "*")]);
    assert_eq!(star.status, 304);

    let head = gateway.head("/api/pricing/status");
    assert_eq!(head.status, 200);
    assert!(head.raw_body.is_empty());
    assert_eq!(
        head.header("content-length"),
        first.header("content-length"),
        "HEAD keeps the GET length"
    );
    assert_eq!(head.header("etag"), Some(etag.as_str()));

    // A 400 is never turned into a 304, even with a matching tag.
    let bad = gateway.get("/api/pricing/lookup");
    assert_eq!(bad.status, 400);
    let repeated = gateway.get_with("/api/pricing/lookup", &[("If-None-Match", "*")]);
    assert_eq!(repeated.status, 400);

    // `jsonCompression` only compresses `/api` JSON at or above 1 KiB; the
    // front door must keep `Vary` off small bodies and honour the header.
    let small = gateway.get_with("/api/pricing/status", &[("Accept-Encoding", "gzip")]);
    assert!(small.header("content-encoding").is_none());

    gateway.ops(json!({
        "pricing.search": {
            "results": (0..80).map(|index| json!({ "id": format!("model-{index}-{}", "x".repeat(40)) })).collect::<Vec<_>>(),
            "status": { "loaded": true, "entries": 3 }
        }
    }));
    let large = gateway.get_with(
        "/api/pricing/search?q=x&limit=100",
        &[("Accept-Encoding", "gzip")],
    );
    assert_eq!(large.status, 200);
    assert_eq!(large.header("content-encoding"), Some("gzip"));
    assert_eq!(large.header("vary"), Some("Accept-Encoding"));
    let decoded: Value = serde_json::from_str(&large.gunzip()).unwrap();
    assert_eq!(decoded["count"], json!(80));
    // The cap is a rule of the retired handler, so it travels to the host.
    assert_eq!(gateway.host_calls().last().unwrap()["limit"], json!(50));
    assert_no_generic_500(&large);
}
