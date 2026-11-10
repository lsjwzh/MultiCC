'use strict';

const { isWaitForUserLetter } = require('../classify/vocab');

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
    notify = () => {},
    broadcast = () => {},
    appendMessage = null,
    hasQueuedDeliveries = null,
    isRunActive = () => false,
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
  // Exactly one expiry timer per active session (setTimeout to deadlineAt,
  // unref'd). Cleared on every non-active write, stop/pause/resume and shutdown;
  // re-armed by the boot migration (src/unattended/runtime.js) and by resume.
  const timers = new Map();

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

  // Re-arm once from the persisted record (boot migration); idempotent.
  function rearmTimer(sessionId) {
    syncTimer(sessionId, stateOf(sessionId));
  }

  function shutdown() {
    for (const sessionId of [...timers.keys()]) clearTimer(sessionId);
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
    syncTimer(sessionId, next);
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
    try {
      const saved = appendMessage(sessionId, entry);
      if (saved === false) return null;
    } catch (error) {
      log(`[unattended] trace append failed for ${sessionId}: ${error && error.message ? error.message : error}`);
      return null;
    }
    try {
      broadcast(sessionId, {
        type: 'unattended_trace',
        kind: 'unattended_trace',
        message: entry.content,
        entry,
      });
    } catch (_) { /* live broadcast is best-effort; the durable line already exists */ }
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
    if (busy) return true;
    return backlogPending(sessionId);
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

  // FIFO backlog evidence is deliberately absent: the scheduler already gates
  // the FIFO behind a pending question (the answer runs first) and behind an E
  // fault (a continuation runs first, the FIFO stays staged until D), then
  // drains it on its own. See docs/unattended-mode.md → v2 item 2.

  function setEvaluating(sessionId, value) {
    const state = stateOf(sessionId);
    if (!state) return;
    if ((state.evaluating === true) === (value === true)) return;
    write(sessionId, { ...state, evaluating: value === true, updatedAt: now() });
  }

  async function runEvaluation(sessionId, reason, assistantText) {
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
      now: now(),
    });
    if (!write(sessionId, decision.nextState)) {
      setEvaluating(sessionId, false);
      return { ok: false, code: 'persist_failed' };
    }
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
  function evaluate(sessionId, { reason = 'turn_end', assistantText = '', fallbackPush = null } = {}) {
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
    return runEvaluation(sessionId, reason, assistantText)
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
        await deliver(sessionId, tagged(decision.answer), {
          userInputRequestId: decision.pendingQuestionId,
          unattendedSystem: true,
          system: true,
        });
        return;
      }
      // The marker is added by code, never by the model; re-tagging also
      // normalises any marker the aux emitted itself.
      if (typeof inject === 'function') inject(sessionId, tagged(message));
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

  function resetFaultCounter(sessionId) {
    const state = stateOf(sessionId);
    if (!state || state.status !== STATUS.ACTIVE) return;
    const stall = state.stall || {};
    if (!stall.consecutiveFaults) return;
    write(sessionId, {
      ...state,
      stall: { ...stall, consecutiveFaults: 0 },
      updatedAt: now(),
    });
  }

  // Called by the classify state machine when a turn settles as D or W.
  // `settle` is the classify letter. A D with staged FIFO work is NOT judged
  // yet: the scheduler will drain that queue on its own, and a verdict on this
  // now-stale output would only burn a round and queue an instruction ahead of
  // the user's work (a supervisor continuation is an "insert now" control).
  // The last backlog turn's own D settle then makes the verdict. W must still
  // be judged: its pending question is exactly what the aux has to answer.
  async function onTurnSettled(sessionId, { assistantText = '', fallbackPush = null, settle = 'D' } = {}) {
    const state = stateOf(sessionId);
    if (!state || state.status !== STATUS.ACTIVE) {
      if (typeof fallbackPush === 'function') {
        try { fallbackPush(); } catch (_) {}
      }
      return null;
    }
    // A clean D/W settle proves the upstream recovered.
    resetFaultCounter(sessionId);
    // A late deadline must not let a stale backlog deferral buy another round.
    if (expireIfDue(sessionId)) return null;
    if (!isWaitForUserLetter(settle) && await backlogPending(sessionId)) {
      // Release the held classic push as every no-op path does, so this settle
      // is never silent while the scheduler drains the backlog.
      rememberHeldPush(sessionId, fallbackPush);
      releaseHeldPushes(sessionId);
      return { ok: false, code: 'backlog_pending' };
    }
    return evaluate(sessionId, { reason: 'turn_end', assistantText, fallbackPush });
  }

  // A user Cancel is a deliberate stop, not a fault.
  function onManualCancel(sessionId) {
    const state = stateOf(sessionId);
    if (!state || state.status !== STATUS.ACTIVE) return null;
    return pause(sessionId, 'cancel');
  }

  // A real user message takes over: pause first, then the caller delivers the
  // message normally. System-injected messages never reach this port.
  function noteUserMessage(sessionId) {
    const state = stateOf(sessionId);
    if (!state || state.status !== STATUS.ACTIVE) return null;
    return pause(sessionId, 'input');
  }

  // Immediate fault (E) continuation, no Aux call. The API-error policy has
  // already decided there is no bounded retry left to make.
  function onFault(sessionId, { reason = 'api_error' } = {}) {
    if (expireIfDue(sessionId)) return null;
    const state = stateOf(sessionId);
    if (!state || state.status !== STATUS.ACTIVE) return null;
    const decision = kernel.decideFault({ state, now: now(), reason });
    if (!decision || decision.action === 'none') return null;
    if (!write(sessionId, decision.nextState)) return null;
    if (decision.action === 'fault_continue') {
      trace(sessionId, tagged(`故障后自动继续（第 ${decision.faults} 次）`));
      if (typeof inject === 'function') inject(sessionId, tagged(decision.message));
      return decision;
    }
    traceDecision(sessionId, decision);
    Promise.resolve(apply(sessionId, decision)).catch(error => {
      log(`[unattended] fault apply failed for ${sessionId}: ${error && error.message ? error.message : error}`);
    });
    return decision;
  }

  function stats() {
    return { inFlight: inFlight.size, queued: queued.size, heldPushes: heldPushes.size, timers: timers.size };
  }

  return Object.freeze({
    armFromRequest,
    evaluate,
    get,
    noteUserMessage,
    onFault,
    onManualCancel,
    onTurnSettled,
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
