//! The session-admin route cluster retired from `src/routes/session-admin.js`:
//!
//! * `GET|HEAD /api/v1/sessions`, `/api/v1/sessions/:id`,
//!   `/api/v1/directories/:id/workspace`
//! * `GET|HEAD /api/sessions`, `/api/sessions/:id`
//! * `POST     /api/sessions/:id/{reclassify,mark-task-done,mark-goal-achieved}`
//! * `POST     /api/reclassify-all`
//! * `GET|HEAD /api/directories/:id/sessions`, `/api/directories/:id/workspace`
//! * `POST     /api/debug/classify/:id`, `GET|HEAD /api/debug/classify-test-cases`
//!
//! Path matching, parameter decoding, query/body reads, the internal
//! execution-slot guard and the Express OPTIONS answer live here; the DTO /
//! presenter / workspace rules live in `multicc_core::session_admin`. Node keeps
//! what Rust cannot see behind one host port, `POST /api/__host/session-admin`
//! (src/routes/session-admin-host.js): the records Map, the terminal/chat live
//! tables, the classify state machine, chat history, workspace status, the
//! auxiliary queue, persistence and WebSocket broadcast.
//!
//! Two facts shape this cluster:
//!
//! * `mountPublicSessionAccessGuard` (src/session/public-session-access.js) is a
//!   fail-closed layer over `/api/sessions/:id` and `/api/v1/sessions/:id`. It
//!   answers internal execution slots (`taskExecutionSlot === true`) with the
//!   v1 error DTO under `/api/v1/` and `{error:'session not found'}` elsewhere,
//!   for every method — including OPTIONS. It runs before the route here,
//!   exactly like the `app.use` mount it replaces.
//! * The three `/api/v1` routes and the legacy routes answer with different
//!   envelopes: `withApiMeta` on v1, raw JSON elsewhere. OPTIONS is claimed on
//!   the shared paths because Node no longer registers the retired methods; the
//!   `Allow` value is the union Express would have computed from the whole app
//!   (session-admin GET, then session-profile PATCH, then session-lifecycle
//!   DELETE).
//!
//! Three write routes (`reclassify`, `mark-task-done`, `mark-goal-achieved`)
//! and `reclassify-all` mutate the classify state machine through the host
//! port, so [`App::session_admin_write`] serializes them like the single
//! event-loop thread did.

// Express refusals are values here (`Err(Response)`), so the error variant is a
// full response body; the same shape is allowed in `native/addon` and
// `native/cdpd` rather than boxing every refusal at every call site.
#![allow(clippy::result_large_err)]

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Method, Response};
use multicc_core::http_gate::{error_dto, query_string, query_value};
use multicc_core::js::serde::truthy;
use multicc_core::js::string::utf16_len;
use multicc_core::session_admin as rules;
use serde_json::{json, Map, Value};

use crate::app::express::{self, RequestCtx};
use crate::app::App;
use crate::host_port;

