//! Rules kernel for the quota & pricing route cluster (`src/routes/pricing.js`,
//! the seven `*-quota.js` route modules and `src/routes/quota-bars.js`).
//!
//! Everything that is a *rule* over the Node runtime's answers lives here:
//! request-parameter sanitization (`text(value, max)`), the pricing model-list
//! parse and its three 400 refusals, the `?limit=` parse-and-cap, the
//! `force` flag spellings, the per-provider status→HTTP decision trees, the
//! `{ ...result, bar }` envelopes and their key order, and the quota-bar
//! request input. Bars are rendered through [`crate::quota_bar_view::render`] —
//! the same kernel the Node addon exposes as `renderQuotaBar` — so the front
//! door produces the identical nested DTO without a second renderer.
//!
//! Everything that needs the process-local world stays in Node behind the host
//! port (`src/routes/quota-host.js`): the models.dev price table and its
//! refresh, the logged-in Chrome profiles / CDP drives, `~/.codex/auth.json`
//! and the OAuth refresh hook, the arkcli subprocess, the in-process quota-bar
//! cache, the Claude usage queue and its live 5h map, and the
//! `recordVendor`/`recordClaude` limit-cache writers.
//!
//! Byte-for-byte parity is the contract: envelopes are serialized with the
//! V8-compatible `js_json_stringify`, and every `text()` call follows the
//! retired JS (control characters → space, then trim, then a UTF-16 slice).

use serde_json::{Map, Value};

use crate::http_gate::{query_string, QueryValue};
use crate::js::serde::{from_serde, js_string, to_serde, truthy, value_or_empty};
use crate::js::string::{is_js_whitespace_char, js_trim, utf16_len, utf16_prefix};
use crate::js::JsValue;
use crate::quota_bar_view;

/// `MAX_LOOKUP_MODELS` in `src/routes/pricing.js`.
pub const MAX_LOOKUP_MODELS: i64 = 50;
/// `MAX_MODEL_LENGTH` in `src/routes/pricing.js`.
pub const MAX_MODEL_LENGTH: usize = 100;
/// `MAX_SEARCH_LIMIT` in `src/routes/pricing.js`.
pub const MAX_SEARCH_LIMIT: i64 = 50;
/// `DEFAULT_SEARCH_LIMIT` in `src/routes/pricing.js`.
pub const DEFAULT_SEARCH_LIMIT: i64 = 20;

/// `REFRESH_KINDS` in `src/routes/quota-bars.js`.
pub const BAR_KINDS: [&str; 6] = ["opencode", "qoder", "codex", "claude", "ark", "kimi"];

/// `text(value, max = 400)` from `src/routes/quota-bars.js`: control
/// characters become spaces, then trim, then `slice(0, max)` over UTF-16 code
/// units. `null`/`undefined` read as `''`.
pub fn text(value: Option<&Value>, max: usize) -> String {
    let raw = match value {
        None | Some(Value::Null) => String::new(),
        Some(other) => js_string(other),
    };
    let cleaned: String = raw
        .chars()
        .map(|character| {
            let code = character as u32;
            if code <= 0x1f || code == 0x7f {
                ' '
            } else {
                character
            }
        })
        .collect();
    let trimmed = js_trim(&cleaned);
    utf16_prefix(trimmed, max)
}

/// `String(value || '')` for one already-decoded query field.
pub fn query_text(value: &QueryValue) -> String {
    query_string(value)
}

/// `typeof value === 'string' ? value : ''` (no trim, no coercion).
pub fn string_only(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        _ => String::new(),
    }
}

/// `String(value || '').trim()` (`query_trimmed` in the retired handlers).
pub fn trimmed_text(value: Option<&Value>) -> String {
    js_trim(&value_or_empty(value)).to_string()
}

/// `req.query` value → the JSON value JS would expose (`undefined` when the
/// parameter is absent). Arrays/objects stay arrays/objects so the callers'
/// `typeof === 'string'` guards see the same thing they did in Express.
pub fn query_json(value: &QueryValue) -> Option<Value> {
    match value {
        QueryValue::Missing => None,
        QueryValue::Text(text) => Some(Value::String(text.clone())),
        QueryValue::List(items) => Some(Value::Array(
            items
                .iter()
                .map(|item| query_json(item).unwrap_or(Value::Null))
                .collect(),
        )),
        QueryValue::Object => Some(Value::Object(Map::new())),
    }
}

