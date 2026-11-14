//! Rules for the voice REST routes retired from `src/routes/voice.js`.
//!
//! The front door owns the whole HTTP surface of these routes; Node keeps only
//! the in-process voice service, the AuxQueue, the env file and the ASR model
//! installer behind one host port (`POST /api/__host/voice`,
//! `src/routes/voice-host.js`). Everything that used to be a decision in the
//! Express handler lives here:
//!
//! * the three prompt templates (refine / confirm / progress-summary), byte for
//!   byte what the Node handler used to send;
//! * the JS coercion rules around them (`(x || '').trim()`, template literals,
//!   `JSON.stringify(e)`, `slice(0, 300)` on UTF-16 units);
//! * the greedy `/\{[\s\S]*\}/` extraction and `{ ok:true, ...parsed, ms }`
//!   spread, including the string/array spread edge cases;
//! * `voiceReadiness` (src/voice/readiness.js) and the settings DTO assembly,
//!   with masking, defaults and the `env.X || runtime.X || default` chain;
//! * the settings-update builder: field order, the `****` echo guards, and the
//!   whole Qwen Audio validation (`invalid <name>`, wss/loopback rules,
//!   trailing `?` stripping) whose errors carried `statusCode = 400`;
//! * the fixed SSE test stream frames.
//!
//! The frozen host contract is `{ op, ...args }` in and `{ ok: true, ... }` /
//! `{ ok: false, error: { message, statusCode? } }` back; anything else means a
//! stale host and the gateway answers 503. `auxEnqueue` is the one op whose
//! failure keeps the old `{ ok:false, cancelled, message }` shape.
//!
//! Known semantic difference: a non-string `result.text` used to raise a
//! JavaScript `TypeError`; the message text below is descriptive, not V8's
//! exact wording (it only reaches the logs — the HTTP body is opaque).

use serde_json::{json, Map, Value};
use url::Url;

use crate::js::json::json_parse;
use crate::js::serde::{
    js_json_stringify, js_json_stringify_indent, js_string, to_serde, truthy, truthy_opt,
};
use crate::js::string::{js_trim, utf16_len, utf16_prefix, utf16_suffix, JsString};

/// `voiceReadiness()`'s "not ready" machine code (src/voice/readiness.js).
pub const NOT_READY: &str = "voice_not_ready";

pub const REFINE_ALLOW: &str = "POST";
pub const FEEDBACK_ALLOW: &str = "POST";
pub const CONFIRM_ALLOW: &str = "POST";
pub const PROGRESS_ALLOW: &str = "POST";
pub const VOCAB_ALLOW: &str = "GET,HEAD";
pub const READINESS_ALLOW: &str = "GET,HEAD";
pub const HOTWORDS_ALLOW: &str = "GET,HEAD";
pub const HOTWORDS_REJECT_ALLOW: &str = "POST";
pub const VOCAB_DELETE_ALLOW: &str = "DELETE";
pub const SETTINGS_VOICE_ALLOW: &str = "GET,HEAD,POST";
pub const ASR_MODEL_ALLOW: &str = "POST";
pub const TEST_SSE_ALLOW: &str = "GET,HEAD";

/// The 503 body `scan.rs` established for "the native module is too old".
pub fn unavailable_body() -> Value {
    json!({
        "error": "语音接口尚未就绪，请更新原生模块",
        "code": "rust_backend_unavailable",
    })
}

/// A JavaScript throw the retired Express handler would have rendered.
///
/// `status_code` is 500 unless the thrown error carried `statusCode` (the Qwen
/// Audio validation did, with 400).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JsError {
    message: String,
    status_code: u16,
}

impl JsError {
    pub fn internal(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            status_code: 500,
        }
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            status_code: 400,
        }
    }

    pub fn message(&self) -> &str {
        &self.message
    }

    pub fn status_code(&self) -> u16 {
        self.status_code
    }
}

/// The `{ message, statusCode? }` object a `{ ok:false, error }` host answer
/// carries. `None` means the answer is not an error object (stale host).
pub fn host_error(error: &Value) -> Option<JsError> {
    let object = error.as_object()?;
    let message = match object.get("message") {
        Some(Value::String(text)) => text.clone(),
        Some(other) => js_string(other),
        // `String((err && err.message) || err)` with both missing.
        None => "undefined".to_string(),
    };
    let status_code = match object.get("statusCode") {
        Some(Value::Number(number)) => number
            .as_i64()
            .filter(|code| (100..=599).contains(code))
            .map(|code| code as u16)
            .unwrap_or(500),
        _ => 500,
    };
    Some(JsError {
        message,
        status_code,
    })
}

/// `Math.random().toString(36).slice(2, 6)`: up to four fractional base-36
/// digits. V8 prints the shortest string that round-trips; the naive expansion
/// used here can differ in the fourth digit for adversarial doubles. The value
/// is an internal request id (log correlation only), never part of a response.
pub fn random_suffix(random: f64) -> String {
    if !(0.0..1.0).contains(&random) {
        return String::new();
    }
    let mut fraction = random;
    let mut digits = String::with_capacity(4);
    while fraction > 0.0 && digits.len() < 4 {
        fraction *= 36.0;
        let digit = fraction.floor();
        if !(0.0..36.0).contains(&digit) {
            break;
        }
        digits.push(std::char::from_digit(digit as u32, 36).unwrap());
        fraction -= digit;
    }
    digits
}

/// `vr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}` and friends.
pub fn req_id(prefix: &str, now_ms: i64, random: f64) -> String {
    format!("{prefix}{now_ms}_{}", random_suffix(random))
}

/// `(req.body[key] || '').trim()`.
///
/// A truthy non-string has no `.trim` and throws a `TypeError`; the retired
/// handler's `await` boundary turned that into an error response.
pub fn trim_body_field(body: &Value, key: &str) -> Result<String, JsError> {
    let value = body.as_object().and_then(|object| object.get(key));
    trim_value(value, key)
}

/// `(value || '').trim()`, with `{key}` used only in the diagnostic.
pub fn trim_value(value: Option<&Value>, label: &str) -> Result<String, JsError> {
    let Some(value) = value else {
        return Ok(String::new());
    };
    if !truthy(value) {
        return Ok(String::new());
    }
    match value {
        Value::String(text) => Ok(js_trim(text).to_string()),
        _ => Err(JsError::internal(format!("{label}.trim is not a function"))),
    }
}

// ── refine ─────────────────────────────────────────────────────────────────

const REFINE_PROMPT_HEAD: &str = r#"你是程序员语音输入助手。原始语音识别文字可能口语化、夹杂中英文。
任务：
1. 保留所有英文技术词汇/命令/API名（React, useState, git commit等）
2. 将口语转为专业简洁的程序员描述
3. 整理成清晰可操作的需求
4. 忠实原意，不臆造功能"#;

/// `String(ex[key])` for the historical examples (`undefined` when absent).
fn example_field(example: &Value, key: &str) -> Result<String, JsError> {
    if example.is_null() {
        return Err(JsError::internal(format!(
            "Cannot read properties of null (reading '{key}')"
        )));
    }
    Ok(
        match example.as_object().and_then(|object| object.get(key)) {
            Some(value) => js_string(value),
            None => "undefined".to_string(),
        },
    )
}

/// The historical-examples suffix and the refine prompt around `raw`.
pub fn refine_prompt(raw: &str, examples: &[Value]) -> Result<String, JsError> {
    let mut examples_str = String::new();
    if !examples.is_empty() {
        let mut rendered = Vec::with_capacity(examples.len());
        for (index, example) in examples.iter().enumerate() {
            rendered.push(format!(
                "[案例{}] 原始：{}\n优化后：{}",
                index + 1,
                example_field(example, "raw")?,
                example_field(example, "userFinal")?
            ));
        }
        examples_str = format!("\n\n历史优化案例（供参考）：\n{}", rendered.join("\n"));
    }
    Ok(format!(
        "{REFINE_PROMPT_HEAD}{examples_str}\n\n原始语音：{raw}\n直接输出优化后的文本，不要任何解释或前缀。"
    ))
}

/// `res.json({ ok:true, text: result.text || '', ms })`.
pub fn refine_success(text: Option<&Value>, ms: i64) -> Value {
    let text = match text {
        Some(value) if truthy(value) => value.clone(),
        _ => Value::String(String::new()),
    };
    let mut body = Map::new();
    body.insert("ok".to_string(), Value::Bool(true));
    body.insert("text".to_string(), text);
    body.insert("ms".to_string(), Value::from(ms));
    Value::Object(body)
}

/// `res.json({ ok:false, text: '[错误: ' + errMsg + ']', ms })`.
pub fn refine_failure(message: &str, ms: i64) -> Value {
    let mut body = Map::new();
    body.insert("ok".to_string(), Value::Bool(false));
    body.insert(
        "text".to_string(),
        Value::String(format!("[错误: {message}]")),
    );
    body.insert("ms".to_string(), Value::from(ms));
    Value::Object(body)
}

// ── auxEnqueue outcomes ────────────────────────────────────────────────────

/// `getAuxQueue().enqueue({ type, prompt, meta: { reqId } })` as the host
/// payload. The queue type is the retired handler's string, not the op name.
pub fn aux_enqueue_payload(kind: &str, prompt: &str, req_id: &str) -> Value {
    let mut meta = Map::new();
    meta.insert("reqId".to_string(), Value::String(req_id.to_string()));
    let mut payload = Map::new();
    payload.insert("op".to_string(), Value::String("auxEnqueue".to_string()));
    payload.insert("type".to_string(), Value::String(kind.to_string()));
    payload.insert("prompt".to_string(), Value::String(prompt.to_string()));
    payload.insert("meta".to_string(), Value::Object(meta));
    Value::Object(payload)
}

/// What the `auxEnqueue` host answer means to a route that asked for text.
pub enum AuxOutcome {
    /// `{ ok:true, text }`; the host already applied `result.text || ''`.
    Success(Option<Value>),
    /// The old `errMsg`: `'cancelled'` or `message || String(err)`.
    Failure(String),
    /// Neither envelope: stale host.
    Invalid,
}

pub fn aux_outcome(answer: &Value) -> AuxOutcome {
    match answer.get("ok") {
        Some(Value::Bool(true)) => AuxOutcome::Success(answer.get("text").cloned()),
        Some(Value::Bool(false)) => AuxOutcome::Failure(aux_error_message(answer)),
        _ => AuxOutcome::Invalid,
    }
}

/// `err?.cancelled ? 'cancelled' : (err?.message || String(err))`, as the host
/// already encoded it in `{ cancelled, message }`.
pub fn aux_error_message(answer: &Value) -> String {
    if truthy_opt(answer.get("cancelled")) {
        return "cancelled".to_string();
    }
    match answer.get("message") {
        Some(Value::String(text)) => text.clone(),
        Some(other) => js_string(other),
        None => "undefined".to_string(),
    }
}

