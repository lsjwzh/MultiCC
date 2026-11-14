//! Voice runtime routes retired from `src/routes/voice-gateway-global.js`
//! (the global realtime-voice control plane) and
//! `src/routes/qwen-audio-runtime.js` (the runtime installer and the legacy
//! per-Fleet projections):
//!
//! * `GET|HEAD|PUT|DELETE /api/voice-gateway` and `/api/v1/...`
//! * `GET|HEAD /api/voice-gateway/runtime`
//! * `POST /api/voice-gateway/restart`
//! * `POST /api/voice-gateway/launch`
//! * `GET|HEAD /api/voice-gateway/launch/:launchId`
//! * `GET|HEAD /api/voice-runtime`
//! * `POST /api/voice-runtime/install`
//! * `GET|HEAD /api/directories/:id/voice-gateway/runtime`
//! * `POST /api/directories/:id/voice-gateway/restart`
//!
//! Path matching, status codes, bodies, header policy, the launch URL and the
//! Fleet projection live here and in `multicc_core::voice_runtime_routes`.
//! Node keeps the state Rust cannot see — the gateway records, the launch
//! registry, the runtime supervisor and the installer — behind one host port,
//! `POST /api/__host/voice-runtime`.
//!
//! The retired handlers ran every step to completion on one event loop; the
//! launch flow and every write here await host round trips, so
//! [`App::voice_runtime_write`] serializes them the same way. The launch flow
//! holds that lock across `launchBegin`, `launchEnd` and the response.

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Method, Response};
use multicc_core::provider_misc::api_meta;
use multicc_core::voice_runtime_routes as rules;
use serde_json::{json, Map, Value};

use crate::app::express::{self, RequestCtx};
use crate::app::App;
use crate::host_port;

/// The host port the Node child serves (`src/routes/voice-runtime-host.js`).
const HOST_PATH: &str = "/api/__host/voice-runtime";

const NO_STORE: &[(&str, &str)] = &[("Cache-Control", "no-store")];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    GlobalGet { versioned: bool },
    GlobalPut { versioned: bool },
    GlobalRemove { versioned: bool },
    GlobalRuntime { versioned: bool },
    GlobalRestart { versioned: bool },
    Launch { versioned: bool },
    LaunchResolve { versioned: bool },
    RuntimeGet { versioned: bool },
    RuntimeInstall { versioned: bool },
    FleetRuntime { versioned: bool },
    FleetRestart { versioned: bool },
    Options(&'static str),
}

/// Segment view of `/api/<rest>`, one optional trailing slash removed. Express
/// matches literal segments case-insensitively and a parameter as `[^/]+?`, so
/// an empty segment never matches.
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

fn is(segment: &str, literal: &str) -> bool {
    segment.eq_ignore_ascii_case(literal)
}

