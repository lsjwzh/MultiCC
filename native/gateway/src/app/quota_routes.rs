//! The quota & pricing route cluster retired from nine Node modules:
//!
//! * `GET|HEAD /api/pricing/status` / `GET|HEAD /api/pricing/lookup`
//! * `POST     /api/pricing/refresh` / `GET|HEAD /api/pricing/search`
//! * `GET|HEAD /api/opencode/quota` / `POST /api/opencode/quota/login`
//! * `GET|HEAD /api/qoder/quota`    / `POST /api/qoder/quota/login`
//! * `GET|HEAD /api/qoder/quota/cookies`
//! * `GET|HEAD /api/codex/quota`
//! * `GET|HEAD /api/ark/quota`      / `POST /api/ark/quota/login` / `POST /api/ark/quota/install`
//! * `GET|HEAD /api/kimi/quota`     / `POST /api/kimi/quota/login`
//! * `GET|HEAD /api/claude/quota`   / `POST /api/claude/quota/login`
//! * `GET|HEAD /api/aliyun/quota`   / `POST /api/aliyun/quota/login`
//! * `GET|HEAD /api/quota/bars/idle` / `GET|HEAD /api/quota/bars/state`
//! * `POST     /api/quota/bars/refresh`
//!
//! Path matching, query/body extraction, the Express OPTIONS answer and every
//! decision the retired handlers made over Node's answers live here; the DTO
//! envelopes, key order and status maps live in `multicc_core::quota_routes`,
//! and the bars are rendered by `multicc_core::quota_bar_view` — the same
//! kernel the Node addon exposes as `renderQuotaBar`/`claudeBar`.
//!
//! Node keeps what Rust cannot see behind one host port,
//! `POST /api/__host/quota` (src/routes/quota-host.js): the models.dev price
//! table, the managed Chrome profile and its CDP drives, `~/.codex/auth.json`
//! and the OAuth refresh hook, the arkcli subprocess and its installer, the
//! in-process quota-bar cache, the Claude usage queue and its live 5h map, and
//! the `recordVendor`/`recordClaude` limit-cache writers.
//!
//! Every POST is a state-changing action (a price refresh, a login window, an
//! installer, a bar refresh that records into the shared cache), so
//! [`App::quota_write`] serializes them the way the single Node event-loop
//! thread did.

#![allow(clippy::result_large_err)]

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Method, Response};
use multicc_core::http_gate::{query_value, QueryValue};
use multicc_core::js::serde::{truthy, value_or_empty};
use multicc_core::js::string::js_trim;
use multicc_core::quota_routes::{
    aliyun_http, ark_http, ark_login_started, bar_kind_valid, bar_refresh_body, bar_refresh_http,
    claude_bar, claude_body, claude_failure, claude_http, codex_http, fixed, idle_bars, kimi_http,
    login_failure, login_ok, lookup_error, ok_error, opencode_http, parse_model_list,
    pricing_error, pricing_lookup, pricing_search, pricing_status, qoder_http, refresh_force,
    render_bar, search_limit, spread_with_bar, status_error, status_error_opt, status_only,
    status_value, string_only, BarInput, BarQuery,
};
use serde_json::{json, Map, Value};

use crate::app::express::{self, RequestCtx};
use crate::app::App;
use crate::host_port;

/// The host port the Node child serves (`src/routes/quota-host.js`).
const HOST_PATH: &str = "/api/__host/quota";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Route {
    PricingStatusGet,
    PricingLookupGet,
    PricingRefreshPost,
    PricingSearchGet,
    AgyQuotaGet,
    OpenCodeQuotaGet,
    OpenCodeLoginPost,
    QoderQuotaGet,
    QoderLoginPost,
    QoderCookiesGet,
    CodexQuotaGet,
    ArkQuotaGet,
    ArkLoginPost,
    ArkInstallPost,
    KimiQuotaGet,
    KimiLoginPost,
    ClaudeQuotaGet,
    ClaudeLoginPost,
    AliyunQuotaGet,
    AliyunLoginPost,
    BarsIdleGet,
    BarsStateGet,
    BarsRefreshPost,
    /// Express's automatic OPTIONS: the union of the methods registered on the
    /// exact path, with `HEAD` after each `GET`, in registration order.
    Options,
}

