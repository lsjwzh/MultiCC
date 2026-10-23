//! Consumer of host-built Air cards. It never infers visibility,
//! permissions, live session state, Git or admission decisions from task rows.
use super::{
    projection::{number, text, truthy},
    query::Snapshot,
    validate_metadata,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
pub enum Command {
    Open {
        epoch: String,
        #[serde(default = "history_limit", rename = "historyLimit")]
        history_limit: usize,
        #[serde(default = "max_bytes", rename = "maxDeltaBytes")]
        max_bytes: usize,
    },
    Apply {
        snapshot: Value,
        #[serde(default)]
        partial: bool,
        #[serde(default)]
        removed: Vec<String>,
        #[serde(default, rename = "idOrder")]
        id_order: Option<Vec<String>>,
    },
    Publish {
        snapshot: Value,
        #[serde(default)]
        partial: bool,
        #[serde(default)]
        removed: Vec<String>,
        #[serde(default, rename = "idOrder")]
        id_order: Option<Vec<String>>,
        #[serde(default, rename = "dayStarts")]
        day_starts: Vec<f64>,
    },
    Sync {
        #[serde(default)]
        since: String,
        #[serde(default, rename = "dayStart")]
        day_start: Value,
    },
    Serialized,
    Identities {
        snapshot: Value,
        #[serde(default)]
        partial: bool,
        #[serde(default)]
        removed: Vec<String>,
    },
    Changes {
        #[serde(default)]
        since: String,
    },
    Page {
        #[serde(default = "super::object")]
        options: Value,
    },
    Stats {
        #[serde(default, rename = "dayStart")]
        day_start: Value,
    },
    Bootstrap {
        #[serde(default)]
        include: Vec<String>,
        #[serde(default, rename = "dayStart")]
        day_start: Value,
    },
    Snapshot,
    Cursor,
}
fn history_limit() -> usize {
    256
}
fn max_bytes() -> usize {
    256 * 1024
}
type Candidate = (Vec<Value>, Value, Vec<Value>, Vec<String>);
struct Event {
    revision: u64,
    body: Value,
    bytes: usize,
}
#[derive(Default)]
pub struct Index {
    epoch: String,
    revision: u64,
    floor: u64,
    history_limit: usize,
    max_bytes: usize,
    rows: Vec<Value>,
    snapshot: Option<Snapshot>,
    history: VecDeque<Event>,
    encoded: Option<Value>,
}
impl Index {
    fn cursor(&self) -> String {
        format!("{}:{}", self.epoch, self.revision)
    }
    fn candidate(
        &self,
        input: &Value,
        partial: bool,
        removed: &[String],
    ) -> Result<Candidate, String> {
        let mut metadata = input
            .as_object()
            .ok_or("read_model_invalid_snapshot")?
            .clone();
        let tasks = metadata.remove("tasks").unwrap_or(json!([]));
        let tasks = tasks.as_array().ok_or("read_model_invalid_snapshot")?;
        let metadata = Value::Object(metadata);
        validate_metadata(&metadata)?;
        let mut present = HashSet::new();
        for card in tasks {
            if !card.is_object()
                || text(card, "id").is_empty()
                || !present.insert(text(card, "id"))
                || !card["title"].is_string()
            {
                return Err("read_model_invalid_card".into());
            }
            for key in ["dirId", "runState", "goalState", "status"] {
                if !card[key].is_null() && !card[key].is_string() {
                    return Err("read_model_invalid_card".into());
                }
            }
            for key in ["updatedAt", "lastMessageAt"] {
                if !card[key].is_null() && !card[key].is_number() {
                    return Err("read_model_invalid_card".into());
                }
                number(&card[key])?;
            }
        }
        let removed: HashSet<_> = removed.iter().map(String::as_str).collect();
        let mut rows = Vec::new();
        let mut deleted = Vec::new();
        // Deletion order must follow the explicit input for partial changes.
        if partial {
            rows = self
                .rows
                .iter()
                .filter(|c| !removed.contains(text(c, "id")))
                .cloned()
                .collect();
        } else {
            for card in &self.rows {
                if present.contains(text(card, "id")) {
                    rows.push(card.clone());
                } else {
                    deleted.push(json!(text(card, "id")));
                }
            }
        }
        let mut positions: HashMap<String, usize> = rows
            .iter()
            .enumerate()
            .map(|(i, c)| (text(c, "id").to_owned(), i))
            .collect();
        let mut changed = Vec::new();
        for card in tasks {
            let id = text(card, "id");
            if let Some(i) = positions.get(id) {
                if &rows[*i] != card {
                    rows[*i] = card.clone();
                    changed.push(card.clone());
                }
            } else {
                positions.insert(id.to_owned(), rows.len());
                rows.push(card.clone());
                changed.push(card.clone());
            }
        }
        Ok((
            rows,
            metadata,
            changed,
            deleted
                .into_iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect(),
        ))
    }
    pub fn run(&mut self, command: Command) -> Result<Value, String> {
        if let Command::Open {
            epoch,
            history_limit,
            max_bytes,
        } = command
        {
            if epoch.is_empty()
                || epoch.contains(':')
                || epoch.len() > 128
                || history_limit > 4096
                || max_bytes > 16 * 1024 * 1024
            {
                return Err("read_model_invalid_air_options".into());
            }
            *self = Self {
                epoch,
                history_limit,
                max_bytes,
                ..Self::default()
            };
            return Ok(json!({"cursor":self.cursor(),"ready":false}));
        }
        if self.epoch.is_empty() {
            return Err("read_model_air_not_open".into());
        }
        match command {
            Command::Open { .. } => unreachable!(),
            Command::Apply {
                snapshot,
                partial,
                removed,
                id_order,
            } => {
                let (rows, metadata, changed, mut deleted) =
                    self.candidate(&snapshot, partial, &removed)?;
                if partial {
                    let mut found: HashSet<_> = self.rows.iter().map(|c| text(c, "id")).collect();
                    deleted = removed
                        .iter()
                        .filter(|id| found.remove(id.as_str()))
                        .cloned()
                        .collect();
                }
                let order =
                    id_order.or_else(|| self.snapshot.as_ref().and_then(|s| s.id_order.clone()));
                validate_order(&rows, &order)?;
                let meta_changed = self
                    .snapshot
                    .as_ref()
                    .is_none_or(|s| s.metadata != metadata);
                if self.snapshot.is_some()
                    && changed.is_empty()
                    && deleted.is_empty()
                    && !meta_changed
                {
                    return Ok(Value::Null);
                }
                let revision = self.revision + 1;
                let candidate =
                    Snapshot::new(rows.clone(), metadata.clone(), json!({}), revision, order);
                let cursor = format!("{}:{revision}", self.epoch);
                let mut event = json!({"type":"air_delta","cursor":cursor,"previous":self.cursor(),"tasks":changed,"deleted":deleted});
                if meta_changed {
                    event["metadata"] = metadata;
                }
                let bytes = super::wire::bytes(&event);
                let reset = self.snapshot.is_none() || bytes > self.max_bytes;
                // All validation and allocations precede publication.
                self.rows = rows;
                self.revision = revision;
                self.snapshot = Some(candidate);
                self.encoded = None;
                if reset {
                    self.history.clear();
                    self.floor = revision;
                    Ok(json!({"type":"air_reset","cursor":cursor}))
                } else {
                    self.history.push_back(Event {
                        revision,
                        body: event.clone(),
                        bytes,
                    });
                    while self.history.len() > self.history_limit {
                        self.floor = self.history.pop_front().unwrap().revision;
                    }
                    Ok(event)
                }
            }
            Command::Publish {
                snapshot,
                partial,
                removed,
                id_order,
                day_starts,
            } => {
                for day in &day_starts {
                    number(&json!(day))?;
                }
                let event = self.run(Command::Apply {
                    snapshot,
                    partial,
                    removed,
                    id_order,
                })?;
                let s = self.snapshot.as_mut().ok_or("read_model_not_ready")?;
                let stats: Vec<_> = day_starts
                    .into_iter()
                    .map(|day| json!([day, s.stats(day)]))
                    .collect();
                Ok(json!({"event":event,"stats":stats,"cursor":self.cursor(),"ready":true}))
            }
            Command::Sync { since, day_start } => {
                let day = number(&day_start)?;
                let mut response = self.changes(&since);
                response["taskStats"] = self
                    .snapshot
                    .as_mut()
                    .ok_or("read_model_not_ready")?
                    .stats(day);
                Ok(response)
            }
            Command::Serialized => {
                if let Some(encoded) = &self.encoded {
                    return Ok(encoded.clone());
                }
                use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
                use sha1::{Digest, Sha1};
                let s = self.snapshot.as_ref().ok_or("read_model_not_ready")?;
                let mut snapshot = s.metadata.clone();
                snapshot["tasks"] = json!(s.cards);
                let body = snapshot.to_string();
                let etag = format!(
                    "W/\"{}\"",
                    URL_SAFE_NO_PAD.encode(Sha1::digest(body.as_bytes()))
                );
                let encoded = json!({"body":body,"etag":etag});
                self.encoded = Some(encoded.clone());
                Ok(encoded)
            }
            Command::Identities {
                snapshot,
                partial,
                removed,
            } => {
                let (rows, _, _, _) = self.candidate(&snapshot, partial, &removed)?;
                Ok(json!({"ids":rows.iter().map(|c|text(c,"id")).collect::<Vec<_>>()}))
            }
            Command::Changes { since } => Ok(self.changes(&since)),
            Command::Cursor => Ok(json!({"cursor":self.cursor(),"ready":self.snapshot.is_some()})),
            Command::Snapshot => {
                let s = self.snapshot.as_ref().ok_or("read_model_not_ready")?;
                let mut result = s.metadata.clone();
                result["tasks"] = json!(s.cards);
                Ok(result)
            }
            Command::Page { options } => {
                let cursor = self.cursor();
                let mut page = self
                    .snapshot
                    .as_mut()
                    .ok_or("read_model_not_ready")?
                    .page(&options)?;
                page.as_object_mut().unwrap().remove("revision");
                page["cursor"] = json!(cursor);
                Ok(page)
            }
            Command::Stats { day_start } => Ok(self
                .snapshot
                .as_mut()
                .ok_or("read_model_not_ready")?
                .stats(number(&day_start)?)),
            Command::Bootstrap { include, day_start } => {
                let cursor = self.cursor();
                let s = self.snapshot.as_mut().ok_or("read_model_not_ready")?;
                let mut ids = Vec::new();
                let mut unique = HashSet::new();
                let pins = s.metadata["taskPins"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                for id in s
                    .cards
                    .iter()
                    .filter(|c| text(c, "status") != "archived")
                    .take(30)
                    .map(|c| text(c, "id").to_owned())
                    .chain(pins.iter().filter_map(|v| v.as_str().map(str::to_owned)))
                    .chain(include.into_iter().take(50))
                {
                    if unique.insert(id.clone()) {
                        ids.push(id);
                    }
                }
                let by_id: HashMap<_, _> = s.cards.iter().map(|c| (text(c, "id"), c)).collect();
                let tasks: Vec<_> = ids
                    .iter()
                    .filter_map(|id| by_id.get(id.as_str()).map(|c| (*c).clone()))
                    .collect();
                let attention: Vec<_> = s
                    .cards
                    .iter()
                    .filter(|c| truthy(&c["attention"]))
                    .take(50)
                    .cloned()
                    .collect();
                let mut result = s.metadata.clone();
                result["ok"] = json!(true);
                result["cursor"] = json!(cursor);
                result["taskStats"] = s.stats(number(&day_start)?);
                result["tasks"] = json!(tasks);
                result["attentionTasks"] = json!(attention);
                Ok(result)
            }
        }
    }
    fn changes(&self, since: &str) -> Value {
        if self.snapshot.is_none() {
            return json!({"ok":false,"code":"air_warming"});
        }
        let reset = || json!({"ok":true,"reset":true,"cursor":self.cursor()});
        let mut parts = since.split(':');
        let epoch = parts.next().unwrap_or("");
        let Some(raw) = parts.next() else {
            return reset();
        };
        let n = if raw.trim().is_empty() {
            0.0
        } else {
            match raw.trim().parse::<f64>() {
                Ok(n) => n,
                Err(_) => return reset(),
            }
        };
        if epoch != self.epoch
            || !n.is_finite()
            || n.fract() != 0.0
            || n < self.floor as f64
            || n > self.revision as f64
        {
            return reset();
        }
        let events: Vec<_> = self
            .history
            .iter()
            .filter(|e| e.revision > n as u64)
            .collect();
        if events.len() > 64 || events.iter().map(|e| e.bytes).sum::<usize>() > self.max_bytes {
            return reset();
        }
        if events.len() <= 1 {
            return json!({"ok":true,"cursor":self.cursor(),"events":events.iter().map(|e|&e.body).collect::<Vec<_>>()});
        }
        let mut tasks: Vec<Value> = Vec::new();
        let mut deleted: Vec<Value> = Vec::new();
        let mut metadata = None;
        for e in events {
            for id in e.body["deleted"].as_array().unwrap() {
                tasks.retain(|t| t["id"] != *id);
                if !deleted.contains(id) {
                    deleted.push(id.clone());
                }
            }
            for card in e.body["tasks"].as_array().unwrap() {
                if let Some(t) = tasks.iter_mut().find(|t| t["id"] == card["id"]) {
                    *t = card.clone();
                } else {
                    tasks.push(card.clone());
                }
                deleted.retain(|id| *id != card["id"]);
            }
            if let Some(m) = e.body.get("metadata") {
                metadata = Some(m.clone());
            }
        }
        let mut event = json!({"type":"air_delta","cursor":self.cursor(),"previous":since,"tasks":tasks,"deleted":deleted});
        if let Some(m) = metadata {
            event["metadata"] = m;
        }
        json!({"ok":true,"cursor":self.cursor(),"events":[event]})
    }
}
fn validate_order(cards: &[Value], order: &Option<Vec<String>>) -> Result<(), String> {
    if let Some(order) = order {
        let ids: HashSet<_> = order.iter().map(String::as_str).collect();
        if ids.len() != cards.len()
            || order.len() != cards.len()
            || cards.iter().any(|c| !ids.contains(text(c, "id")))
        {
            return Err("read_model_identity_order_stale".into());
        }
    } else if cards.iter().any(|c| {
        let id = text(c, "id");
        !id.starts_with("tsk_")
            || id.len() <= 4
            || !id[4..]
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
    }) {
        return Err("read_model_identity_order_required".into());
    }
    Ok(())
}
