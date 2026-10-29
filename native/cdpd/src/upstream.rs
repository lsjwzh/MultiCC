//! 每个 Chrome 一个 actor：持有那条已授权的 WebSocket 和它的 [`Router`]。
//! 所有状态只在这一个任务里改 —— 没有锁，也就没有锁顺序和竞态可言。
//!
//! 生命周期：connecting → ready → 退出。
//! - connecting：等 Chrome 握手（= 等用户点「允许」）。期间加入的调用方都排在这
//!   一次建连后面，用户只看到一个弹窗。所有等待者都走了也继续等：用户随后点了
//!   允许，这次授权就留给下一个调用方，不浪费。
//! - ready：上游一直保持，直到 Chrome 断开。**调用方都走了也不关**——这正是
//!   「一个浏览器会话只审批一次」的来源。也绝不主动重连：重连会在用户什么都没做
//!   的时候弹出授权框，只在下一个调用方到来时由池子重新建连。

use std::collections::HashMap;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::{Sink, SinkExt, Stream, StreamExt};
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::{self, protocol::WebSocketConfig, Message};

use crate::log::now_ms;
use crate::pool::{Outcome, Pool};
use crate::router::{ConnId, JoinOptions, Out, Router};
use crate::wire;

/// 每条连接的待写队列（帧数）。慢到积压这么多的调用方会被断开，而不是让它拖住
/// 上游读循环、进而拖住同一个 Chrome 上的所有人。
pub const CONN_QUEUE: usize = 4096;

/// 单条消息上限。tungstenite 默认 16MB 的帧上限会让一张整页截图直接打断那条已授权
/// 的连接 —— 用户就得再点一次允许。
pub const MAX_WS_MESSAGE: usize = 512 << 20;

pub fn ws_config() -> WebSocketConfig {
    WebSocketConfig::default()
        .max_message_size(Some(MAX_WS_MESSAGE))
        .max_frame_size(Some(MAX_WS_MESSAGE))
}

type BrowserSink = Pin<Box<dyn Sink<Message, Error = tungstenite::Error> + Send>>;
type BrowserStream = Pin<Box<dyn Stream<Item = Result<Message, tungstenite::Error>> + Send>>;

/// The isolation supervisor exposes line-delimited CDP on a private local
/// socket. The same router handles it and Chrome WebSockets; no second set of
/// session/target ownership rules lives in the plugin.
async fn connect_browser(url: &str) -> Result<(BrowserSink, BrowserStream), tungstenite::Error> {
    if let Some(path) = url.strip_prefix("pipe://") {
        let connection = crate::ipc::connect(std::path::Path::new(path)).await?;
        let (reader, writer) = tokio::io::split(connection);
        let sink = futures_util::sink::unfold(writer, |mut writer, message: Message| async move {
            if let Message::Text(text) = message {
                wire::write_line(&mut writer, &text).await?;
            }
            Ok::<_, tungstenite::Error>(writer)
        });
        let stream = futures_util::stream::unfold(
            wire::LineReader::new(reader, MAX_WS_MESSAGE),
            |mut reader| async move {
                match reader.next_line().await {
                    Ok(Some(line)) => Some((Ok(Message::Text(line.into())), reader)),
                    Ok(None) => None,
                    Err(error) => Some((
                        Err(tungstenite::Error::Io(std::io::Error::other(
                            error.to_string(),
                        ))),
                        reader,
                    )),
                }
            },
        );
        return Ok((Box::pin(sink), Box::pin(stream)));
    }
    let (socket, _) =
        tokio_tungstenite::connect_async_with_config(url, Some(ws_config()), true).await?;
    let (sink, stream) = socket.split();
    Ok((Box::pin(sink), Box::pin(stream)))
}

pub enum ConnMsg {
    Line(String),
    /// 写完可选的最后一行（行协议）/ 作为 close reason（WebSocket 入口）后关闭。
    Close(Option<String>),
}

pub type ConnTx = mpsc::Sender<ConnMsg>;

pub enum Cmd {
    Join {
        conn: ConnId,
        options: JoinOptions,
        tx: ConnTx,
    },
    Frame {
        conn: ConnId,
        text: String,
    },
    Leave {
        conn: ConnId,
    },
    Release {
        lane: String,
        reply: oneshot::Sender<bool>,
    },
    Snapshot {
        reply: oneshot::Sender<Value>,
    },
    Upstream(String),
    UpstreamClosed(String),
}

