//! Integration coverage for the system and scan-history routes retired from
//! `src/routes/system.js` / `src/routes/scan.js` and answered by the Rust front
//! door (`native/gateway/src/app/system.rs`, `native/gateway/src/app/scan.rs`):
//!
//!   GET/HEAD/OPTIONS  /api/server-info
//!   GET/HEAD/OPTIONS  /api/version-check
//!   GET/HEAD/OPTIONS  /api/debug/codex-proxy-trace
//!   GET/HEAD/OPTIONS  /api/scan/history
//!
//! The Node process here is only the protocol fixture (PROXY v1 + auth
//! control): it answers `POST /api/__host/system` and
//! `POST /api/__host/scan-history` from `FIXTURE_HOST_SCRIPT` and appends the
//! bodies to `system-calls.jsonl` / `scan-calls.jsonl`. The GitHub releases
//! lookup is a loopback stub (`MULTICC_VERSION_CHECK_RELEASES_URL`), and the
//! install metadata comes from a package.json / .multicc_channel pair the test
//! writes into the gateway's --cwd (the package root the front door resolves).
//! LAN ranking, semver, tag selection, the limit rules, the DTOs and the 503s
//! are Rust and are what these tests assert; the frozen Node handlers are
//! compared byte for byte in docs/rust-migration/differential/system-scan.js.

use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
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
        "multicc-gateway-system-scan-{}-{tag}-{nanos}",
        std::process::id()
    ))
}

fn free_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.local_addr().unwrap().port()
}

/// The GitHub releases lookup, stubbed on loopback: the gateway fetches
/// `MULTICC_VERSION_CHECK_RELEASES_URL` directly (Node's `https.get` read no
/// proxy variables, so the Rust client is deliberately direct too). `hits`
/// lets a test prove a request did or did not reach the network.
struct ReleaseStub {
    url: String,
    hits: Arc<AtomicUsize>,
}

impl ReleaseStub {
    fn start(body: &str) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!(
            "http://127.0.0.1:{}/latest",
            listener.local_addr().unwrap().port()
        );
        let hits = Arc::new(AtomicUsize::new(0));
        let seen = hits.clone();
        let text = body.to_owned();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                seen.fetch_add(1, Ordering::SeqCst);
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                let mut buffer = Vec::new();
                let mut chunk = [0u8; 4096];
                // The fetch sends no body: read until the request head ends.
                loop {
                    match stream.read(&mut chunk) {
                        Ok(0) => break,
                        Ok(n) => {
                            buffer.extend_from_slice(&chunk[..n]);
                            if buffer.windows(4).any(|window| window == b"\r\n\r\n") {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
                // The retired handler parsed the body whatever the status; the
                // stub always answers 200 and lets the body carry the case.
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    text.len(),
                    text
                );
                let _ = stream.write_all(response.as_bytes());
            }
        });
        Self { url, hits }
    }

    fn hits(&self) -> usize {
        self.hits.load(Ordering::SeqCst)
    }
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

/// What the test installs into the gateway's package root (its --cwd):
/// `readInstallMetadata` reads package.json and .multicc_channel from there.
struct Install<'a> {
    package_json: Option<&'a str>,
    channel: Option<&'a str>,
}

impl<'a> Install<'a> {
    fn none() -> Self {
        Self {
            package_json: None,
            channel: None,
        }
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
        Self::start_full(tag, script, Install::none(), None)
    }

