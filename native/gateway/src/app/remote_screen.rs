//! The HTTP forwarding half of the remote screen: everything under
//! `/api/remote-screen` goes to the `multicc-remote` child on its loopback
//! port (docs/remote-screen-process.md §3).
//!
//! Ported from `src/remote-screen-rust.js` lines 271–357 (`forwardHttp`,
//! `copyResponseHeaders`, `unavailableHttp`, `unavailableCapabilities`) on top
//! of [`crate::remote_child`]:
//!
//! ```text
//! GET|HEAD|POST /api/remote-screen[/...]  -> 127.0.0.1:<port><originalUrl>
//!                                            x-multicc-remote-secret: <secret>
//! ```
//!
//! Deleted Node behavior this keeps byte-for-byte: the 405 answer, the two
//! unavailable shapes (`capabilities` stays 200 with `Cache-Control:
//! no-store`), the POST body re-serialization (`JSON.stringify(req.body ??
//! {})`), the response header whitelist, and a body that is streamed, never
//! buffered.
//!
//! **Not wired.** Nothing in [`super::claim`] or [`super::handle`] names this
//! module, so no production path can run it until the checklist in
//! `docs/rust-migration` (or the port report) adds it. The handler owns its
//! [`Arc<RemoteChild>`] instead of reading App state; wiring therefore needs no
//! `App` field.

use std::net::Ipv4Addr;
use std::sync::Arc;
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::http::{Method, Response};
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::client::conn::http1::Builder as ClientBuilder;
use hyper::Request;
use hyper_util::rt::TokioIo;
use serde_json::{json, Value};

use super::express::{self, RequestCtx};
use crate::remote_child::{Ready, RemoteChild};

/// Express's mount point. The retired `app.use('/api/remote-screen', …)` also
/// matched a bare mount path and anything below it.
pub const MOUNT: &str = "/api/remote-screen";

/// `outgoing.setTimeout(15000)`: the request socket's *idle* timeout, not a
/// budget for the whole response.
pub const DEFAULT_IDLE_TIMEOUT: Duration = Duration::from_millis(15_000);

/// The mount's prefix rule: `/api/remote-screen`, `/api/remote-screen/` and
/// `/api/remote-screen/<anything>`; `/api/remote-screenx` is somebody else's.
/// Case-sensitive, like every other native route (`docs/gateway.md` §9); the
/// retired mount matched case-insensitively.
pub fn claims(path: &str) -> bool {
    path == MOUNT
        || path
            .strip_prefix(MOUNT)
            .is_some_and(|rest| rest.starts_with('/'))
}

/// `unavailableCapabilities()`: what the panel reads to hide 🖥. Field order is
/// the JSON byte order every client has seen since the Node implementation.
pub fn unavailable_capabilities() -> Value {
    json!({
        "ok": true,
        "supported": false,
        "reason": "remote-unavailable",
        "features": {
            "view": false,
            "control": false,
            "snapshot": false,
            "annotate": false,
            "stream": false,
            "wake": false,
            "unlock": false,
            "elementTree": false,
        },
        "streams": { "h264": false, "rfb": false },
    })
}

/// The stateful forwarding handler a wired route would hold.
pub struct RemoteScreen {
    child: Arc<RemoteChild>,
    idle_timeout: Duration,
}

impl RemoteScreen {
    pub fn new(child: Arc<RemoteChild>) -> Self {
        Self {
            child,
            idle_timeout: DEFAULT_IDLE_TIMEOUT,
        }
    }

    pub fn with_idle_timeout(mut self, idle_timeout: Duration) -> Self {
        self.idle_timeout = idle_timeout;
        self
    }

    pub fn child(&self) -> &Arc<RemoteChild> {
        &self.child
    }

