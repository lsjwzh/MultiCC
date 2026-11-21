//! Live, strict mutations keep host object identity and accessor ordering.
use crate::js_live::LiveValue as L;
use multicc_core::{js::JsValue, zcode_session};
use napi::{bindgen_prelude::Unknown, Env, Result};
use napi_derive::napi;
use std::ffi::CStr;

#[napi]
pub fn is_zcode_session_id(env: Env, value: Unknown<'_>) -> Result<bool> {
    Ok(L::new(&env, value)
        .string()?
        .is_some_and(|value| zcode_session::is_session_id(&value)))
}

fn clear(record: L<'_>, key: &CStr) -> Result<bool> {
    if record.truthy()?
        && record
            .get(key)?
            .string()?
            .is_some_and(|value| zcode_session::is_legacy_bridge_id(&value))
    {
        record.assign(key, record.from_value(&JsValue::Null)?)?;
        return Ok(true);
    }
    Ok(false)
}

#[napi]
pub fn repair_zcode_session_state(env: Env, session: Unknown<'_>) -> Result<bool> {
    let session = L::new(&env, session);
    let mut changed = false;
    if session.get(c"cli")?.is_string("zcode")? {
        changed |= clear(session, c"cliSessionId")?;
        changed |= clear(session, c"_streamSessionId")?;
    }
    // The old two optional chains each read cliStates, even after a mutation.
    changed |= clear(
        session.get(c"cliStates")?.optional(c"zcode")?,
        c"cliSessionId",
    )?;
    changed |= clear(
        session.get(c"cliStates")?.optional(c"zcode")?,
        c"streamSessionId",
    )?;
    Ok(changed)
}
