//! Lossless JSON at the per-record persistence boundary. Domain strings use
//! UTF-16, including lone surrogates produced by ordinary JavaScript slicing.
use super::{corrupt, err, receipts, table, Result};
use crate::js::{from_serde, json_parse, json_stringify, to_serde, JsValue};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};

pub(super) fn parse(raw: &str) -> Result<JsValue> {
    json_parse(raw).map_err(corrupt)
}
pub(super) fn encode(value: &JsValue) -> Result<String> {
    json_stringify(value).ok_or_else(|| err("record is not JSON serializable"))
}
pub(super) fn well_formed(value: &JsValue) -> bool {
    match value {
        JsValue::String(s) => s.is_well_formed(),
        JsValue::Array(items) => items.iter().all(well_formed),
        JsValue::Object(items) => items
            .iter()
            .all(|(k, v)| k.is_well_formed() && well_formed(v)),
        _ => true,
    }
}
// Only these small values feed indexed SQL columns. The persisted body is never
// converted through serde_json, which cannot represent isolated UTF-16 units.
pub(super) fn index_fields(value: &JsValue) -> Result<Value> {
    let mut out = Map::new();
    for name in [
        "sessionId",
        "status",
        "state",
        "sequence",
        "availableAt",
        "leasedUntil",
        "updatedAt",
        "kind",
        "ownerSessionId",
        "parentSessionId",
    ] {
        if let Some(v) = value.get(name) {
            out.insert(
                name.into(),
                if well_formed(v) {
                    to_serde(v)
                } else {
                    Value::Null
                },
            );
        }
    }
    let mut metadata = Map::new();
    for name in ["nextAt", "dueAt", "expireAt"] {
        if let Some(v) = value.get("metadata").and_then(|v| v.get(name)) {
            metadata.insert(
                name.into(),
                if well_formed(v) {
                    to_serde(v)
                } else {
                    Value::Null
                },
            );
        }
    }
    out.insert("metadata".into(), Value::Object(metadata));
    Ok(Value::Object(out))
}
pub(super) fn path(input: &Value) -> Result<Vec<JsValue>> {
    let value = if let Some(raw) = input["pathJson"].as_str() {
        parse(raw)?
    } else {
        from_serde(input.get("path").unwrap_or(&json!([])))
    };
    match value {
        JsValue::Array(parts) => Ok(parts),
        _ => Err(err("property path must be an array")),
    }
}
// SQLite JSON paths do not cover every possible JS property name. Use its fast
// path only for unambiguous identifiers; other names decode just this record.
pub(super) fn sql_path(parts: &[JsValue]) -> Result<Option<String>> {
    let mut path = String::from("$");
    for part in parts {
        match part {
            JsValue::String(key)
                if !key.is_empty()
                    && key
                        .as_units()
                        .iter()
                        .all(|u| matches!(*u, 48..=57 | 65..=90 | 97..=122 | 95 | 45)) =>
            {
                path.push_str(".\"");
                path.push_str(&key.to_string_lossy());
                path.push('"');
            }
            JsValue::String(_) => return Ok(None),
            JsValue::Number(n) if n.is_finite() && *n >= 0.0 && n.fract() == 0.0 => {
                path.push_str(&format!("[{}]", *n as u64));
            }
            _ => return Err(err("invalid property path")),
        }
    }
    Ok(Some(path))
}
fn at<'a>(mut value: &'a JsValue, parts: &[JsValue]) -> Option<&'a JsValue> {
    for part in parts {
        value = match (value, part) {
            (JsValue::Object(entries), JsValue::String(key)) => {
                &entries.iter().find(|(k, _)| k == key)?.1
            }
            (JsValue::Array(items), JsValue::Number(n)) if *n >= 0.0 && n.fract() == 0.0 => {
                items.get(*n as usize)?
            }
            _ => return None,
        };
    }
    Some(value)
}
pub(super) fn get_json(
    connection: &Connection,
    collection: &str,
    key: &str,
    parts: &[JsValue],
) -> Result<Option<String>> {
    let (table, column) = table(collection)?;
    let source = receipts::path_source(collection, parts)?;
    if let Some(path) = sql_path(parts)? {
        return connection
            .query_row(
                &format!("SELECT {source} -> ?1 FROM {table} WHERE {column}=?2"),
                params![path, key],
                |r| r.get::<_, Option<String>>(0),
            )
            .optional()
            .map(Option::flatten)
            .map_err(corrupt);
    }
    let raw: Option<String> = connection
        .query_row(
            &format!("SELECT {source} FROM {table} WHERE {column}=?1"),
            [key],
            |r| r.get(0),
        )
        .optional()
        .map_err(err)?;
    let Some(raw) = raw else {
        return Ok(None);
    };
    at(&parse(&raw)?, parts).map(encode).transpose()
}
pub(super) fn describe(value: &JsValue) -> Result<Value> {
    Ok(match value {
        JsValue::Object(_) => json!({"kind":"object"}),
        JsValue::Array(items) => json!({"kind":"array", "length":items.len()}),
        _ => json!({"kind":"value", "valueJson":encode(value)?}),
    })
}
pub(super) fn keys(raw: &str) -> Result<String> {
    let keys = match parse(raw)? {
        JsValue::Object(entries) => entries
            .into_iter()
            .map(|(k, _)| JsValue::String(k))
            .collect(),
        JsValue::Array(items) => (0..items.len())
            .map(|i| JsValue::string(&i.to_string()))
            .collect(),
        _ => Vec::new(),
    };
    encode(&JsValue::Array(keys))
}
