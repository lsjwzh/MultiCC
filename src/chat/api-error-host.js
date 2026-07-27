'use strict';

const { isErrorOnlyText, retryNotice } = require('./api-error-policy');
const { SYSTEM_PREFIX } = require('../session-delivery');

function createApiErrorHost(options = {}) {
  const {
    policy,
    logger,
    persistedSessions,
    getTaskState,
    setTaskState,
    chatBroadcast,
    workspaceBroadcast,
    sessionDelivery,
    getAuxQueue,
    setSessionStatus,
    clearIncrementalSave,
    isCurrentTurnRunner,
    isShuttingDown,
  } = options;
  const functionPorts = {
    getTaskState, setTaskState, chatBroadcast, workspaceBroadcast, getAuxQueue,
    setSessionStatus, clearIncrementalSave, isCurrentTurnRunner, isShuttingDown,
  };
  for (const [name, value] of Object.entries(functionPorts)) {
    if (typeof value !== 'function') throw new TypeError(`api error host dependency missing: ${name}`);
  }
  if (!policy || typeof policy.evaluate !== 'function' || typeof policy.recordSuccess !== 'function') {
    throw new TypeError('api error host dependency missing: policy');
  }
  if (!logger || !persistedSessions || !sessionDelivery
      || typeof sessionDelivery.deliverRetry !== 'function') {
    throw new TypeError('api error host dependency missing: object port');
  }
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const setTimeoutFn = typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout;
  const clearTimeoutFn = typeof options.clearTimeout === 'function' ? options.clearTimeout : clearTimeout;
  const setIntervalFn = typeof options.setInterval === 'function' ? options.setInterval : setInterval;
  const clearIntervalFn = typeof options.clearInterval === 'function' ? options.clearInterval : clearInterval;
  const networkThreshold = Math.max(2, Number(options.networkThreshold || 3));
  const probeIntervalMs = Math.max(1_000, Number(options.probeIntervalMs || 30_000));
  const probeTimeoutMs = Math.max(1_000, Number(options.probeTimeoutMs || 15_000));
  const network = {
    unhealthy: false,
    sinceAt: null,
    consecutiveFails: 0,
    lastFailAt: null,
    lastFailMsg: '',
    heldSessions: new Map(),
    probeTimer: null,
  };

  function stopNetworkProbe() {
    if (!network.probeTimer) return;
    clearIntervalFn(network.probeTimer);
    network.probeTimer = null;
  }

  async function resumeHeldSessions() {
    const held = new Map(network.heldSessions);
    network.heldSessions.clear();
    let index = 0;
    for (const [sessionId, info] of held) {
      if (!persistedSessions.has(sessionId)) continue;
      const recovery = `上游 API 已恢复。之前因 API 异常暂挂的任务「${info.goal || '未命名'}」现在可以继续了。`;
      const message = info.pendingText
        ? `${recovery}（含暂挂期间被暂存的真实数据，请据此继续）\n${info.pendingText}`
        : `${recovery}请确认当前状态并继续执行。`;
      try {
        await sessionDelivery.deliverRetry(sessionId, message, {
          idempotencyKey: `api-recovery:${sessionId}:${info.heldAt}`,
          taskSource: 'api_recovery',
        });
      } catch (_) {}
      logger.info('api_error_held_session_resumed', { sessionId });
      if (++index < held.size) await new Promise(resolve => setTimeoutFn(resolve, 2_000));
    }
  }

  function recordApiSuccess(provider, context = {}) {
    policy.recordSuccess(provider || 'unknown', context);
    if (!network.consecutiveFails && !network.unhealthy) return;
    network.consecutiveFails = 0;
    if (!network.unhealthy) return;
    network.unhealthy = false;
    const heldCount = network.heldSessions.size;
    logger.info('api_error_network_recovered', { heldCount });
    resumeHeldSessions();
    stopNetworkProbe();
  }

  function startNetworkProbe() {
    stopNetworkProbe();
    const probe = () => {
      if (!network.unhealthy) return;
      const auxQueue = getAuxQueue();
      if (!auxQueue) return;
      if (auxQueue.queue.some(task => task.type === 'network_probe')
          || auxQueue.currentTask?.type === 'network_probe') return;
      auxQueue.enqueue({
        type: 'network_probe',
        prompt: '回复 ok',
        meta: { timeout: probeTimeoutMs },
      }).then(result => {
        if (result && !result.cancelled && result.text && /ok/i.test(result.text)) {
          recordApiSuccess('aux-probe');
        }
      }).catch(() => {});
    };
    network.probeTimer = setIntervalFn(probe, probeIntervalMs);
    if (network.probeTimer && typeof network.probeTimer.unref === 'function') network.probeTimer.unref();
    probe();
  }

  function recordApiError(raw, context = {}) {
    const decision = policy.evaluate(raw, context);
    if (decision.duplicate || decision.error.category !== 'network') return decision;
    network.consecutiveFails += 1;
    network.lastFailAt = now();
    network.lastFailMsg = decision.error.sanitizedMessage;
    if (network.consecutiveFails >= networkThreshold && !network.unhealthy) {
      network.unhealthy = true;
      network.sinceAt = now();
      logger.error('api_error_network_hold', {
        category: decision.error.category,
        provider: decision.error.provider,
        consecutiveFails: network.consecutiveFails,
      });
      startNetworkProbe();
    }
    return decision;
  }

  function auxHealthProbe() {
    const auxQueue = getAuxQueue();
    const health = auxQueue?.getStatus().health;
    if (!health?.unhealthy || (health.retryAt && health.retryAt > now())
        || (health.retryable === false && !health.retryAt)) return;
    auxQueue.enqueue({
      type: 'health_probe',
      prompt: '回复一个字：ok',
      meta: { probe: true },
    }).then(result => {
      if (result && !result.cancelled) auxQueue.recordSuccess();
    }).catch(() => {});
  }

  function evaluateTurnApiError({
    sessionName,
    cs,
    persisted,
    turn,
    runner,
    raw,
    attempt = 0,
    phase,
    partialOutput,
    sideEffects,
  }) {
    const provider = String(persisted?.cli || cs?.cli || raw?.provider || 'unknown').toLowerCase();
    const decision = recordApiError(raw, {
      provider,
      source: raw?.source || 'process_stderr',
      sessionId: sessionName,
      turnId: turn?.turnId,
      attempt,
      phase,
      partialOutput,
      sideEffects,
      elapsedMs: Number.isFinite(Number(cs?.turnStartedAt))
        ? Math.max(0, now() - Number(cs.turnStartedAt))
        : 0,
      idempotencyKey: `${turn?.turnId || sessionName}:${attempt}:${provider}`,
    });
    if (runner) {
      runner.apiErrorDecision = decision;
      runner.apiErrorRaw = raw;
    }
    if (cs) cs._lastApiErrorDecision = decision;
    const safe = {
      category: decision.error.category,
      provider: decision.error.provider,
      code: decision.error.code,
      httpStatus: decision.error.httpStatus,
      retryable: decision.error.retryable,
      safeToRetry: decision.error.safeToRetry,
      retryAfterMs: decision.error.retryAfterMs,
      phase: decision.error.phase,
      partialOutput: decision.error.partialOutput,
      attempt: decision.attempt || attempt,
      maxAttempts: decision.error.maxAttempts,
      action: decision.action,
      reason: decision.reason,
      retryAt: decision.retryAt || null,
      userAction: decision.error.userAction,
      at: now(),
    };
    setTaskState(sessionName, { apiError: safe }, { save: true });
    if (!decision.duplicate) {
      const message = retryNotice(decision);
      chatBroadcast(sessionName, {
        type: 'api_error_policy',
        state: decision.action === 'retry' ? 'retry_wait' : 'failed',
        message,
        ...safe,
      });
      chatBroadcast(sessionName, { type: 'system', subtype: 'warning', message });
    }
    return decision;
  }

  function meaningfulTurnOutput(cs) {
    const text = String(cs?.currentAssistantText || '');
    return !!(text.trim() && !isErrorOnlyText(text));
  }

  function turnHasSideEffects(cs) {
    return !!(cs?.currentToolCalls || []).some(tool => tool && tool.name !== 'Thinking');
  }

  function clearSessionApiErrorState(sessionName, cs) {
    if (cs) {
      cs._apiRetryAttempt = 0;
      cs._lastApiErrorDecision = null;
    }
    setTaskState(sessionName, { apiError: null }, { save: false });
  }

  function scheduleOwnedRetry({
    sessionName,
    cs,
    persisted,
    turn,
    runner,
    decision,
    provider,
    start,
  }) {
    const delayMs = Math.max(0, Number(decision.delayMs) || 0);
    runner.retryPlanned = true;
    cs._apiRetryAttempt = decision.attempt;
    cs.isStreaming = true;
    clearIncrementalSave(sessionName);
    setSessionStatus(sessionName, { status: 'waiting', currentFile: null });
    cs._apiRetryTimer = setTimeoutFn(() => {
      cs._apiRetryTimer = null;
      const deleted = !persistedSessions.has(sessionName);
      if (isShuttingDown() || deleted || !isCurrentTurnRunner(cs, turn, runner)) {
        logger.info('api_error_retry_cancelled', {
          sessionId: sessionName,
          provider,
          attempt: decision.attempt,
          reason: isShuttingDown() ? 'shutdown' : deleted ? 'session_deleted' : 'superseded',
        });
        return;
      }
      cs.currentAssistantText = '';
      cs.currentToolCalls = [];
      cs._resultSaved = false;
      cs._adapterError = null;
      cs._sawApiError = false;
      cs._codexTransportError = '';
      cs.streamReplay = [];
      setSessionStatus(sessionName, { status: 'thinking', currentFile: null });
      logger.info('api_error_retry_started', {
        sessionId: sessionName,
        provider,
        attempt: decision.attempt,
      });
      start();
    }, delayMs);
    if (cs._apiRetryTimer && typeof cs._apiRetryTimer.unref === 'function') cs._apiRetryTimer.unref();
  }

  function isNetworkUnhealthy() {
    return network.unhealthy;
  }

  function mergeHeldPendingText(pendingText, prior) {
    const newIsNudge = typeof pendingText === 'string' && pendingText.startsWith(SYSTEM_PREFIX);
    const priorIsReal = prior?.pendingText != null
      && !String(prior.pendingText).startsWith(SYSTEM_PREFIX);
    if (newIsNudge && priorIsReal) return prior.pendingText;
    return pendingText != null ? pendingText : prior?.pendingText || null;
  }

  function holdSession(sessionId, reason, pendingText) {
    if (!network.unhealthy) return;
    const persisted = persistedSessions.get(sessionId);
    if (!persisted) return;
    const taskState = getTaskState(persisted);
    const prior = network.heldSessions.get(sessionId);
    network.heldSessions.set(sessionId, {
      goal: taskState.goal || (typeof persisted.summary === 'string' ? persisted.summary.slice(0, 40) : ''),
      heldAt: prior?.heldAt || now(),
      reason: reason || prior?.reason || 'API 异常',
      pendingText: mergeHeldPendingText(pendingText, prior),
    });
    if (!prior && persisted.dirId) {
      workspaceBroadcast(persisted.dirId, {
        type: 'notify',
        sessionId,
        state: 'waiting',
        message: `上游 API 异常，任务「${taskState.goal || '未命名'}」已暂挂，恢复后自动接续`,
      });
    }
  }

  function isHeld(sessionId) {
    return network.heldSessions.has(sessionId);
  }

  function cancelRetry(sessionId, cs) {
    if (!cs?._apiRetryTimer) return false;
    clearTimeoutFn(cs._apiRetryTimer);
    cs._apiRetryTimer = null;
    return true;
  }

  function snapshot() {
    return {
      unhealthy: network.unhealthy,
      sinceAt: network.sinceAt,
      consecutiveFails: network.consecutiveFails,
      heldSessions: network.heldSessions.size,
      policy: policy.snapshot(),
    };
  }

  return Object.freeze({
    recordApiError,
    recordApiSuccess,
    evaluateTurnApiError,
    meaningfulTurnOutput,
    turnHasSideEffects,
    clearSessionApiErrorState,
    scheduleOwnedRetry,
    isNetworkUnhealthy,
    holdSession,
    isHeld,
    cancelRetry,
    auxHealthProbe,
    stopNetworkProbe,
    snapshot,
  });
}

module.exports = { createApiErrorHost };
