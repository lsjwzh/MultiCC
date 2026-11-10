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

/// Held-query identity is a history boundary, even when adjacent answers have
/// identical text. Ordinary (unsegmented) messages keep the legacy dedup rule.
#[napi]
pub fn chat_assistant_same_query(env: Env, left: Unknown<'_>, right: Unknown<'_>) -> Result<bool> {
    let left = LiveValue::new(&env, left).optional(c"heldResultId")?;
    let right = LiveValue::new(&env, right).optional(c"heldResultId")?;
    Ok((left.nullish()? && right.nullish()?) || left.equals(right)?)
}

/// A failed injected query needs a readable outcome even when the SDK sends
/// only an errors array or suppresses its synthetic API-error assistant text.
fn held_query_content<'a>(
    anchor: LV<'a>,
    cs: LV<'a>,
    evt: LV<'a>,
    runner: LV<'a>,
) -> Result<LV<'a>> {
    let mut body = string_or_empty(cs.optional(c"currentAssistantText")?)?;
    let failed = evt.optional(c"is_error")?.is_true()?;
    let result = string_or_empty(evt.optional(c"result")?)?;
    if !failed {
        return redact_value(
            anchor,
            string_value(anchor, if body.is_empty() { result } else { body })?,
        );
    }
    let mut detail = result;
    let pending = runner.optional(c"claudeApiError")?.optional(c"pending")?;
    if detail.is_empty() && pending.truthy()? {
        detail = string_or_empty(pending.optional(c"text")?)?;
    }
    let errors = evt.optional(c"errors")?;
    if detail.is_empty() && errors.is_array()? {
        errors.for_each(|error| {
            let value = if error.kind()? == sys::ValueType::napi_string {
                error
            } else {
                error.optional(c"message")?
            };
            let line = string_or_empty(value)?;
            if !line.is_empty() {
                if !detail.is_empty() {
                    detail.push_str("\n");
                }
                detail.push(&line);
            }
            Ok(())
        })?;
    }
    if detail.is_empty() {
        detail = JsString::from_rust_str("这条消息的回答失败，请重试。");
    }
    // Preserve partial output but never hide the error after it.
    if body.is_empty() {
        body = detail;
    } else if !body.to_string_lossy().contains(&detail.to_string_lossy()) {
        body.push_str("\n\n");
        body.push(&detail);
    }
    redact_value(anchor, string_value(anchor, body)?)
}

/// Capture each query at its actual result boundary, without completing the
/// enclosing host turn. The row remains reachable on the native-managed runner
/// until its history append succeeds. Replaying a boundary retries that row,
/// never captures/clears the next query's live buffer.
fn held_query_result<'a>(
    anchor: LV<'a>,
    cs: LV<'a>,
    session: LV<'a>,
    evt: LV<'a>,
    forward: LV<'a>,
    turn: LV<'a>,
    runner: LV<'a>,
) -> Result<()> {
    let key = evt.optional(c"held_result_id")?;
    if !is_nonempty_string(key)? {
        return Ok(());
    }
    let mut rows = runner.optional(c"heldAnswerRows")?;
    if !rows.is_array()? {
        rows = array(anchor)?;
        runner.assign(c"heldAnswerRows", rows)?;
    }
    let mut found = None;
    rows.for_each(|row| {
        if row.get(c"key")?.equals(key)? {
            found = Some(row);
        }
        Ok(())
    })?;
    let row = if let Some(row) = found {
        row
    } else {
        close_open_thinking(anchor, cs)?;
        let message = object(anchor)?;
        let mut id = turn.get(c"turnId")?.coerce_string()?;
        id.push_str(":");
        id.push(&runner.get(c"runnerId")?.coerce_string()?);
        id.push_str(":held:");
        id.push(&key.coerce_string()?);
        message.set(c"id", string_value(anchor, id.clone())?)?;
        message.set(c"heldResultId", string_value(anchor, id)?)?;
        message.set(c"turnId", turn.get(c"turnId")?)?;
        message.set(c"role", text(anchor, "assistant")?)?;
        message.set(c"content", held_query_content(anchor, cs, evt, runner)?)?;
        message.set(c"terminalReason", evt.optional(c"terminal_reason")?)?;
        let tools = cs.optional(c"currentToolCalls")?;
        if tools.is_array()? && tools.get(c"length")?.number()? > 0.0 {
            message.set(c"tools", tools)?;
        }
        message.set(c"heldIdentities", evt.optional(c"held_identities")?)?;
        message.set(c"usage", evt.optional(c"usage")?)?;
        // SDK cost is a session-wide snapshot, not a per-query charge.
        message.set(c"cost", evt.optional(c"total_cost_usd")?)?;
        message.set(c"ts", number(anchor, now(anchor)?)?)?;
        message.set(c"isError", evt.optional(c"is_error")?)?;
        message.spread_from(call(anchor.get(c"modelAttribution")?, &[cs, turn, runner])?)?;
        let row = object(anchor)?;
        row.set(c"key", key)?;
        row.set(c"message", message)?;
        row.set(c"saved", boolean(anchor, false)?)?;
        push(rows, row)?;
        // Synthetic API errors belong to this query too. An injected failure
        // must not become the enclosing turn's final error envelope.
        let error_state = runner.optional(c"claudeApiError")?;
        if error_state.truthy()? {
            let identities = evt.optional(c"held_identities")?;
            if !identities.is_array()? || identities.get(c"length")?.number()? == 0.0 {
                runner.assign(c"heldOutcomeApiError", error_state.optional(c"pending")?)?;
            }
            error_state.assign(c"pending", null(anchor)?)?;
        }
        // Capturing owns the segment even if disk is temporarily unavailable.
        // A later query gets a fresh buffer; the failed row above remains intact.
        call(anchor.get(c"clearIncrementalSave")?, &[session])?;
        cs.assign(c"currentAssistantText", text(anchor, "")?)?;
        cs.assign(c"currentToolCalls", array(anchor)?)?;
        row
    };
    if !row.optional(c"notified")?.is_true()? {
        let frame = object(anchor)?;
        frame.set(c"type", text(anchor, "held_query_boundary")?)?;
        frame.set(c"message", row.get(c"message")?)?;
        forward.call_plain(&[frame])?;
        row.set(c"notified", boolean(anchor, true)?)?;
        if !is_current(anchor, cs, turn, runner)? {
            return Ok(());
        }
    }
    // Keep transcript order when an earlier append failed or is waiting for
    // its user row. Later query boundaries still capture/notify immediately.
    let mut preceding = true;
    let mut blocked = false;
    rows.for_each(|candidate| {
        if candidate.get(c"key")?.equals(key)? {
            preceding = false;
        }
        if preceding && !candidate.get(c"saved")?.is_true()? {
            blocked = true;
        }
        Ok(())
    })?;
    if blocked {
        return Ok(());
    }
    // The answer cannot be committed before the user history rows it answers.
    // A later retry carries the same captured segment once those rows exist.
    if evt
        .optional(c"held_history_ready")?
        .equals(boolean(anchor, false)?)?
    {
        return Ok(());
    }
    if !row.get(c"saved")?.is_true()? {
        if row.optional(c"saving")?.is_true()? {
            return Ok(());
        }
        row.set(c"saving", boolean(anchor, true)?)?;
        let saved = anchor
            .catch(|| {
                call(
                    anchor.get(c"appendHeldAnswer")?,
                    &[session, row.get(c"message")?],
                )?
                .is_true()
            })?
            .unwrap_or(false);
        row.set(c"saving", boolean(anchor, false)?)?;
        row.set(c"saved", boolean(anchor, saved)?)?;
        if !is_current(anchor, cs, turn, runner)? || !saved {
            return Ok(());
        }
    }
    let ack = evt.optional(c"acknowledge")?;
    if ack.kind()? == sys::ValueType::napi_function && is_current(anchor, cs, turn, runner)? {
        ack.call_plain(&[])?;
    }
    Ok(())
}

