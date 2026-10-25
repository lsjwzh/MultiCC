use serde_json::{json, Value};
use std::collections::BTreeMap;

const MAX_OBSERVATION_BYTES: usize = 8 * 1024 * 1024;
const MAX_EVENT_BYTES: usize = 1024 * 1024;

/// 只旁听，原始响应字节由传输层原样交付；跨块 UTF-8 在完整事件边界才解析。
pub struct Observer {
    claude: bool,
    sse: bool,
    line: Vec<u8>,
    data: Vec<u8>,
    body: Vec<u8>,
    oversized: bool,
    event_name: String,
    blocks: BTreeMap<u64, Value>,
    current_block: Option<Value>,
    tools: BTreeMap<String, String>,
    pub usage: Option<Value>,
    pub events: Vec<Value>,
    pub completed: bool,
    pub failed: bool,
    pub failure_message: String,
    pub saw_output: bool,
    response: Value,
    output: BTreeMap<u64, Value>,
    metadata_bytes: usize,
}

impl Observer {
    pub fn new(claude: bool, sse: bool) -> Self {
        Self {
            claude,
            sse,
            line: vec![],
            data: vec![],
            body: vec![],
            oversized: false,
            event_name: String::new(),
            blocks: BTreeMap::new(),
            current_block: None,
            tools: BTreeMap::new(),
            usage: None,
            events: vec![],
            completed: false,
            failed: false,
            failure_message: String::new(),
            saw_output: false,
            response: json!({}),
            output: BTreeMap::new(),
            metadata_bytes: 0,
        }
    }
    pub fn feed(&mut self, bytes: &[u8]) {
        if !self.sse {
            if self.body.len() + bytes.len() <= MAX_OBSERVATION_BYTES && !self.oversized {
                self.body.extend_from_slice(bytes);
            } else {
                self.body.clear();
                self.oversized = true;
            }
            return;
        }
        for &b in bytes {
            if b == b'\n' {
                let line = std::mem::take(&mut self.line);
                let line = line.strip_suffix(b"\r").unwrap_or(&line);
                if line.is_empty() {
                    if !self.oversized {
                        self.finish_event();
                    }
                    self.data.clear();
                    self.event_name.clear();
                    self.oversized = false;
                } else if !self.oversized {
                    if let Some(data) = line.strip_prefix(b"data:") {
                        let data = data.strip_prefix(b" ").unwrap_or(data);
                        if self.data.len() + data.len() < MAX_EVENT_BYTES {
                            if !self.data.is_empty() {
                                self.data.push(b'\n');
                            }
                            self.data.extend_from_slice(data);
                        } else {
                            self.data.clear();
                            self.oversized = true;
                        }
                    } else if let Some(name) = line.strip_prefix(b"event:") {
                        self.event_name = String::from_utf8_lossy(name).trim().to_owned();
                    }
                }
            } else if self.line.len() < MAX_EVENT_BYTES {
                self.line.push(b);
            } else {
                self.oversized = true;
            }
        }
    }
    pub fn finish(&mut self) {
        if self.sse {
            if !self.line.is_empty() {
                self.feed(b"\n");
            }
            if !self.oversized {
                self.finish_event();
            }
            self.data.clear();
        } else if let Ok(value) = serde_json::from_slice::<Value>(&self.body) {
            self.capture(&value);
        }
        self.body.clear();
    }
    fn finish_event(&mut self) {
        if let Ok(value) = serde_json::from_slice::<Value>(&self.data) {
            self.capture(&value);
        }
        self.data.clear();
    }
    fn capture(&mut self, value: &Value) {
        let typ = value["type"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or(&self.event_name)
            .to_owned();
        if typ == "error" || typ == "response.failed" || typ == "response.incomplete" {
            self.failed = true;
            self.failure_message = value
                .pointer("/response/error/message")
                .or_else(|| value.pointer("/error/message"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .chars()
                .take(1000)
                .collect();
        }
        if self.claude {
            self.capture_claude(value, &typ);
        } else {
            self.capture_responses(value, &typ);
        }
    }
    fn capture_claude(&mut self, value: &Value, typ: &str) {
        if let Some(u) = value
            .pointer("/message/usage")
            .or_else(|| value.get("usage"))
            .filter(|u| u.is_object())
        {
            let mut current = self
                .usage
                .clone()
                .unwrap_or(json!({"inputTokens":0,"outputTokens":0,"cacheWrite":0,"cacheRead":0}));
            for (raw, normalized) in [
                ("input_tokens", "inputTokens"),
                ("cache_creation_input_tokens", "cacheWrite"),
                ("cache_read_input_tokens", "cacheRead"),
            ] {
                if let Some(n) = u[raw].as_u64() {
                    // Compatible upstreams repeat these cumulative totals in
                    // message_delta after message_start. Count each snapshot once.
                    current[normalized] = json!(n.max(current[normalized].as_u64().unwrap_or(0)));
                }
            }
            if let Some(n) = u["output_tokens"].as_u64() {
                current["outputTokens"] =
                    json!(n.max(current["outputTokens"].as_u64().unwrap_or(0)));
            }
            self.usage = Some(current);
        }
        let index = value["index"].as_u64();
        match typ {
            "content_block_start" => {
                let block = &value["content_block"];
                let block = json!({"type":block["type"],"index":index,"id":short_text(&block["id"]),"name":short_text(&block["name"])});
                self.current_block = Some(block.clone());
                if let Some(i) = index.filter(|_| self.blocks.len() < 4096) {
                    self.blocks.insert(i, block.clone());
                }
            }
            "content_block_delta" => {
                let block = match index {
                    Some(i) => self.blocks.get(&i),
                    None => self.current_block.as_ref(),
                };
                let delta = &value["delta"];
                let event = match block.and_then(|b| b["type"].as_str()) {
                    Some("text") => delta["text"].as_str().map(|s| json!({"type":"text", "text":s})),
                    Some("thinking") => delta["thinking"].as_str().or_else(|| delta["text"].as_str()).map(|s| json!({"type":"reasoning", "text":s})),
                    Some("tool_use") => delta["partial_json"].as_str().map(|s| json!({"type":"tool", "tool":{"name":block.unwrap()["name"].as_str().unwrap_or(""), "arguments":s}, "toolId":block.unwrap()["id"].as_str().unwrap_or("")})),
                    _ => None,
                }.or_else(|| match delta["type"].as_str() {
                    Some("compaction_delta") => delta["content"].as_str().map(|s| json!({"type":"text","text":s})),
                    Some("citations_delta") => Some(json!({"type":"source","source":delta["citation"],"blockId":block.and_then(|b|b["id"].as_str()).unwrap_or("")})),
                    _ => None,
                });
                if let Some(event) = event {
                    self.events.push(event);
                    self.saw_output = true;
                }
            }
            "content_block_stop" => {
                if let Some(i) = index {
                    self.blocks.remove(&i);
                }
                if index.is_none()
                    || self
                        .current_block
                        .as_ref()
                        .and_then(|b| b["index"].as_u64())
                        == index
                {
                    self.current_block = None;
                }
            }
            "message_stop" => {
                self.completed = true;
                self.blocks.clear();
                self.current_block = None;
            }
            _ => (),
        }
    }
    fn capture_responses(&mut self, value: &Value, typ: &str) {
        if let Some(u) = value
            .pointer("/response/usage")
            .or_else(|| value.get("usage"))
            .filter(|v| v.is_object())
        {
            self.usage = Some(normalize_responses_usage(u));
        }
        if typ == "response.completed" {
            self.completed = true;
        }
        if typ.starts_with("response.output_")
            || typ.starts_with("response.content_part")
            || typ.starts_with("response.function_call")
            || typ.starts_with("response.reasoning")
        {
            self.saw_output = true;
        }
        if let Some(response) = value.get("response").filter(|v| v.is_object()) {
            let len = response.to_string().len();
            if self.metadata_bytes + len <= MAX_OBSERVATION_BYTES {
                if let Some(existing) = self.response.as_object_mut() {
                    existing.extend(response.as_object().unwrap().clone());
                }
                self.metadata_bytes += len;
            }
        }
        if ["response.output_item.added", "response.output_item.done"].contains(&typ) {
            let item = &value["item"];
            let len = item.to_string().len();
            if self.metadata_bytes + len <= MAX_OBSERVATION_BYTES {
                self.output.insert(
                    value["output_index"]
                        .as_u64()
                        .unwrap_or(self.output.len() as u64),
                    item.clone(),
                );
                self.metadata_bytes += len;
            }
            if self.tools.len() < 4096 {
                if let (Some(id), Some(name)) = (item["id"].as_str(), item["name"].as_str()) {
                    if id.len() <= 1024 && name.len() <= 1024 {
                        self.tools.insert(id.into(), name.into());
                    }
                }
            }
        }
        let delta = value["delta"].as_str();
        let event = match typ {
            "response.output_text.delta" => delta.map(|s|json!({"type":"text","text":s})),
            "response.reasoning_text.delta" | "response.reasoning_summary_text.delta" => delta.map(|s|json!({"type":"reasoning","text":s})),
            "response.function_call_arguments.delta" | "response.custom_tool_call_input.delta" | "response.apply_patch_call_operation_diff.delta" | "response.code_interpreter_call_code.delta" => delta.map(|s| {
                let id = value["item_id"].as_str().unwrap_or("");
                let fallback = if typ.contains("custom_tool") { "custom_tool_call" } else if typ.contains("apply_patch") { "apply_patch_call" } else if typ.contains("code_interpreter") { "code_interpreter_call" } else { "" };
                json!({"type":"tool","tool":{"name":self.tools.get(id).map(String::as_str).unwrap_or(fallback),"arguments":s},"toolId":id})
            }),
            "response.output_text.annotation.added" => Some(json!({"type":"source","source":value["annotation"],"itemId":value["item_id"].as_str().unwrap_or(""),"outputIndex":value["output_index"]})),
            _ => None,
        };
        if let Some(event) = event {
            self.events.push(event);
        }
    }
    pub fn busy(&self) -> bool {
        let s = self.failure_message.to_lowercase();
        [
            "engineinternalerror:1105",
            "system is busy",
            "try again later",
            "code: 10012",
            "code:10012",
        ]
        .iter()
        .any(|v| s.contains(v))
    }
    pub fn completion(&self) -> Vec<u8> {
        let mut response = self.response.clone();
        response["object"] = "response".into();
        response["status"] = "completed".into();
        if !response["id"].is_string() {
            response["id"] = "resp_cpr_rust".into();
        }
        if !self.output.is_empty() {
            response["output"] = Value::Array(self.output.values().cloned().collect());
        } else if !response["output"].is_array() {
            response["output"] = json!([]);
        }
        format!(
            "\n\nevent: response.completed\ndata: {}\n\n",
            json!({"type":"response.completed","response":response})
        )
        .into_bytes()
    }
}
fn normalize_responses_usage(u: &Value) -> Value {
    let n = |v: Option<&Value>| v.and_then(Value::as_u64).unwrap_or(0);
    let input = n(u.get("input_tokens").or_else(|| u.get("prompt_tokens")));
    let cached = n(u
        .pointer("/input_tokens_details/cached_tokens")
        .or_else(|| u.pointer("/prompt_tokens_details/cached_tokens"))
        .or_else(|| u.get("cached_input_tokens")));
    json!({"inputTokens":input.saturating_sub(cached),"outputTokens":n(u.get("output_tokens").or_else(||u.get("completion_tokens"))),"cacheWrite":0,"cacheRead":cached})
}

fn short_text(value: &Value) -> String {
    value.as_str().unwrap_or("").chars().take(1024).collect()
}
