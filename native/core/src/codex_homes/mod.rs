//! Private per-attempt overlays and persistent logical conversation histories.
pub mod attempt;
mod history_file;
mod scrub;
pub mod session;

use sha2::{Digest, Sha256};
use std::{
    fs, io,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub const MAX_ENTRIES: usize = 100_000;
pub type Result<T> = std::result::Result<T, Error>;
#[derive(Debug)]
pub struct Error {
    pub code: String,
    pub message: String,
    pub sources: Vec<PathBuf>,
    pub cause: Option<Box<Error>>,
}
impl Error {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            sources: vec![],
            cause: None,
        }
    }
    fn caused(code: &str, message: &str, cause: Error) -> Self {
        Self {
            cause: Some(Box::new(cause)),
            ..Self::new(code, message)
        }
    }
}
impl From<io::Error> for Error {
    fn from(error: io::Error) -> Self {
        let code = match error.kind() {
            io::ErrorKind::NotFound => "ENOENT",
            io::ErrorKind::PermissionDenied => "EACCES",
            io::ErrorKind::AlreadyExists => "EEXIST",
            io::ErrorKind::NotADirectory => "ENOTDIR",
            io::ErrorKind::IsADirectory => "EISDIR",
            io::ErrorKind::InvalidInput => "EINVAL",
            _ => "EIO",
        };
        Self::new(code, error.to_string())
    }
}
pub fn random_hex<const N: usize>() -> io::Result<String> {
    let mut bytes = [0; N];
    getrandom::fill(&mut bytes).map_err(|e| io::Error::other(e.to_string()))?;
    Ok(bytes.iter().map(|n| format!("{n:02x}")).collect())
}
fn prefix(id: &str, trim: bool, default: &str) -> String {
    let mut text = String::new();
    let mut in_invalid = false;
    for c in id.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() || "._-".contains(c) {
            text.push(c);
            in_invalid = false
        } else if !in_invalid {
            text.push('-');
            in_invalid = true
        }
    }
    let s = if trim { text.trim_matches('-') } else { &text };
    if s.is_empty() {
        default.into()
    } else {
        s.chars().take(48).collect()
    }
}
fn fingerprint(s: &str, n: usize) -> String {
    format!("{:x}", Sha256::digest(s.as_bytes()))[..n].to_owned()
}
pub fn mode(path: &Path, bits: u32) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(bits))
    }
    #[cfg(not(unix))]
    {
        let mut perms = fs::metadata(path)?.permissions();
        perms.set_readonly(bits & 0o200 == 0);
        fs::set_permissions(path, perms)
    }
}
pub fn private_dir(path: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)?;
    mode(path, 0o700)
}
fn is_link(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const REPARSE_POINT: u32 = 0x400;
        meta.file_attributes() & REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        meta.is_symlink()
    }
}

fn unlink(path: &Path, meta: &fs::Metadata) -> io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const DIRECTORY: u32 = 0x10;
        if is_link(meta) && meta.file_attributes() & DIRECTORY != 0 {
            return fs::remove_dir(path);
        }
    }
    #[cfg(not(windows))]
    let _ = meta;
    fs::remove_file(path)
}

fn checked_dir(path: &Path, code: &str, msg: &str) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(m) if !m.is_dir() || is_link(&m) => return Err(Error::new(code, msg)),
        Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e.into()),
        _ => (),
    }
    Ok(private_dir(path)?)
}
pub fn now_ms() -> f64 {
    time_ms(SystemTime::now())
}
fn time_ms(t: SystemTime) -> f64 {
    match t.duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_secs_f64() * 1000.,
        Err(e) => -e.duration().as_secs_f64() * 1000.,
    }
}
#[derive(Clone, Debug, PartialEq)]
struct Version {
    size: u64,
    mtime: SystemTime,
    #[cfg(unix)]
    identity: (u64, u64),
    #[cfg(unix)]
    ctime: (i64, i64),
    #[cfg(not(unix))]
    created: Option<SystemTime>,
}
impl Version {
    fn from_metadata(m: &cap_std::fs::Metadata) -> io::Result<Self> {
        #[cfg(unix)]
        use cap_std::fs::MetadataExt;
        Ok(Self {
            size: m.len(),
            mtime: m.modified()?.into_std(),
            #[cfg(unix)]
            identity: (m.dev(), m.ino()),
            #[cfg(unix)]
            ctime: (m.ctime(), m.ctime_nsec()),
            #[cfg(not(unix))]
            created: m.created().ok().map(|t| t.into_std()),
        })
    }
    fn same_baseline(&self, b: &Self) -> bool {
        #[cfg(unix)]
        if self.identity != b.identity {
            return false;
        }
        self.size == b.size && self.mtime == b.mtime
    }
}
fn scan(root: &Path, suffix: &str, inspected: &mut usize, attempt: bool) -> Result<Vec<PathBuf>> {
    let meta = match fs::symlink_metadata(root) {
        Ok(m) => m,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e.into()),
    };
    if !meta.is_dir() || is_link(&meta) {
        if attempt {
            return Err(Error::new(
                "CODEX_ATTEMPT_ROLLOUT_ROOT_INVALID",
                "Codex rollout root must be a real directory",
            ));
        }
        return Ok(vec![]);
    }
    let anchor = history_file::root(root)?;
    let mut stack = vec![PathBuf::new()];
    let mut files = Vec::new();
    while let Some(relative) = stack.pop() {
        let directory = match history_file::descend(&anchor, &relative, false) {
            Ok(d) => d,
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e.into()),
        };
        let mut entries = Vec::new();
        for entry in directory.entries()? {
            let entry = entry?;
            *inspected += 1;
            if *inspected > MAX_ENTRIES {
                return Err(if attempt {
                    Error::new(
                        "CODEX_ATTEMPT_ROLLOUT_SCAN_LIMIT",
                        "Codex rollout scan limit exceeded",
                    )
                } else {
                    Error::new(
                        "CODEX_SESSION_ROLLOUT_SCAN_LIMIT",
                        "Codex legacy rollout scan limit exceeded",
                    )
                });
            }
            entries.push((entry.file_name(), entry.file_type()?));
        }
        entries.sort_by(|(a, _), (b, _)| a.cmp(b));
        for (name, kind) in entries {
            if kind.is_dir() {
                stack.push(relative.join(name));
            } else if kind.is_file() && name.to_string_lossy().ends_with(suffix) {
                files.push(root.join(&relative).join(name));
            }
        }
    }
    Ok(files)
}
fn exclusive(path: &Path) -> io::Result<fs::File> {
    let mut opt = fs::OpenOptions::new();
    opt.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opt.mode(0o600);
    }
    opt.open(path)
}
fn read_file(path: &Path) -> io::Result<fs::File> {
    let mut opts = fs::OpenOptions::new();
    opts.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const OPEN_REPARSE_POINT: u32 = 0x00200000;
        opts.custom_flags(OPEN_REPARSE_POINT);
    }
    let file = opts.open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file() || is_link(&meta) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "rollout must be a regular file",
        ));
    }
    Ok(file)
}

#[cfg(windows)]
mod junction;
