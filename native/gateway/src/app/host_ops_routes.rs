//! The host-and-system-operations route cluster retired from
//! `src/routes/{server-restart-route,update-route,developer-tools,
//! macos-privacy,ops-terminal,host-write,host-power,skill-sync,doctor,
//! env-doctor}.js` — the 40 routes listed in
//! [`multicc_core::host_ops_routes`].
//!
//! Path matching, parameter decoding, the automatic `OPTIONS` answer and the
//! session access guard live in `multicc_core::host_ops_routes` and
//! [`super::session_admin`]. Everything else is a Node or host fact: the
//! detached restart/update launchers (`src/server-restart.js`,
//! `src/update-runner.js`), the Xcode/Git toolchain probes, the macOS TCC and
//! power services, the Agent provisioner, the shell environment probe and
//! repair terminal, the `.env` writer and the tunnel/push runtimes, the skill
//! sync runtime, and the doctor / environment-doctor services. Node keeps
//! exactly those behind one host port, `POST /api/__host/host-ops`
//! (`src/routes/host-ops-host.js`). Doctor operations return their service
//! result for the gateway to present. Other operations answer `{ status, body, headers }`
//! — the status, JSON body and response headers the retired Express handler
//! produced — so the public contract stays byte-identical.
//!
//! Two process-level routes are deliberately only *validated* here:
//! `POST /api/restart` and `POST /api/update` decide the DTO (202/409/503,
//! `activeStreaming`, `targetVersion`, request ids) in Rust but the detached
//! launcher stays in the host port. The front door never starts a restart or
//! an update itself, so a differential that injects a fake spawn can drive the
//! whole branch without changing the running service.
//!
//! Locality is decided here, on the real client address, and passed to the
//! host as one boolean. The Node child sees every host-port call as loopback
//! (`host_port::call` writes `PROXY TCP4 127.0.0.1 127.0.0.1`), so the retired
//! `isLocal(req)` checks would otherwise always be true.
//!
//! Every mutating op is serialized behind [`App::host_ops_write`] so the
//! single-threaded Node event-loop semantics survive.

// Express refusals are values here (`Err(Response)`), so the error variant is a
// full response body; the same shape is allowed elsewhere in the workspace.
#![allow(clippy::result_large_err)]

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Method, Response};
use multicc_core::auth_runtime::Snapshot;
pub use multicc_core::host_ops_routes::Route;
use multicc_core::host_ops_routes::{self, segments, BodyParser};
use multicc_core::http_gate::{
    self, error_dto, is_private_network_address, query_string, query_value, QueryValue,
};
use serde_json::{json, Map, Value};

use crate::app::express::{self, RequestCtx};
use crate::app::session_admin::guard_facts;
use crate::app::App;
use crate::host_port;

/// The host port the Node child serves (`src/routes/host-ops-host.js`).
const HOST_PATH: &str = "/api/__host/host-ops";

/// The only query key a retired handler in this cluster read:
/// `GET /api/system/ops-run` takes `req.query.from` as its output offset.
const QUERY_KEYS: &[&str] = &["from"];

pub fn claim(method: &Method, path: &str) -> Option<Route> {
    host_ops_routes::claim(method.as_str(), path)
}

/// This cluster's own share of Express's automatic `OPTIONS` `Allow` for the
/// front-door union (`super::OPTIONS_SOURCES`).
pub fn options_share(path: &str) -> Option<String> {
    host_ops_routes::options_share(path)
}

/// `decodeURIComponent` for one parameter; `None` is Express's 400.
fn decoded(ctx: &RequestCtx, raw: &str) -> Result<String, Response<Body>> {
    super::download::decode_uri_component(raw)
        .ok_or_else(|| express::error(ctx, 400, "Failed to decode param"))
}

fn unavailable(ctx: &RequestCtx) -> Response<Body> {
    express::json(
        ctx,
        503,
        &json!({
            "error": "宿主与系统操作接口尚未就绪，请更新原生模块",
            "code": "rust_backend_unavailable",
        }),
        &[],
    )
}

