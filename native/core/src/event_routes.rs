//! Rules kernel for the events & triggers route cluster (`src/events/routes.js`,
//! the five trigger routes of `src/triggers/index.js` and the two
//! `/api/annotation-live` routes of `src/annotation-live.js`).
//!
//! Everything that is a *rule* over the Node runtime's answers lives here: the
//! catalog body (`{events, aliases, actions, clis}`), the `?limit=` parse and
//! the hub's `[1, 200]` clamp, the `{items}` / `{rules}` wrappers, the event-rule
//! validation order (max-rules → schema → channel recipients), the trigger
//! schema and its `clampInt` rules (with cron validation delegated to the host
//! as a fact), the PUT spread that preserves `lastFiredAt`/`firedAt`, the manual
//! emit payload and the annotation relay payload coercions.
//!
//! Everything that needs the process-local world stays in Node behind one host
//! port, `POST /api/__host/events` (`src/routes/events-host.js`): the event hub
//! (recent ring, emit), the rule engine's rule table and persistence, the
//! session records and their persistence, `fireTrigger`, `reconcileSession`,
//! `appendEvent`, the cron parser, the plugin channel registry, and the
//! annotation-live config file, per-target JS regex matching, `remote-screen`
//! hand-off and webhook relay.
//!
//! Byte-for-byte parity is the contract: the front door serializes through the
//! V8-compatible `js_json_stringify`, so every body built here keeps the key
//! order the retired handlers produced.

use serde_json::{json, Map, Value};

use crate::cli_capability::ALIASES;
use crate::cli_switch::SUPPORTED_CHAT_CLIS;
use crate::events;
use crate::js::serde::{js_string, js_to_number, number_value, truthy, value_or_empty};
use crate::js::string::utf16_prefix;

/// `MAX_GLOBAL_RULES` in `src/events/engine.js`.
pub const MAX_GLOBAL_RULES: usize = 100;
/// `MAX_RECENT` in `src/events/hub.js`.
pub const MAX_RECENT: f64 = 200.0;
/// The route's fallback when `parseInt(req.query.limit, 10)` is NaN.
pub const DEFAULT_RECENT_LIMIT: f64 = 50.0;
/// `TRIGGER_TYPES` in `src/triggers/index.js`.
pub const TRIGGER_TYPES: [&str; 4] = ["post-turn", "file-change", "schedule", "event"];
/// `String(body.prompt).slice(0, 4000)`.
pub const MAX_PROMPT_UNITS: usize = 4000;
/// `paths.map(String).slice(0, 20)`.
pub const MAX_TRIGGER_PATHS: usize = 20;
/// `String(body.goal || 'test event').slice(0, 80)`.
pub const MAX_EVENT_GOAL_UNITS: usize = 80;

/// The id/creation-time pair the retired handlers pulled from `crypto`/`Date`
/// only for a rule that passed validation. Node owns those factories, so the
/// front door asks the host for one pair up front (generating them is pure).
#[derive(Debug, Clone)]
pub struct Identity {
    pub id: String,
    pub created_at: String,
}

/// `GET /api/events/catalog`.
pub fn catalog_body() -> Value {
    let catalog = events::catalog_object();
    let mut body = Map::new();
    body.insert("events".into(), member(&catalog, "eventTypes"));
    body.insert("aliases".into(), member(&catalog, "aliases"));
    body.insert("actions".into(), member(&catalog, "actionKinds"));
    body.insert(
        "clis".into(),
        Value::Array(client_clis().into_iter().map(Value::String).collect()),
    );
    Value::Object(body)
}

/// `CLIENT_CHAT_CLIS = SUPPORTED_CHAT_CLIS.filter(cli => !isAlias(cli))`.
///
/// `isAlias` lower-cases the id and tests `CLI_ALIASES` own keys; every
/// `SUPPORTED_CHAT_CLIS` entry is already lower-case, so this is the same list.
pub fn client_clis() -> Vec<String> {
    SUPPORTED_CHAT_CLIS
        .iter()
        .filter(|cli| !ALIASES.iter().any(|(alias, _)| alias == *cli))
        .map(|cli| (*cli).to_string())
        .collect()
}

