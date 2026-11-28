//! The legacy GET migrates rules to fixed task-shell identities before rendering.
use super::{
    express::{self, RequestCtx},
    App, Route,
};
use axum::{
    body::Body,
    http::{Method, Response},
};

use multicc_core::{
    cli_switch, durable_state,
    http_gate::encode_uri_component,
    js::{self, serde::truthy},
    session_records, state_file,
    task_domain::{normalize, repository, text},
    task_store::TaskStore,
};
use serde_json::{json, Value};
use std::{path::Path, sync::Arc};
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Read {
    List,
    Create,
    Calendar,
    Runs,
    Run,
    Modify,
}

pub(crate) fn claim(standalone: bool, method: &Method, path: &str) -> Option<Route> {
    if !standalone
        || !matches!(
            method.as_str(),
            "GET" | "HEAD" | "OPTIONS" | "POST" | "DELETE" | "PATCH"
        )
    {
        return None;
    }
    let path = path.strip_prefix("/api/")?;
    let mut parts = path.strip_suffix('/').unwrap_or(path).split('/');
    if !parts.next()?.eq_ignore_ascii_case("cron") {
        return None;
    }
    let read = match (parts.next(), parts.next(), parts.next()) {
        (None, None, None) if method == Method::POST => Read::Create,
        (Some(id), Some(end), None)
            if !id.is_empty()
                && end.eq_ignore_ascii_case("run")
                && (method == Method::POST || method == Method::OPTIONS) =>
        {
            Read::Run
        }
        (Some(id), None, None)
            if !id.is_empty()
                && (method == Method::PATCH
                    || method == Method::DELETE
                    || (method == Method::OPTIONS && !id.eq_ignore_ascii_case("calendar"))) =>
        {
            Read::Modify
        }
        _ if matches!(method.as_str(), "POST" | "PATCH" | "DELETE") => return None,
        (None, None, None) => Read::List,
        (Some(segment), None, None) if segment.eq_ignore_ascii_case("calendar") => Read::Calendar,
        (Some(id), Some(suffix), None) if !id.is_empty() && suffix.eq_ignore_ascii_case("runs") => {
            Read::Runs
        }
        _ => return None,
    };
    Some(Route::StandaloneCron(read))
}

pub(super) fn fallback(v: &Value, default: Value) -> Value {
    if truthy(v) {
        v.clone()
    } else {
        default
    }
}
pub(super) fn field(field: &str, min: u32, max: u32) -> Option<u64> {
    multicc_core::recurring::field(field, min, max)
}
pub(super) fn next_before(expr: &str, now: i64, end: Option<i64>) -> Option<i64> {
    multicc_core::recurring::Expression::parse(expr)?.next(now, end)
}
fn output_tail(v: &Value, limit: usize) -> js::JsValue {
    let raw = js::js_to_string(&js::from_serde(v));
    let n = raw.as_units().len();
    js::JsValue::String(raw.slice_units(n.saturating_sub(limit), n))
}
fn recent_runs(task: &Value, count: usize, limit: usize) -> Result<Vec<js::JsValue>, String> {
    let mut rows = Vec::new();
    for run in task["runs"]
        .as_array()
        .into_iter()
        .flatten()
        .rev()
        .take(count)
    {
        if run.is_null() {
            return Err("invalid run".into());
        }
        let mut row = js::from_serde(run);
        let output = &run["output"];
        if output
            .as_str()
            .is_some_and(|s| s.encode_utf16().count() > limit)
        {
            multicc_core::quota_guard::set(&mut row, "output", output_tail(output, limit));
        } else if let Some(items) = output.as_array().filter(|items| items.len() > limit) {
            let tail = items[items.len() - limit..]
                .iter()
                .map(js::from_serde)
                .collect();
            multicc_core::quota_guard::set(&mut row, "output", js::JsValue::Array(tail));
        }
        rows.push(row);
    }
    Ok(rows)
}