/// JS `a || b`.
fn pick<'a>(first: Option<&'a Value>, second: Option<&'a Value>) -> Option<&'a Value> {
    match first {
        Some(value) if truthy(value) => Some(value),
        _ => second,
    }
}

/// `parseModelList(raw)` from `src/routes/pricing.js`: comma-split, trim,
/// drop empties, dedupe keeping the first occurrence. A non-string (a qs array)
/// reads as no models at all.
pub fn parse_model_list(raw: Option<&Value>) -> Vec<String> {
    let Some(Value::String(text)) = raw else {
        return Vec::new();
    };
    let mut seen: Vec<String> = Vec::new();
    for part in text.split(',') {
        let model = js_trim(part);
        if model.is_empty() || seen.iter().any(|existing| existing == model) {
            continue;
        }
        seen.push(model.to_string());
    }
    seen
}

/// The lookup refusals, in the retired handler's order: empty, too many, then
/// the first over-long id. The returned pair is `(error code, max)`.
pub fn lookup_error(models: &[String]) -> Option<(&'static str, i64)> {
    if models.is_empty() {
        return Some(("models_required", MAX_LOOKUP_MODELS));
    }
    if models.len() as i64 > MAX_LOOKUP_MODELS {
        return Some(("too_many_models", MAX_LOOKUP_MODELS));
    }
    if models
        .iter()
        .any(|model| utf16_len(model) > MAX_MODEL_LENGTH)
    {
        return Some(("model_too_long", MAX_MODEL_LENGTH as i64));
    }
    None
}

/// `parseInt(text, 10)`: leading JS whitespace, an optional sign, then the
/// longest run of ASCII digits; anything else is NaN. A very long digit run is
/// Infinity in JS, which `parse::<f64>` reproduces.
fn parse_int10(text: &str) -> f64 {
    let trimmed = text.trim_start_matches(is_js_whitespace_char);
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

/// `Number.parseInt(String(x || ''), 10)` then the search cap:
/// `Number.isFinite(n) && n > 0 ? Math.min(n, 50) : 20`.
pub fn search_limit(raw: Option<&Value>) -> i64 {
    let requested = parse_int10(&value_or_empty(raw));
    if requested.is_finite() && requested > 0.0 {
        requested.min(MAX_SEARCH_LIMIT as f64) as i64
    } else {
        DEFAULT_SEARCH_LIMIT
    }
}

/// `POST /api/pricing/refresh`'s `force`:
/// `String(query.force || body.force || '') === '1' || body.force === true`.
pub fn refresh_force(query_force: Option<&Value>, body: &Value) -> bool {
    let body_force = body.get("force");
    let raw = value_or_empty(pick(query_force, body_force));
    raw == "1" || body_force == Some(&Value::Bool(true))
}

/// The sanitized `requestInput(req)` of `src/routes/quota-bars.js`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BarInput {
    pub kind: String,
    pub session: String,
    pub base_url: String,
    pub host: String,
    pub force: bool,
}

/// The query half of `requestInput`; the body half is [`BarInput::from`].
#[derive(Debug, Clone, Copy, Default)]
pub struct BarQuery<'a> {
    pub kind: Option<&'a Value>,
    pub session: Option<&'a Value>,
    pub base_url: Option<&'a Value>,
    pub host: Option<&'a Value>,
    pub force: Option<&'a Value>,
}

fn lower(value: String) -> String {
    crate::js::string::JsString::from_rust_str(&value)
        .to_lowercase()
        .to_string_lossy()
}

impl BarInput {
    /// `requestInput(req)`: the body wins over the query for every field, and
    /// `force` accepts only the two documented spellings.
    pub fn read(body: &Value, query: BarQuery<'_>) -> BarInput {
        let force_raw = value_or_empty(pick(body.get("force"), query.force));
        BarInput {
            kind: lower(text(pick(body.get("kind"), query.kind), 40)),
            session: text(pick(body.get("session"), query.session), 180),
            base_url: text(pick(body.get("baseUrl"), query.base_url), 2048),
            host: lower(text(pick(body.get("host"), query.host), 160)),
            force: force_raw == "1" || force_raw == "true",
        }
    }

