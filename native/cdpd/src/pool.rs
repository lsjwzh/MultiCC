//! wsUrl → 上游 actor。
//!
//! - **建连 single-flight**：actor 一创建就登记，等待审批期间后来的调用方都排进同
//!   一次建连。（先连后登记会让并发调用方各连一次 —— 关掉多余的那条也晚了，
//!   弹窗在建连时就已经弹出来了。）
//! - **弹窗风暴防护**：审批被拒或超时后，同一个 URL 在冷却期内直接拒绝，不再建连；
//!   冷却按次数加倍。调用方循环重试正是「刚点了拒绝又弹出来」的来源。调用方可以用
//!   `force` 绕过（用户刚说「我去点允许」时）。
//! - 只转发到本机 Chrome：网关替同一用户的任何本地程序建连，没有理由让它去连外网。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::mpsc;

use crate::upstream::{self, Cmd};

pub enum Outcome {
    /// Chrome 没在听 / 地址不对：没有弹窗，随时可以重试。
    Unreachable,
    /// 握手被拒或审批超时：冷却。
    Denied,
    /// 曾经就绪，后来断了（Chrome 退出或重启）。
    Closed,
}

#[derive(Debug)]
pub struct Refusal {
    pub code: &'static str,
    pub detail: String,
    pub retry_after_ms: Option<u64>,
}

impl Refusal {
    pub fn bad_request(detail: impl Into<String>) -> Self {
        Self {
            code: "bad-request",
            detail: detail.into(),
            retry_after_ms: None,
        }
    }

    pub fn body(&self) -> String {
        let mut body =
            serde_json::json!({ "ok": false, "error": self.code, "detail": self.detail });
        if let Some(ms) = self.retry_after_ms {
            body["retryAfterMs"] = ms.into();
        }
        body.to_string()
    }
}

pub struct Settings {
    pub connect_timeout: Duration,
    pub cooldown_base: Duration,
    pub cooldown_max: Duration,
    pub allow_remote: bool,
}

impl Settings {
    pub fn from_env() -> Self {
        let secs = |name: &str, default: u64| {
            std::env::var(name)
                .ok()
                .and_then(|v| v.trim().parse::<u64>().ok())
                .unwrap_or(default)
        };
        Self {
            connect_timeout: Duration::from_secs(
                secs("MULTICC_CDP_APPROVAL_TIMEOUT_SECS", 180).max(1),
            ),
            cooldown_base: Duration::from_secs(secs("MULTICC_CDP_COOLDOWN_SECS", 30)),
            cooldown_max: Duration::from_secs(600),
            allow_remote: std::env::var("MULTICC_CDP_ALLOW_REMOTE")
                .map(|v| v.trim() == "1")
                .unwrap_or(false),
        }
    }
}

struct Entry {
    generation: u64,
    tx: mpsc::Sender<Cmd>,
}

struct Cooldown {
    until: Instant,
    strikes: u32,
}

#[derive(Default)]
struct Inner {
    actors: HashMap<String, Entry>,
    cooldowns: HashMap<String, Cooldown>,
    next_generation: u64,
}

pub struct Pool {
    inner: Mutex<Inner>,
    settings: Settings,
}

impl Pool {
    pub fn new(settings: Settings) -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(Inner::default()),
            settings,
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 取（或建）这个 URL 的 actor。
    pub fn handle(self: &Arc<Self>, url: &str, force: bool) -> Result<mpsc::Sender<Cmd>, Refusal> {
        validate(url, self.settings.allow_remote)?;
        let key = normalize(url);
        let mut inner = self.lock();
        if let Some(entry) = inner.actors.get(&key) {
            if !entry.tx.is_closed() {
                return Ok(entry.tx.clone());
            }
        }
        if let Some(cooldown) = inner.cooldowns.get(&key) {
            let now = Instant::now();
            if cooldown.until > now && !force {
                return Err(Refusal {
                    code: "chrome_cooldown",
                    detail: "Chrome refused or ignored the last approval request for this browser. Not asking again yet, \
                             so the user is not flooded with dialogs; retry later, or pass force when the user is ready to click Allow."
                        .into(),
                    retry_after_ms: Some((cooldown.until - now).as_millis() as u64),
                });
            }
        }
        inner.next_generation += 1;
        let generation = inner.next_generation;
        let tx = upstream::spawn(
            self.clone(),
            key.clone(),
            generation,
            url.to_string(),
            self.settings.connect_timeout,
        );
        inner.actors.insert(
            key,
            Entry {
                generation,
                tx: tx.clone(),
            },
        );
        Ok(tx)
    }