fn held_answers_durable(evt: LV<'_>, runner: LV<'_>) -> Result<bool> {
    if !evt.optional(c"held_answers_saved")?.is_true()? {
        return Ok(false);
    }
    let rows = runner.optional(c"heldAnswerRows")?;
    if !rows.is_array()? || rows.get(c"length")?.number()? == 0.0 {
        return Ok(false);
    }
    let mut all = true;
    rows.for_each(|row| {
        all &= row.get(c"saved")?.is_true()?;
        Ok(())
    })?;
    Ok(all)
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
    if evt.optional(c"held_answers_saved")?.is_true()? {
        let error_state = runner.optional(c"claudeApiError")?;
        if error_state.truthy()? {
            error_state.assign(
                c"pending",
                nullish_or(runner.optional(c"heldOutcomeApiError")?, null(anchor)?)?,
            )?;
        }
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
        let value = if value.truthy()? {
            value
        } else {
            object(anchor)?
        };
        // The hold owner sums each unique query once. SDK usage is per query;
        // modelUsage and total_cost_usd remain the latest cumulative snapshot.
        let held = evt.optional(c"held_usage")?;
        if held.truthy()? && held.kind()? == sys::ValueType::napi_object {
            held
        } else {
            value
        }
    };
    let context_trace = call(ports.get(c"contextTrace")?, &[session, cs])?;
    runner.assign(c"pendingUsage", usage)?;
    let text_now = cs.optional(c"currentAssistantText")?;
    let tools_now = cs.get(c"currentToolCalls")?;
    let tool_length = tools_now.get(c"length")?.number()?;
    let has_output = chat_events::has_result_output(text_now.truthy()?, number_truthy(tool_length));
    if held_answers_durable(evt, runner)? && !has_output {
        record_result_event(turn, runner)?;
        crate::chat_turn_effects::mark_result_durable(turn, runner)?;
        call(ports.get(c"recordDurableUsage")?, &[session, runner, usage])?;
        if !is_current(anchor, cs, turn, runner)? {
            return Ok(true);
        }
        let count = cs.get(c"chatTurnCount")?.number()?;
        cs.assign(c"chatTurnCount", number(anchor, count + 1.0)?)?;
        cs.assign(c"_resultSaved", boolean(anchor, true)?)?;
        // Finalization/classification reads this text after the result reducer.
        // Restore the host turn's own outcome, never the last injected row.
        cs.assign(
            c"currentAssistantText",
            redact_value(
                anchor,
                or_chain(&[evt.optional(c"result")?, text(anchor, "")?])?,
            )?,
        )?;
        call(ports.get(c"clearIncrementalSave")?, &[session])?;
    } else if result_succeeded && !envelope_error.truthy()? && has_output {
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
    frame.spread_from(call(ports.get(c"timelineField")?, &[cs, session])?)?;
    forward.call_plain(&[frame])?;
    call(ports.get(c"onTurnComplete")?, &[session])?;
    // The original falls through to the final `forward(evt)` after a completed
    // result; only the no-completion and stale-runner paths return early.
    Ok(false)
}

/// The shared Claude reducer body. `anchor` is also the ports object, exactly as
/// the JavaScript wrapper passed it, so the adapter path can route a nested
/// `claude_event` into this reducer without a round trip through Node.
#[allow(clippy::too_many_arguments)]
pub(crate) fn apply_claude_event<'a>(
    _env: &'a Env,
    cs: LV<'a>,
    session: LV<'a>,
    mut evt: LV<'a>,
    forward: LV<'a>,
    turn: LV<'a>,
    runner: LV<'a>,
    provider_name: LV<'a>,
    anchor: LV<'a>,
) -> Result<()> {
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
    call(anchor.get(c"observeClaude")?, &[cs, evt, session])?;
    let logger = anchor.get(c"logger")?;
    let mode = intercept(anchor, runner, evt, cs, session, turn, logger)?;
    if matches!(mode, Mode::Drop | Mode::Suppress) {
        return Ok(());
    }
    let event_type = evt.get(c"type")?;
    if event_type.is_string("held_query_result")? {
        return held_query_result(anchor, cs, session, evt, forward, turn, runner);
    }
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
    apply_claude_event(
        &env,
        LiveValue::new(&env, cs),
        LiveValue::new(&env, session_name),
        LiveValue::new(&env, evt),
        LiveValue::new(&env, forward),
        LiveValue::new(&env, turn),
        LiveValue::new(&env, runner),
        LiveValue::new(&env, provider_name),
        LiveValue::new(&env, ports),
    )
}

