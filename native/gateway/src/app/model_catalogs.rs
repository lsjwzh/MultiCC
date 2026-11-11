//! Model catalog routes retired from Node:
//!
//! * `GET/HEAD /api/opencode/models`      (src/routes/opencode-models.js)
//! * `GET/HEAD /api/qoder/models`         (src/routes/qoder-models.js)
//! * `GET/HEAD /api/grok/models`          (src/routes/grok-models.js)
//! * `GET/HEAD /api/commandcode/models`   (src/routes/commandcode-models.js)
//! * `GET/HEAD /api/codebuddy/models`     (src/routes/codebuddy-models.js)
//! * `GET/HEAD /api/providers/:id/models` (src/routes/provider-models.js)
//! * `GET/HEAD /api/codex/models` and `POST /api/codex/models/sync`
//!   (src/routes/codex-models.js)
//!
//! Path matching (including the `:id` parameter), query parsing, status codes,
//! response field order, `Cache-Control` and error mapping live here. What stays
//! in Node is exactly the state Rust cannot see: CLI child processes and their
//! process-local caches, the provider store projection, the relay HTTP fetch and
//! the official Codex catalog runtime (provider store + egress binding + native
//! `codexModelsPeek`/`Refresh`). Those are reached through one host port,
//! [`crate::host_port`], served by `src/routes/model-catalogs-host.js`.
//!
//! Node answered every one of these routes on the event loop; the CLI spawns
//! were already asynchronous, so two concurrent refreshes could both spawn. This
//! module keeps no lock: the host side owns its own single-flight state.

use std::time::Duration;

use axum::body::Body;
use axum::http::{Method, Response};
use multicc_core::http_gate::{query_value, QueryValue};
use multicc_core::js::serde::{js_string, truthy, value_or_empty};
use serde_json::{json, Map, Value};

use crate::app::express::{self, RequestCtx};
use crate::host_port;

/// The host port the Node child serves (`src/routes/model-catalogs-host.js`).
const HOST_PATH: &str = "/api/__host/model-catalogs";

/// The legacy Codex path (`GET /api/codex/models` without `providerId`/`poll`)
/// waits for a full native refresh; Node had no timeout on it.
const LEGACY_REFRESH_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Catalog {
    OpenCode,
    Qoder,
    Grok,
    Commandcode,
    Codebuddy,
}

impl Catalog {
    fn slug(self) -> &'static str {
        match self {
            Catalog::OpenCode => "opencode",
            Catalog::Qoder => "qoder",
            Catalog::Grok => "grok",
            Catalog::Commandcode => "commandcode",
            Catalog::Codebuddy => "codebuddy",
        }
    }

    /// The literal the retired `mount*` helper used in its 503 body.
    fn unavailable(self) -> &'static str {
        match self {
            Catalog::OpenCode => "opencode models unavailable",
            Catalog::Qoder => "qoder models unavailable",
            Catalog::Grok => "grok models unavailable",
            Catalog::Commandcode => "commandcode models unavailable",
            Catalog::Codebuddy => "codebuddy models unavailable",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Route {
    CatalogGet(Catalog),
    CatalogOptions(Catalog),
    /// `/api/providers/:id/models`; the id is decoded from the request path by
    /// [`provider_id_from_path`] so the route stays `Copy`.
    ProviderModelsGet,
    ProviderModelsOptions,
    CodexModelsGet,
    CodexModelsOptions,
    CodexModelsSync,
    CodexModelsSyncOptions,
}

/// The `:id` of `/api/providers/:id/models`, keeping its case. `rest` is the
/// path after `/api/` with one optional trailing slash removed. Express matches
/// the literal segments case-insensitively and then decodes the parameter.
fn provider_id(rest: &str) -> Option<String> {
    const HEAD: &str = "providers/";
    const TAIL: &str = "/models";
    if rest.len() <= HEAD.len() + TAIL.len() {
        return None;
    }
    if !rest.as_bytes()[..HEAD.len()].eq_ignore_ascii_case(HEAD.as_bytes()) {
        return None;
    }
    if !rest.as_bytes()[rest.len() - TAIL.len()..].eq_ignore_ascii_case(TAIL.as_bytes()) {
        return None;
    }
    let raw = &rest[HEAD.len()..rest.len() - TAIL.len()];
    if raw.is_empty() || raw.contains('/') {
        return None;
    }
    // `decodeURIComponent`; Express 400s on a malformed escape, which no client
    // of this route produces, so the literal text is kept instead.
    Some(super::download::decode_uri_component(raw).unwrap_or_else(|| raw.to_string()))
}

/// The decoded `:id` of `/api/providers/:id/models` for a raw request path.
pub fn provider_id_from_path(path: &str) -> Option<String> {
    let rest = path.strip_prefix("/api/")?;
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    provider_id(rest)
}

pub fn claim(method: &Method, path: &str) -> Option<Route> {
    let rest = path.strip_prefix("/api/")?;
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    if provider_id(rest).is_some() {
        return match method.as_str() {
            "GET" | "HEAD" => Some(Route::ProviderModelsGet),
            "OPTIONS" => Some(Route::ProviderModelsOptions),
            _ => None,
        };
    }
    let catalog = match rest.to_ascii_lowercase().as_str() {
        "opencode/models" => Catalog::OpenCode,
        "qoder/models" => Catalog::Qoder,
        "grok/models" => Catalog::Grok,
        "commandcode/models" => Catalog::Commandcode,
        "codebuddy/models" => Catalog::Codebuddy,
        _ => {
            return match (rest.to_ascii_lowercase().as_str(), method.as_str()) {
                ("codex/models", "GET" | "HEAD") => Some(Route::CodexModelsGet),
                ("codex/models", "OPTIONS") => Some(Route::CodexModelsOptions),
                ("codex/models/sync", "POST") => Some(Route::CodexModelsSync),
                ("codex/models/sync", "OPTIONS") => Some(Route::CodexModelsSyncOptions),
                _ => None,
            };
        }
    };
    match method.as_str() {
        "GET" | "HEAD" => Some(Route::CatalogGet(catalog)),
        "OPTIONS" => Some(Route::CatalogOptions(catalog)),
        _ => None,
    }
}

/// `String(req.query.x || '')` — the raw text the retired handlers matched on.
fn query_text(ctx: &RequestCtx, name: &str) -> String {
    multicc_core::http_gate::query_string(&query_value(&ctx.original_url, name))
}

/// `/^(?:1|true)$/i.test(...)`: the refresh/poll convention of every route here
/// except opencode, which compared `=== '1'`.
fn flag(text: &str) -> bool {
    text.eq_ignore_ascii_case("1") || text.eq_ignore_ascii_case("true")
}

/// `!req.query.x` for an Express `qs` value: only `undefined` and `''` are
/// falsy; a repeated key or an object is truthy.
fn query_absent(ctx: &RequestCtx, name: &str) -> bool {
    match query_value(&ctx.original_url, name) {
        QueryValue::Missing => true,
        QueryValue::Text(text) => text.is_empty(),
        _ => false,
    }
}

fn unavailable(ctx: &RequestCtx) -> Response<Body> {
    express::json(
        ctx,
        503,
        &json!({
            "error": "模型目录接口尚未就绪，请更新原生模块",
            "code": "rust_backend_unavailable",
        }),
        &[],
    )
}

async fn host(host: u16, payload: Value) -> Option<Value> {
    host_port::call(host, HOST_PATH, &payload).await.ok()
}

fn js_length_nonzero(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Array(items)) => !items.is_empty(),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Object(_)) => false,
        _ => false,
    }
}

