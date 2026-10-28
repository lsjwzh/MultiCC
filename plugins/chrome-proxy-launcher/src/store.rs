//! 身份（profile）存取：所有落盘都在 `~/.multicc/plugins-data/chrome-proxy-launcher/`。
//!
//! 布局：
//!   profiles.json                     身份清单（原子写：tmp + rename）
//!   subscriptions.json                订阅清单（名称 / URL / 节点名缓存）
//!   subscriptions/<id>.yaml           订阅拉下来的完整 Clash 配置原文
//!   run/<id>.pid                      launch 后记录的主进程 pid
//!   run/<id>.relay.json               带凭据直连代理的本地中继
//!   run/<id>.core.pid                 订阅出口的 meow 内核 pid
//!   core/<id>/                        每个身份的内核工作目录（config.yaml 等）
//!   chrome-profiles/<id>/             每个身份独立的 Chrome user-data-dir
//!
//! id 只含 ASCII 安全字符（slug 或 profile-N），目录名直接用 id，不会出现
//! 中文/空格路径被各层编码搞坏的问题；显示名（name）保持用户原文。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyConfig {
    pub scheme: String, // http | https | socks5
    pub host: String,
    pub port: u16,
    // 代理要求认证时填（Chrome 自己带不了代理凭据，launch 会起本地中继代认证）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
}

impl ProxyConfig {
    /// 仅测试构造用（生产路径一律从 manifest/input 解析）。
    #[cfg(test)]
    pub fn new(scheme: &str, host: &str, port: u16) -> Self {
        Self {
            scheme: scheme.into(),
            host: host.into(),
            port,
            username: None,
            password: None,
        }
    }

    pub fn has_credentials(&self) -> bool {
        self.username.as_deref().is_some_and(|u| !u.is_empty())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    /// 直连代理出口。老数据里一定有；订阅出口时为空。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy: Option<ProxyConfig>,
    /// 订阅出口：订阅里的某个节点（可再经它跳板到上游住宅代理）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subscription: Option<SubscriptionEgress>,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub chrome_path: Option<String>,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

/// 订阅出口 = 跳板节点 + 可选上游代理。链路：
///   本机 → 中继 → (meow 跳板) 订阅节点 → 上游住宅代理 → 目标站
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionEgress {
    /// 订阅 id（subscriptions.json 里的条目）。
    pub id: String,
    /// 节点名；空 = 用订阅里的第一个节点。
    #[serde(default)]
    pub node: String,
    /// 经该节点跳板后才可达的上游代理（家宽/住宅代理通常如此）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub via: Option<ProxyConfig>,
}

/// 一份订阅：URL + 拉取结果的元信息。节点名缓存起来给 UI 选，配置原文
/// 单独落在 subscriptions/<id>.yaml（可能上百 KB，不塞进清单 JSON）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Subscription {
    pub id: String,
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub nodes: Vec<String>,
    /// 订阅服务器回的 traffic 头（流量/到期信息），原样展示。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub traffic: Option<String>,
    #[serde(default)]
    pub source_bytes: u64,
}

pub fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub fn home_dir() -> PathBuf {
    // 不引 dirs crate：两个平台变量足够，缺省落到 /tmp（只影响极端环境）。
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"))
}

pub fn data_dir() -> PathBuf {
    #[cfg(feature = "gapaw-read-bridge-test")]
    {
        // 仅显式测试构建可注入数据根，缺失或不属于夹具目录时立即停止，禁止回退生产数据。
        let root = PathBuf::from(std::env::var_os("CHROME_READ_TEST_ROOT").expect("测试构建必须指定 CHROME_READ_TEST_ROOT"));
        assert!(root.is_absolute() && root.parent() == Some(std::path::Path::new("/tmp")) && root.file_name().and_then(|v| v.to_str()).is_some_and(|v| v.starts_with("cbr-")), "测试数据根必须是 /tmp/cbr-* 专用目录");
        let meta = fs::symlink_metadata(&root).expect("测试根目录不存在");
        assert!(meta.is_dir() && !meta.file_type().is_symlink(), "测试根目录不能是符号链接");
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            assert!(meta.uid() == unsafe { libc::geteuid() } && meta.permissions().mode() & 0o077 == 0, "测试根目录属主或权限无效");
        }
        let data = root.join("source-data");
        if let Ok(meta) = fs::symlink_metadata(&data) {
            assert!(meta.is_dir() && !meta.file_type().is_symlink(), "测试数据目录不能是符号链接");
        }
        return data;
    }
    #[cfg(not(feature = "gapaw-read-bridge-test"))]
    home_dir().join(".multicc").join("plugins-data").join("chrome-proxy-launcher")
}

/// 数据目录里有每个身份的登录 cookie、代理账密和订阅 token：整个目录只给本人
/// （0700），清单文件 0600。每条命令开头调一次，旧版本按默认权限建的目录也会
/// 被收紧。失败不阻断命令（例如目录还不存在）。
/// 含账密/token 的文件在 rename 之前就收成 0600，避免出现可读的空窗。
fn private_file(path: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    let _ = path;
}

