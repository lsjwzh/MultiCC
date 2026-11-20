//! End-to-end tests for `remote_child` against the fake `multicc-remote`
//! (`examples/remote_child_fixture.rs`): the ready line, every startup failure,
//! single-flight starts, the backoff ladder, forward notifications, stderr
//! forwarding and shutdown.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use multicc_gateway::remote_child::{Config, RemoteChild};

/// The fake `multicc-remote` (`examples/remote_child_fixture.rs`). It is an
/// example rather than a `[[bin]]` on purpose: `cargo build --release` builds
/// every bin of the package, and a test stand-in must never be compiled into
/// (or sit next to) the release artifacts.
///
/// `cargo test` builds examples, but `cargo test --test <name>` does not, so a
/// missing fixture is built here instead of failing: the tests must not depend
/// on which cargo invocation the caller happened to use.
fn fixture() -> std::path::PathBuf {
    use std::sync::OnceLock;
    static PATH: OnceLock<std::path::PathBuf> = OnceLock::new();
    PATH.get_or_init(|| {
        let exe = std::env::current_exe().expect("test executable path");
        let profile_dir = exe
            .parent()
            .and_then(|deps| deps.parent())
            .expect("target/<profile>/deps/<test>")
            .to_path_buf();
        let name = if cfg!(windows) {
            "remote_child_fixture.exe"
        } else {
            "remote_child_fixture"
        };
        let path = profile_dir.join("examples").join(name);
        if !path.exists() {
            let mut cargo = std::process::Command::new(
                std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into()),
            );
            cargo
                .args([
                    "build",
                    "-p",
                    "multicc-gateway",
                    "--example",
                    "remote_child_fixture",
                ])
                .current_dir(env!("CARGO_MANIFEST_DIR"));
            // Build into the profile the tests themselves run under.
            if profile_dir.file_name().is_some_and(|n| n == "release") {
                cargo.arg("--release");
            }
            if let Some(target) = std::env::var_os("CARGO_TARGET_DIR") {
                cargo.env("CARGO_TARGET_DIR", target);
            }
            let status = cargo.status().expect("run cargo to build the fixture");
            assert!(status.success(), "building remote_child_fixture failed");
        }
        assert!(path.exists(), "{} was not produced", path.display());
        path
    })
    .clone()
}

fn temp_dir(tag: &str) -> PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_micros())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!(
        "multicc-remote-child-{tag}-{}-{stamp}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("temp dir");
    dir
}

struct Harness {
    child: Arc<RemoteChild>,
    logs: Arc<Mutex<Vec<String>>>,
}

fn harness(tag: &str, env: &[(&str, &str)]) -> Harness {
    harness_with(tag, env, |_| {})
}

fn harness_with(tag: &str, env: &[(&str, &str)], tune: impl FnOnce(&mut Config)) -> Harness {
    let dir = temp_dir(tag);
    let logs: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let mut config = Config::new(dir.join("remote-screen"));
    config.binary = Some(fixture());
    config.ready_timeout = Duration::from_millis(400);
    config.restart_base = Duration::from_millis(20);
    config.restart_max = Duration::from_millis(200);
    config.stable_reset = Duration::from_millis(150);
    config.shutdown_grace = Duration::from_millis(500);
    config.env = env
        .iter()
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect();
    let sink = Arc::clone(&logs);
    config.log = Some(Arc::new(move |line| {
        sink.lock().expect("logs").push(line.to_string());
    }));
    tune(&mut config);
    Harness {
        child: Arc::new(RemoteChild::new(config)),
        logs,
    }
}

impl Harness {
    fn logs(&self) -> Vec<String> {
        self.logs.lock().expect("logs").clone()
    }
}

