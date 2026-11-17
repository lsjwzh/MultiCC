//! Experimental bounded row preimages for detached drafts. Not wired to the
//! store until snapshot reads, external writers and conflict checks are proven.
use rusqlite::{
    hooks::PreUpdateCase,
    params_from_iter,
    types::{Value, ValueRef},
    Connection,
};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

const MAX_ROWS: usize = 4096;
const MAX_BYTES: usize = 16 * 1024 * 1024;
type Key = (String, Vec<String>);

#[derive(Default, Debug)]
struct Images {
    rows: BTreeMap<Key, Option<Vec<Value>>>,
    bytes: usize,
    invalid: bool,
}

#[derive(Clone, Default)]
pub(super) struct Capture(Arc<Mutex<Images>>);

fn key_columns(table: &str) -> Option<usize> {
    match table {
        "orchestration_waits"
        | "orchestration_outbox"
        | "orchestration_operations"
        | "orchestration_tasks"
        | "orchestration_session_schedules"
        | "orchestration_session_work_state"
        | "orchestration_extras" => Some(1),
        "orchestration_record_bodies" => Some(2),
        _ => None,
    }
}

fn size(value: ValueRef<'_>) -> usize {
    match value {
        ValueRef::Null => 0,
        ValueRef::Integer(_) | ValueRef::Real(_) => 8,
        ValueRef::Text(v) | ValueRef::Blob(v) => v.len(),
    }
}

fn key<'a>(
    count: usize,
    mut get: impl FnMut(i32) -> rusqlite::Result<ValueRef<'a>>,
) -> Option<Vec<String>> {
    (0..count)
        .map(|i| match get(i as i32).ok()? {
            ValueRef::Text(value) => std::str::from_utf8(value).ok().map(str::to_owned),
            _ => None,
        })
        .collect()
}

fn record(
    images: &mut Images,
    table: &str,
    key: Vec<String>,
    row: Option<Vec<Value>>,
    bytes: usize,
) {
    let map_key = (table.to_owned(), key);
    if images.rows.contains_key(&map_key) {
        return;
    }
    let added = bytes
        .saturating_add(map_key.0.len())
        .saturating_add(map_key.1.iter().map(String::len).sum::<usize>());
    if images.rows.len() >= MAX_ROWS || images.bytes.saturating_add(added) > MAX_BYTES {
        images.invalid = true;
        return;
    }
    images.bytes += added;
    images.rows.insert(map_key, row);
}

impl Capture {
    pub(super) fn install(&self, connection: &Connection) {
        let capture = self.clone();
        connection.preupdate_hook(Some(
            move |_action, database: &str, table: &str, change: &PreUpdateCase| {
                if database != "main" {
                    return;
                }
                let Some(key_count) = key_columns(table) else {
                    return;
                };
                let Ok(mut images) = capture.0.lock() else {
                    return;
                };
                if images.invalid {
                    return;
                }
                let result: Option<()> = (|| {
                    match change {
                        PreUpdateCase::Insert(new) => {
                            let new_key = key(key_count, |i| new.get_new_column_value(i))?;
                            record(&mut images, table, new_key, None, 0);
                        }
                        PreUpdateCase::Delete(old)
                        | PreUpdateCase::Update {
                            old_value_accessor: old,
                            ..
                        } => {
                            let old_key = key(key_count, |i| old.get_old_column_value(i))?;
                            if !images
                                .rows
                                .contains_key(&(table.to_owned(), old_key.clone()))
                            {
                                let count = old.get_column_count();
                                let mut bytes = 0usize;
                                for i in 0..count {
                                    bytes = bytes
                                        .saturating_add(size(old.get_old_column_value(i).ok()?));
                                }
                                if bytes > MAX_BYTES
                                    || images.bytes.saturating_add(bytes) > MAX_BYTES
                                {
                                    images.invalid = true;
                                    return Some(());
                                }
                                let row = (0..count)
                                    .map(|i| old.get_old_column_value(i).map(Value::from))
                                    .collect::<rusqlite::Result<Vec<_>>>()
                                    .ok()?;
                                record(&mut images, table, old_key.clone(), Some(row), bytes);
                            }
                            if let PreUpdateCase::Update {
                                new_value_accessor: new,
                                ..
                            } = change
                            {
                                let new_key = key(key_count, |i| new.get_new_column_value(i))?;
                                if new_key != old_key {
                                    record(&mut images, table, new_key, None, 0);
                                }
                            }
                        }
                        PreUpdateCase::Unknown => return None,
                    }
                    Some(())
                })();
                if result.is_none() {
                    images.invalid = true;
                }
            },
        ));
    }