/// The host answered a non-200: the operation ran and threw, which the retired
/// `safeErrorHandler` rendered as a 500. Anything else (connect refusal, reset,
/// timeout, truncated reply) means we never got a complete answer: the 503.
fn answered_but_failed(error: &std::io::Error) -> bool {
    if error.kind() != std::io::ErrorKind::InvalidData {
        return false;
    }
    let text = error.to_string();
    text.starts_with("host port: status ") || text == "host port: chunked reply"
}

fn host_failed(ctx: &RequestCtx) -> Response<Body> {
    express::error(ctx, 500, "host operation failed")
}

/// `req.query[name]` as the retired `GET /api/system/ops-run` read it:
/// `req.query && req.query.from`. A repeated key keeps qs's comma join.
fn query_json(ctx: &RequestCtx) -> Value {
    let mut object = Map::new();
    for name in QUERY_KEYS {
        match query_value(&ctx.original_url, name) {
            QueryValue::Missing => {}
            value => {
                object.insert((*name).to_string(), Value::String(query_string(&value)));
            }
        }
    }
    Value::Object(object)
}

/// One host round trip carrying the op, the decoded parameters and the facts
/// the retired handler read. The host answers `{ ok: true, value }`; `value` is
/// the `{ status, body, headers }` (or `{ threw, … }`) the retired handler
/// produced.
async fn call(ctx: &RequestCtx, host: u16, payload: Value) -> Result<Value, Response<Body>> {
    match host_port::call(host, HOST_PATH, &payload).await {
        Ok(answer) if answer.get("ok") == Some(&Value::Bool(true)) => {
            Ok(answer.get("value").cloned().unwrap_or(Value::Null))
        }
        Ok(_) => Err(host_failed(ctx)),
        Err(error) => {
            if answered_but_failed(&error) {
                Err(host_failed(ctx))
            } else {
                Err(unavailable(ctx))
            }
        }
    }
}

/// Doctor services own jobs, probes and cancellation in the live host. Only
/// their arguments and results cross the port. Keep request fields that were
/// actually present so absence and JSON null remain distinct.
fn doctor_input(route: &Route, params: &Map<String, Value>, body: &Value) -> Option<Value> {
    let mut input = Map::new();
    match route {
        Route::EnvDoctorStart => {
            for field in ["error", "path", "fix", "recent", "lang"] {
                if let Some(value) = body.get(field) {
                    input.insert(field.to_string(), value.clone());
                }
            }
        }
        Route::SessionDoctorStart => {
            input.insert("sessionId".into(), params.get("id")?.clone());
            input.insert("autofix".into(), Value::Bool(body["autofix"] == true));
            if let Some(note) = body.get("note") {
                input.insert("note".into(), note.clone());
            }
        }
        Route::SessionDoctorList => return params.get("id").cloned(),
        Route::DoctorRun | Route::DoctorCancel | Route::EnvDoctorRun | Route::EnvDoctorCancel => {
            return params.get("runId").cloned();
        }
        _ => return None,
    }
    Some(Value::Object(input))
}

fn doctor_response(ctx: &RequestCtx, route: &Route, answer: Value) -> Response<Body> {
    use multicc_core::js::serde::truthy;
    if answer["threw"] == true {
        return relay(ctx, answer);
    }
    let result = &answer["result"];
    let (status, body) = match route {
        Route::EnvDoctorStart | Route::SessionDoctorStart if result.is_null() => {
            return host_failed(ctx);
        }
        Route::EnvDoctorStart | Route::SessionDoctorStart if !truthy(&result["ok"]) => {
            let mut body = json!({ "ok": false });
            if matches!(route, Route::EnvDoctorStart) {
                if let Some(code) = result.get("code") {
                    body["code"] = code.clone();
                }
            }
            if let Some(error) = result.get("error") {
                body["error"] = error.clone();
            }
            (result["status"].as_u64().unwrap_or(400) as u16, body)
        }
        Route::EnvDoctorStart | Route::SessionDoctorStart => (200, result.clone()),
        Route::DoctorRun if !truthy(result) => (404, json!({"error": "doctor run not found"})),
        Route::EnvDoctorRun if !truthy(result) => (
            404,
            json!({"ok": false, "code": "NOT_FOUND", "error": "diagnosis not found"}),
        ),
        Route::DoctorRun => (200, json!({ "run": result })),
        Route::EnvDoctorRun => (200, json!({ "ok": true, "run": result })),
        Route::SessionDoctorList | Route::DoctorCancel | Route::EnvDoctorCancel => {
            let key = if matches!(route, Route::SessionDoctorList) {
                "runs"
            } else {
                "ok"
            };
            let mut body = json!({});
            if let Some(value) = answer.get("result") {
                body[key] = value.clone();
            }
            (200, body)
        }
        _ => unreachable!("only doctor operations carry a service result"),
    };
    express::json(ctx, status, &body, &[])
}

