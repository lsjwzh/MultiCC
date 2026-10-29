'use strict';

// Client side of MultiCC's CDP gateway (`multicc-cdpd`, native/cdpd in the
// MultiCC repo; contract in docs/desktop-agent-protocol.md §4.4).
//
// Why the main Chrome only ever goes through it: a Chrome whose debugging was
// switched on at runtime (chrome://inspect — since Chrome 136 the only way to
// debug the default profile) asks "Allow remote debugging?" for every NEW
// WebSocket. The gateway keeps one approved connection per Chrome and hands
// each caller an isolated browser-level session over it, so a daemon restart,
// a skill upgrade or a second MultiCC session never shows the dialog again.
// Connecting to the main Chrome directly from here would be exactly the second
// dialog the gateway exists to prevent — there is deliberately no fallback.
//
// Paths mirror src/cdpd.js / native/cdpd/src/paths.rs byte for byte: the skill
// is copied to ~/.agents/skills and cannot require the server's modules.

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const { MbError } = require('./paths');

const PROTOCOL_VERSION = 2;
const BIN_NAME = process.platform === 'win32' ? 'multicc-cdpd.exe' : 'multicc-cdpd';
// The gateway itself gives up on an unanswered "Allow" after 180s
// (MULTICC_CDP_APPROVAL_TIMEOUT_SECS); waiting a little longer means its own,
// precise refusal arrives instead of our generic timeout.
const APPROVAL_TIMEOUT_MS = 190000;

function sanitizeUser(name) {
  const cleaned = String(name || '').replace(/[^A-Za-z0-9._-]/g, '_');
  return cleaned || 'default';
}

function safeUserName() {
  try { return os.userInfo().username; } catch (_) { return 'default'; }
}

function cdpdPaths(env = process.env, { home = os.homedir(), platform = process.platform } = {}) {
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const base = platform === 'win32' ? (env.USERPROFILE || home) : (env.HOME || home);
  const dir = env.MULTICC_CDP_DIR || join(base, '.multicc', 'cdpd');
  const socket = env.MULTICC_CDP_SOCK || (platform === 'win32'
    ? `\\\\.\\pipe\\multicc-cdpd-${sanitizeUser(env.USERNAME || safeUserName())}`
    : join(dir, 'cdp.sock'));
  return { dir, socket, log: join(dir, 'cdpd.log') };
}

// One request, one reply line. Anything short of a parsed reply is null: a
// socket file on disk says nothing about whether a process is behind it.
function request(body, { env = process.env, timeoutMs = 1500 } = {}) {
  return new Promise(resolve => {
    let settled = false;
    let buffer = '';
    let connection;
    const done = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (connection) connection.destroy(); } catch (_) { /* gone */ }
      resolve(value);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    try { connection = net.createConnection({ path: cdpdPaths(env).socket }); } catch (_) { done(null); return; }
    connection.on('connect', () => connection.write(`${JSON.stringify(body)}\n`));
    connection.on('data', chunk => {
      buffer += chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl < 0) return;
      try { done(JSON.parse(buffer.slice(0, nl))); } catch (_) { done(null); }
    });
    connection.on('error', () => done(null));
    connection.on('close', () => done(null));
  });
}

function onPath(name, env = process.env) {
  const dirs = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const file = path.join(dir, name);
    if (isFile(file)) return file;
  }
  return null;
}

function isFile(file) {
  try { return fs.statSync(file).isFile(); } catch (_) { return false; }
}

// Where the gateway binary is, in the order a MultiCC session finds it: an
// explicit override, next to the native module the server loaded (every
// session MultiCC spawns inherits MULTICC_RUST_ADDON), then PATH.
function binaryCandidates(env = process.env) {
  const out = [];
  if (env.MULTICC_CDP_BIN) out.push(env.MULTICC_CDP_BIN);
  if (env.MULTICC_RUST_ADDON) out.push(path.join(path.dirname(env.MULTICC_RUST_ADDON), BIN_NAME));
  const found = onPath(BIN_NAME, env);
  if (found) out.push(found);
  return out;
}

function locateBinary(env = process.env) {
  return binaryCandidates(env).find(isFile) || null;
}

