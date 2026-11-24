//! Stop only the runner belonging to the accepted timed-out provider attempt.
//! Compare live attempt fields in order so a stale event never cancels a new turn.
use crate::js_live::LiveValue;
use multicc_core::js::JsValue;
use napi::{bindgen_prelude::Unknown, Env, Result};
use napi_derive::napi;

#[napi]
#[allow(clippy::too_many_arguments)]
pub fn recover_model_timeout(
    env: Env,
    event: Unknown<'_>,
    outcome: Unknown<'_>,
    sessions: Unknown<'_>,
    stream: Unknown<'_>,
    stall_code: Unknown<'_>,
    mark: Unknown<'_>,
    stop_child: Unknown<'_>,
) -> Result<bool> {
    let event = LiveValue::new(&env, event);
    let outcome = LiveValue::new(&env, outcome);
    let failure = outcome.optional(c"failure")?;
    if !outcome.optional(c"accepted")?.truthy()? || !failure.truthy()? {
        return Ok(false);
    }
    let stall_code = LiveValue::new(&env, stall_code);
    if !stall_code.call_plain(&[failure.get(c"code")?])?.truthy()?
        && !failure.get(c"retryBudgetExhausted")?.truthy()?
    {
        return Ok(false);
    }
    let sessions = LiveValue::new(&env, sessions);
    let session = sessions
        .get(c"get")?
        .call(sessions, &[event.get(c"sessionId")?])?;
    let runner = session.optional(c"_activeRunner")?;
    let attempt = runner.optional(c"providerAttempt")?;
    if !attempt.truthy()?
        || runner.get(c"killReason")?.truthy()?
        || runner.get(c"modelTimeoutStopping")?.truthy()?
        || !session
            .get(c"_activeTurn")?
            .optional(c"turnId")?
            .equals(event.get(c"turnId")?)?
    {
        return Ok(false);
    }
    for field in [
        c"runtimeEpoch",
        c"turnId",
        c"routeAttemptId",
        c"routeGeneration",
        c"decisionId",
        c"attemptNo",
        c"providerRevision",
    ] {
        if !attempt.get(field)?.equals(event.get(field)?)? {
            return Ok(false);
        }
    }
    LiveValue::new(&env, mark).call_plain(&[runner, failure])?;
    if runner.get(c"kind")?.is_string("stream")? {
        let stream = LiveValue::new(&env, stream);
        stream
            .get(c"cancel")?
            .call(stream, &[event.get(c"sessionId")?])?;
    } else {
        let child = session.get(c"claudeProc")?;
        if !child.truthy()? {
            return Ok(false);
        }
        let grace_ms = child.from_value(&JsValue::Number(1_500.0))?;
        LiveValue::new(&env, stop_child).call_plain(&[child, grace_ms])?;
    }
    Ok(true)
}
