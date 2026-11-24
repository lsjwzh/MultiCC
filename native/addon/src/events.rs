use napi::Result;
use napi_derive::napi;

/// Event catalog, rule-schema and envelope constants as one JSON document.
/// The compatibility event host reads it once and freezes its public tables.
#[napi]
pub fn events_catalog() -> Result<String> {
    multicc_core::events::catalog().map_err(napi::Error::from_reason)
}

/// Event logic calls (op dispatch): pattern matching, rule validation and
/// filtering, redaction/clipping, conclusion paging, injection rendering and
/// task-transition derivation.
#[napi]
pub fn events_request(op: String, input: String) -> Result<String> {
    multicc_core::events::request(&op, &input).map_err(napi::Error::from_reason)
}