    /// `snapshotFor(input)` takes the whole `requestInput(req)` object, not
    /// the cache selector: same members and order, `kind` first.
    pub fn state_input(&self) -> Value {
        let mut input = Map::new();
        input.insert("kind".into(), Value::String(self.kind.clone()));
        input.insert("session".into(), Value::String(self.session.clone()));
        input.insert("baseUrl".into(), Value::String(self.base_url.clone()));
        input.insert("host".into(), Value::String(self.host.clone()));
        input.insert("force".into(), Value::Bool(self.force));
        Value::Object(input)
    }

    /// The selector object `cache.get`/`cache.record` take.
    pub fn selector(&self) -> Value {
        let mut selector = Map::new();
        selector.insert("session".into(), Value::String(self.session.clone()));
        selector.insert("baseUrl".into(), Value::String(self.base_url.clone()));
        selector.insert("host".into(), Value::String(self.host.clone()));
        Value::Object(selector)
    }
}

/// `(result && result.status) || fallback` — the raw value, because the body
/// spreads it unchanged (`{status: true}` stays a boolean).
pub fn status_value(result: Option<&Value>, fallback: &str) -> Value {
    match result.and_then(|value| value.get("status")) {
        Some(value) if truthy(value) => value.clone(),
        _ => Value::String(fallback.to_string()),
    }
}

fn status_text(status: &Value) -> Option<&str> {
    match status {
        Value::String(text) => Some(text.as_str()),
        _ => None,
    }
}

/// `GET /api/opencode/quota` status mapping.
pub fn opencode_http(status: &Value) -> u16 {
    match status_text(status) {
        Some("ok") => 200,
        Some("needs_login" | "no_auth") => 401,
        Some("chrome_unavailable") => 503,
        _ => 500,
    }
}

/// `GET /api/qoder/quota` status mapping.
pub fn qoder_http(status: &Value) -> u16 {
    match status_text(status) {
        Some("ok") => 200,
        Some("needs_login") => 401,
        Some("chrome_unavailable") => 503,
        _ => 500,
    }
}

/// `GET /api/codex/quota` status mapping.
pub fn codex_http(status: &Value) -> u16 {
    match status_text(status) {
        Some("ok") => 200,
        Some("no_auth") => 401,
        _ => 500,
    }
}

/// `GET /api/ark/quota` status mapping.
pub fn ark_http(status: &Value) -> u16 {
    match status_text(status) {
        Some("ok") => 200,
        Some("needs_auth") => 401,
        Some("needs_install") => 404,
        _ => 500,
    }
}

/// `GET /api/kimi/quota` status mapping.
pub fn kimi_http(status: &Value) -> u16 {
    match status_text(status) {
        Some("ok") => 200,
        Some("not_configured") => 404,
        Some("needs_login") => 401,
        Some("chrome_unavailable") => 503,
        _ => 502,
    }
}

/// `GET /api/claude/quota` status mapping (`quotaHttpStatus`).
pub fn claude_http(status: &Value) -> u16 {
    match status_text(status) {
        Some("ok" | "idle") => 200,
        Some("needs_login") => 401,
        Some("chrome_unavailable") => 503,
        _ => 500,
    }
}

/// `GET /api/aliyun/quota` status mapping.
pub fn aliyun_http(status: &Value) -> u16 {
    match status_text(status) {
        Some("ok") => 200,
        Some("needs_login") => 401,
        Some("chrome_unavailable") => 503,
        _ => 502,
    }
}

/// `statusCodeFor(status)` from `src/routes/quota-bars.js`.
pub fn bar_refresh_http(status: &Value) -> u16 {
    match status_text(status) {
        Some("ok" | "idle") => 200,
        Some("needs_login" | "no_auth" | "needs_auth") => 401,
        Some("chrome_unavailable" | "needs_install") => 503,
        _ => 500,
    }
}

/// `REFRESH_KINDS.has(kind)`.
pub fn bar_kind_valid(kind: &str) -> bool {
    BAR_KINDS.contains(&kind)
}

/// `renderQuotaBar(kind, value, opts)` — the same kernel the addon exposes.
pub fn render_bar(kind: &str, value: Option<&Value>, opts: &Value) -> Value {
    let value = value.map(from_serde).unwrap_or(JsValue::Null);
    to_serde(&quota_bar_view::render(kind, &value, &from_serde(opts)))
}

