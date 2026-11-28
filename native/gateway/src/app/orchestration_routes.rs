//! The orchestration and unattended route cluster retired from
//! `src/routes/{aux-goal,aux-runs,orchestration}.js` and
//! `src/unattended/routes.js` -- the 30 routes listed in
//! [`multicc_core::orchestration_routes`].
//!
//! Path matching, parameter decoding, the automatic `OPTIONS` answer, the
//! public-session access guard (both the `/api/sessions/:id` and the
//! `/api/v1/sessions/:id` mounts) and the query subset live here and in the
//! core crate. Everything else is a Node fact: the session record map, the
//! unattended supervisor, the Aux queue and its provider/model configuration,
//! the durable orchestration runtime (scheduled messages, operations, the FIFO
//! scheduler), the Aux run log and the live chat turn engine. Node keeps exactly
//! those behind one host port, `POST /api/__host/orchestration`
//! (`src/routes/orchestration-host.js`), which answers `{ status, body,
//! headers }` -- the status, JSON body and response headers the retired Express
//! handler produced -- so the public contract stays byte-identical.
//!
//! Seven neighbouring routes (the wait injector and the detached set) are
//! deliberately not claimed and keep running on Node. In particular
//! `GET /api/v1/sessions/:id/waits` is ours and `GET /api/sessions/:id/waits` is
//! not; see the core module for how [`claim`] tells them apart.
//!
//! The internal-execution-slot guard is session-admin's, reused as-is
//! ([`guard_facts`] / [`guarded_404`]): an internal slot gets the same 404 as a
//! missing session before any handler runs, in the v1 error envelope under
//! `/api/v1/` and the bare envelope everywhere else. The guard runs before the
//! global JSON parser (that is where the retired `app.use` was mounted), so a
//! malformed body on an internal slot is still the guard's 404.
//!
//! No route here is local-only. The `local` fact is nevertheless forwarded so a
//! host operation never has to guess it from the loopback connection it sees.
//!
//! Writes are serialized behind [`App::orchestration_write`] except the three
//! that wait for an Aux model call (`aux/enqueue`, `goal/precheck`) or exist to
//! interrupt such a wait (`aux/cancel`); see [`Route::serializes`].

#![allow(clippy::result_large_err)]

use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::http::{uri::Authority, Method, Response, Uri};
use futures_util::future::{ready, Either};
use multicc_core::auth_runtime::Snapshot;
use multicc_core::http_gate::{
    self, error_dto, is_private_network_address, query_value, QueryValue,
};
pub use multicc_core::orchestration_routes::Route;
use multicc_core::orchestration_routes::{
    self, guard_index, is_v1, segments, BodyParser, QUERY_KEYS,
};
use serde_json::{json, Map, Value};

use crate::app::express::{self, RequestCtx};
use crate::app::session_admin::{guard_facts, guarded_404};
use crate::app::App;
use crate::host_port;

/// The host port the Node child serves (`src/routes/orchestration-host.js`).
const HOST_PATH: &str = "/api/__host/orchestration";

/// How long an Aux model call may hold a request. The retired handlers waited
/// on the Aux queue without a bound of their own (the goal precheck answers
/// `AUX_TIMEOUT` itself after its configured wait), so the front door only
/// needs a budget longer than any of them.
const LONG_POLL: Duration = Duration::from_secs(30 * 60);

/// Lowercase names of the request headers forwarded to the host.
///
/// `host` is forwarded because the wait registration answers a `callbackUrl`
/// built from `req.get('host')`. Node sees the client's original `Host` (the
/// front door forwards requests without rewriting it), so dropping the header
/// here would silently turn every callback URL into `http://undefined/...`.
/// `x-wait-token` is the resolve callback's second token source, after
/// `?token=` and before the body's own field. Nothing else is forwarded --
/// `Cookie` and `Authorization` in particular stay out of the host payload.
const FORWARDED_HEADERS: &[&str] = &["idempotency-key", "host", "x-wait-token"];

pub fn claim(method: &Method, path: &str) -> Option<Route> {
    orchestration_routes::claim(method.as_str(), path)
}

/// This cluster's share of Express's automatic `OPTIONS` `Allow` for the
/// front-door union (`super::OPTIONS_SOURCES`).
pub fn options_share(path: &str) -> Option<String> {
    orchestration_routes::options_share(path)
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
            "error": "编排与无人值守接口尚未就绪，请更新原生模块",
            "code": "rust_backend_unavailable",
        }),
        &[],
    )
}

