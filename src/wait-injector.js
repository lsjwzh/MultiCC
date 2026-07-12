'use strict';

// ── Wait injector: continue a chat session when external data arrives ──
//
// A `claude -p` turn ends when the model yields (even if it said "I'll wait for
// X"). Streaming keeps the process warm, but SOMETHING still has to deliver the
// awaited data as the next message. This module is that something. Three modes:
//
//   A. callback  — the model registers a wait and hands the caller a callback
//                  URL; when the external system POSTs the result, we inject it.
//   B. poll      — the model gives a shell command or URL + a match condition;
//                  we poll on an interval and inject the output once it matches.
//   D. auto      — fallback with NO explicit registration: when a turn ends in a
//                  "waiting on background (B)" or "should continue (C)" state,
//                  nudge the session to continue. UNCAPPED (only 'D' is terminal;
//                  the scan is the backstop), skipped if an explicit wait (A/B)
//                  is already pending for that session.
//   E. bgCheck   — chat-only anti-pattern guard: a turn launched a Bash tool with
//                  run_in_background:true. In a chat session that background
//                  process gets reaped at turn/context boundary, so the model's
//                  "I'll wait for it" silently dies. We auto-inject a corrective
//                  nudge a little after such a turn — same guard shape as D
//                  (capped count, reset by a real user message, skipped when an
//                  explicit A/B wait already covers the session).
//   F. apiRetry  — chat-only resilience guard: a turn ended on a transport/API
//                  error (e.g. "API Error: Connection closed mid-response") rather
//                  than a real completion, so the assistant's answer is truncated
//                  and the turn is effectively dead. server.js injects "刚才因 API
//                  异常中断…请继续" via safeInject — UNCAPPED, retrying as long as
//                  aux (classify) stays healthy; when aux goes down classify stops
//                  running and the retry loop stops naturally.
//   G. resumeInterrupted — classify judged P (still processing) but the CLI
//                  process / event stream has ALREADY ended: the turn died
//                  mid-flight (network drop, crashed CLI, truncated stream). We
//                  inject "【判定未知中断】请继续刚才未完成的任务" to resume.
//                  Fault recovery, so it does NOT respect the autoContinue toggle
//                  (same as F); capped at MAX_RESUME_INTERRUPTED so a CLI that
//                  keeps crashing (non-API, healthy upstream) can't loop forever
//                  - after the cap it gives up and falls back to W (user intervenes).
//
// All three converge on inject() → runChatTurn(session, text), which for a
// streaming session feeds the warm process (queued if a turn is mid-flight) and
// for a default session does a --resume turn. So this works regardless of mode.
//
// ── v2: background-completion inject (de-dup vs classify) ──────────────────
// A Monitor / run_in_background task's task_notification(completed) arrives
// AFTER the turn's `result` (the task outlives the turn that launched it). v1
// only surfaced it to the UI and let classify guess B/C → autoContinue nudge
// with an empty "继续" (a misjudge stalls; or the model re-runs the finished
// work because the nudge carries no result). v2 injects the REAL result straight
// from the completion event. To keep classify from double-injecting an empty
// nudge on top of it, noteBgResultInjected() opens a short de-dup window during
// which autoContinue (D) and bgCheck (E) skip - the result inject subsumes both.

const crypto = require('crypto');

// Injected dependencies (set by init) so the module is testable in isolation.
let _inject = async () => {};   // (session, text, opts?) => Promise   — runChatTurn wrapper
let _exec = async () => ({ stdout: '', code: 1 }); // (cmd, cwd) => {stdout, stderr, code}
let _isBusy = () => false;      // (session) => bool             — is a turn in flight
let _log = () => {};

const waits = new Map();        // waitId -> wait spec/state
const autoState = new Map();    // session -> { count, lastHash }
const bgState = new Map();      // session -> { count }  — run_in_background guard (E)
const interruptState = new Map(); // session -> { count }  — unknown-interruption resume (G)
const bgResultState = new Map();  // session -> { at }      - v2 bg-completion result just injected (de-dup window)
let ticker = null;

