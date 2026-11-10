//! Turn timing recorder kernel (migrated from `src/chat/turn-timing.js`).
//!
//! Four lifecycle instants per turn (received / spawned / sent / first byte),
//! keyed by `<session>\0<turnId || ''>`. A turn logs at most one line: the
//! `[turn-timing]` success line when the first byte lands, or one
//! `[turn-timing-abort]` line if it ends before that. The kernel owns the
//! records and decides the emit plan; the facade formats the ISO timestamps
//! (`new Date(value).toISOString()`, which still throws `RangeError` for an
//! invalid clock) and writes the line.
//!
//! Fixed bug (intentional divergence): the legacy `turnTimingsField` computed
//! `t1 - t0` etc. without the recorder summary's null guards, so a missing t1
//! or t2 coerced to 0 and reported nonsense spawn/send deltas. [`Timing::field`]
//! reports `null` for a delta whose endpoints are unknown.
use crate::background::state::OrderedMap;
use crate::js::coerce::{js_to_number, js_to_string, truthy};
use crate::js::JsString;
use crate::js::JsValue;

pub const MAX_RECORDS: usize = 512;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Instant {
    Spawned,
    Sent,
    FirstByte,
}

/// One turn record. Instants are raw JS values: `Number.isFinite(ts) ? ts :
/// now()` stores the clock result as-is, so an exotic injected clock can put a
/// non-number there. All arithmetic goes through `Number()`.
#[derive(Clone, Debug, PartialEq)]
pub struct Record {
    pub session: JsValue,
    pub turn: JsValue,
    pub cli: JsValue,
    pub t0: JsValue,
    pub t1: Option<JsValue>,
    pub t2: Option<JsValue>,
    pub t3: Option<JsValue>,
    pub logged: bool,
}

/// The `turnTimings` field persisted on the user event. Same shape as the
/// legacy `turnTimingsField` return value, with the bug-5 null guards.
#[derive(Clone, Debug, PartialEq)]
pub struct Timings {
    pub t0: JsValue,
    pub t1: Option<JsValue>,
    pub t2: Option<JsValue>,
    pub t3: Option<JsValue>,
    pub spawn_ms: Option<f64>,
    pub send_ms: Option<f64>,
    pub first_byte_ms: Option<f64>,
    pub total_ms: Option<f64>,
}

/// Everything the facade needs to format one log line. `reason` is present only
/// for the abort line; its position in the formatted object differs (legacy
/// puts `reason` first, before the summary spread).
#[derive(Clone, Debug, PartialEq)]
pub struct LogPlan {
    pub reason: Option<JsString>,
    pub session: JsValue,
    pub turn: JsValue,
    pub cli: JsValue,
    pub t0: JsValue,
    pub t1: Option<JsValue>,
    pub t2: Option<JsValue>,
    pub t3: Option<JsValue>,
    pub spawn_ms: Option<f64>,
    pub send_ms: Option<f64>,
    pub first_byte_ms: Option<f64>,
    pub total_ms: Option<f64>,
}

/// `Number.isFinite(value)` for a JS number, `false` for everything else.
pub fn finite_number(value: Option<&JsValue>) -> Option<f64> {
    match value {
        Some(JsValue::Number(number)) if number.is_finite() => Some(*number),
        _ => None,
    }
}

fn value_number(value: &JsValue) -> f64 {
    js_to_number(value)
}

/// `${sessionId}\u0000${turnId || ''}`. The template literal stringifies a
/// non-nullish id; a falsy turn contributes nothing.
pub fn key(session: &JsValue, turn: Option<&JsValue>) -> JsString {
    let mut out = js_to_string(session);
    out.push_unit(0);
    if let Some(turn) = turn.filter(|turn| truthy(turn)) {
        out.push(&js_to_string(turn));
    }
    out
}

fn deltas(record: &Record) -> (Option<f64>, Option<f64>, Option<f64>, Option<f64>) {
    let spawn = record
        .t1
        .as_ref()
        .map(|t1| value_number(t1) - value_number(&record.t0));
    let send = match (record.t2.as_ref(), record.t1.as_ref()) {
        (Some(t2), Some(t1)) => Some(value_number(t2) - value_number(t1)),
        _ => None,
    };
    let first_byte = match (record.t3.as_ref(), record.t2.as_ref()) {
        (Some(t3), Some(t2)) => Some(value_number(t3) - value_number(t2)),
        _ => None,
    };
    let total = record
        .t3
        .as_ref()
        .map(|t3| value_number(t3) - value_number(&record.t0));
    (spawn, send, first_byte, total)
}

