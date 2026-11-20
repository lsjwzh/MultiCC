//! HTTP deliveries share the task receipt, scheduler and writer owners with chat.
use super::{provider::Provider, shell, store, Session};
use crate::app::App;
use multicc_core::{
    durable_state,
    js::{self, JsValue as V},
    quota_guard,
    task_shell::{chat, reference},
};
use serde_json::{json, Value};
use std::{path::Path, sync::Arc};
use tokio::sync::Mutex;

fn required<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value[key]
        .as_str()
        .filter(|text| !text.is_empty())
        .ok_or_else(|| format!("missing {key}"))
}

fn refusal(code: &str, status: u16) -> String {
    format!(
        "TASK_RULE:{}",
        json!({"code":code,"message":code,"status":status})
    )
}

fn input(root: &Path, request: &Value) -> Result<(String, V, bool), String> {
    let tasks = shell::task_store(root)?;
    let mut shell_id = request["shellId"].as_str().unwrap_or_default().to_owned();
    let mut raw = request["body"].clone();
    match request["op"].as_str() {
        Some("receipt-retry") => {
            tasks.shell_record(&shell_id)?;
            let receipt = tasks.delivery_record("receipt", required(request, "receiptId")?)?;
            if receipt.is_null() || receipt["shellId"] != shell_id {
                return Err(refusal("receipt_not_found", 404));
            }
            raw = receipt["payload"].clone();
            if let Some(voice) = raw.get("voice").cloned() {
                raw["inputSource"] = json!("voice");
                raw["voiceRaw"] = voice["raw"].clone();
            }
        }
        Some("task-message") => {
            let task = tasks.delivery_record("task", required(request, "taskId")?)?;
            if task.is_null() {
                return Err(refusal("task_not_found", 404));
            }
            shell_id = required(&task, "ownerShellId")?.to_owned();
            raw["taskId"] = task["id"].clone();
        }
        _ => {}
    }
    let raw = js::from_serde(&raw);
    chat::normalize_http(&raw, false).map_err(|e| {
        format!(
            "TASK_RULE:{}",
            json!({"code":e.code,"message":e.message,"status":400})
        )
    })?;
    Ok((shell_id, raw, request["op"] == "task-message"))
}

fn target(root: &Path, shell_id: &str, raw: &V) -> Result<(Value, Value), String> {
    let tasks = shell::task_store(root)?;
    let shell = tasks.shell_record(shell_id)?;
    let payload =
        js::to_serde(&chat::normalize_http(raw, false).map_err(|e| refusal(e.code, 400))?);
    let task_id = if payload["newTask"] == true {
        ""
    } else {
        payload["taskId"]
            .as_str()
            .or_else(|| shell["currentTaskId"].as_str())
            .or_else(|| shell["defaultTaskId"].as_str())
            .unwrap_or_default()
    };
    let task = tasks.delivery_record("task", task_id)?;
    Ok((shell, task))
}

fn reserve(
    root: &Path,
    shell_id: &str,
    raw: &V,
    state: Value,
    locked: bool,
) -> Result<Value, String> {
    let (shell, task) = target(root, shell_id, raw)?;
    let all = store::records(root)?;
    let source = store::lookup(&all, required(&shell, "sourceSessionId")?)
        .ok_or_else(|| refusal("source_session_missing", 409))?;
    let record = task["sessionId"]
        .as_str()
        .and_then(|id| store::lookup(&all, id))
        .unwrap_or(source);
    let board =
        multicc_core::task_domain::repository::read_board_snapshot(&root.join("task_board.json"))?;
    let payload =
        js::to_serde(&chat::normalize_http(raw, false).map_err(|e| refusal(e.code, 400))?);
    let mut snapshots = Vec::new();
    let tasks = shell::task_store(root)?;
    let mut references = std::collections::BTreeSet::new();
    for field in ["contextTaskIds", "dependsOn"] {
        for id in payload[field]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            references.insert(id);
        }
    }
    for id in references {
        let reference_task = tasks.delivery_record("task", id)?;
        if reference_task.is_null() {
            return Err(refusal("task_not_found", 404));
        }
        if reference_task["dirId"] != shell["dirId"] {
            return Err(refusal("project_mismatch", 403));
        }
        if tasks
            .delivery_record("link", &format!("{shell_id}:{id}"))?
            .is_null()
        {
            return Err(refusal("task_not_linked", 409));
        }
        let session_id = required(&reference_task, "sessionId")?;
        let source_record = store::lookup(&all, session_id)
            .ok_or_else(|| refusal("source_session_missing", 409))?;
        let question = super::question::read(root, session_id, source_record)?;
        let active = question
            .active
            .get("_activeTurn")
            .and_then(|turn| turn.get("turnId"));
        if payload["dependsOn"]
            .as_array()
            .is_some_and(|ids| ids.iter().any(|value| value == id))
            && store::text(&question.category, "classifyState") != "D"
        {
            return Err(refusal("dependency_not_ready", 409));
        }
        let snapshot = reference::snapshot(
            &V::from(id),
            &store::session_messages(root, session_id)?,
            active,
            12_000,
        );
        snapshots.push(js::json_stringify_or_undefined(&snapshot));
    }
    drop(tasks);
    let runtime = Value::Object(
        [
            "cli",
            "model",
            "provider",
            "providerSelection",
            "effort",
            "agent",
        ]
        .into_iter()
        .filter_map(|key| {
            source
                .get(key)
                .map(|value| (key.to_owned(), js::to_serde(value)))
        })
        .collect(),
    );
    shell::task_store(root)?.reserve_http_chat_input(
        &json!({"shellId":shell_id,"state":state,"board":board,
        "record":js::to_serde(record),"directory":shell::read_directory(root,record)?,
        "sourceRuntime":runtime,"snapshotBodies":snapshots,"estimatedTokens":0,"delivery":{"taskIdentityLocked":locked}}),
        raw,
    )
}

