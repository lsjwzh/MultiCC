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

const crypto = require('crypto');
const { spawn } = require('child_process');

// session name -> state
//   { proc, sessionId, cwd, cmd, baseArgs,
//     started (bool: has this sessionId ever run a turn → use --resume),
//     busy (bool: a turn is in flight), queue: [{text, onEvent, resolve, reject}],
//     current: {onEvent, resolve, reject} | null,
//     lineBuf, idleTimer, onExit, onNewSessionId, onResumeTargetMissing }
const sessions = new Map();

const DEFAULT_IDLE_MS = 10 * 60 * 1000; // kill a warm-but-unused process after 10min
// Ceiling on how long a process may be HELD past idle purely because a
// background task is still registered as live. A genuinely-working task keeps
// refreshing this window (each background event resets idleHeldSince), so the
// ceiling only bites a task that has been registered-but-silent for the whole
// window — i.e. a leaked/stuck shadow. When it trips, the process is reclaimed
// and the exit path reaps the shadows + surfaces `interrupted`.
const DEFAULT_IDLE_MAX_HOLD_MS = 2 * 60 * 60 * 1000; // 2h
// How long cancel()/close() let a SIGTERM'd process exit on its own before
// SIGKILL. Matches the cancel path's grace window in session-work-host.
const CLOSE_KILL_GRACE_MS = 1_500;
// How long a recycle waits for a graceful exit before escalating (and again before
// giving up on the exit event entirely). Longer than the close path: a recycle is
// not urgent, and the prompt exits on its own once stdin quiesces.
const RECYCLE_KILL_GRACE_MS = 3_000;

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

// Stable fingerprint of the ANTHROPIC_* routing keys in a child env. A running
// `-p` process bakes these at spawn time (ANTHROPIC_BASE_URL carries the
// provider id + session, plus auth token / model aliases), so once the desired
// env's routing keys change — a provider / token / model-alias switch — the
// live process is talking to the OLD upstream until it respawns. Only the
// ANTHROPIC_* keys decide the upstream, so unrelated env churn never produces a
// spurious recycle. Fingerprinting `s.env` (the source pump() compares) keeps
// the "no env supplied" case an empty string on both sides → never recycles.
function routeFingerprint(env) {
  if (!env || typeof env !== 'object') return '';
  return Object.keys(env)
    .filter((k) => k.startsWith('ANTHROPIC_'))
    .sort()
    .map((k) => `${k}=${env[k]}`)
    .join('\n');
}

