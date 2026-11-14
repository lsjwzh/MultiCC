//! Integration coverage for the voice REST routes retired from
//! `src/routes/voice.js` and answered by the Rust front door
//! (`native/gateway/src/app/voice_routes.rs`):
//!
//!   POST         /api/voice/refine
//!   POST         /api/voice/feedback
//!   POST         /api/voice/confirm
//!   POST         /api/voice/progress-summary
//!   GET|HEAD     /api/voice/vocab
//!   GET|HEAD     /api/voice/readiness
//!   GET|HEAD     /api/voice/hotwords
//!   POST         /api/voice/hotwords/reject
//!   DELETE       /api/voice/vocab/:term
//!   GET|HEAD     /api/settings/voice
//!   POST         /api/settings/voice/asr-model
//!   POST         /api/settings/voice
//!   GET|HEAD     /api/voice/test-sse
//!
//! `POST /api/voice/stt` stays in Node and must keep being forwarded.
//!
//! The Node process here is only the protocol fixture (PROXY v1 + auth
//! control): it answers `POST /api/__host/voice` from `FIXTURE_HOST_SCRIPT`
//! and appends every body to `voice-calls.jsonl`. Status tables, bodies, key
//! order, the prompts, the write lock and the 503s are Rust and are what these
//! tests assert.

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
        "multicc-gateway-voice-routes-{}-{tag}-{nanos}",
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
    /// gateway binds `0.0.0.0`; a bind failure is retried with a fresh port.
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

    fn raw_calls(&self, file: &str) -> Vec<String> {
        fs::read_to_string(self.state.join(file))
            .unwrap_or_default()
            .lines()
            .filter(|line| !line.is_empty())
            .map(str::to_string)
            .collect()
    }

    fn calls(&self, file: &str) -> Vec<Value> {
        self.raw_calls(file)
            .iter()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn voice_calls(&self) -> Vec<Value> {
        self.calls("voice-calls.jsonl")
    }

    fn voice_raw(&self) -> Vec<String> {
        self.raw_calls("voice-calls.jsonl")
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

    fn request(
        &self,
        method: &str,
        url: &str,
        body: Option<&Value>,
        extra: &[(&str, &str)],
    ) -> Response {
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
        let payload = body
            .map(|value| serde_json::to_string(value).unwrap())
            .unwrap_or_default();
        if body.is_some() {
            lines.push_str("Content-Type: application/json\r\n");
            lines.push_str(&format!("Content-Length: {}\r\n", payload.len()));
        }
        let request = format!(
            "{method} {url} HTTP/1.1\r\nHost: {host}\r\nX-Request-Id: {request_id}\r\n\
             {lines}Connection: close\r\n\r\n{payload}"
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
        Response {
            status,
            headers,
            body: String::from_utf8_lossy(&raw[split + 4..]).into_owned(),
        }
    }

    fn get(&self, url: &str) -> Response {
        self.request("GET", url, None, &[])
    }

    fn head(&self, url: &str) -> Response {
        self.request("HEAD", url, None, &[])
    }

    fn options(&self, url: &str) -> Response {
        self.request("OPTIONS", url, None, &[])
    }

    fn post(&self, url: &str, body: &Value) -> Response {
        self.request("POST", url, Some(body), &[])
    }

    fn delete(&self, url: &str) -> Response {
        self.request("DELETE", url, None, &[])
    }
}

impl Drop for Gateway {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn script(voice: Value) -> Value {
    json!({ "voice": voice })
}

// ── refine ─────────────────────────────────────────────────────────────────

#[test]
fn refine_short_circuits_when_the_transcript_is_blank() {
    let gateway = Gateway::start("refine-empty", script(json!({})));
    let response = gateway.post("/api/voice/refine", &json!({ "raw": "   " }));
    assert_eq!(response.status, 200);
    assert_eq!(response.json(), json!({ "ok": true, "text": "", "ms": 0 }));
    assert!(gateway.voice_calls().is_empty());
}

#[test]
fn refine_sends_the_history_and_answers_with_the_aux_text() {
    let gateway = Gateway::start(
        "refine-ok",
        script(json!({
            "examples": [{"raw": "先做个按钮", "userFinal": "添加按钮"}],
            "text": "添加一个按钮",
        })),
    );
    let response = gateway.post("/api/voice/refine", &json!({ "raw": " 给我加个按钮 " }));
    assert_eq!(response.status, 200);
    let body = response.json();
    assert_eq!(body["ok"], json!(true));
    assert_eq!(body["text"], json!("添加一个按钮"));
    assert!(body["ms"].as_i64().unwrap() >= 0);

    let calls = gateway.voice_calls();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0], json!({ "op": "examples" }));
    assert_eq!(calls[1]["op"], json!("auxEnqueue"));
    assert_eq!(calls[1]["type"], json!("voice_refine"));
    // `vr_<ms>_<base36>`: a real id, not an empty string.
    let req_id = calls[1]["meta"]["reqId"].as_str().unwrap();
    assert!(req_id.starts_with("vr_") && req_id.len() > 5, "{req_id}");
    let prompt = calls[1]["prompt"].as_str().unwrap();
    assert!(prompt.contains("[案例1] 原始：先做个按钮\n优化后：添加按钮"));
    assert!(
        prompt.ends_with("\n\n原始语音：给我加个按钮\n直接输出优化后的文本，不要任何解释或前缀。")
    );
}

#[test]
fn refine_renders_an_aux_failure_as_text_and_a_trim_type_error_as_500() {
    let gateway = Gateway::start(
        "refine-fail",
        script(
            json!({ "answers": { "auxEnqueue": { "ok": false, "cancelled": true, "message": "x" } } }),
        ),
    );
    let response = gateway.post("/api/voice/refine", &json!({ "raw": "hi" }));
    assert_eq!(response.status, 200);
    assert_eq!(response.json()["ok"], json!(false));
    assert_eq!(response.json()["text"], json!("[错误: cancelled]"));

    // `5..trim()` is not a function: the retired handler's await boundary made
    // it an error response.
    let response = gateway.post("/api/voice/refine", &json!({ "raw": 5 }));
    assert_eq!(response.status, 500);
    assert_eq!(response.json()["error"], json!("internal_error"));
}

// ── feedback ───────────────────────────────────────────────────────────────

#[test]
fn feedback_only_writes_when_the_user_changed_the_text() {
    let gateway = Gateway::start("feedback", script(json!({})));
    let no_write = gateway.post(
        "/api/voice/feedback",
        &json!({ "raw": "a", "refined": "b" }),
    );
    assert_eq!(no_write.status, 200);
    assert_eq!(no_write.json(), json!({ "ok": true }));
    assert!(gateway.voice_calls().is_empty());

    let written = gateway.post(
        "/api/voice/feedback",
        &json!({ "raw": "a", "refined": "b", "userFinal": "c" }),
    );
    assert_eq!(written.json(), json!({ "ok": true }));
    assert_eq!(
        gateway.voice_raw(),
        [r#"{"op":"feedbackApply","raw":"a","refined":"b","userFinal":"c"}"#.to_string()]
    );
}

// ── confirm ────────────────────────────────────────────────────────────────

#[test]
fn confirm_requires_text_or_feedback() {
    let gateway = Gateway::start("confirm-400", script(json!({})));
    let response = gateway.post("/api/voice/confirm", &json!({ "text": "  " }));
    assert_eq!(response.status, 400);
    assert_eq!(
        response.json(),
        json!({ "error": "缺少 text 或 userFeedback" })
    );
    assert!(gateway.voice_calls().is_empty());
}

#[test]
fn confirm_spreads_the_greedy_json_and_keeps_ms_last() {
    let gateway = Gateway::start(
        "confirm-ok",
        script(json!({
            "text": "先说点别的 {\"summary\":\"s\",\"items\":[\"a\"],\"allConfirmed\":true} 结尾",
        })),
    );
    let response = gateway.post(
        "/api/voice/confirm",
        &json!({ "text": " 加两个按钮 ", "userFeedback": "再确认一下" }),
    );
    assert_eq!(response.status, 200);
    let body = response.body.clone();
    assert!(
        body.starts_with(r#"{"ok":true,"summary":"s","items":["a"],"allConfirmed":true,"ms":"#),
        "{body}"
    );
    assert!(body.ends_with('}'));
    let call = gateway.voice_calls();
    assert_eq!(call.len(), 1);
    assert_eq!(call[0]["type"], json!("voice_confirm"));
    let prompt = call[0]["prompt"].as_str().unwrap();
    assert!(prompt.contains("用户本次的语音输入：加两个按钮"));
    assert!(prompt.contains("用户对此的语音反馈：再确认一下"));
}

#[test]
fn confirm_falls_back_to_the_trimmed_text() {
    let gateway = Gateway::start(
        "confirm-fallback",
        script(json!({ "text": "  不是 JSON  " })),
    );
    let response = gateway.post("/api/voice/confirm", &json!({ "text": "x" }));
    assert_eq!(response.status, 200);
    let body = response.json();
    assert_eq!(body["summary"], json!("不是 JSON"));
    assert_eq!(body["items"], json!([]));
    assert_eq!(body["questions"], json!([]));
    assert_eq!(body["allConfirmed"], json!(false));
}

#[test]
fn confirm_surfaces_a_caught_parse_error() {
    let gateway = Gateway::start("confirm-throw", script(json!({ "text": 5 })));
    let response = gateway.post("/api/voice/confirm", &json!({ "text": "x" }));
    assert_eq!(response.status, 500);
    assert!(response.json()["error"].as_str().unwrap().contains("match"));
}

// ── progress-summary ───────────────────────────────────────────────────────

#[test]
fn progress_short_circuits_and_summarizes() {
    let gateway = Gateway::start("progress", script(json!({ "text": "  已经完成一半  " })));
    let empty = gateway.post("/api/voice/progress-summary", &json!({ "events": [] }));
    assert_eq!(empty.status, 200);
    assert_eq!(empty.json(), json!({ "ok": true, "summary": "" }));
    let not_array = gateway.post("/api/voice/progress-summary", &json!({ "events": "x" }));
    assert_eq!(not_array.json(), json!({ "ok": true, "summary": "" }));
    assert!(gateway.voice_calls().is_empty());

    let response = gateway.post(
        "/api/voice/progress-summary",
        &json!({
            "events": [{"type": "tool", "summary": "读取文件"}, {"summary": "写代码"}],
            "taskDescription": "做登录页",
        }),
    );
    assert_eq!(response.status, 200);
    let body = response.json();
    assert_eq!(body["ok"], json!(true));
    assert_eq!(body["summary"], json!("已经完成一半"));
    let calls = gateway.voice_calls();
    assert_eq!(calls[0]["type"], json!("progress_summary"));
    let prompt = calls[0]["prompt"].as_str().unwrap();
    assert!(prompt
        .contains("任务描述：做登录页\n\n最近的进展事件：\n1. [tool] 读取文件\n2. [?] 写代码"));
}

// ── vocab ──────────────────────────────────────────────────────────────────

#[test]
fn vocab_get_returns_the_array_and_head_has_no_body() {
    let gateway = Gateway::start(
        "vocab",
        script(json!({ "vocab": [{"term": "React", "count": 2}] })),
    );
    let response = gateway.get("/api/voice/vocab");
    assert_eq!(response.status, 200);
    assert_eq!(response.json(), json!([{"term": "React", "count": 2}]));
    assert_eq!(
        response.header("content-type"),
        Some("application/json; charset=utf-8")
    );

    let head = gateway.head("/api/voice/vocab");
    assert_eq!(head.status, 200);
    assert!(head.body.is_empty());
    assert_eq!(head.header("content-length"), Some("28"));
}

#[test]
fn vocab_delete_lowercases_the_decoded_term() {
    let gateway = Gateway::start("vocab-delete", script(json!({ "remaining": 2 })));
    let response = gateway.delete("/api/voice/vocab/Hello%20World");
    assert_eq!(response.status, 200);
    assert_eq!(response.json(), json!({ "ok": true, "remaining": 2 }));
    assert_eq!(
        gateway.voice_raw(),
        [r#"{"op":"vocabDelete","target":"hello world"}"#.to_string()]
    );

    // A malformed escape made Express answer 400 before the handler ran.
    let broken = gateway.delete("/api/voice/vocab/%zz");
    assert_eq!(broken.status, 400);
    assert_eq!(broken.json()["error"], json!("request_error"));
    assert_eq!(gateway.voice_calls().len(), 1);
}

// ── readiness / hotwords ───────────────────────────────────────────────────

#[test]
fn readiness_maps_the_host_facts() {
    let gateway = Gateway::start(
        "readiness",
        script(json!({
            "localAvailable": false,
            "download": {"state": "downloading", "progress": 0.5},
            "cloudKeys": {"whisper": false, "openrouter": true},
        })),
    );
    let response = gateway.get("/api/voice/readiness");
    assert_eq!(response.status, 200);
    assert_eq!(
        response.body,
        r#"{"ready":true,"engine":"cloud","reason":null,"cloudConfigured":true,"download":{"state":"downloading","progress":0.5}}"#
    );
}

#[test]
fn hotwords_shapes_and_reject_statuses() {
    let gateway = Gateway::start(
        "hotwords",
        script(json!({
            "present": true,
            "enabled": true,
            "snapshot": {"terms": [{"term": "多西", "score": 2}]},
            "accepted": false,
        })),
    );
    let response = gateway.get("/api/voice/hotwords");
    assert_eq!(response.status, 200);
    assert_eq!(
        response.json(),
        json!({ "enabled": true, "terms": [{"term": "多西", "score": 2}] })
    );

    let denied = gateway.post("/api/voice/hotwords/reject", &json!({ "term": "多西" }));
    assert_eq!(denied.status, 400);
    assert_eq!(
        denied.json(),
        json!({ "ok": false, "error": "term required" })
    );
    assert_eq!(
        gateway.voice_raw(),
        [
            r#"{"op":"hotwords"}"#.to_string(),
            r#"{"op":"hotwordsReject","term":"多西"}"#.to_string(),
        ]
    );
}

#[test]
fn hotwords_absent_disables_the_panel() {
    let gateway = Gateway::start("hotwords-absent", script(json!({ "accepted": true })));
    let response = gateway.get("/api/voice/hotwords");
    assert_eq!(response.json(), json!({ "enabled": false }));
    let rejected = gateway.post("/api/voice/hotwords/reject", &json!({ "term": "x" }));
    assert_eq!(rejected.status, 200);
    assert_eq!(rejected.json(), json!({ "ok": true }));
}

// ── settings ───────────────────────────────────────────────────────────────

#[test]
fn settings_get_assembles_the_frozen_dto() {
    let gateway = Gateway::start("settings-get", script(json!({ "env": {}, "runtime": {} })));
    let response = gateway.get("/api/settings/voice");
    assert_eq!(response.status, 200);
    assert_eq!(
        response.body,
        concat!(
            r#"{"baseUrl":"https://openrouter.ai/api/v1","apiKey":"","model":"google/gemini-2.0-flash-001","hasKey":false,"#,
            r#""whisperBaseUrl":"https://openrouter.ai/api/v1","whisperApiKey":"","whisperModel":"whisper-large-v3-turbo","hasWhisperKey":false,"#,
            r#""whisperLanguage":"zh","whisperPrompt":"","#,
            r#""asr":{"provider":"auto","status":{"local":{"available":false}},"openaiUrl":"wss://api.openai.com/v1/realtime","openaiModel":"gpt-4o-transcribe","hasOpenaiKey":false,"volcUrl":"","volcResourceId":"volc.bigasr.sauc.duration","hasVolcAppId":false,"hasVolcToken":false,"funasrUrl":"","funasrMode":"2pass"},"#,
            r#""tts":{"provider":"edge","status":{"provider":"edge"},"edgeVoice":"zh-CN-XiaoxiaoNeural","openaiVoice":"alloy","hasOpenaiKey":false,"volcanoVoice":"zh_female_shuangkuaisisi_moon_bigtts","hasVolcanoAppId":false,"hasVolcanoToken":false},"#,
            r#""qwenAudio":{"hasApiKey":false,"apiKey":"","model":"qwen-audio-3.0-realtime-plus","voice":"longanqian","baseUrl":"wss://dashscope.aliyuncs.com/api-ws/v1/realtime","runtime":null}}"#
        )
    );
}

#[test]
fn settings_get_masks_secrets_over_both_sources() {
    let gateway = Gateway::start(
        "settings-mask",
        script(json!({
            "env": { "OPENROUTER_API_KEY": "sk-1234567890abcdef" },
            "runtime": { "DASHSCOPE_API_KEY": "qwen-1234567890", "OPENAI_API_KEY": "oai" },
            "qwenRuntime": {"state": "ready"},
        })),
    );
    let body = gateway.get("/api/settings/voice").json();
    assert_eq!(body["apiKey"], json!("sk-12345****cdef"));
    assert_eq!(body["hasKey"], json!(true));
    assert_eq!(body["qwenAudio"]["hasApiKey"], json!(true));
    assert_eq!(body["qwenAudio"]["apiKey"], json!("qwen-1****7890"));
    assert_eq!(body["qwenAudio"]["runtime"], json!({"state": "ready"}));
    // The env file masks the runtime OPENAI_API_KEY from tts.hasOpenaiKey only.
    assert_eq!(body["tts"]["hasOpenaiKey"], json!(true));
}

#[test]
fn settings_post_validates_before_the_host_and_then_applies() {
    let gateway = Gateway::start("settings-post", script(json!({})));

    let invalid = gateway.post(
        "/api/settings/voice",
        &json!({ "qwenAudio": { "baseUrl": "http://example.com/x" } }),
    );
    assert_eq!(invalid.status, 400);
    assert_eq!(invalid.json()["error"], json!("request_error"));
    assert!(gateway.voice_calls().is_empty());

    let invalid = gateway.post(
        "/api/settings/voice",
        &json!({ "qwenAudio": { "model": "x".repeat(161) } }),
    );
    assert_eq!(invalid.status, 400);

    let ok = gateway.post(
        "/api/settings/voice",
        &json!({
            "apiKey": "sk-live",
            "whisperApiKey": "wk****",
            "qwenAudio": {
                "model": " qwen-model ",
                "baseUrl": "ws://localhost:8765/realtime??",
            },
        }),
    );
    assert_eq!(ok.status, 200);
    assert_eq!(ok.json(), json!({ "ok": true }));
    assert_eq!(
        gateway.voice_raw(),
        [r#"{"op":"settingsApply","updates":{"OPENROUTER_API_KEY":"sk-live","QWEN_AUDIO_REALTIME_MODEL":"qwen-model","QWEN_AUDIO_REALTIME_BASE_URL":"ws://localhost:8765/realtime"}}"#.to_string()]
    );
}

// ── asr-model ──────────────────────────────────────────────────────────────

#[test]
fn asr_model_downloads_cancels_and_refuses_unknown_actions() {
    let gateway = Gateway::start(
        "asr-model",
        script(json!({ "status": {"state": "downloading"}, "cancelled": true })),
    );
    let download = gateway.post("/api/settings/voice/asr-model", &json!({}));
    assert_eq!(download.status, 200);
    assert_eq!(
        download.json(),
        json!({ "ok": true, "status": {"state": "downloading"} })
    );

    let cancel = gateway.post(
        "/api/settings/voice/asr-model",
        &json!({ "action": "cancel" }),
    );
    assert_eq!(cancel.json()["cancelled"], json!(true));

    let unknown = gateway.post(
        "/api/settings/voice/asr-model",
        &json!({ "action": "nope" }),
    );
    assert_eq!(unknown.status, 400);
    assert_eq!(unknown.json(), json!({ "error": "未知操作: nope" }));

    assert_eq!(
        gateway.voice_raw(),
        [
            r#"{"op":"asrModelStart"}"#.to_string(),
            r#"{"op":"asrModelCancel"}"#.to_string(),
        ]
    );
}

// ── OPTIONS / HEAD / 503 / stt ─────────────────────────────────────────────

#[test]
fn options_carry_the_express_allow_lists() {
    let gateway = Gateway::start("options", script(json!({})));
    for (url, allow) in [
        ("/api/voice/refine", "POST"),
        ("/api/voice/feedback", "POST"),
        ("/api/voice/confirm", "POST"),
        ("/api/voice/progress-summary", "POST"),
        ("/api/voice/vocab", "GET,HEAD"),
        ("/api/voice/readiness", "GET,HEAD"),
        ("/api/voice/hotwords", "GET,HEAD"),
        ("/api/voice/hotwords/reject", "POST"),
        ("/api/voice/vocab/x", "DELETE"),
        ("/api/settings/voice", "GET,HEAD,POST"),
        ("/api/settings/voice/asr-model", "POST"),
        ("/api/voice/test-sse", "GET,HEAD"),
    ] {
        let response = gateway.options(url);
        assert_eq!(response.status, 200, "{url}");
        assert_eq!(response.header("allow"), Some(allow), "{url}");
        assert_eq!(response.body, allow, "{url}");
    }
}

#[test]
fn an_unreachable_host_is_503_with_the_frozen_body() {
    let gateway = Gateway::start("host-down", script(json!({ "hostDown": true })));
    for url in [
        "/api/voice/vocab",
        "/api/voice/readiness",
        "/api/voice/hotwords",
        "/api/settings/voice",
    ] {
        let response = gateway.get(url);
        assert_eq!(response.status, 503, "{url}");
        assert_eq!(
            response.json(),
            json!({
                "error": "语音接口尚未就绪，请更新原生模块",
                "code": "rust_backend_unavailable",
            }),
            "{url}"
        );
    }
}

#[test]
fn stt_and_other_methods_stay_in_node() {
    let gateway = Gateway::start("not-claimed", script(json!({})));
    // The one voice REST route Node still owns.
    gateway.post("/api/voice/stt", &json!({ "probe": true }));
    gateway.get("/api/settings/voice/asr-model");
    gateway.post("/api/voice/refine/extra", &json!({}));
    assert!(
        gateway.forwarded("POST", "/api/voice/stt"),
        "{:?}",
        gateway.fixture_requests()
    );
    assert!(gateway.forwarded("GET", "/api/settings/voice/asr-model"));
    assert!(gateway.forwarded("POST", "/api/voice/refine/extra"));
    assert!(gateway.voice_calls().is_empty());
}

// ── test-sse ───────────────────────────────────────────────────────────────

/// Decode a chunked body (the SSE route has no Content-Length). The frames are
/// ASCII, so byte slicing on the chunk boundaries is safe.
fn dechunk(raw: &str) -> String {
    let mut out = String::new();
    let mut rest = raw;
    while let Some((size_line, after)) = rest.split_once("\r\n") {
        let size = usize::from_str_radix(size_line.trim(), 16).unwrap_or(0);
        if size == 0 || size > after.len() {
            break;
        }
        out.push_str(&after[..size]);
        rest = after[size..].strip_prefix("\r\n").unwrap_or(&after[size..]);
    }
    out
}

#[test]
fn test_sse_streams_three_chunks_then_done() {
    let gateway = Gateway::start("test-sse", script(json!({})));
    let started = Instant::now();
    let response = gateway.get("/api/voice/test-sse");
    let elapsed = started.elapsed();

    assert_eq!(response.status, 200);
    assert_eq!(response.header("content-type"), Some("text/event-stream"));
    assert_eq!(response.header("cache-control"), Some("no-cache"));
    // The handler's own `Connection: keep-alive`; hyper appends `close` to it
    // because this test's request asked for `Connection: close`.
    assert!(response
        .header("connection")
        .is_some_and(|value| value.starts_with("keep-alive")));
    assert_eq!(response.header("x-accel-buffering"), Some("no"));
    assert_eq!(response.header("etag"), None);
    assert_eq!(response.header("content-length"), None);
    assert!(response
        .header("transfer-encoding")
        .is_some_and(|value| value.eq_ignore_ascii_case("chunked")));
    assert_eq!(
        dechunk(&response.body),
        "data: {\"text\":\"SSE test chunk 1\"}\n\n\
         data: {\"text\":\"SSE test chunk 2\"}\n\n\
         data: {\"text\":\"SSE test chunk 3\"}\n\n\
         data: [DONE]\n\n"
    );
    // Three 500ms ticks: the retired setInterval schedule.
    assert!(
        elapsed >= Duration::from_millis(1400),
        "stream finished in {elapsed:?}"
    );
    assert!(elapsed < Duration::from_secs(5), "stream took {elapsed:?}");

    let head = gateway.head("/api/voice/test-sse");
    assert_eq!(head.status, 200);
    assert_eq!(head.header("content-type"), Some("text/event-stream"));
    assert!(head.body.is_empty());
}
