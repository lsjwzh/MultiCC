#!/usr/bin/env node
'use strict';

// 「🖥 屏幕」H.264 转发基线/回归测量。
//
//   node scripts/benchmark-remote-screen.js [--json out.json] [--seconds 20]
//        [--warmup 3] [--runs 1] [--profiles realistic,stress]
//        [--transports relay,p2p] [--repo <dir>] [--help]
//
// 测什么：一个隔离的 server.js（临时数据目录、临时 Agent socket、假 Agent 持续
// 推 H.264 帧）在两种负载 × 两种传输下的转发成本：
//   · server 进程的事件循环延迟 p50/p99/max（perf_hooks.monitorEventLoopDelay,
//     resolution 10ms；用 -r 预加载脚本注入，不改源码）；
//   · server 进程及其所有子孙进程的 %CPU / RSS（每 500ms 一次 ps 采样）；
//   · 客户端实收帧数 / fps / 字节 / Mbps，以及逐字节抽检。
//
// 约束（迁移后原样可跑）：
//   · 不 import src/remote-screen-*.js，也不读它的内部状态；只走
//     HTTP（/readyz、/api/auth/ws-ticket）与 WS（/ws/remote-screen?mode=h264）。
//   · 假 Agent 用 MULTICC_AGENT_SOCK / MULTICC_AGENT_H264_SOCK /
//     MULTICC_AGENT_RFB_SOCK 指过去（见 src/desktop-host.js，Rust 进程也继承
//     这些覆盖项）；MULTICC_AGENT_AUTO_INSTALL=0，绝不碰本机真 Agent。
//   · p2p 用 werift 当浏览器端（与 App/网页同一条信令：rtc-hello / rtc-offer /
//     rtc-answer / 双向 rtc-ice / rtc-active），MULTICC_REMOTE_STUN= 空串只用
//     本机候选。
//
// 帧格式（Agent → 服务端）：[type u8][len u32 BE][payload]
//   1 = config(JSON), 2 = key, 3 = delta, 4 = pong。payload 前 4 字节放帧序号
//   （大端），其余是确定性伪随机字节：客户端按序号重算即可逐字节核对。
//
// 输出：stdout 一张表 + --json 指定的 JSON（含每次运行的原始数字）。

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile, execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const T_CONFIG = 1;
const T_KEY = 2;
const T_DELTA = 3;
const T_PONG = 4;
const REQ_KEY = 0x4b;
const CAP_KBPS = 0x42;
const PING = 0x50;
const WS_PATH = '/ws/remote-screen';

const PROFILES = {
  realistic: { fps: 30, deltaBytes: 14 * 1024, keyBytes: 60 * 1024, keyEverySec: 2 },
  stress: { fps: 60, deltaBytes: 60 * 1024, keyBytes: 200 * 1024, keyEverySec: 2 },
};

// ── 假 Agent 用同一份文件以子进程方式启动（--fake-agent）────────────────────

const PATTERN_BYTES = 64;

function patternFor(seq) {
  const p = Buffer.allocUnsafe(PATTERN_BYTES);
  let x = (Math.imul(seq >>> 0, 2654435761) + 0x9e3779b9) >>> 0;
  for (let i = 0; i < PATTERN_BYTES; i += 1) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    p[i] = x >>> 24;
  }
  return p;
}

// 发送端与校验端必须得到完全相同的字节。
function makeFramePayload(seq, len) {
  const buf = Buffer.allocUnsafe(len);
  const pat = patternFor(seq);
  for (let off = 0; off < len; off += PATTERN_BYTES) {
    pat.copy(buf, off, 0, Math.min(PATTERN_BYTES, len - off));
  }
  if (len >= 4) buf.writeUInt32BE(seq >>> 0, 0);
  return buf;
}

function frameOf(type, payload) {
  const out = Buffer.allocUnsafe(5 + payload.length);
  out[0] = type;
  out.writeUInt32BE(payload.length, 1);
  payload.copy(out, 5);
  return out;
}

function listenUnix(server, file) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(file, () => resolve(server));
  });
}

