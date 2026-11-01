//! 保留既有 JSON 文件协议的 Rust 仓储。双副本先落恢复档，启动按 revision 恢复。
use super::*;
use fs2::FileExt;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};
static SERIAL: AtomicU64 = AtomicU64::new(0);
fn err(e: impl std::fmt::Display) -> String {
    format!("TASK_BOARD_STORAGE: {e}")
}
fn sibling(file: &Path, suffix: &str) -> PathBuf {
    let s = file.to_string_lossy();
    let base = if s.to_ascii_lowercase().ends_with(".json") {
        &s[..s.len() - 5]
    } else {
        &s
    };
    PathBuf::from(format!("{base}{suffix}"))
}
fn unix_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}
enum ReadState {
    Missing,
    Parsed(Value),
    Corrupt,
}
// 文件不存在与“存在但读不出”必须区分：后者绝不能当成空板。
fn read(file: &Path) -> ReadState {
    match fs::read(file) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => ReadState::Missing,
        Err(_) => ReadState::Corrupt,
        Ok(bytes) => match crate::json_lenient::from_slice(&bytes) {
            Ok(value) => ReadState::Parsed(value),
            Err(_) => ReadState::Corrupt,
        },
    }
}
fn write(file: &Path, bytes: &[u8]) -> Result<(), String> {
    let name = PathBuf::from(format!(
        "{}.{}.{}.tmp",
        file.display(),
        std::process::id(),
        SERIAL.fetch_add(1, Ordering::Relaxed)
    ));
    let out = (|| {
        let mut opts = OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&name).map_err(err)?;
        f.write_all(bytes).map_err(err)?;
        f.sync_all().map_err(err)?;
        fs::rename(&name, file).map_err(err)?;
        #[cfg(unix)]
        {
            fs::File::open(file.parent().unwrap_or(Path::new(".")))
                .and_then(|d| d.sync_all())
                .map_err(err)?;
        }
        Ok(())
    })();
    if out.is_err() {
        let _ = fs::remove_file(name);
    }
    out
}
fn restore(file: &Path, old: Option<&Vec<u8>>) -> Result<(), String> {
    match old {
        Some(bytes) => write(file, bytes),
        None => match fs::remove_file(file) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(err(e)),
        },
    }
}
// 原样复制一份备份，不覆盖同名文件；只复制，不改动原文件。
fn copy_backup(src: &Path, dest: &Path) -> Result<(), String> {
    let bytes = fs::read(src).map_err(err)?;
    let mut opts = OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(dest).map_err(err)?;
    f.write_all(&bytes).map_err(err)?;
    f.sync_all().map_err(err)?;
    Ok(())
}
// 同类备份只保留最近 10 份，文件名末尾的毫秒时间戳是排序依据。
fn prune_backups(file: &Path, infix: &str, keep: usize) {
    let Some(dir) = file.parent() else { return };
    let name = file
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let base = name.strip_suffix(".json").unwrap_or(&name);
    let prefix = format!("{base}{infix}");
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut backups: Vec<(u128, PathBuf)> = entries
        .filter_map(|entry| {
            let path = entry.ok()?.path();
            let name = path.file_name()?.to_string_lossy().into_owned();
            let rest = name.strip_prefix(&prefix)?.strip_suffix(".json")?;
            let stamp = rest.rsplit('-').next()?.parse::<u128>().ok()?;
            Some((stamp, path))
        })
        .collect();
    if backups.len() <= keep {
        return;
    }
    backups.sort_by_key(|(stamp, _)| std::cmp::Reverse(*stamp));
    for (_, path) in backups.into_iter().skip(keep) {
        let _ = fs::remove_file(path);
    }
}
fn next_backup(file: &Path, infix: &str, revision: Option<f64>) -> PathBuf {
    let mut stamp = unix_millis();
    loop {
        let suffix = match revision {
            Some(rev) if rev.fract() == 0.0 => {
                format!(".{infix}{}-{stamp}.json", rev as i64)
            }
            Some(rev) => format!(".{infix}{rev}-{stamp}.json"),
            None => format!(".{infix}{stamp}.json"),
        };
        let candidate = sibling(file, &suffix);
        if !candidate.exists() {
            return candidate;
        }
        stamp += 1;
    }
}
fn quarantine(file: &Path) -> Result<PathBuf, String> {
    let dest = next_backup(file, "corrupt-", None);
    copy_backup(file, &dest)?;
    prune_backups(file, ".corrupt-", 10);
    Ok(dest)
}
fn conflict_backup(file: &Path, disk: f64) -> Result<PathBuf, String> {
    let dest = next_backup(file, "conflict-r", Some(disk));
    copy_backup(file, &dest)?;
    prune_backups(file, ".conflict-r", 10);
    Ok(dest)
}
// 同目录 .lock 互斥：返回值持有锁，作用域结束即释放。
fn locked(file: &Path) -> Result<fs::File, String> {
    if file.as_os_str().is_empty() {
        return Err("TASK_BOARD_STORAGE: missing path".into());
    }
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(err)?;
    }
    let mut opts = OpenOptions::new();
    opts.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let lock = opts.open(sibling(file, ".lock")).map_err(err)?;
    lock.try_lock_exclusive()
        .map_err(|_| "TASK_BOARD_STORAGE: busy".to_string())?;
    Ok(lock)
}
pub fn run(v: &Value) -> Result<Value, String> {
    let file = Path::new(text(&v["file"]));
    if text(&v["action"]) == "save" {
        let mut board = v["board"].clone();
        return save_board(
            file,
            &mut board,
            v.get("expectedRevision"),
            text(&v["onConflict"]) == "preserve",
        );
    }
    let _lock = locked(file)?;
    let recovery = sibling(file, ".planning-v2.json");
    match text(&v["action"]) {
        "load" => {
            let primary = read(file);
            let secondary = read(&recovery);
            if let ReadState::Parsed(p) = &primary {
                if num(&p["schemaVersion"]) > 2.0 {
                    return Err(format!(
                        "TASK_BOARD_SCHEMA_UNSUPPORTED:{}",
                        p["schemaVersion"]
                    ));
                }
            }
            let mut quarantined = vec![];
            if matches!(&primary, ReadState::Corrupt) {
                quarantined.push(quarantine(file)?.to_string_lossy().into_owned());
            }
            if matches!(&secondary, ReadState::Corrupt) {
                quarantined.push(quarantine(&recovery)?.to_string_lossy().into_owned());
            }
            let mut restored = false;
            let raw = match (&primary, &secondary) {
                (ReadState::Parsed(p), ReadState::Parsed(s))
                    if num(&s["schemaVersion"]) == 2.0
                        && (num(&p["schemaVersion"]) < 2.0
                            || num(&s["revision"]) > num(&p["revision"])) =>
                {
                    restored = true;
                    s.clone()
                }
                (ReadState::Parsed(p), _) => p.clone(),
                (_, ReadState::Parsed(s)) if num(&s["schemaVersion"]) == 2.0 => {
                    restored = true;
                    s.clone()
                }
                _ => Value::Null,
            };
            if num(&raw["schemaVersion"]) > 2.0 {
                return Err(format!(
                    "TASK_BOARD_SCHEMA_UNSUPPORTED:{}",
                    raw["schemaVersion"]
                ));
            }
            if raw.is_object()
                && num(&raw["schemaVersion"]) < 2.0
                && (!super::board::values(&raw["tasks"]).is_empty()
                    || !super::board::values(&raw["modules"]).is_empty())
            {
                let backup = sibling(file, ".pre-planning-v1.json");
                if !backup.exists() {
                    let bytes = serde_json::to_vec_pretty(&raw).map_err(err)?;
                    let mut opt = OpenOptions::new();
                    opt.write(true).create_new(true);
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::OpenOptionsExt;
                        opt.mode(0o600);
                    }
                    match opt.open(&backup) {
                        Ok(mut f) => {
                            f.write_all(&bytes).map_err(err)?;
                            f.sync_all().map_err(err)?;
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
                        Err(e) => return Err(err(e)),
                    }
                }
            }
            Ok(json!({"raw":raw,"restored":restored,"quarantined":quarantined}))
        }
        _ => Err("invalid_task_board_repository_command".into()),
    }
}

