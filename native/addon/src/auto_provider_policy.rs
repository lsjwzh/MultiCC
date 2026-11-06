use multicc_core::auto_provider_policy as policy;
use napi_derive::napi;

/// How one provider-limit cache entry reads now: `{ state, reason, usedPercent }`.
#[napi]
pub fn auto_provider_limit_state(input: String) -> napi::Result<String> {
    policy::limit_state(&input).map_err(napi::Error::from_reason)
}

/// Which line of an Auto pool to try next: `{ candidate, skipped }`.
#[napi]
pub fn auto_provider_choose_candidate(input: String) -> napi::Result<String> {
    policy::choose_candidate(&input).map_err(napi::Error::from_reason)
}

/// Whether a failed attempt may move to another line: `{ ok, reason }`.
#[napi]
pub fn auto_provider_failover_safety(input: String) -> napi::Result<String> {
    policy::failover_safety(&input).map_err(napi::Error::from_reason)
}

/// The policy's exported constants.
#[napi]
pub fn auto_provider_policy_facts() -> String {
    policy::facts()
}
