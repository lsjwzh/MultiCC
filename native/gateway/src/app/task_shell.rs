//! The task-shell route cluster retired from `src/task-shell/routes.js`:
//!
//! * `GET|HEAD /api/task-shell-tasks/:taskId[/history|/artifacts]`
//! * `POST     /api/task-shell-tasks/:taskId/{fork,messages}`
//! * `GET|HEAD /api/task-shells/config`, `/api/task-shells/:shellId[/chat|/history|/task-index|/artifacts]`
//! * `POST|DELETE /api/task-shells[/:shellId]`
//! * `GET|POST /api/task-shells/:shellId/task-operations[/preview]`
//! * `GET|POST /api/task-operations/:operationId[/cancel|/undo]`
//! * `GET|POST /api/task-shells/:shellId/attribution-decisions[/:decisionId/{accept,dismiss,defer,undo}]`
//! * `POST     /api/task-shells/:shellId/tasks/:taskId/independent-continue`
//! * `GET      /api/task-shells/:shellId/task-continuations`
//! * `GET|POST /api/task-continuations/:continuationId[/apply|/cancel|/retry]`
//! * `GET|POST /api/task-shells/:shellId/relations[/remove]`
//! * `POST     /api/task-shells/:shellId/{links,select-target,tasks/resolve,messages,receipts/:receiptId/retry}`
//! * `GET      /api/task-shells/:shellId/tasks/:taskId`
//! * `GET|POST /api/sessions/:sessionId/{context,task-separation}[/:suggestionId]`
//!
//! Path matching, parameter decoding, query/body extraction and the Express
//! OPTIONS answer live here; the DTO/error rules live in
//! `multicc_core::task_shell`. Node keeps what Rust cannot see behind one host
//! port, `POST /api/__host/task-shell` (src/routes/task-shell-host.js): the
//! SQLite task store, the records Map, WebSocket clients, chat history and the
//! runtime that produces these DTOs.
//!
//! Every write handler awaits one or more host round trips that mutate the
//! durable task store, so [`App::task_shell_write`] serializes them the way the
//! single Node event-loop thread did.

#![allow(clippy::result_large_err)]

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Method, Response};
use multicc_core::http_gate::{query_param, query_value, QueryParam, QueryValue};
use multicc_core::js::serde::truthy;
use multicc_core::task_shell::{
    config_body, error_body, ok_wrap, page_task_history, shell_artifacts_fallback, ErrorFacts,
    PageOptions,
};
use serde_json::{json, Map, Value};

use crate::app::express::{self, RequestCtx};
use crate::app::App;
use crate::host_port;

