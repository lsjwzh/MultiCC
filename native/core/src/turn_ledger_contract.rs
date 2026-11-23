//! Canonical terminal hook vocabulary and its projection onto session liveness.
use serde_json::{json, Value};

const RUNNING: &str = "running";
const YIELDING: &str = "yielding";
const ENDED: &str = "ended";

pub fn vocabulary() -> Value {
    json!({
        "hookEvents": [
            "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse",
            "PermissionRequest", "Notification", "Stop", "StopFailure", "Interrupt", "SessionEnd"
        ],
        "ownership": { "RUNNING": RUNNING, "YIELDING": YIELDING, "ENDED": ENDED },
        "errorReasons": [
            "api-error", "interrupted", "unknown-interruption", "result-not-durable", "handoff-resume-failed"
        ],
        "silentErrorReasons": ["interrupted"]
    })
}

pub fn valid_id(id: &str) -> bool {
    (1..=128).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'))
}

pub fn liveness(ownership: Option<&str>) -> (&'static str, &'static str) {
    match ownership {
        Some(RUNNING) => ("active", "turn_ledger_running"),
        Some(YIELDING) => ("inactive", "turn_ledger_yielding"),
        Some(ENDED) => ("inactive", "turn_ledger_ended"),
        _ => ("unknown", "turn_ledger_no_evidence"),
    }
}
