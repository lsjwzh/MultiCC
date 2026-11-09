//! Native per-event chat reducer for the Claude stream-json lane.
//!
//! `applyClaudeChatEvent` used to live in `src/chat/turn-engine.js`. It decides
//! how one event mutates the live session (`cs`), the turn, the runner's
//! API-error state and what is forwarded. This module owns those decisions and
//! the field mutations on the existing host objects; the JavaScript wrapper
//! supplies only the effects that still belong to Node owners (`forward`,
//! heartbeat, timeline, history, background tasks, status, usage poller,
//! logger, provider-attempt runtime). No state is mirrored and no event is
//! serialized inside the process: objects are read and written through
//! [`LiveValue`] with engine identity, getter order and property order intact.
use crate::{
    cli_completion::{compatible, completed},
    js_live::LiveValue,
};
use multicc_core::{
    api_error_policy, chat_events, js::JsString, js::JsValue, provider_scrub::route_redact,
    redaction,
};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;
use std::ffi::CStr;

type LV<'a> = LiveValue<'a>;

fn undefined<'a>(anchor: LV<'a>) -> Result<LV<'a>> {
    anchor.from_value(&JsValue::Undefined)
}
fn null<'a>(anchor: LV<'a>) -> Result<LV<'a>> {
    anchor.from_value(&JsValue::Null)
}
fn boolean<'a>(anchor: LV<'a>, value: bool) -> Result<LV<'a>> {
    anchor.from_value(&JsValue::Bool(value))
}
fn number<'a>(anchor: LV<'a>, value: f64) -> Result<LV<'a>> {
    anchor.from_value(&JsValue::Number(value))
}
fn text<'a>(anchor: LV<'a>, value: &str) -> Result<LV<'a>> {
    anchor.from_value(&JsValue::string(value))
}
fn string_value<'a>(anchor: LV<'a>, value: JsString) -> Result<LV<'a>> {
    anchor.from_value(&JsValue::String(value))
}
fn object<'a>(anchor: LV<'a>) -> Result<LV<'a>> {
    anchor.from_value(&JsValue::Object(vec![]))
}
fn array<'a>(anchor: LV<'a>) -> Result<LV<'a>> {
    anchor.from_value(&JsValue::Array(vec![]))
}

fn read(value: LV<'_>) -> Result<JsValue> {
    let mut seen = Vec::new();
    unsafe { crate::js_bridge::read_value(value.env(), value.raw(), 0, &mut seen) }
}

/// `Date.now()` through the engine, so a host/test clock replacement is seen.
fn now(anchor: LV<'_>) -> Result<f64> {
    anchor
        .global()?
        .get(c"Date")?
        .get(c"now")?
        .call_plain(&[])?
        .number()
}

fn push<'a>(target: LV<'a>, value: LV<'a>) -> Result<()> {
    target.get(c"push")?.call(target, &[value])?;
    Ok(())
}

/// `String(value || '')`.
fn string_or_empty(value: LV<'_>) -> Result<JsString> {
    if value.truthy()? {
        value.coerce_string()
    } else {
        Ok(JsString::new())
    }
}

/// JS truthiness of a number (`0`, `-0` and `NaN` are falsy).
fn number_truthy(value: f64) -> bool {
    value != 0.0 && !value.is_nan()
}

/// `a || b || c`: the first truthy operand, otherwise the last one.
fn or_chain<'a>(values: &[LV<'a>]) -> Result<LV<'a>> {
    let (last, rest) = values.split_last().expect("non-empty or-chain");
    for value in rest {
        if value.truthy()? {
            return Ok(*value);
        }
    }
    Ok(*last)
}

fn nullish_or<'a>(first: LV<'a>, second: LV<'a>) -> Result<LV<'a>> {
    if first.nullish()? {
        Ok(second)
    } else {
        Ok(first)
    }
}

/// `redactProviderRouteCapability(value)` with engine identity: a string is
/// rewritten by the core rule, an object is walked, anything else is returned
/// unchanged and unchanged inputs keep their identity.
fn redact_value<'a>(_anchor: LV<'a>, value: LV<'a>) -> Result<LV<'a>> {
    route_redact(value, &mut Vec::new(), 0)
}

fn redact_string<'a>(anchor: LV<'a>, value: &JsString) -> Result<LV<'a>> {
    string_value(anchor, redaction::redact_route_capability(value))
}

fn detect<'a>(anchor: LV<'a>, provider: LV<'a>, source: LV<'a>) -> Result<LV<'a>> {
    let provider = read(provider)?;
    let source = read(source)?;
    let value = api_error_policy::detect_error_envelope(&provider, &source);
    anchor.from_value(&value)
}

