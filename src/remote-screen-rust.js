'use strict';

// ── Remote screen（轻量远程协助）：Node 侧的启动看护与转发层（Rust 后端） ──
//
// 本文件不是 server.js 直接 require 的入口：src/remote-screen.js 是选择层，按
// MULTICC_REMOTE_SCREEN_BACKEND 决定加载本文件还是 remote-screen-node.js（迁移前的
// Node 回退实现，见那边的文件头）。默认走这里。
//
// 远控的业务实现整体搬进了独立的 Rust 进程 multicc-remote（native/remote/，
// 契约见 docs/remote-screen-process.md）：Agent socket 客户端、平台画像、截图与
// 裁剪、输入白名单、冻结快照与标注执行、唤屏、RFB / H.264 转发、P2P 直连都在
// 那里。本文件只做三件事：
//
//   1. 懒启动并看护这个进程（退避重启、stdin EOF 收尾）；
//   2. 沿用全站鉴权之后，把 /api/remote-screen/* 的 HTTP 请求原样转过去；
//   3. 把已鉴权的 /ws/remote-screen 逐条转发，并处理 WS 背压。
//
// 为什么这么分：AGENTS.md「后端默认使用 Rust」要求新增/改进的后端逻辑进 Rust，
// Node 只保留迁移期必要的调用桥接。进程隔离让远控崩溃不再带倒整个服务，也让
// 截图/编码在 Node 事件循环之外；Rust 进程编不出来时只是远控不可用，服务照常起。
//
// 退出条件：等全站鉴权和 WS 路由也迁进 Rust 进程（或 Rust 直接接管 Node 的监听
// 端口）时，这一层连同 server.js 里的 mount 一起删除，不再保留任何 Node 远控代码。
//
// 进程协议（文档 §1）：stdin 第一行 {"v":1,"dir":DIR}，之后保持打开（EOF 即退出）；
// stdout 只有一行就绪 JSON {"ready":true,"v":1,"port":…,"secret":…}；日志走 stderr。
// 后续所有请求都带 x-multicc-remote-secret: <secret>（文档 §2）。
//
// 看护策略：崩溃后按 1、2、4…（上限 30s）退避。退避窗口内到来的请求立刻回
// unavailable 并记下「有人还要用」，窗口到点只补启一次；进程连续稳定 60s 才把
// 退避清零。没人看屏幕时不会无脑重启，用户再点也不用等满一个长窗口。
//
// 安全边界与迁移前一致：HTTP 由全站鉴权（远程访问要 ACCESS_TOKEN）、WS 走 ws-ticket；
// 输入固定挂在 'remote-screen' 会话租约下，Agent 的锁屏拒绝 / Esc 急停 / 受保护 App
// 护栏全部由 Agent 与 Rust 进程照旧执行。

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const { createPaths } = require('./paths');
const { getPowerPreferences } = require('./host-power-services');
const { createPowerd } = require('./powerd');

const SESSION = 'remote-screen';
// 冻结截图目录：随数据根隔离，由 assist-snapshots 的 7 天清理兜底。
const DIR = path.join(createPaths({ dataDir: process.env.MULTICC_DATA_DIR }).assistDir, SESSION);

const PROTOCOL_VERSION = 1;
const READY_TIMEOUT_MS = 10000;
const RESTART_BASE_MS = 1000;
const RESTART_MAX_MS = 30000;
const STABLE_RESET_MS = 60000;
const QUEUE_LIMIT_BYTES = 1024 * 1024;
const CLIENT_HIGH_WATER = 64 * 1024;
const CLIENT_LOW_WATER = 16 * 1024;
const BACKPRESSURE_POLL_MS = 15;
const ANNOTATION_TIMEOUT_MS = 20000;
const BIN_NAME = process.platform === 'win32' ? 'multicc-remote.exe' : 'multicc-remote';

