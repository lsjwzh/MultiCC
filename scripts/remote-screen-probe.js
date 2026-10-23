#!/usr/bin/env node
'use strict';

// Remote screen ("🖥 屏幕") segment probe. Walks the live pipeline one hop at a
// time on the real Mac and names the first hop that fails — instead of a user
// report of "taps do nothing", which can mean input lost OR a frozen picture.
//
//   agent       agent.sock answers; grants; locked / halted
//   capture     h264.sock streams a config and a key frame
//   input       hover over h264.sock moves the real cursor, and the picture reacts
//   server      /api/remote-screen/capabilities + ws-ticket
//   relay       /ws/remote-screen?mode=h264 streams frames through the bridge
//   relay-input hover through the relay moves the cursor, and the picture reacts
//   http-input  /api/remote-screen/input knows the live `pointer` op (JPEG / crop mode)
//
// Never clicks: input checks are hover-only moves of a few points, and the cursor
// is put back where it was when the Agent reports it (Agent status `cursor`).
//
//   node scripts/remote-screen-probe.js [--base-url URL] [--token T]
//        [--agent-dir DIR] [--no-move] [--json]
//
// Exit 0 when nothing failed (warnings allowed), 1 otherwise.

const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const T_CONFIG = 1;
const T_KEY = 2;
const REQ_KEY = 0x4b;

const DEFAULT_TIMING = {
  firstFrameMs: 5000,  // config + key frame after connecting
  quietMs: 700,        // no frames for this long = the screen is still
  quietMaxMs: 4000,    // give up waiting for a still screen (video playing)
  stepMs: 40,          // between hover samples
  settleMs: 700,       // after the last sample: frames and cursor must have caught up
  requestMs: 5000,     // HTTP / agent.sock round trips
};

const pointer = (mask, x, y) => Buffer.from([5, mask, x >> 8, x & 255, y >> 8, y & 255]);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function agentCall(sockPath, req, timeoutMs) {
  return new Promise(resolve => {
    let buf = '';
    let settled = false;
    const done = value => { if (!settled) { settled = true; sock.destroy(); resolve(value); } };
    const sock = net.createConnection(sockPath);
    sock.setTimeout(timeoutMs, () => done({ ok: false, error: 'agent-timeout' }));
    sock.on('connect', () => sock.write(JSON.stringify(req) + '\n'));
    sock.on('data', chunk => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      try { done(JSON.parse(buf.slice(0, nl))); } catch { done({ ok: false, error: 'agent-bad-response' }); }
    });
    sock.on('error', error => done({ ok: false, error: 'agent-unreachable', detail: error.code || error.message }));
    sock.on('end', () => done({ ok: false, error: 'agent-closed' }));
  });
}

/** Splits [type u8][len u32 BE][payload] frames and remembers when each arrived. */
class FrameTap {
  constructor() { this.buf = Buffer.alloc(0); this.frames = []; this.config = null; this.waiters = new Set(); }
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
    while (this.buf.length >= 5) {
      const len = this.buf.readUInt32BE(1);
      if (this.buf.length < 5 + len) break;
      const type = this.buf[0];
      const payload = this.buf.subarray(5, 5 + len);
      this.buf = this.buf.subarray(5 + len);
      if (type === T_CONFIG) {
        try { this.config = JSON.parse(payload.toString()); } catch { this.config = { bad: true }; }
      }
      this.frames.push({ at: Date.now(), type, len });
    }
    for (const check of this.waiters) check();
  }
  waitFor(pred, ms) {
    return new Promise(resolve => {
      const check = () => { if (pred()) finish(true); };
      const finish = value => { clearTimeout(timer); this.waiters.delete(check); resolve(value); };
      const timer = setTimeout(() => finish(pred()), ms);
      this.waiters.add(check);
      check();
    });
  }
  since(t) { return this.frames.filter(f => f.at >= t).length; }
  async quiet(ms, maxMs) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      const last = this.frames.length ? this.frames[this.frames.length - 1].at : 0;
      if (Date.now() - last >= ms) return true;
      await sleep(Math.min(ms, 100));
    }
    return false;
  }
}

