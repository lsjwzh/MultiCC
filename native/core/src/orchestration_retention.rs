//! Bounded retention for disposable orchestration records.
//!
//! Task-board records, transcripts, operation idempotency records and unresolved
//! deliveries are outside this policy. A terminal row is deletable only after a
//! valid terminal timestamp and updated_at both pass the retention horizon and
//! no durable recovery edge still names it. No payload crosses the native API.
use fs2::FileExt;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};

pub type Result<T> = std::result::Result<T, String>;
const DAY_MS: i64 = 86_400_000;
const HOUR_MS: i64 = 3_600_000;
const TERMINAL_TASKS: &str = "'completed','failed','interrupted','cancelled'";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct RetentionPolicy {
    pub enabled: bool,
    pub task_days: i64,
    pub outbox_days: i64,
    pub batch_size: usize,
    /// Soft target for terminal tasks + delivered/cancelled outbox receipts.
    /// Recent or referenced receipts may exceed it; active and dead-letter rows do not count.
    pub max_records: usize,
    pub interval_ms: i64,
}
impl Default for RetentionPolicy {
    fn default() -> Self {
        Self {
            enabled: true,
            task_days: 30,
            outbox_days: 30,
            batch_size: 500,
            max_records: 5000,
            interval_ms: HOUR_MS,
        }
    }
}
impl RetentionPolicy {
    /// Whitelisted raw environment values only; no process environment or
    /// unrelated credentials need to cross the NAPI boundary.
    pub fn from_env_values(values: &serde_json::Value) -> Result<Self> {
        let mut policy = Self::default();
        let read = |name: &str| {
            values
                .get(name)
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|v| !v.is_empty())
        };
        if let Some(value) = read("MULTICC_ORCHESTRATION_RETENTION_ENABLED") {
            policy.enabled = match value.to_ascii_lowercase().as_str() {
                "1" | "true" | "on" | "yes" => true,
                "0" | "false" | "off" | "no" => false,
                _ => return Err("invalid MULTICC_ORCHESTRATION_RETENTION_ENABLED".into()),
            };
        }
        for (key, target) in [
            (
                "MULTICC_ORCHESTRATION_RETENTION_TASK_DAYS",
                &mut policy.task_days,
            ),
            (
                "MULTICC_ORCHESTRATION_RETENTION_OUTBOX_DAYS",
                &mut policy.outbox_days,
            ),
            (
                "MULTICC_ORCHESTRATION_RETENTION_INTERVAL_MS",
                &mut policy.interval_ms,
            ),
        ] {
            if let Some(value) = read(key) {
                *target = value.parse().map_err(|_| format!("invalid {key}"))?;
            }
        }
        if let Some(value) = read("MULTICC_ORCHESTRATION_RETENTION_BATCH_SIZE") {
            policy.batch_size = value
                .parse()
                .map_err(|_| "invalid MULTICC_ORCHESTRATION_RETENTION_BATCH_SIZE")?;
        }
        if let Some(value) = read("MULTICC_ORCHESTRATION_RETENTION_MAX_RECORDS") {
            policy.max_records = value
                .parse()
                .map_err(|_| "invalid MULTICC_ORCHESTRATION_RETENTION_MAX_RECORDS")?;
        }
        policy.validate()?;
        Ok(policy)
    }
    pub fn validate(&self) -> Result<()> {
        if !(1..=36_500).contains(&self.task_days) || !(1..=36_500).contains(&self.outbox_days) {
            return Err("orchestration retention days must be between 1 and 36500".into());
        }
        if !(1..=1_000_000).contains(&self.max_records) {
            return Err("orchestration retention maxRecords must be between 1 and 1000000".into());
        }
        if !(1..=10_000).contains(&self.batch_size) {
            return Err("orchestration retention batchSize must be between 1 and 10000".into());
        }
        if !(60_000..=30 * DAY_MS).contains(&self.interval_ms) {
            return Err(
                "orchestration retention intervalMs must be between one minute and 30 days".into(),
            );
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RetentionReport {
    pub enabled: bool,
    pub dry_run: bool,
    pub capacity_triggered: bool,
    pub capacity_excess: u64,
    pub total_tasks: u64,
    pub terminal_tasks: u64,
    pub total_outbox: u64,
    pub terminal_outbox: u64,
    /// Exact eligibility counts from this explicit inventory.
    pub eligible_tasks: u64,
    pub eligible_outbox: u64,
    pub deleted_tasks: u64,
    pub deleted_outbox: u64,
    pub revision: i64,
    pub checked_at: i64,
    pub next_run_at: Option<i64>,
    pub policy: RetentionPolicy,
}

/// Shared by every new native store; the offline tool requires the exclusive
/// counterpart. The additional lsof check in the tool covers older Node hosts
/// which do not yet participate in this lock protocol.
pub struct MaintenanceGuard {
    file: File,
}
impl MaintenanceGuard {
    pub fn lock_path(database: &Path) -> Result<PathBuf> {
        // All path aliases must converge on the same lock. Hard links cannot be
        // normalized this way and also split SQLite WAL sidecars, so reject them.
        let canonical = match std::fs::metadata(database) {
            Ok(metadata) => {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::MetadataExt;
                    if metadata.nlink() != 1 {
                        return Err(
                            "orchestration databases with hard links are not supported".into()
                        );
                    }
                }
                if !metadata.is_file() {
                    return Err("orchestration database is not a regular file".into());
                }
                std::fs::canonicalize(database).map_err(|e| e.to_string())?
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if std::fs::symlink_metadata(database).is_ok() {
                    return Err("orchestration database must not be a dangling symlink".into());
                }
                let parent = database
                    .parent()
                    .filter(|p| !p.as_os_str().is_empty())
                    .unwrap_or(Path::new("."));
                std::fs::canonicalize(parent)
                    .map_err(|e| e.to_string())?
                    .join(
                        database
                            .file_name()
                            .ok_or("orchestration database filename is missing")?,
                    )
            }
            Err(error) => return Err(error.to_string()),
        };
        let mut name = canonical.into_os_string();
        name.push(".maintenance.lock");
        Ok(PathBuf::from(name))
    }
    fn file(database: &Path) -> Result<File> {
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let file = options
            .open(Self::lock_path(database)?)
            .map_err(|e| format!("cannot open orchestration maintenance lock: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(std::fs::Permissions::from_mode(0o600))
                .map_err(|e| e.to_string())?;
        }
        Ok(file)
    }
    pub fn shared(database: &Path) -> Result<Self> {
        let file = Self::file(database)?;
        FileExt::try_lock_shared(&file)
            .map_err(|e| format!("orchestration offline maintenance is active: {e}"))?;
        Ok(Self { file })
    }
    pub fn exclusive(database: &Path) -> Result<Self> {
        let file = Self::file(database)?;
        FileExt::try_lock_exclusive(&file)
            .map_err(|e| format!("orchestration database is still in use: {e}"))?;
        Ok(Self { file })
    }
}
impl Drop for MaintenanceGuard {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.file);
    }
}

