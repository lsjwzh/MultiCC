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
        let mut cargo =
            std::process::Command::new(std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into()));
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
        let path = profile_dir.join("examples").join(name);
        assert!(path.exists(), "{} was not produced", path.display());
        path
    })
    .clone()
}
