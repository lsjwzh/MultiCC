//! Background hold — Rust owner.
//!
//! A resident Claude turn ends at the CLI's main `result`, but background work
//! it started (Agent, run_in_background Bash, Monitor) completes later and the
//! CLI wakes itself with a `<task-notification>` query. Holding the host turn
//! open until that work is done lets those queries run inside the turn (the
//! admitted provider route, the live stream consumer) instead of being
//! re-queued as a separate 🔇 turn.
//!
//! The user's rule: *if background work has not finished, do not mark the turn
//! as ended.* Turn lifetime is a fact, not a timer — a resident turn is open
//! while ANY of these holds:
//!
//!   * its main `result` has not arrived yet,
//!   * background work it owns is still alive,
//!   * a user message injected into the turn has not been answered.
//!
//! It ends only when all three are false, or on user cancel / process death.
//! The cap (`MULTICC_BACKGROUND_HOLD_MAX_MS`) is deliberately not a release
//! trigger: it only marks the point where the host must say so out loud.
//!
//! Which input a result answers is a fact the CLI reports on the result itself
//! (`user_message_uuid` / `user_message_uuids`; observed with the bundled
//! binary, SDK 0.3.317). Two messages queued back to back are coalesced into
//! ONE result that lists BOTH uuids, so settlement is membership-based, never a
//! counter:
//!
//!   * a result whose uuid list covers injected uuid(s) answers those
//!     exchanges — it settles them and is NOT the turn's outcome;
//!   * a result with `origin.kind = 'task-notification'` (a self-wake) never
//!     covers an injected uuid, so it only ever decides the turn's outcome.
//!
//! Everything about the held turn is decided here: the pending injections
//! (ordered, keyed by delivery identity AND message uuid), the written-once
//! identity memory, the turn's own outcome, the injected exchanges' outcomes and
//! usage, the release decision and the injectable predicate. Node only performs
//! the I/O (write the JSON line, append the history row).
//!
//! Exactly-once delivery: [`Hold::begin_injection`] registers the delivery
//! identity BEFORE the host writes the line. A refused/duplicated identity is
//! told to append the missing history row only — the line is never written
//! twice. A failed write calls [`Hold::abort_injection`], which releases the
//! identity so the retry may write.
use serde_json::{Map, Value};
use std::collections::VecDeque;

pub const QUIET_MS: f64 = 5000.0;
pub const TICK_MS: f64 = 1000.0;
pub const DEFAULT_MAX_MS: f64 = 60.0 * 60.0 * 1000.0;
/// Bounded written-once memory. It only has to bridge the seconds between the
/// stdin write and the outbox acknowledgement; the durable history row (same
/// client id) stays the second guard after an eviction.
pub const REMEMBERED_LIMIT: usize = 1024;

/// `MULTICC_BACKGROUND_HOLD_MAX_MS` parsing, exactly `Number()` semantics:
/// an unset variable keeps the default, anything else takes the coerced number
/// when it is finite and non-negative.
pub fn hold_max_ms(value: Option<&Value>) -> f64 {
    match value {
        None => DEFAULT_MAX_MS,
        Some(value) => {
            let number = crate::js::serde::js_to_number(value);
            if number.is_finite() && number >= 0.0 {
                number
            } else {
                DEFAULT_MAX_MS
            }
        }
    }
}

fn text_field<'a>(event: &'a Value, name: &str) -> Option<&'a str> {
    event.get(name).and_then(Value::as_str)
}

fn succeeded(event: &Value) -> bool {
    text_field(event, "subtype") == Some("success")
        && event.get("is_error") == Some(&Value::Bool(false))
}

/// The last self-wake request is what decides the turn: a failure that no later
/// success superseded must be released as a failure, not hidden behind the held
/// main answer. Cancellations/aborts/interrupts and unrecognized results carry
/// no upstream verdict and therefore leave the tracked outcome untouched.
fn failed(event: &Value) -> bool {
    if event.get("is_error") == Some(&Value::Bool(true)) {
        return true;
    }
    if text_field(event, "terminal_reason") == Some("api_error") {
        return true;
    }
    match text_field(event, "subtype") {
        // `/^error(?:_|$)/` without a regex dependency.
        Some(subtype) => subtype == "error" || subtype.starts_with("error_"),
        None => false,
    }
}

fn cancelled(event: &Value) -> bool {
    matches!(
        text_field(event, "terminal_reason"),
        Some("cancelled") | Some("aborted") | Some("interrupted")
    )
}

fn is_continuation(event: &Value) -> bool {
    match text_field(event, "type") {
        Some("assistant") | Some("user") | Some("stream_event") => true,
        Some("system") => text_field(event, "subtype") == Some("init"),
        _ => false,
    }
}

