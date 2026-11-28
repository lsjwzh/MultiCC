//! Concrete models advertised by the signed-in agy account. The gateway owns
//! discovery; its short-lived, atomic snapshot is also readable by the CLI host.
use crate::{account_subscription::valid_account, agy_accounts, cli_capability, state_file};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub const TTL: Duration = Duration::from_secs(600);
pub type Models = BTreeMap<String, String>;

pub fn accounts_home() -> Option<PathBuf> {
    ["MULTICC_AGY_ACCOUNTS_HOME", "HOME", "USERPROFILE"]
        .iter()
        .find_map(|key| {
            std::env::var_os(key)
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
        })
}

pub fn account_key(pin: Option<&str>) -> String {
    pin.filter(|s| !s.is_empty())
        .map(str::to_owned)
        .or_else(|| accounts_home().and_then(|home| agy_accounts::active_id(&home)))
        .unwrap_or_else(|| "__default__".into())
}

fn file(home: &Path, key: &str) -> Option<PathBuf> {
    (key == "__default__" || valid_account(key)).then(|| {
        agy_accounts::account_root(home)
            .join("model-cache")
            .join(format!("{key}.json"))
    })
}

#[derive(Deserialize, Serialize)]
struct Snapshot {
    fetched: u64,
    models: Models,
}
fn now() -> Option<u64> {
    Some(SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs())
}

pub fn cached(key: &str) -> Option<Models> {
    let path = file(&accounts_home()?, key)?;
    let snapshot: Snapshot =
        serde_json::from_value(crate::provider_store::read(&path).ok()??).ok()?;
    (now()?.checked_sub(snapshot.fetched)? < TTL.as_secs()).then_some(snapshot.models)
}

pub fn publish(home: &Path, key: &str, models: Option<&Models>) {
    let Some(path) = file(home, key) else { return };
    if let (Some(models), Some(fetched)) = (models, now()) {
        let _ =
            state_file::write_json_atomic(&path, &json!({ "fetched": fetched, "models": models }));
    } else {
        let _ = fs::remove_file(path);
    }
}

pub fn concrete_models(rows: &Value, id_key: &str, label_key: &str) -> Option<Models> {
    let mut models = Models::new();
    for row in rows.as_array()? {
        let Some(id) = row[id_key]
            .as_str()
            .map(str::trim)
            .filter(|id| !id.is_empty() && id.len() <= 100 && !id.chars().any(char::is_control))
        else {
            continue;
        };
        let label = row[label_key]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty() && s.len() <= 160 && !s.chars().any(char::is_control))
            .unwrap_or(id);
        models.insert(id.to_owned(), label.to_owned());
    }
    Some(models)
}

pub fn effort_spec(models: &Models) -> Value {
    let mut spec = cli_capability::effort_of("agy").expect("bundled agy effort spec");
    let levels = std::mem::take(&mut spec.levels);
    spec.model_levels.clear();
    spec.disabled_model_family = None;
    for level in levels.iter().filter(|s| !s.is_empty()) {
        let suffix = format!("-{level}");
        for family in models.keys().filter_map(|id| id.strip_suffix(&suffix)) {
            spec.model_levels
                .entry(family.to_owned())
                .or_insert_with(|| vec![String::new()])
                .push(level.clone());
        }
    }
    let mut value = json!(spec);
    value["concreteModels"] = json!(models);
    value
}
