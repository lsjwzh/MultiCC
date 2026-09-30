'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { releaseResidentRoute, retainResidentRoute } = require('../codex/resident-route');

// ── Resident codex app-server process per chat session ──
//
// `codex app-server --listen stdio://` is a long-lived JSON-RPC server, but the
// codex-exp lane used to wrap it one-shot: the bridge got the prompt in argv and
// SIGTERM'd the server on `turn/completed`, so every turn re-opened its thread.
// This module is the other half of the resident lane (the bridge learned to keep
// the server and thread alive in `--resident`): ONE bridge child per session,
// one JSON turn request per line on stdin, turn boundary = the `turn/completed`
// notification rather than process exit.
//
// Same facade and same guarantees as chat-stream.js, deliberately: every session
// lifecycle caller (cancellation, hibernation, deletion, pruning, shutdown) goes
// through stream-router, which binds them by protocol. Differences that are real
// and intentional:
//
//   • The bridge is the normalizer. It forwards the app-server's own
//     notifications on stdout, so the host decodes them with the same
//     codex-exp adapter it used on the per-turn lane. Nothing here re-frames
//     protocol traffic.
//   • The native session id (the thread id) is SERVER-allocated and arrives as a
//     `thread/started` notification, so this module never mints an id — the host
//     captures it from the decoded event like any other codex session.
//   • There is no in-process interrupt. The app-server's turn/interrupt is not
//     reachable through the bridge, so cancel() stops the CHILD; the thread
//     survives on disk and the next turn re-attaches with `--thread-id`.
//   • Background-task notifications do not exist on the codex protocol (the
//     codex-exp adapter decodes none), so idle reclaim is unconditional there.
//
// The zcode lane (`streamBackend: 'zcode-app-server'`) rides the same machinery
// with its own wire protocol: its bridge (zcode-bridge.cjs `--resident`) emits
// the opencode-shaped events its adapter decodes, plus two private lines — a
// turn-end sentinel and the live background-task count. Background work lives
// inside the engine process, so while any is running this child is never
// reclaimed or recycled (the bridge holds the host turn open over self-wake
// turns; after that, the child simply stays up until the work ends).

// session name -> state
//   { proc, cmd, baseArgs, cwd, env, threadId, started, busy,
//     queue: [{text, turn, onEvent, resolve, reject}], current, lineBuf,
//     stderrTail, idleTimer, recycling, recycleRequested, spawnedFingerprint }
const sessions = new Map();

const DEFAULT_IDLE_MS = 10 * 60 * 1000; // reclaim a warm-but-unused app-server after 10min
const CLOSE_KILL_GRACE_MS = 1_500;
const RECYCLE_KILL_GRACE_MS = 3_000;
const closer = require('./process-close').createProcessCloser({
  timeoutMs: CLOSE_KILL_GRACE_MS + 1_000, code: 'CODEX_APP_STREAM_CLOSE_TIMEOUT',
});

function isAlive(name) {
  const s = sessions.get(name);
  return !!(s && s.proc && s.proc.exitCode === null && !s.proc.killed);
}

// Routing keys of a codex child. `codex app-server` reads its upstream from the
// OPENAI_* environment at spawn, so a provider / base-url / key switch is
// invisible to a live process until it respawns — the same trap chat-stream
// documents for ANTHROPIC_*, on the other protocol.
//
// CODEX_HOME belongs here for the same reason and on the same footing: it holds
// config.toml, which is where this protocol's base_url actually lives. A
// resident child's home is swapped rather than rewritten when its managed route
// moves (only a respawn can move it), so a home that moved must read as a
// routing change — without this key the child would keep talking to the retired
// route for the rest of its life.
function routeFingerprint(env) {
  if (!env || typeof env !== 'object') return '';
  return Object.keys(env)
    .filter((k) => k.startsWith('OPENAI_') || k === 'CODEX_HOME')
    .sort()
    .map((k) => `${k}=${env[k]}`)
    .join('\n');
}

// ZCode reads its route from files, not env: the private HOME's settings file and
// the engine's provider_config.json. A provider switch rewrites them in place, so
// only their content digest can show that the live engine is on the old route.
// Digest only — the contents carry credentials and never leave this function.
function fileDigest(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16); }
  catch (_) { return '-'; }
}