/// `parseInt(req.query.limit, 10)` then `hub.recent`'s
/// `Math.max(1, Math.min(limit, MAX_RECENT))`; NaN reads as 50.
pub fn recent_limit(raw: Option<&Value>) -> i64 {
    let parsed = parse_int10(&value_or_empty(raw));
    let limit = if parsed.is_nan() {
        DEFAULT_RECENT_LIMIT
    } else {
        parsed
    };
    limit.clamp(1.0, MAX_RECENT) as i64
}

/// `{ events: hub.recent(limit), runs: engine.recentResults(), chains:
/// engine.pendingChains() }`.
pub fn recent_body(host: &Value) -> Value {
    let mut body = Map::new();
    body.insert("events".into(), member(host, "events"));
    body.insert("runs".into(), member(host, "runs"));
    body.insert("chains".into(), member(host, "chains"));
    Value::Object(body)
}

/// `{ <key>: value }` for `GET /api/event-triggers` and `/api/event-rules`.
pub fn single_key(key: &str, value: Value) -> Value {
    let mut body = Map::new();
    body.insert(key.to_string(), value);
    Value::Object(body)
}

/// `{ error: message }` — every simple 4xx body in this cluster.
pub fn error_body(message: &str) -> Value {
    json!({ "error": message })
}

/// `globalRules.length >= MAX_GLOBAL_RULES`.
pub fn too_many_global(count: i64) -> bool {
    count >= MAX_GLOBAL_RULES as i64
}

/// The reason an event rule failed validation: a schema refusal (400) or the
/// unreachable `TypeError` the JS bridge would rethrow (500).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuleError {
    Invalid(String),
    Thrown(String),
}

/// `validateEventRule(body, { scope })` with the injected factories filled in.
///
/// `id` is the factory answer for `needsId`; `created_at` is the factory answer
/// for `needsCreatedAt` (`None` = a JS `undefined`, which drops the key, exactly
/// like the PUT handler whose `nowIso` closure returned `old.createdAt`).
pub fn validate_event_rule(
    body: &Value,
    scope: &str,
    id: Option<&Value>,
    created_at: Option<&Value>,
) -> Result<Value, RuleError> {
    let scope_value = Value::String(scope.to_string());
    let out =
        events::validate_event_rule(Some(body), Some(&scope_value)).map_err(RuleError::Thrown)?;
    if let Some(error) = out.get("error") {
        return Err(RuleError::Invalid(js_string(error)));
    }
    let mut rule = out.get("rule").cloned().unwrap_or(Value::Null);
    let Some(object) = rule.as_object_mut() else {
        return Ok(rule);
    };
    if truthy(out.get("needsId").unwrap_or(&Value::Null)) {
        if let Some(id) = id {
            object.insert("id".into(), id.clone());
        }
    }
    if truthy(out.get("needsCreatedAt").unwrap_or(&Value::Null)) {
        match created_at {
            Some(value) => {
                object.insert("createdAt".into(), value.clone());
            }
            None => {
                object.remove("createdAt");
            }
        }
    }
    Ok(rule)
}

/// `channelProblem(rule, check)` is worth a host round trip only when the rule
/// carries a channel action at all.
pub fn has_channel_actions(rule: &Value) -> bool {
    match events::channel_actions(Some(rule)) {
        Value::Array(actions) => !actions.is_empty(),
        _ => false,
    }
}

/// `{ ...old, ...body, id }` — JS spread order: keys of `old`, then keys of
/// `body` (existing keys keep their position), then the path `id` last.
pub fn merge_rule(old: &Value, body: &Value, id: &str) -> Value {
    let mut out = Map::new();
    if let Some(object) = old.as_object() {
        for (key, value) in object {
            out.insert(key.clone(), value.clone());
        }
    }
    if let Some(object) = body.as_object() {
        for (key, value) in object {
            out.insert(key.clone(), value.clone());
        }
    }
    out.insert("id".into(), Value::String(id.to_string()));
    Value::Object(out)
}

