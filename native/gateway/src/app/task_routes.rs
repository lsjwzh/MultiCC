//! The task-surface route cluster retired from `src/routes/task-planning.js`,
//! `src/routes/task-board.js`, `src/routes/task-search.js`,
//! `src/routes/task-goal.js`, `src/routes/task-graph.js` and
//! `src/task-shell/attribution-settings.js`.
//!
//! Path matching, parameter decoding, query extraction and its limits, the
//! Express OPTIONS answer, the planning error→status ladder, the retention
//! ordering (through [`multicc_core::task_domain::retention`]), the response
//! envelopes and the mark-achieved eligibility ladder live here and in
//! `multicc_core::task_routes`. Node keeps every store behind one host port,
//! `POST /api/__host/task-routes` (src/routes/task-routes-host.js): the board
//! and the task-shell SQLite store, the in-process mutation locks, the chat
//! records and session binding, the message index and the graph aggregation.
//!
//! `POST /api/air/tasks/mark-achieved` is the one path this cluster shares with
//! the Air cluster: Air registers `GET /api/air/tasks/:id` on it *after* this
//! route in `server.js`, so a `GET` still belongs to Air while the `POST`
//! literal and the automatic `OPTIONS` union (`POST,GET,HEAD`) belong here.
//! `mod.rs` therefore claims this cluster before Air.
//!
//! The status, delete, relocate, chat-session and message-search bodies are
//! produced inside transactional helpers that hold process-local state
//! (`holdTaskOperation`, the lifecycle `pending` set, the per-directory
//! retention flights and the index runtime); the host returns those as a
//! finished `{ status, body }` reply and this module renders it unchanged.

#![allow(clippy::result_large_err)]

use std::sync::Arc;
use std::time::Instant;

use axum::body::Body;
use axum::http::{Method, Response};
use multicc_core::http_gate::{query_string, query_value, QueryValue};
use multicc_core::js::string::js_trim;
use multicc_core::task_routes::{
    attribution_body, clamp_limit, csv, empty_message_search, empty_search, filter_too_long,
    filter_too_long_body, invalid_status, mark_achieved_ok, mark_achieved_refusal,
    message_search_ok, min_score, planning_ok, planning_status, query_too_long,
    query_too_long_body, retention_delete, retention_preview, search_ok, status_allowed,
    task_graph_body, task_id_required, task_state_unavailable, MarkFacts,
};
use serde_json::{json, Map, Value};

use crate::app::express::{self, RequestCtx};
use crate::app::App;
use crate::host_port;

/// The host port the Node child serves (`src/routes/task-routes-host.js`).
const HOST_PATH: &str = "/api/__host/task-routes";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Route {
    PlanningCreatePost,
    PlanningUpdatePost,
    PlanningRenamePost,
    PlanningMovePost,
    RetentionGet,
    RetentionPost,
    StatusPost,
    DeleteTask,
    RelocatePost,
    ChatSessionPost,
    BoardSearchGet,
    MessageSearchGet,
    MarkAchievedPost,
    TaskGraphGet,
    AttributionGet,
    /// Express's automatic OPTIONS: the union of the methods registered on the
    /// exact path (including the Air GET that lands on `mark-achieved`), with
    /// `HEAD` after each `GET`, in registration order.
    Options,
}

