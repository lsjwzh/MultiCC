//! Events — the standard event catalog, the rule schema, the hook envelope and
//! the task-transition derivation, migrated verbatim from `src/events/catalog.js`,
//! `rules.js`, `envelope.js` and `task-transitions.js`.
//!
//! The JS modules keep their export surface: they snapshot the constant tables
//! once at load and forward every logic-bearing call here. Inputs are
//! JSON-origin (HTTP bodies, persisted rules and task state, JSONL history).
//! The old JS semantics are kept exactly, including:
//!   * string lengths and slices count UTF-16 code units;
//!   * the secret-redaction regex had no `u` flag, so `{8,}` counted code units
//!     and an astral character counted twice — it runs here over a view where
//!     every surrogate unit is one placeholder character;
//!   * JS `\s` / `trim()` whitespace (includes U+FEFF, excludes U+0085) and
//!     ASCII-only case folding for `/i` (no Kelvin-sign or long-s matches);
//!   * property reads that threw a TypeError on null/undefined still fail on
//!     the same paths (as an error string).
//!
//! Not replicated: Object.prototype names used as lookup keys (a `classifyState`
//! or `goalState` of `"toString"` resolved to a function in JS). Real inputs only
//! carry vocab-validated letters and goal states.
use crate::classify_vocab::{
    is_abnormal_letter, is_goal_state, is_processing_letter, is_terminal_letter,
};
use crate::js::{js_trim, utf16_len, utf16_prefix};
use regex::{Captures, Regex};
use serde_json::{json, Map, Value};
use std::borrow::Cow;
use std::sync::OnceLock;
use url::Url;

const TASK_EVENTS: [&str; 9] = [
    "task.running",
    "task.finished",
    "task.goal_resolved",
    "task.achieved",
    "task.needs_interaction",
    "task.waiting_user",
    "task.waiting_background",
    "task.failed",
    "task.restarted",
];
const TURN_EVENTS: [&str; 1] = ["turn.completed"];
const TRIGGER_EVENT: &str = "trigger.fired";
// Aliases expand only at match time; they are never emitted themselves.
const ALIASES: [(&str, &[&str]); 2] = [
    (
        "task.attention",
        &["task.needs_interaction", "task.waiting_user", "task.failed"],
    ),
    ("task.done", &["task.achieved", "task.needs_interaction"]),
];

const ACTION_KINDS: [&str; 4] = ["inject-prompt", "webhook", "notify", "channel"];
const MAX_PATTERNS: usize = 10;
const MAX_FILTER_IDS: usize = 50;
const MIN_INJECT_COOLDOWN_MS: f64 = 10_000.0;
const DEFAULT_INJECT_COOLDOWN_MS: f64 = 60_000.0;
const MAX_COOLDOWN_MS: f64 = 86_400_000.0;
const MAX_CHAIN_STEPS: usize = 9; // follow-up steps after the first action

const CONCLUSION_MAX: usize = 2000;
const SUMMARY_MAX: usize = 400;
// Events that carry a conclusion; running/restarted/trigger.* never do.
const CONCLUSION_EVENTS: [&str; 7] = [
    "task.finished",
    "task.goal_resolved",
    "task.achieved",
    "task.needs_interaction",
    "task.waiting_user",
    "task.waiting_background",
    "task.failed",
];
const GOAL_STATE_LABEL: [(&str, &str); 2] = [("achieved", "达成目标"), ("interact", "需要交互")];
const DEFAULT_INSTRUCTION: &str = "请根据以上信息简短汇报，并给出下一步建议。";

const LETTER_EVENT: [(&str, &str); 5] = [
    ("P", "task.running"),
    ("D", "task.finished"),
    ("W", "task.waiting_user"),
    ("B", "task.waiting_background"),
    ("E", "task.failed"),
];
const GOAL_EVENT: [(&str, &str); 2] = [
    ("achieved", "task.achieved"),
    ("interact", "task.needs_interaction"),
];

fn event_types() -> impl Iterator<Item = &'static str> {
    TASK_EVENTS
        .iter()
        .chain(TURN_EVENTS.iter())
        .copied()
        .chain(std::iter::once(TRIGGER_EVENT))
}

fn lookup(table: &[(&'static str, &'static str)], key: &str) -> Option<&'static str> {
    table
        .iter()
        .find(|(name, _)| *name == key)
        .map(|(_, value)| *value)
}

fn table_object(table: &[(&str, &str)]) -> Value {
    Value::Object(
        table
            .iter()
            .map(|(key, value)| (key.to_string(), json!(value)))
            .collect(),
    )
}

// ── JS value semantics ──────────────────────────────────────────────────────

fn type_error(message: String) -> String {
    format!("events_type_error: {message}")
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn truthy_opt(value: Option<&Value>) -> bool {
    value.is_some_and(truthy)
}

/// `container.key` where the container is known not to be null/undefined (or
/// the read is guarded): only plain objects carry named properties.
fn prop<'a>(container: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    container
        .and_then(Value::as_object)
        .and_then(|object| object.get(key))
}

/// `container.key` with JS's TypeError on null/undefined.
fn read<'a>(container: Option<&'a Value>, key: &str) -> Result<Option<&'a Value>, String> {
    match container {
        None => Err(type_error(format!(
            "Cannot read properties of undefined (reading '{key}')"
        ))),
        Some(Value::Null) => Err(type_error(format!(
            "Cannot read properties of null (reading '{key}')"
        ))),
        Some(other) => Ok(other.as_object().and_then(|object| object.get(key))),
    }
}

/// `a === b` for JSON values: objects and arrays compare by reference in JS and
/// two JSON copies never alias, so they are never strictly equal.
fn strict_equal(left: Option<&Value>, right: Option<&Value>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(Value::Number(a)), Some(Value::Number(b))) => a.as_f64() == b.as_f64(),
        (Some(a @ (Value::Null | Value::Bool(_) | Value::String(_))), Some(b)) => a == b,
        _ => false,
    }
}

fn format_number(number: &serde_json::Number) -> String {
    if let Some(integer) = number.as_i64() {
        return integer.to_string();
    }
    if let Some(integer) = number.as_u64() {
        return integer.to_string();
    }
    let float = number.as_f64().unwrap_or(f64::NAN);
    if float == 0.0 {
        return "0".to_string();
    }
    let mut buffer = ryu_js::Buffer::new();
    buffer.format_finite(float).to_string()
}

