//! Antigravity (`agy`) `--output-format stream-json` 协议内核。
//!
//! 职责单一：
//! 1. 构造 `agy` 的命令行参数与首轮 `[Role prompt]` 载荷（`--output-format stream-json`、
//!    `--dangerously-skip-permissions`、`--model`、`--effort`、`--conversation`，以及必须置于
//!    最末的 `-p`，由宿主把 prompt 拼作紧随 `-p` 之后的参数）。
//! 2. 维护按 `conversation_id` 隔离的每轮状态机，解码 `init` / `step_update` / `result`
//!    NDJSON 事件，并在每个 `agent_response` `DONE` 步骤产出实时累加的 `live_usage` 事件。
//! 3. 避免第 2 轮及以后误用会话级累计的 `result.usage`：本轮累计仅由本轮的 `step_update`
//!    （按 `step_index` 去重）相加得出，只有在 `requests == 0 && num_turns <= 1` 时才回落到
//!    `result.usage`。
//! 4. 幂等、非破坏性地把 `multicc_router` 写入目标 `HOME/.gemini/config/mcp_config.json`
//!    （不落盘任何敏感凭证——`agy` 会把进程环境里的 `MULTICC_*` 直接透传给 stdio MCP 子进程）。

use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::Path;

const MAX_TRACKED_CONVERSATIONS: usize = 64;
const AGY_LABEL: &str = "Antigravity";
const USAGE_SOURCE: &str = "agy_stream";

#[derive(Debug, Clone, Default)]
pub struct InvocationInput {
    pub cmd: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub conversation_id: Option<String>,
    pub is_first_turn: bool,
    pub role_prompt: Option<String>,
    pub prompt: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvocationOutput {
    pub cmd: String,
    pub args: Vec<String>,
    pub payload: String,
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|s| !s.is_empty())
}

/// 构造 `agy --output-format stream-json` 的调用参数与 prompt 载荷。
pub fn build_invocation(input: &InvocationInput) -> InvocationOutput {
    let mut args = vec![
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--dangerously-skip-permissions".to_string(),
    ];
    if let Some(model) = non_empty(input.model.as_deref()) {
        args.push("--model".to_string());
        args.push(model.to_string());
    }
    if let Some(effort) = non_empty(input.effort.as_deref()) {
        args.push("--effort".to_string());
        args.push(effort.to_string());
    }
    if !input.is_first_turn {
        if let Some(conversation_id) = non_empty(input.conversation_id.as_deref()) {
            args.push("--conversation".to_string());
            args.push(conversation_id.to_string());
        }
    }
    // `-p` 会把紧随其后的单个 argv 当作 prompt，因此必须作为最后一个选项。
    args.push("-p".to_string());

    let payload = match (input.is_first_turn, non_empty(input.role_prompt.as_deref())) {
        (true, Some(role)) => format!(
            "[Role prompt]\n{}\n[End of role prompt]\n\n{}",
            role, input.prompt
        ),
        _ => input.prompt.clone(),
    };

    InvocationOutput {
        cmd: input.cmd.clone(),
        args,
        payload,
    }
}

