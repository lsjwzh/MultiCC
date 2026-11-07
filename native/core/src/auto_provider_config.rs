//! The persisted Auto Provider selection contract — one implementation, here.
//!
//! `src/providers/auto-provider-config.js` used to own every rule in this file.
//! It is now a thin bridge: it asks a caller's provider registry the questions
//! this module cannot ask (it never does I/O), and hands the answers back as
//! data. Everything else — the constants, the regular expressions, the error
//! text and codes, the key order of every returned DTO — lives here.
//!
//! Two kinds of cross-module facts are passed in, never restated:
//!
//! * the Jev gateway table ([`Facts::from_value`]): which gateways exist, their
//!   endpoint/model/vault entry, the default and the `custom` rules;
//! * the native-line namespaces (`opencode-native:` and `<cli>-native:`): their
//!   prefix/suffix, the lanes that own one, and the id/model patterns.
//!
//! The provider registry (`listProviders`, `appTypeForCli`, …) is a set of
//! JavaScript callbacks. The bridge invokes them; this module drives *which*
//! ones it invokes, in the original order and exactly as often, through a
//! small deferred-probe protocol:
//!
//! 1. the caller sends a request with `answers: []`;
//! 2. the reply is `{"probe": {"index": n, "kind": …}}` when a callback is
//!    needed — the caller runs it and re-sends the same request with the
//!    answer appended;
//! 3. once every needed answer is present the reply is `{"result": …}`.
//!
//! Re-running the deterministic validation with the already-collected answers
//! replays the same decisions, so the callback sequence is byte-for-byte the
//! one the old inline implementation produced (down to short-circuiting and
//! call counts). This module itself stays pure: no I/O, no closures over host
//! state.
//!
//! Every public entry point takes and returns a JSON string:
//! `validate_provider_selection`, `provider_selection_dto`,
//! `normalize_stored_provider_selection`, `primary_provider_candidate`,
//! `selection_clis`, `catalog_app_types`, `protocol_of`, `trust_domain_of`,
//! `custom_endpoint_error`, `validate_routing_target`, `jev_target`.
//!
//! Requests are parsed leniently ([`crate::json_lenient`]): the JS bridge
//! `JSON.stringify`s whatever it was handed, and a lone surrogate (a sliced
//! emoji, pasted mojibake) must reach the validation rules as U+FFFD, the way
//! the old JS implementation's plain string handling saw it — not fail the
//! whole call as a malformed request.

use crate::js::{js_trim, utf16_len};
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use url::Url;

// ── module-owned constants ──────────────────────────────────────────────────

const PROTOCOLS: [&str; 2] = ["anthropic", "openai_responses"];
const PROVIDER_ID_PATTERN: &str = r"^[A-Za-z0-9._:-]{1,160}$";
const MODEL_ID_PATTERN: &str = r"^[A-Za-z0-9._:/\[\]-]{1,100}$";
// `~` is the OpenRouter community namespace; routing.model is the only field
// that may carry it.
const ROUTING_MODEL_ID_PATTERN: &str = r"^[A-Za-z0-9._:/\[\]~-]{1,100}$";
const AUTO_PROVIDER_ID_PATTERN: &str = r"(?i)^auto(?::|$)";
const MAX_CANDIDATES: usize = 12;
const MAX_ATTEMPTS: usize = 4;
// Preset ids are minted by the web client (`p<base36>`), but the field is only
// a label: any short string is accepted so old/new clients can round-trip it.
const MAX_PRESET_ID: usize = 128;
const TIER_KEY_PATTERN: &str = r"^[A-Za-z0-9_-]{1,24}$";
const MAX_TIERS: usize = 6;
const ROUTING_ON_UNKNOWN: [&str; 3] = ["strong", "weak", "priority"];
const ROUTING_ESCALATION_KEYS: [&str; 2] = ["minConfidence", "minTierProbability"];
const CUSTOM_ROUTING_API_KEY_PREFIX: &str = "JEV_";
const LEGACY_CUSTOM_ROUTING_API_KEY_PREFIX: &str = "jev-";
const LOOPBACK_HOSTS: [&str; 3] = ["127.0.0.1", "localhost", "[::1]"];
const VAULT_NAME_PATTERN: &str = r"^[A-Za-z0-9_.-]{1,64}$";
const DEFAULT_ROUTING_TIMEOUT_MS: i64 = 2_500;
const MIN_ROUTING_TIMEOUT_MS: i64 = 250;
const MAX_ROUTING_TIMEOUT_MS: i64 = 10_000;
const AUTO_CLIS: [&str; 14] = [
    "claude",
    "claude-exp",
    "codex",
    "codex-exp",
    "opencode",
    "zcode",
    "kimi",
    "dsh",
    "grok",
    "qoder",
    "codebuddy",
    "gemini",
    "pi",
    "commandcode",
];
const MULTI_PROTOCOL_CLIS: [&str; 3] = ["opencode", "zcode", "grok"];
const CLI_SWITCH_POLICIES: [&str; 2] = ["failover", "routing"];
const ROUTING_TIERINGS: [&str; 2] = ["manual", "price"];
const ROUTING_PROVIDERS: [&str; 1] = ["jev"];

// ── small JavaScript semantics ──────────────────────────────────────────────
//
// The contract is a JavaScript one: values that cross the bridge arrive as
// JSON, but the rules were written against `String(x)`, `Number(x)`,
// truthiness, `.trim()` and `.length`. These helpers reproduce those exactly
// where JSON alone would not (`undefined`, `NaN`, UTF-16 lengths, the U+FEFF
// family). `NaN`/`±Infinity`/`BigInt` are tagged by the bridge as
// `{"__jsnum__": …}` / `{"__jsbigint__": …}`.

const TAG_NUMBER: &str = "__jsnum__";
const TAG_BIGINT: &str = "__jsbigint__";

fn tag(value: &Value) -> Option<(&'static str, &str)> {
    let object = value.as_object()?;
    if object.len() != 1 {
        return None;
    }
    if let Some(text) = object.get(TAG_NUMBER).and_then(Value::as_str) {
        return Some(("number", text));
    }
    if let Some(text) = object.get(TAG_BIGINT).and_then(Value::as_str) {
        return Some(("bigint", text));
    }
    None
}

/// `typeof value === 'object'` for the values JSON can carry (tags are numbers).
fn is_js_object(value: &Value) -> bool {
    value.is_object() && tag(value).is_none()
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number
            .as_f64()
            .is_some_and(|float| float != 0.0 && !float.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) => true,
        Value::Object(_) => match tag(value) {
            Some(("number", text)) => !matches!(text, "NaN" | "0"),
            Some(("bigint", text)) => {
                let digits = text.strip_prefix('-').unwrap_or(text);
                !digits.is_empty() && digits != "0"
            }
            _ => true,
        },
    }
}

fn truthy_opt(value: Option<&Value>) -> bool {
    value.is_some_and(truthy)
}

fn format_number(number: &serde_json::Number) -> String {
    if let Some(integer) = number.as_i64() {
        return integer.to_string();
    }
    if let Some(integer) = number.as_u64() {
        return integer.to_string();
    }
    let float = number.as_f64().unwrap_or(f64::NAN);
    if float.is_nan() {
        return "NaN".to_string();
    }
    if float.is_infinite() {
        return if float.is_sign_negative() {
            "-Infinity".to_string()
        } else {
            "Infinity".to_string()
        };
    }
    if float == 0.0 {
        return "0".to_string();
    }
    let mut buffer = ryu_js::Buffer::new();
    buffer.format_finite(float).to_string()
}

/// `String(value)`. Array holes are encoded as `null` by the bridge.
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
        Value::Object(_) => match tag(value) {
            Some((_, text)) => text.to_string(),
            None => "[object Object]".to_string(),
        },
    }
}

/// `String(container.prop)`: a missing property reads as `undefined`.
fn js_member_string(container: &Value, key: &str) -> String {
    match get(container, key) {
        Some(value) => js_string(value),
        None => "undefined".to_string(),
    }
}

/// `String(value || '')`: falsy values become the empty string.
fn js_string_or_empty(value: Option<&Value>) -> String {
    match value {
        Some(value) if truthy(value) => js_string(value),
        _ => String::new(),
    }
}

fn parse_number_text(text: &str) -> f64 {
    let trimmed = js_trim(text);
    if trimmed.is_empty() {
        return 0.0;
    }
    let lowered = trimmed.to_ascii_lowercase();
    match lowered.as_str() {
        "infinity" if trimmed == "Infinity" || trimmed == "+Infinity" => return f64::INFINITY,
        "-infinity" if trimmed == "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    let signed = trimmed.starts_with('+') || trimmed.starts_with('-');
    if !signed {
        // Radix literals take no sign, and `Number('0x10')` is 16.
        let radix = trimmed
            .strip_prefix("0x")
            .or_else(|| trimmed.strip_prefix("0X"))
            .map(|digits| (digits, 16))
            .or_else(|| {
                trimmed
                    .strip_prefix("0o")
                    .or_else(|| trimmed.strip_prefix("0O"))
                    .map(|digits| (digits, 8))
            })
            .or_else(|| {
                trimmed
                    .strip_prefix("0b")
                    .or_else(|| trimmed.strip_prefix("0B"))
                    .map(|digits| (digits, 2))
            });
        if let Some((digits, base)) = radix {
            return u128::from_str_radix(digits, base).map_or(f64::NAN, |integer| integer as f64);
        }
    }
    match trimmed.parse::<f64>() {
        Ok(float) => {
            if float.is_nan() {
                f64::NAN
            } else if float.is_infinite() && !lowered.contains('e') {
                // Rust also parses `inf`/`infinity`; JavaScript's `Number()`
                // only accepts the exact `Infinity` spelling (handled above).
                f64::NAN
            } else {
                float
            }
        }
        Err(_) => f64::NAN,
    }
}

/// `Number(value)`.
fn js_number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(flag) => {
            if *flag {
                1.0
            } else {
                0.0
            }
        }
        Value::Number(number) => number.as_f64().unwrap_or(f64::NAN),
        Value::String(text) => parse_number_text(text),
        Value::Array(_) => parse_number_text(&js_string(value)),
        Value::Object(_) => match tag(value) {
            Some(("number", text)) => match text {
                "Infinity" => f64::INFINITY,
                "-Infinity" => f64::NEG_INFINITY,
                _ => f64::NAN,
            },
            Some(("bigint", text)) => text.parse::<f64>().unwrap_or(f64::NAN),
            _ => f64::NAN,
        },
    }
}

fn is_safe_integer(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0
}

fn is_nullish(value: Option<&Value>) -> bool {
    value.is_none_or(Value::is_null)
}

