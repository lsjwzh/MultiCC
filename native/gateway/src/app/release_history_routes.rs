//! The release-asset, iOS OTA and chat-history route cluster retired from
//! `src/routes/system.js`, `src/ios-udid.js`, `src/routes/chat-history.js` and
//! `src/routes/static-assets.js` -- the eleven routes listed in
//! [`multicc_core::release_history_routes`].
//!
//! Path matching, parameter decoding, the automatic `OPTIONS` answer, the
//! public-session access guard (internal execution slots), the authentication
//! exemptions, the query subset and the Apple device-reply framing (the
//! `express.raw` limits) live here and in the core crate. `GET /` is answered
//! entirely here (a redirect decision with no host fact). Everything else is a
//! Node fact: the APK/IPA sidecar files, the `.mobileconfig` and plist
//! rendering, the one-time UDID token maps and the `openssl cms` verify, the
//! session record map, the transcript store and the native history runtime.
//! Node keeps exactly those behind one host port,
//! `POST /api/__host/release-history` (`src/routes/release-history-host.js`),
//! which answers `{ status, body | contentType + body | bare, headers }` -- the
//! answer the retired Express handler produced -- so the public contract stays
//! byte-identical.
//!
//! `GET /multicc.apk` is claimed like the rest of the cluster, but only its
//! decision is the host's: a usable local file made the retired handler call
//! `next()` into `express.static`, and that mount is
//! [`super::static_web_root`] now, so the host reports `fellThrough` and the
//! file is streamed here with the same engine. The 302 and the bare 404 are
//! relayed like any other answer.
//!
//! Authentication. The OTA fetchers are not browsers: `itms-services` cannot log
//! in and the Apple device posts its signed reply from the phone. The exemptions
//! are the shared HTTP-entry rule ([`release_history_routes::is_public`]), not a
//! copy: the manifest and the result page are public, the callback is public
//! only with Apple's two content types, and the profile download and both JSON
//! infos stay behind the ordinary gate.
//!
//! The internal-execution-slot guard is session-admin's, reused as-is
//! ([`guard_facts`] / [`guarded_404`]): an internal slot gets the same 404 as a
//! missing session before any handler runs and before `OPTIONS`.
//!
//! No route here is local-only. The `local` fact is nevertheless forwarded.
//!
//! Writes (the profile's token issue, the device callback and the message
//! delete) are serialized behind [`App::release_history_write`].

#![allow(clippy::result_large_err)]

use std::sync::Arc;

use axum::body::Body;
use axum::http::{HeaderMap, HeaderValue, Method, Request, Response, Uri};
use base64::Engine;
use multicc_core::auth_runtime::Snapshot;
use multicc_core::http_gate::{self, error_dto, is_private_network_address, query_value};
pub use multicc_core::release_history_routes::Route;
use multicc_core::release_history_routes::{
    self, guard_index, raw_precheck, segments, RawError, QUERY_KEYS, UDID_CALLBACK_LIMIT,
};
use serde_json::{json, Map, Value};

use crate::app::express::{self, RequestCtx};
use crate::app::orchestration_routes::{
    answered_but_failed, host_failed, query_json_value, relay_headers,
};
use crate::app::session_admin::{guard_facts, guarded_404};
use crate::app::App;
use crate::host_port;

/// The host port the Node child serves (`src/routes/release-history-host.js`).
const HOST_PATH: &str = "/api/__host/release-history";

/// Lowercase names of the request headers forwarded to the host: the caller's
/// own origin (`absoluteBaseUrl` reads `X-Forwarded-*` then `Host`) and the
/// cross-site check on the profile download. Credentials never go.
const FORWARDED_HEADERS: &[&str] = &[
    "host",
    "x-forwarded-proto",
    "x-forwarded-host",
    "sec-fetch-site",
];

pub fn claim(method: &Method, path: &str) -> Option<Route> {
    release_history_routes::claim(method.as_str(), path)
}