/// The response headers the retired handler set through `res.set`
/// (`Cache-Control: no-store` on the Agent permission/install reads).
fn relay_headers(answer: &Value) -> Vec<(&str, &str)> {
    answer
        .get("headers")
        .and_then(Value::as_array)
        .map(|pairs| {
            pairs
                .iter()
                .filter_map(|pair| {
                    let pair = pair.as_array()?;
                    Some((pair.first()?.as_str()?, pair.get(1)?.as_str()?))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Relay the answer the retired handler produced. A handler that threw out of
/// its own `try` (the old `safeErrorHandler` path) carries `threw:true` plus the
/// DTO fields; the front door builds the same envelope with its own request ids,
/// never leaking the thrown message.
fn relay(ctx: &RequestCtx, answer: Value) -> Response<Body> {
    if answer.get("threw") == Some(&Value::Bool(true)) {
        let status = answer.get("status").and_then(Value::as_u64).unwrap_or(500) as u16;
        let code = answer
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("internal_error");
        let message = answer
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("internal_error");
        return express::json(ctx, status, &error_dto(code, message, &[], &ctx.ids), &[]);
    }
    let status = answer.get("status").and_then(Value::as_u64).unwrap_or(500) as u16;
    let headers = relay_headers(&answer);
    // A body-less `res.status(500).end()`: no Content-Type and no ETag.
    if answer.get("bare") == Some(&Value::Bool(true)) {
        let mut builder = express::with_base_headers(Response::builder().status(status), ctx);
        builder = express::header(builder, "Content-Length", "0");
        express::log_request(ctx, status);
        return builder.body(Body::empty()).expect("static response parts");
    }
    if let Some(content_type) = answer.get("contentType").and_then(Value::as_str) {
        let body = answer
            .get("body")
            .and_then(Value::as_str)
            .unwrap_or("")
            .as_bytes()
            .to_vec();
        return express::send(ctx, status, content_type, body, &headers);
    }
    let body = answer.get("body").cloned().unwrap_or(Value::Null);
    express::json(ctx, status, &body, &headers)
}

/// `publicSessionAccessGuard`'s internal execution-slot refusal for the two
/// `/api/sessions/:id/doctor` routes — before the handler and before OPTIONS,
/// exactly like the `app.use` mount it replaces.
async fn guarded(
    ctx: &RequestCtx,
    index: usize,
    parts: &[&str],
    host: u16,
) -> Option<Response<Body>> {
    let id = parts.get(index).copied().unwrap_or("");
    let found = match guard_facts(host, id, ctx.method.as_str()).await {
        Ok(found) => found,
        Err(_) => return Some(unavailable(ctx)),
    };
    found
        .internal
        .then(|| super::session_admin::guarded_404(ctx, false))
}

pub async fn handle(
    app: &Arc<App>,
    route: Route,
    ctx: &RequestCtx,
    body: Body,
    peer: &str,
    snapshot: &Snapshot,
    host: u16,
) -> Response<Body> {
    // Node's `gate('peer')` runs for every path, public ones included.
    if app.lan_only && !is_private_network_address(peer) {
        return express::json(
            ctx,
            403,
            &http_gate::public_peer_rejected_dto(&ctx.ids),
            &[],
        );
    }
    if let Some(refusal) = app.gate(ctx, peer, snapshot).await {
        return refusal;
    }

    let parts = segments(&ctx.path).unwrap_or_default();
    let guard_segment = match route {
        Route::Options { guard_segment, .. } => guard_segment,
        _ => host_ops_routes::guard_index(&parts),
    };
    if let Some(index) = guard_segment {
        if let Some(refusal) = guarded(ctx, index, &parts, host).await {
            return refusal;
        }
    }

    let _serialized = if route.is_write() {
        Some(app.host_ops_write.lock().await)
    } else {
        None
    };

    if let Route::Options { allow, .. } = route {
        return super::options(ctx, allow);
    }

    // Every route in this cluster sits after the global `express.json`.
    let request_body = match route.body_parser() {
        BodyParser::Global => match express::json_body(ctx, body, express::JSON_LIMIT).await {
            Ok(value) => value,
            Err(error) => return express::error(ctx, error.status, error.reason),
        },
    };

    if !app.node_enabled && route == Route::SettingsNotify {
        return super::notification_reads::save(app, ctx, request_body).await;
    }
    if !app.node_enabled && route == Route::UpdateStatus {
        return super::update_status::read(app, ctx).await;
    }
    let Some(op) = route.op() else {
        return express::error(ctx, 500, "native route has no host op");
    };
    let mut payload = Map::new();
    payload.insert("op".into(), Value::String(op.to_string()));
    payload.insert(
        "method".into(),
        Value::String(ctx.method.as_str().to_string()),
    );
    payload.insert(
        "originalUrl".into(),
        Value::String(ctx.original_url.clone()),
    );
    for (name, index) in route.params() {
        let raw = parts.get(*index).copied().unwrap_or("");
        match decoded(ctx, raw) {
            Ok(value) => {
                payload.insert((*name).to_string(), Value::String(value));
            }
            Err(response) => return response,
        }
    }
    if let Some(input) = doctor_input(&route, &payload, &request_body) {
        return match call(ctx, host, json!({ "op": op, "input": input })).await {
            Ok(answer) => doctor_response(ctx, &route, answer),
            Err(response) => response,
        };
    }
    payload.insert("query".into(), query_json(ctx));
    payload.insert("body".into(), request_body);
    // The Node child sees every host-port call as loopback; the decision is
    // made here on the real client address and passed as one fact.
    payload.insert(
        "local".into(),
        Value::Bool(http_gate::is_local_request(peer, &ctx.headers)),
    );
    // `req.id` is echoed by the restart/update failure DTOs. Both sides derive
    // it from the same `X-Request-Id` rule (`http_gate::request_ids`).
    payload.insert("requestId".into(), Value::String(ctx.ids.0.clone()));

    match call(ctx, host, Value::Object(payload)).await {
        Ok(answer) => relay(ctx, answer),
        Err(response) => response,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claim_delegates_to_the_kernel() {
        assert_eq!(claim(&Method::POST, "/api/restart"), Some(Route::Restart));
        assert_eq!(
            claim(&Method::POST, "/api/settings/power/unlock-password"),
            Some(Route::SettingsPowerUnlockPasswordSet)
        );
        assert_eq!(
            claim(&Method::DELETE, "/api/settings/power/unlock-password"),
            Some(Route::SettingsPowerUnlockPasswordClear)
        );
        assert_eq!(
            claim(&Method::POST, "/api/tunnel/restart/natapp"),
            Some(Route::TunnelRestart)
        );
        assert_eq!(
            claim(&Method::GET, "/api/sessions/s1/doctor"),
            Some(Route::SessionDoctorList)
        );
        assert_eq!(claim(&Method::GET, "/api/restart"), None);
        assert_eq!(
            claim(&Method::POST, "/api/settings/power"),
            Some(Route::SettingsPower)
        );
    }

    #[test]
    fn options_share_is_this_clusters_method_list() {
        assert_eq!(
            options_share("/api/system/ops-run").as_deref(),
            Some("GET,HEAD,POST")
        );
        assert_eq!(
            options_share("/api/settings/power/unlock-password").as_deref(),
            Some("POST,DELETE")
        );
        assert_eq!(
            options_share("/api/settings/power").as_deref(),
            Some("POST")
        );
        assert_eq!(
            options_share("/api/sessions/s1/doctor").as_deref(),
            Some("POST,GET,HEAD")
        );
        assert_eq!(options_share("/api/not-a-route"), None);
    }

    #[test]
    fn relay_headers_keeps_the_handler_pairs() {
        let answer = json!({
            "status": 200,
            "body": {},
            "headers": [["Cache-Control", "no-store"]],
        });
        assert_eq!(relay_headers(&answer), vec![("Cache-Control", "no-store")]);
        assert!(relay_headers(&json!({ "status": 200 })).is_empty());
    }
}
