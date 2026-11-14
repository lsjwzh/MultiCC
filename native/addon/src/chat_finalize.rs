//! napi surface for the native finalization planner.
//!
//! The planner is pure; this module only moves the input across the lossless
//! bridge, invokes it, and preserves two host identities the JavaScript
//! consumers rely on:
//!
//! * the accepted retry schedule for an API-error plan must be the very object
//!   the host API policy produced (`plan.retry === apiErrorDecision`), and
//! * a resolved plan must keep returning `plan.facts` and `plan.append` by
//!   reference.
//!
//! The host clock is a JavaScript callback so it is only sampled when a retry
//! is actually scheduled, matching the former `deps.retry.now()` call site.
use multicc_core::js::JsValue;
use napi::bindgen_prelude::{JsValue as _, Unknown};
use napi::{sys, Env, Result};
use napi_derive::napi;
use std::ffi::CStr;
use std::ptr;

fn status_error(status: sys::napi_status, context: &str) -> napi::Error {
    if status == sys::Status::napi_pending_exception {
        return napi::Error::new(napi::Status::PendingException, "JavaScript exception");
    }
    napi::Error::new(
        napi::Status::GenericFailure,
        format!("{context} failed with napi status {status}"),
    )
}

fn check(status: sys::napi_status, context: &str) -> Result<()> {
    if status == sys::Status::napi_ok {
        Ok(())
    } else {
        Err(status_error(status, context))
    }
}

unsafe fn named(
    env: sys::napi_env,
    object: sys::napi_value,
    name: &CStr,
) -> Result<sys::napi_value> {
    let mut value = ptr::null_mut();
    check(
        unsafe { sys::napi_get_named_property(env, object, name.as_ptr(), &mut value) },
        "napi_get_named_property",
    )?;
    Ok(value)
}

unsafe fn set_named(
    env: sys::napi_env,
    object: sys::napi_value,
    name: &CStr,
    value: sys::napi_value,
) -> Result<()> {
    check(
        unsafe { sys::napi_set_named_property(env, object, name.as_ptr(), value) },
        "napi_set_named_property",
    )
}

/// Sample the host clock exactly when a schedule is produced. The value goes
/// through the same `Number(...)` coercion the host wrapper applied.
unsafe fn call_clock(env: sys::napi_env, clock: sys::napi_value) -> Result<f64> {
    let mut recv = ptr::null_mut();
    check(
        unsafe { sys::napi_get_undefined(env, &mut recv) },
        "napi_get_undefined",
    )?;
    let mut result = ptr::null_mut();
    check(
        unsafe { sys::napi_call_function(env, recv, clock, 0, ptr::null(), &mut result) },
        "napi_call_function",
    )?;
    let value = unsafe { crate::js_bridge::read_value(env, result, 0, &mut Vec::new()) }?;
    Ok(multicc_core::js::js_to_number(&value))
}

fn scheduled_action(value: &JsValue) -> bool {
    matches!(
        value.get("action"),
        Some(JsValue::String(action)) if action.as_str_lossy() == "continue-codex"
            || action.as_str_lossy() == "continue-opencode"
            || action.as_str_lossy() == "retry-fresh"
    )
}

fn action_is(value: &JsValue, expected: &str) -> bool {
    matches!(value.get("action"), Some(JsValue::String(action)) if action.as_str_lossy() == expected)
}