pub fn claim(method: &Method, path: &str) -> Option<Route> {
    let parts = segments(path)?;
    let versioned = parts[0].eq_ignore_ascii_case("v1");
    let tail = if versioned { &parts[1..] } else { &parts[..] };
    match tail {
        [name] if is(name, "voice-gateway") => match method.as_str() {
            "GET" | "HEAD" => Some(Route::GlobalGet { versioned }),
            "PUT" => Some(Route::GlobalPut { versioned }),
            "DELETE" => Some(Route::GlobalRemove { versioned }),
            "OPTIONS" => Some(Route::Options(rules::GLOBAL_ALLOW)),
            _ => None,
        },
        [name, runtime] if is(name, "voice-gateway") && is(runtime, "runtime") => {
            match method.as_str() {
                "GET" | "HEAD" => Some(Route::GlobalRuntime { versioned }),
                "OPTIONS" => Some(Route::Options(rules::RUNTIME_ALLOW)),
                _ => None,
            }
        }
        [name, restart] if is(name, "voice-gateway") && is(restart, "restart") => {
            match method.as_str() {
                "POST" => Some(Route::GlobalRestart { versioned }),
                "OPTIONS" => Some(Route::Options(rules::RESTART_ALLOW)),
                _ => None,
            }
        }
        [name, launch] if is(name, "voice-gateway") && is(launch, "launch") => {
            match method.as_str() {
                "POST" => Some(Route::Launch { versioned }),
                "OPTIONS" => Some(Route::Options(rules::LAUNCH_ALLOW)),
                _ => None,
            }
        }
        [name, launch, _id] if is(name, "voice-gateway") && is(launch, "launch") => {
            match method.as_str() {
                "GET" | "HEAD" => Some(Route::LaunchResolve { versioned }),
                "OPTIONS" => Some(Route::Options(rules::LAUNCH_RESOLVE_ALLOW)),
                _ => None,
            }
        }
        [name] if is(name, "voice-runtime") => match method.as_str() {
            "GET" | "HEAD" => Some(Route::RuntimeGet { versioned }),
            "OPTIONS" => Some(Route::Options(rules::VOICE_RUNTIME_ALLOW)),
            _ => None,
        },
        [name, install] if is(name, "voice-runtime") && is(install, "install") => {
            match method.as_str() {
                "POST" => Some(Route::RuntimeInstall { versioned }),
                "OPTIONS" => Some(Route::Options(rules::INSTALL_ALLOW)),
                _ => None,
            }
        }
        [directories, _id, gateway, runtime]
            if is(directories, "directories")
                && is(gateway, "voice-gateway")
                && is(runtime, "runtime") =>
        {
            match method.as_str() {
                "GET" | "HEAD" => Some(Route::FleetRuntime { versioned }),
                "OPTIONS" => Some(Route::Options(rules::FLEET_RUNTIME_ALLOW)),
                _ => None,
            }
        }
        [directories, _id, gateway, restart]
            if is(directories, "directories")
                && is(gateway, "voice-gateway")
                && is(restart, "restart") =>
        {
            match method.as_str() {
                "POST" => Some(Route::FleetRestart { versioned }),
                "OPTIONS" => Some(Route::Options(rules::FLEET_RESTART_ALLOW)),
                _ => None,
            }
        }
        _ => None,
    }
}

/// The raw (still percent-encoded) `:launchId` of a claimed resolve path.
fn raw_launch_id(path: &str) -> Option<&str> {
    let parts = segments(path)?;
    let versioned = parts[0].eq_ignore_ascii_case("v1");
    let tail = if versioned { &parts[1..] } else { &parts[..] };
    match tail {
        [name, launch, id] if is(name, "voice-gateway") && is(launch, "launch") => Some(id),
        _ => None,
    }
}

/// The raw (still percent-encoded) `:id` of a claimed Fleet path.
fn raw_directory_id(path: &str) -> Option<&str> {
    let parts = segments(path)?;
    let versioned = parts[0].eq_ignore_ascii_case("v1");
    let tail = if versioned { &parts[1..] } else { &parts[..] };
    match tail {
        [directories, id, gateway, suffix]
            if is(directories, "directories")
                && is(gateway, "voice-gateway")
                && (is(suffix, "runtime") || is(suffix, "restart")) =>
        {
            Some(id)
        }
        _ => None,
    }
}

fn unavailable(ctx: &RequestCtx) -> Response<Body> {
    express::json(ctx, 503, &rules::unavailable_body(), &[])
}

/// What one host answer means to the route.
enum HostAnswer {
    /// `{ ok: true, ... }`: the operation-specific fields are checked next.
    Success,
    /// `{ ok: false, code }`.
    Failure { code: String },
    /// `{ thrown: { code?, message } }` from a host write.
    Thrown(Value),
    /// Anything else is a stale or broken host.
    Invalid,
}

fn classify(answer: &Value) -> HostAnswer {
    match answer.get("ok") {
        Some(Value::Bool(true)) => HostAnswer::Success,
        Some(Value::Bool(false)) => match answer.get("code").and_then(Value::as_str) {
            Some(code) if !code.is_empty() => HostAnswer::Failure {
                code: code.to_string(),
            },
            _ => HostAnswer::Invalid,
        },
        _ => match answer.get("thrown") {
            Some(thrown) if thrown.is_object() => HostAnswer::Thrown(thrown.clone()),
            _ => HostAnswer::Invalid,
        },
    }
}