    /// `forwardHttp`. The caller has already run the auth gate; `body` is the
    /// raw request body because `express.json` runs inside this handler, in
    /// front of the method check — a malformed JSON PUT is a 400 in Node, not
    /// a 405.
    pub async fn handle(&self, ctx: &RequestCtx, body: Body) -> Response<Body> {
        let parsed = match express::json_body(ctx, body, express::JSON_LIMIT).await {
            Ok(value) => value,
            Err(error) => return express::error(ctx, error.status, error.reason),
        };
        let pathname = pathname(ctx);
        if !matches!(ctx.method, Method::GET | Method::HEAD | Method::POST) {
            return express::json(
                ctx,
                405,
                &json!({ "ok": false, "error": "method-not-allowed" }),
                &[],
            );
        }
        let ready = match self.child.ensure().await {
            Ok(ready) => ready,
            // `catch { unavailableHttp(...) }`: binding-missing, spawn failure,
            // ready timeout, a crash window (`restarting`), `stopping` — all
            // the same answer; the code is for the snapshot, not the client.
            Err(_) => return unavailable(ctx, &pathname),
        };
        // POST: `JSON.stringify(req.body ?? {})` — the *re-serialized* bytes,
        // which is why `{"b":1,  "a":2}` reaches the child as `{"b":1,"a":2}`.
        let payload = if ctx.method == Method::POST {
            Some(multicc_core::js::serde::js_json_stringify(&parsed).into_bytes())
        } else {
            None
        };
        let mut headers: Vec<(String, String)> = Vec::new();
        if let Some(content_type) = ctx.headers.get("content-type") {
            headers.push(("content-type".to_string(), content_type.to_string()));
        }
        headers.push(("x-multicc-remote-secret".to_string(), ready.secret.clone()));
        if let Some(payload) = payload.as_ref() {
            headers.push(("content-length".to_string(), payload.len().to_string()));
        }
        let upstream = exchange(&ready, ctx, &headers, payload, self.idle_timeout).await;
        let Some(upstream) = upstream else {
            // Connection refused, handshake failure, idle timeout or a reset
            // before the response head: `res.headersSent` was false.
            return unavailable(ctx, &pathname);
        };
        let status = upstream.status().as_u16();
        let headers = upstream.headers().clone();
        let incoming = upstream.into_body();
        let body = Body::from_stream(frames(incoming, self.idle_timeout));
        response(ctx, status, &headers, body)
    }
}

/// `String(req.originalUrl || req.url || '').split('?')[0]`.
fn pathname(ctx: &RequestCtx) -> String {
    ctx.original_url.split('?').next().unwrap_or("").to_string()
}

/// `unavailableHttp`: `capabilities` keeps answering 200 (the panel needs a
/// shape to render), everything else is a 503.
fn unavailable(ctx: &RequestCtx, pathname: &str) -> Response<Body> {
    if pathname == "/api/remote-screen/capabilities" {
        return express::json(
            ctx,
            200,
            &unavailable_capabilities(),
            &[("Cache-Control", "no-store")],
        );
    }
    express::json(
        ctx,
        503,
        &json!({ "ok": false, "error": "remote-unavailable" }),
        &[],
    )
}

/// One request to `127.0.0.1:<port>` with the original target, method and the
/// protocol headers. Every step is idle-bounded by `idle`; `None` is the
/// "headers not sent" failure the caller turns into an unavailable answer.
async fn exchange(
    ready: &Ready,
    ctx: &RequestCtx,
    headers: &[(String, String)],
    payload: Option<Vec<u8>>,
    idle: Duration,
) -> Option<Response<Incoming>> {
    let address = (Ipv4Addr::LOCALHOST, ready.port);
    let stream = tokio::time::timeout(idle, tokio::net::TcpStream::connect(address))
        .await
        .ok()?
        .ok()?;
    let _ = stream.set_nodelay(true);
    let (mut sender, connection) = tokio::time::timeout(
        idle,
        ClientBuilder::new()
            .preserve_header_case(true)
            .handshake::<_, Full<Bytes>>(TokioIo::new(stream)),
    )
    .await
    .ok()?
    .ok()?;
    tokio::spawn(async move {
        let _ = connection.await;
    });
    // `path: req.originalUrl || req.url` — path *and* query, untouched. The
    // connection is already open, so the request line stays origin-form
    // (`/api/remote-screen/...`), exactly like Node's `http.request({ path })`.
    let mut builder = Request::builder()
        .method(ctx.method.clone())
        .uri(ctx.original_url.as_str());
    for (name, value) in headers {
        if let Ok(value) = axum::http::HeaderValue::from_str(value) {
            builder = builder.header(name.as_str(), value);
        }
    }
    let request_body = Full::new(Bytes::from(payload.unwrap_or_default()));
    let request = builder.body(request_body).ok()?;
    tokio::time::timeout(idle, sender.send_request(request))
        .await
        .ok()?
        .ok()
}

