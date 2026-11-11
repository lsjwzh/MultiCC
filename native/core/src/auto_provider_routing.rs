//! Auto Provider difficulty routing — the Rust half of
//! `src/chat/auto-provider-routing.js`.
//!
//! The tier verdict has to be true *before* the turn starts, so routing rides
//! the admission window: the WebSocket handler prepares a verdict for one
//! message, the turn engine consumes it synchronously. Two invariants hold the
//! path together:
//!
//!   * preparing never rejects — a dead gateway, a missing key or a malformed
//!     answer degrade to the configured `onUnknown` tier, never to a lost
//!     message;
//!   * consuming is text-keyed and idempotent — a turn may be replayed or
//!     retried, and a verdict stays valid for its own message only, so a retry
//!     cannot inherit a stale tier and a fresh message cannot inherit the
//!     previous one's.
//!
//! This module owns the pure decisions ([`text_hash`], [`unknown_tier`],
//! [`resolve_tier`]) and the verdict store ([`Store`]: TTL expiry, oldest-first
//! eviction, per-session clearing). The Jev call itself, the single-flight
//! promise and the host wiring stay in JavaScript, because they are I/O and
//! promise identity.
//!
//! `native/core/tests/fixtures/auto-provider-routing.json` freezes the values,
//! including property order, which the wire consumers read directly.

use serde_json::{Map, Value};

use crate::js::serde::{js_string, number_value, truthy};

pub const DEFAULT_TTL_MS: f64 = 10.0 * 60_000.0;
pub const MAX_ENTRIES: f64 = 256.0;

/// djb2 over UTF-16 code units, tagged with the length: `"<length>:<base36>"`.
///
/// `text == null` hashes as the empty string. The length is the JS string
/// length (code units), so an emoji counts as two — that is what the store key
/// has always used.
pub fn text_hash(text: Option<&Value>) -> String {
    let source = match text {
        Some(value) if !value.is_null() => js_string(value),
        _ => String::new(),
    };
    let mut hash: u32 = 5381;
    let mut units = 0usize;
    for unit in source.encode_utf16() {
        hash = hash.wrapping_mul(33) ^ u32::from(unit);
        units += 1;
    }
    format!("{units}:{}", base36(hash))
}

fn base36(mut value: u32) -> String {
    if value == 0 {
        return "0".to_string();
    }
    let mut digits = Vec::new();
    while value > 0 {
        let digit = (value % 36) as u8;
        digits.push(if digit < 10 {
            b'0' + digit
        } else {
            b'a' + digit - 10
        });
        value /= 36;
    }
    digits.reverse();
    String::from_utf8(digits).expect("base36 digits are ascii")
}

/// `value[key]` where `value` is an object; a non-object has no properties.
fn member<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value
        .and_then(Value::as_object)
        .and_then(|map| map.get(key))
}

fn is_text(value: Option<&Value>, expected: &str) -> bool {
    matches!(value, Some(Value::String(text)) if text == expected)
}

/// `value[key] || fallback`, returned as the JS value the old code produced.
fn or_default(value: Option<&Value>, fallback: Value) -> Value {
    match value {
        Some(value) if truthy(value) => value.clone(),
        _ => fallback,
    }
}

/// `value == null ? null : value`.
fn nullable(value: Option<&Value>) -> Value {
    match value {
        None | Some(Value::Null) => Value::Null,
        Some(value) => value.clone(),
    }
}

fn ladder_of(routing: Option<&Value>) -> Vec<Value> {
    match member(routing, "tiers") {
        Some(Value::Array(items)) => items.clone(),
        _ => Vec::new(),
    }
}

/// The conservative answer when Jev could not decide: the `onUnknown` tier
/// (default `strong`), `unavailable` when the pool has no ladder at all, or no
/// tier when the pool ranks by priority instead.
pub fn unknown_tier(routing: Option<&Value>, verdict: Option<&Value>) -> Value {
    let tiers = ladder_of(routing);
    let code = or_default(
        member(verdict, "code"),
        Value::String("jev_not_prepared".to_string()),
    );
    let mut out = Map::new();
    out.insert("tier".to_string(), Value::Null);
    if tiers.is_empty() {
        out.insert(
            "source".to_string(),
            Value::String("unavailable".to_string()),
        );
        out.insert("code".to_string(), code);
        return Value::Object(out);
    }
    let mode = or_default(
        member(routing, "onUnknown"),
        Value::String("strong".to_string()),
    );
    if is_text(Some(&mode), "priority") {
        out.insert("source".to_string(), Value::String("fallback".to_string()));
        out.insert("code".to_string(), code);
        return Value::Object(out);
    }
    let tier = if is_text(Some(&mode), "weak") {
        tiers.first().cloned().unwrap_or(Value::Null)
    } else {
        tiers.last().cloned().unwrap_or(Value::Null)
    };
    out.insert("tier".to_string(), tier);
    out.insert("source".to_string(), Value::String("fallback".to_string()));
    out.insert("code".to_string(), code);
    Value::Object(out)
}

