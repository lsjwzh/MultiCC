//! Pure rules for the live session-record table and its task-state store.
//! Table membership, host values and file I/O live in the addon owner; this
//! module holds the decisions that must not drift from the previous Node
//! implementation, so they can be unit-tested without an engine.
use crate::js::JsValue;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionDirectory {
    Home,
    Aux,
    Gateway,
    Login,
    Worktree,
    Unavailable,
}

/// Decide where an existing session runs. An unavailable worktree must never
/// silently execute in the base repository or the user's home directory.
pub fn session_directory<E>(
    present: bool,
    session_type: &str,
    workspace_state: &str,
    login_cwd_exists: impl FnOnce() -> Result<bool, E>,
    worktree_exists: impl FnOnce() -> Result<bool, E>,
) -> Result<SessionDirectory, E> {
    if !present {
        return Ok(SessionDirectory::Home);
    }
    Ok(match session_type {
        "aux" => SessionDirectory::Aux,
        "gateway" => SessionDirectory::Gateway,
        _ if login_cwd_exists()? => SessionDirectory::Login,
        _ if !matches!(
            workspace_state,
            "planned" | "hibernating" | "hibernated" | "thawing"
        ) && worktree_exists()? =>
        {
            SessionDirectory::Worktree
        }
        _ => SessionDirectory::Unavailable,
    })
}

pub fn unavailable_workspace_stem(id: &crate::js::JsString) -> String {
    id.as_units()
        .iter()
        .map(|&unit| match u8::try_from(unit) {
            Ok(byte) if byte.is_ascii_alphanumeric() || b"._-".contains(&byte) => char::from(byte),
            _ => '-',
        })
        .collect()
}

/// the task-state store’s `TASK_STATE_DEFAULTS`, in declaration order
/// (`{ ...DEFAULTS, ...ts }` preserves this order for keys the record omits).
pub fn task_state_defaults() -> JsValue {
    let null = JsValue::Null;
    JsValue::object(vec![
        ("goal", JsValue::string("")),
        ("taskId", null.clone()),
        ("phase", JsValue::string("idle")),
        ("startedAt", null.clone()),
        ("endedAt", null.clone()),
        ("lastSummary", JsValue::string("")),
        ("lastSummaryAt", null.clone()),
        ("lastTurnEndedAt", null.clone()),
        ("classifyState", null.clone()),
        ("goalState", null.clone()),
        ("pendingDispatches", JsValue::Array(vec![])),
        ("classifyHistory", JsValue::Array(vec![])),
        ("pendingUserInput", null.clone()),
        ("userInputSignalVersion", JsValue::Number(0.0)),
        ("userInputSignalTurnId", null.clone()),
        ("apiError", null.clone()),
        ("classifyUpdatedAt", null.clone()),
        ("cancelledAt", null.clone()),
        ("cancelReason", null.clone()),
        ("cancelSource", null.clone()),
        ("cancelOperationId", null),
    ])
}

/// `classifyUpdatedAt` is stamped only when the patch itself owns
/// `classifyState`, the letter actually changes, and the caller did not pass an
/// explicit stamp. `classifyState` is a letter or null, so value equality is
/// the same question as JS `!==` there (NaN is not a legal letter, but keeps
/// the same "changes" answer).
pub fn should_stamp_classify_updated_at(
    patch_owns_classify_state: bool,
    classify_state_changed: bool,
    patch_owns_updated_at: bool,
) -> bool {
    patch_owns_classify_state && classify_state_changed && !patch_owns_updated_at
}

/// `new Date().toISOString()` at millisecond precision (UTC, trailing `Z`).
pub fn iso_timestamp_now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// `entry.at > cutoff` for the 7-day classify-history window. A missing or
/// non-numeric `at` becomes NaN and is dropped, exactly as the relational
/// operator did.
pub fn keep_history_entry(at: Option<f64>, cutoff: f64) -> bool {
    at.is_some_and(|at| at > cutoff)
}

/// Dirty/retry/transaction counters shared by `mutate`, `begin` and
/// `bestEffort`. The timer handle and callbacks stay with the host.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct RetryState {
    pub dirty: bool,
    pub attempt: u32,
    pub mutating: bool,
}

impl RetryState {
    /// `scheduleRetry` returns early when one timer is already pending or the
    /// bound is exhausted.
    pub fn can_schedule(&self, timer_pending: bool, max_retries: u32) -> bool {
        !timer_pending && self.attempt < max_retries
    }