#[derive(Clone, Copy)]
enum Seg {
    Lit(&'static str),
    Param,
}
use Seg::{Lit, Param};

struct Layer {
    segs: &'static [Seg],
    method: &'static str,
    kind: Route,
}

/// Registration order of the retired handlers: `taskBoardRuntime.mountRoutes`
/// mounted the five planning routes first, then retention, status, DELETE,
/// relocate and chat-session; the search routes followed, then the
/// session-admin mark-achieved route, the task graph and the attribution read.
static LAYERS: &[Layer] = &[
    Layer {
        segs: &[Lit("task-board"), Lit("tasks")],
        method: "POST",
        kind: Route::PlanningCreatePost,
    },
    Layer {
        segs: &[Lit("task-board"), Lit("tasks"), Param, Lit("update")],
        method: "POST",
        kind: Route::PlanningUpdatePost,
    },
    Layer {
        segs: &[Lit("task-board"), Lit("tasks"), Param, Lit("title")],
        method: "POST",
        kind: Route::PlanningRenamePost,
    },
    // Compatibility alias for early planning clients.
    Layer {
        segs: &[Lit("task-board"), Lit("tasks"), Param, Lit("planning")],
        method: "POST",
        kind: Route::PlanningUpdatePost,
    },
    Layer {
        segs: &[Lit("task-board"), Lit("tasks"), Param, Lit("move")],
        method: "POST",
        kind: Route::PlanningMovePost,
    },
    Layer {
        segs: &[
            Lit("task-board"),
            Lit("directories"),
            Param,
            Lit("retention"),
        ],
        method: "GET",
        kind: Route::RetentionGet,
    },
    Layer {
        segs: &[
            Lit("task-board"),
            Lit("directories"),
            Param,
            Lit("retention"),
        ],
        method: "POST",
        kind: Route::RetentionPost,
    },
    Layer {
        segs: &[Lit("task-board"), Lit("tasks"), Param, Lit("status")],
        method: "POST",
        kind: Route::StatusPost,
    },
    Layer {
        segs: &[Lit("task-board"), Lit("tasks"), Param],
        method: "DELETE",
        kind: Route::DeleteTask,
    },
    Layer {
        segs: &[Lit("task-board"), Lit("tasks"), Param, Lit("relocate")],
        method: "POST",
        kind: Route::RelocatePost,
    },
    Layer {
        segs: &[Lit("task-board"), Lit("tasks"), Param, Lit("chat-session")],
        method: "POST",
        kind: Route::ChatSessionPost,
    },
    Layer {
        segs: &[Lit("task-board"), Lit("search")],
        method: "GET",
        kind: Route::BoardSearchGet,
    },
    Layer {
        segs: &[Lit("search"), Lit("messages")],
        method: "GET",
        kind: Route::MessageSearchGet,
    },
    Layer {
        segs: &[Lit("air"), Lit("tasks"), Lit("mark-achieved")],
        method: "POST",
        kind: Route::MarkAchievedPost,
    },
    Layer {
        segs: &[Lit("task-graph")],
        method: "GET",
        kind: Route::TaskGraphGet,
    },
    Layer {
        segs: &[Lit("settings"), Lit("task-attribution")],
        method: "GET",
        kind: Route::AttributionGet,
    },
];

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

fn layer_matches(segs: &[Seg], parts: &[&str]) -> bool {
    segs.len() == parts.len()
        && segs.iter().zip(parts).all(|(seg, part)| match seg {
            Seg::Lit(name) => part.eq_ignore_ascii_case(name),
            Seg::Param => !part.is_empty(),
        })
}

pub fn claim(method: &Method, path: &str) -> Option<Route> {
    let parts = segments(path)?;
    if method.as_str() == "OPTIONS" {
        return LAYERS
            .iter()
            .any(|layer| layer_matches(layer.segs, &parts))
            .then_some(Route::Options);
    }
    let wanted = if method.as_str() == "HEAD" {
        "GET"
    } else {
        method.as_str()
    };
    LAYERS
        .iter()
        .find(|layer| layer.method == wanted && layer_matches(layer.segs, &parts))
        .map(|layer| layer.kind)
}

/// Express's automatic OPTIONS body and `Allow` header: the union of the
/// methods registered on this exact path, each `GET` followed by `HEAD`, in
/// registration order across every router that reached it.
pub fn allow_for(path: &str) -> Option<String> {
    let parts = segments(path)?;
    let mut methods: Vec<&'static str> = Vec::new();
    let mut matched = false;
    for layer in LAYERS {
        if !layer_matches(layer.segs, &parts) {
            continue;
        }
        matched = true;
        if !methods.contains(&layer.method) {
            methods.push(layer.method);
        }
        if layer.method == "GET" && !methods.contains(&"HEAD") {
            methods.push("HEAD");
        }
    }
    if !matched {
        return None;
    }
    Some(methods.join(","))
}

/// This cluster's own share of Express's automatic `OPTIONS` `Allow`, for the
/// front-door union across clusters (`super::OPTIONS_SOURCES`). The
/// `/api/air/tasks/mark-achieved` literal contributes `POST` here; Air's
/// `GET /api/air/tasks/:id` contributes `GET,HEAD`.
pub fn options_share(path: &str) -> Option<String> {
    allow_for(path)
}

fn part<'a>(parts: &[&'a str], index: usize) -> &'a str {
    parts.get(index).copied().unwrap_or("")
}

