//! 官方账号目录与凭据存储；不读取全局 CLI 登录，不持有凭据缓存。
use crate::{codex_home_fs::*, provider_credentials};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub fn valid_id(id: &str) -> bool {
    id.len() == 16
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub fn account_path(root: &Path, id: &str, kind: &str) -> Result<PathBuf> {
    if !valid_id(id) {
        return Err(Failure::new(
            "OFFICIAL_ACCOUNT_ID_INVALID",
            "invalid official account id",
        ));
    }
    let relative = match kind {
        "codexDir" => PathBuf::from("codex").join(id),
        "codexAuthFile" => PathBuf::from("codex").join(id).join("auth.json"),
        "codexMetaFile" => PathBuf::from("codex").join(id).join("account.json"),
        "claudeHomeDir" => PathBuf::from("claude").join(format!("{id}.home")),
        _ => PathBuf::from("claude").join(format!("{id}.json")),
    };
    let target = absolute(&root.join(relative))?;
    let root = absolute(root)?;
    if !target.starts_with(&root) {
        return Err(Failure::new(
            "OFFICIAL_ACCOUNT_PATH_ESCAPE",
            "official account path escapes store root",
        ));
    }
    Ok(target)
}
pub fn ids(root: &Path, claude: bool) -> Vec<String> {
    let base = root.join(if claude { "claude" } else { "codex" });
    let Ok(entries) = fs::read_dir(base) else {
        return vec![];
    };
    let mut out = vec![];
    for e in entries {
        let Ok(e) = e else {
            return vec![];
        };
        let Ok(t) = e.file_type() else {
            return vec![];
        };
        if t.is_symlink() {
            continue;
        }
        let name = e.file_name().to_string_lossy().into_owned();
        let id = if claude && t.is_file() {
            name.strip_suffix(".json")
        } else if !claude && t.is_dir() {
            Some(name.as_str())
        } else {
            None
        };
        if let Some(id) = id.filter(|id| valid_id(id)) {
            out.push(id.into());
        }
    }
    out.sort();
    out
}
pub fn credential(
    file: &Path,
    operation: &str,
    data: Option<Value>,
    claude: bool,
    now: Option<Value>,
) -> std::result::Result<Value, String> {
    let mut input = json!({"operation":operation,"file":file.to_string_lossy()});
    if let Some(data) = data {
        input["data"] = data;
    }
    if claude {
        input["claude"] = json!(true);
    }
    if let Some(now) = now {
        input["now"] = now;
    }
    provider_credentials::run(&input)
}
pub fn rewritten_since(file: &Path, imported_at: f64) -> bool {
    imported_at.is_finite()
        && fs::metadata(file)
            .ok()
            .and_then(|m| m.modified().ok())
            .is_some_and(|m| millis(m) > imported_at + 2000.)
}
pub fn delete(root: &Path, id: &str, claude: bool) -> Result<()> {
    if claude {
        remove(&account_path(root, id, "claudeFile")?, false)?;
        remove(&account_path(root, id, "claudeHomeDir")?, true)
    } else {
        remove(&account_path(root, id, "codexDir")?, true)
    }
}
