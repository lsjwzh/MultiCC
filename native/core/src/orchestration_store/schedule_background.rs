//! Experimental background projection. This is not connected to production
//! scheduling and the returned snapshot is not an authorization to commit.
use super::{err, header, schedule_identity, schedule_metadata, Result};
use crate::scheduler_read_model::{OutboxState, QueueEntry, Snapshot};
use rusqlite::{Connection, OpenFlags};
use serde_json::json;
use std::fs::File;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc};
use std::time::Duration;

const MAX_WORKERS: usize = 4;
const MAX_ROWS: usize = 4096;
const PAGE_SIZE: usize = 16;
static WORKERS: AtomicUsize = AtomicUsize::new(0);

struct Permit;
impl Drop for Permit {
    fn drop(&mut self) {
        WORKERS.fetch_sub(1, Ordering::AcqRel);
    }
}

/// SQLite revision comes from the worker's single read transaction. Callers
/// must independently bind it to their own connection's data_version and
/// revalidate that version in the write transaction before using the result.
#[derive(Debug)]
pub struct BackgroundSnapshot {
    pub revision: u64,
    pub snapshot: Snapshot,
}

pub struct BackgroundScan {
    cancel: Arc<AtomicBool>,
    result: mpsc::Receiver<Result<BackgroundSnapshot>>,
}

impl Drop for BackgroundScan {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Release);
    }
}

impl BackgroundScan {
    /// Returns immediately. A disconnected worker is a failure, never a ready model.
    pub fn try_finish(&self) -> Option<Result<BackgroundSnapshot>> {
        match self.result.try_recv() {
            Ok(result) => Some(result),
            Err(mpsc::TryRecvError::Empty) => None,
            Err(mpsc::TryRecvError::Disconnected) => {
                Some(Err(err("scheduler background worker stopped")))
            }
        }
    }
}

/// The worker uses a separate, read-only SQLite connection and checks
/// cancellation between bounded pages; no user message crosses the boundary.
pub fn start(file: PathBuf, session: String) -> Result<BackgroundScan> {
    // Validate before allocating a worker or opening the database.
    schedule_metadata::Scan::new(
        "worker".into(),
        &json!({"sessionId":session,"prepareLargeRecords":true}),
    )?;
    // The independent anchor and SQLite's file-control check each provide an
    // identity observation; they do not atomically exclude adversarial renames.
    let anchor = File::open(&file).map_err(err)?;
    schedule_identity::anchor_matches(&anchor, &file)?;
    let mut workers = WORKERS.load(Ordering::Acquire);
    loop {
        if workers >= MAX_WORKERS {
            return Err(err("scheduler background worker capacity exceeded"));
        }
        match WORKERS.compare_exchange_weak(
            workers,
            workers + 1,
            Ordering::AcqRel,
            Ordering::Acquire,
        ) {
            Ok(_) => break,
            Err(current) => workers = current,
        }
    }
    let permit = Permit;
    let cancel = Arc::new(AtomicBool::new(false));
    let worker_cancel = Arc::clone(&cancel);
    let (tx, result) = mpsc::sync_channel(1);
    std::thread::Builder::new()
        .name("multicc-scheduler-read".into())
        .spawn(move || {
            let _permit = permit;
            let answer = project(file, session, &worker_cancel, anchor);
            let _ = tx.send(answer);
        })
        .map_err(err)?;
    Ok(BackgroundScan { cancel, result })
}

fn project(
    file: PathBuf,
    session: String,
    cancel: &AtomicBool,
    anchor: File,
) -> Result<BackgroundSnapshot> {
    project_with_hook(file, session, cancel, anchor, || {})
}

