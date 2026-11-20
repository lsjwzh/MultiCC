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

fn now() -> i64 {
    auth_runtime::now_ms() as i64
}

fn task_store(root: &Path) -> Result<TaskStore, String> {
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

fn response(value: Value) -> Result<Value, String> {
    match value["resultJson"].as_str() {
        Some(raw) => multicc_core::json_lenient::from_str(raw).map_err(|error| error.to_string()),
        None => Ok(value["result"].clone()),
    }
}

fn supported(state: &Session) -> bool {
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

fn workspace_request(root: &Path, id: &str, record: &V, cwd: &Path) -> Result<Value, String> {
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

fn read_directory(root: &Path, record: &V) -> Result<Value, String> {
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

pub(super) async fn submit(
    app: &App,
    id: &str,
    session: &Mutex<Session>,
    route: ShellRoute<'_>,
    message: &V,
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
            &json!({"record":record,"directory":directory,"board":board,"state":active}),
            &message,
        )?;
        let receipt = &reserved["receipt"];
        let receipt_id = required(receipt, "id")?;
        let task = required(receipt, "taskId")?;
        let mut notification = Value::Null;
        if intent != Intent::Cancel && receipt["status"] != "accepted" {
            let payload = &receipt["payload"];
            let task_state = &record["taskState"];
            let mut request = json!({"sessionId":id,"text":payload["text"],"source":"task-shell",
                "idempotencyKey":receipt_id,"hostAdmission":true,"initialState":{
                    "pendingQuestion":task_state["pendingUserInput"],"activeTurn":null,
                    "category":{"classifyState":task_state["classifyState"]}
                },
                "options":{"taskId":task,"taskSource":"task-shell","taskStart":true,
                    "taskShellReceiptId":receipt_id,"clientMsgId":receipt_id,"nativeShellWork":true,
                    "originContinue":true,"rolePrompt":reserved["rolePrompt"]
                }
            });
            if intent == Intent::Answer {
                request["options"]["taskStart"] = json!(false);
                request["options"]["userInputRequestId"] = payload["requestId"].clone();
                request["options"]["taskShellControl"] =
                    json!({"intent":"answer","turnId":payload["turnId"]});
            }
            let admitted = admit_queue(&mut queue_store(&submit_root)?, request.to_string())?;
            if admitted["ok"] != true {
                let code = required(&admitted, "code")?;
                if code == "stale_control" {
                    tasks.settle_receipt(&json!({"receiptId":receipt_id,"error":{"code":code}}))?;
                    return Err(format!(
                        "TASK_RULE:{}",
                        json!({"code":code,"message":"The question is no longer pending"})
                    ));
                }
                return Err(code.to_owned());
            }
            notification = admitted["notification"].clone();
        }
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
    match result {
        Ok(frame) => frame,
        Err(error) => {
            let fault = error
                .strip_prefix("TASK_RULE:")
                .and_then(|raw| serde_json::from_str::<Value>(raw).ok());
            let code = fault.as_ref().and_then(|error| error["code"].as_str());
            if let Some(code) = code {
                let detail = fault
                    .as_ref()
                    .and_then(|error| error["message"].as_str())
                    .unwrap_or(code);
                return error_frame(code, detail);
            }
            error_frame("task_shell_failed", &error)
        }
    }
}

fn admit_queue(queue: &mut Store, request: String) -> Result<Value, String> {
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
