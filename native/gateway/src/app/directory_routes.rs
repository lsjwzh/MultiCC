//! The directory / onboarding / UI-layout route cluster retired from
//! `src/directory/controller.js` (10 routes) and `src/directory/ui-layout.js`
//! (3 routes):
//!
//! * `GET|HEAD /api/fs/list`
//! * `GET|HEAD|POST /api/directories`
//! * `POST /api/onboarding/sample-workspace`
//! * `PUT /api/directories/order`
//! * `PATCH|DELETE /api/directories/:id`
//! * `POST /api/directories/:id/push`
//! * `GET|HEAD /api/directories/:id/uncommitted`
//! * `POST /api/directories/:id/commit`
//! * `GET|HEAD /api/ui-layout`
//! * `PUT /api/ui-layout/dir-order`
//! * `PUT /api/ui-layout/session-order/:dirId`
//!
//! The decision tree — input trimming and validation, the `isHomeOrAbove`
//! path-safety verdict, the browse filter/sort/cap, the DTO key order and the
//! `{code, error, ...extra, requestId?}` envelope, the reorder merge and the
//! layout `normalizeOrder`/`normalizeLayout` rules — lives in
//! `multicc_core::directory_routes`. Node keeps the process-local world behind
//! one host port, `POST /api/__host/directory`
//! (`src/routes/directory-host.js`): the native-owned `directories.json` table,
//! git subprocesses and their caches, the filesystem scan/mkdir/sample files,
//! the session table and cascade kill, the directory event log's append, the
//! native cross-file transaction, and the `ui-layout.json` state store.
//!
//! `/api/directories/:id` (2 segments) and the three 3-segment literals
//! `push` / `uncommitted` / `commit` never shadow the migrated
//! `/sessions`, `/workspace`, `/memo`, `/memo/send` and `/events` claims: those
//! are all 3- or 4-segment shapes with different literals, so this cluster is
//! claimed after them. `PUT /api/directories/order` is a literal layer that
//! wins over `:id` for PUT; `PATCH /api/directories/order` is the retired
//! `:id = "order"` 404, exactly like Express.
//!
//! Every write handler awaits several host round trips that mutate the
//! directory table, the filesystem, a git repo or the layout file;
//! [`App::directory_write`] serializes them the way the single Node event-loop
//! thread ran them.

#![allow(clippy::result_large_err)]

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Method, Response};
use multicc_core::directory_routes::{
    annotate_dir, apply_dir_order, apply_session_order, browse_entries, browse_selectable,
    is_home_or_above, merge_ok, normalize_layout, parse_porcelain, push_state_failure,
    reorder_plan, reorder_tail, service_error, service_status, stamp_updated_at, with_fields,
    UiKnown, MAX_ROLE_PROMPT,
};
use multicc_core::docs_memory_routes::iso_time;
use multicc_core::http_gate::query_value;
use multicc_core::js::format_f64;
use multicc_core::js::serde::{js_string, js_trim, truthy, truthy_opt};
use multicc_core::js::string::utf16_len;
use multicc_core::quota_routes::query_json;
use serde_json::{json, Map, Value};

use crate::app::express::{self, RequestCtx};
use crate::app::App;
use crate::host_port;

/// The host port the Node child serves (`src/routes/directory-host.js`).
const HOST_PATH: &str = "/api/__host/directory";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Route {
    FsList,
    DirsList,
    DirsCreate,
    SampleWorkspace,
    DirsOrder,
    DirUpdate,
    DirDelete,
    DirPush,
    DirUncommitted,
    DirCommit,
    LayoutGet,
    LayoutDirOrder,
    LayoutSessionOrder,
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

/// Registration order of the retired mounts: the ten controller routes, then
/// the three UI-layout routes appended by `src/directory/index.js`.
static LAYERS: &[Layer] = &[
    Layer {
        segs: &[Lit("fs"), Lit("list")],
        method: "GET",
        kind: Route::FsList,
    },
    Layer {
        segs: &[Lit("directories")],
        method: "GET",
        kind: Route::DirsList,
    },
    Layer {
        segs: &[Lit("directories")],
        method: "POST",
        kind: Route::DirsCreate,
    },
    Layer {
        segs: &[Lit("onboarding"), Lit("sample-workspace")],
        method: "POST",
        kind: Route::SampleWorkspace,
    },
    Layer {
        segs: &[Lit("directories"), Lit("order")],
        method: "PUT",
        kind: Route::DirsOrder,
    },
    Layer {
        segs: &[Lit("directories"), Param],
        method: "PATCH",
        kind: Route::DirUpdate,
    },
    Layer {
        segs: &[Lit("directories"), Param],
        method: "DELETE",
        kind: Route::DirDelete,
    },
    Layer {
        segs: &[Lit("directories"), Param, Lit("push")],
        method: "POST",
        kind: Route::DirPush,
    },
    Layer {
        segs: &[Lit("directories"), Param, Lit("uncommitted")],
        method: "GET",
        kind: Route::DirUncommitted,
    },
    Layer {
        segs: &[Lit("directories"), Param, Lit("commit")],
        method: "POST",
        kind: Route::DirCommit,
    },
    Layer {
        segs: &[Lit("ui-layout")],
        method: "GET",
        kind: Route::LayoutGet,
    },
    Layer {
        segs: &[Lit("ui-layout"), Lit("dir-order")],
        method: "PUT",
        kind: Route::LayoutDirOrder,
    },
    Layer {
        segs: &[Lit("ui-layout"), Lit("session-order"), Param],
        method: "PUT",
        kind: Route::LayoutSessionOrder,
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
    Some(match methods.join(",").as_str() {
        "GET,HEAD" => "GET,HEAD",
        "GET,HEAD,POST" => "GET,HEAD,POST",
        "POST" => "POST",
        "PUT" => "PUT",
        "PATCH,DELETE" => "PATCH,DELETE",
        // `/api/directories/order` is matched by the literal PUT layer and by
        // the `:id` PATCH/DELETE layers, exactly as Express unions them.
        "PUT,PATCH,DELETE" => "PUT,PATCH,DELETE",
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
            "error": "目录与布局接口尚未就绪，请更新原生模块",
            "code": "rust_backend_unavailable",
        }),
        &[],
    )
}

/// One host round trip. Business refusals are values (`{error}`, `{found}`,
/// `{ok:false,reason}`) and never fail the exchange; a transport or non-200
/// failure is the documented 503.
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
        &format!("directory host operation failed: {op}"),
    ))
}

