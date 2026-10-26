//! 移植 tests/test-remote-screen-h264.js 与 tests/test-remote-screen.js 里的两条
//! WS 桥用例（H.264 帧桥、RFB 字节管道）。假 socket / 假 WS 钉住：按帧切分、
//! 积压只丢普通帧并补要关键帧、浏览器→Agent 白名单、P2P 切换顺序、RFB 不丢字节。

mod support;

use bytes::Bytes;
use multicc_remote::h264::{H264Bridge, H264Options, CAP_KBPS, PING, REQ_KEY, T_CONFIG, T_DELTA, T_KEY, T_PONG};
use multicc_remote::p2p_api::{P2pControl, P2pEvent, P2pFactory, P2pSink};
use multicc_remote::rfb::{self, RfbConnector, RfbOptions};
use multicc_remote::stats::Counters;
use multicc_remote::wsout::{Incoming, WsOut};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use support::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc::{self, UnboundedReceiver};
use tokio::sync::Notify;

// ── H.264 桥 ───────────────────────────────────────────────────────────
struct H264Env {
    ws: Arc<FakeWs>,
    agent: UnboundedReceiver<Bytes>,
    clock: Arc<AtomicU64>,
    bridge: H264Bridge,
}

fn h264_opts() -> H264Options {
    let start = std::time::Instant::now();
    H264Options {
        high_water: 1024 * 1024,
        low_water: 256 * 1024,
        now: Arc::new(move || start.elapsed().as_millis() as u64),
        stun_urls: Vec::new(),
        ..Default::default()
    }
}

fn h264_harness(mut opts: H264Options) -> H264Env {
    let clock = Arc::new(AtomicU64::new(0));
    let clock_ref = clock.clone();
    opts.now = Arc::new(move || clock_ref.load(Ordering::SeqCst));
    let ws = FakeWs::new();
    let (tx, rx) = mpsc::unbounded_channel();
    let bridge = H264Bridge::new(ws.clone(), tx, opts, Arc::new(Counters::new()), None);
    H264Env { ws, agent: rx, clock, bridge }
}

fn agent_writes(env: &mut H264Env) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    while let Ok(data) = env.agent.try_recv() {
        out.push(data.to_vec());
    }
    out
}