struct Layer {
    segs: &'static [&'static str],
    method: &'static str,
    kind: Route,
}

/// Registration order of the retired mounts (`server.js` mounts pricing first,
/// then the seven vendor modules, then the bars), so a path registered twice
/// lists its methods in the order Express discovered them.
static LAYERS: &[Layer] = &[
    Layer {
        segs: &["pricing", "status"],
        method: "GET",
        kind: Route::PricingStatusGet,
    },
    Layer {
        segs: &["pricing", "lookup"],
        method: "GET",
        kind: Route::PricingLookupGet,
    },
    Layer {
        segs: &["pricing", "refresh"],
        method: "POST",
        kind: Route::PricingRefreshPost,
    },
    Layer {
        segs: &["pricing", "search"],
        method: "GET",
        kind: Route::PricingSearchGet,
    },
    Layer {
        segs: &["agy", "quota"],
        method: "GET",
        kind: Route::AgyQuotaGet,
    },
    Layer {
        segs: &["opencode", "quota"],
        method: "GET",
        kind: Route::OpenCodeQuotaGet,
    },
    Layer {
        segs: &["opencode", "quota", "login"],
        method: "POST",
        kind: Route::OpenCodeLoginPost,
    },
    Layer {
        segs: &["qoder", "quota"],
        method: "GET",
        kind: Route::QoderQuotaGet,
    },
    Layer {
        segs: &["qoder", "quota", "login"],
        method: "POST",
        kind: Route::QoderLoginPost,
    },
    Layer {
        segs: &["qoder", "quota", "cookies"],
        method: "GET",
        kind: Route::QoderCookiesGet,
    },
    Layer {
        segs: &["codex", "quota"],
        method: "GET",
        kind: Route::CodexQuotaGet,
    },
    Layer {
        segs: &["ark", "quota"],
        method: "GET",
        kind: Route::ArkQuotaGet,
    },
    Layer {
        segs: &["ark", "quota", "login"],
        method: "POST",
        kind: Route::ArkLoginPost,
    },
    Layer {
        segs: &["ark", "quota", "install"],
        method: "POST",
        kind: Route::ArkInstallPost,
    },
    Layer {
        segs: &["kimi", "quota"],
        method: "GET",
        kind: Route::KimiQuotaGet,
    },
    Layer {
        segs: &["kimi", "quota", "login"],
        method: "POST",
        kind: Route::KimiLoginPost,
    },
    Layer {
        segs: &["claude", "quota"],
        method: "GET",
        kind: Route::ClaudeQuotaGet,
    },
    Layer {
        segs: &["claude", "quota", "login"],
        method: "POST",
        kind: Route::ClaudeLoginPost,
    },
    Layer {
        segs: &["aliyun", "quota"],
        method: "GET",
        kind: Route::AliyunQuotaGet,
    },
    Layer {
        segs: &["aliyun", "quota", "login"],
        method: "POST",
        kind: Route::AliyunLoginPost,
    },
    Layer {
        segs: &["quota", "bars", "idle"],
        method: "GET",
        kind: Route::BarsIdleGet,
    },
    Layer {
        segs: &["quota", "bars", "state"],
        method: "GET",
        kind: Route::BarsStateGet,
    },
    Layer {
        segs: &["quota", "bars", "refresh"],
        method: "POST",
        kind: Route::BarsRefreshPost,
    },
];

/// `path` → its segments, or `None` when this cluster cannot own the path.
/// Every layer is literal: Express matched these routes exactly, and `/api/`
/// is case-sensitive here for the same reason it is everywhere else in
/// [`super::claim`] (Node's auth gate and gzip test compare it byte for byte).
fn segments(path: &str) -> Option<Vec<&str>> {
    let rest = path.strip_prefix("/api/")?;
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    if rest.is_empty() {
        return None;
    }
    let parts: Vec<&str> = rest.split('/').collect();
    if parts.iter().any(|part| part.is_empty()) {
        return None;
    }
    Some(parts)
}