pub fn spawn(
    pool: Arc<Pool>,
    key: String,
    generation: u64,
    url: String,
    connect_timeout: Duration,
) -> mpsc::Sender<Cmd> {
    let (tx, rx) = mpsc::channel(1024);
    let own = tx.clone();
    tokio::spawn(async move {
        let outcome = run(&url, rx, own, connect_timeout).await;
        pool.finished(&key, generation, outcome);
    });
    tx
}

async fn run(
    url: &str,
    mut rx: mpsc::Receiver<Cmd>,
    own: mpsc::Sender<Cmd>,
    connect_timeout: Duration,
) -> Outcome {
    let started = Instant::now();
    crate::log!("[{url}] connecting");
    let mut waiting: HashMap<ConnId, ConnTx> = HashMap::new();
    let mut early: Vec<Cmd> = Vec::new();
    let connect = tokio::time::timeout(connect_timeout, connect_browser(url));
    tokio::pin!(connect);
    let result = loop {
        tokio::select! {
            result = &mut connect => break result,
            cmd = rx.recv() => match cmd {
                Some(Cmd::Join { conn, options, tx }) => {
                    waiting.insert(conn, tx.clone());
                    early.push(Cmd::Join { conn, options, tx });
                }
                Some(Cmd::Frame { conn, text }) => early.push(Cmd::Frame { conn, text }),
                Some(Cmd::Leave { conn }) => {
                    waiting.remove(&conn);
                    early.retain(|cmd| !matches!(cmd, Cmd::Join { conn: c, .. } | Cmd::Frame { conn: c, .. } if *c == conn));
                }
                Some(Cmd::Snapshot { reply }) => {
                    let _ = reply.send(json!({
                        "url": url, "state": "connecting", "clients": waiting.len(),
                        "waitingMs": started.elapsed().as_millis() as u64,
                    }));
                }
                Some(Cmd::Release { reply, .. }) => { let _ = reply.send(false); }
                Some(_) => {}
                None => return Outcome::Unreachable,
            }
        }
    };

    let socket = match result {
        Ok(Ok(socket)) => socket,
        Ok(Err(error)) => {
            let (code, outcome) = classify(&error);
            crate::log!("[{url}] connect failed ({code}): {error}");
            fail_all(waiting, code, &error.to_string());
            return outcome;
        }
        Err(_) => {
            let detail = format!(
                "Chrome did not accept the connection within {}s. If Chrome shows \"Allow remote debugging?\", click Allow and retry.",
                connect_timeout.as_secs()
            );
            crate::log!("[{url}] approval timed out");
            fail_all(waiting, "chrome_approval_timeout", &detail);
            return Outcome::Denied;
        }
    };
    crate::log!("[{url}] ready after {}ms", started.elapsed().as_millis());

    let (mut sink, mut stream) = socket;
    let (to_chrome, mut chrome_queue) = mpsc::unbounded_channel::<String>();
    let writer_events = own.clone();
    tokio::spawn(async move {
        while let Some(text) = chrome_queue.recv().await {
            if let Err(error) = sink.send(Message::Text(text.into())).await {
                let _ = writer_events
                    .send(Cmd::UpstreamClosed(error.to_string()))
                    .await;
                return;
            }
        }
        let _ = sink.close().await;
    });
    let reader_events = own;
    tokio::spawn(async move {
        let reason = loop {
            let text = match stream.next().await {
                Some(Ok(Message::Text(text))) => text.to_string(),
                Some(Ok(Message::Binary(bytes))) => match String::from_utf8(bytes.to_vec()) {
                    Ok(text) => text,
                    Err(_) => continue,
                },
                Some(Ok(Message::Close(frame))) => {
                    break format!(
                        "closed by Chrome{}",
                        frame.map(|f| format!(": {}", f.reason)).unwrap_or_default()
                    )
                }
                Some(Ok(_)) => continue,
                Some(Err(error)) => break error.to_string(),
                None => break "socket closed".to_string(),
            };
            if reader_events.send(Cmd::Upstream(text)).await.is_err() {
                return;
            }
        };
        let _ = reader_events.send(Cmd::UpstreamClosed(reason)).await;
    });

    let (router, boot) = Router::new(url);
    let mut actor = Ready {
        url: url.to_string(),
        router,
        conns: HashMap::new(),
        to_chrome,
        connected_at: now_ms(),
    };
    actor.apply(boot);
    for cmd in early {
        actor.handle(cmd);
    }
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    loop {
        tokio::select! {
            cmd = rx.recv() => match cmd {
                Some(Cmd::UpstreamClosed(reason)) => {
                    crate::log!("[{url}] upstream closed: {reason}");
                    let notice = wire::error_body("cdp-upstream-closed", &reason);
                    for (_, tx) in actor.conns.drain() {
                        let _ = tx.try_send(ConnMsg::Close(Some(notice.clone())));
                    }
                    return Outcome::Closed;
                }
                Some(cmd) => actor.handle(cmd),
                None => return Outcome::Closed,
            },
            _ = tick.tick() => {
                let out = actor.router.expire(now_ms());
                actor.apply(out);
            }
        }
    }
}

