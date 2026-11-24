//! Legacy session-list facts for a gateway that owns its own WebSocket runtime.
use super::{store, Host};
use crate::app::App;
use multicc_core::{
    auth_runtime, chat_history_file, cli_capability, cli_switch, cli_switch_runtime, durable_state,
    js, js::serde::truthy, model_default, provider_store, session_admin, session_records,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::SystemTime,
};

#[derive(Default)]
pub(super) struct HistoryTimes(Mutex<HashMap<PathBuf, (SystemTime, u64, f64)>>);

pub(crate) fn ensure_aux(root: &Path, package: &Path) -> Result<(), String> {
    let mut records = store::records(root)?;
    if let Some(record) = records
        .iter_mut()
        .rev()
        .find(|r| store::text(r, "id") == "__aux__")
    {
        if store::text(record, "type") == "aux" {
            return Ok(());
        }
        multicc_core::quota_guard::set(record, "type", js::JsValue::from("aux"));
        multicc_core::quota_guard::set(record, "label", js::JsValue::from("AI Assistant"));
    } else {
        records.push(js::from_serde(&json!({"id":"__aux__","cwd":package,"createdAt":session_records::iso_timestamp_now(),"type":"aux","label":"AI Assistant"})));
    }
    durable_state::save(
        &root.join("sessions.json"),
        "sessions",
        &js::JsValue::Array(records),
    )
}

fn aux(record: &Value, clients: usize, status: Value) -> Value {
    let last = status["lastTaskTime"]
        .as_i64()
        .and_then(chrono::DateTime::from_timestamp_millis)
        .map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
    let mut row = json!({"id":"__aux__","lastActivity":last,"clients":clients,"active":status["processing"],"type":"aux",
        "label":record["label"].as_str().filter(|s|!s.is_empty()).unwrap_or("AI Assistant"),"auxStatus":status});
    for k in ["cwd", "createdAt"] {
        if let Some(v) = record.get(k) {
            row[k] = v.clone();
        }
    }
    row
}

fn json_file(path: &Path) -> Value {
    std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}
