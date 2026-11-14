'use strict';

// Unattended-mode supervisor glue. All decisions (goal caps, verdict prompt,
// parse tolerance, stall/fault policy, wall-clock deadline math) are in
// native/core/src/unattended.rs; this host only gathers evidence, calls the aux
// queue, persists `record.unattended`, applies the decided action, broadcasts
// and keeps one expiry timer per active session.
//
// There is no round budget: `rounds` is an informational counter and
// `maxDurationMinutes` / `startedAt` / `deadlineAt` bound supervision time.
//
// State shape and the wire contract: docs/unattended-mode.md ("Backend notes (v2)").

const STATUS = Object.freeze({
  ACTIVE: 'active',
  ACHIEVED: 'achieved',
  NEEDS_HUMAN: 'needs_human',
  EXHAUSTED: 'exhausted',
  STOPPED: 'stopped',
  ERROR: 'error',
});

const RECENT_MESSAGES = 8;
const PAUSE_LABEL = Object.freeze({ user: '用户接管', input: '用户输入', cancel: '已取消' });
// Only used if the addon somehow cannot be reached; the literal lives in Rust.
const TAG_FALLBACK = '[无人值守 Unattended]';

function createUnattendedHost(options = {}) {
  const {
    getRecord,
    persistState,
    getHistory = () => [],
    setTaskState,
    getPendingQuestion = () => null,
    getAuxQueue = () => null,
    deliver,
    inject,
    withdrawQueued = null,
    notify = () => {},
    broadcast = () => {},
    appendMessage = null,
    hasQueuedDeliveries = null,
    isRunActive = () => false,
    // Earliest epoch-ms the provider / Auto candidate pool could accept a turn
    // again (rate-limit reset or parked candidate). Optional: without it the
    // kernel still backs off on the fault streak alone.
    getRetryNotBefore = () => null,
    // Restart reconciliation: the scheduler is the authority on whether a turn
    // is still live, and the persisted task state names the interrupted cause.
    getTaskState = () => ({}),
    getSchedulerStatus = () => null,
    listSessionIds = () => [],
    now = Date.now,
    setTimeout: setTimeoutFn = setTimeout,
    clearTimeout: clearTimeoutFn = clearTimeout,
    log = () => {},
  } = options;
  const kernel = options.kernel || require('./kernel');
  for (const [name, value] of Object.entries({ getRecord, persistState })) {
    if (typeof value !== 'function') throw new TypeError(`[unattended] ${name} port required`);
  }

  // One evaluation in flight per session; a settle that arrives meanwhile is
  // coalesced into exactly one follow-up run.
  const inFlight = new Set();
  const queued = new Set();
  // Classic classify pushes held back while the supervisor decides. Every path
  // that does not produce its own supervisor notice drains these, so a settle is
  // never silent (docs/unattended-mode.md → notifications).
  const heldPushes = new Map();
  // Scheduler entry ids of supervisor messages that were admitted but are still
  // QUEUED (not yet claimed). A user takeover pauses the run, so its own
  // not-yet-started continuations must be withdrawn instead of running one more
  // round after the pause. Only ids the scheduler says are still pending are
  // removed; a claimed/running entry is owned by the normal cancel path.
  const pendingInjections = new Map();
  const faultWithdrawalEpoch = new Map();
  // Exactly one expiry timer per active session (setTimeout to deadlineAt,
  // unref'd). Cleared on every non-active write, stop/pause/resume and shutdown;
  // re-armed by the boot migration (src/unattended/runtime.js) and by resume.
  const timers = new Map();
  // Exactly one durable retry timer per active session (setTimeout to retryAt,
  // unref'd). The kernel decides the delay and persists `retryAt`; this host
  // only runs the clock and injects the recovery instruction when it fires.
  const retryTimers = new Map();

  let cachedTag = '';
  function tag() {
    if (!cachedTag) {
      try { cachedTag = String(kernel.tag() || ''); } catch (_) { cachedTag = ''; }
      if (!cachedTag) cachedTag = TAG_FALLBACK;
    }
    return cachedTag;
  }

  function stripTag(text) {
    return String(text == null ? '' : text).split(tag()).join(' ').trim();
  }

  function tagged(text) {
    const clean = stripTag(text);
    return clean ? `${tag()} ${clean}` : tag();
  }

  function stateOf(sessionId) {
    const record = getRecord(sessionId);
    const state = record && record.unattended;
    return state && typeof state === 'object' ? state : null;
  }

  function get(sessionId) {
    return stateOf(sessionId);
  }

  // ── Wall-clock deadline / expiry timer ────────────────────────────────────

  function armDeadline(startedAt, maxDurationMinutes, at = now()) {
    return kernel.armDeadline({
      startedAt: startedAt == null ? at : startedAt,
      maxDurationMinutes,
      now: at,
    });
  }

  function clearTimer(sessionId) {
    const timer = timers.get(sessionId);
    if (timer === undefined) return;
    timers.delete(sessionId);
    try { clearTimeoutFn(timer); } catch (_) { /* already fired */ }
  }

  function syncTimer(sessionId, state) {
    clearTimer(sessionId);
    if (!state || state.status !== STATUS.ACTIVE) return;
    const deadlineAt = Number(state.deadlineAt);
    if (!Number.isFinite(deadlineAt) || deadlineAt <= 0) return;
    const delay = Math.max(0, deadlineAt - now());
    const timer = setTimeoutFn(() => {
      if (timers.get(sessionId) === timer) timers.delete(sessionId);
      expireIfDue(sessionId);
    }, delay);
    if (timer && typeof timer.unref === 'function') timer.unref();
    timers.set(sessionId, timer);
  }

  // Re-arm once from the persisted record (boot migration); idempotent. A
  // persisted `retryAt` in the past fires promptly, which is exactly the
  // recovery the user wanted across a restart.
  function rearmTimer(sessionId) {
    const state = stateOf(sessionId);
    syncTimer(sessionId, state);
    syncRetryTimer(sessionId, state);
  }

  function shutdown() {
    for (const sessionId of [...timers.keys()]) clearTimer(sessionId);
    for (const sessionId of [...retryTimers.keys()]) clearRetryTimer(sessionId);
  }

  // ── Durable fault retry timer ─────────────────────────────────────────────

  function clearRetryTimer(sessionId) {
    const timer = retryTimers.get(sessionId);
    if (timer === undefined) return;
    retryTimers.delete(sessionId);
    try { clearTimeoutFn(timer); } catch (_) { /* already fired */ }
  }

  function syncRetryTimer(sessionId, state) {
    clearRetryTimer(sessionId);
    if (!state || state.status !== STATUS.ACTIVE) return;
    const retryAt = Number(state.retryAt);
    if (!Number.isFinite(retryAt) || retryAt <= 0) return;
    const delay = Math.max(0, retryAt - now());
    const timer = setTimeoutFn(() => {
      if (retryTimers.get(sessionId) === timer) retryTimers.delete(sessionId);
      fireRetry(sessionId);
    }, delay);
    if (timer && typeof timer.unref === 'function') timer.unref();
    retryTimers.set(sessionId, timer);
  }

  // The retry timer fired: re-check every fact before injecting. Expiry wins
  // first, and a turn started by any other path (FIFO, user, API-policy retry)
  // makes the persisted retry obsolete — clear it instead of double-driving.
  async function fireRetry(sessionId) {
    const at = now();
    const state = stateOf(sessionId);
    if (!state || state.status !== STATUS.ACTIVE) return;
    if (expireIfDue(sessionId)) return;
    const retryAt = Number(state.retryAt);
    if (!Number.isFinite(retryAt) || retryAt <= 0) return;
    if (at < retryAt) {
      // Timers may fire a hair early; re-arm for the remainder.
      syncRetryTimer(sessionId, state);
      return;
    }
    // A crash can occur after the handoff was admitted but before the retry
    // marker was cleared. While that durable entry waits, do not create a
    // second recovery; check again if it is removed before starting.
    const defer = () => {
      clearRetryTimer(sessionId);
      const timer = setTimeoutFn(() => {
        if (retryTimers.get(sessionId) === timer) retryTimers.delete(sessionId);
        void fireRetry(sessionId);
      }, 1000);
      if (timer && typeof timer.unref === 'function') timer.unref();
      retryTimers.set(sessionId, timer);
    };
    let status;
    try { status = await getSchedulerStatus(sessionId); }
    catch (error) {
      log(`[unattended] retry queue check failed for ${sessionId}: ${error.message}`);
      if (Number(stateOf(sessionId)?.retryAt) === retryAt) defer();
      return;
    }
    const current = stateOf(sessionId);
    if (!current || current.status !== STATUS.ACTIVE || Number(current.retryAt) !== retryAt) return;
    if (expireIfDue(sessionId)) return;
    if (status && typeof kernel.selectQueued === 'function') {
      let probe;
      try { probe = probeHandoffQueue(status); }
      catch (error) { log(`[unattended] retry selection failed for ${sessionId}: ${error.message}`); defer(); return; }
      if (probe.handoffPending === true) {
        withdrawFaultEntries(sessionId, probe.faultEntryIds);
        defer();
        return;
      }
    }
    let busy = false;
    try { busy = isRunActive(sessionId) === true; } catch (_) { busy = false; }
    // Clear the durable marker either way: it has been consumed.
    if (!write(sessionId, { ...current, retryAt: null, retryCategory: null, updatedAt: now() })) return;
    if (busy) return;
    const faults = Number(state.stall && state.stall.consecutiveFaults) || 1;
    trace(sessionId, tagged(`故障后自动继续（第 ${faults} 次）`));
    if (typeof inject !== 'function') return;
    trackInjection(sessionId, inject(sessionId, tagged(kernel.faultInstruction()), {
      unattendedRecovery: true,
    }), 'fault');
  }

  // Checked at the top of every evaluation/fault AND by the timer, so a late
  // timer can never allow another injection.
  function expireIfDue(sessionId) {
    const state = stateOf(sessionId);
    if (!state || state.status !== STATUS.ACTIVE) return false;
    const deadlineAt = Number(state.deadlineAt);
    if (!Number.isFinite(deadlineAt) || deadlineAt <= 0) return false;
    let expired = false;
    try {
      expired = kernel.deadlineExpired({ deadlineAt, now: now() }).expired === true;
    } catch (_) {
      expired = false;
    }
    if (!expired) return false;
    return expire(sessionId, state) !== null;
  }

  // Deadline reached: reuse the terminal `exhausted` status, broadcast the usual
  // state + trace, tell the user and release the held classic push exactly like
  // the other no-op paths.
  function expire(sessionId, current) {
    const at = now();
    const humanReason = tagged('已达到最长值守时间');
    const next = {
      ...current,
      status: STATUS.EXHAUSTED,
      evaluating: false,
      pausedBy: null,
      retryAt: null,
      retryCategory: null,
      lastVerdict: {
        verdict: 'needs_human',
        reason: '已达到最长值守时间',
        nextInstruction: '',
        humanReason,
        at,
      },
      updatedAt: at,
    };
    if (!write(sessionId, next)) return null;
    trace(sessionId, humanReason);
    try {
      Promise.resolve(apply(sessionId, { action: 'exhausted', message: humanReason, nextState: next }))
        .catch(error => {
          log(`[unattended] expiry apply failed for ${sessionId}: ${error && error.message ? error.message : error}`);
        });
    } catch (error) {
      log(`[unattended] expiry apply failed for ${sessionId}: ${error && error.message ? error.message : error}`);
    }
    releaseHeldPushes(sessionId);
    return next;
  }

  function write(sessionId, next) {
    try {
      persistState(sessionId, next);
    } catch (error) {
      log(`[unattended] persist failed for ${sessionId}: ${error && error.message ? error.message : error}`);
      return false;
    }
    // Leaving active (pause, achieved, needs_human, expiry, error) means the
    // supervisor must not start another round, including one it already
    // admitted into the FIFO. Only withdraw after the state write landed: a
    // failed write means the pause did not happen.
    if (next && next.status !== STATUS.ACTIVE) withdrawPendingInjections(sessionId);
    syncTimer(sessionId, next);
    syncRetryTimer(sessionId, next);
    try {
      broadcast(sessionId, { type: 'unattended_state', unattended: next });
    } catch (_) { /* a dead socket must not fail the state write */ }
    return true;
  }

  function freshState(config) {
    const at = now();
    const armed = armDeadline(at, config.maxDurationMinutes, at);
    return {
      status: STATUS.ACTIVE,
      goal: config.goal,
      criteria: Array.isArray(config.criteria) ? config.criteria : [],
      maxDurationMinutes: config.maxDurationMinutes,
      rounds: 0,
      startedAt: armed.startedAt,
      deadlineAt: armed.deadlineAt,
      updatedAt: at,
      lastVerdict: null,
      history: [],
      stall: { sameInstruction: 0, auxFailures: 0, consecutiveFaults: 0 },
      retryAt: null,
      retryCategory: null,
      evaluating: false,
      pausedBy: null,
    };
  }

  function sameConfig(state, config) {
    return state.goal === config.goal
      && state.maxDurationMinutes === config.maxDurationMinutes
      && JSON.stringify(state.criteria || []) === JSON.stringify(config.criteria || []);
  }

  function usable(sessionId) {
    const record = getRecord(sessionId);
    return !!record && record.type !== 'aux' && record.type !== 'gateway';
  }

  // ── Trace (persisted UI-only history line; never model context) ────────────

  function trace(sessionId, content) {
    const text = String(content || '').trim();
    if (!text || typeof appendMessage !== 'function') return null;
    const entry = { role: 'system', kind: 'unattended_trace', content: text, ts: now() };
    // The append is a durable write now; its verdict arrives as a Promise.
    // Broadcast only once it reports success, and never let a rejected trace
    // write escape as an unhandled rejection (the trace is best-effort UI).
    const broadcastSaved = (saved) => {
      if (saved === false) return;
      try {
        broadcast(sessionId, {
          type: 'unattended_trace',
          kind: 'unattended_trace',
          message: entry.content,
          entry,
        });
      } catch (_) { /* live broadcast is best-effort; the durable line already exists */ }
    };
    const onAppendError = (error) => {
      log(`[unattended] trace append failed for ${sessionId}: ${error && error.message ? error.message : error}`);
    };
    let pending;
    try {
      pending = appendMessage(sessionId, entry);
    } catch (error) {
      onAppendError(error);
      return null;
    }
    if (pending && typeof pending.then === 'function') pending.then(broadcastSaved, onAppendError);
    else broadcastSaved(pending);
    return entry;
  }

  function traceDecision(sessionId, decision) {
    const last = (decision.nextState && decision.nextState.lastVerdict) || {};
    const reason = stripTag(last.reason);
    const instruction = stripTag(last.nextInstruction);
    const message = stripTag(decision.message);
    let body = '';
    switch (decision.action) {
      case 'inject':
        body = `判定：继续 · ${reason || '继续'} · 下一步：${instruction || stripTag(decision.answer) || message}`;
        break;
      case 'achieved':
        body = `判定：达成 · ${reason || '目标已达成'}`;
        break;
      case 'needs_human':
        body = `判定：需要人工 · ${stripTag(last.humanReason) || message || '有只有人才能解决的问题'}`;
        break;
      case 'stalled':
        body = `判定：停滞 · ${reason || message || '连续给出同一条指令却没有进展'}`;
        break;
      case 'exhausted':
        body = `判定：时长用尽 · ${message || '已达到最长值守时间'}`;
        break;
      case 'error':
        body = `判定：出错 · ${message || '辅助模型未能给出可解析的判定'}`;
        break;
      default:
        return null;
    }
    return trace(sessionId, tagged(body));
  }

  function tracePaused(sessionId, by) {
    return trace(sessionId, tintedPause(by));
  }

  function tintedPause(by) {
    return tagged(`已暂停（${PAUSE_LABEL[by] || PAUSE_LABEL.user}）`);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  // First-message arming. `spec` is the `unattended` object the client sent on
  // the first message; `defaultGoal` is that message's text. Re-arming with the
  // identical config is a no-op so a shell receipt retry cannot reset rounds.
  function armFromRequest(sessionId, spec, { defaultGoal = '' } = {}) {
    if (!spec || typeof spec !== 'object') return { ok: false, code: 'invalid_spec' };
    if (!usable(sessionId)) return { ok: false, code: 'session_not_found' };
    const normalized = kernel.normalizeConfig({
      goal: spec.goal == null || spec.goal === '' ? defaultGoal : spec.goal,
      criteria: spec.criteria,
      maxDurationMinutes: spec.maxDurationMinutes,
    });
    if (!normalized.ok) return { ok: false, code: normalized.error || 'goal_required' };
    const current = stateOf(sessionId);
    if (current && current.status === STATUS.ACTIVE && sameConfig(current, normalized.config)) {
      return { ok: true, unattended: current, unchanged: true };
    }
    const next = freshState(normalized.config);
    if (!write(sessionId, next)) return { ok: false, code: 'persist_failed' };
    return { ok: true, unattended: next };
  }

  // A brand-new turn that is already streaming (or has queued deliveries) will
  // settle on its own; evaluating now would judge a half-written transcript.
  async function evaluationDeferred(sessionId) {
    let busy = false;
    try { busy = isRunActive(sessionId) === true; } catch (_) { busy = false; }
    return kernel.deferEvaluation({
      busy,
      backlogPending: await backlogPending(sessionId),
      classifyState: getTaskState(sessionId)?.classifyState,
      pendingQuestion: getPendingQuestion(sessionId),
    });
  }

  // Read-only question: has the session-work scheduler staged deliveries the
  // FIFO will drain on its own? The supervisor never reads their text — the
  // scheduler is the authority on order (docs/unattended-mode.md → v2 item 2).
  async function backlogPending(sessionId) {
    if (typeof hasQueuedDeliveries !== 'function') return false;
    try {
      return (await hasQueuedDeliveries(sessionId)) === true;
    } catch (_) {
      return false;
    }
  }

  async function start(sessionId, body = {}) {
    if (!usable(sessionId)) return { ok: false, code: 'session_not_found', status: 404 };
    const normalized = kernel.normalizeConfig({
      goal: body.goal,
      criteria: body.criteria,
      maxDurationMinutes: body.maxDurationMinutes,
    });
    if (!normalized.ok) return { ok: false, code: normalized.error || 'goal_required', status: 400 };
    const next = freshState(normalized.config);
    if (!write(sessionId, next)) return { ok: false, code: 'persist_failed', status: 500 };
    let deferred = false;
    if (body.evaluateNow !== false) {
      deferred = await evaluationDeferred(sessionId);
      if (!deferred) evaluate(sessionId, { reason: 'start' });
    }
    return { ok: true, unattended: stateOf(sessionId) || next, deferred };
  }

  function update(sessionId, body = {}) {
    const current = stateOf(sessionId);
    if (!current) return { ok: false, code: 'no_unattended', status: 409 };
    if (current.status !== STATUS.ACTIVE && current.status !== STATUS.NEEDS_HUMAN) {
      return { ok: false, code: 'invalid_state', status: 409 };
    }
    const at = now();
    const normalized = kernel.normalizeConfig({
      goal: body.goal == null ? current.goal : body.goal,
      criteria: body.criteria == null ? current.criteria : body.criteria,
      maxDurationMinutes: body.maxDurationMinutes == null ? current.maxDurationMinutes : body.maxDurationMinutes,
    });
    if (!normalized.ok) return { ok: false, code: normalized.error || 'goal_required', status: 400 };
    // While active the deadline is recomputed from the ORIGINAL startedAt; when
    // the new deadline is already past it is clamped to now + 1 minute and the
    // trace notes it.
    const startedAt = Number(current.startedAt) > 0 ? Number(current.startedAt) : at;
    const armed = armDeadline(startedAt, normalized.config.maxDurationMinutes, at);
    const next = {
      ...current,
      goal: normalized.config.goal,
      criteria: normalized.config.criteria,
      maxDurationMinutes: normalized.config.maxDurationMinutes,
      deadlineAt: armed.deadlineAt,
      updatedAt: at,
    };
    if (!write(sessionId, next)) return { ok: false, code: 'persist_failed', status: 500 };
    if (current.status === STATUS.ACTIVE && armed.clamped === true) {
      try { trace(sessionId, tagged('新的值守时长已使截止时间落在过去，截止时间顺延到 1 分钟后')); } catch (_) {}
    }
    return { ok: true, unattended: next };
  }

  function pause(sessionId, by) {
    const current = stateOf(sessionId);
    if (!current) return null;
    if (current.status === STATUS.STOPPED && current.pausedBy === by) return current;
    const next = {
      ...current,
      status: STATUS.STOPPED,
      pausedBy: by,
      // An evaluation may be in flight; the spinner must not outlive the pause.
      evaluating: false,
      retryAt: null,
      retryCategory: null,
      updatedAt: now(),
    };
    if (!write(sessionId, next)) return null;
    try { tracePaused(sessionId, by); } catch (_) {}
    return next;
  }

  function stop(sessionId) {
    const current = stateOf(sessionId);
    if (!current) return { ok: false, code: 'no_unattended', status: 409 };
    if (current.status === STATUS.STOPPED) return { ok: true, unattended: current };
    const next = pause(sessionId, 'user');
    if (!next) return { ok: false, code: 'persist_failed', status: 500 };
    return { ok: true, unattended: next };
  }

  // End the unattended run and delete `record.unattended`, so the banner and
  // input lock disappear for every client and the panel returns to "not
  // started". The allow/noop decision is Rust (`decide_clear`); this host only
  // gathers the status and applies it. Active is refused — the UI must pause
  // first, because clearing a live supervisor would silently drop its timers.
  function clear(sessionId) {
    const current = stateOf(sessionId);
    let decision;
    try {
      decision = kernel.decideClear({ status: current ? current.status : null });
    } catch (error) {
      log(`[unattended] clear decision failed for ${sessionId}: ${error && error.message ? error.message : error}`);
      return { ok: false, code: 'decision_failed', status: 500 };
    }
    if (!decision || decision.allowed !== true) {
      return { ok: false, code: (decision && decision.code) || 'invalid_state', status: 409 };
    }
    clearTimer(sessionId);
    clearRetryTimer(sessionId);
    if (!current || decision.noop === true) {
      // Idempotent: no state means nothing to delete or broadcast. Still drain
      // any stray supervisor bookkeeping so a late timer cannot resurrect it.
      withdrawPendingInjections(sessionId);
      releaseHeldPushes(sessionId);
      return { ok: true, unattended: null, noop: true };
    }
    // `write(null)` deletes the record, clears both timers and broadcasts
    // `unattended_state` with `unattended: null` to every open client.
    if (!write(sessionId, null)) return { ok: false, code: 'persist_failed', status: 500 };
    // Leaving active must drop the not-yet-started continuations and release
    // any classic classify push that was held while the supervisor decided.
    withdrawPendingInjections(sessionId);
    releaseHeldPushes(sessionId);
    trace(sessionId, tagged('无人值守已结束，设置已清除'));
    return { ok: true, unattended: null };
  }

  async function resume(sessionId, body = {}) {
    const current = stateOf(sessionId);
    if (!current) return { ok: false, code: 'no_unattended', status: 409 };
    const resumable = [STATUS.NEEDS_HUMAN, STATUS.EXHAUSTED, STATUS.STOPPED, STATUS.ERROR];
    if (!resumable.includes(current.status)) return { ok: false, code: 'invalid_state', status: 409 };
    const normalized = kernel.normalizeConfig({
      goal: current.goal,
      criteria: current.criteria,
      maxDurationMinutes: body.maxDurationMinutes == null ? current.maxDurationMinutes : body.maxDurationMinutes,
    });
    if (!normalized.ok) return { ok: false, code: normalized.error || 'goal_required', status: 400 };
    const at = now();
    // Resume re-arms the clock: startedAt = now, deadlineAt = now + duration.
    const armed = armDeadline(at, normalized.config.maxDurationMinutes, at);
    const next = {
      ...current,
      status: STATUS.ACTIVE,
      pausedBy: null,
      evaluating: false,
      maxDurationMinutes: normalized.config.maxDurationMinutes,
      startedAt: armed.startedAt,
      deadlineAt: armed.deadlineAt,
      rounds: current.status === STATUS.EXHAUSTED ? 0 : current.rounds,
      stall: { sameInstruction: 0, auxFailures: 0, consecutiveFaults: 0 },
      retryAt: null,
      retryCategory: null,
      updatedAt: at,
    };
    if (!write(sessionId, next)) return { ok: false, code: 'persist_failed', status: 500 };
    const deferred = await evaluationDeferred(sessionId);
    if (!deferred) evaluate(sessionId, { reason: 'resume' });
    return { ok: true, unattended: stateOf(sessionId) || next, deferred };
  }

  function historyMessages(sessionId) {
    let history;
    try { history = getHistory(sessionId); } catch (_) { history = null; }
    if (!Array.isArray(history)) return [];
    return history.filter(message => message
      && (message.role === 'user' || message.role === 'assistant')
      && typeof message.content === 'string');
  }

  function evidence(sessionId, state, assistantText) {
    const messages = historyMessages(sessionId);
    const recent = messages.slice(-RECENT_MESSAGES).map(({ role, content }) => ({ role, content }));
    let lastOutput = '';
    if (assistantText && String(assistantText).trim()) {
      lastOutput = String(assistantText);
    } else {
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index].role === 'assistant' && messages[index].content.trim()) {
          lastOutput = messages[index].content;
          break;
        }
      }
    }
    let pending = null;
    try { pending = getPendingQuestion(sessionId); } catch (_) { pending = null; }
    const pendingQuestion = pending && pending.resolved !== true && pending.requestId
      ? {
          requestId: String(pending.requestId),
          question: String(pending.question || ''),
          options: Array.isArray(pending.options) ? pending.options.slice() : [],
        }
      : null;
    return {
      goal: state.goal,
      criteria: state.criteria,
      lastOutput,
      recent,
      history: state.history,
      pendingQuestion,
      classifyState: getTaskState(sessionId)?.classifyState,
      rounds: state.rounds,
      maxDurationMinutes: state.maxDurationMinutes,
    };
  }

  function currentAssistantText(sessionId) {
    let messages;
    try { messages = getHistory(sessionId); } catch (_) { return ''; }
    if (!Array.isArray(messages)) return '';
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message && message.role === 'assistant' && typeof message.content === 'string'
        && message.content.trim()) return message.content;
    }
    return '';
  }

  // FIFO 内容不进入判定提示词；队列顺序由调度器和 Rust 策略决定。

  function setEvaluating(sessionId, value) {
    const state = stateOf(sessionId);
    if (!state) return;
    if ((state.evaluating === true) === (value === true)) return;
    write(sessionId, { ...state, evaluating: value === true, updatedAt: now() });
  }

  async function runEvaluation(sessionId, reason, assistantText, settledAt = null) {
    if (expireIfDue(sessionId)) return { ok: false, code: 'expired' };
    const state = stateOf(sessionId);
    if (!state || state.status !== STATUS.ACTIVE) return { ok: false, code: 'not_active' };
    const collected = evidence(sessionId, state, assistantText);
    let collectedLast = collected.lastOutput;
    if (!collectedLast && (reason === 'start' || reason === 'resume')) {
      collectedLast = currentAssistantText(sessionId);
      collected.lastOutput = collectedLast;
    }
    // Nothing has been produced yet (brand-new session): one verdict on an empty
    // transcript would only burn a round.
    if (!collectedLast) return { ok: false, code: 'no_output' };

    const queue = getAuxQueue();
    if (!queue || typeof queue.enqueue !== 'function') return { ok: false, code: 'aux_unavailable' };

    // The backlog read is async: a user message may have paused us meanwhile.
    const before = stateOf(sessionId);
    if (!before || before.status !== STATUS.ACTIVE) return { ok: false, code: 'superseded' };

    setEvaluating(sessionId, true);
    let text = '';
    let auxError = null;
    try {
      const prompt = kernel.buildVerdictPrompt(collected);
      const reply = await queue.enqueue({
        type: 'unattended_verdict',
        priority: 'interactive',
        prompt,
        meta: { sessionName: sessionId, unattended: true },
      });
      text = reply && typeof reply.text === 'string' ? reply.text : '';
    } catch (error) {
      if (error && error.cancelled) {
        setEvaluating(sessionId, false);
        return { ok: false, code: 'cancelled' };
      }
      auxError = error && error.message ? error.message : String(error || 'aux_failed');
    }

    // Aux 等待期间消息可能入队或已经开始执行；交给 Rust 丢弃过时判定。
    const workPending = queued.has(sessionId) || await evaluationDeferred(sessionId);
    const latest = stateOf(sessionId);
    if (!latest || latest.status !== STATUS.ACTIVE) {
      setEvaluating(sessionId, false);
      return { ok: false, code: 'superseded' };
    }

    const verdict = auxError ? { ok: false, error: `aux_failed: ${auxError}` } : kernel.parseVerdict(text);
    const decision = kernel.decide({
      state: latest,
      verdict: verdict.ok ? verdict : undefined,
      parseError: verdict.ok ? undefined : (verdict.error || 'unparseable_verdict'),
      evaluation: collected,
      workPending,
      now: now(),
    });
    // `lastSettleAt` is the restart-reconciliation watermark: a settle that was
    // handled here must never be replayed by the boot pass.
    const nextState = settledAt ? { ...decision.nextState, lastSettleAt: settledAt } : decision.nextState;
    if (!write(sessionId, nextState)) {
      setEvaluating(sessionId, false);
      return { ok: false, code: 'persist_failed' };
    }
    decision.nextState = nextState;
    traceDecision(sessionId, decision);
    try {
      await apply(sessionId, decision);
    } catch (error) {
      log(`[unattended] apply failed for ${sessionId}: ${error && error.message ? error.message : error}`);
      return { ok: false, code: 'apply_failed' };
    }
    return { ok: true, action: decision.action, unattended: decision.nextState };
  }

  function rememberHeldPush(sessionId, fallbackPush) {
    if (typeof fallbackPush !== 'function') return;
    const list = heldPushes.get(sessionId) || [];
    list.push(fallbackPush);
    heldPushes.set(sessionId, list);
  }

  function releaseHeldPushes(sessionId) {
    const list = heldPushes.get(sessionId);
    if (!list) return;
    heldPushes.delete(sessionId);
    for (const push of list) {
      try { push(); } catch (error) {
        log(`[unattended] fallback push failed for ${sessionId}: ${error && error.message ? error.message : error}`);
      }
    }
  }

  // One evaluation in flight per session; a settle that arrives meanwhile is
  // coalesced into exactly one follow-up run (its held push travels with it).
  function evaluate(sessionId, { reason = 'turn_end', assistantText = '', fallbackPush = null, settledAt = null } = {}) {
    rememberHeldPush(sessionId, fallbackPush);
    // A late timer must never allow another injection: check the deadline
    // before anything else. Expiry releases the held push itself.
    if (expireIfDue(sessionId)) return Promise.resolve({ ok: false, code: 'expired' });
    if (inFlight.has(sessionId)) {
      queued.add(sessionId);
      return Promise.resolve({ ok: true, deferred: true });
    }
    const state = stateOf(sessionId);
    if (!state || state.status !== STATUS.ACTIVE) {
      releaseHeldPushes(sessionId);
      return Promise.resolve({ ok: false, code: 'not_active' });
    }
    inFlight.add(sessionId);
    return runEvaluation(sessionId, reason, assistantText, settledAt)
      .catch(error => {
        log(`[unattended] evaluation failed for ${sessionId}: ${error && error.message ? error.message : error}`);
        return { ok: false, code: 'evaluation_failed' };
      })
      .then(result => {
        // Exactly one outcome per settle: whenever the supervisor produced no
        // notice of its own (no_output / superseded / aux unavailable / dropped
        // / persist or apply failure / action none), the classic push fires.
        if (!result || !result.ok || result.action === 'none') releaseHeldPushes(sessionId);
        else heldPushes.delete(sessionId);
        return result;
      })
      .finally(() => {
        inFlight.delete(sessionId);
        if (queued.delete(sessionId)) {
          setImmediate(() => evaluate(sessionId, { reason: 'coalesced' }));
        }
      });
  }

  async function apply(sessionId, decision) {
    const { action, message } = decision;
    if (action === 'none') return;
    if (action === 'inject') {
      if (decision.answer && decision.pendingQuestionId && typeof deliver === 'function') {
        // The aux answered the pending question itself: deliver it exactly like
        // a user's answer so the wait_for_user_answer request is resolved. The
        // marker + 🔇 prefix keep it out of "real user" classification.
        const sent = await deliver(sessionId, tagged(decision.answer), {
          userInputRequestId: decision.pendingQuestionId,
          unattendedSystem: true,
          unattendedRecovery: true,
          system: true,
        });
        rememberInjection(sessionId, sent);
        return;
      }
      // The marker is added by code, never by the model; re-tagging also
      // normalises any marker the aux emitted itself.
      if (typeof inject === 'function') trackInjection(sessionId, inject(sessionId, tagged(message), { unattendedRecovery: decision.recovery === true }));
      return;
    }
    if (action === 'achieved') {
      try {
        if (typeof setTaskState === 'function') {
          setTaskState(sessionId, { goalState: 'achieved', goalStateManualAt: now() });
        }
      } catch (error) {
        log(`[unattended] goalState write failed for ${sessionId}: ${error && error.message ? error.message : error}`);
      }
      notify(sessionId, 'succeeded', message, { classifyState: 'D', goalState: 'achieved' });
      broadcast(sessionId, { type: 'notify', state: 'succeeded', classifyState: 'D', message, goalState: 'achieved' });
      return;
    }
    if (action === 'needs_human' || action === 'stalled') {
      notify(sessionId, 'waiting', message, { classifyState: 'W' });
      broadcast(sessionId, { type: 'notify', state: 'waiting', classifyState: 'W', message });
      return;
    }
    if (action === 'exhausted' || action === 'error') {
      notify(sessionId, 'error', message, { classifyState: 'E' });
      broadcast(sessionId, { type: 'notify', state: 'error', classifyState: 'E', message });
    }
  }

  // While active, the supervisor will judge this settle itself — hold the
  // classic classify push instead of racing two notices. Returns false when the
  // verdict would bail before the Aux call (nothing to judge yet).
  function shouldHoldPush(sessionId, { assistantText = '' } = {}) {
    const state = stateOf(sessionId);
    if (!state || state.status !== STATUS.ACTIVE) return false;
    const text = assistantText && String(assistantText).trim()
      ? assistantText
      : currentAssistantText(sessionId);
    return !!String(text || '').trim();
  }

  function firePush(push) {
    if (typeof push !== 'function') return;
    try { push(); } catch (error) {
      log(`[unattended] fallback push failed: ${error && error.message ? error.message : error}`);
    }
  }

  // The delivery boundary resolves to the scheduler admission result
  // `{ ok, entry: { id }, queued }`. Even queued=false may still be pending
  // before the scheduler claims it; cancellation itself checks the lease.
  function rememberInjection(sessionId, result, kind = 'other') {
    if (!withdrawQueued || !result || result.ok === false || result.duplicate === true) return;
    if (result.queued !== true && kind !== 'fault') return;
    const entryId = result.entry && result.entry.id;
    if (!entryId) return;
    const entries = pendingInjections.get(sessionId) || new Map();
    entries.set(entryId, kind);
    pendingInjections.set(sessionId, entries);
  }

  function trackInjection(sessionId, sent, kind = 'other') {
    if (!withdrawQueued || !sent) return;
    if (typeof sent.then !== 'function') { rememberInjection(sessionId, sent, kind); return; }
    const epoch = faultWithdrawalEpoch.get(sessionId) || 0;
    sent.then(result => {
      rememberInjection(sessionId, result, kind);
      if (kind === 'fault' && (faultWithdrawalEpoch.get(sessionId) || 0) !== epoch) {
        withdrawPendingInjections(sessionId, 'fault');
      }
    }).catch(error => {
      log(`[unattended] continuation admission failed for ${sessionId}: ${error && error.message ? error.message : error}`);
    });
  }

  function withdrawPendingInjections(sessionId, onlyKind = null) {
    const entries = pendingInjections.get(sessionId);
    if (!entries || !entries.size || !withdrawQueued) return;
    for (const [entryId, kind] of entries) {
      if (onlyKind && kind !== onlyKind) continue;
      entries.delete(entryId);
      try {
        Promise.resolve(withdrawQueued(sessionId, entryId)).catch(error => {
          log(`[unattended] queued continuation withdraw failed for ${sessionId}/${entryId}: ${error && error.message ? error.message : error}`);
        });
      } catch (error) {
        log(`[unattended] queued continuation withdraw failed for ${sessionId}/${entryId}: ${error && error.message ? error.message : error}`);
      }
    }
    if (!entries.size) pendingInjections.delete(sessionId);
  }

  function probeHandoffQueue(status) {
    return kernel.selectQueued({ handoffProbe: true, items: (status.queued || []).map(item => ({
      id: item.entryId, taskSource: item.source, message: item.text,
    })) });
  }

  function withdrawFaultEntries(sessionId, ids) {
    if (!withdrawQueued || !Array.isArray(ids)) return;
    for (const id of ids) {
      try { Promise.resolve(withdrawQueued(sessionId, id)).catch(error => {
        log(`[unattended] queued fault withdraw failed for ${sessionId}/${id}: ${error.message}`);
      }); } catch (error) {
        log(`[unattended] queued fault withdraw failed for ${sessionId}/${id}: ${error.message}`);
      }
    }
  }

  function markSettle(state, at) {
    return { ...state, lastSettleAt: at };
  }

  // Local HH:MM for traces and the one waiting notice. Formatting lives here
  // because the kernel stays deterministic and timezone-free.
  function formatClock(at) {
    const date = new Date(Number(at));
    if (!Number.isFinite(date.getTime())) return '';
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }

  function faultTrace(decision) {
    const faults = Number(decision.faults) || 1;
    const at = Number(decision.retryAt);
    if (decision.action === 'fault_wait' && Number.isFinite(at) && at > 0) {
      const clock = formatClock(at);
      if (decision.retryCategory === 'capacity') {
        return `上游额度/线路暂不可用，将在 ${clock} 自动重试（第 ${faults} 次）`;
      }
      return `故障后将在 ${clock} 自动重试（第 ${faults} 次）`;
    }
    return `故障后自动继续（第 ${faults} 次）`;
  }

  // One waiting push/notice when the streak first reaches 3. The session stays
  // active; the notice exists so a long outage is visible and the user knows a
  // pause would take over immediately.
  function maybeFaultNotice(sessionId, before, decision) {
    const faults = Number(decision.faults) || 0;
    const previous = Number(before && before.stall && before.stall.consecutiveFaults) || 0;
    if (faults !== 3 || previous >= 3) return;
    const at = Number(decision.retryAt);
    const when = Number.isFinite(at) && at > 0
      ? `下一次尝试预计在 ${formatClock(at)}`
      : '下一次尝试即将开始';
    const message = `无人值守仍在自动重试：连续第 ${faults} 次上游故障，${when}；你可以随时暂停并接管。`;
    try { notify(sessionId, 'waiting', message, {}); } catch (_) { /* push is best-effort */ }
    try { broadcast(sessionId, { type: 'notify', state: 'waiting', message }); } catch (_) {}
  }

  // Earliest epoch-ms the provider / Auto pool could accept work again. The
  // port is optional; a broken read must never turn into a bogus restriction.
  async function retryNotBeforeOf(sessionId) {
    if (typeof getRetryNotBefore !== 'function') return undefined;
    try {
      const value = Number(await getRetryNotBefore(sessionId));
      return Number.isFinite(value) && value > 0 ? value : undefined;
    } catch (error) {
      log(`[unattended] retryNotBefore read failed for ${sessionId}: ${error && error.message ? error.message : error}`);
      return undefined;
    }
  }

  // The ONE entry for every way a turn can end: D/W settle, E fault, user
  // cancel, host-side cancel (watchdog, stalled recovery, restart/shutdown,
  // provider reclaim) and a boot replay of a settle that happened before this
  // host was ready. The host only gathers facts — the classify letter, the
  // cancel attribution, whether the API policy scheduled a retry, whether the
  // scheduler still has staged backlog — and native/core/src/unattended.rs
  // decides the single action (`evaluate | fault_continue | fault_wait |
  // needs_human | pause | none`). Every no-action/decision-failure branch
  // releases the held classic push, so a settle is never silent.
  async function onTurnEnd(sessionId, facts = {}) {
    const {
      kind = 'settle',
      settle = '',
      turnId = '',
      cancelSource = '',
      killReason = '',
      retryScheduled,
      handoffPending = false,
      faultCategory = '',
      assistantText = '',
      fallbackPush = null,
    } = facts;
    const push = typeof fallbackPush === 'function' ? fallbackPush : null;
    const state = stateOf(sessionId);
    if (!state || state.status !== STATUS.ACTIVE) {
      firePush(push);
      return null;
    }
    // A late deadline must not let a stale settle buy another round. Expiry
    // produces its own notice, so the held push stays suppressed.
    if (expireIfDue(sessionId)) return null;
    // 等待/异常优先恢复；只有正常完成时才因 FIFO 推迟判定。
    const backlog = kind === 'settle' ? await backlogPending(sessionId) : false;
    const retryNotBefore = await retryNotBeforeOf(sessionId);
    const latest = stateOf(sessionId);
    if (!latest || latest.status !== STATUS.ACTIVE) {
      releaseHeldPushes(sessionId);
      firePush(push);
      return null;
    }
    let decision;
    try {
      decision = kernel.decideTurnEnd({
        state: latest,
        now: now(),
        kind,
        settle,
        turnId,
        cancelSource,
        killReason,
        // Strict fact contract: pass the value through unchanged (undefined when
        // absent). A non-boolean is rejected by the kernel instead of being
        // silently coerced, which is how a scheduled retry used to double-inject.
        retryScheduled,
        handoffPending,
        backlogPending: backlog,
        faultCategory,
        retryNotBefore,
      });
    } catch (error) {
      log(`[unattended] turn-end decision failed for ${sessionId}: ${error && error.message ? error.message : error}`);
      releaseHeldPushes(sessionId);
      firePush(push);
      return null;
    }
    const action = decision && decision.action ? decision.action : 'none';
    if (action === 'evaluate') {
      // Claim the turn synchronously before the async verdict. The second
      // observer may report the same turn while the Aux call is in flight; the
      // persisted turn id is what makes that report a no-op.
      if (decision.nextState) write(sessionId, markSettle(decision.nextState, now()));
      return evaluate(sessionId, {
        reason: 'turn_end', assistantText, fallbackPush: push, settledAt: now(),
      });
    }
    if (action === 'pause') {
      // The kernel names the pause cause (`cancel`, or `input` for an insert).
      const by = decision.pausedBy === 'input' ? 'input' : 'cancel';
      const next = markSettle({
        ...(decision.nextState || latest),
        status: STATUS.STOPPED,
        pausedBy: by,
        evaluating: false,
        updatedAt: now(),
      }, now());
      if (!write(sessionId, next)) {
        firePush(push);
        return null;
      }
      try { tracePaused(sessionId, by); } catch (_) {}
      return next;
    }
    if (action === 'fault_continue' || action === 'fault_wait' || action === 'needs_human') {
      if (!decision.nextState) {
        firePush(push);
        return null;
      }
      if (!write(sessionId, markSettle(decision.nextState, now()))) {
        firePush(push);
        return null;
      }
      if (action === 'fault_continue') {
        trace(sessionId, tagged(faultTrace(decision)));
        maybeFaultNotice(sessionId, latest, decision);
        if (typeof inject === 'function') trackInjection(sessionId, inject(sessionId, tagged(decision.message), { unattendedRecovery: true }), 'fault');
        return decision;
      }
      if (action === 'fault_wait') {
        // The kernel persisted `retryAt`; `write` armed the one retry timer.
        trace(sessionId, tagged(faultTrace(decision)));
        maybeFaultNotice(sessionId, latest, decision);
        return decision;
      }
      traceDecision(sessionId, decision);
      Promise.resolve(apply(sessionId, decision)).catch(error => {
        log(`[unattended] fault apply failed for ${sessionId}: ${error && error.message ? error.message : error}`);
      });
      return decision;
    }
    // none: the kernel may still ask for a bookkeeping write (fault reset,
    // settle watermark, turn identity for the deferred/retry branches). The
    // held push must fire exactly once.
    if (decision && decision.nextState) {
      write(sessionId, markSettle(decision.nextState, now()));
    }
    if (push) {
      rememberHeldPush(sessionId, push);
      releaseHeldPushes(sessionId);
    }
    return { ok: false, code: (decision && decision.reason) || 'none' };
  }

  // Ordinary input joins FIFO. Rust owns whether it changes supervision;
  // explicit stop/cancel remain the takeover controls.
  function noteUserMessage(sessionId) {
    const state = stateOf(sessionId);
    if (!state || state.status !== STATUS.ACTIVE) return null;
    const decision = kernel.decideTurnEnd({ state, now: now(), kind: 'user_input' });
    if (decision.nextState && !write(sessionId, decision.nextState)) return null;
    return stateOf(sessionId);
  }

  // Called only after the replacement handoff was durably admitted. Clear the
  // old retry timer and withdraw any supervisor continuation still queued.
  function handoffAccepted(sessionId, turnId) {
    const state = stateOf(sessionId);
    if (!state || state.status !== STATUS.ACTIVE) return false;
    const decision = kernel.decideTurnEnd({ state, now: now(), kind: 'handoff_accepted', turnId });
    if (!decision?.nextState || !write(sessionId, markSettle(decision.nextState, now()))) return false;
    faultWithdrawalEpoch.set(sessionId, (faultWithdrawalEpoch.get(sessionId) || 0) + 1);
    withdrawPendingInjections(sessionId, 'fault');
    // The in-memory tracker is lost on restart; inspect the durable queue too.
    // Only the Rust-recognized fault instruction is withdrawn, and a later
    // turn's state invalidates this asynchronous cleanup.
    if (typeof kernel.selectQueued === 'function') {
      Promise.resolve().then(() => getSchedulerStatus(sessionId)).then(status => {
        if (!status || stateOf(sessionId)?.lastTurnEndId !== turnId) return;
        withdrawFaultEntries(sessionId, probeHandoffQueue(status).faultEntryIds);
      }).catch(error => log(`[unattended] queued fault lookup failed for ${sessionId}: ${error.message}`));
    }
    return true;
  }

  // A restart can settle a turn before this host is ready: the processing
  // watchdog writes E + cancelledAt straight to the task state, and the live
  // `onTurnEnd` never runs. Replay those settles — once. `lastSettleAt` is
  // persisted together with every state write this host makes, so a settle it
  // already handled is never replayed. Only cancellations are replayed here: a
  // plain D/W/E that this host never saw is ambiguous with an API-policy retry
  // and must not be guessed.
  //
  // A persisted `P` turn with no cancel record belongs to the processing
  // watchdog, not to boot: the runner is gone, so its dead-runner detection
  // cancels it through the same single entry (`cancelSource:process_watchdog`).
  // This function therefore never invents a settle for that shape — two owners
  // would depend on `duplicate_turn` for the continuation to stay single.
  async function reconcileStartup() {
    const settled = [];
    const failed = [];
    let ids = [];
    try { ids = Array.from(listSessionIds() || []); } catch (_) { ids = []; }
    const replay = async (sessionId, facts) => {
      const result = await onTurnEnd(sessionId, facts);
      if (result && !(result.ok === false && result.code === 'duplicate_turn')) settled.push(result);
    };
    for (const sessionId of ids) {
      // One broken session must never stop the rest of the boot pass.
      try {
        let state;
        try { state = stateOf(sessionId); } catch (_) { state = null; }
        if (!state || state.status !== STATUS.ACTIVE) continue;
        let taskState;
        try { taskState = getTaskState(sessionId) || {}; } catch (_) { taskState = {}; }
        const cancelledAt = Number(taskState.cancelledAt || 0);
        const cancelSource = taskState.cancelSource || '';
        // A live `P` (or a shutdown-killed one) has no cancel record: the
        // processing watchdog owns that turn end. Only a recorded cancel is
        // replayed here.
        if (!cancelledAt || !cancelSource) continue;
        // Only events inside the CURRENT run belong to it. A historical settle
        // that predates this run's startedAt must not pause or continue it.
        const startedAt = Number(state.startedAt || 0);
        const settledAt = Math.max(Number(taskState.endedAt || 0), cancelledAt);
        if (!(settledAt > startedAt)) continue;
        if (!(settledAt > Number(state.lastSettleAt || 0))) continue;
        let status = null;
        try { status = await getSchedulerStatus(sessionId); } catch (_) { status = null; }
        // A live/recovered slot is not this replay's business; the watchdog and
        // the normal turn end own it.
        if (status && status.active) continue;
        await replay(sessionId, {
          kind: 'cancel',
          settle: 'E',
          turnId: taskState.turnId || '',
          cancelSource,
          killReason: taskState.cancelReason || cancelSource,
        });
      } catch (error) {
        failed.push({ sessionId, error });
        log(`[unattended] startup reconcile failed for ${sessionId}: ${error && error.message ? error.message : error}`);
      }
    }
    if (failed.length) {
      log(`[unattended] startup reconcile: ${failed.length} session(s) failed: ${failed.map(item => item.sessionId).join(', ')}`);
    }
    return { settled, failed, failedIds: failed.map(item => item.sessionId) };
  }

  function stats() {
    return { inFlight: inFlight.size, queued: queued.size, heldPushes: heldPushes.size, timers: timers.size, retryTimers: retryTimers.size };
  }

  return Object.freeze({
    armFromRequest,
    clear,
    evaluate,
    get,
    handoffAccepted,
    noteUserMessage,
    onTurnEnd,
    reconcileStartup,
    rearmTimer,
    resume,
    shouldHoldPush,
    shutdown,
    start,
    stats,
    stop,
    tag,
    update,
  });
}

module.exports = { createUnattendedHost, STATUS };
