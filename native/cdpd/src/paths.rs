//! 落盘位置。Node 侧 src/cdpd.js 逐条镜像这些规则，tests/test-cdpd.js 用
//! `multicc-cdpd paths` 校验两边一致 —— 两边说的不是同一个地址时，用户看到的是
//! 「连不上」而不是「没启动」，很难查。
//!
//! 刻意**不**跟随 XDG_RUNTIME_DIR 之类按登录方式变化的变量：服务端由 launchd /
//! systemd 拉起、脚本从终端或 cron 跑，它们的环境不一样，地址却必须一样。

use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct Paths {
    pub dir: PathBuf,
    /// unix socket 路径；Windows 上是命名管道名。
    pub socket: PathBuf,
    pub lock: PathBuf,
    pub log: PathBuf,
    pub endpoint: PathBuf,
}

fn var(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
}

pub fn resolve() -> Paths {
    let dir = var("MULTICC_CDP_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(default_dir);
    let socket = var("MULTICC_CDP_SOCK")
        .map(PathBuf::from)
        .unwrap_or_else(|| default_socket(&dir));
    Paths {
        lock: dir.join("cdpd.lock"),
        log: dir.join("cdpd.log"),
        endpoint: dir.join("endpoint.json"),
        socket,
        dir,
    }
}

#[cfg(unix)]
fn default_dir() -> PathBuf {
    PathBuf::from(var("HOME").unwrap_or_else(|| "/tmp".into()))
        .join(".multicc")
        .join("cdpd")
}

#[cfg(windows)]
fn default_dir() -> PathBuf {
    PathBuf::from(var("USERPROFILE").unwrap_or_else(|| "C:\\".into()))
        .join(".multicc")
        .join("cdpd")
}

#[cfg(unix)]
fn default_socket(dir: &std::path::Path) -> PathBuf {
    dir.join("cdp.sock")
}

/// 命名管道是全机共享的命名空间：不带用户名，多用户机器上第二个用户的网关
/// 根本起不来（first_pipe_instance），更糟的是会连到别人的网关上。
#[cfg(windows)]
fn default_socket(_dir: &std::path::Path) -> PathBuf {
    PathBuf::from(format!(r"\\.\pipe\multicc-cdpd-{}", pipe_user()))
}

#[cfg(windows)]
fn pipe_user() -> String {
    sanitize_user(&var("USERNAME").unwrap_or_else(|| "default".into()))
}

pub fn sanitize_user(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "default".into()
    } else {
        cleaned
    }
}

/// sun_path 的上限（含结尾 NUL）：macOS 104，Linux 108。超长时 bind 只会报一个
/// 看不出原因的 EINVAL，所以提前给出可操作的错误。
#[cfg(unix)]
pub fn check_socket_len(path: &std::path::Path) -> Result<(), String> {
    let limit = if cfg!(target_os = "macos") { 103 } else { 107 };
    let len = path.as_os_str().len();
    if len > limit {
        return Err(format!(
            "socket path is {len} bytes, the OS limit is {limit}: {} (set MULTICC_CDP_SOCK to a shorter path)",
            path.display()
        ));
    }
    Ok(())
}

impl Paths {
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "dir": self.dir.to_string_lossy(),
            "socket": self.socket.to_string_lossy(),
            "lock": self.lock.to_string_lossy(),
            "log": self.log.to_string_lossy(),
            "endpoint": self.endpoint.to_string_lossy(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_names_are_safe_in_a_pipe_name() {
        assert_eq!(sanitize_user("Zhang San"), "Zhang_San");
        assert_eq!(sanitize_user("a\\b"), "a_b");
        assert_eq!(sanitize_user(""), "default");
    }

    #[cfg(unix)]
    #[test]
    fn overlong_socket_paths_are_refused_with_a_hint() {
        let long = std::path::PathBuf::from(format!("/tmp/{}/cdp.sock", "x".repeat(120)));
        assert!(check_socket_len(&long)
            .unwrap_err()
            .contains("MULTICC_CDP_SOCK"));
        assert!(check_socket_len(std::path::Path::new("/tmp/cdp.sock")).is_ok());
    }
}
