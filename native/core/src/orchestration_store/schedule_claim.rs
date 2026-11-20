//! Confirm a transport lease against the canonical outbox row and move the
//! session into starting in the same write transaction.
use super::{
    err, header, meta, record,
    schedule_admit_live::{
        fallback, field, initial_schedule, is, kind, public_schedule, put, queue_rows,
        related_control, select, task_id,
    },
    session_work_state, set_meta, write_record_json, Result, Store,
};
use crate::{
    auth_security::timing_safe_equal_text,
    js::{js_to_number, truthy, JsValue as V},
    random_id,
};
use rusqlite::{Connection, TransactionBehavior};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub(super) fn commit(store: &mut Store, input: &Value) -> Result<Value> {
    if store.active || store.pending {
        return Err(err("schedule claim requires an idle owner connection"));
    }
    let entry_id = input["entryId"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| err("schedule claim requires entryId"))?;
    let session = input["sessionId"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| err("schedule claim requires sessionId"))?;
    let at = input["at"]
        .as_f64()
        .ok_or_else(|| err("invalid claim clock"))?;
    let updated_at = input["updatedAt"]
        .as_number()
        .ok_or_else(|| err("invalid orchestration clock"))?;
    let db = store
        .connection
        .as_mut()
        .ok_or_else(|| err("database closed"))?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(err)?;
    let reject = |code: &str| -> Result<Value> {
        Ok(json!({"result":{"ok":false,"code":code},"state":header(&tx)?}))
    };
    let Some(raw) = record::get_json(&tx, "outbox", entry_id, &[])? else {
        return reject("delivery_not_leased");
    };
    let mut item = record::parse(&raw)?;
    let id = V::string(entry_id);
    if field(&item, "id") != id
        || !is(&field(&item, "sessionId"), session)
        || !is(&field(&item, "state"), "leased")
        || !lease_matches(&item, input["leaseToken"].as_str(), at)
    {
        return reject("delivery_not_leased");
    }
    // Legacy workers can resolve dispatch lineage from operation records
    // after taking the transport lease. Other claim fields come from disk.
    if let Some(raw) = input["lineageJson"].as_str() {
        let lineage = record::parse(raw)?;
        if matches!(lineage, V::Object(_)) {
            put(&mut item, "turnLineage", lineage)?;
        }
    }

    let mut schedule = record::get_json(&tx, "sessionSchedules", session, &[])?
        .map(|raw| record::parse(&raw))
        .transpose()?
        .unwrap_or_else(|| initial_schedule(session, at));
    if !matches!(schedule, V::Object(_)) || !is(&field(&schedule, "sessionId"), session) {
        return Err(err("invalid session schedule"));
    }
    if !start_claim(&mut schedule, &item, at)? {
        return reject("session_gate_closed");
    }
    write_record_json(
        &tx,
        "sessionSchedules",
        session,
        &record::encode(&schedule)?,
    )?;
    advance_revision(&tx, &Value::Number(updated_at.clone()))?;
    let queue = queue_rows(&tx, session, &schedule)?;
    let projection = public_schedule(&tx, &schedule, &queue)?;
    let result = V::object(vec![("ok", V::Bool(true)), ("schedule", projection)]);
    let result_json = record::encode(&result)?;
    let state = header(&tx)?;
    tx.commit().map_err(err)?;
    Ok(json!({"resultJson":result_json,"state":state}))
}

fn start_claim(schedule: &mut V, item: &V, at: f64) -> Result<bool> {
    let id = field(item, "id");
    let mut active = field(schedule, "active");
    let task = task_id(item);
    let origin = origin_dispatch(item);
    let clock = V::Number(at);
    if !truthy(&active) || is(&field(schedule, "state"), "idle") {
        let source = fallback(
            field(&field(item, "payload"), "source"),
            fallback(field(&field(item, "source"), "type"), V::string("legacy")),
        );
        active = V::object(vec![
            ("entryId", id.clone()),
            ("deliveryId", id.clone()),
            ("taskId", task),
            ("originDispatchId", origin),
            ("source", source),
            ("workKind", kind(item)),
            ("admittedAt", field(item, "createdAt")),
            ("claimedAt", clock.clone()),
            ("startedAt", V::Null),
            ("attempt", field(item, "attempts")),
        ]);
        if field(schedule, "priorityEntryId") == id {
            put(schedule, "priorityEntryId", V::Null)?;
        }
    } else {
        let active_id = fallback(field(&active, "deliveryId"), field(&active, "entryId"));
        if active_id != id && !related_control(schedule, &active, item) {
            return Ok(false);
        }
        put(&mut active, "deliveryId", id)?;
        put(&mut active, "workKind", kind(item))?;
        put(&mut active, "attempt", field(item, "attempts"))?;
        if !truthy(&field(&active, "taskId")) && truthy(&task) {
            put(&mut active, "taskId", task)?;
        }
        if !truthy(&field(&active, "originDispatchId")) && truthy(&origin) {
            put(&mut active, "originDispatchId", origin)?;
        }
    }
    put(schedule, "active", active)?;
    put(schedule, "state", V::string("starting"))?;
    put(schedule, "freezeReason", V::Null)?;
    put(schedule, "updatedAt", clock)?;
    Ok(true)
}

