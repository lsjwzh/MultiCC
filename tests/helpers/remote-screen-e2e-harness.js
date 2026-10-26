'use strict';

// 「🖥 屏幕」端到端测试台：真 server.js（隔离数据目录）+ 假 Agent + 模拟隧道。
//
//   App / 测试 ──tunnel──▶ 真 server.js ──h264.sock──▶ 假 Agent
//               (补 X-Forwarded-For，        (回放 tests/fixtures/remote-screen-h264
//                服务端按外网请求验令牌、换票)  —— Agent 真编码器出的字节流，记下收到的输入)
//
// 只有 macOS 上的 multicc-remote 才会去连 h264.sock，其他平台起不来就直说。
// 假 Agent 的 socket 放在临时目录（MULTICC_AGENT_DIR），并关掉 Agent 自动安装 ——
// 否则隔离服务端看到「源码哈希不一致」会在后台重装本机真正的 Agent。
// Rust 模块按当前源码指纹选（scripts/ensure-source-rust.js，与 ./multicc start 同一步）：
// 从运行中的服务继承来的 MULTICC_RUST_ADDON 可能是旧源码编的，新原生接口缺了就起不来。
// 同一步还会把 multicc-remote 放进模块所在目录，Node 转发层按目录找它。
//
// 用法：
//   模块：const h = await startHarness(); … await h.close();
//   backend:'node' 时经 MULTICC_REMOTE_SCREEN_BACKEND 让服务端加载 Node 回退实现
//   （P2P 统计改由 remote-screen-p2p-stats-observer.js 预加载钩子写同一份形状）。
//   命令行（给 flutter test / 模拟器用）：node tests/helpers/remote-screen-e2e-harness.js [--direct]
//     就绪后 stdout 打一行 JSON {ready, server, direct, control, token}；stdin 关闭或收到
//     SIGTERM 时收尾退出。控制端口（只听 loopback）：
//       GET  /agent                 假 Agent 收到的输入：每条连接的原始 hex + 解析后的事件
//       POST /agent/reset           清空记录
//       POST /agent/drop            断开当前所有 h264 连接（模拟 Agent 崩溃 / 采集停止）
//       GET  /fixture/<file>        tests/fixtures/remote-screen-h264 下的文件（模拟器取码流用）
//       GET  /p2p                   仅 --p2p-stats 时有内容：multicc-remote 写出的
//                                   MULTICC_REMOTE_STATS_FILE（transport/p2pOpened/客户端二进制帧数）
//   直连互通测试还要 MULTICC_REMOTE_STUN= 空串（只用本机/局域网候选，不连外部 STUN）。

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const { assertTestDir } = require('../../src/paths');
const { ensureSourceRust } = require('../../scripts/ensure-source-rust');

const ROOT = path.join(__dirname, '..', '..');
const FIXTURE_DIR = path.join(ROOT, 'tests', 'fixtures', 'remote-screen-h264');
// Node 回退后端的 P2P 观测钩子（`node -r` 预加载；只读，不改行为）。
const NODE_P2P_OBSERVER = path.join(__dirname, 'remote-screen-p2p-stats-observer.js');
const TUNNEL_PEER = '203.0.113.9'; // TEST-NET-3：服务端只看「有没有转发头」，值无所谓

// ── 假 Agent 的截图 ──
// macOS 的截图路径是 agent.snap 写文件 → sips 读尺寸/裁剪/转码，所以假 Agent 必须
// 写出一个 sips 认得的真 PNG。1024×768 是故意选大的：服务端会把物理像素按逻辑
// 尺寸换算裁剪框，图太小（比如 1×1）时 100,80,400×240 会落到屏幕外变成 400。
const SHOT_WIDTH = 1024;
const SHOT_HEIGHT = 768;
let shotPng = null;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function screenshotPng() {
  if (shotPng) return shotPng;
  const row = Buffer.alloc(1 + SHOT_WIDTH * 3);
  for (let x = 0; x < SHOT_WIDTH; x += 1) {
    row[1 + x * 3] = 0x20;
    row[2 + x * 3] = 0x40;
    row[3 + x * 3] = 0x80;
  }
  const raw = Buffer.concat(Array.from({ length: SHOT_HEIGHT }, () => row));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SHOT_WIDTH, 0);
  ihdr.writeUInt32BE(SHOT_HEIGHT, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor RGB
  shotPng = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return shotPng;
}

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

