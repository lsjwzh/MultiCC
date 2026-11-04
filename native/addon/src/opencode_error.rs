use napi::Result;
use napi_derive::napi;

// Bounded error metadata only; no filesystem or network work on the host thread.
#[napi]
pub fn classify_provider_error(input: String) -> Result<String> {
    multicc_core::provider_error::classify(&input).map_err(napi::Error::from_reason)
}