/// `String(value)` for JSON values (array holes arrive as null).
fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => format_number(number),
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| {
                if item.is_null() {
                    String::new()
                } else {
                    js_string(item)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

fn js_string_opt(value: Option<&Value>) -> String {
    value.map_or_else(|| "undefined".to_string(), js_string)
}

/// `value || fallback`, rendered with `String()`.
fn text_or(value: Option<&Value>, fallback: &str) -> String {
    match value {
        Some(found) if truthy(found) => js_string(found),
        _ => fallback.to_string(),
    }
}

/// `value || fallback`, keeping the original value.
fn value_or(value: Option<&Value>, fallback: Value) -> Value {
    match value {
        Some(found) if truthy(found) => found.clone(),
        _ => fallback,
    }
}

fn is_js_whitespace(character: char) -> bool {
    matches!(
        character,
        '\u{0009}'..='\u{000d}'
            | '\u{0020}'
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

/// `slice`'s end argument: ToIntegerOrInfinity, relative when negative.
fn slice_end(end: f64, len: usize) -> usize {
    if end.is_nan() {
        return 0;
    }
    let end = end.trunc();
    if end < 0.0 {
        let from_end = len as f64 + end;
        if from_end < 0.0 {
            0
        } else {
            from_end as usize
        }
    } else if end > len as f64 {
        len
    } else {
        end as usize
    }
}

fn re_decimal() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$")
            .expect("decimal regex")
    })
}

/// StringToNumber: JS whitespace trim, `Infinity`, 0x/0o/0b, decimal literals.
fn string_to_number(text: &str) -> f64 {
    let trimmed = js_trim(text);
    if trimmed.is_empty() {
        return 0.0;
    }
    match trimmed {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    let bytes = trimmed.as_bytes();
    if bytes.len() > 2 && bytes[0] == b'0' {
        let radix = match bytes[1] {
            b'x' | b'X' => 16,
            b'o' | b'O' => 8,
            b'b' | b'B' => 2,
            _ => 0,
        };
        if radix != 0 {
            let mut value = 0.0_f64;
            for &byte in &bytes[2..] {
                let Some(digit) = char::from(byte).to_digit(radix) else {
                    return f64::NAN;
                };
                value = value * f64::from(radix) + f64::from(digit);
            }
            return value;
        }
    }
    if re_decimal().is_match(trimmed) {
        trimmed.parse().unwrap_or(f64::NAN)
    } else {
        f64::NAN
    }
}

/// `Number(value)`; a missing value is undefined → NaN.
fn to_number(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(flag)) => f64::from(u8::from(*flag)),
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(text)) => string_to_number(text),
        Some(array @ Value::Array(_)) => string_to_number(&js_string(array)),
        Some(Value::Object(_)) => f64::NAN,
    }
}

/// `parseInt(text, 10)`.
fn parse_int10(text: &str) -> f64 {
    let trimmed = text.trim_start_matches(is_js_whitespace);
    let (negative, rest) = match trimmed.as_bytes().first() {
        Some(b'-') => (true, &trimmed[1..]),
        Some(b'+') => (false, &trimmed[1..]),
        _ => (false, trimmed),
    };
    let digits = &rest[..rest.bytes().take_while(u8::is_ascii_digit).count()];
    if digits.is_empty() {
        return f64::NAN;
    }
    let value: f64 = digits.parse().unwrap_or(f64::NAN);
    if negative {
        -value
    } else {
        value
    }
}

/// `clampInt(value, min, max, fallback)` from rules.js.
fn clamp_int(value: Option<&Value>, min: f64, max: f64, fallback: f64) -> f64 {
    let number = parse_int10(&js_string_opt(value));
    if number.is_nan() {
        return fallback;
    }
    min.max(max.min(number))
}

// ── catalog ─────────────────────────────────────────────────────────────────

fn re_pattern() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^(\*|[a-z_]+\.(?:\*|[a-z_]+))$").expect("pattern regex"))
}

fn is_known_pattern(pattern: &str) -> bool {
    if !re_pattern().is_match(pattern) {
        return false;
    }
    if pattern == "*" {
        return true;
    }
    if let Some(domain) = pattern.strip_suffix(".*") {
        let prefix = format!("{domain}.");
        return event_types().any(|kind| kind.starts_with(&prefix));
    }
    event_types().any(|kind| kind == pattern) || ALIASES.iter().any(|(name, _)| *name == pattern)
}

/// `matchesPattern(pattern, type)`. The bridge sends `type` as a string or
/// null; a non-string type throws only on the `domain.*` path, as in JS.
fn matches_pattern(pattern: Option<&Value>, kind: Option<&Value>) -> Result<bool, String> {
    let Some(pattern) = pattern.and_then(Value::as_str) else {
        return Ok(false);
    };
    if !is_known_pattern(pattern) {
        return Ok(false);
    }
    let kind = kind.and_then(Value::as_str);
    if pattern == "*" || kind == Some(pattern) {
        return Ok(true);
    }
    if pattern.ends_with(".*") {
        let Some(kind) = kind else {
            return Err(type_error("type.startsWith is not a function".to_string()));
        };
        return Ok(kind.starts_with(&pattern[..pattern.len() - 1]));
    }
    Ok(ALIASES
        .iter()
        .find(|(name, _)| *name == pattern)
        .is_some_and(|(_, members)| kind.is_some_and(|kind| members.contains(&kind))))
}

fn matches_any(patterns: Option<&Value>, kind: Option<&Value>) -> Result<bool, String> {
    let Some(Value::Array(patterns)) = patterns else {
        return Ok(false);
    };
    for pattern in patterns {
        if matches_pattern(Some(pattern), kind)? {
            return Ok(true);
        }
    }
    Ok(false)
}

// ── rules ───────────────────────────────────────────────────────────────────

fn re_id() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z0-9._:-]{1,128}$").expect("id regex"))
}
fn re_cli() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[a-z][a-z0-9-]{0,31}$").expect("cli regex"))
}
fn re_secret_name() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z0-9_.-]{1,64}$").expect("secret name regex"))
}
fn re_channel_plugin() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[a-z0-9][a-z0-9-]{0,63}$").expect("channel plugin regex"))
}
fn re_channel_target() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z0-9._:-]{1,64}$").expect("channel target regex"))
}

/// `value == null ? '' : String(value).slice(0, max)`.
fn text_field(value: Option<&Value>, max: usize) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => utf16_prefix(&js_string(value), max),
    }
}

/// `idList(value)`: one or many ids, stringified, shape-checked, capped.
fn id_list(value: Option<&Value>) -> Vec<String> {
    let items: Vec<String> = match value {
        None | Some(Value::Null) => return Vec::new(),
        Some(Value::Array(items)) => items.iter().map(js_string).collect(),
        Some(value) => vec![js_string(value)],
    };
    items
        .into_iter()
        .filter(|item| re_id().is_match(item))
        .take(MAX_FILTER_IDS)
        .collect()
}

