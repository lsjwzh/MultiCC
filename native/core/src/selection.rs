//! Context selection — memory/chunk ranking and budget clipping, migrated
//! verbatim from `src/context/selection.js`. The JS module keeps its export
//! surface and forwards here.
//!
//! JS semantics kept exactly: string length and slicing count UTF-16 code
//! units, ASCII terms match whole words only, CJK runs contribute bigrams,
//! `estimateTokens` uses the same CJK table and `Math.round`, and `selectContext`
//! hashes `JSON.stringify(dedupeText || text)` with SHA-256. Candidate ordering
//! stays in the JS bridge because `String.prototype.localeCompare` is an
//! ICU/locale decision, not a portable kernel rule.
//!
//! The boundary keeps the JSON text transport (the wrapper still spells
//! non-finite numbers as strings) but parses with [`json_parse`] instead of
//! `json_lenient`: a lone surrogate arrives as its UTF-16 code unit instead of
//! U+FFFD, so clipping and spreading reproduce `String.prototype.slice`
//! exactly.
use sha2::{Digest, Sha256};
use std::collections::HashSet;

use crate::js::{coerce, json_parse, json_stringify, JsString, JsValue};

const MAX_TERMS: usize = 256;
const NULL: JsValue = JsValue::Null;

fn ellipsis() -> JsString {
    JsString::from_rust_str("…")
}

fn newline() -> JsString {
    JsString::from_rust_str("\n")
}

/// `[a-z0-9_./-]` over one UTF-16 code unit. Units outside ASCII never match.
fn ascii_term_unit(unit: u16) -> bool {
    unit < 0x80 && {
        let byte = unit as u8;
        byte.is_ascii_lowercase()
            || byte.is_ascii_digit()
            || matches!(byte, b'_' | b'.' | b'/' | b'-')
    }
}

/// `[㐀-鿿]` — the exact class the old terms/relevance regex used.
fn is_cjk_unit(unit: u16) -> bool {
    (0x3400..=0x9FFF).contains(&unit)
}

fn is_cjk_token_unit(unit: u16) -> bool {
    matches!(
        unit,
        0x3400..=0x4DBF
            | 0x4E00..=0x9FFF
            | 0xF900..=0xFAFF
            | 0x3040..=0x309F
            | 0x30A0..=0x30FF
            | 0xAC00..=0xD7AF
    )
}

fn push_unique(result: &mut Vec<String>, seen: &mut HashSet<String>, term: String) {
    if seen.insert(term.clone()) {
        result.push(term);
    }
}

/// `terms(value)`: lowercased ASCII runs plus CJK bigrams, deduped in first-seen
/// order and capped at 256.
pub fn terms_from(value: &JsValue) -> Vec<String> {
    let text = if coerce::truthy(value) {
        coerce::js_to_string(value)
    } else {
        JsString::new()
    }
    .to_lowercase();
    let units = text.as_units();
    let mut result = Vec::new();
    let mut seen = HashSet::new();

    let mut at = 0usize;
    while at < units.len() {
        if ascii_term_unit(units[at]) {
            let start = at;
            while at < units.len() && ascii_term_unit(units[at]) {
                at += 1;
            }
            if at - start >= 2 {
                push_unique(
                    &mut result,
                    &mut seen,
                    String::from_utf16_lossy(&units[start..at]),
                );
            }
        } else {
            at += 1;
        }
    }

    let mut run: Vec<u16> = Vec::new();
    let flush = |run: &mut Vec<u16>, result: &mut Vec<String>, seen: &mut HashSet<String>| {
        for index in 0..run.len().saturating_sub(1) {
            push_unique(
                result,
                seen,
                String::from_utf16_lossy(&run[index..index + 2]),
            );
        }
        run.clear();
    };
    for unit in units {
        if is_cjk_unit(*unit) {
            run.push(*unit);
        } else if !run.is_empty() {
            flush(&mut run, &mut result, &mut seen);
        }
    }
    if !run.is_empty() {
        flush(&mut run, &mut result, &mut seen);
    }

    result.truncate(MAX_TERMS);
    result
}

