//! Materialize each vendor's chosen provider in its own session home.
use super::{config, nonempty, strval, tier_model};
use crate::{js::serde::truthy, provider_settings_config as settings, state_file};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::OnceLock,
};
fn slug(raw: &str) -> String {
    static BAD: OnceLock<regex::Regex> = OnceLock::new();
    BAD.get_or_init(|| regex::Regex::new("[^a-z0-9._-]+").expect("slug"))
        .replace_all(&raw.to_lowercase(), "-")
        .into_owned()
}
pub fn home(root: &Path, lane: &str, raw: &str) -> Result<PathBuf, String> {
    let label = match lane {
        "zcode" => "ZCode",
        "kimi" => "Kimi",
        "grok" => "Grok",
        _ => return Err("unknown provider home".into()),
    };
    if raw.is_empty() {
        return Err(format!(
            "{label} provider routing requires a stable session id"
        ));
    }
    let part = slug(raw);
    let part = part.trim_matches('-');
    let part = nonempty(&part[..72.min(part.len())], "session");
    let digest = format!("{:x}", Sha256::digest(raw.as_bytes()));
    Ok(root.join(format!("{part}-{}", &digest[..12])))
}
pub(super) fn private_dir(path: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}
fn write_json(path: &Path, data: &Value) -> io::Result<()> {
    state_file::write_json_atomic(path, data)
}
fn sdk_base(s: &str) -> String {
    let s = s.trim_end_matches('/');
    if s.is_empty() || s.to_ascii_lowercase().ends_with("/v1") {
        s.into()
    } else {
        format!("{s}/v1")
    }
}
fn optional(o: &mut Value, key: &str, v: &str) {
    if !v.is_empty() {
        o[key] = v.into()
    }
}
fn nullable(s: &str) -> Value {
    if s.is_empty() {
        Value::Null
    } else {
        s.into()
    }
}
pub fn build(
    lane: &str,
    row: &Value,
    summary: &Value,
    session: &Value,
    root: &Path,
    mut limit: impl FnMut(&str) -> Result<Value, String>,
) -> Result<Value, String> {
    let cfg = config(row);
    let anthropic = summary["apiFormat"] == "anthropic";
    let env = &cfg["env"];
    let stored_base = strval(&summary["baseUrl"]);
    let base = if anthropic || lane == "dsh" {
        nonempty(strval(&env["ANTHROPIC_BASE_URL"]), stored_base)
    } else {
        nonempty(strval(&cfg["proxyTarget"]["originalBaseUrl"]), stored_base)
    };
    let key = if anthropic || lane == "dsh" {
        nonempty(
            strval(&env["ANTHROPIC_AUTH_TOKEN"]),
            strval(&env["ANTHROPIC_API_KEY"]),
        )
    } else {
        nonempty(
            strval(&cfg["proxyTarget"]["apiKey"]),
            strval(&cfg["auth"]["OPENAI_API_KEY"]),
        )
    };
    let id = slug(&format!(
        "multicc-{}",
        nonempty(strval(&row["id"]), "provider")
    ));
    let id = &id[..96.min(id.len())];
    let primary = strval(&summary["model"]);
    let requested = strval(&session["model"]).trim();
    let wanted = if lane == "zcode" {
        let s = nonempty(requested, primary);
        s.strip_prefix(&format!("{id}/")).unwrap_or(s)
    } else {
        requested
    };
    let selected = tier_model(summary, wanted);
    let mut options = vec![json!(selected), json!(primary)];
    if let Some(m) = summary["modelOptions"].as_array() {
        options.extend_from_slice(m);
    }
    let models = settings::unique_models(&options);
    let selected = nonempty(&selected, models.first().map(String::as_str).unwrap_or(""));
    let mut result = json!({"env":{},"qualifiedModel":nullable(selected),"providerModel":nullable(primary),"providerModels":models,"providerName":row["name"]});
    let raw = nonempty(strval(&session["id"]), strval(&session["sessionId"]));
    let home_path = || home(root, lane, raw);
    let io_error = |err: io::Error| err.to_string();
    match lane {
        "kimi" => {
            if key.is_empty() {
                return Err("Kimi Provider 缺少可用的 API Key".into());
            }
            let h = home_path()?;
            private_dir(&h).map_err(io_error)?;
            result["env"] = json!({"KIMI_CODE_HOME":h,"KIMI_API_KEY":key});
            optional(&mut result["env"], "KIMI_BASE_URL", base);
            result["kimiHome"] = json!(h);
        }
        "dsh" => {
            if key.is_empty() {
                return Err("DSH Provider 缺少可用的 API Key".into());
            }
            if base.is_empty() {
                return Err("DSH Provider 缺少可用的 Base URL".into());
            }
            result["env"] = json!({"DEEPSEEK_BASE_URL":base,"DEEPSEEK_API_KEY":key});
        }
        "grok" => {
            if key.is_empty() {
                return Err("Grok Provider 缺少可用的 API Key".into());
            }
            if base.is_empty() {
                return Err("Grok Provider 缺少可用的 Base URL".into());
            }
            if selected.is_empty() {
                return Err("Grok Provider 没有可用模型".into());
            }
            let h = home_path()?;
            private_dir(&h).map_err(io_error)?;
            state_file::write_text_atomic(
                &h.join("config.toml"),
                &settings::grok_model_config(
                    selected,
                    base,
                    if anthropic { "messages" } else { "responses" },
                ),
                0o600,
                0o700,
            )
            .map_err(io_error)?;
            result["env"] = json!({"GROK_HOME":h,"MULTICC_GROK_API_KEY":key});
            result["grokHome"] = json!(h);
        }
        "opencode" => {
            let namespace = if stored_base.is_empty() {
                if anthropic {
                    "anthropic"
                } else {
                    "openai"
                }
            } else {
                id
            };
            result["qualifiedModel"] = if selected.is_empty() {
                Value::Null
            } else {
                json!(format!("{namespace}/{selected}"))
            };
            if !stored_base.is_empty() {
                let mut options =
                    json!({"baseURL":if anthropic{sdk_base(base)}else{stored_base.into()}});
                if anthropic && truthy(&env["ANTHROPIC_AUTH_TOKEN"]) {
                    options["authToken"] = env["ANTHROPIC_AUTH_TOKEN"].clone();
                } else {
                    optional(
                        &mut options,
                        "apiKey",
                        if anthropic {
                            key
                        } else {
                            strval(&cfg["auth"]["OPENAI_API_KEY"])
                        },
                    );
                }
                let mut defs = json!({});
                for model in &models {
                    defs[model] = json!({"name":model,"limit":limit(model)?});
                }
                let setup = json!({"enabled_providers":[id],"provider":{(id):{"npm":if anthropic{"@ai-sdk/anthropic"}else{"@ai-sdk/openai"},"name":row["name"],"options":options,"models":defs}}});
                result["env"] = json!({"OPENCODE_CONFIG_CONTENT":setup.to_string()});
            }
        }
        "zcode" => {
            let h = home_path()?;
            let dot = h.join(".zcode");
            let cli = dot.join("cli");
            let v2 = dot.join("v2");
            for d in [&h, &dot, &cli] {
                private_dir(d).map_err(io_error)?;
            }
            let file = cli.join("config.json");
            let base = if anthropic {
                sdk_base(base)
            } else {
                base.into()
            };
            let mut opts = json!({});
            optional(&mut opts, "baseURL", &base);
            optional(&mut opts, "apiKey", key);
            let mut defs = json!({});
            for model in &models {
                defs[model] = json!({"id":model});
            }
            let mut legacy = json!({"provider":{(id):{"kind":if anthropic{"anthropic"}else{"openai"},"options":opts,"models":defs}}});
            if !selected.is_empty() {
                legacy["model"] = json!(format!("{id}/{selected}"));
            }
            write_json(&file, &legacy).map_err(io_error)?;
            private_dir(&v2).map_err(io_error)?;
            let mut rule = json!({"providerId":id,"enabled":true,"config":{"group":"standard-personal","access":{"type":"api-key"},"api":{"type":if anthropic{"anthropic-messages"}else{"openai-responses"}}}});
            optional(&mut rule, "providerName", strval(&row["name"]));
            optional(&mut rule["config"]["access"], "apiKey", key);
            optional(&mut rule["config"]["api"], "baseUrl", &base);
            if !models.is_empty() {
                rule["config"]["personalModelIds"] = json!(models);
            }
            write_json(&v2.join("provider_config.json"),&json!({"schemaVersion":1,"config":{"providerConfigRules":{"providerRules":[rule]},"modelConfigRules":{"providerModelRules":[],"manualProviderModelRules":[]}}})).map_err(io_error)?;
            result["env"] = json!({"HOME":h,"ZCODE_DATA_BASE_DIR":h,"ZCODE_SETTINGS":file});
            result["zcodeHome"] = json!(h);
            result["qualifiedModel"] = legacy["model"].clone();
        }
        _ => return Err("unknown vendor lane".into()),
    }
    Ok(result)
}
