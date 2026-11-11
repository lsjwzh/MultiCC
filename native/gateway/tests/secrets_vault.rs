//! Integration coverage for the secrets vault routes against the real
//! `multicc-gateway` binary:
//!
//!   GET/HEAD/OPTIONS  /api/secrets
//!   POST/OPTIONS      /api/secrets
//!   POST/OPTIONS      /api/secrets/:name/rename
//!   DELETE/OPTIONS    /api/secrets/:name
//!   GET/HEAD/OPTIONS  /api/secrets/:name/value
//!
//! The Node process is the shared protocol fixture: it speaks PROXY v1, serves
//! the auth control bridge, and answers `/api/__host/secrets-vault` from the
//! JSON script the test writes (`FIXTURE_HOST_SCRIPT`). Routing, path decoding,
//! request validation, status codes, headers and response shapes are Rust and
//! are what these tests assert.

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

/// `NAME_RULE` in src/secrets-vault.js.
const NAME_RULE: &str = "name must be a valid env var identifier ([A-Za-z_][A-Za-z0-9_]*, 1-64 chars) so it can be injected as $NAME";

fn unique(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "multicc-gateway-secrets-vault-{}-{tag}-{nanos}",
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

    fn host_calls(&self) -> Vec<Value> {
        fs::read_to_string(self.state.join("secret-calls.jsonl"))
            .unwrap_or_default()
            .lines()
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn exchange(&self, method: &str, url: &str, body: Option<&Value>) -> Response {
        let payload = body.map(|value| value.to_string()).unwrap_or_default();
        let mut request = format!(
            "{method} {url} HTTP/1.1\r\nHost: localhost\r\nX-Request-Id: diff-req-1\r\nConnection: close\r\n"
        );
        if body.is_some() {
            request.push_str(&format!(
                "Content-Type: application/json\r\nContent-Length: {}\r\n",
                payload.len()
            ));
        }
        request.push_str("\r\n");
        request.push_str(&payload);
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

    fn request(&self, method: &str, url: &str, body: Option<&Value>) -> Response {
        self.exchange(method, url, body)
    }

    fn get(&self, url: &str) -> Response {
        self.exchange("GET", url, None)
    }

    fn post(&self, url: &str, body: &Value) -> Response {
        self.exchange("POST", url, Some(body))
    }

    fn delete(&self, url: &str) -> Response {
        self.exchange("DELETE", url, None)
    }
}

impl Drop for Gateway {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn family_error() -> Value {
    json!({
        "error": "secrets vault interface is not ready",
        "code": "rust_backend_unavailable",
    })
}

fn value_error() -> Value {
    json!({ "error": "value is required and cannot exceed 65536 characters" })
}

fn secret_script(secret: Value) -> Value {
    json!({ "secret": secret })
}

fn meta(name: &str, description: &str, source: &str, created: &str, updated: &str) -> Value {
    json!({
        "name": name,
        "description": description,
        "source": source,
        "createdAt": created,
        "updatedAt": updated,
    })
}

#[test]
fn list_passes_entries_through_verbatim() {
    let entries = json!([
        {
            "name": "BETA",
            "description": "second",
            "source": "user",
            "createdAt": null,
            "updatedAt": null,
        },
        {
            "name": "ALPHA",
            "description": "first",
            "source": "agent",
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-02T00:00:00.000Z",
            "updatedBy": "user-1",
        },
    ]);
    let gateway = Gateway::start("list", secret_script(json!({ "entries": entries })));
    let response = gateway.get("/api/secrets");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(
        response.header("content-type"),
        Some("application/json; charset=utf-8")
    );
    // The store's sort order, field order and optional `updatedBy` all come
    // through untouched.
    assert_eq!(
        response.body,
        "[{\"name\":\"BETA\",\"description\":\"second\",\"source\":\"user\",\
         \"createdAt\":null,\"updatedAt\":null},\
         {\"name\":\"ALPHA\",\"description\":\"first\",\"source\":\"agent\",\
         \"createdAt\":\"2026-01-01T00:00:00.000Z\",\
         \"updatedAt\":\"2026-01-02T00:00:00.000Z\",\"updatedBy\":\"user-1\"}]"
    );
    assert_eq!(gateway.host_calls(), vec![json!({ "op": "list" })]);
}

#[test]
fn create_is_201_when_the_store_creates() {
    let entry = json!({
        "name": "API_KEY",
        "description": "key",
        "source": "agent",
        "createdAt": "2026-01-01T00:00:00.000Z",
        "updatedAt": "2026-01-01T00:00:00.000Z",
        "updatedBy": "user-1",
    });
    let gateway = Gateway::start(
        "create",
        secret_script(json!({ "upsert": { "ok": true, "entry": entry, "created": true } })),
    );
    let response = gateway.post(
        "/api/secrets",
        &json!({
            "name": " API_KEY ",
            "value": "s3cret",
            "source": "agent",
            "description": " raw description ",
            "sessionId": { "who": "user-1" },
        }),
    );
    assert_eq!(response.status, 201, "{}", response.body);
    assert_eq!(
        response.body,
        "{\"ok\":true,\"entry\":{\"name\":\"API_KEY\",\"description\":\"key\",\
         \"source\":\"agent\",\"createdAt\":\"2026-01-01T00:00:00.000Z\",\
         \"updatedAt\":\"2026-01-01T00:00:00.000Z\",\"updatedBy\":\"user-1\"}}"
    );
    // The host sees the trimmed name, the raw optional fields and the raw
    // `sessionId` value.
    assert_eq!(
        gateway.host_calls(),
        vec![json!({
            "op": "upsert",
            "name": "API_KEY",
            "value": "s3cret",
            "source": "agent",
            "description": " raw description ",
            "sessionId": { "who": "user-1" },
        })]
    );
}

#[test]
fn update_is_200_when_the_store_updates() {
    let entry = meta(
        "API_KEY",
        "key",
        "user",
        "2026-01-01T00:00:00.000Z",
        "2026-01-02T00:00:00.000Z",
    );
    let gateway = Gateway::start(
        "update",
        secret_script(json!({ "upsert": { "ok": true, "entry": entry, "created": false } })),
    );
    let response = gateway.post(
        "/api/secrets",
        &json!({ "name": "API_KEY", "value": "rotated" }),
    );
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.json(), json!({ "ok": true, "entry": entry }));
}

#[test]
fn create_passes_only_the_optional_fields_the_body_had() {
    let gateway = Gateway::start("create-optional", secret_script(json!({})));
    // No description / sessionId keys, and `source` is not the strict string
    // `agent`, so the body carries only the four required fields.
    let response = gateway.post(
        "/api/secrets",
        &json!({ "name": "_TOKEN", "value": "v", "source": "AGENT", "description": 7 }),
    );
    assert_eq!(response.status, 201, "{}", response.body);
    let calls = gateway.host_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(
        calls[0],
        json!({ "op": "upsert", "name": "_TOKEN", "value": "v", "source": "user" })
    );
    assert!(calls[0].get("description").is_none());
    assert!(calls[0].get("sessionId").is_none());
}

#[test]
fn invalid_name_is_the_name_rule_400() {
    let gateway = Gateway::start("bad-name", secret_script(json!({})));
    for body in [
        json!({ "name": 7, "value": "x" }),
        json!({ "name": "", "value": "x" }),
        json!({ "name": "9lives", "value": "x" }),
        json!({ "name": "has-dash", "value": "x" }),
        json!({ "name": "has.dot", "value": "x" }),
        json!({ "name": "a".repeat(65), "value": "x" }),
    ] {
        let response = gateway.post("/api/secrets", &body);
        assert_eq!(response.status, 400, "{body}");
        assert_eq!(response.json(), json!({ "error": NAME_RULE }), "{body}");
    }
    // Validation happens before the store is touched.
    assert!(gateway.host_calls().is_empty());
}

#[test]
fn invalid_value_is_the_value_400() {
    let gateway = Gateway::start("bad-value", secret_script(json!({})));
    for body in [
        json!({ "name": "OK" }),
        json!({ "name": "OK", "value": 7 }),
        json!({ "name": "OK", "value": null }),
        json!({ "name": "OK", "value": "" }),
        json!({ "name": "OK", "value": "x".repeat(65537) }),
    ] {
        let response = gateway.post("/api/secrets", &body);
        assert_eq!(response.status, 400, "{body}");
        assert_eq!(response.json(), value_error(), "{body}");
    }
    assert!(gateway.host_calls().is_empty());

    // Exactly 65536 UTF-16 units is accepted.
    let longest = "x".repeat(65536);
    let response = gateway.post("/api/secrets", &json!({ "name": "OK", "value": longest }));
    assert_eq!(response.status, 201, "{}", response.body);
    let calls = gateway.host_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["value"].as_str().unwrap().len(), 65536);
}

#[test]
fn capacity_full_is_409() {
    let gateway = Gateway::start(
        "full",
        secret_script(json!({ "upsert": { "ok": false, "reason": "full" } })),
    );
    let response = gateway.post("/api/secrets", &json!({ "name": "NEW", "value": "x" }));
    assert_eq!(response.status, 409);
    assert_eq!(response.json(), json!({ "error": "vault is full" }));
}

#[test]
fn rename_maps_success_missing_exists_and_bad_target() {
    let entry = json!({
        "name": "RENAMED",
        "description": "kept",
        "source": "user",
        "createdAt": "2026-01-01T00:00:00.000Z",
        "updatedAt": "2026-01-02T00:00:00.000Z",
    });
    let success = Gateway::start(
        "rename-ok",
        secret_script(json!({ "rename": { "ok": true, "entry": entry } })),
    );
    let response = success.post("/api/secrets/old.key/rename", &json!({ "to": " RENAMED " }));
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(
        response.body,
        "{\"ok\":true,\"entry\":{\"name\":\"RENAMED\",\"description\":\"kept\",\
         \"source\":\"user\",\"createdAt\":\"2026-01-01T00:00:00.000Z\",\
         \"updatedAt\":\"2026-01-02T00:00:00.000Z\"}}"
    );
    // A bad target is rejected before the host is called; the old name only
    // has to pass the legacy pattern.
    let bad_target = success.post("/api/secrets/old.key/rename", &json!({ "to": "1bad" }));
    assert_eq!(bad_target.status, 400);
    assert_eq!(bad_target.json(), json!({ "error": NAME_RULE }));
    let bad_old = success.post("/api/secrets/bad%20name/rename", &json!({ "to": "NEW" }));
    assert_eq!(bad_old.status, 404);
    assert_eq!(bad_old.json(), json!({ "error": "entry not found" }));
    assert_eq!(
        success.host_calls(),
        vec![json!({ "op": "rename", "name": "old.key", "to": "RENAMED" })]
    );

    let missing = Gateway::start(
        "rename-missing",
        secret_script(json!({ "rename": { "ok": false, "reason": "missing" } })),
    );
    let response = missing.post("/api/secrets/absent/rename", &json!({ "to": "NEW" }));
    assert_eq!(response.status, 404);
    assert_eq!(response.json(), json!({ "error": "entry not found" }));

    let exists = Gateway::start(
        "rename-exists",
        secret_script(json!({ "rename": { "ok": false, "reason": "exists" } })),
    );
    let response = exists.post("/api/secrets/old/rename", &json!({ "to": "TAKEN" }));
    assert_eq!(response.status, 409);
    assert_eq!(
        response.json(),
        json!({ "error": "target name already exists" })
    );
}

#[test]
fn delete_maps_success_and_missing() {
    let success = Gateway::start(
        "delete-ok",
        secret_script(json!({ "remove": { "ok": true } })),
    );
    let response = success.delete("/api/secrets/Old-Key");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.body, "{\"ok\":true}");
    assert_eq!(
        success.host_calls(),
        vec![json!({ "op": "remove", "name": "Old-Key" })]
    );

    let missing = Gateway::start(
        "delete-missing",
        secret_script(json!({ "remove": { "ok": false, "reason": "missing" } })),
    );
    let response = missing.delete("/api/secrets/Old-Key");
    assert_eq!(response.status, 404);
    assert_eq!(response.json(), json!({ "error": "entry not found" }));

    // A name that fails the legacy pattern never reaches the host.
    let invalid = missing.delete("/api/secrets/bad%20name");
    assert_eq!(invalid.status, 404);
    assert_eq!(invalid.json(), json!({ "error": "entry not found" }));
    assert_eq!(missing.host_calls().len(), 1);
}

