//! The standalone service's durable Aux queue. A claim commits before any
//! network I/O. An interrupted upstream request has an unknown outcome and is
//! never sent twice. Its caller can retrieve the terminal result by task ID.
use crate::{api_error_policy, chat_history_file, js};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{collections::VecDeque, path::Path};

type Result<T> = std::result::Result<T, String>;
pub const PAYLOAD_CONFLICT: &str = "task ID already used for another payload";
fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
fn invalid(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn decode(s: String) -> Result<Value> {
    serde_json::from_str(&s).map_err(invalid)
}
fn initial_health() -> Value {
    json!({"consecutiveFails":0,"unhealthy":false,"retryable":true,"category":null,
           "action":null,"retryAt":null,"lastFailAt":null,"lastFailMsg":"","sinceAt":null})
}
pub struct Queue {
    db: Connection,
    pool: i64,
}
impl Queue {
    pub fn open(root: &Path) -> Result<Self> {
        let path = root.join("aux-jobs.sqlite");
        let mut opts = std::fs::OpenOptions::new();
        opts.create(true).write(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        opts.open(&path).map_err(invalid)?;
        let db = Connection::open(path).map_err(invalid)?;
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS jobs(
            seq INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, payload TEXT NOT NULL,
            lane TEXT NOT NULL, serial_key TEXT NOT NULL, interactive INTEGER NOT NULL,
            state TEXT NOT NULL, ts INTEGER NOT NULL, started INTEGER, ended INTEGER,
            cancelled INTEGER NOT NULL DEFAULT 0, ok INTEGER, answer TEXT, transport TEXT);
            CREATE INDEX IF NOT EXISTS aux_state ON jobs(state,interactive DESC,seq);
            CREATE INDEX IF NOT EXISTS aux_history ON jobs(ended,seq);
            CREATE TABLE IF NOT EXISTS stats(id INTEGER PRIMARY KEY,health TEXT NOT NULL);",
        )
        .map_err(invalid)?;
        db.execute(
            "INSERT OR IGNORE INTO stats VALUES(1,?)",
            [initial_health().to_string()],
        )
        .map_err(invalid)?;
        db.execute("UPDATE jobs SET state='done',ended=?,ok=0,answer=CASE WHEN cancelled=1 THEN 'cancelled' ELSE 'Aux request interrupted by service restart' END WHERE state='running'",[now()]).map_err(invalid)?;
        let pool = std::env::var("MULTICC_AUX_CONCURRENCY")
            .or_else(|_| std::env::var("AUX_CONCURRENCY"))
            .ok()
            .and_then(|s| crate::session_git::parse_int10(&s))
            .unwrap_or(5)
            .clamp(1, 16);
        Ok(Self {
            db,
            pool: pool as i64,
        })
    }
    pub fn enqueue(&self, id: &str, job: &Value, interactive: bool) -> Result<bool> {
        let lane = if matches!(
            job["type"].as_str(),
            Some("memory_distill" | "memory_review")
        ) {
            "serial"
        } else {
            "pool"
        };
        let meta = &job["meta"];
        let key = ["sessionName", "sid", "sessionId"]
            .into_iter()
            .find_map(|k| meta[k].as_str().filter(|s| !s.is_empty()))
            .unwrap_or("");
        let inserted = self
            .db
            .execute(
                "INSERT INTO jobs(id,payload,lane,serial_key,interactive,state,ts)
            VALUES(?,?,?,?,?,'queued',?) ON CONFLICT(id) DO NOTHING",
                params![id, job.to_string(), lane, key, interactive, now()],
            )
            .map_err(invalid)?;
        let original: String = self
            .db
            .query_row("SELECT payload FROM jobs WHERE id=?", [id], |r| r.get(0))
            .map_err(invalid)?;
        if decode(original)? != *job {
            return Err(PAYLOAD_CONFLICT.into());
        }
        Ok(inserted > 0)
    }
    pub fn claim(&mut self) -> Result<Option<(String, Value)>> {
        let tx = self.db.transaction().map_err(invalid)?;
        let next=tx.query_row("SELECT q.id,q.payload FROM jobs q WHERE q.state='queued'
            AND (SELECT count(*) FROM jobs r WHERE r.state='running' AND r.lane=q.lane)
                < CASE WHEN q.lane='serial' THEN 1 ELSE ? END
            AND (q.serial_key='' OR NOT EXISTS (SELECT 1 FROM jobs r WHERE r.serial_key=q.serial_key AND
                (r.state='running' OR (r.state='queued' AND r.seq<q.seq))))
            ORDER BY q.interactive DESC,q.seq LIMIT 1",[self.pool],
            |r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).optional().map_err(invalid)?;
        let Some((id, payload)) = next else {
            return Ok(None);
        };
        let job = decode(payload)?;
        tx.execute(
            "UPDATE jobs SET state='running',started=? WHERE id=?",
            params![now(), id],
        )
        .map_err(invalid)?;
        tx.commit().map_err(invalid)?;
        Ok(Some((id, job)))
    }
    pub fn cancel(&self, id: &str) -> Result<bool> {
        let updated=self.db.execute("UPDATE jobs SET cancelled=1,ended=CASE WHEN state='queued' THEN ? ELSE ended END,
            ok=CASE WHEN state='queued' THEN 0 ELSE ok END,answer=CASE WHEN state='queued' THEN 'cancelled' ELSE answer END,
            state=CASE WHEN state='queued' THEN 'done' ELSE state END WHERE id=? AND state!='done'",params![now(),id]).map_err(invalid)?;
        Ok(updated > 0)
    }
    pub fn finish(
        &mut self,
        id: &str,
        transport: &Value,
        outcome: &std::result::Result<String, String>,
    ) -> Result<()> {
        let tx = self.db.transaction().map_err(invalid)?;
        let at = now();
        let (ok, msg) = match outcome {
            Ok(s) => (true, s),
            Err(s) => (false, s),
        };
        let cancelled: bool = tx
            .query_row(
                "SELECT cancelled FROM jobs WHERE id=? AND state='running'",
                [id],
                |r| r.get(0),
            )
            .map_err(invalid)?;
        let mut transport = transport.clone();
        if !cancelled {
            let mut h = decode(
                tx.query_row("SELECT health FROM stats WHERE id=1", [], |r| r.get(0))
                    .map_err(invalid)?,
            )?;
            if ok {
                let mut reset = initial_health();
                reset["lastFailAt"] = h["lastFailAt"].clone();
                reset["lastFailMsg"] = h["lastFailMsg"].clone();
                h = reset;
            } else {
                let provider = if transport["protocol"] == "openai" {
                    "aux-openai"
                } else {
                    "aux-anthropic"
                };
                let raw = js::from_serde(&json!({"message":msg}));
                let ctx = js::from_serde(
                    &json!({"source":"aux_http","provider":provider,"phase":"before_first_token","partialOutput":false,"sideEffects":false,"idempotencyKey":format!("aux:{id}")}),
                );
                let d = api_error_policy::decide(
                    &raw,
                    &ctx,
                    &api_error_policy::NormalizeDeps {
                        source: "aux_http".into(),
                        provider: provider.into(),
                        upstream: js::JsValue::Null,
                        failure: js::JsValue::Null,
                        rejection: js::JsValue::Null,
                        now: at as f64,
                        known: false,
                    },
                    &|_| f64::NAN,
                    &mut || 0.0,
                );
                let d = js::to_serde(&d);
                let mut e = d["error"].clone();
                e["action"] = d["action"].clone();
                transport["apiError"] = json!({"category":e["category"],"code":e["code"],"httpStatus":e["httpStatus"],"provider":e["provider"],"retryable":e["retryable"],"retryAfterMs":e["retryAfterMs"],"action":e["action"]});
                let fails = h["consecutiveFails"].as_i64().unwrap_or(0) + 1;
                h["consecutiveFails"] = fails.into();
                h["category"] = e["category"].clone();
                h["action"] = e["action"].clone();
                h["retryAt"] = d["retryAt"].clone();
                h["retryable"] = (e["action"] == "retry"
                    || (e["action"] == "wait_reset" && !d["retryAt"].is_null()))
                .into();
                h["lastFailAt"] = at.into();
                h["lastFailMsg"] = msg.chars().take(200).collect::<String>().into();
                if (e["action"] != "retry" || fails >= 3) && h["unhealthy"] != true {
                    h["unhealthy"] = true.into();
                    h["sinceAt"] = at.into();
                }
            }
            tx.execute("UPDATE stats SET health=? WHERE id=1", [h.to_string()])
                .map_err(invalid)?;
        }
        tx.execute(
            "UPDATE jobs SET state='done',ended=?,ok=?,answer=?,transport=? WHERE id=?",
            params![at, ok, msg, transport.to_string(), id],
        )
        .map_err(invalid)?;
        tx.commit().map_err(invalid)
    }
    pub fn result(&self, id: &str) -> Result<Option<Value>> {
        self.db
            .query_row(
                "SELECT ok,cancelled,answer FROM jobs WHERE id=? AND state='done'",
                [id],
                |r| {
                    let msg: String = r.get(2)?;
                    Ok(if r.get::<_, bool>(1)? {
                        json!({"ok":false,"error":"cancelled","taskId":id})
                    } else if r.get::<_, bool>(0)? {
                        json!({"ok":true,"result":msg,"taskId":id})
                    } else {
                        json!({"ok":false,"error":msg,"taskId":id})
                    })
                },
            )
            .optional()
            .map_err(invalid)
    }
    pub fn status(&self) -> Result<Value> {
        let mut stmt=self.db.prepare("SELECT id,json_extract(payload,'$.type'),lane FROM jobs WHERE state='running' ORDER BY started,seq").map_err(invalid)?;
        let running=stmt.query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"type":r.get::<_,String>(1)?,"lane":r.get::<_,String>(2)?}))).map_err(invalid)?.collect::<rusqlite::Result<Vec<_>>>().map_err(invalid)?;
        let mut lanes = json!({});
        let mut queued = 0;
        for (lane, n) in [("serial", 1), ("pool", self.pool)] {
            let depth: i64 = self
                .db
                .query_row(
                    "SELECT count(*) FROM jobs WHERE state='queued' AND lane=?",
                    [lane],
                    |r| r.get(0),
                )
                .map_err(invalid)?;
            queued += depth;
            lanes[lane] = json!({"concurrency":n,"active":running.iter().filter(|r|r["lane"]==lane).count(),"queueDepth":depth});
        }
        let (processed, last): (i64, Option<i64>) = self
            .db
            .query_row(
                "SELECT count(*),max(ended) FROM jobs WHERE state='done' AND ok=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(invalid)?;
        let health = decode(
            self.db
                .query_row("SELECT health FROM stats WHERE id=1", [], |r| r.get(0))
                .map_err(invalid)?,
        )?;
        Ok(
            json!({"processing":!running.is_empty(),"queueDepth":queued,"currentTask":running.first(),"active":running.len(),"capacity":self.pool+1,"concurrency":self.pool,"running":running,"lanes":lanes,"totalProcessed":processed,"lastTaskTime":last,"health":health}),
        )
    }
    pub fn history(&self, root: &Path, limit: i64) -> Result<Value> {
        let cap = if limit < 0 {
            usize::MAX
        } else {
            limit as usize
        };
        let mut rows = VecDeque::new();
        let mut push = |v: Value| {
            rows.push_back(v);
            if rows.len() > cap {
                rows.pop_front();
            }
        };
        let path = chat_history_file::transcript_path(&root.join("chat_history"), "__aux__");
        chat_history_file::visit_transcript(&path, |row| push(js::to_serde(&row)))
            .map_err(invalid)?;
        let mut stmt=self.db.prepare("SELECT * FROM (SELECT id,payload,started,ended,transport,answer,ok,cancelled,ts,seq FROM jobs WHERE state='done' AND started IS NOT NULL ORDER BY ended DESC,seq DESC LIMIT ?) ORDER BY ended,seq").map_err(invalid)?;
        let mut query = stmt
            .query([if limit < 0 { -1 } else { (limit + 1) / 2 }])
            .map_err(invalid)?;
        while let Some(r) = query.next().map_err(invalid)? {
            let id: String = r.get(0).map_err(invalid)?;
            let job = decode(r.get(1).map_err(invalid)?)?;
            let start: i64 = r.get(2).map_err(invalid)?;
            let end: i64 = r.get(3).map_err(invalid)?;
            let meta = decode(
                r.get::<_, Option<String>>(4)
                    .map_err(invalid)?
                    .unwrap_or_else(|| "{}".into()),
            )?;
            let msg: String = r.get(5).map_err(invalid)?;
            let ok: bool = r.get(6).map_err(invalid)?;
            let ts: i64 = r.get(8).map_err(invalid)?;
            let common = json!({"taskId":id,"protocol":meta["protocol"],"wireApi":meta["wireApi"],"transport":"directHttp"});
            let mut user = common.clone();
            user["role"] = "user".into();
            user["content"] = job["prompt"].clone();
            user["ts"] = ts.into();
            user["taskType"] = job["type"].clone();
            user["meta"] = job["meta"].clone();
            push(user);
            let mut assistant = common;
            assistant["role"] = "assistant".into();
            assistant["ts"] = end.into();
            assistant["durationMs"] = (end - start).into();
            assistant["cancelled"] = r.get::<_, bool>(7).map_err(invalid)?.into();
            assistant["enqueuedAt"] = ts.into();
            assistant["startedAt"] = start.into();
            assistant["queueMs"] = (start - ts).into();
            assistant["content"] = if ok {
                msg
            } else {
                assistant["error"] = true.into();
                format!("[ERROR] {msg}")
            }
            .into();
            if let Some(e) = meta.get("apiError") {
                assistant["apiError"] = e.clone();
            }
            push(assistant);
        }
        if limit < 0 {
            rows.drain(..rows.len().min(limit.unsigned_abs() as usize));
        }
        Ok(json!(rows))
    }
}
