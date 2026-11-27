//! Antigravity (`agy`) model catalog, plus transparent pass-through to the
//! lending Host for relay-shared accounts. Logical models come from a real ACP
//! `session/new` on the signed-in account, so they follow whatever tier the
//! user has instead of a hard-coded table.
//!
//! Kept apart from the generic `model_catalogs` cluster because agy is the one
//! catalog the front door spawns itself — it needs the account session, not a
//! Node host op. The per-account cache and single-flight locks live here; the
//! route shape stays in `model_catalogs`.
use crate::agy_relay_client::{fetch_relay_models, RelayCatalogError};
use crate::agy_remote_bridge::{build_ssh_base_args, ssh_bin};
use multicc_core::agy_accounts::{self as agy_store, ResolvedAgyAccount};
use multicc_core::agy_remote::{
    build_remote_agy_command_script, posix_shell_quote, RemoteAgyTarget, DEFAULT_REMOTE_AGY_BIN,
};
use multicc_core::egress_plugin::{EgressBinding, LOOPBACK_NO_PROXY};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    ffi::OsString,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, OnceLock},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::Mutex,
};

/// A successful catalog is reused for ten minutes; a failed probe backs off for
/// thirty seconds so a signed-out CLI cannot spawn on every page load.
const TTL: Duration = Duration::from_secs(600);
const FAIL_TTL: Duration = Duration::from_secs(30);
const MAX_LINE: usize = 4_000_000;

/// `(when, Result<catalog, error>)` — failures back off for `FAIL_TTL`.
type CacheSlot = Option<(Instant, Result<AgyCatalog, String>)>;
type CacheMap = HashMap<String, Arc<Mutex<CacheSlot>>>;
static CACHE: OnceLock<Mutex<CacheMap>> = OnceLock::new();

/// The ACP catalog: the family ids the picker may store, plus the model the
/// CLI would run right now when nothing is pinned. `current` is display-only —
/// sending it back as a model id is not the contract (it carries a tier suffix).
#[derive(Clone)]
pub(crate) struct AgyCatalog {
    pub models: Vec<Value>,
    pub current: Option<Value>,
}

pub(super) struct AgyCatalogResult {
    pub models: Vec<Value>,
    pub current: Option<Value>,
    pub source: &'static str,
    pub cached: bool,
}

fn accounts_home_dir() -> Option<PathBuf> {
    std::env::var_os("MULTICC_AGY_ACCOUNTS_HOME")
        .filter(|v| !v.is_empty())
        .or_else(|| std::env::var_os("HOME").filter(|v| !v.is_empty()))
        .or_else(|| std::env::var_os("USERPROFILE").filter(|v| !v.is_empty()))
        .map(PathBuf::from)
}

pub(crate) const AGY_INSTALL_COMMAND: &str =
    "curl -fsSL https://antigravity.google/cli/install.sh | bash";

pub(crate) fn install_command() -> &'static str {
    AGY_INSTALL_COMMAND
}

fn has_path_separator(raw: &std::ffi::OsStr) -> bool {
    let text = raw.to_string_lossy();
    text.contains('/') || (cfg!(windows) && text.contains('\\'))
}

fn resolve_command_on_path(raw: &std::ffi::OsStr) -> Option<PathBuf> {
    if has_path_separator(raw) {
        let candidate = PathBuf::from(raw);
        return candidate.is_file().then_some(candidate);
    }
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        let candidate = dir.join(raw);
        if candidate.is_file() {
            return Some(candidate);
        }
        #[cfg(windows)]
        {
            let text = raw.to_string_lossy();
            if !text.contains('.') {
                for ext in [".exe", ".cmd", ".bat"] {
                    let with_ext = dir.join(format!("{text}{ext}"));
                    if with_ext.is_file() {
                        return Some(with_ext);
                    }
                }
            }
        }
    }
    None
}

