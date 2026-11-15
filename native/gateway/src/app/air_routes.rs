//! The Air task-board route cluster retired from `src/workspace/air-routes.js`:
//!
//! * `GET|HEAD /api/air`
//! * `POST     /api/air/worktrees/reclaim`
//! * `GET|HEAD /api/air/resolve`
//! * `POST     /api/air/tasks`
//! * `GET|HEAD /api/air/tasks/:id`
//! * `GET|HEAD /api/air/tasks/:id/open`
//! * `POST     /api/air/tasks/:id/delivery/reconcile`
//! * `POST     /api/air/tasks/:id/roles`
//! * `GET|HEAD /api/air/pins` / `POST /api/air/pins` / `POST /api/air/pins/toggle`
//! * `GET|HEAD /api/air/todos` / `POST /api/air/todos` / `POST /api/air/todos/toggle`
//! * `POST     /api/air/todos/ignore`
//!
//! Path matching, parameter decoding, query/body extraction, the Express OPTIONS
//! answer and the conditional-request (ETag → 304) decision live here; the DTO
//! and error rules live in `multicc_core::air_routes`. Node keeps what Rust
//! cannot see behind one host port, `POST /api/__host/air`
//! (src/workspace/air-routes-host.js): the board/records Maps, the card cache
//! and snapshot assembly, the task-shell runtime, worktree reclaim
//! subprocesses, the pins/todos/ignore state files and the live-sync
//! broadcaster.
//!
//! `GET /api/air` and `GET /api/air/tasks/:id` are the only conditional reads:
//! Node serializes the body and derives the weak ETag (`W/"<sha1 base64url>"`,
//! or the summary's cached tag), and this module forwards both byte for byte —
//! the snapshot is a 4s hot path and must not be copied or re-serialized here.
//!
//! Every write handler awaits one host round trip that mutates a state file,
//! the task store or a worktree, so [`App::air_write`] serializes them the way
//! the single Node event-loop thread did.

#![allow(clippy::result_large_err)]

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Method, Response};
use multicc_core::air_routes::{
    conditional_matches, error_body, hibernation_unavailable, ok_field, reclaim_body, resolve_body,
    spread_ok, task_ids_required, ErrorFacts,
};
use multicc_core::http_gate::{query_value, QueryValue};
use multicc_core::js::serde::{js_string, truthy};
use serde_json::{json, Map, Value};

use crate::app::express::{self, RequestCtx};
use crate::app::App;
use crate::host_port;