/// The host port the Node child serves (`src/routes/session-admin-host.js`).
const HOST_PATH: &str = "/api/__host/session-admin";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Route {
    V1SessionsGet,
    V1SessionGet,
    V1WorkspaceGet,
    SessionsGet,
    SessionGet,
    ReclassifyPost,
    MarkTaskDonePost,
    MarkGoalAchievedPost,
    ReclassifyAllPost,
    DirectorySessionsGet,
    DirectoryWorkspaceGet,
    DebugClassifyPost,
    DebugClassifyCasesGet,
    /// Express's automatic OPTIONS for the path, with the union the whole app
    /// registered there (each `GET` followed by `HEAD`), in registration order.
    /// `guard_segment` names the `:id` segment when the retired path sat under
    /// the `publicSessionAccessGuard` `app.use` mount: `app.use` middleware runs
    /// before the automatic Allow responder, so the guard can still 404 the
    /// preflight.
    Options {
        allow: &'static str,
        guard_segment: Option<usize>,
    },
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

/// Express matches literal segments case-insensitively.
fn lit(part: &str, name: &str) -> bool {
    part.eq_ignore_ascii_case(name)
}

/// This cluster's own share of Express's automatic `OPTIONS` `Allow` for
/// `path`, plus the `publicSessionAccessGuard` `:id` segment when the path sits
/// under one of its `app.use` mounts.
///
/// The front door folds this share together with the other clusters that
/// registered routes on the same path (`super::OPTIONS_SOURCES`): Express
/// unions every matching layer, so `/api/sessions/:id` is `GET,HEAD` here plus
/// session-routes' `PATCH,DELETE`, and `/api/directories/:id/sessions` is
/// `GET,HEAD` here plus session-create's `POST`.
pub fn options_share(path: &str) -> Option<(&'static str, Option<usize>)> {
    let parts = segments(path)?;
    match parts.len() {
        1 if lit(parts[0], "sessions") => Some(("GET,HEAD", None)),
        1 if lit(parts[0], "reclassify-all") => Some(("POST", None)),
        2 if lit(parts[0], "v1") && lit(parts[1], "sessions") => Some(("GET,HEAD", None)),
        // `app.use('/api/sessions/:id', guard)` also guards the preflight.
        2 if lit(parts[0], "sessions") => Some(("GET,HEAD", Some(1))),
        2 if lit(parts[0], "debug") && lit(parts[1], "classify-test-cases") => {
            Some(("GET,HEAD", None))
        }
        3 if lit(parts[0], "v1") && lit(parts[1], "sessions") => Some(("GET,HEAD", Some(2))),
        3 if lit(parts[0], "sessions")
            && (lit(parts[2], "reclassify")
                || lit(parts[2], "mark-task-done")
                || lit(parts[2], "mark-goal-achieved")) =>
        {
            Some(("POST", Some(1)))
        }
        3 if lit(parts[0], "directories") && lit(parts[2], "sessions") => Some(("GET,HEAD", None)),
        3 if lit(parts[0], "directories") && lit(parts[2], "workspace") => Some(("GET,HEAD", None)),
        3 if lit(parts[0], "debug") && lit(parts[1], "classify") => Some(("POST", None)),
        4 if lit(parts[0], "v1") && lit(parts[1], "directories") && lit(parts[3], "workspace") => {
            Some(("GET,HEAD", None))
        }
        _ => None,
    }
}

pub fn claim(method: &Method, path: &str) -> Option<Route> {
    let parts = segments(path)?;
    if method.as_str() == "OPTIONS" {
        return options_share(path).map(|(allow, guard_segment)| Route::Options {
            allow,
            guard_segment,
        });
    }
    let get_like = matches!(method.as_str(), "GET" | "HEAD");
    let post = method.as_str() == "POST";
    match parts.len() {
        1 if lit(parts[0], "sessions") => get_like.then_some(Route::SessionsGet),
        1 if lit(parts[0], "reclassify-all") => post.then_some(Route::ReclassifyAllPost),
        2 if lit(parts[0], "v1") && lit(parts[1], "sessions") => {
            get_like.then_some(Route::V1SessionsGet)
        }
        2 if lit(parts[0], "sessions") => get_like.then_some(Route::SessionGet),
        2 if lit(parts[0], "debug") && lit(parts[1], "classify-test-cases") => {
            get_like.then_some(Route::DebugClassifyCasesGet)
        }
        3 if lit(parts[0], "v1") && lit(parts[1], "sessions") => {
            get_like.then_some(Route::V1SessionGet)
        }
        3 if lit(parts[0], "sessions")
            && (lit(parts[2], "reclassify")
                || lit(parts[2], "mark-task-done")
                || lit(parts[2], "mark-goal-achieved")) =>
        {
            if !post {
                return None;
            }
            Some(if lit(parts[2], "reclassify") {
                Route::ReclassifyPost
            } else if lit(parts[2], "mark-task-done") {
                Route::MarkTaskDonePost
            } else {
                Route::MarkGoalAchievedPost
            })
        }
        3 if lit(parts[0], "directories") && lit(parts[2], "sessions") => {
            get_like.then_some(Route::DirectorySessionsGet)
        }
        3 if lit(parts[0], "directories") && lit(parts[2], "workspace") => {
            get_like.then_some(Route::DirectoryWorkspaceGet)
        }
        3 if lit(parts[0], "debug") && lit(parts[1], "classify") => {
            post.then_some(Route::DebugClassifyPost)
        }
        4 if lit(parts[0], "v1") && lit(parts[1], "directories") && lit(parts[3], "workspace") => {
            get_like.then_some(Route::V1WorkspaceGet)
        }
        _ => None,
    }
}

fn part<'a>(parts: &[&'a str], index: usize) -> &'a str {
    parts.get(index).copied().unwrap_or("")
}

/// `decodeURIComponent` for one parameter; `None` is Express's 400.
fn decoded(ctx: &RequestCtx, raw: &str) -> Result<String, Response<Body>> {
    super::download::decode_uri_component(raw)
        .ok_or_else(|| express::error(ctx, 400, "Failed to decode param"))
}

pub(crate) fn unavailable(ctx: &RequestCtx) -> Response<Body> {
    express::json(
        ctx,
        503,
        &json!({
            "error": "会话管理接口尚未就绪，请更新原生模块",
            "code": "rust_backend_unavailable",
        }),
        &[],
    )
}

/// One host round trip. A transport/parse failure is the route's 503: the Node
/// child that owns the records is the only process that could have answered.
async fn call(ctx: &RequestCtx, host: u16, payload: Value) -> Result<Value, Response<Body>> {
    host_port::call(host, HOST_PATH, &payload)
        .await
        .map_err(|_| unavailable(ctx))
}

fn payload(op: &str, fields: Vec<(&str, Value)>) -> Value {
    let mut object = Map::new();
    object.insert("op".into(), Value::String(op.to_string()));
    for (key, value) in fields {
        object.insert(key.to_string(), value);
    }
    Value::Object(object)
}

fn member(value: &Value, key: &str) -> Value {
    value.get(key).cloned().unwrap_or(Value::Null)
}

/// `String(req.query.force).toLowerCase() === 'true'`.
fn force_flag(ctx: &RequestCtx) -> bool {
    query_string(&query_value(&ctx.original_url, "force")).to_lowercase() == "true"
}

// ── sessionQuery.context (`includeHidden` / `includeTaskBound`) ────────────

pub(crate) fn context_visible(
    record: &Value,
    include_hidden: bool,
    include_task_bound: bool,
) -> bool {
    if !record.is_object() {
        return false;
    }
    if matches!(record.get("taskExecutionSlot"), Some(Value::Bool(true))) {
        return false;
    }
    if let Some(Value::String(text)) = record.get("taskBoundTaskId") {
        if !text.is_empty() && !include_task_bound {
            return false;
        }
    }
    if !include_hidden {
        if let Some(Value::String(kind)) = record.get("type") {
            if kind == "aux" || kind == "gateway" {
                return false;
            }
        }
    }
    true
}

