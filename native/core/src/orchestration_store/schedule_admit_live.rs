//! Rust-owned session-work admission. All durable decisions share one write
//! transaction with the versioned session state and outbox records.
use super::{
    err, header, meta, operation_admit, record, session_work_state, set_meta, write_record_json,
    Result, Store,
};
use crate::js::{js_to_number, js_to_string, truthy, JsString, JsValue};
use rusqlite::TransactionBehavior;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::time::{SystemTime, UNIX_EPOCH};

pub(super) fn field(value: &JsValue, name: &str) -> JsValue {
    value.get(name).cloned().unwrap_or(JsValue::Undefined)
}
pub(super) fn fallback(value: JsValue, otherwise: JsValue) -> JsValue {
    if truthy(&value) {
        value
    } else {
        otherwise
    }
}
fn nullish(value: JsValue) -> JsValue {
    if matches!(value, JsValue::Undefined | JsValue::Null) {
        JsValue::Null
    } else {
        value
    }
}
pub(super) fn put(value: &mut JsValue, key: &str, replacement: JsValue) -> Result<()> {
    let JsValue::Object(fields) = value else {
        return Err(err("session work object required"));
    };
    if let Some((_, old)) = fields.iter_mut().find(|(name, _)| name == key) {
        *old = replacement;
    } else {
        fields.push((key.into(), replacement));
    }
    Ok(())
}

fn required_initial_state(input: &Value) -> Result<session_work_state::EncodedState> {
    let raw = input
        .get("initialStateJson")
        .and_then(Value::as_str)
        .ok_or_else(|| err("session work state backfill requires a trusted snapshot"))?;
    let initial = record::parse(raw)?;
    if !matches!(initial, JsValue::Object(_)) {
        return Err(err("session work state backfill requires an object"));
    }
    let required = |name: &str| -> Result<String> {
        record::encode(
            initial
                .get(name)
                .ok_or_else(|| err(format!("session work state backfill requires {name}")))?,
        )
    };
    Ok(session_work_state::EncodedState {
        pending_question_json: required("pendingQuestion")?,
        active_turn_json: required("activeTurn")?,
        category_json: required("category")?,
    })
}

fn initialize_missing_state(
    tx: &rusqlite::Connection,
    session: &str,
    input: &Value,
    snapshot: Value,
) -> Result<Value> {
    if snapshot["exists"] == true {
        return Ok(snapshot);
    }
    let initial = required_initial_state(input)?;
    session_work_state::initialize_in_transaction(tx, session, &initial)
}
pub(super) fn is(value: &JsValue, text: &str) -> bool {
    value == &JsValue::string(text)
}
fn is_control(value: &JsValue) -> bool {
    [
        "answer",
        "approval",
        "callback",
        "continuation",
        "retry",
        "resume",
    ]
    .iter()
    .any(|text| is(value, text))
}
pub(super) fn kind(item: &JsValue) -> JsValue {
    let transfer = field(&field(item, "turnLineage"), "workKind");
    if truthy(&transfer) {
        return transfer;
    }
    let payload = field(item, "payload");
    let typ = field(&payload, "type");
    if is(&typ, "session.work") {
        return fallback(field(&payload, "workKind"), JsValue::string("task"));
    }
    if is(&typ, "dispatch.request") {
        return JsValue::string(
            if field(&payload, "taskStart") == JsValue::Bool(false)
                && truthy(&field(&payload, "taskId"))
            {
                "continuation"
            } else {
                "task"
            },
        );
    }
    if [
        "wait.result",
        "wait.callback",
        "wait.resolved",
        "detached.result",
        "dispatch.result",
        "task.interrupted",
    ]
    .iter()
    .any(|value| is(&typ, value))
    {
        return JsValue::string("callback");
    }
    JsValue::string(
        if field(&payload, "originContinue") == JsValue::Bool(true) {
            "continuation"
        } else {
            "task"
        },
    )
}
fn answer(item: &JsValue) -> bool {
    let payload = field(item, "payload");
    is(&field(&payload, "type"), "session.work")
        && is(&kind(item), "answer")
        && matches!(field(&payload, "requestId"), JsValue::String(ref id) if !id.is_empty())
}
fn queue_text(item: &JsValue) -> JsValue {
    let payload = field(item, "payload");
    let value = fallback(
        field(&payload, "message"),
        fallback(
            field(&payload, "taskText"),
            fallback(field(&payload, "deliveryText"), JsValue::string("")),
        ),
    );
    let text = js_to_string(&value);
    JsValue::String(JsString::from_units(
        text.as_units()[..text.len().min(20_000)].to_vec(),
    ))
}
fn client_id(item: &JsValue) -> JsValue {
    let id = field(&field(&field(item, "payload"), "options"), "clientMsgId");
    match &id {
        JsValue::String(s) if !s.trim().is_empty() => id,
        _ => JsValue::Null,
    }
}
pub(super) fn task_id(item: &JsValue) -> JsValue {
    let lineage = field(&field(item, "turnLineage"), "taskId");
    if truthy(&lineage) {
        return lineage;
    }
    let payload = field(item, "payload");
    if is(&field(&payload, "type"), "dispatch.result") {
        return JsValue::Null;
    }
    fallback(field(&payload, "taskId"), JsValue::Null)
}
pub(super) fn initial_schedule(session: &str, at: f64) -> JsValue {
    crate::js::from_serde(&json!({
        "sessionId":session,"state":"idle","freezeReason":null,"awaitingRequestId":null,
        "classifyState":null,"classifyStateAt":null,"priorityEntryId":null,"active":null,
        "lastDecision":null,"updatedAt":at
    }))
}

pub(super) fn related_control(schedule: &JsValue, active: &JsValue, item: &JsValue) -> bool {
    let work_kind = kind(item);
    if !is_control(&work_kind) {
        return false;
    }
    let payload = field(item, "payload");
    let typ = field(&payload, "type");
    if is(&typ, "session.work") {
        return true;
    }
    let entry = field(&payload, "activeEntryId");
    let task = field(&payload, "taskId");
    let active_task = field(active, "taskId");
    let task_mismatch = !is(&typ, "task.interrupted")
        && !is(&typ, "dispatch.result")
        && truthy(&task)
        && truthy(&active_task)
        && task != active_task;
    let request = field(schedule, "awaitingRequestId");
    let request_mismatch =
        is(&work_kind, "answer") && truthy(&request) && field(&payload, "requestId") != request;
    (!truthy(&entry) || entry == field(active, "entryId")) && !task_mismatch && !request_mismatch
}
fn rank(item: &JsValue) -> f64 {
    match field(item, "queueOrder") {
        JsValue::Number(n) if n.is_finite() => n,
        _ => f64::INFINITY,
    }
}
fn compare(a: &JsValue, b: &JsValue, priority: &JsValue) -> Ordering {
    let pa = field(a, "id") == *priority;
    let pb = field(b, "id") == *priority;
    if pa != pb {
        return if pa {
            Ordering::Less
        } else {
            Ordering::Greater
        };
    }
    let ra = rank(a);
    let rb = rank(b);
    if ra != rb {
        return ra.partial_cmp(&rb).unwrap_or(Ordering::Equal);
    }
    (js_to_number(&field(a, "sequence")) - js_to_number(&field(b, "sequence")))
        .partial_cmp(&0.0)
        .unwrap_or(Ordering::Equal)
}
fn schedule_classify(schedule: &JsValue) -> JsValue {
    let state = field(schedule, "classifyState");
    if ["P", "D", "W", "B", "E"].iter().any(|v| is(&state, v)) {
        return state;
    }
    let reason = field(schedule, "freezeReason");
    for (values, letter) in [
        (
            &["awaiting_user_input", "waiting", "classify_waiting"][..],
            "W",
        ),
        (&["awaiting_callback", "classify_background"][..], "B"),
        (
            &[
                "error",
                "classification_error",
                "unknown_interruption",
                "classify_error",
            ][..],
            "E",
        ),
    ] {
        if values.iter().any(|value| is(&reason, value)) {
            return JsValue::string(letter);
        }
    }
    JsValue::string(if truthy(&field(schedule, "active")) {
        "P"
    } else {
        "D"
    })
}
pub(super) fn queue_rows(
    connection: &rusqlite::Connection,
    session: &str,
    schedule: &JsValue,
) -> Result<Vec<JsValue>> {
    let mut statement = connection.prepare("SELECT id FROM orchestration_outbox WHERE session_id=?1 AND state IN ('pending','leased')").map_err(err)?;
    let ids: Vec<String> = statement
        .query_map([session], |row| row.get(0))
        .map_err(err)?
        .collect::<std::result::Result<_, _>>()
        .map_err(err)?;
    let active = field(schedule, "active");
    let active_id = fallback(field(&active, "deliveryId"), field(&active, "entryId"));
    let mut rows = Vec::new();
    for id in ids {
        let Some(raw) = record::get_json(connection, "outbox", &id, &[])? else {
            continue;
        };
        let item = record::parse(&raw)?;
        if field(&item, "sessionId") != JsValue::string(session) {
            continue;
        }
        let item_state = field(&item, "state");
        if !(is(&item_state, "pending") || is(&item_state, "leased")) {
            continue;
        }
        if truthy(&active_id) && field(&item, "id") == active_id {
            continue;
        }
        rows.push(item);
    }
    let priority = fallback(field(schedule, "priorityEntryId"), JsValue::Null);
    rows.sort_by(|a, b| compare(a, b, &priority));
    Ok(rows)
}
pub(super) fn public_schedule(
    connection: &rusqlite::Connection,
    schedule: &JsValue,
    queue: &[JsValue],
) -> Result<JsValue> {
    let priority = field(schedule, "priorityEntryId");
    let mut shown = Vec::new();
    for item in queue.iter().filter(|item| !answer(item)) {
        let payload = field(item, "payload");
        let last_error = field(item, "lastError");
        let error = if truthy(&last_error) {
            let value = js_to_string(&last_error);
            let end = value
                .as_units()
                .iter()
                .position(|unit| *unit == 10)
                .unwrap_or(value.len());
            let first = JsString::from_units(value.as_units()[..end].to_vec()).trim();
            JsValue::String(JsString::from_units(
                first.as_units()[..first.len().min(160)].to_vec(),
            ))
        } else {
            JsValue::Null
        };
        let attempts = js_to_number(&field(item, "attempts"));
        let attempts = if attempts == 0.0 || attempts.is_nan() {
            0.0
        } else {
            attempts
        };
        shown.push(JsValue::object(vec![
            ("entryId", field(item, "id")),
            ("taskId", task_id(item)),
            (
                "source",
                fallback(
                    field(&payload, "source"),
                    fallback(
                        field(&field(item, "source"), "type"),
                        JsValue::string("legacy"),
                    ),
                ),
            ),
            ("sequence", field(item, "sequence")),
            ("state", field(item, "state")),
            ("workKind", kind(item)),
            ("priority", JsValue::Bool(field(item, "id") == priority)),
            ("position", JsValue::Number((shown.len() + 1) as f64)),
            ("admittedAt", field(item, "createdAt")),
            ("clientMsgId", client_id(item)),
            ("text", queue_text(item)),
            ("attempts", JsValue::Number(attempts)),
            ("lastError", error),
        ]));
    }
    let mut active = fallback(field(schedule, "active"), JsValue::Null);
    if truthy(&active) && !truthy(&field(&active, "startedAt")) {
        let id = fallback(field(&active, "deliveryId"), field(&active, "entryId"));
        if let JsValue::String(value) = id {
            if value.is_well_formed() {
                if let Some(raw) =
                    record::get_json(connection, "outbox", &value.to_string_lossy(), &[])?
                {
                    let item = record::parse(&raw)?;
                    let client = client_id(&item);
                    if truthy(&client) {
                        put(&mut active, "clientMsgId", client)?;
                        put(&mut active, "text", queue_text(&item))?;
                    }
                }
            }
        }
    }
    Ok(JsValue::object(vec![
        ("sessionId", field(schedule, "sessionId")),
        ("state", field(schedule, "state")),
        (
            "freezeReason",
            fallback(field(schedule, "freezeReason"), JsValue::Null),
        ),
        (
            "awaitingRequestId",
            fallback(field(schedule, "awaitingRequestId"), JsValue::Null),
        ),
        ("classifyState", schedule_classify(schedule)),
        ("active", active),
        ("queued", JsValue::Array(shown)),
        (
            "lastDecision",
            fallback(field(schedule, "lastDecision"), JsValue::Null),
        ),
        ("updatedAt", field(schedule, "updatedAt")),
    ]))
}