#[test]
fn reassembles_frames_split_across_reads_one_message_per_frame() {
    let mut env = h264_harness(h264_opts());
    let cfg = frame(T_CONFIG, br#"{"codec":"avc1.64001F","width":1470,"height":956}"#);
    let key = frame(T_KEY, b"KEYFRAME");
    let delta = frame(T_DELTA, b"delta");
    let mut all = Vec::new();
    for part in [&cfg, &key, &delta] {
        all.extend_from_slice(part);
    }
    // 故意切在帧头中间、帧体中间
    env.bridge.feed(&all[..3]);
    env.bridge.feed(&all[3..cfg.len() + 7]);
    env.bridge.feed(&all[cfg.len() + 7..]);
    assert_eq!(env.ws.frame_hexes(), [&cfg, &key, &delta].iter().map(|f| hex(f)).collect::<Vec<_>>());
}

#[test]
fn delta_frames_before_the_first_key_frame_are_dropped() {
    let mut env = h264_harness(h264_opts());
    env.bridge.feed(&frame(T_DELTA, b"early"));
    assert!(env.ws.frames().is_empty());
    env.bridge.feed(&frame(T_KEY, b"k"));
    env.bridge.feed(&frame(T_DELTA, b"d"));
    let types: Vec<u8> = env.ws.frames().iter().map(|f| f[0]).collect();
    assert_eq!(types, vec![T_KEY, T_DELTA]);
}

#[test]
fn frames_parked_in_the_ws_backpressure_queue_count_as_backlog() {
    // 写端把帧攒在队列里时，只看 bufferedAmount 会漏掉几 MB —— 桥必须看到全部积压。
    let mut env = h264_harness(H264Options { high_water: 1000, low_water: 100, ..h264_opts() });
    env.ws.accumulate.store(true, Ordering::SeqCst);
    env.bridge.feed(&frame(T_KEY, b"k1"));
    assert_eq!(env.ws.frames().len(), 1);
    let body = vec![b'd'; 100];
    for _ in 0..40 {
        env.bridge.feed(&frame(T_DELTA, &body));
    }
    let queued = env.ws.buffered();
    assert!(queued <= 1000 + 105, "桥在高水位就停止喂队列（queued {queued}）");
    assert!(env.bridge.stats().dropped.load(Ordering::SeqCst) > 0, "超出积压的普通帧被丢弃，而不是排队");
}

#[test]
fn backlog_drops_deltas_never_the_stream_then_asks_for_a_key_frame_once_drained() {
    let mut env = h264_harness(H264Options { high_water: 1000, low_water: 100, ..h264_opts() });
    env.bridge.feed(&frame(T_KEY, b"k1"));
    env.ws.set_buffered(5000);
    env.bridge.feed(&frame(T_DELTA, b"d1"));
    env.bridge.feed(&frame(T_DELTA, b"d2"));
    assert_eq!(env.ws.frames().len(), 1, "超过高水位的普通帧被丢弃");
    assert!(agent_writes(&mut env).is_empty(), "链路还堵着时不要关键帧");
    assert_eq!(env.ws.close_reason(), None, "慢链路不能断开");

    env.ws.set_buffered(0);
    env.clock.store(1000, Ordering::SeqCst);
    env.bridge.feed(&frame(T_DELTA, b"d3"));
    assert_eq!(env.ws.frames().len(), 1, "还在等关键帧：普通帧解不了");
    assert_eq!(agent_writes(&mut env), vec![vec![REQ_KEY]]);
    env.bridge.feed(&frame(T_DELTA, b"d4"));
    assert!(agent_writes(&mut env).is_empty(), "关键帧请求要节流");

    env.bridge.feed(&frame(T_KEY, b"k2"));
    env.bridge.feed(&frame(T_DELTA, b"d5"));
    let bodies: Vec<String> = env.ws.frames()[1..]
        .iter()
        .map(|f| String::from_utf8_lossy(&f[5..]).to_string())
        .collect();
    assert_eq!(bodies, vec!["k2".to_string(), "d5".to_string()]);
    assert!(env.bridge.stats().dropped.load(Ordering::SeqCst) >= 4);
}

#[test]
fn browser_to_agent_passes_only_key_requests_rate_control_and_rfb_events() {
    let mut env = h264_harness(h264_opts());
    for message in [
        vec![REQ_KEY],
        vec![4, 1, 0, 0, 0, 0, 0, 0x61],
        vec![5, 1, 0, 10, 0, 20],
        vec![CAP_KBPS, 0, 0, 5, 0xdc],
        vec![CAP_KBPS, 0, 0, 0, 0],
        vec![PING, 0, 0, 0, 7],
        vec![CAP_KBPS, 0, 5, 0xdc],           // 长度不对
        vec![PING, 0, 0, 7],                  // 长度不对
        vec![5, 1, 0, 10],                    // 长度不对
        vec![3, 0, 0, 0, 0, 0, 0, 0, 0, 0],   // RFB FramebufferUpdateRequest：不是这座桥的
    ] {
        env.bridge.on_binary(&message);
    }
    env.bridge.on_text("K"); // 文本帧不是输入
    let writes: Vec<String> = agent_writes(&mut env).iter().map(|w| hex(w)).collect();
    assert_eq!(writes, vec!["4b", "0401000000000061", "0501000a0014", "42000005dc", "4200000000", "5000000007"]);
}

#[test]
fn pong_is_forwarded_at_once_never_dropped_and_never_counts_as_a_frame() {
    let mut env = h264_harness(H264Options { high_water: 0, ..h264_opts() });
    // 积压超过水位、且还没见过关键帧：pong 依旧直通，但绝不能顶替视频帧。
    env.ws.set_buffered(10_000);
    let payload = vec![0, 0, 0, 7, 0, 0, 5, 0xdc];
    let pong = frame(T_PONG, &payload);
    env.bridge.feed(&pong);
    assert_eq!(env.ws.frame_hexes(), vec![hex(&pong)]);
    assert_eq!(env.bridge.stats().dropped.load(Ordering::SeqCst), 0);
    assert_eq!(env.bridge.stats().forwarded.load(Ordering::SeqCst), 1);
    env.bridge.on_first_frame_timeout();
    assert_eq!(env.ws.close_reason(), Some((1011, "h264-no-frames".to_string())));
}

#[test]
fn no_frame_from_the_agent_closes_so_the_page_falls_back_to_novnc() {
    let mut env = h264_harness(h264_opts());
    env.bridge.on_first_frame_timeout();
    assert_eq!(env.ws.close_reason(), Some((1011, "h264-no-frames".to_string())));
}

#[test]
fn oversized_frame_header_is_rejected_and_a_socket_close_ends_the_ws() {
    let mut env = h264_harness(H264Options { max_frame_bytes: 16, ..h264_opts() });
    let mut head = vec![T_KEY];
    head.extend_from_slice(&(1u32 << 20).to_be_bytes());
    env.bridge.feed(&head);
    assert_eq!(env.ws.close_reason(), Some((1011, "h264-bad-frame".to_string())));

    let mut other = h264_harness(h264_opts());
    other.bridge.on_agent_closed();
    assert_eq!(other.ws.close_reason(), Some((1011, "h264-unavailable".to_string())));
}

// ── P2P 切换 ───────────────────────────────────────────────────────────
struct FakeControl {
    handled: Arc<Mutex<Vec<Value>>>,
    closed: Arc<AtomicBool>,
}

impl P2pControl for FakeControl {
    fn handle_signal(&self, msg: &Value) {
        self.handled.lock().unwrap().push(msg.clone());
    }
    fn active(&self) -> bool {
        !self.closed.load(Ordering::SeqCst)
    }
    fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
    }
}

