//! Admission for every WebSocket connection the router accepts: the ordered
//! sequence of refusals, metrics, log lines and socket annotations that used
//! to be an inline block in `src/ws/connection-router.js`.
//!
//! Node still supplies the facts -- it owns the request, the cookie jar, the
//! share records, the one-use ticket table, the machine grants and the session
//! records -- and still performs the close. What moved here is the decision:
//! which gate fires, in what order, and what the socket carries afterwards.
//!
//! Two properties of the retired block are load bearing and easy to lose:
//!
//! - A refusal can be preceded by annotations. The router's close listener
//!   logs `ws._correlationId`, so a ticket that is then refused for fleet
//!   scope still names itself in the close log.
//! - The one-use ticket is consumed only when the share branch did not
//!   authorize the connection. `needs_ticket` answers that from the same
//!   share rule `plan` uses, so a caller cannot burn a ticket the retired
//!   path would have left alone.
//!
//! The frozen Node transcription is `tests/helpers/legacy-ws-admission.js` and
//! the corpus generated from it is compared case by case in the tests below.

pub const PEER_REJECTED: &str = "multicc_ws_public_peer_rejected_total";
pub const FLEET_DENIED: &str = "multicc_ws_fleet_scope_denied_total";
pub const LEGACY_AUTH: &str = "multicc_ws_legacy_auth_total";
pub const AUTH_DENIED: &str = "multicc_ws_auth_denied_total";

/// A share record as `share.access` returns it. `session_id` is compared with
/// strict equality against the request's `session` parameter, so a record
/// without a session matches a request without one.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ShareAccess {
    pub session_id: Option<String>,
    pub access: String,
}

/// A consumed one-use ticket. Every field is read for truthiness, so an empty
/// string means the same as an absent one.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Ticket {
    pub machine_grant_id: String,
    pub correlation_id: String,
    pub request_id: String,
    pub fleet_session_id: String,
    pub fleet_directory_id: String,
}

