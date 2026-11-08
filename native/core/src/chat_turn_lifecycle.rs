//! Durable final-result and post-turn claim state for one chat turn.
use crate::js::{truthy, JsValue};

pub struct ChatTurnLifecycle {
    pub result_durable: JsValue,
    pub result_runner_id: JsValue,
    pub post_turn_claimed: JsValue,
    result_append_in_flight: bool,
    confirmed_result_owner: Option<JsValue>,
}

impl Default for ChatTurnLifecycle {
    fn default() -> Self {
        Self {
            result_durable: JsValue::Bool(false),
            result_runner_id: JsValue::Null,
            post_turn_claimed: JsValue::Bool(false),
            result_append_in_flight: false,
            confirmed_result_owner: None,
        }
    }
}

impl ChatTurnLifecycle {
    pub fn begin_result_append(&mut self) -> bool {
        if self.result_append_in_flight {
            return false;
        }
        self.result_append_in_flight = true;
        true
    }

    pub fn end_result_append(&mut self) {
        self.result_append_in_flight = false;
    }

    pub fn record_confirmed_result(&mut self, owner: JsValue) -> bool {
        if !self.result_append_in_flight || self.confirmed_result_owner.is_some() {
            return false;
        }
        self.confirmed_result_owner = Some(owner);
        true
    }

    pub fn confirmed_result_owner(&self) -> Option<&JsValue> {
        self.confirmed_result_owner.as_ref()
    }

    pub fn claim_post_turn(&mut self) -> bool {
        if truthy(&self.post_turn_claimed) {
            return false;
        }
        self.post_turn_claimed = JsValue::Bool(true);
        true
    }
}

/// Usage is claimed only after the host confirms the durable usage write.
#[derive(Default)]
pub struct ChatRunnerLifecycle {
    pub usage_recorded: bool,
    usage_in_flight: bool,
}

impl ChatRunnerLifecycle {
    pub fn begin_usage(&mut self) -> bool {
        if self.usage_in_flight {
            return false;
        }
        self.usage_in_flight = true;
        true
    }

    pub fn end_usage(&mut self) {
        self.usage_in_flight = false;
    }

    pub fn claim_usage(&mut self) -> bool {
        if self.usage_recorded {
            return false;
        }
        self.usage_recorded = true;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durable_result_and_claim_belong_to_one_turn() {
        let mut turn = ChatTurnLifecycle::default();
        assert!(turn.begin_result_append());
        assert!(!turn.begin_result_append());
        assert!(turn.record_confirmed_result(JsValue::string("runner")));
        assert!(!turn.record_confirmed_result(JsValue::string("other")));
        assert_eq!(
            turn.confirmed_result_owner(),
            Some(&JsValue::string("runner"))
        );
        turn.end_result_append();
        assert!(turn.begin_result_append());
        assert_eq!(turn.result_durable, JsValue::Bool(false));
        turn.result_durable = JsValue::Bool(true);
        turn.result_runner_id = JsValue::string("runner");
        assert_eq!(turn.result_durable, JsValue::Bool(true));
        assert_eq!(turn.result_runner_id, JsValue::string("runner"));
        assert!(turn.claim_post_turn());
        assert!(!turn.claim_post_turn());
    }

    #[test]
    fn usage_claim_is_local_to_one_runner() {
        let mut first = ChatRunnerLifecycle::default();
        let mut retry = ChatRunnerLifecycle::default();
        assert!(first.begin_usage());
        assert!(!first.begin_usage());
        assert!(retry.begin_usage());
        first.end_usage();
        assert!(first.begin_usage());
        assert!(first.claim_usage());
        assert!(!first.claim_usage());
        assert!(retry.claim_usage());
    }
}
