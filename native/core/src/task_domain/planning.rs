use super::host::{Facts, Host};
use super::*;
const SAFE: f64 = 9007199254740991.0;
const STAGES: [&str; 5] = ["inbox", "ready", "doing", "review", "done"];
fn rank(v: &Value, fallback: f64) -> f64 {
    let n = number(v);
    if n.is_finite() && n.abs() <= SAFE {
        n
    } else {
        fallback
    }
}
fn revision(v: &Value, fallback: f64) -> f64 {
    let n = number(v).floor();
    if (1.0..=SAFE).contains(&n) {
        n
    } else {
        fallback
    }
}
fn priority(v: &Value) -> Value {
    let p = clean(v, usize::MAX).to_lowercase();
    if ["low", "medium", "high", "urgent"].contains(&p.as_str()) {
        json!(p)
    } else {
        Value::Null
    }
}
fn record_type(t: &Value, origin: &Value) -> Value {
    if ["planned", "observed"].contains(&text(&t["recordType"])) {
        t["recordType"].clone()
    } else {
        json!(if origin == "board" {
            "planned"
        } else {
            "observed"
        })
    }
}
fn criteria(v: &Value) -> String {
    if let Some(values) = v.as_array() {
        let s = values
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join("\n");
        clean(&json!(s), 20000)
    } else {
        clean(v, 20000)
    }
}
fn invalid_field(code: &str, field: &str) -> Value {
    json!({"ok":false,"error":code,"field":field})
}
fn validate(task: &Value, value: &Value) -> Value {
    if value.is_null() || value == "" {
        return invalid_field("expected_revision_required", "expectedRevision");
    }
    let n = number(value);
    if !n.is_finite() || n.fract() != 0.0 || n < 1.0 || n > SAFE {
        return invalid_field("invalid_expected_revision", "expectedRevision");
    }
    let actual = revision(&task["planningRevision"], 1.0);
    if n != actual {
        return json!({"ok":false,"error":"revision_conflict","expectedRevision":n,"actualRevision":actual});
    }
    json!({"ok":true,"expectedRevision":n})
}
fn stage_tasks(
    board: &Value,
    stage: &Value,
    exclude: &Value,
    dir: &Value,
    host: Host,
) -> Vec<Value> {
    let mut tasks = board["tasks"]
        .as_object()
        .map(|a| {
            a.values()
                .filter(|t| {
                    t["recordType"] == "planned"
                        && t["workflowStage"] == *stage
                        && t["status"] != "archived"
                        && (dir.is_null() || t["dirId"] == *dir)
                        && t["id"] != *exclude
                })
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    tasks.sort_by(|a, b| {
        rank(&a["rank"], 0.0)
            .total_cmp(&rank(&b["rank"], 0.0))
            .then_with(|| num(&a["createdAt"]).total_cmp(&num(&b["createdAt"])))
            .then_with(|| host.compare(&a["id"], &b["id"]))
    });
    tasks
}
fn end_rank(board: &Value, stage: &Value, exclude: &Value, dir: &Value, host: Host) -> f64 {
    stage_tasks(board, stage, exclude, dir, host)
        .last()
        .map(|t| rank(&t["rank"], 0.0) + 1024.0)
        .unwrap_or(1024.0)
}
fn renumber(
    board: &mut Value,
    stage: &Value,
    exclude: &Value,
    dir: &Value,
    host: Host,
) -> Vec<Value> {
    let mut tasks = stage_tasks(board, stage, exclude, dir, host);
    for (i, t) in tasks.iter_mut().enumerate() {
        t["rank"] = json!((i + 1) * 1024);
        board["tasks"][text(&t["id"])]["rank"] = t["rank"].clone();
    }
    tasks
}
fn move_rank(
    board: &mut Value,
    id: &str,
    stage: &Value,
    input: &Value,
    host: Host,
    retry: bool,
) -> Value {
    let task = &board["tasks"][id];
    if task.is_null() || task["recordType"] != "planned" {
        return invalid("task_not_found");
    }
    let dir = task["dirId"].clone();
    let tasks = stage_tasks(board, stage, &json!(id), &dir, host);
    let before = clean(&input["beforeTaskId"], 128);
    let after = clean(&input["afterTaskId"], 128);
    if before == id || after == id {
        return invalid("invalid_move_anchor");
    }
    let bi = tasks.iter().position(|t| t["id"] == before);
    let ai = tasks.iter().position(|t| t["id"] == after);
    if (!before.is_empty() && bi.is_none()) || (!after.is_empty() && ai.is_none()) {
        return invalid("move_anchor_not_found");
    }
    if let (Some(b), Some(a)) = (bi, ai) {
        if a >= b {
            return invalid("invalid_move_anchor_order");
        }
    }
    let lower = ai.map(|i| rank(&tasks[i]["rank"], 0.0)).or_else(|| {
        bi.filter(|i| *i > 0)
            .map(|i| rank(&tasks[i - 1]["rank"], 0.0))
    });
    let upper = bi.map(|i| rank(&tasks[i]["rank"], 0.0)).or_else(|| {
        ai.filter(|i| i + 1 < tasks.len())
            .map(|i| rank(&tasks[i + 1]["rank"], 0.0))
    });
    match (lower, upper) {
        (None, None) => json!({"ok":true,"rank":end_rank(board,stage,&json!(id),&dir,host)}),
        (None, Some(u)) => json!({"ok":true,"rank":u-1024.0}),
        (Some(l), None) => json!({"ok":true,"rank":l+1024.0}),
        (Some(l), Some(u)) => {
            let n = l + (u - l) / 2.0;
            let error = if u <= l {
                "invalid_move_anchor_order"
            } else {
                "rank_space_exhausted"
            };
            if u > l && n > l && n < u {
                return json!({"ok":true,"rank":n});
            }
            if retry {
                return invalid(error);
            }
            renumber(board, stage, &json!(id), &dir, host);
            move_rank(board, id, stage, input, host, true)
        }
    }
}
pub fn fields(t: &Value, host: Host) -> Value {
    let planned = t["recordType"] == "planned";
    json!({"recordType":if planned{"planned"}else{"observed"},"dirId":if planned&&truth(&t["dirId"]){t["dirId"].clone()}else{Value::Null},"description":if planned&&truth(&t["description"]){t["description"].clone()}else{json!("")},"workflowStage":if planned{t["workflowStage"].clone()}else{Value::Null},"rank":if planned{json!(rank(&t["rank"],0.0))}else{Value::Null},"priority":if planned{priority(&t["priority"])}else{Value::Null},"dueAt":if planned{host.date(&t["dueAt"])}else{Value::Null},"acceptanceCriteria":if planned&&truth(&t["acceptanceCriteria"]){t["acceptanceCriteria"].clone()}else{json!("")},"planningRevision":if planned{revision(&t["planningRevision"],1.0)}else{0.0}})
}
pub fn normalize_task(t: &mut Value, options: &Value, host: Host) {
    let origin = options.get("origin").cloned().unwrap_or(json!("session"));
    t["recordType"] = record_type(t, &origin);
    if t["recordType"] != "planned" {
        return;
    }
    let d = clean(&t["dirId"], 160);
    let d = if d.is_empty() {
        clean(&options["dirId"], 160)
    } else {
        d
    };
    t["dirId"] = if d.is_empty() { Value::Null } else { json!(d) };
    t["description"] = json!(clean(&t["description"], 20000));
    if !STAGES.contains(&text(&t["workflowStage"])) {
        t["workflowStage"] = json!(if t["status"] == "done" {
            "done"
        } else {
            "inbox"
        });
    }
    t["rank"] = json!(rank(&t["rank"], 0.0));
    t["priority"] = priority(&t["priority"]);
    t["dueAt"] = host.date(&t["dueAt"]);
    t["acceptanceCriteria"] = json!(criteria(&t["acceptanceCriteria"]));
    t["planningRevision"] = json!(revision(&t["planningRevision"], 1.0));
    if t["workflowStage"] == "done" {
        t["status"] = json!("done");
    } else if t["status"] == "done" {
        t["workflowStage"] = json!("done");
    }
}
fn mutate(
    board: &mut Value,
    action: &str,
    id: &str,
    input: &Value,
    options: &Value,
    host: Host,
) -> Value {
    let now = &options["now"];
    if action == "createPlannedTask" {
        let description = clean(&input["description"], 20000);
        let mut title = clean(&input["title"], 40);
        if title.is_empty() {
            title = clean(&json!(description.lines().next().unwrap_or("")), 40);
        }
        let dir = clean(&input["dirId"], 160);
        if title.is_empty() {
            return invalid_field("title_required", "title");
        }
        if dir.is_empty() {
            return invalid_field("directory_required", "dirId");
        }
        let stage = if input["workflowStage"].is_null() || input["workflowStage"] == "" {
            json!("inbox")
        } else {
            input["workflowStage"].clone()
        };
        if !STAGES.contains(&text(&stage)) {
            return invalid_field("invalid_workflow_stage", "workflowStage");
        }
        // 旧 JS 门槛是 `!= null && !== ''`：0/false 也要校验（truth() 会放走它们）。
        if !input["priority"].is_null()
            && input["priority"] != ""
            && input["priority"] != "none"
            && priority(&input["priority"]).is_null()
        {
            return invalid_field("invalid_priority", "priority");
        }
        if !input["dueAt"].is_null() && input["dueAt"] != "" && host.date(&input["dueAt"]).is_null()
        {
            return invalid_field("invalid_due_at", "dueAt");
        }
        if !board["tasks"][id].is_null() {
            return invalid("task_exists");
        }
        let at_end = end_rank(board, &stage, &Value::Null, &json!(dir), host);
        let task = json!({"id":id,"moduleId":null,"title":title,"status":if stage=="done"{"done"}else{"active"},"areas":[],"createdAt":now,"updatedAt":now,"refs":[],"origin":"board","recordType":"planned","dirId":dir,"description":description,"workflowStage":stage,"rank":if input["rank"].is_null(){at_end}else{rank(&input["rank"],at_end)},"priority":priority(&input["priority"]),"dueAt":host.date(&input["dueAt"]),"acceptanceCriteria":criteria(&input["acceptanceCriteria"]),"planningRevision":1});
        board["tasks"][id] = task.clone();
        return json!({"ok":true,"task":task});
    }
    let mut task = board["tasks"][id].clone();
    if task.is_null() {
        return invalid("task_not_found");
    }
    if action == "renameTask" {
        if truth(&task["deleting"]) {
            return invalid("task_deleting");
        }
        if text(input).trim().encode_utf16().count() > 40 {
            return invalid_field("title_too_long", "title");
        }
        let title = clean(input, 40);
        if title.is_empty() {
            return invalid_field("title_required", "title");
        }
        task["title"] = json!(title);
        task["titleSource"] = json!("manual");
        task["updatedAt"] = now.clone();
        if task["recordType"] == "planned" {
            task["planningRevision"] = json!(revision(&task["planningRevision"], 1.0) + 1.0);
        }
    } else {
        if task["recordType"] != "planned" {
            return invalid("task_not_planned");
        }
        if task["status"] == "archived" || truth(&task["deleting"]) {
            return invalid("task_archived");
        }
        let rev = validate(&task, &options["expectedRevision"]);
        if rev["ok"] != true {
            return rev;
        }
        if action == "movePlannedTask" {
            let stage = input
                .get("workflowStage")
                .filter(|v| !v.is_null())
                .cloned()
                .unwrap_or(task["workflowStage"].clone());
            if !STAGES.contains(&text(&stage)) {
                return invalid_field("invalid_workflow_stage", "workflowStage");
            }
            let ranked = move_rank(board, id, &stage, input, host, false);
            if ranked["ok"] != true {
                return ranked;
            }
            task["workflowStage"] = stage.clone();
            task["rank"] = ranked["rank"].clone();
            task["status"] = json!(if stage == "done" { "done" } else { "active" });
        } else {
            if !input["recordType"].is_null() && input["recordType"] != "planned" {
                return invalid("record_type_immutable");
            }
            for (key, code, max) in [
                ("dirId", "directory_required", 160),
                ("title", "title_required", 40),
            ] {
                if input.get(key).is_some() && clean(&input[key], max).is_empty() {
                    return invalid_field(code, key);
                }
            }
            if input.get("priority").is_some()
                && !input["priority"].is_null()
                && input["priority"] != ""
                && input["priority"] != "none"
                && priority(&input["priority"]).is_null()
            {
                return invalid_field("invalid_priority", "priority");
            }
            if input.get("dueAt").is_some()
                && !input["dueAt"].is_null()
                && input["dueAt"] != ""
                && host.date(&input["dueAt"]).is_null()
            {
                return invalid_field("invalid_due_at", "dueAt");
            }
            if input.get("workflowStage").is_some()
                && !STAGES.contains(&text(&input["workflowStage"]))
            {
                return invalid_field("invalid_workflow_stage", "workflowStage");
            }
            let previous_dir = task["dirId"].clone();
            let previous_stage = task["workflowStage"].clone();
            for (key, max) in [("title", 40), ("dirId", 160), ("description", 20000)] {
                if input.get(key).is_some() {
                    task[key] = json!(clean(&input[key], max));
                }
            }
            if input.get("priority").is_some() {
                task["priority"] = priority(&input["priority"]);
            }
            if input.get("dueAt").is_some() {
                task["dueAt"] = host.date(&input["dueAt"]);
            }
            if input.get("acceptanceCriteria").is_some() {
                task["acceptanceCriteria"] = json!(criteria(&input["acceptanceCriteria"]));
            }
            if input.get("workflowStage").is_some() {
                task["workflowStage"] = input["workflowStage"].clone();
                task["status"] = json!(if task["workflowStage"] == "done" {
                    "done"
                } else {
                    "active"
                });
            }
            if previous_dir != task["dirId"] || previous_stage != task["workflowStage"] {
                task["rank"] = json!(end_rank(
                    board,
                    &task["workflowStage"],
                    &task["id"],
                    &task["dirId"],
                    host
                ));
            }
        }
        task["updatedAt"] = now.clone();
        task["planningRevision"] = json!(revision(&task["planningRevision"], 1.0) + 1.0);
    }
    board["tasks"][id] = task.clone();
    json!({"ok":true,"task":task})
}
/// 在借用的任务板上执行；只读 action 不会改写 `board`。
pub fn apply(board: &mut Value, v: &Value, host: Host) -> Result<Value, String> {
    let action = text(&v["action"]);
    let mut task = v["task"].clone();
    let options = &v["options"];
    let input = &v["input"];
    let result = match action {
        "normalizePriority" => priority(input),
        "normalizeDueAt" => host.date(input),
        "normalizeRank" => json!(if v.get("input").is_none() || v["inputNonFinite"] == true {
            options["fallback"].as_f64().unwrap_or(0.0)
        } else {
            rank(input, options["fallback"].as_f64().unwrap_or(0.0))
        }),
        "planningRevision" => json!(revision(input, options["fallback"].as_f64().unwrap_or(1.0))),
        "recordTypeForTask" => record_type(&task, &v["origin"]),
        "planningFields" => fields(&task, host),
        "validateExpectedRevision" => validate(&task, input),
        "normalizePlanningTask" => {
            normalize_task(&mut task, options, host);
            task.clone()
        }
        "plannedTasksInStage" => json!(stage_tasks(
            board,
            &v["stage"],
            &v["exclude"],
            &v["dirId"],
            host
        )),
        "rankAtEnd" => json!(end_rank(
            board,
            &v["stage"],
            &v["exclude"],
            &v["dirId"],
            host
        )),
        "renumberStage" => json!(renumber(
            board,
            &v["stage"],
            &v["exclude"],
            &v["dirId"],
            host
        )),
        "rankForMove" => move_rank(
            board,
            text(&v["taskId"]),
            &v["stage"],
            input,
            host,
            options["_renumbered"] == true,
        ),
        "createPlannedTask" | "updatePlannedTask" | "renameTask" | "movePlannedTask" => {
            mutate(board, action, text(&v["taskId"]), input, options, host)
        }
        "markPlannedTaskStarted" | "alignStageWithStatus" => {
            if task.is_null()
                || task["recordType"] != "planned"
                || (action == "markPlannedTaskStarted" && task["status"] == "archived")
            {
                json!(false)
            } else {
                let next = if action == "markPlannedTaskStarted" {
                    json!("doing")
                } else if v["status"] == "done" {
                    json!("done")
                } else if v["status"] == "active" && task["workflowStage"] == "done" {
                    json!("ready")
                } else {
                    task["workflowStage"].clone()
                };
                let changed = task["workflowStage"] != next
                    || (action == "markPlannedTaskStarted" && task["status"] != "active");
                if changed {
                    task["workflowStage"] = next.clone();
                    if action == "markPlannedTaskStarted" {
                        task["status"] = json!("active");
                    } else if board.is_object() {
                        task["rank"] =
                            json!(end_rank(board, &next, &task["id"], &task["dirId"], host));
                    }
                    task["updatedAt"] = options["now"].clone();
                    task["planningRevision"] =
                        json!(revision(&task["planningRevision"], 1.0) + 1.0);
                }
                json!(changed)
            }
        }
        _ => return Err("invalid_task_planning_command".into()),
    };
    Ok(json!({"result":result,"task":task}))
}

/// 旧 alignStageWithStatus 的嵌套调用不带 idOrder/dates：保持空表语义。
pub fn align_stage(t: &mut Value, status: &Value, now: &Value, board: &Value) -> bool {
    if t.is_null() || t["recordType"] != "planned" {
        return false;
    }
    let next = if status == "done" {
        json!("done")
    } else if status == "active" && t["workflowStage"] == "done" {
        json!("ready")
    } else {
        t["workflowStage"].clone()
    };
    let changed = t["workflowStage"] != next;
    if changed {
        t["workflowStage"] = next.clone();
        if board.is_object() {
            let facts = Facts::default();
            t["rank"] = json!(end_rank(board, &next, &t["id"], &t["dirId"], facts.host()));
        }
        t["updatedAt"] = now.clone();
        t["planningRevision"] = json!(revision(&t["planningRevision"], 1.0) + 1.0);
    }
    changed
}

/// 旧嵌套 rankAtEnd 命令不带 idOrder：调用方用空表 Host。
pub fn rank_at_end(
    board: &Value,
    stage: &Value,
    exclude: &Value,
    dir: &Value,
    host: Host,
) -> Value {
    json!(end_rank(board, stage, exclude, dir, host))
}

pub fn run(v: &Value) -> Result<Value, String> {
    let facts = Facts::of(v);
    let mut board = v["board"].clone();
    let before = board["tasks"].clone();
    let out = apply(&mut board, v, facts.host())?;
    let changes = board["tasks"]
        .as_object()
        .map(|tasks| {
            tasks
                .iter()
                .filter(|(id, t)| before.get(*id) != Some(*t))
                .map(|(id, t)| json!([id, t]))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let mut out = out;
    let map = out.as_object_mut().unwrap();
    let result = map.shift_remove("result").unwrap_or(Value::Null);
    let task = map.shift_remove("task").unwrap_or(Value::Null);
    Ok(json!({"result":result,"changes":changes,"task":task}))
}
