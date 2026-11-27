//! 每次 CLI 尝试的私有 home 与可重试的能力脱敏、孤儿回收。
use crate::{codex_home_fs::*, js, state_file};
use regex::Regex;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
};

pub const OWNER_FILE: &str = ".multicc-attempt-owner.json";
const REDACT: &str = "[REDACTED_PROVIDER_ROUTE]";
static CAPABILITY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"pr1\.[A-Za-z0-9_-]{1,344}\.[A-Za-z0-9_-]{1,344}").unwrap());
struct Process {
    nonce: String,
    live: HashSet<PathBuf>,
}
// 覆盖创建、清理、释放的整段文件操作，避免工作线程/多环境交错删除创建中的租约。
static PROCESS: LazyLock<Mutex<Option<Process>>> = LazyLock::new(|| Mutex::new(None));
fn process<'a>() -> Result<std::sync::MutexGuard<'a, Option<Process>>> {
    let mut lock = PROCESS.lock().map_err(|_| {
        Failure::new(
            "CODEX_ATTEMPT_HOME_STATE_FAILED",
            "Codex attempt state poisoned",
        )
    })?;
    if lock.is_none() {
        *lock = Some(Process {
            nonce: random_hex(8)?,
            live: HashSet::new(),
        });
    }
    Ok(lock)
}
fn normalized(value: &str) -> String {
    let text = js::js_trim(value);
    if CAPABILITY
        .find(text)
        .is_some_and(|m| m.start() == 0 && m.end() == text.len())
    {
        text.into()
    } else {
        String::new()
    }
}
fn secrets(capabilities: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for value in capabilities {
        let cap = normalized(value);
        if cap.is_empty() {
            continue;
        }
        let encoded = cap.split('.').nth(2).unwrap().to_owned();
        for s in [cap, encoded.clone()] {
            if seen.insert(s.clone()) {
                out.push(s);
            }
        }
        {
            let bytes = js::node_base64_decode(&js::JsString::from(encoded.as_str()));
            let token = String::from_utf8_lossy(&bytes).into_owned();
            let valid = token
                .strip_prefix("proxy-route-")
                .or_else(|| token.strip_prefix("proxy-route_"))
                .is_some_and(|s| {
                    (8..=256).contains(&s.len())
                        && s.bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
                });
            if valid && seen.insert(token.clone()) {
                out.push(token);
            }
        }
    }
    out.sort_by_key(|s| std::cmp::Reverse(s.len()));
    out
}
fn rollouts(root: &Path) -> Result<Vec<(PathBuf, Version)>> {
    scan(
        root,
        ".jsonl",
        &mut 0,
        Some((
            "CODEX_ATTEMPT_ROLLOUT_ROOT_INVALID",
            "Codex rollout root must be a real directory",
        )),
        (
            "CODEX_ATTEMPT_ROLLOUT_SCAN_LIMIT",
            "Codex rollout scan limit exceeded",
        ),
    )
}
struct Token {
    start: usize,
    end: usize,
    value: js::JsString,
    key: bool,
    ranges: Vec<(usize, usize)>,
}
fn fragments(input: &[u8], secrets: &[String]) -> Option<Vec<u8>> {
    let text = String::from_utf8_lossy(input);
    let bytes = text.as_bytes();
    let mut tokens = vec![];
    let mut cursor = 0;
    while cursor < bytes.len() {
        if bytes[cursor] != b'"' {
            cursor += 1;
            continue;
        }
        let start = cursor;
        cursor += 1;
        while cursor < bytes.len() {
            if bytes[cursor] == b'\\' {
                cursor += 2;
                continue;
            }
            if bytes[cursor] != b'"' {
                cursor += 1;
                continue;
            }
            let end = cursor + 1;
            if let Ok(js::JsValue::String(value)) = js::json_parse(&text[start..end]) {
                let after = js::js_trim(&text[end..]);
                tokens.push(Token {
                    start,
                    end,
                    value,
                    key: after.starts_with(':'),
                    ranges: vec![],
                });
            }
            break;
        }
        cursor += 1;
    }
    for channel in 0..3 {
        let mut combined = Vec::<u16>::new();
        let mut offsets = vec![];
        for (index, t) in tokens.iter().enumerate() {
            if channel == 0 && t.key || channel == 1 && !t.key {
                continue;
            }
            offsets.push((index, combined.len(), t.value.len()));
            combined.extend_from_slice(t.value.as_units());
        }
        for secret in secrets {
            let secret: Vec<u16> = secret.encode_utf16().collect();
            for (at, window) in combined.windows(secret.len()).enumerate() {
                if window != secret.as_slice() {
                    continue;
                }
                let end = at + secret.len();
                for &(index, offset, len) in &offsets {
                    if offset + len <= at || offset >= end {
                        continue;
                    }
                    tokens[index]
                        .ranges
                        .push((at.saturating_sub(offset), len.min(end - offset)));
                }
            }
        }
    }
    if tokens.iter().all(|t| t.ranges.is_empty()) {
        return None;
    }
    let mut out = String::new();
    let mut cursor = 0;
    for t in &mut tokens {
        if t.ranges.is_empty() {
            continue;
        }
        out.push_str(&text[cursor..t.start]);
        t.ranges.sort();
        let mut value = Vec::new();
        let mut at = 0;
        for &(start, end) in &t.ranges {
            if end <= at {
                continue;
            }
            value.extend_from_slice(&t.value.as_units()[at..at.max(start)]);
            value.extend(REDACT.encode_utf16());
            at = end;
        }
        value.extend_from_slice(&t.value.as_units()[at..]);
        out.push_str(
            &js::json_stringify(&js::JsValue::String(js::JsString::from_units(value))).unwrap(),
        );
        cursor = t.end;
    }
    out.push_str(&text[cursor..]);
    Some(out.into_bytes())
}
fn bytes_replace(input: &[u8], needle: &[u8]) -> Option<Vec<u8>> {
    let first = input.windows(needle.len()).position(|s| s == needle)?;
    let mut out = input[..first].to_vec();
    let mut cursor = first;
    while cursor < input.len() {
        if input[cursor..].starts_with(needle) {
            out.extend_from_slice(REDACT.as_bytes());
            cursor += needle.len();
        } else {
            out.push(input[cursor]);
            cursor += 1;
        }
    }
    Some(out)
}
fn assert_version(file: &Path, expected: &Version) -> Result<()> {
    if version(
        file,
        "CODEX_ATTEMPT_ROLLOUT_CHANGED",
        "Codex rollout changed during capability scrub",
    )
    .ok()
    .as_ref()
        == Some(expected)
    {
        return Ok(());
    }
    Err(Failure::new(
        "CODEX_ATTEMPT_ROLLOUT_CHANGED",
        "Codex rollout changed during capability scrub",
    ))
}
fn scrub_file(file: &Path, initial: &Version, secrets: &[String]) -> Result<bool> {
    let input = fs::read(file).map_err(|e| io_error(e, "read", file))?;
    let mut output = input.clone();
    let mut changed = false;
    for secret in secrets {
        if let Some(bytes) = bytes_replace(&output, secret.as_bytes()) {
            output = bytes;
            changed = true;
        }
    }
    if let Some(bytes) = fragments(&output, secrets) {
        output = bytes;
        changed = true;
    }
    if !changed {
        return Ok(false);
    }
    let current = version(
        file,
        "CODEX_ATTEMPT_ROLLOUT_CHANGED",
        "Codex rollout changed during capability scrub",
    )?;
    assert_version(file, initial)?;
    state_file::write_bytes_atomic_traced_before_rename(file, &output, 0o600, 0o700, || {
        assert_version(file, &current)
            .map_err(|_| std::io::Error::other("CODEX_ATTEMPT_ROLLOUT_CHANGED"))
    })
    .map_err(|e| {
        if e.stage == state_file::WriteStage::BeforeRename {
            Failure::new(
                "CODEX_ATTEMPT_ROLLOUT_CHANGED",
                "Codex rollout changed during capability scrub",
            )
        } else {
            io_error(e.error, "write", &e.path)
        }
    })?;
    Ok(true)
}
fn scrub(
    root: &Path,
    capabilities: &[String],
    baseline: Option<&HashMap<PathBuf, Version>>,
    created: f64,
) -> Result<usize> {
    let secrets = secrets(capabilities);
    if secrets.is_empty() {
        return Ok(0);
    }
    let mut count = 0;
    for (file, stat) in rollouts(root)? {
        let changed = match baseline {
            Some(b) => b.get(&file).is_none_or(|v| !v.same_snapshot(&stat)),
            None => stat.mtime >= created.max(0.) - 1000.,
        };
        if changed && scrub_file(&file, &stat, &secrets)? {
            count += 1;
        }
    }
    Ok(count)
}
#[derive(Default)]
struct Owner {
    pid: Option<u32>,
    nonce: String,
    source: PathBuf,
    sessions: PathBuf,
    capability: String,
    created: f64,
}
fn read_owner(home: &Path) -> Option<Owner> {
    let file = home.join(OWNER_FILE);
    let stat = fs::symlink_metadata(&file).ok()?;
    if !stat.is_file() || stat.file_type().is_symlink() {
        return None;
    }
    let owner: Value = crate::json_lenient::from_slice(&fs::read(file).ok()?).ok()?;
    let pid = js::serde::js_to_number(&owner["pid"]);
    let path = |key: &str| {
        owner[key]
            .as_str()
            .filter(|s| Path::new(s).is_absolute())
            .and_then(|s| absolute(Path::new(s)).ok())
            .unwrap_or_default()
    };
    let created = js::serde::js_to_number(&owner["createdAtMs"]);
    let parsed = owner["createdAt"]
        .as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.timestamp_millis() as f64)
        .unwrap_or(0.);
    Some(Owner {
        pid: if pid.is_finite() && pid > 0. && pid.fract() == 0. && pid <= u32::MAX as f64 {
            Some(pid as u32)
        } else {
            None
        },
        nonce: js::serde::value_or_empty(owner.get("processInstanceId")),
        source: path("sourceHome"),
        sessions: path("sessionsDir"),
        capability: normalized(owner["encodedCapability"].as_str().unwrap_or("")),
        created: if created.is_finite() && created > 0. {
            created
        } else {
            parsed
        },
    })
}
fn alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        if pid > i32::MAX as u32 {
            return false;
        }
        unsafe {
            libc::kill(pid as i32, 0) == 0
                || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
        }
    }
    #[cfg(windows)]
    {
        // 无需额外依赖；仅请求有限查询权限。
        #[link(name = "kernel32")]
        extern "system" {
            fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
            fn CloseHandle(h: *mut std::ffi::c_void) -> i32;
            fn GetExitCodeProcess(h: *mut std::ffi::c_void, code: *mut u32) -> i32;
            fn GetLastError() -> u32;
        }
        unsafe {
            let h = OpenProcess(0x1000, 0, pid);
            if h.is_null() {
                return GetLastError() == 5;
            }
            let mut code = 0;
            let ok = GetExitCodeProcess(h, &mut code);
            CloseHandle(h);
            ok != 0 && code == 259
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = pid;
        true
    }
}
fn live(home: &Path, name: &str, state: &Process) -> bool {
    if !fs::symlink_metadata(home).is_ok_and(|s| s.is_dir() && !s.file_type().is_symlink()) {
        return false;
    }
    let owner = read_owner(home);
    let pid = match &owner {
        Some(o) => o.pid,
        None => name
            .strip_prefix('p')
            .and_then(|s| s.split_once('-'))
            .and_then(|(p, _)| p.parse::<u32>().ok())
            .filter(|p| *p > 0),
    };
    let Some(pid) = pid else {
        return false;
    };
    if pid != std::process::id() {
        return alive(pid);
    }
    match owner {
        Some(o) => o.nonce == state.nonce && state.live.contains(home),
        None => true,
    }
}
fn orphan(home: &Path) -> Result<usize> {
    let owner = read_owner(home);
    let mut caps = vec![];
    if let Some(o) = &owner {
        if !o.capability.is_empty() {
            caps.push(o.capability.clone());
        }
    }
    let config = home.join("config.toml");
    if fs::symlink_metadata(&config)
        .is_ok_and(|m| m.is_file() && !m.file_type().is_symlink() && m.len() <= 2 * 1024 * 1024)
    {
        if let Ok(bytes) = fs::read(&config) {
            for m in CAPABILITY.find_iter(&String::from_utf8_lossy(&bytes)) {
                caps.push(m.as_str().into());
            }
        }
    }
    if caps.is_empty() {
        return Ok(0);
    }
    let linked = home.join("sessions");
    let target = if fs::symlink_metadata(&linked).is_ok_and(|m| m.file_type().is_symlink()) {
        fs::canonicalize(&linked).ok()
    } else {
        None
    };
    let owned = owner.as_ref().and_then(|o| {
        if !o.sessions.as_os_str().is_empty() {
            Some(o.sessions.clone())
        } else if !o.source.as_os_str().is_empty() {
            Some(o.source.join("sessions"))
        } else {
            None
        }
    });
    let sessions = match owned {
        Some(p) if p.starts_with(home) => None,
        Some(p) if target.is_some() && p.exists() && fs::canonicalize(&p).ok() != target => None,
        Some(p) => Some(p),
        None => target,
    }
    .ok_or_else(|| {
        Failure::new(
            "CODEX_ATTEMPT_HOME_ORPHAN_UNRESOLVED",
            "Codex orphan capability rollout root is unresolved",
        )
    })?;
    let created = owner
        .as_ref()
        .filter(|o| o.created > 0.)
        .map(|o| o.created)
        .unwrap_or_else(|| {
            fs::symlink_metadata(home)
                .ok()
                .map(|s| {
                    s.created()
                        .map(millis)
                        .ok()
                        .filter(|n| *n > 0.)
                        .unwrap_or_else(|| {
                            Version::of(home, &s)
                                .map(|v| v.ctime.min(v.mtime))
                                .unwrap_or(0.)
                        })
                })
                .unwrap_or(0.)
        });
    scrub(&sessions, &caps, None, created)
}
fn check_root(root: &Path) -> Result<()> {
    if root.parent().is_none() {
        return Err(Failure::new(
            "CODEX_ATTEMPT_HOME_PATH_INVALID",
            "Codex attempt homes directory is unsafe",
        ));
    }
    real_private_dir(
        root,
        "CODEX_ATTEMPT_HOME_PATH_INVALID",
        "Codex attempt homes directory must be a real directory",
    )
}
fn cleanup_inner(root: &Path, state: &Process) -> Result<Value> {
    check_root(root)?;
    let mut removed = 0;
    let mut retained = 0;
    let mut scrubbed = 0;
    let mut entries = fs::read_dir(root)
        .map_err(|e| io_error(e, "scandir", root))?
        .collect::<std::io::Result<Vec<_>>>()
        .map_err(|e| io_error(e, "scandir", root))?;
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let path = e.path();
        if live(&path, &e.file_name().to_string_lossy(), state) {
            retained += 1;
            continue;
        }
        let result = (|| {
            let m = fs::symlink_metadata(&path).map_err(|e| io_error(e, "lstat", &path))?;
            if m.is_dir() && !m.file_type().is_symlink() {
                scrubbed += orphan(&path)?;
                remove(&path, true)?;
            } else {
                remove(&path, false)?;
            }
            Ok(())
        })();
        match result {
            Ok(()) => removed += 1,
            Err(e) if e.code == "ENOENT" => {}
            Err(e) => return Err(e),
        }
    }
    Ok(json!({"removed":removed,"retained":retained,"scrubbed":scrubbed}))
}
fn cleanup_locked(root: &Path, state: &Process) -> Result<Value> {
    cleanup_inner(root, state).map_err(|e| {
        if e.code == "CODEX_ATTEMPT_HOME_PATH_INVALID"
            || e.code == "CODEX_ATTEMPT_HOME_CLEANUP_FAILED"
        {
            e
        } else {
            Failure::wrap(
                "CODEX_ATTEMPT_HOME_CLEANUP_FAILED",
                "Codex attempt home cleanup failed",
                e,
            )
        }
    })
}
pub fn cleanup(root: &Path) -> Result<Value> {
    let state = process()?;
    cleanup_locked(root, state.as_ref().unwrap())
}
pub struct Lease {
    pub home: PathBuf,
    pub source: PathBuf,
    pub sessions: PathBuf,
    capability: String,
    baseline: HashMap<PathBuf, Version>,
    created: f64,
    released: bool,
}
impl Lease {
    fn release_locked(&mut self, state: &mut Process) -> Result<bool> {
        if self.released {
            return Ok(false);
        }
        state.live.remove(&self.home);
        (|| {
            scrub(
                &self.sessions,
                std::slice::from_ref(&self.capability),
                Some(&self.baseline),
                self.created,
            )?;
            remove(&self.home, true)?;
            if self.home.exists() {
                return Err(Failure::new(
                    "CODEX_HOME_REMOVE_FAILED",
                    "Codex attempt home could not be removed",
                ));
            }
            self.released = true;
            Ok(true)
        })()
        .map_err(|e| {
            Failure::wrap(
                "CODEX_ATTEMPT_HOME_RELEASE_FAILED",
                "Codex attempt capability cleanup failed",
                e,
            )
        })
    }
    pub fn release(&mut self) -> Result<bool> {
        let mut state = process()?;
        self.release_locked(state.as_mut().unwrap())
    }
}
fn copy_private(source: &Path, dest: &Path, required: bool) -> Result<()> {
    if !source.exists() {
        return if required {
            Err(Failure::new(
                "CODEX_ATTEMPT_HOME_SOURCE_INVALID",
                format!(
                    "Codex attempt source is missing {}",
                    source.file_name().unwrap_or_default().to_string_lossy()
                ),
            ))
        } else {
            Ok(())
        };
    }
    fs::copy(source, dest).map_err(|e| io_error(e, "copyfile", source))?;
    mode(dest, 0o600)
}
fn link(source: &Path, dest: &Path) -> Result<()> {
    let target = fs::canonicalize(source).map_err(|e| io_error(e, "realpath", source))?;
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&target, dest).map_err(|e| io_error(e, "symlink", dest))?;
    }
    #[cfg(windows)]
    {
        // Node 的 dir junction 不要求开发者模式。
        crate::codex_home_fs::junction(&target, dest)?;
    }
    Ok(())
}
pub struct Create {
    pub source: PathBuf,
    pub homes: PathBuf,
    pub sessions: Option<PathBuf>,
    pub session: String,
    pub provider: String,
    pub config_required: bool,
    pub copy_auth: bool,
}
pub fn create(input: Create) -> Result<Lease> {
    if input.source.starts_with(&input.homes) {
        return Err(Failure::new(
            "CODEX_ATTEMPT_HOME_PATH_INVALID",
            "Codex provider home must be outside the attempt overlay directory",
        ));
    }
    let mut lock = process()?;
    let state = lock.as_mut().unwrap();
    cleanup_locked(&input.homes, state)?;
    let created = now_ms();
    let sessions = input
        .sessions
        .unwrap_or_else(|| input.source.join("sessions"));
    if sessions.starts_with(&input.homes) {
        return Err(Failure::new(
            "CODEX_ATTEMPT_HOME_PATH_INVALID",
            "Codex sessions directory must be outside the attempt overlay directory",
        ));
    }
    private_dir(&sessions)?;
    let baseline = rollouts(&sessions)?.into_iter().collect();
    let home = loop {
        let p = input.homes.join(format!(
            "p{}-{}-{}-{}-{}",
            std::process::id(),
            state.nonce,
            prefix(&input.provider, false, "provider"),
            fingerprint(&input.session, 16),
            random_hex(6)?
        ));
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        match builder.create(&p) {
            Ok(()) => break p,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(io_error(e, "mkdtemp", &p)),
        }
    };
    private_dir(&home)?;
    state.live.insert(home.clone());
    let mut lease = Lease {
        home,
        source: input.source,
        sessions,
        capability: input.session,
        baseline,
        created,
        released: false,
    };
    let result = (|| {
        let file = lease.home.join(OWNER_FILE);
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut handle = options
            .open(&file)
            .map_err(|e| io_error(e, "open", &file))?;
        let owner = json!({"pid":std::process::id(),"processInstanceId":state.nonce,"sourceHome":path_value(&lease.source),"sessionsDir":path_value(&lease.sessions),
            "encodedCapability":normalized(&lease.capability),"createdAt":js::date_to_iso_string(created),"createdAtMs":created});
        handle
            .write_all(owner.to_string().as_bytes())
            .map_err(|e| io_error(e, "write", &file))?;
        drop(handle);
        mode(&file, 0o600)?;
        copy_private(
            &lease.source.join("config.toml"),
            &lease.home.join("config.toml"),
            input.config_required,
        )?;
        if input.copy_auth {
            copy_private(
                &lease.source.join("auth.json"),
                &lease.home.join("auth.json"),
                false,
            )?;
        }
        copy_private(
            &lease.source.join("AGENTS.md"),
            &lease.home.join("AGENTS.md"),
            false,
        )?;
        private_dir(&lease.home.join("agents"))?;
        link(&lease.sessions, &lease.home.join("sessions"))?;
        for name in ["skills", "rules", "memories"] {
            let src = lease.source.join(name);
            if src.exists() {
                link(&src, &lease.home.join(name))?;
            }
        }
        Ok(())
    })();
    if let Err(e) = result {
        lease.release_locked(state)?;
        return Err(e);
    }
    Ok(lease)
}
