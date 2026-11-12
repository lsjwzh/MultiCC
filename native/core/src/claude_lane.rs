//! Claude lane protocol kernel.
//!
//! This is the pure half of MultiCC's native replacement for
//! `@anthropic-ai/claude-agent-sdk` 0.3.317. It turns the option set MultiCC
//! already materializes into the exact argv/env/settings the SDK produced,
//! frames and classifies the CLI's JSONL output, and keeps the control-request
//! bookkeeping. No process, socket or filesystem access lives here; the addon
//! owns those. See `docs/claude-lane-protocol.md` for the wire contract.

use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::HashMap;

/// SDK version whose observable behaviour this kernel reproduces.
pub const SDK_VERSION: &str = "0.3.317";
/// `CLAUDE_AGENT_SDK_CLIENT_APP` is set by `src/chat/claude-sdk-config.js` today.
pub const CLIENT_APP: &str = "multicc-claude-exp/1.0";
/// Matcher callback id MultiCC registers for `UserPromptSubmit`.
pub const HOOK_CALLBACK_ID: &str = "hook_0";

// ── launch materialization ────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LaunchInput {
    pub session_id: String,
    pub resume: bool,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub agent: Option<String>,
    pub max_turns: Option<i64>,
    pub disallowed_tools: Vec<String>,
    pub mcp_servers: Option<Value>,
    pub system_prompt_append: Option<String>,
    pub settings: Value,
    pub env: Map<String, Value>,
    pub settings_path: String,
    #[serde(default = "default_true")]
    pub include_partial_messages: bool,
    pub permission_mode: Option<String>,
    pub allow_dangerously_skip_permissions: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    /// argv after the executable (and after any injected binary args).
    pub argv: Vec<String>,
    /// Ordered child environment.
    pub env: Vec<(String, String)>,
    /// Exact settings file content (JSON).
    pub settings: String,
}

fn env_string(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Null => Some(String::new()),
        Value::Bool(flag) => Some(flag.to_string()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

/// JavaScript object spread order: existing keys keep their position, later
/// writes replace the value in place.
fn set_var(env: &mut Vec<(String, String)>, key: &str, value: &str) {
    if let Some(entry) = env.iter_mut().find(|(name, _)| name == key) {
        entry.1 = value.to_string();
    } else {
        env.push((key.to_string(), value.to_string()));
    }
}

fn has_var(env: &[(String, String)], key: &str) -> bool {
    env.iter().any(|(name, _)| name == key)
}

fn remove_var(env: &mut Vec<(String, String)>, key: &str) {
    env.retain(|(name, _)| name != key);
}

fn get_var<'a>(env: &'a [(String, String)], key: &str) -> Option<&'a str> {
    env.iter()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value.as_str())
}

/// `qe`: one `key=value` token.
fn push_eq(argv: &mut Vec<String>, key: &str, value: &str) {
    argv.push(format!("{key}={value}"));
}

/// `Ny`/`G6`: two tokens unless the value looks like a flag.
fn push_pair(argv: &mut Vec<String>, key: &str, value: &str) {
    if value.len() > 1 && value.starts_with('-') {
        argv.push(format!("{key}={value}"));
    } else {
        argv.push(key.to_string());
        argv.push(value.to_string());
    }
}

fn sdk_debug_enabled(value: Option<&str>) -> bool {
    match value {
        Some(text) => text == "1" || text.eq_ignore_ascii_case("true"),
        None => false,
    }
}

/// The CLI's prompt-cache switches. Any of them already present in the
/// environment is an explicit choice and is left alone.
const PROMPT_CACHE_SWITCHES: [&str; 3] = [
    "ENABLE_PROMPT_CACHING_1H",
    "FORCE_PROMPT_CACHING_5M",
    "DISABLE_PROMPT_CACHING",
];

/// Default every chat lane to the 1-hour prompt-cache TTL.
///
/// With the CLI's 5-minute default, a turn that starts after more than five
/// idle minutes rewrites the whole cached context. Measured over seven days of
/// local sessions (2026-11-12), half of all turns started after such a gap and
/// those rewrites were about 30% of spend, most of them within the hour. A
/// 1-hour write costs 2x input instead of 1.25x, so the net estimate is roughly
/// 13% less. GLM, DeepSeek V4 Pro and DeepSeek Flash were checked live: they
/// accept the `ttl: "1h"` cache-control field and return 200.
/// To opt out, set `FORCE_PROMPT_CACHING_5M=1` (or any switch above).
fn default_prompt_cache_ttl(env: &mut Vec<(String, String)>) {
    if PROMPT_CACHE_SWITCHES.iter().any(|key| has_var(env, key)) {
        return;
    }
    set_var(env, "ENABLE_PROMPT_CACHING_1H", "1");
}

