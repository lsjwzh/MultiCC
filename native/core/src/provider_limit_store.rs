//! Transactional owner for the existing provider-limit SQLite schema.
//!
//! This is deliberately not wired into production yet: the asynchronous
//! opening/import path and compatibility callbacks must be connected together
//! before the Node connection can be removed. Existing database files keep the
//! same schema and column names, so independently verified cutover and rollback
//! do not require a data format conversion.
use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

use fs2::FileExt;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};

use crate::{
    js::{self, JsValue},
    provider_limit_policy,
    quota_guard::{object, prop},
};

type Result<T> = std::result::Result<T, String>;
fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}

const COLUMNS: &str = "app_type,provider_id,kind,status,summary_json,summary_text,bar_text,\
    fetched_at,updated_at,last_error,last_error_code,last_error_at,last_attempt_at";
const SCHEMA: &str = "CREATE TABLE provider_limit_meta (key TEXT PRIMARY KEY,value_json TEXT NOT NULL) WITHOUT ROWID;
    CREATE TABLE provider_limit_cache (app_type TEXT NOT NULL,provider_id TEXT NOT NULL,kind TEXT,status TEXT,
    summary_json TEXT,summary_text TEXT,bar_text TEXT,fetched_at INTEGER,updated_at INTEGER,last_error TEXT,
    last_error_code TEXT,last_error_at INTEGER,last_attempt_at INTEGER,PRIMARY KEY(app_type,provider_id)) WITHOUT ROWID;
    CREATE INDEX idx_provider_limit_updated ON provider_limit_cache(updated_at);";
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Read the prior StateStore envelope without changing either the primary or
/// its rolling backups. A damaged primary may be recovered from the newest
/// readable backup; an absent primary does not trigger backup recovery.
pub fn read_legacy(file: &Path) -> Result<Option<JsValue>> {
    Ok(read_legacy_snapshot(file)?.map(|(data, _)| data))
}

// Keep the exact primary bytes paired with the parsed value: rereading the
// primary after parsing could archive a newer file whose contents were never
// imported. Backups may provide the value but the primary is what is archived.
fn read_legacy_snapshot(file: &Path) -> Result<Option<(JsValue, Vec<u8>)>> {
    if !file.try_exists().map_err(err)? {
        return Ok(None);
    }
    fn read_envelope(bytes: &[u8]) -> Result<JsValue> {
        let parsed = js::json_parse(&String::from_utf8_lossy(bytes)).map_err(err)?;
        if !matches!(parsed, JsValue::Object(_))
            || !js::truthy(prop(&parsed, "__multiccSchema"))
            || parsed.get("data").is_none()
        {
            return Err("invalid provider limit legacy envelope".into());
        }
        Ok(prop(&parsed, "data").clone())
    }
    let primary = fs::read(file).map_err(err)?;
    if let Ok(data) = read_envelope(&primary) {
        return Ok(Some((data, primary)));
    }
    for index in 1..=3 {
        let mut name = file.as_os_str().to_os_string();
        name.push(format!(".bak{index}"));
        if let Ok(bytes) = fs::read(Path::new(&name)) {
            if let Ok(data) = read_envelope(&bytes) {
                return Ok(Some((data, primary)));
            }
        }
    }
    // Match the former noncritical cache behavior: invalid/unreadable input is
    // not archived and cannot be mistaken for a successful import.
    Ok(None)
}

struct TemporaryFile(PathBuf);
impl Drop for TemporaryFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
        let _ = fs::remove_file(format!("{}-journal", self.0.display()));
    }
}

fn private_file(file: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for (index, path) in [
            file.to_path_buf(),
            PathBuf::from(format!("{}-wal", file.display())),
            PathBuf::from(format!("{}-shm", file.display())),
        ]
        .iter()
        .enumerate()
        {
            if let Err(error) = fs::set_permissions(path, fs::Permissions::from_mode(0o600)) {
                if index == 0 || error.kind() != std::io::ErrorKind::NotFound {
                    return Err(err(error));
                }
            }
        }
    }
    #[cfg(not(unix))]
    let _ = file;
    Ok(())
}

