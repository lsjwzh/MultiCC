//! Explicit offline orchestration maintenance. No server is stopped by this tool.
use multicc_core::orchestration_retention::{self as retention, MaintenanceGuard, RetentionPolicy};
use rusqlite::{Connection, OpenFlags};
use serde_json::json;
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};

type Result<T> = std::result::Result<T, String>;
#[derive(Default)]
struct Options {
    database: Option<PathBuf>,
    backup: Option<PathBuf>,
    apply: bool,
    offline_confirm: bool,
    compact: bool,
    policy: RetentionPolicy,
    max_batches: usize,
}
fn help() -> &'static str {
    "编排记录离线整理（默认只读统计，不会停止服务）\n\
用法：multicc-orchestration-maintenance --database /绝对路径/orchestration.sqlite [选项]\n\
  --apply --offline-confirm --backup /绝对路径/备份.sqlite  停止服务后备份并清理\n\
  --compact                 清理后回收数据库空闲页，仅与 --apply 一起使用\n\
  --task-days N             终态任务保留天数，默认 30\n\
  --outbox-days N           已投递/取消的投递记录保留天数，默认 30\n\
  --max-records N           终态任务及已投递/取消回执的软目标，默认 5000；活动与死信不计\n\
  --batch-size N            每个事务最多删除条数，默认 500，上限 10000\n\
  --max-batches N           本次最多执行事务数，默认 1000，上限 10000\n\
必须先手动停止所有使用该数据库的服务；工具会检查维护锁和进程文件占用。\n\
超过软目标仅提前触发清理，仍保留最近 30 天（可配置）及被引用的回执，不强制降至该数量。\n\
备份路径必须是新的文件，不会覆盖已有备份；任务卡片、聊天记录及操作幂等记录不清理。"
}
fn parse() -> Result<Option<Options>> {
    let mut options = Options {
        max_batches: 1000,
        ..Options::default()
    };
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--help" | "-h" => {
                println!("{}", help());
                return Ok(None);
            }
            "--database" => {
                options.database = Some(PathBuf::from(args.next().ok_or("--database 缺少路径")?))
            }
            "--backup" => {
                options.backup = Some(PathBuf::from(args.next().ok_or("--backup 缺少路径")?))
            }
            "--apply" => options.apply = true,
            "--offline-confirm" => options.offline_confirm = true,
            "--compact" => options.compact = true,
            "--task-days" => {
                options.policy.task_days = args
                    .next()
                    .ok_or("--task-days 缺少天数")?
                    .parse()
                    .map_err(|_| "--task-days 需要整数")?
            }
            "--outbox-days" => {
                options.policy.outbox_days = args
                    .next()
                    .ok_or("--outbox-days 缺少天数")?
                    .parse()
                    .map_err(|_| "--outbox-days 需要整数")?
            }
            "--max-records" => {
                options.policy.max_records = args
                    .next()
                    .ok_or("--max-records 缺少数量")?
                    .parse()
                    .map_err(|_| "--max-records 需要整数")?;
            }
            "--batch-size" => {
                options.policy.batch_size = args
                    .next()
                    .ok_or("--batch-size 缺少数量")?
                    .parse()
                    .map_err(|_| "--batch-size 需要整数")?
            }
            "--max-batches" => {
                options.max_batches = args
                    .next()
                    .ok_or("--max-batches 缺少数量")?
                    .parse()
                    .map_err(|_| "--max-batches 需要整数")?
            }
            _ => return Err(format!("未知选项：{arg}")),
        }
    }
    options.policy.validate()?;
    if !(1..=10000).contains(&options.max_batches) {
        return Err("--max-batches 必须介于 1 到 10000".into());
    }
    if options.database.is_none() {
        return Err("必须提供 --database 绝对路径".into());
    }
    if options.apply && (!options.offline_confirm || options.backup.is_none()) {
        return Err(
            "执行清理必须先停止服务，并提供 --offline-confirm 和新的 --backup 绝对路径".into(),
        );
    }
    if !options.apply && (options.compact || options.backup.is_some() || options.offline_confirm) {
        return Err("备份、停机确认和压缩选项只与 --apply 一起使用；默认模式仅统计".into());
    }
    Ok(Some(options))
}
fn database_path(input: &Path) -> Result<PathBuf> {
    if !input.is_absolute() {
        return Err("数据库必须使用绝对路径".into());
    }
    let path = fs::canonicalize(input).map_err(|e| format!("无法定位数据库：{e}"))?;
    if !path.is_file() {
        return Err("数据库路径不是普通文件".into());
    }
    Ok(path)
}
fn backup_path(input: &Path, database: &Path) -> Result<PathBuf> {
    if !input.is_absolute() {
        return Err("备份必须使用绝对路径，建议放在主仓 data/ 或独立备份目录".into());
    }
    if input.file_name().is_none() || input.exists() || fs::symlink_metadata(input).is_ok() {
        return Err("备份目标必须是尚不存在的新文件".into());
    }
    let parent = fs::canonicalize(input.parent().ok_or("备份目录不存在")?)
        .map_err(|e| format!("无法定位备份目录：{e}"))?;
    let target = parent.join(input.file_name().unwrap());
    if target == database {
        return Err("备份目标不能是原数据库".into());
    }
    for suffix in ["-wal", "-shm", "-journal", ".maintenance.lock"] {
        let mut name = database.as_os_str().to_os_string();
        name.push(suffix);
        if target.as_os_str() == name.as_os_str() {
            return Err("备份目标不能是原数据库的附属文件".into());
        }
    }
    Ok(target)
}
#[cfg(unix)]
fn assert_no_other_openers(database: &Path) -> Result<()> {
    let mut paths = vec![database.to_path_buf()];
    for suffix in ["-wal", "-shm", "-journal"] {
        let mut name = database.as_os_str().to_os_string();
        name.push(suffix);
        let path = PathBuf::from(name);
        if path.exists() {
            paths.push(path);
        }
    }
    let output = std::process::Command::new("lsof")
        .arg("-t")
        .arg("--")
        .args(&paths)
        .output()
        .map_err(|_| "无法执行 lsof 核实进程占用，拒绝离线写入；请安装 lsof 后重试")?;
    if !output.stderr.is_empty() {
        return Err("lsof 未能完整核实数据库占用，拒绝离线写入".into());
    }
    let text = std::str::from_utf8(&output.stdout).map_err(|_| "无法解析数据库占用检查结果")?;
    let mut foreign = Vec::new();
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        let pid: u32 = line
            .trim()
            .parse()
            .map_err(|_| "无法解析数据库占用检查结果")?;
        if pid != std::process::id() {
            foreign.push(pid);
        }
    }
    if !foreign.is_empty() {
        return Err(format!(
            "数据库仍被进程使用（PID {foreign:?}）；请先手动停止服务"
        ));
    }
    if !matches!(output.status.code(), Some(0) | Some(1)) {
        return Err("数据库占用检查未正常完成，拒绝离线写入".into());
    }
    Ok(())
}
#[cfg(not(unix))]
fn assert_no_other_openers(_: &Path) -> Result<()> {
    Err("当前平台暂不能可靠核实旧版服务的数据库占用，仅支持只读统计；拒绝离线写入".into())
}
fn validate_database(connection: &Connection) -> Result<()> {
    let version = |key| -> Result<i64> {
        let value: String = connection
            .query_row(
                "SELECT value_json FROM orchestration_meta WHERE key=?1",
                [key],
                |row| row.get(0),
            )
            .map_err(|e| format!("编排数据库元数据不可读：{e}"))?;
        serde_json::from_str(&value).map_err(|_| format!("不支持的编排数据库版本：{key}"))
    };
    let database_version = version("databaseSchemaVersion")?;
    if !matches!(database_version, 1 | 2) {
        return Err("不支持的编排数据库版本：databaseSchemaVersion".into());
    }
    if version("stateSchemaVersion")? != 3 {
        return Err("不支持的编排数据库版本：stateSchemaVersion".into());
    }
    if database_version == 2 {
        let mut statement = connection
            .prepare("PRAGMA table_info(orchestration_record_bodies)")
            .map_err(|e| e.to_string())?;
        let columns = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(5)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        let expected = [
            ("collection", "TEXT", 1, 1),
            ("record_key", "TEXT", 1, 2),
            ("data_json", "TEXT", 1, 0),
        ]
        .map(|(name, kind, not_null, primary_key)| {
            (name.to_string(), kind.to_string(), not_null, primary_key)
        });
        if columns != expected {
            return Err("编排正文表结构不完整，未执行清理".into());
        }
        for collection in ["tasks", "outbox", "operations", "waits"] {
            let table = format!("orchestration_{collection}");
            let has_body_ref: bool = connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name='body_ref' AND type='INTEGER' AND \"notnull\"=1)",
                    [&table],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())?;
            if !has_body_ref {
                return Err("编排正文引用字段不完整，未执行清理".into());
            }
            for event in ["delete", "update"] {
                let exists: bool = connection
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?1 AND tbl_name=?2)",
                        [&format!("{table}_body_{event}"), &table],
                        |row| row.get(0),
                    )
                    .map_err(|e| e.to_string())?;
                if !exists {
                    return Err("编排正文清理触发器不完整，未执行清理".into());
                }
            }
        }
    }
    let result: String = connection
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    if result != "ok" {
        return Err("数据库完整性检查失败，未执行清理".into());
    }
    Ok(())
}
fn private_backup(connection: &Connection, target: &Path) -> Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options
        .open(target)
        .map_err(|e| format!("无法创建新的私有备份文件：{e}"))?;
    drop(file);
    // SQLite permits VACUUM INTO an existing empty file. Reserving it with
    // create_new sets 0600 before the first private byte and prevents overwrite.
    // On any failure keep the partial backup for inspection; never touch source.
    connection
        .execute(
            "VACUUM INTO ?1",
            [target.to_str().ok_or("备份路径必须是有效 UTF-8")?],
        )
        .map_err(|e| format!("创建一致性备份失败，原库未清理：{e}"))?;
    let backup = Connection::open_with_flags(target, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| e.to_string())?;
    validate_database(&backup)?;
    let mut tables = vec![
        "orchestration_tasks",
        "orchestration_outbox",
        "orchestration_operations",
        "orchestration_waits",
        "orchestration_session_schedules",
        "orchestration_extras",
    ];
    let has_bodies: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='orchestration_record_bodies')",
            [],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if has_bodies {
        tables.push("orchestration_record_bodies");
    }
    for table in tables {
        let sql = format!("SELECT count(*) FROM {table}");
        let original: i64 = connection
            .query_row(&sql, [], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        let copied: i64 = backup
            .query_row(&sql, [], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        if original != copied {
            return Err("一致性备份记录数不匹配，原库未清理".into());
        }
    }
    drop(backup);
    File::open(target)
        .and_then(|file| file.sync_all())
        .map_err(|e| format!("备份持久化失败，原库未清理：{e}"))?;
    #[cfg(unix)]
    {
        File::open(target.parent().unwrap())
            .and_then(|file| file.sync_all())
            .map_err(|e| format!("备份目录持久化失败，原库未清理：{e}"))?;
    }
    Ok(())
}
fn run(options: Options) -> Result<()> {
    let database = database_path(options.database.as_ref().unwrap())?;
    let now = chrono::Utc::now().timestamp_millis();
    if !options.apply {
        let connection = Connection::open_with_flags(&database, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| e.to_string())?;
        connection
            .execute_batch("PRAGMA query_only=ON;")
            .map_err(|e| e.to_string())?;
        validate_database(&connection)?;
        let report = retention::report(&connection, &options.policy, now)?;
        println!(
            "{}",
            serde_json::to_string_pretty(
                &json!({"database":database,"mode":"report","report":report})
            )
            .map_err(|e| e.to_string())?
        );
        return Ok(());
    }
    let backup = backup_path(options.backup.as_ref().unwrap(), &database)?;
    let _guard = MaintenanceGuard::exclusive(&database)?;
    assert_no_other_openers(&database)?;
    let mut connection = Connection::open_with_flags(&database, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|e| e.to_string())?;
    connection
        .busy_timeout(std::time::Duration::from_secs(2))
        .map_err(|e| e.to_string())?;
    // Hold SQLite's exclusive locking mode across all bounded transactions, so
    // an older process starting after lsof cannot race this maintenance run.
    connection
        .execute_batch("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;")
        .map_err(|e| format!("无法独占数据库，未执行整理：{e}"))?;
    assert_no_other_openers(&database)?;
    validate_database(&connection)?;
    private_backup(&connection, &backup)?;
    retention::install_indexes(&connection)?;
    let before = retention::report(&connection, &options.policy, now)?;
    let mut batches = 0;
    let mut deleted_tasks = 0;
    let mut deleted_outbox = 0;
    while batches < options.max_batches {
        let report = retention::prune_batch(&mut connection, &options.policy, now)?;
        batches += 1;
        deleted_tasks += report.deleted_tasks;
        deleted_outbox += report.deleted_outbox;
        eprintln!(
            "清理批次 {batches}/{}：任务 {deleted_tasks} 条，投递 {deleted_outbox} 条",
            options.max_batches
        );
        if report.deleted_tasks + report.deleted_outbox == 0 {
            // A protected prefix may consume the entire bounded scan. Only an
            // exact inventory can prove completion; otherwise keep advancing.
            let remaining = retention::report(&connection, &options.policy, now)?;
            if remaining.eligible_tasks + remaining.eligible_outbox == 0 {
                break;
            }
        }
    }
    connection
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .map_err(|e| e.to_string())?;
    if options.compact {
        connection
            .execute_batch("VACUUM;")
            .map_err(|e| format!("清理已提交，但压缩未完成：{e}"))?;
    }
    let after = retention::report(&connection, &options.policy, now)?;
    println!("{}",serde_json::to_string_pretty(&json!({"database":database,"mode":"apply","backup":backup,"batches":batches,"deletedTasks":deleted_tasks,"deletedOutbox":deleted_outbox,"compacted":options.compact,"before":before,"after":after,"remainingEligible":after.eligible_tasks+after.eligible_outbox,"complete":after.eligible_tasks+after.eligible_outbox==0,"stoppedAtBatchLimit":batches==options.max_batches && after.eligible_tasks+after.eligible_outbox>0})).map_err(|e|e.to_string())?);
    Ok(())
}
fn main() {
    let result = parse().and_then(|options| match options {
        Some(options) => run(options),
        None => Ok(()),
    });
    if let Err(error) = result {
        eprintln!("编排整理未完成：{error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn database(version: i64) -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE orchestration_meta(key TEXT PRIMARY KEY,value_json TEXT NOT NULL);
                INSERT INTO orchestration_meta VALUES('stateSchemaVersion','3');",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO orchestration_meta VALUES('databaseSchemaVersion',?1)",
                [version.to_string()],
            )
            .unwrap();
        connection
    }

    #[test]
    fn accepts_schema_one_and_rejects_unknown_versions() {
        assert!(validate_database(&database(1)).is_ok());
        for version in [0, 3, 100] {
            assert!(validate_database(&database(version)).is_err());
        }
        let connection = database(1);
        connection
            .execute(
                "UPDATE orchestration_meta SET value_json='4' WHERE key='stateSchemaVersion'",
                [],
            )
            .unwrap();
        assert!(validate_database(&connection).is_err());
    }

    #[test]
    fn schema_two_requires_body_table_and_cleanup_triggers() {
        let connection = database(2);
        assert!(validate_database(&connection).is_err());
        connection
            .execute_batch(
                "CREATE TABLE orchestration_record_bodies(
                collection TEXT NOT NULL,record_key TEXT NOT NULL,data_json TEXT NOT NULL,
                PRIMARY KEY(collection,record_key)) WITHOUT ROWID;",
            )
            .unwrap();
        assert!(validate_database(&connection).is_err());
        for collection in ["tasks", "outbox", "operations", "waits"] {
            let table = format!("orchestration_{collection}");
            connection
                .execute_batch(&format!("CREATE TABLE {table}(id TEXT PRIMARY KEY,data_json TEXT NOT NULL,body_ref INTEGER NOT NULL DEFAULT 0);
                    CREATE TRIGGER {table}_body_delete AFTER DELETE ON {table} BEGIN
                    DELETE FROM orchestration_record_bodies WHERE collection='{collection}' AND record_key=OLD.id; END;
                    CREATE TRIGGER {table}_body_update AFTER UPDATE OF data_json ON {table} BEGIN
                    DELETE FROM orchestration_record_bodies WHERE collection='{collection}' AND record_key=OLD.id; END;"))
                .unwrap();
        }
        assert!(validate_database(&connection).is_ok());
        connection
            .execute_batch("DROP TRIGGER orchestration_tasks_body_delete;")
            .unwrap();
        assert!(validate_database(&connection).is_err());
    }
}
