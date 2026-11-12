//! 供应商余额与借道余量入口。查询、并发合并、失败回退在 Rust；宿主仅提供
//! provider store/凭据事实与缓存记录/通知副作用。展示直接调用共享内核。
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, OnceLock};

use axum::body::Body;
use axum::http::{Method, Response};
use multicc_core::http_gate::{query_param, QueryParam};
use serde_json::{json, Value};
use tokio::sync::watch;

use super::express::{self, RequestCtx};
use super::{provider_balance_adapters as adapters, App};
use crate::host_port;

pub const HOST_PATH: &str = "/api/__host/provider-balance";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Route {
    All,
    One,
    ClaudeRelay,
    CodexRelay,
    AllOptions,
    OneOptions,
    ClaudeRelayOptions,
    CodexRelayOptions,
}

pub fn is_relay(route: Route) -> bool {
    matches!(
        route,
        Route::ClaudeRelay
            | Route::CodexRelay
            | Route::ClaudeRelayOptions
            | Route::CodexRelayOptions
    )
}

fn parts(path: &str) -> Vec<&str> {
    path.strip_suffix('/')
        .unwrap_or(path)
        .split('/')
        .skip(1)
        .collect()
}

pub fn claim(method: &Method, path: &str) -> Option<Route> {
    let p = parts(path);
    if p.iter().any(|s| s.is_empty()) {
        return None;
    }
    let candidate = match p.as_slice() {
        ["api", providers, balances]
            if providers.eq_ignore_ascii_case("providers")
                && balances.eq_ignore_ascii_case("balances") =>
        {
            (Route::All, Route::AllOptions)
        }
        ["api", providers, _, _, balance]
            if providers.eq_ignore_ascii_case("providers")
                && balance.eq_ignore_ascii_case("balance") =>
        {
            (Route::One, Route::OneOptions)
        }
        [proxy, _, remote, quota]
            if proxy.eq_ignore_ascii_case("claude-proxy")
                && remote.eq_ignore_ascii_case("remote")
                && quota.eq_ignore_ascii_case("quota") =>
        {
            (Route::ClaudeRelay, Route::ClaudeRelayOptions)
        }
        [proxy, _, quota]
            if proxy.eq_ignore_ascii_case("codex-proxy") && quota.eq_ignore_ascii_case("quota") =>
        {
            (Route::CodexRelay, Route::CodexRelayOptions)
        }
        _ => return None,
    };
    match method.as_str() {
        "GET" | "HEAD" => Some(candidate.0),
        "POST" if is_relay(candidate.0) => Some(candidate.0),
        "OPTIONS" => Some(candidate.1),
        _ => None,
    }
}

async fn host(port: u16, payload: Value) -> Result<Value, String> {
    let value = host_port::call(port, HOST_PATH, &payload)
        .await
        .map_err(|_| "provider balance host unavailable".to_string())?;
    if value["ok"] == true {
        Ok(value)
    } else {
        Err(value["detail"]
            .as_str()
            .unwrap_or("provider balance host failed")
            .to_string())
    }
}

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}
fn has_ago(text: &str) -> bool {
    text.split("{ago:").skip(1).any(|part| {
        part.split_once('}')
            .is_some_and(|(n, _)| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
    })
}

fn stale_fallback(
    entry: &Value,
    app_type: &str,
    id: &str,
    strategy: &str,
    detail: Option<&str>,
) -> Option<Value> {
    if !matches!(text(&entry["summary"]["kind"]), "balance" | "window") {
        return None;
    }
    let bar_text = entry["barText"].as_str()?.trim();
    if bar_text.is_empty() {
        return None;
    }
    // Number(null) === 0 in the old cache path; missing/non-numeric stays null.
    let fetched_at = match entry.get("fetchedAt") {
        Some(Value::Null) => Some(0.0),
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => {
            if s.trim().is_empty() {
                Some(0.0)
            } else {
                s.parse().ok()
            }
        }
        Some(Value::Bool(b)) => Some(if *b { 1.0 } else { 0.0 }),
        _ => None,
    }
    .filter(|n| n.is_finite());
    let stamp = match fetched_at {
        Some(at) if !has_ago(bar_text) => format!(" · 上次同步 {{ago:{at}}}"),
        _ => String::new(),
    };
    let suffix = detail
        .filter(|s| !s.is_empty())
        .map(|s| format!("（{s}）"))
        .unwrap_or_default();
    let mut result = json!({ "ok": true, "dto": entry["summary"],
        "bar": { "text": format!("{bar_text}{stamp}"), "color": "#8b949e", "title": format!("实时查询失败，这是最近一次成功同步的余量，点击重试{suffix}"), "action": null },
        "fetchedAt": fetched_at, "cached": true, "stale": true, "providerId": id, "appType": app_type, "strategy": strategy });
    if let Some(detail) = detail.filter(|s| !s.is_empty()) {
        result["detail"] = json!(detail);
    }
    Some(result)
}

async fn cached(port: u16, app_type: &str, id: &str) -> Result<Value, String> {
    host(
        port,
        json!({ "op":"cached", "appType":app_type, "id":id, "now":super::now_ms() }),
    )
    .await
}

type Pending = watch::Receiver<Option<Value>>;
type Flights = Mutex<HashMap<String, Pending>>;
struct FlightGuard(String);
impl Drop for FlightGuard {
    fn drop(&mut self) {
        flights()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.0);
    }
}