// ── adapter-neutral per-event reducer ───────────────────────────────────────
//
// `applyAdapterChatEvent` used to live next to `applyClaudeChatEvent`. It owns
// every adapter event kind (session lifecycle, status/activity, user input,
// text, tool start/result/update, reasoning, completion, errors) and routes a
// nested `claude_event` straight into the native Claude reducer above. Host
// ownership stays in `ports` (wire decoding, completion tracker, timeline,
// persisted-state side effects, attempt closing, status/heartbeat, background
// tasks, user-input recording, console and logger).

/// `String(value || '').trim() || null`.
fn trimmed_nullish(value: LV<'_>) -> Result<Option<JsString>> {
    let trimmed = string_or_empty(value)?.trim();
    if trimmed.is_empty() {
        Ok(None)
    } else {
        Ok(Some(trimmed))
    }
}

/// `${value}` inside a template literal.
fn template(value: LV<'_>) -> Result<JsString> {
    value.coerce_string()
}

/// `!!(cs?.currentToolCalls || []).some(t => t && t.name !== 'Thinking')`.
fn has_side_effects(cs: LV<'_>) -> Result<bool> {
    let tools = cs.optional(c"currentToolCalls")?;
    if !tools.truthy()? || !tools.is_array()? {
        return Ok(false);
    }
    let mut found = false;
    tools.for_each(|tool| {
        if !found && tool.truthy()? && !tool.get(c"name")?.is_string("Thinking")? {
            found = true;
        }
        Ok(())
    })?;
    Ok(found)
}

/// `!!(String(cs?.currentAssistantText || '').trim() && !isErrorOnlyText(text))`.
fn meaningful_output(cs: LV<'_>) -> Result<bool> {
    let text = string_or_empty(cs.optional(c"currentAssistantText")?)?;
    if text.trim().is_empty() {
        return Ok(false);
    }
    Ok(!api_error_policy::is_error_only_text(&JsValue::String(
        text,
    )))
}

/// `text.length > 1000 ? text.slice(0, 1000) + '...' : text`.
fn preview<'a>(anchor: LV<'a>, value: LV<'a>) -> Result<LV<'a>> {
    let over = match value.string()? {
        Some(text) => text.len() > 1000,
        None => match value.kind()? {
            sys::ValueType::napi_number
            | sys::ValueType::napi_boolean
            | sys::ValueType::napi_bigint
            | sys::ValueType::napi_symbol
            | sys::ValueType::napi_undefined
            | sys::ValueType::napi_null => false,
            _ => match value.get(c"length")?.number_value()? {
                Some(length) => length > 1000.0,
                None => false,
            },
        },
    };
    if !over {
        return Ok(value);
    }
    match value.string()? {
        Some(text) => {
            let mut shortened = text.truncate_units(1000);
            shortened.push_str("...");
            string_value(anchor, shortened)
        }
        None => {
            let sliced = value
                .get(c"slice")?
                .call(value, &[number(anchor, 0.0)?, number(anchor, 1000.0)?])?;
            let mut joined = sliced.coerce_string()?;
            joined.push_str("...");
            string_value(anchor, joined)
        }
    }
}

/// `(x || 0) + 1` for the disconnect counter (a number in production).
fn increment_one<'a>(anchor: LV<'a>, value: LV<'a>) -> Result<LV<'a>> {
    if let Some(mut text) = value.string()? {
        text.push_str("1");
        return string_value(anchor, text);
    }
    match value.kind()? {
        sys::ValueType::napi_number => number(anchor, value.number()? + 1.0),
        sys::ValueType::napi_boolean => number(anchor, if value.is_true()? { 2.0 } else { 1.0 }),
        _ => number(anchor, 1.0),
    }
}

/// `{ source: \`${provider.name}_event\`, provider, code, message }`.
fn provider_event<'a>(
    anchor: LV<'a>,
    provider: LV<'a>,
    code: &str,
    message: LV<'a>,
) -> Result<LV<'a>> {
    let name = provider.get(c"name")?;
    let source = JsString::concat(&[&name.coerce_string()?, &JsString::from_rust_str("_event")]);
    let out = object(anchor)?;
    out.set(c"source", string_value(anchor, source)?)?;
    out.set(c"provider", name)?;
    out.set(c"code", text(anchor, code)?)?;
    out.set(c"message", message)?;
    Ok(out)
}

/// `[multicc/chat] [${sessionName}] ${provider.name} ${log}`.
fn client_log(session: LV<'_>, provider: LV<'_>, log: LV<'_>) -> Result<JsString> {
    Ok(JsString::concat(&[
        &JsString::from_rust_str("[multicc/chat] ["),
        &template(session)?,
        &JsString::from_rust_str("] "),
        &template(provider.get(c"name")?)?,
        &JsString::from_rust_str(" "),
        &template(log)?,
    ]))
}