fn log_plan(record: &Record, reason: Option<JsString>) -> LogPlan {
    let (spawn, send, first_byte, total) = deltas(record);
    LogPlan {
        reason,
        session: record.session.clone(),
        turn: record.turn.clone(),
        cli: record.cli.clone(),
        t0: record.t0.clone(),
        t1: record.t1.clone(),
        t2: record.t2.clone(),
        t3: record.t3.clone(),
        spawn_ms: spawn,
        send_ms: send,
        first_byte_ms: first_byte,
        total_ms: total,
    }
}

pub struct Timing {
    records: OrderedMap<Record>,
}

impl Timing {
    pub fn new() -> Self {
        Self {
            records: OrderedMap::new(),
        }
    }

    pub fn len(&self) -> usize {
        self.records.len()
    }

    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }

    /// Bounded growth: evict the oldest already-LOGGED record (at most one).
    /// Runs before the clock is read.
    pub fn evict_logged(&mut self) {
        if self.records.len() < MAX_RECORDS {
            return;
        }
        let victim = self
            .records
            .iter()
            .find(|(_, record)| record.logged)
            .map(|(key, _)| key.clone());
        if let Some(victim) = victim {
            self.records.delete(&victim);
        }
    }

    /// `begin` after the caller has validated both ids, run eviction and
    /// resolved `t0`. A re-begin of an existing key replaces the record but
    /// keeps its position. `cli` is already `cli || null`.
    pub fn begin(
        &mut self,
        session: &JsValue,
        turn: &JsValue,
        t0: JsValue,
        cli: JsValue,
    ) -> Record {
        let record = Record {
            session: session.clone(),
            turn: turn.clone(),
            cli,
            t0,
            t1: None,
            t2: None,
            t3: None,
            logged: false,
        };
        self.records.set(key(session, Some(turn)), record.clone());
        record
    }

    pub fn find(&self, session: &JsValue, turn: Option<&JsValue>) -> Option<JsString> {
        let candidate = key(session, turn);
        self.records.contains_key(&candidate).then_some(candidate)
    }

    pub fn get(&self, session: &JsValue, turn: Option<&JsValue>) -> Option<&Record> {
        self.records.get(&key(session, turn))
    }

    /// True when the record already emitted its one log line.
    pub fn logged(&self, found: &JsString) -> bool {
        self.records.get(found).is_some_and(|record| record.logged)
    }

    /// True when the record exists and `instant` has not been stamped yet
    /// ("first mark wins"). No clock read here.
    pub fn instant_is_empty(&self, found: &JsString, instant: Instant) -> bool {
        match self.records.get(found) {
            Some(record) => match instant {
                Instant::Spawned => record.t1.is_none(),
                Instant::Sent => record.t2.is_none(),
                Instant::FirstByte => record.t3.is_none(),
            },
            None => false,
        }
    }

    /// Stamp one instant; the first stamp wins. `None` when the record is gone
    /// or the instant was already set.
    pub fn set_instant(
        &mut self,
        found: &JsString,
        instant: Instant,
        ts: JsValue,
    ) -> Option<Record> {
        let record = self.records.get_mut(found)?;
        let slot = match instant {
            Instant::Spawned => &mut record.t1,
            Instant::Sent => &mut record.t2,
            Instant::FirstByte => &mut record.t3,
        };
        if slot.is_some() {
            return None;
        }
        *slot = Some(ts);
        Some(record.clone())
    }

    /// First byte counts once. When the success line has not been emitted yet,
    /// marks it logged and returns the plan the facade formats and emits.
    pub fn mark_first_byte(
        &mut self,
        found: &JsString,
        ts: JsValue,
    ) -> Option<(Record, Option<LogPlan>)> {
        let record = self.records.get_mut(found)?;
        if record.t3.is_some() {
            return None;
        }
        record.t3 = Some(ts);
        if record.logged {
            return Some((record.clone(), None));
        }
        record.logged = true;
        Some((record.clone(), Some(log_plan(record, None))))
    }

    /// One abort line when the turn ended before the first byte. `reason` is
    /// already `String(reason || 'unknown')`.
    pub fn abort(&mut self, found: &JsString, reason: JsString) -> Option<(Record, LogPlan)> {
        let record = self.records.get_mut(found)?;
        if record.logged {
            return None;
        }
        record.logged = true;
        Some((record.clone(), log_plan(record, Some(reason))))
    }

    pub fn drop(&mut self, session: &JsValue, turn: Option<&JsValue>) -> bool {
        self.records.delete(&key(session, turn)).is_some()
    }

    /// The persisted timing field; `None` while t3 is unknown (the legacy
    /// function returns `undefined` for a missing or unfinished record).
    pub fn field(&self, session: &JsValue, turn: Option<&JsValue>) -> Option<Timings> {
        let record = self.records.get(&key(session, turn))?;
        let t3 = record.t3.clone()?;
        let (spawn_ms, send_ms, first_byte_ms, total_ms) = deltas(record);
        Some(Timings {
            t0: record.t0.clone(),
            t1: record.t1.clone(),
            t2: record.t2.clone(),
            t3: Some(t3),
            spawn_ms,
            send_ms,
            first_byte_ms,
            total_ms,
        })
    }

    /// `String(reason || 'unknown')`.
    pub fn abort_reason(reason: Option<&JsValue>) -> JsString {
        match reason.filter(|reason| truthy(reason)) {
            Some(reason) => js_to_string(reason),
            None => JsString::from_rust_str("unknown"),
        }
    }
}

