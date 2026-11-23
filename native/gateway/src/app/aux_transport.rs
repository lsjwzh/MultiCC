//! Aux wire codecs used by the service worker. Request credentials stay in memory.
use multicc_core::{
    account_subscription as account,
    provider_catalog_snapshot::{aux_provider, AuxProvider},
    provider_credentials, provider_store,
    public_safety::sanitize_public_text,
};
use serde_json::{json, Value};
use std::{path::Path, time::Duration};

fn text(v: &Value) -> &str {
    v.as_str().unwrap_or_default()
}
pub(super) fn config(root: &Path) -> Value {
    let v = provider_store::read(&root.join("aux-config.json"))
        .ok()
        .flatten()
        .unwrap_or_default();
    let protocol = v["protocol"].as_str().unwrap_or(if v["cli"] == "codex" {
        "openai"
    } else {
        "anthropic"
    });
    json!({"protocol":if protocol.eq_ignore_ascii_case("openai"){"openai"}else{"anthropic"},"providerId":v["providerId"],"model":v["model"].as_str().map(str::trim).filter(|s|!s.is_empty())})
}
pub(super) fn set_config(root: &Path, home: &Path, v: &Value) -> (u16, Value) {
    let fail = |s: &str| (400, json!({"ok":false,"error":s}));
    let protocol = text(&v["protocol"]).to_ascii_lowercase();
    if !matches!(protocol.as_str(), "anthropic" | "openai") {
        return fail("protocol 必须是 anthropic 或 openai");
    }
    let id = text(&v["providerId"]);
    if id.is_empty() {
        return fail("请选择 Provider");
    }
    let a = match aux_provider(root, home, &protocol, id) {
        Ok(a) => a,
        Err(e) => return fail(&format!("Provider 不支持 {protocol} HTTP 调用：{e}")),
    };
    let model = v["model"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&a.model);
    if model.is_empty() {
        return fail("请选择模型");
    }
    let mut cfg = json!({"protocol":protocol,"providerId":id,"model":model});
    if provider_store::atomic_write(&root.join("aux-config.json"), &cfg).is_err() {
        return (500, json!({"ok":false,"error":"Aux config write failed"}));
    }
    cfg["ok"] = true.into();
    cfg["wireApi"] = a.wire.into();
    (200, cfg)
}

