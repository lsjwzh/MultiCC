// 冻结基准：合并提交 799aa9de 的默认模型规则，仅供差分测试。
//! Default model selection for a CLI lane — one implementation, here.
//!
//! MultiCC must never take a session's default model from the terminal's own
//! configuration (`~/.claude/settings.json` `model` / `env`, `~/.codex/config.toml`
//! `model`). Those files belong to the user's terminal and are routinely
//! rewritten by ccswitch-style tools; a terminal switched to deepseek used to
//! redirect a MultiCC session on the official account and fail with
//! "There's an issue with the selected model (deepseek-flash)".
//!
//! The rule implemented here only ever chooses from the lane's own model list
//! (the same list the picker shows):
//!
//! 1. provider routes keep a pinned model (`provider.model`) exactly as before;
//! 2. otherwise the model the user selected most often on this lane wins —
//!    explicit `session.model` values from persisted session records;
//! 3. ties resolve to the earlier entry of the model list;
//! 4. no usable history resolves to the first model-list entry;
//! 5. history entries whose model is not in the current list (stale ids after
//!    a catalog change) are ignored;
//! 6. an empty list falls back to the last model the CLI actually reported for
//!    this session — still not a terminal default.
//!
//! The host owns all I/O: it resolves the provider summary, the model list and
//! the session records, and passes them as data. This module is pure and takes
//! one JSON string in, one JSON string out (parsed leniently through
//! [`crate::json_lenient`]).

use serde_json::{json, Value};

const INVALID: &str = "MODEL_DEFAULT_INVALID";

#[derive(Debug, Default)]
struct ProviderInfo {
    model: Option<String>,
    options: Vec<String>,
    alias_only: bool,
    official: bool,
}

#[derive(Debug)]
struct History {
    cli: String,
    provider: Option<String>,
    model: String,
}

fn text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

fn model_list(value: Option<&Value>) -> Vec<String> {
    let mut models: Vec<String> = Vec::new();
    for entry in value.and_then(Value::as_array).into_iter().flatten() {
        let Some(model) = text(Some(entry)) else {
            continue;
        };
        if !models.contains(&model) {
            models.push(model);
        }
    }
    models
}

// `claude-exp` is the same Claude lane as `claude`; the usage the user built up
// on either adapter belongs to one list. Same for codex/codex-exp.
fn normalize_cli(cli: &str) -> String {
    let cli = cli.trim().to_ascii_lowercase();
    cli.strip_suffix("-exp").unwrap_or(&cli).to_owned()
}

fn normalize_provider(provider: Option<&str>) -> String {
    provider
        .map(str::trim)
        .filter(|id| !id.is_empty() && *id != "_default_")
        .unwrap_or("")
        .to_owned()
}

fn provider_info(value: Option<&Value>) -> Option<ProviderInfo> {
    let object = value?.as_object()?;
    Some(ProviderInfo {
        model: text(object.get("model")),
        options: model_list(object.get("modelOptions")),
        alias_only: object
            .get("aliasOnly")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        official: object
            .get("official")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

// Which provider scope the explicit-selection history is counted in. The host
// sends `historyProviderId` explicitly: `null` means "the shared/official line"
// (an empty provider key), an id means that provider route. Only an absent
// field falls back to the request's own provider id (older callers/tests).
fn history_provider_scope(
    object: &serde_json::Map<String, Value>,
    provider_id: Option<&str>,
) -> Option<String> {
    match object.get("historyProviderId") {
        None => provider_id.map(str::to_owned),
        Some(value) => text(Some(value)),
    }
}

fn history(value: Option<&Value>) -> Vec<History> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let object = entry.as_object()?;
            let cli = text(object.get("cli"))?;
            let model = text(object.get("model"))?;
            Some(History {
                cli,
                provider: text(object.get("provider")),
                model,
            })
        })
        .collect()
}

// Frequency first, list order on ties, first entry when the lane has no usable
// history. Models that are no longer in the list never win, however often they
// were picked before a catalog change.
fn pick(
    models: &[String],
    history: &[History],
    cli: &str,
    provider: Option<&str>,
) -> Option<String> {
    let mut counts = vec![0usize; models.len()];
    let lane_cli = normalize_cli(cli);
    let lane_provider = normalize_provider(provider);
    for entry in history {
        if normalize_cli(&entry.cli) != lane_cli
            || normalize_provider(entry.provider.as_deref()) != lane_provider
        {
            continue;
        }
        if let Some(index) = models.iter().position(|model| model == &entry.model) {
            counts[index] += 1;
        }
    }
    let mut best = 0usize;
    for index in 1..models.len() {
        if counts[index] > counts[best] {
            best = index;
        }
    }
    models.get(best).cloned()
}

