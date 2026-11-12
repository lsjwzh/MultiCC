//! Provider balance HTTP adapters. Credential reads and CLI token rotation
//! still use the host; HTTP, deadlines, retries and DTO mapping live here.

use std::time::Duration;

use multicc_core::js::serde::{js_string, js_to_number, truthy};
use multicc_core::public_safety::sanitize_public_text;
use reqwest::{Method, Url};
use serde_json::{json, Value};

use super::App;
use crate::{host_port, outbound};

const HOST: &str = "/api/__host/provider-balance";
const TIMEOUT_MS: u64 = 6000;

pub fn supported(strategy: &str) -> bool {
    matches!(
        strategy,
        "glm-monitor"
            | "deepseek-balance"
            | "kimi-balance"
            | "relay-quota"
            | "codex-oauth-usage"
            | "claude-oauth-usage"
    )
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}

// Preserve Number(null) while distinguishing an absent JS property.
fn finite(value: Option<&Value>) -> Option<f64> {
    let number = js_to_number(value?);
    number.is_finite().then_some(number)
}

fn strict_finite(value: Option<&Value>) -> Option<f64> {
    let value = value?;
    if value.is_null() || value.as_str() == Some("") {
        return None;
    }
    finite(Some(value))
}

fn status(percent: f64) -> &'static str {
    if percent >= 100.0 {
        "rejected"
    } else if percent >= 80.0 {
        "allowed_warning"
    } else {
        "allowed"
    }
}

fn nullable(value: &Value) -> Value {
    if truthy(value) {
        value.clone()
    } else {
        Value::Null
    }
}

struct FetchError {
    status: Option<u16>,
    detail: String,
}

async fn read_json(
    app: &App,
    url: &str,
    method: Method,
    headers: Vec<(String, String)>,
    timeout_ms: u64,
) -> Result<Value, FetchError> {
    let url = Url::parse(url).map_err(|_| FetchError {
        status: None,
        detail: "invalid quota URL".into(),
    })?;
    let mut request = outbound::Request::get(url, Duration::from_millis(timeout_ms));
    request.method = method;
    request.headers = headers;
    request.follow_redirects = true;
    request.max_body = Some(4 * 1024 * 1024);
    let response = app
        .outbound
        .send(request)
        .await
        .map_err(|error| FetchError {
            status: None,
            detail: sanitize_public_text(Some(&error.message()), "quota transport failed"),
        })?;
    if !(200..300).contains(&response.status) {
        let snippet = response
            .text()
            .chars()
            .take(200)
            .collect::<String>()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        let detail = format!("HTTP {} {}", response.status, snippet);
        return Err(FetchError {
            status: Some(response.status),
            detail: sanitize_public_text(Some(detail.trim()), &format!("HTTP {}", response.status)),
        });
    }
    serde_json::from_slice(&response.body).map_err(|_| FetchError {
        status: Some(response.status),
        detail: "invalid JSON response".into(),
    })
}

fn bearer(token: &str) -> Vec<(String, String)> {
    vec![("Authorization".into(), format!("Bearer {token}"))]
}

async fn credentials(host: u16, target: &Value) -> Result<Value, String> {
    let result = host_port::call(host, HOST, &json!({"op":"credentials","target":target}))
        .await
        .map_err(|_| "quota credential runtime unavailable".to_string())?;
    if result["ok"] != true {
        return Err(sanitize_public_text(
            result["detail"].as_str(),
            "quota credential unavailable",
        ));
    }
    Ok(result["auth"].clone())
}

