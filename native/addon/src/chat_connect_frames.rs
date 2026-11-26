use crate::{
    host_methods::{call, method},
    js_live::{fields, LiveValue},
};
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
    Ok(fit_history(
        LiveValue::new(&env, messages),
        LiveValue::new(&env, sizes),
        has_more,
        LiveValue::new(&env, max_bytes),
        LiveValue::new(&env, options),
    )?
    .raw())
}
fn fit_history<'a>(
    list: LiveValue<'a>,
    sizes: LiveValue<'a>,
    has_more: bool,
    max: LiveValue<'a>,
    options: LiveValue<'a>,
) -> Result<LiveValue<'a>> {
    let request = list.from_value(&JsValue::Object(Vec::new()))?;
    request.set(c"sizes", sizes)?;
    request.set(c"hasMore", list.from_value(&JsValue::Bool(has_more))?)?;
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
    Ok(result)
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
    Ok(task_frame(
        LiveValue::new(&env, task),
        seed_only,
        LiveValue::new(&env, short_code),
        LiveValue::new(&env, staleness),
    )?
    .raw())
}
fn task_frame<'a>(
    task: LiveValue<'a>,
    seed_only: bool,
    short_code: LiveValue<'a>,
    source: LiveValue<'a>,
) -> Result<LiveValue<'a>> {
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
        return task.from_value(&JsValue::Null);
    }

    let facts = task.from_value(&JsValue::Object(Vec::new()))?;
    let record = if task.truthy()? { task } else { facts };
    let code = crate::task_short_code::current_code(short_code, record.get(c"taskId")?)?;
    // Resolve the current provider after the short-code lookup, which may
    // re-enter the host. Legacy native callers supply an already projected getter.
    let health = if source.kind()? == sys::ValueType::napi_object {
        crate::aux_verdict_health::freshness(source.get(c"provider")?, false)?
    } else {
        source.call_plain(&[])?
    };
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
    Ok(frame)
}

/// The ordered plan for one `/ws/chat` connect: the `chat_history` frame, the
/// task-state seed, the buffer clear that prevents a duplicate bubble, and the
/// replay burst. The caller owns the sockets and the history read.
#[napi]
pub fn chat_connect_replay_plan(input: String) -> Result<String> {
    multicc_core::chat_connect_replay::plan_json(&input).map_err(napi::Error::from_reason)
}

fn message_bytes(message: LiveValue<'_>) -> Result<LiveValue<'_>> {
    let measured = message.catch(|| {
        let global = message.global()?;
        let buffer = global.get(c"Buffer")?;
        let byte_length = buffer.get(c"byteLength")?;
        let encoded = call(global.get(c"JSON")?, c"stringify", &[message])?;
        byte_length.call(buffer, &[encoded])
    })?;
    match measured {
        Some(v) => Ok(v),
        None => message.from_value(&JsValue::Number(0.)),
    }
}

#[napi]
pub fn history_frame_api(env: Env, addon: Unknown<'_>) -> Result<sys::napi_value> {
    let addon = LiveValue::new(&env, addon);
    let bytes = method(&env, addon, "messageBytes", 1, 1, |_, a| {
        message_bytes(a[0])
    })?;
    let fit = method(&env, bytes, "fitHistoryFrame", 2, 3, |bytes, a| {
        let list = if a[0].is_array()? {
            a[0]
        } else {
            a[0].from_value(&JsValue::Array(vec![]))?
        };
        let options = if a[2].undefined()? {
            fields(list, &[])?
        } else {
            a[2]
        };
        let sizes = call(list, c"map", &[bytes])?;
        let max = if options.truthy()? && !options.get(c"maxBytes")?.undefined()? {
            options.get(c"maxBytes")?
        } else {
            list.from_value(&JsValue::Undefined)?
        };
        fit_history(list, sizes, a[1].truthy()?, max, options)
    })?;
    Ok(fields(
        addon,
        &[
            ("DEFAULT_MAX_BYTES", addon.get(c"CHAT_HISTORY_MAX_BYTES")?),
            (
                "DEFAULT_TOOL_STRING_CHARS",
                addon.get(c"CHAT_HISTORY_TOOL_STRING_CHARS")?,
            ),
            ("messageBytes", bytes),
            ("fitHistoryFrame", fit),
        ],
    )?
    .raw())
}

#[napi]
pub fn task_frames_api(env: Env, code_registry: Unknown<'_>) -> Result<sys::napi_value> {
    let registry = LiveValue::new(&env, code_registry);
    let owner = fields(
        registry,
        &[
            ("shortCodes", registry),
            ("provider", registry.from_value(&JsValue::Null)?),
        ],
    )?;
    let install = method(&env, owner, "installAuxHealthProvider", 1, 1, |s, a| {
        let provider = if a[0].kind()? == sys::ValueType::napi_function {
            a[0]
        } else {
            s.from_value(&JsValue::Null)?
        };
        s.set(c"provider", provider)?;
        s.from_value(&JsValue::Undefined)
    })?;
    let freshness = method(&env, owner, "auxVerdictStaleness", 0, 0, |s, _| {
        crate::aux_verdict_health::freshness(s.get(c"provider")?, false)
    })?;
    let fanout = method(&env, owner, "fanOutAuxVerdictStaleness", 1, 1, |s, a| {
        let ports = a[0];
        let sessions = ports.get(c"sessions")?;
        let state = ports.get(c"getTaskState")?;
        let chat = ports.get(c"chatBroadcast")?;
        let workspace = ports.get(c"workspaceBroadcast")?;
        let count = crate::aux_verdict_health::fan_out(
            s.get(c"provider")?,
            sessions,
            state,
            chat,
            workspace,
        )?;
        s.from_value(&JsValue::Number(count))
    })?;
    let seed = method(&env, owner, "taskStateSeed", 1, 1, |s, a| {
        task_frame(a[0], true, s.get(c"shortCodes")?, s)
    })?;
    let payload = method(&env, owner, "taskStatePayload", 1, 1, |s, a| {
        task_frame(a[0], false, s.get(c"shortCodes")?, s)
    })?;
    Ok(fields(
        owner,
        &[
            ("installAuxHealthProvider", install),
            ("auxVerdictStaleness", freshness),
            ("fanOutAuxVerdictStaleness", fanout),
            ("taskStateSeed", seed),
            ("taskStatePayload", payload),
        ],
    )?
    .raw())
}
