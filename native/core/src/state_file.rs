//! `src/state/store.js` `writeTextAtomic` and `src/runtime-security.js`
//! `atomicWriteJson`, for state files Rust now owns.
//!
//! Same steps and tolerances: `mkdir -p` with the directory mode (chmod only
//! when the directory was just created), write a `<target>.tmp.<pid>.<n>`
//! sibling, fsync it (ENOTSUP/EINVAL tolerated), rename over the target, chmod
//! the target, fsync the directory (EISDIR/EBADF/EPERM tolerated), and remove
//! the temporary file on any failure.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::Value;

use crate::js::serde::js_json_stringify_indent;

static COUNTER: AtomicU64 = AtomicU64::new(0);

pub const FILE_MODE: u32 = 0o600;
pub const DIR_MODE: u32 = 0o700;

fn tolerated_fsync(error: &io::Error) -> bool {
    #[cfg(unix)]
    {
        matches!(
            error.raw_os_error(),
            Some(libc_codes::ENOTSUP) | Some(libc_codes::EINVAL)
        )
    }
    #[cfg(not(unix))]
    {
        let _ = error;
        true
    }
}

#[cfg(unix)]
mod libc_codes {
    #[cfg(target_os = "linux")]
    pub const ENOTSUP: i32 = 95;
    #[cfg(not(target_os = "linux"))]
    pub const ENOTSUP: i32 = 45;
    pub const EINVAL: i32 = 22;
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) -> io::Result<()> {
    Ok(())
}

fn fsync_dir(dir: &Path) -> Result<(), (WriteStage, io::Error)> {
    #[cfg(unix)]
    {
        match fs::File::open(dir) {
            Ok(handle) => match handle.sync_all() {
                Err(error) if !tolerated_fsync(&error) => Err((WriteStage::FsyncDirectory, error)),
                _ => Ok(()),
            },
            Err(error) if error.kind() == io::ErrorKind::PermissionDenied => Ok(()),
            Err(error) => Err((WriteStage::OpenDirectory, error)),
        }
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
        Ok(())
    }
}

/// The step that failed inside an atomic write. The history file repository
/// needs it to report the same `syscall` Node does for the equivalent call
/// (`open` for a temp-file failure, `rename` for the replacement, `fsync` for a
/// durability failure, ...).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WriteStage {
    Mkdir,
    ChmodDir,
    OpenTemporary,
    Write,
    Fsync,
    BeforeRename,
    Rename,
    ChmodTarget,
    OpenDirectory,
    FsyncDirectory,
}

/// `String.prototype.replace`-free source of the Node fs error message for a
/// failed atomic write step. `path` is the operand Node would report; `dest` is
/// set only for the rename step.
#[derive(Debug)]
pub struct WriteFailure {
    pub stage: WriteStage,
    pub error: io::Error,
    pub path: PathBuf,
    pub dest: Option<PathBuf>,
}

impl WriteFailure {
    fn new(stage: WriteStage, error: io::Error, path: impl Into<PathBuf>) -> Self {
        Self {
            stage,
            error,
            path: path.into(),
            dest: None,
        }
    }
}

/// `writeTextAtomic(target, text, { mode, dirMode })`.
pub fn write_text_atomic(target: &Path, text: &str, mode: u32, dir_mode: u32) -> io::Result<()> {
    write_bytes_atomic(target, text.as_bytes(), mode, dir_mode)
}

/// Byte-preserving variant. The JS writer passed a string, but the history
/// repository accumulates already-encoded UTF-8 lines and must not decode them
/// again just to re-encode.
pub fn write_bytes_atomic(target: &Path, bytes: &[u8], mode: u32, dir_mode: u32) -> io::Result<()> {
    write_bytes_atomic_traced(target, bytes, mode, dir_mode).map_err(|failure| failure.error)
}

/// Run the store's backup rotation after the new file is durable and before
/// replacing the old primary. The hook must not publish an in-memory snapshot.
pub fn write_text_atomic_before_rename(
    target: &Path,
    text: &str,
    mode: u32,
    dir_mode: u32,
    before_rename: impl FnOnce() -> io::Result<()>,
) -> io::Result<()> {
    write_bytes_atomic_traced_before_rename(target, text.as_bytes(), mode, dir_mode, before_rename)
        .map_err(|failure| failure.error)
}