/// The position of a tier on the ladder, so a chat note can say "simple" or
/// "complex" without knowing the pool's tier keys.
fn position(ladder: &[Value], tier: Option<&Value>) -> (Value, Value) {
    let at = match tier {
        None | Some(Value::Null) => None,
        Some(wanted) => ladder.iter().position(|item| item == wanted),
    };
    (
        match at {
            Some(at) => number_value(at as f64),
            None => Value::Null,
        },
        number_value(ladder.len() as f64),
    )
}

/// `resolveTier({ selection, verdict, tiers })`.
///
/// A price-tiered pool passes this turn's ladder as `tiers`; a verdict for a
/// tier that ladder no longer has (the table refreshed in between) is treated
/// as no verdict at all. Returns `null` when the selection carries no routing.
pub fn resolve_tier(request: &Value) -> Option<Value> {
    let selection = request.get("selection");
    let stored = member(selection, "routing")
        .filter(|routing| truthy(routing))?
        .clone();
    let asked = request.get("tiers");
    let mut verdict = or_default(request.get("verdict"), Value::Null);
    // `Array.isArray(tiers) ? { ...stored, tiers } : stored` — only the ladder
    // is read afterwards.
    let ladder = match asked {
        Some(Value::Array(tiers)) => tiers.clone(),
        _ => ladder_of(Some(&stored)),
    };
    if is_text(member(Some(&stored), "tiering"), "price") && ladder.len() < 2 {
        verdict = serde_json::json!({ "ok": false, "code": "price_tiers_unavailable" });
    } else if asked.is_some_and(Value::is_array) && truthy(&verdict) && truthy(&verdict["ok"]) {
        let on_ladder = verdict
            .get("tier")
            .is_some_and(|tier| ladder.iter().any(|item| item == tier));
        if !on_ladder {
            // The ladder refreshed between prepare and resolve: the verdict no
            // longer names a tier this turn can use.
            let mut changed = Map::new();
            changed.insert("ok".to_string(), Value::Bool(false));
            changed.insert(
                "code".to_string(),
                Value::String("price_ladder_changed".to_string()),
            );
            changed.insert("latencyMs".to_string(), nullable(verdict.get("latencyMs")));
            verdict = Value::Object(changed);
        }
    }
    let (tier_index, tier_count) = position(&ladder, verdict.get("tier"));
    if truthy(&verdict) && truthy(&verdict["ok"]) {
        let mut out = Map::new();
        out.insert("tier".to_string(), nullable(verdict.get("tier")));
        out.insert("tierIndex".to_string(), tier_index);
        out.insert("tierCount".to_string(), tier_count);
        out.insert("source".to_string(), Value::String("jev".to_string()));
        out.insert(
            "code".to_string(),
            or_default(
                verdict.get("reasonCode"),
                Value::String("jev_choice".to_string()),
            ),
        );
        out.insert(
            "escalated".to_string(),
            Value::Bool(verdict.get("escalated") == Some(&Value::Bool(true))),
        );
        out.insert(
            "confidence".to_string(),
            nullable(verdict.get("confidence")),
        );
        out.insert(
            "complexityScore".to_string(),
            nullable(verdict.get("complexityScore")),
        );
        out.insert(
            "chosenTier".to_string(),
            or_default(verdict.get("chosenTier"), Value::Null),
        );
        out.insert(
            "chosenProbability".to_string(),
            nullable(verdict.get("chosenProbability")),
        );
        out.insert("latencyMs".to_string(), nullable(verdict.get("latencyMs")));
        return Some(Value::Object(out));
    }
    // The fallback sees the same routing object the decision saw: the stored
    // one with this turn's ladder spread over it. A price pool stores no tiers
    // at all, so its fallback tier can only come from `tiers`.
    let mut view = stored.as_object().cloned().unwrap_or_default();
    if let Some(Value::Array(tiers)) = asked {
        view.insert("tiers".to_string(), Value::Array(tiers.clone()));
    }
    let fallback = unknown_tier(Some(&Value::Object(view)), Some(&verdict));
    let (tier_index, tier_count) = position(&ladder, fallback.get("tier"));
    let mut out = Map::new();
    out.insert("tier".to_string(), fallback["tier"].clone());
    out.insert("tierIndex".to_string(), tier_index);
    out.insert("tierCount".to_string(), tier_count);
    out.insert(
        "onUnknown".to_string(),
        or_default(
            member(Some(&stored), "onUnknown"),
            Value::String("strong".to_string()),
        ),
    );
    out.insert("source".to_string(), fallback["source"].clone());
    out.insert("code".to_string(), fallback["code"].clone());
    out.insert("escalated".to_string(), Value::Bool(false));
    out.insert("confidence".to_string(), Value::Null);
    out.insert("complexityScore".to_string(), Value::Null);
    out.insert("chosenTier".to_string(), Value::Null);
    out.insert("chosenProbability".to_string(), Value::Null);
    out.insert("latencyMs".to_string(), nullable(verdict.get("latencyMs")));
    Some(Value::Object(out))
}

