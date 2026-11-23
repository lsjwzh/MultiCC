//! Native delivery through the durable scheduler and workspace writer fence.
use super::{
    error_frame, prepare_turn, provider::Provider, run_turn, store, Session, ShellRoute, TurnEnd,
    TurnInput,
};
use crate::app::App;
use multicc_core::{
    auth_runtime, code_revision, durable_state,
    js::{self, JsValue as V},
    orchestration_retention::RetentionPolicy,
    orchestration_store::{self, Store},
    quota_guard, random_id,
    task_shell::chat::{self, Intent},
    task_store::TaskStore,
};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::sync::Mutex;

pub(super) fn now() -> i64 {
    auth_runtime::now_ms() as i64
}

pub(super) fn task_store(root: &Path) -> Result<TaskStore, String> {
    let path = root.join("task-shells.sqlite");
    TaskStore::open(path.to_str().ok_or("invalid task store path")?)
}

pub(super) fn queue_store(root: &Path) -> Result<Store, String> {
    let path = root.join("orchestration.sqlite");
    let legacy = root.join("orchestration.json");
    Store::open(
        path.to_str().ok_or("invalid queue store path")?,
        Some(legacy.to_str().ok_or("invalid legacy queue store path")?),
        now(),
        RetentionPolicy::default(),
    )
}

pub(super) fn adoption_facts(
    root: &Path,
    id: &str,
    record: &V,
    board: &Value,
) -> Result<Value, String> {
    let pending = super::question::read(root, id, record)?.pending;
    let last = store::last_task_message(root, id, board)?;
    Ok(
        json!({"sessionId":id,"record":js::to_serde(record),"taskFirst":true,
        "indexed":board["tasks"],"deleted":board["deletedTaskIds"],"pending":js::to_serde(&pending),"last":last}),
    )
}

pub(super) fn registry(root: &Path, request: &Value) -> Result<Value, String> {
    let all = store::records(root)?;
    let mut tasks = task_store(root)?;
    let shell_id = request["shellId"].as_str().unwrap_or_default();
    match request["op"].as_str() {
        Some("open") => {
            let id = request["sessionId"].as_str().unwrap_or_default();
            let record = store::lookup(&all, id).cloned().unwrap_or(V::Null);
            if record == V::Null
                || store::text(&record, "kind") != "chat"
                || ["aux", "gateway"].contains(&store::text(&record, "type").as_str())
                || js::truthy_opt(record.get("taskExecutionSlot"))
                || js::truthy_opt(record.get("experimentalMode"))
            {
                // Let the shared owner preserve the validation error order.
                return tasks.open_chat_shell(
                    &json!({"sessionId":id,"record":js::to_serde(&record),"taskFirst":true}),
                );
            }
            let board = multicc_core::task_domain::repository::read_board_snapshot(
                &root.join("task_board.json"),
            )?;
            tasks.open_chat_shell(&adoption_facts(root, id, &record, &board)?)
        }
        Some("view") => {
            let shell = tasks.shell_record(shell_id)?;
            let source = shell["sourceSessionId"]
                .as_str()
                .and_then(|id| store::lookup(&all, id))
                .map_or(Value::Null, js::to_serde);
            tasks.shell_view(shell_id, &source)
        }
        Some("select-target") => {
            let board = multicc_core::task_domain::repository::read_board_snapshot(&root.join("task_board.json"))?;
            let shell = tasks.shell_record(shell_id)?;
            let source = shell["sourceSessionId"].as_str().and_then(|id| store::lookup(&all, id))
                .map_or(Value::Null, js::to_serde);
            let task = request["taskId"].as_str().unwrap_or_default();
            tasks.select_chat_shell_target(&json!({"shellId":shell_id,"taskId":request["taskId"],
                "expectedCursorVersion":request["expectedCursorVersion"],"record":source,
                "indexed":board["tasks"][task],"deleted":board["deletedTaskIds"].as_array().is_some_and(|ids| ids.iter().any(|id| id == task))
            }))
        }
        Some("context") => tasks.shell_context_trace(&json!({
            "sessionId":request["sessionId"], "receiptId":request["traceId"], "includeMessages":request["includeMessages"]
        })),
        _ => Err("invalid task-shell registry operation".into()),
    }
}

