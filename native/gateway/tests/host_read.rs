//! Integration coverage for the read-only host routes retired from
//! `src/routes/host-read.js` and answered by the Rust front door
//! (`native/gateway/src/app/host_read.rs`):
//!
//!   GET/HEAD/OPTIONS  /api/push/vapid-key
//!   GET/HEAD/OPTIONS  /api/push/health
//!   GET/HEAD/OPTIONS  /api/settings/notify
//!   GET/HEAD/OPTIONS  /api/settings/tunnel
//!   GET/HEAD/OPTIONS  /api/tunnel/funnel
//!   GET/HEAD/OPTIONS  /api/tunnel/ipv6
//!   GET/HEAD/OPTIONS  /api/tunnel/sakurafrp
//!   GET/HEAD/OPTIONS  /api/settings/access-token
//!   GET/HEAD/OPTIONS  /api/settings/power
//!   GET/HEAD/OPTIONS  /api/host/battery
//!
//! The Node process here is only the protocol fixture (PROXY v1 + auth
//! control): it answers `POST /api/__host/host-read` from
//! `script.hostRead.answers[op]` (`FIXTURE_HOST_SCRIPT`) and appends every
//! request body to `host-read-calls.jsonl`. Routing, path matching, the push
//! health DTOs and fingerprints, URL/token masking, the `canEdit` locality
//! decision, status codes, headers and error bodies are Rust and are what these
//! tests assert.

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
        "multicc-gateway-host-read-{}-{tag}-{nanos}",
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

    /// Replace the script the fixture reads on every host-port request. The
    /// fixture reads the file per call, so unmasked request ordering is safe.
    fn set_script(&self, script: Value) {
        fs::write(self.dir.join("host-script.json"), script.to_string()).unwrap();
    }

    /// Every `POST /api/__host/host-read` body the fixture received, in order.
    fn host_calls(&self) -> Vec<Value> {
        fs::read_to_string(self.state.join("host-read-calls.jsonl"))
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

/// `{ hostRead: { answers: { <op>: <answer> } } }`.
fn script_with(answers: Value) -> Value {
    json!({ "hostRead": { "answers": answers } })
}

fn gunzip(bytes: &[u8]) -> String {
    let mut text = String::new();
    GzDecoder::new(bytes)
        .read_to_string(&mut text)
        .expect("valid gzip body");
    text
}

const JSON: &str = "application/json; charset=utf-8";

// ── vapid key ───────────────────────────────────────────────────────────────

#[test]
fn vapid_key_is_wrapped_and_a_missing_payload_is_an_empty_object() {
    let gateway = Gateway::start(
        "vapid",
        script_with(json!({ "vapid-key": { "ok": true, "payload": "BPUBLIC-KEY" } })),
    );
    let response = gateway.get("/api/push/vapid-key");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.header("content-type"), Some(JSON));
    assert_eq!(response.body, r#"{"publicKey":"BPUBLIC-KEY"}"#);

    // `{ publicKey: undefined }` serializes without the key.
    gateway.set_script(script_with(json!({ "vapid-key": { "ok": true } })));
    let response = gateway.get("/api/push/vapid-key/");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.body, "{}");
    assert_eq!(
        gateway.host_calls(),
        vec![json!({ "op": "vapid-key" }), json!({ "op": "vapid-key" })]
    );
}

// ── push health ─────────────────────────────────────────────────────────────

