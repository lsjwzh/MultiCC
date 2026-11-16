//! Observe the original process without ever signalling it.
//!
//! On Windows the retained OS handle protects against PID reuse. On Unix a
//! reused PID conservatively remains "alive", so it can only block a restart;
//! it can never cause this observer to signal an unrelated process.

use std::io;
use std::time::{Duration, Instant};

#[cfg(unix)]
pub struct ProcessObserver {
    pid: i32,
}

#[cfg(unix)]
impl ProcessObserver {
    pub fn open(pid: u32) -> io::Result<Self> {
        let pid = i32::try_from(pid)
            .ok()
            .filter(|pid| *pid > 1)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid process id"))?;
        Ok(Self { pid })
    }

    pub fn exited(&self) -> io::Result<bool> {
        // SAFETY: signal 0 checks existence/permission without delivering a signal.
        if unsafe { libc::kill(self.pid, 0) } == 0 {
            return Ok(false);
        }
        let error = io::Error::last_os_error();
        match error.raw_os_error() {
            Some(libc::ESRCH) => Ok(true),
            Some(libc::EPERM) => Ok(false),
            _ => Err(error),
        }
    }
}

#[cfg(windows)]
pub struct ProcessObserver {
    handle: *mut std::ffi::c_void,
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
    fn WaitForSingleObject(handle: *mut std::ffi::c_void, millis: u32) -> u32;
    fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
}

#[cfg(windows)]
impl ProcessObserver {
    pub fn open(pid: u32) -> io::Result<Self> {
        if pid <= 1 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid process id",
            ));
        }
        // SYNCHRONIZE only; this handle cannot terminate or modify the process.
        let handle = unsafe { OpenProcess(0x0010_0000, 0, pid) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        Ok(Self { handle })
    }

    pub fn exited(&self) -> io::Result<bool> {
        match unsafe { WaitForSingleObject(self.handle, 0) } {
            0 => Ok(true),
            258 => Ok(false),
            _ => Err(io::Error::last_os_error()),
        }
    }
}

#[cfg(windows)]
impl Drop for ProcessObserver {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.handle);
        }
    }
}

/// Returns false on timeout; observation errors are never treated as exit.
pub fn wait_for_exit(
    observer: &ProcessObserver,
    timeout: Duration,
    interval: Duration,
) -> io::Result<bool> {
    if interval.is_zero() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "poll interval must be positive",
        ));
    }
    let start = Instant::now();
    loop {
        if observer.exited()? {
            return Ok(true);
        }
        let Some(remaining) = timeout.checked_sub(start.elapsed()) else {
            return Ok(false);
        };
        if remaining.is_zero() {
            return Ok(false);
        }
        std::thread::sleep(remaining.min(interval));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};

    #[test]
    fn observes_a_real_child_and_times_out_without_signalling_it() {
        #[cfg(unix)]
        let mut child = Command::new("/bin/sleep")
            .arg("30")
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        #[cfg(windows)]
        let mut child = Command::new("cmd")
            .args(["/C", "ping -n 30 127.0.0.1 >NUL"])
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let observer = ProcessObserver::open(child.id()).unwrap();
        assert!(!wait_for_exit(
            &observer,
            Duration::from_millis(25),
            Duration::from_millis(5)
        )
        .unwrap());
        assert!(
            child.try_wait().unwrap().is_none(),
            "observer must not signal the child"
        );
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(
            wait_for_exit(&observer, Duration::from_secs(2), Duration::from_millis(5)).unwrap()
        );
    }

    #[test]
    fn rejects_invalid_pids() {
        assert!(ProcessObserver::open(0).is_err());
        assert!(ProcessObserver::open(1).is_err());
    }
}
