//! Pure rules for the per-session turn runtime store that used to live in
//! `src/chat/runtime-store.js`.
//!
//! The store owns only proof-bearing preparation state: the current turn id,
//! phase, generation and the last/pending outcome. It deliberately has no
//! reference to the streaming runner, CLI child process or any other live host
//! object. Host values (the provider route proof) and the clock stay in the
//! addon owner; everything that must not drift from the frozen Node
//! implementation is decided here and unit-tested without an engine.

use crate::js::JsString;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Idle,
    Preparing,
    Running,
    Finishing,
}

impl Phase {
    pub fn as_str(self) -> &'static str {
        match self {
            Phase::Idle => "idle",
            Phase::Preparing => "preparing",
            Phase::Running => "running",
            Phase::Finishing => "finishing",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Outcome {
    pub turn_id: JsString,
    pub status: JsString,
    pub reason: Option<JsString>,
    pub at: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PendingOutcome {
    pub status: JsString,
    pub reason: Option<JsString>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Record {
    pub session_id: JsString,
    pub turn_id: Option<JsString>,
    pub phase: Phase,
    pub generation: f64,
    pub cli: Option<JsString>,
    pub transport: Option<JsString>,
    pub message_durable: bool,
    pub provider_route_resolved: bool,
    pub claimed_at: Option<f64>,
    pub started_at: Option<f64>,
    pub finishing_at: Option<f64>,
    pub last_outcome: Option<Outcome>,
    pub pending_outcome: Option<PendingOutcome>,
}

impl Record {
    /// `{ sessionId, phase: 'idle', turnId: null, generation, lastOutcome }`.
    pub fn idle(session_id: JsString, generation: f64, last_outcome: Option<Outcome>) -> Self {
        Self {
            session_id,
            turn_id: None,
            phase: Phase::Idle,
            generation,
            cli: None,
            transport: None,
            message_durable: false,
            provider_route_resolved: false,
            claimed_at: None,
            started_at: None,
            finishing_at: None,
            last_outcome,
            pending_outcome: None,
        }
    }

    /// The `current(sessionId)` default for a session that has no record.
    pub fn default_for(session_id: JsString) -> Self {
        Self::idle(session_id, 0.0, None)
    }

    pub fn owns_turn(&self, turn_id: &JsString) -> bool {
        self.turn_id.as_ref() == Some(turn_id)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    InvalidIdentity,
    TurnInFlight,
    StaleTurn,
    InvalidTransition,
}

impl Failure {
    pub fn code(self) -> &'static str {
        match self {
            Failure::InvalidIdentity => "invalid_identity",
            Failure::TurnInFlight => "turn_in_flight",
            Failure::StaleTurn => "stale_turn",
            Failure::InvalidTransition => "invalid_transition",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StartError {
    Transition(Failure),
    /// `spawn_proof_missing` — the frozen list order is durable-message first.
    Missing(Vec<&'static str>),
}

/// `match(sessionId, turnId, phases)` after the lookup.
pub fn match_phase(record: &Record, turn_id: &JsString, phases: &[Phase]) -> Result<(), Failure> {
    if record.turn_id.is_none() || !record.owns_turn(turn_id) {
        return Err(Failure::StaleTurn);
    }
    if !phases.contains(&record.phase) {
        return Err(Failure::InvalidTransition);
    }
    Ok(())
}

/// `claim`: the previous generation's `lastOutcome` survives into the new
/// preparation record; a non-idle phase is a hard veto.
pub fn claim(
    previous: &Record,
    session_id: JsString,
    turn_id: JsString,
    cli: JsString,
    transport: JsString,
    now: f64,
) -> Result<Record, Failure> {
    // `String(sessionId || '').trim()` — the frozen Node store trims both ids
    // before it looks at them, so the rule owns that step too.
    let session_id = session_id.trim();
    let turn_id = turn_id.trim();
    if session_id.is_empty() || turn_id.is_empty() {
        return Err(Failure::InvalidIdentity);
    }
    if previous.phase != Phase::Idle {
        return Err(Failure::TurnInFlight);
    }
    Ok(Record {
        session_id,
        turn_id: Some(turn_id),
        phase: Phase::Preparing,
        generation: previous.generation + 1.0,
        cli: Some(cli),
        transport: Some(transport),
        message_durable: false,
        provider_route_resolved: false,
        claimed_at: Some(now),
        started_at: None,
        finishing_at: None,
        last_outcome: previous.last_outcome.clone(),
        pending_outcome: None,
    })
}

pub fn mark_message_durable(record: &Record, turn_id: &JsString) -> Result<Record, Failure> {
    match_phase(record, turn_id, &[Phase::Preparing])?;
    let mut next = record.clone();
    next.message_durable = true;
    Ok(next)
}

pub fn mark_provider_route_resolved(
    record: &Record,
    turn_id: &JsString,
) -> Result<Record, Failure> {
    match_phase(record, turn_id, &[Phase::Preparing])?;
    let mut next = record.clone();
    next.provider_route_resolved = true;
    Ok(next)
}

pub fn start(record: &Record, turn_id: &JsString, now: f64) -> Result<Record, StartError> {
    match_phase(record, turn_id, &[Phase::Preparing]).map_err(StartError::Transition)?;
    let mut missing: Vec<&'static str> = Vec::new();
    if !record.message_durable {
        missing.push("durable-user-message");
    }
    if !record.provider_route_resolved {
        missing.push("provider-route");
    }
    if !missing.is_empty() {
        return Err(StartError::Missing(missing));
    }
    let mut next = record.clone();
    next.phase = Phase::Running;
    next.started_at = Some(now);
    Ok(next)
}

pub fn begin_cleanup(
    record: &Record,
    turn_id: &JsString,
    status: JsString,
    reason: Option<JsString>,
    now: f64,
) -> Result<Record, Failure> {
    match_phase(record, turn_id, &[Phase::Running])?;
    let mut next = record.clone();
    next.phase = Phase::Finishing;
    next.finishing_at = Some(now);
    next.pending_outcome = Some(PendingOutcome { status, reason });
    Ok(next)
}

pub fn cleanup(record: &Record, turn_id: &JsString, now: f64) -> Result<Record, Failure> {
    match_phase(record, turn_id, &[Phase::Finishing])?;
    let pending = record.pending_outcome.clone().unwrap_or(PendingOutcome {
        status: JsString::from_rust_str("completed"),
        reason: None,
    });
    Ok(Record::idle(
        record.session_id.clone(),
        record.generation,
        Some(Outcome {
            turn_id: turn_id.clone(),
            status: pending.status,
            reason: pending.reason,
            at: now,
        }),
    ))
}

pub fn settle(
    record: &Record,
    turn_id: &JsString,
    allowed: &[Phase],
    status: JsString,
    reason: Option<JsString>,
    now: f64,
) -> Result<Record, Failure> {
    match_phase(record, turn_id, allowed)?;
    Ok(Record::idle(
        record.session_id.clone(),
        record.generation,
        Some(Outcome {
            turn_id: turn_id.clone(),
            status,
            reason,
            at: now,
        }),
    ))
}

/// `claimProof().claimed`: the record still owns the named turn and is not idle.
pub fn claim_proof(record: &Record, turn_id: &JsString) -> bool {
    record.owns_turn(turn_id) && record.phase != Phase::Idle
}

/// Facts lifted from the host route-proof object. Values that the Node rule
/// only tested for truthiness stay booleans; the two integer fields keep the
/// number for the safe-integer test.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct RouteProofFacts {
    pub kind_provider_route: bool,
    pub resolved_true: bool,
    pub proof_frozen: bool,
    pub route_frozen: bool,
    pub session_matches: bool,
    pub turn_matches: bool,
    pub runtime_epoch: bool,
    pub decision_id: bool,
    pub route_attempt_id: bool,
    pub provider_id: bool,
    pub protocol: bool,
    pub model: bool,
    pub provider_revision: bool,
    pub route_generation: Option<f64>,
    pub attempt_no: Option<f64>,
}

/// `Number.isSafeInteger(v) && v > 0`.
pub fn positive_safe_integer(value: Option<f64>) -> bool {
    const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
    value.is_some_and(|value| {
        value.is_finite() && value.fract() == 0.0 && value.abs() <= MAX_SAFE && value > 0.0
    })
}

/// `ownsConcreteRouteProof(proof, sessionId, turnId)`.
pub fn owns_concrete_route_proof(facts: &RouteProofFacts) -> bool {
    facts.kind_provider_route
        && facts.resolved_true
        && facts.proof_frozen
        && facts.route_frozen
        && facts.session_matches
        && facts.turn_matches
        && facts.runtime_epoch
        && facts.decision_id
        && facts.route_attempt_id
        && facts.provider_id
        && facts.protocol
        && facts.model
        && facts.provider_revision
        && positive_safe_integer(facts.route_generation)
        && positive_safe_integer(facts.attempt_no)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(value: &str) -> JsString {
        JsString::from_rust_str(value)
    }

    fn claimed() -> Record {
        let previous = Record::default_for(s("s1"));
        claim(
            &previous,
            s("s1"),
            s("t1"),
            s("claude"),
            s("claude-stream"),
            10.0,
        )
        .unwrap()
    }

    #[test]
    fn claim_requires_idle_and_a_well_formed_identity() {
        let previous = Record::default_for(s("s1"));
        assert_eq!(
            claim(&previous, s(""), s("t1"), s("claude"), s("x"), 1.0),
            Err(Failure::InvalidIdentity)
        );
        assert_eq!(
            claim(&previous, s("s1"), s("  "), s("claude"), s("x"), 1.0),
            Err(Failure::InvalidIdentity)
        );
        let record = claimed();
        assert_eq!(record.phase, Phase::Preparing);
        assert_eq!(record.generation, 1.0);
        assert_eq!(
            claim(&record, s("s1"), s("t2"), s("claude"), s("x"), 2.0),
            Err(Failure::TurnInFlight)
        );
    }

    #[test]
    fn claim_carries_last_outcome_across_turns() {
        let record = claimed();
        let idle = settle(
            &record,
            &s("t1"),
            &[Phase::Preparing, Phase::Running],
            s("failed"),
            Some(s("boom")),
            20.0,
        )
        .unwrap();
        let next = claim(&idle, s("s1"), s("t2"), s("claude"), s("x"), 30.0).unwrap();
        assert_eq!(next.generation, 2.0);
        let carried = next.last_outcome.unwrap();
        assert_eq!(carried.turn_id, s("t1"));
        assert_eq!(carried.reason, Some(s("boom")));
    }

    #[test]
    fn start_orders_missing_proofs_and_requires_preparing() {
        let mut record = claimed();
        assert_eq!(
            start(&record, &s("t1"), 5.0),
            Err(StartError::Missing(vec![
                "durable-user-message",
                "provider-route"
            ]))
        );
        record = mark_message_durable(&record, &s("t1")).unwrap();
        assert_eq!(
            start(&record, &s("t1"), 5.0),
            Err(StartError::Missing(vec!["provider-route"]))
        );
        record = mark_provider_route_resolved(&record, &s("t1")).unwrap();
        let running = start(&record, &s("t1"), 5.0).unwrap();
        assert_eq!(running.phase, Phase::Running);
        assert_eq!(running.started_at, Some(5.0));
        assert_eq!(
            mark_message_durable(&running, &s("t1")),
            Err(Failure::InvalidTransition)
        );
    }

    #[test]
    fn stale_turn_wins_over_invalid_transition() {
        let record = claimed();
        assert_eq!(
            mark_message_durable(&record, &s("other")),
            Err(Failure::StaleTurn)
        );
        let idle = Record::default_for(s("s1"));
        assert_eq!(
            mark_message_durable(&idle, &s("t1")),
            Err(Failure::StaleTurn)
        );
    }

    #[test]
    fn cleanup_promotes_pending_outcome() {
        let mut record = claimed();
        record = mark_message_durable(&record, &s("t1")).unwrap();
        record = mark_provider_route_resolved(&record, &s("t1")).unwrap();
        record = start(&record, &s("t1"), 1.0).unwrap();
        let finishing = begin_cleanup(&record, &s("t1"), s("completed"), None, 2.0).unwrap();
        assert_eq!(finishing.phase, Phase::Finishing);
        assert_eq!(
            finishing.pending_outcome.as_ref().unwrap().status,
            s("completed")
        );
        let idle = cleanup(&finishing, &s("t1"), 3.0).unwrap();
        assert_eq!(idle.phase, Phase::Idle);
        assert_eq!(idle.turn_id, None);
        assert_eq!(idle.generation, 1.0);
        let outcome = idle.last_outcome.unwrap();
        assert_eq!(outcome.turn_id, s("t1"));
        assert_eq!(outcome.status, s("completed"));
        assert_eq!(outcome.reason, None);
        assert_eq!(outcome.at, 3.0);
    }

    #[test]
    fn claim_proof_needs_the_live_turn() {
        let record = claimed();
        assert!(claim_proof(&record, &s("t1")));
        assert!(!claim_proof(&record, &s("t2")));
        assert!(!claim_proof(&Record::default_for(s("s1")), &s("t1")));
    }

    #[test]
    fn route_proof_facts_require_every_identity_field() {
        let mut facts = RouteProofFacts {
            kind_provider_route: true,
            resolved_true: true,
            proof_frozen: true,
            route_frozen: true,
            session_matches: true,
            turn_matches: true,
            runtime_epoch: true,
            decision_id: true,
            route_attempt_id: true,
            provider_id: true,
            protocol: true,
            model: true,
            provider_revision: true,
            route_generation: Some(1.0),
            attempt_no: Some(1.0),
        };
        assert!(owns_concrete_route_proof(&facts));
        for field in [
            |facts: &mut RouteProofFacts| facts.kind_provider_route = false,
            |facts: &mut RouteProofFacts| facts.resolved_true = false,
            |facts: &mut RouteProofFacts| facts.proof_frozen = false,
            |facts: &mut RouteProofFacts| facts.route_frozen = false,
            |facts: &mut RouteProofFacts| facts.session_matches = false,
            |facts: &mut RouteProofFacts| facts.turn_matches = false,
            |facts: &mut RouteProofFacts| facts.runtime_epoch = false,
            |facts: &mut RouteProofFacts| facts.decision_id = false,
            |facts: &mut RouteProofFacts| facts.route_attempt_id = false,
            |facts: &mut RouteProofFacts| facts.provider_id = false,
            |facts: &mut RouteProofFacts| facts.protocol = false,
            |facts: &mut RouteProofFacts| facts.model = false,
            |facts: &mut RouteProofFacts| facts.provider_revision = false,
        ] {
            let mut broken = facts;
            field(&mut broken);
            assert!(!owns_concrete_route_proof(&broken));
        }
        facts.route_generation = Some(0.0);
        assert!(!owns_concrete_route_proof(&facts));
        facts.route_generation = Some(1.5);
        assert!(!owns_concrete_route_proof(&facts));
        facts.route_generation = Some(9_007_199_254_740_992.0);
        assert!(!owns_concrete_route_proof(&facts));
        facts.route_generation = Some(f64::NAN);
        assert!(!owns_concrete_route_proof(&facts));
        facts.route_generation = Some(1.0);
        facts.attempt_no = None;
        assert!(!owns_concrete_route_proof(&facts));
    }
}