/// `[multicc/chat] [${sessionName}] captured ${provider.name} session id=${id}`.
fn capture_log(session: LV<'_>, provider: LV<'_>, id: &JsString) -> Result<JsString> {
    Ok(JsString::concat(&[
        &JsString::from_rust_str("[multicc/chat] ["),
        &template(session)?,
        &JsString::from_rust_str("] captured "),
        &template(provider.get(c"name")?)?,
        &JsString::from_rust_str(" session id="),
        id,
    ]))
}

fn forward_error(anchor: LV<'_>, forward: LV<'_>, message: JsString) -> Result<()> {
    let frame = object(anchor)?;
    frame.set(c"type", text(anchor, "error")?)?;
    frame.set(c"error", string_value(anchor, message)?)?;
    forward.call_plain(&[frame])?;
    Ok(())
}

/// `if (cs.claudeProc) { try { cs.claudeProc.kill('SIGTERM') } catch (_) {} }`.
fn terminate_proc(anchor: LV<'_>, cs: LV<'_>) -> Result<()> {
    let proc = cs.optional(c"claudeProc")?;
    if !proc.truthy()? {
        return Ok(());
    }
    let _ = proc.catch(|| {
        proc.get(c"kill")?.call(proc, &[text(anchor, "SIGTERM")?])?;
        Ok(())
    })?;
    Ok(())
}

fn finish_attempt(anchor: LV<'_>, ports: LV<'_>, runner: LV<'_>, code: &str) -> Result<()> {
    let facts = object(anchor)?;
    facts.set(c"errorCategory", text(anchor, "adapter_configuration")?)?;
    facts.set(c"reasonCode", text(anchor, code)?)?;
    call(
        ports.get(c"finishProviderAttempt")?,
        &[runner, text(anchor, "failed")?, facts],
    )?;
    Ok(())
}

/// `target.cli` interpolated into the two resume-mismatch messages.
fn cli_error(persisted: LV<'_>, suffix: &str) -> Result<JsString> {
    Ok(JsString::concat(&[
        &JsString::from_rust_str("目标 "),
        &template(persisted.get(c"cli")?)?,
        &JsString::from_rust_str(suffix),
    ]))
}

/// `captureNativeSessionId(persisted, evt.sessionId, { fresh: runner.freshNativeSession })`.
fn accept_session_id(
    anchor: LV<'_>,
    persisted: LV<'_>,
    evt: LV<'_>,
    runner: LV<'_>,
) -> Result<chat_events::CaptureSessionId> {
    let record = persisted.truthy()?;
    let previous_source = if record {
        persisted.optional(c"cliSessionId")?
    } else {
        persisted
    };
    let previous = trimmed_nullish(or_chain(&[previous_source, text(anchor, "")?])?)?;
    let incoming = trimmed_nullish(evt.optional(c"sessionId")?)?;
    let may_replace = runner.optional(c"freshNativeSession")?.is_true()?;
    let outcome = if record {
        chat_events::capture_session_id(previous.as_ref(), incoming.as_ref(), may_replace)
    } else {
        chat_events::CaptureSessionId::Unchanged
    };
    if let chat_events::CaptureSessionId::Changed(current) = &outcome {
        persisted.assign(c"cliSessionId", string_value(anchor, current.clone())?)?;
    }
    Ok(outcome)
}

/// `markReplaySafeAssistantEnvelope(adapterEnvelope, provider.name)`.
fn mark_adapter_envelope<'a>(
    anchor: LV<'a>,
    event: LV<'a>,
    provider: LV<'a>,
    ports: LV<'a>,
) -> Result<LV<'a>> {
    mark_replay_safe(anchor, event, provider.get(c"name")?, ports)
}

