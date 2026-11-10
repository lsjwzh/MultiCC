//! Chat turn request — normalization, admission planning and the spawn proof
//! boundary, migrated verbatim from `src/chat/turn-request.js`.
//!
//! The JS module keeps its export surface (`REQUEST_KIND`, `TurnRequestError`
//! and the five functions) and forwards here. What cannot cross FFI stays in
//! the bridge:
//!   * the `TurnRequestError` class itself — the core answers with a structured
//!     `{code, message}` envelope and the bridge rethrows the same class;
//!   * the `Symbol` brand check (`assertProviderBinding`) — the bridge validates
//!     the binding and hands its plain fields over;
//!   * `Object.prototype.hasOwnProperty` for the forbidden-field guard and the
//!     own-key listing of route evidence — both are property-existence checks
//!     that a JSON round trip cannot answer (`{cliSessionId: undefined}` and
//!     JS's `.sort()` ordering).
//!
//! Old JS semantics are kept exactly: `String()` coercion, JS `trim()`
//! whitespace (includes U+FEFF, excludes U+0085), UTF-16 code-unit lengths and
//! slices, `Number()` coercion, `===` identity checks and `Array.isArray`.
//!
//! The addon reads the request as a JavaScript value and converts it with
//! [`crate::js::tags`], so `undefined`, `NaN`, the infinities and `-0` are not
//! rewritten by JSON before this module sees them.
use crate::js::tags;
use crate::js::{js_trim, utf16_len, utf16_prefix};
use serde_json::{json, Map, Value};
use std::collections::HashSet;

pub const REQUEST_KIND: &str = "chat-turn-request.v1";
const MAX_ID_LENGTH: usize = 128;
const ROUTE_TEXT_MAX: usize = 256;

const FORBIDDEN_FIELDS: [&str; 8] = [
    "cliSessionId",
    "nativeSessionId",
    "sessionSecret",
    "secret",
    "token",
    "apiKey",
    "accessToken",
    "providerToken",
];
const TASK_SOURCES: [&str; 4] = ["task-board", "commander", "router-tool", "task-shell"];
const CONTINUATION_SOURCES: [&str; 1] = ["auto_provider_handoff"];
const LEGACY_TASK_SOURCE_ALIASES: [(&str, &str); 1] = [("commander-route", "commander")];
const PROVIDER_ROUTE_EVIDENCE_KEYS: [&str; 11] = [
    "resolved",
    "binding",
    "providerName",
    "protocol",
    "runtimeEpoch",
    "turnId",
    "decisionId",
    "routeAttemptId",
    "routeGeneration",
    "attemptNo",
    "providerRevision",
];

/// A `TurnRequestError` the JS bridge rethrows with the original class.
#[derive(Debug)]
pub struct Failure {
    pub code: &'static str,
    pub message: String,
}

impl Failure {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Failure {
            code,
            message: message.into(),
        }
    }
}

// ── JS value semantics ──────────────────────────────────────────────────────

fn truthy(value: &Value) -> bool {
    tags::truthy(value)
}

fn truthy_opt(value: Option<&Value>) -> bool {
    tags::truthy_opt(value)
}

fn field<'a>(container: &'a Value, key: &str) -> Option<&'a Value> {
    container.as_object().and_then(|object| object.get(key))
}

/// `String(value)` for tagged JSON values.
fn js_string(value: &Value) -> String {
    tags::js_string(value)
}

fn is_integer(number: f64) -> bool {
    number.is_finite() && number.fract() == 0.0
}

fn is_safe_integer(number: f64) -> bool {
    is_integer(number) && number.abs() <= 9_007_199_254_740_992.0
}

/// Emit an integral number as an integer literal; -0 keeps its sign like JS.
fn js_number_value(number: f64) -> Value {
    if number == 0.0 {
        if number.is_sign_negative() {
            return Value::from(-0.0_f64);
        }
        return Value::from(0_i64);
    }
    if is_safe_integer(number) {
        return Value::from(number as i64);
    }
    Value::from(number)
}

/// `Number(value)`; a missing value is undefined → NaN.
fn to_number(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(value) => tags::js_to_number(value),
    }
}

fn is_nullish(value: Option<&Value>) -> bool {
    match value {
        None => true,
        Some(value) => tags::is_nullish(value),
    }
}

// ── field normalizers ──────────────────────────────────────────────────────

fn clean_id(
    value: Option<&Value>,
    field_name: &str,
    required: bool,
) -> Result<Option<String>, Failure> {
    let text = match value {
        Some(value) if !tags::is_nullish(value) => js_string(value),
        _ => String::new(),
    };
    let text = utf16_prefix(js_trim(&text), MAX_ID_LENGTH);
    if required && text.is_empty() {
        return Err(Failure::new(
            "invalid_request",
            format!("{field_name} is required"),
        ));
    }
    Ok(if text.is_empty() { None } else { Some(text) })
}

