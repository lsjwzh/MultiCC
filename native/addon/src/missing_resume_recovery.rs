use multicc_core::missing_resume_recovery;
use napi::bindgen_prelude::{JsValue as _, Unknown};
use napi::{sys, Env, Result};
use napi_derive::napi;

/// Constant tables (ops, actions, evidence values, reasons).
#[napi]
pub fn missing_resume_recovery_catalog() -> Result<String> {
    missing_resume_recovery::catalog().map_err(napi::Error::from_reason)
}

/// One value-in/value-out entry for classify/decide/probe/resume-plan. The
/// payload crosses napi directly, so `undefined` and the non-finite numbers
/// survive a JSON boundary that would have folded them into null/0.
#[napi]
pub fn missing_resume_recovery_request_value(
    env: Env,
    op: String,
    input: Unknown<'_>,
) -> Result<sys::napi_value> {
    let raw = env.raw();
    let value = unsafe { crate::js_bridge::read_value(raw, input.raw(), 0, &mut Vec::new()) }?;
    let result =
        missing_resume_recovery::request_value(&op, &value).map_err(napi::Error::from_reason)?;
    unsafe { crate::js_bridge::write_value(raw, &result) }
}
