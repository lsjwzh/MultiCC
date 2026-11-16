//! `POST /api/sessions/:id/switch-cli`, retired from
//! `src/cli/switch-runtime.js`.
//!
//! The switching policy, its DTOs and the four entry refusals already live in
//! `multicc_core::cli_switch_runtime` (pure functions). So the front door
//! evaluates `manualGate` itself: a missing session, a system (`aux`/`gateway`)
//! session, a non-chat session and an unsupported CLI never reach Node.
//!
//! Everything that must stay in one process — the live session object identity,
//! the `preparations` Map, the signature/TOCTOU comparison across awaits,
//! child-process teardown, persistence transactions and broadcasts — stays in
//! Node behind one host port, `POST /api/__host/cli-switch`
//! (src/routes/cli-switch-host.js), whose `switch` op carries the whole
//! post-gate body of the retired handler.
//!
//! Ordering matches the retired Express stack exactly: the auth gate, then
//! `publicSessionAccessGuard` (`app.use('/api/sessions/:id')`) — before
//! `express.json` and before the automatic OPTIONS answer — and only then body
//! parsing and the handler.

// Express refusals are values here (`Err(Response)`), so the error variant is a
// full response body; the same shape is allowed in `native/addon` and
// `native/cdpd` rather than boxing every refusal at every call site.
#![allow(clippy::result_large_err)]

use axum::body::Body;
use axum::http::{Method, Response};
use multicc_core::cli_switch_runtime;
use multicc_core::http_gate;
use serde_json::{json, Value};

use crate::app::express::{self, RequestCtx};
use crate::host_port;

/// The host port the Node child serves (`src/routes/cli-switch-host.js`).
const HOST_PATH: &str = "/api/__host/cli-switch";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Route {
    /// `POST /api/sessions/:id/switch-cli`
    Post,
    /// Express's automatic OPTIONS for the one registered method.
    Options,
}

/// Segment view of `/api/<rest>`, one optional trailing slash removed. Express
/// matches literal segments case-insensitively and parameters as `[^/]+?`.
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

fn literal(part: &str, name: &str) -> bool {
    part.eq_ignore_ascii_case(name)
}

pub fn claim(method: &Method, path: &str) -> Option<Route> {
    let parts = segments(path)?;
    if parts.len() != 3 || !literal(parts[0], "sessions") || !literal(parts[2], "switch-cli") {
        return None;
    }
    match method.as_str() {
        "POST" => Some(Route::Post),
        "OPTIONS" => Some(Route::Options),
        // Other verbs were never registered; Express passed them on.
        _ => None,
    }
}

/// `decodeURIComponent` for the `:id` parameter; `None` is Express's 400.
fn decoded(ctx: &RequestCtx, raw: &str) -> Result<String, Response<Body>> {
    super::download::decode_uri_component(raw)
        .ok_or_else(|| express::error(ctx, 400, "Failed to decode param"))
}

fn unavailable(ctx: &RequestCtx) -> Response<Body> {
    express::json(
        ctx,
        503,
        &json!({
            "error": "CLI 切换接口尚未就绪，请更新原生模块",
            "code": "rust_backend_unavailable",
        }),
        &[],
    )
}

fn error_json(ctx: &RequestCtx, status: u16, message: &str) -> Response<Body> {
    express::json(ctx, status, &json!({ "error": message }), &[])
}

/// The guard round trip. Anything other than a well-formed answer is the
/// route's 503: the Node child that owns the records is the only process that
/// could have answered.
async fn facts(ctx: &RequestCtx, host: u16, id: &str) -> Result<Value, Response<Body>> {
    let answer = host_port::call(host, HOST_PATH, &json!({ "op": "facts", "sessionId": id }))
        .await
        .map_err(|_| unavailable(ctx))?;
    let well_formed = answer.get("ok") == Some(&Value::Bool(true))
        && answer.get("exists").is_some_and(Value::is_boolean)
        && answer.get("internalSlot").is_some_and(Value::is_boolean)
        && answer
            .get("session")
            .is_some_and(|session| session.is_null() || session.is_object())
        && answer.get("supported").is_some_and(Value::is_array);
    if !well_formed {
        return Err(unavailable(ctx));
    }
    Ok(answer)
}

/// One side-effect host round trip, validated to `{ ok: true, status?, body }`
/// or `{ ok: false, error: { message } }`.
async fn side_effect(ctx: &RequestCtx, host: u16, payload: Value) -> Result<Value, Response<Body>> {
    host_port::call(host, HOST_PATH, &payload)
        .await
        .map_err(|_| unavailable(ctx))
}

/// `{ status, body }` from a host answer; `None` when the shape is unusable.
fn status_and_body(answer: &Value) -> Option<(u16, Value)> {
    if answer.get("ok") != Some(&Value::Bool(true)) {
        return None;
    }
    let status = answer.get("status")?.as_u64()?;
    let body = answer.get("body")?;
    Some((u16::try_from(status).ok()?, body.clone()))
}