fn call<'a>(method: LV<'a>, arguments: &[LV<'a>]) -> Result<LV<'a>> {
    method.call_plain(arguments)
}

fn log<'a>(logger: LV<'a>, level: &CStr, name: &str, fields: LV<'a>) -> Result<()> {
    if logger.nullish()? {
        return Ok(());
    }
    let method = logger.get(level)?;
    if method.kind()? != sys::ValueType::napi_function {
        return Ok(());
    }
    method.call(logger, &[text(logger, name)?, fields])?;
    Ok(())
}

/// The host's `isCurrentTurnRunner` binding (itself the native owner check in
/// production). The reducer owns when to consult it; the binding stays a port.
fn is_current<'a>(ports: LV<'a>, cs: LV<'a>, turn: LV<'a>, runner: LV<'a>) -> Result<bool> {
    call(ports.get(c"isCurrent")?, &[cs, turn, runner])?.truthy()
}

fn object_keys_len(anchor: LV<'_>, value: LV<'_>) -> Result<f64> {
    let object = anchor.global()?.get(c"Object")?;
    object
        .get(c"keys")?
        .call(object, &[value])?
        .get(c"length")?
        .number()
}

struct ApiErrorMessage<'a> {
    text: LV<'a>,
    http_status: LV<'a>,
    cli_error: LV<'a>,
    request_id: LV<'a>,
    key: Option<JsString>,
}

fn is_nonempty_string(value: LV<'_>) -> Result<bool> {
    if value.kind()? != sys::ValueType::napi_string {
        return Ok(false);
    }
    Ok(value
        .string()?
        .map(|text| !text.is_empty())
        .unwrap_or(false))
}

/// `apiErrorMessageOf(evt)`.
fn api_error_message<'a>(anchor: LV<'a>, evt: LV<'a>) -> Result<Option<ApiErrorMessage<'a>>> {
    if !evt.truthy()? || !evt.get(c"type")?.is_string("assistant")? {
        return Ok(None);
    }
    let message = evt.optional(c"message")?;
    let content = message.optional(c"content")?;
    if !content.is_array()? {
        return Ok(None);
    }
    let flagged = evt.get(c"is_api_error_message")?.is_true()?
        || evt.get(c"isApiErrorMessage")?.is_true()?
        || (is_nonempty_string(evt.optional(c"error")?)?
            && message.optional(c"model")?.is_string("<synthetic>")?);
    if !flagged {
        return Ok(None);
    }
    let mut text_blocks = Vec::new();
    content.for_each(|block| {
        if block.truthy()? && block.get(c"type")?.is_string("text")? {
            text_blocks.push(block);
        }
        Ok(())
    })?;
    let mut joined = JsString::new();
    for block in text_blocks {
        joined.push(&string_or_empty(block.optional(c"text")?)?);
    }
    let text_value = string_value(anchor, joined.clone())?;
    let request_id = or_chain(&[
        evt.optional(c"request_id")?,
        evt.optional(c"requestId")?,
        null(anchor)?,
    ])?;
    let raw_status = {
        let first = evt.get(c"api_error_status")?;
        if first.nullish()? {
            evt.get(c"apiErrorStatus")?
        } else {
            first
        }
    };
    let status = if raw_status.nullish()? {
        None
    } else {
        chat_events::status_of(Some(raw_status.explicit_number()?))
    };
    let http_status = match status {
        Some(value) => number(anchor, value)?,
        None => null(anchor)?,
    };
    let cli_error = if is_nonempty_string(evt.optional(c"error")?)? {
        evt.get(c"error")?
    } else {
        null(anchor)?
    };
    let uuid_text = {
        let uuid = evt.optional(c"uuid")?;
        if uuid.truthy()? {
            Some(uuid.coerce_string()?)
        } else {
            None
        }
    };
    let request_id_text = if request_id.truthy()? {
        Some(request_id.coerce_string()?)
    } else {
        None
    };
    let key = chat_events::api_error_key(uuid_text.as_ref(), request_id_text.as_ref(), &joined);
    Ok(Some(ApiErrorMessage {
        text: text_value,
        http_status,
        cli_error,
        request_id,
        key,
    }))
}

/// `stateOf(runner)`, allocating the state object on first use.
fn api_error_state<'a>(anchor: LV<'a>, runner: LV<'a>) -> Result<Option<LV<'a>>> {
    if !runner.truthy()? || runner.kind()? != sys::ValueType::napi_object {
        return Ok(None);
    }
    let state = runner.get(c"claudeApiError")?;
    if state.truthy()? {
        return Ok(Some(state));
    }
    let fresh = object(anchor)?;
    let seen = anchor.global()?.get(c"Set")?.construct(&[])?;
    fresh.set(c"seen", seen)?;
    fresh.set(c"pending", null(anchor)?)?;
    runner.assign(c"claudeApiError", fresh)?;
    Ok(Some(fresh))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    None,
    Append,
    Suppress,
    Drop,
}

