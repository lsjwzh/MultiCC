//! Row-owned orchestration storage. No whole-database object graph is retained.
//! The compatibility host holds transaction-local proxies; SQLite is authority.
mod activity;
mod draft_cow;
mod legacy;
mod operation_admit;
mod operation_running;
mod outbox_recover;
mod query;
pub mod queue_preview;
mod receipts;
mod record;
mod schedule_admit;
mod schedule_admit_live;
pub use schedule_admit_live::project_schedule;
pub mod schedule_background;
mod schedule_claim;
pub mod schedule_guard;
mod schedule_identity;
mod schedule_metadata;
mod schedule_recover;
pub use schedule_recover::transition as recover_schedule_transition;
mod schedule_settle;
mod schema;
mod session_work_state;
mod wait_cancel;
pub mod wakeup;

use crate::js::{from_serde, json_stringify};
use crate::orchestration_retention::{self, MaintenanceGuard, RetentionPolicy};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

pub type Result<T> = std::result::Result<T, String>;
pub const COLLECTIONS: [&str; 5] = ["waits", "outbox", "operations", "tasks", "sessionSchedules"];

// A bounded owner-side record of observations made by a detached draft. The
// immutable in-memory draft transport is not wired to production yet.
struct DraftFootprint {
    token: String,
    collecting: bool,
    read_only: bool,
    data_version: i64,
    state: Value,
    reads: Vec<(String, Value, [u8; 32])>,
    read_keys: HashSet<(String, String)>,
    header_reads: Vec<String>,
    bytes: usize,
    snapshot: draft_cow::Capture,
}
/// The ledger's own terminal vocabulary for a task or operation row, mirroring
/// `TERMINAL_TASK_STATES` in `src/operation-service.js`. Anything that needs to
/// know "did this task already settle" reads these words instead of inventing a
/// second list: `receipts`, `operation_running` and the background-task nudge
/// gate (`background::settled`) all resolve here.
pub const TERMINAL_TASK_STATES: [&str; 4] = ["completed", "failed", "interrupted", "cancelled"];

/// `TERMINAL_TASK_STATES.has(status)` for a plain status string.
pub fn is_terminal_task_status(status: &str) -> bool {
    TERMINAL_TASK_STATES.contains(&status)
}