fn flights() -> &'static Flights {
    static FLIGHTS: OnceLock<Flights> = OnceLock::new();
    FLIGHTS.get_or_init(|| Mutex::new(HashMap::new()))
}

// 每个实际查询独立任务持有生命周期；HTTP 客户端断开不会留下永不完成的去重项。
fn query_one(
    app: Arc<App>,
    port: u16,
    app_type: String,
    id: String,
    allow_cached: bool,
) -> Pin<Box<dyn Future<Output = Value> + Send>> {
    Box::pin(async move {
        let key = format!("{port}:{allow_cached}:{app_type}:{id}");
        let mut receiver = {
            let mut pending = flights().lock().unwrap_or_else(|e| e.into_inner());
            if let Some(existing) = pending.get(&key) {
                existing.clone()
            } else {
                let (sender, receiver) = watch::channel(None);
                pending.insert(key.clone(), receiver.clone());
                tokio::spawn(async move {
                    let _guard = FlightGuard(key);
                    let result = fetch_one(app, port, app_type, id, allow_cached)
                        .await
                        .unwrap_or(Value::Null);
                    sender.send_replace(Some(result));
                });
                receiver
            }
        };
        loop {
            if let Some(value) = receiver.borrow().clone() {
                return value;
            }
            if receiver.changed().await.is_err() {
                return Value::Null;
            }
        }
    })
}

async fn fetch_one(
    app: Arc<App>,
    port: u16,
    app_type: String,
    id: String,
    allow_cached: bool,
) -> Result<Value, String> {
    let facts = host(port, json!({ "op":"facts", "appType":app_type, "id":id })).await?;
    if facts["found"] != true {
        return Ok(json!({ "ok":false, "reason":"not_found" }));
    }
    let actual_type = text(&facts["provider"]["appType"]);
    if facts["provider"]["virtual"] == true {
        let selected = host(
            port,
            json!({ "op":"virtualMember", "appType":app_type, "id":id }),
        )
        .await?;
        if selected["member"].is_null() {
            return Ok(
                json!({ "ok":false, "reason":"no_available_member", "providerId":id, "appType":actual_type, "virtual":true }),
            );
        }
        let result = query_one(
            app,
            port,
            text(&selected["member"]["appType"]).to_string(),
            text(&selected["member"]["id"]).to_string(),
            allow_cached,
        )
        .await;
        let mut result = result.as_object().cloned().unwrap_or_default();
        result.insert("providerId".into(), json!(id));
        result.insert("virtual".into(), json!(true));
        result.insert("quotaScope".into(), json!("current_member"));
        return Ok(Value::Object(result));
    }
    let target = &facts["target"];
    let strategy = text(&target["strategy"]);
    if !adapters::supported(strategy) {
        return Ok(
            json!({ "ok":false, "reason":"unsupported", "providerId":id, "appType":actual_type }),
        );
    }
    let (dto, detail) = if facts["egress"]["allowed"] == false {
        (None, facts["egress"]["detail"].as_str().map(str::to_string))
    } else {
        match adapters::poll(&app, target, super::now_ms(), port).await {
            Ok(dto) => (dto, None),
            Err(detail) => (None, Some(detail.chars().take(300).collect::<String>())),
        }
    };
    let Some(mut dto) = dto else {
        let mut failure = json!({ "ok":false, "reason":"fetch_failed", "providerId":id, "appType":actual_type, "strategy":strategy });
        if let Some(detail) = detail.as_deref().filter(|s| !s.is_empty()) {
            failure["detail"] = json!(detail);
        }
        let _ = host(port, json!({ "op":"record", "appType":actual_type, "id":id, "result":failure, "now":super::now_ms() })).await;
        if allow_cached {
            if let Ok(answer) = cached(port, actual_type, &id).await {
                if let Some(fallback) = stale_fallback(
                    &answer["entry"],
                    actual_type,
                    &id,
                    strategy,
                    detail.as_deref(),
                ) {
                    return Ok(fallback);
                }
            }
        }
        return Ok(failure);
    };
    let fetched_at = super::now_ms();
    dto["fetchedAt"] = json!(fetched_at);
    let bar = multicc_core::js::to_serde(&multicc_core::quota_bar_view::provider_balance(
        &multicc_core::js::JsValue::string(strategy),
        &multicc_core::js::from_serde(&dto),
        &multicc_core::js::JsValue::Number(fetched_at as f64),
        super::now_ms() as f64,
    ));
    let mut success = json!({ "ok":true, "providerId":id, "appType":actual_type, "strategy":strategy, "dto":dto, "bar":bar, "fetchedAt":fetched_at });
    if let Ok(recorded) = host(port, json!({ "op":"record", "appType":actual_type, "id":id, "result":success, "now":fetched_at })).await {
        if !recorded["snapshot"].is_null() { success["snapshot"] = recorded["snapshot"].clone(); }
    }
    Ok(success)
}