pub fn lock_down() {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let dir = data_dir();
        if fs::create_dir_all(&dir).is_ok() {
            let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
        }
        for file in [profiles_file(), subscriptions_file()] {
            if file.exists() {
                private_file(&file);
            }
        }
    }
}

pub fn profiles_file() -> PathBuf {
    data_dir().join("profiles.json")
}

pub fn subscriptions_file() -> PathBuf {
    data_dir().join("subscriptions.json")
}

/// 订阅拉下来的配置原文（meow 可直接吃的完整 Clash 配置）。
pub fn subscription_config_file(id: &str) -> PathBuf {
    data_dir().join("subscriptions").join(format!("{id}.yaml"))
}

/// 每个身份的内核目录：config.yaml + 内核自己的缓存。
pub fn core_dir(id: &str) -> PathBuf {
    data_dir().join("core").join(id)
}

pub fn core_pid_file(id: &str) -> PathBuf {
    data_dir().join("run").join(format!("{id}.core.pid"))
}

/// 内核的 {pid, port}：probe 复用运行中的内核时要知道它监听哪个端口。
pub fn core_info_file(id: &str) -> PathBuf {
    data_dir().join("run").join(format!("{id}.core.json"))
}

pub fn clear_core_info(id: &str) {
    let _ = fs::remove_file(core_info_file(id));
}

pub fn read_core_pid(id: &str) -> Option<i32> {
    let text = fs::read_to_string(core_pid_file(id)).ok()?;
    text.trim().parse::<i32>().ok()
}

pub fn write_core_pid(id: &str, pid: i32) -> Result<(), String> {
    let dir = data_dir().join("run");
    fs::create_dir_all(&dir).map_err(|err| format!("创建运行目录失败：{err}"))?;
    fs::write(core_pid_file(id), pid.to_string()).map_err(|err| format!("写入内核 pid 失败：{err}"))
}

pub fn clear_core_pid(id: &str) {
    let _ = fs::remove_file(core_pid_file(id));
}

pub fn pid_file(id: &str) -> PathBuf {
    data_dir().join("run").join(format!("{id}.pid"))
}

/// 带凭据代理的本地中继：relay 进程把 {pid, port} 写这里，launch 轮询等它就绪。
pub fn relay_file(id: &str) -> PathBuf {
    data_dir().join("run").join(format!("{id}.relay.json"))
}

pub fn read_relay(id: &str) -> Option<(i32, u16)> {
    let text = fs::read_to_string(relay_file(id)).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    let pid = value.get("pid")?.as_i64()? as i32;
    let port = value.get("port")?.as_u64()? as u16;
    Some((pid, port))
}

pub fn clear_relay(id: &str) {
    let _ = fs::remove_file(relay_file(id));
}

pub fn user_data_dir(id: &str) -> PathBuf {
    data_dir().join("chrome-profiles").join(id)
}

pub fn load_profiles() -> Result<Vec<Profile>, String> {
    let raw = match fs::read(profiles_file()) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(format!("读取身份清单失败：{err}")),
    };
    serde_json::from_slice(&raw).map_err(|err| format!("身份清单不是合法 JSON：{err}"))
}

pub fn save_profiles(profiles: &[Profile]) -> Result<(), String> {
    let dir = data_dir();
    fs::create_dir_all(&dir).map_err(|err| format!("创建数据目录失败：{err}"))?;
    let file = profiles_file();
    let tmp = dir.join(".profiles.json.tmp");
    let bytes = serde_json::to_vec_pretty(profiles).map_err(|err| err.to_string())?;
    fs::write(&tmp, bytes).map_err(|err| format!("写入身份清单失败：{err}"))?;
    private_file(&tmp);
    fs::rename(&tmp, &file).map_err(|err| format!("替换身份清单失败：{err}"))
}

pub fn load_subscriptions() -> Result<Vec<Subscription>, String> {
    let raw = match fs::read(subscriptions_file()) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(format!("读取订阅清单失败：{err}")),
    };
    serde_json::from_slice(&raw).map_err(|err| format!("订阅清单不是合法 JSON：{err}"))
}

pub fn save_subscriptions(subs: &[Subscription]) -> Result<(), String> {
    let dir = data_dir();
    fs::create_dir_all(&dir).map_err(|err| format!("创建数据目录失败：{err}"))?;
    let file = subscriptions_file();
    let tmp = dir.join(".subscriptions.json.tmp");
    let bytes = serde_json::to_vec_pretty(subs).map_err(|err| err.to_string())?;
    fs::write(&tmp, bytes).map_err(|err| format!("写入订阅清单失败：{err}"))?;
    private_file(&tmp);
    fs::rename(&tmp, &file).map_err(|err| format!("替换订阅清单失败：{err}"))
}

