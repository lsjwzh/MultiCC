use multicc_core::chat_context_rotation;
use napi::Result;
use napi_derive::napi;

/// JSON-in/JSON-out entry for native-context rotation planning.
/// `chat_context_rotation::request` parses the boundary payload with
/// `multicc_core::js::json_parse` and returns the planned effect list.
#[napi]
pub fn chat_context_rotation_request(op: String, input: String) -> Result<String> {
    chat_context_rotation::request(&op, &input).map_err(napi::Error::from_reason)
}