// ── feedback ───────────────────────────────────────────────────────────────

/// JavaScript strict equality for JSON values. Objects and arrays are always
/// distinct (they can never be the same reference across the JSON boundary).
fn js_strict_equal(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Null, Value::Null) => true,
        (Value::Bool(left), Value::Bool(right)) => left == right,
        (Value::Number(left), Value::Number(right)) => {
            matches!((left.as_f64(), right.as_f64()), (Some(left), Some(right)) if left == right)
        }
        (Value::String(left), Value::String(right)) => left == right,
        _ => false,
    }
}

/// `raw && refined !== undefined && userFinal !== undefined && userFinal !== refined`.
pub fn feedback_applies(body: &Value) -> bool {
    let Some(object) = body.as_object() else {
        return false;
    };
    if !truthy_opt(object.get("raw")) {
        return false;
    }
    let (Some(refined), Some(user_final)) = (object.get("refined"), object.get("userFinal")) else {
        return false;
    };
    !js_strict_equal(user_final, refined)
}

/// The `feedbackApply` host payload (`{ appends, corrections, hotwords }`).
pub fn feedback_payload(body: &Value) -> Value {
    let object = body.as_object();
    let mut payload = Map::new();
    payload.insert("op".to_string(), Value::String("feedbackApply".to_string()));
    for key in ["raw", "refined", "userFinal"] {
        if let Some(value) = object.and_then(|object| object.get(key)) {
            payload.insert(key.to_string(), value.clone());
        }
    }
    Value::Object(payload)
}

// ── confirm ────────────────────────────────────────────────────────────────

const CONFIRM_PROMPT_HEAD: &str = "你是语音交互的需求确认助手。用户通过连续语音描述了一个编程/技术任务。你的职责是把用户的口语描述整理成清晰、可逐项确认的需求条目，以便在执行前与用户对齐。";

const CONFIRM_PROMPT_TAIL: &str = r#"请输出严格的 JSON（只输出 JSON，不要 markdown 代码块，不要任何解释）：
{
  "summary": "一句话总结你理解的整体需求（用'我理解你要做的是：...'的口吻）",
  "items": ["需求条目1", "需求条目2", "..."],
  "questions": ["如果有需要进一步确认的疑问写在这里，没有则空数组"],
  "allConfirmed": false
}

规则：
- allConfirmed 只有在用户的反馈明确表示"全部正确/确认/没问题/对了/可以了"等时才设为 true，其余情况一律 false
- items 每条用简洁的短句，适合语音逐条念出
- 如果是首次确认（没有 previousBreakdown），根据原始语音拆解；如果有 previousBreakdown + userFeedback，根据反馈更新条目
- questions 只在有真正需要澄清的疑问时才填，通常为空数组"#;

/// The confirm prompt, built exactly like the template literal it replaced.
pub fn confirm_prompt(
    raw: &str,
    previous: Option<&Value>,
    user_feedback: Option<&Value>,
) -> String {
    let mut parts = Vec::new();
    if truthy_opt(previous) {
        parts.push(format!(
            "之前你给出的理解（JSON）：\n{}",
            js_json_stringify_indent(previous.expect("checked above"), "  ")
        ));
    }
    if truthy_opt(user_feedback) {
        parts.push(format!(
            "用户对此的语音反馈：{}",
            js_string(user_feedback.expect("checked above"))
        ));
    }
    let context = if parts.is_empty() {
        String::new()
    } else {
        format!("\n\n{}", parts.join("\n\n"))
    };
    let context_line = if context.is_empty() {
        String::new()
    } else {
        format!("{context}\n\n")
    };
    let spoken = if raw.is_empty() {
        "（无新增，仅根据反馈调整）"
    } else {
        raw
    };
    format!(
        "{CONFIRM_PROMPT_HEAD}\n\n{context_line}用户本次的语音输入：{spoken}\n\n{CONFIRM_PROMPT_TAIL}"
    )
}

/// The greedy `/\{[\s\S]*\}/` match: first `{` through the last `}` after it.
fn greedy_json_object(text: &str) -> Option<&str> {
    let start = text.find('{')?;
    let end = start + 1 + text[start + 1..].rfind('}')?;
    Some(&text[start..=end])
}

/// `{ ok:true, ...parsed, ms }` spread order: `ok` first, then the parsed
/// object's keys (an existing `ok`/`ms` keeps its first position and takes the
/// new value), then `ms`.
fn spread_object(target: &mut Map<String, Value>, value: &Value) {
    match value {
        Value::Object(object) => {
            for (key, member) in object {
                target.insert(key.clone(), member.clone());
            }
        }
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                target.insert(index.to_string(), item.clone());
            }
        }
        Value::String(text) => {
            // `{...'ab'}` spreads UTF-16 code units as indexed properties.
            for (index, unit) in text.encode_utf16().enumerate() {
                target.insert(
                    index.to_string(),
                    Value::String(String::from_utf16_lossy(&[unit])),
                );
            }
        }
        _ => {}
    }
}

/// `JSON.parse` on the greedy match, or the `{ summary, items, questions,
/// allConfirmed }` fallback when there is no match or the parse fails/returns a
/// falsy value.
pub fn confirm_result(text: Option<&Value>) -> Result<Map<String, Value>, JsError> {
    let raw_text = match text {
        Some(Value::String(text)) => text.clone(),
        Some(value) if truthy(value) => {
            return Err(JsError::internal("rawText.match is not a function"))
        }
        _ => String::new(),
    };
    let parsed = greedy_json_object(&raw_text)
        .and_then(|candidate| json_parse(candidate).ok())
        .map(|value| to_serde(&value))
        .filter(truthy);
    let parsed = parsed.unwrap_or_else(|| {
        json!({
            "summary": js_trim(&raw_text),
            "items": [],
            "questions": [],
            "allConfirmed": false,
        })
    });
    let mut result = Map::new();
    spread_object(&mut result, &parsed);
    Ok(result)
}

pub fn confirm_response(parsed: Map<String, Value>, ms: i64) -> Value {
    let mut body = Map::new();
    body.insert("ok".to_string(), Value::Bool(true));
    for (key, value) in parsed {
        body.insert(key, value);
    }
    body.insert("ms".to_string(), Value::from(ms));
    Value::Object(body)
}

// ── progress-summary ───────────────────────────────────────────────────────

const PROGRESS_PROMPT_HEAD: &str = "你是语音交互的进展汇报助手。用户通过语音发起了一个任务，正在等待结果。请根据最近的任务进展事件，用口语化的中文给用户做一个简洁的进展汇报，适合语音播报。";

const PROGRESS_PROMPT_TAIL: &str = r#"要求：
- 用 1-3 句话总结当前进展，口语化，自然
- 直接说内容，不要加"汇报："等前缀
- 如果看到错误或卡住，也如实说明
- 如果进展正常，简单说明已完成了什么、还在做什么
- 不超过 100 字"#;

/// `.slice(0, 300)` on the value: strings and arrays have it, everything else
/// throws.
fn slice_300(value: &Value) -> Result<String, JsError> {
    match value {
        Value::String(text) => Ok(utf16_prefix(text, 300)),
        Value::Array(items) => {
            let sliced: Vec<Value> = items.iter().take(300).cloned().collect();
            Ok(js_string(&Value::Array(sliced)))
        }
        _ => Err(JsError::internal("value.summary.slice is not a function")),
    }
}

fn event_body(event: &Value) -> Result<String, JsError> {
    for key in ["summary", "text"] {
        if let Some(value) = event.as_object().and_then(|object| object.get(key)) {
            if truthy(value) {
                return slice_300(value);
            }
        }
    }
    slice_300(&Value::String(js_json_stringify(event)))
}

/// `${i + 1}. [${e.type || '?'}] ${(...).slice(0, 300)}` joined by newlines.
pub fn progress_events_str(events: &[Value]) -> Result<String, JsError> {
    let mut lines = Vec::with_capacity(events.len());
    for (index, event) in events.iter().enumerate() {
        if event.is_null() {
            return Err(JsError::internal(
                "Cannot read properties of null (reading 'type')",
            ));
        }
        let kind = match event.as_object().and_then(|object| object.get("type")) {
            Some(value) if truthy(value) => js_string(value),
            _ => "?".to_string(),
        };
        lines.push(format!("{}. [{}] {}", index + 1, kind, event_body(event)?));
    }
    Ok(lines.join("\n"))
}

pub fn progress_prompt(events_str: &str, task_description: Option<&Value>) -> String {
    let task = match task_description {
        Some(value) if truthy(value) => js_string(value),
        _ => "编程任务".to_string(),
    };
    format!(
        "{PROGRESS_PROMPT_HEAD}\n\n任务描述：{task}\n\n最近的进展事件：\n{events_str}\n\n{PROGRESS_PROMPT_TAIL}"
    )
}

/// `!Array.isArray(events) || events.length === 0` answered `{ok:true,
/// summary:''}` — no `ms`, and no host call.
pub fn progress_empty() -> Value {
    json!({ "ok": true, "summary": "" })
}

/// `(result.text || '').trim()`; a truthy non-string throws inside the try.
/// V8 quotes the whole source expression in that TypeError, and the retired
/// handler wrote it into the 500 body, so the message is part of the contract.
pub fn progress_success(text: Option<&Value>, ms: i64) -> Result<Value, JsError> {
    let summary = match text {
        Some(Value::String(text)) => js_trim(text).to_string(),
        Some(value) if truthy(value) => {
            return Err(JsError::internal(
                "(result.text || \"\").trim is not a function",
            ))
        }
        _ => String::new(),
    };
    Ok(json!({ "ok": true, "summary": summary, "ms": ms }))
}

// ── readiness ──────────────────────────────────────────────────────────────

fn streaming_ready(streaming: Option<&Value>, provider: &str) -> bool {
    let Some(entry) = streaming
        .and_then(Value::as_object)
        .and_then(|object| object.get(provider))
    else {
        return false;
    };
    truthy(entry)
        && entry
            .as_object()
            .and_then(|object| object.get("ready"))
            .is_some_and(truthy)
}