fn execution(root: &Path, task: &Value) -> Result<String, String> {
    let session = required(task, "sessionId")?;
    let mut all = store::records(root)?;
    let record = match store::lookup(&all, session) {
        Some(record) => record.clone(),
        None => {
            let directory = shell::read_directory(root, &js::from_serde(task))?;
            let repo = Path::new(required(&directory, "path")?)
                .canonicalize()
                .map_err(|e| e.to_string())?;
            let path = repo
                .join(multicc_core::docs_memory_routes::WORKTREE_SUBDIR)
                .join(session);
            let mut record = js::from_serde(&task["runtime"]);
            if !matches!(record, V::Object(_)) {
                record = V::Object(vec![]);
            }
            for (key, value) in [
                ("id", json!(session)),
                ("kind", json!("chat")),
                ("dirId", task["dirId"].clone()),
                ("label", task["title"].clone()),
                ("taskBoundTaskId", task["id"].clone()),
                ("workspaceState", json!("planned")),
                ("worktreePath", json!(path)),
                ("branch", json!(format!("multicc/{session}"))),
            ] {
                quota_guard::set(&mut record, key, js::from_serde(&value));
            }
            if let Some(commit) = task["forkBaseline"]["commit"].as_str() {
                quota_guard::set(&mut record, "workspaceBaseCommit", V::from(commit));
            }
            all.push(record.clone());
            durable_state::save(&root.join("sessions.json"), "sessions", &V::Array(all))?;
            record
        }
    };
    shell::task_store(root)?
        .activate_chat_execution(required(task, "id")?, &js::to_serde(&record))?;
    Ok(session.to_owned())
}

async fn state(
    app: &Arc<App>,
    task: &Value,
) -> Result<(Option<Arc<Mutex<Session>>>, Value), String> {
    let Some(session_id) = task["sessionId"].as_str() else {
        return Ok((None, json!({"busy":false})));
    };
    let root = app.data_root.clone();
    let id = session_id.to_owned();
    let present =
        shell::blocking(move || Ok(store::lookup(&store::records(&root)?, &id).is_some())).await?;
    if !present {
        return Ok((None, json!({"busy":false})));
    }
    let session = app.native_chat.session(app, session_id).await?;
    let current = session.lock().await;
    let root = app.data_root.clone();
    let id = session_id.to_owned();
    let record = current.stored.record.clone();
    let question = shell::blocking(move || super::question::read(&root, &id, &record)).await?;
    let facts = json!({"busy":current.active.is_some(),"taskId":task["id"],
        "turnId":current.active.as_ref().map(|turn|turn.id.clone()).or_else(||store::optional_text(&question.pending,"turnId")),
        "pending":js::to_serde(&question.pending)});
    drop(current);
    Ok((Some(session), facts))
}

