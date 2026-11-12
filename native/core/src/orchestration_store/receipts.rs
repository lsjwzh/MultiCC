//! Small terminal receipts in the indexed tables; a single complete original
//! lives in the body table and is fetched only when the requested fields need it.
use super::{corrupt, err, meta, record, set_meta, table, write_record_json, Result};
use crate::js::JsValue;
use rusqlite::{params, Connection};
use serde_json::{json, Value};

pub(super) const COLLECTIONS: [&str; 4] = ["tasks", "outbox", "operations", "waits"];
const PROGRESS_KEY: &str = "receiptCompaction";

// Retention/recovery edges must be available without touching body pages.
// Only these complete leaf values are copied; parents such as payload/spec are
// deliberately not copied because they can contain arbitrarily large text.
const FIELDS: &[&str] = &[
    "id",
    "taskId",
    "parentSessionId",
    "sessionId",
    "ownerSessionId",
    "kind",
    "type",
    "status",
    "state",
    "sequence",
    "availableAt",
    "leasedUntil",
    "createdAt",
    "updatedAt",
    "completedAt",
    "deliveredAt",
    "cancelledAt",
    "failedAt",
    "startedAt",
    "submittedAt",
    "interruptedAt",
    "expiresAt",
    "payloadHash",
    "requestHash",
    "resultHash",
    "idempotencyKeyHash",
    "callbackTokenHash",
    "resolutionPayloadHash",
    "leaseTokenHash",
    "resultSessionId",
    "resultSettles",
    "externalId",
    "toolUseId",
    "outputFile",
    "requestOutboxId",
    "resultOutboxId",
    "outboxId",
    "attempts",
    "maxAttempts",
    "revision",
    "deliveryId",
    "source.operationId",
    "source.taskId",
    "source.waitId",
    "source.sessionId",
    "payload.operationId",
    "payload.taskId",
    "payload.options.taskId",
    "payload.activeEntryId",
    "turnLineage.taskId",
    "turnLineage.activeEntryId",
    "spec.chatId",
    "spec.targetId",
    "spec.taskId",
    "spec.options.taskId",
    "spec.resultMode",
    "spec.oneWay",
    "spec.targetLabel",
    "spec.replyTo",
    "spec.gateway",
    "result.source",
    "result.taskId",
    "metadata.taskId",
    "metadata.originDispatchId",
    "metadata.nextAt",
    "metadata.dueAt",
    "metadata.expireAt",
];

pub(super) fn is_split_collection(collection: &str) -> bool {
    COLLECTIONS.contains(&collection)
}

fn terminal(collection: &str, value: &JsValue) -> bool {
    let (field, states): (&str, &[&str]) = match collection {
        "tasks" | "operations" => (
            "status",
            &["completed", "failed", "interrupted", "cancelled"],
        ),
        "outbox" => ("state", &["delivered", "cancelled"]),
        "waits" => ("status", &["resolved", "cancelled"]),
        _ => return false,
    };
    states
        .iter()
        .any(|state| value.get(field) == Some(&JsValue::string(state)))
}

fn get<'a>(value: &'a JsValue, field: &str) -> Option<&'a JsValue> {
    field.split('.').try_fold(value, |v, key| v.get(key))
}

fn put(value: &mut JsValue, field: &str, item: JsValue) {
    let (key, rest) = field
        .split_once('.')
        .map_or((field, None), |(k, r)| (k, Some(r)));
    if !matches!(value, JsValue::Object(_)) {
        *value = JsValue::Object(Vec::new());
    }
    let JsValue::Object(entries) = value else {
        unreachable!()
    };
    let index = entries
        .iter()
        .position(|(k, _)| k == key)
        .unwrap_or_else(|| {
            entries.push((key.into(), JsValue::Null));
            entries.len() - 1
        });
    if let Some(rest) = rest {
        put(&mut entries[index].1, rest, item);
    } else {
        entries[index].1 = item;
    }
}

pub(super) fn receipt(collection: &str, value: &JsValue) -> Result<Option<String>> {
    if !terminal(collection, value) {
        return Ok(None);
    }
    let mut out = JsValue::Object(Vec::new());
    for field in FIELDS {
        if let Some(item) = get(value, field) {
            put(&mut out, field, item.clone());
        }
    }
    record::encode(&out).map(Some)
}

fn hot_field(field: &str) -> bool {
    FIELDS
        .iter()
        .any(|kept| field == *kept || field.strip_prefix(kept).is_some_and(|s| s.starts_with('.')))
}