// 测试可替换的依赖。运行期只有 spawn / connectUpstream 两处真实现，其余是常量。
const deps = {
  spawn,
  connectUpstream: ({ url, secret }) => new WebSocket(url, {
    headers: { 'x-multicc-remote-secret': secret },
    perMessageDeflate: false,
  }),
  readyTimeoutMs: READY_TIMEOUT_MS,
  restartBaseMs: RESTART_BASE_MS,
  restartMaxMs: RESTART_MAX_MS,
  stableResetMs: STABLE_RESET_MS,
  annotationTimeoutMs: ANNOTATION_TIMEOUT_MS,
  // 「允许自动解锁」开关 || 电源意图 === 'on'。只给唤屏请求带一个布尔值；
  // 电源设置归 Node 的电源模块管，Rust 不重复读系统状态。
  // 读失败要如实报 'error' 而不是 '0'：迁移前 readConsent 是直接抛，
  // state() 随之抛错 → 唤屏接口 503 agent-unavailable；折成 '0' 会变成
  // 误导性的「自动解锁未开启」200，用户会去改一个本来没问题的开关。
  powerConsent: () => {
    // 测试台用文件注入三态（CI 里没有真实电源设置可读）；生产不会设这个变量。
    const injected = process.env.MULTICC_REMOTE_POWER_CONSENT_FILE;
    if (injected) {
      try {
        const value = fs.readFileSync(injected, 'utf8').trim();
        return ['0', '1', 'error'].includes(value) ? value : 'error';
      } catch { return 'error'; }
    }
    try {
      return getPowerPreferences().read(true) || createPowerd().readIntent() === 'on' ? '1' : '0';
    } catch { return 'error'; }
  },
  logger: null,
};

const state = {
  child: null,
  ready: null,        // { port, secret }
  starting: null,     // 同一时刻只有一个启动在飞，并发请求等同一个结果
  attempts: 0,        // 累计 spawn 次数（测试观测 + 日志）
  backoffMs: 0,       // 下一次崩溃后等多久才允许再启动
  restartTimer: null,
  retryDemand: false, // 退避窗口内来过请求：窗口到期后主动重启一次
  lastError: null,
  stopping: false,
};
const forwards = new Set();

// ── 二进制与日志 ──

// 与原生模块同目录：构建脚本把 multicc-remote 和 multicc_core.node 一起投放。
function addonPath() {
  return process.env.MULTICC_RUST_ADDON || path.join(
    process.env.MULTICC_RUST_PREBUILT_DIR || path.resolve(__dirname, '..', 'native', 'prebuilt'),
    `${process.platform}-${process.arch}`, 'multicc_core.node');
}

function remoteBinary() {
  if (process.env.MULTICC_REMOTE_BIN) return process.env.MULTICC_REMOTE_BIN;
  return path.join(path.dirname(addonPath()), BIN_NAME);
}

function log(level, event, fields) {
  const logger = deps.logger;
  const fn = logger && typeof logger[level] === 'function' ? logger[level].bind(logger) : null;
  if (fn) { fn(event, fields); return; }
  const detail = fields?.line || fields?.error || '';
  console[level === 'error' ? 'error' : 'log'](`[multicc] ${event}${detail ? ` ${detail}` : ''}`);
}

function unavailableError(code) {
  const error = new Error('remote-unavailable');
  error.code = code || 'remote-unavailable';
  return error;
}

function unavailableCapabilities() {
  return {
    ok: true, supported: false, reason: 'remote-unavailable',
    features: { view: false, control: false, snapshot: false, annotate: false,
      stream: false, wake: false, unlock: false, elementTree: false },
    streams: { h264: false, rfb: false },
  };
}

// ── 启动与看护 ──

function scheduleRestart() {
  if (state.restartTimer || state.stopping) return;
  const delay = state.backoffMs || Math.min(deps.restartBaseMs, deps.restartMaxMs);
  state.backoffMs = Math.min(delay * 2, deps.restartMaxMs);
  state.restartTimer = setTimeout(() => {
    state.restartTimer = null;
    // 退避窗口内没有新请求就继续等着，下一次请求自己会触发启动。
    if (!state.retryDemand) return;
    state.retryDemand = false;
    ensureStarted().catch(() => {});
  }, delay);
  state.restartTimer.unref?.();
}

