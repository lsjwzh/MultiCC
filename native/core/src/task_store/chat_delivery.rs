//! Task-shell delivery receipts, including reservation and reconnect replay.
use super::{
    err, items, now,
    rules::{conflict, fail},
    text, Result, TaskStore, MAX_TASKS_PER_DIRECTORY,
};
use crate::js::{self, JsValue as V};
use crate::random_id;
use crate::task_shell::chat::{self, Intent, Rejection};
use serde_json::{json, Value};
use std::path::Path;

fn selected_task(shell: &Value) -> &str {
    shell["currentTaskId"]
        .as_str()
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| text(&shell["defaultTaskId"]))
}

fn stale_cursor() -> String {
    fail(
        "stale_shell_cursor",
        "The current task changed; refresh before sending",
        409,
    )
}

fn check_control(payload: &Value, state: &Value) -> Result<()> {
    if state.is_null() || state["turnId"] != payload["turnId"] {
        return Err(fail(
            "stale_control",
            "The task has moved to another turn",
            409,
        ));
    }
    let pending = &state["pending"];
    let unresolved = !pending.is_null() && !js::serde::truthy(&pending["resolved"]);
    match text(&payload["intent"]) {
        "answer"
            if !unresolved
                || pending["requestId"] != payload["requestId"]
                || pending["taskId"] != payload["taskId"] =>
        {
            Err(fail(
                "stale_control",
                "The question is no longer pending",
                409,
            ))
        }
        "steer" if unresolved => Err(conflict("answer_required")),
        _ => Ok(()),
    }
}

impl TaskStore {
    pub(super) fn reserve_receipt(&mut self, facts: &Value) -> Result<Value> {
        // Keep the original payload's UTF-16 strings, including a voice
        // transcript truncated at a surrogate, in the stored receipt.
        let wire_payload = js::json_parse(text(&facts["payloadJson"])).map_err(err)?;
        let payload = js::to_serde(&wire_payload);
        self.atomic(|store| store.reserve_receipt_in_tx(facts, &payload, wire_payload))
    }

