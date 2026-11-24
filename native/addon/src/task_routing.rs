use crate::js_live::LiveValue;
use multicc_core::{
    js::{serde::from_serde, JsValue},
    task_routing,
};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;

/// Task-routing constant tables (attribution modes) as one JSON document.
#[napi]
pub fn task_routing_catalog() -> Result<String> {
    multicc_core::task_routing::catalog().map_err(napi::Error::from_reason)
}

/// Task-routing policy calls (op dispatch): normalizeAttributionMode,
/// planAttributionAction, evaluateAttribution.
#[napi]
pub fn task_routing_request(op: String, input: String) -> Result<String> {
    multicc_core::task_routing::request(&op, &input).map_err(napi::Error::from_reason)
}

// The previous JSON request replaced unpaired UTF-16 surrogates with U+FFFD.
// Non-strings have no policy meaning, even when they expose coercion hooks.
fn policy_text(value: LiveValue<'_>) -> Result<Option<String>> {
    Ok(value.string()?.map(|s| s.to_string_lossy()))
}

#[napi]
pub fn normalize_host_attribution_mode(
    env: Env,
    mode: Unknown<'_>,
    fallback: Unknown<'_>,
) -> Result<sys::napi_value> {
    let mode = LiveValue::new(&env, mode);
    let fallback = LiveValue::new(&env, fallback);
    Ok(
        match task_routing::normalize_mode(policy_text(mode)?.as_deref()) {
            Some(value) => mode.from_value(&JsValue::string(value))?,
            None => fallback,
        }
        .raw(),
    )
}

#[napi]
pub fn plan_host_attribution_action(
    env: Env,
    mode: Unknown<'_>,
    relation: Unknown<'_>,
    target: Unknown<'_>,
    current: Unknown<'_>,
) -> Result<sys::napi_value> {
    let mode = LiveValue::new(&env, mode);
    let input = serde_json::json!({
        "mode": policy_text(mode)?,
        "relation": policy_text(LiveValue::new(&env, relation))?,
        "targetTaskId": policy_text(LiveValue::new(&env, target))?,
        "currentTaskId": policy_text(LiveValue::new(&env, current))?,
    });
    Ok(mode
        .from_value(&from_serde(&task_routing::plan_attribution_action(&input)))?
        .raw())
}
