'use strict';

const net = require('node:net');

// 「🖥 屏幕」高清流畅模式：Agent 的 h264.sock ⇄ /ws/remote-screen?mode=h264。
//
// 帧格式见 scripts/macos-agent/MultiCCAgentH264.swift 开头：[type u8][len u32 BE][payload]，
// type 1 = config(JSON) / 2 = 关键帧 / 3 = 普通帧 / 4 = pong(令牌 + 实际生效码率)。
// 这里按帧切分后每帧一条 WS 二进制消息原样转发（浏览器用同一份解析），同一套帧
// 以后也走 WebRTC DataChannel。
//
// 与 RFB 桥的区别：RFB 是不可丢的字节流，堵了只能断开重连；视频帧可以丢——
// 浏览器那头积压超过水位就丢普通帧、记下「欠关键帧」，等积压回落再向 Agent 要一个
// 关键帧（节流），画面从下一个关键帧继续，连接不断。pong 是控制消息，不走丢帧
// 规则，也不算「出过帧」：只有真正的视频帧才解除无首帧超时。
//
// 浏览器 → Agent 只放行五种定长消息：'K'（要关键帧）、'B' + kbps（该客户端的
// 码率上限，0 = 撤销）、'P' + token（ping，Agent 立刻回 pong）、RFB KeyEvent、
// RFB PointerEvent；输入在 Agent 侧走 rfbKey/rfbPointer，原有护栏（租约 / Esc 急停 /
// 锁屏 / 受保护 App）照旧。码率上限由 Agent 在所有客户端之间取最小值，这里只是
// 字节转发的白名单。
//
// 后端 Rust 规则（AGENTS.md）的例外说明：码率控制的逻辑全在 Swift Agent 与客户端，
// 这个 Node 桥只多放行 'B'/'P' 两种定长消息、直通 pong，不承载任何策略。远控桥整体
// 迁到 Rust 时，这两种消息和 pong 直通一并迁走。
//
// 传 p2p（见 remote-screen-p2p.js）时，这条 WS 同时是直连的信令通道：DataChannel 打通后
// 帧改走直连（先发 rtc-active 再切，浏览器据此丢弃 WS 上残余的帧），直连断了退回 WS。
// 每次切换都从关键帧重新开始。WS 断开则整条会话结束，直连一并关闭。

const T_CONFIG = 1;
const T_KEY = 2;
const T_DELTA = 3;
const T_PONG = 4;
const REQ_KEY = 0x4b;
const CAP_KBPS = 0x42;          // 'B' + kbps u32 BE
const PING = 0x50;              // 'P' + token u32 BE
const CLIENT_LENGTHS = new Map([[REQ_KEY, 1], [4, 8], [5, 6], [CAP_KBPS, 5], [PING, 5]]);

