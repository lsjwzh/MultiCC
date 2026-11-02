use super::*;
use crate::task_domain::{array, clean, truth};
use sha2::{Digest, Sha256};
fn hash(v: &Value) -> String {
    format!("{:x}", Sha256::digest(v.to_string().as_bytes()))
}
fn fail(code: &str, message: &str, status: u16) -> String {
    format!(
        "TASK_RULE:{}",
        json!({"code":code,"message":message,"status":status})
    )
}
fn conflict(code: &str) -> String {
    fail(code, code, 409)
}
fn client(v: &Value) -> bool {
    text(v).len() <= 160
        && !text(v).is_empty()
        && text(v)
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_.:-".contains(&c))
}
fn binding_input(v: &Value) -> Result<Value> {
    let version = v["expectedVersion"]
        .as_u64()
        .filter(|n| *n <= 9007199254740991);
    if version.is_none()
        || !client(&v["clientMsgId"])
        || !v["bindings"].is_array()
        || array(&v["bindings"]).len() > 8
    {
        return Err(conflict("invalid_role_binding"));
    }
    let mut size = 0;
    let mut bindings = vec![];
    for b in array(&v["bindings"]) {
        let name = clean(&b["name"], usize::MAX);
        let prompt = clean(&b["prompt"], usize::MAX);
        if name.is_empty() || text(&b["name"]).encode_utf16().count() > 80 || prompt.is_empty() {
            return Err(conflict("invalid_role_binding"));
        }
        size += name.encode_utf16().count() + prompt.encode_utf16().count();
        bindings.push(json!({"name":name,"prompt":prompt}));
    }
    if size > 40000 {
        return Err(conflict("invalid_role_binding"));
    }
    Ok(json!(bindings))
}
fn public_relation(r: &Value) -> Value {
    // 旧实现是 Number(revision) || 1：数字与数字字符串取原值，其余（含布尔、
    // 空串、NaN、0）一律回落 1。不要收紧成 as_u64，否则 "2"/1.5 会被静默改写。
    let revision = match &r["revision"] {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse::<f64>().ok(),
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        _ => None,
    };
    let revision = match revision {
        Some(n) if n.is_finite() && n != 0.0 => json!(n),
        _ => json!(1),
    };
    json!({"id":r["id"],"shellId":r["shellId"],"kind":r["kind"],"fromTaskId":r["fromTaskId"],"toTaskId":r["toTaskId"],"fromTitle":null,"toTitle":null,"provenance":r.get("provenance").filter(|v|truth(v)).cloned().unwrap_or(json!("user")),"confirmed":r["confirmed"]!=false,"revision":revision,"createdAt":r["createdAt"],"resolvedAt":r.get("removedAt").filter(|v|truth(v)).cloned().unwrap_or(Value::Null),"createdBy":r.get("createdBy").filter(|v|truth(v)).cloned().unwrap_or(Value::Null)})
}
fn task_access(t: &Value, owner: &Value, lifecycle: &Value) -> Value {
    if t.is_null() {
        return json!({"status":"active","readOnly":true,"ownerShellId":null,"sourceSessionId":null,"forkedFromTaskId":null});
    }
    json!({"status":lifecycle.get("status").filter(|v|truth(v)).cloned().unwrap_or(json!("active")),"readOnly":lifecycle["status"]=="archived"||lifecycle["deleting"]==true||if !owner.is_null(){!truth(&owner["standalone"])&&!truth(&t["taskFirst"])}else{t["origin"]!="board"},"ownerShellId":owner.get("id").filter(|v|truth(v)).cloned().unwrap_or(Value::Null),"sourceSessionId":owner.get("sourceSessionId").filter(|v|truth(v)).cloned().unwrap_or(Value::Null),"forkedFromTaskId":t.get("forkedFromTaskId").filter(|v|truth(v)).cloned().unwrap_or(Value::Null)})
}
// 归属规则本体（纯函数）：link 是这张卡的 link 行（没有为 Null）。逐卡与整页批量共用。
fn owner_from(t: &Value, link: &Value, records: &Value, task_first: bool) -> Value {
    if truth(&t["ownerShellId"]) {
        return json!({"shellId":t["ownerShellId"]});
    }
    if !link.is_null() {
        return json!({"shellId":link["shellId"]});
    }
    let sid = if truth(&t["sessionId"]) {
        t["sessionId"].clone()
    } else if truth(&t["chatSessionId"]) {
        t["chatSessionId"].clone()
    } else {
        items(&t["refs"])
            .iter()
            .find(|r| {
                records
                    .get(text(&r["sessionId"]))
                    .is_some_and(|v| !v.is_null())
            })
            .map(|r| r["sessionId"].clone())
            .unwrap_or(Value::Null)
    };
    let record = &records[text(&sid)];
    if record.is_null()
        || record["kind"] != "chat"
        || truth(&record["taskExecutionSlot"])
        || truth(&record["experimentalMode"])
        || ["gateway", "aux"].contains(&text(&record["type"]))
        || (record["type"] == "commander" && !task_first)
    {
        Value::Null
    } else {
        json!({"sessionId":sid})
    }
}
impl TaskStore {
    fn owner_plan(&mut self, t: &Value, records: &Value, task_first: bool) -> Result<Value> {
        let link = if truth(&t["ownerShellId"]) {
            Value::Null
        } else {
            self.link_by_task(text(&t["id"]))?
        };
        Ok(owner_from(t, &link, records, task_first))
    }
    // 整页批量：link、link 索引与任务壳从按写入读数缓存的内存映射里取，一页只在这三类
    // 真被写过时重读一次。索引缺失或失效的卡回到 link_by_task（写否定缓存/清失效索引）。
    fn access_batch(&mut self, v: &Value) -> Result<Value> {
        let records = &v["records"];
        let task_first = v["taskFirst"] == true;
        let maps = self.access_maps()?;
        let mut out = vec![];
        for item in items(&v["items"]) {
            let t = &item["task"];
            let link = if truth(&t["ownerShellId"]) {
                Value::Null
            } else {
                match maps.link_for(text(&t["id"])) {
                    Some(link) => link,
                    None => self.link_by_task(text(&t["id"]))?,
                }
            };
            let plan = owner_from(t, &link, records, task_first);
            let owner = if truth(&plan["shellId"]) {
                match maps.shells.get(text(&plan["shellId"])) {
                    Some(shell) if shell.get("standalone").is_some() => {
                        json!({"id":shell["id"],"standalone":shell["standalone"],"sourceSessionId":shell["sourceSessionId"]})
                    }
                    // 壳不在或缺 standalone：宿主走逐卡路径（会建壳/回填）。
                    _ => {
                        out.push(json!({"pending":true}));
                        continue;
                    }
                }
            } else if truth(&plan["sessionId"]) {
                out.push(json!({"pending":true}));
                continue;
            } else {
                Value::Null
            };
            out.push(task_access(t, &owner, &item["lifecycle"]));
        }
        self.access = Some(maps);
        Ok(json!(out))
    }
    fn current_role(&self, id: &str, v: &Value) -> Result<Value> {
        let task = self.get("task", id)?;
        if task.is_null() {
            return Err(conflict("task_not_found"));
        }
        let saved = self.get("task-role:binding", id)?;
        if !saved.is_null() {
            return Ok(saved);
        }
        let prompt = [
            &v["record"]["rolePrompt"],
            &task["runtime"]["rolePrompt"],
            &v["directory"]["rolePrompt"],
        ]
        .into_iter()
        .find(|v| truth(v))
        .cloned()
        .unwrap_or(json!(""));
        Ok(
            json!({"taskId":id,"version":0,"bindings":if truth(&prompt){json!([{"name":"原有角色","prompt":prompt}])}else{json!([])}}),
        )
    }
    fn materialize_role(&mut self, value: &Value) -> Result<Value> {
        let id = format!("role_{}", hash(value));
        let mut snapshot = value.clone();
        snapshot["id"] = json!(id);
        snapshot["prompt"] = json!(array(&value["bindings"])
            .iter()
            .map(|b| format!("【{}】\n{}", text(&b["name"]), text(&b["prompt"])))
            .collect::<Vec<_>>()
            .join("\n\n"));
        let old = self.get("task-role:snapshot", &id)?;
        if !old.is_null() && old != snapshot {
            return Err(conflict("role_snapshot_conflict"));
        }
        if old.is_null() {
            self.put("task-role:snapshot", &id, &snapshot)?;
        }
        Ok(json!(id))
    }
    pub(super) fn rule(&mut self, v: &Value) -> Result<Value> {
        let action = text(&v["action"]);
        let id = text(&v["taskId"]);
        let input = &v["input"];
        match action {
            "ownerPlan" => self.owner_plan(&v["task"], &v["records"], v["taskFirst"] == true),
            "taskAccess" => Ok(task_access(&v["task"], &v["owner"], &v["lifecycle"])),
            // 一次算出整页卡片的权限：读投影只读不写。需要补写任务壳（新建或回填
            // standalone）的卡标成 pending，由宿主走原来的逐卡路径处理。
            // 一次算出整页卡片的权限：读投影不建壳。需要补写任务壳（新建或回填
            // standalone）的卡标成 pending，由宿主走原来的逐卡路径处理。
            "accessBatch" => self.access_batch(v),
            "roleValidate" => binding_input(input),
            "roleCurrent" => self.current_role(id, v),
            "roleUpdate" => {
                let bindings = binding_input(input)?;
                self.atomic(|s|{
                let change=hash(&json!([id,input["clientMsgId"]]));let fingerprint=hash(&json!([input["expectedVersion"],bindings]));let old=s.get("task-role:change",&change)?;
                if !old.is_null(){if old["fingerprint"]!=fingerprint{return Err(conflict("idempotency_conflict"));}return Ok(old["result"].clone());}
                let previous=s.current_role(id,v)?;if previous["version"]!=input["expectedVersion"]{return Err(conflict("role_version_conflict"));}
                let result=json!({"taskId":id,"version":previous["version"].as_u64().unwrap_or(0)+1,"bindings":bindings});s.put("task-role:binding",id,&result)?;s.put("task-role:change",&change,&json!({"id":change,"fingerprint":fingerprint,"previous":previous,"result":result,"createdAt":v["now"]}))?;Ok(result)
            })
            }
            "roleSnapshot" => self.atomic(|s| {
                let value = s.current_role(id, v)?;
                if s.get("task-role:binding", id)?.is_null() {
                    s.put("task-role:binding", id, &value)?;
                }
                s.materialize_role(&value)
            }),
            "roleMaterialize" => self.atomic(|s| s.materialize_role(&v["value"])),
            "roleVerify" => {
                let snapshot = self.get("task-role:snapshot", text(&v["id"]))?;
                let value = json!({"taskId":snapshot["taskId"],"version":snapshot["version"],"bindings":snapshot["bindings"]});
                Ok(
                    if snapshot.is_null()
                        || (!id.is_empty() && snapshot["taskId"] != id)
                        || snapshot["id"] != format!("role_{}", hash(&value))
                    {
                        Value::Null
                    } else {
                        snapshot
                    },
                )
            }
            "roleInherit" => self.atomic(|s| {
                let source = s.current_role(text(&v["sourceTaskId"]), v)?;
                let value =
                    json!({"taskId":id,"version":source["version"],"bindings":source["bindings"]});
                let old = s.get("task-role:binding", id)?;
                if !old.is_null() && old != value {
                    return Err(conflict("role_binding_conflict"));
                }
                if old.is_null() {
                    s.put("task-role:binding", id, &value)?;
                }
                Ok(value)
            }),
            "directoryCount" | "directoryCapacity" => {
                let count = self
                    .rows("task", true)?
                    .iter()
                    .filter(|(_, _, t)| t["dirId"] == v["dirId"])
                    .count();
                Ok(if action == "directoryCount" {
                    json!(count)
                } else {
                    json!(count >= 1024)
                })
            }
            "relationList" => {
                let mut rows = self
                    .rows("relation", true)?
                    .into_iter()
                    .map(|(_, _, v)| v)
                    .filter(|r| r["shellId"] == v["shellId"])
                    .collect::<Vec<_>>();
                rows.sort_by(|a, b| {
                    crate::task_domain::num(&b["createdAt"])
                        .total_cmp(&crate::task_domain::num(&a["createdAt"]))
                });
                Ok(json!(rows.iter().map(public_relation).collect::<Vec<_>>()))
            }
            "relationCreate" | "relationRemove" => self.atomic(|s| s.change_relation(v)),
            _ => Err("invalid_task_store_rule".into()),
        }
    }
    fn change_relation(&mut self, v: &Value) -> Result<Value> {
        let input = &v["input"];
        if !client(&input["clientMsgId"]) {
            return Err(fail("invalid_input", "invalid clientMsgId", 400));
        }
        let shell_id = text(&v["shellId"]);
        let operation = format!(
            "rop_{}",
            &hash(&json!([shell_id, input["clientMsgId"]]))[..32]
        );
        if v["action"] == "relationRemove" {
            let id = text(&input["relationId"]);
            let record = self.get("relation", id)?;
            if record.is_null() || record["shellId"] != shell_id {
                let replay = self.get("relation-op", &operation)?;
                if replay["status"] == "removed"
                    && replay["relationId"] == id
                    && truth(&replay["relation"])
                {
                    return Ok(
                        json!({"ok":true,"relation":public_relation(&replay["relation"]),"removed":true,"replayed":true}),
                    );
                }
                return Err(fail("relation_not_found", "Relation not found", 404));
            }
            self.remove("relation", id)?;
            self.put("relation-op",&operation,&json!({"id":operation,"shellId":shell_id,"clientMsgId":input["clientMsgId"],"relationId":record["id"],"status":"removed","fingerprint":record["id"],"relation":record,"removedAt":v["now"],"createdAt":v["now"]}))?;
            return Ok(json!({"ok":true,"relation":public_relation(&record),"removed":true}));
        }
        let shell = self.get("shell", shell_id)?;
        if shell.is_null() {
            return Err(fail("task_shell_not_found", "Task shell not found", 404));
        }
        let kind = if truth(&input["kind"]) {
            text(&input["kind"])
        } else {
            "related"
        };
        if !["related", "group"].contains(&kind) {
            return Err(fail(
                "invalid_input",
                "kind must be one of related, group",
                400,
            ));
        }
        let mut tasks = vec![];
        for label in ["fromTaskId", "toTaskId"] {
            let id = clean(&input[label], usize::MAX);
            if id.is_empty() || id.encode_utf16().count() > 200 {
                return Err(fail("invalid_input", &format!("{label} is required"), 400));
            }
            let task = self.get("task", &id)?;
            if task.is_null() {
                return Err(fail("task_not_found", &format!("{label} not found"), 404));
            }
            tasks.push(task);
        }
        let from = &tasks[0];
        let to = &tasks[1];
        if from["id"] == to["id"] {
            return Err(fail(
                "invalid_input",
                "A task cannot be related to itself",
                400,
            ));
        }
        if from["dirId"] != to["dirId"] || from["dirId"] != shell["dirId"] {
            return Err(fail(
                "project_mismatch",
                "Relations must stay inside one project",
                403,
            ));
        }
        for (task, label) in [(from, "fromTaskId"), (to, "toTaskId")] {
            if self
                .get("link", &format!("{}:{}", shell_id, text(&task["id"])))?
                .is_null()
            {
                return Err(fail(
                    "task_not_linked",
                    &format!("{label} is not part of this conversation"),
                    403,
                ));
            }
        }
        let id = format!(
            "rel_{}",
            &hash(&json!([shell_id, from["id"], to["id"], kind]))[..32]
        );
        let old = self.get("relation-op", &operation)?;
        if truth(&old["fingerprint"]) && old["fingerprint"] != id {
            return Err(fail(
                "idempotency_conflict",
                "This operation id was used for a different relation",
                409,
            ));
        }
        let current = self.get("relation", &id)?;
        if !current.is_null() {
            return Ok(json!({"ok":true,"relation":public_relation(&current),"created":false}));
        }
        let record = json!({"id":id,"shellId":shell_id,"kind":kind,"fromTaskId":from["id"],"toTaskId":to["id"],"provenance":"user","confirmed":true,"revision":1,"createdBy":input["clientMsgId"],"createdAt":v["now"]});
        self.put("relation", &id, &record)?;
        self.put("relation-op",&operation,&json!({"id":operation,"shellId":shell_id,"clientMsgId":input["clientMsgId"],"relationId":id,"status":"applied","fingerprint":id,"createdAt":v["now"]}))?;
        Ok(json!({"ok":true,"relation":public_relation(&record),"created":true}))
    }
}