/// Apply a queue reorder under the SQLite owner lock. The caller supplies
/// already-observed scalar inputs; all queue reads and writes stay here.
pub(super) fn reorder_check(connection: &rusqlite::Connection, input: &Value) -> Result<Value> {
    let session = input["sessionId"]
        .as_str()
        .ok_or_else(|| err("schedule reorder requires sessionId"))?;
    let entry = input["entryId"]
        .as_str()
        .ok_or_else(|| err("schedule reorder requires entryId"))?;
    let Some(raw) = record::get_json(connection, "outbox", entry, &[])? else {
        return Ok(json!({"ok":false,"code":"queued_entry_not_found"}));
    };
    let item = record::parse(&raw)?;
    if field(&item, "sessionId") != JsValue::string(session) {
        return Ok(json!({"ok":false,"code":"queued_entry_not_found"}));
    }
    let raw_schedule = record::get_json(connection, "sessionSchedules", session, &[])?;
    let schedule_missing = raw_schedule.is_none();
    let schedule = raw_schedule
        .map(|raw| record::parse(&raw))
        .transpose()?
        .unwrap_or(JsValue::Null);
    let active = field(&schedule, "active");
    if field(&active, "entryId") == JsValue::string(entry)
        || field(&active, "deliveryId") == JsValue::string(entry)
        || is(&field(&item, "state"), "leased")
    {
        return Ok(
            json!({"ok":false,"code":"queued_entry_already_claimed","scheduleObserved":true,"scheduleMissing":schedule_missing}),
        );
    }
    if !is(&field(&item, "state"), "pending") {
        return Ok(
            json!({"ok":false,"code":"queued_entry_not_pending","scheduleObserved":true,"scheduleMissing":schedule_missing}),
        );
    }
    if answer(&item) {
        return Ok(
            json!({"ok":false,"code":"queued_entry_not_found","scheduleObserved":true,"scheduleMissing":schedule_missing}),
        );
    }
    Ok(json!({"ok":true}))
}

pub(super) fn reorder(store: &mut Store, input: &Value) -> Result<Value> {
    if store.active || store.pending {
        return Err(err("schedule reorder requires an idle owner connection"));
    }
    let session = input["sessionId"]
        .as_str()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| err("schedule reorder requires sessionId"))?;
    let entry = input["entryId"]
        .as_str()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| err("schedule reorder requires entryId"))?;
    let expected = input["expectedRevision"]
        .as_u64()
        .ok_or_else(|| err("expectedRevision required"))?;
    let at = input["at"]
        .as_i64()
        .ok_or_else(|| err("schedule reorder clock required"))?;
    let ensured_at = input["ensuredAt"]
        .as_i64()
        .ok_or_else(|| err("schedule reorder initial clock required"))?;
    let connection = store
        .connection
        .as_mut()
        .ok_or_else(|| err("database closed"))?;
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(err)?;
    let revision = meta(&tx, "revision")?
        .as_u64()
        .ok_or_else(|| err("invalid revision"))?;
    if revision != expected {
        return Err(format!(
            "ORCHESTRATION_SQLITE_CONFLICT:{expected}:{revision}"
        ));
    }
    let snapshot = session_work_state::snapshot_in_write_transaction(&tx, session)?;
    if let Some(version) = input.get("expectedVersion") {
        if version.as_u64() != snapshot["version"].as_u64() {
            return Err(err("session work state version conflict"));
        }
    }
    let snapshot = initialize_missing_state(&tx, session, input, snapshot)?;
    let Some(raw) = record::get_json(&tx, "outbox", entry, &[])? else {
        return Ok(json!({"resultJson":"{\"ok\":false,\"code\":\"queued_entry_not_found\"}"}));
    };
    let item = record::parse(&raw)?;
    if field(&item, "sessionId") != JsValue::string(session) {
        return Ok(json!({"resultJson":"{\"ok\":false,\"code\":\"queued_entry_not_found\"}"}));
    }
    let prior_schedule = record::get_json(&tx, "sessionSchedules", session, &[])?;
    let schedule_missing = prior_schedule.is_none();
    let mut schedule = match prior_schedule {
        Some(raw) => record::parse(&raw)?,
        None => initial_schedule(session, ensured_at as f64),
    };
    let active = field(&schedule, "active");
    let rejected = if field(&active, "entryId") == JsValue::string(entry)
        || field(&active, "deliveryId") == JsValue::string(entry)
        || is(&field(&item, "state"), "leased")
    {
        Some("queued_entry_already_claimed")
    } else if !is(&field(&item, "state"), "pending") {
        Some("queued_entry_not_pending")
    } else if answer(&item) {
        Some("queued_entry_not_found")
    } else {
        None
    };
    if let Some(code) = rejected {
        if schedule_missing {
            if revision >= 9_007_199_254_740_991 {
                return Err(err("schedule revision exhausted"));
            }
            write_record_json(
                &tx,
                "sessionSchedules",
                session,
                &record::encode(&schedule)?,
            )?;
            set_meta(&tx, "revision", &json!(revision + 1))?;
            set_meta(&tx, "updatedAt", &json!(at))?;
        }
        let new_header = header(&tx)?;
        tx.commit().map_err(err)?;
        return Ok(
            json!({"resultJson":json!({"ok":false,"code":code}).to_string(),"state":new_header}),
        );
    }
    let queue = queue_rows(&tx, session, &schedule)?;
    let mut visible: Vec<JsValue> = queue.iter().filter(|item| !answer(item)).cloned().collect();
    let Some(from) = visible
        .iter()
        .position(|row| field(row, "id") == JsValue::string(entry))
    else {
        return Ok(json!({"resultJson":"{\"ok\":false,\"code\":\"queued_entry_not_found\"}"}));
    };
    let requested = match input["direction"].as_str() {
        Some("up") => from as i64 - 1,
        Some("down") => from as i64 + 1,
        _ => input["toIndex"]
            .as_f64()
            .filter(|n| n.is_finite())
            .map_or(from as i64, |n| n.trunc() as i64),
    };
    let to = requested.clamp(0, visible.len() as i64 - 1) as usize;
    let unchanged = to == from;
    if !unchanged {
        let selected = visible.remove(from);
        visible.insert(to, selected);
        for (index, row) in visible.iter_mut().enumerate() {
            put(row, "queueOrder", JsValue::Number(index as f64))?;
            put(row, "updatedAt", JsValue::Number(at as f64))?;
            let id = match field(row, "id") {
                JsValue::String(id) if id.is_well_formed() => id.to_string_lossy(),
                _ => return Err(err("invalid queue entry id")),
            };
            write_record_json(&tx, "outbox", &id, &record::encode(row)?)?;
        }
        put(&mut schedule, "updatedAt", JsValue::Number(at as f64))?;
        write_record_json(
            &tx,
            "sessionSchedules",
            session,
            &record::encode(&schedule)?,
        )?;
    }
    if unchanged && schedule_missing {
        write_record_json(
            &tx,
            "sessionSchedules",
            session,
            &record::encode(&schedule)?,
        )?;
    }
    if !unchanged || schedule_missing {
        if revision >= 9_007_199_254_740_991 {
            return Err(err("schedule revision exhausted"));
        }
        set_meta(&tx, "revision", &json!(revision + 1))?;
        set_meta(&tx, "updatedAt", &json!(at))?;
    }
    let next = if unchanged {
        queue
    } else {
        queue_rows(&tx, session, &schedule)?
    };
    let actual_to = next
        .iter()
        .filter(|row| !answer(row))
        .position(|row| field(row, "id") == JsValue::string(entry))
        .unwrap_or(to);
    let actor_raw = input["actorJson"]
        .as_str()
        .ok_or_else(|| err("schedule reorder actor required"))?;
    let JsValue::String(actor) = record::parse(actor_raw)? else {
        return Err(err("invalid schedule reorder actor"));
    };
    let actor = JsString::from_units(actor.as_units()[..actor.len().min(80)].to_vec());
    let result = JsValue::object(vec![
        ("ok", JsValue::Bool(true)),
        ("unchanged", JsValue::Bool(unchanged)),
        (
            "reordered",
            JsValue::object(vec![
                ("entryId", JsValue::string(entry)),
                ("from", JsValue::Number(from as f64)),
                ("to", JsValue::Number(actual_to as f64)),
                ("actor", JsValue::String(actor)),
                ("at", JsValue::Number(at as f64)),
            ]),
        ),
        ("schedule", public_schedule(&tx, &schedule, &next)?),
    ]);
    let result_json = record::encode(&result)?;
    let new_header = header(&tx)?;
    tx.commit().map_err(err)?;
    Ok(json!({"resultJson":result_json,"snapshot":snapshot,"state":new_header}))
}

