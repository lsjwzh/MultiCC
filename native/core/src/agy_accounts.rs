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
use crate::auth_runtime::now_ms;
use crate::provider_store;
use crate::state_file;

const CLI: &str = "agy";
const ACTIVE_FILE: &str = "active.json";
const HOME_SUFFIX: &str = ".home";
const META_SUFFIX: &str = ".json";
const MAX_LABEL: usize = 64;
const DEFAULT_LABEL: &str = "反重力账号";

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
            let status = login_status(home, id);
            let label = meta
                .get("label")
                .and_then(Value::as_str)
                .filter(|label| !label.is_empty())
                .unwrap_or(id);
            Some(json!({
                "id": id,
                "label": label,
                "email": status.get("email").cloned().unwrap_or(Value::Null),
                "loggedIn": status["loggedIn"],
                "expiresAt": status.get("expiresAt").cloned().unwrap_or(Value::Null),
                "createdAt": meta.get("createdAt").cloned().unwrap_or(Value::Null),
                "source": meta.get("source").cloned().unwrap_or(Value::Null),
                "active": active.as_deref() == Some(id),
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
    let id = random_id()?;
    let dir = account_home(home, &id).ok_or("invalid account id")?;
    let meta = meta_file(home, &id).ok_or("invalid account id")?;
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    set_dir_mode(&dir);
    let record = json!({
        "id": id,
        "label": clean_label(label),
        "createdAt": now_ms().floor() as i64,
        "source": source,
    });
    state_file::write_json_atomic(&meta, &record).map_err(|err| err.to_string())?;
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
