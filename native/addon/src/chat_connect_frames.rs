use crate::js_live::LiveValue;
use multicc_core::js::JsValue;
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;

/// What the connect-time `chat_history` byte budget decides, from the
/// per-message sizes alone: how many of the oldest messages to drop, whether
/// the page must offer the rest over HTTP, and whether to clip tool strings.
///
/// Only numbers cross this bridge. Copying the page itself was measured at 55x
/// the retired JavaScript on an 896 KB page (5.48 ms against 0.10 ms) and is
/// paid on every reconnect, so the caller applies the slice in place and the
/// page's array identity survives when nothing is dropped.
#[napi]
pub fn chat_history_frame_plan(input: String) -> Result<String> {
    multicc_core::chat_history_frame::plan_json(&input).map_err(napi::Error::from_reason)
}

/// Clip oversized tool strings in the messages that survived the drop. Only
/// reached when the plan asked for it, which means the page is still over
/// budget with one message left -- a rare path whose whole point is to rewrite
/// bytes. The persisted transcript is untouched; this is the replay copy.
#[napi]
pub fn chat_history_frame_clip(input: String) -> Result<String> {
    multicc_core::chat_history_frame::clip_page_json(&input).map_err(napi::Error::from_reason)
}

/// Whether to build a connect-time `task_state` seed.
#[napi]
pub fn chat_task_state_should_seed(input: String) -> Result<bool> {
    multicc_core::chat_task_state_frame::should_seed_json(&input).map_err(napi::Error::from_reason)
}

/// The shared `task_state` payload, for the live broadcast that does not gate
/// on a judgement existing.
#[napi]
pub fn chat_task_state_payload(input: String) -> Result<String> {
    multicc_core::chat_task_state_frame::payload_json(&input).map_err(napi::Error::from_reason)
}

/// The live broadcast and the connect-time seed share this fact reader.
#[napi]
pub fn chat_task_state_frame(
    env: Env,
    task: Unknown<'_>,
    seed_only: bool,
    short_code: Unknown<'_>,
    staleness: Unknown<'_>,
) -> Result<sys::napi_value> {
    let task = LiveValue::new(&env, task);
    let json = task.global()?.get(c"JSON")?;
    let envelope = task.from_value(&JsValue::Object(Vec::new()))?;
    envelope.set(c"task", task)?;
    let encode = |input| -> Result<String> {
        Ok(json
            .get(c"stringify")?
            .call(json, &[input])?
            .coerce_string()?
            .to_string_lossy())
    };
    // The short code registry can persist a new code. Only consult it once
    // the original task has passed the seed gate.
    if seed_only && !chat_task_state_should_seed(encode(envelope)?)? {
        return Ok(task.from_value(&JsValue::Null)?.raw());
    }

    let facts = task.from_value(&JsValue::Object(Vec::new()))?;
    let record = if task.truthy()? { task } else { facts };
    let code = LiveValue::new(&env, short_code).call_plain(&[record.get(c"taskId")?])?;
    let health = LiveValue::new(&env, staleness).call_plain(&[])?;
    facts.set(
        c"taskShortCode",
        if code.truthy()? {
            code
        } else {
            task.from_value(&JsValue::string(""))?
        },
    )?;
    facts.set(c"auxUnhealthy", health.get(c"auxUnhealthy")?)?;
    facts.set(c"auxUnhealthySince", health.get(c"auxUnhealthySince")?)?;
    if task.nullish()? {
        envelope.set(c"task", task.from_value(&JsValue::Undefined)?)?;
    }
    envelope.set(c"facts", facts)?;
    let encoded = chat_task_state_payload(encode(envelope)?)?;
    let frame = json
        .get(c"parse")?
        .call(json, &[task.from_value(&JsValue::string(&encoded))?])?;
    if !frame.get(c"apiError")?.nullish()? {
        frame.set(c"apiError", task.get(c"apiError")?)?;
    }
    Ok(frame.raw())
}

/// The ordered plan for one `/ws/chat` connect: the `chat_history` frame, the
/// task-state seed, the buffer clear that prevents a duplicate bubble, and the
/// replay burst. The caller owns the sockets and the history read.
#[napi]
pub fn chat_connect_replay_plan(input: String) -> Result<String> {
    multicc_core::chat_connect_replay::plan_json(&input).map_err(napi::Error::from_reason)
}
