//! 上下文记录的生命周期。一轮的选材计划提交后压成 v2：每条注入的资料（正文连同全部
//! 元数据）按内容哈希在任务的目录（context-source）里只存一份，计划里只留引用；沿用
//! 清单只存目录键；「与本轮无关」只记数量。每个任务只保留最近 DETAIL_TURNS 轮的选材
//! 明细，更早的只留实际注入了哪些资料（id 与版本）和预算。
//!
//! 目录里必须保留的：窗口内各轮注入与沿用的资料、台账里的资料（以后的轮次会沿用它们）、
//! 进行中那一轮沿用的资料。其余随整理回收。运行时提交（contextCommitted）与 v1→v2
//! 迁移遵守同一条规则。
use super::*;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

pub const DETAIL_TURNS: usize = 20;
// 只在挑选时有用的字段，不进目录。
const SELECTION_ONLY: [&str; 4] = ["label", "priority", "dedupeText", "maxTokens"];
// 与旧 JS tracePlan 相同的对外字段及顺序。
const TRACE_KEYS: [&str; 14] = [
    "id",
    "version",
    "mode",
    "taskId",
    "taskName",
    "path",
    "scope",
    "skill",
    "snapshotId",
    "estimatedTokens",
    "truncated",
    "reason",
    "via",
    "messageCount",
];
// 沿用清单条目的字段（准备阶段写下的形状）；mode/taskName 取自当轮清单，可能与目录不同。
const RETAINED_KEYS: [&str; 4] = ["id", "version", "mode", "taskName"];
const RETAINED_DELTA: [&str; 2] = ["mode", "taskName"];