fn ascii_word(character: Option<char>) -> bool {
    character.is_some_and(|character| {
        character.is_ascii_lowercase() || character.is_ascii_digit() || character == '_'
    })
}

fn is_ascii_term(term: &str) -> bool {
    !term.is_empty()
        && term.bytes().all(|byte| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || matches!(byte, b'_' | b'.' | b'/' | b'-')
        })
}

/// ASCII terms must match a whole word; CJK bigrams use plain substring search.
fn term_hit(haystack: &str, term: &str) -> bool {
    if !is_ascii_term(term) {
        return haystack.contains(term);
    }
    let mut search_from = 0usize;
    while let Some(offset) = haystack[search_from..].find(term) {
        let at = search_from + offset;
        let before = haystack[..at].chars().next_back();
        let after = haystack[at + term.len()..].chars().next();
        if !ascii_word(before) && !ascii_word(after) {
            return true;
        }
        search_from = at + 1;
    }
    false
}

fn lowercased_text(value: &JsValue) -> String {
    if coerce::truthy(value) {
        coerce::js_to_string(value)
    } else {
        JsString::new()
    }
    .to_lowercase()
    .to_string_lossy()
}

/// `relevance(query, text)`: count of query terms hit in the lowercased text.
pub fn relevance(query: &JsValue, text: &JsValue) -> usize {
    let tokens = terms_from(query);
    let haystack = lowercased_text(text);
    tokens
        .iter()
        .filter(|term| term_hit(&haystack, term))
        .count()
}

/// `minRelevance(query)`: at least 1 (2 from four terms), or 15 % of terms.
pub fn min_relevance(query: &JsValue) -> f64 {
    let count = terms_from(query).len() as f64;
    let floor: f64 = if count >= 4.0 { 2.0 } else { 1.0 };
    floor.max((count * 0.15).ceil())
}

fn estimate_units(text: &JsString) -> f64 {
    if text.is_empty() {
        return 0.0;
    }
    let units = text.as_units();
    let cjk = units
        .iter()
        .filter(|unit| is_cjk_token_unit(**unit))
        .count();
    let raw = cjk as f64 * 1.5 + (units.len() - cjk) as f64 / 4.0;
    (raw + 0.5).floor().max(1.0)
}

/// `estimateTokens(value)` from `src/task-shell/context.js`, kept on the JS
/// side for its other callers but reproduced here for selection.
pub fn estimate_tokens(value: Option<&JsValue>) -> f64 {
    let text = match value {
        None | Some(JsValue::Null) | Some(JsValue::Undefined) => JsString::new(),
        Some(other) => coerce::js_to_string(other),
    };
    estimate_units(&text)
}

fn sha256_json(value: &JsValue) -> String {
    format!(
        "{:x}",
        Sha256::digest(json_stringify(value).unwrap_or_default().as_bytes())
    )
}

fn less_equal_number(left: f64, right: f64) -> bool {
    !right.is_nan() && left <= right
}