/// The host port the Node child serves (`src/routes/task-shell-host.js`).
const HOST_PATH: &str = "/api/__host/task-shell";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Route {
    TaskEntryGet,
    TaskHistoryGet,
    TaskArtifactsGet,
    ShellArtifactsGet,
    TaskForkPost,
    TaskMessagePost,
    ConfigGet,
    ContextGet,
    SeparationGet,
    SeparationDecidePost,
    ShellOpenPost,
    ShellViewGet,
    ShellChatGet,
    ShellHistoryGet,
    ShellTaskIndexGet,
    TaskOperationsListGet,
    TaskOperationsPreviewPost,
    TaskOperationsApplyPost,
    TaskOperationsGet,
    TaskOperationsCancelPost,
    TaskOperationsUndoPost,
    AttributionListGet,
    AttributionAcceptPost,
    AttributionDismissPost,
    AttributionDeferPost,
    AttributionUndoPost,
    IndependentRequestPost,
    ContinuationsListGet,
    ContinuationGet,
    ContinuationApplyPost,
    ContinuationCancelPost,
    ContinuationRetryPost,
    RelationsListGet,
    RelationsCreatePost,
    RelationsRemovePost,
    ShellRemoveDelete,
    ShellLinksPost,
    ShellSelectTargetPost,
    TasksResolvePost,
    TaskDetailGet,
    ShellMessagePost,
    ReceiptRetryPost,
    /// Express's automatic OPTIONS: the union of the methods registered on the
    /// exact path, with `HEAD` after each `GET`, in registration order.
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

/// Registration order of the retired `mountTaskShellRoutes`, so a request that
/// matches several layers is answered by the first one Express tried. Only the
/// routes whose `some` deps are always provided by the host are listed; in
/// production host.js supplies every one of them.
static LAYERS: &[Layer] = &[
    Layer {
        segs: &[Lit("task-shell-tasks"), Param],
        method: "GET",
        kind: Route::TaskEntryGet,
    },
    Layer {
        segs: &[Lit("task-shell-tasks"), Param, Lit("history")],
        method: "GET",
        kind: Route::TaskHistoryGet,
    },
    Layer {
        segs: &[Lit("task-shell-tasks"), Param, Lit("artifacts")],
        method: "GET",
        kind: Route::TaskArtifactsGet,
    },
    Layer {
        segs: &[Lit("task-shells"), Param, Lit("artifacts")],
        method: "GET",
        kind: Route::ShellArtifactsGet,
    },
    Layer {
        segs: &[Lit("task-shell-tasks"), Param, Lit("fork")],
        method: "POST",
        kind: Route::TaskForkPost,
    },
    Layer {
        segs: &[Lit("task-shell-tasks"), Param, Lit("messages")],
        method: "POST",
        kind: Route::TaskMessagePost,
    },
    Layer {
        segs: &[Lit("task-shells"), Lit("config")],
        method: "GET",
        kind: Route::ConfigGet,
    },
    Layer {
        segs: &[Lit("sessions"), Param, Lit("context")],
        method: "GET",
        kind: Route::ContextGet,
    },
    Layer {
        segs: &[Lit("sessions"), Param, Lit("task-separation")],
        method: "GET",
        kind: Route::SeparationGet,
    },
    Layer {
        segs: &[Lit("sessions"), Param, Lit("task-separation"), Param],
        method: "POST",
        kind: Route::SeparationDecidePost,
    },
    Layer {
        segs: &[Lit("task-shells")],
        method: "POST",
        kind: Route::ShellOpenPost,
    },
    Layer {
        segs: &[Lit("task-shells"), Param],
        method: "GET",
        kind: Route::ShellViewGet,
    },
    Layer {
        segs: &[Lit("task-shells"), Param, Lit("chat")],
        method: "GET",
        kind: Route::ShellChatGet,
    },
    Layer {
        segs: &[Lit("task-shells"), Param, Lit("history")],
        method: "GET",
        kind: Route::ShellHistoryGet,
    },
    Layer {
        segs: &[Lit("task-shells"), Param, Lit("task-index")],
        method: "GET",
        kind: Route::ShellTaskIndexGet,
    },
    Layer {
        segs: &[Lit("task-shells"), Param, Lit("task-operations")],
        method: "GET",
        kind: Route::TaskOperationsListGet,
    },
    Layer {
        segs: &[
            Lit("task-shells"),
            Param,
            Lit("task-operations"),
            Lit("preview"),
        ],
        method: "POST",
        kind: Route::TaskOperationsPreviewPost,
    },
    Layer {
        segs: &[Lit("task-shells"), Param, Lit("task-operations")],
        method: "POST",
        kind: Route::TaskOperationsApplyPost,
    },
    Layer {
        segs: &[Lit("task-operations"), Param],
        method: "GET",
        kind: Route::TaskOperationsGet,
    },
    Layer {
        segs: &[Lit("task-operations"), Param, Lit("cancel")],
        method: "POST",
        kind: Route::TaskOperationsCancelPost,
    },
    Layer {
        segs: &[Lit("task-operations"), Param, Lit("undo")],
        method: "POST",
        kind: Route::TaskOperationsUndoPost,
    },
    Layer {
        segs: &[Lit("task-shells"), Param, Lit("attribution-decisions")],
        method: "GET",
        kind: Route::AttributionListGet,
    },
    Layer {
        segs: &[
            Lit("task-shells"),
            Param,
            Lit("attribution-decisions"),
            Param,
            Lit("accept"),
        ],
        method: "POST",
        kind: Route::AttributionAcceptPost,
    },
    Layer {
        segs: &[
            Lit("task-shells"),
            Param,
            Lit("attribution-decisions"),
            Param,
            Lit("dismiss"),
        ],
        method: "POST",
        kind: Route::AttributionDismissPost,
    },
    Layer {
        segs: &[
            Lit("task-shells"),
            Param,
            Lit("attribution-decisions"),
            Param,
            Lit("defer"),
        ],
        method: "POST",
        kind: Route::AttributionDeferPost,
    },
    Layer {
        segs: &[
            Lit("task-shells"),
            Param,
            Lit("attribution-decisions"),
            Param,
            Lit("undo"),
        ],
        method: "POST",
        kind: Route::AttributionUndoPost,
    },
    Layer {
        segs: &[
            Lit("task-shells"),
            Param,
            Lit("tasks"),
            Param,
            Lit("independent-continue"),
        ],
        method: "POST",
        kind: Route::IndependentRequestPost,
    },
    Layer {
        segs: &[Lit("task-shells"), Param, Lit("task-continuations")],
        method: "GET",
        kind: Route::ContinuationsListGet,
    },
    Layer {
        segs: &[Lit("task-continuations"), Param],
        method: "GET",
        kind: Route::ContinuationGet,
    },
    Layer {
        segs: &[Lit("task-continuations"), Param, Lit("apply")],
        method: "POST",
        kind: Route::ContinuationApplyPost,
    },
    Layer {
        segs: &[Lit("task-continuations"), Param, Lit("cancel")],
        method: "POST",
        kind: Route::ContinuationCancelPost,
    },
    Layer {
        segs: &[Lit("task-continuations"), Param, Lit("retry")],
        method: "POST",
        kind: Route::ContinuationRetryPost,
    },
    Layer {
        segs: &[Lit("task-shells"), Param, Lit("relations")],
        method: "GET",
        kind: Route::RelationsListGet,
    },
    Layer {
        segs: &[Lit("task-shells"), Param, Lit("relations")],
        method: "POST",
        kind: Route::RelationsCreatePost,
    },
    Layer {
        segs: &[Lit("task-shells"), Param, Lit("relations"), Lit("remove")],
        method: "POST",
        kind: Route::RelationsRemovePost,
    },
    Layer {
        segs: &[Lit("task-shells"), Param],
        method: "DELETE",
        kind: Route::ShellRemoveDelete,
    },
    Layer {
        segs: &[Lit("task-shells"), Param, Lit("links")],
        method: "POST",
        kind: Route::ShellLinksPost,
    },
    Layer {
        segs: &[Lit("task-shells"), Param, Lit("select-target")],
        method: "POST",
        kind: Route::ShellSelectTargetPost,
    },
    Layer {
        segs: &[Lit("task-shells"), Param, Lit("tasks"), Lit("resolve")],
        method: "POST",
        kind: Route::TasksResolvePost,
    },
    Layer {
        segs: &[Lit("task-shells"), Param, Lit("tasks"), Param],
        method: "GET",
        kind: Route::TaskDetailGet,
    },
    Layer {
        segs: &[Lit("task-shells"), Param, Lit("messages")],
        method: "POST",
        kind: Route::ShellMessagePost,
    },
    Layer {
        segs: &[
            Lit("task-shells"),
            Param,
            Lit("receipts"),
            Param,
            Lit("retry"),
        ],
        method: "POST",
        kind: Route::ReceiptRetryPost,
    },
];

/// `/api/<rest>` as segments, one optional trailing slash removed. Express
/// matches literal segments case-insensitively and `:params` as `[^/]+?`.
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
/// methods registered on this exact path, each `GET` followed by `HEAD`.
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
    matched.then(|| methods.join(","))
}

