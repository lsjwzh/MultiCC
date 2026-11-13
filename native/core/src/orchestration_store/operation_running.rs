//! Transactional transition of one operation into the running state.
use super::{err, header, meta, record, set_meta, write_record_json, Result, Store};
use crate::js::{from_serde, truthy, JsValue};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::time::Instant;

fn id(input: &Value) -> Result<&str> {
    input["id"]
        .as_str()
        .ok_or_else(|| err("operation id required"))
}
fn load(connection: &Connection, id: &str) -> Result<Option<JsValue>> {
    record::get_json(connection, "operations", id, &[])?
        .map(|raw| record::parse(&raw))
        .transpose()
}
fn terminal(value: Option<&JsValue>) -> bool {
    matches!(value, Some(value) if ["completed", "failed", "interrupted", "cancelled"].iter().any(|s| value == &JsValue::string(s)))
}
fn projection(operation: &JsValue, idempotent: bool) -> Result<Value> {
    let mut public = operation.clone();
    if let JsValue::Object(fields) = &mut public {
        fields.retain(|(key, _)| {
            !["idempotencyKeyHash", "requestHash", "resultHash"]
                .iter()
                .any(|name| key == name)
        });
    }
    let result = JsValue::object(vec![
        ("ok", true.into()),
        ("idempotent", idempotent.into()),
        ("operation", public),
    ]);
    Ok(json!({"resultJson":record::encode(&result)?}))
}
fn external(input: &Value) -> Result<Option<JsValue>> {
    input["externalJson"]
        .as_str()
        .map(record::parse)
        .transpose()
}
fn next_pid(operation: &JsValue, input: &Value) -> Option<JsValue> {
    if input["pidFinite"] == true {
        Some(from_serde(&input["pid"]))
    } else {
        operation.get("pid").cloned()
    }
}
fn needs_change(operation: &JsValue, input: &Value) -> Result<bool> {
    if operation.get("status") != Some(&JsValue::string("running")) {
        return Ok(true);
    }
    let ext = external(input)?;
    if ext
        .as_ref()
        .is_some_and(|ext| operation.get("externalId") != Some(ext))
    {
        return Ok(true);
    }
    Ok(operation.get("pid").cloned() != next_pid(operation, input))
}
pub(super) fn plan(connection: &Connection, input: &Value) -> Result<Value> {
    if input["symbolKey"] == true {
        return Ok(json!({"resultJson":"{\"ok\":false,\"code\":\"not_found\"}"}));
    }
    let Some(operation) = load(connection, id(input)?)?.filter(truthy) else {
        return Ok(json!({"resultJson":"{\"ok\":false,\"code\":\"not_found\"}"}));
    };
    if terminal(operation.get("status")) || !needs_change(&operation, input)? {
        return projection(&operation, true);
    }
    Ok(json!({"pending":true}))
}
fn put(fields: &mut Vec<(crate::js::JsString, JsValue)>, name: &str, value: JsValue) {
    if let Some((_, old)) = fields.iter_mut().find(|(key, _)| key == name) {
        *old = value;
    } else {
        fields.push((name.into(), value));
    }
}
pub(super) fn commit(store: &mut Store, input: &Value) -> Result<Value> {
    let id = id(input)?;
    store.end()?;
    store
        .conn()?
        .execute_batch("BEGIN IMMEDIATE")
        .map_err(err)?;
    store.pending = true;
    let actual = meta(store.conn()?, "revision")?;
    if actual.as_f64() != input["expectedRevision"].as_f64() {
        store.end()?;
        store.add("conflicts_total", 1.0);
        return Err(format!(
            "ORCHESTRATION_SQLITE_CONFLICT:{}:{}",
            input["expectedRevision"], actual
        ));
    }
    let mut operation =
        load(store.conn()?, id)?.ok_or_else(|| err("operation changed during transition"))?;
    let pid = next_pid(&operation, input);
    let started = operation
        .get("startedAt")
        .filter(|v| truthy(v))
        .cloned()
        .unwrap_or_else(|| from_serde(&input["at"]));
    let JsValue::Object(fields) = &mut operation else {
        return Err(err("invalid operation"));
    };
    put(fields, "status", JsValue::string("running"));
    put(fields, "startedAt", started);
    put(fields, "updatedAt", from_serde(&input["at"]));
    if let Some(ext) = external(input)? {
        put(fields, "externalId", ext);
    }
    if let Some(pid) = pid.filter(|value| !value.is_nullish()) {
        put(fields, "pid", pid);
    }
    let raw = record::encode(&operation)?;
    let result = projection(&operation, false)?;
    store.commit_started = Some(Instant::now());
    store.redacted = false;
    store.pending_rows = 1;
    store.pending_bytes = write_record_json(store.conn()?, "operations", id, &raw)?;
    set_meta(
        store.conn()?,
        "revision",
        &json!(actual.as_u64().ok_or_else(|| err("invalid revision"))? + 1),
    )?;
    set_meta(store.conn()?, "updatedAt", &input["updatedAt"])?;
    header(store.conn()?)?;
    store.request("commit", &Value::Null)?;
    Ok(result)
}