/// Reproduce `processOptions()` + the SDK transport's env mutation.
pub fn launch(input: &LaunchInput) -> Launch {
    // 1. The environment MultiCC hands to the SDK.
    let mut env: Vec<(String, String)> = input
        .env
        .iter()
        .filter_map(|(key, value)| env_string(value).map(|value| (key.clone(), value)))
        .collect();
    set_var(&mut env, "CLAUDE_AGENT_SDK_CLIENT_APP", CLIENT_APP);
    set_var(&mut env, "CLAUDE_CODE_STARTUP_FAILURE_RESULTS", "1");
    default_prompt_cache_ttl(&mut env);

    // 2. Settings file content. Credentials travel through this private file,
    // not argv, so they never show up in `ps`.
    let mut settings = match &input.settings {
        Value::Object(map) => map.clone(),
        _ => Map::new(),
    };
    let mut settings_env = match settings.get("env") {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    };
    for (key, value) in &env {
        if key.starts_with("ANTHROPIC_") || key.starts_with("CLAUDE_CODE_") {
            settings_env.insert(key.clone(), Value::String(value.clone()));
        }
    }
    settings.insert("env".to_string(), Value::Object(settings_env));
    let settings = Value::Object(settings).to_string();

    // 3. The SDK transport's own additions (after settings were built).
    if !has_var(&env, "CLAUDE_CODE_ENTRYPOINT") {
        set_var(&mut env, "CLAUDE_CODE_ENTRYPOINT", "sdk-ts");
    }
    if !has_var(&env, "CLAUDE_AGENT_SDK_VERSION") {
        set_var(&mut env, "CLAUDE_AGENT_SDK_VERSION", SDK_VERSION);
    }
    if !env
        .iter()
        .any(|(name, _)| name.to_uppercase() == "CLAUDE_CODE_SDK_READS_SESSION_STATE")
    {
        set_var(&mut env, "CLAUDE_CODE_SDK_READS_SESSION_STATE", "1");
    }
    remove_var(&mut env, "NODE_OPTIONS");
    if sdk_debug_enabled(get_var(&env, "DEBUG_CLAUDE_AGENT_SDK")) {
        set_var(&mut env, "DEBUG", "1");
    } else {
        remove_var(&mut env, "DEBUG");
    }

    // 4. argv, in the exact order the SDK emits it (captured in
    // /tmp/claude-lane-capture/logs/resident/fake-*.jsonl).
    let mut argv: Vec<String> = vec![
        "--output-format".into(),
        "stream-json".into(),
        "--verbose".into(),
        "--input-format".into(),
        "stream-json".into(),
    ];
    if let Some(effort) = input.effort.as_deref().filter(|v| !v.is_empty()) {
        push_eq(&mut argv, "--effort", effort);
    }
    if let Some(turns) = input.max_turns.filter(|turns| *turns > 0) {
        push_eq(&mut argv, "--max-turns", &turns.to_string());
    }
    if let Some(model) = input.model.as_deref().filter(|v| !v.is_empty()) {
        push_eq(&mut argv, "--model", model);
    }
    if let Some(agent) = input.agent.as_deref().filter(|v| !v.is_empty()) {
        push_eq(&mut argv, "--agent", agent);
    }
    if !input.disallowed_tools.is_empty() {
        push_eq(
            &mut argv,
            "--disallowedTools",
            &input.disallowed_tools.join(","),
        );
    }
    if let Some(Value::Object(servers)) = &input.mcp_servers {
        if !servers.is_empty() {
            push_pair(
                &mut argv,
                "--mcp-config",
                &json!({ "mcpServers": Value::Object(servers.clone()) }).to_string(),
            );
        }
    }
    if let Some(mode) = input.permission_mode.as_deref().filter(|v| !v.is_empty()) {
        push_eq(&mut argv, "--permission-mode", mode);
    }
    if input.allow_dangerously_skip_permissions {
        argv.push("--allow-dangerously-skip-permissions".into());
    }
    if input.include_partial_messages {
        argv.push("--include-partial-messages".into());
    }
    if !input.session_id.is_empty() {
        if input.resume {
            push_eq(&mut argv, "--resume", &input.session_id);
        } else {
            push_eq(&mut argv, "--session-id", &input.session_id);
        }
    }
    if !input.settings_path.is_empty() {
        push_pair(&mut argv, "--settings", &input.settings_path);
    }
    Launch {
        argv,
        env,
        settings,
    }
}

// ── request ids ──────────────────────────────────────────────────────────────

