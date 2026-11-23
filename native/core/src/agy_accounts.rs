//! Antigravity (`agy`) multi-account homes.
//!
//! agy keeps its whole login inside `$HOME/.gemini` and honours `HOME`, so an
//! account is simply a separate HOME directory. That mirrors the Claude
//! official-accounts layout (`~/.multicc/official-accounts/claude/<id>.home`
//! used as `CLAUDE_CONFIG_DIR`), except the whole HOME is redirected here.
//!
//! ```text
//! <home>/.multicc/official-accounts/agy/
//!     active.json          {"id":"<16 hex>"}
//!     <id>.json            {"id","label","createdAt","source"}
//!     <id>.home/.gemini/   the account's own agy state
//! ```
//!
//! This layout is the contract with Node (`src/routes/agy-accounts.js`) and the
//! gateway routes: all three read the same paths, no FFI in between. Tokens are
//! never returned — `login_status` only reports whether a usable credential is
//! present.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::account_subscription::{official_root, valid_account};
use crate::agy_remote::{parse_remote_target, RemoteAgyTarget};
use crate::auth_runtime::now_ms;
use crate::egress_plugin::{parse_egress_binding, EgressBinding};
use crate::provider_store;
use crate::state_file;

const CLI: &str = "agy";
const ACTIVE_FILE: &str = "active.json";
const HOME_SUFFIX: &str = ".home";
const META_SUFFIX: &str = ".json";
const MAX_LABEL: usize = 64;
const DEFAULT_LABEL: &str = "反重力账号";
const DEFAULT_REMOTE_LABEL: &str = "远程 VPS 反重力";

pub const KIND_LOCAL: &str = "local";
pub const KIND_REMOTE: &str = "remote";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolvedAgyAccount {
    Local {
        home: PathBuf,
        egress_binding: Option<EgressBinding>,
    },
    Remote {
        id: String,
        label: String,
        remote: RemoteAgyTarget,
    },
}

/// Copied into a new account home. agy rebuilds caches (`brain`, `log`,
/// `cache`, `conversations`, `*.db`, `tmp`) on its own, and those are the files
/// that make a copy expensive and stale.
const IMPORT_FILES: &[&str] = &[
    "oauth_creds.json",
    "google_accounts.json",
    "settings.json",
    "trustedFolders.json",
    "projects.json",
    "state.json",
    "installation_id",
    "GEMINI.md",
];

const IMPORT_SUBDIRS: &[(&str, &[&str])] = &[
    ("config", &["config.json", "mcp_config.json"]),
    (
        "antigravity-cli",
        &["settings.json", "installation_id", "jetski_state.pbtxt"],
    ),
];

/// `<home>/.multicc/official-accounts/agy`.
pub fn account_root(home: &Path) -> PathBuf {
    official_root(home).join(CLI)
}

/// `<root>/<id>.home`, or `None` when the id is not 16 lowercase hex — checked
/// before any join so a hostile id cannot walk out of the root.
pub fn account_home(home: &Path, id: &str) -> Option<PathBuf> {
    valid_account(id).then(|| account_root(home).join(format!("{id}{HOME_SUFFIX}")))
}

/// `<root>/<id>.json`.
pub fn meta_file(home: &Path, id: &str) -> Option<PathBuf> {
    valid_account(id).then(|| account_root(home).join(format!("{id}{META_SUFFIX}")))
}

fn active_file(home: &Path) -> PathBuf {
    account_root(home).join(ACTIVE_FILE)
}

/// The id in `active.json`, or `None` when agy runs on the machine's own login.
pub fn active_id(home: &Path) -> Option<String> {
    let value = provider_store::read(&active_file(home)).ok().flatten()?;
    let id = value.get("id")?.as_str()?.trim().to_owned();
    valid_account(&id).then_some(id)
}

