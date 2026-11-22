//! Pure policy for the chat-history file-repository facade (former
//! `src/session/adapters/chat-history-file-repository.js`). The addon owns the
//! JS object assembly; this module owns every decision that does not need V8.

/// Which JS constructor rebuilds an async failure. The legacy adapter maps
/// `errorType` onto a constructor so `instanceof TypeError`/`SyntaxError`
/// checks downstream keep working; every other value (including a missing
/// `errorType`) rebuilds a plain `Error`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureCtor {
    Error,
    TypeError,
    SyntaxError,
}

pub fn failure_ctor(error_type: Option<&str>) -> FailureCtor {
    match error_type {
        Some("TypeError") => FailureCtor::TypeError,
        Some("SyntaxError") => FailureCtor::SyntaxError,
        _ => FailureCtor::Error,
    }
}

/// The legacy adapter re-parses `jsonSource` before rebuilding a syntax
/// failure, so a bogus transcript surfaces V8's own `SyntaxError` (message and
/// position) instead of the recorded one. Only a string source is re-parsed.
pub fn should_rethrow_json_parse(error_type: Option<&str>, json_source_is_string: bool) -> bool {
    error_type == Some("SyntaxError") && json_source_is_string
}

/// `MULTICC_HISTORY_APPEND !== '0'`: unset or any other value keeps the append
/// ledger on; only the exact string "0" disables it.
pub fn append_enabled_default(env_value: Option<&str>) -> bool {
    env_value != Some("0")
}

/// An empty delivery id never reaches the on-disk probe; the facade answers
/// `false` without touching the worker.
pub fn delivery_probe_short_circuit(identity: &str) -> bool {
    identity.is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failure_ctor_maps_only_the_two_named_constructors() {
        assert_eq!(failure_ctor(Some("TypeError")), FailureCtor::TypeError);
        assert_eq!(failure_ctor(Some("SyntaxError")), FailureCtor::SyntaxError);
        assert_eq!(failure_ctor(Some("Error")), FailureCtor::Error);
        assert_eq!(failure_ctor(Some("RangeError")), FailureCtor::Error);
        assert_eq!(failure_ctor(Some("")), FailureCtor::Error);
        assert_eq!(failure_ctor(None), FailureCtor::Error);
    }

    #[test]
    fn json_source_reparse_requires_syntax_error_and_a_string() {
        assert!(should_rethrow_json_parse(Some("SyntaxError"), true));
        assert!(!should_rethrow_json_parse(Some("SyntaxError"), false));
        assert!(!should_rethrow_json_parse(Some("TypeError"), true));
        assert!(!should_rethrow_json_parse(None, true));
    }

    #[test]
    fn append_default_is_disabled_only_by_exact_zero() {
        assert!(append_enabled_default(None));
        assert!(append_enabled_default(Some("1")));
        assert!(append_enabled_default(Some("")));
        assert!(append_enabled_default(Some("00")));
        assert!(!append_enabled_default(Some("0")));
    }

    #[test]
    fn delivery_probe_short_circuits_only_empty_identity() {
        assert!(delivery_probe_short_circuit(""));
        assert!(!delivery_probe_short_circuit("0"));
        assert!(!delivery_probe_short_circuit("d"));
    }
}
