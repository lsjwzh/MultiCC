//! Atomic storage boundary for an already prepared admission.
//!
//! Correlation and control-entry mutations are derived inside the owner.
//! Queue selection, full input normalization and idempotent replay are still
//! incomplete, so this command is not wired to the production scheduler.
use super::{
    err, header, meta, operation_admit, record, session_work_state, set_meta, write_record_json,
    Result, Store,
};
use crate::js::{truthy, JsString, JsValue};
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};

fn required_string<'a>(input: &'a Value, field: &str) -> Result<&'a str> {
    input
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| err(format!("{field} required")))
}

fn field(object: &JsValue, name: &str) -> JsValue {
    object.get(name).cloned().unwrap_or(JsValue::Undefined)
}

fn put(object: &mut JsValue, name: &str, value: JsValue) -> Result<()> {
    let JsValue::Object(fields) = object else {
        return Err(err("schedule admission requires object records"));
    };
    if let Some((_, old)) = fields.iter_mut().find(|(key, _)| key == name) {
        *old = value;
    } else {
        fields.push((JsString::from(name), value));
    }
    Ok(())
}

pub(super) fn commit(store: &mut Store, input: &Value) -> Result<Value> {
    if store.active || store.pending {
        return Err(err("schedule admission requires an idle owner connection"));
    }
    if input.get("requestJson").and_then(Value::as_str).is_some() {
        return super::schedule_admit_live::commit(store, input);
    }
    let session = required_string(input, "sessionId")?;
    let entry = required_string(input, "entryId")?;
    let expected_version = input["expectedVersion"]
        .as_u64()
        .ok_or_else(|| err("expectedVersion required"))?;
    let expected_revision = input["expectedRevision"]
        .as_u64()
        .ok_or_else(|| err("expectedRevision required"))?;
    let updated_at = input["updatedAt"]
        .as_i64()
        .ok_or_else(|| err("updatedAt required"))?;
    let outbox_raw = required_string(input, "outboxJson")?;
    let mut outbox = record::parse(outbox_raw)?;
    if !matches!(outbox, JsValue::Object(_))
        || outbox.get("id") != Some(&JsValue::string(entry))
        || outbox.get("sessionId") != Some(&JsValue::string(session))
        || outbox.get("state") != Some(&JsValue::string("pending"))
    {
        return Err(err("invalid schedule admission records"));
    }
    let connection = store
        .connection
        .as_mut()
        .ok_or_else(|| err("database closed"))?;
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(err)?;
    let mut schedule = match record::get_json(&tx, "sessionSchedules", session, &[])? {
        Some(raw) => record::parse(&raw)?,
        None => crate::js::from_serde(&json!({"sessionId":session,"state":"idle",
            "freezeReason":null,"awaitingRequestId":null,"classifyState":null,
            "classifyStateAt":null,"priorityEntryId":null,"active":null,
            "lastDecision":null,"updatedAt":updated_at})),
    };
    if !matches!(schedule, JsValue::Object(_))
        || schedule.get("sessionId") != Some(&JsValue::string(session))
    {
        return Err(err("invalid session schedule"));
    }
    let current = session_work_state::snapshot_in_write_transaction(&tx, session)?;
    if current["version"].as_u64() != Some(expected_version) {
        return Err(err("session work state version conflict"));
    }
    // Admission must never infer an empty state for a pre-upgrade session.
    // The migration/backfill boundary must initialize it before this command.
    if current["exists"] != true {
        return Err(err("session work state is not initialized"));
    }
    let state: session_work_state::EncodedState = serde_json::from_value(json!({
        "pendingQuestionJson":current["pendingQuestionJson"],
        "activeTurnJson":current["activeTurnJson"],
        "categoryJson":current["categoryJson"],
    }))
    .map_err(err)?;
    let pending = record::parse(&state.pending_question_json)?;
    let active_turn = record::parse(&state.active_turn_json)?;
    let category = record::parse(&state.category_json)?;
    let mut payload = field(&outbox, "payload");
    if !matches!(&payload, JsValue::Object(_))
        || field(&payload, "type") != JsValue::string("session.work")
    {
        return Err(err("invalid session work admission payload"));
    }
    let pending_request = field(&pending, "requestId");
    let request = field(&payload, "requestId");
    let kind = field(&payload, "workKind");
    let pending_answer_matches = kind == JsValue::string("answer")
        && pending.get("resolved") != Some(&JsValue::Bool(true))
        && truthy(&pending_request)
        && request == pending_request;
    let control = [
        "answer",
        "approval",
        "callback",
        "continuation",
        "retry",
        "resume",
    ]
    .iter()
    .any(|value| kind == JsValue::string(value));
    let active = field(&schedule, "active");
    if control && truthy(&active) {
        put(
            &mut payload,
            "activeEntryId",
            if kind == JsValue::string("answer") {
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
    } else if control && pending_answer_matches {
        put(&mut schedule, "awaitingRequestId", request.clone())?;
        if !truthy(&field(&payload, "taskId")) && truthy(&field(&pending, "taskId")) {
            put(&mut payload, "taskId", field(&pending, "taskId"))?;
        }
    }
    let typed = field(&payload, "source") == JsValue::string("direct")
        || (field(&payload, "source") == JsValue::string("task-shell")
            && truthy(&field(&field(&payload, "options"), "taskShellReceiptId")));
    if typed || control {
        put(&mut outbox, "directRun", JsValue::Bool(true))?;
    }
    if kind == JsValue::string("answer")
        && matches!(&request, JsValue::String(value) if !value.is_empty())
    {
        put(&mut schedule, "priorityEntryId", JsValue::string(entry))?;
    }
    let payload_hash = operation_admit::digest(&operation_admit::canonical(&payload)?);
    put(&mut outbox, "payload", payload)?;
    put(&mut outbox, "payloadHash", JsValue::string(&payload_hash))?;
    put(
        &mut schedule,
        "updatedAt",
        JsValue::Number(updated_at as f64),
    )?;
    let revision = meta(&tx, "revision")?
        .as_u64()
        .ok_or_else(|| err("invalid revision"))?;
    let sequence = meta(&tx, "nextOutboxSequence")?
        .as_u64()
        .ok_or_else(|| err("invalid sequence"))?;
    if revision != expected_revision {
        return Err(format!(
            "ORCHESTRATION_SQLITE_CONFLICT:{expected_revision}:{revision}"
        ));
    }
    if revision >= 9_007_199_254_740_991
        || sequence >= 9_007_199_254_740_991
        || outbox.get("sequence") != Some(&JsValue::Number(sequence as f64))
    {
        return Err(err("invalid schedule admission sequence or revision"));
    }
    let exists: Option<i64> = tx
        .query_row(
            "SELECT 1 FROM orchestration_outbox WHERE id=?1",
            params![entry],
            |row| row.get(0),
        )
        .optional()
        .map_err(err)?;
    if exists.is_some() {
        return Err(err("schedule admission entry already exists"));
    }
    let snapshot =
        session_work_state::write_in_transaction(&tx, session, expected_version, &state)?;
    write_record_json(
        &tx,
        "sessionSchedules",
        session,
        &record::encode(&schedule)?,
    )?;
    write_record_json(&tx, "outbox", entry, &record::encode(&outbox)?)?;
    set_meta(&tx, "revision", &json!(revision + 1))?;
    set_meta(&tx, "nextOutboxSequence", &json!(sequence + 1))?;
    set_meta(&tx, "updatedAt", &json!(updated_at))?;
    let committed_header = header(&tx)?;
    tx.commit().map_err(err)?;
    Ok(json!({"snapshot":snapshot,"state":committed_header,
        "admissionFacts":{"pendingAnswerMatches":pending_answer_matches,
            "activeTurnPresent":truthy(&active_turn),"categoryPresent":truthy(&category)}}))
}
