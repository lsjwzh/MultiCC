//! Air 输入签名、可见集合与目录统计。
use super::board::{dir, unique, values};
use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use sha1::{Digest, Sha1};
use std::collections::{HashMap, HashSet};
fn digest(s: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha1::digest(s.as_bytes()))
}
pub fn run_on(b: &Value, v: &Value) -> Value {
    let records = &v["records"];
    let snapshot = &v["admission"];
    let mut owner = HashMap::new();
    let mut leases = HashMap::new();
    let mut lifecycle = json!({});
    let mut workspaces = HashMap::new();
    for w in array(&snapshot["workspaces"]) {
        if truth(&w["ownerId"]) {
            owner
                .entry(text(&w["ownerId"]).to_string())
                .or_insert(w.clone());
        }
        workspaces.insert(text(&w["id"]).to_string(), w.clone());
        if truth(&w["dirId"]) {
            let id = text(&w["dirId"]);
            if lifecycle[id].is_null() {
                lifecycle[id] =
                    json!({"resident":0,"retained":0,"hibernated":0,"planned":0,"leased":0});
            }
            let residency =
                if ["resident", "retained", "hibernated"].contains(&text(&w["residency"])) {
                    text(&w["residency"])
                } else {
                    "planned"
                };
            lifecycle[id][residency] = json!(num(&lifecycle[id][residency]) + 1.0);
        }
    }
    for l in array(&snapshot["leases"]) {
        leases
            .entry(text(&l["workspaceId"]).to_string())
            .or_insert(l.clone());
        if let Some(w) = workspaces.get(text(&l["workspaceId"])) {
            let id = text(&w["dirId"]);
            if lifecycle[id].is_object() {
                lifecycle[id]["leased"] = json!(num(&lifecycle[id]["leased"]) + 1.0);
            }
        }
    }
    for bucket in lifecycle.as_object_mut().unwrap().values_mut() {
        bucket["onDisk"] = json!(num(&bucket["resident"]) + num(&bucket["retained"]));
        bucket["total"] =
            json!(num(&bucket["onDisk"]) + num(&bucket["hibernated"]) + num(&bucket["planned"]));
    }
    let mut paths: HashMap<String, Vec<Value>> = HashMap::new();
    let mut note = |id: Value, path: Value| {
        if truth(&id) && truth(&path) {
            let p = paths.entry(text(&id).to_string()).or_default();
            if !p.contains(&path) {
                p.push(path);
            }
        }
    };
    for r in values(records) {
        note(r["dirId"].clone(), r["worktreePath"].clone());
    }
    for t in objects(&b["tasks"]) {
        let sid = if truth(&t["chatSessionId"]) {
            &t["chatSessionId"]
        } else {
            &t["sessionId"]
        };
        let d = dir(b, &t);
        note(
            if truth(&d) {
                d
            } else {
                records[text(sid)]["dirId"].clone()
            },
            t["worktreePath"].clone(),
        );
    }
    let worktree_counts: HashMap<_, _> = paths.into_iter().map(|(k, v)| (k, v.len())).collect();
    let tasks = visible(b, &v["shellTasks"]);
    let mut signatures = json!({});
    let mut task_dirs = json!({});
    for t in &tasks {
        let sid = if truth(&t["chatSessionId"]) {
            t["chatSessionId"].clone()
        } else if truth(&t["sessionId"]) {
            t["sessionId"].clone()
        } else {
            Value::Null
        };
        let d = dir(b, t);
        if truth(&d) {
            task_dirs[text(&t["id"])] = d;
        } else if let Some(d) = records[text(&sid)].get("dirId") {
            task_dirs[text(&t["id"])] = d.clone();
        }
        let mut ids = vec![
            sid.clone(),
            t.get("sessionId").cloned().unwrap_or(json!("undefined")),
            t.get("chatSessionId")
                .cloned()
                .unwrap_or(json!("undefined")),
        ];
        ids.extend(
            array(&t["refs"])
                .iter()
                .map(|r| r.get("sessionId").cloned().unwrap_or(json!("undefined"))),
        );
        let own = &records[text(&sid)]["workspaceOwnerSessionId"];
        if truth(own) {
            ids.push(own.clone());
        }
        let w = owner
            .get(if truth(own) { text(own) } else { text(&sid) })
            .cloned()
            .unwrap_or(Value::Null);
        let l = leases.get(text(&w["id"])).cloned().unwrap_or(Value::Null);
        let mut s = wire(t);
        for id in unique(ids) {
            let r = &records[text(&id)];
            let projection = if r.is_null() {
                Value::Null
            } else {
                json!([
                    r["id"],
                    r["dirId"],
                    r["kind"],
                    r["type"],
                    r["cli"],
                    r["provider"],
                    r["providerName"],
                    r["worktreePath"],
                    r["branch"],
                    r["workspaceOwnerSessionId"],
                    r["workspaceState"],
                    r["taskBoundTaskId"],
                    r["taskExecutionSlot"],
                    r["experimentalMode"],
                    r["taskState"]["goalState"]
                ])
            };
            let label = if id.is_null() { "null" } else { text(&id) };
            s.push_str(&format!("\n{label}={}", wire(&projection)));
        }
        s.push_str(&format!("\n{}", wire(&json!([w, l]))));
        signatures[text(&t["id"])] = json!(digest(&s));
    }
    let global = if v["epoch"].is_null() {
        Value::Null
    } else {
        json!(digest(&wire(&json!([
            v["epoch"],
            b.get("modules").cloned().unwrap_or(Value::Null),
            b.get("taskGroups").cloned().unwrap_or(Value::Null)
        ]))))
    };
    json!({"tasks":tasks,"taskIds":tasks.iter().map(|t|t["id"].clone()).collect::<Vec<_>>(),"taskDirs":task_dirs,"signatures":signatures,"globalSignature":global,"lifecycle":lifecycle,"worktreeCounts":worktree_counts})
}
pub fn run(v: &Value) -> Value {
    run_on(&v["board"], v)
}

pub fn visible(b: &Value, shell: &Value) -> Vec<Value> {
    let hidden = shell
        .as_array()
        .into_iter()
        .flatten()
        .filter(|t| {
            t["embedded"] == true || (truth(&t["separatedFromTaskId"]) && !truth(&t["ready"]))
        })
        .filter_map(|t| t["id"].as_str())
        .collect::<HashSet<_>>();
    let deleted = b["deletedTaskIds"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect::<HashSet<_>>();
    objects(&b["tasks"])
        .filter(|t| {
            !truth(&t["mergedIntoTaskId"])
                && !deleted.contains(text(&t["id"]))
                && !hidden.contains(text(&t["id"]))
        })
        .cloned()
        .collect()
}
