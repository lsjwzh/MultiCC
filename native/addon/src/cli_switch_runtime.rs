use napi::Result;
use napi_derive::napi;

#[napi]
pub fn cli_switch_runtime_request(op: String, input: String) -> Result<String> {
    multicc_core::cli_switch_runtime::request(&op, &input).map_err(napi::Error::from_reason)
}
