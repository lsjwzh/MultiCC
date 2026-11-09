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
use std::path::Path;
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

fn fsync_dir(dir: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        match fs::File::open(dir) {
            Ok(handle) => match handle.sync_all() {
                Err(error) if !tolerated_fsync(&error) => Err(error),
                _ => Ok(()),
            },
            Err(error) if error.kind() == io::ErrorKind::PermissionDenied => Ok(()),
            Err(error) => Err(error),
        }
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
        Ok(())
    }
}

/// `writeTextAtomic(target, text, { mode, dirMode })`.
pub fn write_text_atomic(target: &Path, text: &str, mode: u32, dir_mode: u32) -> io::Result<()> {
    write_text_atomic_before_rename(target, text, mode, dir_mode, || Ok(()))
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
    let dir = target.parent().unwrap_or_else(|| Path::new("."));
    let existed = dir.exists();
    fs::create_dir_all(dir)?;
    if !existed {
        set_mode(dir, dir_mode)?;
    }
    let mut name = target.as_os_str().to_os_string();
    name.push(format!(
        ".tmp.{}.{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let temp = std::path::PathBuf::from(name);
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(mode);
        }
        let mut handle = options.open(&temp)?;
        handle.write_all(text.as_bytes())?;
        if let Err(error) = handle.sync_all() {
            if !tolerated_fsync(&error) {
                return Err(error);
            }
        }
        drop(handle);
        before_rename()?;
        fs::rename(&temp, target)?;
        set_mode(target, mode)?;
        fsync_dir(dir)
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