fn response(value: Value) -> Result<Value, String> {
    match value["resultJson"].as_str() {
        Some(raw) => multicc_core::json_lenient::from_str(raw).map_err(|error| error.to_string()),
        None => Ok(value["result"].clone()),
    }
}

pub(super) fn supported(state: &Session) -> bool {
    let record = &state.stored.record;
    store::is_claude(record)
        && store::text(record, "kind") == "chat"
        && !["gateway", "aux", "commander"].contains(&store::text(record, "type").as_str())
        && ![
            "subagent",
            "experimentalMode",
            "pendingCliHandoff",
            "cliAccounts",
            "unattended",
        ]
        .iter()
        .any(|field| js::truthy_opt(record.get(field)))
        && matches!(
            store::text(record, "workspaceState").as_str(),
            "" | "awake" | "planned"
        )
        && !store::text(record, "worktreePath").is_empty()
}

pub(super) fn workspace_request(
    root: &Path,
    id: &str,
    record: &V,
    cwd: &Path,
) -> Result<Value, String> {
    let declared = PathBuf::from(store::text(record, "worktreePath"));
    if store::text(record, "workspaceState") == "planned" {
        if js::truthy_opt(record.get("workspaceOwnerSessionId"))
            || Path::new(id).file_name().and_then(|name| name.to_str()) != Some(id)
        {
            return Err("workspace_identity_conflict".into());
        }
        let directory = read_directory(root, record)?;
        let base = PathBuf::from(required(&directory, "path")?);
        let repo = base
            .canonicalize()
            .map_err(|_| "workspace_directory_missing")?;
        let subdir = multicc_core::docs_memory_routes::WORKTREE_SUBDIR;
        let target = repo.join(subdir).join(id);
        let branch = format!("multicc/{id}");
        if (declared != target && declared != base.join(subdir).join(id))
            || store::text(record, "branch") != branch
        {
            return Err("workspace_identity_conflict".into());
        }
        let base_ref = required(&directory, "baseBranch")?;
        let source =
            optional_base_commit(record)?.unwrap_or_else(|| format!("refs/heads/{base_ref}"));
        return Ok(json!({"sessionId":id,"dirId":directory["id"],"path":target,
            "repo":repo,"branch":branch,"baseRef":base_ref,"source":source}));
    }
    let expected = declared.canonicalize().map_err(|error| error.to_string())?;
    let cwd = cwd.canonicalize().map_err(|error| error.to_string())?;
    if cwd != expected || !cwd.is_dir() {
        return Err("workspace_admission_required".into());
    }
    Ok(json!({"sessionId":id,"dirId":js::to_serde(record)["dirId"],"path":cwd}))
}

fn optional_base_commit(record: &V) -> Result<Option<String>, String> {
    let commit = store::optional_text(record, "workspaceBaseCommit");
    if commit.as_ref().is_some_and(|commit| {
        !matches!(commit.len(), 40 | 64) || !commit.bytes().all(|part| part.is_ascii_hexdigit())
    }) {
        return Err("workspace_invalid_base_commit".into());
    }
    Ok(commit)
}

pub(super) fn read_directory(root: &Path, record: &V) -> Result<Value, String> {
    Ok(
        durable_state::load_or_recover(&root.join("directories.json"))?
            .and_then(|all| match all {
                V::Array(dirs) => dirs
                    .into_iter()
                    .find(|dir| dir.get("id") == record.get("dirId")),
                _ => None,
            })
            .map_or(Value::Null, |directory| js::to_serde(&directory)),
    )
}

