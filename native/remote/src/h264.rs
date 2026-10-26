//! H.264 桥：Agent 的 h264.sock ⇄ /ws/remote-screen?mode=h264（移植
//! src/remote-screen-h264-bridge.js）。
//!
//! 帧格式见 scripts/macos-agent/MultiCCAgentH264.swift 开头：[type u8][len u32 BE][payload]，
//! type 1 = config(JSON) / 2 = 关键帧 / 3 = 普通帧 / 4 = pong(令牌 + 实际生效码率)。
//! 按帧切分后每帧一条 WS 二进制消息原样转发（浏览器用同一份解析），同一套帧
//! 也走 WebRTC DataChannel。
//!
//! 与 RFB 桥的区别：RFB 是不可丢的字节流，堵了只能断开重连；视频帧可以丢 ——
//! 积压超过水位就丢普通帧、记下「欠关键帧」，等积压回落再向 Agent 要一个关键帧
//! （节流），画面从下一个关键帧继续，连接不断。pong 是控制消息，不走丢帧规则，
//! 也不算「出过帧」：只有真正的视频帧才解除无首帧超时。
//!
//! 浏览器 → Agent 只放行五种定长消息：'K'（要关键帧）、'B' + kbps、'P' + token、
//! RFB KeyEvent、RFB PointerEvent。输入在 Agent 侧走 rfbKey/rfbPointer，护栏照旧。

use crate::p2p_api::{ice_servers_json, P2pControl, P2pEvent, P2pFactory, P2pOptions, P2pSink};
use crate::stats::{Counters, Registry};
use crate::wsout::{Incoming, WsOut};
use bytes::Bytes;
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
#[cfg(unix)]
use tokio::io::{AsyncReadExt, AsyncWriteExt};
#[cfg(unix)]
use tokio::net::UnixStream;
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};

pub const T_CONFIG: u8 = 1;
pub const T_KEY: u8 = 2;
pub const T_DELTA: u8 = 3;
pub const T_PONG: u8 = 4;
pub const REQ_KEY: u8 = 0x4b;
pub const CAP_KBPS: u8 = 0x42; // 'B' + kbps u32 BE
pub const PING: u8 = 0x50; // 'P' + token u32 BE

/// 客户端 → Agent 的定长消息表（RFB KeyEvent 8 字节、PointerEvent 6 字节）。
pub const CLIENT_LENGTHS: &[(u8, usize)] = &[(REQ_KEY, 1), (4, 8), (5, 6), (CAP_KBPS, 5), (PING, 5)];

pub fn client_length(first: u8) -> Option<usize> {
    CLIENT_LENGTHS.iter().find(|(t, _)| *t == first).map(|(_, len)| *len)
}

#[derive(Clone)]
pub struct H264Options {
    pub socket_path: Option<std::path::PathBuf>,
    /// WS 积压超过它就丢普通帧。
    pub high_water: usize,
    /// 积压回落到它以下才补要关键帧。
    pub low_water: usize,
    pub max_frame_bytes: usize,
    /// 一直出不了首帧（旧 Agent / 没有屏幕录制授权）→ 断开让前端回退。
    pub first_frame_timeout: Duration,
    pub key_request_interval: Duration,
    /// 毫秒时钟，单测注入假表。
    pub now: Arc<dyn Fn() -> u64 + Send + Sync>,
    pub stun_urls: Vec<String>,
    /// 直连实现（p2p.rs）。None = 这条流只走中继。
    pub p2p: Option<P2pFactory>,
}

impl Default for H264Options {
    fn default() -> Self {
        let start = std::time::Instant::now();
        Self {
            socket_path: None,
            high_water: 1024 * 1024,
            low_water: 256 * 1024,
            max_frame_bytes: 8 * 1024 * 1024,
            first_frame_timeout: Duration::from_millis(10000),
            key_request_interval: Duration::from_millis(500),
            now: Arc::new(move || start.elapsed().as_millis() as u64),
            stun_urls: crate::p2p_api::stun_urls_from_env(),
            p2p: None,
        }
    }
}

/// 帧出口：中继是 WS，直连是 P2pSink。两者的积压语义相同。
enum Active {
    Relay,
    P2p(Arc<dyn P2pSink>),
}

