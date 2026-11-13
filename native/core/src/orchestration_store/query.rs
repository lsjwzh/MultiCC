use super::{encode, err, receipts, record, table, Result};
use crate::js::{from_serde, to_serde, JsValue};
use rusqlite::{params_from_iter, types::Value as Sql, Connection};
use serde_json::{json, Value};
use std::cmp::Ordering;

pub(super) fn sql_value(value: &Value) -> Sql {
    match value {
        Value::Null => Sql::Null,
        Value::Bool(v) => Sql::Integer(i64::from(*v)),
        Value::Number(n) => n
            .as_i64()
            .map(Sql::Integer)
            .unwrap_or_else(|| Sql::Real(n.as_f64().unwrap_or(0.0))),
        Value::String(s) => Sql::Text(s.clone()),
        _ => Sql::Text(encode(value).unwrap_or_default()),
    }
}
pub(super) fn json_path(parts: &[Value]) -> Result<String> {
    let mut out = String::from("$");
    for part in parts {
        match part {
            Value::String(key) => {
                out.push('.');
                out.push_str(&serde_json::to_string(key).map_err(err)?);
            }
            Value::Number(index)
                if index.as_f64().is_some_and(|n| n >= 0.0 && n.fract() == 0.0) =>
            {
                out.push_str(&format!("[{}]", index.as_f64().unwrap() as u64));
            }
            _ => return Err(err("invalid property path")),
        }
    }
    Ok(out)
}
fn path(field: &str) -> Result<String> {
    if field.is_empty()
        || !field
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
        || field.split('.').any(str::is_empty)
    {
        return Err(err("invalid orchestration query field"));
    }
    json_path(
        &field
            .split('.')
            .map(|s| Value::String(s.into()))
            .collect::<Vec<_>>(),
    )
}
fn expressions(collection: &str, field: &str) -> Result<(String, String)> {
    let path = path(field)?;
    let source = receipts::json_source(collection, Some(field))?;
    let column = match (collection, field) {
        (_, "id") if collection != "sessionSchedules" && collection != "extras" => Some("id"),
        ("waits" | "outbox", "sessionId") => Some("session_id"),
        ("sessionSchedules", "sessionId") => Some("session_id"),
        ("waits" | "operations" | "tasks", "status") => Some("status"),
        ("outbox" | "sessionSchedules", "state") => Some("state"),
        ("outbox", "sequence") => Some("sequence"),
        ("outbox", "availableAt") => Some("available_at"),
        ("outbox", "leasedUntil") => Some("leased_until"),
        ("operations", "kind") => Some("kind"),
        ("operations", "ownerSessionId") => Some("owner_session_id"),
        ("tasks", "parentSessionId") => Some("parent_session_id"),
        (_, "updatedAt") if collection != "extras" => Some("updated_at"),
        _ => None,
    };
    let value = column
        .map(str::to_owned)
        .unwrap_or_else(|| format!("json_extract({source},'{path}')"));
    Ok((value, format!("json_type({source},'{path}')")))
}
fn equals(expr: &str, typ: &str, value: &Value, params: &mut Vec<Sql>) -> String {
    match value {
        Value::Null => format!("{typ}='null'"),
        Value::Bool(v) => format!("{typ}='{}'", if *v { "true" } else { "false" }),
        Value::String(text) => {
            params.push(sql_value(value));
            // A symbolic state cannot be produced by SQLite numeric affinity or
            // by JSON encoding another type. Filter the indexed state column
            // before ever parsing the historical record body.
            if matches!(expr, "status" | "state")
                && !text.is_empty()
                && text
                    .bytes()
                    .all(|b| b.is_ascii_alphabetic() || b == b'_' || b == b'-')
            {
                format!("{expr}=?")
            } else {
                format!("({typ}='text' AND {expr}=?)")
            }
        }
        Value::Number(_) => {
            params.push(sql_value(value));
            format!("({typ} IN ('integer','real') AND {expr}=?)")
        }
        _ => "0".into(),
    }
}
fn predicate(collection: &str, where_value: &Value, params: &mut Vec<Sql>) -> Result<String> {
    let Some(where_map) = where_value.as_object() else {
        return Ok("1".into());
    };
    let mut fields = Vec::new();
    for (field, expected) in where_map {
        let (expr, typ) = expressions(collection, field)?;
        let mut membership = |values: &[Value], negated: bool| {
            let clauses = values
                .iter()
                .map(|v| equals(&expr, &typ, v, params))
                .collect::<Vec<_>>();
            let positive = if clauses.is_empty() {
                "0".into()
            } else {
                format!("({})", clauses.join(" OR "))
            };
            if negated {
                format!("NOT COALESCE({positive},0)")
            } else {
                positive
            }
        };
        let condition = if let Some(values) = expected.as_array() {
            membership(values, false)
        } else if let Some(ops) = expected.as_object() {
            let mut conditions = Vec::new();
            for (op, value) in ops {
                match op.as_str() {
                    "$in" | "$nin" => {
                        let values = value
                            .as_array()
                            .ok_or_else(|| err("query membership must be an array"))?;
                        let clauses = values
                            .iter()
                            .map(|v| equals(&expr, &typ, v, params))
                            .collect::<Vec<_>>();
                        let positive = if clauses.is_empty() {
                            "0".into()
                        } else {
                            format!("({})", clauses.join(" OR "))
                        };
                        conditions.push(if op == "$nin" {
                            format!("NOT COALESCE({positive},0)")
                        } else {
                            positive
                        });
                    }
                    "$eq" => conditions.push(equals(&expr, &typ, value, params)),
                    "$ne" => conditions.push(format!(
                        "NOT COALESCE({},0)",
                        equals(&expr, &typ, value, params)
                    )),
                    "$lt" | "$lte" | "$gt" | "$gte" => {
                        if !value.is_number() {
                            return Err(err("range comparison requires a number"));
                        }
                        params.push(sql_value(value));
                        let operator = match op.as_str() {
                            "$lt" => "<",
                            "$lte" => "<=",
                            "$gt" => ">",
                            _ => ">=",
                        };
                        conditions.push(format!(
                            "({typ} IN ('integer','real') AND {expr}{operator}?)"
                        ));
                    }
                    _ => return Err(err("unsupported orchestration query operator")),
                }
            }
            if conditions.is_empty() {
                "1".into()
            } else {
                format!("({})", conditions.join(" AND "))
            }
        } else {
            equals(&expr, &typ, expected, params)
        };
        fields.push(condition);
    }
    Ok(if fields.is_empty() {
        "1".into()
    } else {
        fields.join(" AND ")
    })
}
fn get<'a>(value: &'a JsValue, field: &str) -> Option<&'a JsValue> {
    field.split('.').try_fold(value, |v, key| v.get(key))
}
fn equal(actual: Option<&JsValue>, expected: &JsValue) -> bool {
    matches!(
        expected,
        JsValue::Null | JsValue::Bool(_) | JsValue::Number(_) | JsValue::String(_)
    ) && actual == Some(expected)
}
fn matches(value: &JsValue, filter: &JsValue) -> bool {
    let JsValue::Object(map) = filter else {
        return true;
    };
    map.iter().all(|(field, expected)| {
        let actual = get(value, &field.to_string_lossy());
        if let JsValue::Array(values) = expected {
            return values.iter().any(|v| equal(actual, v));
        }
        let JsValue::Object(ops) = expected else { return equal(actual, expected); };
        ops.iter().all(|(op, expected)| match op.to_string_lossy().as_str() {
            "$in" => matches!(expected, JsValue::Array(values) if values.iter().any(|v| equal(actual, v))),
            "$nin" => matches!(expected, JsValue::Array(values) if values.iter().all(|v| !equal(actual, v))),
            "$eq" => equal(actual, expected),
            "$ne" => !equal(actual, expected),
            "$lt" | "$lte" | "$gt" | "$gte" => match (actual, expected) {
                (Some(JsValue::Number(a)), JsValue::Number(b)) => match op.to_string_lossy().as_str() {
                    "$lt" => a < b, "$lte" => a <= b, "$gt" => a > b, _ => a >= b,
                },
                _ => false,
            },
            _ => false,
        })
    })
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
fn project(value: JsValue, fields: Option<&Vec<Value>>) -> JsValue {
    let Some(fields) = fields else {
        return value;
    };
    let mut out = JsValue::Object(Vec::new());
    for field in fields.iter().filter_map(Value::as_str) {
        if let Some(v) = get(&value, field) {
            put(&mut out, field, v.clone());
        }
    }
    out
}
// Match SQLite's type classes and UTF-8 string ordering when merging overlays.
fn compare(a: &JsValue, b: &JsValue) -> Ordering {
    fn rank(v: &JsValue) -> u8 {
        match v {
            JsValue::Null | JsValue::Undefined => 0,
            JsValue::Number(_) | JsValue::Bool(_) => 1,
            _ => 2,
        }
    }
    fn number(v: &JsValue) -> f64 {
        match v {
            JsValue::Number(n) => *n,
            JsValue::Bool(b) => f64::from(u8::from(*b)),
            _ => 0.0,
        }
    }
    rank(a).cmp(&rank(b)).then_with(|| match (a, b) {
        (JsValue::String(a), JsValue::String(b)) => a.to_string_lossy().cmp(&b.to_string_lossy()),
        _ if rank(a) == 1 => number(a).partial_cmp(&number(b)).unwrap_or(Ordering::Equal),
        _ => record::encode(a)
            .unwrap_or_default()
            .cmp(&record::encode(b).unwrap_or_default()),
    })
}

pub(super) fn select(connection: &Connection, input: &Value, operation: &str) -> Result<Value> {
    let collection = input["collection"]
        .as_str()
        .ok_or_else(|| err("query collection required"))?;
    let (table, key_column) = table(collection)?;
    let options = &input["options"];
    let fields = options["fields"].as_array();
    let filter = match options["whereJson"].as_str() {
        Some(raw) => record::parse(raw)?,
        None => from_serde(&options["where"]),
    };
    // Exotic UTF-16 comparisons use the shared JS model, one row at a time.
    // Normal recovery/count/selectKeys queries stay entirely in indexed SQL.
    let fallback = !record::well_formed(&filter);
    let overrides = input["overrides"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let mut params = Vec::new();
    let validated = predicate(collection, &to_serde(&filter), &mut params)?;
    let mut condition = if fallback {
        params.clear();
        "1".into()
    } else {
        validated
    };
    if !overrides.is_empty() {
        condition.push_str(&format!(
            " AND {key_column} NOT IN ({})",
            vec!["?"; overrides.len()].join(",")
        ));
        for entry in overrides {
            params.push(Sql::Text(
                entry["key"]
                    .as_str()
                    .ok_or_else(|| err("override key required"))?
                    .into(),
            ));
        }
    }
    let mut dirty = Vec::new();
    for entry in overrides {
        if entry["deleted"] == true {
            continue;
        }
        let value = record::parse(
            entry["valueJson"]
                .as_str()
                .ok_or_else(|| err("override JSON required"))?,
        )?;
        if matches(&value, &filter) {
            dirty.push((entry["key"].as_str().unwrap().to_owned(), value));
        }
    }
    if operation == "count" && !fallback {
        let count: u64 = connection
            .query_row(
                &format!("SELECT COUNT(*) FROM {table} WHERE {condition}"),
                params_from_iter(params),
                |r| r.get(0),
            )
            .map_err(err)?;
        return Ok(json!(count + dirty.len() as u64));
    }
    let order = options["orderBy"].as_str();
    let order_expr = order
        .map(|field| expressions(collection, field).map(|v| v.0))
        .transpose()?
        .unwrap_or_else(|| key_column.into());
    let order_json = order
        .map(|field| {
            Ok::<_, String>(format!(
                "{} -> '{}'",
                receipts::json_source(collection, Some(field))?,
                path(field)?
            ))
        })
        .transpose()?
        .unwrap_or_else(|| format!("json_quote({key_column})"));
    let descending = options["descending"] == true;
    let mut selections = vec![key_column.to_string(), order_json];
    if fallback || (matches!(operation, "select" | "selectKeyed") && fields.is_none()) {
        selections.push(receipts::json_source(collection, None)?);
    } else if matches!(operation, "select" | "selectKeyed") {
        for field in fields.unwrap() {
            let field = field
                .as_str()
                .ok_or_else(|| err("query field must be a string"))?;
            selections.push(format!(
                "{} -> '{}'",
                receipts::json_source(collection, Some(field))?,
                path(field)?
            ));
        }
    }
    let limit = options["limit"]
        .as_f64()
        .filter(|n| n.is_finite() && *n >= 0.0 && n.fract() == 0.0)
        .map(|n| n as u64);
    let limit_clause = if fallback || operation == "count" {
        String::new()
    } else {
        limit.map(|n| format!(" LIMIT {n}")).unwrap_or_default()
    };
    let sql = format!("SELECT {} FROM {table} WHERE {condition} ORDER BY {order_expr} {}, {key_column} ASC{limit_clause}", selections.join(","), if descending { "DESC" } else { "ASC" });
    let mut stmt = connection.prepare(&sql).map_err(err)?;
    let mut rows = stmt.query(params_from_iter(params)).map_err(err)?;
    let mut output: Vec<(String, JsValue, JsValue)> = Vec::new();
    let mut count = dirty.len() as u64;
    while let Some(row) = rows.next().map_err(err)? {
        let full = if fallback {
            Some(record::parse(&row.get::<_, String>(2).map_err(err)?)?)
        } else {
            None
        };
        if full.as_ref().is_some_and(|v| !matches(v, &filter)) {
            continue;
        }
        if operation == "count" {
            count += 1;
            continue;
        }
        let key: String = row.get(0).map_err(err)?;
        let ordered = record::parse(
            &row.get::<_, Option<String>>(1)
                .map_err(err)?
                .unwrap_or_else(|| "null".into()),
        )?;
        let value = if operation == "selectKeys" {
            JsValue::Null
        } else if let Some(full) = full {
            project(full, fields)
        } else if let Some(fields) = fields {
            let mut value = JsValue::Object(Vec::new());
            for (i, field) in fields.iter().enumerate() {
                if let Some(raw) = row.get::<_, Option<String>>(2 + i).map_err(err)? {
                    put(&mut value, field.as_str().unwrap(), record::parse(&raw)?);
                }
            }
            value
        } else {
            record::parse(&row.get::<_, String>(2).map_err(err)?)?
        };
        output.push((key, ordered, value));
    }
    if operation == "count" {
        return Ok(json!(count));
    }
    for (key, value) in dirty {
        let ordered = order
            .and_then(|name| get(&value, name))
            .cloned()
            .unwrap_or_else(|| {
                if order.is_some() {
                    JsValue::Null
                } else {
                    JsValue::string(&key)
                }
            });
        output.push((
            key,
            ordered,
            if operation == "selectKeys" {
                JsValue::Null
            } else {
                project(value, fields)
            },
        ));
    }
    output.sort_by(|a, b| {
        let cmp = compare(&a.1, &b.1);
        (if descending { cmp.reverse() } else { cmp }).then_with(|| a.0.cmp(&b.0))
    });
    if let Some(limit) = limit {
        output.truncate(limit.min(usize::MAX as u64) as usize);
    }
    if operation == "selectKeys" {
        return Ok(json!(output
            .into_iter()
            .map(|(key, _, _)| key)
            .collect::<Vec<_>>()));
    }
    if operation == "selectKeyed" {
        let mut keys = Vec::with_capacity(output.len());
        let mut rows = Vec::with_capacity(output.len());
        for (key, _, value) in output {
            keys.push(key);
            rows.push(record::encode(&value)?);
        }
        return Ok(json!({"keys":keys,"rowsJson":rows}));
    }
    Ok(
        json!({"rowsJson": output.into_iter().map(|(_, _, value)| record::encode(&value)).collect::<Result<Vec<_>>>()?}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn terminal_status_filter_never_parses_historical_payloads() {
        let sql = predicate(
            "tasks",
            &json!({"status":{"$nin":["completed","failed","cancelled"]}}),
            &mut Vec::new(),
        )
        .unwrap();
        assert!(!sql.contains("json_"), "{sql}");
        assert!(
            sql.contains("COALESCE"),
            "missing states must remain candidates"
        );
    }
    #[test]
    fn membership_distinguishes_missing_null_and_zero() {
        let check = |a, b| matches(&from_serde(&a), &from_serde(&b));
        assert!(!check(json!({}), json!({"status":null})));
        assert!(check(json!({}), json!({"status":{"$nin":[null,"done"]}})));
        assert!(check(json!({"n":0}), json!({"n":{"$lte":1}})));
        assert!(!check(json!({"n":"0"}), json!({"n":{"$lte":1}})));
    }
    #[test]
    fn projected_fields_do_not_copy_payload() {
        let value = project(
            from_serde(
                &json!({"id":"x","spec":{"chatId":"s","message":"private"},"result":"large"}),
            ),
            Some(&vec![json!("id"), json!("spec.chatId")]),
        );
        assert_eq!(to_serde(&value), json!({"id":"x","spec":{"chatId":"s"}}));
    }
}
