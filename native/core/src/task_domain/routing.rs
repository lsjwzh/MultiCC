use super::*;
use super::{board::*, normalize::*};
use std::collections::BTreeMap;
use unicode_normalization::UnicodeNormalization;
const STOP: [&str; 29] = [
    "the", "and", "for", "with", "from", "this", "that", "into", "task", "session", "任务", "会话",
    "功能", "项目", "代码", "处理", "相关", "进行", "支持", "实现", "修复", "优化", "", "", "", "",
    "", "", "",
];
type Terms = BTreeMap<String, f64>;
pub fn terms(v: &Value) -> Vec<Value> {
    let s = slice(&text(v).nfkc().collect::<String>().to_lowercase(), 1200);
    let mut out = vec![];
    for c in re(r"[\p{Han}]+|[a-z0-9]+").find_iter(&s) {
        let c = c.as_str();
        let len = c.encode_utf16().count();
        if c.is_ascii() {
            if len >= 2 && !STOP.contains(&c) {
                out.push(json!(c));
            }
        } else {
            if (2..=16).contains(&len) && !STOP.contains(&c) {
                out.push(json!(c));
            }
            let chars = c.chars().collect::<Vec<_>>();
            for w in chars.windows(2) {
                let g = w.iter().collect::<String>();
                if !STOP.contains(&g.as_str()) {
                    out.push(json!(g));
                }
            }
        }
    }
    unique(out)
}
fn add(t: &mut Terms, v: &Value, w: f64) {
    for term in terms(v) {
        *t.entry(text(&term).into()).or_default() += w;
    }
}
fn context(v: &Value) -> Terms {
    let mut t = Terms::new();
    add(&mut t, &v["queryText"], 7.0);
    let task = &v["task"];
    if task.is_object() {
        add(&mut t, &task["title"], 6.0);
        for a in array(&task["areas"]) {
            add(&mut t, &a, 7.0);
        }
        add(
            &mut t,
            &v["board"]["modules"][text(&task["moduleId"])]["name"],
            5.0,
        );
    }
    t
}
fn profile(r: &Value) -> Terms {
    let mut t = Terms::new();
    for (k, w) in [("label", 7.0), ("rolePrompt", 5.0)] {
        add(&mut t, &r[k], w);
    }
    if r["agent"].is_string() {
        add(&mut t, &r["agent"], 6.0);
    } else {
        for k in ["name", "label", "role", "description"] {
            add(&mut t, &r["agent"][k], 6.0);
        }
    }
    for (k, w) in [("goal", 5.0), ("summary", 3.0), ("lastSummary", 3.0)] {
        add(&mut t, &r["taskState"][k], w);
    }
    t
}
fn score(context: &Terms, r: &Value) -> f64 {
    let p = profile(r);
    context
        .iter()
        .map(|(k, w)| *w * p.get(k).copied().unwrap_or(0.0))
        .sum()
}
fn from_entries(v: &Value) -> Terms {
    array(v)
        .into_iter()
        .map(|e| (text(&e[0]).to_string(), num(&e[1])))
        .collect()
}
fn entries(t: Terms) -> Value {
    json!(t
        .into_iter()
        .map(|(k, w)| json!([k, w]))
        .collect::<Vec<_>>())
}
pub fn routable(r: &Value) -> bool {
    r["kind"] == "chat"
        && !["aux", "gateway", "commander"].contains(&text(&r["type"]))
        && !truth(&r["ephemeral"])
}
pub fn available(r: &Value) -> bool {
    if r.is_null() || r["active"] == true || r["busy"] == true {
        return false;
    }
    let s = [&r["runState"], &r["status"], &r["taskState"]["runState"]]
        .into_iter()
        .find(|v| truth(v))
        .map(|v| text(v).to_lowercase())
        .unwrap_or_default();
    if [
        "active", "busy", "running", "thinking", "editing", "working", "starting",
    ]
    .contains(&s.as_str())
    {
        return false;
    }
    let letter = text(&r["taskState"]["classifyState"]).trim().to_uppercase();
    letter.is_empty() || ["D", "W"].contains(&letter.as_str())
}
pub fn run(v: &Value) -> Value {
    let action = text(&v["action"]);
    match action {
        "isRoutableRecord" => json!(routable(&v["record"])),
        "recordAppearsAvailable" => json!(available(&v["record"])),
        "routingTerms" => json!(terms(&v["value"])),
        "buildRoutingContext" => entries(context(v)),
        "buildSessionRoutingProfile" => entries(profile(&v["record"])),
        "routingRelevanceScore" => json!(score(&from_entries(&v["contextTerms"]), &v["record"])),
        "resolveDirectoryCommander" => {
            let d = clean(&v["dirId"], usize::MAX);
            if d.is_empty() {
                return json!({"ok":false,"code":"directory_required"});
            }
            let mut matches = array(&v["records"])
                .into_iter()
                .filter(|e| {
                    e[1]["kind"] == "chat"
                        && e[1]["type"] == "commander"
                        && !truth(&e[1]["ephemeral"])
                        && e[1]["dirId"] == d
                })
                .collect::<Vec<_>>();
            matches.sort_by(|a, b| text(&a[0]).cmp(text(&b[0])));
            if matches.is_empty() {
                json!({"ok":false,"code":"commander_not_found"})
            } else if matches.len() > 1 {
                json!({"ok":false,"code":"commander_ambiguous"})
            } else {
                json!({"ok":true,"sessionId":matches[0][0],"record":matches[0][1]})
            }
        }
        "rankRoutingCandidates" => {
            let ctx = from_entries(&v["contextTerms"]);
            let mut ranked = vec![];
            for e in array(&v["records"]) {
                let sid = &e[0];
                let r = &e[1];
                let avail = v["availability"]
                    .get(text(sid))
                    .map(|v| *v == true)
                    .unwrap_or_else(|| available(r));
                if !routable(r) || !avail || (truth(&v["dirId"]) && r["dirId"] != v["dirId"]) {
                    continue;
                }
                let s = score(&ctx, r)
                    + if array(&v["affinitySessionIds"]).contains(sid) {
                        24.0
                    } else {
                        0.0
                    };
                if s > 0.0 {
                    ranked.push(json!({"sid":sid,"score":s,"activity":v["activities"][text(sid)]}));
                }
            }
            ranked.sort_by(|a, b| {
                num(&b["score"])
                    .total_cmp(&num(&a["score"]))
                    .then_with(|| num(&b["activity"]).total_cmp(&num(&a["activity"])))
                    .then_with(|| text(&a["sid"]).cmp(text(&b["sid"])))
            });
            json!(ranked)
        }
        "messageText" => {
            let content = &v["message"]["content"];
            if content.is_string() {
                content.clone()
            } else {
                json!(array(content)
                    .iter()
                    .filter(|b| b["type"] == "text" && b["text"].is_string())
                    .map(|b| text(&b["text"]))
                    .collect::<Vec<_>>()
                    .join("\n"))
            }
        }
        "extractTaskMarker" => re(r"｜tb:([A-Za-z0-9_-]+)】")
            .captures(text(&v["value"]))
            .map(|c| json!(&c[1]))
            .unwrap_or(Value::Null),
        "buildRoutedMessage" | "buildCommanderRoutedMessage" => {
            let routed = format!(
                "【任务：{}】\n{}",
                text(&v["task"]["title"]),
                text(&v["value"])
            );
            json!(if action == "buildCommanderRoutedMessage" {
                format!("[Commander one-way routed task]\nThis execution task was delivered directly by the host router. Complete it in the current worker session; do not dispatch it again.\nThe result stays in the current worker and the task card; it is not fed back to the Commander automatically.\n\n{routed}")
            } else {
                routed
            })
        }
        _ => Value::Null,
    }
}
