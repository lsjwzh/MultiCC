//! Usage observation normalizer — migrated verbatim from
//! `src/usage-observed.js`. The JS module keeps its export surface:
//! `USAGE_OBSERVED_VERSION`, `UsageObservedError`, `createUsageObserved`,
//! `stableUsageEventId`, `validateUsageObserved`.
//!
//! Non-pure edges stay in JS: `assertProviderBinding` (Symbol brand) runs in
//! the bridge before this kernel, and `normalizeProxyOutcome` runs there too —
//! the kernel asks for it lazily (only after every earlier validation passed)
//! so error precedence is unchanged. Structured errors come back through an
//! envelope and the bridge rethrows `UsageObservedError` with the old code.
use chrono::{DateTime, Local, NaiveDate, NaiveDateTime, TimeZone, Utc};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

use crate::js_value::{
    js_string, js_to_number, js_trim, number_value, stable_stringify, truthy, truthy_opt, utf16_len,
};

pub const VERSION: u32 = 1;
pub const ROLE_KINDS: [&str; 3] = ["main", "sub", "aux"];
pub const AGENT_ROLES: [&str; 4] = ["default", "worker", "explorer", "custom"];
pub const SOURCES: [&str; 2] = ["exact", "reconciled"];
pub const COVERAGE: [&str; 2] = ["observed", "unobservable"];
pub const STATUSES: [&str; 3] = ["success", "error", "unobservable"];

const DEFAULT_CODE: &str = "INVALID_USAGE_OBSERVED";

#[derive(Debug)]
pub struct UsageError {
    pub code: &'static str,
    pub message: String,
}

fn invalid(message: impl Into<String>) -> UsageError {
    UsageError {
        code: DEFAULT_CODE,
        message: message.into(),
    }
}

fn invalid_with(message: impl Into<String>, code: &'static str) -> UsageError {
    UsageError {
        code,
        message: message.into(),
    }
}

/// Result of one normalization pass. `NeedsProxyOutcome` means every earlier
/// check passed and the JS bridge must normalize `input.proxyOutcome` before
/// calling again (preserving the original TypeError precedence).
pub enum Created {
    Event(Value),
    NeedsProxyOutcome,
}

fn prop<'a>(container: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    container
        .and_then(Value::as_object)
        .and_then(|object| object.get(key))
}

fn first_non_null<'a>(left: Option<&'a Value>, right: Option<&'a Value>) -> Option<&'a Value> {
    match left {
        Some(value) if !value.is_null() => Some(value),
        _ => right,
    }
}

fn has_control_characters(text: &str) -> bool {
    text.chars()
        .any(|character| matches!(character as u32, 0x00..=0x1F | 0x7F))
}

fn required_text(text: &str, label: &str, max: usize) -> Result<String, UsageError> {
    let text = js_trim(text);
    if text.is_empty() {
        return Err(invalid(format!("{label} is required")));
    }
    if utf16_len(text) > max || has_control_characters(text) {
        return Err(invalid(format!("{label} is invalid")));
    }
    Ok(text.to_string())
}

fn required_string(value: Option<&Value>, label: &str, max: usize) -> Result<String, UsageError> {
    let owned = match value {
        None | Some(Value::Null) => String::new(),
        Some(other) => js_string(other),
    };
    required_text(&owned, label, max)
}

/// `rawValue == null || rawValue === '' ? null : String(rawValue).trim()`,
/// reduced to its truthy (non-empty) form.
fn trimmed_option(value: Option<&Value>) -> Option<String> {
    match value {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) if text.is_empty() => None,
        Some(other) => {
            let text = js_trim(&js_string(other)).to_string();
            if text.is_empty() {
                None
            } else {
                Some(text)
            }
        }
    }
}

