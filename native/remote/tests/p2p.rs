//! p2p.rs 的行为测试：用同一个 webrtc-rs 在进程内当 offerer 端。

use bytes::BytesMut;
use multicc_remote::p2p;
use multicc_remote::p2p_api::{P2pControl, P2pEvent, P2pOptions, P2pSink};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tokio::time::{sleep, Instant};
use webrtc::data_channel::{DataChannel, DataChannelEvent};
use webrtc::peer_connection::{
    PeerConnection, PeerConnectionBuilder, PeerConnectionEventHandler, RTCConfigurationBuilder,
    RTCIceCandidateInit, RTCPeerConnectionIceEvent, RTCPeerConnectionState, RTCSessionDescription,
};

// ───────────────────────── offerer 端 ─────────────────────────

enum TestEv {
    Candidate(Value),
    /// offerer 自己的连接状态；用例只等 DataChannel，不读具体状态。
    State,
    /// DataChannel 由本侧建，服务端不会反推；只是等它出现，不读句柄。
    Dc,
}

enum DcEv {
    Open,
    Msg(Vec<u8>),
    Closed,
}

struct TestHandler {
    tx: UnboundedSender<TestEv>,
}

fn candidate_json(c: &webrtc::peer_connection::RTCIceCandidate) -> Option<Value> {
    let init = c.to_json().ok()?;
    if init.candidate.is_empty() || init.candidate == "candidate:" {
        return None;
    }
    let mut m = serde_json::Map::new();
    m.insert("candidate".into(), Value::String(init.candidate));
    if let Some(mid) = init.sdp_mid {
        m.insert("sdpMid".into(), Value::String(mid));
    }
    if let Some(idx) = init.sdp_mline_index {
        m.insert("sdpMLineIndex".into(), Value::from(idx));
    }
    Some(Value::Object(m))
}

#[async_trait::async_trait]
impl PeerConnectionEventHandler for TestHandler {
    async fn on_ice_candidate(&self, event: RTCPeerConnectionIceEvent) {
        if let Some(v) = candidate_json(&event.candidate) {
            let _ = self.tx.send(TestEv::Candidate(v));
        }
    }
    async fn on_connection_state_change(&self, _state: RTCPeerConnectionState) {
        let _ = self.tx.send(TestEv::State);
    }
    async fn on_data_channel(&self, _dc: Arc<dyn DataChannel>) {
        let _ = self.tx.send(TestEv::Dc);
    }
}

struct Offerer {
    pc: Arc<dyn PeerConnection>,
    dc: Arc<dyn DataChannel>,
    sig_rx: UnboundedReceiver<TestEv>,
    dc_rx: UnboundedReceiver<DcEv>,
    /// 本端 offer 的 SDP（用于测试里直接发给服务端）。
    offer_sdp: String,
}

async fn new_offerer() -> Offerer {
    let (sig_tx, sig_rx) = unbounded_channel();
    let pc: Arc<dyn PeerConnection> = Arc::new(
        PeerConnectionBuilder::new()
            .with_configuration(RTCConfigurationBuilder::new().build())
            .with_handler(Arc::new(TestHandler { tx: sig_tx }))
            .with_udp_addrs(vec!["0.0.0.0:0".to_string()])
            .build()
            .await
            .expect("build offerer pc"),
    );
    let dc = pc.create_data_channel("screen", None).await.expect("dc");
    let (dc_tx, dc_rx) = unbounded_channel();
    let dc2 = dc.clone();
    tokio::spawn(async move {
        while let Some(e) = dc2.poll().await {
            let mapped = match e {
                DataChannelEvent::OnOpen => Some(DcEv::Open),
                DataChannelEvent::OnMessage(m) => {
                    if m.is_string {
                        None
                    } else {
                        Some(DcEv::Msg(m.data.to_vec()))
                    }
                }
                DataChannelEvent::OnClose | DataChannelEvent::OnClosing => Some(DcEv::Closed),
                _ => None,
            };
            if let Some(ev) = mapped {
                if dc_tx.send(ev).is_err() {
                    break;
                }
            }
        }
    });
    let offer = pc.create_offer(None).await.expect("create_offer");
    pc.set_local_description(offer).await.expect("set_local");
    let offer_sdp = pc.local_description().await.expect("local description").sdp;
    Offerer {
        pc,
        dc,
        sig_rx,
        dc_rx,
        offer_sdp,
    }
}

// ───────────────────────── 双向泵 ─────────────────────────

