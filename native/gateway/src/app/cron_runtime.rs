use super::{
    cron_list::{field, Bindings},
    App,
};
use chrono::{Datelike, Local, Timelike};
use multicc_core::{js::serde::truthy, random_id::random_uuid_v4, state_file};
use serde_json::{json, Value};
use std::{path::Path, sync::Arc, time::Duration};
use tokio::sync::Mutex;

#[derive(Default)]
pub(crate) struct ExecutionLocks(
    Mutex<std::collections::HashMap<String, std::sync::Weak<Mutex<()>>>>,
);

impl ExecutionLocks {
    pub(super) async fn for_rule(&self, id: &str) -> Arc<Mutex<()>> {
        let mut rules = self.0.lock().await;
        if let Some(lock) = rules.get(id).and_then(std::sync::Weak::upgrade) {
            return lock;
        }
        rules.retain(|_, lock| lock.strong_count() > 0);
        let lock = Arc::new(Mutex::new(()));
        rules.insert(id.to_owned(), Arc::downgrade(&lock));
        lock
    }
}

fn rules(root: &Path, package: &Path) -> Result<Vec<Value>, String> {
    let path = root.join("scheduled_tasks.json");
    let file = if path.try_exists().map_err(|e| e.to_string())? {
        path
    } else {
        package.join("plugins/cron/scheduled_tasks.json")
    };
    match std::fs::read(file) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| "invalid schedule store".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
        Err(e) => Err(e.to_string()),
    }
}
fn save(root: &Path, tasks: &[Value]) -> Result<(), String> {
    state_file::write_json_atomic(&root.join("scheduled_tasks.json"), &json!(tasks))
        .map_err(|e| e.to_string())
}
fn matches(expr: &str, time: &chrono::DateTime<Local>) -> bool {
    let fields: Vec<_> = expr.split_whitespace().collect();
    if fields.len() != 5 {
        return false;
    }
    let values = [
        time.minute(),
        time.hour(),
        time.day(),
        time.month(),
        time.weekday().num_days_from_sunday(),
    ];
    let bounds = [(0, 59), (0, 23), (1, 31), (1, 12), (0, 6)];
    let mut hit = [false; 5];
    let mut restricted = [false; 5];
    for (i, (lo, hi)) in bounds.into_iter().enumerate() {
        let Some(mask) = field(fields[i], lo, hi) else {
            return false;
        };
        hit[i] = mask & (1 << values[i]) != 0;
        restricted[i] = mask.count_ones() != hi - lo + 1;
    }
    hit[0]
        && hit[1]
        && hit[3]
        && if restricted[2] && restricted[4] {
            hit[2] || hit[4]
        } else {
            hit[2] && hit[4]
        }
}

// Recognize the legacy minute key on upgrades. New keys distinguish dates and
// local times that have the same unpadded digits, including DST repeats.
fn schedule_key(task: &Value, now: &chrono::DateTime<Local>) -> Option<String> {
    if !truthy(&task["enabled"]) || !matches(task["cron"].as_str().unwrap_or_default(), now) {
        return None;
    }
    let minute = format!("m{}", now.timestamp().div_euclid(60));
    let legacy = format!(
        "{}{}{}{}{}",
        now.year(),
        now.month0(),
        now.day(),
        now.hour(),
        now.minute()
    );
    (task["_tickKey"] != minute && task["_tickKey"] != legacy).then_some(minute)
}