fn binding_value(
    raw: Option<&Value>,
    bound: Option<&Value>,
    label: &str,
) -> Result<Option<String>, UsageError> {
    let raw = trimmed_option(raw);
    let bound = trimmed_option(bound);
    if let (Some(raw_value), Some(bound_value)) = (&raw, &bound) {
        if raw_value != bound_value {
            return Err(invalid_with(
                format!("{label} conflicts with ProviderBinding"),
                "USAGE_BINDING_MISMATCH",
            ));
        }
    }
    Ok(raw.or(bound))
}

fn required_bound(value: Option<String>, label: &str, max: usize) -> Result<String, UsageError> {
    required_text(value.as_deref().unwrap_or(""), label, max)
}

fn optional_string(value: Option<&Value>, max: usize) -> Result<Option<String>, UsageError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) if text.is_empty() => Ok(None),
        Some(other) => {
            let text = js_trim(&js_string(other)).to_string();
            if utf16_len(&text) > max || has_control_characters(&text) {
                return Err(invalid("usage string field is invalid"));
            }
            Ok(if text.is_empty() { None } else { Some(text) })
        }
    }
}

fn optional_string_text(text: String, max: usize) -> Result<Option<String>, UsageError> {
    let text = js_trim(&text).to_string();
    if utf16_len(&text) > max || has_control_characters(&text) {
        return Err(invalid("usage string field is invalid"));
    }
    Ok(if text.is_empty() { None } else { Some(text) })
}

fn non_negative(value: Option<&Value>, label: &str) -> Result<f64, UsageError> {
    let number = match value {
        None | Some(Value::Null) => 0.0,
        Some(other) => js_to_number(other),
    };
    if !number.is_finite() || number < 0.0 {
        return Err(invalid(format!("{label} must be a non-negative number")));
    }
    Ok(number)
}

fn safe_integer(number: f64) -> bool {
    number.is_finite() && number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0
}

fn optional_positive_integer(
    value: Option<&Value>,
    label: &str,
) -> Result<Option<f64>, UsageError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) if text.is_empty() => Ok(None),
        Some(other) => {
            let number = js_to_number(other);
            if !safe_integer(number) || number < 1.0 {
                return Err(invalid(format!("{label} must be a positive integer")));
            }
            Ok(Some(number))
        }
    }
}

fn normalize_tokens(raw: Option<&Value>, coverage: &str) -> Result<Option<Value>, UsageError> {
    if coverage == "unobservable" {
        if raw.is_some_and(|value| !value.is_null()) {
            return Err(invalid("unobservable usage must not contain token counts"));
        }
        return Ok(None);
    }
    let object = match raw {
        Some(Value::Object(object)) => object,
        _ => return Err(invalid("tokens are required for observed usage")),
    };
    let first_value = |keys: &[&str]| -> Option<&Value> {
        for key in keys {
            if let Some(value) = object.get(*key) {
                if !value.is_null() {
                    return Some(value);
                }
            }
        }
        None
    };
    let input = non_negative(
        first_value(&["input", "inputTokens", "input_tokens"]),
        "tokens.input",
    )?;
    let output = non_negative(
        first_value(&["output", "outputTokens", "output_tokens"]),
        "tokens.output",
    )?;
    let cache_read = non_negative(
        first_value(&["cacheRead", "cache_read", "cache_read_input_tokens"]),
        "tokens.cacheRead",
    )?;
    let cache_write = non_negative(
        first_value(&["cacheWrite", "cache_write", "cache_creation_input_tokens"]),
        "tokens.cacheWrite",
    )?;
    let mut tokens = Map::new();
    tokens.insert("input".to_string(), number_value(input));
    tokens.insert("output".to_string(), number_value(output));
    tokens.insert("cacheRead".to_string(), number_value(cache_read));
    tokens.insert("cacheWrite".to_string(), number_value(cache_write));
    tokens.insert("total".to_string(), number_value(input + output));
    Ok(Some(Value::Object(tokens)))
}

