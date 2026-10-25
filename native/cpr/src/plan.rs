use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Route {
    pub protocol: String,
    pub provider_id: String,
    pub main_provider_id: String,
    pub session_id: String,
    pub role: String,
    pub agent_role: String,
    pub route_name: String,
    pub model: String,
    pub api_path: String,
    pub query: String,
    pub is_stream: bool,
}

pub fn route(input: &Value) -> Result<Route, String> {
    let protocol = text(input, "protocol");
    let url = text(input, "url");
    let (path, query) = url
        .split_once('?')
        .map_or((url, "".to_owned()), |(p, q)| (p, format!("?{q}")));
    let prefix = if protocol == "claude" {
        "/claude-proxy"
    } else {
        "/codex-proxy"
    };
    let path = path.strip_prefix(prefix).unwrap_or(path);
    let parts: Vec<String> = path
        .split('/')
        .filter(|s| !s.is_empty())
        .map(|s| {
            percent_decode_str(s)
                .decode_utf8()
                .map(|s| s.into_owned())
                .map_err(|_| "代理路径编码无效".to_owned())
        })
        .collect::<Result<_, _>>()?;
    let provider_id = parts.first().cloned().unwrap_or_default();
    if provider_id.is_empty() {
        return Err("代理路径缺少供应商".into());
    }
    let body: Value = serde_json::from_str(text(input, "body")).unwrap_or(Value::Null);
    let mut r = Route {
        protocol: protocol.into(),
        main_provider_id: provider_id.clone(),
        provider_id,
        session_id: String::new(),
        role: "main".into(),
        agent_role: String::new(),
        route_name: "main".into(),
        model: text(&body, "model").into(),
        api_path: String::new(),
        query,
        is_stream: body
            .get("stream")
            .and_then(Value::as_bool)
            .unwrap_or(protocol == "codex"),
    };
    match protocol {
        "claude" => {
            r.session_id = parts.get(1).cloned().unwrap_or_default();
            r.api_path = format!(
                "/{}",
                parts.iter().skip(2).cloned().collect::<Vec<_>>().join("/")
            );
            if r.session_id == "aux" {
                r.role = "aux".into();
                r.route_name = "aux".into();
            }
            if let Some(encoded) = r
                .model
                .strip_prefix("cpr:")
                .or_else(|| r.model.strip_prefix("ccfw:"))
            {
                if let Some((provider, model)) = encoded.split_once(':') {
                    if !provider.trim().is_empty() && !model.trim().is_empty() {
                        r.provider_id = provider.trim().into();
                        r.model = model.trim().into();
                        r.role = "sub".into();
                        r.agent_role = "default".into();
                        r.route_name = "default".into();
                    }
                }
            }
        }
        "codex" => {
            if parts.len() == 4 && parts[3] == "responses" {
                r.session_id = parts[1].clone();
                let role = parts[2].trim().to_lowercase();
                if role == "aux"
                    || role.is_empty()
                    || role.len() > 64
                    || !role.as_bytes()[0].is_ascii_lowercase()
                    || !role.bytes().all(|c| {
                        c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_' || c == b'-'
                    })
                {
                    return Err("Codex 子代理路由无效".into());
                }
                if role != "main" {
                    r.role = "sub".into();
                    r.route_name = if role == "sub" {
                        "default".into()
                    } else {
                        role.clone()
                    };
                    r.agent_role =
                        if ["sub", "default", "worker", "explorer"].contains(&role.as_str()) {
                            r.route_name.clone()
                        } else {
                            "custom".into()
                        };
                }
            } else if parts.len() != 2 || parts[1] != "responses" {
                return Err("Codex 代理路径无效".into());
            }
            r.api_path = "/responses".into();
        }
        _ => return Err("不支持的代理协议".into()),
    }
    Ok(r)
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub route: Route,
    pub provider_name: String,
    pub url: String,
    pub method: String,
    pub headers: BTreeMap<String, String>,
    pub body: String,
    pub mode: String,
    #[serde(default)]
    pub proxy_url: Option<String>,
    #[serde(default = "default_timeout")]
    pub headers_timeout_ms: u64,
}
fn default_timeout() -> u64 {
    300_000
}
pub fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}
fn config(provider: &Value) -> Value {
    let v = &provider["settingsConfig"];
    v.as_str()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_else(|| v.clone())
}
fn strip_suffix(model: &str) -> &str {
    let model = model.trim();
    model
        .rfind('[')
        .filter(|_| model.ends_with(']'))
        .map_or(model, |i| model[..i].trim_end())
}
fn safe_url(raw: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(raw).map_err(|_| "上游地址无效".to_owned())?;
    if !["http", "https"].contains(&url.scheme())
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("上游必须使用不含内嵌凭据的 HTTP 或 HTTPS 地址".into());
    }
    Ok(url)
}

