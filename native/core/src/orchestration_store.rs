//! Row-owned orchestration storage. No whole-database object graph is retained.
//! The compatibility host holds transaction-local proxies; SQLite is authority.
mod activity;
mod legacy;
mod operation_admit;
mod operation_running;
mod outbox_recover;
mod query;
mod receipts;
mod record;
mod schedule_settle;
mod schema;
mod wait_cancel;

use crate::js::{from_serde, json_stringify};
use crate::orchestration_retention::{self, MaintenanceGuard, RetentionPolicy};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

pub type Result<T> = std::result::Result<T, String>;
pub const COLLECTIONS: [&str; 5] = ["waits", "outbox", "operations", "tasks", "sessionSchedules"];

fn claim_metadata(connection: &Connection) -> Result<Value> {
    let input = json!({"collection":"outbox","options":{
        "where":{"state":{"$nin":["delivered","dead-letter","cancelled"]}},
        "fields":["id","sessionId","state","sequence","availableAt","leasedUntil","attempts"]
    }});
    let mut result = query::select(connection, &input, "selectKeyed")?;
    let keys = result["keys"]
        .as_array()
        .ok_or_else(|| err("claim metadata keys missing"))?;
    let rows = result["rowsJson"]
        .as_array()
        .ok_or_else(|| err("claim metadata rows missing"))?;
    let mut leased = Vec::new();
    for (key, raw) in keys.iter().zip(rows) {
        let raw = raw
            .as_str()
            .ok_or_else(|| err("claim metadata row invalid"))?;
        if record::parse(raw)?.get("state") == Some(&crate::js::JsValue::string("leased")) {
            leased.push(key.clone());
        }
    }
    result["leasedKeys"] = json!(leased);
    Ok(result)
}
pub(super) fn err(e: impl std::fmt::Display) -> String {
    format!("ORCHESTRATION_SQLITE_ERROR:{e}")
}
pub(super) fn corrupt(message: impl std::fmt::Display) -> String {
    format!("ORCHESTRATION_STORE_CORRUPT:{message}")
}
pub(super) fn table(collection: &str) -> Result<(&'static str, &'static str)> {
    match collection {
        "waits" => Ok(("orchestration_waits", "id")),
        "outbox" => Ok(("orchestration_outbox", "id")),
        "operations" => Ok(("orchestration_operations", "id")),
        "tasks" => Ok(("orchestration_tasks", "id")),
        "sessionSchedules" => Ok(("orchestration_session_schedules", "session_id")),
        "extras" => Ok(("orchestration_extras", "key")),
        _ => Err(err("unknown orchestration collection")),
    }
}
pub(super) fn encode(value: &Value) -> Result<String> {
    json_stringify(&from_serde(value)).ok_or_else(|| err("value is not JSON serializable"))
}
pub(super) fn meta(connection: &Connection, key: &str) -> Result<Value> {
    let raw: Option<String> = connection
        .query_row(
            "SELECT value_json FROM orchestration_meta WHERE key=?1",
            [key],
            |row| row.get(0),
        )
        .optional()
        .map_err(err)?;
    serde_json::from_str(
        raw.as_deref()
            .ok_or_else(|| corrupt(format!("missing metadata {key}")))?,
    )
    .map_err(corrupt)
}
pub(super) fn set_meta(connection: &Connection, key: &str, value: &Value) -> Result<()> {
    connection.execute("INSERT INTO orchestration_meta(key,value_json) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",params![key,encode(value)?]).map_err(err)?;
    Ok(())
}
pub(super) fn header(connection: &Connection) -> Result<Value> {
    let value = json!({"schemaVersion":meta(connection,"stateSchemaVersion")?,"revision":meta(connection,"revision")?,"updatedAt":meta(connection,"updatedAt")?,"nextOutboxSequence":meta(connection,"nextOutboxSequence")?});
    if value["schemaVersion"] != 3
        || !value["revision"]
            .as_u64()
            .is_some_and(|n| n <= 9_007_199_254_740_991)
        || !value["nextOutboxSequence"]
            .as_u64()
            .is_some_and(|n| (1..=9_007_199_254_740_991).contains(&n))
    {
        return Err(corrupt("invalid orchestration metadata"));
    }
    Ok(value)
}
pub(super) fn private(path: &Path) -> Result<()> {
    #[cfg(not(unix))]
    let _ = path;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(err)?;
    }
    Ok(())
}
fn private_files(file: &Path) -> Result<()> {
    private(file)?;
    for suffix in ["-wal", "-shm"] {
        let path = PathBuf::from(format!("{}{suffix}", file.display()));
        if path.exists() {
            private(&path)?;
        }
    }
    Ok(())
}
fn validate(connection: &Connection) -> Result<()> {
    let check: String = connection
        .query_row("PRAGMA quick_check", [], |r| r.get(0))
        .map_err(corrupt)?;
    if check != "ok" {
        return Err(corrupt(format!("SQLite quick_check: {check}")));
    }
    let schema_version = meta(connection, "databaseSchemaVersion")?;
    if schema_version != 1 && schema_version != 2 {
        return Err(corrupt("unsupported orchestration SQLite schema"));
    }
    for (name, columns) in [
        ("orchestration_meta", &["key", "value_json"][..]),
        ("orchestration_extras", &["key", "data_json"]),
        (
            "orchestration_waits",
            &[
                "id",
                "data_json",
                "session_id",
                "status",
                "next_at",
                "updated_at",
            ],
        ),
        (
            "orchestration_outbox",
            &[
                "id",
                "data_json",
                "session_id",
                "state",
                "sequence",
                "available_at",
                "leased_until",
                "updated_at",
            ],
        ),
        (
            "orchestration_operations",
            &[
                "id",
                "data_json",
                "kind",
                "owner_session_id",
                "status",
                "updated_at",
            ],
        ),
        (
            "orchestration_tasks",
            &[
                "id",
                "data_json",
                "parent_session_id",
                "status",
                "updated_at",
            ],
        ),
        (
            "orchestration_session_schedules",
            &["session_id", "data_json", "state", "updated_at"],
        ),
    ] {
        let mut stmt = connection
            .prepare(&format!("PRAGMA table_info({name})"))
            .map_err(corrupt)?;
        let actual: Vec<String> = stmt
            .query_map([], |r| r.get(1))
            .map_err(corrupt)?
            .collect::<std::result::Result<_, _>>()
            .map_err(corrupt)?;
        if columns
            .iter()
            .any(|column| !actual.iter().any(|c| c == column))
        {
            return Err(corrupt(format!(
                "orchestration table/columns missing: {name}"
            )));
        }
    }
    for (index, table, columns, unique) in [
        (
            "idx_orchestration_waits_due",
            "orchestration_waits",
            &["status", "next_at"][..],
            false,
        ),
        (
            "idx_orchestration_waits_session",
            "orchestration_waits",
            &["session_id", "status"],
            false,
        ),
        (
            "idx_orchestration_outbox_sequence",
            "orchestration_outbox",
            &["sequence"],
            true,
        ),
        (
            "idx_orchestration_outbox_due",
            "orchestration_outbox",
            &["state", "available_at", "sequence"],
            false,
        ),
        (
            "idx_orchestration_outbox_session",
            "orchestration_outbox",
            &["session_id", "state", "sequence"],
            false,
        ),
        (
            "idx_orchestration_operations_owner",
            "orchestration_operations",
            &["owner_session_id", "status", "kind"],
            false,
        ),
        (
            "idx_orchestration_tasks_parent",
            "orchestration_tasks",
            &["parent_session_id", "status"],
            false,
        ),
        (
            "idx_orchestration_schedules_state",
            "orchestration_session_schedules",
            &["state", "updated_at"],
            false,
        ),
    ] {
        let mut stmt = connection
            .prepare(&format!("PRAGMA index_list({table})"))
            .map_err(corrupt)?;
        let actual: Vec<(String, bool)> = stmt
            .query_map([], |r| Ok((r.get(1)?, r.get(2)?)))
            .map_err(corrupt)?
            .collect::<std::result::Result<_, _>>()
            .map_err(corrupt)?;
        let mut info = connection
            .prepare(&format!("PRAGMA index_info({index})"))
            .map_err(corrupt)?;
        let found: Vec<String> = info
            .query_map([], |r| r.get(2))
            .map_err(corrupt)?
            .collect::<std::result::Result<_, _>>()
            .map_err(corrupt)?;
        if !actual.iter().any(|(name, u)| name == index && *u == unique)
            || found.iter().map(String::as_str).collect::<Vec<_>>() != columns
        {
            return Err(corrupt(format!("orchestration index invalid: {index}")));
        }
    }
    header(connection)?;
    if schema_version == 2 {
        receipts::validate(connection)?;
    }
    Ok(())
}
pub(super) fn write_record_json(
    connection: &Connection,
    collection: &str,
    key: &str,
    data: &str,
) -> Result<usize> {
    let parsed = record::parse(data)?;
    // Normalize one record so duplicate JSON properties and escaped key names
    // have the same meaning in SQLite JSON paths and the shared JS parser.
    let data = record::encode(&parsed)?;
    let receipt = receipts::receipt(collection, &parsed)?;
    let value = record::index_fields(&parsed)?;
    let field = |name: &str| query::sql_value(&value[name]);
    let sql;
    let mut values = vec![
        rusqlite::types::Value::Text(key.into()),
        rusqlite::types::Value::Text(receipt.as_ref().unwrap_or(&data).clone()),
    ];
    match collection {
        "waits" => {
            sql="INSERT INTO orchestration_waits(id,data_json,session_id,status,next_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json,session_id=excluded.session_id,status=excluded.status,next_at=excluded.next_at,updated_at=excluded.updated_at";
            values.extend([
                field("sessionId"),
                field("status"),
                query::sql_value(
                    value["metadata"]
                        .get("nextAt")
                        .filter(|v| !v.is_null())
                        .or_else(|| value["metadata"].get("dueAt").filter(|v| !v.is_null()))
                        .or_else(|| value["metadata"].get("expireAt").filter(|v| !v.is_null()))
                        .unwrap_or(&Value::Null),
                ),
                field("updatedAt"),
            ]);
        }
        "outbox" => {
            sql="INSERT INTO orchestration_outbox(id,data_json,session_id,state,sequence,available_at,leased_until,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json,session_id=excluded.session_id,state=excluded.state,sequence=excluded.sequence,available_at=excluded.available_at,leased_until=excluded.leased_until,updated_at=excluded.updated_at";
            values.extend([
                field("sessionId"),
                field("state"),
                field("sequence"),
                field("availableAt"),
                field("leasedUntil"),
                field("updatedAt"),
            ]);
        }
        "operations" => {
            sql="INSERT INTO orchestration_operations(id,data_json,kind,owner_session_id,status,updated_at) VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json,kind=excluded.kind,owner_session_id=excluded.owner_session_id,status=excluded.status,updated_at=excluded.updated_at";
            values.extend([
                field("kind"),
                field("ownerSessionId"),
                field("status"),
                field("updatedAt"),
            ]);
        }
        "tasks" => {
            sql="INSERT INTO orchestration_tasks(id,data_json,parent_session_id,status,updated_at) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json,parent_session_id=excluded.parent_session_id,status=excluded.status,updated_at=excluded.updated_at";
            values.extend([
                field("parentSessionId"),
                field("status"),
                field("updatedAt"),
            ]);
        }
        "sessionSchedules" => {
            sql="INSERT INTO orchestration_session_schedules(session_id,data_json,state,updated_at) VALUES (?1,?2,?3,?4) ON CONFLICT(session_id) DO UPDATE SET data_json=excluded.data_json,state=excluded.state,updated_at=excluded.updated_at";
            values.extend([field("state"), field("updatedAt")]);
        }
        "extras" => {
            sql="INSERT INTO orchestration_extras(key,data_json) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET data_json=excluded.data_json";
        }
        _ => return Err(err("invalid collection")),
    }
    connection
        .execute(sql, rusqlite::params_from_iter(values))
        .map_err(err)?;
    receipts::store_body(
        connection,
        collection,
        key,
        receipt.as_ref().map(|_| data.as_str()),
    )?;
    Ok(data.len())
}

