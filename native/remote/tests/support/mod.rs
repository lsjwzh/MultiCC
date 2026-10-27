//! 测试替身：假 WS、假 Agent、假 shell、临时目录、fixture 读取。
//!
//! 原则与 JS 测试一致：不碰真 Agent、真屏幕、真 ~/.multicc —— 一切都在临时目录
//! 里用假 socket / 假命令跑。

#![allow(dead_code)]

use futures_util::future::BoxFuture;
use multicc_remote::agent::AgentClient;
use multicc_remote::host::Exec;
use multicc_remote::wsout::WsOut;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

// ── 假 WS ──────────────────────────────────────────────────────────────
#[derive(Default)]
pub struct FakeWs {
    pub sent: Mutex<Vec<Vec<u8>>>,
    pub texts: Mutex<Vec<String>>,
    pub closed: Mutex<Option<(u16, String)>>,
    pub buffered: AtomicUsize,
    pub open: AtomicBool,
    /// true = 模拟写端已经坏了（try_send 返回 false）。
    pub broken: AtomicBool,
    /// true = 交给写端的字节先攒在 buffered 里（模拟 ws-backpressure 的队列）。
    pub accumulate: AtomicBool,
}

impl FakeWs {
    pub fn new() -> Arc<Self> {
        let ws = FakeWs::default();
        ws.open.store(true, Ordering::SeqCst);
        Arc::new(ws)
    }

    pub fn frames(&self) -> Vec<Vec<u8>> {
        self.sent.lock().unwrap().clone()
    }

    pub fn frame_hexes(&self) -> Vec<String> {
        self.frames().iter().map(|f| hex(f)).collect()
    }

    pub fn signals(&self) -> Vec<Value> {
        self.texts
            .lock()
            .unwrap()
            .iter()
            .map(|text| serde_json::from_str(text).expect("signal 不是 JSON"))
            .collect()
    }

    pub fn close_reason(&self) -> Option<(u16, String)> {
        self.closed.lock().unwrap().clone()
    }

    pub fn set_buffered(&self, bytes: usize) {
        self.buffered.store(bytes, Ordering::SeqCst);
    }

    fn deliver(&self, data: &[u8]) -> bool {
        if !self.open.load(Ordering::SeqCst) || self.broken.load(Ordering::SeqCst) {
            return false;
        }
        if self.accumulate.load(Ordering::SeqCst) {
            self.buffered.fetch_add(data.len(), Ordering::SeqCst);
        }
        self.sent.lock().unwrap().push(data.to_vec());
        true
    }
}

impl WsOut for FakeWs {
    fn buffered(&self) -> usize {
        self.buffered.load(Ordering::SeqCst)
    }

    fn try_send(&self, data: bytes::Bytes) -> bool {
        self.deliver(&data)
    }

    fn send(&self, data: bytes::Bytes) -> BoxFuture<'static, bool> {
        let ok = self.deliver(&data);
        Box::pin(async move { ok })
    }

    fn send_text(&self, text: String) -> bool {
        if !self.open.load(Ordering::SeqCst) || self.broken.load(Ordering::SeqCst) {
            return false;
        }
        self.texts.lock().unwrap().push(text);
        true
    }

    fn close(&self, code: u16, reason: &str) {
        let mut closed = self.closed.lock().unwrap();
        if closed.is_none() {
            *closed = Some((code, reason.to_string()));
            self.open.store(false, Ordering::SeqCst);
        }
    }

    fn is_open(&self) -> bool {
        self.open.load(Ordering::SeqCst)
    }
}

// ── 假 Agent ───────────────────────────────────────────────────────────
type Reply = Box<dyn Fn(&Value) -> Value + Send + Sync>;

pub struct FakeAgent {
    pub calls: Mutex<Vec<(Value, Option<Duration>)>>,
    pub reply: Mutex<Reply>,
}