/// The user-message uuids this result answers, in the CLI's order. Observed
/// shape (bundled binary): `user_message_uuids: [..]` plus a singular
/// `user_message_uuid` (the LAST uuid) on every result that answers input.
/// A self-wake result carries neither.
pub fn answered_uuids(event: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if let Some(list) = event.get("user_message_uuids").and_then(Value::as_array) {
        for value in list {
            if let Some(text) = value.as_str() {
                if !text.is_empty() && !out.iter().any(|seen| seen == text) {
                    out.push(text.to_string());
                }
            }
        }
    }
    if let Some(text) = text_field(event, "user_message_uuid") {
        if !text.is_empty() && !out.iter().any(|seen| seen == text) {
            out.push(text.to_string());
        }
    }
    out
}

/// A released event built as `{ ...held, <overrides> }`.
///
/// `event` keeps the held main result's identity; `undefined_keys` names the
/// override keys JavaScript would set to `undefined` (absent from the JSON
/// map because JSON cannot carry one). The addon materializes those as real
/// `undefined` properties so the released object has exactly the legacy shape.
#[derive(Debug, Clone, PartialEq)]
pub struct Release {
    pub event: Value,
    pub undefined_keys: Vec<String>,
}

fn spread(base: &Value, overrides: Vec<(&str, Option<Value>)>) -> Release {
    let mut map = match base {
        Value::Object(map) => map.clone(),
        _ => Map::new(),
    };
    let mut undefined_keys = Vec::new();
    for (key, value) in overrides {
        match value {
            Some(value) => {
                map.insert(key.to_string(), value);
            }
            None => {
                map.remove(key);
                undefined_keys.push(key.to_string());
            }
        }
    }
    Release {
        event: Value::Object(map),
        undefined_keys,
    }
}

fn pick(latest: &Value, held: &Value, key: &str) -> Option<Value> {
    match latest.get(key) {
        Some(value) => Some(value.clone()),
        None => held.get(key).cloned(),
    }
}

// The released event keeps the held main result's identity (it is what the
// completion tracker adjudicates) and takes the final answer, usage and cost
// from the last successful self-wake query.
fn merge(held: &Value, latest: Option<&Value>) -> Release {
    let Some(latest) = latest else {
        return Release {
            event: held.clone(),
            undefined_keys: Vec::new(),
        };
    };
    spread(
        held,
        vec![
            ("result", pick(latest, held, "result")),
            ("usage", pick(latest, held, "usage")),
            ("modelUsage", pick(latest, held, "modelUsage")),
            ("total_cost_usd", pick(latest, held, "total_cost_usd")),
        ],
    )
}

// A failed last wake releases the held turn as an API error. `result` is
// intentionally undefined when the failing result carried no text: the held
// main answer must not masquerade as the failed request's output.
fn failed_release(held: &Value, failure: &Value) -> Release {
    let terminal_reason = failure
        .get("terminal_reason")
        .cloned()
        .unwrap_or_else(|| Value::String("api_error".to_string()));
    spread(
        held,
        vec![
            ("subtype", failure.get("subtype").cloned()),
            ("is_error", Some(Value::Bool(true))),
            ("terminal_reason", Some(terminal_reason)),
            ("api_error_status", failure.get("api_error_status").cloned()),
            ("result", failure.get("result").cloned()),
            ("errors", failure.get("errors").cloned()),
            ("usage", pick(failure, held, "usage")),
            ("modelUsage", pick(failure, held, "modelUsage")),
            ("total_cost_usd", pick(failure, held, "total_cost_usd")),
            ("background_wake_failed", Some(Value::Bool(true))),
        ],
    )
}

/// One user message injected into the held turn that has not been answered yet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingInjection {
    pub identity: String,
    pub uuid: String,
}

/// What the host must do for a delivery identity that wants the held turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InjectionRegistration {
    /// Registered now and not written before: write the line with this uuid.
    Write { uuid: String },
    /// Already written once (a retry after the history row failed): do NOT
    /// write again, only append the missing row.
    AppendOnly { uuid: String },
    /// Nothing to do; the message waits for a normal turn.
    Refuse { reason: &'static str },
}

/// One injected exchange that already has its answer. Its outcome and usage are
/// carried on the release event separately from the turn's own result.
#[derive(Debug, Clone, PartialEq)]
pub struct InjectedExchange {
    pub identity: String,
    pub uuid: String,
    pub event: Value,
}

impl InjectedExchange {
    fn value(&self) -> Value {
        let mut map = Map::new();
        map.insert("identity".to_string(), Value::String(self.identity.clone()));
        map.insert("uuid".to_string(), Value::String(self.uuid.clone()));
        for key in [
            "result",
            "usage",
            "modelUsage",
            "total_cost_usd",
            "is_error",
            "subtype",
        ] {
            if let Some(value) = self.event.get(key) {
                map.insert(key.to_string(), value.clone());
            }
        }
        Value::Object(map)
    }
}

