//! OpenCode configuration and model names, and the local AGY ACP listing.
use regex::Regex;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    process::Stdio,
    sync::OnceLock,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
};

pub const HOST_PATH: &str = "/api/__host/model-catalogs";
pub const MAX_MODELS: usize = 1000;

fn clean(s: &str) -> &str {
    s.trim_matches(crate::js::is_js_whitespace_char)
}

pub fn parse_open_code(stdout: &str) -> Vec<Value> {
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    for raw in stdout.split('\n') {
        let line = clean(raw);
        if line.starts_with('#') {
            continue;
        }
        let Some((provider, model)) = line.split_once('/') else {
            continue;
        };
        if provider.is_empty() || model.is_empty() {
            continue;
        }
        let (provider, model) = (clean(provider), clean(model));
        let label = format!("{provider}/{model}");
        if seen.insert(label.clone()) {
            result.push(json!({"provider":provider,"model":model,"label":label}));
        }
        if result.len() == MAX_MODELS {
            break;
        }
    }
    result
}

fn providers(home: &Path) -> impl Iterator<Item = Value> + '_ {
    static BLOCK: OnceLock<Regex> = OnceLock::new();
    static LINE: OnceLock<Regex> = OnceLock::new();
    let block = BLOCK.get_or_init(|| Regex::new(r"(?s)/\*.*?\*/").unwrap());
    let line = LINE.get_or_init(|| Regex::new(r"(?m)^\s*//[^\r\n]*").unwrap());
    ["opencode.json", "opencode.jsonc"]
        .into_iter()
        .filter_map(move |file| {
            let raw = std::fs::read_to_string(home.join(".config/opencode").join(file)).ok()?;
            let stripped = block.replace_all(&raw, "");
            let v: Value = serde_json::from_str(&line.replace_all(&stripped, "")).ok()?;
            v.get("provider")
                .filter(|p| p.is_object() || p.is_array())
                .cloned()
        })
}
pub fn open_code_providers(home: &Path) -> Value {
    providers(home).next().unwrap_or(Value::Null)
}

/// Match Object.entries, including array index ordering ahead of string keys.
pub fn entries(value: &Value) -> Vec<(String, &Value)> {
    if let Some(array) = value.as_array() {
        return array
            .iter()
            .enumerate()
            .map(|(i, v)| (i.to_string(), v))
            .collect();
    }
    let mut pairs: Vec<_> = value
        .as_object()
        .into_iter()
        .flatten()
        .map(|(k, v)| (k.clone(), v))
        .collect();
    pairs.sort_by_key(|(k, _)| {
        k.parse::<u32>()
            .ok()
            .filter(|n| *n < u32::MAX && n.to_string() == *k)
            .unwrap_or(u32::MAX)
    });
    pairs
}
pub fn configured(providers: &Value, dynamic: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for (provider, cfg) in entries(providers) {
        let live = dynamic
            .get(&provider)
            .and_then(Value::as_array)
            .filter(|a| !a.is_empty());
        if let Some(live) = live {
            for row in live {
                let id = row["model"].as_str().unwrap_or_default();
                if seen.insert(format!("{provider}/{id}")) {
                    out.push(row.clone());
                }
                if out.len() >= MAX_MODELS {
                    return out;
                }
            }
        } else {
            for (id, model) in entries(&cfg["models"]) {
                let key = format!("{provider}/{id}");
                if seen.insert(key.clone()) {
                    let label = model.get("name").and_then(Value::as_str).unwrap_or(&key);
                    out.push(
                        json!({"provider":provider,"model":id,"label":format!("{key} ({label})")}),
                    );
                }
                if out.len() >= MAX_MODELS {
                    return out;
                }
            }
        }
    }
    out
}
pub fn open_code_fallback(home: &Path) -> Vec<Value> {
    providers(home)
        .map(|p| configured(&p, &Value::Null))
        .find(|v| !v.is_empty())
        .unwrap_or_default()
}
pub fn authorized_providers(home: &Path, xdg: Option<&str>) -> Vec<String> {
    for dir in xdg
        .filter(|d| !d.is_empty())
        .map(PathBuf::from)
        .into_iter()
        .chain([home.join(".local/share")])
    {
        let Ok(raw) = std::fs::read_to_string(dir.join("opencode/auth.json")) else {
            continue;
        };
        if let Ok(v) = serde_json::from_str::<Value>(&raw) {
            if v.is_object() || v.is_array() {
                return entries(&v).into_iter().map(|(k, _)| k).collect();
            }
        }
    }
    Vec::new()
}

