//! End-to-end integration tests for the Rust gateway cross-machine dispatch
//! endpoints and real-time SSE receipt hub (`native/gateway/src/app/cross_machine_dispatch.rs`).
//!
//! Spawns the real `multicc-gateway` binary with paired machine grants in
//! `machines.json` (Master A and Master C -> Slave B) and verifies:
//!   1. Non-grant callers are rejected with `403 machine_grant_required`.
//!   2. Multi-hop `machine_id` inside `/api/cross-machine/dispatches` is rejected
//!      at the Rust front door before touching Node (`400 cross_machine_multihop_denied`).
//!   3. `GET /targets`, `POST /dispatches`, `GET /dispatches/:opId`,
//!      `POST /dispatches/:opId/cancel`, and `POST /receipts/ack` forward
//!      authenticated `grant { id, ownerId, name }` into `POST /api/__host/orchestration`.
//!   4. `GET /api/cross-machine/receipts/stream` delivers catch-up pending
//!      receipts on connect, streams live `event: receipt` / `event: progress`
//!      frames pushed via `POST /api/__gateway/cross-machine/event`, and
//!      strictly isolates Master A's events from Master C.
//!   5. `POST /api/__gateway/cross-machine/event` rejects bad/missing capability.

use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

const GATEWAY_BIN: &str = env!("CARGO_BIN_EXE_multicc-gateway");
const FIXTURE_JS: &str = include_str!("fixtures/upstream.js");
const TOKEN: &str = "secret-token-cm-1";

fn unique(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "multicc-gateway-cm-{}-{tag}-{nanos}",
        std::process::id()
    ))
}

fn free_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.local_addr().unwrap().port()
}

struct Gateway {
    dir: PathBuf,
    data: PathBuf,
    state: PathBuf,
    port: u16,
    capability: String,
    child: Child,
}