#[test]
fn reveal_returns_the_value_only_in_the_reveal_body() {
    let gateway = Gateway::start(
        "reveal",
        secret_script(json!({
            "entries": [meta("API_KEY", "", "user", "", "")],
            "reveal": { "ok": true, "name": "API_KEY", "value": "top-secret" },
        })),
    );
    let revealed = gateway.get("/api/secrets/API_KEY/value");
    assert_eq!(revealed.status, 200, "{}", revealed.body);
    assert_eq!(
        revealed.body,
        "{\"ok\":true,\"name\":\"API_KEY\",\"value\":\"top-secret\"}"
    );
    assert!(revealed.body.contains("top-secret"));

    // The list projection carries no value.
    let listed = gateway.get("/api/secrets");
    assert_eq!(listed.status, 200, "{}", listed.body);
    assert!(!listed.body.contains("top-secret"));

    let missing = Gateway::start(
        "reveal-missing",
        secret_script(json!({ "reveal": { "ok": false, "reason": "missing" } })),
    );
    let response = missing.get("/api/secrets/API_KEY/value");
    assert_eq!(response.status, 404);
    assert_eq!(response.json(), json!({ "error": "entry not found" }));
}

#[test]
fn percent_encoded_name_is_decoded_and_trimmed() {
    let gateway = Gateway::start(
        "encoded",
        secret_script(json!({
            "reveal": { "ok": true, "name": "API_KEY", "value": "v" },
            "remove": { "ok": true },
        })),
    );
    let response = gateway.get("/api/secrets/%20API_KEY%20/value");
    assert_eq!(response.status, 200, "{}", response.body);
    let deleted = gateway.delete("/api/secrets/%20Old.Key%20");
    assert_eq!(deleted.status, 200, "{}", deleted.body);
    assert_eq!(
        gateway.host_calls(),
        vec![
            json!({ "op": "reveal", "name": "API_KEY" }),
            json!({ "op": "remove", "name": "Old.Key" }),
        ]
    );
}