struct Request {
    binding: Option<multicc_core::egress_plugin::EgressBinding>,
    allowed_ips: Vec<String>,
    url: String,
    headers: std::collections::BTreeMap<String, String>,
    body: Value,
}
fn prepare(home: &Path, a: &AuxProvider, model: &str, job: &Value) -> Result<Request, String> {
    // Dedicated egress cannot silently fall back to a direct connection.
    let binding = multicc_core::egress_plugin::parse_egress_binding(a.record.get("egressBinding"))
        .map_err(|_| "Aux Provider 专用出口配置无效")?;
    let prompt = &job["prompt"];
    let system = &job["systemPrompt"];
    let mut headers = std::collections::BTreeMap::new();
    let mut body = match a.wire.as_str() {
        "messages" => {
            let mut b = json!({"model":model,"max_tokens":128000,"messages":[{"role":"user","content":prompt}]});
            if multicc_core::js::serde::truthy(system) {
                b["system"] = system.clone();
            }
            b
        }
        "responses" => {
            json!({"model":model,"input":[{"role":"user","content":[{"type":"input_text","text":prompt}]}],"instructions":text(system),"stream":true})
        }
        "chat_completions" => {
            let mut m = vec![];
            if multicc_core::js::serde::truthy(system) {
                m.push(json!({"role":"system","content":system}));
            }
            m.push(json!({"role":"user","content":prompt}));
            json!({"model":model,"max_tokens":128000,"messages":m})
        }
        _ => return Err("不支持的 Aux wire API".into()),
    };
    let account_id = text(&a.config["officialAccount"]["id"]);
    if !account_id.is_empty() && !account::valid_account(account_id) {
        return Err("官方账号标识无效".into());
    }
    let url = if a.wire == "messages" {
        let env = &a.config["env"];
        headers.insert("anthropic-version".into(), "2023-06-01".into());
        let base = if a.official {
            let now = chrono::Utc::now().timestamp_millis();
            let token = if account_id.is_empty() {
                std::fs::read_to_string(account::cli_credentials_file(home))
                    .ok()
                    .and_then(|s| account::global_claude_token(&provider_credentials::cli(&s), now))
            } else {
                account::peek_claude_token(home, account_id, now)
            }
            .ok_or("Aux Provider 不可用：官方账号未登录")?;
            headers.insert("authorization".into(), format!("Bearer {token}"));
            headers.insert("anthropic-beta".into(), "oauth-2025-04-20".into());
            "https://api.anthropic.com"
        } else {
            if let Some(token) = env["ANTHROPIC_AUTH_TOKEN"]
                .as_str()
                .filter(|s| !s.is_empty())
            {
                headers.insert("authorization".into(), format!("Bearer {token}"));
            }
            if let Some(key) = env["ANTHROPIC_API_KEY"].as_str().filter(|s| !s.is_empty()) {
                headers.insert("x-api-key".into(), key.into());
            }
            for &(tier, key) in multicc_core::provider_settings_config::ALIAS_TIER_KEYS {
                if model.eq_ignore_ascii_case(tier) && env[key].is_string() {
                    body["model"] = env[key].clone();
                }
            }
            text(&env["ANTHROPIC_BASE_URL"])
        };
        format!("{}/v1/messages?beta=true", base.trim_end_matches('/'))
    } else if a.official {
        let auth = provider_store::read(&account::codex_auth_file(home, account_id))
            .ok()
            .flatten()
            .unwrap_or_default();
        let cred = provider_credentials::codex_credential(
            &auth,
            chrono::Utc::now().timestamp_millis() as f64,
        );
        if cred["ok"] != true {
            return Err("Aux Provider 不可用：官方账号未登录".into());
        }
        multicc_cpr::codex_official::headers(
            &mut headers,
            text(&cred["accessToken"]),
            text(&cred["accountId"]),
        );
        multicc_cpr::codex_official::body(&mut body);
        "https://chatgpt.com/backend-api/codex/responses".into()
    } else {
        headers.insert(
            "authorization".into(),
            format!("Bearer {}", text(&a.config["auth"]["OPENAI_API_KEY"])),
        );
        let suffix = if a.wire == "responses" {
            "/responses"
        } else {
            "/chat/completions"
        };
        let base = a.base.trim_end_matches('/');
        if base.ends_with(suffix) {
            base.into()
        } else {
            format!("{base}{suffix}")
        }
    };
    let u = url::Url::parse(&url).map_err(|_| "Aux Provider URL 无效")?;
    if !matches!(u.scheme(), "http" | "https") || !u.username().is_empty() || u.password().is_some()
    {
        return Err("Aux Provider URL 无效".into());
    }
    Ok(Request {
        allowed_ips: multicc_core::provider_writes::normalize_egress_ip_allowlist(
            a.record.get("egressIpAllowlist"),
        ),
        url,
        headers,
        body,
        binding,
    })
}
fn message(error: &Value, fallback: &str) -> String {
    let raw = error["error"]["message"]
        .as_str()
        .or(error["message"].as_str())
        .or(error["error"].as_str());
    sanitize_public_text(raw, fallback)
}
fn parse(wire: &str, sse: bool, data: &str) -> Result<String, String> {
    let v: Value = if wire == "responses" && sse {
        let mut completed = None;
        for event in data.replace("\r\n", "\n").split("\n\n") {
            let data = event
                .lines()
                .filter_map(|l| l.strip_prefix("data:").map(str::trim_start))
                .collect::<Vec<_>>()
                .join("\n");
            if data.is_empty() || data == "[DONE]" {
                continue;
            }
            let v: Value = serde_json::from_str(&data).map_err(|_| "Invalid Aux response")?;
            match text(&v["type"]) {
                "response.completed" => completed = Some(v["response"].clone()),
                "error" | "response.failed" | "response.incomplete" => {
                    let fallback = format!("Aux {}", text(&v["type"]));
                    return Err(if v["response"]["error"].is_object() {
                        message(&v["response"], &fallback)
                    } else {
                        message(&v, &fallback)
                    });
                }
                _ => (),
            }
        }
        completed.ok_or("Aux Responses stream disconnected before completion")?
    } else {
        serde_json::from_str(data).map_err(|_| "Invalid Aux response")?
    };
    if !v["error"].is_null() {
        return Err(message(&v, "Aux response failed"));
    }
    if matches!(v["status"].as_str(), Some("failed" | "incomplete")) {
        return Err(format!("Aux response {}", text(&v["status"])));
    }
    let blocks = |v: &Value| v.as_array().cloned().unwrap_or_default();
    Ok(match wire {
        "messages" => blocks(&v["content"])
            .iter()
            .filter(|b| b["type"] == "text")
            .map(|b| text(&b["text"]))
            .collect::<Vec<_>>()
            .join(" "),
        "responses" => v["output_text"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| {
                blocks(&v["output"])
                    .iter()
                    .flat_map(|i| blocks(&i["content"]))
                    .filter(|b| matches!(b["type"].as_str(), Some("text" | "output_text")))
                    .map(|b| text(&b["text"]).to_owned())
                    .collect()
            }),
        _ => {
            let content = &v["choices"][0]["message"]["content"];
            content
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| blocks(content).iter().map(|b| text(&b["text"])).collect())
        }
    })
}
async fn observed_ip(client: &reqwest::Client, url: &str) -> Option<String> {
    let mut response = client
        .get(url)
        .timeout(Duration::from_secs(4))
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let mut text = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if text.len() + chunk.len() > 8192 {
            return None;
        }
        text.extend_from_slice(&chunk);
    }
    let ip = std::str::from_utf8(&text).ok()?.trim();
    ip.parse::<std::net::IpAddr>().ok().map(|_| ip.to_owned())
}

