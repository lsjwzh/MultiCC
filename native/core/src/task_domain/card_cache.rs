//! 缓存判定、签名版本、验证间隔和失效均在 Rust；JS 只镜像 token 指向的对象。
use super::*;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
#[derive(Clone)]
struct Entry {
    signature: Value,
    value: Arc<Value>,
    token: u64,
    expires: f64,
}
struct Plan {
    version: u64,
    global: Value,
    keys: Vec<String>,
    signatures: Vec<Value>,
    previous: Vec<Option<Entry>>,
    needed: Vec<usize>,
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
            report: 600000.0,
            global: Value::Null,
            held: HashMap::new(),
            plans: HashMap::new(),
            sequence: 0,
            version: 0,
            stats: json!({"requests":0,"hits":0,"builds":0,"verifies":0,"mismatches":0,"globalResets":0}),
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
    pub fn run(&mut self, input: &str) -> Result<String, String> {
        let v: Value = crate::json_lenient::from_str(input).map_err(|_| "invalid_card_cache_input")?;
        let now = num(&v["now"]);
        let result = match text(&v["op"]) {
            "open" => {
                self.mode = if ["off", "shadow", "on"].contains(&text(&v["mode"])) {
                    text(&v["mode"]).into()
                } else {
                    "shadow".into()
                };
                self.verify = num(&v["verifyMs"]);
                self.report = num(&v["reportMs"]);
                self.last_report = now;
                json!({"mode":self.mode})
            }
            "stats" => {
                let mut stats = self.stats.clone();
                stats["mode"] = json!(self.mode);
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
                let mut needed = vec![];
                let mut tokens = vec![];
                for (i, item) in array(&v["items"]).iter().enumerate() {
                    let key = text(&item["key"]).to_string();
                    let signature = item["signature"].clone();
                    let old = self.held.get(&key).cloned();
                    let hit = self.mode == "on"
                        && !global.is_null()
                        && old
                            .as_ref()
                            .is_some_and(|old| old.signature == signature && now < old.expires);
                    if hit {
                        tokens.push(json!(old.as_ref().unwrap().token));
                    } else {
                        tokens.push(Value::Null);
                        needed.push(i);
                    }
                    keys.push(key);
                    signatures.push(signature);
                    previous.push(old);
                }
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
                        prune: v["prune"] != false,
                    },
                );
                json!({"ticket":ticket,"needed":needed,"tokens":tokens})
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
                let built = array(&v["built"]);
                if built.len() != plan.needed.len() {
                    return Err("card_cache_incomplete_build".into());
                }
                let mut entries = vec![];
                let mut tokens = vec![Value::Null; plan.keys.len()];
                let mut logs = vec![];
                let mut updates = vec![];
                for (i, key) in plan.keys.iter().enumerate() {
                    if !plan.needed.contains(&i) {
                        tokens[i] = json!(plan.previous[i].as_ref().unwrap().token);
                        continue;
                    }
                    let j = plan.needed.iter().position(|v| *v == i).unwrap();
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
                    let random = num(&built[j]["random"]).clamp(0.0, 1.0);
                    updates.push((
                        key.clone(),
                        Entry {
                            signature: plan.signatures[i].clone(),
                            value: Arc::new(value),
                            token,
                            expires: now + self.verify * (0.5 + random / 2.0),
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
                let hits = plan.keys.len() - plan.needed.len();
                self.add("hits", hits);
                self.add("builds", plan.needed.len());
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
                json!({"tokens":tokens,"entries":entries,"retained":retained,"nativeRenderable":cacheable,"keys":plan.keys,"hits":hits,"builds":plan.needed.len(),"logs":logs})
            }
            _ => return Err("invalid_card_cache_command".into()),
        };
        Ok(result.to_string())
    }
}