struct FakeSink {
    sent: Arc<Mutex<Vec<Vec<u8>>>>,
    backlog: Arc<AtomicUsize>,
}

impl P2pSink for FakeSink {
    fn send(&self, frame: &[u8]) -> bool {
        self.sent.lock().unwrap().push(frame.to_vec());
        true
    }
    fn buffered(&self) -> usize {
        self.backlog.load(Ordering::SeqCst)
    }
}

struct P2pEnv {
    env: H264Env,
    events: UnboundedReceiver<P2pEvent>,
    sender: mpsc::UnboundedSender<P2pEvent>,
    handled: Arc<Mutex<Vec<Value>>>,
    session_closed: Arc<AtomicBool>,
    sink_sent: Arc<Mutex<Vec<Vec<u8>>>>,
    sink_backlog: Arc<AtomicUsize>,
    factory_calls: Arc<AtomicUsize>,
}

fn p2p_harness(opts: H264Options) -> P2pEnv {
    let ws = FakeWs::new();
    let (agent_tx, agent_rx) = mpsc::unbounded_channel();
    let (events_tx, events_rx) = mpsc::unbounded_channel();
    let handled = Arc::new(Mutex::new(Vec::new()));
    let session_closed = Arc::new(AtomicBool::new(false));
    let factory_calls = Arc::new(AtomicUsize::new(0));
    let factory: P2pFactory = {
        let handled = handled.clone();
        let session_closed = session_closed.clone();
        let factory_calls = factory_calls.clone();
        Arc::new(move |_opts, _tx| {
            factory_calls.fetch_add(1, Ordering::SeqCst);
            Box::new(FakeControl { handled: handled.clone(), closed: session_closed.clone() })
        })
    };
    let stats = Arc::new(Counters::new());
    let bridge = H264Bridge::new(
        ws.clone(),
        agent_tx,
        opts,
        stats,
        Some((factory, events_tx.clone())),
    );
    P2pEnv {
        env: H264Env { ws, agent: agent_rx, clock: Arc::new(AtomicU64::new(0)), bridge },
        events: events_rx,
        sender: events_tx,
        handled,
        session_closed,
        sink_sent: Arc::new(Mutex::new(Vec::new())),
        sink_backlog: Arc::new(AtomicUsize::new(0)),
        factory_calls,
    }
}

fn deliver(env: &mut P2pEnv, event: P2pEvent) {
    env.sender.send(event).unwrap();
    while let Ok(event) = env.events.try_recv() {
        env.env.bridge.on_p2p_event(event);
    }
}

fn sink(env: &P2pEnv) -> Arc<dyn P2pSink> {
    Arc::new(FakeSink { sent: env.sink_sent.clone(), backlog: env.sink_backlog.clone() })
}

