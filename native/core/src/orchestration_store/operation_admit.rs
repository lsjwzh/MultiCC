//! Atomic admission of detached and dispatch operations.
use super::{err, header, meta, query, record, set_meta, write_record_json, Result, Store};
use crate::js::{js_to_string, to_serde, truthy, JsString, JsValue};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

fn wall_millis(planning: bool) -> f64 {
    if planning {
        return 0.0;
    }
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(value) => value.as_millis() as f64,
        Err(error) => -(error.duration().as_millis() as f64),
    }
}

fn canonical(value: &JsValue) -> Result<String> {
    match value {
        JsValue::Object(entries) => {
            let mut sorted: Vec<_> = entries.iter().collect();
            sorted.sort_by(|a, b| a.0.as_units().cmp(b.0.as_units()));
            let mut parts = Vec::with_capacity(sorted.len());
            for (key, value) in sorted {
                parts.push(format!(
                    "{}:{}",
                    record::encode(&JsValue::String(key.clone()))?,
                    canonical(value)?
                ));
            }
            Ok(format!("{{{}}}", parts.join(",")))
        }
        JsValue::Array(entries) => {
            let parts = entries.iter().map(canonical).collect::<Result<Vec<_>>>()?;
            Ok(format!("[{}]", parts.join(",")))
        }
        _ => record::encode(value),
    }
}
fn digest(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}
fn put(fields: &mut Vec<(JsString, JsValue)>, name: &str, value: JsValue) {
    if let Some((_, old)) = fields.iter_mut().find(|(key, _)| key == name) {
        *old = value;
    } else {
        fields.push((name.into(), value));
    }
}
fn field(value: &JsValue, name: &str) -> JsValue {
    value.get(name).cloned().unwrap_or(JsValue::Undefined)
}
fn or_null(value: JsValue) -> JsValue {
    if truthy(&value) {
        value
    } else {
        JsValue::Null
    }
}
fn json_field(value: &Value, name: &str) -> Result<String> {
    value[name]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| err(format!("{name} required")))
}
fn read(connection: &Connection, collection: &str, id: &str) -> Result<Option<JsValue>> {
    record::get_json(connection, collection, id, &[])?
        .map(|raw| record::parse(&raw))
        .transpose()
}
fn public(mut operation: JsValue, idempotent: bool) -> Result<Value> {
    let JsValue::Object(fields) = &mut operation else {
        return Ok(json!({"legacy":true}));
    };
    fields.retain(|(name, _)| {
        !["idempotencyKeyHash", "requestHash", "resultHash"]
            .iter()
            .any(|s| name == s)
    });
    put(fields, "idempotent", JsValue::Bool(idempotent));
    Ok(json!({"resultJson":record::encode(&operation)?}))
}
fn result_error(kind: &str, message: String, id: &JsValue) -> Result<Value> {
    Ok(json!({"errorKind":kind,"message":message,"idJson":record::encode(id)?}))
}

pub(super) fn plan(store: &mut Store, input: &Value) -> Result<Value> {
    if !store.active {
        return Err(err(
            "operation admission plan requires an active read transaction",
        ));
    }
    execute(store, input, true)
}

pub(super) fn commit(store: &mut Store, input: &Value) -> Result<Value> {
    execute(store, input, false)
}