/// `claudeApiError.intercept(runner, evt, cs, { sessionId, turnId, logger })`.
fn intercept<'a>(
    anchor: LV<'a>,
    runner: LV<'a>,
    evt: LV<'a>,
    cs: LV<'a>,
    session: LV<'a>,
    turn: LV<'a>,
    logger: LV<'a>,
) -> Result<Mode> {
    let Some(info) = api_error_message(anchor, evt)? else {
        return Ok(Mode::None);
    };
    let Some(state) = api_error_state(anchor, runner)? else {
        return Ok(Mode::None);
    };
    let turn_id = turn.get(c"turnId")?;
    let seen = state.get(c"seen")?;
    if let Some(key) = &info.key {
        let key_value = string_value(anchor, key.clone())?;
        if seen.get(c"has")?.call(seen, &[key_value])?.truthy()? {
            let fields = object(anchor)?;
            fields.set(c"sessionId", session)?;
            fields.set(c"turnId", turn_id)?;
            fields.set(c"requestId", info.request_id)?;
            log(logger, c"info", "claude_api_error_message_dedup", fields)?;
            return Ok(Mode::Drop);
        }
        seen.get(c"add")?.call(seen, &[key_value])?;
    }
    let pending = state.get(c"pending")?;
    let base = if pending.truthy()? && pending.get(c"appended")?.truthy()? {
        string_or_empty(pending.get(c"bodyBefore")?)?
    } else {
        string_or_empty(cs.optional(c"currentAssistantText")?)?
    };
    let tools = cs.optional(c"currentToolCalls")?;
    let tool_count = if tools.is_array()? {
        tools.get(c"length")?.number()? as usize
    } else {
        0
    };
    let error_only = chat_events::is_error_only(&base, tool_count);
    let pending_object = object(anchor)?;
    pending_object.set(c"text", info.text)?;
    pending_object.set(c"httpStatus", info.http_status)?;
    pending_object.set(c"cliError", info.cli_error)?;
    pending_object.set(c"requestId", info.request_id)?;
    pending_object.set(
        c"key",
        match &info.key {
            Some(key) => string_value(anchor, key.clone())?,
            None => null(anchor)?,
        },
    )?;
    pending_object.set(c"appended", boolean(anchor, error_only)?)?;
    pending_object.set(
        c"bodyBefore",
        if error_only {
            text(anchor, "")?
        } else {
            null(anchor)?
        },
    )?;
    state.assign(c"pending", pending_object)?;
    let fields = object(anchor)?;
    fields.set(c"sessionId", session)?;
    fields.set(c"turnId", turn_id)?;
    fields.set(c"httpStatus", info.http_status)?;
    fields.set(c"cliError", info.cli_error)?;
    fields.set(c"appended", boolean(anchor, error_only)?)?;
    log(logger, c"info", "claude_api_error_message", fields)?;
    Ok(if error_only {
        Mode::Append
    } else {
        Mode::Suppress
    })
}

/// `claudeApiError.recoverPendingEvent(runner, cs, evt, {...})`.
fn recover_pending<'a>(
    anchor: LV<'a>,
    session: LV<'a>,
    turn: LV<'a>,
    logger: LV<'a>,
    runner: LV<'a>,
    cs: LV<'a>,
    evt: LV<'a>,
) -> Result<bool> {
    if !evt.truthy()? || !evt.get(c"type")?.is_string("assistant")? {
        return Ok(false);
    }
    let content = evt.optional(c"message")?.optional(c"content")?;
    if !content.is_array()? {
        return Ok(false);
    }
    let mut has_output = false;
    content.for_each(|block| {
        if has_output {
            return Ok(());
        }
        if block.truthy()? {
            let kind = block.get(c"type")?;
            // `(type === 'text' && String(text || '').trim()) || type === 'tool_use'`
            let meaningful_text = kind.is_string("text")?
                && !string_or_empty(block.optional(c"text")?)?.trim().is_empty();
            if meaningful_text || kind.is_string("tool_use")? {
                has_output = true;
            }
        }
        Ok(())
    })?;
    if !has_output {
        return Ok(false);
    }
    let Some(state) = api_error_state(anchor, runner)? else {
        return Ok(false);
    };
    let pending = state.get(c"pending")?;
    if !pending.truthy()? {
        return Ok(false);
    }
    state.assign(c"pending", null(anchor)?)?;
    if pending.get(c"appended")?.truthy()? {
        let restored = string_or_empty(pending.get(c"bodyBefore")?)?;
        cs.assign(c"currentAssistantText", string_value(anchor, restored)?)?;
    }
    let fields = object(anchor)?;
    fields.set(c"sessionId", session)?;
    fields.set(c"turnId", turn.get(c"turnId")?)?;
    fields.set(c"httpStatus", pending.get(c"httpStatus")?)?;
    log(logger, c"info", "claude_api_error_recovered", fields)?;
    Ok(true)
}