/// Ops whose frozen host contract has no `ok` envelope (`{status}`,
/// `{runtime}`, `{projectsGlobal, status}`, `{installed, runtime}`): a plain
/// answer is the success shape and the caller validates its fields. A
/// `{thrown}` (or a defensive `{ok:false, code}`) is still an error.
fn classify_plain(answer: &Value) -> HostAnswer {
    if let Some(thrown) = answer.get("thrown") {
        if thrown.is_object() {
            return HostAnswer::Thrown(thrown.clone());
        }
    }
    match answer.get("ok") {
        Some(Value::Bool(false)) => match answer.get("code").and_then(Value::as_str) {
            Some(code) if !code.is_empty() => HostAnswer::Failure {
                code: code.to_string(),
            },
            _ => HostAnswer::Invalid,
        },
        _ => HostAnswer::Success,
    }
}

/// The retired `fail()`: the legacy `{ ok:false, error }` body or the v1
/// `createErrorDto` one, at the status `statusForCode` gives the code.
fn send_failure(ctx: &RequestCtx, versioned: bool, code: &str) -> Response<Body> {
    let status = rules::result_status(code);
    let body = if versioned {
        rules::versioned_failure(code, &ctx.ids)
    } else {
        rules::legacy_failure(code)
    };
    express::json(ctx, status, &body, &[])
}

/// `sendSuccess`: the plain JSON body, or the v1 metadata envelope.
fn send_success(
    ctx: &RequestCtx,
    versioned: bool,
    status: u16,
    payload: Map<String, Value>,
    extra: &[(&str, &str)],
) -> Response<Body> {
    let body = if versioned {
        api_meta(payload, &ctx.ids.0, &ctx.ids.1)
    } else {
        Value::Object(payload)
    };
    express::json(ctx, status, &body, extra)
}

/// `next(error)`: `safeErrorHandler`'s opaque 500 with the thrown identifier
/// code, logged like the Node handler. The terminal handler answered every
/// version of these routes with the same `createErrorDto`, so the v1/legacy
/// distinction does not change this body.
fn send_thrown(ctx: &RequestCtx, _versioned: bool, thrown: &Value) -> Response<Body> {
    let detail = thrown
        .get("message")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .unwrap_or("voice runtime host operation failed");
    let (status, body) = rules::thrown_failure(thrown, &ctx.ids);
    express::log_http_error(ctx, status, detail);
    express::json(ctx, status, &body, &[])
}

fn success(ctx: &RequestCtx, versioned: bool, payload: Map<String, Value>) -> Response<Body> {
    send_success(ctx, versioned, 200, payload, NO_STORE)
}

// ── global control plane ───────────────────────────────────────────────────

/// `GET|HEAD /api[/v1]/voice-gateway`.
async fn global_get(ctx: &RequestCtx, versioned: bool, host: u16) -> Response<Body> {
    let answer = match host_port::call(host, HOST_PATH, &json!({ "op": "globalGet" })).await {
        Ok(value) => value,
        Err(_) => return unavailable(ctx),
    };
    let (Some(gateway), Some(legacy)) = (answer.get("gateway"), answer.get("legacy")) else {
        return unavailable(ctx);
    };
    let Some(base_url) = answer.get("baseUrl").and_then(Value::as_str) else {
        return unavailable(ctx);
    };
    let mut payload = Map::new();
    payload.insert("ok".into(), Value::Bool(true));
    payload.insert("gateway".into(), gateway.clone());
    payload.insert("legacy".into(), legacy.clone());
    payload.insert("baseUrl".into(), Value::String(base_url.to_string()));
    success(ctx, versioned, payload)
}