fn completion_guard(schedule: &JsValue, expected_task: &JsValue) -> Option<&'static str> {
    let completed = field(schedule, "active");
    if !truthy(&completed) {
        return Some("no_active_task");
    }
    let task = field(&completed, "taskId");
    if truthy(expected_task) && truthy(&task) && *expected_task != task {
        return Some("active_task_mismatch");
    }
    None
}

/// Capture the facts and connection-local data version without authorizing a
/// later write. A concurrent commit during capture makes the token invalid.
pub(super) fn completion_token(store: &mut Store, input: &Value) -> Result<Value> {
    if store.active || store.pending {
        return Err(err("schedule completion requires an idle owner connection"));
    }
    let session = input["sessionId"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| err("schedule completion requires sessionId"))?;
    let expected_task = match input.get("expectedTaskIdJson") {
        Some(value) => record::parse(
            value
                .as_str()
                .ok_or_else(|| err("invalid expectedTaskIdJson"))?,
        )?,
        None => JsValue::Null,
    };
    let db = store.conn()?;
    let before: i64 = db
        .query_row("PRAGMA data_version", [], |row| row.get(0))
        .map_err(err)?;
    db.execute_batch("BEGIN").map_err(err)?;
    let result = (|| {
        let current_header = header(db)?;
        let schedule = record::get_json(db, "sessionSchedules", session, &[])?
            .map(|raw| record::parse(&raw))
            .transpose()?
            .unwrap_or(JsValue::Null);
        let guard = match completion_guard(&schedule, &expected_task) {
            Some(code) => json!({"ok":false,"code":code}),
            None => json!({"ok":true}),
        };
        let snapshot = session_work_state::encoded_read(db, input)?;
        if guard["ok"] == true && snapshot["exists"] != true {
            required_initial_state(input)?;
        }
        Ok((current_header, snapshot, guard))
    })();
    if result.is_err() {
        let _ = db.execute_batch("ROLLBACK");
        return result.map(|_| Value::Null);
    }
    if let Err(error) = db.execute_batch("COMMIT") {
        let _ = db.execute_batch("ROLLBACK");
        return Err(err(error));
    }
    let after: i64 = db
        .query_row("PRAGMA data_version", [], |row| row.get(0))
        .map_err(err)?;
    if before != after {
        return Err(err("schedule completion database version conflict"));
    }
    let (state, snapshot, guard) = result?;
    Ok(json!({"state":state,"snapshot":snapshot,"guard":guard,"dataVersion":after}))
}

/// Experimental completion owner. Not connected to the live scheduler until
/// all session facts are written through the same versioned owner.
pub(super) fn complete(store: &mut Store, input: &Value) -> Result<Value> {
    complete_inner(store, input, false, || {})
}

/// Capture the version and perform the completion while holding one write
/// transaction. No caller-visible token exists between observation and commit.
pub(super) fn complete_atomic(store: &mut Store, input: &Value) -> Result<Value> {
    complete_inner(store, input, true, || {})
}

/// Preserve the frozen read-then-validate ordering inside one synchronous
/// owner call. External writers may commit after the read; in that case the
/// write transaction rejects the stale SQLite snapshot without retrying.
pub(super) fn complete_frozen(store: &mut Store, input: &Value) -> Result<Value> {
    complete_frozen_inner(store, input, || {})
}

fn complete_frozen_inner(
    store: &mut Store,
    input: &Value,
    after_snapshot: impl FnOnce(),
) -> Result<Value> {
    if store.active || store.pending {
        return Err(err("schedule completion requires an idle owner connection"));
    }
    let session = input["sessionId"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| err("schedule completion requires sessionId"))?;
    let expected_task = record::parse(
        input["expectedTaskIdJson"]
            .as_str()
            .ok_or_else(|| err("expectedTaskIdJson required"))?,
    )?;
    let db = store.conn()?;
    let data_version: i64 = db
        .query_row("PRAGMA data_version", [], |row| row.get(0))
        .map_err(err)?;
    db.execute_batch("BEGIN").map_err(err)?;
    let read = (|| {
        let revision = meta(db, "revision")?
            .as_u64()
            .ok_or_else(|| err("invalid revision"))?;
        let schedule = record::get_json(db, "sessionSchedules", session, &[])?
            .map(|raw| record::parse(&raw))
            .transpose()?
            .unwrap_or(JsValue::Null);
        let guard = completion_guard(&schedule, &expected_task);
        let snapshot = session_work_state::encoded_read(db, input)?;
        if guard.is_none() && snapshot["exists"] != true {
            required_initial_state(input)?;
        }
        let version = snapshot["version"]
            .as_u64()
            .ok_or_else(|| err("invalid session work state version"))?;
        Ok((revision, version, guard))
    })();
    let (revision, version, guard) = match read {
        Ok(value) => value,
        Err(error) => {
            let _ = db.execute_batch("ROLLBACK");
            return Err(error);
        }
    };
    if let Some(code) = guard {
        db.execute_batch("ROLLBACK").map_err(err)?;
        return Ok(json!({"resultJson":json!({"ok":false,"code":code}).to_string()}));
    }
    after_snapshot();
    db.execute_batch("ROLLBACK").map_err(err)?;
    let mut command = input.clone();
    let object = command
        .as_object_mut()
        .ok_or_else(|| err("schedule completion input must be an object"))?;
    object.insert("expectedRevision".into(), json!(revision));
    object.insert("expectedVersion".into(), json!(version));
    object.insert("expectedDataVersion".into(), json!(data_version));
    match complete(store, &command) {
        Err(error) if error == err("schedule completion database version conflict") => {
            let actual = meta(store.conn()?, "revision")?;
            Err(format!("ORCHESTRATION_SQLITE_CONFLICT:{revision}:{actual}"))
        }
        result => result,
    }
}