/// Pin an account as active. `None` (or an empty id) removes the pin, which
/// sends agy back to the machine's own `$HOME`.
pub fn set_active(home: &Path, id: Option<&str>) -> Result<(), String> {
    let file = active_file(home);
    let id = id.map(str::trim).filter(|id| !id.is_empty());
    let Some(id) = id else {
        return remove_if_present(&file);
    };
    if !valid_account(id) {
        return Err("invalid account id".to_owned());
    }
    match meta_file(home, id) {
        Some(meta) if meta.is_file() => {}
        _ => return Err("unknown account".to_owned()),
    }
    state_file::write_json_atomic(&file, &json!({ "id": id })).map_err(|err| err.to_string())
}

/// The HOME a spawned `agy` should use. `None` means "the real HOME", i.e. the
/// CLI's own login, so callers only touch the environment for `Some`.
pub fn active_home(home: &Path) -> Option<PathBuf> {
    let id = active_id(home)?;
    let dir = account_home(home, &id)?;
    dir.is_dir().then_some(dir)
}

fn read_meta(home: &Path, id: &str) -> Option<Value> {
    let meta = meta_file(home, id)?;
    if !meta.is_file() {
        return None;
    }
    provider_store::read(&meta).ok().flatten()
}

fn parse_remote_from_meta(id: &str, meta: &Value) -> Option<(String, RemoteAgyTarget)> {
    if meta.get("kind").and_then(Value::as_str) != Some(KIND_REMOTE) {
        return None;
    }
    let remote = parse_remote_target(meta.get("remote")?).ok()?;
    let label = meta
        .get("label")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(id)
        .to_owned();
    Some((label, remote))
}

fn egress_from_meta(meta: &Value) -> Option<EgressBinding> {
    parse_egress_binding(meta.get("egressBinding"))
        .ok()
        .flatten()
}

/// 读取账号绑定的专用出口身份（本机与远端 VPS 账号通用）。
pub fn get_account_egress(home: &Path, id: &str) -> Option<EgressBinding> {
    let id = id.trim();
    if !valid_account(id) {
        return None;
    }
    let meta = read_meta(home, id)?;
    egress_from_meta(&meta)
}

/// 读取远端 VPS 账号配置；若非远端账号或不存在则返回 `None`。
pub fn get_remote_account(home: &Path, id: &str) -> Option<(String, RemoteAgyTarget)> {
    let id = id.trim();
    if !valid_account(id) {
        return None;
    }
    let meta = read_meta(home, id)?;
    parse_remote_from_meta(id, &meta)
}

/// 是否至少配置了一个有效的远端 VPS `agy` 账号（用于未安装本机 `agy` 时仍放行车道可用性）。
pub fn has_remote_account(home: &Path) -> bool {
    let Ok(entries) = fs::read_dir(account_root(home)) else {
        return false;
    };
    for entry in entries.flatten() {
        if !entry.file_type().is_ok_and(|kind| kind.is_file()) {
            continue;
        }
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        let Some(id) = name.strip_suffix(META_SUFFIX) else {
            continue;
        };
        if !valid_account(id) {
            continue;
        }
        if let Some(meta) = provider_store::read(&entry.path()).ok().flatten() {
            if parse_remote_from_meta(id, &meta).is_some() {
                return true;
            }
        }
    }
    false
}

/// Whether `id` is a registered agy account (either local with isolated `.home`
/// or a valid remote VPS account).
pub fn has_account(home: &Path, id: &str) -> bool {
    let id = id.trim();
    let Some(meta_path) = meta_file(home, id) else {
        return false;
    };
    if !meta_path.is_file() {
        return false;
    }
    if let Some(meta) = provider_store::read(&meta_path).ok().flatten() {
        if meta.get("kind").and_then(Value::as_str) == Some(KIND_REMOTE) {
            return parse_remote_from_meta(id, &meta).is_some();
        }
    }
    account_home(home, id).is_some_and(|dir| dir.is_dir())
}