/// `PUT /api[/v1]/voice-gateway`.
async fn global_put(
    app: &Arc<App>,
    ctx: &RequestCtx,
    versioned: bool,
    body: &Value,
    host: u16,
) -> Response<Body> {
    // The type check ran before the service was called, so it never sees the
    // request and no host round trip happens.
    if rules::auto_install_invalid(body) {
        return send_failure(ctx, versioned, "voice_gateway_auto_install_invalid");
    }
    let payload = rules::global_put_payload(body);
    let _serialized = app.voice_runtime_write.lock().await;
    let answer = match host_port::call(host, HOST_PATH, &payload).await {
        Ok(value) => value,
        Err(_) => return unavailable(ctx),
    };
    match classify(&answer) {
        HostAnswer::Failure { code } => send_failure(ctx, versioned, &code),
        HostAnswer::Thrown(thrown) => send_thrown(ctx, versioned, &thrown),
        HostAnswer::Invalid => unavailable(ctx),
        HostAnswer::Success => {
            let Some(created) = answer.get("created").and_then(Value::as_bool) else {
                return unavailable(ctx);
            };
            let Some(gateway) = answer.get("gateway") else {
                return unavailable(ctx);
            };
            let mut payload = Map::new();
            payload.insert("ok".into(), Value::Bool(true));
            payload.insert("created".into(), Value::Bool(created));
            payload.insert("gateway".into(), gateway.clone());
            send_success(
                ctx,
                versioned,
                if created { 201 } else { 200 },
                payload,
                NO_STORE,
            )
        }
    }
}

/// `DELETE /api[/v1]/voice-gateway`. The retired handler never set
/// `Cache-Control` here, so neither does this route.
async fn global_remove(
    app: &Arc<App>,
    ctx: &RequestCtx,
    versioned: bool,
    host: u16,
) -> Response<Body> {
    let _serialized = app.voice_runtime_write.lock().await;
    let answer = match host_port::call(host, HOST_PATH, &json!({ "op": "globalRemove" })).await {
        Ok(value) => value,
        Err(_) => return unavailable(ctx),
    };
    match classify(&answer) {
        HostAnswer::Failure { code } => send_failure(ctx, versioned, &code),
        HostAnswer::Thrown(thrown) => send_thrown(ctx, versioned, &thrown),
        HostAnswer::Invalid => unavailable(ctx),
        HostAnswer::Success => {
            let mut payload = Map::new();
            payload.insert("ok".into(), Value::Bool(true));
            payload.insert("removed".into(), Value::Bool(true));
            send_success(ctx, versioned, 200, payload, &[])
        }
    }
}

/// `GET|HEAD /api[/v1]/voice-gateway/runtime`.
async fn global_runtime(ctx: &RequestCtx, versioned: bool, host: u16) -> Response<Body> {
    let answer = match host_port::call(host, HOST_PATH, &json!({ "op": "globalRuntime" })).await {
        Ok(value) => value,
        Err(_) => return unavailable(ctx),
    };
    match classify_plain(&answer) {
        HostAnswer::Failure { code } => send_failure(ctx, versioned, &code),
        HostAnswer::Success => {
            let Some(status) = answer.get("status") else {
                return unavailable(ctx);
            };
            let Some(runtime) = rules::without_url(status) else {
                return unavailable(ctx);
            };
            let mut payload = Map::new();
            payload.insert("ok".into(), Value::Bool(true));
            payload.insert("runtime".into(), runtime);
            success(ctx, versioned, payload)
        }
        HostAnswer::Thrown(_) | HostAnswer::Invalid => unavailable(ctx),
    }
}

/// `POST /api[/v1]/voice-gateway/restart`.
async fn global_restart(
    app: &Arc<App>,
    ctx: &RequestCtx,
    versioned: bool,
    host: u16,
) -> Response<Body> {
    let _serialized = app.voice_runtime_write.lock().await;
    let answer = match host_port::call(host, HOST_PATH, &json!({ "op": "globalRestart" })).await {
        Ok(value) => value,
        Err(_) => return unavailable(ctx),
    };
    match classify_plain(&answer) {
        HostAnswer::Failure { code } => send_failure(ctx, versioned, &code),
        HostAnswer::Thrown(thrown) => send_thrown(ctx, versioned, &thrown),
        HostAnswer::Invalid => unavailable(ctx),
        HostAnswer::Success => {
            // `{ ...(await runtime.restartGlobal() || {}), url: undefined }`.
            let runtime = match answer.get("status") {
                None | Some(Value::Null) => Value::Object(Map::new()),
                Some(status) => match rules::without_url(status) {
                    Some(runtime) => runtime,
                    None => return unavailable(ctx),
                },
            };
            let mut payload = Map::new();
            payload.insert("ok".into(), Value::Bool(true));
            payload.insert("runtime".into(), runtime);
            success(ctx, versioned, payload)
        }
    }
}