fn stored(s: &Value) -> Value {
    let mut v = s.clone();
    if let Some(o) = v.as_object_mut() {
        for k in SELECTION_ONLY {
            o.shift_remove(k);
        }
    }
    v
}
// 目录键覆盖正文与全部元数据：同一份正文以不同元数据注入就是不同条目，还原逐字节一致。
fn source_key(s: &Value) -> String {
    format!("{:x}", Sha256::digest(stored(s).to_string().as_bytes()))[..24].to_string()
}
fn catalog_id(task: &str, key: &str) -> String {
    format!("{task}:{key}")
}
fn same(s: &Value, r: &Value) -> bool {
    s["id"] == r["id"] && s["version"] == r["version"]
}
fn triple(receipt: &str, s: &Value) -> (String, String, String) {
    (receipt.to_string(), s["id"].to_string(), s["version"].to_string())
}
fn trace_source(s: &Value, retained: bool, include: bool) -> Value {
    let mut out = serde_json::Map::new();
    out.insert("retained".into(), json!(retained));
    for k in TRACE_KEYS {
        if let Some(v) = s.get(k) {
            out.insert(k.into(), v.clone());
        }
    }
    if include {
        if let Some(v) = s.get("excerpt") {
            out.insert("excerpt".into(), v.clone());
        }
    }
    Value::Object(out)
}
// 已降级的轮次：只有注入了哪些资料。
fn bare(r: &Value) -> Value {
    json!({"retained":false,"id":r["id"],"version":r["version"]})
}
fn demote(plan: &Value) -> Value {
    let mut out = plan.clone();
    out["detail"] = Value::Null;
    out["detailExpired"] = json!(true);
    out
}
fn retained_entry(content: &Value, e: &Value) -> Value {
    let absent = items(&e["absent"]);
    let mut out = serde_json::Map::new();
    for k in RETAINED_KEYS {
        if absent.iter().any(|a| a == k) {
            continue;
        }
        if let Some(v) = e.get(k).or_else(|| content.get(k)) {
            out.insert(k.into(), v.clone());
        }
    }
    out.insert("receiptId".into(), e["receiptId"].clone());
    Value::Object(out)
}
type Resolved = Option<(String, Value)>;
impl TaskStore {
    fn catalog_source(&self, task: &str, key: &str) -> Result<Value> {
        Ok(self.get("context-source", &catalog_id(task, key))?["source"].clone())
    }
    fn ensure_catalog(&mut self, task: &str, key: &str, content: &Value) -> Result<()> {
        let id = catalog_id(task, key);
        if self.body("context-source", &id)?.is_none() {
            self.put("context-source", &id, &json!({"taskId":task,"key":key,"source":content}))?;
        }
        Ok(())
    }
    // 沿用条目指向的那次注入（旧逻辑：按 receiptId 找原收据，再按 id+版本找来源）。
    fn origin(&self, task: &str, r: &Value) -> Result<Resolved> {
        let receipt = self.get("receipt", text(&r["receiptId"]))?;
        let plan = &receipt["contextPlan"];
        let Some(s) = items(&plan["sources"]).iter().find(|s| same(s, r)) else {
            return Ok(None);
        };
        if plan["format"] != 2 {
            return Ok(Some((source_key(s), stored(s))));
        }
        let key = text(&s["key"]).to_string();
        for owner in [task, text(&receipt["taskId"])] {
            let content = self.catalog_source(owner, &key)?;
            if content.is_object() {
                return Ok(Some((key, content)));
            }
        }
        Ok(None)
    }
    fn resolve_retained(&self, task: &str, plan: &Value) -> Result<Vec<Resolved>> {
        let mut out = vec![];
        for r in items(&plan["retained"]) {
            if let Some(k) = r["key"].as_str() {
                let content = self.catalog_source(task, k)?;
                if content.is_object() {
                    out.push(Some((k.to_string(), content)));
                    continue;
                }
            }
            out.push(self.origin(task, r)?);
        }
        Ok(out)
    }
    // 完整计划 → v2。detail=false 时不写目录、不留明细（窗口外直接降级）。
    pub(super) fn compact_plan(
        &mut self,
        task: &str,
        plan: &Value,
        detail: bool,
        resolved: &[Resolved],
    ) -> Result<Value> {
        if plan["format"] == 2 {
            return Ok(if detail { plan.clone() } else { demote(plan) });
        }
        let mut refs = vec![];
        for s in items(&plan["sources"]) {
            let key = source_key(s);
            if detail {
                self.ensure_catalog(task, &key, &stored(s))?;
            }
            refs.push(json!({"key":key,"id":s["id"],"version":s["version"]}));
        }
        let mut counts = serde_json::Map::new();
        let mut omitted = vec![];
        for o in items(&plan["omitted"]) {
            let reason = o["reason"].as_str().unwrap_or("unknown");
            let n = counts.get(reason).and_then(Value::as_u64).unwrap_or(0);
            counts.insert(reason.into(), json!(n + 1));
            if detail && reason != "not_relevant" {
                omitted.push(json!({"id":o["id"],"reason":o["reason"]}));
            }
        }
        let mut out = json!({"format":2});
        for k in [
            "turnId",
            "status",
            "initial",
            "generation",
            "cli",
            "roleEpoch",
            "budget",
            "removed",
            "diagnostics",
        ] {
            if let Some(v) = plan.get(k) {
                out[k] = v.clone();
            }
        }
        out["sources"] = json!(refs);
        out["retainedCount"] = json!(items(&plan["retained"]).len());
        out["omittedCounts"] = Value::Object(counts);
        if !detail {
            return Ok(demote(&out));
        }
        let mut retained = vec![];
        for (i, r) in items(&plan["retained"]).iter().enumerate() {
            let Some((key, content)) = resolved.get(i).cloned().flatten() else {
                // 原注入找不到：清单条目原样留下（来源行旧逻辑里同样不出）。
                let mut e = r.clone();
                if let Some(o) = e.as_object_mut() {
                    o.shift_remove("key");
                }
                retained.push(e);
                continue;
            };
            self.ensure_catalog(task, &key, &content)?;
            let mut e = json!({"key":key,"receiptId":r["receiptId"]});
            let mut absent = vec![];
            for f in RETAINED_DELTA {
                match (r.get(f), content.get(f)) {
                    (Some(a), Some(b)) if a == b => {}
                    (Some(a), _) => e[f] = a.clone(),
                    (None, Some(_)) => absent.push(json!(f)),
                    (None, None) => {}
                }
            }
            if !absent.is_empty() {
                e["absent"] = json!(absent);
            }
            retained.push(e);
        }
        out["detail"] = json!({"retained":retained,"omitted":omitted});
        Ok(out)
    }
    // 整理一个任务：current 是刚提交的那一轮。比它新的未提交计划是进行中的轮次，原样
    // 保留；比它旧的未提交计划不会再提交，压缩；窗口外的降级；回收没人引用的目录项。
    pub(super) fn finalize_context(&mut self, task: &str, current: &str) -> Result<Value> {
        let ids = self.ids_where(
            "SELECT id FROM shell_records WHERE kind='receipt' AND task_ref=?1 ORDER BY rowid DESC",
            &[&task],
        )?;
        let mut keep = HashSet::new();
        let (mut seen, mut compacted, mut demoted) = (0, 0, 0);
        let mut newer = true;
        for id in ids {
            if id == current {
                newer = false;
            }
            let mut receipt = self.get("receipt", &id)?;
            if !receipt["contextPlan"].is_object() {
                continue;
            }
            seen += 1;
            let plan = receipt["contextPlan"].clone();
            if seen > DETAIL_TURNS {
                if plan["format"] == 2 && plan["detail"].is_null() {
                    break; // 更早的在之前的提交里已整理过
                }
                receipt["contextPlan"] = self.compact_plan(task, &plan, false, &[])?;
                self.put("receipt", &id, &receipt)?;
                demoted += 1;
                continue;
            }
            if plan["format"] != 2 {
                let resolved = self.resolve_retained(task, &plan)?;
                if newer {
                    keep.extend(resolved.into_iter().flatten().map(|(k, _)| k));
                    continue;
                }
                receipt["contextPlan"] = self.compact_plan(task, &plan, true, &resolved)?;
                self.put("receipt", &id, &receipt)?;
                compacted += 1;
            }
            let plan = &receipt["contextPlan"];
            for r in items(&plan["sources"]) {
                keep.insert(text(&r["key"]).to_string());
            }
            for e in items(&plan["detail"]["retained"]) {
                if let Some(k) = e["key"].as_str() {
                    keep.insert(k.to_string());
                }
            }
        }
        let mut ledger = self.get("context-ledger", task)?;
        let mut found = vec![];
        for (id, entry) in ledger["sources"].as_object().into_iter().flatten() {
            if entry["key"].as_str().is_none() {
                let probe = json!({"id":id,"version":entry["version"],"receiptId":entry["receiptId"]});
                if let Some(hit) = self.origin(task, &probe)? {
                    found.push((id.clone(), hit));
                }
            }
        }
        let changed = !found.is_empty();
        for (id, (key, content)) in found {
            self.ensure_catalog(task, &key, &content)?;
            ledger["sources"][&id]["key"] = json!(key);
        }
        for entry in ledger["sources"].as_object().into_iter().flat_map(|o| o.values()) {
            if let Some(k) = entry["key"].as_str() {
                keep.insert(k.to_string());
            }
        }
        if changed {
            self.put("context-ledger", task, &ledger)?;
        }
        let prefix = format!("{task}:");
        let mut collected = 0;
        for id in self.ids_where(
            "SELECT id FROM shell_records WHERE kind='context-source' AND task_ref=?1",
            &[&task],
        )? {
            if !keep.contains(id.strip_prefix(&prefix).unwrap_or(&id)) {
                self.remove("context-source", &id)?;
                collected += 1;
            }
        }
        Ok(json!({"compacted":compacted,"demoted":demoted,"collected":collected}))
    }
    pub(super) fn context_committed(&mut self, task: &str, receipt_id: &str) -> Result<Value> {
        self.atomic(|s| {
            let mut receipt = s.get("receipt", receipt_id)?;
            if receipt["taskId"] != task || !receipt["contextPlan"].is_object() {
                return Ok(Value::Null);
            }
            if receipt["contextPlan"]["format"] != 2 {
                let plan = receipt["contextPlan"].clone();
                let resolved = s.resolve_retained(task, &plan)?;
                receipt["contextPlan"] = s.compact_plan(task, &plan, true, &resolved)?;
                s.put("receipt", receipt_id, &receipt)?;
            }
            s.finalize_context(task, receipt_id)
        })
    }
    // 引用来源面板的数据。完整计划（进行中）与 v2 紧凑计划给出同一形状。
    pub(super) fn context_trace(&self, receipt_id: &str, include: bool) -> Result<Value> {
        let receipt = self.get("receipt", receipt_id)?;
        let plan = &receipt["contextPlan"];
        if !plan.is_object() {
            return Ok(Value::Null);
        }
        let task = text(&receipt["taskId"]);
        let listed = plan["status"] != "prepared";
        let (mut sources, mut retained) = (vec![], vec![]);
        let omitted;
        if plan["format"] == 2 {
            let expired = plan["detail"].is_null();
            for r in items(&plan["sources"]).iter().filter(|_| listed) {
                let content = if expired {
                    Value::Null
                } else {
                    self.catalog_source(task, text(&r["key"]))?
                };
                sources.push(if content.is_object() {
                    trace_source(&content, false, include)
                } else {
                    bare(r)
                });
            }
            for e in items(&plan["detail"]["retained"]) {
                let content = match e["key"].as_str() {
                    Some(k) => self.catalog_source(task, k)?,
                    None => Value::Null,
                };
                if !content.is_object() {
                    retained.push(e.clone());
                    continue;
                }
                if listed {
                    sources.push(trace_source(&content, true, include));
                }
                retained.push(retained_entry(&content, e));
            }
            omitted = items(&plan["detail"]["omitted"]).to_vec();
        } else {
            if listed {
                for s in items(&plan["sources"]) {
                    sources.push(trace_source(s, false, include));
                }
                for r in items(&plan["retained"]) {
                    if let Some((_, content)) = self.origin(task, r)? {
                        sources.push(trace_source(&content, true, include));
                    }
                }
            }
            retained = items(&plan["retained"]).to_vec();
            omitted = items(&plan["omitted"]).to_vec();
        }
        let mut out = json!({"status":plan["status"],"budget":plan["budget"],"sources":sources,
            "retained":retained,"omitted":omitted,"diagnostics":plan["diagnostics"]});
        if plan["format"] == 2 {
            out["omittedCounts"] = plan["omittedCounts"].clone();
        }
        if plan["detailExpired"] == true {
            out["detailExpired"] = json!(true);
        }
        Ok(out)
    }
    // v1→v2。先只读算出窗口和「目录必须保留的资料」；再逐行补引用列、只为需要的资料
    // 写目录、降级窗口外的计划；所有目录键都齐了之后才压缩窗口内的计划（沿用可能指向
    // 更晚写入的收据：受理先后与提交先后不一致），最后把台账搬出任务行。
    pub(super) fn migrate_rows(&mut self) -> Result<Value> {
        let started = now();
        self.report("scan", 0, 0);
        // 1. 窗口：每个任务按写入倒序数带计划的收据。第 1 条未提交的视为进行中。
        let mut rank: HashMap<String, usize> = HashMap::new();
        let mut needed: HashMap<(String, String, String), Vec<String>> = HashMap::new();
        {
            let mut counters: HashMap<String, usize> = HashMap::new();
            let db = self.db()?;
            let mut stmt = db
                .prepare("SELECT id, json_extract(body,'$.taskId'), json_type(body,'$.contextPlan'), json_extract(body,'$.contextPlan.retained') FROM shell_records WHERE kind='receipt' ORDER BY rowid DESC")
                .map_err(err)?;
            let mut rows = stmt.query([]).map_err(err)?;
            while let Some(row) = rows.next().map_err(err)? {
                if row.get_ref(2).map_err(err)?.as_str().ok() != Some("object") {
                    continue;
                }
                let Some(task) = row
                    .get_ref(1)
                    .map_err(err)?
                    .as_str()
                    .ok()
                    .filter(|t| !t.is_empty())
                    .map(str::to_string)
                else {
                    continue;
                };
                let id: String = row.get(0).map_err(err)?;
                let n = counters.entry(task.clone()).or_default();
                *n += 1;
                let n = *n;
                rank.insert(id, n);
                if n <= DETAIL_TURNS {
                    if let Ok(Some(list)) = row.get::<_, Option<String>>(3) {
                        for r in items(&parse(&list)?) {
                            needed
                                .entry(triple(text(&r["receiptId"]), r))
                                .or_default()
                                .push(task.clone());
                        }
                    }
                }
            }
        }
        let mut ledgers = vec![];
        let tasks: Vec<(String, String)> = {
            let db = self.db()?;
            let mut stmt = db
                .prepare("SELECT id, body FROM shell_records WHERE kind='task'")
                .map_err(err)?;
            let rows = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                .map_err(err)?;
            rows.collect::<rusqlite::Result<_>>().map_err(err)?
        };
        for (id, body) in tasks {
            let value = parse(&body)?;
            if !value["contextLedger"].is_object() {
                continue;
            }
            let task = value["id"].as_str().unwrap_or(&id).to_string();
            for (sid, entry) in value["contextLedger"]["sources"].as_object().into_iter().flatten() {
                let probe = json!({"id":sid,"version":entry["version"]});
                needed
                    .entry(triple(text(&entry["receiptId"]), &probe))
                    .or_default()
                    .push(task.clone());
            }
            ledgers.push(id);
        }
        let scanned = now();
        // 2. 逐行：引用列、计划、目录。
        let rowids: Vec<i64> = {
            let mut stmt = self
                .db()?
                .prepare("SELECT rowid FROM shell_records ORDER BY rowid")
                .map_err(err)?;
            let rows = stmt.query_map([], |r| r.get(0)).map_err(err)?;
            rows.collect::<rusqlite::Result<_>>().map_err(err)?
        };
        let mut keys: HashMap<(String, String, String), String> = HashMap::new();
        let mut detailed = vec![];
        let (mut compacted, mut demoted, mut live) = (0, 0, 0);
        for (i, rowid) in rowids.iter().enumerate() {
            self.report("rewrite", i, rowids.len());
            let (kind, id, body): (String, String, String) = self
                .db()?
                .query_row(
                    "SELECT kind,id,body FROM shell_records WHERE rowid=?1",
                    [rowid],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .map_err(err)?;
            let mut value = parse(&body)?;
            let mut changed = false;
            if kind == "receipt" && value["contextPlan"].is_object() {
                let task = text(&value["taskId"]).to_string();
                let plan = value["contextPlan"].clone();
                for s in items(&plan["sources"]) {
                    let t = triple(&id, s);
                    if let Some(owners) = needed.get(&t).cloned() {
                        let key = source_key(s);
                        for owner in owners {
                            self.ensure_catalog(&owner, &key, &stored(s))?;
                        }
                        keys.insert(t, key);
                    }
                }
                let n = rank.get(&id).copied().unwrap_or(usize::MAX);
                let in_flight = n == 1 && plan["status"] != "committed";
                if n <= DETAIL_TURNS && !in_flight {
                    detailed.push(*rowid);
                } else if n > DETAIL_TURNS {
                    value["contextPlan"] = self.compact_plan(&task, &plan, false, &[])?;
                    demoted += 1;
                    changed = true;
                } else {
                    live += 1;
                }
            }
            let body = if changed { value.to_string() } else { body };
            self.db()?
                .prepare_cached(
                    "UPDATE shell_records SET body=?1,task_ref=?2,receipt_ref=?3 WHERE rowid=?4",
                )
                .map_err(err)?
                .execute(params![
                    body,
                    value["taskId"].as_str(),
                    value["receiptId"].as_str(),
                    rowid
                ])
                .map_err(err)?;
        }
        // 3. 窗口内的计划：目录键已齐，压缩并保留明细。
        for (i, rowid) in detailed.iter().enumerate() {
            self.report("compact", i, detailed.len());
            let body: String = self
                .db()?
                .query_row("SELECT body FROM shell_records WHERE rowid=?1", [rowid], |r| r.get(0))
                .map_err(err)?;
            let mut value = parse(&body)?;
            let task = text(&value["taskId"]).to_string();
            let plan = value["contextPlan"].clone();
            let mut resolved = vec![];
            for r in items(&plan["retained"]) {
                let hit = match keys.get(&triple(text(&r["receiptId"]), r)) {
                    Some(k) => Some((k.clone(), self.catalog_source(&task, k)?)),
                    None => None,
                };
                resolved.push(hit.filter(|(_, c)| c.is_object()));
            }
            value["contextPlan"] = self.compact_plan(&task, &plan, true, &resolved)?;
            self.db()?
                .prepare_cached("UPDATE shell_records SET body=?1 WHERE rowid=?2")
                .map_err(err)?
                .execute(params![value.to_string(), rowid])
                .map_err(err)?;
            compacted += 1;
        }
        let rewritten = now();
        // 4. 台账搬出任务行，条目补目录键。
        for (i, id) in ledgers.iter().enumerate() {
            self.report("ledger", i, ledgers.len());
            let mut value = self.get("task", id)?;
            let Some(mut ledger) = value
                .as_object_mut()
                .and_then(|o| o.shift_remove("contextLedger"))
            else {
                continue;
            };
            let task = value["id"].as_str().unwrap_or(id).to_string();
            if let Some(sources) = ledger.get_mut("sources").and_then(Value::as_object_mut) {
                for (sid, entry) in sources.iter_mut() {
                    let probe = json!({"id":sid,"version":entry["version"]});
                    if let Some(k) = keys.get(&triple(text(&entry["receiptId"]), &probe)) {
                        entry["key"] = json!(k);
                    }
                }
            }
            ledger["taskId"] = json!(task);
            self.put("context-ledger", &task, &ledger)?;
            self.put("task", id, &value)?;
        }
        // 之后只剩提交大事务（真实库约 10 秒），进度停在本阶段终点而不是中途。
        self.report("ledger", ledgers.len(), ledgers.len());
        let catalog: i64 = self
            .db()?
            .query_row(
                "SELECT count(*) FROM shell_records WHERE kind='context-source'",
                [],
                |r| r.get(0),
            )
            .map_err(err)?;
        Ok(json!({"rows":rowids.len(),"ledgers":ledgers.len(),"compacted":compacted,"demoted":demoted,
            "live":live,"catalog":catalog,"scanMs":scanned.saturating_sub(started),
            "rewriteMs":rewritten.saturating_sub(scanned),"ledgerMs":now().saturating_sub(rewritten)}))
    }
}
