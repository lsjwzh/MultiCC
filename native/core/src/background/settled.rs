//! Durable "this task's completion nudge already went out" set.
//!
//! The Claude Code CLI re-reads the previous transcript on every start and, when
//! it finds no completion record for a background agent, emits the
//! `task_notification` / `status: stopped` system event again. An agent that
//! died without writing that record (a provider 409, a killed process) never
//! gets one, so the CLI replays the same notification for as long as the session
//! exists — hours or days apart, once per start.
//!
//! None of the pre-existing guards can see that:
//!
//!   * the dedup window is minutes, the replay gap is hours;
//!   * `MetaStore::finish` drops the entry before the completion is handled, so
//!     the stale-run gate lets the next one through;
//!   * a replay has no preceding `task_started`, so there is no `owned` row to
//!     carry a `delivered` flag.
//!
//! Hence this set, which answers one question — has a completion nudge for this
//! `(sessionId, taskId)` already been handed to the coalescer? — and survives a
//! restart, because the replay happens *after* one. Terminal-ness itself is not
//! re-invented here: callers pass a status that already went through the
//! ledger's vocabulary ([`crate::orchestration_store::TERMINAL_TASK_STATES`]).
//!
//! The payload is a flat, insertion-ordered array so that eviction is FIFO and
//! the file stays readable:
//!
//! ```json
//! {"entries":[{"session":"task-88a9","task":"a55bb899","at":1763200000000}]}
//! ```
//!
//! Eviction only ever risks one extra nudge for a task old enough to have been
//! pushed out, which is strictly better than the unbounded growth of a set that
//! is written on the chat event path.
use super::state::OrderedMap;
use crate::js::{JsString, JsValue};
use crate::orchestration_store::is_terminal_task_status;

/// How many `(session, task)` pairs stay remembered. One entry is ~70 bytes of
/// JSON, so the whole file is well under 64 KiB at the cap; the write happens
/// once per background task (on its first completion), not once per event.
pub const DEFAULT_CAP: usize = 512;

/// `TERMINAL_TASK_STATES.has(status)`, re-exported so the napi owner does not
/// need to reach into the ledger module for the gate's second condition.
pub fn is_terminal(status: &str) -> bool {
    is_terminal_task_status(status)
}

#[derive(Clone, Debug)]
pub struct SettledNudges {
    cap: usize,
    /// session → task → delivered-at. Insertion order is eviction order.
    entries: OrderedMap<OrderedMap<f64>>,
}

impl Default for SettledNudges {
    fn default() -> Self {
        Self::with_cap(DEFAULT_CAP)
    }
}

impl SettledNudges {
    pub fn with_cap(cap: usize) -> Self {
        Self {
            cap: cap.max(1),
            entries: OrderedMap::new(),
        }
    }