fn complete_inner(
    store: &mut Store,
    input: &Value,
    atomic: bool,
    after_snapshot: impl FnOnce(),
) -> Result<Value> {
    if store.active || store.pending {
        return Err(err("schedule completion requires an idle owner connection"));
    }
    let session = input["sessionId"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| err("schedule completion requires sessionId"))?;
    let expected = if atomic {
        None
    } else {
        Some((
            input["expectedRevision"]
                .as_u64()
                .ok_or_else(|| err("expectedRevision required"))?,
            input["expectedVersion"]
                .as_u64()
                .ok_or_else(|| err("expectedVersion required"))?,
            input["expectedDataVersion"]
                .as_i64()
                .ok_or_else(|| err("expectedDataVersion required"))?,
        ))
    };
    let at = input["at"]
        .as_i64()
        .ok_or_else(|| err("completion clock required"))?;
    let updated_at = input["updatedAt"]
        .as_i64()
        .ok_or_else(|| err("store clock required"))?;
    let decode = |name: &str| -> Result<JsValue> {
        record::parse(
            input[name]
                .as_str()
                .ok_or_else(|| err(format!("{name} required")))?,
        )
    };
    let expected_task = decode("expectedTaskIdJson")?;
    let reason = decode("reasonJson")?;
    let class = decode("classifyStateJson")?;
    let awaiting = decode("awaitingRequestIdJson")?;
    let db = store
        .connection
        .as_mut()
        .ok_or_else(|| err("database closed"))?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(err)?;
    let revision = meta(&tx, "revision")?
        .as_u64()
        .ok_or_else(|| err("invalid revision"))?;
    let data_version: i64 = tx
        .query_row("PRAGMA data_version", [], |row| row.get(0))
        .map_err(err)?;
    if let Some((expected_revision, _, expected_data_version)) = expected {
        if revision != expected_revision {
            return Err(format!(
                "ORCHESTRATION_SQLITE_CONFLICT:{expected_revision}:{revision}"
            ));
        }
        if data_version != expected_data_version {
            return Err(err("schedule completion database version conflict"));
        }
    }
    let snapshot = session_work_state::snapshot_in_write_transaction(&tx, session)?;
    if let Some((_, expected_version, _)) = expected {
        if snapshot["version"].as_u64() != Some(expected_version) {
            return Err(err("session work state version conflict"));
        }
    }
    let snapshot = initialize_missing_state(&tx, session, input, snapshot)?;
    after_snapshot();
    let mut schedule = record::get_json(&tx, "sessionSchedules", session, &[])?
        .map(|raw| record::parse(&raw))
        .transpose()?
        .unwrap_or(JsValue::Null);
    if let Some(code) = completion_guard(&schedule, &expected_task) {
        return Ok(json!({"resultJson":json!({"ok":false,"code":code}).to_string()}));
    }
    let completed = field(&schedule, "active");
    let task = field(&completed, "taskId");
    if revision >= 9_007_199_254_740_991 {
        return Err(err("schedule revision exhausted"));
    }
    let terminal = is(&class, "D");
    let class = if crate::classify_vocab::CLASSIFY_STATES
        .iter()
        .any(|value| is(&class, value))
    {
        class
    } else {
        JsValue::string("D")
    };
    put(&mut schedule, "active", JsValue::Null)?;
    put(&mut schedule, "state", JsValue::string("idle"))?;
    put(&mut schedule, "freezeReason", JsValue::Null)?;
    put(
        &mut schedule,
        "awaitingRequestId",
        if !terminal && truthy(&awaiting) {
            JsValue::String(js_to_string(&awaiting))
        } else {
            JsValue::Null
        },
    )?;
    if field(&schedule, "priorityEntryId") == field(&completed, "entryId") {
        put(&mut schedule, "priorityEntryId", JsValue::Null)?;
    }
    put(&mut schedule, "classifyState", class.clone())?;
    put(&mut schedule, "classifyStateAt", JsValue::Number(at as f64))?;
    // Admission reads the same durable category. Commit the new classify
    // letter with the scheduler transition so it cannot keep seeing the P
    // from beginTurn after a completed W/D turn.
    let category_raw = snapshot["categoryJson"]
        .as_str()
        .ok_or_else(|| err("invalid session work category"))?;
    let old_category = record::parse(category_raw)?;
    let mut category = match old_category.clone() {
        value @ JsValue::Object(_) => value,
        JsValue::Null => JsValue::Object(vec![]),
        JsValue::String(_) => old_category.clone(),
        _ => return Err(err("invalid session work category")),
    };
    if matches!(category, JsValue::String(_)) {
        category = class.clone();
    } else {
        put(&mut category, "classifyState", class.clone())?;
    }
    if category != old_category {
        let encoded = session_work_state::EncodedState {
            pending_question_json: snapshot["pendingQuestionJson"]
                .as_str()
                .ok_or_else(|| err("invalid pending question"))?
                .to_owned(),
            active_turn_json: snapshot["activeTurnJson"]
                .as_str()
                .ok_or_else(|| err("invalid active turn"))?
                .to_owned(),
            category_json: record::encode(&category)?,
        };
        session_work_state::write_in_transaction(
            &tx,
            session,
            snapshot["version"]
                .as_u64()
                .ok_or_else(|| err("invalid session work version"))?,
            &encoded,
        )?;
    }
    let pending_raw = snapshot["pendingQuestionJson"]
        .as_str()
        .ok_or_else(|| err("invalid pending question"))?;
    let pending = record::parse(pending_raw)?;
    let request_id = field(&pending, "requestId");
    if is(&class, "W")
        && truthy(&pending)
        && field(&pending, "resolved") != JsValue::Bool(true)
        && truthy(&request_id)
    {
        let request_id = JsValue::String(js_to_string(&request_id));
        let mut statement = tx
            .prepare("SELECT id FROM orchestration_outbox WHERE session_id=?1 AND state='pending'")
            .map_err(err)?;
        let ids: Vec<String> = statement
            .query_map([session], |row| row.get(0))
            .map_err(err)?
            .collect::<std::result::Result<_, _>>()
            .map_err(err)?;
        drop(statement);
        for id in ids {
            let Some(raw) = record::get_json(&tx, "outbox", &id, &[])? else {
                continue;
            };
            let mut item = record::parse(&raw)?;
            if field(&item, "sessionId") != JsValue::string(session)
                || !is(&field(&item, "state"), "pending")
            {
                continue;
            }
            if (answer(&item) && field(&field(&item, "payload"), "requestId") == request_id)
                || field(&item, "userInputOverrideId") == request_id
            {
                continue;
            }
            put(&mut item, "directRun", JsValue::Bool(false))?;
            put(&mut item, "blockedByUserInput", request_id.clone())?;
            write_record_json(&tx, "outbox", &id, &record::encode(&item)?)?;
        }
    }
    let superseded = field(&completed, "supersededByEntryId");
    let superseded_truthy = truthy(&superseded);
    put(
        &mut schedule,
        "lastDecision",
        JsValue::object(vec![
            (
                "action",
                JsValue::string(if superseded_truthy {
                    "superseded"
                } else {
                    "complete"
                }),
            ),
            (
                "reason",
                if superseded_truthy {
                    JsValue::string("superseded_by_immediate_insert")
                } else {
                    reason
                },
            ),
            ("entryId", field(&completed, "entryId")),
            ("taskId", fallback(task, JsValue::Null)),
            (
                "originDispatchId",
                fallback(field(&completed, "originDispatchId"), JsValue::Null),
            ),
            ("supersededByEntryId", fallback(superseded, JsValue::Null)),
            ("at", JsValue::Number(at as f64)),
        ]),
    )?;
    put(&mut schedule, "updatedAt", JsValue::Number(at as f64))?;
    write_record_json(
        &tx,
        "sessionSchedules",
        session,
        &record::encode(&schedule)?,
    )?;
    set_meta(&tx, "revision", &json!(revision + 1))?;
    set_meta(&tx, "updatedAt", &json!(updated_at))?;
    let queue = queue_rows(&tx, session, &schedule)?;
    let result = JsValue::object(vec![
        ("ok", JsValue::Bool(true)),
        ("advanced", JsValue::Bool(true)),
        ("completed", completed),
        ("schedule", public_schedule(&tx, &schedule, &queue)?),
    ]);
    let result_json = record::encode(&result)?;
    let new_header = header(&tx)?;
    tx.commit().map_err(err)?;
    let observed_version = snapshot["version"].clone();
    Ok(
        json!({"resultJson":result_json,"snapshot":snapshot,"state":new_header,
        "observedToken":{"revision":revision,"version":observed_version,"dataVersion":data_version}}),
    )
}

fn allowed(item: &JsValue, class: &JsValue) -> bool {
    let k = kind(item);
    let typ = field(&field(item, "payload"), "type");
    if is(&typ, "session.work") || is(&typ, "dispatch.result") {
        return !is(class, "P") && !is(class, "C");
    }
    let set: &[&str] = if is(class, "W") {
        &["answer", "approval", "continuation"]
    } else if is(class, "B") {
        &["callback", "continuation"]
    } else if is(class, "E") {
        &["retry", "resume"]
    } else {
        &[]
    };
    set.iter().any(|name| is(&k, name))
}