function listen(server, target) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(...(typeof target === 'string' ? [target] : [0, '127.0.0.1']), () => resolve(server));
  });
}

// agent-stream.bin = Agent 写进 h264.sock 的原样字节：[type u8][len u32 BE][payload]…
function loadStream(dir = FIXTURE_DIR) {
  const bytes = fs.readFileSync(path.join(dir, 'agent-stream.bin'));
  const messages = [];
  for (let off = 0; off + 5 <= bytes.length;) {
    const len = bytes.readUInt32BE(off + 1);
    messages.push({ type: bytes[off], bytes: bytes.subarray(off, off + 5 + len) });
    off += 5 + len;
  }
  if (messages[0]?.type !== 1 || messages[1]?.type !== 2) throw new Error('fixture must start with config + key frame');
  return messages;
}

// 假 Agent：agent.sock 回最小的 status，h264.sock 回放 fixture，解析并记录收到的输入。
async function startFakeAgent(dir, messages) {
  const sockets = new Set();
  const h264 = new Set();
  const connections = [];
  // agent.sock 上收到的原始请求（HTTP 路由用例要断言「标注真的变成了一次 click」）。
  const inputs = [];
  const timers = new Set();
  // socket → 它的记录：回放时把写出去的每一帧也记下来，直连用例要逐字节对账。
  const streams = new Map();

  const agent = net.createServer(sock => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => {});
    let buf = '';
    sock.on('data', chunk => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      let req = {};
      try { req = JSON.parse(buf.slice(0, nl)); } catch {}
      inputs.push(req);
      let reply;
      if (req.op === 'status') {
        // unlockPassword = 已保存登录密码：唤屏的路由拿它和 Node 传来的同意值组合。
        reply = {
          ok: true, version: '3', accessibility: true, screenRecording: true, postEvents: true,
          screenLocked: false, control: { halted: false }, unlockPassword: true,
        };
      } else if (req.op === 'ping') {
        reply = { ok: true, version: '3' };
      } else if (req.op === 'snap') {
        // 截图：把真 PNG 写到服务端指定的路径，剩下的尺寸/裁剪/转码由 sips 做。
        try {
          fs.mkdirSync(path.dirname(String(req.path)), { recursive: true });
          fs.writeFileSync(String(req.path), screenshotPng());
          reply = { ok: true, path: req.path, width: SHOT_WIDTH, height: SHOT_HEIGHT };
        } catch (error) {
          reply = { ok: false, error: `snap-failed: ${error.message}` };
        }
      } else if (['click', 'move', 'scroll', 'drag', 'pointer', 'type', 'press', 'release', 'resume'].includes(req.op)) {
        reply = { ok: true };
      } else {
        reply = { ok: false, error: 'fake-agent' };
      }
      sock.end(JSON.stringify(reply) + '\n');
    });
  });

  // 一次回放：config 只在连接开头发（Agent 也是只在变化时发），之后关键帧 + 普通帧按 30fps。
  // 新回放**顶掉**同一连接上没跑完的那次：真 Agent 收到 'K' 是从关键帧重开一段新 GOP，
  // 不是让两段流并行。并行会让同一个 POC 的普通帧乱序/重复，Chrome 的 WebCodecs
  // 解码器直接报错（用例里表现为 4 次连续解码失败后主动断开）。
  // 但顶掉时不能把 config 一起丢掉：客户端一到就发 'K'，第一次回放可能还没走到
  // config 那一拍。按连接记着发没发过，没发过就让新的回放带上。
  const replays = new Map();
  function replay(sock, withConfig) {
    const prev = replays.get(sock);
    if (prev) { clearInterval(prev); timers.delete(prev); }
    const conn = streams.get(sock);
    const queue = messages.filter(m => m.type !== 1 || withConfig || !conn?.configSent);
    const send = next => {
      if (!next || sock.destroyed) return false;
      sock.write(next.bytes);
      // 按帧记 hex：直连用例断言收到的每一帧都出自这里、且逐字节相同。
      if (conn) {
        conn.sent.push(next.bytes.toString('hex'));
        if (next.type === 1) conn.configSent = true;
      }
      return true;
    };
    const timer = setInterval(() => {
      const next = queue.shift();
      if (!send(next)) { clearInterval(timer); timers.delete(timer); replays.delete(sock); return; }
      // config 后面紧跟关键帧，不让它们之间有空档
      if (next.type === 1 && queue.length) send(queue.shift());
    }, 33);
    timers.add(timer);
    replays.set(sock, timer);
  }

  const stream = net.createServer(sock => {
    sockets.add(sock);
    h264.add(sock);
    // raw 只记「输入」字节（K / 键 / 指针）——App 的码率控制（'B'）和心跳（'P'）
    // 是自主发的控制消息，数量取决于运行时长，放在 events 里单独看。
    const conn = { sock, raw: [], events: [], sent: [] };
    streams.set(sock, conn);
    let capKbps = 0;
    connections.push(conn);
    sock.on('close', () => { sockets.delete(sock); h264.delete(sock); streams.delete(sock); });
    sock.on('error', () => {});
    let pending = Buffer.alloc(0);
    sock.on('data', chunk => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length) {
        const type = pending[0];
        const need = type === 5 ? 6 : type === 4 ? 8 : type === 0x42 || type === 0x50 ? 5 : 1;
        if (pending.length < need) break;
        const msg = pending.subarray(0, need);
        pending = pending.subarray(need);
        if (msg[0] === 0x4b) {
          conn.raw.push(msg.toString('hex'));
          conn.events.push(['key-request']);
          // 静止屏幕上 Agent 收到关键帧请求会重编最后一帧；这里重放整段，末帧状态不变。
          replay(sock, false);
        } else if (msg[0] === 5) {
          conn.raw.push(msg.toString('hex'));
          conn.events.push(['pointer', msg[1], msg.readUInt16BE(2), msg.readUInt16BE(4)]);
        } else if (msg[0] === 4) {
          conn.raw.push(msg.toString('hex'));
          conn.events.push(['key', msg[1], msg.readUInt32BE(4)]);
        } else if (msg[0] === 0x42) {
          // 'B' kbps：真 Agent 取所有客户端的最小上限；这里记下并当作 applied 回报。
          capKbps = msg.readUInt32BE(1);
          conn.events.push(['cap', capKbps]);
        } else if (msg[0] === 0x50) {
          // 'P' token：真 Agent 立刻回 type 4 pong（令牌 + 实际生效码率）。
          const token = msg.readUInt32BE(1);
          conn.events.push(['ping', token]);
          if (!sock.destroyed) {
            const payload = Buffer.alloc(8);
            payload.writeUInt32BE(token, 0);
            payload.writeUInt32BE(capKbps, 4);
            sock.write(Buffer.concat([Buffer.from([4, 0, 0, 0, 8]), payload]));
          }
        } else {
          conn.events.push(['unknown', msg.toString('hex')]);
        }
      }
    });
    replay(sock, true);
  });

  await listen(agent, path.join(dir, 'agent.sock'));
  await listen(stream, path.join(dir, 'h264.sock'));
  return {
    snapshot: () => ({
      // sent = 假 Agent 实际写出去的帧（按帧 hex），直连用例拿它对账。
      connections: connections.map(c => ({ raw: c.raw.join(''), events: c.events, sent: c.sent.slice() })),
      // inputs = agent.sock 收到的请求（status / snap / click…），按到达顺序。
      inputs: inputs.slice(),
    }),
    // 活着的连接还在往自己那条记录里写，只能清内容，不能把记录换掉。
    reset: () => {
      inputs.length = 0;
      for (let i = connections.length - 1; i >= 0; i -= 1) {
        if (connections[i].sock.destroyed) connections.splice(i, 1);
        else { connections[i].raw.length = 0; connections[i].events.length = 0; }
      }
    },
    drop: () => { const n = h264.size; for (const s of h264) s.destroy(); return n; },
    close: async () => {
      for (const t of timers) clearInterval(t);
      for (const s of sockets) s.destroy();
      await Promise.all([agent, stream].map(s => new Promise(r => s.close(() => r()))));
    },
  };
}

