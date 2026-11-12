use multicc_core::task_store::TaskStore;
use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    path: PathBuf,
    store: TaskStore,
}
impl Fixture {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "multicc-wlease-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("store.sqlite");
        let mut store = TaskStore::open(path.to_str().unwrap()).unwrap();
        let lease = json!({"id":"lease","workspaceId":"w","sessionId":"s","epoch":"e","generation":1,"state":"running","operationId":"op"});
        call(
            &mut store,
            json!({"op":"set","kind":"workspace:lease","id":"w","body":lease.to_string()}),
        )
        .unwrap();
        Self { path, store }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(self.path.parent().unwrap());
    }
}

fn call(store: &mut TaskStore, input: Value) -> Result<Value, String> {
    let out = store.run(&input.to_string())?;
    serde_json::from_str(&out).map_err(|e| e.to_string())
}

fn identity(op: &str, writer: &str, kind: &str) -> Value {
    json!({"op":op,"workspaceId":"w","writerId":writer,"writerKind":kind,
        "leaseId":"lease","epoch":"e","generation":1,"sessionId":"s"})
}

fn acquire(store: &mut TaskStore, writer: &str, kind: &str) -> Result<Value, String> {
    let mut input = identity("writerLeaseAcquire", writer, kind);
    input["pid"] = Value::Null;
    call(store, input)
}

fn read(store: &mut TaskStore, kind: &str, id: &str) -> Value {
    call(store, json!({"op":"get","kind":kind,"id":id})).unwrap()
}

/// The drain notification is the fence snapshot; an external writer (a second
/// SQLite connection, as any out-of-process CLI would be) that registers
/// before it must make the snapshot fail — the write-before-registration
/// window stays closed even when the host never saw the writer spawn.
#[test]
fn external_writer_starting_before_notification_aborts_snapshot() {
    let mut f = Fixture::new();
    let mut external = TaskStore::open(f.path.to_str().unwrap()).unwrap();
    acquire(&mut external, "ext-1", "background").unwrap();
    assert_eq!(
        call(
            &mut f.store,
            identity("writerFenceSnapshot", "w1", "session")
        )
        .unwrap_err(),
        "workspace_writer_active"
    );
    // Once the external writer reports its exit the snapshot succeeds again.
    call(
        &mut external,
        identity("writerLeaseRelease", "ext-1", "background"),
    )
    .unwrap();
    assert!(call(
        &mut f.store,
        identity("writerFenceSnapshot", "w1", "session")
    )
    .is_ok());
}

/// A fence release carrying the pre-acquisition version must lose the race no
/// matter how the acquisition ends: a still-active writer aborts on the
/// registry check, and a writer that already exited has still bumped the
/// fence version, so the release aborts as reactivated.
#[test]
fn release_racing_writer_acquisition_aborts() {
    let mut f = Fixture::new();
    let version = call(
        &mut f.store,
        identity("writerFenceSnapshot", "w1", "session"),
    )
    .unwrap();
    let mut release = identity("writerFenceRelease", "w1", "session");
    release["writerFenceVersion"] = version;
    release["reason"] = json!("stopped");

    let mut racer = TaskStore::open(f.path.to_str().unwrap()).unwrap();
    acquire(&mut racer, "ext-1", "stream").unwrap();
    assert_eq!(
        call(&mut f.store, release.clone()).unwrap_err(),
        "workspace_writer_active"
    );
    call(
        &mut racer,
        identity("writerLeaseRelease", "ext-1", "stream"),
    )
    .unwrap();
    assert_eq!(
        call(&mut f.store, release).unwrap_err(),
        "writer_reactivated"
    );
    assert_eq!(
        read(&mut f.store, "workspace:lease", "w")["state"],
        "running"
    );
}

