//! 任务身份、路由收据、引用与生命周期纯规则。
use super::*;
use std::collections::HashSet;
pub fn values(v: &Value) -> Vec<Value> {
    v.as_object()
        .map(|m| m.values().cloned().collect())
        .unwrap_or_default()
}
pub fn unique(v: Vec<Value>) -> Vec<Value> {
    let mut out = vec![];
    for x in v {
        if !out.contains(&x) {
            out.push(x);
        }
    }
    out
}
pub fn routing(v: &Value) -> Value {
    let mode = text(&v["mode"]);
    let target = clean(&v["targetSessionId"], 200);
    if !["commander", "manual", "router-tool"].contains(&mode) || target.is_empty() {
        return Value::Null;
    }
    let mut r =
        json!({"mode":mode,"targetSessionId":target,"routedAt":num(&v["routedAt"]).max(0.0)});
    for k in ["workerSessionId", "operationId"] {
        let s = clean(&v[k], 200);
        if !s.is_empty() {
            r[k] = json!(s);
        }
    }
    let status = |v: &Value| {
        let s = text(v);
        if !s.is_empty()
            && s.len() <= 40
            && s.bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
        {
            s.to_string()
        } else {
            String::new()
        }
    };
    let st = status(&v["status"]);
    if !st.is_empty() {
        r["status"] = json!(st);
    }
    for k in ["oneWay", "elasticWorkerCreated"] {
        if v[k] == true {
            r[k] = json!(true);
        }
    }
    let mut attempts=array(&v["attempts"]).iter().filter(|a|!clean(&a["operationId"],usize::MAX).is_empty()).map(|a|{let s=status(&a["status"]);json!({"operationId":clean(&a["operationId"],200),"workerSessionId":clean(&a["workerSessionId"],200),"status":if s.is_empty(){"admitted".into()}else{s},"at":num(&a["at"]).max(0.0)})}).collect::<Vec<_>>();
    if attempts.len() > 50 {
        attempts.drain(..attempts.len() - 50);
    }
    if truth(&r["operationId"])
        && !attempts
            .iter()
            .any(|a| a["operationId"] == r["operationId"])
    {
        attempts.push(json!({"operationId":r["operationId"],"workerSessionId":clean(&r["workerSessionId"],200),"status":if st.is_empty(){"admitted"}else{&st},"at":r["routedAt"]}));
    }
    r["attempts"] = json!(attempts);
    r
}
pub fn run_ids(t: &Value) -> Vec<Value> {
    let r = routing(&t["routing"]);
    if r["oneWay"] == true && truth(&r["workerSessionId"]) {
        vec![r["workerSessionId"].clone()]
    } else {
        unique(
            array(&t["refs"])
                .into_iter()
                .map(|r| r["sessionId"].clone())
                .filter(truth)
                .collect(),
        )
    }
}
pub fn sole_id(t: &Value) -> Value {
    let r = routing(&t["routing"]);
    if truth(&r["workerSessionId"]) {
        r["workerSessionId"].clone()
    } else if truth(&t["chatSessionId"]) && run_ids(t).contains(&t["chatSessionId"]) {
        t["chatSessionId"].clone()
    } else {
        json!("")
    }
}
pub fn session_has_turn(r: &Value) -> bool {
    let s = &r["taskState"];
    [
        "queueState",
        "classifyState",
        "classifyHistory",
        "classifyUpdatedAt",
        "lastTurnEndedAt",
        "startedAt",
        "endedAt",
    ]
    .iter()
    .any(|k| {
        let v = &s[k];
        if let Some(a) = v.as_array() {
            !a.is_empty()
        } else {
            !v.is_null() && v != ""
        }
    })
}
pub fn claimed_at(t: &Value) -> f64 {
    for k in ["runStateAt", "updatedAt", "createdAt"] {
        if truth(&t[k]) {
            return num(&t[k]);
        }
    }
    0.0
}
pub fn stale(t: &Value, state: &Value, now: f64) -> Value {
    let stamp = claimed_at(t);
    if ["running", "queued"].contains(&text(&t["runState"]))
        && truth(&sole_id(t))
        && stamp > 0.0
        && now - stamp > 60000.0
        && truth(state)
        && state != "running"
        && state != "queued"
    {
        if state == "done" || state == "completed" {
            json!("succeeded")
        } else {
            state.clone()
        }
    } else {
        Value::Null
    }
}
pub fn dead(t: &Value, has_turn: bool, now: f64) -> bool {
    let stamp = claimed_at(t);
    ["running", "queued"].contains(&text(&t["runState"]))
        && !has_turn
        && stamp > 0.0
        && now - stamp > 60000.0
}
pub fn dir(b: &Value, t: &Value) -> Value {
    let id = clean(&t["dirId"], usize::MAX);
    if !id.is_empty() {
        return json!(id);
    }
    let d = &b["modules"][text(&t["moduleId"])]["dirId"];
    if truth(d) {
        return d.clone();
    }
    array(&t["refs"])
        .iter()
        .find_map(|r| {
            if truth(&r["dirId"]) {
                Some(r["dirId"].clone())
            } else {
                None
            }
        })
        .unwrap_or(Value::Null)
}
pub fn resolve(b: &Value, id: &str) -> Value {
    let mut t = b["tasks"][id].clone();
    let mut seen = HashSet::new();
    while truth(&t["mergedInto"]) {
        if !seen.insert(text(&t["id"]).to_string()) {
            return Value::Null;
        }
        t = b["tasks"][text(&t["mergedInto"])].clone();
    }
    t
}
pub fn last(t: &Value) -> f64 {
    array(&t["refs"])
        .last()
        .map(|r| num(&r["ts"]))
        .unwrap_or(0.0)
        .max(num(&t["updatedAt"]))
        .max(num(&t["createdAt"]))
}
pub fn align(t: &mut Value, status: &Value, now: &Value, b: &Value) {
    // 旧实现走的是不含 idOrder/dates 的嵌套命令，这里保持空表语义。
    planning::align_stage(t, status, now, b);
}
pub fn add_ref(t: &mut Value, r: &Value, now: &Value, max: Option<usize>) -> bool {
    let mut refs = array(&t["refs"]);
    let i = refs.iter().position(|p| {
        (truth(&r["assistantMsgId"]) && p["assistantMsgId"] == r["assistantMsgId"])
            || (truth(&r["userMsgId"]) && p["userMsgId"] == r["userMsgId"])
            || (truth(&r["userMsgId"])
                && !truth(&p["userMsgId"])
                && !truth(&p["assistantMsgId"])
                && p["sessionId"] == r["sessionId"])
    });
    let mut changed = false;
    if let Some(i) = i {
        let p = &mut refs[i];
        for k in ["assistantMsgId", "userMsgId", "dirId"] {
            if !truth(&p[k]) && truth(&r[k]) {
                p[k] = r[k].clone();
                changed = true;
            }
        }
        if truth(&r["ts"]) && num(&r["ts"]) > num(&p["ts"]) {
            p["ts"] = r["ts"].clone();
            changed = true;
        }
        if truth(&r["excerpt"]) && r["excerpt"] != p["excerpt"] {
            p["excerpt"] = json!(clean(&r["excerpt"], 200));
            changed = true;
        }
    } else {
        let mut p =
            json!({"dirId":null,"userMsgId":null,"assistantMsgId":null,"ts":now,"excerpt":""});
        if let Some(s) = r.get("sessionId") {
            p["sessionId"] = s.clone();
        }
        for k in ["dirId", "userMsgId", "assistantMsgId", "ts"] {
            if truth(&r[k]) {
                p[k] = r[k].clone();
            }
        }
        p["excerpt"] = json!(slice(text(&r["excerpt"]), 200));
        refs.push(p);
        if let Some(max) = max {
            if refs.len() > max {
                refs.drain(..refs.len() - max);
            }
        }
        changed = true;
    }
    t["refs"] = json!(refs);
    if changed {
        t["updatedAt"] = now.clone();
    }
    if t["status"] == "done" {
        t["status"] = json!("active");
        align(t, &json!("active"), now, &Value::Null);
        changed = true;
    }
    changed
}
pub fn slice(s: &str, n: usize) -> String {
    let mut size = 0;
    s.chars()
        .take_while(|c| {
            size += c.len_utf16();
            size <= n
        })
        .collect()
}
/// 在借用的任务板上执行；只读 action 不会改写 `b`。
pub fn apply(b: &mut Value, v: &Value) -> Result<Value, String> {
    let mut t = v["task"].clone();
    let action = text(&v["action"]);
    let now = &v["now"];
    let result = match action {
        "normalizeTaskRouting" => routing(&v["value"]),
        "taskRunSessionIds" => json!(run_ids(&t)),
        "soleRunSessionId" => sole_id(&t),
        "sessionHasTurn" => json!(session_has_turn(&v["record"])),
        "deadDispatchClaim" => json!(dead(&t, v["hasTurnState"] == true, num(now))),
        "staleWorkerClaim" => stale(&t, &v["state"], num(now)),
        "foreignRunSession" => {
            let r = routing(&t["routing"]);
            json!(
                truth(&v["sessionId"])
                    && r["oneWay"] == true
                    && truth(&r["workerSessionId"])
                    && v["sessionId"] != r["workerSessionId"]
                    && v["sessionId"] != t["chatSessionId"]
            )
        }
        "taskDirId" => dir(&b, &t),
        "resolveTask" => resolve(&b, text(&v["taskId"])),
        "taskLineageIds" => {
            let target = resolve(&b, text(&v["taskId"]));
            if target.is_null() {
                json!([])
            } else {
                let mut ids = vec![target["id"].clone()];
                for t in objects(&b["tasks"]) {
                    if t["id"] != target["id"]
                        && truth(&t["mergedInto"])
                        && resolve(&b, text(&t["id"]))["id"] == target["id"]
                    {
                        ids.push(t["id"].clone());
                    }
                }
                json!(ids)
            }
        }
        "taskLastTs" => json!(last(&t)),
        // 分类提示词的“现有任务”：未归档、不在模块归类中，按最后活动时间倒序（稳定）
        // 取前 limit 个，返回板里的键。替代宿主逐次比较都调用一次 taskLastTs。
        "recentTaskIds" => {
            let mut rows: Vec<(&String, f64)> = b["tasks"]
                .as_object()
                .into_iter()
                .flatten()
                .filter(|(_, t)| {
                    t.is_object() && t["status"] != "archived" && !truth(&t["moduleAssignment"])
                })
                .map(|(id, t)| (id, last(t)))
                .collect();
            rows.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
            let limit = v["limit"].as_u64().map_or(usize::MAX, |n| n as usize);
            json!(rows
                .into_iter()
                .take(limit)
                .map(|(id, _)| id)
                .collect::<Vec<_>>())
        }
        "addRefToTask" => json!(add_ref(
            &mut t,
            &v["ref"],
            now,
            v["maxRefs"].as_u64().map(|n| n as usize)
        )),
        "setTaskRouting" => {
            let mut r = routing(&v["value"]);
            if t.is_null() || r.is_null() {
                json!(false)
            } else {
                let previous = routing(&t["routing"]);
                let mut attempts = array(&previous["attempts"]);
                if !attempts.is_empty() {
                    for a in array(&r["attempts"]) {
                        if let Some(i) = attempts
                            .iter()
                            .position(|p| p["operationId"] == a["operationId"])
                        {
                            attempts[i] = a;
                        } else {
                            attempts.push(a);
                        }
                    }
                    attempts.sort_by(|a, b| {
                        num(&a["at"])
                            .total_cmp(&num(&b["at"]))
                            .then_with(|| text(&a["operationId"]).cmp(text(&b["operationId"])))
                    });
                    if attempts.len() > 50 {
                        attempts.drain(..attempts.len() - 50);
                    }
                    r["attempts"] = json!(attempts);
                }
                t["updatedAt"] = json!(num(&t["updatedAt"]).max(if truth(&r["routedAt"]) {
                    num(&r["routedAt"])
                } else {
                    num(now)
                }));
                t["routing"] = r;
                json!(true)
            }
        }
        "lifecycleValidate" => {
            if !v["expectedRevision"].is_null()
                && t["recordType"] == "planned"
                && number(&v["expectedRevision"]) != num(&t["planningRevision"])
            {
                invalid("revision_conflict")
            } else {
                json!({"ok":true})
            }
        }
        "permanentPurgeRefusal" => json!([
            "TASK_HISTORY_REFERENCED",
            "task_session_shared",
            "shell_workspace_referenced",
            "task_workspace_dirty",
            "task_workspace_unmerged",
            "task_workspace_ignored",
            "task_workspace_unverifiable"
        ]
        .contains(&text(&v["code"]))),
        "lifecycle" => {
            let id = text(&v["taskId"]);
            let op = text(&v["operation"]);
            let ids = array(&v["ids"]);
            if op == "delete" {
                for id in &ids {
                    if let Some(m) = b["tasks"].as_object_mut() {
                        m.shift_remove(text(id));
                    }
                }
                let mut deleted = array(&b["deletedTaskIds"]);
                deleted.extend(ids.clone());
                b["deletedTaskIds"] = json!(unique(deleted));
                let groups = values(&b["taskGroups"]);
                for mut g in groups {
                    let members = array(&g["taskIds"])
                        .into_iter()
                        .filter(|id| !ids.contains(id))
                        .collect::<Vec<_>>();
                    if members.len() < 2 {
                        b["taskGroups"]
                            .as_object_mut()
                            .unwrap()
                            .shift_remove(text(&g["id"]));
                    } else {
                        if ids.contains(&g["rootTaskId"]) {
                            g["rootTaskId"] = members[0].clone();
                        }
                        g["taskIds"] = json!(members);
                        let id = text(&g["id"]).to_string();
                        b["taskGroups"][id] = g;
                    }
                }
            } else if ["barrier", "rollback"].contains(&op) {
                for id in ids {
                    if let Some(task) = b["tasks"].get_mut(text(&id)) {
                        if op == "barrier" {
                            task["deleting"] = json!(true);
                        } else {
                            task.as_object_mut().unwrap().shift_remove("deleting");
                        }
                    }
                }
            } else {
                // serde 的 IndexMut 对缺失键是“插入 Null”而非报错；直接索引会把
                // 不存在的任务变成幽灵行。存在性必须显式判，缺失走错误路径。
                let Some(task) = b["tasks"].get_mut(id) else {
                    return Err("task_not_found".into());
                };
                if op == "archive" && task["status"] != "archived" {
                    task["archivedFromStatus"] = task["status"].clone();
                }
                task["status"] = if op == "archive" {
                    json!("archived")
                } else {
                    task.get("archivedFromStatus")
                        .filter(|v| truth(v))
                        .cloned()
                        .unwrap_or(json!("active"))
                };
                task["updatedAt"] = now.clone();
                if task["recordType"] == "planned" {
                    task["planningRevision"] = json!(num(&task["planningRevision"]).max(1.0) + 1.0);
                }
            }
            json!({"ok":true})
        }
        _ => return Err("invalid_task_board_command".into()),
    };
    Ok(
        json!({"result":result,"task":if ["setTaskRouting","addRefToTask"].contains(&action){t}else{Value::Null}}),
    )
}

pub fn run(v: &Value) -> Result<Value, String> {
    let mut b = v["board"].clone();
    let mut out = apply(&mut b, v)?;
    out["board"] = if text(&v["action"]) == "lifecycle" {
        b
    } else {
        Value::Null
    };
    Ok(out)
}