/// Build, verify and flush a complete database before publishing it. Older
/// versions must never observe an empty file with an import still pending.
fn create_database(
    file: &Path,
    now: f64,
    source: Option<&[(crate::js::JsString, JsValue)]>,
) -> Result<bool> {
    let parent = file
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let mut directory = fs::DirBuilder::new();
    directory.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        directory.mode(0o700);
    }
    directory.create(parent).map_err(err)?;
    let temp = TemporaryFile(PathBuf::from(format!(
        "{}.migrating.{}.{}",
        file.display(),
        std::process::id(),
        TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    drop(options.open(&temp.0).map_err(err)?);
    let mut connection = Connection::open(&temp.0).map_err(err)?;
    connection
        .execute_batch("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;")
        .map_err(err)?;
    connection.execute_batch(SCHEMA).map_err(err)?;
    for (key, value) in [
        ("databaseSchemaVersion", "1".to_string()),
        ("migratedFromJson", "false".to_string()),
        ("legacyEntryCount", "0".to_string()),
        ("legacyImportPending", "false".to_string()),
        (
            "migratedAt",
            js::json_stringify(&JsValue::Number(now)).ok_or("invalid timestamp")?,
        ),
    ] {
        connection
            .execute(
                "INSERT INTO provider_limit_meta(key,value_json) VALUES (?1,?2)",
                params![key, value],
            )
            .map_err(err)?;
    }
    if let Some(values) = source {
        import_rows(&mut connection, values, true)?;
    }
    connection.close().map_err(|(_, error)| err(error))?;
    fs::File::open(&temp.0)
        .and_then(|f| f.sync_all())
        .map_err(err)?;
    let created = match fs::hard_link(&temp.0, file) {
        Ok(()) => true,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => false,
        Err(error) => return Err(err(error)),
    };
    #[cfg(unix)]
    fs::File::open(parent)
        .and_then(|f| f.sync_all())
        .map_err(err)?;
    Ok(created)
}

fn entries(data: &JsValue) -> Vec<(crate::js::JsString, JsValue)> {
    match prop(data, "entries") {
        JsValue::Object(values) => values.clone(),
        JsValue::Array(values) => values
            .iter()
            .enumerate()
            .map(|(i, value)| (i.to_string().into(), value.clone()))
            .collect(),
        _ => Vec::new(),
    }
}

fn defaulted(value: &JsValue, fallback: JsValue) -> JsValue {
    if value.is_nullish() {
        fallback
    } else {
        value.clone()
    }
}

fn canonical_entry(entry: &JsValue) -> Result<JsValue> {
    if entry.is_nullish() {
        return Err("invalid null legacy entry".into());
    }
    Ok(object(vec![
        ("appType", defaulted(prop(entry, "appType"), JsValue::Null)),
        (
            "providerId",
            defaulted(prop(entry, "providerId"), JsValue::Null),
        ),
        ("kind", defaulted(prop(entry, "kind"), JsValue::Null)),
        ("status", defaulted(prop(entry, "status"), JsValue::Null)),
        ("summary", defaulted(prop(entry, "summary"), JsValue::Null)),
        (
            "summaryText",
            defaulted(prop(entry, "summaryText"), "".into()),
        ),
        ("barText", defaulted(prop(entry, "barText"), JsValue::Null)),
        (
            "fetchedAt",
            defaulted(prop(entry, "fetchedAt"), JsValue::Null),
        ),
        ("updatedAt", defaulted(prop(entry, "updatedAt"), 0.0.into())),
        (
            "lastError",
            defaulted(prop(entry, "lastError"), JsValue::Null),
        ),
        (
            "lastErrorCode",
            defaulted(prop(entry, "lastErrorCode"), JsValue::Null),
        ),
        (
            "lastErrorAt",
            defaulted(prop(entry, "lastErrorAt"), JsValue::Null),
        ),
        (
            "lastAttemptAt",
            defaulted(prop(entry, "lastAttemptAt"), JsValue::Null),
        ),
    ]))
}

fn legacy_row(key: &crate::js::JsString, value: &JsValue) -> Result<JsValue> {
    if !matches!(value, JsValue::Object(_) | JsValue::Array(_)) {
        return Err("invalid provider limit legacy entry".into());
    }
    let key = key.to_string_lossy();
    let (app_type, provider_id) = match key.split_once(':') {
        Some((app, id)) => (app.to_string(), id.to_string()),
        None => {
            let app = prop(value, "appType");
            let id = prop(value, "providerId");
            (
                if js::truthy(app) {
                    js::js_to_string(app).to_string_lossy()
                } else {
                    "claude".into()
                },
                if js::truthy(id) {
                    js::js_to_string(id).to_string_lossy()
                } else {
                    key
                },
            )
        }
    };
    let string = |name| {
        let item = prop(value, name);
        if item.is_nullish() {
            JsValue::Null
        } else {
            JsValue::String(js::js_to_string(item))
        }
    };
    let number = |name, fallback: JsValue| {
        let item = prop(value, name);
        if item.is_nullish() {
            fallback
        } else {
            JsValue::Number(js::js_to_number(item).trunc())
        }
    };
    let text = prop(value, "summaryText");
    Ok(object(vec![
        ("appType", app_type.into()),
        ("providerId", provider_id.into()),
        ("kind", string("kind")),
        ("status", string("status")),
        ("summary", defaulted(prop(value, "summary"), JsValue::Null)),
        (
            "summaryText",
            if text.is_nullish() {
                "".into()
            } else {
                JsValue::String(js::js_to_string(text))
            },
        ),
        ("barText", string("barText")),
        ("fetchedAt", number("fetchedAt", JsValue::Null)),
        ("updatedAt", number("updatedAt", 0.0.into())),
        ("lastError", string("lastError")),
        ("lastErrorCode", string("lastErrorCode")),
        ("lastErrorAt", number("lastErrorAt", JsValue::Null)),
        ("lastAttemptAt", number("lastAttemptAt", JsValue::Null)),
    ]))
}

fn stable(value: &JsValue) -> JsValue {
    match value {
        JsValue::Array(values) => JsValue::Array(values.iter().map(stable).collect()),
        JsValue::Object(values) => {
            let mut values: Vec<_> = values
                .iter()
                .map(|(key, value)| (key.clone(), stable(value)))
                .collect();
            values.sort_by(|left, right| left.0.cmp(&right.0));
            JsValue::Object(values)
        }
        value => value.clone(),
    }
}

fn canonical_json(value: &JsValue) -> Result<String> {
    js::json_stringify(&stable(value)).ok_or_else(|| "legacy JSON cannot be serialized".into())
}

fn archive_legacy(file: &Path, expected: &[u8]) -> Result<PathBuf> {
    if fs::read(file).map_err(err)? != expected {
        return Err("legacy cache changed during migration; retained for retry".into());
    }
    let mut index = 1usize;
    loop {
        let mut name = file.as_os_str().to_os_string();
        name.push(if index == 1 {
            ".migrated".to_string()
        } else {
            format!(".migrated.{index}")
        });
        let target = PathBuf::from(name);
        match fs::hard_link(file, &target) {
            Ok(()) => {
                if fs::read(&target).map_err(err)? != expected
                    || fs::read(file).map_err(err)? != expected
                {
                    let _ = fs::remove_file(&target);
                    return Err("legacy cache changed during archive; retained for retry".into());
                }
                fs::remove_file(file).map_err(err)?;
                #[cfg(unix)]
                if let Some(parent) = file.parent().filter(|path| !path.as_os_str().is_empty()) {
                    fs::File::open(parent)
                        .and_then(|f| f.sync_all())
                        .map_err(err)?;
                }
                return Ok(target);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => index += 1,
            Err(error) => return Err(err(error)),
        }
    }
}

fn migration_lock(file: &Path) -> Result<fs::File> {
    let parent = file
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let mut directory = fs::DirBuilder::new();
    directory.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        directory.mode(0o700);
    }
    directory.create(parent).map_err(err)?;
    let mut lock_path = file.as_os_str().to_os_string();
    lock_path.push(".migration.lock");
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let handle = options.open(Path::new(&lock_path)).map_err(err)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        handle
            .set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(err)?;
    }
    handle.lock_exclusive().map_err(err)?;
    Ok(handle)
}

fn optional_string(value: Option<String>) -> JsValue {
    value.map_or(JsValue::Null, JsValue::from)
}
fn optional_number(value: Option<f64>) -> JsValue {
    value.map_or(JsValue::Null, JsValue::Number)
}

fn read_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<JsValue> {
    let summary: Option<String> = row.get(4)?;
    let summary = match summary {
        Some(raw) => js::json_parse(&raw).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                4,
                rusqlite::types::Type::Text,
                Box::new(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    error.to_string(),
                )),
            )
        })?,
        None => JsValue::Null,
    };
    Ok(object(vec![
        ("appType", JsValue::from(row.get::<_, String>(0)?)),
        ("providerId", JsValue::from(row.get::<_, String>(1)?)),
        ("kind", optional_string(row.get(2)?)),
        ("status", optional_string(row.get(3)?)),
        ("summary", summary),
        (
            "summaryText",
            JsValue::from(row.get::<_, Option<String>>(5)?.unwrap_or_default()),
        ),
        ("barText", optional_string(row.get(6)?)),
        ("fetchedAt", optional_number(row.get(7)?)),
        ("updatedAt", optional_number(row.get(8)?)),
        ("lastError", optional_string(row.get(9)?)),
        ("lastErrorCode", optional_string(row.get(10)?)),
        ("lastErrorAt", optional_number(row.get(11)?)),
        ("lastAttemptAt", optional_number(row.get(12)?)),
    ]))
}

