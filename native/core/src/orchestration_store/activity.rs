//! Bounded activity reads for the task IDs currently displayed by a client.
//! Terminal records supply status from their receipt and never load output bodies.
use super::{err, record, Result};
use crate::js::{from_serde, JsString, JsValue};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

const MAX_TASK_IDS: usize = 100;
const MAX_ID_UNITS: usize = 256;
const OUTPUT_TAIL_UNITS: usize = 500;
const QUERY: &str = "SELECT data_json -> '$.taskId', data_json -> '$.status',
    CASE WHEN json_type(data_json,'$.createdAt') IN ('integer','real') THEN data_json -> '$.createdAt' END,
    CASE WHEN json_type(data_json,'$.updatedAt') IN ('integer','real') THEN data_json -> '$.updatedAt' END,
    CASE WHEN status IN ('completed','failed','interrupted','cancelled','done','fail','error','canceled','stale','timeout')
        THEN NULL ELSE data_json -> '$.lastOutput' END
    FROM orchestration_tasks WHERE id=?1 AND parent_session_id=?2";

fn invalid(message: &str) -> String {
    format!("ORCHESTRATION_TASK_ACTIVITY_INPUT:{message}")
}

fn inputs(input: &Value) -> Result<(&str, Vec<JsString>)> {
    let session = input["sessionId"]
        .as_str()
        .filter(|v| !v.is_empty() && v.encode_utf16().count() <= MAX_ID_UNITS)
        .ok_or_else(|| invalid("sessionId 必须是 1 到 256 字符的会话标识"))?;
    let ids = match &input["taskIds"] {
        Value::String(raw) => {
            if raw.len() > MAX_TASK_IDS * (MAX_ID_UNITS * 6 + 4) + 2 {
                return Err(invalid("taskIds 参数过长"));
            }
            record::parse(raw).map_err(|_| invalid("taskIds 必须是 JSON 字符串数组"))?
        }
        Value::Array(items)
            if items.len() <= MAX_TASK_IDS && items.iter().all(Value::is_string) =>
        {
            from_serde(&input["taskIds"])
        }
        _ => return Err(invalid("taskIds 必须是最多 100 项的字符串数组")),
    };
    let JsValue::Array(ids) = ids else {
        return Err(invalid("taskIds 必须是 JSON 字符串数组"));
    };
    if ids.len() > MAX_TASK_IDS {
        return Err(invalid("taskIds 每次最多查询 100 项"));
    }
    let mut unique = HashSet::new();
    let mut result = Vec::new();
    for id in ids {
        let JsValue::String(id) = id else {
            return Err(invalid("taskIds 的每一项必须是字符串"));
        };
        if id.is_empty() || id.len() > MAX_ID_UNITS {
            return Err(invalid("taskId 长度必须介于 1 到 256 字符"));
        }
        if unique.insert(id.clone()) {
            result.push(id);
        }
    }
    Ok((session, result))
}

fn task_record_id(session: &str, task_id: &JsString) -> String {
    // Node's UTF-8 encoder replaces lone UTF-16 surrogates before hashing.
    let digest = format!(
        "{:x}",
        Sha256::digest(format!("{session}\0{}", task_id.to_string_lossy()).as_bytes())
    );
    format!("task_{}", &digest[..32])
}