fn normalize_string_list(value: Option<&Value>, field_name: &str) -> Result<Value, Failure> {
    let Some(value) = value.filter(|value| !tags::is_nullish(value)) else {
        return Ok(json!([]));
    };
    let Some(items) = value.as_array() else {
        return Err(Failure::new(
            "invalid_request",
            format!("{field_name} must be an array"),
        ));
    };
    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        if let Some(id) = clean_id(Some(item), field_name, false)? {
            if seen.insert(id.clone()) {
                out.push(Value::String(id));
            }
        }
    }
    Ok(Value::Array(out))
}

fn option_value(value: &Option<String>) -> Value {
    value
        .as_ref()
        .map_or(Value::Null, |text| Value::String(text.clone()))
}

fn normalize_task_context(input: &Value) -> Result<Value, Failure> {
    let task_id = clean_id(field(input, "taskId"), "taskId", false)?;
    let start = matches!(field(input, "taskStart"), Some(Value::Bool(true)));
    let raw_source = clean_id(field(input, "taskSource"), "taskSource", false)?;
    let source = raw_source
        .as_ref()
        .and_then(|source| {
            LEGACY_TASK_SOURCE_ALIASES
                .iter()
                .find(|(alias, _)| alias == source)
                .map(|(_, value)| (*value).to_string())
        })
        .or_else(|| raw_source.clone());
    if start && task_id.is_none() {
        return Err(Failure::new("invalid_task", "taskStart requires taskId"));
    }
    if start
        && !source
            .as_deref()
            .is_some_and(|source| TASK_SOURCES.contains(&source))
    {
        return Err(Failure::new(
            "invalid_task",
            "taskStart requires a trusted task source",
        ));
    }
    if let Some(source) = source.as_deref() {
        if !TASK_SOURCES.contains(&source) && !CONTINUATION_SOURCES.contains(&source) {
            return Err(Failure::new(
                "invalid_task",
                format!("unsupported task source: {source}"),
            ));
        }
    }
    let raw_text = match field(input, "taskText") {
        Some(value) if !tags::is_nullish(value) => js_trim(&js_string(value)).to_string(),
        _ => String::new(),
    };
    if !raw_text.is_empty() && !start {
        return Err(Failure::new(
            "invalid_task",
            "taskText is only valid on a task start",
        ));
    }
    let mut out = Map::new();
    out.insert("id".to_string(), option_value(&task_id));
    out.insert("start".to_string(), Value::Bool(start));
    out.insert("source".to_string(), option_value(&source));
    out.insert(
        "text".to_string(),
        Value::String(if start { raw_text } else { String::new() }),
    );
    Ok(Value::Object(out))
}

// ── public operations ──────────────────────────────────────────────────────

