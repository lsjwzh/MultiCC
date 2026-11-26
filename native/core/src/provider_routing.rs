//! Model selection and transport configuration for stored provider records.
use crate::{
    js::serde::{js_string, truthy},
    provider_catalog, provider_settings_config as settings,
    provider_writes::toml_value,
};
use serde_json::{json, Value};

pub fn config(p: &Value) -> Value {
    provider_catalog::config_of(p).unwrap_or_else(|_| json!({}))
}
pub fn strval<'a>(v: &'a Value) -> &'a str {
    v.as_str().unwrap_or("")
}
pub fn nonempty<'a>(first: &'a str, other: &'a str) -> &'a str {
    if first.is_empty() {
        other
    } else {
        first
    }
}
pub fn replace_toml(config: &str, key: &str, value: &str) -> String {
    let line = format!("{key} = \"{}\"", value.replace(['"', '\\'], ""));
    let re = regex::Regex::new(&format!(
        r#"(^|\n)[\s\u{{feff}}]*{}[\s\u{{feff}}]*=[\s\u{{feff}}]*"[^"]*""#,
        regex::escape(key)
    ))
    .expect("escaped TOML key");
    if re.is_match(config) {
        re.replace(config, |c: &regex::Captures<'_>| format!("{}{line}", &c[1]))
            .into_owned()
    } else {
        format!("{line}\n{config}")
    }
}
pub fn effective_codex(p: &Value, port: &str) -> Value {
    let mut cfg = config(p);
    if !truthy(&cfg) {
        cfg = json!({});
    }
    let file = strval(&cfg["config"]);
    let configured = toml_value(cfg.get("config"), "base_url");
    let original = nonempty(strval(&cfg["proxyTarget"]["originalBaseUrl"]), &configured);
    if let Some(base) =
        settings::detect_responses_compat_target(Some(original)).filter(|_| truthy(&p["id"]))
    {
        let target = json!({"baseUrl":base,"apiKey":strval(&cfg["auth"]["OPENAI_API_KEY"]),"originalBaseUrl":original,"mode":"responses-compat"});
        let local = format!(
            "http://127.0.0.1:{port}/codex-proxy/{}",
            js_string(&p["id"])
        );
        cfg["config"] = replace_toml(
            &replace_toml(file, "base_url", &local),
            "wire_api",
            "responses",
        )
        .into();
        cfg["proxyTarget"] = target;
    } else if truthy(&cfg["proxyTarget"]) {
        let restored = if original.is_empty() {
            file.to_owned()
        } else {
            replace_toml(file, "base_url", original)
        };
        cfg["config"] = replace_toml(&restored, "wire_api", "responses").into();
        if let Some(obj) = cfg.as_object_mut() {
            obj.remove("proxyTarget");
        }
    }
    cfg
}
fn tier(s: &str) -> bool {
    s.eq_ignore_ascii_case("default")
        || settings::ALIAS_TIER_KEYS
            .iter()
            .any(|(t, _)| s.eq_ignore_ascii_case(t))
}
pub fn tier_model(summary: &Value, s: &str) -> String {
    let name = s.trim();
    if !tier(name) {
        return name.to_owned();
    }
    let val = &summary["aliasMap"][name.to_ascii_lowercase()];
    val.as_str()
        .or_else(|| val["model"].as_str())
        .unwrap_or("")
        .trim()
        .into()
}
pub fn wire_model(model: &Value, opts: &Value) -> Value {
    let primary = &opts["providerModel"];
    if primary.is_null() {
        if truthy(model) {
            model.clone()
        } else if truthy(&opts["skipDefaultModel"]) || !truthy(&opts["defaultModel"]) {
            Value::Null
        } else {
            opts["defaultModel"].clone()
        }
    } else if truthy(model)
        && (tier(strval(model))
            || opts["providerModels"]
                .as_array()
                .is_some_and(|v| v.contains(model)))
    {
        model.clone()
    } else {
        primary.clone()
    }
}
fn bare(s: &str) -> &str {
    static SUFFIX: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = SUFFIX.get_or_init(|| regex::Regex::new(r"\[[^\]]*\]$").expect("model suffix"));
    re.find(s).map_or(s, |m| &s[..m.start()]).trim()
}
pub fn valid_model(kind: &str, model: &str, summary: &Value) -> bool {
    if model.is_empty() {
        return true;
    }
    if kind == "claude" && (summary.is_null() || truthy(&summary["isOfficial"])) {
        return tier(model) || bare(model).to_ascii_lowercase().starts_with("claude-");
    }
    if summary.is_null() || truthy(&summary["isOfficial"]) {
        return true;
    }
    if tier(model) {
        return model.eq_ignore_ascii_case("default")
            || truthy(&summary["aliasMap"][model.to_ascii_lowercase()]["model"]);
    }
    summary["modelOptions"]
        .as_array()
        .is_none_or(|v| v.is_empty() || v.iter().any(|m| bare(strval(m)) == bare(model)))
}
pub mod import;
pub mod spawn;
pub mod targets;
pub mod vendor;
