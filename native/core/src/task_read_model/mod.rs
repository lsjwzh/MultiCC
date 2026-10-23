//! Read-only pilot: no production route or write owner is switched by this module.
mod air;
mod projection;
mod query;
mod wire;

use query::Snapshot;
use rusqlite::{Connection, OpenFlags};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{fs, path::PathBuf, time::Duration};

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
enum Command {
    Open {
        file: String,
    },
    Refresh {
        #[serde(default = "object")]
        metadata: Value,
        #[serde(default = "object")]
        overlays: Value,
        #[serde(default)]
        force: bool,
        #[serde(default, rename = "idOrder")]
        id_order: Option<Vec<String>>,
    },
    // Omitted inputs reuse Rust-owned state. Explicit null is rejected.
    Sync {
        #[serde(default, deserialize_with = "present")]
        metadata: Option<Value>,
        #[serde(default = "object", rename = "overlayChanges")]
        overlay_changes: Value,
        #[serde(default, rename = "baseRevision")]
        base_revision: Option<u64>,
        #[serde(default, rename = "idOrder")]
        id_order: Option<Vec<String>>,
    },
    View {
        #[serde(default = "object")]
        options: Value,
        #[serde(default, rename = "dayStart")]
        day_start: Value,
    },
    Air {
        command: air::Command,
    },
    Page {
        #[serde(default = "object")]
        options: Value,
    },
    Stats {
        #[serde(default, rename = "dayStart")]
        day_start: Value,
    },
    Snapshot,
    Identities,
    Close,
}
fn present<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Value>, D::Error> {
    Ok(Some(Value::deserialize(d)?))
}
fn object() -> Value {
    json!({})
}

