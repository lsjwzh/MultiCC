//! Authentication endpoints owned by the front door. No Express req/res and
//! no HTTP hop to Node; WS tickets go to the same Rust table Node consumes.
use super::{
    express::{self, RequestCtx},
    App,
};
use axum::{
    body::Body,
    http::{Method, Response},
};
use multicc_core::{
    auth_runtime::{Request, Response as Reply, Snapshot},
    auth_security as auth,
    http_gate::{self, QueryParam},
};
use serde_json::json;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    Page,
    Login,
    Logout,
    Exchange,
    Ticket,
    LoginOptions,
    LogoutOptions,
    PostOptions,
}

pub fn claim(method: &Method, path: &str) -> Option<Route> {
    let path = path.strip_suffix('/').unwrap_or(path).to_ascii_lowercase();
    Some(match (path.as_str(), method.as_str()) {
        ("/login", "GET" | "HEAD") => Route::Page,
        ("/login", "POST") => Route::Login,
        ("/logout", "GET" | "HEAD") => Route::Logout,
        ("/api/auth/exchange", "POST") => Route::Exchange,
        ("/api/auth/ws-ticket", "POST") => Route::Ticket,
        ("/login", "OPTIONS") => Route::LoginOptions,
        ("/logout", "OPTIONS") => Route::LogoutOptions,
        ("/api/auth/exchange" | "/api/auth/ws-ticket", "OPTIONS") => Route::PostOptions,
        _ => return None,
    })
}

pub(super) fn cookie(ctx: &RequestCtx, secret: &str) -> Result<String, ()> {
    let nonce = auth::random_base64url(8).map_err(|_| ())?;
    let body = auth::cookie_body(super::now_ms() as f64, auth::COOKIE_TTL_MS as f64, &nonce);
    let secure = ctx.headers.get("x-forwarded-proto").is_some_and(|v| {
        multicc_core::js::string::js_trim(v.split(',').next().unwrap_or("")) == "https"
    });
    Ok(format!(
        "multicc_auth={body}.{}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000{}",
        auth::sign(secret, &body),
        if secure { "; Secure" } else { "" }
    ))
}

pub(super) fn with_cookie(mut response: Response<Body>, cookie: &str) -> Response<Body> {
    if let Ok(value) = cookie.parse() {
        response.headers_mut().insert("set-cookie", value);
    }
    response
}

fn invalid(ctx: &RequestCtx, ticket: bool) -> Response<Body> {
    let (code, message, category, action, scope, status) = if ticket {
        (
            "WS_PATH_INVALID",
            "invalid WebSocket path",
            "route",
            "check_route",
            "session",
            400,
        )
    } else {
        (
            "AUTH_TOKEN_INVALID",
            "Forbidden: invalid access token",
            "authentication_permission",
            "login",
            "request",
            403,
        )
    };
    express::json(
        ctx,
        status,
        &http_gate::error_dto(
            code,
            message,
            &[
                ("category", json!(category)),
                ("detail", json!(message)),
                ("retryable", json!(false)),
                ("action", json!(action)),
                ("scope", json!(scope)),
            ],
            &ctx.ids,
        ),
        &[],
    )
}

