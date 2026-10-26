//! 「🖥 屏幕」P2P 直连：WebRTC DataChannel，webrtc-rs（crypto-ring）。
//!
//! 行为与迁移前的 Node 版 `src/remote-screen-p2p.js` 一致 —— 直连只是中继的加速
//! 通道，打不通就一直走 WS，客户端不需要知道区别：
//!   · 客户端是 offerer，DataChannel 由客户端建；服务端只做 answerer
//!     （App / 浏览器都按「自己建通道」实现，服务端插手 create_data_channel 反而会
//!      让两端的 SCTP 关联角色对不上）。
//!   · 再次收到 rtc-offer 时替换旧 peer；旧 peer 若已 Open 过，先发 Closed。
//!   · trickle ICE：answer 立即发出，本地候选逐个以 rtc-ice 发出（空候选不发）。
//!   · connection failed/closed、DataChannel 关闭、或打开超时 → 丢掉 peer；Open 过的发 Closed。
//!   · close() 之后不再发任何事件（桥已经关了这条流，再回信只会打到空气里）。
//!   · DataChannel 只把二进制消息转成 Input，文本消息忽略（信令只在 WS 上）。
//!
//! 所有 webrtc-rs 的异步操作都在一个后台任务里做；对外的 `P2pControl` / `P2pSink`
//! 全是同步接口：命令走 unbounded channel，出站帧也走 channel，`buffered()` 读的是
//! 「已入队未处理 + SCTP outstanding」的近似值（对应 RTCDataChannel.bufferedAmount）。
//! 桥的 H.264 循环是同步的，绝不能在这里 `.await` —— 一次 SCTP 背压就会把
//! Agent 的读半边也卡住，整条流看起来像「卡死」而不是「变慢」。
//!
//! ── 两个必须照抄的坑 ───────────────────────────────────────────────────
//!
//! 1. **DTLS 角色固定成 Server**（`SettingEngineBuilder::with_answering_dtls_role`）。
//!    webrtc-rs 默认让 answerer 当 DTLS client、SCTP client。但 werift（App 互通脚本、
//!    旧 Node 实现用它做浏览器替身）在 offerer 一侧也按 ICE controlling 认定自己是
//!    SCTP client：双方都发 SCTP INIT，关联永远建不起来，DataChannel 一直停在
//!    connecting，最后只能靠 open_timeout 回中继。answer 里写 `a=setup:passive`
//!    （DTLS server / SCTP server）是 libwebrtc（Chrome、flutter_webrtc）和 werift
//!    都认的标准答案。
//! 2. **Session 必须在 tokio runtime 里创建**。`Session::start` 用
//!    `Handle::try_current()` 拿运行时；拿不到就把会话标记成已关闭（等价于没有直连）。
//!    桥在 `H264Bridge::new` 里创建它，而那是从 WS 升级回调（axum，已在 runtime 中）
//!    进来的，所以这里是安全的 —— 但别把它挪到启动早期或同步上下文里调用。
//!
//! ── 取舍 ──────────────────────────────────────────────────────────────
//!   · 依赖只带 ring（`webrtc` 默认 features）。开 crypto-aws-lc-rs 会拉进 cmake +
//!     一份 C 构建，交叉编译和「安装包别把编译工具链拖给用户」都受不了。
//!   · 出站帧按 `chunk_bytes` 切片入队而不是一次性交给 SCTP：一条 200 KB 的关键帧
//!     整块塞进去，`buffered()` 会瞬间超水位，桥就会误判链路窄、丢普通帧。
//!   · 关键帧之前到达的候选（werift 在 setLocalDescription 里同步吐候选）先存最多
//!     16 个，下一个 peer 建好后套用；JS 版直接丢，但那会让信令乱序时连通率变差。
//!   · 帧在队列里仍带 generation，旧 peer 的余帧绝不送给新 peer。

use crate::p2p_api::{P2pControl, P2pEvent, P2pFactory, P2pOptions, P2pSink};
use bytes::{Bytes, BytesMut};
use rtc::peer_connection::transport::RTCDtlsRole;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use webrtc::data_channel::{DataChannel, DataChannelEvent};
use webrtc::peer_connection::{
    PeerConnection, PeerConnectionBuilder, PeerConnectionEventHandler, RTCConfigurationBuilder,
    RTCIceCandidateInit, RTCIceServer, RTCPeerConnectionIceEvent, RTCPeerConnectionState,
    RTCSessionDescription, SettingEngineBuilder,
};

