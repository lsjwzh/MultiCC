//! The legacy GET migrates rules to fixed task-shell identities before rendering.
use super::{
    express::{self, RequestCtx},
    App, Route,
};
use axum::{
    body::Body,
    http::{Method, Response},
};
use chrono::{Datelike, Local, TimeZone, Timelike};
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
    Calendar,
    Runs,
}

pub(crate) fn claim(standalone: bool, method: &Method, path: &str) -> Option<Route> {
    if !standalone || !matches!(method.as_str(), "GET" | "HEAD" | "OPTIONS") {
        return None;
    }
    let path = path.strip_prefix("/api/")?;
    let mut parts = path.strip_suffix('/').unwrap_or(path).split('/');
    if !parts.next()?.eq_ignore_ascii_case("cron") {
        return None;
    }
    let read = match (parts.next(), parts.next(), parts.next()) {
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
fn field(field: &str, min: u32, max: u32) -> Option<u64> {
    fn integer(s: &str) -> Option<u32> {
        let s = s.trim().trim_start_matches('+');
        s[..s.bytes().take_while(u8::is_ascii_digit).count()]
            .parse()
            .ok()
    }
    let mut mask = 0;
    for part in field.split(',') {
        let slash: Vec<_> = part.split('/').collect();
        let (range, step) = if slash.len() == 2 {
            (slash[0], integer(slash[1]).filter(|n| *n > 0)?)
        } else {
            (part, 1)
        };
        let (lo, hi) = if range == "*" {
            (min, max)
        } else if let Some((lo, hi)) = range.split_once('-') {
            (integer(lo)?, integer(hi)?)
        } else {
            let n = integer(range)?;
            (n, n)
        };
        if lo < min || hi > max || hi < lo {
            return None;
        }
        for i in (lo..=hi).step_by(step as usize) {
            mask |= 1 << i;
        }
    }
    Some(mask)
}
pub(super) fn next_before(expr: &str, now: i64, end: Option<i64>) -> Option<i64> {
    let fields = expr.split_whitespace().collect::<Vec<_>>();
    if fields.len() != 5 {
        return None;
    }
    let bounds = [(0, 59), (0, 23), (1, 31), (1, 12), (0, 6)];
    let mut masks = [0; 5];
    for i in 0..5 {
        masks[i] = field(fields[i], bounds[i].0, bounds[i].1)?;
    }
    let has = |i: usize, n: u32| masks[i] & (1 << n) != 0;
    let start = Local
        .timestamp_millis_opt(now)
        .single()?
        .naive_local()
        .with_second(0)?
        .with_nanosecond(0)?;
    let stop = end
        .and_then(|ms| Local.timestamp_millis_opt(ms).single())
        .map(|t| t.naive_local());
    for n in 1..=366 * 1440 {
        let dt = start + chrono::Duration::minutes(n);
        if stop.is_some_and(|end| dt >= end) {
            break;
        }
        if has(0, dt.minute()) && has(1, dt.hour()) && has(3, dt.month()) {
            let dom = has(2, dt.day());
            let dow = has(4, dt.weekday().num_days_from_sunday());
            if if masks[2].count_ones() != 31 && masks[4].count_ones() != 7 {
                dom || dow
            } else {
                dom && dow
            } {
                if let Some(t) = Local.from_local_datetime(&dt).earliest() {
                    return Some(t.timestamp_millis());
                }
            }
        }
    }
    None
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
struct Bindings<'a> {
    root: &'a Path,
    db: TaskStore,
    board: Value,
    records: Vec<Value>,
}
impl Bindings<'_> {
    fn summary(&self, id: &str) -> Result<Value, String> {
        let mut summary = self.db.schedule_summary(id, &self.board, &self.records)?;
        if summary["runtime"].is_object() {
            crate::ws_chat_native::session_list::normalize_provider(&mut summary["runtime"]);
        }
        Ok(summary)
    }
    fn bind(&mut self, t: &mut Value, dir: Option<&Value>) -> Result<(), String> {
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
                let provider = match cli {
                    "claude" | "claude-exp" => Some("claude-official"),
                    "codex" | "codex-exp" => Some("codex-official"),
                    _ => None,
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
    read: Read,
    param: &str,
) -> Result<(u16, js::JsValue), String> {
    let path = root.join("scheduled_tasks.json");
    let legacy = package.join("plugins/cron/scheduled_tasks.json");
    let source = if !path.exists() && legacy.exists() {
        &legacy
    } else {
        &path
    };
    let raw = match std::fs::read(source) {
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
                let mut board = repository::read_board_snapshot(&root.join("task_board.json"))?;
                if board.is_null() {
                    board = normalize::empty();
                }
                binding = Some(Bindings {
                    root,
                    board,
                    records: super::directory_list::records(&root.join("sessions.json"))?,
                    db: TaskStore::open(
                        root.join("task-shells.sqlite")
                            .to_str()
                            .ok_or("invalid task store path")?,
                    )?,
                });
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
pub(crate) async fn handle(app: &Arc<App>, ctx: &RequestCtx, read: Read) -> Response<Body> {
    use multicc_core::http_gate::{query_string, query_value};
    let param = match read {
        Read::List => String::new(),
        Read::Calendar => query_string(&query_value(&ctx.original_url, "month")),
        Read::Runs => {
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
                Read::List => "GET,HEAD,POST",
                Read::Calendar => "PATCH,DELETE,GET,HEAD",
                Read::Runs => "GET,HEAD",
            },
        );
    }
    let app = app.clone();
    let result = tokio::spawn(async move {
        let _cron = app.cron_lock.lock().await;
        let _records = app.native_chat.records.lock().await;
        let root = app.data_root.clone();
        let package = app.package_root.clone();
        tokio::task::spawn_blocking(move || {
            let (status, body) = load(&root, &package, read, &param)?;
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