/// `POST /api[/v1]/voice-gateway/launch`: issue, start on demand, then hand
/// the browser a root-relative URL (or revoke and report why there is none).
async fn launch(
    app: &Arc<App>,
    ctx: &RequestCtx,
    versioned: bool,
    body: &Value,
    host: u16,
) -> Response<Body> {
    let _serialized = app.voice_runtime_write.lock().await;
    let begin = rules::launch_begin_payload(body);
    let answer = match host_port::call(host, HOST_PATH, &begin).await {
        Ok(value) => value,
        Err(_) => return unavailable(ctx),
    };
    let issued = match classify(&answer) {
        HostAnswer::Failure { code } => return send_failure(ctx, versioned, &code),
        HostAnswer::Thrown(thrown) => return send_thrown(ctx, versioned, &thrown),
        HostAnswer::Invalid => return unavailable(ctx),
        HostAnswer::Success => match rules::launch_issued(&answer) {
            Some(issued) => issued,
            None => return unavailable(ctx),
        },
    };
    let launch_id = issued.launch.get("id").cloned().unwrap_or(Value::Null);
    let url = rules::launch_url(
        issued.status.as_ref().and_then(|status| status.get("url")),
        launch_id.as_str().unwrap_or(""),
    );
    let Some(url) = url else {
        // No usable runtime URL: revoke the issue and report the runtime's
        // own error code, or "not running" when it has none.
        let _ = host_port::call(host, HOST_PATH, &rules::launch_revoke_payload(&launch_id)).await;
        let code = rules::launch_failure_code(issued.status.as_ref());
        return send_failure(ctx, versioned, &code);
    };
    // The host records the acknowledgement for its audit log; a logging hop
    // failing cannot undo a launch that already has a usable URL.
    let end = rules::launch_end_payload(&issued.launch, &issued.target_session_id);
    let _ = host_port::call(host, HOST_PATH, &end).await;
    let loopback = rules::loopback_only(ctx.headers.get("host"));
    let Value::Object(payload) = rules::launch_response(&issued.launch, &url, loopback) else {
        return unavailable(ctx);
    };
    send_success(ctx, versioned, 200, payload, NO_STORE)
}

/// `GET|HEAD /api[/v1]/voice-gateway/launch/:launchId`.
async fn launch_resolve(
    ctx: &RequestCtx,
    versioned: bool,
    launch_id: &str,
    host: u16,
) -> Response<Body> {
    let answer = match host_port::call(
        host,
        HOST_PATH,
        &json!({ "op": "launchResolve", "launchId": launch_id }),
    )
    .await
    {
        Ok(value) => value,
        Err(_) => return unavailable(ctx),
    };
    match classify(&answer) {
        HostAnswer::Failure { code } => send_failure(ctx, versioned, &code),
        HostAnswer::Success => {
            let Some(context) = answer.get("context") else {
                return unavailable(ctx);
            };
            let mut payload = Map::new();
            payload.insert("ok".into(), Value::Bool(true));
            payload.insert("context".into(), context.clone());
            success(ctx, versioned, payload)
        }
        HostAnswer::Thrown(_) | HostAnswer::Invalid => unavailable(ctx),
    }
}

// ── runtime installer and Fleet projections ────────────────────────────────

/// `GET|HEAD /api[/v1]/voice-runtime`.
async fn runtime_get(ctx: &RequestCtx, versioned: bool, host: u16) -> Response<Body> {
    let answer = match host_port::call(host, HOST_PATH, &json!({ "op": "runtimeGet" })).await {
        Ok(value) => value,
        Err(_) => return unavailable(ctx),
    };
    match classify_plain(&answer) {
        HostAnswer::Failure { code } => send_failure(ctx, versioned, &code),
        HostAnswer::Success => {
            let Some(runtime) = answer.get("runtime") else {
                return unavailable(ctx);
            };
            let mut payload = Map::new();
            payload.insert("ok".into(), Value::Bool(true));
            payload.insert("runtime".into(), runtime.clone());
            success(ctx, versioned, payload)
        }
        HostAnswer::Thrown(_) | HostAnswer::Invalid => unavailable(ctx),
    }
}