    pub fn allow_remote(&self) -> bool {
        self.settings.allow_remote
    }

    /// 已存在的 actor（不新建）：release / status 用。
    pub fn existing(&self, url: &str) -> Option<mpsc::Sender<Cmd>> {
        self.lock()
            .actors
            .get(&normalize(url))
            .map(|e| e.tx.clone())
    }

    pub fn actors(&self) -> Vec<mpsc::Sender<Cmd>> {
        self.lock().actors.values().map(|e| e.tx.clone()).collect()
    }

    pub fn is_empty(&self) -> bool {
        self.lock().actors.is_empty()
    }

    pub fn finished(&self, key: &str, generation: u64, outcome: Outcome) {
        let mut inner = self.lock();
        if inner
            .actors
            .get(key)
            .is_some_and(|e| e.generation == generation)
        {
            inner.actors.remove(key);
        }
        match outcome {
            Outcome::Denied => {
                let strikes = inner.cooldowns.get(key).map(|c| c.strikes + 1).unwrap_or(1);
                let wait = self
                    .settings
                    .cooldown_base
                    .saturating_mul(1u32 << (strikes - 1).min(10))
                    .min(self.settings.cooldown_max);
                crate::log!(
                    "[{key}] cooling down for {}s (strike {strikes})",
                    wait.as_secs()
                );
                inner.cooldowns.insert(
                    key.to_string(),
                    Cooldown {
                        until: Instant::now() + wait,
                        strikes,
                    },
                );
            }
            Outcome::Closed => {
                inner.cooldowns.remove(key);
            }
            Outcome::Unreachable => {}
        }
    }
}

fn normalize(url: &str) -> String {
    match url.split_once("://") {
        Some((scheme, rest)) => {
            let (authority, path) = rest.split_at(rest.find('/').unwrap_or(rest.len()));
            format!(
                "{}://{}{}",
                scheme.to_ascii_lowercase(),
                authority.to_ascii_lowercase(),
                path
            )
        }
        None => url.to_string(),
    }
}

pub fn validate(url: &str, allow_remote: bool) -> Result<(), Refusal> {
    if let Some(path) = url.strip_prefix("pipe://") {
        #[cfg(not(unix))]
        let _ = path;
        #[cfg(unix)]
        {
            use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
            let meta = std::fs::symlink_metadata(path).map_err(|_| {
                Refusal::bad_request(
                    "browser control socket is unavailable; reopen the isolation instance",
                )
            })?;
            if std::path::Path::new(path).is_absolute()
                && meta.file_type().is_socket()
                && meta.uid() == unsafe { libc::geteuid() }
                && meta.permissions().mode() & 0o077 == 0
            {
                return Ok(());
            }
        }
        return Err(Refusal::bad_request(
            "browser control requires a private, current-user local socket",
        ));
    }
    let rest = url
        .strip_prefix("ws://")
        .or_else(|| url.strip_prefix("wss://"))
        .ok_or_else(|| Refusal::bad_request("wsUrl must be a ws:// URL"))?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() || authority.contains('@') {
        return Err(Refusal::bad_request(format!(
            "unsupported wsUrl authority: {authority:?}"
        )));
    }
    let host = if authority.starts_with('[') {
        authority
            .split(']')
            .next()
            .map(|h| format!("{h}]"))
            .unwrap_or_default()
    } else {
        authority
            .rsplit_once(':')
            .map(|(h, _)| h)
            .unwrap_or(authority)
            .to_string()
    };
    let host = host.to_ascii_lowercase();
    let loopback = host == "localhost" || host == "[::1]" || host.starts_with("127.");
    if !loopback && !allow_remote {
        return Err(Refusal::bad_request(format!(
            "multicc-cdpd only relays to a Chrome on this machine (got {host}); set MULTICC_CDP_ALLOW_REMOTE=1 to allow others"
        )));
    }
    Ok(())
}