pub(super) async fn linked_target(
    root: &Path,
    shell: &str,
    id: &str,
    intent: Intent,
) -> Result<(String, String), String> {
    let (root, shell, id) = (root.to_owned(), shell.to_owned(), id.to_owned());
    blocking(move || {
        let all = store::records(&root)?;
        TaskStore::linked_chat_target(
            &root.join("task-shells.sqlite"),
            &shell,
            &id,
            |id, directory| store::session_in_directory(&all, id, directory),
            intent,
        )
    })
    .await
}

pub(super) async fn submit(
    app: &App,
    id: &str,
    session: &Mutex<Session>,
    route: ShellRoute<'_>,
    message: &V,
    control_task: Option<&str>,
) -> V {
    let mut state = session.lock().await;
    let intent = chat::intent(message);
    if !supported(&state) {
        return error_frame(
            "chat_route_unavailable",
            "Task shell delivery is unavailable",
        );
    }
    let id = id.to_owned();
    let shell = route.id.map(ToOwned::to_owned);
    let control_task = control_task.map(ToOwned::to_owned);
    let mut active = json!({"busy":state.active.is_some(),
        "turnId":state.active.as_ref().map(|turn| &turn.id),
        "taskId":state.active.as_ref().and_then(|turn| turn.task.as_ref())
    });
    let root = app.data_root.clone();
    if matches!(intent, Intent::Work | Intent::Answer) {
        if let Err(error) = Provider::load(&root, &state.stored.record).await {
            return error_frame("chat_provider_unavailable", &error);
        }
    }
    let submit_root = root.clone();
    let cwd = state.stored.cwd.clone();
    let record = state.stored.record.clone();
    let client_id = message.get("clientMsgId").cloned().unwrap_or(V::Undefined);
    let message = message.clone();
    let execution = id.clone();
    let result = blocking(move || {
        let id = execution;
        let workspace = workspace_request(&submit_root, &id, &record, &cwd)?;
        let mut tasks = task_store(&submit_root)?;
        if workspace["repo"].is_null() {
            tasks.resident_chat_workspace(&workspace)?;
        }
        let board = multicc_core::task_domain::repository::read_board_snapshot(
            &submit_root.join("task_board.json"),
        )?;
        let directory = read_directory(&submit_root, &record)?;
        if intent == Intent::Answer {
            let question = super::question::read(&submit_root, &id, &record)?;
            let current = question.category.get("userInputSignalTurnId");
            if !multicc_core::js::truthy_opt(current) || current == question.pending.get("turnId") {
                active["pending"] = js::to_serde(&question.pending);
                active["turnId"] = active["pending"]["turnId"].clone();
            }
        }
        let record = js::to_serde(&record);
        let reserved = tasks.reserve_native_chat_input(
            shell.as_deref(),
            &id,
            &json!({"record":record,"directory":directory,"board":board,"state":active,"controlTaskId":control_task}),
            &message,
        )?;
        let receipt = &reserved["receipt"];
        let notification = admit_receipt(&submit_root, &id, &record, receipt)?;
        Ok((receipt.clone(), notification))
    })
    .await;
    let result = match result {
        Ok((receipt, notification)) => {
            if !notification.is_null() {
                app.native_chat
                    .publish(&id, super::value(notification), false);
            }
            if intent == Intent::Cancel && receipt["status"] != "accepted" {
                let cancelled = state.active.as_mut().and_then(|turn| turn.cancel.take());
                if !cancelled.is_some_and(|cancelled| cancelled.send(()).is_ok()) {
                    return chat::Rejection::new(
                        "stale_control",
                        "The task has moved to another turn",
                    )
                    .frame(client_id);
                }
            }
            blocking(move || {
                let receipt_id = required(&receipt, "id")?;
                let settled = task_store(&root)?
                    .settle_receipt(&json!({"receiptId":receipt_id,"sessionId":id}))?;
                Ok(chat::routed_frame(
                    required(&receipt, "shellId")?,
                    receipt_id,
                    required(&receipt, "taskId")?,
                    &id,
                    required(&settled["result"], "decision")?,
                    client_id,
                ))
            })
            .await
        }
        Err(error) => Err(error),
    };
    result.unwrap_or_else(|error| delivery_error(&error))
}

