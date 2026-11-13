//! Live adapter for the wait cancellation state machine. JavaScript values are
//! borrowed so property keys, getters, clocks and exceptions retain their order.
use crate::js_live::LiveValue as L;
use multicc_core::js::JsValue as V;
use napi::{bindgen_prelude::Unknown, Env, Result};
use napi_derive::napi;

#[napi]
pub fn wait_cancel_live(
    env: Env,
    draft: Unknown<'_>,
    id: Unknown<'_>,
    clock: Unknown<'_>,
) -> Result<napi::sys::napi_value> {
    let draft = L::new(&env, draft);
    let id = L::new(&env, id);
    let clock = L::new(&env, clock);
    let wait = draft.get(c"waits")?.get_key(id)?;
    if !wait.truthy()? {
        return Ok(draft
            .from_value(&V::object(vec![
                ("ok", false.into()),
                ("code", V::string("not_found")),
            ]))?
            .raw());
    }
    if wait.get(c"status")?.is_string("cancelled")? {
        return Ok(draft
            .from_value(&V::object(vec![
                ("ok", true.into()),
                ("idempotent", true.into()),
            ]))?
            .raw());
    }
    if !wait.get(c"status")?.is_string("pending")? {
        let result = draft.from_value(&V::object(vec![
            ("ok", false.into()),
            ("code", V::string("not_pending")),
        ]))?;
        result.set(c"status", wait.get(c"status")?)?;
        return Ok(result.raw());
    }
    let at = draft.from_value(&V::Number(clock.call_plain(&[])?.explicit_number()?))?;
    wait.assign(c"status", draft.from_value(&V::string("cancelled"))?)?;
    wait.assign(c"cancelledAt", at)?;
    wait.assign(c"updatedAt", at)?;
    Ok(draft
        .from_value(&V::object(vec![
            ("ok", true.into()),
            ("idempotent", false.into()),
        ]))?
        .raw())
}