#[derive(Debug, Clone, Default)]
pub struct Facts {
    pub shutting_down: bool,
    pub peer_allowed: bool,
    pub path: String,
    /// The `share` query parameter; empty when absent.
    pub share_param: String,
    /// The `session` query parameter; `None` when absent.
    pub session_param: Option<String>,
    /// `session` on the chat path, `id` on the session paths, `None` on the
    /// sessionless ones. Resolved before admission, so it is a fact here.
    pub addressed_session_id: Option<String>,
    pub addressed_directory_id: Option<String>,
    pub share_access: Option<ShareAccess>,
    pub local: bool,
    /// Whether an `ACCESS_TOKEN` is configured at all.
    pub access_token: bool,
    /// Whether the request carried a `ticket` parameter at all. The retired
    /// expression was `has('ticket') && consumeWsTicket(...)`, so the kernel
    /// owns the conjunction: without the parameter there is no ticket, no
    /// matter what the consume port returned.
    pub has_ticket_param: bool,
    /// What the consume port returned, `None` for a refused consume.
    pub consumed_ticket: Option<Ticket>,
    pub allow_legacy_cookie: bool,
    pub allow_legacy_token: bool,
    /// Whether the request carried a `multicc_auth` cookie at all.
    pub auth_cookie: bool,
    pub cookie_valid: bool,
    pub token_valid: bool,
    /// Whether a machines port is installed. A missing port must refuse a
    /// machine-granted ticket exactly like an inactive grant, because the
    /// retired check was `!machines?.active(id)`.
    pub machines_present: bool,
    pub machine_active: bool,
    pub ip: Option<String>,
    pub session_internal_slot: bool,
    /// Whether the native workspace owner already owns this socket's send
    /// queue. The two workspace hosts bring their own, so a second one must
    /// not be installed over it.
    pub native_socket: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    Metric(&'static str),
    /// `installNativeQueue(...)`. Its position is part of the contract: the
    /// queue goes on after the two early refusals, which never install one,
    /// and before any credential work.
    InstallSendQueue,
    /// `ws._machineGrantId`
    MachineGrant(String),
    /// `ws._correlationId`, the ticket's correlation id or its request id.
    CorrelationId(Option<String>),
    /// `logger.warn('legacy_ws_auth', ...)`
    LegacyWarning {
        path: String,
        mode: &'static str,
        ip: Option<String>,
    },
    /// `ws._sharePerm`, assigned for every admitted chat client, `None`
    /// included.
    SharePermission(Option<String>),
    /// The `Session does not exist.` frame that precedes the close.
    SessionMissing,
    /// `None` code and reason mean `ws.close()` with no arguments: an empty
    /// close frame rather than 1000 with a reason.
    Close {
        code: Option<u16>,
        reason: Option<&'static str>,
    },
    Accept,
}

impl Facts {
    /// `has('ticket') && consumeWsTicket(get('ticket'), path)`: `false` from a
    /// missing parameter and `null` from a refused consume are the same falsy
    /// value downstream, so both collapse to `None` here.
    fn ticket(&self) -> Option<&Ticket> {
        if !self.has_ticket_param {
            return None;
        }
        self.consumed_ticket.as_ref()
    }
}

fn truthy(value: &Option<String>) -> bool {
    value.as_deref().is_some_and(|text| !text.is_empty())
}

fn close(code: u16, reason: &'static str) -> Step {
    Step::Close {
        code: Some(code),
        reason: Some(reason),
    }
}

/// The share branch, which runs before the one-use ticket and decides whether
/// the ticket is consumed at all.
enum Share {
    /// The branch did not run: not the chat path, or no `share` parameter.
    Absent,
    /// The branch ran and refused.
    Refused,
    Granted(String),
}

/// Whether the share branch runs at all. The router must ask this before it
/// looks a record up: the retired path consulted the share table only for a
/// chat socket that presented a `share` parameter, and nothing else.
pub fn needs_share_record(facts: &Facts) -> bool {
    facts.path == PATH_CHAT && !facts.share_param.is_empty()
}

fn share(facts: &Facts) -> Share {
    if !needs_share_record(facts) {
        return Share::Absent;
    }
    let permission = facts
        .share_access
        .as_ref()
        .filter(|access| access.session_id == facts.session_param)
        .map(|access| access.access.clone())
        .filter(|access| !access.is_empty());
    match permission {
        Some(permission) => Share::Granted(permission),
        None => Share::Refused,
    }
}

pub const PATH_CHAT: &str = "/ws/chat";

/// Whether admission reaches the auth phase, the only consumer of the one-use
/// ticket. Callers must ask this before consuming one: a connection the share
/// branch authorizes, or either early gate refuses, never touched the ticket
/// table.
pub fn needs_ticket(facts: &Facts) -> bool {
    if facts.shutting_down || !facts.peer_allowed {
        return false;
    }
    matches!(share(facts), Share::Absent)
}

pub fn plan(facts: &Facts) -> Vec<Step> {
    let mut steps = Vec::new();
    if facts.shutting_down {
        steps.push(close(1012, "server shutting down"));
        return steps;
    }
    if !facts.peer_allowed {
        steps.push(Step::Metric(PEER_REJECTED));
        steps.push(close(4003, "Direct public access disabled"));
        return steps;
    }
    if !facts.native_socket {
        steps.push(Step::InstallSendQueue);
    }
    let share_permission = match share(facts) {
        Share::Refused => {
            steps.push(close(4003, "Forbidden"));
            return steps;
        }
        Share::Granted(permission) => Some(permission),
        Share::Absent => None,
    };
    if share_permission.is_none() {
        let legacy_cookie = facts.access_token
            && facts.allow_legacy_cookie
            && facts.auth_cookie
            && facts.cookie_valid;
        let legacy_token = facts.access_token && facts.allow_legacy_token && facts.token_valid;
        if let Some(ticket) = facts.ticket() {
            if !ticket.machine_grant_id.is_empty() {
                if !(facts.machines_present && facts.machine_active) {
                    steps.push(close(4003, "电脑授权已撤销"));
                    return steps;
                }
                steps.push(Step::MachineGrant(ticket.machine_grant_id.clone()));
            }
            let identity = [&ticket.correlation_id, &ticket.request_id]
                .into_iter()
                .find(|value| !value.is_empty())
                .cloned();
            steps.push(Step::CorrelationId(identity));
            let session_mismatch = !ticket.fleet_session_id.is_empty()
                && Some(ticket.fleet_session_id.as_str()) != facts.addressed_session_id.as_deref();
            let directory_mismatch = !ticket.fleet_directory_id.is_empty()
                && Some(ticket.fleet_directory_id.as_str())
                    != facts.addressed_directory_id.as_deref();
            if session_mismatch || directory_mismatch {
                steps.push(Step::Metric(FLEET_DENIED));
                steps.push(close(4003, "Forbidden"));
                return steps;
            }
        }
        if legacy_cookie || legacy_token {
            steps.push(Step::Metric(LEGACY_AUTH));
            steps.push(Step::LegacyWarning {
                path: facts.path.clone(),
                mode: if legacy_token { "query" } else { "cookie" },
                ip: facts.ip.clone(),
            });
        }
        let no_credential = facts.ticket().is_none() && !legacy_cookie && !legacy_token;
        if !facts.local && (!facts.access_token || no_credential) {
            steps.push(Step::Metric(AUTH_DENIED));
            steps.push(close(4003, "Forbidden"));
            return steps;
        }
    }
    if truthy(&facts.addressed_session_id) && facts.session_internal_slot {
        steps.push(Step::SessionMissing);
        steps.push(Step::Close {
            code: None,
            reason: None,
        });
        return steps;
    }
    if facts.path == PATH_CHAT {
        steps.push(Step::SharePermission(share_permission));
    }
    steps.push(Step::Accept);
    steps
}

// ── JSON bridge ────────────────────────────────────────────────────────────

use serde_json::{json, Value};

fn text(value: &Value) -> Option<String> {
    value.as_str().map(str::to_string)
}

/// JS truthiness, because the router serializes what it holds: `accessToken`
/// is the configured secret or null, `authCookie` is the cookie value or null,
/// and the gates read all of them as conditions rather than as booleans.
fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Bool(flag) => *flag,
        Value::String(text) => !text.is_empty(),
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::Null => false,
        // An object or an array is always truthy in JS.
        _ => true,
    }
}

