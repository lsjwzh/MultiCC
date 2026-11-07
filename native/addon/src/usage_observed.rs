use napi::bindgen_prelude::{JsValue as _, Unknown};
use napi::{sys, Env, Result};
use napi_derive::napi;

/// `USAGE_OBSERVED_VERSION` (and future constants) as one JSON document.
#[napi]
pub fn usage_observed_catalog() -> Result<String> {
    Ok(multicc_core::usage_observed::catalog())
}

/// op dispatch: `create` (normalize/validate an observation) and
/// `stableEventId`. Errors travel inside the envelope so the bridge can
/// rethrow `UsageObservedError` with the original code. The payload crosses
/// napi directly, keeping nested `NaN`/`Infinity`, explicit `undefined`
/// properties and `-0` that a JSON boundary would rewrite.
#[napi]
pub fn usage_observed_request_value(
    env: Env,
    op: String,
    input: Unknown<'_>,
) -> Result<sys::napi_value> {
    let raw = env.raw();
    let value = unsafe { crate::js_bridge::read_value(raw, input.raw(), 0, &mut Vec::new()) }?;
    let result = multicc_core::usage_observed::request_value(&op, &value)
        .map_err(napi::Error::from_reason)?;
    unsafe { crate::js_bridge::write_value(raw, &result) }
}
