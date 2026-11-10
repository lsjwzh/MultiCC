//! Background hold — Rust owner.
//!
//! A resident Claude turn ends at the CLI's main `result`, but background work
//! it started (Agent, run_in_background Bash, Monitor) completes later and the
//! CLI wakes itself with a `<task-notification>` query. Holding the host turn
//! open until that work is done lets those queries run inside the turn (the
//! admitted provider route, the live stream consumer) instead of being
//! re-queued as a separate 🔇 turn.
//!
//! This module is the whole state machine migrated from
//! `src/chat/background-hold.js`. Two facts are supplied by the host on every
//! call because they are host I/O, not state: whether a main `result` is a
//! main-result event (`isMainResult` lives in the CLI adapter) and whether
//! background work is still alive (`hasBackground` reads the background-task
//! runtime). Everything else — what is held, when the turn may be released,
//! which self-wake decides the released outcome, and whether a typed message
//! may be delivered INTO the held turn — is decided here.
//!
//! The cap (`MULTICC_BACKGROUND_HOLD_MAX_MS`) is deliberately no longer a
//! release trigger: background work that never ends (a persistent Monitor)
//! keeps the turn open until the user cancels, which is the point — a turn that
//! ended while its background work was still alive is the inconsistent state
//! (turn over, background alive, lease pinned). The cap only marks the point
//! where the host should say so out loud.
//!
//! The LAST self-wake result decides the released outcome: a later success
//! supersedes an earlier failure and vice versa, while cancellations/aborts and
//! unknown results leave it untouched. Releasing a turn whose last wake failed
//! as a success is how a 429 from a task-notification wake was hidden behind the
//! held answer.
use serde_json::{Map, Value};

pub const QUIET_MS: f64 = 5000.0;
pub const TICK_MS: f64 = 1000.0;
pub const DEFAULT_MAX_MS: f64 = 60.0 * 60.0 * 1000.0;

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

pub struct Hold {
    quiet_ms: f64,
    max_ms: f64,
    held: Option<Value>,
    latest: Option<Value>,
    last_wake: Option<Value>,
    busy: bool,
    quiet_since: Option<f64>,
    done: bool,
    /// Injected user messages whose reply has not landed yet. The hold must not
    /// release while one is outstanding: the answer to a message the user just
    /// typed belongs to this turn.
    injections: u32,
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
            injections: 0,
            cap_noted: false,
        }
    }

    pub fn is_held(&self) -> bool {
        self.held.is_some() && !self.done
    }

    pub fn injections(&self) -> u32 {
        self.injections
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
        self.injections = 0;
        self.quiet_since = None;
        true
    }

    /// Returns true when a held turn swallows `event` (self-wake query results
    /// and the events of an injected query's answer).
    pub fn observe(&mut self, event: &Value) -> bool {
        if self.held.is_none() || self.done {
            return false;
        }
        if text_field(event, "type") == Some("result") {
            self.busy = false;
            self.quiet_since = None;
            // One result settles one injected query, whatever its verdict.
            self.injections = self.injections.saturating_sub(1);
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
        if self.held.is_none() || self.done {
            self.quiet_since = None;
            return None;
        }
        if self.injections > 0 || self.busy {
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
        let released = match self.last_wake.as_ref() {
            Some(wake) if failed(wake) => failed_release(&held, wake),
            _ => merge(&held, self.latest.as_ref()),
        };
        self.latest = None;
        self.last_wake = None;
        self.injections = 0;
        self.quiet_since = None;
        Some(released)
    }

    /// An injected query is about to be written to the live process. False when
    /// there is no held turn to answer inside.
    pub fn begin_injection(&mut self) -> bool {
        if !self.is_held() {
            return false;
        }
        self.injections = self.injections.saturating_add(1);
        self.quiet_since = None;
        true
    }

    pub fn abort_injection(&mut self) {
        self.injections = self.injections.saturating_sub(1);
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
        self.injections = 0;
        self.quiet_since = None;
    }
}

/// Facts for "may this typed message be delivered INTO the held turn?".
///
/// The host supplies every field; the answer is decided here so both resident
/// Claude backends share one rule and Node keeps no copy of it.
#[derive(Debug, Clone, Default)]
pub struct InjectFacts {
    pub held: bool,
    /// A previous injected query is still unanswered; one at a time.
    pub injection_in_flight: bool,
    /// A human typed it in the chat page (not dispatch / trigger / task-shell
    /// receipt / continuation).
    pub user_typed: bool,
    /// The host turn is still running (`run_active`).
    pub turn_active: bool,
    /// A live CLI/SDK process can accept another user line.
    pub process_alive: bool,
    /// Spawn-contract digests: the process that is running versus the one a
    /// fresh turn would need.
    pub process_contract: Option<String>,
    pub wanted_contract: Option<String>,
    /// This delivery identity is already durable (settled / replayed).
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
    if facts.injection_in_flight {
        return InjectDecision::wait("injection_in_flight");
    }
    if !facts.turn_active {
        return InjectDecision::wait("no_active_turn");
    }
    if !facts.user_typed {
        return InjectDecision::wait("not_user_typed");
    }
    if !facts.process_alive {
        return InjectDecision::wait("process_not_alive");
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
    fn an_outstanding_injection_keeps_the_turn_open() {
        let mut hold = Hold::new(10.0, DEFAULT_MAX_MS);
        assert!(hold.start(&main_result(), true, true));
        assert!(hold.begin_injection());
        assert_eq!(hold.injections(), 1);
        // Background ended, quiet elapsed — still no release while the answer
        // to the user's message is outstanding.
        assert!(hold.tick(0.0, false).is_none());
        assert!(hold.tick(1000.0, false).is_none());
        assert!(hold.observe(&wake("answer to the typed message")));
        assert_eq!(hold.injections(), 0);
        assert!(hold.tick(2000.0, false).is_none());
        let released = hold.tick(3000.0, false).expect("released after the answer");
        assert_eq!(
            released.event["result"],
            json!("answer to the typed message")
        );
    }

    #[test]
    fn injection_needs_a_held_turn() {
        let mut hold = Hold::new(10.0, DEFAULT_MAX_MS);
        assert!(!hold.begin_injection());
        assert!(hold.start(&main_result(), true, true));
        assert!(hold.begin_injection());
        hold.abort_injection();
        assert_eq!(hold.injections(), 0);
        hold.dispose();
        assert!(!hold.begin_injection());
    }

    fn facts() -> InjectFacts {
        InjectFacts {
            held: true,
            user_typed: true,
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
        f.injection_in_flight = true;
        assert_eq!(may_inject(&f).reason, "injection_in_flight");
        let mut f = facts();
        f.turn_active = false;
        assert_eq!(may_inject(&f).reason, "no_active_turn");
        let mut f = facts();
        f.user_typed = false;
        assert_eq!(may_inject(&f).reason, "not_user_typed");
        let mut f = facts();
        f.process_alive = false;
        assert_eq!(may_inject(&f).reason, "process_not_alive");
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
    fn cap_parsing_matches_number_semantics() {
        assert_eq!(hold_max_ms(None), DEFAULT_MAX_MS);
        assert_eq!(hold_max_ms(Some(&json!("60000"))), 60000.0);
        assert_eq!(hold_max_ms(Some(&json!(""))), 0.0);
        assert_eq!(hold_max_ms(Some(&json!(-1))), DEFAULT_MAX_MS);
        assert_eq!(hold_max_ms(Some(&json!("abc"))), DEFAULT_MAX_MS);
        assert_eq!(hold_max_ms(Some(&Value::Null)), 0.0);
    }
}