fn sum_usage(exchanges: &[InjectedExchange]) -> Option<Value> {
    let mut totals: Map<String, Value> = Map::new();
    for exchange in exchanges {
        let Some(usage) = exchange.event.get("usage").and_then(Value::as_object) else {
            continue;
        };
        for (key, value) in usage {
            let Some(number) = value.as_f64() else {
                continue;
            };
            let base = totals.get(key).and_then(Value::as_f64).unwrap_or(0.0);
            totals.insert(key.clone(), Value::from(base + number));
        }
    }
    if totals.is_empty() {
        None
    } else {
        Some(Value::Object(totals))
    }
}

fn sum_cost(exchanges: &[InjectedExchange]) -> Option<Value> {
    let mut total = 0.0;
    let mut seen = false;
    for exchange in exchanges {
        if let Some(cost) = exchange.event.get("total_cost_usd").and_then(Value::as_f64) {
            total += cost;
            seen = true;
        }
    }
    seen.then(|| Value::from(total))
}

// The turn's own outcome is the held main result (or its self-wakes). Injected
// exchanges ride along as separate fields so the host can account their usage
// without letting their answer become the turn's answer.
fn attach_injected(release: &mut Release, exchanges: &[InjectedExchange]) {
    if exchanges.is_empty() {
        return;
    }
    let Some(map) = release.event.as_object_mut() else {
        return;
    };
    map.insert(
        "injected_exchanges".to_string(),
        Value::Array(exchanges.iter().map(InjectedExchange::value).collect()),
    );
    if let Some(usage) = sum_usage(exchanges) {
        map.insert("injected_usage".to_string(), usage);
    }
    if let Some(cost) = sum_cost(exchanges) {
        map.insert("injected_cost_usd".to_string(), cost);
    }
}

pub struct Hold {
    quiet_ms: f64,
    max_ms: f64,
    held: Option<Value>,
    latest: Option<Value>,
    last_wake: Option<Value>,
    busy: bool,
    quiet_since: Option<f64>,
    done: bool,
    /// Injected messages whose answer has not landed yet, in delivery order.
    /// The hold must not release while one is outstanding: the answer to a
    /// message the user just typed belongs to this turn.
    pending: Vec<PendingInjection>,
    /// Identities whose line was handed to the live process. Bounded; a retry
    /// of one of these appends the history row only.
    written: VecDeque<(String, String)>,
    /// Answers of injected exchanges, in the order they landed.
    exchanges: Vec<InjectedExchange>,
    cap_noted: bool,
}

impl Hold {
    pub fn new(quiet_ms: f64, max_ms: f64) -> Self {
        Self {
            quiet_ms: if quiet_ms.is_finite() && quiet_ms >= 0.0 {
                quiet_ms
            } else {
                QUIET_MS
            },
            max_ms,
            held: None,
            latest: None,
            last_wake: None,
            busy: false,
            quiet_since: None,
            done: false,
            pending: Vec::new(),
            written: VecDeque::new(),
            exchanges: Vec::new(),
            cap_noted: false,
        }
    }

    pub fn is_held(&self) -> bool {
        self.held.is_some() && !self.done
    }

    /// Outstanding injected messages (not a counter of results seen).
    pub fn injections(&self) -> u32 {
        self.pending.len() as u32
    }

    pub fn max_ms(&self) -> f64 {
        self.max_ms
    }

    /// Returns true when `event` (a main result) is held instead of ending the
    /// turn. `main_result` is the adapter's `isMainResult(event)` answer and
    /// `background_active` the host's live-background fact.
    pub fn start(&mut self, event: &Value, main_result: bool, background_active: bool) -> bool {
        if self.done || self.held.is_some() || !main_result || !succeeded(event) {
            return false;
        }
        if !background_active {
            return false;
        }
        self.held = Some(event.clone());
        self.pending.clear();
        self.exchanges.clear();
        self.quiet_since = None;
        true
    }

    /// Returns true when a held turn swallows `event` (self-wake query results
    /// and the events of an injected exchange's answer).
    pub fn observe(&mut self, event: &Value) -> bool {
        if !self.is_held() {
            return false;
        }
        if text_field(event, "type") == Some("result") {
            self.busy = false;
            self.quiet_since = None;
            // Which injected exchanges this result answers is reported by the
            // CLI (uuid membership), never inferred from counting. A result
            // that answers any of them is their answer, not the turn's.
            let answered = answered_uuids(event);
            if !answered.is_empty() {
                let mut settled: Vec<PendingInjection> = Vec::new();
                self.pending.retain(|entry| {
                    if answered.iter().any(|uuid| uuid == &entry.uuid) {
                        settled.push(entry.clone());
                        false
                    } else {
                        true
                    }
                });
                for entry in settled {
                    self.exchanges.push(InjectedExchange {
                        identity: entry.identity,
                        uuid: entry.uuid,
                        event: event.clone(),
                    });
                }
                // Any result that says which user message it answers is that
                // message's answer, never the turn's own: a duplicate of an
                // already-settled uuid is swallowed without touching `latest`.
                return true;
            }
            if cancelled(event) {
                return true;
            }
            if succeeded(event) {
                self.latest = Some(event.clone());
                self.last_wake = Some(event.clone());
            } else if failed(event) {
                self.last_wake = Some(event.clone());
            }
            return true;
        }
        if is_continuation(event) {
            self.busy = true;
            self.quiet_since = None;
        }
        false
    }