#[test]
fn p2p_hello_on_attach_text_frames_are_signalling_and_frames_follow_the_active_channel() {
    let mut env = p2p_harness(h264_opts());
    assert_eq!(env.factory_calls.load(Ordering::SeqCst), 1);
    assert_eq!(env.env.ws.signals(), vec![json!({ "t": "rtc-hello", "iceServers": [] })]);

    env.env.bridge.on_text(r#"{"t":"rtc-offer","sdp":"v=0"}"#);
    assert_eq!(env.handled.lock().unwrap().clone(), vec![json!({ "t": "rtc-offer", "sdp": "v=0" })]);

    env.env.bridge.feed(&frame(T_KEY, b"k1"));
    assert_eq!(env.env.ws.frames().len(), 1, "直连打开前走中继");

    let direct = sink(&env);
    deliver(&mut env, P2pEvent::Open(direct));
    assert_eq!(env.env.ws.signals().last(), Some(&json!({ "t": "rtc-active", "on": true })), "先告诉浏览器再切帧");
    assert_eq!(agent_writes(&mut env.env), vec![vec![REQ_KEY]], "切换后要关键帧");
    assert_eq!(*env.env.bridge.stats().snapshot("h264").get("transport").unwrap(), json!("p2p"));

    env.env.bridge.feed(&frame(T_DELTA, b"d-before-key"));
    env.env.bridge.feed(&frame(T_KEY, b"k2"));
    env.env.bridge.feed(&frame(T_DELTA, b"d2"));
    let bodies: Vec<String> = env.sink_sent.lock().unwrap()[..]
        .iter()
        .map(|f| String::from_utf8_lossy(&f[5..]).to_string())
        .collect();
    assert_eq!(bodies, vec!["k2".to_string(), "d2".to_string()], "新通道从关键帧开始");
    assert_eq!(env.env.ws.frames().len(), 1, "中继上不再有帧");

    // 直连上的输入同样按白名单转给 Agent
    deliver(&mut env, P2pEvent::Input(Bytes::from_static(&[5, 1, 0, 1, 0, 2])));
    deliver(&mut env, P2pEvent::Input(Bytes::from_static(&[3, 0])));
    assert_eq!(agent_writes(&mut env.env), vec![vec![5, 1, 0, 1, 0, 2]]);

    deliver(&mut env, P2pEvent::Closed);
    assert_eq!(env.env.ws.signals().last(), Some(&json!({ "t": "rtc-active", "on": false })));
    env.env.bridge.feed(&frame(T_KEY, b"k3"));
    assert_eq!(&env.env.ws.frames().last().unwrap()[5..], b"k3", "回到中继");
    assert_eq!(*env.env.bridge.stats().snapshot("h264").get("transport").unwrap(), json!("relay"));
}

#[test]
fn p2p_backlog_drops_deltas_and_closing_the_ws_closes_the_session() {
    let mut env = p2p_harness(H264Options { high_water: 1000, low_water: 100, ..h264_opts() });
    let direct = sink(&env);
    deliver(&mut env, P2pEvent::Open(direct));
    env.sink_backlog.store(0, Ordering::SeqCst);
    env.env.bridge.feed(&frame(T_KEY, b"k"));
    env.sink_backlog.store(5000, Ordering::SeqCst);
    env.env.bridge.feed(&frame(T_DELTA, b"d"));
    // 打开直连时的关键帧请求 + 这里有 key，所以只数实际发出的帧。
    assert_eq!(env.sink_sent.lock().unwrap().len(), 1);
    env.env.bridge.on_ws_closed();
    assert!(env.session_closed.load(Ordering::SeqCst));
}

// ── 线协议金样 ─────────────────────────────────────────────────────────
#[test]
fn wire_golden_fixture_bytes_are_the_encoding_of_their_own_fields() {
    let wire = wire_fixture();
    let be = |v: u64| (v as u32).to_be_bytes();
    for case in wire["clientToAgent"].as_array().unwrap() {
        let want: Vec<u8> = match case["kind"].as_str().unwrap() {
            "pointer" => {
                // 指针事件是定长 6 字节：类型 + 掩码 + 各 2 字节大端坐标
                let mut out = vec![5, case["mask"].as_u64().unwrap() as u8];
                out.extend_from_slice(&(case["x"].as_u64().unwrap() as u16).to_be_bytes());
                out.extend_from_slice(&(case["y"].as_u64().unwrap() as u16).to_be_bytes());
                out
            }
            "key" => {
                let keysym = case["keysym"].as_u64().unwrap();
                let mut out = vec![4, if case["down"].as_bool().unwrap() { 1 } else { 0 }, 0, 0];
                out.extend_from_slice(&be(keysym));
                out
            }
            _ => vec![REQ_KEY],
        };
        assert_eq!(hex(&want), case["hex"].as_str().unwrap(), "{}", case["name"]);
    }
    for case in wire["clientRateControlToAgent"].as_array().unwrap() {
        let value = if case["kind"] == json!("cap") {
            let mut out = vec![CAP_KBPS];
            out.extend_from_slice(&be(case["kbps"].as_u64().unwrap()));
            out
        } else {
            let mut out = vec![PING];
            out.extend_from_slice(&be(case["token"].as_u64().unwrap()));
            out
        };
        assert_eq!(hex(&value), case["hex"].as_str().unwrap(), "{}", case["name"]);
    }
    for case in wire["agentToClient"].as_array().unwrap() {
        let ty = case["type"].as_u64().unwrap() as u8;
        let payload = if ty == T_CONFIG || ty == T_PONG {
            unhex(case["payloadHex"].as_str().unwrap())
        } else {
            let mut out = case["pts"].as_u64().unwrap().to_be_bytes().to_vec();
            out.extend_from_slice(&unhex(case["annexBHex"].as_str().unwrap()));
            out
        };
        assert_eq!(hex(&frame(ty, &payload)), case["hex"].as_str().unwrap(), "{}", case["name"]);
        if ty == T_CONFIG {
            assert_eq!(serde_json::from_slice::<Value>(&payload).unwrap(), case["json"]);
        }
        if ty == T_PONG {
            assert_eq!(payload.len(), 8);
            assert_eq!(u32::from_be_bytes(payload[0..4].try_into().unwrap()) as u64, case["token"].as_u64().unwrap());
            assert_eq!(u32::from_be_bytes(payload[4..8].try_into().unwrap()) as u64, case["appliedKbps"].as_u64().unwrap());
        }
    }
    let types: Vec<u64> = wire["agentToClient"].as_array().unwrap().iter().map(|f| f["type"].as_u64().unwrap()).collect();
    assert_eq!(types, vec![1, 2, 3, 4]);
}

#[test]
fn wire_golden_bridge_forwards_every_client_message_byte_for_byte_and_nothing_else() {
    let wire = wire_fixture();
    let mut env = h264_harness(h264_opts());
    for group in ["clientToAgent", "clientRateControlToAgent"] {
        for case in wire[group].as_array().unwrap() {
            let bytes = unhex(case["hex"].as_str().unwrap());
            // 先把之前攒下的关键帧请求清掉，只看这一条的效果。
            agent_writes(&mut env);
            env.bridge.on_binary(&bytes);
            let writes: Vec<String> = agent_writes(&mut env).iter().map(|w| hex(w)).collect();
            assert_eq!(writes, vec![case["hex"].as_str().unwrap()], "{}", case["name"]);
        }
    }
    for case in wire["rejectedByBridge"].as_array().unwrap() {
        agent_writes(&mut env);
        env.bridge.on_binary(&unhex(case["hex"].as_str().unwrap()));
        assert!(agent_writes(&mut env).is_empty(), "{}: {}", case["name"], case["why"]);
    }
}

#[test]
fn wire_golden_agent_frames_reach_the_client_one_message_each_whatever_the_read_boundaries() {
    let wire = wire_fixture();
    let expected: Vec<String> = wire["agentToClient"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["hex"].as_str().unwrap().to_string())
        .collect();
    let mut stream = Vec::new();
    for case in wire["agentToClient"].as_array().unwrap() {
        stream.extend_from_slice(&unhex(case["hex"].as_str().unwrap()));
    }
    for cut in [1usize, 3, 7, 64] {
        let mut env = h264_harness(h264_opts());
        for chunk in stream.chunks(cut) {
            env.bridge.feed(chunk);
        }
        assert_eq!(env.ws.frame_hexes(), expected, "cut {cut}");
    }
}

// ── RFB 桥 ─────────────────────────────────────────────────────────────
async fn wait_until(mut check: impl FnMut() -> bool) {
    for _ in 0..200 {
        if check() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("等待超时");
}

#[tokio::test]
async fn rfb_pipes_bytes_both_ways_and_queues_pre_connect_messages() {
    let dir = temp_dir("rfb");
    let sock_path = dir.join("rfb.sock");
    let listener = tokio::net::UnixListener::bind(&sock_path).unwrap();
    let got = Arc::new(Mutex::new(Vec::new()));
    let got_task = got.clone();
    tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        // Agent 的版本串应原样透到浏览器端
        stream.write_all(b"RFB 003.008\n").await.unwrap();
        let mut buf = [0u8; 64];
        loop {
            match stream.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => got_task.lock().unwrap().extend_from_slice(&buf[..n]),
            }
        }
    });

    // 连接过程卡在闸门上：先塞进去的消息必须排队，不能丢。
    let gate = Arc::new(Notify::new());
    let connect: RfbConnector = {
        let gate = gate.clone();
        Arc::new(move |path| {
            let gate = gate.clone();
            Box::pin(async move {
                gate.notified().await;
                tokio::net::UnixStream::connect(path).await
            })
        })
    };
    let opts = RfbOptions { socket_path: Some(sock_path.clone()), ..Default::default() };
    let ws = FakeWs::new();
    let (tx, rx) = mpsc::unbounded_channel();
    tx.send(Incoming::Bin(Bytes::from_static(b"RFB 003.008\n"))).unwrap();
    let connecting = (connect)(sock_path.clone());
    let task = tokio::spawn(rfb::drive(ws.clone(), rx, connecting, opts));

    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(ws.frames().is_empty(), "连上之前不写 WS");
    gate.notify_one();

    wait_until(|| !ws.frames().is_empty() && !got.lock().unwrap().is_empty()).await;
    assert_eq!(String::from_utf8(ws.frames()[0].clone()).unwrap(), "RFB 003.008\n");
    assert_eq!(String::from_utf8(got.lock().unwrap().clone()).unwrap(), "RFB 003.008\n");

    tx.send(Incoming::Bin(Bytes::from_static(b"\x02\x00\x00\x00"))).unwrap();
    wait_until(|| got.lock().unwrap().len() >= 16).await;
    assert_eq!(String::from_utf8_lossy(&got.lock().unwrap().clone()).to_string(), "RFB 003.008\n\u{2}\u{0}\u{0}\u{0}");

    // 浏览器端断开 → 桥拆掉 unix socket（server 读到 EOF 退出）。
    drop(tx);
    let _ = tokio::time::timeout(Duration::from_secs(2), task).await;
}