/// Route paths are matched case-insensitively by Express's default router.
fn layer_matches(layer: &Layer, parts: &[&str]) -> bool {
    layer.segs.len() == parts.len()
        && layer
            .segs
            .iter()
            .zip(parts)
            .all(|(name, part)| part.eq_ignore_ascii_case(name))
}

pub fn claim(method: &Method, path: &str) -> Option<Route> {
    let parts = segments(path)?;
    if method.as_str() == "OPTIONS" {
        return LAYERS
            .iter()
            .any(|layer| layer_matches(layer, &parts))
            .then_some(Route::Options);
    }
    let wanted = if method.as_str() == "HEAD" {
        "GET"
    } else {
        method.as_str()
    };
    LAYERS
        .iter()
        .find(|layer| layer.method == wanted && layer_matches(layer, &parts))
        .map(|layer| layer.kind)
}

/// Express's automatic OPTIONS body and `Allow` header: the union of the
/// methods registered on this exact path, each `GET` followed by `HEAD`.
pub fn allow_for(path: &str) -> Option<String> {
    let parts = segments(path)?;
    let mut methods: Vec<&'static str> = Vec::new();
    let mut matched = false;
    for layer in LAYERS {
        if !layer_matches(layer, &parts) {
            continue;
        }
        matched = true;
        if !methods.contains(&layer.method) {
            methods.push(layer.method);
        }
        if layer.method == "GET" && !methods.contains(&"HEAD") {
            methods.push("HEAD");
        }
    }
    matched.then(|| methods.join(","))
}

/// This cluster's own share of Express's automatic `OPTIONS` `Allow`, for the
/// front-door union across clusters (`super::OPTIONS_SOURCES`).
pub fn options_share(path: &str) -> Option<String> {
    allow_for(path)
}

fn unavailable(ctx: &RequestCtx) -> Response<Body> {
    express::json(
        ctx,
        503,
        &json!({
            "error": "额度接口尚未就绪，请更新原生模块",
            "code": "rust_backend_unavailable",
        }),
        &[],
    )
}

/// `req.query[name]` as the JSON value JS would have seen; `None` when absent
/// (the retired handlers read `undefined`, which matters for `typeof` guards).
fn q_json(ctx: &RequestCtx, name: &str) -> Option<Value> {
    match query_value(&ctx.original_url, name) {
        QueryValue::Missing => None,
        QueryValue::Text(text) => Some(Value::String(text)),
        QueryValue::List(items) => Some(Value::Array(items.into_iter().map(list_item).collect())),
        QueryValue::Object => Some(Value::Object(Map::new())),
    }
}

fn list_item(value: QueryValue) -> Value {
    match value {
        QueryValue::Missing => Value::Null,
        QueryValue::Text(text) => Value::String(text),
        QueryValue::List(items) => Value::Array(items.into_iter().map(list_item).collect()),
        QueryValue::Object => Value::Object(Map::new()),
    }
}

fn payload(op: &str, fields: Vec<(&str, Value)>) -> Value {
    let mut object = Map::new();
    object.insert("op".into(), Value::String(op.to_string()));
    for (key, value) in fields {
        object.insert(key.to_string(), value);
    }
    Value::Object(object)
}

/// One host round trip. Two failures have to be told apart:
///
/// * the child is gone, or answered a non-200 — `host_port::call` turns that
///   into `Err`, and the front door answers the documented 503 surface;
/// * the op itself threw in Node. The host port reports that as HTTP 200 with
///   `{ok:false,error:{…}}`; the retired handlers that did not catch it were
///   answered by `safeErrorHandler`, so the front door has to emit that same
///   `{ok:false,error:'internal_error',…}` envelope instead of inventing a body
///   from a missing `status` member.
async fn call_value(ctx: &RequestCtx, host: u16, payload: Value) -> Result<Value, Response<Body>> {
    let op = payload
        .get("op")
        .and_then(Value::as_str)
        .unwrap_or("host")
        .to_string();
    let answer = host_port::call(host, HOST_PATH, &payload)
        .await
        .map_err(|_| unavailable(ctx))?;
    if answer.get("ok") == Some(&Value::Bool(true)) {
        return Ok(answer.get("value").cloned().unwrap_or(Value::Null));
    }
    Err(express::error(
        ctx,
        500,
        &format!("quota host operation failed: {op}"),
    ))
}