function runBinary(file, args, { env = process.env, timeoutMs = 20000 } = {}) {
  return new Promise(resolve => {
    execFile(file, args, { encoding: 'utf8', timeout: timeoutMs, env, windowsHide: true },
      (error, stdout, stderr) => resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });
}

// The loopback WebSocket entry without a query: ws://127.0.0.1:PORT/cdp/TOKEN.
// A running gateway answers over its socket; otherwise its own `endpoint`
// command starts it (single-instance lock on its side) and prints the address.
async function baseEndpoint({ env = process.env } = {}) {
  if (String(env.MULTICC_CDP_GATEWAY || '').trim() === '0') {
    throw new MbError('gateway_disabled',
      'MULTICC_CDP_GATEWAY=0 turns the CDP gateway off, and the main Chrome is only ever driven through it');
  }
  const reply = await request({ op: 'endpoint' }, { env });
  if (reply && reply.ok === true && typeof reply.url === 'string') return reply.url;
  const binary = locateBinary(env);
  if (!binary) {
    throw new MbError('gateway_unavailable',
      'the MultiCC CDP gateway (multicc-cdpd) is not running and its binary was not found ' +
      '(looked at $MULTICC_CDP_BIN, next to $MULTICC_RUST_ADDON, and PATH). Run mbrowser from a ' +
      'MultiCC session, or set MULTICC_CDP_BIN to the multicc-cdpd shipped with MultiCC.');
  }
  const result = await runBinary(binary, ['endpoint', '--active-port', 'default'], { env });
  const line = result.stdout.trim().split('\n').pop() || '';
  if (!line.startsWith('ws://')) {
    let detail = line || result.stderr.trim() || (result.error && result.error.message) || 'no output';
    try { const parsed = JSON.parse(line); detail = parsed.detail || parsed.error || detail; } catch (_) { /* plain text */ }
    throw new MbError('gateway_unavailable', `multicc-cdpd endpoint failed: ${detail} (log: ${cdpdPaths(env).log})`);
  }
  return line.split('?')[0];
}

// lane: a named caller keeps its tab leases across reconnects for ttl seconds;
// without one the lane lives exactly as long as the WebSocket.
function endpointUrl(base, { activePort = 'default', wsUrl, lane, ttlSeconds } = {}) {
  const query = [wsUrl ? `ws=${encodeURIComponent(wsUrl)}` : `activePort=${encodeURIComponent(activePort)}`];
  if (lane) query.push(`lane=${encodeURIComponent(lane)}`);
  if (ttlSeconds) query.push(`ttl=${Math.max(1, Math.round(Number(ttlSeconds)))}`);
  return `${base}?${query.join('&')}`;
}

async function mainEndpoint(options = {}) {
  return endpointUrl(await baseEndpoint(options), options);
}

async function browserEndpoint(options = {}) {
  const base = await baseEndpoint(options);
  if (String(options.wsUrl || '').startsWith('pipe://')) {
    const pong = await request({ op: 'ping' }, options);
    if (!pong || !Array.isArray(pong.capabilities) || !pong.capabilities.includes('browser-control-pipe-v1')) {
      throw new MbError('gateway_upgrade_required',
        'the running MultiCC gateway does not support isolation control pipes yet; update MultiCC and restart it manually. ' +
        'Keep this account in its isolation environment; do not fall back to the everyday Chrome.');
    }
  }
  return endpointUrl(base, options);
}

// The token in the path is what keeps other local users out; it has no place
// in logs or in error text handed to a model.
function redact(url) {
  return String(url || '').replace(/\/cdp\/[^/?#]+/, '/cdp/<token>');
}

const ADVICE = {
  chrome_rejected: 'the user declined "Allow remote debugging" in Chrome; ask them before trying again',
  chrome_approval_timeout: 'nobody answered Chrome\'s "Allow remote debugging?" dialog; ask the user to click Allow, then retry',
  chrome_cooldown: 'Chrome refused or timed out recently; do not loop — ask the user, then retry after the cooldown',
  chrome_unavailable: 'the main Chrome is not listening for DevTools (closed, or remote debugging is off)',
  'cdp-upstream-closed': 'the connection to the main Chrome dropped (Chrome quit or restarted); the next command reconnects',
  'cdp-lane-released': 'this caller\'s gateway lane was released; the next command reconnects',
};

// The gateway refuses with a WebSocket close frame whose reason is
// {"ok":false,"error":code,"detail":…,"retryAfterMs"?}.
function refusalFromClose(reason) {
  let body = null;
  try { body = JSON.parse(String(reason || '')); } catch (_) { return null; }
  if (!body || body.ok !== false || !body.error) return null;
  const code = String(body.error).replace(/-/g, '_');
  const retry = Number(body.retryAfterMs) > 0 ? ` (retry after ${Math.ceil(Number(body.retryAfterMs) / 1000)}s)` : '';
  const advice = ADVICE[body.error] ? ` — ${ADVICE[body.error]}` : '';
  return new MbError(code, `${body.detail || body.error}${retry}${advice}`, { gateway: body });
}

async function status({ env = process.env } = {}) {
  const pong = await request({ op: 'ping' }, { env });
  if (!pong || pong.ok !== true) return { running: false, binary: locateBinary(env) };
  return {
    running: true,
    pid: pong.pid,
    version: pong.version,
    protocol: pong.protocol,
    compatible: pong.protocol === PROTOCOL_VERSION,
    binary: locateBinary(env),
  };
}

module.exports = {
  PROTOCOL_VERSION,
  APPROVAL_TIMEOUT_MS,
  cdpdPaths,
  request,
  binaryCandidates,
  locateBinary,
  baseEndpoint,
  endpointUrl,
  mainEndpoint,
  browserEndpoint,
  redact,
  refusalFromClose,
  status,
};
