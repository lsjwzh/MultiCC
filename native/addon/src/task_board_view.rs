//! Read the two host facts for one session. The board host iterates its live
//! references in V8 and calls this once per distinct session.
use crate::{js_live::LiveValue, task_board_host::Host};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;

#[napi]
pub fn task_board_session_fact(
    env: Env,
    options: Unknown<'_>,
    read_run_state: Unknown<'_>,
    id: Unknown<'_>,
) -> Result<sys::napi_value> {
    let options = LiveValue::new(&env, options);
    let id = LiveValue::new(&env, id);
    let read_run_state = LiveValue::new(&env, read_run_state);
    let host = Host(options);
    // A failed admission lookup conservatively keeps the claim. An absent
    // port or a successful response other than literal true does not.
    let has_turn = options
        .catch(|| {
            let read = options.get(c"sessionHasTurn")?;
            Ok(!read.nullish()? && read.call(options, &[id])?.is_true()?)
        })?
        .unwrap_or(true);
    let run_state = if read_run_state.nullish()? {
        None
    } else {
        read_run_state.catch(|| read_run_state.call_plain(&[id]))?
    };
    let run_state = match run_state {
        Some(state) if state.truthy()? => state,
        _ => host.null()?,
    };
    Ok(host
        .object(&[
            (c"hasTurn", host.value(has_turn)?),
            (c"runState", run_state),
        ])?
        .raw())
}
