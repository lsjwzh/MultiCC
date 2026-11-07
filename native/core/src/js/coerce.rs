//! JavaScript coercion: ToBoolean, ToString, ToNumber.
//!
//! Only rules the specification fixes are implemented here. `Date.prototype
//! .toString`, `toLocaleString`, `Intl`, `Date.parse` and `localeCompare`
//! depend on the JS engine (timezone database, ICU, natural-language parsing)
//! and stay in JS: the bridge precomputes them before crossing.
use crate::js::json::date_to_iso_string;
use crate::js::number::{number_to_string, string_to_number};
use crate::js::string::JsString;
use crate::js::value::JsValue;

/// ToBoolean. Every object-shaped value (array, object, buffer, date — even an
/// invalid date) is truthy.
pub fn truthy(value: &JsValue) -> bool {
    match value {
        JsValue::Undefined | JsValue::Null => false,
        JsValue::Bool(flag) => *flag,
        JsValue::Number(number) => *number != 0.0 && !number.is_nan(),
        JsValue::String(text) => !text.is_empty(),
        JsValue::Array(_) | JsValue::Object(_) | JsValue::Bytes(_) | JsValue::Date(_) => true,
    }
}

pub fn truthy_opt(value: Option<&JsValue>) -> bool {
    value.is_some_and(truthy)
}

/// ToString. `undefined` and `null` are spelled out (unlike `Array.prototype
/// .join`, which turns them into empty strings); arrays join their elements.
///
/// `Date` deviates from `Date.prototype.toString`, whose output depends on the
/// local timezone and its name. It prints the ISO form instead; a kernel that
/// needs the engine's format must ask the bridge for it. The same holds for
/// invalid dates (`"Invalid Date"` in JS).
pub fn js_to_string(value: &JsValue) -> JsString {
    match value {
        JsValue::Undefined => JsString::from_rust_str("undefined"),
        JsValue::Null => JsString::from_rust_str("null"),
        JsValue::Bool(flag) => JsString::from_rust_str(if *flag { "true" } else { "false" }),
        JsValue::Number(number) => JsString::from_rust_str(&number_to_string(*number)),
        JsValue::String(text) => text.clone(),
        JsValue::Array(items) => JsString::join(
            &items
                .iter()
                .map(|item| match item {
                    JsValue::Null | JsValue::Undefined => JsString::new(),
                    other => js_to_string(other),
                })
                .collect::<Vec<_>>(),
            &JsString::from_rust_str(","),
        ),
        JsValue::Object(_) => JsString::from_rust_str("[object Object]"),
        JsValue::Bytes(bytes) => JsString::from_rust_str(&String::from_utf8_lossy(bytes)),
        JsValue::Date(milliseconds) => match date_to_iso_string(*milliseconds) {
            Some(text) => JsString::from_rust_str(&text),
            None => JsString::from_rust_str("Invalid Date"),
        },
    }
}

/// ToNumber. Arrays/strings follow `StringNumericLiteral`; bytes behave like
/// `Buffer.prototype.toString()` first; objects are NaN (`valueOf` is not
/// observable across the bridge); dates convert to their time value.
pub fn js_to_number(value: &JsValue) -> f64 {
    match value {
        JsValue::Undefined => f64::NAN,
        JsValue::Null => 0.0,
        JsValue::Bool(flag) => {
            if *flag {
                1.0
            } else {
                0.0
            }
        }
        JsValue::Number(number) => *number,
        JsValue::String(text) => string_to_number(text),
        JsValue::Array(_) | JsValue::Object(_) => string_to_number(&js_to_string(value)),
        JsValue::Bytes(_) => string_to_number(&js_to_string(value)),
        JsValue::Date(milliseconds) => *milliseconds,
    }
}

/// `a ?? b` where `None` is `undefined`.
pub fn nullish<'a>(first: Option<&'a JsValue>, second: Option<&'a JsValue>) -> Option<&'a JsValue> {
    match first {
        None | Some(JsValue::Null) | Some(JsValue::Undefined) => second,
        value => value,
    }
}

/// `a || b` truthiness selection, for kernels that only need the fallback.
pub fn or<'a>(first: Option<&'a JsValue>, second: Option<&'a JsValue>) -> Option<&'a JsValue> {
    match first {
        Some(value) if truthy(value) => first,
        _ => second,
    }
}

/// `Math.min` after both sides are already numbers. NaN wins, matching JS.
pub fn math_min(left: f64, right: f64) -> f64 {
    if left.is_nan() || right.is_nan() {
        return f64::NAN;
    }
    if left <= right {
        left
    } else {
        right
    }
}

/// `left <= Number(right)`; NaN makes the comparison false.
pub fn less_equal_number(left: f64, right: &JsValue) -> bool {
    let right = js_to_number(right);
    !right.is_nan() && left <= right
}

/// `Number(left) < right`; NaN makes the comparison false.
pub fn less_number(left: &JsValue, right: f64) -> bool {
    let left = js_to_number(left);
    !left.is_nan() && left < right
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn string_coercion_matches_javascript() {
        assert_eq!(
            js_to_string(&JsValue::Undefined).to_string_lossy(),
            "undefined"
        );
        assert_eq!(js_to_string(&JsValue::Null).to_string_lossy(), "null");
        assert_eq!(
            js_to_string(&JsValue::Array(vec![
                JsValue::Number(1.0),
                JsValue::Null,
                JsValue::string("x"),
                JsValue::Undefined,
            ]))
            .to_string_lossy(),
            "1,,x,"
        );
        assert_eq!(
            js_to_string(&JsValue::object(vec![("a", JsValue::Number(1.0))])).to_string_lossy(),
            "[object Object]"
        );
        assert_eq!(
            js_to_string(&JsValue::Bytes(b"hi\xff".to_vec())).to_string_lossy(),
            "hi\u{FFFD}"
        );
    }

    #[test]
    fn number_coercion_matches_javascript() {
        assert!(js_to_number(&JsValue::Undefined).is_nan());
        assert_eq!(js_to_number(&JsValue::Null), 0.0);
        assert_eq!(js_to_number(&JsValue::Bool(true)), 1.0);
        assert_eq!(js_to_number(&JsValue::Array(Vec::new())), 0.0);
        assert_eq!(
            js_to_number(&JsValue::Array(vec![JsValue::string("5")])),
            5.0
        );
        assert!(js_to_number(&JsValue::Array(vec![
            JsValue::string("5"),
            JsValue::string("6")
        ]))
        .is_nan());
        assert!(js_to_number(&JsValue::object(vec![("a", JsValue::Number(1.0))])).is_nan());
        assert_eq!(js_to_number(&JsValue::Date(1500.0)), 1500.0);
    }

    #[test]
    fn truthiness_follows_objects_are_truthy() {
        assert!(!truthy(&JsValue::Number(f64::NAN)));
        assert!(!truthy(&JsValue::Number(-0.0)));
        assert!(!truthy(&JsValue::string("")));
        assert!(truthy(&JsValue::Array(Vec::new())));
        assert!(truthy(&JsValue::Bytes(Vec::new())));
        assert!(truthy(&JsValue::Date(f64::NAN)));
    }
}
