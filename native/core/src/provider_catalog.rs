//! The identity half of `GET /api/providers/limit-history`: which providers
//! exist for an app type, in the order `src/providers/core.js`
//! `listProviders(type)` reported them before the route moved.
//!
//! `listProviders` = `officialCatalog.list(type).map(summarize)`, and only
//! `id` / `appType` survive into the identity handed to the quota-history
//! kernel. This module therefore reproduces `officialCatalog.list` itself:
//!
//!   [ alias `<type>-official`,
//!     every logged-in official account `<type>-official-<16 hex>`,
//!     ...for claude, then the same for codex,
//!     providers.json records that are neither official by content nor by id ]
//!
//! errors are all-or-nothing per `list(type)` call, exactly like the route's
//! `try { listProviders(type) } catch { [] }`: a corrupt providers.json, a
//! selection file that is invalid JSON, or a selection value that is not
//! `'global'` / a 16-hex id makes the whole list empty. The account directory
//! is `<HOME>/.multicc/official-accounts` (src/official-accounts.js) and is
//! read-only here.
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::js::serde::{js_string, js_trim, truthy};
use crate::provider_store;

const TYPES: [&str; 2] = ["claude", "codex"];
/// src/official-accounts.js `ACCOUNT_ID_PATTERN`.
const ACCOUNT_ID_RE: &str = "^[a-f0-9]{16}$";

#[derive(Debug, Clone)]
struct Account {
    id: String,
    created_at: Option<f64>,
    logged_in: bool,
    label: String,
    email: String,
    subscription: Value,
}

fn official_id(kind: &str) -> String {
    format!("{kind}-official")
}

fn is_account_id(text: &str) -> bool {
    static PATTERN: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    PATTERN
        .get_or_init(|| regex::Regex::new(ACCOUNT_ID_RE).expect("account id pattern"))
        .is_match(text)
}

fn accounts_root(home: &Path) -> PathBuf {
    home.join(".multicc").join("official-accounts")
}

/// `readJsonIfExists`: an object or null (missing, unreadable, corrupt,
/// non-object all read as null).
fn read_json_if_exists(file: &Path) -> Value {
    match provider_store::read(file) {
        Ok(Some(value)) if value.is_object() => value,
        _ => Value::Null,
    }
}

/// `Number(value) || null` for a JSON value.
fn created_at(value: Option<&Value>) -> Option<f64> {
    let number = crate::js::serde::js_to_number(value?);
    if number.is_finite() && number != 0.0 {
        Some(number)
    } else {
        None
    }
}

fn claude_accounts(home: &Path) -> Vec<Account> {
    let base = accounts_root(home).join("claude");
    let Ok(entries) = std::fs::read_dir(&base) else {
        return Vec::new();
    };
    let mut list = Vec::new();
    for entry in entries.flatten() {
        if !matches!(entry.file_type(), Ok(kind) if kind.is_file()) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(id) = name.strip_suffix(".json") else {
            continue;
        };
        if !is_account_id(id) {
            continue;
        }
        let data = read_json_if_exists(&base.join(&name));
        let access = match data.get("access_token") {
            Some(Value::String(text)) => !js_trim(text).is_empty(),
            _ => false,
        };
        list.push(Account {
            id: id.to_string(),
            created_at: created_at(data.get("createdAt")),
            logged_in: access,
            label: data["label"].as_str().unwrap_or_default().trim().into(),
            email: data["email"].as_str().unwrap_or_default().into(),
            subscription: Value::Null,
        });
    }
    list
}

