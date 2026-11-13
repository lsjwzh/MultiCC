//! Experimental bounded index pages for building a scheduler read model.
//! These rows are only candidates: they omit host facts and payloads, so they
//! must never be used as scheduler decisions on their own.
use super::{err, record, Result};
use crate::js::{truthy, JsValue};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

const MAX_PAGE: u64 = 128;
const MAX_IDENTIFIER_BYTES: usize = 1024;
const MAX_SEQUENCE: i64 = 9_007_199_254_740_991;
const MAX_RECORD_BYTES: usize = 64 * 1024;

#[derive(Clone)]
pub(super) struct Scan {
    token: String,
    session: String,
    state: &'static str,
    after: Option<i64>,
    complete: bool,
    revision: Option<u64>,
}

fn only_fields(input: &Value, allowed: &[&str]) -> Result<()> {
    let fields = input
        .as_object()
        .ok_or_else(|| err("scheduler metadata input must be an object"))?;
    if fields.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(err("unexpected scheduler metadata field"));
    }
    Ok(())
}

impl Scan {
    pub(super) fn session(&self) -> &str {
        &self.session
    }

    pub(super) fn new(token: String, input: &Value) -> Result<Self> {
        only_fields(input, &["sessionId"])?;
        let session = input["sessionId"]
            .as_str()
            .filter(|value| !value.is_empty() && value.len() <= MAX_IDENTIFIER_BYTES)
            .ok_or_else(|| err("invalid scheduler metadata session"))?;
        Ok(Self {
            token,
            session: session.to_owned(),
            state: "pending",
            after: None,
            complete: false,
            revision: None,
        })
    }

    pub(super) fn bind_revision(&mut self, state: &Value) -> Result<()> {
        self.revision = Some(
            state["revision"]
                .as_u64()
                .ok_or_else(|| err("invalid scheduler metadata revision"))?,
        );
        Ok(())
    }

    pub(super) fn validate_prepare(&self, input: &Value) -> Result<()> {
        only_fields(input, &["token", "expectedRevision", "state", "changes"])?;
        if input["token"].as_str() != Some(self.token.as_str()) {
            return Err(err("scheduler metadata snapshot is not active"));
        }
        if !self.complete {
            return Err(err("scheduler metadata scan is incomplete"));
        }
        if self.revision.is_none() || self.revision != input["expectedRevision"].as_u64() {
            return Err(err("scheduler metadata revision mismatch"));
        }
        Ok(())
    }

    pub(super) fn next(&mut self, connection: &Connection, input: &Value) -> Result<Value> {
        only_fields(input, &["token", "limit"])?;
        if input["token"].as_str() != Some(self.token.as_str()) {
            return Err(err("scheduler metadata snapshot is not active"));
        }
        if self.complete {
            return Err(err("scheduler metadata scan is complete"));
        }
        let result = page(connection, &self.session, self.state, self.after, input)?;
        let state = self.state;
        if let Some(next) = result["nextSequence"].as_i64() {
            self.after = Some(next);
        } else if self.state == "pending" {
            self.state = "leased";
            self.after = None;
        } else {
            self.complete = true;
        }
        Ok(json!({"state": state, "rows": result["rows"], "scanComplete": self.complete}))
    }
}

fn optional_id(value: Option<&JsValue>) -> Result<Option<String>> {
    let Some(value) = value.filter(|value| truthy(value)) else {
        return Ok(None);
    };
    let JsValue::String(text) = value else {
        return Err(err("scheduler metadata requires string identifiers"));
    };
    if !text.is_well_formed() {
        return Err(err("scheduler metadata identifier is not well-formed"));
    }
    let text = text.to_string_lossy();
    if text.len() > MAX_IDENTIFIER_BYTES {
        return Err(err("scheduler metadata identifier exceeds limit"));
    }
    Ok(Some(text))
}