/// This cluster's own share of Express's automatic `OPTIONS` `Allow`, for the
/// front-door union across clusters (`super::OPTIONS_SOURCES`).
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
            "error": "任务板接口尚未就绪，请更新原生模块",
            "code": "rust_backend_unavailable",
        }),
        &[],
    )
}

fn error_facts(answer: &Value) -> ErrorFacts {
    let error = answer.get("error").cloned().unwrap_or(Value::Null);
    ErrorFacts {
        code: error
            .get("code")
            .and_then(Value::as_str)
            .map(str::to_string),
        message: error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        status: error.get("status").and_then(Value::as_i64),
        conflicts: error
            .get("conflicts")
            .filter(|value| value.is_array())
            .cloned(),
        detail: error
            .get("detail")
            .filter(|value| value.is_object() || value.is_array())
            .cloned(),
        receipt_id: error
            .get("receiptId")
            .filter(|value| truthy(value))
            .cloned(),
        task_id: error.get("taskId").cloned(),
        not_delivered: error.get("notDelivered") == Some(&Value::Bool(true)),
    }
}

/// One host round trip. `Ok` is the runtime value; `Err` is the refusal the
/// front door must send (a rendered error envelope, or the 503 when the child
/// is gone).
async fn call(
    ctx: &RequestCtx,
    host_port_num: u16,
    payload: Value,
) -> Result<Value, Response<Body>> {
    match host_port::call(host_port_num, HOST_PATH, &payload).await {
        Ok(answer) => {
            if answer.get("ok") == Some(&Value::Bool(true)) {
                Ok(answer.get("value").cloned().unwrap_or(Value::Null))
            } else {
                let (status, body) = error_body(&error_facts(&answer));
                Err(express::json(ctx, status, &body, &[]))
            }
        }
        Err(_) => Err(unavailable(ctx)),
    }
}

fn finish(ctx: &RequestCtx, result: Result<Value, Response<Body>>) -> Response<Body> {
    match result {
        Ok(value) => express::json(ctx, 200, &value, &[]),
        Err(response) => response,
    }
}

fn finish_wrapped(
    ctx: &RequestCtx,
    key: &str,
    result: Result<Value, Response<Body>>,
) -> Response<Body> {
    finish(ctx, result.map(|value| ok_wrap(key, value)))
}

fn payload(op: &str, fields: Vec<(&str, Value)>) -> Value {
    let mut object = Map::new();
    object.insert("op".into(), Value::String(op.to_string()));
    for (key, value) in fields {
        object.insert(key.to_string(), value);
    }
    Value::Object(object)
}

fn q_text(ctx: &RequestCtx, name: &str) -> Option<String> {
    match query_param(&ctx.original_url, name) {
        QueryParam::Text(text) => Some(text),
        _ => None,
    }
}

fn query_json(value: QueryValue) -> Value {
    match value {
        QueryValue::Missing => Value::Null,
        QueryValue::Text(text) => Value::String(text),
        QueryValue::List(items) => Value::Array(items.into_iter().map(query_json).collect()),
        QueryValue::Object => Value::Object(Map::new()),
    }
}

/// `req.query[name]` for a route that forwards it raw; `None` when absent.
fn q_value(ctx: &RequestCtx, name: &str) -> Option<Value> {
    match query_value(&ctx.original_url, name) {
        QueryValue::Missing => None,
        other => Some(query_json(other)),
    }
}

fn body_field(body: &Value, key: &str) -> Option<Value> {
    body.get(key).cloned()
}

fn body_true(body: &Value, key: &str) -> bool {
    body.get(key) == Some(&Value::Bool(true))
}