/// `record.dirId === dirId` (JS strict equality).
fn same_dir(record: &Value, dir_id: &Value) -> bool {
    match (record.get("dirId"), dir_id) {
        (None, _) => false,
        (Some(left), right) => match (left, right) {
            (Value::Null, Value::Null) => true,
            (Value::Bool(a), Value::Bool(b)) => a == b,
            (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
            (Value::String(a), Value::String(b)) => a == b,
            _ => false,
        },
    }
}

/// `[key, record]` in `Map` insertion order, the host's `records` answer.
fn record_pairs(records: &Value) -> Vec<(Value, Value)> {
    records
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .filter_map(|pair| {
            let items = pair.as_array()?;
            let key = items.first().cloned()?;
            Some((key, items.get(1).cloned()?))
        })
        .collect()
}

/// The `{id, record}` items a runtime batch needs: `runtime.read(record.id, …)`.
fn runtime_items(pairs: &[(Value, Value)]) -> Value {
    Value::Array(
        pairs
            .iter()
            .map(|(_, record)| json!({ "id": member(record, "id"), "record": record }))
            .collect(),
    )
}

/// Index into a host array answer: a missing index reads as an empty object.
fn at(facts: &Value, index: usize) -> Value {
    match facts.as_array().and_then(|items| items.get(index)) {
        Some(value) => value.clone(),
        None => Value::Object(Map::new()),
    }
}

/// An `invalid` member that is not an object reads as "no invalid entry".
fn invalid_of(facts: &Value) -> Option<Value> {
    match facts.get("invalid") {
        Some(value) if !value.is_null() => Some(value.clone()),
        _ => None,
    }
}

// ── the internal execution-slot guard ─────────────────────────────────────

pub(crate) struct Guarded {
    pub record: Value,
    pub internal: bool,
    pub task_state_writable: bool,
}

/// `publicSessionAccessGuard` before any business logic — and before OPTIONS,
/// exactly like the `app.use` mount it replaces. The host logs the denial.
async fn guard(ctx: &RequestCtx, host: u16, id: &str) -> Result<Guarded, Response<Body>> {
    guard_facts(host, id, ctx.method.as_str())
        .await
        .map_err(|_| unavailable(ctx))
}

/// The guard round trip with the 503 left to the caller, so a cluster that
/// mounts the same `app.use` layer (the trigger routes) reports its own
/// `rust_backend_unavailable` message.
pub(crate) async fn guard_facts(host: u16, id: &str, method: &str) -> Result<Guarded, ()> {
    let answer = host_port::call(
        host,
        HOST_PATH,
        &payload(
            "guard-record",
            vec![("id", json!(id)), ("method", json!(method))],
        ),
    )
    .await
    .map_err(|_| ())?;
    Ok(Guarded {
        record: member(&answer, "record"),
        internal: matches!(answer.get("internal"), Some(Value::Bool(true))),
        task_state_writable: matches!(answer.get("taskStateWritable"), Some(Value::Bool(true))),
    })
}

/// The two 404 shapes: the v1 error DTO under `/api/v1/`, the bare shape
/// everywhere else.
pub(crate) fn guarded_404(ctx: &RequestCtx, v1: bool) -> Response<Body> {
    if v1 {
        v1_error(ctx, 404, "session not found", "session_not_found")
    } else {
        error_json(ctx, 404, "session not found")
    }
}

fn v1_error(ctx: &RequestCtx, status: u16, message: &str, code: &str) -> Response<Body> {
    express::json(ctx, status, &error_dto(code, message, &[], &ctx.ids), &[])
}

fn error_json(ctx: &RequestCtx, status: u16, message: &str) -> Response<Body> {
    express::json(ctx, status, &json!({ "error": message }), &[])
}

fn ok(ctx: &RequestCtx, value: Value) -> Response<Body> {
    express::json(ctx, 200, &value, &[])
}

fn is_system_record(record: &Value) -> bool {
    matches!(
        record.get("type"),
        Some(Value::String(kind)) if kind == "aux" || kind == "gateway"
    )
}

pub async fn handle(
    app: &Arc<App>,
    route: Route,
    ctx: &RequestCtx,
    body: &Value,
    host: u16,
) -> Response<Body> {
    if matches!(route, Route::SessionsGet) && !app.node_enabled {
        return match crate::ws_chat_native::session_list::list(app).await {
            Ok(rows) => ok(ctx, rows),
            Err(_) => express::error(ctx, 500, "session list unavailable"),
        };
    }
    let write = matches!(ctx.method.as_str(), "POST" | "DELETE" | "PUT" | "PATCH");
    let _serialized = if write {
        Some(app.session_admin_write.lock().await)
    } else {
        None
    };
    answer(ctx, route, body, host).await
}

async fn answer(ctx: &RequestCtx, route: Route, body: &Value, host: u16) -> Response<Body> {
    let parts = segments(&ctx.path).unwrap_or_default();
    match route {
        Route::Options {
            allow,
            guard_segment,
        } => match guard_segment {
            None => super::options(ctx, allow),
            Some(index) => {
                // The retired `app.use('/api[/v1]/sessions/:id', guard)` layer
                // answered OPTIONS too: it 404s internal execution slots before
                // the automatic Allow row is produced.
                let found = match guard(ctx, host, part(&parts, index)).await {
                    Ok(found) => found,
                    Err(response) => return response,
                };
                if found.internal {
                    let v1 = parts.first().is_some_and(|head| lit(head, "v1"));
                    guarded_404(ctx, v1)
                } else {
                    super::options(ctx, allow)
                }
            }
        },
        Route::V1SessionsGet => v1_sessions(ctx, host).await,
        Route::V1SessionGet => v1_session(ctx, host, part(&parts, 2)).await,
        Route::V1WorkspaceGet => v1_workspace(ctx, host, part(&parts, 2)).await,
        Route::SessionsGet => sessions_list(ctx, host).await,
        Route::SessionGet => session_detail(ctx, host, part(&parts, 1)).await,
        Route::ReclassifyPost => reclassify(ctx, host, part(&parts, 1)).await,
        Route::MarkTaskDonePost => mark_task_done(ctx, host, part(&parts, 1)).await,
        Route::MarkGoalAchievedPost => mark_goal_achieved(ctx, host, part(&parts, 1)).await,
        Route::ReclassifyAllPost => reclassify_all(ctx, host, body).await,
        Route::DirectorySessionsGet => directory_sessions(ctx, host, part(&parts, 1)).await,
        Route::DirectoryWorkspaceGet => directory_workspace(ctx, host, part(&parts, 1)).await,
        Route::DebugClassifyPost => debug_classify(ctx, host, part(&parts, 2)).await,
        Route::DebugClassifyCasesGet => debug_cases(ctx, host).await,
    }
}

// ── /api/v1 ────────────────────────────────────────────────────────────────

async fn v1_sessions(ctx: &RequestCtx, host: u16) -> Response<Body> {
    let records = match call(ctx, host, payload("records", vec![])).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let visible: Vec<(Value, Value)> = record_pairs(&records)
        .into_iter()
        .filter(|(_, record)| context_visible(record, false, false))
        .collect();
    let runtimes = match call(
        ctx,
        host,
        payload("v1-dto", vec![("items", runtime_items(&visible))]),
    )
    .await
    {
        Ok(value) => value,
        Err(response) => return response,
    };
    let mut sessions: Vec<Value> = Vec::new();
    for (index, (_, record)) in visible.iter().enumerate() {
        let runtime = member(&at(&runtimes, index), "runtime");
        sessions.push(rules::to_session_dto(&rules::session_dto_source(
            record, &runtime,
        )));
    }
    let count = sessions.len();
    ok(
        ctx,
        rules::with_api_meta(json!({ "sessions": sessions, "count": count }), &ctx.ids),
    )
}

async fn v1_session(ctx: &RequestCtx, host: u16, raw: &str) -> Response<Body> {
    let id = match decoded(ctx, raw) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let guarded = match guard(ctx, host, &id).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    if guarded.internal {
        return guarded_404(ctx, true);
    }
    if !context_visible(&guarded.record, false, true) {
        return v1_error(ctx, 404, "session not found", "session_not_found");
    }
    let record = guarded.record;
    let runtimes = match call(
        ctx,
        host,
        payload(
            "v1-dto",
            vec![(
                "items",
                Value::Array(vec![
                    json!({ "id": member(&record, "id"), "record": record }),
                ]),
            )],
        ),
    )
    .await
    {
        Ok(value) => value,
        Err(response) => return response,
    };
    let runtime = member(&at(&runtimes, 0), "runtime");
    let session = rules::to_session_dto(&rules::session_dto_source(&record, &runtime));
    ok(
        ctx,
        rules::with_api_meta(json!({ "session": session }), &ctx.ids),
    )
}

async fn v1_workspace(ctx: &RequestCtx, host: u16, raw: &str) -> Response<Body> {
    // `snapshot(req.params.id)`: the directory lookup AND the record filter both
    // use the raw decoded parameter.
    let dir_id = match decoded(ctx, raw) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let directory = match call(ctx, host, payload("directory", vec![("id", json!(dir_id))])).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let dto = rules::directory_dto(Some(&directory).filter(|value| value.is_object()));
    if dto.is_null() {
        return v1_error(ctx, 404, "directory not found", "directory_not_found");
    }
    let key = Value::String(dir_id);
    let entries = match workspace_contexts(ctx, host, &key, false).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let mut sessions: Vec<Value> = Vec::new();
    for (record, runtime, facts, _) in entries {
        let session = rules::to_session_dto(&rules::session_dto_source(&record, &runtime));
        sessions.push(rules::workspace_entry(session, &facts));
    }
    let view = rules::workspace_contract_view(dto, sessions);
    ok(
        ctx,
        rules::with_api_meta(json!({ "workspace": view }), &ctx.ids),
    )
}

// ── /api/sessions ─────────────────────────────────────────────────────────

async fn sessions_list(ctx: &RequestCtx, host: u16) -> Response<Body> {
    let records = match call(ctx, host, payload("records", vec![])).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let visible: Vec<(Value, Value)> = record_pairs(&records)
        .into_iter()
        .filter(|(_, record)| context_visible(record, false, false))
        .collect();
    let dto = match call(
        ctx,
        host,
        payload("list-dto", vec![("items", runtime_items(&visible))]),
    )
    .await
    {
        Ok(value) => value,
        Err(response) => return response,
    };
    let mut entries: Vec<Value> = Vec::new();
    for (index, (_, record)) in visible.iter().enumerate() {
        let per = at(&dto, index);
        entries.push(rules::legacy_session_list(
            record,
            &member(&per, "runtime"),
            &per,
        ));
    }
    let aux = match call(ctx, host, payload("aux-entry", vec![])).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    if !matches!(aux.get("available"), Some(Value::Bool(false))) {
        if matches!(aux.get("present"), Some(Value::Bool(true))) {
            entries.insert(0, member(&aux, "entry"));
        }
    } else {
        return express::error(ctx, 500, "aux runtime unavailable");
    }
    ok(ctx, Value::Array(entries))
}

async fn session_detail(ctx: &RequestCtx, host: u16, raw: &str) -> Response<Body> {
    let id = match decoded(ctx, raw) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let guarded = match guard(ctx, host, &id).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    if guarded.internal {
        return guarded_404(ctx, false);
    }
    if !context_visible(&guarded.record, true, true) {
        return error_json(ctx, 404, "Session not found");
    }
    let record = guarded.record;
    let facts = match call(
        ctx,
        host,
        payload(
            "detail-dto",
            vec![("id", member(&record, "id")), ("record", record.clone())],
        ),
    )
    .await
    {
        Ok(value) => value,
        Err(response) => return response,
    };
    ok(
        ctx,
        rules::legacy_session_detail(&record, &member(&facts, "runtime"), &facts),
    )
}

// ── the three POST actions ────────────────────────────────────────────────

async fn reclassify(ctx: &RequestCtx, host: u16, raw: &str) -> Response<Body> {
    let id = match decoded(ctx, raw) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let guarded = match guard(ctx, host, &id).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    if guarded.internal {
        return guarded_404(ctx, false);
    }
    if guarded.record.is_null() {
        return error_json(ctx, 404, "session not found");
    }
    if is_system_record(&guarded.record) {
        return error_json(ctx, 400, "not a chat session");
    }
    let task = match call(ctx, host, payload("task-state", vec![("id", json!(id))])).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let state = member(&task, "classifyState");
    if rules::is_settled_letter(task.get("classifyState")) && !force_flag(ctx) {
        let note = format!(
            "会话状态为 {}，跳过重判（需用户发新消息触发，或 ?force=true 强制）",
            js_display(&state)
        );
        return ok(
            ctx,
            json!({
                "ok": true,
                "skipped": true,
                "classifyState": state,
                "note": note,
            }),
        );
    }
    let reply = match call(ctx, host, payload("reply", vec![("id", json!(id))])).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let reply = match reply {
        Value::String(text) => text,
        _ => String::new(),
    };
    if utf16_len(&reply) < 20 {
        return error_json(ctx, 400, "no assistant reply to classify against");
    }
    if let Err(response) = call(
        ctx,
        host,
        payload("enqueue", vec![("id", json!(id)), ("reply", json!(reply))]),
    )
    .await
    {
        return response;
    }
    ok(
        ctx,
        json!({ "ok": true, "note": "reclassify enqueued; 状态更新会通过 WS 异步到达" }),
    )
}

async fn mark_task_done(ctx: &RequestCtx, host: u16, raw: &str) -> Response<Body> {
    let id = match decoded(ctx, raw) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let guarded = match guard(ctx, host, &id).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    if guarded.internal {
        return guarded_404(ctx, false);
    }
    let record = guarded.record;
    if record.is_null() {
        return error_json(ctx, 404, "session not found");
    }
    if is_system_record(&record) {
        return error_json(ctx, 400, "not a chat session");
    }
    let task = match call(ctx, host, payload("task-state", vec![("id", json!(id))])).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    if rules::is_terminal_letter(task.get("classifyState")) {
        return ok(
            ctx,
            json!({
                "ok": true,
                "alreadySucceeded": true,
                "alreadyDone": true,
                "classifyState": "D",
                "turnOutcome": "succeeded",
            }),
        );
    }
    let chat = match call(ctx, host, payload("chat-flag", vec![("id", json!(id))])).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let streaming = matches!(chat.get("exists"), Some(Value::Bool(true)))
        && chat.get("streaming").is_some_and(truthy);
    if streaming {
        return express::json(
            ctx,
            409,
            &json!({
                "error": "session is streaming",
                "note": "会话正在执行，无法标记执行成功",
            }),
            &[],
        );
    }
    let goal = or_empty(task.get("goal"));
    let phase = or_empty(task.get("phase"));
    let is_terminal = !matches!(record.get("kind"), Some(Value::String(kind)) if kind == "chat");
    if let Err(response) = call(
        ctx,
        host,
        payload(
            "dispatch-state",
            vec![
                ("id", json!(id)),
                ("goal", goal),
                ("phase", phase),
                ("isTerminal", Value::Bool(is_terminal)),
            ],
        ),
    )
    .await
    {
        return response;
    }
    ok(
        ctx,
        json!({ "ok": true, "classifyState": "D", "turnOutcome": "succeeded" }),
    )
}

async fn mark_goal_achieved(ctx: &RequestCtx, host: u16, raw: &str) -> Response<Body> {
    let id = match decoded(ctx, raw) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let guarded = match guard(ctx, host, &id).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    if guarded.internal {
        return guarded_404(ctx, false);
    }
    let record = guarded.record;
    if record.is_null() {
        return error_json(ctx, 404, "session not found");
    }
    if is_system_record(&record) {
        return error_json(ctx, 400, "not a chat session");
    }
    if !guarded.task_state_writable {
        return error_json(ctx, 501, "task state writes unavailable");
    }
    let task = match call(ctx, host, payload("task-state", vec![("id", json!(id))])).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    if !rules::is_terminal_letter(task.get("classifyState")) {
        return express::json(
            ctx,
            409,
            &json!({
                "error": "turn not succeeded",
                "classifyState": or_null(task.get("classifyState")),
                "note": "只有执行成功的一轮才能标记为达成目标",
            }),
            &[],
        );
    }
    if rules::eq_str(task.get("goalState"), rules::GOAL_ACHIEVED) {
        return ok(
            ctx,
            json!({
                "ok": true,
                "alreadyAchieved": true,
                "classifyState": "D",
                "goalState": rules::GOAL_ACHIEVED,
            }),
        );
    }
    if let Err(response) = call(
        ctx,
        host,
        payload("set-goal-achieved", vec![("id", json!(id))]),
    )
    .await
    {
        return response;
    }
    ok(
        ctx,
        json!({ "ok": true, "classifyState": "D", "goalState": rules::GOAL_ACHIEVED }),
    )
}

async fn reclassify_all(ctx: &RequestCtx, host: u16, body: &Value) -> Response<Body> {
    let only_junk = !matches!(body.get("onlyJunk"), Some(Value::Bool(false)));
    let records = match call(ctx, host, payload("records", vec![])).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let mut ids: Vec<Value> = Vec::new();
    for (key, record) in record_pairs(&records) {
        if !truthy(&record) || is_system_record(&record) {
            continue;
        }
        let task = match call(ctx, host, payload("task-state", vec![("id", key.clone())])).await {
            Ok(value) => value,
            Err(response) => return response,
        };
        if rules::is_settled_letter(task.get("classifyState")) {
            continue;
        }
        if only_junk && !rules::is_injected_or_junk_goal(task.get("goal")) {
            continue;
        }
        let reply = match call(ctx, host, payload("reply", vec![("id", key.clone())])).await {
            Ok(value) => value,
            Err(response) => return response,
        };
        let reply = match reply {
            Value::String(text) => text,
            _ => String::new(),
        };
        if utf16_len(&reply) < 20 {
            continue;
        }
        if let Err(response) = call(
            ctx,
            host,
            payload(
                "enqueue",
                vec![("id", key.clone()), ("reply", json!(reply))],
            ),
        )
        .await
        {
            return response;
        }
        ids.push(key);
    }
    let count = ids.len();
    ok(
        ctx,
        json!({ "ok": true, "count": count, "ids": ids, "onlyJunk": only_junk }),
    )
}

// ── /api/directories ──────────────────────────────────────────────────────

async fn directory_sessions(ctx: &RequestCtx, host: u16, raw: &str) -> Response<Body> {
    let id = match decoded(ctx, raw) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let directory = match call(ctx, host, payload("directory", vec![("id", json!(id))])).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    if directory.is_null() {
        return error_json(ctx, 404, "directory not found");
    }
    let records = match call(ctx, host, payload("records", vec![])).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let dir_id = member(&directory, "id");
    let visible: Vec<(Value, Value)> = record_pairs(&records)
        .into_iter()
        .filter(|(_, record)| same_dir(record, &dir_id) && context_visible(record, true, false))
        .collect();
    let dto = match call(
        ctx,
        host,
        payload("dir-dto", vec![("items", runtime_items(&visible))]),
    )
    .await
    {
        Ok(value) => value,
        Err(response) => return response,
    };
    let mut sessions: Vec<Value> = Vec::new();
    for (index, (_, record)) in visible.iter().enumerate() {
        let per = at(&dto, index);
        sessions.push(rules::legacy_directory_session(
            record,
            &member(&per, "runtime"),
            &per,
        ));
    }
    ok(ctx, json!({ "directory": directory, "sessions": sessions }))
}

async fn directory_workspace(ctx: &RequestCtx, host: u16, raw: &str) -> Response<Body> {
    let id = match decoded(ctx, raw) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let directory = match call(ctx, host, payload("directory", vec![("id", json!(id))])).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    if directory.is_null() {
        return error_json(ctx, 404, "directory not found");
    }
    let key = member(&directory, "id");
    let entries = match workspace_contexts(ctx, host, &key, false).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let mut sessions: Vec<Value> = Vec::new();
    for (record, runtime, facts, invalid) in entries {
        sessions.push(rules::legacy_workspace(
            &record,
            &runtime,
            &facts,
            invalid.as_ref(),
        ));
    }
    ok(ctx, json!({ "directory": directory, "sessions": sessions }))
}

/// The `listContexts({dirId})` + `sessionView` + `getInvalidSession` batch the
/// two workspace projections share.
async fn workspace_contexts(
    ctx: &RequestCtx,
    host: u16,
    dir_id: &Value,
    include_hidden: bool,
) -> Result<Vec<(Value, Value, Value, Option<Value>)>, Response<Body>> {
    let records = call(ctx, host, payload("records", vec![])).await?;
    let visible: Vec<(Value, Value)> = record_pairs(&records)
        .into_iter()
        .filter(|(_, record)| {
            same_dir(record, dir_id) && context_visible(record, include_hidden, false)
        })
        .collect();
    let dto = call(
        ctx,
        host,
        payload("workspace-dto", vec![("items", runtime_items(&visible))]),
    )
    .await?;
    let mut out: Vec<(Value, Value, Value, Option<Value>)> = Vec::new();
    for (index, (_, record)) in visible.into_iter().enumerate() {
        let per = at(&dto, index);
        out.push((
            record,
            member(&per, "runtime"),
            member(&per, "facts"),
            invalid_of(&per),
        ));
    }
    Ok(out)
}

// ── /api/debug/classify ───────────────────────────────────────────────────

async fn debug_classify(ctx: &RequestCtx, host: u16, raw: &str) -> Response<Body> {
    let id = match decoded(ctx, raw) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let record = match call(ctx, host, payload("record", vec![("id", json!(id))])).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    if record.is_null() {
        return error_json(ctx, 404, "session not found");
    }
    let history = match read_history(ctx, host, &id).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    if history.as_array().is_none_or(Vec::is_empty) {
        return error_json(ctx, 400, "no history");
    }
    let (text, _) = rules::latest_assistant(&history, 0);
    let length = utf16_len(&text);
    if text.is_empty() || length < 20 {
        return express::json(
            ctx,
            400,
            &json!({ "error": "no valid assistant text", "len": length }),
            &[],
        );
    }
    let chat = match call(ctx, host, payload("chat-flag", vec![("id", json!(id))])).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    if !matches!(chat.get("exists"), Some(Value::Bool(true))) {
        return error_json(ctx, 400, "session not active");
    }
    let task = match call(ctx, host, payload("task-state", vec![("id", json!(id))])).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    if rules::is_settled_letter(task.get("classifyState")) && !force_flag(ctx) {
        let state = member(&task, "classifyState");
        return express::json(
            ctx,
            409,
            &json!({
                "error": format!(
                    "session is {}; use ?force=true to override",
                    js_display(&state)
                ),
                "classifyState": state,
            }),
            &[],
        );
    }
    if let Err(response) = call(
        ctx,
        host,
        payload(
            "run-classify",
            vec![("id", json!(id)), ("text", json!(text))],
        ),
    )
    .await
    {
        return response;
    }
    let tail = rules::assistant_tail(&text);
    let preview = rules::tail_300(&tail).replace('\n', " ");
    ok(
        ctx,
        json!({
            "ok": true,
            "sessionName": id,
            "triggered": true,
            "tailPreview": preview,
            "note": "classify enqueued — check server logs for classify RESULT",
        }),
    )
}

async fn debug_cases(ctx: &RequestCtx, host: u16) -> Response<Body> {
    let records = match call(ctx, host, payload("records", vec![])).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let mut cases: Vec<Value> = Vec::new();
    for (key, record) in record_pairs(&records) {
        if !truthy(&record) || is_system_record(&record) {
            continue;
        }
        if !rules::eq_str(record.get("kind"), "chat") {
            continue;
        }
        let history = match read_history(ctx, host, &js_display(&key)).await {
            Ok(value) => value,
            Err(response) => return response,
        };
        let (text, ts) = rules::latest_assistant(&history, 0);
        if text.is_empty() || utf16_len(&text) < 40 {
            continue;
        }
        let tail = rules::assistant_tail(&text);
        let task = match record.get("taskState") {
            Some(Value::Object(map)) => Value::Object(map.clone()),
            _ => Value::Object(Map::new()),
        };
        cases.push(json!({
            "sessionId": key,
            "label": or_empty(record.get("label")),
            "classifyState": or_null(task.get("classifyState")),
            "goal": or_empty(task.get("goal")),
            "summary": or_empty(record.get("summary")),
            "lastAssistantTail300": rules::tail_300(&tail),
            "lastAssistantFullTail": tail,
            "lastActivity": or_null(record.get("lastActivity")),
            "lastTs": iso_of_ts(&ts),
        }));
    }
    cases.sort_by(|left, right| {
        let key = |value: &Value| -> String {
            match value.get("lastTs") {
                Some(Value::String(text)) => text.clone(),
                _ => String::new(),
            }
        };
        key(right).cmp(&key(left))
    });
    let count = cases.len();
    ok(ctx, json!({ "count": count, "cases": cases }))
}

/// `viewChatHistory(id)`; a throwing loader is Node's 500, not a 503.
async fn read_history(ctx: &RequestCtx, host: u16, id: &str) -> Result<Value, Response<Body>> {
    let answer = call(ctx, host, payload("history", vec![("id", json!(id))])).await?;
    if matches!(answer.get("failed"), Some(Value::Bool(true))) {
        return Err(express::error(ctx, 500, "chat history unavailable"));
    }
    Ok(member(&answer, "history"))
}

/// `latest.ts ? new Date(latest.ts).toISOString() : null`.
fn iso_of_ts(ts: &Value) -> Value {
    match ts {
        Value::Null => Value::Null,
        other if truthy(other) => rules::timestamp(Some(other)),
        _ => Value::Null,
    }
}

/// `String(value)` for a value already known to be a printable scalar.
fn js_display(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => "null".into(),
        other => other.to_string(),
    }
}

