//! Validate live spool records in read order. Some callers supply accessors or
//! coercible IDs, and IDs in the returned envelope retain their original values.
use crate::js_live::LiveValue;
use multicc_core::{
    js::{JsString, JsValue},
    turn_ledger_contract as contract,
};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;
use std::ffi::CStr;

#[napi]
pub fn turn_ledger_vocabulary() -> String {
    contract::vocabulary().to_string()
}

fn valid_id(value: LiveValue<'_>) -> Result<bool> {
    if !value.truthy()? {
        return Ok(false);
    }
    let id = value
        .global()?
        .get(c"String")?
        .call_plain(&[value])?
        .coerce_string()?;
    Ok(contract::valid_id(&id.as_str_lossy()))
}

fn clipped(input: LiveValue<'_>, limit: usize) -> Result<Option<LiveValue<'_>>> {
    input
        .string()?
        .filter(|value| !value.is_empty())
        .map(|value| input.from_value(&JsValue::String(value.truncate_units(limit))))
        .transpose()
}

// Match Number.isInteger(field) then compare the field; keep separate reads for getters.
fn integer_field<'a>(
    input: LiveValue<'a>,
    field: &CStr,
    accepts: impl FnOnce(f64) -> bool,
) -> Result<Option<LiveValue<'a>>> {
    if input
        .get(field)?
        .number_value()?
        .is_some_and(|n| n.fract() == 0.0)
        && accepts(input.get(field)?.explicit_number()?)
    {
        Ok(Some(input.get(field)?))
    } else {
        Ok(None)
    }
}

#[napi]
pub fn turn_ledger_normalize(
    env: Env,
    raw: Unknown<'_>,
    events: Unknown<'_>,
) -> Result<sys::napi_value> {
    Ok(normalize(LiveValue::new(&env, raw), LiveValue::new(&env, events))?.raw())
}
fn normalize<'a>(raw: LiveValue<'a>, events: LiveValue<'a>) -> Result<LiveValue<'a>> {
    let null = raw.from_value(&JsValue::Null)?;
    if raw.kind()? != sys::ValueType::napi_object
        || !raw.get(c"v")?.is_number(1.0)?
        || !valid_id(raw.get(c"sessionId")?)?
        || !valid_id(raw.get(c"eventId")?)?
        || !events
            .get(c"has")?
            .call(events, &[raw.get(c"event")?])?
            .truthy()?
    {
        return Ok(null);
    }
    let ts = raw.get(c"ts")?.explicit_number()?;
    if !ts.is_finite() || ts <= 0.0 {
        return Ok(null);
    }
    let out = raw.from_value(&JsValue::Object(vec![]))?;
    out.set(c"eventId", raw.get(c"eventId")?)?;
    out.set(c"sessionId", raw.get(c"sessionId")?)?;
    out.set(
        c"epoch",
        integer_field(raw, c"epoch", |n| n >= 0.0)?.unwrap_or(raw.from_value(&0.0.into())?),
    )?;
    out.set(c"cli", clipped(raw.get(c"cli")?, 32)?.unwrap_or(null))?;
    out.set(c"event", raw.get(c"event")?)?;
    out.set(c"ts", raw.from_value(&ts.into())?)?;
    for (key, max) in [
        (c"cliSessionId", 128),
        (c"turnId", 128),
        (c"transcriptPath", 1024),
    ] {
        out.set(key, clipped(raw.get(key)?, max)?.unwrap_or(null))?;
    }
    out.set(
        c"cliPid",
        integer_field(raw, c"cliPid", |n| n > 1.0)?.unwrap_or(null),
    )?;
    for key in [
        c"source",
        c"reason",
        c"notificationType",
        c"toolName",
        c"error",
    ] {
        if let Some(value) = clipped(raw.get(key)?, 200)? {
            out.assign(key, value)?;
        }
    }
    if raw.get(c"stopHookActive")?.kind()? == sys::ValueType::napi_boolean {
        out.assign(c"stopHookActive", raw.get(c"stopHookActive")?)?;
    }
    if let Some(value) = integer_field(raw, c"backgroundTasks", |n| n >= 0.0)? {
        out.assign(c"backgroundTasks", value)?;
    }
    if let Some(value) = clipped(raw.get(c"promptHead")?, 120)? {
        out.assign(c"promptHead", value)?;
    }
    Ok(out)
}