const TICK_MS = 1000;
const DEFAULTS = { intervalSec: 15, maxChecks: 40, timeoutSec: 1800 };
const MIN_INTERVAL_SEC = 3;
// autoContinue (D/C→continue) is UNCAPPED — only the classify verdict 'D' (done)
// is terminal, so the loop keeps pushing until the task is genuinely complete
// (scan is the backstop). resumeInterrupted (G) now has MAX_RESUME_INTERRUPTED:
// a CLI that keeps dying mid-flight via a NON-API crash (chokepoint only covers
// API-unhealthy, not a crashed CLI with a healthy upstream) would otherwise loop
// forever, so after the cap it gives up and falls back to W for user intervention.
// bgCheck keeps its cap: it is a one-off anti-pattern correction
// (run_in_background misuse), not task progression.
const MAX_BG_CHECK = 6;          // consecutive run_in_background nudges before giving up
const MAX_RESUME_INTERRUPTED = 10; // consecutive P+no-turn resumes before give-up -> W
const BG_CHECK_DELAY_MS = 25000; // wait ~25s after a bg-launching turn, then nudge
// v2 de-dup window: after a bg-completion result is injected, suppress the
// classify-driven autoContinue (D) and bgCheck (E) empty nudges for this long so
// they don't land on top of the real-result inject. Past the window classify's
// normal nudge resumes (the 60s scan is the backstop). Resets on a real user
// message (resetBgResult), same as resetAuto/resetBg.
const BG_RESULT_DEDUP_MS = 60000;

function genId() { return 'w_' + crypto.randomBytes(6).toString('hex'); }
function genToken() { return crypto.randomBytes(16).toString('hex'); }

function init({ inject, exec, isBusy, log } = {}) {
  if (inject) _inject = inject;
  if (exec) _exec = exec;
  if (isBusy) _isBusy = isBusy;
  if (log) _log = log;
  startTicker();
}

function startTicker() {
  if (ticker) return;
  ticker = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  if (ticker.unref) ticker.unref();
}

// ── Registration (A/B) ──
// spec: { session, mode:'poll'|'callback', cwd?, baseUrl?,
//         pollCmd?|pollUrl?, untilContains?|untilRegex?, intervalSec?, maxChecks?,
//         injectPrefix?, timeoutSec? }
function register(spec, nowMs) {
  const now = nowMs || Date.now();
  if (!spec || !spec.session) throw new Error('session required');
  const mode = spec.mode === 'callback' ? 'callback' : 'poll';
  const w = {
    id: genId(),
    token: genToken(),
    session: spec.session,
    mode,
    cwd: spec.cwd || process.cwd(),
    injectPrefix: typeof spec.injectPrefix === 'string' ? spec.injectPrefix : null,
    createdAt: now,
    checks: 0,
    inFlight: false,
  };

  if (mode === 'poll') {
    if (!spec.pollCmd && !spec.pollUrl) throw new Error('poll mode needs pollCmd or pollUrl');
    if (!spec.untilContains && !spec.untilRegex) throw new Error('poll mode needs untilContains or untilRegex');
    w.pollCmd = spec.pollCmd || null;
    w.pollUrl = spec.pollUrl || null;
    w.untilContains = spec.untilContains || null;
    w.untilRegex = spec.untilRegex || null;
    w.intervalSec = Math.max(MIN_INTERVAL_SEC, Number(spec.intervalSec) || DEFAULTS.intervalSec);
    w.maxChecks = Math.max(1, Number(spec.maxChecks) || DEFAULTS.maxChecks);
    w.nextAt = now + w.intervalSec * 1000;
  } else {
    w.timeoutSec = Math.max(10, Number(spec.timeoutSec) || DEFAULTS.timeoutSec);
    w.expireAt = now + w.timeoutSec * 1000;
  }

  waits.set(w.id, w);
  _log(`[wait] registered ${w.id} mode=${mode} session=${w.session}`);
  return { id: w.id, token: w.token, mode };
}

function publicView(w) {
  return {
    id: w.id, session: w.session, mode: w.mode, checks: w.checks || 0,
    maxChecks: w.maxChecks, intervalSec: w.intervalSec,
    pollCmd: w.pollCmd, pollUrl: w.pollUrl,
    untilContains: w.untilContains, untilRegex: w.untilRegex,
    createdAt: w.createdAt,
  };
}

