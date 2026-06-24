'use strict';

// ── Persistent streaming Claude process per chat session ──
//
// Why this exists: the default chat path spawns `claude -p ... <prompt>` once
// PER TURN and the process exits when the model yields its turn. That works,
// but a turn that ends in a "waiting for external data" state leaves nothing
// running — continuing requires a fresh `--resume` spawn (cold + can fail).
//
// This module keeps ONE `claude -p --input-format stream-json
// --output-format stream-json` process alive for the whole session. User
// messages are written as JSON lines on stdin; the model replies and the
// process STAYS ALIVE (verified: after a `result` event the process idles,
// ready for the next message, with full in-process context — no --resume).
//
// IMPORTANT (proven by experiment, not assumed): a persistent process does
// NOT auto-continue. The model still ends its turn (emits `result`) when it
// says "I'll wait for X". Resuming a waiting task still needs SOMETHING to
// send the next message — that's the "injector" layer, built separately. This
// module only provides the warm, in-context substrate + a clean inject() API.
//
// Process lifecycle:
//   • spawn lazily on first send(); reused for every later send()
//   • turn boundary = the `result` stream-json event (NOT process exit)
//   • the process is killed only on: explicit cancel, session close, or idle
//     timeout. Context survives an idle-kill because we spawn with
//     --session-id and respawn with --resume <same id>.

const { spawn } = require('child_process');

// session name -> state
//   { proc, sessionId, cwd, model, sysPrompt, cmd, baseArgs,
//     started (bool: has this sessionId ever run a turn → use --resume),
//     busy (bool: a turn is in flight), queue: [{text, onEvent, resolve, reject}],
//     current: {onEvent, resolve, reject} | null,
//     lineBuf, idleTimer, onExit }
const sessions = new Map();

const DEFAULT_IDLE_MS = 10 * 60 * 1000; // kill a warm-but-unused process after 10min

function isAlive(name) {
  const s = sessions.get(name);
  return !!(s && s.proc && s.proc.exitCode === null && !s.proc.killed);
}

function userMessageLine(text) {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  }) + '\n';
}

