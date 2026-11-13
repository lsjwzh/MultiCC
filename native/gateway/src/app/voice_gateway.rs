//! Voice-gateway routes retired from `src/routes/voice-gateway.js`:
//!
//! * `GET/HEAD /api/voice-gateways`, `GET/HEAD /api/v1/voice-gateways`
//! * `GET/HEAD /api/directories/:id/voice-gateway` and `/api/v1/...`
//! * `PUT` and `DELETE` on the same two paths
//!
//! Path matching (one decoded `:id` segment, exact case for `/api/` but
//! case-insensitive literal segments, one optional trailing slash), status
//! codes, bodies, header policy and error mapping live here and in
//! `multicc_core::voice_gateway_routes`. Node keeps the state Rust cannot see —
//! the gateway records and directory maps, commander binding, the
//! `sessionPersistence.mutate` transaction and the configured Node/ACP paths —
//! behind one host port, `POST /api/__host/voice-gateway`.
//!
//! Node answered list/inspect/ensure/remove synchronously on the event loop;
//! the write routes here await one host round trip, so
//! [`App::voice_gateway_write`] serializes them like the single-threaded
//! handlers did.

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Method, Response};
use multicc_core::provider_misc::api_meta;
use multicc_core::voice_gateway_routes as rules;
use serde_json::{json, Map, Value};

use crate::app::express::{self, RequestCtx};
use crate::app::App;
use crate::host_port;

/// The host port the Node child serves (`src/routes/voice-gateway-host.js`).
const HOST_PATH: &str = "/api/__host/voice-gateway";

const NO_STORE: &[(&str, &str)] = &[("Cache-Control", "no-store")];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    List { versioned: bool },
    Inspect { versioned: bool },
    Ensure { versioned: bool },
    Remove { versioned: bool },
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

pub fn claim(method: &Method, path: &str) -> Option<Route> {
    let parts = segments(path)?;
    let versioned = parts[0].eq_ignore_ascii_case("v1");
    let tail = if versioned { &parts[1..] } else { &parts[..] };
    match tail {
        [name] if name.eq_ignore_ascii_case("voice-gateways") => match method.as_str() {
            "GET" | "HEAD" => Some(Route::List { versioned }),
            "OPTIONS" => Some(Route::Options(rules::LIST_ALLOW)),
            _ => None,
        },
        [directory, id, name]
            if !id.is_empty()
                && directory.eq_ignore_ascii_case("directories")
                && name.eq_ignore_ascii_case("voice-gateway") =>
        {
            match method.as_str() {
                "GET" | "HEAD" => Some(Route::Inspect { versioned }),
                "PUT" => Some(Route::Ensure { versioned }),
                "DELETE" => Some(Route::Remove { versioned }),
                "OPTIONS" => Some(Route::Options(rules::DIRECTORY_ALLOW)),
                _ => None,
            }
        }
        _ => None,
    }
}

/// The raw (still percent-encoded) `:id` of the claimed directory path.
fn raw_id(path: &str) -> Option<&str> {
    let parts = segments(path)?;
    let versioned = parts[0].eq_ignore_ascii_case("v1");
    let tail = if versioned { &parts[1..] } else { &parts[..] };
    match tail {
        [directory, id, name]
            if !id.is_empty()
                && directory.eq_ignore_ascii_case("directories")
                && name.eq_ignore_ascii_case("voice-gateway") =>
        {
            Some(id)
        }
        _ => None,
    }
}

fn unavailable(ctx: &RequestCtx) -> Response<Body> {
    express::json(
        ctx,
        503,
        &json!({
            "error": "语音网关接口尚未就绪，请更新原生模块",
            "code": "rust_backend_unavailable",
        }),
        &[],
    )
}

/// What one host answer means to the route.
enum HostAnswer {
    /// `{ ok: true, ... }`: the operation-specific fields are checked next.
    Success,
    /// `{ ok: false, code, gatewayIds? }`.
    Failure {
        code: String,
        gateway_ids: Option<Value>,
    },
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
                gateway_ids: answer.get("gatewayIds").cloned(),
            },
            _ => HostAnswer::Invalid,
        },
        _ => match answer.get("thrown") {
            Some(thrown) if thrown.is_object() => HostAnswer::Thrown(thrown.clone()),
            _ => HostAnswer::Invalid,
        },
    }
}

