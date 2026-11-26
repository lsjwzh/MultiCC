//! Keep async delivery and Promise scheduling on the JS thread. Each step
//! borrows the current reply and events without holding handles across await.
use crate::{
    host_methods::{call, method},
    js_iteration::read,
    js_live::{fields, invoke, spread, LiveValue as L},
    route_response::{flag, num, text},
};
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
    Ok(events(input, L::new(&env, is_own), Some(L::new(&env, has_frame)))?.raw())
}

fn events<'a>(input: L<'a>, is_own: L<'a>, has_frame: Option<L<'a>>) -> Result<L<'a>> {
    let empty = input.from_value(&V::Null)?;
    let source = input.optional(c"source")?;
    if source.is_string("user")? || source.is_string("sdk")? || {
        let prompt = input.optional(c"prompt")?;
        !is_own.undefined()?
            && invoke(
                input.from_value(&V::Undefined)?,
                is_own,
                &[prompt],
                "isOwnPrompt",
            )?
            .truthy()?
    } {
        return Ok(empty);
    }
    let prompt = input.optional(c"prompt")?;
    if !input
        .optional(c"hook_event_name")?
        .is_string("UserPromptSubmit")?
    {
        return Ok(empty);
    }
    // Check V8's code-unit length before copying unsolicited prompt text.
    if prompt.kind()? != sys::ValueType::napi_string
        || prompt.get(c"length")?.number()? > monitor_admission::MAX_PROMPT_UNITS as f64
    {
        return Ok(empty);
    }
    // Ordinary CLI prompts can be large; let V8 inspect its own string first.
    let open = input.from_value(&V::string(monitor_admission::OPEN))?;
    let close = input.from_value(&V::string(monitor_admission::CLOSE))?;
    let framed = if let Some(f) = has_frame {
        f.call_plain(&[prompt, open, close])?.truthy()?
    } else {
        call(prompt, c"startsWith", &[open])?.truthy()?
            && call(prompt, c"includes", &[close])?.truthy()?
    };
    if !framed {
        return Ok(empty);
    }
    let rows = monitor_admission::notifications(&prompt.coerce_string()?);
    if rows.is_empty() {
        return Ok(empty);
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
    Ok(if valid { events } else { empty })
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
    Ok(step(events, index, L::new(&env, reply), Some(L::new(&env, copy)))?.raw())
}
fn step<'a>(events: L<'a>, index: u32, reply: L<'a>, copy: Option<L<'a>>) -> Result<L<'a>> {
    let count = events.get(c"length")?.number()? as u32;
    let step = events.from_value(&V::Object(vec![]))?;
    let position = index as u64;
    let count = u64::from(count);
    if count == 0
        || (position > 0 && position <= count && !reply.optional(c"monitorOwned")?.truthy()?)
    {
        step.set(c"outcome", events.from_value(&V::Object(vec![]))?)?;
    } else if position < count {
        let row = events.element(index)?;
        let probe = match copy {
            Some(f) => f.call_plain(&[row])?,
            None => spread(row)?,
        };
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
    Ok(step)
}

#[napi]
pub fn monitor_handoff_result(
    env: Env,
    input: Unknown<'_>,
    includes_reason: Unknown<'_>,
) -> Result<sys::napi_value> {
    let input = L::new(&env, input);
    Ok(handoff(input, Some(L::new(&env, includes_reason)))?.raw())
}
fn handoff<'a>(input: L<'a>, includes: Option<L<'a>>) -> Result<L<'a>> {
    if !input.optional(c"type")?.is_string("result")?
        || !input
            .get(c"origin")?
            .optional(c"kind")?
            .is_string("task-notification")?
        || !input.get(c"num_turns")?.is_number(0.0)?
        || input.get(c"result")?.kind()? != sys::ValueType::napi_string
    {
        return flag(input, false);
    }
    // The second getter can return a different value. Calling the live method
    // in V8 preserves the return object and the engine's exact TypeError.
    let reason = text(input, BLOCK_REASON)?;
    if let Some(f) = includes {
        return f.call_plain(&[input, reason]);
    }
    let result = input.get(c"result")?;
    invoke(
        result,
        read(result, c"includes")?,
        &[reason],
        "event.result.includes",
    )
}

fn next<'a>(s: L<'a>, reply: L<'a>) -> Result<L<'a>> {
    let index = s.get(c"index")?.number()? as u32;
    let current = step(s.get(c"events")?, index, reply, None)?;
    if current.has(c"outcome")? {
        return current.get(c"outcome");
    }
    let pending = invoke(
        s.from_value(&V::Undefined)?,
        s.get(c"deliver")?,
        &[current.get(c"event")?],
        "deliver",
    )?;
    let promise = call(s.global()?.get(c"Promise")?, c"resolve", &[pending])?;
    s.set(c"index", num(s, f64::from(index) + 1.)?)?;
    call(promise, c"then", &[s.get(c"next")?])
}
pub(crate) fn run_hook<'a>(owner: L<'a>, input: L<'a>) -> Result<L<'a>> {
    let pending = (|| {
        let rows = events(input, owner.get(c"isOwn")?, None)?;
        if rows.nullish()? {
            return fields(owner, &[]);
        }
        let state = fields(
            owner,
            &[
                ("deliver", owner.get(c"deliver")?),
                ("index", num(owner, 0.)?),
                ("events", rows),
            ],
        )?;
        let env = Env::from_raw(owner.env());
        state.set(
            c"next",
            method(&env, state, "", 1, 1, |s, a| next(s, a[0]))?,
        )?;
        next(state, owner.from_value(&V::Undefined)?)
    })();
    match pending {
        Ok(value) => call(owner.global()?.get(c"Promise")?, c"resolve", &[value]),
        Err(error) => {
            let cause = match owner.exception_value()? {
                Some(cause) => cause,
                None => owner
                    .global()?
                    .get(c"Error")?
                    .construct(&[text(owner, &error.reason)?])?,
            };
            call(owner.global()?.get(c"Promise")?, c"reject", &[cause])
        }
    }
}
#[napi]
pub fn monitor_admission_api(env: Env, anchor: Unknown<'_>) -> Result<sys::napi_value> {
    let api = L::new(&env, anchor);
    Ok(fields(
        api,
        &[
            ("CALLBACK_ID", text(api, MONITOR_CALLBACK_ID)?),
            (
                "isMonitorHandoffResult",
                method(&env, api, "isMonitorHandoffResult", 1, 1, |_, a| {
                    handoff(a[0], None)
                })?,
            ),
            (
                "createMonitorAdmission",
                method(&env, api, "createMonitorAdmission", 1, 2, |api, a| {
                    let state = fields(api, &[("deliver", a[0]), ("isOwn", a[1])])?;
                    let env = Env::from_raw(api.env());
                    let hook = method(&env, state, "", 1, 1, |s, a| run_hook(s, a[0]))?;
                    Ok(L::from_raw(api.env(), hook.raw()))
                })?,
            ),
        ],
    )?
    .raw())
}
