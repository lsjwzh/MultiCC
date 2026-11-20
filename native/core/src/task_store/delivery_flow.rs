//! Receipt delivery ordering for compatibility hosts. Host ports execute the
//! requested effects and return their result to this durable owner.
use super::{
    rules::{conflict, fail},
    text, Result, TaskStore,
};
use crate::js::serde::truthy;
use serde_json::{json, Value};

fn effect(name: &str, phase: &str, args: Value) -> Value {
    json!({"effect":name,"phase":phase,"args":args})
}

impl TaskStore {
    pub(super) fn delivery_step(&mut self, input: &Value) -> Result<Value> {
        self.atomic(|store| store.advance_delivery(input))
    }

    fn advance_delivery(&mut self, input: &Value) -> Result<Value> {
        let id = text(&input["receiptId"]);
        let mut receipt = self.get("receipt", id)?;
        if receipt.is_null() {
            return Err(fail("receipt_not_found", "receipt_not_found", 404));
        }
        let mut phase = text(&input["phase"]);
        let result = &input["value"];
        let payload = receipt["payload"].clone();
        if phase == "begin" && receipt["status"] == "accepted" && !truthy(&receipt["dispatch"]) {
            return Ok(json!({"done":true,"result":receipt["result"]}));
        }
        let mut task = self.get("task", text(&receipt["taskId"]))?;
        if task.is_null() {
            return Err(fail("task_not_found", "task_not_found", 404));
        }
        if phase == "begin" && receipt["status"] == "accepted" {
            return self.delivery_dispatch(&receipt, &task, "accepted-dispatch");
        }
        if phase == "accepted-dispatch" {
            let mut merged = receipt["result"].clone();
            if let (Some(out), Some(fields)) = (merged.as_object_mut(), result.as_object()) {
                out.extend(
                    fields
                        .iter()
                        .map(|(key, value)| (key.clone(), value.clone())),
                );
            }
            merged["duplicate"] = json!(true);
            return Ok(json!({"done":true,"result":merged}));
        }
        if phase == "begin" {
            if !truthy(&task["ownerShellId"]) {
                let owner = self.link_by_task(text(&task["id"]))?["shellId"].clone();
                task["ownerShellId"] = if truthy(&owner) {
                    owner
                } else {
                    receipt["shellId"].clone()
                };
                self.put("task", text(&task["id"]), &task)?;
            }
            if payload["intent"] == "work" && input["unifiedAdmission"] != true {
                return Ok(effect("capacity", "after-capacity", json!([task])));
            }
            phase = "after-capacity";
        }
        if phase == "after-capacity" {
            if !truthy(&task["ready"]) {
                return Ok(effect(
                    "createExecution",
                    "after-create",
                    json!([task, task["runtime"]]),
                ));
            }
            phase = "after-create";
        } else if phase == "after-create" {
            if !truthy(&result["ok"]) {
                return Err(fail(
                    result["code"]
                        .as_str()
                        .filter(|code| !code.is_empty())
                        .unwrap_or("execution_create_failed"),
                    result["error"]
                        .as_str()
                        .filter(|error| !error.is_empty())
                        .unwrap_or("execution_create_failed"),
                    500,
                ));
            }
            task["ready"] = json!(true);
            if let Some(baseline) = result.get("baseline") {
                task["baseline"] = baseline.clone();
            } else if let Some(fields) = task.as_object_mut() {
                fields.shift_remove("baseline");
            }
            self.put("task", text(&task["id"]), &task)?;
        }
        if phase == "after-create" {
            if input["prepareExecution"] == true {
                let owner = self.get("shell", text(&task["ownerShellId"]))?;
                return Ok(effect(
                    "prepareExecution",
                    "after-prepare",
                    json!([task, owner]),
                ));
            }
            phase = "after-prepare";
        }
        if phase == "after-prepare" {
            return Ok(effect("indexTask", "after-index", json!([task])));
        }
        if phase == "after-index" {
            if !truthy(&result["ok"]) {
                return Err(fail(
                    "task_index_failed",
                    result["error"]
                        .as_str()
                        .filter(|error| !error.is_empty())
                        .unwrap_or("task_index_failed"),
                    500,
                ));
            }
            if payload["intent"] == "cancel" {
                return Ok(effect(
                    "getExecution",
                    "after-control-state",
                    json!([task["sessionId"]]),
                ));
            }
            receipt["status"] = json!("delivering");
            self.put("receipt", id, &receipt)?;
            if truthy(&receipt["dispatch"]) {
                return self.delivery_dispatch(&receipt, &task, "after-delivery");
            }
            let metadata = &receipt["taskMetadata"];
            let locked = truthy(&receipt["taskIdentityLocked"]);
            let task_text = if locked {
                if metadata["taskStart"] == false {
                    Value::Null
                } else if truthy(&metadata["taskText"]) {
                    metadata["taskText"].clone()
                } else {
                    payload["text"].clone()
                }
            } else if payload["intent"] == "work" {
                payload["text"].clone()
            } else {
                task["title"].clone()
            };
            let owner = self.get("shell", text(&task["ownerShellId"]))?;
            let mut options = json!({"taskId":task["id"],"taskStart":!locked||metadata["taskStart"]!=false,
                "taskText":task_text,"taskSource":"task-shell","clientMsgId":id,"idempotencyKey":id,
                "taskShellReceiptId":id,"receivedAt":receipt["createdAt"],"taskContextSeed":"",
                "taskShellAutoClassify":payload["intent"]=="work" && payload["newTask"]!=true && !locked && !truthy(&owner["standalone"])});
            for key in ["unattended", "lang", "voice"] {
                if truthy(&payload[key]) {
                    options[key] = payload[key].clone();
                }
            }
            if payload["intent"] != "work" {
                options["taskShellControl"] =
                    json!({"intent":payload["intent"],"turnId":payload["turnId"]});
            }
            if payload["intent"] == "answer" {
                options["userInputRequestId"] = payload["requestId"].clone();
                if receipt["supervisorAnswer"] == true {
                    for key in ["unattendedSystem", "unattendedRecovery", "system"] {
                        options[key] = json!(true);
                    }
                }
            }
            if payload["intent"] == "steer"
                || matches!(text(&receipt["decision"]), "continue" | "queued")
            {
                options["originContinue"] = json!(true);
            }
            return Ok(effect(
                "send",
                "after-delivery",
                json!([task["sessionId"], payload["text"], options]),
            ));
        }
        if phase == "after-control-state" {
            if result.is_null() || result["turnId"] != payload["turnId"] {
                return Err(fail(
                    "stale_control",
                    "The task has moved to another turn",
                    409,
                ));
            }
            return Ok(effect(
                "cancel",
                "after-delivery",
                json!([task["sessionId"], payload["turnId"]]),
            ));
        }
        if phase == "after-delivery" {
            if !truthy(&result["ok"]) {
                let code = result["code"]
                    .as_str()
                    .filter(|code| !code.is_empty())
                    .unwrap_or("delivery_failed");
                return Err(fail(
                    code,
                    result["error"]
                        .as_str()
                        .filter(|error| !error.is_empty())
                        .unwrap_or(code),
                    409,
                ));
            }
            let settled = self.settle_receipt(
                &json!({"receiptId":id,"sessionId":task["sessionId"],"dispatchResult":result}),
            )?;
            return Ok(
                json!({"done":true,"result":settled["result"],"stateSource":settled["stateSource"]}),
            );
        }
        Err(conflict("invalid_delivery_phase"))
    }

    fn delivery_dispatch(&self, receipt: &Value, task: &Value, phase: &str) -> Result<Value> {
        let id = text(&receipt["id"]);
        let mut options = receipt["dispatch"].clone();
        options["taskId"] = task["id"].clone();
        options["taskStart"] = json!(false);
        options["taskSource"] = json!("task-shell");
        options["clientMsgId"] = json!(id);
        if !truthy(&options["idempotencyKey"]) {
            options["idempotencyKey"] = json!(id);
        }
        options["taskShellReceiptId"] = json!(id);
        options["receivedAt"] = receipt["createdAt"].clone();
        Ok(effect(
            "dispatch",
            phase,
            json!([task["sessionId"], receipt["payload"]["text"], options]),
        ))
    }
}