fn lookup(connection: &Connection, app_type: &str, provider_id: &str) -> Result<Option<JsValue>> {
    connection
        .query_row(
            &format!(
                "SELECT {COLUMNS} FROM provider_limit_cache WHERE app_type=?1 AND provider_id=?2"
            ),
            params![app_type, provider_id],
            read_row,
        )
        .optional()
        .map_err(err)
}

fn sql_text(value: &JsValue) -> Result<Option<String>> {
    match value {
        JsValue::Null | JsValue::Undefined => Ok(None),
        JsValue::String(value) => Ok(Some(value.to_string_lossy())),
        _ => Err("cache text field is not a string".into()),
    }
}
fn sql_number(value: &JsValue) -> Result<Option<f64>> {
    match value {
        JsValue::Null | JsValue::Undefined => Ok(None),
        JsValue::Number(value) => Ok(Some(*value)),
        _ => Err("cache timestamp is not a number".into()),
    }
}

fn write_row(connection: &Connection, row: &JsValue) -> Result<()> {
    let summary = prop(row, "summary");
    let summary = if summary.is_nullish() {
        None
    } else {
        Some(
            js::json_stringify(summary)
                .ok_or_else(|| "summary is not JSON serializable".to_string())?,
        )
    };
    connection.execute(
        "INSERT INTO provider_limit_cache(app_type,provider_id,kind,status,summary_json,summary_text,bar_text,\
         fetched_at,updated_at,last_error,last_error_code,last_error_at,last_attempt_at)\
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)\
         ON CONFLICT(app_type,provider_id) DO UPDATE SET kind=excluded.kind,status=excluded.status,\
         summary_json=excluded.summary_json,summary_text=excluded.summary_text,bar_text=excluded.bar_text,\
         fetched_at=excluded.fetched_at,updated_at=excluded.updated_at,last_error=excluded.last_error,\
         last_error_code=excluded.last_error_code,last_error_at=excluded.last_error_at,\
         last_attempt_at=excluded.last_attempt_at",
        params![
            sql_text(prop(row, "appType"))?, sql_text(prop(row, "providerId"))?,
            sql_text(prop(row, "kind"))?, sql_text(prop(row, "status"))?, summary,
            sql_text(prop(row, "summaryText"))?, sql_text(prop(row, "barText"))?,
            sql_number(prop(row, "fetchedAt"))?, sql_number(prop(row, "updatedAt"))?,
            sql_text(prop(row, "lastError"))?, sql_text(prop(row, "lastErrorCode"))?,
            sql_number(prop(row, "lastErrorAt"))?, sql_number(prop(row, "lastAttemptAt"))?,
        ],
    ).map_err(err)?;
    Ok(())
}

fn import_rows_locked(
    tx: &Connection,
    values: &[(crate::js::JsString, JsValue)],
    verify: bool,
) -> Result<usize> {
    let mut imported = 0usize;
    for (key, value) in values {
        if !matches!(value, JsValue::Object(_) | JsValue::Array(_)) {
            return Err("legacy cache verification failed: invalid row".into());
        }
        let row = legacy_row(key, value)?;
        let app = js::js_to_string(prop(&row, "appType")).to_string_lossy();
        let id = js::js_to_string(prop(&row, "providerId")).to_string_lossy();
        let previous = lookup(tx, &app, &id)?;
        if let Some(existing) = &previous {
            if !verify {
                let identical = canonical_json(&canonical_entry(&row)?)?
                    == canonical_json(&canonical_entry(existing)?)?;
                let old_time = js::js_to_number(prop(&row, "updatedAt"));
                let current_time = js::js_to_number(prop(existing, "updatedAt"));
                if !identical
                    && (!old_time.is_finite()
                        || !current_time.is_finite()
                        || old_time >= current_time)
                {
                    return Err(
                        "legacy cache conflicts with existing row; retained for inspection".into(),
                    );
                }
            }
        }
        if previous.is_some() && !verify {
            imported += 1;
            continue;
        }
        if previous.is_some() {
            return Err("legacy cache verification failed: duplicate key".into());
        }
        write_row(tx, &row)?;
        let reconstructed =
            lookup(tx, &app, &id)?.ok_or("legacy cache row missing after insert")?;
        if verify
            && (!key.is_well_formed()
                || key.to_string_lossy() != format!("{app}:{id}")
                || canonical_json(&canonical_entry(value)?)?
                    != canonical_json(&canonical_entry(&reconstructed)?)?)
        {
            return Err("legacy cache verification failed: contents differ".into());
        }
        imported += 1;
    }
    if verify {
        for (key, value) in [
            ("migratedFromJson", "true".to_string()),
            ("legacyEntryCount", imported.to_string()),
            ("legacyImportPending", "false".to_string()),
        ] {
            tx.execute(
                "INSERT OR REPLACE INTO provider_limit_meta(key,value_json) VALUES (?1,?2)",
                params![key, value],
            )
            .map_err(err)?;
        }
    }
    Ok(imported)
}