/// Live detection of the local `agy` binary — never cached across requests so
/// installing `agy` via `/api/cli/agy/install` (or manually) takes effect
/// immediately without restarting MultiCC.
pub(crate) fn detect_local_agy() -> Option<PathBuf> {
    if let Some(cmd) = std::env::var_os("MULTICC_AGY_BIN").filter(|v| !v.is_empty()) {
        return resolve_command_on_path(&cmd);
    }
    if let Some(cmd) = std::env::var_os("AGY_CMD").filter(|v| !v.is_empty()) {
        return resolve_command_on_path(&cmd);
    }
    let binary = if cfg!(windows) { "agy.exe" } else { "agy" };
    let mut candidates = Vec::new();
    if let Some(home) = std::env::var_os("HOME").filter(|v| !v.is_empty()) {
        candidates.push(PathBuf::from(home).join(".local/bin").join(binary));
    }
    #[cfg(windows)]
    {
        if let Some(profile) = std::env::var_os("USERPROFILE").filter(|v| !v.is_empty()) {
            candidates.push(PathBuf::from(profile).join(".local/bin").join(binary));
        }
        if let Some(local_app) = std::env::var_os("LOCALAPPDATA").filter(|v| !v.is_empty()) {
            candidates.push(PathBuf::from(local_app).join("agy/bin").join(binary));
        }
    }
    if cfg!(target_os = "macos") {
        // Mirrors resolveAgy() in src/cli-adapters/commands.js: Homebrew installs
        // are not always on the service PATH.
        candidates.push(PathBuf::from("/opt/homebrew/bin").join(binary));
        candidates.push(PathBuf::from("/usr/local/bin").join(binary));
    }
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .or_else(|| resolve_command_on_path(std::ffi::OsStr::new(binary)))
}

pub(crate) fn local_cli_status() -> Value {
    let detected = detect_local_agy();
    json!({
        "installed": detected.is_some(),
        "bin": detected.as_ref().map(|path| path.to_string_lossy().into_owned()),
        "installCommand": install_command(),
    })
}

pub(crate) fn executable() -> OsString {
    if let Some(cmd) = std::env::var_os("MULTICC_AGY_BIN").filter(|v| !v.is_empty()) {
        return cmd;
    }
    if let Some(cmd) = std::env::var_os("AGY_CMD").filter(|v| !v.is_empty()) {
        return cmd;
    }
    let binary = if cfg!(windows) { "agy.exe" } else { "agy" };
    detect_local_agy()
        .map(PathBuf::into_os_string)
        .unwrap_or_else(|| binary.into())
}

fn clean_id(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty() && text.len() <= 100)
}

/// ACP session → `(pickable family ids, the model actually in effect)`.
///
/// `configOptions[model].options` are the ids the picker stores; the tiered id
/// agy would run (`models.currentModelId`, e.g. `gemini-4-neon-high`) never
/// appears there, so it is only reported as `current` for display.
fn model_options(session: &Value) -> AgyCatalog {
    let mut models = Vec::new();
    let mut family_current = None;
    if let Some(model) = session
        .get("configOptions")
        .and_then(Value::as_array)
        .and_then(|options| {
            options
                .iter()
                .find(|item| item["id"] == "model" || item["category"] == "model")
        })
    {
        for item in model
            .get("options")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(id) = clean_id(item.get("value")) else {
                continue;
            };
            let label = item.get("name").and_then(Value::as_str).unwrap_or(id);
            models.push(json!({"model": id, "label": label}));
        }
        if let Some(id) = clean_id(model.get("currentValue")) {
            let label = models
                .iter()
                .find(|item| item["model"] == id)
                .and_then(|item| item["label"].as_str())
                .unwrap_or(id);
            family_current = Some(json!({"model": id, "label": label}));
        }
    }
    let current = session
        .get("models")
        .and_then(|models| {
            let id = clean_id(models.get("currentModelId"))?;
            let label = models
                .get("availableModels")
                .and_then(Value::as_array)
                .and_then(|items| {
                    items
                        .iter()
                        .find(|item| item.get("modelId").and_then(Value::as_str) == Some(id))
                })
                .and_then(|item| item.get("name").and_then(Value::as_str))
                .unwrap_or(id);
            Some(json!({"model": id, "label": label}))
        })
        .or(family_current);
    AgyCatalog { models, current }
}

