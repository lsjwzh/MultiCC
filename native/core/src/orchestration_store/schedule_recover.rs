//! Recovery transition kernel. The SQLite transaction and host observation
//! protocol must be connected before this is used by the live scheduler.
use super::{err, Result};
use crate::js::{js_to_number, truthy, JsValue};

/// Match the live SQLite draft's session key order and its outbox query order.
fn ordered_sessions(db: &rusqlite::Connection) -> Result<Vec<String>> {
    let mut query = db
        .prepare("SELECT session_id FROM orchestration_session_schedules ORDER BY session_id")
        .map_err(err)?;
    let mut sessions = query
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(err)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(err)?;
    drop(query);
    // A Proxy's ownKeys trap preserves this order even for numeric-looking keys.
    let mut seen: std::collections::HashSet<String> = sessions.iter().cloned().collect();
    let mut query = db.prepare("SELECT session_id FROM orchestration_outbox WHERE state IN ('pending','leased') ORDER BY id").map_err(err)?;
    let rows = query
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(err)?;
    for session in rows {
        let session = session.map_err(err)?;
        if seen.insert(session.clone()) {
            sessions.push(session);
        }
    }
    Ok(sessions)
}

/// Candidate session identities and version from one read snapshot. This is
/// experimental: invoking it synchronously from Node can block its event loop.
pub(super) fn snapshot(store: &mut super::Store) -> Result<serde_json::Value> {
    snapshot_impl(store, false)
}

/// Experimental owner-only snapshot. It refuses missing migration facts rather
/// than silently consulting the legacy Node process or inventing a verdict.
pub(super) fn owned_snapshot(store: &mut super::Store) -> Result<serde_json::Value> {
    snapshot_impl(store, true)
}

fn snapshot_impl(store: &mut super::Store, owned: bool) -> Result<serde_json::Value> {
    use super::header;
    use serde_json::json;
    if store.active || store.pending {
        return Err(err("schedule recovery requires an idle owner connection"));
    }
    let db = store.conn()?;
    let before: i64 = db
        .query_row("PRAGMA data_version", [], |row| row.get(0))
        .map_err(err)?;
    db.execute_batch("BEGIN").map_err(err)?;
    let result = (|| {
        let state = header(db)?;
        let sessions = ordered_sessions(db)?;
        let mut facts = Vec::new();
        if owned {
            for session in &sessions {
                let current = super::session_work_state::snapshot_encoded(db, session)?;
                if current["exists"] != true {
                    return Err(err("recovery requires owned session facts"));
                }
                let category = super::record::parse(
                    current["categoryJson"]
                        .as_str()
                        .ok_or_else(|| err("invalid owned recovery category"))?,
                )?;
                let active = super::record::parse(
                    current["activeTurnJson"]
                        .as_str()
                        .ok_or_else(|| err("invalid owned recovery turn"))?,
                )?;
                // The write transaction reads the authoritative values itself;
                // only the identity and version cross the protocol boundary.
                owned_facts(&category, &active)?;
                facts.push(json!({"sessionId": session, "expectedVersion": current["version"]}));
            }
        }
        Ok((state, sessions, facts))
    })();
    if result.is_err() {
        let _ = db.execute_batch("ROLLBACK");
        return result.map(|_| serde_json::Value::Null);
    }
    db.execute_batch("COMMIT").map_err(err)?;
    let after: i64 = db
        .query_row("PRAGMA data_version", [], |row| row.get(0))
        .map_err(err)?;
    if before != after {
        return Err(err("schedule recovery database version conflict"));
    }
    let (state, sessions, facts) = result?;
    Ok(if owned {
        json!({"state":state,"dataVersion":after,"facts":facts})
    } else {
        json!({"state":state,"dataVersion":after,"sessions":sessions})
    })
}

fn field(value: &JsValue, key: &str) -> JsValue {
    value.get(key).cloned().unwrap_or(JsValue::Undefined)
}
fn is(value: &JsValue, text: &str) -> bool {
    *value == JsValue::string(text)
}
fn fallback(value: JsValue, other: JsValue) -> JsValue {
    if truthy(&value) {
        value
    } else {
        other
    }
}

