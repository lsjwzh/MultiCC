//! `GET /api/{claude,codex}/subscription`: the decisions behind the answer.
//!
//! This module is the pure half of src/routes/account-subscription.js: the
//! account-id parsing, the official-account existence rule, the read-only
//! credential peek, the request plan and the result mapping. The gateway owns
//! the I/O around it (HTTP through `multicc-cpr`, the SQLite observation
//! cache, single-flight). Moving the plan/result here keeps the Node napi and
//! the gateway on one implementation: `multicc_cpr::provider_host` now
//! delegates both functions to this module.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::http_gate::{query_string, query_value};
use crate::js::string::js_trim;
use crate::{provider_credentials, provider_store, subscription};

/// `ACCOUNT_ID_PATTERN`: the official-account id is 16 lowercase hex digits.
pub fn valid_account(id: &str) -> bool {
    id.len() == 16
        && id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// `String(req.query?.account || '').trim()`.
pub fn account(original_url: &str) -> String {
    let value = query_string(&query_value(original_url, "account"));
    js_trim(&value).to_string()
}

/// `~/.multicc/official-accounts`.
pub fn official_root(home: &Path) -> PathBuf {
    home.join(".multicc").join("official-accounts")
}

/// The Codex credential file the route reads: an official account's mini-home
/// when an id was given, otherwise the CLI's shared login.
pub fn codex_auth_file(home: &Path, id: &str) -> PathBuf {
    if id.is_empty() {
        home.join(".codex").join("auth.json")
    } else {
        official_root(home).join("codex").join(id).join("auth.json")
    }
}

/// The Claude official-account credential file.
pub fn claude_account_file(home: &Path, id: &str) -> PathBuf {
    official_root(home)
        .join("claude")
        .join(format!("{id}.json"))
}

/// The CLI's own credential file (the non-keychain half of readCliCredentials).
pub fn cli_credentials_file(home: &Path) -> PathBuf {
    home.join(".claude").join(".credentials.json")
}

/// `deps.accounts.listClaudeAccounts().some(a => a.id === id)`.
///
/// `listClaudeAccounts` lists `<root>/claude` and keeps regular files named
/// `<16 hex>.json`; the route only asks whether this id is among them. A
/// missing or unreadable directory answers "no" like the Node catch.
pub fn claude_account_known(home: &Path, id: &str) -> bool {
    if !valid_account(id) {
        return false;
    }
    let Ok(entries) = std::fs::read_dir(official_root(home).join("claude")) else {
        return false;
    };
    entries.flatten().any(|entry| {
        let Ok(file_type) = entry.file_type() else {
            return false;
        };
        if !file_type.is_file() {
            return false;
        }
        let Ok(name) = entry.file_name().into_string() else {
            return false;
        };
        let Some(stem) = name.strip_suffix(".json") else {
            return false;
        };
        stem == id && valid_account(stem)
    })
}

fn read_object(file: &Path) -> Value {
    provider_store::read(file)
        .ok()
        .flatten()
        .filter(Value::is_object)
        .unwrap_or(Value::Null)
}

/// `credentials.peekAccountToken(id)?.token`: read-only, no renewal and no
/// account lock, with the peek margin (60s) instead of the renewal margin.
pub fn peek_claude_token(home: &Path, id: &str, now_ms: i64) -> Option<String> {
    if !valid_account(id) {
        return None;
    }
    let stored = provider_credentials::run(&json!({
        "operation": "stored",
        "data": read_object(&claude_account_file(home, id)),
    }))
    .ok()?;
    let usable = provider_credentials::run(&json!({
        "operation": "usable",
        "stored": stored,
        "margin": PEEK_MARGIN_MS,
        "now": now_ms as f64,
    }))
    .ok()?;
    usable["token"].as_str().map(str::to_string)
}

/// A peek is allowed to hand out a token this close to expiry.
pub const PEEK_MARGIN_MS: i64 = 60_000;

/// The route's own check on the CLI credential: `ok` and not expired.
/// `expiresAt == null` is accepted (the route never required an expiry).
pub fn global_claude_token(read: &Value, now_ms: i64) -> Option<String> {
    if read["ok"] != true {
        return None;
    }
    let expires = read["expiresAt"].as_f64();
    if expires.is_some_and(|at| at <= now_ms as f64) {
        return None;
    }
    read["accessToken"].as_str().map(str::to_string)
}

/// `subscription_plan`: the request the host would send for an account.
///
/// Codex reads its own `auth.json` (the mini-home or the CLI's login) for the
/// bearer token, `ChatGPT-Account-Id` and the login-time fallback subscription.
/// Claude takes an already-peeked token. An absent token is `no_auth`, not an
/// error, and is the only case that answers before a URL exists.
pub fn plan(vendor: &str, auth_file: &Path, token: &str) -> Result<Value, String> {
    let mut headers = json!({"Accept":"application/json"});
    let (url, token, fallback) = match vendor {
        "codex" => {
            let auth = provider_credentials::run(&json!({
                "operation": "codexAuth",
                "file": auth_file.to_string_lossy(),
            }))?;
            if auth.is_null() {
                return Ok(json!({"result":{"status":"no_auth"}}));
            }
            headers["ChatGPT-Account-Id"] = auth["accountId"].clone();
            headers["originator"] = json!("codex_cli_rs");
            (
                "https://chatgpt.com/backend-api/wham/usage",
                auth["accessToken"].as_str().unwrap_or("").to_string(),
                auth["subscription"].clone(),
            )
        }
        "claude" => {
            headers["Accept"] = json!("application/json, text/plain, */*");
            headers["User-Agent"] = json!("axios/1.15.2");
            headers["Cache-Control"] = json!("no-cache");
            (
                "https://api.anthropic.com/api/oauth/profile",
                token.to_string(),
                Value::Null,
            )
        }
        _ => return Err("SUBSCRIPTION_INVALID_VENDOR".into()),
    };
    if token.is_empty() {
        return Ok(json!({"result":{"status":"no_auth"}}));
    }
    headers["Authorization"] = json!(format!("Bearer {token}"));
    Ok(json!({"vendor":vendor,"url":url,"headers":headers,"fallback":fallback}))
}

/// `subscription_result`: map one HTTP answer onto the public DTO.
///
/// 401 is `no_auth`; any other non-2xx, and any 2xx whose body is not a JSON
/// object (invalid JSON arrives here as null), is `unavailable`. Codex carries
/// its login-time subscription as a stale fallback; Claude has none.
pub fn result(input: &Value) -> Value {
    let plan = &input["plan"];
    let status = input["status"].as_u64().unwrap_or(0);
    if status == 401 {
        return json!({"status":"no_auth"});
    }
    if !(200..300).contains(&status) || !input["body"].is_object() {
        return if plan["vendor"] == "codex" {
            json!({"status":"unavailable","subscription":plan["fallback"],"stale":true})
        } else {
            json!({"status":"unavailable"})
        };
    }
    let parsed = subscription::parse(
        &json!({"body":input["body"],"source":if plan["vendor"] == "codex" {"usage"} else {"profile"},
        "observedAt":input["now"]})
        .to_string(),
    )
    .ok()
    .and_then(|s| serde_json::from_str::<Value>(&s).ok())
    .unwrap_or(Value::Null);
    json!({"status":"ok","subscription":if parsed.is_null() {plan["fallback"].clone()} else {parsed}})
}

#[cfg(test)]
mod tests;
