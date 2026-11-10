//! Display metadata kept beside task control state.
//!
//! Metadata never decides whether a task is suppressed; it only remembers the
//! fields a late event can no longer carry (parent task, run id, subagent type,
//! task type, description). A late event is rejected when its `run_id` is older
//! than the stored one. The legacy code compared raw strings, so `"10" < "9"`
//! was true and a newer run could be dropped as stale. The rule here is: when
//! BOTH ids are canonical non-negative decimal integers (ASCII digits, no
//! leading zero unless the id is exactly `"0"`) compare them numerically; any
//! other pair keeps the byte/UTF-16 `compare_units` string comparison. Real CLI
//! ids look like `0mw7l8fr0-58e28fed`, so they keep the old string ordering.
use crate::background::state::{is_object_like, metadata_text, own_entries, spread, OrderedMap};
use crate::js::{coerce::or, string::compare_units, string::JsString, JsValue};

/// `true` for a canonical non-negative decimal integer: ASCII digits only and no
/// leading zero unless the whole string is `"0"`.
fn is_canonical_decimal(value: &JsString) -> bool {
    let units = value.as_units();
    match units.first() {
        None => false,
        Some(&first) if first == u16::from(b'0') => units.len() == 1,
        Some(first) => {
            (*first >= u16::from(b'0') && *first <= u16::from(b'9'))
                && units
                    .iter()
                    .all(|unit| *unit >= u16::from(b'0') && *unit <= u16::from(b'9'))
        }
    }
}

/// Compare run ids: numerically when both are canonical decimal integers (by
/// digit count, then lexicographically — valid for arbitrary length), otherwise
/// with the legacy string comparison.
fn compare_run_ids(left: &JsString, right: &JsString) -> std::cmp::Ordering {
    if is_canonical_decimal(left) && is_canonical_decimal(right) {
        left.len()
            .cmp(&right.len())
            .then_with(|| compare_units(left, right))
    } else {
        compare_units(left, right)
    }
}

pub const FIELDS: [&str; 4] = ["parent_task_id", "run_id", "subagent_type", "task_type"];
const DESCRIPTION: &str = "description";

#[derive(Clone, Debug, Default, PartialEq)]
pub struct MetaTask {
    pub values: OrderedMap<JsString>,
}

#[derive(Clone, Debug)]
pub struct MetaStore {
    sessions: OrderedMap<OrderedMap<MetaTask>>,
    snapshots: OrderedMap<OrderedMap<JsValue>>,
}

impl Default for MetaStore {
    fn default() -> Self {
        Self {
            sessions: OrderedMap::new(),
            snapshots: OrderedMap::new(),
        }
    }
}

/// The cleaned fields read from a task-like object.
#[derive(Clone, Debug)]
pub struct MetaInput {
    pub id: JsString,
    pub run_id: JsString,
    pub fields: [JsString; 4],
    pub description: JsString,
}

impl MetaInput {
    pub fn from_value(task: &JsValue) -> Self {
        let id = metadata_text(or(task.get("task_id"), task.get("id")));
        let run_id = metadata_text(task.get("run_id"));
        let fields = [
            metadata_text(task.get(FIELDS[0])),
            metadata_text(task.get(FIELDS[1])),
            metadata_text(task.get(FIELDS[2])),
            metadata_text(task.get(FIELDS[3])),
        ];
        let description = metadata_text(task.get(DESCRIPTION));
        Self {
            id,
            run_id,
            fields,
            description,
        }
    }
}

fn raw_id(task: &JsValue) -> JsValue {
    or(task.get("task_id"), task.get("id"))
        .cloned()
        .unwrap_or(JsValue::Undefined)
}

impl MetaStore {
    pub fn remember(&mut self, session: &JsString, input: &MetaInput) -> bool {
        if input.id.is_empty() {
            return true;
        }
        if !self.sessions.contains_key(session) {
            self.sessions.set(session.clone(), OrderedMap::new());
        }
        let snapshot_keys: Vec<JsString> = self
            .snapshots
            .get(session)
            .map(|snapshot| snapshot.keys_vec())
            .unwrap_or_default();
        let tasks = self
            .sessions
            .get_mut(session)
            .expect("session map inserted above");
        let previous = tasks.get(&input.id).cloned().unwrap_or_default();
        if !input.run_id.is_empty() {
            if let Some(previous_run) = previous.values.get(&JsString::from_rust_str("run_id")) {
                if !previous_run.is_empty()
                    && compare_run_ids(&input.run_id, previous_run) == std::cmp::Ordering::Less
                {
                    return false;
                }
            }
        }
        let mut next = previous;
        for (field, value) in FIELDS.iter().zip(input.fields.iter()) {
            if !value.is_empty() {
                next.values
                    .set(JsString::from_rust_str(field), value.clone());
            }
        }
        if !input.description.is_empty() {
            next.values.set(
                JsString::from_rust_str(DESCRIPTION),
                input.description.clone(),
            );
        }
        tasks.delete(&input.id);
        tasks.set(input.id.clone(), next);
        if tasks.len() > 2000 {
            for key in tasks.keys_vec() {
                if !snapshot_keys.iter().any(|snapshot| snapshot == &key) {
                    tasks.delete(&key);
                }
                if tasks.len() <= 2000 {
                    break;
                }
            }
        }
        true
    }