fn select(
    queue: &[JsValue],
    schedule: &JsValue,
    pending: &JsValue,
    category: &JsValue,
    now: i64,
) -> Result<JsValue> {
    let active = field(schedule, "active");
    let active_id = fallback(field(&active, "deliveryId"), field(&active, "entryId"));
    let class = {
        let candidate = if matches!(category, JsValue::String(_)) {
            category.clone()
        } else {
            field(category, "classifyState")
        };
        if ["P", "D", "W", "B", "E"]
            .iter()
            .any(|value| is(&candidate, value))
        {
            candidate
        } else {
            schedule_classify(schedule)
        }
    };
    let pending_id = field(pending, "requestId");
    let has_pending =
        truthy(pending) && field(pending, "resolved") != JsValue::Bool(true) && truthy(&pending_id);
    let unattended = field(category, "unattended");
    if truthy(&unattended) && !queue.is_empty() {
        let mut rows = Vec::with_capacity(queue.len());
        for item in queue {
            let payload = field(item, "payload");
            let options = field(&payload, "options");
            let message = js_to_string(&fallback(field(&payload, "message"), JsValue::string("")));
            rows.push(JsValue::object(vec![
                ("id", field(item, "id")),
                ("workKind", kind(item)),
                ("requestId", field(&payload, "requestId")),
                ("unattendedSystem", field(&options, "unattendedSystem")),
                ("unattendedRecovery", field(&options, "unattendedRecovery")),
                (
                    "taskSource",
                    fallback(field(&options, "taskSource"), field(&payload, "source")),
                ),
                (
                    "message",
                    JsValue::String(JsString::from_units(
                        message.as_units()[..message.len().min(160)].to_vec(),
                    )),
                ),
            ]));
        }
        let mut request = JsValue::object(vec![
            ("state", unattended),
            ("now", JsValue::Number(now as f64)),
            (
                "hasActive",
                JsValue::Bool(truthy(&active) && !is(&field(schedule, "state"), "idle")),
            ),
            ("classifyState", class.clone()),
            (
                "pendingRequestId",
                if has_pending {
                    pending_id.clone()
                } else {
                    JsValue::Null
                },
            ),
            ("items", JsValue::Array(rows)),
        ]);
        let run_active = field(category, "runActive");
        if matches!(run_active, JsValue::Bool(_)) {
            put(&mut request, "runActive", run_active)?;
        }
        let result = crate::unattended::select_queued(&record::encode(&request)?).map_err(err)?;
        let result = record::parse(&result)?;
        if field(&result, "handled") == JsValue::Bool(true) {
            let id = field(&result, "entryId");
            return Ok(queue
                .iter()
                .find(|item| field(item, "id") == id)
                .map_or(JsValue::Null, |item| field(item, "id")));
        }
    }
    let mut eligible = Vec::new();
    for item in queue {
        let id = field(item, "id");
        let replay = truthy(&active) && truthy(&active_id) && id == active_id;
        let request = field(&field(item, "payload"), "requestId");
        let keep = !has_pending
            || replay
            || (answer(item) && request == pending_id)
            || field(item, "userInputOverrideId") == pending_id;
        if keep {
            eligible.push(item);
            continue;
        }
        let queue_state = field(schedule, "state");
        if field(item, "blockedByUserInput") == pending_id
            || (truthy(&active)
                && ["starting", "running", "assessing"]
                    .iter()
                    .any(|v| is(&queue_state, v)))
        {
            continue;
        }
        let created = field(pending, "createdAt");
        if !truthy(&created) || js_to_number(&field(item, "createdAt")) > js_to_number(&created) {
            eligible.push(item);
        }
    }
    if !truthy(&active) || is(&field(schedule, "state"), "idle") {
        if !is(&class, "P") && !is(&class, "C") {
            if let Some(item) = eligible
                .iter()
                .find(|item| truthy(&field(item, "directRun")))
            {
                return Ok(field(item, "id"));
            }
            if let Some(item) = eligible
                .iter()
                .find(|item| is_control(&kind(item)) && allowed(item, &class))
            {
                return Ok(field(item, "id"));
            }
        }
        return Ok(if is(&class, "D") {
            eligible
                .first()
                .map_or(JsValue::Null, |item| field(item, "id"))
        } else {
            JsValue::Null
        });
    }
    if let Some(item) = eligible
        .iter()
        .find(|item| truthy(&active_id) && field(item, "id") == active_id)
    {
        return Ok(field(item, "id"));
    }
    for item in eligible {
        if related_control(schedule, &active, item) && allowed(item, &class) {
            return Ok(field(item, "id"));
        }
    }
    Ok(JsValue::Null)
}