fn required_text(value: &Value) -> String {
    value.as_str().unwrap_or_default().to_string()
}

pub fn ticket_from(value: &Value) -> Option<Ticket> {
    if !value.is_object() {
        return None;
    }
    Some(Ticket {
        machine_grant_id: required_text(&value["machineGrantId"]),
        correlation_id: required_text(&value["correlationId"]),
        request_id: required_text(&value["requestId"]),
        fleet_session_id: required_text(&value["fleetSessionId"]),
        fleet_directory_id: required_text(&value["fleetDirectoryId"]),
    })
}

/// The facts as the router serializes them. `ticket` is the already consumed
/// record, so `needs_ticket` must have answered true before it is non-null.
pub fn facts_from(value: &Value) -> Facts {
    Facts {
        shutting_down: js_truthy(&value["shuttingDown"]),
        peer_allowed: js_truthy(&value["peerAllowed"]),
        path: required_text(&value["path"]),
        share_param: required_text(&value["shareParam"]),
        session_param: text(&value["sessionParam"]),
        addressed_session_id: text(&value["addressedSessionId"]),
        addressed_directory_id: text(&value["addressedDirectoryId"]),
        share_access: value["shareAccess"].as_object().map(|access| ShareAccess {
            session_id: access.get("sessionId").and_then(text),
            access: access.get("access").map(required_text).unwrap_or_default(),
        }),
        local: js_truthy(&value["local"]),
        access_token: js_truthy(&value["accessToken"]),
        has_ticket_param: js_truthy(&value["hasTicketParam"]),
        consumed_ticket: ticket_from(&value["ticket"]),
        allow_legacy_cookie: js_truthy(&value["allowLegacyWsCookie"]),
        allow_legacy_token: js_truthy(&value["allowLegacyWsToken"]),
        auth_cookie: js_truthy(&value["authCookie"]),
        cookie_valid: js_truthy(&value["cookieValid"]),
        token_valid: js_truthy(&value["tokenValid"]),
        machines_present: js_truthy(&value["machinesPresent"]),
        machine_active: js_truthy(&value["machineActive"]),
        ip: text(&value["ip"]),
        session_internal_slot: js_truthy(&value["sessionInternalSlot"]),
        native_socket: js_truthy(&value["nativeSocket"]),
    }
}

pub fn step_json(step: &Step) -> Value {
    match step {
        Step::Metric(name) => json!({ "op": "metric", "name": name }),
        Step::InstallSendQueue => json!({ "op": "installSendQueue" }),
        Step::MachineGrant(value) => json!({ "op": "machineGrant", "value": value }),
        Step::CorrelationId(value) => json!({ "op": "correlationId", "value": value }),
        Step::LegacyWarning { path, mode, ip } => {
            json!({ "op": "legacyWarning", "path": path, "mode": mode, "ip": ip })
        }
        Step::SharePermission(value) => json!({ "op": "sharePermission", "value": value }),
        Step::SessionMissing => json!({ "op": "sessionMissing" }),
        Step::Close { code, reason } => json!({ "op": "close", "code": code, "reason": reason }),
        Step::Accept => json!({ "op": "accept" }),
    }
}

pub fn plan_json(input: &str) -> Result<String, String> {
    let value: Value = crate::json_lenient::from_str(input)
        .map_err(|e| format!("ws_admission_invalid_input: {e}"))?;
    let steps: Vec<Value> = plan(&facts_from(&value)).iter().map(step_json).collect();
    Ok(Value::Array(steps).to_string())
}

pub fn needs_share_record_json(input: &str) -> Result<bool, String> {
    let value: Value = crate::json_lenient::from_str(input)
        .map_err(|e| format!("ws_admission_invalid_input: {e}"))?;
    Ok(needs_share_record(&facts_from(&value)))
}