fn history(tasks: &[Value], id: &str) -> Result<(u16, js::JsValue), String> {
    let Some(t) = tasks.iter().find(|t| t["id"].as_str() == Some(id)) else {
        return Ok((404, js::from_serde(&json!({"error":"task not found"}))));
    };
    let mut fields = json!({"ok":true, "id":id});
    if let Some(name) = t.get("name") {
        fields["name"] = name.clone();
    }
    fields["runCount"] = fallback(&t["runCount"], json!(0));
    fields["lastRunAt"] = fallback(&t["lastRunAt"], Value::Null);
    fields["lastStatus"] = fallback(&t["lastStatus"], Value::Null);
    fields["limit"] = 20.into();
    let mut row = js::from_serde(&fields);
    multicc_core::quota_guard::set(
        &mut row,
        "runs",
        js::JsValue::Array(recent_runs(t, 20, 2000)?),
    );
    Ok((200, row))
}

fn view(t: &Value, dir: Option<&Value>, s: &Value, at: i64) -> Result<js::JsValue, String> {
    let script = t["kind"] == "script";
    let rt = &s["runtime"];
    let id = text(&t["taskId"]);
    let mut v = json!({});
    for k in ["id", "name", "dirId"] {
        if let Some(val) = t.get(k) {
            v[k] = val.clone();
        }
    }
    if let Some(name) = dir.map_or(Some(json!("(已删除)")), |d| d.get("name").cloned()) {
        v["dirName"] = name;
    }
    for (k, default) in [
        ("kind", json!("agent")),
        ("command", json!("")),
        ("scriptTimeoutMs", Value::Null),
    ] {
        v[k] = fallback(&t[k], default);
    }
    v["cli"] = if script {
        Value::Null
    } else {
        fallback(&rt["cli"], fallback(&t["cli"], json!("claude")))
    };
    for k in ["provider", "model", "effort"] {
        v[k] = if script {
            Value::Null
        } else {
            fallback(&rt[k], Value::Null)
        };
    }
    if script {
        v["prompt"] = json!("");
    } else if let Some(p) = t.get("prompt") {
        v["prompt"] = p.clone();
    }
    for k in ["cron", "createdAt"] {
        if let Some(val) = t.get(k) {
            v[k] = val.clone();
        }
    }
    v["enabled"] = truthy(&t["enabled"]).into();
    v["createdBy"] = fallback(&t["createdBy"], json!("user"));
    for k in [
        "lastRunAt",
        "lastStatus",
        "taskBindingBrokenAt",
        "lastReceiptId",
        "lastDecision",
    ] {
        v[k] = fallback(&t[k], Value::Null);
    }
    v["lastError"] = fallback(&t["lastError"], json!(""));
    v["lastSessionId"] = fallback(
        &t["taskSessionId"],
        fallback(&t["lastSessionId"], Value::Null),
    );
    v["lastExitCode"] = if script {
        t["lastExitCode"].clone()
    } else {
        Value::Null
    };
    v["taskId"] = if script {
        Value::Null
    } else {
        fallback(&t["taskId"], Value::Null)
    };
    if script {
        v["taskTitle"] = Value::Null;
    } else if let Some(title) = s.get("title").filter(|v| truthy(v)).or(t.get("name")) {
        v["taskTitle"] = title.clone();
    }
    v["taskStatus"] = if script {
        Value::Null
    } else {
        fallback(
            &s["status"],
            json!(if id.is_empty() { "binding" } else { "unknown" }),
        )
    };
    v["taskReadOnly"] = json!(s["readOnly"] == true);
    v["taskBindingError"] = if script {
        json!("")
    } else {
        fallback(&t["taskBindingError"], json!(""))
    };
    v["taskBindingBroken"] = json!(!script && truthy(&t["taskBindingError"]));
    v["taskRebindHistory"] = t["taskRebindHistory"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into();
    v["taskUrl"] = json!((!id.is_empty()).then(|| format!(
        "/air?task={}&dir={}",
        encode_uri_component(id),
        encode_uri_component(text(&t["dirId"]))
    )));
    v["runCount"] = fallback(&t["runCount"], json!(0));
    let mut recent = recent_runs(t, 10, 400)?;
    v["nextRunAt"] = json!(if truthy(&t["enabled"]) {
        next_before(text(&t["cron"]), at, None)
    } else {
        None
    });
    let order = [
        "id",
        "name",
        "dirId",
        "dirName",
        "kind",
        "command",
        "scriptTimeoutMs",
        "cli",
        "provider",
        "model",
        "effort",
        "prompt",
        "cron",
        "enabled",
        "createdBy",
        "createdAt",
        "lastRunAt",
        "lastStatus",
        "lastError",
        "lastSessionId",
        "lastExitCode",
        "lastOutput",
        "taskId",
        "taskTitle",
        "taskStatus",
        "taskReadOnly",
        "taskBindingError",
        "taskBindingBroken",
        "taskBindingBrokenAt",
        "taskRebindHistory",
        "taskUrl",
        "lastReceiptId",
        "lastDecision",
        "runCount",
        "recentRuns",
        "nextRunAt",
    ];
    let mut fields = vec![];
    for k in order {
        let value = match k {
            "lastOutput" if script && truthy(&t["lastOutput"]) => {
                output_tail(&t["lastOutput"], 400)
            }
            "lastOutput" => js::JsValue::from(""),
            "recentRuns" => js::JsValue::Array(std::mem::take(&mut recent)),
            _ => {
                if let Some(val) = v.get(k) {
                    js::from_serde(val)
                } else {
                    continue;
                }
            }
        };
        fields.push((k, value));
    }
    Ok(js::JsValue::object(fields))
}
pub(super) struct Bindings<'a> {
    root: &'a Path,
    home: &'a Path,
    db: TaskStore,
    board: Value,
    records: Vec<Value>,
}
impl<'a> Bindings<'a> {
    pub(super) fn open(root: &'a Path, home: &'a Path) -> Result<Self, String> {
        let mut board = repository::read_board_snapshot(&root.join("task_board.json"))?;
        if board.is_null() {
            board = normalize::empty();
        }
        Ok(Self {
            root,
            home,
            board,
            records: super::directory_list::records(&root.join("sessions.json"))?,
            db: TaskStore::open(
                root.join("task-shells.sqlite")
                    .to_str()
                    .ok_or("invalid task store path")?,
            )?,
        })
    }
    fn summary(&self, id: &str) -> Result<Value, String> {
        let mut summary = self.db.schedule_summary(id, &self.board, &self.records)?;
        if summary["runtime"].is_object() {
            crate::ws_chat_native::session_list::normalize_provider(&mut summary["runtime"]);
        }
        Ok(summary)
    }
    pub(super) fn bind(&mut self, t: &mut Value, dir: Option<&Value>) -> Result<(), String> {
        let dir = dir.ok_or("目标目录不存在")?;
        if !truthy(&t["taskId"]) || t["taskBindingVersion"] != 1 {
            if let Some(sid) = t["lastSessionId"].as_str().map(str::to_owned) {
                let old = self.db.chat_task_for_session(&sid)?;
                if let Some(id) = old["id"].as_str() {
                    let summary = self.summary(id)?;
                    if summary["readOnly"] == false {
                        t["taskId"] = json!(id);
                        t["taskSessionId"] = fallback(&summary["sessionId"], json!(sid));
                    }
                }
            }
        }
        if let Some(id) = t["taskId"].as_str().filter(|s| !s.is_empty()) {
            let summary = self.summary(id)?;
            if summary.is_null() {
                return Err("Task not found".into());
            }
            if summary["readOnly"] == true {
                return Err("固定任务已归档或只读".into());
            }
            t["taskSessionId"] = fallback(
                &summary["sessionId"],
                fallback(&t["taskSessionId"], Value::Null),
            );
        } else {
            let title = text(&t["name"]);
            if title.trim().is_empty() || title.encode_utf16().count() > 120 {
                return Err("Directory, title and clientMsgId required".into());
            }
            let cli = t["cli"]
                .as_str()
                .filter(|s| !s.is_empty())
                .unwrap_or("claude");
            if !cli_switch::SUPPORTED_CHAT_CLIS.contains(&cli) {
                return Err(format!(
                    "cli must be {}",
                    cli_switch::SUPPORTED_CHAT_CLIS.join(", ")
                ));
            }
            let raw = format!("cron-task:{}", t["id"].as_str().unwrap_or(""));
            let client = raw
                .encode_utf16()
                .take(160)
                .map(|u| {
                    u8::try_from(u)
                        .ok()
                        .filter(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(b))
                        .map(char::from)
                        .unwrap_or('_')
                })
                .collect::<String>();
            let (key, task) =
                self.db
                    .reserve_schedule_task(&dir["id"], &client, title.trim(), cli)?;
            let sid = text(&task["sessionId"]);
            let id = text(&task["id"]);
            let record = if let Some(r) = self.records.iter().find(|r| r["id"] == sid) {
                if r["dirId"] != dir["id"] || r["taskBoundTaskId"] != id {
                    return Err("execution_identity_conflict".into());
                }
                r.clone()
            } else {
                let at = session_records::iso_timestamp_now();
                let p = Path::new(text(&dir["path"]))
                    .join(".multicc-worktrees")
                    .join(sid);
                let provider =
                    if let Some(pool) = multicc_core::provider_registry::app_type_for_cli(cli) {
                        let defaults =
                            multicc_core::provider_defaults_store::ProviderDefaultsStore::open(
                                self.root.join("provider-defaults.json"),
                            );
                        defaults.assert_readable()?;
                        multicc_core::provider_catalog::normalize_default(
                            self.root,
                            self.home,
                            pool,
                            &js::to_serde(&defaults.get(pool)),
                        )?
                    } else {
                        Value::Null
                    };
                let mut r = json!({"id":sid,"dirId":dir["id"],"cli":cli,"kind":"chat","cliSessionId":null,"label":title.trim(),"model":null,"effort":null,"agent":null,"provider":provider,"providerSelection":null,"autoCommit":true,"streaming":true,"autoContinue":true,"createdAt":at,"workspaceState":"planned","workspaceBaseCommit":null,"lastWorkAt":at,"worktreePath":p,"workspaceOwnerSessionId":null,"branch":format!("multicc/{sid}"),"taskBoundTaskId":id});
                r["cliStates"][cli] = cli_switch::active_state(
                    &r,
                    &json!(chrono::Utc::now().timestamp_millis()),
                    multicc_core::cli_capability::is_providerless(cli),
                    &[],
                )?;
                let mut all =
                    match durable_state::load_or_recover(&self.root.join("sessions.json"))? {
                        Some(js::JsValue::Array(rows)) => rows,
                        None => vec![],
                        _ => return Err("invalid session table".into()),
                    };
                all.push(js::from_serde(&r));
                durable_state::save(
                    &self.root.join("sessions.json"),
                    "sessions",
                    &js::JsValue::Array(all),
                )?;
                self.records.push(r.clone());
                r
            };
            crate::ws_chat_native::first_tasks::index(
                &self.root.join("task_board.json"),
                &mut self.board,
                &task,
            )?;
            self.db.complete_schedule_task(&key, &record, dir)?;
            t["taskId"] = json!(id);
            t["taskSessionId"] = json!(sid);
        }
        t["taskBindingVersion"] = 1.into();
        t["taskBindingError"] = json!("");
        t["taskBindingBrokenAt"] = Value::Null;
        t["taskBindingNotifiedFor"] = Value::Null;
        Ok(())
    }
}
fn load(
    root: &Path,
    package: &Path,
    home: &Path,
    read: Read,
    param: &str,
    body: &Value,
    delete: bool,
) -> Result<(u16, js::JsValue), String> {
    let path = root.join("scheduled_tasks.json");
    let legacy = package.join("plugins/cron/scheduled_tasks.json");
    let source = if !path.exists() && legacy.exists() {
        &legacy
    } else {
        &path
    };
    let raw = match std::fs::read(source) {
        Ok(bytes) if matches!(read, Read::Create | Read::Modify) => {
            serde_json::from_slice::<Value>(&bytes)
                .ok()
                .filter(Value::is_array)
                .ok_or("invalid schedule store")?
        }
        Ok(bytes) => serde_json::from_slice::<Value>(&bytes).unwrap_or_default(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Value::Null,
        Err(e) => return Err(e.to_string()),
    };
    let mut tasks = raw.as_array().cloned().unwrap_or_default();
    if read == Read::Runs {
        if source != &path {
            state_file::write_json_atomic(&path, &json!(tasks)).map_err(|e| e.to_string())?;
        }
        return history(&tasks, param);
    }
    let dirs = super::directory_list::records(&root.join("directories.json"))?;
    if read == Read::Modify {
        let Some(idx) = tasks.iter().position(|t| t["id"] == param) else {
            return Ok((404, js::from_serde(&json!({"error":"task not found"}))));
        };
        let current = &tasks[idx];
        if delete {
            tasks.remove(idx);
            state_file::write_json_atomic(&path, &json!(tasks)).map_err(|e| e.to_string())?;
            return Ok((200, js::from_serde(&json!({"ok":true}))));
        }
        for (field, error) in [
            ("dirId", "固定任务的工作目录不能修改；请新建另一条定时任务"),
            ("cli", "请打开固定 Air 任务修改 CLI / Provider"),
        ] {
            if truthy(&current["taskId"]) && body.get(field).is_some_and(|v| v != &current[field]) {
                return Ok((409, js::from_serde(&json!({"error":error}))));
            }
        }
        let mut merged = current.clone();
        for key in [
            "kind",
            "command",
            "scriptTimeoutMs",
            "name",
            "dirId",
            "cli",
            "prompt",
            "cron",
            "enabled",
            "createdBy",
            "dirPath",
        ] {
            if let Some(v) = body.get(key) {
                merged[key] = v.clone();
            }
        }
        let patch = match super::cron_create::definition(&merged, &dirs, package) {
            Ok(v) => v,
            Err(e) => return Ok((400, js::from_serde(&json!({"error":e})))),
        };
        let t = &mut tasks[idx];
        for (k, v) in patch.as_object().ok_or("invalid schedule")? {
            t[k] = v.clone();
        }
        t["_tickKey"] = Value::Null;
        let dir = dirs.iter().find(|d| d["id"] == t["dirId"]);
        let summary = if let Some(id) = t["taskId"].as_str() {
            Bindings::open(root, home)?.summary(id)?
        } else {
            Value::Null
        };
        let v = view(t, dir, &summary, chrono::Utc::now().timestamp_millis())?;
        state_file::write_json_atomic(&path, &json!(tasks)).map_err(|e| e.to_string())?;
        return Ok((200, v));
    }
    if read == Read::Create {
        let mut task = match super::cron_create::definition(body, &dirs, package) {
            Ok(task) => task,
            Err(error) => return Ok((400, js::from_serde(&json!({"error":error})))),
        };
        let dir = dirs.iter().find(|dir| dir["id"] == task["dirId"]);
        let mut summary = Value::Null;
        // A failed bind or final write leaves a private reservation. Retrying
        // this definition reuses its SQLite clientMsgId without making an
        // incomplete rule visible to the scheduler.
        let pending = super::cron_create::reserve(root, &mut task)?;
        if let Some(committed) = tasks.iter().find(|t| t["id"] == task["id"]) {
            task = committed.clone();
        } else {
            if task["kind"] != "script" {
                Bindings::open(root, home)?.bind(&mut task, dir)?;
            }
            tasks.push(task.clone());
            state_file::write_json_atomic(&path, &json!(tasks)).map_err(|e| e.to_string())?;
        }
        if let Some(id) = task["taskId"].as_str() {
            summary = Bindings::open(root, home)?.summary(id)?;
        }
        std::fs::remove_file(pending).map_err(|e| e.to_string())?;
        return Ok((
            200,
            view(&task, dir, &summary, chrono::Utc::now().timestamp_millis())?,
        ));
    }
    let mut binding = None;
    let mut rows = vec![];
    let now = chrono::Utc::now().timestamp_millis();
    for t in &mut tasks {
        if t.is_null() {
            return Err("invalid schedule".into());
        }
        let dir = dirs.iter().find(|d| d["id"] == t["dirId"]);
        let mut summary = Value::Null;
        if t["kind"] != "script" && t.is_object() {
            if binding.is_none() {
                binding = Some(Bindings::open(root, home)?);
            }
            let b = binding.as_mut().unwrap();
            if let Err(error) = b.bind(t, dir) {
                t["taskBindingError"] = error.into();
                t["taskBindingBrokenAt"] = fallback(&t["taskBindingBrokenAt"], now.into());
                t["taskBindingNotifiedFor"] = fallback(&t["taskId"], json!("unbound"));
            }
            if read == Read::List {
                if let Some(id) = t["taskId"].as_str() {
                    summary = b.summary(id)?;
                }
            }
        }
        if read == Read::List {
            rows.push(view(t, dir, &summary, now)?);
        }
    }
    if raw.as_array() != Some(&tasks) || source != &path {
        state_file::write_json_atomic(&path, &json!(tasks)).map_err(|e| e.to_string())?;
    }
    if read == Read::Calendar {
        let (status, body) = super::cron_calendar::render(&tasks, param, now);
        Ok((status, js::from_serde(&body)))
    } else {
        Ok((200, js::JsValue::Array(rows)))
    }
}
pub(crate) async fn handle(
    app: &Arc<App>,
    ctx: &RequestCtx,
    read: Read,
    body: Value,
) -> Response<Body> {
    use multicc_core::http_gate::{query_string, query_value};
    let param = match read {
        Read::Create | Read::List => String::new(),
        Read::Calendar => query_string(&query_value(&ctx.original_url, "month")),
        Read::Modify => {
            let raw = ctx
                .path
                .trim_end_matches('/')
                .rsplit('/')
                .next()
                .unwrap_or_default();
            let Some(id) = super::download::decode_uri_component(raw) else {
                return express::error(ctx, 400, "Failed to decode param");
            };
            id
        }
        Read::Runs | Read::Run => {
            let raw = ctx
                .path
                .trim_end_matches('/')
                .rsplit('/')
                .nth(1)
                .unwrap_or_default();
            let Some(id) = super::download::decode_uri_component(raw) else {
                return express::error(ctx, 400, "Failed to decode param");
            };
            id
        }
    };
    if ctx.method == "OPTIONS" {
        return super::options(
            ctx,
            match read {
                Read::Create | Read::List => "GET,HEAD,POST",
                Read::Calendar => "PATCH,DELETE,GET,HEAD",
                Read::Runs => "GET,HEAD",
                Read::Run => "POST",
                Read::Modify => "PATCH,DELETE",
            },
        );
    }
    if read == Read::Run {
        return match super::cron_runtime::manual(app, param).await {
            Ok((status, body)) => express::json(ctx, status, &body, &[]),
            Err(_) => express::error(ctx, 500, "schedule storage unavailable"),
        };
    }
    let app = app.clone();
    let delete = ctx.method == "DELETE";
    let result = tokio::spawn(async move {
        let _execution = if read == Read::Modify {
            Some(app.cron_execution.for_rule(&param).await.lock_owned().await)
        } else {
            None
        };
        let _cron = app.cron_lock.lock().await;
        let _records = app.native_chat.records.lock().await;
        let root = app.data_root.clone();
        let package = app.package_root.clone();
        let home = app.home_dir.clone();
        tokio::task::spawn_blocking(move || {
            let (status, body) = load(&root, &package, &home, read, &param, &body, delete)?;
            js::json_stringify(&body)
                .map(|s| (status, s))
                .ok_or_else(|| String::from("invalid schedule response"))
        })
        .await
    })
    .await;
    match result {
        Ok(Ok(Ok((status, body)))) => express::send(
            ctx,
            status,
            "application/json; charset=utf-8",
            body.into_bytes(),
            &[],
        ),
        _ => express::error(ctx, 500, "schedule read unavailable"),
    }
}