pub async fn poll(
    app: &App,
    target: &Value,
    now_ms: i64,
    host_port_num: u16,
) -> Result<Option<Value>, String> {
    let strategy = text(target, "strategy");
    let host = text(target, "host");
    let key = text(target, "apiKey");
    match strategy {
        "glm-monitor" => {
            let body = read_json(
                app,
                &format!("https://{host}/api/monitor/usage/quota/limit"),
                Method::GET,
                vec![
                    ("Authorization".into(), key.into()),
                    ("Content-Type".into(), "application/json".into()),
                ],
                TIMEOUT_MS,
            )
            .await
            .map_err(|error| error.detail)?;
            Ok(glm_dto(&body))
        }
        "deepseek-balance" => {
            let body = read_json(
                app,
                &format!("https://{host}/user/balance"),
                Method::GET,
                bearer(key),
                TIMEOUT_MS,
            )
            .await
            .map_err(|error| error.detail)?;
            Ok(deepseek_dto(&body))
        }
        "kimi-balance" => {
            let host = host.to_ascii_lowercase();
            let host = if host.ends_with("moonshot.cn") {
                host.as_str()
            } else {
                "api.moonshot.cn"
            };
            let body = read_json(
                app,
                &format!("https://{host}/v1/users/me/balance"),
                Method::GET,
                bearer(key),
                TIMEOUT_MS,
            )
            .await
            .map_err(|error| error.detail)?;
            kimi_dto(&body)
        }
        "relay-quota" => {
            let relay = text(target, "relayUrl").trim().trim_end_matches('/');
            if key.trim().is_empty()
                || !Url::parse(relay).is_ok_and(|url| matches!(url.scheme(), "http" | "https"))
            {
                return Ok(None);
            }
            let body = read_json(
                app,
                &format!("{relay}/quota"),
                Method::POST,
                bearer(key.trim()),
                20_000,
            )
            .await
            .map_err(|error| error.detail)?;
            relay_dto(&body)
        }
        "codex-oauth-usage" => {
            let mut auth = credentials(host_port_num, target).await?;
            if auth.is_null() {
                return Ok(None);
            }
            for attempt in 0..2 {
                let mut headers = bearer(text(&auth, "accessToken"));
                headers.extend([
                    ("ChatGPT-Account-Id".into(), text(&auth, "accountId").into()),
                    ("originator".into(), "codex_cli_rs".into()),
                    ("Accept".into(), "application/json".into()),
                ]);
                match read_json(
                    app,
                    "https://chatgpt.com/backend-api/wham/usage",
                    Method::GET,
                    headers,
                    TIMEOUT_MS,
                )
                .await
                {
                    Ok(body) => return Ok(codex_dto(&body, now_ms)),
                    Err(error) => {
                        if attempt != 0 || !matches!(error.status, Some(401 | 403)) {
                            return Err(error.detail);
                        }
                        let refreshed = host_port::call(
                            host_port_num,
                            HOST,
                            &json!({"op":"refreshCodexAuth","target":target}),
                        )
                        .await;
                        if !refreshed
                            .is_ok_and(|value| value["ok"] == true && value["refreshed"] == true)
                        {
                            return Err(error.detail);
                        }
                        auth = credentials(host_port_num, target).await?;
                        if auth.is_null() {
                            return Ok(None);
                        }
                    }
                }
            }
            Ok(None)
        }
        "claude-oauth-usage" => {
            let auth = credentials(host_port_num, target).await?;
            if text(&auth, "accessToken").is_empty() {
                return Err("Claude quota credential unavailable".into());
            }
            let mut headers = bearer(text(&auth, "accessToken"));
            headers.extend([
                ("Accept".into(), "application/json, text/plain, */*".into()),
                ("User-Agent".into(), "axios/1.15.2".into()),
                ("anthropic-beta".into(), "oauth-2025-04-20".into()),
                ("Cache-Control".into(), "no-cache".into()),
            ]);
            let body = read_json(
                app,
                "https://api.anthropic.com/api/oauth/usage",
                Method::GET,
                headers,
                30_000,
            )
            .await
            .map_err(|error| error.detail)?;
            Ok(claude_dto(&body))
        }
        _ => Ok(None),
    }
}

fn glm_dto(body: &Value) -> Option<Value> {
    let limits = body["data"]["limits"].as_array()?;
    let windows: Vec<_> = limits
        .iter()
        .filter(|entry| {
            entry["type"] == "TOKENS_LIMIT" && finite(entry.get("percentage")).is_some()
        })
        .collect();
    let first = windows.first()?;
    let pct = finite(first.get("percentage"))?;
    let weekly = windows.get(1);
    Some(
        json!({"kind":"window","provider":"glm","rateLimitType":"five_hour",
        "status":status(pct),"utilization":(pct/100.0).clamp(0.0,1.0),
        "resetsAt":finite(first.get("nextResetTime")),
        "weeklyUtilization":weekly.and_then(|entry| finite(entry.get("percentage"))).map(|n|(n/100.0).clamp(0.0,1.0)),
        "weeklyResetsAt":weekly.and_then(|entry| finite(entry.get("nextResetTime"))),
        "tier":nullable(&body["data"]["level"])}),
    )
}

fn deepseek_dto(body: &Value) -> Option<Value> {
    let infos = body["balance_infos"].as_array()?;
    let info = infos.first().unwrap_or(&Value::Null);
    Some(
        json!({"kind":"balance","available":body["is_available"] == true,
        "currency":nullable(&info["currency"]),"total":finite(info.get("total_balance")),
        "granted":finite(info.get("granted_balance")),"toppedUp":finite(info.get("topped_up_balance"))}),
    )
}