fn similarity(a: &str, b: &str) -> f64 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    if a == b {
        return 1.0;
    }
    if a.starts_with(b) || b.starts_with(a) {
        return 0.92;
    }
    if a.contains(b) || b.contains(a) {
        return 0.85;
    }
    let left: Vec<_> = a.encode_utf16().collect();
    let right: Vec<_> = b.encode_utf16().collect();
    let mut row: Vec<_> = (0..=right.len()).collect();
    for (i, x) in left.iter().enumerate() {
        let mut previous = row[0];
        row[0] = i + 1;
        for (j, y) in right.iter().enumerate() {
            let old = row[j + 1];
            row[j + 1] = (old + 1)
                .min(row[j] + 1)
                .min(previous + usize::from(x != y));
            previous = old;
        }
    }
    1.0 - row[right.len()] as f64 / left.len().max(right.len()) as f64
}
pub fn validate_open_code(raw: &str, models: &[(String, String)]) -> Option<Option<String>> {
    let (provider, target) = clean(raw).split_once('/')?;
    if provider.is_empty() || target.is_empty() || models.is_empty() {
        return None;
    }
    let alias = |s: &str| {
        s.to_lowercase()
            .chars()
            .filter(char::is_ascii_alphanumeric)
            .collect::<String>()
    };
    let exact = models.iter().any(|(p, _)| p == provider);
    let id = if exact {
        provider
    } else {
        let wanted = alias(provider);
        let ids: HashSet<_> = models
            .iter()
            .map(|(p, _)| p.as_str())
            .filter(|p| alias(p) == wanted)
            .collect();
        if ids.len() != 1 {
            return None;
        }
        *ids.iter().next()?
    };
    let mut best = None;
    let mut high = 0.0;
    for (p, m) in models.iter().filter(|(p, _)| p == id) {
        if m == target {
            return if exact {
                None
            } else {
                Some(Some(format!("{id}/{target}")))
            };
        }
        let score = similarity(target, m);
        if score > high {
            high = score;
            best = Some(format!("{p}/{m}"));
        }
    }
    Some(if high >= 0.6 { best } else { None })
}