/// `GET|HEAD /api/{opencode,qoder,grok,commandcode,codebuddy}/models`.
pub async fn catalog(catalog: Catalog, ctx: &RequestCtx, host_port_num: u16) -> Response<Body> {
    // opencode's retired handler used `String(...) === '1'`; the others accept
    // `1` and `true` case-insensitively.
    let raw = query_text(ctx, "refresh");
    let refresh = if catalog == Catalog::OpenCode {
        raw == "1"
    } else {
        flag(&raw)
    };
    let answer = host(
        host_port_num,
        json!({ "op": catalog.slug(), "refresh": refresh }),
    )
    .await;
    let Some(answer) = answer else {
        return express::json(
            ctx,
            503,
            &json!({ "error": catalog.unavailable(), "models": [] }),
            &[],
        );
    };
    if answer.get("ok") != Some(&Value::Bool(true)) {
        return express::json(
            ctx,
            503,
            &json!({ "error": catalog.unavailable(), "models": [] }),
            &[],
        );
    }
    let models = answer
        .get("models")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    let source = answer
        .get("source")
        .cloned()
        .unwrap_or_else(|| Value::String(String::new()));
    let cached = source.as_str() == Some("cache");
    express::json(
        ctx,
        200,
        &json!({ "models": models, "source": source, "cached": cached }),
        &[],
    )
}

/// `GET|HEAD /api/providers/:id/models`.
pub async fn provider(ctx: &RequestCtx, host_port_num: u16) -> Response<Body> {
    // The id was only used to claim the path; decode it from the raw path here.
    let Some(id) = provider_id_from_path(&ctx.path) else {
        return express::json(ctx, 404, &json!({ "error": "provider not found" }), &[]);
    };
    let id = id.as_str();
    let refresh = flag(&query_text(ctx, "refresh"));
    let Some(answer) = host(
        host_port_num,
        json!({ "op": "provider", "providerId": id, "refresh": refresh }),
    )
    .await
    else {
        return unavailable(ctx);
    };
    let status = answer
        .get("status")
        .and_then(Value::as_u64)
        .and_then(|code| u16::try_from(code).ok())
        .unwrap_or(500);
    let body = answer.get("body").cloned().unwrap_or(Value::Null);
    // The retired handler set this before its availability check, so 404s carry
    // it too.
    express::json(ctx, status, &body, &[("Cache-Control", "no-store")])
}