const MAX_SDP: usize = 64 * 1024;
const MAX_CANDIDATE: usize = 1024;
const DEFAULT_OPEN_TIMEOUT: Duration = Duration::from_secs(10);
const DEFAULT_CHUNK_BYTES: usize = 16 * 1024;

/// 环境变量 MULTICC_REMOTE_P2P=0 时关掉直连（只走中继）。
pub fn factory() -> Option<P2pFactory> {
    if std::env::var("MULTICC_REMOTE_P2P").is_ok_and(|v| v == "0") {
        return None;
    }
    Some(Arc::new(|opts: P2pOptions, tx: UnboundedSender<P2pEvent>| {
        Box::new(Session::start(opts, tx)) as Box<dyn P2pControl>
    }))
}

// ───────────────────────────── 同步外壳 ─────────────────────────────

struct Shared {
    closed: AtomicBool,
    active: AtomicBool,
    /// 已交给驱动、尚未处理（尚未交给 DataChannel）的字节数。
    queued: AtomicUsize,
    /// 最近一次观察到的 DataChannel outstanding bytes（SCTP 未释放）。
    outstanding: AtomicUsize,
    out_tx: UnboundedSender<OutFrame>,
    cmd_tx: UnboundedSender<Cmd>,
}

struct Sink {
    shared: Arc<Shared>,
    gen: u64,
    alive: AtomicBool,
    chunk_bytes: usize,
}

impl P2pSink for Sink {
    fn send(&self, frame: &[u8]) -> bool {
        if !self.alive.load(Ordering::SeqCst) || self.shared.closed.load(Ordering::SeqCst) {
            return false;
        }
        if frame.is_empty() {
            return true;
        }
        let bytes = Bytes::copy_from_slice(frame);
        let chunk = self.chunk_bytes.max(1);
        let mut off = 0usize;
        while off < bytes.len() {
            let end = (off + chunk).min(bytes.len());
            let piece = bytes.slice(off..end);
            self.shared.queued.fetch_add(piece.len(), Ordering::SeqCst);
            if self.shared.out_tx.send(OutFrame { gen: self.gen, data: piece }).is_err() {
                self.shared.queued.fetch_sub(end - off, Ordering::SeqCst);
                self.alive.store(false, Ordering::SeqCst);
                return false;
            }
            off = end;
        }
        true
    }

    fn buffered(&self) -> usize {
        self.shared.queued.load(Ordering::SeqCst) + self.shared.outstanding.load(Ordering::SeqCst)
    }
}

struct Session {
    shared: Arc<Shared>,
}

impl P2pControl for Session {
    fn handle_signal(&self, msg: &Value) {
        if self.shared.closed.load(Ordering::SeqCst) {
            return;
        }
        let Some(obj) = msg.as_object() else { return };
        // 与 JS 版一致：类型不对、字段缺失或超长一律忽略。
        match obj.get("t").and_then(Value::as_str) {
            Some("rtc-offer") => {
                let Some(sdp) = obj.get("sdp").and_then(Value::as_str) else {
                    return;
                };
                if sdp.is_empty() || sdp.len() > MAX_SDP {
                    return;
                }
                let _ = self.shared.cmd_tx.send(Cmd::Offer(sdp.to_string()));
            }
            Some("rtc-ice") => {
                let Some(c) = obj.get("candidate").and_then(Value::as_object) else {
                    return;
                };
                let Some(candidate) = c.get("candidate").and_then(Value::as_str) else {
                    return;
                };
                if candidate.len() > MAX_CANDIDATE {
                    return;
                }
                let sdp_mid = c
                    .get("sdpMid")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                let sdp_mline_index = c
                    .get("sdpMLineIndex")
                    .and_then(Value::as_u64)
                    .and_then(|v| u16::try_from(v).ok());
                let _ = self.shared.cmd_tx.send(Cmd::Ice(RTCIceCandidateInit {
                    candidate: candidate.to_owned(),
                    sdp_mid,
                    sdp_mline_index,
                    username_fragment: None,
                    url: None,
                }));
            }
            Some("rtc-close") => {
                let _ = self.shared.cmd_tx.send(Cmd::DropPeer);
            }
            _ => {}
        }
    }