fn value_is(value: Option<&Value>, expected: &Value) -> bool {
    match value {
        Some(actual) => json_equal(actual, expected),
        None => false,
    }
}

fn value_is_empty_string(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::String(text)) if text.is_empty())
}

/// Structural equality; the only structural values compared here are strings
/// in practice. `NaN` is never equal.
fn json_equal(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Null, Value::Null) => true,
        (Value::Bool(a), Value::Bool(b)) => a == b,
        (Value::Number(a), Value::Number(b)) => match (a.as_f64(), b.as_f64()) {
            (Some(x), Some(y)) => x == y,
            _ => false,
        },
        (Value::String(a), Value::String(b)) => a == b,
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b.iter()).all(|(x, y)| json_equal(x, y))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, value)| b.get(key).is_some_and(|other| json_equal(value, other)))
        }
        _ => false,
    }
}

/// SameValueZero, used by `Array.prototype.includes`.
fn same_value_zero(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(a), Value::Number(b)) => match (a.as_f64(), b.as_f64()) {
            (Some(x), Some(y)) => x == y || (x.is_nan() && y.is_nan()),
            _ => false,
        },
        _ => json_equal(left, right),
    }
}

fn includes_value(items: &[Value], needle: &Value) -> bool {
    items.iter().any(|item| same_value_zero(item, needle))
}

fn get<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.as_object().and_then(|object| object.get(key))
}

fn array_length(value: Option<&Value>) -> usize {
    value.and_then(Value::as_array).map_or(0, Vec::len)
}

// ── cached regular expressions ──────────────────────────────────────────────

fn regex_cache() -> &'static Mutex<HashMap<(String, bool), Regex>> {
    static CACHE: OnceLock<Mutex<HashMap<(String, bool), Regex>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn compile_regex(pattern: &str, ignore_case: bool) -> Result<Regex, String> {
    let key = (pattern.to_string(), ignore_case);
    if let Ok(cache) = regex_cache().lock() {
        if let Some(regex) = cache.get(&key) {
            return Ok(regex.clone());
        }
    }
    let source = if ignore_case {
        format!("(?i){pattern}")
    } else {
        pattern.to_string()
    };
    let regex = Regex::new(&source).map_err(|error| format!("invalid regex: {error}"))?;
    if let Ok(mut cache) = regex_cache().lock() {
        cache.insert(key, regex.clone());
    }
    Ok(regex)
}

fn local_regex(pattern: &str) -> Regex {
    compile_regex(pattern, false).expect("module-owned regex compiles")
}

// ── cross-module facts ──────────────────────────────────────────────────────

#[derive(Clone)]
struct Gateway {
    name: String,
    endpoint: String,
    model: String,
    api_key_name: String,
}

struct Facts {
    gateways: Vec<Gateway>,
    gateway_index: HashMap<String, usize>,
    default_gateway: String,
    custom_gateway: String,
    custom_api_key_name: String,
    custom_model: String,
    max_endpoint_chars: usize,
    native_opencode_prefix: String,
    native_opencode_id: Regex,
    native_vendor_suffix: String,
    vendor_native_clis: HashSet<String>,
    native_vendor_id: Regex,
    native_vendor_model: Regex,
}

fn facts_text(object: &Value, key: &str) -> Result<String, String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("facts.{key} must be a string"))
}

fn facts_flag(object: &Value, key: &str) -> bool {
    object.get(key) == Some(&Value::Bool(true))
}

impl Facts {
    fn from_value(value: &Value) -> Result<Self, String> {
        let gateways_value = value
            .get("gateways")
            .and_then(Value::as_array)
            .ok_or_else(|| "facts.gateways must be an array".to_string())?;
        let mut gateways = Vec::with_capacity(gateways_value.len());
        let mut gateway_index = HashMap::new();
        for entry in gateways_value {
            let name = facts_text(entry, "name")?;
            gateway_index.insert(name.clone(), gateways.len());
            gateways.push(Gateway {
                name,
                endpoint: facts_text(entry, "endpoint")?,
                model: facts_text(entry, "model")?,
                api_key_name: facts_text(entry, "apiKeyName")?,
            });
        }
        let vendor_native_clis = value
            .get("vendorNativeClis")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        Ok(Facts {
            gateways,
            gateway_index,
            default_gateway: facts_text(value, "defaultGateway")?,
            custom_gateway: facts_text(value, "customGateway")?,
            custom_api_key_name: facts_text(value, "customApiKeyName")?,
            custom_model: facts_text(value, "customModel")?,
            max_endpoint_chars: value
                .get("maxEndpointChars")
                .and_then(Value::as_u64)
                .ok_or_else(|| "facts.maxEndpointChars must be a number".to_string())?
                as usize,
            native_opencode_prefix: facts_text(value, "nativeOpenCodePrefix")?,
            native_opencode_id: compile_regex(
                &facts_text(value, "nativeOpenCodeIdPattern")?,
                facts_flag(value, "nativeOpenCodeIdIgnoreCase"),
            )?,
            native_vendor_suffix: facts_text(value, "nativeVendorSuffix")?,
            vendor_native_clis,
            native_vendor_id: compile_regex(
                &facts_text(value, "nativeVendorIdPattern")?,
                facts_flag(value, "nativeVendorIdIgnoreCase"),
            )?,
            native_vendor_model: compile_regex(
                &facts_text(value, "nativeVendorModelPattern")?,
                facts_flag(value, "nativeVendorModelIgnoreCase"),
            )?,
        })
    }

    fn gateway(&self, name: &str) -> Option<&Gateway> {
        self.gateway_index
            .get(name)
            .map(|index| &self.gateways[*index])
    }

    fn default_api_key_name(&self) -> Option<&str> {
        self.gateway(&self.default_gateway)
            .map(|gateway| gateway.api_key_name.as_str())
    }

    fn is_routing_gateway(&self, name: &str) -> bool {
        self.gateway_index.contains_key(name) || name == self.custom_gateway
    }

    fn routing_gateway_names(&self) -> Vec<String> {
        let mut names: Vec<String> = self
            .gateways
            .iter()
            .map(|gateway| gateway.name.clone())
            .collect();
        if !names.iter().any(|name| name == &self.custom_gateway) {
            names.push(self.custom_gateway.clone());
        }
        names
    }
}

fn require_facts(request: &Value) -> Result<Facts, String> {
    let facts = request
        .get("facts")
        .ok_or_else(|| "request.facts is required".to_string())?;
    Facts::from_value(facts)
}

// ── `facts()` snapshot ──────────────────────────────────────────────────────

pub fn facts(request: &str) -> Result<String, String> {
    let value: Value = crate::json_lenient::from_str(request).map_err(|error| error.to_string())?;
    let parsed = Facts::from_value(&value)?;
    let default_api_key = parsed
        .default_api_key_name()
        .ok_or_else(|| "facts.defaultGateway names no gateway".to_string())?
        .to_string();
    let snapshot = json!({
        "protocols": PROTOCOLS,
        "autoClis": AUTO_CLIS,
        "cliSwitchPolicies": CLI_SWITCH_POLICIES,
        "routingGateways": parsed.routing_gateway_names(),
        "defaultRoutingGateway": parsed.default_gateway,
        "customRoutingGateway": parsed.custom_gateway,
        "defaultRoutingApiKey": default_api_key,
        "defaultCustomRoutingApiKey": parsed.custom_api_key_name,
        "defaultCustomRoutingModel": parsed.custom_model,
        "maxRoutingEndpointChars": parsed.max_endpoint_chars,
        "maxCandidates": MAX_CANDIDATES,
        "maxAttempts": MAX_ATTEMPTS,
        "maxTiers": MAX_TIERS,
    });
    serde_json::to_string(&snapshot).map_err(|error| error.to_string())
}

// ── protocol / trust ────────────────────────────────────────────────────────

fn protocol_of_value(provider: &Value) -> Option<String> {
    if !truthy(provider) || tag(provider).is_some() {
        return None;
    }
    let raw = match get(provider, "protocol") {
        Some(value) if truthy(value) => Some(value.clone()),
        _ => get(provider, "apiFormat").cloned(),
    };
    let raw = raw?;
    if raw == Value::String("openai_chat".to_string()) {
        return Some("openai_responses".to_string());
    }
    match &raw {
        Value::String(text) if PROTOCOLS.contains(&text.as_str()) => Some(text.clone()),
        _ => None,
    }
}

fn trust_domain_of_value(provider: &Value) -> &'static str {
    if truthy(provider) && truthy_opt(get(provider, "isOfficial")) {
        "official"
    } else {
        "user-managed"
    }
}

pub fn protocol_of(request: &str) -> Result<String, String> {
    let value: Value = crate::json_lenient::from_str(request).map_err(|error| error.to_string())?;
    stringify_option(protocol_of_value(
        value.get("provider").unwrap_or(&Value::Null),
    ))
}

pub fn trust_domain_of(request: &str) -> Result<String, String> {
    let value: Value = crate::json_lenient::from_str(request).map_err(|error| error.to_string())?;
    let domain = trust_domain_of_value(value.get("provider").unwrap_or(&Value::Null));
    stringify_option(Some(domain.to_string()))
}

fn stringify_option(value: Option<String>) -> Result<String, String> {
    match value {
        Some(text) => {
            serde_json::to_string(&Value::String(text)).map_err(|error| error.to_string())
        }
        None => Ok("null".to_string()),
    }
}

// ── custom endpoint ─────────────────────────────────────────────────────────

fn custom_endpoint_error_value(facts: &Facts, raw: &Value) -> Option<String> {
    // `String(raw == null ? '' : raw)`.
    let text = if raw.is_null() {
        String::new()
    } else {
        js_string(raw)
    };
    let endpoint = js_trim(&text).to_string();
    if endpoint.is_empty() {
        return Some("routing.endpoint is required for the custom gateway".to_string());
    }
    if utf16_len(&endpoint) > facts.max_endpoint_chars {
        return Some(format!(
            "routing.endpoint must be at most {} characters",
            facts.max_endpoint_chars
        ));
    }
    let Ok(url) = Url::parse(&endpoint) else {
        return Some("routing.endpoint must be a URL".to_string());
    };
    if !url.username().is_empty() || url.password().is_some_and(|password| !password.is_empty()) {
        return Some("routing.endpoint must not carry credentials".to_string());
    }
    if url.scheme() == "https" {
        return None;
    }
    if url.scheme() == "http"
        && url
            .host_str()
            .is_some_and(|host| LOOPBACK_HOSTS.contains(&host))
    {
        return None;
    }
    Some("routing.endpoint must use https (http only for a loopback host)".to_string())
}

