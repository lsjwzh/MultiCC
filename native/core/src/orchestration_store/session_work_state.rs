//! Versioned session-work facts, owned by the orchestration SQLite connection.
//!
//! The API is intentionally not connected to the live hosts yet. All facts in
//! a request are committed together, including updates to multiple sessions.
use super::{corrupt, err, record, Result};
use crate::js::{js_to_string, truthy, JsValue};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior, TransactionState};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;

const MAX_VERSION: u64 = 9_007_199_254_740_991;

fn field(object: &JsValue, name: &str) -> JsValue {
    object.get(name).cloned().unwrap_or(JsValue::Undefined)
}

fn put(object: &mut JsValue, name: &str, value: JsValue) -> Result<()> {
    let JsValue::Object(fields) = object else {
        return Err(err("session work object required"));
    };
    if let Some((_, current)) = fields.iter_mut().find(|(key, _)| key == name) {
        *current = value;
    } else {
        fields.push((name.into(), value));
    }
    Ok(())
}

fn or_null(value: JsValue) -> JsValue {
    if truthy(&value) {
        value
    } else {
        JsValue::Null
    }
}

fn nullish(value: JsValue) -> JsValue {
    if matches!(value, JsValue::Undefined | JsValue::Null) {
        JsValue::Null
    } else {
        value
    }
}

