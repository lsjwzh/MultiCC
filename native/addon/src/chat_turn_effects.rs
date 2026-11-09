//! Synchronous transitions against the runner objects still owned by the host.
//! Reads and strict assignments keep their original order, including reentry.
use crate::{cli_completion::completed, js_live::LiveValue};
use multicc_core::js::JsValue;
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;

fn result<'a>(anchor: LiveValue<'a>, ok: bool, code: Option<&str>) -> Result<LiveValue<'a>> {
    anchor.from_value(&JsValue::object(vec![
        ("ok", JsValue::Bool(ok)),
        ("code", code.map(JsValue::string).unwrap_or(JsValue::Null)),
    ]))
}

fn current(turn: LiveValue<'_>, runner: LiveValue<'_>, facts: LiveValue<'_>) -> Result<bool> {
    Ok(turn.truthy()?
        && runner.truthy()?
        && runner.get(c"turnId")?.equals(turn.get(c"turnId")?)?
        && facts.get(c"current")?.is_true()?)
}

fn stale_result(turn: LiveValue<'_>) -> Result<sys::napi_value> {
    let value = result(turn, false, Some("stale_runner"))?;
    let durable = turn.truthy()? && turn.get(c"resultDurable")?.truthy()?;
    value.set(c"resultDurable", turn.from_value(&JsValue::Bool(durable))?)?;
    Ok(value.freeze()?.raw())
}

#[napi]
pub fn chat_owns_current_runner(
    env: Env,
    current_turn: Unknown<'_>,
    current_runner: Unknown<'_>,
    turn: Unknown<'_>,
    runner: Unknown<'_>,
) -> Result<bool> {
    let turn = LiveValue::new(&env, turn);
    let runner = LiveValue::new(&env, runner);
    Ok(LiveValue::new(&env, current_turn).equals(turn)?
        && LiveValue::new(&env, current_runner).equals(runner)?
        && turn.truthy()?
        && runner.truthy()?
        && runner.get(c"turnId")?.equals(turn.get(c"turnId")?)?)
}

/// `assignKillReason(runner, reason)`: the adapter reducer needs the same
/// transition in-process when a native session id cannot be accepted.
pub(crate) fn assign_kill_reason(runner: LiveValue<'_>, reason: LiveValue<'_>) -> Result<bool> {
    if !runner.truthy()? {
        return Ok(false);
    }
    let reason = reason.clean_text()?;
    runner.assign(
        c"killReason",
        if reason.truthy()? {
            reason
        } else {
            runner.from_value(&JsValue::Null)?
        },
    )?;
    runner.get(c"killReason")?.truthy()
}

#[napi]
pub fn chat_assign_kill_reason(env: Env, runner: Unknown<'_>, reason: Unknown<'_>) -> Result<bool> {
    assign_kill_reason(LiveValue::new(&env, runner), LiveValue::new(&env, reason))
}

#[napi]
pub fn chat_clear_succeeded_errors(
    env: Env,
    turn: Unknown<'_>,
    runner: Unknown<'_>,
    cs: Unknown<'_>,
    facts: Unknown<'_>,
) -> Result<bool> {
    let turn = LiveValue::new(&env, turn);
    let runner = LiveValue::new(&env, runner);
    let cs = LiveValue::new(&env, cs);
    let facts = LiveValue::new(&env, facts);
    if !turn.truthy()? || !runner.truthy()? || !turn.get(c"resultDurable")?.is_true()? {
        return Ok(false);
    }
    if !completed(runner.get(c"completionOutcome")?)?
        || !runner.get(c"runnerId")?.truthy()?
        || !turn
            .get(c"resultRunnerId")?
            .equals(runner.get(c"runnerId")?)?
    {
        return Ok(false);
    }
    if facts.get(c"killReason")?.truthy()? {
        return Ok(false);
    }
    if !facts.get(c"code")?.undefined()?
        && !facts
            .get(c"code")?
            .equals(facts.from_value(&JsValue::Null)?)?
        && !facts.get(c"code")?.is_number(0.0)?
    {
        return Ok(false);
    }
    if facts.get(c"boundaryErrorEnvelope")?.truthy()? {
        return Ok(false);
    }
    let had_errors = runner.get(c"sawApiError")?.truthy()?
        || runner.get(c"apiErrorRaw")?.truthy()?
        || runner.get(c"adapterError")?.truthy()?
        || cs.optional(c"_sawApiError")?.truthy()?
        || cs.optional(c"_adapterError")?.truthy()?
        || cs.optional(c"_codexTransportError")?.truthy()?
        || cs.optional(c"_codexPendingStreamError")?.truthy()?;
    let no = runner.from_value(&JsValue::Bool(false))?;
    let null = runner.from_value(&JsValue::Null)?;
    runner.assign(c"sawApiError", no)?;
    runner.assign(c"apiErrorRaw", null)?;
    runner.assign(c"adapterError", null)?;
    if cs.truthy()? {
        cs.assign(c"_sawApiError", no)?;
        cs.assign(c"_adapterError", null)?;
        let empty = runner.from_value(&JsValue::string(""))?;
        cs.assign(c"_codexTransportError", empty)?;
        cs.assign(c"_codexPendingStreamError", empty)?;
    }
    Ok(had_errors)
}