function listForSession(session) {
  return [...waits.values()].filter(w => w.session === session).map(publicView);
}

function hasWait(session) {
  for (const w of waits.values()) if (w.session === session) return true;
  return false;
}

// ── Callback resolution (A) ──
function resolve(id, token, data) {
  const w = waits.get(id);
  if (!w) return { ok: false, error: 'wait not found' };
  if (w.token !== token) return { ok: false, error: 'bad token' };
  waits.delete(id);
  const prefix = w.injectPrefix || '[等待的数据已返回]';
  _log(`[wait] resolved ${id} via callback`);
  fireInject(w.session, `${prefix}\n${typeof data === 'string' ? data : JSON.stringify(data)}`);
  return { ok: true };
}

function cancel(id) {
  const had = waits.delete(id);
  return { ok: had };
}

function cancelForSession(session) {
  let n = 0;
  for (const [id, w] of waits) if (w.session === session) { waits.delete(id); n++; }
  autoState.delete(session);
  bgState.delete(session);
  interruptState.delete(session);
  bgResultState.delete(session);
  return n;
}

// ── Poll driver (B) + callback timeout ──
async function tick(nowMs) {
  const now = nowMs || Date.now();
  for (const w of [...waits.values()]) {
    if (w.mode === 'callback') {
      if (now >= w.expireAt) { waits.delete(w.id); _log(`[wait] callback ${w.id} timed out`); }
      continue;
    }
    // poll
    if (w.inFlight || now < w.nextAt) continue;
    w.inFlight = true;
    try {
      const out = await runProbe(w);
      if (matches(w, out)) {
        waits.delete(w.id);
        const prefix = w.injectPrefix || '[轮询条件已满足]';
        _log(`[wait] poll ${w.id} matched after ${w.checks + 1} checks`);
        fireInject(w.session, `${prefix}\n${out.slice(0, 4000)}`);
        continue;
      }
      w.checks++;
      if (w.checks >= w.maxChecks) {
        waits.delete(w.id);
        _log(`[wait] poll ${w.id} gave up after ${w.checks} checks`);
        fireInject(w.session, `[轮询超时] 等待的条件在 ${w.checks} 次检查后仍未满足，请决定是继续等待还是改用其它方式。`);
      } else {
        w.nextAt = now + w.intervalSec * 1000;
      }
    } catch (e) {
      w.checks++;
      w.nextAt = now + w.intervalSec * 1000;
      _log(`[wait] poll ${w.id} probe error: ${e.message}`);
    } finally {
      w.inFlight = false;
    }
  }
}

async function runProbe(w) {
  if (w.pollUrl) {
    const r = await fetch(w.pollUrl);
    return await r.text();
  }
  const { stdout, stderr } = await _exec(w.pollCmd, w.cwd);
  return `${stdout || ''}${stderr || ''}`;
}

function matches(w, out) {
  if (w.untilContains) return out.includes(w.untilContains);
  if (w.untilRegex) { try { return new RegExp(w.untilRegex).test(out); } catch { return false; } }
  return false;
}

// ── Auto-continue fallback (D) ──
// Called from the post-turn classifier when state === 'background' (B) or
// 'continue' (C). UNCAPPED — only 'D' (done) is terminal, so we keep nudging the
// session forward until classify judges it complete; the periodic scan is the
// backstop. Skipped only if an explicit wait (A/B) already covers the session.
// The count is kept purely for observability (log "#N"), not as a give-up cap.
function autoContinue(session, opts = {}) {
  if (hasWait(session)) { _log(`[wait] auto skip ${session}: explicit wait pending`); return false; }
  if (recentlyBgResultInjected(session)) { _log(`[wait] auto skip ${session}: bg-completion result just injected`); return false; }
  const st = autoState.get(session) || { count: 0, lastHash: null };
  st.count++;
  autoState.set(session, st);
  const nudge = opts.nudge ||
    '继续：你上一轮提到的在等待的外部结果，如果已经可以推进就继续完成任务；如果确实还需要等待，请用 multicc 的 /wait 接口注册轮询或回调，而不要直接停下。';
  _log(`[wait] auto-continue ${session} (#${st.count}, uncapped)`);
  const d = Number(opts.delayMs);
  const delayMs = Number.isFinite(d) ? Math.max(0, d) : 2000;
  injectSystemMsg(session, nudge, delayMs);
  return true;
}

