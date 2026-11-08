//! Completion evidence shared by JSON CLI adapters.
use crate::js::JsString;

pub fn completion_reason(reason: Option<JsString>) -> JsString {
    reason
        .map(|text| JsString::from_units(text.as_units().iter().take(160).copied().collect()))
        .unwrap_or_else(|| "unknown_reason".into())
}

#[derive(Default)]
pub enum StepReason {
    #[default]
    Missing,
    Text(JsString),
    OtherTruthy,
}

#[derive(Default)]
pub struct StepCompletion {
    reason: StepReason,
    has_tools: bool,
}

impl StepCompletion {
    pub fn begin_step(&mut self) {
        self.reason = StepReason::Missing;
        self.has_tools = false;
    }
    pub fn tool_started(&mut self) {
        self.has_tools = true;
    }
    pub fn finish_step(&mut self, reason: StepReason) {
        self.reason = reason;
    }
    pub fn stop_without_tools(&self) -> bool {
        matches!(&self.reason, StepReason::Text(text) if text == "stop") && !self.has_tools
    }
    pub fn unknown_reason(&self) -> JsString {
        if self.has_tools {
            return "tool_step_requires_followup".into();
        }
        match &self.reason {
            StepReason::Missing => "missing_step_finish".into(),
            StepReason::Text(text) => completion_reason(Some(text.clone())),
            StepReason::OtherTruthy => "unknown_reason".into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tool_steps_require_a_fresh_final_step_and_keep_unknown_reasons() {
        let mut step = StepCompletion::default();
        assert!(!step.stop_without_tools());
        step.tool_started();
        step.finish_step(StepReason::Text("stop".into()));
        assert!(!step.stop_without_tools());
        assert_eq!(step.unknown_reason(), "tool_step_requires_followup");
        step.begin_step();
        assert_eq!(step.unknown_reason(), "missing_step_finish");
        step.finish_step(StepReason::Text("stop".into()));
        assert!(step.stop_without_tools());
        step.finish_step(StepReason::OtherTruthy);
        assert_eq!(step.unknown_reason(), "unknown_reason");
    }
    #[test]
    fn reasons_are_truncated_by_utf16_units_without_replacing_surrogates() {
        let mut units = vec![120; 159];
        units.extend([0xd83d, 0xde00]);
        let reason = completion_reason(Some(JsString::from_units(units)));
        assert_eq!(reason.len(), 160);
        assert_eq!(reason.code_unit_at(159), Some(0xd83d));
    }
}
