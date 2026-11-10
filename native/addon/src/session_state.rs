//! Selected-property compatibility reads for the native transition kernel.
use crate::js_live::LiveValue as L;
use multicc_core::{
    js::{JsString, JsValue as V},
    workspace_state::{self as core, RunState, Transition},
};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;

// napi emits its registration (`cfg(not(test))`) only for non-test builds, so
// the test build sees no Rust caller for exports that JS calls by name.
#[cfg_attr(test, allow(dead_code))]
pub(crate) fn initial(anchor: L<'_>) -> Result<L<'_>> {
    anchor.from_value(&RunState::default().value())?.freeze()
}
#[cfg_attr(test, allow(dead_code))]
pub(crate) fn previous(value: L<'_>) -> Result<(RunState, L<'_>)> {
    if !value.truthy()? || value.kind()? != sys::ValueType::napi_object {
        return Ok((RunState::default(), value.from_value(&V::string("idle"))?));
    }
    let supported = value
        .get(c"status")?
        .string()?
        .is_some_and(|s| core::supported(&s));
    let raw_status = if supported {
        value.get(c"status")?
    } else {
        value.from_value(&V::string("idle"))?
    };
    let status = raw_status.string()?;
    let activity = value.get(c"lastActivity")?.explicit_number()?;
    let started = if value.get(c"runStartedAt")?.explicit_number()?.is_finite() {
        Some(value.get(c"runStartedAt")?.explicit_number()?)
    } else {
        None
    };
    let ended = if value.get(c"runEndedAt")?.explicit_number()?.is_finite() {
        Some(value.get(c"runEndedAt")?.explicit_number()?)
    } else {
        None
    };
    Ok((
        RunState {
            status,
            last_activity: if activity.is_nan() {
                0.0
            } else {
                activity.max(0.0)
            },
            run_started_at: started,
            run_ended_at: ended,
        },
        raw_status,
    ))
}
pub(crate) fn calculate<'a>(
    previous: &RunState,
    patch: L<'a>,
    now: L<'a>,
    pending: bool,
    raw_previous: Option<L<'a>>,
) -> Result<Transition> {
    let patch = if patch.undefined()? {
        patch.from_value(&V::Object(vec![]))?
    } else {
        patch
    };
    let requested = if patch.get(c"status")?.undefined()? {
        match raw_previous {
            Some(value) => value,
            None => patch.from_value(
                &previous
                    .status
                    .clone()
                    .map(V::String)
                    .unwrap_or(V::Undefined),
            )?,
        }
    } else {
        patch.get(c"status")?
    };
    let status = requested.string()?;
    if !status.as_ref().is_some_and(core::supported) {
        let suffix = requested.coerce_string()?;
        let mut units: Vec<u16> = "[session] unsupported status: ".encode_utf16().collect();
        units.extend(suffix.as_units());
        let message = requested.from_value(&V::String(JsString::from_units(units)))?;
        return Err(requested
            .global()?
            .get(c"TypeError")?
            .construct(&[message])?
            .throw_error());
    }
    let at = now.explicit_number()?;
    core::transition(previous, status.unwrap(), at, pending).map_err(|e| requested.type_error(e))
}
#[cfg_attr(test, allow(dead_code))]
pub(crate) fn result<'a>(anchor: L<'a>, value: &Transition) -> Result<L<'a>> {
    let out = anchor.from_value(&V::Object(vec![]))?;
    out.set(c"state", anchor.from_value(&value.state.value())?.freeze()?)?;
    for (key, flag) in [
        (c"changed", value.changed),
        (c"enteredRunning", value.entered_running),
        (c"leftRunning", value.left_running),
    ] {
        out.set(key, anchor.from_value(&V::Bool(flag))?)?;
    }
    out.freeze()
}
#[napi]
#[cfg_attr(test, allow(dead_code))]
pub fn session_state_catalog(env: Env) -> Result<sys::napi_value> {
    unsafe {
        crate::js_bridge::write_value(
            env.raw(),
            &V::object(vec![
                (
                    "runningStatuses",
                    V::Array(
                        core::RUNNING_STATUSES
                            .iter()
                            .map(|s| V::string(s))
                            .collect(),
                    ),
                ),
                (
                    "sessionStatuses",
                    V::Array(
                        core::SESSION_STATUSES
                            .iter()
                            .map(|s| V::string(s))
                            .collect(),
                    ),
                ),
            ]),
        )
    }
}
#[napi]
#[cfg_attr(test, allow(dead_code))]
pub fn session_state_initial(env: Env, anchor: Unknown<'_>) -> Result<sys::napi_value> {
    Ok(initial(L::new(&env, anchor))?.raw())
}
#[napi]
#[cfg_attr(test, allow(dead_code))]
pub fn session_state_is_running(env: Env, value: Unknown<'_>) -> Result<bool> {
    Ok(L::new(&env, value)
        .string()?
        .is_some_and(|s| core::running(&s)))
}
#[napi]
#[cfg_attr(test, allow(dead_code))]
pub fn session_state_transition(
    env: Env,
    prior: Unknown<'_>,
    patch: Unknown<'_>,
    now: Unknown<'_>,
    pending: Unknown<'_>,
) -> Result<sys::napi_value> {
    let anchor = L::new(&env, prior);
    let (previous, raw_previous) = previous(anchor)?;
    let transition = calculate(
        &previous,
        L::new(&env, patch),
        L::new(&env, now),
        L::new(&env, pending).truthy()?,
        Some(raw_previous),
    )?;
    Ok(result(anchor, &transition)?.raw())
}
