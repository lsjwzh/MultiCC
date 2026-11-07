//! Codex switch preparation. Resolve the history authority before attempting a
//! migration: absence starts a checkpoint-backed thread, ambiguity and I/O
//! errors preserve the old session and fail closed. Called on an addon worker.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, Metadata, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const MAX_ENTRIES: usize = 100_000;
static TEMP_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Input {
    pub cli: String,
    pub logical_session_id: String,
    pub home_dir: PathBuf,
    #[serde(default)]
    pub native_session_id: Option<String>,
    #[serde(default)]
    pub from_provider_id: Option<String>,
    #[serde(default)]
    pub to_provider_id: Option<String>,
    #[serde(default)]
    pub fresh: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prepared {
    pub probe_handled: bool,
    pub native_session_exists: Option<bool>,
    pub synchronized: bool,
}

fn failure(code: &str, detail: impl std::fmt::Display) -> String {
    format!("{code}: {detail}")
}

fn metadata(path: &Path) -> Result<Option<Metadata>, String> {
    match fs::symlink_metadata(path) {
        Ok(meta) => Ok(Some(meta)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(failure("CODEX_SESSION_HISTORY_IO", error)),
    }
}

fn identity(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 512
        || value
            .chars()
            .any(|c| c.is_control() || c == '/' || c == '\\')
        || value == "."
        || value == ".."
    {
        return Err(failure(
            "CODEX_SESSION_IDENTITY_INVALID",
            "invalid session identity",
        ));
    }
    Ok(())
}

fn canonical_home(base: &Path, id: &str) -> PathBuf {
    let mut prefix = String::new();
    let mut invalid = false;
    for c in id.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
            prefix.push(c);
            invalid = false;
        } else if !invalid {
            prefix.push('-');
            invalid = true;
        }
    }
    let prefix: String = prefix.trim_matches('-').chars().take(48).collect();
    let prefix = if prefix.is_empty() {
        "session"
    } else {
        &prefix
    };
    let hash = format!("{:x}", Sha256::digest(id.as_bytes()));
    base.join(".multicc/codex-session-homes")
        .join(format!("{prefix}-{}", &hash[..20]))
}

fn find(root: &Path, id: &str, inspected: &mut usize) -> Result<Option<PathBuf>, String> {
    let Some(meta) = metadata(root)? else {
        return Ok(None);
    };
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return Err(failure(
            "CODEX_SESSION_HISTORY_PATH_INVALID",
            "history root must be a real directory",
        ));
    }
    let mut stack = vec![root.to_path_buf()];
    let suffix = format!("-{id}.jsonl");
    let mut found = None;
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(dir).map_err(|e| failure("CODEX_SESSION_HISTORY_IO", e))? {
            let entry = entry.map_err(|e| failure("CODEX_SESSION_HISTORY_IO", e))?;
            *inspected += 1;
            if *inspected > MAX_ENTRIES {
                return Err(failure(
                    "CODEX_SESSION_ROLLOUT_SCAN_LIMIT",
                    "history scan limit exceeded",
                ));
            }
            let kind = entry
                .file_type()
                .map_err(|e| failure("CODEX_SESSION_HISTORY_IO", e))?;
            if kind.is_dir() {
                stack.push(entry.path());
            } else if kind.is_file() && entry.file_name().to_string_lossy().ends_with(&suffix) {
                if found.is_some() {
                    return Err(failure(
                        "CODEX_SESSION_ROLLOUT_AMBIGUOUS",
                        "multiple rollout sources",
                    ));
                }
                found = Some(entry.path());
            }
        }
    }
    Ok(found)
}

fn private_dir(path: &Path) -> Result<(), String> {
    if let Some(meta) = metadata(path)? {
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return Err(failure(
                "CODEX_SESSION_HISTORY_PATH_INVALID",
                "destination must be a real directory",
            ));
        }
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        private_dir(parent)?;
    }
    match fs::create_dir(path) {
        Ok(()) => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(path, fs::Permissions::from_mode(0o700))
                    .map_err(|e| failure("CODEX_SESSION_HISTORY_IO", e))?;
            }
            Ok(())
        }
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => private_dir(path),
        Err(e) => Err(failure("CODEX_SESSION_HISTORY_IO", e)),
    }
}

