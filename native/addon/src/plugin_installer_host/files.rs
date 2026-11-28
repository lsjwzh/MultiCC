use multicc_core::handoff_zip::{read_zip, ZipOptions};
use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

pub(super) fn exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}
pub(super) fn remove(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(m) if m.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}
pub(super) fn version(path: &Path) -> Option<String> {
    let json: serde_json::Value =
        serde_json::from_slice(&fs::read(path.join("plugin.json")).ok()?).ok()?;
    json["version"].as_str().map(str::to_owned)
}
pub(super) fn sweep(path: &Path, now: f64) {
    let Ok(entries) = fs::read_dir(path) else {
        return;
    };
    for ent in entries.flatten() {
        let file = ent.path();
        if fs::symlink_metadata(&file)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .is_some_and(|t| now - t.as_secs_f64() * 1000.0 > 86_400_000.0)
        {
            let _ = remove(&file);
        }
    }
}
pub(super) fn swap(current: &Path, kept: &Path, incoming: &Path) -> io::Result<()> {
    let replaced = exists(current);
    if replaced {
        fs::create_dir_all(kept.parent().unwrap())?;
        remove(kept)?;
        fs::rename(current, kept)?;
    }
    if let Err(e) = fs::rename(incoming, current) {
        if replaced && !exists(current) {
            fs::rename(kept, current)?;
        }
        return Err(e);
    }
    Ok(())
}
pub(super) fn rollback(current: &Path, kept: &Path, parked: &Path) -> io::Result<()> {
    if exists(current) {
        fs::rename(current, parked)?
    }
    if let Err(e) = fs::rename(kept, current) {
        if exists(parked) {
            fs::rename(parked, current)?
        }
        return Err(e);
    }
    if exists(parked) {
        fs::rename(parked, kept)?
    }
    Ok(())
}
pub(super) fn executable(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(path)?.permissions().mode();
        fs::set_permissions(path, fs::Permissions::from_mode(mode | 0o755))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}
fn file_error(e: io::Error) -> String {
    match e.kind() {
        io::ErrorKind::AlreadyExists => "EEXIST".to_owned(),
        io::ErrorKind::NotADirectory => "ENOTDIR".to_owned(),
        io::ErrorKind::PermissionDenied => "EACCES".to_owned(),
        _ => e.to_string(),
    }
}
pub(super) fn unpack(buffer: Vec<u8>, dir: PathBuf) -> Result<(), String> {
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let entries =
        read_zip(&buffer, ZipOptions::default()).map_err(|e| format!("not a usable zip: {e}"))?;
    let prefix = entries
        .first()
        .and_then(|entry| entry.name.split_once('/'))
        .map(|(name, _)| format!("{name}/"))
        .filter(|p| {
            entries.iter().all(|e| e.name.starts_with(p))
                && !entries.iter().any(|e| e.name == "plugin.json")
        })
        .unwrap_or_default();
    for entry in entries {
        let relative = &entry.name[prefix.len()..];
        if relative.is_empty() {
            continue;
        }
        let mode = entry.mode.unwrap_or(0);
        if !matches!(mode & 0o170000, 0 | 0o100000) {
            return Err(format!("{} is not a regular file", entry.name));
        }
        let mode = if mode == 0 { 0o644 } else { mode & 0o755 };
        let mut target = dir.clone();
        for part in relative.split('/').filter(|c| !c.is_empty() && *c != ".") {
            if !matches!(
                Path::new(part).components().next(),
                Some(std::path::Component::Normal(_))
            ) {
                return Err(format!("unsafe zip entry name: {}", entry.name));
            }
            target.push(part);
        }
        (|| -> io::Result<()> {
            fs::create_dir_all(target.parent().unwrap())?;
            let mut opts = fs::OpenOptions::new();
            opts.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                opts.mode(mode);
            }
            let mut file = opts.open(&target)?;
            file.write_all(&entry.data)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                file.set_permissions(fs::Permissions::from_mode(mode))?;
            }
            Ok(())
        })()
        .map_err(|e| format!("cannot unpack {}: {}", entry.name, file_error(e)))?;
    }
    Ok(())
}