/// `YYYY-MM-DD` with every component zero-padded, which V8 parses as UTC.
/// Non-padded forms such as `2025-6-5` fall back to local time instead.
fn is_padded_iso_date(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 10
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            4 | 7 => *byte == b'-',
            _ => byte.is_ascii_digit(),
        })
}

fn parse_iso_date(text: &str) -> f64 {
    if let Ok(parsed) = DateTime::parse_from_rfc3339(text) {
        return parsed.timestamp_millis() as f64;
    }
    if is_padded_iso_date(text) {
        if let Ok(date) = NaiveDate::parse_from_str(text, "%Y-%m-%d") {
            let stamp = Utc.from_utc_datetime(&date.and_hms_opt(0, 0, 0).expect("midnight"));
            return stamp.timestamp_millis() as f64;
        }
    }
    if let Ok(date) = NaiveDate::parse_from_str(text, "%Y-%m-%d") {
        if let Some(stamp) = Local
            .from_local_datetime(&date.and_hms_opt(0, 0, 0).expect("midnight"))
            .single()
        {
            return stamp.timestamp_millis() as f64;
        }
    }
    for format in [
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%d %H:%M:%S%.f",
        "%Y-%m-%dT%H:%M",
        "%Y-%m-%d %H:%M",
    ] {
        if let Ok(naive) = NaiveDateTime::parse_from_str(text, format) {
            if let Some(stamp) = Local.from_local_datetime(&naive).single() {
                return stamp.timestamp_millis() as f64;
            }
        }
    }
    f64::NAN
}

fn normalize_occurred_at(value: Option<&Value>) -> Result<f64, UsageError> {
    match value {
        None | Some(Value::Null) => {
            return Err(invalid("occurredAt is required for a stable eventId"));
        }
        Some(Value::String(text)) if text.is_empty() => {
            return Err(invalid("occurredAt is required for a stable eventId"));
        }
        _ => {}
    }
    let number = match value {
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(other) => parse_iso_date(&js_string(other)),
        None => f64::NAN,
    };
    if !number.is_finite() || number <= 0.0 {
        return Err(invalid("occurredAt must be a timestamp"));
    }
    Ok(number.floor())
}

fn event_id_pattern() -> &'static regex::Regex {
    static PATTERN: OnceLock<regex::Regex> = OnceLock::new();
    PATTERN.get_or_init(|| regex::Regex::new(r"^uo_[a-f0-9]{32}$").expect("event id regex"))
}

fn valid_route_name(route: &str) -> bool {
    let mut bytes = route.bytes();
    if !bytes.next().is_some_and(|byte| byte.is_ascii_lowercase()) {
        return false;
    }
    bytes.all(|byte| {
        byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-')
    })
}

fn stable_event_id(identity: &Value) -> String {
    let digest = format!(
        "{:x}",
        Sha256::digest(stable_stringify(identity).as_bytes())
    );
    format!("uo_{}", &digest[..32])
}

fn contains(list: &[&str], value: &str) -> bool {
    list.contains(&value)
}

/// Complete provider attempt identity, shared by eventContent and the event.
struct Attempt<'a> {
    runtime_epoch: &'a Option<String>,
    turn_id: &'a Option<String>,
    decision_id: &'a Option<String>,
    route_attempt_id: &'a Option<String>,
    route_generation: Option<f64>,
    attempt_no: Option<f64>,
    provider_revision: &'a Option<String>,
}

fn insert_attempt_fields(target: &mut Map<String, Value>, attempt: &Attempt<'_>) {
    let text = |value: &Option<String>| match value {
        Some(text) => Value::String(text.clone()),
        None => Value::Null,
    };
    target.insert("runtimeEpoch".to_string(), text(attempt.runtime_epoch));
    target.insert("turnId".to_string(), text(attempt.turn_id));
    target.insert("decisionId".to_string(), text(attempt.decision_id));
    target.insert("routeAttemptId".to_string(), text(attempt.route_attempt_id));
    target.insert(
        "routeGeneration".to_string(),
        attempt.route_generation.map_or(Value::Null, number_value),
    );
    target.insert(
        "attemptNo".to_string(),
        attempt.attempt_no.map_or(Value::Null, number_value),
    );
    target.insert(
        "providerRevision".to_string(),
        text(attempt.provider_revision),
    );
}