fn effort(record: &Value, cli: &str, home: &Path, effective: &Value) -> Value {
    let s = record["effort"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_lowercase();
    let Some(spec) = cli_capability::effort_of(cli) else {
        return Value::Null;
    };
    let levels = spec.levels_for_model(effective.as_str().unwrap_or(""));
    if levels.is_empty() {
        return Value::Null;
    }
    let codex = matches!(cli, "codex" | "codex-exp");
    let supported = |level: &str, name: &str| {
        if codex && matches!(level, "max" | "ultra") {
            let name = name.rsplit('/').next().unwrap_or("").to_ascii_lowercase();
            let name = name.split('[').next().unwrap_or("");
            let version = ["gpt-5.6", "gpt5.6", "gpt_5.6", "gpt.5.6"]
                .iter()
                .find_map(|prefix| name.strip_prefix(prefix));
            if !version.is_some_and(|v| v.is_empty() || v.starts_with(['-', '_', '.'])) {
                return json!("xhigh");
            }
        }
        json!(level)
    };
    if !s.is_empty() && levels.contains(&s) {
        return supported(&s, effective.as_str().unwrap_or(""));
    }
    if codex {
        for dir in std::env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .into_iter()
            .chain(Some(home.join(".codex")))
        {
            let Ok(config) = std::fs::read_to_string(dir.join("config.toml")) else {
                continue;
            };
            let setting = |key: &str| {
                config
                    .lines()
                    .filter_map(|line| line.split_once('='))
                    .find(|(k, _)| k.trim() == key)
                    .map(|(_, v)| v.trim().trim_matches(['"', '\'']))
                    .unwrap_or("")
            };
            let level = setting("model_reasoning_effort").to_ascii_lowercase();
            if !level.is_empty() && levels.contains(&level) {
                return supported(&level, setting("model"));
            }
        }
        return json!("xhigh");
    }
    if !matches!(cli, "claude" | "claude-exp") {
        return Value::Null;
    }
    for f in ["settings.local.json", "settings.json"] {
        let cfg = json_file(&home.join(".claude").join(f));
        if let Some(s) = cfg["effort"]
            .as_str()
            .or(cfg["thinkingEffort"].as_str())
            .filter(|s| !s.is_empty())
        {
            let s = s.trim().to_ascii_lowercase();
            if [
                "none",
                "off",
                "low",
                "minimal",
                "medium",
                "high",
                "xhigh",
                "max",
                "ultra",
                "ultracode",
            ]
            .contains(&s.as_str())
            {
                return json!(s);
            }
        }
    }
    json!("medium")
}

fn selection(record: &Value) -> Result<Value, String> {
    if !truthy(&record["providerSelection"]) {
        return Ok(Value::Null);
    }
    let facts = SELECTION_FACTS;
    let req = json!({"input":record["providerSelection"],"facts":serde_json::from_str::<Value>(facts).map_err(|e|e.to_string())?});
    serde_json::from_str(&multicc_core::auto_provider_config::provider_selection_dto(
        &req.to_string(),
    )?)
    .map_err(|e| e.to_string())
}

fn provider_models(row: &Value) -> Value {
    let config = &row["settingsConfig"];
    let parsed;
    let cfg = if let Some(raw) = config.as_str() {
        parsed = serde_json::from_str::<Value>(raw).unwrap_or_default();
        &parsed
    } else {
        config
    };
    let mut aliases = json!({});
    let mut options = vec![];
    let (model, alias_only) = if row["appType"] == "claude" {
        let mut env = cfg["env"].as_object().cloned().unwrap_or_default();
        multicc_core::provider_settings_config::ensure_zhipu_fable_alias(&mut env);
        for tier in ["opus", "sonnet", "haiku", "fable"] {
            if let Some(m) = env
                .get(&format!(
                    "ANTHROPIC_DEFAULT_{}_MODEL",
                    tier.to_ascii_uppercase()
                ))
                .and_then(Value::as_str)
            {
                aliases[tier] = json!({"model":m});
                options.push(m.to_owned());
            }
        }
        let model = env
            .get("ANTHROPIC_MODEL")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let alias_only = model.is_empty() && env.get("ANTHROPIC_BASE_URL").is_some_and(truthy);
        (model, alias_only)
    } else {
        let model = cfg["config"]
            .as_str()
            .unwrap_or("")
            .lines()
            .filter_map(|l| l.split_once('='))
            .find(|(k, _)| k.trim() == "model")
            .map(|(_, v)| v.trim().trim_matches(['"', '\'']))
            .unwrap_or("");
        (model.to_owned(), false)
    };
    options.insert(0, model.clone());
    options.extend(
        cfg["modelCatalog"]["models"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|m| m["model"].as_str().map(str::to_owned)),
    );
    json!({"id":row["id"],"model":model,"modelOptions":multicc_core::provider_registry::unique_models(&options),"aliasMap":aliases,"aliasOnly":alias_only,"isOfficial":row["isOfficial"]})
}
fn model(
    record: &Value,
    cli: &str,
    provider: &Value,
    history: &[model_default::History],
    models: &[String],
) -> Value {
    if let Some(name) = record["model"].as_str().filter(|v| !v.is_empty()) {
        return json!(provider["aliasMap"][name]["model"].as_str().unwrap_or(name));
    }
    let app_type = match cli {
        "claude" | "claude-exp" => Some("claude"),
        "codex" | "codex-exp" => Some("codex"),
        _ => None,
    };
    let id = record["provider"].as_str();
    let official = id.is_some_and(|id| app_type.is_some_and(|a| id == format!("{a}-official")))
        || provider["isOfficial"] == true;
    let info = model_default::ProviderInfo {
        model: provider["model"].as_str().map(String::from),
        options: provider["modelOptions"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|s| s.as_str().map(String::from))
            .collect(),
        official,
        alias_only: provider["aliasOnly"] == true,
    };
    json!(model_default::resolve(
        &model_default::Request {
            cli: cli.into(),
            app_type: app_type.map(String::from),
            provider_id: id.map(String::from),
            history_provider_id: if official { None } else { id.map(String::from) },
            provider: if official || !provider.is_null() {
                Some(info)
            } else {
                None
            },
            wire_default_model: Some(
                std::env::var("CLAUDE_WIRE_DEFAULT_MODEL")
                    .ok()
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| "claude-sonnet-4-5".into())
            ),
            reported_model: record["reportedModel"].as_str().map(String::from),
            global_provider_cli: matches!(cli, "opencode" | "zcode" | "kimi"),
            models: models.to_vec(),
            ..Default::default()
        },
        history
    ))
}

pub(crate) fn normalize_provider(record: &mut Value) {
    if !truthy(&record["loginFlow"])
        && (!truthy(&record["provider"]) || record["provider"] == "_default_")
    {
        if let Some(cli @ ("claude" | "codex")) = record["cli"].as_str() {
            record["provider"] = json!(format!("{cli}-official"));
        }
    }
}

pub(crate) async fn list(app: &Arc<App>) -> Result<Value, String> {
    let app = app.clone();
    let host = app.native_chat.clone();
    let active = host.activity().await;
    tokio::task::spawn_blocking(move || snapshot(&app, &host, active))
        .await
        .map_err(|e| e.to_string())?
}

