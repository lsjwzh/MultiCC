'use strict';

const { spawn } = require('node:child_process');

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
//   • Background-task notifications do not exist on this protocol (the codex-exp
//     adapter decodes none), so there is no shadow-tail hold: idle reclaim is
//     unconditional.

// session name -> state
//   { proc, cmd, baseArgs, cwd, env, threadId, started, busy,
//     queue: [{text, turn, onEvent, resolve, reject}], current, lineBuf,
//     stderrTail, idleTimer, recycling, recycleRequested, spawnedFingerprint }
const sessions = new Map();

const DEFAULT_IDLE_MS = 10 * 60 * 1000; // reclaim a warm-but-unused app-server after 10min
const CLOSE_KILL_GRACE_MS = 1_500;
const RECYCLE_KILL_GRACE_MS = 3_000;

function isAlive(name) {
  const s = sessions.get(name);
  return !!(s && s.proc && s.proc.exitCode === null && !s.proc.killed);
}

// Routing keys of a codex child. `codex app-server` reads its upstream from the
// OPENAI_* environment at spawn, so a provider / base-url / key switch is
// invisible to a live process until it respawns — the same trap chat-stream
// documents for ANTHROPIC_*, on the other protocol.
function routeFingerprint(env) {
  if (!env || typeof env !== 'object') return '';
  return Object.keys(env)
    .filter((k) => k.startsWith('OPENAI_'))
    .sort()
    .map((k) => `${k}=${env[k]}`)
    .join('\n');
}

function spawnProc(name, s) {
  const args = s.threadId ? [...s.baseArgs, '--thread-id', s.threadId] : [...s.baseArgs];
  const proc = spawn(s.cmd, args, {
    cwd: s.cwd,
    env: s.env && Object.keys(s.env).length ? s.env : { ...process.env, TERM: 'dumb', NO_COLOR: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  s.proc = proc;
  s.spawnedFingerprint = routeFingerprint(s.env);
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
  proc.on('exit', (code, signal) => { if (sessions.get(name)?.proc === proc) onExit(name, code, signal); });
  proc.on('error', (err) => { if (sessions.get(name)?.proc === proc) onExit(name, null, null, err); });
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
    if (!evt || !evt.method) continue;
    if (s.current) s.current.eventCount += 1;
    if (s.current && typeof s.current.onEvent === 'function') {
      try { s.current.onEvent(evt); } catch (_) {}
    }
    // Learn the server-allocated thread id as soon as the app-server announces
    // it, so a respawn (crash, recycle, idle reclaim) resumes this conversation
    // instead of silently starting an empty one.
    if (evt.method === 'thread/started') {
      const id = evt.params?.thread?.id || evt.params?.thread?.sessionId || null;
      if (id) s.threadId = id;
    }
    // A `turn/completed` notification marks the END of the turn. The app-server
    // and the thread stay alive, ready for the next line on stdin.
    if (evt.method === 'turn/completed') finishTurn(name, evt);
  }
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
// zombie beats a session that accepts no messages.
function killForRecycle(name, s) {
  const proc = s.proc;
  s.recycling = true;
  clearIdle(s);
  try { proc.kill('SIGTERM'); }
  catch (_) {
    s.recycling = false;
    setImmediate(() => pump(name));
    return false;
  }
  const escalate = setTimeout(() => {
    if (s.proc !== proc || !s.recycling) return;
    try { proc.kill('SIGKILL'); } catch (_) {}
    const release = setTimeout(() => {
      if (s.proc !== proc || !s.recycling) return;
      s.recycling = false;
      pump(name);
    }, RECYCLE_KILL_GRACE_MS);
    if (release.unref) release.unref();
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
  const next = s.queue.shift();
  if (!next) return;

  // Routing env changed since this child spawned: the live app-server still
  // talks to the OLD upstream. Recycle at this turn boundary — safe by
  // construction, because we only get here when no turn is in flight, and the
  // thread survives the respawn.
  if (isAlive(name) && s.spawnedFingerprint !== null &&
      routeFingerprint(s.env) !== s.spawnedFingerprint) {
    s.queue.unshift(next);
    s.recycleRequested = false;
    killForRecycle(name, s);
    return;
  }
  if (isAlive(name) && s.recycleRequested) {
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
  if (!s || !isAlive(name) || s.busy || s.queue.length > 0) return;
  try { s.proc.stdin.end(); } catch (_) {}
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
      proc: null, started: !!cfg.sessionId, busy: false,
      queue: [], current: null, lineBuf: '', stderrTail: '',
      idleTimer: null, jsonlParseErrors: 0,
      recycling: false, spawnedFingerprint: null, recycleRequested: false,
    };
    sessions.set(name, s);
  } else {
    if (cfg.baseArgs !== undefined) s.baseArgs = cfg.baseArgs;
    if (cfg.env !== undefined) s.env = cfg.env;
    if (cfg.onExit !== undefined) s.onExit = cfg.onExit;
    if (cfg.onDispose !== undefined) s.onDispose = cfg.onDispose;
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
 *   now | deferred-boundary | not-running | kill-failed
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
    try { s.proc.kill('SIGTERM'); } catch (_) {}
    armKillEscalation(s.proc, CLOSE_KILL_GRACE_MS);
  }
}

function close(name) {
  const s = sessions.get(name);
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
}

// Same contract as chat-stream's: the map entry being gone proves no new turn can
// use the child, but callers that must clean up transcript files also need the
// process to have actually exited (SIGKILL escalation included).
function closeAndWait(name, { timeoutMs = CLOSE_KILL_GRACE_MS + 1_000 } = {}) {
  const numericTimeout = Number(timeoutMs);
  if (!Number.isFinite(numericTimeout) || numericTimeout < 1) {
    return Promise.reject(Object.assign(new TypeError('valid close timeout required'), {
      code: 'CODEX_APP_STREAM_CLOSE_TIMEOUT_INVALID',
    }));
  }
  const processState = sessions.get(name)?.proc || null;
  if (!processState || processState.exitCode !== null) {
    close(name);
    return Promise.resolve(Object.freeze({ closed: true, hadProcess: false }));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { processState.removeListener('exit', onExitEvt); } catch (_) {}
      if (error) reject(error);
      else resolve(Object.freeze({ closed: true, hadProcess: true }));
    };
    const onExitEvt = () => finish();
    try { processState.once('exit', onExitEvt); } catch (cause) {
      finish(Object.assign(new Error('cannot join app-server process', { cause }), {
        code: 'CODEX_APP_STREAM_CLOSE_JOIN_FAILED',
      }));
      return;
    }
    timer = setTimeout(() => finish(Object.assign(
      new Error('app-server process did not exit before the cleanup deadline'),
      { code: 'CODEX_APP_STREAM_CLOSE_TIMEOUT' },
    )), numericTimeout);
    close(name);
    if (processState.exitCode !== null) finish();
  });
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
  };
}

module.exports = {
  createCodexAppStream: () => ({
    ensure, send, inject, cancel, close, closeAndWait, isAlive, status, recycle,
  }),
};
