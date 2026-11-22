//! Antigravity account quota from the official agy CLI. The subprocess is
//! asynchronous, bounded, single-flight and never exposes its raw output.
use super::{
    agy_catalog::executable,
    express::{self, RequestCtx},
};
use axum::{body::Body, http::Response};
use serde_json::{json, Value};
use std::{
    process::Stdio,
    sync::OnceLock,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{io::AsyncReadExt, process::Command, sync::Mutex};

const TTL: Duration = Duration::from_secs(60);
const FAIL_TTL: Duration = Duration::from_secs(30);
const MAX_OUTPUT: u64 = 1024 * 1024;
/// `None` records a failed probe, so a signed-out or offline CLI is not spawned
/// on every page load.
static CACHE: OnceLock<Mutex<Option<(Instant, Option<Value>)>>> = OnceLock::new();

fn render(data: &Value, now_ms: u64) -> Option<Value> {
    let groups = data.pointer("/command/data/groups")?.as_array()?;
    let mut rows = Vec::new();
    let mut details = Vec::new();
    let mut lowest = 100.0_f64;
    for group in groups {
        // One malformed group or bucket must not blank the whole bar: skip what
        // cannot be rendered and keep the rest.
        let Some(name) = group.get("name").and_then(Value::as_str) else {
            continue;
        };
        if name.is_empty() || name.len() > 120 || name.chars().any(char::is_control) {
            continue;
        }
        let group_name = match name {
            "Gemini Models" => "Gemini",
            "Claude and GPT models" => "Claude/GPT",
            other => other,
        };
        let Some(buckets) = group.get("buckets").and_then(Value::as_array) else {
            continue;
        };
        for bucket in buckets {
            let Some(remaining) = bucket.get("remaining_fraction").and_then(Value::as_f64) else {
                continue;
            };
            if !(0.0..=1.0).contains(&remaining) {
                continue;
            }
            let window = bucket.get("window").and_then(Value::as_str).unwrap_or("");
            let label = match window {
                "5h" => "5小时",
                "weekly" => "每周",
                _ => bucket.get("name").and_then(Value::as_str).unwrap_or("额度"),
            };
            if label.len() > 120 || label.chars().any(char::is_control) {
                continue;
            }
            let pct = (remaining * 100.0).round();
            lowest = lowest.min(pct);
            let at = bucket
                .get("reset_time")
                .and_then(Value::as_str)
                .and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok())
                .map(|v| v.timestamp_millis())
                .filter(|&v| v > 0);
            let reset = at
                .map(|at| {
                    format!(
                        " · 重置时间 {}",
                        chrono::DateTime::from_timestamp_millis(at)
                            .unwrap()
                            .with_timezone(&chrono::Local)
                            .format("%Y-%m-%d %H:%M")
                    )
                })
                .unwrap_or_default();
            rows.push(format!("{} {}剩余{:.0}%", group_name, label, pct));
            details.push(format!(
                "{} {}：剩余 {:.0}%{}",
                group_name, label, pct, reset
            ));
        }
    }
    if rows.is_empty() {
        return None;
    }
    let color = if lowest <= 10.0 {
        "#f85149"
    } else if lowest <= 30.0 {
        "#d29922"
    } else {
        "#58a6ff"
    };
    Some(json!({"status":"ok", "fetchedAt": now_ms, "bar": {
        "text": format!("反重力 · {}", rows.join(" · ")),
        "title": format!("反重力账号额度\n{}\n点击刷新", details.join("\n")),
        "color": color, "action": "refresh",
        "states": {"loading": {"text":"反重力额度查询中…", "title":"正在查询额度", "color":"#8b949e"}}
    }}))
}

async fn fetch() -> Option<Value> {
    let mut command = Command::new(executable());
    command
        .args([
            "-p",
            "/usage",
            "--output-format",
            "json",
            "--print-timeout",
            "30s",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    // The quota belongs to the signed-in account, and agy reads its login from
    // `$HOME/.gemini`, so a pinned account is served by pointing HOME at its
    // mini-home. No pin leaves the real home untouched.
    if let Some(home) = super::agy_accounts::home_override() {
        command.env("HOME", home);
    }
    let mut child = command.spawn().ok()?;
    let mut stdout = child.stdout.take()?.take(MAX_OUTPUT + 1);
    let mut bytes = Vec::new();
    stdout.read_to_end(&mut bytes).await.ok()?;
    if bytes.len() as u64 > MAX_OUTPUT || !child.wait().await.ok()?.success() {
        return None;
    }
    let data: Value = serde_json::from_slice(&bytes).ok()?;
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis() as u64;
    render(&data, now_ms)
}

fn unavailable_bar() -> Value {
    json!({"status":"unavailable", "bar":{"text":"反重力额度查询失败 · 点击重试", "title":"无法读取 agy 账号额度，请确认已登录并检查网络。", "color":"#f85149", "action":"refresh"}})
}

/// The cached bar is the previous account's quota, so an account switch must
/// drop it instead of waiting out the TTL.
pub(super) async fn invalidate() {
    if let Some(cache) = CACHE.get() {
        *cache.lock().await = None;
    }
}

pub async fn handle(ctx: &RequestCtx) -> Response<Body> {
    let mut cache = CACHE.get_or_init(|| Mutex::new(None)).lock().await;
    let force = ctx
        .original_url
        .split('?')
        .nth(1)
        .unwrap_or("")
        .split('&')
        .any(|part| part == "force=1");
    if !force {
        if let Some((when, value)) = cache.as_ref() {
            let ttl = if value.is_some() { TTL } else { FAIL_TTL };
            if when.elapsed() < ttl {
                let body = value.clone().unwrap_or_else(unavailable_bar);
                return express::json(ctx, 200, &body, &[("Cache-Control", "no-store")]);
            }
        }
    }
    let result = tokio::time::timeout(Duration::from_secs(35), fetch())
        .await
        .ok()
        .flatten();
    *cache = Some((Instant::now(), result.clone()));
    let value = result.unwrap_or_else(unavailable_bar);
    express::json(ctx, 200, &value, &[("Cache-Control", "no-store")])
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_every_bucket_and_rejects_bad_percentages() {
        let data = json!({"command":{"data":{"groups":[
            {"name":"Gemini Models","buckets":[{"window":"5h","remaining_fraction":0.42,"reset_time":"2026-11-22T12:00:00Z"},{"window":"weekly","remaining_fraction":0.8}]},
            {"name":"Claude and GPT models","buckets":[{"window":"5h","remaining_fraction":1.0,"reset_time":"1970-01-01T00:00:00Z"}]}
        ]}}});
        let v = render(&data, 123).unwrap();
        assert!(v["bar"]["text"]
            .as_str()
            .unwrap()
            .contains("Gemini 5小时剩余42%"));
        assert!(v["bar"]["text"]
            .as_str()
            .unwrap()
            .contains("Claude/GPT 5小时剩余100%"));
        assert!(!v["bar"]["title"].as_str().unwrap().contains("1970"));
        assert!(render(&json!({"command":{"data":{"groups":[{"name":"x","buckets":[{"remaining_fraction":1.2}]}]}}}),0).is_none());
    }
}