/// The subset of recoveryFacts read by the Rust transition. The session type
/// must be explicitly transferred to the owner; old rows do not contain it.
fn owned_facts(category: &JsValue, active: &JsValue) -> Result<JsValue> {
    let JsValue::Object(_) = category else {
        return Err(err("recovery requires an owned category"));
    };
    let record_type = category
        .get("recoveryRecordType")
        .ok_or_else(|| err("recovery requires owned session type"))?;
    if !matches!(record_type, JsValue::String(_) | JsValue::Null) {
        return Err(err("invalid owned session type"));
    }
    if !matches!(active, JsValue::Object(_) | JsValue::Null) {
        return Err(err("invalid owned recovery turn"));
    }
    let ended = js_to_number(&fallback(
        field(category, "lastTurnEndedAt"),
        field(category, "endedAt"),
    ));
    let ended = if ended.is_nan() || ended == 0.0 {
        JsValue::Null
    } else if ended.is_finite() {
        JsValue::Number(ended)
    } else {
        return Err(err("non-finite owned recovery timestamp"));
    };
    let class = field(category, "classifyState");
    let class =
        if is(record_type, "gateway") && (is(&class, "P") || is(&class, "C")) && truthy(&ended) {
            JsValue::string("D")
        } else {
            class
        };
    Ok(JsValue::object(vec![
        ("classifyState", class),
        ("startedAt", field(category, "startedAt")),
        ("endedAt", ended),
        (
            "taskId",
            fallback(field(active, "_currentTaskId"), JsValue::Null),
        ),
    ]))
}
fn put(value: &mut JsValue, key: &str, new_value: JsValue) -> Result<()> {
    let JsValue::Object(fields) = value else {
        return Err(err("invalid recovery schedule"));
    };
    if let Some((_, old)) = fields.iter_mut().find(|(name, _)| name == key) {
        *old = new_value;
    } else {
        fields.push((key.into(), new_value));
    }
    Ok(())
}
fn classified(value: &JsValue) -> bool {
    ["P", "W", "B", "D", "E"].iter().any(|s| is(value, s))
}
fn reason(class: &JsValue) -> JsValue {
    JsValue::string(if is(class, "W") {
        "classify_waiting"
    } else if is(class, "B") {
        "classify_background"
    } else if is(class, "E") {
        "classify_error"
    } else {
        "classify_running"
    })
}
fn classification(schedule: &JsValue) -> JsValue {
    let state = field(schedule, "classifyState");
    if classified(&state) {
        return state;
    }
    let reason = field(schedule, "freezeReason");
    if ["waiting", "awaiting_user_input", "classify_waiting"]
        .iter()
        .any(|s| is(&reason, s))
    {
        return JsValue::string("W");
    }
    if ["awaiting_callback", "classify_background"]
        .iter()
        .any(|s| is(&reason, s))
    {
        return JsValue::string("B");
    }
    if [
        "error",
        "classification_error",
        "unknown_interruption",
        "classify_error",
    ]
    .iter()
    .any(|s| is(&reason, s))
    {
        return JsValue::string("E");
    }
    JsValue::string(if truthy(&field(schedule, "active")) {
        "P"
    } else {
        "D"
    })
}

