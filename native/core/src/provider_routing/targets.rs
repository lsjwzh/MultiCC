//! Select the credential and transport for a single stored record.
use super::*;
use crate::{http_gate::encode_uri_component, provider_balance_target, provider_registry};
pub fn import_token(kind: &str, p: &Value, port: &str) -> String {
    let cfg = if kind == "codex" {
        effective_codex(p, port)
    } else {
        config(p)
    };
    (if kind == "codex" {
        strval(&cfg["auth"]["OPENAI_API_KEY"])
    } else {
        nonempty(
            strval(&cfg["env"]["ANTHROPIC_AUTH_TOKEN"]),
            strval(&cfg["env"]["ANTHROPIC_API_KEY"]),
        )
    })
    .trim()
    .into()
}
pub fn relay(kind: &str, p: &Value, force: bool, port: &str) -> Value {
    if !matches!(kind, "claude" | "codex") || p.is_null() || truthy(&p["virtual"]) {
        return Value::Null;
    }
    let cfg = if kind == "codex" {
        effective_codex(p, port)
    } else {
        config(p)
    };
    if !force && cfg["cliRelay"] != true && cfg["relayMode"] != "cli" {
        return Value::Null;
    }
    let toml = toml_value(cfg.get("config"), "base_url");
    let base = if kind == "codex" {
        nonempty(strval(&cfg["proxyTarget"]["originalBaseUrl"]), &toml)
    } else {
        strval(&cfg["env"]["ANTHROPIC_BASE_URL"])
    };
    let token = import_token(kind, p, port);
    if !token.starts_with("mcr1.") {
        return Value::Null;
    }
    provider_registry::relay_route_from_base_url(Some(&json!(base)))
        .filter(|r| r["appType"] == kind)
        .map(|r| json!({"appType":kind,"relayBaseUrl":r["url"],"relayAuthToken":token}))
        .unwrap_or_default()
}
pub fn balance(p: &Value, id: &str) -> Value {
    if p.is_null() || truthy(&p["virtual"]) {
        return Value::Null;
    }
    let cfg = config(p);
    let kind = strval(&p["appType"]);
    let codex = kind == "codex";
    let toml = toml_value(cfg.get("config"), "base_url");
    let (base, key) = if codex {
        (
            nonempty(strval(&cfg["proxyTarget"]["originalBaseUrl"]), &toml),
            nonempty(
                strval(&cfg["proxyTarget"]["apiKey"]),
                strval(&cfg["auth"]["OPENAI_API_KEY"]),
            ),
        )
    } else {
        (
            strval(&cfg["env"]["ANTHROPIC_BASE_URL"]),
            nonempty(
                strval(&cfg["env"]["ANTHROPIC_AUTH_TOKEN"]),
                strval(&cfg["env"]["ANTHROPIC_API_KEY"]),
            ),
        )
    };
    if base.is_empty() && key.is_empty() {
        let account = strval(&cfg["officialAccount"]["id"]);
        let mut v = json!({"providerId":id,"appType":if codex{"codex"}else{"claude"},"host":if codex{"chatgpt.com"}else{"api.anthropic.com"},"apiKey":null,"officialAccountId":if account.is_empty(){Value::Null}else{json!(account)},"strategy":if codex{"codex-oauth-usage"}else{"claude-oauth-usage"}});
        if codex {
            v["keyHashSeed"] = json!(if account.is_empty() {
                "codex-oauth".into()
            } else {
                format!("codex-oauth:{account}")
            });
        }
        return v;
    }
    if base.is_empty() || key.is_empty() {
        return Value::Null;
    }
    if let Some(route) = provider_registry::relay_route_from_base_url(Some(&json!(base))) {
        return json!({"providerId":id,"appType":kind,"relayUrl":route["url"],"apiKey":key,"strategy":"relay-quota"});
    }
    let Some(strategy) = provider_balance_target::strategy_for_base_url(base) else {
        return Value::Null;
    };
    let Ok(url) = url::Url::parse(base.trim()) else {
        return Value::Null;
    };
    let mut v = json!({"providerId":id,"appType":kind,"host":url[url::Position::BeforeHost..url::Position::AfterPort].to_lowercase(),"apiKey":key,"strategy":strategy});
    if strategy == "panel-auto" {
        v["baseUrl"] = base.into();
    }
    v
}
pub fn aux(
    protocol: &str,
    id: &str,
    p: &Value,
    s: &Value,
    port: &str,
    official_proxy: bool,
) -> Value {
    let openai = protocol == "openai";
    let protocol = if openai { "openai" } else { "anthropic" };
    let fail = |reason: &str| json!({"available":false,"protocol":protocol,"reason":reason});
    if p.is_null() {
        return fail("provider not found");
    }
    let cfg = config(p);
    let env = &cfg["env"];
    let local = !openai || provider_catalog::official_codex(p);
    if local {
        if !openai
            && !(truthy(&env["ANTHROPIC_BASE_URL"])
                && (truthy(&env["ANTHROPIC_API_KEY"]) || truthy(&env["ANTHROPIC_AUTH_TOKEN"]))
                || (id == "claude-official" || truthy(&cfg["officialAccount"]["id"]))
                    && official_proxy)
        {
            return fail("provider has no HTTP credentials");
        }
        if port.is_empty() {
            return fail("proxy port unavailable");
        }
        let url = if openai {
            format!(
                "http://127.0.0.1:{port}/codex-proxy/{}/responses",
                encode_uri_component(id)
            )
        } else {
            format!("http://127.0.0.1:{port}/claude-proxy/{id}/aux/v1/messages?beta=true")
        };
        let models = if !openai && s["modelOptions"].as_array().is_none_or(Vec::is_empty) {
            json!(["haiku", "sonnet", "opus", "fable"])
        } else {
            s["modelOptions"].clone()
        };
        return json!({"available":true,"protocol":protocol,"wireApi":if openai{"responses"}else{"messages"},"url":url,"apiKey":"multicc-aux","model":s["model"],"modelOptions":models,"providerName":s["name"],"localProxy":true});
    }
    let api_key = strval(&cfg["auth"]["OPENAI_API_KEY"]);
    if api_key.is_empty() {
        return fail("OAuth provider has no API key");
    }
    let toml = |key| toml_value(cfg.get("config"), key);
    let base = toml("base_url");
    if base.is_empty() {
        return fail("provider has no base_url");
    }
    if base.contains("127.0.0.1") || base.contains("localhost") {
        return fail("local proxy has no direct target");
    }
    let chat = toml("wire_api") == "chat_completions";
    let suffix = if chat {
        "/chat/completions"
    } else {
        "/responses"
    };
    let mut url = base.trim_end_matches('/').to_owned();
    if !url.ends_with(suffix) {
        url.push_str(suffix);
    }
    let model = toml("model");
    let models = if let Some(m) = cfg["modelCatalog"]["models"].as_array() {
        m.iter()
            .filter_map(|r| r.get("model").filter(|v| truthy(v)).cloned())
            .collect()
    } else if model.is_empty() {
        vec![]
    } else {
        vec![json!(model)]
    };
    json!({"available":true,"protocol":protocol,"wireApi":if chat{"chat_completions"}else{"responses"},"url":url,"apiKey":api_key,"model":model,"modelOptions":models,"providerName":s["name"]})
}
