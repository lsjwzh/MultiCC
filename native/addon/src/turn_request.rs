use multicc_core::turn_request;
use napi::Result;
use napi_derive::napi;

/// Constant tables (request kind, forbidden fields, task sources...).
#[napi]
pub fn turn_request_catalog() -> Result<String> {
    turn_request::catalog().map_err(napi::Error::from_reason)
}

/// One JSON-in/JSON-out entry for normalize/admission/proof/spawn-guard.
/// `turn_request::request` parses the boundary payload with
/// `multicc_core::json_lenient::from_str`, so lone surrogate escapes survive.
#[napi]
pub fn turn_request_request(op: String, input: String) -> Result<String> {
    turn_request::request(&op, &input).map_err(napi::Error::from_reason)
}