/// 幂等写入 `<home>/.gemini/config/mcp_config.json` 中的 `mcpServers.multicc_router`。
///
/// - 保留文件中用户已有的其它配置与 MCP server。
/// - 文件不存在或仅包含空白时按空对象初始化。
/// - 文件非空但 JSON 损坏时放弃写入并返回 `Ok(false)`，避免破坏用户配置。
/// - 若目标条目已经完全一致则跳过写盘并返回 `Ok(false)`。
pub fn ensure_router_mcp(home_dir: &Path, node: &str, script: &str) -> Result<bool, String> {
    if home_dir.as_os_str().is_empty() || node.trim().is_empty() || script.trim().is_empty() {
        return Ok(false);
    }
    let config_dir = home_dir.join(".gemini").join("config");
    let config_path = config_dir.join("mcp_config.json");

    let mut root = if config_path.exists() {
        let raw = fs::read_to_string(&config_path)
            .map_err(|err| format!("read mcp_config.json failed: {err}"))?;
        if raw.trim().is_empty() {
            Map::new()
        } else {
            match serde_json::from_str::<Value>(&raw) {
                Ok(Value::Object(map)) => map,
                _ => return Ok(false),
            }
        }
    } else {
        Map::new()
    };

    let desired = json!({
        "command": node,
        "args": [script],
    });

    let servers = match root.get_mut("mcpServers") {
        Some(Value::Object(map)) => map,
        Some(_) => return Ok(false),
        None => {
            root.insert("mcpServers".to_string(), Value::Object(Map::new()));
            match root.get_mut("mcpServers") {
                Some(Value::Object(map)) => map,
                _ => return Ok(false),
            }
        }
    };

    if servers.get("multicc_router") == Some(&desired) {
        return Ok(false);
    }
    servers.insert("multicc_router".to_string(), desired);

    fs::create_dir_all(&config_dir)
        .map_err(|err| format!("create .gemini/config dir failed: {err}"))?;
    let serialized = serde_json::to_string_pretty(&Value::Object(root))
        .map_err(|err| format!("serialize mcp_config.json failed: {err}"))?;
    fs::write(&config_path, format!("{serialized}\n"))
        .map_err(|err| format!("write mcp_config.json failed: {err}"))?;
    Ok(true)
}

#[derive(Debug, Default, Clone)]
struct StepUsage {
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_creation_tokens: u64,
    thinking_tokens: u64,
}

impl StepUsage {
    fn from_value(value: &Value) -> Option<Self> {
        let obj = value.as_object()?;
        let input_tokens = read_u64(obj, &["input_tokens", "inputTokens"]);
        let output_tokens = read_u64(obj, &["output_tokens", "outputTokens"]);
        let cache_read_tokens = read_u64(
            obj,
            &[
                "cache_read_tokens",
                "cache_read_input_tokens",
                "cached_input_tokens",
                "cachedReadTokens",
            ],
        );
        let cache_creation_tokens = read_u64(
            obj,
            &[
                "cache_creation_tokens",
                "cache_creation_input_tokens",
                "cachedWriteTokens",
            ],
        );
        let thinking_tokens = read_u64(
            obj,
            &[
                "thinking_tokens",
                "reasoning_output_tokens",
                "thought_tokens",
                "thinkingTokens",
            ],
        );
        if input_tokens == 0
            && output_tokens == 0
            && cache_read_tokens == 0
            && cache_creation_tokens == 0
            && thinking_tokens == 0
        {
            return None;
        }
        Some(Self {
            input_tokens,
            output_tokens,
            cache_read_tokens,
            cache_creation_tokens,
            thinking_tokens,
        })
    }

    fn context_tokens(&self) -> u64 {
        self.input_tokens
            .saturating_add(self.cache_read_tokens)
            .saturating_add(self.cache_creation_tokens)
    }

    fn to_step_json(&self) -> Value {
        let mut obj = Map::new();
        obj.insert("input_tokens".to_string(), json!(self.input_tokens));
        obj.insert("output_tokens".to_string(), json!(self.output_tokens));
        obj.insert(
            "cache_read_input_tokens".to_string(),
            json!(self.cache_read_tokens),
        );
        obj.insert(
            "cache_creation_input_tokens".to_string(),
            json!(self.cache_creation_tokens),
        );
        if self.thinking_tokens > 0 {
            obj.insert(
                "reasoning_output_tokens".to_string(),
                json!(self.thinking_tokens),
            );
        }
        let ctx = self.context_tokens();
        if ctx > 0 {
            obj.insert("context_tokens".to_string(), json!(ctx));
        }
        Value::Object(obj)
    }
}

#[derive(Debug, Default)]
struct TurnAccumulator {
    seen_steps: HashSet<u64>,
    thoughts: HashMap<String, String>,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_creation_tokens: u64,
    thinking_tokens: u64,
    last_context_tokens: u64,
    requests: u64,
}

