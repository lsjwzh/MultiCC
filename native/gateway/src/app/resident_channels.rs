//! Resident process state and configured channel uses owned by the standalone daemon.
use super::{
    express::{self, RequestCtx},
    App,
};
use axum::{body::Body, http::Response};
use multicc_core::{egress_plugin, events, js::serde::truthy, plugin_routes};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashSet},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, BufReader},
    process::Command,
    sync::oneshot,
    task::JoinHandle,
};

type Row = Arc<Mutex<Value>>;
#[derive(Default)]
pub(crate) struct Registry(Mutex<BTreeMap<String, Row>>);
struct Spec {
    id: String,
    dir: PathBuf,
    binary: Option<PathBuf>,
    modified: Option<SystemTime>,
    status: Value,
}
struct Slot {
    spec: Spec,
    row: Row,
    process: Option<Worker>,
}
impl Slot {
    async fn stop(self) {
        if let Some(worker) = self.process {
            worker.stop().await;
        }
    }
}
pub(crate) struct Worker(oneshot::Sender<()>, JoinHandle<()>);
impl Worker {
    pub(crate) async fn stop(self) {
        let _ = self.0.send(());
        let _ = self.1.await;
    }
}

fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
fn limited(v: &Value, n: usize) -> String {
    String::from_utf16_lossy(
        &v.as_str()
            .unwrap_or("")
            .encode_utf16()
            .take(n)
            .collect::<Vec<_>>(),
    )
}
fn read(path: &Path) -> Value {
    std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}
fn items(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or_default()
}
fn fallback(v: &Value, default: Value) -> Value {
    if truthy(v) {
        v.clone()
    } else {
        default
    }
}
fn valid_id(id: &str) -> bool {
    id.as_bytes().first().is_some_and(u8::is_ascii_alphanumeric)
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}
fn channel(v: &Value) -> Value {
    let label = limited(&v["label"], 40);
    if label.is_empty() {
        return Value::Null;
    }
    let platforms: Vec<_> = items(&v["platforms"])
        .iter()
        .filter(|p| p.is_string())
        .collect();
    json!({"label":label,"labelEn":fallback(&json!(limited(&v["labelEn"],40)),Value::Null),"platforms":(!platforms.is_empty()).then_some(platforms)})
}
fn scan(package: &Path, user: &Path) -> Vec<Spec> {
    let platform_arch =
        egress_plugin::node_platform_arch_for(std::env::consts::OS, std::env::consts::ARCH);
    let platform = platform_arch.split('-').next().unwrap_or("");
    let mut seen = HashSet::new();
    let mut specs = vec![];
    for root in [package.join("plugins"), user.to_owned()] {
        for entry in std::fs::read_dir(root).into_iter().flatten().flatten() {
            if !entry.file_type().is_ok_and(|ty| ty.is_dir()) {
                continue;
            }
            let id = entry.file_name().to_string_lossy().into_owned();
            if !valid_id(&id) || seen.contains(&id) {
                continue;
            }
            let dir = entry.path();
            let m = read(&dir.join("plugin.json"));
            let e = &m["engine"];
            let Some(bin) = e["binary"].as_str().filter(|b| !b.is_empty()) else {
                continue;
            };
            if m["id"] != id || items(&m["commands"]).is_empty() || e["type"] != "command" {
                continue;
            }
            seen.insert(id.clone());
            if e["resident"] != true {
                continue;
            }
            let binary = egress_plugin::command_binary(
                &dir,
                e.as_object().unwrap(),
                bin,
                &platform_arch,
                cfg!(windows),
            );
            let c = channel(&m["channel"]);
            let unsupported = if binary.is_none() {
                Some("binary-missing")
            } else if c["platforms"]
                .as_array()
                .is_some_and(|p| !p.iter().any(|v| v == platform))
                || m["requires"]["platforms"]
                    .as_array()
                    .is_some_and(|p| !p.is_empty() && !p.iter().any(|v| v["os"] == platform))
            {
                Some("platform")
            } else {
                None
            };
            let mut status = json!({"id":id,"name":fallback(&m["name"],json!(id)),"nameEn":fallback(&m["nameEn"],Value::Null),"version":fallback(&m["version"],json!("0.0.0")),"channel":c,"ui":null,"running":false,"ready":false});
            if let Some(reason) = unsupported {
                status["unsupported"] = json!(reason);
            } else {
                if let Some(ui) = m["ui"].as_str().filter(|s| !s.is_empty()) {
                    status["ui"] = json!(format!("/plugins/{id}/{}", ui.trim_start_matches('/')));
                }
                for k in ["pid", "startedAt", "readyAt", "lastExit"] {
                    status[k] = Value::Null;
                }
                status["restarts"] = 0.into();
            }
            status["alerts"] = json!([]);
            let modified = binary
                .as_ref()
                .and_then(|b| b.metadata().ok()?.modified().ok());
            specs.push(Spec {
                id,
                dir,
                binary,
                modified,
                status,
            });
        }
    }
    specs
}

