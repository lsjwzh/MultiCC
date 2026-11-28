//! Match persisted interim/retry normalization before visibility and token accounting.
//! Only adjacent retry candidates require reading their bodies.
use super::*;

pub(super) struct Record {
    pub location: Location,
    pub id: String,
    pub snapshot_alias: Option<String>,
    pub meta: Meta,
    nudge: bool,
}

fn metadata(text: &str) -> Result<Meta> {
    serde_json::from_str(text).or_else(|_| serde_json::from_value(parse(text)?).map_err(err))
}

/// A persisted ID is written on the next history rewrite. Until then reads and
/// mutations derive the same ID without loading or hashing the message body.
pub fn disk_legacy_id(session: &str, index: usize) -> String {
    let mut digest = Sha256::new();
    digest.update(session.as_bytes());
    digest.update((index as u64).to_be_bytes());
    format!("m_legacy_{:x}", digest.finalize())
}

fn is_nudge(text: &str) -> bool {
    #[derive(Deserialize)]
    struct Content<'a> {
        #[serde(borrow)]
        content: Option<&'a serde_json::value::RawValue>,
    }
    let Some(raw) = serde_json::from_str::<Content>(text)
        .ok()
        .and_then(|c| c.content)
    else {
        return false;
    };
    let Some(value) = raw.get().strip_prefix('"') else {
        return false;
    };
    let prefix = value.trim_start();
    prefix.starts_with('🔇')
        || (prefix.starts_with('\\')
            && serde_json::from_str::<String>(raw.get())
                .is_ok_and(|s| s.trim_start().starts_with('🔇')))
}

fn matches_payload(
    sources: &mut Sources,
    prev: &Record,
    next: &Record,
    prefix: bool,
) -> Result<bool> {
    if prev.meta.held_result_id != next.meta.held_result_id
        || sources.large_record(&prev.location)
        || sources.large_record(&next.location)
    {
        return Ok(false);
    }
    let mut left = sources.read(&prev.location, false)?;
    let mut right = sources.read(&next.location, false)?;
    super::clean_thinking(&mut left);
    super::clean_thinking(&mut right);
    if left["tools"] != right["tools"] {
        return Ok(false);
    }
    let l = &left["content"];
    let r = &right["content"];
    if l == r {
        return Ok(prefix || !l.is_object() && !l.is_array());
    }
    let (Some(a), Some(b)) = (l.as_str(), r.as_str()) else {
        return Ok(false);
    };
    Ok(prefix && a.encode_utf16().take(16).count() == 16 && b.starts_with(a))
}

fn protected(board: &Value, session: &str, row: &Record) -> bool {
    if let Some(task) = row.meta.task_id.as_str().filter(|v| !v.is_empty()) {
        if board["tasks"][task]["deleting"] != true
            && !board["deletedTaskIds"]
                .as_array()
                .is_some_and(|ids| ids.iter().any(|v| v == task))
        {
            return true;
        }
    }
    board["tasks"]
        .as_object()
        .into_iter()
        .flat_map(|tasks| tasks.values())
        .filter(|task| task["deleting"] != true)
        .flat_map(|task| task["refs"].as_array().into_iter().flatten())
        .any(|r| {
            r["sessionId"] == session
                && ((r["userMsgId"].as_str().unwrap_or("").is_empty()
                    && r["assistantMsgId"].as_str().unwrap_or("").is_empty())
                    || r["userMsgId"] == row.id
                    || r["assistantMsgId"] == row.id)
        })
}

pub(super) fn records(
    sources: &mut Sources,
    root: &Path,
    path: &Path,
    session: &str,
    snapshots: bool,
) -> Result<Vec<Record>> {
    let mut raw = Vec::new();
    sources.scan(path, |location, text| {
        let meta = metadata(text)?;
        let missing = !js::serde::truthy(&meta.id);
        let id = if missing {
            disk_legacy_id(session, raw.len())
        } else {
            js::js_to_string(&js::from_serde(&meta.id)).to_string_lossy()
        };
        // Older task-context snapshots used a hash of the canonical message
        // body. Recognize those stored references when suppressing a duplicate.
        let snapshot_alias = if snapshots && missing {
            let mut full = js::json_parse(text).map_err(err)?;
            reference::legacy_message_id(&mut full, session, raw.len());
            full.get("id")
                .map(|id| js::js_to_string(id).to_string_lossy())
        } else {
            None
        };
        let nudge = meta.role == "user" && is_nudge(text);
        raw.push(Record {
            location,
            snapshot_alias,
            meta,
            id,
            nudge,
        });
        Ok(())
    })?;
    let mut rows = Vec::<Record>::with_capacity(raw.len());
    let mut last_final = None::<usize>;
    let mut board = None;
    for mut row in raw {
        if row.meta.role == "assistant" {
            let interim = js::serde::truthy(&row.meta.interim);
            if rows
                .last()
                .is_some_and(|r| r.meta.role == "assistant" && js::serde::truthy(&r.meta.interim))
            {
                let previous = rows.pop().unwrap();
                if interim {
                    row.id = previous.id;
                }
            } else if interim
                && rows.last().is_some_and(|r| r.meta.role == "assistant")
                && matches_payload(sources, rows.last().unwrap(), &row, false)?
            {
                continue;
            }
            if !interim {
                if let Some(pos) = last_final {
                    let prev = &rows[pos];
                    if !js::serde::truthy(&prev.meta.handoff)
                        && matches_payload(sources, prev, &row, true)?
                    {
                        if board.is_none() {
                            board = Some(crate::task_domain::repository::read_board_snapshot(
                                &root.join("task_board.json"),
                            )?);
                        }
                        if !protected(board.as_ref().unwrap(), session, prev) {
                            rows.remove(pos);
                        }
                    }
                }
                last_final = Some(rows.len());
            }
        } else if row.meta.role == "user" && !row.nudge {
            last_final = None;
        }
        rows.push(row);
    }
    Ok(rows)
}