fn execute(store: &mut Store, input: &Value, planning: bool) -> Result<Value> {
    let id = json_field(input, "id")?;
    let id_value = record::parse(&json_field(input, "idValueJson")?)?;
    let kind = json_field(input, "kind")?;
    let owner = if input["ownerSymbol"] == true {
        JsValue::Undefined
    } else {
        record::parse(&json_field(input, "ownerValueJson")?)?
    };
    let result_session = if input["resultSymbol"] == true {
        JsValue::Undefined
    } else {
        record::parse(&json_field(input, "resultValueJson")?)?
    };
    let spec = record::parse(&json_field(input, "specJson")?)?;
    let canonical_spec = canonical(&spec)?;
    let request_hash = digest(&canonical_spec);
    let spec = record::parse(&canonical_spec)?;
    let idempotency_hash = input["idempotencyKey"]
        .as_str()
        .filter(|v| !v.is_empty())
        .map(digest);
    if !planning {
        store.end()?;
        store
            .conn()?
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(err)?;
        store.pending = true;
    }
    let actual = meta(store.conn()?, "revision")?;
    if !planning && actual.as_f64() != input["expectedRevision"].as_f64() {
        store.end()?;
        store.add("conflicts_total", 1.0);
        return Err(format!(
            "ORCHESTRATION_SQLITE_CONFLICT:{}:{}",
            input["expectedRevision"], actual
        ));
    }
    let mut existing_key = None;
    if let Some(hash) = idempotency_hash
        .as_ref()
        .filter(|_| input["ownerSymbol"] != true)
    {
        let owner_type = match &owner {
            JsValue::String(_) => "text",
            JsValue::Number(_) => "number",
            JsValue::Bool(true) => "true",
            JsValue::Bool(false) => "false",
            _ => {
                store.end()?;
                return Ok(json!({"legacy":true}));
            }
        };
        existing_key = store.conn()?.query_row(
            "SELECT id FROM orchestration_operations WHERE kind=?1 AND owner_session_id=?2 AND json_extract(data_json,'$.idempotencyKeyHash')=?3 AND (json_type(data_json,'$.ownerSessionId')=?4 OR (?4='number' AND json_type(data_json,'$.ownerSessionId') IN ('integer','real'))) ORDER BY id LIMIT 1",
            params![kind, query::sql_value(&to_serde(&owner)), hash, owner_type], |row| row.get::<_, String>(0),
        ).optional().map_err(err)?;
    }
    let idempotent = existing_key.is_some();
    let operation_key = existing_key.clone().unwrap_or_else(|| id.clone());
    let mut operation = if let Some(key) = existing_key {
        let value =
            read(store.conn()?, "operations", &key)?.ok_or_else(|| err("missing operation"))?;
        if field(&value, "requestHash") != JsValue::string(&request_hash) {
            store.end()?;
            let existing_id = field(&value, "id");
            if matches!(existing_id, JsValue::Undefined) {
                return Ok(json!({"legacy":true}));
            }
            return result_error(
                "operation",
                format!("{kind} idempotency key was already used with different content"),
                &existing_id,
            );
        }
        value
    } else {
        // In the legacy dispatch path the newly admitted symbol reaches a
        // template literal before persistence, which throws rather than
        // coercing through String(symbol).
        if input["idSymbol"] == true {
            store.end()?;
            return Ok(
                json!({"errorKind":"type","message":"Cannot convert a Symbol value to a string"}),
            );
        }
        let current = read(store.conn()?, "operations", &id)?;
        if current.as_ref().is_some_and(truthy) {
            store.end()?;
            return result_error(
                "operation",
                format!("operation {id} already exists"),
                &id_value,
            );
        }
        if current.is_none() && input["prototypeKey"] == true {
            if input["prototypeKnown"] != true {
                return Ok(json!({"needsPrototype":true}));
            }
            if input["prototypeTruthy"] == true {
                store.end()?;
                return result_error(
                    "operation",
                    format!("operation {id} already exists"),
                    &id_value,
                );
            }
        }
        let external = if kind == "detached" {
            let base = id.strip_prefix("op_").unwrap_or(&id);
            let clean: String = base
                .chars()
                .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
                .take(48)
                .collect();
            JsValue::string(&format!("d_{clean}"))
        } else {
            JsValue::Null
        };
        let now = wall_millis(planning);
        JsValue::object(vec![
            ("id", id_value),
            ("kind", kind.clone().into()),
            ("ownerSessionId", owner.clone()),
            ("resultSessionId", result_session),
            ("status", "admitted".into()),
            (
                "idempotencyKeyHash",
                idempotency_hash
                    .clone()
                    .map_or(JsValue::Null, JsValue::from),
            ),
            ("requestHash", request_hash.into()),
            ("resultHash", JsValue::Null),
            ("spec", spec),
            ("externalId", external),
            ("requestOutboxId", JsValue::Null),
            ("resultOutboxId", JsValue::Null),
            ("createdAt", JsValue::Number(now)),
            ("updatedAt", JsValue::Number(now)),
            ("startedAt", JsValue::Null),
            ("completedAt", JsValue::Null),
            ("cancelledAt", JsValue::Null),
            ("lastError", JsValue::Null),
        ])
    };
    let op_id_value = field(&operation, "id");
    let op_id = match &op_id_value {
        JsValue::String(_) | JsValue::Number(_) | JsValue::Bool(_) | JsValue::Null => {
            let text = js_to_string(&op_id_value);
            if !text.is_well_formed() {
                store.end()?;
                return Ok(json!({"legacy":true}));
            }
            text.to_string_lossy()
        }
        _ => {
            store.end()?;
            return Ok(json!({"legacy":true}));
        }
    };
    let mut outbox_write = None;
    let mut next_sequence = None;
    if kind == "dispatch" && !truthy(&field(&operation, "requestOutboxId")) {
        let current_spec = field(&operation, "spec");
        let session = field(&current_spec, "chatId");
        if !matches!(&session, JsValue::String(s) if !s.is_empty()) {
            store.end()?;
            return Ok(json!({"errorKind":"type","message":"outbox item requires sessionId"}));
        }
        if matches!(field(&current_spec, "targetId"), JsValue::Undefined)
            || matches!(field(&current_spec, "message"), JsValue::Undefined)
        {
            store.end()?;
            return Ok(
                json!({"errorKind":"type","message":"outbox payload contains unsupported undefined"}),
            );
        }
        let mut payload = vec![
            ("type", JsValue::string("dispatch.request")),
            ("operationId", op_id_value.clone()),
            ("targetId", field(&current_spec, "targetId")),
            ("message", field(&current_spec, "message")),
            ("taskId", or_null(field(&current_spec, "taskId"))),
            (
                "taskStart",
                JsValue::Bool(field(&current_spec, "taskStart") == JsValue::Bool(true)),
            ),
            ("taskSource", or_null(field(&current_spec, "taskSource"))),
            ("taskText", or_null(field(&current_spec, "taskText"))),
        ];
        if truthy(&field(&current_spec, "taskShellReceiptId")) {
            for name in ["taskShellReceiptId", "clientMsgId", "receivedAt"] {
                let value = field(&current_spec, name);
                if matches!(value, JsValue::Undefined) {
                    store.end()?;
                    return Ok(
                        json!({"errorKind":"type","message":"outbox payload contains unsupported undefined"}),
                    );
                }
                payload.push((name, value));
            }
        }
        let outbox_now = wall_millis(planning);
        let payload = JsValue::object(payload);
        let payload_canonical = canonical(&payload)?;
        let payload_hash = digest(&payload_canonical);
        let payload = record::parse(&payload_canonical)?;
        let outbox_id = format!("operation:{op_id}:request");
        let outbox =
            if let Some(existing) = read(store.conn()?, "outbox", &outbox_id)?.filter(truthy) {
                if field(&existing, "sessionId") != session
                    || field(&existing, "payloadHash") != JsValue::string(&payload_hash)
                {
                    store.end()?;
                    return result_error(
                        "outbox",
                        format!("outbox item {outbox_id} already exists with different content"),
                        &JsValue::string(&outbox_id),
                    );
                }
                existing
            } else {
                let seq = meta(store.conn()?, "nextOutboxSequence")?
                    .as_u64()
                    .ok_or_else(|| err("invalid sequence"))?;
                if seq >= 9_007_199_254_740_991 {
                    store.end()?;
                    return Ok(json!({"legacy":true}));
                }
                let source = JsValue::object(vec![
                    ("kind", "dispatch".into()),
                    ("operationId", op_id_value.clone()),
                    ("type", "operation".into()),
                ]);
                let item = JsValue::object(vec![
                    ("id", outbox_id.clone().into()),
                    ("sessionId", session),
                    ("sequence", JsValue::Number(seq as f64)),
                    ("state", "pending".into()),
                    ("payload", payload),
                    ("payloadHash", payload_hash.into()),
                    ("source", source),
                    ("attempts", JsValue::Number(0.0)),
                    ("availableAt", JsValue::Number(outbox_now)),
                    ("createdAt", JsValue::Number(outbox_now)),
                    ("updatedAt", JsValue::Number(outbox_now)),
                    ("leasedAt", JsValue::Null),
                    ("leasedUntil", JsValue::Null),
                    ("leaseOwner", JsValue::Null),
                    ("leaseTokenHash", JsValue::Null),
                    ("deliveredAt", JsValue::Null),
                    ("deadLetterAt", JsValue::Null),
                    ("lastError", JsValue::Null),
                ]);
                next_sequence = Some(seq + 1);
                outbox_write = Some((outbox_id, record::encode(&item)?));
                item
            };
        let JsValue::Object(fields) = &mut operation else {
            store.end()?;
            return Ok(json!({"legacy":true}));
        };
        put(fields, "requestOutboxId", field(&outbox, "id"));
        put(fields, "updatedAt", JsValue::Number(wall_millis(planning)));
    } else if idempotent {
        let mut result = public(operation, true)?;
        result["unchanged"] = Value::Bool(true);
        store.end()?;
        store.add("noops_total", 1.0);
        return Ok(result);
    }
    if planning {
        return Ok(json!({"pending":true}));
    }
    let result = public(operation.clone(), idempotent)?;
    store.commit_started = Some(Instant::now());
    store.redacted = false;
    let mut bytes = 0;
    if let Some(next) = next_sequence {
        set_meta(store.conn()?, "nextOutboxSequence", &json!(next))?;
    }
    if let Some((outbox_id, raw)) = outbox_write.as_ref() {
        bytes += write_record_json(store.conn()?, "outbox", outbox_id, raw)?;
    }
    bytes += write_record_json(
        store.conn()?,
        "operations",
        &operation_key,
        &record::encode(&operation)?,
    )?;
    set_meta(
        store.conn()?,
        "revision",
        &json!(actual.as_u64().ok_or_else(|| err("invalid revision"))? + 1),
    )?;
    set_meta(store.conn()?, "updatedAt", &json!(wall_millis(false)))?;
    header(store.conn()?)?;
    store.pending_rows = if outbox_write.is_some() { 2 } else { 1 };
    store.pending_bytes = bytes;
    store.request("commit", &Value::Null)?;
    Ok(result)
}