fn codex_accounts(home: &Path) -> Vec<Account> {
    let base = accounts_root(home).join("codex");
    let Ok(entries) = std::fs::read_dir(&base) else {
        return Vec::new();
    };
    let mut list = Vec::new();
    for entry in entries.flatten() {
        if !matches!(entry.file_type(), Ok(kind) if kind.is_dir()) {
            continue;
        }
        let id = entry.file_name().to_string_lossy().into_owned();
        if !is_account_id(&id) {
            continue;
        }
        let dir = base.join(&id);
        let meta = read_json_if_exists(&dir.join("account.json"));
        let auth = read_json_if_exists(&dir.join("auth.json"));
        // describeCodexAuth: `auth.tokens` must be an object and carry a
        // non-empty string access_token.
        let tokens = auth.get("tokens").filter(|tokens| tokens.is_object());
        let access = tokens
            .and_then(|tokens| tokens.get("access_token"))
            .and_then(Value::as_str)
            .is_some_and(|text| !js_trim(text).is_empty());
        let token = auth["tokens"]["id_token"]
            .as_str()
            .filter(|s| !s.is_empty())
            .or_else(|| auth["tokens"]["access_token"].as_str())
            .unwrap_or_default();
        list.push(Account {
            label: meta["label"].as_str().unwrap_or_default().trim().into(),
            email: crate::provider_credentials::jwt(token)["email"]
                .as_str()
                .unwrap_or_default()
                .into(),
            subscription: crate::provider_credentials::codex_subscription(&auth),
            id,
            created_at: created_at(meta.get("createdAt")),
            logged_in: access,
        });
    }
    list
}