/// Rebuild the queue dock's reconnect frame from one coherent SQLite read.
/// Reconnecting never creates a schedule, takes a delivery lease or retries work.
pub fn chat_queue_snapshot(file: &Path, session: &str) -> Result<crate::js::JsValue> {
    use crate::js::JsValue as V;
    let empty = || {
        V::object(vec![
            ("state", V::from("idle")),
            ("freezeReason", V::Null),
            ("active", V::Null),
            ("queued", V::Array(Vec::new())),
        ])
    };
    let schedule = if file.try_exists().map_err(err)? {
        let db = Connection::open_with_flags(file, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(err)?;
        db.busy_timeout(Duration::from_millis(4000)).map_err(err)?;
        db.execute_batch("BEGIN DEFERRED").map_err(err)?;
        let schedule = record::get_json(&db, "sessionSchedules", session, &[])?
            .map(|raw| record::parse(&raw))
            .transpose()?
            .filter(crate::js::truthy)
            .unwrap_or_else(empty);
        let queue = schedule_admit_live::queue_rows(&db, session, &schedule)?;
        schedule_admit_live::public_schedule(&db, &schedule, &queue)?
    } else {
        empty()
    };
    let property = |key| schedule.get(key).cloned().unwrap_or(V::Undefined);
    let items = property("queued");
    let count = match &items {
        V::Array(items) => items.len(),
        _ => 0,
    };
    Ok(V::object(vec![
        ("type", V::from("session_queue")),
        ("event", V::from("snapshot")),
        ("state", property("state")),
        ("queued", V::Number(count as f64)),
        ("items", items),
        ("freezeReason", property("freezeReason")),
        ("active", property("active")),
    ]))
}

/// Read the authoritative question even when the session has no active worker.
pub fn chat_question_snapshot(file: &Path, session: &str) -> Result<Option<Value>> {
    if !file.try_exists().map_err(err)? {
        return Ok(None);
    }
    let db = Connection::open_with_flags(file, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(err)?;
    db.busy_timeout(Duration::from_millis(4000)).map_err(err)?;
    // Old stores can be read before the first native write upgrades the schema.
    let table: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='orchestration_session_work_state')",
        [], |row| row.get(0),
    ).map_err(err)?;
    if !table {
        let initialized: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM orchestration_meta WHERE key='sessionWorkStateSchema')",
            [], |row| row.get(0),
        ).map_err(err)?;
        if initialized {
            return Err(corrupt("initialized session work state table missing"));
        }
        return Ok(None);
    }
    let snapshot = session_work_state::encoded_read(&db, &json!({"sessionId":session}))?;
    Ok((snapshot["exists"] == true).then_some(snapshot))
}

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
    schedule_metadata_scan: Option<schedule_metadata::Scan>,
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
    scheduler_cache: Option<Arc<crate::scheduler_read_model::Cache>>,
    draft_footprint: Option<DraftFootprint>,
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
        session_work_state::initialize(&connection)?;
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
            schedule_metadata_scan: None,
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
            scheduler_cache: None,
            draft_footprint: None,
        })
    }
    pub(crate) fn attach_scheduler_cache(
        &mut self,
        cache: Arc<crate::scheduler_read_model::Cache>,
    ) {
        self.scheduler_cache = Some(cache);
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
    fn clear_draft_footprint(&mut self) {
        if self.draft_footprint.take().is_some() {
            if let Some(connection) = &self.connection {
                connection.preupdate_hook(None::<fn(rusqlite::hooks::Action, &str, &str, &rusqlite::hooks::PreUpdateCase)>);
            }
        }
    }
    pub fn end(&mut self) -> Result<()> {
        // Invalidate before rollback: even a failed rollback must not leave a
        // previously issued read-model token usable.
        self.schedule_metadata_scan = None;
        if self
            .draft_footprint
            .as_ref()
            .is_some_and(|draft| draft.collecting)
        {
            self.clear_draft_footprint();
        }
        // SQLite may roll a transaction back itself after some I/O failures.
        // In that case our bookkeeping flags can still say `active`/`pending`,
        // but issuing another ROLLBACK returns "no transaction is active".
        // That cleanup error used to leave the flags set, making every later
        // `begin` fail in this same method and permanently poisoning the owner.
        // Check SQLite's actual state and clear the flags whenever the
        // connection is back in autocommit mode; keep them only if a real
        // transaction remains open and rollback itself failed.
        let rollback = if self.conn()?.is_autocommit() {
            Ok(())
        } else {
            self.conn()?.execute_batch("ROLLBACK").map_err(err)
        };
        let transaction_is_closed = self.conn()?.is_autocommit();
        if rollback.is_ok() || transaction_is_closed {
            self.active = false;
            self.pending = false;
            self.snapshot_data_version = None;
        }
        rollback
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

    fn draft_footprint_read(&mut self, op: &str, input: &Value) -> Result<Value> {
        match op {
            "inspect" => self.inspect(input),
            "materialize" => self.materialize(input),
            "keys" => self.keys(input),
            "select" | "selectKeys" | "count" => query::select(self.conn()?, input, op),
            "sessionWorkState" if input["action"] == "read" && input["encoding"] == "json" => {
                session_work_state::encoded_read(self.conn()?, input)
            }
            _ => Err(err("unsupported draft footprint read")),
        }
    }

    fn read_tracked_draft(&mut self, input: &Value) -> Result<Value> {
        let draft = self
            .draft_footprint
            .as_ref()
            .ok_or_else(|| err("draft footprint missing"))?;
        if draft.collecting || input["token"].as_str() != Some(draft.token.as_str()) {
            return Err(err("invalid detached draft token"));
        }
        let op = input["operation"]
            .as_str()
            .filter(|op| {
                matches!(
                    *op,
                    "inspect"
                        | "keys"
                        | "materialize"
                        | "select"
                        | "selectKeys"
                        | "count"
                        | "sessionWorkState"
                )
            })
            .ok_or_else(|| err("invalid detached draft read"))?;
        let read_input = input
            .get("input")
            .ok_or_else(|| err("detached draft input required"))?;
        let snapshot = draft.snapshot.clone();
        let version = draft.data_version;
        let expected = draft.state["revision"]
            .as_u64()
            .ok_or_else(|| err("invalid draft revision"))?;
        if self.active || self.pending {
            return Err(err("detached draft read requires an idle owner connection"));
        }
        let current_version: i64 = self
            .conn()?
            .query_row("PRAGMA data_version", [], |r| r.get(0))
            .map_err(err)?;
        if version != current_version || !snapshot.valid() {
            let actual = meta(self.conn()?, "revision")?.as_u64().unwrap_or(expected);
            self.clear_draft_footprint();
            return Err(format!("ORCHESTRATION_SQLITE_CONFLICT:{expected}:{actual}"));
        }
        self.conn()?.execute_batch("BEGIN").map_err(err)?;
        let result = match snapshot.install_views(self.conn()?) {
            Ok(tables) => {
                let result = self
                    .draft_footprint_read(op, read_input)
                    .and_then(|value| self.capture_draft_read(op, read_input).map(|()| value));
                let cleanup = draft_cow::Capture::remove_views(self.conn()?, tables).map_err(err);
                match (result, cleanup) {
                    (Ok(value), Ok(())) => Ok(value),
                    (Err(error), _) | (_, Err(error)) => Err(error),
                }
            }
            Err(error) => Err(err(error)),
        };
        let rollback = self.conn()?.execute_batch("ROLLBACK").map_err(err);
        let after: i64 = self
            .conn()?
            .query_row("PRAGMA data_version", [], |r| r.get(0))
            .map_err(err)?;
        if version != after {
            let actual = meta(self.conn()?, "revision")?.as_u64().unwrap_or(expected);
            self.clear_draft_footprint();
            return Err(format!("ORCHESTRATION_SQLITE_CONFLICT:{expected}:{actual}"));
        }
        if result.is_err() || rollback.is_err() {
            self.clear_draft_footprint();
        }
        rollback?;
        result
    }

    fn capture_draft_read(&mut self, op: &str, input: &Value) -> Result<()> {
        if self
            .draft_footprint
            .as_ref()
            .is_some_and(|footprint| footprint.read_only)
        {
            return Ok(());
        }
        // Record complete records for path reads. This is conservative: even
        // an unobserved field changing forces a conflict rather than write skew.
        let (op, input) = if op == "inspect" || (op == "keys" && input["key"].is_string()) {
            (
                "materialize",
                json!({"collection":input["collection"],"key":input["key"]}),
            )
        } else {
            (op, input.clone())
        };
        let read_key = (op.to_owned(), encode(&input)?);
        if self
            .draft_footprint
            .as_ref()
            .is_some_and(|footprint| footprint.read_keys.contains(&read_key))
        {
            return Ok(());
        }
        let result = self.draft_footprint_read(op, &input)?;
        // A fixed-size digest validates the entire observed result without
        // retaining a second copy of arbitrarily large message bodies.
        let digest: [u8; 32] = Sha256::digest(encode(&result)?.as_bytes()).into();
        let bytes = read_key
            .0
            .len()
            .saturating_add(read_key.1.len())
            .saturating_add(digest.len());
        let footprint = self
            .draft_footprint
            .as_mut()
            .ok_or_else(|| err("draft footprint missing"))?;
        if footprint.reads.len() >= 4096 || footprint.bytes.saturating_add(bytes) > 16 * 1024 * 1024
        {
            return Err(err("draft footprint exceeds limit"));
        }
        footprint.bytes += bytes;
        footprint.read_keys.insert(read_key);
        footprint.reads.push((op.to_owned(), input, digest));
        Ok(())
    }

    fn prepare_tracked_draft(&mut self, input: &Value) -> Result<Value> {
        if self.active || self.pending {
            return Err(err(
                "tracked draft commit requires an idle owner connection",
            ));
        }
        let tracked = self
            .draft_footprint
            .as_ref()
            .ok_or_else(|| err("draft footprint missing"))?;
        if tracked.collecting || input["token"].as_str() != Some(tracked.token.as_str()) {
            return Err(err("invalid detached draft token"));
        }
        if tracked.read_only {
            return Err(err("read-only draft cannot commit"));
        }
        let footprint = self
            .draft_footprint
            .take()
            .ok_or_else(|| err("draft footprint missing"))?;
        self.conn()?.preupdate_hook(
            None::<fn(rusqlite::hooks::Action, &str, &str, &rusqlite::hooks::PreUpdateCase)>,
        );
        if !footprint.snapshot.valid() {
            let expected = footprint.state["revision"].as_u64().unwrap_or(0);
            let actual = meta(self.conn()?, "revision")?.as_u64().unwrap_or(expected);
            return Err(format!("ORCHESTRATION_SQLITE_CONFLICT:{expected}:{actual}"));
        }
        let expected = footprint.state["revision"]
            .as_u64()
            .ok_or_else(|| err("invalid draft revision"))?;
        let actual = meta(self.conn()?, "revision")?
            .as_u64()
            .ok_or_else(|| err("invalid revision"))?;
        let conflict = || format!("ORCHESTRATION_SQLITE_CONFLICT:{expected}:{actual}");
        let data_version: i64 = self
            .conn()?
            .query_row("PRAGMA data_version", [], |row| row.get(0))
            .map_err(err)?;
        if data_version != footprint.data_version
            || actual < expected
            || input["expectedRevision"].as_u64() != Some(expected)
        {
            return Err(conflict());
        }
        if input["headerReadsTracked"] != true {
            return Err(err("draft header reads are not tracked"));
        }
        let current_header = header(self.conn()?)?;
        for field in &footprint.header_reads {
            if current_header[field] != footprint.state[field] {
                return Err(conflict());
            }
        }
        for (op, read_input, old) in &footprint.reads {
            let current = self.draft_footprint_read(op, read_input)?;
            let digest: [u8; 32] = Sha256::digest(encode(&current)?.as_bytes()).into();
            if digest != *old {
                return Err(conflict());
            }
        }
        for entry in input["changes"]
            .as_array()
            .ok_or_else(|| err("changes required"))?
        {
            let found = footprint.reads.iter().any(|(op, read, _)| {
                op == "materialize"
                    && read["collection"] == entry["collection"]
                    && read["key"] == entry["key"]
            });
            if !found {
                return Err(err("draft write lacks captured baseline"));
            }
        }
        let base_sequence = footprint.state["nextOutboxSequence"]
            .as_u64()
            .ok_or_else(|| err("invalid draft sequence"))?;
        let requested_sequence = input["state"]["nextOutboxSequence"]
            .as_u64()
            .ok_or_else(|| err("invalid draft sequence"))?;
        let actual_sequence = meta(self.conn()?, "nextOutboxSequence")?
            .as_u64()
            .ok_or_else(|| err("invalid sequence"))?;
        if requested_sequence != base_sequence && actual_sequence != base_sequence {
            return Err(conflict());
        }
        if input["state"]["schemaVersion"] != footprint.state["schemaVersion"] {
            return Err(err("invalid draft schema"));
        }
        let mut command = input.clone();
        command["expectedRevision"] = json!(actual);
        command["state"]["revision"] = json!(actual
            .checked_add(1)
            .filter(|revision| *revision <= 9_007_199_254_740_991)
            .ok_or_else(|| err("revision overflow"))?);
        if requested_sequence == base_sequence {
            command["state"]["nextOutboxSequence"] = json!(actual_sequence);
        }
        self.snapshot_data_version = Some(footprint.data_version);
        if let Err(error) = self.prepare(&command) {
            let _ = self.end();
            return Err(error);
        }
        if input["prepareOnly"] == true {
            return Ok(json!({"prepared":true}));
        }
        let result = self.request("commit", &json!({}));
        if result.is_err() {
            let _ = self.end();
        }
        result
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
        if self
            .draft_footprint
            .as_ref()
            .is_some_and(|draft| draft.collecting)
            && matches!(
                op,
                "inspect" | "keys" | "materialize" | "select" | "selectKeys" | "count"
            )
            || (self
                .draft_footprint
                .as_ref()
                .is_some_and(|draft| draft.collecting)
                && op == "sessionWorkState"
                && input["action"] == "read"
                && input["encoding"] == "json")
        {
            if let Err(error) = self.capture_draft_read(op, input) {
                self.clear_draft_footprint();
                let _ = self.end();
                return Err(error);
            }
        }
        // A single owner shares this cache across sessions. Invalidate before
        // any existing or unknown write command, even if the write later
        // rolls back. Future cache-consuming commands must validate and then
        // invalidate under their write lock before they apply a mutation.
        if !matches!(
            op,
            "info"
                | "begin"
                | "scheduleMetadataBegin"
                | "scheduleMetadataPage"
                | "scheduleRecoverSnapshotExperimental"
                | "scheduleRecoverOwnedSnapshotExperimental"
                | "end"
                | "inspect"
                | "keys"
                | "materialize"
                | "claimMetadata"
                | "waitCancelCheck"
                | "scheduleSettlePlan"
                | "operationAdmitPlan"
                | "operationRunningPlan"
                | "outboxRecoverPlan"
                | "select"
                | "selectKeys"
                | "count"
                | "noop"
                | "metrics"
                | "checkpoint"
                | "export"
                | "taskActivity"
                | "close"
                | "closeShared"
        ) {
            let invalidation = self
                .scheduler_cache
                .as_ref()
                .map(|cache| cache.invalidate_all());
            if let Some(Err(error)) = invalidation {
                // A commit may already have a prepared transaction. Failure
                // to invalidate cannot leave it live for a later command.
                let _ = self.end();
                return Err(err(format!(
                    "scheduler cache invalidation failed: {error:?}"
                )));
            }
        }
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
            "beginTrackedDraft" => {
                if self.draft_footprint.is_some() {
                    return Err(err("draft footprint already active"));
                }
                let mut random = [0_u8; 16];
                getrandom::fill(&mut random).map_err(err)?;
                let token = random
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>();
                let state = self.request("begin", &json!({}))?;
                let data_version = self
                    .snapshot_data_version
                    .ok_or_else(|| err("draft data version missing"))?;
                let snapshot = draft_cow::Capture::default();
                snapshot.install(self.conn()?);
                self.draft_footprint = Some(DraftFootprint {
                    token: token.clone(),
                    collecting: true,
                    read_only: input["readOnly"] == true,
                    data_version,
                    state: state.clone(),
                    reads: Vec::new(),
                    read_keys: HashSet::new(),
                    header_reads: Vec::new(),
                    bytes: 0,
                    snapshot,
                });
                Ok(json!({"token":token,"state":state}))
            }
            "readTrackedDraft" => self.read_tracked_draft(input),
            "draftTrackHeader" => {
                let draft = self
                    .draft_footprint
                    .as_mut()
                    .ok_or_else(|| err("draft footprint missing"))?;
                if input["token"].as_str() != Some(draft.token.as_str()) {
                    return Err(err("invalid draft token"));
                }
                if draft.read_only {
                    return Ok(Value::Null);
                }
                let field = input["field"]
                    .as_str()
                    .filter(|field| {
                        matches!(
                            *field,
                            "schemaVersion" | "revision" | "updatedAt" | "nextOutboxSequence"
                        )
                    })
                    .ok_or_else(|| err("invalid draft header field"))?;
                if !draft.header_reads.iter().any(|name| name == field) {
                    draft.header_reads.push(field.to_owned());
                }
                Ok(Value::Null)
            }
            "discardTrackedDraft" => {
                let draft = self
                    .draft_footprint
                    .as_ref()
                    .ok_or_else(|| err("draft footprint missing"))?;
                if input["token"].as_str() != Some(draft.token.as_str()) {
                    return Err(err("invalid draft token"));
                }
                let collecting = draft.collecting;
                self.clear_draft_footprint();
                if collecting {
                    self.end()?;
                }
                Ok(Value::Null)
            }
            "scheduleMetadataBegin" => {
                let mut random = [0_u8; 16];
                getrandom::fill(&mut random).map_err(err)?;
                let token = random
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>();
                let mut scan = schedule_metadata::Scan::new(token.clone(), input)?;
                let state = self.request("begin", &json!({}))?;
                let schedule = match schedule_metadata::schedule(
                    self.conn()?,
                    scan.session(),
                    scan.preparation(),
                ) {
                    Ok(schedule) => schedule,
                    Err(error) => {
                        let _ = self.end();
                        return Err(error);
                    }
                };
                scan.bind_revision(&state)?;
                self.schedule_metadata_scan = Some(scan);
                Ok(json!({"token": token, "state": state, "schedule":schedule}))
            }
            "scheduleMetadataPage" => {
                if !self.active {
                    return Err(err("scheduler metadata snapshot is not active"));
                }
                let mut scan = self
                    .schedule_metadata_scan
                    .clone()
                    .ok_or_else(|| err("scheduler metadata snapshot is not active"))?;
                let result = scan.next(self.conn()?, input)?;
                self.schedule_metadata_scan = Some(scan);
                Ok(result)
            }
            "end" => {
                self.end()?;
                Ok(Value::Null)
            }
            // A detached draft keeps its own immutable snapshot. Capture the
            // matching SQLite identity before releasing the read transaction.
            "detachDraftSnapshot" => {
                if !self.active || self.pending || self.schedule_metadata_scan.is_some() {
                    return Err(err("detached draft requires an active plain snapshot"));
                }
                let version = self
                    .snapshot_data_version
                    .ok_or_else(|| err("detached draft snapshot has no data version"))?;
                if let Some(draft) = self.draft_footprint.as_mut() {
                    if !draft.collecting || input["token"].as_str() != Some(draft.token.as_str()) {
                        return Err(err("invalid draft token"));
                    }
                    draft.collecting = false;
                }
                let state = header(self.conn()?)?;
                self.end()?;
                let after: i64 = self
                    .conn()?
                    .query_row("PRAGMA data_version", [], |row| row.get(0))
                    .map_err(err)?;
                if version != after {
                    let expected = self
                        .draft_footprint
                        .as_ref()
                        .and_then(|draft| draft.state["revision"].as_u64());
                    let actual = meta(self.conn()?, "revision")?.as_u64();
                    self.clear_draft_footprint();
                    return match expected {
                        Some(expected) => Err(format!(
                            "ORCHESTRATION_SQLITE_CONFLICT:{expected}:{}",
                            actual.unwrap_or(expected)
                        )),
                        None => Err(err("detached draft snapshot changed during capture")),
                    };
                }
                Ok(json!({"state":state,"dataVersion":version}))
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
            "sessionWorkState" if input.get("encoding").and_then(Value::as_str) == Some("json") => {
                match input.get("action").and_then(Value::as_str) {
                    Some("read") => session_work_state::encoded_read(self.conn()?, input),
                    Some(
                        action @ ("write" | "readOrInitialize" | "readOrInitializeBatch" | "patch"),
                    ) => {
                        if self.active || self.pending {
                            return Err(err(
                                "session work state requires an idle owner connection",
                            ));
                        }
                        let connection = self
                            .connection
                            .as_mut()
                            .ok_or_else(|| err("database closed"))?;
                        match action {
                            "write" => session_work_state::encoded_write(connection, input),
                            "patch" => session_work_state::encoded_patch(connection, input),
                            "readOrInitializeBatch" => {
                                session_work_state::encoded_initialize_batch(connection, input)
                            }
                            _ => session_work_state::encoded_initialize(connection, input),
                        }
                    }
                    _ => Err(err("unknown session work state action")),
                }
            }
            "sessionWorkState" if input.get("encoding").is_some() => {
                Err(err("unsupported session work state encoding"))
            }
            "sessionWorkState" => match input.get("action").and_then(Value::as_str) {
                Some("read") => session_work_state::read(self.conn()?, input),
                Some("readOrInitialize") => {
                    if self.active || self.pending {
                        return Err(err("session work state requires an idle owner connection"));
                    }
                    let connection = self
                        .connection
                        .as_mut()
                        .ok_or_else(|| err("database closed"))?;
                    session_work_state::read_or_initialize(connection, input)
                }
                Some("write") => {
                    if self.active || self.pending {
                        return Err(err("session work state requires an idle owner connection"));
                    }
                    let connection = self
                        .connection
                        .as_mut()
                        .ok_or_else(|| err("database closed"))?;
                    session_work_state::write(connection, input)
                }
                _ => Err(err("unknown session work state action")),
            },
            "sessionWorkQuestionExperimental" => {
                if self.active || self.pending {
                    return Err(err("question transition requires an idle owner connection"));
                }
                let connection = self
                    .connection
                    .as_mut()
                    .ok_or_else(|| err("database closed"))?;
                session_work_state::question_transition(connection, input)
            }
            "scheduleAdmit" => schedule_admit::commit(self, input),
            "scheduleClaim" => schedule_claim::commit(self, input),
            "scheduleClaimChat" => schedule_claim::claim_chat(self, input),
            "scheduleReleaseChat" => schedule_claim::release_chat(self, input),
            "scheduleHandoff" => schedule_claim::handoff(self, input),
            "scheduleCompleteTokenExperimental" => {
                schedule_admit_live::completion_token(self, input)
            }
            "scheduleCompleteExperimental" => schedule_admit_live::complete(self, input),
            "scheduleRecoverSnapshotExperimental" => schedule_recover::snapshot(self),
            "scheduleRecoverOwnedSnapshotExperimental" => schedule_recover::owned_snapshot(self),
            "scheduleRecoverOwnedPrepareExperimental" => {
                schedule_recover::owned_prepare(self, input)
            }
            "scheduleRecoverCommitExperimental" => schedule_recover::commit(self, input),
            "scheduleRecoverOwnedCommitExperimental" => schedule_recover::owned_commit(self, input),
            "scheduleCompleteAtomicExperimental" => {
                schedule_admit_live::complete_atomic(self, input)
            }
            "scheduleCompleteFrozenExperimental" => {
                schedule_admit_live::complete_frozen(self, input)
            }
            "scheduleReorderCheck" => schedule_admit_live::reorder_check(self.conn()?, input),
            "scheduleReorder" => schedule_admit_live::reorder(self, input),
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
                if self.schedule_metadata_scan.is_some() {
                    return Err(err(
                        "scheduler metadata requires its bound prepare operation",
                    ));
                }
                let result = self.prepare(input);
                if result.is_err() {
                    let _ = self.end();
                }
                result
            }
            // Compare the detached snapshot and apply the complete draft in a
            // single owner command; no JavaScript callback runs while the
            // SQLite write transaction is open.
            "commitDetachedDraft" => {
                if self.active || self.pending {
                    return Err(err(
                        "detached draft commit requires an idle owner connection",
                    ));
                }
                let version = input["dataVersion"]
                    .as_i64()
                    .filter(|version| *version >= 0)
                    .ok_or_else(|| err("detached draft dataVersion required"))?;
                self.snapshot_data_version = Some(version);
                if let Err(error) = self.prepare(input) {
                    let _ = self.end();
                    return Err(error);
                }
                let result = self.request("commit", &json!({}));
                if result.is_err() {
                    let _ = self.end();
                }
                result
            }
            "commitTrackedDraft" => self.prepare_tracked_draft(input),
            "scheduleMetadataPrepare" => {
                if !self.active {
                    return Err(err("scheduler metadata snapshot is not active"));
                }
                self.schedule_metadata_scan
                    .as_ref()
                    .ok_or_else(|| err("scheduler metadata snapshot is not active"))?
                    .validate_prepare(input)?;
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
