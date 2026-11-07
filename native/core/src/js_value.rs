//! JavaScript value semantics shared by the migrated pure-logic kernels.
//!
//! The JS modules these kernels replace operate on ordinary JS values, so the
//! Rust side must reproduce `String()`, `Number()`, `trim()`, JSON number
//! formatting and JSON stringification exactly. Lone UTF-16 surrogates cannot
//! cross a napi string at all (they become U+FFFD); every other difference is
//! pinned by the parity harness.
use serde_json::{Map, Value};

/// JS truthiness (`value || fallback`, `if (value)`).
pub fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number
            .as_f64()
            .is_some_and(|float| float != 0.0 && !float.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

pub fn truthy_opt(value: Option<&Value>) -> bool {
    value.is_some_and(truthy)
}

/// ECMAScript `Number.prototype.toString` for an already parsed JSON number.
pub fn number_to_js_string(number: &serde_json::Number) -> String {
    if let Some(integer) = number.as_i64() {
        return integer.to_string();
    }
    if let Some(integer) = number.as_u64() {
        return integer.to_string();
    }
    format_f64(number.as_f64().unwrap_or(f64::NAN))
}

/// ECMAScript `String(number)`.
pub fn format_f64(number: f64) -> String {
    if number.is_nan() {
        return "NaN".to_string();
    }
    if number == f64::INFINITY {
        return "Infinity".to_string();
    }
    if number == f64::NEG_INFINITY {
        return "-Infinity".to_string();
    }
    // JS prints both zeros as "0"; ryu-js matches ECMAScript for everything.
    if number == 0.0 {
        return "0".to_string();
    }
    let mut buffer = ryu_js::Buffer::new();
    buffer.format(number).to_string()
}

/// `String(value)` for JSON values. Array holes (absent values) read as null
/// and join as empty strings, like `Array.prototype.toString`.
pub fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number_to_js_string(number),
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => js_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// `value == null ? '' : String(value)` used by `estimateTokens`.
pub fn js_string_or_empty(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(other) => js_string(other),
    }
}

/// `String(value || '')`.
pub fn value_or_empty(value: Option<&Value>) -> String {
    match value {
        Some(other) if truthy(other) => js_string(other),
        _ => String::new(),
    }
}

/// The exact character set `String.prototype.trim` removes. Rust's
/// `str::trim` differs on U+0085 (JS keeps it) and U+FEFF (JS removes it).
fn is_js_trim_space(character: char) -> bool {
    matches!(
        character,
        '\u{0009}'
            | '\u{000A}'
            | '\u{000B}'
            | '\u{000C}'
            | '\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// `String.prototype.trim`.
pub fn js_trim(text: &str) -> &str {
    let start = text
        .char_indices()
        .find(|(_, character)| !is_js_trim_space(*character))
        .map_or(text.len(), |(index, _)| index);
    let end = text
        .char_indices()
        .rev()
        .find(|(_, character)| !is_js_trim_space(*character))
        .map_or(start, |(index, character)| index + character.len_utf8());
    &text[start..end]
}

/// UTF-16 code-unit length (`String.prototype.length`).
pub fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// First `end` UTF-16 code units of `text`, as code units. A boundary that
/// splits a surrogate pair leaves a lone code unit for the caller to handle.
pub fn utf16_prefix(text: &str, end: usize) -> Vec<u16> {
    let mut units = Vec::with_capacity(end.min(utf16_len(text)));
    for unit in text.encode_utf16() {
        if units.len() == end {
            break;
        }
        units.push(unit);
    }
    units
}

fn ascii_digit(byte: u8) -> bool {
    byte.is_ascii_digit()
}

fn is_decimal_literal(text: &str) -> bool {
    let bytes = text.as_bytes();
    let mut at = 0usize;
    if bytes
        .first()
        .is_some_and(|byte| *byte == b'+' || *byte == b'-')
    {
        at += 1;
    }
    let mut digits = 0usize;
    while bytes.get(at).is_some_and(|byte| ascii_digit(*byte)) {
        at += 1;
        digits += 1;
    }
    if bytes.get(at) == Some(&b'.') {
        at += 1;
        while bytes.get(at).is_some_and(|byte| ascii_digit(*byte)) {
            at += 1;
            digits += 1;
        }
    }
    if digits == 0 {
        return false;
    }
    if bytes
        .get(at)
        .is_some_and(|byte| *byte == b'e' || *byte == b'E')
    {
        at += 1;
        if bytes
            .get(at)
            .is_some_and(|byte| *byte == b'+' || *byte == b'-')
        {
            at += 1;
        }
        let mut exponent_digits = 0usize;
        while bytes.get(at).is_some_and(|byte| ascii_digit(*byte)) {
            at += 1;
            exponent_digits += 1;
        }
        if exponent_digits == 0 {
            return false;
        }
    }
    at == bytes.len()
}

fn radix_number(digits: &str, radix: u32) -> f64 {
    if digits.is_empty() {
        return f64::NAN;
    }
    let mut value = 0.0f64;
    for character in digits.chars() {
        match character.to_digit(radix) {
            Some(digit) => value = value * f64::from(radix) + f64::from(digit),
            None => return f64::NAN,
        }
    }
    value
}

/// ECMAScript `Number(string)`.
pub fn js_string_to_number(text: &str) -> f64 {
    let trimmed = js_trim(text);
    if trimmed.is_empty() {
        return 0.0;
    }
    match trimmed {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(digits) = trimmed.strip_prefix(prefix) {
            return radix_number(digits, radix);
        }
    }
    if !is_decimal_literal(trimmed) {
        return f64::NAN;
    }
    trimmed.parse::<f64>().unwrap_or(f64::NAN)
}

/// ECMAScript `Number(value)`.
pub fn js_to_number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(flag) => {
            if *flag {
                1.0
            } else {
                0.0
            }
        }
        Value::Number(number) => number.as_f64().unwrap_or(f64::NAN),
        Value::String(text) => js_string_to_number(text),
        Value::Array(_) => js_string_to_number(&js_string(value)),
        Value::Object(_) => f64::NAN,
    }
}

