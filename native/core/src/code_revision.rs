//! Content observation runs as one native job, not per-file libuv round trips.
//! Every capture reads fresh bytes; no timestamp cache can mint a stale revision.
use ring::digest::{digest, Context, SHA256};
use std::{
    fs::{self, Metadata, OpenOptions},
    io::{self, Read},
    path::{Component, Path},
};

pub struct FileDigest {
    hash: Context,
}

impl FileDigest {
    pub fn finish(&self, gitlinks: &str) -> String {
        let mut hash = self.hash.clone();
        hash.update(gitlinks.as_bytes());
        hex(hash.finish().as_ref())
    }
}

fn io_error(_: io::Error) -> String {
    "code_observation_failed".into()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(unix)]
fn same_file(a: &Metadata, b: &Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    a.dev() == b.dev()
        && a.ino() == b.ino()
        && a.len() == b.len()
        && a.mtime() == b.mtime()
        && a.mtime_nsec() == b.mtime_nsec()
        && a.ctime() == b.ctime()
        && a.ctime_nsec() == b.ctime_nsec()
}

#[cfg(not(unix))]
fn same_file(a: &Metadata, b: &Metadata) -> bool {
    a.len() == b.len()
        && a.modified().ok() == b.modified().ok()
        && a.created().ok() == b.created().ok()
        && a.file_type() == b.file_type()
}

pub fn observe_files(
    cwd: &Path,
    files: &[String],
    modes: &[String],
    honor_file_mode: bool,
    max_bytes: u64,
) -> Result<FileDigest, String> {
    if files.len() != modes.len() {
        return Err("code_index_unsupported".into());
    }
    // Canonicalize once so Windows extended-length prefixes match those from
    // parent canonicalization too. The host has already resolved the root.
    let root = fs::canonicalize(cwd).map_err(io_error)?;
    let cwd = root.as_path();
    // ring is already part of the runtime and detects SHA acceleration on ARM
    // as well as x86; the old sha2 default uses software hashing on ARM.
    let mut hash = Context::new(&SHA256);
    let mut total = 0u64;
    for (relative, tracked_mode) in files.iter().zip(modes) {
        if Path::new(relative)
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
        {
            return Err("code_path_unsupported".into());
        }
        let path = cwd.join(relative);
        let before = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(io_error(error)),
        };
        let parent = path.parent().ok_or("code_path_unsupported")?;
        if parent != cwd && fs::canonicalize(parent).ok().as_deref() != Some(parent) {
            return Err("code_parent_unsupported".into());
        }
        let symlink = before.file_type().is_symlink();
        if !before.is_file() && !symlink {
            return Err("code_file_unsupported".into());
        }
        total = total
            .checked_add(before.len())
            .ok_or("code_observation_limit")?;
        if total > max_bytes {
            return Err("code_observation_limit".into());
        }
        let digest = if symlink {
            // Match Node readlink's UTF-8 string conversion; never follow it.
            digest(
                &SHA256,
                fs::read_link(&path)
                    .map_err(io_error)?
                    .to_string_lossy()
                    .as_bytes(),
            )
        } else {
            let mut options = OpenOptions::new();
            options.read(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::OpenOptionsExt;
                options.custom_flags(0x00200000); // FILE_FLAG_OPEN_REPARSE_POINT
            }
            let file = options.open(&path).map_err(io_error)?;
            let opened = file.metadata().map_err(io_error)?;
            if !opened.is_file() || !same_file(&before, &opened) {
                return Err("code_changed_during_observation".into());
            }
            let mut file_hash = Context::new(&SHA256);
            let mut limited = file.take(before.len().saturating_add(1));
            let mut buffer = [0u8; 64 * 1024];
            let mut read = 0u64;
            loop {
                let count = limited.read(&mut buffer).map_err(io_error)?;
                if count == 0 {
                    break;
                }
                read += count as u64;
                file_hash.update(&buffer[..count]);
            }
            if read != before.len() {
                return Err("code_changed_during_observation".into());
            }
            file_hash.finish()
        };
        let after = fs::symlink_metadata(&path).map_err(io_error)?;
        if !same_file(&before, &after) {
            return Err("code_changed_during_observation".into());
        }
        #[cfg(unix)]
        let executable = {
            use std::os::unix::fs::PermissionsExt;
            before.permissions().mode() & 0o111 != 0
        };
        #[cfg(not(unix))]
        let executable = false;
        let mode = if symlink {
            "120000"
        } else if !honor_file_mode && !tracked_mode.is_empty() {
            tracked_mode
        } else if executable {
            "100755"
        } else {
            "100644"
        };
        let line = serde_json::to_string(&(relative, mode, hex(digest.as_ref())))
            .map_err(|_| "code_path_unsupported")?;
        hash.update(line.as_bytes());
        hash.update(b"\n");
    }
    Ok(FileDigest { hash })
}