// Reset the auto-continue counter — call on a real user message, or when the
// turn ends "done" / "waiting on user".
function resetAuto(session) { autoState.delete(session); }

// ── Unknown-interruption resume (G) ──
// Called when classify judged P (still processing) but the CLI process / event
// stream has ALREADY ended — i.e. the turn died mid-flight (network drop,
// crashed CLI, truncated event stream) rather than genuinely still running.
// A dropped turn is a fault to recover, same class as apiRetry (F): it does NOT
// respect the autoContinue toggle, and is UNCAPPED — only 'D' (done) is terminal,
// so we keep nudging until the task actually completes; the periodic scan is the
// backstop. Count is kept purely for observability. Skipped if an explicit wait
// already covers the session.
function resumeInterrupted(session, opts = {}) {
  if (hasWait(session)) { _log(`[wait] resumeInterrupted skip ${session}: explicit wait pending`); return false; }
  const st = interruptState.get(session) || { count: 0 };
  if (st.count >= MAX_RESUME_INTERRUPTED) {
    _log(`[wait] resumeInterrupted cap reached for ${session} (${st.count}) -> give up, fall back to W`);
    return false;
  }
  st.count++;
  interruptState.set(session, st);
  const nudge = opts.nudge || '【判定未知中断】请继续刚才未完成的任务';
  _log(`[wait] resumeInterrupted ${session} (#${st.count}/${MAX_RESUME_INTERRUPTED})`);
  const d = Number(opts.delayMs);
  const delayMs = Number.isFinite(d) ? Math.max(0, d) : 2000;
  injectSystemMsg(session, nudge, delayMs);
  return true;
}

// Reset the interruption-resume counter — call on a real user message or a
// clean (non-P) turn end.
function resetInterrupted(session) { interruptState.delete(session); }

// ── run_in_background anti-pattern guard (E) ──
// Chat-only. Called at a turn boundary when that turn launched a Bash tool with
// run_in_background:true. In a chat session the spawned process is reaped when
// the turn/context resets, so the model's "I'll wait for it" never wakes up.
// We inject a corrective nudge a bit later — keeping the session warm AND
// steering it onto the supported path (run-detached / immediate BashOutput).
// Same guard shape as autoContinue: capped count, reset by a real user message,
// skipped when an explicit A/B wait already covers the session.
function bgCheck(session, opts = {}) {
  if (hasWait(session)) { _log(`[wait] bgCheck skip ${session}: explicit wait pending`); return false; }
  if (recentlyBgResultInjected(session)) { _log(`[wait] bgCheck skip ${session}: bg-completion result just injected`); return false; }
  const st = bgState.get(session) || { count: 0 };
  if (st.count >= MAX_BG_CHECK) {
    _log(`[wait] bgCheck cap reached for ${session} (${st.count})`);
    return false;
  }
  st.count++;
  bgState.set(session, st);
  const nudge = opts.nudge ||
    '[后台进程检查] 你刚才用 run_in_background 起了后台命令。在 chat 会话里这个后台进程会随本轮/上下文回收被静默杀掉，"稍后再看"通常等不到结果。请现在就处理：① 若任务很快——直接用 BashOutput 把它的输出取回来确认结果；② 若是构建/部署/长任务/轮询等待——改用 multicc 的 run-detached 接口重跑（它由服务以 setsid 启动、跨轮不丢、完成后自动把结果发回给你续接）。不要只停在"等它跑完"。';
  _log(`[wait] bgCheck ${session} (#${st.count})`);
  const d = Number(opts.delayMs);
  const delayMs = Number.isFinite(d) ? Math.max(0, d) : BG_CHECK_DELAY_MS;
  injectSystemMsg(session, nudge, delayMs);
  return true;
}

// Reset the bgCheck counter — call on a real user message.
function resetBg(session) { bgState.delete(session); }

