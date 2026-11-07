use napi::Result;
use napi_derive::napi;

/// Turn-state constant tables as one JSON document.
/// `src/classify/turn-state.js` reads it once at load and freezes it.
#[napi]
pub fn turn_state_catalog() -> Result<String> {
    multicc_core::turn_state::catalog().map_err(napi::Error::from_reason)
}

/// Project structured runtime facts onto one P/D/W/B/E verdict.
#[napi]
pub fn resolve_turn_state(input: String) -> Result<String> {
    multicc_core::turn_state::resolve_json(&input).map_err(napi::Error::from_reason)
}
