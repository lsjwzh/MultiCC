//! Capture a new Codex terminal's resume ID from the most recent matching rollout.
use crate::js::raw_record::{flag, record, string};
use std::{
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

fn mtime_ms(time: SystemTime) -> f64 {
    let duration = time.duration_since(UNIX_EPOCH);
    let (sign, elapsed) = match duration {
        Ok(elapsed) => (1.0, elapsed),
        Err(before) => (-1.0, before.duration()),
    };
    sign * (elapsed.as_secs() as f64 * 1000.0 + f64::from(elapsed.subsec_nanos()) / 1_000_000.0)
}

// fs.realpathSync resolves "." and ".." lexically before following symlinks.
fn realpath(path: &str) -> Option<PathBuf> {
    let path = Path::new(path);
    let absolute = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir().ok()?.join(path)
    };
    fs::canonicalize(crate::host_exec::lexical_normalize(&absolute)).ok()
}

fn matching_id(path: &Path, cwd: &str, real_cwd: Option<&Path>) -> Option<String> {
    let mut buffer = [0; 8192];
    let size = File::open(path).ok()?.read(&mut buffer).ok()?;
    let first = buffer[..size].split(|&byte| byte == b'\n').next()?;
    let text = String::from_utf8_lossy(first);
    let meta = record(&text)?;
    if string(meta.get("type"))? != "session_meta" {
        return None;
    }
    let payload = record(meta.get("payload")?.get())?;
    let id = payload.get("id")?;
    if !flag(Some(id)) {
        return None;
    }
    let stored = string(payload.get("cwd"))?;
    // A failed realpath leaves the original string intact, including "." and repeated slashes.
    if stored != cwd {
        let actual = realpath(&stored.to_string_lossy())?;
        if Some(actual.as_path()) != real_cwd {
            return None;
        }
    }
    // Preserve the JSON type and UTF-16 escapes, including IDs written by older clients.
    Some(id.get().to_owned())
}

pub fn find_session_id(cwd: &str, since_ms: f64, root: &Path) -> Option<String> {
    let mut directories = vec![root.to_owned()];
    let mut candidates: Vec<(f64, PathBuf)> = Vec::new();
    while let Some(dir) = directories.pop() {
        let Ok(entries) = fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                directories.push(entry.path());
            } else if kind.is_file() && entry.file_name().as_encoded_bytes().ends_with(b".jsonl") {
                if let Ok(time) = entry.metadata().and_then(|meta| meta.modified()) {
                    let modified = mtime_ms(time);
                    if modified >= since_ms {
                        candidates.push((modified, entry.path()));
                    }
                }
            }
        }
    }
    // libuv visits names in lexical order in each directory. Comparing path components
    // reproduces that depth-first visit order when several files have the same mtime.
    candidates.sort_unstable_by(|(a, pa), (b, pb)| b.total_cmp(a).then_with(|| pa.cmp(pb)));
    let real_cwd = realpath(cwd);
    candidates
        .iter()
        .find_map(|(_, path)| matching_id(path, cwd, real_cwd.as_deref()))
}