    /// `{ ...fields }` in FIELDS order, then `parent_description`.
    pub fn fields_entries(&self, session: &JsString, id: &JsValue) -> Vec<(JsString, JsValue)> {
        let key = crate::js::coerce::js_to_string(id);
        let Some(task) = self.sessions.get(session).and_then(|tasks| tasks.get(&key)) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for field in FIELDS {
            if let Some(value) = task.values.get(&JsString::from_rust_str(field)) {
                if !value.is_empty() {
                    out.push((
                        JsString::from_rust_str(field),
                        JsValue::String(value.clone()),
                    ));
                }
            }
        }
        let parent_key = task.values.get(&JsString::from_rust_str("parent_task_id"));
        if let Some(parent_key) = parent_key {
            if !parent_key.is_empty() {
                if let Some(parent) = self
                    .sessions
                    .get(session)
                    .and_then(|tasks| tasks.get(parent_key))
                {
                    if let Some(description) =
                        parent.values.get(&JsString::from_rust_str(DESCRIPTION))
                    {
                        if !description.is_empty() {
                            out.push((
                                JsString::from_rust_str("parent_description"),
                                JsValue::String(description.clone()),
                            ));
                        }
                    }
                }
            }
        }
        out
    }

    pub fn description(&self, session: &JsString, id: &JsValue) -> Option<JsString> {
        let key = crate::js::coerce::js_to_string(id);
        self.sessions
            .get(session)
            .and_then(|tasks| tasks.get(&key))
            .and_then(|task| task.values.get(&JsString::from_rust_str(DESCRIPTION)))
            .cloned()
    }

    /// Remember every object task, refresh the active snapshot, and return the
    /// per-task rows (`task spread fields`).
    pub fn snapshot(&mut self, session: &JsString, tasks: &[JsValue]) -> Vec<JsValue> {
        let mut active: OrderedMap<JsValue> = OrderedMap::new();
        for task in tasks {
            if !is_object_like(task) {
                continue;
            }
            let input = MetaInput::from_value(task);
            if input.id.is_empty() {
                continue;
            }
            let accepted = self.remember(session, &input);
            let stored = if accepted {
                task.clone()
            } else {
                let description = self
                    .sessions
                    .get(session)
                    .and_then(|entries| entries.get(&input.id))
                    .and_then(|entry| entry.values.get(&JsString::from_rust_str(DESCRIPTION)))
                    .cloned()
                    .map(JsValue::String)
                    .or_else(|| task.get(DESCRIPTION).cloned())
                    .unwrap_or(JsValue::Undefined);
                JsValue::Object(spread(
                    own_entries(task),
                    vec![(JsString::from_rust_str(DESCRIPTION), description)],
                ))
            };
            active.set(input.id, stored);
        }
        self.snapshots.set(session.clone(), active.clone());
        let mut out = Vec::with_capacity(tasks.len());
        for task in tasks {
            if !is_object_like(task) {
                out.push(task.clone());
                continue;
            }
            let id = metadata_text(or(task.get("task_id"), task.get("id")));
            let base = active.get(&id).cloned().unwrap_or_else(|| task.clone());
            let fields = self.fields_entries(session, &raw_id(task));
            out.push(JsValue::Object(spread(own_entries(&base), fields)));
        }
        out
    }

    /// Snapshot tasks of one session with metadata fields merged in.
    pub fn active(&self, session: &JsString) -> Vec<JsValue> {
        let Some(snapshot) = self.snapshots.get(session) else {
            return Vec::new();
        };
        snapshot
            .values()
            .map(|task| {
                let fields = self.fields_entries(session, &raw_id(task));
                JsValue::Object(spread(own_entries(task), fields))
            })
            .collect()
    }

    pub fn finish(&mut self, session: &JsString, id: &JsValue) {
        let key = crate::js::coerce::js_to_string(id);
        if let Some(snapshot) = self.snapshots.get_mut(session) {
            snapshot.delete(&key);
        }
    }

    pub fn clear(&mut self, session: &JsString) {
        self.sessions.delete(session);
        self.snapshots.delete(session);
    }

    #[cfg(test)]
    pub fn task_count(&self, session: &JsString) -> usize {
        self.sessions.get(session).map_or(0, |tasks| tasks.len())
    }
}

