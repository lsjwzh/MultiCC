//! RFB 桥：Agent 的 rfb.sock ⇄ /ws/remote-screen（移植 src/remote-screen-rfb-bridge.js）。
//!
//! Raw RFB 是不可丢的字节流：丢掉旧的一段，后面每个矩形都会错位。所以这里做的是
//! 背压而不是丢帧 —— 浏览器写不过来就暂停读 socket，积压超上限就断开重连，
//! 让客户端重新拿一张完整帧（或退回 JPEG 轮询）。
//!
//! 12 秒看门狗判「流卡死」：**只有 socket → 浏览器方向的数据会重新上弦**，
//! 鼠标活动（浏览器 → socket）不能把一条已经停住的画面流一直续命。
//! 连上之前浏览器发来的消息先排队（≤64 KiB）：客户端常常一接通就发
//! SetPixelFormat / SetEncodings，丢了画面就再也起不来。上限之外断开是唯一选择：
//! 悄悄丢一条 RFB 消息的代价比断线重连大得多。

use crate::wsout::{Incoming, WsOut};
use bytes::Bytes;
use futures_util::future::BoxFuture;
use std::io;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
#[cfg(unix)]
use tokio::io::{AsyncReadExt, AsyncWriteExt};
#[cfg(unix)]
use tokio::net::UnixStream;
use tokio::sync::mpsc;

#[cfg(unix)]
pub type RfbConnector =
    Arc<dyn Fn(PathBuf) -> BoxFuture<'static, io::Result<UnixStream>> + Send + Sync>;
/// Windows 上还没有 unix socket 传输；占位类型只为让 RfbOptions 在 win32 也能编译。
#[cfg(not(unix))]
pub type RfbConnector = Arc<dyn Fn(PathBuf) -> BoxFuture<'static, io::Result<()>> + Send + Sync>;

/// 连上后写端积压超过它就暂停读浏览器（Node 的 socket 高水位是 16 KiB）。
const PAUSE_BYTES: usize = 16 * 1024;

#[derive(Clone)]
pub struct RfbOptions {
    pub socket_path: Option<PathBuf>,
    pub timeout: Duration,
    pub max_buffered: usize,
    pub max_pending: usize,
    pub connect: RfbConnector,
}

impl Default for RfbOptions {
    fn default() -> Self {
        #[cfg(unix)]
        let connect: RfbConnector =
            Arc::new(|path| Box::pin(async move { UnixStream::connect(path).await }));
        #[cfg(not(unix))]
        let connect: RfbConnector = Arc::new(|_path| {
            Box::pin(async { Err(io::Error::new(io::ErrorKind::Unsupported, "unix-socket")) })
        });
        Self {
            socket_path: None,
            timeout: Duration::from_millis(12000),
            max_buffered: 8 * 1024 * 1024,
            max_pending: 64 * 1024,
            connect,
        }
    }
}

fn die(ws: &Arc<dyn WsOut>, reason: &str, close_ws: bool) {
    if close_ws && ws.is_open() {
        ws.close(1011, reason);
    }
}

fn as_bytes(message: Incoming) -> Bytes {
    match message {
        Incoming::Bin(data) => data,
        // 文本帧在 RFB 通道里没有意义；照 JS 的 Buffer 处理方式转成字节透传。
        Incoming::Text(text) => Bytes::from(text.into_bytes()),
    }
}

/// 入队给写端，并在队列太大时拒绝（Node 的 `sock.writableLength + len > max`）。
fn queue_write(
    tx: &mpsc::UnboundedSender<Bytes>,
    queued: &AtomicUsize,
    max: usize,
    data: Bytes,
) -> bool {
    let len = data.len();
    if queued.load(Ordering::SeqCst) + len > max {
        return false;
    }
    queued.fetch_add(len, Ordering::SeqCst);
    if tx.send(data).is_err() {
        queued.fetch_sub(len, Ordering::SeqCst);
        return false;
    }
    true
}

#[cfg(unix)]
pub async fn run(ws: Arc<dyn WsOut>, input: mpsc::UnboundedReceiver<Incoming>, opts: RfbOptions) {
    let Some(path) = opts.socket_path.clone() else {
        ws.close(1011, "rfb-unavailable");
        return;
    };
    let connecting = (opts.connect)(path);
    drive(ws, input, connecting, opts).await;
}

