//! Host boundary for `multicc_core::api_error_policy`.
//!
//! The policy itself is pure; this module supplies the three things only the
//! host can: the lossless read of the caller's values, `Date.parse` (an
//! engine-defined parser the JS side owned) and the lazily-called random
//! source. Everything it computes is written back with the same lossless
//! bridge, so `undefined` vs `null`, lone surrogates and `-0` survive.
//!
//! Read cost: `normalizeApiError` / `decideApiErrorPolicy` are not hot paths
//! (once per failed request), so the arguments are read eagerly through
//! [`crate::js_bridge`] instead of being probed lazily. The shapes that read
//! cannot see are restored by [`enrich`]: an `Error` instance keeps
//! `message`/`code` on the prototype, and a `Headers`-like receiver answers
//! only through its `get` method.
use crate::js_live::LiveValue;
use multicc_core::{
    api_error_policy::{self, NormalizeDeps},
    js::{js_to_number, js_to_string, JsString, JsValue},
};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;

fn read(env: &Env, value: LiveValue<'_>) -> Result<JsValue> {
    unsafe { crate::js_bridge::read_value(env.raw(), value.raw(), 0, &mut Vec::new()) }
}

fn write(env: &Env, value: &JsValue) -> Result<sys::napi_value> {
    unsafe { crate::js_bridge::write_value(env.raw(), value) }
}

/// Header names the policy ever asks for (`headerValue`).
const HEADER_NAMES: [&str; 4] = [
    "retry-after",
    "x-ratelimit-reset",
    "ratelimit-reset",
    "x-request-id",
];