async fn verify_exit(
    client: &reqwest::Client,
    allowed: &[String],
    urls: &[&str],
) -> Result<(), String> {
    if allowed.is_empty() {
        return Ok(());
    }
    for url in urls {
        if let Some(ip) = observed_ip(client, url).await {
            if allowed.contains(&ip) {
                return Ok(());
            }
            return Err(format!("当前出口 IP（{ip}）不在该 Provider 允许的 IP 列表内，请修改 Provider 的出口 IP 配置，或切换 VPN 后重试"));
        }
    }
    Err("出口 IP 探测失败，暂不能使用该 Provider".into())
}

async fn send(request: Request, wire: &str, timeout: u64) -> Result<String, String> {
    let mut builder = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none());
    if let Some(binding) = &request.binding {
        let url = crate::egress_runtime::resolve_egress_proxy_url(binding)
            .await
            .map_err(|_| "Aux Provider 专用出口不可用")?;
        let proxy = reqwest::Proxy::all(url).map_err(|_| "Aux Provider 专用出口配置无效")?;
        builder = builder.proxy(proxy);
    }
    let client = builder.build().map_err(|_| "Aux transport unavailable")?;
    // Use the resolved provider proxy, before attaching any provider credentials.
    verify_exit(
        &client,
        &request.allowed_ips,
        &["https://checkip.amazonaws.com", "https://icanhazip.com"],
    )
    .await?;
    let mut req = client
        .post(request.url)
        .timeout(Duration::from_millis(timeout))
        .header("content-type", "application/json")
        .body(request.body.to_string());
    let secrets: Vec<_> = request
        .headers
        .iter()
        .filter(|(k, _)| {
            matches!(
                k.as_str(),
                "authorization" | "x-api-key" | "chatgpt-account-id"
            )
        })
        .map(|(_, v)| v.strip_prefix("Bearer ").unwrap_or(v).to_owned())
        .filter(|v| !v.is_empty())
        .collect();
    for (k, v) in request.headers {
        req = req.header(k, v);
    }
    let mut res = req.send().await.map_err(|e| {
        if e.is_timeout() {
            "timeout"
        } else {
            "Aux connection failed"
        }
    })?;
    let status = res.status();
    let sse = res
        .headers()
        .get("content-type")
        .and_then(|h| h.to_str().ok())
        .is_some_and(|s| s.contains("text/event-stream"));
    let mut data = vec![];
    while let Some(b) = res.chunk().await.map_err(|e| {
        if e.is_timeout() {
            "timeout"
        } else {
            "Aux response disconnected before completion"
        }
    })? {
        if data.len() + b.len() > 16 * 1024 * 1024 {
            return Err("Aux response exceeds size limit".into());
        }
        data.extend_from_slice(&b);
    }
    let body = String::from_utf8_lossy(&data);
    let redact = |mut s: String| {
        for secret in &secrets {
            s = s.replace(secret, "[REDACTED]");
        }
        s
    };
    if status.as_u16() >= 400 {
        let default = format!("HTTP {}", status.as_u16());
        let msg = match serde_json::from_str::<Value>(&body) {
            Ok(v) => message(&v, &default),
            Err(_) => sanitize_public_text(
                Some(&redact(format!(
                    "{default}: {}",
                    body.chars().take(200).collect::<String>()
                ))),
                &default,
            ),
        };
        return Err(redact(msg));
    }
    parse(wire, sse, &body).map(&redact).map_err(redact)
}
pub(super) async fn execute(
    root: std::path::PathBuf,
    home: std::path::PathBuf,
    job: Value,
) -> (Value, Result<String, String>) {
    let timeout = job["meta"]["timeout"]
        .as_u64()
        .filter(|n| *n > 0)
        .unwrap_or_else(|| {
            std::env::var("AUX_TIMEOUT_MS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(90000)
                .max(10000)
        });
    let prepared = tokio::task::spawn_blocking(move || {
        let cfg = config(&root);
        let a = aux_provider(
            &root,
            &home,
            text(&cfg["protocol"]),
            text(&cfg["providerId"]),
        )
        .map_err(|e| format!("Aux Provider 不可用：{e}"));
        let mut meta = json!({"protocol":cfg["protocol"],"wireApi":null});
        let req = a.and_then(|a| {
            meta["wireApi"] = json!(a.wire);
            let model = cfg["model"].as_str().unwrap_or(&a.model);
            if model.is_empty() {
                return Err("Aux Provider 没有可用模型".into());
            }
            prepare(&home, &a, model, &job)
        });
        (meta, req)
    })
    .await;
    let Ok((meta, request)) = prepared else {
        return (Value::Null, Err("Aux transport unavailable".into()));
    };
    let result = match request {
        Ok(req) => send(req, text(&meta["wireApi"]), timeout).await,
        Err(e) => Err(e),
    };
    (meta, result)
}

#[cfg(test)]
mod tests {
    use super::verify_exit;
    use axum::{http::HeaderMap, routing::get, Router};

    #[tokio::test]
    async fn restricted_provider_checks_observed_ip_before_use() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let app = Router::new().route(
            "/ip",
            get(|headers: HeaderMap| async move {
                assert!(
                    !headers.contains_key("authorization") && !headers.contains_key("x-api-key")
                );
                "192.0.2.10\n"
            }),
        );
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let ip = format!("{origin}/ip");
        let missing = format!("{origin}/missing");
        let allowed = vec!["192.0.2.10".to_string()];
        assert!(verify_exit(&client, &[], &[]).await.is_ok());
        assert!(verify_exit(&client, &allowed, &[&missing, &ip])
            .await
            .is_ok());
        assert!(verify_exit(&client, &["192.0.2.11".into()], &[&ip])
            .await
            .unwrap_err()
            .contains("不在"));
        assert!(verify_exit(&client, &allowed, &[&missing])
            .await
            .unwrap_err()
            .contains("探测失败"));
        server.abort();
        let _ = server.await;
    }
}
