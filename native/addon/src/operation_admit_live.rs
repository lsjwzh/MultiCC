//! Live compatibility admission: Rust owns the operation and outbox state
//! transitions while the existing JS draft supplies proxy semantics and ports.
use crate::{js_live::LiveValue as L, wait_canonical::canonical_live};
use multicc_core::js::{JsString, JsValue as V};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;
use std::ffi::CStr;

fn val<'a>(base: L<'a>, value: V) -> Result<L<'a>> {
    base.from_value(&value)
}
fn object(base: L<'_>) -> Result<L<'_>> {
    val(base, V::Object(Vec::new()))
}
fn null(base: L<'_>) -> Result<L<'_>> {
    val(base, V::Null)
}
fn text<'a>(base: L<'a>, s: &str) -> Result<L<'a>> {
    val(base, V::string(s))
}
fn regexp_literal<'a>(base: L<'a>, literal: &str) -> Result<L<'a>> {
    let source = text(base, literal)?;
    let mut value = std::ptr::null_mut();
    napi::check_status!(unsafe { sys::napi_run_script(base.env(), source.raw(), &mut value) })?;
    Ok(L::from_raw(base.env(), value))
}
fn surrounded<'a>(base: L<'a>, prefix: &str, middle: &JsString, suffix: &str) -> Result<L<'a>> {
    let units = prefix
        .encode_utf16()
        .chain(middle.as_units().iter().copied())
        .chain(suffix.encode_utf16())
        .collect();
    val(base, V::String(JsString::from_units(units)))
}
fn set<'a>(obj: L<'a>, key: &'static CStr, value: L<'a>) -> Result<()> {
    obj.set(key, value)
}
fn assign_key<'a>(obj: L<'a>, key: L<'a>, value: L<'a>) -> Result<()> {
    let reflect = obj.global()?.get(c"Reflect")?;
    if !reflect
        .get(c"set")?
        .call(reflect, &[obj, key, value, obj])?
        .truthy()?
    {
        return Err(obj.type_error("Cannot assign to read-only property"));
    }
    Ok(())
}
fn normal<'a>(value: L<'a>) -> Result<L<'a>> {
    let canonical = canonical_live(value)?;
    let json = value.global()?.get(c"JSON")?;
    json.get(c"parse")?.call(json, &[canonical])
}
fn hash<'a>(value: L<'a>, crypto: L<'a>, secret: bool) -> Result<L<'a>> {
    let context = crypto
        .get(c"createHash")?
        .call(crypto, &[text(value, "sha256")?])?;
    let data = if secret {
        value.global()?.get(c"String")?.call_plain(&[value])?
    } else {
        canonical_live(value)?
    };
    let updated = if secret {
        context
            .get(c"update")?
            .call(context, &[data, text(value, "utf8")?])?
    } else {
        context.get(c"update")?.call(context, &[data])?
    };
    updated
        .get(c"digest")?
        .call(updated, &[text(value, "hex")?])
}
fn now<'a>(base: L<'a>, clock: L<'a>) -> Result<L<'a>> {
    let n = clock.call_plain(&[])?.explicit_number()?;
    val(base, V::Number(n))
}
fn throw<'a>(ctor: L<'a>, message: L<'a>, id: L<'a>) -> Result<L<'a>> {
    Err(ctor.construct(&[message, id])?.throw_error())
}
fn public<'a>(value: L<'a>) -> Result<L<'a>> {
    if !value.truthy()? {
        return null(value);
    }
    let json = value.global()?.get(c"JSON")?;
    let encoded = json.get(c"stringify")?.call(json, &[value])?;
    let copy = json.get(c"parse")?.call(json, &[encoded])?;
    copy.delete(c"idempotencyKeyHash")?;
    copy.delete(c"requestHash")?;
    copy.delete(c"resultHash")?;
    Ok(copy)
}
fn is_string(value: L<'_>) -> Result<bool> {
    Ok(value.kind()? == sys::ValueType::napi_string)
}
fn object_type(value: L<'_>) -> Result<bool> {
    Ok(value.kind()? == sys::ValueType::napi_object)
}
fn require_outbox_draft(draft: L<'_>) -> Result<()> {
    if !draft.truthy()?
        || !object_type(draft)?
        || !draft.get(c"outbox")?.truthy()?
        || !object_type(draft.get(c"outbox")?)?
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
    Ok(())
}
fn admit_outbox<'a>(
    draft: L<'a>,
    operation: L<'a>,
    clock: L<'a>,
    crypto: L<'a>,
    conflict: L<'a>,
) -> Result<L<'a>> {
    let operation_id = operation.get(c"id")?;
    let id = surrounded(
        draft,
        "operation:",
        &operation_id.coerce_string()?,
        ":request",
    )?;
    let spec = operation.get(c"spec")?;
    let session_id = spec.get(c"chatId")?;
    let payload = object(draft)?;
    set(payload, c"type", text(draft, "dispatch.request")?)?;
    set(payload, c"operationId", operation_id)?;
    set(payload, c"targetId", spec.get(c"targetId")?)?;
    set(payload, c"message", spec.get(c"message")?)?;
    let task_id = spec.get(c"taskId")?;
    set(
        payload,
        c"taskId",
        if task_id.truthy()? {
            task_id
        } else {
            null(draft)?
        },
    )?;
    set(
        payload,
        c"taskStart",
        val(draft, V::Bool(spec.get(c"taskStart")?.is_true()?))?,
    )?;
    for name in [c"taskSource", c"taskText"] {
        let value = spec.get(name)?;
        set(
            payload,
            name,
            if value.truthy()? { value } else { null(draft)? },
        )?;
    }
    if spec.get(c"taskShellReceiptId")?.truthy()? {
        for name in [c"taskShellReceiptId", c"clientMsgId", c"receivedAt"] {
            set(payload, name, spec.get(name)?)?;
        }
    }
    let source = object(draft)?;
    set(source, c"type", text(draft, "operation")?)?;
    set(source, c"kind", text(draft, "dispatch")?)?;
    set(source, c"operationId", operation_id)?;
    let at = now(draft, clock)?;
    require_outbox_draft(draft)?;
    if !id.truthy()? || !is_string(id)? {
        return Err(id.type_error("outbox item requires id"));
    }
    if !session_id.truthy()? || !is_string(session_id)? {
        return Err(session_id.type_error("outbox item requires sessionId"));
    }
    let number = draft.global()?.get(c"Number")?;
    if !number.get(c"isFinite")?.call(number, &[at])?.truthy()? {
        return Err(at.type_error("outbox timestamps must be finite numbers"));
    }
    let payload = normal(payload)?;
    let payload_hash = hash(payload, crypto, false)?;
    let source = normal(source)?;
    let outbox = draft.get(c"outbox")?;
    let existing = outbox.get_key(id)?;
    if existing.truthy()? {
        if existing.get(c"sessionId")?.equals(session_id)?
            && existing.get(c"payloadHash")?.equals(payload_hash)?
        {
            return Ok(existing);
        }
        return Err(conflict.construct(&[id])?.throw_error());
    }
    let seq = draft.get(c"nextOutboxSequence")?.number()?;
    draft.assign(c"nextOutboxSequence", val(draft, V::Number(seq + 1.0))?)?;
    let item = object(draft)?;
    for (name, value) in [
        (c"id", id),
        (c"sessionId", session_id),
        (c"sequence", val(draft, V::Number(seq))?),
        (c"state", text(draft, "pending")?),
        (c"payload", payload),
        (c"payloadHash", payload_hash),
        (c"source", source),
        (c"attempts", val(draft, V::Number(0.0))?),
        (c"availableAt", at),
        (c"createdAt", at),
        (c"updatedAt", at),
        (c"leasedAt", null(draft)?),
        (c"leasedUntil", null(draft)?),
        (c"leaseOwner", null(draft)?),
        (c"leaseTokenHash", null(draft)?),
        (c"deliveredAt", null(draft)?),
        (c"deadLetterAt", null(draft)?),
        (c"lastError", null(draft)?),
    ] {
        set(item, name, value)?;
    }
    assign_key(outbox, id, item)?;
    Ok(item)
}

