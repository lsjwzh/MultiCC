//! Service configuration and HTTP/WS entrypoints owned wholly by the gateway.
use super::{
    accept,
    express::{self, RequestCtx},
    service_transport::Transport,
    App,
};
use axum::{
    body::Body,
    http::{HeaderValue, Method, Request, Response},
};
use multicc_core::{
    auth_runtime::Snapshot,
    http_gate::{self, GatePolicy, GateRequest},
    js::JsValue,
    service_routes::{self, Store},
};
use serde_json::json;
use std::{
    net::SocketAddr,
    sync::{Arc, Mutex},
};
use url::Url;

pub struct Runtime {
    store: Mutex<Store>,
    transport: Transport,
}
impl Runtime {
    pub fn load(root: &std::path::Path) -> Result<Self, String> {
        Ok(Self {
            store: Mutex::new(Store::load(root.join("service-routes.json"))?),
            transport: Transport::new().map_err(|e| e.to_string())?,
        })
    }
}
#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub enum Route {
    Proxy,
    Management,
}
pub fn claim(path: &str) -> Option<Route> {
    if service_routes::proxy_name(path).is_some() {
        return Some(Route::Proxy);
    }
    let lower = path.to_ascii_lowercase();
    (lower == "/api/service-routes" || lower.starts_with("/api/service-routes/"))
        .then_some(Route::Management)
}
fn authenticated(app: &App, ctx: &RequestCtx, peer: &str, snapshot: &Snapshot, ws: bool) -> bool {
    let policy = GatePolicy {
        access_token: snapshot.secret.clone(),
        lan_only: app.lan_only,
        allow_legacy_token_query: app.allow_legacy_token_query && !ws,
    };
    let request = GateRequest {
        method: ctx.method.as_str(),
        path: &ctx.path,
        original_url: &ctx.original_url,
        peer,
        headers: &ctx.headers,
        now_ms: super::now_ms(),
    };
    if http_gate::is_authenticated(&policy, &request) {
        return true;
    }
    // The former upgrade handler used Object.fromEntries(URLSearchParams),
    // so duplicate tokens select the last value, unlike HTTP's qs arrays.
    ws && app.allow_legacy_token_query
        && multicc_core::auth_security::verify_access_token(
            &snapshot.secret,
            ctx.original_url
                .split_once('?')
                .and_then(|(_, q)| {
                    url::form_urlencoded::parse(q.as_bytes())
                        .filter(|(k, _)| k == "token")
                        .last()
                        .map(|(_, v)| v.into_owned())
                })
                .as_deref(),
        )
}
fn json_error(ctx: &RequestCtx, status: u16, message: &str) -> Response<Body> {
    express::json(ctx, status, &json!({"error": message}), &[])
}
fn no_store(mut response: Response<Body>) -> Response<Body> {
    response
        .headers_mut()
        .insert("cache-control", HeaderValue::from_static("no-store"));
    response
}
fn ws_error(code: u16) -> Response<Body> {
    Response::builder()
        .status(code)
        .header("connection", "close")
        .body(Body::empty())
        .unwrap()
}