function closeForwards(reason = 'remote-unavailable') {
  for (const session of [...forwards]) {
    session.closed = true;
    stopBackpressurePoll(session);
    safeClose(session.ws, 1011, reason);
    try {
      if (session.up?.terminate) session.up.terminate();
      else session.up?.close?.(1011, reason);
    } catch {}
    forwards.delete(session);
  }
}

function handleExit(child, code, signal) {
  if (state.child !== child) return; // 已经被新进程替换或测试 reset 过
  state.child = null;
  state.ready = null;
  state.lastError = `exited code=${code}${signal ? ` signal=${signal}` : ''}`;
  closeForwards('remote-unavailable');
  log('warn', 'remote_screen_exited', { error: state.lastError });
  scheduleRestart();
}

function startProcess() {
  const bin = remoteBinary();
  if (!fs.existsSync(bin)) return Promise.reject(unavailableError('binding-missing'));
  try { fs.mkdirSync(DIR, { recursive: true }); } catch {}
  let child;
  try {
    child = deps.spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env, windowsHide: true });
  } catch (error) {
    return Promise.reject(unavailableError(error.code || 'spawn-failed'));
  }
  state.child = child;
  state.attempts += 1;
  log('info', 'remote_screen_starting', { attempt: state.attempts });

  return new Promise((resolve, reject) => {
    let settled = false;
    let stdoutBuffer = '';
    const fail = code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      state.lastError = code;
      if (state.child === child) state.child = null;
      log('warn', 'remote_screen_start_failed', { error: code });
      try { child.kill('SIGKILL'); } catch {}
      reject(unavailableError(code));
    };
    const timer = setTimeout(() => fail('ready-timeout'), deps.readyTimeoutMs);
    timer.unref?.();

    child.on('error', error => fail(error.code || 'spawn-failed'));
    child.on('exit', (code, signal) => {
      if (!settled) { fail(`exited-before-ready:${code ?? signal}`); return; }
      handleExit(child, code, signal);
    });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (settled) return;
      stdoutBuffer += chunk;
      const newline = stdoutBuffer.indexOf('\n');
      if (newline < 0) {
        if (stdoutBuffer.length > 64 * 1024) fail('bad-ready-line');
        return;
      }
      let ready;
      try { ready = JSON.parse(stdoutBuffer.slice(0, newline)); } catch { fail('bad-ready-line'); return; }
      if (ready?.ready !== true || ready.v !== PROTOCOL_VERSION
          || !Number.isInteger(ready.port) || ready.port <= 0
          || typeof ready.secret !== 'string' || !ready.secret) {
        fail('bad-ready-line');
        return;
      }
      settled = true;
      clearTimeout(timer);
      state.ready = { port: ready.port, secret: ready.secret };
      state.lastError = null;
      log('info', 'remote_screen_ready', { port: ready.port });
      // 跑稳一段时间才把退避清零：起完就崩的二进制不该每分钟重启一次。
      const stable = setTimeout(() => { state.backoffMs = 0; }, deps.stableResetMs);
      stable.unref?.();
      child.once('exit', () => clearTimeout(stable));
      resolve(state.ready);
    });

    // 日志一律走 stderr；按行转给服务日志，避免半行把记录切碎。
    let stderrPending = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      stderrPending += chunk;
      const lines = stderrPending.split('\n');
      stderrPending = lines.pop();
      for (const line of lines) if (line.trim()) log('info', 'remote_screen_stderr', { line: line.slice(0, 500) });
    });

    try { child.stdin.write(JSON.stringify({ v: PROTOCOL_VERSION, dir: DIR }) + '\n'); }
    catch { fail('stdin-closed'); }
  });
}

// 懒启动：第一次有远控请求时才拉起；并发请求共享同一个 Promise。
// 崩溃后退避窗口内的请求直接回 503（文档 §6），同时记下「有人要」，窗口到期自动重启。
function ensureStarted() {
  if (state.stopping) return Promise.reject(unavailableError('stopping'));
  if (state.ready) return Promise.resolve(state.ready);
  if (state.starting) return state.starting;
  if (state.restartTimer) {
    state.retryDemand = true;
    return Promise.reject(unavailableError('restarting'));
  }
  const pending = startProcess().then(ready => {
    state.starting = null;
    return ready;
  }, error => {
    state.starting = null;
    scheduleRestart();
    throw error;
  });
  state.starting = pending;
  return pending;
}

