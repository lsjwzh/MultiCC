use super::projection::{at, number, state, text};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};

fn strings(v: &Value, key: &str) -> Vec<String> {
    v[key]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

pub struct Snapshot {
    pub cards: Vec<Value>,
    pub metadata: Value,
    pub overlays: Value,
    pub revision: u64,
    pub id_order: Option<Vec<String>>,
    ranks: HashMap<String, usize>,
    positions: HashMap<String, usize>,
    todos: HashSet<String>,
    ignored: HashSet<String>,
    memo: HashMap<String, Value>,
    order: VecDeque<String>,
}
impl Snapshot {
    pub fn position(&self, id: &str) -> Option<usize> {
        self.positions.get(id).copied()
    }
    // Overlay fields cannot change id or either ordering clock. Prepare all
    // replacements first; publication then needs no full-card clone or re-sort.
    pub fn patch(
        &mut self,
        replacements: Vec<(usize, Value)>,
        changes: &serde_json::Map<String, Value>,
        metadata: Value,
        revision: u64,
    ) {
        for (i, card) in replacements {
            self.cards[i] = card;
        }
        for (id, value) in changes {
            if value.is_null() {
                self.overlays.as_object_mut().unwrap().remove(id);
            } else {
                self.overlays[id] = value.clone();
            }
        }
        self.update_metadata(metadata, revision);
    }
    pub fn update_metadata(&mut self, metadata: Value, revision: u64) {
        self.todos = strings(&metadata, "taskTodos").into_iter().collect();
        self.ignored = strings(&metadata, "taskTodoIgnored").into_iter().collect();
        self.metadata = metadata;
        self.revision = revision;
        self.memo.clear();
        self.order.clear();
    }
    pub fn new(
        mut cards: Vec<Value>,
        metadata: Value,
        overlays: Value,
        revision: u64,
        id_order: Option<Vec<String>>,
    ) -> Self {
        let ranks: HashMap<_, _> = id_order
            .as_ref()
            .map(|ids| {
                ids.iter()
                    .enumerate()
                    .map(|(i, id)| (id.clone(), i))
                    .collect()
            })
            .unwrap_or_default();
        cards.sort_by(|a, b| {
            at(b)
                .total_cmp(&at(a))
                .then_with(|| {
                    number(&b["updatedAt"])
                        .unwrap_or(0.0)
                        .total_cmp(&number(&a["updatedAt"]).unwrap_or(0.0))
                })
                .then_with(|| {
                    if ranks.is_empty() {
                        text(a, "id").cmp(text(b, "id"))
                    } else {
                        ranks[text(a, "id")].cmp(&ranks[text(b, "id")])
                    }
                })
        });
        let positions = cards
            .iter()
            .enumerate()
            .map(|(i, c)| (text(c, "id").to_owned(), i))
            .collect();
        Self {
            cards,
            positions,
            todos: strings(&metadata, "taskTodos").into_iter().collect(),
            ignored: strings(&metadata, "taskTodoIgnored").into_iter().collect(),
            metadata,
            overlays,
            revision,
            id_order,
            ranks,
            memo: HashMap::new(),
            order: VecDeque::new(),
        }
    }
    fn needs(&self, card: &Value) -> bool {
        text(card, "status") != "archived"
            && !self.ignored.contains(text(card, "id"))
            && (self.todos.contains(text(card, "id"))
                || ["waiting", "error"].contains(&state(card).as_str())
                || state(card) == "succeeded" && text(card, "goalState") == "interact")
    }
    pub fn stats(&mut self, day: f64) -> Value {
        let key = format!("stats:{day}");
        if let Some(hit) = self.memo.get(&key) {
            return hit.clone();
        }
        let mut counts = serde_json::Map::new();
        for card in &self.cards {
            let status = state(card);
            for key in [
                "all",
                card["dirId"]
                    .as_str()
                    .unwrap_or(if card.get("dirId").is_some() {
                        "null"
                    } else {
                        "undefined"
                    }),
            ] {
                let c = counts.entry(key).or_insert_with(|| {
                    json!({"total":0,"open":0,"running":0,
                    "needs":0,"todo":0,"error":0,"archived":0})
                });
                let flags = [
                    ("total", true),
                    (
                        "open",
                        !["done", "archived"].contains(&text(card, "status")),
                    ),
                    ("running", status == "running"),
                    ("needs", self.needs(card)),
                    (
                        "todo",
                        text(card, "status") != "archived" && self.todos.contains(text(card, "id")),
                    ),
                    ("error", status == "error"),
                    ("archived", text(card, "status") == "archived"),
                ];
                for (field, add) in flags {
                    if add {
                        c[field] = json!(c[field].as_u64().unwrap_or(0) + 1);
                    }
                }
                if (status == "succeeded" || text(card, "status") == "done")
                    && number(&card["updatedAt"]).unwrap_or(0.0) >= day
                {
                    c["today"] = json!(c["today"].as_u64().unwrap_or(0) + 1);
                }
            }
        }
        let result = Value::Object(counts);
        self.remember(key, result.clone());
        result
    }
    pub fn page(&mut self, options: &Value) -> Result<Value, String> {
        let key = options.to_string();
        if let Some(hit) = self.memo.get(&key) {
            return Ok(hit.clone());
        }
        if !options.is_object() {
            return Err("read_model_invalid_options".into());
        }
        for field in ["status", "sort", "dirId", "query"] {
            if !options[field].is_null() && !options[field].is_string() {
                return Err("read_model_invalid_options".into());
            }
        }
        if !options["ids"].is_null()
            && !options["ids"]
                .as_array()
                .is_some_and(|a| a.iter().all(Value::is_string))
        {
            return Err("read_model_invalid_options".into());
        }
        if !options["visits"].is_null() && !options["visits"].is_object() {
            return Err("read_model_invalid_options".into());
        }
        let filter = match text(options, "status") {
            "" => "open",
            s => s,
        };
        let query = text(options, "query");
        let units: Vec<_> = query.encode_utf16().take(200).collect();
        let needle = String::from_utf16(&units)
            .map_err(|_| "read_model_unsupported_query")?
            .to_lowercase();
        let dir = text(options, "dirId");
        let day = number(&options["dayStart"])?;
        let pins: HashMap<_, _> = strings(&self.metadata, "taskPins")
            .into_iter()
            .enumerate()
            .map(|(i, id)| (id, i))
            .collect();
        let rank: HashMap<_, _> = strings(options, "ids")
            .into_iter()
            .take(200)
            .enumerate()
            .map(|(i, id)| (id, i))
            .collect();
        let dirs: HashMap<_, _> = self.metadata["directories"]
            .as_array()
            .map(|a| a.iter().map(|d| (text(d, "id"), text(d, "name"))).collect())
            .unwrap_or_default();
        let mut list = Vec::new();
        for card in &self.cards {
            let id = text(card, "id");
            if !dir.is_empty() && dir != text(card, "dirId") {
                continue;
            }
            if options["ids"].is_array() && !rank.contains_key(id) {
                continue;
            }
            if !needle.is_empty()
                && !format!(
                    "{} {}",
                    text(card, "title"),
                    dirs.get(text(card, "dirId")).unwrap_or(&"")
                )
                .to_lowercase()
                .contains(&needle)
            {
                continue;
            }
            let status = state(card);
            let selected = match filter {
                "all" => true,
                "recent" => text(card, "status") != "archived",
                "archived" => text(card, "status") == "archived",
                "today" => {
                    (status == "succeeded" || text(card, "status") == "done")
                        && number(&card["updatedAt"])? >= day
                }
                "needs" | "waiting" => self.needs(card),
                "waitingReply" => status == "waiting",
                "todo" => text(card, "status") != "archived" && self.todos.contains(id),
                "achieved" | "interact" => {
                    status == "succeeded" && text(card, "goalState") == filter
                }
                "running" | "error" | "succeeded" => status == filter,
                _ => !["done", "archived"].contains(&text(card, "status")),
            };
            if selected {
                list.push(card);
            }
        }
        let ascending =
            text(options, "sort") == "oldest" || ["needs", "todo", "waiting"].contains(&filter);
        let mut visits = HashMap::new();
        if text(options, "sort") == "visit" {
            for card in &list {
                visits.insert(
                    text(card, "id"),
                    number(&options["visits"][text(card, "id")])?,
                );
            }
        }
        list.sort_by(|a, b| {
            let aid = text(a, "id");
            let bid = text(b, "id");
            if options["ids"].is_array() {
                return rank[aid].cmp(&rank[bid]);
            }
            if pins.contains_key(aid) || pins.contains_key(bid) {
                return pins
                    .get(aid)
                    .unwrap_or(&usize::MAX)
                    .cmp(pins.get(bid).unwrap_or(&usize::MAX));
            }
            let visit = if text(options, "sort") == "visit" {
                visits[aid].total_cmp(&visits[bid])
            } else {
                std::cmp::Ordering::Equal
            };
            let cmp = visit.then_with(|| at(a).total_cmp(&at(b)));
            (if ascending { cmp } else { cmp.reverse() }).then_with(|| {
                if self.ranks.is_empty() {
                    aid.cmp(bid)
                } else {
                    self.ranks[aid].cmp(&self.ranks[bid])
                }
            })
        });
        let raw_limit = number(&options["limit"])?;
        let limit = (if raw_limit == 0.0 { 20.0 } else { raw_limit })
            .floor()
            .clamp(1.0, 50.0) as usize;
        let pages = list.len().div_ceil(limit).max(1);
        let page = number(&options["page"])?.floor().clamp(1.0, pages as f64) as usize;
        let result = json!({"ok":true,"revision":self.revision,"page":page,"pages":pages,"total":list.len(),
            "tasks":list.into_iter().skip((page-1)*limit).take(limit).collect::<Vec<_>>()});
        self.remember(key, result.clone());
        Ok(result)
    }
    fn remember(&mut self, key: String, result: Value) {
        if self.memo.len() >= 128 {
            if let Some(old) = self.order.pop_front() {
                self.memo.remove(&old);
            }
        }
        self.order.push_back(key.clone());
        self.memo.insert(key, result);
    }
}
