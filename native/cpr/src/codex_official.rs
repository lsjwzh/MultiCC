//! ChatGPT OAuth uses the same native transport as ordinary Responses routes.
use crate::plan::text;
use serde_json::Value;
use std::collections::BTreeMap;
pub fn is_official(provider: &Value, cfg: &Value) -> bool {
    let auth = &cfg["auth"];
    let config = text(cfg, "config");
    let base = config.lines().any(|line| {
        line.trim()
            .split_once('=')
            .is_some_and(|(k, _)| k.trim() == "base_url")
    });
    if !text(auth, "OPENAI_API_KEY").is_empty() || cfg["proxyTarget"].is_object() || base {
        return false;
    }
    let mode = text(auth, "auth_mode").to_ascii_lowercase();
    if !mode.is_empty() {
        return mode == "chatgpt";
    }
    provider["source"] == "ccswitch"
        && provider["id"] == "codex-official"
        && config.trim().is_empty()
        && cfg["officialAccount"].is_null()
}
pub fn headers(headers: &mut BTreeMap<String, String>, token: &str, account: &str) {
    headers.retain(|name, value| {
        ![
            "chatgpt-account-id",
            "cookie2",
            "set-cookie",
            "api-key",
            "x-access-token",
            "x-auth-token",
            "openai-organization",
            "openai-project",
            "content-type",
            "content-encoding",
            "content-md5",
            "content-digest",
            "repr-digest",
            "digest",
            "proxy-connection",
            "expect",
            "http2-settings",
            "forwarded",
            "via",
            "x-real-ip",
            "true-client-ip",
        ]
        .contains(&name.as_str())
            && !name.starts_with("x-forwarded-")
            && !name.starts_with("x-multicc-")
            && value.len() <= 16 * 1024
            && !value.chars().any(|c| c == '\r' || c == '\n' || c == '\0')
    });
    headers.insert("authorization".into(), format!("Bearer {token}"));
    headers.insert("chatgpt-account-id".into(), account.into());
    headers.insert("content-type".into(), "application/json".into());
    headers
        .entry("accept".into())
        .or_insert("text/event-stream".into());
    headers
        .entry("originator".into())
        .or_insert("codex_cli_rs".into());
    headers
        .entry("user-agent".into())
        .or_insert("codex_cli_rs/multicc-relay".into());
}
pub fn body(body: &mut Value) {
    body["store"] = false.into();
    if let Some(items) = body["input"].as_array_mut() {
        for item in items {
            if item["type"] == "reasoning" {
                if let Some(obj) = item.as_object_mut() {
                    obj.remove("content");
                }
            }
        }
    }
}

pub fn public_error(input: &Value) -> Value {
    let body: Value = serde_json::from_str(text(input, "body")).unwrap_or(Value::Null);
    let detail = if body["error"].is_object() {
        &body["error"]
    } else {
        &body
    };
    let mut message = text(detail, "message").to_owned();
    if message.is_empty() {
        message = "Codex 官方上游拒绝了请求".into();
    }
    for secret in [
        text(&input["credential"], "accessToken"),
        text(&input["credential"], "accountId"),
    ] {
        if !secret.is_empty() {
            message = message.replace(secret, "[REDACTED]");
        }
    }
    // Public errors need the reason, never upstream URLs, host paths or headers.
    if message.contains("Bearer ")
        || message.contains("http://")
        || message.contains("https://")
        || message.contains("/Users/")
        || message.contains("/home/")
        || message.contains("api_key")
    {
        message = "Codex 官方上游拒绝了请求，请检查账号状态或请求内容".into();
    }
    let message: String = message.chars().take(600).collect();
    serde_json::json!({"error":{"message":message},"code":"CODEX_OFFICIAL_OAUTH_UPSTREAM_REJECTED","upstreamStatus":input["status"]})
}