fn ok(ctx: &RequestCtx, value: Value) -> Response<Body> {
    express::json(ctx, 200, &value, &[])
}

/// `send(res, r)` for a service refusal.
fn refusal(ctx: &RequestCtx, code: &str, message: &str, extra: Option<&Value>) -> Response<Body> {
    let status = service_status(code);
    let request_id = if status >= 500 {
        Some(ctx.ids.0.as_str())
    } else {
        None
    };
    express::json(
        ctx,
        status,
        &service_error(code, message, extra, request_id),
        &[],
    )
}

/// `wrap()`'s rejected-promise body.
fn internal_error(ctx: &RequestCtx) -> Response<Body> {
    refusal(ctx, "internal", "internal_error", None)
}

fn not_found(ctx: &RequestCtx) -> Response<Body> {
    refusal(ctx, "not_found", "directory not found", None)
}

/// `req.query[name]` as the JSON value Express would expose.
fn q(ctx: &RequestCtx, name: &str) -> Option<Value> {
    query_json(&query_value(&ctx.original_url, name))
}

fn member(value: &Value, key: &str) -> Value {
    value.get(key).cloned().unwrap_or(Value::Null)
}

/// `(raw || '').toString().trim()`.
fn trimmed_input(value: Option<&Value>) -> String {
    match value {
        Some(item) if truthy(item) => js_trim(&js_string(item)).to_string(),
        _ => String::new(),
    }
}

fn string_field(value: &Value, key: &str) -> String {
    value.get(key).map(js_string).unwrap_or_default()
}

fn array_of(value: &Value, key: &str) -> Vec<Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

/// `hostPort.resolveCwd(home, raw)` — `path.resolve`/`path.join` semantics stay
/// in Node, the answer is a path fact.
async fn resolve_path(ctx: &RequestCtx, host: u16, raw: &str) -> Result<String, Response<Body>> {
    let answer = call(ctx, host, json!({"op": "resolve-path", "path": raw})).await?;
    Ok(answer
        .get("resolved")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string())
}

/// `realPathOf` facts plus the realpath of `$HOME`.
async fn real_paths(
    ctx: &RequestCtx,
    host: u16,
    paths: &[String],
) -> Result<(Vec<String>, String), Response<Body>> {
    let answer = call(ctx, host, json!({"op": "real-paths", "paths": paths})).await?;
    let reals = answer
        .get("real")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| item.as_str().unwrap_or("").to_string())
                .collect()
        })
        .unwrap_or_default();
    let home = answer
        .get("home")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    Ok((reals, home))
}

/// `fsPort.exists` / `fsPort.isDirectory` for each path.
async fn path_facts(
    ctx: &RequestCtx,
    host: u16,
    paths: &[String],
) -> Result<(Vec<bool>, Vec<bool>), Response<Body>> {
    let answer = call(ctx, host, json!({"op": "path-facts", "paths": paths})).await?;
    let flags = |key: &str| -> Vec<bool> {
        answer
            .get(key)
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .map(|item| item == &Value::Bool(true))
                    .collect()
            })
            .unwrap_or_default()
    };
    Ok((flags("exists"), flags("isDirectory")))
}

fn unsupported_path(ctx: &RequestCtx, resolved: &str) -> Response<Body> {
    refusal(ctx, "invalid", &format!("路径不是目录: {resolved}"), None)
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
        Route::DirsCreate
            | Route::SampleWorkspace
            | Route::DirsOrder
            | Route::DirUpdate
            | Route::DirDelete
            | Route::DirPush
            | Route::DirCommit
            | Route::LayoutDirOrder
            | Route::LayoutSessionOrder
    );
    let _serialized = if write {
        Some(app.directory_write.lock().await)
    } else {
        None
    };
    answer(ctx, route, body, host).await
}

