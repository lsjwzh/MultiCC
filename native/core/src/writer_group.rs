//! A writer lease remains live while any process in its POSIX group exists.
pub const POLL_MS: u64 = 250;

#[cfg(unix)]
pub fn alive(pgid: u32) -> bool {
    if pgid <= 1 {
        return false;
    }
    // Node's signal probe also treats an unrepresentable target as an error
    // other than ESRCH. It cannot establish that the writer is gone.
    let Ok(target) = libc::pid_t::try_from(-i64::from(pgid)) else {
        return true;
    };
    unsafe {
        libc::kill(target, 0) == 0
            || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    }
}

#[cfg(not(unix))]
pub fn alive(_pgid: u32) -> bool {
    false
}
