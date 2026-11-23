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

/// Event-type dispatch of the queue projection. The live-value reads and the
/// freeze/classify lookups stay with the host adapter; this only names which
/// projection branch a scheduler event type selects, exactly the chain the
/// host ran before the move.
#[derive(Debug, PartialEq, Eq)]
pub enum QueueBranch {
    ClaimReleased,
    Queued,
    Running,
    Completed,
    Reconcile,
    Frozen,
    Idle,
    Ignore,
}

pub fn queue_branch(event_type: &str) -> QueueBranch {
    match event_type {
        "claim_released" => QueueBranch::ClaimReleased,
        "queued" => QueueBranch::Queued,
        "claimed" | "started" | "resumed" => QueueBranch::Running,
        "completed" => QueueBranch::Completed,
        "reconcile" => QueueBranch::Reconcile,
        "frozen" => QueueBranch::Frozen,
        "cancelled" | "skipped" => QueueBranch::Idle,
        _ => QueueBranch::Ignore,
    }
}

#[cfg(test)]
mod tests {
    use super::{queue_branch, turn_outcome, OutcomeProjection as P, QueueBranch as B};

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

    #[test]
    fn queue_event_types_select_the_original_chain() {
        assert_eq!(queue_branch("claim_released"), B::ClaimReleased);
        assert_eq!(queue_branch("queued"), B::Queued);
        for event_type in ["claimed", "started", "resumed"] {
            assert_eq!(queue_branch(event_type), B::Running);
        }
        assert_eq!(queue_branch("completed"), B::Completed);
        assert_eq!(queue_branch("reconcile"), B::Reconcile);
        assert_eq!(queue_branch("frozen"), B::Frozen);
        for event_type in ["cancelled", "skipped"] {
            assert_eq!(queue_branch(event_type), B::Idle);
        }
        for event_type in ["", "unknown", "Queued", "done"] {
            assert_eq!(queue_branch(event_type), B::Ignore);
        }
    }
}
