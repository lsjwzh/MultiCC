//! Transactional dismissal of a completed user-input wait.
use super::{err, header, meta, record, set_meta, write_record_json, Result, Store};
use crate::js::{from_serde, truthy, JsValue};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::time::Instant;

fn load(connection: &Connection, id: &str) -> Result<Option<JsValue>> {
    record::get_json(connection, "sessionSchedules", id, &[])?
        .map(|raw| record::parse(&raw))
        .transpose()
}
fn id(input: &Value) -> Result<&str> {
    input["id"]
        .as_str()
        .ok_or_else(|| err("schedule id required"))
}
fn put(fields: &mut Vec<(crate::js::JsString, JsValue)>, key: &str, value: JsValue) {
    if let Some((_, old)) = fields.iter_mut().find(|(name, _)| name == key) {
        *old = value;
    } else {
        fields.push((key.into(), value));
    }
}
fn plan_value(schedule: Option<JsValue>, request: &JsValue) -> Value {
    let Some(schedule) = schedule.filter(truthy) else {
        return json!({"result":{"ok":true}});
    };
    if !matches!(schedule, JsValue::Object(_)) {
        return json!({"legacy":true});
    }
    if schedule.get("active").is_some_and(truthy) {
        return json!({"result":{"ok":false,"code":"stale_classification"}});
    }
    if let Some(awaiting) = schedule
        .get("awaitingRequestId")
        .filter(|value| truthy(value))
    {
        if matches!(awaiting, JsValue::Object(_) | JsValue::Array(_)) {
            return json!({"legacy":true});
        }
        if awaiting != request {
            return json!({"result":{"ok":false,"code":"request_id_mismatch"}});
        }
    }
    if !matches!(
        schedule.get("lastDecision"),
        None | Some(JsValue::Null) | Some(JsValue::Object(_))
    ) {
        return json!({"legacy":true});
    }
    json!({"pending":true})
}
pub(super) fn plan(connection: &Connection, input: &Value) -> Result<Value> {
    let request = record::parse(
        input["requestJson"]
            .as_str()
            .ok_or_else(|| err("request id required"))?,
    )?;
    Ok(plan_value(load(connection, id(input)?)?, &request))
}
pub(super) fn commit(store: &mut Store, input: &Value) -> Result<Value> {
    let key = id(input)?;
    let request = record::parse(
        input["requestJson"]
            .as_str()
            .ok_or_else(|| err("request id required"))?,
    )?;
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
    let schedule = load(store.conn()?, key)?;
    if plan_value(schedule.clone(), &request)["pending"] != true {
        return Err(err("schedule changed during settlement"));
    }
    let original = schedule.clone();
    let Some(JsValue::Object(mut fields)) = schedule else {
        return Err(err("invalid schedule"));
    };
    let mut decision = match fields
        .iter()
        .find(|(name, _)| name == "lastDecision")
        .map(|(_, value)| value)
    {
        Some(JsValue::Object(fields)) => fields.clone(),
        _ => Vec::new(),
    };
    put(
        &mut decision,
        "action",
        JsValue::string("dismiss_user_input"),
    );
    put(&mut decision, "requestId", request);
    put(&mut decision, "actor", JsValue::string("user"));
    put(&mut decision, "at", from_serde(&input["at"]));
    put(&mut fields, "awaitingRequestId", JsValue::Null);
    put(&mut fields, "classifyState", JsValue::string("D"));
    put(&mut fields, "state", JsValue::string("idle"));
    put(&mut fields, "freezeReason", JsValue::Null);
    put(&mut fields, "lastDecision", JsValue::Object(decision));
    put(
        &mut fields,
        "updatedAt",
        from_serde(&input["scheduleUpdatedAt"]),
    );
    let next = JsValue::Object(fields);
    if original == Some(next.clone()) {
        store.end()?;
        store.add("noops_total", 1.0);
        return Ok(json!({"ok":true}));
    }
    let raw = record::encode(&next)?;
    store.commit_started = Some(Instant::now());
    store.redacted = false;
    store.pending_rows = 1;
    store.pending_bytes = write_record_json(store.conn()?, "sessionSchedules", key, &raw)?;
    set_meta(
        store.conn()?,
        "revision",
        &json!(actual.as_u64().ok_or_else(|| err("invalid revision"))? + 1),
    )?;
    set_meta(store.conn()?, "updatedAt", &input["updatedAt"])?;
    header(store.conn()?)?;
    store.request("commit", &Value::Null)?;
    Ok(json!({"ok":true}))
}
