//! Read the external CC-Switch catalog without creating or changing its database.
use rusqlite::{Connection, OpenFlags};
use serde_json::{Map, Value};
use std::{path::Path, time::Duration};

pub fn available() -> bool {
    Connection::open_in_memory()
        .and_then(|db| db.close().map_err(|(_, e)| e))
        .is_ok()
}

pub enum ReadError {
    Missing,
    Open(rusqlite::Error),
    Query(rusqlite::Error),
}

pub fn read(path: &Path) -> Result<Vec<Value>, ReadError> {
    if !path.exists() {
        return Err(ReadError::Missing);
    }
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(ReadError::Open)?;
    db.busy_timeout(Duration::from_secs(4))
        .map_err(ReadError::Open)?;
    let query = || -> rusqlite::Result<Vec<Value>> {
        let columns = ["id", "app_type", "name", "settings_config", "meta"];
        let has_meta: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('providers') WHERE name='meta')",
            [],
            |r| r.get(0),
        )?;
        let meta = if has_meta { "meta" } else { "NULL AS meta" };
        let mut stmt = db.prepare(&format!("SELECT id, app_type, name, settings_config, {meta} FROM providers ORDER BY app_type, sort_index, name"))?;
        let rows = stmt.query_map([], |row| {
            let mut obj = Map::new();
            for (index, key) in columns.iter().enumerate() {
                let value = match row.get_ref(index)? {
                    rusqlite::types::ValueRef::Null => Value::Null,
                    rusqlite::types::ValueRef::Text(s) => {
                        String::from_utf8_lossy(s).into_owned().into()
                    }
                    rusqlite::types::ValueRef::Integer(n) => n.into(),
                    rusqlite::types::ValueRef::Real(n) => n.into(),
                    rusqlite::types::ValueRef::Blob(b) => {
                        serde_json::json!({"type":"Buffer","data":b})
                    }
                };
                obj.insert(key.to_string(), value);
            }
            Ok(Value::Object(obj))
        })?;
        rows.collect()
    };
    query().map_err(ReadError::Query)
}
