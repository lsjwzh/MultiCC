//! Tagged scalars for the kernels that read JavaScript values directly.
//!
//! `serde_json::Value` cannot hold `undefined`, `NaN` and the infinities, and a
//! direct napi read does not go through JSON. The two kernels that need those
//! distinctions at the value level (`turn_request`, `usage_observed`) therefore
//! convert a [`JsValue`] into a tagged `serde_json::Value` first:
//!
//! * `undefined` becomes `{"\0multicc.js":"undefined"}`;
//! * `NaN`/`Infinity`/`-Infinity` become `{"\0multicc.js":"NaN"}` and friends;
//! * every other value keeps its ordinary JSON shape (`-0` survives as an f64
//!   because serde stores it faithfully).
//!
//! [`is_nullish`], [`truthy`], [`js_string`], [`js_to_number`],
//! [`stable_stringify`], [`from_js`] and [`to_js`] understand those tags.
//! Kernels that never receive a tagged value keep using `js::serde`; these
//! helpers are deliberately separate so JSON-path kernels cannot misread an
//! ordinary object that happens to carry the tag key. A genuine object with a
//! `"\0multicc.js"` property is still escaped on the way in (the key is
//! doubled), so it never looks like a tag.
//!
//! Lone surrogates in strings and property keys are still read through their
//! lossy UTF-8 form: a serde string cannot represent them. Kernels with text
//! fidelity requirements use [`JsString`] directly instead of this module.
use serde_json::{Map, Value};
use std::cmp::Ordering;

use crate::js::json::{date_to_iso_string, json_quote};
use crate::js::number::number_to_string;
use crate::js::serde::from_serde as serde_from_serde;
use crate::js::{JsString, JsValue};

/// Property name (or shape marker) of a tagged scalar. The leading NUL makes an
/// accidental collision with real data vanishingly unlikely; [`from_js`]
/// doubles the key anyway when a genuine object contains it.
pub const TAG_KEY: &str = "\u{0}multicc.js";

fn tag(value: &Value) -> Option<&str> {
    match value {
        Value::Object(map) if map.len() == 1 => map.get(TAG_KEY).and_then(Value::as_str),
        _ => None,
    }
}

fn tagged(text: &str) -> Value {
    let mut map = Map::new();
    map.insert(TAG_KEY.to_string(), Value::String(text.to_string()));
    Value::Object(map)
}

/// `value === undefined` as transported by [`from_js`].
pub fn is_undefined(value: &Value) -> bool {
    tag(value) == Some("undefined")
}

/// `value == null` in JavaScript: `null`, `undefined`, or a missing property.
pub fn is_nullish(value: &Value) -> bool {
    value.is_null() || is_undefined(value)
}

fn tagged_number(value: &Value) -> Option<f64> {
    match tag(value)? {
        "NaN" => Some(f64::NAN),
        "Infinity" => Some(f64::INFINITY),
        "-Infinity" => Some(f64::NEG_INFINITY),
        _ => None,
    }
}

/// ToBoolean for tagged values; untagged values follow `js::serde`.
pub fn truthy(value: &Value) -> bool {
    if let Some(number) = tagged_number(value) {
        return number != 0.0 && !number.is_nan();
    }
    if is_undefined(value) {
        return false;
    }
    crate::js::serde::truthy(value)
}

/// True for transported primitives that only look like objects on the wire:
/// `undefined` and the non-finite numbers. JavaScript type tests (`typeof
/// value === 'object'`, `Array.isArray`) must treat these as non-objects.
pub fn is_tagged_scalar(value: &Value) -> bool {
    is_undefined(value) || tagged_number(value).is_some()
}

pub fn truthy_opt(value: Option<&Value>) -> bool {
    value.is_some_and(truthy)
}

