//! Integration coverage for the model catalog routes against the real
//! `multicc-gateway` binary:
//!
//!   GET/HEAD/OPTIONS /api/{opencode,qoder,grok,commandcode,codebuddy}/models
//!   GET/HEAD/OPTIONS /api/providers/:id/models
//!   GET/HEAD/OPTIONS /api/codex/models
//!   POST/OPTIONS     /api/codex/models/sync
//!
//! The Node process is the shared protocol fixture: it speaks PROXY v1, serves
//! the auth control bridge, and answers the host port from the JSON script the
//! test writes (`FIXTURE_HOST_SCRIPT`). Routing, query parsing, status codes,
//! headers and response shapes are Rust and are what these tests assert.

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
        "multicc-gateway-model-catalogs-{}-{tag}-{nanos}",
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

    fn host_calls(&self, file: &str) -> Vec<Value> {
        fs::read_to_string(self.state.join(file))
            .unwrap_or_default()
            .lines()
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn exchange(&self, method: &str, url: &str, body: Option<&Value>) -> Response {
        let mut stream = TcpStream::connect(("127.0.0.1", self.port)).expect("connect gateway");
        stream
            .set_read_timeout(Some(Duration::from_secs(30)))
            .unwrap();
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
        stream.write_all(request.as_bytes()).unwrap();
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).unwrap();
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
        self.exchange("GET", url, None)
    }

    fn post(&self, url: &str, body: Value) -> Response {
        self.exchange("POST", url, Some(&body))
    }
}