pub fn needs_ticket_json(input: &str) -> Result<bool, String> {
    let value: Value = crate::json_lenient::from_str(input)
        .map_err(|e| format!("ws_admission_invalid_input: {e}"))?;
    Ok(needs_ticket(&facts_from(&value)))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Overridden by the mutation runner so a mutated copy still reads the
    /// frozen corpus.
    const CORPUS: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../docs/rust-migration/differential/ws-admission-corpus.json"
    );

    fn corpus() -> Value {
        let text = std::fs::read_to_string(CORPUS).expect("ws admission corpus");
        serde_json::from_str(&text).expect("corpus json")
    }

    /// Every case the generator wrote from the frozen Node transcription, step
    /// for step. A reordered annotation, a dropped metric or a changed close
    /// code fails here naming the case.
    #[test]
    fn the_admission_plan_matches_the_frozen_node_implementation() {
        let corpus = corpus();
        let cases = corpus["cases"].as_array().expect("cases array");
        assert_eq!(cases.len(), 1080, "the corpus must stay exhaustive");
        for case in cases {
            let facts = facts_from(&case["facts"]);
            let actual: Vec<Value> = plan(&facts).iter().map(step_json).collect();
            let expected = case["steps"].as_array().expect("steps array");
            assert_eq!(
                &actual,
                expected,
                "{} / {}",
                case["sweep"].as_str().unwrap_or(""),
                case["name"].as_str().unwrap_or("")
            );
        }
    }

    /// `needs_ticket` and `plan` read the same share rule, so the answer must
    /// agree with the frozen oracle on every case -- a caller that trusts it
    /// must never burn a ticket the retired path left alone.
    #[test]
    fn needs_ticket_agrees_with_the_frozen_oracle() {
        let corpus = corpus();
        for case in corpus["cases"].as_array().expect("cases array") {
            let facts = facts_from(&case["facts"]);
            assert_eq!(
                needs_ticket(&facts),
                case["consumesTicket"].as_bool().expect("consumesTicket"),
                "{}",
                case["name"].as_str().unwrap_or("")
            );
        }
    }

    /// The same invariant stated against `plan` itself: the auth phase is
    /// reached exactly when a ticket would be consumed. Every refusal before
    /// it, and every share grant, must leave the ticket table alone.
    #[test]
    fn needs_ticket_matches_the_phase_the_plan_reaches() {
        let corpus = corpus();
        for case in corpus["cases"].as_array().expect("cases array") {
            let mut facts = facts_from(&case["facts"]);
            // A ticket that would be refused for scope still proves the phase
            // was reached, so probe with one that annotates and nothing else.
            facts.has_ticket_param = true;
            facts.consumed_ticket = Some(Ticket {
                correlation_id: "probe".to_string(),
                ..Ticket::default()
            });
            let reached = plan(&facts)
                .iter()
                .any(|step| matches!(step, Step::CorrelationId(_)));
            assert_eq!(
                needs_ticket(&facts),
                reached,
                "{}",
                case["name"].as_str().unwrap_or("")
            );
        }
    }

    /// The router looks a share record up only when `needs_share_record` says
    /// so. That is only safe if a record cannot change the plan when it says
    /// no, which is asserted here over the whole corpus.
    #[test]
    fn the_share_record_is_ignored_unless_it_is_needed() {
        let corpus = corpus();
        for case in corpus["cases"].as_array().expect("cases array") {
            let facts = facts_from(&case["facts"]);
            if needs_share_record(&facts) {
                continue;
            }
            let mut planted = facts_from(&case["facts"]);
            planted.share_access = Some(ShareAccess {
                session_id: facts.session_param.clone(),
                access: "operate".to_string(),
            });
            assert_eq!(
                plan(&planted),
                plan(&facts),
                "{}",
                case["name"].as_str().unwrap_or("")
            );
            assert_eq!(needs_ticket(&planted), needs_ticket(&facts));
        }
    }

    #[test]
    fn the_json_bridge_round_trips_a_refusal_and_an_admission() {
        let denied =
            plan_json(r#"{"peerAllowed":true,"path":"/ws/chat","local":false,"accessToken":true}"#)
                .unwrap();
        assert_eq!(
            denied,
            r#"[{"op":"installSendQueue"},{"op":"metric","name":"multicc_ws_auth_denied_total"},{"op":"close","code":4003,"reason":"Forbidden"}]"#
        );
        let admitted = plan_json(r#"{"peerAllowed":true,"path":"/ws/chat","local":true}"#).unwrap();
        assert_eq!(
            admitted,
            r#"[{"op":"installSendQueue"},{"op":"sharePermission","value":null},{"op":"accept"}]"#
        );
        assert!(needs_ticket_json(r#"{"peerAllowed":true,"path":"/ws/chat"}"#).unwrap());
        assert!(!needs_ticket_json(r#"{"shuttingDown":true,"peerAllowed":true}"#).unwrap());
        assert!(plan_json("{").is_err());
    }
}