/// `renderClaudeBar(session)`: `claudeBar(usage, live, nowMs)`. `usage` is
/// `undefined` (not `null`) when the account has no reading, exactly like
/// `entry && entry.result` in the retired route.
pub fn claude_bar(usage: Option<&Value>, live: Option<&Value>, now_ms: f64) -> Value {
    let input = JsValue::object(vec![
        ("usage", usage.map(from_serde).unwrap_or(JsValue::Undefined)),
        ("live", live.map(from_serde).unwrap_or(JsValue::Null)),
        ("nowMs", JsValue::Number(now_ms)),
    ]);
    to_serde(&quota_bar_view::request("claudeBar", &input))
}

/// `{ status: 'ok', bars: idleQuotaBars() }`.
pub fn idle_bars() -> Value {
    let mut body = Map::new();
    body.insert("status".into(), Value::String("ok".into()));
    body.insert(
        "bars".into(),
        to_serde(&quota_bar_view::request(
            "idleQuotaBars",
            &JsValue::Undefined,
        )),
    );
    Value::Object(body)
}

/// Copy a host-provided object's own members in order (the `{ ...result }`
/// spread). A non-object result spreads to nothing.
fn spread(result: Option<&Value>, out: &mut Map<String, Value>) {
    if let Some(Value::Object(object)) = result {
        for (key, value) in object {
            out.insert(key.clone(), value.clone());
        }
    }
}

/// `{ ...result, bar }`.
pub fn spread_with_bar(result: Option<&Value>, bar: Value) -> Value {
    let mut out = Map::new();
    spread(result, &mut out);
    out.insert("bar".into(), bar);
    Value::Object(out)
}

/// `{ ...(result || {}), status, bar }` (the Claude route).
pub fn claude_body(result: Option<&Value>, status: Value, bar: Value) -> Value {
    let mut out = Map::new();
    spread(result, &mut out);
    out.insert("status".into(), status);
    out.insert("bar".into(), bar);
    Value::Object(out)
}

/// `POST /api/quota/bars/refresh` body, key order fixed:
/// `status, fetchedAt, error?, reason?, bar, cached`.
pub fn bar_refresh_body(result: Option<&Value>, bar: Value, cached: Value) -> Value {
    let mut out = Map::new();
    out.insert("status".into(), status_value(result, "unavailable"));
    let fetched_at = result
        .and_then(|value| value.get("fetchedAt"))
        .filter(|value| truthy(value))
        .cloned()
        .unwrap_or(Value::Null);
    out.insert("fetchedAt".into(), fetched_at);
    if let Some(error) = result
        .and_then(|value| value.get("error"))
        .filter(|v| truthy(v))
    {
        out.insert("error".into(), Value::String(text(Some(error), 200)));
    }
    if let Some(reason) = result
        .and_then(|value| value.get("reason"))
        .filter(|v| truthy(v))
    {
        out.insert("reason".into(), Value::String(text(Some(reason), 200)));
    }
    out.insert("bar".into(), bar);
    out.insert("cached".into(), cached);
    Value::Object(out)
}

/// `POST /api/<kind>/quota/login`'s success body.
pub fn login_message(kind: &str) -> &'static str {
    match kind {
        "opencode" => {
            "已打开登录窗口：请在弹出的 Chrome 中登录 opencode.ai，完成后回来重新查询余量"
        }
        "qoder" => "已打开登录窗口：请在弹出的 Chrome 中登录 qoder.com.cn，完成后回来重新查询余量",
        "kimi" => "已打开登录窗口：请在弹出的 Chrome 中登录 kimi.com，完成后回来重新查询余量",
        "claude" => "已打开登录窗口：请在弹出的 Chrome 中登录 claude.ai，完成后回来重新查询余量",
        _ => "已打开登录窗口：请在弹出的 Chrome 中登录阿里云，完成后回来重新查询余量",
    }
}

/// `res.json({ ok: true, message })`.
pub fn login_ok(kind: &str) -> Value {
    let mut body = Map::new();
    body.insert("ok".into(), Value::Bool(true));
    body.insert(
        "message".into(),
        Value::String(login_message(kind).to_string()),
    );
    Value::Object(body)
}