/// Webhook URL syntax check (WHATWG parse). Private/loopback rejection happens
/// at send time after DNS resolution; this only rejects obviously bad input.
///
/// The `url` crate follows the spec on invalid punycode (`xn--a.com`, `a.xn--`)
/// and rejects it, where Node's parser accepted it; it never accepts a URL
/// Node rejects, so whatever passes here still parses in the JS sender. Other
/// differences only change which rejection message a non-http(s) URL gets.
fn validate_webhook_url(raw: Option<&Value>) -> Option<String> {
    let Ok(url) = Url::parse(&js_string_opt(raw)) else {
        return Some("invalid webhook url".to_string());
    };
    if url.scheme() != "https" && url.scheme() != "http" {
        return Some("webhook url must be http(s)".to_string());
    }
    if !url.username().is_empty() || url.password().is_some_and(|password| !password.is_empty()) {
        return Some("webhook url must not embed credentials".to_string());
    }
    None
}

fn action_error(message: impl Into<String>) -> Value {
    json!({ "error": message.into() })
}

/// `validateAction(raw)` → `{ action }` or `{ error }`.
fn validate_action(raw: Option<&Value>) -> Value {
    let raw = match raw {
        Some(value @ (Value::Object(_) | Value::Array(_))) => Some(value),
        _ => return action_error("action is required"),
    };
    let kind = text_or(prop(raw, "kind"), "");
    if !ACTION_KINDS.contains(&kind.as_str()) {
        return action_error(format!("unknown action kind ({})", ACTION_KINDS.join("|")));
    }
    let mut action = Map::new();
    action.insert("kind".into(), json!(kind));
    match kind.as_str() {
        "inject-prompt" => {
            action.insert(
                "prompt".into(),
                json!(text_field(prop(raw, "prompt"), 4000)),
            );
            if truthy_opt(prop(raw, "targetSessionId")) {
                let Some(target) = id_list(prop(raw, "targetSessionId")).into_iter().next() else {
                    return action_error("invalid targetSessionId");
                };
                action.insert("targetSessionId".into(), json!(target));
            }
            // Create a fresh chat session per firing instead of reusing one. dirId /
            // cli may be empty: the runtime then follows the session that raised it.
            let new_session = prop(raw, "newSession");
            if truthy_opt(new_session) {
                if action.contains_key("targetSessionId") {
                    return action_error("targetSessionId and newSession are mutually exclusive");
                }
                let spec = match new_session {
                    Some(value @ (Value::Object(_) | Value::Array(_))) => Some(value),
                    _ => None,
                };
                let dir_id = id_list(prop(spec, "dirId")).into_iter().next();
                if truthy_opt(prop(spec, "dirId")) && dir_id.is_none() {
                    return action_error("invalid newSession.dirId");
                }
                let cli = text_or(prop(spec, "cli"), "");
                if !cli.is_empty() && !re_cli().is_match(&cli) {
                    return action_error("invalid newSession.cli");
                }
                let title = text_field(prop(spec, "title"), 120);
                action.insert(
                    "newSession".into(),
                    json!({ "dirId": dir_id.unwrap_or_default(), "cli": cli, "title": js_trim(&title) }),
                );
            }
        }
        "webhook" => {
            let url = prop(raw, "url");
            if let Some(problem) = validate_webhook_url(url) {
                return action_error(problem);
            }
            action.insert("url".into(), json!(utf16_prefix(&js_string_opt(url), 2000)));
            action.insert(
                "includeConclusion".into(),
                json!(matches!(
                    prop(raw, "includeConclusion"),
                    Some(Value::Bool(true))
                )),
            );
            match prop(raw, "secretName") {
                None | Some(Value::Null) => {}
                Some(Value::String(name)) if name.is_empty() => {}
                Some(name) => {
                    let name = js_string(name);
                    if !re_secret_name().is_match(&name) {
                        return action_error("invalid secretName");
                    }
                    action.insert("secretName".into(), json!(name));
                }
            }
        }
        "channel" => {
            // Shape only: whether the recipient exists is checked at save time
            // (channelProblem), so a rule whose recipient vanished still loads.
            let plugin = text_or(prop(raw, "plugin"), "");
            let target = text_or(prop(raw, "target"), "");
            if !re_channel_plugin().is_match(&plugin) || !re_channel_target().is_match(&target) {
                return action_error("invalid channel action");
            }
            action.insert("plugin".into(), json!(plugin));
            action.insert("target".into(), json!(target));
            action.insert(
                "message".into(),
                json!(text_field(prop(raw, "message"), 400)),
            );
        }
        _ => {
            action.insert(
                "message".into(),
                json!(text_field(prop(raw, "message"), 400)),
            );
        }
    }
    json!({ "action": action })
}