function connectAgentStream(sockPath) {
  return new Promise(resolve => {
    const tap = new FrameTap();
    const sock = net.createConnection(sockPath);
    sock.on('connect', () => resolve({ ok: true, tap, send: b => sock.write(b), close: () => sock.destroy() }));
    sock.on('data', chunk => tap.push(chunk));
    sock.on('error', error => resolve({ ok: false, error: error.code || error.message }));
  });
}

function connectRelay(url) {
  const WebSocket = require('ws');
  return new Promise(resolve => {
    const tap = new FrameTap();
    const ws = new WebSocket(url);
    let opened = false;
    ws.on('open', () => {
      opened = true;
      resolve({ ok: true, tap, send: b => ws.send(b), close: () => ws.terminate(), closed: () => ws.readyState > 1 });
    });
    ws.on('message', (data, isBinary) => { if (isBinary) tap.push(Buffer.from(data)); });
    ws.on('unexpected-response', (_req, res) => resolve({ ok: false, error: `HTTP ${res.statusCode}` }));
    ws.on('error', error => { if (!opened) resolve({ ok: false, error: error.code || error.message }); });
  });
}

async function http(base, token, method, route, body, timeoutMs) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Access-Token'] = token;
  try {
    const res = await fetch(new URL(route, base), {
      method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text };
  } catch (error) {
    return { status: 0, error: error.cause?.code || error.name || error.message };
  }
}

function grantsHint(status) {
  const missing = [];
  if (status.accessibility === false) missing.push('Accessibility');
  if (status.postEvents === false) missing.push('Post Events');
  if (status.screenRecording === false) missing.push('Screen Recording');
  return missing;
}

async function streamCheck(conn, timing) {
  const { tap } = conn;
  conn.send(Buffer.from([REQ_KEY]));
  const started = Date.now();
  const gotKey = await tap.waitFor(() => tap.config && tap.frames.some(f => f.type === T_KEY), timing.firstFrameMs);
  if (!gotKey) {
    return {
      status: 'fail',
      detail: tap.config ? 'config arrived but no key frame' : 'no frames at all',
      hint: 'capture is not producing: Screen Recording grant, a sleeping or locked display, or a wedged ScreenCaptureKit stream (restart the Agent)',
    };
  }
  const { codec, width, height } = tap.config;
  return { status: 'ok', detail: `${codec} ${width}×${height}, first key frame in ${Date.now() - started} ms`, size: [width, height] };
}

// Hover a short path, then check (a) the real cursor ended on the last sample and
// (b) the picture produced frames — the two halves of "the tap did something".
async function inputCheck(conn, size, readCursor, timing) {
  const [w, h] = size;
  const before = await readCursor();
  const quiet = await conn.tap.quiet(timing.quietMs, timing.quietMaxMs);
  const base = before || [Math.round(w / 2), Math.round(h / 2)];
  const dir = base[0] > w - 60 ? -1 : 1;
  const path = [1, 2, 3, 4, 5].map(i => [
    Math.max(0, Math.min(w - 1, base[0] + dir * 6 * i)),
    Math.max(0, Math.min(h - 1, base[1] + 3 * i)),
  ]);
  const t0 = Date.now();
  for (const [x, y] of path) {
    conn.send(pointer(0, x, y));
    await sleep(timing.stepMs);
  }
  await sleep(timing.settleMs);
  const frames = conn.tap.since(t0);
  const after = await readCursor();
  if (before) conn.send(pointer(0, before[0], before[1]));
  const last = path[path.length - 1];
  const delivered = before && after ? Math.abs(after[0] - last[0]) <= 1 && Math.abs(after[1] - last[1]) <= 1 : null;
  const moved = before ? `cursor (${before}) → (${after}), expected (${last})` : 'Agent does not report the cursor (older Agent); moved it to the screen centre';
  const reacted = `${frames} frame(s) after the moves${quiet ? '' : ' (screen was already changing)'}`;
  if (delivered === false) {
    return { status: 'fail', detail: `${moved}; ${reacted}`, hint: 'input reached the Agent but no event was posted to macOS' };
  }
  if (quiet && frames === 0) {
    return delivered
      ? { status: 'fail', detail: `${moved}; ${reacted}`, hint: 'input works but the picture does not update: capture stalled — the App will look frozen while taps really land' }
      : { status: 'fail', detail: `${moved}; ${reacted}`, hint: 'no reaction at all; update the Agent (status.cursor) to tell lost input from a stalled capture' };
  }
  if (delivered === null && !quiet) return { status: 'warn', detail: `${moved}; ${reacted}`, hint: 'inconclusive: the screen kept changing and the Agent cannot report the cursor' };
  return { status: 'ok', detail: `${moved}; ${reacted}` };
}