/// SQL identifiers and collection names originate only in `table`, never input.
pub(super) fn json_source(collection: &str, field: Option<&str>) -> Result<String> {
    let (table, key) = table(collection)?;
    if !is_split_collection(collection) || field.is_some_and(hot_field) {
        return Ok(format!("{table}.data_json"));
    }
    // json() deliberately raises if the marked original is missing. Falling
    // back to the receipt would silently turn corruption into lost API fields.
    Ok(format!("CASE WHEN {table}.body_ref=0 THEN {table}.data_json WHEN {table}.body_ref=1 THEN COALESCE((SELECT body.data_json FROM orchestration_record_bodies AS body WHERE body.collection='{collection}' AND body.record_key={table}.{key}),json('missing terminal record body')) ELSE json('invalid terminal body reference') END"))
}

pub(super) fn path_source(collection: &str, parts: &[JsValue]) -> Result<String> {
    let fields: Option<Vec<String>> = parts
        .iter()
        .map(|part| match part {
            JsValue::String(key) if key.is_well_formed() && !key.as_units().contains(&46) => {
                Some(key.to_string_lossy())
            }
            _ => None,
        })
        .collect();
    let field = fields.filter(|v| !v.is_empty()).map(|v| v.join("."));
    json_source(collection, field.as_deref())
}

pub(super) fn install(connection: &Connection) -> Result<()> {
    connection.execute_batch("CREATE TABLE orchestration_record_bodies(collection TEXT NOT NULL,record_key TEXT NOT NULL,data_json TEXT NOT NULL,PRIMARY KEY(collection,record_key)) WITHOUT ROWID;").map_err(err)?;
    for collection in COLLECTIONS {
        // A constant-default column is a metadata-only SQLite alteration. A
        // CHECK constraint here would scan old rows during startup migration.
        connection.execute_batch(&format!("ALTER TABLE orchestration_{collection} ADD COLUMN body_ref INTEGER NOT NULL DEFAULT 0")).map_err(err)?;
        for suffix in ["delete", "update"] {
            connection
                .execute_batch(&trigger_sql(collection, suffix))
                .map_err(err)?;
        }
    }
    set_meta(
        connection,
        PROGRESS_KEY,
        &json!({"collection":0,"after":null,"complete":false}),
    )?;
    Ok(())
}

fn trigger_sql(collection: &str, suffix: &str) -> String {
    let event = if suffix == "delete" {
        "DELETE"
    } else {
        "UPDATE OF data_json"
    };
    let reset = if suffix == "update" {
        format!(" UPDATE orchestration_{collection} SET body_ref=0 WHERE id=NEW.id;")
    } else {
        String::new()
    };
    format!("CREATE TRIGGER orchestration_{collection}_body_{suffix} AFTER {event} ON orchestration_{collection} BEGIN DELETE FROM orchestration_record_bodies WHERE collection='{collection}' AND record_key=OLD.id;{reset} END")
}

fn normalized_sql(sql: &str) -> String {
    sql.trim_end_matches(';')
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase()
}

pub(super) fn validate(connection: &Connection) -> Result<()> {
    let mut statement = connection
        .prepare("PRAGMA table_info(orchestration_record_bodies)")
        .map_err(corrupt)?;
    let columns = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, bool>(3)?,
                row.get::<_, u32>(5)?,
            ))
        })
        .map_err(corrupt)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(corrupt)?;
    if columns
        != vec![
            ("collection".into(), "TEXT".into(), true, 1),
            ("record_key".into(), "TEXT".into(), true, 2),
            ("data_json".into(), "TEXT".into(), true, 0),
        ]
    {
        return Err(corrupt("terminal body table is missing or invalid"));
    }
    for collection in COLLECTIONS {
        let marker: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name='body_ref' AND type='INTEGER' AND \"notnull\"=1 AND dflt_value='0')",[format!("orchestration_{collection}")],|row|row.get(0)).map_err(corrupt)?;
        if !marker {
            return Err(corrupt(
                "terminal body reference column is missing or invalid",
            ));
        }
        for suffix in ["delete", "update"] {
            let definition: String = connection.query_row("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?1 AND tbl_name=?2",params![format!("orchestration_{collection}_body_{suffix}"),format!("orchestration_{collection}")],|row|row.get(0)).map_err(corrupt)?;
            if normalized_sql(&definition) != normalized_sql(&trigger_sql(collection, suffix)) {
                return Err(corrupt("terminal body cleanup trigger is invalid"));
            }
        }
    }
    progress(connection)?;
    Ok(())
}

pub(super) fn upgrade(connection: &Connection) -> Result<bool> {
    if meta(connection, "databaseSchemaVersion")? == 2 {
        return Ok(false);
    }
    connection.execute_batch("BEGIN IMMEDIATE").map_err(err)?;
    let result = (|| {
        match meta(connection, "databaseSchemaVersion")?.as_u64() {
            Some(1) => {
                install(connection)?;
                set_meta(connection, "databaseSchemaVersion", &json!(2))?;
            }
            Some(2) => (),
            _ => return Err(corrupt("unsupported orchestration SQLite schema")),
        }
        connection.execute_batch("COMMIT").map_err(err)?;
        Ok(true)
    })();
    if result.is_err() {
        let _ = connection.execute_batch("ROLLBACK");
    }
    result
}