#[derive(PartialEq)]
struct Version {
    size: u64,
    modified: Option<std::time::SystemTime>,
    #[cfg(unix)]
    identity: (u64, u64, i64, i64),
}

fn version(path: &Path) -> Result<Option<Version>, String> {
    metadata(path)?
        .map(|meta| {
            if !meta.is_file() || meta.file_type().is_symlink() {
                return Err(failure(
                    "CODEX_SESSION_HISTORY_PATH_INVALID",
                    "rollout must be a real file",
                ));
            }
            Ok(Version {
                size: meta.len(),
                modified: meta.modified().ok(),
                #[cfg(unix)]
                identity: {
                    use std::os::unix::fs::MetadataExt;
                    (meta.dev(), meta.ino(), meta.ctime(), meta.ctime_nsec())
                },
            })
        })
        .transpose()
}

// Sources are retained. A failed switch/persistence operation never consumes
// history; temp cleanup is scoped to this copy, never another thread's files.
fn copy_checked(source: &Path, destination: &Path, replace: bool) -> Result<(), String> {
    if source == destination {
        return Ok(());
    }
    let source_before = version(source)?;
    let destination_before = version(destination)?;
    let parent = destination
        .parent()
        .ok_or_else(|| failure("CODEX_SESSION_HISTORY_PATH_INVALID", "missing parent"))?;
    private_dir(parent)?;
    let temp = parent.join(format!(
        ".switch-{}-{}",
        std::process::id(),
        TEMP_ID.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut output = options
            .open(&temp)
            .map_err(|e| failure("CODEX_SESSION_HISTORY_IO", e))?;
        let mut input = File::open(source).map_err(|e| failure("CODEX_SESSION_HISTORY_IO", e))?;
        io::copy(&mut input, &mut output).map_err(|e| failure("CODEX_SESSION_HISTORY_IO", e))?;
        output
            .sync_all()
            .map_err(|e| failure("CODEX_SESSION_HISTORY_IO", e))?;
        drop(output);
        drop(input);
        if source_before.is_none()
            || source_before != version(source)?
            || destination_before != version(destination)?
        {
            return Err(failure(
                "CODEX_SESSION_ROUTE_SOURCE_CHANGED",
                "history changed during preparation",
            ));
        }
        if replace {
            fs::rename(&temp, destination).map_err(|e| failure("CODEX_SESSION_HISTORY_IO", e))?;
        } else {
            fs::hard_link(&temp, destination)
                .map_err(|e| failure("CODEX_SESSION_ROLLOUT_RACE", e))?;
        }
        #[cfg(unix)]
        File::open(parent)
            .and_then(|file| file.sync_all())
            .map_err(|e| failure("CODEX_SESSION_HISTORY_IO", e))?;
        Ok(())
    })();
    let _ = fs::remove_file(temp);
    result
}