fn decoded(ctx: &RequestCtx, raw: &str) -> Result<String, Response<Body>> {
    super::download::decode_uri_component(raw)
        .ok_or_else(|| express::error(ctx, 400, "Failed to decode param"))
}

fn unavailable(ctx: &RequestCtx) -> Response<Body> {
    express::json(
        ctx,
        503,
        &json!({
            "error": "任务接口尚未就绪，请更新原生模块",
            "code": "rust_backend_unavailable",
        }),
        &[],
    )
}

/// One host round trip. Business refusals travel inside `reply`; anything that
/// makes the round trip itself fail is the documented 503.
async fn call(
    ctx: &RequestCtx,
    host_port_num: u16,
    payload: Value,
) -> Result<Value, Response<Body>> {
    match host_port::call(host_port_num, HOST_PATH, &payload).await {
        Ok(answer) if answer.get("ok") == Some(&Value::Bool(true)) => {
            Ok(answer.get("value").cloned().unwrap_or(Value::Null))
        }
        _ => Err(unavailable(ctx)),
    }
}

/// The retired handler already rendered `{ status, body }`; send it verbatim.
fn reply(ctx: &RequestCtx, value: &Value) -> Option<Response<Body>> {
    let reply = value.get("reply")?;
    let status = reply
        .get("status")
        .and_then(Value::as_u64)
        .filter(|status| *status >= 100 && *status <= 599)
        .unwrap_or(200) as u16;
    Some(express::json(
        ctx,
        status,
        reply.get("body").unwrap_or(&Value::Null),
        &[],
    ))
}

/// The four transaction-backed handlers render their own `{status, body}`;
/// a plain value (no `reply`) is sent as a 200 JSON body.
fn answered(ctx: &RequestCtx, result: Result<Value, Response<Body>>) -> Response<Body> {
    match result {
        Ok(value) => reply(ctx, &value).unwrap_or_else(|| express::json(ctx, 200, &value, &[])),
        Err(response) => response,
    }
}

fn payload(op: &str, fields: Vec<(&str, Value)>) -> Value {
    let mut object = Map::new();
    object.insert("op".into(), Value::String(op.to_string()));
    for (key, value) in fields {
        object.insert(key.to_string(), value);
    }
    Value::Object(object)
}

/// `String(req.query[name])`, including `?a=1&a=2` → `"1,2"`.
fn query_text(ctx: &RequestCtx, name: &str) -> String {
    query_string(&query_value(&ctx.original_url, name))
}

/// `req.query[primary] ?? req.query[fallback] ?? ''`.
fn query_first(ctx: &RequestCtx, primary: &str, fallback: &str) -> String {
    match query_value(&ctx.original_url, primary) {
        QueryValue::Missing => query_text(ctx, fallback),
        other => query_string(&other),
    }
}

fn trimmed(text: &str) -> String {
    js_trim(text).to_string()
}

fn non_empty(text: String) -> Option<String> {
    (!text.is_empty()).then_some(text)
}

fn body_text(body: &Value, key: &str) -> Option<String> {
    body.get(key).and_then(Value::as_str).map(trimmed)
}

pub async fn handle(
    app: &Arc<App>,
    route: Route,
    ctx: &RequestCtx,
    body: &Value,
    host_port_num: u16,
) -> Response<Body> {
    let write = ctx.method == Method::POST || ctx.method == Method::DELETE;
    let _serialized = if write {
        Some(app.task_routes_write.lock().await)
    } else {
        None
    };
    answer(ctx, route, body, host_port_num).await
}

