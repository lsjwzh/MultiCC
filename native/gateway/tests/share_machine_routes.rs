#![recursion_limit = "256"]

//! Integration coverage for the 21 sharing / machines / workspaces routes
//! retired from `src/machines.js`, `src/routes/share.js` and
//! `src/routes/workspaces.js`, answered by the Rust front door
//! (`native/gateway/src/app/share_machine_routes.rs`; matching rules in
//! `multicc_core::share_machine_routes`).
//!
//! The Node process here is only the protocol fixture: it answers
//! `POST /api/__host/share-machines` with `{ ok: true, value }` from
//! `FIXTURE_HOST_SCRIPT.shareMachines.ops` and appends every payload to
//! `share-machines-calls.jsonl`, so each test asserts exactly what the front
//! door asked Node to do — op name, decoded parameters, the query subset, the
//! relayed request headers, and the body Express would have parsed.
//!
//! Two areas prove the split rather than the payload:
//!
//! * `/share/:token` and the four `/api/share/:token/…` reads must reach the
//!   host with no access token, cookie or machine grant, from an external
//!   peer — the share token is its own authority. A control request shows an
//!   ordinary route from the same peer is refused.
//! * `POST /api/machines/:machineId/ws-ticket` relays the host's answer as-is;
//!   the ticket is minted by the child's `AuthRuntime`, so the front door keeps
//!   no second ticket table.
//!
//! `GET|POST|… /api/machines/:machineId/proxy` is the binary/SSE transport and
//! stays in Node: every method, OPTIONS included, is forwarded untouched.

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

