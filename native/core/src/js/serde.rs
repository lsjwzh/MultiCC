//! `serde_json::Value` compatibility layer.
//!
//! Kernels migrated before the lossless bridge was available still speak
//! `serde_json::Value` at their FFI edge. Moving that code over wholesale is a
//! later stage; until then these helpers keep the old behavior byte-identical
//! while the canonical rules live in [`crate::js`]. They also provide the
//! [`JsValue`] conversions, which are defined to be exactly
//! `JSON.parse(JSON.stringify(value))` (the one documented exception is a lone
//! surrogate, which becomes U+FFFD because a serde string is UTF-8).
use serde_json::{Map, Value};

use crate::js::number::number_to_string;
pub use crate::js::string::{js_trim, utf16_len, utf16_prefix_units as utf16_prefix};
use crate::js::value::JsValue;

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

/// `String(number)` for an already parsed JSON number. Integers keep their
/// exact i64/u64 spelling, which matters above 2^53.
pub fn number_to_js_string(number: &serde_json::Number) -> String {
    if let Some(integer) = number.as_i64() {
        return integer.to_string();
    }
    if let Some(integer) = number.as_u64() {
        return integer.to_string();
    }
    number_to_string(number.as_f64().unwrap_or(f64::NAN))
}

/// ECMAScript `String(number)`.
pub fn format_f64(number: f64) -> String {
    number_to_string(number)
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

/// ECMAScript `Number(string)`.
pub fn js_string_to_number(text: &str) -> f64 {
    crate::js::number::js_string_to_number(text)
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

/// `JSON.stringify` for a JS string (no indent), byte-compatible with V8.
pub fn json_quote(text: &str) -> String {
    crate::js::json::json_quote_str(text)
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
    crate::js::coerce::math_min(left, right)
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

/// `serde_json::Value` → [`JsValue`]. No information is available that the
/// JSON model cannot carry (no bytes/dates/undefined); numbers keep their
/// `-0` sign through `as_f64`.
pub fn from_serde(value: &Value) -> JsValue {
    match value {
        Value::Null => JsValue::Null,
        Value::Bool(flag) => JsValue::Bool(*flag),
        Value::Number(number) => JsValue::Number(number.as_f64().unwrap_or(f64::NAN)),
        Value::String(text) => JsValue::string(text),
        Value::Array(items) => JsValue::Array(items.iter().map(from_serde).collect()),
        Value::Object(map) => JsValue::Object(
            map.iter()
                .map(|(key, value)| {
                    (
                        crate::js::string::JsString::from_rust_str(key),
                        from_serde(value),
                    )
                })
                .collect(),
        ),
    }
}

/// [`JsValue`] → `serde_json::Value`, defined to equal
/// `JSON.parse(JSON.stringify(value))`: `undefined` is omitted from objects and
/// becomes `null` in arrays, `NaN`/infinities become `null`, `-0` becomes `0`,
/// bytes become the `Buffer#toJSON` object and dates become ISO strings (or
/// `null`). The one exception: a lone surrogate in a string or key becomes
/// U+FFFD, because a serde string is valid UTF-8.
pub fn to_serde(value: &JsValue) -> Value {
    serde_value(value).unwrap_or(Value::Null)
}

fn serde_value(value: &JsValue) -> Option<Value> {
    match value {
        JsValue::Undefined => None,
        JsValue::Null => Some(Value::Null),
        JsValue::Bool(flag) => Some(Value::Bool(*flag)),
        JsValue::Number(number) => Some(serde_number(*number)),
        JsValue::String(text) => Some(Value::String(text.to_string_lossy())),
        JsValue::Array(items) => Some(Value::Array(
            items
                .iter()
                .map(|item| serde_value(item).unwrap_or(Value::Null))
                .collect(),
        )),
        JsValue::Object(entries) => {
            let mut map = Map::new();
            for (key, item) in entries {
                if let Some(member) = serde_value(item) {
                    map.insert(key.to_string_lossy(), member);
                }
            }
            Some(Value::Object(map))
        }
        JsValue::Bytes(bytes) => {
            let mut map = Map::new();
            map.insert("type".to_string(), Value::String("Buffer".to_string()));
            map.insert(
                "data".to_string(),
                Value::Array(bytes.iter().map(|byte| Value::from(*byte)).collect()),
            );
            Some(Value::Object(map))
        }
        JsValue::Date(milliseconds) => match crate::js::json::date_to_iso_string(*milliseconds) {
            Some(text) => Some(Value::String(text)),
            None => Some(Value::Null),
        },
    }
}

fn serde_number(number: f64) -> Value {
    if !number.is_finite() {
        return Value::Null;
    }
    if number == 0.0 {
        return Value::from(0i64);
    }
    if number.fract() == 0.0 {
        if number > 0.0 && number <= u64::MAX as f64 {
            return Value::from(number as u64);
        }
        if number >= i64::MIN as f64 && number <= i64::MAX as f64 {
            return Value::from(number as i64);
        }
    }
    serde_json::Number::from_f64(number).map_or(Value::Null, Value::Number)
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

    #[test]
    fn to_serde_matches_a_json_round_trip() {
        let value = JsValue::object(vec![
            ("a", JsValue::Undefined),
            ("b", JsValue::Number(f64::NAN)),
            ("c", JsValue::Number(-0.0)),
            ("d", JsValue::Number(1.0)),
            (
                "e",
                JsValue::Array(vec![JsValue::Undefined, JsValue::Number(2.5)]),
            ),
            ("f", JsValue::Bytes(vec![1, 2])),
            ("g", JsValue::Date(0.0)),
            ("h", JsValue::Date(f64::NAN)),
        ]);
        let text = crate::js::json::json_stringify(&value).unwrap();
        let parsed: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(to_serde(&value), parsed);
        // The lone-surrogate exception is explicit.
        let lone = JsValue::Array(vec![JsValue::String(
            crate::js::string::JsString::from_units(vec![0xD83D]),
        )]);
        assert_eq!(to_serde(&lone), json!(["\u{FFFD}"]));
    }

    #[test]
    fn from_serde_round_trips_through_json() {
        let original = json!({"a": [1, null, "x"], "b": {"c": true}, "d": 1.25});
        let text = js_json_stringify(&original);
        assert_eq!(
            crate::js::json::json_stringify(&from_serde(&original)).unwrap(),
            text
        );
    }
}