/// JSON.stringify for a JS string (no indent). Matches the ECMAScript quote
/// escaping: short control escapes plus lowercase `\u00xx`.
fn json_quote(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for character in text.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{0008}' => out.push_str("\\b"),
            '\u{0009}' => out.push_str("\\t"),
            '\u{000A}' => out.push_str("\\n"),
            '\u{000C}' => out.push_str("\\f"),
            '\u{000D}' => out.push_str("\\r"),
            character if (character as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", character as u32));
            }
            character => out.push(character),
        }
    }
    out.push('"');
    out
}

/// `JSON.stringify(value)` for JSON values (undefined members cannot occur).
pub fn js_json_stringify(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number_to_js_string(number),
        Value::String(text) => json_quote(text),
        Value::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .map(js_json_stringify)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(object) => format!(
            "{{{}}}",
            object
                .iter()
                .map(|(key, member)| format!("{}:{}", json_quote(key), js_json_stringify(member)))
                .collect::<Vec<_>>()
                .join(",")
        ),
    }
}

fn compare_utf16(left: &str, right: &str) -> std::cmp::Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

/// `stableStringify`: object keys sorted (UTF-16 code-unit order), arrays in
/// place, primitives through JSON.stringify.
pub fn stable_stringify(value: &Value) -> String {
    match value {
        Value::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .map(stable_stringify)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(object) => {
            let mut keys: Vec<&String> = object.keys().collect();
            keys.sort_by(|left, right| compare_utf16(left, right));
            format!(
                "{{{}}}",
                keys.iter()
                    .map(|key| format!("{}:{}", json_quote(key), stable_stringify(&object[*key])))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        other => js_json_stringify(other),
    }
}

/// A serde number that keeps JS-visible semantics: integers stay integers,
/// negative zero stays negative zero.
pub fn number_value(number: f64) -> Value {
    if number == 0.0 {
        return if number.is_sign_negative() {
            Value::from(-0.0f64)
        } else {
            Value::from(0i64)
        };
    }
    if number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0 {
        return Value::from(number as i64);
    }
    Value::from(number)
}

/// `Math.min(left, right)` where both are numbers after coercion.
pub fn js_math_min(left: f64, right: f64) -> f64 {
    if left.is_nan() || right.is_nan() {
        return f64::NAN;
    }
    if left <= right {
        left
    } else {
        right
    }
}

/// `a <= b` after ToNumber(b); NaN makes the comparison false.
pub fn js_less_equal(left: f64, right: &Value) -> bool {
    let right = js_to_number(right);
    !right.is_nan() && left <= right
}

/// `a < b` after ToNumber(b); NaN makes the comparison false.
pub fn js_less(left: &Value, right: f64) -> bool {
    let left = js_to_number(left);
    !left.is_nan() && left < right
}

pub fn map_with(entries: Vec<(&str, Value)>) -> Value {
    let mut map = Map::new();
    for (key, value) in entries {
        map.insert(key.to_string(), value);
    }
    Value::Object(map)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn string_and_number_coercion_matches_js() {
        assert_eq!(js_string(&json!(null)), "null");
        assert_eq!(js_string(&json!([1, null, "x"])), "1,,x");
        assert_eq!(js_string(&json!({ "a": 1 })), "[object Object]");
        assert_eq!(js_string_to_number(" 12 "), 12.0);
        assert_eq!(js_string_to_number("0x10"), 16.0);
        assert!(js_string_to_number("-0x10").is_nan());
        assert!(js_string_to_number("1_000").is_nan());
        assert_eq!(js_string_to_number("1e3"), 1000.0);
        assert_eq!(js_string_to_number("-Infinity"), f64::NEG_INFINITY);
        assert_eq!(js_to_number(&json!([])), 0.0);
        assert_eq!(js_to_number(&json!(["5"])), 5.0);
        assert!(js_to_number(&json!(["5", "6"])).is_nan());
    }

    #[test]
    fn numbers_print_like_javascript() {
        assert_eq!(format_f64(15.0), "15");
        assert_eq!(format_f64(-0.0), "0");
        assert_eq!(format_f64(1e21), "1e+21");
        assert_eq!(format_f64(0.1 + 0.2), "0.30000000000000004");
    }

    #[test]
    fn trim_uses_the_js_whitespace_set() {
        assert_eq!(js_trim("\u{feff}\u{0020}x\u{0085}"), "x\u{0085}");
        assert_eq!(js_trim("\u{0085}x\u{0085}"), "\u{0085}x\u{0085}");
        assert_eq!(js_trim("\u{00a0}x\u{3000}"), "x");
    }

    #[test]
    fn stable_stringify_sorts_keys_and_keeps_arrays() {
        assert_eq!(
            stable_stringify(&json!({ "b": [2, 1], "a": "x" })),
            "{\"a\":\"x\",\"b\":[2,1]}"
        );
        assert_eq!(stable_stringify(&json!(-0.0)), "0");
    }

    #[test]
    fn utf16_length_and_prefix() {
        assert_eq!(utf16_len("a😀中"), 4);
        assert_eq!(utf16_prefix("a😀中", 2), vec![0x61, 0xD83D]);
    }
}
