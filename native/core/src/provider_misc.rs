//! Rule kernels for the last provider routes retired from Node
//! (`src/routes/providers.js`, `src/providers/speedtest-request.js`,
//! `src/routes/auto-provider-routing-test.js`, `server.js`):
//!
//! * `POST /api/providers/:appType/:id/speedtest` — which model a line should
//!   probe, the loopback request body, and how one collected upstream answer
//!   becomes the route's JSON DTO;
//! * `GET /api/v1/providers` — [`to_provider_dto`], the public projection of one
//!   provider summary (field order included) plus the API metadata envelope;
//! * `POST /api/auto-provider/routing/test` — the Jev wire contract (questions,
//!   tier ladder, escalation policy) and the route's response mapping.
//!
//! Every rule here used to live in the deleted JavaScript. Node keeps only the
//! provider store and summaries, the vault, and the account/catalog facts; the
//! front door asks for those through one host port and applies these rules.

use serde_json::{json, Map, Value};

use crate::js::serde::{js_string, js_trim, truthy, value_or_empty};
use crate::js::string::utf16_prefix;
use crate::provider_registry::relay_route_from_base_url;
use crate::public_safety::{public_error, safe_code, sanitize_public_text};

// ── `GET /api/v1/providers` ────────────────────────────────────────────────

const PROVIDER_DTO_CLIS: &[&str] = &[
    "claude",
    "claude-exp",
    "codex",
    "codex-exp",
    "opencode",
    "zcode",
    "kimi",
    "dsh",
    "grok",
];

fn slice_text(value: &Value, max: usize) -> String {
    let text = js_string(value);
    utf16_prefix(&text, max)
}

/// `toProviderDto(source)` from `src/api-contract.js`, key order included.
/// `Err` is the `TypeError` the retired handler threw (Express answered 500).
pub fn to_provider_dto(source: &Value) -> Result<Value, String> {
    let app_type = if source.get("appType").and_then(Value::as_str) == Some("codex") {
        "codex"
    } else {
        "claude"
    };
    let protocol = if app_type == "codex" {
        "openai_responses"
    } else {
        "anthropic"
    };
    let id = value_or_empty(source.get("id"));
    let wire_api = match source.get("wireApi").and_then(Value::as_str) {
        Some(text @ ("messages" | "responses")) => Value::String(text.to_string()),
        _ => Value::Null,
    };
    let name = source
        .get("name")
        .map(|value| slice_text(value, 160))
        .unwrap_or_default();
    let model = match source.get("model") {
        Some(Value::String(text)) if !text.is_empty() => {
            Value::String(slice_text(&Value::String(text.clone()), 160))
        }
        _ => Value::Null,
    };
    let mut options: Vec<Value> = Vec::new();
    if let Some(Value::Array(items)) = source.get("modelOptions") {
        let mut seen: Vec<String> = Vec::new();
        for item in items {
            let Value::String(_) = item else { continue };
            let text = slice_text(item, 160);
            if seen.contains(&text) {
                continue;
            }
            seen.push(text.clone());
            options.push(Value::String(text));
            if options.len() == 100 {
                break;
            }
        }
    }
    let compatible_clis: Vec<Value> = match source.get("compatibleClis") {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_str)
            .filter(|text| PROVIDER_DTO_CLIS.contains(text))
            .map(|text| Value::String(text.to_string()))
            .collect(),
        _ => Vec::new(),
    };
    let source_kind = if source.get("source").and_then(Value::as_str) == Some("ccswitch") {
        "ccswitch"
    } else {
        "local"
    };
    let mut dto = Map::new();
    dto.insert("id".into(), Value::String(id.clone()));
    dto.insert("appType".into(), Value::String(app_type.into()));
    dto.insert("protocol".into(), Value::String(protocol.into()));
    dto.insert("apiFormat".into(), Value::String(protocol.into()));
    dto.insert("wireApi".into(), wire_api);
    dto.insert("name".into(), Value::String(name.clone()));
    dto.insert("source".into(), Value::String(source_kind.into()));
    dto.insert("model".into(), model);
    dto.insert("modelOptions".into(), Value::Array(options));
    dto.insert(
        "aliasOnly".into(),
        Value::Bool(source.get("aliasOnly").is_some_and(truthy)),
    );
    dto.insert("compatibleClis".into(), Value::Array(compatible_clis));
    dto.insert(
        "hasCredentials".into(),
        Value::Bool(source.get("hasToken").is_some_and(truthy)),
    );
    dto.insert(
        "isOfficial".into(),
        Value::Bool(source.get("isOfficial").is_some_and(truthy)),
    );
    if id.is_empty() || name.is_empty() {
        return Err("provider DTO requires id and name".to_string());
    }
    Ok(Value::Object(dto))
}