/// The PUT handler's stamp preservation: `lastFiredAt` is copied even when it
/// is `null` (only an absent key stays absent), `firedAt` only when truthy.
pub fn carry_stamps(rule: Value, old: &Value) -> Value {
    let mut object = match rule {
        Value::Object(object) => object,
        other => return other,
    };
    if let Some(value) = old.get("lastFiredAt") {
        object.insert("lastFiredAt".into(), value.clone());
    }
    if let Some(value) = old.get("firedAt") {
        if truthy(value) {
            object.insert("firedAt".into(), value.clone());
        }
    }
    Value::Object(object)
}

/// The outcome of validating one trigger body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TriggerPlan {
    /// Ready to persist.
    Ready(Value),
    /// A `schedule` trigger whose cron expression must pass `cron.validate`.
    NeedsCron(Value, String),
    /// A 400 with this message.
    Invalid(String),
    /// The unreachable `TypeError` (500).
    Thrown(String),
}

/// `validateTrigger(body)` from `src/triggers/index.js` minus the host-only
/// `cron.validate` and channel-recipient checks.
pub fn validate_trigger(body: &Value, identity: &Identity) -> TriggerPlan {
    let type_name = value_or_empty(body.get("type"));
    if !TRIGGER_TYPES.contains(&type_name.as_str()) {
        return TriggerPlan::Invalid("invalid type".into());
    }
    if type_name == "event" {
        let id = Value::String(identity.id.clone());
        let created_at = Value::String(identity.created_at.clone());
        return match validate_event_rule(body, "session", Some(&id), Some(&created_at)) {
            Ok(rule) => TriggerPlan::Ready(rule),
            Err(RuleError::Invalid(message)) => TriggerPlan::Invalid(message),
            Err(RuleError::Thrown(message)) => TriggerPlan::Thrown(message),
        };
    }
    let mut trigger = Map::new();
    trigger.insert("id".into(), or_identity(body.get("id"), &identity.id));
    trigger.insert("type".into(), Value::String(type_name.clone()));
    trigger.insert(
        "enabled".into(),
        Value::Bool(!matches!(body.get("enabled"), Some(Value::Bool(false)))),
    );
    trigger.insert(
        "prompt".into(),
        match body.get("prompt") {
            None | Some(Value::Null) => Value::String(String::new()),
            Some(value) => Value::String(utf16_prefix(&js_string(value), MAX_PROMPT_UNITS)),
        },
    );
    let fallback = if type_name == "post-turn" {
        30_000.0
    } else {
        0.0
    };
    trigger.insert(
        "cooldownMs".into(),
        Value::from(events::clamp_int(body.get("cooldownMs"), 0.0, 86_400_000.0, fallback) as i64),
    );
    trigger.insert("mode".into(), Value::String("inject".into()));
    trigger.insert(
        "createdAt".into(),
        or_identity(body.get("createdAt"), &identity.created_at),
    );
    if type_name == "file-change" {
        let paths = match body.get("paths") {
            Some(Value::String(text)) => vec![Value::String(text.clone())],
            Some(Value::Array(items)) => items.clone(),
            _ => return TriggerPlan::Invalid("file-change requires paths[]".into()),
        };
        if paths.is_empty() {
            return TriggerPlan::Invalid("file-change requires paths[]".into());
        }
        trigger.insert(
            "paths".into(),
            Value::Array(
                paths
                    .iter()
                    .take(MAX_TRIGGER_PATHS)
                    .map(|item| Value::String(js_string(item)))
                    .collect(),
            ),
        );
        trigger.insert(
            "debounceMs".into(),
            Value::from(events::clamp_int(body.get("debounceMs"), 500.0, 60_000.0, 3_000.0) as i64),
        );
    }
    if type_name == "schedule" {
        let cron = match body.get("cron").filter(|value| truthy(value)) {
            Some(value) => js_string(value),
            None => return TriggerPlan::Invalid("invalid cron expression".into()),
        };
        trigger.insert("cron".into(), Value::String(cron.clone()));
        return TriggerPlan::NeedsCron(Value::Object(trigger), cron);
    }
    TriggerPlan::Ready(Value::Object(trigger))
}