fn kimi_dto(body: &Value) -> Result<Option<Value>, String> {
    let data = &body["data"];
    if !data.is_object() {
        return Err("kimi balance fetch failed: bad_shape (HTTP 200)".into());
    }
    let available = finite(data.get("available_balance"));
    let voucher = finite(data.get("voucher_balance"));
    let cash = finite(data.get("cash_balance"));
    if available.is_none() && voucher.is_none() && cash.is_none() {
        return Err("kimi balance fetch failed: no_balance_fields (HTTP 200)".into());
    }
    Ok(available.map(|available| {
        json!({"kind":"balance","available":available,
        "voucher":voucher,"cash":cash,"currency":"CNY"})
    }))
}

fn relay_dto(body: &Value) -> Result<Option<Value>, String> {
    if body["ok"] != true {
        for field in ["detail", "reason"] {
            if truthy(&body[field]) {
                let value = js_string(&body[field]);
                let value = if field == "reason" {
                    value.chars().take(100).collect()
                } else {
                    value
                };
                return Err(sanitize_public_text(
                    Some(&format!("lender: {value}")),
                    "lender quota fetch failed",
                ));
            }
        }
        return Ok(None);
    }
    let dto = &body["dto"];
    let valid = match text(dto, "kind") {
        "window" => dto["utilization"].as_f64().is_some_and(f64::is_finite),
        "balance" => dto["available"].is_boolean() || dto["available"].is_number(),
        _ => false,
    };
    Ok(valid.then(|| dto.clone()))
}

fn codex_dto(body: &Value, now_ms: i64) -> Option<Value> {
    let limit = &body["rate_limit"];
    let mut windows = Vec::new();
    for key in ["primary_window", "secondary_window"] {
        let window = &limit[key];
        let (Some(used), Some(seconds)) = (
            strict_finite(window.get("used_percent")),
            strict_finite(window.get("limit_window_seconds")),
        ) else {
            continue;
        };
        if seconds <= 0.0 {
            continue;
        }
        let resets = strict_finite(window.get("reset_at")).or_else(|| {
            strict_finite(window.get("reset_after_seconds"))
                .map(|after| (now_ms / 1000) as f64 + after)
        });
        let label = if seconds >= 28.0 * 86400.0 {
            "1m"
        } else if seconds >= 86400.0 {
            "1wk"
        } else {
            "5h"
        };
        windows.push((seconds, json!({"window":label,"label":label,"usedPercent":used,"resetMs":resets.map(|n|n*1000.0)}), resets));
    }
    windows.sort_by(|a, b| a.0.total_cmp(&b.0));
    let headline = windows
        .iter()
        .find(|(_, window, _)| window["window"] == "1wk")
        .or_else(|| windows.last())?;
    let worst = windows
        .iter()
        .map(|(_, w, _)| w["usedPercent"].as_f64().unwrap_or(0.0))
        .fold(f64::NEG_INFINITY, f64::max);
    Some(json!({"kind":"window","provider":"codex",
        "rateLimitType":if headline.1["window"] == "5h" {"five_hour"} else {"weekly"},
        "status":if limit["limit_reached"] == true {"rejected"} else {status(worst)},
        "utilization":(headline.1["usedPercent"].as_f64().unwrap_or(0.0)/100.0).clamp(0.0,1.0),
        "resetsAt":headline.2,"tier":body["plan_type"].as_str(),
        "windows":windows.iter().map(|(_,w,_)|w).collect::<Vec<_>>()}))
}