pub fn prepare(input: &Input) -> Result<Prepared, String> {
    let mut result = Prepared {
        probe_handled: matches!(input.cli.as_str(), "codex" | "codex-exp"),
        native_session_exists: None,
        synchronized: false,
    };
    if !result.probe_handled || input.fresh {
        return Ok(result);
    }
    let Some(id) = input
        .native_session_id
        .as_deref()
        .filter(|id| !id.is_empty())
    else {
        return Ok(result);
    };
    identity(id)?;
    identity(&input.logical_session_id)?;
    let canonical = canonical_home(&input.home_dir, &input.logical_session_id).join("sessions");
    for path in canonical.ancestors().take(3) {
        if let Some(meta) = metadata(path)? {
            if !meta.is_dir() || meta.file_type().is_symlink() {
                return Err(failure(
                    "CODEX_SESSION_HISTORY_PATH_INVALID",
                    "canonical history must use real directories",
                ));
            }
        }
    }
    let global = input.home_dir.join(".codex/sessions");
    let managed = input
        .from_provider_id
        .as_deref()
        .is_some_and(|id| !id.trim().is_empty());
    let to_managed = input
        .to_provider_id
        .as_deref()
        .is_some_and(|id| !id.trim().is_empty());
    let mut inspected = 0;
    let mut source_root = if managed {
        canonical.clone()
    } else {
        global.clone()
    };
    let mut source = find(&source_root, id, &mut inspected)?;
    if managed && source.is_none() {
        let homes = input.home_dir.join(".multicc/codex-homes");
        let mut roots = vec![global.clone()];
        if let Some(meta) = metadata(&homes)? {
            if !meta.is_dir() || meta.file_type().is_symlink() {
                return Err(failure(
                    "CODEX_SESSION_HISTORY_PATH_INVALID",
                    "legacy homes must be a real directory",
                ));
            }
            for entry in fs::read_dir(&homes).map_err(|e| failure("CODEX_SESSION_HISTORY_IO", e))? {
                let entry = entry.map_err(|e| failure("CODEX_SESSION_HISTORY_IO", e))?;
                inspected += 1;
                if inspected > MAX_ENTRIES {
                    return Err(failure(
                        "CODEX_SESSION_ROLLOUT_SCAN_LIMIT",
                        "history scan limit exceeded",
                    ));
                }
                if entry
                    .file_type()
                    .map_err(|e| failure("CODEX_SESSION_HISTORY_IO", e))?
                    .is_dir()
                {
                    roots.push(entry.path().join("sessions"));
                }
            }
        }
        for root in roots {
            if let Some(file) = find(&root, id, &mut inspected)? {
                if source.is_some() {
                    return Err(failure(
                        "CODEX_SESSION_ROLLOUT_AMBIGUOUS",
                        "multiple legacy rollout sources",
                    ));
                }
                source = Some(file);
                source_root = root;
            }
        }
    }
    let Some(mut source) = source else {
        result.native_session_exists = Some(false);
        return Ok(result);
    };
    result.native_session_exists = Some(true);
    if managed && source_root != canonical {
        let destination = canonical.join(
            source
                .strip_prefix(&source_root)
                .map_err(|e| failure("CODEX_SESSION_HISTORY_PATH_INVALID", e))?,
        );
        copy_checked(&source, &destination, false)?;
        source = destination;
        source_root = canonical.clone();
        result.synchronized = true;
    }
    if managed != to_managed {
        let target_root = if to_managed { canonical } else { global };
        let relative = source
            .strip_prefix(&source_root)
            .map_err(|e| failure("CODEX_SESSION_HISTORY_PATH_INVALID", e))?;
        let destination =
            find(&target_root, id, &mut inspected)?.unwrap_or_else(|| target_root.join(relative));
        copy_checked(&source, &destination, true)?;
        result.synchronized = true;
    }
    Ok(result)
}

