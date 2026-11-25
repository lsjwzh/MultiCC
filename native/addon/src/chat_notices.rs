use crate::js_live::LiveValue as L;
use multicc_core::{chat_notices, js::JsValue};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;

// Keep potentially large error details in V8. String(value) accepts a Symbol;
// interpolation of the code and reason uses ordinary ToString.
fn field_text(value: L<'_>) -> Result<L<'_>> {
    if !value.truthy()? {
        return value.from_value(&JsValue::string(""));
    }
    if value.kind()? == sys::ValueType::napi_string {
        return Ok(value);
    }
    value.global()?.get(c"String")?.call_plain(&[value])
}

#[napi]
pub fn chat_lost_notice(env: Env, error: Unknown<'_>) -> Result<sys::napi_value> {
    let error = L::new(&env, error);
    let code = error.optional(c"code")?;
    let code = if code.truthy()? {
        code
    } else {
        error.from_value(&JsValue::string("delivery_failed"))?
    };
    let detail = field_text(error.optional(c"detail")?)?;
    let mut reason = detail.get(c"trim")?.call(detail, &[])?;
    if !reason.truthy()? {
        let message = field_text(error.optional(c"message")?)?;
        let newline = error.from_value(&JsValue::string("\n"))?;
        let one = error.from_value(&JsValue::Number(1.0))?;
        reason = message
            .get(c"split")?
            .call(message, &[newline, one])?
            .element(0)?;
        if !reason.truthy()? {
            reason = code;
        }
    }
    let prefix = error.from_value(&JsValue::string("🚫 这条消息没能送达（"))?;
    let separator = error.from_value(&JsValue::string("）："))?;
    let suffix = error.from_value(&JsValue::string("\n修好后请重新发送。"))?;
    Ok(prefix
        .get(c"concat")?
        .call(prefix, &[code, separator, reason, suffix])?
        .raw())
}

#[napi]
pub fn chat_queued_notice(
    env: Env,
    locked: bool,
    reasons: Unknown<'_>,
    ms: f64,
) -> Result<sys::napi_value> {
    let reasons = L::new(&env, reasons);
    let text = chat_notices::queued(locked, &reasons.coerce_string()?, ms);
    Ok(reasons.from_value(&JsValue::String(text))?.raw())
}

#[napi]
pub fn chat_held_notice(ms: f64) -> String {
    chat_notices::held(ms)
}

#[napi]
pub fn chat_hold_cap_notice(rounded_minutes: Option<f64>) -> String {
    chat_notices::hold_cap(rounded_minutes)
}