    fn active(&self) -> bool {
        self.shared.active.load(Ordering::SeqCst)
    }

    fn close(&self) {
        if self.shared.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        self.shared.active.store(false, Ordering::SeqCst);
        let _ = self.shared.cmd_tx.send(Cmd::Shutdown);
    }
}

impl Session {
    fn start(opts: P2pOptions, ev_tx: UnboundedSender<P2pEvent>) -> Session {
        let (cmd_tx, cmd_rx) = unbounded_channel();
        let (out_tx, out_rx) = unbounded_channel();
        let shared = Arc::new(Shared {
            closed: AtomicBool::new(false),
            active: AtomicBool::new(false),
            queued: AtomicUsize::new(0),
            outstanding: AtomicUsize::new(0),
            out_tx,
            cmd_tx,
        });
        let session = Session { shared: shared.clone() };
        match tokio::runtime::Handle::try_current() {
            Ok(handle) => {
                handle.spawn(async move {
                    drive(opts, shared, ev_tx, cmd_rx, out_rx).await;
                });
            }
            Err(_) => {
                // 不在 tokio 运行时里：把会话直接标记为关闭，调用方仍能安全地 no-op。
                session.shared.closed.store(true, Ordering::SeqCst);
            }
        }
        session
    }
}

// ───────────────────────────── 后台驱动 ─────────────────────────────

struct OutFrame {
    gen: u64,
    data: Bytes,
}

enum Cmd {
    Offer(String),
    Ice(RTCIceCandidateInit),
    DropPeer,
    Shutdown,
}

enum Ev {
    Candidate {
        gen: u64,
        candidate: String,
        index: Option<u16>,
    },
    State {
        gen: u64,
        state: RTCPeerConnectionState,
    },
    DataChannel {
        gen: u64,
        dc: Arc<dyn DataChannel>,
    },
    DcOpen(u64),
    DcMsg(u64, Bytes),
    DcClosed(u64),
}

struct PeerState {
    gen: u64,
    pc: Arc<dyn PeerConnection>,
    dc: Option<Arc<dyn DataChannel>>,
    sink: Option<Arc<Sink>>,
    deadline: Option<tokio::time::Instant>,
    /// offer 里数据 m-line 的 mid，用来给本地候选填 sdpMid（浏览器/App 都认）。
    sdp_mid: Option<String>,
}

/// 每个 PeerConnection 一个 handler；事件带上 generation，旧的直接丢。
struct Handler {
    gen: u64,
    ev_tx: UnboundedSender<Ev>,
}

#[async_trait::async_trait]
impl PeerConnectionEventHandler for Handler {
    async fn on_ice_candidate(&self, event: RTCPeerConnectionIceEvent) {
        let Ok(init) = event.candidate.to_json() else {
            return;
        };
        // 收集结束的空候选不发。
        if init.candidate.is_empty() || init.candidate == "candidate:" {
            return;
        }
        let _ = self.ev_tx.send(Ev::Candidate {
            gen: self.gen,
            candidate: init.candidate,
            index: init.sdp_mline_index,
        });
    }

    async fn on_connection_state_change(&self, state: RTCPeerConnectionState) {
        let _ = self.ev_tx.send(Ev::State {
            gen: self.gen,
            state,
        });
    }

    async fn on_data_channel(&self, dc: Arc<dyn DataChannel>) {
        let _ = self.ev_tx.send(Ev::DataChannel {
            gen: self.gen,
            dc,
        });
    }
}