/// `normalizeTurnRequest(input)`.
pub fn normalize(input: &Value, resident: &[Value]) -> Result<Value, Failure> {
    if !input.is_object() || tags::is_tagged_scalar(input) {
        return Err(Failure::new(
            "invalid_request",
            "turn request must be an object",
        ));
    }
    for field_name in FORBIDDEN_FIELDS {
        if input.get(field_name).is_some() {
            return Err(Failure::new(
                "secret_field_forbidden",
                format!("{field_name} must not enter the turn core"),
            ));
        }
    }

    let session_id =
        clean_id(field(input, "sessionId"), "sessionId", true)?.expect("required sessionId");
    let text = match field(input, "text") {
        Some(value) if !tags::is_nullish(value) => js_trim(&js_string(value)).to_string(),
        _ => String::new(),
    };
    if text.is_empty() {
        return Err(Failure::new("empty_text", "turn text is required"));
    }
    let cli_raw = match field(input, "cli") {
        Some(value) if truthy(value) => value.clone(),
        _ => Value::String("claude".to_string()),
    };
    let cli = clean_id(Some(&cli_raw), "cli", true)?
        .expect("required cli")
        .to_lowercase();
    let transport = if resident
        .iter()
        .any(|value| value.as_str() == Some(cli.as_str()))
    {
        "claude-stream"
    } else {
        "cli-process"
    };
    let turn_count = if is_nullish(field(input, "turnCount")) {
        0.0
    } else {
        to_number(field(input, "turnCount"))
    };
    if !is_integer(turn_count) || turn_count < 0.0 {
        return Err(Failure::new(
            "invalid_request",
            "turnCount must be a non-negative integer",
        ));
    }
    let has_native_session = matches!(field(input, "hasNativeSession"), Some(Value::Bool(true)));
    let is_first_turn = if cli == "claude-exp" {
        !has_native_session
    } else {
        turn_count == 0.0 || !has_native_session
    };

    let origin_dispatch_id = clean_id(field(input, "originDispatchId"), "originDispatchId", false)?;
    let origin_trigger = matches!(field(input, "originTrigger"), Some(Value::Bool(true)));
    let origin_continue = matches!(field(input, "originContinue"), Some(Value::Bool(true)));
    if origin_dispatch_id.is_some() && origin_trigger {
        return Err(Failure::new(
            "invalid_origin",
            "dispatch and trigger origins are mutually exclusive",
        ));
    }
    let origin_kind = if origin_dispatch_id.is_some() {
        "dispatch"
    } else if origin_trigger {
        "trigger"
    } else {
        "user"
    };

    let delivery_id = clean_id(field(input, "deliveryId"), "deliveryId", false)?;
    let client_msg_id = clean_id(field(input, "clientMsgId"), "clientMsgId", false)?
        .or_else(|| delivery_id.clone());
    let request_id = clean_id(field(input, "requestId"), "requestId", false)?
        .or_else(|| client_msg_id.clone())
        .or_else(|| delivery_id.clone());

    let mut execution = Map::new();
    execution.insert(
        "transport".to_string(),
        Value::String(transport.to_string()),
    );
    execution.insert(
        "historyIntent".to_string(),
        Value::String(if is_first_turn { "first" } else { "resume" }.to_string()),
    );
    execution.insert("isFirstTurn".to_string(), Value::Bool(is_first_turn));

    let mut origin = Map::new();
    origin.insert("kind".to_string(), Value::String(origin_kind.to_string()));
    origin.insert("operationId".to_string(), option_value(&origin_dispatch_id));

    let mut launch = Map::new();
    launch.insert(
        "reason".to_string(),
        Value::String(
            if origin_continue {
                "continue"
            } else {
                "request"
            }
            .to_string(),
        ),
    );

    let mut identity = Map::new();
    identity.insert("clientMsgId".to_string(), option_value(&client_msg_id));
    identity.insert("deliveryId".to_string(), option_value(&delivery_id));

    // Validation order follows the old object literal: task, background (so
    // callers see the same first error).
    let task = normalize_task_context(input)?;
    let mut background = Map::new();
    background.insert(
        "taskIds".to_string(),
        normalize_string_list(field(input, "bgTaskIds"), "bgTaskIds")?,
    );
    background.insert(
        "toolUseIds".to_string(),
        normalize_string_list(field(input, "bgToolUseIds"), "bgToolUseIds")?,
    );

    let mut out = Map::new();
    out.insert("kind".to_string(), Value::String(REQUEST_KIND.to_string()));
    out.insert("sessionId".to_string(), Value::String(session_id));
    out.insert("requestId".to_string(), option_value(&request_id));
    out.insert("text".to_string(), Value::String(text));
    out.insert("cli".to_string(), Value::String(cli));
    out.insert("execution".to_string(), Value::Object(execution));
    out.insert("origin".to_string(), Value::Object(origin));
    out.insert("launch".to_string(), Value::Object(launch));
    out.insert("identity".to_string(), Value::Object(identity));
    out.insert("task".to_string(), task);
    out.insert("background".to_string(), Value::Object(background));
    Ok(Value::Object(out))
}

fn assert_normalized(request: &Value) -> Result<(), Failure> {
    if field(request, "kind").and_then(Value::as_str) != Some(REQUEST_KIND) {
        return Err(Failure::new(
            "invalid_request",
            "normalizeTurnRequest must be called first",
        ));
    }
    Ok(())
}

fn request_text(request: &Value, key: &str) -> Value {
    field(request, key).cloned().unwrap_or(Value::Null)
}

