use napi::Result;
use napi_derive::napi;

/// The one marker every supervisor-inserted message carries. Single source:
/// `native/core/src/unattended.rs`; JS and both UIs read/reuse this literal.
#[napi]
pub fn unattended_tag() -> String {
    multicc_core::unattended::UNATTENDED_TAG.to_string()
}

/// Clamp `{goal, criteria, maxDurationMinutes}` → `{ok, config}` / `{ok:false, error}`.
#[napi]
pub fn unattended_normalize_config(input: String) -> Result<String> {
    multicc_core::unattended::normalize_config(&input).map_err(napi::Error::from_reason)
}

/// Clamp `{maxDurationMinutes}` → `{maxDurationMinutes}` (default 120, 5..1440).
#[napi]
pub fn unattended_clamp_duration(input: String) -> Result<String> {
    multicc_core::unattended::clamp_duration(&input).map_err(napi::Error::from_reason)
}

/// Arm a supervision deadline:
/// `{startedAt?, maxDurationMinutes?, now}` → `{startedAt, deadlineAt, maxDurationMinutes, clamped}`.
#[napi]
pub fn unattended_arm_deadline(input: String) -> Result<String> {
    multicc_core::unattended::arm_deadline(&input).map_err(napi::Error::from_reason)
}

/// `{deadlineAt?, now}` → `{expired}`.
#[napi]
pub fn unattended_deadline_expired(input: String) -> Result<String> {
    multicc_core::unattended::deadline_expired(&input).map_err(napi::Error::from_reason)
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

/// Apply stall/failure policy → `{nextState, action, message}`.
#[napi]
pub fn unattended_decide(input: String) -> Result<String> {
    multicc_core::unattended::decide(&input).map_err(napi::Error::from_reason)
}

/// Immediate fault-E continuation → `{nextState, action, message, faults}`.
#[napi]
pub fn unattended_decide_fault(input: String) -> Result<String> {
    multicc_core::unattended::decide_fault(&input).map_err(napi::Error::from_reason)
}