    fn start_full(tag: &str, script: Value, install: Install, releases_url: Option<&str>) -> Self {
        let mut last_log = String::new();
        for attempt in 0..6 {
            match Self::start_once(&format!("{tag}-{attempt}"), &script, &install, releases_url) {
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
    fn start_once(
        tag: &str,
        script: &Value,
        install: &Install,
        releases_url: Option<&str>,
    ) -> Result<Self, (String, bool)> {
        let dir = unique(tag);
        let data = dir.join("data");
        let home = dir.join("home");
        let state = dir.join("state");
        for path in [&dir, &data, &home, &state] {
            fs::create_dir_all(path).unwrap();
        }
        if let Some(package_json) = install.package_json {
            fs::write(dir.join("package.json"), package_json).unwrap();
        }
        if let Some(channel) = install.channel {
            fs::write(dir.join(".multicc_channel"), channel).unwrap();
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
        if let Some(url) = releases_url {
            command.env("MULTICC_VERSION_CHECK_RELEASES_URL", url);
        }
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

    /// Every body the fixture received on one host port, in order.
    fn calls(&self, file: &str) -> Vec<Value> {
        fs::read_to_string(self.state.join(file))
            .unwrap_or_default()
            .lines()
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn system_calls(&self) -> Vec<Value> {
        self.calls("system-calls.jsonl")
    }

    fn scan_calls(&self) -> Vec<Value> {
        self.calls("scan-calls.jsonl")
    }

    fn fixture_requests(&self) -> Vec<Value> {
        self.calls("requests.log")
    }

    /// Whether the protocol fixture (standing in for the whole Node server)
    /// saw this request — i.e. the front door did not claim it.
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

    fn get(&self, url: &str) -> Response {
        self.exchange("GET", url, &[])
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

// ── Fixtures shared by the tests ────────────────────────────────────────────

/// The process facts the real host route would report: a virtual interface
/// (dropped), one `en*` and one `eth*` (both preferred, same LAN priority, so
/// discovery order breaks the tie), a bind address and a mount-time version.
fn server_info_facts() -> Value {
    json!({
        "interfaces": {
            "utun0": [{ "family": "IPv4", "internal": false, "address": "10.1.0.1" }],
            "en0": [{ "family": "IPv4", "internal": false, "address": "192.168.1.9" }],
            "eth0": [{ "family": 4, "internal": false, "address": "10.0.0.8" }]
        },
        "bindHost": "0.0.0.0",
        "port": 45123,
        "authRequired": true,
        "version": "1.7.3",
        "startedAt": "2026-07-27T03:17:00.000Z",
        "uptimeMs": 8100000
    })
}

/// Seven passes, newest first, like the scan ring the host slices.
fn scan_passes() -> Vec<Value> {
    (0..7)
        .map(|i| json!({ "seq": 7 - i, "label": format!("pass-{i}") }))
        .collect()
}

fn scan_script(max_passes: i64) -> Value {
    json!({ "scan": { "seq": 7, "passes": scan_passes(), "maxPasses": max_passes } })
}

/// The trace ring, oldest first; the host strips `startedAt` and reverses.
fn trace_script() -> Value {
    json!({
        "system": {
            "traceEntries": [
                { "startedAt": "2026-01-01T00:00:00.000Z", "method": "GET", "url": "/v1/0" },
                { "startedAt": "2026-01-01T00:00:01.000Z", "method": "POST", "url": "/v1/1" },
                { "startedAt": "2026-01-01T00:00:02.000Z", "method": "GET", "url": "/v1/2" }
            ]
        }
    })
}

fn trace_entry(url: &str, method: &str) -> Value {
    json!({ "method": method, "url": url })
}

// ── /api/server-info ────────────────────────────────────────────────────────

#[test]
fn server_info_ranks_lan_addresses_and_shapes_the_dto() {
    let gateway = Gateway::start(
        "info",
        json!({ "system": { "serverInfo": server_info_facts() } }),
    );
    let response = gateway.get("/api/server-info");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(
        response.header("content-type"),
        Some("application/json; charset=utf-8")
    );
    assert_eq!(
        response.json(),
        json!({
            "product": "multicc",
            "appProtocolVersion": 1,
            "version": "1.7.3",
            "ip": "192.168.1.9",
            "port": 45123,
            "proto": "http",
            "url": "http://192.168.1.9:45123",
            "bindHost": "0.0.0.0",
            "lanAvailable": true,
            "lanAddresses": ["192.168.1.9", "10.0.0.8"],
            "lanUrls": ["http://192.168.1.9:45123", "http://10.0.0.8:45123"],
            "authRequired": true,
            "startedAt": "2026-07-27T03:17:00.000Z",
            "uptimeMs": 8100000
        })
    );
    // The retired route's key order is part of the DTO contract.
    assert_eq!(
        response.body,
        "{\"product\":\"multicc\",\"appProtocolVersion\":1,\"version\":\"1.7.3\",\"ip\":\"192.168.1.9\",\"port\":45123,\"proto\":\"http\",\"url\":\"http://192.168.1.9:45123\",\"bindHost\":\"0.0.0.0\",\"lanAvailable\":true,\"lanAddresses\":[\"192.168.1.9\",\"10.0.0.8\"],\"lanUrls\":[\"http://192.168.1.9:45123\",\"http://10.0.0.8:45123\"],\"authRequired\":true,\"startedAt\":\"2026-07-27T03:17:00.000Z\",\"uptimeMs\":8100000}"
    );
    assert_eq!(gateway.system_calls(), vec![json!({ "op": "server-info" })]);
}

#[test]
fn server_info_omits_the_version_key_when_the_host_has_none() {
    let mut facts = server_info_facts();
    facts.as_object_mut().unwrap().remove("version");
    let gateway = Gateway::start(
        "info-no-version",
        json!({ "system": { "serverInfo": facts } }),
    );
    let response = gateway.get("/api/server-info");
    assert_eq!(response.status, 200, "{}", response.body);
    assert!(response.json().get("version").is_none());
}

#[test]
fn server_info_and_trace_503_when_the_host_is_gone() {
    let gateway = Gateway::start("host-down", json!({ "hostDown": true }));
    for url in ["/api/server-info", "/api/debug/codex-proxy-trace"] {
        let response = gateway.get(url);
        assert_eq!(response.status, 503, "{url}");
        assert_eq!(
            response.json(),
            json!({
                "error": "主机信息接口尚未就绪，请更新原生模块",
                "code": "rust_backend_unavailable"
            }),
            "{url}"
        );
    }
    let response = gateway.get("/api/scan/history");
    assert_eq!(response.status, 503);
    assert_eq!(
        response.json(),
        json!({
            "error": "扫描历史接口尚未就绪，请更新原生模块",
            "code": "rust_backend_unavailable"
        })
    );
}

// ── /api/scan/history ───────────────────────────────────────────────────────

#[test]
fn scan_history_keeps_the_parseint_cap_and_negative_slice_semantics() {
    // maxPasses 7 (the whole ring) so the default, the cap and the negative
    // slices are all distinguishable in the body.
    let gateway = Gateway::start("scan", scan_script(7));
    let cases: Vec<(&str, usize, i64)> = vec![
        // (query, expected pass count, limit the host must have received)
        ("/api/scan/history", 7, 20),
        ("/api/scan/history?limit=2", 2, 2),
        ("/api/scan/history?limit=999", 7, 999),
        ("/api/scan/history?limit=-2", 5, -2),
        ("/api/scan/history?limit=-999", 0, -999),
        ("/api/scan/history?limit=abc", 7, 20),
        // parseInt("0x10", 10) stops at 'x' → 0 → `0 || 20` → 20.
        ("/api/scan/history?limit=0x10", 7, 20),
        // parseInt("1e3", 10) is 1, not 1000.
        ("/api/scan/history?limit=1e3", 1, 1),
        ("/api/scan/history?limit=0", 7, 20),
        ("/api/scan/history?limit=%203%20", 3, 3),
    ];
    for (url, count, host_limit) in cases {
        let response = gateway.get(url);
        assert_eq!(response.status, 200, "{url}");
        let body = response.json();
        assert_eq!(body["seq"], json!(7), "{url}");
        assert_eq!(body["kept"], json!(7), "{url}");
        let passes = body["passes"].as_array().expect("passes array");
        assert_eq!(passes.len(), count, "{url}");
        for (index, pass) in passes.iter().enumerate() {
            assert_eq!(pass["label"], json!(format!("pass-{index}")), "{url}");
        }
        let last = gateway.scan_calls().last().cloned().expect("host call");
        assert_eq!(
            last,
            json!({ "op": "snapshot", "limit": host_limit }),
            "{url}"
        );
    }
    // The DTO is reassembled by Rust in the retired route's key order.
    let response = gateway.get("/api/scan/history?limit=1");
    assert_eq!(
        response.body,
        "{\"seq\":7,\"kept\":7,\"passes\":[{\"seq\":7,\"label\":\"pass-0\"}]}"
    );
}

#[test]
fn scan_history_caps_at_max_passes() {
    let gateway = Gateway::start("scan-cap", scan_script(5));
    let response = gateway.get("/api/scan/history");
    assert_eq!(response.status, 200);
    let body = response.json();
    assert_eq!(body["kept"], json!(7));
    assert_eq!(body["passes"].as_array().unwrap().len(), 5);
}

// ── /api/debug/codex-proxy-trace ────────────────────────────────────────────

#[test]
fn proxy_trace_reverses_the_ring_strips_started_at_and_caps_the_limit() {
    let gateway = Gateway::start("trace", trace_script());
    let all = vec![
        trace_entry("/v1/2", "GET"),
        trace_entry("/v1/1", "POST"),
        trace_entry("/v1/0", "GET"),
    ];
    let cases: Vec<(&str, Vec<Value>, i64)> = vec![
        // (query, expected entries, limit the host must have received)
        ("/api/debug/codex-proxy-trace", all.clone(), 100),
        (
            "/api/debug/codex-proxy-trace?limit=1",
            vec![trace_entry("/v1/2", "GET")],
            1,
        ),
        ("/api/debug/codex-proxy-trace?limit=2", all[..2].to_vec(), 2),
        ("/api/debug/codex-proxy-trace?limit=999", all.clone(), 200),
        // Number("1e3") is 1000, an integer: capped to 200.
        ("/api/debug/codex-proxy-trace?limit=1e3", all.clone(), 200),
        // Number("0x10") is 16.
        ("/api/debug/codex-proxy-trace?limit=0x10", all.clone(), 16),
        // Number("5.9") is not an integer; "" and negatives are not > 0.
        ("/api/debug/codex-proxy-trace?limit=5.9", all.clone(), 100),
        ("/api/debug/codex-proxy-trace?limit=", all.clone(), 100),
        ("/api/debug/codex-proxy-trace?limit=-3", all.clone(), 100),
        ("/api/debug/codex-proxy-trace?limit=abc", all.clone(), 100),
    ];
    for (url, entries, host_limit) in cases {
        let response = gateway.get(url);
        assert_eq!(response.status, 200, "{url}");
        assert_eq!(response.json(), json!({ "entries": entries }), "{url}");
        let last = gateway.system_calls().last().cloned().expect("host call");
        assert_eq!(last, json!({ "op": "trace", "limit": host_limit }), "{url}");
    }
    let response = gateway.get("/api/debug/codex-proxy-trace?limit=1");
    assert_eq!(
        response.body,
        "{\"entries\":[{\"method\":\"GET\",\"url\":\"/v1/2\"}]}"
    );
}

// ── /api/version-check ──────────────────────────────────────────────────────

#[test]
fn version_check_reports_a_newer_release() {
    let stub = ReleaseStub::start("{\"tag_name\":\"v2.3.4\"}");
    let gateway = Gateway::start_full(
        "version-newer",
        json!({}),
        Install {
            package_json: Some("{\"version\":\"1.7.3\"}"),
            channel: Some("# channel: release\n"),
        },
        Some(&stub.url),
    );
    let response = gateway.get("/api/version-check");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(
        response.json(),
        json!({
            "current": "1.7.3",
            "channel": "release",
            "latest": "v2.3.4",
            "latestVersion": "2.3.4",
            "updateAvailable": true,
            "apiError": false
        })
    );
    assert_eq!(stub.hits(), 1);
    // A tag from the API is final: the git fallback never ran.
    assert!(gateway.system_calls().is_empty());
}

#[test]
fn version_check_falls_back_to_git_tags_after_an_api_failure() {
    // Malformed JSON: the retired handler's catch marks apiError and moves on.
    let stub = ReleaseStub::start("{");
    let gateway = Gateway::start_full(
        "version-fallback",
        json!({ "system": { "lsRemote": {
            "ok": true,
            "output": "a refs/tags/v1.2.0\nb refs/tags/v3.0.0\nc refs/tags/v2.5.0\n"
        } } }),
        Install {
            package_json: Some("{\"version\":\"1.7.3\"}"),
            channel: None,
        },
        Some(&stub.url),
    );
    let response = gateway.get("/api/version-check");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(
        response.json(),
        json!({
            "current": "1.7.3",
            "channel": "dev",
            "latest": "v3.0.0",
            "latestVersion": "3.0.0",
            "updateAvailable": true,
            "apiError": true
        })
    );
    assert_eq!(stub.hits(), 1);
    assert_eq!(gateway.system_calls(), vec![json!({ "op": "ls-remote" })]);
}

#[test]
fn version_check_survives_a_double_failure() {
    let stub = ReleaseStub::start("{");
    let gateway = Gateway::start_full(
        "version-double-fail",
        json!({ "system": { "lsRemote": { "ok": false } } }),
        Install {
            package_json: Some("{\"version\":\"1.7.3\"}"),
            channel: None,
        },
        Some(&stub.url),
    );
    let response = gateway.get("/api/version-check");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(
        response.json(),
        json!({
            "current": "1.7.3",
            "channel": "dev",
            "latest": null,
            "latestVersion": null,
            "updateAvailable": false,
            "apiError": true
        })
    );
    assert_eq!(stub.hits(), 1);
    assert_eq!(gateway.system_calls(), vec![json!({ "op": "ls-remote" })]);
}

#[test]
fn version_check_defaults_when_the_install_metadata_is_unreadable() {
    let stub = ReleaseStub::start("{\"tag_name\":\"v9.9.9\"}");
    let gateway = Gateway::start_full(
        "version-default",
        json!({}),
        Install::none(),
        Some(&stub.url),
    );
    // A malformed package.json in the package root would keep the Node child
    // itself from booting (Node reads the nearest package.json at spawn), so
    // corrupt it only after the child is up: the route reads the file per
    // request and must land on DEFAULT_VERSION_RESULT.
    fs::write(gateway.dir.join("package.json"), "{oops").unwrap();
    let response = gateway.get("/api/version-check");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(
        response.json(),
        json!({
            "current": "0.0.0",
            "channel": "dev",
            "latest": null,
            "latestVersion": null,
            "updateAvailable": false,
            "apiError": true
        })
    );
    // The DEFAULT_VERSION_RESULT path is catch-all: neither the network nor
    // the host was asked.
    assert_eq!(stub.hits(), 0);
    assert!(gateway.system_calls().is_empty());
}

#[test]
fn version_check_stays_quiet_when_already_current() {
    let stub = ReleaseStub::start("{\"tag_name\":\"v1.7.3\"}");
    let gateway = Gateway::start_full(
        "version-current",
        json!({}),
        Install {
            package_json: Some("{\"version\":\"1.7.3\"}"),
            channel: None,
        },
        Some(&stub.url),
    );
    let response = gateway.get("/api/version-check");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(
        response.json(),
        json!({
            "current": "1.7.3",
            "channel": "dev",
            "latest": "v1.7.3",
            "latestVersion": "1.7.3",
            "updateAvailable": false,
            "apiError": false
        })
    );
}

// ── Express behavior and the claim boundary ─────────────────────────────────

#[test]
fn options_lists_get_and_head_without_touching_the_host() {
    let gateway = Gateway::start("options", json!({}));
    for url in [
        "/api/server-info",
        "/api/version-check",
        "/api/debug/codex-proxy-trace",
        "/api/scan/history",
    ] {
        let response = gateway.options(url);
        assert_eq!(response.status, 200, "{url}");
        assert_eq!(response.header("allow"), Some("GET,HEAD"), "{url}");
        assert_eq!(response.body, "GET,HEAD", "{url}");
    }
    assert!(gateway.system_calls().is_empty());
    assert!(gateway.scan_calls().is_empty());
}

#[test]
fn head_matches_get_without_a_body() {
    let gateway = Gateway::start(
        "head",
        json!({ "system": { "serverInfo": server_info_facts() } }),
    );
    let full = gateway.get("/api/server-info");
    let head = gateway.head("/api/server-info");
    assert_eq!(head.status, 200);
    assert!(head.raw_body.is_empty(), "HEAD has no body");
    assert_eq!(head.header("content-length"), full.header("content-length"));
    assert_eq!(head.header("etag"), full.header("etag"));
}

#[test]
fn claim_boundary_keeps_siblings_and_other_methods_forwarded() {
    let gateway = Gateway::start(
        "boundary",
        json!({
            "system": { "serverInfo": server_info_facts() },
            "scan": { "seq": 7, "passes": scan_passes(), "maxPasses": 5 }
        }),
    );
    // One trailing slash is claimed, exactly like Express's non-strict routing.
    for url in ["/api/server-info/", "/api/scan/history/"] {
        let response = gateway.get(url);
        assert_eq!(response.status, 200, "{url}");
        assert!(!gateway.forwarded("GET", url), "{url}");
    }
    // A case-different /API prefix or a parent path is not the route.
    for (method, url) in [
        ("GET", "/API/server-info"),
        ("GET", "/api/scan"),
        ("GET", "/api/debug"),
        ("GET", "/api/server-info/extra"),
        ("POST", "/api/server-info"),
        ("POST", "/api/scan/history"),
    ] {
        let response = gateway.exchange(method, url, &[]);
        assert!(
            gateway.forwarded(method, url),
            "{method} {url} should have been forwarded"
        );
        assert_eq!(response.body, "ok", "{method} {url}");
    }
}