// ── HTTP 转发（文档 §3）──

function upstreamBase(ready) { return `http://127.0.0.1:${ready.port}`; }

function requestUpstream(ready, method, pathname, { body, headers = {}, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(body);
    const outgoing = http.request({
      host: '127.0.0.1',
      port: ready.port,
      method,
      path: pathname,
      headers: {
        ...headers,
        'x-multicc-remote-secret': ready.secret,
        ...(payload ? { 'content-length': String(payload.length) } : {}),
      },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
      response.on('error', reject);
    });
    outgoing.setTimeout(timeoutMs, () => outgoing.destroy(unavailableError('remote-timeout')));
    outgoing.on('error', reject);
    outgoing.end(payload || undefined);
  });
}

function copyResponseHeaders(source, res) {
  for (const [name, value] of Object.entries(source)) {
    if (!/^(content-type|cache-control|content-length|x-screen-|x-region-)/i.test(name)) continue;
    try { res.setHeader(name, value); } catch {}
  }
}

function powerConsentHeader() {
  try { return { 'x-multicc-power-consent': deps.powerConsent() }; }
  catch { return { 'x-multicc-power-consent': 'error' }; }
}

function unavailableHttp(req, res, pathname) {
  if (pathname === '/api/remote-screen/capabilities') {
    res.set({ 'Cache-Control': 'no-store' });
    res.json(unavailableCapabilities());
    return;
  }
  res.status(503).json({ ok: false, error: 'remote-unavailable' });
}

async function forwardHttp(req, res) {
  const pathname = String(req.originalUrl || req.url || '').split('?')[0];
  if (!['GET', 'HEAD', 'POST'].includes(req.method)) {
    res.status(405).json({ ok: false, error: 'method-not-allowed' });
    return;
  }
  let ready;
  try { ready = await ensureStarted(); }
  catch { unavailableHttp(req, res, pathname); return; }

  const body = req.method === 'POST' ? JSON.stringify(req.body ?? {}) : null;
  const headers = {};
  if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
  if (pathname === '/api/remote-screen/wake') Object.assign(headers, powerConsentHeader());

  const outgoing = http.request({
    host: '127.0.0.1',
    port: ready.port,
    method: req.method,
    path: req.originalUrl || req.url,
    headers: {
      ...headers,
      'x-multicc-remote-secret': ready.secret,
      ...(body != null ? { 'content-length': String(Buffer.byteLength(body)) } : {}),
    },
  }, upstream => {
    copyResponseHeaders(upstream.headers, res);
    res.writeHead(upstream.statusCode || 502);
    upstream.pipe(res);
  });
  outgoing.setTimeout(15000, () => outgoing.destroy(unavailableError('remote-timeout')));
  outgoing.on('error', () => {
    if (res.headersSent) { res.destroy(); return; }
    unavailableHttp(req, res, pathname);
  });
  // 客户端走了就别把上游请求晾着（截图和编码会白跑一遍）。
  res.on('close', () => { if (!res.writableEnded) outgoing.destroy(); });
  outgoing.end(body ?? undefined);
}

// ── WS 转发（文档 §4）──

const SENDABLE_CLOSE = new Set([1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014]);

// 1005/1006/1015 这类是本地状态码，不能在线上发送；3000–4999 是应用自定义码。
// 其余（含未分配 / 保留区间）统一换成 1011 让客户端重连。
function sendableCloseCode(code) {
  if (Number.isInteger(code) && code >= 3000 && code <= 4999) return code;
  if (!Number.isInteger(code) || !SENDABLE_CLOSE.has(code)) return 1011;
  return code;
}

function clipReason(reason) {
  const text = typeof reason === 'string' ? reason : String(reason || '');
  return text.length > 100 ? `${text.slice(0, 99)}…` : text;
}