#[test]
fn push_health_builds_fingerprints_and_classifies_failures() {
    let gateway = Gateway::start(
        "push-health",
        script_with(json!({
            "push-health": {
                "ok": true,
                "payload": {
                    "endpoints": [
                        "https://push.example.com/one",
                        "https://push.example.com/two",
                    ],
                    "health": [
                        {
                            "successCount": 3,
                            "failCount": "9",
                            "lastSuccessTime": 1000,
                            "lastFailTime": 7.5,
                            "lastFailReason": "HTTP status: 503",
                            "consecutiveFails": 2,
                        },
                        {
                            "successCount": 1,
                            "failCount": 0,
                            "lastSuccessTime": 5,
                            "lastFailTime": 0,
                            "lastFailReason": "",
                            "consecutiveFails": 0,
                        },
                    ],
                    "size": 2,
                    "globalStats": {
                        "totalSent": 9,
                        "totalSuccess": 7,
                        "totalFail": 2,
                        "lastPushTime": 1234,
                        "lastPushType": " waiting ",
                    },
                    "barkConfigured": true,
                    "barkHealth": {
                        "lastSendTime": 10,
                        "lastSuccess": true,
                        "lastError": "connect ECONNREFUSED",
                    },
                    "webhookConfigured": false,
                    "webhookHealth": {
                        "lastSendTime": 0,
                        "lastSuccess": false,
                        "lastError": "HTTP status: 503",
                    },
                },
            },
        })),
    );
    let response = gateway.get("/api/push/health");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.header("content-type"), Some(JSON));
    // Key order, fingerprint length and the DTO field order are exact; the
    // string "9" and -0 style values were coerced by the Rust port.
    assert_eq!(
        response.body,
        r#"{"subscriptions":[{"endpointFingerprint":"sha256:3acbfbf1aaa16ee1","successCount":3,"failCount":0,"lastSuccessTime":1000,"lastFailTime":7.5,"lastFailReason":"http_5xx","consecutiveFails":2},{"endpointFingerprint":"sha256:b36c00c4a73514e4","successCount":1,"failCount":0,"lastSuccessTime":5,"lastFailTime":0,"lastFailReason":"","consecutiveFails":0}],"subscriptionCount":2,"global":{"totalSent":9,"totalSuccess":7,"totalFail":2,"lastPushTime":1234,"lastPushType":"waiting"},"bark":{"configured":true,"lastSendTime":10,"lastSuccess":true,"lastError":"connection_refused"},"webhook":{"configured":false,"lastSendTime":0,"lastSuccess":false,"lastError":"http_5xx"}}"#
    );
    assert_eq!(gateway.host_calls(), vec![json!({ "op": "push-health" })]);
}

#[test]
fn push_health_without_a_health_entry_uses_zeros() {
    let gateway = Gateway::start(
        "push-health-empty",
        script_with(json!({
            "push-health": {
                "ok": true,
                "payload": {
                    "endpoints": ["https://push.example.com/solo"],
                    "health": [],
                    "globalStats": {},
                    "barkConfigured": false,
                    "webhookConfigured": false,
                },
            },
        })),
    );
    let response = gateway.get("/api/push/health");
    assert_eq!(response.status, 200, "{}", response.body);
    // `size` was absent, so the count falls back to the endpoint list length.
    assert_eq!(
        response.body,
        r#"{"subscriptions":[{"endpointFingerprint":"sha256:dc3e627eab80cc58","successCount":0,"failCount":0,"lastSuccessTime":0,"lastFailTime":0,"lastFailReason":"","consecutiveFails":0}],"subscriptionCount":1,"global":{"totalSent":0,"totalSuccess":0,"totalFail":0,"lastPushTime":0,"lastPushType":""},"bark":{"configured":false,"lastSendTime":0,"lastSuccess":false,"lastError":""},"webhook":{"configured":false,"lastSendTime":0,"lastSuccess":false,"lastError":""}}"#
    );
}

// ── notify ──────────────────────────────────────────────────────────────────

#[test]
fn notify_masks_secret_urls_to_their_origin() {
    let gateway = Gateway::start(
        "notify",
        script_with(json!({
            "notify": {
                "ok": true,
                "payload": {
                    "barkUrl": "https://user:secret@Bark.Example:443/path?key=1",
                    "webhookUrl": "http://hooks.example:8080/x?token=1",
                    "hasBark": true,
                    "barkDevices": [{ "name": "phone", "key": "k" }],
                },
            },
        })),
    );
    let response = gateway.get("/api/settings/notify");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.header("content-type"), Some(JSON));
    let bullets = "\u{2022}\u{2022}\u{2022}\u{2022}";
    let expected = format!(
        r#"{{"barkUrl":"https://bark.example/{bullets}","barkOrigin":"https://bark.example","hasBark":true,"barkDevices":[{{"name":"phone","key":"k"}}],"webhookUrl":"http://hooks.example:8080/{bullets}","webhookOrigin":"http://hooks.example:8080","hasWebhook":true}}"#
    );
    assert_eq!(response.body, expected);
}

