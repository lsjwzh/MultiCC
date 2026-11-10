//! Delivery-handoff probe kernel (migrated from `src/chat/delivery-probe.js`).
//!
//! Persisted != delivered. Backs `runnerDeliveryHandoff()` in the turn engine:
//! `known && handedOff === false` means the live engine watched the message
//! fail before handoff, so re-executing cannot duplicate side effects;
//! `known && handedOff === true` keeps the idempotent skip; unknown (no
//! record, e.g. after a restart) keeps the conservative crash-recovery
//! reading "persisted = delivered".
//!
//! Identities are `clientMsgId` / `deliveryId` string keys refreshed LRU-style
//! (`delete` then `set`) and capped per session. The kernel owns the tables;
//! the facade only forwards values and keeps the registry frozen.
//!
//! Fixed bug (intentional divergence): the capability to hold zero identities
//! could leave an empty per-session table behind forever (the legacy `record`
//! created the table before reading the clock, and never pruned an emptied
//! one — a negative `maxIdentities` even looped forever deleting from nothing).
//! [`Probes::prune_empty`] drops empty tables, and the trim loop stops at
//! empty, so cap 0 or a negative cap cannot spin.
use crate::background::state::OrderedMap;
use crate::js::coerce::{js_to_string, truthy};
use crate::js::JsValue;

#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub handed_off: bool,
    pub turn_id: JsValue,
    pub at: f64,
}

pub struct Probes {
    by_session: OrderedMap<OrderedMap<Entry>>,
    max_identities: f64,
}

impl Probes {
    /// `maxIdentities` after the facade applied its `= 64` default. Kept as an
    /// f64 because the comparison is `size > maxIdentities` (a string cap
    /// coerces, NaN matches nothing, a negative cap empties the table).
    pub fn new(max_identities: f64) -> Self {
        Self {
            by_session: OrderedMap::new(),
            max_identities,
        }
    }

    /// The legacy `record` creates the per-session table before reading the
    /// clock, so a throwing clock must be able to roll the empty table back.
    pub fn ensure_session(&mut self, session: &JsValue) {
        let key = js_to_string(session);
        if !self.by_session.contains_key(&key) {
            self.by_session.set(key, OrderedMap::new());
        }
    }

    pub fn prune_empty(&mut self, session: &JsValue) {
        let key = js_to_string(session);
        if let Some(table) = self.by_session.get(&key) {
            if table.is_empty() {
                self.by_session.delete(&key);
            }
        }
    }

    /// Record one delivery fact under both identities. `handed_off` is already
    /// `facts.handedOff === true`; `turn_id` is `facts.turnId || null`; `at` is
    /// `Number(now())` (no finite check).
    pub fn record(
        &mut self,
        session: &JsValue,
        client_msg_id: Option<&JsValue>,
        delivery_id: Option<&JsValue>,
        handed_off: bool,
        turn_id: JsValue,
        at: f64,
    ) {
        let key = js_to_string(session);
        if let Some(table) = self.by_session.get_mut(&key) {
            let entry = Entry {
                handed_off,
                turn_id,
                at,
            };
            for identity in [client_msg_id, delivery_id].into_iter().flatten() {
                if !truthy(identity) {
                    continue;
                }
                let identity = js_to_string(identity);
                table.delete(&identity);
                table.set(identity, entry.clone());
            }
            while !table.is_empty() && table.len() as f64 > self.max_identities {
                let first = table.keys().next().cloned();
                match first {
                    Some(first) => {
                        table.delete(&first);
                    }
                    None => break,
                }
            }
        }
        self.prune_empty(session);
    }

    pub fn lookup(&self, session: &JsValue, identity: &JsValue) -> Option<&Entry> {
        let key = js_to_string(session);
        let table = self.by_session.get(&key)?;
        table.get(&js_to_string(identity))
    }

    pub fn forget(&mut self, session: &JsValue) -> bool {
        self.by_session.delete(&js_to_string(session)).is_some()
    }

    /// Introspection for the differential/unit tests: one entry per session
    /// that still holds at least one identity.
    pub fn session_count(&self) -> usize {
        self.by_session.len()
    }

    pub fn identity_count(&self, session: &JsValue) -> usize {
        self.by_session
            .get(&js_to_string(session))
            .map(OrderedMap::len)
            .unwrap_or(0)
    }
}

