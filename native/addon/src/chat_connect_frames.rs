use crate::js_live::LiveValue;
use multicc_core::{chat_history_frame, js::JsValue};
use napi::{
    bindgen_prelude::{FromNapiValue, ToNapiValue, Unknown},
    sys, Env, Result,
};
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

#[napi]
pub const CHAT_HISTORY_MAX_BYTES: u32 = chat_history_frame::DEFAULT_MAX_BYTES as u32;
#[napi]
pub const CHAT_HISTORY_TOOL_STRING_CHARS: u32 =
    chat_history_frame::DEFAULT_TOOL_STRING_CHARS as u32;

fn json_frame_request(request: LiveValue<'_>) -> Result<String> {
    let json = request.global()?.get(c"JSON")?;
    let encoded = json.get(c"stringify")?.call(json, &[request])?;
    unsafe { String::from_napi_value(encoded.env(), encoded.raw()) }
}

// JSON would turn an unlimited budget into null, which the kernel reads as zero.
fn frame_limit(value: LiveValue<'_>) -> Result<LiveValue<'_>> {
    if value.is_number(f64::INFINITY)? {
        value.from_value(&JsValue::Number(9_007_199_254_740_991.0))
    } else {
        Ok(value)
    }
}

#[napi]
pub fn chat_fit_history_frame(
    env: Env,
    messages: Unknown<'_>,
    sizes: Unknown<'_>,
    has_more: bool,
    max_bytes: Unknown<'_>,
    options: Unknown<'_>,
) -> Result<sys::napi_value> {
    let list = LiveValue::new(&env, messages);
    let request = list.from_value(&JsValue::Object(Vec::new()))?;
    request.set(c"sizes", LiveValue::new(&env, sizes))?;
    request.set(c"hasMore", list.from_value(&JsValue::Bool(has_more))?)?;
    let max = LiveValue::new(&env, max_bytes);
    if !max.undefined()? {
        request.set(c"maxBytes", frame_limit(max)?)?;
    }
    let plan = chat_history_frame::plan_request(&json_frame_request(request)?)
        .map_err(napi::Error::from_reason)?;
    let dropped = list.from_value(&JsValue::Number(plan.dropped as f64))?;
    let mut kept = list;
    if plan.dropped > 0 {
        kept = list.get(c"slice")?.call(list, &[dropped])?;
    }
    // Most reconnects do not clip. Do not serialize the retained page or
    // touch its toolStringChars getter unless the size-only plan requests it.
    if plan.clipped {
        let clip = list.from_value(&JsValue::Object(Vec::new()))?;
        clip.set(c"messages", kept)?;
        let options = LiveValue::new(&env, options);
        if options.truthy()? && !options.get(c"toolStringChars")?.undefined()? {
            clip.set(
                c"toolStringChars",
                frame_limit(options.get(c"toolStringChars")?)?,
            )?;
        }
        let clipped = chat_history_frame::clip_page_json(&json_frame_request(clip)?)
            .map_err(napi::Error::from_reason)?;
        let json = list.global()?.get(c"JSON")?;
        let text = LiveValue::from_raw(list.env(), unsafe {
            String::to_napi_value(list.env(), clipped)?
        });
        kept = json.get(c"parse")?.call(json, &[text])?;
    }
    let result = list.from_value(&JsValue::Object(Vec::new()))?;
    result.set(c"messages", kept)?;
    result.set(c"hasMore", list.from_value(&JsValue::Bool(plan.has_more))?)?;
    result.set(c"dropped", dropped)?;
    result.set(c"clipped", list.from_value(&JsValue::Bool(plan.clipped))?)?;
    Ok(result.raw())
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