async function runProbe(opts = {}) {
  const timing = { ...DEFAULT_TIMING, ...(opts.timing || {}) };
  const agentDir = opts.agentDir || process.env.MULTICC_AGENT_DIR || path.join(os.homedir(), '.multicc', 'agent');
  const base = opts.baseUrl || process.env.MULTICC_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;
  const token = opts.token ?? process.env.MULTICC_ACCESS_TOKEN ?? process.env.ACCESS_TOKEN ?? '';
  const move = opts.move !== false;
  const segments = [];
  const add = (id, result) => { segments.push({ id, ...result }); return result.status !== 'fail'; };
  const skip = (id, why) => segments.push({ id, status: 'skip', detail: why });
  const agentSock = path.join(agentDir, 'agent.sock');
  let status = null;
  const readCursor = async () => {
    const s = await agentCall(agentSock, { op: 'status', session: 'remote-screen' }, timing.requestMs);
    return Array.isArray(s.cursor) && s.cursor.length === 2 ? s.cursor : null;
  };

  // agent
  status = await agentCall(agentSock, { op: 'status', session: 'remote-screen' }, timing.requestMs);
  let agentOk;
  if (!status.ok) {
    agentOk = add('agent', { status: 'fail', detail: `${agentSock}: ${status.error}${status.detail ? ` (${status.detail})` : ''}`, hint: 'the MultiCC Agent is not running (LaunchAgent com.multicc.agent)' });
  } else {
    const missing = grantsHint(status);
    const halted = status.control?.halted === true;
    const bits = [`v${status.version}`, missing.length ? `missing ${missing.join(', ')}` : 'grants ok',
      status.screenLocked ? 'screen LOCKED' : 'unlocked', halted ? 'emergency stop ON' : 'not halted',
      Array.isArray(status.cursor) ? `cursor (${status.cursor})` : 'no cursor report'];
    const result = missing.length ? 'fail' : status.screenLocked || halted ? 'warn' : 'ok';
    agentOk = add('agent', {
      status: result,
      detail: bits.join(' · '),
      hint: missing.length ? 'grant them in System Settings → Privacy & Security, then restart the Agent'
        : status.screenLocked ? 'a locked screen shows the lock window and refuses most input' : halted ? 'Esc emergency stop is on: input is refused until resumed' : undefined,
    });
  }

  // capture + input, straight at the Agent
  let size = null;
  if (!agentOk) {
    skip('capture', 'agent failed');
    skip('input', 'agent failed');
  } else {
    const conn = await connectAgentStream(path.join(agentDir, 'h264.sock'));
    if (!conn.ok) {
      add('capture', { status: 'fail', detail: `h264.sock: ${conn.error}`, hint: 'older Agent or macOS < 14: only RFB / JPEG modes are available' });
      skip('input', 'capture failed');
    } else {
      const cap = await streamCheck(conn, timing);
      if (add('capture', cap) && move) add('input', await inputCheck(conn, cap.size, readCursor, timing));
      else skip('input', move ? 'capture failed' : '--no-move');
      size = cap.size || null;
      conn.close();
    }
  }

  // server, relay, relay input, HTTP input
  const caps = await http(base, token, 'GET', '/api/remote-screen/capabilities', null, timing.requestMs);
  const ticket = caps.status === 200
    ? await http(base, token, 'POST', '/api/auth/ws-ticket', { path: '/ws/remote-screen' }, timing.requestMs)
    : null;
  let serverOk;
  if (caps.status !== 200) {
    serverOk = add('server', {
      status: 'fail',
      detail: caps.status ? `capabilities → HTTP ${caps.status}` : `${base}: ${caps.error}`,
      hint: caps.status === 401 || caps.status === 403 ? 'pass --token (or MULTICC_ACCESS_TOKEN)' : 'is the MultiCC server running at this address?',
    });
  } else if (!ticket || ticket.status !== 200 || !ticket.json?.ticket) {
    serverOk = add('server', { status: 'fail', detail: `ws-ticket → HTTP ${ticket?.status}`, hint: 'pass --token (or MULTICC_ACCESS_TOKEN)' });
  } else {
    const h264 = caps.json?.streams?.h264;
    serverOk = add('server', {
      status: h264 === false ? 'warn' : 'ok',
      detail: `${base} · h264 ${h264 === true ? 'advertised' : h264 === false ? 'NOT advertised' : 'unknown'}`,
      hint: h264 === false ? 'the App will use RFB instead of H.264' : undefined,
    });
  }
  if (!serverOk) {
    skip('relay', 'server failed');
    skip('relay-input', 'server failed');
  } else {
    const wsUrl = new URL('/ws/remote-screen', base);
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    wsUrl.searchParams.set('mode', 'h264');
    wsUrl.searchParams.set('ticket', ticket.json.ticket);
    const conn = await connectRelay(wsUrl.toString());
    if (!conn.ok) {
      add('relay', { status: 'fail', detail: `WS: ${conn.error}`, hint: 'the server refused the H.264 relay' });
      skip('relay-input', 'relay failed');
    } else {
      const relay = await streamCheck(conn, timing);
      if (relay.status === 'fail') relay.hint = segments.find(s => s.id === 'capture')?.status === 'ok'
        ? 'the Agent streams fine directly, so the server bridge is dropping frames' : relay.hint;
      const relayOk = add('relay', relay);
      if (relayOk && move && segments.find(s => s.id === 'agent')?.status !== 'fail') {
        const res = await inputCheck(conn, relay.size || size, readCursor, timing);
        if (res.status === 'fail' && segments.find(s => s.id === 'input')?.status === 'ok') {
          res.hint = 'direct input works, so the server bridge is not forwarding input';
        }
        add('relay-input', res);
      } else skip('relay-input', relayOk ? (move ? 'agent failed' : '--no-move') : 'relay failed');
      conn.close();
    }
  }
  // The `pointer` op validates `viewer` before touching the Agent: an empty one
  // probes whether the running server knows the op, with no side effect.
  const probe = await http(base, token, 'POST', '/api/remote-screen/input', { op: 'pointer', viewer: '', mask: 0, x: 0, y: 0 }, timing.requestMs);
  const error = String(probe.json?.error || '');
  if (!probe.status) skip('http-input', 'server unreachable');
  else if (/op not allowed: pointer/.test(error)) {
    add('http-input', { status: 'warn', detail: 'running server predates the live `pointer` op', hint: 'JPEG / crop-mode drags still replay on release: restart the server to load the code on disk' });
  } else if (/viewer is required/.test(error)) add('http-input', { status: 'ok', detail: 'live pointer op available' });
  else add('http-input', { status: 'warn', detail: `unexpected reply: HTTP ${probe.status} ${probe.text?.slice(0, 120)}` });

  const firstFailure = segments.find(s => s.status === 'fail') || null;
  return { ok: !firstFailure, firstFailure: firstFailure?.id || null, segments };
}

