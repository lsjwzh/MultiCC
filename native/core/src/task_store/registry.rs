//! Shared shell registration and cursor updates for the gateway and host.
use super::{
    now,
    rules::{conflict, fail},
    text, Result, TaskStore,
};
use crate::{js, task_shell::chat::source_shell_id};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub(super) fn identifier(id: &str, field: &str) -> Result<()> {
    if id.is_empty()
        || id.len() > 160
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.:-".contains(&byte))
    {
        return Err(fail("invalid_input", &format!("invalid {field}"), 400));
    }
    Ok(())
}

fn truth(value: &Value) -> bool {
    js::serde::truthy(value)
}

fn standalone(record: &Value) -> bool {
    truth(&record["taskBoundTaskId"]) && !truth(&record["workspaceOwnerSessionId"])
}

fn supported(record: &Value, task_first: bool) -> bool {
    record["kind"] == "chat"
        && !truth(&record["taskExecutionSlot"])
        && !matches!(record["type"].as_str(), Some("aux" | "gateway"))
        && (task_first || record["type"] != "commander")
}

fn adopted_id(session: &str) -> String {
    let digest = format!(
        "{:x}",
        Sha256::digest(json!(["adopt", session]).to_string())
    );
    format!("tsk_{}", &digest[..32])
}

fn runtime(record: &Value) -> Value {
    let fields = [
        "cli",
        "model",
        "provider",
        "providerSelection",
        "effort",
        "agent",
    ];
    Value::Object(
        fields
            .into_iter()
            .filter_map(|key| record.get(key).map(|value| (key.to_owned(), value.clone())))
            .collect(),
    )
}

impl TaskStore {
    pub fn shell_record(&self, shell_id: &str) -> Result<Value> {
        identifier(shell_id, "shellId")?;
        let value = self.get("shell", shell_id)?;
        if value.is_null() {
            return Err(fail("shell_not_found", "shell_not_found", 404));
        }
        Ok(value)
    }

    pub fn select_chat_shell_target(&mut self, facts: &Value) -> Result<Value> {
        self.atomic(|store| {
            let shell_id = text(&facts["shellId"]);
            let mut shell = store.shell_record(shell_id)?;
            let id = text(&facts["taskId"]);
            identifier(id, "taskId")?;
            let standalone = shell
                .get("standalone")
                .map_or_else(|| standalone(&facts["record"]), truth);
            if standalone && truth(&shell["currentTaskId"]) && shell["currentTaskId"] != id {
                return Err(conflict("standalone_task_identity_locked"));
            }
            if store.get("link", &format!("{shell_id}:{id}"))?.is_null() {
                return Err(fail(
                    "task_not_linked",
                    "This task is not part of the conversation",
                    403,
                ));
            }
            let task = store.get("task", id)?;
            if task.is_null() || task.get("dirId") != shell.get("dirId") {
                return Err(fail("task_not_found", "Task not found", 404));
            }
            let indexed = &facts["indexed"];
            if facts["deleted"] == true {
                return Err(conflict("task_deleted"));
            }
            if truth(&indexed["deleting"]) {
                return Err(conflict("task_deleting"));
            }
            if indexed["status"] == "archived" {
                return Err(conflict("task_archived"));
            }
            let version = shell
                .get("cursorVersion")
                .filter(|value| truth(value))
                .cloned()
                .unwrap_or(json!(0));
            let expected = &facts["expectedCursorVersion"];
            if !expected.is_null() && version.as_f64() != Some(js::serde::js_to_number(expected)) {
                return Err(fail(
                    "stale_shell_cursor",
                    "The current task changed; refresh before choosing another one",
                    409,
                ));
            }
            if shell["currentTaskId"] == id {
                return Ok(json!({"ok":true,"taskId":id,"cursorVersion":version,"changed":false}));
            }
            let version = version
                .as_u64()
                .and_then(|n| n.checked_add(1))
                .filter(|n| *n <= 9_007_199_254_740_991)
                .ok_or_else(|| conflict("invalid_shell_cursor"))?;
            shell["currentTaskId"] = json!(id);
            shell["cursorVersion"] = json!(version);
            shell["cursorReceiptId"] = Value::Null;
            store.put("shell", shell_id, &shell)?;
            Ok(json!({"ok":true,"taskId":id,"cursorVersion":version,"changed":true}))
        })
    }

    pub fn register_chat_shell(&mut self, facts: &Value) -> Result<Value> {
        self.atomic(|store| store.register_shell_in_tx(facts))
    }