/// `claudeApiError.apiErrorEnvelope(runner, providerName, currentText)`.
fn api_error_envelope<'a>(
    anchor: LV<'a>,
    runner: LV<'a>,
    provider_name: LV<'a>,
    current_text: LV<'a>,
) -> Result<LV<'a>> {
    let Some(state) = api_error_state(anchor, runner)? else {
        return null(anchor);
    };
    let pending = state.get(c"pending")?;
    if !pending.truthy()? {
        return null(anchor);
    }
    let pending_text = string_or_empty(pending.get(c"text")?)?;
    let message_value = string_value(anchor, pending_text)?;
    let parsed = detect(anchor, provider_name, message_value)?;
    let body = if pending.get(c"appended")?.truthy()? {
        let before = string_or_empty(pending.get(c"bodyBefore")?)?;
        if before.trim().is_empty() {
            null(anchor)?
        } else {
            string_value(anchor, before)?
        }
    } else {
        let current = string_or_empty(current_text)?;
        if current.trim().is_empty() {
            null(anchor)?
        } else {
            current_text
        }
    };
    let http_status = nullish_or(
        pending.get(c"httpStatus")?,
        nullish_or(parsed.optional(c"httpStatus")?, null(anchor)?)?,
    )?;
    let provider = if provider_name.truthy()? {
        provider_name.coerce_string()?
    } else {
        JsString::from_rust_str("claude")
    };
    let provider_value = string_value(anchor, provider)?;
    let lowered = provider_value
        .get(c"toLowerCase")?
        .call(provider_value, &[])?;
    let source = api_error_policy::envelope_source_for(&read(provider_name)?);
    let out = object(anchor)?;
    out.set(c"source", string_value(anchor, source)?)?;
    out.set(c"provider", lowered)?;
    out.set(c"message", message_value)?;
    out.set(c"httpStatus", http_status)?;
    out.set(c"body", body)?;
    out.set(c"structured", boolean(anchor, true)?)?;
    out.set(c"cliError", pending.get(c"cliError")?)?;
    out.freeze()
}

/// `recordResultEvent(turn, runner, { current: true, persisted: false })`.
fn record_result_event<'a>(turn: LV<'a>, runner: LV<'a>) -> Result<()> {
    if !turn.truthy()? || !runner.truthy()? {
        return Ok(());
    }
    if !runner.get(c"turnId")?.equals(turn.get(c"turnId")?)? {
        return Ok(());
    }
    runner.assign(c"resultEvent", boolean(runner, true)?)?;
    Ok(())
}

/// `closeOpenThinkingTool(cs)`.
fn close_open_thinking(anchor: LV<'_>, cs: LV<'_>) -> Result<()> {
    let tools = cs.optional(c"currentToolCalls")?;
    if !tools.is_array()? {
        return Ok(());
    }
    let at = now(anchor)?;
    let length = tools.get(c"length")?.number()? as u32;
    for index in 0..length {
        let tool = tools.element(index)?;
        if !tool.truthy()? || !tool.get(c"name")?.is_string("Thinking")? {
            continue;
        }
        let started_finite = tool
            .get(c"startedAt")?
            .number_value()?
            .map(f64::is_finite)
            .unwrap_or(false);
        let ended_finite = tool
            .get(c"endedAt")?
            .number_value()?
            .map(f64::is_finite)
            .unwrap_or(false);
        if !started_finite || ended_finite {
            continue;
        }
        tool.assign(c"endedAt", number(tool, at)?)?;
    }
    Ok(())
}

fn find_tool_by_id<'a>(tools: LV<'a>, id: LV<'a>) -> Result<Option<LV<'a>>> {
    if !tools.is_array()? {
        return Ok(None);
    }
    let length = tools.get(c"length")?.number()? as u32;
    for index in 0..length {
        let item = tools.element(index)?;
        if item.get(c"id")?.equals(id)? {
            return Ok(Some(item));
        }
    }
    Ok(None)
}

/// `normalizeClaudeToolResultContent(content)`.
fn normalize_tool_result_content<'a>(anchor: LV<'a>, content: LV<'a>) -> Result<LV<'a>> {
    let result = object(anchor)?;
    if !content.is_array()? {
        let raw = if content.kind()? == sys::ValueType::napi_string {
            content
        } else {
            // `content == null ? '' : content` then JSON.stringify, so null and
            // undefined both stringify as '""' rather than as an empty string.
            let json = if content.nullish()? {
                JsValue::String(JsString::new())
            } else {
                read(content)?
            };
            match multicc_core::js::json::json_stringify(&json) {
                Some(encoded) => text(anchor, &encoded)?,
                None => undefined(anchor)?,
            }
        };
        let safe = redact_value(anchor, raw)?;
        result.set(c"text", safe)?;
        result.set(c"content", safe)?;
        return Ok(result);
    }
    let mut joined = JsString::new();
    let non_text = array(anchor)?;
    content.for_each(|item| {
        if item.truthy()? && item.get(c"text")?.kind()? == sys::ValueType::napi_string {
            joined.push(&item.get(c"text")?.string()?.expect("text"));
        }
        if !item.truthy()? || item.get(c"text")?.kind()? != sys::ValueType::napi_string {
            push(non_text, redact_value(anchor, item)?)?;
        }
        Ok(())
    })?;
    let safe = redact_string(anchor, &joined)?;
    let normalized = array(anchor)?;
    if !joined.is_empty() {
        let block = object(anchor)?;
        block.set(c"type", text(anchor, "text")?)?;
        block.set(c"text", safe)?;
        push(normalized, block)?;
    }
    non_text.for_each(|item| push(normalized, item))?;
    result.set(c"text", safe)?;
    result.set(c"content", normalized)?;
    Ok(result)
}

