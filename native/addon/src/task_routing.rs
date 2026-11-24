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

// Each host owns an independent live setting. File persistence and its
// compensating write stay with the settings route.
#[napi]
pub struct HostAttributionSettings {
    mode: std::cell::Cell<&'static str>,
}

#[napi]
impl HostAttributionSettings {
    #[napi(constructor)]
    pub fn new(env: Env, initial: Unknown<'_>) -> Result<Self> {
        let initial = policy_text(LiveValue::new(&env, initial))?;
        let mode =
            task_routing::normalize_mode(initial.as_deref()).unwrap_or(task_routing::DEFAULT_MODE);
        Ok(Self {
            mode: std::cell::Cell::new(mode),
        })
    }

    #[napi]
    pub fn get_mode(&self) -> String {
        self.mode.get().to_owned()
    }

    #[napi]
    pub fn set_mode(&self, env: Env, value: Unknown<'_>) -> Result<sys::napi_value> {
        let value = LiveValue::new(&env, value);
        let text = policy_text(value)?;
        let Some(requested) = task_routing::normalize_mode(text.as_deref()) else {
            let message = format!("mode must be one of {}", task_routing::MODES.join(", "));
            let error = value
                .global()?
                .get(c"Error")?
                .construct(&[value.from_value(&JsValue::string(&message))?])?;
            error.set(c"code", value.from_value(&JsValue::string("invalid_mode"))?)?;
            error.set(c"status", value.from_value(&JsValue::Number(400.0))?)?;
            return Err(error.throw_error());
        };
        let previous = self.mode.replace(requested);
        let changed = previous != requested;
        let mut fields = vec![
            ("mode", JsValue::string(requested)),
            ("changed", JsValue::Bool(changed)),
        ];
        if changed {
            fields.push(("previous", JsValue::string(previous)));
        }
        Ok(value.from_value(&JsValue::object(fields))?.raw())
    }
}
