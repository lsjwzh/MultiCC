use napi::Result;
use napi_derive::napi;

/// The classify vocabulary tables as one JSON document.
/// `src/classify/vocab.js` reads it once at load and freezes it.
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