pub async fn handle(
    app: &App,
    route: Route,
    ctx: &RequestCtx,
    body: Body,
    peer: &str,
    mut snapshot: Snapshot,
) -> Response<Body> {
    if app.lan_only && !http_gate::is_private_network_address(peer) {
        return express::json(
            ctx,
            403,
            &http_gate::public_peer_rejected_dto(&ctx.ids),
            &[],
        );
    }
    let public = matches!(route, Route::Page | Route::Login | Route::Logout)
        || matches!(ctx.path.as_str(), "/login" | "/logout");
    if !public {
        if let Some(refusal) = app.gate(ctx, peer, &snapshot) {
            return refusal;
        }
    }
    if matches!(
        route,
        Route::LoginOptions | Route::LogoutOptions | Route::PostOptions
    ) {
        if let Err(error) = express::json_body(ctx, body, express::JSON_LIMIT).await {
            return express::error(ctx, error.status, error.reason);
        }
        return super::options(
            ctx,
            match route {
                Route::LoginOptions => "GET,HEAD,POST",
                Route::LogoutOptions => "GET,HEAD",
                _ => "POST",
            },
        );
    }
    match route {
        Route::Page => {
            let failed = match http_gate::query_param(&ctx.original_url, "error") {
                QueryParam::Missing => false,
                QueryParam::Text(v) => !v.is_empty(),
                QueryParam::Other => true,
            };
            let redirect = match http_gate::query_param(&ctx.original_url, "redirect") {
                QueryParam::Text(v) => auth::normalize_redirect(&v),
                _ => None,
            }
            .unwrap_or_else(|| "/".into());
            let escaped = redirect
                .replace('&', "&amp;")
                .replace('<', "&lt;")
                .replace('>', "&gt;")
                .replace('"', "&quot;")
                .replace('\'', "&#39;");
            let parts = multicc_core::auth_login_page::PARTS;
            let page = format!(
                "{}{}{}{}{}",
                parts[0],
                if failed {
                    "<p style=\"color:#f85149;margin-bottom:16px;\">密码错误</p>"
                } else {
                    ""
                },
                parts[1],
                escaped,
                parts[2]
            );
            express::send(ctx, 200, "text/html; charset=utf-8", page.into_bytes(), &[])
        }
        Route::Login => {
            let form = match express::form_body(ctx, body).await {
                Ok(value) => value,
                Err(error) => return express::error(ctx, error.status, error.reason),
            };
            snapshot = match app.auth.snapshot().await {
                Ok(value) => value,
                Err(_) => return express::error(ctx, 503, "authentication runtime unavailable"),
            };
            let redirect = form
                .get("redirect")
                .and_then(|v| v.as_str())
                .and_then(auth::normalize_redirect)
                .unwrap_or_else(|| "/".into());
            if auth::verify_access_token(
                &snapshot.secret,
                form.get("password").and_then(|v| v.as_str()),
            ) {
                match cookie(ctx, &snapshot.secret) {
                    Ok(cookie) => with_cookie(express::redirect(ctx, &redirect), &cookie),
                    Err(()) => express::error(ctx, 500, "cookie entropy unavailable"),
                }
            } else {
                express::redirect(
                    ctx,
                    &format!(
                        "/login?error=1&redirect={}",
                        http_gate::encode_uri_component(&redirect)
                    ),
                )
            }
        }
        Route::Logout => with_cookie(
            express::redirect(ctx, "/login"),
            "multicc_auth=; Path=/; HttpOnly; Max-Age=0",
        ),
        Route::Exchange => {
            if !auth::verify_access_token(&snapshot.secret, ctx.headers.get("x-access-token")) {
                return invalid(ctx, false);
            }
            match cookie(ctx, &snapshot.secret) {
                Ok(cookie) => {
                    express::log_request(ctx, 204);
                    express::with_base_headers(Response::builder().status(204), ctx)
                        .header("set-cookie", cookie)
                        .body(Body::empty())
                        .expect("cookie response")
                }
                Err(()) => express::error(ctx, 500, "cookie entropy unavailable"),
            }
        }
        Route::Ticket => {
            let value = match express::json_body_js(ctx, body, 4096).await {
                Ok(value) => value,
                Err(error) => return express::error(ctx, error.status, error.reason),
            };
            // Re-evaluate after body I/O; rotation/shutdown cannot mint a ticket
            // from stale authentication. The issue RPC checks revision atomically.
            snapshot = match app.auth.snapshot().await {
                Ok(value) => value,
                Err(_) => return express::error(ctx, 503, "authentication runtime unavailable"),
            };
            if let Some(refusal) = app.gate(ctx, peer, &snapshot) {
                return refusal;
            }
            let path_value = value.get("path");
            let path = match path_value.filter(|v| multicc_core::js::truthy(v)) {
                None => "/".to_string(),
                Some(multicc_core::js::JsValue::String(v)) => v.to_string_lossy(),
                _ => return invalid(ctx, true),
            };
            if auth::normalize_ws_path(&path).is_none() {
                return invalid(ctx, true);
            }
            let mut metadata = json!({"correlationId": ctx.ids.1, "requestId": ctx.ids.0});
            if let Some(grant) = ctx
                .headers
                .get("x-multicc-machine-grant")
                .filter(|v| !v.is_empty())
            {
                let root = app.data_root.to_string_lossy().into_owned();
                match multicc_core::machines::authorize(
                    &root,
                    grant,
                    ctx.method.as_str(),
                    &ctx.original_url,
                ) {
                    Some(id) => metadata["machineGrantId"] = json!(id),
                    None => {
                        return express::json(
                            ctx,
                            403,
                            &http_gate::auth_required_dto(&ctx.ids),
                            &[],
                        )
                    }
                }
            }
            match app
                .auth
                .request(Request::IssueTicket {
                    revision: snapshot.revision,
                    path,
                    metadata,
                })
                .await
            {
                Ok(Reply::Ticket {
                    ticket,
                    path,
                    expires_at,
                }) => express::json(
                    ctx,
                    200,
                    &json!({"ticket": ticket, "expiresAt": expires_at, "path": path}),
                    &[("Cache-Control", "no-store")],
                ),
                Ok(Reply::Invalid) => invalid(ctx, true),
                _ => express::error(ctx, 503, "authentication state changed or unavailable"),
            }
        }
        Route::LoginOptions => super::options(ctx, "GET,HEAD,POST"),
        Route::LogoutOptions => super::options(ctx, "GET,HEAD"),
        Route::PostOptions => super::options(ctx, "POST"),
    }
}