/// `validateEventRule(body, { scope })` → `{ error }` or
/// `{ rule, needsId, needsCreatedAt }`; the bridge fills id/createdAt from its
/// injected factories, in that order, only for a valid rule.
fn validate_event_rule(body: Option<&Value>, scope: Option<&Value>) -> Result<Value, String> {
    let empty = Value::Object(Map::new());
    let body = match body {
        None => &empty,
        Some(Value::Null) => {
            return Err(type_error(
                "Cannot read properties of null (reading 'on')".to_string(),
            ))
        }
        Some(body) => body,
    };
    let body = Some(body);
    let on: Vec<String> = match prop(body, "on") {
        Some(Value::Array(items)) => items.iter().map(js_string).collect(),
        Some(value) if truthy(value) => vec![js_string(value)],
        _ => Vec::new(),
    };
    if on.is_empty() || on.len() > MAX_PATTERNS {
        return Ok(action_error(format!(
            "on requires 1-{MAX_PATTERNS} event patterns"
        )));
    }
    // JS `if (unknown)`: the first unknown pattern is reported only when it is
    // truthy, so an empty string first in line lets the rule through (pinned).
    if let Some(unknown) = on.iter().find(|pattern| !is_known_pattern(pattern)) {
        if !unknown.is_empty() {
            return Ok(action_error(format!(
                "unknown event pattern: {}",
                utf16_prefix(unknown, 60)
            )));
        }
    }
    let validated = validate_action(prop(body, "action"));
    if let Some(error) = validated.get("error") {
        return Ok(json!({ "error": error }));
    }
    let action = validated["action"].clone();

    let steps: Vec<&Value> = match prop(body, "then") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => items.iter().collect(),
        Some(value) => vec![value],
    };
    if steps.len() > MAX_CHAIN_STEPS {
        return Ok(action_error(format!(
            "then allows at most {MAX_CHAIN_STEPS} steps"
        )));
    }
    let mut then = Vec::with_capacity(steps.len());
    for (index, step) in steps.into_iter().enumerate() {
        let step = validate_action(Some(step));
        if let Some(error) = step.get("error") {
            return Ok(action_error(format!("then[{index}]: {}", js_string(error))));
        }
        then.push(step["action"].clone());
    }

    let source = match prop(body, "filter") {
        Some(value @ (Value::Object(_) | Value::Array(_))) => Some(value),
        _ => None,
    };
    let mut filter = Map::new();
    let session_ids = id_list(prop(source, "sessionIds"));
    let dir_ids = id_list(prop(source, "dirIds"));
    if !session_ids.is_empty() {
        filter.insert("sessionIds".into(), json!(session_ids));
    }
    if !dir_ids.is_empty() {
        filter.insert("dirIds".into(), json!(dir_ids));
    }
    if let Some(goal @ Value::String(text)) = prop(source, "goalState") {
        if text == "achieved" || text == "interact" {
            filter.insert("goalState".into(), goal.clone());
        }
    }
    if let Some(cancelled @ Value::Bool(_)) = prop(source, "cancelled") {
        filter.insert("cancelled".into(), cancelled.clone());
    }

    let injecting = action["kind"] == "inject-prompt";
    let cooldown = (if injecting {
        MIN_INJECT_COOLDOWN_MS
    } else {
        0.0
    })
    .max(clamp_int(
        prop(body, "cooldownMs"),
        0.0,
        MAX_COOLDOWN_MS,
        if injecting {
            DEFAULT_INJECT_COOLDOWN_MS
        } else {
            0.0
        },
    ));
    let id = prop(body, "id");
    let created_at = prop(body, "createdAt");
    let rule = json!({
        "id": value_or(id, Value::Null),
        "type": "event",
        "scope": scope.cloned().unwrap_or_else(|| json!("global")),
        "name": text_field(prop(body, "name"), 80),
        "enabled": !matches!(prop(body, "enabled"), Some(Value::Bool(false))),
        // One-shot hook: the engine disables it after the first successful
        // firing and stamps `firedAt`. Persistent is the default.
        "once": matches!(prop(body, "once"), Some(Value::Bool(true))),
        "on": on,
        "filter": filter,
        "action": action,
        "then": then,
        // Integral and clamped to [0, 86400000]; `as i64` also folds -0 to 0.
        "cooldownMs": cooldown as i64,
        "mode": "inject",
        "createdAt": value_or(created_at, Value::Null),
    });
    Ok(json!({
        "rule": rule,
        "needsId": !truthy_opt(id),
        "needsCreatedAt": !truthy_opt(created_at),
    }))
}

/// `list.includes(needle)` for an array (SameValueZero) or a string (substring).
fn includes(list: &Value, needle: Option<&Value>) -> Result<bool, String> {
    match list {
        Value::Array(items) => Ok(items.iter().any(|item| strict_equal(Some(item), needle))),
        Value::String(text) => Ok(text.contains(&js_string_opt(needle))),
        _ => Err(type_error(
            "filter ids .includes is not a function".to_string(),
        )),
    }
}

fn matches_filter(rule: Option<&Value>, event: Option<&Value>) -> Result<bool, String> {
    let filter = read(rule, "filter")?.filter(|value| truthy(value));
    if let Some(ids) = prop(filter, "sessionIds").filter(|value| truthy(value)) {
        if !includes(ids, read(event, "sessionId")?)? {
            return Ok(false);
        }
    }
    if let Some(ids) = prop(filter, "dirIds").filter(|value| truthy(value)) {
        if !includes(ids, read(event, "dirId")?)? {
            return Ok(false);
        }
    }
    if let Some(goal) = prop(filter, "goalState").filter(|value| truthy(value)) {
        let actual = read(read(event, "data")?, "goalState")?;
        if !strict_equal(actual, Some(goal)) {
            return Ok(false);
        }
    }
    if let Some(Value::Bool(cancelled)) = prop(filter, "cancelled") {
        let actual = read(read(event, "data")?, "cancelled")?;
        if truthy_opt(actual) != *cancelled {
            return Ok(false);
        }
    }
    Ok(true)
}

/// The channel actions of a rule (main action and chain steps).
fn channel_actions(rule: Option<&Value>) -> Value {
    let mut actions: Vec<&Value> = Vec::new();
    if truthy_opt(rule) {
        actions.extend(prop(rule, "action"));
        if let Some(Value::Array(steps)) = prop(rule, "then") {
            actions.extend(steps.iter());
        }
    }
    Value::Array(
        actions
            .into_iter()
            .filter(|action| truthy(action) && action.get("kind") == Some(&json!("channel")))
            .cloned()
            .collect(),
    )
}

// ── envelope ────────────────────────────────────────────────────────────────

// JS `\s` (WhiteSpace + LineTerminator): includes U+FEFF, excludes U+0085.
const JS_SPACE_CLASS: &str = r"\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";

/// An ASCII literal under JS `/i` without `u`: letters fold to ASCII only.
fn ascii_ci(literal: &str) -> String {
    literal
        .chars()
        .map(|character| {
            if character.is_ascii_alphabetic() {
                format!(
                    "[{}{}]",
                    character.to_ascii_lowercase(),
                    character.to_ascii_uppercase()
                )
            } else {
                regex::escape(&character.to_string())
            }
        })
        .collect()
}

fn re_secret() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        let ws = JS_SPACE_CLASS;
        let keyword = [
            format!("{}[_-]?{}", ascii_ci("api"), ascii_ci("key")),
            ascii_ci("token"),
            ascii_ci("secret"),
            ascii_ci("password"),
            ascii_ci("authorization"),
        ]
        .join("|");
        let pattern = format!(
            "({sk}-[A-Za-z0-9_-]{{16,}}|{gh}[pousrPOUSR]_[A-Za-z0-9]{{20,}}|{bearer}[{ws}]+[A-Za-z0-9._~+/=-]{{16,}}|((?:{keyword})[\"']?[{ws}]*[:=][{ws}]*[\"']?)[^{ws}\"',}}]{{8,}})",
            sk = ascii_ci("sk"),
            gh = ascii_ci("gh"),
            bearer = ascii_ci("Bearer"),
        );
        Regex::new(&pattern).expect("secret redaction regex")
    })
}

// Surrogate units map onto plane-15 private-use placeholders so a regex
// quantifier counts UTF-16 code units, as the old non-`u` JS regex did.
const UNIT_BASE: u32 = 0xF0000;

