//! Agent resource routes retired from Node (`src/routes/agent-resources.js`):
//!
//! * `GET/HEAD /api/agent-resources/skills`
//! * `GET/HEAD /api/agent-presets`
//! * `GET/HEAD /api/agent-presets/:id`
//! * `GET/HEAD /api/agent-resources/claude-sessions`
//! * `DELETE /api/agent-resources/claude-sessions/:project/:id`
//! * `DELETE /api/agent-resources/claude-sessions`
//!
//! Path matching (including the two decoded parameters), query parsing, status
//! codes, response field order and error mapping live here. What stays in Node
//! is exactly the state Rust cannot see: the installed-skill scan, the preset
//! file (plus its provider enrichment) and the Claude history store on disk.
//! Those are reached through one host port, [`crate::host_port`], served by
//! `src/routes/agent-resources-host.js`.
//!
//! Node answered each request to completion on the event loop; the purge loop
//! called a synchronous remove per session, so two concurrent purges could not
//! interleave. That loop now awaits the host port once per session; the host
//! side owns the serialization it needs.

use axum::body::Body;
use axum::http::{Method, Response};
use serde_json::{json, Map, Value};

use crate::app::express::{self, RequestCtx};
use crate::app::Route;
use crate::host_port;

/// The host port the Node child serves (`src/routes/agent-resources-host.js`).
const HOST_PATH: &str = "/api/__host/agent-resources";

/// `/api/agent-resources/skills`.
const SKILLS: &str = "agent-resources/skills";
/// `/api/agent-presets`.
const PRESETS: &str = "agent-presets";
/// `/api/agent-resources/claude-sessions`.
const CLAUDE_SESSIONS: &str = "agent-resources/claude-sessions";

/// `decodeURIComponent`, falling back to the literal text on a malformed
/// escape (the same convention as `model_catalogs`; no client of these routes
/// sends one).
fn decode(raw: &str) -> String {
    super::download::decode_uri_component(raw).unwrap_or_else(|| raw.to_string())
}

/// The `:id` of `/api/agent-presets/:id`, keeping its case. `rest` is the path
/// after `/api/` with one optional trailing slash removed.
fn preset_id(rest: &str) -> Option<String> {
    const HEAD: &str = "agent-presets/";
    if rest.len() <= HEAD.len() {
        return None;
    }
    if !rest.as_bytes()[..HEAD.len()].eq_ignore_ascii_case(HEAD.as_bytes()) {
        return None;
    }
    let raw = &rest[HEAD.len()..];
    if raw.contains('/') {
        return None;
    }
    Some(decode(raw))
}

/// The decoded `:id` of `/api/agent-presets/:id` for a raw request path.
pub fn preset_id_from_path(path: &str) -> Option<String> {
    let rest = path.strip_prefix("/api/")?;
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    preset_id(rest)
}

/// The decoded `:project` and `:id` of
/// `/api/agent-resources/claude-sessions/:project/:id`, each exactly one
/// non-empty segment.
fn session_delete_params(rest: &str) -> Option<(String, String)> {
    const HEAD: &str = "agent-resources/claude-sessions/";
    if rest.len() <= HEAD.len() {
        return None;
    }
    if !rest.as_bytes()[..HEAD.len()].eq_ignore_ascii_case(HEAD.as_bytes()) {
        return None;
    }
    let mut segments = rest[HEAD.len()..].split('/');
    let project = segments.next()?;
    let id = segments.next()?;
    if segments.next().is_some() || project.is_empty() || id.is_empty() {
        return None;
    }
    Some((decode(project), decode(id)))
}

/// The decoded `:project`/`:id` of the one-session delete route for a raw
/// request path.
pub fn session_delete_params_from_path(path: &str) -> Option<(String, String)> {
    let rest = path.strip_prefix("/api/")?;
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    session_delete_params(rest)
}