impl TurnAccumulator {
    fn add_step(&mut self, step_index: Option<u64>, usage: &StepUsage) -> bool {
        if let Some(idx) = step_index {
            if !self.seen_steps.insert(idx) {
                return false;
            }
        }
        self.input_tokens = self.input_tokens.saturating_add(usage.input_tokens);
        self.output_tokens = self.output_tokens.saturating_add(usage.output_tokens);
        self.cache_read_tokens = self
            .cache_read_tokens
            .saturating_add(usage.cache_read_tokens);
        self.cache_creation_tokens = self
            .cache_creation_tokens
            .saturating_add(usage.cache_creation_tokens);
        self.thinking_tokens = self.thinking_tokens.saturating_add(usage.thinking_tokens);
        let ctx = usage.context_tokens();
        if ctx > 0 {
            self.last_context_tokens = ctx;
        }
        self.requests = self.requests.saturating_add(1);
        true
    }

    fn cumulative_usage_json(&self) -> Value {
        let total = self
            .input_tokens
            .saturating_add(self.cache_read_tokens)
            .saturating_add(self.cache_creation_tokens)
            .saturating_add(self.output_tokens);
        let mut obj = Map::new();
        obj.insert("input_tokens".to_string(), json!(self.input_tokens));
        obj.insert("output_tokens".to_string(), json!(self.output_tokens));
        obj.insert(
            "cache_read_input_tokens".to_string(),
            json!(self.cache_read_tokens),
        );
        obj.insert(
            "cache_creation_input_tokens".to_string(),
            json!(self.cache_creation_tokens),
        );
        if self.thinking_tokens > 0 {
            obj.insert(
                "reasoning_output_tokens".to_string(),
                json!(self.thinking_tokens),
            );
        }
        obj.insert("total_tokens".to_string(), json!(total));
        if self.last_context_tokens > 0 {
            obj.insert(
                "context_tokens".to_string(),
                json!(self.last_context_tokens),
            );
        }
        obj.insert("usage_source".to_string(), json!(USAGE_SOURCE));
        Value::Object(obj)
    }

    fn role_main_json(&self) -> Value {
        json!({
            "inputTokens": self.input_tokens,
            "outputTokens": self.output_tokens,
            "cacheRead": self.cache_read_tokens,
            "cacheWrite": self.cache_creation_tokens,
        })
    }
}

/// 按 `conversation_id` 隔离的 `agy --output-format stream-json` 解码器。
#[derive(Debug, Default)]
pub struct AgyStreamDecoder {
    turns: HashMap<String, TurnAccumulator>,
    order: VecDeque<String>,
}