#[napi]
pub fn chat_plan_turn_finalization(
    env: Env,
    input: Unknown<'_>,
    deps: Unknown<'_>,
    clock: Unknown<'_>,
) -> Result<sys::napi_value> {
    let raw = env.raw();
    let input_value =
        unsafe { crate::js_bridge::read_value(raw, input.raw(), 0, &mut Vec::new()) }?;
    let deps_value = unsafe { crate::js_bridge::read_value(raw, deps.raw(), 0, &mut Vec::new()) }?;
    let mut plan =
        multicc_core::chat_finalize::plan_turn_finalization(&input_value, &deps_value, 0.0);
    if scheduled_action(&plan) {
        let now = unsafe { call_clock(raw, clock.raw()) }?;
        plan = multicc_core::chat_finalize::plan_turn_finalization(&input_value, &deps_value, now);
    }
    let written = unsafe { crate::js_bridge::write_value(raw, &plan) }?;
    if action_is(&plan, "retry-api") {
        unsafe {
            let decision = named(raw, input.raw(), c"apiErrorDecision")?;
            set_named(raw, written, c"retry", decision)?;
            let facts = named(raw, written, c"facts")?;
            set_named(raw, facts, c"apiErrorDecision", decision)?;
        }
    }
    Ok(written)
}

#[napi]
pub fn chat_plan_retry_blocked_finalization(
    env: Env,
    source_plan: Unknown<'_>,
    overrides: Unknown<'_>,
) -> Result<sys::napi_value> {
    let raw = env.raw();
    let source =
        unsafe { crate::js_bridge::read_value(raw, source_plan.raw(), 0, &mut Vec::new()) }?;
    let overrides =
        unsafe { crate::js_bridge::read_value(raw, overrides.raw(), 0, &mut Vec::new()) }?;
    let plan = multicc_core::chat_finalize::plan_retry_blocked_finalization(&source, &overrides);
    unsafe { crate::js_bridge::write_value(raw, &plan) }
}

#[napi]
pub fn chat_resolve_turn_finalization(
    env: Env,
    plan: Unknown<'_>,
    outcome: Unknown<'_>,
) -> Result<sys::napi_value> {
    let raw = env.raw();
    let plan_value = unsafe { crate::js_bridge::read_value(raw, plan.raw(), 0, &mut Vec::new()) }?;
    let outcome_value =
        unsafe { crate::js_bridge::read_value(raw, outcome.raw(), 0, &mut Vec::new()) }?;
    let resolved =
        multicc_core::chat_finalize::resolve_turn_finalization(&plan_value, &outcome_value);
    let written = unsafe { crate::js_bridge::write_value(raw, &resolved) }?;
    unsafe {
        if plan_value.get("facts").is_some() {
            let facts = named(raw, plan.raw(), c"facts")?;
            set_named(raw, written, c"facts", facts)?;
        }
        if action_is(&plan_value, "finalize") && plan_value.get("append").is_some() {
            let append = named(raw, plan.raw(), c"append")?;
            set_named(raw, written, c"append", append)?;
        }
    }
    Ok(written)
}

#[napi]
pub fn chat_classify_process_exit(env: Env, input: Unknown<'_>) -> Result<String> {
    let raw = env.raw();
    let value = unsafe { crate::js_bridge::read_value(raw, input.raw(), 0, &mut Vec::new()) }?;
    Ok(multicc_core::chat_finalize::classify_process_exit(&value).to_string())
}

#[napi]
pub fn chat_normalize_handoff(env: Env, input: Unknown<'_>) -> Result<sys::napi_value> {
    let raw = env.raw();
    let value = unsafe { crate::js_bridge::read_value(raw, input.raw(), 0, &mut Vec::new()) }?;
    let handoff = multicc_core::chat_finalize::normalize_handoff(&value);
    unsafe { crate::js_bridge::write_value(raw, &handoff) }
}

#[napi]
pub fn chat_is_guarded_handoff_failure(
    env: Env,
    facts: Unknown<'_>,
    handoff: Unknown<'_>,
) -> Result<bool> {
    let raw = env.raw();
    let facts = unsafe { crate::js_bridge::read_value(raw, facts.raw(), 0, &mut Vec::new()) }?;
    let handoff = unsafe { crate::js_bridge::read_value(raw, handoff.raw(), 0, &mut Vec::new()) }?;
    Ok(multicc_core::chat_finalize::is_guarded_handoff_failure(
        &facts, &handoff,
    ))
}