impl FakeAgent {
    pub fn new(reply: impl Fn(&Value) -> Value + Send + Sync + 'static) -> Arc<Self> {
        Arc::new(FakeAgent {
            calls: Mutex::new(Vec::new()),
            reply: Mutex::new(Box::new(reply)),
        })
    }

    pub fn set(&self, reply: impl Fn(&Value) -> Value + Send + Sync + 'static) {
        *self.reply.lock().unwrap() = Box::new(reply);
    }

    pub fn requests(&self) -> Vec<Value> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .map(|(req, _)| req.clone())
            .collect()
    }

    pub fn timeouts(&self) -> Vec<Option<Duration>> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .map(|(_, timeout)| *timeout)
            .collect()
    }

    pub fn reset(&self) {
        self.calls.lock().unwrap().clear();
    }
}

impl AgentClient for FakeAgent {
    fn call(&self, req: Value, timeout: Option<Duration>) -> BoxFuture<'static, Value> {
        self.calls.lock().unwrap().push((req.clone(), timeout));
        let reply = (self.reply.lock().unwrap())(&req);
        Box::pin(async move { reply })
    }
}

// ── 假 shell ───────────────────────────────────────────────────────────
pub fn ok_exec(stdout: &'static str) -> Exec {
    Arc::new(move |_cmd, _args, _timeout| Box::pin(async move { Ok(stdout.to_string()) }))
}

pub fn panic_exec() -> Exec {
    Arc::new(|cmd, _args, _timeout| {
        let cmd = cmd.clone();
        Box::pin(async move { Err(format!("不该 shell out：{cmd}")) })
    })
}

/// macOS 这条路：osascript 给逻辑尺寸，sips -g 给像素尺寸，其余 sips 调用写 --out。
pub fn mac_exec(log: Arc<Mutex<Vec<Vec<String>>>>) -> Exec {
    Arc::new(move |cmd, args, _timeout| {
        let log = log.clone();
        let cmd = cmd.clone();
        Box::pin(async move {
            log.lock().unwrap().push(
                std::iter::once(cmd.clone())
                    .chain(args.iter().cloned())
                    .collect(),
            );
            match cmd.as_str() {
                "osascript" => Ok("0, 0, 1470, 956\n".to_string()),
                "sips" if args.first().map(|a| a == "-g").unwrap_or(false) => {
                    Ok("pixelWidth: 2940\npixelHeight: 1912\n".to_string())
                }
                "sips" => {
                    let index = args
                        .iter()
                        .position(|a| a == "--out")
                        .ok_or("sips 没有 --out")?;
                    std::fs::write(&args[index + 1], "img").map_err(|e| e.to_string())?;
                    Ok(String::new())
                }
                "/usr/bin/caffeinate" => Ok(String::new()),
                other => Err(format!("unexpected {other}")),
            }
        })
    })
}

// ── 临时目录 ───────────────────────────────────────────────────────────
pub fn temp_dir(tag: &str) -> PathBuf {
    static COUNTER: AtomicUsize = AtomicUsize::new(0);
    let unique = format!(
        "multicc-remote-{tag}-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::SeqCst)
    );
    let dir = std::env::temp_dir().join(unique);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

// ── 字节工具 ───────────────────────────────────────────────────────────
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn unhex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
        .collect()
}

/// `[type u8][len u32 BE][payload]`
pub fn frame(ty: u8, body: &[u8]) -> Vec<u8> {
    let mut out = vec![ty];
    out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    out.extend_from_slice(body);
    out
}

/// 线协议金样：路径从 CARGO_MANIFEST_DIR 回到仓库根。
pub fn wire_fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/remote-screen-wire.json");
    let text =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("读不到 {}: {e}", path.display()));
    serde_json::from_str(&text).expect("wire fixture 不是 JSON")
}

// ── HTTP 响应读数 ──────────────────────────────────────────────────────
pub async fn body_json(response: axum::response::Response) -> Value {
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| panic!("响应体不是 JSON: {:?}", String::from_utf8_lossy(&bytes)))
}
