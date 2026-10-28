//! Per-request failover state. The host drives effects, never chooses retries.
use crate::virtual_provider;
use serde_json::{json, Value};
#[derive(Default)]
pub struct Request {
    attempted: Vec<String>,
    current: Option<String>,
    committed: bool,
    stopped: bool,
    identity: Option<(String, String)>,
}
impl Request {
    pub fn choose(&mut self, mut input: Value) -> Result<Value, String> {
        if self.committed || self.stopped || self.current.is_some() {
            return Err("PROVIDER_REQUEST_NOT_SELECTABLE".into());
        }
        let identity = (
            input["appType"].as_str().unwrap_or("").to_owned(),
            input["providerId"].as_str().unwrap_or("").to_owned(),
        );
        if self.identity.as_ref().is_some_and(|old| old != &identity) {
            return Err("PROVIDER_REQUEST_IDENTITY_CHANGED".into());
        }
        self.identity = Some(identity);
        if self.attempted.len() >= 32 {
            self.stopped = true;
            return Err("VIRTUAL_NO_AVAILABLE_MEMBER".into());
        }
        input["excluded"] = json!(self.attempted);
        let decision: Value = serde_json::from_str(&virtual_provider::select(&input.to_string())?)
            .map_err(|_| "PROVIDER_REQUEST_INVALID_SELECTION")?;
        let Some(id) = decision["selectedId"].as_str() else {
            self.stopped = true;
            return Err("VIRTUAL_NO_AVAILABLE_MEMBER".into());
        };
        self.attempted.push(id.to_owned());
        self.current = Some(id.to_owned());
        Ok(decision)
    }
    pub fn outcome(&mut self, mut input: Value) -> Result<Value, String> {
        if self.current.is_none() || self.current.as_deref() != input["providerId"].as_str() {
            return Err("PROVIDER_REQUEST_WRONG_MEMBER".into());
        }
        input["headersSent"] =
            json!(self.committed || self.stopped || input["headersSent"] == true);
        let result: Value = serde_json::from_str(&virtual_provider::failure(&input.to_string())?)
            .map_err(|_| "PROVIDER_REQUEST_INVALID_OUTCOME")?;
        if result["retry"] == true {
            self.current = None;
        } else {
            self.stopped = true;
        }
        Ok(result)
    }
    pub fn commit(&mut self) {
        self.committed = true;
    }
    pub fn cancel(&mut self) {
        self.stopped = true;
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn input() -> Value {
        json!({"providerId":"pool","appType":"claude","virtual":{"members":[{"id":"a"},{"id":"b"}],"strategy":"ordered"},"providers":[{"id":"a","appType":"claude"},{"id":"b","appType":"claude"}],"now":1900000000000_f64})
    }
    #[test]
    fn bounded_attempts_and_no_replay_after_commit_or_ambiguous_failure() {
        let mut state = Request::default();
        assert_eq!(state.choose(input()).unwrap()["selectedId"], "a");
        assert!(state.choose(input()).is_err());
        assert!(state
            .outcome(json!({"providerId":"b","status":429}))
            .is_err());
        assert_eq!(
            state
                .outcome(json!({"providerId":"a","status":429}))
                .unwrap()["retry"],
            true
        );
        assert_eq!(state.choose(input()).unwrap()["selectedId"], "b");
        state.commit();
        assert_eq!(
            state
                .outcome(json!({"providerId":"b","status":429}))
                .unwrap()["retry"],
            false
        );
        assert!(state.choose(input()).is_err());
        let mut state = Request::default();
        state.choose(input()).unwrap();
        assert_eq!(
            state
                .outcome(json!({"providerId":"a","status":500}))
                .unwrap()["retry"],
            false
        );
        assert!(state.choose(input()).is_err());
    }
}