impl AgyStreamDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    fn reset_turn(&mut self, key: &str) {
        self.turns
            .insert(key.to_string(), TurnAccumulator::default());
        self.order.retain(|existing| existing != key);
        self.order.push_back(key.to_string());
        while self.turns.len() > MAX_TRACKED_CONVERSATIONS {
            if let Some(oldest) = self.order.pop_front() {
                self.turns.remove(&oldest);
            } else {
                break;
            }
        }
    }

    fn turn_mut(&mut self, key: &str) -> &mut TurnAccumulator {
        if !self.turns.contains_key(key) {
            self.reset_turn(key);
        }
        self.turns
            .get_mut(key)
            .expect("turn accumulator inserted above")
    }

    fn take_turn(&mut self, key: &str) -> Option<TurnAccumulator> {
        self.order.retain(|existing| existing != key);
        self.turns.remove(key)
    }

    pub fn decode(&mut self, raw: &Value) -> Vec<Value> {
        let Some(obj) = raw.as_object() else {
            return Vec::new();
        };
        let Some(event) = obj.get("event").and_then(Value::as_str) else {
            return Vec::new();
        };

        match event {
            "init" => self.decode_init(obj),
            "step_update" => self.decode_step_update(obj),
            "result" => self.decode_result(obj),
            _ => Vec::new(),
        }
    }

    fn decode_init(&mut self, obj: &Map<String, Value>) -> Vec<Value> {
        let conv_id = obj
            .get("conversation_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let key = conv_id.unwrap_or("_default_");
        self.reset_turn(key);

        let mut out = Vec::new();
        if let Some(id) = conv_id {
            out.push(json!({
                "type": "session_started",
                "sessionId": id,
            }));
        }
        out.push(json!({
            "type": "status",
            "status": "thinking",
        }));
        out
    }

    fn decode_step_update(&mut self, obj: &Map<String, Value>) -> Vec<Value> {
        let Some(step) = obj.get("step_update").and_then(Value::as_object) else {
            return Vec::new();
        };
        let conv_key = step
            .get("conversation_id")
            .and_then(Value::as_str)
            .or_else(|| obj.get("conversation_id").and_then(Value::as_str))
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("_default_");

        let step_type = step.get("step_type").and_then(Value::as_str).unwrap_or("");
        let state = step.get("state").and_then(Value::as_str).unwrap_or("");
        let step_index = step.get("step_index").and_then(Value::as_u64);

        match step_type {
            "tool" => self.decode_tool_step(step, state, step_index),
            "agent_response" => self.decode_agent_response(conv_key, step, state, step_index),
            _ => Vec::new(),
        }
    }

    fn decode_tool_step(
        &self,
        step: &Map<String, Value>,
        state: &str,
        step_index: Option<u64>,
    ) -> Vec<Value> {
        let tool_info = step.get("tool_info").and_then(Value::as_object);
        let name = step
            .get("tool_name")
            .and_then(Value::as_str)
            .or_else(|| {
                tool_info
                    .and_then(|info| info.get("name"))
                    .and_then(Value::as_str)
            })
            .filter(|s| !s.is_empty())
            .unwrap_or("tool");
        let id = match step_index {
            Some(idx) => format!("agy_step_{idx}"),
            None => format!("agy_tool_{name}"),
        };
        let input = tool_info
            .and_then(|info| info.get("parameters"))
            .filter(|v| v.is_object())
            .cloned()
            .unwrap_or_else(|| json!({}));
        let current_file = extract_current_file(&input);

        let completed = !matches!(state, "ACTIVE" | "PENDING" | "RUNNING" | "");
        let error_obj = tool_info.and_then(|info| info.get("error"));
        let is_error = matches!(state, "ERROR" | "FAILED" | "CANCELLED")
            || error_obj.is_some_and(|v| !v.is_null());

        let content = if completed {
            if is_error {
                extract_tool_error(error_obj)
                    .or_else(|| {
                        tool_info
                            .and_then(|info| info.get("output"))
                            .and_then(stringify_output)
                    })
                    .unwrap_or_else(|| state.to_string())
            } else {
                tool_info
                    .and_then(|info| info.get("output"))
                    .and_then(stringify_output)
                    .unwrap_or_default()
            }
        } else {
            String::new()
        };

        vec![json!({
            "type": "tool_update",
            "id": id,
            "name": name,
            "input": input,
            "currentFile": current_file,
            "completed": completed,
            "content": content,
            "isError": is_error,
        })]
    }

    fn decode_agent_response(
        &mut self,
        conv_key: &str,
        step: &Map<String, Value>,
        state: &str,
        step_index: Option<u64>,
    ) -> Vec<Value> {
        let mut out = Vec::new();

        let thought_id = match step_index {
            Some(idx) => format!("agy_think_{idx}"),
            None => "agy_think".to_string(),
        };
        let mut emitted_thought = false;
        if let Some(thought) = step
            .get("thought_delta")
            .or_else(|| step.get("thinking_delta"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            let acc = self.turn_mut(conv_key);
            let full_thought = {
                let entry = acc.thoughts.entry(thought_id.clone()).or_default();
                entry.push_str(thought);
                entry.clone()
            };
            if state == "DONE" {
                acc.thoughts.remove(&thought_id);
            }
            emitted_thought = true;
            out.push(json!({
                "type": "thinking",
                "id": thought_id,
                "text": full_thought,
                "snapshot": true,
                "delta": true,
                "completed": state == "DONE",
            }));
        } else if state == "DONE" {
            if let Some(full_thought) = self
                .turn_mut(conv_key)
                .thoughts
                .remove(&thought_id)
                .filter(|s| !s.is_empty())
            {
                emitted_thought = true;
                out.push(json!({
                    "type": "thinking",
                    "id": thought_id,
                    "text": full_thought,
                    "snapshot": true,
                    "delta": true,
                    "completed": true,
                }));
            }
        }
        let _ = emitted_thought;

        if let Some(delta) = step
            .get("text_delta")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            out.push(json!({
                "type": "assistant_text",
                "text": delta,
                "delta": true,
            }));
        }

        if state == "DONE" {
            if let Some(step_usage) = step.get("usage").and_then(StepUsage::from_value) {
                let acc = self.turn_mut(conv_key);
                if acc.add_step(step_index, &step_usage) {
                    out.push(json!({
                        "type": "live_usage",
                        "usage": acc.cumulative_usage_json(),
                        "stepUsage": step_usage.to_step_json(),
                        "roleMain": acc.role_main_json(),
                    }));
                }
            }
        }

        out
    }

    fn decode_result(&mut self, obj: &Map<String, Value>) -> Vec<Value> {
        let Some(result) = obj.get("result").and_then(Value::as_object) else {
            return Vec::new();
        };
        let conv_key = result
            .get("conversation_id")
            .and_then(Value::as_str)
            .or_else(|| obj.get("conversation_id").and_then(Value::as_str))
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("_default_");

        let accumulated = self.take_turn(conv_key);
        let status = result
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("ERROR");
        let finished_reason = result
            .get("finished_reason")
            .and_then(Value::as_str)
            .unwrap_or("");

        if status == "SUCCESS" {
            let num_turns = result.get("num_turns").and_then(Value::as_u64).unwrap_or(1);
            let usage = if let Some(acc) = accumulated.filter(|a| a.requests > 0) {
                acc.cumulative_usage_json()
            } else if num_turns <= 1 {
                // 仅在第 1 轮且未收到任何 step_update 用量时回落到 result.usage；
                // 第 2 轮起的 result.usage 是整段会话累计值，绝不可当作本轮用量。
                result
                    .get("usage")
                    .and_then(StepUsage::from_value)
                    .map(|u| {
                        let mut acc = TurnAccumulator::default();
                        acc.add_step(None, &u);
                        acc.cumulative_usage_json()
                    })
                    .unwrap_or_else(|| json!({}))
            } else {
                json!({})
            };
            return vec![json!({
                "type": "complete",
                "cost": Value::Null,
                "usage": usage,
            })];
        }

        if status.eq_ignore_ascii_case("CANCELLED")
            || finished_reason.eq_ignore_ascii_case("cancelled")
        {
            return vec![json!({
                "type": "error",
                "label": AGY_LABEL,
                "kind": "cancelled",
                "message": "Antigravity turn cancelled",
            })];
        }

        let message = result
            .get("error")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| format!("Antigravity stopped: {status}"));
        let code = if !finished_reason.is_empty() {
            finished_reason
        } else {
            status
        };
        vec![json!({
            "type": "error",
            "label": AGY_LABEL,
            "kind": "provider",
            "message": message,
            "error": {
                "source": "agy_event",
                "provider": "agy",
                "code": code,
                "message": message,
            }
        })]
    }
}