/// `createUsageObserved(input, binding)`. `binding` is the plain projection
/// the bridge made after `assertProviderBinding`; `normalized_outcome` is the
/// JS-normalized proxy outcome on the retry pass.
pub fn create(
    input: &Value,
    binding: Option<&Value>,
    normalized_outcome: Option<&Value>,
) -> Result<Created, UsageError> {
    if !matches!(input, Value::Object(_)) {
        return Err(invalid("UsageObserved input must be an object"));
    }
    let occurred_raw = first_non_null(
        prop(Some(input), "occurredAt"),
        prop(Some(input), "timestamp"),
    );
    let occurred_at = normalize_occurred_at(occurred_raw)?;

    let session_raw = first_non_null(
        prop(Some(input), "sessionId"),
        prop(Some(input), "externalSessionId"),
    );
    let session_id = required_bound(
        binding_value(session_raw, prop(binding, "sessionId"), "sessionId")?,
        "sessionId",
        256,
    )?;
    let provider_id = required_bound(
        binding_value(
            prop(Some(input), "providerId"),
            prop(binding, "providerId"),
            "providerId",
        )?,
        "providerId",
        256,
    )?;
    let role_raw = first_non_null(prop(Some(input), "roleKind"), prop(Some(input), "role"));
    let role_kind = required_bound(
        binding_value(role_raw, prop(binding, "roleKind"), "roleKind")?,
        "roleKind",
        16,
    )?
    .to_lowercase();
    if !contains(&ROLE_KINDS, &role_kind) {
        return Err(invalid("roleKind must be main, sub, or aux"));
    }

    let mut agent_role = binding_value(
        prop(Some(input), "agentRole"),
        prop(binding, "agentRole"),
        "agentRole",
    )?;
    let mut route_name = binding_value(
        prop(Some(input), "routeName"),
        prop(binding, "routeName"),
        "routeName",
    )?;
    if role_kind == "sub" {
        agent_role = Some(
            required_bound(
                agent_role.or_else(|| Some("default".to_string())),
                "agentRole",
                32,
            )?
            .to_lowercase(),
        );
        if !contains(&AGENT_ROLES, agent_role.as_deref().unwrap_or("")) {
            return Err(invalid(
                "sub agentRole must be default, worker, explorer, or custom",
            ));
        }
        route_name = Some(
            required_bound(route_name.or_else(|| agent_role.clone()), "routeName", 64)?
                .to_lowercase(),
        );
        if !valid_route_name(route_name.as_deref().unwrap_or("")) {
            return Err(invalid("routeName must be a valid agent route"));
        }
    } else {
        if agent_role.is_some() {
            return Err(invalid("agentRole is only valid for sub usage"));
        }
        agent_role = None;
        route_name = Some(
            required_bound(
                route_name.or_else(|| Some(role_kind.clone())),
                "routeName",
                64,
            )?
            .to_lowercase(),
        );
        if route_name.as_deref() != Some(role_kind.as_str()) {
            return Err(invalid(format!(
                "{role_kind} routeName must be {role_kind}"
            )));
        }
    }

    let source = required_string(prop(Some(input), "source"), "source", 32)?.to_lowercase();
    if !contains(&SOURCES, &source) {
        return Err(invalid("source must be exact or reconciled"));
    }
    let coverage = required_string(prop(Some(input), "coverage"), "coverage", 32)?.to_lowercase();
    if !contains(&COVERAGE, &coverage) {
        return Err(invalid("coverage must be observed or unobservable"));
    }
    let status_default = if coverage == "unobservable" {
        "unobservable"
    } else {
        "success"
    };
    let status_raw = match prop(Some(input), "status") {
        Some(value) if truthy(value) => value.clone(),
        _ => Value::String(status_default.to_string()),
    };
    let mut status = required_string(Some(&status_raw), "status", 32)?.to_lowercase();
    if !contains(&STATUSES, &status) {
        return Err(invalid("status must be success, error, or unobservable"));
    }
    if coverage == "observed" && status == "unobservable" {
        return Err(invalid("observed coverage cannot use unobservable status"));
    }
    if coverage == "unobservable" && status == "success" {
        status = "unobservable".to_string();
    }
    if coverage == "unobservable" && status != "unobservable" && status != "error" {
        return Err(invalid(
            "unobservable coverage requires unobservable or error status",
        ));
    }
    let protocol = required_string(prop(Some(input), "protocol"), "protocol", 64)?;
    let tokens_raw = first_non_null(prop(Some(input), "tokens"), prop(Some(input), "usage"));
    let tokens = normalize_tokens(tokens_raw, &coverage)?;

    let input_event_id = optional_string(prop(Some(input), "eventId"), 256)?.unwrap_or_default();
    let source_candidate = match prop(Some(input), "sourceEventId") {
        Some(value) if truthy(value) => js_string(value),
        _ => {
            if event_id_pattern().is_match(&input_event_id) {
                String::new()
            } else {
                input_event_id.clone()
            }
        }
    };
    let source_event_id = optional_string_text(source_candidate, 256)?;
    let runtime_epoch = optional_string(prop(Some(input), "runtimeEpoch"), 256)?;
    let turn_id = optional_string(prop(Some(input), "turnId"), 256)?;
    let decision_id = optional_string(prop(Some(input), "decisionId"), 256)?;
    let route_attempt_id = optional_string(prop(Some(input), "routeAttemptId"), 256)?;
    let provider_revision = optional_string(prop(Some(input), "providerRevision"), 256)?;
    let route_generation =
        optional_positive_integer(prop(Some(input), "routeGeneration"), "routeGeneration")?;
    let attempt_no = optional_positive_integer(prop(Some(input), "attemptNo"), "attemptNo")?;
    let has_attempt_identity = runtime_epoch.is_some()
        || turn_id.is_some()
        || decision_id.is_some()
        || route_attempt_id.is_some()
        || provider_revision.is_some()
        || route_generation.is_some()
        || attempt_no.is_some();
    if has_attempt_identity
        && (runtime_epoch.is_none()
            || turn_id.is_none()
            || decision_id.is_none()
            || route_attempt_id.is_none()
            || provider_revision.is_none()
            || route_generation.is_none()
            || attempt_no.is_none())
    {
        return Err(invalid("complete provider attempt identity is required"));
    }
    let route_attribution =
        optional_string(prop(Some(input), "routeAttribution"), 32)?.map(|text| text.to_lowercase());
    if let Some(attribution) = &route_attribution {
        if attribution != "exact" && attribution != "ambiguous" {
            return Err(invalid("routeAttribution must be exact or ambiguous"));
        }
    }

    let mut event_content = Map::new();
    event_content.insert("version".to_string(), Value::from(VERSION));
    event_content.insert(
        "sourceEventId".to_string(),
        source_event_id.clone().map_or(Value::Null, Value::String),
    );
    event_content.insert("occurredAt".to_string(), number_value(occurred_at));
    event_content.insert("sessionId".to_string(), Value::String(session_id.clone()));
    event_content.insert("providerId".to_string(), Value::String(provider_id.clone()));
    event_content.insert("roleKind".to_string(), Value::String(role_kind.clone()));
    event_content.insert(
        "agentRole".to_string(),
        agent_role.clone().map_or(Value::Null, Value::String),
    );
    event_content.insert(
        "routeName".to_string(),
        Value::String(route_name.clone().unwrap_or_default()),
    );
    event_content.insert("source".to_string(), Value::String(source.clone()));
    event_content.insert("coverage".to_string(), Value::String(coverage.clone()));
    event_content.insert("status".to_string(), Value::String(status.clone()));
    event_content.insert("protocol".to_string(), Value::String(protocol.clone()));
    let model = optional_string(prop(Some(input), "model"), 256)?.unwrap_or_default();
    event_content.insert("model".to_string(), Value::String(model.clone()));
    event_content.insert("tokens".to_string(), tokens.clone().unwrap_or(Value::Null));
    let proxy_present = truthy_opt(prop(Some(input), "proxyOutcome"));
    if proxy_present {
        match normalized_outcome {
            Some(outcome) => {
                event_content.insert("proxyOutcome".to_string(), outcome.clone());
            }
            None => return Ok(Created::NeedsProxyOutcome),
        }
    }
    let attempt = Attempt {
        runtime_epoch: &runtime_epoch,
        turn_id: &turn_id,
        decision_id: &decision_id,
        route_attempt_id: &route_attempt_id,
        route_generation,
        attempt_no,
        provider_revision: &provider_revision,
    };
    if has_attempt_identity {
        insert_attempt_fields(&mut event_content, &attempt);
    }

    let identity = if let Some(source_event_id) = &source_event_id {
        let mut identity = Map::new();
        identity.insert("version".to_string(), Value::from(VERSION));
        identity.insert(
            "sourceEventId".to_string(),
            Value::String(source_event_id.clone()),
        );
        identity.insert("sessionId".to_string(), Value::String(session_id.clone()));
        identity.insert("providerId".to_string(), Value::String(provider_id.clone()));
        identity.insert("roleKind".to_string(), Value::String(role_kind.clone()));
        identity.insert(
            "agentRole".to_string(),
            agent_role.clone().map_or(Value::Null, Value::String),
        );
        identity.insert(
            "routeName".to_string(),
            Value::String(route_name.clone().unwrap_or_default()),
        );
        identity.insert("source".to_string(), Value::String(source.clone()));
        Value::Object(identity)
    } else {
        Value::Object(event_content.clone())
    };
    let event_id = stable_event_id(&identity);
    if event_id_pattern().is_match(&input_event_id) && input_event_id != event_id {
        return Err(invalid_with(
            "eventId does not match UsageObserved content",
            "USAGE_EVENT_ID_MISMATCH",
        ));
    }

    let mut event = Map::new();
    event.insert("version".to_string(), Value::from(VERSION));
    event.insert("eventId".to_string(), Value::String(event_id));
    event.insert(
        "sourceEventId".to_string(),
        source_event_id.clone().map_or(Value::Null, Value::String),
    );
    event.insert("occurredAt".to_string(), number_value(occurred_at));
    event.insert("sessionId".to_string(), Value::String(session_id));
    event.insert("providerId".to_string(), Value::String(provider_id));
    event.insert(
        "providerName".to_string(),
        Value::String(optional_string(prop(Some(input), "providerName"), 256)?.unwrap_or_default()),
    );
    event.insert("roleKind".to_string(), Value::String(role_kind));
    event.insert(
        "agentRole".to_string(),
        agent_role.map_or(Value::Null, Value::String),
    );
    event.insert(
        "routeName".to_string(),
        Value::String(route_name.unwrap_or_default()),
    );
    event.insert("source".to_string(), Value::String(source));
    event.insert("coverage".to_string(), Value::String(coverage));
    event.insert("status".to_string(), Value::String(status));
    event.insert("protocol".to_string(), Value::String(protocol));
    event.insert("model".to_string(), Value::String(model));
    event.insert("tokens".to_string(), tokens.unwrap_or(Value::Null));
    if let (true, Some(outcome)) = (proxy_present, normalized_outcome) {
        event.insert("proxyOutcome".to_string(), outcome.clone());
    }
    let latency = non_negative(prop(Some(input), "latencyMs"), "latencyMs")?;
    event.insert("latencyMs".to_string(), number_value(latency));
    match prop(Some(input), "statusCode") {
        Some(value) if !value.is_null() => {
            let status_code = non_negative(Some(value), "statusCode")?;
            event.insert("statusCode".to_string(), number_value(status_code));
        }
        _ => {}
    }
    match prop(Some(input), "errorCode") {
        Some(value) if truthy(value) => {
            let error_code = optional_string(Some(value), 128)?.unwrap_or_default();
            event.insert("errorCode".to_string(), Value::String(error_code));
        }
        _ => {}
    }
    if has_attempt_identity {
        insert_attempt_fields(&mut event, &attempt);
    }
    if let Some(attribution) = route_attribution {
        event.insert("routeAttribution".to_string(), Value::String(attribution));
    }
    Ok(Created::Event(Value::Object(event)))
}

