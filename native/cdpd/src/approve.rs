//! macOS 上自动点掉 Chrome 的「允许远程调试」授权框。
//!
//! 背景：Chrome 对运行时开启的调试按**每条 WebSocket** 弹一次授权框，网关重连时
//! 用户就得再点一次。这里在等握手的窗口期内用辅助功能（System Events）找到那个
//! 弹窗并替用户点「允许」；点不掉（没授权辅助功能、弹窗没找到）就什么都不做，
//! 原有「等用户亲手点 / 超时退避」的路径完全不变。
//!
//! 只在 macOS 且上游是 `ws://`（pipe:// 是隔离实例的私有通道，本来就不弹窗）时
//! 由 [`upstream`] 在等待建连期间拉起，建连有了结果（成功/失败/超时）立即停。

use std::time::Duration;

/// 首次尝试前的等待：弹窗本身出现也要一点时间。
const FIRST_TRY_DELAY: Duration = Duration::from_millis(700);
/// 两次尝试的间隔。授权框是模态的，一直等到握手超时为止。
const TRY_INTERVAL: Duration = Duration::from_millis(1200);

/// AppleScript：在目标浏览器进程里找「远程调试」授权框并点允许按钮。
/// 输出一行结果供日志区分：clicked / no-dialog；失败走 stderr。
/// 文案按「按钮名字段」匹配，中英 Chrome 各自一份候选。
#[cfg(target_os = "macos")]
const SCRIPT: &str = r#"
on run argv
    set procName to item 1 of argv
    tell application "System Events"
        if not (exists process procName) then return "no-dialog"
        tell process procName
            set allowNames to {"Allow", "允许"}
            set markers to {"remote debugging", "远程调试"}
            repeat with w in windows
                set targets to {w}
                try
                    set targets to targets & sheets of w
                end try
                repeat with t in targets
                    try
                        set scopes to {t}
                        try
                            set scopes to scopes & groups of t
                        end try
                        repeat with s in scopes
                            set texts to name of static texts of s
                            set joined to texts as text
                            set hit to false
                            repeat with m in markers
                                if joined contains m then set hit to true
                            end repeat
                            if hit then
                                repeat with b in buttons of s
                                    if name of b is in allowNames then
                                        click b
                                        return "clicked"
                                    end if
                                end repeat
                            end if
                        end repeat
                    end try
                end repeat
            end repeat
        end tell
    end tell
    return "no-dialog"
end run
"#;

/// 在等待建连期间周期性尝试自动点「允许」。返回的 handle 由调用方 abort。
/// 非 macOS 或 pipe:// 上游返回 None（调用方已经按这两个条件过滤，这里兜底）。
pub fn spawn(url: String) -> Option<tokio::task::JoinHandle<()>> {
    if url.starts_with("pipe://") {
        return None;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = url;
        None
    }
    #[cfg(target_os = "macos")]
    Some(tokio::spawn(async move {
        tokio::time::sleep(FIRST_TRY_DELAY).await;
        let mut blocked = false;
        let mut logged_error = false;
        loop {
            if blocked {
                return;
            }
            let outcome = tokio::task::spawn_blocking(try_click_allow).await;
            match outcome {
                Ok(ClickOutcome::Clicked) => {
                    crate::log!(
                        "[{url}] auto-approved the remote-debugging dialog via accessibility"
                    );
                    return;
                }
                Ok(ClickOutcome::NoDialog) => {}
                Ok(ClickOutcome::NoAccessibility) => {
                    // 没辅助功能权限时重试一百年也是同样结果，停下来把舞台还给用户。
                    crate::log!(
                        "[{url}] auto-approve unavailable: multicc-cdpd lacks accessibility permission; falling back to manual Allow"
                    );
                    blocked = true;
                }
                Ok(ClickOutcome::Error(error)) => {
                    if !logged_error {
                        crate::log!("[{url}] auto-approve attempt failed: {error}");
                        logged_error = true;
                    }
                }
                Err(_) => {}
            }
            tokio::time::sleep(TRY_INTERVAL).await;
        }
    }))
}

#[cfg(target_os = "macos")]
enum ClickOutcome {
    Clicked,
    NoDialog,
    NoAccessibility,
    Error(String),
}

/// 经 System Events 在「Google Chrome」进程里点允许按钮。
/// 只认主浏览器进程名：专用/隔离实例启动时自带调试开关，不弹这个框。
#[cfg(target_os = "macos")]
fn try_click_allow() -> ClickOutcome {
    let output = match std::process::Command::new("osascript")
        .arg("-e")
        .arg(SCRIPT)
        .arg("Google Chrome")
        .stdin(std::process::Stdio::null())
        .output()
    {
        Ok(output) => output,
        Err(error) => return ClickOutcome::Error(error.to_string()),
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if stdout.trim() == "clicked" {
        return ClickOutcome::Clicked;
    }
    // 1719/assistive：System Events 没拿到辅助功能权限。
    if stderr.contains("assistive") || stderr.contains("1719") || stderr.contains("not allowed") {
        return ClickOutcome::NoAccessibility;
    }
    if !output.status.success() {
        return ClickOutcome::Error(stderr.trim().to_string());
    }
    ClickOutcome::NoDialog
}

/// 建连一有了结果就停掉自动点击。用 Drop 包住，覆盖 run() 的所有提前返回路径。
pub struct AbortOnDrop(Option<tokio::task::AbortHandle>);

impl AbortOnDrop {
    pub fn new(handle: Option<tokio::task::JoinHandle<()>>) -> Self {
        Self(handle.map(|h| h.abort_handle()))
    }
}

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        if let Some(handle) = self.0.take() {
            handle.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pipe_upstreams_never_spawn() {
        assert!(spawn("pipe:///tmp/x.sock".to_string()).is_none());
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn non_macos_never_spawns() {
        assert!(spawn("ws://127.0.0.1:9222/x".to_string()).is_none());
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn guard_aborts_task() {
        let handle = spawn("ws://127.0.0.1:9222/x".to_string()).expect("macOS spawns");
        let aborted = handle.abort_handle();
        aborted.abort();
        assert!(handle.await.unwrap_err().is_cancelled());
    }
}
