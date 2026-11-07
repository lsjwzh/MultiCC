use napi::Result;
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