fn project_with_hook(
    file: PathBuf,
    session: String,
    cancel: &AtomicBool,
    anchor: File,
    after_snapshot: impl FnOnce(),
) -> Result<BackgroundSnapshot> {
    if cancel.load(Ordering::Acquire) {
        return Err(err("scheduler background scan cancelled"));
    }
    schedule_identity::anchor_matches(&anchor, &file)?;
    let db = Connection::open_with_flags(
        &file,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(err)?;
    schedule_identity::anchor_matches(&anchor, &file)?;
    schedule_identity::sqlite_matches_anchor(&db, &anchor)?;
    db.busy_timeout(Duration::from_secs(2)).map_err(err)?;
    db.execute_batch("BEGIN").map_err(err)?;
    let state = header(&db)?;
    let revision = state["revision"]
        .as_u64()
        .ok_or_else(|| err("invalid scheduler metadata revision"))?;
    after_snapshot();
    let mut scan = schedule_metadata::Scan::new(
        "worker".into(),
        &json!({"sessionId":session,"prepareLargeRecords":true}),
    )?;
    scan.bind_revision(&state)?;
    let schedule = schedule_metadata::schedule(&db, &session, true)?;
    let mut entries = Vec::new();
    loop {
        if cancel.load(Ordering::Acquire) {
            return Err(err("scheduler background scan cancelled"));
        }
        let page = scan.next(&db, &json!({"token":"worker","limit":PAGE_SIZE}))?;
        let state = match page["state"].as_str() {
            Some("pending") => OutboxState::Pending,
            Some("leased") => OutboxState::Leased,
            _ => return Err(err("invalid scheduler metadata state")),
        };
        let rows = page["rows"]
            .as_array()
            .ok_or_else(|| err("invalid scheduler metadata rows"))?;
        if entries
            .len()
            .checked_add(rows.len())
            .is_none_or(|count| count > MAX_ROWS)
        {
            return Err(err("scheduler background snapshot exceeds row limit"));
        }
        for row in rows {
            entries.push(QueueEntry {
                id: row["id"]
                    .as_str()
                    .ok_or_else(|| err("invalid scheduler metadata identifier"))?
                    .to_owned(),
                state,
                sequence: row["sequence"]
                    .as_u64()
                    .ok_or_else(|| err("invalid scheduler metadata sequence"))?,
                queue_order: row["queueOrder"].as_f64(),
            });
        }
        if page["scanComplete"] == true {
            break;
        }
    }
    schedule_identity::anchor_matches(&anchor, &file)?;
    schedule_identity::sqlite_matches_anchor(&db, &anchor)?;
    db.execute_batch("ROLLBACK").map_err(err)?;
    Ok(BackgroundSnapshot {
        revision,
        snapshot: Snapshot {
            session_id: session,
            active_delivery_id: schedule["activeDeliveryId"].as_str().map(str::to_owned),
            priority_entry_id: schedule["priorityEntryId"].as_str().map(str::to_owned),
            entries,
        },
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::orchestration_retention::RetentionPolicy;
    use crate::orchestration_store::Store;
    use crate::scheduler_read_model::{Cache, CacheError, Version};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Instant;

    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "multicc-scheduler-background-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn file(&self) -> PathBuf {
            self.0.join("state.sqlite")
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn wait(job: &BackgroundScan) -> Result<BackgroundSnapshot> {
        let start = Instant::now();
        loop {
            if let Some(result) = job.try_finish() {
                return result;
            }
            assert!(
                start.elapsed() < Duration::from_secs(10),
                "background scan timed out"
            );
            std::thread::sleep(Duration::from_millis(2));
        }
    }
    fn seed(db: &mut Connection, count: u64) {
        let tx = db.transaction().unwrap();
        for sequence in 1..=count {
            let id = format!("id-{sequence}");
            let raw = json!({"id":id,"sessionId":"s","state":"pending","sequence":sequence,"queueOrder":0,"message":"PRIVATE-BODY"}).to_string();
            tx.execute("INSERT INTO orchestration_outbox(id,data_json,session_id,state,sequence) VALUES(?1,?2,'s','pending',?3)", rusqlite::params![id,raw,sequence]).unwrap();
        }
        tx.commit().unwrap();
    }

    #[test]
    fn worker_projects_a_consistent_snapshot_and_external_write_blocks_publication() {
        let fixture = Fixture::new();
        let file = fixture.file();
        let store =
            Store::open(file.to_str().unwrap(), None, 0, RetentionPolicy::default()).unwrap();
        let owner = Connection::open(&file).unwrap();
        let mut writer = Connection::open(&file).unwrap();
        seed(&mut writer, 128);
        let data_version = || {
            owner
                .query_row("PRAGMA data_version", [], |r| r.get::<_, i64>(0))
                .unwrap()
        };
        let version = Version {
            revision: header(&owner).unwrap()["revision"].as_u64().unwrap(),
            data_version: data_version(),
        };
        let cache = Cache::new(2, 4096, 1024 * 1024);
        let ticket = cache.begin("s", version).unwrap();
        let job = start(file.clone(), "s".into()).unwrap();
        writer.execute("UPDATE orchestration_outbox SET data_json=json_set(data_json,'$.queueOrder',1) WHERE session_id='s'", []).unwrap();
        let result = wait(&job).unwrap();
        assert_eq!(result.snapshot.entries.len(), 128);
        let orders: std::collections::HashSet<i64> = result
            .snapshot
            .entries
            .iter()
            .map(|e| e.queue_order.unwrap() as i64)
            .collect();
        assert_eq!(
            orders.len(),
            1,
            "one read transaction cannot mix old and new rows"
        );
        assert!(!format!("{:?}", result.snapshot).contains("PRIVATE-BODY"));
        let after = Version {
            revision: result.revision,
            data_version: data_version(),
        };
        assert_ne!(after.data_version, version.data_version);
        assert_eq!(
            cache.publish(&ticket, after, result.snapshot),
            Err(CacheError::Stale)
        );
        assert!(cache.get("s", version).unwrap().is_none());
        drop(store);
    }

    #[test]
    fn invalid_or_oversized_rows_do_not_return_partial_models() {
        let fixture = Fixture::new();
        let file = fixture.file();
        let store =
            Store::open(file.to_str().unwrap(), None, 0, RetentionPolicy::default()).unwrap();
        let mut db = Connection::open(&file).unwrap();
        seed(&mut db, 1);
        db.execute(
            "UPDATE orchestration_outbox SET data_json='{}' WHERE id='id-1'",
            [],
        )
        .unwrap();
        let job = start(file.clone(), "s".into()).unwrap();
        assert!(wait(&job)
            .unwrap_err()
            .contains("indexed fields do not match"));
        let large = json!({"id":"id-1","sessionId":"s","state":"pending","sequence":1,
            "message":"x".repeat(16 * 1024 * 1024)})
        .to_string();
        db.execute(
            "UPDATE orchestration_outbox SET data_json=?1 WHERE id='id-1'",
            [&large],
        )
        .unwrap();
        let job = start(file.clone(), "s".into()).unwrap();
        assert!(wait(&job).unwrap_err().contains("record exceeds limit"));
        drop(store);
    }

    #[test]
    fn row_budget_rejects_without_returning_a_partial_snapshot() {
        let fixture = Fixture::new();
        let file = fixture.file();
        let store =
            Store::open(file.to_str().unwrap(), None, 0, RetentionPolicy::default()).unwrap();
        let mut db = Connection::open(&file).unwrap();
        seed(&mut db, (MAX_ROWS + 1) as u64);
        let job = start(file, "s".into()).unwrap();
        assert!(wait(&job).unwrap_err().contains("exceeds row limit"));
        drop(store);
    }

    #[test]
    fn path_replacement_during_snapshot_is_rejected() {
        let fixture = Fixture::new();
        let file = fixture.file();
        let store =
            Store::open(file.to_str().unwrap(), None, 0, RetentionPolicy::default()).unwrap();
        let anchor = File::open(&file).unwrap();
        let old = fixture.0.join("old.sqlite");
        let cancel = AtomicBool::new(false);
        let result = project_with_hook(file.clone(), "s".into(), &cancel, anchor, || {
            std::fs::rename(&file, &old).unwrap();
            std::fs::write(&file, b"foreign replacement").unwrap();
        });
        std::fs::remove_file(&file).unwrap();
        std::fs::rename(&old, &file).unwrap();
        assert!(result.unwrap_err().contains("database identity changed"));
        drop(store);
    }
}