pub fn write_subscription_config(id: &str, body: &str) -> Result<(), String> {
    let file = subscription_config_file(id);
    let dir = file.parent().map(PathBuf::from).unwrap_or_else(data_dir);
    fs::create_dir_all(&dir).map_err(|err| format!("创建订阅目录失败：{err}"))?;
    let tmp = dir.join(format!(".{id}.yaml.tmp"));
    fs::write(&tmp, body).map_err(|err| format!("写入订阅配置失败：{err}"))?;
    private_file(&tmp);
    fs::rename(&tmp, &file).map_err(|err| format!("替换订阅配置失败：{err}"))
}

pub fn read_subscription_config(id: &str) -> Result<String, String> {
    fs::read_to_string(subscription_config_file(id)).map_err(|err| {
        format!("订阅 {id} 的配置缓存读不到（{err}），请先刷新订阅")
    })
}

pub fn read_pid(id: &str) -> Option<i32> {    let text = fs::read_to_string(pid_file(id)).ok()?;
    text.trim().parse::<i32>().ok()
}

pub fn write_pid(id: &str, pid: i32) -> Result<(), String> {
    let dir = data_dir().join("run");
    fs::create_dir_all(&dir).map_err(|err| format!("创建运行目录失败：{err}"))?;
    fs::write(pid_file(id), pid.to_string()).map_err(|err| format!("写入 pid 失败：{err}"))
}

pub fn clear_pid(id: &str) {
    let _ = fs::remove_file(pid_file(id));
}

/// name → 目录安全的 id：ASCII 字母数字保留、其余压成 '-'。
/// 纯中文名会得到空 slug，由调用方落回 profile-N。
pub fn slugify(name: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

/// 在既有清单里为 name 挑一个不冲突的 id；空 slug 落回 profile-N。
/// 已删除身份的登录目录（chrome-profiles/<id>）会被保留，所以磁盘上已有目录的
/// id 也算占用；单独生成过指纹扩展的目录同样保留，不能继承旧 cookie 或指纹种子。
pub fn allocate_id(name: &str, existing: &[Profile]) -> String {
    allocate_id_with(name, existing, |id| {
        user_data_dir(id).exists() || data_dir().join("fingerprints").join(id).exists()
    })
}

fn allocate_id_with(name: &str, existing: &[Profile], dir_taken: impl Fn(&str) -> bool) -> String {
    let base = {
        let slug = slugify(name);
        if slug.is_empty() {
            "profile".to_string()
        } else {
            slug.chars().take(40).collect::<String>()
        }
    };
    let taken = |id: &str| existing.iter().any(|p| p.id == id) || dir_taken(id);
    if !taken(&base) {
        return base;
    }
    for n in 2..1000 {
        let candidate = format!("{base}-{n}");
        if !taken(&candidate) {
            return candidate;
        }
    }
    format!("profile-{}", now_secs())
}

pub fn validate_proxy(scheme: &str, host: &str, port: u16) -> Result<(), String> {
    if !matches!(scheme, "http" | "https" | "socks5") {
        return Err(format!("不支持的代理类型 `{scheme}`（支持 http / https / socks5）"));
    }
    if host.trim().is_empty() {
        return Err("代理地址不能为空".into());
    }
    if port == 0 {
        return Err("代理端口不能为 0".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_keeps_ascii_and_compresses_separators() {
        assert_eq!(slugify("My Shop 2"), "my-shop-2");
        assert_eq!(slugify("纯中文"), "");
        assert_eq!(slugify("A--B__c"), "a-b-c");
    }

    #[test]
    fn allocate_id_falls_back_and_dedupes() {
        let existing = vec![Profile {
            id: "shop".into(), name: "Shop".into(),
            proxy: Some(ProxyConfig::new("http", "127.0.0.1", 7897)),
            subscription: None,
            note: String::new(), chrome_path: None, created_at: 0, updated_at: 0,
        }];
        let no_dirs = |_: &str| false;
        assert_eq!(allocate_id_with("Shop", &existing, no_dirs), "shop-2");
        assert_eq!(allocate_id_with("纯中文", &[], no_dirs), "profile");
        assert_eq!(allocate_id_with("纯中文", &existing, no_dirs), "profile");
    }

    #[test]
    fn allocate_id_never_reuses_a_deleted_identitys_login_dir() {
        // 「shop」已被删除但登录目录还在：同名新身份不能接手那份 cookie。
        let leftover = |id: &str| id == "shop";
        assert_eq!(allocate_id_with("Shop", &[], leftover), "shop-2");
    }

    #[test]
    fn validate_proxy_rejects_unknown_scheme() {
        assert!(validate_proxy("socks5", "127.0.0.1", 1080).is_ok());
        assert!(validate_proxy("vmess", "127.0.0.1", 1080).is_err());
        assert!(validate_proxy("http", "", 8080).is_err());
    }
}