async fn answer(ctx: &RequestCtx, route: Route, body: &Value, host: u16) -> Response<Body> {
    let parts = segments(&ctx.path).unwrap_or_default();
    match route {
        Route::Options { allow } => super::options(ctx, allow),
        Route::FsList => fs_list(ctx, host).await,
        Route::DirsList => dirs_list(ctx, host).await,
        Route::DirsCreate => dirs_create(ctx, host, body).await,
        Route::SampleWorkspace => sample_workspace(ctx, host).await,
        Route::DirsOrder => dirs_order(ctx, host, body).await,
        Route::DirUpdate => match param(ctx, part(&parts, 1)) {
            Ok(id) => dir_update(ctx, host, &id, body).await,
            Err(response) => response,
        },
        Route::DirDelete => match param(ctx, part(&parts, 1)) {
            Ok(id) => {
                let force = q(ctx, "force") == Some(Value::String("1".to_string()));
                dir_delete(ctx, host, &id, force).await
            }
            Err(response) => response,
        },
        Route::DirPush => match param(ctx, part(&parts, 1)) {
            Ok(id) => dir_push(ctx, host, &id).await,
            Err(response) => response,
        },
        Route::DirUncommitted => match param(ctx, part(&parts, 1)) {
            Ok(id) => dir_uncommitted(ctx, host, &id).await,
            Err(response) => response,
        },
        Route::DirCommit => match param(ctx, part(&parts, 1)) {
            Ok(id) => dir_commit(ctx, host, &id, body).await,
            Err(response) => response,
        },
        Route::LayoutGet => layout_get(ctx, host).await,
        Route::LayoutDirOrder => layout_dir_order(ctx, host, body).await,
        Route::LayoutSessionOrder => match param(ctx, part(&parts, 2)) {
            Ok(dir_id) => layout_session_order(ctx, host, &dir_id, body).await,
            Err(response) => response,
        },
    }
}

// ── directory browser ─────────────────────────────────────────────────────

async fn fs_list(ctx: &RequestCtx, host: u16) -> Response<Body> {
    let raw = q(ctx, "path").unwrap_or(Value::Null);
    let facts = match call(ctx, host, json!({"op": "browse-facts", "path": raw})).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let base = member(&facts, "base");
    let base_is_dir = facts.get("baseIsDir") == Some(&Value::Bool(true));
    let parent_is_dir = facts.get("parentIsDir") == Some(&Value::Bool(true));
    if !base_is_dir && !parent_is_dir {
        // The typed path does not exist and neither does its parent.
        return ok(
            ctx,
            json!({"base": base, "parent": Value::Null, "selectable": false, "entries": []}),
        );
    }
    let prefix = facts
        .get("prefix")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let read = match call(ctx, host, json!({"op": "browse-read", "base": base})).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    if let Some(Value::String(error)) = read.get("error") {
        return refusal(ctx, "invalid", &format!("无法读取目录：{error}"), None);
    }
    let dirents = array_of(&read, "entries");
    let order: Vec<usize> = read
        .get("order")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_u64)
                .map(|index| index as usize)
                .collect()
        })
        .unwrap_or_else(|| (0..dirents.len()).collect());
    let entries = browse_entries(&dirents, &order, &prefix);
    let real_base = facts.get("realBase").and_then(Value::as_str).unwrap_or("");
    let real_home = facts.get("realHome").and_then(Value::as_str).unwrap_or("");
    ok(
        ctx,
        json!({
            "base": base,
            "parent": member(&facts, "parent"),
            "selectable": browse_selectable(real_base, real_home),
            "entries": entries,
        }),
    )
}

