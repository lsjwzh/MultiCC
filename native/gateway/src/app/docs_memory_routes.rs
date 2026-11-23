//! The docs / memory / memo / directory-event route cluster retired from four
//! Node modules:
//!
//! * `src/docs-registry.js` — `GET|POST /api/docs-registry`,
//!   `PATCH|DELETE /api/docs-registry/:id`,
//!   `POST /api/docs-registry/:id/start|stop`,
//!   `GET|HEAD /api/docs-registry/:id/log`
//! * `src/routes/memory-browser.js` — `GET|HEAD /api/memory/graph`,
//!   `GET|HEAD /api/memory/tree`, `GET|HEAD|PUT|DELETE /api/memory/file`
//! * `src/memo/router.js` — `GET|PUT /api/directories/:id/memo`,
//!   `POST /api/directories/:id/memo/send`
//! * `src/notes-store.js` — `GET|HEAD /api/directories/:id/events`
//!
//! The decision trees (sanitizing, validation, the memory-store `rel` verdict
//! and traversal containment, the view/DTO assembly and the memo request
//! validation) live in `multicc_core::docs_memory_routes`. Node keeps the
//! process-local world behind one host port, `POST /api/__host/docs-memory`
//! (`src/routes/docs-memory-host.js`): the registry table and its file, the
//! artifact dependency graph, task/directory lookups, service supervision
//! (spawn/kill/probe/log), the memory-store filesystem with its realpath
//! ancestors and scans, the memo filesystem and `runTurn`, and the directory
//! event ring + JSONL.
//!
//! The three `/api/directories/:id/*` shapes do not overlap the session-admin
//! (`/sessions`, `/workspace`) or voice-gateway claims, so this cluster is
//! claimed after them and never shadows a migrated route.
//!
//! Every write handler awaits host round trips that mutate the registry table,
//! the memory store, a memo file or a chat turn; [`App::docs_memory_write`]
//! serializes them the way the single Node event-loop thread did.

#![allow(clippy::result_large_err)]

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Method, Response};
use multicc_core::docs_memory_routes::{
    artifact_id_from_url, graph_envelope, iso_time, memory_file_dto, memory_path_valid,
    memory_write_dto, normalize_dir, sanitize_incoming, task_id_for, tree_with_duration,
    validate_entry, view, MemoryPathFacts, ResolvedUrl, ViewFacts, MEM_GRAPH_MAX_NODES,
};
use multicc_core::http_gate::{error_dto, query_value};
use multicc_core::js::serde::{js_string, truthy};
use multicc_core::quota_routes::query_json;
use serde_json::{json, Map, Value};

use crate::app::express::{self, RequestCtx};
use crate::app::App;
use crate::host_port;

