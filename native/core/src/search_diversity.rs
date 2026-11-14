//! Diversity post-processing for message retrieval: the rule that keeps one long
//! conversation from occupying an injection budget.
//!
//! The search backend (`src/search/index-store.js`) ranks chunks with FTS5 `bm25()`,
//! which returns a *negative* number on purpose: more relevant documents are more
//! negative, so `ORDER BY rank ASC` is "best first". The store flips the sign before
//! handing rows to callers (`score = -rank`), so **`score` here is the flipped value
//! and bigger is better**; this kernel sorts descending. Callers that pass the raw
//! `bm25()` value would invert the ranking silently, so the convention is spelled
//! out in the module docs of both sides.
//!
//! The kernel is pure: candidates arrive as one JSON object and the answer is an
//! ordering of the *indices it was given*, so the caller keeps its own objects
//! (snippets, session ids, text) without a second round trip. Rules, in order:
//!
//! 1. Relevance stays the primary order: `score` desc, then `updatedAt` desc, then
//!    the original index asc. The last key makes the order total and deterministic,
//!    which is what a test can assert on an all-equal input.
//! 2. Across sessions, a `contentHash` already kept is folded into the more relevant
//!    one and dropped. A duplicate inside one session is kept: the corpus already
//!    deduplicates chunks within a session (see `message-corpus.js`), and this rule
//!    exists for the same paragraph being quoted in several conversations.
//! 3. A single session contributes at most `perRefQuota` chunks to the first pass.
//!    The rest go to a backfill pool, in the same relevance order, used only while
//!    the result is still short of `limit` — a quota must never make the answer
//!    shorter than it would have been without one.
//! 4. Scores are never modified. Diversity only reorders, so a caller that ignores
//!    the quota gets exactly the relevance ordering back.

use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::HashMap;

/// Hits per search when the request does not say (matches the index's own default).
pub const DEFAULT_LIMIT: usize = 20;
/// How many chunks one conversation may contribute before it is demoted.
pub const DEFAULT_PER_REF_QUOTA: usize = 3;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    /// Session id the chunk belongs to.
    pub ref_id: String,
    /// Content hash of the chunk, used for the cross-session fold.
    #[serde(default)]
    pub content_hash: String,
    /// Relevance where bigger is better (see the module docs).
    #[serde(default)]
    pub score: f64,
    /// Message time (epoch ms); only a tie-breaker, never a filter.
    #[serde(default)]
    pub updated_at: f64,
    #[serde(default)]
    pub task_id: String,
    #[serde(default)]
    pub dir_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    #[serde(default)]
    candidates: Vec<Candidate>,
    #[serde(default)]
    limit: Option<f64>,
    #[serde(default)]
    per_ref_quota: Option<f64>,
    #[serde(default = "dedupe_default")]
    dedupe_content_hash: bool,
}

fn dedupe_default() -> bool {
    true
}

#[derive(Debug, Serialize)]
struct Response {
    order: Vec<usize>,
}

/// One non-finite score sorts below every finite one, and `NaN` sorts below `-inf`:
/// a malformed score must never win a slot. `f64::total_cmp` would put `NaN` at an
/// end decided by its sign bit, which is not what a "least relevant" fallback means.
fn ascending(a: f64, b: f64) -> Ordering {
    match (a.is_nan(), b.is_nan()) {
        (true, true) => Ordering::Equal,
        (true, false) => Ordering::Less,
        (false, true) => Ordering::Greater,
        (false, false) => a.partial_cmp(&b).unwrap_or(Ordering::Equal),
    }
}

fn limit_of(request: &Request) -> usize {
    match request.limit {
        Some(value) if value.is_finite() && value >= 0.0 => value.floor() as usize,
        Some(_) => DEFAULT_LIMIT,
        None => DEFAULT_LIMIT,
    }
}

/// `None` means "no cap". The default applies when the field is absent; a caller
/// that asks for 0 or a negative quota is asking to switch the cap off, which is
/// the only reading that cannot silently return an empty answer.
fn quota_of(request: &Request) -> Option<usize> {
    match request.per_ref_quota {
        Some(value) if value.is_finite() && value > 0.0 => Some(value.floor() as usize),
        Some(_) => None,
        None => Some(DEFAULT_PER_REF_QUOTA),
    }
}