/// `planTurnAdmission(request, facts)`.
pub fn plan_admission(request: &Value, facts: &Value) -> Result<Value, Failure> {
    assert_normalized(request)?;
    let mut trace = vec![json!("duplicate-check")];
    let flag = |key: &str| matches!(field(facts, key), Some(Value::Bool(true)));
    if flag("duplicateSeen") {
        let mut out = Map::new();
        out.insert("decision".to_string(), json!("duplicate"));
        out.insert(
            "accepted".to_string(),
            Value::Bool(flag("duplicatePersisted")),
        );
        out.insert("trace".to_string(), Value::Array(trace));
        out.insert("effects".to_string(), json!([]));
        return Ok(Value::Object(out));
    }
    trace.push(json!("shutdown-check"));
    trace.push(json!("session-check"));
    let rejection = |reason: &str, trace: Vec<Value>| -> Value {
        let mut out = Map::new();
        out.insert("decision".to_string(), json!("reject"));
        out.insert("reason".to_string(), json!(reason));
        out.insert("trace".to_string(), Value::Array(trace));
        out.insert("effects".to_string(), json!([]));
        Value::Object(out)
    };
    if flag("shuttingDown") {
        return Ok(rejection("shutdown", trace));
    }
    if matches!(field(facts, "sessionExists"), Some(Value::Bool(false))) {
        return Ok(rejection("session-missing", trace));
    }
    if flag("runningTurn") {
        let mut busy = trace.clone();
        busy.push(json!("busy-check"));
        return Ok(rejection("session-busy", busy));
    }
    if flag("backgroundWorkActive") {
        let mut busy = trace.clone();
        busy.push(json!("busy-check"));
        busy.push(json!("background-check"));
        return Ok(rejection("background-work-active", busy));
    }
    let mut effect = Map::new();
    effect.insert("type".to_string(), json!("persist-user-message"));
    effect.insert("sessionId".to_string(), request_text(request, "sessionId"));
    effect.insert("requestId".to_string(), request_text(request, "requestId"));
    trace.push(json!("busy-check"));
    trace.push(json!("background-check"));
    trace.push(json!("persistence-plan"));
    let mut out = Map::new();
    out.insert("decision".to_string(), json!("prepare"));
    out.insert("trace".to_string(), Value::Array(trace));
    out.insert(
        "effects".to_string(),
        Value::Array(vec![Value::Object(effect)]),
    );
    Ok(Value::Object(out))
}

/// `createDurableMessageProof(request, evidence)`.
pub fn durable_message_proof(request: &Value, evidence: &Value) -> Result<Value, Failure> {
    assert_normalized(request)?;
    let mut out = Map::new();
    out.insert("kind".to_string(), json!("durable-user-message"));
    out.insert("sessionId".to_string(), request_text(request, "sessionId"));
    out.insert("requestId".to_string(), request_text(request, "requestId"));
    out.insert(
        "durable".to_string(),
        Value::Bool(matches!(
            field(evidence, "persisted"),
            Some(Value::Bool(true))
        )),
    );
    Ok(Value::Object(out))
}

fn has_control_characters(text: &str) -> bool {
    text.chars()
        .any(|character| matches!(character, '\u{0000}'..='\u{001f}' | '\u{007f}'))
}

fn route_text(value: Option<&Value>, field_name: &str) -> Result<String, Failure> {
    let raw = match value {
        Some(value) if !tags::is_nullish(value) => js_string(value),
        _ => String::new(),
    };
    let normalized = js_trim(&raw).to_string();
    if normalized.is_empty()
        || utf16_len(&normalized) > ROUTE_TEXT_MAX
        || has_control_characters(&normalized)
    {
        return Err(Failure::new(
            "invalid_provider_route",
            format!("{field_name} is invalid"),
        ));
    }
    Ok(normalized)
}

fn route_integer(value: Option<&Value>, field_name: &str) -> Result<Value, Failure> {
    let number = to_number(value);
    if !is_safe_integer(number) || number < 1.0 {
        return Err(Failure::new(
            "invalid_provider_route",
            format!("{field_name} must be a positive integer"),
        ));
    }
    Ok(js_number_value(number))
}

fn is_auto_provider_id(provider_id: &str) -> bool {
    if !provider_id
        .get(..4)
        .is_some_and(|head| head.eq_ignore_ascii_case("auto"))
    {
        return false;
    }
    provider_id.len() == 4 || provider_id.as_bytes().get(4) == Some(&b':')
}