/// `GET|HEAD /` answers here only for the two redirects; `?id=`/`?newid=`/`?cwd=`
/// is the terminal-session chain on Node.
pub fn claim_uri(method: &Method, uri: &Uri) -> Option<Route> {
    let target = uri.path_and_query().map(|value| value.as_str())?;
    release_history_routes::claim_root(method.as_str(), target)
}

/// This cluster's share of Express's automatic `OPTIONS` `Allow` for the
/// front-door union (`super::OPTIONS_SOURCES`).
pub fn options_share(path: &str) -> Option<String> {
    release_history_routes::options_share(path)
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
            "error": "发布资产与聊天历史接口尚未就绪，请更新原生模块",
            "code": "rust_backend_unavailable",
        }),
        &[],
    )
}

fn query_json(ctx: &RequestCtx) -> Value {
    let mut object = Map::new();
    for name in QUERY_KEYS {
        if let Some(value) = query_json_value(&query_value(&ctx.original_url, name)) {
            object.insert((*name).to_string(), value);
        }
    }
    Value::Object(object)
}

fn request_headers(ctx: &RequestCtx) -> Value {
    let mut headers = Map::new();
    for name in FORWARDED_HEADERS {
        if let Some(value) = ctx.headers.get(name) {
            headers.insert((*name).to_string(), Value::String(value.to_string()));
        }
    }
    Value::Object(headers)
}

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

/// Relay the answer the retired handler produced. A handler that threw (the old
/// `safeErrorHandler` path) carries `threw:true` plus the DTO fields; the front
/// door builds the same envelope with its own request ids, never leaking the
/// thrown message. A body-less `res.status(n).end()` is `bare`: no Content-Type
/// and no ETag, but the headers the handler set (a 301's `Location`) stay.
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
    if answer.get("bare") == Some(&Value::Bool(true)) {
        let mut builder = express::with_base_headers(Response::builder().status(status), ctx);
        for (name, value) in &headers {
            builder = express::header(builder, name, value);
        }
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

/// `publicSessionAccessGuard`'s internal execution-slot refusal, before the
/// handler and before `OPTIONS`. The `:id` is decoded first: Express decoded the
/// layer's param before running the guard, and a malformed escape is its 400.
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
        return Err(guarded_404(ctx, false));
    }
    Ok(id)
}

/// What `express.raw` left in `req.body` for the device callback. The retired
/// route answered the three non-buffer states with its own fixed text after its
/// 410/429 token checks, so the state travels to the host instead of being
/// answered here.
async fn callback_body(ctx: &RequestCtx, body: Body) -> Result<Value, Response<Body>> {
    let headers = &ctx.headers;
    let has_body = headers.get("transfer-encoding").is_some()
        || headers
            .get("content-length")
            .is_some_and(|value| !multicc_core::js::js_string_to_number(value).is_nan());
    // The global `express.json` runs first and consumes a JSON body; the raw
    // parser then sees `req._body` and leaves a parsed value in `req.body`.
    let is_json = has_body
        && headers
            .get("content-type")
            .is_some_and(|value| express::media_type(value).0 == "application/json");
    if is_json {
        return match express::json_body(ctx, body, express::JSON_LIMIT).await {
            Ok(_) => Ok(json!({ "kind": "parsed" })),
            Err(error) => Err(express::error(ctx, error.status, error.reason)),
        };
    }
    match raw_precheck(
        headers.get("transfer-encoding"),
        headers.get("content-length"),
        headers.get("content-encoding"),
    ) {
        Err(refusal) => Ok(json!({ "kind": "error", "status": refusal.status() })),
        Ok(false) => Ok(json!({ "kind": "none" })),
        Ok(true) => match express::collect(body, UDID_CALLBACK_LIMIT).await {
            Ok(bytes) => Ok(json!({
                "kind": "buffer",
                "base64": base64::engine::general_purpose::STANDARD.encode(bytes),
            })),
            Err(error) => {
                let refusal = if error.status == 413 {
                    RawError::TooLarge
                } else {
                    RawError::Invalid
                };
                Ok(json!({ "kind": "error", "status": refusal.status() }))
            }
        },
    }
}