async fn apply_signal_to_offerer(offerer: &Offerer, v: &Value) {
    match v.get("t").and_then(Value::as_str) {
        Some("rtc-answer") => {
            if let Some(sdp) = v.get("sdp").and_then(Value::as_str) {
                if let Ok(desc) = RTCSessionDescription::answer(sdp.to_owned()) {
                    let _ = offerer.pc.set_remote_description(desc).await;
                }
            }
        }
        Some("rtc-ice") => {
            if let Some(c) = v.get("candidate").and_then(Value::as_object) {
                if let Some(candidate) = c.get("candidate").and_then(Value::as_str) {
                    let init = RTCIceCandidateInit {
                        candidate: candidate.to_owned(),
                        sdp_mid: c.get("sdpMid").and_then(Value::as_str).map(str::to_owned),
                        sdp_mline_index: c
                            .get("sdpMLineIndex")
                            .and_then(Value::as_u64)
                            .and_then(|n| u16::try_from(n).ok()),
                        username_fragment: None,
                        url: None,
                    };
                    let _ = offerer.pc.add_ice_candidate(init).await;
                }
            }
        }
        _ => {}
    }
}

fn forward_candidate(ctl: &dyn P2pControl, candidate: Value) {
    ctl.handle_signal(&json!({"t":"rtc-ice","candidate": candidate}));
}

/// 泵事件：服务端 → offerer 的信号会应用；offerer 的候选转发给服务端。
/// 返回收集到的事件。`deliver` 为 false 时故意不把 answer 交给 offerer（模拟打不通）。
async fn pump(
    ctl: &dyn P2pControl,
    rx: &mut UnboundedReceiver<P2pEvent>,
    offerer: &mut Offerer,
    dur: Duration,
    deliver: bool,
    stop_on_open: bool,
) -> Vec<P2pEvent> {
    let deadline = Instant::now() + dur;
    let mut out = Vec::new();
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            break;
        }
        tokio::select! {
            _ = sleep(left) => break,
            ev = rx.recv() => {
                let Some(ev) = ev else { break };
                if deliver {
                    if let P2pEvent::Signal(v) = &ev {
                        apply_signal_to_offerer(offerer, v).await;
                    }
                }
                let opened = matches!(ev, P2pEvent::Open(_));
                out.push(ev);
                if stop_on_open && opened {
                    break;
                }
            }
            tev = offerer.sig_rx.recv() => {
                if let Some(TestEv::Candidate(c)) = tev {
                    forward_candidate(ctl, c);
                }
            }
        }
    }
    out
}

fn take_sink(events: &mut [P2pEvent]) -> Option<Arc<dyn P2pSink>> {
    for ev in events.iter_mut() {
        if let P2pEvent::Open(sink) = ev {
            return Some(sink.clone());
        }
    }
    None
}

fn count_closed(events: &[P2pEvent]) -> usize {
    events
        .iter()
        .filter(|e| matches!(e, P2pEvent::Closed))
        .count()
}

// ───────────────────────── 用例 ─────────────────────────

fn options(timeout_ms: u64) -> P2pOptions {
    P2pOptions {
        stun_urls: vec![],
        open_timeout: Duration::from_millis(timeout_ms),
        chunk_bytes: 16 * 1024,
    }
}

