use super::board::*;
use super::host::{Facts, Host};
use super::*;
use regex::Regex;
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;
pub fn re(pattern: &str) -> Regex {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, Regex>>> =
        std::sync::OnceLock::new();
    let mut cache = CACHE.get_or_init(Default::default).lock().unwrap();
    cache
        .entry(pattern.into())
        .or_insert_with(|| Regex::new(pattern).unwrap())
        .clone()
}
pub fn name(v: &Value) -> String {
    text(v)
        .nfkc()
        .flat_map(char::to_lowercase)
        .filter(|c| c.is_alphanumeric())
        .collect()
}
const FAMILIES: [(&str, &[&str]); 9] = [
    (
        "建设",
        &[
            "实现", "设计", "开发", "构建", "新增", "添加", "接入", "集成", "支持",
        ],
    ),
    ("修复", &["修复", "解决", "排查", "诊断"]),
    (
        "优化",
        &[
            "优化", "完善", "改进", "重构", "升级", "更新", "改造", "切换",
        ],
    ),
    ("删除", &["删除", "清理", "移除", "废弃"]),
    ("恢复", &["恢复", "还原", "保留"]),
    ("启用", &["启用", "开启"]),
    ("停用", &["停用", "关闭", "禁用"]),
    ("验证", &["验证", "测试", "审计", "检查"]),
    ("研究", &["研究", "分析", "调研"]),
];
pub fn canonical(v: &Value) -> String {
    let mut key = name(v).replace(['的', '和', '与', '及'], "");
    for (f, words) in FAMILIES {
        if let Some(w) = words.iter().find(|w| key.starts_with(**w)) {
            key = format!("{f}{}", &key[w.len()..]);
            break;
        }
    }
    key
}
pub fn similarity(a: &Value, b: &Value) -> f64 {
    let a = canonical(a);
    let b = canonical(b);
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    if a == b {
        return 1.0;
    }
    let family = |s: &str| FAMILIES.iter().position(|(f, _)| s.starts_with(f));
    if let (Some(x), Some(y)) = (family(&a), family(&b)) {
        if x != y {
            return 0.0;
        }
    }
    let aa = a.encode_utf16().collect::<Vec<_>>();
    let bb = b.encode_utf16().collect::<Vec<_>>();
    let (short, long) = if aa.len() <= bb.len() {
        (&aa, &bb)
    } else {
        (&bb, &aa)
    };
    let ratio = short.len() as f64 / long.len() as f64;
    if short.len() >= 6 && ratio >= 0.72 && long.windows(short.len()).any(|w| w == short) {
        return ratio;
    }
    if aa.len() < 2 || bb.len() < 2 {
        return 0.0;
    }
    let mut used = vec![false; bb.len() - 1];
    let mut overlap = 0;
    for gram in aa.windows(2) {
        if let Some(i) = bb
            .windows(2)
            .enumerate()
            .position(|(i, g)| !used[i] && gram == g)
        {
            used[i] = true;
            overlap += 1;
        }
    }
    2.0 * overlap as f64 / (aa.len() + bb.len() - 2) as f64
}
pub fn origin(id: &Value) -> Value {
    json!(if re(r"^tsk-[0-9a-f]{32}$").is_match(text(id)) {
        "board"
    } else {
        "session"
    })
}
pub fn error(v: &Value) -> Value {
    let code = slice(text(v), 80);
    json!(
        if code.is_empty() || re(r"(?i)^[a-z0-9_:-]+$").is_match(&code) {
            code
        } else {
            "classification_failed".into()
        }
    )
}
pub fn title(v: &Value) -> String {
    let input = text(v).replace("\r\n", "\n").replace('\r', "\n");
    let header = re(r"^【任务[：:]\s*([^】|｜]+)(?:[|｜][^】]*)?】$");
    let mut declared = String::new();
    for line in input.lines() {
        if let Some(c) = header.captures(line.trim()) {
            let s = c[1].trim();
            if !s.is_empty() && s != "新任务" {
                declared = s.into();
            }
        }
    }
    if !declared.is_empty() {
        return slice(&declared, 40);
    }
    let bullet = re(r"^(?:#{1,6}|[-*+]|\d+[.)]|>)\s*");
    let skip = re(
        r"^(?:这是宿主路由器|请在当前 worker 会话|结果保留在当前 worker|不会自动回灌 Commander|This execution task was delivered directly by the host router|The result stays in the current worker)",
    );
    for line in input.lines() {
        let s = bullet.replace(line.trim(), "");
        let s = s.trim_matches(['"', '\'', '“', '”', '‘', '’']).trim();
        if s.is_empty()
            || re(r"^【[^】]+】$").is_match(s)
            || skip.is_match(s)
            || re(r"^(?:任务|新任务)\s*[:：]?\s*$").is_match(s)
        {
            continue;
        }
        return slice(s, 40);
    }
    String::from("新任务")
}
pub fn module_name(m: &Value) -> String {
    let n = clean(&m["name"], 20);
    let d = clean(&m["dirId"], usize::MAX);
    if m["source"] == "classify"
        && (n == "未分类"
            || (d.encode_utf16().count() >= 12
                && n.encode_utf16().count() >= 12
                && d.starts_with(&n)))
    {
        "待归类".into()
    } else {
        n
    }
}
pub fn find_module(b: &Value, n: &Value, d: &Value) -> Value {
    let key = name(n);
    if key.is_empty() {
        return Value::Null;
    }
    values(&b["modules"])
        .into_iter()
        .find(|m| (!truth(d) || !truth(&m["dirId"]) || m["dirId"] == *d) && name(&m["name"]) == key)
        .unwrap_or(Value::Null)
}
pub fn group_of(b: &Value, id: &str) -> Value {
    let t = resolve(b, id);
    if t.is_null() {
        return Value::Null;
    }
    values(&b["taskGroups"])
        .into_iter()
        .find(|g| array(&g["taskIds"]).contains(&t["id"]))
        .unwrap_or(Value::Null)
}
pub fn reconcile(b: &mut Value, host: Host) -> Value {
    let mut groups = values(&b["taskGroups"]);
    groups.retain(|g| re(r"^[A-Za-z0-9_-]{1,128}$").is_match(text(&g["id"])));
    groups.sort_by(|a, b| {
        num(&a["createdAt"])
            .total_cmp(&num(&b["createdAt"]))
            .then_with(|| host.compare(&a["id"], &b["id"]))
    });
    let mut clean = json!({});
    let mut owner = std::collections::HashMap::<String, String>::new();
    for raw in groups {
        let ids = unique(
            array(&raw["taskIds"])
                .iter()
                .map(|id| resolve(b, text(id))["id"].clone())
                .filter(truth)
                .collect(),
        )
        .into_iter()
        .take(100)
        .collect::<Vec<_>>();
        if ids.len() < 2 {
            continue;
        }
        let root = resolve(b, text(&raw["rootTaskId"]))["id"].clone();
        let overlap = unique(
            ids.iter()
                .filter_map(|id| owner.get(text(id)).map(|s| json!(s)))
                .collect(),
        );
        let mut g = overlap
            .first()
            .map(|id| clean[text(id)].clone())
            .unwrap_or(Value::Null);
        if g.is_null() {
            g = json!({"id":raw["id"],"rootTaskId":if ids.contains(&root){root}else{ids[0].clone()},"taskIds":[],"createdAt":num(&raw["createdAt"]).max(0.0),"updatedAt":num(&raw["updatedAt"]).max(0.0)});
        }
        let mut members = array(&g["taskIds"]);
        for secondary in overlap.iter().skip(1) {
            let s = &clean[text(secondary)];
            if s.is_null() {
                continue;
            }
            for id in array(&s["taskIds"]) {
                if !members.contains(&id) && members.len() < 100 {
                    members.push(id);
                }
            }
            g["createdAt"] = json!(num(&g["createdAt"]).min(num(&s["createdAt"])));
            g["updatedAt"] = json!(num(&g["updatedAt"]).max(num(&s["updatedAt"])));
            clean.as_object_mut().unwrap().shift_remove(text(secondary));
        }
        for id in ids {
            if !members.contains(&id) && members.len() < 100 {
                members.push(id);
            }
        }
        g["updatedAt"] = json!(num(&g["updatedAt"]).max(num(&raw["updatedAt"])));
        g["taskIds"] = json!(members);
        for id in array(&g["taskIds"]) {
            owner.insert(text(&id).into(), text(&g["id"]).into());
        }
        let id = text(&g["id"]).to_string();
        clean[id] = g;
    }
    b["taskGroups"] = clean.clone();
    clean
}
pub fn group(b: &mut Value, v: &Value, host: Host) -> Value {
    let t = resolve(b, text(&v["taskId"]));
    let r = resolve(b, text(&v["relatedTaskId"]));
    if t.is_null() || r.is_null() {
        return invalid("task_not_found");
    }
    if t["id"] == r["id"] {
        return invalid("same_task");
    }
    let td = dir(b, &t);
    let rd = dir(b, &r);
    if truth(&td) && truth(&rd) && td != rd {
        return invalid("task_directory_mismatch");
    }
    reconcile(b, host);
    let tg = group_of(b, text(&t["id"]));
    let rg = group_of(b, text(&r["id"]));
    if !tg.is_null() && tg["id"] == rg["id"] {
        return json!({"ok":true,"changed":false,"groupId":tg["id"],"taskIds":tg["taskIds"]});
    }
    let mut desired = array(&tg["taskIds"]);
    desired.extend(array(&rg["taskIds"]));
    desired.extend([t["id"].clone(), r["id"].clone()]);
    if unique(desired).len() > 100 {
        return invalid("task_group_full");
    }
    let mut g = if !rg.is_null() {
        rg.clone()
    } else {
        tg.clone()
    };
    if g.is_null() {
        let mut ids = [text(&t["id"]), text(&r["id"])];
        ids.sort();
        let h = format!("{:x}", Sha256::digest(ids.join("\u{1f}").as_bytes()));
        g = json!({"id":format!("grp-{}",&h[..24]),"rootTaskId":r["id"],"taskIds":[r["id"],t["id"]],"createdAt":v["now"],"updatedAt":v["now"]});
    } else {
        let mut ids = array(&g["taskIds"]);
        for id in [r["id"].clone(), t["id"].clone()] {
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
        g["taskIds"] = json!(ids);
        g["updatedAt"] = v["now"].clone();
    }
    if !rg.is_null() && !tg.is_null() && rg["id"] != tg["id"] {
        let mut ids = array(&g["taskIds"]);
        ids.extend(array(&tg["taskIds"]));
        g["taskIds"] = json!(unique(ids));
        g["createdAt"] = json!(num(&g["createdAt"]).min(num(&tg["createdAt"])));
        b["taskGroups"]
            .as_object_mut()
            .unwrap()
            .shift_remove(text(&tg["id"]));
    }
    let id = text(&g["id"]).to_string();
    b["taskGroups"][id] = g;
    reconcile(b, host);
    let g = group_of(b, text(&t["id"]));
    json!({"ok":true,"changed":true,"groupId":g["id"],"taskIds":g["taskIds"]})
}
pub fn empty() -> Value {
    json!({"schemaVersion":2,"revision":0,"modules":{},"tasks":{},"taskGroups":{},"deletedTaskIds":[]})
}
pub fn normalize(raw: &Value, host: Host) -> Value {
    let mut b = empty();
    b["deletedTaskIds"] = json!(unique(
        array(&raw["deletedTaskIds"])
            .into_iter()
            .filter(Value::is_string)
            .collect()
    ));
    let rev = num(&raw["revision"]);
    if (0.0..=9007199254740991.0).contains(&rev) && rev.fract() == 0.0 {
        b["revision"] = json!(rev);
    }
    if let Some(modules) = raw["modules"].as_object() {
        for (id, m) in modules {
            if !m["name"].is_string() || clean(&m["name"], usize::MAX).is_empty() {
                continue;
            }
            let mut module = json!({"id":id,"name":m["name"],"source":if ["directory","classify"].contains(&text(&m["source"])){text(&m["source"])}else{"ai"},"dirId":if m["dirId"].is_string(){m["dirId"].clone()}else{Value::Null},"createdAt":num(&m["createdAt"]),"updatedAt":num(&m["updatedAt"])});
            module["name"] = json!(module_name(&module));
            b["modules"][id] = module;
        }
    }
    if let Some(tasks) = raw["tasks"].as_object() {
        for (id, t) in tasks {
            if !t["title"].is_string() || clean(&t["title"], usize::MAX).is_empty() {
                continue;
            }
            let refs=array(&t["refs"]).iter().filter(|r|r["sessionId"].is_string()).map(|r|json!({"sessionId":r["sessionId"],"dirId":if r["dirId"].is_string(){r["dirId"].clone()}else{Value::Null},"userMsgId":if r["userMsgId"].is_string(){r["userMsgId"].clone()}else{Value::Null},"assistantMsgId":if r["assistantMsgId"].is_string(){r["assistantMsgId"].clone()}else{Value::Null},"ts":num(&r["ts"]),"excerpt":slice(text(&r["excerpt"]),200)})).collect::<Vec<_>>();
            let areas = array(&t["areas"])
                .iter()
                .filter(|a| !clean(a, usize::MAX).is_empty())
                .take(8)
                .map(|a| json!(clean(a, 80)))
                .collect::<Vec<_>>();
            let mut task = json!({"id":id,"moduleId":if t["moduleId"].is_string(){t["moduleId"].clone()}else{Value::Null},"title":clean(&t["title"],40),"status":if ["active","done","archived"].contains(&text(&t["status"])){text(&t["status"])}else{"active"},"deleting":t["deleting"]==true,"archivedFromStatus":if t["archivedFromStatus"]=="done"{"done"}else{"active"},"areas":areas,"createdAt":num(&t["createdAt"]),"updatedAt":num(&t["updatedAt"]),"refs":refs,"origin":if ["board","session"].contains(&text(&t["origin"])){t["origin"].clone()}else{origin(&json!(id))}});
            if t["titleSource"] == "manual" {
                task["titleSource"] = json!("manual");
            }
            for k in [
                "recordType",
                "dirId",
                "description",
                "workflowStage",
                "rank",
                "priority",
                "dueAt",
                "acceptanceCriteria",
                "planningRevision",
            ] {
                if let Some(v) = t.get(k) {
                    task[k] = v.clone();
                }
            }
            let d = dir(&b, &task);
            let options = json!({"origin":task["origin"],"dirId":d});
            planning::normalize_task(&mut task, &options, host);
            let state = if ["done", "completed"].contains(&text(&t["runState"])) {
                json!("succeeded")
            } else {
                t["runState"].clone()
            };
            if [
                "idle",
                "running",
                "queued",
                "waiting",
                "background",
                "error",
                "succeeded",
            ]
            .contains(&text(&state))
            {
                task["runState"] = state;
            }
            if num(&t["runStateAt"]) > 0.0 {
                task["runStateAt"] = json!(num(&t["runStateAt"]));
            }
            task = cards::attention(&json!({"action":"normalize","task":task,"source":t}))["task"]
                .clone();
            for (k, max) in [
                ("worktreePath", usize::MAX),
                ("branch", usize::MAX),
                ("chatSessionId", 160),
            ] {
                let s = clean(&t[k], max);
                if !s.is_empty() {
                    task[k] = json!(s);
                }
            }
            let merged = clean(&t["mergedInto"], 128);
            if !merged.is_empty() && merged != *id {
                task["mergedInto"] = json!(merged);
                task["mergedAt"] = json!(num(&t["mergedAt"]).max(0.0));
            }
            let assignment = if t["moduleAssignment"].is_object() {
                &t["moduleAssignment"]
            } else {
                &t["classification"]
            };
            if assignment.is_object()
                || b["modules"][text(&task["moduleId"])]["source"] == "classify"
            {
                let mut a = json!({"running":assignment["running"]==true||assignment["state"]=="running","attempts":num(&assignment["attempts"]).floor().max(0.0),"lastAttemptAt":num(&assignment["lastAttemptAt"]),"lastError":error(&assignment["lastError"])});
                if truth(&assignment["seed"]) && assignment["seed"].is_string() {
                    a["seed"] = json!(slice(text(&assignment["seed"]), 1200));
                }
                task["moduleAssignment"] = a;
            }
            let r = routing(&t["routing"]);
            if !r.is_null() {
                task["routing"] = r;
            }
            b["tasks"][id] = task;
        }
    }
    let ids = b["tasks"]
        .as_object()
        .map(|m| m.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    for key in ids {
        let mut t = b["tasks"][&key].clone();
        if !truth(&t["mergedInto"]) {
            continue;
        }
        if resolve(&b, text(&t["id"])).is_null() {
            t.as_object_mut().unwrap().shift_remove("mergedInto");
            t.as_object_mut().unwrap().shift_remove("mergedAt");
        } else {
            t["status"] = json!("archived");
        }
        let id = text(&t["id"]).to_string();
        b["tasks"][id] = t;
    }
    if let Some(groups) = raw["taskGroups"].as_object() {
        for (id, g) in groups {
            if !re(r"^[A-Za-z0-9_-]{1,128}$").is_match(id) || !g.is_object() {
                continue;
            }
            let ids = unique(
                array(&g["taskIds"])
                    .iter()
                    .filter(|id| !clean(id, usize::MAX).is_empty())
                    .map(|id| json!(clean(id, 128)))
                    .collect(),
            )
            .into_iter()
            .take(100)
            .collect::<Vec<_>>();
            b["taskGroups"][id] = json!({"id":id,"rootTaskId":clean(&g["rootTaskId"],128),"taskIds":ids,"createdAt":num(&g["createdAt"]).max(0.0),"updatedAt":num(&g["updatedAt"]).max(0.0)});
        }
    }
    reconcile(&mut b, host);
    b
}
/// 在借用的任务板上执行；只读 action 不会改写 `b`。
pub fn apply(b: &mut Value, v: &Value, host: Host) -> Value {
    let result = match text(&v["action"]) {
        "normalizeName" => json!(name(&v["value"])),
        "canonicalTaskTitle" => json!(canonical(&v["value"])),
        "taskTitleSimilarity" => json!(similarity(&v["a"], &v["b"])),
        "deriveTaskTitle" => json!(title(&v["value"])),
        "legacyTaskOrigin" => origin(&v["value"]),
        "taskOriginForSource" => json!(if ["task-board", "commander", "task-shell"]
            .contains(&text(&v["value"]))
        {
            "board"
        } else {
            "session"
        }),
        "safeClassificationError" => error(&v["value"]),
        "createEmptyBoard" => empty(),
        "normalizeModuleName" => json!(module_name(&v["value"])),
        "normalizeBoard" => normalize(&v["value"], host),
        "findModuleByName" => find_module(b, &v["value"], &v["dirId"]),
        "reconcileTaskGroups" => reconcile(b, host),
        "relatedTaskGroup" => group_of(b, text(&v["taskId"])),
        "groupRelatedTasks" => group(b, v, host),
        _ => Value::Null,
    };
    json!({"result":result})
}
pub fn run(v: &Value) -> Value {
    let facts = Facts::of(v);
    let mut b = v["board"].clone();
    let mut out = apply(&mut b, v, facts.host());
    let action = text(&v["action"]);
    out["board"] = if ["reconcileTaskGroups", "groupRelatedTasks"].contains(&action) {
        b
    } else {
        Value::Null
    };
    out
}