fn alert(row: &mut Value, msg: &Value, from_host: bool) {
    let key = limited(&msg["key"], 64);
    if !valid_id(&key) {
        return;
    }
    let alerts = row["alerts"].as_array_mut().unwrap();
    if let Some(i) = alerts.iter().position(|a| a["key"] == key) {
        if msg["resolved"] == true {
            alerts.remove(i);
        }
        return;
    }
    if msg["resolved"] != true && alerts.len() < 20 {
        alerts.push(json!({"key":key,"level":if msg["level"]=="critical"{"critical"}else{"warn"},"title":fallback(&json!(limited(&msg["title"],120)),json!(key)),"body":limited(&msg["body"],500),"at":now(),"fromHost":from_host}));
    }
}
fn down_alert(row: &Row) {
    let mut r = row.lock().unwrap();
    if r["ready"] == true {
        return;
    }
    let name = r["name"].as_str().unwrap_or("");
    let title = format!("{name} 停止运行");
    let body = if r["lastExit"].is_null() {
        "插件进程启动后一直没有就绪。在 MultiCC「资料与插件 → 插件」查看。".to_owned()
    } else {
        let last = r["lastExit"]["signal"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| format!("退出码 {}", r["lastExit"]["code"]));
        format!("插件进程已重启 {} 次仍未恢复（最后一次退出：{last}）。在 MultiCC「资料与插件 → 插件」查看。",r["restarts"])
    };
    alert(
        &mut r,
        &json!({"key":"plugin-down","title":title,"level":"critical","body":body}),
        true,
    );
}
async fn down_timer(row: &Row, down: i64) {
    tokio::time::sleep(Duration::from_millis((down + 60010 - now()).max(0) as u64)).await;
    down_alert(row);
    std::future::pending::<()>().await;
}
async fn watch(
    row: Row,
    binary: PathBuf,
    dir: PathBuf,
    data: PathBuf,
    id: String,
    port: u16,
    mut stop: oneshot::Receiver<()>,
) {
    let mut failures = 0usize;
    let mut down = now();
    let manifest_version = row.lock().unwrap()["version"].clone();
    loop {
        let started = now();
        row.lock().unwrap()["startedAt"] = started.into();
        let result = Command::new(&binary)
            .arg("serve")
            .current_dir(&dir)
            .env("MULTICC_PLUGIN_ID", &id)
            .env("MULTICC_PLUGIN_PROTOCOL", "1")
            .env("MULTICC_PLUGIN_DATA_DIR", data.join(&id))
            .env("MULTICC_BASE_URL", format!("http://127.0.0.1:{port}"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn();
        let exit = match result {
            Ok(mut child) => {
                {
                    let mut r = row.lock().unwrap();
                    r["pid"] = json!(child.id());
                    r["running"] = true.into();
                }
                let output = child.stdout.take().unwrap();
                let status = row.clone();
                let manifest_version = &manifest_version;
                let reader = async move {
                    let mut r = BufReader::new(output);
                    loop {
                        let mut line = vec![];
                        let count = (&mut r)
                            .take(4 * 1024 * 1024 + 1)
                            .read_until(b'\n', &mut line)
                            .await?;
                        if count == 0 {
                            return Ok::<_, std::io::Error>(false);
                        }
                        if count > 4 * 1024 * 1024 {
                            return Ok(true);
                        }
                        if let Ok(msg) = serde_json::from_slice::<Value>(&line) {
                            let mut row = status.lock().unwrap();
                            match msg["event"].as_str() {
                                Some("hello") => {
                                    row["ready"] = true.into();
                                    row["readyAt"] = now().into();
                                    let version = limited(&msg["version"], 40);
                                    row["version"] = if version.is_empty() {
                                        manifest_version.clone()
                                    } else {
                                        version.into()
                                    };
                                    alert(
                                        &mut row,
                                        &json!({"key":"plugin-down","resolved":true}),
                                        true,
                                    );
                                }
                                Some("alert") => alert(&mut row, &msg, false),
                                _ => {}
                            }
                        }
                    }
                };
                // Keep stdin open for the entire child lifetime (Child::wait closes its owned stdin).
                let lifeline = child.stdin.take();
                tokio::pin!(reader);
                let supervise = async {
                    tokio::select! {
                        result=child.wait()=>result,
                        read=&mut reader=>{
                            if matches!(read,Ok(true)){let _=child.start_kill();}
                            child.wait().await
                        }
                    }
                };
                let result = tokio::select! {
                    res=supervise=>Some(res),_=down_timer(&row,down)=>unreachable!(),_=&mut stop=>None
                };
                let Some(result) = result else {
                    drop(lifeline);
                    if tokio::time::timeout(Duration::from_secs(3), child.wait())
                        .await
                        .is_err()
                    {
                        let _ = child.kill().await;
                    }
                    return;
                };
                match result {
                    Ok(status) => {
                        #[cfg(unix)]
                        let signal = {
                            use std::os::unix::process::ExitStatusExt;
                            crate::remote_child::signal_name(status.signal())
                        };
                        #[cfg(not(unix))]
                        let signal: Option<String> = None;
                        json!({"code":status.code(),"signal":signal,"at":now()})
                    }
                    Err(e) => json!({"code":null,"signal":null,"at":now(),"error":e.to_string()}),
                }
            }
            Err(e) => {
                json!({"code":null,"signal":null,"at":now(),"error":format!("spawn {} {}",binary.display(), match e.kind(){std::io::ErrorKind::PermissionDenied=>"EACCES",std::io::ErrorKind::NotFound=>"ENOENT",_=>"EIO"})})
            }
        };
        if now() - started >= 60000 {
            failures = 0
        }
        let delay = [1, 5, 30, 300][failures.min(3)];
        failures += 1;
        {
            let mut r = row.lock().unwrap();
            if r["ready"] == true {
                down = now();
            }
            r["running"] = false.into();
            r["ready"] = false.into();
            r["pid"] = Value::Null;
            r["readyAt"] = Value::Null;
            r["lastExit"] = exit;
            r["restarts"] = failures.into();
        }
        tokio::select! {_=tokio::time::sleep(Duration::from_secs(delay))=>{},_=down_timer(&row,down)=>unreachable!(),_=&mut stop=>return}
    }
}
pub(crate) async fn start(app: &Arc<App>, port: u16) -> Worker {
    let app = app.clone();
    let (stop, mut stopped) = oneshot::channel();
    let (ready, started) = oneshot::channel();
    let join = tokio::spawn(async move {
        let mut ready = Some(ready);
        let mut slots = BTreeMap::<String, Slot>::new();
        let user = if app.data_root == app.package_root {
            app.home_dir.join(".multicc/plugins")
        } else {
            app.data_root.join("plugins")
        };
        loop {
            let pkg = app.package_root.clone();
            let u = user.clone();
            if let Ok(specs) = tokio::task::spawn_blocking(move || scan(&pkg, &u)).await {
                let ids: HashSet<_> = specs.iter().map(|s| s.id.clone()).collect();
                let removed: Vec<_> = slots
                    .keys()
                    .filter(|k| !ids.contains(*k))
                    .cloned()
                    .collect();
                for id in removed {
                    if let Some(slot) = slots.remove(&id) {
                        slot.stop().await;
                    }
                }
                for spec in specs {
                    if slots.get(&spec.id).is_some_and(|s| {
                        s.spec.binary == spec.binary
                            && s.spec.modified == spec.modified
                            && s.spec.status == spec.status
                    }) {
                        continue;
                    }
                    if let Some(slot) = slots.remove(&spec.id) {
                        slot.stop().await;
                    }
                    let row = Arc::new(Mutex::new(spec.status.clone()));
                    let process = spec
                        .binary
                        .as_ref()
                        .filter(|_| spec.status["unsupported"].is_null())
                        .map(|bin| {
                            let (stop, stopped) = oneshot::channel();
                            Worker(
                                stop,
                                tokio::spawn(watch(
                                    row.clone(),
                                    bin.clone(),
                                    spec.dir.clone(),
                                    user.with_file_name("plugins-data"),
                                    spec.id.clone(),
                                    port,
                                    stopped,
                                )),
                            )
                        });
                    slots.insert(spec.id.clone(), Slot { spec, row, process });
                }
                *app.channels.0.lock().unwrap() = slots
                    .iter()
                    .map(|(id, s)| (id.clone(), s.row.clone()))
                    .collect();
            }
            if let Some(r) = ready.take() {
                let _ = r.send(());
            }
            tokio::select! {_=&mut stopped=>break,_=tokio::time::sleep(Duration::from_secs(30))=>{}}
        }
        futures_util::future::join_all(slots.into_values().map(Slot::stop)).await;
    });
    let _ = started.await;
    Worker(stop, join)
}
fn usage(root: &Path) -> Vec<Value> {
    let mut result = vec![];
    for sub in items(&read(&root.join("channel-subscriptions.json"))["subscriptions"]) {
        let p = sub["plugin"].as_str().unwrap_or("");
        let t = sub["target"].as_str().unwrap_or("");
        if sub["id"].is_string()
            && sub["enabled"] != false
            && valid_id(p)
            && p.len() <= 64
            && p.bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            && !t.is_empty()
            && t.len() <= 64
            && t.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
        {
            result.push(json!({"plugin":p,"kind":"push"}));
        }
    }
    let mut add = |rule: &Value| {
        if truthy(&rule["enabled"]) {
            for a in items(&events::channel_actions(Some(rule))) {
                result.push(json!({"plugin":a["plugin"],"kind":"hook"}));
            }
        }
    };
    for rule in items(&read(&root.join("event_rules.json"))["rules"]) {
        add(rule);
    }
    for session in super::directory_list::records(&root.join("sessions.json")).unwrap_or_default() {
        for t in items(&session["triggers"]) {
            if t["type"] == "event" {
                add(t);
            }
        }
    }
    result
}
pub(crate) async fn list(app: &Arc<App>, ctx: &RequestCtx) -> Response<Body> {
    let rows: Vec<_> = app
        .channels
        .0
        .lock()
        .unwrap()
        .values()
        .map(|v| v.lock().unwrap().clone())
        .collect();
    let root = app.data_root.clone();
    match tokio::task::spawn_blocking(move || plugin_routes::shape_channels(&rows, &usage(&root)))
        .await
    {
        Ok(Ok(rows)) => express::send(
            ctx,
            200,
            "application/json; charset=utf-8",
            plugin_routes::channels_response(true, &rows).into_bytes(),
            &[("Cache-Control", plugin_routes::CHANNELS_CACHE_CONTROL)],
        ),
        _ => express::error(ctx, 500, "channel status unavailable"),
    }
}