    /// Time-driven step. Returns the released event when the turn may end.
    pub fn tick(&mut self, now: f64, background_active: bool) -> Option<Release> {
        if !self.is_held() {
            self.quiet_since = None;
            return None;
        }
        if !self.pending.is_empty() || self.busy {
            self.quiet_since = None;
            return None;
        }
        if background_active {
            self.quiet_since = None;
            return None;
        }
        let since = match self.quiet_since {
            Some(since) => since,
            None => {
                self.quiet_since = Some(now);
                return None;
            }
        };
        if now - since >= self.quiet_ms {
            return self.finish();
        }
        None
    }

    /// Release now (quiet elapsed, cancel, insert-now): the held answer is
    /// complete.
    pub fn finish(&mut self) -> Option<Release> {
        if self.done {
            return None;
        }
        let held = self.held.take()?;
        self.done = true;
        let mut released = match self.last_wake.as_ref() {
            Some(wake) if failed(wake) => failed_release(&held, wake),
            _ => merge(&held, self.latest.as_ref()),
        };
        attach_injected(&mut released, &self.exchanges);
        self.latest = None;
        self.last_wake = None;
        self.pending.clear();
        self.exchanges.clear();
        self.quiet_since = None;
        Some(released)
    }

    /// Register a delivery identity BEFORE its line is written into the live
    /// process. Refuses when there is no held turn (or the same identity is
    /// already pending); an identity written once is told to append the missing
    /// history row only.
    pub fn begin_injection(&mut self, identity: &str, uuid: &str) -> InjectionRegistration {
        if !self.is_held() {
            return InjectionRegistration::Refuse { reason: "not_held" };
        }
        if identity.is_empty() {
            return InjectionRegistration::Refuse {
                reason: "identity_required",
            };
        }
        if uuid.is_empty() {
            return InjectionRegistration::Refuse {
                reason: "uuid_required",
            };
        }
        if let Some((_, written_uuid)) = self.written.iter().find(|(id, _)| id == identity) {
            return InjectionRegistration::AppendOnly {
                uuid: written_uuid.clone(),
            };
        }
        if self.pending.iter().any(|entry| entry.identity == identity) {
            return InjectionRegistration::Refuse {
                reason: "injection_in_flight",
            };
        }
        if self.written.len() >= REMEMBERED_LIMIT {
            self.written.pop_front();
        }
        self.written
            .push_back((identity.to_string(), uuid.to_string()));
        self.pending.push(PendingInjection {
            identity: identity.to_string(),
            uuid: uuid.to_string(),
        });
        self.quiet_since = None;
        InjectionRegistration::Write {
            uuid: uuid.to_string(),
        }
    }

    /// The write failed: release the identity so a retry may write it.
    pub fn abort_injection(&mut self, identity: &str) {
        self.pending.retain(|entry| entry.identity != identity);
        self.written.retain(|(id, _)| id != identity);
    }

    /// True exactly once, when the host's cap timer first fires on a held turn.
    /// Release does not follow from it — the notice is the whole point.
    pub fn cap_reached(&mut self, background_active: bool) -> bool {
        if !self.is_held() || self.cap_noted {
            return false;
        }
        if !background_active {
            return false;
        }
        self.cap_noted = true;
        true
    }

    pub fn dispose(&mut self) {
        self.done = true;
        self.held = None;
        self.latest = None;
        self.last_wake = None;
        self.pending.clear();
        self.written.clear();
        self.exchanges.clear();
        self.quiet_since = None;
    }
}

