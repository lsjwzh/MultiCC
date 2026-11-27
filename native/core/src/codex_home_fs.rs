//! Codex home 文件操作的同步契约；异步调用方可在工作线程复用。
use serde_json::{json, Value};
use std::{
    fs, io,
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Debug)]
pub struct Failure {
    pub code: String,
    pub message: String,
    pub cause: Option<Box<Failure>>,
    pub sources: Option<Vec<PathBuf>>,
    pub io: Option<io::Error>,
    pub syscall: &'static str,
    pub path: Option<PathBuf>,
}
pub type Result<T> = std::result::Result<T, Failure>;
impl Failure {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            cause: None,
            sources: None,
            io: None,
            syscall: "",
            path: None,
        }
    }
    pub fn wrap(code: &str, message: &str, cause: Self) -> Self {
        let mut out = Self::new(code, message);
        out.cause = Some(Box::new(cause));
        out
    }
}
pub fn io_error(error: io::Error, syscall: &'static str, path: &Path) -> Failure {
    let code = match error.kind() {
        io::ErrorKind::NotFound => "ENOENT",
        io::ErrorKind::AlreadyExists => "EEXIST",
        io::ErrorKind::PermissionDenied => "EACCES",
        io::ErrorKind::NotADirectory => "ENOTDIR",
        io::ErrorKind::IsADirectory => "EISDIR",
        _ => "CODEX_HOME_IO",
    };
    let mut out = Failure::new(code, error.to_string());
    out.io = Some(error);
    out.syscall = syscall;
    out.path = Some(path.into());
    out
}
pub fn absolute(path: &Path) -> Result<PathBuf> {
    let path = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()
            .map_err(|e| io_error(e, "cwd", path))?
            .join(path)
    };
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            _ => out.push(part.as_os_str()),
        }
    }
    Ok(out)
}
pub fn mode(path: &Path, bits: u32) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(bits))
            .map_err(|e| io_error(e, "chmod", path))?;
    }
    #[cfg(not(unix))]
    {
        let mut permissions = fs::metadata(path)
            .map_err(|e| io_error(e, "chmod", path))?
            .permissions();
        permissions.set_readonly(bits & 0o200 == 0);
        fs::set_permissions(path, permissions).map_err(|e| io_error(e, "chmod", path))?;
    }
    Ok(())
}
pub fn private_dir(path: &Path) -> Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(path)
        .map_err(|e| io_error(e, "mkdir", path))?;
    mode(path, 0o700)
}
pub fn real_private_dir(path: &Path, code: &str, message: &str) -> Result<()> {
    if path.exists() {
        let stat = fs::symlink_metadata(path).map_err(|e| io_error(e, "lstat", path))?;
        if !stat.is_dir() || stat.file_type().is_symlink() {
            return Err(Failure::new(code, message));
        }
    }
    private_dir(path)
}
pub fn random_hex(bytes: usize) -> Result<String> {
    let mut data = vec![0; bytes];
    getrandom::fill(&mut data)
        .map_err(|_| Failure::new("CODEX_HOME_RANDOM_FAILED", "系统随机数不可用"))?;
    Ok(data.iter().map(|b| format!("{b:02x}")).collect())
}
pub fn now_ms() -> f64 {
    millis(SystemTime::now())
}
pub fn millis(t: SystemTime) -> f64 {
    match t.duration_since(UNIX_EPOCH) {
        Ok(t) => t.as_secs_f64() * 1000.,
        Err(e) => -e.duration().as_secs_f64() * 1000.,
    }
}
pub fn identity(value: &str, label: &str, code: &str) -> Result<String> {
    let value = crate::js::js_trim(value);
    if value.is_empty()
        || value.encode_utf16().count() > 512
        || value.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
    {
        return Err(Failure::new(code, format!("{label} is required")));
    }
    Ok(value.into())
}
pub fn prefix(value: &str, trim: bool, fallback: &str) -> String {
    let mut out = String::new();
    let mut invalid = false;
    for c in value.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() || "._-".contains(c) {
            out.push(c);
            invalid = false;
        } else if !invalid {
            out.push('-');
            invalid = true;
        }
    }
    let out = if trim { out.trim_matches('-') } else { &out };
    let out: String = out.chars().take(48).collect();
    if out.is_empty() {
        fallback.into()
    } else {
        out
    }
}
pub fn fingerprint(value: &str, count: usize) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(value.as_bytes()))[..count].into()
}
#[derive(Clone, Debug, PartialEq)]
pub struct Version {
    pub dev: u64,
    pub ino: u64,
    pub size: u64,
    pub mtime: f64,
    pub ctime: f64,
}
impl Version {
    pub fn of(path: &Path, m: &fs::Metadata) -> Result<Self> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let _ = path;
            Ok(Self {
                dev: m.dev(),
                ino: m.ino(),
                size: m.len(),
                mtime: m.mtime() as f64 * 1000. + m.mtime_nsec() as f64 / 1e6,
                ctime: m.ctime() as f64 * 1000. + m.ctime_nsec() as f64 / 1e6,
            })
        }
        #[cfg(windows)]
        {
            windows_version(path, m)
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = path;
            Ok(Self {
                dev: 0,
                ino: 0,
                size: m.len(),
                mtime: m.modified().map(millis).unwrap_or(0.),
                ctime: 0.,
            })
        }
    }
    pub fn same_snapshot(&self, other: &Self) -> bool {
        self.dev == other.dev
            && self.ino == other.ino
            && self.size == other.size
            && self.mtime == other.mtime
    }
}
pub fn version(path: &Path, code: &str, message: &str) -> Result<Version> {
    let m = fs::symlink_metadata(path).map_err(|e| io_error(e, "lstat", path))?;
    if !m.is_file() || m.file_type().is_symlink() {
        return Err(Failure::new(code, message));
    }
    Version::of(path, &m)
}
/// 稳定 Rust 的 MetadataExt 不提供 ChangeTime；不能用 CreationTime 代替 ctime。
#[cfg(windows)]
fn windows_version(path: &Path, _metadata: &fs::Metadata) -> Result<Version> {
    use std::ffi::c_void;
    use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
    #[repr(C)]
    #[derive(Default)]
    struct Basic {
        created: i64,
        accessed: i64,
        modified: i64,
        changed: i64,
        attributes: u32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct Info {
        attributes: u32,
        created: [u32; 2],
        accessed: [u32; 2],
        modified: [u32; 2],
        volume: u32,
        size_high: u32,
        size_low: u32,
        links: u32,
        index_high: u32,
        index_low: u32,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetFileInformationByHandle(handle: *mut c_void, info: *mut Info) -> i32;
        fn GetFileInformationByHandleEx(
            handle: *mut c_void,
            class: i32,
            info: *mut c_void,
            size: u32,
        ) -> i32;
    }
    let file = fs::OpenOptions::new()
        .access_mode(0x80)
        .share_mode(7)
        .custom_flags(0x02000000 | 0x00200000)
        .open(path)
        .map_err(|e| io_error(e, "lstat", path))?;
    let mut info = Info::default();
    let mut basic = Basic::default();
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(io_error(io::Error::last_os_error(), "lstat", path));
    }
    if unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            0,
            &mut basic as *mut Basic as *mut c_void,
            std::mem::size_of::<Basic>() as u32,
        )
    } == 0
    {
        return Err(io_error(io::Error::last_os_error(), "lstat", path));
    }
    let time = |value: i64| (value as i128 - 116_444_736_000_000_000i128) as f64 / 10_000.;
    Ok(Version {
        dev: info.volume as u64,
        ino: ((info.index_high as u64) << 32) | info.index_low as u64,
        size: ((info.size_high as u64) << 32) | info.size_low as u64,
        mtime: time(basic.modified),
        ctime: time(basic.changed),
    })
}
/// 每次查找共用预算；不跟随目录和文件软链接，允许删除竞态。
pub fn scan(
    root: &Path,
    suffix: &str,
    inspected: &mut usize,
    invalid: Option<(&str, &str)>,
    limit: (&str, &str),
) -> Result<Vec<(PathBuf, Version)>> {
    if !root.exists() {
        return Ok(vec![]);
    }
    let meta = fs::symlink_metadata(root).map_err(|e| io_error(e, "lstat", root))?;
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return match invalid {
            Some((c, m)) => Err(Failure::new(c, m)),
            None => Ok(vec![]),
        };
    }
    let mut stack = vec![root.to_owned()];
    let mut out = vec![];
    while let Some(dir) = stack.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(e) => return Err(io_error(e, "scandir", &dir)),
        };
        // Node readdirSync 的默认字节排序。
        let mut entries = entries
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|e| io_error(e, "scandir", &dir))?;
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            *inspected += 1;
            if *inspected > 100_000 {
                return Err(Failure::new(limit.0, limit.1));
            }
            let path = e.path();
            let ty = match e.file_type() {
                Ok(t) => t,
                Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
                Err(e) => return Err(io_error(e, "lstat", &path)),
            };
            if ty.is_symlink() {
                continue;
            }
            if ty.is_dir() {
                stack.push(path);
            } else if ty.is_file() && e.file_name().to_string_lossy().ends_with(suffix) {
                match fs::symlink_metadata(&path) {
                    Ok(m) if m.is_file() && !m.file_type().is_symlink() => {
                        let version = match Version::of(&path, &m) {
                            Ok(v) => v,
                            Err(e) if e.code == "ENOENT" => continue,
                            Err(e) => return Err(e),
                        };
                        out.push((path, version))
                    }
                    Ok(_) => {}
                    Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                    Err(e) => return Err(io_error(e, "lstat", &path)),
                }
            }
        }
    }
    Ok(out)
}
pub fn path_value(p: &Path) -> Value {
    json!(p.to_string_lossy())
}
pub fn remove(path: &Path, recursive: bool) -> Result<()> {
    let stat = match fs::symlink_metadata(path) {
        Ok(stat) => stat,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(io_error(e, "lstat", path)),
    };
    let result = if recursive && stat.is_dir() && !stat.file_type().is_symlink() {
        fs::remove_dir_all(path)
    } else {
        #[cfg(windows)]
        if {
            use std::os::windows::fs::MetadataExt;
            stat.file_type().is_symlink() && stat.file_attributes() & 0x10 != 0
        } {
            fs::remove_dir(path)
        } else {
            fs::remove_file(path)
        }
        #[cfg(not(windows))]
        fs::remove_file(path)
    };
    match result {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(io_error(e, "rm", path)),
    }
}
pub fn data_sync(file: &fs::File, path: &Path) -> Result<()> {
    file.sync_data()
        .or_else(|e| {
            if sync_ignored(&e, false) {
                Ok(())
            } else {
                Err(e)
            }
        })
        .map_err(|e| io_error(e, "fdatasync", path))
}
fn sync_ignored(e: &io::Error, dir: bool) -> bool {
    #[cfg(unix)]
    {
        let code = e.raw_os_error();
        code == Some(libc::ENOTSUP)
            || code == Some(libc::EINVAL)
            || dir
                && [libc::EISDIR, libc::EBADF, libc::EPERM]
                    .iter()
                    .any(|n| code == Some(*n))
    }
    #[cfg(not(unix))]
    {
        let _ = (e, dir);
        true
    }
}
pub fn sync_dir(path: &Path) -> Result<()> {
    fs::File::open(path)
        .and_then(|f| f.sync_all())
        .or_else(|e| {
            if sync_ignored(&e, true) {
                Ok(())
            } else {
                Err(e)
            }
        })
        .map_err(|e| io_error(e, "fsync", path))
}
/// 与 Node 的 junction 一样使用 mount-point reparse point，无需软链权限。
#[cfg(windows)]
pub fn junction(source: &Path, destination: &Path) -> Result<()> {
    use std::os::windows::{ffi::OsStrExt, fs::OpenOptionsExt, io::AsRawHandle};
    #[link(name = "kernel32")]
    extern "system" {
        fn DeviceIoControl(
            handle: *mut std::ffi::c_void,
            code: u32,
            input: *const u8,
            input_len: u32,
            output: *mut u8,
            output_len: u32,
            returned: *mut u32,
            overlapped: *mut std::ffi::c_void,
        ) -> i32;
    }
    fs::create_dir(destination).map_err(|e| io_error(e, "symlink", destination))?;
    let result = (|| {
        let display = source.as_os_str().encode_wide().collect::<Vec<_>>();
        let raw = source.to_string_lossy();
        let target = if let Some(t) = raw.strip_prefix(r"\\?\") {
            format!(r"\??\{t}")
        } else if let Some(t) = raw.strip_prefix(r"\\") {
            format!(r"\??\UNC\{t}")
        } else {
            format!(r"\??\{raw}")
        };
        let substitute = target.encode_utf16().collect::<Vec<_>>();
        let len = (substitute.len() + display.len() + 2) * 2;
        if len + 16 > 16 * 1024 {
            return Err(Failure::new("ENAMETOOLONG", "junction target too long"));
        }
        let mut buffer = Vec::with_capacity(len + 16);
        buffer.extend_from_slice(&0xa0000003u32.to_le_bytes());
        buffer.extend_from_slice(&((len + 8) as u16).to_le_bytes());
        buffer.extend_from_slice(&0u16.to_le_bytes());
        for n in [
            0,
            substitute.len() * 2,
            (substitute.len() + 1) * 2,
            display.len() * 2,
        ] {
            buffer.extend_from_slice(&(n as u16).to_le_bytes());
        }
        for n in substitute.into_iter().chain([0]).chain(display).chain([0]) {
            buffer.extend_from_slice(&n.to_le_bytes());
        }
        let file = fs::OpenOptions::new()
            .write(true)
            .custom_flags(0x02000000 | 0x00200000)
            .open(destination)
            .map_err(|e| io_error(e, "symlink", destination))?;
        let mut returned = 0;
        if unsafe {
            DeviceIoControl(
                file.as_raw_handle(),
                0x000900a4,
                buffer.as_ptr(),
                buffer.len() as u32,
                std::ptr::null_mut(),
                0,
                &mut returned,
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err(io_error(io::Error::last_os_error(), "symlink", destination));
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_dir(destination);
    }
    result
}