pub fn catalog() -> String {
    serde_json::json!({ "version": VERSION }).to_string()
}

fn argument<'a>(input: &'a Value, key: &str) -> Option<&'a Value> {
    input.as_object().and_then(|object| object.get(key))
}

/// String-in/string-out dispatcher for the addon. `create` answers with an
/// envelope so the bridge can rebuild `UsageObservedError`/`TypeError` itself.
pub fn request(op: &str, input: &str) -> Result<String, String> {
    let value: Value = crate::json_lenient::from_str(input)
        .map_err(|error| format!("usage_observed_invalid_input: {error}"))?;
    match op {
        "create" => {
            let target = argument(&value, "value").unwrap_or(&Value::Null);
            let binding = argument(&value, "binding");
            let normalized = if argument(&value, "proxyOutcomeNormalized").is_some_and(truthy) {
                argument(&value, "proxyOutcome")
            } else {
                None
            };
            let envelope = match create(target, binding, normalized) {
                Ok(Created::Event(event)) => {
                    serde_json::json!({ "ok": true, "value": event })
                }
                Ok(Created::NeedsProxyOutcome) => {
                    serde_json::json!({ "ok": false, "retry": "proxyOutcome" })
                }
                Err(error) => {
                    serde_json::json!({ "ok": false, "code": error.code, "message": error.message })
                }
            };
            Ok(envelope.to_string())
        }
        "stableEventId" => Ok(Value::String(stable_event_id(
            argument(&value, "identity").unwrap_or(&Value::Null),
        ))
        .to_string()),
        _ => Err(format!("usage_observed_unknown_op: {op}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn exact() -> Value {
        json!({
            "eventId": "cpr-event-1",
            "occurredAt": 1_750_000_000_000i64,
            "sessionId": "session-1",
            "providerId": "provider-1",
            "roleKind": "main",
            "routeName": "main",
            "source": "exact",
            "coverage": "observed",
            "status": "success",
            "protocol": "openai-responses",
            "usage": { "input_tokens": 12, "output_tokens": 3, "cache_read_input_tokens": 4 },
            "latencyMs": 25,
        })
    }

    fn event(input: &Value) -> Value {
        match create(input, None, None).expect("valid usage") {
            Created::Event(event) => event,
            Created::NeedsProxyOutcome => panic!("unexpected retry"),
        }
    }

    #[test]
    fn stable_ids_are_idempotent_and_source_owned() {
        let first = event(&exact());
        let second = event(&exact());
        assert_eq!(first["eventId"], second["eventId"]);
        assert!(first["eventId"].as_str().unwrap().starts_with("uo_"));
        assert_eq!(first["sourceEventId"], "cpr-event-1");
        assert_eq!(first["tokens"]["total"], 15);
        let mut later = exact();
        later["occurredAt"] = json!(1_750_000_005_000i64);
        later["model"] = json!("corrected-model");
        assert_eq!(event(&later)["eventId"], first["eventId"]);
    }

    #[test]
    fn coverage_normalization_matches_the_old_rules() {
        let mut input = exact();
        input["coverage"] = json!("unobservable");
        input["usage"] = Value::Null;
        input["status"] = json!("success");
        let unobservable = event(&input);
        assert_eq!(unobservable["status"], "unobservable");
        assert_eq!(unobservable["tokens"], Value::Null);

        input["status"] = json!("error");
        assert_eq!(event(&input)["status"], "error");

        input["coverage"] = json!("observed");
        input["status"] = json!("unobservable");
        assert!(create(&input, None, None).is_err());
    }

    #[test]
    fn binding_conflicts_and_attempt_identity_are_enforced() {
        let binding = json!({
            "sessionId": "session-sub", "providerId": "provider-sub",
            "roleKind": "sub", "agentRole": "custom", "routeName": "reviewer",
        });
        let mut input = exact();
        input["sessionId"] = json!("wrong-session");
        let error = create(&input, Some(&binding), None).err().unwrap();
        assert_eq!(error.code, "USAGE_BINDING_MISMATCH");

        let mut attempt = exact();
        attempt["routeAttemptId"] = json!("attempt-only");
        assert!(create(&attempt, None, None).is_err());
    }

    #[test]
    fn proxy_outcome_is_requested_lazily() {
        let mut input = exact();
        input["proxyOutcome"] = json!({ "version": 1, "requestId": "request-1",
            "requestKind": "inference", "termination": "completed", "httpStatus": null });
        assert!(matches!(
            create(&input, None, None).unwrap(),
            Created::NeedsProxyOutcome
        ));
        let outcome = json!({ "version": 1, "requestId": "request-1",
            "requestKind": "inference", "termination": "completed", "httpStatus": null });
        match create(&input, None, Some(&outcome)).unwrap() {
            Created::Event(event) => assert_eq!(event["proxyOutcome"], outcome),
            Created::NeedsProxyOutcome => panic!("outcome was already supplied"),
        }
    }

    #[test]
    fn event_id_mismatch_uses_the_legacy_code() {
        let mut input = exact();
        input["eventId"] = json!(format!("uo_{}", "0".repeat(32)));
        let error = create(&input, None, None).err().unwrap();
        assert_eq!(error.code, "USAGE_EVENT_ID_MISMATCH");
    }

    #[test]
    fn stable_event_id_json_entry_matches_the_kernel() {
        let identity = json!({ "b": [2, 1], "a": "x" });
        let raw = serde_json::from_str::<Value>(
            &request(
                "stableEventId",
                &json!({ "identity": identity }).to_string(),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(raw, json!(stable_event_id(&identity)));
    }

    #[test]
    fn timestamps_accept_numbers_and_iso_strings() {
        let mut input = exact();
        input["occurredAt"] = json!("2025-06-15T12:00:00Z");
        let stamp = event(&input)["occurredAt"].clone();
        assert_eq!(stamp, json!(1_749_988_800_000i64));
        input["occurredAt"] = json!(0);
        assert!(create(&input, None, None).is_err());
    }

    #[test]
    fn padded_dates_are_utc_and_non_padded_dates_are_local() {
        assert!(is_padded_iso_date("2025-06-15"));
        assert!(!is_padded_iso_date("2025-6-5"));
        assert_eq!(parse_iso_date("2025-06-15"), 1_749_945_600_000.0);
        let local = Local
            .from_local_datetime(
                &NaiveDate::from_ymd_opt(2025, 6, 5)
                    .unwrap()
                    .and_hms_opt(0, 0, 0)
                    .unwrap(),
            )
            .single()
            .unwrap()
            .timestamp_millis() as f64;
        assert_eq!(parse_iso_date("2025-6-5"), local);
    }
}
