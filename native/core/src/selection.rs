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
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

use crate::js::serde::{
    js_json_stringify, js_less_equal, js_math_min, js_string, js_string_or_empty, js_to_number,
    number_value, truthy, truthy_opt, utf16_len, utf16_prefix, value_or_empty,
};

const MAX_TERMS: usize = 256;

fn ascii_term_run(byte: u8) -> bool {
    byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'.' | b'/' | b'-')
}

fn is_cjk_letter(character: char) -> bool {
    matches!(character, '\u{3400}'..='\u{9FFF}')
}

fn is_cjk_token(character: char) -> bool {
    matches!(
        character,
        '\u{3400}'..='\u{4DBF}'
            | '\u{4E00}'..='\u{9FFF}'
            | '\u{F900}'..='\u{FAFF}'
            | '\u{3040}'..='\u{309F}'
            | '\u{30A0}'..='\u{30FF}'
            | '\u{AC00}'..='\u{D7AF}'
    )
}

fn push_unique(result: &mut Vec<String>, seen: &mut HashSet<String>, term: String) {
    if seen.insert(term.clone()) {
        result.push(term);
    }
}

/// `terms(value)`: lowercased ASCII runs plus CJK bigrams, deduped in first-seen
/// order and capped at 256.
pub fn terms_from(value: &Value) -> Vec<String> {
    let text = if truthy(value) {
        js_string(value)
    } else {
        String::new()
    }
    .to_lowercase();
    let mut result = Vec::new();
    let mut seen = HashSet::new();

    let bytes = text.as_bytes();
    let mut at = 0usize;
    while at < bytes.len() {
        if ascii_term_run(bytes[at]) {
            let start = at;
            while at < bytes.len() && ascii_term_run(bytes[at]) {
                at += 1;
            }
            if at - start >= 2 {
                push_unique(&mut result, &mut seen, text[start..at].to_string());
            }
        } else {
            at += 1;
        }
    }

    let mut run: Vec<char> = Vec::new();
    let flush = |run: &mut Vec<char>, result: &mut Vec<String>, seen: &mut HashSet<String>| {
        for index in 0..run.len().saturating_sub(1) {
            push_unique(result, seen, format!("{}{}", run[index], run[index + 1]));
        }
        run.clear();
    };
    for character in text.chars() {
        if is_cjk_letter(character) {
            run.push(character);
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

/// `relevance(query, text)`: count of query terms hit in the lowercased text.
pub fn relevance(query: &Value, text: &Value) -> usize {
    let tokens = terms_from(query);
    let haystack = if truthy(text) {
        js_string(text)
    } else {
        String::new()
    }
    .to_lowercase();
    tokens
        .iter()
        .filter(|term| term_hit(&haystack, term))
        .count()
}

/// `minRelevance(query)`: at least 1 (2 from four terms), or 15 % of terms.
pub fn min_relevance(query: &Value) -> f64 {
    let count = terms_from(query).len() as f64;
    let floor: f64 = if count >= 4.0 { 2.0 } else { 1.0 };
    floor.max((count * 0.15).ceil())
}

/// `estimateTokens(value)` from `src/task-shell/context.js`, kept on the JS
/// side for its other callers but reproduced here for selection.
pub fn estimate_tokens(value: &Value) -> f64 {
    let text = js_string_or_empty(Some(value));
    if text.is_empty() {
        return 0.0;
    }
    let mut cjk = 0usize;
    let mut length = 0usize;
    for character in text.chars() {
        length += character.len_utf16();
        if is_cjk_token(character) {
            cjk += 1;
        }
    }
    let raw = cjk as f64 * 1.5 + (length - cjk) as f64 / 4.0;
    (raw + 0.5).floor().max(1.0)
}

fn estimate_text(text: &str) -> f64 {
    estimate_tokens(&Value::String(text.to_string()))
}

fn sha256_json(value: &Value) -> String {
    format!("{:x}", Sha256::digest(js_json_stringify(value).as_bytes()))
}

fn less_equal_number(left: f64, right: f64) -> bool {
    !right.is_nan() && left <= right
}

fn clip_text(text: &str, budget: f64) -> String {
    if less_equal_number(estimate_text(text), budget) {
        return text.to_string();
    }
    // `budget < estimateTokens('…')` (a single non-CJK character costs 1).
    if !budget.is_nan() && budget < estimate_text("…") {
        return String::new();
    }
    let mut lo: i64 = 0;
    let mut hi: i64 = utf16_len(text) as i64;
    while lo < hi {
        let mid = (((lo + hi) as f64) / 2.0).ceil() as i64;
        // No surrogate stripping inside the search: JS counts a lone trailing
        // high surrogate as one code unit, and U+FFFD (lossy conversion) has
        // the same length and is likewise non-CJK.
        let units = utf16_prefix(text, mid as usize);
        let piece = format!("{}…", String::from_utf16_lossy(&units));
        if less_equal_number(estimate_text(&piece), budget) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    let mut units = utf16_prefix(text, lo.max(0) as usize);
    if units
        .last()
        .is_some_and(|unit| (0xD800..=0xDBFF).contains(unit))
    {
        units.pop();
    }
    format!("{}…", String::from_utf16_lossy(&units))
}

/// `clipTokens(text, budget)`. Non-string inputs that fit the budget are
/// returned untouched, exactly like the JS original.
pub fn clip_tokens(text: &Value, budget: &Value) -> Result<Value, String> {
    clip_tokens_with(text, budget, false)
}

/// `text_undefined` only selects the engine-style TypeError wording: JSON
/// cannot carry the difference between an absent property and `null`, while
/// `String(undefined)` and `String(null)` both read as `''`.
pub fn clip_tokens_with(
    text: &Value,
    budget: &Value,
    text_undefined: bool,
) -> Result<Value, String> {
    if js_less_equal(estimate_tokens(text), budget) {
        return Ok(text.clone());
    }
    let budget_number = js_to_number(budget);
    if !budget_number.is_nan() && budget_number < estimate_text("…") {
        return Ok(Value::String(String::new()));
    }
    match text {
        Value::String(value) => Ok(Value::String(clip_text(value, budget_number))),
        Value::Null => Err(if text_undefined {
            "context_selection_type_error: Cannot read properties of undefined (reading 'length')"
                .to_string()
        } else {
            "context_selection_type_error: Cannot read properties of null (reading 'length')"
                .to_string()
        }),
        // An array has `slice`, so the failure surfaces on `.replace` instead.
        Value::Array(_) => Err(
            "context_selection_type_error: text.slice(...).replace is not a function".to_string(),
        ),
        _ => Err("context_selection_type_error: text.slice is not a function".to_string()),
    }
}

fn field<'a>(container: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    container
        .and_then(Value::as_object)
        .and_then(|object| object.get(key))
}

/// Spread a candidate into a result object. Strings expose UTF-16 index
/// properties like JS own enumerable string keys; other primitives expose none.
fn spread_source(source: &Value) -> Map<String, Value> {
    match source {
        Value::Object(object) => object.clone(),
        Value::String(text) => text
            .encode_utf16()
            .enumerate()
            .map(|(index, unit)| {
                (
                    index.to_string(),
                    Value::String(String::from_utf16_lossy(&[unit])),
                )
            })
            .collect(),
        _ => Map::new(),
    }
}

fn omitted(source: &Value, reason: &str) -> Value {
    let mut entry = Map::new();
    if let Some(id) = field(Some(source), "id") {
        entry.insert("id".to_string(), id.clone());
    }
    entry.insert("reason".to_string(), Value::String(reason.to_string()));
    Value::Object(entry)
}

fn normalize_budget(budget: Option<&Value>) -> f64 {
    let raw = budget.map_or(8000.0, js_to_number);
    let raw = if raw == 0.0 || raw.is_nan() { 0.0 } else { raw };
    raw.floor().max(0.0)
}

/// `selectContext(candidates, {budget, header, footer})`. Candidates arrive
/// already ordered by the JS bridge (localeCompare stays there).
pub fn select_context(
    candidates: &[Value],
    budget: Option<&Value>,
    header: Option<&Value>,
    footer: Option<&Value>,
) -> Value {
    let limit = normalize_budget(budget);
    let header = header.map_or_else(String::new, js_string);
    let footer = footer.map_or_else(String::new, js_string);
    let mut sources: Vec<Value> = Vec::new();
    let mut omitted_items: Vec<Value> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut body = String::new();

    for source in candidates {
        let text = value_or_empty(field(Some(source), "excerpt"));
        let dedupe = match field(Some(source), "dedupeText") {
            Some(value) if truthy(value) => value.clone(),
            _ => Value::String(text.clone()),
        };
        let digest = sha256_json(&dedupe);
        if text.is_empty() || seen.contains(&digest) {
            omitted_items.push(omitted(source, "duplicate"));
            continue;
        }
        seen.insert(digest);
        let prefix = match field(Some(source), "label") {
            Some(label) if truthy(label) => format!("[{}]\n", js_string(label)),
            _ => String::new(),
        };
        let max_tokens = match field(Some(source), "maxTokens") {
            Some(value) if truthy(value) => js_to_number(value),
            _ => f64::INFINITY,
        };
        let available = js_math_min(
            max_tokens,
            limit - estimate_text(&format!("{header}{body}{prefix}\n{footer}")) - 1.0,
        );
        let excerpt = if truthy_opt(field(Some(source), "atomic")) {
            if less_equal_number(estimate_text(&text), available) {
                text.clone()
            } else {
                String::new()
            }
        } else {
            clip_text(&text, available)
        };
        if excerpt.is_empty() || (excerpt != text && estimate_text(&excerpt) < 24.0) {
            omitted_items.push(omitted(source, "budget"));
            continue;
        }
        let chunk = format!("{prefix}{excerpt}\n");
        if estimate_text(&format!("{header}{body}{chunk}{footer}")) > limit {
            omitted_items.push(omitted(source, "budget"));
            continue;
        }
        body.push_str(&chunk);
        let mut entry = spread_source(source);
        let version = match field(Some(source), "version") {
            Some(value) if truthy(value) => value.clone(),
            _ => Value::String(sha256_json(&Value::String(text.clone()))),
        };
        entry.insert("version".to_string(), version);
        entry.insert("excerpt".to_string(), Value::String(excerpt.clone()));
        entry.insert(
            "truncated".to_string(),
            Value::Bool(
                matches!(field(Some(source), "truncated"), Some(Value::Bool(true)))
                    || excerpt != text,
            ),
        );
        entry.insert(
            "estimatedTokens".to_string(),
            number_value(estimate_text(&chunk)),
        );
        sources.push(Value::Object(entry));
    }

    let text = if body.is_empty() {
        String::new()
    } else {
        format!("{header}{body}{footer}")
    };
    let mut budget_object = Map::new();
    let mut result = Map::new();
    if limit.is_finite() {
        budget_object.insert("limit".to_string(), number_value(limit));
    } else {
        budget_object.insert("limit".to_string(), Value::Null);
        result.insert("budgetInfinite".to_string(), Value::Bool(true));
    }
    budget_object.insert("used".to_string(), number_value(estimate_text(&text)));
    budget_object.insert("managedOnly".to_string(), Value::Bool(true));
    result.insert("text".to_string(), Value::String(text));
    result.insert("sources".to_string(), Value::Array(sources));
    result.insert("omitted".to_string(), Value::Array(omitted_items));
    result.insert("budget".to_string(), Value::Object(budget_object));
    Value::Object(result)
}

// ── String-in entry points for the addon ───────────────────────────────────

fn parse(input: &str) -> Result<Value, String> {
    crate::json_lenient::from_str(input)
        .map_err(|error| format!("context_selection_invalid_input: {error}"))
}

fn argument<'a>(input: &'a Value, key: &str) -> Option<&'a Value> {
    input.as_object().and_then(|object| object.get(key))
}

pub fn terms_json(input: &str) -> Result<String, String> {
    let value = parse(input)?;
    Ok(Value::Array(
        terms_from(argument(&value, "value").unwrap_or(&Value::Null))
            .into_iter()
            .map(Value::String)
            .collect(),
    )
    .to_string())
}

pub fn relevance_json(input: &str) -> Result<String, String> {
    let value = parse(input)?;
    Ok(number_value(relevance(
        argument(&value, "query").unwrap_or(&Value::Null),
        argument(&value, "text").unwrap_or(&Value::Null),
    ) as f64)
    .to_string())
}

pub fn min_relevance_json(input: &str) -> Result<String, String> {
    let value = parse(input)?;
    Ok(number_value(min_relevance(
        argument(&value, "query").unwrap_or(&Value::Null),
    ))
    .to_string())
}

pub fn clip_tokens_json(input: &str) -> Result<String, String> {
    let value = parse(input)?;
    let clipped = clip_tokens_with(
        argument(&value, "text").unwrap_or(&Value::Null),
        argument(&value, "budget").unwrap_or(&Value::Null),
        argument(&value, "textUndefined")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    )?;
    Ok(clipped.to_string())
}

pub fn select_context_json(input: &str) -> Result<String, String> {
    let value = parse(input)?;
    let candidates = argument(&value, "candidates")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok(select_context(
        &candidates,
        argument(&value, "budget"),
        argument(&value, "header"),
        argument(&value, "footer"),
    )
    .to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn terms_mix_ascii_runs_and_cjk_bigrams() {
        assert_eq!(
            terms_from(&json!("DB-tune 数据库性能")),
            vec!["db-tune", "数据", "据库", "库性", "性能"]
        );
        assert_eq!(terms_from(&json!("ok x y")), vec!["ok"]);
        assert_eq!(terms_from(&json!("")), Vec::<String>::new());
        assert_eq!(terms_from(&json!(null)), Vec::<String>::new());
    }

    #[test]
    fn ascii_terms_match_whole_words_only() {
        assert_eq!(relevance(&json!("ok"), &json!("token hook")), 0);
        assert_eq!(relevance(&json!("ok"), &json!("it is ok now")), 1);
        assert_eq!(relevance(&json!("db-tune"), &json!("run db-tune.")), 1);
        // 数据库 yields the bigrams 数据 + 据库; both occur in the haystack.
        assert_eq!(relevance(&json!("数据库"), &json!("数据库性能")), 2);
    }

    #[test]
    fn min_relevance_scales_with_query_length() {
        assert_eq!(min_relevance(&json!("ok")), 1.0);
        assert_eq!(min_relevance(&json!("数据库性能调优")), 2.0);
        assert_eq!(min_relevance(&json!("")), 1.0);
    }

    #[test]
    fn estimate_tokens_counts_utf16_units() {
        assert_eq!(estimate_tokens(&json!("")), 0.0);
        assert_eq!(estimate_tokens(&json!("abcdefgh")), 2.0);
        assert_eq!(estimate_tokens(&json!("数据库")), 5.0);
        assert_eq!(estimate_tokens(&json!("a😀")), 1.0);
    }

    #[test]
    fn clip_tokens_respects_budget_and_surrogate_boundaries() {
        assert_eq!(
            clip_tokens(&json!("short"), &json!(10)).unwrap(),
            json!("short")
        );
        // "abcd…" costs one token (5 non-CJK units -> round(1.25)); five
        // letters plus the ellipsis already rounds to two.
        assert_eq!(
            clip_tokens(&json!("abcdefgh"), &json!(1)).unwrap(),
            json!("abcd…")
        );
        assert_eq!(
            clip_tokens(&json!("abcdefgh"), &json!(0)).unwrap(),
            json!("")
        );
        // The surrogate-pair boundary never leaks a lone high surrogate.
        assert_eq!(
            clip_tokens(&json!("😀😀😀"), &json!(1)).unwrap(),
            json!("😀😀…")
        );
    }

    #[test]
    fn select_context_dedupes_and_marks_budget_omissions() {
        let selected = select_context(
            &[
                json!({ "id": "a", "excerpt": "数据库性能 cache", "priority": 10 }),
                json!({ "id": "b", "excerpt": "数据库性能 cache", "priority": 9 }),
                json!({ "id": "c", "excerpt": "另一个事实", "priority": 1 }),
            ],
            Some(&json!(8000)),
            Some(&json!("")),
            Some(&json!("")),
        );
        assert_eq!(selected["sources"].as_array().unwrap().len(), 2);
        assert_eq!(selected["omitted"][0]["reason"], "duplicate");
        assert_eq!(selected["budget"]["managedOnly"], true);
    }

    #[test]
    fn select_context_keeps_reference_identity_of_version_and_id() {
        let selected = select_context(
            &[json!({ "id": "a", "excerpt": "hello world", "version": 7 })],
            Some(&json!(100)),
            None,
            None,
        );
        assert_eq!(selected["sources"][0]["version"], 7);
        assert!(selected["sources"][0].get("truncated").is_some());
    }

    #[test]
    fn json_entry_points_are_lenient_at_the_boundary() {
        // A lone surrogate escape is sanitized before serde sees it; "ab"
        // still survives as one ASCII term.
        let raw = "{\"value\":\"ab\\ud834\"}";
        let parsed: Value = serde_json::from_str(&terms_json(raw).unwrap()).unwrap();
        assert_eq!(parsed, json!(["ab"]));
        let selected: Value =
            serde_json::from_str(&select_context_json("{\"candidates\":[]}").unwrap()).unwrap();
        assert_eq!(selected["text"], "");
    }
}