/// `GET /api/codex/models` (`sync == false`) and `POST /api/codex/models/sync`.
pub async fn codex(
    ctx: &RequestCtx,
    body: &Value,
    host_port_num: u16,
    sync: bool,
) -> Response<Body> {
    // `String(req.query?.providerId || req.body?.providerId || 'codex-official')`
    let query_provider = query_text(ctx, "providerId");
    let provider_id = if !query_provider.is_empty() {
        query_provider
    } else {
        let from_body = body
            .as_object()
            .and_then(|object| object.get("providerId"))
            .filter(|value| truthy(value))
            .map(js_string)
            .unwrap_or_default();
        if from_body.is_empty() {
            "codex-official".to_string()
        } else {
            from_body
        }
    };
    let Some(state) = host(
        host_port_num,
        json!({ "op": "codex-state", "providerId": provider_id }),
    )
    .await
    else {
        return unavailable(ctx);
    };
    if state.get("error") == Some(&Value::Bool(true)) {
        return express::error(ctx, 500, "codex provider lookup failed");
    }
    if state.get("found") != Some(&Value::Bool(true)) {
        return express::json(ctx, 404, &json!({ "error": "账号线路不存在" }), &[]);
    }
    if state.get("appType").and_then(Value::as_str) != Some("codex") {
        return express::json(
            ctx,
            400,
            &json!({ "error": "该线路不是 Codex 官方账号" }),
            &[],
        );
    }
    if state.get("official") != Some(&Value::Bool(true)) {
        // 借道（第三方中转）线路: the live catalog behind the same fetch as
        // /api/providers/:id/models, reshaped for loadCodexModels().
        let Some(result) = host(
            host_port_num,
            json!({
                "op": "provider",
                "providerId": value_or_empty(state.get("id")),
                "refresh": flag(&query_text(ctx, "refresh")),
            }),
        )
        .await
        else {
            return unavailable(ctx);
        };
        let rows = result
            .get("body")
            .and_then(|body| body.get("models"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let models: Vec<Value> = rows
            .iter()
            .map(|item| {
                let model = item.get("model").cloned().unwrap_or(Value::Null);
                let label = match item.get("label") {
                    Some(value) if truthy(value) => value.clone(),
                    _ => model.clone(),
                };
                json!({ "model": model, "label": label })
            })
            .collect();
        let source = result
            .get("body")
            .and_then(|body| body.get("source"))
            .filter(|value| truthy(value))
            .cloned()
            .unwrap_or_else(|| Value::String("fallback".to_string()));
        let available = !models.is_empty();
        return express::json(
            ctx,
            200,
            &json!({
                "models": models,
                "source": source,
                "cached": false,
                "available": available,
                "refreshing": false,
                "fallback": "custom",
                "diagnostic": {
                    "code": if available { "ok" } else { "none" },
                    "message": "",
                },
            }),
            &[("Cache-Control", "no-store")],
        );
    }

    // Official OAuth account. A request without `providerId` and `poll` is the
    // old client: it waits for the global catalog. Everything else kicks one
    // background refresh (never awaited) and answers from the current catalog,
    // with `refreshing` telling the picker whether that kick is still running.
    let mut poll_only = !sync && flag(&query_text(ctx, "poll"));
    if !sync && query_absent(ctx, "providerId") && query_absent(ctx, "poll") {
        let Some(answer) = host_port::call_with(
            host_port_num,
            HOST_PATH,
            &json!({ "op": "codex-refresh", "providerId": "codex-official", "wait": true }),
            LEGACY_REFRESH_TIMEOUT,
        )
        .await
        .ok() else {
            return unavailable(ctx);
        };
        if answer.get("error") == Some(&Value::Bool(true)) {
            return express::error(ctx, 500, "codex catalog refresh failed");
        }
        poll_only = true;
    }
    if !poll_only {
        let Some(answer) = host(
            host_port_num,
            json!({
                "op": "codex-refresh",
                "providerId": value_or_empty(state.get("id")),
                "wait": false,
            }),
        )
        .await
        else {
            return unavailable(ctx);
        };
        if answer.get("error") == Some(&Value::Bool(true)) {
            return express::error(ctx, 500, "codex catalog refresh failed");
        }
    }
    // Peek after the kick: `refreshing` must already see the pending refresh,
    // exactly as the retired handler read it after `void refreshProvider(...)`.
    let Some(state) = host(
        host_port_num,
        json!({ "op": "codex-state", "providerId": provider_id }),
    )
    .await
    else {
        return unavailable(ctx);
    };
    let mut result: Map<String, Value> = match state.get("peek") {
        Some(Value::Object(object)) => object.clone(),
        _ => Map::new(),
    };
    let available = js_length_nonzero(result.get("models"));
    result.insert("available".to_string(), Value::Bool(available));
    result.insert(
        "refreshing".to_string(),
        Value::Bool(state.get("refreshing") == Some(&Value::Bool(true))),
    );
    express::json(
        ctx,
        200,
        &Value::Object(result),
        &[("Cache-Control", "no-store")],
    )
}
