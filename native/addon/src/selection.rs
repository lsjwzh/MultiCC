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

/// Host prompt policies (execution efficiency, sub-agent delegation, slimmed
/// host hint, turn-plan wording) owned by `multicc_core::host_prompts`.
#[napi]
pub fn host_prompts_request(op: String, input: String) -> Result<String> {
    multicc_core::host_prompts::request(&op, &input).map_err(napi::Error::from_reason)
}

/// Memory retrieval ranking, header-only rule pinning, scope selection,
/// query-hit capping, and 1-hop wikilink expansion.
#[napi]
pub fn memory_retrieval_select(input: String) -> Result<String> {
    multicc_core::memory_retrieval::select_entries_json(&input).map_err(napi::Error::from_reason)
}