    // Caller owns a short read transaction and must always call remove_views.
    pub(super) fn install_views(&self, connection: &Connection) -> rusqlite::Result<Vec<String>> {
        let images = self.0.lock().map_err(|_| rusqlite::Error::InvalidQuery)?;
        if images.invalid {
            return Err(rusqlite::Error::InvalidQuery);
        }
        let mut tables = Vec::new();
        let result = (|| {
            for table in images
                .rows
                .keys()
                .map(|(table, _)| table)
                .collect::<std::collections::BTreeSet<_>>()
            {
                let count = key_columns(table).ok_or(rusqlite::Error::InvalidQuery)?;
                let primary = if count == 2 {
                    vec!["collection", "record_key"]
                } else if table == "orchestration_extras" {
                    vec!["key"]
                } else if table == "orchestration_session_schedules"
                    || table == "orchestration_session_work_state"
                {
                    vec!["session_id"]
                } else {
                    vec!["id"]
                };
                let key_table = format!("__draft_keys_{table}");
                let row_table = format!("__draft_rows_{table}");
                let key_def = (0..count)
                    .map(|i| format!("k{i} TEXT NOT NULL"))
                    .collect::<Vec<_>>()
                    .join(",");
                let key_columns = (0..count)
                    .map(|i| format!("k{i}"))
                    .collect::<Vec<_>>()
                    .join(",");
                tables.push(table.clone());
                connection.execute_batch(&format!("CREATE TEMP TABLE {key_table} ({key_def}, PRIMARY KEY({key_columns})) WITHOUT ROWID; CREATE TEMP TABLE {row_table} AS SELECT * FROM main.{table} WHERE 0;"))?;
                for ((name, key), row) in &images.rows {
                    if name != table {
                        continue;
                    }
                    let placeholders = std::iter::repeat_n("?", key.len())
                        .collect::<Vec<_>>()
                        .join(",");
                    connection.execute(
                        &format!("INSERT INTO temp.{key_table} VALUES({placeholders})"),
                        params_from_iter(key),
                    )?;
                    if let Some(row) = row {
                        let placeholders = std::iter::repeat_n("?", row.len())
                            .collect::<Vec<_>>()
                            .join(",");
                        connection.execute(
                            &format!("INSERT INTO temp.{row_table} VALUES({placeholders})"),
                            params_from_iter(row),
                        )?;
                    }
                }
                let condition = primary
                    .iter()
                    .enumerate()
                    .map(|(i, column)| format!("k.k{i}=base.{column}"))
                    .collect::<Vec<_>>()
                    .join(" AND ");
                connection.execute_batch(&format!("CREATE TEMP VIEW {table} AS SELECT base.* FROM main.{table} AS base WHERE NOT EXISTS (SELECT 1 FROM {key_table} AS k WHERE {condition}) UNION ALL SELECT * FROM {row_table};"))?;
            }
            Ok(())
        })();
        if let Err(error) = result {
            Self::remove_views(connection, tables)?;
            return Err(error);
        }
        Ok(tables)
    }

    pub(super) fn remove_views(
        connection: &Connection,
        tables: Vec<String>,
    ) -> rusqlite::Result<()> {
        for table in tables.into_iter().rev() {
            let cleanup = connection.execute_batch(&format!("DROP VIEW IF EXISTS temp.{table}; DROP TABLE IF EXISTS temp.__draft_rows_{table}; DROP TABLE IF EXISTS temp.__draft_keys_{table};"));
            cleanup?;
        }
        Ok(())
    }

    pub(super) fn valid(&self) -> bool {
        self.0.lock().is_ok_and(|images| !images.invalid)
    }