fn snapshot(
    app: &App,
    host: &Host,
    active: HashMap<String, (bool, Option<u64>)>,
) -> Result<Value, String> {
    let dirs = crate::app::directory_list::records(&app.data_root.join("directories.json"))?;
    let mut all = serde_json::Map::new();
    for mut row in crate::app::directory_list::records(&app.data_root.join("sessions.json"))? {
        normalize_provider(&mut row);
        if let Some(id) = row["id"].as_str().filter(|s| !s.is_empty()) {
            all.insert(id.into(), row);
        }
    }
    let targets = multicc_core::task_store::TaskStore::session_list_targets(
        &app.data_root.join("task-shells.sqlite"),
        &all,
        |r| crate::app::session_admin::context_visible(r, false, false),
    )?;
    let providers = provider_store::read(&app.data_root.join("providers.json"))
        .ok()
        .flatten()
        .unwrap_or_default();
    let summaries: Vec<_> = providers
        .as_array()
        .or_else(|| providers["providers"].as_array())
        .into_iter()
        .flatten()
        .map(provider_models)
        .collect();
    let lookup = |id: &str| {
        summaries
            .iter()
            .find(|v| v["id"] == id)
            .unwrap_or(&Value::Null)
    };
    let history = all
        .values()
        .filter_map(|r| {
            Some(model_default::History {
                cli: r["cli"].as_str().unwrap_or("claude").into(),
                provider: r["provider"]
                    .as_str()
                    .filter(|p| !p.ends_with("-official"))
                    .map(String::from),
                model: r["model"].as_str()?.into(),
            })
        })
        .collect::<Vec<_>>();
    let mut out = Vec::new();
    if let Some(r) = all.get("__aux__") {
        let status = app
            .aux_jobs
            .get()
            .ok_or("Aux runtime unavailable")?
            .status()?;
        out.push(aux(
            r,
            app.aux_jobs.get().map_or(0, |rt| rt.clients()),
            status,
        ));
    }
    let providerless = cli_switch::SUPPORTED_CHAT_CLIS
        .iter()
        .filter(|s| cli_capability::is_providerless(s))
        .collect::<Vec<_>>();
    let claude_cache = json_file(&app.data_root.join("claude-models-cache.json"));
    let mut claude_models: Vec<_> = claude_cache["models"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| m["model"].as_str().map(String::from))
        .collect();
    if claude_models.is_empty() {
        claude_models = multicc_core::claude_models::fallback_ids()
            .into_iter()
            .map(String::from)
            .collect();
    }
    let codex_cache = json_file(&app.home_dir.join(".codex/models_cache.json"));
    let mut visible: Vec<_> = codex_cache["models"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| m["visibility"] == "list" && m["slug"].is_string())
        .collect();
    visible.sort_by(|a, b| {
        a["priority"]
            .as_f64()
            .unwrap_or(99.)
            .total_cmp(&b["priority"].as_f64().unwrap_or(99.))
    });
    let codex_models: Vec<_> = visible
        .iter()
        .filter_map(|m| m["slug"].as_str().map(str::to_owned))
        .collect();
    let born = auth_runtime::now_ms() as i64 - app.started.elapsed().as_millis() as i64;
    for (id, r) in all {
        if !crate::app::session_admin::context_visible(&r, false, false) || id == "__aux__" {
            continue;
        }
        let cli = r["cli"].as_str().unwrap_or("claude").to_owned();
        let is_chat = r["kind"] == "chat";
        let provider = lookup(r["provider"].as_str().unwrap_or(""));
        let mut states = r["cliStates"]
            .as_object()
            .cloned()
            .map(Value::Object)
            .unwrap_or_else(|| json!({}));
        if is_chat && states[&cli].is_null() {
            states[&cli] = cli_switch::active_state(
                &r,
                &json!(born),
                cli_capability::is_providerless(&cli),
                &[],
            )?;
        }
        let facts = json!({"providerSelection":selection(&r)?,"cliStates":cli_switch::state_summary(&json!({"cliStates":states,"providerlessClis":providerless}))?,
                "pendingCliHandoff":cli_switch_runtime::plan("handoffSummary",&json!({"handoff":r["pendingCliHandoff"]}))?});
        let cwd = store::resolve_cwd(
            &js::from_serde(&r),
            &app.data_root,
            &app.home_dir,
            &app.package_root,
            &id,
        )?;
        let target = targets.get(&id).unwrap_or(&id);
        let (busy, timestamp) = active.get(target).copied().unwrap_or_default();
        let mut latest = timestamp.unwrap_or_default() as f64;
        if is_chat {
            let path =
                chat_history_file::transcript_path(&app.data_root.join("chat_history"), target);
            latest = latest.max(host.activity_cache.last_assistant(&path));
        }
        let mut sub = r["subagent"].clone();
        if let Some(m) = sub["model"].as_str() {
            sub["effectiveModel"] = json!(lookup(sub["providerId"].as_str().unwrap_or(""))
                ["aliasMap"][m]["model"]
                .as_str()
                .unwrap_or(m));
        }
        let clients = host.hub.client_count(target);
        let models = match cli.as_str() {
            "claude" | "claude-exp" => claude_models.as_slice(),
            "codex" | "codex-exp" => codex_models.as_slice(),
            _ => &[],
        };
        let effective = model(&r, &cli, provider, &history, models);
        let runtime = json!({"sessionCwd":cwd,"terminalActive":false,"terminalClients":0,"terminalLastActivity":null,
                "chatActive":clients>0 || busy,"chatClients":clients,
                "chatLastActivity":if latest>0.{js::json::date_to_iso_string(latest)}else{None},
                "mergeState":if truthy(&r["dirId"]){Some(app.session_merge.get(&r,dirs.iter().find(|d|d["id"]==r["dirId"]).unwrap_or(&Value::Null)))}else{None},
                "effectiveModel":effective,
                "effectiveEffort":effort(&r,&cli,&app.home_dir,&effective),"subagent":session_admin::subagent_dto(Some(&sub))});
        out.push(session_admin::legacy_session_list(&r, &runtime, &facts));
    }
    Ok(Value::Array(out))
}

