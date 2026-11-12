//! Provider routes retired from `src/routes/providers.js`:
//!
//! * `GET/HEAD /api/providers`, `POST /api/providers`
//! * `GET/HEAD /api/providers/stats`
//! * `POST /api/providers/import`
//! * `PATCH|DELETE /api/providers/:appType/:id`
//! * `POST /api/providers/:appType/:id/probe`
//! * `POST /api/providers/:appType/:id/reassign-sessions`
//! * `POST /api/providers/:appType/:id/relay-share`
//! * `POST /api/providers/:appType/:id/relay-models/sync`
//! * `GET|HEAD /api/providers/:appType/:id/relay-import-code`
//! * `GET|HEAD /api/provider-relay-shares`, `DELETE .../:id`, `GET .../:id/code`
//! * `GET|HEAD|PUT /api/provider-defaults`
//!
//! `POST /api/providers/:appType/:id/speedtest` is deliberately not claimed: it
//! streams SSE frames into `res`, so the connection has to stay in Node.
//!
//! Path matching (`:appType`/`:id` decoded with `decodeURIComponent`), query
//! parsing, validation, status codes, field order and error mapping live here
//! and in `multicc_core::provider_registry`. Node keeps exactly the state Rust
//! cannot see — the provider store, CC-Switch import, the probe child process,
//! session tables, relay-share records and the process-local
//! `provider-defaults.json` object — behind one host port,
//! `POST /api/__host/providers` (src/routes/providers-host.js).
//!
//! Node answered every route to completion on the event loop; the write routes
//! still await one host round trip, so [`App::providers_write`] serializes them
//! exactly like the single-threaded handlers did.

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Method, Response};
use multicc_core::http_gate::{query_param, query_string, query_value, QueryParam, QueryValue};
use multicc_core::js::serde::{js_string, truthy, value_or_empty};
use multicc_core::js::string::js_trim;
use multicc_core::provider_registry::{
    self, catalog_body, create_payload, defaults_updates, delete_response, detach_failed_response,
    encode_relay_share_code, import_error_dto, invalid_defaults_error, normalize_probe_candidates,
    plan_delete, provider_in_use_response, reassign_dry_run, reassign_precheck, reassign_target_id,
    relay_models_of, relay_route_from_base_url, relay_share_urls, update_payload, DeletePlan,
};
use multicc_core::public_safety::{public_error, sanitize_public_text};
use serde_json::{json, Map, Value};

use crate::app::express::{self, RequestCtx};
use crate::app::App;
use crate::host_port;

/// The host port the Node child serves (`src/routes/providers-host.js`).
const HOST_PATH: &str = "/api/__host/providers";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Route {
    CatalogGet,
    CatalogOptions,
    StatsGet,
    StatsOptions,
    ImportPost,
    ImportOptions,
    CreatePost,
    ProviderPatch,
    ProviderDelete,
    ProviderOptions,
    ProbePost,
    ProbeOptions,
    ReassignPost,
    ReassignOptions,
    RelaySharePost,
    RelayShareOptions,
    RelayModelsSyncPost,
    RelayModelsSyncOptions,
    RelayImportCodeGet,
    RelayImportCodeOptions,
    RelaySharesGet,
    RelaySharesOptions,
    RelayShareDelete,
    RelayShareDeleteOptions,
    RelayShareCodeGet,
    RelayShareCodeOptions,
    DefaultsGet,
    DefaultsPut,
    DefaultsOptions,
}

fn get_like(method: &Method) -> bool {
    matches!(method.as_str(), "GET" | "HEAD")
}

/// Segment view of `/api/<rest>`, one optional trailing slash removed. Express
/// matches literal segments case-insensitively and parameters as `[^/]+?`,
/// so an empty segment never matches.
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

fn tail(parts: &[&str], name: &str) -> bool {
    parts
        .last()
        .is_some_and(|part| part.eq_ignore_ascii_case(name))
}