fn sql_error(error: rusqlite::Error) -> String {
    format!("orchestration retention: {error}")
}

/// Add only derived indexes; the database schema version and row JSON remain
/// unchanged. JSON expression indexes keep recovery-reference checks bounded
/// without repeatedly scanning large message/result strings for each candidate.
pub fn install_indexes(connection: &Connection) -> Result<()> {
    connection.execute_batch("CREATE INDEX IF NOT EXISTS idx_orchestration_tasks_retention_scan ON orchestration_tasks(updated_at,id) WHERE status IN ('completed','failed','interrupted','cancelled') AND typeof(updated_at) IN ('integer','real') AND updated_at>0;
        CREATE INDEX IF NOT EXISTS idx_orchestration_outbox_retention_scan ON orchestration_outbox(updated_at,id) WHERE state IN ('delivered','cancelled') AND typeof(updated_at) IN ('integer','real') AND updated_at>0;
        CREATE INDEX IF NOT EXISTS idx_orchestration_tasks_retention_capacity ON orchestration_tasks(id) WHERE status IN ('completed','failed','interrupted','cancelled');
        CREATE INDEX IF NOT EXISTS idx_orchestration_outbox_retention_capacity ON orchestration_outbox(id) WHERE state IN ('delivered','cancelled');").map_err(sql_error)?;
    let groups: &[(&str, &str, &[&str])] = &[
        (
            "orchestration_operations",
            "operation",
            &[
                "requestOutboxId",
                "resultOutboxId",
                "spec.taskId",
                "spec.options.taskId",
                "result.taskId",
            ],
        ),
        (
            "orchestration_outbox",
            "outbox",
            &[
                "source.taskId",
                "payload.taskId",
                "payload.options.taskId",
                "turnLineage.taskId",
                "payload.activeEntryId",
                "turnLineage.activeEntryId",
            ],
        ),
        (
            "orchestration_session_schedules",
            "schedule",
            &[
                "active.taskId",
                "active.entryId",
                "active.deliveryId",
                "priorityEntryId",
            ],
        ),
        (
            "orchestration_waits",
            "wait",
            &["outboxId", "metadata.taskId"],
        ),
    ];
    for (table, prefix, fields) in groups {
        for (number, field) in fields.iter().enumerate() {
            connection.execute_batch(&format!("CREATE INDEX IF NOT EXISTS idx_orchestration_retention_{prefix}_{number} ON {table}(json_extract(data_json,'$.{field}'));")).map_err(sql_error)?;
        }
    }
    Ok(())
}

fn terminal_time(alias: &str, field: &str) -> String {
    format!("json_type({alias}.data_json,'$.{field}') IN ('integer','real') AND json_extract({alias}.data_json,'$.{field}') > 0 AND json_extract({alias}.data_json,'$.{field}') <= ?1")
}
fn task_reference(alias: &str, fields: &[&str]) -> String {
    fields.iter().map(|field| format!("json_extract({alias}.data_json,'$.{field}') IN (candidate.id,json_extract(candidate.data_json,'$.taskId'))")).collect::<Vec<_>>().join(" OR ")
}
fn outbox_reference(alias: &str, fields: &[&str]) -> String {
    fields
        .iter()
        .map(|field| format!("json_extract({alias}.data_json,'$.{field}') = candidate.id"))
        .collect::<Vec<_>>()
        .join(" OR ")
}
fn task_predicate() -> String {
    format!("candidate.status IN ({TERMINAL_TASKS})
        AND typeof(candidate.updated_at) IN ('integer','real') AND candidate.updated_at > 0 AND candidate.updated_at <= ?1
        AND {}
        AND NOT EXISTS (SELECT 1 FROM orchestration_session_schedules AS schedule WHERE json_type(schedule.data_json,'$.active') = 'object' AND ({}))
        AND NOT EXISTS (SELECT 1 FROM orchestration_outbox AS delivery WHERE (delivery.state IS NULL OR delivery.state NOT IN ('delivered','cancelled')) AND ({}))
        AND NOT EXISTS (SELECT 1 FROM orchestration_operations AS operation WHERE (operation.status IS NULL OR operation.status NOT IN ({TERMINAL_TASKS})) AND ({}))
        AND NOT EXISTS (SELECT 1 FROM orchestration_waits AS wait WHERE (wait.status IS NULL OR wait.status NOT IN ('resolved','cancelled')) AND ({}))",
        terminal_time("candidate", "completedAt"),
        task_reference("schedule", &["active.taskId"]),
        task_reference("delivery", &["source.taskId", "payload.taskId", "payload.options.taskId", "turnLineage.taskId"]),
        task_reference("operation", &["spec.taskId", "spec.options.taskId", "result.taskId"]),
        task_reference("wait", &["metadata.taskId"]))
}
fn outbox_predicate() -> String {
    format!("candidate.state IN ('delivered','cancelled')
        AND typeof(candidate.updated_at) IN ('integer','real') AND candidate.updated_at > 0 AND candidate.updated_at <= ?1
        AND ((candidate.state = 'delivered' AND ({})) OR (candidate.state = 'cancelled' AND ({})))
        AND NOT EXISTS (SELECT 1 FROM orchestration_session_schedules AS schedule WHERE ({}))
        AND NOT EXISTS (SELECT 1 FROM orchestration_operations AS operation WHERE ({}))
        AND NOT EXISTS (SELECT 1 FROM orchestration_operations AS operation WHERE operation.id = json_extract(candidate.data_json,'$.source.operationId') OR operation.id = json_extract(candidate.data_json,'$.payload.operationId'))
        AND NOT EXISTS (SELECT 1 FROM orchestration_waits AS wait WHERE ({}))
        AND NOT EXISTS (SELECT 1 FROM orchestration_outbox AS delivery WHERE delivery.id != candidate.id AND (delivery.state IS NULL OR delivery.state NOT IN ('delivered','cancelled')) AND ({}))",
        terminal_time("candidate", "deliveredAt"), terminal_time("candidate", "cancelledAt"),
        outbox_reference("schedule", &["active.entryId", "active.deliveryId", "priorityEntryId"]),
        outbox_reference("operation", &["requestOutboxId", "resultOutboxId"]),
        outbox_reference("wait", &["outboxId"]),
        outbox_reference("delivery", &["payload.activeEntryId", "turnLineage.activeEntryId"]))
}
fn count(connection: &Connection, query: &str) -> Result<u64> {
    connection
        .query_row(query, [], |row| row.get(0))
        .map_err(sql_error)
}
fn count_eligible(
    connection: &Connection,
    table: &str,
    predicate: &str,
    cutoff: i64,
) -> Result<u64> {
    connection
        .query_row(
            &format!("SELECT count(*) FROM {table} AS candidate WHERE {predicate}"),
            [cutoff],
            |row| row.get(0),
        )
        .map_err(sql_error)
}
fn revision(connection: &Connection) -> Result<i64> {
    let value: Option<String> = connection
        .query_row(
            "SELECT value_json FROM orchestration_meta WHERE key = 'revision'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(sql_error)?;
    let value = value.ok_or("orchestration retention revision is missing")?;
    let value: i64 =
        serde_json::from_str(&value).map_err(|_| "orchestration retention revision is invalid")?;
    if !(0..9_007_199_254_740_991).contains(&value) {
        return Err("orchestration retention revision is outside the safe range".into());
    }
    Ok(value)
}
fn cutoffs(policy: &RetentionPolicy, now_ms: i64) -> Result<(i64, i64)> {
    policy.validate()?;
    if now_ms <= 0 || now_ms > 8_640_000_000_000_000 {
        return Err("orchestration retention requires a valid positive timestamp".into());
    }
    Ok((
        now_ms.saturating_sub(policy.task_days * DAY_MS),
        now_ms.saturating_sub(policy.outbox_days * DAY_MS),
    ))
}
/// Stops after maxRecords + batchSize terminal receipts; only index keys are visited.
/// The excess is a lower bound when a large backlog exists. It schedules earlier
/// maintenance but never overrides the minimum retention horizon or reference guards.
/// The caller must install_indexes() once before probing capacity.
pub fn capacity_excess(connection: &Connection, policy: &RetentionPolicy) -> Result<u64> {
    policy.validate()?;
    let limit = policy.max_records.saturating_add(policy.batch_size) as i64;
    let total: u64 = connection.query_row(
        &format!("SELECT count(*) FROM (SELECT id FROM orchestration_tasks INDEXED BY idx_orchestration_tasks_retention_capacity WHERE status IN ({TERMINAL_TASKS}) UNION ALL SELECT id FROM orchestration_outbox INDEXED BY idx_orchestration_outbox_retention_capacity WHERE state IN ('delivered','cancelled') LIMIT ?1)"),
        [limit], |r| r.get(0)).map_err(sql_error)?;
    Ok(total.saturating_sub(policy.max_records as u64))
}
/// Read-only inventory. It never creates indexes, opens a write transaction,
/// emits task identifiers or returns message/result bodies.
pub fn report(
    connection: &Connection,
    policy: &RetentionPolicy,
    now_ms: i64,
) -> Result<RetentionReport> {
    let (task_cutoff, outbox_cutoff) = cutoffs(policy, now_ms)?;
    let total_tasks = count(connection, "SELECT count(*) FROM orchestration_tasks")?;
    let total_outbox = count(connection, "SELECT count(*) FROM orchestration_outbox")?;
    let terminal_tasks = count(
        connection,
        &format!("SELECT count(*) FROM orchestration_tasks WHERE status IN ({TERMINAL_TASKS})"),
    )?;
    let terminal_outbox = count(
        connection,
        "SELECT count(*) FROM orchestration_outbox WHERE state IN ('delivered','cancelled')",
    )?;
    let capacity_excess =
        (terminal_tasks + terminal_outbox).saturating_sub(policy.max_records as u64);
    Ok(RetentionReport {
        enabled: policy.enabled,
        dry_run: true,
        capacity_triggered: capacity_excess > 0,
        capacity_excess,
        total_tasks,
        terminal_tasks,
        total_outbox,
        terminal_outbox,
        eligible_tasks: count_eligible(
            connection,
            "orchestration_tasks",
            &task_predicate(),
            task_cutoff,
        )?,
        eligible_outbox: count_eligible(
            connection,
            "orchestration_outbox",
            &outbox_predicate(),
            outbox_cutoff,
        )?,
        deleted_tasks: 0,
        deleted_outbox: 0,
        revision: revision(connection)?,
        checked_at: now_ms,
        next_run_at: policy
            .enabled
            .then(|| now_ms.saturating_add(policy.interval_ms)),
        policy: policy.clone(),
    })
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RetentionBatchReport {
    pub enabled: bool,
    pub dry_run: bool,
    pub capacity_triggered: bool,
    pub capacity_excess: u64,
    /// Candidate counts refer only to this bounded scan, not the whole database.
    pub eligible_tasks: u64,
    pub eligible_outbox: u64,
    pub eligibility_exact: bool,
    pub scanned_tasks: u64,
    pub scanned_outbox: u64,
    pub deleted_tasks: u64,
    pub deleted_outbox: u64,
    pub revision: i64,
    pub checked_at: i64,
    pub next_run_at: Option<i64>,
    pub policy: RetentionPolicy,
}
#[derive(Serialize, Deserialize)]
struct Cursor {
    at: f64,
    id: String,
}
struct ScanTable<'a> {
    table: &'a str,
    index: &'a str,
    predicate: &'a str,
    cursor_key: &'a str,
    state_filter: &'a str,
}
fn scan_and_delete(
    connection: &Connection,
    spec: ScanTable<'_>,
    cutoff: i64,
    limit: usize,
    scan_limit: usize,
) -> Result<(u64, u64)> {
    let ScanTable {
        table,
        index,
        predicate,
        cursor_key,
        state_filter,
    } = spec;
    if limit == 0 {
        return Ok((0, 0));
    }
    let cursor: Option<String> = connection
        .query_row(
            "SELECT value_json FROM orchestration_meta WHERE key=?1",
            [cursor_key],
            |row| row.get(0),
        )
        .optional()
        .map_err(sql_error)?;
    let cursor = cursor
        .and_then(|value| serde_json::from_str::<Cursor>(&value).ok())
        .filter(|cursor| cursor.at.is_finite() && cursor.at > 0.0);
    let (at, id) = cursor
        .map(|cursor| (cursor.at, cursor.id))
        .unwrap_or((0.0, String::new()));
    // Scan only a bounded prefix of an indexed terminal-time order. References
    // are checked afterwards; a fully protected prefix must not make SQLite
    // inspect every old row while holding the IMMEDIATE write transaction.
    let query = format!(
        "SELECT id,updated_at FROM {table} INDEXED BY {index} WHERE {state_filter}
        AND typeof(updated_at) IN ('integer','real') AND updated_at>0 AND updated_at<=?1
        AND (updated_at,id)>(?2,?3) ORDER BY updated_at,id LIMIT ?4"
    );
    let mut statement = connection.prepare(&query).map_err(sql_error)?;
    let candidates: Vec<(String, f64)> = statement
        .query_map(params![cutoff, at, id, scan_limit as i64], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .map_err(sql_error)?
        .collect::<std::result::Result<_, _>>()
        .map_err(sql_error)?;
    drop(statement);
    let mut check=connection.prepare(&format!("SELECT EXISTS(SELECT 1 FROM {table} AS candidate WHERE candidate.id=?2 AND {predicate})")).map_err(sql_error)?;
    let mut remove = connection
        .prepare(&format!("DELETE FROM {table} WHERE id=?1"))
        .map_err(sql_error)?;
    let mut deleted = 0u64;
    let mut scanned = 0u64;
    let mut last = None;
    for (id, at) in &candidates {
        let eligible: bool = check
            .query_row(params![cutoff, id], |row| row.get(0))
            .map_err(sql_error)?;
        scanned += 1;
        last = Some(Cursor {
            at: *at,
            id: id.clone(),
        });
        if eligible {
            deleted += remove.execute([id]).map_err(sql_error)? as u64;
        }
        if deleted >= limit as u64 {
            break;
        }
    }
    drop(check);
    drop(remove);
    // A cursor is internal maintenance progress, not domain state. Advancing it
    // without deletions need not invalidate a domain revision. End-of-scan wraps
    // on the next interval so newly expired or unreferenced rows are revisited.
    if candidates.len() < scan_limit && scanned as usize == candidates.len() {
        last = None;
    }
    match last {
        Some(cursor) => {
            connection.execute("INSERT INTO orchestration_meta(key,value_json) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",params![cursor_key,serde_json::to_string(&cursor).map_err(|e|e.to_string())?]).map_err(sql_error)?;
        }
        None => {
            connection
                .execute("DELETE FROM orchestration_meta WHERE key=?1", [cursor_key])
                .map_err(sql_error)?;
        }
    }
    Ok((deleted, scanned))
}
/// One bounded write transaction; no full inventory or eligibility COUNT runs
/// here. Operators can explicitly call report() for exact offline statistics.
/// A persisted cursor prevents protected old records from starving later rows.
/// The caller must install_indexes() once before running maintenance.
pub fn prune_batch(
    connection: &mut Connection,
    policy: &RetentionPolicy,
    now_ms: i64,
) -> Result<RetentionBatchReport> {
    let (task_cutoff, outbox_cutoff) = cutoffs(policy, now_ms)?;
    let mut result = RetentionBatchReport {
        enabled: policy.enabled,
        dry_run: !policy.enabled,
        capacity_triggered: false,
        capacity_excess: 0,
        eligible_tasks: 0,
        eligible_outbox: 0,
        eligibility_exact: false,
        scanned_tasks: 0,
        scanned_outbox: 0,
        deleted_tasks: 0,
        deleted_outbox: 0,
        revision: revision(connection)?,
        checked_at: now_ms,
        next_run_at: policy
            .enabled
            .then(|| now_ms.saturating_add(policy.interval_ms)),
        policy: policy.clone(),
    };
    if !policy.enabled {
        return Ok(result);
    }
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sql_error)?;
    result.revision = revision(&transaction)?;
    // Report the trigger under the same write lock as the deletions. Capacity
    // never shortens the retention horizon or limits ordinary expiry cleanup.
    result.capacity_excess = capacity_excess(&transaction, policy)?;
    result.capacity_triggered = result.capacity_excess > 0;
    let budget = policy.batch_size;
    let old_outbox: bool=transaction.query_row("SELECT EXISTS(SELECT 1 FROM orchestration_outbox INDEXED BY idx_orchestration_outbox_retention_scan WHERE state IN ('delivered','cancelled') AND typeof(updated_at) IN ('integer','real') AND updated_at>0 AND updated_at<=?1)",[outbox_cutoff],|row|row.get(0)).map_err(sql_error)?;
    // With a one-row budget, alternate tables even when every candidate is
    // protected and no domain revision changes. Otherwise one table can starve.
    let task_limit = if old_outbox && budget == 1 {
        let prefer_outbox: Option<String> = transaction
            .query_row(
                "SELECT value_json FROM orchestration_meta WHERE key='retentionPreferOutbox'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(sql_error)?;
        let prefer_outbox = prefer_outbox
            .and_then(|value| serde_json::from_str::<bool>(&value).ok())
            .unwrap_or(true);
        transaction.execute("INSERT INTO orchestration_meta(key,value_json) VALUES('retentionPreferOutbox',?1) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json", [if prefer_outbox { "false" } else { "true" }]).map_err(sql_error)?;
        usize::from(!prefer_outbox)
    } else if old_outbox {
        budget.div_ceil(2)
    } else {
        budget
    };
    let scan_limit = policy.batch_size.saturating_mul(4);
    (result.deleted_tasks, result.scanned_tasks) = scan_and_delete(
        &transaction,
        ScanTable {
            table: "orchestration_tasks",
            index: "idx_orchestration_tasks_retention_scan",
            predicate: &task_predicate(),
            cursor_key: "retentionCursorTasks",
            state_filter: &format!("status IN ({TERMINAL_TASKS})"),
        },
        task_cutoff,
        task_limit,
        scan_limit,
    )?;
    (result.deleted_outbox, result.scanned_outbox) = scan_and_delete(
        &transaction,
        ScanTable {
            table: "orchestration_outbox",
            index: "idx_orchestration_outbox_retention_scan",
            predicate: &outbox_predicate(),
            cursor_key: "retentionCursorOutbox",
            state_filter: "state IN ('delivered','cancelled')",
        },
        outbox_cutoff,
        budget - result.deleted_tasks as usize,
        scan_limit,
    )?;
    result.eligible_tasks = result.deleted_tasks;
    result.eligible_outbox = result.deleted_outbox;
    if result.deleted_tasks + result.deleted_outbox > 0 {
        result.revision += 1;
        transaction
            .execute(
                "UPDATE orchestration_meta SET value_json=?1 WHERE key='revision'",
                [result.revision.to_string()],
            )
            .map_err(sql_error)?;
        transaction
            .execute(
                "UPDATE orchestration_meta SET value_json=?1 WHERE key='updatedAt'",
                [now_ms.to_string()],
            )
            .map_err(sql_error)?;
    }
    transaction.commit().map_err(sql_error)?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn database() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE orchestration_meta(key TEXT PRIMARY KEY,value_json TEXT NOT NULL);
            INSERT INTO orchestration_meta VALUES('revision','0'),('updatedAt','1');
            CREATE TABLE orchestration_tasks(id TEXT PRIMARY KEY,data_json TEXT NOT NULL,status TEXT,updated_at INTEGER);
            CREATE TABLE orchestration_outbox(id TEXT PRIMARY KEY,data_json TEXT NOT NULL,state TEXT,updated_at INTEGER);
            CREATE TABLE orchestration_operations(id TEXT PRIMARY KEY,data_json TEXT NOT NULL,status TEXT);
            CREATE TABLE orchestration_waits(id TEXT PRIMARY KEY,data_json TEXT NOT NULL,status TEXT);
            CREATE TABLE orchestration_session_schedules(session_id TEXT PRIMARY KEY,data_json TEXT NOT NULL);").unwrap();
        install_indexes(&connection).unwrap();
        connection
    }
    fn task(connection: &Connection, id: &str, status: &str, completed: serde_json::Value) {
        connection
            .execute(
                "INSERT INTO orchestration_tasks VALUES(?1,?2,?3,1)",
                params![
                    id,
                    json!({"id":id,"taskId":format!("cli-{id}"),"completedAt":completed})
                        .to_string(),
                    status
                ],
            )
            .unwrap();
    }
    fn delivery(connection: &Connection, id: &str, state: &str, extra: serde_json::Value) {
        let mut body = json!({"id":id,"deliveredAt":1,"cancelledAt":1});
        for (key, value) in extra.as_object().unwrap() {
            body[key] = value.clone();
        }
        connection
            .execute(
                "INSERT INTO orchestration_outbox VALUES(?1,?2,?3,1)",
                params![id, body.to_string(), state],
            )
            .unwrap();
    }
    #[test]
    fn only_expired_proven_terminal_records_are_candidates() {
        let connection = database();
        task(&connection, "old", "completed", json!(1));
        task(&connection, "running", "running", json!(1));
        task(
            &connection,
            "unknown-time",
            "completed",
            serde_json::Value::Null,
        );
        task(&connection, "string-time", "completed", json!("1"));
        task(&connection, "recent", "completed", json!(40 * DAY_MS));
        delivery(&connection, "sent", "delivered", json!({}));
        delivery(&connection, "dead", "dead-letter", json!({}));
        let result = report(&connection, &RetentionPolicy::default(), 45 * DAY_MS).unwrap();
        assert_eq!(result.eligible_tasks, 1);
        assert_eq!(result.eligible_outbox, 1);
        assert_eq!(result.revision, 0);
        assert_eq!(result.total_tasks, 5);
    }
    #[test]
    fn recovery_edges_and_idempotency_operations_protect_records() {
        let connection = database();
        for id in ["schedule", "delivery", "operation", "wait"] {
            task(&connection, id, "completed", json!(1));
        }
        connection
            .execute(
                "INSERT INTO orchestration_session_schedules VALUES('s',?1)",
                [json!({"active":{"taskId":"cli-schedule"}}).to_string()],
            )
            .unwrap();
        delivery(
            &connection,
            "pending",
            "pending",
            json!({"payload":{"taskId":"cli-delivery"}}),
        );
        connection
            .execute(
                "INSERT INTO orchestration_operations VALUES('o',?1,'running')",
                [json!({"spec":{"taskId":"cli-operation"},"requestOutboxId":"sent"}).to_string()],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO orchestration_waits VALUES('w',?1,'pending')",
                [json!({"metadata":{"taskId":"cli-wait"}}).to_string()],
            )
            .unwrap();
        delivery(&connection, "sent", "delivered", json!({}));
        let result = report(&connection, &RetentionPolicy::default(), 45 * DAY_MS).unwrap();
        assert_eq!(result.eligible_tasks, 0);
        assert_eq!(result.eligible_outbox, 0);
    }
    #[test]
    fn batches_share_capacity_and_advance_revision_only_when_deleting() {
        let mut connection = database();
        for n in 0..8 {
            task(&connection, &format!("t{n}"), "completed", json!(1));
        }
        for n in 0..8 {
            delivery(&connection, &format!("d{n}"), "delivered", json!({}));
        }
        let policy = RetentionPolicy {
            batch_size: 5,
            ..RetentionPolicy::default()
        };
        let result = prune_batch(&mut connection, &policy, 45 * DAY_MS).unwrap();
        assert_eq!((result.deleted_tasks, result.deleted_outbox), (3, 2));
        assert_eq!(result.revision, 1);
        let disabled = RetentionPolicy {
            enabled: false,
            ..policy
        };
        let result = prune_batch(&mut connection, &disabled, 45 * DAY_MS).unwrap();
        assert_eq!(result.deleted_tasks + result.deleted_outbox, 0);
        assert_eq!(result.revision, 1);
        assert_eq!(result.next_run_at, None);
    }
    #[test]
    fn deletion_and_revision_update_roll_back_together() {
        let mut connection = database();
        task(&connection, "old", "completed", json!(1));
        connection.execute_batch("CREATE TRIGGER reject_revision BEFORE UPDATE ON orchestration_meta BEGIN SELECT RAISE(ABORT,'injected'); END;").unwrap();
        assert!(prune_batch(&mut connection, &RetentionPolicy::default(), 45 * DAY_MS).is_err());
        assert_eq!(
            count(&connection, "SELECT count(*) FROM orchestration_tasks").unwrap(),
            1
        );
        assert_eq!(revision(&connection).unwrap(), 0);
    }
    #[test]
    fn queued_continuations_keep_their_delivered_parent() {
        let connection = database();
        delivery(&connection, "parent", "delivered", json!({}));
        delivery(
            &connection,
            "continuation",
            "dead-letter",
            json!({"turnLineage":{"activeEntryId":"parent"}}),
        );
        assert_eq!(
            report(&connection, &RetentionPolicy::default(), 45 * DAY_MS)
                .unwrap()
                .eligible_outbox,
            0
        );
    }

    #[test]
    fn bounded_scan_progresses_past_a_protected_prefix() {
        let mut connection = database();
        for n in 0..12 {
            let id = format!("protected-{n:02}");
            task(&connection, &id, "completed", json!(1));
            connection
                .execute(
                    "INSERT INTO orchestration_waits VALUES(?1,?2,'pending')",
                    params![
                        format!("wait-{n}"),
                        json!({"metadata":{"taskId":format!("cli-{id}")}}).to_string()
                    ],
                )
                .unwrap();
        }
        task(&connection, "z-unreferenced", "completed", json!(1));
        let policy = RetentionPolicy {
            batch_size: 2,
            ..RetentionPolicy::default()
        };
        let first = prune_batch(&mut connection, &policy, 45 * DAY_MS).unwrap();
        assert_eq!(
            (first.deleted_tasks, first.scanned_tasks, first.revision),
            (0, 8, 0)
        );
        let second = prune_batch(&mut connection, &policy, 45 * DAY_MS).unwrap();
        assert_eq!(
            (second.deleted_tasks, second.scanned_tasks, second.revision),
            (1, 5, 1)
        );
        assert_eq!(
            count(&connection, "SELECT count(*) FROM orchestration_tasks").unwrap(),
            12
        );
        assert!(!second.eligibility_exact);
    }
    #[test]
    fn single_row_batches_allow_both_tables_to_progress() {
        let mut connection = database();
        task(&connection, "task", "completed", json!(1));
        delivery(&connection, "delivery", "delivered", json!({}));
        let policy = RetentionPolicy {
            batch_size: 1,
            ..RetentionPolicy::default()
        };
        let first = prune_batch(&mut connection, &policy, 45 * DAY_MS).unwrap();
        let second = prune_batch(&mut connection, &policy, 45 * DAY_MS).unwrap();
        assert_eq!(first.deleted_tasks + second.deleted_tasks, 1);
        assert_eq!(first.deleted_outbox + second.deleted_outbox, 1);
    }

    #[test]
    fn capacity_triggers_above_five_thousand_but_preserves_recent_receipts() {
        let mut connection = database();
        for n in 0..5000 {
            task(&connection, &format!("t{n:05}"), "completed", json!(1));
        }
        let policy = RetentionPolicy::default();
        assert_eq!(capacity_excess(&connection, &policy).unwrap(), 0);
        let at_target = prune_batch(&mut connection, &policy, DAY_MS).unwrap();
        assert!(!at_target.capacity_triggered);
        assert_eq!(at_target.deleted_tasks, 0);
        task(&connection, "newest", "completed", json!(2));
        connection
            .execute(
                "UPDATE orchestration_tasks SET updated_at=2 WHERE id='newest'",
                [],
            )
            .unwrap();
        let result = prune_batch(&mut connection, &policy, DAY_MS).unwrap();
        assert!(result.capacity_triggered);
        assert_eq!(result.capacity_excess, 1);
        assert_eq!(result.deleted_tasks, 0);
        assert_eq!(
            count(&connection, "SELECT count(*) FROM orchestration_tasks").unwrap(),
            5001
        );
        let inventory = report(&connection, &policy, DAY_MS).unwrap();
        assert_eq!(inventory.capacity_excess, 1);
        assert_eq!(inventory.eligible_tasks, 0);

        // Once the minimum horizon expires, regular cleanup may remove a full
        // batch even if the soft target was exceeded by only one receipt.
        let expired = prune_batch(&mut connection, &policy, 45 * DAY_MS).unwrap();
        assert!(expired.capacity_triggered);
        assert_eq!(expired.deleted_tasks, policy.batch_size as u64);
        assert_eq!(
            count(&connection, "SELECT count(*) FROM orchestration_tasks").unwrap(),
            4501
        );
        assert_eq!(
            count(
                &connection,
                "SELECT count(*) FROM orchestration_tasks WHERE id='newest'"
            )
            .unwrap(),
            1
        );
        let below_target = prune_batch(&mut connection, &policy, 45 * DAY_MS).unwrap();
        assert!(!below_target.capacity_triggered);
        assert_eq!(below_target.deleted_tasks, policy.batch_size as u64);
    }
    #[test]
    fn capacity_counts_only_terminal_receipts_not_activity_or_dead_letters() {
        let connection = database();
        for n in 0..100 {
            task(&connection, &format!("running-{n}"), "running", json!(1));
            delivery(&connection, &format!("pending-{n}"), "pending", json!({}));
            delivery(&connection, &format!("leased-{n}"), "leased", json!({}));
            delivery(&connection, &format!("dead-{n}"), "dead-letter", json!({}));
        }
        let policy = RetentionPolicy {
            max_records: 2,
            ..RetentionPolicy::default()
        };
        assert_eq!(capacity_excess(&connection, &policy).unwrap(), 0);
        task(&connection, "finished", "failed", json!(1));
        delivery(&connection, "cancelled", "cancelled", json!({}));
        assert_eq!(capacity_excess(&connection, &policy).unwrap(), 0);
        delivery(&connection, "sent", "delivered", json!({}));
        assert_eq!(capacity_excess(&connection, &policy).unwrap(), 1);
        let inventory = report(&connection, &policy, DAY_MS).unwrap();
        assert_eq!((inventory.total_tasks, inventory.total_outbox), (101, 302));
        assert_eq!(
            (inventory.terminal_tasks, inventory.terminal_outbox),
            (1, 2)
        );
        assert_eq!(inventory.capacity_excess, 1);
        assert_eq!(inventory.eligible_tasks + inventory.eligible_outbox, 0);
    }
    #[test]
    fn capacity_includes_both_receipt_tables_and_never_deletes_protected_records() {
        let mut connection = database();
        task(&connection, "running", "running", json!(1));
        task(&connection, "protected", "completed", json!(1));
        task(&connection, "protected-2", "completed", json!(1));
        task(&connection, "disposable", "completed", json!(1));
        delivery(
            &connection,
            "dead",
            "dead-letter",
            json!({"payload":{"taskId":"cli-protected"},"source":{"taskId":"cli-protected-2"}}),
        );
        delivery(&connection, "sent", "delivered", json!({}));
        let policy = RetentionPolicy {
            max_records: 1,
            ..RetentionPolicy::default()
        };
        let first = prune_batch(&mut connection, &policy, 45 * DAY_MS).unwrap();
        assert_eq!((first.deleted_tasks, first.deleted_outbox), (1, 1));
        assert_eq!(capacity_excess(&connection, &policy).unwrap(), 1);
        let second = prune_batch(&mut connection, &policy, 45 * DAY_MS).unwrap();
        assert!(second.capacity_triggered);
        assert_eq!(second.deleted_tasks + second.deleted_outbox, 0);
        assert_eq!(
            count(&connection, "SELECT count(*) FROM orchestration_tasks").unwrap(),
            3
        );
    }
    #[test]
    fn capacity_probe_and_deletion_are_bounded() {
        let mut connection = database();
        for n in 0..40 {
            task(&connection, &format!("t{n}"), "completed", json!(1));
        }
        let policy = RetentionPolicy {
            max_records: 5,
            batch_size: 3,
            ..RetentionPolicy::default()
        };
        assert_eq!(capacity_excess(&connection, &policy).unwrap(), 3);
        let result = prune_batch(&mut connection, &policy, 45 * DAY_MS).unwrap();
        assert_eq!(result.deleted_tasks, 3);
        assert!(result.scanned_tasks <= 12);
        assert_eq!(result.revision, 1);
    }

    #[cfg(unix)]
    #[test]
    fn maintenance_lock_unifies_symlinks_and_rejects_hardlinks() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "multicc-retention-lock-{}-{stamp}",
            std::process::id()
        ));
        std::fs::create_dir(&directory).unwrap();
        let database = directory.join("database.sqlite");
        std::fs::write(&database, b"").unwrap();
        let alias = directory.join("alias.sqlite");
        std::os::unix::fs::symlink(&database, &alias).unwrap();
        assert_eq!(
            MaintenanceGuard::lock_path(&database).unwrap(),
            MaintenanceGuard::lock_path(&alias).unwrap()
        );
        let shared = MaintenanceGuard::shared(&database).unwrap();
        assert!(MaintenanceGuard::exclusive(&alias).is_err());
        drop(shared);
        let exclusive = MaintenanceGuard::exclusive(&alias).unwrap();
        assert!(MaintenanceGuard::shared(&database).is_err());
        drop(exclusive);
        let hardlink = directory.join("hardlink.sqlite");
        std::fs::hard_link(&database, &hardlink).unwrap();
        assert!(MaintenanceGuard::exclusive(&hardlink).is_err());
        assert!(MaintenanceGuard::shared(&database).is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }
}