pub(super) fn delivery_error(error: &str) -> V {
    let fault = error
        .strip_prefix("TASK_RULE:")
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok());
    if let Some(fault) = fault {
        if let Some(code) = fault["code"].as_str() {
            return error_frame(code, fault["message"].as_str().unwrap_or(code));
        }
    }
    error_frame("task_shell_failed", error)
}

pub(super) fn admit_queue(queue: &mut Store, request: String) -> Result<Value, String> {
    let mut input = json!({"requestJson":request});
    for retry in 0..=4 {
        input["expectedRevision"] =
            queue.request("info", &Value::Null)?["state"]["revision"].clone();
        input["now"] = json!(now());
        match queue.request("scheduleAdmit", &input) {
            Err(error) if retry < 4 && error.starts_with("ORCHESTRATION_SQLITE_CONFLICT:") => {}
            result => return response(result?),
        }
    }
    unreachable!("the last admission returns its result")
}

pub(super) fn admit_receipt(
    root: &Path,
    session: &str,
    record: &Value,
    receipt: &Value,
) -> Result<Value, String> {
    if receipt["status"] == "accepted" || receipt["payload"]["intent"] == "cancel" {
        return Ok(Value::Null);
    }
    let receipt_id = required(receipt, "id")?;
    let task_id = required(receipt, "taskId")?;
    let payload = &receipt["payload"];
    let mut tasks = task_store(root)?;
    let role = tasks.delivery_role_prompt(receipt)?;
    let mut request = json!({"sessionId":session,"text":payload["text"],"source":"task-shell",
        "idempotencyKey":receipt_id,"hostAdmission":true,"initialState":{
            "pendingQuestion":record["taskState"]["pendingUserInput"],"activeTurn":null,
            "category":{"classifyState":record["taskState"]["classifyState"]}},
        "options":{"taskId":task_id,"taskSource":"task-shell","taskStart":payload["intent"] == "work",
            "taskShellReceiptId":receipt_id,"clientMsgId":receipt_id,"nativeShellWork":true,
            "originContinue":true,"rolePrompt":role}});
    if payload["intent"] != "work" {
        request["options"]["taskShellControl"] =
            json!({"intent":payload["intent"],"turnId":payload["turnId"]});
    }
    if payload["intent"] == "answer" {
        request["options"]["userInputRequestId"] = payload["requestId"].clone();
    }
    let admitted = admit_queue(&mut queue_store(root)?, request.to_string())?;
    if admitted["ok"] != true {
        let code = required(&admitted, "code")?;
        tasks.settle_receipt(&json!({"receiptId":receipt_id,"error":{"code":code}}))?;
        return Err(format!(
            "TASK_RULE:{}",
            json!({"code":code,"message":if code == "stale_control" { "The question is no longer pending" } else { code },"status":409})
        ));
    }
    Ok(admitted["notification"].clone())
}

