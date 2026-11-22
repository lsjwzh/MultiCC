//! Shared helpers for the integration tests that spawn the fake
//! `multicc-remote` (`examples/remote_child_fixture.rs`).
//!
//! Each test target pulls this in with `mod common;`. It lives in a
//! subdirectory on purpose: `tests/common/mod.rs` is not itself a test target.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::SystemTime;

fn is_fresh_example(bin: &Path, manifest_dir: &Path) -> bool {
    let Ok(bin_mtime) = std::fs::metadata(bin).and_then(|m| m.modified()) else {
        return false;
    };
    let inputs = [
        manifest_dir
            .join("examples")
            .join("remote_child_fixture.rs"),
        manifest_dir.join("Cargo.toml"),
    ];
    inputs.iter().all(|src| {
        std::fs::metadata(src)
            .and_then(|m| m.modified())
            .is_ok_and(|src_mtime: SystemTime| bin_mtime >= src_mtime)
    })
}

/// Path of the fake `multicc-remote`, freshly built.
///
/// It is an example rather than a `[[bin]]` on purpose: `cargo build --release`
/// builds every bin of the package, and a test stand-in must never be compiled
/// into (or sit next to) the release artifacts.
///
/// `cargo test` builds examples before running integration tests, while
/// `cargo test --test <name>` does not. Reuse the already-built sibling example
/// when it is at least as new as its source so `cargo test --workspace` avoids
/// a nested `cargo build` (which otherwise thrashes workspace feature caches
/// and waits on the target lock). Fall back to building with `--workspace` only
/// when the example is missing or stale.
pub fn fixture() -> PathBuf {
    static PATH: OnceLock<PathBuf> = OnceLock::new();
    PATH.get_or_init(|| {
        let exe = std::env::current_exe().expect("test executable path");
        let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
        if let Some(profile_dir) = exe.parent().and_then(Path::parent) {
            let candidate = profile_dir.join("examples").join(format!(
                "remote_child_fixture{}",
                std::env::consts::EXE_SUFFIX
            ));
            if is_fresh_example(&candidate, manifest_dir) {
                return candidate;
            }
        }
        let mut cargo =
            std::process::Command::new(std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into()));
        cargo
            .args([
                "build",
                "--locked",
                "--workspace",
                "--example",
                "remote_child_fixture",
                "--message-format=json-render-diagnostics",
            ])
            .current_dir(manifest_dir);
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