async fn drive(
    opts: P2pOptions,
    shared: Arc<Shared>,
    ev_tx: UnboundedSender<P2pEvent>,
    mut cmd_rx: UnboundedReceiver<Cmd>,
    mut out_rx: UnboundedReceiver<OutFrame>,
) {
    let open_timeout = if opts.open_timeout.is_zero() {
        DEFAULT_OPEN_TIMEOUT
    } else {
        opts.open_timeout
    };
    let chunk_bytes = if opts.chunk_bytes == 0 {
        DEFAULT_CHUNK_BYTES
    } else {
        opts.chunk_bytes
    };
    let stun_urls = opts.stun_urls;

    let (int_tx, mut int_rx) = unbounded_channel::<Ev>();
    let mut peer: Option<PeerState> = None;
    let mut generation: u64 = 0;
    // offer 之前到达的候选（werift 会在 setLocalDescription 里同步吐候选）。
    // JS 版直接丢掉；这里先存最多 16 个，下一个 peer 建好后套用，避免信令乱序丢连通。
    let mut pending_ice: std::collections::VecDeque<RTCIceCandidateInit> =
        std::collections::VecDeque::new();
    // 让 out_rx 永远不会因为「发送端都 drop 了」返回 None；退出只由命令通道决定。
    let _out_keepalive = shared.out_tx.clone();

    let emit = |ev: P2pEvent| {
        if !shared.closed.load(Ordering::SeqCst) {
            let _ = ev_tx.send(ev);
        }
    };

    loop {
        let deadline = peer.as_ref().and_then(|p| p.deadline);
        let timeout_fut = async move {
            match deadline {
                Some(d) => tokio::time::sleep_until(d).await,
                None => std::future::pending::<()>().await,
            }
        };

        tokio::select! {
            cmd = cmd_rx.recv() => {
                match cmd {
                    None | Some(Cmd::Shutdown) => {
                        drop_peer(&mut peer, &shared, &ev_tx, true).await;
                        break;
                    }
                    Some(Cmd::DropPeer) => {
                        drop_peer(&mut peer, &shared, &ev_tx, shared.closed.load(Ordering::SeqCst)).await;
                    }
                    Some(Cmd::Offer(sdp)) => {
                        // 再次 offer：先替换旧 peer，旧 peer Open 过的先发 Closed。
                        drop_peer(&mut peer, &shared, &ev_tx, shared.closed.load(Ordering::SeqCst)).await;
                        generation += 1;
                        let gen = generation;
                        match build_answer(
                            gen,
                            &sdp,
                            &stun_urls,
                            int_tx.clone(),
                            open_timeout,
                            &shared,
                            &ev_tx,
                        ).await {
                            Ok(mut next) => {
                                for c in pending_ice.drain(..) {
                                    let _ = next.pc.add_ice_candidate(c).await;
                                }
                                next.sink = None;
                                peer = Some(next);
                            }
                            Err(_) => {
                                // 与 JS 的 handleOffer().catch(dropPeer) 一致。
                                peer = None;
                                shared.active.store(false, Ordering::SeqCst);
                            }
                        }
                    }
                    Some(Cmd::Ice(candidate)) => {
                        match peer.as_ref() {
                            Some(p) => {
                                let _ = p.pc.add_ice_candidate(candidate).await;
                            }
                            None => {
                                if pending_ice.len() >= 16 {
                                    pending_ice.pop_front();
                                }
                                pending_ice.push_back(candidate);
                            }
                        }
                    }
                }
            }
            ev = int_rx.recv() => {
                let Some(ev) = ev else { continue };
                match ev {
                    Ev::Candidate { gen, candidate, index } => {
                        let Some(p) = peer.as_ref() else { continue };
                        if p.gen != gen { continue; }
                        if shared.closed.load(Ordering::SeqCst) { continue; }
                        let mut c = serde_json::Map::new();
                        c.insert("candidate".into(), Value::String(candidate));
                        if let Some(mid) = &p.sdp_mid {
                            c.insert("sdpMid".into(), Value::String(mid.clone()));
                        }
                        if let Some(idx) = index {
                            c.insert("sdpMLineIndex".into(), Value::from(idx));
                        }
                        emit(P2pEvent::Signal(json!({"t":"rtc-ice","candidate": c})));
                    }
                    Ev::State { gen, state } => {
                        let matches = peer.as_ref().is_some_and(|p| p.gen == gen);
                        if matches
                            && matches!(
                                state,
                                RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed
                            )
                        {
                            drop_peer(&mut peer, &shared, &ev_tx, shared.closed.load(Ordering::SeqCst)).await;
                        }
                    }
                    Ev::DataChannel { gen, dc } => {
                        let matches = peer.as_ref().is_some_and(|p| p.gen == gen);
                        if !matches { continue; }
                        // 已经 Open 过的 DataChannel 不再换。
                        let already = peer.as_ref().is_some_and(|p| p.dc.is_some());
                        if already { continue; }
                        if let Some(p) = peer.as_mut() { p.dc = Some(dc.clone()); }
                        let opened = matches!(dc.ready_state().await, Ok(webrtc::data_channel::RTCDataChannelState::Open));
                        if opened {
                            let _ = int_tx.send(Ev::DcOpen(gen));
                        }
                        let ev_tx2 = int_tx.clone();
                        tokio::spawn(async move {
                            let mut sent_close = false;
                            while let Some(event) = dc.poll().await {
                                let mapped = match event {
                                    DataChannelEvent::OnOpen => Some(Ev::DcOpen(gen)),
                                    DataChannelEvent::OnMessage(m) => {
                                        if m.is_string { None } else { Some(Ev::DcMsg(gen, m.data.freeze())) }
                                    }
                                    DataChannelEvent::OnClose | DataChannelEvent::OnClosing => {
                                        sent_close = true;
                                        Some(Ev::DcClosed(gen))
                                    }
                                    _ => None,
                                };
                                if let Some(ev) = mapped {
                                    if ev_tx2.send(ev).is_err() { return; }
                                }
                            }
                            if !sent_close {
                                let _ = ev_tx2.send(Ev::DcClosed(gen));
                            }
                        });
                    }
                    Ev::DcOpen(gen) => {
                        let Some(p) = peer.as_mut() else { continue };
                        if p.gen != gen || p.sink.is_some() { continue; }
                        let sink = Arc::new(Sink {
                            shared: shared.clone(),
                            gen,
                            alive: AtomicBool::new(true),
                            chunk_bytes,
                        });
                        p.sink = Some(sink.clone());
                        p.deadline = None;
                        shared.active.store(true, Ordering::SeqCst);
                        emit(P2pEvent::Open(sink as Arc<dyn P2pSink>));
                    }
                    Ev::DcMsg(gen, data) => {
                        let matches = peer.as_ref().is_some_and(|p| p.gen == gen && p.sink.is_some());
                        if matches {
                            emit(P2pEvent::Input(data));
                        }
                    }
                    Ev::DcClosed(gen) => {
                        let matches = peer.as_ref().is_some_and(|p| p.gen == gen);
                        if matches {
                            drop_peer(&mut peer, &shared, &ev_tx, shared.closed.load(Ordering::SeqCst)).await;
                        }
                    }
                }
            }
            frame = out_rx.recv() => {
                let Some(frame) = frame else { continue };
                let len = frame.data.len();
                shared.queued.fetch_sub(len, Ordering::SeqCst);
                // 旧 peer 入队的帧绝不能再送给新 peer。
                if peer.as_ref().map(|p| p.gen) != Some(frame.gen) {
                    continue;
                }
                let dc = peer.as_ref().and_then(|p| p.dc.clone()).filter(|_| shared.active.load(Ordering::SeqCst));
                if let Some(dc) = dc {
                    let sent = dc.try_send(BytesMut::from(&frame.data[..])).await;
                    if sent.is_err() {
                        drop_peer(&mut peer, &shared, &ev_tx, shared.closed.load(Ordering::SeqCst)).await;
                    } else if let Ok(out) = dc.outstanding_bytes().await {
                        // 先更新 outstanding 再减 queued 的顺序在 Sink::send 里保证
                        // buffered() 只会高估、不会低估。
                        shared.outstanding.store(out, Ordering::SeqCst);
                    }
                } else {
                    shared.outstanding.store(0, Ordering::SeqCst);
                }
            }
            _ = timeout_fut => {
                // offer 之后 open_timeout 内 DataChannel 没 open：丢掉 peer，不发 Open。
                drop_peer(&mut peer, &shared, &ev_tx, shared.closed.load(Ordering::SeqCst)).await;
            }
        }
    }
}