/// The login ops are the only ones whose refusal is an error object rather
/// than a value: the retired handlers built the 4xx/5xx envelope out of
/// `err.code`/`err.message` themselves.
async fn call_login(host: u16, payload: Value) -> Result<Value, LoginFailure> {
    match host_port::call(host, HOST_PATH, &payload).await {
        Ok(answer) => {
            if answer.get("ok") == Some(&Value::Bool(true)) {
                Ok(answer.get("value").cloned().unwrap_or(Value::Null))
            } else {
                Err(LoginFailure::Refused(
                    answer.get("error").cloned().unwrap_or(Value::Null),
                ))
            }
        }
        Err(_) => Err(LoginFailure::Down),
    }
}

enum LoginFailure {
    Refused(Value),
    Down,
}

/// `String(value || '').trim()` over one already-decoded query field.
fn query_trimmed(ctx: &RequestCtx, name: &str) -> String {
    js_trim(&value_or_empty(q_json(ctx, name).as_ref())).to_string()
}

fn threw(value: &Value) -> bool {
    value.get("threw") == Some(&Value::Bool(true))
}

/// The bar a refused/failed vendor fetch still shows: the retired catch arms
/// render from the synthetic `{status:'unavailable',error}` result, so the bar
/// is that kind's unreachable state rather than a blank.
fn failure_bar(kind: &str, error: &str) -> (Value, Value) {
    let result = fixed("unavailable", error);
    let bar = render_bar(kind, Some(&result), &json!({}));
    (result, bar)
}

/// `res.status(code).json({...result, bar})`.
fn with_bar(ctx: &RequestCtx, status: u16, result: &Value, bar: Value) -> Response<Body> {
    express::json(ctx, status, &spread_with_bar(Some(result), bar), &[])
}

pub async fn handle(
    app: &Arc<App>,
    route: Route,
    ctx: &RequestCtx,
    body: &Value,
    host: u16,
) -> Response<Body> {
    let _serialized = if ctx.method == Method::POST {
        Some(app.quota_write.lock().await)
    } else {
        None
    };
    answer(ctx, route, body, host).await
}

fn status_of(value: &Value) -> Value {
    status_value(Some(value), "unavailable")
}