impl HistoryTimes {
    fn last_assistant(&self, path: &Path) -> f64 {
        let Ok(meta) = path.metadata() else { return 0. };
        let Ok(stamp) = meta.modified() else {
            return 0.;
        };
        if let Some((mtime, len, at)) = self.0.lock().unwrap().get(path) {
            if *mtime == stamp && *len == meta.len() {
                return *at;
            }
        }
        let mut at = 0.;
        let result = chat_history_file::visit_transcript(path, |row| {
            if store::text(&row, "role") == "assistant" {
                if let Some(v) = row.get("ts") {
                    let n = js::js_to_number(v);
                    if n.is_finite() && n > 0. {
                        at = n;
                    }
                }
            }
        });
        if result.is_err() {
            return 0.;
        }
        let mut cache = self.0.lock().unwrap();
        if cache.len() >= 4096 {
            cache.clear();
        }
        cache.insert(path.to_owned(), (stamp, meta.len(), at));
        at
    }
}

impl Host {
    async fn activity(&self) -> HashMap<String, (bool, Option<u64>)> {
        let cells: Vec<_> = self
            .sessions
            .lock()
            .await
            .iter()
            .filter_map(|(id, c)| Some((id.clone(), c.get()?.clone())))
            .collect();
        let mut result = HashMap::new();
        for (id, c) in cells {
            let s = c.lock().await;
            result.insert(id, (s.active.is_some(), s.last_activity));
        }
        result
    }
}

// Provider selection validation uses the same public routing catalog as the compatibility host.
const SELECTION_FACTS: &str = r#"{
  "gateways": [
    {
      "name": "vercel",
      "endpoint": "https://ai-gateway.vercel.sh/v1/evaluate",
      "model": "typesafe-ai/jev",
      "apiKeyName": "VERCEL_API_KEY"
    },
    {
      "name": "openrouter",
      "endpoint": "https://openrouter.ai/api/alpha/decisions",
      "model": "~typesafe/jev-latest",
      "apiKeyName": "OPENROUTER_API_KEY"
    },
    {
      "name": "typesafe",
      "endpoint": "https://api.typesafe.ai/v1/systemone",
      "model": "jev-latest",
      "apiKeyName": "TYPESAFE_API_KEY"
    }
  ],
  "defaultGateway": "vercel",
  "customGateway": "custom",
  "customApiKeyName": "JEV_CUSTOM_API_KEY",
  "customModel": "jev-latest",
  "maxEndpointChars": 300,
  "nativeOpenCodePrefix": "opencode-native:",
  "nativeOpenCodeIdPattern": "^[a-z0-9][a-z0-9._-]{0,63}$",
  "nativeOpenCodeIdIgnoreCase": true,
  "nativeVendorSuffix": "-native:",
  "vendorNativeClis": [
    "qoder",
    "codebuddy",
    "gemini",
    "pi",
    "commandcode",
    "dsh",
    "grok"
  ],
  "nativeVendorIdPattern": "^[a-z0-9][a-z0-9._-]{0,63}$",
  "nativeVendorIdIgnoreCase": true,
  "nativeVendorModelPattern": "^[A-Za-z0-9][A-Za-z0-9._:\\/-]{0,118}[A-Za-z0-9._/-]$",
  "nativeVendorModelIgnoreCase": false
}"#;