#[derive(Clone)]
enum Reason {
    Manual,
    Schedule(chrono::DateTime<Local>),
    Recover,
}
struct Claim {
    task: Value,
    dir: Value,
    error: Option<String>,
    interrupted: bool,
}
fn claim(app: &App, id: &str, reason: &Reason) -> Result<Option<Claim>, String> {
    let mut tasks = rules(&app.data_root, &app.package_root)?;
    let Some(t) = tasks.iter_mut().find(|t| t["id"] == id) else {
        return Ok(None);
    };
    let recovering = t["_pendingFire"].is_object();
    if !recovering {
        let (reason, key) = match reason {
            Reason::Manual => ("manual", random_uuid_v4().map_err(|e| e.to_string())?),
            Reason::Schedule(now) => {
                let Some(key) = schedule_key(t, now) else {
                    return Ok(None);
                };
                t["_tickKey"] = json!(key);
                ("schedule", key)
            }
            _ => return Ok(None),
        };
        t["_pendingFire"] =
            json!({"reason":reason,"key":key,"at":chrono::Utc::now().timestamp_millis()});
    }
    let dirs = super::directory_list::records(&app.data_root.join("directories.json"))?;
    let dir = dirs
        .into_iter()
        .find(|d| d["id"] == t["dirId"])
        .unwrap_or_default();
    let error = if dir.is_null() {
        Some("目标目录不存在".into())
    } else if t["kind"] != "script" {
        Bindings::open(&app.data_root, &app.home_dir)?
            .bind(t, Some(&dir))
            .err()
    } else {
        None
    };
    let claim = Claim {
        task: t.clone(),
        dir,
        error,
        interrupted: recovering && t["kind"] == "script",
    };
    save(&app.data_root, &tasks)?;
    Ok(Some(claim))
}
fn prefix(text: &str, limit: usize) -> String {
    String::from_utf16_lossy(&text.encode_utf16().take(limit).collect::<Vec<_>>())
}
async fn execute(app: &Arc<App>, claim: &Claim) -> Value {
    let t = &claim.task;
    if let Some(e) = &claim.error {
        return json!({"ok":false,"error":e});
    }
    if claim.interrupted {
        return json!({"ok":false,"error":"脚本执行期间服务中断","exitCode":null});
    }
    if t["kind"] == "script" {
        let Some(dir) = claim.dir["path"].as_str().filter(|p| !p.is_empty()) else {
            return json!({"ok":false,"error":"目标目录不存在"});
        };
        let (code, out, timed) = super::cron_script::execute(
            t["command"].as_str().unwrap_or_default(),
            Path::new(dir),
            t["scriptTimeoutMs"]
                .as_u64()
                .filter(|n| *n > 0)
                .unwrap_or(120000),
        )
        .await;
        let mut error = if timed {
            "脚本超时".into()
        } else {
            format!("脚本退出码 {code}")
        };
        if !out.is_empty() {
            error.push('：');
            error.push_str(&prefix(&out, 120));
        }
        return json!({"ok":code==0,"error":(code!=0).then_some(error),"exitCode":code,"output":out});
    }
    let run = &t["_pendingFire"];
    let id = format!(
        "cron-run:{}:{}:{}",
        t["id"].as_str().unwrap_or(""),
        run["reason"].as_str().unwrap_or(""),
        run["key"].as_str().unwrap_or("")
    );
    let client: String = id
        .chars()
        .take(160)
        .map(|c| {
            if c.is_ascii_alphanumeric() || "_.:-".contains(c) {
                c
            } else {
                '_'
            }
        })
        .collect();
    let request = json!({"op":"task-message","taskId":t["taskId"],"body":{"text":t["prompt"],"clientMsgId":client,"intent":"work","taskSource":"cron","taskText":t["name"]}});
    match crate::ws_chat_native::shell_delivery(app, request).await {
        Ok(v) => v,
        Err(e) => {
            let detail = e
                .strip_prefix("TASK_RULE:")
                .and_then(|s| serde_json::from_str::<Value>(s).ok())
                .unwrap_or_default();
            json!({"ok":false,"error":detail["message"].as_str().unwrap_or(&e)})
        }
    }
}
fn finish(app: &App, claim: &Claim, result: Value) -> Result<Value, String> {
    let mut tasks = rules(&app.data_root, &app.package_root)?;
    let t = tasks
        .iter_mut()
        .find(|t| t["id"] == claim.task["id"])
        .ok_or("schedule missing")?;
    if t["_pendingFire"] != claim.task["_pendingFire"] {
        return Err("schedule claim changed".into());
    }
    let run = t
        .as_object_mut()
        .ok_or("invalid schedule")?
        .shift_remove("_pendingFire")
        .ok_or("missing schedule claim")?;
    let ok = result["ok"] == true;
    let error = result["error"]
        .as_str()
        .unwrap_or(if ok { "" } else { "任务执行失败" });
    let status = if !ok {
        "error"
    } else if result["decision"] == "queued" {
        "queued"
    } else {
        "ok"
    };
    let session = result
        .get("sessionId")
        .filter(|v| truthy(v))
        .unwrap_or(&t["taskSessionId"])
        .clone();
    let mut row = json!({"at":run["at"],"reason":run["reason"],"status":status,"decision":result["decision"],
        "taskId":t["taskId"],"sessionId":session,"receiptId":result["receiptId"],"error":prefix(error,200)});
    if t["kind"] == "script" {
        t["lastExitCode"] = result["exitCode"].clone();
        t["lastOutput"] = json!(result["output"].as_str().unwrap_or(""));
        if !t["lastExitCode"].is_null() {
            row["exitCode"] = t["lastExitCode"].clone();
        }
        if truthy(&t["lastOutput"]) {
            row["output"] = json!(prefix(t["lastOutput"].as_str().unwrap_or_default(), 2000));
        }
    } else if ok {
        t["lastReceiptId"] = result["receiptId"].clone();
        t["lastDecision"] = json!(result["decision"].as_str().unwrap_or("continue"));
    } else if claim.error.is_some() {
        t["taskBindingError"] = json!(error);
        if t["taskBindingBrokenAt"].is_null() {
            t["taskBindingBrokenAt"] = run["at"].clone();
        }
    }
    if !session.is_null() {
        t["taskSessionId"] = session.clone();
        t["lastSessionId"] = session.clone();
    }
    t["lastStatus"] = json!(status);
    t["lastRunAt"] = run["at"].clone();
    t["lastError"] = json!(error);
    t["runCount"] = json!(t["runCount"].as_u64().unwrap_or_default() + 1);
    let mut rows = t["runs"].as_array().cloned().unwrap_or_default();
    rows.push(row);
    rows.drain(..rows.len().saturating_sub(20));
    t["runs"] = json!(rows);
    let body = json!({"ok":ok,"taskId":t["taskId"],"sessionId":session,"receiptId":result["receiptId"],"decision":result["decision"],
        "exitCode":t["lastExitCode"],"error":(!ok).then_some(error)});
    save(&app.data_root, &tasks)?;
    Ok(body)
}
async fn fire(app: &Arc<App>, id: String, reason: Reason) -> Result<Option<Value>, String> {
    let claim = {
        let _lock = app.cron_lock.lock().await;
        let _records = app.native_chat.records.lock().await;
        let owner = app.clone();
        tokio::task::spawn_blocking(move || claim(&owner, &id, &reason))
            .await
            .map_err(|e| e.to_string())??
    };
    let Some(claim) = claim else { return Ok(None) };
    let result = execute(app, &claim).await;
    let _lock = app.cron_lock.lock().await;
    let owner = app.clone();
    tokio::task::spawn_blocking(move || finish(&owner, &claim, result))
        .await
        .map_err(|e| e.to_string())?
        .map(Some)
}
pub(super) async fn manual(app: &Arc<App>, id: String) -> Result<(u16, Value), String> {
    let app = app.clone();
    tokio::spawn(async move {
        let _execution = app.cron_execution.for_rule(&id).await.lock_owned().await;
        fire(&app, id.clone(), Reason::Recover).await?;
        fire(&app, id, Reason::Manual).await
    })
    .await
    .map_err(|e| e.to_string())?
    .map(|v| {
        v.map(|r| (200, r))
            .unwrap_or_else(|| (404, json!({"error":"task not found"})))
    })
}
pub(crate) async fn run(app: Arc<App>) {
    let mut workers = tokio::task::JoinSet::new();
    let mut ticks = tokio::time::interval(Duration::from_secs(30));
    ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut recovery = true;
    loop {
        tokio::select! {
            _ = ticks.tick() => (),
            Some(_) = workers.join_next(), if !workers.is_empty() => continue,
        }
        let owner = app.clone();
        let now = Local::now();
        let jobs = tokio::task::spawn_blocking(move || {
            Ok::<_, String>(
                rules(&owner.data_root, &owner.package_root)?
                    .into_iter()
                    .filter_map(|t| {
                        let id = t["id"].as_str()?.to_owned();
                        if t["_pendingFire"].is_object() {
                            return Some((id, Reason::Recover));
                        }
                        (!recovery && schedule_key(&t, &now).is_some())
                            .then_some((id, Reason::Schedule(now)))
                    })
                    .collect::<Vec<_>>(),
            )
        })
        .await;
        if let Ok(Ok(jobs)) = jobs {
            for (id, reason) in jobs {
                let Ok(execution) = app.cron_execution.for_rule(&id).await.try_lock_owned() else {
                    continue;
                };
                let owner = app.clone();
                workers.spawn(async move {
                    let _execution = execution;
                    if fire(&owner, id, reason).await.is_err() {
                        eprintln!("[multicc-gateway] cron storage unavailable");
                    }
                });
            }
        }
        recovery = false;
    }
}
