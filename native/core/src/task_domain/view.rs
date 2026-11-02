use super::host::{Facts, Host};
use super::*;
use super::{board::*, normalize::*};
use std::collections::HashMap;
fn aggregate(ids: &[Value], facts: &Value) -> Value {
    let states = ids
        .iter()
        .map(|id| facts[text(id)]["runState"].clone())
        .filter(truth)
        .map(|s| {
            if s == "done" || s == "completed" {
                json!("succeeded")
            } else {
                s
            }
        })
        .collect::<Vec<_>>();
    for state in ["running", "queued", "waiting", "background", "error"] {
        if states.contains(&json!(state)) {
            return json!(state);
        }
    }
    json!(
        if !states.is_empty() && states.iter().all(|s| s == "succeeded") {
            "succeeded"
        } else {
            "idle"
        }
    )
}
pub fn apply(b: &Value, v: &Value, host: Host) -> Value {
    let facts = &v["facts"];
    let mut merged = HashMap::<String, usize>::new();
    for t in objects(&b["tasks"]) {
        if truth(&t["mergedInto"]) {
            let target = resolve(b, text(&t["id"]));
            if !target.is_null() {
                *merged.entry(text(&target["id"]).to_string()).or_default() += 1;
            }
        }
    }
    let mut group_by = HashMap::new();
    for g in values(&b["taskGroups"]) {
        for id in array(&g["taskIds"]) {
            group_by
                .entry(text(&id).to_string())
                .or_insert(g["id"].clone());
        }
    }
    let mut tasks = vec![];
    for t in objects(&b["tasks"]).filter(|t| !truth(&t["mergedInto"])) {
        let ids = unique(
            array(&t["refs"])
                .iter()
                .map(|r| r["sessionId"].clone())
                .collect(),
        );
        let routing = routing(&t["routing"]);
        let run_ids = run_ids(t);
        let has_turn =
            v["hasTurnPort"] != true || run_ids.iter().any(|id| facts[text(id)]["hasTurn"] == true);
        let mut state = if dead(t, has_turn, num(&v["now"])) {
            json!("idle")
        } else {
            let state = stale(t, &facts[text(&sole_id(t))]["runState"], num(&v["now"]));
            if !state.is_null() {
                state
            } else if [
                "queued",
                "running",
                "waiting",
                "background",
                "succeeded",
                "error",
                "idle",
            ]
            .contains(&text(&t["runState"]))
            {
                t["runState"].clone()
            } else if v["hasRunPort"] == true {
                aggregate(&run_ids, facts)
            } else {
                json!("idle")
            }
        };
        if state.is_null() {
            state = json!("idle");
        }
        let mut dirs = vec![t["dirId"].clone()];
        dirs.extend(array(&t["refs"]).iter().map(|r| r["dirId"].clone()));
        let assignment = if truth(&t["moduleAssignment"]) {
            let a = &t["moduleAssignment"];
            json!({"running":a["running"]==true,"attempts":num(&a["attempts"]),"lastAttemptAt":num(&a["lastAttemptAt"]),"lastError":error(&a["lastError"])})
        } else {
            Value::Null
        };
        let mut out = json!({"id":t["id"],"moduleId":t["moduleId"],"title":t["title"],"status":t["status"],"deleting":t["deleting"]==true,"areas":t["areas"],"refCount":array(&t["refs"]).len(),"sessionIds":ids,"dirIds":unique(dirs.into_iter().filter(truth).collect()),"lastTs":last(t),"createdAt":t["createdAt"],"taskGroupId":group_by.get(text(&t["id"])).cloned().unwrap_or(Value::Null),"mergedTaskCount":merged.get(text(&t["id"])).copied().unwrap_or(0),"origin":if ["board","session"].contains(&text(&t["origin"])){t["origin"].clone()}else{origin(&t["id"])} });
        let fields = planning::fields(t, host);
        for (k, val) in fields.as_object().unwrap() {
            out[k] = val.clone();
        }
        out["runState"] = state;
        out["moduleAssignment"] = assignment;
        out["attemptCount"] = json!(array(&routing["attempts"]).len());
        out["routing"] = routing;
        for k in ["worktreePath", "branch", "chatSessionId"] {
            out[k] = if t[k].is_string() {
                t[k].clone()
            } else {
                Value::Null
            };
        }
        tasks.push(out);
    }
    tasks.sort_by(|a, b| num(&b["lastTs"]).total_cmp(&num(&a["lastTs"])));
    let mut modules = vec![];
    for m in values(&b["modules"]) {
        let members = tasks
            .iter()
            .filter(|t| t["moduleId"] == m["id"])
            .collect::<Vec<_>>();
        let ts = members
            .iter()
            .map(|t| num(&t["lastTs"]))
            .fold(0.0, f64::max);
        modules.push(json!({"id":m["id"],"name":m["name"],"source":m["source"],"dirId":m["dirId"],"taskCount":members.len(),"lastTs":if ts!=0.0{ts}else{num(&m["updatedAt"])}}));
    }
    modules.sort_by(|a, b| num(&b["lastTs"]).total_cmp(&num(&a["lastTs"])));
    let mut groups = vec![];
    for g in values(&b["taskGroups"]) {
        let ids = array(&g["taskIds"])
            .into_iter()
            .filter(|id| tasks.iter().any(|t| t["id"] == *id))
            .collect::<Vec<_>>();
        if ids.len() < 2 {
            continue;
        }
        let root = if ids.contains(&g["rootTaskId"]) {
            g["rootTaskId"].clone()
        } else {
            ids[0].clone()
        };
        let title = tasks
            .iter()
            .find(|t| t["id"] == root)
            .map(|t| t["title"].clone())
            .unwrap_or(json!("关联任务"));
        let last = ids
            .iter()
            .map(|id| {
                tasks
                    .iter()
                    .find(|t| t["id"] == *id)
                    .map(|t| num(&t["lastTs"]))
                    .unwrap_or(0.0)
            })
            .fold(0.0, f64::max);
        groups.push(json!({"id":g["id"],"rootTaskId":root,"taskIds":ids,"title":title,"createdAt":num(&g["createdAt"]).max(0.0),"updatedAt":num(&g["updatedAt"]).max(0.0),"lastTs":last}));
    }
    groups.sort_by(|a, b| {
        num(&b["lastTs"])
            .total_cmp(&num(&a["lastTs"]))
            .then_with(|| host.compare(&a["id"], &b["id"]))
    });
    let revision = num(&b["revision"]);
    json!({"schemaVersion":2,"revision":if (0.0..=9007199254740991.0).contains(&revision)&&revision.fract()==0.0{revision}else{0.0},"modules":modules,"tasks":tasks,"taskGroups":groups})
}
pub fn run(v: &Value) -> Value {
    let facts = Facts::of(v);
    apply(&v["board"], v, facts.host())
}