/// `voiceReadiness()` over the `readinessFacts` answer.
///
/// Key order is the JS object literal's: ready, engine, reason, cloudConfigured,
/// download. `download` is omitted when the host did not carry it (JS
/// `undefined`) and is `null` when the installer reported null.
pub fn readiness_body(facts: &Value) -> Option<Value> {
    let object = facts.as_object()?;
    let local_ready = object.get("localAvailable")?.as_bool()?;
    let cloud_keys = object.get("cloudKeys")?.as_object()?;
    let streaming = object.get("streaming");
    let cloud = truthy_opt(cloud_keys.get("whisper"))
        || truthy_opt(cloud_keys.get("openrouter"))
        || ["openai", "volcano", "funasr"]
            .iter()
            .any(|provider| streaming_ready(streaming, provider));
    let engine = if local_ready {
        Some("local")
    } else if cloud {
        Some("cloud")
    } else {
        None
    };
    let download = object.get("download");
    let reason = if engine.is_some() {
        None
    } else {
        let state = download
            .and_then(Value::as_object)
            .and_then(|installer| installer.get("state"));
        Some(match state {
            Some(Value::String(text))
                if matches!(
                    text.as_str(),
                    "downloading" | "failed" | "unsupported" | "disabled"
                ) =>
            {
                text.clone()
            }
            _ => "missing".to_string(),
        })
    };
    let mut body = Map::new();
    body.insert("ready".to_string(), Value::Bool(engine.is_some()));
    body.insert(
        "engine".to_string(),
        engine
            .map(|engine| Value::String(engine.to_string()))
            .unwrap_or(Value::Null),
    );
    body.insert(
        "reason".to_string(),
        reason.map(Value::String).unwrap_or(Value::Null),
    );
    body.insert("cloudConfigured".to_string(), Value::Bool(cloud));
    if let Some(download) = download {
        body.insert("download".to_string(), download.clone());
    }
    Some(Value::Object(body))
}

// ── hotwords ───────────────────────────────────────────────────────────────

/// `!voice.autoHotwords ? {enabled:false} : {enabled:!!x, ...snapshot()}`.
pub fn hotwords_body(answer: &Value) -> Option<Value> {
    let object = answer.as_object()?;
    let present = object.get("present")?.as_bool()?;
    if !present {
        let mut body = Map::new();
        body.insert("enabled".to_string(), Value::Bool(false));
        return Some(Value::Object(body));
    }
    let enabled = truthy_opt(object.get("enabled"));
    let mut body = Map::new();
    body.insert("enabled".to_string(), Value::Bool(enabled));
    match object.get("snapshot") {
        None | Some(Value::Null) => {}
        Some(Value::Object(snapshot)) => {
            for (key, value) in snapshot {
                body.insert(key.clone(), value.clone());
            }
        }
        Some(_) => return None,
    }
    Some(Value::Object(body))
}

pub fn hotwords_reject_payload(body: &Value) -> Value {
    let object = body.as_object();
    let mut payload = Map::new();
    payload.insert(
        "op".to_string(),
        Value::String("hotwordsReject".to_string()),
    );
    for key in ["term", "alias"] {
        if let Some(value) = object.and_then(|object| object.get(key)) {
            payload.insert(key.to_string(), value.clone());
        }
    }
    Value::Object(payload)
}

/// `{ present, accepted }` from the host, both booleans.
pub fn hotwords_reject_result(answer: &Value) -> Option<(bool, bool)> {
    let object = answer.as_object()?;
    Some((
        object.get("present")?.as_bool()?,
        object.get("accepted")?.as_bool()?,
    ))
}

pub fn hotwords_reject_denied() -> Value {
    json!({ "ok": false, "error": "term required" })
}

// ── vocab ──────────────────────────────────────────────────────────────────

pub fn vocab_body(answer: &Value) -> Option<Value> {
    let value = answer.get("vocab")?;
    value.as_array()?;
    Some(value.clone())
}

/// `req.params.term.toLowerCase()` — Unicode default case conversion.
pub fn vocab_delete_target(decoded: &str) -> String {
    JsString::from_rust_str(decoded)
        .to_lowercase()
        .to_string_lossy()
}

pub fn vocab_delete_body(answer: &Value) -> Option<Value> {
    let remaining = answer.get("remaining")?;
    remaining.as_f64()?;
    Some(json!({ "ok": true, "remaining": remaining.clone() }))
}

// ── settings GET ───────────────────────────────────────────────────────────

/// The env-file/process-env keys the retired GET read (host whitelist).
pub const SETTINGS_FACT_KEYS: &[&str] = &[
    "OPENROUTER_API_KEY",
    "OPENROUTER_BASE_URL",
    "OPENROUTER_MODEL",
    "WHISPER_API_KEY",
    "WHISPER_BASE_URL",
    "WHISPER_MODEL",
    "WHISPER_LANGUAGE",
    "WHISPER_PROMPT",
    "QWEN_AUDIO_DASHSCOPE_API_KEY",
    "DASHSCOPE_API_KEY",
    "QWEN_AUDIO_REALTIME_MODEL",
    "QWEN_AUDIO_REALTIME_VOICE",
    "QWEN_AUDIO_REALTIME_BASE_URL",
    "ASR_PROVIDER",
    "OPENAI_REALTIME_URL",
    "OPENAI_REALTIME_MODEL",
    "OPENAI_REALTIME_API_KEY",
    "VOLC_ASR_URL",
    "VOLC_ASR_RESOURCE_ID",
    "VOLC_ASR_APP_ID",
    "VOLC_ASR_ACCESS_TOKEN",
    "FUNASR_WS_URL",
    "FUNASR_MODE",
    "TTS_PROVIDER",
    "EDGE_TTS_VOICE",
    "OPENAI_TTS_VOICE",
    "OPENAI_TTS_API_KEY",
    "OPENAI_API_KEY",
    "VOLC_TTS_VOICE",
    "VOLC_TTS_APP_ID",
    "VOLC_TTS_ACCESS_TOKEN",
];

pub fn settings_facts_payload() -> Value {
    let mut payload = Map::new();
    payload.insert("op".to_string(), Value::String("settingsFacts".to_string()));
    payload.insert(
        "keys".to_string(),
        Value::Array(
            SETTINGS_FACT_KEYS
                .iter()
                .map(|key| Value::String((*key).to_string()))
                .collect(),
        ),
    );
    Value::Object(payload)
}

/// `env[key] || runtime[key] || default`.
fn pick(env: &Map<String, Value>, runtime: &Map<String, Value>, key: &str, default: &str) -> Value {
    for source in [env, runtime] {
        if let Some(value) = source.get(key) {
            if truthy(value) {
                return value.clone();
            }
        }
    }
    Value::String(default.to_string())
}

/// `!!(env[key] || runtime[key])`.
fn present(env: &Map<String, Value>, runtime: &Map<String, Value>, key: &str) -> bool {
    truthy_opt(env.get(key)) || truthy_opt(runtime.get(key))
}

/// `key.slice(0, head) + '****' + key.slice(-4)`.
fn mask_key(value: &Value, head: usize) -> Result<String, JsError> {
    match value {
        Value::String(text) => Ok(format!(
            "{}****{}",
            utf16_prefix(text, head),
            utf16_suffix(text, 4.0)
        )),
        _ => Err(JsError::internal("key.slice is not a function")),
    }
}

/// The whole `GET /api/settings/voice` body. `None` means the host answer is
/// missing the facts the handler always read (stale host).
pub fn settings_dto(facts: &Value) -> Option<Value> {
    let object = facts.as_object()?;
    let env = object.get("env")?.as_object()?;
    let runtime = object.get("runtime")?.as_object()?;

    let key = pick(env, runtime, "OPENROUTER_API_KEY", "");
    let whisper_key = pick(env, runtime, "WHISPER_API_KEY", "");
    let mut qwen_key = Value::String(String::new());
    for (source, name) in [
        (env, "QWEN_AUDIO_DASHSCOPE_API_KEY"),
        (runtime, "QWEN_AUDIO_DASHSCOPE_API_KEY"),
        (env, "DASHSCOPE_API_KEY"),
        (runtime, "DASHSCOPE_API_KEY"),
    ] {
        if let Some(value) = source.get(name) {
            if truthy(value) {
                qwen_key = value.clone();
                break;
            }
        }
    }

    let api_key = if truthy(&key) {
        mask_key(&key, 8).ok()?
    } else {
        String::new()
    };
    let whisper_api_key = if truthy(&whisper_key) {
        mask_key(&whisper_key, 8).ok()?
    } else {
        String::new()
    };
    let qwen_api_key = if truthy(&qwen_key) {
        mask_key(&qwen_key, 6).ok()?
    } else {
        String::new()
    };

    let mut asr = Map::new();
    asr.insert(
        "provider".to_string(),
        pick(env, runtime, "ASR_PROVIDER", "auto"),
    );
    if let Some(status) = object.get("asrStatus") {
        asr.insert("status".to_string(), status.clone());
    }
    asr.insert(
        "openaiUrl".to_string(),
        pick(
            env,
            runtime,
            "OPENAI_REALTIME_URL",
            "wss://api.openai.com/v1/realtime",
        ),
    );
    asr.insert(
        "openaiModel".to_string(),
        pick(env, runtime, "OPENAI_REALTIME_MODEL", "gpt-4o-transcribe"),
    );
    asr.insert(
        "hasOpenaiKey".to_string(),
        Value::Bool(present(env, runtime, "OPENAI_REALTIME_API_KEY")),
    );
    asr.insert(
        "volcUrl".to_string(),
        pick(env, runtime, "VOLC_ASR_URL", ""),
    );
    asr.insert(
        "volcResourceId".to_string(),
        pick(
            env,
            runtime,
            "VOLC_ASR_RESOURCE_ID",
            "volc.bigasr.sauc.duration",
        ),
    );
    asr.insert(
        "hasVolcAppId".to_string(),
        Value::Bool(present(env, runtime, "VOLC_ASR_APP_ID")),
    );
    asr.insert(
        "hasVolcToken".to_string(),
        Value::Bool(present(env, runtime, "VOLC_ASR_ACCESS_TOKEN")),
    );
    asr.insert(
        "funasrUrl".to_string(),
        pick(env, runtime, "FUNASR_WS_URL", ""),
    );
    asr.insert(
        "funasrMode".to_string(),
        pick(env, runtime, "FUNASR_MODE", "2pass"),
    );

    let mut tts = Map::new();
    tts.insert(
        "provider".to_string(),
        pick(env, runtime, "TTS_PROVIDER", "edge"),
    );
    if let Some(status) = object.get("ttsStatus") {
        tts.insert("status".to_string(), status.clone());
    }
    tts.insert(
        "edgeVoice".to_string(),
        pick(env, runtime, "EDGE_TTS_VOICE", "zh-CN-XiaoxiaoNeural"),
    );
    tts.insert(
        "openaiVoice".to_string(),
        pick(env, runtime, "OPENAI_TTS_VOICE", "alloy"),
    );
    tts.insert(
        "hasOpenaiKey".to_string(),
        Value::Bool(
            present(env, runtime, "OPENAI_TTS_API_KEY")
                || truthy_opt(runtime.get("OPENAI_API_KEY")),
        ),
    );
    tts.insert(
        "volcanoVoice".to_string(),
        pick(
            env,
            runtime,
            "VOLC_TTS_VOICE",
            "zh_female_shuangkuaisisi_moon_bigtts",
        ),
    );
    tts.insert(
        "hasVolcanoAppId".to_string(),
        Value::Bool(present(env, runtime, "VOLC_TTS_APP_ID")),
    );
    tts.insert(
        "hasVolcanoToken".to_string(),
        Value::Bool(present(env, runtime, "VOLC_TTS_ACCESS_TOKEN")),
    );

    let mut qwen = Map::new();
    qwen.insert("hasApiKey".to_string(), Value::Bool(truthy(&qwen_key)));
    qwen.insert("apiKey".to_string(), Value::String(qwen_api_key));
    qwen.insert(
        "model".to_string(),
        pick(
            env,
            runtime,
            "QWEN_AUDIO_REALTIME_MODEL",
            "qwen-audio-3.0-realtime-plus",
        ),
    );
    qwen.insert(
        "voice".to_string(),
        pick(env, runtime, "QWEN_AUDIO_REALTIME_VOICE", "longanqian"),
    );
    qwen.insert(
        "baseUrl".to_string(),
        pick(
            env,
            runtime,
            "QWEN_AUDIO_REALTIME_BASE_URL",
            "wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
        ),
    );
    if let Some(runtime_status) = object.get("qwenRuntime") {
        qwen.insert("runtime".to_string(), runtime_status.clone());
    }

    let mut body = Map::new();
    body.insert(
        "baseUrl".to_string(),
        pick(
            env,
            runtime,
            "OPENROUTER_BASE_URL",
            "https://openrouter.ai/api/v1",
        ),
    );
    body.insert("apiKey".to_string(), Value::String(api_key));
    body.insert(
        "model".to_string(),
        pick(
            env,
            runtime,
            "OPENROUTER_MODEL",
            "google/gemini-2.0-flash-001",
        ),
    );
    body.insert("hasKey".to_string(), Value::Bool(truthy(&key)));
    body.insert(
        "whisperBaseUrl".to_string(),
        pick(
            env,
            runtime,
            "WHISPER_BASE_URL",
            "https://openrouter.ai/api/v1",
        ),
    );
    body.insert("whisperApiKey".to_string(), Value::String(whisper_api_key));
    body.insert(
        "whisperModel".to_string(),
        pick(env, runtime, "WHISPER_MODEL", "whisper-large-v3-turbo"),
    );
    body.insert(
        "hasWhisperKey".to_string(),
        Value::Bool(truthy(&whisper_key)),
    );
    body.insert(
        "whisperLanguage".to_string(),
        pick(env, runtime, "WHISPER_LANGUAGE", "zh"),
    );
    body.insert(
        "whisperPrompt".to_string(),
        pick(env, runtime, "WHISPER_PROMPT", ""),
    );
    body.insert("asr".to_string(), Value::Object(asr));
    body.insert("tts".to_string(), Value::Object(tts));
    body.insert("qwenAudio".to_string(), Value::Object(qwen));
    Some(Value::Object(body))
}