pub(super) fn initialize(connection: &Connection) -> Result<()> {
    let already_installed: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM orchestration_meta WHERE key='sessionWorkStateSchema')",
            [],
            |row| row.get(0),
        )
        .map_err(corrupt)?;
    // An already upgraded store must remain openable while another owner
    // session holds a write transaction; only the upgrade takes a write lock.
    connection
        .execute_batch(if already_installed {
            "BEGIN"
        } else {
            "BEGIN IMMEDIATE"
        })
        .map_err(err)?;
    let result = (|| {
        let version: Option<String> = connection
            .query_row(
                "SELECT value_json FROM orchestration_meta WHERE key='sessionWorkStateSchema'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(corrupt)?;
        if already_installed && version.is_none() {
            return Err(corrupt("session work state schema marker disappeared"));
        }
        if let Some(version) = &version {
            if serde_json::from_str::<Value>(version).map_err(corrupt)? != json!(1) {
                return Err(corrupt("unsupported session work state schema"));
            }
        } else {
            connection
                .execute_batch(
                    "CREATE TABLE IF NOT EXISTS orchestration_session_work_state (
          session_id TEXT PRIMARY KEY,
          version INTEGER NOT NULL CHECK(version > 0),
          pending_question_json TEXT NOT NULL,
          active_turn_json TEXT NOT NULL,
          category_json TEXT NOT NULL
        ) WITHOUT ROWID;",
                )
                .map_err(err)?;
        }
        let mut statement = connection
            .prepare("PRAGMA table_info(orchestration_session_work_state)")
            .map_err(corrupt)?;
        let columns: Vec<(String, String, bool, bool)> = statement
            .query_map([], |row| {
                Ok((
                    row.get(1)?,
                    row.get(2)?,
                    row.get::<_, i64>(3)? != 0,
                    row.get::<_, i64>(5)? != 0,
                ))
            })
            .map_err(corrupt)?
            .collect::<std::result::Result<_, _>>()
            .map_err(corrupt)?;
        let expected = [
            ("session_id", "TEXT", true, true),
            ("version", "INTEGER", true, false),
            ("pending_question_json", "TEXT", true, false),
            ("active_turn_json", "TEXT", true, false),
            ("category_json", "TEXT", true, false),
        ];
        if columns.len() != expected.len()
            || columns.iter().zip(expected).any(|(actual, expected)| {
                actual.0 != expected.0
                    || actual.1 != expected.1
                    || actual.2 != expected.2
                    || actual.3 != expected.3
            })
        {
            return Err(corrupt("invalid or missing session work state table"));
        }
        drop(statement);
        if version.is_none() {
            connection.execute("INSERT INTO orchestration_meta(key,value_json) VALUES('sessionWorkStateSchema','1')", []).map_err(err)?;
        }
        Ok(())
    })();
    match result {
        Ok(()) => connection.execute_batch("COMMIT").map_err(err),
        Err(error) => {
            let _ = connection.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Update {
    session_id: String,
    expected_version: u64,
    pending_question: Value,
    active_turn: Value,
    category: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InitialState {
    pending_question: Value,
    active_turn: Value,
    category: Value,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct EncodedState {
    pub(super) pending_question_json: String,
    pub(super) active_turn_json: String,
    pub(super) category_json: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EncodedUpdate {
    session_id: String,
    expected_version: u64,
    pending_question_json: String,
    active_turn_json: String,
    category_json: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EncodedInitialEntry {
    session_id: String,
    initial: EncodedState,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EncodedPatch {
    expected_version: u64,
    pending_question_json: Option<String>,
    active_turn_json: Option<String>,
    category_json: Option<String>,
}

fn validate_encoded(state: &EncodedState) -> Result<()> {
    for raw in [
        &state.pending_question_json,
        &state.active_turn_json,
        &state.category_json,
    ] {
        record::parse(raw)?;
    }
    Ok(())
}

pub(super) fn snapshot_encoded(connection: &Connection, id: &str) -> Result<Value> {
    let row: Option<(u64, String, String, String)> = connection
        .query_row(
            "SELECT version, pending_question_json, active_turn_json, category_json
         FROM orchestration_session_work_state WHERE session_id=?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(err)?;
    let (version, pending, turn, category) =
        row.unwrap_or_else(|| (0, "null".into(), "null".into(), "null".into()));
    if version > MAX_VERSION {
        return Err(err("invalid session work state version"));
    }
    let state = EncodedState {
        pending_question_json: pending,
        active_turn_json: turn,
        category_json: category,
    };
    validate_encoded(&state)?;
    Ok(
        json!({"sessionId":id,"version":version,"exists":version != 0,
        "pendingQuestionJson":state.pending_question_json,"activeTurnJson":state.active_turn_json,
        "categoryJson":state.category_json}),
    )
}

/// Read the authoritative session facts while the caller holds the same
/// SQLite write transaction that will update the scheduling records.
pub(super) fn snapshot_in_write_transaction(connection: &Connection, id: &str) -> Result<Value> {
    if connection.transaction_state(Some("main")).map_err(err)? != TransactionState::Write {
        return Err(err("session work state requires a write transaction"));
    }
    snapshot_encoded(connection, id)
}

pub(super) fn encoded_read(connection: &Connection, input: &Value) -> Result<Value> {
    snapshot_encoded(connection, session_id(input)?)
}

pub(super) fn encoded_initialize(connection: &mut Connection, input: &Value) -> Result<Value> {
    let id = session_id(input)?;
    let initial: EncodedState = serde_json::from_value(
        input
            .get("initial")
            .cloned()
            .ok_or_else(|| err("session work state initial snapshot required"))?,
    )
    .map_err(err)?;
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(err)?;
    let result = initialize_in_transaction(&tx, id, &initial)?;
    tx.commit().map_err(err)?;
    Ok(result)
}

/// Import one trusted startup capture atomically. Existing canonical rows win;
/// malformed or duplicate entries reject the whole batch before any write.
pub(super) fn encoded_initialize_batch(
    connection: &mut Connection,
    input: &Value,
) -> Result<Value> {
    let entries: Vec<EncodedInitialEntry> = serde_json::from_value(
        input
            .get("entries")
            .cloned()
            .ok_or_else(|| err("session work state entries required"))?,
    )
    .map_err(err)?;
    let mut ids = HashSet::new();
    for entry in &entries {
        if entry.session_id.is_empty() || !ids.insert(&entry.session_id) {
            return Err(err("invalid session work state initialization batch"));
        }
        validate_encoded(&entry.initial)?;
    }
    if entries.is_empty() {
        return Ok(json!({"snapshots":[]}));
    }
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(err)?;
    let mut snapshots = Vec::with_capacity(entries.len());
    for entry in entries {
        snapshots.push(initialize_in_transaction(
            &tx,
            &entry.session_id,
            &entry.initial,
        )?);
    }
    tx.commit().map_err(err)?;
    Ok(json!({"snapshots":snapshots}))
}

/// Backfill a trusted snapshot under the caller's write lock. An existing
/// canonical row always wins; neither this function nor its caller commits.
pub(super) fn initialize_in_transaction(
    connection: &Connection,
    id: &str,
    initial: &EncodedState,
) -> Result<Value> {
    if connection.transaction_state(Some("main")).map_err(err)? != TransactionState::Write {
        return Err(err("session work state requires a write transaction"));
    }
    if id.is_empty() {
        return Err(err("session work state requires a session id"));
    }
    validate_encoded(initial)?;
    connection
        .execute(
            "INSERT INTO orchestration_session_work_state
        (session_id, version, pending_question_json, active_turn_json, category_json)
        VALUES (?1,1,?2,?3,?4) ON CONFLICT(session_id) DO NOTHING",
            params![
                id,
                initial.pending_question_json,
                initial.active_turn_json,
                initial.category_json
            ],
        )
        .map_err(err)?;
    snapshot_encoded(connection, id)
}

pub(super) fn encoded_write(connection: &mut Connection, input: &Value) -> Result<Value> {
    let updates: Vec<EncodedUpdate> = serde_json::from_value(
        input
            .get("updates")
            .cloned()
            .ok_or_else(|| err("session work state updates required"))?,
    )
    .map_err(err)?;
    let mut ids = HashSet::new();
    if updates.is_empty()
        || updates.iter().any(|u| {
            u.session_id.is_empty()
                || u.expected_version >= MAX_VERSION
                || !ids.insert(&u.session_id)
        })
    {
        return Err(err("invalid session work state update"));
    }
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(err)?;
    let mut snapshots = Vec::with_capacity(updates.len());
    for update in updates {
        let initial = EncodedState {
            pending_question_json: update.pending_question_json,
            active_turn_json: update.active_turn_json,
            category_json: update.category_json,
        };
        snapshots.push(write_in_transaction(
            &tx,
            &update.session_id,
            update.expected_version,
            &initial,
        )?);
    }
    tx.commit().map_err(err)?;
    Ok(json!({"snapshots":snapshots}))
}

/// Update selected facts while holding the same SQLite write lock used by
/// admission. Existing facts are read under that lock; an absent row can use
/// a complete trusted initial snapshot, atomically with the patch.
pub(super) fn encoded_patch(connection: &mut Connection, input: &Value) -> Result<Value> {
    let id = session_id(input)?;
    let patch: EncodedPatch = serde_json::from_value(
        input
            .get("patch")
            .cloned()
            .ok_or_else(|| err("session work state patch required"))?,
    )
    .map_err(err)?;
    if patch.pending_question_json.is_none()
        && patch.active_turn_json.is_none()
        && patch.category_json.is_none()
    {
        return Err(err("session work state patch must change a field"));
    }
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(err)?;
    let current = snapshot_in_write_transaction(&tx, id)?;
    if current["version"].as_u64() != Some(patch.expected_version) {
        return Err(err("session work state version conflict"));
    }
    let initial: Option<EncodedState> = if current["exists"] != true {
        Some(
            serde_json::from_value(
                input
                    .get("initial")
                    .cloned()
                    .ok_or_else(|| err("session work state is not initialized"))?,
            )
            .map_err(err)?,
        )
    } else {
        None
    };
    if let Some(initial) = &initial {
        validate_encoded(initial)?;
    }
    let current_field = |name: &str| -> Result<String> {
        if let Some(initial) = &initial {
            return match name {
                "pendingQuestionJson" => Ok(initial.pending_question_json.clone()),
                "activeTurnJson" => Ok(initial.active_turn_json.clone()),
                "categoryJson" => Ok(initial.category_json.clone()),
                _ => Err(err("invalid session work state field")),
            };
        }
        current[name]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| err("invalid session work state"))
    };
    let state = EncodedState {
        pending_question_json: patch
            .pending_question_json
            .unwrap_or(current_field("pendingQuestionJson")?),
        active_turn_json: patch
            .active_turn_json
            .unwrap_or(current_field("activeTurnJson")?),
        category_json: patch
            .category_json
            .unwrap_or(current_field("categoryJson")?),
    };
    let result = write_in_transaction(&tx, id, patch.expected_version, &state)?;
    tx.commit().map_err(err)?;
    Ok(result)
}

/// Question lifecycle on the same SQLite owner used by admission. This is not
/// connected to live hosts until active-turn and classify writers migrate too.
pub(super) fn question_transition(connection: &mut Connection, input: &Value) -> Result<Value> {
    let raw = input["requestJson"]
        .as_str()
        .ok_or_else(|| err("question request required"))?;
    let request = record::parse(raw)?;
    let action = field(&request, "action");
    let id = match field(&request, "sessionId") {
        JsValue::String(value) if value.is_well_formed() && !value.is_empty() => {
            value.to_string_lossy()
        }
        _ if action == JsValue::string("move") => {
            return Ok(json!({"result":{"ok":false,"code":"invalid_move"}}))
        }
        _ => return Err(err("question transition requires sessionId")),
    };
    let requested_version = match field(&request, "expectedVersion") {
        JsValue::Undefined => None,
        JsValue::Number(value)
            if value.is_finite()
                && value >= 0.0
                && value.fract() == 0.0
                && value <= MAX_VERSION as f64 =>
        {
            Some(value as u64)
        }
        _ => return Err(err("question transition requires expectedVersion")),
    };
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(err)?;
    let current = snapshot_in_write_transaction(&tx, &id)?;
    let expected = current["version"]
        .as_u64()
        .ok_or_else(|| err("invalid session work state version"))?;
    if requested_version.is_some_and(|version| version != expected) {
        return Err(err("session work state version conflict"));
    }
    let mut encoded = if current["exists"] == true {
        serde_json::from_value::<EncodedState>(json!({
            "pendingQuestionJson":current["pendingQuestionJson"], "activeTurnJson":current["activeTurnJson"],
            "categoryJson":current["categoryJson"]
        })).map_err(err)?
    } else {
        let initial = field(&request, "initialState");
        if !matches!(initial, JsValue::Object(_)) {
            return Err(err(
                "question transition requires a trusted initial snapshot",
            ));
        }
        let required = |name: &str| -> Result<String> {
            record::encode(
                initial
                    .get(name)
                    .ok_or_else(|| err(format!("initial snapshot requires {name}")))?,
            )
        };
        EncodedState {
            pending_question_json: required("pendingQuestion")?,
            active_turn_json: required("activeTurn")?,
            category_json: required("category")?,
        }
    };
    validate_encoded(&encoded)?;
    let mut pending = record::parse(&encoded.pending_question_json)?;
    let stored_active = record::parse(&encoded.active_turn_json)?;
    // Until turn ownership moves to this store, the synchronous caller must be
    // able to provide the live turn it observed for the record guard. Do not
    // silently replace the separately owned active-turn snapshot here.
    let active = request
        .get("liveActiveTurn")
        .cloned()
        .unwrap_or(stored_active);
    let mut category = match record::parse(&encoded.category_json)? {
        value @ JsValue::Object(_) => value,
        JsValue::Null => JsValue::Object(vec![]),
        value @ JsValue::String(_) => JsValue::object(vec![("classifyState", value)]),
        _ => return Err(err("invalid session work category")),
    };
    if action == JsValue::string("patchFacts") {
        let original = encoded.clone();
        let original_category = category.clone();
        if let Some(patch) = request.get("categoryPatch") {
            let JsValue::Object(entries) = patch else {
                return Err(err("session work category patch must be an object"));
            };
            for (key, value) in entries {
                if !key.is_well_formed() {
                    return Err(err("invalid session work category field"));
                }
                let key = key.to_string_lossy();
                if !matches!(
                    key.as_str(),
                    "classifyState"
                        | "recoveryRecordType"
                        | "goalState"
                        | "unattended"
                        | "runActive"
                        | "startedAt"
                        | "endedAt"
                        | "lastTurnEndedAt"
                ) {
                    return Err(err("unsupported session work category field"));
                }
                if key == "recoveryRecordType"
                    && !matches!(value, JsValue::String(_) | JsValue::Null)
                {
                    return Err(err("invalid recovery session type"));
                }
                put(&mut category, &key, value.clone())?;
            }
            if category != original_category {
                encoded.category_json = record::encode(&category)?;
            }
        }
        if let Some(active_turn) = request.get("activeTurn") {
            if record::parse(&encoded.active_turn_json)? != *active_turn {
                encoded.active_turn_json = record::encode(active_turn)?;
            }
        }
        if current["exists"] == true
            && encoded.pending_question_json == original.pending_question_json
            && encoded.active_turn_json == original.active_turn_json
            && encoded.category_json == original.category_json
        {
            return Ok(
                json!({"result":{"ok":true,"changed":false},"snapshot":current,"notificationJson":"null"}),
            );
        }
        let saved = write_in_transaction(&tx, &id, expected, &encoded)?;
        tx.commit().map_err(err)?;
        return Ok(
            json!({"result":{"ok":true,"changed":true},"snapshot":saved,"notificationJson":"null"}),
        );
    }
    let at = match field(&request, "at") {
        JsValue::Number(value) if value.is_finite() => JsValue::Number(value),
        _ => return Err(err("question transition requires clock")),
    };
    if action == JsValue::string("move") {
        let target_id = match field(&request, "targetSessionId") {
            JsValue::String(value) if value.is_well_formed() && !value.is_empty() => {
                value.to_string_lossy()
            }
            _ => return Ok(json!({"result":{"ok":false,"code":"invalid_move"}})),
        };
        if target_id == id {
            return Ok(json!({"result":{"ok":false,"code":"invalid_move"}}));
        }
        if !truthy(&pending) || field(&pending, "resolved") == JsValue::Bool(true) {
            return Ok(
                json!({"result":{"ok":false,"code":if truthy(&pending) {"already_resolved"} else {"no_pending_request"}}}),
            );
        }
        let expected_request = field(&request, "expectedRequestId");
        if !matches!(expected_request, JsValue::Undefined | JsValue::Null) {
            if !matches!(&expected_request, JsValue::String(value) if !value.is_empty()) {
                return Err(err("invalid expected question request id"));
            }
            if field(&pending, "requestId") != expected_request {
                return Ok(json!({"result":{"ok":false,"code":"request_id_mismatch"}}));
            }
        }
        let requested_turn = field(&request, "turnId");
        let current_turn = field(&pending, "turnId");
        if truthy(&requested_turn) && truthy(&current_turn) && requested_turn != current_turn {
            return Ok(json!({"result":{"ok":false,"code":"turn_mismatch"}}));
        }
        let requested_target_version = match field(&request, "targetExpectedVersion") {
            JsValue::Undefined => None,
            JsValue::Number(value)
                if value.is_finite()
                    && value >= 0.0
                    && value.fract() == 0.0
                    && value <= MAX_VERSION as f64 =>
            {
                Some(value as u64)
            }
            _ => return Err(err("question move requires targetExpectedVersion")),
        };
        let target = snapshot_in_write_transaction(&tx, &target_id)?;
        let target_version = target["version"]
            .as_u64()
            .ok_or_else(|| err("invalid target session work state version"))?;
        if requested_target_version.is_some_and(|version| version != target_version) {
            return Err(err("session work state version conflict"));
        }
        let mut target_encoded = if target["exists"] == true {
            serde_json::from_value::<EncodedState>(json!({
                "pendingQuestionJson":target["pendingQuestionJson"], "activeTurnJson":target["activeTurnJson"],
                "categoryJson":target["categoryJson"]
            })).map_err(err)?
        } else {
            let initial = field(&request, "targetInitialState");
            if !matches!(initial, JsValue::Object(_)) {
                return Err(err("question move requires a trusted target snapshot"));
            }
            let required = |name: &str| -> Result<String> {
                record::encode(
                    initial
                        .get(name)
                        .ok_or_else(|| err(format!("target snapshot requires {name}")))?,
                )
            };
            EncodedState {
                pending_question_json: required("pendingQuestion")?,
                active_turn_json: required("activeTurn")?,
                category_json: required("category")?,
            }
        };
        validate_encoded(&target_encoded)?;
        let target_pending = record::parse(&target_encoded.pending_question_json)?;
        if truthy(&target_pending) && field(&target_pending, "resolved") != JsValue::Bool(true) {
            return Ok(json!({"result":{"ok":false,"code":"target_already_pending"}}));
        }
        let mut target_category = match record::parse(&target_encoded.category_json)? {
            value @ JsValue::Object(_) => value,
            JsValue::Null => JsValue::Object(vec![]),
            value @ JsValue::String(_) => JsValue::object(vec![("classifyState", value)]),
            _ => return Err(err("invalid session work category")),
        };
        let original = pending.clone();
        let request_id = field(&pending, "requestId");
        let source_task = nullish(field(&pending, "taskId"));
        put(&mut pending, "resolved", JsValue::Bool(true))?;
        put(&mut pending, "resolvedAt", at.clone())?;
        put(&mut pending, "resolution", JsValue::string("moved"))?;
        put(
            &mut pending,
            "movedToSessionId",
            JsValue::string(&target_id),
        )?;
        put(
            &mut category,
            "lastResolvedUserInput",
            JsValue::object(vec![
                ("requestId", request_id.clone()),
                ("at", at.clone()),
                ("taskId", source_task.clone()),
                ("resolution", JsValue::string("moved")),
            ]),
        )?;
        put(
            &mut category,
            "userInputSignalVersion",
            JsValue::Number(1.0),
        )?;
        let task = field(&request, "taskId");
        let selected_task = if truthy(&task) {
            task
        } else {
            or_null(field(&original, "taskId"))
        };
        let reason = field(&original, "reason");
        let options = field(&original, "options");
        let created_at = field(&original, "createdAt");
        let mut moved = JsValue::object(vec![
            ("requestId", request_id.clone()),
            ("turnId", or_null(current_turn.clone())),
            ("taskId", selected_task),
            ("question", field(&original, "question")),
            (
                "reason",
                if truthy(&reason) {
                    reason
                } else {
                    JsValue::string("")
                },
            ),
            (
                "options",
                if matches!(options, JsValue::Array(_)) {
                    options
                } else {
                    JsValue::Array(vec![])
                },
            ),
            (
                "allowMultiple",
                JsValue::Bool(field(&original, "allowMultiple") == JsValue::Bool(true)),
            ),
            (
                "createdAt",
                if truthy(&created_at) {
                    created_at
                } else {
                    at.clone()
                },
            ),
            ("resolved", JsValue::Bool(false)),
            ("movedFromSessionId", JsValue::string(&id)),
        ]);
        let secret = field(&original, "secretName");
        if field(&original, "inputType") == JsValue::string("secret") && truthy(&secret) {
            put(&mut moved, "inputType", JsValue::string("secret"))?;
            put(
                &mut moved,
                "secretName",
                JsValue::String(js_to_string(&secret)),
            )?;
        }
        if truthy(&current_turn) {
            put(&mut target_category, "userInputSignalTurnId", current_turn)?;
        }
        put(
            &mut target_category,
            "userInputSignalVersion",
            JsValue::Number(1.0),
        )?;
        put(&mut target_category, "classifyState", JsValue::string("W"))?;
        encoded.pending_question_json = record::encode(&pending)?;
        encoded.category_json = record::encode(&category)?;
        target_encoded.pending_question_json = record::encode(&moved)?;
        target_encoded.category_json = record::encode(&target_category)?;
        let saved = write_in_transaction(&tx, &id, expected, &encoded)?;
        let target_saved = write_in_transaction(&tx, &target_id, target_version, &target_encoded)?;
        let notification = record::encode(&JsValue::object(vec![
            ("type", JsValue::string("user_input_resolved")),
            ("requestId", request_id),
            ("taskId", source_task),
            ("resolution", JsValue::string("moved")),
        ]))?;
        tx.commit().map_err(err)?;
        return Ok(
            json!({"result":{"ok":true},"snapshot":saved,"targetSnapshot":target_saved,
            "notificationJson":notification,"questionJson":record::encode(&original)?}),
        );
    }
    let mut notification = JsValue::Null;
    let result = if action == JsValue::string("record") {
        let signal = field(&request, "signal");
        let turn_id = field(&signal, "turnId");
        let request_id = field(&signal, "requestId");
        if field(&signal, "sessionId") != JsValue::string(&id)
            || !matches!(&turn_id, JsValue::String(value) if !value.is_empty())
        {
            return Err(err(
                "question transition requires matching sessionId and turnId",
            ));
        }
        if !matches!(&request_id, JsValue::String(id) if !id.is_empty()) {
            return Err(err("question transition requires requestId"));
        }
        let turn = field(&active, "_activeTurn");
        if !truthy(&turn)
            || field(&turn, "turnId") != turn_id
            || !truthy(&field(&active, "isStreaming"))
        {
            return Ok(json!({"result":{"ok":false,"code":"turn_not_active"}}));
        }
        if field(&pending, "requestId") == request_id {
            return Ok(json!({"result":{"ok":true,"duplicate":true}}));
        }
        if truthy(&pending) && field(&pending, "resolved") != JsValue::Bool(true) {
            return Ok(json!({"result":{"ok":false,"code":"user_input_already_pending"}}));
        }
        let options = match field(&signal, "options") {
            value @ JsValue::Array(_) => value,
            _ => JsValue::Array(vec![]),
        };
        let reason = match field(&signal, "reason") {
            value if truthy(&value) => value,
            _ => JsValue::string(""),
        };
        let task_id = or_null(field(&active, "_currentTaskId"));
        pending = JsValue::object(vec![
            ("requestId", request_id.clone()),
            ("turnId", turn_id.clone()),
            ("taskId", task_id.clone()),
            ("question", field(&signal, "question")),
            ("reason", reason.clone()),
            ("options", options.clone()),
            (
                "allowMultiple",
                JsValue::Bool(field(&signal, "allowMultiple") == JsValue::Bool(true)),
            ),
            ("createdAt", at.clone()),
            ("resolved", JsValue::Bool(false)),
        ]);
        let secret = field(&signal, "secretName");
        if field(&signal, "inputType") == JsValue::string("secret") {
            // The frozen host applies String(signal.secretName || '') before
            // validating and storing the name, including for non-string input.
            let text = if truthy(&secret) {
                js_to_string(&secret).to_string_lossy()
            } else {
                String::new()
            };
            if !text.is_empty()
                && text.len() <= 64
                && text
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
            {
                put(&mut pending, "inputType", JsValue::string("secret"))?;
                put(&mut pending, "secretName", JsValue::string(&text))?;
            }
        }
        put(
            &mut category,
            "userInputSignalVersion",
            JsValue::Number(1.0),
        )?;
        notification = JsValue::object(vec![
            ("type", JsValue::string("user_input_required")),
            ("requestId", request_id),
            ("turnId", turn_id),
            ("taskId", task_id),
            ("question", field(&signal, "question")),
            ("reason", reason),
            ("options", options),
            ("allowMultiple", field(&pending, "allowMultiple")),
        ]);
        if field(&pending, "inputType") == JsValue::string("secret") {
            put(&mut notification, "inputType", JsValue::string("secret"))?;
            put(
                &mut notification,
                "secretName",
                field(&pending, "secretName"),
            )?;
        }
        json!({"ok":true,"duplicate":false})
    } else if action == JsValue::string("beginTurn") {
        if let Some(turn) = request.get("activeTurn") {
            if !matches!(turn, JsValue::Object(_) | JsValue::Null) {
                return Err(err("invalid session work active turn"));
            }
            encoded.active_turn_json = record::encode(turn)?;
        }
        let continuation = field(&request, "originContinue") == JsValue::Bool(true);
        let request_id = field(&pending, "requestId");
        let superseded = !continuation
            && truthy(&pending)
            && field(&pending, "resolved") != JsValue::Bool(true)
            && truthy(&request_id);
        if superseded {
            let last = JsValue::object(vec![
                ("requestId", request_id.clone()),
                ("at", at.clone()),
                ("superseded", JsValue::Bool(true)),
            ]);
            put(&mut category, "lastResolvedUserInput", last)?;
            notification = JsValue::object(vec![
                ("type", JsValue::string("user_input_resolved")),
                ("requestId", request_id),
                ("taskId", nullish(field(&pending, "taskId"))),
                ("superseded", JsValue::Bool(true)),
            ]);
        } else {
            let last = or_null(field(&category, "lastResolvedUserInput"));
            put(&mut category, "lastResolvedUserInput", last)?;
        }
        pending = if continuation {
            or_null(pending)
        } else {
            JsValue::Null
        };
        put(
            &mut category,
            "userInputSignalVersion",
            JsValue::Number(1.0),
        )?;
        put(
            &mut category,
            "userInputSignalTurnId",
            or_null(field(&request, "turnId")),
        )?;
        put(&mut category, "classifyState", JsValue::string("P"))?;
        put(&mut category, "goalState", JsValue::Null)?;
        json!({"ok":true})
    } else if action == JsValue::string("resolve") {
        let requested = field(&request, "requestId");
        if !truthy(&pending) || field(&pending, "requestId") != requested {
            return Ok(
                json!({"result":{"ok":false,"code":if truthy(&pending) {"request_id_mismatch"} else {"no_pending_request"}}}),
            );
        }
        if field(&pending, "resolved") == JsValue::Bool(true) {
            return Ok(json!({"result":{"ok":true,"duplicate":true}}));
        }
        let dismissed = field(&request, "dismissed") == JsValue::Bool(true);
        put(&mut pending, "resolved", JsValue::Bool(true))?;
        put(&mut pending, "resolvedAt", at.clone())?;
        let task_id = nullish(field(&pending, "taskId"));
        let last_at = match field(&request, "lastResolvedAt") {
            JsValue::Number(value) if value.is_finite() => JsValue::Number(value),
            _ => at.clone(),
        };
        let mut last = JsValue::object(vec![
            ("requestId", requested.clone()),
            ("at", last_at),
            ("taskId", task_id.clone()),
        ]);
        notification = JsValue::object(vec![
            ("type", JsValue::string("user_input_resolved")),
            ("requestId", requested),
            ("taskId", task_id),
        ]);
        if dismissed {
            put(&mut pending, "resolution", JsValue::string("dismissed"))?;
            put(&mut pending, "resolvedBy", JsValue::string("user"))?;
            put(&mut last, "resolution", JsValue::string("dismissed"))?;
            put(
                &mut notification,
                "resolution",
                JsValue::string("dismissed"),
            )?;
        }
        put(&mut category, "lastResolvedUserInput", last)?;
        put(
            &mut category,
            "userInputSignalVersion",
            JsValue::Number(1.0),
        )?;
        put(&mut pending, "resolvedNotification", notification.clone())?;
        json!({"ok":true,"duplicate":false})
    } else {
        return Err(err("unknown question transition"));
    };
    encoded.pending_question_json = record::encode(&pending)?;
    encoded.category_json = record::encode(&category)?;
    let saved = write_in_transaction(&tx, &id, expected, &encoded)?;
    let notification_json = record::encode(&notification)?;
    tx.commit().map_err(err)?;
    Ok(json!({"result":result,"snapshot":saved,"notificationJson":notification_json}))
}

/// Apply one compare-and-write on the caller's already locked SQLite
/// connection. It never commits, so a scheduling command can include this
/// state in the same transaction as its schedule and outbox changes.
pub(super) fn write_in_transaction(
    connection: &Connection,
    session_id: &str,
    expected_version: u64,
    state: &EncodedState,
) -> Result<Value> {
    if connection.transaction_state(Some("main")).map_err(err)? != TransactionState::Write {
        return Err(err("session work state requires a write transaction"));
    }
    if session_id.is_empty() || expected_version >= MAX_VERSION {
        return Err(err("invalid session work state update"));
    }
    validate_encoded(state)?;
    if snapshot_in_write_transaction(connection, session_id)?["version"].as_u64()
        != Some(expected_version)
    {
        return Err(err("session work state version conflict"));
    }
    connection
        .execute(
            "INSERT INTO orchestration_session_work_state
        (session_id, version, pending_question_json, active_turn_json, category_json)
        VALUES (?1,?2,?3,?4,?5) ON CONFLICT(session_id) DO UPDATE SET
        version=excluded.version, pending_question_json=excluded.pending_question_json,
        active_turn_json=excluded.active_turn_json, category_json=excluded.category_json",
            params![
                session_id,
                expected_version + 1,
                state.pending_question_json,
                state.active_turn_json,
                state.category_json
            ],
        )
        .map_err(err)?;
    snapshot_encoded(connection, session_id)
}

fn session_id(input: &Value) -> Result<&str> {
    input
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| err("session work state requires a session id"))
}

fn snapshot(connection: &Connection, id: &str) -> Result<Value> {
    let row: Option<(u64, String, String, String)> = connection
        .query_row(
            "SELECT version, pending_question_json, active_turn_json, category_json
         FROM orchestration_session_work_state WHERE session_id=?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(err)?;
    match row {
        None => Ok(json!({"sessionId":id,"version":0,"exists":false,
            "pendingQuestion":null,"activeTurn":null,"category":null})),
        Some((version, pending, turn, category)) if (1..=MAX_VERSION).contains(&version) => {
            let parse = |raw: &str| serde_json::from_str::<Value>(raw).map_err(err);
            Ok(json!({"sessionId":id,"version":version,"exists":true,
                "pendingQuestion":parse(&pending)?,"activeTurn":parse(&turn)?,
                "category":parse(&category)?}))
        }
        Some(_) => Err(err("invalid session work state version")),
    }
}

pub(super) fn read(connection: &Connection, input: &Value) -> Result<Value> {
    snapshot(connection, session_id(input)?)
}

/// First-access import is one SQLite operation. The supplied legacy snapshot
/// is only used while no canonical row exists, including under concurrent
/// initialization; a retry never overwrites an already-owned state.
pub(super) fn read_or_initialize(connection: &mut Connection, input: &Value) -> Result<Value> {
    let id = session_id(input)?;
    let initial: InitialState = serde_json::from_value(
        input
            .get("initial")
            .cloned()
            .ok_or_else(|| err("session work state initial snapshot required"))?,
    )
    .map_err(err)?;
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(err)?;
    tx.execute(
        "INSERT INTO orchestration_session_work_state
         (session_id, version, pending_question_json, active_turn_json, category_json)
         VALUES (?1,1,?2,?3,?4) ON CONFLICT(session_id) DO NOTHING",
        params![
            id,
            initial.pending_question.to_string(),
            initial.active_turn.to_string(),
            initial.category.to_string()
        ],
    )
    .map_err(err)?;
    let result = snapshot(&tx, id)?;
    tx.commit().map_err(err)?;
    Ok(result)
}

pub(super) fn write(connection: &mut Connection, input: &Value) -> Result<Value> {
    let updates: Vec<Update> = serde_json::from_value(
        input
            .get("updates")
            .cloned()
            .ok_or_else(|| err("session work state updates required"))?,
    )
    .map_err(err)?;
    if updates.is_empty() {
        return Err(err("session work state updates required"));
    }
    let mut ids = HashSet::new();
    if updates.iter().any(|update| {
        update.session_id.is_empty()
            || update.expected_version >= MAX_VERSION
            || !ids.insert(&update.session_id)
    }) {
        return Err(err("invalid session work state update"));
    }
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(err)?;
    let mut snapshots = Vec::with_capacity(updates.len());
    for update in updates {
        let state = EncodedState {
            pending_question_json: update.pending_question.to_string(),
            active_turn_json: update.active_turn.to_string(),
            category_json: update.category.to_string(),
        };
        write_in_transaction(&tx, &update.session_id, update.expected_version, &state)?;
        snapshots.push(snapshot(&tx, &update.session_id)?);
    }
    tx.commit().map_err(err)?;
    Ok(json!({"snapshots":snapshots}))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn init(connection: &Connection) {
        connection.execute_batch("CREATE TABLE orchestration_meta (key TEXT PRIMARY KEY, value_json TEXT NOT NULL) WITHOUT ROWID").unwrap();
        initialize(connection).unwrap();
    }

    fn update(id: &str, version: u64, category: Value) -> Value {
        json!({"sessionId":id,"expectedVersion":version,"pendingQuestion":{"requestId":"r"},
            "activeTurn":{"turnId":"t"},"category":category})
    }

    #[test]
    fn question_lifecycle_can_observe_and_transition_in_one_transaction() {
        let mut connection = Connection::open_in_memory().unwrap();
        init(&connection);
        let execute = |connection: &mut Connection, request: Value| {
            question_transition(connection, &json!({"requestJson":request.to_string()}))
        };
        let initial = json!({"pendingQuestion":null,"activeTurn":{"_activeTurn":{"turnId":"t"},
            "isStreaming":true,"_currentTaskId":"task"},"category":{"classifyState":"W"}});
        let signal = |id| json!({"sessionId":"s","turnId":"t","requestId":id,"question":"Q"});
        let create = json!({"action":"record","sessionId":"s","at":1,
            "initialState":initial,"signal":signal("first")});
        let result = execute(&mut connection, create.clone()).unwrap();
        assert_eq!(result["snapshot"]["version"], 1);
        assert_eq!(
            execute(&mut connection, create).unwrap()["result"]["duplicate"],
            true
        );
        assert_eq!(
            read(&connection, &json!({"sessionId":"s"})).unwrap()["version"],
            1
        );
        let settled = execute(
            &mut connection,
            json!({"action":"resolve","sessionId":"s",
            "at":2,"requestId":"first"}),
        )
        .unwrap();
        assert_eq!(settled["snapshot"]["version"], 2);
        let replacement = execute(
            &mut connection,
            json!({"action":"record","sessionId":"s",
            "at":3,"signal":signal("second")}),
        )
        .unwrap();
        assert_eq!(replacement["snapshot"]["version"], 3);
        assert_eq!(
            read(&connection, &json!({"sessionId":"s"})).unwrap()["pendingQuestion"]["requestId"],
            "second"
        );
        let stale = json!({"action":"resolve","sessionId":"s","expectedVersion":2,"at":4,"requestId":"second"});
        assert!(execute(&mut connection, stale)
            .unwrap_err()
            .contains("version conflict"));
        assert!(execute(
            &mut connection,
            json!({"action":"record","sessionId":"new","at":1,
            "signal":{"sessionId":"new","turnId":"t","requestId":"q"}})
        )
        .unwrap_err()
        .contains("trusted initial snapshot"));
        assert_eq!(
            read(&connection, &json!({"sessionId":"new"})).unwrap()["exists"],
            false
        );
    }

    #[test]
    fn begin_turn_commits_classification_and_active_task_together() {
        let mut connection = Connection::open_in_memory().unwrap();
        init(&connection);
        read_or_initialize(
            &mut connection,
            &json!({"sessionId":"s","initial":{
            "pendingQuestion":null,"activeTurn":{"_currentTaskId":"old"},
            "category":{"classifyState":"W"}}}),
        )
        .unwrap();
        let request = json!({"action":"beginTurn","sessionId":"s","expectedVersion":1,
            "at":2,"turnId":"turn","activeTurn":{"_currentTaskId":"new"}});
        let execute = |connection: &mut Connection, value: &Value| {
            question_transition(connection, &json!({"requestJson":value.to_string()}))
        };
        let saved = execute(&mut connection, &request).unwrap();
        assert_eq!(saved["snapshot"]["version"], 2);
        let current = read(&connection, &json!({"sessionId":"s"})).unwrap();
        assert_eq!(current["category"]["classifyState"], "P");
        assert_eq!(current["activeTurn"]["_currentTaskId"], "new");
        assert!(execute(&mut connection, &request)
            .unwrap_err()
            .contains("version conflict"));
        let mut invalid = request.clone();
        invalid["expectedVersion"] = json!(2);
        invalid["activeTurn"] = json!(7);
        assert!(execute(&mut connection, &invalid)
            .unwrap_err()
            .contains("invalid session work active turn"));
        assert_eq!(
            read(&connection, &json!({"sessionId":"s"})).unwrap(),
            current
        );
    }

    #[test]
    fn fact_patch_preserves_current_question_and_is_idempotent() {
        let mut connection = Connection::open_in_memory().unwrap();
        init(&connection);
        let execute = |connection: &mut Connection, request: Value| {
            question_transition(connection, &json!({"requestJson":request.to_string()}))
        };
        let initial = json!({"pendingQuestion":{"requestId":"q","resolved":false},
            "activeTurn":null,"category":{"classifyState":"W"}});
        let patch = json!({"action":"patchFacts","sessionId":"s","initialState":initial,
            "activeTurn":{"turnId":"t"},"categoryPatch":{"classifyState":"P","runActive":true}});
        let first = execute(&mut connection, patch.clone()).unwrap();
        assert_eq!(first["result"]["changed"], true);
        assert_eq!(first["snapshot"]["version"], 1);
        let replay = execute(&mut connection, patch).unwrap();
        assert_eq!(replay["result"]["changed"], false);
        assert_eq!(replay["snapshot"]["version"], 1);
        execute(
            &mut connection,
            json!({"action":"resolve","sessionId":"s","at":1,"requestId":"q"}),
        )
        .unwrap();
        let update = execute(
            &mut connection,
            json!({"action":"patchFacts","sessionId":"s",
            "categoryPatch":{"classifyState":"D"}}),
        )
        .unwrap();
        assert_eq!(update["snapshot"]["version"], 3);
        let state = read(&connection, &json!({"sessionId":"s"})).unwrap();
        assert_eq!(state["pendingQuestion"]["requestId"], "q");
        assert_eq!(state["pendingQuestion"]["resolved"], true);
        assert_eq!(state["category"]["classifyState"], "D");
        execute(
            &mut connection,
            json!({"action":"record","sessionId":"s","at":2,
            "liveActiveTurn":{"_activeTurn":{"turnId":"t"},"isStreaming":true},
            "signal":{"sessionId":"s","turnId":"t","requestId":"replacement","question":"Q"}}),
        )
        .unwrap();
        let after = execute(
            &mut connection,
            json!({"action":"patchFacts","sessionId":"s",
            "categoryPatch":{"classifyState":"W"}}),
        )
        .unwrap();
        assert_eq!(after["snapshot"]["version"], 5);
        let state = read(&connection, &json!({"sessionId":"s"})).unwrap();
        assert_eq!(state["pendingQuestion"]["requestId"], "replacement");
        assert_eq!(state["pendingQuestion"]["resolved"], false);
        assert!(execute(
            &mut connection,
            json!({"action":"patchFacts","sessionId":"s",
            "expectedVersion":1,"categoryPatch":{"classifyState":"W"}})
        )
        .unwrap_err()
        .contains("version conflict"));
        assert!(execute(
            &mut connection,
            json!({"action":"patchFacts","sessionId":"s",
            "categoryPatch":{"pendingQuestion":null}})
        )
        .unwrap_err()
        .contains("unsupported session work category field"));
        assert_eq!(read(&connection, &json!({"sessionId":"s"})).unwrap(), state);
    }

    #[test]
    fn concurrent_first_questions_choose_one_owner_and_do_not_overwrite_it() {
        use std::{
            sync::{Arc, Barrier},
            thread,
            time::Duration,
        };
        let mut random = [0u8; 12];
        getrandom::fill(&mut random).unwrap();
        let file = std::env::temp_dir().join(format!(
            "multicc-question-owner-{}.sqlite",
            random
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        ));
        let connection = Connection::open(&file).unwrap();
        init(&connection);
        drop(connection);
        let barrier = Arc::new(Barrier::new(2));
        let mut workers = Vec::new();
        for question in ["first", "second"] {
            let file = file.clone();
            let barrier = barrier.clone();
            workers.push(thread::spawn(move || {
                let mut connection = Connection::open(file).unwrap();
                connection.busy_timeout(Duration::from_secs(5)).unwrap();
                let request = json!({"action":"record","sessionId":"s","at":1,
                    "initialState":{"pendingQuestion":null,"activeTurn":{"_activeTurn":{"turnId":"t"},
                        "isStreaming":true},"category":null},
                    "signal":{"sessionId":"s","turnId":"t","requestId":question,"question":"Q"}});
                barrier.wait();
                question_transition(&mut connection, &json!({"requestJson":request.to_string()})).unwrap()
            }));
        }
        let results: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        assert_eq!(
            results.iter().filter(|r| r["result"]["ok"] == true).count(),
            1
        );
        assert_eq!(
            results
                .iter()
                .filter(|r| r["result"]["code"] == "user_input_already_pending")
                .count(),
            1
        );
        let connection = Connection::open(&file).unwrap();
        let final_state = read(&connection, &json!({"sessionId":"s"})).unwrap();
        assert_eq!(final_state["version"], 1);
        let winner = final_state["pendingQuestion"]["requestId"]
            .as_str()
            .unwrap();
        assert!(winner == "first" || winner == "second");
        drop(connection);
        std::fs::remove_file(file).unwrap();
    }

    #[test]
    fn concurrent_fact_update_and_replacement_keep_both_changes() {
        use std::{
            sync::{Arc, Barrier},
            thread,
            time::Duration,
        };
        let mut random = [0u8; 12];
        getrandom::fill(&mut random).unwrap();
        let file = std::env::temp_dir().join(format!(
            "multicc-question-facts-{}.sqlite",
            random
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        ));
        let mut connection = Connection::open(&file).unwrap();
        init(&connection);
        write(&mut connection, &json!({"updates":[{"sessionId":"s","expectedVersion":0,
            "pendingQuestion":{"requestId":"old","resolved":true},
            "activeTurn":{"_activeTurn":{"turnId":"t"},"isStreaming":true},"category":{"classifyState":"W"}}]})).unwrap();
        drop(connection);
        let barrier = Arc::new(Barrier::new(2));
        let requests = [
            json!({"action":"patchFacts","sessionId":"s","categoryPatch":{"classifyState":"P"}}),
            json!({"action":"record","sessionId":"s","at":2,
                "signal":{"sessionId":"s","turnId":"t","requestId":"new","question":"Q"}}),
        ];
        let workers: Vec<_> = requests
            .into_iter()
            .map(|request| {
                let file = file.clone();
                let barrier = barrier.clone();
                thread::spawn(move || {
                    let mut connection = Connection::open(file).unwrap();
                    connection.busy_timeout(Duration::from_secs(5)).unwrap();
                    barrier.wait();
                    question_transition(
                        &mut connection,
                        &json!({"requestJson":request.to_string()}),
                    )
                    .unwrap()
                })
            })
            .collect();
        for worker in workers {
            assert_eq!(worker.join().unwrap()["result"]["ok"], true);
        }
        let connection = Connection::open(&file).unwrap();
        let state = read(&connection, &json!({"sessionId":"s"})).unwrap();
        assert_eq!(state["version"], 3);
        assert_eq!(state["pendingQuestion"]["requestId"], "new");
        assert_eq!(state["category"]["classifyState"], "P");
        drop(connection);
        std::fs::remove_file(file).unwrap();
    }

    #[test]
    fn question_move_commits_both_sessions_or_neither() {
        let mut connection = Connection::open_in_memory().unwrap();
        init(&connection);
        write(&mut connection, &json!({"updates":[
            {"sessionId":"source","expectedVersion":0,"pendingQuestion":{
                "requestId":"q","turnId":"t","taskId":"old","question":"Q",
                "options":["yes"],"createdAt":5,"resolved":false},"activeTurn":null,"category":"W"},
            {"sessionId":"target","expectedVersion":0,"pendingQuestion":null,"activeTurn":null,"category":null}
        ]})).unwrap();
        let request = |source_version: u64, target_version: u64| {
            json!({"requestJson":json!({
            "action":"move","sessionId":"source","expectedVersion":source_version,
            "targetSessionId":"target","targetExpectedVersion":target_version,
            "turnId":"t","taskId":"new","at":10
        }).to_string()})
        };
        let mismatch = json!({"requestJson":json!({"action":"move","sessionId":"source",
            "expectedVersion":1,"targetSessionId":"target","targetExpectedVersion":0,
            "turnId":"other","at":10}).to_string()});
        assert_eq!(
            question_transition(&mut connection, &mismatch).unwrap()["result"]["code"],
            "turn_mismatch"
        );
        let stale = json!({"requestJson":json!({"action":"move","sessionId":"source",
            "expectedVersion":1,"targetSessionId":"target","targetExpectedVersion":1,
            "expectedRequestId":"replaced","turnId":"t","at":10}).to_string()});
        assert_eq!(
            question_transition(&mut connection, &stale).unwrap()["result"]["code"],
            "request_id_mismatch"
        );
        assert_eq!(
            read(&connection, &json!({"sessionId":"source"})).unwrap()["version"],
            1
        );
        assert_eq!(
            read(&connection, &json!({"sessionId":"target"})).unwrap()["version"],
            1
        );
        assert!(question_transition(&mut connection, &request(1, 0))
            .unwrap_err()
            .contains("version conflict"));
        assert_eq!(
            read(&connection, &json!({"sessionId":"source"})).unwrap()["version"],
            1
        );
        connection
            .execute(
                "UPDATE orchestration_session_work_state SET version=?1 WHERE session_id='target'",
                [MAX_VERSION],
            )
            .unwrap();
        assert!(question_transition(&mut connection, &request(1, MAX_VERSION)).is_err());
        let source = read(&connection, &json!({"sessionId":"source"})).unwrap();
        assert_eq!(source["version"], 1);
        assert_eq!(source["pendingQuestion"]["resolved"], false);
        connection
            .execute(
                "UPDATE orchestration_session_work_state SET version=1 WHERE session_id='target'",
                [],
            )
            .unwrap();
        let result = question_transition(&mut connection, &request(1, 1)).unwrap();
        assert_eq!(result["result"]["ok"], true);
        let source = read(&connection, &json!({"sessionId":"source"})).unwrap();
        let target = read(&connection, &json!({"sessionId":"target"})).unwrap();
        assert_eq!(source["pendingQuestion"]["resolution"], "moved");
        assert_eq!(
            source["category"]["lastResolvedUserInput"]["requestId"],
            "q"
        );
        assert_eq!(target["pendingQuestion"]["requestId"], "q");
        assert_eq!(target["pendingQuestion"]["taskId"], "new");
        assert_eq!(target["pendingQuestion"]["movedFromSessionId"], "source");
        assert_eq!(target["category"]["userInputSignalTurnId"], "t");
        assert_eq!(target["category"]["classifyState"], "W");
        assert_eq!(
            (source["version"].as_u64(), target["version"].as_u64()),
            (Some(2), Some(2))
        );
        let notice: Value =
            serde_json::from_str(result["notificationJson"].as_str().unwrap()).unwrap();
        assert_eq!(
            notice,
            json!({"type":"user_input_resolved","requestId":"q",
            "taskId":"old","resolution":"moved"})
        );
        // The source guard runs before target lookup, like the legacy host.
        let replay = question_transition(&mut connection, &request(2, 1)).unwrap();
        assert_eq!(replay["result"]["code"], "already_resolved");
        assert_eq!(
            read(&connection, &json!({"sessionId":"target"})).unwrap(),
            target
        );
    }

    #[test]
    fn an_initialized_missing_or_incompatible_table_fails_closed() {
        let connection = Connection::open_in_memory().unwrap();
        init(&connection);
        connection
            .execute_batch("DROP TABLE orchestration_session_work_state")
            .unwrap();
        assert!(initialize(&connection)
            .unwrap_err()
            .contains("invalid or missing"));
        let count: i64 = connection
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name='orchestration_session_work_state'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            count, 0,
            "missing canonical data must not be silently recreated"
        );
        connection
            .execute_batch(
                "CREATE TABLE orchestration_session_work_state(session_id TEXT PRIMARY KEY)",
            )
            .unwrap();
        assert!(initialize(&connection)
            .unwrap_err()
            .contains("invalid or missing"));
    }

    #[test]
    fn new_session_unknown_category_and_version_conflict_are_visible() {
        let mut connection = Connection::open_in_memory().unwrap();
        init(&connection);
        let input = json!({"sessionId":"s"});
        assert_eq!(read(&connection, &input).unwrap()["version"], 0);
        let result = write(
            &mut connection,
            &json!({"updates":[update("s", 0, json!("future"))]}),
        )
        .unwrap();
        assert_eq!(result["snapshots"][0]["version"], 1);
        assert_eq!(read(&connection, &input).unwrap()["category"], "future");
        assert!(write(
            &mut connection,
            &json!({"updates":[update("s", 0, json!("P"))]})
        )
        .is_err());
        assert_eq!(read(&connection, &input).unwrap(), result["snapshots"][0]);
        let invalid = json!({"updates":[{"sessionId":"other","expectedVersion":0,
            "pendingQuestion":null,"activeTurn":null,"category":null,"unknownField":true}]});
        assert!(write(&mut connection, &invalid).is_err());
        assert_eq!(
            read(&connection, &json!({"sessionId":"other"})).unwrap()["version"],
            0
        );
    }

    #[test]
    fn a_later_conflict_rolls_back_every_session_in_the_batch() {
        let mut connection = Connection::open_in_memory().unwrap();
        init(&connection);
        write(
            &mut connection,
            &json!({"updates":[update("b", 0, json!("P"))]}),
        )
        .unwrap();
        assert!(write(
            &mut connection,
            &json!({"updates":[update("a", 0, json!("W")), update("b", 0, json!("D"))]})
        )
        .is_err());
        assert_eq!(
            read(&connection, &json!({"sessionId":"a"})).unwrap()["version"],
            0
        );
        assert_eq!(
            read(&connection, &json!({"sessionId":"b"})).unwrap()["category"],
            "P"
        );
    }

    #[test]
    fn first_access_backfills_once_without_overwriting_a_later_snapshot() {
        let mut connection = Connection::open_in_memory().unwrap();
        init(&connection);
        let seed = json!({"sessionId":"s","initial":{
            "pendingQuestion":{"requestId":"old"},"activeTurn":null,"category":"P"}});
        let first = read_or_initialize(&mut connection, &seed).unwrap();
        assert_eq!(first["version"], 1);
        assert_eq!(first["pendingQuestion"]["requestId"], "old");
        let saved = write(
            &mut connection,
            &json!({"updates":[update("s", 1, json!("W"))]}),
        )
        .unwrap();
        assert_eq!(
            read_or_initialize(&mut connection, &seed).unwrap(),
            saved["snapshots"][0]
        );
        let invalid = json!({"sessionId":"new","initial":{
            "pendingQuestion":null,"activeTurn":null,"category":null,"extra":1}});
        assert!(read_or_initialize(&mut connection, &invalid).is_err());
        assert_eq!(
            read(&connection, &json!({"sessionId":"new"})).unwrap()["version"],
            0
        );
    }

    #[test]
    fn encoded_json_preserves_js_surrogates_and_rolls_back_bad_input() {
        let mut connection = Connection::open_in_memory().unwrap();
        init(&connection);
        let raw = r#"{"\ud800":"\udc00"}"#;
        let seed = json!({"sessionId":"s","initial":{"pendingQuestionJson":raw,
            "activeTurnJson":"null","categoryJson":"\"P\""}});
        let first = encoded_initialize(&mut connection, &seed).unwrap();
        assert_eq!(first["pendingQuestionJson"], raw);
        let updates = json!({"updates":[
            {"sessionId":"s","expectedVersion":1,"pendingQuestionJson":"null","activeTurnJson":"null","categoryJson":"\"W\""},
            {"sessionId":"new","expectedVersion":0,"pendingQuestionJson":"{broken","activeTurnJson":"null","categoryJson":"null"}
        ]});
        assert!(encoded_write(&mut connection, &updates).is_err());
        assert_eq!(
            encoded_read(&connection, &json!({"sessionId":"s"})).unwrap(),
            first
        );
        assert_eq!(
            encoded_read(&connection, &json!({"sessionId":"new"})).unwrap()["version"],
            0
        );
    }

    #[test]
    fn concurrent_writers_publish_one_complete_snapshot() {
        use std::sync::{Arc, Barrier};
        use std::time::Duration;

        let mut random = [0_u8; 16];
        getrandom::fill(&mut random).unwrap();
        let name = random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let directory = std::env::temp_dir().join(format!("multicc-session-work-state-{name}"));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("state.sqlite");
        let connection = Connection::open(&path).unwrap();
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .unwrap();
        init(&connection);
        let locked_writer = Connection::open(&path).unwrap();
        locked_writer.execute_batch("BEGIN IMMEDIATE").unwrap();
        connection.busy_timeout(Duration::from_millis(100)).unwrap();
        initialize(&connection).unwrap();
        locked_writer.execute_batch("ROLLBACK").unwrap();
        drop(locked_writer);
        let barrier = Arc::new(Barrier::new(2));
        let workers: Vec<_> = ["one", "two"]
            .into_iter()
            .map(|value| {
                let path = path.clone();
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    let mut writer = Connection::open(path).unwrap();
                    writer.busy_timeout(Duration::from_secs(5)).unwrap();
                    barrier.wait();
                    let input = json!({"updates":[{"sessionId":"s","expectedVersion":0,
                    "pendingQuestion":value,"activeTurn":value,"category":value}]});
                    write(&mut writer, &input)
                })
            })
            .collect();
        let results: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        let observed = read(&connection, &json!({"sessionId":"s"})).unwrap();
        assert_eq!(observed["version"], 1);
        assert_eq!(observed["pendingQuestion"], observed["activeTurn"]);
        assert_eq!(observed["pendingQuestion"], observed["category"]);
        let barrier = Arc::new(Barrier::new(2));
        let initializers: Vec<_> = ["first", "second"]
            .into_iter()
            .map(|value| {
                let path = path.clone();
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    let mut writer = Connection::open(path).unwrap();
                    writer.busy_timeout(Duration::from_secs(5)).unwrap();
                    barrier.wait();
                    read_or_initialize(
                        &mut writer,
                        &json!({"sessionId":"new","initial":{
                        "pendingQuestion":value,"activeTurn":value,"category":value}}),
                    )
                    .unwrap()
                })
            })
            .collect();
        let initialized: Vec<_> = initializers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        assert_eq!(initialized[0], initialized[1]);
        assert_eq!(initialized[0]["version"], 1);
        assert_eq!(
            initialized[0]["pendingQuestion"],
            initialized[0]["category"]
        );
        drop(connection);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