async fn query_all(app: &Arc<App>, port: u16) -> Result<Value, String> {
    let answer = host(port, json!({ "op":"list" })).await?;
    let providers = answer["providers"]
        .as_array()
        .ok_or("provider list unavailable")?;
    let mut tasks = tokio::task::JoinSet::new();
    for (index, provider) in providers.iter().enumerate() {
        let app = app.clone();
        let provider = provider.clone();
        tasks.spawn(async move {
            let result = query_one(
                app,
                port,
                text(&provider["appType"]).into(),
                text(&provider["id"]).into(),
                true,
            )
            .await;
            let mut row = serde_json::Map::new();
            row.insert("name".into(), provider["name"].clone());
            if let Some(result) = result.as_object() {
                row.extend(result.clone());
            }
            (index, Value::Object(row))
        });
    }
    let mut rows = vec![Value::Null; providers.len()];
    while let Some(result) = tasks.join_next().await {
        let (index, value) = result.map_err(|_| "provider balance task failed")?;
        rows[index] = value;
    }
    Ok(json!({ "ok":true, "results":rows }))
}

pub async fn handle(app: &Arc<App>, route: Route, ctx: &RequestCtx, port: u16) -> Response<Body> {
    match route {
        Route::AllOptions | Route::OneOptions => return super::options(ctx, "GET,HEAD"),
        Route::ClaudeRelayOptions | Route::CodexRelayOptions => {
            return super::options(ctx, "GET,HEAD,POST")
        }
        _ => {}
    }
    let relay = is_relay(route);
    let headers: &[(&str, &str)] = if relay {
        &[("Cache-Control", "no-store")]
    } else {
        &[]
    };
    let result = if route == Route::All {
        query_all(app, port).await
    } else {
        let p = parts(&ctx.path);
        let (app_type, id) = match route {
            Route::ClaudeRelay => (
                Some("claude".into()),
                super::download::decode_uri_component(p[1]),
            ),
            Route::CodexRelay => (
                Some("codex".into()),
                super::download::decode_uri_component(p[1]),
            ),
            _ => (
                super::download::decode_uri_component(p[2]),
                super::download::decode_uri_component(p[3]),
            ),
        };
        let (Some(app_type), Some(id)) = (app_type, id) else {
            return express::error(ctx, 400, "Failed to decode param");
        };
        if !relay
            && matches!(query_param(&ctx.original_url, "cached"), QueryParam::Text(value) if value == "1")
        {
            cached(port, &app_type, &id).await.map(|answer| {
                if answer["found"] != true {
                    json!({ "ok":false, "reason":"not_found" })
                } else if let Some(mut snapshot) = answer["snapshot"].as_object().cloned() {
                    snapshot.insert("cached".into(), json!(true));
                    Value::Object(snapshot)
                } else {
                    json!({ "ok":false, "reason":"no_cached_limit" })
                }
            })
        } else {
            Ok(query_one(app.clone(), port, app_type, id, !relay).await)
        }
    };
    match result {
        Ok(result) if !result.is_null() || relay => {
            let status = if result["reason"] == "not_found" {
                404
            } else {
                200
            };
            express::json(ctx, status, &result, headers)
        }
        _ => {
            let body = if relay {
                json!({ "ok":false, "reason":"fetch_failed" })
            } else {
                json!({ "ok":false, "error":if route == Route::All { "provider balances failed" } else { "provider balance failed" } })
            };
            express::json(ctx, 500, &body, headers)
        }
    }
}
