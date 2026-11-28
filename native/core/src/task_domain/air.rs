//! Air 输入签名、可见集合与目录统计。
use super::board::{dir, unique};
use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use sha1::{Digest, Sha1};
use std::collections::{HashMap, HashSet};
fn digest(s: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha1::digest(s.as_bytes()))
}
pub fn run_on(b: &Value, v: &Value) -> Value {
    prepare(b, v, None)
}

/// The resident board already fingerprints each task when it is written.
#[derive(Default)]
pub struct Signatures(HashMap<String, (u64, String, String)>);

pub fn prepare(
    b: &Value,
    v: &Value,
    mut memo: Option<(&HashMap<String, u64>, &mut Signatures)>,
) -> Value {
    let records = &v["records"];
    let snapshot = &v["admission"];
    let mut owner = HashMap::new();
    let mut leases = HashMap::new();
    let mut lifecycle = json!({});
    let mut workspaces = HashMap::new();
    for (index, w) in snapshot["workspaces"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
    {
        if truth(&w["ownerId"]) {
            owner
                .entry(text(&w["ownerId"]).to_string())
                .or_insert((w, index));
        }
        workspaces.insert(text(&w["id"]), w);
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
    for (index, l) in snapshot["leases"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
    {
        leases
            .entry(text(&l["workspaceId"]).to_string())
            .or_insert((l, index));
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
    let mut paths: HashMap<String, HashSet<Value>> = HashMap::new();
    let mut note = |id: Value, path: Value| {
        if truth(&id) && truth(&path) {
            paths.entry(text(&id).to_string()).or_default().insert(path);
        }
    };
    for r in objects(records) {
        note(r["dirId"].clone(), r["worktreePath"].clone());
    }
    for t in objects(&b["tasks"]) {
        if !truth(&t["worktreePath"]) {
            continue;
        }
        let sid = if truth(&t["chatSessionId"]) {
            &t["chatSessionId"]
        } else {
            &t["sessionId"]
        };
        let d = dir(b, t);
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
    let visible = visible_refs(b, &v["shellTasks"]);
    let task_ids: Vec<_> = visible.iter().map(|t| text(&t["id"])).collect();
    let selected = v["ids"]
        .as_array()
        .map(|ids| ids.iter().filter_map(Value::as_str).collect::<HashSet<_>>());
    let tasks: Vec<_> = visible
        .iter()
        .copied()
        .filter(|t| {
            selected
                .as_ref()
                .is_none_or(|ids| ids.contains(text(&t["id"])))
        })
        .collect();
    let mut resources = json!({});
    if let Some((hashes, signatures)) = &mut memo {
        signatures.0.retain(|id, _| hashes.contains_key(id));
    }
    let mut signatures = json!({});
    let mut task_dirs = json!({});
    let mut signature_builds = 0;
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
        let workspace = owner.get(if truth(own) { text(own) } else { text(&sid) });
        let w = workspace.map_or(&Value::Null, |(row, _)| *row);
        let lease = leases.get(text(&w["id"]));
        let l = lease.map_or(&Value::Null, |(row, _)| *row);
        if v["resourceIndex"] == true {
            resources[text(&t["id"])] = json!([workspace.map(|(_, i)| i), lease.map(|(_, i)| i)]);
        }
        let mut s = String::new();
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
        let id = text(&t["id"]);
        let signature = if let Some((hashes, cache)) = &mut memo {
            let stamp = hashes.get(id).copied();
            if let Some((_, _, sig)) = cache
                .0
                .get(id)
                .filter(|(old, facts, _)| Some(*old) == stamp && facts == &s)
            {
                sig.clone()
            } else {
                signature_builds += 1;
                let sig = digest(&(wire(t) + &s));
                if let Some(stamp) = stamp {
                    cache.0.insert(id.to_owned(), (stamp, s, sig.clone()));
                }
                sig
            }
        } else {
            signature_builds += 1;
            digest(&(wire(t) + &s))
        };
        signatures[id] = json!(signature);
    }
    // 任务仓储的依赖已逐卡并入签名（宿主把批量算出的权限结果拼进每卡签名），这里
    // 只剩任务板级的模块/分组；cacheable=false（缓存关闭）时放弃缓存。
    let global = if v["cacheable"] == false {
        Value::Null
    } else {
        json!(digest(&wire(&json!([
            b.get("modules").cloned().unwrap_or(Value::Null),
            b.get("taskGroups").cloned().unwrap_or(Value::Null)
        ]))))
    };
    let mut result = json!({"tasks":tasks,"taskIds":task_ids,"taskDirs":task_dirs,"signatures":signatures,"globalSignature":global,"lifecycle":lifecycle,"worktreeCounts":worktree_counts});
    if v["resourceIndex"] == true {
        result["resourceIndex"] = resources;
        result["signatureBuilds"] = json!(signature_builds);
    }
    result
}
pub fn run(v: &Value) -> Value {
    run_on(&v["board"], v)
}

/// Bulk archive uses the newest known activity. Old board files used both
/// ts and timestamp for references; a missing date cannot prove inactivity.
pub fn inactive_done(board: &Value, command: &Value) -> Value {
    const MONTH_MS: f64 = 30. * 24. * 60. * 60. * 1000.;
    let cutoff = num(&command["now"]) - MONTH_MS;
    let busy_sessions: HashSet<_> = command["busySessions"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    let busy_tasks: HashSet<_> = command["busyTasks"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(|id| {
            board::resolve(board, id)["id"]
                .as_str()
                .unwrap_or(id)
                .to_owned()
        })
        .collect();
    let ids: Vec<_> = visible_refs(board, &command["shellTasks"])
        .into_iter()
        .filter(|task| {
            task["status"] == "done"
                && !truth(&task["deleting"])
                && !truth(&task["mergedInto"])
                && !busy_tasks.contains(text(&task["id"]))
        })
        .filter(|task| {
            let date = |v: &Value| {
                num(v).max(
                    v.as_str()
                        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                        .map_or(0., |d| d.timestamp_millis() as f64),
                )
            };
            let mut at = ["createdAt", "updatedAt", "lastMessageAt", "seenAt"]
                .iter()
                .map(|k| date(&task[k]))
                .fold(0., f64::max);
            at = at.max(date(&task["attention"]["at"]));
            let sessions = [
                &task["sessionId"],
                &task["chatSessionId"],
                &task["routing"]["workerSessionId"],
            ]
            .into_iter()
            .chain(
                task["refs"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|r| &r["sessionId"]),
            )
            .filter_map(Value::as_str);
            for id in sessions {
                if busy_sessions.contains(id) {
                    return false;
                }
                at = at.max(date(&command["activity"][id]));
            }
            for r in task["refs"].as_array().into_iter().flatten() {
                at = at.max(date(&r["ts"])).max(date(&r["timestamp"]));
            }
            at > 0. && at <= cutoff
        })
        .map(|t| &t["id"])
        .collect();
    json!(ids)
}

pub fn visible(b: &Value, shell: &Value) -> Vec<Value> {
    visible_refs(b, shell).into_iter().cloned().collect()
}
fn visible_refs<'a>(b: &'a Value, shell: &Value) -> Vec<&'a Value> {
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
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dirty_card_does_not_rehash_its_neighbors() {
        let mut board =
            json!({"tasks":{"a":{"id":"a","title":"first","chatSessionId":"s"},"b":{"id":"b"}}});
        let mut hashes = HashMap::from([("a".into(), 1), ("b".into(), 2)]);
        let mut memo = Signatures::default();
        let mut cmd = json!({"resourceIndex":true,"admission":{},"records":{"s":{"id":"s"}}});
        let before = prepare(&board, &cmd, Some((&hashes, &mut memo)));
        assert_eq!(before["signatureBuilds"], 2);
        board["tasks"]["a"]["title"] = json!("changed");
        hashes.insert("a".into(), 3);
        cmd["ids"] = json!(["a"]);
        let delta = prepare(&board, &cmd, Some((&hashes, &mut memo)));
        assert_eq!(delta["signatureBuilds"], 1);
        assert_eq!(delta["tasks"].as_array().unwrap().len(), 1);
        assert_eq!(delta["taskIds"], json!(["a", "b"]));
        cmd.as_object_mut().unwrap().remove("ids");
        assert_eq!(
            prepare(&board, &cmd, Some((&hashes, &mut memo)))["signatureBuilds"],
            0
        );
        cmd["records"]["s"]["cli"] = json!("changed");
        assert_eq!(
            prepare(&board, &cmd, Some((&hashes, &mut memo)))["signatureBuilds"],
            1
        );
    }
    #[test]
    fn archived_planned_task_survives_reload_and_restores_to_done() {
        let mut board = json!({"tasks":{"a":{"id":"a","title":"old","recordType":"planned",
            "status":"done","workflowStage":"done","updatedAt":1}}});
        let action = |op| json!({"action":"lifecycle","taskId":"a","operation":op,"now":2});
        board::apply(&mut board, &action("archive")).unwrap();
        let mut reloaded = normalize::normalize(&board, host::Facts::default().host());
        assert_eq!(reloaded["tasks"]["a"]["status"], "archived");
        assert_eq!(reloaded["tasks"]["a"]["workflowStage"], "done");
        board::apply(&mut reloaded, &action("restore")).unwrap();
        assert_eq!(reloaded["tasks"]["a"]["status"], "done");
    }

    #[test]
    fn archive_requires_positive_old_activity_and_done() {
        let board = json!({"tasks":{
            "a":{"id":"a","status":"done","updatedAt":10},
            "b":{"id":"b","status":"done","updatedAt":1,"refs":[{"timestamp":11}]},
            "c":{"id":"c","status":"active","updatedAt":1},
            "d":{"id":"d","status":"done"},
            "e":{"id":"e","status":"done","createdAt":1},
            "f":{"id":"f","status":"archived","updatedAt":1}},
            "deletedTaskIds":["e"]});
        assert_eq!(
            inactive_done(&board, &json!({"now":2592000010i64})),
            json!(["a"])
        );
    }
}