pub(super) fn task_activity(connection: &Connection, input: &Value) -> Result<Value> {
    let (session, ids) = inputs(input)?;
    let transaction = connection.unchecked_transaction().map_err(err)?;
    let mut statement = transaction.prepare(QUERY).map_err(err)?;
    let mut rows = Vec::with_capacity(ids.len());
    for id in ids {
        let values = statement
            .query_row(params![task_record_id(session, &id), session], |row| {
                Ok([
                    row.get::<_, Option<String>>(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ])
            })
            .optional()
            .map_err(err)?;
        let Some(values) = values else { continue };
        let value = |index: usize| -> Result<JsValue> {
            values[index]
                .as_deref()
                .map(record::parse)
                .transpose()
                .map(|v| v.unwrap_or(JsValue::Null))
        };
        // The parent column and full task ID guard both session boundaries and
        // the UTF-8 replacement collisions possible with legacy JS task IDs.
        if value(0)? != JsValue::String(id.clone()) {
            continue;
        }
        let status = match value(1)? {
            JsValue::String(status) => JsValue::String(status.truncate_units(64)),
            _ => JsValue::Null,
        };
        let mut projected = vec![
            ("taskId", JsValue::String(id)),
            ("status", status),
            ("createdAt", value(2)?),
            ("updatedAt", value(3)?),
        ];
        if let JsValue::String(output) = value(4)? {
            projected.push((
                "lastOutput",
                JsValue::String(
                    output
                        .slice_units(output.len().saturating_sub(OUTPUT_TAIL_UNITS), output.len()),
                ),
            ));
        }
        rows.push(record::encode(&JsValue::object(projected))?);
    }
    drop(statement);
    transaction.commit().map_err(err)?;
    Ok(json!({"rowsJson":rows}))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn database() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE orchestration_tasks(id TEXT PRIMARY KEY,parent_session_id TEXT,status TEXT,data_json TEXT NOT NULL);").unwrap();
        connection
    }

    fn insert(connection: &Connection, session: &str, task_id: &str, status: &str, output: &str) {
        connection.execute("INSERT INTO orchestration_tasks VALUES(?1,?2,?3,?4)", params![
            task_record_id(session, &task_id.into()), session, status,
            json!({"taskId":task_id,"status":status,"createdAt":1,"updatedAt":2,"lastOutput":output,"unrelated":"private"}).to_string()
        ]).unwrap();
    }

    #[test]
    fn activity_reads_requested_ids_and_settles_terminal_tasks_without_body_tables() {
        let connection = database();
        insert(
            &connection,
            "session",
            "running",
            "running",
            &"x".repeat(5000),
        );
        insert(
            &connection,
            "session",
            "ended",
            "completed",
            "must not be returned",
        );
        insert(
            &connection,
            "other",
            "foreign",
            "running",
            "not this session",
        );
        let result = task_activity(&connection, &json!({"sessionId":"session","taskIds":["running","ended","foreign","missing","running"]})).unwrap();
        let rows: Vec<Value> = result["rowsJson"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| serde_json::from_str(row.as_str().unwrap()).unwrap())
            .collect();
        assert_eq!(rows.len(), 2);
        assert_eq!(
            rows[0]["lastOutput"].as_str().unwrap().len(),
            OUTPUT_TAIL_UNITS
        );
        assert!(rows[0].get("unrelated").is_none());
        assert_eq!(rows[1]["status"], "completed");
        assert!(rows[1].get("lastOutput").is_none());
    }

    #[test]
    fn activity_validates_bounded_inputs_and_uses_primary_key_search() {
        let connection = database();
        for input in [
            json!({"sessionId":"session","taskIds":"not-json"}),
            json!({"sessionId":"session","taskIds":[1]}),
            json!({"sessionId":"session","taskIds":[""]}),
            json!({"sessionId":"session","taskIds":vec!["id";101]}),
            json!({"sessionId":"session","taskIds":["x".repeat(257)]}),
            json!({"sessionId":"","taskIds":[]}),
        ] {
            assert!(task_activity(&connection, &input)
                .unwrap_err()
                .starts_with("ORCHESTRATION_TASK_ACTIVITY_INPUT:"));
        }
        let result =
            task_activity(&connection, &json!({"sessionId":"session","taskIds":"[]"})).unwrap();
        assert_eq!(result["rowsJson"], json!([]));
        let plan: String = connection
            .query_row(
                &format!("EXPLAIN QUERY PLAN {QUERY}"),
                ["key", "session"],
                |row| row.get(3),
            )
            .unwrap();
        assert!(plan.contains("SEARCH orchestration_tasks"), "{plan}");
    }

    #[test]
    fn activity_tail_preserves_utf16_and_task_id_hash_matches_node() {
        let connection = database();
        let id = JsString::from_units(vec![0xd800]);
        let key = task_record_id("session", &id);
        let raw = r#"{"taskId":"\ud800","status":"running","lastOutput":"a\ud800"}"#;
        connection
            .execute(
                "INSERT INTO orchestration_tasks VALUES(?1,'session','running',?2)",
                params![key, raw],
            )
            .unwrap();
        let result = task_activity(
            &connection,
            &json!({"sessionId":"session","taskIds":r#"["\ud800"]"#}),
        )
        .unwrap();
        let row = record::parse(result["rowsJson"][0].as_str().unwrap()).unwrap();
        assert_eq!(row.get("taskId"), Some(&JsValue::String(id)));
        assert_eq!(
            row.get("lastOutput"),
            Some(&JsValue::String(JsString::from_units(vec![97, 0xd800])))
        );
        assert_eq!(
            task_record_id("session", &"id".into()),
            "task_eac06d0d290d31081bdc43bd4f025321"
        );
    }
}
