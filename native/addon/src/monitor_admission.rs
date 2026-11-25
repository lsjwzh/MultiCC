//! Keep async delivery and Promise scheduling on the JS thread. Each step
//! borrows the current reply and events without holding handles across await.
use crate::js_live::LiveValue as L;
use multicc_core::{
    js::JsValue as V,
    monitor_admission::{self, BLOCK_REASON},
};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;

#[napi]
pub const MONITOR_CALLBACK_ID: &str = monitor_admission::CALLBACK_ID;

#[napi]
pub fn monitor_admission_events(
    env: Env,
    input: Unknown<'_>,
    is_own: Unknown<'_>,
    has_frame: Unknown<'_>,
) -> Result<sys::napi_value> {
    let input = L::new(&env, input);
    let empty = input.from_value(&V::Null)?;
    let source = input.optional(c"source")?;
    if source.is_string("user")?
        || source.is_string("sdk")?
        || L::new(&env, is_own)
            .call_plain(&[input.optional(c"prompt")?])?
            .truthy()?
    {
        return Ok(empty.raw());
    }
    let prompt = input.optional(c"prompt")?;
    if !input
        .optional(c"hook_event_name")?
        .is_string("UserPromptSubmit")?
    {
        return Ok(empty.raw());
    }
    // Check V8's code-unit length before copying unsolicited prompt text.
    if prompt.kind()? != sys::ValueType::napi_string
        || prompt.get(c"length")?.number()? > monitor_admission::MAX_PROMPT_UNITS as f64
    {
        return Ok(empty.raw());
    }
    // Ordinary CLI prompts can be large; let V8 inspect its own string first.
    let framed = L::new(&env, has_frame).call_plain(&[
        prompt,
        input.from_value(&V::string(monitor_admission::OPEN))?,
        input.from_value(&V::string(monitor_admission::CLOSE))?,
    ])?;
    if !framed.truthy()? {
        return Ok(empty.raw());
    }
    let rows = monitor_admission::notifications(&prompt.coerce_string()?);
    if rows.is_empty() {
        return Ok(empty.raw());
    }
    let events = input.from_value(&V::Array(vec![]))?;
    let mut valid = true;
    for (index, row) in rows.into_iter().enumerate() {
        let Some(row) = row else {
            valid = false;
            continue;
        };
        let event = input.from_value(&row)?;
        if input.get(c"prompt_id")?.truthy()? {
            let mut id = input.get(c"prompt_id")?.coerce_string()?;
            id.push(&multicc_core::js::JsString::from(
                format!(":{index}").as_str(),
            ));
            event.set(c"event_id", input.from_value(&V::String(id))?)?;
        }
        events.set_element(index as u32, event)?;
    }
    Ok(if valid { events } else { empty }.raw())
}

#[napi]
pub fn monitor_delivery_step(
    env: Env,
    events: Unknown<'_>,
    index: u32,
    reply: Unknown<'_>,
    copy: Unknown<'_>,
) -> Result<sys::napi_value> {
    let events = L::new(&env, events);
    let count = events.get(c"length")?.number()? as u32;
    let step = events.from_value(&V::Object(vec![]))?;
    let position = index as u64;
    let count = u64::from(count);
    if count == 0
        || (position > 0
            && position <= count
            && !L::new(&env, reply).optional(c"monitorOwned")?.truthy()?)
    {
        step.set(c"outcome", events.from_value(&V::Object(vec![]))?)?;
    } else if position < count {
        let probe = L::new(&env, copy).call_plain(&[events.element(index)?])?;
        probe.set(c"probe", events.from_value(&V::Bool(true))?)?;
        step.set(c"event", probe)?;
    } else if position < 2 * count {
        step.set(c"event", events.element((position - count) as u32)?)?;
    } else {
        let output = V::object(vec![
            ("hookEventName", V::string("UserPromptSubmit")),
            ("suppressOriginalPrompt", V::Bool(true)),
        ]);
        let blocked = V::object(vec![
            ("decision", V::string("block")),
            ("reason", V::string(BLOCK_REASON)),
            ("hookSpecificOutput", output),
        ]);
        step.set(c"outcome", events.from_value(&blocked)?)?;
    }
    Ok(step.raw())
}

#[napi]
pub fn monitor_handoff_result(
    env: Env,
    input: Unknown<'_>,
    includes_reason: Unknown<'_>,
) -> Result<sys::napi_value> {
    let input = L::new(&env, input);
    if !input.optional(c"type")?.is_string("result")?
        || !input
            .get(c"origin")?
            .optional(c"kind")?
            .is_string("task-notification")?
        || !input.get(c"num_turns")?.is_number(0.0)?
        || input.get(c"result")?.kind()? != sys::ValueType::napi_string
    {
        return Ok(input.from_value(&V::Bool(false))?.raw());
    }
    // The second getter can return a different value. Calling the live method
    // in V8 preserves the return object and the engine's exact TypeError.
    Ok(L::new(&env, includes_reason)
        .call_plain(&[input, input.from_value(&V::string(BLOCK_REASON))?])?
        .raw())
}