#[allow(clippy::too_many_arguments)]
fn apply_adapter_one<'a>(
    env: &'a Env,
    anchor: LV<'a>,
    mut evt: LV<'a>,
    cs: LV<'a>,
    persisted: LV<'a>,
    session: LV<'a>,
    forward: LV<'a>,
    turn: LV<'a>,
    runner: LV<'a>,
    provider: LV<'a>,
    ports: LV<'a>,
) -> Result<()> {
    if !evt.truthy()? {
        return Ok(());
    }
    evt = call(
        ports.get(c"scrub")?,
        &[runner.optional(c"providerAttempt")?, evt],
    )?;
    call(ports.get(c"observeAdapter")?, &[cs, evt, session])?;

    if evt.get(c"type")?.is_string("claude_event")? {
        return apply_claude_event(
            env,
            cs,
            session,
            evt.get(c"raw")?,
            forward,
            turn,
            runner,
            provider.get(c"name")?,
            ports,
        );
    }

    if evt.get(c"type")?.is_string("session_init")? {
        let model = evt.optional(c"model")?;
        if model.truthy()? {
            call(ports.get(c"noteReportedModel")?, &[session, model])?;
        }
        return Ok(());
    }

    if evt.get(c"type")?.is_string("native_session_missing")?
        && evt
            .get(c"sessionId")?
            .equals(persisted.get(c"cliSessionId")?)?
    {
        persisted.assign(c"cliSessionId", null(anchor)?)?;
        persisted.assign(c"_streamSessionId", null(anchor)?)?;
        runner.assign(c"freshNativeSession", boolean(anchor, true)?)?;
        call(ports.get(c"rememberActiveCliState")?, &[persisted])?;
        call(
            ports.get(c"savePersistedSessions")?,
            &[text(anchor, "runtime.codex-resume-missing")?],
        )?;
        let frame = object(anchor)?;
        frame.set(c"type", text(anchor, "system")?)?;
        frame.set(c"subtype", text(anchor, "warning")?)?;
        frame.set(
            c"message",
            text(
                anchor,
                "Codex 原生会话已不可复用（历史缺失或线路配置已变更），已自动新建会话并附带上下文摘要，继续本条消息。",
            )?,
        )?;
        forward.call_plain(&[frame])?;
        return Ok(());
    }

    if evt.get(c"type")?.is_string("session_started")? {
        let handoff = persisted.optional(c"pendingCliHandoff")?;
        let session_id = evt.optional(c"sessionId")?;
        let resume_mismatch = session_id.truthy()?
            && persisted.optional(c"cliSessionId")?.truthy()?
            && !session_id.equals(persisted.get(c"cliSessionId")?)?
            && handoff.truthy()?
            && handoff.optional(c"status")?.is_string("pending")?
            && handoff.optional(c"reusedTarget")?.truthy()?
            && handoff.optional(c"toCli")?.equals(persisted.get(c"cli")?)?;
        if resume_mismatch {
            cs.assign(
                c"_adapterError",
                text(
                    anchor,
                    "cross-cli target returned a different native session id",
                )?,
            )?;
            runner.assign(c"adapterError", cs.get(c"_adapterError")?)?;
            crate::chat_turn_effects::assign_kill_reason(
                runner,
                text(anchor, "cli_resume_mismatch")?,
            )?;
            forward_error(
                anchor,
                forward,
                cli_error(
                    persisted,
                    " 没有恢复预期的原生会话；未接受 CLI 返回的新会话。请重新切换并选择“重置目标 CLI 会话”。",
                )?,
            )?;
            finish_attempt(anchor, ports, runner, "cli_resume_mismatch")?;
            terminate_proc(anchor, cs)?;
            return Ok(());
        }
        match accept_session_id(anchor, persisted, evt, runner)? {
            chat_events::CaptureSessionId::Mismatch => {
                cs.assign(
                    c"_adapterError",
                    text(anchor, "native resume returned a different session id")?,
                )?;
                runner.assign(c"adapterError", cs.get(c"_adapterError")?)?;
                crate::chat_turn_effects::assign_kill_reason(
                    runner,
                    text(anchor, "native_resume_mismatch")?,
                )?;
                forward_error(
                    anchor,
                    forward,
                    cli_error(
                        persisted,
                        " 返回了不同的原生会话；为避免把回复写入错误上下文，本轮已停止。",
                    )?,
                )?;
                finish_attempt(anchor, ports, runner, "native_resume_mismatch")?;
                terminate_proc(anchor, cs)?;
            }
            chat_events::CaptureSessionId::Changed(current) => {
                call(ports.get(c"rememberActiveCliState")?, &[persisted])?;
                call(
                    ports.get(c"savePersistedSessions")?,
                    &[text(anchor, "runtime.chat-session-id-capture")?],
                )?;
                let message = capture_log(session, provider, &current)?;
                call(ports.get(c"consoleLog")?, &[string_value(anchor, message)?])?;
            }
            chat_events::CaptureSessionId::Unchanged => {}
        }
        return Ok(());
    }

    if evt.get(c"type")?.is_string("status")? {
        let phase = or_chain(&[evt.optional(c"phase")?, evt.optional(c"status")?])?;
        call(
            ports.get(c"updatePhase")?,
            &[session, turn.get(c"turnId")?, phase],
        )?;
        let status = object(anchor)?;
        status.set(
            c"status",
            or_chain(&[evt.optional(c"status")?, text(anchor, "thinking")?])?,
        )?;
        status.set(
            c"currentFile",
            or_chain(&[evt.optional(c"currentFile")?, null(anchor)?])?,
        )?;
        call(ports.get(c"setSessionStatus")?, &[session, status])?;
        return Ok(());
    }

    if evt.get(c"type")?.is_string("activity")? {
        let phase = object(anchor)?;
        phase.set(
            c"phase",
            or_chain(&[evt.optional(c"phase")?, text(anchor, "tool")?])?,
        )?;
        phase.set(c"safeToolKind", evt.optional(c"toolKind")?)?;
        call(
            ports.get(c"updatePhase")?,
            &[session, turn.get(c"turnId")?, phase],
        )?;
        let status = object(anchor)?;
        status.set(c"status", text(anchor, "running")?)?;
        status.set(c"currentFile", null(anchor)?)?;
        call(ports.get(c"setSessionStatus")?, &[session, status])?;
        return Ok(());
    }

    if evt.get(c"type")?.is_string("user_input_signal")? {
        let landed = call(
            ports.get(c"recordUserInput")?,
            &[evt, session, turn.get(c"turnId")?],
        )?;
        let log = evt.optional(c"log")?;
        if log.truthy()? {
            let message = client_log(session, provider, log)?;
            call(
                ports.get(c"consoleWarn")?,
                &[string_value(anchor, message)?],
            )?;
        }
        if landed.truthy()? && landed.optional(c"ok")?.truthy()? {
            return Ok(());
        }
        let fallback = or_chain(&[
            if landed.truthy()? {
                landed.optional(c"fallbackText")?
            } else {
                landed
            },
            evt.optional(c"fallbackText")?,
            text(anchor, "")?,
        ])?;
        evt = object(anchor)?;
        evt.set(c"type", text(anchor, "assistant_text")?)?;
        evt.set(c"text", fallback)?;
    }

    if evt.get(c"type")?.is_string("assistant_text")? {
        call(
            ports.get(c"updatePhase")?,
            &[session, turn.get(c"turnId")?, text(anchor, "thinking")?],
        )?;
        let incoming = evt.optional(c"text")?;
        if !incoming.truthy()? {
            return Ok(());
        }
        let prior = string_or_empty(cs.optional(c"currentAssistantText")?)?;
        let next = string_or_empty(incoming)?;
        let delta = evt.optional(c"delta")?.is_true()?;
        let joined = chat_events::append_adapter_text(&prior, &next, delta);
        cs.assign(c"currentAssistantText", redact_string(anchor, &joined)?)?;
        let frame = object(anchor)?;
        frame.set(c"type", text(anchor, "assistant")?)?;
        let message = object(anchor)?;
        message.set(c"textSnapshot", boolean(anchor, true)?)?;
        let content = array(anchor)?;
        let block = object(anchor)?;
        block.set(c"type", text(anchor, "text")?)?;
        block.set(c"text", cs.get(c"currentAssistantText")?)?;
        push(content, block)?;
        message.set(c"content", content)?;
        frame.set(c"message", message)?;
        let marked = mark_adapter_envelope(anchor, frame, provider, ports)?;
        forward.call_plain(&[marked])?;
        let status = object(anchor)?;
        status.set(c"status", text(anchor, "thinking")?)?;
        status.set(c"currentFile", null(anchor)?)?;
        call(ports.get(c"setSessionStatus")?, &[session, status])?;
        call(ports.get(c"scheduleIncrementalSave")?, &[session, cs])?;
        let log = evt.optional(c"log")?;
        if log.truthy()? {
            let message = client_log(session, provider, log)?;
            call(
                ports.get(c"consoleWarn")?,
                &[string_value(anchor, message)?],
            )?;
        }
        return Ok(());
    }

    if evt.get(c"type")?.is_string("tool_start")? {
        call(
            ports.get(c"updatePhase")?,
            &[
                session,
                turn.get(c"turnId")?,
                text(anchor, "tool")?,
                evt.optional(c"name")?,
            ],
        )?;
        let tools = cs.get(c"currentToolCalls")?;
        let tool = object(anchor)?;
        tool.set(c"name", evt.optional(c"name")?)?;
        tool.set(
            c"input",
            or_chain(&[evt.optional(c"input")?, object(anchor)?])?,
        )?;
        tool.set(c"id", evt.optional(c"id")?)?;
        tool.set(c"startedAt", number(anchor, now(anchor)?)?)?;
        push(tools, tool)?;
        call(
            ports.get(c"backgroundRecordToolUseId")?,
            &[session, evt.optional(c"id")?],
        )?;
        let frame = object(anchor)?;
        frame.set(c"type", text(anchor, "assistant")?)?;
        let message = object(anchor)?;
        let content = array(anchor)?;
        let block = object(anchor)?;
        block.set(c"type", text(anchor, "tool_use")?)?;
        block.set(c"name", evt.optional(c"name")?)?;
        block.set(c"id", evt.optional(c"id")?)?;
        block.set(
            c"input",
            or_chain(&[evt.optional(c"input")?, object(anchor)?])?,
        )?;
        push(content, block)?;
        message.set(c"content", content)?;
        frame.set(c"message", message)?;
        forward.call_plain(&[frame])?;
        let status = object(anchor)?;
        status.set(
            c"status",
            or_chain(&[evt.optional(c"status")?, text(anchor, "running")?])?,
        )?;
        status.set(
            c"currentFile",
            or_chain(&[evt.optional(c"currentFile")?, null(anchor)?])?,
        )?;
        call(ports.get(c"setSessionStatus")?, &[session, status])?;
        return Ok(());
    }

    if evt.get(c"type")?.is_string("tool_result")? {
        call(
            ports.get(c"updatePhase")?,
            &[session, turn.get(c"turnId")?, text(anchor, "thinking")?],
        )?;
        let content_value = or_chain(&[evt.optional(c"content")?, text(anchor, "")?])?;
        let is_error = evt.optional(c"isError")?.truthy()?;
        let frame = object(anchor)?;
        frame.set(c"type", text(anchor, "user")?)?;
        let message = object(anchor)?;
        let content = array(anchor)?;
        let block = object(anchor)?;
        block.set(c"type", text(anchor, "tool_result")?)?;
        block.set(c"tool_use_id", evt.optional(c"id")?)?;
        block.set(c"content", content_value)?;
        block.set(c"is_error", boolean(anchor, is_error)?)?;
        push(content, block)?;
        message.set(c"content", content)?;
        frame.set(c"message", message)?;
        forward.call_plain(&[frame])?;
        let tools = cs.get(c"currentToolCalls")?;
        if let Some(tool) = find_tool_by_id(tools, evt.optional(c"id")?)? {
            tool.assign(c"result", preview(anchor, content_value)?)?;
            tool.assign(c"is_error", boolean(anchor, is_error)?)?;
            tool.assign(c"endedAt", number(anchor, now(anchor)?)?)?;
        }
        return Ok(());
    }

    if evt.get(c"type")?.is_string("tool_update")? {
        let completed = evt.optional(c"completed")?.truthy()?;
        call(
            ports.get(c"updatePhase")?,
            &[
                session,
                turn.get(c"turnId")?,
                text(anchor, if completed { "thinking" } else { "tool" })?,
                evt.optional(c"name")?,
            ],
        )?;
        let tools = cs.get(c"currentToolCalls")?;
        let raw_id = evt.optional(c"id")?;
        let id = if raw_id.truthy()? {
            raw_id
        } else {
            let length = tools.get(c"length")?.number()? as u64;
            string_value(anchor, JsString::from_rust_str(&format!("call_{length}")))?
        };
        let tool = match find_tool_by_id(tools, id)? {
            Some(tool) => tool,
            None => {
                let tool = object(anchor)?;
                tool.set(c"name", evt.optional(c"name")?)?;
                tool.set(
                    c"input",
                    or_chain(&[evt.optional(c"input")?, object(anchor)?])?,
                )?;
                tool.set(c"id", id)?;
                tool.set(c"startedAt", number(anchor, now(anchor)?)?)?;
                push(tools, tool)?;
                call(ports.get(c"backgroundRecordToolUseId")?, &[session, id])?;
                let frame = object(anchor)?;
                frame.set(c"type", text(anchor, "assistant")?)?;
                let message = object(anchor)?;
                let content = array(anchor)?;
                let block = object(anchor)?;
                block.set(c"type", text(anchor, "tool_use")?)?;
                block.set(c"name", evt.optional(c"name")?)?;
                block.set(c"id", id)?;
                block.set(
                    c"input",
                    or_chain(&[evt.optional(c"input")?, object(anchor)?])?,
                )?;
                push(content, block)?;
                message.set(c"content", content)?;
                frame.set(c"message", message)?;
                forward.call_plain(&[frame])?;
                tool
            }
        };
        let status = object(anchor)?;
        status.set(c"status", text(anchor, "running")?)?;
        status.set(
            c"currentFile",
            or_chain(&[evt.optional(c"currentFile")?, null(anchor)?])?,
        )?;
        call(ports.get(c"setSessionStatus")?, &[session, status])?;
        if completed {
            let content_value = or_chain(&[evt.optional(c"content")?, text(anchor, "")?])?;
            let is_error = evt.optional(c"isError")?.truthy()?;
            let frame = object(anchor)?;
            frame.set(c"type", text(anchor, "user")?)?;
            let message = object(anchor)?;
            let content = array(anchor)?;
            let block = object(anchor)?;
            block.set(c"type", text(anchor, "tool_result")?)?;
            block.set(c"tool_use_id", id)?;
            block.set(c"content", content_value)?;
            block.set(c"is_error", boolean(anchor, is_error)?)?;
            push(content, block)?;
            message.set(c"content", content)?;
            frame.set(c"message", message)?;
            forward.call_plain(&[frame])?;
            tool.assign(c"result", preview(anchor, content_value)?)?;
            tool.assign(c"is_error", boolean(anchor, is_error)?)?;
            tool.assign(c"endedAt", number(anchor, now(anchor)?)?)?;
        }
        return Ok(());
    }

    if evt.get(c"type")?.is_string("thinking")? {
        call(
            ports.get(c"updatePhase")?,
            &[session, turn.get(c"turnId")?, text(anchor, "thinking")?],
        )?;
        let reasoning_text = evt.optional(c"text")?;
        let is_text = reasoning_text.kind()? == sys::ValueType::napi_string
            && reasoning_text
                .string()?
                .map(|text| !text.is_empty())
                .unwrap_or(false);
        if is_text {
            let reasoning = object(anchor)?;
            reasoning.set(c"type", text(anchor, "reasoning")?)?;
            let id = evt.optional(c"id")?;
            reasoning.set(
                c"id",
                if id.kind()? == sys::ValueType::napi_string {
                    id
                } else {
                    null(anchor)?
                },
            )?;
            reasoning.set(c"text", reasoning_text)?;
            reasoning.set(c"snapshot", boolean(anchor, true)?)?;
            forward.call_plain(&[reasoning])?;
        }
        let tools = cs.get(c"currentToolCalls")?;
        let id = evt.optional(c"id")?;
        let found = if id.truthy()? {
            find_tool_by_id(tools, id)?
        } else {
            None
        };
        let snapshot = evt.optional(c"snapshot")?.is_true()?;
        let tool_input = object(anchor)?;
        tool_input.set(
            c"text",
            or_chain(&[evt.optional(c"text")?, text(anchor, "")?])?,
        )?;
        let tool = match found {
            Some(tool) if snapshot => {
                tool.assign(c"input", tool_input)?;
                tool
            }
            _ => {
                let tool = object(anchor)?;
                tool.set(c"name", text(anchor, "Thinking")?)?;
                tool.set(c"input", tool_input)?;
                tool.set(c"id", id)?;
                tool.set(c"startedAt", number(anchor, now(anchor)?)?)?;
                push(tools, tool)?;
                call(ports.get(c"backgroundRecordToolUseId")?, &[session, id])?;
                tool
            }
        };
        let frame = object(anchor)?;
        frame.set(c"type", text(anchor, "assistant")?)?;
        let message = object(anchor)?;
        let content = array(anchor)?;
        let block = object(anchor)?;
        block.set(c"type", text(anchor, "tool_use")?)?;
        block.set(c"name", text(anchor, "Thinking")?)?;
        block.set(c"id", id)?;
        block.set(c"input", tool.get(c"input")?)?;
        push(content, block)?;
        message.set(c"content", content)?;
        frame.set(c"message", message)?;
        forward.call_plain(&[frame])?;
        if !evt.optional(c"delta")?.is_true()? || evt.optional(c"completed")?.is_true()? {
            let content_value = or_chain(&[evt.optional(c"text")?, text(anchor, "")?])?;
            let frame = object(anchor)?;
            frame.set(c"type", text(anchor, "user")?)?;
            let message = object(anchor)?;
            let content = array(anchor)?;
            let block = object(anchor)?;
            block.set(c"type", text(anchor, "tool_result")?)?;
            block.set(c"tool_use_id", id)?;
            block.set(c"content", content_value)?;
            block.set(c"is_error", boolean(anchor, false)?)?;
            push(content, block)?;
            message.set(c"content", content)?;
            frame.set(c"message", message)?;
            forward.call_plain(&[frame])?;
            tool.assign(c"endedAt", number(anchor, now(anchor)?)?)?;
        }
        return Ok(());
    }

    if evt.get(c"type")?.is_string("complete")? {
        runner.assign(c"pendingCompletionEvent", evt)?;
        return Ok(());
    }

    if evt.get(c"type")?.is_string("error")? {
        let public_message = crate::api_error_text::sanitize(
            evt.optional(c"message")?,
            undefined(anchor)?,
            undefined(anchor)?,
        )?;
        let kind = or_chain(&[evt.optional(c"kind")?, text(anchor, "provider_error")?])?;
        let fields = object(anchor)?;
        fields.set(c"sessionId", session)?;
        fields.set(c"turnId", turn.get(c"turnId")?)?;
        fields.set(c"runnerId", runner.optional(c"runnerId")?)?;
        fields.set(c"provider", provider.get(c"name")?)?;
        fields.set(c"kind", kind)?;
        fields.set(c"message", public_message)?;
        log(
            ports.get(c"logger")?,
            c"warn",
            "chat_provider_error_observed",
            fields,
        )?;
        call(
            ports.get(c"updatePhase")?,
            &[
                session,
                turn.get(c"turnId")?,
                text(
                    anchor,
                    if kind.is_string("transport_disconnect")? {
                        "recovering"
                    } else {
                        "finalizing"
                    },
                )?,
            ],
        )?;
        if kind.is_string("response_completed_disconnect")? {
            cs.assign(c"_codexPendingStreamError", public_message)?;
            let current = or_chain(&[
                cs.optional(c"_codexPendingStreamErrorCount")?,
                number(anchor, 0.0)?,
            ])?;
            cs.assign(
                c"_codexPendingStreamErrorCount",
                increment_one(anchor, current)?,
            )?;
            let mut has_output = cs.optional(c"currentAssistantText")?.truthy()?;
            if !has_output {
                has_output = cs.get(c"currentToolCalls")?.get(c"length")?.truthy()?;
            }
            if !has_output {
                has_output = cs.optional(c"_resultSaved")?.truthy()?;
            }
            if has_output {
                cs.assign(c"_codexRecoveredDisconnect", boolean(anchor, true)?)?;
            }
            let fields = object(anchor)?;
            fields.set(c"sessionId", session)?;
            fields.set(c"provider", provider.get(c"name")?)?;
            fields.set(c"afterOutput", boolean(anchor, has_output)?)?;
            fields.set(c"occurrence", cs.get(c"_codexPendingStreamErrorCount")?)?;
            log(
                ports.get(c"logger")?,
                c"warn",
                "chat_provider_response_completed_disconnect",
                fields,
            )?;
        } else if kind.is_string("transport_disconnect")? {
            cs.assign(c"_codexTransportError", public_message)?;
            cs.assign(c"_sawApiError", boolean(anchor, true)?)?;
            runner.assign(c"sawApiError", boolean(anchor, true)?)?;
            runner.assign(
                c"apiErrorRaw",
                or_chain(&[
                    evt.optional(c"error")?,
                    provider_event(
                        anchor,
                        provider,
                        "connection_reset",
                        evt.optional(c"message")?,
                    )?,
                ])?,
            )?;
            let phase = if meaningful_output(cs)? || has_side_effects(cs)? {
                "stream"
            } else {
                "before_first_token"
            };
            let fields = object(anchor)?;
            fields.set(c"sessionId", session)?;
            fields.set(c"provider", provider.get(c"name")?)?;
            fields.set(c"phase", text(anchor, phase)?)?;
            log(
                ports.get(c"logger")?,
                c"warn",
                "chat_provider_transport_error",
                fields,
            )?;
        } else {
            cs.assign(c"_adapterError", public_message)?;
            runner.assign(c"adapterError", public_message)?;
            runner.assign(c"sawApiError", boolean(anchor, true)?)?;
            runner.assign(
                c"apiErrorRaw",
                or_chain(&[
                    evt.optional(c"error")?,
                    provider_event(
                        anchor,
                        provider,
                        "provider_error",
                        evt.optional(c"message")?,
                    )?,
                ])?,
            )?;
            let label = or_chain(&[evt.optional(c"label")?, provider.get(c"name")?])?;
            let mut message = template(label)?;
            message.push_str(" 出错：");
            message.push(&template(public_message)?);
            forward_error(anchor, forward, message)?;
        }
        return Ok(());
    }

    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn apply_adapter_event<'a>(
    env: &'a Env,
    anchor: LV<'a>,
    cs: LV<'a>,
    persisted: LV<'a>,
    session: LV<'a>,
    raw_event: LV<'a>,
    forward: LV<'a>,
    turn: LV<'a>,
    runner: LV<'a>,
    provider: LV<'a>,
    ports: LV<'a>,
) -> Result<()> {
    if !is_current(anchor, cs, turn, runner)? {
        return Ok(());
    }
    call(
        ports.get(c"touchActivity")?,
        &[session, turn.get(c"turnId")?],
    )?;
    let decoded = call(ports.get(c"decodeEvent")?, &[provider, raw_event])?;
    let decoded = if decoded.truthy()? {
        decoded
    } else {
        array(anchor)?
    };
    let list = if decoded.is_array()? {
        decoded
    } else {
        let list = array(anchor)?;
        push(list, decoded)?;
        list
    };
    let completion = runner.optional(c"completion")?;
    completion
        .get(c"observe")?
        .call(completion, &[raw_event, list])?;
    list.for_each(|evt| {
        apply_adapter_one(
            env, anchor, evt, cs, persisted, session, forward, turn, runner, provider, ports,
        )
    })
}

#[napi]
#[allow(clippy::too_many_arguments)]
pub fn chat_apply_adapter_event(
    env: Env,
    provider: Unknown<'_>,
    cs: Unknown<'_>,
    persisted: Unknown<'_>,
    session_name: Unknown<'_>,
    raw_event: Unknown<'_>,
    forward: Unknown<'_>,
    turn: Unknown<'_>,
    runner: Unknown<'_>,
    ports: Unknown<'_>,
) -> Result<()> {
    let anchor = LiveValue::new(&env, ports);
    apply_adapter_event(
        &env,
        anchor,
        LiveValue::new(&env, cs),
        LiveValue::new(&env, persisted),
        LiveValue::new(&env, session_name),
        LiveValue::new(&env, raw_event),
        LiveValue::new(&env, forward),
        LiveValue::new(&env, turn),
        LiveValue::new(&env, runner),
        LiveValue::new(&env, provider),
        anchor,
    )
}
