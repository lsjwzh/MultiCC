//! `GET /api/uploads/stats` and `DELETE /api/uploads/cleanup` (were
//! `createUploadStatsHandler` / `createUploadCleanupHandler` in
//! src/routes/file-transfer.js): the chat upload temp files, `multicc_*` in
//! `os.tmpdir()`. Uploading itself (`POST /api/upload`, multer) is still Node.

use std::path::Path;

use multicc_core::http_send::{node_mtime, FileStat};
use serde_json::{json, Value};

const PREFIX: &str = "multicc_";

fn non_empty_env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

/// `os.tmpdir()`.
pub fn tmpdir() -> String {
    if cfg!(windows) {
        let mut path = non_empty_env("TEMP")
            .or_else(|| non_empty_env("TMP"))
            .unwrap_or_else(|| {
                let root = non_empty_env("SystemRoot")
                    .or_else(|| non_empty_env("windir"))
                    .unwrap_or_default();
                format!("{root}\\temp")
            });
        if path.len() > 1 && path.ends_with('\\') && !path.ends_with(":\\") {
            path.pop();
        }
        path
    } else {
        let mut path = non_empty_env("TMPDIR")
            .or_else(|| non_empty_env("TMP"))
            .or_else(|| non_empty_env("TEMP"))
            .unwrap_or_else(|| "/tmp".to_string());
        if path.len() > 1 && path.ends_with('/') {
            path.pop();
        }
        path
    }
}

/// `path.join(dir, name)` for a plain file name.
fn join(dir: &str, name: &str) -> String {
    let separator = if cfg!(windows) { '\\' } else { '/' };
    if dir.ends_with(separator) || (cfg!(windows) && dir.ends_with('/')) {
        format!("{dir}{name}")
    } else {
        format!("{dir}{separator}{name}")
    }
}

/// Node's message for a failed `readdirSync` (`<code>: <description>,
/// scandir '<dir>'`), for the errors a temp directory can realistically give.
fn scandir_message(error: &std::io::Error, dir: &str) -> String {
    let (code, description) = match error.kind() {
        std::io::ErrorKind::NotFound => ("ENOENT", "no such file or directory"),
        std::io::ErrorKind::PermissionDenied => ("EACCES", "permission denied"),
        _ if error.raw_os_error() == Some(20) && cfg!(unix) => ("ENOTDIR", "not a directory"),
        _ => return format!("{error}, scandir '{dir}'"),
    };
    format!("{code}: {description}, scandir '{dir}'")
}

/// `fs.readdirSync(dir)` names that start with `multicc_`: UTF-8 decoded with
/// replacement and sorted by bytes (libuv's scandir sorts with strcmp).
fn upload_names(dir: &str) -> Result<Vec<String>, String> {
    let entries = std::fs::read_dir(dir).map_err(|error| scandir_message(&error, dir))?;
    let mut names: Vec<String> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with(PREFIX))
        .collect();
    names.sort_unstable_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
    Ok(names)
}

/// `fs.statSync(path)` (follows symlinks) for a regular file.
fn file_stat(path: &str) -> Option<FileStat> {
    let meta = std::fs::metadata(Path::new(path)).ok()?;
    meta.is_file().then(|| super::download::file_stat(&meta))
}

/// `GET /api/uploads/stats`.
pub fn stats() -> (u16, Value) {
    let dir = tmpdir();
    let names = match upload_names(&dir) {
        Ok(names) => names,
        Err(message) => return (500, json!({ "error": message })),
    };
    let mut files = Vec::new();
    let mut total: u64 = 0;
    for name in names {
        let Some(stat) = file_stat(&join(&dir, &name)) else {
            continue;
        };
        total += stat.size;
        let mtime = multicc_core::js::date_to_iso_string(node_mtime(&stat))
            .map(Value::String)
            .unwrap_or(Value::Null);
        files.push(json!({ "name": name, "size": stat.size, "mtime": mtime }));
    }
    (
        200,
        json!({ "count": files.len(), "totalSize": total, "dir": dir, "files": files }),
    )
}

/// `(freed / 1024 / 1024).toFixed(2)`: exact, ties away from zero like
/// `Number.prototype.toFixed` (bytes / 2^20 is a dyadic rational, so ties
/// really happen, e.g. 131072 bytes = 0.125).
fn megabytes_fixed2(bytes: u64) -> String {
    let scaled = u128::from(bytes) * 100;
    let unit = 1u128 << 20;
    let hundredths = (scaled * 2 + unit) / (unit * 2);
    format!("{}.{:02}", hundredths / 100, hundredths % 100)
}

/// `DELETE /api/uploads/cleanup`.
pub fn cleanup() -> (u16, Value) {
    let dir = tmpdir();
    let names = match upload_names(&dir) {
        Ok(names) => names,
        Err(message) => return (500, json!({ "error": message })),
    };
    let (mut deleted, mut freed) = (0u64, 0u64);
    for name in names {
        let path = join(&dir, &name);
        let Some(stat) = file_stat(&path) else {
            continue;
        };
        if std::fs::remove_file(&path).is_ok() {
            deleted += 1;
            freed += stat.size;
        }
    }
    // console.log in the Node handler; same stream, same text.
    println!(
        "[multicc] Cleanup: deleted {deleted} temp files, freed {} MB",
        megabytes_fixed2(freed)
    );
    (200, json!({ "deleted": deleted, "freed": freed }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn megabytes_round_like_to_fixed() {
        assert_eq!(megabytes_fixed2(0), "0.00");
        assert_eq!(megabytes_fixed2(131_072), "0.13"); // exact tie 0.125
        assert_eq!(megabytes_fixed2(1_048_576), "1.00");
        assert_eq!(megabytes_fixed2(5_242), "0.00");
        assert_eq!(megabytes_fixed2(5_243), "0.01");
        assert_eq!(megabytes_fixed2(3_000_000_000), "2861.02");
    }

    #[test]
    fn join_and_scandir_messages_follow_node() {
        if cfg!(unix) {
            assert_eq!(join("/tmp", "multicc_a"), "/tmp/multicc_a");
            let missing = std::io::Error::from(std::io::ErrorKind::NotFound);
            assert_eq!(
                scandir_message(&missing, "/nope"),
                "ENOENT: no such file or directory, scandir '/nope'"
            );
        }
    }
}
