//! Imported workspace endpoints and upload bodies stay in the public Rust host.
use super::{
    express::{self, RequestCtx},
    App,
};
use axum::{
    body::Body,
    http::{Method, Request, Response},
};
use futures_util::StreamExt;
use multicc_core::{
    api_contract, http_gate,
    js::{self, JsValue as V},
    workspace_sharing::{self as sharing},
};
use sharing::{get, text, truth};
use std::{net::SocketAddr, sync::Arc};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    List,
    Import,
    Remove,
    Refresh,
    Ticket,
    Proxy,
    Options(&'static str),
}
fn parts(path: &str) -> Option<Vec<&str>> {
    let parts = path.split('/').collect::<Vec<_>>();
    (parts.len() >= 3
        && parts[0].is_empty()
        && parts[1].eq_ignore_ascii_case("api")
        && parts[2].eq_ignore_ascii_case("external-fleets"))
    .then_some(parts)
}
pub fn claim(method: &Method, path: &str) -> Option<Route> {
    let p = parts(path)?;
    if p.len() >= 6 && !p[3].is_empty() && p[4].eq_ignore_ascii_case("remote") {
        return Some(Route::Proxy);
    }
    let p = parts(path.strip_suffix('/').unwrap_or(path))?;
    let (route, allow) = match p.as_slice() {
        [_, _, _]
            if method == Method::GET || method == Method::HEAD || method == Method::OPTIONS =>
        {
            (Route::List, "GET,HEAD")
        }
        [_, _, _, tail]
            if tail.eq_ignore_ascii_case("import")
                && (method == Method::POST || method == Method::OPTIONS) =>
        {
            (Route::Import, "POST,DELETE")
        }
        [_, _, _, id]
            if !id.is_empty() && (method == Method::DELETE || method == Method::OPTIONS) =>
        {
            (Route::Remove, "DELETE")
        }
        [_, _, _, id, action]
            if !id.is_empty()
                && action.eq_ignore_ascii_case("refresh")
                && (method == Method::POST || method == Method::OPTIONS) =>
        {
            (Route::Refresh, "POST")
        }
        [_, _, _, id, action]
            if !id.is_empty()
                && action.eq_ignore_ascii_case("ws-ticket")
                && (method == Method::POST || method == Method::OPTIONS) =>
        {
            (Route::Ticket, "POST")
        }
        _ => return None,
    };
    Some(if method == Method::OPTIONS {
        Route::Options(allow)
    } else {
        route
    })
}
fn decode(raw: &str) -> Option<String> {
    let mut out = Vec::new();
    let b = raw.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let pair = b.get(i + 1..i + 3)?;
            let hi = (pair[0] as char).to_digit(16)?;
            let lo = (pair[1] as char).to_digit(16)?;
            out.push((hi * 16 + lo) as u8);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}
