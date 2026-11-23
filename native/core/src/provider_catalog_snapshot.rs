//! Public display and Aux capability projections of the same provider records.
//! Credentials are inspected locally. Only the masked display value leaves this module.
use crate::{
    codex_models, js::serde::truthy, provider_catalog, provider_registry,
    provider_settings_config as settings, provider_writes,
};
use serde_json::{json, Value};
use std::path::Path;

pub struct Catalog {
    pub providers: Vec<Value>,
    pub aux: Value,
}

fn string(v: &Value) -> &str {
    v.as_str().unwrap_or_default()
}
fn models(catalog: &Value) -> Vec<Value> {
    catalog["models"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| m.get("model").filter(|v| truthy(v)).cloned())
        .collect()
}
fn masked(token: &str) -> String {
    let u = token.encode_utf16().collect::<Vec<_>>();
    if u.is_empty() {
        String::new()
    } else if u.len() <= 10 {
        "***".into()
    } else {
        format!(
            "{}…{}",
            String::from_utf16_lossy(&u[..6]),
            String::from_utf16_lossy(&u[u.len() - 4..])
        )
    }
}
fn official_models(home: &Path, account: &Value) -> Vec<Value> {
    let dir = match account.as_str() {
        Some(id)
            if id.len() == 16
                && id
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) =>
        {
            home.join(".multicc/official-accounts/codex").join(id)
        }
        Some(_) => return vec![],
        None => home.join(".codex"),
    };
    codex_models::load(&dir.to_string_lossy())
        .ok()
        .and_then(|v| serde_json::from_str(&v).ok())
        .map(|v| models(&v))
        .unwrap_or_default()
}