pub fn custom_endpoint_error(request: &str) -> Result<String, String> {
    let value: Value = crate::json_lenient::from_str(request).map_err(|error| error.to_string())?;
    let facts = require_facts(&value)?;
    let raw = value.get("endpoint").unwrap_or(&Value::Null);
    stringify_option(custom_endpoint_error_value(&facts, raw))
}

// ── failure objects ─────────────────────────────────────────────────────────

fn fail_with_code(error: String, code: &str) -> Value {
    let mut object = Map::new();
    object.insert("ok".to_string(), Value::Bool(false));
    object.insert("value".to_string(), Value::Null);
    object.insert("error".to_string(), Value::String(error));
    object.insert("code".to_string(), Value::String(code.to_string()));
    Value::Object(object)
}

fn fail(error: String) -> Value {
    fail_with_code(error, "invalid_provider_selection")
}

fn ok_null() -> Value {
    let mut object = Map::new();
    object.insert("ok".to_string(), Value::Bool(true));
    object.insert("value".to_string(), Value::Null);
    object.insert("error".to_string(), Value::Null);
    object.insert("code".to_string(), Value::Null);
    Value::Object(object)
}

// ── routing target ─────────────────────────────────────────────────────────

fn routing_source(input: Option<&Value>) -> &Value {
    match input {
        Some(value) if value.is_object() => value,
        _ => &Value::Null,
    }
}

fn validate_routing_target_value(facts: &Facts, input: Option<&Value>) -> Result<Value, Value> {
    let source = routing_source(input);
    let gateway_value = get(source, "gateway");
    let gateway = if is_nullish(gateway_value) || value_is_empty_string(gateway_value) {
        facts.default_gateway.clone()
    } else {
        js_trim(&js_string(gateway_value.unwrap_or(&Value::Null))).to_lowercase()
    };
    if !facts.is_routing_gateway(&gateway) {
        return Err(fail_with_code(
            format!("unsupported routing gateway {gateway}"),
            "invalid_provider_routing",
        ));
    }
    let preset = facts.gateway(&gateway).cloned();
    if preset.is_some() {
        if let Some(endpoint) = get(source, "endpoint") {
            if !endpoint.is_null() && !js_trim(&js_string(endpoint)).is_empty() {
                return Err(fail_with_code(
                    "routing.endpoint is only allowed for the custom gateway".to_string(),
                    "invalid_provider_routing",
                ));
            }
        }
    }
    let endpoint = if gateway == facts.custom_gateway {
        js_trim(&js_string_or_empty(get(source, "endpoint"))).to_string()
    } else {
        preset
            .as_ref()
            .map(|entry| entry.endpoint.clone())
            .unwrap_or_default()
    };
    if gateway == facts.custom_gateway {
        if let Some(problem) = custom_endpoint_error_value(facts, &Value::String(endpoint.clone()))
        {
            return Err(fail_with_code(problem, "invalid_provider_routing"));
        }
    }
    let api_key_default = preset
        .as_ref()
        .map(|entry| entry.api_key_name.clone())
        .unwrap_or_else(|| facts.custom_api_key_name.clone());
    let api_key_name = match get(source, "apiKeyName") {
        None => api_key_default,
        Some(value) if value.is_null() => api_key_default,
        Some(value) => {
            let text = js_trim(&js_string(value)).to_string();
            if text.is_empty() {
                api_key_default
            } else {
                text
            }
        }
    };
    if !local_regex(VAULT_NAME_PATTERN).is_match(&api_key_name) {
        return Err(fail_with_code(
            "routing.apiKeyName must be a vault entry name".to_string(),
            "invalid_provider_routing",
        ));
    }
    if gateway == facts.custom_gateway
        && !api_key_name.starts_with(CUSTOM_ROUTING_API_KEY_PREFIX)
        && !api_key_name.starts_with(LEGACY_CUSTOM_ROUTING_API_KEY_PREFIX)
    {
        return Err(fail_with_code(
            format!(
                "a custom gateway key must live in a {CUSTOM_ROUTING_API_KEY_PREFIX}* vault entry"
            ),
            "invalid_provider_routing",
        ));
    }
    let model_default = preset
        .as_ref()
        .map(|entry| entry.model.clone())
        .unwrap_or_else(|| facts.custom_model.clone());
    let model = match get(source, "model") {
        None => model_default,
        Some(value) if value.is_null() => model_default,
        Some(value) => {
            let text = js_trim(&js_string(value)).to_string();
            if text.is_empty() {
                model_default
            } else {
                text
            }
        }
    };
    if !local_regex(ROUTING_MODEL_ID_PATTERN).is_match(&model) {
        return Err(fail_with_code(
            "routing.model is invalid".to_string(),
            "invalid_provider_routing",
        ));
    }
    let mut value = Map::new();
    value.insert("gateway".to_string(), Value::String(gateway.clone()));
    if gateway == facts.custom_gateway {
        value.insert("endpoint".to_string(), Value::String(endpoint));
    }
    value.insert("model".to_string(), Value::String(model));
    value.insert("apiKeyName".to_string(), Value::String(api_key_name));
    Ok(Value::Object(value))
}

pub fn validate_routing_target(request: &str) -> Result<String, String> {
    let value: Value = crate::json_lenient::from_str(request).map_err(|error| error.to_string())?;
    let facts = require_facts(&value)?;
    let outcome = validate_routing_target_value(&facts, value.get("input"));
    let result = match outcome {
        Ok(value) => {
            let mut object = Map::new();
            object.insert("ok".to_string(), Value::Bool(true));
            object.insert("value".to_string(), value);
            Value::Object(object)
        }
        Err(error) => error,
    };
    serde_json::to_string(&result).map_err(|error| error.to_string())
}

fn jev_target_value(facts: &Facts, routing: Option<&Value>) -> Value {
    let source = routing_source(routing);
    let named = js_trim(&js_string_or_empty(get(source, "gateway"))).to_lowercase();
    let gateway = if facts.is_routing_gateway(&named) {
        named
    } else {
        facts.default_gateway.clone()
    };
    let preset = facts.gateway(&gateway);
    let model = js_trim(&js_string_or_empty(get(source, "model"))).to_string();
    let api_key_name = js_trim(&js_string_or_empty(get(source, "apiKeyName"))).to_string();
    let endpoint = js_trim(&js_string_or_empty(get(source, "endpoint"))).to_string();
    let mut value = Map::new();
    value.insert("gateway".to_string(), Value::String(gateway.clone()));
    let endpoint_value = if gateway == facts.custom_gateway {
        if endpoint.is_empty() {
            Value::Null
        } else {
            Value::String(endpoint)
        }
    } else {
        Value::String(
            preset
                .map(|entry| entry.endpoint.clone())
                .unwrap_or_default(),
        )
    };
    value.insert("endpoint".to_string(), endpoint_value);
    let model_value = if model.is_empty() {
        preset
            .map(|entry| entry.model.clone())
            .unwrap_or_else(|| facts.custom_model.clone())
    } else {
        model
    };
    value.insert("model".to_string(), Value::String(model_value));
    let key_value = if api_key_name.is_empty() {
        preset
            .map(|entry| entry.api_key_name.clone())
            .unwrap_or_else(|| facts.custom_api_key_name.clone())
    } else {
        api_key_name
    };
    value.insert("apiKeyName".to_string(), Value::String(key_value));
    Value::Object(value)
}

pub fn jev_target(request: &str) -> Result<String, String> {
    let value: Value = crate::json_lenient::from_str(request).map_err(|error| error.to_string())?;
    let facts = require_facts(&value)?;
    let target = jev_target_value(&facts, value.get("routing"));
    serde_json::to_string(&target).map_err(|error| error.to_string())
}

// ── routing block ──────────────────────────────────────────────────────────

enum RoutingOutcome {
    Absent,
    Value(Value),
    Failed(Value),
}

