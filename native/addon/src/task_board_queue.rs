//! Live-value adapter for task-board queue projections.
use crate::js_live::LiveValue as L;
use multicc_core::{js::JsValue as J, task_board_queue as core};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;

#[napi]
pub fn task_board_turn_outcome(
    env: Env,
    outcome: Unknown<'_>,
    classify_state: Unknown<'_>,
    classify: Unknown<'_>,
) -> Result<sys::napi_value> {
    let outcome = L::new(&env, outcome);
    let state = L::new(&env, classify_state);
    let classify = L::new(&env, classify);
    let text = outcome.string()?.map(|value| value.to_string_lossy());
    match core::turn_outcome(text.as_deref()) {
        core::OutcomeProjection::State(value) => Ok(outcome.from_value(&J::string(value))?.raw()),
        core::OutcomeProjection::Classify(letter) => Ok(classify
            .call_plain(&[outcome.from_value(&J::string(letter))?])?
            .raw()),
        core::OutcomeProjection::Fallback => {
            let selected = if state.truthy()? {
                state
            } else {
                outcome.from_value(&J::string("D"))?
            };
            Ok(classify.call_plain(&[selected])?.raw())
        }
    }
}