fn import_rows(
    connection: &mut Connection,
    values: &[(crate::js::JsString, JsValue)],
    verify: bool,
) -> Result<usize> {
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(err)?;
    let imported = import_rows_locked(&tx, values, verify)?;
    tx.commit().map_err(err)?;
    Ok(imported)
}

// Subscription readers can create the shared database before the quota
// cache opens. Add the quota schema and import atomically without replacing
// the existing file or losing subscription rows. Unknown/partial layouts are
// rejected rather than treated as a new cache.
fn initialize_shared_database(
    file: &Path,
    now: f64,
    source: Option<&[(crate::js::JsString, JsValue)]>,
) -> Result<bool> {
    private_file(file)?;
    let mut connection =
        Connection::open_with_flags(file, OpenFlags::SQLITE_OPEN_READ_WRITE).map_err(err)?;
    connection
        .busy_timeout(Duration::from_millis(4_000))
        .map_err(err)?;
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(err)?;
    let integrity: String = tx
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(err)?;
    if integrity != "ok" {
        return Err(format!("quick_check failed: {integrity}"));
    }
    let names = {
        let mut query = tx
            .prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            )
            .map_err(err)?;
        let rows = query
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(err)?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(err)?
    };
    let has_meta = names.iter().any(|name| name == "provider_limit_meta");
    let has_cache = names.iter().any(|name| name == "provider_limit_cache");
    if has_meta && has_cache {
        tx.commit().map_err(err)?;
        return Ok(false);
    }
    if has_meta || has_cache || names.iter().any(|name| name != "provider_subscriptions") {
        return Err("unsupported shared provider cache database layout".into());
    }
    tx.execute_batch(SCHEMA).map_err(err)?;
    for (key, value) in [
        ("databaseSchemaVersion", "1".to_string()),
        ("migratedFromJson", "false".to_string()),
        ("legacyEntryCount", "0".to_string()),
        ("legacyImportPending", "false".to_string()),
        (
            "migratedAt",
            js::json_stringify(&JsValue::Number(now)).ok_or("invalid timestamp")?,
        ),
    ] {
        tx.execute(
            "INSERT INTO provider_limit_meta(key,value_json) VALUES (?1,?2)",
            params![key, value],
        )
        .map_err(err)?;
    }
    if let Some(values) = source {
        import_rows_locked(&tx, values, true)?;
    }
    tx.commit().map_err(err)?;
    Ok(true)
}

fn apply_success(
    connection: &Connection,
    app_type: &str,
    provider_id: &str,
    previous: JsValue,
    entry: &JsValue,
    now: f64,
) -> Result<JsValue> {
    let time = prop(entry, "fetchedAt");
    let fetched_at = if time.is_nullish() {
        now
    } else {
        js::js_to_number(time).trunc()
    };
    let plan = provider_limit_policy::success(&object(vec![
        ("appType", app_type.into()),
        ("providerId", provider_id.into()),
        ("previous", previous),
        ("entry", entry.clone()),
        ("fetchedAt", fetched_at.into()),
        ("now", now.into()),
    ]));
    if prop(&plan, "write") == &JsValue::Bool(true) {
        write_row(connection, prop(&plan, "entry"))?;
    }
    Ok(plan)
}

pub struct Store {
    connection: Connection,
}