/// The host answered a non-200: the operation ran and threw, which the retired
/// `safeErrorHandler` rendered as a 500. Anything else (connect refusal, reset,
/// timeout, truncated reply) means we never got a complete answer: the 503.
pub(super) fn answered_but_failed(error: &std::io::Error) -> bool {
    if error.kind() != std::io::ErrorKind::InvalidData {
        return false;
    }
    let text = error.to_string();
    text.starts_with("host port: status ") || text == "host port: chunked reply"
}

pub(super) fn host_failed(ctx: &RequestCtx) -> Response<Body> {
    express::error(ctx, 500, "host operation failed")
}

/// One qs value as the JSON the handler's own coercions will see: a string, a
/// (nested) array, or an object (which is only ever `String()`-ed, `parseInt`-ed
/// or compared, never read by key).
pub(super) fn query_json_value(value: &QueryValue) -> Option<Value> {
    match value {
        QueryValue::Missing => None,
        QueryValue::Text(text) => Some(Value::String(text.clone())),
        QueryValue::List(items) => Some(Value::Array(
            items
                .iter()
                .map(|item| query_json_value(item).unwrap_or(Value::Null))
                .collect(),
        )),
        QueryValue::Object => Some(Value::Object(Map::new())),
    }
}

/// `req.query` restricted to the keys this cluster's handlers read.
fn query_json(ctx: &RequestCtx) -> Value {
    let mut object = Map::new();
    for name in QUERY_KEYS {
        if let Some(value) = query_json_value(&query_value(&ctx.original_url, name)) {
            object.insert((*name).to_string(), value);
        }
    }
    Value::Object(object)
}

/// The request headers a retired handler read through `req.get(...)`: only
/// `Idempotency-Key` (scheduled messages, queue actions). Forwarding an
/// allow-list keeps credentials (`Cookie`, `Authorization`, access tokens) out of
/// the host-port payload.
fn request_headers(ctx: &RequestCtx) -> Value {
    let mut headers = Map::new();
    for name in FORWARDED_HEADERS {
        if let Some(value) = ctx.headers.get(name) {
            headers.insert((*name).to_string(), Value::String(value.to_string()));
        }
    }
    Value::Object(headers)
}

