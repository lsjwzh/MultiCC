//! 缓存判定、签名版本、验证间隔和失效均在 Rust；JS 只镜像 token 指向的对象。
use super::*;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
#[derive(Clone)]
struct Entry {
    signature: Value,
    value: Arc<Value>,
    token: u64,
    /// 这张卡最后一次被「重建并与缓存值比对」的时刻。签名未变即一直有效，这个
    /// 时刻只决定它什么时候轮到下一次抽样审计，**不是过期时间**。
    audited: f64,
}
struct Plan {
    version: u64,
    global: Value,
    keys: Vec<String>,
    signatures: Vec<Value>,
    previous: Vec<Option<Entry>>,
    needed: Vec<usize>,
    /// needed 里属于「抽样审计」的那些下标：它们的缓存值仍然有效，重建只为比对。
    audited: HashSet<usize>,
    prune: bool,
}
pub struct CardCache {
    prepared_input: Option<String>,
    prepared_value: Value,
    prepared_token: u32,
    rendered_value: Value,
    rendered_token: u32,
    mode: String,
    verify: f64,
    audit_budget: usize,
    report: f64,
    global: Value,
    held: HashMap<String, Entry>,
    plans: HashMap<u64, Plan>,
    sequence: u64,
    version: u64,
    stats: Value,
    last_report: f64,
    last_mismatch: f64,
}
impl Default for CardCache {
    fn default() -> Self {
        Self {
            prepared_input: None,
            prepared_value: Value::Null,
            prepared_token: 0,
            rendered_value: Value::Null,
            rendered_token: 0,
            mode: "shadow".into(),
            verify: 60000.0,
            audit_budget: 8,
            report: 600000.0,
            global: Value::Null,
            held: HashMap::new(),
            plans: HashMap::new(),
            sequence: 0,
            version: 0,
            stats: json!({"requests":0,"hits":0,"builds":0,"audits":0,"verifies":0,"mismatches":0,"globalResets":0}),
            last_report: 0.0,
            last_mismatch: 0.0,
        }
    }
}
impl CardCache {
    pub fn prepare(&mut self, input: &str, known_token: u32) -> Result<String, String> {
        if self.prepared_input.as_deref() != Some(input) {
            let command: Value =
                crate::json_lenient::from_str(input).map_err(|_| "invalid_air_preparation")?;
            self.prepared_value = super::run_value(&command)?;
            self.prepared_input = Some(input.to_string());
            self.prepared_token = self.prepared_token.wrapping_add(1).max(1);
        }
        Ok(if known_token == self.prepared_token {
            json!({"token":self.prepared_token})
        } else {
            json!({"token":self.prepared_token,"prepared":self.prepared_value})
        }
        .to_string())
    }
    /// 常驻任务板版：输入不含 board，直接读句柄的常驻副本；按句柄版本号判定重算。
    pub fn prepare_on(
        &mut self,
        input: &str,
        board: &Value,
        version: u64,
        known_token: u32,
    ) -> Result<String, String> {
        let key = format!("{version}\u{1}{input}");
        if self.prepared_input.as_deref() != Some(key.as_str()) {
            let command: Value =
                crate::json_lenient::from_str(input).map_err(|_| "invalid_air_preparation")?;
            if text(&command["op"]) != "airInputs" {
                return Err("invalid_air_preparation".into());
            }
            self.prepared_value = super::air::run_on(board, &command);
            self.prepared_input = Some(key);
            self.prepared_token = self.prepared_token.wrapping_add(1).max(1);
        }
        Ok(if known_token == self.prepared_token {
            json!({"token":self.prepared_token})
        } else {
            json!({"token":self.prepared_token,"prepared":self.prepared_value})
        }
        .to_string())
    }
    fn add(&mut self, key: &str, n: usize) {
        self.stats[key] = json!(self.stats[key].as_u64().unwrap_or(0) + n as u64);
    }
    /// 一轮快照的第一段：只上送 key/signature，由 Rust 决定哪些卡需要重建。
    /// 命中时宿主不再构造任何底稿，成本与旧路径的 plan 相同。
    pub fn snapshot_plan(&mut self, input: &str) -> Result<String, String> {
        let v: Value =
            crate::json_lenient::from_str(input).map_err(|_| "invalid_air_snapshot_input")?;
        let items = v["items"].as_array().map(Vec::as_slice).unwrap_or(&[]);
        let plan = self.exec(&json!({
            "op":"plan",
            "globalSignature":v["globalSignature"],
            "now":num(&v["now"]),
            "prune":v["prune"],
            "items":items.iter().map(|item| json!({
                "key":item["key"],
                "signature":item["signature"]
            })).collect::<Vec<_>>()
        }))?;
        Ok(json!({
            "ticket":plan["ticket"],
            "needed":plan["needed"],
            "hits":plan["hits"]
        })
        .to_string())
    }
    /// 第二轮：宿主只带 needed 的底稿回来；complete、overlay、排序都在 Rust 内完成。
    pub fn snapshot_finish(&mut self, input: &str) -> Result<String, String> {
        let v: Value =
            crate::json_lenient::from_str(input).map_err(|_| "invalid_air_snapshot_input")?;
        let now = num(&v["now"]);
        let built = v["bases"]
            .as_array()
            .map(|bases| {
                bases
                    .iter()
                    .map(|item| json!({"base":item["base"]}))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let complete =
            self.exec(&json!({"op":"complete","ticket":v["ticket"],"built":built,"now":now}))?;
        let native_renderable = complete["nativeRenderable"] == true;
        let overlay = self.exec(&json!({
            "op":"overlay",
            "now":now,
            "facts":v["facts"],
            "merges":v["merges"],
            "capacityReasons":v["capacityReasons"],
            "knownRenderToken":v["knownRenderToken"],
            "keys":complete["keys"],
            "tokens":complete["tokens"],
            "nativeRenderable":complete["nativeRenderable"],
            "entries":if native_renderable { Value::Null } else { complete["entries"].clone() }
        }))?;
        Ok(json!({
            "cards":overlay["cards"],
            "tokens":complete["tokens"],
            "hits":complete["hits"],
            "builds":complete["builds"],
            "audits":complete["audits"],
            "logs":complete["logs"],
            "renderToken":overlay["token"]
        })
        .to_string())
    }
    /// 宿主在 plan 与 finish 之间失败时丢弃 ticket，避免占满待办队列。
    pub fn snapshot_abort(&mut self, input: &str) -> Result<String, String> {
        let v: Value =
            crate::json_lenient::from_str(input).map_err(|_| "invalid_air_snapshot_input")?;
        self.exec(&json!({"op":"abort","ticket":v["ticket"]}))?;
        Ok("null".into())
    }
    pub fn run(&mut self, input: &str) -> Result<String, String> {
        let v: Value =
            crate::json_lenient::from_str(input).map_err(|_| "invalid_card_cache_input")?;
        Ok(self.exec(&v)?.to_string())
    }
    fn exec(&mut self, v: &Value) -> Result<Value, String> {
        let now = num(&v["now"]);
        let result = match text(&v["op"]) {
            "open" => {
                self.mode = if ["off", "shadow", "on"].contains(&text(&v["mode"])) {
                    text(&v["mode"]).into()
                } else {
                    "shadow".into()
                };
                self.verify = num(&v["verifyMs"]);
                // 每轮最多重建几张「已命中但久未审计」的卡。0 = 不审计。
                self.audit_budget = if v["verifyBudget"].is_null() {
                    8
                } else {
                    num(&v["verifyBudget"]).max(0.0) as usize
                };
                self.report = num(&v["reportMs"]);
                self.last_report = now;
                json!({"mode":self.mode})
            }
            "stats" => {
                let mut stats = self.stats.clone();
                stats["mode"] = json!(self.mode);
                stats["held"] = json!(self.held.len());
                stats["auditBudget"] = json!(self.audit_budget);
                stats
            }
            "plan" => {
                if self.plans.len() >= 16 {
                    return Err("card_cache_queue_full".into());
                }
                self.add("requests", 1);
                let global = &v["globalSignature"];
                if self.mode == "off" || global.is_null() {
                    self.global = Value::Null;
                    self.held.clear();
                    self.version += 1;
                } else if global != &self.global {
                    if !self.global.is_null() {
                        self.add("globalResets", 1);
                    }
                    self.global = global.clone();
                    self.held.clear();
                    self.version += 1;
                }
                let mut keys = vec![];
                let mut signatures = vec![];
                let mut previous = vec![];
                let mut cached = vec![];
                let mut tokens = vec![];
                for item in array(&v["items"]).iter() {
                    let key = text(&item["key"]).to_string();
                    let signature = item["signature"].clone();
                    let old = self.held.get(&key).cloned();
                    // 签名按输入内容算（见 air.rs），所以它就是唯一的正确性判据：
                    // 内容没变的卡一直有效，不因为时间流逝而失效。
                    let valid = self.mode == "on"
                        && !global.is_null()
                        && old.as_ref().is_some_and(|old| old.signature == signature);
                    tokens.push(if valid {
                        json!(old.as_ref().unwrap().token)
                    } else {
                        Value::Null
                    });
                    keys.push(key);
                    signatures.push(signature);
                    previous.push(old);
                    cached.push(valid);
                }
                // 审计 = 重建一张仍然命中的卡并与缓存值比对，防的是「某个输入没进
                // 签名」这类缺陷。它必须是抽样：按最久未审计优先轮转，每轮硬上限
                // audit_budget。曾经的写法是给每条目设 verifyMs 过期，结果一到期
                // 就是全表重建（上千张卡），缓存等于不存在。
                // verifyBudget 是唯一开关（0 = 不审计）；verifyMs 只是间隔，
                // verifyMs=0 表示「每轮都该抽查」，仍受预算封顶。
                let mut audited: HashSet<usize> = HashSet::new();
                if self.audit_budget > 0 {
                    let age = |i: &usize| previous[*i].as_ref().map_or(0.0, |old| old.audited);
                    let mut due = (0..keys.len())
                        .filter(|i| cached[*i] && now - age(i) >= self.verify)
                        .collect::<Vec<_>>();
                    due.sort_by(|a, b| age(a).total_cmp(&age(b)).then(a.cmp(b)));
                    audited.extend(due.into_iter().take(self.audit_budget));
                }
                for i in &audited {
                    tokens[*i] = Value::Null;
                }
                let needed = (0..keys.len())
                    .filter(|i| !cached[*i] || audited.contains(i))
                    .collect::<Vec<_>>();
                let hits = cached.iter().filter(|value| **value).count();
                self.sequence += 1;
                let ticket = self.sequence;
                self.plans.insert(
                    ticket,
                    Plan {
                        version: self.version,
                        global: global.clone(),
                        keys,
                        signatures,
                        previous,
                        needed: needed.clone(),
                        audited,
                        prune: v["prune"] != false,
                    },
                );
                json!({"ticket":ticket,"needed":needed,"tokens":tokens,"hits":hits})
            }
            "overlay" => {
                let mut cards = vec![];
                for (i, key) in array(&v["keys"]).iter().enumerate() {
                    let entry = if v["nativeRenderable"] == true {
                        let held = self
                            .held
                            .get(text(key))
                            .ok_or("card_cache_version_changed")?;
                        if held.token != v["tokens"][i].as_u64().unwrap_or(0) {
                            return Err("card_cache_version_changed".into());
                        }
                        held.value.as_ref()
                    } else {
                        &v["entries"][i]
                    };
                    let id = text(&entry["card"]["id"]);
                    cards.push(cards::overlay_parts(
                        &entry["t"],
                        &entry["card"],
                        &v["facts"],
                        now,
                        &v["merges"][id],
                        &v["capacityReasons"][id],
                    ));
                }
                cards::sort(&mut cards);
                let cards = json!(cards);
                if self.rendered_value != cards {
                    self.rendered_value = cards;
                    self.rendered_token = self.rendered_token.wrapping_add(1).max(1);
                }
                if v["knownRenderToken"].as_u64() == Some(self.rendered_token as u64) {
                    json!({"token":self.rendered_token})
                } else {
                    json!({"token":self.rendered_token,"cards":self.rendered_value})
                }
            }
            "abort" => {
                self.plans.remove(&v["ticket"].as_u64().unwrap_or(0));
                Value::Null
            }
            "complete" => {
                let plan = self
                    .plans
                    .remove(&v["ticket"].as_u64().unwrap_or(0))
                    .ok_or("card_cache_ticket_missing")?;
                if plan.version != self.version {
                    return Err("card_cache_version_changed".into());
                }
                let built = v["built"].as_array().map(Vec::as_slice).unwrap_or(&[]);
                if built.len() != plan.needed.len() {
                    return Err("card_cache_incomplete_build".into());
                }
                let mut entries = vec![];
                let mut tokens = vec![Value::Null; plan.keys.len()];
                let mut logs = vec![];
                let mut updates = vec![];
                // needed 是稀疏升序下标：逐卡 contains + position 在上千张卡上是
                // 平方级扫描，这里先折成一张直查表。
                let mut built_at = vec![None; plan.keys.len()];
                for (j, i) in plan.needed.iter().enumerate() {
                    built_at[*i] = Some(j);
                }
                for (i, key) in plan.keys.iter().enumerate() {
                    let Some(j) = built_at[i] else {
                        tokens[i] = json!(plan.previous[i].as_ref().unwrap().token);
                        continue;
                    };
                    let value = if let Some(base) = built[j].get("base") {
                        let mut entry = cards::base(base);
                        entry["t"] = base["task"].clone();
                        entry
                    } else {
                        built[j]["entry"].clone()
                    };
                    if let Some(old) = &plan.previous[i] {
                        if old.signature == plan.signatures[i] {
                            self.add("verifies", 1);
                            if old.value["card"] != value["card"] {
                                self.add("mismatches", 1);
                                if now - self.last_mismatch >= 60000.0 {
                                    self.last_mismatch = now;
                                    let fields = value["card"]
                                        .as_object()
                                        .map(|card| {
                                            card.iter()
                                                .filter(|(k, val)| {
                                                    old.value["card"].get(*k) != Some(*val)
                                                })
                                                .map(|(k, _)| k.clone())
                                                .collect::<Vec<_>>()
                                        })
                                        .unwrap_or_default();
                                    logs.push(json!({"event":"air_card_cache_mismatch","mode":self.mode,"taskId":value["card"]["id"],"fields":fields}));
                                }
                            }
                        }
                    }
                    self.sequence += 1;
                    let token = self.sequence;
                    tokens[i] = json!(token);
                    entries.push(json!({"token":token,"entry":value}));
                    updates.push((
                        key.clone(),
                        Entry {
                            signature: plan.signatures[i].clone(),
                            value: Arc::new(value),
                            token,
                            audited: now,
                        },
                    ));
                }
                self.version += 1;
                let cacheable = self.mode != "off" && !plan.global.is_null();
                if cacheable {
                    if plan.prune {
                        let keys: HashSet<_> = plan.keys.iter().collect();
                        self.held.retain(|key, _| keys.contains(key));
                    }
                    for (key, value) in updates {
                        self.held.insert(key, value);
                    }
                }
                // 审计重建的卡缓存仍然有效，算命中；只有签名真的变了才算 build。
                let audits = plan.audited.len();
                let hits = plan.keys.len() - plan.needed.len() + audits;
                let builds = plan.needed.len() - audits;
                self.add("hits", hits);
                self.add("builds", builds);
                self.add("audits", audits);
                if now - self.last_report >= self.report {
                    self.last_report = now;
                    let mut report = self.stats.clone();
                    report["event"] = json!("air_card_cache_stats");
                    report["mode"] = json!(self.mode);
                    logs.push(report);
                }
                let retained = if cacheable {
                    self.held
                        .values()
                        .map(|v| json!(v.token))
                        .collect::<Vec<_>>()
                } else {
                    tokens.clone()
                };
                json!({"tokens":tokens,"entries":entries,"retained":retained,"nativeRenderable":cacheable,"keys":plan.keys,"hits":hits,"builds":builds,"audits":audits,"logs":logs})
            }
            _ => return Err("invalid_card_cache_command".into()),
        };
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一轮快照：上送 key+签名，为 needed 的卡回填底稿，返回 (hits, builds, audits)。
    fn round(cache: &mut CardCache, now: f64, items: &[(&str, &str)]) -> (usize, usize, usize) {
        let plan = cache
            .exec(&json!({
                "op":"plan","globalSignature":"g","now":now,"prune":true,
                "items":items.iter().map(|(k, s)| json!({"key":k,"signature":s})).collect::<Vec<_>>()
            }))
            .expect("plan");
        let built = array(&plan["needed"])
            .iter()
            .map(|i| {
                let (key, _) = items[i.as_u64().unwrap() as usize];
                json!({"entry":{"card":{"id":key},"t":{"id":key}},"random":1})
            })
            .collect::<Vec<_>>();
        let done = cache
            .exec(&json!({"op":"complete","ticket":plan["ticket"],"built":built,"now":now}))
            .expect("complete");
        (
            done["hits"].as_u64().unwrap() as usize,
            done["builds"].as_u64().unwrap() as usize,
            done["audits"].as_u64().unwrap() as usize,
        )
    }

    fn opened(verify: f64, budget: i64) -> CardCache {
        let mut cache = CardCache::default();
        cache
            .exec(&json!({"op":"open","mode":"on","verifyMs":verify,
                "verifyBudget":budget,"reportMs":600000,"now":0}))
            .expect("open");
        cache
    }

    // 这是本次修复的核心：签名按输入内容算，所以内容没变的卡永远有效。曾经每条
    // 目带 verifyMs 过期，于是一到点整表一起重建 —— 上千张卡在同一轮被重算，
    // 缓存等于不存在（线上实测 1554 张卡里 1536 张在重建）。
    #[test]
    fn an_unchanged_signature_never_expires_with_time() {
        let mut cache = opened(60_000.0, 0);
        assert_eq!(round(&mut cache, 0.0, &[("a", "s")]), (0, 1, 0));
        for now in [4_000.0, 61_000.0, 600_000.0, 86_400_000.0] {
            assert_eq!(
                round(&mut cache, now, &[("a", "s")]),
                (1, 0, 0),
                "签名未变的卡不该因为时间流逝而重建（now={now}）"
            );
        }
    }

    #[test]
    fn a_changed_signature_still_rebuilds_that_card_only() {
        let mut cache = opened(60_000.0, 0);
        round(&mut cache, 0.0, &[("a", "s1"), ("b", "s1")]);
        assert_eq!(
            round(&mut cache, 1_000.0, &[("a", "s2"), ("b", "s1")]),
            (1, 1, 0)
        );
    }

    // 审计是抽样，不是过期：到点的卡再多，一轮也只抽 budget 张。
    #[test]
    fn audits_are_capped_by_the_budget_per_round() {
        let mut cache = opened(60_000.0, 2);
        let items: Vec<(String, String)> = (0..10)
            .map(|i| (format!("k{i}"), "s".to_string()))
            .collect();
        let refs: Vec<(&str, &str)> = items
            .iter()
            .map(|(k, s)| (k.as_str(), s.as_str()))
            .collect();
        assert_eq!(round(&mut cache, 0.0, &refs), (0, 10, 0));
        // 全部到点，但预算只有 2：剩下 8 张照常命中。
        let (hits, builds, audits) = round(&mut cache, 61_000.0, &refs);
        assert_eq!(
            (hits, builds, audits),
            (10, 0, 2),
            "审计不算重建，且受预算封顶"
        );
    }

    // 轮转：最久没被审计过的先抽，所以 5 轮能把 10 张卡覆盖一遍，不会反复抽同几张。
    #[test]
    fn audits_rotate_over_the_least_recently_audited_cards() {
        let mut cache = opened(1.0, 2);
        let items: Vec<(String, String)> = (0..10)
            .map(|i| (format!("k{i}"), "s".to_string()))
            .collect();
        let refs: Vec<(&str, &str)> = items
            .iter()
            .map(|(k, s)| (k.as_str(), s.as_str()))
            .collect();
        round(&mut cache, 0.0, &refs);
        let mut seen: HashSet<String> = HashSet::new();
        for step in 1..=5 {
            let now = step as f64 * 10.0;
            let before: HashMap<String, f64> = cache
                .held
                .iter()
                .map(|(k, v)| (k.clone(), v.audited))
                .collect();
            round(&mut cache, now, &refs);
            for (key, value) in &cache.held {
                if before.get(key) != Some(&value.audited) {
                    seen.insert(key.clone());
                }
            }
        }
        assert_eq!(
            seen.len(),
            10,
            "5 轮 × 每轮 2 张应正好轮完 10 张，不重复抽同几张"
        );
    }

    #[test]
    fn a_zero_budget_disables_auditing_entirely() {
        let mut cache = opened(0.0, 0);
        round(&mut cache, 0.0, &[("a", "s")]);
        assert_eq!(round(&mut cache, 1_000_000.0, &[("a", "s")]), (1, 0, 0));
    }

    // 审计发现「签名没变但内容变了」时必须报警：那说明某个输入没进签名。
    #[test]
    fn an_audit_reports_a_mismatch_when_the_signature_missed_an_input() {
        // 报警本身按 60s 节流（last_mismatch 初值 0），所以必须用真实时钟量级：
        // 否则第一条报警就落在节流窗口里。生产用 Date.now()，从不会这样。
        const T0: f64 = 1_700_000_000_000.0;
        let mut cache = opened(0.0, 4);
        let plan = cache
            .exec(
                &json!({"op":"plan","globalSignature":"g","now":T0,"prune":true,
                "items":[{"key":"a","signature":"s"}]}),
            )
            .expect("plan");
        cache
            .exec(&json!({"op":"complete","ticket":plan["ticket"],"now":T0,
                "built":[{"entry":{"card":{"id":"a","readOnly":false}},"random":1}]}))
            .expect("complete");
        let plan = cache
            .exec(
                &json!({"op":"plan","globalSignature":"g","now":T0 + 10.0,"prune":true,
                "items":[{"key":"a","signature":"s"}]}),
            )
            .expect("plan");
        assert_eq!(array(&plan["needed"]).len(), 1, "到点的卡要被抽查");
        let done = cache
            .exec(
                &json!({"op":"complete","ticket":plan["ticket"],"now":T0 + 10.0,
                "built":[{"entry":{"card":{"id":"a","readOnly":true}},"random":1}]}),
            )
            .expect("complete");
        let logs = array(&done["logs"]);
        let mismatch = logs
            .iter()
            .find(|line| line["event"] == "air_card_cache_mismatch")
            .expect("必须记下差异");
        assert_eq!(mismatch["taskId"], json!("a"));
        assert_eq!(mismatch["fields"], json!(["readOnly"]));
    }

    #[test]
    fn a_changed_global_signature_drops_every_entry() {
        let mut cache = opened(60_000.0, 0);
        round(&mut cache, 0.0, &[("a", "s"), ("b", "s")]);
        let plan = cache
            .exec(
                &json!({"op":"plan","globalSignature":"g2","now":10,"prune":true,
                "items":[{"key":"a","signature":"s"},{"key":"b","signature":"s"}]}),
            )
            .expect("plan");
        assert_eq!(
            array(&plan["needed"]).len(),
            2,
            "任务板模块/分组变了要整体重建"
        );
    }

    // runState 的物证键清单只许有一份：宿主按它裁剪 taskState 投影，少一个键会让
    // 规则看不到物证却不报错。
    #[test]
    fn the_run_state_fact_keys_are_exposed_for_the_host() {
        let keys = json!(super::super::cards::RUN_STATE_FACT_KEYS);
        assert_eq!(array(&keys).len(), 7);
        assert!(array(&keys).contains(&json!("classifyState")));
    }
}
