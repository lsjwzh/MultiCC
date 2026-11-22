//! Pure outcome classification for the session persistence adapter (former
//! `src/session/persistence.js`). The addon owns every V8 read; this module
//! owns the status-to-verdict rules and the legacy default constants so both
//! sides stay byte-identical.

/// `kind = 'sessions'` destructuring default (file mode).
pub const DEFAULT_KIND: &str = "sessions";
/// `retryDelayMs = 250` destructuring default.
pub const DEFAULT_RETRY_DELAY_MS: f64 = 250.0;
/// `maxRetries = 3` destructuring default.
pub const DEFAULT_MAX_RETRIES: f64 = 3.0;
/// `bestEffort(source = 'runtime')` parameter default.
pub const DEFAULT_BEST_EFFORT_SOURCE: &str = "runtime";

/// `PersistenceError` fixed surface (legacy class body).
pub const ERROR_NAME: &str = "PersistenceError";
pub const ERROR_CODE: &str = "SESSION_PERSISTENCE_FAILED";
pub const ERROR_STATUS: f64 = 500.0;
/// `source = 'unknown'` options default inside the error constructor.
pub const ERROR_SOURCE_DEFAULT: &str = "unknown";

/// `mutate()` handling of `outcome.status` (legacy switch).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MutateVerdict {
    /// `ok`: return `outcome.value`.
    Value,
    /// `nested`: throw PersistenceError("nested session persistence mutation").
    Nested,
    /// `async`: throw TypeError("session persistence mutator must be synchronous").
    AsyncMutator,
    /// `snapshot`: rethrow `outcome.error` (raw TypeError, as before).
    SnapshotPassthrough,
    /// `mutator`: rethrow `outcome.error`.
    MutatorPassthrough,
    /// `required`: throw PersistenceError("session state could not be persisted")
    /// with `outcome.error` as the cause.
    Required,
    /// any other status: throw the `unexpected status` PersistenceError whose
    /// `source` falls back to the constructor default.
    Unexpected,
}

pub fn classify_mutate(status: &str) -> MutateVerdict {
    match status {
        "ok" => MutateVerdict::Value,
        "nested" => MutateVerdict::Nested,
        "async" => MutateVerdict::AsyncMutator,
        "snapshot" => MutateVerdict::SnapshotPassthrough,
        "mutator" => MutateVerdict::MutatorPassthrough,
        "required" => MutateVerdict::Required,
        _ => MutateVerdict::Unexpected,
    }
}

/// `begin()` handling of `opened.status`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BeginVerdict {
    /// proceed with `opened.token`.
    Ok,
    /// throw PersistenceError("nested session persistence mutation").
    Nested,
    /// rethrow `opened.error`.
    SnapshotPassthrough,
    /// throw the `unexpected status` PersistenceError (source `'unknown'`).
    Unexpected,
}

pub fn classify_begin(status: &str) -> BeginVerdict {
    match status {
        "ok" => BeginVerdict::Ok,
        "nested" => BeginVerdict::Nested,
        "snapshot" => BeginVerdict::SnapshotPassthrough,
        _ => BeginVerdict::Unexpected,
    }
}

/// `commit()` handling of `outcome.status`: `ok` returns, `required` throws
/// the could-not-persist error with cause, everything else reports the
/// transaction as closed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommitVerdict {
    Ok,
    Required,
    Closed,
}

pub fn classify_commit(status: &str) -> CommitVerdict {
    match status {
        "ok" => CommitVerdict::Ok,
        "required" => CommitVerdict::Required,
        _ => CommitVerdict::Closed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mutate_status_classification_matches_the_legacy_switch() {
        assert_eq!(classify_mutate("ok"), MutateVerdict::Value);
        assert_eq!(classify_mutate("nested"), MutateVerdict::Nested);
        assert_eq!(classify_mutate("async"), MutateVerdict::AsyncMutator);
        assert_eq!(
            classify_mutate("snapshot"),
            MutateVerdict::SnapshotPassthrough
        );
        assert_eq!(
            classify_mutate("mutator"),
            MutateVerdict::MutatorPassthrough
        );
        assert_eq!(classify_mutate("required"), MutateVerdict::Required);
        for other in ["", "OK", "closed", "unexpected", "error", "undefined"] {
            assert_eq!(classify_mutate(other), MutateVerdict::Unexpected, "{other}");
        }
    }

    #[test]
    fn begin_status_classification_matches_the_legacy_guard_chain() {
        assert_eq!(classify_begin("ok"), BeginVerdict::Ok);
        assert_eq!(classify_begin("nested"), BeginVerdict::Nested);
        assert_eq!(
            classify_begin("snapshot"),
            BeginVerdict::SnapshotPassthrough
        );
        for other in ["", "required", "mutator", "async", "ok "] {
            assert_eq!(classify_begin(other), BeginVerdict::Unexpected, "{other}");
        }
    }

    #[test]
    fn commit_status_classification_collapses_everything_else_to_closed() {
        assert_eq!(classify_commit("ok"), CommitVerdict::Ok);
        assert_eq!(classify_commit("required"), CommitVerdict::Required);
        for other in ["", "nested", "snapshot", "mutator", "async"] {
            assert_eq!(classify_commit(other), CommitVerdict::Closed, "{other}");
        }
    }

    #[test]
    fn defaults_are_the_legacy_literals() {
        assert_eq!(DEFAULT_KIND, "sessions");
        assert_eq!(DEFAULT_RETRY_DELAY_MS, 250.0);
        assert_eq!(DEFAULT_MAX_RETRIES, 3.0);
        assert_eq!(DEFAULT_BEST_EFFORT_SOURCE, "runtime");
        assert_eq!(ERROR_NAME, "PersistenceError");
        assert_eq!(ERROR_CODE, "SESSION_PERSISTENCE_FAILED");
        assert_eq!(ERROR_STATUS, 500.0);
        assert_eq!(ERROR_SOURCE_DEFAULT, "unknown");
    }
}
