//! HTTP transcript reads retain row identities and file ranges. Message bodies
//! are decoded one at a time, only after task membership and cursors are resolved.
mod full;
mod large;
mod normalize;
pub use full::{Body, FullRecord, CHUNK};
pub use normalize::disk_legacy_id;
mod preview;
mod source;
mod usage;

use crate::{chat_history_file as history, js, task_shell::reference};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use source::{Location, Sources};
use std::{collections::HashSet, fs::File, path::Path};

type Result<T> = std::result::Result<T, String>;
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn parse(s: &str) -> Result<Value> {
    serde_json::from_str(s).or_else(|_| js::json_parse(s).map(|v| js::to_serde(&v)).map_err(err))
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Scope {
    pub session_ids: Vec<String>,
    pub snapshot_ids: Vec<String>,
    pub streaming: HashSet<String>,
}

#[derive(Default)]
pub struct Query {
    pub before: Option<String>,
    pub around: Option<String>,
    pub message_id: Option<String>,
    pub limit: usize,
    pub archive: bool,
    pub per_turn: bool,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Meta {
    id: Value,
    role: Value,
    task_id: Value,
    ts: Value,
    usage: Value,
    held_result_id: Value,
    #[serde(rename = "_handoffArchive")]
    handoff: Value,
    #[serde(rename = "_interim")]
    interim: Value,
    usage_epoch: Value,
    usage_cumulative: Value,
}

struct Entry {
    location: Location,
    key: String,
    snapshot_alias: Option<String>,
    id: String,
    session: String,
    ts: f64,
    in_progress: bool,
    usage: Option<[f64; 5]>,
}

fn stamp(v: &Value) -> f64 {
    v.as_f64()
        .or_else(|| v.as_str()?.parse().ok())
        .filter(|v| v.is_finite())
        .unwrap_or_default()
}

fn clean_thinking(row: &mut Value) {
    if let Some(blocks) = row.get_mut("content").and_then(Value::as_array_mut) {
        blocks.retain(|b| {
            b["type"] != "thinking" || b["thinking"].as_str().is_some_and(|s| !s.trim().is_empty())
        });
    }
    if let Some(tools) = row.get_mut("tools").and_then(Value::as_array_mut) {
        for tool in tools {
            if tool["name"] == "Thinking"
                && tool["result"].is_string()
                && tool["result"] == tool["input"]["text"]
            {
                tool.as_object_mut().unwrap().remove("result");
            }
        }
    }
}

struct Index {
    sources: Sources,
    rows: Vec<Entry>,
}

impl Index {
    fn load(root: &Path, scope: &Scope, detail: &Value, q: &Query) -> Result<Self> {
        let task = detail.pointer("/task/id").and_then(Value::as_str);
        let primary = detail["sessionId"].as_str();
        let mut sources = Sources::default();
        let mut rows = vec![];
        let history_root = root.join("chat_history");
        for session in &scope.session_ids {
            let hidden = if task.is_none() && !q.archive {
                history::read_hidden_ids(&history::visibility_path(&history_root, session))
                    .map_err(err)?
            } else {
                HashSet::new()
            };
            let transcript = history::transcript_path(&history_root, session);
            let canonical = normalize::records(
                &mut sources,
                root,
                &transcript,
                session,
                !scope.snapshot_ids.is_empty(),
            )?;
            let last_user = canonical
                .iter()
                .rposition(|r| r.meta.role == "user")
                .filter(|_| scope.streaming.contains(session));
            let mut baselines = usage::Baselines::default();
            for (i, record) in canonical.into_iter().enumerate() {
                let normalize::Record {
                    meta,
                    id,
                    location,
                    snapshot_alias,
                    ..
                } = record;
                let delta = if task.is_none() && meta.role == "assistant" {
                    baselines.project(
                        meta.usage_epoch.as_str().unwrap_or("legacy"),
                        &meta.usage,
                        &meta.usage_cumulative,
                        q.per_turn,
                    )
                } else {
                    None
                };
                if let Some(task) = task {
                    let belongs = if js::serde::truthy(&meta.task_id) {
                        meta.task_id == task
                    } else {
                        Some(session.as_str()) == primary
                    };
                    if !belongs {
                        continue;
                    }
                }
                if hidden.contains(&js::JsString::from_rust_str(&id)) {
                    continue;
                }
                let mut key = if task.is_some() {
                    format!("{session}:{id}")
                } else {
                    id.clone()
                };
                if key.len() > 256 {
                    key = format!("row-{:x}", Sha256::digest(key.as_bytes()));
                }
                rows.push(Entry {
                    location,
                    key,
                    snapshot_alias,
                    id,
                    session: session.clone(),
                    ts: stamp(&meta.ts),
                    in_progress: last_user.is_some_and(|start| i >= start),
                    usage: delta,
                });
            }
        }
        if task.is_some() {
            rows.sort_by(|a, b| a.ts.total_cmp(&b.ts));
            let live: HashSet<_> = rows
                .iter()
                .flat_map(|r| std::iter::once(r.id.as_str()).chain(r.snapshot_alias.as_deref()))
                .collect();
            let mut inherited = vec![];
            sources.snapshots(root, &scope.snapshot_ids, |location, row| {
                let source_id = row["sourceMessageId"].as_str();
                if source_id.is_some_and(|id| live.contains(id)) {
                    return;
                }
                let Location::Snapshot { ref id, index } = location else {
                    unreachable!()
                };
                let key = format!("snapshot:{id}:{index}");
                inherited.push(Entry {
                    snapshot_alias: None,
                    key,
                    id: source_id.or(row["id"].as_str()).unwrap_or_default().into(),
                    session: row["sourceSessionId"].as_str().unwrap_or_default().into(),
                    ts: 0.,
                    location,
                    in_progress: false,
                    usage: None,
                });
            })?;
            inherited.append(&mut rows);
            rows = inherited;
        } else if !q.archive {
            let cap = if scope.session_ids.first().is_some_and(|id| id == "__aux__") {
                200
            } else {
                10000
            };
            rows.drain(..rows.len().saturating_sub(cap));
        }
        // Damaged or imported histories may reuse a message ID. Every cursor must still advance.
        let mut seen = HashSet::new();
        for (i, row) in rows.iter_mut().enumerate() {
            while !seen.insert(row.key.clone()) {
                row.key = format!("row-{i}-{:x}", Sha256::digest(row.key.as_bytes()));
            }
        }
        Ok(Self { sources, rows })
    }

    fn materialize(&mut self, n: usize, task: &Value, codes: &Value, full: bool) -> Result<Value> {
        let entry = &self.rows[n];
        let mut row = self.sources.read(&entry.location, full)?;
        clean_thinking(&mut row);
        row["messageKey"] = json!(entry.key);
        if !entry.id.is_empty() {
            row["id"] = json!(entry.id);
        }
        if task.is_object() {
            if matches!(entry.location, Location::Snapshot { .. }) {
                row["inherited"] = json!(true);
                if !crate::js::serde::truthy(&row["content"]) {
                    row["content"] = row["evidenceExcerpt"].as_str().unwrap_or("").into();
                }
                // Immutable evidence can already be an excerpt without a surviving original.
                if row["truncated"] == true {
                    row["canExpand"] = json!(false);
                }
            } else {
                row["sourceSessionId"] = json!(entry.session);
                row["sourceMessageId"] = json!(entry.id);
                row["contextMessageId"] = json!(entry.key);
                if entry.in_progress {
                    row["inProgress"] = json!(true);
                }
            }
            if !task["taskShortCode"].is_null()
                && (row["taskId"].is_null() || row["taskId"] == task["id"])
            {
                row["taskId"] = task["id"].clone();
                row["taskShortCode"] = task["taskShortCode"].clone();
                if row["taskName"].is_null() {
                    row["taskName"] = task["title"].clone();
                }
            }
        } else if row["role"] == "assistant" {
            usage::apply(&mut row, entry.usage);
        }
        if row["taskShortCode"].is_null() {
            if let Some(code) = row["taskId"].as_str().and_then(|id| codes.get(id)) {
                row["taskShortCode"] = code.clone();
            }
        }
        Ok(row)
    }
}

/// A single-message response goes straight from the Rust worker to the public
/// socket. The host port never receives full or preview message bodies.
pub fn read(root: &Path, scope: Scope, detail: Value, q: Query) -> Result<(u16, Body)> {
    for _ in 0..2 {
        let mut index = Index::load(root, &scope, &detail, &q)?;
        let reply = reply(root, &mut index, detail.clone(), &q);
        if index.sources.unchanged()? {
            return reply;
        }
    }
    Err("chat history changed during read".into())
}

fn reply(root: &Path, index: &mut Index, mut detail: Value, q: &Query) -> Result<(u16, Body)> {
    let codes = crate::durable_state::load_or_recover(&root.join("task-short-codes.json"))?
        .and_then(|v| v.get("byTaskId").map(js::to_serde))
        .unwrap_or_default();
    if let Some(id) = &q.message_id {
        let pos = index
            .rows
            .iter()
            .position(|r| &r.key == id)
            .or_else(|| index.rows.iter().position(|r| &r.id == id));
        return match pos {
            Some(n) if index.sources.large_record(&index.rows[n].location) => {
                let entry = &index.rows[n];
                Ok((
                    200,
                    Body::Record(index.sources.open_record(&entry.location, &entry.key)?),
                ))
            }
            Some(n) => Ok((
                200,
                serde_json::to_vec(
                    &json!({"message":index.materialize(n,&detail["task"],&codes,true)?}),
                )
                .map_err(err)?
                .into(),
            )),
            None => Ok((404, br#"{"error":"message not found"}"#.to_vec().into())),
        };
    }
    let len = index.rows.len();
    let limit = q.limit.clamp(1, 100);
    let find = |s: &String| index.rows.iter().position(|r| &r.key == s);
    let (mut start, mut end) = if let Some(around) = &q.around {
        let pos = find(around);
        detail["found"] = json!(pos.is_some());
        let end = pos.map_or(0, |n| (n.saturating_sub((limit - 1) / 2) + limit).min(len));
        detail["hasNewer"] = json!(pos.is_some() && end < len);
        (end.saturating_sub(limit), end)
    } else {
        let end = q.before.as_ref().map_or(len, |s| find(s).unwrap_or(0));
        (end.saturating_sub(limit), end)
    };
    // Start around requests at their anchor, so a byte cap never evicts it.
    let anchor = q
        .around
        .as_ref()
        .and_then(find)
        .unwrap_or_else(|| end.saturating_sub(1));
    let mut messages = std::collections::VecDeque::new();
    let mut bytes = 0;
    for n in (start..=anchor).rev().filter(|n| *n < end) {
        let (row, size) = preview::preview(index.materialize(n, &detail["task"], &codes, false)?);
        if bytes + size > preview::PAGE_BYTES && !messages.is_empty() {
            start = n + 1;
            break;
        }
        bytes += size + 1;
        messages.push_front(row);
    }
    for n in anchor + 1..end {
        let (row, size) = preview::preview(index.materialize(n, &detail["task"], &codes, false)?);
        if bytes + size > preview::PAGE_BYTES {
            end = n;
            break;
        }
        bytes += size + 1;
        messages.push_back(row);
    }
    if q.around.is_some() && detail["found"] == true {
        detail["hasNewer"] = json!(end < len);
    }
    detail["hasMore"] = json!(start > 0);
    detail["before"] = if start > 0 {
        json!(index.rows[start].key)
    } else {
        Value::Null
    };
    detail["messages"] = serde_json::to_value(messages).map_err(err)?;
    Ok((200, serde_json::to_vec(&detail).map_err(err)?.into()))
}

#[cfg(test)]
mod tests;