fn tier_order_for(candidates: &[Value], declared: Option<&Value>) -> Result<Vec<String>, Value> {
    let mut indexed: Vec<(f64, usize, &Value)> = candidates
        .iter()
        .enumerate()
        .map(|(index, candidate)| {
            let priority = match get(candidate, "priority") {
                Some(value) => js_number(value),
                None => f64::NAN,
            };
            (priority, index, candidate)
        })
        .collect();
    // JavaScript's `sort` keeps the input order when the comparator answers
    // NaN, so an absent priority leaves the candidate where it was.
    indexed.sort_by(|left, right| match (left.0.is_nan(), right.0.is_nan()) {
        (false, false) => left
            .0
            .partial_cmp(&right.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(left.1.cmp(&right.1)),
        _ => left.1.cmp(&right.1),
    });
    let mut derived: Vec<String> = Vec::new();
    for (_, _, candidate) in &indexed {
        if truthy_opt(get(candidate, "enabled")) {
            if let Some(tier) = get(candidate, "tier") {
                if truthy(tier) {
                    let text = js_string(tier);
                    if !derived.contains(&text) {
                        derived.push(text);
                    }
                }
            }
        }
    }
    let present: HashSet<String> = derived.iter().cloned().collect();
    let Some(declared) = declared else {
        return Ok(derived);
    };
    let Some(items) = declared.as_array() else {
        return Ok(derived);
    };
    let mut order: Vec<String> = Vec::new();
    for raw in items {
        let key = match raw {
            Value::Null => String::new(),
            other => js_trim(&js_string(other)).to_string(),
        };
        if !local_regex(TIER_KEY_PATTERN).is_match(&key) {
            return Err(fail_with_code(
                "routing.tiers must be tier keys".to_string(),
                "invalid_provider_routing",
            ));
        }
        if !present.contains(&key) {
            return Err(fail_with_code(
                format!("routing tier {key} is not used by any enabled candidate"),
                "provider_routing_tier_mismatch",
            ));
        }
        if order.contains(&key) {
            return Err(fail_with_code(
                format!("routing tier {key} appears more than once"),
                "invalid_provider_routing",
            ));
        }
        order.push(key);
    }
    if order.len() != derived.len() {
        return Err(fail_with_code(
            "routing.tiers must list every enabled candidate tier".to_string(),
            "provider_routing_tier_mismatch",
        ));
    }
    Ok(order)
}

fn validate_routing(facts: &Facts, input: Option<&Value>, candidates: &[Value]) -> RoutingOutcome {
    let Some(input) = input else {
        return RoutingOutcome::Absent;
    };
    if input.is_null() {
        return RoutingOutcome::Absent;
    }
    if !is_js_object(input) {
        return RoutingOutcome::Failed(fail_with_code(
            "providerSelection.routing must be an object".to_string(),
            "invalid_provider_routing",
        ));
    }
    if let Some(version) = get(input, "version") {
        if !version.is_null() && !value_is(Some(version), &json!(1)) {
            return RoutingOutcome::Failed(fail_with_code(
                "unsupported providerSelection.routing version".to_string(),
                "invalid_provider_routing",
            ));
        }
    }
    let provider = js_trim(&js_string_or_empty(get(input, "provider"))).to_lowercase();
    let provider = if provider.is_empty() {
        "jev".to_string()
    } else {
        provider
    };
    if !ROUTING_PROVIDERS.contains(&provider.as_str()) {
        return RoutingOutcome::Failed(fail_with_code(
            format!("unsupported routing provider {provider}"),
            "invalid_provider_routing",
        ));
    }
    let target = match validate_routing_target_value(facts, Some(input)) {
        Ok(value) => value,
        Err(error) => return RoutingOutcome::Failed(error),
    };
    let gateway = js_string(get(&target, "gateway").unwrap_or(&Value::Null));
    // Absent for a preset (destructured as `undefined`, i.e. omitted below).
    let endpoint = match get(&target, "endpoint") {
        Some(value) => js_string(value),
        None => String::new(),
    };
    let model = js_string(get(&target, "model").unwrap_or(&Value::Null));
    let api_key_name = js_string(get(&target, "apiKeyName").unwrap_or(&Value::Null));
    let timeout_ms = match get(input, "timeoutMs") {
        None => DEFAULT_ROUTING_TIMEOUT_MS as f64,
        Some(value) if value.is_null() => DEFAULT_ROUTING_TIMEOUT_MS as f64,
        Some(value) => js_number(value),
    };
    if !is_safe_integer(timeout_ms)
        || timeout_ms < MIN_ROUTING_TIMEOUT_MS as f64
        || timeout_ms > MAX_ROUTING_TIMEOUT_MS as f64
    {
        return RoutingOutcome::Failed(fail_with_code(
            format!("routing.timeoutMs must be {MIN_ROUTING_TIMEOUT_MS}-{MAX_ROUTING_TIMEOUT_MS}"),
            "invalid_provider_routing",
        ));
    }
    // `String(input.onUnknown).trim().toLowerCase()` once the field exists; an
    // empty string is *not* the default here.
    let on_unknown = match get(input, "onUnknown") {
        None => "strong".to_string(),
        Some(value) if value.is_null() => "strong".to_string(),
        Some(value) => js_trim(&js_string(value)).to_lowercase(),
    };
    if !ROUTING_ON_UNKNOWN.contains(&on_unknown.as_str()) {
        return RoutingOutcome::Failed(fail_with_code(
            "routing.onUnknown must be strong, weak or priority".to_string(),
            "invalid_provider_routing",
        ));
    }
    let tiering = match get(input, "tiering") {
        None => "manual".to_string(),
        Some(value) if value.is_null() || value_is_empty_string(Some(value)) => {
            "manual".to_string()
        }
        Some(value) => js_trim(&js_string(value)).to_lowercase(),
    };
    if !ROUTING_TIERINGS.contains(&tiering.as_str()) {
        return RoutingOutcome::Failed(fail_with_code(
            "routing.tiering must be manual or price".to_string(),
            "invalid_provider_routing",
        ));
    }
    let mut order: Vec<String> = Vec::new();
    if tiering == "price" {
        let hand_tagged = candidates
            .iter()
            .any(|candidate| get(candidate, "tier").is_some_and(truthy));
        let has_declared = array_length(get(input, "tiers")) > 0;
        if hand_tagged || has_declared {
            return RoutingOutcome::Failed(fail_with_code(
                "manual tiers are not used with price tiering".to_string(),
                "provider_routing_tier_mismatch",
            ));
        }
    } else {
        match tier_order_for(candidates, get(input, "tiers")) {
            Ok(ladder) => {
                if ladder.len() < 2 {
                    return RoutingOutcome::Failed(fail_with_code(
                        "routing requires at least two enabled candidate tiers".to_string(),
                        "provider_routing_requires_tiers",
                    ));
                }
                order = ladder;
            }
            Err(error) => return RoutingOutcome::Failed(error),
        }
    }
    let escalation_input = match get(input, "escalation") {
        Some(value) if truthy(value) && is_js_object(value) => value.clone(),
        _ => Value::Object(Map::new()),
    };
    let mut escalation = Map::new();
    if let Some(object) = escalation_input.as_object() {
        for (label, raw) in object {
            if !ROUTING_ESCALATION_KEYS.contains(&label.as_str()) {
                return RoutingOutcome::Failed(fail_with_code(
                    format!("routing.escalation.{label} is not a supported signal"),
                    "invalid_provider_routing",
                ));
            }
            if raw.is_null() {
                continue;
            }
            let number = js_number(raw);
            if !number.is_finite() || !(0.0..=1.0).contains(&number) {
                return RoutingOutcome::Failed(fail_with_code(
                    format!("routing.{label} must be between 0 and 1"),
                    "invalid_provider_routing",
                ));
            }
            escalation.insert(label.clone(), json!(number));
        }
    }
    let mut value = Map::new();
    value.insert("version".to_string(), json!(1));
    value.insert("provider".to_string(), Value::String(provider));
    value.insert("gateway".to_string(), Value::String(gateway.clone()));
    if !endpoint.is_empty() {
        // Absent for a preset: its endpoint is the table's, and persisting a
        // copy would let a stale one survive a table update.
        value.insert("endpoint".to_string(), Value::String(endpoint));
    }
    value.insert("model".to_string(), Value::String(model));
    value.insert("apiKeyName".to_string(), Value::String(api_key_name));
    value.insert("timeoutMs".to_string(), json!(timeout_ms as i64));
    value.insert("onUnknown".to_string(), Value::String(on_unknown));
    if tiering == "price" {
        // Only a price-tiered pool carries the key, so a manual pool's DTO stays
        // byte-identical to the one it had before tiering existed.
        value.insert("tiering".to_string(), Value::String(tiering));
    }
    value.insert(
        "tiers".to_string(),
        Value::Array(order.into_iter().map(Value::String).collect()),
    );
    value.insert("escalation".to_string(), Value::Object(escalation));
    RoutingOutcome::Value(Value::Object(value))
}

// ── candidate ──────────────────────────────────────────────────────────────

struct CandidateOutcome {
    ok: bool,
    value: Value,
    trust_domain: Option<&'static str>,
    protocol: Option<String>,
}

struct Pending {
    index: usize,
    descriptor: Value,
}

#[derive(Clone)]
struct Catalog {
    app_type: Value,
    lane: String,
    providers: Vec<Value>,
    by_id: HashMap<String, usize>,
}

struct Flags {
    usable: bool,
    has_provider_supports_cli: bool,
    has_model_valid_for_provider: bool,
}

fn flags_from(value: Option<&Value>) -> Flags {
    Flags {
        usable: value.is_some_and(|value| truthy_opt(get(value, "usable"))),
        has_provider_supports_cli: value
            .is_some_and(|value| truthy_opt(get(value, "hasProviderSupportsCli"))),
        has_model_valid_for_provider: value
            .is_some_and(|value| truthy_opt(get(value, "hasModelValidForProvider"))),
    }
}

struct Run {
    facts: Facts,
    flags: Flags,
    answers: Vec<Value>,
    probe_seq: usize,
    catalogs: HashMap<String, Option<Catalog>>,
    home_cli: Option<String>,
}

impl Run {
    fn probe(&mut self, descriptor: Value) -> Result<Value, Pending> {
        let index = self.probe_seq;
        self.probe_seq += 1;
        if let Some(answer) = self.answers.get(index) {
            Ok(answer.clone())
        } else {
            Err(Pending { index, descriptor })
        }
    }

    fn lane_catalog(&mut self, cli: Option<&str>) -> Result<Option<Catalog>, Pending> {
        if !self.flags.usable {
            return Ok(None);
        }
        let key = cli
            .filter(|text| !text.is_empty())
            .map(str::to_string)
            .or_else(|| self.home_cli.clone())
            .unwrap_or_default();
        if let Some(cached) = self.catalogs.get(&key) {
            return Ok(cached.clone());
        }
        let answer = self.probe(json!({ "kind": "catalog", "cli": key }))?;
        let catalog = catalog_from_answer(&answer, &key);
        self.catalogs.insert(key, catalog.clone());
        Ok(catalog)
    }
}

fn catalog_from_answer(answer: &Value, key: &str) -> Option<Catalog> {
    let catalog = answer.get("catalog").filter(|value| !value.is_null())?;
    let app_type = catalog.get("appType").cloned().unwrap_or(Value::Null);
    let lane = catalog
        .get("cli")
        .and_then(Value::as_str)
        .unwrap_or(key)
        .to_string();
    let providers: Vec<Value> = catalog
        .get("providers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut by_id = HashMap::new();
    for (index, provider) in providers.iter().enumerate() {
        by_id.insert(js_member_string(provider, "id"), index);
    }
    Some(Catalog {
        app_type,
        lane,
        providers,
        by_id,
    })
}

struct CandidateContext<'a> {
    protocol: Option<&'a str>,
    home_cli: Option<&'a str>,
    cross_cli: bool,
}

#[allow(clippy::too_many_arguments)]
fn candidate_value(
    provider_id: &str,
    model: &Option<String>,
    priority: i64,
    enabled: bool,
    tier: &Option<String>,
    cli: &Option<String>,
    auto_model: bool,
) -> Value {
    let mut value = Map::new();
    value.insert(
        "providerId".to_string(),
        Value::String(provider_id.to_string()),
    );
    value.insert(
        "model".to_string(),
        model.clone().map_or(Value::Null, Value::String),
    );
    value.insert("priority".to_string(), json!(priority));
    value.insert("enabled".to_string(), Value::Bool(enabled));
    if let Some(tier) = tier {
        value.insert("tier".to_string(), Value::String(tier.clone()));
    }
    if let Some(cli) = cli {
        value.insert("cli".to_string(), Value::String(cli.clone()));
    }
    if auto_model {
        value.insert("autoModel".to_string(), Value::Bool(true));
    }
    Value::Object(value)
}

fn candidate_failure(message: String) -> CandidateOutcome {
    CandidateOutcome {
        ok: false,
        value: fail_with_code(message, "invalid_provider_candidate"),
        trust_domain: None,
        protocol: None,
    }
}

fn candidate_problem(value: Value) -> CandidateOutcome {
    CandidateOutcome {
        ok: false,
        value,
        trust_domain: None,
        protocol: None,
    }
}

fn validate_candidate(
    run: &mut Run,
    raw: &Value,
    index: usize,
    context: &CandidateContext<'_>,
) -> Result<CandidateOutcome, Pending> {
    let display_index = index + 1;
    if !truthy(raw) || !is_js_object(raw) {
        return Ok(candidate_failure(format!(
            "candidate {display_index} must be an object"
        )));
    }
    let provider_id = match get(raw, "providerId") {
        Some(value) if truthy(value) => js_string(value),
        _ => String::new(),
    };
    let provider_id = js_trim(&provider_id).to_string();
    if !local_regex(PROVIDER_ID_PATTERN).is_match(&provider_id)
        || local_regex(AUTO_PROVIDER_ID_PATTERN).is_match(&provider_id)
    {
        return Ok(candidate_failure(format!(
            "candidate {display_index} has an invalid providerId"
        )));
    }
    let model = match get(raw, "model") {
        None => None,
        Some(value) if value.is_null() => None,
        Some(value) => {
            let text = js_trim(&js_string(value)).to_string();
            if text.is_empty() {
                None
            } else {
                Some(text)
            }
        }
    };
    if let Some(model) = &model {
        if !local_regex(MODEL_ID_PATTERN).is_match(model) {
            return Ok(candidate_failure(format!(
                "candidate {display_index} has an invalid model"
            )));
        }
    }
    let priority = match get(raw, "priority") {
        None => (index + 1) as f64,
        Some(value) if value.is_null() => (index + 1) as f64,
        Some(value) => js_number(value),
    };
    if !is_safe_integer(priority) || priority < 1.0 || priority > 100.0 {
        return Ok(candidate_failure(format!(
            "candidate {display_index} priority must be an integer from 1 to 100"
        )));
    }
    let tier = match get(raw, "tier") {
        None => None,
        Some(value) if value.is_null() || value_is_empty_string(Some(value)) => None,
        Some(value) => Some(js_trim(&js_string(value)).to_string()),
    };
    if let Some(tier) = &tier {
        if !local_regex(TIER_KEY_PATTERN).is_match(tier) {
            return Ok(candidate_failure(format!(
                "candidate {display_index} has an invalid tier"
            )));
        }
    }
    let enabled = !value_is(get(raw, "enabled"), &Value::Bool(false));
    let cli = match get(raw, "cli") {
        None => None,
        Some(value) if value.is_null() || value_is_empty_string(Some(value)) => None,
        Some(value) => Some(js_trim(&js_string(value)).to_string()),
    };
    if let Some(cli) = &cli {
        if !AUTO_CLIS.contains(&cli.as_str()) {
            return Ok(candidate_failure(format!(
                "candidate {display_index} has an unsupported cli"
            )));
        }
    }
    let auto_model = value_is(get(raw, "autoModel"), &Value::Bool(true));
    if auto_model && model.is_some() {
        return Ok(candidate_failure(format!(
            "candidate {display_index} cannot pin a model and pick one automatically"
        )));
    }

    // OpenCode's own providers: named, never looked up.
    if let Some(native_id) = provider_id.strip_prefix(&run.facts.native_opencode_prefix) {
        let native_id = native_id.to_string();
        if !run.facts.native_opencode_id.is_match(&native_id) {
            return Ok(candidate_failure(format!(
                "candidate {display_index} has an invalid OpenCode provider id"
            )));
        }
        let lane = cli
            .clone()
            .filter(|text| !text.is_empty())
            .or_else(|| context.home_cli.map(str::to_string));
        if lane.as_deref() != Some("opencode") {
            return Ok(candidate_failure(format!(
                "candidate {display_index} names an OpenCode native provider, which is only usable on the opencode cli"
            )));
        }
        if let Some(model) = &model {
            if !model.starts_with(&format!("{native_id}/")) {
                return Ok(candidate_failure(format!(
                    "candidate {display_index} model must start with \"{native_id}/\""
                )));
            }
        }
        return Ok(CandidateOutcome {
            ok: true,
            value: candidate_value(
                &provider_id,
                &model,
                priority as i64,
                enabled,
                &tier,
                &cli,
                auto_model,
            ),
            trust_domain: Some("user-managed"),
            protocol: None,
        });
    }

    // Vendor-native lines: one synthetic line per lane.
    if let Some((vendor_cli, vendor_id)) = native_vendor_of(&run.facts, &provider_id) {
        if !run.facts.native_vendor_id.is_match(&vendor_id) || vendor_id != vendor_cli {
            return Ok(candidate_failure(format!(
                "candidate {display_index} has an invalid vendor-native provider id"
            )));
        }
        if !run.facts.vendor_native_clis.contains(&vendor_cli) {
            return Ok(candidate_failure(format!(
                "candidate {display_index} names an unknown vendor-native lane"
            )));
        }
        let lane = cli
            .clone()
            .filter(|text| !text.is_empty())
            .or_else(|| context.home_cli.map(str::to_string));
        if lane.as_deref() != Some(vendor_cli.as_str()) {
            return Ok(candidate_failure(format!(
                "candidate {display_index} names a {vendor_cli} native line, which is only usable on the {vendor_cli} cli"
            )));
        }
        if let Some(model) = &model {
            if !run.facts.native_vendor_model.is_match(model) {
                return Ok(candidate_failure(format!(
                    "candidate {display_index} has an invalid vendor-native model"
                )));
            }
        }
        return Ok(CandidateOutcome {
            ok: true,
            value: candidate_value(
                &provider_id,
                &model,
                priority as i64,
                enabled,
                &tier,
                &cli,
                auto_model,
            ),
            trust_domain: Some("user-managed"),
            protocol: None,
        });
    }

    let mut trust_domain = None;
    let mut protocol = None;
    let catalog = if context.cross_cli {
        run.lane_catalog(cli.as_deref())?
    } else {
        run.lane_catalog(None)?
    };
    if let Some(catalog) = catalog {
        let Some(provider_index) = catalog.by_id.get(&provider_id).copied() else {
            return Ok(candidate_problem(fail_with_code(
                format!("provider {provider_id} was not found"),
                "provider_not_found",
            )));
        };
        let provider = catalog.providers[provider_index].clone();
        let lane_value = Value::String(catalog.lane.clone());
        let supports = if run.flags.has_provider_supports_cli {
            let answer = run.probe(json!({
                "kind": "supportsCli",
                "provider": provider,
                "cli": catalog.lane,
            }))?;
            truthy_opt(answer.get("value"))
        } else {
            match get(&provider, "compatibleClis") {
                Some(Value::Array(items)) => includes_value(items, &lane_value),
                _ => false,
            }
        };
        if !supports {
            return Ok(candidate_problem(fail_with_code(
                format!("provider {provider_id} does not support {}", catalog.lane),
                "provider_cli_mismatch",
            )));
        }
        protocol = protocol_of_value(&provider);
        if !context.cross_cli
            && !MULTI_PROTOCOL_CLIS.contains(&catalog.lane.as_str())
            && context.protocol.is_some()
            && protocol.as_deref() != context.protocol
        {
            return Ok(candidate_problem(fail_with_code(
                format!(
                    "provider {provider_id} does not use {}",
                    context.protocol.unwrap_or_default()
                ),
                "provider_protocol_mismatch",
            )));
        }
        if let Some(model) = &model {
            if run.flags.has_model_valid_for_provider {
                let app_type = match get(&provider, "appType") {
                    Some(value) if truthy(value) => value.clone(),
                    _ => catalog.app_type.clone(),
                };
                let answer = run.probe(json!({
                    "kind": "modelValid",
                    "appType": app_type,
                    "providerId": provider_id,
                    "model": model,
                }))?;
                if !truthy_opt(answer.get("value")) {
                    return Ok(candidate_problem(fail_with_code(
                        format!("model {model} is not available for provider {provider_id}"),
                        "provider_model_mismatch",
                    )));
                }
            }
        }
        trust_domain = Some(trust_domain_of_value(&provider));
    }
    Ok(CandidateOutcome {
        ok: true,
        value: candidate_value(
            &provider_id,
            &model,
            priority as i64,
            enabled,
            &tier,
            &cli,
            auto_model,
        ),
        trust_domain,
        protocol,
    })
}

fn native_vendor_of(facts: &Facts, value: &str) -> Option<(String, String)> {
    let at = value.find(&facts.native_vendor_suffix)?;
    if at == 0 {
        return None;
    }
    let cli = &value[..at];
    if !facts.vendor_native_clis.contains(cli) {
        return None;
    }
    Some((
        cli.to_string(),
        value[at + facts.native_vendor_suffix.len()..].to_string(),
    ))
}

// ── selection validation ────────────────────────────────────────────────────

fn ok_selection(value: Value) -> Value {
    let mut object = Map::new();
    object.insert("ok".to_string(), Value::Bool(true));
    object.insert("value".to_string(), value);
    object.insert("error".to_string(), Value::Null);
    object.insert("code".to_string(), Value::Null);
    Value::Object(object)
}

fn selected_protocol(declared: &str, derived: Option<String>) -> String {
    if !declared.is_empty() {
        declared.to_string()
    } else {
        derived.unwrap_or_else(|| "anthropic".to_string())
    }
}

// Cosmetic provenance for the run-config pill: which local preset the user
// saved this pool from. It stays outside the routing policy — a malformed
// value is ignored instead of rejecting an otherwise valid pool, so records
// written by older or newer peers keep validating.
fn preset_provenance(input: &Value) -> Option<String> {
    let Some(Value::String(text)) = get(input, "presetId") else {
        return None;
    };
    let text = js_trim(text);
    if text.is_empty() || text.chars().count() > MAX_PRESET_ID {
        return None;
    }
    Some(text.to_string())
}

fn run_selection(
    facts: Facts,
    input: Value,
    options: Option<&Value>,
    flags: Flags,
    answers: Vec<Value>,
) -> Result<Value, Pending> {
    if input.is_null() || value_is_empty_string(Some(&input)) {
        return Ok(ok_null());
    }
    if truthy(&input) && value_is(get(&input, "mode"), &Value::String("manual".to_string())) {
        return Ok(ok_null());
    }
    if !truthy(&input)
        || !is_js_object(&input)
        || !value_is(get(&input, "mode"), &Value::String("auto".to_string()))
    {
        return Ok(fail(
            "providerSelection must be null/manual or an Auto Provider object".to_string(),
        ));
    }
    if let Some(version) = get(&input, "version") {
        if !version.is_null() && !value_is(Some(version), &json!(1)) {
            return Ok(fail("unsupported providerSelection version".to_string()));
        }
    }
    let declared_protocol = js_trim(&js_string_or_empty(get(&input, "protocol"))).to_string();
    if !declared_protocol.is_empty() && !PROTOCOLS.contains(&declared_protocol.as_str()) {
        return Ok(fail_with_code(
            "invalid Auto Provider protocol".to_string(),
            "invalid_provider_protocol",
        ));
    }
    let candidates_value = get(&input, "candidates");
    let candidates_len = array_length(candidates_value);
    if candidates_value.is_none_or(|value| !value.is_array())
        || !(2..=MAX_CANDIDATES).contains(&candidates_len)
    {
        return Ok(fail_with_code(
            format!("Auto Provider requires 2-{MAX_CANDIDATES} candidates"),
            "invalid_provider_candidates",
        ));
    }
    let candidates_input = candidates_value
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let allow_cross_trust = value_is(get(&input, "allowCrossTrust"), &Value::Bool(true));
    let cross_cli = candidates_input.iter().any(|raw| {
        truthy(raw)
            && is_js_object(raw)
            && get(raw, "cli")
                .is_some_and(|cli| !cli.is_null() && !value_is_empty_string(Some(cli)))
    });
    let home_cli = match options.and_then(|options| get(options, "cli")) {
        Some(value) if truthy(value) => Some(js_string(value)),
        _ => None,
    };
    let mut run = Run {
        facts,
        flags,
        answers,
        probe_seq: 0,
        catalogs: HashMap::new(),
        home_cli: home_cli.clone(),
    };
    // A single-lane pool resolves its catalog once, before the first candidate
    // is looked at — even if that candidate is rejected before the lookup.
    if !cross_cli {
        run.lane_catalog(None)?;
    }
    let mut candidates: Vec<Value> = Vec::with_capacity(candidates_len);
    let mut ids: Vec<String> = Vec::new();
    let mut trust_domains: HashSet<&'static str> = HashSet::new();
    let mut lane_protocols: HashMap<String, String> = HashMap::new();
    let mut pool_protocols: Vec<String> = Vec::new();
    let mut derived_protocol: Option<String> = None;
    for (index, raw) in candidates_input.iter().enumerate() {
        let display_index = index + 1;
        let mut raw = raw.clone();
        if cross_cli && truthy(&raw) && is_js_object(&raw) {
            let cli_missing = match get(&raw, "cli") {
                None => true,
                Some(value) => value.is_null() || value_is_empty_string(Some(value)),
            };
            if cli_missing {
                let usable_home = home_cli
                    .as_deref()
                    .filter(|text| AUTO_CLIS.contains(text))
                    .map(str::to_string);
                let Some(usable_home) = usable_home else {
                    return Ok(fail_with_code(
                        format!("candidate {display_index} must name its cli in a cross-CLI pool"),
                        "invalid_provider_candidate",
                    ));
                };
                if let Some(object) = raw.as_object_mut() {
                    object.insert("cli".to_string(), Value::String(usable_home));
                }
            }
        }
        let context = CandidateContext {
            protocol: if declared_protocol.is_empty() {
                None
            } else {
                Some(declared_protocol.as_str())
            },
            home_cli: home_cli.as_deref(),
            cross_cli,
        };
        let outcome = validate_candidate(&mut run, &raw, index, &context)?;
        if !outcome.ok {
            return Ok(outcome.value);
        }
        if declared_protocol.is_empty()
            && derived_protocol.is_none()
            && truthy_opt(get(&outcome.value, "enabled"))
            && outcome.protocol.is_some()
        {
            derived_protocol = outcome.protocol.clone();
        }
        let candidate_cli = match get(&outcome.value, "cli") {
            Some(Value::String(text)) => Some(text.clone()),
            _ => None,
        };
        let provider_id = js_string(get(&outcome.value, "providerId").unwrap_or(&Value::Null));
        let key = format!(
            "{}\n{}",
            candidate_cli.clone().unwrap_or_default(),
            provider_id
        );
        if ids.contains(&key) {
            return Ok(fail_with_code(
                format!("provider {provider_id} appears more than once"),
                "duplicate_provider_candidate",
            ));
        }
        ids.push(key);
        if let Some(protocol) = outcome.protocol.clone() {
            if !pool_protocols.contains(&protocol) {
                pool_protocols.push(protocol.clone());
            }
            let lane = candidate_cli
                .clone()
                .filter(|text| !text.is_empty())
                .or_else(|| home_cli.clone());
            let is_multi = lane
                .as_deref()
                .is_some_and(|text| MULTI_PROTOCOL_CLIS.contains(&text));
            let lane_key = lane.clone().unwrap_or_default();
            if !is_multi {
                if let Some(previous) = lane_protocols.get(&lane_key) {
                    if previous != &protocol {
                        return Ok(fail_with_code(
                            format!(
                                "candidates on {} mix protocols",
                                lane_label(lane.as_deref())
                            ),
                            "provider_protocol_mismatch",
                        ));
                    }
                }
            }
            lane_protocols.insert(lane_key, protocol);
        }
        let is_enabled = truthy_opt(get(&outcome.value, "enabled"));
        candidates.push(outcome.value);
        if is_enabled {
            if let Some(trust_domain) = outcome.trust_domain {
                trust_domains.insert(trust_domain);
            }
        }
    }
    let protocol = selected_protocol(&declared_protocol, derived_protocol);
    if !pool_protocols.is_empty() && !pool_protocols.contains(&protocol) {
        return Ok(fail_with_code(
            format!("no candidate uses {protocol}"),
            "provider_protocol_mismatch",
        ));
    }
    let cli_switch = match get(&input, "cliSwitch") {
        None => "failover".to_string(),
        Some(value) if value.is_null() || value_is_empty_string(Some(value)) => {
            "failover".to_string()
        }
        Some(value) => js_trim(&js_string(value)).to_lowercase(),
    };
    if !CLI_SWITCH_POLICIES.contains(&cli_switch.as_str()) {
        return Ok(fail("cliSwitch must be failover or routing".to_string()));
    }
    let enabled_count = candidates
        .iter()
        .filter(|candidate| truthy_opt(get(candidate, "enabled")))
        .count();
    if enabled_count < 2 {
        return Ok(fail_with_code(
            "Auto Provider requires at least two enabled candidates".to_string(),
            "insufficient_provider_candidates",
        ));
    }
    if trust_domains.len() > 1 && !allow_cross_trust {
        return Ok(fail_with_code(
            "Auto Provider candidates cross trust domains".to_string(),
            "provider_trust_mismatch",
        ));
    }
    let max_attempts_cap = std::cmp::min(MAX_ATTEMPTS, enabled_count);
    let max_attempts = match get(&input, "maxAttempts") {
        None => std::cmp::min(3, enabled_count) as f64,
        Some(value) if value.is_null() => std::cmp::min(3, enabled_count) as f64,
        Some(value) => js_number(value),
    };
    if !is_safe_integer(max_attempts)
        || max_attempts < 2.0
        || max_attempts > max_attempts_cap as f64
    {
        return Ok(fail_with_code(
            format!("maxAttempts must be between 2 and {max_attempts_cap}"),
            "invalid_provider_attempt_budget",
        ));
    }
    let routing = validate_routing(&run.facts, get(&input, "routing"), &candidates);
    let routing_value = match routing {
        RoutingOutcome::Failed(error) => return Ok(error),
        RoutingOutcome::Absent => None,
        RoutingOutcome::Value(value) => Some(value),
    };
    let has_auto_model = candidates
        .iter()
        .any(|candidate| truthy_opt(get(candidate, "autoModel")));
    if has_auto_model && routing_value.is_none() {
        return Ok(fail_with_code(
            "automatic model selection requires routing".to_string(),
            "provider_auto_model_requires_routing",
        ));
    }
    let mut value = Map::new();
    value.insert("version".to_string(), json!(1));
    value.insert("mode".to_string(), Value::String("auto".to_string()));
    value.insert("protocol".to_string(), Value::String(protocol));
    value.insert("candidates".to_string(), Value::Array(candidates));
    value.insert("maxAttempts".to_string(), json!(max_attempts as i64));
    value.insert(
        "sticky".to_string(),
        Value::Bool(!value_is(get(&input, "sticky"), &Value::Bool(false))),
    );
    // Quota-first steering, default on: a line with under a fifth of its
    // quota left yields to a roomier one (see auto_provider_policy.rs
    // `by_quota`). Default-true means an existing pool gains the behaviour
    // without a migration; the checkbox exists precisely so it can be turned
    // back off per pool.
    value.insert(
        "preferMaxQuota".to_string(),
        Value::Bool(!value_is(
            get(&input, "preferMaxQuota"),
            &Value::Bool(false),
        )),
    );
    value.insert(
        "allowCrossTrust".to_string(),
        Value::Bool(allow_cross_trust),
    );
    if let Some(preset_id) = preset_provenance(&input) {
        value.insert("presetId".to_string(), Value::String(preset_id));
    }
    if cross_cli {
        value.insert("cliSwitch".to_string(), Value::String(cli_switch));
    }
    if let Some(routing) = routing_value {
        value.insert("routing".to_string(), routing);
    }
    Ok(ok_selection(Value::Object(value)))
}

fn lane_label(lane: Option<&str>) -> String {
    lane.map_or_else(|| "null".to_string(), str::to_string)
}

pub fn validate_provider_selection(request: &str) -> Result<String, String> {
    let value: Value = crate::json_lenient::from_str(request).map_err(|error| error.to_string())?;
    let facts = require_facts(&value)?;
    let input = value.get("input").cloned().unwrap_or(Value::Null);
    let options = value.get("options").cloned();
    let flags = flags_from(value.get("providers"));
    let answers = value
        .get("answers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    match run_selection(facts, input, options.as_ref(), flags, answers) {
        Ok(result) => {
            serde_json::to_string(&json!({ "result": result })).map_err(|error| error.to_string())
        }
        Err(pending) => {
            let mut probe = Map::new();
            probe.insert("index".to_string(), json!(pending.index));
            if let Value::Object(descriptor) = pending.descriptor {
                for (key, value) in descriptor {
                    probe.insert(key, value);
                }
            }
            serde_json::to_string(&json!({ "probe": probe })).map_err(|error| error.to_string())
        }
    }
}

// ── stored selection helpers ────────────────────────────────────────────────

fn normalize_value(input: &Value, facts: Facts) -> Result<Option<Value>, Pending> {
    let result = run_selection(
        facts,
        input.clone(),
        None,
        Flags {
            usable: false,
            has_provider_supports_cli: false,
            has_model_valid_for_provider: false,
        },
        Vec::new(),
    )?;
    if truthy_opt(get(&result, "ok")) {
        Ok(get(&result, "value").cloned())
    } else {
        Ok(None)
    }
}

fn normalize_request(request: &str) -> Result<Option<Value>, String> {
    let value: Value = crate::json_lenient::from_str(request).map_err(|error| error.to_string())?;
    let facts = require_facts(&value)?;
    let input = value.get("input").cloned().unwrap_or(Value::Null);
    normalize_value(&input, facts).map_err(|_| "unexpected callback probe".to_string())
}

pub fn normalize_stored_provider_selection(request: &str) -> Result<String, String> {
    match normalize_request(request)? {
        Some(selection) => serde_json::to_string(&selection).map_err(|error| error.to_string()),
        None => Ok("null".to_string()),
    }
}

pub fn provider_selection_dto(request: &str) -> Result<String, String> {
    match normalize_request(request)? {
        Some(selection) => serde_json::to_string(&selection).map_err(|error| error.to_string()),
        None => Ok("null".to_string()),
    }
}

fn priority_less_than(left: Option<&Value>, right: Option<&Value>) -> bool {
    // `candidate.priority < primary.priority` — an absent value is `undefined`
    // (NaN in a comparison, so never less), while a stored `null` is 0.
    let Some(left) = left else {
        return false;
    };
    let Some(right) = right else {
        return false;
    };
    let (a, b) = (js_number(left), js_number(right));
    if a.is_nan() || b.is_nan() {
        false
    } else {
        a < b
    }
}

pub fn primary_provider_candidate(request: &str) -> Result<String, String> {
    let value: Value = crate::json_lenient::from_str(request).map_err(|error| error.to_string())?;
    let selection = value.get("selection").cloned().unwrap_or(Value::Null);
    let cli = value.get("cli").cloned().unwrap_or(Value::Null);
    let candidates = get(&selection, "candidates")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut primary: Option<usize> = None;
    for (index, candidate) in candidates.iter().enumerate() {
        if !truthy(candidate) || value_is(get(candidate, "enabled"), &Value::Bool(false)) {
            continue;
        }
        let candidate_cli = get(candidate, "cli");
        if truthy(&cli) && truthy_opt(candidate_cli) && !json_equal(candidate_cli.unwrap(), &cli) {
            continue;
        }
        let replace = match primary {
            None => true,
            Some(current) => priority_less_than(
                get(candidate, "priority"),
                get(&candidates[current], "priority"),
            ),
        };
        if replace {
            primary = Some(index);
        }
    }
    let result = match primary {
        Some(index) => json!(index),
        None => Value::Null,
    };
    serde_json::to_string(&json!({ "index": result })).map_err(|error| error.to_string())
}

pub fn selection_clis(request: &str) -> Result<String, String> {
    let value: Value = crate::json_lenient::from_str(request).map_err(|error| error.to_string())?;
    let selection = value.get("selection").cloned().unwrap_or(Value::Null);
    let candidates = get(&selection, "candidates")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut out: Vec<Value> = Vec::new();
    for candidate in &candidates {
        if !truthy(candidate) {
            continue;
        }
        let Some(cli) = get(candidate, "cli") else {
            continue;
        };
        if !truthy(cli) {
            continue;
        }
        if !includes_value(&out, cli) {
            out.push(cli.clone());
        }
    }
    serde_json::to_string(&Value::Array(out)).map_err(|error| error.to_string())
}

/// The `appType` list a catalog read should ask `listProviders` for.
/// `appTypes` is the raw result of `appTypesForCli`; `hasAppTypesForCli` says
/// whether that callback exists at all.
pub fn catalog_app_types(request: &str) -> Result<String, String> {
    let value: Value = crate::json_lenient::from_str(request).map_err(|error| error.to_string())?;
    let cli = js_string(get(&value, "cli").unwrap_or(&Value::Null));
    let app_type = get(&value, "appType").cloned().unwrap_or(Value::Null);
    let has_app_types_for_cli = value.get("hasAppTypesForCli").is_some_and(truthy);
    let resolved = if has_app_types_for_cli {
        value.get("appTypes").cloned().unwrap_or(Value::Null)
    } else if cli == "opencode" || cli == "zcode" {
        Value::Array(vec![
            Value::String("claude".to_string()),
            Value::String("codex".to_string()),
        ])
    } else if truthy(&app_type) {
        Value::Array(vec![app_type])
    } else {
        Value::Array(Vec::new())
    };
    let list = match resolved {
        Value::Array(items) => {
            let mut deduped: Vec<Value> = Vec::new();
            for item in items {
                if !includes_value(&deduped, &item) {
                    deduped.push(item);
                }
            }
            deduped
        }
        _ => Vec::new(),
    };
    serde_json::to_string(&json!({ "list": list })).map_err(|error| error.to_string())
}

// ── tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_facts() -> Value {
        json!({
            "gateways": [
                {
                    "name": "vercel",
                    "endpoint": "https://ai-gateway.vercel.sh/v1/evaluate",
                    "model": "typesafe-ai/jev",
                    "apiKeyName": "VERCEL_API_KEY"
                },
                {
                    "name": "openrouter",
                    "endpoint": "https://openrouter.ai/api/alpha/decisions",
                    "model": "~typesafe/jev-latest",
                    "apiKeyName": "OPENROUTER_API_KEY"
                },
                {
                    "name": "typesafe",
                    "endpoint": "https://api.typesafe.ai/v1/systemone",
                    "model": "jev-latest",
                    "apiKeyName": "TYPESAFE_API_KEY"
                }
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

    #[test]
    fn keeps_preset_provenance_and_ignores_unusable_values() {
        let facts = sample_facts();
        let base = json!({
            "version": 1,
            "mode": "auto",
            "protocol": "anthropic",
            "presetId": "  p1abc  ",
            "candidates": [
                { "providerId": "codebuddy-native:codebuddy", "cli": "codebuddy", "model": "deepseek-v4.1-flash" },
                { "providerId": "qoder-native:qoder", "cli": "qoder", "model": "auto" },
            ],
        });
        let request = json!({ "facts": facts.clone(), "input": base });
        let out: Value = serde_json::from_str(
            &normalize_stored_provider_selection(&request.to_string()).unwrap(),
        )
        .unwrap();
        assert_eq!(out["presetId"], json!("p1abc"));

        // Anything but a short string is simply not echoed back; the pool stays valid.
        for garbage in [json!(7), json!("   "), json!("x".repeat(MAX_PRESET_ID + 1))] {
            let mut input = base.clone();
            input["presetId"] = garbage;
            let request = json!({ "facts": facts.clone(), "input": input });
            let out: Value = serde_json::from_str(
                &normalize_stored_provider_selection(&request.to_string()).unwrap(),
            )
            .unwrap();
            assert!(out.get("presetId").is_none(), "unexpected presetId: {out}");
            assert_eq!(out["candidates"].as_array().unwrap().len(), 2);
        }
    }

    #[test]
    fn snapshot_matches_the_exported_contract() {
        let snapshot: Value =
            serde_json::from_str(&facts(&sample_facts().to_string()).unwrap()).unwrap();
        assert_eq!(
            snapshot["protocols"],
            json!(["anthropic", "openai_responses"])
        );
        assert_eq!(
            snapshot["routingGateways"],
            json!(["vercel", "openrouter", "typesafe", "custom"])
        );
        assert_eq!(snapshot["defaultRoutingApiKey"], json!("VERCEL_API_KEY"));
        assert_eq!(snapshot["maxRoutingEndpointChars"], json!(300));
        assert_eq!(snapshot["maxTiers"], json!(6));
    }

    #[test]
    fn lone_surrogate_requests_reach_validation_not_a_parse_error() {
        // JSON.stringify on the JS side emits "\ud834" for a sliced surrogate;
        // the old JS implementation passed that text through to the rules, so
        // parsing must be lenient and surface U+FFFD, not reject the request.
        let facts = serde_json::to_string(&sample_facts()).unwrap();
        let request = format!(r#"{{"facts":{facts},"endpoint":"x\ud834"}}"#);
        assert_eq!(
            custom_endpoint_error(&request).unwrap(),
            serde_json::to_string("routing.endpoint must be a URL").unwrap()
        );
        let request = r#"{"selection":{"candidates":[{"cli":"\ud834"}]}}"#;
        assert_eq!(
            selection_clis(request).unwrap(),
            serde_json::to_string(&json!(["\u{fffd}"])).unwrap()
        );
    }

    #[test]
    fn javascript_string_number_and_trim_semantics() {
        assert_eq!(js_string(&json!([1, null, "a"])), "1,,a");
        assert_eq!(js_string(&json!({"a": 1})), "[object Object]");
        assert_eq!(js_string(&json!(-0.0)), "0");
        assert_eq!(js_number(&json!("0x10")), 16.0);
        assert!(js_number(&json!("0x10x")).is_nan());
        assert!(js_number(&json!("inf")).is_nan());
        assert_eq!(js_number(&json!(["7"])), 7.0);
        assert!(js_number(&json!([1, 2])).is_nan());
        assert_eq!(js_trim("\u{feff} a \u{3000}"), "a");
        assert_eq!(utf16_len("😀"), 2);
        assert!(!truthy(&json!(0)));
        assert!(truthy(&json!([0])));
        assert!(!truthy(&json!({"__jsnum__": "NaN"})));
    }

    #[test]
    fn endpoint_rules_use_whatwg_urls() {
        let facts = Facts::from_value(&sample_facts()).unwrap();
        let check = |endpoint: &str| {
            custom_endpoint_error_value(&facts, &Value::String(endpoint.to_string()))
        };
        assert_eq!(check("https://jev.example/v1"), None);
        assert_eq!(check("http://127.0.0.1:8080/e"), None);
        assert_eq!(check("http://localhost/e"), None);
        assert_eq!(check("http://[::1]/e"), None);
        assert_eq!(
            check("http://jev.example/e").as_deref(),
            Some("routing.endpoint must use https (http only for a loopback host)")
        );
        assert_eq!(
            check("jev.example/v1").as_deref(),
            Some("routing.endpoint must be a URL")
        );
        assert_eq!(
            check("").as_deref(),
            Some("routing.endpoint is required for the custom gateway")
        );
        let long = format!("https://x.example/{}", "y".repeat(400));
        assert!(check(&long).unwrap().contains("at most 300"));
    }

    #[test]
    fn recorded_vectors_match() {
        // Recorded from the JavaScript implementation this module replaced
        // (its tests plus hand-made edge cases), so the port stays byte-equal.
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/auto_provider_config_vectors.json"
        );
        let text =
            std::fs::read_to_string(path).unwrap_or_else(|error| panic!("read {path}: {error}"));
        let document: Value = serde_json::from_str(&text).unwrap();
        let facts = document["facts"].clone();
        let vectors = document["vectors"].as_array().unwrap();
        let mut passed = 0usize;
        let mut skipped = 0usize;
        for vector in vectors {
            let kind = vector["kind"].as_str().unwrap();
            if vector.get("threw").is_some_and(|value| !value.is_null()) {
                skipped += 1;
                continue;
            }
            match kind {
                "validateProviderSelection" => run_validation_vector(&facts, vector),
                "protocolOf" => {
                    let request = json!({"facts": facts, "provider": vector["input"].clone()});
                    let actual = protocol_of(&request.to_string()).unwrap();
                    assert_same_json(&actual, &vector["expected"], kind);
                }
                "trustDomainOf" => {
                    let request = json!({"facts": facts, "provider": vector["input"].clone()});
                    let actual = trust_domain_of(&request.to_string()).unwrap();
                    assert_same_json(&actual, &vector["expected"], kind);
                }
                "customEndpointError" => {
                    let request = json!({"facts": facts, "endpoint": vector["input"].clone()});
                    let actual = custom_endpoint_error(&request.to_string()).unwrap();
                    assert_same_json(&actual, &vector["expected"], kind);
                }
                "validateRoutingTarget" => {
                    let request = json!({"facts": facts, "input": vector["input"].clone()});
                    let actual = validate_routing_target(&request.to_string()).unwrap();
                    assert_same_json(&actual, &vector["expected"], kind);
                }
                "jevTarget" => {
                    let request = json!({"facts": facts, "routing": vector["input"].clone()});
                    let actual = jev_target(&request.to_string()).unwrap();
                    assert_same_json(&actual, &vector["expected"], kind);
                }
                "normalizeStoredProviderSelection" => {
                    let request = json!({"facts": facts, "input": vector["input"].clone()});
                    let actual = normalize_stored_provider_selection(&request.to_string()).unwrap();
                    assert_same_json(&actual, &vector["expected"], kind);
                }
                "providerSelectionDto" => {
                    let request = json!({"facts": facts, "input": vector["input"].clone()});
                    let actual = provider_selection_dto(&request.to_string()).unwrap();
                    assert_same_json(&actual, &vector["expected"], kind);
                }
                "primaryProviderCandidate" => {
                    let request = json!({
                        "facts": facts,
                        "selection": vector["input"].clone(),
                        "cli": vector.get("cli").cloned().unwrap_or(Value::Null),
                    });
                    let actual = primary_provider_candidate(&request.to_string()).unwrap();
                    let expected = vector["expected"].clone();
                    let expected_index = match expected {
                        Value::Null => Value::Null,
                        other => {
                            let selection = vector["input"].clone();
                            let candidates = get(&selection, "candidates")
                                .and_then(Value::as_array)
                                .cloned()
                                .unwrap_or_default();
                            let position = candidates
                                .iter()
                                .position(|item| json_equal(item, &other))
                                .expect("recorded candidate present");
                            json!(position)
                        }
                    };
                    assert_same_json(&actual, &json!({ "index": expected_index }), kind);
                }
                "selectionClis" => {
                    let request = json!({"facts": facts, "selection": vector["input"].clone()});
                    let actual = selection_clis(&request.to_string()).unwrap();
                    assert_same_json(&actual, &vector["expected"], kind);
                }
                "catalogFor" => run_catalog_vector(&facts, vector),
                other => panic!("unknown vector kind {other}"),
            }
            passed += 1;
        }
        assert!(passed > 0, "no vectors");
        eprintln!("vectors passed={passed} skipped={skipped}");
    }

    fn run_validation_vector(facts: &Value, vector: &Value) {
        let calls = vector["calls"].as_array().cloned().unwrap_or_default();
        let mut cursor = 0usize;
        let mut answers: Vec<Value> = Vec::new();
        loop {
            let request = json!({
                "facts": facts,
                "input": vector.get("input").cloned().unwrap_or(Value::Null),
                "options": vector.get("options").cloned().unwrap_or_else(|| json!({})),
                "providers": vector.get("providers").cloned().unwrap_or(Value::Null),
                "answers": answers,
            });
            let reply: Value =
                serde_json::from_str(&validate_provider_selection(&request.to_string()).unwrap())
                    .unwrap();
            if let Some(probe) = reply.get("probe") {
                let index = probe["index"].as_u64().unwrap() as usize;
                assert_eq!(index, answers.len(), "probe index must be sequential");
                let answer = vector_answer(facts, probe, &calls, &mut cursor);
                answers.push(answer);
                continue;
            }
            assert_same_json(
                &serde_json::to_string(&reply["result"]).unwrap(),
                &vector["expected"],
                "validateProviderSelection",
            );
            break;
        }
        assert_eq!(
            cursor,
            calls.len(),
            "every recorded callback must be replayed"
        );
    }

    fn vector_answer(facts: &Value, probe: &Value, calls: &[Value], cursor: &mut usize) -> Value {
        let _ = facts;
        match probe["kind"].as_str().unwrap() {
            "catalog" => {
                let lane = probe["cli"].as_str().unwrap_or_default().to_string();
                let start = *cursor;
                assert_eq!(
                    calls[start]["kind"].as_str(),
                    Some("appTypeForCli"),
                    "catalog probe must follow an appTypeForCli call"
                );
                assert_eq!(calls[start]["cli"].as_str(), Some(lane.as_str()));
                let app_type = calls[start].get("result").cloned().unwrap_or(Value::Null);
                *cursor += 1;
                let mut has_app_types = false;
                let mut app_types = Value::Null;
                if calls.get(*cursor).and_then(|call| call["kind"].as_str())
                    == Some("appTypesForCli")
                {
                    has_app_types = true;
                    app_types = calls[*cursor].get("result").cloned().unwrap_or(Value::Null);
                    *cursor += 1;
                }
                let mut list_calls: Vec<Value> = Vec::new();
                while calls.get(*cursor).and_then(|call| call["kind"].as_str())
                    == Some("listProviders")
                {
                    list_calls.push(calls[*cursor]["result"].clone());
                    *cursor += 1;
                }
                let plan_request = json!({
                    "cli": lane,
                    "appType": app_type,
                    "appTypes": app_types,
                    "hasAppTypesForCli": has_app_types,
                });
                let plan: Value =
                    serde_json::from_str(&catalog_app_types(&plan_request.to_string()).unwrap())
                        .unwrap();
                let app_types_used = plan["list"].as_array().is_some_and(|list| !list.is_empty());
                let flat: Vec<Value> = if app_types_used {
                    let mut flat = Vec::new();
                    for result in list_calls {
                        match result {
                            Value::Array(items) => flat.extend(items),
                            other => flat.push(other),
                        }
                    }
                    flat
                } else {
                    list_calls
                        .into_iter()
                        .next()
                        .and_then(|result| result.as_array().cloned())
                        .unwrap_or_default()
                };
                let providers: Vec<Value> = flat.iter().map(project_provider).collect();
                json!({
                    "catalog": {
                        "appType": app_type,
                        "cli": lane,
                        "providers": providers,
                    }
                })
            }
            "supportsCli" => {
                assert_eq!(
                    calls[*cursor]["kind"].as_str(),
                    Some("providerSupportsCli"),
                    "supports probe must follow a providerSupportsCli call"
                );
                assert_eq!(calls[*cursor]["cli"], probe["cli"]);
                let value = calls[*cursor].get("result").cloned().unwrap_or(Value::Null);
                *cursor += 1;
                json!({ "value": value })
            }
            "modelValid" => {
                assert_eq!(
                    calls[*cursor]["kind"].as_str(),
                    Some("modelValidForProvider"),
                    "model probe must follow a modelValidForProvider call"
                );
                assert_eq!(calls[*cursor]["providerId"], probe["providerId"]);
                assert_eq!(calls[*cursor]["model"], probe["model"]);
                let value = calls[*cursor].get("result").cloned().unwrap_or(Value::Null);
                *cursor += 1;
                json!({ "value": value })
            }
            other => panic!("unknown probe kind {other}"),
        }
    }

    fn project_provider(item: &Value) -> Value {
        let mut object = Map::new();
        for key in [
            "id",
            "protocol",
            "apiFormat",
            "isOfficial",
            "appType",
            "compatibleClis",
        ] {
            if let Some(value) = item.as_object().and_then(|object| object.get(key)) {
                object.insert(key.to_string(), value.clone());
            }
        }
        Value::Object(object)
    }

    fn run_catalog_vector(facts: &Value, vector: &Value) {
        let _ = facts;
        let expected = &vector["expected"];
        if expected.is_null() {
            return;
        }
        let calls = vector["calls"].as_array().cloned().unwrap_or_default();
        let cli = vector["cli"].clone();
        let app_type = vector.get("appType").cloned().unwrap_or(Value::Null);
        let app_types = vector.get("appTypes").cloned().unwrap_or(Value::Null);
        let has_app_types = vector.get("hasAppTypesForCli").is_some_and(truthy);
        let plan_request = json!({
            "cli": cli,
            "appType": app_type,
            "appTypes": app_types,
            "hasAppTypesForCli": has_app_types,
        });
        let plan: Value =
            serde_json::from_str(&catalog_app_types(&plan_request.to_string()).unwrap()).unwrap();
        let app_types_used = plan["list"].as_array().is_some_and(|list| !list.is_empty());
        let list_results: Vec<Value> = calls
            .iter()
            .filter(|call| call["kind"].as_str() == Some("listProviders"))
            .map(|call| call["result"].clone())
            .collect();
        let flat: Vec<Value> = if app_types_used {
            let mut flat = Vec::new();
            for result in list_results {
                match result {
                    Value::Array(items) => flat.extend(items),
                    other => flat.push(other),
                }
            }
            flat
        } else {
            list_results
                .into_iter()
                .next()
                .and_then(|result| result.as_array().cloned())
                .unwrap_or_default()
        };
        let mut keys: Vec<String> = Vec::new();
        for item in &flat {
            let key = js_member_string(item, "id");
            if !keys.contains(&key) {
                keys.push(key);
            }
        }
        assert_eq!(json!(keys), expected["byIdKeys"], "catalogFor keys");
    }

    fn assert_same_json(actual: &str, expected: &Value, label: &str) {
        let actual: Value =
            serde_json::from_str(actual).unwrap_or_else(|error| panic!("{label}: {error}"));
        let expected: Value = expected.clone();
        assert!(
            json_equal(&actual, &expected),
            "{label}: value mismatch\nactual={actual}\nexpected={expected}"
        );
        assert!(
            keys_match(&actual, &expected),
            "{label}: key order mismatch\nactual={actual}\nexpected={expected}"
        );
    }

    fn keys_match(actual: &Value, expected: &Value) -> bool {
        match (actual, expected) {
            (Value::Object(a), Value::Object(b)) => {
                let a_keys: Vec<&String> = a.keys().collect();
                let b_keys: Vec<&String> = b.keys().collect();
                a_keys == b_keys
                    && a.iter().all(|(key, value)| {
                        b.get(key).is_some_and(|other| keys_match(value, other))
                    })
            }
            (Value::Array(a), Value::Array(b)) => {
                a.len() == b.len()
                    && a.iter()
                        .zip(b.iter())
                        .all(|(left, right)| keys_match(left, right))
            }
            _ => true,
        }
    }
}