/// `withApiMeta({...payload, apiVersion, requestId, correlationId})`.
pub fn api_meta(payload: Map<String, Value>, request_id: &str, correlation_id: &str) -> Value {
    let mut body = payload;
    body.insert("apiVersion".into(), Value::String("v1".into()));
    body.insert("requestId".into(), Value::String(request_id.into()));
    body.insert(
        "correlationId".into(),
        Value::String(if correlation_id.is_empty() {
            request_id.to_string()
        } else {
            correlation_id.to_string()
        }),
    );
    Value::Object(body)
}

// ── speed test: model selection ────────────────────────────────────────────

/// `claude-opus-5[1m]` is a CLI context suffix; the wire only accepts the id.
pub fn wire_model_id(value: &Value) -> String {
    let model = js_trim(&value_or_empty(Some(value))).to_string();
    let trimmed = model.trim_end();
    let stripped = match (trimmed.rfind('['), trimmed.ends_with(']')) {
        (Some(start), true) => js_trim(&trimmed[..start]).to_string(),
        _ => trimmed.to_string(),
    };
    stripped
}

/// `preferredSpeedtestModel(values)`: haiku first, otherwise the first model.
pub fn preferred_speedtest_model(values: Option<&Value>) -> String {
    let items: &[Value] = match values {
        Some(Value::Array(items)) => items,
        _ => &[],
    };
    let models: Vec<String> = items
        .iter()
        .map(wire_model_id)
        .filter(|model| !model.is_empty())
        .collect();
    if models.is_empty() {
        return String::new();
    }
    let mut unique: Vec<&String> = Vec::new();
    for model in &models {
        if !unique.contains(&model) {
            unique.push(model);
        }
    }
    unique
        .iter()
        .find(|model| model.to_ascii_lowercase().contains("haiku"))
        .map(|model| (*model).clone())
        .unwrap_or_else(|| unique[0].clone())
}

fn explicit_model(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(text)) => {
            let trimmed = js_trim(text);
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        }
        _ => None,
    }
}

/// `claudeSpeedtestModel(env, summary)`: explicit env/model, then the provider's
/// catalog, then (borrowed relay only) the CLI fallback list the lender serves.
pub fn claude_speedtest_model(
    env: &Value,
    summary: &Value,
    fallback_models: Option<&Value>,
) -> String {
    let explicit = [
        env.get("ANTHROPIC_MODEL"),
        env.get("ANTHROPIC_DEFAULT_HAIKU_MODEL"),
        env.get("ANTHROPIC_DEFAULT_SONNET_MODEL"),
        summary.get("model"),
    ]
    .into_iter()
    .find_map(explicit_model);
    if let Some(model) = explicit {
        return model;
    }
    let from_catalog = preferred_speedtest_model(summary.get("modelOptions"));
    if !from_catalog.is_empty() {
        return from_catalog;
    }
    if relay_route_from_base_url(env.get("ANTHROPIC_BASE_URL")).is_some() {
        return preferred_speedtest_model(fallback_models);
    }
    String::new()
}

/// `summary.model || (summary.modelOptions || [])[0]`, or null.
pub fn official_codex_model(summary: &Value) -> Option<Value> {
    if let Some(model) = summary.get("model").filter(|item| truthy(item)) {
        return Some(model.clone());
    }
    summary
        .get("modelOptions")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .filter(|item| truthy(item))
        .cloned()
}

/// `(target.modelOptions && target.modelOptions[0]) || target.model || 'gpt-4o-mini'`.
pub fn codex_speedtest_model(target: &Value) -> Value {
    if let Some(model) = target
        .get("modelOptions")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .filter(|item| truthy(item))
    {
        return model.clone();
    }
    if let Some(model) = target.get("model").filter(|item| truthy(item)) {
        return model.clone();
    }
    Value::String("gpt-4o-mini".into())
}

/// The loopback request a speed test sends (same bodies the retired handler
/// stringified).
pub fn codex_speedtest_body(model: &Value) -> Value {
    json!({
        "model": model,
        "instructions": "Reply with only OK.",
        "input": [{ "role": "user", "content": [{ "type": "input_text", "text": "hi" }] }],
        "stream": true,
        "store": false,
    })
}

pub fn claude_speedtest_body(model: &Value, official_oauth: bool) -> Value {
    let mut body = Map::new();
    body.insert("model".into(), model.clone());
    body.insert("max_tokens".into(), Value::from(1));
    if official_oauth {
        body.insert(
            "system".into(),
            json!([{ "type": "text", "text": "You are Claude Code, Anthropic's official CLI for Claude." }]),
        );
    }
    body.insert(
        "messages".into(),
        json!([{ "role": "user", "content": "hi" }]),
    );
    Value::Object(body)
}

// ── speed test: one collected upstream answer → the route DTO ──────────────