/// `sendFailure`: the legacy `{ ok:false, error, gatewayIds? }` body or the v1
/// `createErrorDto` one, at the status `resultStatus` gives the code.
fn send_failure(
    ctx: &RequestCtx,
    versioned: bool,
    code: &str,
    gateway_ids: Option<&Value>,
) -> Response<Body> {
    let status = rules::result_status(code);
    let body = if versioned {
        rules::versioned_failure(code, &ctx.ids)
    } else {
        rules::legacy_failure(code, gateway_ids)
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

/// `next(error)` for a host throw: `voice_gateway_id_conflict` is the one code
/// the retired handler answered itself; everything else was safeErrorHandler's
/// opaque 500.
fn send_thrown(ctx: &RequestCtx, versioned: bool, thrown: &Value) -> Response<Body> {
    if thrown.get("code").and_then(Value::as_str) == Some("voice_gateway_id_conflict") {
        return send_failure(ctx, versioned, "voice_gateway_id_conflict", None);
    }
    let detail = thrown
        .get("message")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .unwrap_or("voice gateway host operation failed");
    let (status, body) = rules::thrown_failure(thrown, &ctx.ids);
    express::log_http_error(ctx, status, detail);
    express::json(ctx, status, &body, &[])
}

/// `GET|HEAD /api[/v1]/voice-gateways`.
async fn list(ctx: &RequestCtx, versioned: bool, host: u16) -> Response<Body> {
    let answer = match host_port::call(host, HOST_PATH, &json!({ "op": "list" })).await {
        Ok(value) => value,
        Err(_) => return unavailable(ctx),
    };
    let Some(gateways) = answer.get("gateways").and_then(Value::as_array) else {
        return unavailable(ctx);
    };
    let Some(launch) = answer.get("launch") else {
        return unavailable(ctx);
    };
    if !rules::launch_valid(launch) {
        return unavailable(ctx);
    }
    let mut items = Vec::with_capacity(gateways.len());
    for gateway in gateways {
        if !gateway.is_object() {
            return unavailable(ctx);
        }
        if versioned {
            items.push(gateway.clone());
        } else {
            match rules::with_launch(gateway, launch) {
                Some(value) => items.push(value),
                None => return unavailable(ctx),
            }
        }
    }
    let mut payload = Map::new();
    payload.insert("ok".into(), Value::Bool(true));
    payload.insert("gateways".into(), Value::Array(items));
    send_success(ctx, versioned, 200, payload, NO_STORE)
}

/// `GET|HEAD /api[/v1]/directories/:id/voice-gateway`.
async fn inspect(ctx: &RequestCtx, versioned: bool, id: &str, host: u16) -> Response<Body> {
    let answer = match host_port::call(host, HOST_PATH, &json!({ "op": "inspect", "id": id })).await
    {
        Ok(value) => value,
        Err(_) => return unavailable(ctx),
    };
    match classify(&answer) {
        HostAnswer::Failure { code, gateway_ids } => {
            send_failure(ctx, versioned, &code, gateway_ids.as_ref())
        }
        HostAnswer::Success => {
            let Some(gateway) = answer.get("gateway").filter(|value| value.is_object()) else {
                return unavailable(ctx);
            };
            let Some(launch) = answer.get("launch") else {
                return unavailable(ctx);
            };
            if !rules::launch_valid(launch) {
                return unavailable(ctx);
            }
            let gateway = if versioned {
                gateway.clone()
            } else {
                match rules::with_launch(gateway, launch) {
                    Some(value) => value,
                    None => return unavailable(ctx),
                }
            };
            let mut payload = Map::new();
            payload.insert("ok".into(), Value::Bool(true));
            payload.insert("gateway".into(), gateway);
            send_success(ctx, versioned, 200, payload, NO_STORE)
        }
        HostAnswer::Thrown(_) | HostAnswer::Invalid => unavailable(ctx),
    }
}

/// `PUT /api[/v1]/directories/:id/voice-gateway`.
async fn ensure(
    app: &Arc<App>,
    ctx: &RequestCtx,
    versioned: bool,
    id: &str,
    body: &Value,
    host: u16,
) -> Response<Body> {
    // The type check ran before the service was called, so it never sees the
    // request and no host round trip happens.
    if rules::auto_install_invalid(body) {
        return send_failure(ctx, versioned, "voice_gateway_auto_install_invalid", None);
    }
    let options = rules::put_options(body);
    let auto_install = rules::auto_install_flag(body);
    let _serialized = app.voice_gateway_write.lock().await;
    let answer = match host_port::call(
        host,
        HOST_PATH,
        &json!({
            "op": "ensure",
            "id": id,
            "options": options,
            "autoInstall": auto_install,
        }),
    )
    .await
    {
        Ok(value) => value,
        Err(_) => return unavailable(ctx),
    };
    match classify(&answer) {
        HostAnswer::Failure { code, gateway_ids } => {
            send_failure(ctx, versioned, &code, gateway_ids.as_ref())
        }
        HostAnswer::Thrown(thrown) => send_thrown(ctx, versioned, &thrown),
        HostAnswer::Invalid => unavailable(ctx),
        HostAnswer::Success => {
            let Some(created) = answer.get("created").and_then(Value::as_bool) else {
                return unavailable(ctx);
            };
            let Some(gateway) = answer.get("gateway").filter(|value| value.is_object()) else {
                return unavailable(ctx);
            };
            let Some(launch) = answer.get("launch") else {
                return unavailable(ctx);
            };
            if !rules::launch_valid(launch) {
                return unavailable(ctx);
            }
            let gateway = if versioned {
                gateway.clone()
            } else {
                match rules::with_launch(gateway, launch) {
                    Some(value) => value,
                    None => return unavailable(ctx),
                }
            };
            let mut payload = Map::new();
            payload.insert("ok".into(), Value::Bool(true));
            payload.insert("created".into(), Value::Bool(created));
            payload.insert("gateway".into(), gateway);
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

/// `DELETE /api[/v1]/directories/:id/voice-gateway`.
async fn remove(
    app: &Arc<App>,
    ctx: &RequestCtx,
    versioned: bool,
    id: &str,
    host: u16,
) -> Response<Body> {
    let _serialized = app.voice_gateway_write.lock().await;
    let answer = match host_port::call(host, HOST_PATH, &json!({ "op": "remove", "id": id })).await
    {
        Ok(value) => value,
        Err(_) => return unavailable(ctx),
    };
    match classify(&answer) {
        HostAnswer::Failure { code, gateway_ids } => {
            send_failure(ctx, versioned, &code, gateway_ids.as_ref())
        }
        HostAnswer::Thrown(thrown) => send_thrown(ctx, versioned, &thrown),
        HostAnswer::Invalid => unavailable(ctx),
        HostAnswer::Success => {
            // The retired handler answered the service's own `{ok,id,directoryId}`
            // object, so the host's keys and order are the body.
            let Some(object) = answer.as_object() else {
                return unavailable(ctx);
            };
            if !object.get("id").is_some_and(Value::is_string)
                || !object.get("directoryId").is_some_and(Value::is_string)
            {
                return unavailable(ctx);
            }
            send_success(ctx, versioned, 200, object.clone(), &[])
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
    if let Route::List { versioned } = route {
        return list(ctx, versioned, host).await;
    }
    let Some(raw) = raw_id(&ctx.path) else {
        return express::error(ctx, 400, "Failed to decode param");
    };
    // `req.params.id` went through decodeURIComponent; a malformed escape made
    // Express answer 400 before the handler ran.
    let id = match super::download::decode_uri_component(raw) {
        Some(id) => id,
        None => return express::error(ctx, 400, "Failed to decode param"),
    };
    match route {
        Route::Inspect { versioned } => inspect(ctx, versioned, &id, host).await,
        Route::Ensure { versioned } => ensure(app, ctx, versioned, &id, body, host).await,
        Route::Remove { versioned } => remove(app, ctx, versioned, &id, host).await,
        Route::List { .. } | Route::Options(_) => unreachable!("answered above"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claims_follow_express_matching() {
        assert_eq!(
            claim(&Method::GET, "/api/voice-gateways"),
            Some(Route::List { versioned: false })
        );
        assert_eq!(
            claim(&Method::HEAD, "/api/Voice-Gateways/"),
            Some(Route::List { versioned: false })
        );
        assert_eq!(
            claim(&Method::GET, "/api/v1/voice-gateways"),
            Some(Route::List { versioned: true })
        );
        assert_eq!(
            claim(&Method::OPTIONS, "/api/v1/voice-gateways"),
            Some(Route::Options(rules::LIST_ALLOW))
        );
        assert_eq!(
            claim(&Method::GET, "/api/directories/dir-1/voice-gateway"),
            Some(Route::Inspect { versioned: false })
        );
        assert_eq!(
            claim(&Method::GET, "/api/V1/Directories/dir-1/Voice-Gateway/"),
            Some(Route::Inspect { versioned: true })
        );
        assert_eq!(
            claim(&Method::PUT, "/api/v1/directories/dir-1/voice-gateway"),
            Some(Route::Ensure { versioned: true })
        );
        assert_eq!(
            claim(&Method::DELETE, "/api/directories/dir-1/voice-gateway"),
            Some(Route::Remove { versioned: false })
        );
        assert_eq!(
            claim(&Method::OPTIONS, "/api/directories/dir-1/voice-gateway"),
            Some(Route::Options(rules::DIRECTORY_ALLOW))
        );
        // Deeper paths still belong to Node (runtime, restart).
        for path in [
            "/api/directories/dir-1/voice-gateway/runtime",
            "/api/directories/dir-1/voice-gateway/restart",
            "/api/directories/dir-1/voice-gateway/extra/",
        ] {
            assert_eq!(claim(&Method::GET, path), None, "{path}");
        }
        // Exact segment count, no empty segment, exact-case `/api/` prefix.
        assert_eq!(claim(&Method::GET, "/api/directories//voice-gateway"), None);
        assert_eq!(claim(&Method::GET, "/api/directories/dir-1"), None);
        assert_eq!(claim(&Method::GET, "/API/voice-gateways"), None);
        assert_eq!(claim(&Method::GET, "/api/voice-gateways//"), None);
        assert_eq!(claim(&Method::GET, "/api/v1"), None);
        // Wrong methods were not routes.
        assert_eq!(claim(&Method::POST, "/api/voice-gateways"), None);
        assert_eq!(
            claim(&Method::POST, "/api/directories/dir-1/voice-gateway"),
            None
        );
        assert_eq!(
            claim(&Method::PATCH, "/api/directories/dir-1/voice-gateway"),
            None
        );
        assert_eq!(
            raw_id("/api/v1/directories/My%20Dir/voice-gateway"),
            Some("My%20Dir")
        );
    }
}