fn handle_tool_result<'a>(
    anchor: LV<'a>,
    normalized: LV<'a>,
    ports: LV<'a>,
    session: LV<'a>,
    turn: LV<'a>,
    cs: LV<'a>,
    r: LV<'a>,
) -> Result<()> {
    if r.truthy()? && r.get(c"type")?.is_string("tool_result")? {
        call(
            ports.get(c"updatePhase")?,
            &[session, turn.get(c"turnId")?, text(anchor, "thinking")?],
        )?;
        let tools = cs.get(c"currentToolCalls")?;
        let found = find_tool_by_id(tools, r.get(c"tool_use_id")?)?;
        let content = normalize_tool_result_content(anchor, r.get(c"content")?)?;
        if let Some(tool) = found {
            let normalized_text = content.get(c"text")?;
            tool.assign(c"result", normalized_text)?;
            let is_error = if r.get(c"is_error")?.truthy()? {
                r.get(c"is_error")?
            } else {
                boolean(anchor, false)?
            };
            tool.assign(c"is_error", is_error)?;
            tool.assign(c"endedAt", number(anchor, now(anchor)?)?)?;
            let stored = tool.get(c"result")?;
            if stored.truthy()? {
                if let Some(value) = stored.string()? {
                    if value.len() > 1000 {
                        let mut shortened = value.truncate_units(1000);
                        shortened.push_str("...");
                        tool.assign(c"result", string_value(anchor, shortened)?)?;
                    }
                }
            }
        }
        let item = object(anchor)?;
        item.spread_from(r)?;
        item.set(c"content", content.get(c"content")?)?;
        push(normalized, item)?;
    } else {
        push(normalized, r)?;
    }
    Ok(())
}

fn normalize_assistant_snapshot<'a>(
    anchor: LV<'a>,
    evt: LV<'a>,
    current_text: LV<'a>,
) -> Result<LV<'a>> {
    let out = object(anchor)?;
    out.spread_from(evt)?;
    let message = evt.optional(c"message")?;
    let snapshot = object(anchor)?;
    snapshot.spread_from(message)?;
    snapshot.set(c"textSnapshot", boolean(anchor, true)?)?;
    let non_text = array(anchor)?;
    message.optional(c"content")?.for_each(|block| {
        if !(block.truthy()? && block.get(c"type")?.is_string("text")?) {
            push(non_text, block)?;
        }
        Ok(())
    })?;
    let content = array(anchor)?;
    let mut index = 0u32;
    if current_text.truthy()? {
        let block = object(anchor)?;
        block.set(c"type", text(anchor, "text")?)?;
        block.set(c"text", redact_value(anchor, current_text)?)?;
        content.set_element(index, block)?;
        index += 1;
    }
    non_text.for_each(|block| {
        content.set_element(index, block)?;
        index += 1;
        Ok(())
    })?;
    snapshot.set(c"content", content)?;
    out.set(c"message", snapshot)?;
    Ok(out)
}

/// `markReplaySafeAssistantEnvelope(event, providerName)`.
fn mark_replay_safe<'a>(
    anchor: LV<'a>,
    event: LV<'a>,
    provider_name: LV<'a>,
    ports: LV<'a>,
) -> Result<LV<'a>> {
    if !event.truthy()? || !event.get(c"type")?.is_string("assistant")? {
        return Ok(event);
    }
    let content = event.optional(c"message")?.optional(c"content")?;
    if !content.is_array()? {
        return Ok(event);
    }
    if content.get(c"length")?.number()? == 0.0 {
        return Ok(event);
    }
    let mut joined = JsString::new();
    let mut all_text = true;
    content.for_each(|block| {
        if !(block.truthy()? && block.get(c"type")?.is_string("text")?) {
            all_text = false;
            return Ok(());
        }
        joined.push(&string_or_empty(block.optional(c"text")?)?);
        Ok(())
    })?;
    if !all_text {
        return Ok(event);
    }
    let envelope = detect(anchor, provider_name, string_value(anchor, joined)?)?;
    if envelope.truthy()? && envelope.optional(c"body")?.nullish()? {
        return call(ports.get(c"markHostEnvelope")?, &[event]);
    }
    Ok(event)
}

