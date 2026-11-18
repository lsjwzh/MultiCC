//! Version-bound scheduler metadata cache; not yet a production scheduler.
//!
//! A snapshot contains no message bodies or host callback facts. Its version
//! must be observed on the same SQLite connection at every read and before any
//! future commit; this module does not replace that transaction validation.
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

const MAX_ID_BYTES: usize = 1024;
const MAX_SAFE_SEQUENCE: u64 = 9_007_199_254_740_991;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Version {
    pub revision: u64,
    pub data_version: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutboxState {
    Pending,
    Leased,
}

#[derive(Clone, Debug, PartialEq)]
pub struct QueueEntry {
    pub id: String,
    pub state: OutboxState,
    pub sequence: u64,
    pub queue_order: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Snapshot {
    pub session_id: String,
    pub active_delivery_id: Option<String>,
    pub priority_entry_id: Option<String>,
    pub entries: Vec<QueueEntry>,
}

#[derive(Clone, Debug)]
pub struct Ticket {
    session_id: String,
    generation: u64,
    epoch: u64,
    version: Version,
}

#[derive(Debug, PartialEq, Eq)]
pub enum CacheError {
    InvalidIdentifier,
    InvalidEntry,
    DuplicateEntry,
    Capacity,
    Stale,
    Exhausted,
    Poisoned,
}

struct Slot {
    generation: u64,
    version: Version,
    snapshot: Option<Arc<Snapshot>>,
    rows: usize,
    bytes: usize,
}

struct State {
    epoch: u64,
    next_generation: u64,
    slots: HashMap<String, Slot>,
    rows: usize,
    bytes: usize,
}

/// Session, row and payload allocation budgets bound this cache's owned slots.
/// In-flight builds and `Arc`s retained by readers require separate limits.
pub struct Cache {
    state: Mutex<State>,
    max_sessions: usize,
    max_rows: usize,
    max_bytes: usize,
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= MAX_ID_BYTES
}

impl Cache {
    pub fn new(max_sessions: usize, max_rows: usize, max_bytes: usize) -> Self {
        Self {
            state: Mutex::new(State {
                epoch: 0,
                next_generation: 0,
                slots: HashMap::new(),
                rows: 0,
                bytes: 0,
            }),
            max_sessions,
            max_rows,
            max_bytes,
        }
    }

    /// Invalidates the old value before starting a rebuild. The caller may
    /// build on a worker, but must acquire host facts at their original time.
    pub fn begin(&self, session_id: &str, version: Version) -> Result<Ticket, CacheError> {
        if !valid_id(session_id) {
            return Err(CacheError::InvalidIdentifier);
        }
        let mut state = self.state.lock().map_err(|_| CacheError::Poisoned)?;
        if !state.slots.contains_key(session_id) && state.slots.len() >= self.max_sessions {
            return Err(CacheError::Capacity);
        }
        let generation = state
            .next_generation
            .checked_add(1)
            .ok_or(CacheError::Exhausted)?;
        state.next_generation = generation;
        if let Some(old) = state.slots.remove(session_id) {
            state.rows -= old.rows;
            state.bytes -= old.bytes;
        }
        let epoch = state.epoch;
        state.slots.insert(
            session_id.to_owned(),
            Slot {
                generation,
                version,
                snapshot: None,
                rows: 0,
                bytes: 0,
            },
        );
        Ok(Ticket {
            session_id: session_id.to_owned(),
            generation,
            epoch,
            version,
        })
    }

    /// A write or external invalidation makes even an in-flight build stale.
    pub fn invalidate_all(&self) -> Result<(), CacheError> {
        let mut state = self.state.lock().map_err(|_| CacheError::Poisoned)?;
        let epoch = state.epoch.checked_add(1);
        state.slots.clear();
        state.rows = 0;
        state.bytes = 0;
        state.epoch = epoch.ok_or(CacheError::Exhausted)?;
        Ok(())
    }

    /// Failing builds must release their reserved slot without removing a
    /// later build for the same session.
    pub fn cancel(&self, ticket: &Ticket) -> Result<bool, CacheError> {
        let mut state = self.state.lock().map_err(|_| CacheError::Poisoned)?;
        let matches = state.epoch == ticket.epoch
            && state
                .slots
                .get(&ticket.session_id)
                .is_some_and(|s| s.generation == ticket.generation && s.snapshot.is_none());
        if matches {
            state.slots.remove(&ticket.session_id);
        }
        Ok(matches)
    }

    pub fn publish(
        &self,
        ticket: &Ticket,
        observed: Version,
        snapshot: Snapshot,
    ) -> Result<(), CacheError> {
        if snapshot.session_id != ticket.session_id {
            return Err(CacheError::InvalidIdentifier);
        }
        if snapshot.entries.len() > self.max_rows {
            return Err(CacheError::Capacity);
        }
        let mut bytes = snapshot
            .session_id
            .capacity()
            .checked_add(snapshot.session_id.len())
            .and_then(|n| n.checked_add(std::mem::size_of::<Snapshot>()))
            .and_then(|n| {
                snapshot
                    .entries
                    .capacity()
                    .checked_mul(std::mem::size_of::<QueueEntry>())
                    .and_then(|v| n.checked_add(v))
            })
            .ok_or(CacheError::Capacity)?;
        for id in [&snapshot.active_delivery_id, &snapshot.priority_entry_id]
            .into_iter()
            .flatten()
        {
            if !valid_id(id) {
                return Err(CacheError::InvalidIdentifier);
            }
            bytes = bytes
                .checked_add(id.capacity())
                .ok_or(CacheError::Capacity)?;
        }
        let mut ids = HashSet::with_capacity(snapshot.entries.len());
        let mut sequences = HashSet::with_capacity(snapshot.entries.len());
        for entry in &snapshot.entries {
            if !valid_id(&entry.id) {
                return Err(CacheError::InvalidIdentifier);
            }
            if entry.sequence == 0
                || entry.sequence > MAX_SAFE_SEQUENCE
                || entry.queue_order.is_some_and(|n| !n.is_finite())
            {
                return Err(CacheError::InvalidEntry);
            }
            if !ids.insert(&entry.id) || !sequences.insert(entry.sequence) {
                return Err(CacheError::DuplicateEntry);
            }
            bytes = bytes
                .checked_add(entry.id.capacity())
                .ok_or(CacheError::Capacity)?;
        }
        let mut state = self.state.lock().map_err(|_| CacheError::Poisoned)?;
        let same_build = state.epoch == ticket.epoch
            && state.slots.get(&ticket.session_id).is_some_and(|s| {
                s.generation == ticket.generation
                    && s.version == ticket.version
                    && s.snapshot.is_none()
            });
        if same_build && observed != ticket.version {
            state.slots.remove(&ticket.session_id);
            return Err(CacheError::Stale);
        }
        let valid = state.epoch == ticket.epoch
            && observed == ticket.version
            && state.slots.get(&ticket.session_id).is_some_and(|s| {
                s.generation == ticket.generation && s.version == observed && s.snapshot.is_none()
            });
        if !valid {
            return Err(CacheError::Stale);
        }
        let total_rows = state
            .rows
            .checked_add(snapshot.entries.len())
            .ok_or(CacheError::Capacity)?;
        let total_bytes = state.bytes.checked_add(bytes).ok_or(CacheError::Capacity)?;
        if total_rows > self.max_rows || total_bytes > self.max_bytes {
            return Err(CacheError::Capacity);
        }
        let rows = snapshot.entries.len();
        let slot = state
            .slots
            .get_mut(&ticket.session_id)
            .ok_or(CacheError::Stale)?;
        slot.snapshot = Some(Arc::new(snapshot));
        slot.rows = rows;
        slot.bytes = bytes;
        state.rows = total_rows;
        state.bytes = total_bytes;
        Ok(())
    }

    pub fn get(
        &self,
        session_id: &str,
        observed: Version,
    ) -> Result<Option<Arc<Snapshot>>, CacheError> {
        let mut state = self.state.lock().map_err(|_| CacheError::Poisoned)?;
        if state
            .slots
            .get(session_id)
            .is_some_and(|s| s.version != observed)
        {
            if let Some(old) = state.slots.remove(session_id) {
                state.rows -= old.rows;
                state.bytes -= old.bytes;
            }
            return Ok(None);
        }
        Ok(state
            .slots
            .get(session_id)
            .filter(|s| s.version == observed)
            .and_then(|s| s.snapshot.clone()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use std::sync::Barrier;

    fn v(revision: u64, data_version: i64) -> Version {
        Version {
            revision,
            data_version,
        }
    }
    fn snapshot(id: &str, entries: &[(&str, u64)]) -> Snapshot {
        Snapshot {
            session_id: id.into(),
            active_delivery_id: None,
            priority_entry_id: None,
            entries: entries
                .iter()
                .map(|(id, sequence)| QueueEntry {
                    id: (*id).into(),
                    state: OutboxState::Pending,
                    sequence: *sequence,
                    queue_order: None,
                })
                .collect(),
        }
    }

    #[test]
    fn builds_are_versioned_and_cannot_resurrect_after_invalidation() {
        let cache = Cache::new(2, 8, 2048);
        let first = cache.begin("s", v(1, 7)).unwrap();
        assert!(cache.get("s", v(1, 7)).unwrap().is_none());
        let second = cache.begin("s", v(1, 7)).unwrap();
        assert_eq!(
            cache.publish(&first, v(1, 7), snapshot("s", &[])),
            Err(CacheError::Stale)
        );
        assert!(!cache.cancel(&first).unwrap());
        cache
            .publish(&second, v(1, 7), snapshot("s", &[("a", 1)]))
            .unwrap();
        assert_eq!(cache.get("s", v(1, 7)).unwrap().unwrap().entries[0].id, "a");
        assert!(cache.get("s", v(1, 8)).unwrap().is_none());
        assert!(cache.get("s", v(1, 7)).unwrap().is_none());
        cache.invalidate_all().unwrap();
        assert!(cache.get("s", v(1, 7)).unwrap().is_none());
        assert_eq!(
            cache.publish(&second, v(1, 7), snapshot("s", &[])),
            Err(CacheError::Stale)
        );
        let third = cache.begin("s", v(1, 7)).unwrap();
        assert_eq!(
            cache.publish(&third, v(1, 8), snapshot("s", &[])),
            Err(CacheError::Stale)
        );
        assert!(!cache.cancel(&third).unwrap());
    }

    #[test]
    fn capacity_and_invalid_rows_fail_without_publishing_or_disturbing_other_sessions() {
        let cache = Cache::new(2, 1, 1024);
        let a = cache.begin("a", v(0, 1)).unwrap();
        cache
            .publish(&a, v(0, 1), snapshot("a", &[("a1", 1)]))
            .unwrap();
        let b = cache.begin("b", v(0, 1)).unwrap();
        assert_eq!(cache.begin("c", v(0, 1)).unwrap_err(), CacheError::Capacity);
        assert_eq!(
            cache.publish(&b, v(0, 1), snapshot("b", &[("b1", 2)])),
            Err(CacheError::Capacity)
        );
        assert!(cache.get("b", v(0, 1)).unwrap().is_none());
        assert!(cache.get("a", v(0, 1)).unwrap().is_some());
        assert!(cache.cancel(&b).unwrap());
        cache.invalidate_all().unwrap();
        let c = cache.begin("c", v(0, 1)).unwrap();
        assert_eq!(
            cache.publish(&c, v(0, 1), snapshot("c", &[("x", 0)])),
            Err(CacheError::InvalidEntry)
        );
        cache
            .publish(&c, v(0, 1), snapshot("c", &[("x", 1)]))
            .unwrap();
        let d = Cache::new(1, 2, 4096);
        let t = d.begin("d", v(0, 1)).unwrap();
        assert_eq!(
            d.publish(&t, v(0, 1), snapshot("d", &[("x", 1), ("y", 1)])),
            Err(CacheError::DuplicateEntry)
        );
        let mut invalid = snapshot("d", &[("x", 1)]);
        invalid.entries[0].queue_order = Some(f64::NAN);
        assert_eq!(
            d.publish(&t, v(0, 1), invalid),
            Err(CacheError::InvalidEntry)
        );
        let limited = Cache::new(1, 1, 512);
        let ticket = limited.begin("s", v(0, 1)).unwrap();
        let mut oversized = snapshot("s", &[("x", 1)]);
        oversized.entries[0].id.reserve(4096);
        assert_eq!(
            limited.publish(&ticket, v(0, 1), oversized),
            Err(CacheError::Capacity)
        );
        assert!(limited.get("s", v(0, 1)).unwrap().is_none());
    }

    #[test]
    fn invalidation_wins_over_a_late_background_publisher() {
        let cache = Arc::new(Cache::new(1, 8, 2048));
        let ticket = cache.begin("s", v(1, 1)).unwrap();
        let barrier = Arc::new(Barrier::new(2));
        let worker = {
            let cache = Arc::clone(&cache);
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                barrier.wait();
                cache.publish(&ticket, v(1, 1), snapshot("s", &[("old", 1)]))
            })
        };
        barrier.wait();
        cache.invalidate_all().unwrap();
        let new = cache.begin("s", v(2, 1)).unwrap();
        cache
            .publish(&new, v(2, 1), snapshot("s", &[("new", 2)]))
            .unwrap();
        barrier.wait();
        assert_eq!(worker.join().unwrap(), Err(CacheError::Stale));
        assert_eq!(
            cache.get("s", v(2, 1)).unwrap().unwrap().entries[0].id,
            "new"
        );
    }

    #[test]
    fn sqlite_external_commit_invalidates_but_rollback_does_not() {
        let dir = std::env::temp_dir().join(format!(
            "multicc-scheduler-model-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir(&dir).unwrap();
        let file = dir.join("state.sqlite");
        {
            let owner = Connection::open(&file).unwrap();
            owner.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE item (id TEXT); INSERT INTO item VALUES ('original');").unwrap();
            let other = Connection::open(&file).unwrap();
            let data_version = || {
                owner
                    .query_row("PRAGMA data_version", [], |r| r.get::<_, i64>(0))
                    .unwrap()
            };
            let before = data_version();
            let cache = Cache::new(1, 8, 2048);
            let ticket = cache.begin("s", v(0, before)).unwrap();
            cache
                .publish(&ticket, v(0, before), snapshot("s", &[("original", 1)]))
                .unwrap();
            other
                .execute_batch("BEGIN; INSERT INTO item VALUES ('rolled-back'); ROLLBACK;")
                .unwrap();
            assert_eq!(data_version(), before);
            assert!(cache.get("s", v(0, data_version())).unwrap().is_some());
            other
                .execute_batch("INSERT INTO item VALUES ('committed');")
                .unwrap();
            assert_ne!(data_version(), before);
            assert!(cache.get("s", v(0, data_version())).unwrap().is_none());
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn failed_invalidation_rolls_back_a_prepared_owner_commit() {
        use crate::orchestration_retention::RetentionPolicy;
        use crate::orchestration_store::Store;
        let dir = std::env::temp_dir().join(format!(
            "multicc-scheduler-poison-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir(&dir).unwrap();
        let file = dir.join("state.sqlite");
        {
            let mut store =
                Store::open(file.to_str().unwrap(), None, 0, RetentionPolicy::default()).unwrap();
            let cache = Arc::new(Cache::new(1, 8, 2048));
            store.attach_scheduler_cache(Arc::clone(&cache));
            let header = store.request("begin", &serde_json::json!({})).unwrap();
            let mut next = header.clone();
            next["revision"] = serde_json::json!(header["revision"].as_u64().unwrap() + 1);
            store.request("prepare", &serde_json::json!({"expectedRevision":header["revision"],"state":next,"changes":[]})).unwrap();
            let worker_cache = Arc::clone(&cache);
            assert!(std::thread::spawn(move || {
                let _guard = worker_cache.state.lock().unwrap();
                panic!("simulate a cache panic");
            })
            .join()
            .is_err());
            assert!(store
                .request("commit", &serde_json::json!({}))
                .unwrap_err()
                .contains("invalidation failed"));
            assert_eq!(
                store.request("info", &serde_json::json!({})).unwrap()["state"]["revision"],
                header["revision"]
            );
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}