async fn drop_peer(
    peer: &mut Option<PeerState>,
    shared: &Shared,
    ev_tx: &UnboundedSender<P2pEvent>,
    closed: bool,
) {
    let Some(p) = peer.take() else {
        return;
    };
    if let Some(sink) = &p.sink {
        sink.alive.store(false, Ordering::SeqCst);
    }
    shared.active.store(false, Ordering::SeqCst);
    shared.outstanding.store(0, Ordering::SeqCst);
    // Open 过才发 Closed；close() 之后一个事件都不发。
    if p.sink.is_some() && !closed {
        let _ = ev_tx.send(P2pEvent::Closed);
    }
    let _ = p.pc.close().await;
    // p.dc / p.sink 在这里 drop，SCTP / poll 任务随之结束。
}

async fn build_answer(
    gen: u64,
    sdp: &str,
    stun_urls: &[String],
    int_tx: UnboundedSender<Ev>,
    open_timeout: Duration,
    shared: &Arc<Shared>,
    ev_tx: &UnboundedSender<P2pEvent>,
) -> Result<PeerState, ()> {
    let ice_servers = if stun_urls.is_empty() {
        Vec::new()
    } else {
        vec![RTCIceServer {
            urls: stun_urls.to_vec(),
            ..Default::default()
        }]
    };
    let config = RTCConfigurationBuilder::new()
        .with_ice_servers(ice_servers)
        .build();
    // 答方固定当 DTLS/SCTP server（answer 里 a=setup:passive）：
    //   · Chrome/App（libwebrtc）标准支持；
    //   · werift 作为 offerer 按 ICE controlling 认定自己是 SCTP client，
    //     答方若也当 client，双方都会发 SCTP INIT，关联永远建不起来。
    let setting = SettingEngineBuilder::new()
        .with_answering_dtls_role(RTCDtlsRole::Server)
        .build();
    let pc: Arc<dyn PeerConnection> = Arc::new(
        PeerConnectionBuilder::new()
            .with_configuration(config)
            .with_setting_engine(setting)
            .with_handler(Arc::new(Handler {
                gen,
                ev_tx: int_tx.clone(),
            }))
            .with_udp_addrs(vec!["0.0.0.0:0".to_string()])
            .build()
            .await
            .map_err(|_| ())?,
    );
    let offer = RTCSessionDescription::offer(sdp.to_owned()).map_err(|_| ())?;
    if pc.set_remote_description(offer).await.is_err() {
        let _ = pc.close().await;
        return Err(());
    }
    let answer = pc.create_answer(None).await.map_err(|_| ())?;
    if pc.set_local_description(answer).await.is_err() {
        let _ = pc.close().await;
        return Err(());
    }
    // trickle ICE：answer 立即发出（不等候选收集完）。
    if let Some(local) = pc.local_description().await {
        if !shared.closed.load(Ordering::SeqCst) {
            let _ = ev_tx.send(P2pEvent::Signal(
                json!({"t":"rtc-answer","sdp": local.sdp}),
            ));
        }
    }
    Ok(PeerState {
        gen,
        pc,
        dc: None,
        sink: None,
        deadline: Some(tokio::time::Instant::now() + open_timeout),
        sdp_mid: data_channel_mid(sdp),
    })
}