/// 解析一次绑定/调用所指向的 `agy` 账号目标（本机隔离 HOME 或远端 VPS 目标）。
///
/// * `Some(id)` (非空): fail-closed，账号不存在、格式非法或目录/远端配置损坏时返回 `Err`。
/// * `None` / 空白: 沿用全局 `active.json`，未钉账号返回 `Ok(None)`（使用本机默认 `$HOME`）。
pub fn resolve_account(
    home: &Path,
    account_id: Option<&str>,
) -> Result<Option<ResolvedAgyAccount>, String> {
    let (id, explicit) = match account_id.map(str::trim).filter(|id| !id.is_empty()) {
        Some(id) => (id.to_owned(), true),
        None => match active_id(home) {
            Some(id) => (id, false),
            None => return Ok(None),
        },
    };
    if !valid_account(&id) {
        return if explicit {
            Err("invalid account id".to_owned())
        } else {
            Ok(None)
        };
    }
    let Some(meta_path) = meta_file(home, &id) else {
        return if explicit {
            Err("invalid account id".to_owned())
        } else {
            Ok(None)
        };
    };
    if !meta_path.is_file() {
        return if explicit {
            Err("unknown account".to_owned())
        } else {
            Ok(None)
        };
    }
    let meta = provider_store::read(&meta_path).ok().flatten();
    let egress_binding = meta.as_ref().and_then(egress_from_meta);
    if let Some(meta_val) = meta.as_ref() {
        if meta_val.get("kind").and_then(Value::as_str) == Some(KIND_REMOTE) {
            return match parse_remote_from_meta(&id, meta_val) {
                Some((label, remote)) => Ok(Some(ResolvedAgyAccount::Remote { id, label, remote })),
                None if explicit => Err("invalid remote account configuration".to_owned()),
                None => Ok(None),
            };
        }
    }
    match account_home(home, &id) {
        Some(dir) if dir.is_dir() => Ok(Some(ResolvedAgyAccount::Local {
            home: dir,
            egress_binding,
        })),
        _ if explicit => Err("unknown account".to_owned()),
        _ => Ok(None),
    }
}

/// Resolve the HOME a spawned `agy` should use for one binding.
///
/// * `Some(id)` (non-empty): fail-closed lookup — returns the account's own
///   `<id>.home` when valid and present, or `Err` so a deleted/invalid pick
///   never silently falls back to another account or the machine login.
/// * `None` / blank: follows the global `active.json` pin (`active_home`), or
///   `Ok(None)` to leave the real `$HOME` untouched.
pub fn resolve_home(home: &Path, account_id: Option<&str>) -> Result<Option<PathBuf>, String> {
    let Some(id) = account_id.map(str::trim).filter(|id| !id.is_empty()) else {
        return Ok(active_home(home));
    };
    if !valid_account(id) {
        return Err("invalid account id".to_owned());
    }
    match (meta_file(home, id), account_home(home, id)) {
        (Some(meta), Some(dir)) if meta.is_file() && dir.is_dir() => Ok(Some(dir)),
        _ => Err("unknown account".to_owned()),
    }
}

/// `{"loggedIn","email","expiresAt"}` for one `.gemini` directory. Reads
/// `oauth_creds.json` and `google_accounts.json` but never echoes a token: only
/// whether an access token is present, the active Google address and the expiry.
fn status_of(gemini: &Path) -> Value {
    let creds = provider_store::read(&gemini.join("oauth_creds.json"))
        .ok()
        .flatten();
    let logged_in = creds
        .as_ref()
        .and_then(|value| value.get("access_token"))
        .and_then(Value::as_str)
        .is_some_and(|token| !token.is_empty());
    let expires_at = creds
        .as_ref()
        .and_then(|value| value.get("expiry_date"))
        .and_then(Value::as_i64)
        .map_or(Value::Null, |at| json!(at));
    let email = provider_store::read(&gemini.join("google_accounts.json"))
        .ok()
        .flatten()
        .and_then(|value| {
            value
                .get("active")
                .and_then(Value::as_str)
                .filter(|mail| !mail.is_empty())
                .map(str::to_owned)
        })
        .map_or(Value::Null, |mail| json!(mail));
    json!({ "loggedIn": logged_in, "email": email, "expiresAt": expires_at })
}