/// One prepared verdict.
struct Entry {
    session_id: String,
    verdict: Value,
    at: f64,
}

/// Prepared verdicts, keyed `${sessionId}\n${hash}`.
///
/// The store keeps the JavaScript `Map` behaviour exactly: re-inserting a key
/// moves it to the newest position, eviction drops the oldest entry, and
/// expiry is checked only on read.
pub struct Store {
    ttl_ms: f64,
    max_entries: f64,
    entries: Vec<(String, Entry)>,
}

fn number_or_default(value: Option<f64>, fallback: f64) -> f64 {
    match value {
        Some(value) if value != 0.0 && !value.is_nan() => value,
        _ => fallback,
    }
}

impl Store {
    /// `Math.max(1_000, Number(ttlMs) || DEFAULT_TTL_MS)` and
    /// `Math.max(8, Number(maxEntries) || MAX_ENTRIES)`.
    pub fn new(ttl_ms: Option<f64>, max_entries: Option<f64>) -> Self {
        Self {
            ttl_ms: number_or_default(ttl_ms, DEFAULT_TTL_MS).max(1_000.0),
            max_entries: number_or_default(max_entries, MAX_ENTRIES).max(8.0),
            entries: Vec::new(),
        }
    }

    pub fn ttl_ms(&self) -> f64 {
        self.ttl_ms
    }

    pub fn max_entries(&self) -> f64 {
        self.max_entries
    }

    fn key(session_id: &str, hash: &str) -> String {
        format!("{session_id}\n{hash}")
    }

    /// `remember(sessionId, hash, verdict)`.
    pub fn remember(&mut self, session_id: &str, hash: &str, verdict: Value, now: f64) {
        let key = Self::key(session_id, hash);
        self.entries.retain(|(existing, _)| existing != &key);
        self.entries.push((
            key,
            Entry {
                session_id: session_id.to_string(),
                verdict,
                at: now,
            },
        ));
        while (self.entries.len() as f64) > self.max_entries {
            self.entries.remove(0);
        }
    }

    /// `consume({ sessionId, text })` — idempotent, and expiry is the only
    /// thing that removes a verdict.
    pub fn consume(&mut self, session_id: &str, text: Option<&Value>, now: f64) -> Option<Value> {
        let key = Self::key(session_id, &text_hash(text));
        let at = self
            .entries
            .iter()
            .position(|(existing, _)| existing == &key)?;
        if now - self.entries[at].1.at > self.ttl_ms {
            self.entries.remove(at);
            return None;
        }
        Some(self.entries[at].1.verdict.clone())
    }

    /// `clearSession(sessionId)` — this session only; in-flight state is the
    /// caller's.
    pub fn clear_session(&mut self, session_id: &str) {
        self.entries
            .retain(|(_, entry)| entry.session_id != session_id);
    }

