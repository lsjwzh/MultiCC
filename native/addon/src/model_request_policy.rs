use crate::js_live::LiveValue as L;
use multicc_core::js::JsValue;
use napi::bindgen_prelude::{JsValue as _, Unknown};
use napi::{sys, Env, Result};
use napi_derive::napi;

#[napi]
pub fn model_request_policy_value(env: Env, input: Unknown<'_>) -> Result<sys::napi_value> {
    resolve_value(env.raw(), input.raw())
}

fn resolve_value(raw: sys::napi_env, input: sys::napi_value) -> Result<sys::napi_value> {
    let input = unsafe { crate::js_bridge::read_value(raw, input, 0, &mut Vec::new()) }?;
    let result = multicc_core::model_request_policy::resolve(&input);
    unsafe { crate::js_bridge::write_value(raw, &result) }
}

fn bridge_value(value: L<'_>) -> Result<L<'_>> {
    if value.kind()? == sys::ValueType::napi_bigint {
        value.get(c"toString")?.call(value, &[])
    } else {
        Ok(value)
    }
}

/// Read the host's live budget inputs in the original order. Only top-level
/// BigInts are converted before entering the existing value bridge.
#[napi]
pub fn resolve_model_request_policy(
    env: Env,
    session: Unknown<'_>,
    environment: Unknown<'_>,
) -> Result<sys::napi_value> {
    let session = L::new(&env, session);
    let environment = L::new(&env, environment);
    let effort = session.get(c"effort")?;
    let mode = session.get(c"providerSelection")?.optional(c"mode")?;
    let legacy = if mode.is_string("auto")? {
        environment.get(c"MULTICC_AUTO_STALL_TIMEOUT_MS")?
    } else {
        session.from_value(&JsValue::Undefined)?
    };
    let object = session.global()?.get(c"Object")?;
    let freeze = object.get(c"freeze")?;
    let input = session.from_value(&JsValue::Object(vec![]))?;
    input.set(c"effort", bridge_value(effort)?)?;
    input.set(c"mode", bridge_value(mode)?)?;
    input.set(c"legacy", bridge_value(legacy)?)?;
    for (key, name) in [
        (c"idle", c"MULTICC_MODEL_IDLE_TIMEOUT_MS"),
        (c"request", c"MULTICC_MODEL_REQUEST_TIMEOUT_MS"),
        (c"connect", c"MULTICC_MODEL_CONNECT_TIMEOUT_MS"),
    ] {
        input.set(key, bridge_value(environment.get(name)?)?)?;
    }
    let result = L::from_raw(env.raw(), resolve_value(env.raw(), input.raw())?);
    Ok(freeze.call(object, &[result])?.raw())
}