function safeClose(ws, code, reason) {
  try { if (ws.readyState === 1 || ws.readyState === 2) ws.close(sendableCloseCode(code), clipReason(reason)); } catch {}
}

// ticket / token 是全站鉴权凭据，只属于 Node 这一跳，不进上游 URL。
function upstreamPath(req, mode) {
  const raw = String(req?.url || '');
  const index = raw.indexOf('?');
  const params = new URLSearchParams(index >= 0 ? raw.slice(index + 1) : '');
  params.delete('ticket');
  params.delete('token');
  if (mode === 'h264' && !params.has('mode')) params.set('mode', 'h264');
  const query = params.toString();
  return `/ws/remote-screen${query ? `?${query}` : ''}`;
}

function stopBackpressurePoll(session) {
  if (!session.poll) return;
  clearInterval(session.poll);
  session.poll = null;
}

// 客户端侧真实积压 = ws 传输层队列 + installWsBackpressure 自己攒的队列。
// 只看 bufferedAmount 会漏掉更早的一大截：连接握手时 connection-router 就给每条
// WS 装了背压层，`ws.send` 先落进它自己的队列（没写进 socket 的字节不计入
// bufferedAmount）。漏算的结果是慢客户端迟迟不暂停上游，几秒的旧画面全排在
// 内存里。stats() 拿不到（没装背压层 / 已关闭）就当 0，不让它挡正常路径。
function clientBufferedBytes(ws) {
  let queued = 0;
  try {
    const stats = ws?._multiccBackpressure?.stats?.();
    if (stats && Number.isFinite(stats.queueBytes)) queued = stats.queueBytes;
  } catch {}
  return (ws?.bufferedAmount || 0) + queued;
}

// 客户端积压超过高水位就暂停读上游；每 15ms 查到低水位以下再恢复。
// 不这样做的话慢链路会把几秒的旧画面全排在 ws 的发送队列里，越拖越久。
function watchBackpressure(session) {
  if (session.poll || session.closed || !session.up) return;
  if (clientBufferedBytes(session.ws) <= CLIENT_HIGH_WATER) return;
  try { session.up.pause?.(); } catch {}
  session.poll = setInterval(() => {
    if (session.closed || clientBufferedBytes(session.ws) > CLIENT_LOW_WATER) return;
    stopBackpressurePoll(session);
    try { session.up.resume?.(); } catch {}
  }, BACKPRESSURE_POLL_MS);
  session.poll.unref?.();
}

function attach(ws, mode, req) {
  const session = { ws, up: null, queue: [], queuedBytes: 0, closed: false, poll: null };
  forwards.add(session);

  const detach = () => {
    session.closed = true;
    stopBackpressurePoll(session);
    forwards.delete(session);
  };

  ws.on('error', () => {});
  ws.on('close', (code, reason) => {
    const wasClosed = session.closed;
    detach();
    const up = session.up;
    if (!up || wasClosed) return;
    try { up.close(sendableCloseCode(code), clipReason(reason)); } catch {}
  });
  ws.on('message', (data, isBinary) => {
    if (session.closed) return;
    const up = session.up;
    if (up && up.readyState === 1) {
      try { up.send(data, { binary: isBinary }); } catch { safeClose(ws, 1011, 'upstream-closed'); }
      return;
    }
    // 上游还没连上：先排队，超过 1 MB 就以 1013 关闭（文档 §4.2）。
    const bytes = typeof data === 'string' ? Buffer.byteLength(data) : (data?.length || 0);
    if (session.queuedBytes + bytes > QUEUE_LIMIT_BYTES) {
      detach();
      safeClose(ws, 1013, 'queue-overflow');
      return;
    }
    session.queue.push({ data, isBinary });
    session.queuedBytes += bytes;
  });

  ensureStarted().then(ready => {
    if (session.closed) return;
    let up;
    try { up = deps.connectUpstream({ url: `ws://127.0.0.1:${ready.port}${upstreamPath(req, mode)}`, secret: ready.secret }); }
    catch { detach(); safeClose(ws, 1011, 'remote-unavailable'); return; }
    session.up = up;
    up.on('error', () => {});
    up.on('open', () => {
      for (const item of session.queue.splice(0)) {
        try { up.send(item.data, { binary: item.isBinary }); } catch { break; }
      }
      session.queuedBytes = 0;
    });
    up.on('message', (data, isBinary) => {
      if (session.closed || ws.readyState !== 1) return;
      try { ws.send(data, { binary: isBinary }); } catch {}
      watchBackpressure(session);
    });
    up.on('close', (code, reason) => {
      if (session.closed) return;
      detach();
      safeClose(ws, code, reason);
    });
  }, () => {
    detach();
    safeClose(ws, 1011, 'remote-unavailable');
  });
}