/// Login state of one stored account.
pub fn login_status(home: &Path, id: &str) -> Value {
    match account_home(home, id) {
        Some(dir) => status_of(&dir.join(".gemini")),
        None => json!({ "loggedIn": false, "email": Value::Null, "expiresAt": Value::Null }),
    }
}

/// The machine's own `~/.gemini` login — what agy uses with no account pinned.
pub fn local_status(home: &Path) -> Value {
    status_of(&home.join(".gemini"))
}

/// Every account, oldest first, with its login state and whether it is active.
pub fn list_accounts(home: &Path) -> Vec<Value> {
    let Ok(entries) = fs::read_dir(account_root(home)) else {
        return vec![];
    };
    let active = active_id(home);
    let mut accounts: Vec<Value> = entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let id = name.strip_suffix(META_SUFFIX)?;
            if !valid_account(id) {
                return None;
            }
            let meta = provider_store::read(&entry.path())
                .ok()
                .flatten()
                .unwrap_or_else(|| json!({}));
            let label = meta
                .get("label")
                .and_then(Value::as_str)
                .filter(|label| !label.is_empty())
                .unwrap_or(id);
            let egress_val = egress_from_meta(&meta)
                .map(|b| b.to_value())
                .unwrap_or(Value::Null);
            if let Some((_, remote)) = parse_remote_from_meta(id, &meta) {
                let remote_logged_in = meta
                    .get("remoteLoggedIn")
                    .and_then(Value::as_bool)
                    .unwrap_or(true);
                let remote_email = meta
                    .get("remoteEmail")
                    .and_then(Value::as_str)
                    .filter(|s| !s.trim().is_empty())
                    .map(|s| json!(s))
                    .unwrap_or(Value::Null);
                return Some(json!({
                    "id": id,
                    "kind": KIND_REMOTE,
                    "label": label,
                    "email": remote_email,
                    "loggedIn": remote_logged_in,
                    "expiresAt": Value::Null,
                    "createdAt": meta.get("createdAt").cloned().unwrap_or(Value::Null),
                    "source": meta.get("source").cloned().unwrap_or_else(|| json!("remote")),
                    "active": active.as_deref() == Some(id),
                    "egressBinding": Value::Null,
                    "remote": remote.redacted_for_list(),
                }));
            }
            let status = login_status(home, id);
            Some(json!({
                "id": id,
                "kind": KIND_LOCAL,
                "label": label,
                "email": status.get("email").cloned().unwrap_or(Value::Null),
                "loggedIn": status["loggedIn"],
                "expiresAt": status.get("expiresAt").cloned().unwrap_or(Value::Null),
                "createdAt": meta.get("createdAt").cloned().unwrap_or(Value::Null),
                "source": meta.get("source").cloned().unwrap_or(Value::Null),
                "active": active.as_deref() == Some(id),
                "egressBinding": egress_val,
            }))
        })
        .collect();
    accounts.sort_by(|left, right| {
        let key = |value: &Value| value["createdAt"].as_f64().unwrap_or(0.0);
        key(left)
            .partial_cmp(&key(right))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    accounts
}

fn random_id() -> Result<String, String> {
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes).map_err(|_| "OS random source unavailable".to_owned())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn clean_label(label: &str) -> String {
    let trimmed = label.trim();
    if trimmed.is_empty() {
        return DEFAULT_LABEL.to_owned();
    }
    trimmed.chars().take(MAX_LABEL).collect()
}

/// A fresh account home with no credentials yet — the user signs in through
/// the ordinary agy OAuth flow, which writes into `<id>.home/.gemini`.
pub fn create_account(home: &Path, label: &str, source: &str) -> Result<Value, String> {
    create_account_with_egress(home, label, source, None)
}

pub fn create_account_with_egress(
    home: &Path,
    label: &str,
    source: &str,
    raw_egress: Option<&Value>,
) -> Result<Value, String> {
    let egress = parse_egress_binding(raw_egress)?;
    let id = random_id()?;
    let dir = account_home(home, &id).ok_or("invalid account id")?;
    let meta = meta_file(home, &id).ok_or("invalid account id")?;
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    set_dir_mode(&dir);
    let mut record = json!({
        "id": id,
        "label": clean_label(label),
        "createdAt": now_ms().floor() as i64,
        "source": source,
    });
    if let Some(binding) = egress {
        record["egressBinding"] = binding.to_value();
    }
    state_file::write_json_atomic(&meta, &record).map_err(|err| err.to_string())?;
    Ok(record)
}

/// 创建一个远端 VPS 承载的 `agy` 账号（无需在本地建 `.home` 目录，也无需本机登录 `agy`）。
///
/// 若 `raw_remote.isolateHome == true` 且未手填 `remoteHome`，自动分配
/// `.multicc-remote/agy-accounts/<id>` 作为该账号在 VPS 上的独立 `$HOME`，
/// 并把初始 `remoteLoggedIn` 置为 `false` 供网页 OAuth 授权登录。
/// 创建远端 Host / VPS `agy` 账号引用。
///
/// 标准 Host/Client 分离约定：出口 IP 由远端 Host（VPS 上的 MultiCC）账号自己绑定与解析，
/// Client 侧绝不持久化或覆盖远端账号的 `egressBinding`。
pub fn create_remote_account(
    home: &Path,
    label: &str,
    raw_remote: &Value,
) -> Result<Value, String> {
    let mut remote = parse_remote_target(raw_remote)?;
    let isolate_home = remote.host_account_id.is_none()
        && raw_remote
            .get("isolateHome")
            .and_then(Value::as_bool)
            .unwrap_or(false);
    let id = random_id()?;
    if isolate_home && remote.remote_home.is_none() {
        remote.remote_home = Some(format!(".multicc-remote/agy-accounts/{id}"));
    }
    let meta = meta_file(home, &id).ok_or("invalid account id")?;
    let effective_label = if label.trim().is_empty() {
        if let Some(host_label) = remote
            .host_account_label
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            clean_label(host_label)
        } else if remote.is_relay() {
            let host = remote
                .relay_base_url
                .as_deref()
                .and_then(|u| url::Url::parse(u).ok())
                .and_then(|u| u.host_str().map(str::to_owned))
                .unwrap_or_else(|| "远程共享".to_string());
            clean_label(&format!("反重力借道 ({host})"))
        } else {
            clean_label(&format!("{DEFAULT_REMOTE_LABEL} ({})", remote.ssh_target))
        }
    } else {
        clean_label(label)
    };
    let record = json!({
        "id": id,
        "kind": KIND_REMOTE,
        "label": effective_label,
        "createdAt": now_ms().floor() as i64,
        "source": if remote.is_relay() { "relay" } else { "remote" },
        "remoteLoggedIn": !isolate_home,
        "remoteEmail": Value::Null,
        "remote": remote,
    });
    state_file::write_json_atomic(&meta, &record).map_err(|err| err.to_string())?;
    let mut public_record = record;
    public_record["remote"] = remote.redacted_for_list();
    Ok(public_record)
}