pub async fn handle(
    app: Arc<App>,
    route: Route,
    mut request: Request<Body>,
    client: SocketAddr,
) -> Response<Body> {
    let (parts, body) = request.into_parts();
    let ctx = RequestCtx::new(&parts);
    request = Request::from_parts(parts, body);
    let peer = client.ip().to_string();
    let ws = request.headers().contains_key("upgrade")
        && ctx.headers.get("connection").is_some_and(|v| {
            v.as_bytes()
                .split(|c| *c == b',')
                .any(|p| p.trim_ascii().eq_ignore_ascii_case(b"upgrade"))
        });
    let snapshot = match app.auth.snapshot().await {
        Ok(v) => v,
        Err(_) => {
            return if ws {
                ws_error(503)
            } else {
                express::error(&ctx, 503, "authentication runtime unavailable")
            }
        }
    };
    let Some(runtime) = app.services.get().cloned() else {
        return express::error(&ctx, 503, "service runtime unavailable");
    };
    if route == Route::Management {
        return management_entry(app, runtime, &ctx, request.into_body(), &peer, snapshot).await;
    }
    // HTTP peer rejection preceded service lookup in the former middleware.
    if !ws && app.lan_only && !http_gate::is_private_network_address(&peer) {
        return express::json(
            &ctx,
            403,
            &http_gate::public_peer_rejected_dto(&ctx.ids),
            &[],
        );
    }
    let name = service_routes::proxy_name(&ctx.path)
        .unwrap_or("")
        .to_string();
    let lookup = runtime.clone();
    let lookup_name = name.clone();
    let hit = match tokio::task::spawn_blocking(move || {
        lookup
            .store
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .find(&lookup_name)
    })
    .await
    {
        Ok(hit) => hit,
        Err(_) => return express::error(&ctx, 500, "service lookup panicked"),
    };
    let Some(hit) = hit else {
        return if ws {
            ws_error(404)
        } else {
            no_store(json_error(&ctx, 404, "service_route_not_found"))
        };
    };
    let prefix = format!("/services/{name}");
    let public = hit["access"] == "public";
    let allowed = (!app.lan_only || http_gate::is_private_network_address(&peer))
        && (public
            || (service_routes::same_origin_host(
                ctx.headers.get("origin"),
                ctx.headers.get("host"),
            ) && authenticated(&app, &ctx, &peer, &snapshot, ws)));
    if !allowed {
        return if ws {
            ws_error(401)
        } else if ctx.method == Method::GET
            && accept::prefer(ctx.headers.get("accept"), &["text/html"]).is_some()
        {
            no_store(express::redirect(
                &ctx,
                &format!(
                    "/login?redirect={}",
                    http_gate::encode_uri_component(&ctx.original_url)
                ),
            ))
        } else {
            no_store(json_error(&ctx, 401, "authentication_required"))
        };
    }
    if !ws && ctx.path == prefix {
        let query = ctx
            .original_url
            .find('?')
            .map(|i| &ctx.original_url[i..])
            .unwrap_or("");
        return no_store(express::redirect_status(
            &ctx,
            &format!("{prefix}/{query}"),
            308,
            "Permanent Redirect",
        ));
    }
    if ctx
        .headers
        .get("x-multicc-service-hop")
        .is_some_and(|v| !v.is_empty())
    {
        return if ws {
            ws_error(508)
        } else {
            no_store(json_error(&ctx, 508, "service_route_loop"))
        };
    }
    let target = Url::parse(hit["target"].as_str().unwrap()).expect("validated service target");
    let suffix = service_routes::upstream_suffix(&ctx.original_url, &prefix);
    match runtime
        .transport
        .forward(request, &target, &prefix, &suffix, ws)
        .await
    {
        Ok(mut response) => {
            if !ws {
                // The old handler retained these middleware headers while
                // replacing the other headers with the sanitized upstream's.
                for (name, value) in [
                    ("x-powered-by", "Express"),
                    ("x-multicc-request-id", ctx.ids.0.as_str()),
                    ("x-correlation-id", ctx.ids.1.as_str()),
                    ("x-multicc-api-version", http_gate::API_VERSION),
                ] {
                    if !response.headers().contains_key(name) {
                        if let Ok(v) = value.parse() {
                            response.headers_mut().insert(name, v);
                        }
                    }
                }
                express::log_request(&ctx, response.status().as_u16());
            }
            response
        }
        Err(()) => {
            if ws {
                ws_error(502)
            } else {
                no_store(json_error(&ctx, 502, "upstream_unavailable"))
            }
        }
    }
}

async fn management_entry(
    app: Arc<App>,
    runtime: Arc<Runtime>,
    ctx: &RequestCtx,
    body: Body,
    peer: &str,
    snapshot: Snapshot,
) -> Response<Body> {
    if snapshot.shutting_down {
        return express::json(
            ctx,
            503,
            &http_gate::error_dto(
                "SERVER_SHUTTING_DOWN",
                "server is shutting down",
                &[],
                &ctx.ids,
            ),
            &[("Retry-After", "1")],
        );
    }
    if app.lan_only && !http_gate::is_private_network_address(peer) {
        return express::json(
            ctx,
            403,
            &http_gate::public_peer_rejected_dto(&ctx.ids),
            &[],
        );
    }
    let public =
        multicc_core::http_entry::public_path(ctx.method.as_str(), &ctx.path.as_str().into());
    let bootstrap = !public
        && ctx.method == Method::GET
        && !ctx.path.starts_with("/api/")
        && multicc_core::auth_security::verify_access_token(
            &snapshot.secret,
            http_gate::query_token(&ctx.original_url).as_deref(),
        );
    if !public && !bootstrap {
        if let Some(refusal) = app.gate(ctx, peer, &snapshot) {
            return refusal;
        }
    }
    let cookie = if bootstrap {
        match super::auth::cookie(ctx, &snapshot.secret) {
            Ok(v) => Some(v),
            Err(_) => return express::error(ctx, 500, "cookie entropy unavailable"),
        }
    } else {
        None
    };
    let response = management_body(app, runtime, ctx, body, peer).await;
    match cookie {
        Some(cookie) => super::auth::with_cookie(response, &cookie),
        None => response,
    }
}

