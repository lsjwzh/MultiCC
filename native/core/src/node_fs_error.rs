//! Node/libuv-shaped metadata for filesystem errors.
//!
//! Node's sync `fs` errors are `Error` objects carrying `{ code, errno,
//! syscall, path[, dest] }`, where `code` is the symbolic name, `errno` is the
//! negative libuv error (the negated OS errno on unix) and the message is
//! `"${code}: ${description}, ${syscall} '${path}'"`. Native file IO has to
//! reproduce those fields: callers branch on `.code` (`ENOENT`) and the turn
//! engine forwards `.code` to clients, so a generic Rust error is not enough.
//!
//! This module only supplies the platform mapping (code, errno, description).
//! The addon owns the JS `Error` construction and the syscall/path context.

use std::io;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FsErrorInfo {
    /// Symbolic name Node exposes as `error.code`.
    pub code: &'static str,
    /// Negative libuv errno, exactly the value Node exposes as `error.errno`.
    pub errno: i32,
    /// `uv_strerror()` text, the part between `code: ` and `, syscall`.
    pub description: &'static str,
}

const fn info(code: &'static str, errno: i32, description: &'static str) -> FsErrorInfo {
    FsErrorInfo {
        code,
        errno,
        description,
    }
}

/// Map an `io::Error` to the metadata Node would report for the same failure.
/// Unknown OS errors fall back to `ErrorKind`, which covers the failures a Rust
/// std call can synthesize without a raw OS errno.
pub fn classify(error: &io::Error) -> FsErrorInfo {
    #[cfg(unix)]
    if let Some(raw) = error.raw_os_error() {
        if let Some(info) = unix_error(raw) {
            return info;
        }
    }
    #[cfg(windows)]
    if let Some(raw) = error.raw_os_error() {
        if let Some(info) = windows_error(raw) {
            return info;
        }
    }
    #[cfg(windows)]
    {
        windows_fallback(error.kind())
    }
    #[cfg(not(windows))]
    {
        unix_fallback(error.kind())
    }
}

#[cfg(unix)]
fn unix_error(raw: i32) -> Option<FsErrorInfo> {
    let (code, description) = match raw {
        1 => ("EPERM", "operation not permitted"),
        2 => ("ENOENT", "no such file or directory"),
        4 => ("EINTR", "interrupted system call"),
        5 => ("EIO", "i/o error"),
        13 => ("EACCES", "permission denied"),
        16 => ("EBUSY", "resource busy or locked"),
        17 => ("EEXIST", "file already exists"),
        18 => ("EXDEV", "cross-device link not permitted"),
        20 => ("ENOTDIR", "not a directory"),
        21 => ("EISDIR", "illegal operation on a directory"),
        22 => ("EINVAL", "invalid argument"),
        23 => ("ENFILE", "file table overflow"),
        24 => ("EMFILE", "too many open files"),
        26 => ("ETXTBSY", "text file busy"),
        27 => ("EFBIG", "file too large"),
        28 => ("ENOSPC", "no space left on device"),
        30 => ("EROFS", "read-only file system"),
        32 => ("EPIPE", "broken pipe"),
        other => return nonportable_unix_error(other),
    };
    Some(info(code, -raw, description))
}

// These errno values differ between Linux and the BSDs (including macOS).
#[cfg(all(unix, target_os = "linux"))]
fn nonportable_unix_error(raw: i32) -> Option<FsErrorInfo> {
    let (code, description) = match raw {
        36 => ("ENAMETOOLONG", "name too long"),
        38 => ("ENOSYS", "function not implemented"),
        39 => ("ENOTEMPTY", "directory not empty"),
        40 => ("ELOOP", "too many symbolic links encountered"),
        75 => ("EOVERFLOW", "value too large for defined data type"),
        122 => ("EDQUOT", "disk quota exceeded"),
        _ => return None,
    };
    Some(info(code, -raw, description))
}

#[cfg(all(unix, any(target_os = "macos", target_os = "ios")))]
fn nonportable_unix_error(raw: i32) -> Option<FsErrorInfo> {
    let (code, description) = match raw {
        62 => ("ELOOP", "too many symbolic links encountered"),
        63 => ("ENAMETOOLONG", "name too long"),
        66 => ("ENOTEMPTY", "directory not empty"),
        69 => ("EDQUOT", "disk quota exceeded"),
        78 => ("ENOSYS", "function not implemented"),
        84 => ("EOVERFLOW", "value too large for defined data type"),
        _ => return None,
    };
    Some(info(code, -raw, description))
}

#[cfg(all(
    unix,
    not(any(target_os = "linux", target_os = "macos", target_os = "ios"))
))]
fn nonportable_unix_error(_raw: i32) -> Option<FsErrorInfo> {
    None
}