/// `{ ok: false, error: err.code || 'login_window_failed', message: err.message }`
/// — `message` is dropped when the error carried none, exactly like
/// `JSON.stringify` dropping an `undefined` member.
pub fn login_failure(error: Option<Value>, message: Option<&str>) -> Value {
    let mut body = Map::new();
    body.insert("ok".into(), Value::Bool(false));
    let error = match error {
        Some(value) if truthy(&value) => value,
        _ => Value::String("login_window_failed".into()),
    };
    body.insert("error".into(), error);
    if let Some(message) = message {
        body.insert("message".into(), Value::String(message.to_string()));
    }
    Value::Object(body)
}

/// The fixed bodies the retired handlers returned for the ark/claude/codex
/// special cases.
pub fn fixed(status: &str, error: &str) -> Value {
    let mut body = Map::new();
    body.insert("status".into(), Value::String(status.to_string()));
    body.insert("error".into(), Value::String(error.to_string()));
    Value::Object(body)
}

/// `{ status }` — a body whose only member is the status.
pub fn status_only(status: &str) -> Value {
    let mut body = Map::new();
    body.insert("status".into(), Value::String(status.to_string()));
    Value::Object(body)
}

/// `{ ok: false, error }` (`{ ok:false, error:'no saved cookies' }`).
pub fn ok_error(error: &str) -> Value {
    let mut body = Map::new();
    body.insert("ok".into(), Value::Bool(false));
    body.insert("error".into(), Value::String(error.to_string()));
    Value::Object(body)
}

/// The Claude route's catch arm: `{ status:'unavailable', error, bar }`.
pub fn claude_failure(bar: Value) -> Value {
    let mut body = Map::new();
    body.insert("status".into(), Value::String("unavailable".into()));
    body.insert(
        "error".into(),
        Value::String("claude quota fetch failed".into()),
    );
    body.insert("bar".into(), bar);
    Value::Object(body)
}

/// `{ status: 'started', pid }`.
pub fn ark_login_started(pid: Option<Value>) -> Value {
    let mut body = Map::new();
    body.insert("status".into(), Value::String("started".into()));
    body.insert("pid".into(), pid.unwrap_or(Value::Null));
    Value::Object(body)
}

/// `{ status, error: value || fallback }` — `err.message || 'spawn failed'`.
pub fn status_error(status: &str, error: Option<Value>, fallback: &str) -> Value {
    let mut body = Map::new();
    body.insert("status".into(), Value::String(status.to_string()));
    let error = match error {
        Some(value) if truthy(&value) => value,
        _ => Value::String(fallback.to_string()),
    };
    body.insert("error".into(), error);
    Value::Object(body)
}

/// `{ status, error? }` — the `error` member is dropped when the value is
/// missing, exactly like `JSON.stringify` dropping an `undefined`.
pub fn status_error_opt(status: &str, error: Option<Value>) -> Value {
    let mut body = Map::new();
    body.insert("status".into(), Value::String(status.to_string()));
    if let Some(value) = error {
        body.insert("error".into(), value);
    }
    Value::Object(body)
}

/// `{ ok: true, status: priceTable.status() }`.
pub fn pricing_status(status: Value) -> Value {
    let mut body = Map::new();
    body.insert("ok".into(), Value::Bool(true));
    body.insert("status".into(), status);
    Value::Object(body)
}

/// `{ ok: true, prices, status }`.
pub fn pricing_lookup(prices: Value, status: Value) -> Value {
    let mut body = Map::new();
    body.insert("ok".into(), Value::Bool(true));
    body.insert("prices".into(), prices);
    body.insert("status".into(), status);
    Value::Object(body)
}

/// `{ ok: true, query, count, results, status }`.
pub fn pricing_search(query: &str, results: Value, status: Value) -> Value {
    let count = match &results {
        Value::Array(items) => items.len(),
        _ => 0,
    };
    let mut body = Map::new();
    body.insert("ok".into(), Value::Bool(true));
    body.insert("query".into(), Value::String(query.to_string()));
    body.insert("count".into(), Value::from(count));
    body.insert("results".into(), results);
    body.insert("status".into(), status);
    Value::Object(body)
}