function zcodeFingerprint(env) {
  if (!env || typeof env !== 'object') return '';
  const keys = Object.keys(env).filter((k) => k === 'HOME' || k.startsWith('ZCODE_')).sort();
  const lines = keys.map((k) => `${k}=${env[k]}`);
  const dataDir = env.ZCODE_DATA_BASE_DIR || env.HOME;
  if (env.ZCODE_SETTINGS) lines.push(`settings#${fileDigest(env.ZCODE_SETTINGS)}`);
  if (dataDir) lines.push(`provider#${fileDigest(path.join(dataDir, '.zcode', 'v2', 'provider_config.json'))}`);
  return lines.join('\n');
}

const ZCODE_TURN_END = 'multicc_turn_end';
const ZCODE_BACKGROUND = 'multicc_background';

// Per-protocol wire facts. `read(evt)` classifies one stdout line:
//   forward — hand it to the turn's onEvent (the adapter decodes it)
//   nativeId — the server-allocated conversation id, if the line announces one
//   done — the line ends the current turn
//   background — the live background-task count, if the line reports one
const PROTOCOLS = {
  codex: {
    fingerprint: routeFingerprint,
    resumeArgs: (baseArgs, id) => (id ? [...baseArgs, '--thread-id', id] : [...baseArgs]),
    retainsHome: true,
    read(evt) {
      if (!evt || !evt.method) return null;
      const nativeId = evt.method === 'thread/started'
        ? (evt.params?.thread?.id || evt.params?.thread?.sessionId || null) : null;
      return { forward: true, nativeId, done: evt.method === 'turn/completed' };
    },
  },
  zcode: {
    fingerprint: zcodeFingerprint,
    // The adapter already puts `--session <id>` on non-first turns; the id the
    // child learned wins so a respawn never forks a fresh conversation.
    resumeArgs(baseArgs, id) {
      const args = [];
      for (let i = 0; i < baseArgs.length; i += 1) {
        if (baseArgs[i] === '--session') { i += 1; continue; }
        args.push(baseArgs[i]);
      }
      return id ? ['--session', id, ...args] : args;
    },
    retainsHome: false,
    read(evt) {
      if (!evt || typeof evt.type !== 'string') return null;
      if (evt.type === ZCODE_TURN_END) return { forward: false, done: true };
      if (evt.type === ZCODE_BACKGROUND) {
        return { forward: false, background: Math.max(0, Number(evt.active) || 0) };
      }
      const nativeId = typeof evt.sessionID === 'string' && evt.sessionID.startsWith('sess_')
        ? evt.sessionID : null;
      return { forward: true, nativeId, done: false };
    },
  },
};
const protocolOf = (backend) => (backend === 'zcode-app-server' ? 'zcode' : 'codex');

