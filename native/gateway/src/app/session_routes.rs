//! The session-management route cluster retired from `src/routes/session-memory.js`,
//! `session-bundle.js`, `session-lifecycle.js`, `session-create.js`,
//! `session-meta.js` and `session-profile.js`:
//!
//! * `GET|HEAD|PUT|DELETE /api/sessions/:id/memory`
//! * `POST                 /api/sessions/:id/memory/action`
//! * `GET|HEAD             /api/sessions/:id/bundle`
//! * `POST                 /api/sessions/import`
//! * `DELETE               /api/sessions/:id`
//! * `POST                 /api/sessions/:id/relocate`
//! * `POST                 /api/sessions/:id/restart`
//! * `POST                 /api/sessions/:id/restart-spawn`
//! * `POST                 /api/sessions/:id/vendor-login-terminal`
//! * `PUT                  /api/directories/:id/role-workers/:presetId`
//! * `POST                 /api/directories/:id/sessions`
//! * `POST                 /api/sessions/:id/notes`
//! * `GET|HEAD             /api/sessions/:id/liveness`
//! * `GET|HEAD             /api/sessions/:id/notes`
//! * `PATCH                /api/sessions/:id`
//! * `POST                 /api/sessions/:id/fork`
//!
//! Path matching, `:id`/`:presetId` decoding, query/body reads, the Express
//! `OPTIONS` answer and the internal execution-slot guard live here and in
//! `multicc_core::session_routes`. The handlers themselves are stateful and
//! process-local in a way Rust cannot see: they read the session/directory
//! `Map`s, spawn and kill CLI children, build a git bundle, encrypt with
//! `crypto`, stage configuration, fork transcripts, broadcast WebSocket frames
//! and append audit events. Node keeps exactly those facts behind one host
//! port, `POST /api/__host/session-routes` (`src/routes/session-routes-host.js`),
//! which answers `{ status, body }` — the status and JSON body the retired
//! Express handler produced — so the public contract stays byte-identical.
//!
//! Two routes deliberately stay in Node: `GET /api/sessions/:id/bundle.zip`
//! (`res.send` of an in-memory zip whose bytes carry timestamps) and
//! `POST /api/sessions/import-zip` (a raw 160 MB body). See
//! `multicc_core::session_routes`.
//!
//! The fifteen `/api/sessions/:id/…` routes (and `PATCH`/`DELETE` on the shared
//! `/api/sessions/:id` shape) all sat under the
//! `app.use('/api/sessions/:id', publicSessionAccessGuard)` mount session-admin
//! migrated, so they answer an internal execution slot with the very same
//! `{error:'session not found'}` 404 — before any business logic and before
//! `OPTIONS`. The guard helpers are reused verbatim from
//! [`super::session_admin`].
//!
//! Every write handler awaits one or more host round trips that mutate records,
//! workspaces or child processes; [`App::session_routes_write`] serializes them
//! the way the single Node event-loop thread did.

// Express refusals are values here (`Err(Response)`), so the error variant is a
// full response body; the same shape is allowed in `native/addon` and
// `native/cdpd` rather than boxing every refusal at every call site.
#![allow(clippy::result_large_err)]

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Method, Response};
use multicc_core::http_gate::{error_dto, query_param, QueryParam};
use multicc_core::session_routes;
pub use multicc_core::session_routes::Route;
use serde_json::{json, Map, Value};

use crate::app::express::{self, RequestCtx};
use crate::app::session_admin::guard_facts;
use crate::app::App;
use crate::host_port;

/// The host port the Node child serves (`src/routes/session-routes-host.js`).
/// `super::` so the agy account cluster can reuse the same executor port for
/// its login terminal: that op also creates a session record and needs the
/// PTY-only dependencies Node holds.
pub(super) const HOST_PATH: &str = "/api/__host/session-routes";

/// The query keys any route in the cluster reads. Express parses the whole
/// query string; sending only the keys the retired handlers touched keeps the
/// payload small and the shapes plain (every one of them is a scalar).
const QUERY_KEYS: &[&str] = &[
    "passphrase",
    "scopes",
    "skillsMode",
    "skills",
    "git",
    "context",
    "probe",
    "force",
];

pub fn claim(method: &Method, path: &str) -> Option<Route> {
    session_routes::claim(method.as_str(), path)
}

/// This cluster's own share of Express's automatic `OPTIONS` `Allow` for the
/// front-door union (`super::OPTIONS_SOURCES`): `/api/sessions/:id` contributes
/// `PATCH,DELETE`, the `import` literals `PATCH,POST,DELETE`, and so on.
pub fn options_share(path: &str) -> Option<String> {
    session_routes::options_share(path).map(|(allow, _)| allow.to_string())
}

/// Segment view of `/api/<rest>`, one optional trailing slash removed. Kept in
/// lockstep with `multicc_core::session_routes`.
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

fn part<'a>(parts: &[&'a str], index: usize) -> &'a str {
    parts.get(index).copied().unwrap_or("")
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
            "error": "会话管理接口尚未就绪，请更新原生模块",
            "code": "rust_backend_unavailable",
        }),
        &[],
    )
}

/// `req.body || {}`: Express leaves the parsed body as `{}` when a JSON body is
/// absent; only a missing or JSON-null value falls back here.
fn request_value(body: &Value) -> Value {
    match body {
        Value::Object(_) | Value::Array(_) => body.clone(),
        _ => Value::Object(Map::new()),
    }
}