struct Ready {
    url: String,
    router: Router,
    conns: HashMap<ConnId, ConnTx>,
    to_chrome: mpsc::UnboundedSender<String>,
    connected_at: u64,
}

impl Ready {
    fn handle(&mut self, cmd: Cmd) {
        let now = now_ms();
        let out = match cmd {
            Cmd::Join { conn, options, tx } => {
                self.conns.insert(conn, tx);
                self.router.join(conn, options, now)
            }
            Cmd::Frame { conn, text } => self.router.from_conn(conn, &text),
            Cmd::Leave { conn } => {
                self.conns.remove(&conn);
                self.router.leave(conn, now)
            }
            Cmd::Upstream(text) => self.router.from_chrome(&text),
            Cmd::Release { lane, reply } => {
                let (found, out) = self.router.release(&lane);
                let _ = reply.send(found);
                out
            }
            Cmd::Snapshot { reply } => {
                let _ = reply.send(json!({
                    "url": self.url, "state": "ready", "clients": self.conns.len(),
                    "connectedAt": crate::log::format_utc(self.connected_at / 1000),
                    "router": self.router.snapshot(),
                }));
                Vec::new()
            }
            Cmd::UpstreamClosed(_) => Vec::new(),
        };
        self.apply(out);
    }

    fn apply(&mut self, mut out: Vec<Out>) {
        while !out.is_empty() {
            let mut evicted = Vec::new();
            for item in out.drain(..) {
                match item {
                    Out::Chrome(text) => {
                        let _ = self.to_chrome.send(text);
                    }
                    Out::Line(conn, line) => {
                        if let Some(tx) = self.conns.get(&conn) {
                            if tx.try_send(ConnMsg::Line(line)).is_err() {
                                evicted.push(conn);
                            }
                        }
                    }
                    Out::Close(conn, reason) => {
                        if let Some(tx) = self.conns.remove(&conn) {
                            let _ = tx.try_send(ConnMsg::Close(reason));
                        }
                    }
                }
            }
            for conn in evicted {
                // 丢掉发送端：写任务把已排队的写完就收尾，调用方看到连接关闭。
                if self.conns.remove(&conn).is_some() {
                    crate::log!(
                        "[{}] client {conn} fell {CONN_QUEUE} frames behind; disconnected",
                        self.url
                    );
                    out.extend(self.router.leave(conn, now_ms()));
                }
            }
        }
    }
}

fn fail_all(waiting: HashMap<ConnId, ConnTx>, code: &str, detail: &str) {
    let body = wire::error_body(code, detail);
    for (_, tx) in waiting {
        let _ = tx.try_send(ConnMsg::Close(Some(body.clone())));
    }
}

/// 握手失败分两类：Chrome 根本没在听（没弹窗，可以随时重试），和 Chrome 收到了
/// 但没放行（拒绝、或握手中途被关 —— 用户点了「拒绝」就是这样），后者要冷却。
fn classify(error: &tungstenite::Error) -> (&'static str, Outcome) {
    use tungstenite::Error;
    match error {
        Error::Http(response) if matches!(response.status().as_u16(), 401 | 403) => {
            ("chrome_rejected", Outcome::Denied)
        }
        Error::Http(_) => ("chrome_unavailable", Outcome::Unreachable),
        Error::Io(io)
            if matches!(
                io.kind(),
                std::io::ErrorKind::ConnectionRefused
                    | std::io::ErrorKind::NotFound
                    | std::io::ErrorKind::AddrNotAvailable
            ) =>
        {
            ("chrome_unavailable", Outcome::Unreachable)
        }
        Error::Url(_) => ("bad-request", Outcome::Unreachable),
        Error::Io(_) | Error::ConnectionClosed | Error::AlreadyClosed | Error::Protocol(_) => {
            ("chrome_rejected", Outcome::Denied)
        }
        _ => ("chrome_unavailable", Outcome::Unreachable),
    }
}