    fn reserve_receipt_in_tx(
        &mut self,
        facts: &Value,
        payload: &Value,
        wire_payload: V,
    ) -> Result<Value> {
        let shell_id = text(&facts["shellId"]);
        let receipt_id = text(&facts["receiptId"]);
        let target_id = text(&facts["targetId"]);
        let intent = text(&payload["intent"]);
        let work = intent == "work";
        let state = &facts["state"];
        let answer_key = format!("{target_id}:{}", text(&payload["requestId"]));
        if !work {
            if intent == "answer" && self.answer_reserved(&answer_key)? {
                return Err(conflict("answer_already_reserved"));
            }
            check_control(payload, state)?;
        }
        let existing = self.get("receipt", receipt_id)?;
        if !existing.is_null() {
            if existing["fingerprint"] != facts["fingerprint"] {
                return Err(conflict("idempotency_conflict"));
            }
            return Ok(json!({"created":false,"receipt":existing}));
        }

        let mut shell = self.get("shell", shell_id)?;
        if shell.is_null() {
            return Err(fail("shell_not_found", "shell_not_found", 404));
        }
        if shell["sourceSessionId"] != facts["sourceSessionId"] || shell["dirId"] != facts["dirId"]
        {
            return Err(stale_cursor());
        }
        let new_task = payload["newTask"] == true;
        if new_task && js::serde::truthy(&shell["standalone"]) {
            return Err(conflict("standalone_task_identity_locked"));
        }
        let delivery = &facts["delivery"];
        let locked = delivery["taskIdentityLocked"] == true;
        let cursor = shell["cursorVersion"].as_u64().unwrap_or(0);
        if work && !locked {
            let requested = text(&payload["taskId"]);
            if (facts["expectedCursorSet"] == true
                && payload["expectedCursorVersion"].as_f64() != Some(cursor as f64))
                || (!new_task && !requested.is_empty() && shell["currentTaskId"] != requested)
                || (!new_task && requested.is_empty() && selected_task(&shell) != target_id)
            {
                return Err(stale_cursor());
            }
        }

        let mut last = Value::Null;
        let (task_id, decision) = if target_id.is_empty() {
            (
                self.create_delivery_task(&shell, facts, &wire_payload)?,
                "new",
            )
        } else {
            let task = self.get("task", target_id)?;
            if task.is_null() {
                return Err(fail("task_not_found", "task_not_found", 404));
            }
            if task["dirId"] != shell["dirId"] {
                return Err(fail(
                    "project_mismatch",
                    "Tasks must belong to the same project",
                    403,
                ));
            }
            if self
                .get("link", &format!("{shell_id}:{target_id}"))?
                .is_null()
            {
                return Err(conflict("task_not_linked"));
            }
            let mut owner = task["ownerShellId"].clone();
            if !js::serde::truthy(&owner) {
                owner = self.link_by_task(target_id)?["shellId"].clone();
            }
            if js::serde::truthy(&owner) && self.get("shell", text(&owner))?.is_null() {
                return Err(fail("shell_not_found", "shell_not_found", 404));
            }
            if owner != shell_id {
                return Err(fail(
                    "task_owner_mismatch",
                    "Open the owning conversation or fork this task",
                    409,
                ));
            }
            if task["sessionId"] != facts["targetSessionId"] {
                return Err(stale_cursor());
            }
            let claim = self.get("claim", target_id)?;
            if let Some(previous) = claim["receiptId"].as_str() {
                last = self.get("receipt", previous)?;
            }
            if work && !items(&facts["snapshotBodies"]).is_empty() {
                return Err(fail(
                    "context_requires_new_task",
                    "Start a new task to import versioned context",
                    409,
                ));
            }
            let busy = state["busy"] != false
                || claim["receiptId"] != facts["observedClaim"]
                || (!last.is_null() && last["status"] != "accepted");
            (
                target_id.to_owned(),
                if !work {
                    intent
                } else if busy {
                    "queued"
                } else {
                    "continue"
                },
            )
        };
        if intent == "answer" {
            self.put("answer", &answer_key, &json!({"receiptId":receipt_id}))?;
        }
        let role = self.delivery_role(&task_id, payload, &last, facts)?;
        let version = if work { cursor + 1 } else { cursor };
        let mut receipt = json!({
            "id":receipt_id,"shellId":shell_id,"taskId":task_id,"fingerprint":facts["fingerprint"],
            "payload":null,"roleSnapshotId":role,"taskIdentityLocked":locked
        });
        if facts["nativeAdmission"] == true {
            receipt["nativeAdmission"] = Value::Bool(true);
        }
        if delivery["supervisorAnswer"] == true {
            receipt["supervisorAnswer"] = Value::Bool(true);
        }
        receipt["taskMetadata"] = delivery["taskMetadata"].clone();
        receipt["dispatch"] = delivery["dispatch"].clone();
        receipt["cursorVersion"] = json!(version);
        receipt["status"] = json!("reserved");
        receipt["decision"] = json!(decision);
        receipt["contextSavings"] = if work {
            json!({"estimatedTokens":facts["estimatedTokens"],"contextRefilled":false})
        } else {
            Value::Null
        };
        receipt["createdAt"] = json!(now());
        let mut wire_receipt = js::from_serde(&receipt);
        crate::quota_guard::set(&mut wire_receipt, "payload", wire_payload);
        self.set(
            "receipt",
            receipt_id,
            &js::json_stringify_or_undefined(&wire_receipt),
        )?;
        if work {
            shell["cursorVersion"] = json!(version);
            shell["cursorReceiptId"] = json!(receipt_id);
            self.put("shell", shell_id, &shell)?;
            self.put("claim", &task_id, &json!({"receiptId":receipt_id}))?;
        }
        let link_id = format!("{shell_id}:{task_id}");
        self.set(
            "link",
            &link_id,
            &json!({"shellId":shell_id,"taskId":task_id}).to_string(),
        )?;
        receipt["payload"] = payload.clone();
        Ok(json!({"created":true,"receipt":receipt}))
    }

