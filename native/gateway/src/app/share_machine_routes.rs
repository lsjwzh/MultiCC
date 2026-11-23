//! The sharing / machines / workspaces route cluster retired from
//! `src/machines.js`, `src/routes/share.js` and `src/routes/workspaces.js`:
//!
//! * `GET|HEAD|POST      /api/machines`
//! * `GET|HEAD            /api/machines/self`, `/api/machines/grants`
//! * `POST                /api/machines/pair`, `/api/machines/:machineId/ws-ticket`
//! * `DELETE              /api/machines/connection`, `/api/machines/grants/:grantId`
//! * `PATCH|DELETE        /api/machines/:machineId`
//! * `POST                /api/sessions/:id/share`, `/api/sessions/:id/share-messages`
//! * `GET|HEAD            /api/sessions/:id/shares`
//! * `DELETE              /api/sessions/:id/share/:token`
//! * `GET|HEAD            /share/:token`
//! * `POST                /api/share/:token/auth`
//! * `GET|HEAD            /api/share/:token/{entry,history,session}`
//! * `GET|HEAD            /api/workspaces/overview`, `POST /api/workspaces/sweep`
//!
//! Path matching, parameter decoding, the automatic `OPTIONS` answer and the
//! internal execution-slot guard live in `multicc_core::share_machine_routes`
//! and [`super::session_admin`]. Everything else is a Node fact: the machine
//! registry and its grant store (already `multicc_core::machines`, reached
//! through the addon), the remote machine HTTP transport, the WS-ticket table
//! owned by the child's `AuthRuntime`, the share store and its password
//! cookies and the workspace scan/sweep runtime. The gateway renders the share page.
//! Node keeps exactly those behind one host port,
//! `POST /api/__host/share-machines` (`src/routes/share-machines-host.js`),
//! which answers `{ status, body, headers }` — the status, JSON body and
//! response headers the retired Express handler produced — so the public
//! contract stays byte-identical.
//!
//! Two paths are special:
//!
//! * `/share/:token` and the four `/api/share/:token/…` reads are the share
//!   token's own authority: Node's `httpEntry` exempts them from the access
//!   token/cookie gate for every method, and this module reuses that same
//!   predicate (never a second rule) so a guest can reach them.
//! * `POST /api/machines/:machineId/ws-ticket` mints its ticket through the
//!   child's `AuthRuntime` (`Reply::Ticket`), the same table the WS router in
//!   `src/ws/machines.js` consumes — the front door keeps no second store.
//!
//! `DELETE /api/machines/:machineId/proxy` and the SSE proxy stay whole in
//! Node: they stream binaries and never fit a JSON host port. Every method on
//! that path — including the `app.use` layer that answered its OPTIONS — is
//! forwarded.
//!
//! Every mutating op is serialized behind [`App::share_machine_write`] so the
//! single-threaded Node event-loop semantics survive.

// Express refusals are values here (`Err(Response)`), so the error variant is a
// full response body; the same shape is allowed elsewhere in the workspace.
#![allow(clippy::result_large_err)]

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Method, Response};
use multicc_core::auth_runtime::Snapshot;
use multicc_core::http_entry;
use multicc_core::http_gate::{
    self, error_dto, is_private_network_address, query_string, query_value, QueryValue,
};
use multicc_core::js::JsString;
pub use multicc_core::share_machine_routes::Route;
use multicc_core::share_machine_routes::{self, segments, BodyParser};
use serde_json::{json, Map, Value};

use crate::app::express::{self, RequestCtx};
use crate::app::session_admin::guard_facts;
use crate::app::App;
use crate::host_port;

/// The host port the Node child serves (`src/routes/share-machines-host.js`).
const HOST_PATH: &str = "/api/__host/share-machines";

/// The query keys any retired handler in this cluster read.
const QUERY_KEYS: &[&str] = &["before", "around", "limit", "orphans"];

/// The request headers the retired handlers read: `req.get('host')` and
/// `req.get('x-forwarded-proto')` build share links, `req.headers.cookie`
/// carries the share password cookie, `x-access-token` guards pairing and
/// `x-multicc-machine-grant` is the scoped credential
/// `DELETE /api/machines/connection` re-resolves. Nothing else is forwarded.
const HEADER_KEYS: &[&str] = &[
    "host",
    "x-forwarded-proto",
    "cookie",
    "x-access-token",
    "x-multicc-machine-grant",
];