#[derive(Default)]
pub struct ReadModel {
    db: Option<Connection>,
    file: PathBuf,
    identity: String,
    version: Option<i64>,
    snapshot: Option<Snapshot>,
    revision: u64,
    sources: Option<Vec<Value>>,
    source_positions: std::collections::HashMap<String, usize>,
    air: air::Index,
}
fn identity(file: &PathBuf) -> Result<String, String> {
    let meta = fs::metadata(file).map_err(|_| "read_model_source_unavailable")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(format!("{}:{}", meta.dev(), meta.ino()))
    }
    #[cfg(not(unix))]
    {
        Ok(format!(
            "{:?}",
            meta.created()
                .map_err(|_| "read_model_source_identity_unavailable")?
        ))
    }
}
impl ReadModel {
    pub fn run(&mut self, input: &str) -> Result<String, String> {
        let command: Command =
            serde_json::from_str(input).map_err(|_| "read_model_invalid_command")?;
        let result = match command {
            Command::Open { file } => {
                let file = fs::canonicalize(file).map_err(|_| "read_model_source_unavailable")?;
                let before = identity(&file)?;
                let db = Connection::open_with_flags(&file, OpenFlags::SQLITE_OPEN_READ_ONLY)
                    .map_err(|_| "read_model_open_failed")?;
                db.busy_timeout(Duration::from_millis(250))
                    .map_err(|_| "read_model_open_failed")?;
                db.pragma_update(None, "query_only", true)
                    .map_err(|_| "read_model_open_failed")?;
                let schema: i64 = db
                    .pragma_query_value(None, "user_version", |r| r.get(0))
                    .map_err(|_| "read_model_schema")?;
                if schema != 1 {
                    return Err("read_model_unsupported_schema".into());
                }
                db.prepare("SELECT id,body FROM shell_records WHERE kind='task' ORDER BY rowid")
                    .map_err(|_| "read_model_schema")?;
                if identity(&file)? != before {
                    return Err("read_model_source_replaced".into());
                }
                self.db = Some(db);
                self.file = file;
                self.identity = before;
                self.version = None;
                self.snapshot = None;
                self.sources = None;
                self.source_positions.clear();
                json!({"readonly":true,"sqlite":rusqlite::version()})
            }
            Command::Refresh {
                metadata,
                overlays,
                force,
                id_order,
            } => self.refresh(metadata, overlays, force, id_order)?,
            Command::Air { command } => self.air.run(command)?,
            Command::Sync {
                metadata,
                overlay_changes,
                base_revision,
                id_order,
            } => self.sync(metadata, overlay_changes, base_revision, id_order)?,
            Command::View { options, day_start } => {
                let s = self.snapshot.as_mut().ok_or("read_model_not_ready")?;
                json!({"revision":s.revision,"page":s.page(&options)?,"counts":s.stats(projection::number(&day_start)?)})
            }
            Command::Identities => {
                let db = self.db.as_ref().ok_or("read_model_not_open")?;
                if identity(&self.file)? != self.identity {
                    return Err("read_model_source_replaced".into());
                }
                let mut stmt = db
                    .prepare("SELECT id FROM shell_records WHERE kind='task' ORDER BY rowid")
                    .map_err(|_| "read_model_read_failed")?;
                let ids = stmt
                    .query_map([], |r| r.get::<_, String>(0))
                    .map_err(|_| "read_model_read_failed")?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|_| "read_model_read_failed")?;
                json!({"ids":ids})
            }
            Command::Page { options } => self
                .snapshot
                .as_mut()
                .ok_or("read_model_not_ready")?
                .page(&options)?,
            Command::Stats { day_start } => {
                let s = self.snapshot.as_mut().ok_or("read_model_not_ready")?;
                json!({"revision":s.revision,"counts":s.stats(projection::number(&day_start)?)})
            }
            Command::Snapshot => {
                let s = self.snapshot.as_ref().ok_or("read_model_not_ready")?;
                json!({"revision":s.revision,"metadata":s.metadata,"tasks":s.cards})
            }
            Command::Close => {
                self.db = None;
                self.snapshot = None;
                self.version = None;
                self.sources = None;
                self.source_positions.clear();
                self.air = air::Index::default();
                json!({"closed":true})
            }
        };
        Ok(result.to_string())
    }
    fn source_version(&self) -> Result<i64, String> {
        let db = self.db.as_ref().ok_or("read_model_not_open")?;
        if identity(&self.file)? != self.identity {
            return Err("read_model_source_replaced".into());
        }
        let schema: i64 = db
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .map_err(|_| "read_model_read_failed")?;
        if schema != 1 {
            return Err("read_model_unsupported_schema".into());
        }
        db.pragma_query_value(None, "data_version", |r| r.get(0))
            .map_err(|_| "read_model_read_failed".into())
    }
    fn sync(
        &mut self,
        metadata: Option<Value>,
        changes: Value,
        base: Option<u64>,
        order: Option<Vec<String>>,
    ) -> Result<Value, String> {
        let s = self.snapshot.as_ref().ok_or("read_model_not_ready")?;
        if base.is_some_and(|r| r != s.revision) {
            return Err("read_model_stale_revision".into());
        }
        let patch = changes.as_object().ok_or("read_model_invalid_overlay")?;
        if let Some(m) = &metadata {
            validate_metadata(m)?;
        }
        // An explicit reuse command avoids copying every overlay merely to
        // discover it has not changed. No JS object-identity assumptions.
        if patch.is_empty()
            && order
                .as_ref()
                .is_none_or(|o| Some(o) == s.id_order.as_ref())
            && self.version == Some(self.source_version()?)
        {
            let changed = metadata.as_ref().is_some_and(|m| m != &s.metadata);
            if changed {
                self.revision += 1;
                self.snapshot
                    .as_mut()
                    .unwrap()
                    .update_metadata(metadata.unwrap(), self.revision);
            }
            return Ok(
                json!({"revision":self.revision,"reloaded":false,"changed":changed,"rowsLoaded":0}),
            );
        }
        if !patch.is_empty()
            && order
                .as_ref()
                .is_none_or(|o| Some(o) == s.id_order.as_ref())
            && self.version == Some(self.source_version()?)
        {
            let changed = metadata.as_ref().is_some_and(|m| m != &s.metadata)
                || patch.iter().any(|(id, v)| {
                    if v.is_null() {
                        s.overlays.get(id).is_some()
                    } else {
                        s.overlays.get(id) != Some(v)
                    }
                });
            if !changed {
                return Ok(
                    json!({"revision":self.revision,"reloaded":false,"changed":false,"rowsLoaded":0}),
                );
            }
            let sources = self.sources.as_ref().ok_or("read_model_not_ready")?;
            let replacements: serde_json::Map<_, _> = patch
                .iter()
                .filter(|(_, v)| !v.is_null())
                .map(|(id, v)| (id.clone(), v.clone()))
                .collect();
            let updates = patch
                .keys()
                .filter_map(|id| s.position(id).map(|i| (id, i)))
                .map(|(id, i)| {
                    let raw = &sources[*self
                        .source_positions
                        .get(id)
                        .ok_or("read_model_invalid_snapshot")?];
                    Ok((i, projection::overlay(raw.clone(), &replacements)?))
                })
                .collect::<Result<Vec<_>, String>>()?;
            let metadata = metadata.unwrap_or_else(|| s.metadata.clone());
            self.snapshot
                .as_mut()
                .unwrap()
                .patch(updates, patch, metadata, self.revision + 1);
            self.revision += 1;
            return Ok(
                json!({"revision":self.revision,"reloaded":false,"changed":true,"rowsLoaded":0}),
            );
        }
        let mut overlays = s.overlays.clone();
        for (id, value) in patch {
            if value.is_null() {
                overlays.as_object_mut().unwrap().remove(id);
            } else {
                overlays[id] = value.clone();
            }
        }
        let metadata = metadata.unwrap_or_else(|| s.metadata.clone());
        let order = order.or_else(|| s.id_order.clone());
        self.refresh(metadata, overlays, false, order)
    }
    fn refresh(
        &mut self,
        metadata: Value,
        overlays: Value,
        force: bool,
        id_order: Option<Vec<String>>,
    ) -> Result<Value, String> {
        let overlays_map = overlays.as_object().ok_or("read_model_invalid_overlay")?;
        validate_metadata(&metadata)?;
        let db = self.db.as_mut().ok_or("read_model_not_open")?;
        if identity(&self.file)? != self.identity {
            return Err("read_model_source_replaced".into());
        }
        let schema: i64 = db
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .map_err(|_| "read_model_read_failed")?;
        if schema != 1 {
            return Err("read_model_unsupported_schema".into());
        }
        // Only this persistent connection owns data_version. All writers are
        // external, so its unchanged value can safely validate a warm snapshot.
        let version: i64 = db
            .pragma_query_value(None, "data_version", |r| r.get(0))
            .map_err(|_| "read_model_read_failed")?;
        if !force
            && self.version == Some(version)
            && self.snapshot.as_ref().is_some_and(|s| {
                s.metadata == metadata && s.overlays == overlays && s.id_order == id_order
            })
        {
            return Ok(json!({"revision":self.revision,"reloaded":false,"rowsLoaded":0}));
        }
        let reload = force || self.version != Some(version);
        // Metadata changes invalidate queries without re-reading or cloning cards.
        if !reload
            && self
                .snapshot
                .as_ref()
                .is_some_and(|s| s.overlays == overlays && s.id_order == id_order)
        {
            self.revision += 1;
            self.snapshot
                .as_mut()
                .unwrap()
                .update_metadata(metadata, self.revision);
            return Ok(
                json!({"revision":self.revision,"reloaded":false,"changed":true,"rowsLoaded":0}),
            );
        }
        // Build a candidate under one SQLite read transaction. Never publish half
        // of a snapshot or update the version after a parse/lock/commit failure.
        let sources = if reload {
            let tx = db.transaction().map_err(|_| "read_model_read_failed")?;
            let mut sources = Vec::new();
            {
                let mut stmt = tx
                    .prepare("SELECT id,body FROM shell_records WHERE kind='task' ORDER BY rowid")
                    .map_err(|_| "read_model_read_failed")?;
                let rows = stmt
                    .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                    .map_err(|_| "read_model_read_failed")?;
                for row in rows {
                    let (id, body) = row.map_err(|_| "read_model_read_failed")?;
                    sources.push(projection::project(&id, &body)?);
                }
            }
            tx.commit().map_err(|_| "read_model_read_failed")?;
            sources
        } else {
            self.sources.as_ref().ok_or("read_model_not_ready")?.clone()
        };
        let cards = sources
            .iter()
            .map(|s| projection::overlay(s.clone(), overlays_map))
            .collect::<Result<Vec<_>, _>>()?;
        if identity(&self.file)? != self.identity {
            return Err("read_model_source_replaced".into());
        }
        let count = cards.len();
        if let Some(ids) = &id_order {
            let keys: std::collections::HashSet<_> = ids.iter().map(String::as_str).collect();
            if keys.len() != count
                || ids.len() != count
                || cards
                    .iter()
                    .any(|c| !keys.contains(projection::text(c, "id")))
            {
                return Err("read_model_identity_order_stale".into());
            }
        } else if cards.iter().any(|c| {
            let id = projection::text(c, "id");
            !id.starts_with("tsk_")
                || id.len() <= 4
                || !id[4..]
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        }) {
            return Err("read_model_identity_order_required".into());
        }
        let candidate = Snapshot::new(cards, metadata, overlays, self.revision + 1, id_order);
        let changed = self.snapshot.as_ref().is_none_or(|s| {
            s.metadata != candidate.metadata
                || s.overlays != candidate.overlays
                || s.cards != candidate.cards
                || s.id_order != candidate.id_order
        });
        if changed {
            self.revision += 1;
            self.snapshot = Some(candidate);
        }
        self.source_positions = sources
            .iter()
            .enumerate()
            .map(|(i, c)| (projection::text(c, "id").to_owned(), i))
            .collect();
        self.sources = Some(sources);
        self.version = Some(version);
        Ok(
            json!({"revision":self.revision,"reloaded":reload,"changed":changed,"rowsLoaded":if reload {count} else {0}}),
        )
    }
}

pub(super) fn validate_metadata(metadata: &Value) -> Result<(), String> {
    if !metadata.is_object() {
        return Err("read_model_invalid_metadata".into());
    }
    for field in ["taskPins", "taskTodos", "taskTodoIgnored"] {
        if !metadata[field].is_null()
            && !metadata[field]
                .as_array()
                .is_some_and(|a| a.iter().all(Value::is_string))
        {
            return Err("read_model_invalid_metadata".into());
        }
    }
    if !metadata["directories"].is_null()
        && !metadata["directories"].as_array().is_some_and(|a| {
            a.iter()
                .all(|d| d["id"].is_string() && (d["name"].is_null() || d["name"].is_string()))
        })
    {
        return Err("read_model_invalid_metadata".into());
    }
    Ok(())
}