async fn run_acp_model_query(
    mut command: Command,
    cwd: &str,
    spawn_err: &str,
) -> Result<AgyCatalog, String> {
    let mut child = command.spawn().map_err(|_| spawn_err.to_string())?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "无法与 agy ACP 通信".to_string())?;
    let mut stdout = BufReader::new(
        child
            .stdout
            .take()
            .ok_or_else(|| "无法读取 agy ACP 输出".to_string())?,
    )
    .lines();
    for (id, method, params) in [
        (
            1,
            "initialize",
            json!({"protocolVersion":1,"clientCapabilities":{},"clientInfo":{"name":"multicc-models","version":"1.0.0"}}),
        ),
        (2, "session/new", json!({"cwd":cwd,"mcpServers":[]})),
    ] {
        let request = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
        stdin
            .write_all(format!("{}\n", request).as_bytes())
            .await
            .map_err(|_| "发送 agy ACP 请求失败".to_string())?;
        loop {
            let line = stdout
                .next_line()
                .await
                .map_err(|_| "读取 agy ACP 响应失败".to_string())?
                .ok_or_else(|| "未读到反重力模型，请确认已登录 agy 并检查网络".to_string())?;
            if line.len() > MAX_LINE {
                return Err("agy ACP 响应超出长度限制".to_string());
            }
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if message.get("id").and_then(Value::as_i64) != Some(id) {
                continue;
            }
            let result = message
                .get("result")
                .ok_or_else(|| "未读到反重力模型，请确认已登录 agy 并检查网络".to_string())?;
            if id == 2 {
                let catalog = model_options(result);
                return if catalog.models.is_empty() {
                    Err("未读到反重力模型，请确认已登录 agy 并检查网络".to_string())
                } else {
                    Ok(catalog)
                };
            }
            break;
        }
    }
    Err("未读到反重力模型，请确认已登录 agy 并检查网络".to_string())
}

async fn fetch_local_with_env(
    home_override: Option<&Path>,
    proxy_url: Option<&str>,
) -> Result<AgyCatalog, String> {
    let mut command = Command::new(executable());
    command
        .arg("acp")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .env_remove("MULTICC_AGY_REMOTE_ACCOUNT_JSON")
        .env_remove("MULTICC_AGY_EGRESS_JSON");
    // The model list follows the signed-in account; agy reads its login from
    // `$HOME/.gemini`, so a pinned account is served by pointing HOME at its
    // mini-home. No pin leaves the real home untouched.
    if let Some(home) = home_override {
        command.env("HOME", home);
    }
    if let Some(url) = proxy_url {
        command
            .env("HTTP_PROXY", url)
            .env("HTTPS_PROXY", url)
            .env("ALL_PROXY", url)
            .env("http_proxy", url)
            .env("https_proxy", url)
            .env("all_proxy", url)
            .env("NO_PROXY", LOOPBACK_NO_PROXY)
            .env("no_proxy", LOOPBACK_NO_PROXY);
    }
    let cwd = std::env::current_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .to_string_lossy()
        .into_owned();
    run_acp_model_query(command, &cwd, "未读到反重力模型，请确认本机已安装并登录 agy").await
}

/// 通过 SSH 桥接向远端 Host 拉取反重力模型目录（复用与本地一致的 ACP `initialize` + `session/new`）。
///
/// 命令通过 `sh -c <quoted_script>` 传递，确保 `stdin` 从首字节起完整透传给远端 `exec agy acp`。
async fn fetch_ssh_models(remote: &RemoteAgyTarget) -> Result<AgyCatalog, String> {
    let agy_bin = remote
        .remote_agy_bin
        .as_deref()
        .unwrap_or(DEFAULT_REMOTE_AGY_BIN);
    let script = build_remote_agy_command_script(
        agy_bin,
        remote.remote_home.as_deref(),
        remote.host_account_id.as_deref(),
        &["acp"],
    );
    let mut args = build_ssh_base_args(remote);
    args.push(remote.ssh_target.clone());
    args.push("--".to_string());
    args.push(format!("sh -c {}", posix_shell_quote(&script)));

    let mut command = Command::new(ssh_bin());
    command
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .env_remove("MULTICC_AGY_REMOTE_ACCOUNT_JSON")
        .env_remove("MULTICC_AGY_EGRESS_JSON");

    match tokio::time::timeout(
        Duration::from_secs(30),
        run_acp_model_query(
            command,
            "/tmp",
            "无法通过 SSH 连接远端反重力主机拉取模型目录",
        ),
    )
    .await
    {
        Ok(res) => res,
        Err(_) => Err("通过 SSH 拉取远端反重力模型目录超时，请检查 SSH 连接与网络".to_string()),
    }
}

