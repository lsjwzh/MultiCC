//! JavaScript-hosted compatibility bridge for the Rust scheduling transition.
//! Reads and writes the legacy draft lazily, preserving property and clock order.
use crate::js_live::LiveValue as L;
use multicc_core::js::JsValue as V;
use napi::bindgen_prelude::Unknown;
use napi::{Env, Result};
use napi_derive::napi;

#[napi]
pub fn schedule_settle_live(
    env: Env,
    draft: Unknown<'_>,
    session_id: Unknown<'_>,
    request_id: Unknown<'_>,
    clock: Unknown<'_>,
) -> Result<napi::sys::napi_value> {
    let draft = L::new(&env, draft);
    let session_id = L::new(&env, session_id);
    let request_id = L::new(&env, request_id);
    let clock = L::new(&env, clock);
    let schedule = draft.get(c"sessionSchedules")?.get_key(session_id)?;
    let ok = || draft.from_value(&V::object(vec![("ok", true.into())]));
    if !schedule.truthy()? {
        return Ok(ok()?.raw());
    }
    let fail = |code: &str| {
        draft.from_value(&V::object(vec![
            ("ok", false.into()),
            ("code", V::string(code)),
        ]))
    };
    if schedule.get(c"active")?.truthy()? {
        return Ok(fail("stale_classification")?.raw());
    }
    let awaiting = schedule.get(c"awaitingRequestId")?;
    if awaiting.truthy()? && !awaiting.equals(request_id)? {
        return Ok(fail("request_id_mismatch")?.raw());
    }
    let null = draft.from_value(&V::Null)?;
    schedule.assign(c"awaitingRequestId", null)?;
    schedule.assign(c"classifyState", draft.from_value(&V::string("D"))?)?;
    schedule.assign(c"state", draft.from_value(&V::string("idle"))?)?;
    schedule.assign(c"freezeReason", null)?;
    let prior = schedule.get(c"lastDecision")?;
    let decision = draft.from_value(&V::object(Vec::<(&str, V)>::new()))?;
    decision.spread_from(prior)?;
    decision.set(
        c"action",
        draft.from_value(&V::string("dismiss_user_input"))?,
    )?;
    decision.set(c"requestId", request_id)?;
    decision.set(c"actor", draft.from_value(&V::string("user"))?)?;
    let at = clock.call_plain(&[])?.explicit_number()?;
    decision.set(c"at", draft.from_value(&V::Number(at))?)?;
    schedule.assign(c"lastDecision", decision)?;
    let updated_at = clock.call_plain(&[])?.explicit_number()?;
    schedule.assign(c"updatedAt", draft.from_value(&V::Number(updated_at))?)?;
    Ok(ok()?.raw())
}
