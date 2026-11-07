use multicc_core::task_run_context;
use napi::bindgen_prelude::{JsValue as _, Unknown};
use napi::{sys, Env, Result};
use napi_derive::napi;

// Pure transform: board record + turn refs in, context wall out. The value is
// read without JSON, so lone surrogates, undefined, NaN and Buffers survive.
#[napi]
pub fn build_task_run_context(env: Env, input: Unknown<'_>) -> Result<sys::napi_value> {
    let raw = env.raw();
    let value = unsafe { crate::js_bridge::read_value(raw, input.raw(), 0, &mut Vec::new()) }?;
    let result = task_run_context::build_value(&value).map_err(napi::Error::from_reason)?;
    unsafe { crate::js_bridge::write_value(raw, &result) }
}