function attachH264Bridge(ws, {
  socketPath,
  connect = p => net.createConnection(p),
  highWater = 1024 * 1024,        // WS 积压超过它就丢普通帧
  lowWater = 256 * 1024,          // 积压回落到它以下才补要关键帧
  maxFrameBytes = 8 * 1024 * 1024,
  firstFrameTimeoutMs = 10000,    // 一直出不了首帧（旧 Agent / 没有屏幕录制授权）→ 断开让前端回退
  keyRequestIntervalMs = 500,
  now = () => Date.now(),
  p2p = null,                     // ({sendSignal,onOpen,onClose,onMessage}) => session
  p2pHello = null,                // 发给浏览器的 rtc-hello 附加字段（iceServers）
} = {}) {
  const sock = connect(socketPath);
  let buf = Buffer.alloc(0);
  let closed = false;
  let open = false;
  let sawFrame = false;
  let needKey = true;             // 解码器从关键帧起步
  let lastKeyRequest = -Infinity;
  const stats = { forwarded: 0, dropped: 0, keyRequests: 0, p2pOpened: 0, transport: 'relay' };
  const wsSink = {
    kind: 'relay',
    // 连接路由给每条 WS 装了背压层（ws-backpressure）：帧先进它的队列，
    // bufferedAmount 过了它的高水位就停着不往下送。只看 bufferedAmount 会漏掉
    // 队列里的几 MB —— 慢链路上帧只排队不丢，画面和光标越拖越旧。
    buffered: () => (ws.bufferedAmount || 0)
      + (ws._multiccBackpressure?.stats().queueBytes || 0),
    send: msg => ws.send(msg, { binary: true }, error => { if (error) die(); }),
  };
  let sink = wsSink;
  let session = null;

  const die = (reason = 'h264-unavailable', closeWs = true) => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    session?.close();
    sock.destroy();
    if (closeWs && ws.readyState === 1) {
      try { ws.close(1011, reason); } catch {}
    }
  };
  const timer = setTimeout(() => { if (!sawFrame) die('h264-no-frames'); }, firstFrameTimeoutMs);
  timer.unref?.();

  const toAgent = data => { if (open && !closed) sock.write(data); };
  const requestKey = force => {
    const t = now();
    if (!force && t - lastKeyRequest < keyRequestIntervalMs) return;
    lastKeyRequest = t;
    stats.keyRequests += 1;
    toAgent(Buffer.from([REQ_KEY]));
  };

  const forward = (type, msg) => {
    if (type === T_CONFIG) { send(msg); return; }
    // pong 是控制消息：永远直通，不参与丢帧/关键帧状态，也不算「已经出过帧」。
    if (type === T_PONG) { send(msg); return; }
    if (type !== T_KEY && type !== T_DELTA) return; // 未知类型：向前兼容，忽略
    sawFrame = true;
    const backlog = sink.buffered();
    if (type === T_DELTA && (needKey || backlog > highWater)) {
      stats.dropped += 1;
      needKey = true;
      if (backlog < lowWater) requestKey(false);
      return;
    }
    if (type === T_KEY && backlog > highWater * 2) {
      // 关键帧也塞不进去：链路是真的窄。丢掉，等积压回落再要。
      stats.dropped += 1;
      needKey = true;
      return;
    }
    if (type === T_KEY) needKey = false;
    send(msg);
  };
  const send = msg => {
    try {
      sink.send(msg);
      stats.forwarded += 1;
    } catch {
      if (sink === wsSink) die(); else useSink(wsSink);
    }
  };
  const signal = obj => {
    if (closed || ws.readyState !== 1) return;
    try { ws.send(JSON.stringify(obj)); } catch { die(); }
  };
  // 切换通道：先在 WS 上发 rtc-active（排在 WS 已发帧之后），再换出口并要关键帧。
  const useSink = next => {
    if (closed || sink === next) return;
    signal({ t: 'rtc-active', on: next !== wsSink });
    sink = next;
    stats.transport = next.kind;
    needKey = true;
    requestKey(true);
  };
  const fromBrowser = b => {
    if (!b.length || CLIENT_LENGTHS.get(b[0]) !== b.length) return;
    if (b[0] === REQ_KEY) { needKey = true; requestKey(true); return; }
    toAgent(b);
  };

  sock.on('connect', () => { if (!closed) open = true; });
  sock.on('data', chunk => {
    if (closed) return;
    if (ws.readyState !== 1) return die();
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 5) {
      const type = buf[0];
      const len = buf.readUInt32BE(1);
      if (len > maxFrameBytes) return die('h264-bad-frame');
      if (buf.length < 5 + len) break;
      // 拷贝出独立的一帧：subarray 会让整块接收缓冲随 WS 发送队列一起滞留。
      const msg = Buffer.from(buf.subarray(0, 5 + len));
      buf = buf.subarray(5 + len);
      forward(type, msg);
    }
  });
  sock.on('error', () => die());
  sock.on('close', () => die());

  ws.on('message', (data, isBinary) => {
    if (closed) return;
    if (isBinary === false) {
      if (!session || data.length > 80 * 1024) return;
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      session.handleSignal(msg);
      return;
    }
    fromBrowser(Buffer.isBuffer(data) ? data : Buffer.from(data));
  });
  if (p2p) {
    try {
      session = p2p({
        sendSignal: signal,
        onOpen: next => { stats.p2pOpened += 1; useSink(next); },
        onClose: () => useSink(wsSink),
        onMessage: b => { if (!closed) fromBrowser(b); },
      });
    } catch { session = null; }
    if (session) signal({ t: 'rtc-hello', ...(p2pHello || {}) });
  }
  ws.on('close', () => die('h264-unavailable', false));
  ws.on('error', () => die());
  // 积压回落后补要关键帧：屏幕静止时 Agent 不出帧，forward 里的补要就等不来。
  const drainPoll = setInterval(() => {
    if (closed) { clearInterval(drainPoll); return; }
    if (needKey && sawFrame && sink.buffered() < lowWater) requestKey(false);
  }, keyRequestIntervalMs);
  drainPoll.unref?.();

  return { stats, close: () => die() };
}

module.exports = { attachH264Bridge, T_CONFIG, T_KEY, T_DELTA, T_PONG, REQ_KEY, CAP_KBPS, PING };