/// `duplicateSeen === true && duplicatePersisted === true && !!probe &&
/// probe.known === true && probe.handedOff === false`.
pub fn should_reexecute(
    duplicate_seen: &JsValue,
    duplicate_persisted: &JsValue,
    probe: Option<&JsValue>,
) -> bool {
    let strict_true = |value: &JsValue| matches!(value, JsValue::Bool(true));
    if !strict_true(duplicate_seen) || !strict_true(duplicate_persisted) {
        return false;
    }
    let Some(probe) = probe.filter(|probe| truthy(probe)) else {
        return false;
    };
    matches!(probe.get("known"), Some(JsValue::Bool(true)))
        && matches!(probe.get("handedOff"), Some(JsValue::Bool(false)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::js::JsString;

    fn value(text: &str) -> JsValue {
        JsValue::String(JsString::from_rust_str(text))
    }

    fn session() -> JsValue {
        value("sess")
    }

    fn registry(max: f64) -> Probes {
        let mut probes = Probes::new(max);
        probes.ensure_session(&session());
        probes
    }

    #[test]
    fn both_identities_share_one_lru_entry() {
        let mut probes = registry(64.0);
        probes.record(
            &session(),
            Some(&value("m1")),
            Some(&value("d1")),
            false,
            JsValue::Null,
            100.0,
        );
        assert_eq!(probes.identity_count(&session()), 2);
        let entry = probes.lookup(&session(), &value("m1")).unwrap();
        assert!(!entry.handed_off);
        assert_eq!(entry.at, 100.0);
        assert_eq!(
            probes.lookup(&session(), &value("d1")).map(|e| e.at),
            Some(100.0)
        );
        // A new record refreshes both keys to the end of the LRU order.
        probes.record(
            &session(),
            Some(&value("m1")),
            None,
            true,
            value("turn"),
            200.0,
        );
        assert_eq!(probes.lookup(&session(), &value("d1")).unwrap().at, 100.0);
        let entry = probes.lookup(&session(), &value("m1")).unwrap();
        assert!(entry.handed_off);
        assert_eq!(entry.turn_id, value("turn"));
    }

    #[test]
    fn cap_evicts_the_oldest_identity_and_never_spins() {
        let mut probes = registry(2.0);
        probes.record(
            &session(),
            Some(&value("a")),
            None,
            false,
            JsValue::Null,
            1.0,
        );
        probes.record(
            &session(),
            Some(&value("b")),
            None,
            false,
            JsValue::Null,
            2.0,
        );
        probes.record(
            &session(),
            Some(&value("c")),
            None,
            false,
            JsValue::Null,
            3.0,
        );
        assert!(probes.lookup(&session(), &value("a")).is_none());
        assert_eq!(probes.identity_count(&session()), 2);

        let mut zero = registry(0.0);
        zero.record(
            &session(),
            Some(&value("a")),
            None,
            false,
            JsValue::Null,
            1.0,
        );
        assert_eq!(zero.identity_count(&session()), 0);
        assert_eq!(zero.session_count(), 0, "an emptied table is pruned");

        let mut negative = registry(-1.0);
        negative.record(
            &session(),
            Some(&value("a")),
            None,
            false,
            JsValue::Null,
            1.0,
        );
        assert_eq!(negative.identity_count(&session()), 0);
        assert_eq!(negative.session_count(), 0);
    }

    #[test]
    fn prune_empty_rolls_back_a_throwing_clock_slot() {
        let mut probes = Probes::new(64.0);
        probes.ensure_session(&session());
        assert_eq!(probes.session_count(), 1);
        probes.prune_empty(&session());
        assert_eq!(probes.session_count(), 0);
        assert!(!probes.forget(&session()));
    }

    #[test]
    fn forget_drops_the_whole_session_table() {
        let mut probes = registry(64.0);
        probes.record(
            &session(),
            Some(&value("a")),
            None,
            false,
            JsValue::Null,
            1.0,
        );
        assert!(probes.forget(&session()));
        assert_eq!(probes.session_count(), 0);
        assert!(probes.lookup(&session(), &value("a")).is_none());
    }

    #[test]
    fn should_reexecute_requires_strict_booleans_and_known_failed_handoff() {
        let probe = |known: JsValue, handed_off: JsValue| {
            JsValue::Object(vec![
                (JsString::from_rust_str("known"), known),
                (JsString::from_rust_str("handedOff"), handed_off),
            ])
        };
        let yes = probe(JsValue::Bool(true), JsValue::Bool(false));
        assert!(should_reexecute(
            &JsValue::Bool(true),
            &JsValue::Bool(true),
            Some(&yes)
        ));
        for (seen, persisted, candidate) in [
            (JsValue::Number(1.0), JsValue::Bool(true), yes.clone()),
            (JsValue::Bool(true), JsValue::Number(1.0), yes.clone()),
            (JsValue::Bool(true), JsValue::Bool(true), JsValue::Null),
            (
                JsValue::Bool(true),
                JsValue::Bool(true),
                probe(JsValue::Bool(true), JsValue::Bool(true)),
            ),
            (
                JsValue::Bool(true),
                JsValue::Bool(true),
                probe(JsValue::Number(1.0), JsValue::Bool(false)),
            ),
        ] {
            assert!(!should_reexecute(&seen, &persisted, Some(&candidate)));
        }
    }
}