/// Indices into `request.candidates`, best first, at most `limit` of them.
fn order_of(request: &Request) -> Vec<usize> {
    let candidates = &request.candidates;
    let limit = limit_of(request);
    if limit == 0 || candidates.is_empty() {
        return Vec::new();
    }
    let quota = quota_of(request);

    // Relevance order. `sort_by` is stable, and the final key (the original index)
    // makes the comparator total anyway, so the answer cannot depend on the sort
    // implementation.
    let mut ranked: Vec<usize> = (0..candidates.len()).collect();
    ranked.sort_by(|&left, &right| {
        let a = &candidates[left];
        let b = &candidates[right];
        ascending(b.score, a.score)
            .then_with(|| ascending(b.updated_at, a.updated_at))
            .then_with(|| left.cmp(&right))
    });

    let mut kept: Vec<usize> = Vec::with_capacity(limit.min(ranked.len()));
    let mut backfill: Vec<usize> = Vec::new();
    let mut per_ref: HashMap<&str, usize> = HashMap::new();
    // content hash -> the session whose chunk was already kept for it.
    let mut seen: HashMap<&str, &str> = HashMap::new();

    for &index in &ranked {
        if kept.len() >= limit {
            break;
        }
        let candidate = &candidates[index];
        if request.dedupe_content_hash
            && !candidate.content_hash.is_empty()
            && seen
                .get(candidate.content_hash.as_str())
                .is_some_and(|owner| *owner != candidate.ref_id.as_str())
        {
            // Same paragraph, different conversation: this is the copy, not a hit.
            continue;
        }
        let count = per_ref.get(candidate.ref_id.as_str()).copied().unwrap_or(0);
        if quota.is_some_and(|cap| count >= cap) {
            backfill.push(index);
            continue;
        }
        remember(&mut seen, &mut per_ref, candidate);
        kept.push(index);
    }

    for index in backfill {
        if kept.len() >= limit {
            break;
        }
        let candidate = &candidates[index];
        if request.dedupe_content_hash
            && !candidate.content_hash.is_empty()
            && seen
                .get(candidate.content_hash.as_str())
                .is_some_and(|owner| *owner != candidate.ref_id.as_str())
        {
            continue;
        }
        remember(&mut seen, &mut per_ref, candidate);
        kept.push(index);
    }

    kept
}

fn remember<'a>(
    seen: &mut HashMap<&'a str, &'a str>,
    per_ref: &mut HashMap<&'a str, usize>,
    candidate: &'a Candidate,
) {
    if !candidate.content_hash.is_empty() {
        seen.entry(candidate.content_hash.as_str())
            .or_insert(candidate.ref_id.as_str());
    }
    *per_ref.entry(candidate.ref_id.as_str()).or_insert(0) += 1;
}