/// 取出本地（Host）反重力账号的显示名称（确认存在且为本机账号，用于生成借道分享码）。
pub fn get_local_account_label(home: &Path, id: &str) -> Option<String> {
    let id = id.trim();
    if !valid_account(id) {
        return None;
    }
    let dir = account_home(home, id)?;
    if !dir.is_dir() {
        return None;
    }
    let meta = read_meta(home, id)?;
    if meta.get("kind").and_then(Value::as_str) == Some(KIND_REMOTE) {
        return None;
    }
    let label = meta
        .get("label")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(id);
    Some(label.to_string())
}

/// 为通过分享码导入的 `agy` 远程借道账号重新编码原始 `mcrelay1.…` 分享码（用于「复制原始导入信息」）。
pub fn get_relay_import_code(home: &Path, id: &str) -> Result<(String, String), String> {
    let (label, remote) =
        get_remote_account(home, id).ok_or_else(|| "未找到对应的远程借道反重力账号".to_string())?;
    if !remote.is_relay() {
        return Err("这不是通过分享码导入的反重力借道账号".to_string());
    }
    let base_url = remote
        .relay_base_url
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "缺少借道地址".to_string())?;
    let token = remote
        .relay_auth_token
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "缺少借道安全凭据".to_string())?;
    let share_id = remote.relay_share_id.as_deref().unwrap_or("");
    let code = crate::provider_registry::encode_relay_share_code(
        &label,
        "agy",
        base_url,
        &[],
        share_id,
        token,
    );
    Ok((code, base_url.to_string()))
}

