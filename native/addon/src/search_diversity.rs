//! Host boundary for `multicc_core::search_diversity`.
//!
//! The kernel is pure and works on indices into the list it was handed, so the
//! whole crossing is one JSON string each way: the caller keeps its own objects
//! (snippets, session ids, text) and only reorders them. There is no host
//! dependency to supply — no clock, no I/O, no engine parser — which is why this
//! does not need the live-value bridge the error policy uses.
use multicc_core::search_diversity as kernel;
use napi_derive::napi;

/// Relevance order with a per-session quota and a cross-session content fold:
/// `{ candidates, limit, perRefQuota, dedupeContentHash }` in, `{ order }` out.
/// `order` holds indices into `candidates`, best first.
#[napi]
pub fn search_diversity_rerank(input: String) -> napi::Result<String> {
    kernel::rerank(&input).map_err(napi::Error::from_reason)
}