fn fallback_api_error_raw<'a>(
    anchor: LV<'a>,
    evt: LV<'a>,
    provider_name: LV<'a>,
) -> Result<LV<'a>> {
    let error = evt.optional(c"error")?;
    let detail = if error.truthy()? && error.kind()? == sys::ValueType::napi_object {
        error
    } else {
        object(anchor)?
    };
    let source = api_error_policy::envelope_source_for(&read(provider_name)?);
    let out = object(anchor)?;
    out.set(c"source", string_value(anchor, source)?)?;
    out.set(c"provider", provider_name)?;
    out.set(
        c"code",
        or_chain(&[
            evt.optional(c"startup_failure_reason")?,
            detail.optional(c"code")?,
            evt.optional(c"subtype")?,
            detail.optional(c"type")?,
        ])?,
    )?;
    out.set(c"errors", evt.optional(c"errors")?)?;
    out.set(
        c"httpStatus",
        or_chain(&[
            detail.optional(c"http_status")?,
            detail.optional(c"status_code")?,
            detail.optional(c"status")?,
            evt.optional(c"http_status")?,
            evt.optional(c"status_code")?,
            evt.optional(c"status")?,
            evt.optional(c"api_error_status")?,
        ])?,
    )?;
    out.set(
        c"headers",
        or_chain(&[detail.optional(c"headers")?, evt.optional(c"headers")?])?,
    )?;
    out.set(
        c"requestId",
        or_chain(&[
            detail.optional(c"request_id")?,
            evt.optional(c"request_id")?,
        ])?,
    )?;
    out.set(
        c"message",
        or_chain(&[
            detail.optional(c"message")?,
            evt.optional(c"result")?,
            evt.optional(c"subtype")?,
            text(anchor, "api_error")?,
        ])?,
    )?;
    Ok(out)
}