impl Drop for Gateway {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn catalog(provider: &str, model: &str) -> Value {
    json!({ "provider": provider, "model": model, "label": format!("{provider}/{model}") })
}

fn base_script() -> Value {
    json!({
        "catalogs": {
            "opencode": { "ok": true, "models": [catalog("opencode", "big-pickle")], "source": "cli" },
            "qoder": { "ok": true, "models": [{ "model": "Auto", "label": "Auto" }], "source": "cache" },
            "grok": { "ok": true, "models": [{ "model": "grok-4.6", "label": "grok-4.6", "isDefault": true }], "source": "fallback" },
            "commandcode": { "ok": true, "models": [{ "model": "moonshotai/kimi-k3", "label": "moonshotai/kimi-k3", "group": "Open Source" }], "source": "cli" },
            "codebuddy": { "ok": true, "models": [{ "model": "glm-5.3", "label": "glm-5.3" }], "source": "cli-unauthenticated" }
        },
        "provider": { "status": 200, "body": { "models": [{ "model": "deepseek-v4.1", "label": "DeepSeek V4.1" }], "source": "live", "cached": false } },
        "providers": {
            "missing": { "status": 404, "body": { "error": "provider not found" } }
        },
        "codex": {
            "states": {
                "codex-official": {
                    "found": true, "id": "codex-official", "appType": "codex", "official": true,
                    "peek": { "catalogFetchedAt": null, "models": [{ "model": "gpt-5-codex", "label": "GPT-5 Codex", "isDefault": true }], "source": "memory_cache", "cached": true, "stale": false, "available": true, "fetchedAt": 1700000000000i64, "cliVersion": "0.50.0", "diagnostic": { "code": "ok", "message": "ok" }, "fallback": "codex_default" },
                    "refreshing": false
                }
            },
            "peekAfterRefresh": { "catalogFetchedAt": 1700000005000i64, "models": [{ "model": "gpt-6-sol", "label": "GPT-6 Sol", "isDefault": true }], "source": "cli", "cached": false, "stale": false, "available": true, "fetchedAt": 1700000005000i64, "cliVersion": "0.51.0", "diagnostic": { "code": "ok", "message": "ok" }, "fallback": "codex_default" }
        }
    })
}

#[test]
fn cli_catalogs_answer_the_retired_shape() {
    let gateway = Gateway::start("catalogs", base_script());
    for (path, expected) in [
        (
            "/api/opencode/models",
            json!({ "models": [catalog("opencode", "big-pickle")], "source": "cli", "cached": false }),
        ),
        (
            "/api/qoder/models",
            json!({ "models": [{ "model": "Auto", "label": "Auto" }], "source": "cache", "cached": true }),
        ),
        (
            "/api/grok/models",
            json!({ "models": [{ "model": "grok-4.6", "label": "grok-4.6", "isDefault": true }], "source": "fallback", "cached": false }),
        ),
        (
            "/api/commandcode/models",
            json!({ "models": [{ "model": "moonshotai/kimi-k3", "label": "moonshotai/kimi-k3", "group": "Open Source" }], "source": "cli", "cached": false }),
        ),
        (
            "/api/codebuddy/models",
            json!({ "models": [{ "model": "glm-5.3", "label": "glm-5.3" }], "source": "cli-unauthenticated", "cached": false }),
        ),
    ] {
        let response = gateway.get(path);
        assert_eq!(response.status, 200, "{path}: {}", response.body);
        assert_eq!(
            response.header("content-type"),
            Some("application/json; charset=utf-8")
        );
        assert_eq!(response.json(), expected, "{path}");
    }
}

#[test]
fn refresh_flags_keep_each_route_convention() {
    let gateway = Gateway::start("refresh", base_script());
    for url in [
        "/api/opencode/models?refresh=1",
        "/api/opencode/models?refresh=true",
        "/api/opencode/models?refresh=TRUE",
        "/api/qoder/models?refresh=TRUE",
        "/api/grok/models?refresh=true",
        "/api/commandcode/models?refresh=0",
        "/api/codebuddy/models?refresh",
    ] {
        let response = gateway.get(url);
        assert_eq!(response.status, 200, "{url}");
    }
    let calls = gateway.host_calls("model-calls.jsonl");
    let flags: Vec<(String, bool)> = calls
        .iter()
        .map(|call| {
            (
                call["op"].as_str().unwrap_or("").to_string(),
                call["refresh"] == json!(true),
            )
        })
        .collect();
    assert_eq!(
        flags,
        vec![
            ("opencode".to_string(), true),
            ("opencode".to_string(), false),
            ("opencode".to_string(), false),
            ("qoder".to_string(), true),
            ("grok".to_string(), true),
            ("commandcode".to_string(), false),
            ("codebuddy".to_string(), false),
        ]
    );
}

#[test]
fn a_failed_cli_pull_keeps_the_route_503_shape() {
    let gateway = Gateway::start("cli-down", {
        let mut script = base_script();
        script["catalogs"]["qoder"] = json!({ "ok": false, "error": "qoder models unavailable" });
        script
    });
    let response = gateway.get("/api/qoder/models");
    assert_eq!(response.status, 503);
    assert_eq!(
        response.json(),
        json!({ "error": "qoder models unavailable", "models": [] })
    );
}

#[test]
fn provider_models_forward_status_and_header() {
    let gateway = Gateway::start("provider", base_script());
    let ok = gateway.get("/api/providers/main/models");
    assert_eq!(ok.status, 200, "{}", ok.body);
    assert_eq!(ok.header("cache-control"), Some("no-store"));
    assert_eq!(
        ok.json(),
        json!({ "models": [{ "model": "deepseek-v4.1", "label": "DeepSeek V4.1" }], "source": "live", "cached": false })
    );

    let missing = gateway.get("/api/providers/missing/models");
    assert_eq!(missing.status, 404);
    assert_eq!(missing.header("cache-control"), Some("no-store"));
    assert_eq!(missing.json(), json!({ "error": "provider not found" }));

    let calls = gateway.host_calls("model-calls.jsonl");
    assert_eq!(
        calls[0],
        json!({ "op": "provider", "providerId": "main", "refresh": false })
    );
    assert_eq!(
        calls[1],
        json!({ "op": "provider", "providerId": "missing", "refresh": false })
    );
}

#[test]
fn provider_id_is_decoded_and_case_preserved() {
    let gateway = Gateway::start("provider-id", base_script());
    let response = gateway.get("/api/Providers/My%20Relay/models");
    assert_eq!(response.status, 200);
    let calls = gateway.host_calls("model-calls.jsonl");
    assert_eq!(calls[0]["providerId"], json!("My Relay"));
}

#[test]
fn codex_official_kicks_a_refresh_then_answers_the_new_catalog() {
    let gateway = Gateway::start("codex", base_script());
    let response = gateway.get("/api/codex/models?providerId=codex-official");
    assert_eq!(response.status, 200, "{}", response.body);
    let value = response.json();
    assert_eq!(value["models"][0]["model"], json!("gpt-6-sol"));
    assert_eq!(value["available"], json!(true));
    assert_eq!(value["refreshing"], json!(false));
    assert_eq!(value["fallback"], json!("codex_default"));
    assert_eq!(response.header("cache-control"), Some("no-store"));

    let calls = gateway.host_calls("model-calls.jsonl");
    assert_eq!(
        calls[0],
        json!({ "op": "codex-state", "providerId": "codex-official" })
    );
    assert_eq!(
        calls[1],
        json!({ "op": "codex-refresh", "providerId": "codex-official", "wait": false })
    );
    assert_eq!(
        calls[2],
        json!({ "op": "codex-state", "providerId": "codex-official" })
    );
}

#[test]
fn codex_legacy_wait_refreshes_the_global_account_once() {
    let gateway = Gateway::start("codex-legacy", base_script());
    let response = gateway.get("/api/codex/models");
    assert_eq!(response.status, 200, "{}", response.body);
    let refresh = gateway.host_calls("model-refresh.jsonl");
    assert_eq!(refresh[0]["providerId"], json!("codex-official"));
    assert_eq!(refresh[0]["wait"], json!(true));
    // The legacy path polls only: no second background kick.
    assert_eq!(refresh.len(), 1);
}

#[test]
fn codex_rejects_unknown_and_non_codex_providers() {
    let gateway = Gateway::start("codex-invalid", base_script());
    let missing = gateway.get("/api/codex/models?providerId=ghost");
    assert_eq!(missing.status, 404);
    assert_eq!(missing.json(), json!({ "error": "账号线路不存在" }));

    let mut script = base_script();
    script["codex"]["states"]["claude-line"] = json!({
        "found": true, "id": "claude-line", "appType": "claude", "official": false,
    });
    let gateway = Gateway::start("codex-claude", script);
    let wrong = gateway.get("/api/codex/models?providerId=claude-line");
    assert_eq!(wrong.status, 400);
    assert_eq!(
        wrong.json(),
        json!({ "error": "该线路不是 Codex 官方账号" })
    );
}

#[test]
fn codex_relay_lines_use_the_provider_catalog_shape() {
    let mut script = base_script();
    script["codex"]["states"]["relay"] = json!({
        "found": true, "id": "relay", "appType": "codex", "official": false,
    });
    script["providers"]["relay"] = json!({
        "status": 200,
        "body": { "models": [{ "model": "deepseek-v4.1", "label": "DeepSeek V4.1" }], "source": "live" }
    });
    let gateway = Gateway::start("codex-relay", script);
    let response = gateway.get("/api/codex/models?providerId=relay");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(
        response.json(),
        json!({
            "models": [{ "model": "deepseek-v4.1", "label": "DeepSeek V4.1" }],
            "source": "live",
            "cached": false,
            "available": true,
            "refreshing": false,
            "fallback": "custom",
            "diagnostic": { "code": "ok", "message": "" },
        })
    );
}

#[test]
fn codex_sync_reads_the_provider_from_the_body() {
    let gateway = Gateway::start("codex-sync", base_script());
    let response = gateway.post(
        "/api/codex/models/sync",
        json!({ "providerId": "codex-official" }),
    );
    assert_eq!(response.status, 200, "{}", response.body);
    let calls = gateway.host_calls("model-calls.jsonl");
    assert_eq!(calls[0]["op"], json!("codex-state"));
    assert_eq!(calls[0]["providerId"], json!("codex-official"));
    assert_eq!(calls[1]["op"], json!("codex-refresh"));
    assert_eq!(calls[1]["wait"], json!(false));
}

#[test]
fn express_options_answers_are_preserved() {
    let gateway = Gateway::start("options", base_script());
    for path in [
        "/api/opencode/models",
        "/api/qoder/models",
        "/api/grok/models",
        "/api/commandcode/models",
        "/api/codebuddy/models",
        "/api/providers/main/models",
        "/api/codex/models",
    ] {
        let response = gateway.exchange("OPTIONS", path, None);
        assert_eq!(response.status, 200, "{path}");
        assert_eq!(response.header("allow"), Some("GET,HEAD"), "{path}");
    }
    let sync = gateway.exchange("OPTIONS", "/api/codex/models/sync", None);
    assert_eq!(sync.status, 200);
    assert_eq!(sync.header("allow"), Some("POST"));
}

#[test]
fn head_matches_get_without_a_body() {
    let gateway = Gateway::start("head", base_script());
    let get = gateway.get("/api/opencode/models");
    let head = gateway.exchange("HEAD", "/api/opencode/models", None);
    assert_eq!(head.status, 200);
    assert_eq!(head.body, "");
    assert_eq!(head.header("etag"), get.header("etag"));
    assert_eq!(head.header("content-type"), get.header("content-type"));
}

#[test]
fn host_down_answers_the_family_shapes() {
    let gateway = Gateway::start("host-down", {
        let mut script = base_script();
        script["hostDown"] = json!(true);
        script
    });
    let catalog_response = gateway.get("/api/opencode/models");
    assert_eq!(catalog_response.status, 503);
    assert_eq!(
        catalog_response.json(),
        json!({ "error": "opencode models unavailable", "models": [] })
    );
    for path in ["/api/providers/main/models", "/api/codex/models"] {
        let response = gateway.get(path);
        assert_eq!(response.status, 503, "{path}");
        assert_eq!(
            response.json(),
            json!({
                "error": "模型目录接口尚未就绪，请更新原生模块",
                "code": "rust_backend_unavailable",
            })
        );
    }
}

#[test]
fn unrelated_paths_still_reach_node() {
    let gateway = Gateway::start("forward", base_script());
    // The fixture answers `ok` for anything it does not serve by name; a
    // claimed path would answer JSON from Rust instead.
    for path in [
        "/api/providers/main/models/extra",
        "/api/providers//models",
        "/api/opencode/models/extra",
    ] {
        let response = gateway.get(path);
        assert_eq!(response.status, 200, "{path}: {}", response.body);
        assert_eq!(response.body, "ok", "{path} was answered in Rust");
    }
    assert!(gateway.host_calls("model-calls.jsonl").is_empty());
}