// ── v2 bg-completion result de-dup ──
// Called by server.js when a background task's task_notification(completed) is
// injected as the real result. Opens the BG_RESULT_DEDUP_MS window during which
// autoContinue (D) and bgCheck (E) skip their empty nudges - the result inject
// already drives the continuation, an empty nudge on top would double-inject.
function noteBgResultInjected(session) {
  bgResultState.set(session, { at: Date.now() });
  _log(`[wait] bg-result injected ${session} (de-dup window ${BG_RESULT_DEDUP_MS}ms)`);
}
// Reset the de-dup window - call on a real user message (alongside resetAuto /
// resetBg): a user driving again means the bg-driven continuation is superseded.
function resetBgResult(session) { bgResultState.delete(session); }
function recentlyBgResultInjected(session) {
  const st = bgResultState.get(session);
  return !!(st && Date.now() - st.at < BG_RESULT_DEDUP_MS);
}

// Universal prefix for all system-injected messages (autoContinue,
// bgCheck). Recognition side (server.js) matches this single token to skip
// injected text during classify/reconcile, replacing the old per-language regex.
const SYS_PREFIX = '🔇';

// Retry while a turn is mid-flight so we don't interrupt the work we're waiting
// on. After BUSY_MAX_ATTEMPTS we force-inject anyway: a turn hung longer than
// that would otherwise block a real-data inject (dispatch result / bg-completion)
// forever. injectSystemMsg (classify nudges) has no such cap - nudges can wait,
// real data must eventually land. (Streaming queues internally too.)
const BUSY_MAX_ATTEMPTS = 300; // 5min @ 1s - generous; a live long turn never hits it
function fireInject(session, text, attempt = 0, opts) {
  if (_isBusy(session) && attempt < BUSY_MAX_ATTEMPTS) {
    setTimeout(() => fireInject(session, text, attempt + 1, opts), 1000);
    return;
  }
  if (attempt >= BUSY_MAX_ATTEMPTS) {
    _log(`[wait] fireInject ${session}: still busy after ${BUSY_MAX_ATTEMPTS}s, force-injecting (turn may be hung)`);
  }
  Promise.resolve(_inject(session, text, opts)).catch(e => _log(`[wait] inject failed for ${session}: ${e.message}`));
}

// Fire an auto-generated nudge/retry message into a session. Always prefixed
// with SYS_PREFIX so classifiers and reconcilers can reliably identify and
// ignore it — language-agnostic, no fragile regex.
//
// opts is optional origin metadata forwarded to _inject (→ runChatTurn → the
// saved user message). Today only the bg-completion coalescer passes
// { bgTaskIds, bgToolUseIds }; classify nudges and other callers omit it, which
// keeps their behaviour identical to before.
function injectSystemMsg(session, text, delayMs, opts) {
  const msg = `${SYS_PREFIX}${text}`;
  const d = Number(delayMs);
  const delay = Number.isFinite(d) ? Math.max(0, d) : 0;
  const go = () => {
    if (_isBusy(session)) { setTimeout(go, 1000); return; }
    Promise.resolve(_inject(session, msg, opts)).catch(e => _log(`[wait] system inject failed for ${session}: ${e.message}`));
  };
  if (delay) { setTimeout(go, delay); return; }
  go();
}

function stats() {
  return { waits: waits.size, autoSessions: autoState.size, bgSessions: bgState.size, interruptSessions: interruptState.size };
}

// Busy-safe delivery of arbitrary text into a session as a new turn. Reuses the
// same fireInject guard (retry while the session's turn is in flight) so callers
// outside the wait machinery — e.g. routing a dispatched sub-task's result back
// to the session that dispatched it — never interrupt an in-flight turn and
// naturally serialise when several results land at once.
function safeInject(session, text) { fireInject(session, text); }

module.exports = {
  init, register, resolve, cancel, cancelForSession,
  listForSession, hasWait, tick, autoContinue, resetAuto,
  bgCheck, resetBg, resumeInterrupted, resetInterrupted, stats, safeInject,
  injectSystemMsg, SYS_PREFIX,
  noteBgResultInjected, resetBgResult,
  _waits: waits, // for tests
};
