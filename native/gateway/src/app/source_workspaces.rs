//! Share administration and state HTTP are owned here. The Rust channel addresses
//! the same source Store used by remaining live-context/WS consumers.
use super::{
    express::{self, RequestCtx},
    external_workspaces::{failure, send_json},
    App,
};
use axum::{
    body::Body,
    http::{Method, Response},
};
use multicc_core::{
    http_gate,
    js::{self, JsValue as V},
    workspace_sharing::{self as sharing, control},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    Landing,
    LandingOptions,
    Create,
    List,
    Revoke,
    State,
    Import,
    Ticket,
    Options(&'static str),
}

pub fn claim(method: &Method, path: &str) -> Option<Route> {
    let p = path
        .strip_suffix('/')
        .unwrap_or(path)
        .split('/')
        .collect::<Vec<_>>();
    if p.len() == 3
        && p[0].is_empty()
        && p[1].eq_ignore_ascii_case("fleet-share")
        && !p[2].is_empty()
    {
        return match method.as_str() {
            "GET" | "HEAD" => Some(Route::Landing),
            "OPTIONS" => Some(Route::LandingOptions),
            _ => None,
        };
    }
    if p.len() == 5
        && p[0].is_empty()
        && p[1].eq_ignore_ascii_case("api")
        && p[2].eq_ignore_ascii_case("fleet-shares")
        && !p[3].is_empty()
    {
        return match (p[4].to_ascii_lowercase().as_str(), method.as_str()) {
            ("state", "GET" | "HEAD") => Some(Route::State),
            ("state", "OPTIONS") => Some(Route::Options("GET,HEAD")),
            ("import", "POST") => Some(Route::Import),
            ("import", "OPTIONS") => Some(Route::Options("POST")),
            ("ws-ticket", "POST") => Some(Route::Ticket),
            ("ws-ticket", "OPTIONS") => Some(Route::Options("POST")),
            _ => None,
        };
    }
    if p.len() < 5
        || p[0] != ""
        || !p[1].eq_ignore_ascii_case("api")
        || !p[2].eq_ignore_ascii_case("fleets")
        || p[3].is_empty()
    {
        return None;
    }
    let (route, allow) = if p.len() == 5
        && p[4].eq_ignore_ascii_case("share")
        && matches!(method.as_str(), "POST" | "OPTIONS")
    {
        (Route::Create, "POST")
    } else if p.len() == 5
        && p[4].eq_ignore_ascii_case("shares")
        && matches!(method.as_str(), "GET" | "HEAD" | "OPTIONS")
    {
        (Route::List, "GET,HEAD")
    } else if p.len() == 6
        && p[4].eq_ignore_ascii_case("share")
        && !p[5].is_empty()
        && matches!(method.as_str(), "DELETE" | "OPTIONS")
    {
        (Route::Revoke, "DELETE")
    } else {
        return None;
    };
    Some(if method == Method::OPTIONS {
        Route::Options(allow)
    } else {
        route
    })
}

fn origin(ctx: &RequestCtx) -> String {
    let forwarded = js::string::js_trim(
        ctx.headers
            .get("x-forwarded-proto")
            .unwrap_or("")
            .split(',')
            .next()
            .unwrap_or(""),
    )
    .to_lowercase();
    let protocol = if forwarded == "https" {
        "https"
    } else {
        "http"
    };
    format!(
        "{protocol}://{}",
        ctx.headers.get("host").unwrap_or("undefined")
    )
}

async fn admit(
    app: &App,
    route: Route,
    ctx: &RequestCtx,
    peer: &str,
    snapshot: &multicc_core::auth_runtime::Snapshot,
) -> Option<Response<Body>> {
    // The transport peer gate always precedes a share capability. A successful
    // share scope precedes machine/global authentication, matching Node entry.
    if app.lan_only && !http_gate::is_private_network_address(peer) {
        return app.gate(ctx, peer, snapshot);
    }
    if bootstrap(ctx, snapshot) {
        return None;
    }
    if matches!(
        route,
        Route::Import | Route::Ticket | Route::Landing | Route::LandingOptions
    ) && multicc_core::http_entry::public_path(ctx.method.as_str(), &ctx.path.as_str().into())
    {
        return None;
    }
    if route == Route::State {
        if let (Some(token), Some(grant)) = (
            ctx.headers
                .get("x-multicc-fleet-token")
                .filter(|v| !v.is_empty()),
            ctx.headers
                .get("x-multicc-fleet-grant")
                .filter(|v| !v.is_empty()),
        ) {
            let input = V::object(vec![
                ("token", V::string(token)),
                ("grant", V::string(grant)),
                ("method", V::string(ctx.method.as_str())),
                ("pathname", V::string(&ctx.original_url)),
            ]);
            let request = control::Request::Authorize {
                input: js::json::json_encode_wire(&input).unwrap(),
            };
            match app
                .source_workspaces
                .workspace(&request)
                .await
                .and_then(|v| control::decode(&v))
            {
                Ok(Ok(V::Bool(true))) => return None,
                Ok(Ok(_)) => {}
                Ok(Err(e)) => return Some(failure(ctx, e)),
                Err(_) => {
                    return Some(express::error(
                        ctx,
                        503,
                        "workspace source runtime unavailable",
                    ))
                }
            }
        }
    }
    app.gate(ctx, peer, snapshot)
}

fn bootstrap(ctx: &RequestCtx, snapshot: &multicc_core::auth_runtime::Snapshot) -> bool {
    ctx.method == Method::GET
        && !ctx.path.starts_with("/api/")
        // Public routes return before the legacy query-token cookie bootstrap.
        && !multicc_core::http_entry::public_path(ctx.method.as_str(), &ctx.path.as_str().into())
        && matches!(http_gate::query_param(&ctx.original_url, "token"),
            http_gate::QueryParam::Text(token) if multicc_core::auth_security::verify_access_token(&snapshot.secret, Some(&token)))
}

pub async fn handle(
    app: &App,
    route: Route,
    ctx: &RequestCtx,
    peer: &str,
    body: Body,
    snapshot: multicc_core::auth_runtime::Snapshot,
) -> Response<Body> {
    // The legacy bootstrap cookie is attached before JSON/route processing,
    // including its error responses. Peer rejection must never mint a cookie.
    let cookie = if bootstrap(ctx, &snapshot)
        && (!app.lan_only || http_gate::is_private_network_address(peer))
    {
        match super::auth::cookie(ctx, &snapshot.secret) {
            Ok(cookie) => Some(cookie),
            Err(_) => return express::error(ctx, 500, "cookie entropy unavailable"),
        }
    } else {
        None
    };
    let response = handle_request(app, route, ctx, peer, body, snapshot).await;
    match cookie {
        Some(cookie) => super::auth::with_cookie(response, &cookie),
        None => response,
    }
}

async fn handle_request(
    app: &App,
    route: Route,
    ctx: &RequestCtx,
    peer: &str,
    body: Body,
    snapshot: multicc_core::auth_runtime::Snapshot,
) -> Response<Body> {
    if let Some(refusal) = admit(app, route, ctx, peer, &snapshot).await {
        return refusal;
    }
    let parsed = match express::json_body_js(ctx, body, express::JSON_LIMIT).await {
        Ok(v) => v,
        Err(e) => return express::error(ctx, e.status, e.reason),
    };
    let p = ctx
        .path
        .trim_end_matches('/')
        .split('/')
        .collect::<Vec<_>>();
    let decode = super::download::decode_uri_component;
    if matches!(route, Route::Landing | Route::LandingOptions) {
        if decode(p[2]).is_none() {
            return express::error(ctx, 400, "Failed to decode param");
        }
        if route == Route::LandingOptions {
            return super::options(ctx, "GET,HEAD");
        }
        // The landing file contains no scoped data and does not read the source
        // Store. Preserve the non-API shutdown and bootstrap-cookie behavior.
        return super::download::send_file(
            ctx,
            &app.public_dir.join("fleet-share.html").to_string_lossy(),
            false,
        )
        .await;
    }
    let Some(id) = decode(p[3]) else {
        return express::error(ctx, 400, "Failed to decode param");
    };
    let token = if p.len() == 6 {
        match decode(p[5]) {
            Some(v) => v,
            None => return express::error(ctx, 400, "Failed to decode param"),
        }
    } else {
        String::new()
    };
    if let Route::Options(allow) = route {
        return super::options(ctx, allow);
    }
    // A slow body must not carry an old credential past rotation or shutdown.
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
    if let Some(refusal) = admit(app, route, ctx, peer, &snapshot).await {
        return refusal;
    }
    let request = match route {
        Route::Create => control::Request::Create {
            id,
            options: js::json::json_encode_wire(&parsed).unwrap_or_else(|| "{}".into()),
        },
        Route::List => control::Request::List { id },
        Route::Revoke => control::Request::Revoke { id, token },
        Route::State => control::Request::State {
            token: id,
            grant: ctx.headers.get("x-multicc-fleet-grant").map(str::to_owned),
        },
        Route::Import => control::Request::Import {
            input: js::json::json_encode_wire(&V::object(vec![
                ("token", V::string(&id)),
                ("ip", V::string(peer)),
                ("password", sharing::get(&parsed, "password").clone()),
            ]))
            .unwrap(),
        },
        Route::Ticket => control::Request::Ticket {
            revision: snapshot.revision,
            input: js::json::json_encode_wire(&V::object(vec![
                ("token", V::string(&id)),
                (
                    "grant",
                    ctx.headers
                        .get("x-multicc-fleet-grant")
                        .map(V::string)
                        .unwrap_or(V::Undefined),
                ),
                ("pathname", sharing::get(&parsed, "pathname").clone()),
                ("sessionId", sharing::get(&parsed, "sessionId").clone()),
                ("directoryId", sharing::get(&parsed, "directoryId").clone()),
            ]))
            .unwrap(),
        },
        _ => unreachable!(),
    };
    let result = match app
        .source_workspaces
        .workspace(&request)
        .await
        .and_then(|v| control::decode(&v))
    {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => return failure(ctx, e),
        Err(_) => return express::error(ctx, 503, "workspace source runtime unavailable"),
    };
    if matches!(route, Route::State | Route::Import) {
        return send_json(ctx, &result, &[("Cache-Control", "no-store")]);
    }
    if route == Route::Ticket {
        let mut ticket = result;
        let origin = origin(ctx)
            .replacen("http:", "ws:", 1)
            .replacen("https:", "wss:", 1);
        sharing::put(&mut ticket, "wsOrigin", V::string(&origin));
        return send_json(ctx, &ticket, &[]);
    }
    let value = if route == Route::List {
        let origin = origin(ctx);
        let rows = sharing::array(&result)
            .iter()
            .cloned()
            .map(|mut record| {
                let mut url = js::JsString::from_rust_str(&format!("{origin}/fleet-share/"));
                url.push(&js::js_to_string(sharing::get(&record, "token")));
                sharing::put(&mut record, "url", V::String(url));
                record
            })
            .collect();
        V::object(vec![("shares", V::Array(rows))])
    } else if route == Route::Create {
        let mut record = V::object(vec![("ok", true.into())]);
        if let V::Object(fields) = result {
            for (key, value) in fields {
                sharing::put(&mut record, &key.to_string_lossy(), value);
            }
        }
        let mut url = js::JsString::from_rust_str(&format!("{}/fleet-share/", origin(ctx)));
        url.push(&js::js_to_string(sharing::get(&record, "token")));
        sharing::put(&mut record, "url", V::String(url));
        record
    } else {
        V::object(vec![("ok", result)])
    };
    send_json(ctx, &value, &[])
}
