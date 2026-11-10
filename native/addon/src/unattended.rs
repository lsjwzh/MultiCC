use napi::Result;
use napi_derive::napi;

/// The one marker every supervisor-inserted message carries. Single source:
/// `native/core/src/unattended.rs`; JS and both UIs read/reuse this literal.
#[napi]
pub fn unattended_tag() -> String {
    multicc_core::unattended::UNATTENDED_TAG.to_string()
}

/// Clamp `{goal, criteria, maxRounds}` → `{ok, config}` / `{ok:false, error}`.
#[napi]
pub fn unattended_normalize_config(input: String) -> Result<String> {
    multicc_core::unattended::normalize_config(&input).map_err(napi::Error::from_reason)
}

/// Build the aux verdict prompt → `{prompt}`.
#[napi]
pub fn unattended_verdict_prompt(input: String) -> Result<String> {
    multicc_core::unattended::build_verdict_prompt(&input).map_err(napi::Error::from_reason)
}

/// Parse the aux reply → `{ok:true, verdict}` / `{ok:false, error}`. Never throws
/// for unusable model text; only invalid UTF-16-ish input can.
#[napi]
pub fn unattended_parse_verdict(text: String) -> Result<String> {
    multicc_core::unattended::parse_verdict(&text).map_err(napi::Error::from_reason)
}

/// Apply budget/stall/failure policy → `{nextState, action, message}`.
#[napi]
pub fn unattended_decide(input: String) -> Result<String> {
    multicc_core::unattended::decide(&input).map_err(napi::Error::from_reason)
}

/// Immediate fault-E continuation → `{nextState, action, message, faults}`.
#[napi]
pub fn unattended_decide_fault(input: String) -> Result<String> {
    multicc_core::unattended::decide_fault(&input).map_err(napi::Error::from_reason)
}