/// 测试入口：连接过程可注入（在连上之前客户端消息怎么排、连不上怎么关都用它测）。
#[cfg(unix)]
pub async fn drive(
    ws: Arc<dyn WsOut>,
    mut input: mpsc::UnboundedReceiver<Incoming>,
    connecting: BoxFuture<'static, io::Result<UnixStream>>,
    opts: RfbOptions,
) {
    // 看门狗从 attach 就开始计时（JS 的 arm() 在 connect 之前调用）。
    let mut stall = Box::pin(tokio::time::sleep(opts.timeout));
    let mut pending: Vec<Bytes> = Vec::new();
    let mut pending_bytes = 0usize;
    let mut connecting = connecting;
    let stream = loop {
        tokio::select! {
            message = input.recv() => {
                let Some(message) = message else {
                    return die(&ws, "rfb-unavailable", false);
                };
                let data = as_bytes(message);
                pending_bytes += data.len();
                if pending_bytes > opts.max_pending {
                    return die(&ws, "rfb-backpressure", true);
                }
                pending.push(data);
            }
            result = &mut connecting => match result {
                Ok(stream) => break stream,
                Err(_) => return die(&ws, "rfb-unavailable", true),
            },
            _ = &mut stall => return die(&ws, "rfb-stalled", true),
        }
    };
    let (mut reader, mut writer) = stream.into_split();
    let queued = Arc::new(AtomicUsize::new(0));
    let (write_tx, mut write_rx) = mpsc::unbounded_channel::<Bytes>();
    let task_queued = queued.clone();
    let writer_task = tokio::spawn(async move {
        while let Some(data) = write_rx.recv().await {
            if writer.write_all(&data).await.is_err() {
                break;
            }
            task_queued.fetch_sub(data.len(), Ordering::SeqCst);
        }
    });
    // 连上后按序补发，一条都不能乱。
    for data in pending.drain(..) {
        if !queue_write(&write_tx, &queued, opts.max_buffered, data) {
            writer_task.abort();
            return die(&ws, "rfb-backpressure", true);
        }
    }
    let outcome = pump(
        &ws,
        &mut input,
        &mut reader,
        &write_tx,
        &queued,
        &mut stall,
        &opts,
    )
    .await;
    writer_task.abort();
    if let Some((reason, close_ws)) = outcome {
        die(&ws, reason, close_ws);
    }
}

#[cfg(unix)]
async fn pump(
    ws: &Arc<dyn WsOut>,
    input: &mut mpsc::UnboundedReceiver<Incoming>,
    reader: &mut tokio::net::unix::OwnedReadHalf,
    write_tx: &mpsc::UnboundedSender<Bytes>,
    queued: &Arc<AtomicUsize>,
    stall: &mut std::pin::Pin<Box<tokio::time::Sleep>>,
    opts: &RfbOptions,
) -> Option<(&'static str, bool)> {
    let mut chunk = vec![0u8; 64 * 1024];
    let mut paused = false;
    loop {
        if !ws.is_open() {
            return Some(("rfb-unavailable", false));
        }
        tokio::select! {
            read = reader.read(&mut chunk) => match read {
                // socket 关闭/出错：JS 的 die() 默认 reason，带关闭帧。
                Ok(0) | Err(_) => return Some(("rfb-unavailable", true)),
                Ok(n) => {
                    // 只有屏幕/心跳数据才算「活着」。
                    stall.as_mut().reset(tokio::time::Instant::now() + opts.timeout);
                    if ws.buffered() + n > opts.max_buffered {
                        return Some(("rfb-backpressure", true));
                    }
                    let data = Bytes::copy_from_slice(&chunk[..n]);
                    // 等这条写进 socket 再继续读：这就是 JS 的 sock.pause()/resume()。
                    if !ws.send(data).await {
                        return Some(("rfb-unavailable", true));
                    }
                }
            },
            message = input.recv(), if !paused => match message {
                None => return Some(("rfb-unavailable", false)),
                Some(message) => {
                    let data = as_bytes(message);
                    if !queue_write(write_tx, queued, opts.max_buffered, data) {
                        return Some(("rfb-backpressure", true));
                    }
                }
            },
            _ = stall.as_mut() => return Some(("rfb-stalled", true)),
        }
        // 写端还没消化完就先别再收（Node 的 ws.pause()）。
        paused = queued.load(Ordering::SeqCst) >= PAUSE_BYTES;
    }
}

/// Windows 上还没有 unix socket 传输（画像里 rfb_sock 本来就是 None）。
#[cfg(not(unix))]
pub async fn run(ws: Arc<dyn WsOut>, _input: mpsc::UnboundedReceiver<Incoming>, _opts: RfbOptions) {
    ws.close(1011, "rfb-unavailable");
}

/// 同名测试入口的非 unix 占位：直接以 rfb-unavailable 关闭。
#[cfg(not(unix))]
pub async fn drive(
    ws: Arc<dyn WsOut>,
    _input: mpsc::UnboundedReceiver<Incoming>,
    _connecting: BoxFuture<'static, io::Result<()>>,
    _opts: RfbOptions,
) {
    ws.close(1011, "rfb-unavailable");
}