impl Default for Timing {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(value: &str) -> JsValue {
        JsValue::String(JsString::from_rust_str(value))
    }

    fn key_of(session: &str, turn: &str) -> JsString {
        key(&text(session), Some(&text(turn)))
    }

    #[test]
    fn key_matches_the_legacy_template() {
        assert_eq!(
            key_of("sess", "turn_1"),
            JsString::from_rust_str("sess\0turn_1")
        );
        assert_eq!(
            key(&text("s"), None),
            JsString::from_rust_str("s\0"),
            "a missing turn contributes an empty tail"
        );
        assert_eq!(
            key(&text("s"), Some(&JsValue::Number(0.0))),
            JsString::from_rust_str("s\0"),
            "a falsy turn contributes an empty tail"
        );
        assert_eq!(
            key(&text("s"), Some(&text("t"))).len(),
            "s\0t".len(),
            "no trimming and no length prefix"
        );
    }

    #[test]
    fn summary_guards_every_missing_endpoint() {
        let mut timing = Timing::new();
        timing.begin(
            &text("s"),
            &text("t"),
            JsValue::Number(100.0),
            JsValue::Null,
        );
        assert_eq!(timing.field(&text("s"), Some(&text("t"))), None);
        let found = timing.find(&text("s"), Some(&text("t"))).unwrap();
        timing.set_instant(&found, Instant::FirstByte, JsValue::Number(190.0));
        // Fixed bug: without t1/t2 the legacy field reported -100/-190/90.
        let field = timing.field(&text("s"), Some(&text("t"))).unwrap();
        assert_eq!(field.spawn_ms, None);
        assert_eq!(field.send_ms, None);
        assert_eq!(field.first_byte_ms, None);
        assert_eq!(field.total_ms, Some(90.0));
    }

    #[test]
    fn first_mark_wins_and_first_byte_counts_once() {
        let mut timing = Timing::new();
        timing.begin(&text("s"), &text("t"), JsValue::Number(0.0), JsValue::Null);
        let found = timing.find(&text("s"), Some(&text("t"))).unwrap();
        assert!(timing.instant_is_empty(&found, Instant::Spawned));
        assert!(timing
            .set_instant(&found, Instant::Spawned, JsValue::Number(10.0))
            .is_some());
        assert!(!timing.instant_is_empty(&found, Instant::Spawned));
        assert!(timing
            .set_instant(&found, Instant::Spawned, JsValue::Number(99.0))
            .is_none());
        let (_, plan) = timing
            .mark_first_byte(&found, JsValue::Number(50.0))
            .expect("first byte");
        assert!(plan.is_some());
        assert!(
            timing
                .mark_first_byte(&found, JsValue::Number(60.0))
                .is_none(),
            "the first byte counts once; a second call returns null"
        );
        let record = timing.get(&text("s"), Some(&text("t"))).unwrap();
        assert_eq!(
            (record.t1.clone(), record.t3.clone()),
            (Some(JsValue::Number(10.0)), Some(JsValue::Number(50.0)))
        );
        assert!(record.logged);
    }