pub fn claim(method: &Method, path: &str) -> Option<Route> {
    let rest = path.strip_prefix("/api/")?;
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    if preset_id(rest).is_some() {
        return match method.as_str() {
            "GET" | "HEAD" => Some(Route::AgentPreset),
            "OPTIONS" => Some(Route::AgentResourcesOptionsGet),
            _ => None,
        };
    }
    if session_delete_params(rest).is_some() {
        return match method.as_str() {
            "DELETE" => Some(Route::AgentClaudeSessionDelete),
            "OPTIONS" => Some(Route::AgentResourcesOptionsDelete),
            _ => None,
        };
    }
    if rest.eq_ignore_ascii_case(SKILLS) {
        return match method.as_str() {
            "GET" | "HEAD" => Some(Route::AgentResourcesSkills),
            "OPTIONS" => Some(Route::AgentResourcesOptionsGet),
            _ => None,
        };
    }
    if rest.eq_ignore_ascii_case(PRESETS) {
        return match method.as_str() {
            "GET" | "HEAD" => Some(Route::AgentPresets),
            "OPTIONS" => Some(Route::AgentResourcesOptionsGet),
            _ => None,
        };
    }
    if rest.eq_ignore_ascii_case(CLAUDE_SESSIONS) {
        return match method.as_str() {
            "GET" | "HEAD" => Some(Route::AgentClaudeSessions),
            "DELETE" => Some(Route::AgentClaudeSessionsPurge),
            // Express collects every method registered on this path, in
            // registration order: the GET route contributes GET,HEAD and the
            // DELETE route then appends DELETE.
            "OPTIONS" => Some(Route::AgentResourcesOptionsShared),
            _ => None,
        };
    }
    None
}

fn unavailable(ctx: &RequestCtx) -> Response<Body> {
    express::json(
        ctx,
        503,
        &json!({
            "error": "agent resources interface is not ready",
            "code": "rust_backend_unavailable",
        }),
        &[],
    )
}

fn presets_unavailable(ctx: &RequestCtx) -> Response<Body> {
    express::json(
        ctx,
        500,
        &json!({ "error": "agent presets unavailable" }),
        &[],
    )
}

fn not_found(ctx: &RequestCtx) -> Response<Body> {
    express::json(ctx, 404, &json!({ "error": "not found" }), &[])
}

async fn host(host_port_num: u16, payload: Value) -> Option<Value> {
    host_port::call(host_port_num, HOST_PATH, &payload)
        .await
        .ok()
}

fn host_ok(answer: &Value) -> bool {
    answer.get("ok") == Some(&Value::Bool(true))
}

/// `GET|HEAD /api/agent-resources/skills`.
pub async fn skills(ctx: &RequestCtx, host_port_num: u16) -> Response<Body> {
    let Some(answer) = host(host_port_num, json!({ "op": "skills" })).await else {
        return unavailable(ctx);
    };
    if !host_ok(&answer) {
        return unavailable(ctx);
    }
    let skills = answer
        .get("skills")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    let mut claude = 0usize;
    let mut codex = 0usize;
    if let Some(items) = skills.as_array() {
        for item in items {
            // `skill.provider === 'claude'` / `=== 'codex'`: strict, case-sensitive.
            match item.get("provider").and_then(Value::as_str) {
                Some("claude") => claude += 1,
                Some("codex") => codex += 1,
                _ => {}
            }
        }
    }
    express::json(
        ctx,
        200,
        &json!({
            "skills": skills,
            "counts": { "claude": claude, "codex": codex },
        }),
        &[],
    )
}