    /// Total remembered pairs, across sessions.
    pub fn len(&self) -> usize {
        self.entries.values().map(|tasks| tasks.len()).sum()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Has a completion nudge for this pair already been delivered?
    pub fn is_settled(&self, session: &JsString, task: &JsString) -> bool {
        self.entries
            .get(session)
            .is_some_and(|tasks| tasks.contains_key(task))
    }

    /// Remember a delivered nudge. Returns `true` when the set changed, which is
    /// the caller's signal to persist; a repeat delivery keeps the original
    /// timestamp so the FIFO position (and therefore eviction order) is stable.
    pub fn record(&mut self, session: &JsString, task: &JsString, at: f64) -> bool {
        if self.is_settled(session, task) {
            return false;
        }
        if self.entries.get(session).is_none() {
            self.entries.set(session.clone(), OrderedMap::new());
        }
        self.entries
            .get_mut(session)
            .expect("session bucket just inserted")
            .set(task.clone(), at);
        self.evict();
        true
    }

    /// Forget one pair: a genuine re-run of the same task id must nudge again.
    pub fn forget(&mut self, session: &JsString, task: &JsString) -> bool {
        let Some(tasks) = self.entries.get_mut(session) else {
            return false;
        };
        if tasks.delete(task).is_none() {
            return false;
        }
        if tasks.is_empty() {
            self.entries.delete(session);
        }
        true
    }

    /// Forget a whole session (its chat history and task ids are gone with it).
    pub fn forget_session(&mut self, session: &JsString) -> bool {
        self.entries.delete(session).is_some()
    }

    /// Drop the oldest pairs until the cap holds.
    fn evict(&mut self) {
        while self.len() > self.cap {
            // Resolve both keys before touching the map: the oldest session
            // bucket, then its oldest task.
            let Some(session) = self.entries.keys().next().cloned() else {
                return;
            };
            let oldest = self
                .entries
                .get(&session)
                .and_then(|tasks| tasks.keys().next().cloned());
            let emptied = match oldest {
                Some(task) => match self.entries.get_mut(&session) {
                    Some(tasks) => {
                        tasks.delete(&task);
                        tasks.is_empty()
                    }
                    None => true,
                },
                None => true,
            };
            if emptied {
                self.entries.delete(&session);
            }
        }
    }

    /// The persisted document (see the module docs for the shape).
    pub fn to_value(&self) -> JsValue {
        let mut rows = Vec::new();
        for (session, tasks) in self.entries.iter() {
            for (task, at) in tasks.iter() {
                rows.push(JsValue::object(vec![
                    ("session", JsValue::String(session.clone())),
                    ("task", JsValue::String(task.clone())),
                    ("at", JsValue::Number(*at)),
                ]));
            }
        }
        JsValue::object(vec![("entries", JsValue::Array(rows))])
    }

    /// Rebuild from a persisted document. Unreadable rows are skipped rather
    /// than failing the load: a corrupt entry must not cost the user their whole
    /// replay memory, and the worst case of dropping one is a single extra
    /// nudge.
    pub fn from_value(value: &JsValue, cap: usize) -> Self {
        let mut set = Self::with_cap(cap);
        let Some(JsValue::Array(rows)) = value.get("entries") else {
            return set;
        };
        for row in rows {
            let (Some(JsValue::String(session)), Some(JsValue::String(task))) =
                (row.get("session"), row.get("task"))
            else {
                continue;
            };
            if session.is_empty() || task.is_empty() {
                continue;
            }
            let at = match row.get("at") {
                Some(JsValue::Number(at)) if at.is_finite() => *at,
                _ => 0.0,
            };
            set.record(session, task, at);
        }
        set
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(text: &str) -> JsString {
        JsString::from_rust_str(text)
    }

    #[test]
    fn a_replayed_completion_is_settled_only_after_the_first_delivery() {
        let mut set = SettledNudges::default();
        let (session, task) = (s("task-88a9"), s("a55bb899"));
        // The first stopped notification must still reach the user: nothing has
        // been delivered yet.
        assert!(!set.is_settled(&session, &task));
        assert!(set.record(&session, &task, 10.0));
        // Every later replay of the same notification is already settled.
        assert!(set.is_settled(&session, &task));
        // A repeat delivery neither changes the set nor asks for a write.
        assert!(!set.record(&session, &task, 99.0));
        assert_eq!(set.len(), 1);
    }

    #[test]
    fn the_set_is_keyed_by_session_and_task_together() {
        let mut set = SettledNudges::default();
        set.record(&s("s1"), &s("t1"), 1.0);
        assert!(!set.is_settled(&s("s2"), &s("t1")));
        assert!(!set.is_settled(&s("s1"), &s("t2")));
        assert!(set.is_settled(&s("s1"), &s("t1")));
    }

    #[test]
    fn a_rerun_of_the_same_task_id_nudges_again() {
        let mut set = SettledNudges::default();
        let (session, task) = (s("s1"), s("t1"));
        set.record(&session, &task, 1.0);
        // `task_started` for the same id means a new run: the old delivery must
        // not silence it.
        assert!(set.forget(&session, &task));
        assert!(!set.is_settled(&session, &task));
        assert!(!set.forget(&session, &task), "forgetting twice is a no-op");
    }

    #[test]
    fn forgetting_a_session_drops_all_of_its_tasks() {
        let mut set = SettledNudges::default();
        set.record(&s("s1"), &s("t1"), 1.0);
        set.record(&s("s1"), &s("t2"), 2.0);
        set.record(&s("s2"), &s("t1"), 3.0);
        assert!(set.forget_session(&s("s1")));
        assert_eq!(set.len(), 1);
        assert!(set.is_settled(&s("s2"), &s("t1")));
        assert!(!set.forget_session(&s("s1")));
    }

    #[test]
    fn a_restart_reloads_the_same_decisions() {
        let mut set = SettledNudges::default();
        set.record(&s("task-88a9"), &s("a55bb899"), 10.0);
        set.record(&s("task-88a9"), &s("a7e730ac"), 11.0);
        // This is the restart: only the persisted document crosses over.
        let reloaded = SettledNudges::from_value(&set.to_value(), DEFAULT_CAP);
        assert_eq!(reloaded.len(), 2);
        assert!(reloaded.is_settled(&s("task-88a9"), &s("a55bb899")));
        assert!(reloaded.is_settled(&s("task-88a9"), &s("a7e730ac")));
        assert!(!reloaded.is_settled(&s("task-88a9"), &s("other")));
    }

    #[test]
    fn eviction_is_fifo_and_bounded() {
        let mut set = SettledNudges::with_cap(2);
        set.record(&s("s1"), &s("t1"), 1.0);
        set.record(&s("s1"), &s("t2"), 2.0);
        set.record(&s("s1"), &s("t3"), 3.0);
        assert_eq!(set.len(), 2);
        assert!(!set.is_settled(&s("s1"), &s("t1")), "oldest pair evicted");
        assert!(set.is_settled(&s("s1"), &s("t3")));
    }

    #[test]
    fn eviction_drops_an_emptied_session_bucket() {
        let mut set = SettledNudges::with_cap(1);
        set.record(&s("s1"), &s("t1"), 1.0);
        set.record(&s("s2"), &s("t2"), 2.0);
        assert_eq!(set.len(), 1);
        assert!(!set.is_settled(&s("s1"), &s("t1")));
        // The emptied bucket must not linger, or the document keeps growing.
        assert_eq!(
            set.to_value().get("entries").map(|rows| match rows {
                JsValue::Array(rows) => rows.len(),
                _ => usize::MAX,
            }),
            Some(1)
        );
    }

    #[test]
    fn a_corrupt_document_loads_what_it_can() {
        let document = JsValue::object(vec![(
            "entries",
            JsValue::Array(vec![
                JsValue::object(vec![
                    ("session", JsValue::String(s("s1"))),
                    ("task", JsValue::String(s("t1"))),
                    ("at", JsValue::Number(5.0)),
                ]),
                JsValue::Number(7.0),
                JsValue::object(vec![("session", JsValue::String(s("s2")))]),
                JsValue::object(vec![
                    ("session", JsValue::String(s(""))),
                    ("task", JsValue::String(s("t9"))),
                ]),
                JsValue::object(vec![
                    ("session", JsValue::String(s("s3"))),
                    ("task", JsValue::String(s("t3"))),
                    ("at", JsValue::String(s("nope"))),
                ]),
            ]),
        )]);
        let set = SettledNudges::from_value(&document, DEFAULT_CAP);
        assert_eq!(set.len(), 2);
        assert!(set.is_settled(&s("s1"), &s("t1")));
        assert!(
            set.is_settled(&s("s3"), &s("t3")),
            "a bad `at` still counts"
        );
    }

    #[test]
    fn an_empty_or_foreign_document_is_an_empty_set() {
        assert!(SettledNudges::from_value(&JsValue::Null, DEFAULT_CAP).is_empty());
        assert!(SettledNudges::from_value(&JsValue::Array(vec![]), DEFAULT_CAP).is_empty());
        assert!(SettledNudges::from_value(
            &JsValue::object(vec![("entries", JsValue::Number(1.0))]),
            DEFAULT_CAP
        )
        .is_empty());
    }

    #[test]
    fn the_gate_reuses_the_ledger_terminal_vocabulary() {
        for status in ["completed", "failed", "interrupted", "cancelled"] {
            assert!(is_terminal(status), "{status} is a ledger terminal state");
        }
        for status in ["running", "queued", "stopped", ""] {
            assert!(
                !is_terminal(status),
                "{status} is not terminal in the ledger"
            );
        }
    }
}
