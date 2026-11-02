use super::*;
fn or(a: &Value, b: &Value) -> Value {
    if truth(a) {
        a.clone()
    } else {
        b.clone()
    }
}
pub fn pending(t: &Value) -> Value {
    let m = &t["attention"];
    if ["completed", "error", "waiting"].contains(&text(&m["kind"]))
        && t["status"] != "archived"
        && num(&m["at"]) > num(&t["seenAt"])
    {
        json!({"kind":m["kind"],"at":num(&m["at"])})
    } else {
        Value::Null
    }
}
pub fn attention(v: &Value) -> Value {
    let mut task = v["task"].clone();
    let action = text(&v["action"]);
    let at = num(&v["at"]);
    let kind = |s: &Value| match text(s) {
        "succeeded" => json!("completed"),
        "error" => json!("error"),
        "waiting" => json!("waiting"),
        _ => Value::Null,
    };
    let changed = match action {
        "kind" => return kind(&v["state"]),
        "pending" => return pending(&task),
        "seen" => {
            if pending(&task).is_null() {
                false
            } else {
                task["seenAt"] = json!(at.max(num(&task["attention"]["at"])));
                true
            }
        }
        "note" => {
            let next = kind(&v["next"]);
            if task.is_null() {
                false
            } else if !next.is_null() && next != kind(&v["previous"]) {
                task["attention"] = json!({"kind":next,"at":at.max(num(&task["seenAt"])+1.0)});
                true
            } else if next.is_null() && task["attention"]["kind"] == "waiting" {
                task.as_object_mut().unwrap().shift_remove("attention");
                true
            } else {
                false
            }
        }
        "normalize" => {
            let src = &v["source"];
            let mark = &src["attention"];
            if ["completed", "error", "waiting"].contains(&text(&mark["kind"]))
                && num(&mark["at"]) > 0.0
            {
                task["attention"] = json!({"kind":mark["kind"],"at":num(&mark["at"])});
            }
            if num(&src["seenAt"]) > 0.0 {
                task["seenAt"] = json!(num(&src["seenAt"]));
            }
            false
        }
        _ => false,
    };
    json!({"task":task,"changed":changed})
}
pub fn run_state(t: &Value, facts: &Value, now: f64) -> Value {
    if t["runState"] != "running" && t["runState"] != "queued" {
        return t.get("runState").cloned().unwrap_or(Value::Null);
    }
    let stamp = num(&or(&t["runStateAt"], &or(&t["updatedAt"], &t["createdAt"])));
    if stamp <= 0.0 || now - stamp <= 60000.0 {
        return t["runState"].clone();
    }
    let ids = board::run_ids(t)
        .into_iter()
        .map(|v| text(&v).to_string())
        .collect::<Vec<_>>();
    let has_turn = ids.iter().any(|id| {
        let state = &facts[id]["taskState"];
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
            let v = &state[k];
            if let Some(a) = v.as_array() {
                !a.is_empty()
            } else {
                !v.is_null() && v != ""
            }
        })
    });
    if !has_turn {
        return json!("idle");
    }
    let executor_value = board::sole_id(t);
    let executor = text(&executor_value);
    let state = &facts[executor]["runState"];
    if !executor.is_empty() && truth(state) && state != "running" && state != "queued" {
        if state == "done" || state == "completed" {
            json!("succeeded")
        } else {
            state.clone()
        }
    } else {
        t["runState"].clone()
    }
}
pub fn base(v: &Value) -> Value {
    let t = &v["task"];
    let r = &v["record"];
    let session = or(&t["chatSessionId"], &or(&t["sessionId"], &Value::Null));
    let workspace = &v["workspace"];
    let lease = &v["lease"];
    let residency = or(
        &workspace["residency"],
        &json!(if r["workspaceState"] == "planned" || r.is_null() {
            "planned"
        } else {
            "retained"
        }),
    );
    let resource = json!({"id":or(&workspace["id"],&Value::Null),"residency":residency,"lease":or(&lease["state"],&json!("idle")),"capacityReason":null,"reason":or(&lease["reason"],&Value::Null),"pins":or(&workspace["pins"],&json!([])),"path":or(&workspace["path"],&or(&r["worktreePath"],&Value::Null)),"branch":or(&workspace["branch"],&or(&r["branch"],&Value::Null))});
    let refs = array(&t["refs"]);
    let last = refs.iter().map(|v| num(&v["ts"])).fold(0.0, f64::max);
    // 旧链是数字回退 Number(createdAt) || Number(updatedAt)：先数值化再选，
    // 不能用真值 or()（ISO 字符串 createdAt 真值为真、数值为 0 会吞掉 updatedAt）。
    let last = if last != 0.0 {
        last
    } else {
        let created = num(&t["createdAt"]);
        if created != 0.0 {
            created
        } else {
            num(&t["updatedAt"])
        }
    };
    let mut card = json!({"id":t["id"],"title":t["title"],"status":t["status"],"recordType":or(&t["recordType"],&Value::Null),"workflowStage":or(&t["workflowStage"],&Value::Null),"lastMessageAt":last,"sessionId":session});
    if let Some(dir) = v.get("dirId") {
        card["dirId"] = dir.clone();
    }
    if let Some(at) = t
        .get("updatedAt")
        .filter(|v| truth(v))
        .or_else(|| t.get("createdAt"))
    {
        card["updatedAt"] = at.clone();
    }
    if let Some(access) = v["access"].as_object() {
        for (k, value) in access {
            card[k] = value.clone();
        }
    }
    card["providerName"] = if truth(&r["provider"]) {
        or(&v["providerName"], &r["provider"])
    } else {
        Value::Null
    };
    card["runState"] = Value::Null;
    card["goalState"] = if ["achieved", "interact"].contains(&text(&r["taskState"]["goalState"])) {
        r["taskState"]["goalState"].clone()
    } else {
        Value::Null
    };
    card["resource"] = resource;
    card["worktreeChanges"] = Value::Null;
    card["attention"] = pending(t);
    let capacity = if workspace.is_object() && lease.is_null() {
        let mut c = json!({"id":workspace["id"]});
        for k in ["residency", "dirId"] {
            if let Some(v) = workspace.get(k) {
                c[k] = v.clone();
            }
        }
        c
    } else {
        Value::Null
    };
    json!({"card":card,"capacityOf":capacity})
}
pub fn overlay(v: &Value) -> Value {
    overlay_parts(
        &v["task"],
        &v["card"],
        &v["facts"],
        num(&v["now"]),
        &v["merge"],
        &v["capacityReason"],
    )
}
pub fn overlay_parts(
    task: &Value,
    base: &Value,
    facts: &Value,
    now: f64,
    merge: &Value,
    capacity_reason: &Value,
) -> Value {
    let mut card = base.clone();
    // 旧实现恒写 runState（底稿占位 null，覆盖层写实时值）；键缺失会让
    // 依赖键存在的客户端与缓存签名比对产生分叉，这里恢复恒存在。
    card["runState"] = run_state(task, facts, now);
    let m = merge;
    card["worktreeChanges"] =
        if !m.is_null() && m["reason"] != "loading" && m["worktreeMissing"] != true {
            let raw = js_string(&m["ahead"]);
            let digits = super::normalize::re(r"^[+-]?\d+")
                .find(raw.trim())
                .map(|m| m.as_str())
                .unwrap_or("0");
            let n = digits.parse::<f64>().unwrap_or(0.0);
            let ahead = if n.is_finite() { n.max(0.0) } else { 0.0 };
            json!({"dirty":m["dirty"]==true,"ahead":ahead})
        } else {
            Value::Null
        };
    if !capacity_reason.is_null() {
        card["resource"]["capacityReason"] = capacity_reason.clone();
    }
    card
}
pub fn sort(cards: &mut [Value]) {
    cards.sort_by(|a, b| {
        num(&b["lastMessageAt"])
            .partial_cmp(&num(&a["lastMessageAt"]))
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                num(&b["updatedAt"])
                    .partial_cmp(&num(&a["updatedAt"]))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });
}