    #[test]
    fn abort_is_silent_after_logging_and_keeps_reason_coercion() {
        let mut timing = Timing::new();
        timing.begin(&text("s"), &text("t"), JsValue::Number(0.0), JsValue::Null);
        let found = timing.find(&text("s"), Some(&text("t"))).unwrap();
        assert_eq!(
            Timing::abort_reason(Some(&JsValue::Bool(false))),
            JsString::from_rust_str("unknown")
        );
        assert_eq!(
            Timing::abort_reason(Some(&JsValue::Number(7.0))),
            JsString::from_rust_str("7")
        );
        let (_, plan) = timing
            .abort(&found, Timing::abort_reason(Some(&text("closed"))))
            .expect("abort plan");
        assert_eq!(plan.reason, Some(JsString::from_rust_str("closed")));
        assert!(timing.abort(&found, Timing::abort_reason(None)).is_none());
        let (_, plan) = timing
            .mark_first_byte(&found, JsValue::Number(5.0))
            .expect("t3");
        assert!(plan.is_none(), "already logged by the abort line");
        assert_eq!(
            timing.get(&text("s"), Some(&text("t"))).unwrap().t3,
            Some(JsValue::Number(5.0))
        );
    }

    #[test]
    fn eviction_removes_only_the_oldest_logged_record() {
        let mut timing = Timing::new();
        for index in 0..MAX_RECORDS {
            timing.begin(
                &text("s"),
                &text(&format!("t{index}")),
                JsValue::Number(index as f64),
                JsValue::Null,
            );
        }
        let first = key_of("s", "t0");
        let second = key_of("s", "t1");
        timing.set_instant(&first, Instant::FirstByte, JsValue::Number(1.0));
        timing.records.get_mut(&first).unwrap().logged = false;
        timing.evict_logged();
        assert_eq!(timing.len(), MAX_RECORDS, "no logged record to evict yet");
        timing.records.get_mut(&second).unwrap().logged = true;
        timing.evict_logged();
        assert_eq!(timing.len(), MAX_RECORDS - 1);
        assert!(!timing.records.contains_key(&second));
        assert!(timing.records.contains_key(&first));
        // Re-begin keeps the position of an existing key.
        let before: Vec<JsString> = timing.records.keys().cloned().collect();
        timing.begin(&text("s"), &text("t2"), JsValue::Number(0.0), JsValue::Null);
        let after: Vec<JsString> = timing.records.keys().cloned().collect();
        assert_eq!(before, after);
    }

    #[test]
    fn drop_and_lookup_by_missing_ids() {
        let mut timing = Timing::new();
        timing.begin(&text("s"), &text("t"), JsValue::Number(0.0), JsValue::Null);
        assert!(timing.get(&text("s"), Some(&JsValue::Null)).is_none());
        assert!(timing.drop(&text("s"), Some(&text("t"))));
        assert!(!timing.drop(&text("s"), Some(&text("t"))));
        assert_eq!(timing.len(), 0);
    }

    #[test]
    fn deltas_coerce_non_number_instants_like_js_subtraction() {
        let mut timing = Timing::new();
        timing.begin(&text("s"), &text("t"), text("100"), JsValue::Null);
        let found = timing.find(&text("s"), Some(&text("t"))).unwrap();
        timing.set_instant(&found, Instant::Spawned, JsValue::Number(150.0));
        timing.set_instant(&found, Instant::Sent, JsValue::Number(175.0));
        timing.set_instant(&found, Instant::FirstByte, text("200"));
        let field = timing.field(&text("s"), Some(&text("t"))).unwrap();
        assert_eq!(
            (
                field.spawn_ms,
                field.send_ms,
                field.first_byte_ms,
                field.total_ms
            ),
            (Some(50.0), Some(25.0), Some(25.0), Some(100.0))
        );
    }
}
