//! Wait resolution domain transaction using lazy host values.
//!
//! Authentication happens before accessing the untrusted payload. The caller
//! owns the transaction and invokes this command synchronously.
use crate::{
    js_live::LiveValue as L,
    operation_admit_live::{hash, normal},
};
use multicc_core::js::{JsString, JsValue as V};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;
use std::ffi::CStr;

fn val<'a>(root: L<'a>, value: V) -> Result<L<'a>> {
    root.from_value(&value)
}
fn text<'a>(root: L<'a>, value: &str) -> Result<L<'a>> {
    val(root, V::string(value))
}
fn object(root: L<'_>) -> Result<L<'_>> {
    val(root, V::Object(Vec::new()))
}
fn null(root: L<'_>) -> Result<L<'_>> {
    val(root, V::Null)
}
fn set<'a>(object: L<'a>, name: &'static CStr, value: L<'a>) -> Result<()> {
    object.set(name, value)
}
fn valid_hash(expected: L<'_>) -> Result<bool> {
    let Some(value) = expected.string()? else {
        return Ok(false);
    };
    Ok(value.len() == 64
        && value
            .as_units()
            .iter()
            .all(|c| matches!(*c, 48..=57 | 65..=70 | 97..=102)))
}
pub(crate) fn token_equal<'a>(expected_hex: L<'a>, raw: L<'a>, crypto: L<'a>) -> Result<L<'a>> {
    let context = crypto
        .get(c"createHash")?
        .call(crypto, &[text(raw, "sha256")?])?;
    let update = context.get(c"update")?;
    let raw_string = raw.global()?.get(c"String")?.call_plain(&[raw])?;
    let updated = update.call(context, &[raw_string, text(raw, "utf8")?])?;
    let actual = updated.get(c"digest")?.call(updated, &[])?;
    let buffer = raw.global()?.get(c"Buffer")?;
    let mut expected = buffer
        .get(c"alloc")?
        .call(buffer, &[actual.get(c"length")?])?;
    let valid = if valid_hash(expected_hex)? {
        expected = buffer
            .get(c"from")?
            .call(buffer, &[expected_hex, text(raw, "hex")?])?;
        expected.get(c"length")?.equals(actual.get(c"length")?)?
    } else {
        false
    };
    let compare_fn = crypto.get(c"timingSafeEqual")?;
    let compare = if valid {
        expected
    } else {
        buffer
            .get(c"alloc")?
            .call(buffer, &[actual.get(c"length")?])?
    };
    let equal = compare_fn.call(crypto, &[actual, compare])?;
    if valid {
        Ok(equal)
    } else {
        val(raw, V::Bool(false))
    }
}
fn string_interpolate<'a>(root: L<'a>, prefix: &str, value: L<'a>) -> Result<L<'a>> {
    let value = value.coerce_string()?;
    let units = prefix
        .encode_utf16()
        .chain(value.as_units().iter().copied())
        .collect();
    val(root, V::String(JsString::from_units(units)))
}
#[napi]
#[allow(clippy::too_many_arguments)] // Live ports preserve ordered getters, custom crypto and clock semantics.
pub fn wait_resolve_live(
    env: Env,
    draft: Unknown<'_>,
    id: Unknown<'_>,
    payload: Unknown<'_>,
    input: Unknown<'_>,
    clock: Unknown<'_>,
    crypto: Unknown<'_>,
    default_crypto: Unknown<'_>,
    conflict: Unknown<'_>,
) -> Result<sys::napi_value> {
    let draft = L::new(&env, draft);
    let id = L::new(&env, id);
    let payload = L::new(&env, payload);
    let input = L::new(&env, input);
    let clock = L::new(&env, clock);
    let crypto = L::new(&env, crypto);
    let default_crypto = L::new(&env, default_crypto);
    let conflict = L::new(&env, conflict);
    if !id.truthy()? || id.kind()? != sys::ValueType::napi_string {
        return Err(draft.type_error("[wait-service] resolve requires wait id"));
    }
    let wait = draft.get(c"waits")?.get_key(id)?;
    let fail = |code: &str| -> Result<L<'_>> {
        val(
            draft,
            V::object(vec![("ok", false.into()), ("code", V::string(code))]),
        )
    };
    if !wait.truthy()? {
        return Ok(fail("not_found")?.raw());
    }
    let expected_mode = input.get(c"expectedMode")?;
    if expected_mode.truthy()? && !wait.get(c"mode")?.equals(expected_mode)? {
        return Ok(fail("mode_mismatch")?.raw());
    }
    if wait.get(c"mode")?.is_string("callback")?
        && !token_equal(
            wait.get(c"callbackTokenHash")?,
            input.get(c"callbackToken")?,
            crypto,
        )?
        .truthy()?
    {
        return Ok(fail("invalid_token")?.raw());
    }
    let payload = normal(payload)?;
    let payload_hash = hash(payload, crypto, false)?;
    if wait.get(c"status")?.is_string("resolved")? {
        let idempotent = wait.get(c"resolutionPayloadHash")?.equals(payload_hash)?;
        let result = object(draft)?;
        set(result, c"ok", val(draft, V::Bool(idempotent))?)?;
        if idempotent {
            set(result, c"idempotent", val(draft, V::Bool(true))?)?;
        } else {
            set(result, c"code", text(draft, "payload_conflict")?)?;
            set(result, c"statusCode", val(draft, V::Number(409.0))?)?;
        }
        set(result, c"waitId", wait.get(c"id")?)?;
        set(result, c"outboxId", wait.get(c"outboxId")?)?;
        return Ok(result.raw());
    }
    if !wait.get(c"status")?.is_string("pending")? {
        let result = fail("not_pending")?;
        set(result, c"status", wait.get(c"status")?)?;
        return Ok(result.raw());
    }
    let at = val(draft, V::Number(clock.call_plain(&[])?.explicit_number()?))?;
    let outbox_id = string_interpolate(draft, "wait:", wait.get(c"id")?)?;
    let session_work = input.get(c"sessionWork")?;
    let first = session_work.optional(c"text")?;
    let session_text = if first.kind()? == sys::ValueType::napi_string {
        let value = session_work.get(c"text")?;
        value.get(c"trim")?.call(value, &[])?
    } else {
        text(draft, "")?
    };
    let out_payload = object(draft)?;
    let nil = null(draft)?;
    if session_text.truthy()? {
        set(out_payload, c"type", text(draft, "session.work")?)?;
        set(out_payload, c"workKind", text(draft, "task")?)?;
        set(out_payload, c"message", session_text)?;
        let options = object(draft)?;
        for (name, value) in [
            (c"originContinue", val(draft, V::Bool(false))?),
            (c"clientMsgId", outbox_id),
            (c"scheduledMessageId", wait.get(c"id")?),
            (c"receivedAt", at),
        ] {
            set(options, name, value)?;
        }
        set(out_payload, c"options", options)?;
        set(out_payload, c"source", text(draft, "scheduled")?)?;
        for name in [c"taskId", c"requestId", c"activeEntryId"] {
            set(out_payload, name, nil)?;
        }
    } else {
        set(out_payload, c"type", text(draft, "wait.resolved")?)?;
        set(out_payload, c"waitId", wait.get(c"id")?)?;
        set(out_payload, c"mode", wait.get(c"mode")?)?;
        set(out_payload, c"injectPrefix", wait.get(c"injectPrefix")?)?;
        set(out_payload, c"data", payload)?;
        let delivery = input.get(c"deliveryText")?;
        set(
            out_payload,
            c"deliveryText",
            if delivery.kind()? == sys::ValueType::napi_string {
                delivery
            } else {
                nil
            },
        )?;
        for name in [c"taskId", c"originDispatchId"] {
            if wait.optional(c"metadata")?.optional(name)?.truthy()? {
                set(out_payload, name, wait.get(c"metadata")?.get(name)?)?;
            }
        }
    }
    let source = object(draft)?;
    set(source, c"type", text(draft, "wait")?)?;
    set(source, c"waitId", wait.get(c"id")?)?;
    let (item, idempotent) = crate::outbox_runtime::admit::insert(
        draft,
        outbox_id,
        wait.get(c"sessionId")?,
        out_payload,
        source,
        at,
        at,
        (default_crypto, conflict),
    )?;
    if session_text.truthy()? && draft.get(c"outbox")?.get_key(item.get(c"id")?)?.truthy()? {
        draft
            .get(c"outbox")?
            .get_key(item.get(c"id")?)?
            .assign(c"directRun", val(draft, V::Bool(true))?)?;
    }
    wait.assign(c"status", text(draft, "resolved")?)?;
    wait.assign(c"resolvedAt", at)?;
    wait.assign(c"updatedAt", at)?;
    wait.assign(c"resolutionPayloadHash", payload_hash)?;
    wait.assign(c"outboxId", item.get(c"id")?)?;
    let result = object(draft)?;
    set(result, c"ok", val(draft, V::Bool(true))?)?;
    set(result, c"idempotent", val(draft, V::Bool(idempotent))?)?;
    set(result, c"waitId", wait.get(c"id")?)?;
    set(result, c"outboxId", item.get(c"id")?)?;
    Ok(result.raw())
}