/// 双写落盘（先恢复档后主档，失败回滚）。常驻任务板直接传自己的副本，不克隆；
/// 冲突保全会把 board 的 revision 改为磁盘+1，写失败时连同 revision 一起回退。
/// 主档/恢复档的文件指纹。自己上次写入之后两份都没被动过（rename 换 inode、
/// 原地写改纳秒 mtime），磁盘 revision 就是上次写入的值，冲突检查不必重读解析整档。
#[derive(Clone, PartialEq, Debug)]
pub struct DiskStamp {
    path: PathBuf,
    files: [(u64, u128, u64); 2],
    revision: f64,
}
fn file_stamp(file: &Path) -> Option<(u64, u128, u64)> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let m = fs::metadata(file).ok()?;
        let modified = m
            .modified()
            .ok()?
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_nanos();
        Some((m.len(), modified, m.ino()))
    }
    // 拿不到 inode 的平台始终走完整检查。
    #[cfg(not(unix))]
    {
        let _ = file;
        None
    }
}
fn stamp_of(file: &Path, recovery: &Path, revision: f64) -> Option<DiskStamp> {
    Some(DiskStamp {
        path: file.to_path_buf(),
        files: [file_stamp(file)?, file_stamp(recovery)?],
        revision,
    })
}

pub fn save_board(
    file: &Path,
    board: &mut Value,
    expected: Option<&Value>,
    preserve: bool,
) -> Result<Value, String> {
    save_board_stamped(file, board, expected, preserve, &mut None)
}

