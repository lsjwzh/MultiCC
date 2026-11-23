//! Live-value adapter for task-board queue projections.
use crate::js_live::LiveValue as L;
use multicc_core::{js::JsValue as J, task_board_queue as core};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;

/// `classifyState || 'D'` on the live value, then the host's letter lookup.
/// The callback receives the selected value untouched so its JS identity and
/// any exception it raises survive the boundary unchanged.
fn classify_selected(classify: L, state: L, scratch: L) -> Result<sys::napi_value> {
    let selected = if state.truthy()? {
        state
    } else {
        scratch.from_value(&J::string("D"))?
    };
    Ok(classify.call_plain(&[selected])?.raw())
}

/// The `claim_released` projection, read for read identical to the retired
/// host function: `freezeReason` is read once for the truthiness check and a
/// second time as the callback argument; `queuedItems` is read again for its
/// `length` only when the first read was an array; a missing `queueSummary`
/// short-circuits to `undefined` exactly like `?.`.
fn claim_released(event: L, freeze: L, classify: L) -> Result<sys::napi_value> {
    let first = event.get(c"freezeReason")?;
    if first.truthy()? {
        let second = event.get(c"freezeReason")?;
        return Ok(freeze.call_plain(&[second])?.raw());
    }
    let probe = event.get(c"queuedItems")?;
    let depth = if probe.is_array()? {
        Some(event.get(c"queuedItems")?.get(c"length")?)
    } else {
        None
    };
    let depth_is_null = match depth {
        None => true,
        Some(value) => value.nullish()? && !value.undefined()?,
    };
    if depth_is_null {
        return Ok(event.from_value(&J::string("queued"))?.raw());
    }
    if let Some(value) = depth {
        if value.positive()? {
            return Ok(event.from_value(&J::string("queued"))?.raw());
        }
    }
    let summary = event.get(c"queueSummary")?;
    let state = if summary.nullish()? {
        event.from_value(&J::Undefined)?
    } else {
        summary.get(c"classifyState")?
    };
    classify_selected(classify, state, event)
}

/// Event type plus the raw event in, run state or null out. Every branch
/// reads the event's properties in the same order and count the retired host
/// chain did (`turnOutcome` before `classifyState`, both eagerly on
/// `completed`), and the freeze/classify lookups stay host callbacks so live
/// JS values and exceptions keep their exact behavior.
#[napi]
pub fn task_board_queue_run_state(
    env: Env,
    event_type: String,
    event: Unknown<'_>,
    freeze: Unknown<'_>,
    classify: Unknown<'_>,
) -> Result<sys::napi_value> {
    let event = L::new(&env, event);
    let freeze = L::new(&env, freeze);
    let classify = L::new(&env, classify);
    match core::queue_branch(&event_type) {
        core::QueueBranch::ClaimReleased => claim_released(event, freeze, classify),
        core::QueueBranch::Queued => Ok(event.from_value(&J::string("queued"))?.raw()),
        core::QueueBranch::Running => Ok(event.from_value(&J::string("running"))?.raw()),
        core::QueueBranch::Completed => {
            let outcome = event.get(c"turnOutcome")?;
            let state = event.get(c"classifyState")?;
            let text = outcome.string()?.map(|value| value.to_string_lossy());
            match core::turn_outcome(text.as_deref()) {
                core::OutcomeProjection::State(value) => {
                    Ok(event.from_value(&J::string(value))?.raw())
                }
                core::OutcomeProjection::Classify(letter) => Ok(classify
                    .call_plain(&[event.from_value(&J::string(letter))?])?
                    .raw()),
                core::OutcomeProjection::Fallback => classify_selected(classify, state, event),
            }
        }
        core::QueueBranch::Reconcile => {
            let state = event.get(c"classifyState")?;
            classify_selected(classify, state, event)
        }
        core::QueueBranch::Frozen => {
            let reason = event.get(c"freezeReason")?;
            Ok(freeze.call_plain(&[reason])?.raw())
        }
        core::QueueBranch::Idle => Ok(event.from_value(&J::string("idle"))?.raw()),
        core::QueueBranch::Ignore => Ok(event.from_value(&J::Null)?.raw()),
    }
}