pub(super) fn send_json(ctx: &RequestCtx, value: &V, extra: &[(&str, &str)]) -> Response<Body> {
    express::send(
        ctx,
        200,
        "application/json; charset=utf-8",
        js::json_stringify(value)
            .unwrap_or_else(|| "null".into())
            .into_bytes(),
        extra,
    )
}
pub(super) fn failure(ctx: &RequestCtx, error: sharing::Error) -> Response<Body> {
    let internal = error.code == "WORKSPACE_SHARING_INTERNAL";
    let code = if internal {
        "INTERNAL_ERROR"
    } else {
        &error.code
    };
    let status = if internal { 500 } else { error.status };
    let auth = status == 401 || status == 403;
    let remote = get(&error.metadata, "category") == &V::string("remote")
        || code.contains("REMOTE")
        || code.contains("EXTERNAL");
    let retryable = match get(&error.metadata, "retryable") {
        V::Bool(v) => *v,
        _ => remote && [408, 425, 429, 500, 502, 503, 504].contains(&status),
    };
    let or = |key, default: &str| {
        let v = get(&error.metadata, key);
        if truth(v) {
            v.clone()
        } else {
            V::string(default)
        }
    };
    let upstream = get(&error.metadata, "upstreamRequestId");
    let mut detail = if truth(get(&error.metadata, "detail")) {
        js::js_to_string(get(&error.metadata, "detail"))
    } else {
        error.message.clone()
    };
    if truth(upstream) {
        detail.push_str(" · upstream requestId ");
        detail.push(&js::js_to_string(upstream));
    }
    let input = V::object(vec![
        ("code", V::string(code)),
        ("message", V::String(error.message.clone())),
        ("detail", V::String(detail)),
        (
            "category",
            or(
                "category",
                if internal {
                    "internal"
                } else if auth {
                    "authentication_permission"
                } else if remote {
                    "remote"
                } else if status == 409 {
                    "conflict"
                } else {
                    "route"
                },
            ),
        ),
        ("retryable", retryable.into()),
        (
            "action",
            or(
                "action",
                if internal {
                    "copy_details"
                } else if auth {
                    "login"
                } else if retryable {
                    "retry"
                } else {
                    "revise"
                },
            ),
        ),
        ("scope", or("scope", "request")),
        ("cause", get(&error.metadata, "causeCode").clone()),
        ("upstreamRequestId", upstream.clone()),
        ("httpStatus", V::Number(status.into())),
    ]);
    let dto = api_contract::error_dto(&input, &ctx.ids);
    let upstream = text(upstream);
    let extra = if truth(get(&error.metadata, "upstreamRequestId")) {
        vec![("X-Multicc-Upstream-Request-Id", upstream.as_str())]
    } else {
        vec![]
    };
    express::send(
        ctx,
        status,
        "application/json; charset=utf-8",
        js::json_stringify(&dto).unwrap().into_bytes(),
        &extra,
    )
}
fn unavailable(ctx: &RequestCtx) -> Response<Body> {
    express::error(ctx, 503, "external workspace runtime unavailable")
}
pub async fn handle(
    app: Arc<App>,
    route: Route,
    request: Request<Body>,
    client: SocketAddr,
) -> Response<Body> {
    let (parts, body) = request.into_parts();
    let ctx = RequestCtx::new(&parts);
    let peer = client.ip().to_string();
    let snapshot = match app.auth.snapshot().await {
        Ok(v) => v,
        Err(_) => return express::error(&ctx, 503, "authentication runtime unavailable"),
    };
    if snapshot.shutting_down {
        return express::json(
            &ctx,
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
    if let Some(refusal) = app.gate(&ctx, &peer, &snapshot) {
        return refusal;
    }
    let Some(runtime) = app.external_workspaces.get().cloned() else {
        return unavailable(&ctx);
    };
    // JSON keeps the existing parsed-body contract. Other upload formats stream
    // directly into reqwest with Hyper backpressure; never enter a Node socket.
    let json = ctx.headers.get("content-type").is_some_and(|v| {
        v.split(';')
            .next()
            .unwrap_or("")
            .trim()
            .eq_ignore_ascii_case("application/json")
    });
    let (parsed, upload) = if route == Route::Proxy && !json {
        (
            V::Object(vec![]),
            Some(Box::pin(
                body.into_data_stream()
                    .map(|chunk| chunk.map_err(std::io::Error::other)),
            ) as sharing::transport::Upload),
        )
    } else {
        match express::json_body_js(&ctx, body, express::JSON_LIMIT).await {
            Ok(v) => (v, None),
            Err(e) => return express::error(&ctx, e.status, e.reason),
        }
    };
    let raw_parts = ctx.path.split('/').collect::<Vec<_>>();
    let raw_id = raw_parts.get(3).copied().unwrap_or("");
    let id = match decode(raw_id) {
        Some(v) => V::string(&v),
        None => return express::error(&ctx, 400, "Failed to decode param"),
    };
    let mut pathname = String::new();
    if route == Route::Proxy {
        let suffix = raw_parts[5..].join("/");
        let suffix = match decode(&suffix) {
            Some(v) => v,
            None => return express::error(&ctx, 400, "Failed to decode param"),
        };
        pathname = format!("/{}", suffix.trim_start_matches('/'));
        if let Some((_, q)) = ctx.original_url.split_once('?') {
            pathname.push('?');
            pathname.push_str(q);
        }
    }
    if let Route::Options(allow) = route {
        return super::options(&ctx, allow);
    }
    // Recheck credentials/closure after buffered input before any mutation.
    if upload.is_none() {
        let current = match app.auth.snapshot().await {
            Ok(v) => v,
            Err(_) => return unavailable(&ctx),
        };
        if current.shutting_down {
            return express::json(
                &ctx,
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
        if let Some(refusal) = app.gate(&ctx, &peer, &current) {
            return refusal;
        }
    }
    let now = super::now_ms() as f64;
    if route == Route::List {
        return match runtime.query("listExternal", &V::Null, now) {
            Ok(v) => send_json(&ctx, &V::object(vec![("fleets", v)]), &[]),
            Err(e) => failure(&ctx, e),
        };
    }
    if route == Route::Proxy && ctx.method == Method::GET {
        match runtime.projection(&id, &pathname, now) {
            Ok(Some(v)) => return send_json(&ctx, &v, &[]),
            Err(e) => return failure(&ctx, e),
            _ => {}
        }
    }
    let context = V::object(vec![("correlationId", V::string(&ctx.ids.1))]);
    let request = if route == Route::Proxy {
        V::object(vec![
            ("method", V::string(ctx.method.as_str())),
            ("pathname", V::string(&pathname)),
            (
                "headers",
                V::object(vec![
                    ("accept", V::string(ctx.headers.get("accept").unwrap_or(""))),
                    (
                        "content-type",
                        V::string(ctx.headers.get("content-type").unwrap_or("")),
                    ),
                    ("x-correlation-id", V::string(&ctx.ids.1)),
                ]),
            ),
        ])
    } else {
        parsed.clone()
    };
    let bytes =
        (route == Route::Proxy && json && ctx.method != Method::GET && ctx.method != Method::HEAD)
            .then(|| js::json_stringify(&parsed).unwrap().into_bytes());
    let operation = match route {
        Route::Import => "importExternal",
        Route::Remove => "removeExternal",
        Route::Refresh => "refreshExternal",
        Route::Ticket => "issueExternalWsTicket",
        Route::Proxy => "proxyExternal",
        _ => unreachable!(),
    };
    let input = V::object(vec![("id", id), ("request", request), ("context", context)]);
    match runtime
        .operate(
            operation,
            input,
            bytes,
            upload,
            None,
            sharing::DEFAULT_TIMEOUT_MS as f64,
        )
        .await
    {
        Err(e) => failure(&ctx, e),
        Ok(result) => match route {
            Route::Import | Route::Refresh => send_json(
                &ctx,
                &V::object(vec![("ok", true.into()), ("fleet", result.value)]),
                &[],
            ),
            Route::Remove => send_json(&ctx, &V::object(vec![("ok", result.value)]), &[]),
            Route::Ticket => send_json(&ctx, &result.value, &[("Cache-Control", "no-store")]),
            Route::Proxy => {
                let status = sharing::number(get(&result.value, "status")) as u16;
                let content_type = text(get(&result.value, "contentType"));
                let content_type = if content_type.is_empty() {
                    "application/octet-stream"
                } else {
                    &content_type
                };
                let cache = text(get(&result.value, "cacheControl"));
                let upstream = text(get(&result.value, "upstreamRequestId"));
                let mut headers = vec![];
                if !cache.is_empty() {
                    headers.push(("Cache-Control", cache.as_str()));
                }
                if truth(get(&result.value, "upstreamRequestId")) {
                    headers.push(("X-Multicc-Upstream-Request-Id", upstream.as_str()));
                }
                express::send(&ctx, status, content_type, result.bytes, &headers)
            }
            _ => unreachable!(),
        },
    }
}