/// Produces one transition without reading the clock, database or host. The
/// caller must commit all sessions together and validate the observed snapshot.
#[allow(dead_code)]
pub(super) fn transition(
    session: &str,
    schedule: Option<JsValue>,
    observed: &JsValue,
    at: f64,
    delivery_needs_ack: bool,
) -> Result<(JsValue, Option<JsValue>)> {
    let raw_class = field(observed, "classifyState");
    let class = if classified(&raw_class) {
        raw_class
    } else {
        JsValue::Null
    };
    let now = JsValue::Number(at);
    if schedule.is_none() {
        let mut schedule = JsValue::object(vec![
            ("sessionId", JsValue::string(session)),
            ("state", JsValue::string("idle")),
            ("freezeReason", JsValue::Null),
            ("awaitingRequestId", JsValue::Null),
            ("classifyState", class.clone()),
            ("classifyStateAt", now.clone()),
            ("priorityEntryId", JsValue::Null),
            ("active", JsValue::Null),
            ("lastDecision", JsValue::Null),
            ("updatedAt", now.clone()),
        ]);
        if truthy(&class) && !is(&class, "D") && !is(&class, "E") {
            let started = field(observed, "startedAt");
            put(
                &mut schedule,
                "active",
                JsValue::object(vec![
                    (
                        "entryId",
                        JsValue::string(&format!("legacy-active:{session}")),
                    ),
                    ("deliveryId", JsValue::Null),
                    ("taskId", fallback(field(observed, "taskId"), JsValue::Null)),
                    (
                        "originDispatchId",
                        fallback(field(observed, "originDispatchId"), JsValue::Null),
                    ),
                    ("source", JsValue::string("legacy")),
                    ("workKind", JsValue::string("task")),
                    ("admittedAt", fallback(started.clone(), now)),
                    ("startedAt", fallback(started, JsValue::Null)),
                    ("attempt", JsValue::Number(0.0)),
                    ("legacy", JsValue::Bool(true)),
                ]),
            )?;
            let frozen = reason(&class);
            put(&mut schedule, "state", JsValue::string("frozen"))?;
            put(&mut schedule, "freezeReason", frozen.clone())?;
            return Ok((
                schedule,
                Some(JsValue::object(vec![
                    ("type", JsValue::string("frozen")),
                    ("sessionId", JsValue::string(session)),
                    ("reason", frozen),
                ])),
            ));
        }
        return Ok((schedule, None));
    }
    let mut schedule = schedule.unwrap();
    if truthy(&class) {
        put(&mut schedule, "classifyState", class)?;
        put(&mut schedule, "classifyStateAt", now.clone())?;
    }
    let class = classification(&schedule);
    let active = field(&schedule, "active");
    if !truthy(&active) {
        put(&mut schedule, "state", JsValue::string("idle"))?;
        put(&mut schedule, "freezeReason", JsValue::Null)?;
        put(&mut schedule, "awaitingRequestId", JsValue::Null)?;
        put(&mut schedule, "updatedAt", now)?;
        return Ok((schedule, None));
    }
    let entry = field(&active, "entryId");
    let task = fallback(field(&active, "taskId"), JsValue::Null);
    let mut event = JsValue::object(vec![
        ("sessionId", JsValue::string(session)),
        ("entryId", entry.clone()),
        ("taskId", task.clone()),
    ]);
    let mut complete = is(&class, "E");
    if is(&class, "D") {
        let started = js_to_number(&fallback(
            field(&active, "startedAt"),
            field(&active, "claimedAt"),
        ));
        let ended = js_to_number(&field(observed, "endedAt"));
        let observed_task = field(observed, "taskId");
        let success = is(&field(observed, "classifyState"), "D")
            && started.is_finite()
            && started > 0.0
            && ended.is_finite()
            && ended >= started
            && (!truthy(&task) || !truthy(&observed_task) || task == observed_task);
        if !success {
            put(&mut schedule, "classifyState", JsValue::string("P"))?;
            put(&mut schedule, "state", JsValue::string("assessing"))?;
            put(&mut schedule, "freezeReason", JsValue::Null)?;
            put(&mut event, "type", JsValue::string("assessing"))?;
        } else if delivery_needs_ack {
            put(&mut schedule, "state", JsValue::string("frozen"))?;
            put(
                &mut schedule,
                "freezeReason",
                JsValue::string("delivery_recovery"),
            )?;
            put(&mut event, "type", JsValue::string("frozen"))?;
            put(&mut event, "reason", JsValue::string("delivery_recovery"))?;
        } else {
            complete = true;
        }
    } else if !complete {
        let frozen = reason(&class);
        put(&mut schedule, "state", JsValue::string("frozen"))?;
        put(&mut schedule, "freezeReason", frozen.clone())?;
        put(&mut event, "type", JsValue::string("frozen"))?;
        put(&mut event, "reason", frozen)?;
    }
    if complete {
        let superseded = fallback(field(&active, "supersededByEntryId"), JsValue::Null);
        let is_superseded = truthy(&superseded);
        put(&mut schedule, "active", JsValue::Null)?;
        put(&mut schedule, "state", JsValue::string("idle"))?;
        put(&mut schedule, "freezeReason", JsValue::Null)?;
        put(&mut schedule, "awaitingRequestId", JsValue::Null)?;
        put(
            &mut schedule,
            "lastDecision",
            JsValue::object(vec![
                (
                    "action",
                    JsValue::string(if is_superseded {
                        "superseded"
                    } else {
                        "complete"
                    }),
                ),
                (
                    "reason",
                    JsValue::string(if is_superseded {
                        "superseded_by_immediate_insert"
                    } else if is(&class, "E") {
                        "recovered-classify-E"
                    } else {
                        "recovered-classify-D"
                    }),
                ),
                ("entryId", entry),
                ("taskId", task),
                (
                    "originDispatchId",
                    fallback(field(&active, "originDispatchId"), JsValue::Null),
                ),
                ("supersededByEntryId", superseded),
                ("at", now.clone()),
            ]),
        )?;
        put(&mut event, "type", JsValue::string("completed"))?;
        put(&mut event, "classifyState", class.clone())?;
        put(
            &mut event,
            "turnOutcome",
            JsValue::string(if is(&class, "E") {
                "failed"
            } else {
                "succeeded"
            }),
        )?;
    }
    put(&mut schedule, "updatedAt", now)?;
    Ok((schedule, Some(event)))
}