    fn create_delivery_task(
        &mut self,
        shell: &Value,
        facts: &Value,
        payload: &V,
    ) -> Result<String> {
        if self.directory_task_count(&shell["dirId"])? >= MAX_TASKS_PER_DIRECTORY {
            return Err(fail(
                "task_shell_task_limit",
                &format!("Task limit reached ({MAX_TASKS_PER_DIRECTORY} tasks/project)"),
                429,
            ));
        }
        let mut snapshots = Vec::new();
        for body in items(&facts["snapshotBodies"]).iter().map(text) {
            let value = super::parse(body)?;
            let hash = text(&value["hash"]);
            self.set("snapshot", hash, body)?;
            snapshots.push(hash.to_owned());
        }
        if facts["sourceRuntime"].is_null() {
            return Err(conflict("source_session_missing"));
        }
        let uuid = random_id::random_uuid_v4().map_err(err)?.replace('-', "");
        let id = format!("tsk_{uuid}");
        let mut task = js::from_serde(&json!({
            "id":id,"dirId":shell["dirId"],"sessionId":format!("task-{uuid}"),"ownerShellId":shell["id"],
            "taskFirst":facts["taskFirst"] == true,"parentTaskId":null,"title":null,
            "snapshotIds":snapshots,"ready":false,"createdAt":now(),"runtime":facts["sourceRuntime"]
        }));
        if let Some(V::String(title)) = payload.get("text") {
            crate::quota_guard::set(&mut task, "title", V::String(title.truncate_units(120)));
        }
        self.set("task", &id, &js::json_stringify_or_undefined(&task))?;
        Ok(id)
    }

    fn answer_reserved(&self, key: &str) -> Result<bool> {
        let held = self.get("answer", key)?;
        if held.is_null() {
            return Ok(false);
        }
        let receipt = self.get("receipt", text(&held["receiptId"]))?;
        Ok(!matches!(text(&receipt["status"]), "rejected" | "failed"))
    }

    fn delivery_role(
        &mut self,
        task: &str,
        payload: &Value,
        previous: &Value,
        facts: &Value,
    ) -> Result<Value> {
        if payload["intent"] != "work" {
            let run = self.get("delivery:run", text(&payload["turnId"]))?;
            let origin = self.get("receipt", text(&run["binding"]["receiptId"]))?;
            // Separation can move a question to a new task. The old turn's
            // role is reusable only if the snapshot belongs to this task.
            for receipt in [&origin, previous] {
                let role = &receipt["roleSnapshotId"];
                if !self.verified_role(text(role), task)?.is_null() {
                    return Ok(role.clone());
                }
            }
        }
        self.snapshot_role(task, facts)
    }

    pub fn settle_receipt(&mut self, facts: &Value) -> Result<Value> {
        self.atomic(|store| {
            let id = text(&facts["receiptId"]);
            let mut receipt = store.get("receipt", id)?;
            if receipt.is_null() {
                return Err(fail("receipt_not_found", "receipt_not_found", 404));
            }
            if receipt["status"] == "accepted" {
                return Ok(json!({"result":receipt["result"]}));
            }
            let task_id = text(&receipt["taskId"]).to_owned();
            if let Some(error) = facts.get("error") {
                let rejected = error["code"] == "stale_control";
                receipt["status"] = json!(if rejected { "rejected" } else { "failed" });
                receipt["error"] = error.clone();
                if receipt["payload"]["intent"] == "answer" {
                    let request_id = text(&receipt["payload"]["requestId"]);
                    let key = format!("{task_id}:{request_id}");
                    if store.get("answer", &key)?["receiptId"] == id {
                        store.remove("answer", &key)?;
                    }
                }
                store.set("receipt", id, &receipt.to_string())?;
                return Ok(Value::Null);
            }

            let mut result = if js::serde::truthy(&receipt["dispatch"]) {
                facts["dispatchResult"].clone()
            } else {
                json!({})
            };
            result["ok"] = Value::Bool(true);
            result["taskId"] = json!(task_id);
            result["sessionId"] = facts["sessionId"].clone();
            result["receiptId"] = json!(id);
            result["decision"] = receipt["decision"].clone();
            receipt["status"] = json!("accepted");
            receipt["error"] = Value::Null;
            receipt["result"] = result.clone();
            store.set("receipt", id, &receipt.to_string())?;
            let mut source = Value::Null;
            if receipt["payload"]["intent"] == "work" {
                let shell_id = text(&receipt["shellId"]);
                let mut shell = store.get("shell", shell_id)?;
                if shell.is_null() {
                    return Err(fail("shell_not_found", "shell_not_found", 404));
                }
                let cursor = shell["cursorVersion"].as_u64().unwrap_or(0);
                if shell["cursorReceiptId"] == id
                    && receipt["cursorVersion"].as_u64() == Some(cursor)
                {
                    if shell["currentTaskId"] != task_id {
                        source = shell["sourceSessionId"].clone();
                    }
                    shell["currentTaskId"] = json!(task_id);
                    shell["defaultTaskId"] = json!(task_id);
                    store.put("shell", shell_id, &shell)?;
                }
            }
            Ok(json!({"result":result,"stateSource":source}))
        })
    }

