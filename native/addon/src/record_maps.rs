//! Map membership and file decoding belong to RustSessionRecords. Per-facade
//! observer slots are V8-visible so an observer may retain the map and still
//! be collected as a cycle.
use crate::route_response::*;
use multicc_core::js::JsString;
use napi_derive::napi;

#[napi]
pub fn new_chat_table_slot(env: Env, shared: Unknown<'_>) -> Result<sys::napi_value> {
    let shared = L::new(&env, shared);
    if !shared.truthy()? || !shared.get(c"native")?.truthy()? {
        return Err(shared.type_error("chat session owner is required"));
    }
    Ok(fields(
        shared,
        &[
            ("native", shared.get(c"native")?),
            ("forget", null(shared)?),
            ("observers", shared.from_value(&V::Array(vec![]))?),
        ],
    )?
    .raw())
}

fn notify<'a>(slot: L<'a>, key: L<'a>) -> Result<()> {
    if slot.get(c"forget")?.truthy()? {
        call(slot, c"forget", &[key])?;
    }
    slot.get(c"observers")?.for_each(|callback| {
        callback.call_plain(&[key])?;
        Ok(())
    })
}

#[napi]
pub fn chat_table_after_delete(
    env: Env,
    slot: Unknown<'_>,
    key: Unknown<'_>,
    removed: Unknown<'_>,
) -> Result<sys::napi_value> {
    let removed = L::new(&env, removed);
    if removed.truthy()? {
        notify(L::new(&env, slot), L::new(&env, key))?;
    }
    Ok(removed.raw())
}

#[napi]
pub fn chat_table_after_clear(env: Env, slot: Unknown<'_>, keys: Unknown<'_>) -> Result<()> {
    let slot = L::new(&env, slot);
    L::new(&env, keys).for_each(|key| notify(slot, key))
}

#[napi]
pub fn chat_table_hook(
    env: Env,
    slot: Unknown<'_>,
    callback: Unknown<'_>,
    append: bool,
) -> Result<()> {
    let slot = L::new(&env, slot);
    let callback = L::new(&env, callback);
    let callable = callback.kind()? == sys::ValueType::napi_function;
    if append {
        if callable {
            call(slot.get(c"observers")?, c"push", &[callback])?;
        }
        Ok(())
    } else {
        slot.set(c"forget", if callable { callback } else { null(slot)? })
    }
}

#[napi]
pub fn state_record_error(
    env: Env,
    constructor: Unknown<'_>,
    file: Unknown<'_>,
    result: Unknown<'_>,
) -> Result<sys::napi_value> {
    let file = L::new(&env, file);
    let result = L::new(&env, result);
    let detail = result.optional(c"detail")?;
    let suffix = if detail.truthy()? {
        JsString::concat(&[&": ".into(), &result.get(c"detail")?.coerce_string()?])
    } else {
        JsString::new()
    };
    let kind = result.optional(c"errorKind")?;
    let (prefix, suffix, meta) = if kind.is_string("unreadable")? {
        (
            "unreadable state file ",
            suffix,
            fields(file, &[("file", file)])?,
        )
    } else if kind.is_string("envelope")? {
        (
            "state envelope missing in ",
            JsString::new(),
            fields(file, &[("file", file)])?,
        )
    } else {
        let raw = fallback(result.optional(c"raw")?, "".into())?;
        (
            "corrupt JSON in ",
            suffix,
            fields(file, &[("file", file), ("raw", raw)])?,
        )
    };
    let message = file.from_value(&V::String(JsString::concat(&[
        &prefix.into(),
        &file.coerce_string()?,
        &suffix,
    ])))?;
    Ok(L::new(&env, constructor).construct(&[message, meta])?.raw())
}