fn is_unit_placeholder(character: char) -> bool {
    (UNIT_BASE..UNIT_BASE + 0x800).contains(&u32::from(character))
}

fn to_unit_view(text: &str) -> Cow<'_, str> {
    if text.chars().all(|character| u32::from(character) <= 0xFFFF) {
        return Cow::Borrowed(text);
    }
    let mut view = String::with_capacity(text.len() + 8);
    let mut buffer = [0_u16; 2];
    for character in text.chars() {
        if u32::from(character) <= 0xFFFF {
            view.push(character);
            continue;
        }
        for unit in character.encode_utf16(&mut buffer).iter() {
            let placeholder = char::from_u32(UNIT_BASE + (u32::from(*unit) - 0xD800));
            view.push(placeholder.expect("plane-15 placeholder"));
        }
    }
    Cow::Owned(view)
}

fn from_unit_view(view: &str) -> String {
    if !view.chars().any(is_unit_placeholder) {
        return view.to_string();
    }
    let mut units: Vec<u16> = Vec::with_capacity(view.len());
    let mut buffer = [0_u16; 2];
    for character in view.chars() {
        if is_unit_placeholder(character) {
            units.push((u32::from(character) - UNIT_BASE + 0xD800) as u16);
        } else {
            units.extend_from_slice(character.encode_utf16(&mut buffer));
        }
    }
    String::from_utf16_lossy(&units)
}

/// `redactText(text)`: secrets → `***` (keeping a `key=` prefix), home → `~`.
fn redact(text: &str, home: &str) -> String {
    let view = to_unit_view(text);
    let replaced = re_secret().replace_all(&view, |captures: &Captures| match captures.get(2) {
        Some(prefix) => format!("{}***", prefix.as_str()),
        None => "***".to_string(),
    });
    let out = from_unit_view(&replaced);
    if !home.is_empty() && home != "/" {
        out.replace(home, "~")
    } else {
        out
    }
}

/// `clipText(text, max)`: redact, trim, cap at `max` UTF-16 units plus `…`.
fn clip(text: &str, max: f64, home: &str) -> String {
    let redacted = redact(text, home);
    let value = js_trim(&redacted);
    let len = utf16_len(value);
    if len as f64 > max {
        format!("{}…", utf16_prefix(value, slice_end(max, len)))
    } else {
        value.to_string()
    }
}

fn message_text(message: &Value) -> String {
    match message.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter(|block| truthy(block) && block.get("type") == Some(&json!("text")))
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// One page of `conclusionFromHistory`: the last non-empty assistant reply in
/// `messages`, clipped and redacted, or null when the page has none. The
/// bridge pages from the end, so a long history never crosses FFI whole.
fn conclusion_page(messages: Option<&Value>, home: &str) -> Value {
    let Some(Value::Array(messages)) = messages else {
        return Value::Null;
    };
    for message in messages.iter().rev() {
        if message.get("role") == Some(&json!("assistant")) {
            let text = message_text(message);
            let text = js_trim(&text);
            if !text.is_empty() {
                return json!(clip(text, CONCLUSION_MAX as f64, home));
            }
        }
    }
    Value::Null
}

/// The text injected into the next session. The user's instruction goes last.
fn render_injection(event: Option<&Value>, instruction: Option<&Value>) -> Result<String, String> {
    let data = read(event, "data")?.filter(|value| truthy(value));
    let field = |key: &str| prop(data, key);
    let mut lines = vec![format!(
        "【multicc 自动触发】事件 {}",
        js_string_opt(read(event, "type")?)
    )];
    lines.push(format!(
        "来源会话：{}\u{3000}任务：{}",
        text_or(read(event, "sessionId")?, "（无）"),
        text_or(field("goal"), "（未命名）")
    ));
    if let Some(goal_state) = field("goalState").filter(|value| truthy(value)) {
        let key = js_string(goal_state);
        let label = lookup(&GOAL_STATE_LABEL, &key).map_or(key, str::to_string);
        lines.push(format!("目标状态：{label}"));
    }
    if let Some(category) = field("errorCategory").filter(|value| truthy(value)) {
        let stopped = if truthy_opt(field("cancelled")) {
            "（用户主动停止）"
        } else {
            ""
        };
        lines.push(format!("错误类别：{}{stopped}", js_string(category)));
    }
    if let Some(summary) = field("summary").filter(|value| truthy(value)) {
        lines.push(format!("任务摘要：{}", js_string(summary)));
    }
    if let Some(conclusion) = field("conclusion").filter(|value| truthy(value)) {
        lines.push(format!(
            "上一轮结论（已截断，完整内容请用来源会话 id 读取历史）：\n{}",
            js_string(conclusion)
        ));
    }
    lines.push(String::new());
    let instruction = match instruction {
        Some(Value::String(text)) => js_trim(text).to_string(),
        Some(value) if truthy(value) => {
            return Err(type_error(
                "(instruction || '').trim is not a function".to_string(),
            ))
        }
        _ => String::new(),
    };
    let instruction = if instruction.is_empty() {
        DEFAULT_INSTRUCTION.to_string()
    } else {
        instruction
    };
    lines.push(format!("你的指令：{instruction}"));
    Ok(lines.join("\n"))
}

// ── task transitions ────────────────────────────────────────────────────────

fn letter_of(state: Option<&Value>) -> Option<&'static str> {
    let letter = prop(state, "classifyState")?.as_str()?;
    LETTER_EVENT
        .iter()
        .find(|(name, _)| *name == letter)
        .map(|(name, _)| *name)
}

fn goal_of(state: Option<&Value>) -> Option<&'static str> {
    let goal = prop(state, "goalState")?.as_str()?;
    if !is_goal_state(goal) {
        return None;
    }
    GOAL_EVENT
        .iter()
        .find(|(name, _)| *name == goal)
        .map(|(name, _)| *name)
}

fn optional(name: Option<&'static str>) -> Value {
    name.map_or(Value::Null, |name| json!(name))
}

fn base_data(next: Option<&Value>) -> Map<String, Value> {
    let mut data = Map::new();
    data.insert("taskId".into(), value_or(prop(next, "taskId"), Value::Null));
    data.insert("goal".into(), value_or(prop(next, "goal"), json!("")));
    data.insert("phase".into(), value_or(prop(next, "phase"), json!("idle")));
    data.insert("classifyState".into(), optional(letter_of(next)));
    data.insert("goalState".into(), optional(goal_of(next)));
    data
}