fn base36(mut value: u64) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value == 0 {
        return "0".to_string();
    }
    let mut out = Vec::new();
    while value > 0 {
        out.push(DIGITS[(value % 36) as usize]);
        value /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

/// `Math.random().toString(36).substring(2, 15)` equivalent: `[0-9a-z]`, no
/// meaning beyond opacity. The counter keeps ids unique within one process.
pub fn random_prefix() -> u64 {
    let mut bytes = [0u8; 8];
    if getrandom::fill(&mut bytes).is_err() {
        return 0x5eed_1234;
    }
    u64::from_le_bytes(bytes)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PendingKind {
    Initialize,
    Interrupt,
    SetModel,
    GetTaskOutput,
    StopTask,
}

/// Control-request bookkeeping for one resident child.
#[derive(Debug, Default)]
pub struct LaneState {
    prefix: u64,
    counter: u64,
    pending: HashMap<String, PendingKind>,
    pub initialized: bool,
    pub initialize_request: Option<String>,
}

impl LaneState {
    pub fn new(prefix: u64) -> Self {
        Self {
            prefix,
            ..Self::default()
        }
    }

    pub fn request_id(&mut self) -> String {
        self.counter += 1;
        // The odd multiplier is a bijection modulo 2^64, so distinct counters
        // stay distinct while the id looks like the SDK's ~11 opaque chars.
        let mixed = self
            .prefix
            .wrapping_add(self.counter.wrapping_mul(0x9E37_79B9_7F4A_7C15));
        base36(mixed)
    }

    pub fn register(&mut self, id: String, kind: PendingKind) -> String {
        self.pending.insert(id.clone(), kind);
        id
    }

    pub fn begin_initialize(&mut self) -> String {
        let id = self.request_id();
        self.pending.insert(id.clone(), PendingKind::Initialize);
        self.initialize_request = Some(id.clone());
        id
    }

    pub fn resolve(&mut self, id: &str) -> Option<PendingKind> {
        self.pending.remove(id)
    }

    pub fn pending(&self, id: &str) -> Option<PendingKind> {
        self.pending.get(id).copied()
    }

    pub fn mark_initialized(&mut self) {
        self.initialized = true;
        if let Some(id) = self.initialize_request.clone() {
            self.pending.remove(&id);
        }
    }

    pub fn fail_all(&mut self) -> Vec<String> {
        let mut ids: Vec<String> = self.pending.keys().cloned().collect();
        ids.sort();
        self.pending.clear();
        ids
    }
}

// ── line framing ─────────────────────────────────────────────────────────────

/// Incremental JSONL framer. Callers feed arbitrary byte chunks; complete lines
/// come back without their `\n` (and without a preceding `\r`). Incomplete
/// tails stay buffered, so a message split across pipe reads is one line.
#[derive(Debug, Default)]
pub struct LineFramer {
    buffer: Vec<u8>,
}

impl LineFramer {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.buffer.extend_from_slice(chunk);
        let mut lines = Vec::new();
        let mut start = 0usize;
        for index in 0..self.buffer.len() {
            if self.buffer[index] != b'\n' {
                continue;
            }
            let mut end = index;
            if end > start && self.buffer[end - 1] == b'\r' {
                end -= 1;
            }
            lines.push(String::from_utf8_lossy(&self.buffer[start..end]).into_owned());
            start = index + 1;
        }
        if start > 0 {
            self.buffer.drain(..start);
        }
        lines
    }

    /// Remaining bytes when the stream ends without a trailing newline.
    pub fn finish(&mut self) -> Option<String> {
        if self.buffer.is_empty() {
            return None;
        }
        let mut tail = std::mem::take(&mut self.buffer);
        if tail.last() == Some(&b'\r') {
            tail.pop();
        }
        Some(String::from_utf8_lossy(&tail).into_owned())
    }

    pub fn buffered(&self) -> usize {
        self.buffer.len()
    }
}

// ── line classification ──────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub struct ControlResponse {
    pub request_id: String,
    pub success: bool,
    pub payload: Value,
    pub error: Option<String>,
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct HookCallback {
    pub request_id: String,
    pub callback_id: String,
    pub input: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Classified {
    /// Whitespace-only line; every side skips it.
    Blank,
    /// Answer to one of our control requests.
    ControlResponse(ControlResponse),
    /// CLI asking us to run a host hook.
    HookCallback(HookCallback),
    /// CLI cancelling an in-flight hook callback.
    ControlCancel { request_id: String },
    /// A control request MultiCC does not implement; the lane answers with an
    /// error response, exactly like the SDK.
    UnknownControlRequest { request_id: String, subtype: String },
    /// Swallowed heartbeat.
    KeepAlive { startup_mark: Option<String> },
    /// Swallowed `transcript_mirror` / host-only session state.
    Swallowed,
    /// Everything else, as the original line text. JS parses this once.
    Stream(String),
}

fn as_str(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str)
}

/// Classify one CLI output line. A line that is not JSON is a fatal protocol
/// error (the SDK's reader also terminates on it).
pub fn classify_line(line: &str) -> Result<Classified, String> {
    if line.trim().is_empty() {
        return Ok(Classified::Blank);
    }
    let value: Value = crate::json_lenient::from_str(line)
        .map_err(|error| format!("Claude Code emitted invalid JSON: {error}"))?;
    let Value::Object(object) = &value else {
        return Ok(Classified::Stream(line.to_string()));
    };
    let kind = object.get("type").and_then(Value::as_str).unwrap_or("");
    match kind {
        "control_response" => {
            let Some(Value::Object(response)) = object.get("response") else {
                return Ok(Classified::Swallowed);
            };
            let Some(request_id) = as_str(response.get("request_id")) else {
                return Ok(Classified::Swallowed);
            };
            let subtype = as_str(response.get("subtype")).unwrap_or("");
            Ok(Classified::ControlResponse(ControlResponse {
                request_id: request_id.to_string(),
                success: subtype == "success",
                payload: response
                    .get("response")
                    .cloned()
                    .unwrap_or_else(|| json!({})),
                error: as_str(response.get("error")).map(str::to_string),
                error_code: as_str(response.get("error_code")).map(str::to_string),
            }))
        }
        "control_request" => {
            let Some(request_id) = as_str(object.get("request_id")) else {
                return Ok(Classified::Swallowed);
            };
            let Some(Value::Object(request)) = object.get("request") else {
                return Ok(Classified::UnknownControlRequest {
                    request_id: request_id.to_string(),
                    subtype: String::new(),
                });
            };
            let subtype = as_str(request.get("subtype")).unwrap_or("");
            if subtype == "hook_callback" {
                Ok(Classified::HookCallback(HookCallback {
                    request_id: request_id.to_string(),
                    callback_id: as_str(request.get("callback_id"))
                        .unwrap_or_default()
                        .to_string(),
                    input: request.get("input").cloned().unwrap_or_else(|| json!({})),
                }))
            } else {
                Ok(Classified::UnknownControlRequest {
                    request_id: request_id.to_string(),
                    subtype: subtype.to_string(),
                })
            }
        }
        "control_cancel_request" => Ok(Classified::ControlCancel {
            request_id: as_str(object.get("request_id"))
                .unwrap_or_default()
                .to_string(),
        }),
        "keep_alive" => Ok(Classified::KeepAlive {
            startup_mark: as_str(object.get("startup_mark"))
                .filter(|mark| mark.len() <= 64)
                .map(str::to_string),
        }),
        "transcript_mirror" => Ok(Classified::Swallowed),
        "system"
            if object.get("subtype").and_then(Value::as_str) == Some("session_state_changed")
                && object.get("sdk_host_only").and_then(Value::as_bool) == Some(true) =>
        {
            Ok(Classified::Swallowed)
        }
        _ => Ok(Classified::Stream(line.to_string())),
    }
}

/// The SDK writes `JSON.stringify(x) + "\n"`; mirror that framing.
pub fn frame_line(line: &str) -> String {
    let mut out = String::with_capacity(line.len() + 1);
    out.push_str(line);
    out.push('\n');
    out
}

// ── control request builders ─────────────────────────────────────────────────

pub fn initialize_line(
    request_id: &str,
    hook_callback: bool,
    append_system_prompt: Option<&str>,
) -> String {
    let mut request = Map::new();
    request.insert("subtype".into(), json!("initialize"));
    if hook_callback {
        request.insert(
            "hooks".into(),
            json!({ "UserPromptSubmit": [{ "hookCallbackIds": [HOOK_CALLBACK_ID] }] }),
        );
    }
    match append_system_prompt {
        Some(text) => request.insert("appendSystemPrompt".into(), json!(text)),
        None => request.insert("systemPrompt".into(), json!([""])),
    };
    json!({
        "request_id": request_id,
        "type": "control_request",
        "request": request,
    })
    .to_string()
}

pub fn interrupt_line(request_id: &str, cancel_queued: bool) -> String {
    json!({
        "request_id": request_id,
        "type": "control_request",
        "request": { "subtype": "interrupt", "cancel_queued": cancel_queued },
    })
    .to_string()
}

pub fn set_model_line(request_id: &str, model: Option<&str>) -> String {
    let mut request = Map::new();
    request.insert("subtype".into(), json!("set_model"));
    if let Some(model) = model.filter(|model| !model.is_empty()) {
        request.insert("model".into(), json!(model));
    }
    json!({
        "request_id": request_id,
        "type": "control_request",
        "request": request,
    })
    .to_string()
}

pub fn get_task_output_line(request_id: &str, task_id: &str) -> String {
    json!({
        "request_id": request_id,
        "type": "control_request",
        "request": { "subtype": "get_task_output", "task_id": task_id },
    })
    .to_string()
}

pub fn stop_task_line(request_id: &str, task_id: &str) -> String {
    json!({
        "request_id": request_id,
        "type": "control_request",
        "request": { "subtype": "stop_task", "task_id": task_id },
    })
    .to_string()
}

pub fn control_response_line(request_id: &str, payload: &Value) -> String {
    json!({
        "type": "control_response",
        "response": {
            "subtype": "success",
            "request_id": request_id,
            "response": payload,
        },
    })
    .to_string()
}

pub fn control_response_error_line(
    request_id: &str,
    message: &str,
    error_code: Option<&str>,
) -> String {
    let mut response = Map::new();
    response.insert("subtype".into(), json!("error"));
    response.insert("request_id".into(), json!(request_id));
    response.insert("error".into(), json!(message));
    if let Some(code) = error_code.filter(|code| valid_error_code(code)) {
        response.insert("error_code".into(), json!(code));
    }
    json!({ "type": "control_response", "response": response }).to_string()
}

/// The SDK only turns `error_code` into `Error.code` when it matches this.
fn valid_error_code(code: &str) -> bool {
    let bytes = code.as_bytes();
    if bytes.is_empty() || bytes.len() > 64 {
        return false;
    }
    if !bytes[0].is_ascii_lowercase() {
        return false;
    }
    bytes
        .iter()
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'_')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn launch_input() -> LaunchInput {
        let env: Map<String, Value> = serde_json::from_value(json!({
            "PATH": "/usr/bin",
            "HOME": "/tmp/home",
            "TMPDIR": "/tmp",
            "CLAUDE_CONFIG_DIR": "/tmp/claude",
            "ANTHROPIC_BASE_URL": "http://127.0.0.1:9",
            "ANTHROPIC_AUTH_TOKEN": "secret-token",
            "ANTHROPIC_API_KEY": "",
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
            "NODE_OPTIONS": "--max-old-space-size=4096",
            "DEBUG": "1",
        }))
        .unwrap();
        LaunchInput {
            session_id: "853caea9-a074-4b21-929b-f7ef15395852".into(),
            resume: false,
            model: Some("claude-sonnet-4-6".into()),
            effort: Some("high".into()),
            agent: Some("general-purpose".into()),
            max_turns: Some(4),
            disallowed_tools: vec!["WebSearch".into(), "WebFetch".into()],
            mcp_servers: Some(json!({
                "multicc_router": { "command": "/opt/node", "args": ["/opt/router.mjs"] }
            })),
            system_prompt_append: Some("APPENDED".into()),
            settings: json!({}),
            env,
            settings_path: "/tmp/multicc-sdk-X/settings.json".into(),
            include_partial_messages: true,
            permission_mode: Some("bypassPermissions".into()),
            allow_dangerously_skip_permissions: true,
        }
    }

    #[test]
    fn argv_matches_captured_resident_invocation() {
        let launch = launch(&launch_input());
        assert_eq!(launch.argv, vec![
            "--output-format", "stream-json",
            "--verbose",
            "--input-format", "stream-json",
            "--effort=high",
            "--max-turns=4",
            "--model=claude-sonnet-4-6",
            "--agent=general-purpose",
            "--disallowedTools=WebSearch,WebFetch",
            "--mcp-config",
            "{\"mcpServers\":{\"multicc_router\":{\"command\":\"/opt/node\",\"args\":[\"/opt/router.mjs\"]}}}",
            "--permission-mode=bypassPermissions",
            "--allow-dangerously-skip-permissions",
            "--include-partial-messages",
            "--session-id=853caea9-a074-4b21-929b-f7ef15395852",
            "--settings", "/tmp/multicc-sdk-X/settings.json",
        ]);
    }

    #[test]
    fn resume_swaps_only_the_identity_token() {
        let fresh = launch(&launch_input());
        let mut input = launch_input();
        input.resume = true;
        let resumed = launch(&input);
        assert_eq!(
            resumed.argv,
            fresh
                .argv
                .iter()
                .map(
                    |token| if token == "--session-id=853caea9-a074-4b21-929b-f7ef15395852" {
                        "--resume=853caea9-a074-4b21-929b-f7ef15395852".to_string()
                    } else {
                        token.clone()
                    }
                )
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn settings_file_matches_captured_content_and_omits_sdk_vars() {
        let launch = launch(&launch_input());
        let settings: Value = serde_json::from_str(&launch.settings).unwrap();
        assert_eq!(
            settings,
            json!({ "env": {
                "ANTHROPIC_BASE_URL": "http://127.0.0.1:9",
                "ANTHROPIC_AUTH_TOKEN": "secret-token",
                "ANTHROPIC_API_KEY": "",
                "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
                "CLAUDE_CODE_STARTUP_FAILURE_RESULTS": "1",
            }})
        );
        assert!(!launch.settings.contains("CLAUDE_CODE_ENTRYPOINT"));
        assert!(!launch.settings.contains("CLAUDE_AGENT_SDK_CLIENT_APP"));
    }

    #[test]
    fn child_env_matches_sdk_transport_rules() {
        let launch = launch(&launch_input());
        let env: HashMap<String, String> = launch.env.iter().cloned().collect();
        assert_eq!(env.get("CLAUDE_CODE_ENTRYPOINT").unwrap(), "sdk-ts");
        assert_eq!(env.get("CLAUDE_AGENT_SDK_VERSION").unwrap(), SDK_VERSION);
        assert_eq!(env.get("CLAUDE_CODE_SDK_READS_SESSION_STATE").unwrap(), "1");
        assert_eq!(env.get("CLAUDE_AGENT_SDK_CLIENT_APP").unwrap(), CLIENT_APP);
        assert_eq!(env.get("CLAUDE_CODE_STARTUP_FAILURE_RESULTS").unwrap(), "1");
        assert!(!env.contains_key("NODE_OPTIONS"));
        assert!(
            !env.contains_key("DEBUG"),
            "DEBUG is dropped without DEBUG_CLAUDE_AGENT_SDK"
        );
        assert_eq!(env.get("ANTHROPIC_AUTH_TOKEN").unwrap(), "secret-token");
    }

    #[test]
    fn prompt_cache_defaults_to_one_hour_ttl() {
        let env: HashMap<String, String> = launch(&launch_input()).env.into_iter().collect();
        assert_eq!(env.get("ENABLE_PROMPT_CACHING_1H").unwrap(), "1");
    }

    #[test]
    fn an_explicit_prompt_cache_switch_is_left_alone() {
        for key in PROMPT_CACHE_SWITCHES {
            let mut input = launch_input();
            input.env.insert(key.into(), json!("0"));
            let env: HashMap<String, String> = launch(&input).env.into_iter().collect();
            assert_eq!(env.get(key).unwrap(), "0", "{key} keeps its value");
            if key != "ENABLE_PROMPT_CACHING_1H" {
                assert!(
                    !env.contains_key("ENABLE_PROMPT_CACHING_1H"),
                    "{key} opts out of the 1h default"
                );
            }
        }
    }

    #[test]
    fn debug_is_forced_back_when_the_sdk_debug_flag_is_set() {
        let mut input = launch_input();
        input
            .env
            .insert("DEBUG_CLAUDE_AGENT_SDK".into(), json!("1"));
        let env: HashMap<String, String> = launch(&input).env.into_iter().collect();
        assert_eq!(env.get("DEBUG").unwrap(), "1");
    }

    #[test]
    fn settings_base_object_keeps_its_keys_and_merges_env() {
        let mut input = launch_input();
        input.settings = json!({ "ultracode": true, "env": { "KEEP": "1" } });
        let settings: Value = serde_json::from_str(&launch(&input).settings).unwrap();
        assert_eq!(settings["ultracode"], json!(true));
        assert_eq!(settings["env"]["KEEP"], json!("1"));
        assert_eq!(
            settings["env"]["ANTHROPIC_AUTH_TOKEN"],
            json!("secret-token")
        );
    }

    #[test]
    fn a_value_starting_with_dash_uses_one_token() {
        let mut input = launch_input();
        input.model = Some("-leading".into());
        let argv = launch(&input).argv;
        assert!(argv.contains(&"--model=-leading".to_string()));
        assert!(!argv.contains(&"--model".to_string()));
    }

    #[test]
    fn framer_joins_partial_lines_and_strips_crlf() {
        let mut framer = LineFramer::new();
        assert!(framer.push(br#"{"type":"assi"#).is_empty());
        let lines = framer.push(b"stant\"}\r\n{\"type\":\"result\"}\npartial");
        assert_eq!(
            lines,
            vec!["{\"type\":\"assistant\"}", "{\"type\":\"result\"}"]
        );
        assert_eq!(framer.finish().as_deref(), Some("partial"));
    }

    #[test]
    fn framer_handles_multibyte_characters_split_across_chunks() {
        let text = "{\"type\":\"assistant\",\"message\":\"好\"}\n";
        let bytes = text.as_bytes();
        let mut framer = LineFramer::new();
        let mut out = framer.push(&bytes[..bytes.len() - 4]);
        out.extend(framer.push(&bytes[bytes.len() - 4..]));
        assert_eq!(out, vec![text.trim_end()]);
    }

    #[test]
    fn framer_handles_lines_over_one_megabyte() {
        let payload = "x".repeat(1024 * 1024 + 7);
        let line = format!("{{\"type\":\"system\",\"subtype\":\"blob\",\"text\":\"{payload}\"}}");
        let mut framer = LineFramer::new();
        let mut lines = Vec::new();
        for chunk in line.as_bytes().chunks(7777) {
            lines.extend(framer.push(chunk));
        }
        lines.extend(framer.push(b"\n"));
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].len(), line.len());
    }

    #[test]
    fn classify_control_response_success_and_error() {
        let success = classify_line(
            r#"{"type":"control_response","response":{"subtype":"success","request_id":"a1","response":{"ok":1}}}"#,
        )
        .unwrap();
        assert_eq!(
            success,
            Classified::ControlResponse(ControlResponse {
                request_id: "a1".into(),
                success: true,
                payload: json!({"ok":1}),
                error: None,
                error_code: None,
            })
        );
        let error = classify_line(
            r#"{"type":"control_response","response":{"subtype":"error","request_id":"a2","error":"boom","error_code":"bad_thing"}}"#,
        )
        .unwrap();
        assert_eq!(
            error,
            Classified::ControlResponse(ControlResponse {
                request_id: "a2".into(),
                success: false,
                payload: json!({}),
                error: Some("boom".into()),
                error_code: Some("bad_thing".into()),
            })
        );
    }

    #[test]
    fn classify_hook_callback_and_cancel() {
        let line = r#"{"type":"control_request","request_id":"r1","request":{"subtype":"hook_callback","callback_id":"hook_0","input":{"hook_event_name":"UserPromptSubmit","prompt":"hi"}}}"#;
        assert_eq!(
            classify_line(line).unwrap(),
            Classified::HookCallback(HookCallback {
                request_id: "r1".into(),
                callback_id: "hook_0".into(),
                input: json!({"hook_event_name":"UserPromptSubmit","prompt":"hi"}),
            })
        );
        assert_eq!(
            classify_line(r#"{"type":"control_cancel_request","request_id":"r1"}"#).unwrap(),
            Classified::ControlCancel {
                request_id: "r1".into()
            }
        );
    }

    #[test]
    fn classify_unknown_control_request_is_reported_not_passed_through() {
        let line =
            r#"{"type":"control_request","request_id":"r9","request":{"subtype":"can_use_tool"}}"#;
        assert_eq!(
            classify_line(line).unwrap(),
            Classified::UnknownControlRequest {
                request_id: "r9".into(),
                subtype: "can_use_tool".into(),
            }
        );
    }

    #[test]
    fn keep_alive_and_transcript_mirror_are_swallowed() {
        assert_eq!(
            classify_line(r#"{"type":"keep_alive","startup_mark":"abc"}"#).unwrap(),
            Classified::KeepAlive {
                startup_mark: Some("abc".into())
            }
        );
        assert_eq!(
            classify_line(r#"{"type":"transcript_mirror","filePath":"x"}"#).unwrap(),
            Classified::Swallowed
        );
        assert_eq!(
            classify_line(
                r#"{"type":"system","subtype":"session_state_changed","sdk_host_only":true}"#
            )
            .unwrap(),
            Classified::Swallowed
        );
    }

    #[test]
    fn unknown_types_and_arrays_pass_through_as_original_text() {
        let line = r#"{"type":"mystery","extra":1}"#;
        assert_eq!(
            classify_line(line).unwrap(),
            Classified::Stream(line.into())
        );
        let array = "[1,2]";
        assert_eq!(
            classify_line(array).unwrap(),
            Classified::Stream(array.into())
        );
    }

    #[test]
    fn blank_lines_are_skipped() {
        assert_eq!(classify_line("").unwrap(), Classified::Blank);
        assert_eq!(classify_line(" \r").unwrap(), Classified::Blank);
    }

    #[test]
    fn invalid_json_is_fatal() {
        assert!(classify_line("{not json").is_err());
    }

    #[test]
    fn lone_surrogate_escapes_are_accepted() {
        let line = r#"{"type":"assistant","message":{"text":"\ud800"}}"#;
        match classify_line(line).unwrap() {
            Classified::Stream(text) => assert_eq!(text, line),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn request_ids_are_unique_and_opaque() {
        let mut state = LaneState::new(12345);
        let first = state.request_id();
        let second = state.request_id();
        assert_ne!(first, second);
        assert!(first
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()));
        assert!(first.len() >= 6);
    }

    #[test]
    fn state_tracks_initialize_and_pending_controls() {
        let mut state = LaneState::new(7);
        let initialize = state.begin_initialize();
        assert_eq!(state.pending(&initialize), Some(PendingKind::Initialize));
        assert!(!state.initialized);
        state.mark_initialized();
        assert!(state.initialized);
        assert_eq!(state.pending(&initialize), None);

        let interrupt = state.request_id();
        state.register(interrupt.clone(), PendingKind::Interrupt);
        assert_eq!(state.resolve(&interrupt), Some(PendingKind::Interrupt));
        assert_eq!(state.resolve(&interrupt), None);

        let model = state.request_id();
        state.register(model, PendingKind::SetModel);
        let stop = state.request_id();
        state.register(stop, PendingKind::StopTask);
        assert_eq!(state.fail_all().len(), 2);
        assert!(state.fail_all().is_empty());
    }

    #[test]
    fn initialize_with_hooks_and_append_matches_capture_shape() {
        let line = initialize_line("abc", true, Some("APPENDED_SYSTEM_PROMPT_SENTINEL"));
        let value: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(value["type"], json!("control_request"));
        assert_eq!(value["request"]["subtype"], json!("initialize"));
        assert_eq!(
            value["request"]["hooks"]["UserPromptSubmit"][0]["hookCallbackIds"][0],
            json!("hook_0")
        );
        assert_eq!(
            value["request"]["appendSystemPrompt"],
            json!("APPENDED_SYSTEM_PROMPT_SENTINEL")
        );
        assert!(value["request"].get("systemPrompt").is_none());
    }

    #[test]
    fn initialize_without_append_sends_the_empty_system_prompt_array() {
        let value: Value = serde_json::from_str(&initialize_line("abc", true, None)).unwrap();
        assert_eq!(value["request"]["systemPrompt"], json!([""]));
        assert!(value["request"].get("appendSystemPrompt").is_none());
        let no_hooks: Value = serde_json::from_str(&initialize_line("abc", false, None)).unwrap();
        assert!(no_hooks["request"].get("hooks").is_none());
    }

    #[test]
    fn control_builders_match_the_sdk_envelopes() {
        let interrupt: Value = serde_json::from_str(&interrupt_line("i1", true)).unwrap();
        assert_eq!(interrupt["request"]["subtype"], json!("interrupt"));
        assert_eq!(interrupt["request"]["cancel_queued"], json!(true));
        let model: Value =
            serde_json::from_str(&set_model_line("m1", Some("claude-opus-4-6"))).unwrap();
        assert_eq!(model["request"]["subtype"], json!("set_model"));
        assert_eq!(model["request"]["model"], json!("claude-opus-4-6"));
        let task: Value = serde_json::from_str(&get_task_output_line("t1", "task-1")).unwrap();
        assert_eq!(task["request"]["task_id"], json!("task-1"));
        let stop: Value = serde_json::from_str(&stop_task_line("s1", "task-1")).unwrap();
        assert_eq!(stop["request"]["subtype"], json!("stop_task"));
    }

    #[test]
    fn control_responses_carry_payload_and_only_valid_error_codes() {
        let success: Value =
            serde_json::from_str(&control_response_line("h1", &json!({"decision":"block"})))
                .unwrap();
        assert_eq!(success["response"]["subtype"], json!("success"));
        assert_eq!(success["response"]["request_id"], json!("h1"));
        assert_eq!(success["response"]["response"]["decision"], json!("block"));
        let error: Value =
            serde_json::from_str(&control_response_error_line("h2", "boom", Some("Bad-Code")))
                .unwrap();
        assert_eq!(error["response"]["error"], json!("boom"));
        assert!(error["response"].get("error_code").is_none());
        let coded: Value =
            serde_json::from_str(&control_response_error_line("h3", "boom", Some("bad_code")))
                .unwrap();
        assert_eq!(coded["response"]["error_code"], json!("bad_code"));
    }

    #[test]
    fn launch_omits_empty_optional_fields() {
        let mut input = launch_input();
        input.model = None;
        input.effort = None;
        input.agent = None;
        input.max_turns = None;
        input.disallowed_tools.clear();
        input.mcp_servers = None;
        input.permission_mode = None;
        input.allow_dangerously_skip_permissions = false;
        input.include_partial_messages = false;
        input.settings_path.clear();
        assert_eq!(
            launch(&input).argv,
            vec![
                "--output-format",
                "stream-json",
                "--verbose",
                "--input-format",
                "stream-json",
                "--session-id=853caea9-a074-4b21-929b-f7ef15395852",
            ]
        );
    }
}