function spawnProc(name, s) {
  s.beforeSpawn?.({ sessionId: s.threadId });
  const protocol = PROTOCOLS[s.protocol];
  const args = protocol.resumeArgs(s.baseArgs, s.threadId);
  const proc = spawn(s.cmd, args, {
    cwd: s.cwd,
    env: s.env && Object.keys(s.env).length ? s.env : { ...process.env, TERM: 'dumb', NO_COLOR: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  s.proc = proc;
  if (protocol.retainsHome) proc.once('close', retainResidentRoute(s.env?.CODEX_HOME));
  s.spawnedFingerprint = protocol.fingerprint(s.env);
  s.backgroundActive = 0;
  s.lineBuf = '';
  s.stderrTail = '';
  s.jsonlParseErrors = 0;

  // Guard against a stale proc: a SIGTERM'd child can still emit buffered output
  // or fire 'exit' after a respawn replaced it.
  proc.stdout.on('data', (chunk) => { if (sessions.get(name)?.proc === proc) onStdout(name, chunk); });
  proc.stderr.on('data', (chunk) => {
    if (sessions.get(name)?.proc !== proc) return;
    s.stderrTail = (s.stderrTail + chunk.toString()).slice(-1000);
  });
  proc.stdin.on('error', () => {
    if (sessions.get(name)?.proc !== proc) return;
    s.recycling = true;
    try { proc.kill('SIGTERM'); } catch (_) {}
    armKillEscalation(proc, CLOSE_KILL_GRACE_MS);
  });
  proc.on('exit', (code, signal) => { if (sessions.get(name)?.proc === proc) onExit(name, code, signal); });
  proc.on('error', (err) => {
    if (sessions.get(name)?.proc !== proc) return;
    if (!proc.pid) onExit(name, null, null, err); else s.recycling = true;
  });
  return proc;
}

function onStdout(name, chunk) {
  const s = sessions.get(name);
  if (!s) return;
  if (s.current && !s.current.firstByteReported && typeof s.current.onTiming === 'function') {
    s.current.firstByteReported = true;
    try { s.current.onTiming('firstByte'); } catch (_) {}
  }
  s.lineBuf += chunk.toString();
  let i;
  while ((i = s.lineBuf.indexOf('\n')) >= 0) {
    const line = s.lineBuf.slice(0, i);
    s.lineBuf = s.lineBuf.slice(i + 1);
    if (!line.trim()) continue;
    let evt;
    try { evt = JSON.parse(line); }
    catch {
      s.jsonlParseErrors += 1;
      if (s.jsonlParseErrors <= 5) {
        console.warn(`[multicc/codex-app-stream] [${name}] malformed JSON line dropped (#${s.jsonlParseErrors}, ${line.length} bytes)`);
      }
      continue;
    }
    const read = PROTOCOLS[s.protocol].read(evt);
    if (!read) continue;
    if (read.forward) {
      if (s.current) s.current.eventCount += 1;
      if (s.current && typeof s.current.onEvent === 'function') {
        try { s.current.onEvent(evt); } catch (_) {}
      }
    }
    // Learn the server-allocated id as soon as the server announces it, so a
    // respawn (crash, recycle, idle reclaim) resumes this conversation instead
    // of silently starting an empty one.
    if (read.nativeId) s.threadId = read.nativeId;
    if (read.background !== undefined) onBackground(name, read.background);
    // The turn boundary. The server and the conversation stay alive, ready for
    // the next line on stdin.
    if (read.done) finishTurn(name, evt);
  }
}

// Background work lives in the child: while any runs, idle reclaim and recycles
// wait. When the last one ends on an idle child, apply what waited.
function onBackground(name, active) {
  const s = sessions.get(name);
  if (!s) return;
  const was = s.backgroundActive;
  s.backgroundActive = active;
  if (s.busy || s.recycling || !isAlive(name)) return;
  if (active > 0) { clearIdle(s); return; }
  if (!was) return;
  if (s.recycleRequested && s.queue.length === 0) {
    s.recycleRequested = false;
    killForRecycle(name, s);
    return;
  }
  armIdle(name);
}

function finishTurn(name, evt) {
  const s = sessions.get(name);
  if (!s) return;
  s.started = true;
  const cur = s.current;
  s.current = null;
  s.busy = false;
  if (cur && typeof cur.resolve === 'function') cur.resolve({ result: evt });
  armIdle(name);
  pump(name);
}

function onExit(name, code, signal, err) {
  const s = sessions.get(name);
  if (!s) return;
  clearIdle(s);
  const wasBusy = s.busy;
  const cur = s.current;
  s.proc = null;
  s.busy = false;
  s.current = null;
  s.recycling = false;
  s.spawnedFingerprint = null;
  s.backgroundActive = 0;
  if (wasBusy && cur && typeof cur.reject === 'function') {
    cur.reject(new Error(err
      ? err.message
      : `app-server exited code=${code}${signal ? '/' + signal : ''}: ${(s.stderrTail || '').slice(-200)}`));
  }
  if (typeof s.onExit === 'function') {
    try { s.onExit({ code, signal, err: err || null, wasBusy }); } catch (_) {}
  }
  pump(name);
}

// SIGTERM the child so onExit → pump respawns it re-attached to the same thread.
// The caller must already have re-queued whatever turn triggered this. The
// escalation exists for the same reason as chat-stream's: a child that ignores
// SIGTERM would otherwise wedge the session forever, and a respawn alongside a
// second writer must never start alongside an unconfirmed old one.
function killForRecycle(name, s) {
  const proc = s.proc;
  s.recycling = true;
  clearIdle(s);
  // A signal error is not exit evidence. Keep the fence until onExit.
  try { proc.kill('SIGTERM'); } catch (_) {}
  const escalate = setTimeout(() => {
    if (s.proc !== proc || !s.recycling) return;
    try { proc.kill('SIGKILL'); } catch (_) {}
  }, RECYCLE_KILL_GRACE_MS);
  if (escalate.unref) escalate.unref();
  return true;
}

function turnLine(text, turn) {
  const model = turn && turn.model ? { model: turn.model } : {};
  const effort = turn && turn.effort ? { effort: turn.effort } : {};
  return `${JSON.stringify({ text, ...model, ...effort })}\n`;
}

function pump(name) {
  const s = sessions.get(name);
  if (!s || s.busy || s.recycling) return;
  if (closer.isClosing(name)) {
    if (!s.joiningClose) {
      s.joiningClose = true;
      void closer.drained(name).then(() => { s.joiningClose = false; pump(name); });
    }
    return;
  }
  const next = s.queue.shift();
  if (!next) return;

  // Routing env changed since this child spawned: the live app-server still
  // talks to the OLD upstream. Recycle at this turn boundary — safe by
  // construction, because we only get here when no turn is in flight, and the
  // thread survives the respawn. Live background work owns the child, though:
  // the turn is refused (as chat-stream does) rather than run on the old route
  // or kill the work.
  if (isAlive(name) && s.spawnedFingerprint !== null &&
      PROTOCOLS[s.protocol].fingerprint(s.env) !== s.spawnedFingerprint) {
    if (s.backgroundActive > 0) {
      next.reject(Object.assign(new Error('Background work still owns the process'), { code: 'CHAT_BACKGROUND_ACTIVE' }));
      return;
    }
    s.queue.unshift(next);
    s.recycleRequested = false;
    killForRecycle(name, s);
    return;
  }
  // An explicit recycle waits past live background work (see onBackground);
  // the turn runs on the current child meanwhile.
  if (isAlive(name) && s.recycleRequested && !(s.backgroundActive > 0)) {
    s.queue.unshift(next);
    s.recycleRequested = false;
    killForRecycle(name, s);
    return;
  }

  if (!isAlive(name)) {
    try { spawnProc(name, s); }
    catch (e) { next.reject(e); return; }
  }
  s.busy = true;
  s.current = next;
  clearIdle(s);
  if (typeof next.onTiming === 'function') {
    try { next.onTiming('spawned'); } catch (_) {}
  }
  try {
    s.proc.stdin.write(turnLine(next.text, next.turn));
    // Never end() stdin — that is this lane's shutdown signal, not a turn boundary.
    if (typeof next.onTiming === 'function') {
      try { next.onTiming('sent'); } catch (_) {}
    }
  } catch (e) {
    s.busy = false;
    s.current = null;
    next.reject(e);
  }
}

function armIdle(name) {
  const s = sessions.get(name);
  if (!s) return;
  clearIdle(s);
  s.idleTimer = setTimeout(() => reclaimIfIdle(name), s.idleMs || DEFAULT_IDLE_MS);
  if (s.idleTimer.unref) s.idleTimer.unref();
}

// Ending stdin is the bridge's graceful-shutdown signal: it stops the
// app-server and exits. The thread is already durable on codex's side, so the
// next send re-attaches with `--thread-id`.
function reclaimIfIdle(name) {
  const s = sessions.get(name);
  if (!s || !isAlive(name) || s.busy || s.queue.length > 0 || s.backgroundActive > 0) return;
  s.recycling = true;
  try { s.proc.stdin.end(); } catch (_) {}
  armKillEscalation(s.proc, CLOSE_KILL_GRACE_MS);
}

function clearIdle(s) {
  if (s && s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null; }
}

/**
 * Ensure a resident app-server session exists (does not spawn until first send()).
 * cfg: { cmd, cwd, baseArgs, sessionId?, env?, idleMs?, onExit?, onDispose? }
 * `sessionId` is an existing codex thread id to re-attach to, if the session has one.
 */
function ensure(name, cfg) {
  let s = sessions.get(name);
  if (!s) {
    s = {
      cmd: cfg.cmd,
      cwd: cfg.cwd,
      baseArgs: cfg.baseArgs || [],
      threadId: cfg.sessionId || null,
      env: cfg.env || {},
      idleMs: cfg.idleMs || DEFAULT_IDLE_MS,
      onExit: cfg.onExit || null,
      onDispose: cfg.onDispose || null,
      beforeSpawn: cfg.beforeSpawn || null,
      protocol: protocolOf(cfg.streamBackend),
      proc: null, started: !!cfg.sessionId, busy: false, backgroundActive: 0,
      queue: [], current: null, lineBuf: '', stderrTail: '',
      idleTimer: null, jsonlParseErrors: 0,
      recycling: false, spawnedFingerprint: null, recycleRequested: false,
    };
    sessions.set(name, s);
  } else {
    const protocol = protocolOf(cfg.streamBackend);
    if (protocol !== s.protocol) {
      // Another CLI took the session over: its conversation id and child are
      // not this protocol's. Replace the child at the next boundary.
      s.protocol = protocol;
      s.threadId = null;
      s.recycleRequested = isAlive(name);
    }
    if (cfg.baseArgs !== undefined) s.baseArgs = cfg.baseArgs;
    if (cfg.env !== undefined) s.env = cfg.env;
    if (cfg.onExit !== undefined) s.onExit = cfg.onExit;
    if (cfg.onDispose !== undefined) s.onDispose = cfg.onDispose;
    if (cfg.beforeSpawn !== undefined) s.beforeSpawn = cfg.beforeSpawn;
    if (cfg.sessionId) s.threadId = cfg.sessionId;
  }
  return s;
}

/**
 * Send one turn and resolve when the app-server reports `turn/completed`.
 * opts.turn carries per-turn model/effort overrides; opts.onTiming reports the
 * same three instants the claude lane does.
 */
function send(name, text, onEvent, opts = {}) {
  const s = sessions.get(name);
  if (!s) return Promise.reject(new Error(`codex app-server session "${name}" not ensured`));
  return new Promise((resolve, reject) => {
    s.queue.push({
      text, turn: opts.turnOptions || null, onEvent, resolve, reject,
      onTiming: opts.onTiming || null, eventCount: 0, firstByteReported: false,
    });
    pump(name);
  });
}

function inject(name, text, onEvent, opts = {}) {
  return send(name, `${text}`, onEvent, opts);
}

/**
 * Replace the child so it picks up a new routing env / spawn args. Applied at a
 * turn boundary, never mid-turn. Returns how the request landed:
 *   now | deferred-boundary | deferred-background | not-running | kill-failed
 */
function recycle(name, reason) {
  const s = sessions.get(name);
  if (!s) return { ok: false, applied: 'unknown-session' };
  s.recycleReason = reason || 'recycle';
  if (!isAlive(name)) return { ok: true, applied: 'not-running' };
  if (s.busy || s.queue.length > 0 || s.recycling) {
    s.recycleRequested = true;
    return { ok: true, applied: 'deferred-boundary' };
  }
  if (s.backgroundActive > 0) {
    s.recycleRequested = true;
    return { ok: true, applied: 'deferred-background' };
  }
  s.recycleRequested = false;
  return killForRecycle(name, s)
    ? { ok: true, applied: 'now' }
    : { ok: false, applied: 'kill-failed' };
}

function armKillEscalation(proc, graceMs) {
  const killer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} }, graceMs);
  if (killer.unref) killer.unref();
  try { proc.once('exit', () => clearTimeout(killer)); } catch (_) {}
}