/// `req.query` for the scalar keys this cluster reads. A repeated or nested key
/// (`QueryParam::Other`) is only ever compared against a string in the retired
/// handlers, for which `undefined` and an array/object are indistinguishable on
/// every branch this cluster takes, so it is omitted.
fn query_json(ctx: &RequestCtx) -> Value {
    let mut object = Map::new();
    for name in QUERY_KEYS {
        if let QueryParam::Text(text) = query_param(&ctx.original_url, name) {
            object.insert((*name).to_string(), Value::String(text));
        }
    }
    Value::Object(object)
}

/// The `:id` (or directory `:id`) segment index that the guard mount observes.
/// Every `/api/sessions/…` shape is under it; `/api/directories/…` is not.
fn guard_index(parts: &[&str]) -> Option<usize> {
    if parts.len() >= 2 && part(parts, 0).eq_ignore_ascii_case("sessions") {
        Some(1)
    } else {
        None
    }
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
    express::error(ctx, 500, "session route failed")
}

/// One host round trip carrying the op, the decoded parameters, the parsed
/// query and body. The host answers `{ ok: true, value }`; `value` is the
/// `{ status, body }` (or `{ threw, … }`) the retired handler produced.
pub(super) async fn call(
    ctx: &RequestCtx,
    host: u16,
    payload: Value,
) -> Result<Value, Response<Body>> {
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

/// Relay the `{ status, body }` the retired handler produced. A handler that
/// threw (the old `safeErrorHandler` path) carries `threw:true` plus the DTO
/// fields; the front door builds the same envelope with its own request ids.
pub(super) fn relay(ctx: &RequestCtx, answer: Value) -> Response<Body> {
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
    let body = answer.get("body").cloned().unwrap_or(Value::Null);
    express::json(ctx, status, &body, &[])
}

pub async fn handle(
    app: &Arc<App>,
    route: Route,
    ctx: &RequestCtx,
    body: &Value,
    host: u16,
) -> Response<Body> {
    let _serialized = if route.is_write() {
        Some(app.session_routes_write.lock().await)
    } else {
        None
    };
    answer(ctx, route, body, host).await
}

async fn answer(ctx: &RequestCtx, route: Route, body: &Value, host: u16) -> Response<Body> {
    let parts = segments(&ctx.path).unwrap_or_default();

    if let Route::Options {
        allow,
        guard_segment,
    } = route
    {
        // The retired `app.use('/api/sessions/:id', guard)` layer answered
        // OPTIONS too: it 404s internal execution slots before the automatic
        // Allow row is produced.
        if let Some(index) = guard_segment {
            let found = match guard_facts(host, part(&parts, index), ctx.method.as_str()).await {
                Ok(found) => found,
                Err(_) => return unavailable(ctx),
            };
            if found.internal {
                return super::session_admin::guarded_404(ctx, false);
            }
        }
        return super::options(ctx, allow);
    }

    // The same fail-closed guard in front of every business handler.
    if let Some(index) = guard_index(&parts) {
        let found = match guard_facts(host, part(&parts, index), ctx.method.as_str()).await {
            Ok(found) => found,
            Err(_) => return unavailable(ctx),
        };
        if found.internal {
            return super::session_admin::guarded_404(ctx, false);
        }
    }

    // Decode the path parameters the retired handler read (`req.params.id`,
    // `req.params.presetId`). `import` carries no session id.
    let id = if guard_index(&parts).is_some() || part(&parts, 0).eq_ignore_ascii_case("directories")
    {
        match decoded(ctx, part(&parts, 1)) {
            Ok(value) => Some(value),
            Err(response) => return response,
        }
    } else {
        None
    };
    let preset_id = if matches!(route, Route::RoleWorkersPut) {
        match decoded(ctx, part(&parts, 3)) {
            Ok(value) => Some(value),
            Err(response) => return response,
        }
    } else {
        None
    };

    let Some(op) = route.op() else {
        return express::error(ctx, 500, "native route has no host op");
    };
    let mut payload = Map::new();
    payload.insert("op".into(), Value::String(op.to_string()));
    payload.insert(
        "method".into(),
        Value::String(ctx.method.as_str().to_string()),
    );
    if let Some(id) = id {
        payload.insert("id".into(), Value::String(id));
    }
    if let Some(preset_id) = preset_id {
        payload.insert("presetId".into(), Value::String(preset_id));
    }
    payload.insert("query".into(), query_json(ctx));
    payload.insert("body".into(), request_value(body));

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
        assert_eq!(
            claim(&Method::GET, "/api/sessions/s1/memory"),
            Some(Route::MemoryGet)
        );
        assert_eq!(
            claim(&Method::PATCH, "/api/sessions/s1"),
            Some(Route::SessionPatch)
        );
        assert_eq!(claim(&Method::GET, "/api/sessions/s1"), None);
        assert_eq!(
            claim(&Method::POST, "/api/directories/d1/sessions"),
            Some(Route::DirectorySessionCreatePost)
        );
    }

    #[test]
    fn guard_index_only_covers_the_sessions_prefix() {
        assert_eq!(guard_index(&["sessions", "s1", "memory"]), Some(1));
        assert_eq!(guard_index(&["directories", "d1", "sessions"]), None);
        assert_eq!(guard_index(&["sessions"]), None);
    }
}