/// `createProviderRouteProof(request, evidence)`. The binding arrives already
/// brand-checked by the bridge, reduced to its plain fields.
pub fn provider_route_proof(
    request: &Value,
    evidence: &Value,
    binding: &Value,
) -> Result<Value, Failure> {
    assert_normalized(request)?;
    let binding_text = |key: &str| -> Option<String> {
        field(binding, key)
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    let session_id = field(request, "sessionId").cloned().unwrap_or(Value::Null);
    let cli = field(request, "cli").cloned().unwrap_or(Value::Null);
    let transport = field(request, "transport").cloned().unwrap_or(Value::Null);
    let binding_matches = |key: &str, expected: &Value| -> bool {
        match (binding_text(key), expected.as_str()) {
            (Some(actual), Some(expected)) => actual == expected,
            _ => false,
        }
    };
    // `binding.providerId || '_default_'` — an empty/absent id falls back.
    let provider_id = match field(binding, "providerId") {
        Some(value) if truthy(value) => js_string(value),
        _ => "_default_".to_string(),
    };
    if !matches!(field(evidence, "resolved"), Some(Value::Bool(true)))
        || !binding_matches("sessionId", &session_id)
        || !binding_matches("cli", &cli)
        || binding_text("roleKind").as_deref() != Some("main")
        || binding_text("routeName").as_deref() != Some("main")
        || is_auto_provider_id(&provider_id)
    {
        return Err(Failure::new(
            "invalid_provider_route",
            "concrete provider route identity is required",
        ));
    }
    let provider_name_value = match field(evidence, "providerName") {
        Some(value) if truthy(value) => value.clone(),
        _ => Value::String(provider_id.clone()),
    };
    let model = field(binding, "model").cloned();
    let mut route = Map::new();
    route.insert(
        "runtimeEpoch".to_string(),
        Value::String(route_text(field(evidence, "runtimeEpoch"), "runtimeEpoch")?),
    );
    route.insert(
        "decisionId".to_string(),
        Value::String(route_text(field(evidence, "decisionId"), "decisionId")?),
    );
    route.insert(
        "routeAttemptId".to_string(),
        Value::String(route_text(
            field(evidence, "routeAttemptId"),
            "routeAttemptId",
        )?),
    );
    route.insert(
        "routeGeneration".to_string(),
        route_integer(field(evidence, "routeGeneration"), "routeGeneration")?,
    );
    route.insert(
        "attemptNo".to_string(),
        route_integer(field(evidence, "attemptNo"), "attemptNo")?,
    );
    route.insert("providerId".to_string(), Value::String(provider_id));
    route.insert(
        "providerName".to_string(),
        Value::String(route_text(Some(&provider_name_value), "providerName")?),
    );
    route.insert(
        "protocol".to_string(),
        Value::String(route_text(field(evidence, "protocol"), "protocol")?),
    );
    route.insert(
        "model".to_string(),
        Value::String(route_text(model.as_ref(), "model")?),
    );
    route.insert(
        "providerRevision".to_string(),
        Value::String(route_text(
            field(evidence, "providerRevision"),
            "providerRevision",
        )?),
    );
    let mut out = Map::new();
    out.insert("kind".to_string(), json!("provider-route"));
    out.insert("sessionId".to_string(), session_id);
    out.insert("cli".to_string(), cli);
    out.insert("transport".to_string(), transport);
    out.insert(
        "turnId".to_string(),
        Value::String(route_text(field(evidence, "turnId"), "turnId")?),
    );
    out.insert("resolved".to_string(), Value::Bool(true));
    out.insert("route".to_string(), Value::Object(route));
    Ok(Value::Object(out))
}

fn prop<'a>(container: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    container
        .and_then(Value::as_object)
        .and_then(|object| object.get(key))
}

/// `evaluateSpawnGuard(request, proofs)`. `route_frozen` carries
/// `Object.isFrozen(route.route)`, which only JS can answer.
pub fn evaluate_spawn_guard(
    request: &Value,
    message: Option<&Value>,
    route: Option<&Value>,
    runtime: Option<&Value>,
    route_frozen: bool,
) -> Result<Value, Failure> {
    assert_normalized(request)?;
    let session_id = field(request, "sessionId").cloned().unwrap_or(Value::Null);
    let cli = field(request, "cli").cloned().unwrap_or(Value::Null);
    let transport = field(request, "transport").cloned().unwrap_or(Value::Null);
    let matches_session = |value: Option<&Value>| -> bool {
        match (prop(value, "sessionId"), session_id.as_str()) {
            (Some(Value::String(actual)), Some(expected)) => actual == expected,
            _ => false,
        }
    };
    let mut missing: Vec<Value> = Vec::new();

    let message_ok = message.is_some_and(|message| {
        prop(Some(message), "kind").and_then(Value::as_str) == Some("durable-user-message")
            && matches_session(Some(message))
            && matches!(prop(Some(message), "durable"), Some(Value::Bool(true)))
    });
    if !message_ok {
        missing.push(json!("durable-user-message"));
    }

    let runtime_turn = prop(runtime, "turnId");
    let route_ok = route.is_some_and(|route| {
        let route_ref = prop(Some(route), "route");
        prop(Some(route), "kind").and_then(Value::as_str) == Some("provider-route")
            && matches_session(Some(route))
            && prop(Some(route), "cli") == Some(&cli)
            && prop(Some(route), "transport") == Some(&transport)
            && matches!(prop(Some(route), "resolved"), Some(Value::Bool(true)))
            && prop(Some(route), "turnId") == runtime_turn
            && truthy_opt(route_ref)
            && route_frozen
            && truthy_opt(prop(route_ref, "runtimeEpoch"))
            && truthy_opt(prop(route_ref, "decisionId"))
            && truthy_opt(prop(route_ref, "routeAttemptId"))
            && truthy_opt(prop(route_ref, "providerId"))
            && truthy_opt(prop(route_ref, "providerName"))
            && truthy_opt(prop(route_ref, "protocol"))
            && truthy_opt(prop(route_ref, "model"))
            && truthy_opt(prop(route_ref, "providerRevision"))
            && prop(route_ref, "routeGeneration").is_some_and(|value| {
                is_safe_integer_of(value) && value.as_f64().unwrap_or(0.0) >= 1.0
            })
            && prop(route_ref, "attemptNo").is_some_and(|value| {
                is_safe_integer_of(value) && value.as_f64().unwrap_or(0.0) >= 1.0
            })
    });
    if !route_ok {
        missing.push(json!("provider-route"));
    }

    let runtime_ok = runtime.is_some_and(|runtime| {
        prop(Some(runtime), "kind").and_then(Value::as_str) == Some("runtime-claim")
            && matches_session(Some(runtime))
            && matches!(prop(Some(runtime), "claimed"), Some(Value::Bool(true)))
    });
    if !runtime_ok {
        missing.push(json!("runtime-claim"));
    }

    if !missing.is_empty() {
        let mut out = Map::new();
        out.insert("ok".to_string(), Value::Bool(false));
        out.insert("code".to_string(), json!("spawn_proof_missing"));
        out.insert("missing".to_string(), Value::Array(missing));
        return Ok(Value::Object(out));
    }

    let mut effect = Map::new();
    effect.insert("type".to_string(), json!("spawn-turn"));
    effect.insert("sessionId".to_string(), session_id);
    effect.insert(
        "turnId".to_string(),
        runtime_turn.cloned().unwrap_or(Value::Null),
    );
    effect.insert("cli".to_string(), cli);
    effect.insert("transport".to_string(), transport);
    effect.insert(
        "historyIntent".to_string(),
        field(request, "historyIntent")
            .cloned()
            .unwrap_or(Value::Null),
    );
    effect.insert(
        "route".to_string(),
        prop(route, "route").cloned().unwrap_or(Value::Null),
    );
    let mut out = Map::new();
    out.insert("ok".to_string(), Value::Bool(true));
    out.insert("effect".to_string(), Value::Object(effect));
    Ok(Value::Object(out))
}

