//! Session/git routes retired from `src/routes/session-git.js`:
//!
//! * `GET/HEAD /api/sessions/:id/merge-status`, `.../diff`, `.../diff/files`,
//!   `.../diff/file`
//! * `GET/HEAD /api/git/log`, `.../commit-files`, `.../commit-diff`,
//!   `.../directory-file-diff`, `.../directory-status`
//! * `GET/HEAD /api/task-board/tasks/:taskId/diff/files`, `.../diff/file`
//! * `POST /api/task-board/tasks/:taskId/merge`, `.../cleanup-worktree`
//! * `POST /api/sessions/:id/merge`, `.../sync`, `.../rebase`
//!
//! Parsing the git output, `:id`/`:taskId` matching, query validation, DTO
//! assembly and key order, the error-text mapping and the merge/sync/rebase
//! status trees live here and in `multicc_core::session_git`. Node keeps what
//! Rust cannot see behind one host port, `POST /api/__host/session-git`
//! (src/routes/session-git-host.js): spawning `git` through the repository
//! actor (runtime-patched `PATH`, non-interactive environment), the
//! session/directory `Map` lookups, `isChatStateBusy`, the merge-state cache and
//! the executable merge/sync/rebase/cleanup flows.
//!
//! The five write routes await one or more host round trips and mutate real
//! worktrees, so [`App::session_git_write`] serializes them like the single
//! event-loop thread did.

// Express refusals are values here (`Err(Response)`), so the error variant is a
// full response body; the same shape is allowed in `native/addon` and
// `native/cdpd` rather than boxing every refusal at every call site.
#![allow(clippy::result_large_err)]

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Method, Response};
use multicc_core::http_gate::{query_param, query_string, query_value, QueryParam};
use multicc_core::js::serde::truthy;
use multicc_core::js::string::js_trim;
use multicc_core::session_git::{self, MAX_DIFF_BYTES};
use serde_json::{json, Map, Value};

use crate::app::express::{self, RequestCtx};
use crate::app::App;
use crate::host_port;

/// The host port the Node child serves (`src/routes/session-git-host.js`).
const HOST_PATH: &str = "/api/__host/session-git";

const DIFF_MAX_BUFFER: usize = MAX_DIFF_BYTES + 16 * 1024;
const PATCH_MAX_BUFFER: usize = 512 * 1024 + 16 * 1024;
const NUMSTAT_MAX_BUFFER: usize = 4 * 1024 * 1024;
const NAME_STATUS_MAX_BUFFER: usize = 1024 * 1024;
const STAT_MAX_BUFFER: usize = 256 * 1024;
const SMALL_BUFFER: usize = 4096;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Route {
    MergeStatusGet,
    MergeStatusOptions,
    DiffGet,
    DiffOptions,
    DiffFilesGet,
    DiffFilesOptions,
    DiffFileGet,
    DiffFileOptions,
    GitLogGet,
    GitLogOptions,
    CommitFilesGet,
    CommitFilesOptions,
    CommitDiffGet,
    CommitDiffOptions,
    DirectoryFileDiffGet,
    DirectoryFileDiffOptions,
    DirectoryStatusGet,
    DirectoryStatusOptions,
    TaskDiffFilesGet,
    TaskDiffFilesOptions,
    TaskDiffFileGet,
    TaskDiffFileOptions,
    TaskMergePost,
    TaskMergeOptions,
    TaskCleanupPost,
    TaskCleanupOptions,
    SessionMergePost,
    SessionMergeOptions,
    SessionSyncPost,
    SessionSyncOptions,
    SessionRebasePost,
    SessionRebaseOptions,
}

fn get_like(method: &Method) -> bool {
    matches!(method.as_str(), "GET" | "HEAD")
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
    if literal(parts[0], "sessions") {
        return match parts.len() {
            3 => match parts[2].to_ascii_lowercase().as_str() {
                "merge-status" if get_like(method) => Some(Route::MergeStatusGet),
                "merge-status" if method.as_str() == "OPTIONS" => Some(Route::MergeStatusOptions),
                "diff" if get_like(method) => Some(Route::DiffGet),
                "diff" if method.as_str() == "OPTIONS" => Some(Route::DiffOptions),
                "merge" if method.as_str() == "POST" => Some(Route::SessionMergePost),
                "merge" if method.as_str() == "OPTIONS" => Some(Route::SessionMergeOptions),
                "sync" if method.as_str() == "POST" => Some(Route::SessionSyncPost),
                "sync" if method.as_str() == "OPTIONS" => Some(Route::SessionSyncOptions),
                "rebase" if method.as_str() == "POST" => Some(Route::SessionRebasePost),
                "rebase" if method.as_str() == "OPTIONS" => Some(Route::SessionRebaseOptions),
                _ => None,
            },
            4 if literal(parts[2], "diff") => match parts[3].to_ascii_lowercase().as_str() {
                "files" if get_like(method) => Some(Route::DiffFilesGet),
                "files" if method.as_str() == "OPTIONS" => Some(Route::DiffFilesOptions),
                "file" if get_like(method) => Some(Route::DiffFileGet),
                "file" if method.as_str() == "OPTIONS" => Some(Route::DiffFileOptions),
                _ => None,
            },
            _ => None,
        };
    }
    if literal(parts[0], "git") && parts.len() == 2 {
        return match parts[1].to_ascii_lowercase().as_str() {
            "log" if get_like(method) => Some(Route::GitLogGet),
            "log" if method.as_str() == "OPTIONS" => Some(Route::GitLogOptions),
            "commit-files" if get_like(method) => Some(Route::CommitFilesGet),
            "commit-files" if method.as_str() == "OPTIONS" => Some(Route::CommitFilesOptions),
            "commit-diff" if get_like(method) => Some(Route::CommitDiffGet),
            "commit-diff" if method.as_str() == "OPTIONS" => Some(Route::CommitDiffOptions),
            "directory-file-diff" if get_like(method) => Some(Route::DirectoryFileDiffGet),
            "directory-file-diff" if method.as_str() == "OPTIONS" => {
                Some(Route::DirectoryFileDiffOptions)
            }
            "directory-status" if get_like(method) => Some(Route::DirectoryStatusGet),
            "directory-status" if method.as_str() == "OPTIONS" => {
                Some(Route::DirectoryStatusOptions)
            }
            _ => None,
        };
    }
    if literal(parts[0], "task-board") && parts.len() >= 2 && literal(parts[1], "tasks") {
        return match parts.len() {
            4 => match parts[3].to_ascii_lowercase().as_str() {
                "merge" if method.as_str() == "POST" => Some(Route::TaskMergePost),
                "merge" if method.as_str() == "OPTIONS" => Some(Route::TaskMergeOptions),
                "cleanup-worktree" if method.as_str() == "POST" => Some(Route::TaskCleanupPost),
                "cleanup-worktree" if method.as_str() == "OPTIONS" => {
                    Some(Route::TaskCleanupOptions)
                }
                _ => None,
            },
            5 if literal(parts[3], "diff") => match parts[4].to_ascii_lowercase().as_str() {
                "files" if get_like(method) => Some(Route::TaskDiffFilesGet),
                "files" if method.as_str() == "OPTIONS" => Some(Route::TaskDiffFilesOptions),
                "file" if get_like(method) => Some(Route::TaskDiffFileGet),
                "file" if method.as_str() == "OPTIONS" => Some(Route::TaskDiffFileOptions),
                _ => None,
            },
            _ => None,
        };
    }
    None
}

/// `decodeURIComponent` for one parameter; `None` is Express's 400.
fn decode(raw: &str) -> Option<String> {
    super::download::decode_uri_component(raw)
}

fn session_param(path: &str) -> Option<String> {
    let parts = segments(path)?;
    if literal(parts[0], "sessions") && parts.len() >= 3 {
        decode(parts[1])
    } else {
        None
    }
}

fn task_param(path: &str) -> Option<String> {
    let parts = segments(path)?;
    if literal(parts[0], "task-board") && literal(parts[1], "tasks") && parts.len() >= 4 {
        decode(parts[2])
    } else {
        None
    }
}

fn bad_param(ctx: &RequestCtx) -> Response<Body> {
    express::error(ctx, 400, "Failed to decode param")
}

