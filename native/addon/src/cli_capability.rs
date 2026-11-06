use napi_derive::napi;

/// The CLI catalogue and every view derived from it, as one JSON document.
/// `src/cli/cli-capability.js` reads it once at load and freezes it.
#[napi]
pub fn cli_catalog() -> napi::Result<String> {
    multicc_core::cli_capability::catalog().map_err(napi::Error::from_reason)
}