/// `triggerLabel(trigger)` from `src/triggers/index.js` (`appendEvent` label).
pub fn trigger_label(trigger: &Value) -> String {
    match value_or_empty(trigger.get("type")).as_str() {
        "file-change" => format!("文件变更 {}", join_list(trigger.get("paths"))),
        "schedule" => format!("定时 {}", value_or_empty(trigger.get("cron"))),
        "event" => format!("事件 {}", join_list(trigger.get("on"))),
        _ => "每轮结束".to_string(),
    }
}

/// `(value || []).join(',')` for the two list fields the label reads.
fn join_list(value: Option<&Value>) -> String {
    match value {
        Some(Value::Array(items)) => items.iter().map(js_string).collect::<Vec<_>>().join(","),
        _ => String::new(),
    }
}

/// `{ ...trigger, enabled: true, cooldownMs: 0 }` for the manual `/test` route.
pub fn forced_trigger(trigger: &Value) -> Value {
    let mut object = match trigger {
        Value::Object(object) => object.clone(),
        other => return other.clone(),
    };
    object.insert("enabled".into(), Value::Bool(true));
    object.insert("cooldownMs".into(), Value::from(0i64));
    Value::Object(object)
}

/// `EVENT_TYPES.includes(body.type)` → the accepted type string.
pub fn event_type(body: &Value) -> Option<String> {
    let catalog = events::catalog_object();
    let types = catalog.get("eventTypes")?.as_array()?;
    let requested = body.get("type")?;
    types
        .iter()
        .any(|known| strict_equal(known, requested))
        .then(|| js_string(requested))
}

/// The emit input for `hub.emit(type, sessionId, { goal, goalState },
/// { origin: 'manual-test' })`.
pub fn event_emit_input(body: &Value) -> Value {
    let mut out = Map::new();
    out.insert("type".into(), member(body, "type"));
    out.insert(
        "sessionId".into(),
        match body.get("sessionId").filter(|value| truthy(value)) {
            Some(value) => Value::String(js_string(value)),
            None => Value::Null,
        },
    );
    let goal = match body.get("goal").filter(|value| truthy(value)) {
        Some(value) => js_string(value),
        None => "test event".to_string(),
    };
    out.insert(
        "goal".into(),
        Value::String(utf16_prefix(&goal, MAX_EVENT_GOAL_UNITS)),
    );
    out.insert(
        "goalState".into(),
        match body.get("goalState").filter(|value| truthy(value)) {
            Some(value) => value.clone(),
            None => Value::Null,
        },
    );
    Value::Object(out)
}

/// `{ ok: true, eventId: event && event.eventId }` (`null` for a refused emit).
pub fn event_test_body(event_id: Option<&Value>) -> Value {
    let mut out = Map::new();
    out.insert("ok".into(), Value::Bool(true));
    out.insert("eventId".into(), event_id.cloned().unwrap_or(Value::Null));
    Value::Object(out)
}

/// The normalized relay payload of `POST /api/annotation-live`.
pub fn annotation_payload(body: &Value) -> Value {
    let mut out = Map::new();
    out.insert(
        "sessionId".into(),
        Value::String(value_or_empty(body.get("sessionId"))),
    );
    out.insert("src".into(), Value::String(value_or_empty(body.get("src"))));
    out.insert("width".into(), number_or_zero(body.get("width")));
    out.insert("height".into(), number_or_zero(body.get("height")));
    out.insert(
        "kind".into(),
        Value::String(value_or_empty(body.get("kind"))),
    );
    out.insert("a".into(), or_null(body.get("a")));
    out.insert("b".into(), or_null(body.get("b")));
    Value::Object(out)
}

/// `{ config: CONFIG, targets: loadTargets() }`.
pub fn annotation_get_body(host: &Value) -> Value {
    let mut out = Map::new();
    out.insert("config".into(), member(host, "config"));
    out.insert(
        "targets".into(),
        match host.get("targets") {
            Some(value) => value.clone(),
            None => Value::Array(Vec::new()),
        },
    );
    Value::Object(out)
}