/// `value || ''` for a member of `source`.
fn or_empty(value: Option<&Value>) -> Value {
    match value {
        Some(inner) if truthy(inner) => inner.clone(),
        _ => Value::String(String::new()),
    }
}

/// `value || null`.
fn or_null(value: Option<&Value>) -> Value {
    match value {
        Some(inner) if truthy(inner) => inner.clone(),
        _ => Value::Null,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segments_respect_case_and_trailing_slash() {
        assert_eq!(
            segments("/api/V1/Sessions/x").unwrap(),
            vec!["V1", "Sessions", "x"]
        );
        assert_eq!(segments("/api/sessions/").unwrap(), vec!["sessions"]);
        assert!(segments("/api/").is_none());
        assert!(segments("/api/sessions//x").is_none());
        assert!(segments("/other/sessions").is_none());
    }

    #[test]
    fn claims_cover_every_method_and_allow() {
        let get = Method::GET;
        let head = Method::HEAD;
        let post = Method::POST;
        let options = Method::OPTIONS;
        let opt = |allow: &'static str, guard_segment: Option<usize>| {
            Some(Route::Options {
                allow,
                guard_segment,
            })
        };
        assert_eq!(claim(&get, "/api/sessions"), Some(Route::SessionsGet));
        assert_eq!(claim(&head, "/api/sessions"), Some(Route::SessionsGet));
        assert_eq!(claim(&get, "/api/sessions/abc"), Some(Route::SessionGet));
        // This cluster's own share; session-routes contributes PATCH/DELETE and
        // session-create the POST, which the front door unions
        // (`super::OPTIONS_SOURCES`).
        assert_eq!(
            claim(&options, "/api/sessions/abc"),
            opt("GET,HEAD", Some(1))
        );
        assert_eq!(
            claim(&options, "/api/directories/d1/sessions"),
            opt("GET,HEAD", None)
        );
        assert_eq!(
            claim(&options, "/api/directories/d1/workspace"),
            opt("GET,HEAD", None)
        );
        assert_eq!(
            claim(&options, "/api/v1/directories/d1/workspace"),
            opt("GET,HEAD", None)
        );
        assert_eq!(claim(&options, "/api/reclassify-all"), opt("POST", None));
        assert_eq!(
            claim(&options, "/api/sessions/abc/reclassify"),
            opt("POST", Some(1))
        );
        assert_eq!(
            claim(&options, "/api/debug/classify/abc"),
            opt("POST", None)
        );
        assert_eq!(
            claim(&options, "/api/debug/classify-test-cases"),
            opt("GET,HEAD", None)
        );
        assert_eq!(claim(&options, "/api/v1/sessions"), opt("GET,HEAD", None));
        assert_eq!(
            claim(&options, "/api/v1/sessions/abc"),
            opt("GET,HEAD", Some(2))
        );
        assert_eq!(
            claim(&post, "/api/sessions/abc/mark-task-done"),
            Some(Route::MarkTaskDonePost)
        );
        assert_eq!(
            claim(&post, "/api/sessions/abc/mark-goal-achieved"),
            Some(Route::MarkGoalAchievedPost)
        );
        assert_eq!(
            claim(&get, "/api/Debug/Classify-Test-Cases"),
            Some(Route::DebugClassifyCasesGet)
        );
        assert_eq!(claim(&post, "/api/sessions/abc"), None);
        assert_eq!(claim(&get, "/api/reclassify-all"), None);
        assert_eq!(claim(&get, "/api/sessions/abc/unknown"), None);
        // The `/api/` prefix itself is case-sensitive across the front door.
        assert_eq!(claim(&get, "/API/sessions"), None);
    }

    #[test]
    fn context_visibility_matches_session_query() {
        let hidden = json!({ "id": "a", "type": "aux" });
        assert!(!context_visible(&hidden, false, false));
        assert!(context_visible(&hidden, true, false));
        let slot = json!({ "id": "b", "taskExecutionSlot": true });
        assert!(!context_visible(&slot, true, true));
        let bound = json!({ "id": "c", "taskBoundTaskId": "task-1" });
        assert!(!context_visible(&bound, true, false));
        assert!(context_visible(&bound, true, true));
        let free = json!({ "id": "d", "taskBoundTaskId": "" });
        assert!(context_visible(&free, false, false));
        assert!(!context_visible(&Value::Null, true, true));
    }

    #[test]
    fn strict_directory_equality() {
        assert!(same_dir(&json!({ "dirId": "d1" }), &json!("d1")));
        assert!(!same_dir(&json!({ "dirId": "d1" }), &json!("d2")));
        assert!(!same_dir(&json!({ "dirId": 1 }), &json!("1")));
        assert!(same_dir(&json!({ "dirId": 1 }), &json!(1)));
        assert!(!same_dir(&json!({}), &json!(null)));
    }

    #[test]
    fn record_pairs_keep_map_order() {
        let records = json!([["k1", { "id": "r1" }], ["k2", { "id": "r2" }]]);
        let pairs = record_pairs(&records);
        assert_eq!(pairs.len(), 2);
        assert_eq!(pairs[1].0, json!("k2"));
        assert_eq!(member(&pairs[0].1, "id"), json!("r1"));
        assert!(record_pairs(&json!({})).is_empty());
    }

    fn ctx_for(url: &str) -> RequestCtx {
        let request = axum::http::Request::builder()
            .uri(url)
            .body(())
            .expect("valid request");
        let (parts, _) = request.into_parts();
        RequestCtx::new(&parts)
    }

    #[test]
    fn force_flag_reads_qs_shape() {
        let ctx = ctx_for;
        assert!(force_flag(&ctx("/api/x?force=true")));
        assert!(force_flag(&ctx("/api/x?force=TRUE")));
        assert!(force_flag(&ctx("/api/x?force[]=true")));
        assert!(!force_flag(&ctx("/api/x")));
        assert!(!force_flag(&ctx("/api/x?force=1")));
        assert!(!force_flag(&ctx("/api/x?force[a]=true")));
    }

    #[test]
    fn timestamp_of_absent_ts_is_null() {
        assert_eq!(iso_of_ts(&Value::Null), Value::Null);
        assert_eq!(iso_of_ts(&json!(0)), Value::Null);
        assert_eq!(
            iso_of_ts(&json!("2026-11-14T10:00:00.000Z")),
            json!("2026-11-14T10:00:00.000Z")
        );
    }
}