// ── settings POST ──────────────────────────────────────────────────────────

/// `value.includes('****')` where `value` may be a string (substring) or an
/// array (SameValueZero element); every other type throws.
fn secret_includes_marker(value: &Value, name: &str) -> Result<bool, JsError> {
    match value {
        Value::String(text) => Ok(text.contains("****")),
        Value::Array(items) => Ok(items
            .iter()
            .any(|item| matches!(item, Value::String(text) if text == "****"))),
        _ => Err(JsError::internal(format!(
            "{name}.includes is not a function"
        ))),
    }
}

/// `cleanQwenValue`: string, no CR/LF/NUL, UTF-16 length within the cap, then
/// `trim()`. Every failure is `TypeError { statusCode: 400 }`.
fn clean_qwen_value(value: &Value, name: &str, max_length: usize) -> Result<String, JsError> {
    let Value::String(text) = value else {
        return Err(JsError::bad_request(format!("invalid {name}")));
    };
    if text
        .chars()
        .any(|character| matches!(character, '\r' | '\n' | '\0'))
        || utf16_len(text) > max_length
    {
        return Err(JsError::bad_request(format!("invalid {name}")));
    }
    Ok(js_trim(text).to_string())
}

/// The Node `parsed.hostname` spelling: bracketed IPv6, lowercased domain.
fn url_hostname(parsed: &Url) -> String {
    match parsed.host() {
        Some(url::Host::Domain(domain)) => domain.to_string(),
        Some(url::Host::Ipv4(address)) => address.to_string(),
        Some(url::Host::Ipv6(address)) => format!("[{address}]"),
        None => String::new(),
    }
}

fn qwen_base_url(value: &Value) -> Result<String, JsError> {
    let cleaned = clean_qwen_value(value, "qwenAudio.baseUrl", 500)?;
    let parsed =
        Url::parse(&cleaned).map_err(|_| JsError::bad_request("invalid qwenAudio.baseUrl"))?;
    let loopback = matches!(
        url_hostname(&parsed).as_str(),
        "127.0.0.1" | "localhost" | "::1" | "[::1]"
    );
    let scheme = parsed.scheme();
    if scheme != "wss" && !(scheme == "ws" && loopback) {
        return Err(JsError::bad_request(
            "qwenAudio.baseUrl requires wss or loopback ws",
        ));
    }
    Ok(cleaned.trim_end_matches('?').to_string())
}

fn set_section(updates: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    let Some(value) = value else {
        return;
    };
    if let Value::String(text) = value {
        if text.contains("****") {
            return;
        }
    }
    updates.insert(key.to_string(), value.clone());
}

/// The ordered `updates` object the retired POST built, before any side effect.
/// Every validation error here aborts the request before `settingsApply`.
pub fn settings_updates(body: &Value) -> Result<Map<String, Value>, JsError> {
    let object = body.as_object();
    let field = |name: &str| object.and_then(|object| object.get(name));
    let mut updates = Map::new();

    if let Some(value) = field("baseUrl") {
        updates.insert("OPENROUTER_BASE_URL".to_string(), value.clone());
    }
    if let Some(value) = field("apiKey") {
        if !secret_includes_marker(value, "apiKey")? {
            updates.insert("OPENROUTER_API_KEY".to_string(), value.clone());
        }
    }
    if let Some(value) = field("model") {
        updates.insert("OPENROUTER_MODEL".to_string(), value.clone());
    }
    if let Some(value) = field("whisperBaseUrl") {
        updates.insert("WHISPER_BASE_URL".to_string(), value.clone());
    }
    if let Some(value) = field("whisperApiKey") {
        if !secret_includes_marker(value, "whisperApiKey")? {
            updates.insert("WHISPER_API_KEY".to_string(), value.clone());
        }
    }
    if let Some(value) = field("whisperModel") {
        updates.insert("WHISPER_MODEL".to_string(), value.clone());
    }
    if let Some(value) = field("whisperLanguage") {
        updates.insert("WHISPER_LANGUAGE".to_string(), value.clone());
    }
    if let Some(value) = field("whisperPrompt") {
        updates.insert("WHISPER_PROMPT".to_string(), value.clone());
    }

    let asr = field("asr").and_then(Value::as_object);
    let asr_field = |name: &str| asr.and_then(|asr| asr.get(name));
    for (key, name) in [
        ("ASR_PROVIDER", "provider"),
        ("OPENAI_REALTIME_API_KEY", "openaiApiKey"),
        ("OPENAI_REALTIME_URL", "openaiUrl"),
        ("OPENAI_REALTIME_MODEL", "openaiModel"),
        ("VOLC_ASR_APP_ID", "volcAppId"),
        ("VOLC_ASR_ACCESS_TOKEN", "volcAccessToken"),
        ("VOLC_ASR_RESOURCE_ID", "volcResourceId"),
        ("VOLC_ASR_URL", "volcUrl"),
        ("FUNASR_WS_URL", "funasrUrl"),
        ("FUNASR_MODE", "funasrMode"),
    ] {
        set_section(&mut updates, key, asr_field(name));
    }

    let tts = field("tts").and_then(Value::as_object);
    let tts_field = |name: &str| tts.and_then(|tts| tts.get(name));
    for (key, name) in [
        ("TTS_PROVIDER", "provider"),
        ("EDGE_TTS_VOICE", "edgeVoice"),
        ("OPENAI_TTS_API_KEY", "openaiApiKey"),
        ("OPENAI_TTS_URL", "openaiUrl"),
        ("OPENAI_TTS_MODEL", "openaiModel"),
        ("OPENAI_TTS_VOICE", "openaiVoice"),
        ("VOLC_TTS_APP_ID", "volcanoAppId"),
        ("VOLC_TTS_ACCESS_TOKEN", "volcanoToken"),
        ("VOLC_TTS_URL", "volcanoUrl"),
        ("VOLC_TTS_VOICE", "volcanoVoice"),
    ] {
        set_section(&mut updates, key, tts_field(name));
    }

    let qwen = field("qwenAudio").and_then(Value::as_object);
    let qwen_field = |name: &str| qwen.and_then(|qwen| qwen.get(name));
    if matches!(qwen_field("clearApiKey"), Some(Value::Bool(true))) {
        updates.insert("QWEN_AUDIO_DASHSCOPE_API_KEY".to_string(), Value::Null);
    } else if let Some(api_key) = qwen_field("apiKey") {
        // The `****` echo test goes through String() first.
        if !js_string(api_key).contains("****") {
            let cleaned = clean_qwen_value(api_key, "qwenAudio.apiKey", 512)?;
            updates.insert(
                "QWEN_AUDIO_DASHSCOPE_API_KEY".to_string(),
                Value::String(cleaned),
            );
        }
    }
    if let Some(value) = qwen_field("model") {
        let cleaned = clean_qwen_value(value, "qwenAudio.model", 160)?;
        updates.insert(
            "QWEN_AUDIO_REALTIME_MODEL".to_string(),
            Value::String(cleaned),
        );
    }
    if let Some(value) = qwen_field("voice") {
        let cleaned = clean_qwen_value(value, "qwenAudio.voice", 80)?;
        updates.insert(
            "QWEN_AUDIO_REALTIME_VOICE".to_string(),
            Value::String(cleaned),
        );
    }
    if let Some(value) = qwen_field("baseUrl") {
        let cleaned = qwen_base_url(value)?;
        updates.insert(
            "QWEN_AUDIO_REALTIME_BASE_URL".to_string(),
            Value::String(cleaned),
        );
    }
    Ok(updates)
}

pub fn settings_apply_payload(updates: Map<String, Value>) -> Value {
    let mut payload = Map::new();
    payload.insert("op".to_string(), Value::String("settingsApply".to_string()));
    payload.insert("updates".to_string(), Value::Object(updates));
    Value::Object(payload)
}