function attachH264(ws, req) { attach(ws, 'h264', req); }
function attachRfb(ws, req) { attach(ws, 'rfb', req); }

// ── 标注（文档 §3 内部路由）──

// 「是不是远控自己的截图」只是一次路径检查，留在 Node 里决定往哪里转。
function isOwnShot(src) {
  const file = path.resolve(String(src || ''));
  return path.dirname(file) === path.resolve(DIR) && /^shot-\d+\.png$/.test(path.basename(file));
}

async function handleAnnotation(payload = {}) {
  const src = path.resolve(String(payload.src || ''));
  if (!isOwnShot(src)) return { ok: false, refresh: false, text: '不是远程屏幕截图' };
  let ready;
  try { ready = await ensureStarted(); }
  catch { return { ok: false, refresh: false, text: '远控服务不可用' }; }
  try {
    const response = await requestUpstream(ready, 'POST', '/internal/annotation', {
      body: JSON.stringify(payload),
      headers: { 'content-type': 'application/json' },
      timeoutMs: deps.annotationTimeoutMs,
    });
    if (response.status !== 200) return { ok: false, refresh: false, text: '远控服务无响应' };
    const result = JSON.parse(response.body.toString('utf8'));
    if (!result || typeof result !== 'object') throw new Error('bad response');
    return result;
  } catch {
    return { ok: false, refresh: false, text: '远控服务无响应' };
  }
}

// ── 对外接线 ──

async function capabilities() {
  try {
    const ready = await ensureStarted();
    const response = await requestUpstream(ready, 'GET', '/api/remote-screen/capabilities');
    return JSON.parse(response.body.toString('utf8'));
  } catch { return unavailableCapabilities(); }
}

function mount(app, options = {}) {
  if (options.logger) deps.logger = options.logger;
  // 全站鉴权已在 server.js 更早的中间件里完成；这里只做转发。
  app.use('/api/remote-screen', (req, res) => { forwardHttp(req, res).catch(() => unavailableHttp(req, res, String(req.originalUrl || req.url || '').split('?')[0])); });
}

function stateSnapshot() {
  return {
    pid: state.child?.pid || null,
    ready: state.ready ? { port: state.ready.port, secret: state.ready.secret } : null,
    attempts: state.attempts,
    backoffMs: state.backoffMs,
    restartPending: !!state.restartTimer,
    lastError: state.lastError,
  };
}

function resetForTests() {
  state.stopping = true;
  if (state.restartTimer) { clearTimeout(state.restartTimer); state.restartTimer = null; }
  const child = state.child;
  state.child = null;
  state.ready = null;
  state.starting = null;
  state.attempts = 0;
  state.backoffMs = 0;
  state.retryDemand = false;
  state.lastError = null;
  closeForwards('remote-unavailable');
  state.stopping = false;
  if (!child) return Promise.resolve();
  return new Promise(resolve => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    child.once('exit', finish);
    try { child.kill('SIGKILL'); } catch { finish(); return; }
    setTimeout(finish, 1000).unref?.();
  });
}

module.exports = {
  mount,
  attachRfb,
  attachH264,
  handleAnnotation,
  isOwnShot,
  capabilities,
  DIR,
  _deps: deps,
  _state: stateSnapshot,
  _resetForTests: resetForTests,
  _unavailableCapabilities: unavailableCapabilities,
  // 设置路由用它判断「Rust 远控是否可用」；只解析路径，不会启动进程。
  _remoteBinary: remoteBinary,
};
