use napi::Result;
use napi_derive::napi;

#[napi]
pub fn record_secret_audit(file: String, input: String) -> Result<String> {
    multicc_core::secret_audit::record(&file, &input).map_err(napi::Error::from_reason)
}
