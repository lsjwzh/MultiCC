//! Pure semantics of `GET /api/providers/limit-history` (was
//! src/routes/provider-limit-history.js): query parsing, the `sinceMs` /
//! `points` arithmetic and the response shape. The identity list comes from
//! [`crate::provider_catalog`], the storage from [`crate::quota_history`]; the
//! gateway handler only adds auth, timers and HTTP.
use serde_json::{json, Value};

use crate::http_gate::{query_value, QueryValue};
use crate::js::serde::{js_json_stringify, js_string_to_number, number_value};
use crate::js::string::{js_trim, utf16_prefix};

const DAY_MS: f64 = 24.0 * 60.0 * 60.0 * 1000.0;
const MAX_POINTS: f64 = 240.0;
const MAX_AGE_MS: f64 = 90.0 * DAY_MS;
const MAX_PROVIDERS: usize = 64;

fn bounded_text(value: &QueryValue, max: usize) -> String {
    let QueryValue::Text(text) = value else {
        return String::new();
    };
    let trimmed = js_trim(text);
    if trimmed.is_empty() {
        String::new()
    } else {
        utf16_prefix(trimmed, max)
    }
}

/// `Number(queryValue)`: `undefined` is NaN, arrays join with `,` (recursively,
/// so `Number([['5']])` is 5), objects are NaN.
fn query_number(value: &QueryValue) -> f64 {
    match value {
        QueryValue::Missing | QueryValue::Object => f64::NAN,
        QueryValue::Text(text) => js_string_to_number(text),
        QueryValue::List(items) => js_string_to_number(&js_array_to_string(items)),
    }
}

/// `Array.prototype.toString`: nested arrays join recursively, objects become
/// `[object Object]` (which `Number()` rejects).
fn js_array_to_string(items: &[QueryValue]) -> String {
    items
        .iter()
        .map(|item| match item {
            QueryValue::Missing => String::new(),
            QueryValue::Text(text) => text.clone(),
            QueryValue::List(items) => js_array_to_string(items),
            QueryValue::Object => "[object Object]".to_string(),
        })
        .collect::<Vec<String>>()
        .join(",")
}

/// `Math.trunc(number) || fallback` (JS truthiness: 0 and NaN are falsy).
fn trunc_or(number: f64, fallback: f64) -> f64 {
    let truncated = number.trunc();
    if truncated == 0.0 || truncated.is_nan() {
        fallback
    } else {
        truncated
    }
}

/// The three values the route derives before it touches the store.
#[derive(Debug, Clone, PartialEq)]
pub struct Params {
    pub range: String,
    pub requested_since: f64,
    pub points: f64,
    pub app_type: String,
    pub id: String,
}

pub fn params(original_url: &str) -> Params {
    let range = bounded_text(&query_value(original_url, "range"), 8);
    let range = if range.is_empty() {
        "24h".to_string()
    } else {
        range
    };
    let points = query_number(&query_value(original_url, "points"));
    let points = MAX_POINTS.min(2.0f64.max(trunc_or(points, 48.0)));
    Params {
        range,
        requested_since: query_number(&query_value(original_url, "since")),
        points,
        app_type: bounded_text(&query_value(original_url, "appType"), 32),
        id: bounded_text(&query_value(original_url, "id"), 80),
    }
}

/// `RANGE_MS[range] || RANGE_MS['24h']`. `toString` and `valueOf` are the two
/// `Object.prototype` keys short enough to survive `boundedText(…, 8)`; the
/// route subtracted the inherited function and produced NaN (`sinceMs: null`).
fn range_ms(range: &str) -> f64 {
    match range {
        "24h" => DAY_MS,
        "7d" => 7.0 * DAY_MS,
        "30d" => 30.0 * DAY_MS,
        "toString" | "valueOf" => f64::NAN,
        _ => DAY_MS,
    }
}

pub fn since_ms(params: &Params, now_ms: i64) -> f64 {
    let current = now_ms as f64;
    if params.requested_since.is_finite() && params.requested_since > 0.0 {
        params.requested_since.max(current - MAX_AGE_MS)
    } else {
        current - range_ms(&params.range)
    }
}