fn failed_envelope(text: &str) -> bool {
    text.contains("response.failed")
        || text.contains("\"status\":\"failed\"")
        || text.contains("\"status\": \"failed\"")
        || {
            // `"error"\s*:\s*\{`
            let bytes = text.as_bytes();
            let mut index = 0;
            let mut found = false;
            while let Some(offset) = text[index..].find("\"error\"") {
                let mut cursor = index + offset + "\"error\"".len();
                while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
                    cursor += 1;
                }
                if cursor < bytes.len() && bytes[cursor] == b':' {
                    cursor += 1;
                    while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
                        cursor += 1;
                    }
                    if cursor < bytes.len() && bytes[cursor] == b'{' {
                        found = true;
                        break;
                    }
                }
                index = index + offset + "\"error\"".len();
            }
            found
        }
}

fn json_parse(text: &str) -> Option<Value> {
    serde_json::from_str(text).ok()
}

fn envelope_message(body: &str) -> String {
    let fallback = "provider speedtest failed";
    if let Some(parsed) = json_parse(body) {
        if let Some(message) = parsed
            .get("error")
            .and_then(|error| error.get("message"))
            .and_then(Value::as_str)
        {
            return sanitize_public_text(Some(message), fallback);
        }
        if let Some(message) = parsed
            .get("response")
            .and_then(|response| response.get("error"))
            .and_then(|error| error.get("message"))
            .and_then(Value::as_str)
        {
            return sanitize_public_text(Some(message), fallback);
        }
    }
    // `/message["']?\s*:\s*["']([^"']+)/i`
    if let Some(start) = find_message_start(body) {
        let rest = &body[start..];
        let quote = rest.chars().next().unwrap_or('"');
        let value = &rest[quote.len_utf8()..];
        let end = value.find(quote).unwrap_or(value.len());
        return sanitize_public_text(Some(&value[..end]), fallback);
    }
    fallback.to_string()
}

fn find_message_start(body: &str) -> Option<usize> {
    let lower = body.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let needle = b"message";
    let mut index = 0;
    while index + needle.len() <= bytes.len() {
        if &bytes[index..index + needle.len()] == needle {
            let mut cursor = index + needle.len();
            if cursor < bytes.len() && (bytes[cursor] == b'"' || bytes[cursor] == b'\'') {
                cursor += 1;
            }
            while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
                cursor += 1;
            }
            if cursor >= bytes.len() || bytes[cursor] != b':' {
                index += 1;
                continue;
            }
            cursor += 1;
            while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
                cursor += 1;
            }
            if cursor >= bytes.len() || (bytes[cursor] != b'"' && bytes[cursor] != b'\'') {
                index += 1;
                continue;
            }
            return Some(cursor);
        }
        index += 1;
    }
    None
}

fn non_ok_message(body: &str, status: u16) -> String {
    let fallback = format!("HTTP {status}");
    if let Some(parsed) = json_parse(body) {
        if let Some(error) = parsed.get("error").filter(|item| truthy(item)) {
            if let Some(message) = error.get("message").filter(|item| truthy(item)) {
                return sanitize_public_text(Some(&js_string(message)), &fallback);
            }
            return sanitize_public_text(
                Some(&serde_json::to_string(error).unwrap_or_default()),
                &fallback,
            );
        }
    }
    fallback
}

/// `runSpeedtestRequest`'s `finish(...)` payload for a fully collected answer.
pub fn speedtest_result(status: u16, body: &str, model: &Value, ms: i64) -> Value {
    let mut out = Map::new();
    if failed_envelope(body) {
        out.insert("ok".into(), Value::Bool(false));
        out.insert("ms".into(), Value::from(ms));
        out.insert("model".into(), model.clone());
        out.insert("error".into(), Value::String(envelope_message(body)));
        return Value::Object(out);
    }
    if (200..300).contains(&status) {
        out.insert("ok".into(), Value::Bool(true));
        out.insert("ms".into(), Value::from(ms));
        out.insert("status".into(), Value::from(status));
        out.insert("model".into(), model.clone());
        return Value::Object(out);
    }
    out.insert("ok".into(), Value::Bool(false));
    out.insert("ms".into(), Value::from(ms));
    out.insert("status".into(), Value::from(status));
    out.insert("model".into(), model.clone());
    out.insert("error".into(), Value::String(non_ok_message(body, status)));
    Value::Object(out)
}

/// `{ ok:false, ms, error }` for the timeout branch.
pub fn speedtest_failure(ms: i64, error: &str) -> Value {
    json!({ "ok": false, "ms": ms, "error": error })
}

/// `{ ok:false, ms, status, model, error:'response too large' }`.
pub fn speedtest_too_large(status: u16, model: &Value, ms: i64) -> Value {
    json!({ "ok": false, "ms": ms, "status": status, "model": model, "error": "response too large" })
}