// ── asr-model ──────────────────────────────────────────────────────────────

/// `String((req.body && req.body.action) || 'download')`.
pub fn asr_action(body: &Value) -> String {
    match body.as_object().and_then(|object| object.get("action")) {
        Some(value) if truthy(value) => js_string(value),
        _ => "download".to_string(),
    }
}

/// `{ ok:true, cancelled, status }` — keys the host did not carry stay
/// omitted, like `JSON.stringify` on `undefined`.
pub fn asr_cancel_body(answer: &Value) -> Option<Value> {
    let object = answer.as_object()?;
    let mut body = Map::new();
    body.insert("ok".to_string(), Value::Bool(true));
    if let Some(cancelled) = object.get("cancelled") {
        body.insert("cancelled".to_string(), cancelled.clone());
    }
    if let Some(status) = object.get("status") {
        body.insert("status".to_string(), status.clone());
    }
    Some(Value::Object(body))
}

/// `{ ok:true, status }`.
pub fn asr_status_body(answer: &Value) -> Option<Value> {
    let status = answer.get("status")?;
    let mut body = Map::new();
    body.insert("ok".to_string(), Value::Bool(true));
    body.insert("status".to_string(), status.clone());
    Some(Value::Object(body))
}

// ── SSE test stream ────────────────────────────────────────────────────────

/// One `data:` frame of the SSE test stream. Index 0..3 are the three text
/// chunks, 3 is `[DONE]`.
pub fn sse_frame(index: usize) -> String {
    if index >= 3 {
        return "data: [DONE]\n\n".to_string();
    }
    let payload = json!({ "text": format!("SSE test chunk {}", index + 1) });
    format!("data: {}\n\n", js_json_stringify(&payload))
}

/// `setInterval(..., 500)`: the first chunk lands after one interval, and the
/// third chunk, `[DONE]` and `end()` share the same tick.
pub const SSE_INTERVAL_MS: u64 = 500;
pub const SSE_CHUNK_COUNT: usize = 3;

/// The 503 body and the "unknown host op" answer never reach a client; the
/// gateway only uses these constants for claim-time header tests.
pub const TEST_SSE_CONTENT_TYPE: &str = "text/event-stream";

#[cfg(test)]
mod tests {
    use super::*;

    fn js(value: &Value) -> String {
        js_json_stringify(value)
    }

    #[test]
    fn trim_body_field_follows_js_coercion() {
        assert_eq!(trim_body_field(&json!({}), "raw").unwrap(), "");
        assert_eq!(trim_body_field(&json!({"raw": null}), "raw").unwrap(), "");
        assert_eq!(trim_body_field(&json!({"raw": ""}), "raw").unwrap(), "");
        assert_eq!(trim_body_field(&json!({"raw": 0}), "raw").unwrap(), "");
        assert_eq!(trim_body_field(&json!({"raw": false}), "raw").unwrap(), "");
        assert_eq!(
            trim_body_field(&json!({"raw": "  hi\u{3000}\u{00a0}\n"}), "raw").unwrap(),
            "hi"
        );
        // Truthy non-strings have no .trim.
        for value in [json!(5), json!(true), json!([1]), json!({"a": 1})] {
            let error = trim_body_field(&json!({"raw": value}), "raw").unwrap_err();
            assert_eq!(error.status_code(), 500);
            assert!(error.message().contains("trim is not a function"));
        }
        // Arrays have no keys either.
        assert_eq!(trim_body_field(&json!(["raw"]), "raw").unwrap(), "");
    }

    #[test]
    fn refine_prompt_matches_the_retired_template() {
        let prompt = refine_prompt(" 做一个登录页 ", &[]).unwrap();
        assert_eq!(
            prompt,
            "你是程序员语音输入助手。原始语音识别文字可能口语化、夹杂中英文。\n\
             任务：\n\
             1. 保留所有英文技术词汇/命令/API名（React, useState, git commit等）\n\
             2. 将口语转为专业简洁的程序员描述\n\
             3. 整理成清晰可操作的需求\n\
             4. 忠实原意，不臆造功能\n\
             \n原始语音： 做一个登录页 \n直接输出优化后的文本，不要任何解释或前缀。"
        );
        let with_examples = refine_prompt(
            "x",
            &[
                json!({"raw": "先做个按钮", "userFinal": "添加按钮"}),
                json!({"raw": 2}),
            ],
        )
        .unwrap();
        assert!(with_examples.contains(
            "\n\n历史优化案例（供参考）：\n[案例1] 原始：先做个按钮\n优化后：添加按钮\n[案例2] 原始：2\n优化后：undefined\n\n原始语音：x\n"
        ));
        assert_eq!(
            refine_prompt("", &[]).unwrap().matches('\n').count(),
            "你是程序员语音输入助手。原始语音识别文字可能口语化、夹杂中英文。\n任务：\n1. 保留所有英文技术词汇/命令/API名（React, useState, git commit等）\n2. 将口语转为专业简洁的程序员描述\n3. 整理成清晰可操作的需求\n4. 忠实原意，不臆造功能\n\n原始语音：\n直接输出优化后的文本，不要任何解释或前缀。"
                .matches('\n')
                .count()
        );
        // A null example throws before the prompt is sent.
        assert_eq!(
            refine_prompt("x", &[Value::Null])
                .unwrap_err()
                .status_code(),
            500
        );
    }

