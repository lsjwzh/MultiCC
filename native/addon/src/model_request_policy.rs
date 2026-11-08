use napi::bindgen_prelude::{JsValue as _, Unknown};
use napi::{sys, Env, Result};
use napi_derive::napi;

#[napi]
pub fn model_request_policy_value(env: Env, input: Unknown<'_>) -> Result<sys::napi_value> {
    let raw = env.raw();
    let input = unsafe { crate::js_bridge::read_value(raw, input.raw(), 0, &mut Vec::new()) }?;
    let result = multicc_core::model_request_policy::resolve(&input);
    unsafe { crate::js_bridge::write_value(raw, &result) }
}