fn clip_text(text: &JsString, budget: f64) -> JsString {
    if less_equal_number(estimate_units(text), budget) {
        return text.clone();
    }
    // `budget < estimateTokens('…')` (a single non-CJK character costs 1).
    if !budget.is_nan() && budget < estimate_units(&ellipsis()) {
        return JsString::new();
    }
    let mut lo: i64 = 0;
    let mut hi: i64 = text.len() as i64;
    while lo < hi {
        let mid = (((lo + hi) as f64) / 2.0).ceil() as i64;
        // No surrogate stripping inside the search: `slice(0, mid)` counts a
        // lone trailing high surrogate as one code unit, and it is non-CJK.
        let mut piece = text.truncate_units(mid as usize);
        piece.push(&ellipsis());
        if less_equal_number(estimate_units(&piece), budget) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    let mut clipped = text.truncate_units(lo.max(0) as usize);
    // `text.slice(0, lo).replace(/[\uD800-\uDBFF]$/, '')`: drop one trailing
    // high surrogate, but keep any other lone surrogate.
    if clipped
        .as_units()
        .last()
        .is_some_and(|unit| (0xD800..=0xDBFF).contains(unit))
    {
        clipped = clipped.truncate_units(clipped.len() - 1);
    }
    clipped.push(&ellipsis());
    clipped
}

/// `clipTokens(text, budget)`. Non-string inputs that fit the budget are
/// returned untouched, exactly like the JS original.
pub fn clip_tokens(text: &JsValue, budget: &JsValue) -> Result<JsValue, String> {
    clip_tokens_with(text, budget, false)
}

/// `text_undefined` only selects the engine-style TypeError wording: JSON
/// cannot carry the difference between an absent property and `null`, while
/// `String(undefined)` and `String(null)` both read as `''`.
pub fn clip_tokens_with(
    text: &JsValue,
    budget: &JsValue,
    text_undefined: bool,
) -> Result<JsValue, String> {
    if coerce::less_equal_number(estimate_tokens(Some(text)), budget) {
        return Ok(text.clone());
    }
    let budget_number = coerce::js_to_number(budget);
    if !budget_number.is_nan() && budget_number < estimate_units(&ellipsis()) {
        return Ok(JsValue::String(JsString::new()));
    }
    match text {
        JsValue::String(value) => Ok(JsValue::String(clip_text(value, budget_number))),
        JsValue::Null | JsValue::Undefined => Err(if text_undefined {
            "context_selection_type_error: Cannot read properties of undefined (reading 'length')"
                .to_string()
        } else {
            "context_selection_type_error: Cannot read properties of null (reading 'length')"
                .to_string()
        }),
        // An array has `slice`, so the failure surfaces on `.replace` instead.
        JsValue::Array(_) => Err(
            "context_selection_type_error: text.slice(...).replace is not a function".to_string(),
        ),
        _ => Err("context_selection_type_error: text.slice is not a function".to_string()),
    }
}

fn field<'a>(container: Option<&'a JsValue>, key: &str) -> Option<&'a JsValue> {
    container.and_then(|value| match value {
        JsValue::Object(entries) => entries
            .iter()
            .find(|(name, _)| name.to_string_lossy() == key)
            .map(|(_, value)| value),
        _ => None,
    })
}