function fakeAgentMain() {
  const cfg = JSON.parse(process.env.RS_FAKE || '{}');
  const stats = { sent: 0, skipped: 0, bytes: 0, keys: 0, deltas: 0, connections: 0 };
  const sockets = new Set();
  let statsWritten = false;
  const writeStats = () => {
    if (statsWritten) return;
    statsWritten = true;
    try { fs.writeFileSync(cfg.statsFile, JSON.stringify(stats)); } catch {}
  };

  // agent.sock：一行 JSON 请求 / 一行 JSON 响应（status / ping 是服务端会用到的）。
  const agent = net.createServer(sock => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => {});
    let buf = '';
    sock.on('data', chunk => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let req = {};
        try { req = JSON.parse(line); } catch {}
        const reply = req.op === 'status'
          ? { ok: true, version: '3', accessibility: true, screenRecording: true, postEvents: true,
            screenLocked: false, control: { halted: false } }
          : req.op === 'ping' ? { ok: true, version: '3' } : { ok: false, error: 'fake-agent' };
        if (!sock.destroyed) sock.write(`${JSON.stringify(reply)}\n`);
        sock.end();
      }
    });
  });

  // h264.sock：连接即发 config，之后按固定帧率持续推帧；'P' ping 回 pong。
  const stream = net.createServer(sock => {
    sockets.add(sock);
    stats.connections += 1;
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => {});
    const config = frameOf(T_CONFIG, Buffer.from(JSON.stringify({
      codec: 'avc1.42001f', width: 1280, height: 720, inputWidth: 1280, inputHeight: 720,
    })));
    sock.write(config);

    let pending = Buffer.alloc(0);
    let capKbps = 0;
    sock.on('data', chunk => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length) {
        const type = pending[0];
        const need = type === 5 ? 6 : type === 4 ? 8 : type === CAP_KBPS || type === PING ? 5 : 1;
        if (pending.length < need) break;
        const msg = pending.subarray(0, need);
        pending = pending.subarray(need);
        if (msg[0] === CAP_KBPS) capKbps = msg.readUInt32BE(1);
        else if (msg[0] === PING) {
          const payload = Buffer.alloc(8);
          payload.writeUInt32BE(msg.readUInt32BE(1), 0);
          payload.writeUInt32BE(capKbps, 4);
          if (!sock.destroyed) sock.write(frameOf(T_PONG, payload));
        }
        // 'K' 关键帧请求：本假 Agent 固定每 2 秒一个关键帧，不需要额外处理。
      }
    });

    const keyEvery = Math.max(1, Math.round(cfg.fps * cfg.keyEverySec));
    const frameMs = 1000 / cfg.fps;
    let seq = 0;
    let skipNext = false;
    let stopped = false;
    let timer = null;
    // 自己按绝对时刻排下一次：setInterval(16.67ms) 在 Node 上只有 ~57fps。
    let nextAt = performance.now() + frameMs;
    const schedule = () => {
      if (stopped || sock.destroyed) return;
      timer = setTimeout(tick, Math.max(0, nextAt - performance.now()));
    };
    const tick = () => {
      timer = null;
      if (stopped || sock.destroyed) return;
      if (skipNext) {
        skipNext = false;
        stats.skipped += 1;
      } else {
        const isKey = seq % keyEvery === 0;
        const len = isKey ? cfg.keyBytes : cfg.deltaBytes;
        const frame = frameOf(isKey ? T_KEY : T_DELTA, makeFramePayload(seq, len));
        const ok = sock.write(frame);
        stats.sent += 1;
        stats.bytes += frame.length;
        if (isKey) stats.keys += 1; else stats.deltas += 1;
        seq += 1;
        // 写端积压时不无限排队：跳过下一帧（真 Agent 也是丢普通帧）。
        if (!ok) skipNext = true;
      }
      nextAt += frameMs;
      // 卡顿之后不要用突发把欠的帧全补回来。
      if (nextAt < performance.now()) nextAt = performance.now();
      schedule();
    };
    schedule();
    sock.on('close', () => { stopped = true; if (timer) clearTimeout(timer); });
  });

  const shutdown = () => {
    writeStats();
    for (const s of sockets) s.destroy();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('exit', writeStats);

  (async () => {
    await listenUnix(agent, path.join(cfg.dir, 'agent.sock'));
    await listenUnix(stream, path.join(cfg.dir, 'h264.sock'));
    process.stdout.write(`${JSON.stringify({ ready: true })}\n`);
  })().catch(error => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exit(1);
  });
}