fn accounts_of(home: &Path, kind: &str) -> Vec<Account> {
    let mut list = if kind == "codex" {
        codex_accounts(home)
    } else {
        claude_accounts(home)
    };
    // Array.prototype.sort is stable, so equal createdAt keeps readdir order.
    list.sort_by(|left, right| {
        left.created_at
            .unwrap_or(0.0)
            .partial_cmp(&right.created_at.unwrap_or(0.0))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    list
}

/// `readSelection()`: the file missing reads as `{}`, anything unreadable or
/// not JSON throws (provider_store::read is the native `readStateJson`).
fn read_selection(data_root: &Path) -> Result<Value, ()> {
    provider_store::read(&data_root.join("official-provider-selection.json"))
        .map(|value| value.unwrap_or_else(|| json!({})))
        .map_err(|_| ())
}

/// `officialCatalog.active(type)`.
fn active(selection: &Value, kind: &str) -> Result<String, ()> {
    let selected = selection.get(kind);
    match selected {
        None | Some(Value::Null) => Ok("global".to_string()),
        Some(Value::String(text)) if text == "global" => Ok("global".to_string()),
        Some(Value::String(text)) if is_account_id(text) => Ok(text.clone()),
        Some(_) => Err(()),
    }
}

fn default_account(selection: &Value, kind: &str, accounts: &[Account]) -> Result<String, ()> {
    let selected = active(selection, kind)?;
    let logged: Vec<&Account> = accounts
        .iter()
        .filter(|account| account.logged_in)
        .collect();
    if selected != "global" && logged.iter().any(|account| account.id == selected) {
        return Ok(selected);
    }
    Ok(logged
        .first()
        .map(|account| account.id.clone())
        .unwrap_or(selected))
}

fn list_official(
    selection: &Value,
    home: &Path,
    kind: &str,
    stored: &[Value],
) -> Result<Vec<Value>, ()> {
    let accounts = accounts_of(home, kind);
    let default = default_account(selection, kind, &accounts)?;
    let title = if kind == "codex" { "Codex" } else { "Claude" };
    let mut rows = vec![];
    for account in std::iter::once(None).chain(accounts.iter().filter(|a| a.logged_in).map(Some)) {
        let mut cfg = if kind == "codex" {
            json!({"auth":{"auth_mode":"chatgpt"},"config":""})
        } else {
            json!({"env":{}})
        };
        let mut id = official_id(kind);
        let mut name = format!("同 {title} 终端");
        if let Some(a) = account {
            id = format!("{id}-{}", a.id);
            let label = [&a.label, &a.email]
                .into_iter()
                .map(|s| s.trim())
                .find(|s| !s.is_empty())
                .unwrap_or(&a.id[..6]);
            name = format!("{title} 账号 · {label}");
            cfg["officialAccount"] = json!({"id":a.id});
        }
        let mut row = json!({"id":id,"name":name,"appType":kind,"source":"builtin","builtinOfficial":true,
            "activeAccountId":account.map_or("global",|a|&a.id),"isDefaultOfficial":account.is_some_and(|a|a.id==default),
            "accountEmail":account.map(|a|&a.email).filter(|s|!s.is_empty()),"subscription":account.map(|a|&a.subscription),"settingsConfig":cfg});
        if let Some(saved) = stored
            .iter()
            .find(|p| p["id"] == id && p["appType"] == kind)
        {
            row["egressIpAllowlist"] = saved["egressIpAllowlist"].clone();
            let binding = &saved["egressBinding"];
            if ["pluginId", "profileId"]
                .iter()
                .all(|k| binding[k].as_str().is_some_and(|s| !s.is_empty()))
            {
                row["egressBinding"] = binding.clone();
            }
        }
        rows.push(row);
    }
    Ok(rows)
}

/// `src/providers/official-catalog.js` `configOf`; a parsed `null` is the one
/// value that makes later `cfg.env` reads throw in JS, reported as Err.
pub(super) fn config_of(record: &Value) -> Result<Value, ()> {
    match record.get("settingsConfig") {
        Some(Value::String(text)) => {
            Ok(crate::json_lenient::from_str(text).unwrap_or_else(|_| json!({})))
        }
        Some(value) if truthy(value) => Ok(value.clone()),
        _ => Ok(json!({})),
    }
}

fn env_flag(env: Option<&Value>, key: &str) -> bool {
    env.and_then(|env| env.get(key)).is_some_and(truthy)
}

/// `isOfficial(record)` for a claude record.
fn is_official_claude(record: &Value) -> Result<bool, ()> {
    let config = config_of(record)?;
    if config.is_null() {
        // `cfg.env` on null throws; the route turns that into an empty list.
        return Err(());
    }
    let env = config.get("env").filter(|value| truthy(value));
    Ok(!env_flag(env, "ANTHROPIC_BASE_URL")
        && !env_flag(env, "ANTHROPIC_AUTH_TOKEN")
        && !env_flag(env, "ANTHROPIC_API_KEY"))
}

/// src/codex/official-relay.js `parseObject`.
fn parse_object(value: Option<&Value>) -> Value {
    if let Some(value) = value.filter(|value| value.is_object()) {
        return value.clone();
    }
    let text = match value {
        Some(value) if truthy(value) => js_string(value),
        _ => "{}".to_string(),
    };
    match crate::json_lenient::from_str::<Value>(&text) {
        Ok(parsed) if parsed.is_object() => parsed,
        _ => json!({}),
    }
}

pub fn official_codex(record: &Value) -> bool {
    if record["appType"] != "codex" {
        return false;
    }
    static BASE_URL: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let pattern = BASE_URL.get_or_init(|| {
        regex::Regex::new("(?i)(?:^|\\n)[\\s\\u{feff}]*base_url[\\s\\u{feff}]*=")
            .expect("base_url pattern")
    });
    let config = parse_object(record.get("settingsConfig"));
    let auth = parse_object(config.get("auth"));
    if auth.get("OPENAI_API_KEY").is_some_and(truthy)
        || config.get("proxyTarget").is_some_and(truthy)
    {
        return false;
    }
    let toml = config
        .get("config")
        .filter(|value| truthy(value))
        .map(js_string)
        .unwrap_or_default();
    if pattern.is_match(&toml) {
        return false;
    }
    let mode = auth
        .get("auth_mode")
        .filter(|value| truthy(value))
        .map(js_string)
        .unwrap_or_default()
        .to_lowercase();
    if !mode.is_empty() {
        return mode == "chatgpt";
    }
    record.get("source").and_then(Value::as_str) == Some("ccswitch")
        && record.get("id").and_then(Value::as_str) == Some("codex-official")
        && js_trim(&toml).is_empty()
        && !config.get("officialAccount").is_some_and(truthy)
}

/// `isOfficial(record)`: content-based only (an official-shaped id alone is
/// not enough; the id filter below covers those).
#[allow(clippy::result_unit_err)]
pub fn is_official(record: &Value) -> Result<bool, ()> {
    let Some(kind) = record.get("appType").and_then(Value::as_str) else {
        return Ok(false);
    };
    if !TYPES.contains(&kind) {
        return Ok(false);
    }
    if kind == "codex" {
        Ok(official_codex(record))
    } else {
        is_official_claude(record)
    }
}

/// `isOfficialProviderId(type, id)` for a raw record id (non-strings never
/// match: the first check is strict equality, the second requires a string).
pub fn is_official_provider_id(kind: &str, id: Option<&Value>) -> bool {
    let Some(Value::String(id)) = id else {
        return false;
    };
    let alias = official_id(kind);
    if id == &alias {
        return true;
    }
    id.strip_prefix(&format!("{alias}-"))
        .is_some_and(is_account_id)
}

fn records(data_root: &Path) -> Result<Vec<Value>, ()> {
    let value = provider_store::read(&data_root.join("providers.json")).map_err(|_| ())?;
    provider_store::records(&value).map_err(|_| ())
}

/// `officialCatalog.list(type)`.
pub(super) fn list(data_root: &Path, home: &Path, kind: &str) -> Result<Vec<Value>, ()> {
    let mut rows = Vec::new();
    let stored = records(data_root)?;
    let selection = read_selection(data_root)?;
    for official in TYPES {
        rows.extend(list_official(&selection, home, official, &stored)?);
    }
    for record in stored {
        if record.is_null() {
            // The Node filter reads `p.id` on a null record: TypeError, empty
            // list for the whole call.
            return Err(());
        }
        if is_official(&record)? {
            continue;
        }
        if TYPES
            .iter()
            .any(|official| is_official_provider_id(official, record.get("id")))
        {
            continue;
        }
        rows.push(record);
    }
    Ok(rows
        .into_iter()
        .filter(|row| kind.is_empty() || row.get("appType").and_then(Value::as_str) == Some(kind))
        .collect())
}

pub fn initial_selection(records: &Value, defaults: &Value) -> Value {
    let mut choice = json!({});
    for kind in TYPES {
        let record = records
            .as_array()
            .into_iter()
            .flatten()
            .find(|r| r["appType"] == kind && r["id"] == defaults[kind]);
        let marker = record
            .and_then(|r| config_of(r).ok())
            .map(|cfg| js_string(&cfg["officialAccount"]["id"]));
        choice[kind] = marker
            .filter(|s| is_account_id(s))
            .unwrap_or_else(|| "global".into())
            .into();
    }
    choice
}

pub fn normalize_default(
    root: &Path,
    home: &Path,
    kind: &str,
    id: &Value,
) -> Result<Value, &'static str> {
    let alias = official_id(kind);
    if !truthy(id) || id == "_default_" || id == &alias {
        return Ok(alias.into());
    }
    let exists = |account: &str| accounts_of(home, kind).iter().any(|a| a.id == account);
    if let Some(account) = id
        .as_str()
        .and_then(|s| s.strip_prefix(&format!("{alias}-")))
        .filter(|s| is_account_id(s))
    {
        return Ok(if exists(account) {
            id.clone()
        } else {
            alias.into()
        });
    }
    if let Some(old) = records(root)
        .map_err(|_| "invalid providers")?
        .iter()
        .find(|p| p["appType"] == kind && p["id"] == *id)
    {
        if is_official(old).map_err(|_| "invalid provider")? {
            let cfg = config_of(old).map_err(|_| "invalid settings")?;
            return Ok(cfg["officialAccount"]["id"]
                .as_str()
                .filter(|s| is_account_id(s) && exists(s))
                .map(|s| format!("{alias}-{s}"))
                .unwrap_or(alias)
                .into());
        }
    }
    Ok(id.clone())
}

/// Identities for one `listProviders(type)` call: `[{appType, providerId}]`
/// with the skipped rows of `providerIdentities` applied.
pub fn identities(data_root: &Path, home: &Path, app_type: &str, id: &str) -> Vec<Value> {
    let wanted: Vec<&str> = if TYPES.contains(&app_type) {
        vec![app_type]
    } else {
        TYPES.to_vec()
    };
    let mut out = Vec::new();
    for kind in wanted {
        let Ok(rows) = list(data_root, home, kind) else {
            continue;
        };
        for row in rows {
            let Some(row_id) = row.get("id") else {
                continue;
            };
            if !truthy(row_id) {
                continue;
            }
            if !id.is_empty() && row_id != &Value::String(id.to_string()) {
                continue;
            }
            let app = row
                .get("appType")
                .filter(|value| truthy(value))
                .cloned()
                .unwrap_or_else(|| Value::String(kind.to_string()));
            out.push(json!({ "appType": app, "providerId": js_string(row_id) }));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "multicc-provider-catalog-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn record(id: Value, app_type: Value) -> Value {
        json!({"id": id, "appType": app_type, "settingsConfig": {"env": {"ANTHROPIC_BASE_URL": "https://relay"}}})
    }

    #[test]
    fn relay_records_follow_the_file_and_official_ones_are_hidden() {
        let dir = temp("order");
        let home = dir.join("home");
        std::fs::write(
            dir.join("providers.json"),
            json!([
                record(json!("relay"), json!("claude")),
                {"id": "claude-official", "appType": "claude", "settingsConfig": {"env": {}}},
                {"id": "claude-official-0123456789abcdef", "appType": "claude"},
                record(json!("relay"), json!("claude")),
            ])
            .to_string(),
        )
        .unwrap();
        let ids = identities(&dir, &home, "claude", "");
        let pairs: Vec<(String, String)> = ids
            .iter()
            .map(|row| {
                (
                    row["appType"].as_str().unwrap_or_default().to_string(),
                    row["providerId"].as_str().unwrap_or_default().to_string(),
                )
            })
            .collect();
        assert_eq!(
            pairs,
            vec![
                ("claude".into(), "claude-official".into()),
                ("claude".into(), "relay".into()),
                ("claude".into(), "relay".into()),
            ]
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn logged_in_accounts_join_after_the_alias_and_the_id_filter_is_strict() {
        let dir = temp("accounts");
        let home = dir.join("home");
        let claude = home
            .join(".multicc")
            .join("official-accounts")
            .join("claude");
        std::fs::create_dir_all(&claude).unwrap();
        std::fs::write(
            claude.join("0123456789abcdef.json"),
            json!({"access_token": " live ", "createdAt": 100}).to_string(),
        )
        .unwrap();
        std::fs::write(
            claude.join("fedcba9876543210.json"),
            json!({"access_token": "  ", "createdAt": 50}).to_string(),
        )
        .unwrap();
        std::fs::write(claude.join("not-an-account.json"), "{}").unwrap();
        let ids = identities(&dir, &home, "claude", "");
        assert_eq!(ids.len(), 2);
        assert_eq!(ids[1]["providerId"], "claude-official-0123456789abcdef");
        assert!(identities(&dir, &home, "claude", "0123456789abcdef").is_empty());
        let filtered = identities(&dir, &home, "claude", "claude-official-0123456789abcdef");
        assert_eq!(filtered.len(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn corrupt_inputs_empty_the_list_and_the_selection_is_checked() {
        let dir = temp("corrupt");
        let home = dir.join("home");
        std::fs::write(dir.join("providers.json"), "{not json").unwrap();
        assert!(identities(&dir, &home, "claude", "").is_empty());
        std::fs::write(dir.join("providers.json"), "[]").unwrap();
        std::fs::write(dir.join("official-provider-selection.json"), "{broken").unwrap();
        assert!(identities(&dir, &home, "claude", "").is_empty());
        std::fs::write(
            dir.join("official-provider-selection.json"),
            json!({"claude": "zzz"}).to_string(),
        )
        .unwrap();
        assert!(identities(&dir, &home, "claude", "").is_empty());
        std::fs::write(
            dir.join("official-provider-selection.json"),
            json!({"claude": "0123456789abcdef"}).to_string(),
        )
        .unwrap();
        assert_eq!(identities(&dir, &home, "claude", "").len(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn numeric_ids_survive_unfiltered_but_never_match_the_query_id() {
        let dir = temp("numeric");
        let home = dir.join("home");
        std::fs::write(
            dir.join("providers.json"),
            json!([
                record(json!(42), json!("claude")),
                record(json!(0), json!("claude"))
            ])
            .to_string(),
        )
        .unwrap();
        let ids = identities(&dir, &home, "claude", "");
        assert_eq!(ids.len(), 2);
        assert_eq!(ids[0]["providerId"], "claude-official");
        assert_eq!(ids[1]["providerId"], "42");
        assert!(identities(&dir, &home, "claude", "42").is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }
}