fn is_safe_integer_of(value: &Value) -> bool {
    matches!(value, Value::Number(number) if number.as_f64().is_some_and(is_safe_integer))
}

// ── entry points ───────────────────────────────────────────────────────────

/// Constant tables; `src/chat/turn-request.js` snapshots this at load.
pub fn catalog() -> Result<String, String> {
    Ok(json!({
        "requestKind": REQUEST_KIND,
        "forbiddenFields": FORBIDDEN_FIELDS,
        "taskSources": TASK_SOURCES,
        "continuationSources": CONTINUATION_SOURCES,
        "legacyTaskSourceAliases": LEGACY_TASK_SOURCE_ALIASES
            .iter()
            .map(|(alias, source)| json!({ "alias": alias, "source": source }))
            .collect::<Vec<_>>(),
        "providerRouteEvidenceKeys": PROVIDER_ROUTE_EVIDENCE_KEYS,
    })
    .to_string())
}

fn envelope(result: Result<Value, Failure>) -> Value {
    match result {
        Ok(value) => json!({ "ok": true, "value": value }),
        Err(failure) => json!({
            "ok": false,
            "error": { "code": failure.code, "message": failure.message },
        }),
    }
}

fn dispatch(op: &str, input: &Value) -> Result<Value, String> {
    let arg = |key: &str| input.as_object().and_then(|object| object.get(key));
    let resident = arg("residentClis")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let result = match op {
        "normalize" => normalize(arg("input").unwrap_or(&Value::Null), &resident),
        "admission" => plan_admission(
            arg("request").unwrap_or(&Value::Null),
            arg("facts").unwrap_or(&Value::Null),
        ),
        "messageProof" => durable_message_proof(
            arg("request").unwrap_or(&Value::Null),
            arg("evidence").unwrap_or(&Value::Null),
        ),
        "routeProof" => provider_route_proof(
            arg("request").unwrap_or(&Value::Null),
            arg("evidence").unwrap_or(&Value::Null),
            arg("binding").unwrap_or(&Value::Null),
        ),
        "spawnGuard" => evaluate_spawn_guard(
            arg("request").unwrap_or(&Value::Null),
            arg("message"),
            arg("route"),
            arg("runtime"),
            matches!(arg("routeFrozen"), Some(Value::Bool(true))),
        ),
        _ => return Err(format!("turn_request_unknown_op: {op}")),
    };
    Ok(envelope(result))
}