#[napi]
// Separate live ports preserve host callback order and original exception identity.
#[allow(clippy::too_many_arguments)]
pub fn operation_admit_live(
    env: Env,
    draft: Unknown<'_>,
    action: String,
    input: Unknown<'_>,
    clock: Unknown<'_>,
    crypto: Unknown<'_>,
    default_crypto: Unknown<'_>,
    conflict: Unknown<'_>,
    outbox_conflict: Unknown<'_>,
) -> Result<sys::napi_value> {
    let draft = L::new(&env, draft);
    let input = L::new(&env, input);
    let clock = L::new(&env, clock);
    let crypto = L::new(&env, crypto);
    let default_crypto = L::new(&env, default_crypto);
    let conflict = L::new(&env, conflict);
    let outbox_conflict = L::new(&env, outbox_conflict);
    let id = input.get(c"operationId")?;
    let owner = if action == "detached" {
        input.get(c"sessionId")?
    } else {
        input.get(c"ownerSessionId")?
    };
    let mut external_id = null(draft)?;
    if action == "detached" {
        if id.nullish()? {
            let value = if id.undefined()? { "undefined" } else { "null" };
            return Err(id.type_error(&format!(
                "Cannot read properties of {value} (reading 'replace')"
            )));
        }
        let replace = id.get(c"replace")?;
        if replace.kind()? != sys::ValueType::napi_function {
            return Err(id.type_error("operationId.replace is not a function"));
        }
        let first = regexp_literal(draft, "/^op_/")?;
        let a = replace.call(id, &[first, text(draft, "")?])?;
        let replace = a.get(c"replace")?;
        if replace.kind()? != sys::ValueType::napi_function {
            return Err(a.type_error("operationId.replace(...).replace is not a function"));
        }
        let second = regexp_literal(draft, "/[^A-Za-z0-9_-]/g")?;
        let b = replace.call(a, &[second, text(draft, "")?])?;
        let slice = b.get(c"slice")?;
        if slice.kind()? != sys::ValueType::napi_function {
            return Err(
                b.type_error("operationId.replace(...).replace(...).slice is not a function")
            );
        }
        let sliced = slice.call(
            b,
            &[val(draft, V::Number(0.0))?, val(draft, V::Number(48.0))?],
        )?;
        external_id = surrounded(draft, "d_", &sliced.coerce_string()?, "")?;
    }
    let spec = normal(input.get(c"spec")?)?;
    let request_hash = hash(spec, crypto, false)?;
    let key = input.get(c"idempotencyKey")?;
    let key_hash = if key.truthy()? {
        hash(key, crypto, true)?
    } else {
        null(draft)?
    };
    let operations = draft.get(c"operations")?;
    let kind = text(draft, &action)?;
    let mut existing = null(draft)?;
    if key_hash.truthy()? {
        let select = draft.get(c"select")?;
        let rows = if select.kind()? == sys::ValueType::napi_function {
            let where_ = object(draft)?;
            set(where_, c"kind", kind)?;
            set(where_, c"ownerSessionId", owner)?;
            set(where_, c"idempotencyKeyHash", key_hash)?;
            let options = object(draft)?;
            set(options, c"where", where_)?;
            select.call(draft, &[text(draft, "operations")?, options])?
        } else {
            let object_ctor = draft.global()?.get(c"Object")?;
            object_ctor
                .get(c"values")?
                .call(object_ctor, &[operations])?
        };
        let n = rows.get(c"length")?.number()? as u32;
        for index in 0..n {
            let candidate = rows.element(index)?;
            if candidate.get(c"kind")?.equals(kind)?
                && candidate.get(c"ownerSessionId")?.equals(owner)?
                && candidate.get(c"idempotencyKeyHash")?.equals(key_hash)?
            {
                existing = candidate;
                break;
            }
        }
    }
    let idempotent = existing.truthy()?;
    let operation = if idempotent {
        if !existing.get(c"requestHash")?.equals(request_hash)? {
            return Ok(throw(
                conflict,
                text(
                    draft,
                    &format!("{action} idempotency key was already used with different content"),
                )?,
                existing.get(c"id")?,
            )?
            .raw());
        }
        existing
    } else {
        if operations.get_key(id)?.truthy()? {
            let message = surrounded(draft, "operation ", &id.coerce_string()?, " already exists")?;
            return Ok(throw(conflict, message, id)?.raw());
        }
        let at = now(draft, clock)?;
        let operation = object(draft)?;
        let result_session = input.get(c"resultSessionId")?;
        let result_session = if result_session.truthy()? {
            result_session
        } else {
            owner
        };
        for (name, value) in [
            (c"id", id),
            (c"kind", kind),
            (c"ownerSessionId", owner),
            (c"resultSessionId", result_session),
            (c"status", text(draft, "admitted")?),
            (c"idempotencyKeyHash", key_hash),
            (c"requestHash", request_hash),
            (c"resultHash", null(draft)?),
            (c"spec", spec),
            (c"externalId", external_id),
            (c"requestOutboxId", null(draft)?),
            (c"resultOutboxId", null(draft)?),
            (c"createdAt", at),
            (c"updatedAt", at),
            (c"startedAt", null(draft)?),
            (c"completedAt", null(draft)?),
            (c"cancelledAt", null(draft)?),
            (c"lastError", null(draft)?),
        ] {
            set(operation, name, value)?;
        }
        assign_key(operations, id, operation)?;
        operation
    };
    if action == "dispatch" && !operation.get(c"requestOutboxId")?.truthy()? {
        let item = admit_outbox(draft, operation, clock, default_crypto, outbox_conflict)?;
        operation.assign(c"requestOutboxId", item.get(c"id")?)?;
        operation.assign(c"updatedAt", now(draft, clock)?)?;
    }
    let result = object(draft)?;
    result.spread_from(public(operation)?)?;
    result.set(c"idempotent", val(draft, V::Bool(idempotent))?)?;
    Ok(result.raw())
}
