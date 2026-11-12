use multicc_core::task_store::TaskStore;
use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(0);

struct ChildGuard(std::process::Child);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
        }
        let _ = self.0.wait();
    }
}

struct Fixture {
    path: PathBuf,
    store: TaskStore,
}
impl Fixture {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "multicc-fence-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("store.sqlite");
        let mut store = TaskStore::open(path.to_str().unwrap()).unwrap();
        let lease = json!({"id":"lease","workspaceId":"w","sessionId":"s","epoch":"e","generation":1,"state":"running","operationId":"op"});
        for (kind, id, value) in [
            ("workspace:lease", "w", lease.clone()),
            ("workspace:operation", "op", lease),
            ("delivery:latest", "s", json!({"runId":"turn"})),
            (
                "delivery:run",
                "turn",
                json!({"id":"turn","attemptId":"a","state":"running", "binding":{
                "sessionId":"s","turnId":"turn","taskId":"task","workspaceId":"w","baseRef":"main"}}),
            ),
        ] {
            call(
                &mut store,
                json!({"op":"set","kind":kind,"id":id,"body":value.to_string()}),
            )
            .unwrap();
        }
        Self { path, store }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(self.path.parent().unwrap());
    }
}
fn call(store: &mut TaskStore, input: Value) -> Result<Value, String> {
    store
        .run(&input.to_string())
        .and_then(|out| serde_json::from_str(&out).map_err(|e| e.to_string()))
}
fn identity(op: &str) -> Value {
    json!({"op":op,"sessionId":"s","workspaceId":"w","leaseId":"lease","epoch":"e","generation":1})
}
fn finalize(version: Value) -> Value {
    let mut input = identity("finalizeStoppedDelivery");
    input["turnId"] = json!("turn");
    input["writerFenceVersion"] = version;
    input["result"] = json!({"attemptId":"a","outcome":"cancelled","pendingInput":false,"resultDurable":false,"usageDurable":false});
    input["code"] = json!({"revision":"r","repoId":"repo","head":"h","dirty":false});
    input["error"] = Value::Null;
    input["now"] = json!(1);
    input
}
fn read(store: &mut TaskStore, kind: &str, id: &str) -> Value {
    call(store, json!({"op":"get","kind":kind,"id":id})).unwrap()
}
fn reactivated(kind: &str) {
    let mut f = Fixture::new();
    let snapshot = call(&mut f.store, identity("writerFenceSnapshot")).unwrap();
    // A different connection records activity while the caller is scanning.
    let mut writer = TaskStore::open(f.path.to_str().unwrap()).unwrap();
    let mut activity = identity("writerFenceActivity");
    activity["writerKind"] = json!(kind);
    call(&mut writer, activity).unwrap();
    assert!(call(&mut f.store, finalize(snapshot.clone()))
        .unwrap_err()
        .contains("writer_reactivated"));
    let mut release = identity("writerFenceRelease");
    release["writerFenceVersion"] = snapshot;
    assert!(call(&mut f.store, release)
        .unwrap_err()
        .contains("writer_reactivated"));
    assert_eq!(
        read(&mut f.store, "workspace:lease", "w")["state"],
        "running"
    );
    assert_eq!(
        read(&mut f.store, "task-first:run-result", "turn"),
        Value::Null
    );
    assert_eq!(
        read(&mut f.store, "delivery:run", "turn")["state"],
        "running"
    );
}
#[test]
fn session_reactivation_aborts() {
    reactivated("session");
}
#[test]
fn background_reactivation_aborts() {
    reactivated("background");
}
#[test]
fn stream_reactivation_aborts() {
    reactivated("stream");
}