/// `POST /api[/v1]/voice-runtime/install`.
async fn runtime_install(
    app: &Arc<App>,
    ctx: &RequestCtx,
    versioned: bool,
    host: u16,
) -> Response<Body> {
    let _serialized = app.voice_runtime_write.lock().await;
    let answer = match host_port::call(host, HOST_PATH, &json!({ "op": "runtimeInstall" })).await {
        Ok(value) => value,
        Err(_) => return unavailable(ctx),
    };
    match classify_plain(&answer) {
        HostAnswer::Failure { code } => send_failure(ctx, versioned, &code),
        HostAnswer::Thrown(thrown) => send_thrown(ctx, versioned, &thrown),
        HostAnswer::Invalid => unavailable(ctx),
        HostAnswer::Success => {
            let Some(installed) = answer.get("installed").and_then(Value::as_bool) else {
                return unavailable(ctx);
            };
            let Some(runtime) = answer.get("runtime") else {
                return unavailable(ctx);
            };
            let mut payload = Map::new();
            payload.insert("ok".into(), Value::Bool(true));
            payload.insert("runtime".into(), runtime.clone());
            send_success(
                ctx,
                versioned,
                if installed { 200 } else { 202 },
                payload,
                NO_STORE,
            )
        }
    }
}

/// The `{ projectsGlobal, status }` answer both Fleet routes need.
fn fleet_answer(answer: &Value) -> Option<(bool, Value)> {
    let projects_global = answer.get("projectsGlobal")?.as_bool()?;
    let status = answer.get("status")?.clone();
    status.as_object()?;
    Some((projects_global, status))
}

fn fleet_runtime_value(projects_global: bool, status: &Value, id: &str) -> Option<Value> {
    if projects_global {
        rules::projection(status, id)
    } else {
        Some(status.clone())
    }
}

/// `GET|HEAD /api[/v1]/directories/:id/voice-gateway/runtime`: once the global
/// gateway exists the legacy per-Fleet endpoint reports that one child.
async fn fleet_runtime(ctx: &RequestCtx, versioned: bool, id: &str, host: u16) -> Response<Body> {
    let answer =
        match host_port::call(host, HOST_PATH, &json!({ "op": "fleetRuntime", "id": id })).await {
            Ok(value) => value,
            Err(_) => return unavailable(ctx),
        };
    match classify_plain(&answer) {
        HostAnswer::Failure { code } => send_failure(ctx, versioned, &code),
        HostAnswer::Success => {
            let Some((projects_global, status)) = fleet_answer(&answer) else {
                return unavailable(ctx);
            };
            let Some(runtime) = fleet_runtime_value(projects_global, &status, id) else {
                return unavailable(ctx);
            };
            let mut payload = Map::new();
            payload.insert("ok".into(), Value::Bool(true));
            payload.insert("runtime".into(), runtime);
            success(ctx, versioned, payload)
        }
        HostAnswer::Thrown(_) | HostAnswer::Invalid => unavailable(ctx),
    }
}

/// `POST /api[/v1]/directories/:id/voice-gateway/restart`.
async fn fleet_restart(
    app: &Arc<App>,
    ctx: &RequestCtx,
    versioned: bool,
    id: &str,
    host: u16,
) -> Response<Body> {
    let _serialized = app.voice_runtime_write.lock().await;
    let answer =
        match host_port::call(host, HOST_PATH, &json!({ "op": "fleetRestart", "id": id })).await {
            Ok(value) => value,
            Err(_) => return unavailable(ctx),
        };
    match classify_plain(&answer) {
        HostAnswer::Failure { code } => send_failure(ctx, versioned, &code),
        HostAnswer::Thrown(thrown) => send_thrown(ctx, versioned, &thrown),
        HostAnswer::Invalid => unavailable(ctx),
        HostAnswer::Success => {
            let Some((projects_global, status)) = fleet_answer(&answer) else {
                return unavailable(ctx);
            };
            let Some(runtime) = fleet_runtime_value(projects_global, &status, id) else {
                return unavailable(ctx);
            };
            let mut payload = Map::new();
            payload.insert("ok".into(), Value::Bool(true));
            payload.insert("runtime".into(), runtime);
            success(ctx, versioned, payload)
        }
    }
}