pub(super) async fn wake(app: &Arc<App>, id: &str, session: &Arc<Mutex<Session>>, task: String) {
    let mut state = session.lock().await;
    if state.shell_worker || state.active.is_some() || !supported(&state) {
        return;
    }
    state.shell_worker = true;
    drop(state);
    let (app, id, session) = (Arc::clone(app), id.to_owned(), Arc::clone(session));
    tokio::spawn(async move {
        let worker = match random_id::prefixed_id("chat") {
            Ok(id) => id,
            Err(error) => {
                session.lock().await.shell_worker = false;
                app.native_chat.publish(
                    &id,
                    error_frame("internal_error", &error.to_string()),
                    false,
                );
                return;
            }
        };
        let mut deferrals = 0;
        loop {
            let mut state = session.lock().await;
            let next = claim(&app.data_root, &id, &task, &worker).await;
            let delivery = match next {
                Ok(Some(delivery)) => delivery,
                Ok(None) => {
                    state.shell_worker = false;
                    return;
                }
                Err(error) => {
                    state.shell_worker = false;
                    app.native_chat
                        .publish(&id, error_frame("chat_claim_failed", &error), false);
                    return;
                }
            };
            let writer = match Writer::acquire(&app, &delivery, &mut state, &worker).await {
                Ok(writer) => writer,
                Err(error) => {
                    let defer = matches!(
                        error.as_str(),
                        "workspace_busy"
                            | "workspace_execution_capacity"
                            | "workspace_restore_capacity"
                            | "workspace_resident_capacity"
                    );
                    let released = delivery.release(&error, defer).await;
                    if defer && released.is_ok() && deferrals < 30 {
                        deferrals += 1;
                        drop(state);
                        tokio::time::sleep(Duration::from_millis(1100)).await;
                        continue;
                    }
                    state.shell_worker = false;
                    let error = released.err().unwrap_or(error);
                    app.native_chat.publish(
                        &id,
                        error_frame("chat_writer_unavailable", &error),
                        false,
                    );
                    return;
                }
            };
            deferrals = 0;
            let launched = prepare_turn(
                &app,
                &id,
                &mut state,
                &delivery.prompt,
                Some(&delivery.receipt),
                TurnInput::Shell(&delivery),
            )
            .await;
            drop(state);
            let completion = match launched {
                Ok(launched) => {
                    let end = run_turn(
                        &app,
                        &id,
                        &session,
                        launched,
                        &delivery.prompt,
                        Some((&writer, &delivery)),
                    )
                    .await;
                    match writer.stop(end.stopped, Some(&end)).await {
                        Ok(()) if end.stopped => delivery.complete(&end).await,
                        Ok(()) => Err("writer_stop_unverified".into()),
                        Err(error) => Err(error),
                    }
                }
                Err((code, detail)) => {
                    app.native_chat
                        .publish(&id, error_frame(code, &detail), false);
                    match writer.stop(true, None).await {
                        Ok(()) => delivery.release(code, false).await,
                        Err(error) => Err(error),
                    }
                }
            };
            if let Err(error) = completion {
                session.lock().await.shell_worker = false;
                app.native_chat
                    .publish(&id, error_frame("chat_completion_failed", &error), false);
                return;
            }
            let root = app.data_root.clone();
            let execution = id.clone();
            if let Ok(queue) = blocking(move || {
                orchestration_store::chat_queue_snapshot(
                    &root.join("orchestration.sqlite"),
                    &execution,
                )
            })
            .await
            {
                app.native_chat.publish(&id, queue, false);
            }
        }
    });
}

async fn claim(
    root: &Path,
    id: &str,
    task: &str,
    worker: &str,
) -> Result<Option<Delivery>, String> {
    let (root, id, task, worker) = (
        root.to_owned(),
        id.to_owned(),
        task.to_owned(),
        worker.to_owned(),
    );
    blocking(move || {
        let picked = queue_store(&root)?.request(
            "scheduleClaimChat",
            &json!({
                "sessionId":id,"taskId":task,"workerId":worker,"at":now()
            }),
        )?;
        if picked.is_null() {
            return Ok(None);
        }
        let payload: Value =
            multicc_core::json_lenient::from_str(required(&picked, "payloadJson")?)
                .map_err(|error| error.to_string())?;
        let options = &payload["options"];
        Ok(Some(Delivery {
            root,
            id,
            task,
            entry: required(&picked, "entryId")?.into(),
            token: required(&picked, "leaseToken")?.into(),
            attempt: picked["attempt"].clone(),
            receipt: required(options, "taskShellReceiptId")?.into(),
            answer: options["userInputRequestId"].is_string(),
            role_prompt: options["rolePrompt"]
                .as_str()
                .filter(|text| !text.is_empty())
                .map(ToOwned::to_owned),
            prompt: required(&payload, "message")?.into(),
        }))
    })
    .await
}

pub(super) struct Delivery {
    root: PathBuf,
    id: String,
    pub task: String,
    pub entry: String,
    token: String,
    attempt: Value,
    receipt: String,
    prompt: String,
    pub answer: bool,
    pub role_prompt: Option<String>,
}

