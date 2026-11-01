use super::host::{Facts, Host};
use super::*;
pub fn interaction(t: &Value, record: &Value) -> f64 {
    let refs = array(&t["refs"])
        .into_iter()
        .filter(|r| {
            r["sessionId"] == record["id"]
                && (truth(&r["userMsgId"]) || truth(&r["assistantMsgId"]))
        })
        .collect::<Vec<_>>();
    if refs.is_empty() {
        return 0.0;
    }
    let latest = refs
        .iter()
        .map(|r| num(&r["timestamp"]))
        .fold(0.0, f64::max);
    if latest > 0.0 {
        latest
    } else {
        num(&record["lastWorkTimestamp"])
    }
}
pub fn apply(b: &Value, v: &Value, host: Host) -> Value {
    let mut out = vec![];
    for s in array(&v["shellTasks"]) {
        let t = &b["tasks"][text(&s["id"])];
        let f = &v["facts"][text(&s["id"])];
        if s["dirId"] != v["dirId"]
            || !truth(&s["ready"])
            || array(&v["excludedIds"]).contains(&s["id"])
        {
            continue;
        }
        if t.is_null()
            || f["dirId"] != v["dirId"]
            || truth(&t["deleting"])
            || truth(&t["mergedIntoTaskId"])
            || !(t["status"] == "done"
                || (t["status"] == "archived" && t["archivedFromStatus"] == "done"))
        {
            continue;
        }
        let lineage = array(&f["lineage"]);
        if lineage.len() != 1 || lineage.iter().any(|id| array(&v["pinnedIds"]).contains(id)) {
            continue;
        }
        let r = &f["record"];
        if r.is_null()
            || r["taskBoundTaskId"] != t["id"]
            || r["dirId"] != v["dirId"]
            || truth(&r["workspaceOwnerSessionId"])
        {
            continue;
        }
        if !truth(&f["runState"])
            || ["queued", "running", "waiting", "background"].contains(&text(&f["runState"]))
            || f["busy"] == true
        {
            continue;
        }
        let at = num(&f["lastInteraction"]);
        if at > 0.0 {
            out.push(json!({"id":t["id"],"sessionId":r["id"],"at":at}));
        }
    }
    out.sort_by(|a, b| {
        num(&a["at"])
            .total_cmp(&num(&b["at"]))
            .then_with(|| host.compare(&a["id"], &b["id"]))
    });
    json!(out)
}
pub fn run(v: &Value) -> Value {
    let facts = Facts::of(v);
    apply(&v["board"], v, facts.host())
}