#[tokio::test]
async fn rfb_closes_the_ws_with_1011_when_the_socket_is_unavailable() {
    let gate = Arc::new(Notify::new());
    let connect: RfbConnector = {
        let gate = gate.clone();
        Arc::new(move |_path| {
            let gate = gate.clone();
            Box::pin(async move {
                gate.notified().await;
                Err(std::io::Error::new(std::io::ErrorKind::NotFound, "missing"))
            })
        })
    };
    let opts = RfbOptions { socket_path: Some("/missing".into()), connect: connect.clone(), ..Default::default() };
    let ws = FakeWs::new();
    let (_tx, rx) = mpsc::unbounded_channel();
    let task = tokio::spawn(rfb::drive(ws.clone(), rx, (connect)("/missing".into()), opts));
    gate.notify_one();
    wait_until(|| ws.close_reason().is_some()).await;
    assert_eq!(ws.close_reason(), Some((1011, "rfb-unavailable".to_string())));
    let _ = tokio::time::timeout(Duration::from_secs(2), task).await;
}

#[tokio::test]
async fn rfb_applies_backpressure_without_dropping_or_reordering_bytes() {
    let dir = temp_dir("rfb-order");
    let sock_path = dir.join("rfb.sock");
    let listener = tokio::net::UnixListener::bind(&sock_path).unwrap();
    let got = Arc::new(Mutex::new(Vec::new()));
    let got_task = got.clone();
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        ready_tx.send(()).unwrap();
        let mut buf = [0u8; 64];
        loop {
            match stream.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => got_task.lock().unwrap().extend_from_slice(&buf[..n]),
            }
        }
    });
    let opts = RfbOptions { socket_path: Some(sock_path.clone()), ..Default::default() };
    let ws = FakeWs::new();
    let (tx, rx) = mpsc::unbounded_channel();
    let task = tokio::spawn(rfb::drive(ws.clone(), rx, (opts.connect)(sock_path.clone()), opts));
    ready_rx.await.unwrap();

    // 浏览器的每条消息都必须按序到 Agent，一条不丢。
    for i in 0..50u8 {
        tx.send(Incoming::Bin(Bytes::from(vec![i, 0, 0, 1, 5]))).unwrap();
    }
    wait_until(|| got.lock().unwrap().len() >= 250).await;
    let seen = got.lock().unwrap().clone();
    let expected: Vec<u8> = (0..50u8).flat_map(|i| [i, 0, 0, 1, 5]).collect();
    assert_eq!(seen, expected, "不丢、不乱序");

    // socket 端写 8 字节，浏览器端已积压 20（上限 24）→ 断开整条流，不跳片段。
    let blocked = FakeWs::new();
    blocked.set_buffered(20);
    let dir = temp_dir("rfb-overflow");
    let sock2 = dir.join("rfb.sock");
    let listener2 = tokio::net::UnixListener::bind(&sock2).unwrap();
    tokio::spawn(async move {
        let (mut stream, _) = listener2.accept().await.unwrap();
        stream.write_all(&[0u8; 8]).await.unwrap();
        tokio::time::sleep(Duration::from_secs(1)).await;
    });
    let opts = RfbOptions { socket_path: Some(sock2.clone()), max_buffered: 24, ..Default::default() };
    let (_tx2, rx2) = mpsc::unbounded_channel();
    let task2 = tokio::spawn(rfb::drive(blocked.clone(), rx2, (opts.connect)(sock2), opts));
    wait_until(|| blocked.close_reason().is_some()).await;
    assert_eq!(blocked.close_reason(), Some((1011, "rfb-backpressure".to_string())));
    assert!(blocked.frames().is_empty(), "不跳过片段、也不留一条坏掉的 RFB 连接");
    let _ = tokio::time::timeout(Duration::from_secs(2), task2).await;
    let _ = tokio::time::timeout(Duration::from_secs(2), task).await;
}

