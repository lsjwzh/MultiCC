//! Pure task-board projection decisions shared with the live host adapter.

#[derive(Debug, PartialEq, Eq)]
pub enum OutcomeProjection {
    State(&'static str),
    Classify(&'static str),
    Fallback,
}

/// Select only the explicit outcome branch. The host supplies the existing
/// classifier lookup for waiting and fallback paths so its live JS value and
/// property-access semantics remain unchanged during the host migration.
pub fn turn_outcome(outcome: Option<&str>) -> OutcomeProjection {
    match outcome {
        Some("succeeded") => OutcomeProjection::State("succeeded"),
        Some("failed") => OutcomeProjection::State("error"),
        Some("waiting_user") => OutcomeProjection::Classify("W"),
        Some("waiting_background") => OutcomeProjection::Classify("B"),
        Some("running") => OutcomeProjection::State("running"),
        _ => OutcomeProjection::Fallback,
    }
}

#[cfg(test)]
mod tests {
    use super::{turn_outcome, OutcomeProjection as P};

    #[test]
    fn explicit_and_unknown_outcomes_select_the_original_branches() {
        assert_eq!(turn_outcome(Some("succeeded")), P::State("succeeded"));
        assert_eq!(turn_outcome(Some("failed")), P::State("error"));
        assert_eq!(turn_outcome(Some("waiting_user")), P::Classify("W"));
        assert_eq!(turn_outcome(Some("waiting_background")), P::Classify("B"));
        assert_eq!(turn_outcome(Some("running")), P::State("running"));
        assert_eq!(turn_outcome(Some("unknown")), P::Fallback);
        assert_eq!(turn_outcome(None), P::Fallback);
    }
}