// 模拟隧道（cloudflared / Tailscale Funnel 之类）：原样转发，补一个转发头。服务端据此把
// 请求当外网的：REST 要 X-Access-Token，WS 要先换票 —— 与手机经隧道连进来时同一条路。
function startTunnel(targetPort) {
  const forwardHeaders = req => ({ ...req.headers, 'x-forwarded-for': TUNNEL_PEER, 'x-forwarded-proto': 'https' });
  const server = http.createServer((req, res) => {
    const up = http.request({ host: '127.0.0.1', port: targetPort, method: req.method, path: req.url, headers: forwardHeaders(req) }, upRes => {
      res.writeHead(upRes.statusCode, upRes.headers);
      upRes.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  // 升级后的连接不归 http.Server 管（closeAllConnections 关不掉），自己记着收尾时销毁。
  const upgraded = new Set();
  server.destroyUpgraded = () => { for (const s of upgraded) s.destroy(); };
  server.on('upgrade', (req, socket, head) => {
    const up = net.connect(targetPort, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [k, v] of Object.entries(forwardHeaders(req))) {
        for (const value of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${value}`);
      }
      up.write(lines.join('\r\n') + '\r\n\r\n');
      if (head?.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    upgraded.add(socket);
    upgraded.add(up);
    const end = () => { up.destroy(); socket.destroy(); upgraded.delete(up); upgraded.delete(socket); };
    up.on('error', end);
    socket.on('error', end);
    up.on('close', end);
    socket.on('close', end);
  });
  return listen(server);
}

async function waitReady(base, child, output) {
  for (let i = 0; i < 300; i += 1) {
    if (child.exitCode !== null) throw new Error(`server.js exited early (${child.exitCode}):\n${output()}`);
    try {
      if ((await fetch(`${base}/readyz`)).status === 200) return;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`server.js not ready after 30s:\n${output()}`);
}

async function startHarness({ fixtureDir = FIXTURE_DIR, platform = process.platform, p2pStats = false,
  powerConsentFile = null, backend = 'rust' } = {}) {
  if (platform !== 'darwin') throw new Error('the server only exposes h264.sock on macOS (desktop-host profile)');
  // 后端经环境变量交给 server.js 的选择层：rust（默认）走 multicc-remote，node 走回退实现。
  if (!['rust', 'node'].includes(backend)) throw new Error(`unknown remote-screen backend: ${backend}`);
  const messages = loadStream(fixtureDir);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-rs-e2e-'));
  const dataDir = assertTestDir(path.join(root, 'data'));
  const agentDir = path.join(root, 'agent');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  const token = crypto.randomBytes(16).toString('hex');
  // 电源设置是机器级真状态，测试台用文件注入同意值三态（'1'/'0'/'error'）。
  // 调用方可以传自己的文件（比如预先写好 '0'），否则默认 '1'；返回路径供用例改写。
  const consentFile = powerConsentFile || path.join(root, 'power-consent.txt');
  if (!fs.existsSync(consentFile)) fs.writeFileSync(consentFile, '1');
  const cleanups = [];
  // 每步都限时：收尾卡住只会让测试进程挂着不退，比失败更难查。
  const close = async () => {
    for (const fn of cleanups.reverse()) {
      try { await Promise.race([fn(), new Promise(r => setTimeout(r, 5000).unref())]); } catch {}
    }
    cleanups.length = 0;
    fs.rmSync(root, { recursive: true, force: true });
  };
  try {
    const agent = await startFakeAgent(agentDir, messages);
    cleanups.push(() => agent.close());

    // 首次可能要现编（约 1 分钟），之后按指纹复用缓存。Node 回退不需要远控进程，
    // 但服务端其它功能仍用同一个原生模块，所以照常准备。
    const rustAddon = ensureSourceRust({ log: () => {} });
    // 观测口：rust 后端由 multicc-remote 自己按 200ms 原子写这个文件（见
    // docs/remote-screen-process.md §5）；node 后端由预加载的观测钩子写同一份形状。
    const statsFile = path.join(root, 'p2p-stats.json');
    const port = await freePort();
    let log = '';
    const preload = p2pStats && backend === 'node' ? ['-r', NODE_P2P_OBSERVER] : [];
    const child = spawn(process.execPath, [...preload, 'server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT: String(port),
        ACCESS_TOKEN: token,
        MULTICC_DATA_DIR: dataDir,
        MULTICC_AGENT_DIR: agentDir,
        MULTICC_AGENT_AUTO_INSTALL: '0',
        MULTICC_REMOTE_POWER_CONSENT_FILE: consentFile,
        ...(backend === 'node' ? { MULTICC_REMOTE_SCREEN_BACKEND: 'node' } : {}),
        ...(p2pStats && backend === 'node'
          ? { MULTICC_TEST_P2P_STATS_FILE: statsFile }
          : p2pStats ? { MULTICC_REMOTE_STATS_FILE: statsFile } : {}),
        ...(rustAddon ? { MULTICC_RUST_ADDON: rustAddon } : {}),
        MULTICC_ORCHESTRATION_WORKER_INTERVAL_MS: '60000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', c => { log = (log + c).slice(-8000); });
    child.stderr.on('data', c => { log = (log + c).slice(-8000); });
    cleanups.push(async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise(r => child.once('exit', r));
      child.kill('SIGTERM');
      await Promise.race([exited, new Promise(r => setTimeout(r, 4000))]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });
    const direct = `http://127.0.0.1:${port}`;
    await waitReady(direct, child, () => log);

    const tunnel = await startTunnel(port);
    cleanups.push(() => new Promise(r => {
      tunnel.destroyUpgraded();
      tunnel.closeAllConnections?.();
      tunnel.close(() => r());
    }));

    const control = http.createServer((req, res) => {
      const json = (body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && url.pathname === '/agent') return json(agent.snapshot());
      if (req.method === 'GET' && url.pathname === '/p2p') {
        let stats = {};
        if (p2pStats) {
          try {
            const file = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
            if (backend === 'node') {
              // 观测钩子直接写 {id, stats, wsBinary, at}，形状与服务端桥一致。
              stats = file;
            } else {
              const conns = Array.isArray(file.connections) ? file.connections : [];
              // Rust 侧按连接记；老的观测口只盯一条 h264 桥，形状（stats/wsBinary）
              // 不能变 —— 模拟器里的互通用例按老形状读。
              const c = conns.filter(x => x && x.mode === 'h264').at(-1) || conns.at(-1);
              if (c) {
                const { clientBinary, mode, ...rest } = c;
                stats = { id: 1, stats: rest, wsBinary: clientBinary ?? 0, at: Date.now() };
              }
            }
          } catch {}
        }
        return json(stats);
      }
      if (req.method === 'POST' && url.pathname === '/agent/reset') { agent.reset(); return json({ ok: true }); }
      if (req.method === 'POST' && url.pathname === '/agent/drop') return json({ ok: true, dropped: agent.drop() });
      const file = url.pathname.startsWith('/fixture/') && path.basename(url.pathname);
      if (req.method === 'GET' && file && fs.existsSync(path.join(fixtureDir, file))) {
        res.writeHead(200, { 'content-type': file.endsWith('.json') ? 'application/json' : 'application/octet-stream' });
        return fs.createReadStream(path.join(fixtureDir, file)).pipe(res);
      }
      json({ error: 'not found' }, 404);
    });
    await listen(control);
    cleanups.push(() => new Promise(r => { control.closeAllConnections?.(); control.close(() => r()); }));

    return {
      server: `http://127.0.0.1:${tunnel.address().port}`,
      direct,
      control: `http://127.0.0.1:${control.address().port}`,
      token,
      messages,
      agent,
      backend,
      childPid: child.pid,
      powerConsentFile: consentFile,
      serverLog: () => log,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

module.exports = { startHarness, loadStream, FIXTURE_DIR, TUNNEL_PEER };

if (require.main === module) {
  (async () => {
    const h = await startHarness({ p2pStats: process.argv.includes('--p2p-stats') });
    const direct = process.argv.includes('--direct');
    process.stdout.write(JSON.stringify({
      ready: true, server: direct ? h.direct : h.server, direct: h.direct, control: h.control, token: h.token,
      p2p: `${h.control}/p2p`,
    }) + '\n');
    let closing = false;
    const shutdown = async () => {
      if (closing) return;
      closing = true;
      await h.close();
      process.exit(0);
    };
    process.stdin.on('end', shutdown);
    process.stdin.on('close', shutdown);
    process.stdin.resume();
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  })().catch(error => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exit(1);
  });
}