fn resolve_effective(input: &Value) -> Result<Option<String>, String> {
    let object = input
        .as_object()
        .ok_or_else(|| format!("{INVALID}: request must be an object"))?;
    let cli = text(object.get("cli")).unwrap_or_default();
    let app_type = text(object.get("appType"));
    let provider_id = text(object.get("providerId"));
    let provider = provider_info(object.get("provider"));
    let models = model_list(object.get("models"));
    let reported = text(object.get("reportedModel"));
    let history = history(object.get("history"));
    let global_provider_cli = object
        .get("globalProviderCli")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    // Official provider entries (including the per-account ids) share the
    // official picker line with provider-less sessions, so their history is
    // keyed by an empty provider id on both sides.
    let history_provider = history_provider_scope(object, provider_id.as_deref());

    if provider_id.is_some() {
        let key = history_provider.as_deref();
        if let Some(info) = provider {
            // Provider-pinned models are configuration, not a terminal default:
            // keep them exactly as before.
            if let Some(model) = info.model {
                return Ok(Some(model));
            }
            if !info.options.is_empty() {
                if let Some(model) = pick(&info.options, &history, &cli, key) {
                    return Ok(Some(model));
                }
            }
            // The official line has no provider-owned catalog of its own; its
            // list is the same official CLI catalog the picker shows.
            if info.official {
                if let Some(model) = pick(&models, &history, &cli, key) {
                    return Ok(Some(model));
                }
                // Managed Codex routes own their default; a reported model may
                // still belong to the provider we just left and must not come
                // back just because the catalog is momentarily empty.
                if app_type.as_deref() == Some("codex") {
                    return Ok(None);
                }
                return Ok(reported);
            }
            // Managed Codex routes own their default; a stale reported model
            // may still belong to the provider we just left and must not come
            // back just because the catalog is momentarily empty.
            if app_type.as_deref() == Some("codex") {
                return Ok(None);
            }
            return Ok(reported);
        }
        // The provider id is stale (deleted/renamed). Do not invent a route
        // model; the last reported model is the only lane-local fact left.
        return Ok(reported);
    }

    if global_provider_cli {
        return Ok(reported);
    }

    match app_type.as_deref() {
        Some("claude") | Some("codex") => Ok(pick(&models, &history, &cli, None).or(reported)),
        _ => Ok(reported),
    }
}

fn resolve_provider_default(input: &Value) -> Result<Option<String>, String> {
    let object = input
        .as_object()
        .ok_or_else(|| format!("{INVALID}: request must be an object"))?;
    let cli = text(object.get("cli")).unwrap_or_default();
    let app_type = text(object.get("appType"));
    let provider_id = text(object.get("providerId"));
    let models = model_list(object.get("models"));
    let history = history(object.get("history"));
    let wire_default = text(object.get("wireDefaultModel"));
    let history_provider = history_provider_scope(object, provider_id.as_deref());

    if provider_id.is_none() {
        // Only the official Claude line has a picker list without a provider.
        // Codex profiles keep the historical "no default" answer.
        if app_type.as_deref() == Some("claude") {
            return Ok(pick(&models, &history, &cli, None));
        }
        return Ok(None);
    }

    let Some(info) = provider_info(object.get("provider")) else {
        return Ok(None);
    };
    if info.alias_only {
        return Ok(wire_default);
    }
    if let Some(model) = info.model {
        return Ok(Some(model));
    }
    let key = history_provider.as_deref();
    if !info.options.is_empty() {
        return Ok(pick(&info.options, &history, &cli, key));
    }
    if info.official {
        return Ok(pick(&models, &history, &cli, key));
    }
    Ok(None)
}

/// Resolve the default model for one lane. Returns a JSON object
/// `{"model": string|null}`; `null` means the lane has no list and the session
/// never reported a model, so the caller must not invent one.
pub fn resolve(input: &str) -> Result<String, String> {
    let request: Value =
        crate::json_lenient::from_str(input).map_err(|error| format!("{INVALID}: {error}"))?;
    let object = request
        .as_object()
        .ok_or_else(|| format!("{INVALID}: request must be an object"))?;
    let kind = text(object.get("kind")).unwrap_or_else(|| "effective".to_owned());
    let model = match kind.as_str() {
        "effective" => resolve_effective(&request)?,
        "providerDefault" => resolve_provider_default(&request)?,
        other => return Err(format!("{INVALID}: unknown kind {other}")),
    };
    Ok(json!({ "model": model }).to_string())
}