    pub fn size(&self) -> usize {
        self.entries.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture() -> Value {
        serde_json::from_str(include_str!("../tests/fixtures/auto-provider-routing.json"))
            .expect("routing fixture")
    }

    #[test]
    fn text_hash_replays_the_frozen_fixture() {
        for case in fixture()["cases"].as_array().unwrap() {
            if case["op"] != json!("textHash") {
                continue;
            }
            let text = &case["request"]["text"];
            // The fixture spells the `undefined` argument as the string
            // "undefined", because JSON has no hole for it.
            let hash = if *text == json!("undefined") {
                text_hash(None)
            } else {
                text_hash(Some(text))
            };
            assert_eq!(
                json!(hash),
                case["expect"]["value"]["hash"],
                "{}",
                case["name"]
            );
        }
    }

    #[test]
    fn unknown_tier_replays_the_frozen_fixture() {
        for case in fixture()["cases"].as_array().unwrap() {
            if case["op"] != json!("unknownTier") {
                continue;
            }
            let routing = &case["request"]["routing"];
            let verdict = &case["request"]["verdict"];
            let got = unknown_tier(
                (!routing.is_null()).then_some(routing),
                (!verdict.is_null()).then_some(verdict),
            );
            assert_eq!(got, case["expect"]["value"], "{}", case["name"]);
        }
    }

    #[test]
    fn resolve_tier_replays_the_frozen_fixture() {
        for case in fixture()["cases"].as_array().unwrap() {
            if case["op"] != json!("resolveTier") {
                continue;
            }
            // `resolveTier` answers `null` when the selection has no routing.
            let got = resolve_tier(&case["request"]).unwrap_or(Value::Null);
            assert_eq!(got, case["expect"]["value"], "{}", case["name"]);
        }
    }

    #[test]
    fn store_is_text_keyed_and_idempotent() {
        let mut store = Store::new(None, None);
        let verdict = json!({ "ok": true, "tier": "weak" });
        store.remember(
            "s1",
            &text_hash(Some(&json!("hello"))),
            verdict.clone(),
            0.0,
        );
        assert_eq!(
            store.consume("s1", Some(&json!("hello")), 0.0),
            Some(verdict.clone())
        );
        assert_eq!(
            store.consume("s1", Some(&json!("hello")), 1.0),
            Some(verdict)
        );
        assert_eq!(store.consume("s1", Some(&json!("other")), 0.0), None);
        assert_eq!(store.consume("s2", Some(&json!("hello")), 0.0), None);
        assert_eq!(store.size(), 1);
    }

    #[test]
    fn store_expires_after_ttl_and_only_on_read() {
        let mut store = Store::new(Some(1_000.0), None);
        store.remember(
            "s1",
            &text_hash(Some(&json!("hi"))),
            json!({ "ok": true }),
            500.0,
        );
        assert_eq!(
            store.consume("s1", Some(&json!("hi")), 1_500.0),
            Some(json!({ "ok": true }))
        );
        assert_eq!(store.consume("s1", Some(&json!("hi")), 1_501.0), None);
        assert_eq!(store.size(), 0);
        // A non-positive or unusable option clamps to the documented floor.
        let store = Store::new(Some(-5.0), Some(1.0));
        assert_eq!(store.ttl_ms(), 1_000.0);
        assert_eq!(store.max_entries(), 8.0);
        let store = Store::new(None, None);
        assert_eq!(store.ttl_ms(), DEFAULT_TTL_MS);
        assert_eq!(store.max_entries(), MAX_ENTRIES);
    }

    #[test]
    fn eviction_drops_the_oldest_and_reinsert_moves_to_newest() {
        let mut store = Store::new(None, Some(8.0));
        let hash = |text: &str| text_hash(Some(&json!(text)));
        for at in 0..8 {
            store.remember(
                "s",
                &hash(&format!("m{at}")),
                json!({ "at": at }),
                at as f64,
            );
        }
        // Re-insert the oldest; the next-oldest becomes the eviction target.
        store.remember("s", &hash("m0"), json!({ "at": 99 }), 99.0);
        store.remember("s", &hash("m8"), json!({ "at": 8 }), 8.0);
        assert_eq!(store.size(), 8);
        assert_eq!(store.consume("s", Some(&json!("m1")), 0.0), None);
        assert_eq!(
            store.consume("s", Some(&json!("m0")), 0.0),
            Some(json!({ "at": 99 }))
        );
        assert_eq!(
            store.consume("s", Some(&json!("m8")), 0.0),
            Some(json!({ "at": 8 }))
        );
        assert!(store.consume("s", Some(&json!("m2")), 0.0).is_some());
    }

    #[test]
    fn clear_session_leaves_other_sessions_alone() {
        let mut store = Store::new(None, None);
        store.remember(
            "s1",
            &text_hash(Some(&json!("a"))),
            json!({ "ok": true }),
            0.0,
        );
        store.remember(
            "s2",
            &text_hash(Some(&json!("a"))),
            json!({ "ok": true }),
            0.0,
        );
        store.clear_session("s1");
        assert_eq!(store.size(), 1);
        assert_eq!(store.consume("s1", Some(&json!("a")), 0.0), None);
        assert!(store.consume("s2", Some(&json!("a")), 0.0).is_some());
    }
}