/// `publicError(error, fallback)` for a transport failure.
pub fn speedtest_error(message: Option<&str>, ms: i64) -> Value {
    json!({
        "ok": false,
        "ms": ms,
        "error": public_error(message, "provider speedtest failed"),
    })
}

// ── routing test: Jev wire contract ────────────────────────────────────────

pub const SAMPLE_TEXT: &str = "把 README 里的一个错别字改掉";
pub const MAX_TEXT_LENGTH: usize = 2000;
pub const TEST_TIMEOUT_MS: u64 = 8000;
pub const INVALID_TARGET_CODE: &str = "invalid_routing_target";

const TIER_BANDS: [&str; 4] = [
    "Mechanical change whose exact edit is already known: a typo, a rename, a version bump, a one-line fix, or re-running a known command. No design decisions and no investigation.",
    "Small, well-understood change: one or two files, the approach already clear from the request. Light reasoning, but nothing has to be designed.",
    "Multi-file change that needs real reasoning: a new small feature, a behaviour fix with an unknown cause, or wiring across modules. The approach has to be chosen first.",
    "Architecture-level work: refactors across layers, provider or protocol changes, concurrency or migration work, or a request whose scope must be designed before any code is written.",
];

/// The `FACTS` object `src/providers/auto-provider-config.js` assembles. The
/// values are the owners' constants; the differential run keeps them honest.
pub fn routing_facts() -> Value {
    json!({
        "gateways": [
            { "name": "vercel", "endpoint": "https://ai-gateway.vercel.sh/v1/evaluate", "model": "typesafe-ai/jev", "apiKeyName": "VERCEL_API_KEY" },
            { "name": "openrouter", "endpoint": "https://openrouter.ai/api/alpha/decisions", "model": "~typesafe/jev-latest", "apiKeyName": "OPENROUTER_API_KEY" },
            { "name": "typesafe", "endpoint": "https://api.typesafe.ai/v1/systemone", "model": "jev-latest", "apiKeyName": "TYPESAFE_API_KEY" }
        ],
        "defaultGateway": "vercel",
        "customGateway": "custom",
        "customApiKeyName": "JEV_CUSTOM_API_KEY",
        "customModel": "jev-latest",
        "maxEndpointChars": 300,
        "nativeOpenCodePrefix": "opencode-native:",
        "nativeOpenCodeIdPattern": "^[a-z0-9][a-z0-9._-]{0,63}$",
        "nativeOpenCodeIdIgnoreCase": true,
        "nativeVendorSuffix": "-native:",
        "vendorNativeClis": ["qoder", "codebuddy", "gemini", "pi", "commandcode", "dsh", "grok"],
        "nativeVendorIdPattern": "^[a-z0-9][a-z0-9._-]{0,63}$",
        "nativeVendorIdIgnoreCase": true,
        "nativeVendorModelPattern": "^[A-Za-z0-9][A-Za-z0-9._:\\/-]{0,118}[A-Za-z0-9._/-]$",
        "nativeVendorModelIgnoreCase": false
    })
}

fn envelope(input: &Value) -> String {
    json!({ "facts": routing_facts(), "input": input }).to_string()
}

fn routing_envelope(routing: &Value) -> String {
    json!({ "facts": routing_facts(), "routing": routing }).to_string()
}

#[derive(Debug)]
pub struct RoutingPlan {
    pub text: String,
    pub endpoint: String,
    pub model: String,
    pub api_key_name: String,
}

/// `run(body)`: validate the target, resolve the Jev destination, and normalize
/// the probe text. `Err` is the 400 body (`invalid_routing_target`).
pub fn routing_plan(body: &Value) -> Result<RoutingPlan, Value> {
    let validated = crate::auto_provider_config::validate_routing_target(&envelope(body))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .unwrap_or_else(|| json!({ "ok": false, "error": "" }));
    if validated.get("ok") != Some(&Value::Bool(true)) {
        let error = validated
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or_default();
        return Err(json!({
            "ok": false,
            "code": INVALID_TARGET_CODE,
            "detail": sanitize_public_text(Some(error), "-"),
        }));
    }
    let target = validated.get("value").cloned().unwrap_or(Value::Null);
    let call = crate::auto_provider_config::jev_target(&routing_envelope(&target))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .unwrap_or(Value::Null);
    let raw_text = value_or_empty(body.get("text"));
    let trimmed = js_trim(&raw_text);
    let cut = utf16_prefix(trimmed, MAX_TEXT_LENGTH);
    let text = if cut.is_empty() {
        SAMPLE_TEXT.to_string()
    } else {
        cut
    };
    Ok(RoutingPlan {
        text,
        endpoint: call
            .get("endpoint")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        model: call
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        api_key_name: call
            .get("apiKeyName")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    })
}