pub(super) fn commit(store: &mut Store, input: &Value) -> Result<Value> {
    if store.active || store.pending {
        return Err(err("schedule admission requires an idle owner connection"));
    }
    let raw = input["requestJson"]
        .as_str()
        .ok_or_else(|| err("admission request required"))?;
    let request = record::parse(raw)?;
    let session_value = field(&request, "sessionId");
    let session = js_to_string(&fallback(session_value, JsValue::string(""))).trim();
    if session.is_empty() || !session.is_well_formed() {
        return Err(err("session work requires sessionId"));
    }
    let session = session.to_string_lossy();
    let text = js_to_string(&fallback(field(&request, "text"), JsValue::string(""))).trim();
    if text.is_empty() {
        return Err(err("session work requires text"));
    }
    let options = match field(&request, "options") {
        JsValue::Undefined => JsValue::Object(Vec::new()),
        value @ JsValue::Object(_) => record::parse(&operation_admit::canonical(&value)?)?,
        _ => return Err(err("session work options must be an object")),
    };
    let connection = store
        .connection
        .as_mut()
        .ok_or_else(|| err("database closed"))?;
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(err)?;
    let expected_revision = input["expectedRevision"]
        .as_u64()
        .ok_or_else(|| err("expectedRevision required"))?;
    let revision = meta(&tx, "revision")?
        .as_u64()
        .ok_or_else(|| err("invalid revision"))?;
    if revision != expected_revision {
        return Err(format!(
            "ORCHESTRATION_SQLITE_CONFLICT:{expected_revision}:{revision}"
        ));
    }
    let mut state = session_work_state::snapshot_in_write_transaction(&tx, &session)?;
    if let Some(expected) = request.get("expectedVersion") {
        let JsValue::Number(expected) = expected else {
            return Err(err("invalid session work state expectedVersion"));
        };
        if !expected.is_finite()
            || *expected < 0.0
            || expected.fract() != 0.0
            || *expected > 9_007_199_254_740_991.0
            || state["version"].as_f64() != Some(*expected)
        {
            return Err(err("session work state version conflict"));
        }
    }
    if state["exists"] != true {
        let initial = request
            .get("initialState")
            .ok_or_else(|| err("session work state backfill requires a trusted snapshot"))?;
        let required = |name: &str| -> Result<String> {
            record::encode(
                initial
                    .get(name)
                    .ok_or_else(|| err(format!("session work state backfill requires {name}")))?,
            )
        };
        let seed = session_work_state::EncodedState {
            pending_question_json: required("pendingQuestion")?,
            active_turn_json: required("activeTurn")?,
            category_json: required("category")?,
        };
        state = session_work_state::initialize_in_transaction(&tx, &session, &seed)?;
    }
    let mut encoded_state: session_work_state::EncodedState = serde_json::from_value(json!({
        "pendingQuestionJson":state["pendingQuestionJson"], "activeTurnJson":state["activeTurnJson"], "categoryJson":state["categoryJson"],
    })).map_err(err)?;
    let pending_raw = record::parse(&encoded_state.pending_question_json)?;
    let pending_id = field(&pending_raw, "requestId");
    let pending = if truthy(&pending_raw)
        && field(&pending_raw, "resolved") != JsValue::Bool(true)
        && truthy(&pending_id)
    {
        let mut p = pending_raw.clone();
        put(
            &mut p,
            "requestId",
            JsValue::String(js_to_string(&pending_id)),
        )?;
        p
    } else {
        JsValue::Null
    };
    let active_turn = record::parse(&encoded_state.active_turn_json)?;
    let category = record::parse(&encoded_state.category_json)?;
    let now = match input.get("now") {
        Some(value) => value
            .as_i64()
            .ok_or_else(|| err("invalid admission clock"))?,
        None => SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(err)?
            .as_millis() as i64,
    };
    let mut schedule = match record::get_json(&tx, "sessionSchedules", &session, &[])? {
        Some(raw) => record::parse(&raw)?,
        None => initial_schedule(&session, now as f64),
    };
    if !matches!(schedule, JsValue::Object(_))
        || field(&schedule, "sessionId") != JsValue::string(&session)
    {
        return Err(err("invalid session schedule"));
    }
    // The client carries its answer correlation in options. Decide against the
    // snapshot read under this transaction, never against a Node callback.
    let mut options = options;
    let host_admission = field(&request, "hostAdmission") == JsValue::Bool(true);
    let source = fallback(
        field(&request, "source"),
        fallback(
            field(&options, "taskSource"),
            JsValue::string(if field(&options, "originTrigger") == JsValue::Bool(true) {
                "trigger"
            } else if host_admission && field(&options, "originContinue") == JsValue::Bool(true) {
                "continuation"
            } else {
                "direct"
            }),
        ),
    );
    let policy = crate::unattended::decide_turn_end(&record::encode(&JsValue::object(vec![
        ("state", field(&category, "unattended")),
        ("kind", JsValue::string("user_input")),
        ("source", source.clone()),
        ("options", options.clone()),
    ]))?)
    .map_err(err)?;
    let policy = record::parse(&policy)?;
    let queue_input = host_admission && field(&policy, "queueInput") == JsValue::Bool(true);
    let requested = field(&options, "userInputRequestId");
    let requested = if matches!(&requested, JsValue::String(_)) {
        JsValue::String(js_to_string(&requested).trim())
    } else {
        JsValue::Null
    };
    let shell_answer = is(
        &field(&field(&options, "taskShellControl"), "intent"),
        "answer",
    );
    let option_answer = host_admission
        && !queue_input
        && truthy(&requested)
        && (field(&pending_raw, "requestId") == requested || shell_answer);
    if host_admission && (queue_input || !option_answer) {
        if let JsValue::Object(fields) = &mut options {
            fields.retain(|(key, _)| {
                key != "userInputRequestId" && (!queue_input || key != "taskShellControl")
            });
        }
    }
    if option_answer
        && !truthy(&field(&options, "taskId"))
        && truthy(&field(&pending_raw, "taskId"))
    {
        put(&mut options, "taskId", field(&pending_raw, "taskId"))?;
    }
    let request_id = if queue_input {
        JsValue::Null
    } else {
        fallback(
            field(&request, "requestId"),
            if option_answer {
                requested
            } else {
                JsValue::Null
            },
        )
    };
    let requested_kind = field(&request, "workKind");
    let work_kind = if queue_input {
        JsValue::string("task")
    } else if truthy(&requested_kind) {
        requested_kind
    } else if truthy(&request_id) {
        JsValue::string("answer")
    } else if host_admission
        && is(&source, "direct")
        && truthy(&field(&schedule, "active"))
        && !is(&category, "P")
        && !is(&field(&category, "classifyState"), "P")
    {
        JsValue::string("continuation")
    } else if truthy(&field(&options, "retry")) {
        JsValue::string("retry")
    } else if field(&options, "originContinue") == JsValue::Bool(true) {
        JsValue::string("continuation")
    } else {
        JsValue::string("task")
    };
    if !is(&work_kind, "task") && !is_control(&work_kind) {
        return Err(err("invalid session work kind"));
    }
    let mut payload = JsValue::object(vec![
        ("type", JsValue::string("session.work")),
        ("workKind", work_kind.clone()),
        ("message", JsValue::String(text)),
        ("options", options.clone()),
        ("source", source),
        ("taskId", fallback(field(&options, "taskId"), JsValue::Null)),
        ("requestId", request_id.clone()),
        (
            "activeEntryId",
            fallback(field(&request, "activeEntryId"), JsValue::Null),
        ),
    ]);
    let origin = field(&options, "originDispatchId");
    if truthy(&origin) {
        put(&mut payload, "originDispatchId", origin)?;
    }
    payload = record::parse(&operation_admit::canonical(&payload)?)?;
    let key = if host_admission {
        // The former host admission contract gives an explicit key priority
        // over a client message ID, and that priority over a delivery ID.
        fallback(
            field(&request, "idempotencyKey"),
            fallback(
                field(&options, "idempotencyKey"),
                fallback(
                    field(&options, "clientMsgId"),
                    field(&options, "deliveryId"),
                ),
            ),
        )
    } else {
        fallback(
            field(&request, "idempotencyKey"),
            fallback(
                field(&options, "deliveryId"),
                fallback(field(&options, "clientMsgId"), field(&options, "requestId")),
            ),
        )
    };
    let identity = if truthy(&key) {
        let mut identity = JsString::from_rust_str("key:");
        identity.push(&js_to_string(&key));
        identity
    } else {
        let mut bytes = [0_u8; 16];
        getrandom::fill(&mut bytes).map_err(err)?;
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        let hex = bytes
            .iter()
            .map(|value| format!("{value:02x}"))
            .collect::<String>();
        let uuid = format!(
            "{}-{}-{}-{}-{}",
            &hex[..8],
            &hex[8..12],
            &hex[12..16],
            &hex[16..20],
            &hex[20..]
        );
        JsString::from_rust_str(&format!(
            "new:{uuid}:{}",
            record::encode(&payload)?.encode_utf16().count()
        ))
    };
    let mut hash_input = JsString::from_rust_str(&session);
    hash_input.push_unit(0);
    hash_input.push(&identity);
    let digest = format!("{:x}", Sha256::digest(hash_input.utf8_lossy_bytes()));
    let entry_id = format!("session-work:{}", &digest[..40]);
    let existing = record::get_json(&tx, "outbox", &entry_id, &[])?
        .map(|raw| record::parse(&raw))
        .transpose()?;
    let receipt = field(&options, "taskShellReceiptId");
    if truthy(&receipt) && existing.is_none() {
        let control = field(&options, "taskShellControl");
        if truthy(&control) {
            let turn = field(&control, "turnId");
            let current_turn = fallback(field(&active_turn, "turnId"), active_turn.clone());
            let matching_turn = truthy(&turn)
                && (current_turn == turn
                    || (is(&field(&control, "intent"), "answer")
                        && truthy(&field(&pending, "turnId"))
                        && field(&pending, "turnId") == turn));
            let matching_answer = !is(&field(&control, "intent"), "answer")
                || (truthy(&pending)
                    && field(&pending, "requestId") == request_id
                    && field(&pending, "taskId") == field(&options, "taskId"));
            if !matching_turn || !matching_answer {
                return Ok(json!({"resultJson":"{\"ok\":false,\"code\":\"stale_control\"}"}));
            }
        }
    }
    if let Some(item) = existing.as_ref().filter(|_| truthy(&receipt)) {
        let previous_payload = field(item, "payload");
        let previous_options = field(&previous_payload, "options");
        if field(&previous_options, "taskShellReceiptId") != receipt
            || field(&previous_payload, "message") != field(&payload, "message")
            || field(&previous_payload, "taskId") != field(&options, "taskId")
            || record::encode(&previous_options)? != record::encode(&options)?
        {
            return Ok(json!({"resultJson":"{\"ok\":false,\"code\":\"idempotency_conflict\"}"}));
        }
        let queue = queue_rows(&tx, &session, &schedule)?;
        let result = JsValue::object(vec![
            ("ok", JsValue::Bool(true)),
            ("duplicate", JsValue::Bool(true)),
            ("shellReplay", JsValue::Bool(true)),
            ("entry", item.clone()),
            ("queued", JsValue::Bool(false)),
            ("position", JsValue::Number(0.0)),
            ("schedule", public_schedule(&tx, &schedule, &queue)?),
        ]);
        let result_json = record::encode(&result)?;
        let new_header = header(&tx)?;
        tx.commit().map_err(err)?;
        return Ok(json!({"resultJson":result_json,"snapshot":state,"state":new_header}));
    }
    let correlated = is(&work_kind, "answer")
        && truthy(&request_id)
        && truthy(&pending)
        && field(&pending, "requestId") == request_id;
    let active = field(&schedule, "active");
    if is_control(&work_kind) {
        if truthy(&active) {
            put(
                &mut payload,
                "activeEntryId",
                if is(&work_kind, "answer") {
                    JsValue::Null
                } else {
                    field(&active, "entryId")
                },
            )?;
            if !truthy(&field(&payload, "taskId")) && truthy(&field(&active, "taskId")) {
                put(&mut payload, "taskId", field(&active, "taskId"))?;
            }
            if !truthy(&field(&payload, "originDispatchId"))
                && truthy(&field(&active, "originDispatchId"))
            {
                put(
                    &mut payload,
                    "originDispatchId",
                    field(&active, "originDispatchId"),
                )?;
            }
        } else if correlated {
            put(&mut schedule, "awaitingRequestId", request_id.clone())?;
            if !truthy(&field(&payload, "taskId")) && truthy(&field(&pending, "taskId")) {
                put(&mut payload, "taskId", field(&pending, "taskId"))?;
            }
        }
    }
    let canonical_payload = operation_admit::canonical(&payload)?;
    let payload_hash = operation_admit::digest(&canonical_payload);
    payload = record::parse(&canonical_payload)?;
    let sequence = meta(&tx, "nextOutboxSequence")?
        .as_u64()
        .ok_or_else(|| err("invalid sequence"))?;
    if sequence >= 9_007_199_254_740_991 || revision >= 9_007_199_254_740_991 {
        return Err(err("schedule admission sequence or revision exhausted"));
    }
    let duplicate = existing.is_some();
    let mut item = if let Some(item) = existing {
        if field(&item, "sessionId") != JsValue::string(&session)
            || field(&item, "payloadHash") != JsValue::string(&payload_hash)
        {
            return Err(format!("OUTBOX_PAYLOAD_CONFLICT:{entry_id}"));
        }
        item
    } else {
        JsValue::object(vec![
            ("id", JsValue::string(&entry_id)),
            ("sessionId", JsValue::string(&session)),
            ("sequence", JsValue::Number(sequence as f64)),
            ("state", JsValue::string("pending")),
            ("payload", payload.clone()),
            ("payloadHash", JsValue::string(&payload_hash)),
            (
                "source",
                JsValue::object(vec![
                    ("kind", work_kind.clone()),
                    ("type", JsValue::string("session-admission")),
                ]),
            ),
            ("attempts", JsValue::Number(0.0)),
            ("availableAt", JsValue::Number(now as f64)),
            ("createdAt", JsValue::Number(now as f64)),
            ("updatedAt", JsValue::Number(now as f64)),
            ("leasedAt", JsValue::Null),
            ("leasedUntil", JsValue::Null),
            ("leaseOwner", JsValue::Null),
            ("leaseTokenHash", JsValue::Null),
            ("deliveredAt", JsValue::Null),
            ("deadLetterAt", JsValue::Null),
            ("lastError", JsValue::Null),
        ])
    };
    if duplicate {
        // An idempotent replay is a read: it must not advance either the
        // session version or the scheduler revision, nor rewrite the outbox.
        let queue = queue_rows(&tx, &session, &schedule)?;
        let selected = select(&queue, &schedule, &pending, &category, now)?;
        let position = queue
            .iter()
            .position(|row| field(row, "id") == JsValue::string(&entry_id))
            .map_or(0, |index| index + 1);
        let special_answer = answer(&item);
        let result = JsValue::object(vec![
            ("ok", JsValue::Bool(true)),
            ("duplicate", JsValue::Bool(true)),
            ("answerConsumed", JsValue::Null),
            ("entry", item),
            (
                "queued",
                JsValue::Bool(!special_answer && selected != JsValue::string(&entry_id)),
            ),
            (
                "position",
                JsValue::Number(if special_answer { 0.0 } else { position as f64 }),
            ),
            ("schedule", public_schedule(&tx, &schedule, &queue)?),
        ]);
        let result_json = record::encode(&result)?;
        let new_header = header(&tx)?;
        tx.commit().map_err(err)?;
        return Ok(json!({"resultJson":result_json,"snapshot":state,"state":new_header}));
    }
    let typed = is(&field(&payload, "source"), "direct")
        || (is(&field(&payload, "source"), "task-shell")
            && truthy(&field(&options, "taskShellReceiptId")));
    if typed || is_control(&work_kind) {
        put(&mut item, "directRun", JsValue::Bool(true))?;
    }
    let special_answer = answer(&item);
    if special_answer && is(&field(&item, "state"), "pending") {
        put(&mut schedule, "priorityEntryId", JsValue::string(&entry_id))?;
    }
    put(&mut schedule, "updatedAt", JsValue::Number(now as f64))?;
    // Persist answer settlement together with the outbox and scheduler row.
    // An idempotent replay must not emit a second settlement effect.
    let consumed = correlated && !duplicate;
    let mut notification = JsValue::Null;
    if consumed {
        let mut settled = pending_raw.clone();
        put(&mut settled, "resolved", JsValue::Bool(true))?;
        put(&mut settled, "resolvedAt", JsValue::Number(now as f64))?;
        // Keep the client-facing settlement alongside the consumed question.
        // While this question remains in the snapshot, a reconnect can recover
        // the event if the host dies after commit and before broadcasting it.
        notification = JsValue::object(vec![
            ("type", JsValue::string("user_input_resolved")),
            ("requestId", request_id.clone()),
            ("taskId", nullish(field(&pending_raw, "taskId"))),
        ]);
        put(&mut settled, "resolvedNotification", notification.clone())?;
        encoded_state.pending_question_json = record::encode(&settled)?;
        // Replay must retain this settlement after beginTurn clears the
        // pending question. Persist it in the same transaction as admission.
        let mut next_category = match category.clone() {
            value @ JsValue::Object(_) => value,
            JsValue::Null => JsValue::Object(vec![]),
            value => JsValue::object(vec![("classifyState", value)]),
        };
        put(
            &mut next_category,
            "lastResolvedUserInput",
            JsValue::object(vec![
                ("requestId", request_id.clone()),
                ("at", JsValue::Number(now as f64)),
                ("taskId", nullish(field(&pending_raw, "taskId"))),
            ]),
        )?;
        put(
            &mut next_category,
            "userInputSignalVersion",
            JsValue::Number(1.0),
        )?;
        encoded_state.category_json = record::encode(&next_category)?;
    }
    let version = state["version"]
        .as_u64()
        .ok_or_else(|| err("invalid session work state version"))?;
    let snapshot =
        session_work_state::write_in_transaction(&tx, &session, version, &encoded_state)?;
    write_record_json(
        &tx,
        "sessionSchedules",
        &session,
        &record::encode(&schedule)?,
    )?;
    write_record_json(&tx, "outbox", &entry_id, &record::encode(&item)?)?;
    if !duplicate {
        set_meta(&tx, "nextOutboxSequence", &json!(sequence + 1))?;
    }
    set_meta(&tx, "revision", &json!(revision + 1))?;
    set_meta(&tx, "updatedAt", &json!(now))?;
    let queue = queue_rows(&tx, &session, &schedule)?;
    let selected = select(&queue, &schedule, &pending, &category, now)?;
    let position = queue
        .iter()
        .position(|row| field(row, "id") == JsValue::string(&entry_id))
        .map_or(0, |index| index + 1);
    let result = JsValue::object(vec![
        ("ok", JsValue::Bool(true)),
        ("duplicate", JsValue::Bool(duplicate)),
        ("notification", notification),
        (
            "answerConsumed",
            if consumed {
                JsValue::object(vec![
                    ("requestId", request_id.clone()),
                    (
                        "taskId",
                        fallback(field(&pending_raw, "taskId"), JsValue::Null),
                    ),
                    ("at", JsValue::Number(now as f64)),
                ])
            } else {
                JsValue::Null
            },
        ),
        ("entry", item),
        (
            "queued",
            JsValue::Bool(!special_answer && selected != JsValue::string(&entry_id)),
        ),
        (
            "position",
            JsValue::Number(if special_answer { 0.0 } else { position as f64 }),
        ),
        ("schedule", public_schedule(&tx, &schedule, &queue)?),
    ]);
    let result_json = record::encode(&result)?;
    let new_header = header(&tx)?;
    tx.commit().map_err(err)?;
    Ok(json!({"resultJson":result_json,"snapshot":snapshot,"state":new_header}))
}