pub(super) fn schedule(connection: &Connection, session: &str) -> Result<Value> {
    // Only one capped scheduler record is parsed, inside the read snapshot;
    // the complete record and any unrelated fields never leave Rust.
    let raw: Option<Option<String>> = connection.query_row(
        "SELECT CASE WHEN octet_length(data_json)<=?2 THEN data_json END FROM orchestration_session_schedules WHERE session_id=?1",
        params![session, MAX_RECORD_BYTES as i64], |row| row.get(0),
    ).optional().map_err(err)?;
    let Some(raw) = raw else {
        return Ok(json!({"exists":false,"activeDeliveryId":null,"priorityEntryId":null}));
    };
    let raw = raw.ok_or_else(|| err("scheduler metadata schedule exceeds limit"))?;
    let value = record::parse(&raw)?;
    if !matches!(&value, JsValue::Object(_)) {
        return Err(err("scheduler metadata schedule must be an object"));
    }
    let active = value.get("active");
    if active.is_some_and(|value| !value.is_nullish() && !matches!(value, JsValue::Object(_))) {
        return Err(err("scheduler metadata active must be an object or null"));
    }
    let delivery = optional_id(active.and_then(|value| value.get("deliveryId")))?;
    let entry = optional_id(active.and_then(|value| value.get("entryId")))?;
    let priority = optional_id(value.get("priorityEntryId"))?;
    Ok(json!({"exists":true,"activeDeliveryId":delivery.or(entry),"priorityEntryId":priority}))
}

fn queue_order(
    connection: &Connection,
    id: &str,
    session: &str,
    state: &str,
    sequence: i64,
) -> Result<Option<f64>> {
    // octet_length(column) can inspect SQLite's record header without first
    // loading an arbitrarily large payload. A large or split active record is
    // unsupported here; never silently use an incomplete projection.
    let raw: Option<String> = connection.query_row(
        "SELECT CASE WHEN body_ref=0 AND octet_length(data_json)<=?2 THEN data_json END FROM orchestration_outbox WHERE id=?1",
        params![id, MAX_RECORD_BYTES as i64], |row| row.get(0),
    ).map_err(err)?;
    let raw =
        raw.ok_or_else(|| err("scheduler metadata outbox record exceeds limit or is split"))?;
    let value = record::parse(&raw)?;
    let matches_text =
        |field: &str, expected: &str| value.get(field) == Some(&JsValue::string(expected));
    if !matches_text("id", id)
        || !matches_text("sessionId", session)
        || !matches_text("state", state)
        || value.get("sequence") != Some(&JsValue::Number(sequence as f64))
    {
        return Err(err(
            "scheduler metadata indexed fields do not match the record",
        ));
    }
    Ok(match value.get("queueOrder") {
        Some(JsValue::Number(value)) if value.is_finite() => Some(*value),
        _ => None,
    })
}

fn page(
    connection: &Connection,
    session: &str,
    state: &str,
    after: Option<i64>,
    input: &Value,
) -> Result<Value> {
    let limit = input["limit"]
        .as_u64()
        .filter(|value| (1..=MAX_PAGE).contains(value))
        .ok_or_else(|| err("invalid scheduler metadata page limit"))?;
    // Walk indexed columns first and reject oversized identifiers before
    // copying them out of SQLite. Bounded record projection follows below.
    let sql = if after.is_some() {
        "SELECT CASE WHEN octet_length(id) <= 1024 THEN id END, sequence FROM orchestration_outbox INDEXED BY idx_orchestration_outbox_session WHERE session_id=?1 AND state=?2 AND sequence>?3 ORDER BY sequence LIMIT ?4"
    } else {
        "SELECT CASE WHEN octet_length(id) <= 1024 THEN id END, sequence FROM orchestration_outbox INDEXED BY idx_orchestration_outbox_session WHERE session_id=?1 AND state=?2 ORDER BY sequence LIMIT ?3"
    };
    let mut statement = connection.prepare(sql).map_err(err)?;
    let mut rows = if let Some(after) = after {
        statement
            .query(params![session, state, after, (limit + 1) as i64])
            .map_err(err)?
    } else {
        statement
            .query(params![session, state, (limit + 1) as i64])
            .map_err(err)?
    };
    let mut values = Vec::new();
    while let Some(row) = rows.next().map_err(err)? {
        let id: Option<String> = row.get(0).map_err(err)?;
        let id = id.ok_or_else(|| err("scheduler metadata identifier exceeds limit"))?;
        let sequence: i64 = row.get(1).map_err(err)?;
        if !(1..=MAX_SEQUENCE).contains(&sequence) {
            return Err(err("invalid scheduler metadata sequence"));
        }
        values.push((id, sequence));
    }
    drop(rows);
    drop(statement);
    let has_more = values.len() > limit as usize;
    if has_more {
        values.pop();
    }
    let next = if has_more {
        values.last().map(|row| row.1)
    } else {
        None
    };
    let mut projected = Vec::with_capacity(values.len());
    for (id, sequence) in values {
        let order = queue_order(connection, &id, session, state, sequence)?;
        projected.push(json!({"id": id, "sequence": sequence, "queueOrder": order}));
    }
    Ok(json!({"rows": projected, "nextSequence": next}))
}