pub fn write_bytes_atomic_traced(
    target: &Path,
    bytes: &[u8],
    mode: u32,
    dir_mode: u32,
) -> Result<(), WriteFailure> {
    write_bytes_atomic_traced_before_rename(target, bytes, mode, dir_mode, || Ok(()))
}

pub fn write_bytes_atomic_traced_before_rename(
    target: &Path,
    bytes: &[u8],
    mode: u32,
    dir_mode: u32,
    before_rename: impl FnOnce() -> io::Result<()>,
) -> Result<(), WriteFailure> {
    let dir = target.parent().unwrap_or_else(|| Path::new("."));
    let existed = dir.exists();
    // `writeTextAtomic` swallows EEXIST from the recursive mkdir and lets the
    // temp-file open surface the real failure (a file where a directory
    // belongs fails ENOTDIR there, exactly like Node).
    if let Err(error) = fs::create_dir_all(dir) {
        if error.kind() != io::ErrorKind::AlreadyExists {
            return Err(WriteFailure::new(WriteStage::Mkdir, error, dir));
        }
    }
    if !existed {
        set_mode(dir, dir_mode)
            .map_err(|error| WriteFailure::new(WriteStage::ChmodDir, error, dir))?;
    }
    let mut name = target.as_os_str().to_os_string();
    name.push(format!(
        ".tmp.{}.{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let temp = PathBuf::from(name);
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(mode);
        }
        let mut handle = options
            .open(&temp)
            .map_err(|error| WriteFailure::new(WriteStage::OpenTemporary, error, &temp))?;
        handle
            .write_all(bytes)
            .map_err(|error| WriteFailure::new(WriteStage::Write, error, &temp))?;
        if let Err(error) = handle.sync_all() {
            if !tolerated_fsync(&error) {
                return Err(WriteFailure::new(WriteStage::Fsync, error, &temp));
            }
        }
        drop(handle);
        before_rename()
            .map_err(|error| WriteFailure::new(WriteStage::BeforeRename, error, target))?;
        fs::rename(&temp, target).map_err(|error| WriteFailure {
            stage: WriteStage::Rename,
            error,
            path: temp.clone(),
            dest: Some(target.to_path_buf()),
        })?;
        set_mode(target, mode)
            .map_err(|error| WriteFailure::new(WriteStage::ChmodTarget, error, target))?;
        fsync_dir(dir).map_err(|(stage, error)| WriteFailure::new(stage, error, dir))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

/// `atomicWriteJson(file, value)`: `JSON.stringify(value, null, 2)`, 0600 in
/// a 0700 directory, no trailing newline.
pub fn write_json_atomic(target: &Path, value: &Value) -> io::Result<()> {
    write_text_atomic(
        target,
        &js_json_stringify_indent(value, "  "),
        FILE_MODE,
        DIR_MODE,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn indent_layout_matches_v8() {
        let value = json!({"version": 1, "presets": [{"a": [], "b": {}, "c": [1, "x"]}], "e": []});
        assert_eq!(
            js_json_stringify_indent(&value, "  "),
            "{\n  \"version\": 1,\n  \"presets\": [\n    {\n      \"a\": [],\n      \"b\": {},\n      \"c\": [\n        1,\n        \"x\"\n      ]\n    }\n  ],\n  \"e\": []\n}"
        );
        assert_eq!(js_json_stringify_indent(&json!([]), "  "), "[]");
        assert_eq!(js_json_stringify_indent(&json!("s"), "  "), "\"s\"");
    }

    #[test]
    fn writes_private_file_and_leaves_no_temp() {
        let dir = std::env::temp_dir().join(format!("multicc-state-file-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let target = dir.join("nested").join("x.json");
        write_json_atomic(&target, &json!({"ok": true})).unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "{\n  \"ok\": true\n}");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let file_mode = fs::metadata(&target).unwrap().permissions().mode() & 0o777;
            let dir_mode = fs::metadata(target.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(file_mode, 0o600);
            assert_eq!(dir_mode, 0o700);
        }
        let leftovers: Vec<_> = fs::read_dir(target.parent().unwrap())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp."))
            .collect();
        assert!(leftovers.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }
}