impl Delivery {
    pub async fn reference_seed(&self, first: bool) -> Result<String, String> {
        if !first {
            return Ok(String::new());
        }
        let (root, task, session) = (self.root.clone(), self.task.clone(), self.id.clone());
        let receipt_id = self.receipt.clone();
        blocking(move || {
            let history = store::session_messages(&root, &session)?;
            let mut tasks = task_store(&root)?;
            let seed = tasks.shell_context_seed(&task, true, "", &history)?;
            let record = tasks.delivery_record("task", &task)?;
            let mut receipt = tasks.delivery_record("receipt", &receipt_id)?;
            receipt["contextSeedSnapshotIds"] =
                record.get("snapshotIds").cloned().unwrap_or(json!([]));
            tasks.run(
                &json!({"op":"set","kind":"receipt","id":receipt_id,"body":receipt.to_string()})
                    .to_string(),
            )?;
            Ok(seed)
        })
        .await
    }

    async fn change(&self, op: &'static str, mut input: Value) -> Result<Value, String> {
        let root = self.root.clone();
        let at = now();
        input["sessionId"] = json!(self.id);
        input["entryId"] = json!(self.entry);
        input["leaseToken"] = json!(self.token);
        input["at"] = json!(at);
        input["updatedAt"] = json!(at);
        blocking(move || queue_store(&root)?.request(op, &input)).await
    }

    pub async fn handoff(&self) -> Result<(), String> {
        let result = response(self.change("scheduleHandoff", json!({})).await?)?;
        if result["acknowledged"]["ok"] != true {
            return Err(required(&result["acknowledged"], "code")?.into());
        }
        Ok(())
    }

    async fn release(&self, reason: &str, defer: bool) -> Result<(), String> {
        self.change(
            "scheduleReleaseChat",
            json!({"reason":reason,"defer":defer}),
        )
        .await?;
        Ok(())
    }

    async fn complete(&self, end: &TurnEnd) -> Result<(), String> {
        let result = response(
            self.change(
                "scheduleCompleteAtomicExperimental",
                json!({
                    "expectedTaskIdJson":json!(self.task).to_string(),
                    "expectedDeliveryId":self.entry,"expectedAttempt":self.attempt,
                    "reasonJson":json!(end.phase).to_string(),"awaitingRequestIdJson":json!(end.awaiting).to_string(),
                    "classifyStateJson":json!(if end.awaiting.is_some() { "W" } else if end.phase == "failed" { "E" } else { "D" }).to_string()
                }),
            )
            .await?,
        )?;
        if result["ok"] != true {
            return Err(required(&result, "code")?.into());
        }
        Ok(())
    }
}

pub(super) struct Writer {
    root: PathBuf,
    cwd: PathBuf,
    facts: Value,
}