fn unique(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "multicc-gateway-share-machines-{}-{tag}-{nanos}",
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

    fn lines(&self, name: &str) -> Vec<Value> {
        fs::read_to_string(self.state.join(name))
            .unwrap_or_default()
            .lines()
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    /// Every payload the front door sent the share-machines host port.
    fn calls(&self) -> Vec<Value> {
        self.lines("share-machines-calls.jsonl")
    }

    fn session_admin_calls(&self) -> Vec<Value> {
        self.lines("session-admin-calls.jsonl")
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
            format!("{method} {url} HTTP/1.1\r\nHost: localhost\r\nX-Request-Id: share-req-1\r\n");
        for (name, value) in extra {
            request.push_str(&format!("{name}: {value}\r\n"));
        }
        if body.is_some() {
            request.push_str("Content-Type: application/json\r\n");
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
            stream.write_all(payload).unwrap();
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
    fn delete(&self, url: &str) -> Response {
        self.exchange("DELETE", url, &[], None)
    }
    fn send(&self, method: &str, url: &str, body: &Value) -> Response {
        self.exchange(method, url, &[], Some(body.to_string().as_bytes()))
    }
    fn send_with(&self, method: &str, url: &str, body: &Value, extra: &[(&str, &str)]) -> Response {
        self.exchange(method, url, extra, Some(body.to_string().as_bytes()))
    }
    fn get_with(&self, url: &str, extra: &[(&str, &str)]) -> Response {
        self.exchange("GET", url, extra, None)
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

/// The `value` the host port answers: the retired handler's `{ status, body }`.
fn relay(status: u16, body: Value) -> Value {
    json!({ "status": status, "body": body })
}

fn world(ops: Value) -> Value {
    json!({ "shareMachines": { "ops": ops } })
}

/// An external peer: the ordinary gate would demand the access token.
fn external<'a>() -> Vec<(&'static str, &'a str)> {
    vec![("X-Forwarded-For", EXTERNAL_IP)]
}

// ── machines ────────────────────────────────────────────────────────────────

#[test]
fn machines_list_relays_the_no_store_header_and_the_payload() {
    let gateway = Gateway::start(
        "machines-list",
        world(json!({
            "machines-list": {
                "status": 200,
                "body": { "self": { "id": "m-self", "local": true }, "machines": [] },
                "headers": [["Cache-Control", "no-store"]],
            }
        })),
    );
    let response = gateway.get("/api/machines");
    assert_eq!(response.status, 200, "{}", gateway.log());
    assert_eq!(response.header("cache-control"), Some("no-store"));
    assert_eq!(
        response.header("content-type"),
        Some("application/json; charset=utf-8")
    );
    assert_eq!(response.json()["self"]["id"], json!("m-self"));
    // The host's key order survives, so the ETag matches the retired response.
    assert_key_order(&response.body, &["self", "machines"]);
    assert_eq!(
        gateway.calls(),
        vec![json!({
            "op": "machines-list",
            "method": "GET",
            "originalUrl": "/api/machines",
            "query": {},
            "headers": { "host": "localhost" },
            "body": {},
        })]
    );
}

#[test]
fn machines_reads_and_the_parameter_routes_decode_their_segments() {
    let gateway = Gateway::start(
        "machines-params",
        world(json!({
            "machines-grants": relay(200, json!({"grants": []})),
            "machines-rename": relay(200, json!({"ok": true})),
            "machines-remove": relay(200, json!({"ok": true})),
        })),
    );
    assert_eq!(gateway.get("/api/machines/grants").status, 200);
    assert_eq!(
        gateway
            .send("PATCH", "/api/machines/m%201", &json!({"name": "Laptop"}))
            .status,
        200
    );
    assert_eq!(gateway.delete("/api/machines/m-2").status, 200);
    let calls = gateway.calls();
    assert_eq!(calls[0]["op"], json!("machines-grants"));
    // Express decodes `:machineId` before the handler sees it.
    assert_eq!(calls[1]["machineId"], json!("m 1"));
    assert_eq!(calls[1]["body"], json!({"name": "Laptop"}));
    assert_eq!(calls[2]["machineId"], json!("m-2"));
}

#[test]
fn literals_match_case_insensitively_with_one_optional_trailing_slash() {
    let gateway = Gateway::start(
        "machine-literals",
        world(json!({ "machines-self": relay(200, json!({"id": "m-self"})) })),
    );
    assert_eq!(gateway.get("/api/MACHINES/Self/").status, 200);
    // No interior empty segment, no double slash.
    assert_eq!(gateway.get("/api/machines//self").status, 200);
    assert_eq!(gateway.calls().len(), 1);
}

#[test]
fn the_two_body_less_deletes_forward_no_body_but_patch_and_pair_do() {
    let gateway = Gateway::start(
        "machine-bodies",
        world(json!({
            // The retired handler refuses without a resolved grant id.
            "machines-connection-delete": relay(403, json!({"error": "缺少电脑授权"})),
            "machines-grant-revoke": relay(200, json!({"ok": true})),
            "machines-pair": relay(200, json!({"machine": {"id": "m1"}})),
        })),
    );
    // A machine grant is a scoped credential: the front door resolves it
    // itself, so an unknown one is refused before Node (fail-closed) and the
    // host port never sees the request.
    let refused = gateway.send_with(
        "DELETE",
        "/api/machines/connection",
        &json!({"ignored": true}),
        &[("X-Multicc-Machine-Grant", "mcg_unknown")],
    );
    assert_eq!(refused.status, 403, "{}", refused.body);
    assert!(gateway.calls().is_empty());
    // Without the grant the retired handler refuses on its own terms.
    let unauthenticated = gateway.send(
        "DELETE",
        "/api/machines/connection",
        &json!({"ignored": true}),
    );
    assert_eq!(unauthenticated.status, 403);
    assert_eq!(unauthenticated.json(), json!({"error": "缺少电脑授权"}));
    assert_eq!(
        gateway
            .send(
                "DELETE",
                "/api/machines/grants/g1",
                &json!({"ignored": true})
            )
            .status,
        200
    );
    assert_eq!(
        gateway
            .send_with(
                "POST",
                "/api/machines/pair",
                &json!({"ownerId": "m1", "name": "Peer"}),
                &[("X-Access-Token", TOKEN)],
            )
            .status,
        200
    );
    let calls = gateway.calls();
    assert_eq!(calls.len(), 3);
    // Both DELETEs registered no parser: Express left req.body undefined.
    assert_eq!(calls[0]["op"], json!("machines-connection-delete"));
    assert_eq!(calls[0]["body"], Value::Null);
    assert_eq!(calls[1]["op"], json!("machines-grant-revoke"));
    assert_eq!(calls[1]["body"], Value::Null);
    assert_eq!(calls[1]["grantId"], json!("g1"));
    // The scoped credential the retired handlers read reaches Node.
    assert_eq!(calls[2]["headers"]["x-access-token"], json!(TOKEN));
    assert_eq!(calls[2]["body"]["ownerId"], json!("m1"));
}

#[test]
fn a_machines_body_over_the_sixteen_kilobyte_limit_is_a_413() {
    let gateway = Gateway::start(
        "machine-limit",
        world(json!({ "machines-pair": relay(200, json!({"ok": true})) })),
    );
    let big = json!({ "padding": "x".repeat(16 * 1024) });
    let response = gateway.send("POST", "/api/machines/pair", &big);
    assert_eq!(response.status, 413, "{}", gateway.log());
    assert_eq!(response.json()["error"], json!("request_error"));
    // The global 50mb parser is looser; the share routes use it.
    let share = gateway.send(
        "POST",
        "/api/sessions/s1/share",
        &json!({ "padding": "x".repeat(64 * 1024) }),
    );
    assert_eq!(share.status, 200);
    assert!(!gateway.calls().is_empty());
}

#[test]
fn ws_ticket_relays_the_minted_ticket_in_key_order() {
    let gateway = Gateway::start(
        "ws-ticket",
        world(json!({
            "machines-ws-ticket": relay(200, json!({
                "ticket": "tkt-1", "expiresAt": 1750000000000_u64,
                "path": "/api/status", "proxyPath": "/ws/machines/m1",
            }))
        })),
    );
    let response = gateway.send(
        "POST",
        "/api/machines/m1/ws-ticket",
        &json!({"path": "/api/status"}),
    );
    assert_eq!(response.status, 200);
    assert_key_order(
        &response.body,
        &["ticket", "expiresAt", "path", "proxyPath"],
    );
    // The front door never mints a ticket itself: one host call, nothing else.
    let calls = gateway.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["op"], json!("machines-ws-ticket"));
    assert_eq!(calls[0]["machineId"], json!("m1"));
    assert_eq!(calls[0]["body"]["path"], json!("/api/status"));
}

#[test]
fn the_binary_proxy_path_is_forwarded_for_every_method() {
    let gateway = Gateway::start("proxy-forward", world(json!({})));
    for method in ["GET", "POST", "DELETE", "OPTIONS"] {
        let response = gateway.exchange(method, "/api/machines/m1/proxy/x", &[], None);
        // The fixture's catch-all. The important part: the host port never ran.
        assert_eq!(response.status, 200, "{method}: {}", response.body);
        assert_eq!(response.body, "ok", "{method}");
    }
    assert!(gateway.calls().is_empty(), "{:?}", gateway.calls());
}

#[test]
fn a_cross_site_page_cannot_borrow_the_machine_surface() {
    let gateway = Gateway::start(
        "cross-site",
        world(json!({ "machines-list": relay(200, json!({"machines": []})) })),
    );
    let response = gateway.get_with("/api/machines", &[("Sec-Fetch-Site", "cross-site")]);
    assert_eq!(response.status, 403);
    assert_eq!(
        response.json(),
        json!({
            "ok": false,
            "code": "machine_cross_site_denied",
            "error": "不允许从其他网站访问多电脑接口",
        })
    );
    // The guard was an `app.use('/api/machines', …)`: it also covered OPTIONS.
    let options = gateway.exchange(
        "OPTIONS",
        "/api/machines/connection",
        &[("Sec-Fetch-Site", "cross-site")],
        None,
    );
    assert_eq!(options.status, 403);
    assert!(gateway.calls().is_empty());
    // Other origins (and a missing header) pass.
    assert_eq!(
        gateway
            .get_with("/api/machines", &[("Sec-Fetch-Site", "same-origin")])
            .status,
        200
    );
}

// ── share ───────────────────────────────────────────────────────────────────

#[test]
fn the_public_share_page_is_reachable_from_an_external_peer_without_a_token() {
    let html = "<html><body>chat page</body></html>";
    let gateway = Gateway::start("share-page", world(json!({})));
    let public = gateway.dir.join("public");
    fs::create_dir(&public).unwrap();
    fs::write(public.join("chat.html"), html).unwrap();
    let response = gateway.get_with("/share/tok-abc", &external());
    assert_eq!(response.status, 200, "{}", gateway.log());
    assert_eq!(
        response.header("content-type"),
        Some("text/html; charset=utf-8")
    );
    assert_eq!(
        response.header("cache-control"),
        Some("no-store, no-cache, must-revalidate")
    );
    assert_eq!(response.header("pragma"), Some("no-cache"));
    // res.send() of a string still yields a weak ETag.
    assert!(response.header("etag").unwrap().starts_with("W/\""));
    assert_eq!(response.body, html);
    let cached = gateway.get_with(
        "/share/tok-abc",
        &[("If-None-Match", response.header("etag").unwrap())],
    );
    assert_eq!(cached.status, 304);
    let head = gateway.head("/share/tok-abc");
    assert_eq!(
        head.header("content-length"),
        Some(html.len().to_string().as_str())
    );
    assert!(head.body.is_empty());
    assert!(gateway.calls().is_empty());
}

#[test]
fn the_public_share_reads_bypass_the_gate_and_an_ordinary_route_does_not() {
    let gateway = Gateway::start(
        "share-public",
        world(json!({
            "share-entry": relay(200, json!({"access": "view", "type": "session", "label": "Handoff"})),
            "share-history": relay(200, json!({"messages": [], "hasMore": false})),
            "share-session": relay(200, json!({"access": "view", "type": "session", "messages": []})),
            "share-auth": relay(403, json!({"error": "密码错误"})),
            "session-shares-list": relay(200, json!({"shares": []})),
        })),
    );
    // Four public reads, one of them a POST: all reach the host.
    assert_eq!(
        gateway.get_with("/api/share/t1/entry", &external()).status,
        200
    );
    assert_eq!(
        gateway
            .get_with("/api/share/t1/history", &external())
            .status,
        200
    );
    assert_eq!(
        gateway
            .get_with("/api/share/t1/session", &external())
            .status,
        200
    );
    assert_eq!(
        gateway
            .send_with(
                "POST",
                "/api/share/t1/auth",
                &json!({"password": "x"}),
                &external()
            )
            .status,
        403
    );
    // Control: the same peer asking an admin route is refused before Node.
    let refused = gateway.get_with("/api/sessions/s1/shares", &external());
    assert_eq!(refused.status, 403, "{}", refused.body);
    assert_eq!(refused.json()["code"], json!("AUTH_REQUIRED"));
    assert_eq!(gateway.calls().len(), 4);
}

#[test]
fn share_history_forwards_the_query_subset_exactly_as_qs_left_it() {
    let gateway = Gateway::start(
        "share-history-query",
        world(json!({ "share-history": relay(200, json!({"messages": []})) })),
    );
    assert_eq!(
        gateway
            .get("/api/share/t1/history?before=10&around=m2&limit=5&orphans=1&other=x&around=n3")
            .status,
        200
    );
    let call = gateway.calls().remove(0);
    // Repeated keys keep qs's array shape and the handler's String() coercion.
    assert_eq!(
        call["query"],
        json!({"before": "10", "around": "m2,n3", "limit": "5", "orphans": "1"})
    );
    assert_eq!(call["token"], json!("t1"));
}

#[test]
fn share_auth_relays_the_set_cookie_header_and_the_cookie_is_forwarded() {
    let gateway = Gateway::start(
        "share-cookie",
        world(json!({
            "share-entry": relay(401, json!({"needPassword": true})),
            "share-auth": {
                "status": 200,
                "body": { "ok": true, "access": "view" },
                "headers": [["Set-Cookie", "multicc_share_t1=sig; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800"]],
            },
        })),
    );
    let response = gateway.send(
        "POST",
        "/api/share/t1/auth",
        &json!({"password": "share-pass"}),
    );
    assert_eq!(response.status, 200);
    assert_eq!(
        response.header("set-cookie"),
        Some("multicc_share_t1=sig; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800")
    );
    // The password cookie is the read authority: it must reach the handler.
    assert_eq!(
        gateway
            .get_with("/api/share/t1/entry", &[("Cookie", "multicc_share_t1=sig")])
            .status,
        401
    );
    let calls = gateway.calls();
    assert_eq!(calls[1]["headers"]["cookie"], json!("multicc_share_t1=sig"));
}

#[test]
fn the_share_admin_routes_keep_the_execution_slot_guard() {
    let gateway = Gateway::start(
        "share-guard",
        json!({
            "shareMachines": { "ops": { "session-shares-list": relay(200, json!({"shares": []})) } },
            "sessionAdmin": { "ops": { "guard-record": { "record": null, "internal": true, "taskStateWritable": true } } },
        }),
    );
    let response = gateway.get("/api/sessions/slot-1/shares");
    assert_eq!(response.status, 404);
    assert_eq!(response.json(), json!({"error": "session not found"}));
    // The guard ran before the handler: Node never saw the share op.
    assert!(gateway.calls().is_empty());
    // It also ran before OPTIONS, exactly like the `app.use` mount.
    let options = gateway.options("/api/sessions/slot-1/share");
    assert_eq!(options.status, 404);
    let guard = gateway.session_admin_calls();
    assert_eq!(guard[0]["op"], json!("guard-record"));
    assert_eq!(guard[0]["id"], json!("slot-1"));
}

#[test]
fn a_missing_share_page_renders_the_bare_500() {
    let gateway = Gateway::start("share-bare", world(json!({})));
    let response = gateway.get("/share/t1");
    assert_eq!(response.status, 500);
    // `res.status(500).end()`: no body, no Content-Type, no ETag.
    assert_eq!(response.body, "");
    assert_eq!(response.header("content-length"), Some("0"));
    assert_eq!(response.header("content-type"), None);
    assert_eq!(response.header("etag"), None);
    let head = gateway.head("/share/t1");
    assert_eq!(head.status, 500);
    assert_eq!(head.header("content-length"), Some("0"));
    assert_eq!(head.header("etag"), None);
    assert_eq!(head.header("content-type"), None);
    assert!(head.body.is_empty());
    assert!(gateway.calls().is_empty());
}

// ── workspaces ──────────────────────────────────────────────────────────────

#[test]
fn workspace_overview_and_sweep_keep_their_query_and_verbs() {
    let gateway = Gateway::start(
        "workspaces",
        world(json!({
            "workspaces-overview": relay(200, json!({
                "status": null, "totals": {"awake": 1, "hibernated": 0},
                "directories": [], "removedIgnoredAudit": [], "orphans": null,
            })),
            "workspaces-sweep": relay(200, json!({"ok": true, "sweep": {"hibernated": 0}, "orphans": null})),
        })),
    );
    let overview = gateway.get("/api/workspaces/overview");
    assert_eq!(overview.status, 200);
    assert_key_order(
        &overview.body,
        &[
            "status",
            "totals",
            "directories",
            "removedIgnoredAudit",
            "orphans",
        ],
    );
    let sweep = gateway.send("POST", "/api/workspaces/sweep?orphans=1", &json!({}));
    assert_eq!(sweep.status, 200);
    let calls = gateway.calls();
    assert_eq!(calls[1]["op"], json!("workspaces-sweep"));
    assert_eq!(calls[1]["query"], json!({"orphans": "1"}));
}

// ── shared framing ──────────────────────────────────────────────────────────

#[test]
fn options_states_the_measured_allow_and_the_union_is_registration_ordered() {
    let gateway = Gateway::start("options", world(json!({})));
    // The measured Express union (`allow_union_matches_the_measured_express_values`
    // in the kernel): a `:param` layer answers OPTIONS for any literal on that
    // segment, which is why `/api/machines/self` also offers PATCH and DELETE.
    let cases = [
        ("/api/machines", "GET,HEAD,POST"),
        ("/api/machines/self", "GET,HEAD,PATCH,DELETE"),
        ("/api/machines/grants", "GET,HEAD,PATCH,DELETE"),
        ("/api/machines/pair", "POST,PATCH,DELETE"),
        ("/api/machines/connection", "DELETE,PATCH"),
        ("/api/machines/grants/g1", "DELETE"),
        ("/api/machines/m1", "PATCH,DELETE"),
        ("/api/machines/m1/ws-ticket", "POST"),
        ("/api/machines/grants/ws-ticket", "DELETE,POST"),
        ("/api/sessions/s1/share", "POST"),
        ("/api/sessions/s1/shares", "GET,HEAD"),
        ("/api/sessions/s1/share/t1", "DELETE"),
        ("/api/sessions/s1/share-messages", "POST"),
        ("/api/share/t1/auth", "POST"),
        ("/api/share/t1/entry", "GET,HEAD"),
        ("/api/share/t1/history", "GET,HEAD"),
        ("/api/share/t1/session", "GET,HEAD"),
        ("/api/workspaces/overview", "GET,HEAD"),
        ("/api/workspaces/sweep", "POST"),
        ("/share/t1", "GET,HEAD"),
    ];
    for (path, allow) in cases {
        let response = gateway.options(path);
        assert_eq!(response.status, 200, "{path}: {}", response.body);
        assert_eq!(response.header("allow"), Some(allow), "{path}");
        // Express's automatic responder is `res.send(allow)`.
        assert_eq!(response.body, allow, "{path}");
    }
    // A path the front door did not claim: the proxy keeps Node's answer.
    assert_eq!(gateway.options("/api/machines/m1/proxy").body, "ok");
    assert!(
        gateway.calls().is_empty(),
        "OPTIONS reached Node: {:?}",
        gateway.calls()
    );
}

#[test]
fn the_api_json_body_is_gzipped_and_the_share_page_is_not() {
    let big = "y".repeat(4096);
    let gateway = Gateway::start(
        "gzip",
        world(json!({
            "machines-list": relay(200, json!({"machines": [], "padding": big})),
        })),
    );
    let public = gateway.dir.join("public");
    fs::create_dir(&public).unwrap();
    fs::write(public.join("chat.html"), format!("<html>{big}</html>")).unwrap();
    let api = gateway.get_with("/api/machines", &[("Accept-Encoding", "gzip")]);
    assert_eq!(api.header("content-encoding"), Some("gzip"));
    let page = gateway.get_with("/share/t1", &[("Accept-Encoding", "gzip")]);
    assert_eq!(page.header("content-encoding"), None);
    assert!(page.body.len() > 4000);
}

#[test]
fn a_conditional_read_gets_the_same_304_the_retired_handler_served() {
    let gateway = Gateway::start(
        "share-304",
        world(json!({ "machines-self": relay(200, json!({"id": "m-self"})) })),
    );
    let first = gateway.get("/api/machines/self");
    let etag = first.header("etag").unwrap().to_string();
    let second = gateway.get_with("/api/machines/self", &[("If-None-Match", &etag)]);
    assert_eq!(second.status, 304);
    assert_eq!(second.body, "");
}

#[test]
fn head_follows_get_on_the_read_routes_only() {
    let gateway = Gateway::start(
        "head",
        world(json!({
            "machines-self": relay(200, json!({"id": "m-self"})),
            "machines-list": relay(200, json!({"machines": []})),
        })),
    );
    let response = gateway.head("/api/machines/self");
    assert_eq!(response.status, 200);
    assert_eq!(response.body, "");
    assert_eq!(
        response.header("content-type"),
        Some("application/json; charset=utf-8")
    );
    // HEAD on a POST-only path is not claimed at all.
    let refused = gateway.head("/api/machines/pair");
    // The fixture's catch-all (text/plain), not a host answer (JSON).
    assert_eq!(refused.status, 200);
    assert_eq!(
        refused.header("content-type"),
        Some("text/plain"),
        "{}",
        refused.body
    );
    assert_eq!(gateway.calls().len(), 1);
}

#[test]
fn an_unreachable_host_is_the_registered_503_surface() {
    let gateway = Gateway::start(
        "host-down",
        json!({ "shareMachines": { "hostDown": true } }),
    );
    let response = gateway.get("/api/machines/self");
    assert_eq!(response.status, 503);
    assert_eq!(
        response.json(),
        json!({
            "error": "分享与电脑接口尚未就绪，请更新原生模块",
            "code": "rust_backend_unavailable",
        })
    );
    assert_eq!(
        response.header("content-type"),
        Some("application/json; charset=utf-8")
    );
}

#[test]
fn a_host_operation_that_ran_and_threw_is_the_generic_500() {
    let gateway = Gateway::start(
        "host-fail",
        json!({ "shareMachines": { "fail": ["machines-list"] } }),
    );
    let response = gateway.get("/api/machines");
    assert_eq!(response.status, 500);
    assert_eq!(response.json()["error"], json!("internal_error"));
    assert!(response.json()["requestId"].is_string());
}

#[test]
fn a_handler_that_threw_crosses_as_the_safe_error_envelope() {
    let gateway = Gateway::start(
        "threw",
        world(json!({
            "session-share-create": {
                "threw": true, "status": 500,
                "code": "internal_error", "message": "internal_error",
            }
        })),
    );
    let response = gateway.send("POST", "/api/sessions/s1/share", &json!({}));
    assert_eq!(response.status, 500);
    let body = response.json();
    assert_eq!(body["error"], json!("internal_error"));
    // The request id is the front door's own, not a value from Node.
    assert_eq!(
        body["requestId"].as_str().unwrap(),
        response.header("x-multicc-request-id").unwrap()
    );
    assert!(body["correlationId"].is_string());
}

#[test]
fn unclaimed_sessions_and_share_like_paths_are_forwarded_untouched() {
    let gateway = Gateway::start("unclaimed", world(json!({})));
    for path in [
        "/api/sessions/s1/share/extra/segment",
        "/api/sessions/s1/share/t1/extra",
        "/api/share",
        "/api/share/t1",
        "/share",
        "/share/t1/extra",
        "/api/workspaces",
        "/api/workspaces/overview/x",
    ] {
        assert_eq!(gateway.get(path).body, "ok", "{path}");
    }
    assert!(gateway.calls().is_empty());
}