pub fn prepare(input: Value) -> Result<Value, String> {
    let mut route: Route =
        serde_json::from_value(input["route"].clone()).map_err(|_| "代理路由无效".to_owned())?;
    let provider = &input["provider"];
    let cfg = config(provider);
    let raw = text(&input, "body");
    let mut body: Value = serde_json::from_str(raw).unwrap_or(Value::Null);
    let mut wire = raw.to_owned();
    let mut headers = BTreeMap::new();
    let incoming = input["headers"].as_object();
    let mut excluded = vec![
        "host",
        "content-length",
        "connection",
        "keep-alive",
        "transfer-encoding",
        "te",
        "trailer",
        "upgrade",
        "proxy-authorization",
        "proxy-authenticate",
        "accept-encoding",
        "authorization",
        "x-api-key",
        "cookie",
    ];
    let connection_parts: Vec<String> = incoming
        .and_then(|h| h.get("connection"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .split(',')
        .map(|s| s.trim().to_lowercase())
        .collect();
    for part in &connection_parts {
        excluded.push(part);
    }
    if let Some(incoming) = incoming {
        for (name, value) in incoming {
            let name = name.to_lowercase();
            if !excluded.contains(&name.as_str()) {
                if let Some(s) = value.as_str() {
                    headers.insert(name, s.to_owned());
                }
            }
        }
    }
    headers.insert("accept-encoding".into(), "identity".into());
    let mode;
    let url = if route.protocol == "claude" {
        mode = "anthropic-messages".to_owned();
        let env = &cfg["env"];
        let mut base = text(env, "ANTHROPIC_BASE_URL").to_owned();
        let account = text(&cfg["officialAccount"], "id");
        let account = if account.len() == 16
            && account
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        {
            account
        } else {
            ""
        };
        let official = base.is_empty()
            && (route.provider_id == text(&input, "officialProviderId")
                || route.provider_id == "claude-official"
                || !account.is_empty())
            && input["officialViaProxy"] == true;
        if official {
            let token = text(&input, "officialToken");
            if token.is_empty() {
                return Ok(json!({"credentialRequest": {"accountId": account}}));
            }
            base = if text(&input, "officialBaseUrl").is_empty() {
                "https://api.anthropic.com"
            } else {
                text(&input, "officialBaseUrl")
            }
            .into();
            headers.insert("authorization".into(), format!("Bearer {token}"));
            let beta = if text(&input, "oauthBeta").is_empty() {
                "oauth-2025-04-20"
            } else {
                text(&input, "oauthBeta")
            };
            let mut betas: Vec<&str> = headers
                .get("anthropic-beta")
                .map(String::as_str)
                .unwrap_or("")
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .collect();
            if !betas.contains(&beta) {
                betas.push(beta);
            }
            headers.insert("anthropic-beta".into(), betas.join(","));
        } else {
            if base.is_empty() {
                return Err("供应商未配置上游地址".into());
            }
            let token = text(env, "ANTHROPIC_AUTH_TOKEN");
            let key = text(env, "ANTHROPIC_API_KEY");
            if !token.is_empty() {
                headers.insert("authorization".into(), format!("Bearer {token}"));
            }
            if !key.is_empty() {
                headers.insert("x-api-key".into(), key.into());
            }
            let tier = route.model.to_lowercase();
            if ["sonnet", "opus", "haiku", "fable"].contains(&tier.as_str()) {
                let alias = &env[format!("ANTHROPIC_DEFAULT_{}_MODEL", tier.to_uppercase())];
                let alias = alias.as_str().unwrap_or_else(|| {
                    let m = text(alias, "model");
                    if m.is_empty() {
                        text(alias, "name")
                    } else {
                        m
                    }
                });
                if !alias.is_empty() {
                    route.model = strip_suffix(alias).into();
                }
            }
        }
        if body.is_object() && body["model"].as_str().unwrap_or("") != route.model {
            body["model"] = route.model.clone().into();
            wire = body.to_string();
        }
        let mut parsed = safe_url(&base)?;
        let path = format!("{}{}", parsed.path().trim_end_matches('/'), route.api_path);
        parsed.set_path(&path);
        parsed.set_query(route.query.strip_prefix('?'));
        parsed.set_fragment(None);
        parsed.to_string()
    } else {
        if !body.is_object() {
            return Err("Responses 请求必须是 JSON 对象".into());
        }
        let target = &cfg["proxyTarget"];
        let (base, target_mode, key) = if !text(target, "baseUrl").is_empty() {
            (
                text(target, "baseUrl").to_owned(),
                text(target, "mode").to_owned(),
                {
                    let k = text(target, "apiKey");
                    if k.is_empty() {
                        text(&cfg["auth"], "OPENAI_API_KEY")
                    } else {
                        k
                    }
                }
                .to_owned(),
            )
        } else {
            let parsed: toml::Value = toml::from_str(text(&cfg, "config"))
                .map_err(|_| "供应商 config.toml 无效".to_owned())?;
            let name = parsed
                .get("model_provider")
                .and_then(toml::Value::as_str)
                .unwrap_or("");
            let p = parsed
                .get("model_providers")
                .and_then(|p| p.get(name))
                .ok_or("供应商未配置 model_provider")?;
            let base = p
                .get("base_url")
                .and_then(toml::Value::as_str)
                .ok_or("供应商未配置 base_url")?;
            let wire_api = p
                .get("wire_api")
                .and_then(toml::Value::as_str)
                .unwrap_or("responses");
            if ["chat", "chat_completions"].contains(&wire_api) {
                return Err("Rust CPR 暂不提供已退役的 Chat 转 Responses 桥；请使用原生 Responses 或切回 Node".into());
            }
            let base = base.trim_end_matches('/');
            let endpoint = if base.ends_with("/responses") {
                base.to_owned()
            } else {
                format!("{base}/responses")
            };
            let k = text(&cfg["auth"], "OPENAI_API_KEY");
            (
                endpoint,
                "direct-responses".into(),
                if k.is_empty() {
                    text(&cfg["auth"]["tokens"], "access_token")
                } else {
                    k
                }
                .into(),
            )
        };
        let parsed = safe_url(&base)?;
        let local_prefix = text(&input, "codexProxyPath");
        let local_prefix = if local_prefix.is_empty() {
            "/codex-proxy"
        } else {
            local_prefix
        };
        if ["127.0.0.1", "localhost", "[::1]"].contains(&parsed.host_str().unwrap_or(""))
            && (parsed.path() == local_prefix
                || parsed.path().starts_with(&format!("{local_prefix}/")))
        {
            return Err("供应商上游指回本机 Codex 代理，会造成循环".into());
        }
        mode = if parsed.host_str() == Some("maas-coding-api.cn-huabei-1.xf-yun.com") {
            "responses-compat".into()
        } else {
            target_mode
        };
        if !["direct-responses", "responses-compat"].contains(&mode.as_str()) {
            return Err("Rust CPR 不支持此上游协议模式；请使用原生 Responses 或切回 Node".into());
        }
        if key.is_empty() {
            return Err("供应商未配置 HTTP 凭据".into());
        }
        route.is_stream = mode == "responses-compat" || body["stream"] != false;
        body["stream"] = route.is_stream.into();
        wire = body.to_string();
        headers.insert("authorization".into(), format!("Bearer {key}"));
        headers.insert("content-type".into(), "application/json".into());
        headers.insert("accept".into(), "text/event-stream".into());
        parsed.to_string()
    };
    headers.insert("content-length".into(), wire.len().to_string());
    let plan = Plan {
        route,
        provider_name: text(provider, "name").into(),
        url,
        method: text(&input, "method").into(),
        headers,
        body: wire,
        mode,
        proxy_url: None,
        headers_timeout_ms: input["headersTimeoutMs"]
            .as_u64()
            .unwrap_or(default_timeout())
            .clamp(1, 300_000),
    };
    Ok(json!({"plan": plan}))
}

pub fn rate_limit(headers: &Map<String, Value>) -> Option<Value> {
    crate::claude_quota::extract(headers)
}
