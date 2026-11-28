//! POSIX 的独立监护子进程只持有管道读端。桥退出（含 SIGKILL）自动关闭
//! 唯一写端；整个专属进程组及其 MCP、出口包装进程都随之终止。
#[cfg(unix)]
pub(super) fn install() -> std::io::Result<std::process::Child> {
    use std::{
        io,
        process::{Command, Stdio},
    };
    unsafe {
        // 宿主以 detached 启动。独立调用时也必须独占会话，避免误杀同一 shell 管道。
        if libc::getsid(0) != libc::getpid() && libc::setsid() == -1 {
            return Err(io::Error::last_os_error());
        }
    }
    Command::new(std::env::current_exe()?)
        .args(["agy-stream-guard", &std::process::id().to_string()])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
}

#[cfg(unix)]
pub fn watch(group: Option<&String>) -> i32 {
    use std::io::{self, Read};
    let Some(group) = group.and_then(|v| v.parse::<i32>().ok()).filter(|v| *v > 1) else {
        return 2;
    };
    if unsafe { libc::getpgrp() != group || libc::getsid(0) != group || libc::isatty(0) == 1 } {
        return 2;
    }
    let mut byte = [0u8; 1];
    while let Err(err) = io::stdin().read(&mut byte) {
        if err.kind() != io::ErrorKind::Interrupted {
            break;
        }
    }
    unsafe {
        libc::kill(-group, libc::SIGKILL);
    }
    0
}

// Windows 的 Job 由桥进程单独持有。句柄不继承，TerminateProcess 或宿主 EOF
// 退出时由内核终止整个 Job（含 agy 派生的 MCP 进程）。
#[cfg(windows)]
pub(super) fn install() -> std::io::Result<std::os::windows::io::OwnedHandle> {
    use std::{
        io, mem,
        os::windows::io::{FromRawHandle, OwnedHandle},
    };
    use windows_sys::Win32::System::{JobObjects::*, Threading::GetCurrentProcess};
    unsafe {
        let raw = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if raw.is_null() {
            return Err(io::Error::last_os_error());
        }
        let job = OwnedHandle::from_raw_handle(raw);
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            raw,
            JobObjectExtendedLimitInformation,
            (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            mem::size_of_val(&info) as u32,
        ) == 0
            || AssignProcessToJobObject(raw, GetCurrentProcess()) == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(job)
    }
}
