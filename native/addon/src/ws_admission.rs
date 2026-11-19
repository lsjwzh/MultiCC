use napi::Result;
use napi_derive::napi;

/// The ordered admission plan for one WebSocket connection, as JSON steps.
/// The router owns the facts and performs the close; the decision is here.
#[napi]
pub fn ws_admission_plan(facts: String) -> Result<String> {
    multicc_core::ws_admission::plan_json(&facts).map_err(napi::Error::from_reason)
}

/// Whether admission reaches the auth phase, the only consumer of the one-use
/// ticket. The router must ask this before consuming one, so a connection the
/// share branch authorizes does not burn a ticket.
#[napi]
pub fn ws_admission_needs_ticket(facts: String) -> Result<bool> {
    multicc_core::ws_admission::needs_ticket_json(&facts).map_err(napi::Error::from_reason)
}

/// Whether the share branch runs, so the router consults the share table only
/// for a chat socket that presented a `share` parameter.
#[napi]
pub fn ws_admission_needs_share_record(facts: String) -> Result<bool> {
    multicc_core::ws_admission::needs_share_record_json(&facts).map_err(napi::Error::from_reason)
}