impl Active {
    fn is_relay(&self) -> bool {
        matches!(self, Active::Relay)
    }
}

pub struct H264Bridge {
    ws: Arc<dyn WsOut>,
    agent_tx: UnboundedSender<Bytes>,
    stats: Arc<Counters>,
    opts: H264Options,
    session: Option<Box<dyn P2pControl>>,
    active: Active,
    buf: Vec<u8>,
    closed: bool,
    open: bool,
    saw_frame: bool,
    /// 解码器从关键帧起步。
    need_key: bool,
    last_key_request: Option<u64>,
}

impl H264Bridge {
    pub fn new(
        ws: Arc<dyn WsOut>,
        agent_tx: UnboundedSender<Bytes>,
        opts: H264Options,
        stats: Arc<Counters>,
        p2p: Option<(P2pFactory, UnboundedSender<P2pEvent>)>,
    ) -> Self {
        let mut bridge = Self {
            ws,
            agent_tx,
            stats,
            opts: opts.clone(),
            session: None,
            active: Active::Relay,
            buf: Vec::new(),
            closed: false,
            open: true,
            saw_frame: false,
            need_key: true,
            last_key_request: None,
        };
        if let Some((factory, events)) = p2p {
            let control = factory(
                P2pOptions {
                    stun_urls: opts.stun_urls.clone(),
                    open_timeout: Duration::from_secs(10),
                    chunk_bytes: 16 * 1024,
                },
                events,
            );
            bridge.session = Some(control);
            // 这条 WS 同时是信令通道：先告诉浏览器可以试直连。
            bridge.signal(json!({ "t": "rtc-hello", "iceServers": ice_servers_json(&opts.stun_urls) }));
        }
        bridge
    }

    pub fn stats(&self) -> Arc<Counters> {
        self.stats.clone()
    }

    pub fn is_closed(&self) -> bool {
        self.closed
    }

    pub fn first_frame_timeout(&self) -> Duration {
        self.opts.first_frame_timeout
    }

    pub fn key_request_interval(&self) -> Duration {
        self.opts.key_request_interval
    }