/// 更新本机（Host）反重力账号绑定的专用出口身份；传入 `None`/`null` 清除绑定。
/// 远端引用账号拒绝在 Client 侧修改出口，保证出口归属严格在 Host 侧。
pub fn update_account_egress(
    home: &Path,
    id: &str,
    raw_egress: Option<&Value>,
) -> Result<Value, String> {
    let id = id.trim();
    if !valid_account(id) {
        return Err("invalid account id".to_owned());
    }
    let egress = parse_egress_binding(raw_egress)?;
    let meta_path = meta_file(home, id).ok_or("invalid account id")?;
    let mut existing = provider_store::read(&meta_path)
        .map_err(|err| err.to_string())?
        .ok_or_else(|| "unknown account".to_owned())?;
    if existing.get("kind").and_then(Value::as_str) == Some(KIND_REMOTE) {
        return Err(
            "远程 Host 账号的出口 IP 由远端 Host（VPS 的 MultiCC）管理，请在 Host 端修改"
                .to_owned(),
        );
    }
    if let Some(obj) = existing.as_object_mut() {
        match egress {
            Some(binding) => {
                obj.insert("egressBinding".to_string(), binding.to_value());
            }
            None => {
                obj.remove("egressBinding");
            }
        }
    }
    state_file::write_json_atomic(&meta_path, &existing).map_err(|err| err.to_string())?;
    Ok(existing)
}

/// 更新远端 VPS 账号的登录状态与 Google 邮箱（网页 OAuth 授权完成后落盘）。
pub fn set_remote_login_meta(
    home: &Path,
    id: &str,
    logged_in: bool,
    email: Option<&str>,
) -> Result<(), String> {
    let id = id.trim();
    if !valid_account(id) {
        return Err("invalid account id".to_owned());
    }
    let meta_path = meta_file(home, id).ok_or("invalid account id")?;
    let mut existing = provider_store::read(&meta_path)
        .map_err(|err| err.to_string())?
        .ok_or_else(|| "unknown account".to_owned())?;
    if existing.get("kind").and_then(Value::as_str) != Some(KIND_REMOTE) {
        return Err("仅支持更新远端 VPS 反重力账号的登录状态".to_owned());
    }
    if let Some(obj) = existing.as_object_mut() {
        obj.insert("remoteLoggedIn".to_string(), json!(logged_in));
        if let Some(mail) = email.map(str::trim).filter(|s| !s.is_empty()) {
            obj.insert("remoteEmail".to_string(), json!(mail));
        }
    }
    state_file::write_json_atomic(&meta_path, &existing).map_err(|err| err.to_string())
}

/// 更新已有远端 VPS `agy` 账号的配置与显示名称。
pub fn update_remote_account(
    home: &Path,
    id: &str,
    label: Option<&str>,
    raw_remote: &Value,
) -> Result<Value, String> {
    let id = id.trim();
    if !valid_account(id) {
        return Err("invalid account id".to_owned());
    }
    let meta_path = meta_file(home, id).ok_or("invalid account id")?;
    let existing = provider_store::read(&meta_path)
        .map_err(|err| err.to_string())?
        .ok_or_else(|| "unknown account".to_owned())?;
    if existing.get("kind").and_then(Value::as_str) != Some(KIND_REMOTE) {
        return Err("仅支持更新远端 VPS 类型的反重力账号".to_owned());
    }
    let remote = parse_remote_target(raw_remote)?;
    let effective_label = match label.map(str::trim).filter(|s| !s.is_empty()) {
        Some(next) => clean_label(next),
        None => existing
            .get("label")
            .and_then(Value::as_str)
            .map(clean_label)
            .unwrap_or_else(|| clean_label(&remote.ssh_target)),
    };
    let record = json!({
        "id": id,
        "kind": KIND_REMOTE,
        "label": effective_label,
        "createdAt": existing.get("createdAt").cloned().unwrap_or_else(|| json!(now_ms().floor() as i64)),
        "source": "remote",
        "remote": remote,
    });
    state_file::write_json_atomic(&meta_path, &record).map_err(|err| err.to_string())?;
    Ok(record)
}