async fn slot_for(cache_key: &str) -> Arc<Mutex<CacheSlot>> {
    let mut map = CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .await;
    map.entry(cache_key.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(None)))
        .clone()
}

async fn cached_models<F, Fut>(
    cache_key: &str,
    refresh: bool,
    producer: F,
) -> Result<(AgyCatalog, bool), String>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<AgyCatalog, String>>,
{
    let slot = slot_for(cache_key).await;
    let mut guard = slot.lock().await;
    if !refresh {
        if let Some((when, entry)) = guard.as_ref() {
            let ttl = if entry.is_ok() { TTL } else { FAIL_TTL };
            if when.elapsed() < ttl {
                return entry.clone().map(|models| (models, true));
            }
        }
    }
    let fresh = producer().await;
    *guard = Some((Instant::now(), fresh.clone()));
    fresh.map(|models| (models, false))
}

/// 查询 Host 本机某个隔离反重力账号的模型目录（供本机 `/api/agy/models` 与借道 Host `/agy-proxy/<id>/models` 复用）。
///
/// 绑定了 `chrome-proxy-launcher` 专用出口时采用 fail-closed：实时解析出口并注入代理环境，
/// 出口不可用时直接报错，绝不静默走 Host 默认出口 IP。
pub(crate) async fn query_local_account(
    account_id: &str,
    account_home: &Path,
    egress_binding: Option<&EgressBinding>,
    refresh: bool,
) -> Result<(AgyCatalog, bool), String> {
    let cache_key = format!("local:{account_id}");
    cached_models(&cache_key, refresh, || async {
        let proxy_url = if let Some(binding) = egress_binding {
            match crate::egress_runtime::resolve_egress_proxy_url(binding).await {
                Ok(url) => Some(url),
                Err(err) => return Err(format!("Host 账号专用出口不可用：{err}")),
            }
        } else {
            None
        };
        fetch_local_with_env(Some(account_home), proxy_url.as_deref()).await
    })
    .await
}

/// The cached catalog describes the previous account, so an account switch
/// must drop it instead of waiting out the ten-minute TTL.
pub(super) async fn invalidate() {
    if let Some(cache) = CACHE.get() {
        cache.lock().await.clear();
    }
}