#[napi]
pub fn chat_record_result_event(
    env: Env,
    turn: Unknown<'_>,
    runner: Unknown<'_>,
    facts: Unknown<'_>,
) -> Result<sys::napi_value> {
    let turn = LiveValue::new(&env, turn);
    let runner = LiveValue::new(&env, runner);
    let facts = LiveValue::new(&env, facts);
    if !current(turn, runner, facts)? {
        return stale_result(turn);
    }
    let yes = turn.from_value(&JsValue::Bool(true))?;
    runner.assign(c"resultEvent", yes)?;
    if facts.get(c"persisted")?.is_true()? {
        turn.assign(c"resultDurable", yes)?;
        turn.assign(c"resultRunnerId", runner.get(c"runnerId")?)?;
    }
    let ok = facts.get(c"persisted")?.is_true()?;
    let code = if facts.get(c"persisted")?.is_true()? {
        None
    } else {
        Some("result_not_durable")
    };
    let value = result(turn, ok, code)?;
    value.set(c"resultDurable", turn.get(c"resultDurable")?)?;
    Ok(value.freeze()?.raw())
}

#[napi]
pub fn chat_record_close_result(
    env: Env,
    turn: Unknown<'_>,
    runner: Unknown<'_>,
    facts: Unknown<'_>,
) -> Result<sys::napi_value> {
    let turn = LiveValue::new(&env, turn);
    let runner = LiveValue::new(&env, runner);
    let facts = LiveValue::new(&env, facts);
    if !current(turn, runner, facts)? {
        return stale_result(turn);
    }
    if facts.get(c"final")?.is_true()? && facts.get(c"persisted")?.is_true()? {
        turn.assign(c"resultDurable", turn.from_value(&JsValue::Bool(true))?)?;
        turn.assign(c"resultRunnerId", runner.get(c"runnerId")?)?;
    }
    let ok = facts.get(c"final")?.is_true()? && facts.get(c"persisted")?.is_true()?;
    let code = if !facts.get(c"final")?.is_true()? {
        Some("not_final_result")
    } else if !facts.get(c"persisted")?.is_true()? {
        Some("result_not_durable")
    } else {
        None
    };
    let value = result(turn, ok, code)?;
    value.set(c"resultDurable", turn.get(c"resultDurable")?)?;
    Ok(value.freeze()?.raw())
}

#[napi]
pub fn chat_record_partial_checkpoint(
    env: Env,
    turn: Unknown<'_>,
    runner: Unknown<'_>,
    facts: Unknown<'_>,
) -> Result<sys::napi_value> {
    let turn = LiveValue::new(&env, turn);
    let runner = LiveValue::new(&env, runner);
    let facts = LiveValue::new(&env, facts);
    if !current(turn, runner, facts)? {
        return Ok(result(turn, false, Some("stale_runner"))?.freeze()?.raw());
    }
    let key = facts.get(c"checkpointKey")?.clean_text()?;
    if !facts.get(c"persisted")?.is_true()? || !key.truthy()? {
        return Ok(result(turn, false, Some("checkpoint_not_durable"))?
            .freeze()?
            .raw());
    }
    runner.assign(c"partialCheckpointKey", key)?;
    let value = result(turn, true, None)?;
    value.set(c"checkpointKey", key)?;
    Ok(value.freeze()?.raw())
}

#[napi]
pub fn chat_has_partial_checkpoint(
    env: Env,
    runner: Unknown<'_>,
    checkpoint_key: Unknown<'_>,
) -> Result<bool> {
    let runner = LiveValue::new(&env, runner);
    Ok(runner.truthy()?
        && runner.get(c"partialCheckpointKey")?.truthy()?
        && runner
            .get(c"partialCheckpointKey")?
            .equals(LiveValue::new(&env, checkpoint_key).clean_text()?)?)
}
