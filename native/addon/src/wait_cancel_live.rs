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
    Ok(cancel(L::new(&env, draft), L::new(&env, id), L::new(&env, clock))?.raw())
}

pub(crate) fn cancel<'a>(draft: L<'a>, id: L<'a>, clock: L<'a>) -> Result<L<'a>> {
    let wait = draft.get(c"waits")?.get_key(id)?;
    if !wait.truthy()? {
        return draft.from_value(&V::object(vec![
            ("ok", false.into()),
            ("code", V::string("not_found")),
        ]));
    }
    if wait.get(c"status")?.is_string("cancelled")? {
        return draft.from_value(&V::object(vec![
            ("ok", true.into()),
            ("idempotent", true.into()),
        ]));
    }
    if !wait.get(c"status")?.is_string("pending")? {
        let result = draft.from_value(&V::object(vec![
            ("ok", false.into()),
            ("code", V::string("not_pending")),
        ]))?;
        result.set(c"status", wait.get(c"status")?)?;
        return Ok(result);
    }
    let at = draft.from_value(&V::Number(clock.call_plain(&[])?.explicit_number()?))?;
    wait.assign(c"status", draft.from_value(&V::string("cancelled"))?)?;
    wait.assign(c"cancelledAt", at)?;
    wait.assign(c"updatedAt", at)?;
    draft.from_value(&V::object(vec![
        ("ok", true.into()),
        ("idempotent", false.into()),
    ]))
}