/// `GET|HEAD /api/agent-presets`.
pub async fn presets(ctx: &RequestCtx, host_port_num: u16) -> Response<Body> {
    let Some(answer) = host(host_port_num, json!({ "op": "presets" })).await else {
        return unavailable(ctx);
    };
    if !host_ok(&answer) {
        return presets_unavailable(ctx);
    }
    // `{ source, version, generatedAt, categories, featured, presets }` in
    // that order; `JSON.stringify` drops the keys the host left undefined.
    let mut body = Map::new();
    for key in ["source", "version", "generatedAt"] {
        if let Some(value) = answer.get(key) {
            body.insert(key.to_string(), value.clone());
        }
    }
    let categories = answer
        .get("categories")
        .filter(|value| multicc_core::js::serde::truthy(value))
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    body.insert("categories".to_string(), categories);
    let featured = answer
        .get("featured")
        .filter(|value| multicc_core::js::serde::truthy(value))
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    body.insert("featured".to_string(), featured);
    let presets = match answer.get("presets") {
        Some(value @ Value::Array(_)) => value.clone(),
        _ => Value::Array(Vec::new()),
    };
    body.insert("presets".to_string(), presets);
    express::json(ctx, 200, &Value::Object(body), &[])
}

/// `GET|HEAD /api/agent-presets/:id`.
pub async fn preset(ctx: &RequestCtx, host_port_num: u16) -> Response<Body> {
    let Some(id) = preset_id_from_path(&ctx.path) else {
        return not_found(ctx);
    };
    let Some(answer) = host(host_port_num, json!({ "op": "preset", "id": id })).await else {
        return unavailable(ctx);
    };
    if !host_ok(&answer) {
        return presets_unavailable(ctx);
    }
    if answer.get("found") != Some(&Value::Bool(true)) {
        return not_found(ctx);
    }
    let preset = answer.get("preset").cloned().unwrap_or(Value::Null);
    express::json(ctx, 200, &preset, &[])
}

/// `GET|HEAD /api/agent-resources/claude-sessions`.
pub async fn claude_sessions(ctx: &RequestCtx, host_port_num: u16) -> Response<Body> {
    let Some(answer) = host(host_port_num, json!({ "op": "claude-sessions" })).await else {
        return unavailable(ctx);
    };
    if !host_ok(&answer) {
        return unavailable(ctx);
    }
    let sessions = match answer.get("sessions") {
        Some(value @ Value::Array(_)) => value.clone(),
        _ => Value::Array(Vec::new()),
    };
    let items = sessions.as_array().map(Vec::as_slice).unwrap_or(&[]);
    // `sessions.reduce((sum, s) => sum + s.size, 0)`: a missing or non-numeric
    // size poisons the sum to NaN, which `JSON.stringify` emits as `null`.
    let mut total_size = 0.0f64;
    for session in items {
        total_size += session
            .get("size")
            .and_then(Value::as_f64)
            .unwrap_or(f64::NAN);
    }
    let protected_count = items
        .iter()
        .filter(|session| {
            multicc_core::js::serde::truthy(session.get("linked").unwrap_or(&Value::Null))
        })
        .count();
    express::json(
        ctx,
        200,
        &json!({
            "sessions": sessions,
            "count": items.len(),
            "totalSize": multicc_core::js::serde::number_value(total_size),
            "protectedCount": protected_count,
        }),
        &[],
    )
}

/// `DELETE /api/agent-resources/claude-sessions/:project/:id`.
pub async fn delete_session(ctx: &RequestCtx, host_port_num: u16) -> Response<Body> {
    let Some((project, id)) = session_delete_params_from_path(&ctx.path) else {
        return not_found(ctx);
    };
    let answer = host(
        host_port_num,
        json!({ "op": "claude-session-delete", "project": project, "id": id }),
    )
    .await;
    let Some(answer) = answer else {
        return unavailable(ctx);
    };
    if host_ok(&answer) {
        let mut body = Map::new();
        body.insert("ok".to_string(), Value::Bool(true));
        if let Some(freed) = answer.get("freed") {
            body.insert("freed".to_string(), freed.clone());
        }
        return express::json(ctx, 200, &Value::Object(body), &[]);
    }
    // The retired handler only mapped a *string* error: anything else (a throw,
    // or a non-string error, on which `.includes` would have thrown too) became
    // the generic 500.
    if answer.get("threw") == Some(&Value::Bool(true)) {
        return express::json(ctx, 500, &json!({ "error": "history delete failed" }), &[]);
    }
    match answer.get("error") {
        Some(Value::String(text)) => {
            let status = if text.contains("protected") { 409 } else { 404 };
            express::json(ctx, status, &json!({ "error": text }), &[])
        }
        _ => express::json(ctx, 500, &json!({ "error": "history delete failed" }), &[]),
    }
}