    fn transport(&self) -> &'static str {
        if self.active.is_relay() { "relay" } else { "p2p" }
    }

    fn buffered(&self) -> usize {
        match &self.active {
            Active::Relay => self.ws.buffered(),
            Active::P2p(sink) => sink.buffered(),
        }
    }

    /// 切通道：先在 WS 上发 rtc-active（排在 WS 已发帧之后），再换出口并要关键帧。
    fn use_sink(&mut self, next: Active) {
        if self.closed {
            return;
        }
        let same = match (&self.active, &next) {
            (Active::Relay, Active::Relay) => true,
            (Active::P2p(a), Active::P2p(b)) => Arc::ptr_eq(a, b),
            _ => false,
        };
        if same {
            return;
        }
        let on = !next.is_relay();
        self.signal(json!({ "t": "rtc-active", "on": on }));
        self.active = next;
        self.stats.set_transport(self.transport());
        self.need_key = true;
        self.request_key(true);
    }

    fn signal(&mut self, object: Value) {
        if self.closed || !self.ws.is_open() {
            return;
        }
        if !self.ws.send_text(object.to_string()) {
            self.die("h264-unavailable", true);
        }
    }

    fn to_agent(&self, data: Bytes) {
        if self.open && !self.closed {
            let _ = self.agent_tx.send(data);
        }
    }

    fn request_key(&mut self, force: bool) {
        let now = (self.opts.now)();
        if !force {
            if let Some(last) = self.last_key_request {
                if now.saturating_sub(last) < self.opts.key_request_interval.as_millis() as u64 {
                    return;
                }
            }
        }
        self.last_key_request = Some(now);
        self.stats.key_requests.fetch_add(1, Ordering::Relaxed);
        self.to_agent(Bytes::from_static(&[REQ_KEY]));
    }

    fn die(&mut self, reason: &str, close_ws: bool) {
        if self.closed {
            return;
        }
        self.closed = true;
        if let Some(session) = &self.session {
            session.close();
        }
        if close_ws && self.ws.is_open() {
            self.ws.close(1011, reason);
        }
    }

    pub fn on_agent_closed(&mut self) {
        self.die("h264-unavailable", true);
    }

    pub fn on_ws_closed(&mut self) {
        self.die("h264-unavailable", false);
    }

    /// 首帧超时：pong 不算出过帧，所以这里只认视频帧。
    pub fn on_first_frame_timeout(&mut self) {
        if !self.saw_frame {
            self.die("h264-no-frames", true);
        }
    }

    /// 屏幕静止时 Agent 不出帧，forward 里的补要就等不来 —— 定时看一眼积压。
    pub fn on_drain_tick(&mut self) {
        if self.closed {
            return;
        }
        if self.need_key && self.saw_frame && self.buffered() < self.opts.low_water {
            self.request_key(false);
        }
    }

    pub fn on_binary(&mut self, data: &[u8]) {
        if self.closed {
            return;
        }
        self.stats.client_binary.fetch_add(1, Ordering::Relaxed);
        self.handle_browser_input(data);
    }

    /// WS 文本：直连信令。超过 80 KB 的一律不解析（信令里不会有这么大的）。
    pub fn on_text(&mut self, text: &str) {
        if self.closed {
            return;
        }
        let Some(session) = &self.session else { return };
        if text.len() > 80 * 1024 {
            return;
        }
        let Ok(message) = serde_json::from_str::<Value>(text) else { return };
        session.handle_signal(&message);
    }

    pub fn on_p2p_event(&mut self, event: P2pEvent) {
        if self.closed {
            return;
        }
        match event {
            P2pEvent::Signal(object) => self.signal(object),
            P2pEvent::Open(sink) => {
                self.stats.p2p_opened.fetch_add(1, Ordering::Relaxed);
                self.use_sink(Active::P2p(sink));
            }
            P2pEvent::Closed => self.use_sink(Active::Relay),
            P2pEvent::Input(bytes) => self.handle_browser_input(&bytes),
        }
    }

    fn handle_browser_input(&mut self, data: &[u8]) {
        let Some(&first) = data.first() else { return };
        if client_length(first) != Some(data.len()) {
            return;
        }
        if first == REQ_KEY {
            self.need_key = true;
            self.request_key(true);
            return;
        }
        self.to_agent(Bytes::copy_from_slice(data));
    }

    /// Agent 来的字节流：按帧切分、每帧一条 WS 消息。
    pub fn feed(&mut self, chunk: &[u8]) {
        if self.closed {
            return;
        }
        if !self.ws.is_open() {
            self.on_agent_closed();
            return;
        }
        self.buf.extend_from_slice(chunk);
        while self.buf.len() >= 5 {
            let ty = self.buf[0];
            let len = u32::from_be_bytes([self.buf[1], self.buf[2], self.buf[3], self.buf[4]]) as usize;
            if len > self.opts.max_frame_bytes {
                self.die("h264-bad-frame", true);
                return;
            }
            if self.buf.len() < 5 + len {
                break;
            }
            // 拷贝出独立的一帧：subarray 会让整块接收缓冲随发送队列一起滞留。
            let message = Bytes::copy_from_slice(&self.buf[..5 + len]);
            self.buf.drain(..5 + len);
            self.forward(ty, message);
            if self.closed {
                return;
            }
        }
    }

    fn forward(&mut self, ty: u8, message: Bytes) {
        // config 与 pong 是控制消息：永远直通，不参与丢帧/关键帧状态，也不算「出过帧」。
        if ty == T_CONFIG || ty == T_PONG {
            self.send(message);
            return;
        }
        if ty != T_KEY && ty != T_DELTA {
            // 未知类型：向前兼容，忽略。
            return;
        }
        self.saw_frame = true;
        let backlog = self.buffered();
        if ty == T_DELTA && (self.need_key || backlog > self.opts.high_water) {
            self.stats.dropped.fetch_add(1, Ordering::Relaxed);
            self.need_key = true;
            if backlog < self.opts.low_water {
                self.request_key(false);
            }
            return;
        }
        if ty == T_KEY && backlog > self.opts.high_water * 2 {
            // 关键帧也塞不进去：链路是真的窄。丢掉，等积压回落再要。
            self.stats.dropped.fetch_add(1, Ordering::Relaxed);
            self.need_key = true;
            return;
        }
        if ty == T_KEY {
            self.need_key = false;
        }
        self.send(message);
    }

    fn send(&mut self, message: Bytes) {
        let delivered = match &self.active {
            Active::Relay => self.ws.try_send(message),
            Active::P2p(sink) => sink.send(&message),
        };
        if delivered {
            self.stats.forwarded.fetch_add(1, Ordering::Relaxed);
            return;
        }
        if self.active.is_relay() {
            self.die("h264-unavailable", true);
        } else {
            self.use_sink(Active::Relay);
        }
    }
}