pub(super) fn store_body(
    connection: &Connection,
    collection: &str,
    key: &str,
    body: Option<&str>,
) -> Result<()> {
    if let Some(body) = body {
        connection.execute("INSERT INTO orchestration_record_bodies(collection,record_key,data_json) VALUES(?1,?2,?3) ON CONFLICT(collection,record_key) DO UPDATE SET data_json=excluded.data_json", params![collection,key,body]).map_err(err)?;
        let (table, column) = table(collection)?;
        connection
            .execute(
                &format!("UPDATE {table} SET body_ref=1 WHERE {column}=?1"),
                [key],
            )
            .map_err(err)?;
    }
    Ok(())
}

fn progress(connection: &Connection) -> Result<Value> {
    let progress = meta(connection, PROGRESS_KEY)?;
    if !progress["collection"]
        .as_u64()
        .is_some_and(|i| i <= COLLECTIONS.len() as u64)
        || !progress["complete"].is_boolean()
        || !(progress["after"].is_null() || progress["after"].is_string())
    {
        return Err(corrupt("terminal compaction progress is invalid"));
    }
    Ok(progress)
}

pub(super) fn finish_import(connection: &Connection) -> Result<()> {
    set_meta(
        connection,
        PROGRESS_KEY,
        &json!({"collection":COLLECTIONS.len(),"after":null,"complete":true}),
    )
}

/// Only bounded primary-key pages are scanned. New writes are already split,
/// and the durable cursor means restarts never begin a full-history scan again.
pub(super) fn compact(connection: &Connection, limit: usize) -> Result<Value> {
    if !(1..=10_000).contains(&limit) {
        return Err(err("compact limit must be between 1 and 10000"));
    }
    connection.execute_batch("BEGIN IMMEDIATE").map_err(err)?;
    let result = (|| {
        let mut state = progress(connection)?;
        let mut scanned = 0;
        let mut compacted = 0;
        while state["complete"] != true && scanned < limit {
            let index = state["collection"].as_u64().unwrap() as usize;
            if index == COLLECTIONS.len() {
                state["complete"] = json!(true);
                break;
            }
            let collection = COLLECTIONS[index];
            let (table, key) = table(collection)?;
            let after = state["after"].as_str();
            let remaining = limit - scanned;
            let state_filter = match collection {
                "tasks" | "operations" => {
                    "status IN ('completed','failed','interrupted','cancelled')"
                }
                "outbox" => "state IN ('delivered','cancelled')",
                _ => "status IN ('resolved','cancelled')",
            };
            let cursor = if after.is_some() {
                format!("WHERE {key}>?2")
            } else {
                String::new()
            };
            let mut statement = connection.prepare(&format!("SELECT {key},COALESCE({state_filter},0),body_ref FROM {table} {cursor} ORDER BY {key} LIMIT ?1")).map_err(err)?;
            let arguments: Vec<rusqlite::types::Value> =
                std::iter::once(rusqlite::types::Value::Integer(remaining as i64))
                    .chain(after.map(|key| rusqlite::types::Value::Text(key.into())))
                    .collect();
            let keys = statement
                .query_map(rusqlite::params_from_iter(arguments), |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, bool>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                })
                .map_err(err)?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(err)?;
            drop(statement);
            for (key, is_terminal, body_ref) in &keys {
                // This is deliberately one body at a time, never a page of bodies.
                let already: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_record_bodies WHERE collection=?1 AND record_key=?2)",params![collection,key],|row|row.get(0)).map_err(err)?;
                if !matches!(body_ref, 0 | 1) || already != (*body_ref == 1) {
                    return Err(corrupt(
                        "terminal body reference does not match its original",
                    ));
                }
                if *is_terminal && !already {
                    let raw: String = connection
                        .query_row(
                            &format!("SELECT data_json FROM {table} WHERE id=?1"),
                            [key],
                            |row| row.get(0),
                        )
                        .map_err(err)?;
                    if terminal(collection, &record::parse(&raw)?) {
                        write_record_json(connection, collection, key, &raw)?;
                        compacted += 1;
                    }
                }
                scanned += 1;
                state["after"] = json!(key);
            }
            if keys.len() < remaining {
                state["collection"] = json!(index + 1);
                state["after"] = Value::Null;
                state["complete"] = json!(index + 1 == COLLECTIONS.len());
            }
        }
        set_meta(connection, PROGRESS_KEY, &state)?;
        let revision = meta(connection, "revision")?;
        connection.execute_batch("COMMIT").map_err(err)?;
        Ok(
            json!({"compactedRecords":compacted,"scannedRecords":scanned,"complete":state["complete"],"revision":revision}),
        )
    })();
    if result.is_err() {
        let _ = connection.execute_batch("ROLLBACK");
    }
    result
}

#[cfg(test)]
mod tests;
