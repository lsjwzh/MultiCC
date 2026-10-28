'use strict';

// 本地 CDP 网关进程（native/cdpd，三平台同一份 Rust 实现）：二进制在哪、地址在哪、
// 有没有在跑、版本对不对、怎么拉起。帧协议与 ws 形状的 socket 见 src/cdp-relay.js，
// 契约见 docs/desktop-agent-protocol.md §4.4。
//
// 它存在的唯一理由：Chrome 144+ 对每条新的 WebSocket 连接都要用户点一次「允许远程
// 调试」，点完只覆盖那一条。网关常驻、每个 Chrome 只留一条上游连接。
//
// 生命周期：不是服务端的子进程（服务端重启不该让用户再点一次允许）。服务端启动时
// eager 拉起一次，用的时候发现不在也会按需拉起 —— 网关空闲（没有任何上游）一小时
// 会自己退出，所以「只在启动时拉一次」是不够的。

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

// 与 native/cdpd/src/lib.rs 的 PROTOCOL_VERSION 一致；tests/test-cdpd.js 用二进制的
// --version 校验。
const PROTOCOL_VERSION = 2;
const BIN_NAME = process.platform === 'win32' ? 'multicc-cdpd.exe' : 'multicc-cdpd';

// 与原生模块同目录：scripts/build-rust-kernels.js 把 cdpd 和 multicc_core.node
// 一起投放（和 multicc-remote 完全一样的布局）。
function addonPath(env = process.env) {
  return env.MULTICC_RUST_ADDON || path.join(
    env.MULTICC_RUST_PREBUILT_DIR || path.join(__dirname, '..', 'native', 'prebuilt'),
    `${process.platform}-${process.arch}`, 'multicc_core.node');
}

function binaryPath(env = process.env) {
  if (env.MULTICC_CDP_BIN) return env.MULTICC_CDP_BIN;
  return path.join(path.dirname(addonPath(env)), BIN_NAME);
}

function sanitizeUser(name) {
  const cleaned = String(name || '').replace(/[^A-Za-z0-9._-]/g, '_');
  return cleaned || 'default';
}

// 与 native/cdpd/src/paths.rs 逐条一致（`multicc-cdpd paths` 可对照）。刻意不跟随
// XDG_RUNTIME_DIR：服务端（launchd/systemd 拉起）和终端里的脚本环境不同，地址却必须相同。
function cdpdPaths(env = process.env, { home = os.homedir(), platform = process.platform } = {}) {
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const base = platform === 'win32' ? (env.USERPROFILE || home) : (env.HOME || home);
  const dir = env.MULTICC_CDP_DIR || join(base, '.multicc', 'cdpd');
  const socket = env.MULTICC_CDP_SOCK || (platform === 'win32'
    ? `\\\\.\\pipe\\multicc-cdpd-${sanitizeUser(env.USERNAME || safeUserName())}`
    : join(dir, 'cdp.sock'));
  return {
    dir,
    socket,
    lock: join(dir, 'cdpd.lock'),
    log: join(dir, 'cdpd.log'),
    endpoint: join(dir, 'endpoint.json'),
  };
}

function safeUserName() {
  try { return os.userInfo().username; } catch (_) { return 'default'; }
}

function socketPath(env = process.env) {
  return cdpdPaths(env).socket;
}

// MULTICC_CDP_GATEWAY=0：完全不用网关，直连 Chrome（每条连接一次授权）。
function gatewayDisabled(env = process.env) {
  return String(env.MULTICC_CDP_GATEWAY || '').trim() === '0';
}

// MULTICC_CDP_AUTOSTART=0：用已经在跑的网关，但不替它拉起进程。
function autostartDisabled(env = process.env) {
  return gatewayDisabled(env) || String(env.MULTICC_CDP_AUTOSTART || '').trim() === '0';
}

// 一问一答的控制请求。连不上（ENOENT / ECONNREFUSED / 死 socket）都返回 null：
// socket 文件在不在不能说明进程在不在。
function request(body, { env = process.env, netModule = net, timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let buffer = '';
    let connection;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { connection && connection.destroy(); } catch (_) { /* gone */ }
      resolve(value);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    timer.unref?.();
    try { connection = netModule.createConnection({ path: socketPath(env) }); }
    catch (_) { done(null); return; }
    connection.on('connect', () => connection.write(`${JSON.stringify(body)}\n`));
    connection.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl < 0) return;
      try { done(JSON.parse(buffer.slice(0, nl))); } catch (_) { done(null); }
    });
    connection.on('error', () => done(null));
    connection.on('close', () => done(null));
  });
}

// 老版本（协议 1）的 ping 只有 {version: 1}。
function protocolOf(pong) {
  if (!pong || pong.ok !== true) return 0;
  if (Number.isInteger(pong.protocol)) return pong.protocol;
  return Number.isInteger(pong.version) ? pong.version : 0;
}

// `multicc-cdpd 2 0.2.0` → { protocol: 2, version: '0.2.0' }，按 mtime 缓存。
const versionCache = new Map();
function binaryVersion(file, { run = spawnSync, fileSystem = fs } = {}) {
  let stamp;
  try { stamp = fileSystem.statSync(file).mtimeMs; } catch (_) { return null; }
  const cached = versionCache.get(file);
  if (cached && cached.stamp === stamp) return cached.value;
  const result = run(file, ['--version'], { encoding: 'utf8', timeout: 10_000 });
  const match = /^multicc-cdpd (\d+) (\S+)/.exec(String(result.stdout || '').trim());
  const value = match ? { protocol: Number(match[1]), version: match[2] } : null;
  versionCache.set(file, { stamp, value });
  return value;
}