// The eighth argument is the upstream handle a `fellThrough` decision needs to
// continue down the retired chain; the other seven are the shared pre-gate
// inputs every arm in this file already took.
#[allow(clippy::too_many_arguments)]
pub async fn handle(
    app: &Arc<App>,
    route: Route,
    ctx: &RequestCtx,
    body: Body,
    peer: &str,
    snapshot: &Snapshot,
    host: u16,
    upstream: crate::forward::UpstreamHandle,
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
    // The OTA fetchers cannot log in: exactly the shared HTTP-entry exemptions
    // skip the ordinary gate; everything else keeps it.
    let public = release_history_routes::is_public(
        ctx.method.as_str(),
        &ctx.path,
        ctx.headers.get("content-type"),
    );
    if !public {
        if let Some(refusal) = app.gate(ctx, peer, snapshot).await {
            return refusal;
        }
    }

    let parts = segments(&ctx.path).unwrap_or_default();
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

    let _serialized = if route.is_write() {
        Some(app.release_history_write.lock().await)
    } else {
        None
    };

    // Every route here sits after the global `express.json`; only the device
    // callback has its own raw parser behind it.
    let mut request_body = Value::Null;
    let mut raw_body = None;
    if route == Route::UdidCallback {
        match callback_body(ctx, body).await {
            Ok(state) => raw_body = Some(state),
            Err(refusal) => return refusal,
        }
    } else {
        match express::json_body(ctx, body, express::JSON_LIMIT).await {
            Ok(value) => request_body = value,
            Err(error) => return express::error(ctx, error.status, error.reason),
        }
    }

    if route == Route::Root {
        // `GET /` only claims when it redirects.
        let Some(location) = release_history_routes::root_redirect(&ctx.original_url) else {
            return express::error(ctx, 500, "root route claimed without a redirect");
        };
        return express::redirect(ctx, location);
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
    if let Some(state) = raw_body {
        payload.insert("rawBody".into(), state);
    }
    payload.insert(
        "local".into(),
        Value::Bool(http_gate::is_local_request(peer, &ctx.headers)),
    );
    payload.insert("requestId".into(), Value::String(ctx.ids.0.clone()));
    payload.insert("correlationId".into(), Value::String(ctx.ids.1.clone()));

    let answer = match call(ctx, host, Value::Object(payload)).await {
        Ok(answer) => answer,
        Err(response) => return response,
    };
    if route == Route::ApkDownload {
        return apk_download(app, ctx, answer, upstream).await;
    }
    relay(ctx, answer)
}

/// `GET|HEAD /multicc.apk`. The retired handler had three outcomes, and only
/// one of them wrote a response itself:
///
/// * a usable local `public/multicc.apk` -> `next()`, which dropped the
///   request back into the chain: the `.apk`/`.ipa` guard first (a case
///   variant of the name dies there with its bare no-store 404), then
///   `express.static`'s streamed `sendFile` (Range / ETag / Last-Modified,
///   plus the download headers), and whatever neither resolved still reached
///   Node (a trailing-slash spelling never matched the guard and is no file).
///   The guard is [`super::static_assets_routes`], the static mount is
///   [`super::static_web_root`], and the last step is the same forward every
///   unclaimed request takes.
/// * a verified release -> `res.redirect(302, url)` after two `res.set`s.
/// * every other state -> `res.set('Cache-Control', 'no-store')` + a bare 404.
async fn apk_download(
    app: &Arc<App>,
    ctx: &RequestCtx,
    answer: Value,
    upstream: crate::forward::UpstreamHandle,
) -> Response<Body> {
    if answer.get("fellThrough") == Some(&Value::Bool(true)) {
        if let Ok(uri) = Uri::try_from(ctx.original_url.as_str()) {
            if let Some(route) = super::static_assets_routes::claim(&ctx.method, uri.path()) {
                return super::static_assets_routes::handle(route, ctx);
            }
            // Only the upgrade check reads the headers, and an upgrade never
            // reached the retired Express chain.
            let mut headers = HeaderMap::new();
            if ctx.headers.get("upgrade").is_some() {
                headers.insert(
                    axum::http::header::UPGRADE,
                    HeaderValue::from_static("websocket"),
                );
            }
            if let Some(resolved) = super::static_web_root::claim(app, &ctx.method, &uri, &headers)
            {
                return super::static_web_root::handle(app, ctx, Some(&resolved)).await;
            }
        }
        return crate::forward::forward(upstream, forward_request(ctx), None).await;
    }
    if let Some(redirect) = answer.get("redirect").and_then(Value::as_object) {
        let status = redirect
            .get("status")
            .and_then(Value::as_u64)
            .unwrap_or(302) as u16;
        let location = redirect
            .get("location")
            .and_then(Value::as_str)
            .unwrap_or("");
        let reason = if status == 301 {
            "Moved Permanently"
        } else {
            "Found"
        };
        let mut response = express::redirect_status(ctx, location, status, reason);
        // The two `res.set` calls the handler made before redirecting.
        for (name, value) in relay_headers(&answer) {
            if let (Ok(name), Ok(value)) = (
                axum::http::HeaderName::try_from(name),
                axum::http::HeaderValue::try_from(value),
            ) {
                response.headers_mut().insert(name, value);
            }
        }
        return response;
    }
    relay(ctx, answer)
}

/// The request as [`crate::forward::forward`] would have received it, rebuilt
/// after `express.json` consumed it: the body is gone, and the hop-by-hop
/// headers with it.
fn forward_request(ctx: &RequestCtx) -> Request<Body> {
    let mut builder = Request::builder()
        .method(ctx.method.clone())
        .uri(ctx.original_url.as_str());
    for name in ctx.headers.names() {
        if matches!(
            name,
            "connection" | "content-length" | "transfer-encoding" | "upgrade"
        ) {
            continue;
        }
        if let Some(value) = ctx.headers.get(name) {
            builder = builder.header(name, value);
        }
    }
    builder.body(Body::empty()).expect("static request parts")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claim_delegates_to_the_kernel() {
        assert_eq!(
            claim(&Method::GET, "/api/sessions/s1/history"),
            Some(Route::History)
        );
        assert_eq!(
            claim(&Method::POST, "/ios-ota/udid/callback/t"),
            Some(Route::UdidCallback)
        );
        assert_eq!(
            claim(&Method::GET, "/multicc.apk"),
            Some(Route::ApkDownload)
        );
        assert_eq!(
            claim(&Method::HEAD, "/multicc.apk"),
            Some(Route::ApkDownload)
        );
        assert_eq!(claim(&Method::POST, "/multicc.apk"), None);
        assert_eq!(claim(&Method::GET, "/"), None);
    }

    #[test]
    fn the_root_claims_only_when_it_redirects() {
        let root = |text: &str| claim_uri(&Method::GET, &text.parse::<Uri>().unwrap());
        assert_eq!(root("/"), Some(Route::Root));
        assert_eq!(root("/?id=__aux__"), Some(Route::Root));
        assert_eq!(root("/?id=s1"), None);
        assert_eq!(root("/air"), None);
    }

    #[test]
    fn options_share_is_this_clusters_method_list() {
        assert_eq!(
            options_share("/api/sessions/s1/messages/m1").as_deref(),
            Some("DELETE")
        );
        assert_eq!(
            options_share("/ios-ota/manifest.plist").as_deref(),
            Some("GET,HEAD")
        );
        assert_eq!(options_share("/multicc.apk").as_deref(), Some("GET,HEAD"));
        assert_eq!(options_share("/multicc-ios.ipa"), None);
    }

    #[test]
    fn relay_headers_keeps_the_handler_pairs() {
        let answer = json!({
            "status": 200,
            "headers": [["Cache-Control", "no-store"]],
        });
        assert_eq!(relay_headers(&answer), vec![("Cache-Control", "no-store")]);
    }
}