// Stop the current turn by stopping the child. Unlike the claude lane there is
// no in-process interrupt to ask for, so the session is torn down; the thread
// survives on disk and the next turn re-attaches.
function cancel(name) {
  const s = sessions.get(name);
  if (!s) return;
  const pending = s.queue.splice(0);
  for (const q of pending) { try { q.reject(new Error('cancelled')); } catch (_) {} }
  if (s.proc) {
    s.recycling = true;
    try { s.proc.kill('SIGTERM'); } catch (_) {}
    armKillEscalation(s.proc, CLOSE_KILL_GRACE_MS);
  }
}

function close(name) {
  const s = sessions.get(name);
  closer.track(name, s?.proc);
  cancel(name);
  if (!s) return;
  clearIdle(s);
  const cur = s.current;
  s.current = null;
  s.busy = false;
  s.proc = null;
  if (cur && typeof cur.reject === 'function') {
    try { cur.reject(new Error('codex app-server session closed')); } catch (_) {}
  }
  try { s.onDispose?.(); } catch (_) {}
  sessions.delete(name);
  // Retire the session route now; its directory stays pinned until proc.close.
  // Recycle keeps the session route so the next child can reuse the same home.
  releaseResidentRoute(name);
}

// Same contract as chat-stream's: the map entry being gone proves no new turn can
// use the child, but callers that must clean up transcript files also need the
// process to have actually exited (SIGKILL escalation included).
function closeAndWait(name, opts) {
  return closer.wait(name, () => close(name), opts);
}

function status(name) {
  const s = sessions.get(name);
  if (!s) return null;
  return {
    alive: isAlive(name),
    busy: s.busy,
    queued: s.queue.length,
    started: s.started,
    pid: s.proc ? s.proc.pid : null,
    threadId: s.threadId,
    recycling: s.recycling,
    recycleRequested: s.recycleRequested,
    backend: s.protocol,
    backgroundActive: s.backgroundActive > 0,
  };
}

module.exports = {
  createCodexAppStream: () => ({
    ensure, send, inject, cancel, close, closeAndWait, isAlive, status, recycle, isClosing: closer.isClosing,
    waitForClose: (name, opts) => closer.wait(name, () => {}, opts),
  }),
};
