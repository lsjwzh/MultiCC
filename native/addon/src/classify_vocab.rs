mod public_api;
use napi::Result;
use napi_derive::napi;

/// The classify vocabulary tables as one JSON document.
/// The public API materializes one catalog per module instance.
#[napi]
pub fn classify_vocab_catalog() -> Result<String> {
    multicc_core::classify_vocab::catalog().map_err(napi::Error::from_reason)
}

/// Parse the classifier's 3-line text output into {state, goal, phase}.
#[napi]
pub fn parse_classify_result(text: String) -> Result<String> {
    multicc_core::classify_vocab::parse_classify_result(&text).map_err(napi::Error::from_reason)
}

/// The logic-bearing vocabulary calls (op dispatch): applyUserInputEvidence,
/// goalStateForClassify, resolveGoalState, classifyGroupKey, buildSystemPrompt.
#[napi]
pub fn classify_vocab_request(op: String, input: String) -> Result<String> {
    multicc_core::classify_vocab::request(&op, &input).map_err(napi::Error::from_reason)
}

#[napi]
pub fn session_question_request(op: String, input: String) -> Result<String> {
    multicc_core::session_question::request(&op, &input).map_err(napi::Error::from_reason)
}
