use super::scrub::{self, Baseline};
use super::*;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    io::Write,
    sync::{Mutex, OnceLock},
};

pub const OWNER: &str = ".multicc-attempt-owner.json";
static NONCE: OnceLock<String> = OnceLock::new();
static LIVE: Mutex<Option<HashSet<PathBuf>>> = Mutex::new(None);
fn nonce() -> Result<&'static str> {
    if let Some(n) = NONCE.get() {
        return Ok(n);
    }
    let _ = NONCE.set(random_hex::<8>()?);
    Ok(NONCE.get().unwrap())
}
fn pid_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        pid <= i32::MAX as u32
            && (unsafe { libc::kill(pid as i32, 0) } == 0
                || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM))
    }
    #[cfg(windows)]
    {
        #[link(name = "kernel32")]
        extern "system" {
            fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
            fn GetExitCodeProcess(handle: *mut std::ffi::c_void, status: *mut u32) -> i32;
            fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
        }
        unsafe {
            let handle = OpenProcess(0x1000, 0, pid);
            if handle.is_null() {
                return io::Error::last_os_error().raw_os_error() == Some(5);
            }
            let mut status = 0;
            let alive = GetExitCodeProcess(handle, &mut status) != 0 && status == 259;
            CloseHandle(handle);
            alive
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        false
    }
}
fn owner(p: &Path) -> Option<Value> {
    let file = p.join(OWNER);
    let input = read_file(&file).ok()?;
    let v: Value = serde_json::from_reader(input).ok()?;
    v.is_object().then_some(v)
}
fn pid(v: &Value) -> Option<u32> {
    let n = v.as_f64().or_else(|| v.as_str()?.parse().ok())?;
    (n.fract() == 0. && n > 0. && n <= u32::MAX as f64).then_some(n as u32)
}
fn is_live(p: &Path, v: Option<&Value>, live: &HashSet<PathBuf>) -> Result<bool> {
    let id = match v {
        Some(o) => pid(&o["pid"]),
        None => p
            .file_name()
            .and_then(|s| s.to_str())
            .and_then(|s| s.strip_prefix('p'))
            .and_then(|s| s.split_once('-'))
            .filter(|(s, _)| !s.starts_with('0'))
            .and_then(|(s, _)| s.parse::<u32>().ok()),
    };
    Ok(match id {
        Some(id) if id == std::process::id() => match v {
            Some(o) => o["processInstanceId"].as_str() == Some(nonce()?) && live.contains(p),
            None => true,
        },
        Some(id) => pid_alive(id),
        None => false,
    })
}
fn directory_timestamp(path: &Path) -> Option<f64> {
    let meta = fs::symlink_metadata(path).ok()?;
    if let Some(birth) = meta.created().ok().map(time_ms).filter(|v| *v > 0.) {
        return Some(birth);
    }
    let modified = meta
        .modified()
        .ok()
        .map(time_ms)
        .filter(|v| *v > 0.)
        .unwrap_or(f64::INFINITY);
    #[cfg(unix)]
    let changed = {
        use std::os::unix::fs::MetadataExt;
        let ms = meta.ctime() as f64 * 1000. + meta.ctime_nsec() as f64 / 1_000_000.;
        if ms > 0. {
            ms
        } else {
            f64::INFINITY
        }
    };
    #[cfg(not(unix))]
    let changed = f64::INFINITY;
    Some(modified.min(changed))
}

