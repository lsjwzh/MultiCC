#![recursion_limit = "256"]

//! Integration coverage for the 32 account / credential routes retired from
//! `src/routes/{claude-accounts,codex-accounts,zcode-auth,cli-key-accounts,
//! kimi-auth,claude-oauth,codex-oauth,commandcode-auth}.js`, answered by the
//! Rust front door (`native/gateway/src/app/account_routes.rs`).
//!
//! The Node process here is only the protocol fixture: it answers
//! `POST /api/__host/account-routes` with `{ ok: true, value }` from
//! `FIXTURE_HOST_SCRIPT.accountRoutes.ops` and appends every payload to
//! `account-routes-calls.jsonl`, so the tests can assert what the front door
//! asked the runtime to do, and in which order.
//!
//! Two routes stay in Node (`POST /api/{zcode,kimi}/auth/login`) and are
//! asserted to forward straight to the child, never touching the host.

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

fn unique(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "multicc-gateway-account-routes-{}-{tag}-{nanos}",
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

    /// Every payload the front door sent the account-routes host port.
    fn calls(&self) -> Vec<Value> {
        fs::read_to_string(self.state.join("account-routes-calls.jsonl"))
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
        extra: &[(&str, &str)],
        body: Option<&str>,
    ) -> Response {
        let payload = body.unwrap_or("");
        let mut request =
            format!("{method} {url} HTTP/1.1\r\nHost: localhost\r\nX-Request-Id: acct-req-1\r\n");
        for (name, value) in extra {
            request.push_str(&format!("{name}: {value}\r\n"));
        }
        if body.is_some() {
            request.push_str("Content-Type: application/json\r\n");
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
        self.exchange("GET", url, &[], None)
    }
    fn head(&self, url: &str) -> Response {
        self.exchange("HEAD", url, &[], None)
    }
    fn options(&self, url: &str) -> Response {
        self.exchange("OPTIONS", url, &[], None)
    }
    fn send(&self, method: &str, url: &str, body: &Value) -> Response {
        self.exchange(method, url, &[], Some(&body.to_string()))
    }
    fn send_with(&self, method: &str, url: &str, body: &Value, extra: &[(&str, &str)]) -> Response {
        self.exchange(method, url, extra, Some(&body.to_string()))
    }
    fn post(&self, url: &str, body: &Value) -> Response {
        self.send("POST", url, body)
    }
    fn delete(&self, url: &str) -> Response {
        self.exchange("DELETE", url, &[], None)
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
    json!({ "accountRoutes": { "ops": ops } })
}

/// Assert no credential carrying key appears in a public response body.
fn assert_no_credentials(body: &str) {
    let lower = body.to_ascii_lowercase();
    for needle in [
        "access_token",
        "refresh_token",
        "refresh-token",
        "api_key",
        "api-key",
        "apikey",
        "password",
        "cookie",
        "\"token\"",
        "\"secret\"",
    ] {
        assert!(!lower.contains(needle), "response leaked {needle}: {body}");
    }
}

// ── claude accounts ─────────────────────────────────────────────────────────

#[test]
fn claude_accounts_list_relays_the_projection_byte_for_byte() {
    let gateway = Gateway::start(
        "claude-list",
        world(json!({
            "claude-accounts-list": relay(200, json!({
                "ok": true,
                "activeAccountId": "global",
                "cliLogin": null,
                "accounts": [
                    { "id": "global", "label": "本机 CLI 登录账号", "global": true, "active": true },
                    { "id": "a1", "label": "Work", "loggedIn": true,
                      "email": "u@example.test", "expiresAt": 1893513600000i64,
                      "expired": false, "hasRefreshToken": true, "active": false,
                      "subscription": "max", "organizationName": null,
                      "accountExternalId": "ext-1",
                      "credential": { "refreshCount": 0, "lastError": null,
                        "lastRefreshAt": null, "blockedUntil": null, "renewedBy": "cli" } }
                ],
            }))
        })),
    );
    let response = gateway.get("/api/claude/accounts");
    assert_eq!(response.status, 200, "{}", gateway.log());
    assert_key_order(
        &response.body,
        &["ok", "activeAccountId", "cliLogin", "accounts"],
    );
    assert_key_order(
        &response.body,
        &[
            "refreshCount",
            "lastError",
            "lastRefreshAt",
            "blockedUntil",
            "renewedBy",
        ],
    );
    assert_eq!(
        gateway.calls(),
        vec![json!({"op": "claude-accounts-list", "method": "GET", "body": {}})]
    );
}

#[test]
fn claude_account_list_and_status_carry_no_credentials() {
    // The Node host already projects credential-free DTOs; this locks the front
    // door to relaying them verbatim — it must not re-introduce anything from
    // the request (cookie, bearer, query) into the body.
    let gateway = Gateway::start(
        "sanitize",
        world(json!({
            "claude-accounts-list": relay(200, json!({
                "ok": true, "activeAccountId": null, "cliLogin": null,
                "accounts": [{ "id": "a1", "loggedIn": true, "email": "u@example.test",
                  "expiresAt": 1893513600000i64, "expired": false, "hasRefreshToken": true,
                  "credential": { "refreshCount": 0, "lastError": null,
                    "lastRefreshAt": null, "blockedUntil": null, "renewedBy": "cli" } }],
            })),
        })),
    );
    let response = gateway.send_with(
        "GET",
        "/api/claude/accounts?token=CANARY-QUERY&api_key=CANARY-KEY",
        &json!({}),
        &[
            ("Cookie", "session=CANARY-COOKIE"),
            ("Authorization", "Bearer CANARY-BEARER"),
        ],
    );
    assert_eq!(response.status, 200, "{}", gateway.log());
    assert_no_credentials(&response.body);
    assert!(!response.body.contains("CANARY"), "{}", response.body);
    // …and none of those values crossed to the host port either.
    let logged =
        fs::read_to_string(gateway.state.join("account-routes-calls.jsonl")).unwrap_or_default();
    assert!(!logged.contains("CANARY"), "{logged}");
}

#[test]
fn claude_activate_relays_the_unified_refusal() {
    let gateway = Gateway::start(
        "claude-activate",
        world(json!({
            "claude-account-activate": relay(409, json!({"ok": false, "error": "统一官方账号未启用"}))
        })),
    );
    let response = gateway.post("/api/claude/accounts/a1/activate", &json!({}));
    assert_eq!(response.status, 409);
    assert_eq!(
        response.json(),
        json!({"ok": false, "error": "统一官方账号未启用"})
    );
    assert_eq!(gateway.calls()[0]["op"], json!("claude-account-activate"));
    assert_eq!(gateway.calls()[0]["id"], json!("a1"));
}

#[test]
fn claude_create_forwards_the_body_verbatim_and_relays_201() {
    let gateway = Gateway::start(
        "claude-create",
        world(json!({
            "claude-accounts-create": relay(201, json!({
                "ok": true, "accountId": "a2", "providerId": "claude-official-a2",
                "oauthUrl": "https://claude.ai/oauth/authorize?x=1", "reused": false,
            }))
        })),
    );
    let body = json!({"label": "Work", "egressBinding": {"pluginId": "p", "profileId": "q"}});
    let response = gateway.post("/api/claude/accounts", &body);
    assert_eq!(response.status, 201);
    assert_key_order(
        &response.body,
        &["ok", "accountId", "providerId", "oauthUrl", "reused"],
    );
    assert_eq!(gateway.calls()[0]["body"], body);
}

#[test]
fn claude_login_status_and_callback_relay_their_refusals() {
    let gateway = Gateway::start(
        "claude-login",
        world(json!({
            "claude-account-login-status": relay(404, json!({"ok": false, "error": "account not found"})),
            "claude-account-login-callback": relay(400, json!({"ok": false, "error": "请粘贴浏览器地址栏里的完整链接，或授权码 code#state"})),
        })),
    );
    assert_eq!(
        gateway.get("/api/claude/accounts/a1/login-status").status,
        404
    );
    let callback = gateway.post(
        "/api/claude/accounts/a1/login-callback",
        &json!({"callback": "x"}),
    );
    assert_eq!(callback.status, 400);
    let calls = gateway.calls();
    assert_eq!(calls[1]["op"], json!("claude-account-login-callback"));
    assert_eq!(calls[1]["body"], json!({"callback": "x"}));
}

#[test]
fn claude_relogin_delete_and_quota_keep_their_contracts() {
    let gateway = Gateway::start(
        "claude-quota",
        world(json!({
            "claude-account-relogin": relay(200, json!({"ok": true, "accountId": "a1", "oauthUrl": "https://x", "reused": true})),
            "claude-account-delete": relay(200, json!({"ok": true, "deletedProviderId": "claude-official-a1"})),
            "claude-account-quota": relay(200, json!({"status": "ok", "fetchedAt": 1, "usage": {"windows": []}})),
        })),
    );
    assert_eq!(
        gateway
            .post("/api/claude/accounts/a1/relogin", &json!({}))
            .status,
        200
    );
    assert_eq!(gateway.delete("/api/claude/accounts/a1").status, 200);
    let quota = gateway.get("/api/claude/accounts/a1/quota");
    assert_eq!(quota.status, 200);
    assert_key_order(&quota.body, &["status", "fetchedAt", "usage"]);
    assert_no_credentials(&quota.body);
}

#[test]
fn claude_quota_relays_the_no_auth_branches() {
    let unavailable = Gateway::start(
        "claude-quota-503",
        world(json!({
            "claude-account-quota": relay(503, json!({"status": "no_auth", "error": "账号凭证不可用：keychain_locked"}))
        })),
    );
    assert_eq!(unavailable.get("/api/claude/accounts/a1/quota").status, 503);
    let gate = Gateway::start(
        "claude-quota-401",
        world(json!({
            "claude-account-quota": relay(401, json!({"status": "no_auth", "error": "账号凭证已失效，请重新登录"}))
        })),
    );
    assert_eq!(gate.get("/api/claude/accounts/a1/quota").status, 401);
}

#[test]
fn percent_encoded_ids_are_decoded_before_the_host_call() {
    let gateway = Gateway::start(
        "claude-decode",
        world(
            json!({"claude-account-delete": relay(200, json!({"ok": true, "deletedProviderId": null}))}),
        ),
    );
    assert_eq!(gateway.delete("/api/claude/accounts/a%2Fb%20c").status, 200);
    assert_eq!(gateway.calls()[0]["id"], json!("a/b c"));
}

// ── codex accounts ──────────────────────────────────────────────────────────

#[test]
fn codex_accounts_cover_the_seven_routes() {
    let gateway = Gateway::start(
        "codex-accounts",
        world(json!({
            "codex-accounts-list": relay(200, json!({"ok": true, "activeAccountId": "global", "cliLogin": null, "accounts": []})),
            "codex-accounts-create": relay(201, json!({"ok": true, "accountId": "c1", "providerId": null, "oauthUrl": "https://x", "reused": false})),
            "codex-account-activate": relay(200, json!({"ok": true, "activeAccountId": "c1", "provider": "codex-official-c1"})),
            "codex-account-login-status": relay(200, json!({"ok": true, "accountId": "c1", "state": "pending"})),
            "codex-account-login-callback": relay(409, json!({"ok": false, "error": "没有等待中的登录，请先点「重新登录」"})),
            "codex-account-relogin": relay(502, json!({"ok": false, "error": "login unavailable"})),
            "codex-account-delete": relay(409, json!({"ok": false, "error": "“同 Codex 终端”为内置线路，不能删除"})),
        })),
    );
    assert_eq!(gateway.get("/api/codex/accounts").status, 200);
    assert_eq!(gateway.post("/api/codex/accounts", &json!({})).status, 201);
    assert_eq!(
        gateway
            .post("/api/codex/accounts/c1/activate", &json!({}))
            .status,
        200
    );
    assert_eq!(
        gateway.get("/api/codex/accounts/c1/login-status").status,
        200
    );
    assert_eq!(
        gateway
            .post(
                "/api/codex/accounts/c1/login-callback",
                &json!({"code": "x"})
            )
            .status,
        409
    );
    assert_eq!(
        gateway
            .post("/api/codex/accounts/c1/relogin", &json!({}))
            .status,
        502
    );
    assert_eq!(gateway.delete("/api/codex/accounts/global").status, 409);
    let ops: Vec<Value> = gateway.calls().iter().map(|c| c["op"].clone()).collect();
    assert_eq!(
        ops,
        vec![
            json!("codex-accounts-list"),
            json!("codex-accounts-create"),
            json!("codex-account-activate"),
            json!("codex-account-login-status"),
            json!("codex-account-login-callback"),
            json!("codex-account-relogin"),
            json!("codex-account-delete"),
        ]
    );
}

// ── zcode / kimi auth ───────────────────────────────────────────────────────

#[test]
fn zcode_status_relays_login_available_and_desktop_providers() {
    let gateway = Gateway::start(
        "zcode-status",
        world(json!({
            "zcode-auth-status": relay(200, json!({
                "configured": true, "provider": "zai", "hasKey": true, "source": "cli_config",
                "kind": "anthropic", "model": "glm-4.6",
                "loginAvailable": true, "desktopProviders": [{"id": "zai", "hasKey": true}],
            }))
        })),
    );
    let response = gateway.get("/api/zcode/auth");
    assert_eq!(response.status, 200, "{}", gateway.log());
    assert_key_order(
        &response.body,
        &[
            "configured",
            "provider",
            "hasKey",
            "source",
            "kind",
            "model",
            "loginAvailable",
            "desktopProviders",
        ],
    );
    assert_no_credentials(&response.body);
}

#[test]
fn zcode_sync_put_and_check_keep_their_branches() {
    let gateway = Gateway::start(
        "zcode-sync",
        world(json!({
            "zcode-auth-sync": relay(400, json!({"ok": false, "code": "no_desktop_key", "message": "未在 ZCode 桌面端配置中检测到 API Key。请先在桌面端设置 API Key，或手动填写。"})),
            "zcode-auth-put": relay(400, json!({"error": "providerId and apiKey are required"})),
            "zcode-auth-check": relay(200, json!({"ok": true, "provider": "zai", "source": "cli_config"})),
        })),
    );
    assert_eq!(gateway.post("/api/zcode/auth/sync", &json!({})).status, 400);
    let put = gateway.send(
        "PUT",
        "/api/zcode/auth",
        &json!({"providerId": "zai", "apiKey": "sk-CANARY"}),
    );
    assert!(!put.body.contains("sk-CANARY"), "{}", put.body);
    assert_eq!(put.status, 400);
    let check = gateway.get("/api/zcode/auth/check");
    assert_key_order(&check.body, &["ok", "provider", "source"]);
    // The front door forwarded the PUT body verbatim (the Node handler decides
    // what to do with the key; it never leaves Node in a response).
    assert_eq!(gateway.calls()[1]["body"]["apiKey"], json!("sk-CANARY"));
}

#[test]
fn kimi_auth_covers_status_put_and_check() {
    let gateway = Gateway::start(
        "kimi-auth",
        world(json!({
            "kimi-auth-status": relay(200, json!({"ok": true, "configured": false, "hasKey": false, "source": "none", "loginAvailable": true})),
            "kimi-auth-put": relay(400, json!({"error": "apiKey is required"})),
            "kimi-auth-check": relay(200, json!({"ok": false, "code": "configuration_required", "message": "未配置", "loginAvailable": true})),
        })),
    );
    assert_eq!(gateway.get("/api/kimi/auth").status, 200);
    assert_eq!(
        gateway
            .send("PUT", "/api/kimi/auth", &json!({"apiKey": "k-CANARY"}))
            .status,
        400
    );
    let check = gateway.get("/api/kimi/auth/check");
    assert_eq!(check.status, 200, "{}", gateway.log());
    assert_key_order(&check.body, &["ok", "code", "message", "loginAvailable"]);
    assert_no_credentials(&check.body);
}

#[test]
fn kimi_check_omits_a_missing_message_like_json_stringify() {
    let gateway = Gateway::start(
        "kimi-check-nomsg",
        world(
            json!({"kimi-auth-check": relay(200, json!({"ok": false, "code": "configuration_required", "loginAvailable": false}))}),
        ),
    );
    let response = gateway.get("/api/kimi/auth/check");
    assert_eq!(response.status, 200);
    assert!(!response.body.contains("\"message\""), "{}", response.body);
}

#[test]
fn the_two_login_routes_are_forwarded_to_the_child() {
    let gateway = Gateway::start("forwarded-login", world(json!({})));
    // No host op exists for these; the request reaches the child fixture, whose
    // catch-all answers `200 ok` (an unscripted path in this fixture).
    let zcode = gateway.post("/api/zcode/auth/login", &json!({}));
    let kimi = gateway.post("/api/kimi/auth/login", &json!({}));
    assert_eq!(zcode.status, 200, "{}", gateway.log());
    assert_eq!(zcode.body, "ok");
    assert_eq!(kimi.status, 200);
    assert_eq!(kimi.body, "ok");
    assert!(gateway.calls().is_empty(), "the host port was never asked");
}

// ── cli key accounts ────────────────────────────────────────────────────────

#[test]
fn cli_accounts_cover_all_four_routes_and_the_lane_param() {
    let gateway = Gateway::start(
        "cli-accounts",
        world(json!({
            "cli-accounts-list": relay(200, json!({"ok": true, "cli": "claude", "accounts": []})),
            "cli-accounts-create": relay(201, json!({"ok": true, "account": {"id": "k1", "label": "A"}})),
            "cli-account-patch": relay(404, json!({"ok": false, "error": "账户不存在"})),
            "cli-account-delete": relay(200, json!({"ok": true, "releasedSessions": []})),
        })),
    );
    assert_eq!(gateway.get("/api/cli-accounts/claude").status, 200);
    assert_eq!(
        gateway
            .post(
                "/api/cli-accounts/claude",
                &json!({"label": "A", "apiKey": "sk-CANARY"})
            )
            .status,
        201
    );
    assert_eq!(
        gateway
            .send(
                "PATCH",
                "/api/cli-accounts/claude/k1",
                &json!({"label": "B"})
            )
            .status,
        404
    );
    assert_eq!(gateway.delete("/api/cli-accounts/claude/k1").status, 200);
    let calls = gateway.calls();
    assert_eq!(calls[0]["cli"], json!("claude"));
    assert_eq!(calls[2]["cli"], json!("claude"));
    assert_eq!(calls[2]["id"], json!("k1"));
    assert_eq!(calls[2]["body"], json!({"label": "B"}));
}

// ── oauth + commandcode ─────────────────────────────────────────────────────

#[test]
fn claude_oauth_status_and_login_keep_their_key_order() {
    let gateway = Gateway::start(
        "claude-oauth",
        world(json!({
            "claude-oauth-status": relay(200, json!({
                "ok": true, "enabled": true, "needsLogin": false, "lastOutcome": "ok",
                "consecutiveFailures": 0, "loginSessionId": null, "loginCommand": null,
            })),
            "claude-oauth-login": relay(500, json!({"ok": false, "error": "no directory available"})),
        })),
    );
    let status = gateway.get("/api/claude/oauth/status");
    assert_key_order(
        &status.body,
        &[
            "ok",
            "enabled",
            "needsLogin",
            "lastOutcome",
            "consecutiveFailures",
            "loginSessionId",
            "loginCommand",
        ],
    );
    assert_eq!(
        gateway.post("/api/claude/oauth/login", &json!({})).status,
        500
    );
}

#[test]
fn codex_oauth_status_and_login_keep_their_key_order() {
    let gateway = Gateway::start(
        "codex-oauth",
        world(json!({
            "codex-oauth-status": relay(200, json!({
                "ok": true, "enabled": false, "needsLogin": true, "needsLoginSince": 1,
                "lastOutcome": "needs-login", "consecutiveFailures": 2, "retryAfter": null,
                "loginCommand": "codex login",
            })),
            "codex-oauth-login": relay(200, json!({"ok": true, "sessionId": "codex-login", "reused": false, "hint": "h"})),
        })),
    );
    let status = gateway.get("/api/codex/oauth/status");
    assert_key_order(
        &status.body,
        &[
            "ok",
            "enabled",
            "needsLogin",
            "needsLoginSince",
            "lastOutcome",
            "consecutiveFailures",
            "retryAfter",
            "loginCommand",
        ],
    );
    assert_eq!(
        gateway.post("/api/codex/oauth/login", &json!({})).status,
        200
    );
}

#[test]
fn commandcode_status_and_login_keep_their_contracts() {
    let gateway = Gateway::start(
        "commandcode",
        world(json!({
            "commandcode-auth-status": relay(200, json!({
                "ok": true, "credentialSaved": true, "userName": "u", "environmentKey": "prod"
            })),
            "commandcode-auth-login": relay(409, json!({"ok": false, "error": "请先添加一个项目目录，再打开登录终端。"})),
        })),
    );
    let status = gateway.get("/api/commandcode/auth/status");
    assert_key_order(
        &status.body,
        &["ok", "credentialSaved", "userName", "environmentKey"],
    );
    assert_no_credentials(&status.body);
    assert_eq!(
        gateway
            .post("/api/commandcode/auth/login", &json!({}))
            .status,
        409
    );
}

// ── OPTIONS + failure surface ───────────────────────────────────────────────

#[test]
fn options_unions_match_express() {
    let gateway = Gateway::start("options", world(json!({})));
    let table = [
        ("/api/claude/accounts", "GET,HEAD,POST"),
        ("/api/claude/accounts/a1/activate", "POST"),
        ("/api/claude/accounts/a1/login-status", "GET,HEAD"),
        ("/api/claude/accounts/a1/quota", "GET,HEAD"),
        ("/api/claude/accounts/a1", "DELETE"),
        ("/api/codex/accounts", "GET,HEAD,POST"),
        ("/api/codex/accounts/c1/login-status", "GET,HEAD"),
        ("/api/zcode/auth", "GET,HEAD,PUT"),
        ("/api/zcode/auth/sync", "POST"),
        ("/api/zcode/auth/check", "GET,HEAD"),
        ("/api/kimi/auth", "GET,HEAD,PUT"),
        ("/api/kimi/auth/check", "GET,HEAD"),
        ("/api/cli-accounts/claude", "GET,HEAD,POST"),
        ("/api/cli-accounts/claude/k1", "PATCH,DELETE"),
        ("/api/claude/oauth/status", "GET,HEAD"),
        ("/api/claude/oauth/login", "POST"),
        ("/api/commandcode/auth/status", "GET,HEAD"),
        ("/api/commandcode/auth/login", "POST"),
    ];
    for (path, allow) in table {
        let response = gateway.options(path);
        assert_eq!(response.status, 200, "{path}: {}", gateway.log());
        assert_eq!(response.header("allow"), Some(allow), "{path}");
        assert_eq!(response.body, allow, "{path} body");
    }
    assert!(gateway.calls().is_empty(), "OPTIONS never reaches the host");
}

#[test]
fn head_answers_like_get_without_a_body() {
    let gateway = Gateway::start(
        "head",
        world(
            json!({"claude-accounts-list": relay(200, json!({"ok": true, "activeAccountId": null, "cliLogin": null, "accounts": []}))}),
        ),
    );
    let response = gateway.head("/api/claude/accounts");
    assert_eq!(response.status, 200, "{}", gateway.log());
    assert!(response.body.is_empty(), "{:?}", response.body);
    assert_eq!(gateway.calls()[0]["op"], json!("claude-accounts-list"));
}

#[test]
fn host_unreachable_is_a_503() {
    let gateway = Gateway::start("host-down", json!({"accountRoutes": {"hostDown": true}}));
    let response = gateway.get("/api/claude/accounts");
    assert_eq!(response.status, 503, "body {:?}", response.body);
    assert_eq!(response.json()["code"], json!("rust_backend_unavailable"));
}

#[test]
fn a_host_500_becomes_the_generic_internal_error() {
    let gateway = Gateway::start(
        "host-500",
        json!({"accountRoutes": {"ops": {}, "fail": ["claude-accounts-list"]}}),
    );
    let response = gateway.get("/api/claude/accounts");
    assert_eq!(response.status, 500, "body {:?}", response.body);
    assert_eq!(response.json()["error"], json!("internal_error"));
}

#[test]
fn a_thrown_handler_relays_the_safe_error_envelope() {
    let gateway = Gateway::start(
        "thrown",
        world(json!({
            "claude-account-activate": {
                "threw": true, "status": 400, "code": "request_error", "message": "request_error"
            }
        })),
    );
    let response = gateway.post("/api/claude/accounts/a1/activate", &json!({}));
    assert_eq!(response.status, 400, "{:?}", response.body);
    let body = response.json();
    assert_eq!(body["error"], json!("request_error"));
    assert!(!body["correlationId"].is_null());
}

#[test]
fn unknown_methods_on_a_claimed_path_are_forwarded_not_invented() {
    let gateway = Gateway::start("wrong-method", world(json!({})));
    // `DELETE /api/claude/accounts` is not a retired route; the front door
    // forwards it to the child (the fixture catch-all answers `200 ok`).
    let response = gateway.delete("/api/claude/accounts");
    assert_eq!(response.status, 200, "{}", gateway.log());
    assert_eq!(response.body, "ok");
    assert!(gateway.calls().is_empty());
}