    fn chat_task_for_session(&self, session: &str) -> Result<Value> {
        let indexed = self.get("task-session", session)?;
        if let Some(task_id) = indexed["taskId"].as_str() {
            let task = self.get("task", task_id)?;
            if task["sessionId"] == session {
                return Ok(task);
            }
        }
        Ok(self
            .rows("task", true)?
            .into_iter()
            .find_map(|(_, _, task)| (task["sessionId"] == session).then_some(task))
            .unwrap_or(Value::Null))
    }

    /// Admit only an execution that already owns the addressed task, and bind
    /// the receipt to that task before the scheduler sees the first input.
    pub fn reserve_native_chat_input(
        &mut self,
        shell_query: Option<&str>,
        session: &str,
        facts: &Value,
        message: &V,
    ) -> Result<Value> {
        let intent = chat::intent(message);
        self.atomic(|store| {
            let shell_id = match shell_query {
                Some(id) => id.to_owned(),
                None => {
                    let task = store.chat_task_for_session(session)?;
                    if !js::serde::truthy(&task["adopted"]) && !text(&task["ownerShellId"]).is_empty() {
                        text(&task["ownerShellId"]).to_owned()
                    } else {
                        chat::source_shell_id(session)
                    }
                }
            };
            Self::validate_chat_shell_id(&shell_id)?;
            let shell = store.get("shell", &shell_id)?;
            let task = store.get("task", selected_task(&shell))?;
            let id = text(&task["id"]);
            if id.is_empty()
                || task["ready"] != true
                || task["sessionId"] != session
                || shell["dirId"].is_null()
                || facts["record"]["dirId"] != shell["dirId"]
                || js::serde::truthy(&shell["archivedAt"])
            {
                return Err(conflict("chat_route_unavailable"));
            }
            let payload = chat::normalize(message, Some(id))
                .map_err(|e| fail(e.code, &e.message, 400))?;
            let payload_facts = js::to_serde(&payload);
            if payload_facts["newTask"] == true && !js::serde::truthy(&shell["standalone"]) {
                return Err(conflict("chat_route_unavailable"));
            }
            if !payload_facts["unattended"].is_null()
                || !items(&payload_facts["contextTaskIds"]).is_empty()
                || !items(&payload_facts["dependsOn"]).is_empty()
            {
                return Err(conflict("chat_route_unavailable"));
            }
            if intent == Intent::Cancel && facts["state"]["taskId"] != id {
                return Err(fail("stale_control", "The task has moved to another turn", 409));
            }
            let indexed = &facts["board"]["tasks"][id];
            if items(&facts["board"]["deletedTaskIds"]).iter().any(|removed| removed == id) {
                return Err(conflict("task_deleted"));
            }
            if js::serde::truthy(&indexed["deleting"]) {
                return Err(conflict("task_deleting"));
            }
            if indexed["status"] == "archived" || task["status"] == "archived" {
                return Err(conflict("task_archived"));
            }
            let (receipt_id, fingerprint) = chat::receipt_identity(&shell_id, &payload);
            let existing = store.get("receipt", &receipt_id)?;
            if !existing.is_null()
                && (existing["taskId"] != id || existing["nativeAdmission"] != true)
            {
                // A receipt reserved by a different execution owner can carry
                // an unfinished external launch. Leave it to that owner.
                return Err(conflict("chat_route_unavailable"));
            }
            if intent == Intent::Answer && !existing.is_null() {
                if existing["fingerprint"] != fingerprint {
                    return Err(conflict("idempotency_conflict"));
                }
                if matches!(existing["status"].as_str(), Some("rejected" | "failed")) {
                    return Err(conflict("stale_control"));
                }
                let role = store.verified_role(text(&existing["roleSnapshotId"]), id)?;
                return Ok(json!({"receipt":existing,"rolePrompt":role["prompt"]}));
            }
            let claim = store.get("claim", id)?;
            if intent == Intent::Work && !claim["receiptId"].is_null() && claim["receiptId"] != receipt_id {
                let previous = store.get("receipt", text(&claim["receiptId"]))?;
                if !previous.is_null() && previous["status"] != "accepted" && previous["nativeAdmission"] != true {
                    return Err(conflict("chat_route_unavailable"));
                }
            }
            let reservation = json!({
                "shellId":shell_id,"sourceSessionId":shell["sourceSessionId"],"dirId":shell["dirId"],
                "targetId":id,"targetSessionId":session,"receiptId":receipt_id,"fingerprint":fingerprint,
                "observedClaim":claim["receiptId"],"state":facts["state"],"record":facts["record"],
                "directory":facts["directory"],"estimatedTokens":0,"nativeAdmission":true
            });
            let reserved = store.reserve_receipt_in_tx(&reservation, &payload_facts, payload)?;
            let receipt = &reserved["receipt"];
            let role = store.verified_role(text(&receipt["roleSnapshotId"]), id)?;
            Ok(json!({"receipt":receipt,"rolePrompt":role["prompt"]}))
        })
    }

