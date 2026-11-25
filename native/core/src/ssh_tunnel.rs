//! One-click SSH (port 22) TCP tunnel preset & endpoint discovery.
//!
//! Runs independently from MultiCC's primary HTTP (port 3000) tunnel configuration
//! (`tunnel-config.json`) so mapping SSH for `mcssh1.` / Mutagen never overwrites
//! the user's web/API tunnel.

use std::fs;
use std::io;
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::state_file;

pub const DEFAULT_SSH_PORT: u16 = 22;
pub const CONFIG_FILE: &str = "ssh-tunnel.json";
pub const CPOLAR_LOG_FILE: &str = "ssh-cpolar.log";
pub const TAILSCALE_SSH_NOTE: &str =
    "仅限同一 Tailnet 内设备直连（Tailscale Funnel 不支持原始 TCP 22）";

pub const CPOLAR_BIN_CANDIDATES: &[&str] = &[
    "/usr/local/bin/cpolar",
    "/opt/homebrew/bin/cpolar",
    "/usr/bin/cpolar",
];
pub const TAILSCALE_BIN_CANDIDATES: &[&str] = &[
    "/usr/local/bin/tailscale",
    "/opt/homebrew/bin/tailscale",
    "/usr/bin/tailscale",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SshTunnelProvider {
    Auto,
    Cpolar,
    Sakurafrp,
    Tailscale,
    Custom,
}

impl SshTunnelProvider {
    pub fn parse(raw: &str) -> Result<Self, String> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "" | "auto" => Ok(Self::Auto),
            "cpolar" => Ok(Self::Cpolar),
            "sakurafrp" => Ok(Self::Sakurafrp),
            "tailscale" => Ok(Self::Tailscale),
            "custom" => Ok(Self::Custom),
            other => Err(format!("不支持的 SSH 映射通道: {other}")),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Cpolar => "cpolar",
            Self::Sakurafrp => "sakurafrp",
            Self::Tailscale => "tailscale",
            Self::Custom => "custom",
        }
    }

    pub fn display_label(raw: &str) -> &'static str {
        match raw {
            "cpolar" => "cpolar TCP",
            "sakurafrp" => "SakuraFrp TCP",
            "tailscale" => "Tailscale 内网直连",
            "custom" => "自定义映射",
            "configured" => "已保存映射",
            _ => "SSH 映射",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTunnelConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_provider")]
    pub provider: String,
    #[serde(default = "default_ssh_port")]
    pub local_port: u16,
    #[serde(default)]
    pub remote_host: String,
    #[serde(default = "default_ssh_port")]
    pub remote_port: u16,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub sakura_tunnel_id: Option<String>,
    #[serde(default)]
    pub pid: Option<u32>,
    #[serde(default)]
    pub updated_at: u64,
}

fn default_provider() -> String {
    "cpolar".to_string()
}

fn default_ssh_port() -> u16 {
    DEFAULT_SSH_PORT
}