#[test]
fn notify_treats_unusable_urls_as_configured_without_an_origin() {
    let gateway = Gateway::start(
        "notify-invalid",
        script_with(json!({
            "notify": {
                "ok": true,
                "payload": {
                    "barkUrl": "ftp://files.example/x",
                    "webhookUrl": "/relative/path",
                },
            },
        })),
    );
    let response = gateway.get("/api/settings/notify");
    assert_eq!(response.status, 200, "{}", response.body);
    // Non-http(s) and unparseable values are still "configured", but only the
    // bullet mask is safe to show. `hasBark` falls back to bark.configured and
    // the absent `barkDevices` key is omitted.
    assert_eq!(
        response.body,
        "{\"barkUrl\":\"\u{2022}\u{2022}\u{2022}\u{2022}\",\"barkOrigin\":\"\",\
         \"hasBark\":true,\"webhookUrl\":\"\u{2022}\u{2022}\u{2022}\u{2022}\",\
         \"webhookOrigin\":\"\",\"hasWebhook\":true}"
    );
}

// ── verbatim echoes ─────────────────────────────────────────────────────────

#[test]
fn tunnel_ipv6_sakurafrp_and_battery_echo_their_payloads_verbatim() {
    let tunnel = json!({ "z": 1, "a": 2, "nested": { "y": true, "x": false } });
    let ipv6 = json!({ "b": true, "a": false });
    let sakura = json!({ "node": "jp", "tunnels": [{ "id": 2, "name": "a" }] });
    let battery = json!({ "level": 80, "charging": false, "z": 0 });
    let gateway = Gateway::start(
        "echo",
        script_with(json!({
            "tunnel": { "ok": true, "payload": tunnel.clone() },
            "ipv6": { "ok": true, "payload": ipv6.clone() },
            "sakurafrp": { "ok": true, "payload": sakura.clone() },
            "battery": { "ok": true, "payload": battery.clone() },
        })),
    );
    for (path, payload, op) in [
        ("/api/settings/tunnel", &tunnel, "tunnel"),
        ("/api/tunnel/ipv6", &ipv6, "ipv6"),
        ("/api/tunnel/sakurafrp", &sakura, "sakurafrp"),
        ("/api/host/battery", &battery, "battery"),
    ] {
        let response = gateway.get(path);
        assert_eq!(response.status, 200, "{path}: {}", response.body);
        assert_eq!(response.header("content-type"), Some(JSON), "{path}");
        // Deliberately non-alphabetical keys: any map reordering shows up here.
        assert_eq!(response.body, payload.to_string(), "{path} ({op})");
    }
    assert_eq!(
        gateway.host_calls(),
        vec![
            json!({ "op": "tunnel" }),
            json!({ "op": "ipv6" }),
            json!({ "op": "sakurafrp" }),
            json!({ "op": "battery" }),
        ]
    );
}

#[test]
fn funnel_is_wrapped_in_a_status_key() {
    let funnel = json!({ "state": "on", "port": 8443 });
    let gateway = Gateway::start(
        "funnel",
        script_with(json!({ "funnel": { "ok": true, "payload": funnel.clone() } })),
    );
    let response = gateway.get("/api/tunnel/funnel");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.body, format!(r#"{{"status":{}}}"#, funnel));

    // `{ status: undefined }` drops the key, exactly like the retired handler.
    gateway.set_script(script_with(json!({ "funnel": { "ok": true } })));
    let response = gateway.get("/api/tunnel/funnel");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.body, "{}");
}