impl Store {
    /// Open with a crash-recoverable, gap-only import from the old StateStore
    /// JSON. The primary remains available until all imported rows commit and
    /// the original bytes have been checked again during archival.
    pub fn open(file: &Path, legacy: Option<&Path>, now: f64) -> Result<(Self, JsValue)> {
        let _migration_guard = migration_lock(file)?;
        let source = match legacy {
            Some(path) => {
                read_legacy_snapshot(path)?.map(|(data, bytes)| (path, bytes, entries(&data)))
            }
            None => None,
        };
        let mut created = if !file.try_exists().map_err(err)? {
            create_database(
                file,
                now,
                source.as_ref().map(|(_, _, values)| values.as_slice()),
            )?
        } else {
            false
        };
        if !created {
            created = initialize_shared_database(
                file,
                now,
                source.as_ref().map(|(_, _, values)| values.as_slice()),
            )?;
        }
        let mut store = Self::open_existing(file)?;
        let pending: Option<String> = store
            .connection
            .query_row(
                "SELECT value_json FROM provider_limit_meta WHERE key='legacyImportPending'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(err)?;
        let verify_import = pending.as_deref() == Some("true");
        if verify_import && source.is_none() {
            return Err("pending legacy cache import has no readable source".into());
        }
        let mut imported = 0usize;
        let mut migrated = verify_import || (created && source.is_some());
        let mut archived = JsValue::Null;
        if let Some((source_file, bytes, values)) = source {
            if created {
                imported = values.len();
            } else if !values.is_empty() || verify_import {
                imported = import_rows(&mut store.connection, &values, verify_import)?;
                if !values.is_empty() {
                    migrated = true;
                }
            }
            archived = JsValue::from(
                archive_legacy(source_file, &bytes)?
                    .to_string_lossy()
                    .into_owned(),
            );
        }
        let result = object(vec![
            ("migrated", migrated.into()),
            ("legacyEntryCount", (imported as f64).into()),
            ("archivedJsonFile", archived),
            ("created", created.into()),
        ]);
        Ok((store, result))
    }

    /// Opens an existing cache or creates an empty one. Until the full legacy
    /// import/catch-up path is implemented, any existing legacy file fails
    /// closed and remains untouched, even when the SQLite file is present.
    pub fn open_without_legacy(file: &Path, legacy: Option<&Path>, now: f64) -> Result<Self> {
        if let Some(legacy) = legacy {
            if legacy.try_exists().map_err(err)? {
                return Err("provider limit legacy JSON import has not been migrated".into());
            }
        }
        if !file.try_exists().map_err(err)? {
            let _ = create_database(file, now, None)?;
        }
        Self::open_existing(file)
    }

    /// Opening an existing DB never creates an empty replacement for a missing
    /// file. Legacy import and new-file creation are separate cutover work.
    pub fn open_existing(file: &Path) -> Result<Self> {
        private_file(file)?;
        let connection =
            Connection::open_with_flags(file, OpenFlags::SQLITE_OPEN_READ_WRITE).map_err(err)?;
        connection
            .busy_timeout(Duration::from_millis(4_000))
            .map_err(err)?;
        let integrity: String = connection
            .query_row("PRAGMA quick_check", [], |row| row.get(0))
            .map_err(err)?;
        if integrity != "ok" {
            return Err(format!("quick_check failed: {integrity}"));
        }
        let version: Option<String> = connection
            .query_row(
                "SELECT value_json FROM provider_limit_meta WHERE key='databaseSchemaVersion'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(err)?;
        if version.as_deref() != Some("1") {
            return Err(format!("unsupported provider limit schema: {version:?}"));
        }
        // Prepare the complete projection up front so missing columns fail
        // during open, before any write can change an incompatible database.
        connection
            .prepare(&format!(
                "SELECT {COLUMNS} FROM provider_limit_cache LIMIT 0"
            ))
            .map_err(err)?;
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .map_err(err)?;
        connection
            .pragma_update(None, "synchronous", "NORMAL")
            .map_err(err)?;
        connection
            .pragma_update(None, "secure_delete", "ON")
            .map_err(err)?;
        connection
            .pragma_update(None, "wal_autocheckpoint", 1000)
            .map_err(err)?;
        private_file(file)?;
        Ok(Self { connection })
    }

    pub fn get(&self, app_type: &str, provider_id: &str) -> Result<Option<JsValue>> {
        lookup(&self.connection, app_type, provider_id)
    }

    /// Read the previous row, decide and write under the same SQLite write
    /// lock. This closes the lost-update window between competing instances.
    pub fn record(
        &mut self,
        app_type: &str,
        provider_id: &str,
        entry: &JsValue,
        now: f64,
    ) -> Result<JsValue> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(err)?;
        let previous = lookup(&tx, app_type, provider_id)?.unwrap_or(JsValue::Null);
        let result = apply_success(&tx, app_type, provider_id, previous, entry, now)?;
        tx.commit().map_err(err)?;
        Ok(result)
    }

    /// Finish an existing Rust recorder rule while holding the same write
    /// transaction that reads the previous observation and saves the result.
    /// This avoids a get/compute/record race when callers move off sync SQLite.
    pub fn record_derived(
        &mut self,
        app_type: &str,
        provider_id: &str,
        operation: &str,
        arguments: &JsValue,
        now: f64,
    ) -> Result<JsValue> {
        if !["dtoFinish", "vendorRecord", "officialRecord"].contains(&operation) {
            return Err("unsupported provider limit derived record".into());
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(err)?;
        let previous = lookup(&tx, app_type, provider_id)?.unwrap_or(JsValue::Null);
        let mut input = arguments.clone();
        if !matches!(input, JsValue::Object(_)) {
            return Err("invalid recorder arguments".into());
        }
        let summary = if previous.is_nullish() {
            JsValue::Null
        } else {
            object(vec![("summary", prop(&previous, "summary").clone())])
        };
        crate::quota_guard::set(&mut input, "previous", summary);
        let entry = crate::limit_cache_recorder::request(operation, &input);
        if !js::truthy(&entry) {
            tx.commit().map_err(err)?;
            return Ok(object(vec![
                ("write", false.into()),
                ("entry", JsValue::Null),
            ]));
        }
        let result = apply_success(&tx, app_type, provider_id, previous, &entry, now)?;
        tx.commit().map_err(err)?;
        Ok(result)
    }

    pub fn record_failure(
        &mut self,
        app_type: &str,
        provider_id: &str,
        meta: &JsValue,
        now: f64,
    ) -> Result<JsValue> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(err)?;
        let previous = lookup(&tx, app_type, provider_id)?.unwrap_or(JsValue::Null);
        let result = provider_limit_policy::failure(&object(vec![
            ("appType", app_type.into()),
            ("providerId", provider_id.into()),
            ("previous", previous),
            ("meta", meta.clone()),
            ("now", now.into()),
        ]));
        write_row(&tx, &result)?;
        tx.commit().map_err(err)?;
        Ok(result)
    }

    /// Apply a rejection or credential recovery against the row protected by
    /// the write transaction, including the preserve and model-scope rules.
    pub fn transition_availability(
        &mut self,
        app_type: &str,
        provider_id: &str,
        input: &JsValue,
        now: f64,
    ) -> Result<JsValue> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(err)?;
        let previous = lookup(&tx, app_type, provider_id)?.unwrap_or(JsValue::Null);
        let summary = if previous.is_nullish() {
            JsValue::Null
        } else {
            object(vec![("summary", prop(&previous, "summary").clone())])
        };
        let rule = |op: &str, value: JsValue| crate::limit_cache_recorder::request(op, &value);
        let mut refresh = false;
        let entry = if prop(input, "release") == &JsValue::Bool(true) {
            if !js::truthy(&rule(
                "releaseEligible",
                object(vec![("entry", summary.clone())]),
            )) {
                JsValue::Null
            } else {
                rule("releaseRecord", object(vec![("now", now.into())]))
            }
        } else {
            let policy = rule(
                "failurePolicy",
                object(vec![
                    ("httpStatus", prop(input, "httpStatus").clone()),
                    ("targetKind", prop(input, "targetKind").clone()),
                    ("previous", summary.clone()),
                    ("now", now.into()),
                ]),
            );
            let revoked = js::truthy(&rule(
                "isRevokedCategory",
                object(vec![("category", prop(input, "category").clone())]),
            ));
            let rejection = prop(input, "rejection");
            let park = if revoked || !js::truthy(rejection) {
                JsValue::Null
            } else {
                rule(
                    "rejectionPark",
                    object(vec![("rejection", rejection.clone()), ("now", now.into())]),
                )
            };
            let action = rule(
                "failureCheck",
                object(vec![
                    ("category", prop(input, "category").clone()),
                    ("previous", summary.clone()),
                    ("policy", policy.clone()),
                    ("park", park.clone()),
                    ("rejection", prop(input, "hasRejection").clone()),
                    ("blockedUntilMs", prop(input, "blockedUntilMs").clone()),
                ]),
            );
            let long_park = action == JsValue::from("checkLong")
                && js::truthy(&rule(
                    "longPark",
                    object(vec![("previous", summary.clone()), ("now", now.into())]),
                ));
            if action == JsValue::from("preserve") || long_park {
                JsValue::Null
            } else {
                let plan = rule(
                    "cooldown",
                    object(vec![
                        ("category", prop(input, "category").clone()),
                        ("httpStatus", prop(input, "httpStatus").clone()),
                        ("blockedUntilMs", prop(input, "blockedUntilMs").clone()),
                        ("park", park),
                        ("now", now.into()),
                    ]),
                );
                refresh = prop(&policy, "refresh") != &JsValue::Bool(false);
                let keeps = js::truthy(prop(&plan, "needsPrevious"))
                    && js::truthy(&rule(
                        "keepsAccountPark",
                        object(vec![
                            ("previous", summary),
                            ("now", now.into()),
                            ("modelUntil", prop(&plan, "until").clone()),
                        ]),
                    ));
                if keeps {
                    JsValue::Null
                } else {
                    prop(&plan, "value").clone()
                }
            }
        };
        let mut result = if entry.is_nullish() {
            object(vec![("write", false.into()), ("entry", previous)])
        } else {
            apply_success(&tx, app_type, provider_id, previous, &entry, now)?
        };
        crate::quota_guard::set(&mut result, "refresh", refresh.into());
        tx.commit().map_err(err)?;
        Ok(result)
    }

