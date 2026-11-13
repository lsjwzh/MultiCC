//! Wait resolution domain transaction using lazy host values.
//!
//! Authentication happens before accessing the untrusted payload. The caller
//! owns the transaction and invokes this command synchronously.
use crate::{js_live::LiveValue as L, wait_canonical::canonical_live};
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
fn normal<'a>(value: L<'a>) -> Result<L<'a>> {
    let canonical = canonical_live(value)?;
    let json = value.global()?.get(c"JSON")?;
    json.get(c"parse")?.call(json, &[canonical])
}
fn hash<'a>(value: L<'a>, crypto: L<'a>) -> Result<L<'a>> {
    let context = crypto
        .get(c"createHash")?
        .call(crypto, &[text(value, "sha256")?])?;
    let data = canonical_live(value)?;
    let updated = context.get(c"update")?.call(context, &[data])?;
    updated
        .get(c"digest")?
        .call(updated, &[text(value, "hex")?])
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
fn token_equal(expected_hex: L<'_>, raw: L<'_>, crypto: L<'_>) -> Result<bool> {
    let context = crypto
        .get(c"createHash")?
        .call(crypto, &[text(raw, "sha256")?])?;
    let raw_string = raw.global()?.get(c"String")?.call_plain(&[raw])?;
    let updated = context
        .get(c"update")?
        .call(context, &[raw_string, text(raw, "utf8")?])?;
    let actual = updated.get(c"digest")?.call(updated, &[])?;
    let length = actual.get(c"length")?;
    let buffer = raw.global()?.get(c"Buffer")?;
    let mut expected = buffer.get(c"alloc")?.call(buffer, &[length])?;
    let valid = if valid_hash(expected_hex)? {
        expected = buffer
            .get(c"from")?
            .call(buffer, &[expected_hex, text(raw, "hex")?])?;
        expected.get(c"length")?.equals(length)?
    } else {
        false
    };
    let compare = if valid {
        expected
    } else {
        buffer.get(c"alloc")?.call(buffer, &[length])?
    };
    let equal = crypto
        .get(c"timingSafeEqual")?
        .call(crypto, &[actual, compare])?
        .truthy()?;
    Ok(valid && equal)
}
fn string_interpolate<'a>(root: L<'a>, prefix: &str, value: L<'a>) -> Result<L<'a>> {
    let value = value.coerce_string()?;
    let units = prefix
        .encode_utf16()
        .chain(value.as_units().iter().copied())
        .collect();
    val(root, V::String(JsString::from_units(units)))
}
fn outbox_admit<'a>(
    draft: L<'a>,
    id: L<'a>,
    session: L<'a>,
    payload: L<'a>,
    source: L<'a>,
    at: L<'a>,
    ports: (L<'a>, L<'a>),
) -> Result<(L<'a>, bool)> {
    let (crypto, conflict) = ports;
    let obj_type = |x: L<'_>| -> Result<bool> { Ok(x.kind()? == sys::ValueType::napi_object) };
    if !draft.truthy()?
        || !obj_type(draft)?
        || !draft.get(c"outbox")?.truthy()?
        || !obj_type(draft.get(c"outbox")?)?
    {
        return Err(draft.type_error("outbox mutation requires an orchestration/store draft"));
    }
    let number = draft.global()?.get(c"Number")?;
    let sequence = draft.get(c"nextOutboxSequence")?;
    if !number
        .get(c"isSafeInteger")?
        .call(number, &[sequence])?
        .truthy()?
        || sequence.number()? < 1.0
    {
        return Err(draft.type_error("outbox draft has an invalid sequence"));
    }
    if !id.truthy()? || id.kind()? != sys::ValueType::napi_string {
        return Err(draft.type_error("outbox item requires id"));
    }
    if !session.truthy()? || session.kind()? != sys::ValueType::napi_string {
        return Err(draft.type_error("outbox item requires sessionId"));
    }
    if !number.get(c"isFinite")?.call(number, &[at])?.truthy()? {
        return Err(draft.type_error("outbox timestamps must be finite numbers"));
    }
    let payload = normal(payload)?;
    let payload_hash = hash(payload, crypto)?;
    let source = normal(source)?;
    let outbox = draft.get(c"outbox")?;
    let existing = outbox.get_key(id)?;
    if existing.truthy()? {
        if existing.get(c"sessionId")?.equals(session)?
            && existing.get(c"payloadHash")?.equals(payload_hash)?
        {
            return Ok((existing, true));
        }
        return Err(conflict.construct(&[id])?.throw_error());
    }
    draft.assign(
        c"nextOutboxSequence",
        val(draft, V::Number(sequence.number()? + 1.0))?,
    )?;
    let item = object(draft)?;
    let nil = null(draft)?;
    for (name, value) in [
        (c"id", id),
        (c"sessionId", session),
        (c"sequence", sequence),
        (c"state", text(draft, "pending")?),
        (c"payload", payload),
        (c"payloadHash", payload_hash),
        (c"source", source),
        (c"attempts", val(draft, V::Number(0.0))?),
        (c"availableAt", at),
        (c"createdAt", at),
        (c"updatedAt", at),
        (c"leasedAt", nil),
        (c"leasedUntil", nil),
        (c"leaseOwner", nil),
        (c"leaseTokenHash", nil),
        (c"deliveredAt", nil),
        (c"deadLetterAt", nil),
        (c"lastError", nil),
    ] {
        set(item, name, value)?;
    }
    outbox.set_key(id, item)?;
    Ok((item, false))
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
    {
        return Ok(fail("invalid_token")?.raw());
    }
    let payload = normal(payload)?;
    let payload_hash = hash(payload, crypto)?;
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
    let (item, idempotent) = outbox_admit(
        draft,
        outbox_id,
        wait.get(c"sessionId")?,
        out_payload,
        source,
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