// 守护进程只拿它需要的环境：一个常驻进程不该带着服务端的 API key 活下去。
const ENV_KEEP = ['HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'USERNAME', 'PATH',
  'TMPDIR', 'TEMP', 'TMP', 'LANG', 'SystemRoot', 'SYSTEMROOT'];
function daemonEnv(env = process.env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (ENV_KEEP.includes(key) || key.startsWith('MULTICC_CDP_')) out[key] = value;
  }
  return out;
}

function createCdpdProvisioner(options = {}) {
  const {
    env = process.env,
    logger = console,
    fs: fileSystem = fs,
    spawnFn = spawn,
    netModule = net,
    readVersion = (file) => binaryVersion(file, { fileSystem }),
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    startTimeoutMs = 4000,
  } = options;
  let inflight = null;

  const ping = () => request({ op: 'ping' }, { env, netModule });

  function inspect() {
    const binary = binaryPath(env);
    let binaryPresent = false;
    try { binaryPresent = fileSystem.statSync(binary).isFile(); } catch (_) { binaryPresent = false; }
    return { binary, binaryPresent, paths: cdpdPaths(env), disabled: autostartDisabled(env) };
  }

  async function start(state) {
    try { fileSystem.mkdirSync(state.paths.dir, { recursive: true, mode: 0o700 }); } catch (_) { /* serve reports it */ }
    const child = spawnFn(state.binary, ['serve'], {
      detached: true,
      stdio: 'ignore',
      // 不钉住服务端的 cwd（可能是一个之后会被删掉的 worktree）。
      cwd: state.paths.dir,
      env: daemonEnv(env),
      windowsHide: true,
    });
    child.on('error', (error) => logger.warn?.(`[cdpd] start failed: ${error.message}`));
    child.unref();
    const deadline = Date.now() + startTimeoutMs;
    while (Date.now() < deadline) {
      const pong = await ping();
      if (protocolOf(pong) === PROTOCOL_VERSION) return pong;
      await wait(100);
    }
    return null;
  }

  // 让一个旧版本退场。有已授权上游时，协议兼容就留着它（换掉 = 用户再点一次允许），
  // 协议不兼容才强制换。
  async function retire({ force }) {
    const reply = await request({ op: 'shutdown', force }, { env, netModule });
    if (!reply || reply.ok !== true) return false;
    for (let i = 0; i < 30; i++) {
      if (!(await ping())) return true;
      await wait(100);
    }
    return false;
  }

  async function ensureOnce() {
    const state = inspect();
    if (state.disabled) return { action: 'skip', reason: 'disabled' };
    const pong = await ping();
    const shipped = state.binaryPresent ? readVersion(state.binary) : null;
    if (pong) {
      const running = protocolOf(pong);
      if (running === PROTOCOL_VERSION) {
        const stale = shipped && pong.version && shipped.version !== pong.version;
        if (!stale) return { action: 'already-running', pid: pong.pid, version: pong.version };
        if (pong.busy) return { action: 'already-running', pid: pong.pid, version: pong.version, pendingUpgrade: shipped.version };
        if (!(await retire({ force: false }))) return { action: 'already-running', pid: pong.pid, version: pong.version };
        logger.log?.(`[cdpd] replaced idle gateway ${pong.version} with ${shipped.version}`);
      } else {
        if (!state.binaryPresent) return { action: 'skip', reason: 'incompatible-running', protocol: running };
        if (!(await retire({ force: true }))) {
          logger.warn?.(`[cdpd] gateway speaks protocol ${running}, need ${PROTOCOL_VERSION}, and it would not stop; using direct connections`);
          return { action: 'skip', reason: 'incompatible-running', protocol: running };
        }
        logger.warn?.(`[cdpd] replaced gateway protocol ${running} → ${PROTOCOL_VERSION}; Chrome may ask to allow debugging once more`);
      }
    }
    if (!state.binaryPresent) return { action: 'skip', reason: 'binary-missing', binary: state.binary };
    if (shipped && shipped.protocol !== PROTOCOL_VERSION) {
      return { action: 'skip', reason: 'binary-protocol-mismatch', protocol: shipped.protocol };
    }
    const started = await start(state);
    if (started) logger.log?.(`[cdpd] CDP gateway started (pid ${started.pid})`);
    else logger.warn?.(`[cdpd] CDP gateway did not answer within ${startTimeoutMs}ms; see ${state.paths.log}`);
    return { action: started ? 'started' : 'failed', binary: state.binary, socket: state.paths.socket, pid: started && started.pid };
  }

  // 同一进程里并发的 ensure 合并成一次；跨进程的并发由守护进程的单实例锁兜底。
  function ensure() {
    if (!inflight) inflight = ensureOnce().finally(() => { inflight = null; });
    return inflight;
  }

  return { ensure, inspect, ping };
}

function sharedCdpdProvisioner(options = {}) {
  if (!sharedCdpdProvisioner.instance) sharedCdpdProvisioner.instance = createCdpdProvisioner(options);
  return sharedCdpdProvisioner.instance;
}

module.exports = {
  PROTOCOL_VERSION,
  BIN_NAME,
  binaryPath,
  binaryVersion,
  cdpdPaths,
  socketPath,
  sanitizeUser,
  request,
  protocolOf,
  daemonEnv,
  gatewayDisabled,
  autostartDisabled,
  createCdpdProvisioner,
  sharedCdpdProvisioner,
};