fn unavailable(ctx: &RequestCtx) -> Response<Body> {
    express::json(
        ctx,
        503,
        &json!({
            "error": "会话 Git 接口尚未就绪，请更新原生模块",
            "code": "rust_backend_unavailable",
        }),
        &[],
    )
}

fn error_json(ctx: &RequestCtx, status: u16, message: &str) -> Response<Body> {
    express::json(ctx, status, &json!({ "error": message }), &[])
}

async fn host(host_port_num: u16, payload: Value) -> Option<Value> {
    host_port::call(host_port_num, HOST_PATH, &payload)
        .await
        .ok()
}

/// `req.query[name]` as a string only when it is exactly one plain pair.
fn q_text(ctx: &RequestCtx, name: &str) -> Option<String> {
    match query_param(&ctx.original_url, name) {
        QueryParam::Text(text) => Some(text),
        _ => None,
    }
}

fn q_truthy(ctx: &RequestCtx, name: &str) -> bool {
    match query_param(&ctx.original_url, name) {
        QueryParam::Missing => false,
        QueryParam::Text(text) => !text.is_empty(),
        QueryParam::Other => true,
    }
}

fn q_is_one(ctx: &RequestCtx, name: &str) -> bool {
    matches!(query_param(&ctx.original_url, name), QueryParam::Text(value) if value == "1")
}

fn field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn non_empty_field(value: &Value, key: &str) -> Option<String> {
    field(value, key)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn bool_field(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

struct GitFailure {
    stderr: Option<String>,
    message: Option<String>,
    max_buffer: bool,
}

impl GitFailure {
    fn text(&self) -> String {
        session_git::error_text(self.stderr.as_deref(), self.message.as_deref())
    }
}

enum GitResult {
    Output(String),
    Failed(GitFailure),
    Down,
}

/// `deps.gitRunQueued(repo, args, { maxBuffer, raw })`.
async fn run_git(
    host_port_num: u16,
    repo: &str,
    args: Vec<String>,
    max_buffer: usize,
    raw: bool,
) -> GitResult {
    let payload = json!({
        "op": "git",
        "repo": repo,
        "args": args,
        "maxBuffer": max_buffer,
        "raw": raw,
    });
    let Some(answer) = host(host_port_num, payload).await else {
        return GitResult::Down;
    };
    if answer.get("ok") == Some(&Value::Bool(true)) {
        return GitResult::Output(field(&answer, "stdout").unwrap_or("").to_string());
    }
    GitResult::Failed(GitFailure {
        stderr: field(&answer, "stderr").map(str::to_string),
        message: field(&answer, "message").map(str::to_string),
        max_buffer: bool_field(&answer, "maxBuffer"),
    })
}

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_string()).collect()
}

struct Found {
    persisted: Value,
    dir: Value,
    worktree_exists: bool,
}

async fn find_session(
    host_port_num: u16,
    ctx: &RequestCtx,
    id: &str,
) -> Result<Found, Response<Body>> {
    let Some(answer) = host(host_port_num, json!({ "op": "session", "sessionId": id })).await
    else {
        return Err(unavailable(ctx));
    };
    if let Some(error) = field(&answer, "error") {
        let status: u16 = match error {
            "session not found" | "directory not found" => 404,
            _ => 503,
        };
        return Err(error_json(ctx, status, error));
    }
    let Some(persisted) = answer.get("session").cloned().filter(Value::is_object) else {
        return Err(unavailable(ctx));
    };
    Ok(Found {
        persisted,
        dir: answer.get("dir").cloned().unwrap_or(Value::Null),
        worktree_exists: bool_field(&answer, "worktreeExists"),
    })
}

/// `hasWorktree(record, res, message)` as a refusal, or `None` to continue.
fn has_worktree(found: &Found, ctx: &RequestCtx, message: &str) -> Option<Response<Body>> {
    if non_empty_field(&found.persisted, "worktreePath").is_some()
        && non_empty_field(&found.persisted, "branch").is_some()
        && found.worktree_exists
    {
        return None;
    }
    if field(&found.persisted, "workspaceState") == Some("hibernated") {
        return Some(express::json(
            ctx,
            409,
            &session_git::workspace_hibernated_body(),
            &[],
        ));
    }
    Some(error_json(ctx, 400, message))
}

/// `dir.baseBranch` or `deps.gitBaseBranch(dir.path)`.
async fn base_branch(
    host_port_num: u16,
    ctx: &RequestCtx,
    dir: &Value,
) -> Result<String, Response<Body>> {
    if let Some(branch) = non_empty_field(dir, "baseBranch") {
        return Ok(branch);
    }
    let Some(path) = field(dir, "path") else {
        return Err(unavailable(ctx));
    };
    let Some(answer) = host(
        host_port_num,
        json!({ "op": "base-branch", "dirPath": path }),
    )
    .await
    else {
        return Err(unavailable(ctx));
    };
    if answer.get("ok") == Some(&Value::Bool(true)) {
        return Ok(field(&answer, "baseBranch").unwrap_or("").to_string());
    }
    Err(error_json(
        ctx,
        500,
        &session_git::error_text(field(&answer, "stderr"), field(&answer, "message")),
    ))
}

/// `mergeStateCached` / `mergeStateFresh` for a session id.
async fn merge_state(
    host_port_num: u16,
    ctx: &RequestCtx,
    session_id: &str,
    refresh: bool,
    priority: bool,
) -> Result<Value, Response<Body>> {
    let Some(answer) = host(
        host_port_num,
        json!({
            "op": "merge-state",
            "sessionId": session_id,
            "refresh": refresh,
            "priority": priority,
        }),
    )
    .await
    else {
        return Err(unavailable(ctx));
    };
    merge_state_answer(ctx, &answer)
}

async fn merge_state_task(
    host_port_num: u16,
    ctx: &RequestCtx,
    task_id: &str,
) -> Result<Value, Response<Body>> {
    let Some(answer) = host(
        host_port_num,
        json!({
            "op": "merge-state",
            "taskId": task_id,
            "refresh": false,
            "priority": false,
        }),
    )
    .await
    else {
        return Err(unavailable(ctx));
    };
    merge_state_answer(ctx, &answer)
}

fn merge_state_answer(ctx: &RequestCtx, answer: &Value) -> Result<Value, Response<Body>> {
    if let Some(error) = field(answer, "error") {
        let status: u16 = match error {
            "session not found" | "directory not found" | "task_not_found" => 404,
            _ => 503,
        };
        return Err(error_json(ctx, status, error));
    }
    Ok(answer.get("value").cloned().unwrap_or(Value::Null))
}