#[test]
fn failed_fence_write_aborts_result_and_lease_release_until_retried() {
    let mut f = Fixture::new();
    let snapshot = call(&mut f.store, identity("writerFenceSnapshot")).unwrap();
    let db = rusqlite::Connection::open(&f.path).unwrap();
    db.execute_batch("CREATE TRIGGER reject_fence BEFORE UPDATE ON shell_records WHEN NEW.kind = 'workspace:writer-fence' BEGIN SELECT RAISE(ABORT, 'injected_fence_failure'); END;").unwrap();
    let mut activity = identity("writerFenceActivity");
    activity["writerKind"] = json!("background");
    assert!(call(&mut f.store, activity.clone())
        .unwrap_err()
        .contains("injected_fence_failure"));
    assert!(call(&mut f.store, finalize(snapshot.clone()))
        .unwrap_err()
        .contains("writer_fence_write_failed"));
    let mut release = identity("writerFenceRelease");
    release["writerFenceVersion"] = snapshot;
    assert!(call(&mut f.store, release)
        .unwrap_err()
        .contains("writer_fence_write_failed"));
    assert_eq!(
        read(&mut f.store, "workspace:lease", "w")["state"],
        "running"
    );
    assert_eq!(
        read(&mut f.store, "task-first:run-result", "turn"),
        Value::Null
    );
    db.execute_batch("DROP TRIGGER reject_fence").unwrap();
    call(&mut f.store, activity).unwrap();
    assert!(call(&mut f.store, identity("writerFenceSnapshot")).is_ok());
}

#[test]
fn exhausted_json_safe_fence_cannot_wrap_or_release() {
    let mut f = Fixture::new();
    let fence = json!({"leaseId":"lease","epoch":"e","generation":1,"sessionId":"s","version":9_007_199_254_740_991_u64});
    call(
        &mut f.store,
        json!({"op":"set","kind":"workspace:writer-fence","id":"w","body":fence.to_string()}),
    )
    .unwrap();
    let mut activity = identity("writerFenceActivity");
    activity["writerKind"] = json!("stream");
    assert!(call(&mut f.store, activity)
        .unwrap_err()
        .contains("writer_fence_overflow"));
    let mut release = identity("writerFenceRelease");
    release["writerFenceVersion"] = fence["version"].clone();
    assert!(call(&mut f.store, release)
        .unwrap_err()
        .contains("writer_fence_write_failed"));
    assert_eq!(
        read(&mut f.store, "workspace:lease", "w")["state"],
        "running"
    );
}

#[test]
fn fence_release_updates_lease_and_operation_in_one_transaction() {
    let mut f = Fixture::new();
    let snapshot = call(&mut f.store, identity("writerFenceSnapshot")).unwrap();
    let db = rusqlite::Connection::open(&f.path).unwrap();
    db.execute_batch("CREATE TRIGGER reject_operation BEFORE UPDATE ON shell_records WHEN NEW.kind = 'workspace:operation' BEGIN SELECT RAISE(ABORT, 'injected_operation_failure'); END;").unwrap();
    let mut release = identity("writerFenceRelease");
    release["writerFenceVersion"] = snapshot;
    release["reason"] = json!("stopped");
    release["now"] = json!(2);
    assert!(call(&mut f.store, release.clone())
        .unwrap_err()
        .contains("injected_operation_failure"));
    assert_eq!(
        read(&mut f.store, "workspace:lease", "w")["state"],
        "running"
    );
    db.execute_batch("DROP TRIGGER reject_operation").unwrap();
    call(&mut f.store, release).unwrap();
    assert_eq!(
        read(&mut f.store, "workspace:lease", "w")["state"],
        "released"
    );
    assert_eq!(
        read(&mut f.store, "workspace:operation", "op")["state"],
        "released"
    );
}

#[test]
fn failure_at_release_rolls_back_result_and_barrier_with_outer_transaction() {
    let mut f = Fixture::new();
    let snapshot = call(&mut f.store, identity("writerFenceSnapshot")).unwrap();
    let db = rusqlite::Connection::open(&f.path).unwrap();
    db.execute_batch("CREATE TRIGGER reject_operation BEFORE UPDATE ON shell_records WHEN NEW.kind = 'workspace:operation' BEGIN SELECT RAISE(ABORT, 'injected_operation_failure'); END;").unwrap();
    let frame = call(&mut f.store, json!({"op":"begin"})).unwrap();
    call(&mut f.store, finalize(snapshot.clone())).unwrap();
    let mut release = identity("writerFenceRelease");
    release["writerFenceVersion"] = snapshot;
    release["reason"] = json!("stopped");
    release["now"] = json!(2);
    assert!(call(&mut f.store, release)
        .unwrap_err()
        .contains("injected_operation_failure"));
    call(&mut f.store, json!({"op":"rollback", "frame":frame})).unwrap();
    assert_eq!(
        read(&mut f.store, "workspace:lease", "w")["state"],
        "running"
    );
    assert_eq!(
        read(&mut f.store, "task-first:run-result", "turn"),
        Value::Null
    );
    assert_eq!(
        read(&mut f.store, "delivery:run", "turn")["state"],
        "running"
    );
    let barriers = call(
        &mut f.store,
        json!({"op":"list", "kind":"task-first:writer-barrier"}),
    )
    .unwrap();
    assert_eq!(barriers, json!([]));
}