fn orphan(p: &Path, v: Option<&Value>) -> Result<usize> {
    let empty = Value::Null;
    let v = v.unwrap_or(&empty);
    let mut caps = vec![v["encodedCapability"].as_str().unwrap_or("").to_string()];
    if let Ok(mut f) = read_file(&p.join("config.toml")) {
        if f.metadata()?.len() <= 2 * 1024 * 1024 {
            let mut bytes = vec![];
            use std::io::Read;
            f.read_to_end(&mut bytes)?;
            caps.extend(
                scrub::CAP
                    .find_iter(&String::from_utf8_lossy(&bytes))
                    .map(|m| m.as_str().to_owned()),
            )
        }
    }
    if caps.iter().all(|s| scrub::capability(s).is_empty()) {
        return Ok(0);
    }
    let linked = p.join("sessions");
    let link = fs::symlink_metadata(&linked)
        .ok()
        .filter(is_link)
        .and_then(|_| linked.canonicalize().ok());
    let owned = |key: &str| {
        v[key]
            .as_str()
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
    };
    let selected = if let Some(stored) =
        owned("sessionsDir").or_else(|| owned("sourceHome").map(|p| p.join("sessions")))
    {
        // Normalize components before checking that a persisted marker is outside its overlay.
        let mut normalized = PathBuf::new();
        for c in stored.components() {
            match c {
                std::path::Component::ParentDir => {
                    normalized.pop();
                }
                std::path::Component::CurDir => (),
                other => normalized.push(other.as_os_str()),
            }
        }
        if normalized.starts_with(p)
            || link.as_ref().is_some_and(|s| {
                normalized.exists() && normalized.canonicalize().ok().as_ref() != Some(s)
            })
        {
            None
        } else {
            Some(normalized)
        }
    } else {
        link
    };
    let attempt_real = p.canonicalize()?;
    let dir = selected
        .filter(|target| {
            // An old marker may spell the root through a parent alias. It must
            // never make the overlay's own contents the authority for a scrub.
            !target.starts_with(p)
                && !target
                    .canonicalize()
                    .is_ok_and(|real| real.starts_with(&attempt_real))
        })
        .ok_or_else(|| {
            Error::new(
                "CODEX_ATTEMPT_HOME_ORPHAN_UNRESOLVED",
                "Codex orphan capability rollout root is unresolved",
            )
        })?;
    let timestamp = v["createdAtMs"]
        .as_f64()
        .or_else(|| v["createdAtMs"].as_str()?.parse().ok())
        .filter(|n| n.is_finite() && *n > 0.)
        .or_else(|| {
            chrono::DateTime::parse_from_rfc3339(v["createdAt"].as_str()?)
                .ok()
                .map(|d| d.timestamp_millis() as f64)
        })
        .or_else(|| directory_timestamp(p))
        .unwrap_or(0.);
    scrub::changed_rollouts(&dir, &caps, None, timestamp)
}
fn cleanup_locked(root: &Path, live: &HashSet<PathBuf>) -> Result<Value> {
    if root.parent().is_none() {
        return Err(Error::new(
            "CODEX_ATTEMPT_HOME_PATH_INVALID",
            "Codex attempt homes directory is unsafe",
        ));
    }
    let run = (|| {
        checked_dir(
            root,
            "CODEX_ATTEMPT_HOME_PATH_INVALID",
            "Codex attempt homes directory must be a real directory",
        )?;
        let (mut removed, mut retained, mut scrubbed) = (0, 0, 0);
        for entry in fs::read_dir(root)? {
            let e = entry?;
            let dir = e.path();
            let result: Result<()> = (|| {
                let stat = fs::symlink_metadata(&dir)?;
                if stat.is_dir() && !is_link(&stat) {
                    let o = owner(&dir);
                    if is_live(&dir, o.as_ref(), live)? {
                        retained += 1;
                        return Ok(());
                    }
                    scrubbed += orphan(&dir, o.as_ref())?;
                    fs::remove_dir_all(&dir)?;
                } else {
                    unlink(&dir, &stat)?
                }
                removed += 1;
                Ok(())
            })();
            match result {
                Err(e) if e.code == "ENOENT" => (),
                r => r?,
            }
        }
        Ok(json!({"removed":removed,"retained":retained,"scrubbed":scrubbed}))
    })();
    run.map_err(|e: Error| {
        if e.code == "CODEX_ATTEMPT_HOME_PATH_INVALID" {
            e
        } else {
            Error::caused(
                "CODEX_ATTEMPT_HOME_CLEANUP_FAILED",
                "Codex attempt home cleanup failed",
                e,
            )
        }
    })
}
pub fn cleanup(root: &Path) -> Result<Value> {
    let mut live = LIVE.lock().unwrap_or_else(|e| e.into_inner());
    cleanup_locked(root, live.get_or_insert_with(HashSet::new))
}
#[cfg(unix)]
fn directory_link(target: &Path, link: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}
#[cfg(windows)]
fn directory_link(target: &Path, link: &Path) -> io::Result<()> {
    super::junction::create(target, link)
}
pub struct Lease {
    pub home: PathBuf,
    pub source: PathBuf,
    pub sessions: PathBuf,
    baseline: Baseline,
    cap: String,
    created: f64,
    released: bool,
}
impl Lease {
    fn release_locked(&mut self, live: &mut HashSet<PathBuf>) -> Result<bool> {
        if self.released {
            return Ok(false);
        }
        live.remove(&self.home);
        let result = (|| {
            scrub::changed_rollouts(
                &self.sessions,
                std::slice::from_ref(&self.cap),
                Some(&self.baseline),
                self.created,
            )?;
            match fs::remove_dir_all(&self.home) {
                Err(e) if e.kind() == io::ErrorKind::NotFound => (),
                other => other?,
            }
            if self.home.exists() {
                return Err(Error::new("EIO", "Codex attempt home could not be removed"));
            }
            self.released = true;
            Ok(true)
        })();
        result.map_err(|e| {
            Error::caused(
                "CODEX_ATTEMPT_HOME_RELEASE_FAILED",
                "Codex attempt capability cleanup failed",
                e,
            )
        })
    }
    pub fn release(&mut self) -> Result<bool> {
        let mut live = LIVE.lock().unwrap_or_else(|e| e.into_inner());
        self.release_locked(live.get_or_insert_with(HashSet::new))
    }
}
pub fn create(
    root: &Path,
    source: &Path,
    session: &str,
    provider: &str,
    sessions: PathBuf,
    config_required: bool,
    copy_auth: bool,
) -> Result<Lease> {
    if source.starts_with(root) {
        return Err(Error::new(
            "CODEX_ATTEMPT_HOME_PATH_INVALID",
            "Codex provider home must be outside the attempt overlay directory",
        ));
    }
    let mut guard = LIVE.lock().unwrap_or_else(|e| e.into_inner());
    let live = guard.get_or_insert_with(HashSet::new);
    cleanup_locked(root, live)?;
    let created = now_ms();
    if sessions.starts_with(root) {
        return Err(Error::new(
            "CODEX_ATTEMPT_HOME_PATH_INVALID",
            "Codex sessions directory must be outside the attempt overlay directory",
        ));
    }
    private_dir(&sessions)?;
    let baseline = scrub::snapshot(&sessions)?;
    let name = format!(
        "p{}-{}-{}-{}-{}",
        std::process::id(),
        nonce()?,
        prefix(provider, false, "provider"),
        fingerprint(session, 16),
        random_hex::<8>()?
    );
    let home = root.join(name);
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(&home)?;
    live.insert(home.clone());
    let mut lease = Lease {
        home,
        source: source.to_owned(),
        sessions,
        baseline,
        created,
        cap: scrub::capability(session).to_owned(),
        released: false,
    };
    let result = (|| {
        let marker = lease.home.join(OWNER);
        let mut out = exclusive(&marker)?;
        let timestamp = chrono::DateTime::from_timestamp_millis(created as i64)
            .ok_or_else(|| Error::new("EINVAL", "invalid attempt creation time"))?;
        let details = json!({
            "pid": std::process::id(),
            "processInstanceId": nonce()?,
            "sourceHome": source,
            "sessionsDir": lease.sessions,
            "encodedCapability": lease.cap,
            "createdAt": timestamp.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            "createdAtMs": created.floor(),
        });
        out.write_all(details.to_string().as_bytes())?;
        mode(&marker, 0o600)?;
        for (name, required) in [
            ("config.toml", config_required),
            ("auth.json", false),
            ("AGENTS.md", false),
        ] {
            if name == "auth.json" && !copy_auth {
                continue;
            }
            let src = source.join(name);
            if !src.exists() {
                if required {
                    return Err(Error::new(
                        "CODEX_ATTEMPT_HOME_SOURCE_INVALID",
                        format!("Codex attempt source is missing {name}"),
                    ));
                }
                continue;
            }
            let dest = lease.home.join(name);
            let mut out = exclusive(&dest)?;
            io::copy(&mut fs::File::open(src)?, &mut out)?;
            mode(&dest, 0o600)?;
        }
        private_dir(&lease.home.join("agents"))?;
        directory_link(
            &lease.sessions.canonicalize()?,
            &lease.home.join("sessions"),
        )?;
        for name in ["skills", "rules", "memories"] {
            let src = source.join(name);
            if src.exists() {
                directory_link(&src.canonicalize()?, &lease.home.join(name))?
            }
        }
        Ok(())
    })();
    if let Err(e) = result {
        lease.release_locked(live)?;
        return Err(e);
    }
    Ok(lease)
}