/// 解析目标反重力账号的模型目录（本机隔离账号、本机默认 `$HOME` 或借道透传至出借方 Host）。
pub(super) async fn resolve_models(
    explicit_account_id: Option<&str>,
    refresh: bool,
) -> Result<AgyCatalogResult, String> {
    let Some(home) = accounts_home_dir() else {
        return Err("无法定位 HOME 目录，未能读取反重力模型目录".to_string());
    };
    match agy_store::resolve_account(&home, explicit_account_id) {
        Ok(None) => {
            let (catalog, cached) = cached_models("__default__", refresh, || async {
                fetch_local_with_env(None, None).await
            })
            .await?;
            Ok(AgyCatalogResult {
                models: catalog.models,
                current: catalog.current,
                source: "cli",
                cached,
            })
        }
        Ok(Some(ResolvedAgyAccount::Local {
            home: account_home,
            egress_binding,
        })) => {
            let acct_id = explicit_account_id
                .map(str::to_owned)
                .or_else(|| agy_store::active_id(&home))
                .unwrap_or_else(|| "local".to_string());
            let (catalog, cached) =
                query_local_account(&acct_id, &account_home, egress_binding.as_ref(), refresh)
                    .await?;
            Ok(AgyCatalogResult {
                models: catalog.models,
                current: catalog.current,
                source: "cli",
                cached,
            })
        }
        Ok(Some(ResolvedAgyAccount::Remote { id, remote, .. })) if remote.is_relay() => {
            let cache_key = format!("relay:{id}");
            let (catalog, cached) = cached_models(&cache_key, refresh, || async {
                fetch_relay_models(&remote, refresh)
                    .await
                    .map(|(models, current)| AgyCatalog { models, current })
                    .map_err(|err| match err {
                        RelayCatalogError::Revoked => {
                            "反重力借道分享码已被撤销或无效，请向出借方重新获取".to_string()
                        }
                        RelayCatalogError::NotFound => {
                            "远端 Host 上对应的反重力账号已不存在，或 Host 尚未升级支持反重力借道模型目录"
                                .to_string()
                        }
                        RelayCatalogError::Unavailable(detail) => detail,
                    })
            })
            .await?;
            Ok(AgyCatalogResult {
                models: catalog.models,
                current: catalog.current,
                source: "relay",
                cached,
            })
        }
        Ok(Some(ResolvedAgyAccount::Remote { id, remote, .. })) => {
            let cache_key = format!("ssh:{id}");
            let (catalog, cached) = cached_models(&cache_key, refresh, || async {
                fetch_ssh_models(&remote).await
            })
            .await?;
            Ok(AgyCatalogResult {
                models: catalog.models,
                current: catalog.current,
                source: "ssh",
                cached,
            })
        }
        Err(err) => Err(err),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_acp_model_option_and_skips_bad_rows() {
        let session = json!({"configOptions":[
            {"id":"thought_level","category":"thought_level","options":[{"value":"high"}]},
            {"id":"model","category":"model","options":[
                {"value":"gemini-4-neon","name":"Gemini 4 Neon"},
                {"value":"  ","name":"blank"},
                {"value":"claude-sonnet-5-5"}
            ]}
        ]});
        let catalog = model_options(&session);
        assert_eq!(catalog.models.len(), 2);
        assert_eq!(catalog.models[0]["model"], "gemini-4-neon");
        assert_eq!(catalog.models[0]["label"], "Gemini 4 Neon");
        assert_eq!(catalog.models[1]["label"], "claude-sonnet-5-5");
        // 没有 currentValue / currentModelId 时不臆造默认值。
        assert!(catalog.current.is_none());
    }

    #[test]
    fn current_model_reports_the_tiered_id_in_effect() {
        let session = json!({
            "configOptions":[{"id":"model","category":"model","currentValue":"gemini-4-neon","options":[
                {"value":"gemini-4-neon","name":"Gemini 4 Neon"},
                {"value":"claude-sonnet-5-5","name":"Claude Sonnet 5.5"}
            ]}],
            "models":{
                "currentModelId":"gemini-4-neon-high",
                "availableModels":[
                    {"modelId":"gemini-4-neon-high","name":"Gemini 4 Neon (High)"},
                    {"modelId":"gemini-4-neon-medium","name":"Gemini 4 Neon (Medium)"}
                ]
            }
        });
        let catalog = model_options(&session);
        // 可选项仍是族名；真正在跑的档位只出现在 current 里。
        assert_eq!(catalog.models.len(), 2);
        assert_eq!(
            catalog.current.unwrap(),
            json!({"model":"gemini-4-neon-high","label":"Gemini 4 Neon (High)"})
        );
    }

    #[test]
    fn current_model_falls_back_to_the_option_value() {
        let session = json!({
            "configOptions":[{"id":"model","category":"model","currentValue":"claude-sonnet-5-5","options":[
                {"value":"gemini-4-neon","name":"Gemini 4 Neon"},
                {"value":"claude-sonnet-5-5","name":"Claude Sonnet 5.5"}
            ]}]
        });
        let catalog = model_options(&session);
        assert_eq!(
            catalog.current.unwrap(),
            json!({"model":"claude-sonnet-5-5","label":"Claude Sonnet 5.5"})
        );
    }

    #[test]
    fn no_model_option_is_an_empty_catalog() {
        assert!(model_options(&json!({"configOptions":[]}))
            .models
            .is_empty());
        assert!(model_options(&json!({})).models.is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn query_local_account_injects_egress_and_client_relays_catalog() {
        use std::os::unix::fs::PermissionsExt;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::time::{SystemTime, UNIX_EPOCH};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;

        let _guard = crate::egress_runtime::TEST_ENV_LOCK.lock().await;
        invalidate().await;

        let root = std::env::temp_dir().join(format!(
            "multicc-agy-catalog-relay-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let host_home = root.join("host-home");
        let client_home = root.join("client-home");
        let bin_dir = root.join("bin");
        std::fs::create_dir_all(&host_home).unwrap();
        std::fs::create_dir_all(&client_home).unwrap();
        std::fs::create_dir_all(&bin_dir).unwrap();

        let fake_agy = bin_dir.join("agy");
        std::fs::write(
            &fake_agy,
            r#"#!/bin/sh
if [ "$HTTPS_PROXY" != "http://127.0.0.1:48888" ]; then
  exit 2
fi
read _line1
printf '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}\n'
read _line2
printf '{"jsonrpc":"2.0","id":2,"result":{"configOptions":[{"id":"model","category":"model","currentValue":"gemini-4-neon","options":[{"value":"gemini-4-neon","name":"Gemini 4 Neon"},{"value":"claude-sonnet-5-5","name":"Claude Sonnet 5.5"}]}],"models":{"currentModelId":"gemini-4-neon-high","availableModels":[{"modelId":"gemini-4-neon-high","name":"Gemini 4 Neon (High)"}]}}}\n'
"#,
        )
        .unwrap();
        std::fs::set_permissions(&fake_agy, std::fs::Permissions::from_mode(0o755)).unwrap();

        std::env::set_var("MULTICC_AGY_BIN", &fake_agy);
        std::env::set_var("MULTICC_EGRESS_PROXY_OVERRIDE", "http://127.0.0.1:48888");

        // 1) Host local account with bound egress injects HTTPS_PROXY and parses ACP models.
        let created = agy_store::create_account_with_egress(
            &host_home,
            "Host 代理账号",
            "created",
            Some(&json!({ "pluginId": "chrome-proxy-launcher", "profileId": "us-1" })),
        )
        .unwrap();
        let host_id = created["id"].as_str().unwrap().to_string();
        let acct_home = agy_store::account_home(&host_home, &host_id).unwrap();
        let egress = agy_store::get_account_egress(&host_home, &host_id);
        let (host_catalog, cached) =
            query_local_account(&host_id, &acct_home, egress.as_ref(), true)
                .await
                .unwrap();
        assert!(!cached);
        assert_eq!(host_catalog.models.len(), 2);
        assert_eq!(host_catalog.models[0]["model"], "gemini-4-neon");
        assert_eq!(
            host_catalog.current.as_ref(),
            Some(&json!({"model":"gemini-4-neon-high","label":"Gemini 4 Neon (High)"}))
        );

        // 2) Client active relay account transparently forwards /api/agy/models to Host
        //    with caching and ?refresh=1 passthrough.
        let hits = Arc::new(AtomicUsize::new(0));
        let hits_srv = hits.clone();
        let catalog_payload = json!({
            "models": host_catalog.models,
            "current": host_catalog.current,
            "source": "cli",
            "cached": false,
        })
        .to_string();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let srv = tokio::spawn(async move {
            for expected_refresh in [false, true] {
                let (mut sock, _) = listener.accept().await.unwrap();
                let mut buf = [0u8; 2048];
                let n = sock.read(&mut buf).await.unwrap();
                let req = String::from_utf8_lossy(&buf[..n]);
                if expected_refresh {
                    assert!(req.contains("/models?refresh=1 "));
                } else {
                    assert!(req.contains("/models "));
                }
                hits_srv.fetch_add(1, Ordering::SeqCst);
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    catalog_payload.len(),
                    catalog_payload
                );
                sock.write_all(resp.as_bytes()).await.unwrap();
            }
        });

        let relay_acct = agy_store::create_remote_account(
            &client_home,
            "借道反重力",
            &json!({
                "transport": "relay",
                "relayBaseUrl": format!("http://127.0.0.1:{port}/agy-proxy/{host_id}"),
                "relayAuthToken": "mcr1.0123456789abcdef.secret8888",
            }),
        )
        .unwrap();
        let client_acct_id = relay_acct["id"].as_str().unwrap();
        agy_store::set_active(&client_home, Some(client_acct_id)).unwrap();
        std::env::set_var("MULTICC_AGY_ACCOUNTS_HOME", &client_home);
        invalidate().await;

        let r1 = resolve_models(None, false).await.unwrap();
        assert_eq!(r1.source, "relay");
        assert!(!r1.cached);
        assert_eq!(r1.models.len(), 2);
        // 出借方的“当前模型”随目录一起透传，借用方不必再猜。
        assert_eq!(
            r1.current,
            Some(json!({"model":"gemini-4-neon-high","label":"Gemini 4 Neon (High)"}))
        );
        assert_eq!(hits.load(Ordering::SeqCst), 1);

        // Second non-refresh call hits cache.
        let r2 = resolve_models(None, false).await.unwrap();
        assert_eq!(r2.source, "relay");
        assert!(r2.cached);
        assert_eq!(hits.load(Ordering::SeqCst), 1);

        // Refresh bypasses cache and forwards ?refresh=1 to Host.
        let r3 = resolve_models(None, true).await.unwrap();
        assert_eq!(r3.source, "relay");
        assert!(!r3.cached);
        assert_eq!(hits.load(Ordering::SeqCst), 2);
        let _ = srv.await;

        assert!(crate::ws_agy_relay::claims_models(&format!(
            "/agy-proxy/{host_id}/models"
        )));
        assert!(!crate::ws_agy_relay::claims_models(
            "/agy-proxy/bad-id/models"
        ));

        std::env::remove_var("MULTICC_AGY_ACCOUNTS_HOME");
        std::env::remove_var("MULTICC_AGY_BIN");
        std::env::remove_var("MULTICC_EGRESS_PROXY_OVERRIDE");
        invalidate().await;
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn ssh_remote_account_bridges_models_over_ssh_with_caching() {
        use std::os::unix::fs::PermissionsExt;

        let root = std::env::temp_dir().join(format!(
            "multicc-agy-ssh-models-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let client_home = root.join("client");
        std::fs::create_dir_all(&client_home).unwrap();

        let fake_agy = root.join("fake-agy");
        std::fs::write(
            &fake_agy,
            r#"#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}'
      ;;
    *'"method":"session/new"'*)
      printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"configOptions":[{"id":"model","options":[{"value":"gemini-4-neon","name":"Gemini 4 Neon"}]}],"models":{"currentModelId":"gemini-4-neon-high","availableModels":[{"modelId":"gemini-4-neon-high","name":"Gemini 4 Neon (High)"}]}}}'
      exit 0
      ;;
  esac
done
"#,
        )
        .unwrap();
        std::fs::set_permissions(&fake_agy, std::fs::Permissions::from_mode(0o755)).unwrap();

        // Fake ssh receives `... <target> -- "sh -c '<script>'"` and evaluates the last argument via sh -c.
        let fake_ssh = root.join("fake-ssh");
        std::fs::write(
            &fake_ssh,
            "#!/bin/sh\nlast=''\nfor a in \"$@\"; do last=\"$a\"; done\nexec /bin/sh -c \"$last\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&fake_ssh, std::fs::Permissions::from_mode(0o755)).unwrap();

        let ssh_acct = agy_store::create_remote_account(
            &client_home,
            "SSH 借用反重力",
            &json!({
                "transport": "ssh",
                "sshTarget": "user@host.test",
                "sshPort": 32303,
                "remoteAgyBin": fake_agy.to_string_lossy(),
                "fileMode": "mutagen",
            }),
        )
        .unwrap();
        let acct_id = ssh_acct["id"].as_str().unwrap();
        agy_store::set_active(&client_home, Some(acct_id)).unwrap();
        std::env::set_var("MULTICC_AGY_ACCOUNTS_HOME", &client_home);
        std::env::set_var("MULTICC_SSH_BIN", &fake_ssh);
        invalidate().await;

        let r1 = resolve_models(None, false).await.unwrap();
        assert_eq!(r1.source, "ssh");
        assert!(!r1.cached);
        assert_eq!(r1.models.len(), 1);
        assert_eq!(r1.models[0]["model"], "gemini-4-neon");
        assert_eq!(
            r1.current,
            Some(json!({"model":"gemini-4-neon-high","label":"Gemini 4 Neon (High)"}))
        );

        let r2 = resolve_models(None, false).await.unwrap();
        assert_eq!(r2.source, "ssh");
        assert!(r2.cached);

        std::env::remove_var("MULTICC_AGY_ACCOUNTS_HOME");
        std::env::remove_var("MULTICC_SSH_BIN");
        invalidate().await;
        let _ = std::fs::remove_dir_all(&root);
    }
}
