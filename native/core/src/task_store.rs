//! 任务仓储：连接、事务、JSON、派生索引与缓存失效均由 Rust 持有。
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
mod context;
mod rules;
type Result<T> = std::result::Result<T, String>;
/// v2：引用列 task_ref/receipt_ref（仓储写入时维护）+ 台账独立成类 + 上下文记录分层。
pub const SCHEMA_VERSION: i64 = 2;
fn items(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn parse(s: &str) -> Result<Value> {
    crate::json_lenient::from_str(s).map_err(err)
}
fn text(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
struct Cached {
    epoch: String,
    token: u64,
    rows: Value,
}
// 整页权限判断用的内存映射（见 rules.rs access_batch），随 link/link-task/shell 的读数失效。
pub(crate) struct AccessMaps {
    epoch: String,
    links: HashMap<String, Value>,
    index: HashMap<String, Value>,
    pub(crate) shells: HashMap<String, Value>,
}
impl AccessMaps {
    // Some(link 行或 Null=否定缓存)；None=索引缺失或失效，交回 link_by_task。
    pub(crate) fn link_for(&self, task: &str) -> Option<Value> {
        let indexed = self.index.get(task)?;
        let link_id = text(&indexed["linkId"]);
        if link_id.is_empty() {
            return Some(Value::Null);
        }
        self.links.get(link_id).cloned()
    }
}
pub struct TaskStore {
    db: Option<Connection>,
    writes: HashMap<String, u64>,
    cache: HashMap<String, Cached>,
    sequence: u64,
    frames: Vec<String>,
    migration: Value,
    access: Option<AccessMaps>,
    progress: Option<Progress>,
}
// 迁移进度写在库旁的 <库>.migration.json（先写临时文件再改名），供启动期的「正在升级」
// 页面与启动器读取；只有阶段、计数和字节数，不含用户数据。同一阶段内最多 4 次/秒。
struct Progress {
    path: String,
    state: Value,
    written: u64,
}
impl Progress {
    fn write(&mut self) {
        self.state["updatedAt"] = json!(now());
        let tmp = format!("{}.tmp", self.path);
        if std::fs::write(&tmp, self.state.to_string()).is_ok() {
            let _ = std::fs::rename(&tmp, &self.path);
        }
        self.written = now();
    }
}
pub fn migration_progress_file(file: &str) -> String {
    format!("{file}.migration.json")
}
// 打开前的只读探测：库已存在、版本低于当前且有数据时才需要迁移。探测失败按「不需要」
// 处理，交给正式打开去报错。
pub fn migration_pending(file: &str) -> bool {
    use rusqlite::OpenFlags;
    if file == ":memory:" || !Path::new(file).exists() {
        return false;
    }
    let Ok(db) = Connection::open_with_flags(file, OpenFlags::SQLITE_OPEN_READ_ONLY) else {
        return false;
    };
    let _ = db.busy_timeout(Duration::from_millis(5000));
    let version: i64 = db
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .unwrap_or(SCHEMA_VERSION);
    version < SCHEMA_VERSION
        && db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='shell_records') AND EXISTS(SELECT 1 FROM shell_records)",
                [],
                |r| r.get::<_, bool>(0),
            )
            .unwrap_or(false)
}
// 同一库只留一份迁移前备份：之前被打断的那次留下的备份和半成品一律删掉（库还是旧版本、
// 迁移没提交，库本身就是最新的原样数据）。
fn remove_stale_backups(file: &str, from: i64) -> Result<()> {
    let path = Path::new(file);
    let dir = path.parent().filter(|d| !d.as_os_str().is_empty()).unwrap_or(Path::new("."));
    let prefix = format!(
        "{}.v{from}-backup-",
        path.file_name().and_then(|n| n.to_str()).unwrap_or_default()
    );
    for entry in std::fs::read_dir(dir).map_err(err)?.flatten() {
        if entry.file_name().to_str().is_some_and(|n| n.starts_with(&prefix)) {
            std::fs::remove_file(entry.path()).map_err(err)?;
        }
    }
    Ok(())
}
impl TaskStore {
    pub fn open(file: &str) -> Result<Self> {
        if file != ":memory:" {
            if let Some(p) = Path::new(file).parent() {
                std::fs::create_dir_all(p).map_err(err)?;
            }
        }
        let db = Connection::open(file).map_err(err)?;
        db.busy_timeout(Duration::from_millis(5000)).map_err(err)?;
        let version: i64 = db
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .map_err(err)?;
        if version > SCHEMA_VERSION {
            return Err("unsupported task-shell schema".into());
        }
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; CREATE TABLE IF NOT EXISTS shell_records(kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,task_ref TEXT,receipt_ref TEXT,PRIMARY KEY(kind,id));").map_err(err)?;
        db.set_prepared_statement_cache_capacity(64);
        let mut store = Self {
            db: Some(db),
            writes: HashMap::new(),
            cache: HashMap::new(),
            sequence: 0,
            frames: vec![],
            migration: Value::Null,
            access: None,
            progress: None,
        };
        if version < SCHEMA_VERSION {
            let result = store.migrate(file, version);
            if let Some(mut p) = store.progress.take() {
                match &result {
                    Ok(()) => {
                        let _ = std::fs::remove_file(&p.path);
                    }
                    Err(e) => {
                        p.state["phase"] = json!("failed");
                        p.state["error"] = json!(e);
                        p.write();
                    }
                }
            }
            result?;
        }
        #[cfg(unix)]
        if file != ":memory:" {
            use std::os::unix::fs::PermissionsExt;
            let backup = store.migration["backup"].as_str().map(|b| b.to_string());
            for path in ["", "-wal", "-shm"]
                .iter()
                .map(|suffix| format!("{file}{suffix}"))
                .chain(backup)
            {
                match std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)) {
                    Ok(()) => (),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                    Err(e) => return Err(err(e)),
                }
            }
        }
        Ok(store)
    }
    // v1→v2 一次性迁移：先整库备份（VACUUM INTO，空间不够直接拒绝、不改任何数据），
    // 再在单个事务里补引用列、建索引、搬台账、压缩上下文记录；崩溃即整体回滚，
    // 下次启动重来。最后 VACUUM 回收空间（失败不影响数据）。
    fn migrate(&mut self, file: &str, from: i64) -> Result<()> {
        let started = now();
        let db = self.db()?;
        let has_rows: bool = db
            .query_row("SELECT EXISTS(SELECT 1 FROM shell_records)", [], |r| r.get(0))
            .map_err(err)?;
        let columns = db
            .prepare("SELECT name FROM pragma_table_info('shell_records')")
            .and_then(|mut stmt| {
                stmt.query_map([], |r| r.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()
            })
            .map_err(err)?;
        let durable = has_rows && file != ":memory:";
        let mut backup = Value::Null;
        if durable {
            let size: u64 = ["", "-wal"]
                .iter()
                .filter_map(|s| std::fs::metadata(format!("{file}{s}")).ok())
                .map(|m| m.len())
                .sum();
            let path = format!("{file}.v{from}-backup-{started}");
            self.progress = Some(Progress {
                path: migration_progress_file(file),
                state: json!({"pid":std::process::id(),"from":from,"to":SCHEMA_VERSION,
                    "startedAt":started,"phase":"backup","done":0,"total":0,"dbBytes":size,
                    "backupPartial":format!("{path}.partial")}),
                written: 0,
            });
            self.report("backup", 0, 0);
            remove_stale_backups(file, from)?;
            let dir = Path::new(file).parent().unwrap_or(Path::new("."));
            let free = fs2::available_space(dir).map_err(err)?;
            let need = size.saturating_mul(3) + (256 << 20);
            if free < need {
                if let Some(p) = self.progress.as_mut() {
                    p.state["needBytes"] = json!(need);
                    p.state["freeBytes"] = json!(free);
                }
                return Err(format!(
                    "task_store_migration_needs_space: need {need} bytes free, have {free}"
                ));
            }
            // 先写半成品再改名：被打断时留下的只会是 .partial，不会被当成完整备份。
            let partial = format!("{path}.partial");
            self.db()?
                .execute("VACUUM INTO ?1", [&partial])
                .map_err(err)?;
            std::fs::rename(&partial, &path).map_err(err)?;
            self.report("backup", 1, 1);
            backup = json!(path);
        }
        let backed = now();
        let stats = self.atomic(|s| {
            for column in ["task_ref", "receipt_ref"] {
                if !columns.iter().any(|c| c == column) {
                    s.db()?
                        .execute_batch(&format!("ALTER TABLE shell_records ADD COLUMN {column} TEXT"))
                        .map_err(err)?;
                }
            }
            s.db()?.execute_batch("CREATE INDEX IF NOT EXISTS shell_records_task_ref ON shell_records(kind,task_ref); CREATE INDEX IF NOT EXISTS shell_records_receipt_ref ON shell_records(kind,receipt_ref);").map_err(err)?;
            let stats = s.migrate_rows()?;
            s.db()?
                .execute_batch(&format!("PRAGMA user_version={SCHEMA_VERSION}"))
                .map_err(err)?;
            Ok(stats)
        })?;
        let migrated = now();
        self.report("vacuum", 0, 0);
        let vacuumed = durable && self.db()?.execute_batch("VACUUM").is_ok();
        self.cache.clear();
        self.migration = json!({"from":from,"to":SCHEMA_VERSION,"backup":backup,"vacuumed":vacuumed,
            "ms":now().saturating_sub(started),"backupMs":backed.saturating_sub(started),
            "migrateMs":migrated.saturating_sub(backed),"vacuumMs":now().saturating_sub(migrated),"stats":stats});
        Ok(())
    }
    // 换阶段立刻写；同一阶段内节流（最后一条总会在下一次换阶段时被覆盖）。
    fn report(&mut self, phase: &str, done: usize, total: usize) {
        let Some(p) = self.progress.as_mut() else {
            return;
        };
        let same = p.state["phase"] == phase;
        if same && done != 0 && done != total && now().saturating_sub(p.written) < 250 {
            return;
        }
        p.state["phase"] = json!(phase);
        p.state["done"] = json!(done);
        p.state["total"] = json!(total);
        p.write();
    }
    fn db(&self) -> Result<&Connection> {
        self.db.as_ref().ok_or_else(|| "task_store_closed".into())
    }
    fn body(&self, kind: &str, id: &str) -> Result<Option<String>> {
        self.db()?
            .prepare_cached("SELECT body FROM shell_records WHERE kind=? AND id=?")
            .map_err(err)?
            .query_row(params![kind, id], |r| r.get(0))
            .optional()
            .map_err(err)
    }
    fn get(&self, kind: &str, id: &str) -> Result<Value> {
        self.body(kind, id)?
            .map(|s| parse(&s))
            .unwrap_or(Ok(Value::Null))
    }
    fn rows(&self, kind: &str, ordered: bool) -> Result<Vec<(i64, String, Value)>> {
        let sql = if ordered {
            "SELECT rowid,id,body FROM shell_records WHERE kind=? ORDER BY rowid"
        } else {
            "SELECT rowid,id,body FROM shell_records WHERE kind=?"
        };
        let mut stmt = self.db()?.prepare_cached(sql).map_err(err)?;
        let rows = stmt
            .query_map([kind], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(err)?;
        rows.map(|r| {
            let (rid, id, body) = r.map_err(err)?;
            Ok((rid, id, parse(&body)?))
        })
        .collect()
    }
    // 引用列只收字符串，与旧 JS 用字符串 Set 比对的口径一致。
    fn put_row(&mut self, kind: &str, id: &str, body: &str, value: &Value) -> Result<()> {
        self.db()?.prepare_cached("INSERT INTO shell_records(kind,id,body,task_ref,receipt_ref) VALUES(?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body,task_ref=excluded.task_ref,receipt_ref=excluded.receipt_ref").map_err(err)?
            .execute(params![kind,id,body,value["taskId"].as_str(),value["receiptId"].as_str()]).map_err(err)?;
        *self.writes.entry(kind.into()).or_default() += 1;
        Ok(())
    }
    fn put(&mut self, kind: &str, id: &str, value: &Value) -> Result<()> {
        self.put_row(kind, id, &value.to_string(), value)
    }
    fn ids_where(&self, sql: &str, args: &[&dyn rusqlite::ToSql]) -> Result<Vec<String>> {
        let mut stmt = self.db()?.prepare_cached(sql).map_err(err)?;
        let rows = stmt.query_map(args, |r| r.get(0)).map_err(err)?;
        rows.collect::<rusqlite::Result<_>>().map_err(err)
    }
    fn remove(&mut self, kind: &str, id: &str) -> Result<u64> {
        let changes = self
            .db()?
            .prepare_cached("DELETE FROM shell_records WHERE kind=? AND id=?")
            .map_err(err)?
            .execute(params![kind, id])
            .map_err(err)?;
        *self.writes.entry(kind.into()).or_default() += 1;
        Ok(changes as u64)
    }
    fn epoch(&self, kinds: &[Value]) -> Result<String> {
        let version: u64 = self
            .db()?
            .pragma_query_value(None, "data_version", |r| r.get(0))
            .map_err(err)?;
        Ok(format!(
            "{}:{}",
            version,
            kinds
                .iter()
                .map(|k| self.writes.get(text(k)).unwrap_or(&0).to_string())
                .collect::<Vec<_>>()
                .join(",")
        ))
    }
    fn begin(&mut self) -> Result<String> {
        self.sequence += 1;
        let frame = format!("task_frame_{}", self.sequence);
        let sql = if self.frames.is_empty() {
            "BEGIN IMMEDIATE".into()
        } else {
            format!("SAVEPOINT {frame}")
        };
        self.db()?.execute_batch(&sql).map_err(err)?;
        self.frames.push(frame.clone());
        Ok(frame)
    }
    fn finish(&mut self, frame: &str, commit: bool) -> Result<()> {
        if self.frames.last().map(String::as_str) != Some(frame) {
            return Err("task_store_transaction_order".into());
        }
        let sql = match (self.frames.len() == 1, commit) {
            (true, true) => "COMMIT".into(),
            (true, false) => "ROLLBACK".into(),
            (false, true) => format!("RELEASE {frame}"),
            (false, false) => format!("ROLLBACK TO {frame}; RELEASE {frame}"),
        };
        self.db()?.execute_batch(&sql).map_err(err)?;
        self.frames.pop();
        if !commit {
            self.cache.clear();
            self.sequence += 1;
        }
        Ok(())
    }
    fn atomic<T>(&mut self, f: impl FnOnce(&mut Self) -> Result<T>) -> Result<T> {
        let frame = self.begin()?;
        match f(self) {
            Ok(value) => match self.finish(&frame, true) {
                Ok(()) => Ok(value),
                Err(e) => {
                    let _ = self.finish(&frame, false);
                    Err(e)
                }
            },
            Err(e) => {
                self.finish(&frame, false)?;
                Err(e)
            }
        }
    }
    fn drop_task_index(&mut self, id: &str, session: &str) -> Result<()> {
        if !session.is_empty() && self.get("task-session", session)?["taskId"] == id {
            self.remove("task-session", session)?;
        }
        Ok(())
    }
    fn drop_link_index(&mut self, id: &str) -> Result<()> {
        let link = self.get("link", id)?;
        let task = text(&link["taskId"]);
        if !task.is_empty() && self.get("link-task", task)?["linkId"] == id {
            self.remove("link-task", task)?;
        }
        Ok(())
    }
    fn receipt_items(&self, shell: &str) -> Result<Vec<Value>> {
        Ok(self.get("receipt-shell", shell)?["items"]
            .as_array()
            .cloned()
            .unwrap_or_default())
    }
    fn write_receipt_items(&mut self, shell: &str, items: Vec<Value>) -> Result<()> {
        self.put(
            "receipt-shell",
            shell,
            &json!({"shellId":shell,"items":items}),
        )
    }
    fn receipt_watermark(&self) -> Result<i64> {
        self.db()?
            .query_row(
                "SELECT coalesce(max(rowid),0) FROM shell_records WHERE kind='receipt'",
                [],
                |r| r.get(0),
            )
            .map_err(err)
    }
    fn drop_receipt(&mut self, shell: &str, id: &str) -> Result<()> {
        if shell.is_empty() {
            return Ok(());
        }
        let mut items = self.receipt_items(shell)?;
        let before = items.len();
        items.retain(|v| v["id"] != id);
        if before != items.len() {
            self.write_receipt_items(shell, items)?;
        }
        Ok(())
    }
    fn add_receipt(&mut self, shell: &str, id: &str) -> Result<()> {
        let rid: i64 = self
            .db()?
            .query_row(
                "SELECT rowid FROM shell_records WHERE kind='receipt' AND id=?",
                [id],
                |r| r.get(0),
            )
            .map_err(err)?;
        let mut items = self.receipt_items(shell)?;
        if let Some(item) = items.iter_mut().find(|v| v["id"] == id) {
            if item["rowid"] == rid {
                return Ok(());
            }
            item["rowid"] = json!(rid);
        } else {
            items.push(json!({"id":id,"rowid":rid}));
        }
        self.write_receipt_items(shell, items)?;
        let mut meta = self.get("receipt-index-meta", "v1")?;
        if meta.is_object() && rid > meta["watermark"].as_i64().unwrap_or(0) {
            meta["watermark"] = json!(rid);
            self.put("receipt-index-meta", "v1", &meta)?;
        }
        Ok(())
    }
    fn build_receipts(&mut self) -> Result<()> {
        let mut grouped: HashMap<String, Vec<Value>> = HashMap::new();
        for (rid, id, row) in self.rows("receipt", true)? {
            let shell = text(&row["shellId"]);
            if !shell.is_empty() {
                grouped
                    .entry(shell.into())
                    .or_default()
                    .push(json!({"id":id,"rowid":rid}));
            }
        }
        let count = grouped.len();
        for (shell, items) in grouped {
            self.write_receipt_items(&shell, items)?;
        }
        self.put(
            "receipt-index-meta",
            "v1",
            &json!({"builtAt":now(),"watermark":self.receipt_watermark()?,"shells":count}),
        )
    }
    fn set(&mut self, kind: &str, id: &str, body: &str) -> Result<()> {
        let value = parse(body)?;
        self.atomic(|s|{let old=s.body(kind,id)?;
            if old.as_deref()==Some(body){return Ok(());}
            if kind=="snapshot"&&old.is_some(){return Err("immutable snapshot conflict".into());}
            let before=match &old{Some(b)=>parse(b)?,None=>Value::Null};s.put_row(kind,id,body,&value)?;
            match kind{
                "task"=>{let old=text(&before["sessionId"]);let next=text(&value["sessionId"]);if old!=next{s.drop_task_index(id,old)?;}
if !next.is_empty(){s.put("task-session",next,&json!({"taskId":value.get("id").cloned().unwrap_or(json!(id)),"sessionId":next}))?;}},
                "link"=>{let task=text(&value["taskId"]);if !task.is_empty()&&text(&s.get("link-task",task)?["linkId"]).is_empty(){s.put("link-task",task,&json!({"taskId":task,"shellId":value["shellId"],"linkId":id}))?;}},
                "receipt"=>{let old=text(&before["shellId"]);let next=text(&value["shellId"]);if old!=next{s.drop_receipt(old,id)?;}
if !next.is_empty(){s.add_receipt(next,id)?;}},_=>()
            }Ok(())})
    }
    // link-task 索引协议：命中即 PK 查 link 行，索引指向已删 link 时清索引，
    // 未命中全表扫一次并回填（含否定缓存）。ownerPlan 与 linkByTask op 必须共用，
    // 否则规则路径每次全表扫描且永不回填。
    // 删除扫描只要三个引用字段。收据行平均约 80KB（整类数百 MB），整行解析一次删除
    // 就要数秒；在 SQL 里投影，与迁移前的口径相同。SQLite 拒绝的行（宽松解码才能读的
    // 脏数据）退回整行解析，结果不变。
    fn remove_row(&mut self, kind: &str, id: &str) -> Result<u64> {
        let before = self.get(kind, id)?;
        match kind {
            "task" => self.drop_task_index(id, text(&before["sessionId"]))?,
            "link" => self.drop_link_index(id)?,
            "receipt" => self.drop_receipt(text(&before["shellId"]), id)?,
            _ => (),
        }
        self.remove(kind, id)
    }
    // 删任务的关联行：存储键是任务 id、正文 taskId 指向任务、或 receiptId 指向这些任务
    // 的收据。走引用列索引，只碰命中的行，耗时与历史总量无关。
    fn purge_task_refs(&mut self, kinds: &[&str], task_ids: &[&str]) -> Result<Value> {
        let mut receipts = vec![];
        for chunk in task_ids.chunks(400) {
            let marks = vec!["?"; chunk.len()].join(",");
            let sql = format!("SELECT body FROM shell_records WHERE kind='receipt' AND task_ref IN ({marks})");
            let mut stmt = self.db()?.prepare(&sql).map_err(err)?;
            let bodies = stmt
                .query_map(rusqlite::params_from_iter(chunk.iter()), |r| r.get::<_, String>(0))
                .map_err(err)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(err)?;
            for body in bodies {
                if let Some(id) = parse(&body)?["id"].as_str() {
                    receipts.push(id.to_string());
                }
            }
        }
        let mut removed = 0;
        for kind in kinds {
            let mut targets = std::collections::BTreeSet::new();
            for chunk in task_ids.chunks(400) {
                let marks = vec!["?"; chunk.len()].join(",");
                let sql = format!("SELECT id FROM shell_records WHERE kind=? AND (id IN ({marks}) OR task_ref IN ({marks}))");
                let args = std::iter::once(*kind).chain(chunk.iter().copied()).chain(chunk.iter().copied());
                let mut stmt = self.db()?.prepare(&sql).map_err(err)?;
                for id in stmt.query_map(rusqlite::params_from_iter(args), |r| r.get::<_, String>(0)).map_err(err)? {
                    targets.insert(id.map_err(err)?);
                }
            }
            for chunk in receipts.chunks(400) {
                let marks = vec!["?"; chunk.len()].join(",");
                let sql = format!("SELECT id FROM shell_records WHERE kind=? AND receipt_ref IN ({marks})");
                let args = std::iter::once(*kind).chain(chunk.iter().map(String::as_str));
                let mut stmt = self.db()?.prepare(&sql).map_err(err)?;
                for id in stmt.query_map(rusqlite::params_from_iter(args), |r| r.get::<_, String>(0)).map_err(err)? {
                    targets.insert(id.map_err(err)?);
                }
            }
            for id in targets {
                removed += self.remove_row(kind, &id)?;
            }
        }
        Ok(json!({"removed":removed,"receipts":receipts.len()}))
    }
    fn access_maps(&mut self) -> Result<AccessMaps> {
        let epoch = self.epoch(&[json!("link"), json!("link-task"), json!("shell")])?;
        if let Some(maps) = self.access.take().filter(|m| m.epoch == epoch) {
            return Ok(maps);
        }
        let map = |rows: Vec<(i64, String, Value)>| rows.into_iter().map(|(_, id, v)| (id, v)).collect();
        Ok(AccessMaps {
            links: map(self.rows("link", false)?),
            index: map(self.rows("link-task", false)?),
            shells: map(self.rows("shell", false)?),
            epoch,
        })
    }
    fn link_by_task(&mut self, task_id: &str) -> Result<Value> {
        if task_id.is_empty() {
            return Ok(Value::Null);
        }
        let indexed = self.get("link-task", task_id)?;
        if !indexed.is_null() {
            let link_id = text(&indexed["linkId"]);
            let found = self.get("link", link_id)?;
            if !link_id.is_empty() && found.is_null() {
                self.remove("link-task", task_id)?;
            }
            return Ok(found);
        }
        let found = self
            .rows("link", true)?
            .into_iter()
            .find(|(_, _, value)| value["taskId"] == task_id);
        let index = match &found {
            Some((_, key, value)) => json!({"taskId":task_id,"shellId":value["shellId"],"linkId":key}),
            None => json!({"taskId":task_id,"shellId":null,"linkId":null}),
        };
        self.put("link-task", task_id, &index)?;
        Ok(found.map(|(_, _, v)| v).unwrap_or(Value::Null))
    }
    // panic 穿越 addon 边界后恢复：回滚遗留事务并丢弃持有态缓存。
    pub fn recover_after_panic(&mut self) {
        if self.frames.is_empty() {
            return;
        }
        if let Some(db) = &self.db {
            let _ = db.execute_batch("ROLLBACK");
        }
        self.frames.clear();
        self.cache.clear();
        self.access = None;
    }
    pub fn run(&mut self, input: &str) -> Result<String> {
        let v = parse(input)?;
        let op = text(&v["op"]);
        let kind = text(&v["kind"]);
        let id = text(&v["id"]);
        let out = match op {
            "rule" => self.rule(&v)?,
            "get" => self.get(kind, id)?,
            "list" => json!(self
                .rows(kind, true)?
                .into_iter()
                .map(|(_, _, v)| v)
                .collect::<Vec<_>>()),
            "entries" => json!(self
                .rows(kind, false)?
                .into_iter()
                .map(|(_, id, v)| json!([id, v]))
                .collect::<Vec<_>>()),
            "set" => {
                self.set(kind, id, text(&v["body"]))?;
                Value::Null
            }
            "remove" => {
                let changes = self.atomic(|s| s.remove_row(kind, id))?;
                json!({"changes":changes})
            }
            "purgeTaskRefs" => {
                let kinds = items(&v["kinds"]).iter().map(text).collect::<Vec<_>>();
                let ids = items(&v["ids"]).iter().filter_map(Value::as_str).collect::<Vec<_>>();
                self.atomic(|s| s.purge_task_refs(&kinds, &ids))?
            }
            "contextCommitted" => self.context_committed(text(&v["taskId"]), id)?,
            "contextTrace" => self.context_trace(id, v["includeMessages"] == true)?,
            "migration" => self.migration.clone(),
            "epoch" => json!(self.epoch(v["kinds"].as_array().ok_or("invalid_task_store_kinds")?)?),
            "cached" => {
                if ![
                    "task",
                    "link",
                    "shell",
                    "task-first:indexed",
                    "workspace:record",
                    "workspace:lease",
                ]
                .contains(&kind)
                {
                    return Err(format!("row cache not allowed for kind {kind}"));
                }
                let shape = text(&v["shape"]);
                let key = format!("{shape}:{kind}");
                let epoch = self.epoch(&[json!(kind)])?;
                if !self.cache.get(&key).is_some_and(|c| c.epoch == epoch) {
                    let rows = self
                        .rows(kind, shape != "entries")?
                        .into_iter()
                        .map(|(_, id, value)| {
                            if shape == "entries" {
                                json!([id, value])
                            } else {
                                value
                            }
                        })
                        .collect::<Vec<_>>();
                    self.sequence += 1;
                    self.cache.insert(
                        key.clone(),
                        Cached {
                            epoch,
                            token: self.sequence,
                            rows: json!(rows),
                        },
                    );
                }
                let cached = &self.cache[&key];
                if v["token"].as_u64() == Some(cached.token) {
                    json!({"token":cached.token})
                } else {
                    json!({"token":cached.token,"rows":cached.rows})
                }
            }
            "taskBySession" => {
                if id.is_empty() {
                    Value::Null
                } else {
                    let indexed = self.get("task-session", id)?;
                    if !indexed.is_null() {
                        let found = self.get("task", text(&indexed["taskId"]))?;
                        if !text(&indexed["taskId"]).is_empty() && found.is_null() {
                            self.remove("task-session", id)?;
                        }
                        found
                    } else {
                        let found = self.rows("task", true)?
                            .into_iter()
                            .find(|(_, _, value)| value["sessionId"] == id);
                        let index = if let Some((_, key, value)) = &found {
                            json!({"taskId":value.get("id").cloned().unwrap_or(json!(key)),"sessionId":id})
                        } else {
                            json!({"taskId":null,"sessionId":id})
                        };
                        self.put("task-session", id, &index)?;
                        found.map(|(_, _, v)| v).unwrap_or(Value::Null)
                    }
                }
            }
            "linkByTask" => self.link_by_task(&id)?,
            "receiptsForShell" => {
                if id.is_empty() {
                    json!([])
                } else {
                    let meta = self.get("receipt-index-meta", "v1")?;
                    if meta.is_null()
                        || self.receipt_watermark()? > meta["watermark"].as_i64().unwrap_or(0)
                    {
                        self.atomic(|s| s.build_receipts())?;
                    }
                    let mut items = self.receipt_items(id)?;
                    items.sort_by_key(|v| v["rowid"].as_i64().unwrap_or(0));
                    let limit = v["limit"].as_i64().unwrap_or(100);
                    let start = if limit > 0 {
                        items.len().saturating_sub(limit as usize)
                    } else {
                        0
                    };
                    let mut out = vec![];
                    let mut stale = false;
                    for item in &items[start..] {
                        let row = self.get("receipt", text(&item["id"]))?;
                        if row.is_null() {
                            stale = true;
                        } else {
                            out.push(row);
                        }
                    }
                    if stale {
                        let mut alive = vec![];
                        for item in items {
                            if self.body("receipt", text(&item["id"]))?.is_some() {
                                alive.push(item);
                            }
                        }
                        self.write_receipt_items(id, alive)?;
                    }
                    json!(out)
                }
            }
            "begin" => json!(self.begin()?),
            "commit" | "rollback" => {
                self.finish(text(&v["frame"]), op == "commit")?;
                Value::Null
            }
            "close" => {
                if let Some(db) = self.db.take() {
                    match db.close() {
                        Ok(()) => (),
                        Err((db, e)) => {
                            self.db = Some(db);
                            return Err(err(e));
                        }
                    }
                }
                self.cache.clear();
                self.frames.clear();
                Value::Null
            }
            _ => return Err("invalid_task_store_command".into()),
        };
        Ok(out.to_string())
    }
}
