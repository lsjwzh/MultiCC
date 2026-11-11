//! Auto Provider selection identity — the Rust half of
//! `src/chat/auto-provider-selection-key.js`.
//!
//! A session remembers the route it settled on. Session records are cloned
//! during a CLI handoff and persistence hydration, so the key must not depend on
//! object identity: only a real policy change may reset the sticky route. The
//! key is therefore the normalized selection, serialized in a fixed property
//! order, with the preset provenance removed.
//!
//! `presetId` is a display label ("this pool came from preset X"), not routing
//! policy: saving the same pool again under another preset must not reset the
//! session's sticky route or its notes.
//!
//! Normalization itself belongs to the retained
//! [`crate::auto_provider_config`] bridge; this module only derives the key.
//! The fixture `native/core/tests/fixtures/auto-provider-selection-key.json`
//! records, per case, both the normalized selection and its key, so the
//! derivation is replayed without the cross-module facts the JS bridge
//! assembles at load.

use serde_json::Value;

use crate::auto_provider_config::normalize_stored_selection;
use crate::js::serde::truthy;

/// `selectionKey(selection)`.
///
/// `request` is the same `{ facts, input }` envelope the config bridge uses.
/// The answer is JSON text — a quoted key, or the four characters `null` when
/// the selection is invalid, matching the old `return null` path and the
/// conventions of the other native calls.
pub fn selection_key(request: &str) -> Result<String, String> {
    // Normalization answers `Some(null)` for an unusable selection; the old
    // `if (!normalized) return null` also covers any other falsy value.
    match normalize_stored_selection(request)? {
        Some(selection) if truthy(&selection) => {
            serde_json::to_string(&key_of(&selection)).map_err(|error| error.to_string())
        }
        _ => Ok("null".to_string()),
    }
}

/// The key of an already-normalized selection: the policy object without its
/// preset provenance, serialized compactly.
///
/// The normalized value preserves property order (`serde_json` runs with
/// `preserve_order`), so removing a key that normalization always appends last
/// leaves every other position untouched.
pub fn key_of(selection: &Value) -> String {
    let mut policy = selection.clone();
    if let Value::Object(map) = &mut policy {
        // `shift_remove`, not `remove`: the latter swaps the last entry into the
        // hole under `preserve_order`, which would reorder the key whenever
        // presetId is not last.
        map.shift_remove("presetId");
    }
    policy.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;

    fn fixture() -> Value {
        serde_json::from_str(include_str!(
            "../tests/fixtures/auto-provider-selection-key.json"
        ))
        .expect("selection-key fixture")
    }

    /// Keys derived from the recorded normalized selections, by label.
    fn derived_keys(case: &Value) -> HashMap<String, Option<String>> {
        let mut keys = HashMap::new();
        for call in case["calls"].as_array().unwrap() {
            let label = call["label"].as_str().unwrap().to_string();
            let key = match &call["normalized"] {
                Value::Null => None,
                normalized => Some(key_of(normalized)),
            };
            keys.insert(label, key);
        }
        keys
    }

    #[test]
    fn key_derivation_replays_the_frozen_fixture() {
        for case in fixture()["cases"].as_array().unwrap() {
            let keys = derived_keys(case);
            let expect = &case["expect"]["keys"];
            for (label, expected) in expect.as_object().unwrap() {
                let got = match keys.get(label).unwrap_or_else(|| panic!("{label} missing")) {
                    Some(key) => json!(key),
                    None => Value::Null,
                };
                assert_eq!(&got, expected, "{} ({label})", case["name"]);
            }
            for (pair, expected) in case["expect"]["equal"].as_object().unwrap() {
                let (left, right) = pair.split_once('=').unwrap();
                let same = keys[left] == keys[right];
                assert_eq!(json!(same), *expected, "{} ({pair})", case["name"]);
            }
        }
    }

    #[test]
    fn preset_provenance_is_not_part_of_the_key() {
        let base = json!({
            "version": 1,
            "mode": "auto",
            "candidates": [],
            "presetId": "preset-a",
        });
        let other = json!({
            "version": 1,
            "mode": "auto",
            "candidates": [],
            "presetId": "preset-b",
        });
        assert_eq!(key_of(&base), key_of(&other));
        assert_eq!(
            key_of(&base),
            json!({ "version": 1, "mode": "auto", "candidates": [] }).to_string()
        );
    }

    #[test]
    fn property_order_survives_key_removal() {
        // A selection whose presetId is not last keeps the surrounding order:
        // `delete` only drops the one key.
        let selection = json!({
            "presetId": "p",
            "version": 1,
            "mode": "auto",
            "protocol": "anthropic",
        });
        assert_eq!(
            key_of(&selection),
            r#"{"version":1,"mode":"auto","protocol":"anthropic"}"#
        );
    }

    #[test]
    fn key_is_stable_across_json_round_trips() {
        let selection = json!({ "version": 1, "mode": "auto", "candidates": [], "sticky": true });
        let clone: Value = serde_json::from_str(&selection.to_string()).unwrap();
        assert_eq!(key_of(&selection), key_of(&clone));
    }
}