    pub fn record_virtual_failure(
        &mut self,
        app_type: &str,
        provider_id: &str,
        input: &JsValue,
        now: f64,
    ) -> Result<JsValue> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(err)?;
        let previous = lookup(&tx, app_type, provider_id)?.unwrap_or(JsValue::Null);
        let mut args = input.clone();
        if !matches!(args, JsValue::Object(_)) {
            return Err("invalid virtual failure arguments".into());
        }
        crate::quota_guard::set(&mut args, "previous", prop(&previous, "summary").clone());
        crate::quota_guard::set(&mut args, "now", now.into());
        let raw = js::json_stringify(&args).ok_or("invalid virtual failure arguments")?;
        let computed = crate::virtual_provider::failure(&raw)?;
        let computed = js::json_parse(&computed).map_err(err)?;
        let record = prop(&computed, "record");
        let result = if record.is_nullish() {
            object(vec![("write", false.into()), ("entry", previous)])
        } else {
            apply_success(&tx, app_type, provider_id, previous, record, now)?
        };
        tx.commit().map_err(err)?;
        Ok(result)
    }

    pub fn snapshot(&self) -> Result<JsValue> {
        let mut statement = self
            .connection
            .prepare(&format!(
                "SELECT {COLUMNS} FROM provider_limit_cache ORDER BY app_type,provider_id"
            ))
            .map_err(err)?;
        let rows = statement.query_map([], read_row).map_err(err)?;
        let mut entries = Vec::new();
        let mut updated = 0.0f64;
        for row in rows {
            let row = row.map_err(err)?;
            let key = format!(
                "{}:{}",
                js::js_to_string(prop(&row, "appType")).to_string_lossy(),
                js::js_to_string(prop(&row, "providerId")).to_string_lossy()
            );
            let timestamp = js::js_to_number(prop(&row, "updatedAt"));
            if timestamp > updated {
                updated = timestamp;
            }
            entries.push((key, row));
        }
        Ok(object(vec![
            ("entries", JsValue::object(entries)),
            ("updatedAt", updated.into()),
        ]))
    }

    pub fn prune(&mut self, live_keys: &HashSet<String>) -> Result<usize> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(err)?;
        let mut removed = 0;
        {
            let mut query = tx
                .prepare("SELECT app_type,provider_id FROM provider_limit_cache")
                .map_err(err)?;
            let rows = query
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(err)?;
            for row in rows {
                let (app_type, id) = row.map_err(err)?;
                if !live_keys.contains(&format!("{app_type}:{id}")) {
                    removed += tx
                        .execute(
                            "DELETE FROM provider_limit_cache WHERE app_type=?1 AND provider_id=?2",
                            params![app_type, id],
                        )
                        .map_err(err)?;
                }
            }
        }
        tx.commit().map_err(err)?;
        Ok(removed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory() -> Store {
        let connection = Connection::open_in_memory().expect("in-memory SQLite");
        connection.execute_batch(
            "CREATE TABLE provider_limit_cache (app_type TEXT NOT NULL,provider_id TEXT NOT NULL,\
             kind TEXT,status TEXT,summary_json TEXT,summary_text TEXT,bar_text TEXT,fetched_at INTEGER,\
             updated_at INTEGER,last_error TEXT,last_error_code TEXT,last_error_at INTEGER,\
             last_attempt_at INTEGER,PRIMARY KEY(app_type,provider_id)) WITHOUT ROWID;"
        ).expect("schema");
        Store { connection }
    }

    #[test]
    fn transactional_success_failure_and_prune_keep_existing_contract() {
        let mut store = memory();
        let success = store
            .record(
                "claude",
                "p",
                &object(vec![
                    ("kind", "window".into()),
                    ("summaryText", "80%".into()),
                    ("summary", object(vec![("label", "中文".into())])),
                    ("fetchedAt", 100.0.into()),
                ]),
                100.0,
            )
            .unwrap();
        assert_eq!(prop(&success, "write"), &JsValue::Bool(true));
        let late = store
            .record(
                "claude",
                "p",
                &object(vec![
                    ("summaryText", "stale".into()),
                    ("fetchedAt", 99.0.into()),
                ]),
                200.0,
            )
            .unwrap();
        assert_eq!(prop(&late, "write"), &JsValue::Bool(false));
        let failure = store
            .record_failure(
                "claude",
                "p",
                &object(vec![("error", "offline".into())]),
                99.0,
            )
            .unwrap();
        assert_eq!(prop(&failure, "summaryText"), &JsValue::from("80%"));
        assert_eq!(prop(&failure, "updatedAt"), &JsValue::Number(101.0));
        assert_eq!(
            prop(&store.get("claude", "p").unwrap().unwrap(), "lastError"),
            &JsValue::from("offline")
        );
        assert_eq!(
            store
                .prune(&HashSet::from(["claude:p".to_string()]))
                .unwrap(),
            0
        );
        assert_eq!(store.prune(&HashSet::new()).unwrap(), 1);
        assert!(store.get("claude", "p").unwrap().is_none());
    }

    #[test]
    fn failed_serialization_leaves_existing_row_unchanged() {
        let mut store = memory();
        store
            .record(
                "claude",
                "p",
                &object(vec![("summaryText", "before".into())]),
                100.0,
            )
            .unwrap();
        let error = store.record(
            "claude",
            "p",
            &object(vec![("kind", JsValue::Array(vec![]))]),
            200.0,
        );
        assert!(error.is_err());
        let current = store.get("claude", "p").unwrap().unwrap();
        assert_eq!(prop(&current, "summaryText"), &JsValue::from("before"));
        assert_eq!(prop(&current, "fetchedAt"), &JsValue::Number(100.0));
    }

    #[test]
    fn derived_observation_reads_and_writes_in_one_transaction() {
        let mut store = memory();
        let old = object(vec![
            ("window", "1wk".into()),
            ("usedPercent", 20.0.into()),
            ("resetMs", 5_000.0.into()),
        ]);
        store
            .record(
                "claude",
                "p",
                &object(vec![
                    ("kind", "claude".into()),
                    ("fetchedAt", 100.0.into()),
                    (
                        "summary",
                        object(vec![
                            ("kind", "claude".into()),
                            ("status", "ok".into()),
                            ("windows", JsValue::Array(vec![old])),
                        ]),
                    ),
                ]),
                100.0,
            )
            .unwrap();
        let next = object(vec![
            ("window", "5h".into()),
            ("usedPercent", 40.0.into()),
            ("resetMs", 5_000.0.into()),
        ]);
        let plan = store
            .record_derived(
                "claude",
                "p",
                "officialRecord",
                &object(vec![
                    ("appType", "claude".into()),
                    ("at", 200.0.into()),
                    ("windows", JsValue::Array(vec![next])),
                ]),
                200.0,
            )
            .unwrap();
        assert_eq!(prop(&plan, "write"), &JsValue::Bool(true));
        let row = store.get("claude", "p").unwrap().unwrap();
        let JsValue::Array(windows) = prop(prop(&row, "summary"), "windows") else {
            panic!("windows")
        };
        assert_eq!(windows.len(), 2);
    }

    #[test]
    fn availability_transition_preserves_revocation_until_explicit_release() {
        let mut store = memory();
        let revoked = object(vec![
            ("category", "AUTHENTICATION_PERMISSION".into()),
            ("httpStatus", 401.0.into()),
        ]);
        let first = store
            .transition_availability("claude", "p", &revoked, 100.0)
            .unwrap();
        assert_eq!(prop(&first, "write"), &JsValue::Bool(true));
        assert_eq!(
            prop(prop(prop(&first, "entry"), "summary"), "revoked"),
            &JsValue::Bool(true)
        );
        let transient = object(vec![("category", "provider_transient".into())]);
        let held = store
            .transition_availability("claude", "p", &transient, 200.0)
            .unwrap();
        assert_eq!(prop(&held, "write"), &JsValue::Bool(false));
        assert_eq!(
            prop(prop(prop(&held, "entry"), "summary"), "revoked"),
            &JsValue::Bool(true)
        );
        let released = store
            .transition_availability(
                "claude",
                "p",
                &object(vec![("release", true.into())]),
                300.0,
            )
            .unwrap();
        assert_eq!(prop(&released, "write"), &JsValue::Bool(true));
        assert_eq!(
            prop(prop(prop(&released, "entry"), "summary"), "status"),
            &JsValue::from("available")
        );
        let again = store
            .transition_availability(
                "claude",
                "p",
                &object(vec![("release", true.into())]),
                400.0,
            )
            .unwrap();
        assert_eq!(prop(&again, "write"), &JsValue::Bool(false));
    }

    #[test]
    fn virtual_rejection_keeps_the_committed_window_reset() {
        let mut store = memory();
        store
            .record(
                "claude",
                "p",
                &object(vec![(
                    "summary",
                    object(vec![(
                        "windows",
                        JsValue::Array(vec![object(vec![
                            ("usedPercent", 100.0.into()),
                            ("resetMs", 9_000_000.0.into()),
                        ])]),
                    )]),
                )]),
                100.0,
            )
            .unwrap();
        let result = store
            .record_virtual_failure(
                "claude",
                "p",
                &object(vec![
                    ("providerId", "p".into()),
                    ("status", 429.0.into()),
                    ("headersSent", false.into()),
                ]),
                200.0,
            )
            .unwrap();
        assert_eq!(prop(&result, "write"), &JsValue::Bool(true));
        assert_eq!(
            prop(prop(prop(&result, "entry"), "summary"), "blockedUntilMs"),
            &JsValue::Number(9_000_000.0)
        );
    }

    #[test]
    fn new_cache_is_created_atomically_and_legacy_is_never_silently_skipped() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "multicc-limit-native-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).unwrap();
        let file = directory.join("limits.db");
        let legacy = directory.join("legacy.json");
        fs::write(&legacy, b"do not discard").unwrap();
        assert!(Store::open_without_legacy(&file, Some(&legacy), 100.0).is_err());
        assert!(!file.exists());
        assert_eq!(fs::read(&legacy).unwrap(), b"do not discard");
        fs::remove_file(&legacy).unwrap();
        let mut store = Store::open_without_legacy(&file, Some(&legacy), 100.0).unwrap();
        store
            .record(
                "claude",
                "p",
                &object(vec![("summaryText", "good".into())]),
                101.0,
            )
            .unwrap();
        drop(store);
        let reopened = Store::open_existing(&file).unwrap();
        assert_eq!(
            prop(
                &reopened.get("claude", "p").unwrap().unwrap(),
                "summaryText"
            ),
            &JsValue::from("good")
        );
        drop(reopened);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn legacy_read_recovers_backup_without_modifying_either_file() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "multicc-limit-legacy-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).unwrap();
        let file = directory.join("legacy.json");
        let backup = directory.join("legacy.json.bak1");
        fs::write(&file, b"broken").unwrap();
        fs::write(&backup, br#"{"__multiccSchema":{"kind":"cache"},"data":{"entries":{"claude:p":{"summaryText":"ok"}}}}"#).unwrap();
        let recovered = read_legacy(&file).unwrap().unwrap();
        assert_eq!(
            prop(prop(prop(&recovered, "entries"), "claude:p"), "summaryText"),
            &JsValue::from("ok")
        );
        assert_eq!(fs::read(&file).unwrap(), b"broken");
        assert!(backup.exists());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn legacy_archive_rejects_a_file_changed_after_its_snapshot() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "multicc-limit-change-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).unwrap();
        let file = directory.join("legacy.json");
        let old = br#"{"__multiccSchema":{"kind":"cache"},"data":{"entries":{}}}"#;
        let new = br#"{"__multiccSchema":{"kind":"cache"},"data":{"entries":{"claude:p":{}}}}"#;
        fs::write(&file, old).unwrap();
        let (_, bytes) = read_legacy_snapshot(&file).unwrap().unwrap();
        fs::write(&file, new).unwrap();
        assert!(archive_legacy(&file, &bytes).is_err());
        assert_eq!(fs::read(&file).unwrap(), new);
        assert!(!directory.join("legacy.json.migrated").exists());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn legacy_import_is_verified_archived_and_catchup_never_overwrites() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "multicc-limit-import-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("cache.db");
        let legacy = dir.join("cache.json");
        let body = br#"{"__multiccSchema":{"kind":"cache"},"data":{"entries":{"claude:p":{"appType":"claude","providerId":"p","kind":"window","status":"ok","summary":{"title":"\ud800"},"summaryText":"old","barText":null,"fetchedAt":100,"updatedAt":100,"lastError":null,"lastErrorCode":null,"lastErrorAt":null,"lastAttemptAt":100}}}}"#;
        fs::write(&legacy, body).unwrap();
        let (mut store, migration) = Store::open(&file, Some(&legacy), 100.0).unwrap();
        assert_eq!(prop(&migration, "migrated"), &JsValue::Bool(true));
        assert!(!legacy.exists());
        assert_eq!(fs::read(dir.join("cache.json.migrated")).unwrap(), body);
        store
            .record(
                "claude",
                "p",
                &object(vec![
                    ("summaryText", "new".into()),
                    ("fetchedAt", 200.0.into()),
                ]),
                200.0,
            )
            .unwrap();
        drop(store);
        fs::write(&legacy, body).unwrap();
        let (store, migration) = Store::open(&file, Some(&legacy), 300.0).unwrap();
        assert_eq!(prop(&migration, "migrated"), &JsValue::Bool(true));
        assert_eq!(
            prop(&store.get("claude", "p").unwrap().unwrap(), "summaryText"),
            &JsValue::from("new")
        );
        assert!(dir.join("cache.json.migrated.2").exists());
        drop(store);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn failed_legacy_verification_remains_pending_across_restart() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "multicc-limit-invalid-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("cache.db");
        let legacy = dir.join("cache.json");
        let body = br#"{"__multiccSchema":{"kind":"cache"},"data":{"entries":{"claude:p":{"summaryText":"missing identity"}}}}"#;
        fs::write(&legacy, body).unwrap();
        assert!(Store::open(&file, Some(&legacy), 1.0).is_err());
        assert!(Store::open(&file, Some(&legacy), 1.0).is_err());
        assert_eq!(fs::read(&legacy).unwrap(), body);
        assert!(!dir.join("cache.json.migrated").exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn changed_legacy_row_is_not_archived_over_an_older_database_value() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "multicc-limit-conflict-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("cache.db");
        let legacy = dir.join("cache.json");
        let mut store = Store::open_without_legacy(&file, Some(&legacy), 100.0).unwrap();
        store
            .record(
                "claude",
                "p",
                &object(vec![("summaryText", "old".into())]),
                100.0,
            )
            .unwrap();
        drop(store);
        let body = br#"{"__multiccSchema":{"kind":"cache"},"data":{"entries":{"claude:p":{"appType":"claude","providerId":"p","summaryText":"new","updatedAt":200}}}}"#;
        fs::write(&legacy, body).unwrap();
        assert!(Store::open(&file, Some(&legacy), 300.0).is_err());
        assert_eq!(fs::read(&legacy).unwrap(), body);
        assert!(!dir.join("cache.json.migrated").exists());
        let store = Store::open_existing(&file).unwrap();
        assert_eq!(
            prop(&store.get("claude", "p").unwrap().unwrap(), "summaryText"),
            &JsValue::from("old")
        );
        drop(store);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn subscription_first_database_keeps_subscription_rows_and_imports_legacy() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "multicc-limit-shared-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("cache.db");
        let legacy = dir.join("cache.json");
        let db = Connection::open(&file).unwrap();
        db.execute_batch("CREATE TABLE provider_subscriptions(vendor TEXT PRIMARY KEY, subscription_json TEXT); INSERT INTO provider_subscriptions VALUES('claude', '{\"status\":\"ok\"}');").unwrap();
        drop(db);
        fs::write(&legacy, br#"{"__multiccSchema":{"kind":"cache"},"data":{"entries":{"claude:p":{"appType":"claude","providerId":"p","summaryText":"old"}}}}"#).unwrap();
        let (store, _) = Store::open(&file, Some(&legacy), 100.0).unwrap();
        assert_eq!(
            prop(&store.get("claude", "p").unwrap().unwrap(), "summaryText"),
            &JsValue::from("old")
        );
        let subscriptions: i64 = store
            .connection
            .query_row("SELECT count(*) FROM provider_subscriptions", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(subscriptions, 1);
        drop(store);
        fs::remove_dir_all(dir).unwrap();
    }
}