#[tokio::test]
async fn rfb_stall_watchdog_counts_screen_data_never_outgoing_input() {
    let dir = temp_dir("rfb-stall");
    let sock_path = dir.join("rfb.sock");
    let listener = tokio::net::UnixListener::bind(&sock_path).unwrap();
    tokio::spawn(async move {
        // 连上后什么都不发：画面流卡死。
        let (_stream, _) = listener.accept().await.unwrap();
        tokio::time::sleep(Duration::from_secs(2)).await;
    });
    let opts = RfbOptions {
        socket_path: Some(sock_path.clone()),
        timeout: Duration::from_millis(80),
        ..Default::default()
    };
    let ws = FakeWs::new();
    let (tx, rx) = mpsc::unbounded_channel();
    let task = tokio::spawn(rfb::drive(ws.clone(), rx, (opts.connect)(sock_path), opts));
    // 鼠标活动不能给一条已经停住的画面流续命。
    let pokes = tokio::spawn(async move {
        for _ in 0..20 {
            tokio::time::sleep(Duration::from_millis(10)).await;
            if tx.send(Incoming::Bin(Bytes::from_static(b"mouse"))).is_err() {
                break;
            }
        }
    });
    wait_until(|| ws.close_reason().is_some()).await;
    assert_eq!(ws.close_reason(), Some((1011, "rfb-stalled".to_string())));
    pokes.abort();
    let _ = tokio::time::timeout(Duration::from_secs(2), task).await;

    // 收到屏幕数据会重新上弦：没超过窗口就不该断。
    let dir = temp_dir("rfb-alive");
    let sock_path = dir.join("rfb.sock");
    let listener = tokio::net::UnixListener::bind(&sock_path).unwrap();
    tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        for _ in 0..6 {
            tokio::time::sleep(Duration::from_millis(30)).await;
            let _ = stream.write_all(&[0u8, 0, 0, 1, 5]).await;
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    });
    let opts = RfbOptions { socket_path: Some(sock_path.clone()), timeout: Duration::from_millis(150), ..Default::default() };
    let ws = FakeWs::new();
    let (_tx, rx) = mpsc::unbounded_channel();
    let task = tokio::spawn(rfb::drive(ws.clone(), rx, (opts.connect)(sock_path), opts));
    wait_until(|| ws.frames().len() >= 6).await;
    assert_eq!(ws.close_reason(), None);
    task.abort();
}
