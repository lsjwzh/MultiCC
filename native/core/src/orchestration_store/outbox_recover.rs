//! Recovery of expired outbox leases. The complete batch is one SQLite commit.
use super::{err, header, meta, record, set_meta, write_record_json, Result, Store};
use crate::js::{self, JsValue};
use rusqlite::Connection;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{cmp::Ordering, time::Instant};
use subtle::ConstantTimeEq;

type RecordChanges = Vec<(String, String)>;
type LeaseMetadata = (String, Option<String>, Option<String>, Option<String>);

fn put(fields: &mut Vec<(js::JsString, JsValue)>, name: &str, value: JsValue) {
    if let Some((_, old)) = fields.iter_mut().find(|(key, _)| key == name) {
        *old = value;
    } else {
        fields.push((name.into(), value));
    }
}
fn delay(input: &Value, attempts: f64) -> Result<f64> {
    let base = input["baseBackoffMs"]
        .as_f64()
        .ok_or_else(|| err("invalid outbox backoff"))?;
    let max = input["maxBackoffMs"]
        .as_f64()
        .ok_or_else(|| err("invalid outbox backoff"))?;
    let exponent = if attempts.is_nan() {
        f64::NAN
    } else {
        (attempts - 1.0).max(0.0)
    };
    let raw = base * 2f64.powf(exponent);
    let value = if raw.is_nan() { f64::NAN } else { max.min(raw) };
    if !value.is_finite() || value < 0.0 {
        return Err("OUTBOX_BACKOFF_INVALID".into());
    }
    Ok(value)
}
pub(super) fn recover(connection: &Connection, input: &Value) -> Result<(RecordChanges, u64, u64)> {
    let at = input["at"]
        .as_f64()
        .filter(|n| n.is_finite())
        .ok_or_else(|| err("invalid outbox clock"))?;
    let max_attempts = input["maxAttempts"]
        .as_f64()
        .ok_or_else(|| err("invalid outbox max attempts"))?;
    let mut stmt = connection
        .prepare("SELECT id, data_json -> '$.sequence', data_json -> '$.leasedUntil', data_json -> '$.attempts' FROM orchestration_outbox WHERE state='leased' ORDER BY id")
        .map_err(err)?;
    let metadata: Vec<LeaseMetadata> = stmt
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .map_err(err)?
        .collect::<std::result::Result<_, _>>()
        .map_err(err)?;
    drop(stmt);
    let parse = |raw: Option<String>| -> Result<JsValue> {
        raw.map(|raw| record::parse(&raw))
            .unwrap_or(Ok(JsValue::Undefined))
    };
    let mut rows = Vec::with_capacity(metadata.len());
    for (id, sequence, until, attempts) in metadata {
        rows.push((id, parse(sequence)?, parse(until)?, parse(attempts)?));
    }
    // Existing native query returns id order; JS then applies a stable numeric
    // sequence sort, with NaN treated as an equal comparison.
    rows.sort_by(|a, b| {
        (js::js_to_number(&a.1) - js::js_to_number(&b.1))
            .partial_cmp(&0.0)
            .unwrap_or(Ordering::Equal)
    });
    let mut changes = Vec::new();
    let mut recovered = 0;
    let mut dead = 0;
    for (id, _, until, attempts) in rows {
        if js::js_to_number(&until) > at {
            continue;
        }
        let attempts = js::js_to_number(&attempts);
        let raw = record::get_json(connection, "outbox", &id, &[])?
            .ok_or_else(|| err("missing leased outbox record"))?;
        let mut item = record::parse(&raw)?;
        let JsValue::Object(fields) = &mut item else {
            return Err(err("invalid leased outbox record"));
        };
        put(
            fields,
            "lastError",
            JsValue::string("delivery lease expired"),
        );
        put(fields, "updatedAt", JsValue::Number(at));
        for name in ["leasedAt", "leasedUntil", "leaseOwner", "leaseTokenHash"] {
            put(fields, name, JsValue::Null);
        }
        if attempts >= max_attempts {
            put(fields, "state", JsValue::string("dead-letter"));
            put(fields, "deadLetterAt", JsValue::Number(at));
            dead += 1;
        } else {
            let delay = delay(input, attempts)?;
            put(fields, "state", JsValue::string("pending"));
            put(fields, "availableAt", JsValue::Number(at + delay));
            recovered += 1;
        }
        changes.push((id, record::encode(&item)?));
    }
    Ok((changes, recovered, dead))
}
fn token_equal(expected: Option<&JsValue>, token: &JsValue) -> bool {
    let actual = Sha256::digest(js::js_to_string(token).to_string_lossy().as_bytes());
    let mut decoded = [0u8; 32];
    let valid = if let Some(JsValue::String(text)) = expected {
        let value = text.to_string_lossy();
        if value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            for (index, slot) in decoded.iter_mut().enumerate() {
                *slot = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16).unwrap_or(0);
            }
            true
        } else {
            false
        }
    } else {
        false
    };
    bool::from(actual.as_slice().ct_eq(&decoded)) && valid
}
fn public(item: &JsValue) -> JsValue {
    let mut copy = item.clone();
    if let JsValue::Object(fields) = &mut copy {
        fields.retain(|(key, _)| key != "leaseTokenHash");
    }
    copy
}
fn process(connection: &Connection, input: &Value) -> Result<(Vec<(String, String)>, JsValue)> {
    let (mut changes, recovered, dead) = recover(connection, input)?;
    let action = input["action"].as_str().unwrap_or("recover");
    if action == "recover" {
        return Ok((
            changes,
            JsValue::object(vec![
                ("recovered", (recovered as f64).into()),
                ("deadLettered", (dead as f64).into()),
            ]),
        ));
    }
    let id = input["id"]
        .as_str()
        .ok_or_else(|| err("outbox id required"))?;
    let target_index = changes.iter().position(|(key, _)| key == id);
    let raw = if let Some(index) = target_index {
        Some(changes[index].1.clone())
    } else {
        record::get_json(connection, "outbox", id, &[])?
    };
    let Some(raw) = raw else {
        return Ok((
            changes,
            JsValue::object(vec![("ok", false.into()), ("code", "not_found".into())]),
        ));
    };
    let mut item = record::parse(&raw)?;
    if !js::truthy(&item) {
        return Ok((
            changes,
            JsValue::object(vec![("ok", false.into()), ("code", "not_found".into())]),
        ));
    }
    let token = record::parse(
        input["tokenJson"]
            .as_str()
            .ok_or_else(|| err("outbox token required"))?,
    )?;
    if item.get("state") != Some(&JsValue::string("leased"))
        || !token_equal(item.get("leaseTokenHash"), &token)
    {
        return Ok((
            changes,
            JsValue::object(vec![("ok", false.into()), ("code", "lease_lost".into())]),
        ));
    }
    if matches!(action, "fail" | "defer") && input["reasonDeferred"] == true {
        return Ok((changes, JsValue::object(vec![("needsReason", true.into())])));
    }
    let at = input["at"]
        .as_f64()
        .ok_or_else(|| err("invalid outbox clock"))?;
    let attempts = js::js_to_number(item.get("attempts").unwrap_or(&JsValue::Undefined));
    let JsValue::Object(fields) = &mut item else {
        return Err(err("invalid leased outbox record"));
    };
    for name in ["leasedAt", "leasedUntil", "leaseOwner", "leaseTokenHash"] {
        put(fields, name, JsValue::Null);
    }
    put(fields, "updatedAt", JsValue::Number(at));
    let mut extra = Vec::new();
    match action {
        "ack" => {
            put(fields, "state", JsValue::string("delivered"));
            put(fields, "deliveredAt", JsValue::Number(at));
        }
        "fail" | "defer" => {
            let reason = record::parse(
                input["reasonJson"]
                    .as_str()
                    .ok_or_else(|| err("outbox reason required"))?,
            )?;
            let reason = if input["reasonFormatted"] == true {
                reason.get("value").cloned().unwrap_or(JsValue::Undefined)
            } else if js::truthy(&reason) {
                JsValue::String(js::js_to_string(&reason).slice_units(0, 2000))
            } else {
                JsValue::string("delivery failed")
            };
            put(fields, "lastError", reason);
            if action == "defer" {
                let attempts = if attempts.is_nan() {
                    f64::NAN
                } else {
                    (attempts - 1.0).max(0.0)
                };
                let available = at
                    + input["delayMs"]
                        .as_f64()
                        .ok_or_else(|| err("invalid defer delay"))?;
                put(fields, "attempts", JsValue::Number(attempts));
                put(fields, "state", JsValue::string("pending"));
                put(fields, "availableAt", JsValue::Number(available));
                extra.push(("deferred", true.into()));
                extra.push(("availableAt", available.into()));
            } else if input["retryable"] == true
                && attempts < input["maxAttempts"].as_f64().unwrap_or(0.0)
            {
                let available = at + delay(input, attempts)?;
                put(fields, "state", JsValue::string("pending"));
                put(fields, "availableAt", JsValue::Number(available));
                extra.push(("retry", true.into()));
                extra.push(("availableAt", available.into()));
            } else {
                put(fields, "state", JsValue::string("dead-letter"));
                put(fields, "deadLetterAt", JsValue::Number(at));
                extra.push(("retry", false.into()));
                extra.push(("deadLetter", true.into()));
            }
        }
        _ => return Err(err("invalid outbox action")),
    }
    let raw = record::encode(&item)?;
    if let Some(index) = target_index {
        changes[index].1 = raw;
    } else {
        changes.push((id.to_owned(), raw));
    }
    let mut fields = vec![("ok", true.into())];
    fields.extend(extra);
    fields.push(("item", public(&item)));
    Ok((changes, JsValue::object(fields)))
}
pub(super) fn plan(connection: &Connection, input: &Value) -> Result<Value> {
    let (changes, result) = process(connection, input)?;
    if result.get("needsReason") == Some(&JsValue::Bool(true)) {
        return Ok(json!({"needsReason":true}));
    }
    Ok(json!({"changed":!changes.is_empty(),"resultJson":record::encode(&result)?}))
}
pub(super) fn commit(store: &mut Store, input: &Value) -> Result<Value> {
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
    let (changes, result) = process(store.conn()?, input)?;
    store.commit_started = Some(Instant::now());
    store.redacted = false;
    store.pending_rows = changes.len();
    store.pending_bytes = 0;
    for (id, raw) in changes {
        store.pending_bytes += write_record_json(store.conn()?, "outbox", &id, &raw)?;
    }
    set_meta(
        store.conn()?,
        "revision",
        &json!(actual.as_u64().ok_or_else(|| err("invalid revision"))? + 1),
    )?;
    set_meta(store.conn()?, "updatedAt", &input["updatedAt"])?;
    header(store.conn()?)?;
    store.request("commit", &Value::Null)?;
    Ok(json!({"resultJson":record::encode(&result)?}))
}