pub fn claim(method: &Method, path: &str) -> Option<Route> {
    let parts = segments(path)?;
    if parts[0].eq_ignore_ascii_case("providers") {
        return match parts.len() {
            1 => match method.as_str() {
                "GET" | "HEAD" => Some(Route::CatalogGet),
                "OPTIONS" => Some(Route::CatalogOptions),
                "POST" => Some(Route::CreatePost),
                _ => None,
            },
            2 => {
                if parts[1].eq_ignore_ascii_case("stats") {
                    return match method.as_str() {
                        "GET" | "HEAD" => Some(Route::StatsGet),
                        "OPTIONS" => Some(Route::StatsOptions),
                        _ => None,
                    };
                }
                if parts[1].eq_ignore_ascii_case("import") {
                    return match method.as_str() {
                        "POST" => Some(Route::ImportPost),
                        "OPTIONS" => Some(Route::ImportOptions),
                        _ => None,
                    };
                }
                None
            }
            3 => match method.as_str() {
                "PATCH" => Some(Route::ProviderPatch),
                "DELETE" => Some(Route::ProviderDelete),
                "OPTIONS" => Some(Route::ProviderOptions),
                _ => None,
            },
            4 => {
                if parts[3].eq_ignore_ascii_case("probe") {
                    match method.as_str() {
                        "POST" => Some(Route::ProbePost),
                        "OPTIONS" => Some(Route::ProbeOptions),
                        _ => None,
                    }
                } else if parts[3].eq_ignore_ascii_case("reassign-sessions") {
                    match method.as_str() {
                        "POST" => Some(Route::ReassignPost),
                        "OPTIONS" => Some(Route::ReassignOptions),
                        _ => None,
                    }
                } else if parts[3].eq_ignore_ascii_case("relay-share") {
                    match method.as_str() {
                        "POST" => Some(Route::RelaySharePost),
                        "OPTIONS" => Some(Route::RelayShareOptions),
                        _ => None,
                    }
                } else if parts[3].eq_ignore_ascii_case("relay-import-code") && get_like(method) {
                    Some(Route::RelayImportCodeGet)
                } else if parts[3].eq_ignore_ascii_case("relay-import-code")
                    && method.as_str() == "OPTIONS"
                {
                    Some(Route::RelayImportCodeOptions)
                } else {
                    None
                }
            }
            5 if parts[3].eq_ignore_ascii_case("relay-models") && tail(&parts, "sync") => {
                match method.as_str() {
                    "POST" => Some(Route::RelayModelsSyncPost),
                    "OPTIONS" => Some(Route::RelayModelsSyncOptions),
                    _ => None,
                }
            }
            _ => None,
        };
    }
    if parts[0].eq_ignore_ascii_case("provider-relay-shares") {
        return match parts.len() {
            1 => match method.as_str() {
                "GET" | "HEAD" => Some(Route::RelaySharesGet),
                "OPTIONS" => Some(Route::RelaySharesOptions),
                _ => None,
            },
            2 => match method.as_str() {
                "DELETE" => Some(Route::RelayShareDelete),
                "OPTIONS" => Some(Route::RelayShareDeleteOptions),
                _ => None,
            },
            3 if tail(&parts, "code") && get_like(method) => Some(Route::RelayShareCodeGet),
            3 if tail(&parts, "code") && method.as_str() == "OPTIONS" => {
                Some(Route::RelayShareCodeOptions)
            }
            _ => None,
        };
    }
    if parts.len() == 1 && parts[0].eq_ignore_ascii_case("provider-defaults") {
        return match method.as_str() {
            "GET" | "HEAD" => Some(Route::DefaultsGet),
            "PUT" => Some(Route::DefaultsPut),
            "OPTIONS" => Some(Route::DefaultsOptions),
            _ => None,
        };
    }
    None
}

/// `decodeURIComponent` for one parameter; `None` is Express's 400.
fn decode(raw: &str) -> Option<String> {
    super::download::decode_uri_component(raw)
}

/// The `:appType`/`:id` of a `/api/providers/:appType/:id[/tail...]` path.
fn provider_params(path: &str) -> Option<(String, String)> {
    let parts = segments(path)?;
    if parts.len() < 3 || !parts[0].eq_ignore_ascii_case("providers") {
        return None;
    }
    Some((decode(parts[1])?, decode(parts[2])?))
}

fn relay_share_id(path: &str) -> Option<String> {
    let parts = segments(path)?;
    if parts.len() < 2 || !parts[0].eq_ignore_ascii_case("provider-relay-shares") {
        return None;
    }
    decode(parts[1])
}

/// `String(req.query.x || '')`.
fn query_text(ctx: &RequestCtx, name: &str) -> String {
    query_string(&query_value(&ctx.original_url, name))
}

/// `(req.query[name] || '').trim()`. `qs` turns repeated pairs and `name[...]`
/// forms into an array/object, which has no `trim`: the retired handler threw
/// and safeErrorHandler answered the internal_error DTO (the same rule as
/// `src/routes/file-transfer-host.js`'s `path` parameter).
fn query_trimmed(ctx: &RequestCtx, name: &str) -> Result<String, String> {
    match query_param(&ctx.original_url, name) {
        QueryParam::Missing => Ok(String::new()),
        QueryParam::Text(text) => Ok(js_trim(&text).to_string()),
        QueryParam::Other => Err(format!("req.query.{name}.trim is not a function")),
    }
}

fn unavailable(ctx: &RequestCtx) -> Response<Body> {
    express::json(
        ctx,
        503,
        &json!({
            "error": "供应商接口尚未就绪，请更新原生模块",
            "code": "rust_backend_unavailable",
        }),
        &[],
    )
}

async fn host(host: u16, payload: Value) -> Option<Value> {
    host_port::call(host, HOST_PATH, &payload).await.ok()
}

fn succeeded(answer: &Value) -> bool {
    answer.get("ok") == Some(&Value::Bool(true))
}