    pub fn replay_chat_input(
        file: &Path,
        shell_query: Option<&str>,
        session: &str,
        addressed_session_only: bool,
        session_in_directory: impl Fn(&str, Option<&Value>) -> bool,
        message: &V,
    ) -> std::result::Result<Option<V>, Rejection> {
        let storage_error = |error: String| Rejection::state("task_shell_failed", error);
        let Some(store) = Self::open_chat_reader(file).map_err(storage_error)? else {
            chat::normalize(message, None)?;
            return Ok(None);
        };
        let owned = if shell_query.is_none() || chat::intent(message) != Intent::Work {
            store
                .chat_task_for_session(session)
                .map_err(storage_error)?
        } else {
            Value::Null
        };
        let shell_id = if let Some(shell) = shell_query {
            shell.to_owned()
        } else {
            let owner = text(&owned["ownerShellId"]);
            let parent = if !owner.is_empty() && !js::serde::truthy(&owned["adopted"]) {
                store.get("shell", owner).map_err(storage_error)?
            } else {
                Value::Null
            };
            if !parent.is_null() && session_in_directory(session, parent.get("dirId")) {
                owner.to_owned()
            } else {
                chat::source_shell_id(session)
            }
        };
        let shell = store.get("shell", &shell_id).map_err(storage_error)?;
        let control_task = owned["id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .or_else(|| shell["currentTaskId"].as_str().filter(|id| !id.is_empty()))
            .or_else(|| shell["defaultTaskId"].as_str());
        let input = chat::normalize(message, control_task)?;
        if shell.is_null() {
            return Ok(None);
        }
        let scope = store
            .chat_scope(&shell_id, session, session_in_directory)
            .map_err(storage_error)?;
        let (receipt_id, fingerprint) = chat::receipt_identity(&shell_id, &input);
        let receipt = store.get("receipt", &receipt_id).map_err(storage_error)?;
        if receipt.is_null() {
            return Ok(None);
        }
        if receipt["fingerprint"] != fingerprint {
            return Err(Rejection::new(
                "idempotency_conflict",
                "idempotency_conflict",
            ));
        }
        if receipt["status"] != "accepted" || !receipt["dispatch"].is_null() {
            return Ok(None);
        }
        let result = &receipt["result"];
        let target = text(&result["sessionId"]);
        let task_id = text(&result["taskId"]);
        let decision = text(&result["decision"]);
        if receipt["shellId"] != shell_id
            || receipt["id"] != receipt_id
            || result["receiptId"] != receipt_id
            || result["taskId"] != receipt["taskId"]
            || result["ok"] != true
            || task_id.is_empty()
            || decision.is_empty()
            || !scope.iter().any(|id| id == target)
            || (addressed_session_only && target != session)
        {
            return Err(Rejection::state(
                "task_shell_failed",
                "Task receipt no longer belongs to this chat scope",
            ));
        }
        Ok(Some(chat::routed_frame(
            &shell_id,
            &receipt_id,
            task_id,
            target,
            decision,
            input.get("clientMsgId").cloned().unwrap_or(V::Undefined),
        )))
    }
}