impl MetaStore {
    pub fn new() -> Self {
        Self::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(value: &str) -> JsString {
        JsString::from_rust_str(value)
    }

    fn task(entries: Vec<(&str, JsValue)>) -> JsValue {
        JsValue::object(
            entries
                .into_iter()
                .map(|(key, value)| (JsString::from_rust_str(key), value))
                .collect::<Vec<_>>(),
        )
    }

    #[test]
    fn remember_merges_and_moves_to_the_end() {
        let mut store = MetaStore::new();
        let session = text("s");
        assert!(store.remember(
            &session,
            &MetaInput::from_value(&task(vec![
                ("task_id", JsValue::string("a")),
                ("subagent_type", JsValue::string("Explore")),
            ]))
        ));
        assert!(store.remember(
            &session,
            &MetaInput::from_value(&task(vec![
                ("task_id", JsValue::string("b")),
                ("description", JsValue::string("other")),
            ]))
        ));
        assert!(store.remember(
            &session,
            &MetaInput::from_value(&task(vec![
                ("task_id", JsValue::string("a")),
                ("description", JsValue::string("first")),
            ]))
        ));
        assert_eq!(store.task_count(&session), 2);
        let fields = store.fields_entries(&session, &JsValue::string("a"));
        assert_eq!(fields.len(), 1);
        assert_eq!(fields[0].0, text("subagent_type"));
        assert_eq!(fields[0].1, JsValue::string("Explore"));
        assert_eq!(
            store.description(&session, &JsValue::string("a")),
            Some(text("first"))
        );
    }

    #[test]
    fn stale_runs_compare_numeric_ids_numerically() {
        let mut store = MetaStore::new();
        let session = text("s");
        assert!(store.remember(
            &session,
            &MetaInput::from_value(&task(vec![
                ("task_id", JsValue::string("a")),
                ("run_id", JsValue::string("9")),
            ]))
        ));
        // "10" is numerically newer than "9", so the late event is accepted.
        assert!(store.remember(
            &session,
            &MetaInput::from_value(&task(vec![
                ("task_id", JsValue::string("a")),
                ("run_id", JsValue::string("10")),
                ("description", JsValue::string("new")),
            ]))
        ));
        assert_eq!(
            store.description(&session, &JsValue::string("a")),
            Some(text("new"))
        );
        // "9" after "10" is older numerically and is rejected as stale.
        assert!(!store.remember(
            &session,
            &MetaInput::from_value(&task(vec![
                ("task_id", JsValue::string("a")),
                ("run_id", JsValue::string("9")),
                ("description", JsValue::string("ignored")),
            ]))
        ));
        assert_eq!(
            store.description(&session, &JsValue::string("a")),
            Some(text("new"))
        );
    }

    #[test]
    fn stale_runs_keep_string_comparison_for_non_numeric_ids() {
        let mut store = MetaStore::new();
        let session = text("s");
        assert!(store.remember(
            &session,
            &MetaInput::from_value(&task(vec![
                ("task_id", JsValue::string("a")),
                ("run_id", JsValue::string("x-9")),
            ]))
        ));
        // Non-numeric ids keep the legacy string comparison: "x-10" < "x-9".
        assert!(!store.remember(
            &session,
            &MetaInput::from_value(&task(vec![
                ("task_id", JsValue::string("a")),
                ("run_id", JsValue::string("x-10")),
            ]))
        ));
        // "x-99" > "x-9" as strings, so a newer-looking string run is accepted.
        assert!(store.remember(
            &session,
            &MetaInput::from_value(&task(vec![
                ("task_id", JsValue::string("a")),
                ("run_id", JsValue::string("x-99")),
            ]))
        ));
    }

    #[test]
    fn canonical_decimal_detection_edges() {
        assert!(is_canonical_decimal(&text("0")));
        assert!(is_canonical_decimal(&text("10")));
        assert!(!is_canonical_decimal(&text("010")));
        assert!(!is_canonical_decimal(&text("")));
        assert!(!is_canonical_decimal(&text("1a")));
        assert!(!is_canonical_decimal(&text("-1")));
        // When only one side is canonical the legacy string comparison applies:
        // "010" < "10" as strings, so the canonical "10" is still accepted.
        assert_eq!(
            compare_run_ids(&text("10"), &text("010")),
            std::cmp::Ordering::Greater
        );
    }

    #[test]
    fn snapshot_returns_merged_rows_and_keeps_non_objects() {
        let mut store = MetaStore::new();
        let session = text("s");
        let parent = task(vec![
            ("task_id", JsValue::string("p")),
            ("description", JsValue::string("parent")),
        ]);
        let child = task(vec![
            ("task_id", JsValue::string("c")),
            ("parent_task_id", JsValue::string("p")),
            ("description", JsValue::string("child")),
        ]);
        let rows = store.snapshot(&session, &[parent, child.clone(), JsValue::Number(1.0)]);
        assert_eq!(rows.len(), 3);
        let JsValue::Object(child_row) = &rows[1] else {
            panic!("child row");
        };
        assert!(child_row
            .iter()
            .any(|(key, value)| key == &text("parent_description")
                && value == &JsValue::string("parent")));
        assert_eq!(rows[2], JsValue::Number(1.0));
        let active = store.active(&session);
        assert_eq!(active.len(), 2);
        let JsValue::Object(entries) = &active[1] else {
            panic!("row object");
        };
        assert!(entries
            .iter()
            .any(|(key, value)| key == &text("parent_description")
                && value == &JsValue::string("parent")));
    }
}