/// Pick from the same FIFO as admission. Older work is left for its owner;
/// the gateway may claim only work it admitted for this specific task.
pub(super) fn claim_chat(store: &mut Store, input: &Value) -> Result<Value> {
    if store.active || store.pending {
        return Err(err("schedule claim requires an idle owner connection"));
    }
    let session = input["sessionId"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("sessionId required")?;
    let task = input["taskId"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("taskId required")?;
    let owner = input["workerId"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("workerId required")?;
    let at = input["at"].as_i64().ok_or("claim clock required")?;
    let tx = store
        .connection
        .as_mut()
        .ok_or("database closed")?
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(err)?;
    let Some(raw) = record::get_json(&tx, "sessionSchedules", session, &[])? else {
        return Ok(Value::Null);
    };
    let mut schedule = record::parse(&raw)?;
    if !is(&field(&schedule, "state"), "idle") || truthy(&field(&schedule, "active")) {
        return Ok(Value::Null);
    }
    let snapshot = session_work_state::snapshot_in_write_transaction(&tx, session)?;
    let pending = record::parse(
        snapshot["pendingQuestionJson"]
            .as_str()
            .ok_or("invalid pending question")?,
    )?;
    let category = record::parse(
        snapshot["categoryJson"]
            .as_str()
            .ok_or("invalid schedule category")?,
    )?;
    if truthy(&field(&category, "unattended")) {
        return Ok(Value::Null);
    }
    let mut queue = queue_rows(&tx, session, &schedule)?;
    // Neither expired transport leases nor work with unknown launch state
    // can be silently replayed by a fresh gateway process.
    if queue
        .iter()
        .any(|entry| is(&field(entry, "state"), "leased"))
    {
        return Ok(Value::Null);
    }
    queue.retain(|entry| js_to_number(&field(entry, "availableAt")) <= at as f64);
    let selected = select(&queue, &schedule, &pending, &category, at)?;
    let Some(mut item) = queue
        .into_iter()
        .find(|entry| field(entry, "id") == selected)
    else {
        return Ok(Value::Null);
    };
    let payload = field(&item, "payload");
    let options = field(&payload, "options");
    if !is(&field(&payload, "type"), "session.work")
        || !is(&field(&payload, "source"), "task-shell")
        || !is(&task_id(&item), task)
        || field(&options, "nativeShellWork") != V::Bool(true)
    {
        return Ok(Value::Null);
    }
    let V::String(id) = selected else {
        return Err(err("invalid selected outbox entry"));
    };
    let id = id.to_string_lossy();
    let token = random_id::random_uuid_v4().map_err(err)?;
    let hash = format!("{:x}", Sha256::digest(token.as_bytes()));
    let attempt = js_to_number(&field(&item, "attempts")) + 1.0;
    if !attempt.is_finite() || !(1.0..=9_007_199_254_740_991.0).contains(&attempt) {
        return Err(err("invalid delivery attempt"));
    }
    for (key, val) in [
        ("state", V::string("leased")),
        ("attempts", V::Number(attempt)),
        ("leasedAt", V::Number(at as f64)),
        ("leasedUntil", V::Number(at as f64 + 30_000.0)),
        ("leaseOwner", V::string(owner)),
        ("leaseTokenHash", V::string(&hash)),
        ("updatedAt", V::Number(at as f64)),
    ] {
        put(&mut item, key, val)?;
    }
    if !start_claim(&mut schedule, &item, at as f64)? {
        return Err(err("selected delivery could not be claimed"));
    }
    write_record_json(&tx, "outbox", &id, &record::encode(&item)?)?;
    write_record_json(
        &tx,
        "sessionSchedules",
        session,
        &record::encode(&schedule)?,
    )?;
    advance_revision(&tx, &json!(at))?;
    tx.commit().map_err(err)?;
    Ok(
        json!({"entryId":id,"attempt":attempt,"leaseToken":token,"payloadJson":record::encode(&payload)?}),
    )
}

pub(super) fn release_chat(store: &mut Store, input: &Value) -> Result<Value> {
    if store.active || store.pending {
        return Err(err("schedule release requires an idle owner connection"));
    }
    let session = input["sessionId"].as_str().ok_or("sessionId required")?;
    let entry = input["entryId"].as_str().ok_or("entryId required")?;
    let at = input["at"].as_i64().ok_or("release clock required")?;
    let tx = store
        .connection
        .as_mut()
        .ok_or("database closed")?
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(err)?;
    let raw_item = record::get_json(&tx, "outbox", entry, &[])?.ok_or("delivery_not_leased")?;
    let raw_schedule = record::get_json(&tx, "sessionSchedules", session, &[])?
        .ok_or("active_delivery_mismatch")?;
    let mut item = record::parse(&raw_item)?;
    let mut schedule = record::parse(&raw_schedule)?;
    let active = field(&schedule, "active");
    // A failed pre-launch can release its own expired transport lease, but
    // never a lease that has been replaced by another worker.
    let hash = input["leaseToken"]
        .as_str()
        .map(|token| format!("{:x}", Sha256::digest(token.as_bytes())));
    if !is(&field(&item, "sessionId"), session)
        || !is(&field(&item, "state"), "leased")
        || !hash.is_some_and(|hash| is(&field(&item, "leaseTokenHash"), &hash))
        || !is(&field(&active, "deliveryId"), entry)
        || !is(&field(&schedule, "state"), "starting")
    {
        return Err(err("active_delivery_mismatch"));
    }
    let defer = input["defer"] == true;
    let clock = V::Number(at as f64);
    put(&mut schedule, "active", V::Null)?;
    put(&mut schedule, "state", V::string("idle"))?;
    put(&mut schedule, "updatedAt", clock.clone())?;
    put(
        &mut item,
        "state",
        V::string(if defer { "pending" } else { "dead-letter" }),
    )?;
    put(
        &mut item,
        "lastError",
        crate::js::from_serde(&input["reason"]),
    )?;
    put(&mut item, "updatedAt", clock.clone())?;
    if defer {
        let attempts = js_to_number(&field(&item, "attempts"));
        put(&mut item, "attempts", V::Number((attempts - 1.0).max(0.0)))?;
        put(&mut item, "availableAt", V::Number(at as f64 + 1000.0))?;
    } else {
        put(&mut item, "deadLetterAt", clock)?;
    }
    for key in ["leasedAt", "leasedUntil", "leaseOwner", "leaseTokenHash"] {
        put(&mut item, key, V::Null)?;
    }
    write_record_json(&tx, "outbox", entry, &record::encode(&item)?)?;
    write_record_json(
        &tx,
        "sessionSchedules",
        session,
        &record::encode(&schedule)?,
    )?;
    advance_revision(&tx, &json!(at))?;
    tx.commit().map_err(err)?;
    Ok(json!({"ok":true}))
}

/// Acknowledge a chat input after its transcript write is durable. Compact
/// that same outbox record and advance only the matching active attempt.
pub(super) fn handoff(store: &mut Store, input: &Value) -> Result<Value> {
    if store.active || store.pending {
        return Err(err("delivery handoff requires an idle owner connection"));
    }
    let entry = input["entryId"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| err("delivery handoff requires entryId"))?;
    let session = input["sessionId"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| err("delivery handoff requires sessionId"))?;
    let at = input["at"]
        .as_f64()
        .ok_or_else(|| err("invalid handoff clock"))?;
    let tx = store
        .connection
        .as_mut()
        .ok_or_else(|| err("database closed"))?
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(err)?;
    let reject = |code: &str| -> Result<Value> {
        Ok(json!({"result":{"acknowledged":{"ok":false,"code":code}},"state":header(&tx)?}))
    };
    let Some(raw) = record::get_json(&tx, "outbox", entry, &[])? else {
        return reject("not_found");
    };
    let mut item = record::parse(&raw)?;
    let id = V::string(entry);
    if field(&item, "id") != id
        || !is(&field(&item, "sessionId"), session)
        || !is(&field(&item, "state"), "leased")
        || !lease_matches(&item, input["leaseToken"].as_str(), at)
    {
        return reject("lease_lost");
    }
    let mut payload = field(&item, "payload");
    if !is(&field(&payload, "type"), "session.work") {
        return reject("delivery_type_mismatch");
    }
    let native = field(&field(&payload, "options"), "nativeShellWork") == V::Bool(true);
    let clock = V::Number(at);
    put(&mut item, "state", V::string("delivered"))?;
    put(&mut item, "deliveredAt", clock.clone())?;
    put(&mut item, "updatedAt", clock.clone())?;
    for key in ["leasedAt", "leasedUntil", "leaseOwner", "leaseTokenHash"] {
        put(&mut item, key, V::Null)?;
    }
    let mut public = item.clone();
    if let V::Object(fields) = &mut public {
        fields.retain(|(name, _)| name != "leaseTokenHash");
    }
    if let V::Object(fields) = &mut payload {
        if fields.iter().any(|(name, _)| name == "message") {
            fields.retain(|(name, _)| name != "message");
            put(
                &mut payload,
                "messageRef",
                V::object(vec![("sessionId", V::string(session)), ("deliveryId", id)]),
            )?;
            put(&mut item, "payload", payload)?;
        }
    }
    write_record_json(&tx, "outbox", entry, &record::encode(&item)?)?;
    let started = mark_running(&tx, session, entry, &item, clock)?;
    if native && started.is_nullish() {
        return reject("active_delivery_mismatch");
    }
    advance_revision(&tx, &input["updatedAt"])?;
    let result = V::object(vec![
        (
            "acknowledged",
            V::object(vec![("ok", V::Bool(true)), ("item", public)]),
        ),
        ("started", started),
    ]);
    let result_json = record::encode(&result)?;
    let state = header(&tx)?;
    tx.commit().map_err(err)?;
    Ok(json!({"resultJson":result_json,"state":state}))
}

fn mark_running(db: &Connection, session: &str, entry: &str, item: &V, at: V) -> Result<V> {
    let Some(raw) = record::get_json(db, "sessionSchedules", session, &[])? else {
        return Ok(V::Null);
    };
    let mut schedule = record::parse(&raw)?;
    let mut active = field(&schedule, "active");
    let attempt = field(item, "attempts");
    let claimed = field(&active, "attempt");
    let state = field(&schedule, "state");
    if !is(&field(&active, "deliveryId"), entry)
        || (truthy(&attempt) && truthy(&claimed) && attempt != claimed)
        || is(&state, "assessing")
        || is(&state, "frozen")
    {
        return Ok(V::Null);
    }
    let started_at = fallback(field(&active, "startedAt"), at.clone());
    put(&mut active, "startedAt", started_at)?;
    put(&mut active, "attempt", attempt)?;
    put(&mut schedule, "active", active)?;
    put(&mut schedule, "state", V::string("running"))?;
    put(&mut schedule, "freezeReason", V::Null)?;
    put(&mut schedule, "awaitingRequestId", V::Null)?;
    put(&mut schedule, "classifyState", V::string("P"))?;
    put(&mut schedule, "updatedAt", at)?;
    write_record_json(db, "sessionSchedules", session, &record::encode(&schedule)?)?;
    let queue = queue_rows(db, session, &schedule)?;
    public_schedule(db, &schedule, &queue)
}

fn advance_revision(db: &Connection, updated_at: &Value) -> Result<()> {
    if !updated_at.is_number() {
        return Err(err("invalid orchestration clock"));
    }
    let revision = meta(db, "revision")?
        .as_u64()
        .filter(|n| *n < 9_007_199_254_740_991)
        .ok_or_else(|| err("schedule revision exhausted"))?;
    set_meta(db, "revision", &json!(revision + 1))?;
    set_meta(db, "updatedAt", updated_at)
}

fn origin_dispatch(item: &V) -> V {
    let payload = field(item, "payload");
    let operation = if is(&field(&payload, "type"), "dispatch.request") {
        field(&payload, "operationId")
    } else {
        V::Null
    };
    fallback(
        field(&field(item, "turnLineage"), "originDispatchId"),
        fallback(
            field(&payload, "originDispatchId"),
            fallback(operation, V::Null),
        ),
    )
}

fn lease_matches(item: &V, token: Option<&str>, at: f64) -> bool {
    let until = field(item, "leasedUntil");
    match (field(item, "leaseTokenHash"), token) {
        (V::String(hash), Some(token)) if matches!(until, V::Number(expires) if expires > at) => {
            let actual = format!("{:x}", Sha256::digest(token.as_bytes()));
            timing_safe_equal_text(&hash.to_string_lossy().to_ascii_lowercase(), &actual)
        }
        // Older imported leases may have neither an expiry nor a token.
        (V::Undefined | V::Null, None) => until.is_nullish(),
        _ => false,
    }
}
