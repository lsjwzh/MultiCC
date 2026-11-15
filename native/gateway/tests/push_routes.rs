#![recursion_limit = "256"]

//! Integration coverage for the 18 push routes retired from
//! `src/push/runtime.js`, `src/push/channel-subscriptions.js`,
//! `src/push/fcm-devices.js` and `src/push/bark-devices.js`, answered by the
//! Rust front door (`native/gateway/src/app/push_routes.rs`). The Node process
//! here is only the protocol fixture: it answers `POST /api/__host/push` from
//! `FIXTURE_HOST_SCRIPT` and appends every payload to `push-calls.jsonl`, so
//! the tests can assert exactly what the front door asked the runtime to do,
//! and in which order. Nothing here contacts a real FCM, Bark or webhook
//! endpoint: the fixture is the only upstream.

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
const JSON_TYPE: &str = "application/json; charset=utf-8";

fn unique(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "multicc-gateway-push-routes-{}-{tag}-{nanos}",
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
        fs::read_to_string(self.state.join("push-calls.jsonl"))
            .unwrap_or_default()
            .lines()
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    /// `content_type` overrides the default JSON type, so the media gate can be
    /// exercised; pass `None` for no body.
    fn exchange(
        &self,
        method: &str,
        url: &str,
        content_type: Option<&str>,
        body: Option<&str>,
    ) -> Response {
        let payload = body.unwrap_or("");
        let mut request =
            format!("{method} {url} HTTP/1.1\r\nHost: localhost\r\nX-Request-Id: push-req-1\r\n");
        if let Some(kind) = content_type {
            request.push_str(&format!("Content-Type: {kind}\r\n"));
        }
        if body.is_some() {
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
        self.exchange("GET", url, None, None)
    }
    fn head(&self, url: &str) -> Response {
        self.exchange("HEAD", url, None, None)
    }
    fn options(&self, url: &str) -> Response {
        self.exchange("OPTIONS", url, None, None)
    }
    fn post(&self, url: &str, body: &Value) -> Response {
        self.exchange(
            "POST",
            url,
            Some("application/json"),
            Some(&body.to_string()),
        )
    }
    fn send(&self, method: &str, url: &str, body: &Value) -> Response {
        self.exchange(
            method,
            url,
            Some("application/json"),
            Some(&body.to_string()),
        )
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

fn world(ops: Value) -> Value {
    json!({ "push": { "ops": ops } })
}

const VALID_ID: &str = "abcdefghijklmnop"; // 16 chars, within [16,128]
const VALID_BINDING: &str = "mnopqrstuvwxyz01";
const VALID_TOKEN: &str = "ABCDEFGHIJ_KL:mnopqrstuv"; // 24 chars, within [20,4096]

// ── web push subscriptions ─────────────────────────────────────────────────-

#[test]
fn subscribe_rejects_a_missing_endpoint_without_asking_the_host() {
    let gateway = Gateway::start("sub-missing", world(json!({})));
    for body in [json!({}), json!({ "endpoint": "" })] {
        let response = gateway.post("/api/push/subscribe", &body);
        assert_eq!(response.status, 400, "{body}");
        assert_eq!(response.body, r#"{"error":"Invalid subscription"}"#);
        assert_eq!(response.header("content-type"), Some(JSON_TYPE));
    }
    assert!(gateway.calls().is_empty());
}

#[test]
fn subscribe_and_unsubscribe_forward_the_body_and_answer_ok() {
    let gateway = Gateway::start(
        "sub-ok",
        world(json!({
            "subscribe": ok(json!({})),
            "unsubscribe": ok(json!({})),
        })),
    );
    let post = gateway.post("/api/push/subscribe", &json!({"endpoint": "https://e/1"}));
    assert_eq!(post.status, 200);
    assert_eq!(post.body, r#"{"ok":true}"#);
    let delete = gateway.send(
        "DELETE",
        "/api/push/subscribe",
        &json!({"endpoint": "https://e/1"}),
    );
    assert_eq!(delete.status, 200);
    assert_eq!(delete.body, r#"{"ok":true}"#);
    let calls = gateway.calls();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0]["op"], "subscribe");
    assert_eq!(calls[0]["body"]["endpoint"], "https://e/1");
    assert_eq!(calls[1]["op"], "unsubscribe");
    assert_eq!(calls[1]["body"]["endpoint"], "https://e/1");
}

#[test]
fn validate_gates_the_endpoint_and_returns_known() {
    let gateway = Gateway::start(
        "validate",
        world(json!({ "validate": ok(json!({"known": true})) })),
    );
    let missing = gateway.post("/api/push/validate", &json!({}));
    assert_eq!(missing.status, 400);
    assert_eq!(missing.body, r#"{"error":"Missing endpoint"}"#);
    assert!(gateway.calls().is_empty());

    let known = gateway.post("/api/push/validate", &json!({"endpoint": "https://e/1"}));
    assert_eq!(known.status, 200);
    assert_eq!(known.body, r#"{"known":true}"#);
    let calls = gateway.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["op"], "validate");
    assert_eq!(calls[0]["endpoint"], "https://e/1");
}

#[test]
fn the_test_route_reports_the_subscriber_count() {
    let gateway = Gateway::start(
        "test-count",
        world(json!({ "test": ok(json!({"subscribers": 3})) })),
    );
    let response = gateway.post("/api/push/test", &json!({}));
    assert_eq!(response.status, 200);
    assert_eq!(response.body, r#"{"ok":true,"subscribers":3}"#);
    assert_eq!(gateway.calls()[0]["op"], "test");
}

// ── notify ──────────────────────────────────────────────────────────────────

#[test]
fn notify_requires_json_and_forwards_the_body() {
    let gateway = Gateway::start(
        "notify",
        world(json!({
            "notify": ok(json!({
                "status": 202,
                "body": {"ok": true, "delivered": true, "deduped": false, "deliveredCount": 2},
            }))
        })),
    );
    let rejected = gateway.exchange("POST", "/api/push/notify", Some("text/plain"), Some("hi"));
    assert_eq!(rejected.status, 415);
    assert_eq!(
        rejected.body,
        r#"{"ok":false,"delivered":false,"deduped":false,"error":"UNSUPPORTED_MEDIA_TYPE"}"#
    );
    assert!(gateway.calls().is_empty());

    let accepted = gateway.post("/api/push/notify", &json!({"title": "t"}));
    assert_eq!(accepted.status, 202);
    assert_eq!(
        accepted.body,
        r#"{"ok":true,"delivered":true,"deduped":false,"deliveredCount":2}"#
    );
    let calls = gateway.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["op"], "notify");
    assert_eq!(calls[0]["body"]["title"], "t");
}

#[test]
fn notify_renders_the_retired_reply_status() {
    let gateway = Gateway::start(
        "notify-status",
        world(json!({
            "notify": ok(json!({
                "status": 409,
                "body": {"ok": false, "delivered": false, "deduped": false, "code": "BUSY"},
            }))
        })),
    );
    let response = gateway.post("/api/push/notify", &json!({}));
    assert_eq!(response.status, 409);
    assert_eq!(
        response.body,
        r#"{"ok":false,"delivered":false,"deduped":false,"code":"BUSY"}"#
    );
}

// ── direct channel tests ────────────────────────────────────────────────────

#[test]
fn test_bark_reports_configured_ok_and_failure() {
    let unconfigured = Gateway::start(
        "bark-unconfigured",
        world(json!({ "test-bark": ok(json!({"configured": false})) })),
    );
    let response = unconfigured.post("/api/push/test-bark", &json!({}));
    assert_eq!(response.status, 400);
    assert_eq!(response.body, r#"{"error":"Bark URL not configured"}"#);

    let failed = Gateway::start(
        "bark-failed",
        world(json!({ "test-bark": ok(json!({"configured": true, "ok": false})) })),
    );
    let response = failed.post("/api/push/test-bark", &json!({}));
    assert_eq!(response.status, 502);
    assert_eq!(response.body, r#"{"error":"bark_test_failed"}"#);

    let delivered = Gateway::start(
        "bark-ok",
        world(json!({ "test-bark": ok(json!({"configured": true, "ok": true})) })),
    );
    let response = delivered.post("/api/push/test-bark", &json!({}));
    assert_eq!(response.status, 200);
    assert_eq!(response.body, r#"{"ok":true}"#);
}

#[test]
fn test_webhook_reports_configured() {
    let unconfigured = Gateway::start(
        "webhook-unconfigured",
        world(json!({ "test-webhook": ok(json!({"configured": false})) })),
    );
    let response = unconfigured.post("/api/push/test-webhook", &json!({}));
    assert_eq!(response.status, 400);
    assert_eq!(response.body, r#"{"error":"Webhook URL not configured"}"#);

    let configured = Gateway::start(
        "webhook-configured",
        world(json!({ "test-webhook": ok(json!({"configured": true})) })),
    );
    let response = configured.post("/api/push/test-webhook", &json!({}));
    assert_eq!(response.status, 200);
    assert_eq!(response.body, r#"{"ok":true}"#);
}

// ── plugin channels ─────────────────────────────────────────────────────────

#[test]
fn channel_get_returns_the_catalog_payload() {
    let gateway = Gateway::start(
        "channel-get",
        world(json!({
            "channel-get": ok(json!({
                "subscriptions": [{"id": "s1", "channel": "bark", "categories": ["done"]}],
                "otherChannels": {"fcm": 1},
            }))
        })),
    );
    let response = gateway.get("/api/push/channel-subscriptions");
    assert_eq!(response.status, 200);
    assert_key_order(
        &response.body,
        &["subscriptions", "categories", "defaults", "otherChannels"],
    );
    let value = response.json();
    assert_eq!(
        value["categories"],
        json!(["done", "question", "background", "error"])
    );
    assert_eq!(value["defaults"], json!(["error", "question"]));
    assert_eq!(value["subscriptions"][0]["id"], "s1");
    assert_eq!(value["otherChannels"], json!({"fcm": 1}));
}

#[test]
fn channel_replace_forwards_subscriptions() {
    let subscriptions = json!([{"id": "s1", "channel": "webhook", "categories": ["error"]}]);
    let gateway = Gateway::start(
        "channel-replace",
        world(json!({
            "channel-replace": ok(json!({
                "subscriptions": subscriptions,
                "otherChannels": {},
            }))
        })),
    );
    let response = gateway.send(
        "PUT",
        "/api/push/channel-subscriptions",
        &json!({ "subscriptions": subscriptions }),
    );
    assert_eq!(response.status, 200);
    assert_eq!(response.json()["subscriptions"][0]["id"], "s1");
    let calls = gateway.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["op"], "channel-replace");
    assert_eq!(calls[0]["subscriptions"][0]["channel"], "webhook");
}

#[test]
fn channel_upsert_forwards_the_body() {
    let gateway = Gateway::start(
        "channel-upsert",
        world(json!({
            "channel-upsert": ok(json!({"subscriptions": [], "otherChannels": {"fcm": 2}}))
        })),
    );
    let response = gateway.post(
        "/api/push/channel-subscriptions",
        &json!({"channel": "bark", "categories": ["done"]}),
    );
    assert_eq!(response.status, 200);
    assert_eq!(response.json()["otherChannels"], json!({"fcm": 2}));
    let calls = gateway.calls();
    assert_eq!(calls[0]["op"], "channel-upsert");
    assert_eq!(calls[0]["body"]["channel"], "bark");
}

#[test]
fn channel_remove_decodes_the_id() {
    let gateway = Gateway::start(
        "channel-remove",
        world(json!({
            "channel-remove": ok(json!({"subscriptions": [], "otherChannels": {}}))
        })),
    );
    let response = gateway.send(
        "DELETE",
        "/api/push/channel-subscriptions/chs%2F1",
        &json!({}),
    );
    assert_eq!(response.status, 200);
    let calls = gateway.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["op"], "channel-remove");
    assert_eq!(calls[0]["id"], "chs/1");
}

#[test]
fn channel_errors_render_the_code_envelope() {
    let gateway = Gateway::start(
        "channel-error",
        world(json!({
            "channel-upsert": ok(json!({
                "channelError": {
                    "status": 404,
                    "message": "Channel not found",
                    "code": "CHANNEL_NOT_FOUND",
                }
            }))
        })),
    );
    let response = gateway.post("/api/push/channel-subscriptions", &json!({"id": "nope"}));
    assert_eq!(response.status, 404);
    assert_eq!(
        response.body,
        r#"{"error":"Channel not found","code":"CHANNEL_NOT_FOUND"}"#
    );
}

#[test]
fn test_channel_forwards_and_can_answer_an_error() {
    let delivered = Gateway::start(
        "test-channel-ok",
        world(json!({
            "test-channel": ok(json!({
                "ok": true,
                "channel": "bark",
                "receipt": {"delivered": true, "deduped": false},
            }))
        })),
    );
    let response = delivered.post("/api/push/test-channel", &json!({"id": "s1"}));
    assert_eq!(response.status, 200);
    assert_eq!(
        response.body,
        r#"{"ok":true,"channel":"bark","receipt":{"delivered":true,"deduped":false}}"#
    );
    let calls = delivered.calls();
    assert_eq!(calls[0]["op"], "test-channel");
    assert_eq!(calls[0]["body"]["id"], "s1");

    let failed = Gateway::start(
        "test-channel-error",
        world(json!({
            "test-channel": ok(json!({
                "channelError": {"status": 400, "message": "Channel disabled", "code": "CHANNEL_DISABLED"}
            }))
        })),
    );
    let response = failed.post("/api/push/test-channel", &json!({"id": "s2"}));
    assert_eq!(response.status, 400);
    assert_eq!(
        response.body,
        r#"{"error":"Channel disabled","code":"CHANNEL_DISABLED"}"#
    );
}

// ── FCM devices ─────────────────────────────────────────────────────────────

#[test]
fn fcm_status_projects_the_dto_and_head_follows_get() {
    let gateway = Gateway::start(
        "fcm-status",
        world(json!({
            "fcm-status": ok(json!({"configured": true, "devices": 2, "storageAvailable": false}))
        })),
    );
    let get = gateway.get("/api/push/fcm");
    assert_eq!(get.status, 200);
    assert_eq!(
        get.body,
        r#"{"configured":true,"devices":2,"storageAvailable":false}"#
    );
    let head = gateway.head("/api/push/fcm");
    assert_eq!(head.status, 200);
    assert!(head.body.is_empty(), "HEAD body: {}", head.body);
}

#[test]
fn fcm_register_and_remove_keep_the_status_key() {
    let gateway = Gateway::start(
        "fcm-devices",
        world(json!({
            "fcm-register": ok(json!({"status": 200, "ok": true, "device": {"id": VALID_ID}})),
            "fcm-remove": ok(json!({"status": 200, "ok": true})),
        })),
    );
    // Pre-gate refusals: the whole { status, error } object is the body.
    let bad_register = gateway.post("/api/push/fcm", &json!({"id": "short"}));
    assert_eq!(bad_register.status, 400);
    assert_eq!(
        bad_register.body,
        r#"{"status":400,"error":"INVALID_FCM_DEVICE"}"#
    );
    let bad_remove = gateway.send("DELETE", "/api/push/fcm", &json!({"id": "short"}));
    assert_eq!(bad_remove.status, 400);
    assert_eq!(
        bad_remove.body,
        r#"{"status":400,"error":"INVALID_FCM_DEVICE"}"#
    );
    assert!(gateway.calls().is_empty());

    let register = gateway.post(
        "/api/push/fcm",
        &json!({"id": VALID_ID, "binding": VALID_BINDING, "token": VALID_TOKEN}),
    );
    assert_eq!(register.status, 200);
    assert_eq!(
        register.body,
        r#"{"status":200,"ok":true,"device":{"id":"abcdefghijklmnop"}}"#
    );
    let remove = gateway.send("DELETE", "/api/push/fcm", &json!({"id": VALID_ID}));
    assert_eq!(remove.status, 200);
    assert_eq!(remove.body, r#"{"status":200,"ok":true}"#);
    let calls = gateway.calls();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0]["op"], "fcm-register");
    assert_eq!(calls[0]["body"]["token"], VALID_TOKEN);
    assert_eq!(calls[1]["op"], "fcm-remove");
    assert_eq!(calls[1]["body"]["id"], VALID_ID);
}

#[test]
fn fcm_test_maps_ok_to_200_and_failure_to_502() {
    let gateway = Gateway::start(
        "fcm-test",
        world(json!({
            "fcm-test": ok(json!({"ok": true, "messageId": "m1"})),
        })),
    );
    let invalid = gateway.post("/api/push/fcm/test", &json!({"id": "short"}));
    assert_eq!(invalid.status, 400);
    assert_eq!(invalid.body, r#"{"error":"INVALID_FCM_DEVICE"}"#);
    assert!(gateway.calls().is_empty());

    let delivered = gateway.post("/api/push/fcm/test", &json!({"id": VALID_ID}));
    assert_eq!(delivered.status, 200);
    assert_eq!(delivered.body, r#"{"ok":true,"messageId":"m1"}"#);
    assert_eq!(gateway.calls()[0]["op"], "fcm-test");
    assert_eq!(gateway.calls()[0]["id"], VALID_ID);

    let failed = Gateway::start(
        "fcm-test-fail",
        world(json!({ "fcm-test": ok(json!({"ok": false, "error": "FCM_SEND_FAILED"})) })),
    );
    let response = failed.post("/api/push/fcm/test", &json!({"id": VALID_ID}));
    assert_eq!(response.status, 502);
    assert_eq!(response.body, r#"{"ok":false,"error":"FCM_SEND_FAILED"}"#);
}

// ── Bark devices ────────────────────────────────────────────────────────────

#[test]
fn bark_devices_list_wraps_the_array() {
    // The host port answers `{ devices: [...] }` (or the retired
    // `{ status, body }` reply when the store is unreadable), not a bare array.
    let gateway = Gateway::start(
        "bark-list",
        world(json!({
            "bark-list": ok(json!({"devices": [{"id": "d1", "origin": "https://api.day.app"}]}))
        })),
    );
    let response = gateway.get("/api/push/bark-devices");
    assert_eq!(response.status, 200);
    assert_eq!(
        response.body,
        r#"{"devices":[{"id":"d1","origin":"https://api.day.app"}]}"#
    );

    let failing = Gateway::start(
        "bark-list-fail",
        world(json!({
            "bark-list": ok(json!({
                "status": 503,
                "body": {"error": "bark_storage_unavailable"}
            }))
        })),
    );
    let response = failing.get("/api/push/bark-devices");
    assert_eq!(response.status, 503);
    assert_eq!(response.body, r#"{"error":"bark_storage_unavailable"}"#);
}

#[test]
fn bark_action_requires_a_known_verb_and_forwards() {
    let gateway = Gateway::start(
        "bark-action",
        world(json!({
            "bark-action": ok(json!({
                "status": 200,
                "body": {"ok": true, "devices": [{"id": "d1", "origin": "https://api.day.app"}]},
            }))
        })),
    );
    let invalid = gateway.post("/api/push/bark-devices", &json!({"action": "bogus"}));
    assert_eq!(invalid.status, 400);
    assert_eq!(invalid.body, r#"{"error":"invalid_action"}"#);
    assert!(gateway.calls().is_empty());

    let added = gateway.post(
        "/api/push/bark-devices",
        &json!({"action": "add", "url": "https://api.day.app/KEY"}),
    );
    assert_eq!(added.status, 200);
    assert_key_order(&added.body, &["ok", "devices"]);
    let calls = gateway.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["op"], "bark-action");
    assert_eq!(calls[0]["body"]["action"], "add");

    let refused = Gateway::start(
        "bark-action-refused",
        world(json!({
            "bark-action": ok(json!({"status": 409, "body": {"error": "duplicate"}}))
        })),
    );
    let response = refused.post(
        "/api/push/bark-devices",
        &json!({"action": "add", "url": "https://api.day.app/KEY"}),
    );
    assert_eq!(response.status, 409);
    assert_eq!(response.body, r#"{"error":"duplicate"}"#);
}

// ── OPTIONS / HEAD ──────────────────────────────────────────────────────────

#[test]
fn options_unions_follow_registration_order() {
    let gateway = Gateway::start("options", world(json!({})));
    for (path, allow) in [
        ("/api/push/fcm", "GET,HEAD,POST,DELETE"),
        ("/api/push/fcm/test", "POST"),
        ("/api/push/bark-devices", "GET,HEAD,POST"),
        ("/api/push/channel-subscriptions", "GET,HEAD,PUT,POST"),
        ("/api/push/channel-subscriptions/chs_1", "DELETE"),
        ("/api/push/subscribe", "POST,DELETE"),
        ("/api/push/validate", "POST"),
        ("/api/push/test", "POST"),
        ("/api/push/notify", "POST"),
        ("/api/push/test-bark", "POST"),
        ("/api/push/test-webhook", "POST"),
        ("/api/push/test-channel", "POST"),
    ] {
        let response = gateway.options(path);
        assert_eq!(response.status, 200, "{path}");
        assert_eq!(response.header("allow"), Some(allow), "{path}");
        assert_eq!(
            response.header("content-type"),
            Some("text/html; charset=utf-8")
        );
        assert_eq!(response.body, allow, "{path}");
    }
    assert!(gateway.calls().is_empty());
}

// ── host-port failure surface (docs/gateway.md §9) ──────────────────────────

#[test]
fn host_unreachable_is_the_documented_503() {
    let gateway = Gateway::start(
        "host-down",
        json!({ "hostDown": true, "push": { "ops": {} } }),
    );
    let response = gateway.post("/api/push/test", &json!({}));
    assert_eq!(response.status, 503);
    assert_eq!(
        response.body,
        r#"{"error":"推送接口尚未就绪，请更新原生模块","code":"rust_backend_unavailable"}"#
    );
}

#[test]
fn host_failure_is_the_retired_500() {
    let gateway = Gateway::start("host-fail", world(json!({})));
    let response = gateway.post("/api/push/notify", &json!({"title": "t"}));
    assert_eq!(response.status, 500);
    assert_eq!(response.body, r#"{"error":"push request failed"}"#);
}

#[test]
fn the_read_and_write_routes_share_one_host_port() {
    // The same listener serves GET /api/push/fcm and POST /api/push/subscribe,
    // which is the confirmation that every route reaches the one Node runtime
    // (and therefore the one subscription Map the host-read projection reads).
    let gateway = Gateway::start(
        "shared-port",
        world(json!({
            "fcm-status": ok(json!({"configured": false, "devices": 0, "storageAvailable": true})),
            "subscribe": ok(json!({})),
        })),
    );
    assert_eq!(gateway.get("/api/push/fcm").status, 200);
    assert_eq!(
        gateway
            .post("/api/push/subscribe", &json!({"endpoint": "https://e/1"}))
            .status,
        200
    );
    let calls = gateway.calls();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0]["op"], "fcm-status");
    assert_eq!(calls[1]["op"], "subscribe");
}