/// Spread a candidate into a result object. Strings expose UTF-16 index
/// properties like JS own enumerable string keys; other primitives expose none.
fn spread_source(source: &JsValue) -> Vec<(JsString, JsValue)> {
    match source {
        JsValue::Object(entries) => entries.clone(),
        JsValue::String(text) => text
            .as_units()
            .iter()
            .enumerate()
            .map(|(index, unit)| {
                (
                    JsString::from_rust_str(&index.to_string()),
                    JsValue::String(JsString::from_units(vec![*unit])),
                )
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn omitted(source: &JsValue, reason: &str) -> JsValue {
    let mut entry: Vec<(JsString, JsValue)> = Vec::new();
    if let Some(id) = field(Some(source), "id") {
        entry.push((JsString::from_rust_str("id"), id.clone()));
    }
    entry.push((
        JsString::from_rust_str("reason"),
        JsValue::String(JsString::from_rust_str(reason)),
    ));
    JsValue::Object(entry)
}

fn normalize_budget(budget: Option<&JsValue>) -> f64 {
    let raw = budget.map_or(8000.0, coerce::js_to_number);
    let raw = if raw == 0.0 || raw.is_nan() { 0.0 } else { raw };
    raw.floor().max(0.0)
}

fn text_or_empty(value: Option<&JsValue>) -> JsString {
    match value {
        Some(value) if coerce::truthy(value) => coerce::js_to_string(value),
        _ => JsString::new(),
    }
}

fn string_value(text: &str) -> JsValue {
    JsValue::String(JsString::from_rust_str(text))
}

fn number(number: f64) -> JsValue {
    JsValue::Number(number)
}

/// `selectContext(candidates, {budget, header, footer})`. Candidates arrive
/// already ordered by the JS bridge (localeCompare stays there).
pub fn select_context(
    candidates: &[JsValue],
    budget: Option<&JsValue>,
    header: Option<&JsValue>,
    footer: Option<&JsValue>,
) -> JsValue {
    let limit = normalize_budget(budget);
    let header = header.map_or_else(JsString::new, coerce::js_to_string);
    let footer = footer.map_or_else(JsString::new, coerce::js_to_string);
    let mut sources: Vec<JsValue> = Vec::new();
    let mut omitted_items: Vec<JsValue> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut body = JsString::new();

    let estimate_of = |parts: &[&JsString]| -> f64 { estimate_units(&JsString::concat(parts)) };

    for source in candidates {
        let text = text_or_empty(field(Some(source), "excerpt"));
        let dedupe = match field(Some(source), "dedupeText") {
            Some(value) if coerce::truthy(value) => value.clone(),
            _ => JsValue::String(text.clone()),
        };
        let digest = sha256_json(&dedupe);
        if text.is_empty() || seen.contains(&digest) {
            omitted_items.push(omitted(source, "duplicate"));
            continue;
        }
        seen.insert(digest);
        let prefix = match field(Some(source), "label") {
            Some(label) if coerce::truthy(label) => {
                let mut prefix = JsString::from_rust_str("[");
                prefix.push(&coerce::js_to_string(label));
                prefix.push_str("]\n");
                prefix
            }
            _ => JsString::new(),
        };
        let max_tokens = match field(Some(source), "maxTokens") {
            Some(value) if coerce::truthy(value) => coerce::js_to_number(value),
            _ => f64::INFINITY,
        };
        let available = coerce::math_min(
            max_tokens,
            limit - estimate_of(&[&header, &body, &prefix, &newline(), &footer]) - 1.0,
        );
        let excerpt = if coerce::truthy_opt(field(Some(source), "atomic")) {
            if less_equal_number(estimate_units(&text), available) {
                text.clone()
            } else {
                JsString::new()
            }
        } else {
            clip_text(&text, available)
        };
        if excerpt.is_empty() || (excerpt != text && estimate_units(&excerpt) < 24.0) {
            omitted_items.push(omitted(source, "budget"));
            continue;
        }
        let mut chunk = prefix.clone();
        chunk.push(&excerpt);
        chunk.push(&newline());
        if estimate_of(&[&header, &body, &chunk, &footer]) > limit {
            omitted_items.push(omitted(source, "budget"));
            continue;
        }
        body.push(&chunk);
        let mut entry = spread_source(source);
        let version = match field(Some(source), "version") {
            Some(value) if coerce::truthy(value) => value.clone(),
            _ => JsValue::String(JsString::from_rust_str(&sha256_json(&JsValue::String(
                text.clone(),
            )))),
        };
        entry.push((JsString::from_rust_str("version"), version));
        entry.push((
            JsString::from_rust_str("excerpt"),
            JsValue::String(excerpt.clone()),
        ));
        entry.push((
            JsString::from_rust_str("truncated"),
            JsValue::Bool(
                matches!(field(Some(source), "truncated"), Some(JsValue::Bool(true)))
                    || excerpt != text,
            ),
        ));
        entry.push((
            JsString::from_rust_str("estimatedTokens"),
            number(estimate_units(&chunk)),
        ));
        sources.push(JsValue::Object(entry));
    }

    let text = if body.is_empty() {
        JsString::new()
    } else {
        JsString::concat(&[&header, &body, &footer])
    };
    let mut budget_object: Vec<(JsString, JsValue)> = Vec::new();
    let mut result: Vec<(JsString, JsValue)> = Vec::new();
    if limit.is_finite() {
        budget_object.push((JsString::from_rust_str("limit"), number(limit)));
    } else {
        budget_object.push((JsString::from_rust_str("limit"), JsValue::Null));
        result.push((
            JsString::from_rust_str("budgetInfinite"),
            JsValue::Bool(true),
        ));
    }
    budget_object.push((
        JsString::from_rust_str("used"),
        number(estimate_units(&text)),
    ));
    budget_object.push((JsString::from_rust_str("managedOnly"), JsValue::Bool(true)));
    result.insert(0, (JsString::from_rust_str("text"), JsValue::String(text)));
    result.insert(
        1,
        (JsString::from_rust_str("sources"), JsValue::Array(sources)),
    );
    result.insert(
        2,
        (
            JsString::from_rust_str("omitted"),
            JsValue::Array(omitted_items),
        ),
    );
    result.insert(
        3,
        (
            JsString::from_rust_str("budget"),
            JsValue::Object(budget_object),
        ),
    );
    JsValue::Object(result)
}

// ── String-in entry points for the addon ───────────────────────────────────

fn parse(input: &str) -> Result<JsValue, String> {
    json_parse(input).map_err(|error| format!("context_selection_invalid_input: {error}"))
}

fn argument<'a>(input: &'a JsValue, key: &str) -> Option<&'a JsValue> {
    field(Some(input), key)
}

fn stringify(value: &JsValue) -> Result<String, String> {
    json_stringify(value).ok_or_else(|| "context_selection_unserializable_output".to_string())
}

pub fn terms_json(input: &str) -> Result<String, String> {
    let value = parse(input)?;
    let terms = terms_from(argument(&value, "value").unwrap_or(&NULL));
    stringify(&JsValue::Array(
        terms.into_iter().map(|term| string_value(&term)).collect(),
    ))
}

pub fn relevance_json(input: &str) -> Result<String, String> {
    let value = parse(input)?;
    stringify(&number(relevance(
        argument(&value, "query").unwrap_or(&NULL),
        argument(&value, "text").unwrap_or(&NULL),
    ) as f64))
}

pub fn min_relevance_json(input: &str) -> Result<String, String> {
    let value = parse(input)?;
    stringify(&number(min_relevance(
        argument(&value, "query").unwrap_or(&NULL),
    )))
}

pub fn clip_tokens_json(input: &str) -> Result<String, String> {
    let value = parse(input)?;
    let clipped = clip_tokens_with(
        argument(&value, "text").unwrap_or(&NULL),
        argument(&value, "budget").unwrap_or(&NULL),
        matches!(argument(&value, "textUndefined"), Some(JsValue::Bool(true))),
    )?;
    stringify(&clipped)
}

pub fn select_context_json(input: &str) -> Result<String, String> {
    let value = parse(input)?;
    let candidates = match argument(&value, "candidates") {
        Some(JsValue::Array(items)) => items.clone(),
        _ => Vec::new(),
    };
    stringify(&select_context(
        &candidates,
        argument(&value, "budget"),
        argument(&value, "header"),
        argument(&value, "footer"),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::js::serde::from_serde;
    use serde_json::json;

    fn js(value: serde_json::Value) -> JsValue {
        from_serde(&value)
    }

    #[test]
    fn terms_mix_ascii_runs_and_cjk_bigrams() {
        assert_eq!(
            terms_from(&js(json!("DB-tune 数据库性能"))),
            vec!["db-tune", "数据", "据库", "库性", "性能"]
        );
        assert_eq!(terms_from(&js(json!("ok x y"))), vec!["ok"]);
        assert_eq!(terms_from(&js(json!(""))), Vec::<String>::new());
        assert_eq!(terms_from(&js(json!(null))), Vec::<String>::new());
    }

    #[test]
    fn ascii_terms_match_whole_words_only() {
        assert_eq!(relevance(&js(json!("ok")), &js(json!("token hook"))), 0);
        assert_eq!(relevance(&js(json!("ok")), &js(json!("it is ok now"))), 1);
        assert_eq!(
            relevance(&js(json!("db-tune")), &js(json!("run db-tune."))),
            1
        );
        // 数据库 yields the bigrams 数据 + 据库; both occur in the haystack.
        assert_eq!(relevance(&js(json!("数据库")), &js(json!("数据库性能"))), 2);
    }

    #[test]
    fn min_relevance_scales_with_query_length() {
        assert_eq!(min_relevance(&js(json!("ok"))), 1.0);
        assert_eq!(min_relevance(&js(json!("数据库性能调优"))), 2.0);
        assert_eq!(min_relevance(&js(json!(""))), 1.0);
    }

    #[test]
    fn estimate_tokens_counts_utf16_units() {
        assert_eq!(estimate_tokens(Some(&js(json!("")))), 0.0);
        assert_eq!(estimate_tokens(Some(&js(json!("abcdefgh")))), 2.0);
        assert_eq!(estimate_tokens(Some(&js(json!("数据库")))), 5.0);
        assert_eq!(estimate_tokens(Some(&js(json!("a😀")))), 1.0);
    }

    #[test]
    fn clip_tokens_respects_budget_and_surrogate_boundaries() {
        assert_eq!(
            clip_tokens(&js(json!("short")), &js(json!(10))).unwrap(),
            js(json!("short"))
        );
        // "abcd…" costs one token (5 non-CJK units -> round(1.25)); five
        // letters plus the ellipsis already rounds to two.
        assert_eq!(
            clip_tokens(&js(json!("abcdefgh")), &js(json!(1))).unwrap(),
            js(json!("abcd…"))
        );
        assert_eq!(
            clip_tokens(&js(json!("abcdefgh")), &js(json!(0))).unwrap(),
            js(json!(""))
        );
        // The surrogate-pair boundary never leaks a lone high surrogate.
        assert_eq!(
            clip_tokens(&js(json!("😀😀😀")), &js(json!(1))).unwrap(),
            js(json!("😀😀…"))
        );
    }

    #[test]
    fn select_context_dedupes_and_marks_budget_omissions() {
        let selected = select_context(
            &[
                js(json!({ "id": "a", "excerpt": "数据库性能 cache", "priority": 10 })),
                js(json!({ "id": "b", "excerpt": "数据库性能 cache", "priority": 9 })),
                js(json!({ "id": "c", "excerpt": "另一个事实", "priority": 1 })),
            ],
            Some(&js(json!(8000))),
            Some(&js(json!(""))),
            Some(&js(json!(""))),
        );
        let sources = match &selected {
            JsValue::Object(entries) => entries
                .iter()
                .find(|(key, _)| key.to_string_lossy() == "sources")
                .map(|(_, value)| value)
                .expect("sources"),
            _ => panic!("object"),
        };
        let JsValue::Array(sources) = sources else {
            panic!("array")
        };
        assert_eq!(sources.len(), 2);
        let omitted_reason = field(Some(&selected), "omitted").and_then(|omitted| {
            let JsValue::Array(items) = omitted else {
                return None;
            };
            field(items.first(), "reason").cloned()
        });
        assert_eq!(omitted_reason, Some(string_value("duplicate")));
        let managed_only = field(Some(&selected), "budget")
            .and_then(|budget| field(Some(budget), "managedOnly").cloned());
        assert_eq!(managed_only, Some(JsValue::Bool(true)));
    }

    #[test]
    fn select_context_keeps_reference_identity_of_version_and_id() {
        let selected = select_context(
            &[js(
                json!({ "id": "a", "excerpt": "hello world", "version": 7 }),
            )],
            Some(&js(json!(100))),
            None,
            None,
        );
        let JsValue::Array(sources) = field(Some(&selected), "sources").expect("sources") else {
            panic!("array")
        };
        let first = sources.first().expect("source");
        assert_eq!(field(Some(first), "version"), Some(&number(7.0)));
        assert!(field(Some(first), "truncated").is_some());
    }

    #[test]
    fn json_entry_points_are_lenient_at_the_boundary() {
        // A lone surrogate escape survives as its code unit; "ab" still
        // registers as one ASCII term.
        let raw = "{\"value\":\"ab\\ud834\"}";
        let parsed = json_parse(&terms_json(raw).unwrap()).unwrap();
        assert_eq!(parsed, js(json!(["ab"])));
        let selected = json_parse(&select_context_json("{\"candidates\":[]}").unwrap()).unwrap();
        assert_eq!(field(Some(&selected), "text"), Some(&string_value("")));
    }
}
