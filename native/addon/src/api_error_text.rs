//! Text redaction and the provider rejection contract at the host boundary.
//!
//! The rules are `multicc_core::redaction`; this module only reproduces how
//! the JS functions read and coerced their arguments: `String(value || '')`,
//! the defaulted fallback, `slice(0, maxLength)` with JS integer conversion,
//! and `normalizeRejection`'s property reads in their original order and
//! count (getters and Proxies see the same traps).
use crate::js_live::LiveValue;
use multicc_core::{
    js::{JsString, JsValue},
    redaction,
};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;
use std::ffi::CStr;

const DEFAULT_FALLBACK: &str = "Upstream API request failed";
/// `MAX_SANITIZED_MESSAGE`.
const MAX_SANITIZED_MESSAGE: f64 = 240.0;
/// `REJECTION_TEXT_MAX`.
const REJECTION_TEXT_MAX: usize = 80;

fn text<'a>(anchor: LiveValue<'a>, value: JsString) -> Result<LiveValue<'a>> {
    anchor.from_value(&JsValue::String(value))
}

fn null(anchor: LiveValue<'_>) -> Result<LiveValue<'_>> {
    anchor.from_value(&JsValue::Null)
}

/// `String(value)` (a Symbol becomes its description, unlike `${value}`).
fn js_string(value: LiveValue<'_>) -> Result<JsString> {
    Ok(value
        .global()?
        .get(c"String")?
        .call_plain(&[value])?
        .string()?
        .expect("String() returns a string"))
}

/// `String(value || '')`.
fn string_or_empty(value: LiveValue<'_>) -> Result<JsString> {
    if value.truthy()? {
        js_string(value)
    } else {
        Ok(JsString::from_rust_str(""))
    }
}

/// The argument must already be a string (the JS wrappers check `typeof`).
fn read_text(value: LiveValue<'_>) -> Result<JsString> {
    match value.string()? {
        Some(text) => Ok(text),
        None => Err(value.type_error("expected a string")),
    }
}

/// `sanitizeMessage(value, fallback, maxLength)` with the JS defaults for an
/// `undefined` fallback or length.
pub(crate) fn sanitize<'a>(
    value: LiveValue<'a>,
    fallback: LiveValue<'a>,
    max_length: LiveValue<'a>,
) -> Result<LiveValue<'a>> {
    let message = redaction::sanitize_message(&string_or_empty(value)?);
    let fallback = if fallback.undefined()? {
        text(value, JsString::from_rust_str(DEFAULT_FALLBACK))?
    } else {
        fallback
    };
    let max_length = if max_length.undefined()? {
        value.from_value(&JsValue::Number(MAX_SANITIZED_MESSAGE))?
    } else {
        max_length
    };
    // `if (!message) message = fallback; return message.slice(0, maxLength)`:
    // the fallback may be any value, so its `slice` is looked up on it.
    let message = if message.is_empty() {
        fallback
    } else {
        text(value, message)?
    };
    if message.nullish()? {
        let kind = if message.undefined()? {
            "undefined"
        } else {
            "null"
        };
        return Err(message.type_error(&format!(
            "Cannot read properties of {kind} (reading 'slice')"
        )));
    }
    let zero = value.from_value(&JsValue::Number(0.0))?;
    message.get(c"slice")?.call(message, &[zero, max_length])
}

fn lower_token(value: JsString) -> String {
    value.trim().to_lowercase().to_string_lossy()
}

fn member<'a>(anchor: LiveValue<'a>, token: &str, allowed: &[&str]) -> Result<LiveValue<'a>> {
    if allowed.contains(&token) {
        text(anchor, JsString::from_rust_str(token))
    } else {
        null(anchor)
    }
}

/// `rejectionText(value)`: a trimmed, capped string or null.
fn rejection_text<'a>(value: LiveValue<'a>) -> Result<LiveValue<'a>> {
    match value.string()? {
        Some(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                null(value)
            } else {
                text(value, trimmed.truncate_units(REJECTION_TEXT_MAX))
            }
        }
        None => null(value),
    }
}

/// `Math.round` for a finite positive number.
fn round(value: f64) -> f64 {
    let floor = value.floor();
    if value - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}

fn get<'a>(value: LiveValue<'a>, name: &CStr) -> Result<LiveValue<'a>> {
    value.get(name)
}