/// The pid is unknowable at acquire time (the lease precedes the launch), so
/// it is annotated exactly once afterwards; a stale annotation must never
/// repoint the lease at an unrelated process.
#[test]
fn annotate_pid_writes_once_and_never_repoints() {
    let mut f = Fixture::new();
    acquire(&mut f.store, "w-1", "session").unwrap();
    let mut annotate = identity("writerLeaseAnnotatePid", "w-1", "session");
    annotate["pid"] = json!(4242);
    call(&mut f.store, annotate.clone()).unwrap();
    // Same pid again is an idempotent retry, not a repoint.
    call(&mut f.store, annotate).unwrap();
    let mut repoint = identity("writerLeaseAnnotatePid", "w-1", "session");
    repoint["pid"] = json!(9999);
    assert_eq!(
        call(&mut f.store, repoint).unwrap_err(),
        "writer_lease_stale"
    );
    let listed = call(
        &mut f.store,
        json!({"op":"writerLeaseList","workspaceId":"w"}),
    )
    .unwrap();
    assert_eq!(listed["writers"]["w-1"]["pid"], json!(4242));
    assert_eq!(listed["writers"]["w-1"]["kind"], json!("session"));
}

/// A lost annotate race against the writer's own release is the normal
/// outcome for a fast-exiting child: the annotation is stale, and — unlike a
/// genuine write failure — it must not pin the workspace, so the next
/// snapshot succeeds.
#[test]
fn annotate_after_release_is_stale_but_not_poisoning() {
    let mut f = Fixture::new();
    acquire(&mut f.store, "w-1", "background").unwrap();
    call(
        &mut f.store,
        identity("writerLeaseRelease", "w-1", "background"),
    )
    .unwrap();
    let mut annotate = identity("writerLeaseAnnotatePid", "w-1", "background");
    annotate["pid"] = json!(4242);
    assert_eq!(
        call(&mut f.store, annotate).unwrap_err(),
        "writer_lease_stale"
    );
    assert!(call(
        &mut f.store,
        identity("writerFenceSnapshot", "w2", "session")
    )
    .is_ok());
}

#[test]
fn list_reads_registry_and_release_is_idempotent() {
    let mut f = Fixture::new();
    acquire(&mut f.store, "w-1", "session").unwrap();
    acquire(&mut f.store, "w-2", "stream").unwrap();
    let listed = call(
        &mut f.store,
        json!({"op":"writerLeaseList","workspaceId":"w"}),
    )
    .unwrap();
    assert_eq!(listed["writers"]["w-1"]["state"], json!("active"));
    assert_eq!(listed["writers"]["w-2"]["kind"], json!("stream"));
    assert!(listed["writers"]["w-1"]["pid"].is_null());
    assert_eq!(
        call(
            &mut f.store,
            identity("writerLeaseAssertEmpty", "w3", "session")
        )
        .unwrap_err(),
        "workspace_writer_active"
    );
    call(
        &mut f.store,
        identity("writerLeaseRelease", "w-1", "session"),
    )
    .unwrap();
    call(
        &mut f.store,
        identity("writerLeaseRelease", "w-1", "session"),
    )
    .unwrap();
    let listed = call(
        &mut f.store,
        json!({"op":"writerLeaseList","workspaceId":"w"}),
    )
    .unwrap();
    assert_eq!(listed["writers"]["w-1"]["state"], json!("released"));
}

#[test]
fn identity_validation_is_fail_closed() {
    let mut f = Fixture::new();
    let mut bad_kind = identity("writerLeaseAcquire", "w-1", "rogue");
    bad_kind["pid"] = Value::Null;
    assert_eq!(
        call(&mut f.store, bad_kind).unwrap_err(),
        "writer_lease_identity_required"
    );
    assert_eq!(
        call(
            &mut f.store,
            identity("writerLeaseRelease", "never-acquired", "session")
        )
        .unwrap_err(),
        "writer_lease_stale"
    );
    assert_eq!(
        call(
            &mut f.store,
            json!({"op":"writerLeaseList","workspaceId":""})
        )
        .unwrap_err(),
        "workspace_release_identity_required"
    );
    let mut stale = identity("writerLeaseAcquire", "w-9", "session");
    stale["epoch"] = json!("other-epoch");
    stale["pid"] = Value::Null;
    assert_eq!(
        call(&mut f.store, stale).unwrap_err(),
        "workspace_lease_stale"
    );
}
