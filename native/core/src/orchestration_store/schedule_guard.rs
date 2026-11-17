//! Experimental commit-side validation for prepared scheduler metadata.
//! This is not yet connected to the production scheduler or write paths.
use super::{err, header, schedule_identity, Result};
use crate::scheduler_read_model::{Cache, Snapshot, Version};
use rusqlite::{Connection, TransactionState};
use std::sync::Arc;
use std::{fs::File, path::Path};

/// Use only the same connection on which the version was captured. A write
/// transaction excludes other SQLite writers until its eventual commit or
/// rollback; the caller must also invalidate on every local write and keep
/// the database identity pinned. This helper neither commits nor rolls back.
pub fn validate_in_write_transaction(
    connection: &Connection,
    cache: &Cache,
    session_id: &str,
) -> Result<Arc<Snapshot>> {
    if connection.transaction_state(Some("main")).map_err(err)? != TransactionState::Write {
        return Err(err("scheduler validation requires a write transaction"));
    }
    let revision = header(connection)?["revision"]
        .as_u64()
        .ok_or_else(|| err("invalid scheduler metadata revision"))?;
    let data_version = connection
        .query_row("PRAGMA data_version", [], |row| row.get(0))
        .map_err(err)?;
    cache
        .get(
            session_id,
            Version {
                revision,
                data_version,
            },
        )
        .map_err(|error| err(format!("scheduler model unavailable: {error:?}")))?
        .ok_or_else(|| err("scheduler model is unavailable or stale"))
}

/// Multiple owner sessions cannot compare `data_version` values obtained from
/// different SQLite connections. A dedicated, autocommit-only monitor can
/// observe writes from all of them; its value is meaningful only for builds
/// that used this exact monitor. The caller must ensure both connections refer
/// to the pinned database and serialize monitor access.
pub fn validate_with_monitor(
    writer: &Connection,
    monitor: &Connection,
    cache: &Cache,
    session_id: &str,
) -> Result<Arc<Snapshot>> {
    if std::ptr::eq(writer, monitor) || !monitor.is_autocommit() {
        return Err(err(
            "scheduler monitor must be a separate autocommit connection",
        ));
    }
    if writer.transaction_state(Some("main")).map_err(err)? != TransactionState::Write {
        return Err(err("scheduler validation requires a write transaction"));
    }
    let revision = header(writer)?["revision"]
        .as_u64()
        .ok_or_else(|| err("invalid scheduler metadata revision"))?;
    let data_version = monitor
        .query_row("PRAGMA data_version", [], |row| row.get(0))
        .map_err(err)?;
    cache
        .get(
            session_id,
            Version {
                revision,
                data_version,
            },
        )
        .map_err(|error| err(format!("scheduler model unavailable: {error:?}")))?
        .ok_or_else(|| err("scheduler model is unavailable or stale"))
}

