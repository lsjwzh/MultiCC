'use strict';

// Unattended-mode supervisor glue. All decisions (goal caps, verdict prompt,
// parse tolerance, budget/stall/aux-failure policy) are in
// native/core/src/unattended.rs; this host only gathers evidence, calls the aux
// queue, persists `record.unattended`, applies the decided action and broadcasts.
//
// State shape and the wire contract: docs/unattended-mode.md.

const STATUS = Object.freeze({
  ACTIVE: 'active',
  ACHIEVED: 'achieved',
  NEEDS_HUMAN: 'needs_human',
  EXHAUSTED: 'exhausted',
  STOPPED: 'stopped',
  ERROR: 'error',
});

const RECENT_MESSAGES = 8;

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
    now = Date.now,
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

  function stateOf(sessionId) {
    const record = getRecord(sessionId);
    const state = record && record.unattended;
    return state && typeof state === 'object' ? state : null;
  }

  function get(sessionId) {
    return stateOf(sessionId);
  }

  function write(sessionId, next) {
    try {
      persistState(sessionId, next);
    } catch (error) {
      log(`[unattended] persist failed for ${sessionId}: ${error && error.message ? error.message : error}`);
      return false;
    }
    try {
      broadcast(sessionId, { type: 'unattended_state', unattended: next });
    } catch (_) { /* a dead socket must not fail the state write */ }
    return true;
  }

  function freshState(config) {
    const at = now();
    return {
      status: STATUS.ACTIVE,
      goal: config.goal,
      criteria: Array.isArray(config.criteria) ? config.criteria : [],
      maxRounds: config.maxRounds,
      rounds: 0,
      startedAt: at,
      updatedAt: at,
      lastVerdict: null,
      history: [],
      stall: { sameInstruction: 0, auxFailures: 0 },
    };
  }

  function sameConfig(state, config) {
    return state.goal === config.goal
      && state.maxRounds === config.maxRounds
      && JSON.stringify(state.criteria || []) === JSON.stringify(config.criteria || []);
  }

  function usable(sessionId) {
    const record = getRecord(sessionId);
    return !!record && record.type !== 'aux' && record.type !== 'gateway';
  }

  // First-message arming. `spec` is the `unattended` object the client sent on
  // the first message; `defaultGoal` is that message's text. Re-arming with the
  // identical config is a no-op so a shell receipt retry cannot reset rounds.
  function armFromRequest(sessionId, spec, { defaultGoal = '' } = {}) {
    if (!spec || typeof spec !== 'object') return { ok: false, code: 'invalid_spec' };
    if (!usable(sessionId)) return { ok: false, code: 'session_not_found' };
    const normalized = kernel.normalizeConfig({
      goal: spec.goal == null || spec.goal === '' ? defaultGoal : spec.goal,
      criteria: spec.criteria,
      maxRounds: spec.maxRounds,
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

  function start(sessionId, body = {}) {
    if (!usable(sessionId)) return { ok: false, code: 'session_not_found', status: 404 };
    const normalized = kernel.normalizeConfig({
      goal: body.goal,
      criteria: body.criteria,
      maxRounds: body.maxRounds,
    });
    if (!normalized.ok) return { ok: false, code: normalized.error || 'goal_required', status: 400 };
    const next = freshState(normalized.config);
    if (!write(sessionId, next)) return { ok: false, code: 'persist_failed', status: 500 };
    if (body.evaluateNow !== false) evaluate(sessionId, { reason: 'start' });
    return { ok: true, unattended: next };
  }

  function update(sessionId, body = {}) {
    const current = stateOf(sessionId);
    if (!current) return { ok: false, code: 'no_unattended', status: 409 };
    if (current.status !== STATUS.ACTIVE && current.status !== STATUS.NEEDS_HUMAN) {
      return { ok: false, code: 'invalid_state', status: 409 };
    }
    const normalized = kernel.normalizeConfig({
      goal: body.goal == null ? current.goal : body.goal,
      criteria: body.criteria == null ? current.criteria : body.criteria,
      maxRounds: body.maxRounds == null ? current.maxRounds : body.maxRounds,
    });
    if (!normalized.ok) return { ok: false, code: normalized.error || 'goal_required', status: 400 };
    const next = {
      ...current,
      goal: normalized.config.goal,
      criteria: normalized.config.criteria,
      maxRounds: normalized.config.maxRounds,
      updatedAt: now(),
    };
    if (!write(sessionId, next)) return { ok: false, code: 'persist_failed', status: 500 };
    return { ok: true, unattended: next };
  }

  function stop(sessionId) {
    const current = stateOf(sessionId);
    if (!current) return { ok: false, code: 'no_unattended', status: 409 };
    if (current.status === STATUS.STOPPED) return { ok: true, unattended: current };
    const next = { ...current, status: STATUS.STOPPED, updatedAt: now() };
    if (!write(sessionId, next)) return { ok: false, code: 'persist_failed', status: 500 };
    return { ok: true, unattended: next };
  }

  function resume(sessionId) {
    const current = stateOf(sessionId);
    if (!current) return { ok: false, code: 'no_unattended', status: 409 };
    const resumable = [STATUS.NEEDS_HUMAN, STATUS.EXHAUSTED, STATUS.STOPPED, STATUS.ERROR];
    if (!resumable.includes(current.status)) return { ok: false, code: 'invalid_state', status: 409 };
    const next = {
      ...current,
      status: STATUS.ACTIVE,
      rounds: current.status === STATUS.EXHAUSTED ? 0 : current.rounds,
      stall: { sameInstruction: 0, auxFailures: 0 },
      updatedAt: now(),
    };
    if (!write(sessionId, next)) return { ok: false, code: 'persist_failed', status: 500 };
    evaluate(sessionId, { reason: 'resume' });
    return { ok: true, unattended: next };
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
      maxRounds: state.maxRounds,
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

  async function runEvaluation(sessionId, reason, assistantText) {
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
      if (error && error.cancelled) return { ok: false, code: 'cancelled' };
      auxError = error && error.message ? error.message : String(error || 'aux_failed');
    }

    const latest = stateOf(sessionId);
    if (!latest || latest.status !== STATUS.ACTIVE) return { ok: false, code: 'superseded' };

    const verdict = auxError ? { ok: false, error: `aux_failed: ${auxError}` } : kernel.parseVerdict(text);
    const decision = kernel.decide({
      state: latest,
      verdict: verdict.ok ? verdict : undefined,
      parseError: verdict.ok ? undefined : (verdict.error || 'unparseable_verdict'),
      evaluation: collected,
      now: now(),
    });
    if (!write(sessionId, decision.nextState)) return { ok: false, code: 'persist_failed' };
    await apply(sessionId, decision);
    return { ok: true, action: decision.action, unattended: decision.nextState };
  }

  // One evaluation in flight per session; a settle that arrives meanwhile is
  // coalesced into exactly one follow-up run.
  function evaluate(sessionId, { reason = 'turn_end', assistantText = '' } = {}) {
    if (inFlight.has(sessionId)) {
      queued.add(sessionId);
      return Promise.resolve({ ok: true, deferred: true });
    }
    const state = stateOf(sessionId);
    if (!state || state.status !== STATUS.ACTIVE) return Promise.resolve({ ok: false, code: 'not_active' });
    inFlight.add(sessionId);
    return runEvaluation(sessionId, reason, assistantText)
      .catch(error => {
        log(`[unattended] evaluation failed for ${sessionId}: ${error && error.message ? error.message : error}`);
        return { ok: false, code: 'evaluation_failed' };
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
        // a user's answer so the wait_for_user_answer request is resolved.
        await deliver(sessionId, decision.answer, {
          userInputRequestId: decision.pendingQuestionId,
          unattendedSystem: true,
        });
        return;
      }
      if (typeof inject === 'function') inject(sessionId, message);
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

  // Called by the classify state machine when a turn settles as D or W.
  function onTurnSettled(sessionId, { assistantText = '' } = {}) {
    const state = stateOf(sessionId);
    if (!state || state.status !== STATUS.ACTIVE) return null;
    return evaluate(sessionId, { reason: 'turn_end', assistantText });
  }

  // A user Cancel is a deliberate stop, not a failure.
  function onManualCancel(sessionId) {
    const state = stateOf(sessionId);
    if (!state || state.status !== STATUS.ACTIVE) return null;
    const next = { ...state, status: STATUS.STOPPED, updatedAt: now() };
    write(sessionId, next);
    return next;
  }

  // A real user message does not disarm the supervisor; it only resets the
  // stall/failure counters (the human just proved they are watching).
  function noteUserMessage(sessionId) {
    const state = stateOf(sessionId);
    if (!state || state.status !== STATUS.ACTIVE) return null;
    const stall = state.stall || {};
    if (!stall.sameInstruction && !stall.auxFailures) return state;
    const next = { ...state, stall: { sameInstruction: 0, auxFailures: 0 }, updatedAt: now() };
    write(sessionId, next);
    return next;
  }

  function stats() {
    return { inFlight: inFlight.size, queued: queued.size };
  }

  return Object.freeze({
    armFromRequest,
    evaluate,
    get,
    noteUserMessage,
    onManualCancel,
    onTurnSettled,
    resume,
    start,
    stats,
    stop,
    update,
  });
}

module.exports = { createUnattendedHost, STATUS };