/// The JSON handed to `RustQuotaHistory.query` (the adapter's `JSON.stringify`
/// of `{providers, sinceMs?, points?}`; non-finite values were omitted).
pub fn kernel_input(identities: &[Value], since_ms: f64, points: f64) -> String {
    let mut input = serde_json::Map::new();
    input.insert(
        "providers".to_string(),
        Value::Array(identities.iter().take(MAX_PROVIDERS).cloned().collect()),
    );
    if since_ms.is_finite() {
        input.insert("sinceMs".to_string(), number_value(since_ms.trunc()));
    }
    if points.is_finite() {
        input.insert("points".to_string(), number_value(points.trunc()));
    }
    js_json_stringify(&Value::Object(input))
}

/// `result.providers || {}` after the adapter's `JSON.parse`.
pub fn providers_of(output: &str) -> Value {
    match serde_json::from_str::<Value>(output) {
        Ok(value) => match value.get("providers") {
            Some(Value::Object(providers)) => Value::Object(providers.clone()),
            _ => json!({}),
        },
        Err(_) => json!({}),
    }
}

pub fn available_response(
    generated_at: i64,
    since_ms: f64,
    points: f64,
    providers: Value,
) -> Value {
    json!({
        "available": true,
        "generatedAt": generated_at,
        "sinceMs": number_value(since_ms),
        "points": number_value(points),
        "providers": providers,
    })
}

