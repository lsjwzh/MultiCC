//! Idempotent task-shell creation used by legacy schedule migration. A receipt
//! is completed only after the caller has persisted the execution and board.
use super::{
    now,
    rules::{hash, task_access},
    text, Result, TaskStore, MAX_TASKS_PER_DIRECTORY,
};
use serde_json::{json, Value};

impl TaskStore {
    pub fn reserve_schedule_task(
        &mut self,
        directory: &Value,
        client: &str,
        title: &str,
        cli: &str,
    ) -> Result<(String, Value)> {
        let key = format!("create_{}", &hash(&json!([directory, client]))[..40]);
        let runtime = json!({"cli":cli});
        let fingerprint = hash(&json!([title, runtime]));
        self.atomic(|store| {
            let receipt = store.get("task-create", &key)?;
            if !receipt.is_null() {
                if receipt["fingerprint"] != fingerprint {
                    return Err("idempotency_conflict".into());
                }
                let task = store.get("task", text(&receipt["taskId"]))?;
                if task.is_null() {
                    return Err("Task not found".into());
                }
                return Ok((key.clone(), task));
            }
            if store.directory_task_count(directory)? >= MAX_TASKS_PER_DIRECTORY {
                return Err(format!("Task limit reached ({MAX_TASKS_PER_DIRECTORY} tasks/project)"));
            }
            let digest = hash(&json!(key));
            let id = format!("tsk_{}", &digest[..32]);
            let session = format!("task-{}", &digest[..32]);
            let shell = crate::task_shell::chat::source_shell_id(&session);
            if !store.get("task", &id)?.is_null() || !store.get("shell", &shell)?.is_null() {
                return Err("execution_identity_conflict".into());
            }
            let task = json!({
                "id": id, "dirId": directory, "title": title, "sessionId": session, "ownerShellId": shell,
                "taskFirst": true, "snapshotIds": [], "ready": false, "createdAt": now(), "runtime": runtime
            });
            let shell_record = json!({
                "id": shell, "sourceSessionId": session, "dirId": directory, "standalone": true,
                "currentTaskId": id, "defaultTaskId": id, "cursorVersion": 0, "createdAt": task["createdAt"]
            });
            let link = json!({"shellId": shell, "taskId": id});
            store.set("task", &id, &task.to_string())?;
            store.put("shell", &shell, &shell_record)?;
            store.set("link", &format!("{shell}:{id}"), &link.to_string())?;
            store.put("task-create", &key, &json!({"taskId": id, "fingerprint": fingerprint}))?;
            Ok((key.clone(), task))
        })
    }

    pub fn complete_schedule_task(&mut self, key: &str, record: &Value, dir: &Value) -> Result<()> {
        self.atomic(|store| {
            let mut receipt = store.get("task-create", key)?;
            if receipt["result"].is_object() {
                return Ok(());
            }
            let id = text(&receipt["taskId"]).to_owned();
            let mut task = store.get("task", &id)?;
            if task.is_null() {
                return Err("Task not found".into());
            }
            task["ready"] = true.into();
            task["baseline"] = Value::Null;
            store.set("task", &id, &task.to_string())?;
            store.snapshot_role(&id, &json!({"record":record,"directory":dir}))?;
            store.mark_first_task_indexed(&id, text(&task["sessionId"]))?;
            let url = format!("/air?task={}&dir={}",crate::http_gate::encode_uri_component(&id),
                crate::http_gate::encode_uri_component(text(&task["dirId"])));
            receipt["result"] = json!({
                "ok": true, "taskId": id, "sessionId": task["sessionId"], "shellId": task["ownerShellId"], "url": url
            });
            store.put("task-create", key, &receipt)
        })
    }

    pub fn schedule_summary(&self, id: &str, board: &Value, records: &[Value]) -> Result<Value> {
        let mut task = self.get("task", id)?;
        let lifecycle = &board["tasks"][id];
        if task.is_null() {
            task = lifecycle.clone();
        }
        if task.is_null() {
            return Ok(Value::Null);
        }
        let owner = self.get("shell", text(&task["ownerShellId"]))?;
        let access = task_access(
            &task,
            &owner,
            if lifecycle.is_null() {
                &task
            } else {
                lifecycle
            },
        );
        let session = task["sessionId"]
            .as_str()
            .or(task["chatSessionId"].as_str());
        let record = records.iter().find(|r| r["id"].as_str() == session);
        let mut runtime = task["runtime"].as_object().cloned().unwrap_or_default();
        if let Some(r) = record {
            for key in ["cli", "provider", "model", "effort"] {
                if let Some(v) = r.get(key) {
                    runtime.insert(key.into(), v.clone());
                }
            }
        }
        Ok(
            json!({"id":id,"sessionId":record.map(|r|&r["id"]),"title":lifecycle.get("title").unwrap_or(&task["title"]),"status":access["status"],"readOnly":access["readOnly"],"runtime":runtime}),
        )
    }
}