fn project(p: &Value, home: &Path) -> Result<(Value, Option<Value>), &'static str> {
    let cfg = provider_catalog::config_of(p).map_err(|_| "invalid provider settings")?;
    let kind = string(&p["appType"]);
    let claude = kind == "claude";
    let fmt = settings::normalize_api_format(p.get("apiFormat"), Some(kind));
    let env = &cfg["env"];
    let toml = |key| provider_writes::toml_value(cfg.get("config"), key);
    let raw_base = toml("base_url");
    let base = if claude {
        string(&env["ANTHROPIC_BASE_URL"])
    } else {
        cfg["proxyTarget"]["originalBaseUrl"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or(&raw_base)
    };
    let model = if claude {
        string(&env["ANTHROPIC_MODEL"]).into()
    } else {
        toml("model")
    };
    let auth = &cfg["auth"];
    let token = if claude {
        env["ANTHROPIC_AUTH_TOKEN"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or(string(&env["ANTHROPIC_API_KEY"]))
    } else {
        auth["OPENAI_API_KEY"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or(string(&auth["tokens"]["access_token"]))
    };
    let extras = models(&cfg["modelCatalog"]);
    let mut options = vec![json!(model)];
    let mut aliases = json!({});
    if claude {
        for &(tier, key) in settings::ALIAS_TIER_KEYS {
            if truthy(&env[key]) {
                options.push(env[key].clone());
                aliases[tier] =
                    json!({"model":env[key],"name":string(&env[format!("{key}_NAME")])});
            }
        }
    }
    options.extend_from_slice(&extras);
    if claude
        && aliases.get("fable").is_none()
        && settings::is_zhipu_base_url(env.get("ANTHROPIC_BASE_URL"))
    {
        aliases["fable"] = settings::zhipu_fable_alias();
        options.push(aliases["fable"]["model"].clone());
    }
    let official = if claude {
        base.is_empty()
    } else {
        provider_catalog::official_codex(p)
    };
    let account = cfg["officialAccount"]["id"].as_str();
    let options = if !claude && base.is_empty() {
        if official {
            official_models(home, &json!(account))
        } else {
            vec![]
        }
    } else {
        settings::unique_models(&options)
            .into_iter()
            .map(Value::String)
            .collect()
    };
    let binding = &p["egressBinding"];
    let mut public = json!({
        "id":p["id"],"appType":kind,"apiFormat":fmt,"protocol":fmt,"wireApi":if claude {"messages"} else {"responses"},
        "compatibleClis":provider_registry::compatible_clis(fmt,!base.is_empty() && !token.is_empty()),
        "name":p["name"],"builtinOfficial":p["builtinOfficial"]==true,"activeAccountId":p["activeAccountId"],
        "needsLogin":p["needsLogin"]==true,"accountEmail":p["accountEmail"],"subscription":p["subscription"],
        "isDefaultOfficial":p["isDefaultOfficial"]==true,"quotaKind":p["quotaKind"],
        "egressIpAllowlist":provider_writes::normalize_egress_ip_allowlist(p.get("egressIpAllowlist")),
        "egressBinding":binding["pluginId"].as_str().zip(binding["profileId"].as_str()).map(|(plugin,profile)|json!({"pluginId":plugin,"profileId":profile})),
        "source":p["source"].as_str().filter(|s|!s.is_empty()).unwrap_or("local"),"baseUrl":base,"model":model,
        "modelOptions":options,"aliasOnly":claude && !base.is_empty() && model.is_empty(),"aliasMap":aliases,
        "tokenMask":masked(token),"hasToken":!token.is_empty(),"isOfficial":official,"officialAccountId":account
    });
    if truthy(&p["virtual"]) {
        public["virtual"] = p["virtual"].clone();
        public["isOfficial"] = false.into();
        public["hasToken"] = false.into();
        public["tokenMask"] = "".into();
        public["baseUrl"] = "".into();
        public["compatibleClis"] = json!([kind, format!("{kind}-exp")]);
    }
    let target = if claude
        && ((!base.is_empty() && !token.is_empty())
            || p["id"] == "claude-official"
            || account.is_some())
    {
        Some((
            "messages",
            if options.is_empty() {
                json!(["haiku", "sonnet", "opus", "fable"])
            } else {
                json!(options)
            },
        ))
    } else if !claude && official {
        Some(("responses", json!(options)))
    } else if kind == "codex"
        && !string(&auth["OPENAI_API_KEY"]).is_empty()
        && !raw_base.is_empty()
        && !raw_base.contains("localhost")
        && !raw_base.contains("127.0.0.1")
    {
        let available_models = if cfg["modelCatalog"]["models"].is_array() {
            extras
        } else if !model.is_empty() {
            vec![model.into()]
        } else {
            vec![]
        };
        Some((
            if toml("wire_api") == "chat_completions" {
                "chat_completions"
            } else {
                "responses"
            },
            json!(available_models),
        ))
    } else {
        None
    };
    let aux = target.map(|(wire, options)| {
        json!({"id":p["id"],"name":p["name"],"modelOptions":options,
        "wireApi":wire,"available":true,"unavailableReason":null,"limit":null})
    });
    Ok((public, aux))
}

pub fn read(root: &Path, home: &Path) -> Result<Catalog, &'static str> {
    let mut providers = Vec::new();
    let mut aux = json!({"anthropic":[],"openai":[]});
    let rows =
        provider_catalog::list(root, home, "").map_err(|_| "provider catalog unavailable")?;
    for p in rows {
        let (summary, target) = project(&p, home)?;
        providers.push(summary);
        if let Some(target) = target {
            let protocol = if p["appType"] == "codex" {
                "openai"
            } else {
                "anthropic"
            };
            aux[protocol]
                .as_array_mut()
                .expect("protocol array")
                .push(target);
        }
    }
    Ok(Catalog { providers, aux })
}

/// Private input to the Aux transport. Callers must never serialize this as a catalog row.
pub struct AuxProvider {
    pub record: Value,
    pub config: Value,
    pub wire: String,
    pub model: String,
    pub base: String,
    pub official: bool,
}
pub fn aux_provider(
    root: &Path,
    home: &Path,
    protocol: &str,
    id: &str,
) -> Result<AuxProvider, String> {
    let kind = if protocol == "openai" {
        "codex"
    } else {
        "claude"
    };
    let rows =
        provider_catalog::list(root, home, kind).map_err(|_| "provider catalog unavailable")?;
    let p = rows
        .into_iter()
        .find(|p| p["id"] == id)
        .ok_or("provider not found")?;
    let cfg = provider_catalog::config_of(&p).map_err(|_| "provider settings unavailable")?;
    let (summary, target) = project(&p, home)?;
    let base = provider_writes::toml_value(cfg.get("config"), "base_url");
    let dto = target.ok_or_else(|| {
        if kind == "claude" {
            "provider has no HTTP credentials"
        } else if string(&cfg["auth"]["OPENAI_API_KEY"]).is_empty() {
            "OAuth provider has no API key"
        } else if base.is_empty() {
            "provider has no base_url"
        } else {
            "local proxy has no direct target"
        }
    })?;
    let model = summary["model"]
        .as_str()
        .filter(|s| !s.is_empty())
        .or_else(|| dto["modelOptions"][0].as_str())
        .unwrap_or_default()
        .to_owned();
    Ok(AuxProvider {
        record: p,
        config: cfg,
        wire: string(&dto["wireApi"]).into(),
        model,
        base,
        official: summary["isOfficial"] == true,
    })
}