/// The napi entry point: `{ candidates, limit, perRefQuota, dedupeContentHash }` in,
/// `{ order }` out. Errors are the caller's — a request that is not JSON at all is a
/// bug, not a corpus condition.
pub fn rerank(input: &str) -> Result<String, String> {
    let request: Request =
        serde_json::from_str(input).map_err(|error| format!("invalid_rerank_request: {error}"))?;
    let answer = Response {
        order: order_of(&request),
    };
    serde_json::to_string(&answer).map_err(|error| format!("invalid_rerank_response: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn candidate(ref_id: &str, hash: &str, score: f64, updated_at: f64) -> serde_json::Value {
        json!({
            "refId": ref_id,
            "contentHash": hash,
            "score": score,
            "updatedAt": updated_at,
        })
    }

    fn run(candidates: Vec<serde_json::Value>, limit: usize, quota: Option<usize>) -> Vec<usize> {
        let request = Request {
            candidates: serde_json::from_value(serde_json::Value::Array(candidates)).unwrap(),
            limit: Some(limit as f64),
            per_ref_quota: quota.map(|value| value as f64),
            dedupe_content_hash: true,
        };
        order_of(&request)
    }

    fn refs_of(candidates: &[serde_json::Value], order: &[usize]) -> Vec<String> {
        order
            .iter()
            .map(|&index| candidates[index]["refId"].as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn one_session_dominating_the_list_is_capped_to_the_quota() {
        // The measured failure: 13 of 20 hits from one conversation.
        let mut candidates = Vec::new();
        for rank in 0..13 {
            candidates.push(candidate(
                "loud",
                &format!("h{rank}"),
                100.0 - rank as f64,
                0.0,
            ));
        }
        for rank in 0..7 {
            candidates.push(candidate(
                &format!("other{rank}"),
                &format!("o{rank}"),
                50.0 - rank as f64,
                0.0,
            ));
        }
        let order = run(candidates.clone(), 10, Some(3));
        assert_eq!(order.len(), 10);
        let refs = refs_of(&candidates, &order);
        assert_eq!(
            refs.iter().filter(|id| *id == "loud").count(),
            3,
            "the loud conversation contributes exactly the quota"
        );
        assert_eq!(order[0], 0, "relevance still leads the ordering");
        assert_eq!(order[3], 13, "the next slot goes to the best other session");
    }

    #[test]
    fn identical_content_across_sessions_is_folded_once() {
        let candidates = vec![
            candidate("a", "same", 9.0, 0.0),
            candidate("b", "same", 8.0, 0.0),
            candidate("c", "other", 7.0, 0.0),
        ];
        let order = run(candidates.clone(), 10, Some(3));
        assert_eq!(refs_of(&candidates, &order), vec!["a", "c"]);
        assert_eq!(order, vec![0, 2], "the more relevant copy survives");
    }

    #[test]
    fn a_duplicate_inside_one_session_is_not_folded() {
        // `message-corpus.js` already deduplicates within a session; folding here
        // would silently drop a legitimate second chunk of the same session.
        let candidates = vec![
            candidate("a", "same", 9.0, 0.0),
            candidate("a", "same", 8.0, 0.0),
        ];
        let order = run(candidates, 10, Some(3));
        assert_eq!(order, vec![0, 1]);
    }

    #[test]
    fn the_backfill_pool_refills_a_short_answer() {
        // Quota 1, two sessions, limit 5: the cap must not shorten the answer.
        let mut candidates = vec![candidate("a", "a1", 10.0, 0.0)];
        for rank in 0..3 {
            candidates.push(candidate(
                "a",
                &format!("a{}", rank + 2),
                9.0 - rank as f64,
                0.0,
            ));
        }
        candidates.push(candidate("b", "b1", 1.0, 0.0));
        let order = run(candidates.clone(), 5, Some(1));
        assert_eq!(order.len(), 5);
        assert_eq!(order[0], 0);
        assert_eq!(order[1], 4, "the other session is promoted first");
        assert_eq!(
            order[2..].to_vec(),
            vec![1, 2, 3],
            "backfill continues in relevance order"
        );
    }

    #[test]
    fn an_empty_input_answers_an_empty_order() {
        assert_eq!(run(Vec::new(), 20, Some(3)), Vec::<usize>::new());
    }

    #[test]
    fn equal_scores_are_ordered_by_message_time_then_original_index() {
        let candidates = vec![
            candidate("a", "h1", 5.0, 100.0),
            candidate("b", "h2", 5.0, 300.0),
            candidate("c", "h3", 5.0, 200.0),
            candidate("d", "h4", 5.0, 200.0),
        ];
        let order = run(candidates, 10, Some(3));
        assert_eq!(order, vec![1, 2, 3, 0], "updatedAt desc, then index asc");
    }

    #[test]
    fn the_ordering_is_stable_across_repeated_runs() {
        let candidates: Vec<_> = (0..30)
            .map(|index| candidate(&format!("s{}", index % 4), &format!("h{index}"), 1.0, 7.0))
            .collect();
        let first = run(candidates.clone(), 12, Some(3));
        for _ in 0..5 {
            assert_eq!(run(candidates.clone(), 12, Some(3)), first);
        }
    }

    #[test]
    fn a_zero_or_negative_quota_switches_the_cap_off() {
        let candidates: Vec<_> = (0..6)
            .map(|index| candidate("loud", &format!("h{index}"), 6.0 - index as f64, 0.0))
            .collect();
        assert_eq!(run(candidates.clone(), 6, Some(0)), vec![0, 1, 2, 3, 4, 5]);
        assert_eq!(
            run(candidates.clone(), 6, Some(usize::MAX)),
            vec![0, 1, 2, 3, 4, 5]
        );
    }

    #[test]
    fn a_quota_larger_than_the_candidate_set_changes_nothing() {
        let candidates = vec![
            candidate("a", "a", 3.0, 0.0),
            candidate("a", "b", 2.0, 0.0),
            candidate("b", "c", 1.0, 0.0),
        ];
        assert_eq!(run(candidates, 10, Some(100)), vec![0, 1, 2]);
    }

    #[test]
    fn a_zero_limit_returns_nothing_and_a_missing_limit_is_the_default() {
        let candidates = vec![candidate("a", "a", 1.0, 0.0)];
        assert_eq!(run(candidates.clone(), 0, Some(3)), Vec::<usize>::new());
        let request = Request {
            candidates: serde_json::from_value(serde_json::Value::Array(candidates)).unwrap(),
            limit: None,
            per_ref_quota: None,
            dedupe_content_hash: true,
        };
        assert_eq!(limit_of(&request), DEFAULT_LIMIT);
        assert_eq!(quota_of(&request), Some(DEFAULT_PER_REF_QUOTA));
        assert_eq!(order_of(&request), vec![0]);
    }

    #[test]
    fn a_nan_score_never_outranks_a_real_one() {
        // JSON cannot spell NaN, so this is built directly on the struct: a caller
        // that computes a score itself can still produce one, and it must sort last.
        let make = |ref_id: &str, hash: &str, score: f64| Candidate {
            ref_id: ref_id.into(),
            content_hash: hash.into(),
            score,
            updated_at: 0.0,
            task_id: String::new(),
            dir_id: String::new(),
        };
        let order = order_of(&Request {
            candidates: vec![
                make("nan", "n", f64::NAN),
                make("low", "l", -100.0),
                make("high", "h", 1.0),
            ],
            limit: Some(3.0),
            per_ref_quota: None,
            dedupe_content_hash: true,
        });
        assert_eq!(order, vec![2, 1, 0]);
    }

    #[test]
    fn the_json_boundary_parses_camel_case_and_answers_indices() {
        let answer = rerank(
            &json!({
                "candidates": [
                    { "refId": "a", "contentHash": "1", "score": 1.0, "updatedAt": 5, "taskId": "t1", "dirId": "d1" },
                    { "refId": "a", "contentHash": "2", "score": 0.5, "updatedAt": 6 },
                ],
                "limit": 1,
                "perRefQuota": 1,
                "dedupeContentHash": true,
            })
            .to_string(),
        )
        .unwrap();
        assert_eq!(answer, r#"{"order":[0]}"#);
        assert!(rerank("{}").unwrap().contains("\"order\":[]"));
        assert_eq!(
            rerank("not json").unwrap_err(),
            "invalid_rerank_request: expected ident at line 1 column 2"
        );
    }

    #[test]
    fn task_and_dir_ids_never_change_the_order() {
        // They are carried for callers that filter before reranking; an unused field
        // must not perturb a deterministic order.
        let plain: Vec<serde_json::Value> = (0..5)
            .map(|index| candidate("a", &format!("h{index}"), 5.0 - index as f64, 0.0))
            .collect();
        let tagged: Vec<serde_json::Value> = plain
            .iter()
            .map(|value| {
                let mut value = value.clone();
                value["taskId"] = json!("task-x");
                value["dirId"] = json!("dir-y");
                value
            })
            .collect();
        assert_eq!(
            refs_of(&plain, &run(plain.clone(), 5, Some(3))),
            refs_of(&tagged, &run(tagged.clone(), 5, Some(3)))
        );
    }

    #[test]
    fn dedupe_can_be_switched_off() {
        let request: Request = serde_json::from_str(
            &json!({
                "candidates": [
                    { "refId": "a", "contentHash": "same", "score": 2.0 },
                    { "refId": "b", "contentHash": "same", "score": 1.0 },
                ],
                "limit": 10,
                "perRefQuota": 3,
                "dedupeContentHash": false,
            })
            .to_string(),
        )
        .unwrap();
        assert_eq!(order_of(&request), vec![0, 1]);
    }
}