/// `headerValue` supports a `Headers`-like receiver through its `get` method,
/// which the eager read cannot see (functions are skipped). Snapshot the four
/// names it can ask for; a plain object is read as-is. An empty snapshot still
/// replaces the plain entries, because `headerValue` never consults them once
/// `get` exists.
fn header_snapshot(env: &Env, headers: LiveValue<'_>) -> Result<Option<JsValue>> {
    let get = match headers.get(c"get") {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    if get.kind()? != sys::ValueType::napi_function {
        return Ok(None);
    }
    let mut entries: Vec<(JsString, JsValue)> = Vec::new();
    for name in HEADER_NAMES {
        let key = headers.from_value(&JsValue::String(JsString::from_rust_str(name)))?;
        let value = match get.call(headers, &[key]) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if value.nullish()? {
            continue;
        }
        entries.push((JsString::from_rust_str(name), read(env, value)?));
    }
    Ok(Some(JsValue::Object(entries)))
}

fn set_entry(entries: &mut Vec<(JsString, JsValue)>, name: &str, value: JsValue) {
    if let Some(entry) = entries.iter_mut().find(|(existing, _)| existing == name) {
        entry.1 = value;
    } else {
        entries.push((JsString::from_rust_str(name), value));
    }
}

/// `message`, `code` and a `Headers`-like `headers` are property lookups the
/// eager bridge either skips (functions) or cannot see (a prototype); copy them
/// in so the policy reads what the JS implementation read. Recurses into
/// `error`, which the policy also inspects.
fn enrich(env: &Env, live: LiveValue<'_>, parsed: &mut JsValue) -> Result<()> {
    if live.nullish()? || live.kind()? != sys::ValueType::napi_object {
        return Ok(());
    }
    if !matches!(parsed, JsValue::Object(_)) {
        return Ok(());
    }
    for name in [c"message", c"code"] {
        let key = name.to_str().expect("ascii property name");
        let missing = match parsed {
            JsValue::Object(entries) => !entries.iter().any(|(existing, _)| existing == key),
            _ => false,
        };
        if !missing {
            continue;
        }
        let value = live.get(name)?;
        if value.undefined()? {
            continue;
        }
        let value = read(env, value)?;
        if let JsValue::Object(entries) = parsed {
            entries.push((JsString::from_rust_str(key), value));
        }
    }
    if let Ok(headers) = live.get(c"headers") {
        if !headers.nullish()? {
            if let Some(snapshot) = header_snapshot(env, headers)? {
                if let JsValue::Object(entries) = parsed {
                    set_entry(entries, "headers", snapshot);
                }
            }
        }
    }
    let nested = match live.get(c"error") {
        Ok(value) if !value.nullish()? => Some(value),
        _ => None,
    };
    if let Some(nested) = nested {
        if let JsValue::Object(entries) = parsed {
            if let Some((_, child)) = entries.iter_mut().find(|(name, _)| name == "error") {
                if matches!(child, JsValue::Object(_)) {
                    enrich(env, nested, child)?;
                }
            }
        }
    }
    Ok(())
}

/// `Date.parse(text)`, kept in the engine because everything outside the ISO
/// grammar is implementation-defined. A throw (never for a string argument)
/// reads as `NaN`, which the policy treats as "not a date".
fn date_parse(anchor: LiveValue<'_>, text: &JsString) -> Option<f64> {
    let global = anchor.global().ok()?;
    let date = global.get(c"Date").ok()?;
    let parse = date.get(c"parse").ok()?;
    let input = anchor.from_value(&JsValue::String(text.clone())).ok()?;
    let value = parse.call(date, &[input]).ok()?;
    value.number().ok()
}

fn deps_from(value: &JsValue) -> NormalizeDeps {
    let field = |key: &str| value.get(key).cloned().unwrap_or(JsValue::Undefined);
    NormalizeDeps {
        source: js_to_string(&field("source")),
        provider: js_to_string(&field("provider")),
        upstream: field("upstream"),
        failure: field("failure"),
        rejection: field("rejection"),
        now: js_to_number(&field("now")),
        known: matches!(field("known"), JsValue::Bool(true)),
    }
}

fn number_or_null(value: Option<f64>) -> JsValue {
    value.map_or(JsValue::Null, JsValue::Number)
}

#[napi]
pub fn api_error_facts() -> Result<String> {
    Ok(api_error_policy::facts())
}

#[napi]
pub fn api_error_signatures_quoted() -> Result<String> {
    Ok(api_error_policy::signatures_quoted())
}

/// `{ source, provider, rejection }`: the parts of `normalizeApiError` that
/// must be read before the host classifier and extractor run.
#[napi]
pub fn api_error_prepare(env: Env, raw: Unknown<'_>, context: Unknown<'_>) -> Result<sys::napi_value> {
    let anchor = LiveValue::new(&env, raw);
    let mut raw = read(&env, anchor)?;
    enrich(&env, anchor, &mut raw)?;
    let context = read(&env, LiveValue::new(&env, context))?;
    match api_error_policy::prepare(&raw, &context) {
        Ok(value) => write(&env, &value),
        Err(message) => Err(anchor.type_error(&message)),
    }
}

/// `{ result, textEntitlement }`. The flag tells the JS bridge to share one
/// frozen rejection object, as the Node implementation did; the policy value
/// itself carries no marker.
fn outcome(env: &Env, value: api_error_policy::Outcome) -> Result<sys::napi_value> {
    let flagged = JsValue::Object(vec![
        (JsString::from_rust_str("result"), value.value),
        (
            JsString::from_rust_str("textEntitlement"),
            JsValue::Bool(value.text_entitlement_rejection),
        ),
    ]);
    write(env, &flagged)
}

#[napi]
pub fn api_error_normalize(
    env: Env,
    raw: Unknown<'_>,
    context: Unknown<'_>,
    deps: Unknown<'_>,
) -> Result<sys::napi_value> {
    let anchor = LiveValue::new(&env, raw);
    let mut raw = read(&env, anchor)?;
    enrich(&env, anchor, &mut raw)?;
    let context = read(&env, LiveValue::new(&env, context))?;
    let deps = deps_from(&read(&env, LiveValue::new(&env, deps))?);
    let date = |text: &JsString| date_parse(anchor, text).unwrap_or(f64::NAN);
    let result = api_error_policy::normalize_outcome(&raw, &context, &deps, &date);
    outcome(&env, result)
}

#[napi]
pub fn api_error_decide(
    env: Env,
    raw_error: Unknown<'_>,
    context: Unknown<'_>,
    deps: Unknown<'_>,
    random: Unknown<'_>,
) -> Result<sys::napi_value> {
    let anchor = LiveValue::new(&env, raw_error);
    let mut raw_error = read(&env, anchor)?;
    enrich(&env, anchor, &mut raw_error)?;
    let context = read(&env, LiveValue::new(&env, context))?;
    let deps = deps_from(&read(&env, LiveValue::new(&env, deps))?);
    let random = LiveValue::new(&env, random);
    // `Number(random()) || 0` in the policy: a throw here is a caller bug; its
    // sample reads as `NaN`, which the policy turns into 0.
    let mut sample = move || match random.call_plain(&[]) {
        Ok(value) => value.number().unwrap_or(f64::NAN),
        Err(_) => f64::NAN,
    };
    let date = |text: &JsString| date_parse(anchor, text).unwrap_or(f64::NAN);
    let result = api_error_policy::decide_outcome(&raw_error, &context, &deps, &date, &mut sample);
    outcome(&env, result)
}

#[napi]
pub fn api_error_retry_notice(env: Env, decision: Unknown<'_>) -> Result<sys::napi_value> {
    let decision = read(&env, LiveValue::new(&env, decision))?;
    write(&env, &JsValue::String(api_error_policy::retry_notice(&decision)))
}

#[napi]
pub fn api_error_metric_token(env: Env, value: Unknown<'_>) -> Result<String> {
    let value = read(&env, LiveValue::new(&env, value))?;
    Ok(api_error_policy::metric_token(&value).to_string_lossy())
}

#[napi]
pub fn api_error_is_error_only_text(env: Env, value: Unknown<'_>) -> Result<bool> {
    let value = read(&env, LiveValue::new(&env, value))?;
    Ok(api_error_policy::is_error_only_text(&value))
}

#[napi]
pub fn api_error_split_trailing_envelope(env: Env, value: Unknown<'_>) -> Result<sys::napi_value> {
    let value = read(&env, LiveValue::new(&env, value))?;
    write(&env, &api_error_policy::split_trailing_error_envelope(&value))
}

#[napi]
pub fn api_error_detect_envelope(
    env: Env,
    provider: Unknown<'_>,
    text: Unknown<'_>,
) -> Result<sys::napi_value> {
    let provider = read(&env, LiveValue::new(&env, provider))?;
    let text = read(&env, LiveValue::new(&env, text))?;
    write(&env, &api_error_policy::detect_error_envelope(&provider, &text))
}

#[napi]
pub fn api_error_claude_envelope(
    env: Env,
    provider: Unknown<'_>,
    text: Unknown<'_>,
) -> Result<sys::napi_value> {
    let provider = read(&env, LiveValue::new(&env, provider))?;
    let text = read(&env, LiveValue::new(&env, text))?;
    write(&env, &api_error_policy::claude_error_envelope(&provider, &text))
}

#[napi]
pub fn api_error_envelope_source_for(env: Env, provider: Unknown<'_>) -> Result<String> {
    let provider = read(&env, LiveValue::new(&env, provider))?;
    Ok(api_error_policy::envelope_source_for(&provider).to_string_lossy())
}

#[napi]
pub fn api_error_is_known_harmless_stderr_line(env: Env, line: Unknown<'_>) -> Result<bool> {
    let line = read(&env, LiveValue::new(&env, line))?;
    Ok(api_error_policy::is_known_harmless_stderr_line(&line))
}

#[napi]
pub fn api_error_parse_retry_after(
    env: Env,
    value: Unknown<'_>,
    now: f64,
) -> Result<sys::napi_value> {
    let anchor = LiveValue::new(&env, value);
    let value = read(&env, anchor)?;
    let date = |text: &JsString| date_parse(anchor, text).unwrap_or(f64::NAN);
    let result = api_error_policy::parse_retry_after(&Some(value), now, &date);
    write(&env, &number_or_null(result))
}

#[napi]
pub fn api_error_reset_after_from_text(
    env: Env,
    value: Unknown<'_>,
    now: f64,
) -> Result<sys::napi_value> {
    let anchor = LiveValue::new(&env, value);
    let value = read(&env, anchor)?;
    let date = |text: &JsString| date_parse(anchor, text).unwrap_or(f64::NAN);
    let result = api_error_policy::reset_after_from_text(&Some(value), now, &date);
    write(&env, &number_or_null(result))
}