// (re)spawn the persistent process for a session. Uses --session-id the first
// time and --resume on any later respawn so context survives a process restart.
function spawnProc(name, cfg) {
  const s = sessions.get(name);
  if (typeof s.beforeSpawn === 'function') s.beforeSpawn({ sessionId: s.sessionId });
  const resuming = s.started;
  const sessionArgs = resuming
    ? ['--resume', s.sessionId]
    : ['--session-id', s.sessionId];
  const args = [...s.baseArgs, ...sessionArgs];

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
  s.lastSpawnWasResume = resuming;
  // Record the routing fingerprint this process was actually spawned with, so a
  // later provider/env switch (which updates s.env via ensure()) is detectable
  // at the next turn boundary and triggers a --resume respawn.
  s.spawnedFingerprint = routeFingerprint(s.env);
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

function isMissingResumeResult(evt) {
  if (!evt || evt.type !== 'result' || evt.is_error !== true) return false;
  const messages = [
    ...(Array.isArray(evt.errors) ? evt.errors : []),
    typeof evt.error === 'string' ? evt.error : evt.error && evt.error.message,
    evt.result,
  ];
  return messages.some((message) => (
    /No conversation found with session ID\s*:/i.test(String(message || ''))
  ));
}

// A persisted streaming id only proves that MultiCC allocated an id; it does
// not prove Claude still has the corresponding transcript. Claude reports a
// missing `--resume` target as a stream-json result (not stderr / process
// failure), so the ordinary exit recovery cannot see it. Recover below the
// provider layer: no provider request ran, and requiring this to be the first
// event guarantees that retrying the same queued message cannot duplicate
// visible output or tool side effects.
function recoverMissingResume(name, evt) {
  const s = sessions.get(name);
  const cur = s && s.current;
  if (!s || !cur || !s.lastSpawnWasResume || cur.eventCount !== 0
      || cur.resumeRecoveryAttempt >= 1 || !isMissingResumeResult(evt)) return false;

  const proc = s.proc;
  const previousSessionId = s.sessionId;
  const nextSessionId = crypto.randomUUID();
  cur.resumeRecoveryAttempt += 1;
  cur.firstByteReported = false;
  s.current = null;
  s.busy = false;
  s.sessionId = nextSessionId;
  s.started = false;
  s.stderrTail = '';
  s.recycleRequested = false;
  s.recycleReason = '';
  s.queue.unshift(cur);

  if (typeof s.onNewSessionId === 'function') {
    try { s.onNewSessionId(nextSessionId); } catch (_) {}
  }
  if (typeof s.onResumeTargetMissing === 'function') {
    try {
      const recovery = s.onResumeTargetMissing({
        previousSessionId, sessionId: nextSessionId,
      });
      const replacementText = typeof recovery === 'string' ? recovery : recovery && recovery.text;
      if (typeof replacementText === 'string' && replacementText.trim()) cur.text = replacementText;
    } catch (_) {}
  }
  console.warn(`[multicc/chat-stream] [${name}] resume target missing; rotating native session and retrying`);

  if (proc && proc.exitCode === null && !proc.killed) {
    if (!killForRecycle(name, s)) s.proc = null;
  } else {
    // The process can exit between emitting the result and this handler. Detach
    // it so its late exit callback cannot reject the message we just re-queued.
    s.proc = null;
    s.recycling = false;
    setImmediate(() => pump(name));
  }
  return true;
}

function onStdout(name, chunk) {
  const s = sessions.get(name);
  if (!s) return;
  // Turn-timing t3: the first stdout byte of the current turn, counted once.
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
      // A malformed JSONL line is a dropped event - silently ignoring it made
      // adapter output corruption invisible. Count every drop, log the first
      // few (capped so a chatty breakage cannot flood the log).
      s.jsonlParseErrors = (s.jsonlParseErrors || 0) + 1;
      if (s.jsonlParseErrors <= 5) {
        console.warn(`[multicc/chat-stream] [${name}] malformed JSONL line dropped (#${s.jsonlParseErrors}, ${line.length} bytes)`);
      }
      continue;
    }

    if (recoverMissingResume(name, evt)) return;
    if (s.current) s.current.eventCount += 1;

    // Capture the real session id if the CLI reports one (first turn / system init).
    if (evt.session_id && evt.session_id !== s.sessionId && evt.type === 'system') {
      // keep our id; CLI honors --session-id, but record just in case
    }

    if (s.current && typeof s.current.onEvent === 'function') {
      try { s.current.onEvent(evt); } catch (_) {}
    }

    // Background task events (task_started/task_updated/task_notification/
    // background_tasks_changed) outlive the turn: the model starts a Monitor,
    // ends its turn (result below), and the task keeps running. The per-turn
    // onEvent above is cleared at finishTurn (s.current = null), so these
    // post-result events would be silently dropped. Forward them through a
    // SEPARATE callback independent of s.current so the server can shadow-tail
    // Monitor output and surface progress to the UI.
    if (s.onBackgroundEvent && evt.type === 'system' &&
        /^(task_started|task_progress|task_updated|task_notification|background_tasks_changed)$/.test(evt.subtype || '')) {
      try { s.onBackgroundEvent(evt); } catch (_) {}
      // A live background signal = the task is genuinely progressing. Refresh the
      // idle-hold clock so an actively-working task never trips the hard ceiling,
      // and re-arm idle if the turn is over (so the 10-min window restarts from
      // this activity rather than the last user turn).
      s.idleHeldSince = 0;
      if (!s.busy && s.queue.length === 0) armIdle(name);
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
  // A recycle-driven (or any) exit is done: no live process, no fingerprint to
  // track, and pump() is free to respawn with the current env.
  s.recycling = false;
  s.spawnedFingerprint = null;

  // Detect "Session ID already in use" — the CLI refuses to start because
  // another process (or a stale lock) holds this session UUID. Generate a
  // fresh UUID, re-queue the in-flight message, and retry the spawn.
  const stderr = (s.stderrTail || '').trim();
  if (/already in use/i.test(stderr)) {
    const crypto = require('crypto');
    s.sessionId = crypto.randomUUID();
    s.started = false;
    s.stderrTail = '';
    if (typeof s.onNewSessionId === 'function') {
      try { s.onNewSessionId(s.sessionId); } catch (_) {}
    }
    // If a message was in-flight, put it back so it re-runs with the new id.
    if (cur) s.queue.unshift(cur);
    setImmediate(() => pump(name));
    return;
  }

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

// SIGTERM the warm process so onExit → pump respawns it with `--resume <same id>`.
// The caller must have re-queued whatever turn triggered this.
//
// `recycling` blocks every pump for this session until the exit lands, so a process
// that ignores SIGTERM would wedge the session for good — hence the escalation to
// SIGKILL and, if even that produces no exit event, releasing the flag so turns can
// resume (a respawn alongside a zombie beats a session that accepts no messages).
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

// Start the next queued message if the process is free.
function pump(name) {
  const s = sessions.get(name);
  if (!s || s.busy || s.recycling) return;
  const next = s.queue.shift();
  if (!next) return;

  // Provider/routing env changed since this process spawned. The live `-p`
  // process still routes to the OLD upstream (env is baked at spawn), so recycle
  // it at THIS turn boundary and let onExit → pump respawn with the fresh env.
  // Safe by construction: we only reach here when !busy, so no in-flight turn is
  // interrupted; the requeued message re-runs on the new process; and context is
  // preserved because the respawn uses --resume <same session id>. SIGTERM (same
  // as cancel()) gives a deterministic prompt exit — the transcript is already
  // persisted, so nothing is lost.
  if (isAlive(name) && s.spawnedFingerprint !== null &&
      routeFingerprint(s.env) !== s.spawnedFingerprint) {
    s.queue.unshift(next);
    s.recycleRequested = false;   // the respawn satisfies any pending request too
    killForRecycle(name, s);
    return;
  }

  // An explicit recycle request (e.g. the transcript was trimmed on disk and the
  // live process still holds the untrimmed context in memory). Same boundary, one
  // extra condition: while background work is live, killing the process reaps the
  // task and orphans its shadow monitor, so the request waits for a later boundary
  // — the trimmed transcript is already on disk and loses nothing by waiting.
  if (isAlive(name) && s.recycleRequested) {
    const bgActive = typeof s.isBackgroundActive === 'function' && s.isBackgroundActive();
    if (!bgActive) {
      s.queue.unshift(next);
      s.recycleRequested = false;
      killForRecycle(name, s);
      return;
    }
  }

  if (!isAlive(name)) {
    try { spawnProc(name, s); }
    catch (e) { next.reject(e); return; }
  }
  s.busy = true;
  s.current = next;
  s.idleHeldSince = 0; // a real user turn is fresh activity; reset the hold clock
  clearIdle(s);
  // Turn-timing: the process is ready for this message (fresh spawn above or a
  // warm reuse) — this is t1 on the streaming path.
  if (typeof next.onTiming === 'function') {
    try { next.onTiming('spawned'); } catch (_) {}
  }
  try {
    s.proc.stdin.write(userMessageLine(next.text));
    // NOTE: do NOT end() stdin — the process must stay open for future turns.
    // Turn-timing: prompt line handed to the CLI — t2 on the streaming path.
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

// Idle-timer fire: reclaim the warm process ONLY if it is truly unused. A
// process that still owns live background work must NOT be killed — doing so
// murders the running task and orphans its shadow monitor (the root cause of
// the "后台任务一直转圈" bug). While background work is live we hold the process
// and re-check next window, bounded by idleMaxHoldMs so a permanently-silent
// (leaked) task can't pin it forever.
function reclaimIfIdle(name) {
  const s = sessions.get(name);
  if (!s) return;
  if (!isAlive(name) || s.busy || s.queue.length > 0) return;
  const bgActive = typeof s.isBackgroundActive === 'function' && s.isBackgroundActive();
  if (bgActive) {
    if (!s.idleHeldSince) s.idleHeldSince = Date.now();
    const maxHold = s.idleMaxHoldMs || DEFAULT_IDLE_MAX_HOLD_MS;
    if (Date.now() - s.idleHeldSince < maxHold) { armIdle(name); return; }
    // ceiling exceeded → fall through and reclaim (exit path reaps + surfaces interrupted)
  }
  s.idleHeldSince = 0;
  try { s.proc.stdin.end(); } catch (_) {}
  // graceful close; context is recoverable via --resume on next send
}

function clearIdle(s) {
  if (s && s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null; }
}

/**
 * Ensure a streaming session exists (does not spawn until first send()).
 * cfg: { cmd, cwd, sessionId, baseArgs, beforeSpawn?, env?, idleMs?, onExit?, onDispose?,
 *        onNewSessionId?, onResumeTargetMissing?, resume? }
 */
function ensure(name, cfg) {
  let s = sessions.get(name);
  if (!s) {
    s = {
      cmd: cfg.cmd,
      cwd: cfg.cwd,
      sessionId: cfg.sessionId,
      baseArgs: cfg.baseArgs || [],
      beforeSpawn: cfg.beforeSpawn || null,
      env: cfg.env || {},
      idleMs: cfg.idleMs || DEFAULT_IDLE_MS,
      idleMaxHoldMs: cfg.idleMaxHoldMs || DEFAULT_IDLE_MAX_HOLD_MS,
      isBackgroundActive: cfg.isBackgroundActive || null,
      onExit: cfg.onExit || null,
      onDispose: cfg.onDispose || null,
      onNewSessionId: cfg.onNewSessionId || null,
      onResumeTargetMissing: cfg.onResumeTargetMissing || null,
      onBackgroundEvent: cfg.onBackgroundEvent || null,
      proc: null, started: false, busy: false,
      queue: [], current: null, lineBuf: '', stderrTail: '',
      idleTimer: null, idleHeldSince: 0,
      recycling: false, spawnedFingerprint: null,
      recycleRequested: false, recycleReason: '',
      lastSpawnWasResume: false,
    };
    s.started = cfg.resume === true;
    sessions.set(name, s);
  } else {
    // Allow per-turn overrides (arguments/provider env can change between turns).
    if (cfg.baseArgs !== undefined) s.baseArgs = cfg.baseArgs;
    if (cfg.beforeSpawn !== undefined) s.beforeSpawn = cfg.beforeSpawn;
    if (cfg.env !== undefined) s.env = cfg.env;
    if (cfg.onNewSessionId !== undefined) s.onNewSessionId = cfg.onNewSessionId;
    if (cfg.onResumeTargetMissing !== undefined) s.onResumeTargetMissing = cfg.onResumeTargetMissing;
    if (cfg.onBackgroundEvent !== undefined) s.onBackgroundEvent = cfg.onBackgroundEvent;
    if (cfg.onExit !== undefined) s.onExit = cfg.onExit;
    if (cfg.onDispose !== undefined) s.onDispose = cfg.onDispose;
    if (cfg.isBackgroundActive !== undefined) s.isBackgroundActive = cfg.isBackgroundActive;
    if (cfg.idleMaxHoldMs !== undefined) s.idleMaxHoldMs = cfg.idleMaxHoldMs;
  }
  return s;
}

/**
 * Send a user message and resolve when that turn completes (`result` event).
 * onEvent receives every stream-json event for live forwarding to the UI.
 * opts.onTiming?.('spawned'|'sent') reports process-readiness and stdin-write
 * instants for turn-timing instrumentation (see src/chat/turn-timing.js).
 * Turns are serialized per session: a send while a turn is in flight queues.
 */
function send(name, text, onEvent, opts = {}) {
  const s = sessions.get(name);
  if (!s) return Promise.reject(new Error(`stream session "${name}" not ensured`));
  return new Promise((resolve, reject) => {
    s.queue.push({
      text, onEvent, resolve, reject, onTiming: opts.onTiming || null,
      eventCount: 0, resumeRecoveryAttempt: 0,
    });
    pump(name);
  });
}

/**
 * Inject a continuation message — semantically identical to send(), named
 * separately so callers (the waiting-injector) read clearly. This is the API
 * the "data returned, continue" driver uses.
 */
function inject(name, text, onEvent, opts = {}) {
  return send(name, `${text}`, onEvent, opts);
}

/**
 * Replace the warm process so it re-reads its transcript from disk.
 *
 * A `-p` process holds the conversation in memory; trimming the transcript file
 * underneath it changes nothing until it restarts. Since the restart is
 * `--resume <same session id>`, the (now trimmed) transcript comes back with it —
 * so this is how an on-disk prune becomes a smaller live context.
 *
 * Applied at a turn boundary, never mid-turn. Returns how the request landed:
 *   now                  — idle, so the process was replaced immediately
 *   deferred-boundary    — a turn is in flight; pump() applies it when it ends
 *   deferred-background   — live background work owns the process; waits
 *   not-running          — nothing to replace; the next spawn reads the new file
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
  const bgActive = typeof s.isBackgroundActive === 'function' && s.isBackgroundActive();
  if (bgActive) {
    s.recycleRequested = true;
    return { ok: true, applied: 'deferred-background' };
  }
  s.recycleRequested = false;
  return killForRecycle(name, s)
    ? { ok: true, applied: 'now' }
    : { ok: false, applied: 'kill-failed' };
}

// Arm the SIGTERM -> SIGKILL escalation for a captured child handle. SIGTERM is
// a request; a CLI that ignores it (or is wedged in a syscall) keeps running and
// - for the cancel path - stays eligible for reuse (pump only checks isAlive),
// so every later turn inherits the wedged process. The timer fires only if the
// captured process is still around; a respawn is a different ChildProcess, so a
// handle captured before it can never be aimed at the new one.
function armKillEscalation(proc, graceMs) {
  const killer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} }, graceMs);
  if (killer.unref) killer.unref();
  try { proc.once('exit', () => clearTimeout(killer)); } catch (_) {}
}

// Kill the current turn (and process). Context is recoverable via --resume.
function cancel(name) {
  const s = sessions.get(name);
  if (!s) return;
  // Reject queued sends so callers don't hang.
  const pending = s.queue.splice(0);
  for (const q of pending) { try { q.reject(new Error('cancelled')); } catch (_) {} }
  if (s.proc) {
    try { s.proc.kill('SIGTERM'); } catch (_) {}
    armKillEscalation(s.proc, CLOSE_KILL_GRACE_MS);
  }
}

// Fully tear down: session deleted, history cleared, or a deliberate hard
// respawn. Everything the exit path would normally do has to happen HERE,
// because deleting the map entry disarms it: every proc handler is guarded by
// `sessions.get(name)?.proc === proc`, so once the entry is gone the 'exit'
// event is a no-op. Two things would otherwise leak.
//
//  1. The in-flight turn's promise never settles. finishTurn/onExit are the only
//     places that resolve or reject it, so send()'s caller (finalizeStreamingTurn)
//     never runs and the session stays "streaming" for good — visible in the UI
//     as a session that is idle by every other measure yet refuses new messages.
//  2. The process is only ASKED to stop. cancel() sends SIGTERM and arms the
//     SIGKILL escalation itself (armKillEscalation keeps the captured handle),
//     so a CLI that ignores even that is still reaped after the grace period
//     instead of running alongside a respawn.
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
    try { cur.reject(new Error('stream session closed')); } catch (_) {}
  }
  try { s.onDispose?.(); } catch (_) {}
  sessions.delete(name);
}

// TaskRun reuse needs a stronger boundary than close(): the map entry being
// gone proves no new turn can use the process, but transcript cleanup must also
// wait until the captured CLI process has actually exited (including SIGKILL
// escalation). Existing callers keep close()'s synchronous contract.
function closeAndWait(name, { timeoutMs = CLOSE_KILL_GRACE_MS + 1_000 } = {}) {
  const numericTimeout = Number(timeoutMs);
  if (!Number.isFinite(numericTimeout) || numericTimeout < 1) {
    return Promise.reject(Object.assign(new TypeError('valid close timeout required'), {
      code: 'CHAT_STREAM_CLOSE_TIMEOUT_INVALID',
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
      try { processState.removeListener('exit', onExit); } catch (_) {}
      if (error) reject(error);
      else resolve(Object.freeze({ closed: true, hadProcess: true }));
    };
    const onExit = () => finish();
    try { processState.once('exit', onExit); } catch (cause) {
      finish(Object.assign(new Error('cannot join native chat process', { cause }), {
        code: 'CHAT_STREAM_CLOSE_JOIN_FAILED',
      }));
      return;
    }
    timer = setTimeout(() => finish(Object.assign(
      new Error('native chat process did not exit before the cleanup deadline'),
      { code: 'CHAT_STREAM_CLOSE_TIMEOUT' },
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
    recycling: s.recycling,
    recycleRequested: s.recycleRequested,
  };
}

module.exports = { ensure, send, inject, cancel, close, closeAndWait, isAlive, status, recycle };