/// Check the raw authority before URL parsing can discard whitespace or normalize paths.
fn valid_http_origin(origin: &str) -> bool {
    let Some((scheme, authority)) = origin.split_once("://") else {
        return false;
    };
    (scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https"))
        && !authority.is_empty()
        && !authority.ends_with(':')
        && !authority.contains(['/', '\\', '?', '#', '@'])
        && !authority
            .chars()
            .any(|c| c.is_whitespace() || c.is_control())
        && url::Url::parse(origin).is_ok_and(|url| {
            url.host_str()
                .is_some_and(|host| host.parse::<Authority>().is_ok())
        })
}

fn wait_callback_origin(ctx: &RequestCtx, body: &Value) -> Result<Option<String>, ()> {
    let mut explicit = None;
    for name in ["callbackBaseUrl", "callback_base_url"] {
        if let Some(field) = body.get(name) {
            let value = field.as_str().ok_or(())?;
            let origin = value.strip_suffix('/').unwrap_or(value);
            if !valid_http_origin(origin) {
                return Err(());
            }
            explicit.get_or_insert(origin);
        }
    }
    if let Some(origin) = explicit {
        return Ok(Some(origin.to_owned()));
    }
    let proto = ctx
        .headers
        .get("x-forwarded-proto")
        .and_then(|s| s.split(',').next());
    if proto.is_some_and(|s| s.trim().eq_ignore_ascii_case("https")) {
        if let Some(host) = ctx.headers.get("host") {
            let origin = format!("https://{host}");
            return Ok(valid_http_origin(&origin).then_some(origin));
        }
    }
    Ok(None)
}

fn rewrite_wait_callback(answer: &mut Value, origin: &str) {
    if answer["status"].as_u64() != Some(200) {
        return;
    }
    let Some(field) = answer.pointer_mut("/body/callbackUrl") else {
        return;
    };
    let Some(uri) = field.as_str().and_then(|s| s.parse::<Uri>().ok()) else {
        return;
    };
    if matches!(uri.scheme_str(), Some("http" | "https")) && uri.authority().is_some() {
        if let Some(suffix) = uri
            .path_and_query()
            .filter(|p| p.path().starts_with("/api/wait/"))
        {
            *field = Value::String(format!("{origin}{suffix}"));
        }
    }
}

/// One host round trip carrying the op, the decoded parameters and the facts
/// the retired handler read. The host answers `{ ok: true, value }`; `value` is
/// the `{ status, body, headers }` (or `{ threw, … }`) the retired handler
/// produced.
async fn call(
    ctx: &RequestCtx,
    host: u16,
    payload: Value,
    timeout: Option<Duration>,
) -> Result<Value, Response<Body>> {
    let outcome = match timeout {
        Some(budget) => host_port::call_with(host, HOST_PATH, &payload, budget).await,
        None => host_port::call(host, HOST_PATH, &payload).await,
    };
    match outcome {
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

/// The response headers the retired handler set through `res.set`.
pub(super) fn relay_headers(answer: &Value) -> Vec<(&str, &str)> {
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
    let body = answer.get("body").cloned().unwrap_or(Value::Null);
    express::json(ctx, status, &body, &headers)
}

/// `publicSessionAccessGuard`'s internal execution-slot refusal, before the
/// handler and before `OPTIONS`, exactly like the `app.use` mounts it replaces.
/// The `:id` is decoded first: Express decoded the layer's param before running
/// the guard, and a malformed escape is its 400.
async fn guarded(
    ctx: &RequestCtx,
    index: usize,
    parts: &[&str],
    host: u16,
) -> Result<String, Response<Body>> {
    let id = decoded(ctx, parts.get(index).copied().unwrap_or(""))?;
    let found = match guard_facts(host, &id, ctx.method.as_str()).await {
        Ok(found) => found,
        Err(_) => return Err(unavailable(ctx)),
    };
    if found.internal {
        return Err(guarded_404(ctx, is_v1(parts)));
    }
    Ok(id)
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
    let public_resolve = matches!(route, Route::WaitResolve)
        && multicc_core::http_entry::public_path(ctx.method.as_str(), &ctx.path.as_str().into());
    if !public_resolve {
        if let Some(refusal) = app.gate(ctx, peer, snapshot).await {
            return refusal;
        }
    }

    let parts = segments(&ctx.path).unwrap_or_default();
    if !app.node_enabled && claim(&Method::POST, &ctx.path) == Some(Route::UserInputDismiss) {
        let id = match decoded(ctx, parts.get(1).copied().unwrap_or("")) {
            Ok(id) => id,
            Err(response) => return response,
        };
        match crate::ws_chat_native::question_access(app, &id).await {
            Ok(Some(true)) => return guarded_404(ctx, false),
            Ok(Some(false)) => {}
            Ok(None) if matches!(route, Route::UserInputDismiss) => {
                return express::json(ctx, 404, &json!({"error":"session_not_found"}), &[]);
            }
            Ok(None) => {}
            Err(_) => return unavailable(ctx),
        }
        if let Route::Options { allow, .. } = route {
            return super::options(ctx, allow);
        }
        let body = match express::json_body(ctx, body, express::JSON_LIMIT).await {
            Ok(value) => value,
            Err(error) => return express::error(ctx, error.status, error.reason),
        };
        let Some(request) = body["requestId"]
            .as_str()
            .filter(|id| id.encode_utf16().count() <= 160)
            .map(multicc_core::js::js_trim)
            .filter(|id| !id.is_empty())
        else {
            return express::json(ctx, 400, &json!({"error":"request_id_required"}), &[]);
        };
        return match crate::ws_chat_native::dismiss_question(app, &id, request).await {
            Ok(result) => express::json(
                ctx,
                if result["ok"] == true { 200 } else { 409 },
                &result,
                &[],
            ),
            Err(error) => express::json(ctx, 500, &json!({"error":error}), &[]),
        };
    }
    let parse_body = match route.body_parser() {
        BodyParser::Global => express::json_body(ctx, body, express::JSON_LIMIT),
    };
    let mut callback_origin = None;
    let parse_body = if route == Route::SessionWaitPost {
        // Reject invalid origins before even the session guard calls the host.
        // Defer JSON parser errors until after the guard, as on other routes.
        let parsed = parse_body.await;
        if let Ok(body) = &parsed {
            callback_origin = match wait_callback_origin(ctx, body) {
                Ok(origin) => origin,
                Err(()) => {
                    return express::json(
                        ctx,
                        400,
                        &json!({"error":"invalid callbackBaseUrl"}),
                        &[],
                    )
                }
            };
        }
        Either::Left(ready(parsed))
    } else {
        Either::Right(parse_body)
    };
    let guard_segment = match route {
        Route::Options { guard_segment, .. } => guard_segment,
        _ => guard_index(&parts),
    };
    let mut session_id = None;
    if let Some(index) = guard_segment {
        match guarded(ctx, index, &parts, host).await {
            Ok(id) => session_id = Some(id),
            Err(refusal) => return refusal,
        }
    }

    if let Route::Options { allow, .. } = route {
        return super::options(ctx, allow);
    }

    let _serialized = if route.serializes() || (!app.node_enabled && route == Route::AuxConfigGet) {
        Some(app.orchestration_write.lock().await)
    } else {
        None
    };

    // Every route in this cluster sits after the global `express.json`.
    let request_body = match parse_body.await {
        Ok(value) => value,
        Err(error) => return express::error(ctx, error.status, error.reason),
    };

    if !app.node_enabled && route == Route::AuxConfigGet {
        return super::standalone_catalog::handle(app, ctx, None).await;
    }
    if !app.node_enabled {
        if let Some(answer) = super::aux_runtime::handle(app, ctx, route, &request_body).await {
            return answer;
        }
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
        let value = match (*name, &session_id) {
            ("id", Some(id)) => id.clone(),
            _ => match decoded(ctx, parts.get(*index).copied().unwrap_or("")) {
                Ok(value) => value,
                Err(response) => return response,
            },
        };
        payload.insert((*name).to_string(), Value::String(value));
    }
    payload.insert("query".into(), query_json(ctx));
    payload.insert("headers".into(), request_headers(ctx));
    payload.insert("body".into(), request_body);
    payload.insert(
        "local".into(),
        Value::Bool(http_gate::is_local_request(peer, &ctx.headers)),
    );
    // `req.id` / `req.correlationId` feed the v1 error and meta envelopes.
    payload.insert("requestId".into(), Value::String(ctx.ids.0.clone()));
    payload.insert("correlationId".into(), Value::String(ctx.ids.1.clone()));

    let budget = route.long_poll().then_some(LONG_POLL);
    match call(ctx, host, Value::Object(payload), budget).await {
        Ok(mut answer) => {
            if let Some(origin) = callback_origin {
                rewrite_wait_callback(&mut answer, &origin);
            }
            relay(ctx, answer)
        }
        Err(response) => response,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claim_delegates_to_the_kernel() {
        assert_eq!(
            claim(&Method::GET, "/api/v1/sessions/s1/waits"),
            Some(Route::V1SessionWaits)
        );
        assert_eq!(
            claim(&Method::GET, "/api/sessions/s1/waits"),
            Some(Route::SessionWaits)
        );
        assert_eq!(
            claim(&Method::POST, "/api/sessions/s1/queue/action"),
            Some(Route::SessionQueueAction)
        );
        assert_eq!(
            claim(&Method::POST, "/api/sessions/s1/wait"),
            Some(Route::SessionWaitPost)
        );
        assert_eq!(
            claim(&Method::GET, "/api/detached/t1"),
            Some(Route::DetachedTask)
        );
    }

    #[test]
    fn options_share_is_this_clusters_method_list() {
        assert_eq!(
            options_share("/api/aux/config").as_deref(),
            Some("GET,HEAD,POST")
        );
        assert_eq!(
            options_share("/api/sessions/s1/scheduled-messages").as_deref(),
            Some("POST,GET,HEAD")
        );
        assert_eq!(
            options_share("/api/sessions/s1/scheduled-messages/m1").as_deref(),
            Some("DELETE")
        );
        assert_eq!(
            options_share("/api/sessions/s1/waits").as_deref(),
            Some("GET,HEAD")
        );
    }

    #[test]
    fn query_values_keep_their_qs_shape() {
        assert_eq!(query_json_value(&QueryValue::Missing), None);
        assert_eq!(
            query_json_value(&QueryValue::Text("a".into())),
            Some(json!("a"))
        );
        assert_eq!(
            query_json_value(&QueryValue::List(vec![
                QueryValue::Text("a".into()),
                QueryValue::List(vec![QueryValue::Text("b".into())]),
            ])),
            Some(json!(["a", ["b"]]))
        );
        assert_eq!(query_json_value(&QueryValue::Object), Some(json!({})));
    }

    #[test]
    fn only_successful_wait_callback_urls_are_rewritten() {
        for (status, callback) in [
            (400, json!("http://localhost/api/wait/w1/resolve?token=t")),
            (200, Value::Null),
            (200, json!("/api/wait/w1/resolve?token=t")),
            (
                200,
                json!("http://localhost/other?next=/api/wait/w1/resolve"),
            ),
        ] {
            let answer = json!({"status": status, "body": {"callbackUrl": callback}});
            let mut actual = answer.clone();
            rewrite_wait_callback(&mut actual, "https://tunnel.example.test");
            assert_eq!(actual, answer);
        }
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
