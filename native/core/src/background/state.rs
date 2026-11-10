//! Ordered containers and small JavaScript-shape helpers for the
//! background-task owner.
//!
//! JS `Map`/`Set` keep insertion order, move a re-set key to the end, and never
//! convert keys implicitly (the owner passes `String(...)` explicitly where the
//! legacy code did). There is no `indexmap` in this workspace, so the ordered
//! map below is a `Vec` of pairs: every store here is capped at a couple of
//! thousand entries, and a linear scan is cheaper than a hash table plus an
//! index at that size.
use crate::js::{coerce::js_to_string, coerce::truthy, string::JsString, JsValue};

#[derive(Clone, Debug, Default, PartialEq)]
pub struct OrderedMap<V> {
    entries: Vec<(JsString, V)>,
}

impl<V> OrderedMap<V> {
    pub fn new() -> Self {
        Self {
            entries: Vec::new(),
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    fn position(&self, key: &JsString) -> Option<usize> {
        self.entries.iter().position(|(name, _)| name == key)
    }

    pub fn get(&self, key: &JsString) -> Option<&V> {
        self.position(key).map(|index| &self.entries[index].1)
    }

    pub fn get_mut(&mut self, key: &JsString) -> Option<&mut V> {
        self.position(key)
            .map(move |index| &mut self.entries[index].1)
    }

    pub fn contains_key(&self, key: &JsString) -> bool {
        self.position(key).is_some()
    }

    /// `map.set(key, value)`: an existing key keeps its position, a new one is
    /// appended.
    pub fn set(&mut self, key: JsString, value: V) -> Option<V> {
        match self.position(&key) {
            Some(index) => Some(std::mem::replace(&mut self.entries[index].1, value)),
            None => {
                self.entries.push((key, value));
                None
            }
        }
    }

    /// `map.delete(key)`: remaining keys keep their order.
    pub fn delete(&mut self, key: &JsString) -> Option<V> {
        let index = self.position(key)?;
        Some(self.entries.remove(index).1)
    }

    pub fn keys(&self) -> impl Iterator<Item = &JsString> {
        self.entries.iter().map(|(key, _)| key)
    }

    pub fn keys_vec(&self) -> Vec<JsString> {
        self.entries.iter().map(|(key, _)| key.clone()).collect()
    }

    pub fn values(&self) -> impl Iterator<Item = &V> {
        self.entries.iter().map(|(_, value)| value)
    }

    pub fn values_mut(&mut self) -> impl Iterator<Item = &mut V> {
        self.entries.iter_mut().map(|(_, value)| value)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&JsString, &V)> {
        self.entries.iter().map(|(key, value)| (key, value))
    }

    pub fn iter_mut(&mut self) -> impl Iterator<Item = (&JsString, &mut V)> {
        self.entries.iter_mut().map(|(key, value)| (&*key, value))
    }

    pub fn into_pairs(self) -> Vec<(JsString, V)> {
        self.entries
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct OrderedSet {
    keys: Vec<JsString>,
}

impl OrderedSet {
    pub fn new() -> Self {
        Self { keys: Vec::new() }
    }

    pub fn len(&self) -> usize {
        self.keys.len()
    }

    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }

    pub fn contains(&self, key: &JsString) -> bool {
        self.keys.iter().any(|name| name == key)
    }

    /// `set.add(key)`; returns whether the key was new.
    pub fn insert(&mut self, key: JsString) -> bool {
        if self.contains(&key) {
            return false;
        }
        self.keys.push(key);
        true
    }

    pub fn delete(&mut self, key: &JsString) -> bool {
        match self.keys.iter().position(|name| name == key) {
            Some(index) => {
                self.keys.remove(index);
                true
            }
            None => false,
        }
    }

    pub fn iter(&self) -> impl Iterator<Item = &JsString> {
        self.keys.iter()
    }

    pub fn to_vec(&self) -> Vec<JsString> {
        self.keys.clone()
    }
}

/// `typeof value === 'object'` including arrays, buffers and dates.
pub fn is_object_like(value: &JsValue) -> bool {
    matches!(
        value,
        JsValue::Array(_) | JsValue::Object(_) | JsValue::Bytes(_) | JsValue::Date(_)
    )
}

/// Own enumerable properties in `Object.keys` order, used for `{ ...value }`.
/// A `Date` has none; arrays and `Buffer`s expose their indices.
pub fn own_entries(value: &JsValue) -> Vec<(JsString, JsValue)> {
    match value {
        JsValue::Object(entries) => entries.clone(),
        JsValue::Array(items) => items
            .iter()
            .enumerate()
            .map(|(index, item)| (JsString::from_rust_str(&index.to_string()), item.clone()))
            .collect(),
        JsValue::Bytes(bytes) => bytes
            .iter()
            .enumerate()
            .map(|(index, byte)| {
                (
                    JsString::from_rust_str(&index.to_string()),
                    JsValue::Number(*byte as f64),
                )
            })
            .collect(),
        JsValue::Date(_) => Vec::new(),
        _ => Vec::new(),
    }
}

/// `{ ...base, ...extra }` as ordered entries: existing keys are replaced in
/// place, new keys are appended.
pub fn spread(
    base: Vec<(JsString, JsValue)>,
    extra: Vec<(JsString, JsValue)>,
) -> Vec<(JsString, JsValue)> {
    let mut out = OrderedMap::new();
    for (key, value) in base {
        out.set(key, value);
    }
    for (key, value) in extra {
        out.set(key, value);
    }
    out.into_pairs()
}

/// `String(value || '')` with the control-character run rule applied, then
/// `trim()` and `slice(0, 240)`.
pub fn strip_controls(text: &JsString) -> JsString {
    let mut units = Vec::with_capacity(text.len());
    let mut in_run = false;
    for &unit in text.as_units() {
        if unit <= 0x1f || unit == 0x7f {
            if !in_run {
                units.push(0x20);
                in_run = true;
            }
        } else {
            units.push(unit);
            in_run = false;
        }
    }
    JsString::from_units(units)
}

/// `value || ''` for a raw (possibly missing) property.
pub fn or_empty(value: Option<&JsValue>) -> JsValue {
    match value {
        Some(value) if truthy(value) => value.clone(),
        _ => JsValue::string(""),
    }
}

/// `typeof value === 'string' ? value.replace(...).trim().slice(0, 240) : ''`.
pub fn metadata_text(value: Option<&JsValue>) -> JsString {
    match value {
        Some(JsValue::String(text)) => strip_controls(text).trim().truncate_units(240),
        _ => JsString::new(),
    }
}

/// `String(value || '')` then the same cleaning, with a fallback when empty.
pub fn safe_description(value: Option<&JsValue>, fallback: &str) -> JsString {
    let text = match value {
        Some(value) if truthy(value) => js_to_string(value),
        _ => JsString::new(),
    };
    let text = strip_controls(&text).trim();
    if text.is_empty() {
        JsString::from_rust_str(fallback)
    } else {
        text.truncate_units(240)
    }
}

/// `String(value || '')` without trimming (legacy `String(chunk || '')`).
pub fn string_or_empty(value: Option<&JsValue>) -> JsString {
    match value {
        Some(value) if truthy(value) => js_to_string(value),
        _ => JsString::new(),
    }
}

/// `Math.max(a, b)`: NaN wins; `+0` beats `-0`.
pub fn js_max(left: f64, right: f64) -> f64 {
    if left.is_nan() || right.is_nan() {
        return f64::NAN;
    }
    if left == 0.0 && right == 0.0 {
        return if left.is_sign_negative() && right.is_sign_negative() {
            -0.0
        } else {
            0.0
        };
    }
    if left >= right {
        left
    } else {
        right
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(value: &str) -> JsString {
        JsString::from_rust_str(value)
    }

    #[test]
    fn ordered_map_moves_reset_keys_and_keeps_the_rest() {
        let mut map = OrderedMap::new();
        map.set(text("a"), 1);
        map.set(text("b"), 2);
        map.set(text("c"), 3);
        map.set(text("a"), 4);
        assert_eq!(map.keys_vec(), vec![text("a"), text("b"), text("c")]);
        assert_eq!(map.get(&text("a")), Some(&4));
        assert_eq!(map.delete(&text("b")), Some(2));
        assert_eq!(map.keys_vec(), vec![text("a"), text("c")]);
        assert_eq!(map.delete(&text("b")), None);
    }

    #[test]
    fn controls_collapse_to_one_space_per_run() {
        let cleaned = strip_controls(&text("a\u{0}\u{1}b\u{7f}c"));
        assert_eq!(cleaned, text("a b c"));
        assert_eq!(strip_controls(&text("\u{1} x")), text("  x"));
    }

    #[test]
    fn metadata_text_only_accepts_strings() {
        assert_eq!(metadata_text(Some(&JsValue::Number(5.0))), text(""));
        assert_eq!(
            metadata_text(Some(&JsValue::string("  a\u{0}\u{0}b  "))),
            text("a b")
        );
        let long = "x".repeat(300);
        assert_eq!(metadata_text(Some(&JsValue::string(&long))).len(), 240);
    }

    #[test]
    fn safe_description_uses_the_fallback_only_when_empty() {
        assert_eq!(
            safe_description(Some(&JsValue::string("\u{1}  ")), "fallback"),
            text("fallback")
        );
        assert_eq!(
            safe_description(Some(&JsValue::string("  report ")), "fallback"),
            text("report")
        );
        assert_eq!(safe_description(None, "x"), text("x"));
        assert_eq!(
            safe_description(Some(&JsValue::Number(0.0)), "x"),
            text("x")
        );
        assert_eq!(
            safe_description(Some(&JsValue::Number(5.0)), "x"),
            text("5")
        );
    }

    #[test]
    fn js_max_matches_math_max_edges() {
        assert_eq!(js_max(0.0, 0.0), 0.0);
        assert!(js_max(-0.0, -0.0).is_sign_negative());
        assert!(!js_max(-0.0, 0.0).is_sign_negative());
        assert!(js_max(f64::NAN, 1.0).is_nan());
        assert_eq!(js_max(0.0, f64::INFINITY), f64::INFINITY);
    }

    #[test]
    fn spread_replaces_in_place_and_appends() {
        let base = vec![
            (text("a"), JsValue::Number(1.0)),
            (text("b"), JsValue::Number(2.0)),
        ];
        let extra = vec![
            (text("b"), JsValue::Number(3.0)),
            (text("c"), JsValue::Number(4.0)),
        ];
        let out = spread(base, extra);
        assert_eq!(out[0].0, text("a"));
        assert_eq!(out[1].0, text("b"));
        assert_eq!(out[1].1, JsValue::Number(3.0));
        assert_eq!(out[2].0, text("c"));
    }
}