    #[test]
    fn refine_responses_keep_the_key_order() {
        let ok = refine_success(Some(&json!("优化后的文本")), 12);
        assert_eq!(js(&ok), r#"{"ok":true,"text":"优化后的文本","ms":12}"#);
        let empty = refine_success(Some(&json!("")), 0);
        assert_eq!(js(&empty), r#"{"ok":true,"text":"","ms":0}"#);
        let missing = refine_success(None, 0);
        assert_eq!(js(&missing), r#"{"ok":true,"text":"","ms":0}"#);
        let failure = refine_failure("boom", 7);
        assert_eq!(js(&failure), r#"{"ok":false,"text":"[错误: boom]","ms":7}"#);
    }

    #[test]
    fn aux_outcomes_follow_the_host_envelopes() {
        assert!(matches!(
            aux_outcome(&json!({"ok": true, "text": "t"})),
            AuxOutcome::Success(Some(_))
        ));
        assert!(matches!(
            aux_outcome(&json!({"ok": true})),
            AuxOutcome::Success(None)
        ));
        assert!(matches!(
            aux_outcome(&json!({"ok": false, "cancelled": true, "message": "x"})),
            AuxOutcome::Failure(ref message) if message == "cancelled"
        ));
        assert!(matches!(
            aux_outcome(&json!({"ok": false, "cancelled": false, "message": "boom"})),
            AuxOutcome::Failure(ref message) if message == "boom"
        ));
        assert!(matches!(
            aux_outcome(&json!({"ok": false, "message": ""})),
            AuxOutcome::Failure(ref message) if message.is_empty()
        ));
        assert!(matches!(
            aux_outcome(&json!({"ok": false})),
            AuxOutcome::Failure(ref message) if message == "undefined"
        ));
        assert!(matches!(
            aux_outcome(&json!({"text": "t"})),
            AuxOutcome::Invalid
        ));
        assert!(matches!(aux_outcome(&json!([1])), AuxOutcome::Invalid));
        assert_eq!(
            js(&aux_enqueue_payload("voice_refine", "p", "vr_1_ab")),
            r#"{"op":"auxEnqueue","type":"voice_refine","prompt":"p","meta":{"reqId":"vr_1_ab"}}"#
        );
        assert_eq!(js(&progress_empty()), r#"{"ok":true,"summary":""}"#);
        assert_eq!(
            js(&progress_success(Some(&json!("  完成了  ")), 4).unwrap()),
            r#"{"ok":true,"summary":"完成了","ms":4}"#
        );
        assert_eq!(
            js(&progress_success(None, 0).unwrap()),
            r#"{"ok":true,"summary":"","ms":0}"#
        );
        assert_eq!(
            progress_success(Some(&json!(5)), 0)
                .unwrap_err()
                .status_code(),
            500
        );
        // The retired handler put V8's whole-expression TypeError text in the
        // 500 body; the differential compares it byte for byte.
        assert_eq!(
            progress_success(Some(&json!(5)), 0).unwrap_err().message(),
            "(result.text || \"\").trim is not a function"
        );
    }

    #[test]
    fn feedback_applies_only_for_a_real_difference() {
        assert!(feedback_applies(
            &json!({"raw": "a", "refined": "b", "userFinal": "c"})
        ));
        assert!(!feedback_applies(
            &json!({"raw": "", "refined": "b", "userFinal": "c"})
        ));
        assert!(!feedback_applies(&json!({"raw": "a", "userFinal": "c"})));
        assert!(!feedback_applies(&json!({"raw": "a", "refined": null})));
        // null !== undefined, so a present null is a real value.
        assert!(feedback_applies(
            &json!({"raw": "a", "refined": null, "userFinal": "c"})
        ));
        assert!(!feedback_applies(
            &json!({"raw": "a", "refined": null, "userFinal": null})
        ));
        // Equal primitives are not a correction; objects never are equal.
        assert!(!feedback_applies(
            &json!({"raw": "a", "refined": "same", "userFinal": "same"})
        ));
        assert!(!feedback_applies(
            &json!({"raw": "a", "refined": 1, "userFinal": 1})
        ));
        assert!(!feedback_applies(
            &json!({"raw": "a", "refined": 1.0, "userFinal": 1})
        ));
        assert!(feedback_applies(
            &json!({"raw": "a", "refined": {"x": 1}, "userFinal": {"x": 1}})
        ));
        assert!(!feedback_applies(&json!(["raw"])));
        assert_eq!(
            js(&feedback_payload(
                &json!({"raw": "a", "refined": "b", "userFinal": "c", "x": 1})
            )),
            r#"{"op":"feedbackApply","raw":"a","refined":"b","userFinal":"c"}"#
        );
    }

    #[test]
    fn confirm_prompt_matches_the_template_literal() {
        let first = confirm_prompt(" 加个按钮 ", None, None);
        assert!(first.starts_with(CONFIRM_PROMPT_HEAD));
        assert!(first.contains("。\n\n用户本次的语音输入： 加个按钮 \n\n请输出严格的 JSON"));
        let fallback = confirm_prompt("", None, None);
        assert!(fallback.contains("用户本次的语音输入：（无新增，仅根据反馈调整）\n\n"));
        let with_context = confirm_prompt(
            "",
            Some(&json!({"summary": "s", "items": ["a"]})),
            Some(&json!("不对，应该是两个按钮")),
        );
        assert!(with_context.contains(
            "对齐。\n\n\n\n之前你给出的理解（JSON）：\n{\n  \"summary\": \"s\",\n  \"items\": [\n    \"a\"\n  ]\n}\n\n用户对此的语音反馈：不对，应该是两个按钮\n\n用户本次的语音输入："
        ));
        // A truthy non-string feedback goes through String().
        let numeric = confirm_prompt("", None, Some(&json!(5)));
        assert!(numeric.contains("用户对此的语音反馈：5\n\n"));
    }

    #[test]
    fn confirm_result_parses_greedily_and_falls_back() {
        let parsed = confirm_result(Some(&json!(
            "前置 {\"summary\":\"s\",\"items\":[\"a\"],\"allConfirmed\":true} 后缀"
        )))
        .unwrap();
        let body = confirm_response(parsed, 9);
        assert_eq!(
            js(&body),
            r#"{"ok":true,"summary":"s","items":["a"],"allConfirmed":true,"ms":9}"#
        );

        // Greedy: first `{` through the last `}`.
        let greedy = confirm_result(Some(&json!("{ \"a\": {\"b\": 1} }"))).unwrap();
        assert_eq!(js(&Value::Object(greedy)), r#"{"a":{"b":1}}"#);

        // Invalid JSON after a match falls back to the summary.
        let invalid = confirm_result(Some(&json!("{not json}"))).unwrap();
        assert_eq!(
            js(&confirm_response(invalid, 3)),
            r#"{"ok":true,"summary":"{not json}","items":[],"questions":[],"allConfirmed":false,"ms":3}"#
        );

        // No text at all.
        let empty = confirm_result(None).unwrap();
        assert_eq!(
            js(&confirm_response(empty, 0)),
            r#"{"ok":true,"summary":"","items":[],"questions":[],"allConfirmed":false,"ms":0}"#
        );
        let empty = confirm_result(Some(&json!(""))).unwrap();
        assert_eq!(empty["summary"], json!(""));

        // A falsy parse result cannot happen through the greedy match (a match
        // always parses to an object or throws), so text without braces simply
        // falls back with the whole trimmed text.
        for text in ["prefix 0 suffix", "prefix null suffix", "{ broken"] {
            let body = confirm_response(confirm_result(Some(&json!(text))).unwrap(), 1);
            assert_eq!(body["allConfirmed"], json!(false), "{text}");
            assert_eq!(body["summary"], json!(text.trim()), "{text}");
        }

        // Spread order: an `ok`/`ms` key from the model keeps its first spot
        // and overwrites the literal's `ok`, exactly like `{ ok:true, ...parsed, ms }`.
        let parsed =
            confirm_result(Some(&json!("{\"ms\":1,\"ok\":\"x\",\"summary\":\"s\"}"))).unwrap();
        assert_eq!(
            js(&confirm_response(parsed, 5)),
            r#"{"ok":"x","ms":5,"summary":"s"}"#
        );

        // `spread_object` also models the non-object shapes `{...x}` accepts,
        // though the greedy match can only ever yield an object.
        let mut spread = Map::new();
        spread_object(&mut spread, &json!("ab"));
        assert_eq!(js(&Value::Object(spread)), r#"{"0":"a","1":"b"}"#);
        let mut spread = Map::new();
        spread_object(&mut spread, &json!([7, 8]));
        assert_eq!(js(&Value::Object(spread)), r#"{"0":7,"1":8}"#);
        let mut spread = Map::new();
        spread_object(&mut spread, &json!(5));
        assert!(spread.is_empty());

        // A truthy non-string text throws inside the try.
        let error = confirm_result(Some(&json!(5))).unwrap_err();
        assert_eq!(error.status_code(), 500);
        assert!(error.message().contains("match"));
    }

    #[test]
    fn progress_events_follow_the_template() {
        let events = vec![
            json!({"type": "tool", "summary": "读取文件"}),
            json!({"type": "", "text": "42"}),
            json!({"summary": "无类型"}),
            json!(["a", "b"]),
            json!("str"),
            json!(true),
            json!({}),
        ];
        let rendered = progress_events_str(&events).unwrap();
        assert_eq!(
            rendered,
            "1. [tool] 读取文件\n\
             2. [?] 42\n\
             3. [?] 无类型\n\
             4. [?] [\"a\",\"b\"]\n\
             5. [?] \"str\"\n\
             6. [?] true\n\
             7. [?] {}"
        );
        // A null event throws at `e.type`.
        assert_eq!(
            progress_events_str(&[Value::Null])
                .unwrap_err()
                .status_code(),
            500
        );
        // A truthy non-sliceable summary or text throws (numbers have no slice).
        assert_eq!(
            progress_events_str(&[json!({"summary": 5})])
                .unwrap_err()
                .status_code(),
            500
        );
        assert_eq!(
            progress_events_str(&[json!({"text": 5})])
                .unwrap_err()
                .status_code(),
            500
        );
        // 300 UTF-16 units; a cut through a surrogate pair becomes U+FFFD.
        let emoji = "😀";
        let long = format!("x{}", emoji.repeat(200));
        let rendered = progress_events_str(&[json!({"type": "t", "summary": long})]).unwrap();
        let body = rendered.trim_start_matches("1. [t] ");
        assert_eq!(utf16_len(body), 300);
        assert!(body.ends_with('\u{FFFD}'));
        assert!(
            utf16_len(&progress_events_str(&[json!({"summary": emoji.repeat(400)})]).unwrap())
                > 300
        );
        let prompt = progress_prompt("1. [x] y", None);
        assert!(prompt.contains("任务描述：编程任务\n\n最近的进展事件：\n1. [x] y\n\n要求："));
        let prompt = progress_prompt("e", Some(&json!("做登录页")));
        assert!(prompt.contains("任务描述：做登录页\n"));
        let prompt = progress_prompt("e", Some(&json!(0)));
        assert!(prompt.contains("任务描述：编程任务\n"));
    }

    #[test]
    fn readiness_matches_the_js_helper() {
        let local = readiness_body(&json!({
            "localAvailable": true,
            "download": null,
            "cloudKeys": {"whisper": false, "openrouter": false},
            "streaming": null,
        }))
        .unwrap();
        assert_eq!(
            js(&local),
            r#"{"ready":true,"engine":"local","reason":null,"cloudConfigured":false,"download":null}"#
        );

        let cloud = readiness_body(&json!({
            "localAvailable": false,
            "download": {"state": "downloading", "progress": 3},
            "cloudKeys": {"whisper": false, "openrouter": true},
            "streaming": {},
        }))
        .unwrap();
        assert_eq!(
            js(&cloud),
            r#"{"ready":true,"engine":"cloud","reason":null,"cloudConfigured":true,"download":{"state":"downloading","progress":3}}"#
        );

        for (provider, ready) in [("openai", true), ("volcano", true), ("funasr", true)] {
            let body = readiness_body(&json!({
                "localAvailable": false,
                "download": null,
                "cloudKeys": {},
                "streaming": {provider: {"ready": ready}},
            }))
            .unwrap();
            assert_eq!(body["engine"], json!("cloud"), "{provider}");
        }
        // A present but not-ready entry, or a non-object entry, is not cloud.
        for streaming in [
            json!({"openai": {"ready": false}}),
            json!({"openai": "yes"}),
            json!({"openai": null}),
        ] {
            let body = readiness_body(&json!({
                "localAvailable": false,
                "download": null,
                "cloudKeys": {},
                "streaming": streaming,
            }))
            .unwrap();
            assert_eq!(body["engine"], Value::Null);
            assert_eq!(body["reason"], json!("missing"));
        }

        for (state, reason) in [
            ("downloading", "downloading"),
            ("failed", "failed"),
            ("unsupported", "unsupported"),
            ("disabled", "disabled"),
            ("weird", "missing"),
        ] {
            let body = readiness_body(&json!({
                "localAvailable": false,
                "download": {"state": state},
                "cloudKeys": {},
                "streaming": null,
            }))
            .unwrap();
            assert_eq!(body["reason"], json!(reason), "{state}");
        }
        // download absent is omitted; download null stays null.
        let body = readiness_body(&json!({
            "localAvailable": false,
            "cloudKeys": {},
        }))
        .unwrap();
        assert_eq!(
            js(&body),
            r#"{"ready":false,"engine":null,"reason":"missing","cloudConfigured":false}"#
        );
        assert!(readiness_body(&json!({"cloudKeys": {}})).is_none());
    }

    #[test]
    fn hotwords_and_vocab_shapes() {
        assert_eq!(
            js(&hotwords_body(&json!({"present": false, "enabled": true})).unwrap()),
            r#"{"enabled":false}"#
        );
        // The snapshot spread comes after `enabled`, so a snapshot `enabled`
        // wins exactly like `{ enabled: !!x, ...snapshot() }`.
        assert_eq!(
            js(&hotwords_body(&json!({
                "present": true,
                "enabled": 1,
                "snapshot": {"terms": ["a"], "enabled": false},
            }))
            .unwrap()),
            r#"{"enabled":false,"terms":["a"]}"#
        );
        assert!(hotwords_body(&json!({"present": true, "snapshot": "x"})).is_none());
        assert!(hotwords_body(&json!({"enabled": false})).is_none());
        assert_eq!(
            js(&hotwords_reject_payload(
                &json!({"term": "多西", "alias": "doc"})
            )),
            r#"{"op":"hotwordsReject","term":"多西","alias":"doc"}"#
        );
        assert_eq!(
            js(&hotwords_reject_payload(&json!({"term": null}))),
            r#"{"op":"hotwordsReject","term":null}"#
        );
        assert_eq!(
            js(&hotwords_reject_payload(&json!({}))),
            r#"{"op":"hotwordsReject"}"#
        );
        assert_eq!(
            hotwords_reject_result(&json!({"present": true, "accepted": false})),
            Some((true, false))
        );
        assert_eq!(hotwords_reject_result(&json!({"present": true})), None);
        assert_eq!(
            js(&hotwords_reject_denied()),
            r#"{"ok":false,"error":"term required"}"#
        );
        assert_eq!(
            js(&vocab_body(&json!({"vocab": [{"term": "a"}]})).unwrap()),
            r#"[{"term":"a"}]"#
        );
        assert!(vocab_body(&json!({"vocab": "x"})).is_none());
        assert_eq!(vocab_delete_target("ÄBC O"), "äbc o");
        assert_eq!(
            js(&vocab_delete_body(&json!({"remaining": 2})).unwrap()),
            r#"{"ok":true,"remaining":2}"#
        );
        assert!(vocab_delete_body(&json!({"remaining": "2"})).is_none());
    }

    #[test]
    fn settings_dto_assembles_the_frozen_shape() {
        let facts = json!({
            "env": {
                "OPENROUTER_API_KEY": "sk-1234567890abcdef",
                "WHISPER_API_KEY": "wk-abcdefghijklmn",
                "QWEN_AUDIO_DASHSCOPE_API_KEY": "qwen-1234567890",
                "ASR_PROVIDER": "",
                "TTS_PROVIDER": "edge",
            },
            "runtime": {
                "OPENROUTER_MODEL": "model-x",
                "OPENROUTER_BASE_URL": "",
                "DASHSCOPE_API_KEY": "runtime-qwen-1234567890",
                "OPENAI_API_KEY": "oai-key",
            },
            "asrStatus": {"local": {"available": false}},
            "ttsStatus": null,
            "qwenRuntime": {"state": "ready"},
        });
        let body = settings_dto(&facts).unwrap();
        assert_eq!(body["apiKey"], json!("sk-12345****cdef"));
        assert_eq!(body["hasKey"], json!(true));
        assert_eq!(body["whisperApiKey"], json!("wk-abcde****klmn"));
        assert_eq!(body["hasWhisperKey"], json!(true));
        assert_eq!(body["model"], json!("model-x"));
        // Empty string in the env file falls through to the default.
        assert_eq!(body["baseUrl"], json!("https://openrouter.ai/api/v1"));
        // Empty ASR_PROVIDER is falsy.
        assert_eq!(body["asr"]["provider"], json!("auto"));
        assert_eq!(
            body["asr"]["status"],
            json!({"local": {"available": false}})
        );
        assert_eq!(
            body["asr"]["openaiUrl"],
            json!("wss://api.openai.com/v1/realtime")
        );
        assert_eq!(body["asr"]["openaiModel"], json!("gpt-4o-transcribe"));
        assert_eq!(body["asr"]["hasOpenaiKey"], json!(false));
        assert_eq!(
            body["asr"]["volcResourceId"],
            json!("volc.bigasr.sauc.duration")
        );
        assert_eq!(body["asr"]["funasrMode"], json!("2pass"));
        assert_eq!(body["asr"]["funasrUrl"], json!(""));
        assert_eq!(body["tts"]["status"], Value::Null);
        assert_eq!(body["tts"]["hasOpenaiKey"], json!(true));
        assert_eq!(body["tts"]["edgeVoice"], json!("zh-CN-XiaoxiaoNeural"));
        assert_eq!(
            body["tts"]["volcanoVoice"],
            json!("zh_female_shuangkuaisisi_moon_bigtts")
        );
        // The env-file Qwen key wins over the runtime DASHSCOPE_API_KEY.
        assert_eq!(body["qwenAudio"]["apiKey"], json!("qwen-1****7890"));
        assert_eq!(body["qwenAudio"]["hasApiKey"], json!(true));
        assert_eq!(
            body["qwenAudio"]["model"],
            json!("qwen-audio-3.0-realtime-plus")
        );
        assert_eq!(body["qwenAudio"]["voice"], json!("longanqian"));
        assert_eq!(
            body["qwenAudio"]["baseUrl"],
            json!("wss://dashscope.aliyuncs.com/api-ws/v1/realtime")
        );
        assert_eq!(body["qwenAudio"]["runtime"], json!({"state": "ready"}));
        // Exact key order for the top level and each nested object.
        let keys: Vec<&str> = body
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            [
                "baseUrl",
                "apiKey",
                "model",
                "hasKey",
                "whisperBaseUrl",
                "whisperApiKey",
                "whisperModel",
                "hasWhisperKey",
                "whisperLanguage",
                "whisperPrompt",
                "asr",
                "tts",
                "qwenAudio"
            ]
        );
        let asr_keys: Vec<&str> = body["asr"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            asr_keys,
            [
                "provider",
                "status",
                "openaiUrl",
                "openaiModel",
                "hasOpenaiKey",
                "volcUrl",
                "volcResourceId",
                "hasVolcAppId",
                "hasVolcToken",
                "funasrUrl",
                "funasrMode"
            ]
        );
        let tts_keys: Vec<&str> = body["tts"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            tts_keys,
            [
                "provider",
                "status",
                "edgeVoice",
                "openaiVoice",
                "hasOpenaiKey",
                "volcanoVoice",
                "hasVolcanoAppId",
                "hasVolcanoToken"
            ]
        );
        let qwen_keys: Vec<&str> = body["qwenAudio"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            qwen_keys,
            [
                "hasApiKey",
                "apiKey",
                "model",
                "voice",
                "baseUrl",
                "runtime"
            ]
        );
    }

    #[test]
    fn settings_dto_omits_undefined_status_and_runtime() {
        let body = settings_dto(&json!({"env": {}, "runtime": {}})).unwrap();
        assert!(body["asr"].as_object().unwrap().get("status").is_none());
        assert!(body["tts"].as_object().unwrap().get("status").is_none());
        assert!(body["qwenAudio"]
            .as_object()
            .unwrap()
            .get("runtime")
            .is_none());
        assert_eq!(body["apiKey"], json!(""));
        assert_eq!(body["hasKey"], json!(false));
        assert_eq!(body["whisperPrompt"], json!(""));
        assert_eq!(body["asr"]["hasVolcAppId"], json!(false));
        // Missing facts are a stale host, not an empty panel.
        assert!(settings_dto(&json!({})).is_none());
        assert!(settings_dto(&json!({"env": {}})).is_none());
        assert!(settings_dto(&json!({"env": "x", "runtime": {}})).is_none());
    }

    #[test]
    fn settings_updates_preserve_field_order_and_echo_guards() {
        let updates = settings_updates(&json!({
            "baseUrl": "https://x/api/v1",
            "apiKey": "sk-live",
            "model": "m",
            "whisperBaseUrl": "https://w",
            "whisperApiKey": ["****"],
            "whisperModel": "wm",
            "whisperLanguage": "en",
            "whisperPrompt": "p",
            "asr": {
                "provider": "openai",
                "openaiApiKey": "key****",
                "openaiUrl": "wss://o",
                "openaiModel": "om",
                "volcAppId": "app",
                "volcAccessToken": "tok",
                "volcResourceId": "res",
                "volcUrl": "wss://v",
                "funasrUrl": "ws://f",
                "funasrMode": "online",
            },
            "tts": {
                "provider": "openai",
                "edgeVoice": "ev",
                "openaiApiKey": "otk",
                "openaiUrl": "wss://t",
                "openaiModel": "tm",
                "openaiVoice": "voice",
                "volcanoAppId": "vapp",
                "volcanoToken": "vtok",
                "volcanoUrl": "wss://vt",
                "volcanoVoice": "vv",
            },
            "qwenAudio": {
                "apiKey": "  qwen-key  ",
                "model": " qwen-model ",
                "voice": " qwen-voice ",
                "baseUrl": "wss://dashscope.example.com/realtime??",
            },
            "ignored": 1,
        }))
        .unwrap();
        let keys: Vec<&str> = updates.keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            [
                "OPENROUTER_BASE_URL",
                "OPENROUTER_API_KEY",
                "OPENROUTER_MODEL",
                "WHISPER_BASE_URL",
                "WHISPER_MODEL",
                "WHISPER_LANGUAGE",
                "WHISPER_PROMPT",
                "ASR_PROVIDER",
                "OPENAI_REALTIME_URL",
                "OPENAI_REALTIME_MODEL",
                "VOLC_ASR_APP_ID",
                "VOLC_ASR_ACCESS_TOKEN",
                "VOLC_ASR_RESOURCE_ID",
                "VOLC_ASR_URL",
                "FUNASR_WS_URL",
                "FUNASR_MODE",
                "TTS_PROVIDER",
                "EDGE_TTS_VOICE",
                "OPENAI_TTS_API_KEY",
                "OPENAI_TTS_URL",
                "OPENAI_TTS_MODEL",
                "OPENAI_TTS_VOICE",
                "VOLC_TTS_APP_ID",
                "VOLC_TTS_ACCESS_TOKEN",
                "VOLC_TTS_URL",
                "VOLC_TTS_VOICE",
                "QWEN_AUDIO_DASHSCOPE_API_KEY",
                "QWEN_AUDIO_REALTIME_MODEL",
                "QWEN_AUDIO_REALTIME_VOICE",
                "QWEN_AUDIO_REALTIME_BASE_URL",
            ]
        );
        assert!(updates.get("WHISPER_API_KEY").is_none());
        assert!(updates.get("OPENAI_REALTIME_API_KEY").is_none());
        assert_eq!(updates["QWEN_AUDIO_DASHSCOPE_API_KEY"], json!("qwen-key"));
        assert_eq!(updates["QWEN_AUDIO_REALTIME_MODEL"], json!("qwen-model"));
        assert_eq!(updates["QWEN_AUDIO_REALTIME_VOICE"], json!("qwen-voice"));
        assert_eq!(
            updates["QWEN_AUDIO_REALTIME_BASE_URL"],
            json!("wss://dashscope.example.com/realtime")
        );
        assert_eq!(
            js(&settings_apply_payload(updates)),
            r#"{"op":"settingsApply","updates":{"OPENROUTER_BASE_URL":"https://x/api/v1","OPENROUTER_API_KEY":"sk-live","OPENROUTER_MODEL":"m","WHISPER_BASE_URL":"https://w","WHISPER_MODEL":"wm","WHISPER_LANGUAGE":"en","WHISPER_PROMPT":"p","ASR_PROVIDER":"openai","OPENAI_REALTIME_URL":"wss://o","OPENAI_REALTIME_MODEL":"om","VOLC_ASR_APP_ID":"app","VOLC_ASR_ACCESS_TOKEN":"tok","VOLC_ASR_RESOURCE_ID":"res","VOLC_ASR_URL":"wss://v","FUNASR_WS_URL":"ws://f","FUNASR_MODE":"online","TTS_PROVIDER":"openai","EDGE_TTS_VOICE":"ev","OPENAI_TTS_API_KEY":"otk","OPENAI_TTS_URL":"wss://t","OPENAI_TTS_MODEL":"tm","OPENAI_TTS_VOICE":"voice","VOLC_TTS_APP_ID":"vapp","VOLC_TTS_ACCESS_TOKEN":"vtok","VOLC_TTS_URL":"wss://vt","VOLC_TTS_VOICE":"vv","QWEN_AUDIO_DASHSCOPE_API_KEY":"qwen-key","QWEN_AUDIO_REALTIME_MODEL":"qwen-model","QWEN_AUDIO_REALTIME_VOICE":"qwen-voice","QWEN_AUDIO_REALTIME_BASE_URL":"wss://dashscope.example.com/realtime"}}"#
        );

        // `****` echo on a top-level apiKey is dropped; other non-strings throw.
        assert!(settings_updates(&json!({"apiKey": "sk****"}))
            .unwrap()
            .is_empty());
        assert!(settings_updates(&json!({"apiKey": ["x", "****"]}))
            .unwrap()
            .get("OPENROUTER_API_KEY")
            .is_none());
        assert_eq!(
            settings_updates(&json!({"apiKey": 5}))
                .unwrap_err()
                .status_code(),
            500
        );
        assert_eq!(
            settings_updates(&json!({"whisperApiKey": null}))
                .unwrap_err()
                .status_code(),
            500
        );
        // An array without the marker is a value, like JS includes().
        assert_eq!(
            settings_updates(&json!({"apiKey": ["a"]})).unwrap()["OPENROUTER_API_KEY"],
            json!(["a"])
        );
        assert!(settings_updates(&json!({})).unwrap().is_empty());
        assert!(settings_updates(&json!([1])).unwrap().is_empty());
    }

    #[test]
    fn qwen_audio_validation_matches_the_retired_handler() {
        // clearApiKey wins over apiKey.
        let updates = settings_updates(&json!({
            "qwenAudio": {"clearApiKey": true, "apiKey": "new-key"},
        }))
        .unwrap();
        assert_eq!(updates["QWEN_AUDIO_DASHSCOPE_API_KEY"], Value::Null);
        // apiKey with `****` is dropped; with clearApiKey false it is applied.
        assert!(
            settings_updates(&json!({"qwenAudio": {"apiKey": "abc****def"}}))
                .unwrap()
                .is_empty()
        );
        let updates = settings_updates(&json!({
            "qwenAudio": {"clearApiKey": false, "apiKey": " k "},
        }))
        .unwrap();
        assert_eq!(updates["QWEN_AUDIO_DASHSCOPE_API_KEY"], json!("k"));
        // Non-string apiKey goes through String() for the view, then fails.
        let error = settings_updates(&json!({"qwenAudio": {"apiKey": 5}})).unwrap_err();
        assert_eq!(error.message(), "invalid qwenAudio.apiKey");
        assert_eq!(error.status_code(), 400);
        assert_eq!(
            settings_updates(&json!({"qwenAudio": {"apiKey": 5.5}}))
                .unwrap_err()
                .message(),
            "invalid qwenAudio.apiKey"
        );

        // Control characters and length caps.
        for (field, value) in [
            ("apiKey", json!("a\nb")),
            ("apiKey", json!("a\rb")),
            ("apiKey", json!("a\u{0}b")),
            ("apiKey", json!("x".repeat(513))),
            ("model", json!("x".repeat(161))),
            ("voice", json!("x".repeat(81))),
            ("baseUrl", json!(format!("wss://h/{}", "x".repeat(500)))),
        ] {
            let error = settings_updates(&json!({"qwenAudio": {field: value}})).unwrap_err();
            assert_eq!(error.status_code(), 400, "{field}");
            assert_eq!(
                error.message(),
                format!("invalid qwenAudio.{field}"),
                "{field}"
            );
        }
        // The length cap counts UTF-16 units, not bytes.
        assert!(settings_updates(&json!({"qwenAudio": {"model": "😀".repeat(80)}})).is_ok());
        assert_eq!(
            settings_updates(&json!({"qwenAudio": {"model": "😀".repeat(81)}}))
                .unwrap_err()
                .message(),
            "invalid qwenAudio.model"
        );

        // URL rules.
        for ok in [
            "wss://dashscope.example.com/realtime",
            "wss://127.0.0.1/x",
            "ws://127.0.0.1:8765/x",
            "ws://localhost/x",
            "ws://[::1]:1234/x",
            "ws://LOCALHOST/x",
        ] {
            assert!(
                settings_updates(&json!({"qwenAudio": {"baseUrl": ok}})).is_ok(),
                "{ok}"
            );
        }
        for bad in [
            "http://localhost/x",
            "ws://example.com/x",
            "ftp://localhost/",
        ] {
            let error = settings_updates(&json!({"qwenAudio": {"baseUrl": bad}})).unwrap_err();
            assert_eq!(
                error.message(),
                "qwenAudio.baseUrl requires wss or loopback ws",
                "{bad}"
            );
        }
        for invalid in ["", "not a url", "wss://", "ws://127.0.0.1:99999/x"] {
            let error = settings_updates(&json!({"qwenAudio": {"baseUrl": invalid}})).unwrap_err();
            assert_eq!(error.message(), "invalid qwenAudio.baseUrl", "{invalid}");
        }
        // Trailing question marks are stripped after validation.
        let updates = settings_updates(&json!({
            "qwenAudio": {"baseUrl": "wss://h/p?x=1???"},
        }))
        .unwrap();
        assert_eq!(
            updates["QWEN_AUDIO_REALTIME_BASE_URL"],
            json!("wss://h/p?x=1")
        );
        // A pb with a control character never reaches the URL parser.
        assert_eq!(
            settings_updates(&json!({"qwenAudio": {"baseUrl": "wss://h/\n"}}))
                .unwrap_err()
                .message(),
            "invalid qwenAudio.baseUrl"
        );
        // `qwenAudio` that is not an object behaves like {}.
        assert!(settings_updates(&json!({"qwenAudio": 5}))
            .unwrap()
            .is_empty());
        assert!(settings_updates(&json!({"qwenAudio": null}))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn asr_model_action_and_bodies() {
        assert_eq!(asr_action(&json!({})), "download");
        assert_eq!(asr_action(&json!({"action": null})), "download");
        assert_eq!(asr_action(&json!({"action": ""})), "download");
        assert_eq!(asr_action(&json!({"action": "cancel"})), "cancel");
        assert_eq!(asr_action(&json!({"action": 0})), "download");
        assert_eq!(asr_action(&json!({"action": "x"})), "x");
        assert_eq!(asr_action(&json!(["cancel"])), "download");
        assert_eq!(
            js(&asr_cancel_body(&json!({"cancelled": true, "status": {"state": "idle"}})).unwrap()),
            r#"{"ok":true,"cancelled":true,"status":{"state":"idle"}}"#
        );
        assert_eq!(
            js(&asr_cancel_body(&json!({"status": null})).unwrap()),
            r#"{"ok":true,"status":null}"#
        );
        assert_eq!(
            js(&asr_status_body(&json!({"status": {"state": "downloading"}})).unwrap()),
            r#"{"ok":true,"status":{"state":"downloading"}}"#
        );
        assert!(asr_status_body(&json!({})).is_none());
    }

    #[test]
    fn req_ids_and_frames_match_the_js_spelling() {
        // Math.random().toString(36).slice(2, 6) for representative doubles.
        assert_eq!(req_id("vr_", 1700000000000, 0.5), "vr_1700000000000_i");
        assert_eq!(req_id("s2s_c_", 1, 0.0), "s2s_c_1_");
        assert_eq!(random_suffix(0.25), "9");
        assert_eq!(random_suffix(0.123456789).len(), 4);
        assert!(random_suffix(f64::NAN).is_empty());
        assert_eq!(sse_frame(0), "data: {\"text\":\"SSE test chunk 1\"}\n\n");
        assert_eq!(sse_frame(2), "data: {\"text\":\"SSE test chunk 3\"}\n\n");
        assert_eq!(sse_frame(3), "data: [DONE]\n\n");
        assert_eq!(sse_frame(9), "data: [DONE]\n\n");
    }

    #[test]
    fn host_errors_keep_status_code_and_message() {
        let error = host_error(&json!({"message": "invalid x", "statusCode": 400})).unwrap();
        assert_eq!(error.message(), "invalid x");
        assert_eq!(error.status_code(), 400);
        assert_eq!(
            host_error(&json!({"message": "boom"}))
                .unwrap()
                .status_code(),
            500
        );
        assert_eq!(
            host_error(&json!({"message": "boom", "statusCode": null}))
                .unwrap()
                .status_code(),
            500
        );
        assert_eq!(
            host_error(&json!({"message": "boom", "statusCode": "400"}))
                .unwrap()
                .status_code(),
            500
        );
        assert_eq!(
            host_error(&json!({"message": "boom", "statusCode": 42}))
                .unwrap()
                .status_code(),
            500
        );
        assert_eq!(
            host_error(&json!({"message": "boom", "statusCode": 599}))
                .unwrap()
                .status_code(),
            599
        );
        // Non-string messages go through String(), missing ones read "undefined".
        assert_eq!(host_error(&json!({"message": 5})).unwrap().message(), "5");
        assert_eq!(host_error(&json!({})).unwrap().message(), "undefined");
        assert!(host_error(&json!("boom")).is_none());
        assert!(host_error(&Value::Null).is_none());
        assert_eq!(
            js(&unavailable_body()),
            r#"{"error":"语音接口尚未就绪，请更新原生模块","code":"rust_backend_unavailable"}"#
        );
        assert!(NOT_READY.starts_with("voice"));
        assert_eq!(TEST_SSE_CONTENT_TYPE, "text/event-stream");
        assert_eq!(SSE_INTERVAL_MS, 500);
        assert_eq!(SSE_CHUNK_COUNT, 3);
    }

    #[test]
    fn settings_fact_keys_are_the_host_whitelist() {
        let payload = settings_facts_payload();
        assert_eq!(payload["op"], json!("settingsFacts"));
        let keys = payload["keys"].as_array().unwrap();
        assert_eq!(keys.len(), SETTINGS_FACT_KEYS.len());
        assert_eq!(keys[0], json!("OPENROUTER_API_KEY"));
        assert_eq!(keys[keys.len() - 1], json!("VOLC_TTS_ACCESS_TOKEN"));
        assert_eq!(
            keys.iter()
                .filter(|key| key == &&json!("OPENAI_API_KEY"))
                .count(),
            1
        );
    }

    #[test]
    fn greedy_match_and_spread_edge_cases() {
        assert_eq!(greedy_json_object("{}"), Some("{}"));
        assert_eq!(greedy_json_object("{}{}"), Some("{}{}"));
        assert_eq!(greedy_json_object("} {}"), Some("{}"));
        assert_eq!(greedy_json_object("}"), None);
        assert_eq!(greedy_json_object("{} }"), Some("{} }"));
        assert_eq!(greedy_json_object("no braces"), None);
        // A falsy but valid parse value takes the fallback; a truthy array spreads.
        let parsed = confirm_result(Some(&json!("{\"a\":1}"))).unwrap();
        assert_eq!(
            js(&confirm_response(parsed, 0)),
            r#"{"ok":true,"a":1,"ms":0}"#
        );
        let parsed = confirm_result(Some(&json!("[ ]"))).unwrap();
        assert_eq!(
            js(&confirm_response(parsed, 0)),
            r#"{"ok":true,"summary":"[ ]","items":[],"questions":[],"allConfirmed":false,"ms":0}"#
        );
        let parsed = confirm_result(Some(&json!("{\"summary\":\"只有摘要\"}"))).unwrap();
        assert!(parsed.get("items").is_none());
    }
}
