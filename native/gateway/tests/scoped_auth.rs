//! Scoped authorization at the front door
//! (`native/gateway/src/app/scoped_auth.rs`, `multicc_core::http_gate`,
//! `multicc_core::workspace_sharing`).
//!
//! Node's gate calls `authorizeScopedRequest` for every claimed, non-public,
//! non-relay request: `machines.authorize(req) || fleetSharingRuntime?
//! .authorizeRequest({ token, grant, method, pathname }) === true`
//! (`server.js`, `native/addon/src/http_entry.rs`). The front door must keep
//! both halves working on the routes it answers itself, in that order, and must
//! never widen them: a share grant opens exactly the plan the store records for
//! that token, no other workspace and no other route.
//!
//! The Node child here is only the protocol fixture. It answers the share
//! store question (`Authorize`) from `FIXTURE_HOST_SCRIPT.fleet`, appends every
//! scope request to `source-authorize.jsonl`, and answers the routes' own host
//! ports from their existing script sections.

use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value};

const GATEWAY_BIN: &str = env!("CARGO_BIN_EXE_multicc-gateway");
const FIXTURE_JS: &str = include_str!("fixtures/upstream.js");
const TOKEN: &str = "secret-token-1";
/// The peer every share-scoped request in these tests claims to come from. The
/// decision must not depend on it beyond the existing lan-only allowlist.
const EXTERNAL_IP: &str = "203.0.113.9";
const PRESETS: &str = "/api/agent-presets";

fn unique(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "multicc-gateway-scoped-auth-{}-{tag}-{nanos}",
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
    fn assert_auth_required(&self, what: &str) {
        assert_eq!(self.status, 403, "{what}: body {:?}", self.body);
        assert_eq!(self.json()["code"], json!("AUTH_REQUIRED"), "{what}");
    }
}

struct Gateway {
    dir: PathBuf,
    state: PathBuf,
    script: PathBuf,
    port: u16,
    child: Child,
}

impl Gateway {
    fn start(tag: &str, script: Value) -> Self {
        Self::start_with(tag, script, None)
    }