fn read_u64(obj: &Map<String, Value>, keys: &[&str]) -> u64 {
    for key in keys {
        if let Some(value) = obj.get(*key) {
            if let Some(n) = value.as_u64() {
                return n;
            }
            if let Some(n) = value.as_i64().filter(|&n| n >= 0) {
                return n as u64;
            }
            if let Some(s) = value.as_str() {
                if let Ok(n) = s.trim().parse::<u64>() {
                    return n;
                }
            }
        }
    }
    0
}

fn extract_current_file(input: &Value) -> Value {
    let Some(obj) = input.as_object() else {
        return Value::Null;
    };
    for key in [
        "Path",
        "path",
        "filePath",
        "file_path",
        "TargetFile",
        "AbsolutePath",
        "DirectoryPath",
    ] {
        if let Some(path) = obj
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            return json!(path);
        }
    }
    Value::Null
}

fn extract_tool_error(error: Option<&Value>) -> Option<String> {
    let value = error?;
    if let Some(text) = value.as_str().map(str::trim).filter(|s| !s.is_empty()) {
        return Some(text.to_string());
    }
    if let Some(obj) = value.as_object() {
        if let Some(msg) = obj
            .get("message")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            return Some(msg.to_string());
        }
        if let Some(kind) = obj
            .get("type")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            return Some(kind.to_string());
        }
    }
    None
}