// (re)spawn the persistent process for a session. Uses --session-id the first
// time and --resume on any later respawn so context survives a process restart.
function spawnProc(name, cfg) {
  const s = sessions.get(name);
  const sessionArgs = s.started
    ? ['--resume', s.sessionId]
    : ['--session-id', s.sessionId];
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--dangerously-skip-permissions',
    ...(s.model ? ['--model', s.model] : []),
    ...(s.sysPrompt ? ['--append-system-prompt', s.sysPrompt] : []),
    ...(s.extraArgs || []),
    ...sessionArgs,
  ];

  // s.env is the FULL child env the caller already computed (process.env with
  // ANTHROPIC_* routing keys stripped + the session's provider env applied), so
  // use it verbatim — re-merging process.env here would re-introduce routing
  // vars that leaked into the server's own environment and break provider
  // selection. Fall back to a plain process.env merge if no env was supplied.
  const childEnv = s.env
    ? s.env
    : { ...process.env, TERM: 'dumb', NO_COLOR: '1' };
  const proc = spawn(s.cmd, args, {
    cwd: s.cwd,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  s.proc = proc;
  s.lineBuf = '';
  s.stderrTail = '';

  // Guard every handler against a STALE proc: a SIGTERM'd process can still emit
  // buffered stdout or fire 'exit' after it has been replaced by a respawn.
  // Ignoring events from a proc that is no longer s.proc prevents an old turn
  // from corrupting the state of the new one.
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
  s.lineBuf += chunk.toString();
  let i;
  while ((i = s.lineBuf.indexOf('\n')) >= 0) {
    const line = s.lineBuf.slice(0, i);
    s.lineBuf = s.lineBuf.slice(i + 1);
    if (!line.trim()) continue;
    let evt;
    try { evt = JSON.parse(line); } catch { continue; }

    // Capture the real session id if the CLI reports one (first turn / system init).
    if (evt.session_id && evt.session_id !== s.sessionId && evt.type === 'system') {
      // keep our id; CLI honors --session-id, but record just in case
    }

    if (s.current && typeof s.current.onEvent === 'function') {
      try { s.current.onEvent(evt); } catch (_) {}
    }

    // A `result` event marks the END of the current turn. The process stays
    // alive and ready for the next message.
    if (evt.type === 'result') {
      finishTurn(name, evt);
    }
  }
}

function finishTurn(name, resultEvt) {
  const s = sessions.get(name);
  if (!s) return;
  s.started = true;
  const cur = s.current;
  s.current = null;
  s.busy = false;
  if (cur && typeof cur.resolve === 'function') {
    cur.resolve({ result: resultEvt });
  }
  armIdle(name);
  // Drain any queued message now that the turn is done.
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
  // If a turn was in flight when the process died, reject it so the caller can
  // fall back / surface an error (the injector decides whether to retry).
  if (wasBusy && cur && typeof cur.reject === 'function') {
    const reason = err ? err.message : `stream proc exited code=${code}${signal ? '/' + signal : ''}: ${(s.stderrTail || '').slice(-200)}`;
    cur.reject(new Error(reason));
  }
  if (typeof s.onExit === 'function') {
    try { s.onExit({ code, signal, err: err || null, wasBusy }); } catch (_) {}
  }
  // Queued messages will respawn the process on the next pump().
  pump(name);
}

// Start the next queued message if the process is free.
function pump(name) {
  const s = sessions.get(name);
  if (!s || s.busy) return;
  const next = s.queue.shift();
  if (!next) return;

  if (!isAlive(name)) {
    try { spawnProc(name, s); }
    catch (e) { next.reject(e); return; }
  }
  s.busy = true;
  s.current = next;
  clearIdle(s);
  try {
    s.proc.stdin.write(userMessageLine(next.text));
    // NOTE: do NOT end() stdin — the process must stay open for future turns.
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
  s.idleTimer = setTimeout(() => {
    if (isAlive(name) && !s.busy && s.queue.length === 0) {
      try { s.proc.stdin.end(); } catch (_) {}
      // graceful close; context is recoverable via --resume on next send
    }
  }, s.idleMs || DEFAULT_IDLE_MS);
  if (s.idleTimer.unref) s.idleTimer.unref();
}

function clearIdle(s) {
  if (s && s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null; }
}

/**
 * Ensure a streaming session exists (does not spawn until first send()).
 * cfg: { cmd, cwd, sessionId, model?, sysPrompt?, extraArgs?, env?, idleMs?, onExit? }
 */
function ensure(name, cfg) {
  let s = sessions.get(name);
  if (!s) {
    s = {
      cmd: cfg.cmd,
      cwd: cfg.cwd,
      sessionId: cfg.sessionId,
      model: cfg.model || null,
      sysPrompt: cfg.sysPrompt || null,
      extraArgs: cfg.extraArgs || [],
      env: cfg.env || {},
      idleMs: cfg.idleMs || DEFAULT_IDLE_MS,
      onExit: cfg.onExit || null,
      proc: null, started: false, busy: false,
      queue: [], current: null, lineBuf: '', stderrTail: '',
      idleTimer: null,
    };
    sessions.set(name, s);
  } else {
    // Allow per-turn overrides (model/system prompt/provider env can change between turns).
    if (cfg.model !== undefined) s.model = cfg.model;
    if (cfg.sysPrompt !== undefined) s.sysPrompt = cfg.sysPrompt;
    if (cfg.env !== undefined) s.env = cfg.env;
  }
  return s;
}

/**
 * Send a user message and resolve when that turn completes (`result` event).
 * onEvent receives every stream-json event for live forwarding to the UI.
 * Turns are serialized per session: a send while a turn is in flight queues.
 */
function send(name, text, onEvent) {
  const s = sessions.get(name);
  if (!s) return Promise.reject(new Error(`stream session "${name}" not ensured`));
  return new Promise((resolve, reject) => {
    s.queue.push({ text, onEvent, resolve, reject });
    pump(name);
  });
}

/**
 * Inject a continuation message — semantically identical to send(), named
 * separately so callers (the waiting-injector) read clearly. This is the API
 * the "data returned, continue" driver uses.
 */
function inject(name, text, onEvent) {
  return send(name, `${text}`, onEvent);
}

// Kill the current turn (and process). Context is recoverable via --resume.
function cancel(name) {
  const s = sessions.get(name);
  if (!s) return;
  // Reject queued sends so callers don't hang.
  const pending = s.queue.splice(0);
  for (const q of pending) { try { q.reject(new Error('cancelled')); } catch (_) {} }
  if (s.proc) { try { s.proc.kill('SIGTERM'); } catch (_) {} }
}

// Fully tear down (session deleted).
function close(name) {
  cancel(name);
  const s = sessions.get(name);
  if (s) clearIdle(s);
  sessions.delete(name);
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
  };
}

module.exports = { ensure, send, inject, cancel, close, isAlive, status };