/// Facts for "may this typed message be delivered INTO the held turn?".
///
/// The host supplies every field; the answer is decided here so both resident
/// Claude backends share one rule and Node keeps no copy of it. Several
/// injections may be pending at once (the CLI coalesces queued user messages
/// into one result that lists every uuid), so this predicate does not limit
/// them; it only gates the first write.
#[derive(Debug, Clone, Default)]
pub struct InjectFacts {
    pub held: bool,
    /// A human typed it in the chat page (not dispatch / trigger / task-shell
    /// receipt / continuation).
    pub user_typed: bool,
    /// The lane reports which user message each result answers (an SDK result
    /// carries `user_message_uuid(s)`). A plain stream-json lane reports no
    /// attribution, so an injected line there could never be settled.
    pub attributable: bool,
    /// The host turn is still running (`run_active`).
    pub turn_active: bool,
    /// A live CLI/SDK process can accept another user line.
    pub process_alive: bool,
    /// The live process would no longer be the one a fresh turn spawns (route,
    /// settings or vault drift the pump already detects).
    pub process_stale: bool,
    /// Spawn-contract digests: the process that is running versus the one a
    /// fresh turn would need.
    pub process_contract: Option<String>,
    pub wanted_contract: Option<String>,
    /// This delivery identity already has a durable row (settled / replayed).
    pub delivery_settled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InjectDecision {
    pub inject: bool,
    pub reason: &'static str,
}

impl InjectDecision {
    const fn allow() -> Self {
        Self {
            inject: true,
            reason: "held",
        }
    }
    const fn wait(reason: &'static str) -> Self {
        Self {
            inject: false,
            reason,
        }
    }
}

/// Pure predicate: no clock, no host calls, no state.
pub fn may_inject(facts: &InjectFacts) -> InjectDecision {
    if !facts.held {
        return InjectDecision::wait("not_held");
    }
    if !facts.turn_active {
        return InjectDecision::wait("no_active_turn");
    }
    if !facts.user_typed {
        return InjectDecision::wait("not_user_typed");
    }
    if !facts.attributable {
        return InjectDecision::wait("unattributable_lane");
    }
    if !facts.process_alive {
        return InjectDecision::wait("process_not_alive");
    }
    if facts.process_stale {
        return InjectDecision::wait("process_changed");
    }
    match (&facts.process_contract, &facts.wanted_contract) {
        (Some(process), Some(wanted)) if process == wanted => {}
        _ => return InjectDecision::wait("spawn_contract_changed"),
    }
    if facts.delivery_settled {
        return InjectDecision::wait("already_delivered");
    }
    InjectDecision::allow()
}

/// The facts a "is the live process still the desired one?" comparison needs.
/// `None` means the fact was not observable on that side; equal `None`s count
/// as equal so an untouched fact never looks like drift.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProcessFacts {
    pub route_url: Option<String>,
    pub route_token: Option<String>,
    pub fingerprint: Option<String>,
    pub vault_digest: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ProcessStaleness {
    pub route_changed: bool,
    pub config_changed: bool,
    pub vault_stale: bool,
}

impl ProcessStaleness {
    pub fn stale(&self) -> bool {
        self.route_changed || self.config_changed || self.vault_stale
    }
}

/// One comparison used by the stream pump (may a waiting turn reuse this
/// process?) and by the injection predicate (may a typed message enter it?).
pub fn process_stale(running: &ProcessFacts, wanted: &ProcessFacts) -> ProcessStaleness {
    ProcessStaleness {
        route_changed: running.route_url != wanted.route_url
            || running.route_token != wanted.route_token,
        config_changed: running.fingerprint != wanted.fingerprint,
        vault_stale: running.vault_digest != wanted.vault_digest,
    }
}

/// The fields the "a human typed this in the chat box" rule reads. Host
/// objects stay host objects; the rule itself lives here.
#[derive(Debug, Clone, Default)]
pub struct TypedFacts {
    pub payload_type: Option<String>,
    pub source: Option<String>,
    pub origin_continue: bool,
    pub origin_dispatch_id: bool,
    pub payload_origin_dispatch_id: bool,
    pub request_id: bool,
    pub user_input_request_id: bool,
}

/// A direct, human-typed chat message. Excluded on purpose: dispatch requests,
/// triggers, machine continuations (originContinue), and task-page
/// (task-shell) messages — the last is human-typed too, but its receipt
/// lifecycle is owned by the turn engine, which an injected message never
/// enters, so it keeps waiting instead of being written behind the engine's
/// back.
pub fn is_direct_user_typed(facts: &TypedFacts) -> bool {
    facts.payload_type.as_deref() == Some("session.work")
        && facts.source.as_deref() == Some("direct")
        && !facts.origin_continue
        && !facts.origin_dispatch_id
        && !facts.payload_origin_dispatch_id
        && !facts.request_id
        && !facts.user_input_request_id
}

/// `backgroundHoldSpawnContract(facts)` — a stable digest of everything that
/// decides which process serves a turn. Compared byte-for-byte by
/// [`may_inject`]; computed once when a process spawns and once per delivery.
pub fn spawn_contract(facts: &Value) -> String {
    use sha2::{Digest, Sha256};
    let canonical = crate::js::serde::stable_stringify(facts);
    let digest = Sha256::digest(canonical.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn main_result() -> Value {
        json!({"type":"result","subtype":"success","is_error":false,"result":"first","usage":{"input_tokens":1}})
    }

    fn wake(result: &str) -> Value {
        json!({"type":"result","subtype":"success","is_error":false,"result":result,
            "origin":{"kind":"task-notification"},"usage":{"input_tokens":9}})
    }

    fn answer(uuids: &[&str], result: &str, input_tokens: f64) -> Value {
        json!({"type":"result","subtype":"success","is_error":false,"result":result,
            "user_message_uuid": uuids.last().copied().unwrap_or(""),
            "user_message_uuids": uuids,
            "usage":{"input_tokens":input_tokens,"output_tokens":2}})
    }

    fn failure(result: &str) -> Value {
        json!({"type":"result","subtype":"error_during_execution","is_error":true,"result":result,
            "terminal_reason":"api_error","api_error_status":429,"usage":{"input_tokens":9}})
    }

    #[test]
    fn holds_only_a_successful_main_result_with_background_work() {
        let mut hold = Hold::new(QUIET_MS, DEFAULT_MAX_MS);
        assert!(!hold.start(&main_result(), false, true));
        assert!(!hold.start(&main_result(), true, false));
        assert!(hold.start(&main_result(), true, true));
        assert!(hold.is_held());
        assert!(!hold.start(&main_result(), true, true));
    }

    #[test]
    fn releases_after_quiet_once_background_ends() {
        let mut hold = Hold::new(50.0, DEFAULT_MAX_MS);
        assert!(hold.start(&main_result(), true, true));
        assert!(hold.tick(0.0, true).is_none());
        assert!(hold.tick(1000.0, true).is_none());
        assert!(hold.tick(2000.0, false).is_none(), "quiet window starts");
        assert!(hold.tick(2030.0, false).is_none());
        let released = hold.tick(2050.0, false).expect("quiet elapsed");
        assert_eq!(released.event["result"], json!("first"));
        assert!(released.undefined_keys.is_empty());
        assert!(released.event.get("injected_exchanges").is_none());
    }

    #[test]
    fn never_releases_on_the_cap_while_background_is_alive() {
        let mut hold = Hold::new(50.0, 100.0);
        assert!(hold.start(&main_result(), true, true));
        for step in 0..10_000 {
            assert!(hold.tick(step as f64 * 1000.0, true).is_none());
        }
        assert!(hold.is_held(), "the cap is not a release trigger");
        assert!(hold.cap_reached(true), "the cap notices once");
        assert!(!hold.cap_reached(true));
    }

    #[test]
    fn last_self_wake_decides_and_failure_is_released_as_failure() {
        let mut hold = Hold::new(10.0, DEFAULT_MAX_MS);
        assert!(hold.start(&main_result(), true, true));
        assert!(!hold.observe(&json!({"type":"assistant"})));
        assert!(hold.observe(&wake("second")));
        assert!(hold.observe(&failure("boom")));
        let released = hold.finish().expect("released");
        assert_eq!(released.event["result"], json!("boom"));
        assert_eq!(released.event["is_error"], json!(true));
        assert_eq!(released.event["terminal_reason"], json!("api_error"));
        assert_eq!(released.event["api_error_status"], json!(429));
        assert_eq!(released.event["background_wake_failed"], json!(true));
        assert_eq!(released.event["usage"], json!({"input_tokens":9}));
        // `{...held, modelUsage: undefined}`: keys the legacy spread set to
        // undefined stay in the shape without a value.
        assert_eq!(
            released.undefined_keys,
            vec!["errors", "modelUsage", "total_cost_usd"]
        );
    }

    #[test]
    fn a_failing_wake_without_text_does_not_borrow_the_held_answer() {
        let mut hold = Hold::new(10.0, DEFAULT_MAX_MS);
        assert!(hold.start(&main_result(), true, true));
        assert!(hold.observe(&json!({"type":"result","subtype":"error","is_error":true})));
        let released = hold.finish().expect("released");
        assert!(
            released.event.get("result").is_none(),
            "no held answer leak"
        );
        assert!(released.undefined_keys.iter().any(|key| key == "result"));
        assert_eq!(released.event["is_error"], json!(true));
    }

    #[test]
    fn success_after_failure_supersedes_and_cancel_leaves_it_untouched() {
        let mut hold = Hold::new(10.0, DEFAULT_MAX_MS);
        assert!(hold.start(&main_result(), true, true));
        assert!(hold.observe(&failure("wake-429")));
        assert!(hold.observe(&wake("recovered")));
        let released = hold.finish().expect("released");
        assert_eq!(released.event["result"], json!("recovered"));
        assert_eq!(released.event["is_error"], json!(false));
        assert!(released
            .undefined_keys
            .iter()
            .all(|key| key == "modelUsage" || key == "total_cost_usd"));
        assert!(released.event.get("background_wake_failed").is_none());

        let mut keep = Hold::new(10.0, DEFAULT_MAX_MS);
        assert!(keep.start(&main_result(), true, true));
        assert!(keep.observe(&wake("kept")));
        assert!(keep.observe(&json!({"type":"result","terminal_reason":"interrupted"})));
        assert_eq!(
            keep.finish().expect("released").event["result"],
            json!("kept")
        );
    }

    #[test]
    fn an_injected_exchange_is_settled_by_uuid_and_is_not_the_turn_result() {
        let mut hold = Hold::new(10.0, DEFAULT_MAX_MS);
        assert!(hold.start(&main_result(), true, true));
        assert_eq!(
            hold.begin_injection("m1", "uuid-a"),
            InjectionRegistration::Write {
                uuid: "uuid-a".into()
            }
        );
        assert_eq!(hold.injections(), 1);
        // Background finished, quiet elapsed — no release while unanswered.
        assert!(hold.tick(0.0, false).is_none());
        assert!(hold.tick(1000.0, false).is_none());
        // A self-wake (task-notification, no user uuid) never settles it.
        assert!(hold.observe(&wake("wake after background ended")));
        assert_eq!(hold.injections(), 1, "a self-wake is not an answer");
        assert!(hold.tick(2000.0, false).is_none(), "still unanswered");
        // The answer to the injected message settles exactly that exchange.
        assert!(hold.observe(&answer(&["uuid-a"], "answer to the typed message", 3.0)));
        assert_eq!(hold.injections(), 0);
        assert!(hold.tick(3000.0, false).is_none());
        let released = hold.tick(4000.0, false).expect("released after the answer");
        assert_eq!(
            released.event["result"],
            json!("wake after background ended")
        );
        let exchanges = released.event["injected_exchanges"]
            .as_array()
            .expect("exchanges ride along");
        assert_eq!(exchanges.len(), 1);
        assert_eq!(exchanges[0]["uuid"], json!("uuid-a"));
        assert_eq!(exchanges[0]["identity"], json!("m1"));
        assert_eq!(exchanges[0]["result"], json!("answer to the typed message"));
        assert_eq!(
            released.event["injected_usage"],
            json!({"input_tokens":3.0,"output_tokens":2.0})
        );
    }

    #[test]
    fn two_queued_messages_are_settled_by_one_coalesced_result() {
        let mut hold = Hold::new(10.0, DEFAULT_MAX_MS);
        assert!(hold.start(&main_result(), true, true));
        assert!(matches!(
            hold.begin_injection("m1", "uuid-a"),
            InjectionRegistration::Write { .. }
        ));
        assert!(matches!(
            hold.begin_injection("m2", "uuid-b"),
            InjectionRegistration::Write { .. }
        ));
        assert_eq!(hold.injections(), 2);
        // The bundled binary coalesces two queued messages into one result that
        // lists both uuids (observed shape).
        assert!(hold.observe(&answer(&["uuid-a", "uuid-b"], "both answered", 4.0)));
        assert_eq!(hold.injections(), 0, "one result settles both");
        let released = hold.finish().expect("released");
        assert_eq!(released.event["result"], json!("first"));
        assert_eq!(
            released.event["injected_exchanges"]
                .as_array()
                .map(Vec::len),
            Some(2)
        );
    }

    #[test]
    fn retry_only_appends_the_row_and_abort_releases_the_identity() {
        let mut hold = Hold::new(10.0, DEFAULT_MAX_MS);
        assert!(hold.start(&main_result(), true, true));
        assert!(matches!(
            hold.begin_injection("m1", "uuid-a"),
            InjectionRegistration::Write { .. }
        ));
        // The host wrote the line; the history row failed. The retry must not
        // be told to write again.
        assert_eq!(
            hold.begin_injection("m1", "uuid-ignored"),
            InjectionRegistration::AppendOnly {
                uuid: "uuid-a".into()
            }
        );
        assert_eq!(hold.injections(), 1);

        // A failed write releases the identity so the retry may write it.
        let mut failed_write = Hold::new(10.0, DEFAULT_MAX_MS);
        assert!(failed_write.start(&main_result(), true, true));
        assert!(matches!(
            failed_write.begin_injection("m2", "uuid-b"),
            InjectionRegistration::Write { .. }
        ));
        failed_write.abort_injection("m2");
        assert_eq!(failed_write.injections(), 0);
        assert_eq!(
            failed_write.begin_injection("m2", "uuid-c"),
            InjectionRegistration::Write {
                uuid: "uuid-c".into()
            }
        );
    }

    #[test]
    fn injection_needs_a_held_turn_and_a_registered_identity() {
        let mut hold = Hold::new(10.0, DEFAULT_MAX_MS);
        assert_eq!(
            hold.begin_injection("m1", "uuid-a"),
            InjectionRegistration::Refuse { reason: "not_held" }
        );
        assert!(hold.start(&main_result(), true, true));
        assert_eq!(
            hold.begin_injection("", "uuid-a"),
            InjectionRegistration::Refuse {
                reason: "identity_required"
            }
        );
        assert_eq!(
            hold.begin_injection("m1", ""),
            InjectionRegistration::Refuse {
                reason: "uuid_required"
            }
        );
        hold.dispose();
        assert!(matches!(
            hold.begin_injection("m1", "uuid-a"),
            InjectionRegistration::Refuse { .. }
        ));
    }

    #[test]
    fn an_injected_answer_never_decides_the_turn_outcome() {
        let mut hold = Hold::new(10.0, DEFAULT_MAX_MS);
        assert!(hold.start(&main_result(), true, true));
        assert!(matches!(
            hold.begin_injection("m1", "uuid-a"),
            InjectionRegistration::Write { .. }
        ));
        assert!(hold.observe(&answer(&["uuid-a"], "typed answer", 3.0)));
        // A duplicate of the already-settled uuid is swallowed too: it must not
        // replace the turn's own outcome with the injected answer.
        assert!(hold.observe(&answer(&["uuid-a"], "duplicate answer", 9.0)));
        let released = hold.finish().expect("released");
        assert_eq!(
            released.event["result"],
            json!("first"),
            "the turn's own result, not the injected answer"
        );
        assert_eq!(released.event["usage"], json!({"input_tokens":1}));
        assert_eq!(
            released.event["injected_usage"],
            json!({"input_tokens":3.0,"output_tokens":2.0})
        );
    }

    fn facts() -> InjectFacts {
        InjectFacts {
            held: true,
            user_typed: true,
            attributable: true,
            turn_active: true,
            process_alive: true,
            process_contract: Some("same".into()),
            wanted_contract: Some("same".into()),
            ..InjectFacts::default()
        }
    }

    #[test]
    fn injects_only_for_a_held_user_typed_message_on_the_same_contract() {
        assert!(may_inject(&facts()).inject);
        let mut f = facts();
        f.held = false;
        assert_eq!(may_inject(&f).reason, "not_held");
        let mut f = facts();
        f.turn_active = false;
        assert_eq!(may_inject(&f).reason, "no_active_turn");
        let mut f = facts();
        f.user_typed = false;
        assert_eq!(may_inject(&f).reason, "not_user_typed");
        let mut f = facts();
        f.attributable = false;
        assert_eq!(may_inject(&f).reason, "unattributable_lane");
        let mut f = facts();
        f.process_alive = false;
        assert_eq!(may_inject(&f).reason, "process_not_alive");
        let mut f = facts();
        f.process_stale = true;
        assert_eq!(may_inject(&f).reason, "process_changed");
        let mut f = facts();
        f.wanted_contract = Some("other".into());
        assert_eq!(may_inject(&f).reason, "spawn_contract_changed");
        let mut f = facts();
        f.process_contract = None;
        assert_eq!(may_inject(&f).reason, "spawn_contract_changed");
        let mut f = facts();
        f.delivery_settled = true;
        assert_eq!(may_inject(&f).reason, "already_delivered");
    }

    #[test]
    fn process_staleness_compares_the_same_facts_the_pump_uses() {
        let running = ProcessFacts {
            route_url: Some("http://relay/one".into()),
            route_token: Some("t1".into()),
            fingerprint: Some("f1".into()),
            vault_digest: Some("v1".into()),
        };
        assert!(!process_stale(&running, &running.clone()).stale());
        let mut wanted = running.clone();
        wanted.route_url = Some("http://relay/two".into());
        assert_eq!(
            process_stale(&running, &wanted),
            ProcessStaleness {
                route_changed: true,
                config_changed: false,
                vault_stale: false
            }
        );
        let mut wanted = running.clone();
        wanted.fingerprint = Some("f2".into());
        assert!(process_stale(&running, &wanted).config_changed);
        let mut wanted = running.clone();
        wanted.vault_digest = Some("v2".into());
        assert!(process_stale(&running, &wanted).vault_stale);
        // A fact never observed on the running side must not look like drift
        // when the wanted side has one too.
        let unobserved = ProcessFacts::default();
        assert!(!process_stale(&unobserved, &unobserved).stale());
    }

    #[test]
    fn direct_user_typed_excludes_machine_and_task_page_messages() {
        let typed = TypedFacts {
            payload_type: Some("session.work".into()),
            source: Some("direct".into()),
            ..TypedFacts::default()
        };
        assert!(is_direct_user_typed(&typed));
        for mutate in [
            |f: &mut TypedFacts| f.payload_type = Some("session.notice".into()),
            |f: &mut TypedFacts| f.source = Some("dispatch".into()),
            |f: &mut TypedFacts| f.origin_continue = true,
            |f: &mut TypedFacts| f.origin_dispatch_id = true,
            |f: &mut TypedFacts| f.payload_origin_dispatch_id = true,
            |f: &mut TypedFacts| f.request_id = true,
            |f: &mut TypedFacts| f.user_input_request_id = true,
        ] {
            let mut facts = typed.clone();
            mutate(&mut facts);
            assert!(!is_direct_user_typed(&facts));
        }
    }

    #[test]
    fn spawn_contract_is_order_independent_and_stable() {
        let digest = spawn_contract(&json!({"cli":"claude","model":"probe"}));
        assert_eq!(digest.len(), 64);
        assert_eq!(
            digest,
            spawn_contract(&json!({"model":"probe","cli":"claude"}))
        );
        assert_ne!(
            digest,
            spawn_contract(&json!({"cli":"claude","model":"other"}))
        );
    }

    #[test]
    fn cap_parsing_matches_number_semantics() {
        assert_eq!(hold_max_ms(None), DEFAULT_MAX_MS);
        assert_eq!(hold_max_ms(Some(&json!("60000"))), 60000.0);
        assert_eq!(hold_max_ms(Some(&json!(""))), 0.0);
        assert_eq!(hold_max_ms(Some(&json!(-1))), DEFAULT_MAX_MS);
        assert_eq!(hold_max_ms(Some(&json!("abc"))), DEFAULT_MAX_MS);
        assert_eq!(hold_max_ms(Some(&Value::Null)), 0.0);
    }
}
