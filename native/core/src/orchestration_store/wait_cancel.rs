//! Atomic cancellation of a single durable wait.
use super::{err, header, meta, record, set_meta, write_record_json, Result, Store};
use crate::js::{truthy, JsValue};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::time::Instant;

fn id(input: &Value) -> Result<&str> {
    input["id"].as_str().ok_or_else(|| err("wait id required"))
}

fn load(connection: &Connection, id: &str) -> Result<Option<JsValue>> {
    record::get_json(connection, "waits", id, &[])?
        .map(|raw| record::parse(&raw))
        .transpose()
}

pub(super) fn check(connection: &Connection, input: &Value) -> Result<Value> {
    if input["symbolKey"] == true {
        return Ok(json!({"result": {"ok":false,"code":"not_found"}}));
    }
    let wait = load(connection, id(input)?)?;
    let Some(wait) = wait.filter(truthy) else {
        return Ok(json!({"result": {"ok":false,"code":"not_found"}}));
    };
    match wait.get("status") {
        Some(JsValue::String(s)) if s == "pending" => Ok(json!({"pending":true})),
        Some(JsValue::String(s)) if s == "cancelled" => {
            Ok(json!({"result":{"ok":true,"idempotent":true}}))
        }
        status => Ok(json!({"result":{"ok":false,"code":"not_pending"},
            "statusJson":status.map(record::encode).transpose()?})),
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
    let Some(JsValue::Object(mut wait)) = load(store.conn()?, id)? else {
        return Err(err("wait changed during cancellation"));
    };
    if !wait
        .iter()
        .any(|(k, v)| k == "status" && *v == JsValue::string("pending"))
    {
        return Err(err("wait changed during cancellation"));
    }
    for (name, value) in [
        ("status", JsValue::string("cancelled")),
        ("cancelledAt", crate::js::from_serde(&input["at"])),
        ("updatedAt", crate::js::from_serde(&input["at"])),
    ] {
        if let Some((_, old)) = wait.iter_mut().find(|(key, _)| key == name) {
            *old = value;
        } else {
            wait.push((name.into(), value));
        }
    }
    let raw = record::encode(&JsValue::Object(wait))?;
    store.commit_started = Some(Instant::now());
    store.redacted = false;
    store.pending_rows = 1;
    store.pending_bytes = write_record_json(store.conn()?, "waits", id, &raw)?;
    set_meta(
        store.conn()?,
        "revision",
        &json!(actual.as_u64().ok_or_else(|| err("invalid revision"))? + 1),
    )?;
    set_meta(store.conn()?, "updatedAt", &input["updatedAt"])?;
    header(store.conn()?)?;
    store.request("commit", &Value::Null)?;
    Ok(json!({"ok":true,"idempotent":false}))
}