/// 调用方给 wsUrl，或给一个 DevToolsActivePort（Chrome 运行时开启调试时唯一的
/// 发现途径 —— 那种模式下 /json/version 不应答）。后者每次现读，Chrome 重启后
/// 换了的 browser id 自然跟上。
pub fn resolve_url(ws_url: Option<&str>, active_port: Option<&str>) -> Result<String, Refusal> {
    if let Some(url) = ws_url.filter(|u| !u.trim().is_empty()) {
        return Ok(url.trim().to_string());
    }
    let Some(spec) = active_port.filter(|p| !p.trim().is_empty()) else {
        return Err(Refusal::bad_request("wsUrl or activePort is required"));
    };
    let mut file = if spec.trim() == "default" {
        default_active_port_file()
    } else {
        PathBuf::from(spec.trim())
    };
    if file.is_dir() {
        file = file.join("DevToolsActivePort");
    }
    let raw = std::fs::read_to_string(&file).map_err(|error| Refusal {
        code: "chrome_unavailable",
        detail: format!(
            "cannot read {}: {error} (is remote debugging enabled in that Chrome?)",
            file.display()
        ),
        retry_after_ms: None,
    })?;
    parse_active_port(&raw)
        .map(|(port, path)| format!("ws://127.0.0.1:{port}{path}"))
        .ok_or_else(|| {
            Refusal::bad_request(format!(
                "{} is not a DevToolsActivePort file",
                file.display()
            ))
        })
}

pub fn parse_active_port(raw: &str) -> Option<(u16, String)> {
    let mut lines = raw.lines().map(str::trim);
    let port = lines.next()?.parse::<u16>().ok().filter(|p| *p > 0)?;
    let path = lines
        .next()
        .filter(|p| p.starts_with("/devtools/browser/"))?;
    Some((port, path.to_string()))
}

/// 用户日常 Chrome（默认 profile）的 DevToolsActivePort。
pub fn default_active_port_file() -> PathBuf {
    let var = |name: &str| std::env::var(name).unwrap_or_default();
    if cfg!(target_os = "macos") {
        PathBuf::from(var("HOME"))
            .join("Library/Application Support/Google/Chrome/DevToolsActivePort")
    } else if cfg!(windows) {
        PathBuf::from(var("LOCALAPPDATA")).join("Google\\Chrome\\User Data\\DevToolsActivePort")
    } else {
        PathBuf::from(var("HOME")).join(".config/google-chrome/DevToolsActivePort")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_local_chrome_is_relayed_by_default() {
        for ok in [
            "ws://127.0.0.1:9222/devtools/browser/x",
            "ws://localhost:1/x",
            "ws://[::1]:9222/x",
            "ws://127.0.0.2:9/x",
        ] {
            assert!(validate(ok, false).is_ok(), "{ok}");
        }
        for bad in [
            "ws://example.com:9222/x",
            "ws://10.0.0.1:9222/x",
            "ws://127.0.0.1@evil.com/x",
            "http://127.0.0.1:9222/x",
            "ws:///x",
        ] {
            assert!(validate(bad, false).is_err(), "{bad}");
        }
        assert!(validate("ws://10.0.0.1:9222/x", true).is_ok());
    }

    #[test]
    fn host_case_does_not_split_a_browser_into_two_upstreams() {
        assert_eq!(
            normalize("WS://LocalHost:9222/devtools/browser/AbC"),
            "ws://localhost:9222/devtools/browser/AbC"
        );
    }

    #[test]
    fn devtools_active_port_files_are_parsed_strictly() {
        assert_eq!(
            parse_active_port("58142\n/devtools/browser/abc\n"),
            Some((58142, "/devtools/browser/abc".into()))
        );
        assert_eq!(
            parse_active_port("58142\r\n/devtools/browser/abc"),
            Some((58142, "/devtools/browser/abc".into()))
        );
        assert_eq!(parse_active_port("0\n/devtools/browser/abc"), None);
        assert_eq!(parse_active_port("58142\n/json"), None);
        assert_eq!(parse_active_port(""), None);
    }

    #[test]
    fn an_explicit_ws_url_wins_and_a_missing_file_is_reported() {
        assert_eq!(
            resolve_url(Some(" ws://127.0.0.1:1/x "), Some("default")).unwrap(),
            "ws://127.0.0.1:1/x"
        );
        let error = resolve_url(None, Some("/nonexistent/DevToolsActivePort")).unwrap_err();
        assert_eq!(error.code, "chrome_unavailable");
        assert_eq!(resolve_url(None, None).unwrap_err().code, "bad-request");
    }
}