impl Default for SshTunnelConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            provider: default_provider(),
            local_port: DEFAULT_SSH_PORT,
            remote_host: String::new(),
            remote_port: DEFAULT_SSH_PORT,
            username: String::new(),
            sakura_tunnel_id: None,
            pid: None,
            updated_at: 0,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SakuraSshCandidate {
    pub tunnel_id: String,
    pub name: String,
    pub online: bool,
    pub remote_host: String,
    pub remote_port: u16,
    pub node_name: String,
    pub local_port: Option<u16>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CpolarCandidate {
    pub available: bool,
    pub bin_path: Option<String>,
    pub running_pid: Option<u32>,
    pub alive: bool,
    pub remote_host: Option<String>,
    pub remote_port: Option<u16>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SakuraCandidateSummary {
    pub has_token: bool,
    pub tunnel: Option<SakuraSshCandidate>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TailscaleCandidate {
    pub available: bool,
    pub host: Option<String>,
    pub note: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidatesSnapshot {
    pub cpolar: CpolarCandidate,
    pub sakurafrp: SakuraCandidateSummary,
    pub tailscale: TailscaleCandidate,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestedSshEndpoint {
    pub source: String,
    pub provider_label: String,
    pub ssh_target: String,
    pub ssh_port: u16,
    pub command: String,
    pub active: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTunnelSnapshot {
    pub can_edit: bool,
    pub local_user: String,
    pub local_port: u16,
    pub sshd_listening: bool,
    pub config: SshTunnelConfig,
    pub active: bool,
    pub pid_alive: bool,
    pub candidates: CandidatesSnapshot,
    pub suggested: Option<SuggestedSshEndpoint>,
}

/// Resolve the directory holding `ssh-tunnel.json` and `ssh-cpolar.log`.
/// Isolated instances (`MULTICC_DATA_DIR`, where `data_root != package_root`)
/// keep all files under `data_root`; regular installs store under `~/.multicc`.
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

pub fn cpolar_log_path(state_dir: &Path) -> PathBuf {
    state_dir.join(CPOLAR_LOG_FILE)
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
        return Err("映射公网地址不能为空".to_string());
    }
    if trimmed.len() > 253 {
        return Err("映射地址过长（最多 253 个字符）".to_string());
    }
    if trimmed.starts_with('-') {
        return Err("映射地址不能以 - 开头".to_string());
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | ':' | '_' | '-'))
    {
        return Err("映射地址只能包含字母、数字、点、冒号、下划线或连字符".to_string());
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
    if SshTunnelProvider::parse(&cfg.provider).is_err() || cfg.provider == "auto" {
        cfg.provider = default_provider();
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

pub fn probe_tcp(host: &str, port: u16, timeout_ms: u64) -> bool {
    if port == 0 {
        return false;
    }
    let timeout = Duration::from_millis(timeout_ms.max(50));
    let Ok(addrs) = (host, port).to_socket_addrs() else {
        return false;
    };
    for addr in addrs {
        if TcpStream::connect_timeout(&addr, timeout).is_ok() {
            return true;
        }
    }
    false
}

pub fn find_binary(candidates: &[&str], name: &str) -> Option<PathBuf> {
    for candidate in candidates {
        let p = Path::new(candidate);
        if is_executable_file(p) {
            return Some(p.to_path_buf());
        }
    }
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        let full = dir.join(name);
        if is_executable_file(&full) {
            return Some(full);
        }
    }
    None
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(meta) = fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        (meta.permissions().mode() & 0o111) != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

pub fn is_pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    #[cfg(unix)]
    {
        let Ok(raw_pid) = i32::try_from(pid) else {
            return false;
        };
        unsafe { libc::kill(raw_pid, 0) == 0 }
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        false
    }
}

fn process_looks_like_cpolar(pid: u32) -> bool {
    let Ok(output) = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "comm="])
        .output()
    else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    String::from_utf8_lossy(&output.stdout)
        .to_ascii_lowercase()
        .contains("cpolar")
}

/// Gracefully stop a previously spawned `cpolar tcp` process tracked by PID.
/// Never uses `pkill -f` so a user's primary HTTP (port 3000) cpolar stays intact.
pub fn stop_cpolar_ssh(pid: u32) -> Result<bool, String> {
    if pid == 0 || !is_pid_alive(pid) {
        return Ok(false);
    }
    if !process_looks_like_cpolar(pid) {
        return Ok(false);
    }
    #[cfg(unix)]
    {
        let raw_pid = i32::try_from(pid).map_err(|_| "无效进程 ID".to_string())?;
        let rc = unsafe { libc::kill(raw_pid, libc::SIGTERM) };
        if rc != 0 {
            return Err(format!(
                "停止 cpolar 进程失败 (pid={pid}): {}",
                io::Error::last_os_error()
            ));
        }
        for _ in 0..15 {
            if !is_pid_alive(pid) {
                return Ok(true);
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        Ok(true)
    }
    #[cfg(not(unix))]
    {
        Ok(false)
    }
}

pub fn read_cpolar_authtoken(data_root: &Path) -> Option<String> {
    let raw = fs::read_to_string(data_root.join("tunnel-config.json")).ok()?;
    let val: Value = serde_json::from_str(&raw).ok()?;
    val.pointer("/cpolar/authtoken")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Spawn a detached `cpolar tcp <local_port>` instance logging to `ssh-cpolar.log`.
pub fn start_cpolar_ssh(
    state_dir: &Path,
    data_root: &Path,
    home: &Path,
    local_port: u16,
    previous_pid: Option<u32>,
) -> Result<u32, String> {
    validate_port(local_port)?;
    let bin = find_binary(CPOLAR_BIN_CANDIDATES, "cpolar")
        .ok_or_else(|| "未检测到 cpolar 客户端，请先安装后再使用".to_string())?;
    if let Some(pid) = previous_pid {
        let _ = stop_cpolar_ssh(pid);
    }
    // Only seed ~/.cpolar/cpolar.yml if missing and MultiCC already stores a token.
    if !home.join(".cpolar").join("cpolar.yml").exists() {
        if let Some(token) = read_cpolar_authtoken(data_root) {
            let _ = Command::new(&bin)
                .args(["authtoken", &token])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }
    fs::create_dir_all(state_dir).map_err(|e| format!("创建状态目录失败: {e}"))?;
    let log_path = cpolar_log_path(state_dir);
    let stdout_file = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&log_path)
        .map_err(|e| format!("打开 cpolar 日志文件失败: {e}"))?;
    let stderr_file = stdout_file
        .try_clone()
        .map_err(|e| format!("打开 cpolar 错误日志失败: {e}"))?;
    let child = Command::new(&bin)
        .args(["tcp", &local_port.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout_file))
        .stderr(Stdio::from(stderr_file))
        .spawn()
        .map_err(|e| format!("启动 cpolar tcp {local_port} 失败: {e}"))?;
    Ok(child.id())
}

/// Parse the latest `tcp://<host>:<port>` endpoint from cpolar stdout/log lines
/// or cpolar's local web UI JSON (`/api/tunnels`).
pub fn parse_cpolar_tcp_endpoint(text: &str) -> Option<(String, u16)> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        if let Ok(val) = serde_json::from_str::<Value>(trimmed) {
            let arr = val
                .get("tunnels")
                .and_then(Value::as_array)
                .or_else(|| val.as_array());
            if let Some(items) = arr {
                for item in items {
                    let proto = item.get("proto").and_then(Value::as_str).unwrap_or("");
                    let public_url = item.get("public_url").and_then(Value::as_str).unwrap_or("");
                    if (proto.eq_ignore_ascii_case("tcp") || public_url.starts_with("tcp://"))
                        && !public_url.is_empty()
                    {
                        if let Some(ep) = extract_tcp_url(public_url) {
                            return Some(ep);
                        }
                    }
                }
            }
        }
    }
    let mut found = None;
    let mut rest = trimmed;
    while let Some(idx) = rest.find("tcp://") {
        let after = &rest[idx..];
        if let Some(ep) = extract_tcp_url(after) {
            found = Some(ep);
        }
        rest = &rest[idx + "tcp://".len()..];
    }
    found
}

fn extract_tcp_url(raw: &str) -> Option<(String, u16)> {
    let after = raw.strip_prefix("tcp://")?;
    let token: String = after
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | ':' | '-' | '_'))
        .collect();
    let (host, port_str) = token.rsplit_once(':')?;
    let host = validate_host(host).ok()?;
    let port: u16 = port_str.parse().ok()?;
    validate_port(port).ok()?;
    Some((host, port))
}

/// Read SakuraFrp API token without ever returning or logging it.
pub fn read_sakura_token(data_root: &Path, home: &Path) -> Option<String> {
    if let Ok(raw) = fs::read_to_string(data_root.join("tunnel-config.json")) {
        if let Ok(val) = serde_json::from_str::<Value>(&raw) {
            if let Some(token) = val
                .pointer("/sakurafrp/authtoken")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                return Some(token.to_string());
            }
        }
    }
    if cfg!(target_os = "macos") {
        let launcher_cfg = home
            .join("Library")
            .join("Containers")
            .join("com.natfrp.launcher")
            .join("Data")
            .join("Library")
            .join("Application Support")
            .join("natfrp-service")
            .join("config.json");
        if let Ok(raw) = fs::read_to_string(launcher_cfg) {
            if let Ok(val) = serde_json::from_str::<Value>(&raw) {
                if let Some(token) = val
                    .get("token")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| {
                        (16..=64).contains(&s.len()) && s.chars().all(|c| c.is_ascii_alphanumeric())
                    })
                {
                    return Some(token.to_string());
                }
            }
        }
    }
    None
}

fn json_u16(val: Option<&Value>) -> Option<u16> {
    let v = val?;
    if let Some(n) = v.as_u64() {
        return u16::try_from(n).ok().filter(|p| *p > 0);
    }
    v.as_str()
        .and_then(|s| s.trim().parse::<u16>().ok())
        .filter(|p| *p > 0)
}

fn json_id_string(val: Option<&Value>) -> Option<String> {
    let v = val?;
    if let Some(s) = v.as_str() {
        let trimmed = s.trim();
        return (!trimmed.is_empty()).then(|| trimmed.to_string());
    }
    v.as_u64()
        .map(|n| n.to_string())
        .or_else(|| v.as_i64().map(|n| n.to_string()))
}

/// Select the best TCP tunnel for local SSH (port 22) from SakuraFrp `/tunnels`
/// and `/nodes` JSON payloads.
pub fn select_sakura_ssh_tunnel(
    tunnels: &Value,
    nodes: &Value,
    local_port: u16,
    preferred_id: Option<&str>,
) -> Option<SakuraSshCandidate> {
    let items = tunnels.as_array()?;
    let nodes_obj = nodes.as_object();
    let mut scored: Vec<(i32, SakuraSshCandidate)> = Vec::new();

    for tunnel in items {
        let Some(obj) = tunnel.as_object() else {
            continue;
        };
        let t_type = obj.get("type").and_then(Value::as_str).unwrap_or("");
        if !t_type.eq_ignore_ascii_case("tcp") {
            continue;
        }
        let local = json_u16(obj.get("local_port").or_else(|| obj.get("localPort")));
        if let Some(lp) = local {
            if lp != local_port {
                continue;
            }
        }
        let Some(tunnel_id) = json_id_string(obj.get("id")) else {
            continue;
        };
        let Some(remote_port) = json_u16(obj.get("remote")) else {
            continue;
        };
        let Some(node_id) = json_id_string(obj.get("node")) else {
            continue;
        };
        let node = nodes_obj.and_then(|m| m.get(&node_id));
        let Some(raw_host) = node.and_then(|n| n.get("host")).and_then(Value::as_str) else {
            continue;
        };
        let Ok(remote_host) = validate_host(raw_host) else {
            continue;
        };
        let name = obj
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let node_name = node
            .and_then(|n| n.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let online = obj.get("online").and_then(Value::as_bool).unwrap_or(false);

        let mut score = 0;
        if preferred_id.is_some_and(|pref| pref == tunnel_id) {
            score += 1000;
        }
        if online {
            score += 100;
        }
        if local == Some(local_port) {
            score += 20;
        }
        if name.to_ascii_lowercase().contains("ssh") {
            score += 10;
        }

        scored.push((
            score,
            SakuraSshCandidate {
                tunnel_id,
                name,
                online,
                remote_host,
                remote_port,
                node_name,
                local_port: local,
            },
        ));
    }

    scored.sort_by(|a, b| b.0.cmp(&a.0));
    scored.into_iter().next().map(|(_, candidate)| candidate)
}

pub fn parse_tailscale_ssh_host(json: &Value) -> Option<String> {
    let self_node = json.get("Self")?;
    if let Some(dns) = self_node.get("DNSName").and_then(Value::as_str) {
        let trimmed = dns.trim().trim_end_matches('.');
        if let Ok(host) = validate_host(trimmed) {
            return Some(host);
        }
    }
    if let Some(ips) = self_node.get("TailscaleIPs").and_then(Value::as_array) {
        for ip in ips {
            if let Some(raw) = ip.as_str() {
                if let Ok(host) = validate_host(raw) {
                    return Some(host);
                }
            }
        }
    }
    None
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
    cpolar: &CpolarCandidate,
    sakura: &SakuraCandidateSummary,
    tailscale: &TailscaleCandidate,
) -> Option<SuggestedSshEndpoint> {
    let effective_user = if config.username.trim().is_empty() {
        local_user.trim()
    } else {
        config.username.trim()
    };
    let user = validate_username(effective_user)
        .ok()
        .filter(|u| !u.is_empty())
        .unwrap_or_else(|| "root".to_string());

    let make =
        |source: &str, host: &str, port: u16, active: bool| -> Option<SuggestedSshEndpoint> {
            let host = validate_host(host).ok()?;
            let port = validate_port(port).ok()?;
            let ssh_target = format!("{user}@{host}");
            let command = format_ssh_command(&ssh_target, port);
            Some(SuggestedSshEndpoint {
                source: source.to_string(),
                provider_label: SshTunnelProvider::display_label(source).to_string(),
                ssh_target,
                ssh_port: port,
                command,
                active,
            })
        };

    if config.enabled {
        match config.provider.as_str() {
            "cpolar" => {
                if cpolar.alive {
                    if let (Some(host), Some(port)) = (&cpolar.remote_host, cpolar.remote_port) {
                        return make("cpolar", host, port, true);
                    }
                    if let Some(ep) = make("cpolar", &config.remote_host, config.remote_port, true)
                    {
                        return Some(ep);
                    }
                }
            }
            "sakurafrp" => {
                if let Some(t) = &sakura.tunnel {
                    return make("sakurafrp", &t.remote_host, t.remote_port, t.online);
                }
                if let Some(ep) = make("sakurafrp", &config.remote_host, config.remote_port, true) {
                    return Some(ep);
                }
            }
            "tailscale" => {
                if let Some(host) = &tailscale.host {
                    return make("tailscale", host, config.local_port, true);
                }
                if let Some(ep) = make("tailscale", &config.remote_host, config.remote_port, true) {
                    return Some(ep);
                }
            }
            _ => {
                if let Some(ep) = make(
                    &config.provider,
                    &config.remote_host,
                    config.remote_port,
                    true,
                ) {
                    return Some(ep);
                }
            }
        }
    }

    if let Some(t) = sakura.tunnel.as_ref().filter(|t| t.online) {
        return make("sakurafrp", &t.remote_host, t.remote_port, false);
    }
    if cpolar.alive {
        if let (Some(host), Some(port)) = (&cpolar.remote_host, cpolar.remote_port) {
            return make("cpolar", host, port, false);
        }
    }
    if let Some(host) = &tailscale.host {
        let port = validate_port(config.local_port).unwrap_or(DEFAULT_SSH_PORT);
        return make("tailscale", host, port, false);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn parses_cpolar_endpoint_from_log_and_api_json() {
        let log = "cpolar running\nTunnel established at tcp://3.tcp.cpolar.top:12345\n";
        assert_eq!(
            parse_cpolar_tcp_endpoint(log),
            Some(("3.tcp.cpolar.top".to_string(), 12345))
        );
        let api_json = r#"{"tunnels":[{"name":"ssh","proto":"tcp","public_url":"tcp://9.tcp.vip.cpolar.cn:24680"}]}"#;
        assert_eq!(
            parse_cpolar_tcp_endpoint(api_json),
            Some(("9.tcp.vip.cpolar.cn".to_string(), 24680))
        );
        assert_eq!(parse_cpolar_tcp_endpoint("no endpoint here"), None);
    }

    #[test]
    fn selects_online_sakura_tcp_22_tunnel_and_skips_http() {
        let tunnels = json!([
            { "id": 10, "name": "web", "type": "https", "online": true, "node": 1, "remote": 443, "local_port": 3000 },
            { "id": 11, "name": "ssh-offline", "type": "tcp", "online": false, "node": 1, "remote": 20011, "local_port": 22 },
            { "id": 12, "name": "ssh-main", "type": "tcp", "online": true, "node": 2, "remote": 31234, "local_port": 22 }
        ]);
        let nodes = json!({
            "1": { "name": "Node A", "host": "frp-a.example" },
            "2": { "name": "Shanghai BGP", "host": "cn-sh.example" }
        });
        let picked = select_sakura_ssh_tunnel(&tunnels, &nodes, 22, None).unwrap();
        assert_eq!(picked.tunnel_id, "12");
        assert_eq!(picked.remote_host, "cn-sh.example");
        assert_eq!(picked.remote_port, 31234);
        assert!(picked.online);

        let preferred = select_sakura_ssh_tunnel(&tunnels, &nodes, 22, Some("11")).unwrap();
        assert_eq!(preferred.tunnel_id, "11");
    }

    #[test]
    fn parses_tailscale_dns_and_ip_fallback() {
        let with_dns = json!({
            "Self": {
                "DNSName": "mac-mini.tail1234.ts.net.",
                "TailscaleIPs": ["100.64.0.10"]
            }
        });
        assert_eq!(
            parse_tailscale_ssh_host(&with_dns).as_deref(),
            Some("mac-mini.tail1234.ts.net")
        );
        let ip_only = json!({
            "Self": {
                "DNSName": "",
                "TailscaleIPs": ["100.64.0.10"]
            }
        });
        assert_eq!(
            parse_tailscale_ssh_host(&ip_only).as_deref(),
            Some("100.64.0.10")
        );
    }

    #[test]
    fn host_and_username_validation_reject_injection() {
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
    }

    #[test]
    fn config_roundtrip_is_atomic_and_defaults_safely() {
        let dir = temp_dir("cfg");
        let loaded_empty = load_config(&dir);
        assert!(!loaded_empty.enabled);
        assert_eq!(loaded_empty.local_port, 22);

        let cfg = SshTunnelConfig {
            enabled: true,
            provider: "custom".to_string(),
            local_port: 22,
            remote_host: "ssh.example.com".to_string(),
            remote_port: 2222,
            username: "alice".to_string(),
            sakura_tunnel_id: None,
            pid: None,
            updated_at: 123456,
        };
        save_config(&dir, &cfg).unwrap();
        let loaded = load_config(&dir);
        assert_eq!(loaded, cfg);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn suggested_endpoint_builds_target_and_command() {
        let cfg = SshTunnelConfig {
            enabled: true,
            provider: "custom".to_string(),
            local_port: 22,
            remote_host: "3.tcp.cpolar.top".to_string(),
            remote_port: 12345,
            username: "".to_string(),
            sakura_tunnel_id: None,
            pid: None,
            updated_at: 1,
        };
        let empty_candidates = (
            CpolarCandidate {
                available: false,
                bin_path: None,
                running_pid: None,
                alive: false,
                remote_host: None,
                remote_port: None,
            },
            SakuraCandidateSummary {
                has_token: false,
                tunnel: None,
                error: None,
            },
            TailscaleCandidate {
                available: false,
                host: None,
                note: TAILSCALE_SSH_NOTE.to_string(),
            },
        );
        let ep = build_suggested_endpoint(
            &cfg,
            "bob",
            &empty_candidates.0,
            &empty_candidates.1,
            &empty_candidates.2,
        )
        .unwrap();
        assert_eq!(ep.ssh_target, "bob@3.tcp.cpolar.top");
        assert_eq!(ep.ssh_port, 12345);
        assert_eq!(ep.command, "ssh -p 12345 bob@3.tcp.cpolar.top");
        assert!(ep.active);
    }
}
