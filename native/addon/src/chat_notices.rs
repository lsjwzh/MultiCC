use crate::{host_methods::method, js_iteration::read, js_live::invoke, route_response::*};
use multicc_core::{chat_notices, js::JsValue};
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

fn notice_option<'a>(value: L<'a>, key: &std::ffi::CStr, default: V) -> Result<L<'a>> {
    let value = read(value, key)?;
    if value.undefined()? {
        value.from_value(&default)
    } else {
        Ok(value)
    }
}
fn notice_options(value: L<'_>) -> Result<L<'_>> {
    if value.undefined()? {
        fields(value, &[])
    } else {
        Ok(value)
    }
}
fn notice_parameter<'a>(value: L<'a>, key: &std::ffi::CStr) -> Result<L<'a>> {
    if value.nullish()? {
        let (printed, kind) = if value.undefined()? {
            ("undefined", "undefined")
        } else {
            ("object null", "null")
        };
        return Err(value.type_error(&format!(
            "Cannot destructure property '{}' of '{printed}' as it is {kind}.",
            key.to_str().expect("static key")
        )));
    }
    read(value, key)
}
fn notice_number(value: L<'_>) -> Result<L<'_>> {
    value.global()?.get(c"Number")?.call_plain(&[value])
}
fn notice_lost<'a>(api: L<'a>, error: L<'a>) -> Result<L<'a>> {
    call(api.get(c"native")?, c"chatLostNotice", &[error])
}
fn notice_stuck<'a>(api: L<'a>, value: L<'a>) -> Result<L<'a>> {
    let value = notice_options(value)?;
    let reason = notice_option(value, c"reason", "session_busy".into())?;
    let reasons = notice_option(value, c"reasons", V::Array(vec![]))?;
    let waited = notice_option(value, c"waitedMs", V::Number(0.0))?;
    let list = if read(reasons, c"length")?.truthy()? {
        invoke(
            reasons,
            read(reasons, c"join")?,
            &[text(api, "、")?],
            "reasons.join",
        )?
    } else {
        reason
    };
    let native = api.get(c"native")?;
    let queued = read(native, c"chatQueuedNotice")?;
    let locked = flag(api, reason.equals(text(api, "delivery_locked")?)?)?;
    let list = api.from_value(&V::String(list.coerce_string()?))?;
    let waited = notice_number(fallback(waited, V::Number(0.0))?)?;
    queued.call(native, &[locked, list, waited])
}
fn notice_held<'a>(api: L<'a>, value: L<'a>) -> Result<L<'a>> {
    let waited = notice_option(notice_options(value)?, c"waitedMs", V::Number(0.0))?;
    let native = api.get(c"native")?;
    let held = read(native, c"chatHeldNotice")?;
    held.call(native, &[notice_number(fallback(waited, V::Number(0.0))?)?])
}
fn notice_cap<'a>(api: L<'a>, value: L<'a>) -> Result<L<'a>> {
    let minutes = notice_option(notice_options(value)?, c"minutes", V::Number(0.0))?;
    let native = api.get(c"native")?;
    let cap = read(native, c"chatHoldCapNotice")?;
    let rounded = if notice_number(minutes)?.number()? >= 1.0 {
        let math = api.global()?.get(c"Math")?;
        let round = read(math, c"round")?;
        round.call(math, &[notice_number(minutes)?])?
    } else {
        null(api)?
    };
    cap.call(native, &[rounded])
}

fn notice_exception(anchor: L<'_>, error: napi::Error) -> Result<L<'_>> {
    if let Some(value) = anchor.exception_value()? {
        return Ok(value);
    }
    let value = anchor
        .global()?
        .get(c"Error")?
        .construct(&[text(anchor, &error.reason)?])?;
    value.set(c"code", text(anchor, error.status.as_ref())?)?;
    Ok(value)
}
fn notice_warn(instance: L<'_>, event: &str, session: L<'_>, error: L<'_>) -> Result<()> {
    // Constructing the warning fields is outside warn's try/catch in the old
    // host. A hostile error.message getter must retain that exception boundary.
    let message = if error.truthy()? && read(error, c"message")?.truthy()? {
        read(error, c"message")?
    } else {
        string(error)?
    };
    let warning = fields(instance, &[("sessionId", session), ("message", message)])?;
    instance.catch(|| {
        let logger = instance.get(c"logger")?;
        if !logger.nullish()? {
            let warn = read(logger, c"warn")?;
            if !warn.nullish()? {
                invoke(
                    logger,
                    warn,
                    &[text(instance, event)?, warning],
                    "logger?.warn",
                )?;
            }
        }
        Ok(())
    })?;
    Ok(())
}
fn notice_broadcast<'a>(instance: L<'a>, session: L<'a>, message: L<'a>) -> Result<()> {
    let send = || {
        let broadcast = instance.get(c"chatBroadcast")?;
        if !broadcast.nullish()? {
            let frame = fields(
                instance,
                &[
                    ("type", text(instance, "system")?),
                    ("subtype", text(instance, "notice")?),
                    ("message", message),
                ],
            )?;
            invoke(
                instance.from_value(&V::Undefined)?,
                broadcast,
                &[session, frame],
                "chatBroadcast",
            )?;
        }
        Ok(())
    };
    if let Err(error) = send() {
        notice_warn(
            instance,
            "chat_notice_broadcast_failed",
            session,
            notice_exception(instance, error)?,
        )?;
    }
    Ok(())
}
fn notice_bound<'a>(api: L<'a>, key: &std::ffi::CStr, args: &[L<'a>], name: &str) -> Result<L<'a>> {
    let mut bound = vec![api.from_value(&V::Undefined)?];
    bound.extend_from_slice(args);
    let callback = call(api.get(key)?, c"bind", &bound)?;
    call(
        api.global()?.get(c"Object")?,
        c"defineProperty",
        &[
            callback,
            text(api, "name")?,
            fields(api, &[("value", text(api, name)?)])?,
        ],
    )?;
    Ok(callback)
}
fn notice_say<'a>(api: L<'a>, instance: L<'a>, session: L<'a>, message: L<'a>) -> Result<L<'a>> {
    let append = instance.get(c"appendChatMessage")?;
    if !session.truthy()? || append.kind()? != sys::ValueType::napi_function {
        return api.from_value(&V::Undefined);
    }
    let save = || {
        let timestamp = invoke(
            instance.from_value(&V::Undefined)?,
            instance.get(c"now")?,
            &[],
            "now",
        )?;
        let record = fields(
            instance,
            &[
                ("role", text(instance, "system")?),
                ("content", message),
                ("ts", timestamp),
            ],
        )?;
        append.call_plain(&[session, record])
    };
    let saved = match save() {
        Ok(value) => value,
        Err(error) => {
            notice_warn(
                instance,
                "chat_notice_persist_failed",
                session,
                notice_exception(instance, error)?,
            )?;
            return flag(api, false);
        }
    };
    if saved.truthy()? && read(saved, c"then")?.kind()? == sys::ValueType::napi_function {
        let promise = call(api.global()?.get(c"Promise")?, c"resolve", &[saved])?;
        let then = read(promise, c"then")?;
        let args = [instance, session, message];
        let success = notice_bound(api, c"success", &args, "")?;
        let failure = notice_bound(api, c"failure", &args, "")?;
        return then.call(promise, &[success, failure]);
    }
    if !saved.truthy()? {
        return flag(api, false);
    }
    notice_broadcast(instance, session, message)?;
    flag(api, true)
}
fn notice_create<'a>(api: L<'a>, options: L<'a>) -> Result<L<'a>> {
    let append = notice_parameter(options, c"appendChatMessage")?;
    let broadcast = read(options, c"chatBroadcast")?;
    let now = read(options, c"now")?;
    let now = if now.undefined()? {
        read(api.global()?.get(c"Date")?, c"now")?
    } else {
        now
    };
    let logger = read(options, c"logger")?;
    let logger = if logger.undefined()? {
        api.global()?.get(c"console")?
    } else {
        logger
    };
    let instance = fields(
        api,
        &[
            ("appendChatMessage", append),
            ("chatBroadcast", broadcast),
            ("now", now),
            ("logger", logger),
        ],
    )?;
    fields(
        api,
        &[
            (
                "notifyLostMessage",
                notice_bound(api, c"lost", &[instance], "notifyLostMessage")?,
            ),
            (
                "notifyStuckDelivery",
                notice_bound(api, c"stuck", &[instance], "notifyStuckDelivery")?,
            ),
            (
                "notifyHoldCap",
                notice_bound(api, c"cap", &[instance], "notifyHoldCap")?,
            ),
        ],
    )
}

/// Durable append, Promise continuations and live broadcast all remain on V8's
/// thread. Rust owns the sequencing and error decisions over injected ports.
#[napi]
pub fn session_notices_api(env: Env, native: Unknown<'_>) -> Result<sys::napi_value> {
    let native = L::new(&env, native);
    let api = fields(native, &[("native", native)])?;
    api.set(
        c"success",
        method(&env, api, "", 4, 4, |_, a| {
            if !a[3].truthy()? {
                return flag(a[0], false);
            }
            notice_broadcast(a[0], a[1], a[2])?;
            flag(a[0], true)
        })?,
    )?;
    api.set(
        c"failure",
        method(&env, api, "", 4, 4, |_, a| {
            notice_warn(a[0], "chat_notice_persist_failed", a[1], a[3])?;
            flag(a[0], false)
        })?,
    )?;
    api.set(
        c"lost",
        method(&env, api, "", 2, 2, |s, a| {
            let session = notice_parameter(a[1], c"sessionId")?;
            let error = read(a[1], c"error")?;
            notice_say(s, a[0], session, notice_lost(s, error)?)
        })?,
    )?;
    api.set(
        c"stuck",
        method(&env, api, "", 2, 2, |s, a| {
            let value = a[1];
            let session = notice_parameter(value, c"sessionId")?;
            let reason = read(value, c"reason")?;
            let reasons = read(value, c"reasons")?;
            let waited = read(value, c"waitedMs")?;
            let held = notice_option(value, c"heldForBackground", V::Bool(false))?;
            let options = fields(
                s,
                &[
                    ("reason", reason),
                    ("reasons", reasons),
                    ("waitedMs", waited),
                ],
            )?;
            let message = if held.truthy()? {
                notice_held(s, options)?
            } else {
                notice_stuck(s, options)?
            };
            notice_say(s, a[0], session, message)
        })?,
    )?;
    api.set(
        c"cap",
        method(&env, api, "", 2, 2, |s, a| {
            let session = notice_parameter(a[1], c"sessionId")?;
            let minutes = read(a[1], c"minutes")?;
            let message = notice_cap(s, fields(s, &[("minutes", minutes)])?)?;
            notice_say(s, a[0], session, message)
        })?,
    )?;
    Ok(fields(
        api,
        &[
            (
                "createSessionNotices",
                method(&env, api, "createSessionNotices", 1, 1, |s, a| {
                    notice_create(s, a[0])
                })?,
            ),
            (
                "lostMessageText",
                method(&env, api, "lostMessageText", 1, 1, |s, a| {
                    notice_lost(s, a[0])
                })?,
            ),
            (
                "stuckDeliveryText",
                method(&env, api, "stuckDeliveryText", 0, 1, |s, a| {
                    notice_stuck(s, a[0])
                })?,
            ),
            (
                "heldBackgroundText",
                method(&env, api, "heldBackgroundText", 0, 1, |s, a| {
                    notice_held(s, a[0])
                })?,
            ),
            (
                "heldCapText",
                method(&env, api, "heldCapText", 0, 1, |s, a| notice_cap(s, a[0]))?,
            ),
        ],
    )?
    .raw())
}