fn writer_input(op: &str, writer: &str) -> Value {
    let mut value = identity(op);
    value["writerId"] = json!(writer);
    value["writerKind"] = json!("background");
    value
}

#[test]
fn helper_external_writer() {
    let Ok(db) = std::env::var("MULTICC_FENCE_TEST_DB") else {
        return;
    };
    let dir = PathBuf::from(std::env::var("MULTICC_FENCE_TEST_DIR").unwrap());
    let mut store = TaskStore::open(&db).unwrap();
    call(
        &mut store,
        writer_input("writerLeaseAcquire", "external-writer"),
    )
    .unwrap();
    // This write deliberately precedes any event sent to the host.
    fs::write(dir.join("external-write"), b"written").unwrap();
    for _ in 0..1000 {
        if dir.join("stop").exists() {
            call(
                &mut store,
                writer_input("writerLeaseRelease", "external-writer"),
            )
            .unwrap();
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    panic!("test stop signal was not received");
}

#[test]
fn external_writer_is_registered_before_writing_without_a_host_event() {
    let mut f = Fixture::new();
    let snapshot = call(&mut f.store, identity("writerFenceSnapshot")).unwrap();
    let dir = f.path.parent().unwrap().to_owned();
    let mut child = ChildGuard(
        std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "helper_external_writer", "--nocapture"])
            .env("MULTICC_FENCE_TEST_DB", &f.path)
            .env("MULTICC_FENCE_TEST_DIR", &dir)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap(),
    );
    let mut found = false;
    for _ in 0..500 {
        if dir.join("external-write").exists() {
            found = true;
            break;
        }
        if child.0.try_wait().unwrap().is_some() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    if !found {
        panic!("external writer did not start");
    }
    assert!(call(&mut f.store, finalize(snapshot.clone()))
        .unwrap_err()
        .contains("workspace_writer_active"));
    let mut release = identity("writerFenceRelease");
    release["writerFenceVersion"] = snapshot.clone();
    assert!(call(&mut f.store, release)
        .unwrap_err()
        .contains("workspace_writer_active"));
    assert_eq!(
        read(&mut f.store, "workspace:lease", "w")["state"],
        "running"
    );
    assert_eq!(
        read(&mut f.store, "task-first:run-result", "turn"),
        Value::Null
    );
    fs::write(dir.join("stop"), b"stop").unwrap();
    assert!(child.0.wait().unwrap().success());
    assert!(call(&mut f.store, finalize(snapshot))
        .unwrap_err()
        .contains("writer_reactivated"));
}

#[test]
fn writer_acquisition_and_workspace_release_have_one_winner() {
    let mut f = Fixture::new();
    let snapshot = call(&mut f.store, identity("writerFenceSnapshot")).unwrap();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let db = f.path.clone();
    let other = barrier.clone();
    let spawn = std::thread::spawn(move || {
        let mut store = TaskStore::open(db.to_str().unwrap()).unwrap();
        other.wait();
        call(
            &mut store,
            writer_input("writerLeaseAcquire", "racing-writer"),
        )
    });
    let mut release = identity("writerFenceRelease");
    release["writerFenceVersion"] = snapshot;
    release["reason"] = json!("stopped");
    release["now"] = json!(1);
    barrier.wait();
    let released = call(&mut f.store, release);
    let acquired = spawn.join().unwrap();
    assert_ne!(
        released.is_ok(),
        acquired.is_ok(),
        "release={released:?}, acquire={acquired:?}"
    );
    if acquired.is_ok() {
        assert_eq!(
            read(&mut f.store, "workspace:lease", "w")["state"],
            "running"
        );
    } else {
        assert_eq!(
            read(&mut f.store, "workspace:lease", "w")["state"],
            "released"
        );
    }
}

#[test]
fn a_writer_id_cannot_be_reused_after_release() {
    let mut f = Fixture::new();
    let acquired = writer_input("writerLeaseAcquire", "writer");
    call(&mut f.store, acquired.clone()).unwrap();
    call(&mut f.store, writer_input("writerLeaseRelease", "writer")).unwrap();
    assert!(call(&mut f.store, acquired)
        .unwrap_err()
        .contains("writer_lease_id_reused"));
    assert_eq!(
        read(&mut f.store, "workspace:lease", "w")["state"],
        "running"
    );
}

#[test]
fn acquisition_after_workspace_release_fails_before_writer_can_start() {
    let mut f = Fixture::new();
    let version = call(&mut f.store, identity("writerFenceSnapshot")).unwrap();
    let mut release = identity("writerFenceRelease");
    release["writerFenceVersion"] = version;
    release["reason"] = json!("stopped");
    release["now"] = json!(1);
    call(&mut f.store, release).unwrap();
    assert!(
        call(&mut f.store, writer_input("writerLeaseAcquire", "too-late"))
            .unwrap_err()
            .contains("workspace_lease_stale")
    );
    assert_eq!(
        read(&mut f.store, "workspace:writer-leases", "w"),
        Value::Null
    );
}

#[test]
fn failed_writer_lease_insert_rolls_back_its_version_bump() {
    let mut f = Fixture::new();
    let snapshot = call(&mut f.store, identity("writerFenceSnapshot")).unwrap();
    let db = rusqlite::Connection::open(&f.path).unwrap();
    db.execute_batch("CREATE TRIGGER reject_writer BEFORE INSERT ON shell_records WHEN NEW.kind = 'workspace:writer-leases' BEGIN SELECT RAISE(ABORT, 'injected_writer_failure'); END;").unwrap();
    assert!(
        call(&mut f.store, writer_input("writerLeaseAcquire", "writer"))
            .unwrap_err()
            .contains("injected_writer_failure")
    );
    let mut other = TaskStore::open(f.path.to_str().unwrap()).unwrap();
    assert_eq!(
        call(&mut other, identity("writerFenceSnapshot")).unwrap(),
        snapshot
    );
    assert_eq!(
        read(&mut other, "workspace:writer-leases", "w"),
        Value::Null
    );
    assert_eq!(read(&mut other, "workspace:lease", "w")["state"], "running");
    let mut release = identity("writerFenceRelease");
    release["writerFenceVersion"] = snapshot;
    assert!(call(&mut f.store, release)
        .unwrap_err()
        .contains("writer_fence_write_failed"));
}

#[test]
fn a_writer_can_report_exit_after_host_epoch_changes_but_cannot_release_a_new_lease() {
    let mut f = Fixture::new();
    call(&mut f.store, writer_input("writerLeaseAcquire", "survivor")).unwrap();
    let mut lease = read(&mut f.store, "workspace:lease", "w");
    lease["epoch"] = json!("recovered-epoch");
    lease["state"] = json!("uncertain");
    call(
        &mut f.store,
        json!({"op":"set","kind":"workspace:lease","id":"w","body":lease.to_string()}),
    )
    .unwrap();
    let mut recovered = identity("writerFenceSnapshot");
    recovered["epoch"] = json!("recovered-epoch");
    assert!(call(&mut f.store, recovered.clone())
        .unwrap_err()
        .contains("workspace_writer_active"));
    call(&mut f.store, writer_input("writerLeaseRelease", "survivor")).unwrap();
    assert!(call(&mut f.store, recovered).is_ok());
    lease["id"] = json!("different-lease");
    lease["state"] = json!("running");
    call(
        &mut f.store,
        json!({"op":"set","kind":"workspace:lease","id":"w","body":lease.to_string()}),
    )
    .unwrap();
    assert!(
        call(&mut f.store, writer_input("writerLeaseRelease", "survivor"))
            .unwrap_err()
            .contains("writer_lease_stale")
    );
}
