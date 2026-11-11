//! Stage immutable turn facts until the host has stopped every workspace writer.
//! A single fresh observation can then back both the run result and its barrier.
//! This owner never releases a lease or interprets process liveness itself.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResultFacts {
    pub attempt_id: Option<String>,
    pub outcome: String,
    pub pending_input: bool,
    pub result_durable: bool,
    pub usage_durable: bool,
}

#[derive(Default)]
pub struct Finalization {
    pub attempt_id: Option<String>,
    pub succeeded: bool,
    pub pending_input: bool,
    pub cancelled: bool,
    pub failed: bool,
    pub result_durable: bool,
    pub usage_durable: bool,
}

#[derive(Default)]
pub struct ReleaseEvidence {
    result: Option<ResultFacts>,
    finalized: bool,
}

impl ReleaseEvidence {
    pub fn finalized(&mut self, input: Finalization) {
        self.finalized = true;
        self.result = Some(ResultFacts {
            attempt_id: input.attempt_id,
            outcome: if input.pending_input {
                "waiting"
            } else if input.succeeded {
                "succeeded"
            } else if input.cancelled {
                "cancelled"
            } else if input.failed {
                "failed"
            } else {
                "unknown"
            }
            .into(),
            pending_input: input.pending_input,
            result_durable: input.result_durable,
            usage_durable: input.usage_durable,
        });
    }

    pub fn terminal(&mut self, status: &str, attempt_id: Option<String>, pending_input: bool) {
        // Forced cancellation can lack a finalizer. A scheduler success cannot
        // manufacture durable success, and a late fallback cannot replace it.
        if self.finalized || attempt_id.is_none() || !matches!(status, "cancelled" | "failed") {
            return;
        }
        self.result = Some(ResultFacts {
            attempt_id,
            outcome: status.into(),
            pending_input,
            result_durable: false,
            usage_durable: false,
        });
    }

    pub fn result(&self) -> Option<ResultFacts> {
        self.result.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finalizer_overrides_fallback_but_late_fallback_cannot_replace_finalizer() {
        let mut state = ReleaseEvidence::default();
        state.terminal("failed", Some("attempt".into()), false);
        assert_eq!(state.result().unwrap().outcome, "failed");
        state.finalized(Finalization {
            attempt_id: Some("attempt".into()),
            succeeded: true,
            result_durable: true,
            usage_durable: true,
            ..Default::default()
        });
        let expected = state.result();
        state.terminal("cancelled", Some("attempt".into()), true);
        assert_eq!(state.result(), expected);
        assert!(expected.unwrap().result_durable);
    }

    #[test]
    fn scheduler_completion_is_not_a_durable_final_result() {
        let mut state = ReleaseEvidence::default();
        state.terminal("succeeded", Some("attempt".into()), false);
        state.terminal("failed", None, false);
        assert!(state.result().is_none());
    }

    #[test]
    fn outcome_precedence_matches_the_existing_finalizer() {
        for (pending_input, succeeded, cancelled, failed, expected) in [
            (true, true, true, true, "waiting"),
            (false, true, true, true, "succeeded"),
            (false, false, true, true, "cancelled"),
            (false, false, false, true, "failed"),
            (false, false, false, false, "unknown"),
        ] {
            let mut state = ReleaseEvidence::default();
            state.finalized(Finalization {
                pending_input,
                succeeded,
                cancelled,
                failed,
                ..Default::default()
            });
            assert_eq!(state.result().unwrap().outcome, expected);
        }
    }
}