/// The host port the Node child serves (`src/workspace/air-routes-host.js`).
const HOST_PATH: &str = "/api/__host/air";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Route {
    SnapshotGet,
    ReclaimPost,
    ResolveGet,
    TasksPost,
    TaskDetailGet,
    TaskOpenGet,
    ReconcilePost,
    RolesPost,
    PinsGet,
    PinsPost,
    PinsTogglePost,
    TodosGet,
    TodosPost,
    TodosTogglePost,
    TodosIgnorePost,
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

/// Registration order of the retired `mountAirRoutes`, so a request that
/// matches several layers is answered by the first one Express tried.
static LAYERS: &[Layer] = &[
    Layer {
        segs: &[Lit("air")],
        method: "GET",
        kind: Route::SnapshotGet,
    },
    Layer {
        segs: &[Lit("air"), Lit("worktrees"), Lit("reclaim")],
        method: "POST",
        kind: Route::ReclaimPost,
    },
    Layer {
        segs: &[Lit("air"), Lit("resolve")],
        method: "GET",
        kind: Route::ResolveGet,
    },
    Layer {
        segs: &[Lit("air"), Lit("tasks")],
        method: "POST",
        kind: Route::TasksPost,
    },
    Layer {
        segs: &[Lit("air"), Lit("tasks"), Param],
        method: "GET",
        kind: Route::TaskDetailGet,
    },
    Layer {
        segs: &[Lit("air"), Lit("tasks"), Param, Lit("open")],
        method: "GET",
        kind: Route::TaskOpenGet,
    },
    Layer {
        segs: &[
            Lit("air"),
            Lit("tasks"),
            Param,
            Lit("delivery"),
            Lit("reconcile"),
        ],
        method: "POST",
        kind: Route::ReconcilePost,
    },
    Layer {
        segs: &[Lit("air"), Lit("tasks"), Param, Lit("roles")],
        method: "POST",
        kind: Route::RolesPost,
    },
    Layer {
        segs: &[Lit("air"), Lit("pins")],
        method: "GET",
        kind: Route::PinsGet,
    },
    Layer {
        segs: &[Lit("air"), Lit("pins")],
        method: "POST",
        kind: Route::PinsPost,
    },
    Layer {
        segs: &[Lit("air"), Lit("pins"), Lit("toggle")],
        method: "POST",
        kind: Route::PinsTogglePost,
    },
    Layer {
        segs: &[Lit("air"), Lit("todos")],
        method: "GET",
        kind: Route::TodosGet,
    },
    Layer {
        segs: &[Lit("air"), Lit("todos")],
        method: "POST",
        kind: Route::TodosPost,
    },
    Layer {
        segs: &[Lit("air"), Lit("todos"), Lit("toggle")],
        method: "POST",
        kind: Route::TodosTogglePost,
    },
    Layer {
        segs: &[Lit("air"), Lit("todos"), Lit("ignore")],
        method: "POST",
        kind: Route::TodosIgnorePost,
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
            "error": "首页接口尚未就绪，请更新原生模块",
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
        status: error.get("status").and_then(Value::as_i64),
        message: error
            .get("message")
            .and_then(Value::as_str)
            .map(str::to_string),
    }
}

/// One host round trip. `Ok` is the runtime value; `Err` is the refusal the
/// front door must send: the rendered error envelope with the route's own
/// default code / message rule, or the 503 when the child is gone.
async fn call(
    ctx: &RequestCtx,
    host_port_num: u16,
    payload: Value,
    default_code: &str,
    generic_message: bool,
) -> Result<Value, Response<Body>> {
    match host_port::call(host_port_num, HOST_PATH, &payload).await {
        Ok(answer) => {
            if answer.get("ok") == Some(&Value::Bool(true)) {
                Ok(answer.get("value").cloned().unwrap_or(Value::Null))
            } else {
                let (status, body) =
                    error_body(default_code, generic_message, &error_facts(&answer));
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

/// `conditionalBody`: the host already produced `{ body, etag }`; this decides
/// 200 vs 304 and forwards the exact bytes and tag.
fn conditional(ctx: &RequestCtx, result: Result<Value, Response<Body>>) -> Response<Body> {
    let value = match result {
        Ok(value) => value,
        Err(response) => return response,
    };
    let body = value.get("body").and_then(Value::as_str).unwrap_or("");
    let etag = value.get("etag").and_then(Value::as_str).unwrap_or("");
    let header = ctx.headers.get("if-none-match");
    let status = if conditional_matches(header, etag) {
        304
    } else {
        200
    };
    express::send_with_etag(
        ctx,
        status,
        "application/json; charset=utf-8",
        body.as_bytes().to_vec(),
        &[],
        etag,
    )
}

fn payload(op: &str, fields: Vec<(&str, Value)>) -> Value {
    let mut object = Map::new();
    object.insert("op".into(), Value::String(op.to_string()));
    for (key, value) in fields {
        object.insert(key.to_string(), value);
    }
    Value::Object(object)
}

fn query_json(value: QueryValue) -> Value {
    match value {
        QueryValue::Missing => Value::Null,
        QueryValue::Text(text) => Value::String(text),
        QueryValue::List(items) => Value::Array(items.into_iter().map(query_json).collect()),
        QueryValue::Object => Value::Object(Map::new()),
    }
}

/// `req.query[name]`; `None` when absent so the host sees `undefined`, like the
/// retired `req.query`.
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

/// `Array.isArray(req.body.taskIds)` — the one decision the front door makes
/// without asking Node.
fn task_ids_array(body: &Value) -> Option<Vec<Value>> {
    match body.get("taskIds") {
        Some(Value::Array(items)) => Some(items.clone()),
        _ => None,
    }
}

pub async fn handle(
    app: &Arc<App>,
    route: Route,
    ctx: &RequestCtx,
    body: &Value,
    host_port_num: u16,
) -> Response<Body> {
    let write = ctx.method == Method::POST;
    let _serialized = if write {
        Some(app.air_write.lock().await)
    } else {
        None
    };
    answer(ctx, route, body, host_port_num).await
}

async fn answer(ctx: &RequestCtx, route: Route, body: &Value, host: u16) -> Response<Body> {
    let parts = segments(&ctx.path).unwrap_or_default();
    // The retired catch arm: `error.code || 'air_request_failed'` with the
    // thrown message only when `error.status` was truthy.
    const AIR: &str = "air_request_failed";
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
        Route::SnapshotGet => {
            let mut fields = Vec::new();
            push_optional(
                &mut fields,
                "ifNoneMatch",
                ctx.headers
                    .get("if-none-match")
                    .map(|value| Value::String(value.to_string())),
            );
            conditional(
                ctx,
                call(ctx, host, payload("snapshot", fields), AIR, false).await,
            )
        }
        Route::ReclaimPost => {
            let dir_id = body_field(body, "dirId")
                .filter(truthy)
                .map(|value| js_string(&value));
            let force = body_true(body, "force");
            let result = call(
                ctx,
                host,
                payload(
                    "reclaim",
                    vec![
                        (
                            "dirId",
                            dir_id
                                .as_deref()
                                .map(|value| Value::String(value.to_string()))
                                .unwrap_or(Value::Null),
                        ),
                        ("force", Value::Bool(force)),
                    ],
                ),
                AIR,
                false,
            )
            .await;
            let value = match result {
                Ok(value) => value,
                Err(response) => return response,
            };
            if value.get("kind").and_then(Value::as_str) == Some("unavailable") {
                return express::json(ctx, 200, &hibernation_unavailable(), &[]);
            }
            let reclaimed = value.get("result").cloned().unwrap_or(Value::Null);
            express::json(ctx, 200, &reclaim_body(&reclaimed, dir_id.as_deref()), &[])
        }
        Route::ResolveGet => {
            let mut fields = Vec::new();
            push_optional(&mut fields, "task", q_value(ctx, "task"));
            push_optional(&mut fields, "session", q_value(ctx, "session"));
            push_optional(&mut fields, "shell", q_value(ctx, "shell"));
            let value = match call(ctx, host, payload("resolve", fields), AIR, false).await {
                Ok(value) => value,
                Err(response) => return response,
            };
            let task_id = value.get("taskId").cloned().unwrap_or(Value::Null);
            let dir_id = value.get("dirId").cloned().unwrap_or(Value::Null);
            express::json(ctx, 200, &resolve_body(&task_id, &dir_id), &[])
        }
        Route::TasksPost => finish(
            ctx,
            call(
                ctx,
                host,
                payload("create-task", vec![("body", body.clone())]),
                AIR,
                false,
            )
            .await,
        ),
        Route::TaskDetailGet => {
            let id = match decoded(ctx, part(&parts, 2)) {
                Ok(value) => value,
                Err(response) => return response,
            };
            conditional(
                ctx,
                call(
                    ctx,
                    host,
                    payload("task-detail", vec![("taskId", json!(id))]),
                    AIR,
                    false,
                )
                .await,
            )
        }
        Route::TaskOpenGet => {
            let id = match decoded(ctx, part(&parts, 2)) {
                Ok(value) => value,
                Err(response) => return response,
            };
            finish(
                ctx,
                call(
                    ctx,
                    host,
                    payload("task-open", vec![("taskId", json!(id))]),
                    AIR,
                    false,
                )
                .await,
            )
        }
        Route::ReconcilePost => {
            let id = match decoded(ctx, part(&parts, 2)) {
                Ok(value) => value,
                Err(response) => return response,
            };
            finish(
                ctx,
                call(
                    ctx,
                    host,
                    payload("reconcile", vec![("taskId", json!(id))]),
                    AIR,
                    false,
                )
                .await
                .map(|value| ok_field("publications", value)),
            )
        }
        Route::RolesPost => {
            let id = match decoded(ctx, part(&parts, 2)) {
                Ok(value) => value,
                Err(response) => return response,
            };
            finish(
                ctx,
                call(
                    ctx,
                    host,
                    payload("roles", vec![("taskId", json!(id)), ("body", body.clone())]),
                    AIR,
                    false,
                )
                .await
                .map(|value| ok_field("roleBindings", value)),
            )
        }
        Route::PinsGet => finish(
            ctx,
            call(ctx, host, payload("pins-read", vec![]), AIR, false)
                .await
                .map(|value| ok_field("taskIds", value)),
        ),
        Route::PinsPost => match task_ids_array(body) {
            Some(items) => finish(
                ctx,
                call(
                    ctx,
                    host,
                    payload("pins-replace", vec![("taskIds", Value::Array(items))]),
                    "pin_failed",
                    true,
                )
                .await
                .map(|value| ok_field("taskIds", value)),
            ),
            None => {
                let (status, value) = task_ids_required();
                express::json(ctx, status, &value, &[])
            }
        },
        Route::PinsTogglePost => finish(
            ctx,
            call(
                ctx,
                host,
                payload(
                    "pins-toggle",
                    vec![("taskId", body.get("taskId").cloned().unwrap_or(Value::Null))],
                ),
                "pin_failed",
                false,
            )
            .await
            .map(|value| ok_field("taskIds", value)),
        ),
        Route::TodosGet => finish(
            ctx,
            call(ctx, host, payload("todos-read", vec![]), AIR, false)
                .await
                .map(|value| ok_field("taskIds", value)),
        ),
        Route::TodosPost => match task_ids_array(body) {
            Some(items) => finish(
                ctx,
                call(
                    ctx,
                    host,
                    payload("todos-replace", vec![("taskIds", Value::Array(items))]),
                    "todo_failed",
                    true,
                )
                .await
                .map(|value| ok_field("taskIds", value)),
            ),
            None => {
                let (status, value) = task_ids_required();
                express::json(ctx, status, &value, &[])
            }
        },
        Route::TodosTogglePost => finish(
            ctx,
            call(
                ctx,
                host,
                payload(
                    "todos-toggle",
                    vec![("taskId", body.get("taskId").cloned().unwrap_or(Value::Null))],
                ),
                "todo_failed",
                false,
            )
            .await
            .map(|value| ok_field("taskIds", value)),
        ),
        Route::TodosIgnorePost => finish(
            ctx,
            call(
                ctx,
                host,
                payload(
                    "todos-ignore",
                    vec![("taskId", body.get("taskId").cloned().unwrap_or(Value::Null))],
                ),
                "todo_ignore_failed",
                false,
            )
            .await
            .map(|value| spread_ok(&value)),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allow(path: &str) -> String {
        allow_for(path).unwrap_or_else(|| panic!("no layer matches {path}"))
    }

    #[test]
    fn claims_match_the_retired_express_routes() {
        let get = Method::GET;
        let post = Method::POST;
        assert_eq!(claim(&get, "/api/air"), Some(Route::SnapshotGet));
        assert_eq!(claim(&Method::HEAD, "/api/air"), Some(Route::SnapshotGet));
        assert_eq!(
            claim(&post, "/api/air/worktrees/reclaim"),
            Some(Route::ReclaimPost)
        );
        assert_eq!(claim(&get, "/api/air/resolve"), Some(Route::ResolveGet));
        assert_eq!(claim(&post, "/api/air/tasks"), Some(Route::TasksPost));
        assert_eq!(
            claim(&get, "/api/air/tasks/tsk_1"),
            Some(Route::TaskDetailGet)
        );
        assert_eq!(
            claim(&get, "/api/air/tasks/tsk_1/open"),
            Some(Route::TaskOpenGet)
        );
        assert_eq!(
            claim(&post, "/api/air/tasks/tsk_1/delivery/reconcile"),
            Some(Route::ReconcilePost)
        );
        assert_eq!(
            claim(&post, "/api/air/tasks/tsk_1/roles"),
            Some(Route::RolesPost)
        );
        assert_eq!(claim(&get, "/api/air/pins"), Some(Route::PinsGet));
        assert_eq!(claim(&post, "/api/air/pins"), Some(Route::PinsPost));
        assert_eq!(
            claim(&post, "/api/air/pins/toggle"),
            Some(Route::PinsTogglePost)
        );
        assert_eq!(claim(&get, "/api/air/todos"), Some(Route::TodosGet));
        assert_eq!(claim(&post, "/api/air/todos"), Some(Route::TodosPost));
        assert_eq!(
            claim(&post, "/api/air/todos/toggle"),
            Some(Route::TodosTogglePost)
        );
        assert_eq!(
            claim(&post, "/api/air/todos/ignore"),
            Some(Route::TodosIgnorePost)
        );
        assert_eq!(claim(&Method::OPTIONS, "/api/air"), Some(Route::Options));
    }

    #[test]
    fn the_sync_and_page_routes_stay_in_node() {
        for path in ["/api/air/sync", "/api/air/page"] {
            assert_eq!(claim(&Method::GET, path), None, "{path}");
            assert_eq!(claim(&Method::OPTIONS, path), None, "{path}");
        }
        assert_eq!(claim(&Method::DELETE, "/api/air"), None);
        assert_eq!(claim(&Method::PUT, "/api/air/pins"), None);
    }

    #[test]
    fn first_match_and_case_follow_express() {
        assert_eq!(
            claim(&Method::GET, "/API/AIR"),
            None,
            "the /api/ prefix is case-sensitive"
        );
        assert_eq!(
            claim(&Method::GET, "/api/AIR/tasks/x"),
            Some(Route::TaskDetailGet)
        );
        assert_eq!(
            claim(&Method::GET, "/api/air/tasks/x/OPEN"),
            Some(Route::TaskOpenGet)
        );
        assert_eq!(
            claim(&Method::GET, "/api/air/tasks//open"),
            None,
            "empty segments never match"
        );
    }

    #[test]
    fn options_allow_is_the_registration_order_union() {
        assert_eq!(allow("/api/air"), "GET,HEAD");
        assert_eq!(allow("/api/air/tasks/tsk_1"), "GET,HEAD");
        assert_eq!(allow("/api/air/worktrees/reclaim"), "POST");
        assert_eq!(allow("/api/air/tasks"), "POST");
        assert_eq!(allow("/api/air/pins"), "GET,HEAD,POST");
        assert_eq!(allow("/api/air/todos"), "GET,HEAD,POST");
        assert_eq!(allow("/api/air/pins/toggle"), "POST");
        assert_eq!(allow("/api/air/todos/ignore"), "POST");
        assert_eq!(allow_for("/api/air/sync"), None);
    }

    #[test]
    fn trailing_slash_is_tolerated_once_like_express() {
        assert_eq!(claim(&Method::GET, "/api/air/"), Some(Route::SnapshotGet));
        assert_eq!(claim(&Method::GET, "/api/air//"), None);
        assert_eq!(claim(&Method::GET, "/air"), None);
    }

    #[test]
    fn task_ids_array_requires_a_real_array() {
        assert_eq!(
            task_ids_array(&json!({"taskIds": ["a", "b"]})),
            Some(vec![json!("a"), json!("b")])
        );
        assert_eq!(task_ids_array(&json!({"taskIds": "a"})), None);
        assert_eq!(task_ids_array(&json!({"taskIds": null})), None);
        assert_eq!(task_ids_array(&json!({})), None);
        assert_eq!(task_ids_array(&json!([1, 2])), None);
        assert_eq!(task_ids_array(&Value::Null), None);
    }
}