#[test]
fn trailing_slash_matches_the_express_route() {
    let gateway = Gateway::start(
        "trailing",
        secret_script(json!({
            "entries": [],
            "upsert": { "ok": true, "created": true, "entry": meta("NEW", "", "user", "", "") },
            "rename": { "ok": true, "entry": meta("NEW", "", "user", "", "") },
            "remove": { "ok": true },
            "reveal": { "ok": true, "name": "NEW", "value": "v" },
        })),
    );
    assert_eq!(gateway.get("/api/secrets/").status, 200);
    assert_eq!(
        gateway
            .post("/api/secrets/", &json!({ "name": "NEW", "value": "v" }))
            .status,
        201
    );
    assert_eq!(
        gateway
            .post("/api/secrets/old/rename/", &json!({ "to": "NEW" }))
            .status,
        200
    );
    assert_eq!(gateway.delete("/api/secrets/NEW/").status, 200);
    assert_eq!(gateway.get("/api/secrets/NEW/value/").status, 200);
    assert_eq!(
        gateway.host_calls(),
        vec![
            json!({ "op": "list" }),
            json!({ "op": "upsert", "name": "NEW", "value": "v", "source": "user" }),
            json!({ "op": "rename", "name": "old", "to": "NEW" }),
            json!({ "op": "remove", "name": "NEW" }),
            json!({ "op": "reveal", "name": "NEW" }),
        ]
    );
}

