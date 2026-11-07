use napi::Result;
use napi_derive::napi;

/// `USAGE_OBSERVED_VERSION` (and future constants) as one JSON document.
#[napi]
pub fn usage_observed_catalog() -> Result<String> {
    Ok(multicc_core::usage_observed::catalog())
}

/// op dispatch: `create` (normalize/validate an observation) and
/// `stableEventId`. Errors travel inside the envelope so the bridge can
/// rethrow `UsageObservedError` with the original code.
#[napi]
pub fn usage_observed_request(op: String, input: String) -> Result<String> {
    multicc_core::usage_observed::request(&op, &input).map_err(napi::Error::from_reason)
}
