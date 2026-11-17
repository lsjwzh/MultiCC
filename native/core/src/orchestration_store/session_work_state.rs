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

#[derive(Deserialize)]
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
    let id = match field(&request, "sessionId") {
        JsValue::String(value) if value.is_well_formed() && !value.is_empty() => {
            value.to_string_lossy()
        }
        _ => return Err(err("question transition requires sessionId")),
    };
    let expected = match field(&request, "expectedVersion") {
        JsValue::Number(value)
            if value.is_finite()
                && value >= 0.0
                && value.fract() == 0.0
                && value <= MAX_VERSION as f64 =>
        {
            value as u64
        }
        _ => return Err(err("question transition requires expectedVersion")),
    };
    let action = field(&request, "action");
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(err)?;
    let current = snapshot_in_write_transaction(&tx, &id)?;
    if current["version"].as_u64() != Some(expected) {
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
    let active = record::parse(&encoded.active_turn_json)?;
    let mut category = match record::parse(&encoded.category_json)? {
        value @ JsValue::Object(_) => value,
        JsValue::Null => JsValue::Object(vec![]),
        value @ JsValue::String(_) => JsValue::object(vec![("classifyState", value)]),
        _ => return Err(err("invalid session work category")),
    };
    let at = match field(&request, "at") {
        JsValue::Number(value) if value.is_finite() => JsValue::Number(value),
        _ => return Err(err("question transition requires clock")),
    };
    let mut notification = JsValue::Null;
    let result;
    if action == JsValue::string("record") {
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
        result = json!({"ok":true,"duplicate":false});
    } else if action == JsValue::string("beginTurn") {
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
        result = json!({"ok":true});
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
        result = json!({"ok":true,"duplicate":false});
    } else {
        return Err(err("unknown question transition"));
    }
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