    fn register_shell_in_tx(&mut self, facts: &Value) -> Result<Value> {
        let id = text(&facts["sessionId"]);
        identifier(id, "sessionId")?;
        let source = &facts["record"];
        let task_first = facts["taskFirst"] == true;
        if !supported(source, task_first) || truth(&source["experimentalMode"]) {
            return Err(fail("unsupported_source", "Use an ordinary chat", 400));
        }
        let owner = self.chat_task_for_session(id)?;
        if !owner.is_null() && !truth(&owner["adopted"]) {
            let mut origin = owner["ownerShellId"].clone();
            if !truth(&origin) {
                origin = self.link_by_task(text(&owner["id"]))?["shellId"].clone();
            }
            let parent = self.get("shell", text(&origin))?;
            if !parent.is_null() && parent.get("dirId") == source.get("dirId") {
                return Ok(parent);
            }
        }
        let shell_id = source_shell_id(id);
        let existing = self.get("shell", &shell_id)?;
        if !existing.is_null() {
            if existing["sourceSessionId"] != id {
                return Err(conflict("shell_identity_mismatch"));
            }
            return Ok(existing);
        }
        let mut shell = json!({"id":shell_id,"sourceSessionId":id,"dirId":source["dirId"],
            "currentTaskId":null,"cursorVersion":0,"standalone":standalone(source),"createdAt":now()});
        if source.get("dirId").is_none() {
            shell.as_object_mut().expect("shell").shift_remove("dirId");
        }
        self.put("shell", &shell_id, &shell)?;
        Ok(shell)
    }

    pub fn adopt_chat_shell(&mut self, facts: &Value) -> Result<Value> {
        self.atomic(|store| store.adopt_shell_in_tx(facts))
    }

    fn adopt_shell_in_tx(&mut self, facts: &Value) -> Result<Value> {
        let shell_id = text(&facts["shellId"]);
        identifier(shell_id, "shellId")?;
        let id = text(&facts["sessionId"]);
        let record = &facts["record"];
        let task_first = facts["taskFirst"] == true;
        let mut shell = self.get("shell", shell_id)?;
        if shell.is_null() {
            return Err(fail("shell_not_found", "shell_not_found", 404));
        }
        if !supported(record, task_first) || record.get("dirId") != shell.get("dirId") {
            return Err(conflict("unsupported_source"));
        }
        let bound = &record["taskBoundTaskId"];
        let mut task = self.chat_task_for_session(id)?;
        let history = &facts["last"];
        let history_id = text(&history["taskId"]);
        let indexed = &facts["indexed"];
        let historical = self.get("task", history_id)?;
        let known = if historical.is_null() {
            &indexed[history_id]
        } else {
            &historical
        };
        let known_session = known
            .get("sessionId")
            .filter(|value| truth(value))
            .unwrap_or(&known["chatSessionId"]);
        let history_id = if truth(known_session) && known_session != id {
            ""
        } else {
            history_id
        };
        let pending = &facts["pending"];
        let signal_task = if !truth(bound) && task.is_null() && !truth(&pending["resolved"]) {
            &pending["taskId"]
        } else {
            &Value::Null
        };
        let task_id = [
            text(&task["id"]),
            text(bound),
            text(signal_task),
            text(&record["taskState"]["userInputSignalTaskId"]),
            history_id,
        ]
        .into_iter()
        .find(|value| !value.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| adopted_id(id));
        let label = crate::js::from_serde(&history["content"]);
        let excerpt = match label {
            crate::js::JsValue::String(label) => label.truncate_units(120).to_string_lossy(),
            _ => String::new(),
        };
        let title = [
            text(&indexed[&task_id]["title"]),
            if history_id.is_empty() {
                ""
            } else {
                text(&history["taskName"])
            },
            text(&record["label"]),
            excerpt.as_str(),
            id,
        ]
        .into_iter()
        .find(|value| !value.is_empty())
        .unwrap_or_default();
        if task.is_null() {
            if !self.get("task", &task_id)?.is_null() {
                return Err(conflict("task_identity_mismatch"));
            }
            task = json!({"id":task_id,"dirId":shell["dirId"],"sessionId":id,"title":title,
                "ownerShellId":shell_id,"taskFirst":task_first,"parentTaskId":null,"snapshotIds":[],
                "ready":true,"adopted":true,"createdAt":now(),"runtime":runtime(record)});
            if shell.get("dirId").is_none() {
                task.as_object_mut().expect("task").shift_remove("dirId");
            }
            self.set("task", &task_id, &task.to_string())?;
        } else if !title.is_empty() && task["title"] != title {
            task["title"] = json!(title);
            self.set("task", &task_id, &task.to_string())?;
        }
        let link = format!("{shell_id}:{task_id}");
        if self.get("link", &link)?.is_null() {
            self.set(
                "link",
                &link,
                &json!({"shellId":shell_id,"taskId":task_id}).to_string(),
            )?;
        }
        if !truth(&shell["currentTaskId"]) {
            shell["currentTaskId"] = json!(task_id);
            shell["defaultTaskId"] = json!(task_id);
            self.put("shell", shell_id, &shell)?;
        }
        Ok(task)
    }

