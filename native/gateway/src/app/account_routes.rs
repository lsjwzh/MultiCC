//! The account / credential route cluster retired from `src/routes/claude-accounts.js`,
//! `codex-accounts.js`, `zcode-auth.js`, `cli-key-accounts.js`, `kimi-auth.js`,
//! `claude-oauth.js`, `codex-oauth.js` and `commandcode-auth.js`:
//!
//! * `GET|HEAD|POST /api/claude/accounts`
//! * `POST          /api/claude/accounts/:id/activate`
//! * `GET|HEAD      /api/claude/accounts/:id/login-status`
//! * `POST          /api/claude/accounts/:id/login-callback`
//! * `POST          /api/claude/accounts/:id/relogin`
//! * `DELETE        /api/claude/accounts/:id`
//! * `GET|HEAD      /api/claude/accounts/:id/quota`
//! * the same seven shapes under `/api/codex/accounts` minus the quota read
//! * `GET|HEAD|PUT  /api/zcode/auth`, `POST /api/zcode/auth/sync`,
//!   `GET|HEAD      /api/zcode/auth/check`
//! * `GET|HEAD|PUT  /api/kimi/auth`, `GET|HEAD /api/kimi/auth/check`
//! * `GET|HEAD|POST /api/cli-accounts/:cli`, `PATCH|DELETE /api/cli-accounts/:cli/:id`
//! * `GET|HEAD      /api/{claude,codex}/oauth/status`, `POST /api/{claude,codex}/oauth/login`
//! * `GET|HEAD      /api/commandcode/auth/status`, `POST /api/commandcode/auth/login`
//!
//! Path matching, `:id`/`:cli` decoding and the automatic `OPTIONS` answer live
//! here and in `multicc_core::account_routes`. The handlers themselves are the
//! part Rust cannot see: they read the keychain and `~/.codex/auth.json` /
//! `~/.claude` credential files, drive the PKCE login state machines, spawn the
//! interactive login terminals, sync a desktop API key into a CLI config, and
//! project the account store to credential-free DTOs. Node keeps exactly those
//! facts behind one host port, `POST /api/__host/account-routes`
//! (`src/routes/account-routes-host.js`), which answers `{ status, body }` —
//! the status and JSON body the retired Express handler produced — so the public
//! contract stays byte-identical and masking stays single-sourced in Node.
//!
//! Two routes deliberately stay in Node: `POST /api/zcode/auth/login` and
//! `POST /api/kimi/auth/login` block for up to five minutes on a child process,
//! which the 60 s host-port ceiling cannot carry. They are re-mounted publicly
//! as a login-only subset; the front door forwards them.
//!
//! Every mutating handler is serialized behind [`App::account_write`] so the
//! single-threaded Node event-loop semantics survive.

// Express refusals are values here (`Err(Response)`), so the error variant is a
// full response body; the same shape is allowed elsewhere in the workspace.
#![allow(clippy::result_large_err)]

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Method, Response};
pub use multicc_core::account_routes::Route;
use multicc_core::account_routes::{self, segments};
use multicc_core::http_gate::error_dto;
use serde_json::{json, Map, Value};

use crate::app::express::{self, RequestCtx};
use crate::app::App;
use crate::host_port;

/// The host port the Node child serves (`src/routes/account-routes-host.js`).
const HOST_PATH: &str = "/api/__host/account-routes";

pub fn claim(method: &Method, path: &str) -> Option<Route> {
    account_routes::claim(method.as_str(), path)
}

/// This cluster's own share of Express's automatic `OPTIONS` `Allow` for the
/// front-door union (`super::OPTIONS_SOURCES`).
pub fn options_share(path: &str) -> Option<String> {
    account_routes::options_share(path)
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
            "error": "账号管理接口尚未就绪，请更新原生模块",
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
    express::error(ctx, 500, "account route failed")
}

/// One host round trip carrying the op, the decoded parameters and the body the
/// retired handler read (`{}` when body-parser produced no body, `null` for a
/// JSON `null`, exactly as Express left `req.body`). The host answers
/// `{ ok: true, value }`; `value` is the `{ status, body }` (or `{ threw, … }`)
/// the retired handler produced.
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

/// Relay the `{ status, body }` the retired handler produced. A handler that
/// threw out of its own `try` (the old `safeErrorHandler` path) carries
/// `threw:true` plus the DTO fields; the front door builds the same envelope
/// with its own request ids, never leaking the thrown message.
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
        Some(app.account_write.lock().await)
    } else {
        None
    };
    answer(ctx, route, body, host).await
}

async fn answer(ctx: &RequestCtx, route: Route, body: &Value, host: u16) -> Response<Body> {
    if route == Route::Options {
        let allow = account_routes::allow_for(&ctx.path).unwrap_or_default();
        return super::options(ctx, &allow);
    }
    let parts = segments(&ctx.path).unwrap_or_default();

    let Some(op) = route.op() else {
        return express::error(ctx, 500, "native route has no host op");
    };

    let mut payload = Map::new();
    payload.insert("op".into(), Value::String(op.to_string()));
    payload.insert(
        "method".into(),
        Value::String(ctx.method.as_str().to_string()),
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
    // `body` is what `express::json_body` parsed: `{}` when body-parser would
    // have left `req.body` empty, `Value::Null` for a JSON `null`. The host sets
    // `req.body = payload.body`, so the retired handler sees the same value —
    // including the `req.body.providerId` TypeError that a JSON `null` causes.
    payload.insert("body".into(), body.clone());

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
            claim(&Method::GET, "/api/claude/accounts"),
            Some(Route::ClaudeAccountsGet)
        );
        assert_eq!(
            claim(&Method::DELETE, "/api/codex/accounts/c1"),
            Some(Route::CodexAccountDelete)
        );
        assert_eq!(
            claim(&Method::PUT, "/api/kimi/auth"),
            Some(Route::KimiAuthPut)
        );
        assert_eq!(claim(&Method::POST, "/api/zcode/auth/login"), None);
        assert_eq!(claim(&Method::GET, "/api/claude/models"), None);
    }

    #[test]
    fn options_share_matches_the_kernel() {
        assert_eq!(
            options_share("/api/claude/accounts").as_deref(),
            Some("GET,HEAD,POST")
        );
        assert_eq!(
            options_share("/api/cli-accounts/claude/k1").as_deref(),
            Some("PATCH,DELETE")
        );
        assert_eq!(options_share("/api/claude/models"), None);
    }

    #[test]
    fn forwarded_login_paths_have_no_options_share() {
        assert_eq!(options_share("/api/zcode/auth/login"), None);
        assert_eq!(options_share("/api/kimi/auth/login"), None);
    }
}