pub fn claim(method: &Method, path: &str) -> Option<Route> {
    share_machine_routes::claim(method.as_str(), path)
}

/// This cluster's own share of Express's automatic `OPTIONS` `Allow` for the
/// front-door union (`super::OPTIONS_SOURCES`).
pub fn options_share(path: &str) -> Option<String> {
    share_machine_routes::options_share(path)
}

/// Whether `path` sits under the `app.use('/api/machines', …)` cross-site
/// guard mount (`src/machines.js`): the mount path or anything below it.
fn is_machine_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower == "/api/machines" || lower.starts_with("/api/machines/")
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
            "error": "分享与电脑接口尚未就绪，请更新原生模块",
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
    express::error(ctx, 500, "share route failed")
}

/// `req.query[name]` as the retired handlers read it:
/// `req.query.x && String(req.query.x)`. A repeated or nested key keeps qs's
/// shape and `String()` coercion, so `?around=a&around=b` still yields `a,b`.
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

/// The handful of request headers the retired handlers read, under their
/// lower-case names.
fn headers_json(ctx: &RequestCtx) -> Value {
    let mut object = Map::new();
    for name in HEADER_KEYS {
        if let Some(value) = ctx.headers.get(name) {
            object.insert((*name).to_string(), Value::String(value.to_string()));
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

/// The response headers the retired handler set through `res.set`/`res.type`
/// (`Cache-Control: no-store` on every machine answer, the share page's two
/// cache headers, the auth route's `Set-Cookie`).
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
    let headers = relay_headers(&answer);
    let body = answer.get("body").cloned().unwrap_or(Value::Null);
    express::json(ctx, status, &body, &headers)
}

/// `publicSessionAccessGuard`'s internal execution-slot refusal for the four
/// `/api/sessions/:id/…` share routes — before the handler and before OPTIONS,
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
    // The share surface is the token's own authority; Node's `httpEntry` marks
    // exactly these paths public for every method. Everything else keeps the
    // ordinary gate (machine grants, fleet grants, cookie or access token).
    let public = http_entry::public_path(ctx.method.as_str(), &JsString::from(ctx.path.as_str()));
    if !public {
        if let Some(refusal) = app.gate(ctx, peer, snapshot).await {
            return refusal;
        }
    }
    // `app.use('/api/machines', …)`: a cross-site page must never borrow the
    // loopback bypass or the paired grant. It ran after the auth gate and
    // before every machine route, OPTIONS included.
    if is_machine_path(&ctx.path)
        && ctx
            .headers
            .get("sec-fetch-site")
            .is_some_and(|value| value.eq_ignore_ascii_case("cross-site"))
    {
        return express::json(
            ctx,
            403,
            &json!({
                "ok": false,
                "code": "machine_cross_site_denied",
                "error": "不允许从其他网站访问多电脑接口",
            }),
            &[],
        );
    }

    let parts = segments(&ctx.path).unwrap_or_default();
    let guard_segment = match route {
        Route::Options { guard_segment, .. } => guard_segment,
        _ => share_machine_routes::guard_index(&parts),
    };
    if let Some(index) = guard_segment {
        if let Some(refusal) = guarded(ctx, index, &parts, host).await {
            return refusal;
        }
    }

    let _serialized = if route.is_write() {
        Some(app.share_machine_write.lock().await)
    } else {
        None
    };

    if let Route::Options { allow, .. } = route {
        return super::options(ctx, allow);
    }

    // `express.json` exactly where the retired mounts had it: the machines
    // cluster parsed with its own 16kb limit before the global 50mb parser, and
    // two of its DELETEs registered no parser at all.
    let request_body = match route.body_parser() {
        BodyParser::None => {
            drop(body);
            Value::Null
        }
        BodyParser::Json16k => match express::json_body(ctx, body, 16 * 1024).await {
            Ok(value) => value,
            Err(error) => return express::error(ctx, error.status, error.reason),
        },
        BodyParser::Global => match express::json_body(ctx, body, express::JSON_LIMIT).await {
            Ok(value) => value,
            Err(error) => return express::error(ctx, error.status, error.reason),
        },
    };

    if route == Route::SharePage {
        let page = share_machine_routes::page_segments(&ctx.path).unwrap_or_default();
        if let Err(response) = decoded(ctx, page.get(1).copied().unwrap_or("")) {
            return response;
        }
        return super::static_web_root::versioned(
            app,
            ctx,
            super::static_web_root::HtmlPage::Share,
        )
        .await;
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
    for &(name, index) in route.params() {
        let raw = parts.get(index).copied().unwrap_or("");
        match decoded(ctx, raw) {
            Ok(value) => {
                payload.insert(name.to_string(), Value::String(value));
            }
            Err(response) => return response,
        }
    }
    if !app.node_enabled {
        if matches!(route, Route::ShareEntry | Route::ShareAuth) {
            let token = payload["token"].as_str().unwrap_or_default().to_owned();
            return super::share_entry::handle(&app.data_root, ctx, route, token, request_body)
                .await;
        }
        let op = match route {
            Route::MachinesList => Some("list"),
            Route::MachinesSelf => Some("self"),
            Route::MachinesGrants => Some("grants"),
            Route::MachinesRename => Some("rename"),
            _ => None,
        };
        if let Some(op) = op {
            let input = json!({ "id": payload.get("machineId"), "name": request_body.get("name") });
            let root = app.data_root.clone();
            let result = tokio::task::spawn_blocking(move || {
                multicc_core::machines::local_operation(&root.to_string_lossy(), op, &input)
            })
            .await;
            return match result {
                Ok(reply) => express::json(
                    ctx,
                    reply["status"].as_u64().unwrap_or(500) as u16,
                    &reply["data"],
                    &[("Cache-Control", "no-store")],
                ),
                Err(_) => unavailable(ctx),
            };
        }
    }
    payload.insert("query".into(), query_json(ctx));
    payload.insert("headers".into(), headers_json(ctx));
    payload.insert("body".into(), request_body);

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
            claim(&Method::GET, "/api/machines"),
            Some(Route::MachinesList)
        );
        assert_eq!(
            claim(&Method::DELETE, "/api/machines/grants/g1"),
            Some(Route::MachinesGrantRevoke)
        );
        assert_eq!(claim(&Method::GET, "/share/t1"), Some(Route::SharePage));
        assert_eq!(
            claim(&Method::POST, "/api/share/t1/auth"),
            Some(Route::ShareAuth)
        );
        assert_eq!(claim(&Method::GET, "/api/machines/m1/proxy"), None);
        assert_eq!(claim(&Method::GET, "/api/sessions/s1"), None);
    }

    #[test]
    fn options_share_matches_the_measured_allow() {
        assert_eq!(
            options_share("/api/machines/connection").as_deref(),
            Some("DELETE,PATCH")
        );
        assert_eq!(
            options_share("/api/machines/grants/ws-ticket").as_deref(),
            Some("DELETE,POST")
        );
        assert_eq!(options_share("/share/t1").as_deref(), Some("GET,HEAD"));
        assert_eq!(options_share("/api/machines/m1/proxy"), None);
    }

    #[test]
    fn machine_path_is_the_guard_mount() {
        assert!(is_machine_path("/api/machines"));
        assert!(is_machine_path("/api/machines/"));
        assert!(is_machine_path("/api/machines/self"));
        assert!(is_machine_path("/API/Machines/m1/proxy"));
        assert!(!is_machine_path("/api/machinesx"));
        assert!(!is_machine_path("/api/share/t1/entry"));
    }

    #[test]
    fn relay_headers_keeps_the_handler_pairs() {
        let answer = json!({
            "status": 200,
            "body": {},
            "headers": [["Cache-Control", "no-store"], ["Set-Cookie", "a=b"]],
        });
        assert_eq!(
            relay_headers(&answer),
            vec![("Cache-Control", "no-store"), ("Set-Cookie", "a=b")]
        );
        assert!(relay_headers(&json!({ "status": 200 })).is_empty());
    }
}