/// The host port the Node child serves (`src/routes/docs-memory-host.js`).
const HOST_PATH: &str = "/api/__host/docs-memory";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Route {
    DocsListGet,
    DocsRegisterPost,
    DocsEntryPatch,
    DocsEntryDelete,
    DocsStartPost,
    DocsStopPost,
    DocsLogGet,
    MemGraphGet,
    MemTreeGet,
    MemFileGet,
    MemFilePut,
    MemFileDelete,
    MemoGet,
    MemoPut,
    MemoSendPost,
    NotesEventsGet,
    /// Express's automatic OPTIONS: the union of the methods registered on the
    /// exact path, with `HEAD` after each `GET`, in registration order.
    Options {
        allow: &'static str,
    },
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

/// Registration order of the retired mounts: the notes store, the memo router,
/// the memory browser and finally the docs registry (server.js line order).
static LAYERS: &[Layer] = &[
    Layer {
        segs: &[Lit("directories"), Param, Lit("events")],
        method: "GET",
        kind: Route::NotesEventsGet,
    },
    Layer {
        segs: &[Lit("directories"), Param, Lit("memo")],
        method: "GET",
        kind: Route::MemoGet,
    },
    Layer {
        segs: &[Lit("directories"), Param, Lit("memo")],
        method: "PUT",
        kind: Route::MemoPut,
    },
    Layer {
        segs: &[Lit("directories"), Param, Lit("memo"), Lit("send")],
        method: "POST",
        kind: Route::MemoSendPost,
    },
    Layer {
        segs: &[Lit("memory"), Lit("graph")],
        method: "GET",
        kind: Route::MemGraphGet,
    },
    Layer {
        segs: &[Lit("memory"), Lit("tree")],
        method: "GET",
        kind: Route::MemTreeGet,
    },
    Layer {
        segs: &[Lit("memory"), Lit("file")],
        method: "GET",
        kind: Route::MemFileGet,
    },
    Layer {
        segs: &[Lit("memory"), Lit("file")],
        method: "PUT",
        kind: Route::MemFilePut,
    },
    Layer {
        segs: &[Lit("memory"), Lit("file")],
        method: "DELETE",
        kind: Route::MemFileDelete,
    },
    Layer {
        segs: &[Lit("docs-registry")],
        method: "GET",
        kind: Route::DocsListGet,
    },
    Layer {
        segs: &[Lit("docs-registry")],
        method: "POST",
        kind: Route::DocsRegisterPost,
    },
    Layer {
        segs: &[Lit("docs-registry"), Param],
        method: "PATCH",
        kind: Route::DocsEntryPatch,
    },
    Layer {
        segs: &[Lit("docs-registry"), Param],
        method: "DELETE",
        kind: Route::DocsEntryDelete,
    },
    Layer {
        segs: &[Lit("docs-registry"), Param, Lit("start")],
        method: "POST",
        kind: Route::DocsStartPost,
    },
    Layer {
        segs: &[Lit("docs-registry"), Param, Lit("stop")],
        method: "POST",
        kind: Route::DocsStopPost,
    },
    Layer {
        segs: &[Lit("docs-registry"), Param, Lit("log")],
        method: "GET",
        kind: Route::DocsLogGet,
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
        let allow = allow_for(&parts)?;
        return Some(Route::Options { allow });
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

/// Express's automatic OPTIONS body and `Allow` header for this path.
/// This cluster's own share of Express's automatic `OPTIONS` `Allow` for the
/// front-door union across clusters (`super::OPTIONS_SOURCES`).
pub fn options_share(path: &str) -> Option<String> {
    let parts = segments(path)?;
    allow_for(&parts).map(str::to_string)
}

fn allow_for(parts: &[&str]) -> Option<&'static str> {
    let mut methods: Vec<&'static str> = Vec::new();
    let mut matched = false;
    for layer in LAYERS {
        if !layer_matches(layer.segs, parts) {
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
    // The registered unions are static; spelling them out keeps the header a
    // plain &'static str for `super::options`.
    Some(match methods.join(",").as_str() {
        "GET,HEAD" => "GET,HEAD",
        "GET,HEAD,POST" => "GET,HEAD,POST",
        "GET,HEAD,PUT" => "GET,HEAD,PUT",
        "GET,HEAD,PUT,DELETE" => "GET,HEAD,PUT,DELETE",
        "PATCH,DELETE" => "PATCH,DELETE",
        "POST" => "POST",
        _ => "GET,HEAD",
    })
}

fn part<'a>(parts: &[&'a str], index: usize) -> &'a str {
    parts.get(index).copied().unwrap_or("")
}

fn param(ctx: &RequestCtx, raw: &str) -> Result<String, Response<Body>> {
    super::download::decode_uri_component(raw)
        .ok_or_else(|| express::error(ctx, 400, "Failed to decode param"))
}

fn unavailable(ctx: &RequestCtx) -> Response<Body> {
    express::json(
        ctx,
        503,
        &json!({
            "error": "文档与记忆接口尚未就绪，请更新原生模块",
            "code": "rust_backend_unavailable",
        }),
        &[],
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

/// One host round trip. Business refusals are values (`{error}`,
/// `{refused}`, `{found:false}`) and never fail the exchange; a transport or
/// non-200 failure is the documented 503.
async fn call(ctx: &RequestCtx, host: u16, payload: Value) -> Result<Value, Response<Body>> {
    let op = payload
        .get("op")
        .and_then(Value::as_str)
        .unwrap_or("host")
        .to_string();
    let answer = host_port::call(host, HOST_PATH, &payload)
        .await
        .map_err(|_| unavailable(ctx))?;
    if answer.get("ok") == Some(&Value::Bool(true)) {
        return Ok(answer.get("value").cloned().unwrap_or(Value::Null));
    }
    Err(express::error(
        ctx,
        500,
        &format!("docs-memory host operation failed: {op}"),
    ))
}

/// `req.body || {}` for the retired handlers (`req.body` is already parsed).
fn request_value(body: &Value) -> Value {
    match body {
        Value::Object(_) | Value::Array(_) => body.clone(),
        _ => Value::Object(Map::new()),
    }
}

/// `req.query[name]` as the JSON value Express would expose.
fn q_json(ctx: &RequestCtx, name: &str) -> Option<Value> {
    query_json(&query_value(&ctx.original_url, name))
}

/// `Array.prototype.join`/`String()` for API parameters.
fn member(value: &Value, name: &str) -> Value {
    value.get(name).cloned().unwrap_or(Value::Null)
}

fn first_item(value: &Value, name: &str, index: usize) -> Value {
    value
        .get(name)
        .and_then(Value::as_array)
        .and_then(|items| items.get(index))
        .cloned()
        .unwrap_or(Value::Null)
}

/// `entry.artifactId || artifactIdFromUrl(entry.url)`.
mod registry;

fn artifact_of(entry: &Value) -> Value {
    if let Some(stored) = entry.get("artifactId") {
        if truthy(stored) {
            return stored.clone();
        }
    }
    artifact_id_from_url(entry.get("url").and_then(Value::as_str))
        .map(Value::String)
        .unwrap_or(Value::Null)
}

/// The host facts `toView` needs, resolved for one entry.
struct FactsRequest {
    items: Vec<Value>,
}

impl FactsRequest {
    fn new() -> Self {
        Self { items: Vec::new() }
    }

    fn push(&mut self, entry: &Value) {
        self.items.push(json!({
            "sessionId": entry.get("sessionId").cloned().unwrap_or(Value::Null),
            "artifactId": artifact_of(entry),
            "taskId": task_id_for(entry).unwrap_or(Value::Null),
        }));
    }
}

/// `dirOf`'s `resolveDir`, `artifactExists` and `resolveTaskTitle` for every
/// entry that needs them; the derivations themselves stay in the kernel.
async fn facts_for(
    ctx: &RequestCtx,
    host: u16,
    entries: &[Value],
) -> Result<Vec<ViewFacts>, Response<Body>> {
    let mut request = FactsRequest::new();
    for entry in entries {
        request.push(entry);
    }
    if request.items.is_empty() {
        return Ok(Vec::new());
    }
    let facts = call(
        ctx,
        host,
        payload("docs-facts", vec![("items", json!(request.items))]),
    )
    .await?;
    Ok(entries
        .iter()
        .enumerate()
        .map(|(index, _)| ViewFacts {
            session_dir: normalize_dir(Some(&first_item(&facts, "sessionDir", index))),
            task_title: first_item(&facts, "taskTitle", index),
            exists: first_item(&facts, "exists", index).as_bool(),
            retained: false,
        })
        .collect())
}

fn retained_ids(list: &Value) -> Vec<String> {
    list.get("retained")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn build_view(entry: &Value, facts: ViewFacts, retained: &[String]) -> Value {
    let artifact = artifact_of(entry);
    let keep = match artifact.as_str() {
        Some(id) => retained.iter().any(|kept| kept == id),
        None => false,
    };
    view(
        entry,
        &ViewFacts {
            retained: keep,
            ..facts
        },
    )
}

/// One entry's view: the host facts for exactly that entry.
async fn one_view(
    ctx: &RequestCtx,
    host: u16,
    entry: &Value,
    retained: Option<&[String]>,
) -> Result<Value, Response<Body>> {
    let mut facts = facts_for(ctx, host, std::slice::from_ref(entry)).await?;
    let retained = match retained {
        Some(ids) => ids.to_vec(),
        None => {
            let list = call(ctx, host, payload("docs-list", vec![])).await?;
            retained_ids(&list)
        }
    };
    Ok(build_view(
        entry,
        facts.pop().unwrap_or_default(),
        &retained,
    ))
}

fn not_found(ctx: &RequestCtx, message: &str) -> Response<Body> {
    express::json(ctx, 404, &json!({ "error": message }), &[])
}

fn ok(ctx: &RequestCtx, value: Value) -> Response<Body> {
    express::json(ctx, 200, &value, &[])
}

fn current_iso() -> String {
    iso_time(super::now_ms())
}

/// The `docs-clean-url` host answer for an absolute URL (WHATWG `new URL`).
async fn url_verdict(
    ctx: &RequestCtx,
    host: u16,
    body: &Value,
) -> Result<ResolvedUrl, Response<Body>> {
    match body.get("url") {
        Some(value) => {
            if let Some(trimmed) = multicc_core::docs_memory_routes::url_needs_host(Some(value)) {
                let answer = call(
                    ctx,
                    host,
                    payload("docs-clean-url", vec![("url", json!(trimmed))]),
                )
                .await?;
                let href = match member(&answer, "href") {
                    Value::String(text) => Some(text),
                    _ => None,
                };
                Ok(ResolvedUrl::Host(href))
            } else {
                Ok(ResolvedUrl::Inline)
            }
        }
        None => Ok(ResolvedUrl::Inline),
    }
}

pub async fn handle(
    app: &Arc<App>,
    route: Route,
    ctx: &RequestCtx,
    body: &Value,
    host: u16,
) -> Response<Body> {
    let write = matches!(
        route,
        Route::DocsRegisterPost
            | Route::DocsEntryPatch
            | Route::DocsEntryDelete
            | Route::DocsStartPost
            | Route::DocsStopPost
            | Route::MemFilePut
            | Route::MemFileDelete
            | Route::MemoPut
            | Route::MemoSendPost
    );
    let _serialized = if write {
        Some(app.docs_memory_write.lock().await)
    } else {
        None
    };
    if !app.node_enabled && route == Route::DocsListGet {
        let root = app.data_root.clone();
        let artifacts = super::artifacts::served_roots(app);
        let result = tokio::task::spawn_blocking(move || registry::views(&root, &artifacts)).await;
        return match result {
            Ok(Ok(views)) => list_response(ctx, registry::probe_services(views).await),
            _ => unavailable(ctx),
        };
    }
    answer(ctx, route, body, host).await
}

async fn answer(ctx: &RequestCtx, route: Route, body: &Value, host: u16) -> Response<Body> {
    let parts = segments(&ctx.path).unwrap_or_default();
    match route {
        Route::Options { allow } => super::options(ctx, allow),
        Route::NotesEventsGet => notes_events(ctx, host, part(&parts, 1)).await,
        Route::MemoGet => memo_read(ctx, host, part(&parts, 1)).await,
        Route::MemoPut => memo_write(ctx, host, part(&parts, 1), body).await,
        Route::MemoSendPost => memo_send(ctx, host, part(&parts, 1), body).await,
        Route::MemGraphGet => memory_graph(ctx, host).await,
        Route::MemTreeGet => memory_tree(ctx, host).await,
        Route::MemFileGet => memory_file_get(ctx, host).await,
        Route::MemFilePut => memory_file_put(ctx, host, body).await,
        Route::MemFileDelete => memory_file_delete(ctx, host, body).await,
        Route::DocsListGet => docs_list(ctx, host).await,
        Route::DocsRegisterPost => docs_register(ctx, host, body).await,
        Route::DocsEntryPatch => docs_patch(ctx, host, part(&parts, 1), body).await,
        Route::DocsEntryDelete => docs_delete(ctx, host, part(&parts, 1)).await,
        Route::DocsStartPost => docs_start(ctx, host, part(&parts, 1)).await,
        Route::DocsStopPost => docs_stop(ctx, host, part(&parts, 1)).await,
        Route::DocsLogGet => docs_log(ctx, host, part(&parts, 1)).await,
    }
}

// ── docs registry ─────────────────────────────────────────────────────────

async fn docs_list(ctx: &RequestCtx, host: u16) -> Response<Body> {
    let list = match call(ctx, host, payload("docs-list", vec![])).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let entries: Vec<Value> = list
        .get("entries")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let retained = retained_ids(&list);
    // `entries.map(view).sort(byRetention)`: the host answered the permutation
    // its real `byRetention` produced (`localeCompare` stays in the JS engine
    // by project convention; the comparator reads only entry fields).
    let order: Vec<usize> = list
        .get("order")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_u64)
                .map(|index| index as usize)
                .filter(|index| *index < entries.len())
                .collect()
        })
        .unwrap_or_else(|| (0..entries.len()).collect());
    let facts = match facts_for(ctx, host, &entries).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let views: Vec<Value> = order
        .into_iter()
        .map(|index| build_view(&entries[index], facts[index].clone(), &retained))
        .collect();
    list_response(ctx, views)
}

fn list_response(ctx: &RequestCtx, views: Vec<Value>) -> Response<Body> {
    let raw = q_json(ctx, "dir");
    match raw {
        None => ok(ctx, Value::Array(views)),
        Some(raw) => match normalize_dir(Some(&raw)) {
            Some(wanted) => ok(
                ctx,
                Value::Array(
                    views
                        .into_iter()
                        .filter(|view| view.get("dir").and_then(Value::as_str) == Some(&wanted))
                        .collect(),
                ),
            ),
            // A scoped request that cannot be normalized answers [] rather
            // than the whole registry.
            None => ok(ctx, Value::Array(Vec::new())),
        },
    }
}

async fn docs_register(ctx: &RequestCtx, host: u16, body: &Value) -> Response<Body> {
    let mut request = request_value(body);
    if !truthy_or(&request, "taskId") && truthy_or(&request, "sessionId") {
        let session = request.get("sessionId").cloned().unwrap_or(Value::Null);
        let answer = match call(
            ctx,
            host,
            payload("docs-task-id", vec![("sessionId", session)]),
        )
        .await
        {
            Ok(value) => value,
            Err(response) => return response,
        };
        let task_id = member(&answer, "taskId");
        if truthy(&task_id) {
            if let Value::Object(ref mut map) = request {
                map.insert("taskId".into(), task_id);
            }
        }
    }
    if !truthy_or(&request, "dir") {
        let mut dir = normalize_dir(request.get("cwd"));
        if dir.is_none() {
            let session = request.get("sessionId").cloned().unwrap_or(Value::Null);
            let answer =
                match call(ctx, host, payload("docs-dir", vec![("sessionId", session)])).await {
                    Ok(value) => value,
                    Err(response) => return response,
                };
            dir = normalize_dir(Some(&member(&answer, "dir")));
        }
        if let Some(dir) = dir {
            if let Value::Object(ref mut map) = request {
                map.insert("dir".into(), Value::String(dir));
            }
        }
    }
    let host_url = match url_verdict(ctx, host, &request).await {
        Ok(verdict) => verdict,
        Err(response) => return response,
    };
    let mut entry = sanitize_incoming(&request, &Value::Object(Map::new()), host_url);
    let object = match entry {
        Value::Object(ref mut map) => map,
        _ => unreachable!("sanitize_incoming returns an object"),
    };
    if !truthy(object.get("kind").unwrap_or(&Value::Null)) {
        object.insert("kind".into(), Value::String("page".into()));
    }
    if !truthy(object.get("source").unwrap_or(&Value::Null)) {
        object.insert("source".into(), Value::String("agent".into()));
    }
    if let Some(error) = validate_entry(&Value::Object(object.clone())) {
        return express::json(ctx, 400, &json!({ "error": error }), &[]);
    }
    let result = match call(
        ctx,
        host,
        payload(
            "docs-register",
            vec![("entry", Value::Object(object.clone()))],
        ),
    )
    .await
    {
        Ok(value) => value,
        Err(response) => return response,
    };
    if let Some(Value::String(error)) = result.get("error") {
        return express::json(ctx, 400, &json!({ "error": error }), &[]);
    }
    let entry = member(&result, "entry");
    let created = result.get("created") == Some(&Value::Bool(true));
    match one_view(ctx, host, &entry, None).await {
        Ok(view) => express::json(ctx, if created { 201 } else { 200 }, &view, &[]),
        Err(response) => response,
    }
}

fn truthy_or(object: &Value, name: &str) -> bool {
    object.get(name).is_some_and(truthy)
}

async fn docs_patch(ctx: &RequestCtx, host: u16, id_raw: &str, body: &Value) -> Response<Body> {
    let id = match param(ctx, id_raw) {
        Ok(id) => id,
        Err(response) => return response,
    };
    let found = match call(ctx, host, payload("docs-get", vec![("id", json!(id))])).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    if found.get("found") != Some(&Value::Bool(true)) {
        return not_found(ctx, "entry not found");
    }
    let existing = member(&found, "entry");
    let request = request_value(body);
    let host_url = match url_verdict(ctx, host, &request).await {
        Ok(verdict) => verdict,
        Err(response) => return response,
    };
    let mut merged = sanitize_incoming(&request, &existing, host_url);
    if let Some(error) = validate_entry(&merged) {
        return express::json(ctx, 400, &json!({ "error": error }), &[]);
    }
    let artifact = artifact_id_from_url(merged.get("url").and_then(Value::as_str))
        .map(Value::String)
        .unwrap_or(Value::Null);
    if let Value::Object(ref mut map) = merged {
        map.insert("artifactId".into(), artifact);
        map.insert("updatedAt".into(), Value::String(current_iso()));
    }
    let replaced = match call(
        ctx,
        host,
        payload(
            "docs-replace",
            vec![("id", json!(id)), ("entry", merged.clone())],
        ),
    )
    .await
    {
        Ok(value) => value,
        Err(response) => return response,
    };
    if replaced.get("found") != Some(&Value::Bool(true)) {
        return not_found(ctx, "entry not found");
    }
    match one_view(ctx, host, &merged, None).await {
        Ok(view) => ok(ctx, view),
        Err(response) => response,
    }
}

async fn docs_delete(ctx: &RequestCtx, host: u16, id_raw: &str) -> Response<Body> {
    let id = match param(ctx, id_raw) {
        Ok(id) => id,
        Err(response) => return response,
    };
    let removed = match call(ctx, host, payload("docs-delete", vec![("id", json!(id))])).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    if removed.get("found") != Some(&Value::Bool(true)) {
        return not_found(ctx, "entry not found");
    }
    let entry = member(&removed, "removed");
    match one_view(ctx, host, &entry, None).await {
        Ok(view) => ok(ctx, json!({ "ok": true, "removed": view })),
        Err(response) => response,
    }
}

/// `startService`'s `{error, status}` / `{entry}` answer.
async fn docs_start(ctx: &RequestCtx, host: u16, id_raw: &str) -> Response<Body> {
    let id = match param(ctx, id_raw) {
        Ok(id) => id,
        Err(response) => return response,
    };
    let result = match call(ctx, host, payload("docs-start", vec![("id", json!(id))])).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    if let Some(Value::String(error)) = result.get("error") {
        let status = result.get("status").and_then(Value::as_u64).unwrap_or(500) as u16;
        return express::json(ctx, status, &json!({ "error": error }), &[]);
    }
    let entry = member(&result, "entry");
    let response = match one_view(ctx, host, &entry, None).await {
        Ok(view) => ok(ctx, view),
        Err(response) => response,
    };
    // The retired handler answered first, then kicked the probe loop:
    // `probeAllServices().catch(() => {})`.
    tokio::spawn(async move {
        let _ = host_port::call(host, HOST_PATH, &payload("docs-probe-kick", vec![])).await;
    });
    response
}

async fn docs_stop(ctx: &RequestCtx, host: u16, id_raw: &str) -> Response<Body> {
    let id = match param(ctx, id_raw) {
        Ok(id) => id,
        Err(response) => return response,
    };
    let result = match call(ctx, host, payload("docs-stop", vec![("id", json!(id))])).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    if let Some(Value::String(error)) = result.get("error") {
        let status = result.get("status").and_then(Value::as_u64).unwrap_or(500) as u16;
        return express::json(ctx, status, &json!({ "error": error }), &[]);
    }
    let entry = member(&result, "entry");
    match one_view(ctx, host, &entry, None).await {
        Ok(view) => ok(ctx, view),
        Err(response) => response,
    }
}

async fn docs_log(ctx: &RequestCtx, host: u16, id_raw: &str) -> Response<Body> {
    let id = match param(ctx, id_raw) {
        Ok(id) => id,
        Err(response) => return response,
    };
    let result = match call(ctx, host, payload("docs-log", vec![("id", json!(id))])).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    if result.get("found") != Some(&Value::Bool(true)) {
        return not_found(ctx, "entry not found");
    }
    let text = match member(&result, "text") {
        Value::String(text) if !text.is_empty() => text,
        _ => "(no log yet)".to_string(),
    };
    express::send(
        ctx,
        200,
        "text/plain; charset=utf-8",
        text.into_bytes(),
        &[],
    )
}

// ── memory browser ────────────────────────────────────────────────────────

async fn memory_graph(ctx: &RequestCtx, host: u16) -> Response<Body> {
    let dir_id = match q_json(ctx, "dirId") {
        Some(value) if truthy(&value) => js_string(&value),
        _ => "all".to_string(),
    };
    let result = match call(
        ctx,
        host,
        payload("memory-graph", vec![("dirId", json!(dir_id))]),
    )
    .await
    {
        Ok(value) => value,
        Err(response) => return response,
    };
    if let Some(Value::String(error)) = result.get("error") {
        return express::json(ctx, 500, &json!({ "error": error }), &[]);
    }
    let duration = result
        .get("durationMs")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    ok(
        ctx,
        graph_envelope(
            &dir_id,
            &member(&result, "data"),
            duration,
            MEM_GRAPH_MAX_NODES,
        ),
    )
}

async fn memory_tree(ctx: &RequestCtx, host: u16) -> Response<Body> {
    let result = match call(ctx, host, payload("memory-tree", vec![])).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    if let Some(Value::String(error)) = result.get("error") {
        return express::json(ctx, 500, &json!({ "error": error }), &[]);
    }
    let duration = result
        .get("durationMs")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    ok(ctx, tree_with_duration(member(&result, "data"), duration))
}

/// `req.query.rel ? String(req.query.rel) : ''`.
fn query_rel(ctx: &RequestCtx) -> String {
    match q_json(ctx, "rel") {
        Some(value) if truthy(&value) => js_string(&value),
        _ => String::new(),
    }
}

fn memory_facts(answer: &Value) -> MemoryPathFacts {
    MemoryPathFacts {
        root: answer
            .get("root")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        resolved: answer
            .get("resolved")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        real_root: answer
            .get("rootReal")
            .and_then(Value::as_str)
            .map(str::to_string),
        existing_ancestor_real: answer
            .get("ancestorReal")
            .and_then(Value::as_str)
            .map(str::to_string),
        exists: answer.get("exists") == Some(&Value::Bool(true)),
        parent_exists: answer.get("parentExists") == Some(&Value::Bool(true)),
        name: answer
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
    }
}

/// The `resolveMemoryFilePath` verdict over the host's filesystem facts; a
/// rejected `rel` never reaches a read/write/delete op.
async fn memory_verdict(
    ctx: &RequestCtx,
    host: u16,
    rel: &str,
) -> Result<MemoryPathFacts, Response<Body>> {
    let answer = call(
        ctx,
        host,
        payload("memory-resolve", vec![("rel", json!(rel))]),
    )
    .await?;
    Ok(memory_facts(&answer))
}

fn invalid_rel(ctx: &RequestCtx) -> Response<Body> {
    express::json(
        ctx,
        400,
        &json!({ "error": "invalid rel (must be a *.md under the memory store)" }),
        &[],
    )
}

async fn memory_file_get(ctx: &RequestCtx, host: u16) -> Response<Body> {
    let rel = query_rel(ctx);
    let facts = match memory_verdict(ctx, host, &rel).await {
        Ok(facts) => facts,
        Err(response) => return response,
    };
    if !memory_path_valid(&rel, &facts) {
        return invalid_rel(ctx);
    }
    if !facts.exists {
        return not_found(ctx, "file not found");
    }
    let read = match call(ctx, host, payload("memory-read", vec![("rel", json!(rel))])).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    if let Some(Value::String(error)) = read.get("error") {
        return express::json(ctx, 500, &json!({ "error": error }), &[]);
    }
    if read.get("valid") != Some(&Value::Bool(true)) {
        return invalid_rel(ctx);
    }
    let content = read
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let abs = read
        .get("abs")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    ok(
        ctx,
        memory_file_dto(&rel, &abs, &content, member(&read, "mtime")),
    )
}

async fn memory_file_put(ctx: &RequestCtx, host: u16, body: &Value) -> Response<Body> {
    let request = request_value(body);
    let content = request.get("content").cloned().unwrap_or(Value::Null);
    let content = match content {
        Value::String(text) => text,
        _ => {
            return express::json(
                ctx,
                400,
                &json!({ "error": "content (string) required" }),
                &[],
            )
        }
    };
    if multicc_core::js::string::utf16_len(&content)
        > multicc_core::docs_memory_routes::MEMORY_FILE_MAX_CHARS
    {
        return express::json(
            ctx,
            413,
            &json!({ "error": "content too long (max 200000 chars)" }),
            &[],
        );
    }
    // `resolveMemoryFilePath` only accepts a string; any other JSON type reads
    // as the empty rel and is refused as invalid.
    let rel = match request.get("rel") {
        Some(Value::String(text)) => text.clone(),
        _ => String::new(),
    };
    let facts = match memory_verdict(ctx, host, &rel).await {
        Ok(facts) => facts,
        Err(response) => return response,
    };
    if !memory_path_valid(&rel, &facts) {
        return invalid_rel(ctx);
    }
    if !facts.parent_exists {
        return express::json(
            ctx,
            400,
            &json!({ "error": "parent folder does not exist" }),
            &[],
        );
    }
    let written = match call(
        ctx,
        host,
        payload(
            "memory-write",
            vec![("rel", json!(rel)), ("content", json!(content))],
        ),
    )
    .await
    {
        Ok(value) => value,
        Err(response) => return response,
    };
    if let Some(Value::String(error)) = written.get("error") {
        return express::json(ctx, 500, &json!({ "error": error }), &[]);
    }
    if written.get("valid") != Some(&Value::Bool(true)) {
        return invalid_rel(ctx);
    }
    if written.get("parentMissing") == Some(&Value::Bool(true)) {
        return express::json(
            ctx,
            400,
            &json!({ "error": "parent folder does not exist" }),
            &[],
        );
    }
    let abs = written
        .get("abs")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    ok(
        ctx,
        memory_write_dto(&rel, &abs, &content, member(&written, "mtime")),
    )
}

async fn memory_file_delete(ctx: &RequestCtx, host: u16, body: &Value) -> Response<Body> {
    let request = request_value(body);
    // `(req.body && req.body.rel) || req.query.rel`
    let body_rel = request.get("rel").cloned().unwrap_or(Value::Null);
    let rel = if truthy(&body_rel) {
        js_string(&body_rel)
    } else {
        query_rel(ctx)
    };
    let facts = match memory_verdict(ctx, host, &rel).await {
        Ok(facts) => facts,
        Err(response) => return response,
    };
    if !memory_path_valid(&rel, &facts) {
        return invalid_rel(ctx);
    }
    let deleted = match call(
        ctx,
        host,
        payload("memory-delete", vec![("rel", json!(rel))]),
    )
    .await
    {
        Ok(value) => value,
        Err(response) => return response,
    };
    if let Some(Value::String(error)) = deleted.get("error") {
        return express::json(ctx, 500, &json!({ "error": error }), &[]);
    }
    if deleted.get("valid") != Some(&Value::Bool(true)) {
        return invalid_rel(ctx);
    }
    ok(ctx, json!({ "ok": true }))
}

// ── memo ──────────────────────────────────────────────────────────────────

/// A controller result or its branded refusal, mapped by `src/http` in Node.
async fn memo_answer(
    ctx: &RequestCtx,
    host: u16,
    op: &str,
    fields: Vec<(&str, Value)>,
) -> Response<Body> {
    let result = match call(ctx, host, payload(op, fields)).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    if let Some(refused) = result.get("refused") {
        let status = refused.get("status").and_then(Value::as_u64).unwrap_or(500) as u16;
        let message = refused
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("internal_error");
        let code = refused
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("internal_error");
        return express::json(ctx, status, &error_dto(code, message, &[], &ctx.ids), &[]);
    }
    ok(ctx, member(&result, "data"))
}

async fn memo_read(ctx: &RequestCtx, host: u16, id: &str) -> Response<Body> {
    let directory = match param(ctx, id) {
        Ok(id) => id,
        Err(response) => return response,
    };
    memo_answer(
        ctx,
        host,
        "memo-read",
        vec![("directoryId", json!(directory))],
    )
    .await
}

async fn memo_write(ctx: &RequestCtx, host: u16, id: &str, body: &Value) -> Response<Body> {
    let directory = match param(ctx, id) {
        Ok(id) => id,
        Err(response) => return response,
    };
    let request = request_value(body);
    memo_answer(
        ctx,
        host,
        "memo-write",
        vec![
            ("directoryId", json!(directory)),
            ("text", member(&request, "text")),
        ],
    )
    .await
}

async fn memo_send(ctx: &RequestCtx, host: u16, id: &str, body: &Value) -> Response<Body> {
    let directory = match param(ctx, id) {
        Ok(id) => id,
        Err(response) => return response,
    };
    let request = request_value(body);
    memo_answer(
        ctx,
        host,
        "memo-send",
        vec![
            ("directoryId", json!(directory)),
            ("text", member(&request, "text")),
            ("sessionId", member(&request, "sessionId")),
        ],
    )
    .await
}

// ── directory events ──────────────────────────────────────────────────────

async fn notes_events(ctx: &RequestCtx, host: u16, id: &str) -> Response<Body> {
    let directory = match param(ctx, id) {
        Ok(id) => id,
        Err(response) => return response,
    };
    let result = match call(
        ctx,
        host,
        payload("notes-events", vec![("directoryId", json!(directory))]),
    )
    .await
    {
        Ok(value) => value,
        Err(response) => return response,
    };
    if result.get("found") != Some(&Value::Bool(true)) {
        return not_found(ctx, "directory not found");
    }
    ok(ctx, json!({ "events": member(&result, "events") }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allow(path: &str) -> Option<&'static str> {
        match claim(&Method::OPTIONS, path) {
            Some(Route::Options { allow }) => Some(allow),
            _ => None,
        }
    }

    #[test]
    fn claims_the_sixteen_paths_and_their_automatic_options() {
        let routes = [
            ("GET", "/api/docs-registry", Route::DocsListGet),
            ("POST", "/api/docs-registry", Route::DocsRegisterPost),
            ("PATCH", "/api/docs-registry/d1", Route::DocsEntryPatch),
            ("DELETE", "/api/docs-registry/d1", Route::DocsEntryDelete),
            ("POST", "/api/docs-registry/d1/start", Route::DocsStartPost),
            ("POST", "/api/docs-registry/d1/stop", Route::DocsStopPost),
            ("GET", "/api/docs-registry/d1/log", Route::DocsLogGet),
            ("GET", "/api/memory/graph", Route::MemGraphGet),
            ("GET", "/api/memory/tree", Route::MemTreeGet),
            ("GET", "/api/memory/file", Route::MemFileGet),
            ("PUT", "/api/memory/file", Route::MemFilePut),
            ("DELETE", "/api/memory/file", Route::MemFileDelete),
            ("GET", "/api/directories/d1/memo", Route::MemoGet),
            ("PUT", "/api/directories/d1/memo", Route::MemoPut),
            ("POST", "/api/directories/d1/memo/send", Route::MemoSendPost),
            ("GET", "/api/directories/d1/events", Route::NotesEventsGet),
        ];
        for (method, path, route) in routes {
            let method = Method::from_bytes(method.as_bytes()).unwrap();
            assert_eq!(claim(&method, path), Some(route), "{method} {path}");
        }
        // HEAD is dispatched to the GET branch.
        assert_eq!(
            claim(&Method::HEAD, "/api/memory/file"),
            Some(Route::MemFileGet)
        );
        assert_eq!(
            claim(&Method::HEAD, "/api/docs-registry/d1/log"),
            Some(Route::DocsLogGet)
        );
    }

    #[test]
    fn options_allow_is_the_registration_order_union() {
        assert_eq!(allow("/api/docs-registry"), Some("GET,HEAD,POST"));
        assert_eq!(allow("/api/docs-registry/d1"), Some("PATCH,DELETE"));
        assert_eq!(allow("/api/docs-registry/d1/start"), Some("POST"));
        assert_eq!(allow("/api/docs-registry/d1/stop"), Some("POST"));
        assert_eq!(allow("/api/docs-registry/d1/log"), Some("GET,HEAD"));
        assert_eq!(allow("/api/memory/graph"), Some("GET,HEAD"));
        assert_eq!(allow("/api/memory/tree"), Some("GET,HEAD"));
        assert_eq!(allow("/api/memory/file"), Some("GET,HEAD,PUT,DELETE"));
        assert_eq!(allow("/api/directories/d1/memo"), Some("GET,HEAD,PUT"));
        assert_eq!(allow("/api/directories/d1/memo/send"), Some("POST"));
        assert_eq!(allow("/api/directories/d1/events"), Some("GET,HEAD"));
    }

    #[test]
    fn literal_segments_are_case_insensitive_and_trailing_slash_is_optional() {
        assert_eq!(
            claim(&Method::GET, "/api/Docs-Registry/"),
            Some(Route::DocsListGet)
        );
        assert_eq!(
            claim(&Method::GET, "/api/MEMORY/File"),
            Some(Route::MemFileGet)
        );
        assert_eq!(
            claim(&Method::GET, "/api/docs-registry/d1/log/"),
            Some(Route::DocsLogGet)
        );
        // A parameter is one non-empty segment and nothing else may match.
        assert_eq!(claim(&Method::GET, "/api/docs-registry//log"), None);
        assert_eq!(claim(&Method::GET, "/api/docs-registry/d1/log/x"), None);
        assert_eq!(claim(&Method::GET, "/api/docs-registry/d1"), None);
        assert_eq!(claim(&Method::GET, "/api/memory"), None);
        assert_eq!(claim(&Method::GET, "/api/memory/file/x"), None);
    }

    #[test]
    fn the_directory_claims_do_not_shadow_session_admin_or_voice_gateway() {
        // `/api/directories/:id/sessions|workspace|voice-gateway` stay with the
        // clusters that already own them; only the memo/events shapes land here.
        assert_eq!(claim(&Method::GET, "/api/directories/d1/sessions"), None);
        assert_eq!(claim(&Method::GET, "/api/directories/d1/workspace"), None);
        assert_eq!(
            claim(&Method::GET, "/api/directories/d1/voice-gateway"),
            None
        );
        assert_eq!(
            claim(&Method::GET, "/api/directories/d1/memo"),
            Some(Route::MemoGet)
        );
    }
}