async fn answer(ctx: &RequestCtx, route: Route, body: &Value, host: u16) -> Response<Body> {
    match route {
        Route::Options => {
            let allow = allow_for(&ctx.path).unwrap_or_default();
            express::send(
                ctx,
                200,
                "text/html; charset=utf-8",
                allow.clone().into_bytes(),
                &[("Allow", allow.as_str())],
            )
        }

        Route::PricingStatusGet => {
            let value = match call_value(ctx, host, payload("pricing.status", vec![])).await {
                Ok(value) => value,
                Err(response) => return response,
            };
            let status = value.get("status").cloned().unwrap_or(Value::Null);
            express::json(ctx, 200, &pricing_status(status), &[])
        }
        Route::PricingLookupGet => {
            let models = parse_model_list(q_json(ctx, "models").as_ref());
            if let Some((code, max)) = lookup_error(&models) {
                return express::json(ctx, 400, &pricing_error(code, max), &[]);
            }
            let value = match call_value(
                ctx,
                host,
                payload("pricing.lookup", vec![("models", json!(models))]),
            )
            .await
            {
                Ok(value) => value,
                Err(response) => return response,
            };
            let prices = value.get("prices").cloned().unwrap_or(Value::Null);
            let status = value.get("status").cloned().unwrap_or(Value::Null);
            express::json(ctx, 200, &pricing_lookup(prices, status), &[])
        }
        Route::PricingRefreshPost => {
            let force = refresh_force(q_json(ctx, "force").as_ref(), body);
            let value = match call_value(
                ctx,
                host,
                payload("pricing.refresh", vec![("force", Value::Bool(force))]),
            )
            .await
            {
                Ok(value) => value,
                Err(response) => return response,
            };
            let status = value.get("status").cloned().unwrap_or(Value::Null);
            express::json(ctx, 200, &pricing_status(status), &[])
        }
        Route::PricingSearchGet => {
            let query = query_trimmed(ctx, "q");
            let limit = search_limit(q_json(ctx, "limit").as_ref());
            let value = match call_value(
                ctx,
                host,
                payload(
                    "pricing.search",
                    vec![("query", json!(query)), ("limit", json!(limit))],
                ),
            )
            .await
            {
                Ok(value) => value,
                Err(response) => return response,
            };
            let results = value.get("results").cloned().unwrap_or(Value::Null);
            let status = value.get("status").cloned().unwrap_or(Value::Null);
            express::json(ctx, 200, &pricing_search(&query, results, status), &[])
        }

        Route::AgyQuotaGet => super::agy_quota::handle(ctx).await,
        Route::OpenCodeQuotaGet => vendor_quota(ctx, host, "opencode", opencode_http).await,
        Route::QoderQuotaGet => vendor_quota(ctx, host, "qoder", qoder_http).await,
        Route::CodexQuotaGet => codex_quota(ctx, host).await,
        Route::ArkQuotaGet => ark_quota(ctx, host).await,
        Route::KimiQuotaGet => kimi_quota(ctx, host).await,
        Route::AliyunQuotaGet => aliyun_quota(ctx, host).await,

        Route::QoderCookiesGet => {
            let value = match call_value(ctx, host, payload("qoder.cookies", vec![])).await {
                Ok(value) => value,
                Err(response) => return response,
            };
            let saved = value.get("saved").cloned().unwrap_or(Value::Null);
            if !truthy(&saved) {
                return express::json(ctx, 404, &ok_error("no saved cookies"), &[]);
            }
            express::json(ctx, 200, &saved, &[])
        }

        Route::OpenCodeLoginPost => login(ctx, host, "opencode", "opencode.login").await,
        Route::QoderLoginPost => login(ctx, host, "qoder", "qoder.login").await,
        Route::KimiLoginPost => login(ctx, host, "kimi", "kimi.login").await,
        Route::ClaudeLoginPost => login(ctx, host, "claude", "claude.login").await,
        Route::AliyunLoginPost => login(ctx, host, "aliyun", "aliyun.login").await,
        Route::ArkLoginPost => {
            let value = match call_value(ctx, host, payload("ark.login", vec![])).await {
                Ok(value) => value,
                Err(response) => return response,
            };
            if value.get("mode").and_then(Value::as_str) == Some("needs_install") {
                return express::json(
                    ctx,
                    404,
                    &fixed("needs_install", "arkcli not found on PATH"),
                    &[],
                );
            }
            if threw(&value) {
                let body =
                    status_error("unavailable", value.get("message").cloned(), "spawn failed");
                return express::json(ctx, 500, &body, &[]);
            }
            let pid = value.get("pid").cloned().unwrap_or(Value::Null);
            express::json(ctx, 200, &ark_login_started(Some(pid)), &[])
        }
        Route::ArkInstallPost => {
            let value = match call_value(ctx, host, payload("ark.install", vec![])).await {
                Ok(value) => value,
                Err(response) => return response,
            };
            if threw(&value) {
                let body = status_error("error", value.get("message").cloned(), "install failed");
                return express::json(ctx, 500, &body, &[]);
            }
            if value.get("ok") == Some(&Value::Bool(true)) {
                return express::json(ctx, 200, &status_only("ok"), &[]);
            }
            let body = status_error_opt("error", value.get("error").cloned());
            express::json(ctx, 500, &body, &[])
        }

        Route::ClaudeQuotaGet => claude_quota(ctx, host).await,
        Route::BarsIdleGet => express::json(ctx, 200, &idle_bars(), &[]),
        Route::BarsStateGet => {
            let input = bar_input(ctx, body);
            let value = match call_value(
                ctx,
                host,
                payload("bars.state", vec![("selector", input.state_input())]),
            )
            .await
            {
                Ok(value) => value,
                Err(response) => return response,
            };
            let snapshot = value.get("snapshot").cloned().unwrap_or(Value::Null);
            express::json(ctx, 200, &snapshot, &[])
        }
        Route::BarsRefreshPost => {
            let input = bar_input(ctx, body);
            if !bar_kind_valid(&input.kind) {
                return express::json(
                    ctx,
                    400,
                    &fixed("unavailable", "invalid quota bar kind"),
                    &[],
                );
            }
            let refreshed = match refresh_bar(ctx, host, &input).await {
                Ok(value) => value,
                Err(response) => return response,
            };
            let (result, bar, missing) = match refreshed {
                Refresh::Failed => {
                    return express::json(
                        ctx,
                        500,
                        &fixed("unavailable", "quota bar refresh failed"),
                        &[],
                    )
                }
                Refresh::Ok {
                    result,
                    bar,
                    missing,
                } => (result, bar, missing),
            };
            commit_bar(ctx, host, &input, result, bar, !missing).await
        }
    }
}