/// `{ ok: true, relayed, results }` around the host relay answer.
pub fn annotation_relay_body(host: &Value) -> Value {
    let mut out = Map::new();
    out.insert("ok".into(), Value::Bool(true));
    out.insert("relayed".into(), member(host, "relayed"));
    out.insert(
        "results".into(),
        match host.get("results") {
            Some(value) => value.clone(),
            None => Value::Array(Vec::new()),
        },
    );
    Value::Object(out)
}

/// `{ global: { count, id, createdAt } }` is assembled by the host; the route
/// only reads these three facts through [`Identity`] and the count.
pub fn identity_of(host: &Value) -> Identity {
    Identity {
        id: value_or_empty(host.get("id")),
        created_at: value_or_empty(host.get("createdAt")),
    }
}

// ── small JS coercions ─────────────────────────────────────────────────────

fn member(source: &Value, key: &str) -> Value {
    source.get(key).cloned().unwrap_or(Value::Null)
}

/// `value || fallbackString` for a JSON value (truthiness keeps arrays/objects).
fn or_identity(value: Option<&Value>, fallback: &str) -> Value {
    match value {
        Some(inner) if truthy(inner) => inner.clone(),
        _ => Value::String(fallback.to_string()),
    }
}

/// `value || null`.
fn or_null(value: Option<&Value>) -> Value {
    match value {
        Some(inner) if truthy(inner) => inner.clone(),
        _ => Value::Null,
    }
}

/// `Number(value) || 0`; JS then serializes a surviving Infinity as `null`.
fn number_or_zero(value: Option<&Value>) -> Value {
    let number = value.map(js_to_number).unwrap_or(0.0);
    if number.is_nan() || number == 0.0 {
        Value::from(0i64)
    } else if number.is_infinite() {
        Value::Null
    } else {
        number_value(number)
    }
}

/// `a === b` restricted to the strings the catalog holds.
fn strict_equal(left: &Value, right: &Value) -> bool {
    matches!((left, right), (Value::String(a), Value::String(b)) if a == b)
}