    #[cfg(test)]
    fn with_views<T>(
        &self,
        connection: &Connection,
        run: impl FnOnce() -> rusqlite::Result<T>,
    ) -> rusqlite::Result<T> {
        let tables = self.install_views(connection)?;
        let result = run();
        Self::remove_views(connection, tables)?;
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn captures_first_preimage_of_without_rowid_mutations_and_rollbacks() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE orchestration_extras(key TEXT PRIMARY KEY,data_json TEXT NOT NULL) WITHOUT ROWID;
            INSERT INTO orchestration_extras VALUES('update','old'),('delete','gone'),('rollback','original');").unwrap();
        let capture = Capture::default();
        capture.install(&db);
        db.execute_batch("UPDATE orchestration_extras SET data_json='new' WHERE key='update';
            UPDATE orchestration_extras SET data_json='newer' WHERE key='update';
            DELETE FROM orchestration_extras WHERE key='delete';
            INSERT INTO orchestration_extras VALUES('insert','new');
            BEGIN; UPDATE orchestration_extras SET data_json='uncommitted' WHERE key='rollback'; ROLLBACK;").unwrap();
        let data = capture.0.lock().unwrap();
        let lookup = |key: &str| {
            data.rows
                .get(&("orchestration_extras".into(), vec![key.into()]))
                .unwrap()
        };
        assert!(!data.invalid);
        assert_eq!(
            lookup("update").as_ref().unwrap()[1],
            Value::Text("old".into())
        );
        assert_eq!(
            lookup("delete").as_ref().unwrap()[1],
            Value::Text("gone".into())
        );
        assert!(lookup("insert").is_none());
        assert_eq!(
            lookup("rollback").as_ref().unwrap()[1],
            Value::Text("original".into())
        );
        drop(data);
        capture
            .with_views(&db, || {
                let mut stmt =
                    db.prepare("SELECT key,data_json FROM orchestration_extras ORDER BY key")?;
                let rows = stmt
                    .query_map([], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                assert_eq!(
                    rows,
                    vec![
                        ("delete".into(), "gone".into()),
                        ("rollback".into(), "original".into()),
                        ("update".into(), "old".into())
                    ]
                );
                Ok(())
            })
            .unwrap();
        assert_eq!(
            db.query_row(
                "SELECT data_json FROM orchestration_extras WHERE key='update'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "newer"
        );
    }

    #[test]
    fn row_overlay_preserves_filtered_ordered_query_and_split_body() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(super::super::schema::SQL).unwrap();
        for table in ["waits", "outbox", "operations", "tasks"] {
            db.execute_batch(&format!(
                "ALTER TABLE orchestration_{table} ADD COLUMN body_ref INTEGER NOT NULL DEFAULT 0"
            ))
            .unwrap();
        }
        db.execute_batch("CREATE TABLE orchestration_record_bodies(collection TEXT NOT NULL,record_key TEXT NOT NULL,data_json TEXT NOT NULL,PRIMARY KEY(collection,record_key)) WITHOUT ROWID;
            INSERT INTO orchestration_outbox(id,data_json,session_id,state,sequence,body_ref) VALUES
            ('a','{\"id\":\"a\",\"sessionId\":\"s\",\"state\":\"pending\",\"sequence\":1}','s','pending',1,1),
            ('b','{\"id\":\"b\",\"sessionId\":\"s\",\"state\":\"pending\",\"sequence\":2}','s','pending',2,0);
            INSERT INTO orchestration_record_bodies VALUES('outbox','a','{\"id\":\"a\",\"sessionId\":\"s\",\"state\":\"pending\",\"sequence\":1,\"payload\":{\"message\":\"old\"}}');").unwrap();
        let input = json!({"collection":"outbox","options":{"where":{"sessionId":"s","state":"pending"},"orderBy":"sequence","limit":2},"overrides":[]});
        let expected = super::super::query::select(&db, &input, "select").unwrap();
        let capture = Capture::default();
        capture.install(&db);
        db.execute_batch("UPDATE orchestration_record_bodies SET data_json='{\"id\":\"a\",\"payload\":{\"message\":\"new\"}}' WHERE record_key='a';
            UPDATE orchestration_outbox SET state='delivered',data_json='{\"id\":\"b\",\"state\":\"delivered\"}' WHERE id='b';
            INSERT INTO orchestration_outbox(id,data_json,session_id,state,sequence) VALUES('c','{\"id\":\"c\",\"sessionId\":\"s\",\"state\":\"pending\",\"sequence\":3}','s','pending',3);").unwrap();
        capture
            .with_views(&db, || {
                let actual = super::super::query::select(&db, &input, "select").unwrap();
                assert_eq!(actual, expected);
                Ok(())
            })
            .unwrap();
        assert_ne!(
            super::super::query::select(&db, &input, "select").unwrap(),
            expected
        );
    }

    #[test]
    fn oversized_preimage_invalidates_only_the_snapshot() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE orchestration_extras(key TEXT PRIMARY KEY,data_json NOT NULL) WITHOUT ROWID;
            INSERT INTO orchestration_extras VALUES('large',zeroblob(16777217));").unwrap();
        let capture = Capture::default();
        capture.install(&db);
        db.execute(
            "UPDATE orchestration_extras SET data_json='new' WHERE key='large'",
            [],
        )
        .unwrap();
        assert!(!capture.valid());
        assert!(capture.install_views(&db).is_err());
        assert_eq!(
            db.query_row(
                "SELECT data_json FROM orchestration_extras WHERE key='large'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "new"
        );
    }
}