#[cfg(test)]
mod completion_tests {
    use super::*;
    use crate::orchestration_retention::RetentionPolicy;

    #[test]
    fn frozen_completion_allows_external_commit_then_rejects_stale_snapshot() {
        let mut random = [0_u8; 12];
        getrandom::fill(&mut random).unwrap();
        let name = random
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let dir = std::env::temp_dir().join(format!("multicc-frozen-completion-{name}"));
        std::fs::create_dir(&dir).unwrap();
        let file = dir.join("state.sqlite");
        let mut store =
            Store::open(file.to_str().unwrap(), None, 1, RetentionPolicy::default()).unwrap();
        store.request("sessionWorkState", &json!({"action":"readOrInitialize","encoding":"json","sessionId":"s",
            "initial":{"pendingQuestionJson":"{\"requestId\":\"q\"}","activeTurnJson":"null","categoryJson":"null"}})).unwrap();
        write_record_json(
            store.conn().unwrap(),
            "sessionSchedules",
            "s",
            &json!({"sessionId":"s","state":"running",
            "active":{"entryId":"active","taskId":"task"},"classifyState":"P"})
            .to_string(),
        )
        .unwrap();
        write_record_json(store.conn().unwrap(), "outbox", "queued", &json!({"id":"queued","sessionId":"s",
            "state":"pending","sequence":1,"payload":{"type":"session.work","message":"hello"},"directRun":true}).to_string()).unwrap();
        let command = json!({"sessionId":"s","at":1000,"updatedAt":1200,
            "expectedTaskIdJson":"\"task\"","reasonJson":"\"successful\"","classifyStateJson":"\"W\"","awaitingRequestIdJson":"\"q\""});
        let competing_path = file.clone();
        let failure = complete_frozen_inner(&mut store, &command, || {
            let writer = rusqlite::Connection::open(competing_path).unwrap();
            writer.execute("UPDATE orchestration_outbox SET data_json=json_set(data_json,'$.external',7) WHERE id='queued'", []).unwrap();
        }).unwrap_err();
        assert!(
            failure.starts_with("ORCHESTRATION_SQLITE_CONFLICT:0:0"),
            "{failure}"
        );
        let db = store.conn().unwrap();
        let row: Value = serde_json::from_str(
            &record::get_json(db, "outbox", "queued", &[])
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(row["external"], 7);
        assert_eq!(row["directRun"], true);
        assert!(row.get("blockedByUserInput").is_none());
        let schedule: Value = serde_json::from_str(
            &record::get_json(db, "sessionSchedules", "s", &[])
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(schedule["active"]["entryId"], "active");
        assert_eq!(schedule["state"], "running");
        assert_eq!(meta(db, "revision").unwrap(), 0);
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn atomic_completion_holds_writer_lock_between_snapshot_and_commit() {
        use std::time::Duration;
        let mut random = [0_u8; 12];
        getrandom::fill(&mut random).unwrap();
        let name = random
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let dir = std::env::temp_dir().join(format!("multicc-atomic-completion-{name}"));
        std::fs::create_dir(&dir).unwrap();
        let file = dir.join("state.sqlite");
        let mut store =
            Store::open(file.to_str().unwrap(), None, 1, RetentionPolicy::default()).unwrap();
        store.request("sessionWorkState", &json!({"action":"readOrInitialize","encoding":"json","sessionId":"s",
            "initial":{"pendingQuestionJson":"{\"requestId\":\"old\"}","activeTurnJson":"null","categoryJson":"null"}})).unwrap();
        write_record_json(
            store.conn().unwrap(),
            "sessionSchedules",
            "s",
            &json!({"sessionId":"s","state":"running",
            "active":{"entryId":"active","taskId":"task"},"classifyState":"P"})
            .to_string(),
        )
        .unwrap();
        write_record_json(store.conn().unwrap(), "outbox", "queued", &json!({"id":"queued","sessionId":"s",
            "state":"pending","sequence":1,"payload":{"type":"session.work","message":"hello"},"directRun":true}).to_string()).unwrap();
        // A writer that commits before the snapshot becomes the authoritative fact.
        let before = rusqlite::Connection::open(&file).unwrap();
        before.execute("UPDATE orchestration_session_work_state SET version=2,pending_question_json=?1 WHERE session_id='s'", [r#"{"requestId":"before"}"#]).unwrap();
        drop(before);
        let command = json!({"sessionId":"s","at":1000,"updatedAt":1200,
            "expectedTaskIdJson":"\"task\"","reasonJson":"\"successful\"","classifyStateJson":"\"W\"","awaitingRequestIdJson":"\"before\""});
        let competing_path = file.clone();
        let result = complete_inner(&mut store, &command, true, || {
            let competing = std::thread::spawn(move || {
                let writer = rusqlite::Connection::open(competing_path).unwrap();
                writer.busy_timeout(Duration::from_millis(75)).unwrap();
                writer.execute_batch("BEGIN IMMEDIATE")
            });
            let error = competing.join().unwrap().unwrap_err();
            assert_eq!(
                error.sqlite_error_code(),
                Some(rusqlite::ErrorCode::DatabaseBusy)
            );
        })
        .unwrap();
        assert_eq!(result["observedToken"]["version"], 2);
        assert_eq!(result["observedToken"]["revision"], 0);
        let row: Value = serde_json::from_str(
            &record::get_json(store.conn().unwrap(), "outbox", "queued", &[])
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(row["blockedByUserInput"], "before");
        let after = rusqlite::Connection::open(&file).unwrap();
        let stale_writes = after.execute("UPDATE orchestration_session_work_state SET version=version+1 WHERE session_id='s' AND version=2 AND (SELECT CAST(value_json AS INTEGER) FROM orchestration_meta WHERE key='revision')=0", []).unwrap();
        assert_eq!(
            stale_writes, 0,
            "a writer using the pre-completion token must reject after commit"
        );
        drop(after);
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn completion_checks_snapshot_and_rolls_back_queue_and_schedule_together() {
        let mut random = [0_u8; 12];
        getrandom::fill(&mut random).unwrap();
        let name = random
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let dir = std::env::temp_dir().join(format!("multicc-completion-{name}"));
        std::fs::create_dir(&dir).unwrap();
        let file = dir.join("state.sqlite");
        let mut store =
            Store::open(file.to_str().unwrap(), None, 1, RetentionPolicy::default()).unwrap();
        let absent = store
            .request(
                "scheduleCompleteTokenExperimental",
                &json!({"sessionId":"missing"}),
            )
            .unwrap();
        assert_eq!(absent["guard"], json!({"ok":false,"code":"no_active_task"}));
        assert_eq!(absent["snapshot"]["exists"], false);
        write_record_json(
            store.conn().unwrap(),
            "sessionSchedules",
            "missing",
            &json!({"sessionId":"missing",
            "state":"running","active":{"entryId":"missing-active"}})
            .to_string(),
        )
        .unwrap();
        assert!(store
            .request(
                "scheduleCompleteTokenExperimental",
                &json!({"sessionId":"missing"})
            )
            .unwrap_err()
            .contains("backfill requires a trusted snapshot"));
        let stale_missing = json!({"sessionId":"missing","expectedRevision":99,"expectedVersion":0,
            "expectedDataVersion":0,"at":1,"updatedAt":1,"expectedTaskIdJson":"null",
            "reasonJson":"\"successful\"","classifyStateJson":"\"D\"","awaitingRequestIdJson":"null"});
        assert!(store
            .request("scheduleCompleteExperimental", &stale_missing)
            .unwrap_err()
            .starts_with("ORCHESTRATION_SQLITE_CONFLICT:99:"));
        store.request("sessionWorkState", &json!({"action":"readOrInitialize","encoding":"json","sessionId":"s",
            "initial":{"pendingQuestionJson":"{\"requestId\":\"q\",\"taskId\":\"task\"}","activeTurnJson":"null","categoryJson":"null"}})).unwrap();
        let db = store.conn().unwrap();
        write_record_json(
            db,
            "sessionSchedules",
            "s",
            &json!({"sessionId":"s","state":"running",
            "active":{"entryId":"active","taskId":"task"},"classifyState":"P"})
            .to_string(),
        )
        .unwrap();
        for (index, id, payload, extra) in [
            (
                1,
                "ordinary",
                json!({"type":"session.work","message":"hello"}),
                json!({}),
            ),
            (
                2,
                "answer",
                json!({"type":"session.work","workKind":"answer","requestId":"q"}),
                json!({}),
            ),
            (
                3,
                "override",
                json!({"type":"session.work","message":"override"}),
                json!({"userInputOverrideId":"q"}),
            ),
        ] {
            let mut item = json!({"id":id,"sessionId":"s","state":"pending","sequence":index,"payload":payload,"directRun":true});
            item.as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            write_record_json(db, "outbox", id, &item.to_string()).unwrap();
        }
        let token = store
            .request(
                "scheduleCompleteTokenExperimental",
                &json!({"sessionId":"s"}),
            )
            .unwrap();
        assert_eq!(token["snapshot"]["version"], 1);
        assert_eq!(token["state"]["revision"], 0);
        assert_eq!(token["guard"], json!({"ok":true}));
        let guard = store
            .request(
                "scheduleCompleteTokenExperimental",
                &json!({"sessionId":"s",
            "expectedTaskIdJson":"\"other\""}),
            )
            .unwrap();
        assert_eq!(
            guard["guard"],
            json!({"ok":false,"code":"active_task_mismatch"})
        );
        let version = token["dataVersion"].as_i64().unwrap();
        let mut command = json!({"sessionId":"s","expectedRevision":0,"expectedVersion":1,"expectedDataVersion":version,"at":1000,"updatedAt":1200,
            "expectedTaskIdJson":"\"task\"","reasonJson":"\"successful\"","classifyStateJson":"\"W\"","awaitingRequestIdJson":"\"q\""});
        let mut stale = command.clone();
        stale["expectedVersion"] = json!(2);
        assert!(store
            .request("scheduleCompleteExperimental", &stale)
            .unwrap_err()
            .contains("version conflict"));
        let mut mismatched = command.clone();
        mismatched["expectedTaskIdJson"] = json!("\"other\"");
        let rejected = store
            .request("scheduleCompleteExperimental", &mismatched)
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(rejected["resultJson"].as_str().unwrap()).unwrap(),
            json!({"ok":false,"code":"active_task_mismatch"})
        );
        assert_eq!(meta(store.conn().unwrap(), "revision").unwrap(), 0);
        let other = rusqlite::Connection::open(&file).unwrap();
        other
            .execute(
                "INSERT INTO orchestration_extras(key,data_json) VALUES('external','{}')",
                [],
            )
            .unwrap();
        drop(other);
        assert!(store
            .request("scheduleCompleteExperimental", &command)
            .unwrap_err()
            .contains("database version conflict"));
        let current = store
            .request(
                "scheduleCompleteTokenExperimental",
                &json!({"sessionId":"s"}),
            )
            .unwrap()["dataVersion"]
            .as_i64()
            .unwrap();
        assert_ne!(current, version);
        command["expectedDataVersion"] = json!(current);
        store.conn().unwrap().execute_batch("CREATE TRIGGER reject_completion BEFORE UPDATE ON orchestration_session_schedules BEGIN SELECT RAISE(ABORT, 'reject completion'); END;").unwrap();
        assert!(store
            .request("scheduleCompleteExperimental", &command)
            .unwrap_err()
            .contains("reject completion"));
        let db = store.conn().unwrap();
        let ordinary = record::get_json(db, "outbox", "ordinary", &[])
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&ordinary).unwrap()["directRun"],
            true
        );
        let schedule = record::get_json(db, "sessionSchedules", "s", &[])
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&schedule).unwrap()["state"],
            "running"
        );
        assert_eq!(meta(db, "revision").unwrap(), 0);
        db.execute_batch("DROP TRIGGER reject_completion").unwrap();
        let response = store
            .request("scheduleCompleteExperimental", &command)
            .unwrap();
        let result: Value = serde_json::from_str(response["resultJson"].as_str().unwrap()).unwrap();
        assert_eq!(result["schedule"]["classifyState"], "W");
        assert_eq!(result["schedule"]["awaitingRequestId"], "q");
        assert_eq!(result["completed"]["entryId"], "active");
        assert_eq!(
            store
                .request(
                    "scheduleCompleteTokenExperimental",
                    &json!({"sessionId":"s"})
                )
                .unwrap()["guard"],
            json!({"ok":false,"code":"no_active_task"})
        );
        let db = store.conn().unwrap();
        for id in ["ordinary", "answer", "override"] {
            let raw = record::get_json(db, "outbox", id, &[]).unwrap().unwrap();
            let item: Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(item["directRun"], id != "ordinary");
            if id == "ordinary" {
                assert_eq!(item["blockedByUserInput"], "q");
            }
        }
        assert_eq!(meta(db, "revision").unwrap(), 1);
        // The old implementation evaluates the awaiting-request rule on the
        // raw letter before normalizing unknown letters to D.
        write_record_json(
            db,
            "sessionSchedules",
            "s",
            &json!({"sessionId":"s","state":"running",
            "active":{"entryId":"second","taskId":"task"},"classifyState":"P"})
            .to_string(),
        )
        .unwrap();
        let next = store
            .request(
                "scheduleCompleteTokenExperimental",
                &json!({"sessionId":"s"}),
            )
            .unwrap();
        command["expectedRevision"] = next["state"]["revision"].clone();
        command["expectedDataVersion"] = next["dataVersion"].clone();
        // Production pairs the version from the freshest token snapshot
        // (native-store-host.js passes token.snapshot.version); reusing the
        // stale version from the first token trips the optimistic guard.
        command["expectedVersion"] = next["snapshot"]["version"].clone();
        command["classifyStateJson"] = json!("\"future\"");
        let response = store
            .request("scheduleCompleteExperimental", &command)
            .unwrap();
        let result: Value = serde_json::from_str(response["resultJson"].as_str().unwrap()).unwrap();
        assert_eq!(result["schedule"]["classifyState"], "D");
        assert_eq!(result["schedule"]["awaitingRequestId"], "q");
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