pub fn agy_model_option(session: &Value) -> Option<&Value> {
    session
        .get("configOptions")?
        .as_array()?
        .iter()
        .find(|o| o["id"] == "model" || o["category"] == "model")
}
pub fn agy_rows(session: &Value) -> Vec<Value> {
    agy_model_option(session)
        .and_then(|m| m.get("options"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|o| {
            let id = clean(o.get("value")?.as_str()?);
            if id.is_empty() || id.encode_utf16().count() > 100 {
                return None;
            }
            Some(json!({"model":id,"label":o.get("name").and_then(Value::as_str).unwrap_or(id)}))
        })
        .collect()
}
fn agy_executable() -> PathBuf {
    if let Some(cmd) = std::env::var_os("AGY_CMD").filter(|v| !v.is_empty()) {
        return cmd.into();
    }
    let name = if cfg!(windows) { "agy.exe" } else { "agy" };
    let mut candidates = Vec::new();
    if let Some(home) = std::env::var_os("HOME").filter(|h| !h.is_empty()) {
        candidates.push(PathBuf::from(home).join(".local/bin").join(name));
    }
    if cfg!(target_os = "macos") {
        candidates.extend([
            PathBuf::from("/opt/homebrew/bin/agy"),
            PathBuf::from("/usr/local/bin/agy"),
        ]);
    }
    candidates
        .into_iter()
        .find(|p| p.is_file())
        .unwrap_or_else(|| name.into())
}
pub async fn agy_query(
    pin: HashMap<String, String>,
    cwd: String,
    timeout_ms: u64,
) -> Result<Vec<Value>, String> {
    let mut cmd = Command::new(agy_executable());
    cmd.arg("acp")
        .envs(pin)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let mut stdin = child.stdin.take().ok_or("missing stdin")?;
    let mut reader = BufReader::new(child.stdout.take().ok_or("missing stdout")?).lines();
    let query = async {
        let initialize = json!({
            "protocolVersion": 1,
            "clientCapabilities": {},
            "clientInfo": { "name": "multicc-models", "version": "1.0.0" }
        });
        let session = json!({"cwd": cwd, "mcpServers": []});
        for (id, method, params) in [(1, "initialize", initialize), (2, "session/new", session)] {
            let request = json!({"jsonrpc":"2.0", "id":id, "method":method, "params":params});
            stdin
                .write_all(format!("{request}\n").as_bytes())
                .await
                .map_err(|e| e.to_string())?;
            loop {
                let line = reader
                    .next_line()
                    .await
                    .map_err(|e| e.to_string())?
                    .ok_or("agy acp closed early")?;
                if line.encode_utf16().count() > 4_000_000 {
                    return Err(String::from("agy acp line too long"));
                }
                let reply: Value =
                    serde_json::from_str(&line).map_err(|_| "agy acp sent invalid json")?;
                if crate::js::serde::js_to_number(&reply["id"]) != f64::from(id) {
                    continue;
                }
                if !crate::js::serde::truthy(&reply["result"]) {
                    return Err("agy acp answered without a result".into());
                }
                if id == 2 {
                    let models = agy_rows(&reply["result"]);
                    if models.is_empty() {
                        return Err("agy acp returned no model option".into());
                    }
                    return Ok(models);
                }
                break;
            }
        }
        Err("agy acp closed early".into())
    };
    let result = tokio::time::timeout(Duration::from_millis(timeout_ms), query)
        .await
        .unwrap_or_else(|_| Err(String::from("agy acp timeout")));
    drop(stdin);
    #[cfg(unix)]
    if let Some(id) = child.id() {
        // Node's ChildProcess.kill() defaults to SIGTERM. Reap outside of the
        // listing promise so a slow child cannot delay cache publication.
        unsafe { libc::kill(id as libc::pid_t, libc::SIGTERM) };
        tokio::spawn(async move {
            if tokio::time::timeout(Duration::from_secs(1), child.wait())
                .await
                .is_err()
            {
                let _ = child.kill().await;
            }
        });
    }
    #[cfg(not(unix))]
    let _ = child.start_kill();
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn agy_ids_obey_the_host_utf16_limit() {
        let fits = "语".repeat(100);
        let too_long = "🎙".repeat(51);
        let session = json!({"configOptions":[{"category":"model","options":[
            {"value":too_long},{"value":format!(" {fits} ")}
        ]}]});
        assert_eq!(agy_rows(&session), vec![json!({"model":fits,"label":fits})]);
    }

    #[test]
    fn configuration_obeys_object_key_order_and_live_provider_replacement() {
        let providers = json!({
            "z":{"models":{"old":{}}},
            "12":{"models":{"b":{}}},
            "2":{"models":{"a":{"name":"Alpha"}}}
        });
        let live = json!({"z":[{"provider":"z","model":"new","label":"z/new"}]});
        let actual = configured(&providers, &live);
        let labels: Vec<_> = actual
            .iter()
            .map(|r| r["label"].as_str().unwrap())
            .collect();
        assert_eq!(labels, ["2/a (Alpha)", "12/b (12/b)", "z/new"]);
    }

    #[test]
    fn a_provider_alias_must_be_unique() {
        let rows = vec![
            ("my-cli".into(), "model".into()),
            ("my_cli".into(), "model".into()),
        ];
        assert_eq!(validate_open_code("mycli/model", &rows), None);
        assert_eq!(
            validate_open_code("MYCLI/model", &rows[..1]),
            Some(Some("my-cli/model".into()))
        );
    }
}