/// `answer.error.message`, already sanitized by the host.
fn host_message(answer: &Value) -> String {
    answer
        .get("error")
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

/// `{ ...result }` appended to an object whose first key is `ok: true`.
fn spread_result(answer: &Value) -> Value {
    let mut out = Map::new();
    out.insert("ok".into(), Value::Bool(true));
    if let Some(Value::Object(result)) = answer.get("result") {
        for (key, value) in result {
            out.insert(key.clone(), value.clone());
        }
    }
    Value::Object(out)
}

fn body_map(body: &Value) -> Option<&Map<String, Value>> {
    body.as_object()
}

/// The decode-400 body: the router failed the parameter before the handler ran.
fn bad_param(ctx: &RequestCtx) -> Response<Body> {
    express::error(ctx, 400, "Failed to decode param")
}

/// `GET|HEAD /api/providers`.
async fn catalog(ctx: &RequestCtx, host_port_num: u16) -> Response<Body> {
    let app_type = match query_trimmed(ctx, "appType") {
        Ok(value) => value,
        Err(detail) => return express::error(ctx, 500, &detail),
    };
    let cli = match query_trimmed(ctx, "cli") {
        Ok(value) => value,
        Err(detail) => return express::error(ctx, 500, &detail),
    };
    let mut payload = Map::new();
    payload.insert("op".into(), json!("catalog"));
    payload.insert("appType".into(), json!(app_type));
    payload.insert("cli".into(), json!(cli));
    // The host skips the background Codex catalog refresh only for `poll=1`
    // (`body.poll !== '1'`); forward the qs shape so every other value agrees.
    if let Some(poll) = query_json(&query_value(&ctx.original_url, "poll")) {
        payload.insert("poll".into(), poll);
    }
    let Some(answer) = host(host_port_num, Value::Object(payload)).await else {
        return unavailable(ctx);
    };
    if !succeeded(&answer) {
        return unavailable(ctx);
    }
    express::json(ctx, 200, &catalog_body(&answer), &[])
}

/// `GET|HEAD /api/providers/stats`.
async fn stats(ctx: &RequestCtx, host_port_num: u16) -> Response<Body> {
    let Some(answer) = host(host_port_num, json!({ "op": "usageStats" })).await else {
        return unavailable(ctx);
    };
    if !succeeded(&answer) {
        return express::json(
            ctx,
            500,
            &json!({
                "error": sanitize_public_text(
                    Some(&host_message(&answer)),
                    "provider stats failed"
                ),
            }),
            &[],
        );
    }
    let stats = answer.get("stats").cloned().unwrap_or(Value::Null);
    express::json(ctx, 200, &stats, &[])
}

/// `POST /api/providers/import`.
async fn import(app: &Arc<App>, ctx: &RequestCtx, host_port_num: u16) -> Response<Body> {
    let _serialized = app.providers_write.lock().await;
    let Some(answer) = host(host_port_num, json!({ "op": "import" })).await else {
        return unavailable(ctx);
    };
    if succeeded(&answer) {
        return express::json(ctx, 200, &spread_result(&answer), &[]);
    }
    let error = answer.get("error");
    let dto = import_error_dto(
        error
            .and_then(|error| error.get("message"))
            .and_then(Value::as_str),
        error.and_then(|error| error.get("code")),
        error.and_then(|error| error.get("reason")),
    );
    express::json(ctx, 400, &dto, &[])
}

/// `POST /api/providers`.
async fn create(
    app: &Arc<App>,
    ctx: &RequestCtx,
    body: &Value,
    host_port_num: u16,
) -> Response<Body> {
    let _serialized = app.providers_write.lock().await;
    let payload = match create_payload(body_map(body)) {
        Ok(payload) => payload,
        Err(message) => {
            return express::json(
                ctx,
                400,
                &json!({ "error": public_error(Some(&message), "provider create failed") }),
                &[],
            )
        }
    };
    let Some(answer) = host(
        host_port_num,
        json!({ "op": "create", "body": Value::Object(payload) }),
    )
    .await
    else {
        return unavailable(ctx);
    };
    if succeeded(&answer) {
        return express::json(ctx, 200, &spread_result(&answer), &[]);
    }
    express::json(
        ctx,
        400,
        &json!({
            "error": public_error(Some(&host_message(&answer)), "provider create failed"),
        }),
        &[],
    )
}

/// `PATCH /api/providers/:appType/:id`.
async fn update(
    app: &Arc<App>,
    ctx: &RequestCtx,
    body: &Value,
    host_port_num: u16,
) -> Response<Body> {
    let _serialized = app.providers_write.lock().await;
    let Some((app_type, id)) = provider_params(&ctx.path) else {
        return bad_param(ctx);
    };
    let patch = match update_payload(body_map(body)) {
        Ok(patch) => patch,
        Err(message) => {
            return express::json(
                ctx,
                400,
                &json!({ "error": public_error(Some(&message), "provider update failed") }),
                &[],
            )
        }
    };
    let Some(answer) = host(
        host_port_num,
        json!({
            "op": "update",
            "appType": app_type,
            "id": id,
            "body": Value::Object(patch),
        }),
    )
    .await
    else {
        return unavailable(ctx);
    };
    if succeeded(&answer) {
        return express::json(ctx, 200, &json!({ "ok": true }), &[]);
    }
    express::json(
        ctx,
        400,
        &json!({
            "error": public_error(Some(&host_message(&answer)), "provider update failed"),
        }),
        &[],
    )
}

/// `DELETE /api/providers/:appType/:id`.
async fn delete(app: &Arc<App>, ctx: &RequestCtx, host_port_num: u16) -> Response<Body> {
    let _serialized = app.providers_write.lock().await;
    let Some((app_type, id)) = provider_params(&ctx.path) else {
        return bad_param(ctx);
    };
    let Some(facts) = host(
        host_port_num,
        json!({ "op": "deleteFacts", "appType": app_type, "id": id }),
    )
    .await
    else {
        return unavailable(ctx);
    };
    let references = facts
        .get("references")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    let reference_count = references.as_array().map_or(0, Vec::len);
    let forceable = facts.get("forceable") == Some(&Value::Bool(true));
    let force = {
        let raw = query_text(ctx, "force").to_lowercase();
        raw == "1" || raw == "true"
    };
    let plan = plan_delete(reference_count, force, forceable);
    if plan == DeletePlan::InUse {
        return express::json(
            ctx,
            409,
            &provider_in_use_response(&references, forceable),
            &[],
        );
    }
    let Some(answer) = host(
        host_port_num,
        json!({
            "op": "deleteExec",
            "appType": app_type,
            "id": id,
            "references": references,
        }),
    )
    .await
    else {
        return unavailable(ctx);
    };
    if !succeeded(&answer) {
        return express::json(
            ctx,
            400,
            &json!({
                "error": public_error(Some(&host_message(&answer)), "provider delete failed"),
            }),
            &[],
        );
    }
    let delete_ok = answer.get("deleteOk") == Some(&Value::Bool(true));
    let detached = answer
        .get("detached")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    let failed = answer
        .get("failed")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    if plan == DeletePlan::Detach && failed.as_array().is_some_and(|list| !list.is_empty()) {
        return express::json(ctx, 409, &detach_failed_response(&failed, &detached), &[]);
    }
    let forced = plan == DeletePlan::Detach;
    express::json(
        ctx,
        200,
        &delete_response(delete_ok, forced, &detached),
        &[],
    )
}

/// `POST /api/providers/:appType/:id/probe`.
async fn probe(ctx: &RequestCtx, body: &Value, host_port_num: u16) -> Response<Body> {
    let Some((app_type, id)) = provider_params(&ctx.path) else {
        return bad_param(ctx);
    };
    let Some(facts) = host(
        host_port_num,
        json!({ "op": "probeFacts", "appType": app_type, "id": id }),
    )
    .await
    else {
        return unavailable(ctx);
    };
    if facts.get("exists") != Some(&Value::Bool(true)) {
        return express::json(ctx, 404, &json!({ "error": "provider not found" }), &[]);
    }
    let candidates = match normalize_probe_candidates(
        body_map(body).and_then(|object| object.get("candidates")),
    ) {
        Ok(candidates) => candidates,
        Err((status, message)) => {
            return express::json(ctx, status, &json!({ "error": message }), &[])
        }
    };
    let mut payload = Map::new();
    payload.insert("op".into(), json!("probeExec"));
    payload.insert("appType".into(), json!(app_type));
    payload.insert("id".into(), json!(id));
    if let Some(candidates) = candidates {
        payload.insert("candidates".into(), json!(candidates));
    }
    let Some(answer) = host(host_port_num, Value::Object(payload)).await else {
        return unavailable(ctx);
    };
    if !succeeded(&answer) {
        return express::json(
            ctx,
            400,
            &json!({
                "error": public_error(Some(&host_message(&answer)), "provider probe failed"),
            }),
            &[],
        );
    }
    // The host already ran sanitizeProbeResult; sanitizing twice is idempotent
    // but would only re-normalize, so the answer is passed through as is.
    let result = answer.get("result").cloned().unwrap_or(Value::Null);
    express::json(ctx, 200, &result, &[])
}

/// `POST /api/providers/:appType/:id/reassign-sessions`.
async fn reassign(
    app: &Arc<App>,
    ctx: &RequestCtx,
    body: &Value,
    host_port_num: u16,
) -> Response<Body> {
    let _serialized = app.providers_write.lock().await;
    let Some((raw_app_type, id)) = provider_params(&ctx.path) else {
        return bad_param(ctx);
    };
    let app_type = js_trim(&raw_app_type).to_string();
    if !provider_registry::is_valid_app_type(&app_type) {
        return express::json(ctx, 400, &json!({ "error": "invalid app type" }), &[]);
    }
    let object = body_map(body);
    let Some(facts) = host(
        host_port_num,
        json!({ "op": "reassignFacts", "appType": app_type, "id": id }),
    )
    .await
    else {
        return unavailable(ctx);
    };
    if facts.get("sourceExists") != Some(&Value::Bool(true)) {
        return express::json(ctx, 404, &json!({ "error": "provider not found" }), &[]);
    }
    let target = reassign_target_id(object.and_then(|object| object.get("targetProviderId")));
    let dry_run = reassign_dry_run(object);
    if let Err((status, message)) = reassign_precheck(&id, target.as_deref(), dry_run) {
        return express::json(ctx, status, &json!({ "error": message }), &[]);
    }
    if let Some(target_id) = target.as_deref().filter(|text| !text.is_empty()) {
        let Some(answer) = host(
            host_port_num,
            json!({ "op": "reassignTarget", "targetProviderId": target_id }),
        )
        .await
        else {
            return unavailable(ctx);
        };
        if !succeeded(&answer) || answer.get("target").is_none_or(Value::is_null) {
            return express::json(
                ctx,
                404,
                &json!({ "error": "target provider not found" }),
                &[],
            );
        }
    }
    if facts.get("patchRuntime") != Some(&Value::Bool(true)) {
        return express::json(
            ctx,
            409,
            &json!({ "error": "session patch runtime unavailable" }),
            &[],
        );
    }
    let target_value = match target.as_deref() {
        Some(text) if !text.is_empty() => Value::String(text.to_string()),
        _ => Value::Null,
    };
    let Some(answer) = host(
        host_port_num,
        json!({
            "op": "reassignExec",
            "appType": app_type,
            "id": id,
            "targetProviderId": target_value,
            "dryRun": dry_run,
        }),
    )
    .await
    else {
        return unavailable(ctx);
    };
    if !succeeded(&answer) {
        return express::json(
            ctx,
            400,
            &json!({
                "error": public_error(
                    Some(&host_message(&answer)),
                    "provider reassignment failed"
                ),
            }),
            &[],
        );
    }
    let result = answer.get("result").cloned().unwrap_or(Value::Null);
    express::json(ctx, 200, &result, &[])
}

/// `POST /api/providers/:appType/:id/relay-share`.
async fn relay_share(
    app: &Arc<App>,
    ctx: &RequestCtx,
    body: &Value,
    host_port_num: u16,
) -> Response<Body> {
    let _serialized = app.providers_write.lock().await;
    let Some((app_type, id)) = provider_params(&ctx.path) else {
        return bad_param(ctx);
    };
    let Some(facts) = host(
        host_port_num,
        json!({ "op": "relayShareFacts", "appType": app_type, "id": id }),
    )
    .await
    else {
        return unavailable(ctx);
    };
    let provider = facts.get("provider").filter(|value| truthy(value)).cloned();
    let Some(provider) = provider else {
        return express::json(ctx, 404, &json!({ "error": "provider not found" }), &[]);
    };
    let Some(urls) = relay_share_urls(
        &app_type,
        &id,
        body_map(body).and_then(|object| object.get("publicBaseUrl")),
    ) else {
        return express::json(
            ctx,
            400,
            &json!({ "error": "publicBaseUrl must be an http(s) URL" }),
            &[],
        );
    };
    let summary = facts.get("summary").cloned().unwrap_or_else(|| json!({}));
    let models = relay_models_of(Some(&summary));
    let provider_name = {
        let name = value_or_empty(provider.get("name"));
        if name.is_empty() {
            id.clone()
        } else {
            name
        }
    };
    let relay_name = format!("{provider_name} · 远程共享");
    let mut payload = Map::new();
    payload.insert("op".into(), json!("relayShareCreate"));
    payload.insert("appType".into(), json!(app_type));
    payload.insert("id".into(), json!(id));
    payload.insert("providerName".into(), json!(provider_name));
    payload.insert("publicBaseUrl".into(), json!(urls.base));
    payload.insert("relayBaseUrl".into(), json!(urls.relay_base_url));
    if let Some(token) = body_map(body).and_then(|object| object.get("token")) {
        payload.insert("token".into(), token.clone());
    }
    if let Some(label) = body_map(body).and_then(|object| object.get("label")) {
        payload.insert("label".into(), label.clone());
    }
    let Some(answer) = host(host_port_num, Value::Object(payload)).await else {
        return unavailable(ctx);
    };
    if succeeded(&answer) {
        let share = answer.get("share").cloned().unwrap_or(Value::Null);
        let credential = value_or_empty(answer.get("credential"));
        let share_id = value_or_empty(share.get("id"));
        let code = encode_relay_share_code(
            &relay_name,
            &app_type,
            &urls.relay_base_url,
            &models,
            &share_id,
            &credential,
        );
        return express::json(
            ctx,
            200,
            &json!({
                "ok": true,
                "code": code,
                "baseUrl": urls.relay_base_url,
                "share": share,
            }),
            &[],
        );
    }
    if answer.get("code").and_then(Value::as_str) == Some("RELAY_TOKEN_INVALID") {
        return express::json(
            ctx,
            400,
            &json!({
                "error": "共享凭据必须为 8–128 位无空格 ASCII 字符",
                "code": "RELAY_TOKEN_INVALID",
            }),
            &[],
        );
    }
    express::json(
        ctx,
        400,
        &json!({
            "error": public_error(Some(&host_message(&answer)), "relay share create failed"),
        }),
        &[],
    )
}

/// `POST /api/providers/:appType/:id/relay-models/sync`.
async fn relay_models_sync(app: &Arc<App>, ctx: &RequestCtx, host_port_num: u16) -> Response<Body> {
    let _serialized = app.providers_write.lock().await;
    let Some((app_type, id)) = provider_params(&ctx.path) else {
        return bad_param(ctx);
    };
    let Some(answer) = host(
        host_port_num,
        json!({ "op": "relayModelsSync", "appType": app_type, "id": id }),
    )
    .await
    else {
        return unavailable(ctx);
    };
    if !succeeded(&answer) {
        return unavailable(ctx);
    }
    if answer.get("found") != Some(&Value::Bool(true)) {
        return express::json(
            ctx,
            404,
            &json!({ "ok": false, "reason": "not_found" }),
            &[],
        );
    }
    if answer.get("available") != Some(&Value::Bool(true)) {
        return express::json(
            ctx,
            503,
            &json!({ "ok": false, "reason": "relay_model_sync_unavailable" }),
            &[],
        );
    }
    let result = answer.get("result").cloned().unwrap_or(Value::Null);
    let reason = result.get("reason").and_then(Value::as_str);
    if result.get("ok") != Some(&Value::Bool(true)) {
        let status = if reason == Some("not_relay") {
            400
        } else {
            502
        };
        return express::json(ctx, status, &result, &[]);
    }
    express::json(ctx, 200, &result, &[])
}

/// `GET|HEAD /api/provider-relay-shares`.
async fn relay_shares(ctx: &RequestCtx, host_port_num: u16) -> Response<Body> {
    let mut payload = Map::new();
    payload.insert("op".into(), json!("relaySharesList"));
    for name in ["appType", "providerId"] {
        if let Some(value) = query_json(&query_value(&ctx.original_url, name)) {
            payload.insert(name.into(), value);
        }
    }
    let Some(answer) = host(host_port_num, Value::Object(payload)).await else {
        return unavailable(ctx);
    };
    if !succeeded(&answer) {
        // The retired route passed the error to `next(error)`, whose terminal
        // safeErrorHandler answered the internal_error DTO.
        return express::error(ctx, 500, "relay share list failed");
    }
    let shares = answer
        .get("shares")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    express::json(ctx, 200, &json!({ "shares": shares }), &[])
}

/// `req.query` as the JSON value qs built: a missing key stays absent.
fn query_json(value: &QueryValue) -> Option<Value> {
    match value {
        QueryValue::Missing => None,
        QueryValue::Text(text) => Some(Value::String(text.clone())),
        QueryValue::List(items) => Some(Value::Array(
            items
                .iter()
                .map(|item| query_json(item).unwrap_or(Value::Null))
                .collect(),
        )),
        QueryValue::Object => Some(json!({})),
    }
}

/// `DELETE /api/provider-relay-shares/:id`.
async fn relay_share_delete(
    app: &Arc<App>,
    ctx: &RequestCtx,
    host_port_num: u16,
) -> Response<Body> {
    let _serialized = app.providers_write.lock().await;
    let Some(id) = relay_share_id(&ctx.path) else {
        return bad_param(ctx);
    };
    let Some(answer) = host(host_port_num, json!({ "op": "relayShareRevoke", "id": id })).await
    else {
        return unavailable(ctx);
    };
    if !succeeded(&answer) {
        return express::json(
            ctx,
            500,
            &json!({
                "error": public_error(Some(&host_message(&answer)), "relay share revoke failed"),
            }),
            &[],
        );
    }
    let share = answer.get("share").cloned().unwrap_or(Value::Null);
    if !truthy(&share) {
        return express::json(ctx, 404, &json!({ "error": "relay share not found" }), &[]);
    }
    express::json(ctx, 200, &json!({ "ok": true, "share": share }), &[])
}

/// `GET|HEAD /api/provider-relay-shares/:id/code`.
async fn relay_share_code(ctx: &RequestCtx, host_port_num: u16) -> Response<Body> {
    let Some(id) = relay_share_id(&ctx.path) else {
        return bad_param(ctx);
    };
    let Some(answer) = host(
        host_port_num,
        json!({ "op": "relayShareCodeFacts", "id": id }),
    )
    .await
    else {
        return unavailable(ctx);
    };
    if !succeeded(&answer) {
        return express::json(
            ctx,
            500,
            &json!({
                "error": public_error(Some(&host_message(&answer)), "relay share copy failed"),
            }),
            &[],
        );
    }
    let found = answer.get("found").cloned().unwrap_or(Value::Null);
    if !found.is_object() {
        return express::json(
            ctx,
            500,
            &json!({
                "error": public_error(Some(&host_message(&answer)), "relay share copy failed"),
            }),
            &[],
        );
    }
    if found.get("ok") != Some(&Value::Bool(true)) {
        let code = found
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let (status, error) = match code.as_str() {
            "not_found" => (404, "relay share not found"),
            "revoked" => (410, "这条分享已撤销，无法再复制"),
            _ => (
                409,
                "这条分享创建于旧版本，凭据未留存，无法再复制；请新建一条",
            ),
        };
        // `res.json({ error, code: found.code })`: an absent code stays absent
        // (JSON.stringify drops undefined) while an explicit null is kept.
        let body = match found.get("code") {
            None => json!({ "error": error }),
            Some(code) => json!({ "error": error, "code": code }),
        };
        return express::json(ctx, status, &body, &[]);
    }
    let share = found.get("share").cloned().unwrap_or(Value::Null);
    let provider = answer
        .get("provider")
        .filter(|value| truthy(value))
        .cloned();
    let Some(provider) = provider else {
        return express::json(ctx, 404, &json!({ "error": "provider not found" }), &[]);
    };
    let summary = answer.get("summary").cloned().unwrap_or_else(|| json!({}));
    let name = {
        let name = value_or_empty(provider.get("name"));
        if name.is_empty() {
            value_or_empty(share.get("providerId"))
        } else {
            name
        }
    };
    let relay_name = format!("{name} · 远程共享");
    let base_url = value_or_empty(share.get("relayBaseUrl"));
    let code = encode_relay_share_code(
        &relay_name,
        &value_or_empty(share.get("appType")),
        &base_url,
        &relay_models_of(Some(&summary)),
        &value_or_empty(share.get("id")),
        &value_or_empty(found.get("credential")),
    );
    express::json(
        ctx,
        200,
        &json!({ "ok": true, "code": code, "baseUrl": base_url, "share": share }),
        &[],
    )
}

/// `GET|HEAD /api/providers/:appType/:id/relay-import-code`.
async fn relay_import_code(ctx: &RequestCtx, host_port_num: u16) -> Response<Body> {
    let Some((app_type, id)) = provider_params(&ctx.path) else {
        return bad_param(ctx);
    };
    let Some(answer) = host(
        host_port_num,
        json!({ "op": "relayImportFacts", "appType": app_type, "id": id }),
    )
    .await
    else {
        return unavailable(ctx);
    };
    if !succeeded(&answer) {
        return unavailable(ctx);
    }
    let provider = answer
        .get("provider")
        .filter(|value| truthy(value))
        .cloned();
    let Some(provider) = provider else {
        return express::json(ctx, 404, &json!({ "error": "provider not found" }), &[]);
    };
    let summary = answer.get("summary").cloned().unwrap_or_else(|| json!({}));
    let token = answer.get("token").cloned().unwrap_or(Value::Null);
    let route = relay_route_from_base_url(summary.get("baseUrl"));
    let credential = provider_registry::parse_credential(Some(&token));
    let route_matches = route.as_ref().is_some_and(|route| {
        route.get("appType").and_then(Value::as_str) == Some(app_type.as_str())
    });
    let (Some(route), Some((relay_share_id_value, _))) = (route, credential) else {
        return not_relay_import(ctx);
    };
    if !route_matches {
        return not_relay_import(ctx);
    }
    let name = {
        let name = value_or_empty(provider.get("name"));
        if name.is_empty() {
            let summary_name = value_or_empty(summary.get("name"));
            if summary_name.is_empty() {
                id
            } else {
                summary_name
            }
        } else {
            name
        }
    };
    let url = value_or_empty(route.get("url"));
    let code = encode_relay_share_code(
        &name,
        &app_type,
        &url,
        &relay_models_of(Some(&summary)),
        &relay_share_id_value,
        &js_string(&token),
    );
    express::json(
        ctx,
        200,
        &json!({ "ok": true, "code": code, "baseUrl": url }),
        &[],
    )
}

fn not_relay_import(ctx: &RequestCtx) -> Response<Body> {
    express::json(
        ctx,
        400,
        &json!({ "error": "这不是通过分享码导入的借道线路", "code": "not_relay_import" }),
        &[],
    )
}

/// `GET|HEAD /api/provider-defaults`.
async fn defaults_get(ctx: &RequestCtx, host_port_num: u16) -> Response<Body> {
    let Some(answer) = host(host_port_num, json!({ "op": "defaultsGet" })).await else {
        return unavailable(ctx);
    };
    if !succeeded(&answer) {
        return unavailable(ctx);
    }
    let defaults = answer.get("defaults").cloned().unwrap_or(Value::Null);
    express::json(ctx, 200, &defaults, &[])
}

/// `PUT /api/provider-defaults`.
async fn defaults_put(
    app: &Arc<App>,
    ctx: &RequestCtx,
    body: &Value,
    host_port_num: u16,
) -> Response<Body> {
    let _serialized = app.providers_write.lock().await;
    let Some(current) = host(host_port_num, json!({ "op": "defaultsGet" })).await else {
        return unavailable(ctx);
    };
    if !succeeded(&current) {
        return unavailable(ctx);
    }
    let mut next = match current.get("defaults") {
        Some(Value::Object(defaults)) => defaults.clone(),
        _ => Map::new(),
    };
    for (cli, raw) in defaults_updates(body_map(body)) {
        let Some(validated) = host(
            host_port_num,
            json!({ "op": "defaultsValidate", "cli": cli, "id": raw }),
        )
        .await
        else {
            return unavailable(ctx);
        };
        if !succeeded(&validated) || validated.get("valid") != Some(&Value::Bool(true)) {
            return express::json(ctx, 400, &invalid_defaults_error(&cli), &[]);
        }
        let value = validated.get("value").cloned().unwrap_or(Value::Null);
        next.insert(cli, value);
    }
    let Some(answer) = host(
        host_port_num,
        json!({ "op": "defaultsPersist", "next": Value::Object(next) }),
    )
    .await
    else {
        return unavailable(ctx);
    };
    if !succeeded(&answer) {
        return unavailable(ctx);
    }
    let defaults = answer.get("defaults").cloned().unwrap_or(Value::Null);
    express::json(ctx, 200, &json!({ "ok": true, "defaults": defaults }), &[])
}

/// Answers one claimed route.
pub async fn handle(
    app: &Arc<App>,
    route: Route,
    ctx: &RequestCtx,
    body: &Value,
    host_port_num: u16,
) -> Response<Body> {
    match route {
        Route::CatalogOptions => super::options(ctx, "GET,HEAD,POST"),
        Route::StatsOptions => super::options(ctx, "GET,HEAD"),
        Route::ImportOptions => super::options(ctx, "POST"),
        Route::ProviderOptions => super::options(ctx, "PATCH,DELETE"),
        Route::ProbeOptions | Route::ReassignOptions | Route::RelayShareOptions => {
            super::options(ctx, "POST")
        }
        Route::RelayModelsSyncOptions => super::options(ctx, "POST"),
        Route::RelayImportCodeOptions => super::options(ctx, "GET,HEAD"),
        Route::RelaySharesOptions | Route::RelayShareCodeOptions => super::options(ctx, "GET,HEAD"),
        Route::RelayShareDeleteOptions => super::options(ctx, "DELETE"),
        Route::DefaultsOptions => super::options(ctx, "GET,HEAD,PUT"),
        Route::CatalogGet => catalog(ctx, host_port_num).await,
        Route::StatsGet => stats(ctx, host_port_num).await,
        Route::ImportPost => import(app, ctx, host_port_num).await,
        Route::CreatePost => create(app, ctx, body, host_port_num).await,
        Route::ProviderPatch => update(app, ctx, body, host_port_num).await,
        Route::ProviderDelete => delete(app, ctx, host_port_num).await,
        Route::ProbePost => probe(ctx, body, host_port_num).await,
        Route::ReassignPost => reassign(app, ctx, body, host_port_num).await,
        Route::RelaySharePost => relay_share(app, ctx, body, host_port_num).await,
        Route::RelayModelsSyncPost => relay_models_sync(app, ctx, host_port_num).await,
        Route::RelayImportCodeGet => relay_import_code(ctx, host_port_num).await,
        Route::RelaySharesGet => relay_shares(ctx, host_port_num).await,
        Route::RelayShareDelete => relay_share_delete(app, ctx, host_port_num).await,
        Route::RelayShareCodeGet => relay_share_code(ctx, host_port_num).await,
        Route::DefaultsGet => defaults_get(ctx, host_port_num).await,
        Route::DefaultsPut => defaults_put(app, ctx, body, host_port_num).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claims_match_the_retired_express_routes() {
        assert_eq!(
            claim(&Method::GET, "/api/providers"),
            Some(Route::CatalogGet)
        );
        assert_eq!(
            claim(&Method::HEAD, "/api/Providers/"),
            Some(Route::CatalogGet)
        );
        assert_eq!(
            claim(&Method::POST, "/api/providers"),
            Some(Route::CreatePost)
        );
        assert_eq!(
            claim(&Method::OPTIONS, "/api/providers"),
            Some(Route::CatalogOptions)
        );
        assert_eq!(
            claim(&Method::GET, "/api/providers/stats"),
            Some(Route::StatsGet)
        );
        assert_eq!(
            claim(&Method::POST, "/api/providers/import"),
            Some(Route::ImportPost)
        );
        assert_eq!(
            claim(&Method::PATCH, "/api/providers/claude/work-1"),
            Some(Route::ProviderPatch)
        );
        assert_eq!(
            claim(&Method::DELETE, "/api/providers/claude/work-1"),
            Some(Route::ProviderDelete)
        );
        assert_eq!(
            claim(&Method::OPTIONS, "/api/providers/claude/work-1"),
            Some(Route::ProviderOptions)
        );
        // PATCH/DELETE are the only methods on the two-parameter path.
        assert_eq!(claim(&Method::GET, "/api/providers/claude/work-1"), None);
        assert_eq!(claim(&Method::POST, "/api/providers/claude/work-1"), None);
        assert_eq!(
            claim(&Method::POST, "/api/providers/claude/work-1/probe"),
            Some(Route::ProbePost)
        );
        // speedtest keeps streaming into Node.
        for method in ["POST", "GET", "OPTIONS", "HEAD"] {
            let method = Method::from_bytes(method.as_bytes()).unwrap();
            assert_eq!(
                claim(&method, "/api/providers/claude/work-1/speedtest"),
                None
            );
        }
        assert_eq!(
            claim(
                &Method::POST,
                "/api/providers/claude/work-1/reassign-sessions"
            ),
            Some(Route::ReassignPost)
        );
        assert_eq!(
            claim(&Method::POST, "/api/providers/claude/work-1/relay-share"),
            Some(Route::RelaySharePost)
        );
        assert_eq!(
            claim(
                &Method::POST,
                "/api/providers/claude/work-1/relay-models/sync"
            ),
            Some(Route::RelayModelsSyncPost)
        );
        assert_eq!(
            claim(
                &Method::GET,
                "/api/providers/claude/work-1/relay-import-code"
            ),
            Some(Route::RelayImportCodeGet)
        );
        assert_eq!(
            claim(&Method::GET, "/api/provider-relay-shares"),
            Some(Route::RelaySharesGet)
        );
        assert_eq!(
            claim(&Method::DELETE, "/api/provider-relay-shares/share-1"),
            Some(Route::RelayShareDelete)
        );
        assert_eq!(
            claim(&Method::GET, "/api/provider-relay-shares/share-1/code"),
            Some(Route::RelayShareCodeGet)
        );
        assert_eq!(
            claim(&Method::GET, "/api/provider-defaults"),
            Some(Route::DefaultsGet)
        );
        assert_eq!(
            claim(&Method::PUT, "/api/provider-defaults"),
            Some(Route::DefaultsPut)
        );
        assert_eq!(
            claim(&Method::OPTIONS, "/api/provider-defaults"),
            Some(Route::DefaultsOptions)
        );
    }

    #[test]
    fn unmatched_shapes_stay_with_node() {
        assert_eq!(claim(&Method::GET, "/api/providers/limit-history"), None);
        assert_eq!(claim(&Method::GET, "/api/providers/balances"), None);
        assert_eq!(
            claim(&Method::GET, "/api/providers/claude/work-1/balance"),
            None
        );
        assert_eq!(
            claim(&Method::POST, "/api/providers/claude/work-1/models"),
            None
        );
        assert_eq!(
            claim(&Method::GET, "/api/providers/claude/work-1/models"),
            None
        );
        assert_eq!(claim(&Method::GET, "/api/providers//"), None);
        assert_eq!(claim(&Method::GET, "/api/providers/claude//"), None);
        assert_eq!(claim(&Method::GET, "/API/providers"), None);
    }

    #[test]
    fn params_are_decoded_and_keep_their_case() {
        assert_eq!(
            provider_params("/api/providers/Claude/Work%201"),
            Some(("Claude".to_string(), "Work 1".to_string()))
        );
        assert_eq!(
            provider_params("/api/providers/claude/a%2Fb/probe"),
            Some(("claude".to_string(), "a/b".to_string()))
        );
        // A malformed escape is Express's 400, not a literal parameter.
        assert_eq!(provider_params("/api/providers/claude/%E0%A4%A"), None);
        assert_eq!(
            relay_share_id("/api/provider-relay-shares/Sh%20are/code"),
            Some("Sh are".to_string())
        );
    }

    #[test]
    fn query_values_keep_the_qs_shape() {
        let value = query_value(
            "/api/provider-relay-shares?appType=claude&appType=codex",
            "appType",
        );
        assert_eq!(query_json(&value), Some(json!(["claude", "codex"])));
        assert_eq!(query_json(&query_value("/x", "appType")), None);
    }
}