async fn setup(timeout_ms: u64) -> (Box<dyn P2pControl>, UnboundedReceiver<P2pEvent>) {
    let factory = p2p::factory().expect("p2p available");
    let (tx, rx) = unbounded_channel();
    let ctl = factory(options(timeout_ms), tx);
    (ctl, rx)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn answer_trickle_connects_and_opens() {
    let (ctl, mut rx) = setup(10_000).await;
    let mut off = new_offerer().await;
    ctl.handle_signal(&json!({"t":"rtc-offer","sdp": off.offer_sdp}));

    let mut events = pump(
        ctl.as_ref(),
        &mut rx,
        &mut off,
        Duration::from_secs(8),
        true,
        true,
    )
    .await;

    assert!(
        events
            .iter()
            .any(|e| matches!(e, P2pEvent::Signal(v) if v["t"] == "rtc-answer")),
        "should emit an answer"
    );
    assert!(
        events
            .iter()
            .any(|e| matches!(e, P2pEvent::Signal(v) if v["t"] == "rtc-ice")),
        "should trickle at least one local candidate"
    );
    assert!(take_sink(&mut events).is_some(), "DataChannel should open");
    assert!(ctl.active());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn large_frame_is_reassembled_byte_for_byte() {
    let (ctl, mut rx) = setup(10_000).await;
    let mut off = new_offerer().await;
    ctl.handle_signal(&json!({"t":"rtc-offer","sdp": off.offer_sdp}));
    let mut events = pump(
        ctl.as_ref(),
        &mut rx,
        &mut off,
        Duration::from_secs(8),
        true,
        true,
    )
    .await;
    let sink = take_sink(&mut events).expect("open");

    // [type u8][len u32 BE][payload]，payload > 200 KB。
    let payload: Vec<u8> = (0..230_000usize).map(|i| (i * 31 % 251) as u8).collect();
    let mut frame = Vec::with_capacity(5 + payload.len());
    frame.push(3u8);
    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.extend_from_slice(&payload);

    assert!(sink.send(&frame), "send should enqueue");
    // 驱动把帧交给 SCTP 需要一点时间；等对端拼齐。
    let mut got = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(8);
    while got.len() < frame.len() && Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(500), off.dc_rx.recv()).await {
            Ok(Some(DcEv::Msg(m))) => got.extend_from_slice(&m),
            Ok(Some(_)) => {}
            Ok(None) => break,
            Err(_) => {}
        }
    }
    assert_eq!(got.len(), frame.len(), "reassembled length");
    assert_eq!(got, frame, "reassembled bytes");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn client_input_arrives_as_input_event() {
    let (ctl, mut rx) = setup(10_000).await;
    let mut off = new_offerer().await;
    ctl.handle_signal(&json!({"t":"rtc-offer","sdp": off.offer_sdp}));
    let mut events = pump(
        ctl.as_ref(),
        &mut rx,
        &mut off,
        Duration::from_secs(8),
        true,
        true,
    )
    .await;
    assert!(take_sink(&mut events).is_some());

    // 等对端 DataChannel open。
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match tokio::time::timeout(Duration::from_millis(200), off.dc_rx.recv()).await {
            Ok(Some(DcEv::Open)) => break,
            Ok(Some(_)) => {}
            _ if Instant::now() > deadline => panic!("dc never opened"),
            _ => {}
        }
    }
    off.dc
        .send(BytesMut::from(&[0x4bu8, 1, 2, 3][..]))
        .await
        .expect("send input");

    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            panic!("no Input event");
        }
        match tokio::time::timeout(left, rx.recv()).await {
            Ok(Some(P2pEvent::Input(b))) => {
                assert_eq!(&b[..], &[0x4b, 1, 2, 3]);
                break;
            }
            Ok(Some(_)) => {}
            Ok(None) => panic!("event channel closed"),
            Err(_) => panic!("timeout waiting for input"),
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn peer_close_emits_closed() {
    let (ctl, mut rx) = setup(10_000).await;
    let mut off = new_offerer().await;
    ctl.handle_signal(&json!({"t":"rtc-offer","sdp": off.offer_sdp}));
    let mut events = pump(
        ctl.as_ref(),
        &mut rx,
        &mut off,
        Duration::from_secs(8),
        true,
        true,
    )
    .await;
    assert!(take_sink(&mut events).is_some());

    // 等 dc open 再关。
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match tokio::time::timeout(Duration::from_millis(200), off.dc_rx.recv()).await {
            Ok(Some(DcEv::Open)) => break,
            _ if Instant::now() > deadline => break,
            _ => {}
        }
    }
    off.dc.close().await.expect("close dc");

    let deadline = Instant::now() + Duration::from_secs(5);
    let mut closed = false;
    while Instant::now() < deadline {
        let left = deadline.saturating_duration_since(Instant::now());
        match tokio::time::timeout(left, rx.recv()).await {
            Ok(Some(P2pEvent::Closed)) => {
                closed = true;
                break;
            }
            Ok(Some(_)) => {}
            _ => break,
        }
    }
    assert!(closed, "Closed should be emitted after the peer closes");
    assert!(!ctl.active());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn open_timeout_drops_peer_without_open() {
    let factory = p2p::factory().expect("p2p available");
    let (tx, mut rx) = unbounded_channel();
    // Use the production 10-second budget: the retry performs real ICE/DTLS
    // negotiation and must not inherit a CI-sensitive 1.5-second deadline.
    // Withhold the first answer so that the same timeout still has to expire.
    let ctl = factory(options(10_000), tx);
    let mut off = new_offerer().await;
    ctl.handle_signal(&json!({"t":"rtc-offer","sdp": off.offer_sdp}));
    let events = pump(
        ctl.as_ref(),
        &mut rx,
        &mut off,
        Duration::from_secs(11),
        false,
        false,
    )
    .await;
    assert!(
        !events.iter().any(|e| matches!(e, P2pEvent::Open(_))),
        "must not open"
    );
    assert_eq!(count_closed(&events), 0, "never opened → no Closed");
    assert!(!ctl.active());

    // 超时后会话仍然可用：新 offer 能正常打通（旧 peer 已释放）。
    let mut off2 = new_offerer().await;
    ctl.handle_signal(&json!({"t":"rtc-offer","sdp": off2.offer_sdp}));
    let mut events = pump(
        ctl.as_ref(),
        &mut rx,
        &mut off2,
        Duration::from_secs(12),
        true,
        true,
    )
    .await;
    assert!(
        take_sink(&mut events).is_some(),
        "a fresh offer after timeout should open"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn new_offer_replaces_old_peer() {
    let (ctl, mut rx) = setup(10_000).await;
    let mut off1 = new_offerer().await;
    ctl.handle_signal(&json!({"t":"rtc-offer","sdp": off1.offer_sdp}));
    let mut events = pump(
        ctl.as_ref(),
        &mut rx,
        &mut off1,
        Duration::from_secs(8),
        true,
        true,
    )
    .await;
    let old_sink = take_sink(&mut events).expect("first open");

    // 第二个 offer 替换旧 peer。
    let mut off2 = new_offerer().await;
    ctl.handle_signal(&json!({"t":"rtc-offer","sdp": off2.offer_sdp}));
    let mut events = pump(
        ctl.as_ref(),
        &mut rx,
        &mut off2,
        Duration::from_secs(8),
        true,
        false,
    )
    .await;
    assert_eq!(
        count_closed(&events),
        1,
        "old opened peer → exactly one Closed"
    );
    let new_sink = take_sink(&mut events).expect("second open");
    assert!(!old_sink.send(&[1, 2, 3]), "old sink must be dead");
    assert!(new_sink.send(&[1, 2, 3]), "new sink should accept");
    assert!(ctl.active());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn oversized_sdp_and_candidate_are_ignored() {
    let (ctl, mut rx) = setup(10_000).await;
    // sdp > 64 KiB：直接忽略，不产出任何信号。
    let huge = format!("v=0\r\n{}", "x".repeat(70_000));
    ctl.handle_signal(&json!({"t":"rtc-offer","sdp": huge}));

    let mut off = new_offerer().await;
    let events = pump(
        ctl.as_ref(),
        &mut rx,
        &mut off,
        Duration::from_millis(400),
        true,
        false,
    )
    .await;
    assert!(events.is_empty(), "oversized sdp must produce no events");

    // 正常 offer 仍能打通；随后发送超长 candidate 应被忽略且不影响连接。
    ctl.handle_signal(&json!({"t":"rtc-offer","sdp": off.offer_sdp}));
    let mut events = pump(
        ctl.as_ref(),
        &mut rx,
        &mut off,
        Duration::from_secs(8),
        true,
        true,
    )
    .await;
    assert!(take_sink(&mut events).is_some());
    ctl.handle_signal(&json!({
        "t": "rtc-ice",
        "candidate": { "candidate": "candidate:".to_string() + &"1".repeat(2000), "sdpMLineIndex": 0 }
    }));
    sleep(Duration::from_millis(200)).await;
    assert!(
        ctl.active(),
        "oversized candidate must not break the connection"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn no_events_after_close() {
    let (ctl, mut rx) = setup(10_000).await;
    let mut off = new_offerer().await;
    ctl.handle_signal(&json!({"t":"rtc-offer","sdp": off.offer_sdp}));
    let mut events = pump(
        ctl.as_ref(),
        &mut rx,
        &mut off,
        Duration::from_secs(8),
        true,
        true,
    )
    .await;
    assert!(take_sink(&mut events).is_some());

    ctl.close();
    assert!(!ctl.active());
    // 关闭后再提 offer / 候选，一句都不许回。
    let mut off2 = new_offerer().await;
    ctl.handle_signal(&json!({"t":"rtc-offer","sdp": off2.offer_sdp}));
    ctl.handle_signal(&json!({"t":"rtc-ice","candidate":{"candidate":"candidate:1 1 udp 1 127.0.0.1 9 typ host","sdpMLineIndex":0}}));

    let events = pump(
        ctl.as_ref(),
        &mut rx,
        &mut off2,
        Duration::from_millis(600),
        true,
        false,
    )
    .await;
    assert!(
        events.is_empty(),
        "no events after close(), got {}",
        events.len()
    );
}