/// `parseInt(text, 10)`: leading JS whitespace, an optional sign, then the
/// longest run of ASCII digits; anything else is NaN.
fn parse_int10(text: &str) -> f64 {
    let trimmed = text.trim_start_matches(crate::js::string::is_js_whitespace_char);
    let (sign, rest) = match trimmed.as_bytes().first() {
        Some(b'-') => (-1.0, &trimmed[1..]),
        Some(b'+') => (1.0, &trimmed[1..]),
        _ => (1.0, trimmed),
    };
    let end = rest
        .bytes()
        .position(|byte| !byte.is_ascii_digit())
        .unwrap_or(rest.len());
    if end == 0 {
        return f64::NAN;
    }
    sign * rest[..end].parse::<f64>().unwrap_or(f64::NAN)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity() -> Identity {
        Identity {
            id: "uuid-1".into(),
            created_at: "2026-11-15T00:00:00.000Z".into(),
        }
    }

    #[test]
    fn catalog_body_keeps_the_retired_key_order_and_drops_aliases() {
        let body = catalog_body().to_string();
        assert!(body.starts_with(r#"{"events":["#), "{body}");
        assert!(body.contains(r#""aliases":{"task.attention":["#), "{body}");
        assert!(
            body.contains(r#""actions":["inject-prompt","webhook","notify","channel"]"#),
            "{body}"
        );
        let clis = client_clis();
        assert_eq!(clis.first().map(String::as_str), Some("claude"));
        assert!(
            !clis.iter().any(|cli| cli == "claude-exp"),
            "aliases are filtered"
        );
        assert_eq!(clis.len(), 14);
    }

    #[test]
    fn recent_limit_parses_and_clamps_like_the_hub() {
        assert_eq!(recent_limit(None), 50);
        assert_eq!(recent_limit(Some(&json!("10"))), 10);
        assert_eq!(recent_limit(Some(&json!("abc"))), 50);
        assert_eq!(recent_limit(Some(&json!(""))), 50);
        assert_eq!(recent_limit(Some(&json!("0"))), 1);
        assert_eq!(recent_limit(Some(&json!("-5"))), 1);
        assert_eq!(recent_limit(Some(&json!("999"))), 200);
        assert_eq!(recent_limit(Some(&json!("10.9"))), 10);
        assert_eq!(recent_limit(Some(&json!(["10", "20"]))), 10);
        assert_eq!(recent_limit(Some(&json!("1e999"))), 1);
        let huge = "9".repeat(400);
        assert_eq!(
            recent_limit(Some(&json!(huge))),
            200,
            "Infinity clamps to 200"
        );
    }

    #[test]
    fn wrappers_keep_the_declared_order() {
        assert_eq!(
            recent_body(&json!({"events":[1],"runs":[],"chains":[]})).to_string(),
            r#"{"events":[1],"runs":[],"chains":[]}"#
        );
        assert_eq!(
            recent_body(&Value::Null).to_string(),
            r#"{"events":null,"runs":null,"chains":null}"#
        );
        assert_eq!(
            single_key("items", json!([{"a":1}])).to_string(),
            r#"{"items":[{"a":1}]}"#
        );
        assert_eq!(
            error_body("not found").to_string(),
            r#"{"error":"not found"}"#
        );
    }

    #[test]
    fn non_event_triggers_match_the_retired_schema_and_key_order() {
        let plan = validate_trigger(&json!({"type": "post-turn", "prompt": "hi"}), &identity());
        let TriggerPlan::Ready(trigger) = plan else {
            panic!("expected a trigger, got {plan:?}");
        };
        assert_eq!(
            trigger.to_string(),
            r#"{"id":"uuid-1","type":"post-turn","enabled":true,"prompt":"hi","cooldownMs":30000,"mode":"inject","createdAt":"2026-11-15T00:00:00.000Z"}"#
        );

        let file_change = validate_trigger(
            &json!({"type": "file-change", "paths": "src/**", "debounceMs": 20, "cooldownMs": 9e7}),
            &identity(),
        );
        let TriggerPlan::Ready(trigger) = file_change else {
            panic!("expected a trigger");
        };
        assert_eq!(
            trigger.to_string(),
            r#"{"id":"uuid-1","type":"file-change","enabled":true,"prompt":"","cooldownMs":86400000,"mode":"inject","createdAt":"2026-11-15T00:00:00.000Z","paths":["src/**"],"debounceMs":500}"#
        );
    }

    #[test]
    fn trigger_refusals_and_coercions_follow_the_js_checks() {
        assert_eq!(
            validate_trigger(&json!({"type": "unknown"}), &identity()),
            TriggerPlan::Invalid("invalid type".into())
        );
        assert_eq!(
            validate_trigger(&json!({"type": "file-change"}), &identity()),
            TriggerPlan::Invalid("file-change requires paths[]".into())
        );
        assert_eq!(
            validate_trigger(&json!({"type": "file-change", "paths": []}), &identity()),
            TriggerPlan::Invalid("file-change requires paths[]".into())
        );
        assert_eq!(
            validate_trigger(&json!({"type": "schedule", "cron": ""}), &identity()),
            TriggerPlan::Invalid("invalid cron expression".into())
        );
        match validate_trigger(
            &json!({"type": "schedule", "cron": "0 9 * * *"}),
            &identity(),
        ) {
            TriggerPlan::NeedsCron(trigger, expr) => {
                assert_eq!(expr, "0 9 * * *");
                assert_eq!(trigger.get("cron"), Some(&json!("0 9 * * *")));
                assert_eq!(trigger.get("cooldownMs"), Some(&json!(0)));
            }
            other => panic!("unexpected {other:?}"),
        }
        let plan = validate_trigger(
            &json!({"type": "post-turn", "id": "", "enabled": false, "prompt": null, "cooldownMs": "x"}),
            &identity(),
        );
        let TriggerPlan::Ready(trigger) = plan else {
            panic!("expected a trigger");
        };
        assert_eq!(trigger.get("id"), Some(&json!("uuid-1")));
        assert_eq!(trigger.get("enabled"), Some(&json!(false)));
        assert_eq!(trigger.get("prompt"), Some(&json!("")));
        assert_eq!(trigger.get("cooldownMs"), Some(&json!(30000)));
    }

    #[test]
    fn event_triggers_go_through_the_shared_rule_schema() {
        let plan = validate_trigger(
            &json!({"type": "event", "on": ["turn.completed"], "action": {"kind": "inject-prompt"}}),
            &identity(),
        );
        let TriggerPlan::Ready(rule) = plan else {
            panic!("expected a rule");
        };
        assert_eq!(rule.get("id"), Some(&json!("uuid-1")));
        assert_eq!(rule.get("scope"), Some(&json!("session")));
        assert_eq!(
            rule.get("createdAt"),
            Some(&json!("2026-11-15T00:00:00.000Z"))
        );
        assert_eq!(rule.get("type"), Some(&json!("event")));

        let invalid = validate_trigger(&json!({"type": "event", "on": []}), &identity());
        assert!(matches!(invalid, TriggerPlan::Invalid(_)), "{invalid:?}");
    }

    #[test]
    fn forced_trigger_overwrites_in_place_like_a_spread() {
        let trigger = json!({"id":"t","enabled":false,"prompt":"p","cooldownMs":9});
        assert_eq!(
            forced_trigger(&trigger).to_string(),
            r#"{"id":"t","enabled":true,"prompt":"p","cooldownMs":0}"#
        );
    }

    #[test]
    fn manual_emit_input_truncates_the_goal_and_keeps_goal_state() {
        let input = event_emit_input(
            &json!({"type":"turn.completed","sessionId":" s1 ","goal":"g","goalState":"achieved"}),
        );
        assert_eq!(
            input.to_string(),
            r#"{"type":"turn.completed","sessionId":" s1 ","goal":"g","goalState":"achieved"}"#
        );
        let defaults = event_emit_input(
            &json!({"type":"turn.completed","sessionId":0,"goal":"","goalState":0}),
        );
        assert_eq!(
            defaults.to_string(),
            r#"{"type":"turn.completed","sessionId":null,"goal":"test event","goalState":null}"#
        );
        let long = "x".repeat(200);
        let sliced = event_emit_input(&json!({"type":"turn.completed","goal":long}));
        assert_eq!(
            sliced.get("goal").and_then(Value::as_str).map(str::len),
            Some(80)
        );
    }

    #[test]
    fn event_test_body_keeps_ok_then_event_id() {
        assert_eq!(
            event_test_body(Some(&json!("ev-1"))).to_string(),
            r#"{"ok":true,"eventId":"ev-1"}"#
        );
        assert_eq!(
            event_test_body(None).to_string(),
            r#"{"ok":true,"eventId":null}"#
        );
    }

    #[test]
    fn event_type_requires_an_exact_catalog_member() {
        assert_eq!(
            event_type(&json!({"type":"turn.completed"})),
            Some("turn.completed".into())
        );
        assert_eq!(event_type(&json!({"type":"nope"})), None);
        assert_eq!(event_type(&json!({"type":3})), None);
        assert_eq!(event_type(&json!({})), None);
    }

    #[test]
    fn annotation_payload_coerces_like_the_retired_handler() {
        let payload = annotation_payload(&json!({
            "sessionId": "s", "src": "a.png", "width": "1470", "height": 956,
            "kind": "point", "a": {"x":1}, "b": 0,
        }));
        assert_eq!(
            payload.to_string(),
            r#"{"sessionId":"s","src":"a.png","width":1470,"height":956,"kind":"point","a":{"x":1},"b":null}"#
        );
        let defaults = annotation_payload(&json!({"width": "abc", "height": ""}));
        assert_eq!(
            defaults.to_string(),
            r#"{"sessionId":"","src":"","width":0,"height":0,"kind":"","a":null,"b":null}"#
        );
        // `Number("1e999")` is Infinity, which JSON serializes as null.
        let infinite = annotation_payload(&json!({"width": "1e999"}));
        assert_eq!(infinite.get("width"), Some(&Value::Null));
    }

    #[test]
    fn annotation_envelopes_keep_the_route_shape() {
        assert_eq!(
            annotation_get_body(&json!({"config":"/tmp/x.json","targets":[{"url":"http://a"}]}))
                .to_string(),
            r#"{"config":"/tmp/x.json","targets":[{"url":"http://a"}]}"#
        );
        assert_eq!(
            annotation_relay_body(&json!({"relayed":1,"results":[{"ok":true}]})).to_string(),
            r#"{"ok":true,"relayed":1,"results":[{"ok":true}]}"#
        );
        assert_eq!(
            annotation_relay_body(&json!({})).to_string(),
            r#"{"ok":true,"relayed":null,"results":[]}"#
        );
    }

    #[test]
    fn rule_validation_fills_identity_and_reports_refusals() {
        let rule = validate_event_rule(
            &json!({"on": ["turn.completed"], "action": {"kind": "inject-prompt"}}),
            "global",
            Some(&json!("uuid-9")),
            Some(&json!("2026-11-15T00:00:00.000Z")),
        )
        .expect("valid rule");
        assert_eq!(rule.get("id"), Some(&json!("uuid-9")));
        assert_eq!(
            rule.get("createdAt"),
            Some(&json!("2026-11-15T00:00:00.000Z"))
        );
        assert_eq!(rule.get("scope"), Some(&json!("global")));

        assert_eq!(
            validate_event_rule(&json!({"on": []}), "global", None, None),
            Err(RuleError::Invalid("on requires 1-10 event patterns".into()))
        );

        // A PUT whose old rule had no createdAt drops the key (JS assigned undefined).
        let without = validate_event_rule(
            &json!({"on": ["turn.completed"], "action": {"kind":"inject-prompt"}, "createdAt": null}),
            "global",
            Some(&json!("r1")),
            None,
        )
        .expect("valid rule");
        assert!(without.get("createdAt").is_none(), "{without}");
    }

    #[test]
    fn merge_and_stamp_preservation_match_the_put_handler() {
        let merged = merge_rule(
            &json!({"id":"r1","name":"old","createdAt":"then","lastFiredAt":null,"firedAt":7}),
            &json!({"name":"new","enabled":false}),
            "r1",
        );
        assert_eq!(
            merged.to_string(),
            r#"{"id":"r1","name":"new","createdAt":"then","lastFiredAt":null,"firedAt":7,"enabled":false}"#
        );
        let carried = carry_stamps(
            json!({"id":"r1","createdAt":"then"}),
            &json!({"id":"r1","lastFiredAt":null,"firedAt":0}),
        );
        assert_eq!(
            carried.to_string(),
            r#"{"id":"r1","createdAt":"then","lastFiredAt":null}"#
        );
        let carried = carry_stamps(
            json!({"id":"r1"}),
            &json!({"id":"r1","firedAt":"2026-01-01T00:00:00.000Z"}),
        );
        assert_eq!(
            carried.to_string(),
            r#"{"id":"r1","firedAt":"2026-01-01T00:00:00.000Z"}"#
        );
    }

    #[test]
    fn channel_actions_gate_the_host_round_trip() {
        assert!(!has_channel_actions(
            &json!({"action":{"kind":"inject-prompt"}})
        ));
        assert!(has_channel_actions(
            &json!({"action":{"kind":"channel","plugin":"p","target":"t"}})
        ));
        assert!(has_channel_actions(
            &json!({"action":{"kind":"inject-prompt"},"then":[{"kind":"channel","plugin":"p","target":"t"}]})
        ));
    }

    #[test]
    fn identity_is_read_from_the_host_answer() {
        let identity = identity_of(&json!({"id":"u","createdAt":"now"}));
        assert_eq!(identity.id, "u");
        assert_eq!(identity.created_at, "now");
        let missing = identity_of(&json!({}));
        assert_eq!(missing.id, "");
        assert_eq!(missing.created_at, "");
    }

    #[test]
    fn global_rule_cap_is_the_engine_constant() {
        assert!(!too_many_global(99));
        assert!(too_many_global(100));
    }
}