// ── 预加载脚本：事件循环延迟 ────────────────────────────────────────────────

function writePreload() {
  const file = path.join(os.tmpdir(), `rs-bench-loop-${process.pid}.js`);
  fs.writeFileSync(file, `'use strict';
const { monitorEventLoopDelay } = require('node:perf_hooks');
const fs = require('node:fs');
const histogram = monitorEventLoopDelay({ resolution: 10 });
histogram.enable();
const out = process.env.RS_LOOP_STATS_FILE;
function snapshot() {
  return {
    p50: histogram.percentile(50) / 1e6,
    p99: histogram.percentile(99) / 1e6,
    max: histogram.max / 1e6,
    mean: histogram.mean / 1e6,
    count: histogram.count,
  };
}
function flush() {
  if (!out) return;
  try {
    const temporary = out + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(snapshot()));
    fs.renameSync(temporary, out);
  } catch {}
}
// SIGUSR2 = 从这一刻重新计时（预热结束）；每 250ms 落一次累计直方图。
process.on('SIGUSR2', () => { histogram.reset(); flush(); });
setInterval(flush, 250).unref();
flush();
`);
  return file;
}

// ── 小工具 ──────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function selectRustAddon() {
  try {
    const { ensureSourceRust } = require('./ensure-source-rust');
    return ensureSourceRust({ log: () => {} }) || undefined;
  } catch (error) {
    process.stderr.write(`[bench] Rust addon selection failed, continuing without MULTICC_RUST_ADDON: ${error.message}\n`);
    return undefined;
  }
}

function gitHead(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000 }).trim();
  } catch { return null; }
}

// ── 假 Agent 子进程 ─────────────────────────────────────────────────────────