fn band_for_tier(index: usize, count: usize) -> usize {
    let top = TIER_BANDS.len() - 1;
    if count <= 1 {
        return 0;
    }
    let scaled = (index as f64 / (count - 1) as f64) * top as f64;
    ((scaled + 0.5).floor() as usize).min(top)
}

/// `buildQuestions(normalizeTiers(['t1','t2']))`.
pub fn routing_questions() -> Value {
    let tiers = ["t1", "t2"];
    let mut criteria = Map::new();
    let mut levels = Vec::new();
    for (index, key) in tiers.iter().enumerate() {
        let band = TIER_BANDS[band_for_tier(index, tiers.len())];
        criteria.insert((*key).to_string(), Value::String(band.into()));
        levels.push(Value::String(band.into()));
    }
    json!({
        "tier": {
            "type": "choice",
            "instructions": "Pick the cheapest model tier that can still carry out this request well. Judge it by the work the request actually requires, not by how important it sounds or how long the message is.",
            "criteria": criteria,
        },
        "complexity": {
            "type": "score",
            "instructions": "Rate how much engineering work this request really requires, from a mechanical edit to architecture-level design.",
            "criteria": levels,
        },
    })
}

pub fn routing_request_body(text: &str, model: &str) -> Value {
    json!({
        "model": model,
        "state": { "request": text },
        "questions": routing_questions(),
    })
}

// JS coercion helpers used only by the escalation policy.

fn number_or_null(value: Option<&Value>) -> Option<f64> {
    let value = value?;
    if value.is_null() || matches!(value, Value::String(text) if text.is_empty()) {
        return None;
    }
    js_number(value).filter(|number| number.is_finite())
}

fn js_number(value: &Value) -> Option<f64> {
    match value {
        Value::Null => Some(0.0),
        Value::Bool(flag) => Some(if *flag { 1.0 } else { 0.0 }),
        Value::Number(number) => number.as_f64(),
        Value::String(text) => {
            let trimmed = js_trim(text);
            if trimmed.is_empty() {
                Some(0.0)
            } else {
                trimmed.parse::<f64>().ok()
            }
        }
        Value::Array(items) => {
            let joined = items
                .iter()
                .map(|item| {
                    if item.is_null() {
                        String::new()
                    } else {
                        js_string(item)
                    }
                })
                .collect::<Vec<_>>()
                .join(",");
            let trimmed = js_trim(&joined);
            if trimmed.is_empty() {
                Some(0.0)
            } else {
                trimmed.parse::<f64>().ok()
            }
        }
        Value::Object(_) => None,
    }
}

fn clamp01(value: Option<&Value>) -> Option<f64> {
    number_or_null(value).map(|number| number.clamp(0.0, 1.0))
}

fn first_defined<'a>(values: &[Option<&'a Value>]) -> Option<&'a Value> {
    values
        .iter()
        .flatten()
        .copied()
        .find(|value| !(value.is_null() || matches!(value, Value::String(text) if text.is_empty())))
}

fn read_answers(payload: &Value) -> Option<&Value> {
    let candidates = [
        payload.get("answers"),
        payload
            .get("result")
            .and_then(|result| result.get("answers")),
        payload
            .get("output")
            .and_then(|output| output.get("answers")),
        payload.get("data").and_then(|data| data.get("answers")),
    ];
    candidates
        .into_iter()
        .flatten()
        .find(|value| value.is_object())
}

fn read_confidence(payload: &Value, question_id: &str) -> Option<f64> {
    let nested = payload
        .get("providerMetadata")
        .and_then(|meta| meta.get("typesafe"))
        .and_then(|typesafe| typesafe.get("confidence"))
        .and_then(|confidence| confidence.get(question_id));
    let direct = payload
        .get("confidence")
        .and_then(|confidence| confidence.get(question_id));
    let scoped = read_answers(payload)
        .and_then(|answers| answers.get(question_id))
        .and_then(|answer| answer.as_object())
        .and_then(|answer| answer.get("confidence"));
    clamp01(first_defined(&[scoped, nested, direct]))
}

fn read_choice(answer: Option<&Value>) -> Option<String> {
    let answer = answer.filter(|value| value.is_object())?;
    let choice = first_defined(&[
        answer.get("choice"),
        answer.get("value"),
        answer.get("answer"),
        answer.get("label"),
    ])?;
    if choice.is_object() || choice.is_array() {
        return None;
    }
    Some(js_trim(&js_string(choice)).to_string())
}

fn read_probability_map(answer: Option<&Value>) -> Option<Map<String, Value>> {
    let answer = answer?;
    let raw = first_defined(&[answer.get("probabilities"), answer.get("probability")])?;
    let Value::Object(map) = raw else { return None };
    let mut out = Map::new();
    for (key, value) in map {
        if let Some(probability) = clamp01(Some(value)) {
            out.insert(key.to_lowercase(), Value::from(probability));
        }
    }
    (!out.is_empty()).then_some(out)
}

