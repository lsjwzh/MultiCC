//! The dispatch owner's terminal-target rules, reading live host records.
//!
//! The record map stays in Node (it is the live session registry), so these
//! commands take it as a port and perform the same gets, in the same order,
//! the retired `src/dispatch/terminal-target-policy.js` performed: a record
//! wrapped in a Proxy observes an unchanged access sequence. The decisions
//! themselves — the gateway relation and explicit targeting — live in
//! `multicc_core::terminal_target`.
use crate::js_live::LiveValue;
use multicc_core::js::{JsString, JsValue};
use multicc_core::terminal_target::{explicitly_names_terminal, legacy_gateway_terminal_id};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;

/// `value == null ? '' : String(value).trim()`, kept as UTF-16 code units so
/// an isolated surrogate in a label survives the comparison unchanged.
fn trimmed(value: LiveValue<'_>) -> Result<JsString> {
    value.clean_text()?.coerce_string()
}

/// `String(value || '')`: a false-like field reads as the empty string without
/// touching a boxed primitive's prototype.
fn text_or_empty(value: LiveValue<'_>) -> Result<JsString> {
    if value.truthy()? {
        value.coerce_string()
    } else {
        Ok(JsString::new())
    }
}

/// The terminal a dispatch target executes on, or null.
///
/// A terminal record is its own terminal. Otherwise the explicit `gatewayFor`
/// wins, and the legacy `-gw-chat` id is still computed unconditionally
/// afterwards, exactly as the host's `||` did, so the reads a hostile record
/// observes do not change with the branch taken.
fn terminal_for_record<'a>(records: LiveValue<'a>, record: LiveValue<'a>) -> Result<LiveValue<'a>> {
    let null = record.from_value(&JsValue::Null)?;
    if !record.truthy()? || !records.truthy()? {
        return Ok(null);
    }
    if records.get(c"get")?.kind()? != sys::ValueType::napi_function {
        return Ok(null);
    }
    if record.get(c"kind")?.is_string("terminal")? {
        return Ok(record);
    }
    let explicit_id = trimmed(record.get(c"gatewayFor")?)?;
    // The legacy id is computed unconditionally, exactly as the host's `||`
    // did, so the reads a hostile record observes do not change with the
    // branch that wins.
    let legacy_id =
        if record.get(c"kind")?.is_string("chat")? && record.get(c"ephemeral")?.is_true()? {
            legacy_gateway_terminal_id(&text_or_empty(record.get(c"id")?)?).unwrap_or_default()
        } else {
            JsString::new()
        };
    let terminal_id = if explicit_id.is_empty() {
        legacy_id
    } else {
        explicit_id
    };
    if terminal_id.is_empty() {
        return Ok(null);
    }
    let key = record.from_value(&JsValue::String(terminal_id))?;
    let terminal = records.get(c"get")?.call(records, &[key])?;
    if !terminal.truthy()?
        || !terminal.get(c"kind")?.is_string("terminal")?
        || !terminal.get(c"dirId")?.equals(record.get(c"dirId")?)?
    {
        return Ok(null);
    }
    Ok(terminal)
}

#[napi]
pub fn dispatch_terminal_for_record(
    env: Env,
    records: Unknown<'_>,
    record: Unknown<'_>,
) -> Result<sys::napi_value> {
    let records = LiveValue::new(&env, records);
    Ok(terminal_for_record(records, LiveValue::new(&env, record))?.raw())
}

/// A terminal gateway is an execution detail, never a second worker choice.
#[napi]
pub fn dispatch_is_terminal_gateway(
    env: Env,
    records: Unknown<'_>,
    record: Unknown<'_>,
) -> Result<bool> {
    let records = LiveValue::new(&env, records);
    let record = LiveValue::new(&env, record);
    if !record.truthy()? || !record.get(c"kind")?.is_string("chat")? {
        return Ok(false);
    }
    terminal_for_record(records, record)?.truthy()
}

/// Whether the originating user text named this terminal outright.
#[napi]
pub fn dispatch_explicitly_names_terminal(
    env: Env,
    user_text: Unknown<'_>,
    terminal: Unknown<'_>,
) -> Result<bool> {
    let user_text = LiveValue::new(&env, user_text);
    let terminal = LiveValue::new(&env, terminal);
    let text = trimmed(user_text)?;
    if text.is_empty() || !terminal.truthy()? {
        return Ok(false);
    }
    let id = trimmed(terminal.get(c"id")?)?;
    let label = trimmed(terminal.get(c"label")?)?;
    Ok(explicitly_names_terminal(&text, &id, &label))
}