/// `normalizeRejection(value)`: the structured rejection a Rust proxy reports
/// crosses a process boundary, so only the contract's keys, known enum values
/// and capped free text survive. `null` for anything else.
pub(crate) fn normalize_rejection(value: LiveValue<'_>) -> Result<LiveValue<'_>> {
    if !value.truthy()? || value.kind()? != sys::ValueType::napi_object || value.is_array()? {
        return null(value);
    }
    let kind = lower_token(string_or_empty(get(value, c"kind")?)?);
    if !["transient", "window", "entitlement", "billing"].contains(&kind.as_str()) {
        return null(value);
    }
    let scope = lower_token(string_or_empty(get(value, c"scope")?)?);
    // `value.window == null ? null : String(value.window)…`: a second read.
    let window = if get(value, c"window")?.nullish()? {
        None
    } else {
        Some(lower_token(js_string(get(value, c"window")?)?))
    };
    let source = lower_token(string_or_empty(get(value, c"source")?)?);
    let reset = get(value, c"resetMs")?.explicit_number()?;
    let reset = if reset.is_finite() && reset > 0.0 && reset <= 9_007_199_254_740_991.0 {
        value.from_value(&JsValue::Number(round(reset)))?
    } else {
        null(value)?
    };
    let entries: Vec<(&CStr, LiveValue<'_>)> = vec![
        (
            c"kind",
            member(
                value,
                &kind,
                &["transient", "window", "entitlement", "billing"],
            )?,
        ),
        (
            c"scope",
            member(value, &scope, &["request", "model", "account"])?,
        ),
        (
            c"window",
            match window {
                Some(window) => member(value, &window, &["5h", "1d", "1wk", "1m"])?,
                None => null(value)?,
            },
        ),
        (c"resetMs", reset),
        (c"code", rejection_text(get(value, c"code")?)?),
        (c"model", rejection_text(get(value, c"model")?)?),
        (
            c"source",
            member(value, &source, &["headers", "code", "text", "status"])?,
        ),
    ];
    let output = value.from_value(&JsValue::Object(vec![]))?;
    for (name, item) in entries {
        output.set(name, item)?;
    }
    output.freeze()
}

#[napi]
pub fn api_sanitize_message(
    env: Env,
    value: Unknown<'_>,
    fallback: Unknown<'_>,
    max_length: Unknown<'_>,
) -> Result<sys::napi_value> {
    Ok(sanitize(
        LiveValue::new(&env, value),
        LiveValue::new(&env, fallback),
        LiveValue::new(&env, max_length),
    )?
    .raw())
}

#[napi]
pub fn api_normalize_rejection(env: Env, value: Unknown<'_>) -> Result<sys::napi_value> {
    Ok(normalize_rejection(LiveValue::new(&env, value))?.raw())
}

/// The input string itself when nothing changed: no new string is created.
fn rewritten<'a>(value: LiveValue<'a>, rule: fn(&JsString) -> JsString) -> Result<LiveValue<'a>> {
    let input = read_text(value)?;
    let output = rule(&input);
    if output == input {
        Ok(value)
    } else {
        text(value, output)
    }
}

#[napi]
pub fn redaction_redact_text(env: Env, value: Unknown<'_>) -> Result<sys::napi_value> {
    Ok(rewritten(LiveValue::new(&env, value), redaction::redact_text)?.raw())
}

#[napi]
pub fn redaction_route_capability(env: Env, value: Unknown<'_>) -> Result<sys::napi_value> {
    Ok(rewritten(
        LiveValue::new(&env, value),
        redaction::redact_route_capability,
    )?
    .raw())
}

/// `{ route, text }`: see `redaction::ROUTE_ANCHORS` / `TEXT_ANCHORS`.
#[napi(object)]
pub struct RedactionAnchors {
    pub route: Vec<String>,
    pub text: Vec<String>,
}

#[napi]
pub fn redaction_anchors() -> RedactionAnchors {
    RedactionAnchors {
        route: redaction::ROUTE_ANCHORS
            .iter()
            .map(|a| a.to_string())
            .collect(),
        text: redaction::TEXT_ANCHORS
            .iter()
            .map(|a| a.to_string())
            .collect(),
    }
}

#[napi]
pub fn redaction_secret_key(env: Env, value: Unknown<'_>) -> Result<bool> {
    let value = LiveValue::new(&env, value);
    Ok(redaction::is_secret_key(&read_text(value)?))
}