pub async fn handle(route: Route, ctx: &RequestCtx, body: Body, host: u16) -> Response<Body> {
    let parts = segments(&ctx.path).unwrap_or_default();
    let raw = parts.get(1).copied().unwrap_or("");
    let id = match decoded(ctx, raw) {
        Ok(id) => id,
        Err(response) => return response,
    };

    // `publicSessionAccessGuard`: an internal execution slot is invisible for
    // every method, before the body is parsed and before OPTIONS.
    let guarded = match facts(ctx, host, &id).await {
        Ok(answer) => answer,
        Err(response) => return response,
    };
    if guarded.get("internalSlot") == Some(&Value::Bool(true)) {
        return error_json(ctx, 404, "session not found");
    }

    if route == Route::Options {
        return super::options(ctx, "POST");
    }

    // `express.json({ limit: '50mb' })`, exactly as the global middleware would
    // have parsed it (no body → `{}`).
    let body = match express::json_body(ctx, body, express::JSON_LIMIT).await {
        Ok(value) => value,
        Err(error) => return express::error(ctx, error.status, error.reason),
    };

    // The four entry refusals are pure policy: no Node round trip.
    let gate = match cli_switch_runtime::plan(
        "manualGate",
        &json!({
            "exists": guarded["exists"],
            "session": guarded["session"],
            "body": body,
            "supported": guarded["supported"],
        }),
    ) {
        Ok(gate) => gate,
        Err(_) => return unavailable(ctx),
    };
    match gate.get("action").and_then(Value::as_str) {
        Some("respond") => {
            let status = gate
                .get("status")
                .and_then(Value::as_u64)
                .and_then(|value| u16::try_from(value).ok())
                .unwrap_or(400);
            let body = gate.get("body").cloned().unwrap_or(Value::Null);
            express::json(ctx, status, &body, &[])
        }
        Some("noop") => {
            let answer =
                match side_effect(ctx, host, json!({ "op": "noop", "sessionId": id })).await {
                    Ok(answer) => answer,
                    Err(response) => return response,
                };
            if answer.get("ok") == Some(&Value::Bool(true)) {
                match answer.get("body") {
                    Some(body) => return express::json(ctx, 200, body, &[]),
                    None => return unavailable(ctx),
                }
            }
            host_failure(ctx, &answer)
        }
        Some("switch") => {
            let target = gate.get("targetCli").cloned().unwrap_or(Value::Null);
            let fresh = gate.get("fresh").cloned().unwrap_or(Value::Bool(false));
            let answer = match side_effect(
                ctx,
                host,
                json!({ "op": "switch", "sessionId": id, "targetCli": target, "fresh": fresh }),
            )
            .await
            {
                Ok(answer) => answer,
                Err(response) => return response,
            };
            match status_and_body(&answer) {
                Some((status, body)) => express::json(ctx, status, &body, &[]),
                None => host_failure(ctx, &answer),
            }
        }
        _ => unavailable(ctx),
    }
}

/// `ok:false` is a handler that threw: replay the retired `safeErrorHandler`
/// from the host answer, whose fields `src/routes/cli-switch-host.js`
/// (`hostFailure`) fills exactly like `src/routes/host-read-host.js`. The
/// error's own `code` survives (`SESSION_PERSISTENCE_FAILED`), the message
/// does not. Anything else is a shape the host cannot have produced: the 503.
fn host_failure(ctx: &RequestCtx, answer: &Value) -> Response<Body> {
    if answer.get("ok") != Some(&Value::Bool(false)) {
        return unavailable(ctx);
    }
    let status = answer
        .get("status")
        .and_then(Value::as_u64)
        .filter(|status| (400..600).contains(status))
        .map(|status| status as u16)
        .unwrap_or(500);
    let detail = answer
        .get("detail")
        .and_then(Value::as_str)
        .or_else(|| {
            answer
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
        })
        .unwrap_or("cli switch failed");
    let safe_message = answer.get("safeMessage").and_then(Value::as_str);
    let (message, fallback_code) = if status >= 500 {
        ("internal_error", "internal_error")
    } else {
        (safe_message.unwrap_or("request_error"), "request_error")
    };
    // createErrorDto only echoes codes that look like identifiers.
    let code = answer
        .get("code")
        .and_then(Value::as_str)
        .filter(|code| {
            !code.is_empty()
                && multicc_core::js::string::utf16_len(code) <= 96
                && code
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
        })
        .unwrap_or(fallback_code);
    let body = http_gate::error_dto(code, message, &[], &ctx.ids);
    express::log_http_error(ctx, status, detail);
    express::json(ctx, status, &body, &[])
}