#[cfg(windows)]
fn windows_error(raw: i32) -> Option<FsErrorInfo> {
    windows_lookup(raw)
}

/// Win32 code → the metadata Node reports (its libuv `uv_translate_sys_error`
/// result). Declared outside `cfg(windows)` so the constants are compiled and
/// pinned by tests on every platform; the negative values come from
/// `uv/errno.h`'s `_WIN32` fallbacks.
pub const WINDOWS_ERRORS: &[(i32, FsErrorInfo)] = &[
    (2, info("ENOENT", -4058, "no such file or directory")),
    (3, info("ENOENT", -4058, "no such file or directory")),
    (53, info("ENOENT", -4058, "no such file or directory")),
    (67, info("ENOENT", -4058, "no such file or directory")),
    (123, info("ENOENT", -4058, "no such file or directory")),
    (5, info("EACCES", -4092, "permission denied")),
    (6, info("EBADF", -4083, "bad file descriptor")),
    (32, info("EBUSY", -4082, "resource busy or locked")),
    (33, info("EBUSY", -4082, "resource busy or locked")),
    (39, info("ENOSPC", -4055, "no space left on device")),
    (112, info("ENOSPC", -4055, "no space left on device")),
    (80, info("EEXIST", -4075, "file already exists")),
    (183, info("EEXIST", -4075, "file already exists")),
    (87, info("EINVAL", -4071, "invalid argument")),
    (161, info("EINVAL", -4071, "invalid argument")),
    (109, info("EPIPE", -4047, "broken pipe")),
    (145, info("ENOTEMPTY", -4051, "directory not empty")),
    (267, info("ENOTDIR", -4052, "not a directory")),
];

/// Shared by `windows_error` and the cross-platform constant test.
#[cfg(any(windows, test))]
pub(crate) fn windows_lookup(raw: i32) -> Option<FsErrorInfo> {
    WINDOWS_ERRORS
        .iter()
        .find(|(code, _)| *code == raw)
        .map(|(_, info)| *info)
}

#[cfg(unix)]
fn unix_fallback(kind: io::ErrorKind) -> FsErrorInfo {
    #[cfg(target_os = "linux")]
    let (eagain, etimedout) = (11, 110);
    #[cfg(not(target_os = "linux"))]
    let (eagain, etimedout) = (35, 60);
    let (code, errno, description) = match kind {
        io::ErrorKind::NotFound => ("ENOENT", 2, "no such file or directory"),
        io::ErrorKind::PermissionDenied => ("EACCES", 13, "permission denied"),
        io::ErrorKind::AlreadyExists => ("EEXIST", 17, "file already exists"),
        io::ErrorKind::InvalidInput | io::ErrorKind::InvalidData => {
            ("EINVAL", 22, "invalid argument")
        }
        io::ErrorKind::Interrupted => ("EINTR", 4, "interrupted system call"),
        io::ErrorKind::BrokenPipe => ("EPIPE", 32, "broken pipe"),
        io::ErrorKind::WouldBlock => ("EAGAIN", eagain, "resource temporarily unavailable"),
        io::ErrorKind::TimedOut => ("ETIMEDOUT", etimedout, "connection timed out"),
        _ => ("EIO", 5, "i/o error"),
    };
    info(code, -errno, description)
}