async fn planning(
    ctx: &RequestCtx,
    host: u16,
    op: &str,
    task_id: Option<String>,
    body: &Value,
) -> Response<Body> {
    let mut fields = vec![("body", body.clone())];
    if let Some(task_id) = task_id {
        fields.push(("taskId", json!(task_id)));
    }
    let value = match call(ctx, host, payload(op, fields)).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    if let Some(response) = reply(ctx, &value) {
        return response;
    }
    if let Some(outcome) = value.get("outcome") {
        let code = outcome
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or_default();
        return express::json(ctx, planning_status(code), outcome, &[]);
    }
    let task = value.get("task").cloned().unwrap_or(Value::Null);
    let revision = value.get("revision").cloned().unwrap_or(Value::Null);
    express::json(ctx, 200, &planning_ok(&task, &revision), &[])
}

async fn answer(ctx: &RequestCtx, route: Route, body: &Value, host: u16) -> Response<Body> {
    let parts = segments(&ctx.path).unwrap_or_default();
    match route {
        Route::Options => {
            let allow = allow_for(&ctx.path).unwrap_or_default();
            express::send(
                ctx,
                200,
                "text/html; charset=utf-8",
                allow.clone().into_bytes(),
                &[("Allow", allow.as_str())],
            )
        }
        Route::PlanningCreatePost => planning(ctx, host, "planning-create", None, body).await,
        Route::PlanningUpdatePost => match decoded(ctx, part(&parts, 2)) {
            Ok(id) => planning(ctx, host, "planning-update", Some(id), body).await,
            Err(response) => response,
        },
        Route::PlanningRenamePost => match decoded(ctx, part(&parts, 2)) {
            Ok(id) => planning(ctx, host, "planning-rename", Some(id), body).await,
            Err(response) => response,
        },
        Route::PlanningMovePost => match decoded(ctx, part(&parts, 2)) {
            Ok(id) => planning(ctx, host, "planning-move", Some(id), body).await,
            Err(response) => response,
        },
        Route::RetentionGet => {
            let dir_id = match decoded(ctx, part(&parts, 2)) {
                Ok(value) => value,
                Err(response) => return response,
            };
            let value = match call(
                ctx,
                host,
                payload("retention-preview", vec![("dirId", json!(dir_id))]),
            )
            .await
            {
                Ok(value) => value,
                Err(response) => return response,
            };
            if let Some(response) = reply(ctx, &value) {
                return response;
            }
            let mut entries = value
                .get("entries")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let body = retention_preview(
                &mut entries,
                value.get("idOrder").unwrap_or(&Value::Null),
                value.get("limit").unwrap_or(&Value::Null),
                value.get("count").unwrap_or(&Value::Null),
                value.get("maxBatch").unwrap_or(&Value::Null),
            );
            express::json(ctx, 200, &body, &[])
        }
        Route::RetentionPost => {
            let dir_id = match decoded(ctx, part(&parts, 2)) {
                Ok(value) => value,
                Err(response) => return response,
            };
            let task_ids = body.get("taskIds").cloned().unwrap_or(Value::Null);
            let value = match call(
                ctx,
                host,
                payload(
                    "retention-delete",
                    vec![("dirId", json!(dir_id)), ("taskIds", task_ids)],
                ),
            )
            .await
            {
                Ok(value) => value,
                Err(response) => return response,
            };
            if let Some(response) = reply(ctx, &value) {
                return response;
            }
            let body = retention_delete(
                value.get("deleted").unwrap_or(&Value::Null),
                value.get("skipped").unwrap_or(&Value::Null),
                value.get("count").unwrap_or(&Value::Null),
                value.get("limit").unwrap_or(&Value::Null),
            );
            express::json(ctx, 200, &body, &[])
        }
        Route::StatusPost => {
            // The first gate in the retired handler, before any store is read.
            if !status_allowed(body) {
                return express::json(ctx, 400, &invalid_status(), &[]);
            }
            let id = match decoded(ctx, part(&parts, 2)) {
                Ok(value) => value,
                Err(response) => return response,
            };
            answered(
                ctx,
                call(
                    ctx,
                    host,
                    payload(
                        "task-status",
                        vec![("taskId", json!(id)), ("body", body.clone())],
                    ),
                )
                .await,
            )
        }
        Route::DeleteTask => {
            let id = match decoded(ctx, part(&parts, 2)) {
                Ok(value) => value,
                Err(response) => return response,
            };
            answered(
                ctx,
                call(
                    ctx,
                    host,
                    payload(
                        "task-delete",
                        vec![("taskId", json!(id)), ("body", body.clone())],
                    ),
                )
                .await,
            )
        }
        Route::RelocatePost => {
            let id = match decoded(ctx, part(&parts, 2)) {
                Ok(value) => value,
                Err(response) => return response,
            };
            answered(
                ctx,
                call(
                    ctx,
                    host,
                    payload(
                        "task-relocate",
                        vec![("taskId", json!(id)), ("body", body.clone())],
                    ),
                )
                .await,
            )
        }
        Route::ChatSessionPost => {
            let id = match decoded(ctx, part(&parts, 2)) {
                Ok(value) => value,
                Err(response) => return response,
            };
            answered(
                ctx,
                call(
                    ctx,
                    host,
                    payload("task-chat-session", vec![("taskId", json!(id))]),
                )
                .await,
            )
        }
        Route::BoardSearchGet => {
            let query = trimmed(&query_first(ctx, "q", "query"));
            if query.is_empty() {
                return express::json(ctx, 200, &empty_search(), &[]);
            }
            if query_too_long(&query) {
                return express::json(ctx, 400, &query_too_long_body(), &[]);
            }
            let mut fields = vec![
                ("query", json!(query)),
                ("limit", json!(clamp_limit(&query_text(ctx, "limit")))),
            ];
            if let Some(dir_id) = non_empty(trimmed(&query_text(ctx, "dirId"))) {
                fields.push(("dirId", json!(dir_id)));
            }
            if let Some(dir_ids) = csv(&query_text(ctx, "dirIds")) {
                fields.push(("dirIds", json!(dir_ids)));
            }
            if let Some(statuses) = csv(&query_text(ctx, "statuses")) {
                fields.push(("statuses", json!(statuses)));
            }
            fields.push((
                "minScore",
                serde_json::Number::from_f64(min_score(&query_text(ctx, "minScore")))
                    .map(Value::Number)
                    // `JSON.stringify(Infinity)` is `null`, and so is ours.
                    .unwrap_or(Value::Null),
            ));
            let value = match call(ctx, host, payload("search-board", fields)).await {
                Ok(value) => value,
                Err(response) => return response,
            };
            if let Some(response) = reply(ctx, &value) {
                return response;
            }
            let results = value.get("results").cloned().unwrap_or(Value::Null);
            express::json(ctx, 200, &search_ok(&query, &results), &[])
        }
        Route::MessageSearchGet => {
            // The retired handler resolves the index runtime before it validates
            // anything, so the round trip comes first: a host that cannot open
            // its index answers 503 exactly like an unwired one.
            let scope = match call(ctx, host, payload("search-messages-scope", vec![])).await {
                Ok(value) => value,
                Err(response) => return response,
            };
            if scope.get("unavailable") == Some(&Value::Bool(true)) {
                return express::json(
                    ctx,
                    503,
                    &json!({ "error": "message_search_unavailable" }),
                    &[],
                );
            }
            let warming = scope.get("warming") == Some(&Value::Bool(true));
            let query = trimmed(&query_first(ctx, "q", "query"));
            if query.is_empty() {
                return express::json(ctx, 200, &empty_message_search(warming), &[]);
            }
            if query_too_long(&query) {
                return express::json(ctx, 400, &query_too_long_body(), &[]);
            }
            let dir_id = trimmed(&query_text(ctx, "dirId"));
            let task_id = trimmed(&query_text(ctx, "taskId"));
            if filter_too_long(&dir_id) || filter_too_long(&task_id) {
                return express::json(ctx, 400, &filter_too_long_body(), &[]);
            }
            let mut fields = vec![
                ("query", json!(query)),
                ("limit", json!(clamp_limit(&query_text(ctx, "limit")))),
            ];
            if let Some(kinds) =
                csv(&query_text(ctx, "role")).or_else(|| csv(&query_text(ctx, "kinds")))
            {
                fields.push(("kinds", json!(kinds)));
            }
            if let Some(ref_ids) =
                csv(&query_text(ctx, "session")).or_else(|| csv(&query_text(ctx, "sessions")))
            {
                fields.push(("refIds", json!(ref_ids)));
            }
            if !dir_id.is_empty() {
                fields.push(("dirId", json!(dir_id)));
            }
            if !task_id.is_empty() {
                fields.push(("taskId", json!(task_id)));
            }
            let value = match call(ctx, host, payload("search-messages", fields)).await {
                Ok(value) => value,
                Err(response) => return response,
            };
            if let Some(response) = reply(ctx, &value) {
                return response;
            }
            let results = value.get("results").cloned().unwrap_or(Value::Null);
            express::json(ctx, 200, &message_search_ok(&query, warming, &results), &[])
        }
        Route::MarkAchievedPost => {
            let task_id = body_text(body, "taskId").unwrap_or_default();
            if task_id.is_empty() {
                return express::json(ctx, 400, &task_id_required(), &[]);
            }
            let facts_value = match call(
                ctx,
                host,
                payload("mark-achieved-facts", vec![("taskId", json!(task_id))]),
            )
            .await
            {
                Ok(value) => value,
                Err(response) => return response,
            };
            if let Some(response) = reply(ctx, &facts_value) {
                return response;
            }
            if facts_value.get("unavailable") == Some(&Value::Bool(true)) {
                return express::json(ctx, 501, &task_state_unavailable(), &[]);
            }
            let facts = MarkFacts::from_value(&facts_value);
            if let Some((status, refusal)) = mark_achieved_refusal(&facts) {
                return express::json(ctx, status, &refusal, &[]);
            }
            let written = match call(
                ctx,
                host,
                payload(
                    "mark-achieved-write",
                    vec![
                        ("taskId", json!(task_id)),
                        ("sessionId", json!(facts.session_id)),
                    ],
                ),
            )
            .await
            {
                Ok(value) => value,
                Err(response) => return response,
            };
            if let Some(response) = reply(ctx, &written) {
                return response;
            }
            express::json(ctx, 200, &mark_achieved_ok(&task_id), &[])
        }
        Route::TaskGraphGet => {
            let started = Instant::now();
            let dir_id = match query_value(&ctx.original_url, "dirId") {
                QueryValue::Missing => "all".to_string(),
                other => non_empty(query_string(&other)).unwrap_or_else(|| "all".to_string()),
            };
            let value = match call(
                ctx,
                host,
                payload("task-graph", vec![("dirId", json!(dir_id))]),
            )
            .await
            {
                Ok(value) => value,
                Err(response) => return response,
            };
            if let Some(response) = reply(ctx, &value) {
                return response;
            }
            let graph = value.get("graph").cloned().unwrap_or(Value::Null);
            let duration = started.elapsed().as_millis() as i64;
            express::json(ctx, 200, &task_graph_body(graph, duration), &[])
        }
        Route::AttributionGet => {
            let value = match call(ctx, host, payload("attribution-mode", vec![])).await {
                Ok(value) => value,
                Err(response) => return response,
            };
            if let Some(response) = reply(ctx, &value) {
                return response;
            }
            let mode = value.get("mode").cloned().unwrap_or(Value::Null);
            express::json(ctx, 200, &attribution_body(&mode), &[])
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allow(path: &str) -> String {
        allow_for(path).unwrap_or_else(|| panic!("no layer matches {path}"))
    }

    fn claim_str(method: Method, path: &str) -> Option<Route> {
        claim(&method, path)
    }

    #[test]
    fn claims_the_fifteen_paths_and_their_automatic_options() {
        let get = Method::GET;
        let post = Method::POST;
        assert_eq!(
            claim_str(post.clone(), "/api/task-board/tasks"),
            Some(Route::PlanningCreatePost)
        );
        assert_eq!(
            claim_str(post.clone(), "/api/task-board/tasks/t1/update"),
            Some(Route::PlanningUpdatePost)
        );
        assert_eq!(
            claim_str(post.clone(), "/api/task-board/tasks/t1/planning"),
            Some(Route::PlanningUpdatePost),
            "the compatibility alias answers like update"
        );
        assert_eq!(
            claim_str(post.clone(), "/api/task-board/tasks/t1/title"),
            Some(Route::PlanningRenamePost)
        );
        assert_eq!(
            claim_str(post.clone(), "/api/task-board/tasks/t1/move"),
            Some(Route::PlanningMovePost)
        );
        assert_eq!(
            claim_str(get.clone(), "/api/task-board/directories/d1/retention"),
            Some(Route::RetentionGet)
        );
        assert_eq!(
            claim_str(post.clone(), "/api/task-board/directories/d1/retention"),
            Some(Route::RetentionPost)
        );
        assert_eq!(
            claim_str(post.clone(), "/api/task-board/tasks/t1/status"),
            Some(Route::StatusPost)
        );
        assert_eq!(
            claim_str(Method::DELETE, "/api/task-board/tasks/t1"),
            Some(Route::DeleteTask)
        );
        assert_eq!(
            claim_str(post.clone(), "/api/task-board/tasks/t1/relocate"),
            Some(Route::RelocatePost)
        );
        assert_eq!(
            claim_str(post.clone(), "/api/task-board/tasks/t1/chat-session"),
            Some(Route::ChatSessionPost)
        );
        assert_eq!(
            claim_str(get.clone(), "/api/task-board/search"),
            Some(Route::BoardSearchGet)
        );
        assert_eq!(
            claim_str(get.clone(), "/api/search/messages"),
            Some(Route::MessageSearchGet)
        );
        assert_eq!(
            claim_str(post.clone(), "/api/air/tasks/mark-achieved"),
            Some(Route::MarkAchievedPost)
        );
        assert_eq!(
            claim_str(get.clone(), "/api/task-graph"),
            Some(Route::TaskGraphGet)
        );
        assert_eq!(
            claim_str(get.clone(), "/api/settings/task-attribution"),
            Some(Route::AttributionGet)
        );
        assert_eq!(
            claim_str(Method::OPTIONS, "/api/task-board/tasks"),
            Some(Route::Options)
        );
    }

    #[test]
    fn head_follows_get_and_unowned_methods_fall_through() {
        assert_eq!(
            claim_str(Method::HEAD, "/api/task-board/search"),
            Some(Route::BoardSearchGet)
        );
        assert_eq!(
            claim_str(Method::HEAD, "/api/task-graph"),
            Some(Route::TaskGraphGet)
        );
        assert_eq!(claim_str(Method::GET, "/api/task-board/tasks/t1"), None);
        assert_eq!(claim_str(Method::GET, "/api/task-board/tasks"), None);
        assert_eq!(claim_str(Method::PUT, "/api/task-board/tasks/t1"), None);
        assert_eq!(
            claim_str(Method::POST, "/api/task-board/tasks/t1/diff/files"),
            None,
            "session-git owns the diff tails"
        );
        assert_eq!(
            claim_str(Method::POST, "/api/task-board/tasks/t1/merge"),
            None,
            "session-git owns merge"
        );
        assert_eq!(
            claim_str(Method::DELETE, "/api/task-board/tasks"),
            None,
            "the bare collection is not a DELETE route"
        );
    }

    #[test]
    fn mark_achieved_does_not_shadow_air() {
        // The literal POST is ours; Air keeps the param GET on the same path.
        assert_eq!(
            claim_str(Method::POST, "/api/air/tasks/mark-achieved"),
            Some(Route::MarkAchievedPost)
        );
        assert_eq!(
            claim_str(Method::GET, "/api/air/tasks/mark-achieved"),
            None,
            "GET /api/air/tasks/:id still belongs to the Air cluster"
        );
        assert_eq!(
            claim_str(Method::GET, "/api/air/tasks/t1"),
            None,
            "Air owns every three-segment GET"
        );
        assert_eq!(
            claim_str(Method::POST, "/api/air/tasks/t1"),
            None,
            "Air has no POST /api/air/tasks/:id; this cluster must not invent one"
        );
        assert_eq!(
            claim_str(Method::POST, "/api/air/tasks"),
            None,
            "the Air create route stays with Air"
        );
        // This cluster's own share is just the POST; Air contributes GET,HEAD
        // and the front door unions them in registration order
        // (`super::OPTIONS_SOURCES`, covered by `app::tests`).
        assert_eq!(allow("/api/air/tasks/mark-achieved"), "POST");
    }

    #[test]
    fn literal_tails_never_swallow_each_other() {
        let post = Method::POST;
        for (tail, route) in [
            ("update", Route::PlanningUpdatePost),
            ("planning", Route::PlanningUpdatePost),
            ("title", Route::PlanningRenamePost),
            ("move", Route::PlanningMovePost),
            ("status", Route::StatusPost),
            ("relocate", Route::RelocatePost),
            ("chat-session", Route::ChatSessionPost),
        ] {
            assert_eq!(
                claim_str(post.clone(), &format!("/api/task-board/tasks/t1/{tail}")),
                Some(route),
                "{tail}"
            );
            assert_eq!(
                allow(&format!("/api/task-board/tasks/t1/{tail}")),
                "POST",
                "{tail}"
            );
            // A two-segment tail is not a task id plus a known tail.
            assert_eq!(
                claim_str(
                    post.clone(),
                    &format!("/api/task-board/tasks/t1/{tail}/extra")
                ),
                None,
                "{tail}/extra"
            );
        }
        assert_eq!(
            claim_str(post.clone(), "/api/task-board/tasks/t1/UPDATE"),
            Some(Route::PlanningUpdatePost),
            "literal segments are case-insensitive like Express"
        );
    }

    #[test]
    fn the_claims_do_not_shadow_task_shell_session_admin_or_quota() {
        for (method, path) in [
            ("GET", "/api/task-shells/sh1"),
            ("POST", "/api/task-shells/sh1/fork"),
            ("GET", "/api/task-board/tasks/t1/diff/files"),
            ("POST", "/api/task-board/tasks/t1/cleanup-worktree"),
            ("GET", "/api/sessions/s1/unattended"),
            ("POST", "/api/sessions/s1/task-separation"),
            ("GET", "/api/pricing/search"),
            ("PUT", "/api/settings/quota-guard"),
        ] {
            let method = Method::from_bytes(method.as_bytes()).unwrap();
            assert_eq!(claim(&method, path), None, "{method} {path}");
            assert_eq!(
                allow_for(path),
                None,
                "OPTIONS {path} must stay with its own cluster"
            );
        }
    }

    #[test]
    fn options_allow_is_the_registration_order_union() {
        assert_eq!(allow("/api/task-board/tasks"), "POST");
        assert_eq!(allow("/api/task-board/tasks/t1/update"), "POST");
        assert_eq!(allow("/api/task-board/tasks/t1"), "DELETE");
        assert_eq!(
            allow("/api/task-board/directories/d1/retention"),
            "GET,HEAD,POST"
        );
        assert_eq!(allow("/api/task-board/search"), "GET,HEAD");
        assert_eq!(allow("/api/search/messages"), "GET,HEAD");
        assert_eq!(allow("/api/task-graph"), "GET,HEAD");
        assert_eq!(allow("/api/settings/task-attribution"), "GET,HEAD");
        assert_eq!(allow_for("/api/task-board/tasks/t1/merge"), None);
        assert_eq!(allow_for("/api/air/tasks/t1"), None);
    }

    #[test]
    fn trailing_slash_and_case_follow_express() {
        assert_eq!(
            claim_str(Method::GET, "/api/task-graph/"),
            Some(Route::TaskGraphGet)
        );
        assert_eq!(claim_str(Method::GET, "/api/task-graph//"), None);
        assert_eq!(
            claim_str(Method::GET, "/API/task-graph"),
            None,
            "the /api/ prefix is case-sensitive"
        );
        assert_eq!(
            claim_str(Method::GET, "/api/TASK-GRAPH"),
            Some(Route::TaskGraphGet),
            "segment literals are case-insensitive"
        );
        assert_eq!(
            claim_str(Method::GET, "/api/task-graph"),
            Some(Route::TaskGraphGet)
        );
        assert_eq!(
            claim_str(Method::GET, "/api/task-board/tasks//update"),
            None,
            "empty segments never match"
        );
    }
}