fn read_score(answer: Option<&Value>) -> Option<f64> {
    let answer = answer.filter(|value| value.is_object())?;
    number_or_null(first_defined(&[answer.get("score"), answer.get("value")]))
}

fn tier_index(tiers: &[&str], key: &str) -> Option<usize> {
    let clean = js_trim(key).to_lowercase();
    if clean.is_empty() {
        return None;
    }
    tiers.iter().position(|tier| tier.to_lowercase() == clean)
}

/// `escalationPolicy({tiers, escalation: defaults}, answers, payload)`.
pub fn escalation_policy(answers: &Value, payload: &Value) -> Value {
    let tiers = ["t1", "t2"];
    let top = tiers.len() - 1;
    let tier_answer = answers.get("tier");
    let chosen = read_choice(tier_answer);
    let chosen_index = chosen.as_deref().and_then(|key| tier_index(&tiers, key));
    let probabilities = if chosen_index.is_some() {
        read_probability_map(tier_answer)
    } else {
        None
    };
    let chosen_probability = chosen_index.and_then(|index| {
        probabilities
            .as_ref()
            .and_then(|map| map.get(&tiers[index].to_lowercase()))
            .and_then(Value::as_f64)
    });
    let confidence =
        read_confidence(payload, "tier").or_else(|| read_confidence(payload, "complexity"));
    let score = read_score(answers.get("complexity"));
    let complexity_index = score.map(|score| {
        let rounded = (score + 0.5).floor();
        (rounded.max(0.0) as usize).min(top)
    });
    let chosen_index_signed = chosen_index.map(|index| index as i64).unwrap_or(-1);
    if chosen_index.is_none() && complexity_index.is_none() {
        return json!({ "ok": false, "code": "jev_unreadable_answers" });
    }
    let mut index = chosen_index.unwrap_or(0).max(complexity_index.unwrap_or(0));
    let mut reason = if complexity_index.is_some_and(|value| value as i64 > chosen_index_signed) {
        "jev_complexity_escalation"
    } else {
        "jev_choice"
    };
    if let Some(confidence) = confidence {
        if confidence < 0.5 {
            if top > index {
                reason = "jev_low_confidence";
            }
            index = top;
        }
    } else if top > index {
        reason = "jev_confidence_missing";
        index = top;
    }
    if let Some(probability) = chosen_probability {
        if probability < 0.5 && index < top {
            reason = "jev_low_tier_probability";
            index += 1;
        }
    }
    json!({
        "ok": true,
        "tierIndex": index,
        "tier": tiers[index],
        "reasonCode": reason,
        "escalated": (index as i64) > chosen_index_signed,
        "chosenTier": chosen_index.map(|value| tiers[value]),
        "chosenProbability": chosen_probability,
        "tierProbabilities": probabilities,
        "complexityScore": score,
        "complexityIndex": complexity_index,
        "confidence": confidence,
    })
}

fn detail_of(payload: &Value) -> Option<String> {
    let error = payload.get("error");
    let message = first_defined(&[
        error.and_then(|error| error.get("message")),
        error,
        payload.get("message"),
    ])?;
    if !message.is_string() {
        return None;
    }
    Some(utf16_prefix(&js_string(message), 200))
}

/// The `classify()` verdict without `latencyMs`, derived from one HTTP answer.
/// `Err(code)` is a transport/timeout failure.
pub fn routing_verdict(http_status: u16, ok: bool, raw: &str) -> Value {
    let payload = if raw.is_empty() {
        Value::Null
    } else {
        json_parse(raw).unwrap_or(Value::Null)
    };
    if !ok {
        return json!({
            "ok": false,
            "code": format!("jev_http_{http_status}"),
            "status": http_status,
            "detail": detail_of(&payload),
        });
    }
    let Some(answers) = read_answers(&payload) else {
        return json!({ "ok": false, "code": "jev_bad_payload" });
    };
    let verdict = escalation_policy(answers, &payload);
    if verdict.get("ok") != Some(&Value::Bool(true)) {
        return json!({
            "ok": false,
            "code": verdict.get("code").cloned().unwrap_or(Value::String("jev_unreadable_answers".into())),
        });
    }
    verdict
}

