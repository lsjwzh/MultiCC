//! Shared helpers for the integration tests that spawn the fake
//! `multicc-remote` (`examples/remote_child_fixture.rs`).
//!
//! Each test target pulls this in with `mod common;`. It lives in a
//! subdirectory on purpose: `tests/common/mod.rs` is not itself a test target.

use std::path::PathBuf;
use std::sync::OnceLock;

/// Path of the fake `multicc-remote`, freshly built.
///
/// It is an example rather than a `[[bin]]` on purpose: `cargo build --release`
/// builds every bin of the package, and a test stand-in must never be compiled
/// into (or sit next to) the release artifacts.
///
/// `cargo test` builds examples, but `cargo test --test <name>` does not. So
/// this always asks cargo to build it. Checking only that the file exists is
/// not enough: after the fixture source changes, a stale binary would keep
/// running and the new switches would silently do nothing. Cargo's own
/// up-to-date check makes the unchanged case a no-op, and `OnceLock` keeps it
/// to one invocation per test process.
pub fn fixture() -> PathBuf {
    static PATH: OnceLock<PathBuf> = OnceLock::new();
    PATH.get_or_init(|| {
        let exe = std::env::current_exe().expect("test executable path");
        let mut cargo =
            std::process::Command::new(std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into()));
        cargo
            .args([
                "build",
                "-p",
                "multicc-gateway",
                "--example",
                "remote_child_fixture",
                "--message-format=json-render-diagnostics",
            ])
            .current_dir(env!("CARGO_MANIFEST_DIR"));
        // Build into the profile the tests themselves run under.
        if exe
            .ancestors()
            .any(|part| part.file_name().is_some_and(|n| n == "release"))
        {
            cargo.arg("--release");
        }
        if let Some(target) = std::env::var_os("CARGO_TARGET_DIR") {
            cargo.env("CARGO_TARGET_DIR", target);
        }
        let output = cargo.output().expect("run cargo to build the fixture");
        assert!(
            output.status.success(),
            "building remote_child_fixture failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let path = String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
            .find(|message| {
                message["reason"] == "compiler-artifact"
                    && message["target"]["name"] == "remote_child_fixture"
            })
            .and_then(|message| message["executable"].as_str().map(PathBuf::from))
            .expect("cargo did not report the remote_child_fixture executable");
        assert!(path.exists(), "{} was not produced", path.display());
        path
    })
    .clone()
}
