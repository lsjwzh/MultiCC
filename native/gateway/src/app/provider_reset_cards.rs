//! Read-only reset-credit inventory for a single official provider. The caller
//! must explicitly request it; no background Claude usage polling is added.
use super::{
    aux_transport,
    express::{self, RequestCtx},
    provider_balance, provider_balance_adapters,
};
use axum::{body::Body, http::Response};
use chrono::DateTime;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
use tokio::sync::Mutex as AsyncMutex;

const TTL: Duration = Duration::from_secs(60);
type Slot = Arc<AsyncMutex<Option<(Instant, Value)>>>;
fn slots() -> &'static Mutex<HashMap<String, Slot>> {
    static SLOTS: OnceLock<Mutex<HashMap<String, Slot>>> = OnceLock::new();
    SLOTS.get_or_init(Default::default)
}
fn date(v: Option<&Value>) -> Result<Option<i64>, ()> {
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => DateTime::parse_from_rfc3339(s)
            .map(|d| Some(d.timestamp_millis()))
            .map_err(|_| ()),
        _ => Err(()),
    }
}
// Unknown/malformed inventories are not reported as zero. Only public display
// fields leave this module; reset IDs and redemption handles remain private.
fn inventory(vendor: &str, body: &Value, now: i64) -> Option<Value> {
    let mut cards = Vec::new();
    let mut reported_count = None;
    if vendor == "codex" {
        let entries = body.get("credits")?.as_array()?;
        let count = body.get("available_count")?.as_u64()?;
        if entries.len() > 200 || count > 200 {
            return None;
        }
        reported_count = Some(count);
        for entry in entries {
            let status = entry.get("status")?.as_str()?;
            if status != "available" {
                continue;
            }
            let end = date(entry.get("expires_at")).ok()?;
            if end.is_some_and(|d| d <= now) {
                continue;
            }
            cards.push(json!({"count":1,"expiresAt":end}));
        }
    } else {
        let block = body.get("cedar_ember")?;
        if !block.get("eligible")?.as_bool()? {
            return None;
        }
        let entries = block.get("grants")?.as_array()?;
        if entries.len() > 200 {
            return None;
        }
        for entry in entries {
            let count = entry.get("resets_left")?.as_u64()?;
            if count > 50 {
                return None;
            }
            if entry
                .get("paused")
                .is_some_and(|p| !p.is_null() && !p.is_boolean())
            {
                return None;
            }
            let start = date(entry.get("starts_at")).ok()?;
            let end = date(entry.get("ends_at")).ok()?;
            if count == 0
                || entry["paused"] == true
                || start.is_some_and(|d| d > now)
                || end.is_some_and(|d| d <= now)
            {
                continue;
            }
            cards.push(json!({"count":count,"expiresAt":end}));
        }
    }
    let total: u64 = cards.iter().filter_map(|c| c["count"].as_u64()).sum();
    if total > 200 || reported_count.is_some_and(|count| count != total) {
        return None;
    }
    cards.sort_by_key(|c| c["expiresAt"].as_i64().unwrap_or(i64::MAX));
    Some(json!({"ok":true,"count":total,"cards":cards,"fetchedAt":now}))
}
async fn claude_agent() -> Option<String> {
    let binary = crate::cli_bin::resolve_claude_bin();
    let output = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::process::Command::new(binary)
            .arg("--version")
            .kill_on_drop(true)
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    if !output.status.success() || output.stdout.len() > 4096 {
        return None;
    }
    let text = std::str::from_utf8(&output.stdout).ok()?;
    let v = text.split_whitespace().next()?;
    if v.len() > 40
        || v.split('.').count() < 2
        || !v
            .split('.')
            .all(|p| !p.is_empty() && p.bytes().all(|c| c.is_ascii_digit()))
    {
        return None;
    }
    Some(format!("claude-cli/{v} (external, cli)"))
}
async fn query(port: u16, vendor: &str, id: &str) -> Value {
    let fail = || json!({"ok":false,"reason":"unavailable"});
    let facts =
        match provider_balance::host(port, json!({"op":"facts","appType":vendor,"id":id})).await {
            Ok(v) => v,
            Err(_) => return fail(),
        };
    let target = &facts["target"];
    if facts["found"] != true
        || facts["provider"]["virtual"] == true
        || target["strategy"] != format!("{vendor}-oauth-usage")
    {
        return fail();
    }
    let binding = match multicc_core::egress_plugin::parse_egress_binding(
        facts["provider"].get("egressBinding"),
    ) {
        Ok(v) => v,
        Err(_) => return fail(),
    };
    let mut builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(12));
    if let Some(binding) = binding {
        let proxy = match crate::egress_runtime::resolve_egress_proxy_url(&binding).await {
            Ok(p) => p,
            Err(_) => return fail(),
        };
        builder = match reqwest::Proxy::all(proxy) {
            Ok(p) => builder.proxy(p),
            Err(_) => return fail(),
        };
    }
    let client = match builder.build() {
        Ok(c) => c,
        Err(_) => return fail(),
    };
    let allowed = multicc_core::provider_writes::normalize_egress_ip_allowlist(
        facts["provider"].get("egressIpAllowlist"),
    );
    if aux_transport::verify_exit(
        &client,
        &allowed,
        &["https://checkip.amazonaws.com", "https://icanhazip.com"],
    )
    .await
    .is_err()
    {
        return fail();
    }
    let agent = if vendor == "claude" {
        match claude_agent().await {
            Some(v) => v,
            None => return fail(),
        }
    } else {
        "MultiCC".into()
    };
    let auth = match provider_balance_adapters::credentials(port, target).await {
        Ok(v) => v,
        Err(_) => return fail(),
    };
    let Some(token) = auth["accessToken"].as_str().filter(|s| !s.is_empty()) else {
        return fail();
    };
    let url = if vendor == "claude" {
        "https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1"
    } else {
        "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits"
    };
    let mut req = client
        .get(url)
        .bearer_auth(token)
        .header("Accept", "application/json")
        .header("User-Agent", agent);
    if vendor == "claude" {
        req = req
            .header("anthropic-beta", "oauth-2025-04-20")
            .header("x-app", "cli");
    } else {
        req = req
            .header("OpenAI-Beta", "codex-1")
            .header("originator", "Codex Desktop");
        if let Some(account) = auth["accountId"].as_str().filter(|s| !s.is_empty()) {
            req = req.header("ChatGPT-Account-Id", account);
        }
    }
    let mut res = match req.send().await {
        Ok(r) if r.status().is_success() => r,
        _ => return fail(),
    };
    let mut bytes = Vec::new();
    loop {
        match res.chunk().await {
            Ok(Some(chunk)) if bytes.len() + chunk.len() <= 1024 * 1024 => {
                bytes.extend_from_slice(&chunk)
            }
            Ok(None) => break,
            _ => return fail(),
        }
    }
    let body: Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(_) => return fail(),
    };
    inventory(vendor, &body, super::now_ms()).unwrap_or_else(fail)
}
pub(super) async fn handle(ctx: &RequestCtx, port: u16) -> Response<Body> {
    let parts: Vec<_> = ctx.path.trim_end_matches('/').split('/').collect();
    let vendor = parts
        .get(3)
        .and_then(|s| super::download::decode_uri_component(s));
    let id = parts
        .get(4)
        .and_then(|s| super::download::decode_uri_component(s));
    let (Some(vendor), Some(id)) = (vendor, id) else {
        return express::error(ctx, 400, "invalid provider");
    };
    if !matches!(vendor.as_str(), "claude" | "codex") || id.is_empty() || id.len() > 200 {
        return express::error(ctx, 400, "invalid provider");
    }
    let key = format!("{port}:{vendor}:{id}");
    let slot = {
        let mut all = slots().lock().unwrap_or_else(|e| e.into_inner());
        if all.len() >= 512 && !all.contains_key(&key) {
            all.retain(|_, slot| {
                Arc::strong_count(slot) > 1
                    || slot.try_lock().map_or(true, |state| {
                        state.as_ref().is_some_and(|(at, _)| at.elapsed() < TTL)
                    })
            });
        }
        if all.len() >= 512 && !all.contains_key(&key) {
            None
        } else {
            Some(all.entry(key).or_default().clone())
        }
    };
    let Some(slot) = slot else {
        return express::json(
            ctx,
            429,
            &json!({"ok":false,"reason":"busy"}),
            &[("Cache-Control", "no-store")],
        );
    };
    let mut state = slot.lock().await;
    let answer = if let Some((at, value)) = &*state {
        if at.elapsed() < TTL {
            Some(value.clone())
        } else {
            None
        }
    } else {
        None
    };
    let result = match answer {
        Some(v) => v,
        None => {
            let v = query(port, &vendor, &id).await;
            *state = Some((Instant::now(), v.clone()));
            v
        }
    };
    express::json(ctx, 200, &result, &[("Cache-Control", "no-store")])
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn route_only_allows_explicit_post() {
        use axum::http::Method;
        let path = "/api/providers/claude/claude-official/reset-cards";
        assert_eq!(
            provider_balance::claim(&Method::POST, path),
            Some(provider_balance::Route::ResetCards)
        );
        assert_eq!(provider_balance::claim(&Method::GET, path), None);
        assert_eq!(
            provider_balance::claim(&Method::OPTIONS, path),
            Some(provider_balance::Route::ResetCardsOptions)
        );
    }
    #[test]
    fn inventories_do_not_confuse_unknown_and_zero_or_include_expired() {
        let now = 1_800_000_000_000;
        assert!(inventory("codex", &json!({}), now).is_none());
        assert_eq!(
            inventory("codex", &json!({"credits":[],"available_count":0}), now).unwrap()["count"],
            0
        );
        let result = inventory("codex", &json!({"available_count":1,"credits":[{"status":"available","expires_at":"2030-01-01T00:00:00Z"},{"status":"redeemed"},{"status":"available","expires_at":"2020-01-01T00:00:00Z"}]}), now).unwrap();
        assert_eq!(result["count"], 1);
        assert!(inventory(
            "codex",
            &json!({"available_count":1,"credits":[{"status":"unrecognized"}]}),
            now
        )
        .is_none());
        assert!(inventory(
            "claude",
            &json!({"cedar_ember":{"eligible":false,"grants":[]}}),
            now
        )
        .is_none());
        let result = inventory("claude", &json!({"cedar_ember":{"eligible":true,"grants":[{"resets_left":2,"ends_at":"2030-01-01T00:00:00Z"},{"resets_left":1,"paused":true}]}}), now).unwrap();
        assert_eq!(result["count"], 2);
        assert_eq!(result["cards"][0]["count"], 2);
        assert!(inventory(
            "claude",
            &json!({"cedar_ember":{"eligible":true,"grants":[{"resets_left":"?"}]}}),
            now
        )
        .is_none());
    }
}