pub struct Store {
    connection: Option<Connection>,
    file: PathBuf,
    guard: Option<MaintenanceGuard>,
    active: bool,
    snapshot_data_version: Option<i64>,
    pending: bool,
    redacted: bool,
    policy: RetentionPolicy,
    next_retention_at: i64,
    next_capacity_check_at: i64,
    next_compact_at: i64,
    metrics: Map<String, Value>,
    migration: Value,
    commit_started: Option<Instant>,
    pending_rows: usize,
    pending_bytes: usize,
    indexes_ready: bool,
}
impl Store {
    pub fn open(
        file: &str,
        legacy_file: Option<&str>,
        now: i64,
        policy: RetentionPolicy,
    ) -> Result<Self> {
        policy.validate().map_err(err)?;
        let file = PathBuf::from(file);
        if let Some(parent) = file.parent() {
            fs::create_dir_all(parent).map_err(err)?;
        }
        let guard = MaintenanceGuard::shared(&file).map_err(err)?;
        let started = Instant::now();
        let migration = if !file.exists() {
            legacy::create(&file, legacy_file.map(Path::new), now)?
        } else {
            json!({"migrated":false,"legacyDigest":null})
        };
        let file = fs::canonicalize(&file).map_err(err)?;
        private(&file)?;
        let connection = Connection::open(&file).map_err(corrupt)?;
        connection
            .busy_timeout(Duration::from_millis(4000))
            .map_err(err)?;
        connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; PRAGMA wal_autocheckpoint=1000; PRAGMA journal_size_limit=0;").map_err(err)?;
        validate(&connection)?;
        let upgraded = receipts::upgrade(&connection)?;
        private_files(&file)?;
        let mut metrics = Map::new();
        for key in [
            "mutations_total",
            "noops_total",
            "conflicts_total",
            "dirty_rows_total",
            "serialized_bytes_total",
            "materialized_bytes_total",
            "redaction_checkpoints_total",
            "commit_ms_total",
            "commit_ms_max",
            "migration_ms",
        ] {
            metrics.insert(format!("multicc_orchestration_sqlite_{key}"), json!(0));
        }
        metrics.insert(
            "multicc_orchestration_sqlite_migration_ms".into(),
            json!(started.elapsed().as_secs_f64() * 1000.0),
        );
        Ok(Self {
            connection: Some(connection),
            file,
            guard: Some(guard),
            active: false,
            snapshot_data_version: None,
            pending: false,
            redacted: false,
            policy,
            next_retention_at: 0,
            next_capacity_check_at: 0,
            next_compact_at: 0,
            metrics,
            migration: {
                let mut value = migration;
                value["receiptSchemaUpgraded"] = json!(upgraded);
                value
            },
            commit_started: None,
            pending_rows: 0,
            pending_bytes: 0,
            indexes_ready: false,
        })
    }
    fn conn(&self) -> Result<&Connection> {
        self.connection
            .as_ref()
            .ok_or_else(|| err("orchestration database is closed"))
    }
    fn add(&mut self, key: &str, amount: f64) {
        let key = format!("multicc_orchestration_sqlite_{key}");
        let old = self.metrics[&key].as_f64().unwrap_or(0.0);
        self.metrics.insert(key, json!(old + amount));
    }
    pub fn end(&mut self) -> Result<()> {
        if self.active || self.pending {
            self.conn()?.execute_batch("ROLLBACK").map_err(err)?;
        }
        self.active = false;
        self.pending = false;
        self.snapshot_data_version = None;
        Ok(())
    }
    fn inspect(&mut self, input: &Value) -> Result<Value> {
        let collection = input["collection"]
            .as_str()
            .ok_or_else(|| err("collection required"))?;
        let key = input["key"]
            .as_str()
            .ok_or_else(|| err("record key required"))?;
        let parts = record::path(input)?;
        let (table, column) = table(collection)?;
        if let Some(path) = record::sql_path(&parts)? {
            // Compaction only replaces an object with another object. Merely
            // opening the record proxy must not fetch its large original.
            let source = if parts.is_empty() {
                format!("{table}.data_json")
            } else {
                receipts::path_source(collection, &parts)?
            };
            let sql=format!("SELECT json_type({source},?1), CASE WHEN json_type({source},?1)='array' THEN CAST(json_array_length({source},?1) AS TEXT) WHEN json_type({source},?1)='object' THEN NULL ELSE {source} -> ?1 END FROM {table} WHERE {column}=?2");
            let answer: Option<(Option<String>, Option<String>)> = self
                .conn()?
                .query_row(&sql, params![path, key], |r| Ok((r.get(0)?, r.get(1)?)))
                .optional()
                .map_err(corrupt)?;
            let Some((Some(kind), raw)) = answer else {
                return Ok(json!({"kind":"missing"}));
            };
            return match kind.as_str() {
                "object" => Ok(json!({"kind":"object"})),
                "array" => Ok(
                    json!({"kind":"array","length":raw.and_then(|n|n.parse::<usize>().ok()).unwrap_or(0)}),
                ),
                _ => {
                    let raw = raw.ok_or_else(|| corrupt("missing JSON scalar"))?;
                    self.add("materialized_bytes_total", raw.len() as f64);
                    Ok(json!({"kind":"value","valueJson":raw}))
                }
            };
        }
        let Some(raw) = record::get_json(self.conn()?, collection, key, &parts)? else {
            return Ok(json!({"kind":"missing"}));
        };
        record::describe(&record::parse(&raw)?)
    }
    fn keys(&self, input: &Value) -> Result<Value> {
        let collection = input["collection"]
            .as_str()
            .ok_or_else(|| err("collection required"))?;
        if let Some(key) = input["key"].as_str() {
            let parts = record::path(input)?;
            let raw = record::get_json(self.conn()?, collection, key, &parts)?
                .unwrap_or_else(|| "null".into());
            Ok(json!({"keysJson":record::keys(&raw)?}))
        } else {
            let (table, column) = table(collection)?;
            let mut stmt = self
                .conn()?
                .prepare(&format!("SELECT {column} FROM {table} ORDER BY {column}"))
                .map_err(err)?;
            let keys: Vec<String> = stmt
                .query_map([], |r| r.get(0))
                .map_err(err)?
                .collect::<std::result::Result<_, _>>()
                .map_err(err)?;
            Ok(json!(keys))
        }
    }
    fn materialize(&mut self, input: &Value) -> Result<Value> {
        let collection = input["collection"]
            .as_str()
            .ok_or_else(|| err("collection required"))?;
        let key = input["key"].as_str().ok_or_else(|| err("key required"))?;
        if let Some(raw) = record::get_json(self.conn()?, collection, key, &[])? {
            self.add("materialized_bytes_total", raw.len() as f64);
            Ok(json!({"found":true,"valueJson":raw}))
        } else {
            Ok(json!({"found":false}))
        }
    }
    fn prepare(&mut self, input: &Value) -> Result<Value> {
        let snapshot_data_version = self.snapshot_data_version;
        self.end()?;
        self.conn()?.execute_batch("BEGIN IMMEDIATE").map_err(err)?;
        self.pending = true;
        let actual = meta(self.conn()?, "revision")?;
        let data_version: i64 = self
            .conn()?
            .query_row("PRAGMA data_version", [], |row| row.get(0))
            .map_err(err)?;
        if actual.as_f64() != input["expectedRevision"].as_f64()
            || snapshot_data_version.is_some_and(|version| version != data_version)
        {
            self.end()?;
            self.add("conflicts_total", 1.0);
            return Err(format!(
                "ORCHESTRATION_SQLITE_CONFLICT:{}:{}",
                input["expectedRevision"], actual
            ));
        }
        self.commit_started = Some(Instant::now());
        self.redacted = false;
        let mut count = 0;
        let mut bytes = 0;
        for entry in input["changes"]
            .as_array()
            .ok_or_else(|| err("changes required"))?
        {
            let collection = entry["collection"]
                .as_str()
                .ok_or_else(|| err("collection required"))?;
            let key = entry["key"]
                .as_str()
                .ok_or_else(|| err("record key required"))?;
            let (table, column) = table(collection)?;
            if entry["deleted"] == true {
                self.conn()?
                    .execute(&format!("DELETE FROM {table} WHERE {column}=?1"), [key])
                    .map_err(err)?;
            } else {
                let raw = entry["valueJson"]
                    .as_str()
                    .ok_or_else(|| err("record JSON required"))?;
                if matches!(collection, "outbox" | "operations") {
                    let field = if collection == "outbox" {
                        "payload"
                    } else {
                        "spec"
                    };
                    let parsed = record::parse(raw)?;
                    let after = parsed.get(field);
                    if after
                        .and_then(|v| v.get("messageRef"))
                        .is_some_and(crate::js::truthy)
                    {
                        for name in ["message", "taskText"] {
                            if after.and_then(|v| v.get(name)).is_none() {
                                let source = receipts::json_source(collection, None)?;
                                let before:bool=self.conn()?.query_row(&format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE {column}=?1 AND json_type({source},'$.{field}.{name}') IS NOT NULL)"),[key],|r|r.get(0)).map_err(err)?;
                                self.redacted |= before;
                            }
                        }
                    }
                }
                bytes += write_record_json(self.conn()?, collection, key, raw)?;
            }
            count += 1;
        }
        for (key, field) in [
            ("stateSchemaVersion", "schemaVersion"),
            ("revision", "revision"),
            ("updatedAt", "updatedAt"),
            ("nextOutboxSequence", "nextOutboxSequence"),
        ] {
            set_meta(self.conn()?, key, &input["state"][field])?;
        }
        header(self.conn()?)?;
        self.pending_rows = count;
        self.pending_bytes = bytes;
        Ok(json!({"prepared":true}))
    }
    pub fn request(&mut self, op: &str, input: &Value) -> Result<Value> {
        match op {
            "info" => Ok(json!({"state":header(self.conn()?)?,"migration":self.migration})),
            "begin" => {
                self.end()?;
                let data_version = self
                    .conn()?
                    .query_row("PRAGMA data_version", [], |row| row.get(0))
                    .map_err(err)?;
                self.conn()?.execute_batch("BEGIN").map_err(err)?;
                self.active = true;
                self.snapshot_data_version = Some(data_version);
                header(self.conn()?)
            }
            "end" => {
                self.end()?;
                Ok(Value::Null)
            }
            "inspect" => self.inspect(input),
            "keys" => self.keys(input),
            "materialize" => self.materialize(input),
            "claimMetadata" => {
                if !self.active {
                    return Err(err("claim metadata requires a read transaction"));
                }
                claim_metadata(self.conn()?)
            }
            "waitCancelCheck" => wait_cancel::check(self.conn()?, input),
            "scheduleSettlePlan" => schedule_settle::plan(self.conn()?, input),
            "scheduleSettleCommit" => {
                let result = schedule_settle::commit(self, input);
                if result.is_err() {
                    let _ = self.end();
                }
                result
            }
            "operationAdmitPlan" => {
                let result = operation_admit::plan(self, input);
                if result.is_err() {
                    let _ = self.end();
                }
                result
            }
            "operationAdmit" => {
                let result = operation_admit::commit(self, input);
                if result.is_err() {
                    let _ = self.end();
                }
                result
            }
            "operationRunningPlan" => operation_running::plan(self.conn()?, input),
            "outboxRecoverPlan" => outbox_recover::plan(self.conn()?, input),
            "outboxRecoverCommit" => {
                let result = outbox_recover::commit(self, input);
                if result.is_err() {
                    let _ = self.end();
                }
                result
            }
            "operationRunningCommit" => {
                let result = operation_running::commit(self, input);
                if result.is_err() {
                    let _ = self.end();
                }
                result
            }
            "waitCancelCommit" => {
                let result = wait_cancel::commit(self, input);
                if result.is_err() {
                    let _ = self.end();
                }
                result
            }
            "select" | "selectKeys" | "count" => {
                let result = query::select(self.conn()?, input, op)?;
                self.add("materialized_bytes_total", encode(&result)?.len() as f64);
                Ok(result)
            }
            "prepare" => {
                let result = self.prepare(input);
                if result.is_err() {
                    let _ = self.end();
                }
                result
            }
            "commit" => {
                if !self.pending {
                    return Err(err("no prepared orchestration commit"));
                }
                self.conn()?.execute_batch("COMMIT").map_err(err)?;
                self.pending = false;
                self.add("mutations_total", 1.0);
                self.add("dirty_rows_total", self.pending_rows as f64);
                self.add("serialized_bytes_total", self.pending_bytes as f64);
                if self.redacted {
                    self.conn()?
                        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
                        .map_err(err)?;
                    self.add("redaction_checkpoints_total", 1.0);
                }
                private_files(&self.file)?;
                let ms = self
                    .commit_started
                    .take()
                    .map_or(0.0, |at| at.elapsed().as_secs_f64() * 1000.0);
                self.add("commit_ms_total", ms);
                let key = "multicc_orchestration_sqlite_commit_ms_max";
                let max = self.metrics[key].as_f64().unwrap_or(0.0).max(ms);
                self.metrics.insert(key.into(), json!(max));
                Ok(json!({"redacted":self.redacted,"state":header(self.conn()?)?}))
            }
            "noop" => {
                self.add("noops_total", 1.0);
                Ok(Value::Null)
            }
            "metrics" => Ok(Value::Object(self.metrics.clone())),
            "checkpoint" => {
                self.end()?;
                self.conn()?
                    .execute_batch("PRAGMA wal_checkpoint(FULL)")
                    .map_err(err)?;
                private_files(&self.file)?;
                Ok(Value::Null)
            }
            "export" => {
                self.end()?;
                let target = Path::new(
                    input["file"]
                        .as_str()
                        .ok_or_else(|| err("export target required"))?,
                );
                validate_export_target(&self.file, target)?;
                legacy::export(self.conn()?, target)
            }
            "retention" => self.retention(input),
            "taskActivity" => {
                self.end()?;
                activity::task_activity(self.conn()?, input)
            }
            "compact" => {
                self.end()?;
                let limit = input.get("limit").map_or(Ok(500), |value| {
                    value
                        .as_u64()
                        .and_then(|v| usize::try_from(v).ok())
                        .ok_or_else(|| err("compact limit must be an integer"))
                })?;
                receipts::compact(self.conn()?, limit)
            }
            "close" | "closeShared" => {
                let mut result = self.end();
                if let Some(connection) = self.connection.take() {
                    // Another session in the same owner may hold a read
                    // snapshot. TRUNCATE would wait for that session while the
                    // serial owner cannot service its next command. The last
                    // session still performs the ordinary close checkpoint.
                    let checkpoint = if op == "close" {
                        connection
                            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
                            .map_err(err)
                    } else {
                        Ok(())
                    };
                    let close = connection.close().map_err(|(_, e)| err(e));
                    result = result.and(checkpoint).and(close);
                }
                result = result.and(private_files(&self.file));
                self.guard.take();
                result?;
                Ok(Value::Null)
            }
            _ => Err(err("unknown orchestration store operation")),
        }
    }
    fn retention(&mut self, input: &Value) -> Result<Value> {
        self.end()?;
        let now = input["now"]
            .as_f64()
            .filter(|n| n.is_finite())
            .ok_or_else(|| err("retention clock required"))? as i64;
        if input["apply"] != true {
            return serde_json::to_value(
                orchestration_retention::report(self.conn()?, &self.policy, now).map_err(err)?,
            )
            .map_err(err);
        }
        // Storage compaction does not remove domain records and remains useful
        // even when expiry is disabled. All scheduling and batches stay native.
        let compact = if now >= self.next_compact_at {
            self.next_compact_at = now.saturating_add(60_000);
            let result = receipts::compact(self.conn()?, self.policy.batch_size)?;
            if result["complete"] == true {
                self.next_compact_at = i64::MAX;
            } else if result["scannedRecords"].as_u64().unwrap_or(0) > 0 {
                self.next_compact_at = now.saturating_add(1000);
            }
            Some(result)
        } else {
            None
        };
        let next_compact_at = self.next_compact_at;
        let with_compact = |mut result: Value| {
            if let Some(compact) = &compact {
                result["compact"] = compact.clone();
                if compact["scannedRecords"].as_u64().unwrap_or(0) > 0 {
                    result["skipped"] = json!(false);
                }
            }
            if next_compact_at < i64::MAX {
                result["nextRunAt"] = json!(result["nextRunAt"]
                    .as_i64()
                    .map_or(next_compact_at, |next| next.min(next_compact_at)));
            }
            result
        };
        if !self.policy.enabled {
            return Ok(with_compact(
                json!({"skipped":true,"enabled":false,"nextRunAt":null}),
            ));
        }
        if now < self.next_retention_at && now < self.next_capacity_check_at {
            return Ok(with_compact(
                json!({"skipped":true,"nextRunAt":self.next_retention_at.min(self.next_capacity_check_at)}),
            ));
        }
        // The capacity probe is independent of the hourly expiry sweep. Back
        // off on errors/protected-only batches rather than spinning every tick.
        self.next_capacity_check_at = now.saturating_add(60_000);
        if !self.indexes_ready {
            orchestration_retention::install_indexes(self.conn()?).map_err(err)?;
            self.indexes_ready = true;
        }
        let capacity =
            orchestration_retention::capacity_excess(self.conn()?, &self.policy).map_err(err)?;
        if now < self.next_retention_at && capacity == 0 {
            return Ok(with_compact(
                json!({"skipped":true,"nextRunAt":self.next_retention_at.min(self.next_capacity_check_at)}),
            ));
        }
        self.next_retention_at = now.saturating_add(self.policy.interval_ms);
        let connection = self
            .connection
            .as_mut()
            .ok_or_else(|| err("database closed"))?;
        let report =
            orchestration_retention::prune_batch(connection, &self.policy, now).map_err(err)?;
        if report.capacity_triggered && report.deleted_tasks + report.deleted_outbox > 0 {
            self.next_capacity_check_at = now.saturating_add(1000);
        }
        let mut result = serde_json::to_value(report).map_err(err)?;
        result["nextRunAt"] = json!(self.next_retention_at.min(self.next_capacity_check_at));
        Ok(with_compact(result))
    }
}