fn stringify_output(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        other => serde_json::to_string(other).ok(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn invocation_puts_print_flag_last_and_wraps_first_turn_role() {
        let first = build_invocation(&InvocationInput {
            cmd: "/bin/agy".into(),
            model: Some("gemini-4-neon".into()),
            effort: Some("high".into()),
            conversation_id: Some("ignored-on-first".into()),
            is_first_turn: true,
            role_prompt: Some("reviewer".into()),
            prompt: "hello".into(),
        });
        assert_eq!(
            first.args,
            vec![
                "--output-format",
                "stream-json",
                "--dangerously-skip-permissions",
                "--model",
                "gemini-4-neon",
                "--effort",
                "high",
                "-p",
            ]
        );
        assert_eq!(
            first.payload,
            "[Role prompt]\nreviewer\n[End of role prompt]\n\nhello"
        );

        let resume = build_invocation(&InvocationInput {
            cmd: "/bin/agy".into(),
            model: Some("gemini-4-neon".into()),
            effort: Some("low".into()),
            conversation_id: Some("conv-123".into()),
            is_first_turn: false,
            role_prompt: Some("reviewer".into()),
            prompt: "- follow up".into(),
        });
        assert_eq!(
            resume.args,
            vec![
                "--output-format",
                "stream-json",
                "--dangerously-skip-permissions",
                "--model",
                "gemini-4-neon",
                "--effort",
                "low",
                "--conversation",
                "conv-123",
                "-p",
            ]
        );
        assert_eq!(resume.payload, "- follow up");
    }

    #[test]
    fn multi_step_turn_emits_live_usage_and_ignores_turn2_cumulative_result_usage() {
        let mut decoder = AgyStreamDecoder::new();

        let init = decoder.decode(&json!({
            "event": "init",
            "conversation_id": "c-1",
            "init": { "model": "gemini-4-neon" }
        }));
        assert_eq!(init.len(), 2);
        assert_eq!(init[0]["type"], "session_started");
        assert_eq!(init[0]["sessionId"], "c-1");

        // Step 1: silent agent_response before tool call still reports usage
        let step1 = decoder.decode(&json!({
            "event": "step_update",
            "step_update": {
                "conversation_id": "c-1",
                "step_index": 1,
                "state": "DONE",
                "step_type": "agent_response",
                "usage": {
                    "input_tokens": 13389,
                    "output_tokens": 113,
                    "thinking_tokens": 83,
                    "cache_read_tokens": 0,
                    "total_tokens": 13502
                }
            }
        }));
        assert_eq!(step1.len(), 1);
        assert_eq!(step1[0]["type"], "live_usage");
        assert_eq!(step1[0]["usage"]["input_tokens"], 13389);
        assert_eq!(step1[0]["usage"]["output_tokens"], 113);
        assert_eq!(step1[0]["usage"]["reasoning_output_tokens"], 83);
        assert_eq!(step1[0]["usage"]["context_tokens"], 13389);
        assert_eq!(step1[0]["roleMain"]["inputTokens"], 13389);

        // Step 2: tool active -> tool error
        let tool_start = decoder.decode(&json!({
            "event": "step_update",
            "step_update": {
                "conversation_id": "c-1",
                "step_index": 2,
                "state": "ACTIVE",
                "step_type": "tool",
                "tool_name": "read_file",
                "tool_info": { "name": "read_file", "parameters": { "Path": "/tmp/a.txt" } }
            }
        }));
        assert_eq!(tool_start[0]["type"], "tool_update");
        assert_eq!(tool_start[0]["id"], "agy_step_2");
        assert_eq!(tool_start[0]["currentFile"], "/tmp/a.txt");
        assert_eq!(tool_start[0]["completed"], false);

        let tool_err = decoder.decode(&json!({
            "event": "step_update",
            "step_update": {
                "conversation_id": "c-1",
                "step_index": 2,
                "state": "ERROR",
                "step_type": "tool",
                "tool_name": "read_file",
                "tool_info": {
                    "name": "read_file",
                    "parameters": { "Path": "/tmp/a.txt" },
                    "error": { "type": "TOOL_ERROR", "message": "file does not exist" }
                }
            }
        }));
        assert_eq!(tool_err[0]["completed"], true);
        assert_eq!(tool_err[0]["isError"], true);
        assert_eq!(tool_err[0]["content"], "file does not exist");

        // Step 3: text delta + DONE with cache_read_tokens
        let delta = decoder.decode(&json!({
            "event": "step_update",
            "step_update": {
                "conversation_id": "c-1",
                "step_index": 3,
                "state": "ACTIVE",
                "step_type": "agent_response",
                "text_delta": "hello"
            }
        }));
        assert_eq!(delta[0]["type"], "assistant_text");
        assert_eq!(delta[0]["delta"], true);

        let step3_done = decoder.decode(&json!({
            "event": "step_update",
            "step_update": {
                "conversation_id": "c-1",
                "step_index": 3,
                "state": "DONE",
                "step_type": "agent_response",
                "text_delta": "\n",
                "usage": {
                    "input_tokens": 2201,
                    "output_tokens": 84,
                    "thinking_tokens": 33,
                    "cache_read_tokens": 11332,
                    "total_tokens": 2285
                }
            }
        }));
        assert_eq!(step3_done.len(), 2);
        assert_eq!(step3_done[0]["type"], "assistant_text");
        assert_eq!(step3_done[1]["type"], "live_usage");
        assert_eq!(step3_done[1]["usage"]["input_tokens"], 13389 + 2201);
        assert_eq!(step3_done[1]["usage"]["output_tokens"], 113 + 84);
        assert_eq!(step3_done[1]["usage"]["cache_read_input_tokens"], 11332);
        assert_eq!(step3_done[1]["usage"]["reasoning_output_tokens"], 83 + 33);
        assert_eq!(step3_done[1]["usage"]["context_tokens"], 2201 + 11332);
        assert_eq!(step3_done[1]["stepUsage"]["context_tokens"], 2201 + 11332);

        // Result on turn 2 reports inflated conversation-cumulative totals (e.g. 99999);
        // decoder MUST emit this turn's step sum instead.
        let result = decoder.decode(&json!({
            "event": "result",
            "result": {
                "conversation_id": "c-1",
                "status": "SUCCESS",
                "num_turns": 2,
                "usage": {
                    "input_tokens": 99999,
                    "output_tokens": 9999,
                    "cache_read_tokens": 88888
                }
            }
        }));
        assert_eq!(result.len(), 1);
        assert_eq!(result[0]["type"], "complete");
        assert_eq!(result[0]["usage"]["input_tokens"], 13389 + 2201);
        assert_eq!(result[0]["usage"]["output_tokens"], 113 + 84);
        assert_eq!(result[0]["usage"]["cache_read_input_tokens"], 11332);
        assert_eq!(result[0]["usage"]["context_tokens"], 2201 + 11332);
    }

    #[test]
    fn error_result_decodes_to_provider_error() {
        let mut decoder = AgyStreamDecoder::new();
        let out = decoder.decode(&json!({
            "event": "result",
            "result": {
                "conversation_id": "",
                "status": "ERROR",
                "error": "unknown model \"nope\"",
                "finished_reason": "error"
            }
        }));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["type"], "error");
        assert_eq!(out[0]["kind"], "provider");
        assert_eq!(out[0]["message"], "unknown model \"nope\"");
        assert_eq!(out[0]["error"]["source"], "agy_event");
        assert_eq!(out[0]["error"]["code"], "error");
    }

    #[test]
    fn ensure_router_mcp_merges_idempotently_and_preserves_existing_servers() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let home = std::env::temp_dir().join(format!("multicc-agy-mcp-test-{nanos}"));
        let cfg_dir = home.join(".gemini").join("config");
        fs::create_dir_all(&cfg_dir).unwrap();
        let cfg_path = cfg_dir.join("mcp_config.json");

        // Empty file is treated as {}
        fs::write(&cfg_path, "").unwrap();
        assert!(ensure_router_mcp(&home, "/opt/node", "/opt/router.js").unwrap());
        // Second call is a no-op
        assert!(!ensure_router_mcp(&home, "/opt/node", "/opt/router.js").unwrap());

        // Existing user server is preserved
        fs::write(
            &cfg_path,
            r#"{"mcpServers":{"user_srv":{"command":"uvx","args":["foo"]}}}"#,
        )
        .unwrap();
        assert!(ensure_router_mcp(&home, "/opt/node", "/opt/router.js").unwrap());
        let parsed: Value = serde_json::from_str(&fs::read_to_string(&cfg_path).unwrap()).unwrap();
        assert_eq!(parsed["mcpServers"]["user_srv"]["command"], "uvx");
        assert_eq!(
            parsed["mcpServers"]["multicc_router"]["command"],
            "/opt/node"
        );
        assert_eq!(
            parsed["mcpServers"]["multicc_router"]["args"][0],
            "/opt/router.js"
        );

        // Malformed JSON is never clobbered
        fs::write(&cfg_path, "{broken").unwrap();
        assert!(!ensure_router_mcp(&home, "/opt/node", "/opt/router.js").unwrap());
        assert_eq!(fs::read_to_string(&cfg_path).unwrap(), "{broken");

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn thought_deltas_accumulate_as_snapshots_and_close_on_done() {
        let mut decoder = AgyStreamDecoder::new();
        decoder.decode(&json!({
            "event": "init",
            "conversation_id": "c-think"
        }));

        let first = decoder.decode(&json!({
            "event": "step_update",
            "step_update": {
                "conversation_id": "c-think",
                "step_index": 1,
                "state": "ACTIVE",
                "step_type": "agent_response",
                "thought_delta": "先看"
            }
        }));
        assert_eq!(first.len(), 1);
        assert_eq!(first[0]["type"], "thinking");
        assert_eq!(first[0]["id"], "agy_think_1");
        assert_eq!(first[0]["text"], "先看");
        assert_eq!(first[0]["snapshot"], true);
        assert_eq!(first[0]["completed"], false);

        let second = decoder.decode(&json!({
            "event": "step_update",
            "step_update": {
                "conversation_id": "c-think",
                "step_index": 1,
                "state": "ACTIVE",
                "step_type": "agent_response",
                "thought_delta": "代码结构"
            }
        }));
        assert_eq!(second.len(), 1);
        assert_eq!(second[0]["text"], "先看代码结构");
        assert_eq!(second[0]["snapshot"], true);
        assert_eq!(second[0]["completed"], false);

        // DONE without another thought_delta still closes the accumulated thought.
        let done = decoder.decode(&json!({
            "event": "step_update",
            "step_update": {
                "conversation_id": "c-think",
                "step_index": 1,
                "state": "DONE",
                "step_type": "agent_response",
                "text_delta": "看完了"
            }
        }));
        assert_eq!(done.len(), 2);
        assert_eq!(done[0]["type"], "thinking");
        assert_eq!(done[0]["id"], "agy_think_1");
        assert_eq!(done[0]["text"], "先看代码结构");
        assert_eq!(done[0]["snapshot"], true);
        assert_eq!(done[0]["completed"], true);
        assert_eq!(done[1]["type"], "assistant_text");
        assert_eq!(done[1]["text"], "看完了");
    }
}
