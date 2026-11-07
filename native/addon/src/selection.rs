use napi::Result;
use napi_derive::napi;

/// `terms(value)` as a JSON string array. `src/context/selection.js` keeps the
/// export surface and forwards here.
#[napi]
pub fn context_selection_terms(input: String) -> Result<String> {
    multicc_core::selection::terms_json(&input).map_err(napi::Error::from_reason)
}

/// `relevance(query, text)`.
#[napi]
pub fn context_selection_relevance(input: String) -> Result<String> {
    multicc_core::selection::relevance_json(&input).map_err(napi::Error::from_reason)
}

/// `minRelevance(query)`.
#[napi]
pub fn context_selection_min_relevance(input: String) -> Result<String> {
    multicc_core::selection::min_relevance_json(&input).map_err(napi::Error::from_reason)
}

/// `clipTokens(text, budget)`.
#[napi]
pub fn context_selection_clip_tokens(input: String) -> Result<String> {
    multicc_core::selection::clip_tokens_json(&input).map_err(napi::Error::from_reason)
}

/// `selectContext(candidates, options)`; candidates arrive pre-sorted by the
/// bridge because localeCompare is an ICU decision.
#[napi]
pub fn context_selection_select(input: String) -> Result<String> {
    multicc_core::selection::select_context_json(&input).map_err(napi::Error::from_reason)
}
