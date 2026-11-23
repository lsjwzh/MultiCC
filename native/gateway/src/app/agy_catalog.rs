//! Antigravity (`agy`) model catalog. The logical models come from a real ACP
//! `session/new` on the signed-in account, so they follow whatever tier the
//! user has instead of a hard-coded table.
//!
//! Kept apart from the generic `model_catalogs` cluster because agy is the one
//! catalog the front door spawns itself — it needs the account session, not a
//! Node host op. The process cache and the single-flight lock live here; the
//! route shape stays in `model_catalogs`.
use serde_json::{json, Value};
use std::{
    ffi::OsString,
    process::Stdio,
    sync::OnceLock,
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

/// `(when, models)` — `None` records a failed probe inside the same window.
type CacheEntry = Option<(Instant, Option<Vec<Value>>)>;
static CACHE: OnceLock<Mutex<CacheEntry>> = OnceLock::new();

pub(super) fn executable() -> OsString {
    if let Some(cmd) = std::env::var_os("AGY_CMD").filter(|v| !v.is_empty()) {
        return cmd;
    }
    let binary = if cfg!(windows) { "agy.exe" } else { "agy" };
    let mut candidates = Vec::new();
    if let Some(home) = std::env::var_os("HOME") {
        candidates.push(
            std::path::PathBuf::from(home)
                .join(".local/bin")
                .join(binary),
        );
    }
    if cfg!(target_os = "macos") {
        // Mirrors resolveAgy() in src/cli-adapters/commands.js: Homebrew installs
        // are not always on the service PATH.
        candidates.push(std::path::PathBuf::from("/opt/homebrew/bin").join(binary));
        candidates.push(std::path::PathBuf::from("/usr/local/bin").join(binary));
    }
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .map(|path| path.into_os_string())
        .unwrap_or_else(|| binary.into())
}

fn model_options(session: &Value) -> Vec<Value> {
    let Some(options) = session.get("configOptions").and_then(Value::as_array) else {
        return vec![];
    };
    let Some(model) = options
        .iter()
        .find(|item| item["id"] == "model" || item["category"] == "model")
    else {
        return vec![];
    };
    model
        .get("options")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let id = item.get("value")?.as_str()?.trim();
            if id.is_empty() || id.len() > 100 {
                return None;
            }
            let label = item.get("name").and_then(Value::as_str).unwrap_or(id);
            Some(json!({"model": id, "label": label}))
        })
        .collect()
}

async fn fetch() -> Result<Vec<Value>, ()> {
    let mut command = Command::new(executable());
    command
        .arg("acp")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    // The model list follows the signed-in account; agy reads its login from
    // `$HOME/.gemini`, so a pinned account is served by pointing HOME at its
    // mini-home. No pin leaves the real home untouched.
    if let Some(home) = super::agy_accounts::home_override() {
        command.env("HOME", home);
    }
    let mut child = command.spawn().map_err(|_| ())?;
    let mut stdin = child.stdin.take().ok_or(())?;
    let mut stdout = BufReader::new(child.stdout.take().ok_or(())?).lines();
    for (id, method, params) in [
        (
            1,
            "initialize",
            json!({"protocolVersion":1,"clientCapabilities":{},"clientInfo":{"name":"multicc-models","version":"1.0.0"}}),
        ),
        (
            2,
            "session/new",
            json!({"cwd":std::env::current_dir().map_err(|_| ())?,"mcpServers":[]}),
        ),
    ] {
        let request = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
        stdin
            .write_all(format!("{}\n", request).as_bytes())
            .await
            .map_err(|_| ())?;
        loop {
            let line = stdout.next_line().await.map_err(|_| ())?.ok_or(())?;
            if line.len() > MAX_LINE {
                return Err(());
            }
            let message: Value = serde_json::from_str(&line).map_err(|_| ())?;
            if message.get("id").and_then(Value::as_i64) != Some(id) {
                continue;
            }
            let result = message.get("result").ok_or(())?;
            if id == 2 {
                let models = model_options(result);
                return if models.is_empty() {
                    Err(())
                } else {
                    Ok(models)
                };
            }
            break;
        }
    }
    Err(())
}

/// The cached catalog describes the previous account, so an account switch
/// must drop it instead of waiting out the ten-minute TTL.
pub(super) async fn invalidate() {
    if let Some(cache) = CACHE.get() {
        *cache.lock().await = None;
    }
}

/// The catalog plus whether it came from the process cache. The caller owns the
/// request timeout; a failed probe yields `None` and is remembered for
/// [`FAIL_TTL`] unless `refresh` is set.
pub(super) async fn models(refresh: bool) -> Option<(Vec<Value>, bool)> {
    let mut cache = CACHE.get_or_init(|| Mutex::new(None)).lock().await;
    if !refresh {
        if let Some((when, entry)) = cache.as_ref() {
            let ttl = if entry.is_some() { TTL } else { FAIL_TTL };
            if when.elapsed() < ttl {
                return entry.clone().map(|models| (models, true));
            }
        }
    }
    match fetch().await {
        Ok(models) => {
            *cache = Some((Instant::now(), Some(models.clone())));
            Some((models, false))
        }
        Err(()) => {
            *cache = Some((Instant::now(), None));
            None
        }
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
        let models = model_options(&session);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0]["model"], "gemini-4-neon");
        assert_eq!(models[0]["label"], "Gemini 4 Neon");
        assert_eq!(models[1]["label"], "claude-sonnet-5-5");
    }

    #[test]
    fn no_model_option_is_an_empty_catalog() {
        assert!(model_options(&json!({"configOptions":[]})).is_empty());
        assert!(model_options(&json!({})).is_empty());
    }
}