/// Experimental composition of file checks and version checking under the
/// writer lock. A failed identity observation invalidates all cached models.
/// Path and SQLite checks are not atomic against a hostile concurrent rename.
pub fn validate_pinned_with_monitor(
    writer: &Connection,
    monitor: &Connection,
    anchor: &File,
    path: &Path,
    cache: &Cache,
    session_id: &str,
) -> Result<Arc<Snapshot>> {
    if writer.transaction_state(Some("main")).map_err(err)? != TransactionState::Write {
        return Err(err("scheduler validation requires a write transaction"));
    }
    let identity = || -> Result<()> {
        schedule_identity::anchor_matches(anchor, path)?;
        schedule_identity::sqlite_matches_anchor(writer, anchor)?;
        schedule_identity::sqlite_matches_anchor(monitor, anchor)?;
        schedule_identity::anchor_matches(anchor, path)
    };
    let result = identity().and_then(|()| {
        let snapshot = validate_with_monitor(writer, monitor, cache, session_id)?;
        identity()?;
        Ok(snapshot)
    });
    if result.is_err() {
        cache
            .invalidate_all()
            .map_err(|error| err(format!("scheduler cache invalidation failed: {error:?}")))?;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestration_retention::RetentionPolicy;
    use crate::orchestration_store::Store;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Duration;

    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "multicc-schedule-fence-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir(&dir).unwrap();
            Self(dir)
        }
        fn file(&self) -> std::path::PathBuf {
            self.0.join("state.sqlite")
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn version(db: &Connection) -> Version {
        Version {
            revision: header(db).unwrap()["revision"].as_u64().unwrap(),
            data_version: db
                .query_row("PRAGMA data_version", [], |r| r.get(0))
                .unwrap(),
        }
    }
    fn put(cache: &Cache, version: Version) {
        let ticket = cache.begin("s", version).unwrap();
        cache
            .publish(
                &ticket,
                version,
                Snapshot {
                    session_id: "s".into(),
                    active_delivery_id: None,
                    priority_entry_id: None,
                    entries: vec![],
                },
            )
            .unwrap();
    }

    #[test]
    fn write_lock_and_same_connection_version_are_required() {
        let fixture = Fixture::new();
        let file = fixture.file();
        let store =
            Store::open(file.to_str().unwrap(), None, 0, RetentionPolicy::default()).unwrap();
        let owner = Connection::open(&file).unwrap();
        let other = Connection::open(&file).unwrap();
        other.busy_timeout(Duration::from_millis(30)).unwrap();
        let cache = Cache::new(2, 8, 2048);
        put(&cache, version(&owner));
        assert!(validate_in_write_transaction(&owner, &cache, "s")
            .unwrap_err()
            .contains("requires a write transaction"));
        owner.execute_batch("BEGIN").unwrap();
        assert!(validate_in_write_transaction(&owner, &cache, "s")
            .unwrap_err()
            .contains("requires a write transaction"));
        owner.execute_batch("ROLLBACK; BEGIN IMMEDIATE").unwrap();
        assert_eq!(
            validate_in_write_transaction(&owner, &cache, "s")
                .unwrap()
                .session_id,
            "s"
        );
        assert!(other
            .execute(
                "INSERT INTO orchestration_extras(key,data_json) VALUES('blocked','{}')",
                []
            )
            .is_err());
        owner.execute_batch("ROLLBACK").unwrap();
        assert!(cache.get("s", version(&owner)).unwrap().is_some());
        drop(store);
    }

    #[test]
    fn external_commit_or_local_revision_change_rejects_without_writing() {
        let fixture = Fixture::new();
        let file = fixture.file();
        let store =
            Store::open(file.to_str().unwrap(), None, 0, RetentionPolicy::default()).unwrap();
        let owner = Connection::open(&file).unwrap();
        let other = Connection::open(&file).unwrap();
        let cache = Cache::new(2, 8, 2048);
        let first = version(&owner);
        put(&cache, first);
        other
            .execute(
                "INSERT INTO orchestration_extras(key,data_json) VALUES('external','{}')",
                [],
            )
            .unwrap();
        owner.execute_batch("BEGIN IMMEDIATE").unwrap();
        assert!(validate_in_write_transaction(&owner, &cache, "s")
            .unwrap_err()
            .contains("stale"));
        owner.execute_batch("ROLLBACK").unwrap();
        assert!(cache.get("s", first).unwrap().is_none());
        let second = version(&owner);
        put(&cache, second);
        owner
            .execute(
                "UPDATE orchestration_meta SET value_json='1' WHERE key='revision'",
                [],
            )
            .unwrap();
        owner.execute_batch("BEGIN IMMEDIATE").unwrap();
        assert!(validate_in_write_transaction(&owner, &cache, "s")
            .unwrap_err()
            .contains("stale"));
        owner.execute_batch("ROLLBACK").unwrap();
        let count: i64 = owner
            .query_row(
                "SELECT count(*) FROM orchestration_extras WHERE key='blocked'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
        drop(store);
    }

    #[test]
    fn shared_monitor_detects_writes_across_owner_connections() {
        let fixture = Fixture::new();
        let file = fixture.file();
        let store =
            Store::open(file.to_str().unwrap(), None, 0, RetentionPolicy::default()).unwrap();
        let monitor = Connection::open(&file).unwrap();
        let first = Connection::open(&file).unwrap();
        let second = Connection::open(&file).unwrap();
        let cache = Cache::new(2, 8, 2048);
        put(&cache, version(&monitor));
        first
            .execute(
                "INSERT INTO orchestration_extras(key,data_json) VALUES('first','{}')",
                [],
            )
            .unwrap();
        second.execute_batch("BEGIN IMMEDIATE").unwrap();
        assert!(validate_with_monitor(&second, &monitor, &cache, "s")
            .unwrap_err()
            .contains("stale"));
        second.execute_batch("ROLLBACK").unwrap();
        put(&cache, version(&monitor));
        second.execute_batch("BEGIN IMMEDIATE").unwrap();
        assert_eq!(
            validate_with_monitor(&second, &monitor, &cache, "s")
                .unwrap()
                .session_id,
            "s"
        );
        #[cfg(unix)]
        assert_eq!(
            validate_pinned_with_monitor(
                &second,
                &monitor,
                &File::open(&file).unwrap(),
                &file,
                &cache,
                "s"
            )
            .unwrap()
            .session_id,
            "s"
        );
        assert!(validate_with_monitor(&second, &second, &cache, "s").is_err());
        second.execute_batch("ROLLBACK").unwrap();
        monitor.execute_batch("BEGIN").unwrap();
        second.execute_batch("BEGIN IMMEDIATE").unwrap();
        assert!(validate_with_monitor(&second, &monitor, &cache, "s").is_err());
        second.execute_batch("ROLLBACK").unwrap();
        monitor.execute_batch("ROLLBACK").unwrap();
        drop(store);
    }

    #[cfg(unix)]
    #[test]
    fn commit_guard_rejects_monitor_opened_during_an_aba_replacement() {
        let fixture = Fixture::new();
        let file = fixture.file();
        let other = fixture.0.join("replacement.sqlite");
        let parked = fixture.0.join("parked.sqlite");
        let store =
            Store::open(file.to_str().unwrap(), None, 0, RetentionPolicy::default()).unwrap();
        Connection::open(&other)
            .unwrap()
            .execute_batch("CREATE TABLE foreign_db(v)")
            .unwrap();
        let anchor = File::open(&file).unwrap();
        let writer = Connection::open(&file).unwrap();
        let cache = Cache::new(2, 8, 2048);
        let original = version(&writer);
        put(&cache, original);
        std::fs::rename(&file, &parked).unwrap();
        std::fs::rename(&other, &file).unwrap();
        let foreign =
            Connection::open_with_flags(&file, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        std::fs::rename(&file, &other).unwrap();
        std::fs::rename(&parked, &file).unwrap();
        writer.execute_batch("BEGIN IMMEDIATE").unwrap();
        let error = validate_pinned_with_monitor(&writer, &foreign, &anchor, &file, &cache, "s")
            .unwrap_err();
        assert!(error.contains("identity changed"), "{error}");
        writer.execute_batch("ROLLBACK").unwrap();
        assert!(cache.get("s", original).unwrap().is_none());
        drop(foreign);
        drop(writer);
        drop(anchor);
        drop(store);
    }

    #[test]
    fn owner_sessions_share_invalidation_even_when_a_write_rolls_back() {
        let fixture = Fixture::new();
        let file = fixture.file();
        let mut first =
            Store::open(file.to_str().unwrap(), None, 0, RetentionPolicy::default()).unwrap();
        let mut second =
            Store::open(file.to_str().unwrap(), None, 0, RetentionPolicy::default()).unwrap();
        let cache = Arc::new(Cache::new(2, 8, 2048));
        first.attach_scheduler_cache(Arc::clone(&cache));
        second.attach_scheduler_cache(Arc::clone(&cache));
        let initial = version(first.conn().unwrap());
        put(&cache, initial);
        second.request("info", &serde_json::json!({})).unwrap();
        assert!(
            cache.get("s", initial).unwrap().is_some(),
            "read-only request must not discard the cache"
        );
        let header = first.request("begin", &serde_json::json!({})).unwrap();
        let pending = cache.begin("other", initial).unwrap();
        let bad = serde_json::json!({"expectedRevision":header["revision"], "state":header, "changes":"not-an-array"});
        assert!(first.request("prepare", &bad).is_err());
        assert!(cache.get("s", initial).unwrap().is_none());
        assert_eq!(
            cache.publish(
                &pending,
                initial,
                Snapshot {
                    session_id: "other".into(),
                    active_delivery_id: None,
                    priority_entry_id: None,
                    entries: vec![]
                }
            ),
            Err(crate::scheduler_read_model::CacheError::Stale)
        );
        assert_eq!(
            version(first.conn().unwrap()).revision,
            initial.revision,
            "failed prepare must roll back"
        );
        put(&cache, version(first.conn().unwrap()));
        assert!(second
            .request("anUnknownFutureWrite", &serde_json::json!({}))
            .is_err());
        assert!(
            cache.get("s", initial).unwrap().is_none(),
            "unclassified future operations fail closed"
        );
    }

    #[test]
    fn prepared_and_committed_writes_invalidate_builds_across_sessions() {
        let fixture = Fixture::new();
        let file = fixture.file();
        let mut first =
            Store::open(file.to_str().unwrap(), None, 0, RetentionPolicy::default()).unwrap();
        let mut second =
            Store::open(file.to_str().unwrap(), None, 0, RetentionPolicy::default()).unwrap();
        let cache = Arc::new(Cache::new(2, 8, 2048));
        first.attach_scheduler_cache(Arc::clone(&cache));
        second.attach_scheduler_cache(Arc::clone(&cache));
        let original = version(first.conn().unwrap());
        let late = cache.begin("s", original).unwrap();
        let header = first.request("begin", &serde_json::json!({})).unwrap();
        let mut next = header.clone();
        next["revision"] = serde_json::json!(original.revision + 1);
        first.request("prepare", &serde_json::json!({"expectedRevision":original.revision,"state":next,"changes":[]})).unwrap();
        assert_eq!(
            cache.publish(
                &late,
                original,
                Snapshot {
                    session_id: "s".into(),
                    active_delivery_id: None,
                    priority_entry_id: None,
                    entries: vec![]
                }
            ),
            Err(crate::scheduler_read_model::CacheError::Stale)
        );
        // Even an incorrectly published build between prepare and commit must
        // be retired before the transaction becomes visible to another owner.
        put(&cache, original);
        first.request("commit", &serde_json::json!({})).unwrap();
        assert!(cache.get("s", original).unwrap().is_none());
        let observed = second.request("info", &serde_json::json!({})).unwrap();
        assert_eq!(observed["state"]["revision"], original.revision + 1);
    }
}