/// A `GET /api/<kind>/quota` route: fetch, status map, `{...result, bar}`.
async fn vendor_quota(
    ctx: &RequestCtx,
    host: u16,
    kind: &str,
    http: fn(&Value) -> u16,
) -> Response<Body> {
    let op = format!("{kind}.quota");
    let value = match call_value(ctx, host, payload(&op, vec![])).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    if threw(&value) {
        let (result, bar) = failure_bar(kind, &format!("{kind} quota fetch failed"));
        return with_bar(ctx, 500, &result, bar);
    }
    let result = value.get("result").cloned().unwrap_or(Value::Null);
    let status = status_of(&result);
    let bar = render_bar(kind, Some(&result), &json!({}));
    with_bar(ctx, http(&status), &result, bar)
}

async fn codex_quota(ctx: &RequestCtx, host: u16) -> Response<Body> {
    let account = query_trimmed(ctx, "account");
    let value = match call_value(
        ctx,
        host,
        payload("codex.quota", vec![("account", json!(account))]),
    )
    .await
    {
        Ok(value) => value,
        Err(response) => return response,
    };
    match value.get("mode").and_then(Value::as_str) {
        Some("disabled") => express::json(
            ctx,
            400,
            &fixed("unavailable", "official accounts not enabled"),
            &[],
        ),
        Some("missing") => express::json(ctx, 404, &fixed("no_auth", "账号不存在"), &[]),
        _ => {
            if threw(&value) {
                let (result, bar) = failure_bar("codex", "codex quota fetch failed");
                return with_bar(ctx, 500, &result, bar);
            }
            let result = value.get("result").cloned().unwrap_or(Value::Null);
            let status = status_of(&result);
            let bar = render_bar("codex", Some(&result), &json!({}));
            with_bar(ctx, codex_http(&status), &result, bar)
        }
    }
}

async fn ark_quota(ctx: &RequestCtx, host: u16) -> Response<Body> {
    // Only a plain string is the caller's plan; the catch arm records the raw
    // query value, so both spellings travel.
    let base_url = string_only(q_json(ctx, "baseUrl").as_ref());
    let mut fields = vec![("baseUrl", json!(base_url))];
    if let Some(raw) = q_json(ctx, "baseUrl") {
        fields.push(("rawBaseUrl", raw));
    }
    let value = match call_value(ctx, host, payload("ark.quota", fields)).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    if threw(&value) {
        // The retired catch renders without the caller's baseUrl.
        let (result, bar) = failure_bar("ark", "ark quota fetch failed");
        return with_bar(ctx, 500, &result, bar);
    }
    let result = value.get("result").cloned().unwrap_or(Value::Null);
    let status = status_of(&result);
    let bar = render_bar("ark", Some(&result), &json!({ "baseUrl": base_url }));
    with_bar(ctx, ark_http(&status), &result, bar)
}