/// One value-in/value-out entry per exported JS function. The payload keeps
/// `undefined`, `NaN`, the infinities and `-0`, which JSON cannot carry.
pub fn request_value(op: &str, input: &crate::js::JsValue) -> Result<crate::js::JsValue, String> {
    let payload = tags::from_js(input);
    let result = dispatch(op, &payload)?;
    Ok(tags::to_js(&result))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resident() -> Value {
        json!(["claude", "claude-exp"])
    }

    fn request_json(input: Value) -> Value {
        normalize(&input, resident().as_array().unwrap()).expect("normalizes")
    }

    fn failure(input: Value) -> (String, String) {
        let failure = normalize(&input, resident().as_array().unwrap()).expect_err("must fail");
        (failure.code.to_string(), failure.message)
    }

    #[test]
    fn normalizes_identity_and_history_intent() {
        let turn = request_json(json!({
            "sessionId": "s1", "text": "  hello  ", "cli": "claude", "turnCount": 0,
            "hasNativeSession": true,
        }));
        assert_eq!(turn["text"], "hello");
        assert_eq!(turn["execution"]["transport"], "claude-stream");
        assert_eq!(turn["execution"]["historyIntent"], "first");
        assert_eq!(turn["requestId"], Value::Null);
        assert_eq!(
            turn["origin"],
            json!({ "kind": "user", "operationId": null })
        );

        let resumed = request_json(json!({
            "sessionId": "s1", "text": "x", "cli": "codex", "turnCount": 2, "hasNativeSession": true,
        }));
        assert_eq!(resumed["execution"]["transport"], "cli-process");
        assert_eq!(resumed["execution"]["historyIntent"], "resume");
    }

    #[test]
    fn claude_exp_ignores_turn_count() {
        for (turn_count, has_native) in [(0, false), (0, true), (9, true)] {
            let turn = request_json(json!({
                "sessionId": "s1", "text": "x", "cli": "claude-exp",
                "turnCount": turn_count, "hasNativeSession": has_native,
            }));
            assert_eq!(turn["execution"]["isFirstTurn"], !has_native);
        }
    }

    #[test]
    fn derives_client_and_request_ids_in_order() {
        let turn = request_json(json!({
            "sessionId": "s1", "text": "x", "deliveryId": " d1 ",
            "clientMsgId": "c1", "requestId": "r1",
        }));
        assert_eq!(turn["identity"]["clientMsgId"], "c1");
        assert_eq!(turn["requestId"], "r1");
        let fallback = request_json(json!({ "sessionId": "s1", "text": "x", "deliveryId": "d1" }));
        assert_eq!(fallback["identity"]["clientMsgId"], "d1");
        assert_eq!(fallback["requestId"], "d1");
    }

    #[test]
    fn rejects_secrets_and_empty_text() {
        assert_eq!(
            failure(json!({ "sessionId": "s1", "text": "x", "apiKey": "k" })).0,
            "secret_field_forbidden"
        );
        assert_eq!(
            failure(json!({ "sessionId": "s1", "text": "   " })).0,
            "empty_text"
        );
        assert_eq!(failure(json!({ "text": "x" })).0, "invalid_request");
    }

    #[test]
    fn task_context_gates_start_sources() {
        let started = request_json(json!({
            "sessionId": "s1", "text": "x", "taskId": "t1", "taskStart": true,
            "taskSource": "commander-route", "taskText": " body ",
        }));
        assert_eq!(started["task"]["source"], "commander");
        assert_eq!(started["task"]["text"], "body");
        assert_eq!(
            failure(json!({ "sessionId": "s1", "text": "x", "taskStart": true })).1,
            "taskStart requires taskId"
        );
        assert_eq!(
            failure(json!({
                "sessionId": "s1", "text": "x", "taskId": "t1", "taskStart": true,
                "taskSource": "auto_provider_handoff",
            })),
            (
                "invalid_task".to_string(),
                "taskStart requires a trusted task source".to_string()
            )
        );
        let handoff = request_json(json!({
            "sessionId": "s1", "text": "x", "taskId": "t1",
            "taskSource": "auto_provider_handoff",
        }));
        assert_eq!(handoff["task"]["start"], false);
        assert_eq!(handoff["task"]["source"], "auto_provider_handoff");
        assert_eq!(
            failure(json!({ "sessionId": "s1", "text": "x", "taskSource": "mystery" })).1,
            "unsupported task source: mystery"
        );
        assert_eq!(
            failure(json!({ "sessionId": "s1", "text": "x", "taskText": "body" })).1,
            "taskText is only valid on a task start"
        );
    }

    #[test]
    fn background_lists_and_retired_goal_limits() {
        let turn = request_json(json!({
            "sessionId": "s1", "text": "x",
            "bgTaskIds": ["a", "a", 2, null, ""],
        }));
        // Goal mode is gone: the field is neither carried nor validated, so a
        // legacy client sending it still gets a normalized request back.
        assert!(turn.get("goalLimits").is_none());
        assert_eq!(turn["background"]["taskIds"], json!(["a", "2"]));
        assert_eq!(turn["background"]["toolUseIds"], json!([]));
        let legacy = request_json(json!({
            "sessionId": "s1", "text": "x",
            "goalLimits": { "maxRounds": 3, "maxBudget": " 12 " },
        }));
        assert!(legacy.get("goalLimits").is_none());
        let bad = request_json(json!({ "sessionId": "s1", "text": "x", "goalLimits": [] }));
        assert!(bad.get("goalLimits").is_none());
    }

    #[test]
    fn origin_and_launch() {
        let dispatch = request_json(json!({
            "sessionId": "s1", "text": "x", "originDispatchId": "op-1", "originContinue": true,
        }));
        assert_eq!(
            dispatch["origin"],
            json!({ "kind": "dispatch", "operationId": "op-1" })
        );
        assert_eq!(dispatch["launch"], json!({ "reason": "continue" }));
        assert_eq!(
            failure(json!({
                "sessionId": "s1", "text": "x", "originDispatchId": "op-1", "originTrigger": true,
            }))
            .0,
            "invalid_origin"
        );
    }

    #[test]
    fn admission_and_proofs() {
        let turn = request_json(json!({ "sessionId": "s1", "text": "x", "requestId": "r1" }));
        let prepare = plan_admission(&turn, &json!({ "sessionExists": true })).unwrap();
        assert_eq!(prepare["decision"], "prepare");
        assert_eq!(
            prepare["trace"],
            json!([
                "duplicate-check",
                "shutdown-check",
                "session-check",
                "busy-check",
                "background-check",
                "persistence-plan"
            ])
        );
        let duplicate = plan_admission(
            &turn,
            &json!({ "duplicateSeen": true, "duplicatePersisted": true }),
        )
        .unwrap();
        assert_eq!(duplicate["decision"], "duplicate");
        assert_eq!(duplicate["accepted"], true);
        let busy = plan_admission(
            &turn,
            &json!({ "sessionExists": true, "backgroundWorkActive": true }),
        )
        .unwrap();
        assert_eq!(busy["reason"], "background-work-active");
        let missing = evaluate_spawn_guard(&turn, None, None, None, false).unwrap();
        assert_eq!(
            missing["missing"],
            json!(["durable-user-message", "provider-route", "runtime-claim"])
        );
    }

    #[test]
    fn provider_route_proof_rejects_auto_and_wide_text() {
        let turn = request_json(json!({ "sessionId": "s1", "text": "x", "cli": "claude" }));
        let binding = json!({
            "sessionId": "s1", "cli": "claude", "providerId": "p1", "model": "m1",
            "roleKind": "main", "routeName": "main",
        });
        let evidence = json!({
            "resolved": true, "providerName": "P", "protocol": "anthropic",
            "runtimeEpoch": "e", "turnId": "t1", "decisionId": "d", "routeAttemptId": "a",
            "routeGeneration": 1, "attemptNo": 1, "providerRevision": "r",
        });
        let proof = provider_route_proof(&turn, &evidence, &binding).unwrap();
        assert_eq!(proof["kind"], "provider-route");
        assert_eq!(proof["route"]["providerId"], "p1");
        let auto = json!({
            "sessionId": "s1", "cli": "claude", "providerId": "AUTO:balanced", "model": "m1",
            "roleKind": "main", "routeName": "main",
        });
        assert_eq!(
            provider_route_proof(&turn, &evidence, &auto)
                .expect_err("rejects")
                .message,
            "concrete provider route identity is required"
        );
        let wide = json!({
            "resolved": true, "providerName": "P", "protocol": "anthropic",
            "runtimeEpoch": "e", "turnId": "t1", "decisionId": "d", "routeAttemptId": "a",
            "routeGeneration": 1, "attemptNo": 1, "providerRevision": "bad\nvalue",
        });
        assert_eq!(
            provider_route_proof(&turn, &wide, &binding)
                .expect_err("rejects")
                .message,
            "providerRevision is invalid"
        );
    }

    #[test]
    fn utf16_slices_and_catalogue() {
        assert_eq!(utf16_prefix("a😀b", 2), "a\u{fffd}");
        assert_eq!(utf16_prefix("a😀b", 3), "a😀");
        let catalog: Value = serde_json::from_str(&catalog().unwrap()).unwrap();
        assert_eq!(catalog["requestKind"], REQUEST_KIND);
        assert_eq!(catalog["forbiddenFields"].as_array().unwrap().len(), 8);
        assert_eq!(
            catalog["legacyTaskSourceAliases"],
            json!([{ "alias": "commander-route", "source": "commander" }])
        );
    }
}
