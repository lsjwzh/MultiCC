use multicc_core::turn_request;
use napi::bindgen_prelude::{JsValue as _, Unknown};
use napi::{sys, Env, Result};
use napi_derive::napi;

/// Constant tables (request kind, forbidden fields, task sources...).
#[napi]
pub fn turn_request_catalog() -> Result<String> {
    turn_request::catalog().map_err(napi::Error::from_reason)
}

/// One value-in/value-out entry for normalize/admission/proof/spawn-guard. The
/// payload crosses napi directly, so `undefined`, `NaN`, the infinities and
/// `-0` survive a JSON boundary that would have folded them into null/0.
#[napi]
pub fn turn_request_request_value(
    env: Env,
    op: String,
    input: Unknown<'_>,
) -> Result<sys::napi_value> {
    let raw = env.raw();
    let value = unsafe { crate::js_bridge::read_value(raw, input.raw(), 0, &mut Vec::new()) }?;
    let result = turn_request::request_value(&op, &value).map_err(napi::Error::from_reason)?;
    unsafe { crate::js_bridge::write_value(raw, &result) }
}