/// `upstream.pipe(res)` as a body: one frame per upstream read, idle-bounded so
/// a stalled child cannot pin the connection. A frame error ends the stream
/// with an error, which makes hyper abort the response — the same visible
/// effect as the retired `res.destroy()` (`res.headersSent` was true, so the
/// client sees a dropped connection rather than a clean end).
fn frames(
    incoming: Incoming,
    idle: Duration,
) -> impl futures_util::Stream<Item = Result<Bytes, std::io::Error>> {
    futures_util::stream::unfold(Some(incoming), move |state| async move {
        let mut incoming = state?;
        loop {
            match tokio::time::timeout(idle, incoming.frame()).await {
                Ok(Some(Ok(frame))) => match frame.into_data() {
                    Ok(data) => return Some((Ok(data), Some(incoming))),
                    // A trailer frame carries no body bytes; hyper has nowhere
                    // to put it on a chunked response here, so it is skipped.
                    Err(_trailers) => continue,
                },
                Ok(Some(Err(error))) => {
                    return Some((Err(std::io::Error::other(error.to_string())), None))
                }
                Ok(None) => return None,
                Err(_) => {
                    return Some((
                        Err(std::io::Error::new(
                            std::io::ErrorKind::TimedOut,
                            "remote-timeout",
                        )),
                        None,
                    ))
                }
            }
        }
    })
}

/// `copyResponseHeaders`'s whitelist.
fn allowed_header(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "content-type" | "cache-control" | "content-length"
    ) || lower.starts_with("x-screen-")
        || lower.starts_with("x-region-")
}

/// `copyResponseHeaders` + `res.writeHead(status || 502)` + the base headers
/// every Express response had already set.
fn response(
    ctx: &RequestCtx,
    status: u16,
    headers: &axum::http::HeaderMap,
    body: Body,
) -> Response<Body> {
    let mut builder = express::with_base_headers(Response::builder().status(status), ctx);
    for (name, value) in headers {
        if !allowed_header(name.as_str()) {
            continue;
        }
        builder = builder.header(name, value);
    }
    express::log_request(ctx, status);
    match builder.body(body) {
        Ok(response) => response,
        Err(_) => express::error(ctx, 502, "remote-unavailable"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mount_prefix_matches_express_use() {
        assert!(claims("/api/remote-screen"));
        assert!(claims("/api/remote-screen/"));
        assert!(claims("/api/remote-screen/capabilities"));
        assert!(claims("/api/remote-screen/frame?x=1"));
        assert!(!claims("/api/remote-screenx"));
        assert!(!claims("/api/remote-screenx/capabilities"));
        assert!(!claims("/API/REMOTE-SCREEN"));
        assert!(!claims("/api"));
        assert!(!claims("/"));
    }

    #[test]
    fn unavailable_capabilities_byte_order() {
        assert_eq!(
            multicc_core::js::serde::js_json_stringify(&unavailable_capabilities()),
            r#"{"ok":true,"supported":false,"reason":"remote-unavailable","features":{"view":false,"control":false,"snapshot":false,"annotate":false,"stream":false,"wake":false,"unlock":false,"elementTree":false},"streams":{"h264":false,"rfb":false}}"#
        );
    }

    #[test]
    fn header_whitelist_follows_the_js_regex() {
        assert!(allowed_header("content-type"));
        assert!(allowed_header("Content-Type"));
        assert!(allowed_header("cache-control"));
        assert!(allowed_header("content-length"));
        assert!(allowed_header("x-screen-width"));
        assert!(allowed_header("X-Region-Top"));
        assert!(!allowed_header("x-secret-leak"));
        assert!(!allowed_header("set-cookie"));
        assert!(!allowed_header("connection"));
        assert!(!allowed_header("transfer-encoding"));
        assert!(!allowed_header("x-screenx"));
    }
}
