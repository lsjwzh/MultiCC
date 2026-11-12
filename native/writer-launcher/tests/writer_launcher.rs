use multicc_core::task_store::TaskStore;
use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    dir: PathBuf,
    store_path: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "multicc-wlaunch-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        let store_path = dir.join("store.sqlite");
        let mut store = TaskStore::open(store_path.to_str().unwrap()).unwrap();
        let lease = json!({"id":"lease","workspaceId":"w","sessionId":"s","epoch":"e","generation":1,"state":"running","operationId":"op"});
        store
            .run(
                &json!({"op":"set","kind":"workspace:lease","id":"w","body":lease.to_string()})
                    .to_string(),
            )
            .unwrap();
        Self { dir, store_path }
    }
    fn fence(&self) -> String {
        json!({"workspaceId":"w","leaseId":"lease","epoch":"e","generation":1,"sessionId":"s"})
            .to_string()
    }
    fn record(&self) -> Value {
        let mut store = TaskStore::open(self.store_path.to_str().unwrap()).unwrap();
        let out = store
            .run(&json!({"op":"writerLeaseList","workspaceId":"w"}).to_string())
            .unwrap();
        serde_json::from_str(&out).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn launcher() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_multicc-writer"));
    // The contract is fail-closed on the launcher's own env, never on whatever
    // the surrounding shell happens to export.
    for key in [
        "MULTICC_TASK_STORE",
        "MULTICC_WRITER_FENCE",
        "MULTICC_WRITER_KIND",
        "MULTICC_WRITER_ID",
    ] {
        command.env_remove(key);
    }
    command
}

/// Cross-platform "create an empty file": the negative tests must fail
/// before this ever runs, and the happy path asserts on the marker.
fn touch_command(marker: &std::path::Path) -> Vec<String> {
    if cfg!(windows) {
        vec![
            "cmd".into(),
            "/c".into(),
            "type".into(),
            "nul".into(),
            ">".into(),
            marker.to_string_lossy().into_owned(),
        ]
    } else {
        vec!["touch".into(), marker.to_string_lossy().into_owned()]
    }
}

/// Cross-platform "exit with status 42".
fn exit_42_command() -> Vec<String> {
    if cfg!(windows) {
        vec!["cmd".into(), "/c".into(), "exit".into(), "42".into()]
    } else {
        vec!["sh".into(), "-c".into(), "exit 42".into()]
    }
}

#[test]
fn refuses_to_spawn_without_fence_env() {
    let f = Fixture::new();
    let marker = f.dir.join("marker");
    let output = launcher()
        .env("MULTICC_TASK_STORE", &f.store_path)
        .arg("exec")
        .args(touch_command(&marker))
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(64));
    assert!(!marker.exists());
}

#[test]
fn refuses_a_stale_fence_identity() {
    let f = Fixture::new();
    let marker = f.dir.join("marker");
    let stale =
        json!({"workspaceId":"w","leaseId":"lease","epoch":"other","generation":1,"sessionId":"s"});
    let output = launcher()
        .env("MULTICC_TASK_STORE", &f.store_path)
        .env("MULTICC_WRITER_FENCE", stale.to_string())
        .env("MULTICC_WRITER_KIND", "background")
        .arg("exec")
        .args(touch_command(&marker))
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(75));
    assert!(!marker.exists());
    assert!(f.record().is_null());
}

#[test]
fn acquires_annotates_runs_and_releases() {
    let f = Fixture::new();
    let marker = f.dir.join("marker");
    let output = launcher()
        .env("MULTICC_TASK_STORE", &f.store_path)
        .env("MULTICC_WRITER_FENCE", f.fence())
        .env("MULTICC_WRITER_KIND", "session")
        .env("MULTICC_WRITER_ID", "ext-1")
        .arg("exec")
        .args(touch_command(&marker))
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(0));
    assert!(marker.exists());
    let writer = &f.record()["writers"]["ext-1"];
    assert_eq!(writer["state"], json!("released"));
    assert_eq!(writer["kind"], json!("session"));
    assert!(writer["pid"].as_u64().unwrap() > 0);
}

#[test]
fn passes_through_the_child_exit_status() {
    let f = Fixture::new();
    let output = launcher()
        .env("MULTICC_TASK_STORE", &f.store_path)
        .env("MULTICC_WRITER_FENCE", f.fence())
        .env("MULTICC_WRITER_KIND", "stream")
        .arg("exec")
        .args(exit_42_command())
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(42));
}

/// A CLI that exits while a background descendant keeps writing must hold the
/// lease until the descendant is gone: the launcher releases on process-group
/// emptiness, not on the direct child's exit.
#[cfg(unix)]
#[test]
fn group_lifetime_covers_detached_descendants() {
    let f = Fixture::new();
    let started = std::time::Instant::now();
    let output = launcher()
        .env("MULTICC_TASK_STORE", &f.store_path)
        .env("MULTICC_WRITER_FENCE", f.fence())
        .env("MULTICC_WRITER_KIND", "background")
        .env("MULTICC_WRITER_ID", "ext-group")
        .args(["exec", "--", "sh", "-c", "sleep 1 & exit 0"])
        .output()
        .unwrap();
    let elapsed = started.elapsed();
    assert_eq!(output.status.code(), Some(0));
    assert!(
        elapsed >= std::time::Duration::from_millis(900),
        "launcher left before the process group was empty: {elapsed:?}"
    );
    assert_eq!(
        f.record()["writers"]["ext-group"]["state"],
        json!("released")
    );
}

#[cfg(unix)]
#[test]
fn signal_death_maps_to_128_plus_signal() {
    let f = Fixture::new();
    let output = launcher()
        .env("MULTICC_TASK_STORE", &f.store_path)
        .env("MULTICC_WRITER_FENCE", f.fence())
        .env("MULTICC_WRITER_KIND", "session")
        .args(["exec", "--", "sh", "-c", "kill -TERM $$"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(143));
}
