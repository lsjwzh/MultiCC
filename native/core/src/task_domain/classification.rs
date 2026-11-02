//! AI 归类的解析、任务创建与用户确认合并。标题不构成任务身份。
use super::host::{Facts, Host};
use super::*;
use super::{board::*, normalize::*};
use sha2::{Digest, Sha256};
fn next_id(v: &Value, prefix: &str, cursor: &mut usize) -> String {
    let ids = array(&v["newIds"]);
    if let Some(value) = ids.get(*cursor).and_then(Value::as_str) {
        *cursor += 1;
        return format!("{prefix}-{value}");
    }
    // 池耗尽：旧 JS 在这里调 newId 随机生成，绝不复用占位符。退回固定
    // "missing" 会让多条记录共享同一 id 互相覆盖；这里派生稳定唯一 id。
    let mut hasher = Sha256::new();
    hasher.update(prefix.as_bytes());
    hasher.update((*cursor as u64).to_ne_bytes());
    hasher.update(v["now"].to_string().as_bytes());
    hasher.update(v["newIds"].to_string().as_bytes());
    *cursor += 1;
    let digest = hasher.finalize();
    format!(
        "{prefix}-x{:016x}",
        u64::from_be_bytes(digest[..8].try_into().unwrap_or([0u8; 8]))
    )
}
fn areas(t: &mut Value, entries: &Value, trim: bool) -> bool {
    let mut a = array(&t["areas"]);
    let before = a.len();
    for value in array(entries) {
        let value = if trim {
            json!(clean(&value, 80))
        } else {
            value
        };
        if (!trim || truth(&value)) && !a.contains(&value) && a.len() < 8 {
            a.push(value);
        }
    }
    t["areas"] = json!(a);
    t["areas"].as_array().unwrap().len() != before
}
fn delete_empty(b: &mut Value, id: &Value) {
    if !truth(id) {
        return;
    }
    if !objects(&b["tasks"]).any(|t| t["moduleId"] == *id) {
        b["modules"].as_object_mut().unwrap().shift_remove(text(id));
    }
}
pub fn find_task(b: &Value, module: &Value, title: &Value, options: &Value) -> Value {
    let mut best = Value::Null;
    let mut score = 0.0;
    if canonical(title).is_empty() {
        return best;
    }
    for t in objects(&b["tasks"]) {
        if t["status"] == "archived" || truth(&t["deleting"]) {
            continue;
        }
        let same = truth(module) && t["moduleId"] == *module;
        let same_dir = truth(&options["dirId"]) && dir(b, t) == options["dirId"];
        if !same && !same_dir {
            continue;
        }
        let s = similarity(&t["title"], title);
        if s < (if options["similar"] == true {
            0.78
        } else {
            1.0
        }) {
            continue;
        }
        let rank = s + if same { 2.0 } else { 0.0 };
        let previous = score
            + if truth(module) && best["moduleId"] == *module {
                2.0
            } else {
                0.0
            };
        if best.is_null() || rank > previous || (rank == previous && last(t) > last(&best)) {
            best = t.clone();
            score = s;
        }
    }
    best
}
pub fn parse(input: &Value, backfill: bool) -> Value {
    let s = text(input);
    let marker = "<｜end▁of▁thinking｜>";
    let s = s.find(marker).map(|i| &s[i + marker.len()..]).unwrap_or(s);
    let s = re(r"(?s)<think>.*?</think>").replace_all(s, "");
    let s = re(r"</?think>").replace_all(&s, "");
    let s = re(r"(?i)```(?:json)?").replace_all(&s, "");
    let s = s.trim();
    let parsed = crate::json_lenient::from_str::<Value>(s)
        .or_else(|_| {
            let start = s.find('{').unwrap_or(s.len());
            let end = s.rfind('}').unwrap_or(0);
            crate::json_lenient::from_str(if end > start { &s[start..=end] } else { "null" })
        })
        .unwrap_or(Value::Null);
    let list = if !backfill && parsed.is_array() {
        array(&parsed)
    } else {
        array(&parsed["tasks"])
    };
    let mut out = vec![];
    for e in list {
        if !e.is_object() {
            continue;
        }
        let id = clean(&e["id"], usize::MAX);
        let title = clean(&e["title"], 40);
        if id.is_empty() && title.is_empty() {
            continue;
        }
        let a = array(&e["areas"])
            .iter()
            .filter(|a| !clean(a, usize::MAX).is_empty())
            .take(5)
            .map(|a| json!(clean(a, 80)))
            .collect::<Vec<_>>();
        let mut t = json!({"id":id,"title":title,"module":clean(&e["module"],20),"areas":a});
        if backfill {
            let turns = unique(
                array(&e["turns"])
                    .iter()
                    .map(number)
                    .filter(|n| n.is_finite() && *n >= 0.0 && n.fract() == 0.0)
                    .map(|n| json!(n))
                    .collect(),
            );
            if turns.is_empty() {
                continue;
            }
            t["turns"] = json!(turns);
        }
        out.push(t);
        if out.len() >= if backfill { 8 } else { 3 } {
            break;
        }
    }
    json!({"tasks":out})
}
pub fn apply_tags(
    b: &mut Value,
    entries: &Value,
    r: &Value,
    now: &Value,
    options: &Value,
    v: &Value,
    cursor: &mut usize,
) -> Value {
    let mut touched = vec![];
    for e in array(entries).into_iter().take(3) {
        let mut t = if truth(&e["id"]) && e["id"] != "new" {
            b["tasks"][text(&e["id"])].clone()
        } else {
            Value::Null
        };
        if t.is_null() {
            let mod_name = if !clean(&e["module"], usize::MAX).is_empty() {
                clean(&e["module"], usize::MAX)
            } else if truth(&r["dirLabel"]) {
                text(&r["dirLabel"]).into()
            } else {
                "未分组".into()
            };
            let mut m = find_module(b, &json!(mod_name), &r["dirId"]);
            if options["legacyMergeByTitle"] == true {
                t = find_task(b, &m["id"], &e["title"], &json!({"dirId":r["dirId"]}));
            }
            let old = b["modules"][text(&t["moduleId"])].clone();
            let needs = !t.is_null()
                && old["source"] == "classify"
                && options["moduleSource"] != "classify"
                && !clean(&e["module"], usize::MAX).is_empty();
            if m.is_null()
                && !t.is_null()
                && old["source"] == "classify"
                && options["moduleSource"] == "classify"
            {
                m = old.clone();
                m["name"] = json!(slice(&mod_name, 20));
                m["updatedAt"] = now.clone();
                let id = text(&m["id"]).to_string();
                b["modules"][id] = m.clone();
                touched.push(t["id"].clone());
            }
            if m.is_null() && (t.is_null() || needs) {
                m = json!({"id":next_id(v,"mod",cursor),"name":slice(&mod_name,20),"source":if options["moduleSource"]=="classify"{"classify"}else{"ai"},"dirId":r.get("dirId").filter(|v|truth(v)).cloned().unwrap_or(Value::Null),"createdAt":now,"updatedAt":now});
                let id = text(&m["id"]).to_string();
                b["modules"][id] = m.clone();
            }
            if t.is_null() {
                if !truth(&e["title"]) {
                    continue;
                }
                let id = options
                    .get("newTaskId")
                    .filter(|v| truth(v))
                    .cloned()
                    .unwrap_or_else(|| json!(next_id(v, "tsk", cursor)));
                t = json!({"id":id,"moduleId":m["id"],"title":slice(text(&e["title"]),40),"status":"active","areas":[],"createdAt":now,"updatedAt":now,"refs":[],"origin":"session","recordType":"observed"});
                touched.push(id);
            } else if !m.is_null()
                && t["moduleId"] != m["id"]
                && old["source"] == "classify"
                && (m["source"] != "classify" || options["moduleSource"] == "classify")
            {
                t["moduleId"] = m["id"].clone();
                let id = text(&t["id"]).to_string();
                b["tasks"][id] = t.clone();
                delete_empty(b, &old["id"]);
                touched.push(t["id"].clone());
            }
            if !m.is_null() {
                let id = text(&m["id"]).to_string();
                b["modules"][id]["updatedAt"] = now.clone();
            }
        }
        if areas(&mut t, &e["areas"], false) {
            touched.push(t["id"].clone());
        }
        if add_ref(&mut t, r, now, None) {
            touched.push(t["id"].clone());
        }
        let id = text(&t["id"]).to_string();
        b["tasks"][id] = t;
    }
    json!(unique(touched))
}
pub fn pending(b: &mut Value, input: &Value, v: &Value, cursor: &mut usize) -> Value {
    if !truth(&input["sessionId"]) {
        return Value::Null;
    }
    let id = if re(r"^[A-Za-z0-9_-]{1,128}$").is_match(text(&input["taskId"])) {
        text(&input["taskId"]).to_string()
    } else {
        next_id(v, "tsk", cursor)
    };
    if !b["tasks"][&id].is_null() {
        return b["tasks"][&id].clone();
    }
    if array(&b["deletedTaskIds"]).contains(&json!(id)) {
        return Value::Null;
    }
    let d = input
        .get("dirId")
        .filter(|v| truth(v))
        .cloned()
        .unwrap_or(Value::Null);
    let now = &input["now"];
    let mut m=values(&b["modules"]).into_iter().find(|m|m["source"]=="classify"&&m["name"]=="待归类"&&m["dirId"]==d).unwrap_or_else(||json!({"id":next_id(v,"mod",cursor),"name":"待归类","source":"classify","dirId":d,"createdAt":now,"updatedAt":now}));
    let mut t = json!({"id":id,"moduleId":m["id"],"title":title(&input["taskText"]),"status":"active","areas":[],"createdAt":now,"updatedAt":now,"origin":if ["board","session"].contains(&text(&input["origin"])){input["origin"].clone()}else{json!("session")},"refs":[{"sessionId":input["sessionId"],"dirId":d,"userMsgId":null,"assistantMsgId":null,"ts":now,"excerpt":""}],"runState":"running","moduleAssignment":{"running":false,"attempts":0,"lastAttemptAt":0,"lastError":""}});
    // 旧嵌套命令不带 dates/idOrder：保持空表语义。
    let facts = Facts::default();
    let host = facts.host();
    let options = json!({"origin":t["origin"],"dirId":d});
    planning::normalize_task(&mut t, &options, host);
    if t["recordType"] == "planned" {
        t["description"] = json!(clean(&input["taskText"], 20000));
        t["workflowStage"] = json!("doing");
        t["rank"] = planning::rank_at_end(b, &json!("doing"), &Value::Null, &t["dirId"], host);
    }
    b["tasks"][id] = t.clone();
    m["updatedAt"] = now.clone();
    let mid = text(&m["id"]).to_string();
    b["modules"][mid] = m;
    t
}
pub fn classify(b: &mut Value, v: &Value, cursor: &mut usize) -> Value {
    let id = text(&v["taskId"]);
    let mut p = b["tasks"][id].clone();
    if p.is_null() {
        return invalid("task_not_found");
    }
    let e = &v["entry"];
    let candidate = if truth(&e["id"]) && e["id"] != "new" && e["id"] != id {
        b["tasks"][text(&e["id"])].clone()
    } else {
        Value::Null
    };
    let hint = if !candidate.is_null() && !truth(&candidate["moduleAssignment"]) {
        candidate
    } else {
        Value::Null
    };
    let target = if v["options"]["allowIdentityMerge"] == true {
        hint.clone()
    } else {
        Value::Null
    };
    let title = clean(&e["title"], 40);
    let title = if title.is_empty() {
        text(&hint["title"]).to_string()
    } else {
        title
    };
    let em = b["modules"][text(&hint["moduleId"])].clone();
    let mn = if truth(&e["module"]) {
        clean(&e["module"], 20)
    } else {
        clean(&em["name"], 20)
    };
    if (title.is_empty() && target.is_null()) || mn.is_empty() || mn == "待归类" {
        return invalid("invalid_classification");
    }
    let d = dir(b, &p);
    let d = if truth(&d) {
        d
    } else {
        v["ref"].get("dirId").cloned().unwrap_or(Value::Null)
    };
    let mut m = if em.is_null() {
        find_module(b, &json!(mn), &d)
    } else {
        em
    };
    let now = &v["now"];
    if m.is_null() || m["source"] == "classify" {
        m = json!({"id":next_id(v,"mod",cursor),"name":mn,"source":"ai","dirId":d,"createdAt":now,"updatedAt":now});
        let mid = text(&m["id"]).to_string();
        b["modules"][mid] = m.clone();
    }
    let old = p["moduleId"].clone();
    if !target.is_null() && target["id"] != id {
        let mut t = target;
        for r in array(&p["refs"]) {
            add_ref(&mut t, &r, now, None);
        }
        if v["ref"].is_object() {
            add_ref(&mut t, &v["ref"], now, None);
        }
        areas(&mut t, &e["areas"], true);
        t["updatedAt"] = now.clone();
        if truth(&p["routing"])
            && (!truth(&t["routing"])
                || num(&p["routing"]["routedAt"]) >= num(&t["routing"]["routedAt"]))
        {
            t["routing"] = p["routing"].clone();
        }
        if t["status"] == "done" {
            t["status"] = json!("active");
            align(&mut t, &json!("active"), now, b);
        }
        let tid = text(&t["id"]).to_string();
        b["tasks"][&tid] = t;
        b["tasks"].as_object_mut().unwrap().shift_remove(id);
        delete_empty(b, &old);
        return json!({"ok":true,"taskId":tid,"removedTaskId":id,"touched":[tid,id]});
    }
    if p["titleSource"] != "manual" && !title.is_empty() {
        p["title"] = json!(title);
    }
    p["moduleId"] = m["id"].clone();
    p["updatedAt"] = now.clone();
    areas(&mut p, &e["areas"], true);
    if v["ref"].is_object() {
        add_ref(&mut p, &v["ref"], now, None);
    }
    p.as_object_mut().unwrap().shift_remove("moduleAssignment");
    b["tasks"][id] = p;
    m["updatedAt"] = now.clone();
    let mid = text(&m["id"]).to_string();
    b["modules"][mid] = m;
    delete_empty(b, &old);
    json!({"ok":true,"taskId":id,"removedTaskId":null,"touched":[id]})
}
pub fn merge(b: &mut Value, v: &Value, host: Host) -> Value {
    let input = &v["input"];
    let id = text(&input["targetTaskId"]);
    let mut target = b["tasks"][id].clone();
    let err = |code: &str, task: Value| {
        let mut e = invalid(code);
        if !task.is_null() {
            e["taskId"] = task;
        }
        e
    };
    if target.is_null() {
        return err(
            "task_not_found",
            input
                .get("targetTaskId")
                .filter(|v| truth(v))
                .cloned()
                .unwrap_or(Value::Null),
        );
    }
    if truth(&target["mergedInto"]) {
        return invalid("target_already_merged");
    }
    if target["status"] == "archived" || truth(&target["deleting"]) {
        return invalid("target_not_mergeable");
    }
    let ids = unique(
        array(&input["sourceTaskIds"])
            .iter()
            .filter(|id| !clean(id, usize::MAX).is_empty())
            .map(|id| json!(clean(id, usize::MAX)))
            .collect(),
    );
    if ids.is_empty() || ids.len() > 100 {
        return invalid("invalid_merge_request");
    }
    let mut sources = vec![];
    let mut already = vec![];
    let to = if ["board", "session"].contains(&text(&target["origin"])) {
        target["origin"].clone()
    } else {
        origin(&target["id"])
    };
    for sid in ids {
        if sid == target["id"] {
            return err("invalid_merge_request", sid);
        }
        let s = b["tasks"][text(&sid)].clone();
        if s.is_null() {
            return err("task_not_found", sid);
        }
        if truth(&s["mergedInto"]) {
            if resolve(b, text(&sid))["id"] == target["id"] {
                already.push(sid);
                continue;
            }
            return err("source_already_merged", sid);
        }
        if s["status"] == "archived" || truth(&s["deleting"]) {
            return err("source_not_mergeable", sid);
        }
        let so = if ["board", "session"].contains(&text(&s["origin"])) {
            s["origin"].clone()
        } else {
            origin(&s["id"])
        };
        if so != to {
            return err("task_origin_mismatch", sid);
        }
        let td = dir(b, &target);
        let sd = dir(b, &s);
        if truth(&td) && truth(&sd) && td != sd {
            return err("task_directory_mismatch", sid);
        }
        sources.push(s);
    }
    let now = &input["now"];
    if sources.is_empty() {
        let mut touched = vec![target["id"].clone()];
        touched.extend(already.clone());
        return json!({"ok":true,"changed":false,"taskId":id,"mergedTaskIds":[],"alreadyMergedTaskIds":already,"touched":touched});
    }
    let root_ids = sources.iter().map(|s| s["id"].clone()).collect::<Vec<_>>();
    let mut merged = sources.clone();
    merged.extend(
        objects(&b["tasks"])
            .filter(|t| {
                truth(&t["mergedInto"]) && root_ids.contains(&resolve(b, text(&t["id"]))["id"])
            })
            .cloned(),
    );
    let mut all = array(&target["refs"]);
    for s in &sources {
        all.extend(array(&s["refs"]));
        areas(&mut target, &s["areas"], false);
    }
    all.sort_by(|a, b| num(&a["ts"]).total_cmp(&num(&b["ts"])));
    let mut accumulator = json!({"refs":[],"status":"active","updatedAt":0});
    for r in all {
        add_ref(&mut accumulator, &r, now, None);
    }
    let mut refs = array(&accumulator["refs"]);
    refs.sort_by(|a, b| num(&a["ts"]).total_cmp(&num(&b["ts"])));
    target["refs"] = json!(refs);
    let status = json!(if target["status"] == "done"
        && sources.iter().all(|t| t["status"] == "done")
    {
        "done"
    } else {
        "active"
    });
    target["status"] = status.clone();
    align(&mut target, &status, now, b);
    let created = std::iter::once(&target)
        .chain(sources.iter())
        .map(|t| num(&t["createdAt"]))
        .filter(|n| *n != 0.0)
        .reduce(f64::min);
    if let Some(c) = created {
        target["createdAt"] = json!(c);
    }
    target["updatedAt"] = now.clone();
    b["tasks"][id] = target;
    let mut touched = vec![json!(id)];
    for mut s in merged {
        let sid = text(&s["id"]).to_string();
        touched.push(json!(sid));
        s["mergedInto"] = json!(id);
        s["mergedAt"] = now.clone();
        s["status"] = json!("archived");
        s["updatedAt"] = now.clone();
        if s["moduleAssignment"]["running"] != true {
            s.as_object_mut().unwrap().shift_remove("moduleAssignment");
        }
        b["tasks"][sid] = s;
    }
    reconcile(b, host);
    touched.extend(already.clone());
    json!({"ok":true,"changed":true,"taskId":id,"mergedTaskIds":root_ids,"alreadyMergedTaskIds":already,"touched":touched})
}
/// 在借用的任务板上执行；只读 action 不会改写 `b`。
pub fn apply(b: &mut Value, v: &Value, host: Host) -> Value {
    let mut cursor = 0;
    let result = match text(&v["action"]) {
        "parseTagResult" => parse(&v["value"], false),
        "parseBackfillResult" => parse(&v["value"], true),
        "findTaskByTitle" => find_task(b, &v["moduleId"], &v["value"], &v["options"]),
        "createPendingTask" => pending(b, &v["input"], v, &mut cursor),
        "applyTaskClassification" => classify(b, v, &mut cursor),
        "applyTagResult" => apply_tags(
            b,
            &v["entries"],
            &v["ref"],
            &v["now"],
            &v["options"],
            v,
            &mut cursor,
        ),
        "mergeTasks" => merge(b, v, host),
        "applyBackfillResult" => {
            let mut touched = vec![];
            for (index, e) in array(&v["entries"]).iter().enumerate() {
                let supplied = if truth(&e["id"]) && e["id"] != "new" {
                    Some(text(&e["id"]).to_string())
                } else {
                    None
                };
                let refs = array(&e["turns"])
                    .iter()
                    .map(|n| &v["refByTurn"][wire(n)])
                    .filter(|r| r.is_object())
                    .map(|r| {
                        ["sessionId", "dirId", "userMsgId", "assistantMsgId"]
                            .map(|k| text(&r[k]))
                            .join("\u{1f}")
                    })
                    .collect::<Vec<_>>();
                let legacy = supplied.or_else(|| {
                    if refs.is_empty() {
                        None
                    } else {
                        Some(format!(
                            "tsk-legacy-{}",
                            &format!(
                                "{:x}",
                                Sha256::digest(
                                    format!("{index}\u{1e}{}", refs.join("\u{1d}")).as_bytes()
                                )
                            )[..24]
                        ))
                    }
                });
                let mut stable = e.clone();
                if let Some(id) = &legacy {
                    stable["id"] = json!(id);
                }
                for n in array(&e["turns"]) {
                    let r = &v["refByTurn"][wire(&n)];
                    if !r.is_object() {
                        continue;
                    }
                    let changed = apply_tags(
                        b,
                        &json!([stable]),
                        r,
                        &v["now"],
                        &json!({"newTaskId":legacy}),
                        v,
                        &mut cursor,
                    );
                    let ids = array(&changed);
                    touched.extend(ids.clone());
                    if (!truth(&stable["id"]) || stable["id"] == "new") && !ids.is_empty() {
                        stable["id"] = ids[0].clone();
                    }
                }
            }
            json!(unique(touched))
        }
        _ => Value::Null,
    };
    json!({"result":result})
}
pub fn run(v: &Value) -> Value {
    let facts = Facts::of(v);
    let mut b = v["board"].clone();
    let mut out = apply(&mut b, v, facts.host());
    let read =
        ["parseTagResult", "parseBackfillResult", "findTaskByTitle"].contains(&text(&v["action"]));
    out["board"] = if read { Value::Null } else { b };
    out
}