fn claude_dto(body: &Value) -> Option<Value> {
    let mut windows = Vec::new();
    for (key, window, label, kind) in [
        ("five_hour", "5h", "Current session", "session"),
        ("seven_day", "1wk", "All models", "weekly_all"),
        ("seven_day_opus", "1wk", "Opus", ""),
        ("seven_day_sonnet", "1wk", "Sonnet", ""),
    ] {
        let fallback = body["limits"].as_array().and_then(|items| {
            items.iter().rev().find(|entry| {
                !kind.is_empty()
                    && entry["kind"] == kind
                    && !entry["percent"].is_null()
                    && finite(entry.get("percent")).is_some()
            })
        });
        let raw = if let Some(limit) = fallback {
            finite(limit.get("percent"))
        } else if body[key]["utilization"].is_null() {
            None
        } else {
            finite(body[key].get("utilization"))
        };
        let Some(raw) = raw else {
            continue;
        };
        let reset = fallback
            .map(|limit| &limit["resets_at"])
            .filter(|v| truthy(v))
            .unwrap_or(&body[key]["resets_at"]);
        let reset_ms = reset
            .as_str()
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
            .map(|time| time.timestamp_millis());
        windows.push(json!({"window":window,"label":label,"usedPercent":(raw.clamp(0.0,100.0)*10.0).round()/10.0,"resetMs":reset_ms}));
    }
    let main = windows
        .iter()
        .find(|w| w["window"] == "5h")
        .or_else(|| windows.first())?;
    let worst = windows
        .iter()
        .map(|w| w["usedPercent"].as_f64().unwrap_or(0.0))
        .fold(f64::NEG_INFINITY, f64::max);
    Some(json!({"kind":"window","provider":"claude",
        "rateLimitType":if main["window"] == "5h" {"five_hour"} else {"weekly"},
        "status":status(worst),"utilization":main["usedPercent"].as_f64().unwrap_or(0.0)/100.0,
        "resetsAt":main["resetMs"].as_i64().map(|n| n as f64/1000.0),"windows":windows}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glm_ignores_call_limits_and_preserves_both_token_windows() {
        let dto = glm_dto(&json!({"data":{"level":"pro","limits":[
            {"type":"TIME_LIMIT","percentage":100},
            {"type":"TOKENS_LIMIT","percentage":"82","nextResetTime":123},
            {"type":"TOKENS_LIMIT","percentage":40,"nextResetTime":456}
        ]}}))
        .unwrap();
        assert_eq!(dto["status"], "allowed_warning");
        assert_eq!(dto["utilization"], 0.82);
        assert_eq!(dto["weeklyUtilization"], 0.4);
        assert_eq!(dto["resetsAt"], 123.0);
        assert_eq!(dto["weeklyResetsAt"], 456.0);
        assert!(glm_dto(&json!({"data":{"limits":[]}})).is_none());
    }

    #[test]
    fn monetary_balances_keep_vendor_specific_types() {
        let dto = deepseek_dto(&json!({"is_available":true,"balance_infos":[{
            "currency":"CNY","total_balance":"12.5","granted_balance":"2","topped_up_balance":"10.5"
        }]}))
        .unwrap();
        assert_eq!(dto["available"], true);
        assert_eq!(dto["total"], 12.5);
        let dto = kimi_dto(&json!({"data":{"available_balance":"12.5","voucher_balance":"2","cash_balance":"10.5"}})).unwrap().unwrap();
        assert_eq!(dto["available"], 12.5);
        assert_eq!(dto["voucher"], 2.0);
        assert!(kimi_dto(&json!({"data":{"voucher_balance":1}}))
            .unwrap()
            .is_none());
        assert!(kimi_dto(&json!({"data":{}})).is_err());
    }

    #[test]
    fn codex_classifies_by_duration_and_blocks_on_any_exhausted_window() {
        let dto = codex_dto(&json!({"plan_type":"plus","rate_limit":{
            "primary_window":{"used_percent":24,"limit_window_seconds":604800,"reset_after_seconds":60},
            "secondary_window":{"used_percent":100,"limit_window_seconds":18000,"reset_at":3000}
        }}), 1_000_000).unwrap();
        assert_eq!(dto["status"], "rejected");
        assert_eq!(dto["rateLimitType"], "weekly");
        assert_eq!(dto["utilization"], 0.24);
        assert_eq!(dto["resetsAt"], 1060.0);
        assert_eq!(dto["windows"][0]["window"], "5h");
        assert_eq!(dto["windows"][0]["resetMs"], 3_000_000.0);
        assert_eq!(dto["windows"][1]["window"], "1wk");
    }

    #[test]
    fn claude_does_not_invent_windows_for_null_utilization() {
        let dto = claude_dto(&json!({
            "five_hour":{"utilization":20,"resets_at":"2026-01-01T00:00:00Z"},
            "seven_day":{"utilization":50},"seven_day_opus":{"utilization":null},
            "limits":[{"kind":"weekly_all","percent":85}]
        }))
        .unwrap();
        assert_eq!(dto["windows"].as_array().unwrap().len(), 2);
        assert_eq!(dto["windows"][1]["usedPercent"], 85.0);
        assert_eq!(dto["utilization"], 0.2);
        assert_eq!(dto["status"], "allowed_warning");
        assert_eq!(dto["resetsAt"], 1767225600.0);
    }

    #[test]
    fn relay_accepts_only_known_dto_species_and_reports_lender_failure() {
        assert!(
            relay_dto(&json!({"ok":true,"dto":{"kind":"window","utilization":"0.5"}}))
                .unwrap()
                .is_none()
        );
        assert!(
            relay_dto(&json!({"ok":true,"dto":{"kind":"balance","available":false}}))
                .unwrap()
                .is_some()
        );
        assert_eq!(
            relay_dto(&json!({"ok":false,"reason":"unsupported"})).unwrap_err(),
            "lender: unsupported"
        );
        assert!(relay_dto(&json!({"ok":true,"dto":{"kind":"other"}}))
            .unwrap()
            .is_none());
    }
}