#[test]
fn options_allow_lists() {
    let gateway = Gateway::start("options", secret_script(json!({})));
    for (path, allow) in [
        ("/api/secrets", "GET,HEAD,POST"),
        ("/api/Secrets/", "GET,HEAD,POST"),
        ("/api/secrets/anything", "DELETE"),
        ("/api/secrets/anything/", "DELETE"),
        ("/api/secrets/anything/rename", "POST"),
        ("/api/secrets/anything/value", "GET,HEAD"),
    ] {
        let response = gateway.request("OPTIONS", path, None);
        assert_eq!(response.status, 200, "{path}");
        assert_eq!(response.header("allow"), Some(allow), "{path}");
        assert_eq!(response.body, allow, "{path}");
    }
    // Express answers OPTIONS itself, before any handler runs.
    assert!(gateway.host_calls().is_empty());
}

#[test]
fn head_matches_get_without_a_body() {
    let gateway = Gateway::start(
        "head",
        secret_script(json!({
            "entries": [meta("A", "", "user", "", "")],
            "reveal": { "ok": true, "name": "A", "value": "v" },
        })),
    );
    let get = gateway.get("/api/secrets");
    let head = gateway.request("HEAD", "/api/secrets", None);
    assert_eq!(head.status, 200);
    assert_eq!(head.body, "");
    assert_eq!(head.header("etag"), get.header("etag"));
    assert_eq!(head.header("content-type"), get.header("content-type"));

    let get = gateway.get("/api/secrets/A/value");
    let head = gateway.request("HEAD", "/api/secrets/A/value", None);
    assert_eq!(head.status, 200);
    assert_eq!(head.body, "");
    assert_eq!(head.header("etag"), get.header("etag"));
}