async fn dirs_list(ctx: &RequestCtx, host: u16) -> Response<Body> {
    let answer = match call(ctx, host, json!({"op": "dirs-annotated"})).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let Some(dirs) = answer.get("dirs").and_then(Value::as_array) else {
        return internal_error(ctx);
    };
    let sessions = answer
        .get("sessions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let states = answer
        .get("pushStates")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let annotated: Vec<Value> = dirs
        .iter()
        .enumerate()
        .map(|(index, dir)| {
            let list = sessions
                .get(index)
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let state = match states.get(index) {
                Some(state) if state.get("ok") == Some(&Value::Bool(true)) => {
                    member(state, "value")
                }
                Some(state) => push_state_failure(&string_field(state, "error")),
                None => push_state_failure(""),
            };
            annotate_dir(dir, &list, state)
        })
        .collect();
    ok(ctx, Value::Array(annotated))
}

/// The retired `service.register`, as a decision sequence over host effects.
async fn register(
    ctx: &RequestCtx,
    host: u16,
    name: Option<&Value>,
    raw_path: Option<&Value>,
    create: Option<&Value>,
    sample: bool,
) -> Result<Value, Response<Body>> {
    let dir_name = trimmed_input(name);
    let raw = trimmed_input(raw_path);
    let want_create = create == Some(&Value::Bool(true))
        || matches!(create, Some(Value::String(text)) if text == "true");
    if dir_name.is_empty() || raw.is_empty() {
        return Err(refusal(ctx, "invalid", "name and path required", None));
    }
    let resolved = resolve_path(ctx, host, &raw).await?;
    let (reals, real_home) = real_paths(ctx, host, std::slice::from_ref(&resolved)).await?;
    let real_resolved = reals.first().cloned().unwrap_or_default();
    if is_home_or_above(&real_resolved, &real_home) {
        return Err(refusal(
            ctx,
            "invalid",
            "不允许选择 $HOME 或更高层目录",
            None,
        ));
    }
    let (exists, is_dir) = path_facts(ctx, host, std::slice::from_ref(&resolved)).await?;
    let exists = exists.first().copied().unwrap_or(false);
    let is_dir = is_dir.first().copied().unwrap_or(false);
    if !exists {
        if !want_create {
            return Err(refusal(
                ctx,
                "invalid",
                &format!("path does not exist: {resolved}"),
                None,
            ));
        }
        let made = call(ctx, host, json!({"op": "mkdirp", "path": resolved})).await?;
        if let Some(Value::String(error)) = made.get("error") {
            return Err(refusal(
                ctx,
                "invalid",
                &format!("无法创建目录: {error}"),
                None,
            ));
        }
    } else if !is_dir {
        return Err(unsupported_path(ctx, &resolved));
    }
    let dup = call(
        ctx,
        host,
        json!({"op": "find-by-path", "path": resolved, "excludeId": Value::Null}),
    )
    .await?;
    if let Some(found) = dup.get("found").filter(|value| !value.is_null()) {
        return Err(refusal(
            ctx,
            "invalid",
            &format!(
                "该路径已被目录 \"{}\" 登记，不允许重复",
                string_field(found, "name")
            ),
            None,
        ));
    }
    let id_answer = call(ctx, host, json!({"op": "new-id"})).await?;
    let id = id_answer
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let mut dir = Map::new();
    dir.insert("id".into(), Value::String(id.clone()));
    dir.insert("name".into(), Value::String(dir_name));
    dir.insert("path".into(), Value::String(resolved));
    dir.insert("createdAt".into(), Value::String(iso_time(super::now_ms())));
    if sample {
        dir.insert("sample".into(), Value::Bool(true));
    }
    let dir = Value::Object(dir);
    call(ctx, host, json!({"op": "register-add", "dir": dir.clone()})).await?;
    let ready = call(ctx, host, json!({"op": "ensure-ready", "id": id})).await?;
    if ready.get("ok") != Some(&Value::Bool(true)) {
        let _ = call(ctx, host, json!({"op": "register-rollback", "id": id})).await?;
        let reason = member(&ready, "reason");
        let reason_text = if truthy(&reason) {
            js_string(&reason)
        } else {
            String::new()
        };
        let described = call(
            ctx,
            host,
            json!({"op": "dir-reason", "reason": reason_text}),
        )
        .await?;
        let detail = member(&described, "detail");
        let detail = if truthy(&detail) {
            js_string(&detail)
        } else {
            "目录初始化失败".to_string()
        };
        let fix = member(&described, "fix");
        let fix = if truthy(&fix) {
            fix
        } else if reason_text.starts_with("git-error: ") {
            Value::String("open-ops-terminal".into())
        } else {
            Value::Null
        };
        let extra = if truthy(&fix) {
            Some(json!({ "fix": fix }))
        } else {
            None
        };
        return Err(refusal(ctx, "invalid", &detail, extra.as_ref()));
    }
    let committed = call(ctx, host, json!({"op": "register-commit", "id": id})).await?;
    if committed.get("error").is_some() {
        return Err(internal_error(ctx));
    }
    // The host's readiness probe stamps `baseBranch`/`gitInitialized` onto the
    // registered record (and seeding the commander chat may add its own field),
    // so the answer is the record as it now lives, exactly like the retired
    // handler returning the object it had just mutated.
    Ok(match committed.get("dir") {
        Some(value) if !value.is_null() => value.clone(),
        _ => dir,
    })
}

async fn dirs_create(ctx: &RequestCtx, host: u16, body: &Value) -> Response<Body> {
    match register(
        ctx,
        host,
        body.get("name"),
        body.get("path"),
        body.get("create"),
        false,
    )
    .await
    {
        Ok(dir) => ok(ctx, dir),
        Err(response) => response,
    }
}

async fn sample_workspace(ctx: &RequestCtx, host: u16) -> Response<Body> {
    let sample = match call(ctx, host, json!({"op": "sample-ensure"})).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    if sample.get("error").is_some() {
        return internal_error(ctx);
    }
    let path = member(&sample, "path");
    let created_files = member(&sample, "createdFiles");
    let found = match call(
        ctx,
        host,
        json!({"op": "find-by-path", "path": path, "excludeId": Value::Null}),
    )
    .await
    {
        Ok(value) => value,
        Err(response) => return response,
    };
    if let Some(existing) = found.get("found").filter(|value| !value.is_null()) {
        let mut dir = existing.clone();
        if existing.get("sample") != Some(&Value::Bool(true)) {
            let marked = match call(
                ctx,
                host,
                json!({"op": "sample-mark", "id": member(existing, "id")}),
            )
            .await
            {
                Ok(value) => value,
                Err(response) => return response,
            };
            if marked.get("error").is_some() {
                return internal_error(ctx);
            }
            dir = member(&marked, "dir");
        }
        return ok(
            ctx,
            with_fields(
                &dir,
                vec![
                    ("reused", Value::Bool(true)),
                    ("createdFiles", created_files),
                ],
            ),
        );
    }
    let name = member(&sample, "name");
    let raw = json!(path.as_str().unwrap_or(""));
    match register(
        ctx,
        host,
        Some(&name),
        Some(&raw),
        Some(&Value::Bool(true)),
        true,
    )
    .await
    {
        Ok(dir) => ok(
            ctx,
            with_fields(
                &dir,
                vec![
                    ("reused", Value::Bool(false)),
                    ("createdFiles", created_files),
                ],
            ),
        ),
        Err(response) => response,
    }
}

async fn dirs_order(ctx: &RequestCtx, host: u16, body: &Value) -> Response<Body> {
    let ids = body.get("ids").cloned().unwrap_or(Value::Null);
    let Value::Array(items) = ids else {
        return refusal(ctx, "invalid", "ids array required", None);
    };
    let known_answer = match call(ctx, host, json!({"op": "dir-ids"})).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let known: Vec<String> = array_of(&known_answer, "ids")
        .iter()
        .map(|item| item.as_str().unwrap_or("").to_string())
        .collect();
    let wanted = reorder_plan(&items, &known);
    let mut order = wanted.clone();
    order.extend(reorder_tail(&known, &wanted));
    let answer = match call(ctx, host, json!({"op": "dirs-reorder", "order": order})).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    if answer.get("error").is_some() {
        return internal_error(ctx);
    }
    ok(ctx, json!({"ok": true, "ids": member(&answer, "ids")}))
}

async fn dir_update(ctx: &RequestCtx, host: u16, id: &str, body: &Value) -> Response<Body> {
    let found = match call(ctx, host, json!({"op": "dir-get", "id": id})).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    if found.get("dir").is_none_or(Value::is_null) {
        return not_found(ctx);
    }
    if truthy_opt(body.get("name")) {
        let name = js_trim(&js_string(body.get("name").unwrap_or(&Value::Null))).to_string();
        let applied = match call(
            ctx,
            host,
            json!({"op": "dir-set-name", "id": id, "name": name}),
        )
        .await
        {
            Ok(value) => value,
            Err(response) => return response,
        };
        if applied.get("error").is_some() {
            return internal_error(ctx);
        }
    }
    if truthy_opt(body.get("path")) {
        let raw = js_trim(&js_string(body.get("path").unwrap_or(&Value::Null))).to_string();
        let resolved = match resolve_path(ctx, host, &raw).await {
            Ok(value) => value,
            Err(response) => return response,
        };
        let (exists, _is_dir) = match path_facts(ctx, host, std::slice::from_ref(&resolved)).await {
            Ok(value) => value,
            Err(response) => return response,
        };
        if !exists.first().copied().unwrap_or(false) {
            return refusal(
                ctx,
                "invalid",
                &format!("path does not exist: {resolved}"),
                None,
            );
        }
        let (reals, real_home) = match real_paths(ctx, host, std::slice::from_ref(&resolved)).await
        {
            Ok(value) => value,
            Err(response) => return response,
        };
        if is_home_or_above(reals.first().map(String::as_str).unwrap_or(""), &real_home) {
            return refusal(ctx, "invalid", "不允许选择 $HOME 或更高层目录", None);
        }
        let dup = match call(
            ctx,
            host,
            json!({"op": "find-by-path", "path": resolved, "excludeId": id}),
        )
        .await
        {
            Ok(value) => value,
            Err(response) => return response,
        };
        if let Some(other) = dup.get("found").filter(|value| !value.is_null()) {
            return refusal(
                ctx,
                "invalid",
                &format!(
                    "该路径已被目录 \"{}\" 登记，不允许重复",
                    string_field(other, "name")
                ),
                None,
            );
        }
        let equal = match call(
            ctx,
            host,
            json!({"op": "realpath-equal", "id": id, "path": resolved}),
        )
        .await
        {
            Ok(value) => value,
            Err(response) => return response,
        };
        if equal.get("equal") != Some(&Value::Bool(true)) {
            let applied = match call(
                ctx,
                host,
                json!({"op": "dir-set-path", "id": id, "path": resolved}),
            )
            .await
            {
                Ok(value) => value,
                Err(response) => return response,
            };
            if applied.get("error").is_some() {
                return internal_error(ctx);
            }
            let ready = match call(ctx, host, json!({"op": "ensure-ready", "id": id})).await {
                Ok(value) => value,
                Err(response) => return response,
            };
            if ready.get("ok") != Some(&Value::Bool(true)) {
                let reason = member(&ready, "reason");
                let reason_text = if truthy(&reason) {
                    js_string(&reason)
                } else {
                    String::new()
                };
                let described = match call(
                    ctx,
                    host,
                    json!({"op": "dir-reason", "reason": reason_text}),
                )
                .await
                {
                    Ok(value) => value,
                    Err(response) => return response,
                };
                let detail = member(&described, "detail");
                let detail = if truthy(&detail) {
                    js_string(&detail)
                } else {
                    "目录初始化失败".to_string()
                };
                let fix = member(&described, "fix");
                let fix = if truthy(&fix) {
                    fix
                } else if reason_text.starts_with("git-error: ") {
                    Value::String("open-ops-terminal".into())
                } else {
                    Value::Null
                };
                let extra = if truthy(&fix) {
                    Some(json!({ "fix": fix }))
                } else {
                    None
                };
                return refusal(ctx, "invalid", &detail, extra.as_ref());
            }
        }
    }
    if let Some(role) = body.get("rolePrompt") {
        let prompt = if role.is_null() {
            String::new()
        } else {
            js_string(role)
        };
        if utf16_len(&prompt) > MAX_ROLE_PROMPT {
            return refusal(ctx, "invalid", "rolePrompt too long (max 40000)", None);
        }
        let trimmed = js_trim(&prompt);
        let value = if trimmed.is_empty() {
            Value::Null
        } else {
            Value::String(trimmed.to_string())
        };
        let applied = match call(
            ctx,
            host,
            json!({"op": "dir-set-role", "id": id, "value": value}),
        )
        .await
        {
            Ok(value) => value,
            Err(response) => return response,
        };
        if applied.get("error").is_some() {
            return internal_error(ctx);
        }
    }
    let saved = match call(ctx, host, json!({"op": "dir-save"})).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    if saved.get("error").is_some() {
        return internal_error(ctx);
    }
    let final_dir = match call(ctx, host, json!({"op": "dir-get", "id": id})).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    ok(ctx, member(&final_dir, "dir"))
}

async fn dir_delete(ctx: &RequestCtx, host: u16, id: &str, force: bool) -> Response<Body> {
    let found = match call(ctx, host, json!({"op": "dir-get", "id": id})).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    if found.get("dir").is_none_or(Value::is_null) {
        return not_found(ctx);
    }
    let answer = match call(ctx, host, json!({"op": "sessions-by-dir", "id": id})).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let sessions = array_of(&answer, "sessions");
    if !sessions.is_empty() && !force {
        let ids: Vec<Value> = sessions
            .iter()
            .map(|session| session.get("id").cloned().unwrap_or(Value::Null))
            .collect();
        return refusal(
            ctx,
            "invalid",
            &format!(
                "directory has {} session(s); pass ?force=1 to delete them too",
                sessions.len()
            ),
            Some(&json!({ "sessions": ids })),
        );
    }
    for session in &sessions {
        let destroyed = match call(
            ctx,
            host,
            json!({
                "op": "destroy-cascade",
                "sessionId": session.get("id").cloned().unwrap_or(Value::Null),
                "session": session,
                "dirId": id,
                "force": force,
            }),
        )
        .await
        {
            Ok(value) => value,
            Err(response) => return response,
        };
        let result = member(&destroyed, "result");
        if result.get("ok") == Some(&Value::Bool(false)) {
            return refusal(
                ctx,
                "invalid",
                &string_field(&result, "error"),
                Some(&result),
            );
        }
    }
    let removed = match call(ctx, host, json!({"op": "dir-remove", "id": id})).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    if removed.get("error").is_some() {
        return internal_error(ctx);
    }
    let committed = match call(
        ctx,
        host,
        json!({"op": "tx-commit", "id": id, "force": force}),
    )
    .await
    {
        Ok(value) => value,
        Err(response) => return response,
    };
    if let Some(Value::String(error)) = committed.get("error") {
        return refusal(ctx, "internal", &format!("persist failed: {error}"), None);
    }
    ok(ctx, json!({"ok": true, "removedSessions": sessions.len()}))
}

async fn dir_push(ctx: &RequestCtx, host: u16, id: &str) -> Response<Body> {
    let found = match call(ctx, host, json!({"op": "dir-get", "id": id})).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    if found.get("dir").is_none_or(Value::is_null) {
        return not_found(ctx);
    }
    let answer = match call(ctx, host, json!({"op": "git-push", "id": id})).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    if let Some(Value::String(error)) = answer.get("error") {
        return refusal(ctx, "invalid", error, None);
    }
    let result = member(&answer, "result");
    let pushed = result.get("pushed").map(truthy).unwrap_or(false);
    let text = if pushed {
        let before = member(&result, "before");
        format!(
            "{} 个提交 → {}/{}",
            string_field(&before, "ahead"),
            string_field(&before, "remote"),
            string_field(&before, "remoteBranch")
        )
    } else {
        "无待推送提交".to_string()
    };
    let _ = call(
        ctx,
        host,
        json!({"op": "events-append", "dirId": id, "kind": "pushed", "text": text}),
    )
    .await;
    ok(ctx, merge_ok(&result))
}

async fn dir_uncommitted(ctx: &RequestCtx, host: u16, id: &str) -> Response<Body> {
    let found = match call(ctx, host, json!({"op": "dir-get", "id": id})).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    if found.get("dir").is_none_or(Value::is_null) {
        return not_found(ctx);
    }
    let answer = match call(ctx, host, json!({"op": "status-porcelain", "id": id})).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    if let Some(Value::String(error)) = answer.get("error") {
        return refusal(ctx, "invalid", error, None);
    }
    let out = answer.get("out").and_then(Value::as_str).unwrap_or("");
    ok(ctx, json!({ "files": parse_porcelain(out) }))
}

async fn dir_commit(ctx: &RequestCtx, host: u16, id: &str, body: &Value) -> Response<Body> {
    let found = match call(ctx, host, json!({"op": "dir-get", "id": id})).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    if found.get("dir").is_none_or(Value::is_null) {
        return not_found(ctx);
    }
    let facts = match call(ctx, host, json!({"op": "commit-facts", "id": id})).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    if let Some(Value::String(error)) = facts.get("error") {
        return refusal(ctx, "invalid", error, None);
    }
    let before = member(&facts, "pushState");
    let dirty_zero = matches!(
        before.get("dirty"),
        Some(Value::Number(number)) if number.as_f64() == Some(0.0)
    );
    if dirty_zero {
        return ok(
            ctx,
            json!({"ok": true, "committed": false, "pushState": before}),
        );
    }
    let mut message = match body.get("message") {
        Some(value) if truthy(value) => js_trim(&js_string(value)).to_string(),
        _ => String::new(),
    };
    if message.is_empty() {
        let answer = match call(ctx, host, json!({"op": "commit-default-message", "id": id})).await
        {
            Ok(value) => value,
            Err(response) => return response,
        };
        if let Some(Value::String(error)) = answer.get("error") {
            return refusal(ctx, "invalid", error, None);
        }
        message = answer
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
    }
    let valid = match call(
        ctx,
        host,
        json!({"op": "commit-validate", "message": message}),
    )
    .await
    {
        Ok(value) => value,
        Err(response) => return response,
    };
    if let Some(Value::String(error)) = valid.get("error") {
        return refusal(ctx, "invalid", error, None);
    }
    let run = match call(
        ctx,
        host,
        json!({"op": "commit-run", "id": id, "message": message}),
    )
    .await
    {
        Ok(value) => value,
        Err(response) => return response,
    };
    if let Some(Value::String(error)) = run.get("error") {
        return refusal(ctx, "invalid", error, None);
    }
    let after = member(&run, "pushState");
    let after_ahead = after.get("ahead").and_then(Value::as_f64);
    let before_ahead = before.get("ahead").and_then(Value::as_f64);
    let count = match (after_ahead, before_ahead) {
        (Some(after), Some(before)) if after > before => after - before,
        _ => before.get("dirty").and_then(Value::as_f64).unwrap_or(0.0),
    };
    let text = format!("提交 {} 个未提交改动", format_f64(count));
    let _ = call(
        ctx,
        host,
        json!({"op": "events-append", "dirId": id, "kind": "committed", "text": text}),
    )
    .await;
    ok(
        ctx,
        json!({"ok": true, "committed": true, "pushState": after}),
    )
}

// ── UI layout ─────────────────────────────────────────────────────────────

/// The in-memory layout document: loaded lazily through the host store, then
/// structurally normalized exactly like `ui-layout.js`'s `load()`.
async fn layout_doc(ctx: &RequestCtx, host: u16) -> Result<Value, Response<Body>> {
    let answer = call(ctx, host, json!({"op": "layout-load"})).await?;
    let data = if answer.get("present") == Some(&Value::Bool(true)) {
        member(&answer, "data")
    } else {
        Value::Null
    };
    Ok(normalize_layout(&data, None))
}

async fn layout_known(ctx: &RequestCtx, host: u16) -> Result<UiKnown, Response<Body>> {
    let answer = call(ctx, host, json!({"op": "layout-known"})).await?;
    let mut known = UiKnown::default();
    for id in array_of(&answer, "dirIds") {
        if let Some(text) = id.as_str() {
            known.dir_ids.insert(text.to_string());
        }
    }
    if let Some(Value::Object(by_dir)) = answer.get("sessionIds") {
        for (dir_id, ids) in by_dir {
            let set: std::collections::HashSet<String> = ids
                .as_array()
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            known.session_ids.insert(dir_id.clone(), set);
        }
    }
    Ok(known)
}

async fn layout_get(ctx: &RequestCtx, host: u16) -> Response<Body> {
    let doc = match layout_doc(ctx, host).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let known = match layout_known(ctx, host).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    ok(
        ctx,
        json!({"ok": true, "layout": normalize_layout(&doc, Some(&known))}),
    )
}

async fn layout_dir_order(ctx: &RequestCtx, host: u16, body: &Value) -> Response<Body> {
    let order = body.get("order").cloned().unwrap_or(Value::Null);
    if !order.is_array() {
        return express::json(
            ctx,
            400,
            &json!({"error": "order must be an array of directory ids"}),
            &[],
        );
    }
    let mut doc = match layout_doc(ctx, host).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let known = match layout_known(ctx, host).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    apply_dir_order(&mut doc, &order, &known.dir_ids);
    stamp_updated_at(&mut doc, &iso_time(super::now_ms()));
    if let Err(response) = call(ctx, host, json!({"op": "layout-save", "doc": doc})).await {
        return response;
    }
    ok(
        ctx,
        json!({"ok": true, "layout": normalize_layout(&doc, Some(&known))}),
    )
}

async fn layout_session_order(
    ctx: &RequestCtx,
    host: u16,
    dir_id: &str,
    body: &Value,
) -> Response<Body> {
    let order = body.get("order").cloned().unwrap_or(Value::Null);
    if !order.is_array() {
        return express::json(
            ctx,
            400,
            &json!({"error": "order must be an array of session ids"}),
            &[],
        );
    }
    let mut doc = match layout_doc(ctx, host).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let known = match layout_known(ctx, host).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    if !apply_session_order(&mut doc, dir_id, &order, &known) {
        return express::json(ctx, 404, &json!({"error": "directory not found"}), &[]);
    }
    stamp_updated_at(&mut doc, &iso_time(super::now_ms()));
    if let Err(response) = call(ctx, host, json!({"op": "layout-save", "doc": doc})).await {
        return response;
    }
    ok(
        ctx,
        json!({"ok": true, "layout": normalize_layout(&doc, Some(&known))}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allow(method: &str, path: &str) -> Option<&'static str> {
        match claim(&Method::from_bytes(method.as_bytes()).unwrap(), path) {
            Some(Route::Options { allow }) => Some(allow),
            _ => None,
        }
    }

    #[test]
    fn claims_the_thirteen_paths_and_their_automatic_options() {
        let cases = [
            ("GET", "/api/fs/list", Route::FsList),
            ("HEAD", "/api/fs/list", Route::FsList),
            ("GET", "/api/directories", Route::DirsList),
            ("HEAD", "/api/directories", Route::DirsList),
            ("POST", "/api/directories", Route::DirsCreate),
            (
                "POST",
                "/api/onboarding/sample-workspace",
                Route::SampleWorkspace,
            ),
            ("PUT", "/api/directories/order", Route::DirsOrder),
            ("PATCH", "/api/directories/d1", Route::DirUpdate),
            ("DELETE", "/api/directories/d1", Route::DirDelete),
            ("POST", "/api/directories/d1/push", Route::DirPush),
            (
                "GET",
                "/api/directories/d1/uncommitted",
                Route::DirUncommitted,
            ),
            (
                "HEAD",
                "/api/directories/d1/uncommitted",
                Route::DirUncommitted,
            ),
            ("POST", "/api/directories/d1/commit", Route::DirCommit),
            ("GET", "/api/ui-layout", Route::LayoutGet),
            ("HEAD", "/api/ui-layout", Route::LayoutGet),
            ("PUT", "/api/ui-layout/dir-order", Route::LayoutDirOrder),
            (
                "PUT",
                "/api/ui-layout/session-order/d1",
                Route::LayoutSessionOrder,
            ),
        ];
        for (method, path, expected) in cases {
            assert_eq!(
                claim(&Method::from_bytes(method.as_bytes()).unwrap(), path),
                Some(expected),
                "{method} {path}"
            );
        }
        assert_eq!(allow("OPTIONS", "/api/fs/list"), Some("GET,HEAD"));
        assert_eq!(allow("OPTIONS", "/api/directories"), Some("GET,HEAD,POST"));
        assert_eq!(
            allow("OPTIONS", "/api/onboarding/sample-workspace"),
            Some("POST")
        );
        assert_eq!(
            allow("OPTIONS", "/api/directories/order"),
            Some("PUT,PATCH,DELETE")
        );
        assert_eq!(
            allow("OPTIONS", "/api/directories/d1"),
            Some("PATCH,DELETE")
        );
        assert_eq!(allow("OPTIONS", "/api/directories/d1/push"), Some("POST"));
        assert_eq!(
            allow("OPTIONS", "/api/directories/d1/uncommitted"),
            Some("GET,HEAD")
        );
        assert_eq!(allow("OPTIONS", "/api/ui-layout"), Some("GET,HEAD"));
        assert_eq!(allow("OPTIONS", "/api/ui-layout/dir-order"), Some("PUT"));
        assert_eq!(
            allow("OPTIONS", "/api/ui-layout/session-order/d1"),
            Some("PUT")
        );
        assert_eq!(allow("OPTIONS", "/api/fs"), None);
    }

    #[test]
    fn literal_segments_are_case_insensitive_and_trailing_slash_is_optional() {
        assert_eq!(
            claim(&Method::from_bytes(b"GET").unwrap(), "/API/Fs/List"),
            None,
            "the /api/ prefix itself is case-sensitive"
        );
        assert_eq!(
            claim(&Method::from_bytes(b"GET").unwrap(), "/api/FS/LIST"),
            Some(Route::FsList)
        );
        assert_eq!(
            claim(&Method::from_bytes(b"GET").unwrap(), "/api/fs/list/"),
            Some(Route::FsList)
        );
        assert_eq!(
            claim(
                &Method::from_bytes(b"PUT").unwrap(),
                "/api/Directories/Order"
            ),
            Some(Route::DirsOrder)
        );
        assert_eq!(
            claim(&Method::from_bytes(b"GET").unwrap(), "/api/fs/list//"),
            None
        );
    }

    #[test]
    fn the_literal_order_route_wins_for_put_and_patch_order_is_the_404() {
        assert_eq!(
            claim(
                &Method::from_bytes(b"PUT").unwrap(),
                "/api/directories/order"
            ),
            Some(Route::DirsOrder)
        );
        // `PATCH /api/directories/order` is the retired `:id = "order"` update,
        // which answered 404 `directory not found`.
        assert_eq!(
            claim(
                &Method::from_bytes(b"PATCH").unwrap(),
                "/api/directories/order"
            ),
            Some(Route::DirUpdate)
        );
        assert_eq!(
            claim(
                &Method::from_bytes(b"DELETE").unwrap(),
                "/api/directories/order"
            ),
            Some(Route::DirDelete)
        );
        // A bare `PATCH /api/directories/:id` claim must not swallow a trailing
        // segment: those paths belong to other clusters.
        assert_eq!(
            claim(
                &Method::from_bytes(b"PATCH").unwrap(),
                "/api/directories/d1/extra"
            ),
            None
        );
    }

    #[test]
    fn the_directory_claims_do_not_shadow_session_admin_or_memory_routes() {
        // Shapes owned by session-admin, docs-memory and voice-gateway.
        let foreign = [
            ("GET", "/api/directories/d1/sessions"),
            ("POST", "/api/directories/d1/sessions"),
            ("GET", "/api/directories/d1/workspace"),
            ("GET", "/api/directories/d1/memo"),
            ("PUT", "/api/directories/d1/memo"),
            ("POST", "/api/directories/d1/memo/send"),
            ("GET", "/api/directories/d1/events"),
            ("POST", "/api/directories/d1/voice-gateway"),
            ("GET", "/api/directories/d1/voice-gateway/status"),
        ];
        for (method, path) in foreign {
            assert_eq!(
                claim(&Method::from_bytes(method.as_bytes()).unwrap(), path),
                None,
                "{method} {path} must stay with its own cluster"
            );
        }
        // Our three literals are the only 3-segment claims on this prefix.
        assert_eq!(
            claim(
                &Method::from_bytes(b"POST").unwrap(),
                "/api/directories/d1/push"
            ),
            Some(Route::DirPush)
        );
        assert_eq!(
            claim(
                &Method::from_bytes(b"POST").unwrap(),
                "/api/directories/d1/commit"
            ),
            Some(Route::DirCommit)
        );
        assert_eq!(
            claim(
                &Method::from_bytes(b"GET").unwrap(),
                "/api/directories/d1/uncommitted"
            ),
            Some(Route::DirUncommitted)
        );
    }
}