/// `Number(state.goalStateManualAt || 0)`.
fn manual_at(state: Option<&Value>) -> f64 {
    let value = prop(state, "goalStateManualAt");
    if truthy_opt(value) {
        to_number(value)
    } else {
        0.0
    }
}

/// Ordered `{ type, data }` events from one taskState transition. The classify
/// letter is the only state source; goalState is the D sub-state, which may
/// arrive with D (classify), after D (refine) or by hand (manual).
fn derive_task_events(prev: Option<&Value>, next: Option<&Value>) -> Value {
    let mut events = Vec::new();
    if !truthy_opt(next) {
        return Value::Array(events);
    }
    let before = letter_of(prev);
    let after = letter_of(next);
    let goal_before = goal_of(prev);
    let goal_after = goal_of(next);

    if let Some(letter) = after.filter(|letter| Some(*letter) != before) {
        let mut data = base_data(next);
        data.insert("from".into(), optional(before));
        if is_abnormal_letter(letter) {
            let cancelled = truthy_opt(prop(next, "cancelledAt"));
            data.insert("cancelled".into(), json!(cancelled));
            let reason = if cancelled {
                value_or(prop(next, "cancelReason"), Value::Null)
            } else {
                Value::Null
            };
            data.insert("cancelReason".into(), reason);
            let api_error = prop(next, "apiError");
            let category = if truthy_opt(api_error) {
                prop(api_error, "category").filter(|value| truthy(value))
            } else {
                None
            };
            data.insert(
                "errorCategory".into(),
                category.map_or(Value::Null, |category| json!(js_string(category))),
            );
        }
        if is_processing_letter(letter) && before.is_some_and(is_terminal_letter) {
            let previous = prop(prev, "taskId");
            let current = prop(next, "taskId");
            if truthy_opt(previous) && truthy_opt(current) && !strict_equal(previous, current) {
                let mut restarted = data.clone();
                restarted.insert(
                    "previousTaskId".into(),
                    previous.cloned().unwrap_or(Value::Null),
                );
                events.push(json!({ "type": "task.restarted", "data": restarted }));
            }
        }
        events.push(json!({ "type": lookup(&LETTER_EVENT, letter), "data": data }));
    }

    // goalState only means something while the letter is D.
    let was_done = before.is_some_and(is_terminal_letter);
    if let (true, Some(goal)) = (after.is_some_and(is_terminal_letter), goal_after) {
        let previous = if was_done { goal_before } else { None };
        if Some(goal) != previous {
            let source = if !was_done {
                "classify"
            } else if manual_at(next) != manual_at(prev) {
                "manual"
            } else {
                "refine"
            };
            let mut data = base_data(next);
            data.insert("from".into(), optional(previous));
            data.insert("to".into(), json!(goal));
            data.insert("source".into(), json!(source));
            events.push(json!({ "type": "task.goal_resolved", "data": data.clone() }));
            events.push(json!({ "type": lookup(&GOAL_EVENT, goal), "data": data }));
        }
    }
    Value::Array(events)
}

/// Segment id used for idempotency: one task segment = task id + start time.
fn segment_key(state: Option<&Value>) -> String {
    format!(
        "{}@{}",
        text_or(prop(state, "taskId"), ""),
        text_or(prop(state, "startedAt"), "")
    )
}

// ── entry points ────────────────────────────────────────────────────────────

/// Constant tables; the JS modules snapshot this once at load.
pub fn catalog() -> Result<String, String> {
    let aliases: Map<String, Value> = ALIASES
        .iter()
        .map(|(name, members)| (name.to_string(), json!(members)))
        .collect();
    Ok(json!({
        "taskEvents": TASK_EVENTS,
        "turnEvents": TURN_EVENTS,
        "eventTypes": event_types().collect::<Vec<_>>(),
        "aliases": aliases,
        "actionKinds": ACTION_KINDS,
        "minInjectCooldownMs": MIN_INJECT_COOLDOWN_MS as i64,
        "maxChainSteps": MAX_CHAIN_STEPS,
        "conclusionMax": CONCLUSION_MAX,
        "summaryMax": SUMMARY_MAX,
        "conclusionEvents": CONCLUSION_EVENTS,
        "letterEvent": table_object(&LETTER_EVENT),
        "goalEvent": table_object(&GOAL_EVENT),
    })
    .to_string())
}