#[allow(clippy::too_many_arguments)]
fn apply_result<'a>(
    anchor: LV<'a>,
    cs: LV<'a>,
    session: LV<'a>,
    evt: LV<'a>,
    forward: LV<'a>,
    turn: LV<'a>,
    runner: LV<'a>,
    provider_name: LV<'a>,
    ports: LV<'a>,
) -> Result<bool> {
    let completion = runner.get(c"completionOutcome")?;
    if !completion.truthy()? {
        runner.assign(c"pendingClaudeResult", evt)?;
        record_result_event(turn, runner)?;
        return Ok(true);
    }
    call(
        ports.get(c"updatePhase")?,
        &[session, turn.get(c"turnId")?, text(anchor, "finalizing")?],
    )?;
    close_open_thinking(anchor, cs)?;
    let total_cost = evt.optional(c"total_cost_usd")?;
    cs.assign(
        c"currentCost",
        if total_cost.truthy()? {
            total_cost
        } else {
            null(anchor)?
        },
    )?;
    let attempt = runner.optional(c"providerAttempt")?;
    let proxy_failure = call(ports.get(c"proxyFailure")?, &[attempt])?;
    let result_succeeded = completed(completion)?
        && (!proxy_failure.truthy()? || compatible(proxy_failure, completion)?);
    let state = completion.optional(c"state")?.string()?;
    let source = completion.optional(c"source")?.string()?;
    let api_failure = chat_events::is_api_failure(state.as_ref(), source.as_ref());
    let current_text = cs.optional(c"currentAssistantText")?;
    let mut detected = api_error_envelope(anchor, runner, provider_name, current_text)?;
    if !detected.truthy()? {
        detected = detect(anchor, provider_name, current_text)?;
    }
    let envelope_error = if api_failure { null(anchor)? } else { detected };
    if envelope_error.truthy()? {
        let body = envelope_error.get(c"body")?;
        if !body.nullish()? {
            cs.assign(c"currentAssistantText", body)?;
        }
    }
    if api_failure || envelope_error.truthy()? {
        call(ports.get(c"clearIncrementalSave")?, &[session])?;
        cs.assign(c"_sawApiError", boolean(anchor, true)?)?;
        runner.assign(c"sawApiError", boolean(anchor, true)?)?;
        let raw = if detected.truthy()? {
            detected
        } else {
            fallback_api_error_raw(anchor, evt, provider_name)?
        };
        runner.assign(c"apiErrorRaw", raw)?;
    }
    let usage = {
        let value = evt.optional(c"usage")?;
        if value.truthy()? {
            value
        } else {
            object(anchor)?
        }
    };
    let context_trace = call(ports.get(c"contextTrace")?, &[session, cs])?;
    runner.assign(c"pendingUsage", usage)?;
    let text_now = cs.optional(c"currentAssistantText")?;
    let tools_now = cs.get(c"currentToolCalls")?;
    let tool_length = tools_now.get(c"length")?.number()?;
    let has_output = chat_events::has_result_output(text_now.truthy()?, number_truthy(tool_length));
    if result_succeeded && !envelope_error.truthy()? && has_output {
        let was_mapped = call(ports.get(c"isMapped")?, &[session, cs])?.truthy()?;
        let message = object(anchor)?;
        message.set(c"role", text(anchor, "assistant")?)?;
        message.set(c"content", cs.optional(c"currentAssistantText")?)?;
        message.set(
            c"tools",
            if number_truthy(tool_length) {
                tools_now
            } else {
                undefined(anchor)?
            },
        )?;
        message.set(c"cost", cs.optional(c"currentCost")?)?;
        message.set(
            c"usage",
            if number_truthy(object_keys_len(anchor, usage)?) {
                usage
            } else {
                undefined(anchor)?
            },
        )?;
        message.set(c"ts", number(anchor, now(anchor)?)?)?;
        if context_trace.truthy()? {
            message.set(c"contextTrace", context_trace)?;
        }
        let timings = call(ports.get(c"turnTimings")?, &[session, turn.get(c"turnId")?])?;
        message.set(c"turnTimings", timings)?;
        let options = object(anchor)?;
        options.set(c"resultEvent", boolean(anchor, true)?)?;
        let durable = call(
            ports.get(c"persistFinal")?,
            &[session, cs, turn, runner, message, options],
        )?
        .truthy()?;
        if !is_current(anchor, cs, turn, runner)?
            || (was_mapped && !call(ports.get(c"isMapped")?, &[session, cs])?.truthy()?)
        {
            return Ok(true);
        }
        if durable {
            call(ports.get(c"recordDurableUsage")?, &[session, runner, usage])?;
            if !is_current(anchor, cs, turn, runner)?
                || (was_mapped && !call(ports.get(c"isMapped")?, &[session, cs])?.truthy()?)
            {
                return Ok(true);
            }
            let count = cs.get(c"chatTurnCount")?.number()?;
            cs.assign(c"chatTurnCount", number(anchor, count + 1.0)?)?;
            cs.assign(c"_resultSaved", boolean(anchor, true)?)?;
        }
        call(ports.get(c"clearIncrementalSave")?, &[session])?;
    } else {
        record_result_event(turn, runner)?;
    }
    let started = cs.optional(c"turnStartedAt")?;
    let duration = if started.truthy()? {
        number(anchor, now(anchor)? - started.number()?)?
    } else {
        undefined(anchor)?
    };
    let frame = object(anchor)?;
    frame.set(c"type", text(anchor, "result")?)?;
    frame.set(c"total_cost_usd", evt.optional(c"total_cost_usd")?)?;
    frame.set(c"usage", usage)?;
    frame.set(c"durationMs", duration)?;
    frame.set(c"num_turns", cs.get(c"chatTurnCount")?)?;
    if context_trace.truthy()? {
        frame.set(c"contextTrace", context_trace)?;
    }
    frame.spread_from(call(ports.get(c"modelAttribution")?, &[cs, turn, runner])?)?;
    frame.spread_from(call(ports.get(c"timelineField")?, &[cs])?)?;
    forward.call_plain(&[frame])?;
    call(ports.get(c"onTurnComplete")?, &[session])?;
    // The original falls through to the final `forward(evt)` after a completed
    // result; only the no-completion and stale-runner paths return early.
    Ok(false)
}

