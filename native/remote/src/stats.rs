//! 测试观测：各条 H.264 流的统计（docs/remote-screen-process.md §5）。
//!
//! 只在设了 MULTICC_REMOTE_STATS_FILE 时才写文件，且每 200 ms 原子替换一次
//! （写临时文件再 rename），读的人永远看到一份完整的 JSON。只给测试台用。

use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

pub const WRITE_INTERVAL_MS: u64 = 200;

#[derive(Debug)]
pub struct Counters {
    pub forwarded: AtomicU64,
    pub dropped: AtomicU64,
    pub key_requests: AtomicU64,
    pub p2p_opened: AtomicU64,
    /// "relay" / "p2p"：字符串要能换，用数字下标映射。
    pub transport: Mutex<&'static str>,
    /// 这条 WS 上收到的客户端二进制消息数：证明直连期间输入没有走中继。
    pub client_binary: AtomicU64,
}

impl Counters {
    pub fn new() -> Self {
        Self {
            forwarded: AtomicU64::new(0),
            dropped: AtomicU64::new(0),
            key_requests: AtomicU64::new(0),
            p2p_opened: AtomicU64::new(0),
            transport: Mutex::new("relay"),
            client_binary: AtomicU64::new(0),
        }
    }

    pub fn set_transport(&self, transport: &'static str) {
        *self.transport.lock().unwrap() = transport;
    }

    pub fn snapshot(&self, mode: &str) -> Value {
        let mut map = Map::new();
        map.insert("mode".into(), json!(mode));
        map.insert(
            "forwarded".into(),
            json!(self.forwarded.load(Ordering::Relaxed)),
        );
        map.insert(
            "dropped".into(),
            json!(self.dropped.load(Ordering::Relaxed)),
        );
        map.insert(
            "keyRequests".into(),
            json!(self.key_requests.load(Ordering::Relaxed)),
        );
        map.insert(
            "p2pOpened".into(),
            json!(self.p2p_opened.load(Ordering::Relaxed)),
        );
        map.insert("transport".into(), json!(*self.transport.lock().unwrap()));
        map.insert(
            "clientBinary".into(),
            json!(self.client_binary.load(Ordering::Relaxed)),
        );
        Value::Object(map)
    }
}

impl Default for Counters {
    fn default() -> Self {
        Self::new()
    }
}

/// 进程内所有在跑的流。连接结束时由 `Registration` 摘掉自己。
#[derive(Default)]
pub struct Registry {
    conns: Mutex<Vec<(usize, &'static str, Arc<Counters>)>>,
    next_id: AtomicUsize,
}

impl Registry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(self: &Arc<Self>, mode: &'static str) -> Registration {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let counters = Arc::new(Counters::new());
        self.conns
            .lock()
            .unwrap()
            .push((id, mode, counters.clone()));
        Registration {
            registry: self.clone(),
            id,
            counters,
        }
    }

    pub fn to_json(&self) -> Value {
        let conns = self.conns.lock().unwrap();
        json!({ "connections": conns.iter().map(|(_, mode, c)| c.snapshot(mode)).collect::<Vec<_>>() })
    }
}

pub struct Registration {
    registry: Arc<Registry>,
    id: usize,
    pub counters: Arc<Counters>,
}

impl Drop for Registration {
    fn drop(&mut self) {
        self.registry
            .conns
            .lock()
            .unwrap()
            .retain(|(id, _, _)| *id != self.id);
    }
}

/// 原子写：先写同目录临时文件，再 rename 覆盖。
pub fn write_atomic(path: &Path, contents: &str) -> std::io::Result<()> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, contents)?;
    std::fs::rename(&tmp, path)
}

pub fn stats_file_from_env() -> Option<PathBuf> {
    std::env::var_os("MULTICC_REMOTE_STATS_FILE")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

/// 后台写手：不设环境变量时什么都不做。
pub async fn run_writer(registry: Arc<Registry>, path: PathBuf) {
    let mut ticker = tokio::time::interval(std::time::Duration::from_millis(WRITE_INTERVAL_MS));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        ticker.tick().await;
        let body = registry.to_json().to_string();
        let target = path.clone();
        // 写盘不该卡住服务：挪到阻塞线程池。
        let _ = tokio::task::spawn_blocking(move || write_atomic(&target, &body)).await;
    }
}