function format(report) {
  const icon = { ok: '✔', warn: '!', fail: '✖', skip: '-' };
  const lines = report.segments.map(s => `${icon[s.status]} ${s.id.padEnd(12)} ${s.detail || ''}${s.hint ? `\n  ${''.padEnd(12)} → ${s.hint}` : ''}`);
  lines.push('');
  lines.push(report.firstFailure
    ? `First failing hop: ${report.firstFailure}. Hops after it were not trusted.`
    : 'Mac side and relay are healthy. If the App still looks frozen, read the "last frame" age in its status bar and check the App version.');
  return lines.join('\n');
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--no-move') opts.move = false;
    else if (a === '--base-url') opts.baseUrl = argv[++i];
    else if (a === '--token') opts.token = argv[++i];
    else if (a === '--agent-dir') opts.agentDir = argv[++i];
    else if (a === '-h' || a === '--help') opts.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

if (require.main === module) {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exit(2); }
  if (opts.help) {
    console.log('usage: node scripts/remote-screen-probe.js [--base-url URL] [--token T] [--agent-dir DIR] [--no-move] [--json]');
    process.exit(0);
  }
  runProbe(opts).then(report => {
    console.log(opts.json ? JSON.stringify(report, null, 2) : format(report));
    process.exit(report.ok ? 0 : 1);
  }, error => { console.error(error.stack || error.message); process.exit(2); });
}

module.exports = { runProbe, format, parseArgs, FrameTap };
