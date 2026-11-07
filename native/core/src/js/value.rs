//! The single lossless representation of a JavaScript value inside the Rust
//! kernels.
//!
//! The model has to be wider than JSON: `undefined` is distinct from `null`,
//! `NaN`/`±Infinity`/`-0` survive, strings are UTF-16 code units (lone
//! surrogates included), `Buffer`/`Uint8Array` are bytes rather than a
//! `{type,data}` object and `Date` stays a number of milliseconds.
//!
//! [`JsValue::Object`] keeps insertion order. JS itself enumerates integer-like
//! keys first, in ascending order, and then the remaining own keys in insertion
//! order; the bridge reads property names in that engine order, so an
//! `Object.keys`-shaped sequence is all this type has to preserve.
use crate::js::string::JsString;

#[derive(Clone, Debug, PartialEq)]
pub enum JsValue {
    /// `undefined`. Only meaningful as a property value or array element; a
    /// top-level `undefined` has no JSON representation at all.
    Undefined,
    Null,
    Bool(bool),
    /// Always `f64`: JS numbers have no integer subtype. `NaN`, both
    /// infinities and negative zero are preserved as-is.
    Number(f64),
    String(JsString),
    Array(Vec<JsValue>),
    /// Own enumerable string keys in `Object.keys` order.
    Object(Vec<(JsString, JsValue)>),
    /// `Buffer` or `Uint8Array` content.
    Bytes(Vec<u8>),
    /// `Date` as milliseconds since the Unix epoch; any `f64` is representable
    /// here so an invalid date (`NaN`) can be carried.
    Date(f64),
}

impl JsValue {
    pub fn string(value: &str) -> Self {
        JsValue::String(JsString::from_rust_str(value))
    }

    pub fn object<K: Into<JsString>>(entries: Vec<(K, JsValue)>) -> Self {
        JsValue::Object(
            entries
                .into_iter()
                .map(|(key, value)| (key.into(), value))
                .collect(),
        )
    }

    /// One own property, compared by code unit. Returns `None` for non-objects,
    /// which is what `value.key` would throw on in JS — callers already guard
    /// with `object_like`.
    pub fn get(&self, key: &str) -> Option<&JsValue> {
        match self {
            JsValue::Object(entries) => entries
                .iter()
                .find(|(name, _)| name == key)
                .map(|(_, value)| value),
            _ => None,
        }
    }

    pub fn is_nullish(&self) -> bool {
        matches!(self, JsValue::Null | JsValue::Undefined)
    }

    pub fn type_name(&self) -> &'static str {
        match self {
            JsValue::Undefined => "undefined",
            JsValue::Null => "object",
            JsValue::Bool(_) => "boolean",
            JsValue::Number(_) => "number",
            JsValue::String(_) => "string",
            JsValue::Array(_) => "object",
            JsValue::Object(_) => "object",
            JsValue::Bytes(_) => "object",
            JsValue::Date(_) => "object",
        }
    }
}

impl From<&str> for JsValue {
    fn from(value: &str) -> Self {
        JsValue::string(value)
    }
}

impl From<String> for JsValue {
    fn from(value: String) -> Self {
        JsValue::String(JsString::from_rust_str(&value))
    }
}

impl From<bool> for JsValue {
    fn from(value: bool) -> Self {
        JsValue::Bool(value)
    }
}

impl From<f64> for JsValue {
    fn from(value: f64) -> Self {
        JsValue::Number(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn object_lookup_uses_code_units_and_keeps_order() {
        let value = JsValue::object(vec![("b", JsValue::Number(1.0)), ("a", JsValue::Null)]);
        assert_eq!(value.get("b"), Some(&JsValue::Number(1.0)));
        assert_eq!(value.get("a"), Some(&JsValue::Null));
        assert_eq!(value.get("c"), None);
        let JsValue::Object(entries) = &value else {
            panic!("object");
        };
        assert_eq!(entries[0].0, JsString::from_rust_str("b"));
        assert_eq!(entries[1].0, JsString::from_rust_str("a"));
    }
}