// ── access token ────────────────────────────────────────────────────────────

#[test]
fn access_token_masks_all_but_the_last_four_characters() {
    let gateway = Gateway::start("access-token", script_with(json!({})));

    gateway.set_script(script_with(
        json!({ "access-token": { "ok": true, "payload": { "token": "0123456789" } } }),
    ));
    let response = gateway.get("/api/settings/access-token");
    assert_eq!(
        response.body,
        r#"{"hasToken":true,"masked":"****6789","canEdit":true}"#
    );

    // Four or fewer UTF-16 units is the bare mask.
    gateway.set_script(script_with(
        json!({ "access-token": { "ok": true, "payload": { "token": "abcd" } } }),
    ));
    let response = gateway.get("/api/settings/access-token");
    assert_eq!(
        response.body,
        r#"{"hasToken":true,"masked":"****","canEdit":true}"#
    );

    // An absent token is the empty string: no mask and `hasToken:false`.
    gateway.set_script(script_with(
        json!({ "access-token": { "ok": true, "payload": { "token": "" } } }),
    ));
    let response = gateway.get("/api/settings/access-token");
    assert_eq!(
        response.body,
        r#"{"hasToken":false,"masked":"","canEdit":true}"#
    );
}

// ── locality (canEdit) ──────────────────────────────────────────────────────

#[test]
fn can_edit_follows_request_locality() {
    let gateway = Gateway::start(
        "locality",
        script_with(json!({
            "access-token": { "ok": true, "payload": { "token": "abcdef" } },
        })),
    );

    // Loopback peer + loopback Host + no forwarding metadata.
    let local = gateway.get("/api/settings/access-token");
    assert_eq!(local.status, 200, "{}", local.body);
    assert_eq!(local.json()["canEdit"], json!(true));

    // A non-local Host header: the route still answers, but canEdit is false.
    let remote_host = gateway.get_with(
        "/api/settings/access-token",
        &[("Host", "remote.example.com"), ("X-Access-Token", TOKEN)],
    );
    assert_eq!(remote_host.status, 200, "{}", remote_host.body);
    assert_eq!(remote_host.json()["canEdit"], json!(false));

    // Loopback Host but a forwarding header: also not local.
    let forwarded = gateway.get_with(
        "/api/settings/access-token",
        &[
            ("X-Forwarded-For", "203.0.113.9"),
            ("X-Access-Token", TOKEN),
        ],
    );
    assert_eq!(forwarded.status, 200, "{}", forwarded.body);
    assert_eq!(forwarded.json()["canEdit"], json!(false));
}

#[test]
fn power_sends_the_locality_decision_to_the_host() {
    let payload = json!({ "canEdit": true, "editor": "host", "state": "on" });
    let gateway = Gateway::start(
        "power",
        script_with(json!({ "power": { "ok": true, "payload": payload.clone() } })),
    );
    let expected = payload.to_string();

    let local = gateway.get("/api/settings/power");
    assert_eq!(local.status, 200, "{}", local.body);
    assert_eq!(local.body, expected);

    let remote = gateway.get_with(
        "/api/settings/power",
        &[("Host", "remote.example.com"), ("X-Access-Token", TOKEN)],
    );
    assert_eq!(remote.status, 200, "{}", remote.body);

    let forwarded = gateway.get_with(
        "/api/settings/power",
        &[
            ("X-Forwarded-For", "203.0.113.9"),
            ("X-Access-Token", TOKEN),
        ],
    );
    assert_eq!(forwarded.status, 200, "{}", forwarded.body);

    let calls = gateway.host_calls();
    assert_eq!(
        calls,
        vec![
            json!({ "op": "power", "canEdit": true }),
            json!({ "op": "power", "canEdit": false }),
            json!({ "op": "power", "canEdit": false }),
        ]
    );
    // Exactly `op` and `canEdit`, nothing else.
    for call in &calls {
        assert_eq!(call.as_object().unwrap().len(), 2, "{call}");
    }
}