async fn kimi_quota(ctx: &RequestCtx, host: u16) -> Response<Body> {
    let host_value = string_only(q_json(ctx, "host").as_ref());
    let mut fields = vec![("host", json!(host_value))];
    if let Some(raw) = q_json(ctx, "host") {
        fields.push(("rawHost", raw));
    }
    let value = match call_value(ctx, host, payload("kimi.quota", fields)).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let cached = value.get("cached").cloned().unwrap_or(Value::Null);
    if threw(&value) {
        let result = fixed("unavailable", "kimi quota fetch failed");
        let bar = render_bar("kimi", Some(&result), &json!({ "cached": cached }));
        return with_bar(ctx, 500, &result, bar);
    }
    let result = value.get("result").cloned().unwrap_or(Value::Null);
    let status = status_of(&result);
    let bar = render_bar("kimi", Some(&result), &json!({ "cached": cached }));
    with_bar(ctx, kimi_http(&status), &result, bar)
}

async fn aliyun_quota(ctx: &RequestCtx, host: u16) -> Response<Body> {
    let value = match call_value(ctx, host, payload("aliyun.quota", vec![])).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    if threw(&value) {
        return express::json(
            ctx,
            500,
            &fixed("unavailable", "aliyun quota fetch failed"),
            &[],
        );
    }
    let result = value.get("result").cloned().unwrap_or(Value::Null);
    let status = status_of(&result);
    // The Aliyun DTO goes out as-is: this route never carried a bar.
    express::json(ctx, aliyun_http(&status), &result, &[])
}

/// The five `/login` routes share one contract: open a visible window on the
/// managed profile, or answer with `err.code`/`err.message` and a 503 only for
/// `chrome_unavailable`.
async fn login(ctx: &RequestCtx, host: u16, kind: &str, op: &str) -> Response<Body> {
    match call_login(host, payload(op, vec![])).await {
        Ok(_) => express::json(ctx, 200, &login_ok(kind), &[]),
        Err(LoginFailure::Down) => unavailable(ctx),
        Err(LoginFailure::Refused(error)) => {
            let code = error
                .get("code")
                .and_then(Value::as_str)
                .map(str::to_string);
            let status = if code.as_deref() == Some("chrome_unavailable") {
                503
            } else {
                500
            };
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_string);
            express::json(
                ctx,
                status,
                &login_failure(error.get("code").cloned(), message.as_deref()),
                &[],
            )
        }
    }
}

fn bar_input(ctx: &RequestCtx, body: &Value) -> BarInput {
    BarInput::read(
        body,
        BarQuery {
            kind: q_json(ctx, "kind").as_ref(),
            session: q_json(ctx, "session").as_ref(),
            base_url: q_json(ctx, "baseUrl").as_ref(),
            host: q_json(ctx, "host").as_ref(),
            force: q_json(ctx, "force").as_ref(),
        },
    )
}

/// The Claude state the retired `renderClaudeBar` + queue read produced:
/// whether there is a reading, that reading, the bar's own `usage`, the live
/// 5h/window map entry, and the single `nowMs` the bar was rendered at.
#[derive(Default)]
struct ClaudeState {
    threw: bool,
    entry: bool,
    result: Value,
    usage: Option<Value>,
    live: Value,
    now_ms: f64,
}

impl ClaudeState {
    fn bar(&self) -> Value {
        claude_bar(self.usage.as_ref(), Some(&self.live), self.now_ms)
    }
}

async fn claude_state(
    ctx: &RequestCtx,
    host: u16,
    session: &str,
    force: bool,
) -> Result<ClaudeState, Response<Body>> {
    let value = match call_value(
        ctx,
        host,
        payload(
            "claude.quota",
            vec![("session", json!(session)), ("force", Value::Bool(force))],
        ),
    )
    .await
    {
        Ok(value) => value,
        Err(response) => return Err(response),
    };
    Ok(ClaudeState {
        threw: threw(&value),
        entry: value
            .get("entry")
            .cloned()
            .is_some_and(|value| truthy(&value)),
        result: value.get("result").cloned().unwrap_or(Value::Null),
        usage: value.get("usage").cloned(),
        live: value.get("live").cloned().unwrap_or(Value::Null),
        now_ms: value.get("nowMs").and_then(Value::as_f64).unwrap_or(0.0),
    })
}