/// `DELETE /api/agent-resources/claude-sessions?olderThanDays=N`.
pub async fn purge_sessions(ctx: &RequestCtx, host_port_num: u16) -> Response<Body> {
    // `Number(String(req.query.olderThanDays || ''))`.
    let raw = multicc_core::http_gate::query_string(&multicc_core::http_gate::query_value(
        &ctx.original_url,
        "olderThanDays",
    ));
    let older_than_days = multicc_core::js::serde::js_string_to_number(&raw);
    if !older_than_days.is_finite() || older_than_days < 1.0 {
        return express::json(
            ctx,
            400,
            &json!({ "error": "olderThanDays must be at least 1" }),
            &[],
        );
    }
    let now = super::now_ms() as f64;
    let cutoff = now - older_than_days * 86_400.0 * 1000.0;

    let Some(answer) = host(host_port_num, json!({ "op": "claude-sessions" })).await else {
        return unavailable(ctx);
    };
    if !host_ok(&answer) {
        return unavailable(ctx);
    }
    let sessions = match answer.get("sessions") {
        Some(value @ Value::Array(_)) => value.clone(),
        _ => Value::Array(Vec::new()),
    };

    let mut deleted = 0usize;
    let mut freed = 0.0f64;
    for session in sessions.as_array().map(Vec::as_slice).unwrap_or(&[]) {
        if multicc_core::js::serde::truthy(session.get("linked").unwrap_or(&Value::Null)) {
            continue;
        }
        let updated_ms = session
            .get("updatedAt")
            .and_then(Value::as_str)
            .and_then(date_ms)
            .unwrap_or(f64::NAN);
        if !updated_ms.is_finite() || updated_ms >= cutoff {
            continue;
        }
        // A non-string field is `undefined` on the retired handler's call; the
        // host's remove then saw `undefined`. Keep the call, with an empty
        // string, so the delete still happens exactly once.
        let project = session.get("project").and_then(Value::as_str).unwrap_or("");
        let id = session.get("id").and_then(Value::as_str).unwrap_or("");
        let outcome = host(
            host_port_num,
            json!({ "op": "claude-session-delete", "project": project, "id": id }),
        )
        .await;
        // A per-session failure (or an unreachable host mid-loop) is ignored,
        // exactly like the retired `try { ... } catch (_) {}`.
        if let Some(result) = outcome {
            if host_ok(&result) {
                deleted += 1;
                freed += result
                    .get("freed")
                    .and_then(Value::as_f64)
                    .unwrap_or(f64::NAN);
            }
        }
    }
    express::json(
        ctx,
        200,
        &json!({
            "ok": true,
            "deleted": deleted,
            "freed": multicc_core::js::serde::number_value(freed),
        }),
        &[],
    )
}

/// `new Date(text).getTime()` for the values `Date#toISOString` produces
/// (`2006-01-02T15:04:05.000Z`, parsed as RFC 3339). The other formats
/// `Date.parse` accepts (locale strings, bare dates, numeric offsets without a
/// colon) are not reproduced: every writer of `updatedAt` here uses
/// `toISOString`. Anything unparsable is `NaN`, which skips the session.
fn date_ms(text: &str) -> Option<f64> {
    chrono::DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|date| date.timestamp_millis() as f64)
}