// ── failures ────────────────────────────────────────────────────────────────

#[test]
fn host_failure_answers_map_through_the_safe_error_dto() {
    let gateway = Gateway::start(
        "host-failure",
        script_with(json!({
            "tunnel": {
                "ok": false,
                "status": 500,
                "code": "EBOOM",
                "detail": "host exploded",
            },
            "ipv6": {
                "ok": false,
                "status": 400,
                "safeMessage": "bad tunnel request",
                "detail": "bad",
            },
            "sakurafrp": {
                "ok": false,
                "status": 418,
                "code": "bad code!",
                "safeMessage": "teapot",
                "detail": "x",
            },
        })),
    );

    let server = gateway.get("/api/settings/tunnel");
    assert_eq!(server.status, 500, "{}", server.body);
    assert_eq!(server.header("content-type"), Some(JSON));
    let body = server.json();
    assert_eq!(body["ok"], json!(false));
    assert_eq!(body["error"], json!("internal_error"));
    assert_eq!(body["code"], json!("EBOOM"));
    assert_eq!(body["apiVersion"], json!("v1"));
    assert_eq!(body["requestId"], json!("diff-req-1"));
    assert_eq!(body["correlationId"], json!("diff-req-1"));

    let client = gateway.get("/api/tunnel/ipv6");
    assert_eq!(client.status, 400, "{}", client.body);
    let body = client.json();
    assert_eq!(body["error"], json!("bad tunnel request"));
    assert_eq!(body["code"], json!("request_error"));

    // A code that is not an identifier falls back, but the safe message and
    // the host's status are kept.
    let teapot = gateway.get("/api/tunnel/sakurafrp");
    assert_eq!(teapot.status, 418, "{}", teapot.body);
    let body = teapot.json();
    assert_eq!(body["error"], json!("teapot"));
    assert_eq!(body["code"], json!("request_error"));
}

#[test]
fn host_down_is_the_internal_500() {
    let gateway = Gateway::start(
        "host-down",
        json!({
            "hostDown": true,
            "hostRead": { "answers": { "vapid-key": { "ok": true, "payload": "k" } } },
        }),
    );
    for path in ["/api/push/vapid-key", "/api/host/battery"] {
        let response = gateway.get(path);
        assert_eq!(response.status, 500, "{path}: {}", response.body);
        assert_eq!(response.header("content-type"), Some(JSON), "{path}");
        let body = response.json();
        assert_eq!(body["ok"], json!(false), "{path}");
        assert_eq!(body["error"], json!("internal_error"), "{path}");
        assert_eq!(body["code"], json!("internal_error"), "{path}");
    }
    // Both attempts reached the fixture; the failure was the destroyed socket.
    assert_eq!(
        gateway.host_calls(),
        vec![json!({ "op": "vapid-key" }), json!({ "op": "battery" })]
    );
}

// ── OPTIONS / HEAD / compression / paths / auth ─────────────────────────────

#[test]
fn options_allow_lists_follow_each_registered_pair() {
    let gateway = Gateway::start("options", script_with(json!({})));
    for (path, allow) in [
        ("/api/push/vapid-key", "GET,HEAD"),
        ("/api/push/health", "GET,HEAD"),
        ("/api/settings/notify", "GET,HEAD,POST"),
        ("/api/settings/tunnel", "GET,HEAD,POST"),
        ("/api/tunnel/funnel", "GET,HEAD,POST"),
        ("/api/tunnel/ipv6", "GET,HEAD"),
        ("/api/tunnel/sakurafrp", "GET,HEAD"),
        ("/api/settings/access-token", "GET,HEAD,POST"),
        ("/api/settings/power", "GET,HEAD,POST"),
        ("/api/host/battery", "GET,HEAD"),
        ("/api/Push/Vapid-Key/", "GET,HEAD"),
    ] {
        let response = gateway.options(path);
        assert_eq!(response.status, 200, "{path}");
        assert_eq!(response.header("allow"), Some(allow), "{path}");
        assert_eq!(response.body, allow, "{path}");
    }
    // Express answers OPTIONS itself, before any handler runs.
    assert!(gateway.host_calls().is_empty());
}