#[napi]
#[allow(clippy::too_many_arguments)]
pub fn chat_apply_claude_event(
    env: Env,
    cs: Unknown<'_>,
    session_name: Unknown<'_>,
    evt: Unknown<'_>,
    forward: Unknown<'_>,
    turn: Unknown<'_>,
    runner: Unknown<'_>,
    provider_name: Unknown<'_>,
    ports: Unknown<'_>,
) -> Result<()> {
    let anchor = LiveValue::new(&env, ports);
    let cs = LiveValue::new(&env, cs);
    let session = LiveValue::new(&env, session_name);
    let mut evt = LiveValue::new(&env, evt);
    let forward = LiveValue::new(&env, forward);
    let turn = LiveValue::new(&env, turn);
    let runner = LiveValue::new(&env, runner);
    let provider_name = LiveValue::new(&env, provider_name);

    if !is_current(anchor, cs, turn, runner)? {
        return Ok(());
    }
    evt = call(
        anchor.get(c"scrub")?,
        &[runner.optional(c"providerAttempt")?, evt],
    )?;
    call(
        anchor.get(c"touchActivity")?,
        &[session, turn.get(c"turnId")?],
    )?;
    call(anchor.get(c"observeClaude")?, &[cs, evt])?;
    let logger = anchor.get(c"logger")?;
    let mode = intercept(anchor, runner, evt, cs, session, turn, logger)?;
    if matches!(mode, Mode::Drop | Mode::Suppress) {
        return Ok(());
    }
    let event_type = evt.get(c"type")?;
    let message = evt.optional(c"message")?;
    if event_type.is_string("assistant")? && message.optional(c"model")?.truthy()? {
        call(
            anchor.get(c"noteReportedModel")?,
            &[session, message.get(c"model")?],
        )?;
    }
    if event_type.is_string("assistant")? && message.optional(c"content")?.truthy()? {
        if mode != Mode::Append {
            recover_pending(anchor, session, turn, logger, runner, cs, evt)?;
        }
        let content = message.get(c"content")?;
        content.for_each(|block| {
            let kind = block.get(c"type")?;
            if kind.is_string("text")? {
                call(
                    anchor.get(c"updatePhase")?,
                    &[session, turn.get(c"turnId")?, text(anchor, "thinking")?],
                )?;
                let mut joined = cs.optional(c"currentAssistantText")?.coerce_string()?;
                joined.push(&string_or_empty(block.optional(c"text")?)?);
                cs.assign(c"currentAssistantText", redact_string(anchor, &joined)?)?;
                let status = object(anchor)?;
                status.set(c"status", text(anchor, "thinking")?)?;
                status.set(c"currentFile", null(anchor)?)?;
                call(anchor.get(c"setSessionStatus")?, &[session, status])?;
                call(anchor.get(c"scheduleIncrementalSave")?, &[session, cs])?;
            }
            if kind.is_string("tool_use")? {
                let name = block.get(c"name")?;
                call(
                    anchor.get(c"updatePhase")?,
                    &[session, turn.get(c"turnId")?, text(anchor, "tool")?, name],
                )?;
                let tool = object(anchor)?;
                tool.set(c"name", name)?;
                tool.set(c"input", block.get(c"input")?)?;
                let id = block.get(c"id")?;
                tool.set(c"id", id)?;
                tool.set(c"startedAt", number(anchor, now(anchor)?)?)?;
                push(cs.get(c"currentToolCalls")?, tool)?;
                call(anchor.get(c"backgroundRecordToolUseId")?, &[session, id])?;
                if name.is_string("TaskOutput")? {
                    call(
                        anchor.get(c"backgroundMarkTaskOutputAwaiting")?,
                        &[session, block.optional(c"input")?],
                    )?;
                }
                let editing = name.is_string("Edit")?
                    || name.is_string("Write")?
                    || name.is_string("MultiEdit")?
                    || name.is_string("NotebookEdit")?;
                let running = name.is_string("Bash")?;
                let status = object(anchor)?;
                status.set(
                    c"status",
                    text(
                        anchor,
                        if editing {
                            "editing"
                        } else if running {
                            "running"
                        } else {
                            "thinking"
                        },
                    )?,
                )?;
                status.set(
                    c"currentFile",
                    if editing {
                        let file = block.optional(c"input")?.optional(c"file_path")?;
                        if file.truthy()? {
                            file
                        } else {
                            null(anchor)?
                        }
                    } else {
                        null(anchor)?
                    },
                )?;
                call(anchor.get(c"setSessionStatus")?, &[session, status])?;
            }
            Ok(())
        })?;
    }
    if event_type.is_string("user")? && message.optional(c"content")?.truthy()? {
        let content = message.get(c"content")?;
        let was_array = content.is_array()?;
        let normalized = array(anchor)?;
        if was_array {
            content.for_each(|entry| {
                handle_tool_result(anchor, normalized, anchor, session, turn, cs, entry)
            })?;
        } else {
            handle_tool_result(anchor, normalized, anchor, session, turn, cs, content)?;
        }
        let out = object(anchor)?;
        out.spread_from(evt)?;
        let rewritten = object(anchor)?;
        rewritten.spread_from(message)?;
        rewritten.set(
            c"content",
            if was_array {
                normalized
            } else {
                normalized.element(0)?
            },
        )?;
        out.set(c"message", rewritten)?;
        evt = out;
    }
    if event_type.is_string("result")?
        && apply_result(
            anchor,
            cs,
            session,
            evt,
            forward,
            turn,
            runner,
            provider_name,
            anchor,
        )?
    {
        return Ok(());
    }
    if event_type.is_string("system")? && evt.optional(c"subtype")?.is_string("init")? {
        call(
            anchor.get(c"noteReportedModel")?,
            &[session, evt.optional(c"model")?],
        )?;
        return Ok(());
    }
    if event_type.is_string("assistant")?
        && evt.optional(c"message")?.optional(c"content")?.is_array()?
    {
        let snapshot =
            normalize_assistant_snapshot(anchor, evt, cs.optional(c"currentAssistantText")?)?;
        let marked = mark_replay_safe(anchor, snapshot, provider_name, anchor)?;
        forward.call_plain(&[marked])?;
        return Ok(());
    }
    forward.call_plain(&[evt])?;
    Ok(())
}