/// Read-only export for offline rollback tooling; no schema writes or retention indexes.
pub fn export_snapshot(file: &str, target: &str) -> Result<Value> {
    let _guard = MaintenanceGuard::shared(Path::new(file)).map_err(err)?;
    validate_export_target(Path::new(file), Path::new(target))?;
    let conn = Connection::open_with_flags(file, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(err)?;
    validate(&conn)?;
    let mut result = legacy::export(&conn, Path::new(target))?;
    result["databaseFile"] = json!(file);
    result["targetFile"] = json!(target);
    Ok(result)
}

fn absolute_target(path: &Path) -> Result<PathBuf> {
    if path.exists() {
        return fs::canonicalize(path).map_err(err);
    }
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).map_err(err)?;
    Ok(fs::canonicalize(parent)
        .map_err(err)?
        .join(path.file_name().ok_or_else(|| err("invalid export path"))?))
}

/// A rollback snapshot must never replace its live SQLite source or sidecars.
fn validate_export_target(source: &Path, target: &Path) -> Result<()> {
    let source = fs::canonicalize(source).map_err(err)?;
    let target_path = absolute_target(target)?;
    for suffix in ["", "-wal", "-shm", "-journal", ".maintenance.lock"] {
        let protected = PathBuf::from(format!("{}{suffix}", source.display()));
        if protected == target_path {
            return Err(err("export target overlaps the orchestration database"));
        }
        #[cfg(unix)]
        if let (Ok(a), Ok(b)) = (fs::metadata(&protected), fs::metadata(target)) {
            use std::os::unix::fs::MetadataExt;
            if a.dev() == b.dev() && a.ino() == b.ino() {
                return Err(err("export target aliases the orchestration database"));
            }
        }
    }
    Ok(())
}