/// 同 save_board；`known` 记着上次写入后的文件指纹，未变时跳过整档重读解析。
pub fn save_board_stamped(
    file: &Path,
    board: &mut Value,
    expected: Option<&Value>,
    preserve: bool,
    known: &mut Option<DiskStamp>,
) -> Result<Value, String> {
    let _lock = locked(file)?;
    let recovery = sibling(file, ".planning-v2.json");
    let old = fs::read(file).ok();
    let old_recovery = fs::read(&recovery).ok();
    let unchanged = known.as_ref().filter(|k| {
        k.path == file && stamp_of(file, &recovery, k.revision).as_ref() == Some(*k)
    });
    let (primary, disk_revision) = match unchanged {
        Some(k) => (ReadState::Parsed(Value::Null), k.revision),
        None => {
            let primary = read(file);
            let secondary = read(&recovery);
            // 写前先把读不出的旧文件原样保全，下一次写入才能安全覆盖它。
            if matches!(&primary, ReadState::Corrupt) {
                quarantine(file)?;
            }
            if matches!(&secondary, ReadState::Corrupt) {
                quarantine(&recovery)?;
            }
            let disk = [&primary, &secondary]
                .into_iter()
                .filter_map(|state| match state {
                    ReadState::Parsed(value) => Some(num(&value["revision"])),
                    _ => None,
                })
                .fold(0.0, f64::max);
            (primary, disk)
        }
    };
    *known = None;
    let previous = board["revision"].clone();
    let mut conflict = None;
    if let Some(expected) = expected {
        if number(expected) != disk_revision {
            if !preserve {
                return Err("TASK_BOARD_REVISION_CONFLICT".into());
            }
            let backup = match &primary {
                ReadState::Parsed(_) => Some(
                    conflict_backup(file, disk_revision)?
                        .to_string_lossy()
                        .into_owned(),
                ),
                _ => None,
            };
            board["revision"] = json!(disk_revision + 1.0);
            conflict = Some((disk_revision, backup));
        }
    }
    let written = serde_json::to_vec_pretty(&*board)
        .map_err(err)
        .and_then(|bytes| write(&recovery, &bytes).and_then(|()| write(file, &bytes)));
    if let Err(error) = written {
        board["revision"] = previous;
        let a = restore(file, old.as_ref());
        let b = restore(&recovery, old_recovery.as_ref());
        if a.is_err() || b.is_err() {
            return Err(format!("{error}; rollback_failed"));
        }
        return Err(error);
    }
    *known = stamp_of(file, &recovery, num(&board["revision"]));
    let mut out = json!({"ok":true,"revision":num(&board["revision"])});
    if let Some((disk, backup)) = conflict {
        out["conflict"] = json!({"diskRevision":disk,"backup":backup});
    }
    Ok(out)
}