async fn management_body(
    app: Arc<App>,
    runtime: Arc<Runtime>,
    ctx: &RequestCtx,
    body: Body,
    peer: &str,
) -> Response<Body> {
    let body = match express::json_body_js(ctx, body, express::JSON_LIMIT).await {
        Ok(v) => v,
        Err(e) => return express::error(ctx, e.status, e.reason),
    };
    // Re-read after body I/O: revoked credentials or shutdown cannot mutate routes.
    let snapshot = match app.auth.snapshot().await {
        Ok(v) => v,
        Err(_) => return express::error(ctx, 503, "authentication runtime unavailable"),
    };
    if snapshot.shutting_down {
        return express::json(
            ctx,
            503,
            &http_gate::error_dto(
                "SERVER_SHUTTING_DOWN",
                "server is shutting down",
                &[],
                &ctx.ids,
            ),
            &[("Retry-After", "1")],
        );
    }
    if !authenticated(&app, ctx, peer, &snapshot, false) {
        return json_error(ctx, 401, "authentication_required");
    }
    if !matches!(ctx.method, Method::GET | Method::HEAD)
        && !service_routes::same_origin_host(ctx.headers.get("origin"), ctx.headers.get("host"))
    {
        return json_error(ctx, 403, "origin_mismatch");
    }
    management(runtime, ctx, body).await
}

async fn management(runtime: Arc<Runtime>, ctx: &RequestCtx, body: JsValue) -> Response<Body> {
    let path = ctx.path.strip_suffix('/').unwrap_or(&ctx.path);
    let name = path
        .get("/api/service-routes/".len()..)
        .filter(|s| !s.is_empty() && !s.contains('/'));
    let root = path.eq_ignore_ascii_case("/api/service-routes");
    let name = match name {
        Some(raw) => match super::download::decode_uri_component(raw) {
            Some(name) => Some(name),
            None => return express::error(ctx, 400, "invalid route parameter"),
        },
        None => None,
    };
    if ctx.method == Method::OPTIONS && (root || name.is_some()) {
        return super::options(ctx, if root { "GET,HEAD" } else { "PUT,DELETE" });
    }
    let method = ctx.method.clone();
    if !(root && matches!(method, Method::GET | Method::HEAD)
        || name.is_some() && matches!(method, Method::PUT | Method::DELETE))
    {
        return express::not_found(ctx);
    }
    let result = tokio::task::spawn_blocking(move || {
        let mut store = runtime.store.lock().unwrap_or_else(|e| e.into_inner());
        if root {
            return (200, store.list());
        }
        let name = name.unwrap();
        let route = if method == Method::PUT {
            let mut fields = vec![("name", JsValue::string(&name))];
            for field in ["target", "access", "enabled"] {
                fields.push((
                    field,
                    body.get(field).cloned().unwrap_or(JsValue::Undefined),
                ));
            }
            match service_routes::validate(&JsValue::object(fields)) {
                Ok(route) => {
                    if route["access"] == "public"
                        && body.get("acknowledgePublicRisk") != Some(&JsValue::Bool(true))
                    {
                        return (400, json!({"error": "启用免密码模式必须确认公开访问风险"}));
                    }
                    Some(route)
                }
                Err(error) => return (400, json!({"error": error})),
            }
        } else {
            None
        };
        match store.update(&name, route.clone()) {
            Ok(()) => (200, route.unwrap_or(json!({"ok":true}))),
            Err(_) => (500, json!({"error":"service_routes_save_failed"})),
        }
    })
    .await;
    match result {
        Ok((status, value)) => express::json(ctx, status, &value, &[]),
        Err(_) => express::error(ctx, 500, "service store panicked"),
    }
}