/// Logic-bearing calls (op dispatch). String-in/string-out, lenient at the JS
/// boundary. Text ops receive already-stringified text from the bridge.
pub fn request(op: &str, input: &str) -> Result<String, String> {
    let input: Value =
        crate::json_lenient::from_str(input).map_err(|e| format!("events_invalid_input: {e}"))?;
    let arg = |key: &str| input.as_object().and_then(|object| object.get(key));
    let text = || arg("text").and_then(Value::as_str).unwrap_or("");
    let home = || arg("home").and_then(Value::as_str).unwrap_or("");
    let out = match op {
        "isKnownPattern" => json!(arg("pattern")
            .and_then(Value::as_str)
            .is_some_and(is_known_pattern)),
        "matchesPattern" => json!(matches_pattern(arg("pattern"), arg("type"))?),
        "matchesAny" => json!(matches_any(arg("patterns"), arg("type"))?),
        "validateWebhookUrl" => validate_webhook_url(arg("raw")).map_or(Value::Null, Value::String),
        "validateAction" => validate_action(arg("raw")),
        "validateEventRule" => validate_event_rule(arg("body"), arg("scope"))?,
        "matchesFilter" => json!(matches_filter(arg("rule"), arg("event"))?),
        "channelActions" => channel_actions(arg("rule")),
        "redactText" => json!(redact(text(), home())),
        "clipText" => {
            let max = string_to_number(arg("max").and_then(Value::as_str).unwrap_or("NaN"));
            json!(clip(text(), max, home()))
        }
        "conclusionPage" => conclusion_page(arg("messages"), home()),
        "renderInjection" => json!(render_injection(arg("event"), arg("instruction"))?),
        "deriveTaskEvents" => derive_task_events(arg("prev"), arg("next")),
        "segmentKey" => json!(segment_key(arg("state"))),
        "letterOf" => optional(letter_of(arg("state"))),
        "goalOf" => optional(goal_of(arg("state"))),
        _ => return Err(format!("events_unknown_op: {op}")),
    };
    Ok(out.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(op: &str, input: Value) -> Value {
        serde_json::from_str(&request(op, &input.to_string()).unwrap()).unwrap()
    }

    #[test]
    fn catalog_and_patterns() {
        let catalog: Value = serde_json::from_str(&catalog().unwrap()).unwrap();
        assert_eq!(catalog["eventTypes"].as_array().unwrap().len(), 11);
        assert_eq!(catalog["eventTypes"][10], "trigger.fired");
        assert_eq!(
            catalog["aliases"]["task.done"],
            json!(["task.achieved", "task.needs_interaction"])
        );
        for known in [
            "*",
            "task.*",
            "turn.*",
            "task.done",
            "task.failed",
            "trigger.fired",
        ] {
            assert!(is_known_pattern(known), "{known}");
        }
        for unknown in [
            "",
            "task",
            "nope.*",
            "task.nope",
            "Task.failed",
            "task.failed ",
            "a.b.c",
        ] {
            assert!(!is_known_pattern(unknown), "{unknown}");
        }
        assert!(matches_pattern(Some(&json!("task.*")), Some(&json!("task.failed"))).unwrap());
        assert!(
            matches_pattern(Some(&json!("task.attention")), Some(&json!("task.failed"))).unwrap()
        );
        assert!(!matches_pattern(Some(&json!("task.done")), Some(&json!("task.failed"))).unwrap());
        assert!(matches_pattern(Some(&json!("*")), None).unwrap());
        // A non-string type only throws on the domain.* path.
        assert!(matches_pattern(Some(&json!("task.*")), None).is_err());
        assert!(!matches_pattern(Some(&json!("task.done")), None).unwrap());
        assert!(matches_any(
            Some(&json!(["x", "turn.*"])),
            Some(&json!("turn.completed"))
        )
        .unwrap());
        assert!(!matches_any(Some(&json!("turn.*")), Some(&json!("turn.completed"))).unwrap());
    }

    #[test]
    fn rule_validation_shapes_and_errors() {
        let out = call(
            "validateEventRule",
            json!({ "body": { "on": "task.done", "action": { "kind": "inject-prompt", "prompt": "hi" },
                "filter": { "sessionIds": ["s1", "bad id"], "goalState": "achieved", "cancelled": false } },
                "scope": "global" }),
        );
        let rule = &out["rule"];
        assert_eq!(out["needsId"], true);
        assert_eq!(out["needsCreatedAt"], true);
        assert_eq!(rule["on"], json!(["task.done"]));
        assert_eq!(
            rule["filter"],
            json!({ "sessionIds": ["s1"], "goalState": "achieved", "cancelled": false })
        );
        assert_eq!(rule["cooldownMs"], 60000);
        let keys: Vec<&String> = rule.as_object().unwrap().keys().collect();
        assert_eq!(
            keys,
            [
                "id",
                "type",
                "scope",
                "name",
                "enabled",
                "once",
                "on",
                "filter",
                "action",
                "then",
                "cooldownMs",
                "mode",
                "createdAt"
            ]
        );
        let cases = [
            (json!({}), "on requires 1-10 event patterns"),
            (
                json!({ "on": ["task.nope"] }),
                "unknown event pattern: task.nope",
            ),
            (json!({ "on": "*" }), "action is required"),
            (
                json!({ "on": "*", "action": { "kind": "x" } }),
                "unknown action kind (inject-prompt|webhook|notify|channel)",
            ),
            (
                json!({ "on": "*", "action": { "kind": "notify" }, "then": [null] }),
                "then[0]: action is required",
            ),
            (
                json!({ "on": "*", "action": { "kind": "webhook", "url": "ftp://x" } }),
                "webhook url must be http(s)",
            ),
            (
                json!({ "on": "*", "action": { "kind": "webhook", "url": "https://u:p@x" } }),
                "webhook url must not embed credentials",
            ),
            (
                json!({ "on": "*", "action": { "kind": "channel", "plugin": "Bad", "target": "t" } }),
                "invalid channel action",
            ),
            (
                json!({ "on": "*", "action": { "kind": "inject-prompt", "targetSessionId": "s", "newSession": true } }),
                "targetSessionId and newSession are mutually exclusive",
            ),
        ];
        for (body, error) in cases {
            assert_eq!(
                call("validateEventRule", json!({ "body": body }))["error"],
                error,
                "{body}"
            );
        }
        assert!(request("validateEventRule", r#"{"body":null}"#).is_err());
        // Stricter than Node on invalid punycode, by design (spec-conforming).
        assert_eq!(
            validate_webhook_url(Some(&json!("https://xn--a.com/hook"))).as_deref(),
            Some("invalid webhook url")
        );
        assert_eq!(
            validate_webhook_url(Some(&json!("https://xn--fsq.com/hook"))),
            None
        );
        assert_eq!(
            validate_webhook_url(Some(&json!("https://例子.测试/路径"))),
            None
        );
        // An empty first unknown pattern is falsy in JS and slips through.
        let slipped = call(
            "validateEventRule",
            json!({ "body": { "on": ["", "task.nope"], "action": { "kind": "notify" } } }),
        );
        assert_eq!(slipped["rule"]["on"], json!(["", "task.nope"]));
        assert_eq!(
            call(
                "validateEventRule",
                json!({ "body": { "on": ["task.nope", ""] } })
            )["error"],
            "unknown event pattern: task.nope"
        );
    }

    #[test]
    fn cooldown_follows_parse_int() {
        let cooldown = |value: Value| {
            call(
                "validateEventRule",
                json!({ "body": { "on": "*", "action": { "kind": "notify" }, "cooldownMs": value } }),
            )["rule"]["cooldownMs"]
                .clone()
        };
        assert_eq!(cooldown(json!("  1500ms")), 1500);
        assert_eq!(cooldown(json!(1e21)), 1); // String(1e21) === "1e+21"
        assert_eq!(cooldown(json!(-5)), 0);
        assert_eq!(cooldown(json!("-0")), 0);
        assert_eq!(cooldown(json!(9e15)), 86_400_000);
        assert_eq!(cooldown(json!(null)), 0);
        assert_eq!(cooldown(json!([250])), 250);
    }

    #[test]
    fn filter_matching() {
        let rule = json!({ "filter": { "sessionIds": ["s1"], "cancelled": true } });
        let event = |session: &str, cancelled: Value| json!({ "sessionId": session, "data": { "cancelled": cancelled } });
        assert!(matches_filter(Some(&rule), Some(&event("s1", json!(1)))).unwrap());
        assert!(!matches_filter(Some(&rule), Some(&event("s2", json!(true)))).unwrap());
        assert!(!matches_filter(Some(&rule), Some(&event("s1", json!(0)))).unwrap());
        assert!(matches_filter(Some(&json!({})), None).unwrap());
        assert!(matches_filter(
            Some(&json!({ "filter": { "goalState": "x" } })),
            Some(&json!({}))
        )
        .is_err());
        assert!(matches_filter(Some(&Value::Null), Some(&json!({}))).is_err());
        let actions = channel_actions(Some(&json!({
            "action": { "kind": "channel", "plugin": "p" }, "then": [null, { "kind": "notify" }, { "kind": "channel" }]
        })));
        assert_eq!(actions.as_array().unwrap().len(), 2);
    }

    #[test]
    fn redaction_counts_utf16_units_and_js_whitespace() {
        assert_eq!(redact("key sk-abcdefghijklmnopqr end", ""), "key *** end");
        assert_eq!(redact("TOKEN: \"abcdefgh\"", ""), "TOKEN: \"***\"");
        assert_eq!(
            redact("Authorization: Bearer abcdefghijklmnop1234", ""),
            "Authorization: ***"
        );
        // Four astral characters are eight UTF-16 units: redacted, like JS.
        assert_eq!(redact("token=😀😀😀😀", ""), "token=***");
        assert_eq!(redact("token=😀😀😀", ""), "token=😀😀😀");
        // U+FEFF is JS whitespace; U+0085 is not (so it is part of the value).
        assert_eq!(redact("token\u{feff}=abcdefgh", ""), "token\u{feff}=***");
        assert_eq!(redact("token\u{85}=abcdefgh", ""), "token\u{85}=abcdefgh");
        // ASCII-only case folding: the Kelvin sign does not spell "key".
        assert_eq!(
            redact("api\u{212a}ey=abcdefgh", ""),
            "api\u{212a}ey=abcdefgh"
        );
        assert_eq!(redact("/home/me/x and /home/me", "/home/me"), "~/x and ~");
        assert_eq!(redact("/x", "/"), "/x");
    }

    #[test]
    fn clipping_and_conclusion() {
        assert_eq!(clip("  abcdef  ", 4.0, ""), "abcd…");
        assert_eq!(clip("abc", f64::NAN, ""), "abc");
        assert_eq!(clip("abcdef", -2.0, ""), "abcd…");
        // A cut through a surrogate pair leaves U+FFFD.
        assert_eq!(clip("a😀b", 2.0, ""), "a\u{fffd}…");
        let page = json!([
            { "role": "assistant", "content": [{ "type": "text", "text": "first" }] },
            { "role": "user", "content": "q" },
            { "role": "assistant", "content": [{ "type": "tool_use" }, { "type": "text", "text": "  " }] },
        ]);
        assert_eq!(conclusion_page(Some(&page), ""), "first");
        assert_eq!(
            conclusion_page(Some(&json!([{ "role": "user", "content": "x" }])), ""),
            Value::Null
        );
    }

    #[test]
    fn injection_rendering() {
        let event = json!({ "type": "task.failed", "sessionId": "s1", "data": {
            "goal": "g", "goalState": "achieved", "errorCategory": "quota", "cancelled": true,
            "summary": "sum", "conclusion": "done" } });
        let text = render_injection(Some(&event), Some(&json!("  do it "))).unwrap();
        assert_eq!(
            text,
            "【multicc 自动触发】事件 task.failed\n来源会话：s1\u{3000}任务：g\n目标状态：达成目标\n错误类别：quota（用户主动停止）\n任务摘要：sum\n上一轮结论（已截断，完整内容请用来源会话 id 读取历史）：\ndone\n\n你的指令：do it"
        );
        let bare = render_injection(Some(&json!({})), None).unwrap();
        assert_eq!(
            bare,
            "【multicc 自动触发】事件 undefined\n来源会话：（无）\u{3000}任务：（未命名）\n\n你的指令：请根据以上信息简短汇报，并给出下一步建议。"
        );
        assert!(render_injection(None, None).is_err());
        assert!(render_injection(Some(&event), Some(&json!(5))).is_err());
    }

    #[test]
    fn task_transitions() {
        let events = |prev: Value, next: Value| derive_task_events(Some(&prev), Some(&next));
        let out = events(
            json!({ "classifyState": "P" }),
            json!({ "classifyState": "E", "cancelledAt": 5, "apiError": { "category": 429 } }),
        );
        assert_eq!(out[0]["type"], "task.failed");
        assert_eq!(out[0]["data"]["cancelled"], true);
        assert_eq!(out[0]["data"]["errorCategory"], "429");
        assert_eq!(out[0]["data"]["phase"], "idle");
        let out = events(
            json!({ "classifyState": "D", "taskId": "a" }),
            json!({ "classifyState": "P", "taskId": "b" }),
        );
        assert_eq!(out[0]["type"], "task.restarted");
        assert_eq!(out[0]["data"]["previousTaskId"], "a");
        assert_eq!(out[1]["type"], "task.running");
        let out = events(
            json!({ "classifyState": "P" }),
            json!({ "classifyState": "D", "goalState": "interact" }),
        );
        let types: Vec<&str> = out
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["type"].as_str().unwrap())
            .collect();
        assert_eq!(
            types,
            [
                "task.finished",
                "task.goal_resolved",
                "task.needs_interaction"
            ]
        );
        assert_eq!(out[1]["data"]["source"], "classify");
        let out = events(
            json!({ "classifyState": "D", "goalState": "interact", "goalStateManualAt": "x" }),
            json!({ "classifyState": "D", "goalState": "achieved", "goalStateManualAt": "x" }),
        );
        assert_eq!(out[0]["data"]["source"], "manual", "NaN !== NaN");
        let out = events(
            json!({ "classifyState": "D", "goalState": "interact", "goalStateManualAt": 7 }),
            json!({ "classifyState": "D", "goalState": "achieved", "goalStateManualAt": "7" }),
        );
        assert_eq!(out[0]["data"]["source"], "refine");
        assert_eq!(derive_task_events(None, None), json!([]));
        assert_eq!(
            segment_key(Some(&json!({ "taskId": "t", "startedAt": 1.5 }))),
            "t@1.5"
        );
        assert_eq!(segment_key(None), "@");
    }

    #[test]
    fn js_number_coercions() {
        assert_eq!(string_to_number(" 0x1F "), 31.0);
        assert_eq!(string_to_number("Infinity"), f64::INFINITY);
        assert!(string_to_number("inf").is_nan());
        assert!(string_to_number("infinity").is_nan());
        assert!(string_to_number("-0x10").is_nan());
        assert_eq!(string_to_number(".5e1"), 5.0);
        assert_eq!(string_to_number(""), 0.0);
        assert!(string_to_number("\u{85}1").is_nan());
        assert_eq!(parse_int10("\u{feff} -12.9x"), -12.0);
        assert!(parse_int10("x1").is_nan());
    }
}