    /// `machines`: an optional `machines.json` registry written into the data
    /// root before the gateway starts, which is how a machine grant is
    /// provisioned in production (`multicc_core::machines::store`).
    fn start_with(tag: &str, script: Value, machines: Option<Value>) -> Self {
        let mut last_log = String::new();
        for attempt in 0..6 {
            match Self::start_once(&format!("{tag}-{attempt}"), &script, machines.as_ref()) {
                Ok(gateway) => {
                    gateway.wait_for_source();
                    fs::write(gateway.state.join("start-count"), attempt.to_string()).unwrap();
                    return gateway;
                }
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

    fn start_once(
        tag: &str,
        script: &Value,
        machines: Option<&Value>,
    ) -> Result<Self, (String, bool)> {
        let dir = unique(tag);
        let data = dir.join("data");
        let home = dir.join("home");
        let state = dir.join("state");
        for path in [&dir, &data, &home, &state] {
            fs::create_dir_all(path).unwrap();
        }
        if let Some(registry) = machines {
            fs::write(data.join("machines.json"), registry.to_string()).unwrap();
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
            script: script_path,
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

    /// The share store is only reachable once the fixture has finished the
    /// capability handshake on the source control channel. Waiting here keeps
    /// the assertions about "no round trip" honest.
    fn wait_for_source(&self) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !self.state.join("source-ready").exists() {
            assert!(
                Instant::now() < deadline,
                "share store never registered\n{}",
                self.log()
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn log(&self) -> String {
        fs::read_to_string(self.dir.join("gateway.log")).unwrap_or_default()
    }

    /// Rewrite the fixture's script in place. The fixture re-reads it per
    /// request, so a single gateway can walk through several store states;
    /// rename keeps a request from observing a half-written file.
    fn write_script(&self, script: &Value) {
        let temporary = self.script.with_extension("json.tmp");
        fs::write(&temporary, script.to_string()).unwrap();
        fs::rename(&temporary, &self.script).unwrap();
    }

    fn lines(&self, name: &str) -> Vec<Value> {
        fs::read_to_string(self.state.join(name))
            .unwrap_or_default()
            .lines()
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    /// Every scope question the front door asked the share store, in order.
    fn authorizations(&self) -> Vec<Value> {
        self.lines("source-authorize.jsonl")
    }

    fn agent_calls(&self) -> Vec<Value> {
        self.lines("agent-calls.jsonl")
    }

    fn session_admin_calls(&self) -> Vec<Value> {
        self.lines("session-admin-calls.jsonl")
    }

    fn get_with(&self, url: &str, extra: &[(&str, &str)]) -> Response {
        self.exchange("GET", url, None, extra)
    }

    fn exchange(
        &self,
        method: &str,
        url: &str,
        body: Option<&str>,
        extra: &[(&str, &str)],
    ) -> Response {
        let mut host = "localhost";
        let mut request_id = "scoped-req-1";
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
        let payload = body.unwrap_or("");
        let mut request = format!(
            "{method} {url} HTTP/1.1\r\nHost: {host}\r\nX-Request-Id: {request_id}\r\n{lines}"
        );
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
}

impl Drop for Gateway {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.dir);
    }
}

/// The headers `tests/test-auth-locality-isolated.js` sends: an external peer
/// on the wire, a dashboard host, and the share pair.
fn fleet_headers<'a>(token: &'a str, grant: &'a str) -> Vec<(&'static str, &'a str)> {
    vec![
        ("Host", "dashboard.example.test"),
        ("X-Forwarded-For", EXTERNAL_IP),
        ("X-Multicc-Fleet-Token", token),
        ("X-Multicc-Fleet-Grant", grant),
    ]
}

/// A script whose share store answers exactly the listed path decisions and
/// refuses everything else, like the migrated `authority::plan` does for a
/// real share.
fn share_script(paths: &[(&str, bool)]) -> Value {
    let mut answers = Map::new();
    for (path, allow) in paths {
        answers.insert((*path).to_string(), Value::Bool(*allow));
    }
    json!({
        "agent": { "data": { "ok": true, "presets": [] } },
        "fleet": { "authorize": Value::Object(answers) },
    })
}

#[test]
fn a_fleet_scope_opens_a_claimed_route_and_records_the_request() {
    let gateway = Gateway::start("fleet-allow", share_script(&[(PRESETS, true)]));
    let response = gateway.get_with(PRESETS, &fleet_headers("fleet_share_token", "grant"));
    assert_eq!(
        response.status,
        200,
        "body {:?}\n{}",
        response.body,
        gateway.log()
    );
    assert_eq!(response.json()["presets"], json!([]));
    // The route ran to completion, not just past the gate.
    assert_eq!(gateway.agent_calls()[0]["op"], json!("presets"));
    // The decision was asked of the share store with the original request
    // line — the exact input Node's `authorizeRequest` receives.
    assert_eq!(
        gateway.authorizations(),
        vec![json!({
            "token": "fleet_share_token",
            "grant": "grant",
            "method": "GET",
            "pathname": PRESETS,
        })],
        "{}",
        gateway.log()
    );
    // A share grants access, never an identity: the response is a plain 200
    // without a login redirect or a session cookie.
    assert_eq!(response.header("set-cookie"), None);
}

#[test]
fn a_share_scope_never_widens_the_routes_the_store_allows() {
    // The store allows the presets read; a different claimed route on the very
    // same credentials must still be refused by the ordinary gate.
    let gateway = Gateway::start("fleet-narrow", share_script(&[(PRESETS, true)]));
    let refusal = gateway.get_with(
        "/api/server-info",
        &fleet_headers("fleet_share_token", "grant"),
    );
    refusal.assert_auth_required("unshared route");
    // The scope is per request, not per connection: the allowed one still works.
    assert_eq!(
        gateway
            .get_with(PRESETS, &fleet_headers("fleet_share_token", "grant"))
            .status,
        200
    );
    // Both requests were judged by the store; only the plan decided.
    let asked: Vec<Value> = gateway
        .authorizations()
        .into_iter()
        .map(|input| input["pathname"].clone())
        .collect();
    assert_eq!(asked, vec![json!("/api/server-info"), json!(PRESETS)]);
}

#[test]
fn an_incomplete_scope_credential_never_reaches_the_share_store() {
    let gateway = Gateway::start("fleet-partial", share_script(&[(PRESETS, true)]));
    let incomplete = [
        vec![("X-Multicc-Fleet-Token", "fleet_share_token")],
        vec![("X-Multicc-Fleet-Grant", "grant")],
        vec![
            ("X-Multicc-Fleet-Token", ""),
            ("X-Multicc-Fleet-Grant", "grant"),
        ],
        vec![
            ("X-Multicc-Fleet-Token", "fleet_share_token"),
            ("X-Multicc-Fleet-Grant", ""),
        ],
    ];
    for extra in incomplete {
        let mut headers = vec![("Host", "dashboard.example.test")];
        headers.extend(extra.iter().copied());
        let response = gateway.get_with(PRESETS, &headers);
        response.assert_auth_required(&format!("{extra:?}"));
    }
    // Node passes `undefined` into `authorizeRequest` here, which fails on the
    // missing half before any policy runs; there is nothing to ask the store.
    assert!(gateway.authorizations().is_empty());
}

#[test]
fn a_share_store_failure_leaves_only_the_ordinary_credential() {
    let mut script = share_script(&[(PRESETS, true)]);
    script["fleet"]["mode"] = json!("error");
    let gateway = Gateway::start("fleet-error", script);
    // No grant, no 500 and no crash: the ordinary refusal.
    gateway
        .get_with(PRESETS, &fleet_headers("fleet_share_token", "grant"))
        .assert_auth_required("store error");
    // `||` semantics: a failed scope is not an assertion. The access token
    // still admits the same request, exactly as in the Node gate.
    let mut headers = fleet_headers("fleet_share_token", "grant");
    headers.push(("X-Access-Token", TOKEN));
    assert_eq!(
        gateway.get_with(PRESETS, &headers).status,
        200,
        "{}",
        gateway.log()
    );

    // A destroyed control stream is the same answer, and the next request
    // recovers on the reconnect.
    let mut destroyed = share_script(&[(PRESETS, true)]);
    destroyed["fleet"]["mode"] = json!("destroy");
    gateway.write_script(&destroyed);
    gateway
        .get_with(PRESETS, &fleet_headers("fleet_share_token", "grant"))
        .assert_auth_required("store destroyed");
    let mut restored = share_script(&[(PRESETS, true)]);
    restored["fleet"]["mode"] = json!("none");
    gateway.write_script(&restored);
    assert_eq!(
        gateway
            .get_with(PRESETS, &fleet_headers("fleet_share_token", "grant"))
            .status,
        200,
        "{}",
        gateway.log()
    );
}

#[test]
fn only_the_shared_directory_is_open_to_a_share_grant() {
    // The acceptance case from `tests/test-auth-locality-isolated.js`: the
    // session-admin cluster answers `/api/directories/:id/sessions` itself, and
    // the share grant must carry the same workspace fence the Node gate had.
    let script = json!({
        "sessionAdmin": { "ops": {
            "directory:shared-workspace": { "id": "shared-workspace", "name": "shared" },
        }},
        "fleet": { "authorize": {
            "/api/directories/shared-workspace/sessions": true,
            "/api/directories/other-workspace/sessions": false,
        }},
    });
    let gateway = Gateway::start("fleet-directory", script);
    let allowed = gateway.get_with(
        "/api/directories/shared-workspace/sessions",
        &fleet_headers("fleet_share_token", "grant"),
    );
    assert_eq!(
        allowed.status,
        200,
        "body {:?}\n{}",
        allowed.body,
        gateway.log()
    );
    assert_eq!(allowed.json()["directory"]["id"], json!("shared-workspace"));

    let denied = gateway.get_with(
        "/api/directories/other-workspace/sessions",
        &fleet_headers("fleet_share_token", "grant"),
    );
    denied.assert_auth_required("other workspace");

    // The route only ran for the workspace the token was published for.
    let directory_reads = gateway
        .session_admin_calls()
        .into_iter()
        .filter(|call| call["op"] == json!("directory"))
        .count();
    assert_eq!(directory_reads, 1, "{:?}", gateway.session_admin_calls());
    let asked: Vec<Value> = gateway
        .authorizations()
        .into_iter()
        .map(|input| input["pathname"].clone())
        .collect();
    assert_eq!(
        asked,
        vec![
            json!("/api/directories/shared-workspace/sessions"),
            json!("/api/directories/other-workspace/sessions"),
        ]
    );
}

/// `machines.json` written by a pairing (`multicc_core::machines::store`). The
/// credential is `mcg_` plus 48 hex-ish characters; only its SHA-256 digest is
/// stored.
const MACHINE_CREDENTIAL: &str = "mcg_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MACHINE_DIGEST: &str = "1c81d99cbedcb23aa3b43c9ad338a2716ef3c2e2d82cdc147dae729606ebac0d";

fn machines_registry() -> Value {
    json!({
        "version": 1,
        "id": "machine_local_1",
        "name": "this computer",
        "peers": [],
        "grants": [{
            "id": "grant_laptop_1",
            "ownerId": "machine_peer_1",
            "name": "laptop",
            "digest": MACHINE_DIGEST,
            "createdAt": "2026-11-15T00:00:00Z",
        }],
    })
}

#[test]
fn a_machine_grant_opens_claimed_routes_without_the_share_store() {
    let gateway = Gateway::start_with(
        "machine-grant",
        share_script(&[]),
        Some(machines_registry()),
    );
    let response = gateway.get_with(
        PRESETS,
        &[
            ("Host", "dashboard.example.test"),
            ("X-Multicc-Machine-Grant", MACHINE_CREDENTIAL),
        ],
    );
    assert_eq!(
        response.status,
        200,
        "body {:?}\n{}",
        response.body,
        gateway.log()
    );
    assert_eq!(response.json()["presets"], json!([]));
    // `machines.authorize(req)` short-circuits the `||`; the fleet store is
    // never asked for a machine-scoped request.
    assert!(gateway.authorizations().is_empty());

    // A credential the registry does not know is no grant, and a machine header
    // suppresses the cookie/token fallback (`!machineHeader`) — so this is a
    // refusal even though the same request carries the access token.
    let unknown = format!("mcg_{}", "b".repeat(48));
    gateway
        .get_with(
            PRESETS,
            &[
                ("Host", "dashboard.example.test"),
                ("X-Multicc-Machine-Grant", &unknown),
                ("X-Access-Token", TOKEN),
            ],
        )
        .assert_auth_required("unknown machine grant");
}

#[test]
fn the_share_pair_is_only_the_second_half_of_the_scope_decision() {
    // Both credentials on one request: the machine grant is valid, so Node's
    // `||` never consults the share store. The front door keeps that order, so
    // a machine-scoped request cannot be delayed by a slow share store.
    let gateway = Gateway::start_with(
        "machine-then-fleet",
        share_script(&[(PRESETS, true)]),
        Some(machines_registry()),
    );
    let response = gateway.get_with(
        PRESETS,
        &[
            ("Host", "dashboard.example.test"),
            ("X-Multicc-Machine-Grant", MACHINE_CREDENTIAL),
            ("X-Multicc-Fleet-Token", "fleet_share_token"),
            ("X-Multicc-Fleet-Grant", "grant"),
        ],
    );
    assert_eq!(response.status, 200, "{}", gateway.log());
    assert!(
        gateway.authorizations().is_empty(),
        "{:?}",
        gateway.authorizations()
    );
}