/// `{ ok: false, error, max }` — the pricing refusals.
pub fn pricing_error(code: &str, max: i64) -> Value {
    let mut body = Map::new();
    body.insert("ok".into(), Value::Bool(false));
    body.insert("error".into(), Value::String(code.to_string()));
    body.insert("max".into(), Value::from(max));
    Value::Object(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn text_replaces_controls_trims_and_slices_in_utf16() {
        assert_eq!(text(None, 400), "");
        assert_eq!(text(Some(&Value::Null), 400), "");
        assert_eq!(text(Some(&json!("  hi\tthere\u{1} \n")), 400), "hi there");
        assert_eq!(text(Some(&json!(12)), 400), "12");
        assert_eq!(text(Some(&json!(true)), 400), "true");
        // Array joins with commas like String([...]).
        assert_eq!(text(Some(&json!(["a", "b"])), 400), "a,b");
        // The slice counts UTF-16 code units, not chars.
        assert_eq!(text(Some(&json!("额度")), 1), "额");
        assert_eq!(text(Some(&json!("abc")), 2), "ab");
    }

    #[test]
    fn query_json_maps_missing_text_list_and_object() {
        assert_eq!(query_json(&QueryValue::Missing), None);
        assert_eq!(query_json(&QueryValue::Text("x".into())), Some(json!("x")));
        assert_eq!(
            query_json(&QueryValue::List(vec![
                QueryValue::Text("a".into()),
                QueryValue::Text("b".into()),
            ])),
            Some(json!(["a", "b"]))
        );
        assert_eq!(query_json(&QueryValue::Object), Some(json!({})));
    }

    #[test]
    fn model_list_splits_trims_dedupes_and_ignores_non_strings() {
        assert_eq!(parse_model_list(None), Vec::<String>::new());
        assert_eq!(parse_model_list(Some(&json!(["a"]))), Vec::<String>::new());
        assert_eq!(
            parse_model_list(Some(&json!(" a,,b , a ,c, "))),
            vec!["a".to_string(), "b".to_string(), "c".to_string()]
        );
        assert_eq!(parse_model_list(Some(&json!(""))), Vec::<String>::new());
    }

    #[test]
    fn lookup_refusals_follow_the_retired_order() {
        assert_eq!(lookup_error(&[]), Some(("models_required", 50)));
        let too_many: Vec<String> = (0..51).map(|index| format!("m{index}")).collect();
        assert_eq!(lookup_error(&too_many), Some(("too_many_models", 50)));
        let long = "x".repeat(101);
        assert_eq!(lookup_error(&[long]), Some(("model_too_long", 100_i64)));
        assert_eq!(lookup_error(&["ok".to_string()]), None);
        // A 100-unit id is allowed; 101 is refused.
        assert_eq!(lookup_error(&["x".repeat(100)]), None);
    }

    #[test]
    fn search_limit_caps_and_defaults_like_parse_int() {
        assert_eq!(search_limit(None), 20);
        assert_eq!(search_limit(Some(&json!(""))), 20);
        assert_eq!(search_limit(Some(&json!("7"))), 7);
        assert_eq!(search_limit(Some(&json!("100"))), 50);
        assert_eq!(search_limit(Some(&json!("0"))), 20);
        assert_eq!(search_limit(Some(&json!("-3"))), 20);
        assert_eq!(search_limit(Some(&json!(" 12 "))), 12);
        assert_eq!(search_limit(Some(&json!("0x10"))), 20);
        assert_eq!(search_limit(Some(&json!("3.9"))), 3);
        // A qs list joins with commas: parseInt("5,6") = 5.
        assert_eq!(search_limit(Some(&json!(["5", "6"]))), 5);
        // An object is "[object Object]": NaN → default.
        assert_eq!(search_limit(Some(&json!({}))), 20);
        assert_eq!(search_limit(Some(&json!("99999999999999999999999"))), 50);
    }

    #[test]
    fn refresh_force_reads_query_then_body() {
        assert!(!refresh_force(None, &json!({})));
        assert!(refresh_force(Some(&json!("1")), &json!({})));
        assert!(!refresh_force(Some(&json!("true")), &json!({})));
        assert!(refresh_force(Some(&json!("")), &json!({ "force": "1" })));
        // A non-empty query string is truthy in JS, so it wins over the body.
        assert!(!refresh_force(Some(&json!("0")), &json!({ "force": "1" })));
        assert!(refresh_force(None, &json!({ "force": true })));
        assert!(!refresh_force(None, &json!({ "force": "true" })));
        assert!(refresh_force(None, &json!({ "force": 1 })));
        // A qs list of one value stringifies to "1".
        assert!(refresh_force(Some(&json!(["1"])), &json!({})));
    }

    #[test]
    fn bar_input_body_wins_and_sanitizes() {
        let input = BarInput::read(
            &json!({ "kind": " OPENCODE ", "session": " s ", "baseUrl": "http://x", "host": "H.example", "force": "true" }),
            BarQuery::default(),
        );
        assert_eq!(
            input,
            BarInput {
                kind: "opencode".into(),
                session: "s".into(),
                base_url: "http://x".into(),
                host: "h.example".into(),
                force: true,
            }
        );
        let input = BarInput::read(
            &json!({}),
            BarQuery {
                kind: Some(&json!("ARK")),
                force: Some(&json!("1")),
                ..BarQuery::default()
            },
        );
        assert_eq!(input.kind, "ark");
        assert!(input.force);
        assert_eq!(
            input.selector(),
            json!({ "session": "", "baseUrl": "", "host": "" })
        );
        // A body that is not an object falls back to the query.
        let input = BarInput::read(
            &json!("x"),
            BarQuery {
                kind: Some(&json!("kimi")),
                ..BarQuery::default()
            },
        );
        assert_eq!(input.kind, "kimi");
        // Control characters are replaced, then trimmed.
        let input = BarInput::read(&json!({ "session": " a\u{0}b " }), BarQuery::default());
        assert_eq!(input.session, "a b");
    }

    #[test]
    fn status_maps_match_every_retired_branch() {
        assert_eq!(opencode_http(&json!("ok")), 200);
        assert_eq!(opencode_http(&json!("no_auth")), 401);
        assert_eq!(opencode_http(&json!("needs_login")), 401);
        assert_eq!(opencode_http(&json!("chrome_unavailable")), 503);
        assert_eq!(opencode_http(&json!("unavailable")), 500);

        assert_eq!(qoder_http(&json!("needs_login")), 401);
        assert_eq!(qoder_http(&json!("chrome_unavailable")), 503);
        assert_eq!(qoder_http(&json!("unavailable")), 500);
        assert_eq!(qoder_http(&json!("no_auth")), 500);

        assert_eq!(codex_http(&json!("ok")), 200);
        assert_eq!(codex_http(&json!("no_auth")), 401);
        assert_eq!(codex_http(&json!("unavailable")), 500);

        assert_eq!(ark_http(&json!("ok")), 200);
        assert_eq!(ark_http(&json!("needs_auth")), 401);
        assert_eq!(ark_http(&json!("needs_install")), 404);
        assert_eq!(ark_http(&json!("unavailable")), 500);

        assert_eq!(kimi_http(&json!("ok")), 200);
        assert_eq!(kimi_http(&json!("not_configured")), 404);
        assert_eq!(kimi_http(&json!("needs_login")), 401);
        assert_eq!(kimi_http(&json!("chrome_unavailable")), 503);
        assert_eq!(kimi_http(&json!("unavailable")), 502);

        assert_eq!(claude_http(&json!("ok")), 200);
        assert_eq!(claude_http(&json!("idle")), 200);
        assert_eq!(claude_http(&json!("needs_login")), 401);
        assert_eq!(claude_http(&json!("chrome_unavailable")), 503);
        assert_eq!(claude_http(&json!("unavailable")), 500);

        assert_eq!(aliyun_http(&json!("ok")), 200);
        assert_eq!(aliyun_http(&json!("needs_login")), 401);
        assert_eq!(aliyun_http(&json!("chrome_unavailable")), 503);
        assert_eq!(aliyun_http(&json!("unavailable")), 502);

        assert_eq!(bar_refresh_http(&json!("idle")), 200);
        assert_eq!(bar_refresh_http(&json!("no_auth")), 401);
        assert_eq!(bar_refresh_http(&json!("needs_auth")), 401);
        assert_eq!(bar_refresh_http(&json!("needs_install")), 503);
        assert_eq!(bar_refresh_http(&json!("unavailable")), 500);
    }

    #[test]
    fn body_shapes_keep_the_retired_key_order() {
        let result = json!({ "status": "ok", "fetchedAt": 5, "usage": { "a": 1 } });
        assert_eq!(
            crate::js::serde::js_json_stringify(&spread_with_bar(
                Some(&result),
                json!({"text":"t"})
            )),
            r#"{"status":"ok","fetchedAt":5,"usage":{"a":1},"bar":{"text":"t"}}"#
        );
        // `status` keeps its original position and takes the override value.
        assert_eq!(
            crate::js::serde::js_json_stringify(&claude_body(
                Some(&json!({"status":"ok","x":1})),
                json!("ok"),
                Value::Null
            )),
            r#"{"status":"ok","x":1,"bar":null}"#
        );
        assert_eq!(
            crate::js::serde::js_json_stringify(&claude_body(None, json!("idle"), Value::Null)),
            r#"{"status":"idle","bar":null}"#
        );
        let refresh = bar_refresh_body(
            Some(&json!({"status":"unavailable","error":"boom","reason":"r","fetchedAt":0})),
            json!({"text":"t"}),
            Value::Null,
        );
        assert_eq!(
            crate::js::serde::js_json_stringify(&refresh),
            r#"{"status":"unavailable","fetchedAt":null,"error":"boom","reason":"r","bar":{"text":"t"},"cached":null}"#
        );
        let refresh = bar_refresh_body(None, Value::Null, json!({"x":1}));
        assert_eq!(
            crate::js::serde::js_json_stringify(&refresh),
            r#"{"status":"unavailable","fetchedAt":null,"bar":null,"cached":{"x":1}}"#
        );
    }

    #[test]
    fn login_and_pricing_envelopes_are_stable() {
        assert_eq!(
            crate::js::serde::js_json_stringify(&login_ok("qoder")),
            r#"{"ok":true,"message":"已打开登录窗口：请在弹出的 Chrome 中登录 qoder.com.cn，完成后回来重新查询余量"}"#
        );
        assert_eq!(
            crate::js::serde::js_json_stringify(&login_failure(
                Some(json!("chrome_unavailable")),
                Some("boom")
            )),
            r#"{"ok":false,"error":"chrome_unavailable","message":"boom"}"#
        );
        assert_eq!(
            crate::js::serde::js_json_stringify(&login_failure(None, None)),
            r#"{"ok":false,"error":"login_window_failed"}"#
        );
        assert_eq!(
            crate::js::serde::js_json_stringify(&pricing_error("models_required", 50)),
            r#"{"ok":false,"error":"models_required","max":50}"#
        );
        assert_eq!(
            crate::js::serde::js_json_stringify(&pricing_search(
                "q",
                json!([1, 2]),
                json!({"at":1})
            )),
            r#"{"ok":true,"query":"q","count":2,"results":[1,2],"status":{"at":1}}"#
        );
        assert_eq!(
            crate::js::serde::js_json_stringify(&pricing_lookup(json!({"m":1}), json!({"at":1}))),
            r#"{"ok":true,"prices":{"m":1},"status":{"at":1}}"#
        );
        assert_eq!(
            crate::js::serde::js_json_stringify(&ark_login_started(Some(json!(42)))),
            r#"{"status":"started","pid":42}"#
        );
        assert_eq!(
            crate::js::serde::js_json_stringify(&ark_login_started(None)),
            r#"{"status":"started","pid":null}"#
        );
    }

    #[test]
    fn idle_bars_list_every_kind_in_order() {
        let bars = idle_bars();
        assert_eq!(bars["status"], json!("ok"));
        let body = crate::js::serde::js_json_stringify(&bars);
        let order: Vec<usize> = ["opencode", "qoder", "codex", "ark", "kimi", "claude"]
            .iter()
            .map(|kind| body.find(&format!("\"{kind}\":")).unwrap())
            .collect();
        assert!(order.windows(2).all(|pair| pair[0] < pair[1]), "{body}");
    }

    #[test]
    fn render_bar_uses_the_shared_kernel() {
        let bar = render_bar("opencode", Some(&json!({ "status": "idle" })), &json!({}));
        assert!(bar.is_object());
        assert_eq!(
            crate::js::serde::js_json_stringify(&render_bar("nope", None, &json!({}))),
            "null"
        );
    }
}