#[test]
fn head_matches_get_and_gzip_compresses_api_json() {
    let battery = json!({
        "level": 87,
        "charging": false,
        "temperature": 31.5,
        "note": "x".repeat(2000),
        "keys": ["b", "a"],
    });
    let gateway = Gateway::start(
        "head-gzip",
        script_with(json!({ "battery": { "ok": true, "payload": battery.clone() } })),
    );

    let get = gateway.get("/api/host/battery");
    assert_eq!(get.status, 200, "{}", get.body);
    assert_eq!(get.body, battery.to_string());
    assert_eq!(
        get.header("content-length"),
        Some(get.body.len().to_string().as_str())
    );

    let head = gateway.head("/api/host/battery");
    assert_eq!(head.status, 200);
    assert_eq!(head.body, "");
    assert_eq!(head.header("etag"), get.header("etag"));
    assert_eq!(head.header("content-type"), get.header("content-type"));
    assert_eq!(head.header("content-length"), get.header("content-length"));

    let gzip = gateway.get_with("/api/host/battery", &[("Accept-Encoding", "gzip")]);
    assert_eq!(gzip.status, 200);
    assert_eq!(gzip.header("content-encoding"), Some("gzip"));
    assert_eq!(gzip.header("vary"), Some("Accept-Encoding"));
    assert_eq!(
        gzip.header("content-length"),
        Some(gzip.raw_body.len().to_string().as_str())
    );
    assert_eq!(gunzip(&gzip.raw_body), get.body);
    // The handler still ran for every request.
    assert_eq!(gateway.host_calls().len(), 3);
}

#[test]
fn path_matching_claims_case_insensitively_and_one_trailing_slash() {
    let gateway = Gateway::start(
        "paths",
        script_with(json!({ "vapid-key": { "ok": true, "payload": "KEY" } })),
    );

    // Case-insensitive literal segments and one optional trailing slash.
    let claimed = gateway.get("/api/Push/Vapid-Key/");
    assert_eq!(claimed.status, 200, "{}", claimed.body);
    assert_eq!(claimed.body, r#"{"publicKey":"KEY"}"#);

    // None of these are claimed; the fixture's echo fallback answers `ok`.
    for (method, url) in [
        ("GET", "/api/push/vapid-key/extra"),
        ("GET", "/API/push/vapid-key"),
        ("GET", "/api/push/vapid-key//"),
        ("POST", "/api/settings/power"),
    ] {
        let response = gateway.request(method, url);
        assert_eq!(response.status, 200, "{method} {url}: {}", response.body);
        assert_eq!(response.body, "ok", "{method} {url} was answered in Rust");
        assert_eq!(
            response.header("content-type"),
            Some("text/plain"),
            "{method} {url}"
        );
        assert!(
            gateway.forwarded(method, url),
            "{method} {url} never reached Node"
        );
    }
    // Only the claimed request crossed the host port.
    assert_eq!(gateway.host_calls(), vec![json!({ "op": "vapid-key" })]);
}

#[test]
fn auth_gate_refuses_an_external_host_without_a_token() {
    let gateway = Gateway::start(
        "auth",
        script_with(json!({ "vapid-key": { "ok": true, "payload": "KEY" } })),
    );
    let response = gateway.get_with("/api/push/vapid-key", &[("Host", "remote.example.com")]);
    assert_eq!(response.status, 403, "{}", response.body);
    assert_eq!(response.header("content-type"), Some(JSON));
    let body = response.json();
    assert_eq!(body["ok"], json!(false));
    assert_eq!(body["error"], json!("Forbidden: not authenticated"));
    assert_eq!(body["code"], json!("AUTH_REQUIRED"));
    // The gate refused before the route asked the host port.
    assert!(gateway.host_calls().is_empty());
}