#[napi]
pub fn turn_ledger_transition_id(
    env: Env,
    session: Unknown<'_>,
    epoch: Unknown<'_>,
    turn: Unknown<'_>,
    seq: Unknown<'_>,
    state: Unknown<'_>,
) -> Result<sys::napi_value> {
    Ok(transition_id(
        LiveValue::new(&env, session),
        LiveValue::new(&env, epoch),
        LiveValue::new(&env, turn),
        LiveValue::new(&env, seq),
        LiveValue::new(&env, state),
    )?
    .raw())
}
fn transition_id<'a>(
    session: LiveValue<'a>,
    epoch: LiveValue<'a>,
    turn: LiveValue<'a>,
    seq: LiveValue<'a>,
    state: LiveValue<'a>,
) -> Result<LiveValue<'a>> {
    let parts = [
        session.coerce_string()?,
        epoch.coerce_string()?,
        if turn.truthy()? {
            turn.coerce_string()?
        } else {
            JsString::from_rust_str("-")
        },
        seq.coerce_string()?,
        state.coerce_string()?,
    ];
    let id = JsString::join(&parts, &JsString::from_rust_str(":"));
    session.from_value(&JsValue::String(id))
}

#[napi]
pub fn turn_ledger_liveness(env: Env, ownership: Unknown<'_>) -> Result<sys::napi_value> {
    Ok(liveness(LiveValue::new(&env, ownership))?.raw())
}
fn liveness(ownership: LiveValue<'_>) -> Result<LiveValue<'_>> {
    let input = ownership.string()?;
    let (state, reason) = contract::liveness(input.as_ref().map(|s| s.as_str_lossy()).as_deref());
    let out = ownership.from_value(&JsValue::Object(vec![]))?;
    out.set(c"state", ownership.from_value(&state.into())?)?;
    out.set(c"reason", ownership.from_value(&reason.into())?)?;
    Ok(out)
}

#[napi]
pub fn turn_ledger_api(env: Env) -> Result<sys::napi_value> {
    use crate::{host_methods::method, js_live::fields};
    use napi::bindgen_prelude::ToNapiValue;
    let anchor = LiveValue::new(&env, ().into_unknown(&env)?);
    let catalog = anchor.from_value(&multicc_core::js::from_serde(&contract::vocabulary()))?;
    let set = anchor.global()?.get(c"Set")?;
    let events = set.construct(&[catalog.get(c"hookEvents")?])?;
    Ok(fields(
        catalog,
        &[
            ("HOOK_EVENTS", events),
            ("OWNERSHIP", catalog.get(c"ownership")?.freeze()?),
            ("E_REASONS", catalog.get(c"errorReasons")?.freeze()?),
            (
                "SILENT_E_REASONS",
                set.construct(&[catalog.get(c"silentErrorReasons")?])?,
            ),
            (
                "normalizeEnvelope",
                method(&env, events, "normalizeEnvelope", 1, 1, |e, a| {
                    normalize(a[0], e)
                })?,
            ),
            (
                "transitionId",
                method(&env, events, "transitionId", 1, 1, |_, a| {
                    let v = a[0];
                    transition_id(
                        v.get(c"sessionId")?,
                        v.get(c"epoch")?,
                        v.get(c"turnId")?,
                        v.get(c"seq")?,
                        v.get(c"state")?,
                    )
                })?,
            ),
            (
                "projectLiveness",
                method(&env, events, "projectLiveness", 1, 1, |_, a| liveness(a[0]))?,
            ),
        ],
    )?
    .raw())
}