/// `listUntrackedFiles(execGit, worktree)`: paths or `[]` on failure.
async fn list_untracked(host_port_num: u16, worktree: &str) -> Vec<String> {
    match run_git(
        host_port_num,
        worktree,
        strings(&[
            "-c",
            "core.quotepath=false",
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z",
        ]),
        NUMSTAT_MAX_BUFFER,
        false,
    )
    .await
    {
        GitResult::Output(raw) => raw
            .split('\0')
            .filter(|part| !part.is_empty())
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

struct UntrackedFact {
    path: String,
    additions: i64,
    binary: bool,
}

async fn read_facts(host_port_num: u16, worktree: &str, paths: &[String]) -> Vec<UntrackedFact> {
    let Some(answer) = host(
        host_port_num,
        json!({ "op": "read-facts", "worktree": worktree, "paths": paths }),
    )
    .await
    else {
        return Vec::new();
    };
    let mut facts = Vec::new();
    if let Some(Value::Array(items)) = answer.get("facts") {
        for item in items {
            let Some(path) = field(item, "path") else {
                continue;
            };
            facts.push(UntrackedFact {
                path: path.to_string(),
                additions: item.get("additions").and_then(Value::as_i64).unwrap_or(0),
                binary: bool_field(item, "binary"),
            });
        }
    }
    facts
}

struct TextFact {
    exists: bool,
    binary: bool,
    text: String,
}

async fn read_text(host_port_num: u16, worktree: &str, path: &str) -> Option<TextFact> {
    let answer = host(
        host_port_num,
        json!({ "op": "read-text", "worktree": worktree, "path": path }),
    )
    .await?;
    Some(TextFact {
        exists: bool_field(&answer, "exists"),
        binary: bool_field(&answer, "binary"),
        text: field(&answer, "text").unwrap_or("").to_string(),
    })
}

/// Append the untracked-file list (already capped at `FILE_CAP`) to a tracked
/// file array; returns `(all, untrackedCount)`.
async fn untracked_files(
    host_port_num: u16,
    worktree: &str,
    tracked: Vec<Value>,
) -> (Vec<Value>, usize) {
    let mut untracked: Vec<Value> = Vec::new();
    let paths: Vec<String> = list_untracked(host_port_num, worktree)
        .await
        .into_iter()
        .take(session_git::FILE_CAP)
        .collect();
    if !paths.is_empty() {
        for fact in read_facts(host_port_num, worktree, &paths).await {
            let mut entry = Map::new();
            entry.insert("path".into(), Value::String(fact.path));
            entry.insert("oldPath".into(), Value::Null);
            entry.insert("status".into(), json!("U"));
            entry.insert("additions".into(), json!(fact.additions));
            entry.insert("deletions".into(), json!(0));
            entry.insert("binary".into(), Value::Bool(fact.binary));
            untracked.push(Value::Object(entry));
        }
    }
    let count = untracked.len();
    let mut all = tracked;
    all.extend(untracked);
    (all, count)
}

fn total(files: &[Value], key: &str) -> i64 {
    files
        .iter()
        .map(|file| file.get(key).and_then(Value::as_i64).unwrap_or(0))
        .sum()
}

/// `GET|HEAD /api/sessions/:id/merge-status`.
async fn merge_status(ctx: &RequestCtx, host_port_num: u16) -> Response<Body> {
    let Some(id) = session_param(&ctx.path) else {
        return bad_param(ctx);
    };
    if let Err(response) = find_session(host_port_num, ctx, &id).await {
        return response;
    }
    let refresh = q_is_one(ctx, "refresh") || q_is_one(ctx, "fresh");
    match merge_state(host_port_num, ctx, &id, refresh, true).await {
        Ok(value) => express::json(ctx, 200, &value, &[]),
        Err(response) => response,
    }
}

/// `GET|HEAD /api/sessions/:id/diff`.
async fn diff(ctx: &RequestCtx, host_port_num: u16) -> Response<Body> {
    let Some(id) = session_param(&ctx.path) else {
        return bad_param(ctx);
    };
    let found = match find_session(host_port_num, ctx, &id).await {
        Ok(found) => found,
        Err(response) => return response,
    };
    let Some(worktree) = non_empty_field(&found.persisted, "worktreePath") else {
        return error_json(ctx, 400, "worktree missing");
    };
    if !found.worktree_exists {
        return error_json(ctx, 400, "worktree missing");
    }
    let base = match base_branch(host_port_num, ctx, &found.dir).await {
        Ok(branch) => branch,
        Err(response) => return response,
    };
    let (mut diff, mut truncated) = ("".to_string(), false);
    let mut error: Option<String> = None;
    match run_git(
        host_port_num,
        &worktree,
        strings(&["diff", "--no-color", &base]),
        DIFF_MAX_BUFFER,
        false,
    )
    .await
    {
        GitResult::Output(stdout) => {
            let capped = session_git::cap_diff(stdout);
            diff = capped.0;
            truncated = capped.1;
        }
        GitResult::Failed(failure) if failure.max_buffer => {
            truncated = true;
            diff = session_git::DIFF_TOO_LARGE.to_string();
        }
        GitResult::Failed(failure) => error = Some(failure.text()),
        GitResult::Down => return unavailable(ctx),
    }
    let mut stat = String::new();
    if let GitResult::Output(stdout) = run_git(
        host_port_num,
        &worktree,
        strings(&["diff", "--stat", "--no-color", &base]),
        STAT_MAX_BUFFER,
        false,
    )
    .await
    {
        stat = stdout;
    }
    let merge_state = match merge_state(host_port_num, ctx, &id, false, false).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let mut out = Map::new();
    out.insert("baseBranch".into(), Value::String(base));
    if let Some(branch) = found.persisted.get("branch") {
        out.insert("branch".into(), branch.clone());
    }
    out.insert("stat".into(), Value::String(stat));
    out.insert("diff".into(), Value::String(diff));
    out.insert("truncated".into(), Value::Bool(truncated));
    out.insert("mergeState".into(), merge_state);
    out.insert(
        "error".into(),
        error.map(Value::String).unwrap_or(Value::Null),
    );
    express::json(ctx, 200, &Value::Object(out), &[])
}

/// `GET|HEAD /api/sessions/:id/diff/files`.
async fn diff_files(ctx: &RequestCtx, host_port_num: u16) -> Response<Body> {
    let Some(id) = session_param(&ctx.path) else {
        return bad_param(ctx);
    };
    let found = match find_session(host_port_num, ctx, &id).await {
        Ok(found) => found,
        Err(response) => return response,
    };
    let Some(worktree) = non_empty_field(&found.persisted, "worktreePath") else {
        return error_json(ctx, 400, "worktree missing");
    };
    if !found.worktree_exists {
        return error_json(ctx, 400, "worktree missing");
    }
    let base = match base_branch(host_port_num, ctx, &found.dir).await {
        Ok(branch) => branch,
        Err(response) => return response,
    };
    let branch = found.persisted.get("branch").cloned();
    match file_list_body(
        ctx,
        host_port_num,
        &worktree,
        &base,
        branch,
        &found.dir,
        Some(&id),
        None,
    )
    .await
    {
        Ok(body) => express::json(ctx, 200, &body, &[]),
        Err(response) => response,
    }
}

/// The shared body for the session and task file-list routes. `session_id` is
/// `Some` for a session worktree, `None` for a task one.
#[allow(clippy::too_many_arguments)]
async fn file_list_body(
    ctx: &RequestCtx,
    host_port_num: u16,
    worktree: &str,
    base: &str,
    branch: Option<Value>,
    _dir: &Value,
    session_id: Option<&str>,
    task_id: Option<&str>,
) -> Result<Value, Response<Body>> {
    let (mut numstat, mut name_status) = (String::new(), String::new());
    let mut error: Option<String> = None;
    match run_git(
        host_port_num,
        worktree,
        strings(&[
            "-c",
            "core.quotepath=false",
            "diff",
            "--numstat",
            "--no-color",
            "-z",
            base,
        ]),
        NUMSTAT_MAX_BUFFER,
        false,
    )
    .await
    {
        GitResult::Output(stdout) => numstat = stdout,
        GitResult::Failed(failure) => error = Some(failure.text()),
        GitResult::Down => return Err(unavailable(ctx)),
    }
    match run_git(
        host_port_num,
        worktree,
        strings(&[
            "-c",
            "core.quotepath=false",
            "diff",
            "--name-status",
            "--no-color",
            "-z",
            base,
        ]),
        NAME_STATUS_MAX_BUFFER,
        false,
    )
    .await
    {
        GitResult::Output(stdout) => name_status = stdout,
        GitResult::Failed(failure) => {
            if error.is_none() {
                error = Some(failure.text());
            }
        }
        GitResult::Down => return Err(unavailable(ctx)),
    }
    let tracked = if error.is_some() {
        Vec::new()
    } else {
        match session_git::parse_diff_files(&numstat, &name_status) {
            Value::Array(files) => files,
            _ => Vec::new(),
        }
    };
    let (all_files, untracked_count) = untracked_files(host_port_num, worktree, tracked).await;
    let total_files = all_files.len();
    let total_additions = total(&all_files, "additions");
    let total_deletions = total(&all_files, "deletions");
    let truncated = total_files > session_git::FILE_CAP;
    let files: Vec<Value> = if truncated {
        all_files.into_iter().take(session_git::FILE_CAP).collect()
    } else {
        all_files
    };
    let merge_state = if let Some(id) = session_id {
        merge_state(host_port_num, ctx, id, false, false).await?
    } else if let Some(id) = task_id {
        merge_state_task(host_port_num, ctx, id).await?
    } else {
        session_git::loading_merge_state()
    };
    let mut out = Map::new();
    out.insert("baseBranch".into(), Value::String(base.to_string()));
    if let Some(branch) = branch {
        out.insert("branch".into(), branch);
    }
    out.insert("files".into(), Value::Array(files));
    out.insert("totalFiles".into(), json!(total_files));
    out.insert("totalAdditions".into(), json!(total_additions));
    out.insert("totalDeletions".into(), json!(total_deletions));
    out.insert("untrackedCount".into(), json!(untracked_count));
    out.insert("truncated".into(), Value::Bool(truncated));
    out.insert("mergeState".into(), merge_state);
    out.insert(
        "error".into(),
        error.map(Value::String).unwrap_or(Value::Null),
    );
    Ok(Value::Object(out))
}

/// `filePath` from `?path=` for the per-file diff routes, or the 400 message.
fn diff_file_param(ctx: &RequestCtx) -> Result<String, Response<Body>> {
    let Some(file_path) = q_text(ctx, "path") else {
        return Err(error_json(ctx, 400, "path required (1..500 chars)"));
    };
    if let Some(message) = session_git::diff_file_path_error(&file_path) {
        return Err(error_json(ctx, 400, message));
    }
    Ok(file_path)
}

/// `GET|HEAD /api/sessions/:id/diff/file`.
async fn diff_file(ctx: &RequestCtx, host_port_num: u16) -> Response<Body> {
    let Some(id) = session_param(&ctx.path) else {
        return bad_param(ctx);
    };
    let found = match find_session(host_port_num, ctx, &id).await {
        Ok(found) => found,
        Err(response) => return response,
    };
    let Some(worktree) = non_empty_field(&found.persisted, "worktreePath") else {
        return error_json(ctx, 400, "worktree missing");
    };
    if !found.worktree_exists {
        return error_json(ctx, 400, "worktree missing");
    }
    let file_path = match diff_file_param(ctx) {
        Ok(file_path) => file_path,
        Err(response) => return response,
    };
    let base = match base_branch(host_port_num, ctx, &found.dir).await {
        Ok(branch) => branch,
        Err(response) => return response,
    };
    match single_patch(ctx, host_port_num, &worktree, &base, &file_path).await {
        Ok(body) => express::json(ctx, 200, &body, &[]),
        Err(response) => response,
    }
}

/// The shared body for the session and task single-file diff routes.
async fn single_patch(
    ctx: &RequestCtx,
    host_port_num: u16,
    worktree: &str,
    base: &str,
    file_path: &str,
) -> Result<Value, Response<Body>> {
    let mut patch;
    let mut truncated = false;
    let mut error: Option<String> = None;
    let mut untracked = false;
    match run_git(
        host_port_num,
        worktree,
        strings(&["diff", "--no-color", base, "--", file_path]),
        PATCH_MAX_BUFFER,
        false,
    )
    .await
    {
        GitResult::Output(stdout) => {
            let capped = session_git::cap_patch(stdout);
            patch = capped.0;
            truncated = capped.1;
        }
        GitResult::Failed(failure) => {
            error = Some(failure.text());
            patch = String::new();
        }
        GitResult::Down => return Err(unavailable(ctx)),
    }
    if patch.is_empty() && error.is_none() {
        let untracked_paths = list_untracked(host_port_num, worktree).await;
        if untracked_paths.iter().any(|path| path == file_path) {
            untracked = true;
            if let Some(fact) = read_text(host_port_num, worktree, file_path).await {
                if fact.exists {
                    if fact.binary {
                        patch = session_git::binary_patch(file_path);
                    } else {
                        let built = session_git::untracked_patch(file_path, &fact.text);
                        let capped = session_git::cap_patch(built);
                        patch = capped.0;
                        truncated = capped.1;
                    }
                }
            }
        }
    }
    let mut out = Map::new();
    out.insert("path".into(), Value::String(file_path.to_string()));
    out.insert("patch".into(), Value::String(patch));
    out.insert("truncated".into(), Value::Bool(truncated));
    out.insert(
        "error".into(),
        error.map(Value::String).unwrap_or(Value::Null),
    );
    out.insert("untracked".into(), Value::Bool(untracked));
    Ok(Value::Object(out))
}

/// The `{session, dir, sessionWorktreeExists, dirPathExists}` lookup hosted by
/// `/api/git/*`, which reads the raw maps without owner resolution.
struct Lookup {
    session: Option<Value>,
    dir: Option<Value>,
    session_worktree_exists: bool,
    dir_path_exists: bool,
}

async fn lookup(
    host_port_num: u16,
    ctx: &RequestCtx,
    session_id: Option<&str>,
    dir_id: Option<&str>,
) -> Result<Lookup, Response<Body>> {
    let Some(answer) = host(
        host_port_num,
        json!({
            "op": "lookup",
            "sessionId": session_id,
            "dirId": dir_id,
        }),
    )
    .await
    else {
        return Err(unavailable(ctx));
    };
    Ok(Lookup {
        session: answer.get("session").cloned().filter(Value::is_object),
        dir: answer.get("dir").cloned().filter(Value::is_object),
        session_worktree_exists: bool_field(&answer, "sessionWorktreeExists"),
        dir_path_exists: bool_field(&answer, "dirPathExists"),
    })
}

/// `GET|HEAD /api/git/log`.
async fn git_log(ctx: &RequestCtx, host_port_num: u16) -> Response<Body> {
    let session_truthy = q_truthy(ctx, "sessionId");
    let dir_truthy = q_truthy(ctx, "dirId");
    let limit = session_git::log_limit(&query_string(&query_value(&ctx.original_url, "limit")));
    let all_branches = q_is_one(ctx, "all");
    let session_key = q_text(ctx, "sessionId");
    let dir_key = q_text(ctx, "dirId");
    let (repo, exists) = if session_truthy {
        let looked = match lookup(host_port_num, ctx, session_key.as_deref(), None).await {
            Ok(looked) => looked,
            Err(response) => return response,
        };
        let Some(session) = looked.session else {
            return error_json(ctx, 404, "session or worktree not found");
        };
        let Some(worktree) = non_empty_field(&session, "worktreePath") else {
            return error_json(ctx, 404, "session or worktree not found");
        };
        (worktree, looked.session_worktree_exists)
    } else if dir_truthy {
        let looked = match lookup(host_port_num, ctx, None, dir_key.as_deref()).await {
            Ok(looked) => looked,
            Err(response) => return response,
        };
        let Some(dir) = looked.dir else {
            return error_json(ctx, 404, "directory not found");
        };
        let Some(path) = field(&dir, "path") else {
            return error_json(ctx, 404, "directory not found");
        };
        (path.to_string(), looked.dir_path_exists)
    } else {
        return error_json(ctx, 400, "dirId or sessionId required");
    };
    if !exists {
        return error_json(ctx, 404, "repo path missing");
    }
    let mut args = strings(&[
        "log",
        &format!("-{limit}"),
        "--format=%H%x00%h%x00%an%x00%aI%x00%s%x00%D",
        "--no-color",
    ]);
    if all_branches {
        args.push("--all".to_string());
    }
    match run_git(host_port_num, &repo, args, 512 * 1024, false).await {
        GitResult::Output(raw) => {
            let mut out = Map::new();
            out.insert("commits".into(), session_git::parse_log_commits(&raw));
            out.insert("repoPath".into(), Value::String(repo));
            express::json(ctx, 200, &Value::Object(out), &[])
        }
        GitResult::Failed(failure) => error_json(ctx, 500, &failure.text()),
        GitResult::Down => unavailable(ctx),
    }
}

/// `GET|HEAD /api/git/commit-files`.
async fn commit_files(ctx: &RequestCtx, host_port_num: u16) -> Response<Body> {
    let session_truthy = q_truthy(ctx, "sessionId");
    let session_key = q_text(ctx, "sessionId");
    let dir_key = q_text(ctx, "dirId");
    let looked = match lookup(
        host_port_num,
        ctx,
        session_key.as_deref(),
        dir_key.as_deref(),
    )
    .await
    {
        Ok(looked) => looked,
        Err(response) => return response,
    };
    let (repo, exists) = if session_truthy {
        let session = looked.session.as_ref();
        let worktree = session.and_then(|value| non_empty_field(value, "worktreePath"));
        (worktree, looked.session_worktree_exists)
    } else {
        let path = looked
            .dir
            .as_ref()
            .and_then(|value| non_empty_field(value, "path"));
        (path, looked.dir_path_exists)
    };
    let Some(repo) = repo else {
        return error_json(ctx, 404, "repo not found");
    };
    if !exists {
        return error_json(ctx, 404, "repo not found");
    }
    let Some(hash) = q_text(ctx, "hash").filter(|hash| session_git::valid_commit_hash(hash)) else {
        return error_json(ctx, 400, "invalid hash");
    };
    match run_git(
        host_port_num,
        &repo,
        strings(&[
            "show",
            "--format=",
            "--name-status",
            "-z",
            "--root",
            "--first-parent",
            "--no-color",
            &hash,
        ]),
        NAME_STATUS_MAX_BUFFER,
        false,
    )
    .await
    {
        GitResult::Output(raw) => {
            let mut out = Map::new();
            out.insert("hash".into(), Value::String(hash));
            out.insert("files".into(), session_git::parse_commit_files(&raw));
            express::json(ctx, 200, &Value::Object(out), &[])
        }
        GitResult::Failed(failure) => error_json(ctx, 500, &failure.text()),
        GitResult::Down => unavailable(ctx),
    }
}

/// `GET|HEAD /api/git/commit-diff`.
async fn commit_diff(ctx: &RequestCtx, host_port_num: u16) -> Response<Body> {
    let dir_truthy = q_truthy(ctx, "dirId");
    let session_truthy = q_truthy(ctx, "sessionId");
    let session_key = q_text(ctx, "sessionId");
    let dir_key = q_text(ctx, "dirId");
    let looked = match lookup(
        host_port_num,
        ctx,
        session_key.as_deref(),
        dir_key.as_deref(),
    )
    .await
    {
        Ok(looked) => looked,
        Err(response) => return response,
    };
    let (repo, exists) = if dir_truthy {
        let Some(dir) = looked.dir.as_ref() else {
            return error_json(ctx, 404, "directory not found");
        };
        let Some(path) = field(dir, "path") else {
            return error_json(ctx, 404, "directory not found");
        };
        (path.to_string(), looked.dir_path_exists)
    } else if session_truthy {
        let Some(session) = looked.session.as_ref() else {
            return error_json(ctx, 404, "session or worktree not found");
        };
        let Some(worktree) = non_empty_field(session, "worktreePath") else {
            return error_json(ctx, 404, "session or worktree not found");
        };
        (worktree, looked.session_worktree_exists)
    } else {
        return error_json(ctx, 404, "directory not found");
    };
    if !exists {
        return error_json(ctx, 404, "repo path missing");
    }
    let Some(hash) = q_text(ctx, "hash").filter(|hash| session_git::valid_commit_hash(hash)) else {
        return error_json(ctx, 400, "invalid hash");
    };
    let file = match query_param(&ctx.original_url, "file") {
        QueryParam::Missing => None,
        QueryParam::Text(text) if session_git::valid_commit_file_path(&text) => Some(text),
        _ => return error_json(ctx, 400, "invalid file"),
    };
    let Some(file) = file else {
        return commit_diff_without_file(ctx, host_port_num, &repo, &hash).await;
    };
    let raw = match run_git(
        host_port_num,
        &repo,
        strings(&[
            "show",
            "--format=",
            "--name-status",
            "-z",
            "--root",
            "--first-parent",
            "--no-color",
            &hash,
        ]),
        NAME_STATUS_MAX_BUFFER,
        false,
    )
    .await
    {
        GitResult::Output(raw) => raw,
        GitResult::Failed(failure) if failure.max_buffer => {
            return commit_diff_truncated(ctx, &hash, &file)
        }
        GitResult::Failed(failure) => return error_json(ctx, 500, &failure.text()),
        GitResult::Down => return unavailable(ctx),
    };
    let changed = match session_git::parse_commit_files(&raw) {
        Value::Array(files) => files
            .into_iter()
            .find(|entry| field(entry, "path") == Some(file.as_str())),
        _ => None,
    };
    let Some(changed) = changed else {
        return error_json(ctx, 404, "file not found in commit");
    };
    let mut paths: Vec<String> = Vec::new();
    if let Some(old_path) = non_empty_field(&changed, "oldPath") {
        paths.push(old_path);
    }
    if let Some(path) = field(&changed, "path") {
        paths.push(path.to_string());
    }
    let mut args = strings(&[
        "show",
        "--format=",
        "--patch",
        "--root",
        "--first-parent",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        &hash,
        "--",
    ]);
    for path in &paths {
        args.push(format!(":(literal){path}"));
    }
    match run_git(host_port_num, &repo, args, DIFF_MAX_BUFFER, false).await {
        GitResult::Output(stdout) => {
            let capped = session_git::cap_diff(stdout);
            commit_diff_body(ctx, &hash, Some(&file), "", capped.0, capped.1, None)
        }
        GitResult::Failed(failure) if failure.max_buffer => {
            commit_diff_truncated(ctx, &hash, &file)
        }
        GitResult::Failed(failure) => error_json(ctx, 500, &failure.text()),
        GitResult::Down => unavailable(ctx),
    }
}

fn commit_diff_truncated(ctx: &RequestCtx, hash: &str, file: &str) -> Response<Body> {
    commit_diff_body(ctx, hash, Some(file), "", String::new(), true, None)
}

/// `{ hash, path?, stat, diff, truncated, error }` preserving the retired key
/// order (`path` sits between `hash` and `stat` only for the file branch).
fn commit_diff_body(
    ctx: &RequestCtx,
    hash: &str,
    file: Option<&str>,
    stat: &str,
    diff: String,
    truncated: bool,
    error: Option<String>,
) -> Response<Body> {
    let mut out = Map::new();
    out.insert("hash".into(), Value::String(hash.to_string()));
    if let Some(file) = file {
        out.insert("path".into(), Value::String(file.to_string()));
    }
    out.insert("stat".into(), Value::String(stat.to_string()));
    out.insert("diff".into(), Value::String(diff));
    out.insert("truncated".into(), Value::Bool(truncated));
    out.insert(
        "error".into(),
        error.map(Value::String).unwrap_or(Value::Null),
    );
    express::json(ctx, 200, &Value::Object(out), &[])
}

async fn commit_diff_without_file(
    ctx: &RequestCtx,
    host_port_num: u16,
    repo: &str,
    hash: &str,
) -> Response<Body> {
    let (mut diff, mut truncated) = (String::new(), false);
    let mut error: Option<String> = None;
    match run_git(
        host_port_num,
        repo,
        strings(&["show", "--format=", "--patch", hash]),
        DIFF_MAX_BUFFER,
        false,
    )
    .await
    {
        GitResult::Output(stdout) => diff = stdout,
        GitResult::Failed(failure) if failure.max_buffer => {
            truncated = true;
            diff = session_git::DIFF_TOO_LARGE.to_string();
        }
        GitResult::Failed(failure) => error = Some(failure.text()),
        GitResult::Down => return unavailable(ctx),
    }
    if diff.is_empty() {
        let has_parent = match run_git(
            host_port_num,
            repo,
            strings(&["rev-parse", "--verify", "--quiet", &format!("{hash}~1")]),
            SMALL_BUFFER,
            false,
        )
        .await
        {
            GitResult::Output(_) => true,
            GitResult::Failed(_) => false,
            GitResult::Down => return unavailable(ctx),
        };
        if has_parent {
            match run_git(
                host_port_num,
                repo,
                strings(&["diff", "--patch", &format!("{hash}~1"), hash]),
                DIFF_MAX_BUFFER,
                false,
            )
            .await
            {
                GitResult::Output(stdout) => diff = stdout,
                GitResult::Failed(failure) if failure.max_buffer => {
                    truncated = true;
                    diff = session_git::DIFF_TOO_LARGE.to_string();
                }
                GitResult::Failed(failure) => error = Some(failure.text()),
                GitResult::Down => return unavailable(ctx),
            }
            if !diff.is_empty() {
                error = None;
            }
        }
    }
    let capped = session_git::cap_diff(diff);
    let mut stat = String::new();
    if let GitResult::Output(stdout) = run_git(
        host_port_num,
        repo,
        strings(&["show", "--format=", "--stat", hash]),
        STAT_MAX_BUFFER,
        false,
    )
    .await
    {
        stat = stdout;
    }
    commit_diff_body(
        ctx,
        hash,
        None,
        &stat,
        capped.0,
        truncated || capped.1,
        error,
    )
}

/// `GET|HEAD /api/git/directory-file-diff`.
async fn directory_file_diff(ctx: &RequestCtx, host_port_num: u16) -> Response<Body> {
    let Some(dir_id) = q_text(ctx, "dirId").filter(|value| session_git::valid_dir_id(value)) else {
        return error_json(ctx, 400, "dirId required");
    };
    let looked = match lookup(host_port_num, ctx, None, Some(&dir_id)).await {
        Ok(looked) => looked,
        Err(response) => return response,
    };
    let Some(dir) = looked.dir else {
        return error_json(ctx, 404, "directory not found");
    };
    let Some(repo) = field(&dir, "path").map(str::to_string) else {
        return error_json(ctx, 404, "directory not found");
    };
    if !looked.dir_path_exists {
        return error_json(ctx, 404, "repo path missing");
    }
    let Some(file_path) =
        q_text(ctx, "path").filter(|path| session_git::valid_directory_file_path(path))
    else {
        return error_json(ctx, 400, "invalid path");
    };
    let mut patch = String::new();
    let mut error: Option<String> = None;
    match run_git(
        host_port_num,
        &repo,
        strings(&["diff", "--no-color", "HEAD", "--", &file_path]),
        PATCH_MAX_BUFFER,
        false,
    )
    .await
    {
        GitResult::Output(stdout) => patch = stdout,
        GitResult::Failed(failure) => {
            match run_git(
                host_port_num,
                &repo,
                strings(&["diff", "--no-color", "--", &file_path]),
                PATCH_MAX_BUFFER,
                false,
            )
            .await
            {
                GitResult::Output(stdout) => patch = stdout,
                GitResult::Failed(_) => error = Some(failure.text()),
                GitResult::Down => return unavailable(ctx),
            }
        }
        GitResult::Down => return unavailable(ctx),
    }
    directory_patch_body(ctx, host_port_num, &repo, &file_path, patch, error).await
}

/// Untracked-file fallback then cap, shared by the directory and single-file
/// patch routes (the directory route reads from the main checkout).
async fn directory_patch_body(
    ctx: &RequestCtx,
    host_port_num: u16,
    repo: &str,
    file_path: &str,
    mut patch: String,
    mut error: Option<String>,
) -> Response<Body> {
    let mut untracked = false;
    if patch.is_empty() && error.is_none() {
        let untracked_paths = list_untracked(host_port_num, repo).await;
        if untracked_paths.iter().any(|path| path == file_path) {
            untracked = true;
            if let Some(fact) = read_text(host_port_num, repo, file_path).await {
                if fact.exists {
                    if fact.binary {
                        patch = session_git::binary_patch(file_path);
                    } else {
                        let built = session_git::untracked_patch(file_path, &fact.text);
                        let capped = session_git::cap_patch(built);
                        patch = capped.0;
                    }
                }
            }
        }
    }
    let capped = session_git::cap_patch(patch);
    let mut out = Map::new();
    out.insert("path".into(), Value::String(file_path.to_string()));
    out.insert("patch".into(), Value::String(capped.0));
    out.insert("truncated".into(), Value::Bool(capped.1));
    out.insert(
        "error".into(),
        error.take().map(Value::String).unwrap_or(Value::Null),
    );
    out.insert("untracked".into(), Value::Bool(untracked));
    express::json(ctx, 200, &Value::Object(out), &[])
}

/// `GET|HEAD /api/git/directory-status`.
async fn directory_status(ctx: &RequestCtx, host_port_num: u16) -> Response<Body> {
    let Some(dir_id) = q_text(ctx, "dirId").filter(|value| session_git::valid_dir_id(value)) else {
        return error_json(ctx, 400, "dirId required");
    };
    let looked = match lookup(host_port_num, ctx, None, Some(&dir_id)).await {
        Ok(looked) => looked,
        Err(response) => return response,
    };
    let Some(dir) = looked.dir else {
        return error_json(ctx, 404, "directory not found");
    };
    let Some(repo) = field(&dir, "path").map(str::to_string) else {
        return error_json(ctx, 404, "directory not found");
    };
    if !looked.dir_path_exists {
        return error_json(ctx, 404, "repo path missing");
    }
    let branch = match run_git(
        host_port_num,
        &repo,
        strings(&["rev-parse", "--abbrev-ref", "HEAD"]),
        SMALL_BUFFER,
        false,
    )
    .await
    {
        GitResult::Output(stdout) => js_trim(&stdout).to_string(),
        GitResult::Failed(failure) => return error_json(ctx, 500, &failure.text()),
        GitResult::Down => return unavailable(ctx),
    };
    let upstream = match run_git(
        host_port_num,
        &repo,
        strings(&[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ]),
        SMALL_BUFFER,
        false,
    )
    .await
    {
        GitResult::Output(stdout) => js_trim(&stdout).to_string(),
        _ => String::new(),
    };
    let mut base = non_empty_field(&dir, "baseBranch").unwrap_or_default();
    if base.is_empty() {
        base = match base_branch(host_port_num, ctx, &dir).await {
            Ok(branch) => branch,
            Err(response) => return response,
        };
    }
    let ahead_ref = if upstream.is_empty() {
        base.clone()
    } else {
        upstream.clone()
    };
    let (mut ahead, mut behind) = (0i64, 0i64);
    if !ahead_ref.is_empty() {
        let ahead_result = run_git(
            host_port_num,
            &repo,
            strings(&["rev-list", "--count", &format!("{ahead_ref}..HEAD")]),
            SMALL_BUFFER,
            false,
        )
        .await;
        let behind_result = run_git(
            host_port_num,
            &repo,
            strings(&["rev-list", "--count", &format!("HEAD..{ahead_ref}")]),
            SMALL_BUFFER,
            false,
        )
        .await;
        if let (GitResult::Output(ahead_raw), GitResult::Output(behind_raw)) =
            (ahead_result, behind_result)
        {
            ahead = session_git::parse_int_or_zero(js_trim(&ahead_raw));
            behind = session_git::parse_int_or_zero(js_trim(&behind_raw));
        }
    }
    let mut dirty_files: Vec<Value> = Vec::new();
    if let GitResult::Output(raw) = run_git(
        host_port_num,
        &repo,
        strings(&["status", "--porcelain"]),
        STAT_MAX_BUFFER,
        true,
    )
    .await
    {
        for line in raw.split('\n') {
            if let Some(entry) = session_git::dirty_file_entry(line) {
                dirty_files.push(entry);
            }
        }
    }
    let mut out = Map::new();
    out.insert("branch".into(), Value::String(branch));
    out.insert(
        "upstream".into(),
        if upstream.is_empty() {
            Value::Null
        } else {
            Value::String(upstream)
        },
    );
    out.insert(
        "baseBranch".into(),
        if base.is_empty() {
            Value::Null
        } else {
            Value::String(base)
        },
    );
    out.insert("ahead".into(), json!(ahead));
    out.insert("behind".into(), json!(behind));
    out.insert("dirtyFiles".into(), Value::Array(dirty_files));
    express::json(ctx, 200, &Value::Object(out), &[])
}

struct TaskInfo {
    dir: Value,
    worktree_path: String,
    branch: String,
    worktree_exists: bool,
}

async fn task_info(
    host_port_num: u16,
    ctx: &RequestCtx,
    task_id: &str,
) -> Result<TaskInfo, Response<Body>> {
    let Some(answer) = host(
        host_port_num,
        json!({ "op": "task-worktree", "taskId": task_id }),
    )
    .await
    else {
        return Err(unavailable(ctx));
    };
    let Some(info) = answer.get("info").filter(|value| value.is_object()) else {
        return Err(error_json(ctx, 404, "task_not_found"));
    };
    let Some(worktree_path) = non_empty_field(info, "worktreePath") else {
        return Err(error_json(ctx, 404, "task_not_found"));
    };
    let Some(branch) = non_empty_field(info, "branch") else {
        return Err(error_json(ctx, 404, "task_not_found"));
    };
    let dir = info.get("dir").cloned().unwrap_or(Value::Null);
    Ok(TaskInfo {
        dir,
        worktree_path,
        branch,
        worktree_exists: bool_field(&answer, "worktreeExists"),
    })
}

/// `GET|HEAD /api/task-board/tasks/:taskId/diff/files`.
async fn task_diff_files(ctx: &RequestCtx, host_port_num: u16) -> Response<Body> {
    let Some(task_id) = task_param(&ctx.path) else {
        return bad_param(ctx);
    };
    let info = match task_info(host_port_num, ctx, &task_id).await {
        Ok(info) => info,
        Err(response) => return response,
    };
    if !info.worktree_exists {
        return error_json(ctx, 400, "worktree missing");
    }
    let base = match base_branch(host_port_num, ctx, &info.dir).await {
        Ok(branch) => branch,
        Err(response) => return response,
    };
    match file_list_body(
        ctx,
        host_port_num,
        &info.worktree_path,
        &base,
        Some(Value::String(info.branch.clone())),
        &info.dir,
        None,
        Some(&task_id),
    )
    .await
    {
        Ok(body) => express::json(ctx, 200, &body, &[]),
        Err(response) => response,
    }
}

/// `GET|HEAD /api/task-board/tasks/:taskId/diff/file`.
async fn task_diff_file(ctx: &RequestCtx, host_port_num: u16) -> Response<Body> {
    let Some(task_id) = task_param(&ctx.path) else {
        return bad_param(ctx);
    };
    let info = match task_info(host_port_num, ctx, &task_id).await {
        Ok(info) => info,
        Err(response) => return response,
    };
    if !info.worktree_exists {
        return error_json(ctx, 400, "worktree missing");
    }
    let file_path = match diff_file_param(ctx) {
        Ok(file_path) => file_path,
        Err(response) => return response,
    };
    let base = match base_branch(host_port_num, ctx, &info.dir).await {
        Ok(branch) => branch,
        Err(response) => return response,
    };
    match single_patch(ctx, host_port_num, &info.worktree_path, &base, &file_path).await {
        Ok(body) => express::json(ctx, 200, &body, &[]),
        Err(response) => response,
    }
}

/// `POST /api/task-board/tasks/:taskId/merge`.
async fn task_merge(app: &Arc<App>, ctx: &RequestCtx, host_port_num: u16) -> Response<Body> {
    let Some(task_id) = task_param(&ctx.path) else {
        return bad_param(ctx);
    };
    let info = match task_info(host_port_num, ctx, &task_id).await {
        Ok(info) => info,
        Err(response) => return response,
    };
    if !info.worktree_exists {
        return error_json(ctx, 400, "任务 worktree 不存在");
    }
    let _serialized = app.session_git_write.lock().await;
    let Some(answer) = host(
        host_port_num,
        json!({ "op": "task-merge", "taskId": task_id }),
    )
    .await
    else {
        return unavailable(ctx);
    };
    if bool_field(&answer, "missing") {
        return error_json(ctx, 404, "task_not_found");
    }
    if let Some(error) = answer.get("error") {
        let dto = session_git::failed_git_result(error);
        return express::json(ctx, session_git::merge_failure_status(&dto), &dto, &[]);
    }
    let Some(result) = answer.get("result").cloned() else {
        return unavailable(ctx);
    };
    if !result_ok(&result) {
        return express::json(
            ctx,
            session_git::merge_failure_status(&result),
            &result,
            &[],
        );
    }
    express::json(ctx, 200, &result, &[])
}

/// `POST /api/task-board/tasks/:taskId/cleanup-worktree`.
async fn task_cleanup(
    app: &Arc<App>,
    ctx: &RequestCtx,
    body: &Value,
    host_port_num: u16,
) -> Response<Body> {
    let Some(task_id) = task_param(&ctx.path) else {
        return bad_param(ctx);
    };
    let _info = match task_info(host_port_num, ctx, &task_id).await {
        Ok(info) => info,
        Err(response) => return response,
    };
    let force = body.get("force") == Some(&Value::Bool(true));
    let _serialized = app.session_git_write.lock().await;
    let Some(answer) = host(
        host_port_num,
        json!({ "op": "task-cleanup", "taskId": task_id, "force": force }),
    )
    .await
    else {
        return unavailable(ctx);
    };
    let result = answer.get("result").cloned().unwrap_or(Value::Null);
    if result.is_null() || result.get("ok") == Some(&Value::Bool(false)) {
        if field(&result, "code") == Some("task_not_found") {
            return error_json(ctx, 404, "task_not_found");
        }
        if truthy(result.get("blocked").unwrap_or(&Value::Null)) {
            return express::json(ctx, 409, &result, &[]);
        }
        let body = if result.is_null() {
            json!({ "error": "cleanup_failed" })
        } else {
            result
        };
        return express::json(ctx, 400, &body, &[]);
    }
    express::json(ctx, 200, &result, &[])
}

fn result_ok(result: &Value) -> bool {
    result.get("ok") == Some(&Value::Bool(true))
}

/// `POST /api/sessions/:id/merge`.
async fn session_merge(app: &Arc<App>, ctx: &RequestCtx, host_port_num: u16) -> Response<Body> {
    let Some(id) = session_param(&ctx.path) else {
        return bad_param(ctx);
    };
    let found = match find_session(host_port_num, ctx, &id).await {
        Ok(found) => found,
        Err(response) => return response,
    };
    if let Some(response) = has_worktree(&found, ctx, "该会话没有 worktree，无需合并") {
        return response;
    }
    let _serialized = app.session_git_write.lock().await;
    let Some(answer) = host(
        host_port_num,
        json!({ "op": "session-merge", "sessionId": id }),
    )
    .await
    else {
        return unavailable(ctx);
    };
    if let Some(error) = answer.get("error") {
        let dto = session_git::failed_git_result(error);
        return express::json(ctx, session_git::merge_failure_status(&dto), &dto, &[]);
    }
    let Some(result) = answer.get("result").cloned() else {
        return unavailable(ctx);
    };
    if !result_ok(&result) {
        return express::json(
            ctx,
            session_git::merge_failure_status(&result),
            &result,
            &[],
        );
    }
    express::json(ctx, 200, &result, &[])
}

/// `POST /api/sessions/:id/sync`.
async fn session_sync(
    app: &Arc<App>,
    ctx: &RequestCtx,
    body: &Value,
    host_port_num: u16,
) -> Response<Body> {
    let Some(id) = session_param(&ctx.path) else {
        return bad_param(ctx);
    };
    let found = match find_session(host_port_num, ctx, &id).await {
        Ok(found) => found,
        Err(response) => return response,
    };
    if let Some(response) = has_worktree(&found, ctx, "该会话没有 worktree，无需同步") {
        return response;
    }
    let persisted_id = field(&found.persisted, "id").unwrap_or(&id).to_string();
    let force = q_is_one(ctx, "force") || body.get("force") == Some(&Value::Bool(true));
    if !force {
        match sync_gate(ctx, host_port_num, &persisted_id).await {
            Ok(Some(body)) => return express::json(ctx, 409, &body, &[]),
            Ok(None) => {}
            Err(response) => return response,
        }
    }
    let _serialized = app.session_git_write.lock().await;
    let Some(answer) = host(
        host_port_num,
        json!({ "op": "session-sync", "sessionId": persisted_id, "force": force }),
    )
    .await
    else {
        return unavailable(ctx);
    };
    if let Some(error) = answer.get("error") {
        let dto = session_git::blocked_git_result(error);
        return express::json(ctx, session_git::sync_failure_status(&dto), &dto, &[]);
    }
    let Some(result) = answer.get("result").cloned() else {
        return unavailable(ctx);
    };
    if !result_ok(&result) {
        return express::json(ctx, session_git::sync_failure_status(&result), &result, &[]);
    }
    express::json(ctx, 200, &result, &[])
}

/// `sessionSyncGate` via the two Node-side facts plus the Rust decision tree.
async fn sync_gate(
    ctx: &RequestCtx,
    host_port_num: u16,
    session_id: &str,
) -> Result<Option<Value>, Response<Body>> {
    let Some(answer) = host(
        host_port_num,
        json!({ "op": "sync-gate-facts", "sessionId": session_id }),
    )
    .await
    else {
        return Err(unavailable(ctx));
    };
    let active = bool_field(&answer, "active");
    let classify_state = field(&answer, "classifyState");
    let Some((state, message)) = session_git::sync_gate(active, classify_state) else {
        return Ok(None);
    };
    Ok(Some(json!({
        "ok": false,
        "blocked": true,
        "reasons": ["busy"],
        "classifyState": state,
        "error": message,
    })))
}

/// `POST /api/sessions/:id/rebase`.
async fn session_rebase(
    app: &Arc<App>,
    ctx: &RequestCtx,
    body: &Value,
    host_port_num: u16,
) -> Response<Body> {
    let Some(id) = session_param(&ctx.path) else {
        return bad_param(ctx);
    };
    let found = match find_session(host_port_num, ctx, &id).await {
        Ok(found) => found,
        Err(response) => return response,
    };
    if let Some(response) = has_worktree(&found, ctx, "该会话没有 worktree") {
        return response;
    }
    let persisted_id = field(&found.persisted, "id").unwrap_or(&id).to_string();
    let action = if body.get("action").and_then(Value::as_str) == Some("abort") {
        "abort"
    } else {
        "continue"
    };
    let force = q_is_one(ctx, "force") || body.get("force") == Some(&Value::Bool(true));
    let _serialized = app.session_git_write.lock().await;
    let Some(answer) = host(
        host_port_num,
        json!({
            "op": "session-rebase",
            "sessionId": persisted_id,
            "action": action,
            "force": force,
        }),
    )
    .await
    else {
        return unavailable(ctx);
    };
    if let Some(error) = answer.get("error") {
        let dto = session_git::blocked_git_result(error);
        return express::json(ctx, session_git::sync_failure_status(&dto), &dto, &[]);
    }
    let Some(result) = answer.get("result").cloned() else {
        return unavailable(ctx);
    };
    if !result_ok(&result) {
        return express::json(ctx, session_git::sync_failure_status(&result), &result, &[]);
    }
    express::json(ctx, 200, &result, &[])
}

pub async fn handle(
    app: &Arc<App>,
    route: Route,
    ctx: &RequestCtx,
    body: &Value,
    host_port_num: u16,
) -> Response<Body> {
    match route {
        Route::MergeStatusOptions
        | Route::DiffOptions
        | Route::DiffFilesOptions
        | Route::DiffFileOptions
        | Route::GitLogOptions
        | Route::CommitFilesOptions
        | Route::CommitDiffOptions
        | Route::DirectoryFileDiffOptions
        | Route::DirectoryStatusOptions
        | Route::TaskDiffFilesOptions
        | Route::TaskDiffFileOptions => super::options(ctx, "GET,HEAD"),
        Route::TaskMergeOptions
        | Route::TaskCleanupOptions
        | Route::SessionMergeOptions
        | Route::SessionSyncOptions
        | Route::SessionRebaseOptions => super::options(ctx, "POST"),
        Route::MergeStatusGet => merge_status(ctx, host_port_num).await,
        Route::DiffGet => diff(ctx, host_port_num).await,
        Route::DiffFilesGet => diff_files(ctx, host_port_num).await,
        Route::DiffFileGet => diff_file(ctx, host_port_num).await,
        Route::GitLogGet => git_log(ctx, host_port_num).await,
        Route::CommitFilesGet => commit_files(ctx, host_port_num).await,
        Route::CommitDiffGet => commit_diff(ctx, host_port_num).await,
        Route::DirectoryFileDiffGet => directory_file_diff(ctx, host_port_num).await,
        Route::DirectoryStatusGet => directory_status(ctx, host_port_num).await,
        Route::TaskDiffFilesGet => task_diff_files(ctx, host_port_num).await,
        Route::TaskDiffFileGet => task_diff_file(ctx, host_port_num).await,
        Route::TaskMergePost => task_merge(app, ctx, host_port_num).await,
        Route::TaskCleanupPost => task_cleanup(app, ctx, body, host_port_num).await,
        Route::SessionMergePost => session_merge(app, ctx, host_port_num).await,
        Route::SessionSyncPost => session_sync(app, ctx, body, host_port_num).await,
        Route::SessionRebasePost => session_rebase(app, ctx, body, host_port_num).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claims_match_the_retired_express_routes() {
        assert_eq!(
            claim(&Method::GET, "/api/sessions/s1/merge-status"),
            Some(Route::MergeStatusGet)
        );
        assert_eq!(
            claim(&Method::HEAD, "/api/Sessions/s1/diff"),
            Some(Route::DiffGet)
        );
        assert_eq!(
            claim(&Method::GET, "/api/sessions/s1/diff/files"),
            Some(Route::DiffFilesGet)
        );
        assert_eq!(
            claim(&Method::GET, "/api/sessions/s1/diff/file"),
            Some(Route::DiffFileGet)
        );
        assert_eq!(claim(&Method::GET, "/api/git/log"), Some(Route::GitLogGet));
        assert_eq!(
            claim(&Method::GET, "/api/git/commit-files"),
            Some(Route::CommitFilesGet)
        );
        assert_eq!(
            claim(&Method::GET, "/api/git/commit-diff"),
            Some(Route::CommitDiffGet)
        );
        assert_eq!(
            claim(&Method::GET, "/api/git/directory-file-diff"),
            Some(Route::DirectoryFileDiffGet)
        );
        assert_eq!(
            claim(&Method::GET, "/api/git/directory-status"),
            Some(Route::DirectoryStatusGet)
        );
        assert_eq!(
            claim(&Method::GET, "/api/task-board/tasks/t1/diff/files"),
            Some(Route::TaskDiffFilesGet)
        );
        assert_eq!(
            claim(&Method::GET, "/api/task-board/tasks/t1/diff/file"),
            Some(Route::TaskDiffFileGet)
        );
        assert_eq!(
            claim(&Method::POST, "/api/task-board/tasks/t1/merge"),
            Some(Route::TaskMergePost)
        );
        assert_eq!(
            claim(&Method::POST, "/api/task-board/tasks/t1/cleanup-worktree"),
            Some(Route::TaskCleanupPost)
        );
        assert_eq!(
            claim(&Method::POST, "/api/sessions/s1/merge"),
            Some(Route::SessionMergePost)
        );
        assert_eq!(
            claim(&Method::POST, "/api/sessions/s1/sync"),
            Some(Route::SessionSyncPost)
        );
        assert_eq!(
            claim(&Method::POST, "/api/sessions/s1/rebase"),
            Some(Route::SessionRebasePost)
        );
        // OPTIONS answers the methods registered on that exact path.
        assert_eq!(
            claim(&Method::OPTIONS, "/api/sessions/s1/diff"),
            Some(Route::DiffOptions)
        );
        assert_eq!(
            claim(&Method::OPTIONS, "/api/sessions/s1/merge"),
            Some(Route::SessionMergeOptions)
        );
        assert_eq!(
            claim(&Method::OPTIONS, "/api/task-board/tasks/t1/merge"),
            Some(Route::TaskMergeOptions)
        );
        assert_eq!(
            claim(&Method::OPTIONS, "/api/git/log"),
            Some(Route::GitLogOptions)
        );
        // Wrong methods and neighbouring paths fall through to Node.
        assert_eq!(claim(&Method::POST, "/api/sessions/s1/diff"), None);
        assert_eq!(claim(&Method::GET, "/api/sessions/s1/merge"), None);
        assert_eq!(claim(&Method::GET, "/api/git/log/extra"), None);
        assert_eq!(claim(&Method::GET, "/api/sessions/s1/unknown"), None);
        assert_eq!(claim(&Method::GET, "/api/task-board/tasks/t1"), None);
    }

    #[test]
    fn params_decode_like_express() {
        assert_eq!(
            session_param("/api/sessions/a%20b/diff").as_deref(),
            Some("a b")
        );
        assert_eq!(session_param("/api/sessions/a%ZZ/diff"), None);
        assert_eq!(
            task_param("/api/task-board/tasks/t%2F1/merge").as_deref(),
            Some("t/1")
        );
        assert_eq!(session_param("/api/git/log"), None);
    }

    #[test]
    fn result_ok_is_strict() {
        assert!(result_ok(&json!({ "ok": true })));
        assert!(!result_ok(&json!({ "ok": 1 })));
        assert!(!result_ok(&json!({ "merged": true })));
    }
}