/// offer 里 **application m-line** 的 `a=mid:`。
///
/// 不能拿第一条 `a=mid:` 顶替：多 m-line 的 offer（音频 + DataChannel、或浏览器
/// 预置的 m-line）第一条 mid 是音频/视频的，本地候选挂到错的 mid 上，对端会当成
/// 无效候选直接丢，于是 trickle ICE 永远连不上。没有 application m-line（不该出现，
/// 但别 panic）时退回第一条 mid，保持和旧实现一样能工作。
fn data_channel_mid(sdp: &str) -> Option<String> {
    let mut in_application = false;
    let mut first = None;
    for line in sdp.lines() {
        let line = line.trim_end_matches('\r');
        if let Some(media) = line.strip_prefix("m=") {
            in_application = media.split_whitespace().next() == Some("application");
            continue;
        }
        if let Some(mid) = line.strip_prefix("a=mid:") {
            let mid = mid.trim().to_owned();
            if in_application {
                return Some(mid);
            }
            first.get_or_insert(mid);
        }
    }
    first
}

#[cfg(test)]
mod tests {
    use super::data_channel_mid;

    #[test]
    fn sdp_mid_comes_from_the_application_m_line() {
        let sdp = "v=0\r\n\
                   m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n\
                   a=mid:audio\r\n\
                   m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n\
                   a=mid:data\r\n";
        assert_eq!(data_channel_mid(sdp).as_deref(), Some("data"));
    }

    #[test]
    fn sdp_mid_falls_back_to_the_first_mid_without_an_application_m_line() {
        let sdp = "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:0\r\n";
        assert_eq!(data_channel_mid(sdp).as_deref(), Some("0"));
        let bare = "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:v0\r\n";
        assert_eq!(data_channel_mid(bare).as_deref(), Some("v0"));
        assert_eq!(data_channel_mid("v=0\r\n"), None);
    }
}
