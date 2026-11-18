#![recursion_limit = "256"]

//! Integration coverage for the ten release-asset, iOS OTA and chat-history
//! routes retired from `src/routes/system.js`, `src/ios-udid.js`,
//! `src/routes/chat-history.js` and `src/routes/static-assets.js` and answered
//! by the Rust front door (`native/gateway/src/app/release_history_routes.rs`;
//! matching rules in `multicc_core::release_history_routes`).
//!
//! The Node process here is only the protocol fixture: it answers
//! `POST /api/__host/release-history` from
//! `FIXTURE_HOST_SCRIPT.releaseHistory.ops` and appends every payload to
//! `release-history-calls.jsonl` (plus start/end events to
//! `release-history-events.jsonl`), so each test asserts exactly what the front
//! door asked Node to do and what it relayed back byte for byte.
//!
//! The authentication tests use an external peer (an `X-Forwarded-For` header
//! makes the locality fact false) with no token, so only the shared HTTP-entry
//! exemptions can let a request through.

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
const PKCS7: &str = "application/pkcs7-signature";
const DEVICEINFO: &str = "application/x-apple-aspen-deviceinfo";

fn token64() -> String {
    "ab".repeat(32)
}

fn unique(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "multicc-gateway-release-history-{}-{tag}-{nanos}",
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
        serde_json::from_str(&self.body).unwrap_or_else(|_| panic!("JSON response: {}", self.body))
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

    fn lines(&self, file: &str) -> Vec<Value> {
        fs::read_to_string(self.state.join(file))
            .unwrap_or_default()
            .lines()
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    /// Every payload the front door sent the release-history host port.
    fn calls(&self) -> Vec<Value> {
        self.lines("release-history-calls.jsonl")
    }

    fn ops(&self) -> Vec<String> {
        self.calls()
            .iter()
            .map(|call| call["op"].as_str().unwrap().to_string())
            .collect()
    }

    /// `start`/`end` phases in the order the fixture observed them.
    fn phases(&self) -> Vec<String> {
        self.lines("release-history-events.jsonl")
            .iter()
            .map(|event| {
                format!(
                    "{}:{}",
                    event["phase"].as_str().unwrap(),
                    event["op"].as_str().unwrap()
                )
            })
            .collect()
    }

    fn session_admin_calls(&self) -> Vec<Value> {
        self.lines("session-admin-calls.jsonl")
    }

    /// Whether the protocol fixture (standing in for the whole Node server)
    /// saw this request, that is the front door did not claim it.
    fn forwarded(&self, method: &str, url: &str) -> bool {
        self.lines("requests.log").iter().any(|entry| {
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
        let mut request =
            format!("{method} {url} HTTP/1.1\r\nHost: localhost\r\nX-Request-Id: host-req-1\r\n");
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
            // The front door may answer (413) before the whole body is read.
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

fn world(ops: Value) -> Value {
    json!({ "releaseHistory": { "ops": ops } })
}

/// External peer, authenticated: the forwarding header makes the locality fact
/// false, the token satisfies the ordinary gate.
fn external() -> Vec<(&'static str, &'static str)> {
    vec![("X-Forwarded-For", EXTERNAL_IP), ("X-Access-Token", TOKEN)]
}

/// External peer with no credential at all: only the exemptions get through.
fn anonymous() -> Vec<(&'static str, &'static str)> {
    vec![("X-Forwarded-For", EXTERNAL_IP)]
}

/// Every route this cluster claims with a host op, as `(method, url, op)`.
fn op_routes() -> Vec<(&'static str, String, &'static str)> {
    vec![
        ("GET", "/api/apk-info".into(), "apk-info"),
        ("GET", "/api/ios-ota-info".into(), "ios-ota-info"),
        ("GET", "/ios-ota/manifest.plist".into(), "ios-ota-manifest"),
        ("GET", "/ios-ota/udid.mobileconfig".into(), "udid-profile"),
        (
            "GET",
            format!("/ios-ota/udid/result/{}", token64()),
            "udid-result",
        ),
        (
            "POST",
            format!("/ios-ota/udid/callback/{}", token64()),
            "udid-callback",
        ),
        (
            "DELETE",
            "/api/sessions/s1/messages/m1".into(),
            "message-delete",
        ),
        ("GET", "/api/sessions/s1/history".into(), "history"),
        (
            "GET",
            "/api/sessions/s1/context-level".into(),
            "context-level",
        ),
    ]
}

fn callback_url() -> String {
    format!("/ios-ota/udid/callback/{}", token64())
}

fn callback(gateway: &Gateway, headers: &[(&str, &str)], body: Option<&[u8]>) -> Response {
    gateway.exchange("POST", &callback_url(), headers, body)
}

fn headers_with<'a>(
    base: &[(&'a str, &'a str)],
    more: &[(&'a str, &'a str)],
) -> Vec<(&'a str, &'a str)> {
    base.iter().chain(more.iter()).copied().collect()
}

// ── Normal paths: status, body, key order, payload ─────────────────────────

#[test]
fn apk_info_relays_the_host_json_with_its_key_order() {
    let gateway = Gateway::start(
        "apk-info",
        world(json!({ "apk-info": { "status": 200, "body": {
            "available": true, "version": "2.40.0", "size": 1234, "url": "/multicc.apk"
        } } })),
    );
    let response = gateway.exchange("GET", "/api/apk-info?x=1", &external(), None);
    assert_eq!(response.status, 200, "{}", gateway.log());
    assert_eq!(
        response.header("content-type"),
        Some("application/json; charset=utf-8")
    );
    assert_eq!(
        response.body,
        r#"{"available":true,"version":"2.40.0","size":1234,"url":"/multicc.apk"}"#
    );
    let calls = gateway.calls();
    assert_eq!(calls.len(), 1);
    let call = &calls[0];
    assert_eq!(call["op"], "apk-info");
    assert_eq!(call["method"], "GET");
    assert_eq!(call["originalUrl"], "/api/apk-info?x=1");
    // Unknown query keys never travel.
    assert_eq!(call["query"], json!({}));
    assert_eq!(call["local"], false);
    assert_eq!(call["requestId"], "host-req-1");
    // The payload's own key order is part of the front-door/host contract.
    let text = fs::read_to_string(gateway.state.join("release-history-calls.jsonl")).unwrap();
    assert_key_order(
        &text,
        &[
            "op",
            "method",
            "originalUrl",
            "query",
            "headers",
            "body",
            "local",
            "requestId",
            "correlationId",
        ],
    );
}

#[test]
fn ios_ota_info_relays_status_and_body() {
    let gateway = Gateway::start(
        "ota-info",
        world(json!({ "ios-ota-info": { "status": 200, "body": {
            "available": false, "reason": "not-built", "version": null
        } } })),
    );
    let response = gateway.get("/api/ios-ota-info");
    assert_eq!(response.status, 200, "{}", gateway.log());
    assert_eq!(
        response.body,
        r#"{"available":false,"reason":"not-built","version":null}"#
    );
    assert_eq!(gateway.ops(), vec!["ios-ota-info"]);
    assert_eq!(gateway.calls()[0]["local"], true);
}

#[test]
fn a_host_status_other_than_200_is_relayed() {
    let gateway = Gateway::start(
        "ota-404",
        world(json!({ "apk-info": { "status": 404, "body": { "error": "no apk" } } })),
    );
    let response = gateway.get("/api/apk-info");
    assert_eq!(response.status, 404);
    assert_eq!(response.body, r#"{"error":"no apk"}"#);
}

#[test]
fn manifest_plist_is_sent_as_text_xml_with_the_private_cache_headers() {
    let plist = "<?xml version=\"1.0\"?>\n<plist version=\"1.0\"><dict/></plist>\n";
    let gateway = Gateway::start(
        "manifest",
        world(json!({ "ios-ota-manifest": {
            "status": 200,
            "contentType": "text/xml; charset=utf-8",
            "body": plist,
            "headers": [
                ["Cache-Control", "no-store, no-cache, must-revalidate"],
                ["Pragma", "no-cache"]
            ]
        } })),
    );
    let response = gateway.exchange("GET", "/ios-ota/manifest.plist", &anonymous(), None);
    assert_eq!(response.status, 200, "{}", gateway.log());
    assert_eq!(
        response.header("content-type"),
        Some("text/xml; charset=utf-8")
    );
    assert_eq!(
        response.header("cache-control"),
        Some("no-store, no-cache, must-revalidate")
    );
    assert_eq!(response.header("pragma"), Some("no-cache"));
    assert_eq!(response.body, plist);
    assert_eq!(gateway.ops(), vec!["ios-ota-manifest"]);
}

#[test]
fn udid_profile_relays_the_aspen_content_type_verbatim() {
    let profile = "<?xml version=\"1.0\"?><plist><dict>profile</dict></plist>";
    let gateway = Gateway::start(
        "profile",
        world(json!({ "udid-profile": {
            "status": 200,
            "contentType": "application/x-apple-aspen-config; charset=utf-8",
            "body": profile,
            "headers": [
                ["Cache-Control", "no-store"],
                ["Referrer-Policy", "no-referrer"],
                ["X-Content-Type-Options", "nosniff"],
                ["Content-Disposition", "attachment; filename=\"multicc-udid.mobileconfig\""]
            ]
        } })),
    );
    let response = gateway.exchange(
        "GET",
        "/ios-ota/udid.mobileconfig",
        &headers_with(
            &external(),
            &[
                ("X-Forwarded-Proto", "https"),
                ("X-Forwarded-Host", "air.example.com"),
                ("Sec-Fetch-Site", "same-origin"),
                ("Cookie", "secret=1"),
            ],
        ),
        None,
    );
    assert_eq!(response.status, 200, "{}", gateway.log());
    // The host's Content-Type is relayed verbatim -- never re-typed and never
    // sniffed. `res.send(string)` on the Node side is what appends the charset
    // (Express does that for any already-set type), so the aspen type arrives
    // here already carrying it.
    assert_eq!(
        response.header("content-type"),
        Some("application/x-apple-aspen-config; charset=utf-8")
    );
    assert_eq!(
        response.header("content-disposition"),
        Some("attachment; filename=\"multicc-udid.mobileconfig\"")
    );
    assert_eq!(response.header("cache-control"), Some("no-store"));
    assert_eq!(response.header("referrer-policy"), Some("no-referrer"));
    assert_eq!(response.header("x-content-type-options"), Some("nosniff"));
    assert_eq!(response.body, profile);
    // Only the four origin-bearing headers travel; credentials never do.
    let call = &gateway.calls()[0];
    assert_eq!(call["op"], "udid-profile");
    assert_eq!(
        call["headers"],
        json!({
            "host": "localhost",
            "x-forwarded-proto": "https",
            "x-forwarded-host": "air.example.com",
            "sec-fetch-site": "same-origin"
        })
    );
}

#[test]
fn udid_result_page_carries_the_html_csp_and_robots_headers() {
    let csp = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
    let page = "<!doctype html><title>UDID</title>";
    let token = token64();
    let gateway = Gateway::start(
        "result",
        world(json!({ "udid-result": {
            "status": 200,
            "contentType": "text/html; charset=utf-8",
            "body": page,
            "headers": [
                ["Cache-Control", "no-store"],
                ["Referrer-Policy", "no-referrer"],
                ["X-Content-Type-Options", "nosniff"],
                ["X-Robots-Tag", "noindex, nofollow, noarchive"],
                ["Content-Security-Policy", csp]
            ]
        } })),
    );
    let response = gateway.exchange(
        "GET",
        &format!("/ios-ota/udid/result/{token}"),
        &anonymous(),
        None,
    );
    assert_eq!(response.status, 200, "{}", gateway.log());
    assert_eq!(
        response.header("content-type"),
        Some("text/html; charset=utf-8")
    );
    assert_eq!(response.header("content-security-policy"), Some(csp));
    assert_eq!(
        response.header("x-robots-tag"),
        Some("noindex, nofollow, noarchive")
    );
    assert_eq!(response.header("cache-control"), Some("no-store"));
    assert_eq!(response.header("referrer-policy"), Some("no-referrer"));
    assert_eq!(response.header("x-content-type-options"), Some("nosniff"));
    assert_eq!(response.body, page);
    let call = &gateway.calls()[0];
    assert_eq!(call["op"], "udid-result");
    assert_eq!(call["token"], json!(token));
}

#[test]
fn udid_callback_forwards_the_decoded_token_and_a_buffer_raw_body() {
    let gateway = Gateway::start(
        "callback",
        world(json!({ "udid-callback": {
            "status": 301,
            "bare": true,
            "headers": [["Location", "/ios-ota/udid/result/abc"], ["Cache-Control", "no-store"]]
        } })),
    );
    let response = callback(&gateway, &[("Content-Type", PKCS7)], Some(b"abc"));
    assert_eq!(response.status, 301, "{}", gateway.log());
    // `bare`: the handler's own headers stay, no Content-Type or ETag appears.
    assert_eq!(
        response.header("location"),
        Some("/ios-ota/udid/result/abc")
    );
    assert_eq!(response.header("cache-control"), Some("no-store"));
    assert_eq!(response.header("content-length"), Some("0"));
    assert_eq!(response.header("content-type"), None);
    assert_eq!(response.header("etag"), None);
    assert_eq!(response.body, "");
    let call = &gateway.calls()[0];
    assert_eq!(call["op"], "udid-callback");
    assert_eq!(call["method"], "POST");
    assert_eq!(call["token"], json!(token64()));
    assert_eq!(
        call["rawBody"],
        json!({ "kind": "buffer", "base64": "YWJj" })
    );
    assert_eq!(call["body"], Value::Null);
}

#[test]
fn message_delete_forwards_both_decoded_parameters() {
    let gateway = Gateway::start(
        "delete",
        world(json!({ "message-delete": { "status": 200, "body": { "ok": true, "deleted": 1 } } })),
    );
    let response = gateway.exchange(
        "DELETE",
        "/api/sessions/s%201/messages/m%2F1",
        &external(),
        None,
    );
    assert_eq!(response.status, 200, "{}", gateway.log());
    assert_eq!(response.body, r#"{"ok":true,"deleted":1}"#);
    let call = &gateway.calls()[0];
    assert_eq!(call["op"], "message-delete");
    assert_eq!(call["method"], "DELETE");
    assert_eq!(call["id"], "s 1");
    assert_eq!(call["msgId"], "m/1");
    assert_eq!(call["originalUrl"], "/api/sessions/s%201/messages/m%2F1");
}

#[test]
fn history_forwards_only_the_known_query_keys() {
    let gateway = Gateway::start(
        "history",
        world(json!({ "history": { "status": 200, "body": {
            "messages": [{ "id": "m1" }], "hasMore": false
        } } })),
    );
    let response = gateway.exchange(
        "GET",
        "/api/sessions/s1/history?historyScope=all&before=7&around=m9&limit=50&plan=1&secret=x&limit=60",
        &external(),
        None,
    );
    assert_eq!(response.status, 200, "{}", gateway.log());
    assert_eq!(
        response.body,
        r#"{"messages":[{"id":"m1"}],"hasMore":false}"#
    );
    let call = &gateway.calls()[0];
    assert_eq!(call["op"], "history");
    assert_eq!(call["id"], "s1");
    let query = call["query"].as_object().unwrap();
    for key in ["historyScope", "before", "around", "plan"] {
        assert!(query.contains_key(key), "{key} missing from {query:?}");
    }
    assert!(!query.contains_key("secret"));
    // A repeated key is the qs array, exactly as Express's parser gave it.
    assert_eq!(query["limit"], json!(["50", "60"]));
    assert_eq!(query["historyScope"], "all");
}

#[test]
fn context_level_relays_the_host_body() {
    let gateway = Gateway::start(
        "context",
        world(
            json!({ "context-level:s1": { "status": 200, "body": { "level": "high", "used": 0.8 } } }),
        ),
    );
    let response = gateway.get("/api/sessions/s1/context-level");
    assert_eq!(response.status, 200, "{}", gateway.log());
    assert_eq!(response.body, r#"{"level":"high","used":0.8}"#);
    let call = &gateway.calls()[0];
    assert_eq!(call["op"], "context-level");
    assert_eq!(call["id"], "s1");
    assert_eq!(call["query"], json!({}));
}

// ── Authentication exemptions (shared HTTP-entry table) ────────────────────

#[test]
fn the_ota_fetchers_reach_the_host_without_a_credential() {
    let gateway = Gateway::start("auth-open", world(json!({})));
    // itms-services cannot log in: the manifest and the result page are public.
    let manifest = gateway.exchange("GET", "/ios-ota/manifest.plist", &anonymous(), None);
    assert_eq!(manifest.status, 200, "{}", gateway.log());
    let result = gateway.exchange(
        "GET",
        &format!("/ios-ota/udid/result/{}", token64()),
        &anonymous(),
        None,
    );
    assert_eq!(result.status, 200, "{}", gateway.log());
    // The Apple device posts its signed reply with one of two content types.
    for content_type in [PKCS7, DEVICEINFO] {
        let response = callback(
            &gateway,
            &headers_with(&anonymous(), &[("Content-Type", content_type)]),
            Some(b"signed"),
        );
        assert_eq!(response.status, 200, "{content_type}: {}", gateway.log());
    }
    assert_eq!(
        gateway.ops(),
        vec![
            "ios-ota-manifest",
            "udid-result",
            "udid-callback",
            "udid-callback"
        ]
    );
}

#[test]
fn the_profile_and_both_json_infos_stay_behind_the_gate() {
    let gateway = Gateway::start("auth-closed", world(json!({})));
    for url in [
        "/ios-ota/udid.mobileconfig",
        "/api/apk-info",
        "/api/ios-ota-info",
    ] {
        let response = gateway.exchange("GET", url, &anonymous(), None);
        // The ordinary gate answers: a login redirect for the browser-shaped
        // profile download, the AUTH_REQUIRED DTO for the JSON infos.
        assert!(
            matches!(response.status, 302 | 401 | 403),
            "{url}: {} {}",
            response.status,
            response.body
        );
    }
    assert!(gateway.calls().is_empty(), "a gated route reached the host");
    // With the token the same routes are served.
    let response = gateway.exchange("GET", "/api/apk-info", &external(), None);
    assert_eq!(response.status, 200);
}

#[test]
fn the_callback_with_any_other_content_type_is_refused() {
    let gateway = Gateway::start("auth-callback", world(json!({})));
    for content_type in ["application/json", "text/plain", "application/octet-stream"] {
        let response = callback(
            &gateway,
            &headers_with(&anonymous(), &[("Content-Type", content_type)]),
            Some(b"{}"),
        );
        assert_eq!(response.status, 403, "{content_type}: {}", response.body);
        assert_eq!(response.json()["code"], "AUTH_REQUIRED", "{content_type}");
    }
    // No Content-Type at all is refused too.
    let response = callback(&gateway, &anonymous(), Some(b"x"));
    assert_eq!(response.status, 403);
    assert!(gateway.calls().is_empty());
}

// ── Internal execution slots ───────────────────────────────────────────────

#[test]
fn internal_slots_are_404_on_the_three_history_routes_and_their_options() {
    let script = json!({
        "releaseHistory": { "ops": {} },
        "sessionAdmin": { "ops": {
            "guard-record:slot1": { "record": null, "internal": true, "taskStateWritable": true }
        } }
    });
    let gateway = Gateway::start("slot", script);
    let cases = [
        ("GET", "/api/sessions/slot1/history"),
        ("HEAD", "/api/sessions/slot1/history"),
        ("GET", "/api/sessions/slot1/context-level"),
        ("DELETE", "/api/sessions/slot1/messages/m1"),
        ("OPTIONS", "/api/sessions/slot1/history"),
        ("OPTIONS", "/api/sessions/slot1/context-level"),
        ("OPTIONS", "/api/sessions/slot1/messages/m1"),
    ];
    for (method, url) in cases {
        let response = gateway.exchange(method, url, &external(), None);
        assert_eq!(response.status, 404, "{method} {url}: {}", gateway.log());
        if method != "HEAD" {
            assert_eq!(
                response.json(),
                json!({ "error": "session not found" }),
                "{method} {url}"
            );
        }
    }
    // Zero side effects: the guard answered before any handler or OPTIONS.
    assert!(
        gateway.calls().is_empty(),
        "an internal slot reached the host: {:?}",
        gateway.ops()
    );
    assert!(gateway.phases().is_empty());
    assert_eq!(gateway.session_admin_calls().len(), cases.len());
    // A real session on the same routes is served.
    let response = gateway.exchange("GET", "/api/sessions/s1/history", &external(), None);
    assert_eq!(response.status, 200);
    assert_eq!(gateway.ops(), vec!["history"]);
}

// ── OPTIONS ────────────────────────────────────────────────────────────────

#[test]
fn options_answers_this_clusters_allow_list_without_the_host() {
    let gateway = Gateway::start("allow", world(json!({})));
    let cases = [
        ("/api/apk-info", "GET,HEAD"),
        ("/api/ios-ota-info", "GET,HEAD"),
        ("/ios-ota/manifest.plist", "GET,HEAD"),
        ("/ios-ota/udid.mobileconfig", "GET,HEAD"),
        ("/ios-ota/udid/result/abc", "GET,HEAD"),
        ("/ios-ota/udid/callback/abc", "POST"),
        ("/api/sessions/s9/messages/m1", "DELETE"),
        ("/api/sessions/s9/history", "GET,HEAD"),
        ("/api/sessions/s9/context-level", "GET,HEAD"),
    ];
    for (path, allow) in cases {
        let response = gateway.options(path);
        assert_eq!(response.status, 200, "{path}: {}", gateway.log());
        assert_eq!(response.header("allow"), Some(allow), "{path}");
        assert_eq!(response.body, allow, "{path}");
    }
    assert!(gateway.calls().is_empty(), "OPTIONS reached the host");
}

// ── Host failures ──────────────────────────────────────────────────────────

#[test]
fn an_unreachable_host_is_the_503_for_every_op_route() {
    let gateway = Gateway::start("down", json!({ "hostDown": true }));
    for (method, url, op) in op_routes() {
        let mut headers = external();
        let body: Option<&[u8]> = if method == "POST" {
            headers.push(("Content-Type", PKCS7));
            Some(b"x")
        } else {
            None
        };
        let response = gateway.exchange(method, &url, &headers, body);
        assert_eq!(response.status, 503, "{op}: {}", gateway.log());
        assert_eq!(
            response.json(),
            json!({
                "error": "发布资产与聊天历史接口尚未就绪，请更新原生模块",
                "code": "rust_backend_unavailable"
            }),
            "{op}"
        );
    }
}

#[test]
fn a_host_answer_of_the_wrong_shape_is_refused() {
    // An unparseable reply cannot be relayed: the 503.
    let garbled = Gateway::start(
        "garbled",
        json!({ "releaseHistory": { "rawAnswer": "not json at all" } }),
    );
    let response = garbled.get("/api/apk-info");
    assert_eq!(response.status, 503, "{}", garbled.log());
    assert_eq!(response.json()["code"], "rust_backend_unavailable");

    // A well-formed reply that is not `ok:true` is the host-operation failure
    // (500), the same envelope every other cluster uses for that case.
    let refused = Gateway::start(
        "not-ok",
        json!({ "releaseHistory": { "rawAnswer": "{\"ok\":false}" } }),
    );
    let response = refused.get("/api/apk-info");
    assert_eq!(response.status, 500, "{}", refused.log());
    assert_eq!(response.json()["code"], "internal_error");
    assert_eq!(response.json()["requestId"], "host-req-1");
}

#[test]
fn a_thrown_handler_is_rebuilt_with_the_front_doors_ids_and_no_message() {
    // The host (`thrownEnvelope`) already reduces a 5xx to `internal_error`;
    // the front door relays only status, code and message, and stamps its own
    // request ids, never anything else the answer carried.
    let gateway = Gateway::start(
        "threw",
        world(json!({ "history": {
            "threw": true, "status": 500, "code": "internal_error", "message": "internal_error",
            "stack": "Error: boom at /Users/someone/src/ios-udid.js:42",
            "requestId": "HOST-RID", "correlationId": "HOST-CID"
        } })),
    );
    let response = gateway.exchange("GET", "/api/sessions/s1/history", &external(), None);
    assert_eq!(response.status, 500, "{}", gateway.log());
    assert_key_order(
        &response.body,
        &["ok", "error", "code", "requestId", "correlationId"],
    );
    for leaked in ["HOST-RID", "HOST-CID", "boom", "/Users/", "ios-udid"] {
        assert!(
            !response.body.contains(leaked),
            "{leaked}: {}",
            response.body
        );
    }
    let body = response.json();
    assert_eq!(body["ok"], false);
    assert_eq!(body["error"], "internal_error");
    assert_eq!(body["code"], "internal_error");
    assert_eq!(body["requestId"], "host-req-1");
    assert_eq!(body["correlationId"], "host-req-1");
}

#[test]
fn a_thrown_client_error_keeps_its_status_code_and_safe_message() {
    let gateway = Gateway::start(
        "threw-400",
        world(json!({ "message-delete": {
            "threw": true, "status": 400, "code": "request_error", "message": "bad message id"
        } })),
    );
    let response = gateway.exchange("DELETE", "/api/sessions/s1/messages/m1", &external(), None);
    assert_eq!(response.status, 400, "{}", gateway.log());
    let body = response.json();
    assert_eq!(body["error"], "bad message id");
    assert_eq!(body["code"], "request_error");
    assert_eq!(body["requestId"], "host-req-1");
}

// ── GET / ──────────────────────────────────────────────────────────────────

#[test]
fn the_bare_root_redirects_to_air() {
    let gateway = Gateway::start("root", world(json!({})));
    let response = gateway.get("/");
    assert_eq!(response.status, 302, "{}", gateway.log());
    assert_eq!(response.header("location"), Some("/air"));
    let aux = gateway.get("/?id=__aux__");
    assert_eq!(aux.status, 302);
    assert_eq!(aux.header("location"), Some("/air?view=aux"));
    // HEAD redirects the same way, with no body.
    let head = gateway.head("/");
    assert_eq!(head.status, 302);
    assert_eq!(head.header("location"), Some("/air"));
    assert_eq!(head.body, "");
    // The root never asks the host.
    assert!(gateway.calls().is_empty());
    assert!(!gateway.forwarded("GET", "/"));
}

#[test]
fn a_root_with_a_terminal_session_query_falls_back_to_node() {
    let gateway = Gateway::start("root-fallback", world(json!({})));
    for url in ["/?id=s1", "/?newid=n1", "/?cwd=%2Ftmp%2Fproject"] {
        let response = gateway.get(url);
        assert_eq!(response.status, 200, "{url}: {}", gateway.log());
        assert_eq!(response.header("location"), None, "{url}");
        // The fixture's fallback answer, not the front door's redirect.
        assert_eq!(response.body, "ok", "{url}");
        assert!(gateway.forwarded("GET", url), "{url} was not forwarded");
    }
    assert!(gateway.calls().is_empty());
}

#[test]
fn the_apk_download_asks_the_host_then_falls_back_to_node() {
    // The front door claims `/multicc.apk` and asks the `apk-download` op; a host
    // that answers `next()` (the unscripted fixture) lets the retired chain
    // continue, which with no `public/multicc.apk` ends in the forward.
    let gateway = Gateway::start("apk-file", world(json!({})));
    let response = gateway.get("/multicc.apk");
    assert_eq!(response.status, 200, "{}", gateway.log());
    assert_eq!(response.body, "ok");
    assert!(gateway.forwarded("GET", "/multicc.apk"));
    let calls = gateway.calls();
    assert_eq!(calls.len(), 1, "{calls:?}");
    assert_eq!(calls[0]["op"], "apk-download");
}

// ── The device reply's four raw-body states ────────────────────────────────

fn raw_state(gateway: &Gateway) -> Value {
    let calls = gateway.calls();
    assert_eq!(calls.len(), 1, "{calls:?}\n{}", gateway.log());
    assert_eq!(calls[0]["op"], "udid-callback");
    calls[0]["rawBody"].clone()
}

#[test]
fn raw_body_state_buffer_carries_the_exact_bytes() {
    let gateway = Gateway::start("raw-buffer", world(json!({})));
    let bytes: Vec<u8> = (0u8..=255).collect();
    let response = callback(&gateway, &[("Content-Type", PKCS7)], Some(&bytes));
    assert_eq!(response.status, 200, "{}", gateway.log());
    let state = raw_state(&gateway);
    assert_eq!(state["kind"], "buffer");
    use base64::Engine;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(state["base64"].as_str().unwrap())
        .unwrap();
    assert_eq!(decoded, bytes);
}

#[test]
fn raw_body_state_buffer_accepts_exactly_the_limit() {
    let gateway = Gateway::start("raw-limit", world(json!({})));
    let bytes = vec![b'a'; 64 * 1024];
    callback(&gateway, &[("Content-Type", DEVICEINFO)], Some(&bytes));
    assert_eq!(raw_state(&gateway)["kind"], "buffer");
}

#[test]
fn raw_body_state_error_413_when_the_reply_exceeds_64kb() {
    let gateway = Gateway::start("raw-413", world(json!({})));
    // The declared length alone decides: the front door answers the host with
    // the 413 state before reading a byte, so no body is written (writing it
    // after the response would only provoke a connection reset).
    callback(
        &gateway,
        &[("Content-Type", PKCS7), ("Content-Length", "65537")],
        None,
    );
    assert_eq!(
        raw_state(&gateway),
        json!({ "kind": "error", "status": 413 })
    );
}

#[test]
fn raw_body_state_error_413_for_a_chunked_reply_over_the_limit() {
    let gateway = Gateway::start("raw-413-chunked", world(json!({})));
    let mut chunked = Vec::new();
    for _ in 0..3 {
        chunked.extend_from_slice(format!("{:x}\r\n", 32 * 1024).as_bytes());
        chunked.extend_from_slice(&vec![b'a'; 32 * 1024]);
        chunked.extend_from_slice(b"\r\n");
    }
    chunked.extend_from_slice(b"0\r\n\r\n");
    callback(
        &gateway,
        &[("Content-Type", PKCS7), ("Transfer-Encoding", "chunked")],
        Some(&chunked),
    );
    assert_eq!(
        raw_state(&gateway),
        json!({ "kind": "error", "status": 413 })
    );
}

#[test]
fn raw_body_state_error_400_for_a_gzip_reply_because_inflate_is_off() {
    let gateway = Gateway::start("raw-gzip", world(json!({})));
    callback(
        &gateway,
        &[("Content-Type", PKCS7), ("Content-Encoding", "gzip")],
        Some(b"\x1f\x8b\x08\x00"),
    );
    assert_eq!(
        raw_state(&gateway),
        json!({ "kind": "error", "status": 400 })
    );
}

#[test]
fn raw_body_state_none_when_the_request_has_no_body() {
    let gateway = Gateway::start("raw-none", world(json!({})));
    let response = callback(&gateway, &[("Content-Type", PKCS7)], None);
    assert_eq!(response.status, 200, "{}", gateway.log());
    assert_eq!(raw_state(&gateway), json!({ "kind": "none" }));
}

#[test]
fn raw_body_state_parsed_when_the_global_json_parser_consumed_the_body() {
    let gateway = Gateway::start("raw-parsed", world(json!({})));
    // Authenticated: `application/json` is not an Apple content type.
    callback(
        &gateway,
        &headers_with(&external(), &[("Content-Type", "application/json")]),
        Some(br#"{"a":1}"#),
    );
    assert_eq!(raw_state(&gateway), json!({ "kind": "parsed" }));
}

// ── HEAD ───────────────────────────────────────────────────────────────────

#[test]
fn head_has_headers_and_no_body_on_every_read_route() {
    let gateway = Gateway::start(
        "head",
        world(json!({
            "apk-info": { "status": 200, "body": { "available": true } },
            "ios-ota-manifest": {
                "status": 200, "contentType": "text/xml; charset=utf-8",
                "body": "<plist/>", "headers": [["Pragma", "no-cache"]]
            },
            "history": { "status": 200, "body": { "messages": [] } }
        })),
    );
    for (url, content_type) in [
        ("/api/apk-info", "application/json; charset=utf-8"),
        ("/ios-ota/manifest.plist", "text/xml; charset=utf-8"),
        (
            "/api/sessions/s1/history",
            "application/json; charset=utf-8",
        ),
    ] {
        let response = gateway.exchange("HEAD", url, &external(), None);
        assert_eq!(response.status, 200, "{url}: {}", gateway.log());
        assert_eq!(response.header("content-type"), Some(content_type), "{url}");
        assert!(response.header("content-length").is_some(), "{url}");
        assert_ne!(response.header("content-length"), Some("0"), "{url}");
        assert_eq!(response.body, "", "{url}");
    }
    let methods: Vec<String> = gateway
        .calls()
        .iter()
        .map(|call| call["method"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(methods, vec!["HEAD", "HEAD", "HEAD"]);
    assert_eq!(gateway.head("/api/ios-ota-info").status, 200);
}

// ── Write serialization ────────────────────────────────────────────────────

/// Fire one request per entry at the same moment and return the statuses.
type BurstRequest<'a> = (&'a str, String, Vec<(&'a str, &'a str)>);

fn burst(gateway: &Gateway, requests: &[BurstRequest]) -> Vec<u16> {
    std::thread::scope(|scope| {
        let handles: Vec<_> = requests
            .iter()
            .map(|(method, url, headers)| {
                scope.spawn(move || {
                    let body: Option<&[u8]> = if *method == "POST" { Some(b"x") } else { None };
                    gateway.exchange(method, url, headers, body).status
                })
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    })
}

fn assert_alternating(phases: &[String], expected: usize) {
    assert_eq!(phases.len(), expected * 2, "{phases:?}");
    for pair in phases.chunks(2) {
        let (start, end) = (&pair[0], &pair[1]);
        assert!(start.starts_with("start:"), "{phases:?}");
        assert_eq!(end.replacen("end:", "start:", 1), *start, "{phases:?}");
    }
}

#[test]
fn concurrent_hits_on_one_write_route_do_not_interleave() {
    let gateway = Gateway::start(
        "write-same",
        json!({ "releaseHistory": { "delayMs": 150, "ops": {} } }),
    );
    let requests: Vec<_> = (0..4)
        .map(|_| ("GET", "/ios-ota/udid.mobileconfig".to_string(), external()))
        .collect();
    assert_eq!(burst(&gateway, &requests), vec![200; 4]);
    assert_alternating(&gateway.phases(), 4);
}

#[test]
fn the_three_write_routes_share_one_lock() {
    let gateway = Gateway::start(
        "write-mixed",
        json!({ "releaseHistory": { "delayMs": 150, "ops": {} } }),
    );
    let callback_headers = headers_with(&external(), &[("Content-Type", PKCS7)]);
    let requests = vec![
        ("GET", "/ios-ota/udid.mobileconfig".to_string(), external()),
        ("POST", callback_url(), callback_headers),
        (
            "DELETE",
            "/api/sessions/s1/messages/m1".to_string(),
            external(),
        ),
    ];
    assert_eq!(burst(&gateway, &requests), vec![200; 3]);
    let phases = gateway.phases();
    assert_alternating(&phases, 3);
    let mut ops = gateway.ops();
    ops.sort();
    assert_eq!(ops, vec!["message-delete", "udid-callback", "udid-profile"]);
}

#[test]
fn read_routes_are_not_serialized_behind_the_write_lock() {
    let gateway = Gateway::start(
        "read-parallel",
        json!({ "releaseHistory": { "delayMs": 500, "ops": {} } }),
    );
    let requests: Vec<_> = (0..3)
        .map(|_| ("GET", "/api/sessions/s1/history".to_string(), external()))
        .collect();
    assert_eq!(burst(&gateway, &requests), vec![200; 3]);
    let phases = gateway.phases();
    assert_eq!(phases.len(), 6, "{phases:?}");
    // At least two requests were in flight at once.
    let first_end = phases.iter().position(|p| p.starts_with("end:")).unwrap();
    assert!(first_end >= 2, "reads ran one at a time: {phases:?}");
}
