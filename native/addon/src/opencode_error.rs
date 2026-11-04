use napi::Result;
use napi_derive::napi;

// Bounded error metadata only; no filesystem or network work on the host thread.
#[napi]
pub fn describe_opencode_context_error(input: String) -> Result<String> {
    multicc_core::opencode_error::describe(&input).map_err(napi::Error::from_reason)
}