#[test]
fn host_down_answers_the_family_shape() {
    let gateway = Gateway::start("host-down", json!({ "hostDown": true, "secret": {} }));
    for (method, path, body) in [
        ("GET", "/api/secrets", None),
        (
            "POST",
            "/api/secrets",
            Some(json!({ "name": "A", "value": "x" })),
        ),
        (
            "POST",
            "/api/secrets/old/rename",
            Some(json!({ "to": "B" })),
        ),
        ("DELETE", "/api/secrets/old", None),
        ("GET", "/api/secrets/old/value", None),
    ] {
        let response = match (method, body) {
            ("POST", Some(body)) => gateway.post(path, &body),
            _ => gateway.request(method, path, None),
        };
        assert_eq!(response.status, 503, "{method} {path}: {}", response.body);
        assert_eq!(response.json(), family_error(), "{method} {path}");
    }
}

#[test]
fn unclaimed_paths_still_reach_node() {
    let gateway = Gateway::start("forward", secret_script(json!({})));
    // The fixture answers `ok` for anything it does not serve by name; a
    // claimed path would answer JSON from Rust instead.
    for (method, path, body) in [
        ("GET", "/api/secrets/a/b", None),
        ("POST", "/api/secrets/foo", Some(json!({}))),
        ("GET", "/API/secrets", None),
        // `/rename` only has POST; a GET is not a route.
        ("GET", "/api/secrets/a/rename", None),
        // `/value` only has GET/HEAD.
        ("DELETE", "/api/secrets/a/value", None),
        ("GET", "/api/secrets//", None),
    ] {
        let response = match (method, body) {
            ("POST", Some(body)) => gateway.post(path, &body),
            _ => gateway.request(method, path, None),
        };
        assert_eq!(response.status, 200, "{method} {path}: {}", response.body);
        assert_eq!(response.body, "ok", "{method} {path} was answered in Rust");
    }
    assert!(gateway.host_calls().is_empty());
}