/// Apply all captured host facts under one immediate SQLite write transaction.
/// This entry point remains private until the observation protocol is connected.
#[allow(dead_code)]
pub(super) fn commit(
    store: &mut super::Store,
    input: &serde_json::Value,
) -> Result<serde_json::Value> {
    commit_impl(store, input, false)
}

/// Owned facts always require a version check, even if the caller omitted it.
pub(super) fn owned_commit(
    store: &mut super::Store,
    input: &serde_json::Value,
) -> Result<serde_json::Value> {
    commit_impl(store, input, true)
}

fn commit_impl(
    store: &mut super::Store,
    input: &serde_json::Value,
    require_owned: bool,
) -> Result<serde_json::Value> {
    use super::{header, meta, record, schedule_admit_live, set_meta, write_record_json};
    use rusqlite::TransactionBehavior;
    use serde_json::json;
    if store.active || store.pending {
        return Err(err("schedule recovery requires an idle owner connection"));
    }
    if require_owned
        && input.as_object().is_none_or(|object| {
            object.keys().any(|key| {
                !matches!(
                    key.as_str(),
                    "expectedRevision" | "expectedDataVersion" | "at" | "updatedAt" | "facts"
                )
            })
        })
    {
        return Err(err("unsupported owned recovery parameter"));
    }
    let expected_revision = input["expectedRevision"]
        .as_u64()
        .ok_or_else(|| err("expectedRevision required"))?;
    let expected_data_version = input["expectedDataVersion"]
        .as_i64()
        .ok_or_else(|| err("expectedDataVersion required"))?;
    let at = input["at"]
        .as_f64()
        .ok_or_else(|| err("recovery clock required"))?;
    let updated_at = input["updatedAt"]
        .as_i64()
        .ok_or_else(|| err("store clock required"))?;
    let facts = input["facts"]
        .as_array()
        .ok_or_else(|| err("recovery facts required"))?;
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
    if revision != expected_revision || data_version != expected_data_version {
        return Err(format!(
            "ORCHESTRATION_SQLITE_CONFLICT:{expected_revision}:{revision}"
        ));
    }
    let sessions: std::collections::HashSet<String> = {
        let mut query = tx.prepare(
            "SELECT session_id FROM orchestration_session_schedules UNION SELECT session_id FROM orchestration_outbox WHERE state IN ('pending','leased')"
        ).map_err(err)?;
        let rows = query
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(err)?;
        rows.collect::<std::result::Result<_, _>>().map_err(err)?
    };
    let ordered = if require_owned {
        Some(ordered_sessions(&tx)?)
    } else {
        None
    };
    let mut seen = std::collections::HashSet::new();
    let mut events = Vec::new();
    let mut changed = false;
    for (index, fact) in facts.iter().enumerate() {
        if require_owned
            && fact.as_object().is_none_or(|object| {
                object
                    .keys()
                    .any(|key| key != "sessionId" && key != "expectedVersion")
            })
        {
            return Err(err("owned recovery accepts only session id and version"));
        }
        let session = fact["sessionId"]
            .as_str()
            .ok_or_else(|| err("invalid recovery session"))?;
        if ordered
            .as_ref()
            .is_some_and(|ids| ids.get(index).map(String::as_str) != Some(session))
        {
            return Err(err("owned recovery session order mismatch"));
        }
        if !seen.insert(session.to_owned()) {
            return Err(err("duplicate recovery session"));
        }
        if require_owned && fact.get("expectedVersion").is_none() {
            return Err(err("owned recovery fact version required"));
        }
        let mut owned_observed = None;
        if let Some(expected) = fact.get("expectedVersion") {
            let expected = expected
                .as_u64()
                .ok_or_else(|| err("invalid recovery fact version"))?;
            let current = super::session_work_state::snapshot_encoded(&tx, session)?;
            if current["exists"] != true || current["version"].as_u64() != Some(expected) {
                return Err(err("recovery fact version conflict"));
            }
            if require_owned {
                let category = record::parse(
                    current["categoryJson"]
                        .as_str()
                        .ok_or_else(|| err("invalid owned recovery category"))?,
                )?;
                let active = record::parse(
                    current["activeTurnJson"]
                        .as_str()
                        .ok_or_else(|| err("invalid owned recovery turn"))?,
                )?;
                owned_observed = Some(owned_facts(&category, &active)?);
            }
        }
        let observed = match owned_observed {
            Some(value) => value,
            None => record::parse(
                fact["stateJson"]
                    .as_str()
                    .ok_or_else(|| err("invalid recovery fact"))?,
            )?,
        };
        let schedule = record::get_json(&tx, "sessionSchedules", session, &[])?
            .map(|raw| record::parse(&raw))
            .transpose()?;
        let active = schedule
            .as_ref()
            .map(|s| field(s, "active"))
            .unwrap_or(JsValue::Null);
        let delivery = field(&active, "deliveryId");
        let needs_ack = if let JsValue::String(id) = &delivery {
            if id.is_well_formed() {
                record::get_json(&tx, "outbox", &id.to_string_lossy(), &[])?
                    .map(|raw| record::parse(&raw))
                    .transpose()?
                    .is_some_and(|v| {
                        is(&field(&v, "state"), "pending") || is(&field(&v, "state"), "leased")
                    })
            } else {
                false
            }
        } else {
            false
        };
        let missing = schedule.is_none();
        let before = schedule.as_ref().map(record::encode).transpose()?;
        let (schedule, event) = transition(session, schedule, &observed, at, needs_ack)?;
        let after = record::encode(&schedule)?;
        if before.as_deref() != Some(after.as_str()) {
            write_record_json(&tx, "sessionSchedules", session, &after)?;
            changed = true;
        }
        if let Some(mut event) = event {
            if !missing {
                let queue = schedule_admit_live::queue_rows(&tx, session, &schedule)?;
                let projection = schedule_admit_live::public_schedule(&tx, &schedule, &queue)?;
                put(&mut event, "queued", JsValue::Number(queue.len() as f64))?;
                put(&mut event, "queuedItems", field(&projection, "queued"))?;
            }
            events.push(event);
        }
    }
    if seen != sessions {
        return Err(err("schedule recovery session snapshot mismatch"));
    }
    if changed {
        if revision >= 9_007_199_254_740_991 {
            return Err(err("schedule revision exhausted"));
        }
        set_meta(&tx, "revision", &json!(revision + 1))?;
        set_meta(&tx, "updatedAt", &json!(updated_at))?;
    }
    let result = record::encode(&JsValue::Array(events))?;
    let state = header(&tx)?;
    tx.commit().map_err(err)?;
    Ok(json!({"resultJson":result,"state":state}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestration_retention::RetentionPolicy;
    use serde_json::json;
    fn v(value: serde_json::Value) -> JsValue {
        crate::js::from_serde(&value)
    }

    #[test]
    fn owned_facts_project_gateway_completion_and_refuse_missing_type() {
        let active = v(json!({"_currentTaskId":"task"}));
        let category = v(json!({"recoveryRecordType":"gateway", "classifyState":"P",
            "startedAt":50, "lastTurnEndedAt":70}));
        let projected = owned_facts(&category, &active).unwrap();
        assert_eq!(field(&projected, "classifyState"), JsValue::string("D"));
        assert_eq!(field(&projected, "endedAt"), JsValue::Number(70.0));
        assert_eq!(field(&projected, "taskId"), JsValue::string("task"));
        let waiting = v(json!({"recoveryRecordType":"gateway", "classifyState":"W", "endedAt":70}));
        assert_eq!(
            field(
                &owned_facts(&waiting, &JsValue::Null).unwrap(),
                "classifyState"
            ),
            JsValue::string("W")
        );
        assert!(owned_facts(&v(json!({"classifyState":"P"})), &active).is_err());
    }

    #[test]
    fn owned_recovery_rejects_same_connection_fact_changes() {
        let mut random = [0_u8; 12];
        getrandom::fill(&mut random).unwrap();
        let name = random
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let dir = std::env::temp_dir().join(format!("multicc-owned-recovery-{name}"));
        std::fs::create_dir(&dir).unwrap();
        let file = dir.join("state.sqlite");
        let mut store =
            super::super::Store::open(file.to_str().unwrap(), None, 1, RetentionPolicy::default())
                .unwrap();
        super::super::write_record_json(
            store.conn().unwrap(),
            "sessionSchedules",
            "s",
            &json!({"sessionId":"s", "state":"running", "classifyState":"P",
                "active":{"entryId":"e", "taskId":"t", "startedAt":50}})
            .to_string(),
        )
        .unwrap();
        super::super::write_record_json(
            store.conn().unwrap(),
            "sessionSchedules",
            "z",
            &json!({"sessionId":"z", "state":"idle", "active":null}).to_string(),
        )
        .unwrap();
        assert!(owned_snapshot(&mut store)
            .unwrap_err()
            .contains("owned session facts"));
        let connection = store.connection.as_mut().unwrap();
        super::super::session_work_state::read_or_initialize(connection, &json!({"sessionId":"s",
            "initial":{"pendingQuestion":null,"activeTurn":{"_currentTaskId":"t"},
                "category":{"recoveryRecordType":"gateway","classifyState":"P","startedAt":50,"endedAt":70}}})).unwrap();
        super::super::session_work_state::read_or_initialize(
            store.connection.as_mut().unwrap(),
            &json!({"sessionId":"z", "initial":{"pendingQuestion":null,"activeTurn":null,
                "category":{"recoveryRecordType":null,"classifyState":null}}}),
        )
        .unwrap();
        let captured = owned_snapshot(&mut store).unwrap();
        let mut command = json!({"expectedRevision":captured["state"]["revision"],
            "expectedDataVersion":captured["dataVersion"], "at":100, "updatedAt":101,
            "facts":captured["facts"]});
        let mut missing_version = command.clone();
        missing_version["facts"][0]
            .as_object_mut()
            .unwrap()
            .remove("expectedVersion");
        assert!(owned_commit(&mut store, &missing_version)
            .unwrap_err()
            .contains("fact version required"));
        let mut reordered = command.clone();
        reordered["facts"].as_array_mut().unwrap().reverse();
        assert!(owned_commit(&mut store, &reordered)
            .unwrap_err()
            .contains("session order mismatch"));
        let invalid = json!({"action":"patchFacts", "sessionId":"s",
            "categoryPatch":{"recoveryRecordType":42}})
        .to_string();
        assert!(super::super::session_work_state::question_transition(
            store.connection.as_mut().unwrap(),
            &json!({"requestJson":invalid}),
        )
        .unwrap_err()
        .contains("invalid recovery session type"));
        let patch = json!({"action":"patchFacts", "sessionId":"s",
            "categoryPatch":{"recoveryRecordType":"worker", "classifyState":"W"}})
        .to_string();
        super::super::session_work_state::question_transition(
            store.connection.as_mut().unwrap(),
            &json!({"requestJson":patch}),
        )
        .unwrap();
        assert!(owned_commit(&mut store, &command)
            .unwrap_err()
            .contains("recovery fact version conflict"));
        let unchanged =
            super::super::record::get_json(store.conn().unwrap(), "sessionSchedules", "s", &[])
                .unwrap()
                .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&unchanged).unwrap()["state"],
            "running"
        );
        let current = owned_snapshot(&mut store).unwrap();
        command["facts"] = current["facts"].clone();
        command["expectedDataVersion"] = current["dataVersion"].clone();
        // Reject injected facts even after an earlier session has been processed;
        // the transaction must roll that earlier session back as well.
        let mut tampered = command.clone();
        tampered["facts"][1]["stateJson"] = json!("{\"classifyState\":\"D\"}");
        assert!(owned_commit(&mut store, &tampered)
            .unwrap_err()
            .contains("only session id and version"));
        let mut direct_classification = command.clone();
        direct_classification["facts"][1]["classifyState"] = json!("D");
        assert!(owned_commit(&mut store, &direct_classification)
            .unwrap_err()
            .contains("only session id and version"));
        let unchanged =
            super::super::record::get_json(store.conn().unwrap(), "sessionSchedules", "s", &[])
                .unwrap()
                .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&unchanged).unwrap()["state"],
            "running"
        );
        let mut injected = command.clone();
        injected["classifyState"] = json!("D");
        assert!(owned_commit(&mut store, &injected)
            .unwrap_err()
            .contains("unsupported owned recovery parameter"));
        owned_commit(&mut store, &command).unwrap();
        let saved =
            super::super::record::get_json(store.conn().unwrap(), "sessionSchedules", "s", &[])
                .unwrap()
                .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&saved).unwrap()["freezeReason"],
            "classify_waiting"
        );
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn snapshot_preserves_sqlite_key_order_for_schedule_and_outbox() {
        let mut random = [0_u8; 12];
        getrandom::fill(&mut random).unwrap();
        let name = random
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let dir = std::env::temp_dir().join(format!("multicc-recovery-order-{name}"));
        std::fs::create_dir(&dir).unwrap();
        let file = dir.join("state.sqlite");
        let mut store =
            super::super::Store::open(file.to_str().unwrap(), None, 1, RetentionPolicy::default())
                .unwrap();
        for id in ["\u{e000}", "𐀀", "10", "2"] {
            super::super::write_record_json(
                store.conn().unwrap(),
                "sessionSchedules",
                id,
                &json!({"sessionId":id,"state":"idle","active":null}).to_string(),
            )
            .unwrap();
        }
        for (sequence, (id, session)) in [("out-\u{e000}", "out-1"), ("out-𐀀", "out-2")]
            .into_iter()
            .enumerate()
        {
            super::super::write_record_json(
                store.conn().unwrap(),
                "outbox",
                id,
                &json!({"id":id,"sessionId":session,"state":"pending","sequence":sequence+1})
                    .to_string(),
            )
            .unwrap();
        }
        assert_eq!(
            snapshot(&mut store).unwrap()["sessions"],
            json!(["10", "2", "\u{e000}", "𐀀", "out-1", "out-2"])
        );
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn missing_schedule_only_freezes_for_non_outcomes() {
        for (class, state, has_event) in [
            ("W", "frozen", true),
            ("P", "frozen", true),
            ("B", "frozen", true),
            ("D", "idle", false),
            ("E", "idle", false),
        ] {
            let (schedule, event) = transition(
                "s",
                None,
                &v(serde_json::json!({"classifyState":class})),
                100.0,
                false,
            )
            .unwrap();
            assert_eq!(field(&schedule, "state"), JsValue::string(state));
            assert_eq!(event.is_some(), has_event);
        }
    }
    #[test]
    fn recovered_success_requires_correlated_timestamp_and_ack() {
        let schedule = v(
            serde_json::json!({"state":"running","classifyState":"P","active":{"entryId":"a","taskId":"t","startedAt":50}}),
        );
        let stale = v(serde_json::json!({"classifyState":"D","taskId":"other","endedAt":60}));
        let good = v(serde_json::json!({"classifyState":"D","taskId":"t","endedAt":60}));
        let (result, _) = transition("s", Some(schedule.clone()), &stale, 100.0, false).unwrap();
        assert_eq!(field(&result, "state"), JsValue::string("assessing"));
        let (result, _) = transition("s", Some(schedule.clone()), &good, 100.0, true).unwrap();
        assert_eq!(
            field(&result, "freezeReason"),
            JsValue::string("delivery_recovery")
        );
        let (result, event) = transition("s", Some(schedule), &good, 100.0, false).unwrap();
        assert_eq!(field(&result, "active"), JsValue::Null);
        assert_eq!(
            field(&event.unwrap(), "turnOutcome"),
            JsValue::string("succeeded")
        );
    }

    #[test]
    fn recovery_commit_is_atomic_and_rejects_external_writes() {
        let mut random = [0_u8; 12];
        getrandom::fill(&mut random).unwrap();
        let name = random
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let dir = std::env::temp_dir().join(format!("multicc-recovery-{name}"));
        std::fs::create_dir(&dir).unwrap();
        let file = dir.join("state.sqlite");
        let mut store =
            super::super::Store::open(file.to_str().unwrap(), None, 1, RetentionPolicy::default())
                .unwrap();
        for id in ["a", "b"] {
            super::super::write_record_json(store.conn().unwrap(), "sessionSchedules", id,
                &json!({"sessionId":id,"state":"running","classifyState":"P","active":{"entryId":id,"taskId":id}}).to_string()).unwrap();
        }
        let version: i64 = store
            .conn()
            .unwrap()
            .query_row("PRAGMA data_version", [], |row| row.get(0))
            .unwrap();
        let command = json!({"expectedRevision":0,"expectedDataVersion":version,"at":100,"updatedAt":101,
            "facts":[{"sessionId":"a","stateJson":"{\"classifyState\":\"E\"}"},
                     {"sessionId":"b","stateJson":"{\"classifyState\":\"W\"}"}]});
        store.conn().unwrap().execute_batch("CREATE TRIGGER fail_recovery BEFORE UPDATE ON orchestration_session_schedules WHEN NEW.session_id='b' BEGIN SELECT RAISE(ABORT, 'reject recovery'); END").unwrap();
        assert!(commit(&mut store, &command).is_err());
        let row =
            super::super::record::get_json(store.conn().unwrap(), "sessionSchedules", "a", &[])
                .unwrap()
                .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&row).unwrap()["state"],
            "running"
        );
        store
            .conn()
            .unwrap()
            .execute_batch("DROP TRIGGER fail_recovery")
            .unwrap();
        let external = rusqlite::Connection::open(&file).unwrap();
        external.execute("UPDATE orchestration_session_schedules SET data_json=json_set(data_json,'$.external',7) WHERE session_id='a'", []).unwrap();
        assert!(commit(&mut store, &command)
            .unwrap_err()
            .contains("ORCHESTRATION_SQLITE_CONFLICT"));
        let row =
            super::super::record::get_json(store.conn().unwrap(), "sessionSchedules", "a", &[])
                .unwrap()
                .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&row).unwrap()["external"],
            7
        );
        let mut current = command.clone();
        current["expectedDataVersion"] = json!(store
            .conn()
            .unwrap()
            .query_row("PRAGMA data_version", [], |row| row.get::<_, i64>(0))
            .unwrap());
        let mut missing = current.clone();
        missing["facts"].as_array_mut().unwrap().pop();
        assert!(commit(&mut store, &missing)
            .unwrap_err()
            .contains("session snapshot mismatch"));
        let result = commit(&mut store, &current).unwrap();
        assert_eq!(result["state"]["revision"], 1);
        let first =
            super::super::record::get_json(store.conn().unwrap(), "sessionSchedules", "a", &[])
                .unwrap()
                .unwrap();
        let second =
            super::super::record::get_json(store.conn().unwrap(), "sessionSchedules", "b", &[])
                .unwrap()
                .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&first).unwrap()["state"],
            "idle"
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&second).unwrap()["state"],
            "frozen"
        );
        drop(external);
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