/// 桥的异步外壳：连 h264.sock，读半边喂 `feed`，其余事件分发给桥。
#[cfg(unix)]
pub async fn run(
    ws: Arc<dyn WsOut>,
    mut input: UnboundedReceiver<Incoming>,
    opts: H264Options,
    registry: Arc<Registry>,
) {
    let Some(path) = opts.socket_path.clone() else {
        ws.close(1011, "h264-unavailable");
        return;
    };
    let registration = registry.register("h264");
    let Ok(stream) = UnixStream::connect(&path).await else {
        ws.close(1011, "h264-unavailable");
        return;
    };
    let (mut reader, mut writer) = stream.into_split();
    let (agent_tx, mut agent_rx) = mpsc::unbounded_channel::<Bytes>();
    // 写端单开一个任务：桥的逻辑是同步的，不该被 socket 写阻塞。
    tokio::spawn(async move {
        while let Some(data) = agent_rx.recv().await {
            if writer.write_all(&data).await.is_err() {
                break;
            }
        }
    });
    let (p2p_tx, mut p2p_rx) = mpsc::unbounded_channel::<P2pEvent>();
    let p2p = opts.p2p.clone();
    // p2p=None 时 sender 在这里就被丢掉了：recv() 之后每次都立刻回 None。
    // 这个分支要是留在 select 里，整个循环就变成忙轮询，一个核直接烧满。
    // 先用标志位把分支关掉，等真有事件（或有人主动关掉通道）再退出。
    let mut p2p_alive = p2p.is_some();
    let mut bridge = H264Bridge::new(ws, agent_tx, opts, registration.counters.clone(), p2p.map(|f| (f, p2p_tx)));
    let first_frame = tokio::time::sleep(bridge.first_frame_timeout());
    tokio::pin!(first_frame);
    // Sleep 到期一次后就永远 ready；不摘掉的话每轮 select 都会被它立刻唤醒。
    let mut first_frame_pending = true;
    let mut tick = tokio::time::interval(bridge.key_request_interval());
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut chunk = vec![0u8; 64 * 1024];
    while !bridge.is_closed() {
        tokio::select! {
            read = reader.read(&mut chunk) => match read {
                Ok(0) | Err(_) => bridge.on_agent_closed(),
                Ok(n) => bridge.feed(&chunk[..n]),
            },
            message = input.recv() => match message {
                Some(Incoming::Bin(data)) => bridge.on_binary(&data),
                Some(Incoming::Text(text)) => bridge.on_text(&text),
                None => { bridge.on_ws_closed(); }
            },
            event = p2p_rx.recv(), if p2p_alive => match event {
                Some(event) => bridge.on_p2p_event(event),
                // 通道彻底关了（直连会话退场）：别再监听这条分支。
                None => p2p_alive = false,
            },
            _ = &mut first_frame, if first_frame_pending => {
                first_frame_pending = false;
                bridge.on_first_frame_timeout();
            }
            _ = tick.tick() => bridge.on_drain_tick(),
        }
    }
}

/// Windows 上还没有 unix socket 传输（画像里 h264_sock 本来就是 None）。
/// 这里保留同名入口，让整个 crate 在 win32 目标上也能编译通过。
#[cfg(not(unix))]
pub async fn run(
    ws: Arc<dyn WsOut>,
    _input: UnboundedReceiver<Incoming>,
    _opts: H264Options,
    _registry: Arc<Registry>,
) {
    ws.close(1011, "h264-unavailable");
}