impl Writer {
    async fn acquire(
        app: &App,
        delivery: &Delivery,
        state: &mut Session,
        worker: &str,
    ) -> Result<Self, String> {
        let (root, id, entry, worker) = (
            delivery.root.clone(),
            delivery.id.clone(),
            delivery.entry.clone(),
            worker.to_owned(),
        );
        let (cwd, record) = (state.stored.cwd.clone(), state.stored.record.clone());
        let planned = store::text(&record, "workspaceState") == "planned";
        let _records = if planned {
            Some(app.native_chat.records.lock().await)
        } else {
            None
        };
        let (writer, updated) = blocking(move || {
            let mut request = workspace_request(&root, &id, &record, &cwd)?;
            request["epoch"] = json!(worker);
            request["requestId"] = json!(entry);
            request["now"] = json!(now());
            for (field, env, default) in [
                ("executionLimit", "MULTICC_WORKSPACE_RUN_LIMIT", 8),
                ("residentLimit", "MULTICC_WORKSPACE_RESIDENT_LIMIT", 128),
                ("restoreLimit", "MULTICC_WORKSPACE_RESTORE_LIMIT", 2),
            ] {
                let n = match std::env::var(env) {
                    Ok(text) => text.parse::<u64>().map_err(|_| format!("invalid {env}"))?,
                    Err(_) => default,
                };
                request[field] = json!(n);
            }
            if !planned {
                let facts = task_store(&root)?.acquire_chat_writer(&request)?;
                return Ok((Self { root, facts, cwd }, None));
            }
            let mut tasks = task_store(&root)?;
            let lease = tasks.reserve_chat_materialization(&request)?;
            let cwd = PathBuf::from(required(&request, "path")?);
            let facts = match (|| {
                let (head, common_dir) = multicc_core::worktree_sync::materialize_planned(
                    Path::new(required(&request, "repo")?), &cwd,
                    required(&request, "branch")?, required(&request, "source")?,
                )?;
                let observed = json!({"head":head,"commonDir":common_dir,"now":now()});
                tasks.activate_chat_materialization(&lease, &observed)
            })() {
                Ok(facts) => facts,
                Err(error) => {
                    tasks.workspace_transition(&json!({"workspaceId":lease["workspaceId"],"leaseId":lease["id"],
                        "epoch":lease["epoch"],"state":"released","now":now(),"fields":{"materializing":false}}))?;
                    return Err(error);
                }
            };
            let updated = match store::update_record(&root, &id, |record| {
                quota_guard::set(record, "workspaceState", V::from("awake"));
                quota_guard::set(record, "worktreePath", V::from(cwd.to_string_lossy().as_ref()));
                quota_guard::set(record, "workspaceId", js::from_serde(&lease["workspaceId"]));
                quota_guard::set(record, "workspaceStateErrorCode", V::Null);
            }) {
                Ok(record) => record,
                Err(error) => {
                    tasks.finish_chat_writer(&facts, true, now(), None)?;
                    return Err(error);
                }
            };
            Ok((Self { root, facts, cwd }, Some(updated)))
        })
        .await?;
        if let Some(record) = updated {
            state.stored.cwd = writer.cwd.clone();
            state.stored.record = record;
        }
        Ok(writer)
    }

    pub async fn started(
        &self,
        pid: i32,
        turn: &str,
        attempt: &str,
        delivery: &Delivery,
    ) -> Result<(), String> {
        let (root, facts) = (self.root.clone(), self.facts.clone());
        let run = json!({"turnId":turn,"attemptId":attempt,"receiptId":delivery.receipt,"taskId":delivery.task});
        blocking(move || task_store(&root)?.start_chat_writer(&facts, pid, now(), &run)).await
    }

    async fn stop(&self, stopped: bool, end: Option<&TurnEnd>) -> Result<(), String> {
        let (root, facts) = (self.root.clone(), self.facts.clone());
        let cwd = self.cwd.clone();
        let result = end.filter(|_| stopped).map(|end| json!({"turnId":end.id,"result":{
            "attemptId":end.attempt,"outcome":if end.phase == "released" { "cancelled" } else { end.phase },
            "resultDurable":end.phase == "succeeded","usageDurable":end.usage_durable,"pendingInput":false
        }}));
        blocking(move || {
            let result = result.map(|mut completion| {
                match code_revision::observe_revision(&cwd, code_revision::DEFAULT_MAX_BYTES, code_revision::DEFAULT_MAX_FILES, 0) {
                    Ok(code) => {
                        completion["code"] = json!({"repoId":code.repo_id,"head":code.head,"revision":code.revision,"dirty":code.dirty});
                        completion["error"] = Value::Null;
                    }
                    Err(error) => completion["error"] = json!(error),
                }
                completion
            });
            task_store(&root)?.finish_chat_writer(&facts, stopped, now(), result.as_ref())
        }).await
    }
}

fn required<'a>(value: &'a Value, field: &str) -> Result<&'a str, String> {
    value[field]
        .as_str()
        .filter(|text| !text.is_empty())
        .ok_or_else(|| format!("missing {field}"))
}

pub(super) async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| error.to_string())?
}
