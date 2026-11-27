//! Expire direct entries of the writable artifacts root. Child operations are
//! relative to the opened directory, including when the root is replaced.
use cap_fs_ext::DirExt;
use cap_std::{ambient_authority, fs::Dir};
use std::{collections::HashSet, path::Path, time::UNIX_EPOCH};

pub fn sweep(path: &Path, now_ms: f64, max_age_ms: f64, pinned: &HashSet<String>) -> u32 {
    let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else {
        return 0;
    };
    let Ok(root) = Dir::open_ambient_dir(parent, ambient_authority())
        .and_then(|dir| dir.open_dir_nofollow(name))
    else {
        return 0;
    };
    let Ok(entries) = root.entries() else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name();
        if name.to_str().is_some_and(|id| pinned.contains(id)) {
            continue;
        }
        let Ok(metadata) = root.symlink_metadata(&name) else {
            continue;
        };
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        let mtime = match modified.into_std().duration_since(UNIX_EPOCH) {
            Ok(duration) => duration.as_secs_f64() * 1000.,
            Err(error) => -error.duration().as_secs_f64() * 1000.,
        };
        if now_ms - mtime > max_age_ms {
            let result = if metadata.is_dir() {
                root.remove_dir_all(&name)
            } else {
                root.remove_file_or_symlink(&name)
            };
            if result.is_ok() {
                removed += 1;
            }
        }
    }
    removed
}
