// napi wrapper for the default-model contract. The rule lives in
// `multicc_core::model_default`; this file only marshals a JSON string.

use napi::Result;
use napi_derive::napi;

#[napi]
pub fn session_model_default(request: String) -> Result<String> {
    multicc_core::model_default::resolve(&request).map_err(napi::Error::from_reason)
}
