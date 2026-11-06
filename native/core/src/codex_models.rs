//! 按账号隔离的 Codex 模型发现。磁盘和子进程操作均在扩展工作线程执行。
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const TTL: u64 = 86_400_000;
const MAX_BYTES: usize = 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(12);
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    model: String,
    label: String,
    is_default: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    models: Vec<Model>,
    fetched_at: u64,
    cli_version: String,
    stale: bool,
    diagnostic: Value,
    source: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Input {
    home: PathBuf,
    cli_bin: String,
    #[serde(default)]
    env: HashMap<String, String>,
    #[serde(default)]
    force: bool,
}
#[derive(Default)]
struct Entry {
    value: Mutex<Option<Catalog>>,
    gate: Mutex<()>,
    generation: AtomicU64,
    failure: Mutex<Option<(String, Instant)>>,
}
static ENTRIES: OnceLock<Mutex<HashMap<PathBuf, Arc<Entry>>>> = OnceLock::new();
fn entry(home: &Path) -> Arc<Entry> {
    ENTRIES
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .entry(home.to_owned())
        .or_default()
        .clone()
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn diagnostic(code: &str) -> Value {
    json!({"code":code,"message": match code { "ok"=>"已获取当前账号的模型目录。", "account_no_models"=>"当前账号没有返回可选模型。", "not_loaded"=>"模型目录尚未加载。", "catalog_stale"=>"当前目录来自旧缓存，后台刷新尚未获得新目录。", "catalog_unverified"=>"模型目录未提供可验证的获取时间。", "cli_timeout"=>"模型目录刷新超时，可稍后重试。", "cli_not_installed"=>"未找到 Codex CLI。", "cache_write_failed"=>"模型目录已获取，但缓存保存失败。", _=>"模型目录刷新失败，保留已有目录。" }})
}
fn empty() -> Catalog {
    Catalog {
        models: vec![],
        fetched_at: 0,
        cli_version: String::new(),
        stale: true,
        diagnostic: diagnostic("not_loaded"),
        source: "none".into(),
    }
}
pub fn peek(home: &str) -> String {
    let found = ENTRIES
        .get()
        .and_then(|entries| entries.lock().unwrap().get(Path::new(home)).cloned());
    let value = found
        .and_then(|e| e.value.lock().unwrap().clone())
        .unwrap_or_else(empty);
    serde_json::to_string(&value).unwrap()
}
/// 启动时只恢复已有账号目录，不启动 CLI，也不刷新获取时间。
pub fn load(home: &str) -> Result<String, String> {
    let home = Path::new(home);
    if !home.is_absolute()
        || home
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("模型目录参数无效".into());
    }
    let e = entry(home);
    let _gate = e.gate.lock().unwrap();
    let mut value = e.value.lock().unwrap().clone();
    if value.is_none() {
        let mut c = disk(home, true)
            .or_else(|| disk(home, false))
            .unwrap_or_else(empty);
        if c.fetched_at == 0 || now() < c.fetched_at || now() - c.fetched_at >= TTL {
            c.stale = true;
            if c.fetched_at > 0 {
                c.diagnostic = diagnostic("catalog_stale");
            }
        }
        *e.value.lock().unwrap() = Some(c.clone());
        value = Some(c);
    }
    Ok(serde_json::to_string(value.as_ref().unwrap()).unwrap())
}
fn fresh(c: &Catalog, version: &str, time: u64) -> bool {
    c.fetched_at > 0
        && time >= c.fetched_at
        && time - c.fetched_at < TTL
        && c.cli_version == version
        && !c.stale
}
fn normalize(rows: &[Value]) -> Vec<Model> {
    let mut seen = HashSet::new();
    rows.iter()
        .filter(|r| r.get("hidden") != Some(&Value::Bool(true)))
        .filter_map(|r| {
            let id = ["model", "id", "slug"]
                .iter()
                .find_map(|k| r.get(k).and_then(Value::as_str))?;
            if id.is_empty()
                || id.len() > 160
                || !id.bytes().next()?.is_ascii_alphanumeric()
                || !id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._:/-".contains(&b))
                || !seen.insert(id.to_owned())
            {
                return None;
            }
            let label = ["displayName", "display_name", "label"]
                .iter()
                .find_map(|k| r.get(k).and_then(Value::as_str))
                .unwrap_or(id)
                .chars()
                .map(|c| if c.is_control() { ' ' } else { c })
                .take(160)
                .collect();
            Some(Model {
                model: id.into(),
                label,
                is_default: r.get("isDefault").and_then(Value::as_bool).unwrap_or(false),
            })
        })
        .take(200)
        .collect()
}
fn read_json(path: &Path) -> Option<Value> {
    let file = fs::File::open(path).ok()?;
    let mut data = Vec::new();
    file.take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut data)
        .ok()?;
    if data.len() > MAX_BYTES {
        return None;
    }
    crate::json_lenient::from_slice(&data).ok()
}
fn disk(home: &Path, own: bool) -> Option<Catalog> {
    let value = read_json(&home.join(if own {
        "multicc_models_catalog.json"
    } else {
        "models_cache.json"
    }))?;
    if own {
        return serde_json::from_value(value).ok();
    }
    let mut rows: Vec<Value> = value
        .get("models")?
        .as_array()?
        .iter()
        .filter(|r| r.get("visibility").and_then(Value::as_str) == Some("list"))
        .cloned()
        .collect();
    rows.sort_by(|a, b| {
        a.get("priority")
            .and_then(Value::as_f64)
            .unwrap_or(999.0)
            .total_cmp(&b.get("priority").and_then(Value::as_f64).unwrap_or(999.0))
    });
    let fetched_at = value
        .get("fetched_at")
        .and_then(Value::as_str)
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.timestamp_millis().max(0) as u64)
        .unwrap_or(0);
    Some(Catalog {
        models: normalize(&rows),
        fetched_at,
        cli_version: value
            .get("client_version")
            .and_then(Value::as_str)
            .unwrap_or("")
            .into(),
        stale: true,
        diagnostic: diagnostic("catalog_stale"),
        source: "cli_cache".into(),
    })
}
fn save(home: &Path, c: &Catalog) -> Result<(), &'static str> {
    let temp = home.join(format!(
        ".multicc_models_catalog.{}.tmp",
        std::process::id()
    ));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut file = options.open(&temp)?;
        file.write_all(&serde_json::to_vec(c)?)?;
        file.sync_all()?;
        fs::rename(&temp, home.join("multicc_models_catalog.json"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result.map_err(|_: std::io::Error| "cache_write_failed")
}
struct Process {
    child: Child,
    output: mpsc::Receiver<Result<Vec<u8>, &'static str>>,
}
impl Drop for Process {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            unsafe extern "C" {
                fn kill(pid: i32, signal: i32) -> i32;
            }
            unsafe {
                kill(-(self.child.id() as i32), 9);
            }
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
fn spawn(input: &Input, args: &[&str]) -> Result<Process, &'static str> {
    let mut command = Command::new(&input.cli_bin);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .args(args)
        .env_clear()
        .envs(&input.env)
        .env("CODEX_HOME", &input.home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "cli_not_installed"
            } else {
                "cli_error"
            }
        })?;
    let mut stdout = child.stdout.take().unwrap();
    let (tx, output) = mpsc::sync_channel(16);
    thread::spawn(move || {
        let mut total = 0;
        loop {
            let mut b = vec![0; 8192];
            match stdout.read(&mut b) {
                Ok(0) => break,
                Ok(n) => {
                    total += n;
                    if total > MAX_BYTES {
                        let _ = tx.send(Err("cli_output_too_large"));
                        break;
                    }
                    b.truncate(n);
                    if tx.send(Ok(b)).is_err() {
                        break;
                    }
                }
                Err(_) => {
                    let _ = tx.send(Err("cli_error"));
                    break;
                }
            }
        }
    });
    Ok(Process { child, output })
}
fn receive(p: &Process, deadline: Instant) -> Result<Option<Vec<u8>>, &'static str> {
    match p
        .output
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
    {
        Ok(r) => r.map(Some),
        Err(mpsc::RecvTimeoutError::Timeout) => Err("cli_timeout"),
        Err(_) => Ok(None),
    }
}
fn version(input: &Input, deadline: Instant) -> Result<String, &'static str> {
    let mut p = spawn(input, &["--version"])?;
    p.child.stdin.take();
    let mut bytes = vec![];
    while let Some(b) = receive(&p, deadline)? {
        bytes.extend(b);
    }
    // 管道关闭不等于进程退出，等待仍须受总时限约束。
    loop {
        match p.child.try_wait() {
            Ok(Some(s)) if s.success() => break,
            Ok(Some(_)) | Err(_) => return Err("cli_error"),
            _ if Instant::now() >= deadline => return Err("cli_timeout"),
            _ => thread::sleep(Duration::from_millis(5)),
        }
    }
    let s = String::from_utf8_lossy(&bytes);
    s.split_whitespace()
        .find(|v| {
            v.len() <= 80
                && v.chars()
                    .all(|c| c.is_ascii_alphanumeric() || ".-+".contains(c))
                && v.split('.').take(3).count() == 3
                && v.starts_with(|c: char| c.is_ascii_digit())
        })
        .map(str::to_owned)
        .ok_or("cli_error")
}
fn send(p: &mut Process, message: Value) -> Result<(), &'static str> {
    let bytes = serde_json::to_vec(&message).unwrap();
    let stdin = p.child.stdin.as_mut().ok_or("cli_error")?;
    stdin
        .write_all(&bytes)
        .and_then(|_| stdin.write_all(b"\n"))
        .map_err(|_| "cli_error")
}
fn discover(input: &Input, deadline: Instant) -> Result<Vec<Model>, &'static str> {
    let mut p = spawn(input, &["app-server", "--stdio"])?;
    send(
        &mut p,
        json!({"method":"initialize","id":1,"params":{"clientInfo":{"name":"multicc","title":"MultiCC","version":"1"},"capabilities":{"experimentalApi":false,"requestAttestation":false}}}),
    )?;
    let mut pending = vec![];
    let mut id = 1;
    let mut rows = vec![];
    let mut pages = 0;
    let mut cursors = HashSet::new();
    loop {
        let bytes = receive(&p, deadline)?.ok_or("cli_error")?;
        pending.extend(bytes);
        while let Some(end) = pending.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = pending.drain(..=end).collect();
            let Ok(msg) = crate::json_lenient::from_slice::<Value>(&line) else {
                continue;
            };
            if msg.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if msg.get("error").is_some() {
                return Err("cli_error");
            }
            let result = msg.get("result").ok_or("cli_error")?;
            let cursor = if id == 1 {
                None
            } else {
                let data = result
                    .get("data")
                    .and_then(Value::as_array)
                    .ok_or("cli_error")?;
                rows.extend(data.iter().cloned());
                pages += 1;
                let next = result
                    .get("nextCursor")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty());
                if next.is_none() || rows.len() >= 200 {
                    return Ok(normalize(&rows));
                }
                let c = next.unwrap();
                if c.len() > 500 || pages >= 20 || !cursors.insert(c.to_owned()) {
                    return Err("cli_error");
                }
                Some(c.to_owned())
            };
            id += 1;
            send(
                &mut p,
                json!({"method":"model/list","id":id,"params":{"includeHidden":false,"limit":100,"cursor":cursor}}),
            )?;
        }
    }
}
pub fn refresh(input_json: &str) -> Result<String, String> {
    refresh_with_timeout(input_json, TIMEOUT)
}
fn refresh_with_timeout(input_json: &str, timeout: Duration) -> Result<String, String> {
    let input: Input =
        crate::json_lenient::from_str(input_json).map_err(|_| "模型目录参数无效".to_owned())?;
    if !input.home.is_absolute()
        || input
            .home
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
        || input.cli_bin.is_empty()
    {
        return Err("模型目录参数无效".into());
    }
    let e = entry(&input.home);
    let generation = e.generation.load(Ordering::SeqCst);
    let _gate = e.gate.lock().unwrap();
    if !input.force && e.generation.load(Ordering::SeqCst) != generation {
        return Ok(
            serde_json::to_string(&e.value.lock().unwrap().clone().unwrap_or_else(empty)).unwrap(),
        );
    }
    let cached = e.value.lock().unwrap().clone();
    let mut c = cached
        .or_else(|| disk(&input.home, true))
        .or_else(|| disk(&input.home, false))
        .unwrap_or_else(empty);
    let deadline = Instant::now() + timeout;
    let mut attempted_version = String::new();
    let mut throttled = false;
    let result = (|| {
        if input.force {
            // 重登可能换了身份：内存与 CLI 旧目录均不能跨登录沿用，清理失败则停止发现。
            c = empty();
            *e.value.lock().unwrap() = Some(c.clone());
            for name in ["multicc_models_catalog.json", "models_cache.json"] {
                if let Err(err) = fs::remove_file(input.home.join(name)) {
                    if err.kind() != std::io::ErrorKind::NotFound {
                        return Err("cache_reset_failed");
                    }
                }
            }
        }
        let v = version(&input, deadline)?;
        attempted_version = v.clone();
        if !input.force
            && e.failure
                .lock()
                .unwrap()
                .as_ref()
                .map(|(old, when)| old == &v && when.elapsed() < Duration::from_secs(30))
                .unwrap_or(false)
        {
            throttled = true;
            return Ok(());
        }
        if !input.force && fresh(&c, &v, now()) {
            c.source = "account_cache".into();
            return Ok(());
        }
        let models = discover(&input, deadline)?;
        let evidence = disk(&input.home, false);
        let fetched = evidence.as_ref().map(|d| d.fetched_at).unwrap_or(0);
        let verified = evidence
            .as_ref()
            .map(|d| d.cli_version == v && fetched > 0 && now() >= fetched && now() - fetched < TTL)
            .unwrap_or(false);
        // 在线失败时 app-server 可能静默回退旧文件。只信原 fetched_at，不以当前进程时间冒充新鲜目录。
        if !verified && c.fetched_at > fetched {
            c.stale = true;
            c.diagnostic = diagnostic("catalog_stale");
            return Ok(());
        }
        c = Catalog {
            models,
            fetched_at: fetched,
            cli_version: v,
            stale: !verified,
            diagnostic: diagnostic(if verified {
                "ok"
            } else if fetched == 0 {
                "catalog_unverified"
            } else {
                "catalog_stale"
            }),
            source: "app_server".into(),
        };
        if verified {
            if c.models.is_empty() {
                c.diagnostic = diagnostic("account_no_models");
            }
            save(&input.home, &c)?;
        }
        Ok(())
    })();
    if let Err(code) = result {
        c.stale = true;
        c.diagnostic = diagnostic(code);
    }
    if !throttled && c.stale {
        *e.failure.lock().unwrap() = Some((attempted_version, Instant::now()));
    } else if !throttled {
        *e.failure.lock().unwrap() = None;
    }
    *e.value.lock().unwrap() = Some(c.clone());
    e.generation.fetch_add(1, Ordering::SeqCst);
    Ok(serde_json::to_string(&c).unwrap())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    struct Fixture {
        home: PathBuf,
        cli: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let home = std::env::temp_dir().join(format!(
                "multicc-catalog-test-{}-{}",
                std::process::id(),
                COUNTER.fetch_add(1, Ordering::SeqCst)
            ));
            fs::create_dir_all(&home).unwrap();
            let cli = home.join("cli");
            fs::write(&cli,r#"#!/usr/bin/env python3
import os, sys, json, datetime, time
home=os.environ['CODEX_HOME']
version=os.environ.get('TEST_VERSION','1.2.3')
if '--version' in sys.argv:
 print('codex-cli '+version); sys.exit(0)
with open(home+'/calls','a') as f: f.write('call\n')
if os.environ.get('FAIL'):
 print('SECRET_TOKEN_MUST_NOT_ESCAPE',file=sys.stderr);sys.exit(1)
with open(home+'/pid','w') as f:f.write(str(os.getpid()))
if os.environ.get('SLEEP'):time.sleep(10)
if os.environ.get('DELAY'):time.sleep(0.2)
if os.environ.get('HUGE'):print('x'*1100000,flush=True);time.sleep(10)
if not os.environ.get('NO_CACHE'):
 stamp=(datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(days=2 if os.environ.get('OLD_CACHE') else 0)).isoformat()
 with open(home+'/models_cache.json','w') as f:json.dump({'models':[], 'fetched_at':stamp,'client_version':version},f)
for line in sys.stdin:
 req=json.loads(line)
 if req['method']=='initialize': result={'userAgent':'codex/'+version}
 elif req['params'].get('cursor'):result={'data':[{'model':'second','label':'第二个'}]}
 else:result={'data':[{'model':os.environ.get('MODEL','first'),'isDefault':True},{'model':'hidden','hidden':True}], 'nextCursor':'next'}
 print(json.dumps({'id':req['id'],'result':result}),flush=True)
"#).unwrap();
            fs::set_permissions(&cli, fs::Permissions::from_mode(0o700)).unwrap();
            Self { home, cli }
        }
        fn input(&self, extra: Value, force: bool) -> String {
            let mut env: HashMap<String, String> = HashMap::new();
            env.insert("PATH".into(), std::env::var("PATH").unwrap_or_default());
            for (k, v) in extra.as_object().unwrap() {
                env.insert(k.clone(), v.as_str().unwrap().into());
            }
            json!({"home":self.home,"cliBin":self.cli,"env":env,"force":force}).to_string()
        }
        fn run(&self, extra: Value, force: bool) -> Catalog {
            serde_json::from_str(&refresh(&self.input(extra, force)).unwrap()).unwrap()
        }
        fn calls(&self) -> usize {
            fs::read_to_string(self.home.join("calls"))
                .unwrap_or_default()
                .lines()
                .count()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.home);
        }
    }
    #[test]
    fn cold_pagination_and_fresh_cache() {
        let f = Fixture::new();
        let c = f.run(json!({}), false);
        assert!(!c.stale, "{:?}", c);
        assert_eq!(c.models.len(), 2);
        assert_eq!(c.models[1].model, "second");
        assert_eq!(f.calls(), 1);
        f.run(json!({}), false);
        assert_eq!(f.calls(), 1);
        assert_eq!(
            fs::metadata(f.home.join("multicc_models_catalog.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    #[test]
    fn ttl_exact_boundary() {
        let mut c = empty();
        c.stale = false;
        c.fetched_at = 1;
        c.cli_version = "1".into();
        assert!(fresh(&c, "1", TTL));
        assert!(!fresh(&c, "1", TTL + 1));
        assert!(!fresh(&c, "2", 2));
        assert!(!fresh(&c, "1", 0));
    }
    #[test]
    fn upgraded_cli_refreshes() {
        let f = Fixture::new();
        f.run(json!({}), false);
        let c = f.run(json!({"TEST_VERSION":"1.2.4"}), false);
        assert_eq!(f.calls(), 2);
        assert_eq!(c.cli_version, "1.2.4");
    }
    #[test]
    fn accounts_and_force_are_isolated() {
        let a = Fixture::new();
        let b = Fixture::new();
        a.run(json!({"MODEL":"a"}), false);
        b.run(json!({"MODEL":"b"}), false);
        let c: Catalog = serde_json::from_str(&peek(a.home.to_str().unwrap())).unwrap();
        assert_eq!(c.models[0].model, "a");
        let c = a.run(json!({"FAIL":"1"}), true);
        assert!(c.models.is_empty());
        assert!(!a.home.join("multicc_models_catalog.json").exists());
        let c: Catalog = serde_json::from_str(&peek(b.home.to_str().unwrap())).unwrap();
        assert_eq!(c.models[0].model, "b");
    }
    #[test]
    fn failure_preserves_disk_and_throttles() {
        let f = Fixture::new();
        f.run(json!({}), false);
        let original = fs::read(f.home.join("multicc_models_catalog.json")).unwrap();
        let c = f.run(json!({"FAIL":"1","TEST_VERSION":"1.2.4"}), false);
        assert_eq!(c.models.len(), 2);
        assert!(c.stale);
        assert_eq!(
            fs::read(f.home.join("multicc_models_catalog.json")).unwrap(),
            original
        );
        f.run(json!({"FAIL":"1","TEST_VERSION":"1.2.4"}), false);
        assert_eq!(f.calls(), 2);
        let result = serde_json::to_string(&c).unwrap();
        assert!(!result.contains("SECRET"));
    }
    #[test]
    fn old_cli_cache_does_not_claim_online_success() {
        let f = Fixture::new();
        let c = f.run(json!({"OLD_CACHE":"1"}), false);
        assert!(c.stale);
        assert!(now() - c.fetched_at > TTL);
        assert_eq!(c.diagnostic["code"], "catalog_stale");
        assert!(!f.home.join("multicc_models_catalog.json").exists());
    }
    #[test]
    fn missing_timestamp_is_unverified() {
        let f = Fixture::new();
        let c = f.run(json!({"NO_CACHE":"1"}), false);
        assert!(c.stale);
        assert_eq!(c.fetched_at, 0);
        assert_eq!(c.diagnostic["code"], "catalog_unverified");
    }
    #[test]
    fn timeout_is_bounded() {
        let f = Fixture::new();
        let start = Instant::now();
        let c: Catalog = serde_json::from_str(
            &refresh_with_timeout(
                &f.input(json!({"SLEEP":"1"}), false),
                Duration::from_millis(500),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(c.diagnostic["code"], "cli_timeout");
        assert!(start.elapsed() < Duration::from_secs(2));
    }
    #[test]
    fn peek_does_not_load_disk() {
        let f = Fixture::new();
        fs::write(
            f.home.join("models_cache.json"),
            r#"{"models":[{"slug":"wrong","visibility":"list"}]}"#,
        )
        .unwrap();
        let c: Catalog = serde_json::from_str(&peek(f.home.to_str().unwrap())).unwrap();
        assert!(c.models.is_empty());
        assert_eq!(c.diagnostic["code"], "not_loaded");
    }
    #[test]
    fn concurrent_normal_refreshes_merge_but_force_is_preserved() {
        let f = Fixture::new();
        let first = f.input(json!({"DELAY":"1"}), false);
        let a = thread::spawn(move || refresh(&first).unwrap());
        let deadline = Instant::now() + Duration::from_secs(2);
        while f.calls() == 0 && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        let ordinary = f.input(json!({}), false);
        let b = thread::spawn(move || refresh(&ordinary).unwrap());
        a.join().unwrap();
        b.join().unwrap();
        assert_eq!(f.calls(), 1);
        let first = f.input(json!({"DELAY":"1","TEST_VERSION":"1.2.4"}), false);
        let a = thread::spawn(move || refresh(&first).unwrap());
        while f.calls() < 2 && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        let forced = f.run(json!({"MODEL":"new-account","TEST_VERSION":"1.2.4"}), true);
        a.join().unwrap();
        assert_eq!(f.calls(), 3);
        assert_eq!(forced.models[0].model, "new-account");
    }
    #[test]
    fn output_is_bounded_and_child_is_reaped() {
        let f = Fixture::new();
        let c = f.run(json!({"HUGE":"1"}), false);
        assert_eq!(c.diagnostic["code"], "cli_output_too_large");
        let pid: i32 = fs::read_to_string(f.home.join("pid"))
            .unwrap()
            .parse()
            .unwrap();
        unsafe extern "C" {
            fn kill(pid: i32, signal: i32) -> i32;
        }
        assert_eq!(unsafe { kill(pid, 0) }, -1);
    }
    #[test]
    fn load_restores_disk_without_cli_or_overwriting_memory() {
        let f = Fixture::new();
        let c = f.run(json!({}), false);
        ENTRIES.get().unwrap().lock().unwrap().remove(&f.home);
        let restored: Catalog =
            serde_json::from_str(&load(f.home.to_str().unwrap()).unwrap()).unwrap();
        assert_eq!(restored.fetched_at, c.fetched_at);
        assert_eq!(restored.models.len(), 2);
        assert_eq!(f.calls(), 1);
        fs::remove_file(f.home.join("multicc_models_catalog.json")).unwrap();
        let retained: Catalog =
            serde_json::from_str(&load(f.home.to_str().unwrap()).unwrap()).unwrap();
        assert_eq!(retained.models.len(), 2);
        assert!(load("relative").is_err());
    }
}