#[cfg(any(windows, test))]
pub(crate) fn windows_fallback(kind: io::ErrorKind) -> FsErrorInfo {
    // Libuv error codes, matching what Node reports on Windows.
    match kind {
        io::ErrorKind::NotFound => info("ENOENT", -4058, "no such file or directory"),
        io::ErrorKind::PermissionDenied => info("EACCES", -4092, "permission denied"),
        io::ErrorKind::AlreadyExists => info("EEXIST", -4075, "file already exists"),
        io::ErrorKind::InvalidInput | io::ErrorKind::InvalidData => {
            info("EINVAL", -4071, "invalid argument")
        }
        io::ErrorKind::Interrupted => info("EINTR", -4072, "interrupted system call"),
        io::ErrorKind::BrokenPipe => info("EPIPE", -4047, "broken pipe"),
        io::ErrorKind::WouldBlock => info("EAGAIN", -4088, "resource temporarily unavailable"),
        io::ErrorKind::TimedOut => info("ETIMEDOUT", -4039, "connection timed out"),
        _ => info("UNKNOWN", -4094, "unknown error"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(code: i32) -> io::Error {
        io::Error::from_raw_os_error(code)
    }

    #[cfg(unix)]
    #[test]
    fn common_unix_errors_match_node_metadata() {
        let cases = [
            (2, "ENOENT", "no such file or directory"),
            (1, "EPERM", "operation not permitted"),
            (13, "EACCES", "permission denied"),
            (17, "EEXIST", "file already exists"),
            (20, "ENOTDIR", "not a directory"),
            (21, "EISDIR", "illegal operation on a directory"),
            (22, "EINVAL", "invalid argument"),
            (24, "EMFILE", "too many open files"),
            (28, "ENOSPC", "no space left on device"),
            (30, "EROFS", "read-only file system"),
            (16, "EBUSY", "resource busy or locked"),
            (18, "EXDEV", "cross-device link not permitted"),
            (5, "EIO", "i/o error"),
        ];
        for (raw_code, code, description) in cases {
            let mapped = classify(&raw(raw_code));
            assert_eq!(mapped.code, code, "raw {raw_code}");
            assert_eq!(mapped.errno, -raw_code, "raw {raw_code}");
            assert_eq!(mapped.description, description, "raw {raw_code}");
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_nonportable_errnos_are_negative_raw() {
        for (raw_code, code) in [(39, "ENOTEMPTY"), (40, "ELOOP"), (36, "ENAMETOOLONG")] {
            let mapped = classify(&raw(raw_code));
            assert_eq!(mapped.code, code);
            assert_eq!(mapped.errno, -raw_code);
        }
    }

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    #[test]
    fn bsd_nonportable_errnos_are_negative_raw() {
        let cases = [
            (66, "ENOTEMPTY", "directory not empty"),
            (62, "ELOOP", "too many symbolic links encountered"),
            (63, "ENAMETOOLONG", "name too long"),
        ];
        for (raw_code, code, description) in cases {
            let mapped = classify(&raw(raw_code));
            assert_eq!(mapped.code, code);
            assert_eq!(mapped.errno, -raw_code);
            assert_eq!(mapped.description, description);
        }
    }

    #[cfg(unix)]
    #[test]
    fn unknown_errno_falls_back_by_kind() {
        let error = io::Error::new(io::ErrorKind::NotFound, "missing");
        assert_eq!(classify(&error).code, "ENOENT");
        assert_eq!(classify(&error).errno, -2);
        assert_eq!(classify(&error).description, "no such file or directory");
        let denied = io::Error::new(io::ErrorKind::PermissionDenied, "denied");
        assert_eq!(classify(&denied).code, "EACCES");
    }

    // Runs on every platform: the Windows table is plain data and only the
    // lookup is cfg(windows). Pins the negative libuv values from uv/errno.h.
    #[test]
    fn windows_libuv_constants_match_the_uv_header() {
        let expected = [
            (2, "ENOENT", -4058),
            (3, "ENOENT", -4058),
            (53, "ENOENT", -4058),
            (67, "ENOENT", -4058),
            (123, "ENOENT", -4058),
            (5, "EACCES", -4092),
            (6, "EBADF", -4083),
            (32, "EBUSY", -4082),
            (33, "EBUSY", -4082),
            (39, "ENOSPC", -4055),
            (112, "ENOSPC", -4055),
            (80, "EEXIST", -4075),
            (183, "EEXIST", -4075),
            (87, "EINVAL", -4071),
            (161, "EINVAL", -4071),
            (109, "EPIPE", -4047),
            (145, "ENOTEMPTY", -4051),
            (267, "ENOTDIR", -4052),
        ];
        assert_eq!(WINDOWS_ERRORS.len(), expected.len());
        for ((raw, info), (expected_raw, code, errno)) in WINDOWS_ERRORS.iter().zip(expected) {
            assert_eq!(*raw, expected_raw);
            assert_eq!(info.code, code);
            assert_eq!(info.errno, errno);
        }
        assert_eq!(windows_lookup(6).unwrap().errno, -4083);

        let fallbacks = [
            (io::ErrorKind::NotFound, "ENOENT", -4058),
            (io::ErrorKind::PermissionDenied, "EACCES", -4092),
            (io::ErrorKind::AlreadyExists, "EEXIST", -4075),
            (io::ErrorKind::InvalidInput, "EINVAL", -4071),
            (io::ErrorKind::Interrupted, "EINTR", -4072),
            (io::ErrorKind::BrokenPipe, "EPIPE", -4047),
            (io::ErrorKind::WouldBlock, "EAGAIN", -4088),
            (io::ErrorKind::TimedOut, "ETIMEDOUT", -4039),
            (io::ErrorKind::Other, "UNKNOWN", -4094),
        ];
        for (kind, code, errno) in fallbacks {
            let mapped = windows_fallback(kind);
            assert_eq!(mapped.code, code, "{kind:?}");
            assert_eq!(mapped.errno, errno, "{kind:?}");
        }
    }
}