async function startFakeAgent({ dir, fps, deltaBytes, keyBytes, keyEverySec, statsFile }) {
  const child = spawn(process.execPath, [__filename, '--fake-agent'], {
    env: {
      ...process.env,
      RS_FAKE: JSON.stringify({ dir, fps, deltaBytes, keyBytes, keyEverySec, statsFile }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', chunk => { log = (log + chunk).slice(-4000); });
  child.stderr.on('data', chunk => { log += chunk; });
  child.on('exit', code => { log += `\n[fake-agent exited ${code}]`; });
  for (let i = 0; i < 100; i += 1) {
    if (child.exitCode !== null) throw new Error(`fake agent exited early (${child.exitCode}):\n${log}`);
    if (log.includes('"ready":true')) return child;
    await sleep(50);
  }
  child.kill('SIGKILL');
  throw new Error(`fake agent not ready:\n${log}`);
}

async function stopChild(child, signal = 'SIGTERM', timeoutMs = 4000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill(signal);
  await Promise.race([exited, sleep(timeoutMs)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

// ── 被测 server ─────────────────────────────────────────────────────────────

async function startServer({ port, token, dataDir, agentDir, rustAddon, loopFile, preload }) {
  // 隔离 HOME：登录 shell 会自己补 PATH，光改 PATH 挡不住 provider 运行时去
  // ~/.local/bin 找 CLI 并拉起与远控无关的子进程；空 HOME 让这些探测找不到东西。
  const home = path.join(path.dirname(dataDir), 'home');
  fs.mkdirSync(home, { recursive: true });
  const child = spawn(process.execPath, ['-r', preload, 'server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_CACHE_HOME: path.join(home, '.cache'),
      NODE_ENV: 'test',
      PORT: String(port),
      ACCESS_TOKEN: token,
      MULTICC_DATA_DIR: dataDir,
      MULTICC_AGENT_DIR: agentDir,
      MULTICC_AGENT_SOCK: path.join(agentDir, 'agent.sock'),
      MULTICC_AGENT_H264_SOCK: path.join(agentDir, 'h264.sock'),
      MULTICC_AGENT_RFB_SOCK: path.join(agentDir, 'rfb.sock'),
      MULTICC_AGENT_AUTO_INSTALL: '0',
      MULTICC_REMOTE_STUN: '',
      MULTICC_ORCHESTRATION_WORKER_INTERVAL_MS: '60000',
      RS_LOOP_STATS_FILE: loopFile,
      // 只留系统目录：隔离实例因此找不到 claude/codex/qoder/zcode 这些 CLI，
      // 启动时就不会顺带拉起与远控无关的模型探测子进程，CPU/RSS 采样才干净。
      // 远控本身只需要 h264.sock，不依赖任何 CLI。
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      ...(rustAddon ? { MULTICC_RUST_ADDON: rustAddon } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  const collect = chunk => { log = (log + chunk).slice(-8000); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 400; i += 1) {
    if (child.exitCode !== null) throw new Error(`server.js exited early (${child.exitCode}):\n${log}`);
    try {
      if ((await fetch(`${base}/readyz`)).status === 200) return { child, base, port, log: () => log };
    } catch {}
    await sleep(100);
  }
  child.kill('SIGKILL');
  throw new Error(`server.js not ready after 40s:\n${log}`);
}

// ── 鉴权票据 ────────────────────────────────────────────────────────────────

async function issueWsTicket(base) {
  const response = await fetch(`${base}/api/auth/ws-ticket`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: WS_PATH }),
  });
  if (!response.ok) throw new Error(`ws-ticket ${response.status}: ${await response.text()}`);
  const body = await response.json();
  if (!body || typeof body.ticket !== 'string') throw new Error(`ws-ticket response: ${JSON.stringify(body)}`);
  return body.ticket;
}

// ── 客户端 ──────────────────────────────────────────────────────────────────

class FrameSink {
  constructor(transport) {
    this.transport = transport;
    this.recording = false;
    this.frames = 0;
    this.bytes = 0;
    this.minSeq = Infinity;
    this.maxSeq = -1;
    this.seen = new Set();
    this.checked = 0;
    this.mismatches = 0;
    this.badHeaders = 0;
    this.configFrames = 0;
    this.pongs = 0;
    this.otherFrames = 0;
    this.chunks = Buffer.alloc(0);
    this.firstFrameAt = null;
  }

  onData(data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (this.transport === 'relay') {
      this.onFrame(buf);
      return;
    }
    // DataChannel 上是字节流：按 5 字节头拼回整帧。
    this.chunks = this.chunks.length ? Buffer.concat([this.chunks, buf]) : buf;
    while (this.chunks.length >= 5) {
      const len = this.chunks.readUInt32BE(1);
      if (len > 16 * 1024 * 1024) { this.badHeaders += 1; this.chunks = Buffer.alloc(0); return; }
      if (this.chunks.length < 5 + len) break;
      const frame = this.chunks.subarray(0, 5 + len);
      this.chunks = this.chunks.subarray(5 + len);
      this.onFrame(frame);
    }
  }

  onFrame(frame) {
    if (frame.length < 5) { this.badHeaders += 1; return; }
    const type = frame[0];
    const len = frame.readUInt32BE(1);
    if (len + 5 !== frame.length) { this.badHeaders += 1; return; }
    if (type === T_CONFIG) { this.configFrames += 1; return; }
    if (type === T_PONG) { this.pongs += 1; return; }
    if (type !== T_KEY && type !== T_DELTA) { this.otherFrames += 1; return; }
    this.firstFrameAt = this.firstFrameAt || Date.now();
    if (!this.recording) return;
    const payload = frame.subarray(5);
    if (payload.length < 4) { this.badHeaders += 1; return; }
    const seq = payload.readUInt32BE(0);
    this.frames += 1;
    this.bytes += frame.length;
    if (seq < this.minSeq) this.minSeq = seq;
    if (seq > this.maxSeq) this.maxSeq = seq;
    this.seen.add(seq);
    // 抽检：开头 3 帧 + 每 421 帧一帧，最多 50 帧，逐字节比对。
    if (this.checked < 50 && (this.checked < 3 || seq % 421 === 0)) {
      const expected = makeFramePayload(seq, len);
      if (!expected.equals(payload)) this.mismatches += 1;
      this.checked += 1;
    }
  }

  missing() {
    if (this.maxSeq < 0) return 0;
    return Math.max(0, this.maxSeq - this.minSeq + 1 - this.seen.size);
  }
}

function openWs(url) {
  const WebSocket = require('ws');
  const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 32 * 1024 * 1024 });
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

async function runRelayClient({ port, ticket, sink }) {
  const ws = await openWs(`ws://127.0.0.1:${port}${WS_PATH}?mode=h264&ticket=${encodeURIComponent(ticket)}`);
  ws.on('message', (data, isBinary) => {
    if (!isBinary) return; // rtc-hello 之类文本信令：relay 模式忽略
    sink.onData(data);
  });
  return {
    kind: 'relay',
    close: () => new Promise(resolve => {
      if (ws.readyState === 3) return resolve();
      ws.once('close', resolve);
      try { ws.close(); } catch { resolve(); }
      setTimeout(resolve, 2000).unref?.();
    }),
  };
}

async function runP2pClient({ port, ticket, sink }) {
  const werift = require('werift');
  const ws = await openWs(`ws://127.0.0.1:${port}${WS_PATH}?mode=h264&ticket=${encodeURIComponent(ticket)}`);
  const pc = new werift.RTCPeerConnection({ iceServers: [] });
  const channel = pc.createDataChannel('screen', { ordered: true });
  const pendingCandidates = [];
  let remoteSet = false;
  let active = false;
  let activeResolve;
  const activePromise = new Promise(resolve => { activeResolve = resolve; });
  let dcOpen = false;

  const close = () => new Promise(resolve => {
    try { pc.close().catch?.(() => {}); } catch {}
    if (ws.readyState === 3) return resolve();
    ws.once('close', resolve);
    try { ws.close(); } catch { resolve(); }
    setTimeout(resolve, 2000).unref?.();
  });

  pc.onIceCandidate.subscribe(candidate => {
    if (!candidate) return;
    const json = typeof candidate.toJSON === 'function' ? candidate.toJSON() : candidate;
    try { ws.send(JSON.stringify({ t: 'rtc-ice', candidate: json })); } catch {}
  });
  channel.onMessage.subscribe(data => sink.onData(Buffer.isBuffer(data) ? data : Buffer.from(data)));
  channel.stateChanged.subscribe(state => { if (state === 'open') dcOpen = true; });

  ws.on('message', async (data, isBinary) => {
    if (isBinary) return;
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    try {
      if (msg.t === 'rtc-hello') {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        ws.send(JSON.stringify({ t: 'rtc-offer', sdp: pc.localDescription.sdp }));
      } else if (msg.t === 'rtc-answer') {
        await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
        remoteSet = true;
        for (const candidate of pendingCandidates) pc.addIceCandidate(candidate).catch(() => {});
        pendingCandidates.length = 0;
      } else if (msg.t === 'rtc-ice') {
        if (remoteSet) pc.addIceCandidate(msg.candidate).catch(() => {});
        else pendingCandidates.push(msg.candidate);
      } else if (msg.t === 'rtc-active' && msg.on === true) {
        active = true;
        activeResolve();
      }
    } catch (error) {
      process.stderr.write(`[bench] p2p signaling error: ${error.message}\n`);
    }
  });

  await Promise.race([
    activePromise,
    sleep(15000).then(() => { throw new Error(`p2p did not become active (dcOpen=${dcOpen}, remoteSet=${remoteSet})`); }),
  ]);
  return { kind: 'p2p', close };
}

// ── 进程树采样 ──────────────────────────────────────────────────────────────

function psSnapshot(rootPid) {
  return new Promise(resolve => {
    execFile('/bin/ps', ['-ax', '-o', 'pid=,ppid=,%cpu=,rss=,comm='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 5000 },
      (error, stdout) => {
        if (error || !stdout) return resolve([]);
        const procs = new Map();
        for (const line of stdout.split('\n')) {
          const match = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/.exec(line);
          if (!match) continue;
          procs.set(Number(match[1]), { pid: Number(match[1]), ppid: Number(match[2]),
            cpu: Number(match[3]), rss: Number(match[4]), comm: match[5].trim() });
        }
        const children = new Map();
        for (const proc of procs.values()) {
          if (!children.has(proc.ppid)) children.set(proc.ppid, []);
          children.get(proc.ppid).push(proc.pid);
        }
        const tree = [];
        const stack = [rootPid];
        const visited = new Set();
        while (stack.length) {
          const pid = stack.pop();
          if (visited.has(pid)) continue;
          visited.add(pid);
          const proc = procs.get(pid);
          if (!proc) continue;
          tree.push(proc);
          for (const child of children.get(pid) || []) stack.push(child);
        }
        resolve(tree);
      });
  });
}

function startCpuSampler(rootPid, intervalMs = 500) {
  const samples = [];
  let busy = false;
  let timer = null;
  const sample = async () => {
    if (busy) return;
    busy = true;
    try {
      const tree = await psSnapshot(rootPid);
      if (tree.length) samples.push(tree);
    } finally { busy = false; }
  };
  timer = setInterval(sample, intervalMs);
  sample();
  return {
    async stop() {
      clearInterval(timer);
      await sample();
      return samples;
    },
  };
}

function aggregateCpu(samples, rootPid) {
  const perProcess = new Map();
  let serverSum = 0;
  let childSum = 0;
  let remoteChildSum = 0;
  let peakRssKb = 0;
  let serverPeakRssKb = 0;
  let remoteChildPeakRssKb = 0;
  let usable = 0;
  // 迁移后远控进程叫 multicc-remote；Node 基线里没有这个子进程。
  const remoteName = /^multicc-remote(\.exe)?$/;
  for (const tree of samples) {
    usable += 1;
    let serverCpu = 0;
    let childCpu = 0;
    let rssKb = 0;
    for (const proc of tree) {
      const name = path.basename(proc.comm) || proc.comm;
      const isRoot = proc.pid === rootPid;
      const isRemote = remoteName.test(name);
      if (isRoot) {
        serverCpu += proc.cpu;
        serverPeakRssKb = Math.max(serverPeakRssKb, proc.rss);
      } else {
        childCpu += proc.cpu;
        if (isRemote) {
          remoteChildSum += proc.cpu;
          remoteChildPeakRssKb = Math.max(remoteChildPeakRssKb, proc.rss);
        }
      }
      rssKb += proc.rss;
      const key = `${isRoot ? 'server' : 'child'}:${name}`;
      const record = perProcess.get(key) || { role: isRoot ? 'server' : 'child', comm: name, cpuSum: 0, samples: 0, peakRssKb: 0 };
      record.cpuSum += proc.cpu;
      record.samples += 1;
      record.peakRssKb = Math.max(record.peakRssKb, proc.rss);
      perProcess.set(key, record);
    }
    serverSum += serverCpu;
    childSum += childCpu;
    peakRssKb = Math.max(peakRssKb, rssKb);
  }
  const n = usable || 1;
  return {
    samples: usable,
    serverAvg: serverSum / n,
    childAvg: childSum / n,
    remoteChildAvg: remoteChildSum / n,
    totalAvg: (serverSum + childSum) / n,
    serverPeakRssMB: serverPeakRssKb / 1024,
    remoteChildPeakRssMB: remoteChildPeakRssKb / 1024,
    peakRssMB: peakRssKb / 1024,
    processes: [...perProcess.values()].map(record => ({
      role: record.role,
      comm: record.comm,
      cpuAvg: record.cpuSum / record.samples,
      peakRssMB: record.peakRssKb / 1024,
    })),
  };
}

// ── 单次组合 ────────────────────────────────────────────────────────────────

async function runCombination({ profileName, transport, run, seconds, warmupSeconds, settleSeconds, preload }) {
  const profile = PROFILES[profileName];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-bench-'));
  const dataDir = path.join(root, 'data');
  const agentDir = path.join(root, 'agent');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  const loopFile = path.join(root, 'loop.json');
  const agentStatsFile = path.join(root, 'agent-stats.json');
  const token = crypto.randomBytes(16).toString('hex');

  let agent = null;
  let server = null;
  let client = null;
  let sampler = null;
  try {
    agent = await startFakeAgent({ dir: agentDir, ...profile, statsFile: agentStatsFile });
    const rustAddon = selectRustAddon();
    // freePort 关掉探测口到 server listen 之间有竞态；撞上 EADDRINUSE 就换个口重来。
    let attempt = 0;
    for (;;) {
      const port = await freePort();
      try {
        server = await startServer({ port, token, dataDir, agentDir, rustAddon, loopFile, preload });
        break;
      } catch (error) {
        attempt += 1;
        if (attempt >= 5 || !/EADDRINUSE/.test(error.message)) throw error;
      }
    }
    const port = server.port;
    // 静置：隔离实例启动时会顺带做与远控无关的后台工作（模型目录刷新、CLI 探测），
    // 它们会在几秒内拉起一堆吃 CPU 的子进程。等它们安静下来再开始连客户端，
    // 否则「子孙进程 CPU」测到的是它们，不是远控转发层。
    if (settleSeconds > 0) await sleep(settleSeconds * 1000);

    const ticket = await issueWsTicket(server.base);
    const sink = new FrameSink(transport);
    client = transport === 'p2p'
      ? await runP2pClient({ port, ticket, sink })
      : await runRelayClient({ port, ticket, sink });

    // 预热：等第一帧（最多 10 秒）再计 3 秒，让桥、编码参数和直连切换都稳定下来。
    const deadline = Date.now() + 10000;
    while (!sink.firstFrameAt && Date.now() < deadline) await sleep(50);
    await sleep(warmupSeconds * 1000);

    // 从这一刻开始算事件循环延迟与 CPU。
    try { server.child.kill('SIGUSR2'); } catch {}
    sink.recording = true;
    sampler = startCpuSampler(server.child.pid, 500);
    const startedAt = process.hrtime.bigint();
    await sleep(seconds * 1000);
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    sink.recording = false;
    const cpu = aggregateCpu(await sampler.stop(), server.child.pid);
    sampler = null;
    await sleep(300); // 等预加载脚本最后一次 250ms 落盘
    const loop = readJson(loopFile);

    const elapsedSec = elapsedMs / 1000;
    const result = {
      profile: profileName,
      transport,
      run,
      offered: {
        fps: profile.fps,
        deltaBytes: profile.deltaBytes,
        keyBytes: profile.keyBytes,
        keyEverySec: profile.keyEverySec,
        mbps: profile.fps * (((profile.fps * profile.keyEverySec - 1) * profile.deltaBytes + profile.keyBytes)
          / (profile.fps * profile.keyEverySec)) * 8 / 1e6,
      },
      durationSec: elapsedSec,
      frames: sink.frames,
      bytes: sink.bytes,
      fps: sink.frames / elapsedSec,
      mbps: (sink.bytes * 8) / elapsedSec / 1e6,
      missingSeq: sink.missing(),
      byteChecks: sink.checked,
      byteMismatches: sink.mismatches,
      badHeaders: sink.badHeaders,
      configFrames: sink.configFrames,
      pongs: sink.pongs,
      otherFrames: sink.otherFrames,
      loop,
      cpu,
    };

    if (client) await client.close().catch(() => {});
    client = null;
    await stopChild(server.child);
    server = null;
    await stopChild(agent);
    const agentStats = readJson(agentStatsFile);
    agent = null;
    result.agent = agentStats;
    return result;
  } finally {
    if (sampler) await sampler.stop().catch(() => {});
    if (client) await client.close().catch(() => {});
    if (server) await stopChild(server.child);
    if (agent) await stopChild(agent);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ── 输出 ────────────────────────────────────────────────────────────────────

function pad(value, width, right = false) {
  const text = String(value);
  return right ? text.padStart(width) : text.padEnd(width);
}

function printHeader() {
  process.stdout.write([
    pad('combo', 20), pad('run', 4, true), pad('loopP50', 8, true), pad('loopP99', 8, true), pad('loopMax', 8, true),
    pad('srvCPU%', 8, true), pad('descCPU%', 9, true), pad('rsCPU%', 8, true), pad('totCPU%', 8, true),
    pad('srvRSS', 8, true), pad('treeRSS', 8, true),
    pad('fps', 7, true), pad('Mbps', 7, true), pad('missing', 8, true), pad('byteChk', 8, true),
  ].join(' ') + '\n');
}

function printRow(result) {
  if (result.error) {
    process.stdout.write(`${pad(`${result.profile}/${result.transport}`, 20)} ${pad(`#${result.run}`, 3, true)}  ERROR: ${result.error}\n`);
    return;
  }
  const loop = result.loop || {};
  const milli = value => (typeof value === 'number' && Number.isFinite(value) ? value.toFixed(1) : '-');
  process.stdout.write([
    pad(`${result.profile}/${result.transport}`, 20), pad(`#${result.run}`, 4, true),
    pad(milli(loop.p50), 8, true), pad(milli(loop.p99), 8, true), pad(milli(loop.max), 8, true),
    pad(result.cpu.serverAvg.toFixed(1), 8, true), pad(result.cpu.childAvg.toFixed(1), 9, true),
    pad(result.cpu.remoteChildAvg.toFixed(1), 8, true), pad(result.cpu.totalAvg.toFixed(1), 8, true),
    pad(result.cpu.serverPeakRssMB.toFixed(0), 8, true), pad(result.cpu.peakRssMB.toFixed(0), 8, true),
    pad(result.fps.toFixed(1), 7, true), pad(result.mbps.toFixed(2), 7, true),
    pad(result.missingSeq, 8, true), pad(`${result.byteChecks}/${result.byteMismatches}`, 8, true),
  ].join(' ') + '\n');
}

// ── 参数 ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const options = {
    json: null,
    seconds: 20,
    warmupSeconds: 3,
    runs: 1,
    settleSeconds: 20,
    profiles: Object.keys(PROFILES),
    transports: ['relay', 'p2p'],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    if (arg === '--json') options.json = path.resolve(next());
    else if (arg === '--seconds') options.seconds = Number(next());
    else if (arg === '--warmup') options.warmupSeconds = Number(next());
    else if (arg === '--settle') options.settleSeconds = Number(next());
    else if (arg === '--runs') options.runs = Math.max(1, Number(next()));
    else if (arg === '--profiles') options.profiles = next().split(',').map(s => s.trim()).filter(Boolean);
    else if (arg === '--transports') options.transports = next().split(',').map(s => s.trim()).filter(Boolean);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  for (const profile of options.profiles) if (!PROFILES[profile]) throw new Error(`unknown profile: ${profile}`);
  for (const transport of options.transports) {
    if (transport !== 'relay' && transport !== 'p2p') throw new Error(`unknown transport: ${transport}`);
  }
  if (!(options.seconds > 0)) throw new Error('--seconds must be > 0');
  return options;
}

function usage() {
  process.stdout.write(`Usage: node scripts/benchmark-remote-screen.js [options]

  --json <file>        also write the raw results as JSON
  --seconds <n>        measurement window per combination (default 20)
  --warmup <n>         warmup seconds before measuring (default 3)
  --settle <n>         idle seconds after server start before connecting (default 20)
                       (lets the isolated instance's unrelated boot-time background
                       work finish, so descendant CPU is not misattributed)
  --runs <n>           repeat every combination n times (default 1)
  --profiles <list>    realistic,stress (default both)
  --transports <list>  relay,p2p (default both)

Load: realistic = 30fps / ~4 Mbps, stress = 60fps / ~30 Mbps.
`);
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  if (process.argv.includes('--fake-agent')) return fakeAgentMain();

  const options = parseArgs(process.argv.slice(2));
  if (options.help) return usage();

  const preload = writePreload();
  const startedAt = new Date();
  const results = [];
  process.stdout.write(`remote-screen benchmark | node ${process.version} | ${process.platform}/${process.arch}`
    + ` | ${options.seconds}s window, ${options.warmupSeconds}s warmup, ${options.runs} run(s)\n`);
  printHeader();

  try {
    for (const profileName of options.profiles) {
      for (const transport of options.transports) {
        for (let run = 1; run <= options.runs; run += 1) {
          let result;
          try {
            result = await runCombination({
              profileName, transport, run, seconds: options.seconds,
              warmupSeconds: options.warmupSeconds, settleSeconds: options.settleSeconds, preload,
            });
          } catch (error) {
            result = { profile: profileName, transport, run, error: error.message };
          }
          results.push(result);
          printRow(result);
        }
      }
    }
  } finally {
    try { fs.rmSync(preload, { force: true }); } catch {}

    const payload = {
      meta: {
        generatedAt: startedAt.toISOString(),
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        repo: ROOT,
        gitHead: gitHead(ROOT),
        seconds: options.seconds,
        warmupSeconds: options.warmupSeconds,
        settleSeconds: options.settleSeconds,
        runs: options.runs,
        loopResolutionMs: 10,
        note: 'loop delay = Node server event loop (monitorEventLoopDelay, 10ms resolution); '
          + 'cpu = avg %CPU from /bin/ps sampled every 500ms; rss = summed RSS peak across the process tree',
      },
      results,
    };
    if (options.json) {
      fs.mkdirSync(path.dirname(options.json), { recursive: true });
      fs.writeFileSync(options.json, `${JSON.stringify(payload, null, 2)}\n`);
      process.stdout.write(`\nJSON written to ${options.json}\n`);
    }
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});