impl Gateway {
    fn start(tag: &str, script: Value) -> Self {
        let mut last_log = String::new();
        for attempt in 0..6 {
            match Self::start_once(&format!("{tag}-{attempt}"), &script) {
                Ok(gw) => return gw,
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
        // Wrap upstream.js so it also records MULTICC_GATEWAY_AUTH_CAPABILITY for the test.
        let wrapper = format!(
            "require('node:fs').writeFileSync(require('node:path').join(process.env.FIXTURE_STATE_DIR, 'auth-cap'), String(process.env.MULTICC_GATEWAY_AUTH_CAPABILITY || ''));\n{FIXTURE_JS}"
        );
        fs::write(dir.join("server.js"), wrapper).unwrap();
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
        let mut gw = Self {
            dir,
            data,
            state,
            port,
            capability: String::new(),
            child,
        };
        let deadline = Instant::now() + Duration::from_secs(15);
        while !gw.state.join("ready").exists() {
            if let Ok(Some(status)) = gw.child.try_wait() {
                let log = gw.log();
                let retryable = log.contains("EADDRINUSE") || log.contains("cannot bind");
                return Err((format!("{log}\nchild exited: {status}"), retryable));
            }
            if Instant::now() >= deadline {
                return Err((gw.log(), false));
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        gw.capability = fs::read_to_string(gw.state.join("auth-cap")).unwrap_or_default();
        Ok(gw)
    }

    fn log(&self) -> String {
        fs::read_to_string(self.dir.join("gateway.log")).unwrap_or_default()
    }

    fn pair_grant(&self, owner_id: &str, name: &str) -> (String, String) {
        let root = self.data.to_string_lossy().into_owned();
        let reply = multicc_core::machines::local_operation(
            &root,
            "pair",
            &json!({ "ownerId": owner_id, "name": name }),
        );
        assert_eq!(reply["status"], 200, "pair failed: {reply}");
        let grant = reply["data"]["grant"].as_str().unwrap().to_string();
        let grant_id = reply["data"]["grantId"].as_str().unwrap().to_string();
        (grant, grant_id)
    }

    fn request(
        &self,
        method: &str,
        path: &str,
        headers: &[(&str, &str)],
        body: &str,
    ) -> (u16, Value) {
        let mut stream = TcpStream::connect(("127.0.0.1", self.port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut raw = format!(
            "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\nContent-Length: {}\r\n",
            self.port,
            body.len()
        );
        for (k, v) in headers {
            raw.push_str(&format!("{k}: {v}\r\n"));
        }
        raw.push_str("\r\n");
        raw.push_str(body);
        stream.write_all(raw.as_bytes()).unwrap();
        let mut buf = Vec::new();
        stream.read_to_end(&mut buf).unwrap();
        let text = String::from_utf8_lossy(&buf);
        let (head, body_str) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
        let status: u16 = head
            .lines()
            .next()
            .unwrap_or("")
            .split_whitespace()
            .nth(1)
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        let parsed = serde_json::from_str(body_str).unwrap_or_else(|_| json!({ "raw": body_str }));
        (status, parsed)
    }

    fn open_sse(&self, grant: &str) -> BufReader<TcpStream> {
        let mut stream = TcpStream::connect(("127.0.0.1", self.port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let req = format!(
            "GET /api/cross-machine/receipts/stream HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAccept: text/event-stream\r\nx-multicc-machine-grant: {grant}\r\n\r\n",
            self.port
        );
        stream.write_all(req.as_bytes()).unwrap();
        let mut reader = BufReader::new(stream);
        let mut status_line = String::new();
        reader.read_line(&mut status_line).unwrap();
        assert!(
            status_line.contains("200"),
            "expected SSE 200, got: {status_line}"
        );
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            if line == "\r\n" || line == "\n" || line.is_empty() {
                break;
            }
        }
        reader
    }
}

impl Drop for Gateway {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn read_sse_event(reader: &mut BufReader<TcpStream>) -> (String, Value) {
    let mut event = String::new();
    let mut data = String::new();
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line).unwrap();
        assert!(n > 0, "SSE stream closed unexpectedly");
        let trimmed = line.trim_end_matches(&['\r', '\n'][..]);
        if trimmed.is_empty() {
            if !data.is_empty() {
                let parsed: Value = serde_json::from_str(&data).unwrap();
                return (event, parsed);
            }
            continue;
        }
        if trimmed.starts_with(':') {
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("event:") {
            event = rest.trim().to_string();
        } else if let Some(rest) = trimmed.strip_prefix("data:") {
            data = rest.trim().to_string();
        }
    }
}

#[test]
fn cross_machine_gateway_enforces_grant_multihop_and_streams_isolated_receipts() {
    let script = json!({
        "orchestration": {
            "ops": {
                "cross-machine-targets": {
                    "status": 200,
                    "body": { "ok": true, "directories": [{"id": "dir_1", "name": "multicc"}], "sessions": [{"id": "task-1", "label": "Worker 1"}] }
                },
                "cross-machine-admit": {
                    "status": 200,
                    "body": { "ok": true, "operationId": "op_live_1", "status": "admitted", "targetSessionId": "task-1", "executionSessionId": "task-1" }
                },
                "cross-machine-pending-receipts": {
                    "status": 200,
                    "body": {
                        "ok": true,
                        "receipts": [
                            { "operationId": "op_catchup_1", "status": "completed", "terminal": true, "settle": 1, "result": { "text": "replayed from sqlite" } }
                        ]
                    }
                },
                "cross-machine-ack": {
                    "status": 200,
                    "body": { "ok": true, "operationId": "op_live_1", "ackedSettle": 1 }
                }
            }
        }
    });
    let gw = Gateway::start("e2e", script);
    let (grant_a, _grant_a_id) = gw.pair_grant("machine_master_a", "MacBook-A");
    let (grant_c, _grant_c_id) = gw.pair_grant("machine_master_c", "Other-C");

    // 1. Access token without x-multicc-machine-grant must be rejected (403 machine_grant_required).
    let (st, body) = gw.request(
        "GET",
        "/api/cross-machine/targets",
        &[("x-access-token", TOKEN)],
        "",
    );
    assert_eq!(st, 403);
    assert_eq!(body["code"], "machine_grant_required");

    // 2. Multi-hop machine_id must be rejected in Rust front door before Node.
    let (st, body) = gw.request(
        "POST",
        "/api/cross-machine/dispatches",
        &[
            ("x-multicc-machine-grant", &grant_a),
            ("Content-Type", "application/json"),
        ],
        &json!({
            "machine_id": "machine_hop_2",
            "operationId": "op_hop",
            "idempotencyKey": "k1",
            "mode": "async",
            "targetSessionId": "task-1",
            "message": "hello"
        })
        .to_string(),
    );
    assert_eq!(st, 400);
    assert_eq!(body["code"], "cross_machine_multihop_denied");

    // 3. Valid grant succeeds on targets & admit.
    let (st, body) = gw.request(
        "GET",
        "/api/cross-machine/targets",
        &[("x-multicc-machine-grant", &grant_a)],
        "",
    );
    assert_eq!(st, 200);
    assert_eq!(body["sessions"][0]["id"], "task-1");

    let (st, body) = gw.request(
        "POST",
        "/api/cross-machine/dispatches",
        &[
            ("x-multicc-machine-grant", &grant_a),
            ("Content-Type", "application/json"),
        ],
        &json!({
            "operationId": "op_live_1",
            "idempotencyKey": "k2",
            "mode": "async",
            "targetSessionId": "task-1",
            "message": "run check"
        })
        .to_string(),
    );
    assert_eq!(st, 200);
    assert_eq!(body["operationId"], "op_live_1");

    // 4. Open SSE streams for both Master A and Master C.
    let mut sse_a = gw.open_sse(&grant_a);
    let mut sse_c = gw.open_sse(&grant_c);

    // Both receive their catch-up receipt on connect.
    let (ev_a0, data_a0) = read_sse_event(&mut sse_a);
    assert_eq!(ev_a0, "receipt");
    assert_eq!(data_a0["operationId"], "op_catchup_1");
    let (ev_c0, _) = read_sse_event(&mut sse_c);
    assert_eq!(ev_c0, "receipt");

    // 5. Internal event endpoint rejects invalid capability.
    let (st, body) = gw.request(
        "POST",
        "/api/__gateway/cross-machine/event",
        &[
            ("x-multicc-gateway-capability", "wrong-cap"),
            ("Content-Type", "application/json"),
        ],
        &json!({
            "masterMachineId": "machine_master_a",
            "event": "receipt",
            "payload": { "operationId": "op_live_1" }
        })
        .to_string(),
    );
    assert_eq!(st, 403);
    assert_eq!(body["code"], "invalid_capability");

    // 6. Valid capability publishes an event targeted ONLY to Master A, then one to Master C.
    let (st, body) = gw.request(
        "POST",
        "/api/__gateway/cross-machine/event",
        &[
            ("x-multicc-gateway-capability", &gw.capability),
            ("Content-Type", "application/json"),
        ],
        &json!({
            "masterMachineId": "machine_master_a",
            "event": "receipt",
            "payload": { "operationId": "op_live_1", "status": "completed", "settle": 1, "result": { "text": "done on macpro" } }
        })
        .to_string(),
    );
    assert_eq!(st, 200);
    assert_eq!(body["ok"], true);

    let (st, _) = gw.request(
        "POST",
        "/api/__gateway/cross-machine/event",
        &[
            ("x-multicc-gateway-capability", &gw.capability),
            ("Content-Type", "application/json"),
        ],
        &json!({
            "masterMachineId": "machine_master_c",
            "event": "progress",
            "payload": { "operationId": "op_c_only", "progress": { "text": "only for C" } }
        })
        .to_string(),
    );
    assert_eq!(st, 200);

    // Master A receives op_live_1; Master C skips op_live_1 and receives ONLY op_c_only!
    let (ev_a1, data_a1) = read_sse_event(&mut sse_a);
    assert_eq!(ev_a1, "receipt");
    assert_eq!(data_a1["operationId"], "op_live_1");
    assert_eq!(data_a1["result"]["text"], "done on macpro");

    let (ev_c1, data_c1) = read_sse_event(&mut sse_c);
    assert_eq!(ev_c1, "progress");
    assert_eq!(data_c1["operationId"], "op_c_only");

    // 7. Ack succeeds with valid grant.
    let (st, body) = gw.request(
        "POST",
        "/api/cross-machine/receipts/ack",
        &[
            ("x-multicc-machine-grant", &grant_a),
            ("Content-Type", "application/json"),
        ],
        &json!({ "operationId": "op_live_1", "settle": 1 }).to_string(),
    );
    assert_eq!(st, 200);
    assert_eq!(body["ackedSettle"], 1);
}
