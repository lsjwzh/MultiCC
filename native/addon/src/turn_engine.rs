//! Dispatch recovery and process-close observations over live chat state.
mod admission_finish;
mod claim;
pub(crate) mod events;
mod execution;
mod invocation;
mod persistence;
mod preflight;
mod preparation;
mod process_runner;
mod runner_context;
mod services;
mod stream_finish;
mod streaming;
mod task_start;
use crate::{js_iteration::read, route_response::*};
use napi_derive::napi;
use std::ops::ControlFlow;

// History rows may be sparse, or append new rows while their properties are
// read. Bound temporary V8 handles without taking a snapshot of the array.
fn scan_history(
    env: &Env,
    history: L<'_>,
    start: u32,
    mut visit: impl FnMut(u32, L<'_>) -> Result<ControlFlow<()>>,
) -> Result<()> {
    let mut index = start;
    loop {
        let done = env.run_in_scope(|| {
            for _ in 0..128 {
                if index >= history.get(c"length")?.number()?.ceil() as u32 {
                    return Ok(true);
                }
                if visit(index, history.element(index)?)?.is_break() {
                    return Ok(true);
                }
                index += 1;
            }
            Ok(false)
        })?;
        if done {
            return Ok(());
        }
    }
}

#[napi]
pub fn chat_recover_dispatch_from_history(
    env: Env,
    history: Unknown<'_>,
    operation: Unknown<'_>,
) -> Result<sys::napi_value> {
    let history = L::new(&env, history);
    let operation = L::new(&env, operation);
    let array = history.is_array()?;
    let operation_id = operation.optional(c"id")?;
    let request_id = operation.optional(c"requestOutboxId")?;
    if !operation_id.truthy()? || !array {
        return Ok(null(history)?.raw());
    }
    let mut latest = None;
    let user_role = text(history, "user")?;
    let assistant_role = text(history, "assistant")?;
    scan_history(&env, history, 0, |index, row| {
        if row.truthy()?
            && row.get(c"role")?.equals(user_role)?
            && (row.get(c"originDispatchId")?.equals(operation_id)?
                || (request_id.truthy()?
                    && (row.get(c"deliveryId")?.equals(request_id)?
                        || row.get(c"clientMsgId")?.equals(request_id)?)))
        {
            latest = Some(index);
        }
        Ok(ControlFlow::Continue(()))
    })?;
    let Some(index) = latest else {
        return Ok(null(history)?.raw());
    };
    let turn = history.element(index)?.optional(c"turnId")?;
    // Keep the actual last matching object across handle scopes, even when a
    // subsequent getter mutates or deletes that history entry.
    let selected = fields(history, &[("row", null(history)?)])?;
    scan_history(&env, history, index + 1, |_, row| {
        if row.truthy()? {
            if row.get(c"role")?.equals(user_role)?
                && (!turn.truthy()? || !row.get(c"turnId")?.equals(turn)?)
            {
                return Ok(ControlFlow::Break(()));
            }
            if row.get(c"role")?.equals(assistant_role)?
                && !(turn.truthy()?
                    && row.get(c"turnId")?.truthy()?
                    && !row.get(c"turnId")?.equals(turn)?)
            {
                selected.set(c"row", row)?;
            }
        }
        Ok(ControlFlow::Continue(()))
    })?;
    let row = selected.get(c"row")?;
    let (complete, content) = if row.nullish()? {
        (false, text(history, "")?)
    } else {
        let partial = row.get(c"_interim")?.truthy()?
            || row.get(c"partial")?.truthy()?
            || row.get(c"cancelled")?.truthy()?
            || row.get(c"error")?.truthy()?;
        let content = string(fallback(row.get(c"content")?, "".into())?)?;
        if partial {
            (false, call(content, c"slice", &[num(history, -4000.0)?])?)
        } else {
            (true, content)
        }
    };
    Ok(fields(
        history,
        &[
            ("completed", flag(history, complete)?),
            (if complete { "text" } else { "lastOutput" }, content),
        ],
    )?
    .raw())
}

fn default_to(value: L<'_>, default: V) -> Result<L<'_>> {
    if value.undefined()? {
        value.from_value(&default)
    } else {
        Ok(value)
    }
}

#[napi]
pub fn chat_derive_close_turn_facts(
    env: Env,
    cs: Unknown<'_>,
    turn: Unknown<'_>,
    options: Unknown<'_>,
) -> Result<sys::napi_value> {
    let cs = L::new(&env, cs);
    let turn = L::new(&env, turn);
    let options = L::new(&env, options);
    let session = read(options, c"sessionName")?;
    let pid = options.get(c"pid")?;
    let code = options.get(c"code")?;
    let signal = options.get(c"signal")?;
    let duration = options.get(c"durMs")?;
    let reason = options.get(c"killReason")?;
    let completion = options.get(c"completionOutcome")?;
    let retry = options.get(c"isRetry")?;
    let stream_error = options.get(c"pendingStreamError")?;
    let transport = default_to(options.get(c"pendingTransportError")?, "".into())?;
    let count = default_to(options.get(c"pendingStreamErrorCount")?, V::Number(0.0))?;
    let stderr = default_to(options.get(c"stderrTail")?, "".into())?;
    let has_output = read(cs, c"_resultSaved")?.truthy()?
        || cs.get(c"currentAssistantText")?.truthy()?
        || read(cs.get(c"currentToolCalls")?, c"length")?.truthy()?;
    let recovered =
        (cs.get(c"_codexRecoveredDisconnect")?.truthy()? || stream_error.truthy()?) && has_output;
    let diag = fields(
        cs,
        &[
            ("session", session),
            ("cli", cs.get(c"cli")?),
            ("pid", pid),
            ("code", code),
            ("signal", signal),
            ("durMs", duration),
            ("killReason", reason),
            (
                "resultSaved",
                flag(cs, read(turn, c"resultDurable")?.truthy()?)?,
            ),
            ("completion", completion),
            (
                "gotText",
                fallback(cs.get(c"currentAssistantText")?, "".into())?.get(c"length")?,
            ),
            ("toolCalls", read(cs.get(c"currentToolCalls")?, c"length")?),
            ("liveClients", read(cs.get(c"clients")?, c"size")?),
            ("isRetry", flag(cs, retry.truthy()?)?),
            ("recoveredCodexDisconnect", flag(cs, recovered)?),
            (
                "pendingTransportError",
                call(transport, c"slice", &[num(cs, 0.0)?, num(cs, 200.0)?])?,
            ),
            ("pendingStreamErrorCount", count),
            ("stderrTail", stderr),
        ],
    )?;
    let kind = if signal.truthy()? {
        let (label, value) = if reason.truthy()? {
            ("killed(", reason)
        } else {
            ("signaled(", signal)
        };
        let mut label = multicc_core::js::JsString::from(label);
        label.push(&value.coerce_string()?);
        label.push_str(")");
        cs.from_value(&V::String(label))?
    } else if !code.is_number(0.0)? && !recovered {
        text(cs, "nonzero_exit")?
    } else if !turn.get(c"resultDurable")?.truthy()?
        && !cs.get(c"currentAssistantText")?.truthy()?
        && !read(cs.get(c"currentToolCalls")?, c"length")?.truthy()?
    {
        text(cs, "empty_exit")?
    } else {
        text(cs, "normal")?
    };
    Ok(fields(
        cs,
        &[
            ("hasTurnOutput", flag(cs, has_output)?),
            ("recoveredCodexDisconnect", flag(cs, recovered)?),
            ("diag", diag),
            ("kind", kind),
        ],
    )?
    .raw())
}