/// The route's `(status, body)` for one verdict (either missing key or the
/// [`routing_verdict`] object).
pub fn routing_response(verdict: &Value, latency_ms: i64) -> (u16, Value) {
    let mut out = Map::new();
    if verdict.get("ok") == Some(&Value::Bool(true)) {
        out.insert("ok".into(), Value::Bool(true));
        out.insert(
            "tier".into(),
            Value::String(
                if verdict.get("tier").and_then(Value::as_str) == Some("t1") {
                    "t1".into()
                } else {
                    "t2".into()
                },
            ),
        );
        out.insert("latencyMs".into(), Value::from(latency_ms));
        return (200, Value::Object(out));
    }
    out.insert("ok".into(), Value::Bool(false));
    let code = verdict
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or_default();
    out.insert("code".into(), Value::String(safe_code(code, "jev_failed")));
    if let Some(status) = verdict.get("status").filter(|item| truthy(item)) {
        let number = number_or_null(Some(status)).unwrap_or(0.0);
        out.insert("status".into(), Value::from(number as i64));
    }
    let detail = verdict
        .get("detail")
        .filter(|item| truthy(item))
        .map(|item| sanitize_public_text(Some(&js_string(item)), "-"));
    if let Some(detail) = detail.filter(|item| item != "-") {
        out.insert("detail".into(), Value::String(utf16_prefix(&detail, 240)));
    }
    out.insert("latencyMs".into(), Value::from(latency_ms));
    (200, Value::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_dto_matches_the_node_projection() {
        let dto = to_provider_dto(&json!({
            "id": "claude-1",
            "appType": "claude",
            "protocol": "openai_responses",
            "wireApi": "responses",
            "name": "Line",
            "source": "ccswitch",
            "model": "claude-sonnet",
            "modelOptions": ["a", "a", 7, "b"],
            "aliasOnly": 1,
            "compatibleClis": ["claude", "qoder", "codex"],
            "hasToken": "yes",
            "isOfficial": 0
        }))
        .unwrap();
        assert_eq!(
            serde_json::to_string(&dto).unwrap(),
            r#"{"id":"claude-1","appType":"claude","protocol":"anthropic","apiFormat":"anthropic","wireApi":"responses","name":"Line","source":"ccswitch","model":"claude-sonnet","modelOptions":["a","b"],"aliasOnly":true,"compatibleClis":["claude","codex"],"hasCredentials":true,"isOfficial":false}"#
        );
        assert!(to_provider_dto(&json!({ "id": "", "name": "x" })).is_err());
        assert!(to_provider_dto(&json!({ "id": "x", "name": "" })).is_err());
    }

    #[test]
    fn speedtest_model_prefers_haiku_and_strips_context_suffix() {
        assert_eq!(wire_model_id(&json!("claude-opus-5[1m]")), "claude-opus-5");
        assert_eq!(
            preferred_speedtest_model(Some(&json!([
                "claude-opus-5[1m]",
                " claude-sonnet-5 ",
                "claude-haiku-4-5"
            ]))),
            "claude-haiku-4-5"
        );
        let env = json!({ "ANTHROPIC_MODEL": "  ", "ANTHROPIC_BASE_URL": "https://x.example" });
        let summary = json!({ "modelOptions": ["claude-opus-5", "claude-haiku-4-5"] });
        assert_eq!(
            claude_speedtest_model(&env, &summary, None),
            "claude-haiku-4-5"
        );
        assert_eq!(
            claude_speedtest_model(&env, &json!({}), Some(&json!(["claude-haiku-9"]))),
            ""
        );
        assert_eq!(
            claude_speedtest_model(
                &json!({ "ANTHROPIC_BASE_URL": "https://lender.example/claude-proxy/x/remote" }),
                &json!({}),
                Some(&json!(["claude-opus-5", "claude-haiku-9"]))
            ),
            "claude-haiku-9"
        );
    }

    #[test]
    fn speedtest_result_maps_every_branch() {
        assert_eq!(
            serde_json::to_string(&speedtest_result(200, "", &json!("m"), 3)).unwrap(),
            r#"{"ok":true,"ms":3,"status":200,"model":"m"}"#
        );
        assert_eq!(
            serde_json::to_string(&speedtest_result(
                400,
                r#"{"message":"bad"}"#,
                &json!("m"),
                4
            ))
            .unwrap(),
            r#"{"ok":false,"ms":4,"status":400,"model":"m","error":"HTTP 400"}"#
        );
        assert_eq!(
            serde_json::to_string(&speedtest_result(
                400,
                r#"{"error":{"message":"bad"}}"#,
                &json!("m"),
                4
            ))
            .unwrap(),
            r#"{"ok":false,"ms":4,"model":"m","error":"bad"}"#
        );
        assert_eq!(
            serde_json::to_string(&speedtest_result(
                200,
                r#"{"error":{"message":"bad key"}}"#,
                &json!("m"),
                5
            ))
            .unwrap(),
            r#"{"ok":false,"ms":5,"model":"m","error":"bad key"}"#
        );
        assert_eq!(
            serde_json::to_string(&speedtest_result(
                200,
                r#"event: response.failed message: 'oops'"#,
                &json!("m"),
                6
            ))
            .unwrap(),
            r#"{"ok":false,"ms":6,"model":"m","error":"oops"}"#
        );
        assert_eq!(
            serde_json::to_string(&speedtest_result(502, "not json", &json!("m"), 7)).unwrap(),
            r#"{"ok":false,"ms":7,"status":502,"model":"m","error":"HTTP 502"}"#
        );
    }

    #[test]
    fn routing_plan_rejects_bad_targets_and_normalizes_text() {
        let bad = routing_plan(&json!({ "gateway": "nope" })).unwrap_err();
        assert_eq!(bad["code"], "invalid_routing_target");
        let plan = routing_plan(&json!({ "gateway": "vercel", "text": "   " })).unwrap();
        assert_eq!(plan.text, SAMPLE_TEXT);
        assert_eq!(plan.endpoint, "https://ai-gateway.vercel.sh/v1/evaluate");
        assert_eq!(plan.model, "typesafe-ai/jev");
        assert_eq!(plan.api_key_name, "VERCEL_API_KEY");
        let long = routing_plan(&json!({ "gateway": "vercel", "text": "x".repeat(3000) })).unwrap();
        assert_eq!(long.text.len(), MAX_TEXT_LENGTH);
    }

    #[test]
    fn routing_questions_shape() {
        let questions = routing_questions();
        assert_eq!(questions["tier"]["type"], "choice");
        assert_eq!(questions["complexity"]["type"], "score");
        assert!(questions["tier"]["criteria"]["t1"]
            .as_str()
            .unwrap()
            .starts_with("Mechanical"));
        assert!(questions["tier"]["criteria"]["t2"]
            .as_str()
            .unwrap()
            .starts_with("Architecture"));
        assert_eq!(
            questions["complexity"]["criteria"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn escalation_policy_escalates_on_missing_confidence_and_low_margin() {
        let payload = json!({ "answers": { "tier": { "choice": "t1", "probabilities": { "t1": 0.9, "t2": 0.1 } } } });
        let verdict = escalation_policy(&payload["answers"], &payload);
        // Missing confidence still escalates to the top tier (jev_confidence_missing).
        assert_eq!(verdict["tier"], "t2");
        assert_eq!(verdict["reasonCode"], "jev_confidence_missing");

        let payload = json!({
            "answers": {
                "tier": { "choice": "t1", "probabilities": { "t1": 0.4, "t2": 0.6 } },
                "complexity": { "score": 0 }
            },
            "confidence": { "tier": 0.9 }
        });
        let verdict = escalation_policy(&payload["answers"], &payload);
        assert_eq!(verdict["tier"], "t2");
        assert_eq!(verdict["reasonCode"], "jev_low_tier_probability");

        let payload = json!({
            "answers": { "tier": { "choice": "t1" }, "complexity": { "score": 1 } },
            "confidence": { "tier": 0.9 }
        });
        let verdict = escalation_policy(&payload["answers"], &payload);
        assert_eq!(verdict["tier"], "t2");
        assert_eq!(verdict["reasonCode"], "jev_complexity_escalation");
    }

    #[test]
    fn routing_verdict_and_response_cover_the_wire_codes() {
        assert_eq!(
            routing_verdict(0, false, ""),
            json!({ "ok": false, "code": "jev_http_0", "status": 0, "detail": null })
        );
        let http = routing_verdict(429, false, r#"{"error":{"message":"slow down"}}"#);
        assert_eq!(http["code"], "jev_http_429");
        assert_eq!(http["detail"], "slow down");
        let bad = routing_verdict(200, true, r#"{"nothing":true}"#);
        assert_eq!(bad, json!({ "ok": false, "code": "jev_bad_payload" }));

        let (status, body) = routing_response(&http, 12);
        assert_eq!(status, 200);
        assert_eq!(
            serde_json::to_string(&body).unwrap(),
            r#"{"ok":false,"code":"jev_http_429","status":429,"detail":"slow down","latencyMs":12}"#
        );
        let (status, body) = routing_response(&json!({ "ok": true, "tier": "t1" }), 7);
        assert_eq!(status, 200);
        assert_eq!(
            serde_json::to_string(&body).unwrap(),
            r#"{"ok":true,"tier":"t1","latencyMs":7}"#
        );
        let (status, body) = routing_response(&json!({ "ok": true, "tier": "weird" }), 8);
        assert_eq!(status, 200);
        assert_eq!(
            serde_json::to_string(&body).unwrap(),
            r#"{"ok":true,"tier":"t2","latencyMs":8}"#
        );
    }

    #[test]
    fn api_meta_appends_in_node_order() {
        let mut payload = Map::new();
        payload.insert("providers".into(), json!([]));
        payload.insert("count".into(), json!(0));
        assert_eq!(
            serde_json::to_string(&api_meta(payload, "abcd1234", "")).unwrap(),
            r#"{"providers":[],"count":0,"apiVersion":"v1","requestId":"abcd1234","correlationId":"abcd1234"}"#
        );
    }
}