    /// A retry timer fired: the attempt is counted before the save.
    pub fn begin_attempt(&mut self) {
        self.attempt += 1;
    }

    /// A successful save clears the dirty flag, the failure envelope and the
    /// retry counter, and cancels any pending timer.
    pub fn mark_clean(&mut self) {
        self.dirty = false;
        self.attempt = 0;
    }

    /// A failed best-effort save keeps the in-memory change.
    pub fn mark_dirty(&mut self) {
        self.dirty = true;
    }

    /// `stop()` clears the timer but keeps the attempt counter, as before.
    pub fn stop(&mut self) {
        self.mutating = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_directory_probes_only_eligible_paths() {
        let missing = || Ok::<_, std::convert::Infallible>(false);
        let found = || Ok(true);
        let unexpected = || panic!("unexpected workspace probe");
        assert_eq!(
            session_directory(true, "gateway", "awake", unexpected, unexpected).unwrap(),
            SessionDirectory::Gateway
        );
        assert_eq!(
            session_directory(true, "", "hibernated", missing, unexpected).unwrap(),
            SessionDirectory::Unavailable
        );
        assert_eq!(
            session_directory(true, "", "planned", found, unexpected).unwrap(),
            SessionDirectory::Login
        );
        assert_eq!(
            session_directory(true, "", "legacy", missing, found).unwrap(),
            SessionDirectory::Worktree
        );
    }

    fn keys(value: &JsValue) -> Vec<String> {
        match value {
            JsValue::Object(entries) => entries
                .iter()
                .map(|(key, _)| key.to_string_lossy())
                .collect(),
            other => panic!("not an object: {other:?}"),
        }
    }

    #[test]
    fn defaults_keep_the_wire_key_order_and_values() {
        let defaults = task_state_defaults();
        assert_eq!(
            keys(&defaults),
            [
                "goal",
                "taskId",
                "phase",
                "startedAt",
                "endedAt",
                "lastSummary",
                "lastSummaryAt",
                "lastTurnEndedAt",
                "classifyState",
                "goalState",
                "pendingDispatches",
                "classifyHistory",
                "pendingUserInput",
                "userInputSignalVersion",
                "userInputSignalTurnId",
                "apiError",
                "classifyUpdatedAt",
                "cancelledAt",
                "cancelReason",
                "cancelSource",
                "cancelOperationId",
            ]
        );
        let JsValue::Object(entries) = defaults else {
            unreachable!()
        };
        assert_eq!(entries[0].1, JsValue::string(""));
        assert_eq!(entries[2].1, JsValue::string("idle"));
        assert_eq!(entries[10].1, JsValue::Array(vec![]));
        assert_eq!(entries[13].1, JsValue::Number(0.0));
        assert_eq!(entries[20].1, JsValue::Null);
    }

    #[test]
    fn classify_stamp_needs_own_changed_and_no_explicit_value() {
        assert!(should_stamp_classify_updated_at(true, true, false));
        assert!(!should_stamp_classify_updated_at(false, true, false));
        assert!(!should_stamp_classify_updated_at(true, false, false));
        assert!(!should_stamp_classify_updated_at(true, true, true));
    }

    #[test]
    fn history_window_is_strict_and_drops_nan() {
        assert!(keep_history_entry(Some(101.0), 100.0));
        assert!(!keep_history_entry(Some(100.0), 100.0));
        assert!(!keep_history_entry(Some(f64::NAN), 100.0));
        assert!(!keep_history_entry(None, 100.0));
    }

    #[test]
    fn retry_state_bounds_and_resets() {
        let mut state = RetryState::default();
        assert!(state.can_schedule(false, 3));
        state.mark_dirty();
        state.begin_attempt();
        assert_eq!(state.attempt, 1);
        assert!(!state.can_schedule(true, 3), "one timer at a time");
        state.begin_attempt();
        state.begin_attempt();
        assert!(!state.can_schedule(false, 3), "bound exhausted");
        state.mark_clean();
        assert_eq!((state.dirty, state.attempt), (false, 0));
        assert!(state.can_schedule(false, 3));
        state.begin_attempt();
        state.stop();
        assert_eq!(state.attempt, 1, "stop keeps the attempt counter");
    }
}
