use multicc_core::cli_switch;
use napi::Result;
use napi_derive::napi;

/// Supported chat CLI list (the JS module freezes it at load).
#[napi]
pub fn cli_switch_catalog() -> Result<String> {
    cli_switch::catalog().map_err(napi::Error::from_reason)
}

/// One JSON-in/JSON-out entry for active state, activation, summary, clear
/// planning, message text, checkpoint building and prompt rendering.
/// `cli_switch::request` parses the boundary payload with
/// `multicc_core::json_lenient::from_str`.
#[napi]
pub fn cli_switch_request(op: String, input: String) -> Result<String> {
    cli_switch::request(&op, &input).map_err(napi::Error::from_reason)
}
