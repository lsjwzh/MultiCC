//! 任务仓储：连接、事务、JSON、派生索引与缓存失效均由 Rust 持有。
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
mod rules;
type Result<T> = std::result::Result<T, String>;
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
pub struct TaskStore {
    db: Option<Connection>,
    writes: HashMap<String, u64>,
    cache: HashMap<String, Cached>,
    sequence: u64,
    frames: Vec<String>,
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
        if version > 1 {
            return Err("unsupported task-shell schema".into());
        }
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; CREATE TABLE IF NOT EXISTS shell_records(kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id)); PRAGMA user_version=1;").map_err(err)?;
        db.set_prepared_statement_cache_capacity(64);
        #[cfg(unix)]
        if file != ":memory:" {
            use std::os::unix::fs::PermissionsExt;
            for suffix in ["", "-wal", "-shm"] {
                match std::fs::set_permissions(
                    format!("{file}{suffix}"),
                    std::fs::Permissions::from_mode(0o600),
                ) {
                    Ok(()) => (),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                    Err(e) => return Err(err(e)),
                }
            }
        }
        Ok(Self {
            db: Some(db),
            writes: HashMap::new(),
            cache: HashMap::new(),
            sequence: 0,
            frames: vec![],
        })
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
    fn put_body(&mut self, kind: &str, id: &str, body: &str) -> Result<()> {
        self.db()?.prepare_cached("INSERT INTO shell_records(kind,id,body) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body").map_err(err)?
            .execute(params![kind,id,body]).map_err(err)?;
        *self.writes.entry(kind.into()).or_default() += 1;
        Ok(())
    }
    fn put(&mut self, kind: &str, id: &str, value: &Value) -> Result<()> {
        self.put_body(kind, id, &value.to_string())
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
        if kind == "snapshot" && self.body(kind, id)?.is_some_and(|old| old != body) {
            return Err("immutable snapshot conflict".into());
        }
        self.atomic(|s|{let before=s.get(kind,id)?;s.put_body(kind,id,body)?;
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
    fn deletion_entries(&self, kind: &str) -> Result<Vec<Value>> {
        const KEYS: [&str; 3] = ["id", "taskId", "receiptId"];
        let db = self.db()?;
        let projected = (|| -> rusqlite::Result<Vec<(String, String, [bool; 3])>> {
            let mut stmt = db.prepare_cached(
                "SELECT id,json_extract(body,'$.id','$.taskId','$.receiptId'),\
                 json_type(body,'$.id') IS NOT NULL,json_type(body,'$.taskId') IS NOT NULL,\
                 json_type(body,'$.receiptId') IS NOT NULL FROM shell_records WHERE kind=? ORDER BY rowid",
            )?;
            let rows = stmt.query_map([kind], |r| {
                Ok((r.get(0)?, r.get(1)?, [r.get(2)?, r.get(3)?, r.get(4)?]))
            })?;
            rows.collect()
        })();
        let Ok(projected) = projected else {
            return Ok(self
                .rows(kind, true)?
                .into_iter()
                .map(|(_, id, v)| {
                    let mut refs = serde_json::Map::new();
                    for key in KEYS {
                        if let Some(value) = v.get(key) {
                            refs.insert(key.into(), value.clone());
                        }
                    }
                    json!([id, refs])
                })
                .collect());
        };
        projected
            .into_iter()
            .map(|(id, values, present)| {
                let values = parse(&values)?;
                let mut refs = serde_json::Map::new();
                for (i, key) in KEYS.iter().enumerate() {
                    if present[i] {
                        refs.insert((*key).into(), values[i].clone());
                    }
                }
                Ok(json!([id, refs]))
            })
            .collect()
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
            "deletionEntries" => json!(self.deletion_entries(kind)?),
            "set" => {
                self.set(kind, id, text(&v["body"]))?;
                Value::Null
            }
            "remove" => {
                let changes = self.atomic(|s| {
                    let before = s.get(kind, id)?;
                    match kind {
                        "task" => s.drop_task_index(id, text(&before["sessionId"]))?,
                        "link" => s.drop_link_index(id)?,
                        "receipt" => s.drop_receipt(text(&before["shellId"]), id)?,
                        _ => (),
                    }
                    s.remove(kind, id)
                })?;
                json!({"changes":changes})
            }
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