pub async fn handle(
    app: &Arc<App>,
    route: Route,
    ctx: &RequestCtx,
    body: &Value,
    host: u16,
) -> Response<Body> {
    if let Route::Options(allow) = route {
        return super::options(ctx, allow);
    }
    // `:launchId` / `:id` went through decodeURIComponent; a malformed escape
    // made Express answer 400 before the handler ran.
    match route {
        Route::GlobalGet { versioned } => global_get(ctx, versioned, host).await,
        Route::GlobalPut { versioned } => global_put(app, ctx, versioned, body, host).await,
        Route::GlobalRemove { versioned } => global_remove(app, ctx, versioned, host).await,
        Route::GlobalRuntime { versioned } => global_runtime(ctx, versioned, host).await,
        Route::GlobalRestart { versioned } => global_restart(app, ctx, versioned, host).await,
        Route::Launch { versioned } => launch(app, ctx, versioned, body, host).await,
        Route::LaunchResolve { versioned } => {
            let Some(raw) = raw_launch_id(&ctx.path) else {
                return express::error(ctx, 400, "Failed to decode param");
            };
            match super::download::decode_uri_component(raw) {
                Some(id) => launch_resolve(ctx, versioned, &id, host).await,
                None => express::error(ctx, 400, "Failed to decode param"),
            }
        }
        Route::RuntimeGet { versioned } => runtime_get(ctx, versioned, host).await,
        Route::RuntimeInstall { versioned } => runtime_install(app, ctx, versioned, host).await,
        Route::FleetRuntime { versioned } => {
            let Some(raw) = raw_directory_id(&ctx.path) else {
                return express::error(ctx, 400, "Failed to decode param");
            };
            match super::download::decode_uri_component(raw) {
                Some(id) => fleet_runtime(ctx, versioned, &id, host).await,
                None => express::error(ctx, 400, "Failed to decode param"),
            }
        }
        Route::FleetRestart { versioned } => {
            let Some(raw) = raw_directory_id(&ctx.path) else {
                return express::error(ctx, 400, "Failed to decode param");
            };
            match super::download::decode_uri_component(raw) {
                Some(id) => fleet_restart(app, ctx, versioned, &id, host).await,
                None => express::error(ctx, 400, "Failed to decode param"),
            }
        }
        Route::Options(_) => unreachable!("answered above"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claims_follow_express_matching() {
        assert_eq!(
            claim(&Method::GET, "/api/voice-gateway"),
            Some(Route::GlobalGet { versioned: false })
        );
        assert_eq!(
            claim(&Method::HEAD, "/api/Voice-Gateway/"),
            Some(Route::GlobalGet { versioned: false })
        );
        assert_eq!(
            claim(&Method::PUT, "/api/v1/voice-gateway"),
            Some(Route::GlobalPut { versioned: true })
        );
        assert_eq!(
            claim(&Method::DELETE, "/api/voice-gateway"),
            Some(Route::GlobalRemove { versioned: false })
        );
        assert_eq!(
            claim(&Method::OPTIONS, "/api/voice-gateway"),
            Some(Route::Options(rules::GLOBAL_ALLOW))
        );
        assert_eq!(
            claim(&Method::GET, "/api/v1/voice-gateway/runtime"),
            Some(Route::GlobalRuntime { versioned: true })
        );
        assert_eq!(
            claim(&Method::OPTIONS, "/api/voice-gateway/runtime"),
            Some(Route::Options(rules::RUNTIME_ALLOW))
        );
        assert_eq!(
            claim(&Method::POST, "/api/voice-gateway/restart"),
            Some(Route::GlobalRestart { versioned: false })
        );
        assert_eq!(
            claim(&Method::OPTIONS, "/api/v1/voice-gateway/restart"),
            Some(Route::Options(rules::RESTART_ALLOW))
        );
        assert_eq!(
            claim(&Method::POST, "/api/voice-gateway/launch"),
            Some(Route::Launch { versioned: false })
        );
        assert_eq!(
            claim(&Method::OPTIONS, "/api/voice-gateway/launch"),
            Some(Route::Options(rules::LAUNCH_ALLOW))
        );
        assert_eq!(
            claim(&Method::GET, "/api/voice-gateway/launch/abc-1"),
            Some(Route::LaunchResolve { versioned: false })
        );
        assert_eq!(
            claim(&Method::HEAD, "/api/V1/Voice-Gateway/Launch/abc-1/"),
            Some(Route::LaunchResolve { versioned: true })
        );
        assert_eq!(
            claim(&Method::OPTIONS, "/api/voice-gateway/launch/abc-1"),
            Some(Route::Options(rules::LAUNCH_RESOLVE_ALLOW))
        );
        assert_eq!(
            claim(&Method::GET, "/api/voice-runtime"),
            Some(Route::RuntimeGet { versioned: false })
        );
        assert_eq!(
            claim(&Method::HEAD, "/api/V1/Voice-Runtime/"),
            Some(Route::RuntimeGet { versioned: true })
        );
        assert_eq!(
            claim(&Method::OPTIONS, "/api/voice-runtime"),
            Some(Route::Options(rules::VOICE_RUNTIME_ALLOW))
        );
        assert_eq!(
            claim(&Method::POST, "/api/voice-runtime/install"),
            Some(Route::RuntimeInstall { versioned: false })
        );
        assert_eq!(
            claim(&Method::OPTIONS, "/api/voice-runtime/install"),
            Some(Route::Options(rules::INSTALL_ALLOW))
        );
        assert_eq!(
            claim(&Method::GET, "/api/directories/dir-1/voice-gateway/runtime"),
            Some(Route::FleetRuntime { versioned: false })
        );
        assert_eq!(
            claim(
                &Method::HEAD,
                "/api/V1/Directories/dir-1/Voice-Gateway/Runtime/"
            ),
            Some(Route::FleetRuntime { versioned: true })
        );
        assert_eq!(
            claim(
                &Method::OPTIONS,
                "/api/directories/dir-1/voice-gateway/runtime"
            ),
            Some(Route::Options(rules::FLEET_RUNTIME_ALLOW))
        );
        assert_eq!(
            claim(
                &Method::POST,
                "/api/directories/dir-1/voice-gateway/restart"
            ),
            Some(Route::FleetRestart { versioned: false })
        );
        assert_eq!(
            claim(
                &Method::OPTIONS,
                "/api/v1/directories/dir-1/voice-gateway/restart"
            ),
            Some(Route::Options(rules::FLEET_RESTART_ALLOW))
        );

        // Deeper paths, wrong methods, empty segments, exact-case prefix.
        for (method, path) in [
            (&Method::GET, "/api/voice-gateway/launch/a/b"),
            (&Method::GET, "/api/voice-gateway/runtime/x"),
            (&Method::GET, "/api/directories/dir-1/voice-gateway"),
            (
                &Method::GET,
                "/api/directories/dir-1/voice-gateway/runtime/x",
            ),
            (&Method::GET, "/api/voice-gateways"),
            (&Method::POST, "/api/voice-gateway"),
            (&Method::GET, "/api/voice-gateway/restart"),
            (&Method::GET, "/api/voice-runtime/install"),
            (&Method::DELETE, "/api/voice-runtime"),
            (&Method::GET, "/api/directories//voice-gateway/runtime"),
            (&Method::GET, "/api/voice-gateway/launch/"),
            (&Method::GET, "/API/voice-gateway"),
            (&Method::GET, "/api/voice-gateway//"),
        ] {
            assert_eq!(claim(method, path), None, "{method} {path}");
        }

        assert_eq!(
            raw_launch_id("/api/v1/voice-gateway/launch/My%20Launch"),
            Some("My%20Launch")
        );
        assert_eq!(
            raw_directory_id("/api/directories/My%20Dir/voice-gateway/restart"),
            Some("My%20Dir")
        );
        assert_eq!(
            raw_directory_id("/api/directories/My%20Dir/voice-gateway"),
            None
        );
    }
}