    pub fn open_chat_shell(&mut self, facts: &Value) -> Result<Value> {
        self.atomic(|store| {
            let session = text(&facts["sessionId"]);
            let bound = text(&facts["record"]["taskBoundTaskId"]);
            if !bound.is_empty()
                && session == format!("task-{}", bound.strip_prefix("tsk_").unwrap_or(bound))
                && store.chat_task_for_session(session)?.is_null()
            {
                return Err(conflict("task_shell_state_unavailable"));
            }
            let shell = store.register_shell_in_tx(facts)?;
            let mut adopt = facts.clone();
            adopt["shellId"] = shell["id"].clone();
            store.adopt_shell_in_tx(&adopt)?;
            store.shell_view_in_tx(text(&shell["id"]), &facts["record"])
        })
    }

    pub fn shell_view(&mut self, shell_id: &str, source: &Value) -> Result<Value> {
        self.atomic(|store| store.shell_view_in_tx(shell_id, source))
    }

    fn shell_view_in_tx(&mut self, shell_id: &str, source: &Value) -> Result<Value> {
        let mut shell = self.shell_record(shell_id)?;
        let mut changed = false;
        if shell.get("standalone").is_none() {
            shell["standalone"] = json!(standalone(source));
            changed = true;
        }
        if !truth(&shell["currentTaskId"]) && truth(&shell["defaultTaskId"]) {
            shell["currentTaskId"] = shell["defaultTaskId"].clone();
            changed = true;
        }
        if changed {
            self.put("shell", shell_id, &shell)?;
        }
        let linked: std::collections::HashSet<_> = self
            .rows("link", false)?
            .into_iter()
            .filter(|(_, _, row)| row["shellId"] == shell_id)
            .filter_map(|(_, _, row)| row["taskId"].as_str().map(str::to_owned))
            .collect();
        let receipts = self.receipts_for_shell(shell_id, 100)?;
        let cache_key = "rows:task";
        self.refresh_cache("task", "rows", cache_key)?;
        let tasks = self.cache[cache_key]
            .rows
            .as_array()
            .ok_or("invalid cached task rows")?;
        let token_savings = receipts
            .iter()
            .rev()
            .find(|receipt| {
                receipt["payload"]["intent"] == "work" && receipt["status"] == "accepted"
            })
            .map_or(Value::Null, |receipt| receipt["contextSavings"].clone());
        let projected_receipts: Vec<_> = receipts
            .iter()
            .map(|receipt| {
                let mut output = serde_json::Map::new();
                for (key, value) in [
                    ("id", receipt.get("id")),
                    ("clientMsgId", receipt["payload"].get("clientMsgId")),
                    ("taskId", receipt.get("taskId")),
                    ("intent", receipt["payload"].get("intent")),
                    ("status", receipt.get("status")),
                    (
                        "error",
                        Some(
                            receipt
                                .get("error")
                                .filter(|v| truth(v))
                                .unwrap_or(&Value::Null),
                        ),
                    ),
                    (
                        "contextSavings",
                        Some(
                            receipt
                                .get("contextSavings")
                                .filter(|v| truth(v))
                                .unwrap_or(&Value::Null),
                        ),
                    ),
                ] {
                    if let Some(value) = value {
                        output.insert(key.into(), value.clone());
                    }
                }
                Value::Object(output)
            })
            .collect();
        let available: Vec<_> = tasks
            .iter()
            .filter(|task| task.get("dirId") == shell.get("dirId"))
            .map(|task| {
                let mut entry = serde_json::Map::new();
                for field in ["id", "title"] {
                    if let Some(value) = task.get(field) {
                        entry.insert(field.into(), value.clone());
                    }
                }
                Value::Object(entry)
            })
            .collect();
        shell["enabled"] = json!(true);
        shell["tasks"] = json!(tasks
            .iter()
            .filter(|task| linked.contains(text(&task["id"])))
            .collect::<Vec<_>>());
        shell["availableTasks"] = json!(available);
        shell["tokenSavings"] = if truth(&token_savings) {
            token_savings
        } else {
            Value::Null
        };
        shell["receipts"] = json!(projected_receipts);
        Ok(shell)
    }
}