fn push_optional(fields: &mut Vec<(&'static str, Value)>, key: &'static str, value: Option<Value>) {
    if let Some(value) = value {
        fields.push((key, value));
    }
}

pub async fn handle(
    app: &Arc<App>,
    route: Route,
    ctx: &RequestCtx,
    body: &Value,
    host_port_num: u16,
) -> Response<Body> {
    let write = matches!(ctx.method.as_str(), "POST" | "DELETE" | "PUT" | "PATCH");
    let _serialized = if write {
        Some(app.task_shell_write.lock().await)
    } else {
        None
    };
    answer(ctx, route, body, host_port_num).await
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
        Route::ConfigGet => express::json(ctx, 200, &config_body(), &[]),
        Route::TaskEntryGet => {
            let id = match decoded(ctx, part(&parts, 1)) {
                Ok(value) => value,
                Err(response) => return response,
            };
            finish(
                ctx,
                call(
                    ctx,
                    host,
                    payload("task-entry", vec![("taskId", json!(id))]),
                )
                .await,
            )
        }
        Route::TaskHistoryGet => {
            let id = match decoded(ctx, part(&parts, 1)) {
                Ok(value) => value,
                Err(response) => return response,
            };
            let entry = match call(
                ctx,
                host,
                payload("task-entry", vec![("taskId", json!(id))]),
            )
            .await
            {
                Ok(value) => value,
                Err(response) => return response,
            };
            let messages = entry.get("messages").cloned().unwrap_or(Value::Null);
            let options = PageOptions {
                limit: q_value(ctx, "limit"),
                around: q_value(ctx, "around"),
                before: q_value(ctx, "before"),
            };
            let mut page = page_task_history(&messages, &options);
            if let (Value::Object(map), Some(entry_map)) = (&mut page, entry.as_object()) {
                for key in ["task", "execution", "readOnly"] {
                    if let Some(value) = entry_map.get(key) {
                        map.insert(key.to_string(), value.clone());
                    }
                }
            }
            express::json(ctx, 200, &page, &[])
        }
        Route::TaskArtifactsGet => {
            let id = match decoded(ctx, part(&parts, 1)) {
                Ok(value) => value,
                Err(response) => return response,
            };
            finish(
                ctx,
                call(ctx, host, payload("artifacts", vec![("taskId", json!(id))])).await,
            )
        }
        Route::ShellArtifactsGet => {
            let shell_id = match decoded(ctx, part(&parts, 1)) {
                Ok(value) => value,
                Err(response) => return response,
            };
            let scope = match call(
                ctx,
                host,
                payload("shell-artifacts-scope", vec![("shellId", json!(shell_id))]),
            )
            .await
            {
                Ok(value) => value,
                Err(response) => return response,
            };
            let task_id = scope.get("taskId").cloned().unwrap_or(Value::Null);
            if truthy(&task_id) {
                finish(
                    ctx,
                    call(ctx, host, payload("artifacts", vec![("taskId", task_id)])).await,
                )
            } else {
                express::json(ctx, 200, &shell_artifacts_fallback(), &[])
            }
        }
        Route::TaskForkPost => {
            let id = match decoded(ctx, part(&parts, 1)) {
                Ok(value) => value,
                Err(response) => return response,
            };
            finish(
                ctx,
                call(
                    ctx,
                    host,
                    payload("fork", vec![("taskId", json!(id)), ("body", body.clone())]),
                )
                .await,
            )
        }
        Route::TaskMessagePost => {
            let id = match decoded(ctx, part(&parts, 1)) {
                Ok(value) => value,
                Err(response) => return response,
            };
            finish(
                ctx,
                call(
                    ctx,
                    host,
                    payload(
                        "task-message",
                        vec![("taskId", json!(id)), ("body", body.clone())],
                    ),
                )
                .await,
            )
        }
        Route::ContextGet => {
            let session_id = match decoded(ctx, part(&parts, 1)) {
                Ok(value) => value,
                Err(response) => return response,
            };
            let mut fields: Vec<(&str, Value)> = vec![
                ("sessionId", json!(session_id)),
                (
                    "includeMessages",
                    json!(q_text(ctx, "include").as_deref() == Some("messages")),
                ),
            ];
            push_optional(&mut fields, "traceId", q_value(ctx, "traceId"));
            finish(ctx, call(ctx, host, payload("context", fields)).await)
        }
        Route::SeparationGet => {
            let session_id = match decoded(ctx, part(&parts, 1)) {
                Ok(value) => value,
                Err(response) => return response,
            };
            let result = call(
                ctx,
                host,
                payload("separation-latest", vec![("sessionId", json!(session_id))]),
            )
            .await;
            finish_wrapped(ctx, "suggestion", result)
        }
        Route::SeparationDecidePost => {
            let session_id = match decoded(ctx, part(&parts, 1)) {
                Ok(value) => value,
                Err(response) => return response,
            };
            let suggestion_id = match decoded(ctx, part(&parts, 3)) {
                Ok(value) => value,
                Err(response) => return response,
            };
            let mut fields: Vec<(&str, Value)> = vec![
                ("sessionId", json!(session_id)),
                ("suggestionId", json!(suggestion_id)),
            ];
            push_optional(&mut fields, "decision", body_field(body, "decision"));
            finish(
                ctx,
                call(ctx, host, payload("separation-decide", fields)).await,
            )
        }
        Route::ShellOpenPost => {
            let mut fields: Vec<(&str, Value)> = Vec::new();
            push_optional(&mut fields, "sessionId", body_field(body, "sessionId"));
            finish(ctx, call(ctx, host, payload("open", fields)).await)
        }
        Route::ShellViewGet => {
            let shell_id = match decoded(ctx, part(&parts, 1)) {
                Ok(value) => value,
                Err(response) => return response,
            };
            finish(
                ctx,
                call(
                    ctx,
                    host,
                    payload("view", vec![("shellId", json!(shell_id))]),
                )
                .await,
            )
        }
        Route::ShellChatGet => {
            let shell_id = match decoded(ctx, part(&parts, 1)) {
                Ok(value) => value,
                Err(response) => return response,
            };
            finish(
                ctx,
                call(
                    ctx,
                    host,
                    payload("chat", vec![("shellId", json!(shell_id))]),
                )
                .await,
            )
        }
        Route::ShellHistoryGet => {
            let shell_id = match decoded(ctx, part(&parts, 1)) {
                Ok(value) => value,
                Err(response) => return response,
            };
            let mut fields: Vec<(&str, Value)> = vec![
                ("shellId", json!(shell_id)),
                (
                    "includeHidden",
                    json!(q_text(ctx, "historyScope").as_deref() == Some("archive")),
                ),
            ];
            push_optional(&mut fields, "before", q_value(ctx, "before"));
            push_optional(&mut fields, "around", q_value(ctx, "around"));
            push_optional(&mut fields, "limit", q_value(ctx, "limit"));
            finish(ctx, call(ctx, host, payload("shell-history", fields)).await)
        }
        Route::ShellTaskIndexGet => {
            let shell_id = match decoded(ctx, part(&parts, 1)) {
                Ok(value) => value,
                Err(response) => return response,
            };
            finish(
                ctx,
                call(
                    ctx,
                    host,
                    payload(
                        "task-index",
                        vec![
                            ("shellId", json!(shell_id)),
                            (
                                "includeEmpty",
                                json!(q_text(ctx, "includeEmpty").as_deref() == Some("1")),
                            ),
                        ],
                    ),
                )
                .await,
            )
        }
        Route::TaskOperationsListGet => {
            let shell_id = match decoded(ctx, part(&parts, 1)) {
                Ok(value) => value,
                Err(response) => return response,
            };
            let result = call(
                ctx,
                host,
                payload("task-operations-list", vec![("shellId", json!(shell_id))]),
            )
            .await;
            finish_wrapped(ctx, "operations", result)
        }
        Route::TaskOperationsPreviewPost => {
            let shell_id = match decoded(ctx, part(&parts, 1)) {
                Ok(value) => value,
                Err(response) => return response,
            };
            let mut fields: Vec<(&str, Value)> = vec![("shellId", json!(shell_id))];
            push_optional(&mut fields, "turns", body_field(body, "turns"));
            push_optional(&mut fields, "range", body_field(body, "range"));
            push_optional(&mut fields, "target", body_field(body, "target"));
            finish(
                ctx,
                call(ctx, host, payload("task-operations-preview", fields)).await,
            )
        }
        Route::TaskOperationsApplyPost => {
            let shell_id = match decoded(ctx, part(&parts, 1)) {
                Ok(value) => value,
                Err(response) => return response,
            };
            let mut fields: Vec<(&str, Value)> = vec![
                ("shellId", json!(shell_id)),
                ("queue", json!(body_true(body, "queue"))),
            ];
            push_optional(&mut fields, "clientMsgId", body_field(body, "clientMsgId"));
            push_optional(
                &mut fields,
                "previewToken",
                body_field(body, "previewToken"),
            );
            push_optional(
                &mut fields,
                "expectedRevision",
                body_field(body, "expectedRevision"),
            );
            push_optional(&mut fields, "turns", body_field(body, "turns"));
            push_optional(&mut fields, "range", body_field(body, "range"));
            push_optional(&mut fields, "target", body_field(body, "target"));
            finish(
                ctx,
                call(ctx, host, payload("task-operations-apply", fields)).await,
            )
        }
        Route::TaskOperationsGet => {
            let operation_id = match decoded(ctx, part(&parts, 1)) {
                Ok(value) => value,
                Err(response) => return response,
            };
            finish(
                ctx,
                call(
                    ctx,
                    host,
                    payload(
                        "task-operations-get",
                        vec![("operationId", json!(operation_id))],
                    ),
                )
                .await,
            )
        }
        Route::TaskOperationsCancelPost | Route::TaskOperationsUndoPost => {
            let operation_id = match decoded(ctx, part(&parts, 1)) {
                Ok(value) => value,
                Err(response) => return response,
            };
            let mut fields: Vec<(&str, Value)> = vec![("operationId", json!(operation_id))];
            push_optional(&mut fields, "clientMsgId", body_field(body, "clientMsgId"));
            let op = if route == Route::TaskOperationsCancelPost {
                "task-operations-cancel"
            } else {
                "task-operations-undo"
            };
            finish(ctx, call(ctx, host, payload(op, fields)).await)
        }
        Route::AttributionListGet => {
            let shell_id = match decoded(ctx, part(&parts, 1)) {
                Ok(value) => value,
                Err(response) => return response,
            };
            let result = call(
                ctx,
                host,
                payload(
                    "attribution-list",
                    vec![
                        ("shellId", json!(shell_id)),
                        (
                            "includeHidden",
                            json!(q_text(ctx, "includeHidden").as_deref() == Some("1")),
                        ),
                    ],
                ),
            )
            .await;
            finish_wrapped(ctx, "decisions", result)
        }
        Route::AttributionAcceptPost
        | Route::AttributionDismissPost
        | Route::AttributionDeferPost
        | Route::AttributionUndoPost => {
            let shell_id = match decoded(ctx, part(&parts, 1)) {
                Ok(value) => value,
                Err(response) => return response,
            };
            let decision_id = match decoded(ctx, part(&parts, 3)) {
                Ok(value) => value,
                Err(response) => return response,
            };
            let mut fields: Vec<(&str, Value)> = vec![
                ("shellId", json!(shell_id)),
                ("decisionId", json!(decision_id)),
            ];
            let op = match route {
                Route::AttributionAcceptPost => {
                    push_optional(&mut fields, "clientMsgId", body_field(body, "clientMsgId"));
                    "attribution-accept"
                }
                Route::AttributionDismissPost => "attribution-dismiss",
                Route::AttributionDeferPost => "attribution-defer",
                _ => "attribution-undo",
            };
            finish(ctx, call(ctx, host, payload(op, fields)).await)
        }
        Route::IndependentRequestPost => {
            let shell_id = match decoded(ctx, part(&parts, 1)) {
                Ok(value) => value,
                Err(response) => return response,
            };
            let task_id = match decoded(ctx, part(&parts, 3)) {
                Ok(value) => value,
                Err(response) => return response,
            };
            let mut fields: Vec<(&str, Value)> =
                vec![("shellId", json!(shell_id)), ("taskId", json!(task_id))];
            push_optional(&mut fields, "clientMsgId", body_field(body, "clientMsgId"));
            finish(
                ctx,
                call(ctx, host, payload("independent-request", fields)).await,
            )
        }
        Route::ContinuationsListGet => {
            let shell_id = match decoded(ctx, part(&parts, 1)) {
                Ok(value) => value,
                Err(response) => return response,
            };
            let result = call(
                ctx,
                host,
                payload("independent-list", vec![("shellId", json!(shell_id))]),
            )
            .await;
            finish_wrapped(ctx, "continuations", result)
        }
        Route::ContinuationGet
        | Route::ContinuationApplyPost
        | Route::ContinuationCancelPost
        | Route::ContinuationRetryPost => {
            let continuation_id = match decoded(ctx, part(&parts, 1)) {
                Ok(value) => value,
                Err(response) => return response,
            };
            let op = match route {
                Route::ContinuationGet => "independent-get",
                Route::ContinuationApplyPost => "independent-apply",
                Route::ContinuationCancelPost => "independent-cancel",
                _ => "independent-retry",
            };
            finish(
                ctx,
                call(
                    ctx,
                    host,
                    payload(op, vec![("continuationId", json!(continuation_id))]),
                )
                .await,
            )
        }
        Route::RelationsListGet => {
            let shell_id = match decoded(ctx, part(&parts, 1)) {
                Ok(value) => value,
                Err(response) => return response,
            };
            let result = call(
                ctx,
                host,
                payload("relations-list", vec![("shellId", json!(shell_id))]),
            )
            .await;
            finish_wrapped(ctx, "relations", result)
        }
        Route::RelationsCreatePost => {
            let shell_id = match decoded(ctx, part(&parts, 1)) {
                Ok(value) => value,
                Err(response) => return response,
            };
            let mut fields: Vec<(&str, Value)> = vec![("shellId", json!(shell_id))];
            push_optional(&mut fields, "kind", body_field(body, "kind"));
            push_optional(&mut fields, "fromTaskId", body_field(body, "fromTaskId"));
            push_optional(&mut fields, "toTaskId", body_field(body, "toTaskId"));
            push_optional(&mut fields, "clientMsgId", body_field(body, "clientMsgId"));
            finish(
                ctx,
                call(ctx, host, payload("relations-create", fields)).await,
            )
        }
        Route::RelationsRemovePost => {
            let shell_id = match decoded(ctx, part(&parts, 1)) {
                Ok(value) => value,
                Err(response) => return response,
            };
            let mut fields: Vec<(&str, Value)> = vec![("shellId", json!(shell_id))];
            push_optional(&mut fields, "relationId", body_field(body, "relationId"));
            push_optional(&mut fields, "clientMsgId", body_field(body, "clientMsgId"));
            finish(
                ctx,
                call(ctx, host, payload("relations-remove", fields)).await,
            )
        }
        Route::ShellRemoveDelete => {
            let shell_id = match decoded(ctx, part(&parts, 1)) {
                Ok(value) => value,
                Err(response) => return response,
            };
            finish(
                ctx,
                call(
                    ctx,
                    host,
                    payload("remove-shell", vec![("shellId", json!(shell_id))]),
                )
                .await,
            )
        }
        Route::ShellLinksPost => {
            let shell_id = match decoded(ctx, part(&parts, 1)) {
                Ok(value) => value,
                Err(response) => return response,
            };
            let mut fields: Vec<(&str, Value)> = vec![("shellId", json!(shell_id))];
            push_optional(&mut fields, "taskId", body_field(body, "taskId"));
            finish(ctx, call(ctx, host, payload("links", fields)).await)
        }
        Route::ShellSelectTargetPost => {
            let shell_id = match decoded(ctx, part(&parts, 1)) {
                Ok(value) => value,
                Err(response) => return response,
            };
            let mut fields: Vec<(&str, Value)> = vec![("shellId", json!(shell_id))];
            push_optional(&mut fields, "taskId", body_field(body, "taskId"));
            push_optional(
                &mut fields,
                "expectedCursorVersion",
                body_field(body, "expectedCursorVersion"),
            );
            finish(ctx, call(ctx, host, payload("select-target", fields)).await)
        }
        Route::TasksResolvePost => {
            let shell_id = match decoded(ctx, part(&parts, 1)) {
                Ok(value) => value,
                Err(response) => return response,
            };
            let mut fields: Vec<(&str, Value)> = vec![("shellId", json!(shell_id))];
            push_optional(&mut fields, "taskId", body_field(body, "taskId"));
            push_optional(&mut fields, "taskText", body_field(body, "taskText"));
            push_optional(&mut fields, "title", body_field(body, "title"));
            finish(ctx, call(ctx, host, payload("tasks-resolve", fields)).await)
        }
        Route::TaskDetailGet => {
            let shell_id = match decoded(ctx, part(&parts, 1)) {
                Ok(value) => value,
                Err(response) => return response,
            };
            let task_id = match decoded(ctx, part(&parts, 3)) {
                Ok(value) => value,
                Err(response) => return response,
            };
            finish(
                ctx,
                call(
                    ctx,
                    host,
                    payload(
                        "detail",
                        vec![("shellId", json!(shell_id)), ("taskId", json!(task_id))],
                    ),
                )
                .await,
            )
        }
        Route::ShellMessagePost => {
            let shell_id = match decoded(ctx, part(&parts, 1)) {
                Ok(value) => value,
                Err(response) => return response,
            };
            finish(
                ctx,
                call(
                    ctx,
                    host,
                    payload(
                        "shell-message",
                        vec![("shellId", json!(shell_id)), ("body", body.clone())],
                    ),
                )
                .await,
            )
        }
        Route::ReceiptRetryPost => {
            let shell_id = match decoded(ctx, part(&parts, 1)) {
                Ok(value) => value,
                Err(response) => return response,
            };
            let receipt_id = match decoded(ctx, part(&parts, 3)) {
                Ok(value) => value,
                Err(response) => return response,
            };
            finish(
                ctx,
                call(
                    ctx,
                    host,
                    payload(
                        "receipt-retry",
                        vec![
                            ("shellId", json!(shell_id)),
                            ("receiptId", json!(receipt_id)),
                        ],
                    ),
                )
                .await,
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allow(path: &str) -> String {
        allow_for(path).unwrap()
    }

    #[test]
    fn claims_match_the_retired_express_routes() {
        assert_eq!(
            claim(&Method::GET, "/api/task-shell-tasks/t1"),
            Some(Route::TaskEntryGet)
        );
        assert_eq!(
            claim(&Method::GET, "/api/task-shell-tasks/t1/history"),
            Some(Route::TaskHistoryGet)
        );
        assert_eq!(
            claim(&Method::GET, "/api/task-shell-tasks/t1/artifacts"),
            Some(Route::TaskArtifactsGet)
        );
        assert_eq!(
            claim(&Method::GET, "/api/task-shells/sh1/artifacts"),
            Some(Route::ShellArtifactsGet)
        );
        assert_eq!(
            claim(&Method::POST, "/api/task-shell-tasks/t1/fork"),
            Some(Route::TaskForkPost)
        );
        assert_eq!(
            claim(&Method::POST, "/api/task-shell-tasks/t1/messages"),
            Some(Route::TaskMessagePost)
        );
        assert_eq!(
            claim(&Method::GET, "/api/task-shells/config"),
            Some(Route::ConfigGet)
        );
        assert_eq!(
            claim(&Method::GET, "/api/sessions/s1/context"),
            Some(Route::ContextGet)
        );
        assert_eq!(
            claim(&Method::GET, "/api/sessions/s1/task-separation"),
            Some(Route::SeparationGet)
        );
        assert_eq!(
            claim(&Method::POST, "/api/sessions/s1/task-separation/g1"),
            Some(Route::SeparationDecidePost)
        );
        assert_eq!(
            claim(&Method::POST, "/api/task-shells"),
            Some(Route::ShellOpenPost)
        );
        assert_eq!(
            claim(&Method::GET, "/api/task-shells/sh1"),
            Some(Route::ShellViewGet)
        );
        assert_eq!(
            claim(&Method::DELETE, "/api/task-shells/sh1"),
            Some(Route::ShellRemoveDelete)
        );
        assert_eq!(
            claim(&Method::GET, "/api/task-shells/sh1/task-operations"),
            Some(Route::TaskOperationsListGet)
        );
        assert_eq!(
            claim(&Method::POST, "/api/task-shells/sh1/task-operations"),
            Some(Route::TaskOperationsApplyPost)
        );
        assert_eq!(
            claim(
                &Method::POST,
                "/api/task-shells/sh1/task-operations/preview"
            ),
            Some(Route::TaskOperationsPreviewPost)
        );
        assert_eq!(
            claim(&Method::GET, "/api/task-operations/o1"),
            Some(Route::TaskOperationsGet)
        );
        assert_eq!(
            claim(&Method::POST, "/api/task-operations/o1/cancel"),
            Some(Route::TaskOperationsCancelPost)
        );
        assert_eq!(
            claim(
                &Method::POST,
                "/api/task-shells/sh1/attribution-decisions/d1/accept"
            ),
            Some(Route::AttributionAcceptPost)
        );
        assert_eq!(
            claim(
                &Method::POST,
                "/api/task-shells/sh1/tasks/t1/independent-continue"
            ),
            Some(Route::IndependentRequestPost)
        );
        assert_eq!(
            claim(&Method::GET, "/api/task-shells/sh1/task-continuations"),
            Some(Route::ContinuationsListGet)
        );
        assert_eq!(
            claim(&Method::GET, "/api/task-continuations/c1"),
            Some(Route::ContinuationGet)
        );
        assert_eq!(
            claim(&Method::POST, "/api/task-continuations/c1/retry"),
            Some(Route::ContinuationRetryPost)
        );
        assert_eq!(
            claim(&Method::GET, "/api/task-shells/sh1/relations"),
            Some(Route::RelationsListGet)
        );
        assert_eq!(
            claim(&Method::POST, "/api/task-shells/sh1/relations/remove"),
            Some(Route::RelationsRemovePost)
        );
        assert_eq!(
            claim(&Method::POST, "/api/task-shells/sh1/tasks/resolve"),
            Some(Route::TasksResolvePost)
        );
        assert_eq!(
            claim(&Method::GET, "/api/task-shells/sh1/tasks/t1"),
            Some(Route::TaskDetailGet)
        );
        assert_eq!(
            claim(&Method::POST, "/api/task-shells/sh1/messages"),
            Some(Route::ShellMessagePost)
        );
        assert_eq!(
            claim(&Method::POST, "/api/task-shells/sh1/receipts/r1/retry"),
            Some(Route::ReceiptRetryPost)
        );
    }

    #[test]
    fn first_match_and_case_follow_express() {
        // GET on the resolve path is answered by `tasks/:taskId` (layer 40).
        assert_eq!(
            claim(&Method::GET, "/api/task-shells/sh1/tasks/resolve"),
            Some(Route::TaskDetailGet)
        );
        // POST matches the literal resolve layer first.
        assert_eq!(
            claim(&Method::POST, "/api/task-shells/sh1/tasks/resolve"),
            Some(Route::TasksResolvePost)
        );
        // A non-resolve POST task path is not a route.
        assert_eq!(claim(&Method::POST, "/api/task-shells/sh1/tasks/t1"), None);
        // Literal config beats the `:shellId` param layer.
        assert_eq!(
            claim(&Method::GET, "/api/Task-Shells/CONFIG"),
            Some(Route::ConfigGet)
        );
        // HEAD is handled by the GET layer.
        assert_eq!(
            claim(&Method::HEAD, "/api/task-shells/sh1/chat"),
            Some(Route::ShellChatGet)
        );
        // Neighbouring shapes stay with Node.
        assert_eq!(claim(&Method::GET, "/api/task-shells"), None);
        assert_eq!(claim(&Method::GET, "/api/task-shells/sh1/tasks"), None);
        assert_eq!(claim(&Method::GET, "/api/git/log"), None);
    }

    #[test]
    fn options_allow_is_the_registration_order_union() {
        assert_eq!(allow("/api/task-shells/config"), "GET,HEAD,DELETE");
        assert_eq!(allow("/api/task-shells/sh1"), "GET,HEAD,DELETE");
        assert_eq!(
            allow("/api/task-shells/sh1/task-operations"),
            "GET,HEAD,POST"
        );
        assert_eq!(allow("/api/task-shells/sh1/relations"), "GET,HEAD,POST");
        assert_eq!(allow("/api/task-shells/sh1/tasks/resolve"), "POST,GET,HEAD");
        assert_eq!(allow("/api/task-shells/sh1/tasks/abc"), "GET,HEAD");
        assert_eq!(allow("/api/task-shells/sh1/messages"), "POST");
        assert_eq!(allow("/api/task-shells/sh1/chat"), "GET,HEAD");
        assert_eq!(allow("/api/task-operations/o1"), "GET,HEAD");
        assert_eq!(
            claim(&Method::OPTIONS, "/api/task-shells/sh1/chat"),
            Some(Route::Options)
        );
        assert_eq!(claim(&Method::OPTIONS, "/api/git/log"), None);
    }

    #[test]
    fn trailing_slash_and_missing_api_prefix() {
        assert_eq!(
            claim(&Method::GET, "/api/task-shell-tasks/t1/"),
            Some(Route::TaskEntryGet)
        );
        assert_eq!(claim(&Method::GET, "/api/"), None);
        assert_eq!(claim(&Method::GET, "/task-shells/sh1"), None);
    }
}