pub(super) async fn deliver(app: &Arc<App>, request: Value) -> Result<Value, String> {
    let root = app.data_root.clone();
    let (shell_id, raw, locked) = shell::blocking(move || input(&root, &request)).await?;
    let root = app.data_root.clone();
    let replay_shell = shell_id.clone();
    let replay_raw = raw.clone();
    let replay = shell::blocking(move || {
        let mut tasks = shell::task_store(&root)?;
        let payload = chat::normalize_http(&replay_raw, false).map_err(|e| refusal(e.code, 400))?;
        let (id, _) = chat::receipt_identity(&replay_shell, &payload);
        if tasks.delivery_record("receipt", &id)?.is_null() {
            return Ok(None);
        }
        tasks
            .reserve_http_chat_input(&json!({"shellId":replay_shell}), &replay_raw)
            .map(Some)
    })
    .await?;
    if let Some(replay) = &replay {
        if replay["receipt"]["status"] == "accepted" {
            return Ok(replay["receipt"]["result"].clone());
        }
        if replay["receipt"]["status"] == "rejected" {
            return Err(refusal("stale_control", 409));
        }
    }
    let root = app.data_root.clone();
    let selected_shell = shell_id.clone();
    let selected_raw = raw.clone();
    let (_, task) = shell::blocking(move || target(&root, &selected_shell, &selected_raw)).await?;
    let (_, facts) = state(app, &task).await?;
    let root = app.data_root.clone();
    let reserved = match replay {
        Some(replay) => replay,
        None => shell::blocking(move || reserve(&root, &shell_id, &raw, facts, locked)).await?,
    };
    let receipt = reserved["receipt"].clone();
    if receipt["status"] == "accepted" {
        return Ok(receipt["result"].clone());
    }
    if receipt["status"] == "rejected" {
        return Err(refusal("stale_control", 409));
    }
    let result = deliver_reserved(app, reserved).await;
    match result {
        Ok(result) => Ok(result),
        Err(error) => {
            let mut fault = error
                .strip_prefix("TASK_RULE:")
                .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
                .unwrap_or_else(|| json!({"code":"delivery_failed","message":error,"status":500}));
            let root = app.data_root.clone();
            let id = receipt["id"].clone();
            let detail = fault.clone();
            shell::blocking(move || {
                shell::task_store(&root)?.settle_receipt(&json!({"receiptId":id,"error":detail}))
            })
            .await?;
            fault["receiptId"] = receipt["id"].clone();
            fault["taskId"] = receipt["taskId"].clone();
            fault["notDelivered"] = json!(fault["code"] == "stale_control");
            Err(format!("TASK_RULE:{fault}"))
        }
    }
}

async fn deliver_reserved(app: &Arc<App>, reserved: Value) -> Result<Value, String> {
    let receipt = reserved["receipt"].clone();
    let root = app.data_root.clone();
    let task = reserved["task"].clone();
    let task_id = required(&task, "id")?.to_owned();
    let id = {
        let _guard = app.native_chat.records.lock().await;
        shell::blocking(move || execution(&root, &task)).await?
    };
    let session = app.native_chat.session(app, &id).await?;
    let mut current = session.lock().await;
    if !shell::supported(&current) {
        return Err(refusal("chat_route_unavailable", 409));
    }
    if receipt["payload"]["intent"] != "cancel" {
        Provider::load(&app.data_root, &current.stored.record).await?;
    }
    if receipt["payload"]["intent"] == "cancel" {
        if current.active.as_ref().map(|turn| turn.id.as_str())
            != receipt["payload"]["turnId"].as_str()
            || !current
                .active
                .as_mut()
                .and_then(|turn| turn.cancel.take())
                .is_some_and(|cancel| cancel.send(()).is_ok())
        {
            return Err(refusal("stale_control", 409));
        }
    } else {
        let root = app.data_root.clone();
        let record = js::to_serde(&current.stored.record);
        let execution = id.clone();
        let reserved_receipt = receipt.clone();
        let notification = shell::blocking(move || {
            shell::admit_receipt(&root, &execution, &record, &reserved_receipt)
        })
        .await?;
        if !notification.is_null() {
            app.native_chat
                .publish(&id, js::from_serde(&notification), false);
        }
    }
    let root = app.data_root.clone();
    let execution = id.clone();
    let result = shell::blocking(move || {
        shell::task_store(&root)?
            .settle_receipt(&json!({"receiptId":receipt["id"],"sessionId":execution}))
    })
    .await?;
    drop(current);
    shell::wake(app, &id, &session, task_id).await;
    Ok(result["result"].clone())
}