async fn wait_until(limit: Duration, mut check: impl FnMut() -> bool) -> bool {
    let start = Instant::now();
    while start.elapsed() < limit {
        if check() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    check()
}

#[tokio::test]
async fn happy_path_prints_one_ready_line() {
    let dir = temp_dir("ready");
    let stdin = dir.join("stdin.json");
    let h = harness_with(
        "ready",
        &[("FIXTURE_STDIN_FILE", stdin.to_str().expect("utf8"))],
        |_| {},
    );
    let ready = h.child.ensure().await.expect("ready");
    assert!(ready.port > 0);
    assert_eq!(ready.secret, "fixture-secret");
    let snapshot = h.child.snapshot();
    assert_eq!(snapshot.attempts, 1);
    assert_eq!(snapshot.ready.as_ref(), Some(&ready));
    assert!(snapshot.pid.is_some());
    assert!(snapshot.last_error.is_none());
    assert!(!snapshot.restart_pending);

    // The first stdin line is the protocol config with the configured DIR.
    assert!(wait_until(Duration::from_secs(2), || stdin.exists()).await);
    let line = std::fs::read_to_string(&stdin).expect("stdin line");
    let value: serde_json::Value = serde_json::from_str(line.trim()).expect("json line");
    assert_eq!(value["v"], 1);
    assert_eq!(
        value["dir"].as_str().expect("dir"),
        h.child.dir().to_string_lossy()
    );

    // A second ensure shares the running child.
    let again = h.child.ensure().await.expect("ready again");
    assert_eq!(again, ready);
    assert_eq!(h.child.snapshot().attempts, 1);

    h.child.shutdown().await;
}

#[tokio::test]
async fn missing_binary_is_binding_missing() {
    let dir = temp_dir("binding");
    let h = harness_with("binding", &[], |config| {
        config.binary = Some(dir.join("no-such-binary"));
    });
    let error = h.child.ensure().await.expect_err("binding-missing");
    assert_eq!(error.code, "binding-missing");
    let snapshot = h.child.snapshot();
    assert_eq!(snapshot.attempts, 0);
    assert_eq!(snapshot.last_error.as_deref(), Some("binding-missing"));
}

#[tokio::test]
async fn silent_child_times_out() {
    let h = harness_with("timeout", &[("FIXTURE_MODE", "silent")], |config| {
        config.ready_timeout = Duration::from_millis(200);
    });
    let start = Instant::now();
    let error = h.child.ensure().await.expect_err("timeout");
    assert_eq!(error.code, "ready-timeout");
    assert!(start.elapsed() < Duration::from_secs(3));
    let snapshot = h.child.snapshot();
    assert!(snapshot.pid.is_none());
    assert_eq!(snapshot.attempts, 1);
    assert_eq!(snapshot.last_error.as_deref(), Some("ready-timeout"));
}

#[tokio::test]
async fn bad_ready_lines_are_rejected() {
    let h = harness("bad-json", &[("FIXTURE_MODE", "bad-ready-line")]);
    assert_eq!(
        h.child.ensure().await.expect_err("bad line").code,
        "bad-ready-line"
    );
    let h = harness("bad-version", &[("FIXTURE_MODE", "bad-version")]);
    assert_eq!(
        h.child.ensure().await.expect_err("bad version").code,
        "bad-ready-line"
    );
}

#[tokio::test]
async fn an_endless_ready_line_is_rejected() {
    let h = harness("huge-line", &[("FIXTURE_MODE", "huge-line")]);
    assert_eq!(
        h.child.ensure().await.expect_err("huge line").code,
        "bad-ready-line"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn a_non_executable_binary_is_a_spawn_error() {
    use std::os::unix::fs::PermissionsExt;
    let dir = temp_dir("spawn-error");
    let file = dir.join("not-executable");
    std::fs::write(&file, b"#!/bin/sh\nexit 0\n").expect("write");
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).expect("chmod");
    let h = harness_with("spawn-error", &[], |config| {
        config.binary = Some(file);
    });
    assert_eq!(h.child.ensure().await.expect_err("spawn").code, "EACCES");
}

#[tokio::test]
async fn exit_before_ready_reports_the_code() {
    let h = harness(
        "exit-early",
        &[
            ("FIXTURE_MODE", "exit-before-ready"),
            ("FIXTURE_EXIT_CODE", "3"),
        ],
    );
    let error = h.child.ensure().await.expect_err("exit");
    assert_eq!(error.code, "exited-before-ready:3");
    let snapshot = h.child.snapshot();
    assert_eq!(
        snapshot.last_error.as_deref(),
        Some("exited-before-ready:3")
    );
    assert_eq!(snapshot.attempts, 1);
    // 20ms base: the stored delay for the *next* crash doubles once.
    assert_eq!(snapshot.backoff_ms, 40);
}

#[tokio::test]
async fn concurrent_ensures_share_one_start() {
    let h = harness("single-flight", &[("FIXTURE_READY_DELAY_MS", "200")]);
    let mut tasks = Vec::new();
    for _ in 0..8 {
        let child = Arc::clone(&h.child);
        tasks.push(tokio::spawn(async move { child.ensure().await }));
    }
    let mut ports = Vec::new();
    for task in tasks {
        ports.push(task.await.expect("task").expect("ready").port);
    }
    assert!(ports.iter().all(|port| *port == ports[0]));
    assert_eq!(h.child.snapshot().attempts, 1);
    h.child.shutdown().await;
}

#[tokio::test]
async fn backoff_doubles_and_needs_a_demand() {
    let h = harness("backoff", &[("FIXTURE_MODE", "exit-before-ready")]);
    assert_eq!(
        h.child.ensure().await.expect_err("first").code,
        "exited-before-ready:3"
    );
    assert_eq!(h.child.snapshot().backoff_ms, 40);

    // Nobody asks: the window expires without a new process.
    tokio::time::sleep(Duration::from_millis(150)).await;
    let snapshot = h.child.snapshot();
    assert_eq!(snapshot.attempts, 1);
    assert!(!snapshot.restart_pending);

    // A request inside the window fails at once and records the demand.
    // The window from the first failure has already expired, so this is a
    // fresh start that fails again with the doubled delay stored.
    let error = h.child.ensure().await.expect_err("second");
    assert_eq!(error.code, "exited-before-ready:3");
    assert!(
        wait_until(Duration::from_secs(2), || {
            h.child.snapshot().backoff_ms == 80
        })
        .await
    );
}

#[tokio::test]
async fn in_window_requests_fail_immediately_and_restart_once() {
    let h = harness_with(
        "retry-demand",
        &[("FIXTURE_MODE", "exit-before-ready")],
        |config| {
            config.restart_base = Duration::from_millis(150);
            config.restart_max = Duration::from_millis(400);
        },
    );
    assert_eq!(
        h.child.ensure().await.expect_err("first").code,
        "exited-before-ready:3"
    );
    // Inside the 150ms window.
    let error = h.child.ensure().await.expect_err("restarting");
    assert_eq!(error.code, "restarting");
    assert!(h.child.snapshot().restart_pending);
    // The window's timer starts exactly one more attempt.
    assert!(wait_until(Duration::from_secs(2), || h.child.snapshot().attempts == 2).await);
    // And that attempt's failure schedules the next window; nobody asked
    // again, so no third attempt appears once the window expires.
    assert!(
        wait_until(Duration::from_secs(2), || {
            h.child.snapshot().restart_pending
        })
        .await
    );
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(h.child.snapshot().attempts, 2);
}

#[tokio::test]
async fn backoff_caps_at_the_maximum() {
    let h = harness_with(
        "backoff-cap",
        &[("FIXTURE_MODE", "exit-before-ready")],
        |config| {
            config.restart_base = Duration::from_millis(150);
            config.restart_max = Duration::from_millis(200);
        },
    );
    assert!(h.child.ensure().await.is_err());
    // delay = min(150, 200) = 150; the stored delay is min(300, 200) = 200.
    assert_eq!(h.child.snapshot().backoff_ms, 200);
    let _ = h.child.ensure().await.expect_err("restarting");
    assert!(wait_until(Duration::from_secs(2), || h.child.snapshot().attempts == 2).await);
    assert!(
        wait_until(Duration::from_secs(2), || {
            h.child.snapshot().restart_pending
        })
        .await
    );
    // delay = 200 again, doubled to 400 and capped back to 200.
    assert_eq!(h.child.snapshot().backoff_ms, 200);
}

#[tokio::test]
async fn a_stable_run_clears_the_ladder() {
    let dir = temp_dir("stable");
    let marker = dir.join("failed-once");
    let h = harness_with(
        "stable",
        &[("FIXTURE_FAIL_FIRST", marker.to_str().expect("utf8"))],
        |_| {},
    );
    assert_eq!(
        h.child.ensure().await.expect_err("first").code,
        "exited-before-ready:3"
    );
    assert_eq!(h.child.snapshot().backoff_ms, 40);
    let ready = h.child.ensure().await;
    assert_eq!(ready.expect_err("restarting").code, "restarting");
    assert!(
        wait_until(Duration::from_secs(3), || {
            h.child.snapshot().ready.is_some()
        })
        .await
    );
    // Still inside the stability window.
    assert_eq!(h.child.snapshot().backoff_ms, 40);
    assert!(
        wait_until(Duration::from_secs(3), || h.child.snapshot().backoff_ms
            == 0)
        .await
    );
    h.child.shutdown().await;
}

#[tokio::test]
async fn a_crash_after_ready_notifies_forwards() {
    let h = harness(
        "crash",
        &[("FIXTURE_EXIT_AFTER_MS", "80"), ("FIXTURE_EXIT_CODE", "7")],
    );
    let mut exits = h.child.subscribe_exits();
    h.child.ensure().await.expect("ready");
    let notice = tokio::time::timeout(Duration::from_secs(3), exits.recv())
        .await
        .expect("exit notice")
        .expect("broadcast");
    assert_eq!(notice.code, Some(7));
    assert!(!notice.stopping);
    assert!(
        wait_until(Duration::from_secs(2), || {
            h.child.snapshot().restart_pending
        })
        .await
    );
    let snapshot = h.child.snapshot();
    assert!(snapshot.ready.is_none());
    assert_eq!(snapshot.last_error.as_deref(), Some("exited code=7"));
    assert_eq!(snapshot.backoff_ms, 40);
    // A run that dies before the stability window never clears the ladder.
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(h.child.snapshot().backoff_ms, 40);
}

#[tokio::test]
async fn stderr_is_forwarded_line_by_line_and_clipped() {
    let h = harness("stderr", &[("FIXTURE_STDERR", "1")]);
    h.child.ensure().await.expect("ready");
    let clipped = format!("remote_screen_stderr {}", "L".repeat(500));
    assert!(wait_until(Duration::from_secs(3), || { h.logs().contains(&clipped) }).await);
    let logs = h.logs();
    let stderr: Vec<&String> = logs
        .iter()
        .filter(|line| line.starts_with("remote_screen_stderr "))
        .collect();
    assert!(stderr.iter().any(|line| line.ends_with(" alpha")));
    assert!(stderr.iter().any(|line| line.ends_with(" beta")));
    assert!(stderr
        .iter()
        .all(|line| !line["remote_screen_stderr ".len()..].trim().is_empty()));
    assert!(stderr
        .iter()
        .all(|line| line.len() <= "remote_screen_stderr ".len() + 500));
    h.child.shutdown().await;
}

#[tokio::test]
async fn shutdown_closes_stdin_and_the_child_exits() {
    let dir = temp_dir("shutdown");
    let stdin = dir.join("stdin.json");
    let h = harness_with(
        "shutdown",
        &[("FIXTURE_STDIN_FILE", stdin.to_str().expect("utf8"))],
        |_| {},
    );
    h.child.ensure().await.expect("ready");
    let start = Instant::now();
    h.child.shutdown().await;
    assert!(start.elapsed() < Duration::from_secs(2));
    assert!(
        wait_until(Duration::from_secs(2), || {
            dir.join("stdin.json.eof").exists()
        })
        .await
    );
    assert!(h.child.snapshot().pid.is_none());
    let error = h.child.ensure().await.expect_err("stopping");
    assert_eq!(error.code, "stopping");
}