pub fn unavailable_response(generated_at: i64, since_ms: f64, points: f64) -> Value {
    json!({
        "available": false,
        "reason": "unavailable",
        "generatedAt": generated_at,
        "sinceMs": number_value(since_ms),
        "points": number_value(points),
        "providers": {},
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000_000;

    fn get(url: &str) -> Params {
        params(url)
    }

    fn points_of(query: &str) -> f64 {
        get(&format!("/api/providers/limit-history?{query}")).points
    }

    #[test]
    fn range_trimming_utf16_and_unknown_values() {
        assert_eq!(get("/api/providers/limit-history").range, "24h");
        assert_eq!(get("/x?range=7d").range, "7d");
        assert_eq!(get("/x?range=%20%207d%20").range, "7d");
        assert_eq!(get("/x?range=").range, "24h");
        assert_eq!(get("/x?range=123456789").range, "12345678");
        assert_eq!(get("/x?range=%E4%B8%AD%E6%96%87").range, "中文");
        // Repeated and `[]` forms are arrays, not strings.
        assert_eq!(get("/x?range=7d&range=30d").range, "24h");
        assert_eq!(get("/x?range[]=7d").range, "24h");
    }

    #[test]
    fn since_uses_the_requested_value_clamped_to_ninety_days() {
        let current = NOW as f64;
        assert_eq!(since_ms(&get("/x"), NOW), current - DAY_MS);
        assert_eq!(since_ms(&get("/x?range=7d"), NOW), current - 7.0 * DAY_MS);
        assert_eq!(since_ms(&get("/x?range=30d"), NOW), current - 30.0 * DAY_MS);
        assert_eq!(since_ms(&get("/x?range=1d"), NOW), current - DAY_MS);
        assert_eq!(since_ms(&get("/x?since=123"), NOW), current - MAX_AGE_MS);
        assert_eq!(
            since_ms(&get(&format!("/x?since={}", NOW - 1000)), NOW),
            (NOW - 1000) as f64
        );
        assert_eq!(since_ms(&get("/x?since=-1"), NOW), current - DAY_MS);
        assert_eq!(since_ms(&get("/x?since=0"), NOW), current - DAY_MS);
        assert_eq!(since_ms(&get("/x?since="), NOW), current - DAY_MS);
        assert_eq!(since_ms(&get("/x?since=1e309"), NOW), current - DAY_MS);
        assert_eq!(since_ms(&get("/x?since=0x10"), NOW), current - MAX_AGE_MS);
        assert_eq!(since_ms(&get("/x?since=1e3"), NOW), current - MAX_AGE_MS);
        assert_eq!(
            since_ms(&get(&format!("/x?since={}", NOW)), NOW),
            NOW as f64
        );
        // `Object.prototype.toString` / `valueOf` made the subtraction NaN.
        assert!(since_ms(&get("/x?range=toString"), NOW).is_nan());
        assert!(since_ms(&get("/x?range=valueOf"), NOW).is_nan());
    }

    #[test]
    fn since_reads_single_element_arrays_and_ignores_repeated_ones() {
        let current = NOW as f64;
        assert_eq!(
            since_ms(&get(&format!("/x?since[]={}", NOW - 5)), NOW),
            (NOW - 5) as f64
        );
        assert_eq!(since_ms(&get("/x?since=1&since=2"), NOW), current - DAY_MS);
        assert_eq!(since_ms(&get("/x?since[a]=1"), NOW), current - DAY_MS);
        assert_eq!(
            since_ms(&get(&format!("/x?since[0]={}", NOW - 7)), NOW),
            (NOW - 7) as f64
        );
        assert_eq!(
            since_ms(&get(&format!("/x?since[0]={}&since[1]=1", NOW - 9)), NOW),
            current - DAY_MS
        );
    }

    #[test]
    fn range_reads_single_element_arrays_but_not_named_objects() {
        assert_eq!(get("/x?range[0]=7d").range, "24h");
        assert_eq!(get("/x?range[]=7d").range, "24h");
        assert_eq!(get("/x?range=7d&range=30d").range, "24h");
    }

    #[test]
    fn points_match_javascript_number_and_trunc_rules() {
        assert_eq!(points_of("points=0"), 48.0);
        assert_eq!(points_of("points=1"), 2.0);
        assert_eq!(points_of("points=2"), 2.0);
        assert_eq!(points_of("points=240"), 240.0);
        assert_eq!(points_of("points=241"), 240.0);
        assert_eq!(points_of("points=9999"), 240.0);
        assert_eq!(points_of("points=-5"), 2.0);
        assert_eq!(points_of("points=2.9"), 2.0);
        assert_eq!(points_of("points=abc"), 48.0);
        assert_eq!(points_of("points="), 48.0);
        assert_eq!(points_of("points=1e309"), 240.0);
        assert_eq!(points_of("points=-1e309"), 2.0);
        assert_eq!(points_of("points=%20%207%20"), 7.0);
        assert_eq!(points_of("points=5&points=6"), 48.0);
        assert_eq!(points_of("points[]=5"), 5.0);
        assert_eq!(points_of("points[k]=5"), 48.0);
        // qs numeric indexes: one index compacts to a one-element array, two
        // indexes join with ',' and become NaN, and 1000 is an object.
        assert_eq!(points_of("points[0]=5"), 5.0);
        assert_eq!(points_of("points[1]=5"), 5.0);
        assert_eq!(points_of("points[0]=5&points[1]=6"), 48.0);
        assert_eq!(points_of("points[20]=5"), 5.0);
        assert_eq!(points_of("points[21]=5"), 5.0);
        assert_eq!(points_of("points[1000]=5"), 48.0);
        assert_eq!(points_of("points%5B0%5D=5"), 5.0);
        assert_eq!(points_of("points[0][0]=5"), 5.0);
        assert_eq!(points_of("points[0]=5&points[]=6"), 48.0);
    }

    #[test]
    fn app_type_and_id_are_trimmed_and_capped_by_utf16_units() {
        let value = get("/x?appType=%20claude%20");
        assert_eq!(value.app_type, "claude");
        let value = get("/x?appType=CLAUDE");
        assert_eq!(value.app_type, "CLAUDE");
        let long = "x".repeat(81);
        assert_eq!(get(&format!("/x?id={long}")).id, "x".repeat(80));
        let emoji = "%F0%9F%98%80".repeat(41);
        assert_eq!(
            utf16_prefix(&"😀".repeat(41), 80),
            get(&format!("/x?id={emoji}")).id
        );
    }

    #[test]
    fn response_key_order_matches_the_route() {
        let text = js_json_stringify(&available_response(7, 1.0, 48.0, json!({})));
        assert!(text.starts_with(
            "{\"available\":true,\"generatedAt\":7,\"sinceMs\":1,\"points\":48,\"providers\":{}"
        ));
        let text = js_json_stringify(&unavailable_response(7, f64::NAN, 48.0));
        assert_eq!(
            text,
            "{\"available\":false,\"reason\":\"unavailable\",\"generatedAt\":7,\"sinceMs\":null,\"points\":48,\"providers\":{}}"
        );
    }

    #[test]
    fn kernel_input_omits_non_finite_numbers_and_caps_providers() {
        let many: Vec<Value> = (0..70)
            .map(|index| json!({"appType": "claude", "providerId": index.to_string()}))
            .collect();
        let text = kernel_input(&many, f64::NAN, 48.0);
        assert!(text.starts_with("{\"providers\":["));
        assert!(text.ends_with("],\"points\":48}"));
        assert_eq!(text.matches("providerId").count(), 64);
        assert!(!text.contains("sinceMs"));
        let text = kernel_input(&[], 1.9, 2.9);
        assert_eq!(text, "{\"providers\":[],\"sinceMs\":1,\"points\":2}");
    }
}
