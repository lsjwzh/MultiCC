//! Lossless value boundary; no JSON encoding or cache ownership in Node.
use napi::bindgen_prelude::{JsValue as _, Unknown};
use napi::{sys, Env, Result};
use napi_derive::napi;

#[napi]
pub fn limit_cache_recorder_request_value(
    env: Env,
    op: String,
    input: Unknown<'_>,
) -> Result<sys::napi_value> {
    let raw = env.raw();
    let input = unsafe { crate::js_bridge::read_value(raw, input.raw(), 0, &mut Vec::new()) }?;
    let result = multicc_core::limit_cache_recorder::request(&op, &input);
    unsafe { crate::js_bridge::write_value(raw, &result) }
}