/// `GET /api/claude/quota`: this route reads only `?session=` / `?force=`
/// (never the body, and never `text()`-sanitized) — see the retired handler.
async fn claude_quota(ctx: &RequestCtx, host: u16) -> Response<Body> {
    let session = string_only(q_json(ctx, "session").as_ref());
    let force = match q_json(ctx, "force") {
        Some(Value::String(text)) => text == "1" || text == "true",
        _ => false,
    };
    let state = match claude_state(ctx, host, &session, force).await {
        Ok(state) => state,
        Err(response) => return response,
    };
    let bar = state.bar();
    if state.threw {
        return express::json(ctx, 500, &claude_failure(bar), &[]);
    }
    if state.entry {
        record_claude(host, &session, &state.result, &bar).await;
    }
    let status = status_value(Some(&state.result), "idle");
    express::json(
        ctx,
        claude_http(&status),
        &claude_body(Some(&state.result), status, bar),
        &[],
    )
}

/// `recordClaude(session, result, bar && bar.text)` — only when there was a
/// real reading, and only when the bar has text (the retired `&&`).
async fn record_claude(host: u16, session: &str, result: &Value, bar: &Value) {
    let Some(text) = bar.get("text").filter(|value| truthy(value)) else {
        return;
    };
    // The retired `try { await recordClaude(...) } catch (_) {}` swallows a
    // recorder failure silently — no 500 envelope, no log line.
    let _ = host_port::call(
        host,
        HOST_PATH,
        &payload(
            "claude.record",
            vec![
                ("session", json!(session)),
                ("result", result.clone()),
                ("text", text.clone()),
            ],
        ),
    )
    .await;
}

enum Refresh {
    Ok {
        result: Value,
        bar: Value,
        missing: bool,
    },
    Failed,
}

async fn refresh_bar(
    ctx: &RequestCtx,
    host: u16,
    input: &BarInput,
) -> Result<Refresh, Response<Body>> {
    if input.kind == "claude" {
        let state = claude_state(ctx, host, &input.session, input.force).await?;
        if state.threw {
            return Ok(Refresh::Failed);
        }
        let missing = !state.entry;
        let bar = state.bar();
        let result = if state.entry {
            let result = state.result.clone();
            record_claude(host, &input.session, &result, &bar).await;
            result
        } else {
            status_only("idle")
        };
        return Ok(Refresh::Ok {
            result,
            bar,
            missing,
        });
    }
    let value = match call_value(
        ctx,
        host,
        payload(
            "bars.fetch",
            vec![
                ("kind", json!(input.kind)),
                ("host", json!(input.host)),
                ("baseUrl", json!(input.base_url)),
            ],
        ),
    )
    .await
    {
        Ok(value) => value,
        Err(response) => return Err(response),
    };
    if threw(&value) {
        return Ok(Refresh::Failed);
    }
    let result = value.get("result").cloned().unwrap_or(Value::Null);
    let bar = if input.kind == "ark" {
        render_bar("ark", Some(&result), &json!({ "baseUrl": input.base_url }))
    } else {
        render_bar(&input.kind, Some(&result), &json!({}))
    };
    Ok(Refresh::Ok {
        result,
        bar,
        missing: false,
    })
}

/// `cache.record` then `cache.get`, in the retired order.
async fn commit_bar(
    ctx: &RequestCtx,
    host: u16,
    input: &BarInput,
    result: Value,
    bar: Value,
    record: bool,
) -> Response<Body> {
    let value = match call_value(
        ctx,
        host,
        payload(
            "bars.commit",
            vec![
                ("record", Value::Bool(record)),
                ("kind", json!(input.kind)),
                ("result", result.clone()),
                ("bar", bar.clone()),
                ("selector", input.selector()),
            ],
        ),
    )
    .await
    {
        Ok(value) => value,
        Err(response) => return response,
    };
    let cached = value.get("cached").cloned().unwrap_or(Value::Null);
    let status = status_of(&result);
    express::json(
        ctx,
        bar_refresh_http(&status),
        &bar_refresh_body(Some(&result), bar, cached),
        &[],
    )
}