/// ToString for tagged values; untagged values follow `js::serde`. Arrays join
/// their elements with `Array.prototype.join` semantics, where `null` and
/// `undefined` render as the empty string.
pub fn js_string(value: &Value) -> String {
    if is_undefined(value) {
        return "undefined".to_string();
    }
    if let Some(number) = tagged_number(value) {
        return number_to_string(number);
    }
    match value {
        Value::Array(items) => items
            .iter()
            .map(|item| {
                if is_nullish(item) {
                    String::new()
                } else {
                    js_string(item)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        _ => crate::js::serde::js_string(value),
    }
}

/// `String(value == null ? '' : value)`.
pub fn js_string_or_empty(value: Option<&Value>) -> String {
    match value {
        None => String::new(),
        Some(value) if is_nullish(value) => String::new(),
        Some(value) => js_string(value),
    }
}

/// `String(value || '')`.
pub fn value_or_empty(value: Option<&Value>) -> String {
    match value {
        Some(value) if truthy(value) => js_string(value),
        _ => String::new(),
    }
}

/// ToNumber for tagged values; untagged values follow `js::serde`.
pub fn js_to_number(value: &Value) -> f64 {
    if is_undefined(value) {
        return f64::NAN;
    }
    if let Some(number) = tagged_number(value) {
        return number;
    }
    match value {
        Value::Array(_) => {
            crate::js::number::string_to_number(&JsString::from_rust_str(&js_string(value)))
        }
        _ => crate::js::serde::js_to_number(value),
    }
}

fn compare_utf16(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

/// `stableStringify` from `src/usage-observed.js`: object keys sorted by code
/// unit, arrays in place, primitives through `JSON.stringify`. `undefined`
/// inside an object spells `undefined`; inside an array `join(',')` renders it
/// as the empty string, and a tagged non-finite number is `null`.
pub fn stable_stringify(value: &Value) -> String {
    if is_undefined(value) {
        return "undefined".to_string();
    }
    if tagged_number(value).is_some() {
        return "null".to_string();
    }
    match value {
        Value::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .map(|item| {
                    if is_undefined(item) {
                        String::new()
                    } else {
                        stable_stringify(item)
                    }
                })
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(object) => {
            let mut keys: Vec<&String> = object.keys().collect();
            keys.sort_by(|left, right| compare_utf16(left, right));
            format!(
                "{{{}}}",
                keys.iter()
                    .map(|key| format!(
                        "{}:{}",
                        json_quote(&JsString::from_rust_str(key)),
                        stable_stringify(&object[*key])
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        other => crate::js::serde::js_json_stringify(other),
    }
}

// A genuine property name that starts with the tag marker gets one more marker
// in front. The mapping is bijective: the tag object itself is built by
// `tagged()` without escaping, and any key that could form it has been escaped.
fn key_to_string(key: &JsString) -> String {
    let text = key.to_string_lossy();
    if text.starts_with(TAG_KEY) {
        format!("{TAG_KEY}{text}")
    } else {
        text
    }
}

fn string_to_key(key: &str) -> JsString {
    if let Some(rest) = key.strip_prefix(TAG_KEY) {
        JsString::from_rust_str(rest)
    } else {
        JsString::from_rust_str(key)
    }
}

/// [`JsValue`] → tagged `serde_json::Value`, following JSON serialization for
/// shapes JSON defines (bytes become the `Buffer#toJSON` object, dates their
/// ISO string) while keeping `undefined`, `NaN` and the infinities.
pub fn from_js(value: &JsValue) -> Value {
    match value {
        JsValue::Undefined => tagged("undefined"),
        JsValue::Null => Value::Null,
        JsValue::Bool(flag) => Value::Bool(*flag),
        JsValue::Number(number) => {
            if number.is_nan() {
                tagged("NaN")
            } else if *number == f64::INFINITY {
                tagged("Infinity")
            } else if *number == f64::NEG_INFINITY {
                tagged("-Infinity")
            } else {
                Value::from(*number)
            }
        }
        JsValue::String(text) => Value::String(text.to_string_lossy()),
        JsValue::Array(items) => Value::Array(items.iter().map(from_js).collect()),
        JsValue::Object(entries) => {
            let mut map = Map::new();
            for (key, item) in entries {
                map.insert(key_to_string(key), from_js(item));
            }
            Value::Object(map)
        }
        JsValue::Bytes(bytes) => {
            let mut map = Map::new();
            map.insert("type".to_string(), Value::String("Buffer".to_string()));
            map.insert(
                "data".to_string(),
                Value::Array(
                    bytes
                        .iter()
                        .map(|byte| Value::from(u64::from(*byte)))
                        .collect(),
                ),
            );
            Value::Object(map)
        }
        JsValue::Date(milliseconds) => match date_to_iso_string(*milliseconds) {
            Some(text) => Value::String(text),
            None => Value::Null,
        },
    }
}

/// Tagged `serde_json::Value` → [`JsValue`], the inverse of [`from_js`].
pub fn to_js(value: &Value) -> JsValue {
    if is_undefined(value) {
        return JsValue::Undefined;
    }
    if let Some(number) = tagged_number(value) {
        return JsValue::Number(number);
    }
    match value {
        Value::Object(map) => JsValue::Object(
            map.iter()
                .map(|(key, item)| (string_to_key(key), to_js(item)))
                .collect(),
        ),
        Value::Array(items) => JsValue::Array(items.iter().map(to_js).collect()),
        Value::String(_) | Value::Number(_) | Value::Bool(_) | Value::Null => {
            serde_from_serde(value)
        }
    }
}

/// Round-trip helper for tests and diagnostics: exactly
/// `from_js` followed by `to_js`.
pub fn round_trip(value: &JsValue) -> JsValue {
    to_js(&from_js(value))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn undefined_and_non_finite_numbers_keep_their_semantics() {
        let tagged_undefined = from_js(&JsValue::Undefined);
        assert!(is_undefined(&tagged_undefined));
        assert!(is_nullish(&tagged_undefined));
        assert!(!truthy(&tagged_undefined));
        assert_eq!(js_string(&tagged_undefined), "undefined");
        assert!(js_to_number(&tagged_undefined).is_nan());

        let nan = from_js(&JsValue::Number(f64::NAN));
        assert!(!truthy(&nan));
        assert_eq!(js_string(&nan), "NaN");
        assert!(js_to_number(&nan).is_nan());

        let infinity = from_js(&JsValue::Number(f64::INFINITY));
        assert!(truthy(&infinity));
        assert_eq!(js_string(&infinity), "Infinity");
        assert_eq!(js_to_number(&infinity), f64::INFINITY);

        let negative_zero = from_js(&JsValue::Number(-0.0));
        assert!(js_to_number(&negative_zero).is_sign_negative());
        assert_eq!(js_string(&negative_zero), "0");
        assert_eq!(to_js(&negative_zero), JsValue::Number(-0.0));
    }

    #[test]
    fn genuine_tag_key_objects_are_escaped() {
        let value = JsValue::object(vec![
            ("\u{0}multicc.js", JsValue::string("undefined")),
            ("x", JsValue::Number(1.0)),
        ]);
        let tagged = from_js(&value);
        assert!(!is_undefined(&tagged));
        assert!(truthy(&tagged));
        assert_eq!(to_js(&tagged), value);
    }

    #[test]
    fn stable_stringify_matches_the_javascript_recursion() {
        let value = JsValue::object(vec![
            (
                "b",
                JsValue::Array(vec![JsValue::Number(2.0), JsValue::Number(1.0)]),
            ),
            ("a", JsValue::string("x")),
            ("u", JsValue::Undefined),
            ("n", JsValue::Number(f64::NAN)),
        ]);
        assert_eq!(
            stable_stringify(&from_js(&value)),
            "{\"a\":\"x\",\"b\":[2,1],\"n\":null,\"u\":undefined}"
        );
        let array = JsValue::Array(vec![JsValue::Number(1.0), JsValue::Undefined]);
        assert_eq!(stable_stringify(&from_js(&array)), "[1,]");
    }

    #[test]
    fn bytes_and_dates_serialize_like_json() {
        let bytes = from_js(&JsValue::Bytes(vec![1, 2]));
        assert_eq!(
            bytes,
            serde_json::json!({ "type": "Buffer", "data": [1, 2] })
        );
        let date = from_js(&JsValue::Date(0.0));
        assert_eq!(date, Value::String("1970-01-01T00:00:00.000Z".to_string()));
    }
}
