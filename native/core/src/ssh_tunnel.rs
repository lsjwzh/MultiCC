//! Unified SSH (port 22) TCP endpoint configuration & generic TCP/SSH probe.
//!
//! Vendor-agnostic by design: whether the user exposes port 22 via SakuraFrp,
//! cpolar, Natapp, self-hosted frpc, Tailscale, or router port-forwarding, SSH
//! always speaks the same `user@host:port` contract. Stored independently in
//! `ssh-tunnel.json` so it never touches MultiCC's port-3000 web tunnel.

use std::fs;
use std::io::{self, Read};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::state_file;

pub const DEFAULT_SSH_PORT: u16 = 22;
pub const CONFIG_FILE: &str = "ssh-tunnel.json";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTunnelConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_ssh_port")]
    pub local_port: u16,
    #[serde(default)]
    pub remote_host: String,
    #[serde(default = "default_ssh_port")]
    pub remote_port: u16,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub updated_at: u64,
}

fn default_ssh_port() -> u16 {
    DEFAULT_SSH_PORT
}

impl Default for SshTunnelConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            local_port: DEFAULT_SSH_PORT,
            remote_host: String::new(),
            remote_port: DEFAULT_SSH_PORT,
            username: String::new(),
            note: String::new(),
            updated_at: 0,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedSshEndpoint {
    pub remote_host: String,
    pub remote_port: Option<u16>,
    pub username: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TcpProbeResult {
    pub reachable: bool,
    pub ssh_banner: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestedSshEndpoint {
    pub ssh_target: String,
    pub ssh_port: u16,
    pub command: String,
    pub active: bool,
    pub note: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTunnelSnapshot {
    pub can_edit: bool,
    pub local_user: String,
    pub local_port: u16,
    pub sshd_listening: bool,
    pub remote_reachable: Option<bool>,
    pub remote_ssh_banner: Option<bool>,
    pub config: SshTunnelConfig,
    pub active: bool,
    pub suggested: Option<SuggestedSshEndpoint>,
}

/// Resolve the directory holding `ssh-tunnel.json`.
/// Isolated instances (`MULTICC_DATA_DIR`, where `data_root != package_root`)
/// keep files under `data_root`; regular installs store under `~/.multicc`.
pub fn state_dir(data_root: &Path, package_root: &Path, home: &Path) -> PathBuf {
    if data_root != package_root {
        data_root.to_path_buf()
    } else {
        home.join(".multicc")
    }
}

pub fn config_path(state_dir: &Path) -> PathBuf {
    state_dir.join(CONFIG_FILE)
}

pub fn now_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

pub fn validate_port(port: u16) -> Result<u16, String> {
    if port == 0 {
        return Err("端口号必须在 1 到 65535 之间".to_string());
    }
    Ok(port)
}

pub fn validate_host(host: &str) -> Result<String, String> {
    let trimmed = host.trim();
    if trimmed.is_empty() {
        return Err("公网主机 / IP 不能为空".to_string());
    }
    if trimmed.len() > 253 {
        return Err("主机地址过长（最多 253 个字符）".to_string());
    }
    if trimmed.starts_with('-') {
        return Err("主机地址不能以 - 开头".to_string());
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | ':' | '_' | '-'))
    {
        return Err("主机地址只能包含字母、数字、点、冒号、下划线或连字符".to_string());
    }
    Ok(trimmed.to_string())
}

pub fn validate_username(user: &str) -> Result<String, String> {
    let trimmed = user.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    if trimmed.len() > 64 {
        return Err("SSH 用户名过长（最多 64 个字符）".to_string());
    }
    if trimmed.starts_with('-') {
        return Err("SSH 用户名不能以 - 开头".to_string());
    }
    if trimmed
        .chars()
        .any(|c| c.is_control() || c.is_whitespace() || matches!(c, '@' | '/' | '\\'))
    {
        return Err("SSH 用户名包含非法字符".to_string());
    }
    Ok(trimmed.to_string())
}

pub fn validate_note(note: &str) -> Result<String, String> {
    let trimmed = note.trim();
    if trimmed.chars().count() > 64 {
        return Err("备注过长（最多 64 个字符）".to_string());
    }
    if trimmed.chars().any(char::is_control) {
        return Err("备注不能包含控制字符".to_string());
    }
    Ok(trimmed.to_string())
}

/// Parse common pasted SSH / TCP tunnel strings into structured host, port, and username:
/// - `tcp://3.tcp.cpolar.top:12345`
/// - `ssh://alice@example.com:2222`
/// - `ssh -p 12345 alice@example.com` / `ssh alice@example.com -p 12345`
/// - `alice@example.com:12345` / `alice@example.com`
/// - `example.com:12345` / `example.com`
pub fn parse_ssh_endpoint(raw: &str) -> Result<ParsedSshEndpoint, String> {
    let text = raw.trim();
    if text.is_empty() {
        return Err("请粘贴或填写 SSH 映射地址".to_string());
    }

    let mut parsed_port: Option<u16> = None;

    let mut tokens = text.split_whitespace();
    let target_token = if tokens
        .next()
        .is_some_and(|first| first.eq_ignore_ascii_case("ssh"))
    {
        let mut target: Option<&str> = None;
        let rest: Vec<&str> = tokens.collect();
        let mut idx = 0;
        while idx < rest.len() {
            let tok = rest[idx];
            if tok == "-p" {
                let port_str = rest
                    .get(idx + 1)
                    .ok_or_else(|| "ssh 命令中的 -p 缺少端口号".to_string())?;
                let port = port_str
                    .parse::<u16>()
                    .map_err(|_| "ssh 命令中的端口号无效".to_string())?;
                parsed_port = Some(validate_port(port)?);
                idx += 2;
                continue;
            }
            if let Some(port_str) = tok.strip_prefix("-p") {
                if !port_str.is_empty() {
                    let port = port_str
                        .parse::<u16>()
                        .map_err(|_| "ssh 命令中的端口号无效".to_string())?;
                    parsed_port = Some(validate_port(port)?);
                    idx += 1;
                    continue;
                }
            }
            if matches!(
                tok,
                "-i" | "-l" | "-o" | "-J" | "-F" | "-b" | "-c" | "-L" | "-R" | "-D"
            ) {
                idx += 2;
                continue;
            }
            if tok.starts_with('-') {
                idx += 1;
                continue;
            }
            if target.is_none() {
                target = Some(tok);
            }
            idx += 1;
        }
        target
            .ok_or_else(|| "未能从 ssh 命令中识别出目标主机".to_string())?
            .to_string()
    } else {
        text.to_string()
    };

    // Strip optional tcp:// or ssh:// scheme (case-insensitive) and trailing path.
    let lower = target_token.to_ascii_lowercase();
    let without_scheme = if lower.starts_with("tcp://") {
        &target_token["tcp://".len()..]
    } else if lower.starts_with("ssh://") {
        &target_token["ssh://".len()..]
    } else {
        target_token.as_str()
    };
    let authority = without_scheme.split('/').next().unwrap_or("").trim();
    if authority.is_empty() {
        return Err("映射地址缺少主机名".to_string());
    }

    let (username, host_port) = match authority.split_once('@') {
        Some((user_raw, rest)) => {
            let user = validate_username(user_raw)?;
            (if user.is_empty() { None } else { Some(user) }, rest)
        }
        None => (None, authority),
    };

    let (host_raw, inline_port) = if host_port.matches(':').count() == 1 {
        let (h, p_str) = host_port.split_once(':').unwrap();
        let port = p_str
            .parse::<u16>()
            .map_err(|_| "映射地址中的端口号无效（须为 1~65535 的整数）".to_string())?;
        (h, Some(validate_port(port)?))
    } else {
        (host_port, None)
    };

    let remote_host = validate_host(host_raw)?;
    Ok(ParsedSshEndpoint {
        remote_host,
        remote_port: parsed_port.or(inline_port),
        username,
    })
}

pub fn load_config(state_dir: &Path) -> SshTunnelConfig {
    let path = config_path(state_dir);
    let Ok(raw) = fs::read_to_string(&path) else {
        return SshTunnelConfig::default();
    };
    let mut cfg: SshTunnelConfig = serde_json::from_str(&raw).unwrap_or_default();
    if cfg.local_port == 0 {
        cfg.local_port = DEFAULT_SSH_PORT;
    }
    if cfg.remote_port == 0 {
        cfg.remote_port = DEFAULT_SSH_PORT;
    }
    cfg
}

pub fn save_config(state_dir: &Path, cfg: &SshTunnelConfig) -> io::Result<()> {
    let path = config_path(state_dir);
    let value = serde_json::to_value(cfg).unwrap_or_else(|_| json!({}));
    state_file::write_json_atomic(&path, &value)
}

pub fn current_username() -> String {
    for key in ["USER", "LOGNAME"] {
        if let Ok(val) = std::env::var(key) {
            let trimmed = val.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    if let Ok(output) = Command::new("id").arg("-un").output() {
        if output.status.success() {
            let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !text.is_empty() {
                return text;
            }
        }
    }
    "root".to_string()
}

/// Probe TCP connectivity and check whether the peer emits an `SSH-` banner.
pub fn probe_ssh_endpoint(host: &str, port: u16, timeout_ms: u64) -> TcpProbeResult {
    if port == 0 || host.trim().is_empty() {
        return TcpProbeResult {
            reachable: false,
            ssh_banner: false,
        };
    }
    let timeout = Duration::from_millis(timeout_ms.max(50));
    let Ok(addrs) = (host, port).to_socket_addrs() else {
        return TcpProbeResult {
            reachable: false,
            ssh_banner: false,
        };
    };
    for addr in addrs {
        if let Ok(mut stream) = TcpStream::connect_timeout(&addr, timeout) {
            let _ = stream.set_read_timeout(Some(Duration::from_millis(400)));
            let mut buf = [0u8; 128];
            let ssh_banner = stream
                .read(&mut buf)
                .map(|n| n >= 4 && &buf[..4] == b"SSH-")
                .unwrap_or(false);
            return TcpProbeResult {
                reachable: true,
                ssh_banner,
            };
        }
    }
    TcpProbeResult {
        reachable: false,
        ssh_banner: false,
    }
}

pub fn format_ssh_command(ssh_target: &str, ssh_port: u16) -> String {
    if ssh_port == DEFAULT_SSH_PORT {
        format!("ssh {ssh_target}")
    } else {
        format!("ssh -p {ssh_port} {ssh_target}")
    }
}

pub fn build_suggested_endpoint(
    config: &SshTunnelConfig,
    local_user: &str,
) -> Option<SuggestedSshEndpoint> {
    if !config.enabled {
        return None;
    }
    let host = validate_host(&config.remote_host).ok()?;
    let port = validate_port(config.remote_port).ok()?;
    let effective_user = if config.username.trim().is_empty() {
        local_user.trim()
    } else {
        config.username.trim()
    };
    let user = validate_username(effective_user)
        .ok()
        .filter(|u| !u.is_empty())
        .unwrap_or_else(|| "root".to_string());
    let ssh_target = format!("{user}@{host}");
    let command = format_ssh_command(&ssh_target, port);
    Some(SuggestedSshEndpoint {
        ssh_target,
        ssh_port: port,
        command,
        active: true,
        note: config.note.clone(),
    })
}

pub fn gather_snapshot_blocking(state_dir: &Path, can_edit: bool) -> SshTunnelSnapshot {
    let config = load_config(state_dir);
    let local_port = if config.local_port == 0 {
        DEFAULT_SSH_PORT
    } else {
        config.local_port
    };
    let local_user = current_username();
    let sshd_listening = probe_ssh_endpoint("127.0.0.1", local_port, 250).reachable;
    let active =
        config.enabled && validate_host(&config.remote_host).is_ok() && config.remote_port > 0;
    let (remote_reachable, remote_ssh_banner) = if active {
        let probe = probe_ssh_endpoint(&config.remote_host, config.remote_port, 1500);
        (Some(probe.reachable), Some(probe.ssh_banner))
    } else {
        (None, None)
    };
    let suggested = build_suggested_endpoint(&config, &local_user);
    SshTunnelSnapshot {
        can_edit,
        local_user,
        local_port,
        sshd_listening,
        remote_reachable,
        remote_ssh_banner,
        config,
        active,
        suggested,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpListener;

    fn temp_dir(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "multicc-ssh-tunnel-test-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn parses_common_pasted_endpoint_formats() {
        let cpolar = parse_ssh_endpoint("tcp://3.tcp.cpolar.top:12345").unwrap();
        assert_eq!(cpolar.remote_host, "3.tcp.cpolar.top");
        assert_eq!(cpolar.remote_port, Some(12345));
        assert_eq!(cpolar.username, None);

        let ssh_cmd = parse_ssh_endpoint("ssh -p 2222 alice@cn-sh.example.com").unwrap();
        assert_eq!(ssh_cmd.remote_host, "cn-sh.example.com");
        assert_eq!(ssh_cmd.remote_port, Some(2222));
        assert_eq!(ssh_cmd.username.as_deref(), Some("alice"));

        let ssh_trailing = parse_ssh_endpoint("ssh bob@mac.tail.ts.net -p 2200").unwrap();
        assert_eq!(ssh_trailing.remote_host, "mac.tail.ts.net");
        assert_eq!(ssh_trailing.remote_port, Some(2200));
        assert_eq!(ssh_trailing.username.as_deref(), Some("bob"));

        let user_host_port = parse_ssh_endpoint("me@1.2.3.4:31234").unwrap();
        assert_eq!(user_host_port.remote_host, "1.2.3.4");
        assert_eq!(user_host_port.remote_port, Some(31234));
        assert_eq!(user_host_port.username.as_deref(), Some("me"));

        let bare = parse_ssh_endpoint("mac-mini.tail.ts.net").unwrap();
        assert_eq!(bare.remote_host, "mac-mini.tail.ts.net");
        assert_eq!(bare.remote_port, None);
        assert_eq!(bare.username, None);

        assert!(parse_ssh_endpoint("-oProxyCommand=id").is_err());
        assert!(parse_ssh_endpoint("host:99999").is_err());
        assert!(parse_ssh_endpoint("").is_err());
    }

    #[test]
    fn host_username_and_note_validation_reject_injection() {
        assert!(validate_host("3.tcp.cpolar.top").is_ok());
        assert!(validate_host("-oProxyCommand=id").is_err());
        assert!(validate_host("host name").is_err());
        assert!(validate_host("bad\nhost").is_err());
        assert!(validate_host("").is_err());

        assert!(validate_username("").is_ok());
        assert!(validate_username("zhuanz").is_ok());
        assert!(validate_username("-root").is_err());
        assert!(validate_username("me@host").is_err());
        assert!(validate_username("user name").is_err());

        assert!(validate_note("SakuraFrp 节点").is_ok());
        assert!(validate_note("bad\nnote").is_err());
    }

    #[test]
    fn config_roundtrip_and_legacy_json_compat() {
        let dir = temp_dir("cfg");
        // Legacy JSON with old provider/pid/sakuraTunnelId fields must deserialize cleanly.
        fs::write(
            config_path(&dir),
            r#"{"enabled":true,"provider":"cpolar","localPort":22,"remoteHost":"3.tcp.cpolar.top","remotePort":12345,"username":"alice","pid":99999,"sakuraTunnelId":"42"}"#,
        )
        .unwrap();
        let loaded = load_config(&dir);
        assert!(loaded.enabled);
        assert_eq!(loaded.remote_host, "3.tcp.cpolar.top");
        assert_eq!(loaded.remote_port, 12345);
        assert_eq!(loaded.username, "alice");

        let next = SshTunnelConfig {
            enabled: true,
            local_port: 22,
            remote_host: "ssh.example.com".to_string(),
            remote_port: 2222,
            username: "bob".to_string(),
            note: "SakuraFrp".to_string(),
            updated_at: 123456,
        };
        save_config(&dir, &next).unwrap();
        assert_eq!(load_config(&dir), next);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn suggested_endpoint_only_emits_when_enabled() {
        let mut cfg = SshTunnelConfig {
            enabled: true,
            local_port: 22,
            remote_host: "3.tcp.cpolar.top".to_string(),
            remote_port: 12345,
            username: String::new(),
            note: "cpolar".to_string(),
            updated_at: 1,
        };
        let ep = build_suggested_endpoint(&cfg, "bob").unwrap();
        assert_eq!(ep.ssh_target, "bob@3.tcp.cpolar.top");
        assert_eq!(ep.ssh_port, 12345);
        assert_eq!(ep.command, "ssh -p 12345 bob@3.tcp.cpolar.top");
        assert_eq!(ep.note, "cpolar");

        cfg.enabled = false;
        assert!(build_suggested_endpoint(&cfg, "bob").is_none());
    }

    #[test]
    fn probe_detects_real_ssh_banner_on_loopback() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let _ = stream.write_all(b"SSH-2.0-OpenSSH_9.0\r\n");
            }
        });
        let probe = probe_ssh_endpoint("127.0.0.1", port, 500);
        handle.join().unwrap();
        assert!(probe.reachable);
        assert!(probe.ssh_banner);
    }
}
