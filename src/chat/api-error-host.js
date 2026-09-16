'use strict';

const { isErrorOnlyText, retryNotice } = require('./api-error-policy');
const { SYSTEM_PREFIX } = require('../session/delivery');

function cleanIdentity(value) {
  return value == null ? '' : String(value).trim();
}

function positiveIdentityNumber(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

// A logical turn can move between concrete provider routes. Error policy must
// therefore read the immutable runner-owned attempt before mutable session
// defaults. Field-wise fallback lets providerAttempt carry the physical route
// while usageAttribution supplies the CLI on older attempt snapshots.
function turnProviderIdentity({ runner, persisted, cs, raw }) {
  const providerAttempt = runner?.providerAttempt && typeof runner.providerAttempt === 'object'
    ? runner.providerAttempt : {};
  const usageAttribution = runner?.usageAttribution && typeof runner.usageAttribution === 'object'
    ? runner.usageAttribution : {};
  const cli = cleanIdentity(
    providerAttempt.cli || usageAttribution.cli || persisted?.cli || cs?.cli || raw?.provider || 'unknown',
  ).toLowerCase() || 'unknown';
  const providerId = cleanIdentity(
    providerAttempt.providerId || usageAttribution.providerId
      || persisted?.provider || raw?.providerId || '_default_',
  ) || '_default_';
  return Object.freeze({
    cli,
    providerId,
    providerName: cleanIdentity(
      providerAttempt.providerName || usageAttribution.providerName
        || persisted?.providerName || raw?.providerName,
    ) || (providerId === '_default_' ? cli : providerId),
    turnId: cleanIdentity(
      providerAttempt.turnId || usageAttribution.turnId || raw?.turnId,
    ) || null,
    decisionId: cleanIdentity(
      providerAttempt.decisionId || usageAttribution.decisionId || raw?.decisionId,
    ) || null,
    runtimeEpoch: cleanIdentity(
      providerAttempt.runtimeEpoch || usageAttribution.runtimeEpoch || raw?.runtimeEpoch,
    ) || null,
    routeAttemptId: cleanIdentity(
      providerAttempt.routeAttemptId || usageAttribution.routeAttemptId || raw?.routeAttemptId,
    ) || null,
    routeGeneration: positiveIdentityNumber(
      providerAttempt.routeGeneration ?? usageAttribution.routeGeneration ?? raw?.routeGeneration,
    ),
    attemptNo: positiveIdentityNumber(
      providerAttempt.attemptNo ?? usageAttribution.attemptNo ?? raw?.attemptNo,
    ),
    providerRevision: cleanIdentity(
      providerAttempt.providerRevision || usageAttribution.providerRevision || raw?.providerRevision,
    ) || null,
  });
}

function turnErrorIdempotencyKey(sessionName, turn, attempt, identity) {
  const legacy = `${turn?.turnId || sessionName}:${attempt}:${identity.cli}`;
  if (!identity.routeAttemptId) return legacy;
  return `${legacy}:${identity.runtimeEpoch || '_runtime_'}:${identity.routeAttemptId}`;
}

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
    appendChatMessage,
    getAuxQueue,
    setSessionStatus,
    clearIncrementalSave,
    isCurrentTurnRunner,
    isShuttingDown,
    onApiError,
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
      const record = persistedSessions.get(sessionId);
      if (!record) continue;
      // A TaskRun error is terminal and its hidden slot may already have had
      // native history scrubbed.  Recovery must be a new TaskRun admitted by
      // Task Board, never an anonymous retry of the reusable physical slot.
      if (record.taskExecutionSlot === true) {
        logger.info('api_error_task_run_requires_new_run', { sessionId });
        continue;
      }
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
    // Recovery hook for failures the host can act on by itself (today: an
    // expired official-OAuth credential, which only a CLI run can refresh). It
    // is deliberately fire-and-forget and deliberately cannot influence the
    // decision — this turn has already failed, and repairing the credential is
    // about the *next* one. A throwing or rejecting repair must never turn one
    // API error into two.
    if (onApiError && !decision.duplicate) {
      try { Promise.resolve(onApiError(decision)).catch(() => {}); } catch (_) {}
    }
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

  // Aux is the fleet's only automatic way back. While it is unhealthy every
  // session's judgement freezes at whatever Aux last said, and this probe is the
  // one thing that can notice the upstream recovered. Two properties therefore
  // outrank politeness here:
  //
  //   1. it must fire for EVERY unhealthy state. `retryable` describes whether
  //      the failed request was worth retrying, not whether the upstream can
  //      come back: a dead credential or a lapsed subscription makes every
  //      request non-retryable, and gating on that flag left the fleet latched
  //      with no probe at all — in exactly the state that most needs a second
  //      look.
  //   2. it must back off, so an upstream that is genuinely gone costs one tiny
  //      request per 30 min instead of one per 5 min forever.
  const AUX_PROBE_BACKOFF_MS = [5 * 60_000, 10 * 60_000, 20 * 60_000, 30 * 60_000];
  const auxProbe = { episode: null, attempts: 0, nextAt: 0 };

  function auxHealthProbe() {
    const auxQueue = getAuxQueue();
    const health = auxQueue?.getStatus().health;
    if (!health?.unhealthy) {
      auxProbe.episode = null;
      auxProbe.attempts = 0;
      auxProbe.nextAt = 0;
      return;
    }
    // One unhealthy episode → one backoff schedule. `sinceAt` is stamped once,
    // when the queue first went unhealthy, so a probe that fails again cannot
    // push the next one out (the schedule is the episode's, not the last
    // failure's) — and a recovery that later fails starts over from 5 min
    // instead of waiting out the previous episode's 30.
    const episode = health.sinceAt || 0;
    if (auxProbe.episode !== episode) {
      auxProbe.episode = episode;
      auxProbe.attempts = 0;
      auxProbe.nextAt = 0;
    }
    if (auxProbe.nextAt > now()) return;
    // A credible reset time from the error taxonomy outranks the schedule:
    // waiting until then is exactly what the upstream asked for.
    if (health.retryAt && health.retryAt > now()) return;
    if (auxQueue.queue.some(task => task.type === 'health_probe')
        || auxQueue.currentTask?.type === 'health_probe') return;
    auxProbe.attempts += 1;
    const delay = AUX_PROBE_BACKOFF_MS[Math.min(auxProbe.attempts - 1, AUX_PROBE_BACKOFF_MS.length - 1)];
    auxProbe.nextAt = now() + delay;
    auxQueue.enqueue({
      type: 'health_probe',
      prompt: '回复一个字：ok',
      meta: { probe: true, timeout: probeTimeoutMs },
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
    deferNotice = false,
  }) {
    const observedAt = now();
    const recoveryTurnId = cleanIdentity(turn?.turnId);
    let recoveryStartedAt = observedAt;
    if (cs) {
      const ownedStart = Number(cs._apiRecoveryStartedAt);
      if (cs._apiRecoveryTurnId !== recoveryTurnId || !Number.isFinite(ownedStart)) {
        cs._apiRecoveryTurnId = recoveryTurnId;
        cs._apiRecoveryStartedAt = observedAt;
      }
      recoveryStartedAt = Number(cs._apiRecoveryStartedAt);
    }
    const turnElapsedMs = Number.isFinite(Number(cs?.turnStartedAt))
      ? Math.max(0, observedAt - Number(cs.turnStartedAt)) : 0;
    const recoveryElapsedMs = Math.max(0, observedAt - recoveryStartedAt);
    const identity = turnProviderIdentity({ runner, persisted, cs, raw });
    const decision = recordApiError(raw, {
      // `provider` is the legacy public field and intentionally remains the
      // CLI. providerId is additive and owns circuit/failover identity.
      provider: identity.cli,
      cli: identity.cli,
      providerId: identity.providerId,
      providerName: identity.providerName,
      decisionId: identity.decisionId,
      runtimeEpoch: identity.runtimeEpoch,
      routeAttemptId: identity.routeAttemptId,
      routeGeneration: identity.routeGeneration,
      attemptNo: identity.attemptNo,
      providerRevision: identity.providerRevision,
      providerRouteScope: identity.runtimeEpoch && identity.decisionId && identity.routeAttemptId
        && identity.routeGeneration && identity.attemptNo && identity.providerRevision
        ? 'attempt' : null,
      source: raw?.source || 'process_stderr',
      sessionId: sessionName,
      turnId: turn?.turnId,
      attempt,
      phase,
      partialOutput,
      sideEffects,
      turnElapsedMs,
      recoveryElapsedMs,
      // Compatibility for policy runtimes that have not learned the explicit
      // recovery field yet. It intentionally no longer means turn duration.
      elapsedMs: recoveryElapsedMs,
      idempotencyKey: turnErrorIdempotencyKey(sessionName, turn, attempt, identity),
    });
    if (runner) {
      runner.apiErrorDecision = decision;
      runner.apiErrorRaw = raw;
    }
    if (cs) cs._lastApiErrorDecision = decision;
    const routeIdentity = identity.runtimeEpoch && identity.decisionId && identity.routeAttemptId
        && identity.routeGeneration && identity.attemptNo && identity.providerRevision ? {
      providerRouteScope: 'attempt',
      runtimeEpoch: decision.error.runtimeEpoch || identity.runtimeEpoch,
      turnId: decision.error.turnId || identity.turnId || turn?.turnId,
      decisionId: decision.error.decisionId || identity.decisionId,
      routeAttemptId: decision.error.routeAttemptId || identity.routeAttemptId,
      routeGeneration: decision.error.routeGeneration ?? identity.routeGeneration,
      attemptNo: decision.error.attemptNo ?? identity.attemptNo,
      providerRevision: decision.error.providerRevision || identity.providerRevision,
    } : {};
    const safe = {
      category: decision.error.category,
      provider: decision.error.provider,
      providerId: decision.error.providerId || identity.providerId,
      providerName: decision.error.providerName || identity.providerName,
      ...routeIdentity,
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
      rootCause: decision.error.rootCause || decision.error.sanitizedMessage || null,
      param: decision.error.param || null,
      turnElapsedMs,
      recoveryElapsedMs: decision.recoveryElapsedMs ?? recoveryElapsedMs,
      budgetExhaustedBy: decision.budgetExhaustedBy || null,
      at: observedAt,
    };
    const {
      providerRouteScope: _scope, runtimeEpoch: _epoch, turnId: _turnId,
      decisionId: _decisionId, routeAttemptId: _routeAttemptId,
      routeGeneration: _routeGeneration, attemptNo: _attemptNo,
      providerRevision: _providerRevision, ...durableSafe
    } = safe;
    setTaskState(sessionName, { apiError: durableSafe }, { save: true });
    if (!decision.duplicate) {
      const message = retryNotice(decision);
      chatBroadcast(sessionName, {
        type: 'api_error_policy',
        state: decision.action === 'retry' ? 'retry_wait' : 'failed',
        message,
        ...safe,
      });
      if (!deferNotice) chatBroadcast(sessionName, { type: 'system', subtype: 'warning', message });
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
      cs._apiRecoveryStartedAt = null;
      cs._apiRecoveryTurnId = null;
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
    if (!prior) {
      // Surface the hold INSIDE the chat as well: while the network stays
      // unhealthy every new message is silently claim→release cycled, which
      // used to read as "insert does nothing" (the queued card shows 执行中
      // forever). One system notice per hold episode, right where the user
      // is looking. The workspace notify above remains the directory-level
      // signal.
      const notice = '上游 API 异常，消息已暂挂；网络恢复后会自动执行，无需重复发送。';
      try {
        if (typeof appendChatMessage === 'function'
            && appendChatMessage(sessionId, { role: 'system', content: notice, ts: now() })) {
          chatBroadcast(sessionId, { type: 'system', subtype: 'notice', message: notice });
        }
      } catch (_) {}
      if (persisted.dirId) {
        workspaceBroadcast(persisted.dirId, {
          type: 'notify',
          sessionId,
          state: 'waiting',
          message: `上游 API 异常，任务「${taskState.goal || '未命名'}」已暂挂，恢复后自动接续`,
        });
      }
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