pub fn request(input: &str) -> Result<String, String> {
    let input: Input = crate::json_lenient::from_str(input).map_err(|e| e.to_string())?;
    serde_json::to_string(&prepare(&input)?).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "multicc-cli-route-{}-{}",
                std::process::id(),
                TEMP_ID.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn input(&self) -> Input {
            Input {
                cli: "codex-exp".into(),
                logical_session_id: "task-1".into(),
                home_dir: self.0.clone(),
                native_session_id: Some("thread-1".into()),
                from_provider_id: Some("old-provider".into()),
                to_provider_id: Some("chosen-provider".into()),
                fresh: false,
            }
        }
        fn write(&self, root: &str, body: &str) -> PathBuf {
            let file = self
                .0
                .join(root)
                .join("sessions/2026/11/07/rollout-now-thread-1.jsonl");
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(&file, body).unwrap();
            file
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn missing_history_starts_fresh_without_attempting_migration_or_creating_stores() {
        let f = Fixture::new();
        for cli in ["codex", "codex-exp"] {
            let mut input = f.input();
            input.cli = cli.into();
            let prepared = prepare(&input).unwrap();
            assert_eq!(prepared.native_session_exists, Some(false));
            assert!(!prepared.synchronized);
            assert!(!f.0.join(".multicc").exists());
        }
    }

    #[test]
    fn a_unique_legacy_rollout_is_migrated_and_canonical_wins_on_later_switches() {
        let f = Fixture::new();
        let legacy = f.write(".multicc/codex-homes/old-provider", "original");
        let input = f.input();
        assert!(prepare(&input).unwrap().synchronized);
        let canonical =
            canonical_home(&f.0, "task-1").join("sessions/2026/11/07/rollout-now-thread-1.jsonl");
        assert_eq!(fs::read_to_string(&canonical).unwrap(), "original");
        assert_eq!(fs::read_to_string(legacy).unwrap(), "original");
        f.write(".codex", "another legacy copy");
        assert!(!prepare(&input).unwrap().synchronized);
        assert_eq!(fs::read_to_string(canonical).unwrap(), "original");
    }

    #[test]
    fn ambiguous_history_is_an_error_and_does_not_create_or_delete_any_rollout() {
        let f = Fixture::new();
        let a = f.write(".codex", "A");
        let b = f.write(".multicc/codex-homes/provider", "B");
        assert!(prepare(&f.input())
            .unwrap_err()
            .starts_with("CODEX_SESSION_ROLLOUT_AMBIGUOUS:"));
        assert_eq!(fs::read_to_string(a).unwrap(), "A");
        assert_eq!(fs::read_to_string(b).unwrap(), "B");
        assert!(!canonical_home(&f.0, "task-1").exists());
    }

    #[test]
    fn providerless_and_managed_routes_keep_the_newest_authoritative_copy() {
        let f = Fixture::new();
        let global = f.write(".codex", "providerless latest");
        let mut input = f.input();
        input.from_provider_id = None;
        assert!(prepare(&input).unwrap().synchronized);
        let canonical =
            canonical_home(&f.0, "task-1").join("sessions/2026/11/07/rollout-now-thread-1.jsonl");
        assert_eq!(
            fs::read_to_string(&canonical).unwrap(),
            "providerless latest"
        );
        fs::write(&canonical, "managed latest").unwrap();
        input.from_provider_id = Some("managed".into());
        input.to_provider_id = None;
        assert!(prepare(&input).unwrap().synchronized);
        assert_eq!(fs::read_to_string(global).unwrap(), "managed latest");
        assert_eq!(fs::read_to_string(canonical).unwrap(), "managed latest");
    }

    #[test]
    fn non_codex_and_explicit_fresh_switches_do_not_inspect_history() {
        let f = Fixture::new();
        let mut input = f.input();
        fs::write(f.0.join(".multicc"), "not a directory").unwrap();
        input.fresh = true;
        assert_eq!(prepare(&input).unwrap().native_session_exists, None);
        input.fresh = false;
        input.cli = "claude-exp".into();
        assert!(!prepare(&input).unwrap().probe_handled);
    }

    #[test]
    fn invalid_ids_and_non_directory_roots_are_never_reported_as_missing() {
        let f = Fixture::new();
        let mut input = f.input();
        input.native_session_id = Some("../outside".into());
        assert!(prepare(&input)
            .unwrap_err()
            .starts_with("CODEX_SESSION_IDENTITY_INVALID:"));
        input.native_session_id = Some("thread-1".into());
        fs::create_dir_all(f.0.join(".codex")).unwrap();
        fs::write(f.0.join(".codex/sessions"), "not a directory").unwrap();
        assert!(prepare(&input)
            .unwrap_err()
            .starts_with("CODEX_SESSION_HISTORY_PATH_INVALID:"));
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_canonical_roots_fail_closed_and_copies_are_private() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let f = Fixture::new();
        f.write(".codex", "history");
        prepare(&f.input()).unwrap();
        let home = canonical_home(&f.0, "task-1");
        let file = home.join("sessions/2026/11/07/rollout-now-thread-1.jsonl");
        assert_eq!(
            fs::metadata(file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(&home).unwrap().permissions().mode() & 0o777,
            0o700
        );
        fs::remove_dir_all(&home).unwrap();
        symlink(f.0.join(".codex"), home).unwrap();
        assert!(prepare(&f.input())
            .unwrap_err()
            .starts_with("CODEX_SESSION_HISTORY_PATH_INVALID:"));
    }

    #[test]
    fn canonical_names_match_the_host_hash_and_prefix_contract() {
        let f = Fixture::new();
        assert!(canonical_home(&f.0, "task-1").ends_with("task-1-7afaa346b4bf92bf9dc2"));
    }
}