/// Copy this machine's signed-in `~/.gemini` into a new account home, so a
/// working login can be kept and switched back to later.
pub fn import_account(home: &Path, label: &str) -> Result<Value, String> {
    let source = home.join(".gemini");
    if !source.join("oauth_creds.json").is_file() {
        return Err("本机尚未登录 agy，请先完成登录再导入".to_owned());
    }
    let record = create_account(home, label, "import")?;
    let id = record["id"]
        .as_str()
        .ok_or("invalid account id")?
        .to_owned();
    let target = account_home(home, &id)
        .ok_or("invalid account id")?
        .join(".gemini");
    let result = (|| {
        for name in IMPORT_FILES {
            copy_file(&source.join(name), &target.join(name))?;
        }
        for (dir, files) in IMPORT_SUBDIRS {
            for name in *files {
                copy_file(&source.join(dir).join(name), &target.join(dir).join(name))?;
            }
        }
        // The label defaults to the imported account's own Google address so
        // the list is readable without opening anything; persist it so the
        // stored metadata and the answer agree.
        let status = login_status(home, &id);
        let email = status.get("email").and_then(Value::as_str).unwrap_or("");
        if label.trim().is_empty() && !email.is_empty() {
            let updated = json!({
                "id": id,
                "label": clean_label(email),
                "createdAt": record["createdAt"].clone(),
                "source": "import",
            });
            state_file::write_json_atomic(
                &meta_file(home, &id).ok_or("invalid account id")?,
                &updated,
            )
            .map_err(|err| err.to_string())?;
            return Ok(updated);
        }
        Ok::<Value, String>(json!({
            "id": id,
            "label": record["label"].clone(),
            "createdAt": record["createdAt"].clone(),
            "source": "import",
        }))
    })();
    // A half-copied home would look like a usable account, so roll it back.
    if result.is_err() {
        let _ = fs::remove_dir_all(&target);
        if let Some(meta) = meta_file(home, &id) {
            let _ = fs::remove_file(meta);
        }
    }
    result
}

pub fn delete_account(home: &Path, id: &str) -> Result<(), String> {
    if !valid_account(id) {
        return Err("invalid account id".to_owned());
    }
    let dir = account_home(home, id).ok_or("invalid account id")?;
    let meta = meta_file(home, id).ok_or("invalid account id")?;
    if !meta.is_file() && !dir.is_dir() {
        return Err("unknown account".to_owned());
    }
    if dir.is_dir() {
        fs::remove_dir_all(&dir).map_err(|err| err.to_string())?;
    }
    remove_if_present(&meta)?;
    if active_id(home).as_deref() == Some(id) {
        remove_if_present(&active_file(home))?;
    }
    Ok(())
}

fn copy_file(from: &Path, to: &Path) -> Result<(), String> {
    match fs::read(from) {
        Ok(bytes) => {
            state_file::write_bytes_atomic(to, &bytes, state_file::FILE_MODE, state_file::DIR_MODE)
                .map_err(|err| err.to_string())
        }
        // An optional file that is absent here is simply not part of the account.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn remove_if_present(file: &Path) -> Result<(), String> {
    match fs::remove_file(file) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn set_dir_mode(dir: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(dir, fs::Permissions::from_mode(state_file::DIR_MODE));
    }
    #[cfg(not(unix))]
    let _ = dir;
}

#[cfg(test)]
mod tests;
