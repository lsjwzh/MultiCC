'use strict';

const { isErrorOnlyText, retryNotice } = require('./api-error-policy');
const { vendorLoginForCli } = require('../cli-adapters/vendor-login');

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
    setTaskState,
    chatBroadcast,
    setSessionStatus,
    clearIncrementalSave,
    isCurrentTurnRunner,
    isShuttingDown,
  } = options;
  const functionPorts = {
    setTaskState, chatBroadcast,
    setSessionStatus, clearIncrementalSave, isCurrentTurnRunner, isShuttingDown,
  };
  for (const [name, value] of Object.entries(functionPorts)) {
    if (typeof value !== 'function') throw new TypeError(`api error host dependency missing: ${name}`);
  }
  if (!policy || typeof policy.evaluate !== 'function' || typeof policy.recordSuccess !== 'function') {
    throw new TypeError('api error host dependency missing: policy');
  }
  if (!logger || !persistedSessions) {
    throw new TypeError('api error host dependency missing: object port');
  }
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const setTimeoutFn = typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout;
  const clearTimeoutFn = typeof options.clearTimeout === 'function' ? options.clearTimeout : clearTimeout;

  function recordApiSuccess(provider, context = {}) {
    policy.recordSuccess(provider || 'unknown', context);
  }

  function recordApiError(raw, context = {}) {
    return policy.evaluate(raw, context);
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
    const turnElapsedMs = Number.isFinite(Number(cs?.turnStartedAt))
      ? Math.max(0, observedAt - Number(cs.turnStartedAt)) : 0;
    const identity = turnProviderIdentity({ runner, persisted, cs, raw });
    const decision = recordApiError(raw, {
      // `provider` is the legacy public field and intentionally remains the
      // CLI. providerId is additive route diagnostics for this request only.
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
      // Vendor-auth CLIs (WorkBuddy/Qoder) own their account: an auth failure
      // can only be fixed by logging in inside the vendor TUI. Attach a
      // structured action so clients can render a one-click "open login
      // terminal" button instead of a dead-end text notice.
      const vendorLogin = decision.error.category === 'authentication_permission'
        ? vendorLoginForCli(identity.cli) : null;
      const authAction = vendorLogin ? {
        kind: 'vendor_login_terminal',
        cli: identity.cli,
        label: vendorLogin.label,
        loginCommand: vendorLogin.loginCommand,
      } : null;
      const baseMessage = retryNotice(decision);
      const message = vendorLogin
        ? `${baseMessage} ${vendorLogin.label} 使用厂商独立账号：点下方按钮打开登录终端，输入 ${vendorLogin.loginCommand} 完成登录后再重新发送。`
        : baseMessage;
      chatBroadcast(sessionName, {
        type: 'api_error_policy',
        state: decision.action === 'retry' ? 'retry_wait' : 'failed',
        message,
        ...safe,
        ...(authAction ? { authAction } : {}),
      });
      if (!deferNotice) {
        chatBroadcast(sessionName, {
          type: 'system', subtype: 'warning', message,
          ...(authAction ? { authAction } : {}),
        });
      }
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

  function cancelRetry(sessionId, cs) {
    if (!cs?._apiRetryTimer) return false;
    clearTimeoutFn(cs._apiRetryTimer);
    cs._apiRetryTimer = null;
    return true;
  }

  function snapshot() {
    return { policy: policy.snapshot() };
  }

  return Object.freeze({
    recordApiError,
    recordApiSuccess,
    evaluateTurnApiError,
    meaningfulTurnOutput,
    turnHasSideEffects,
    clearSessionApiErrorState,
    scheduleOwnedRetry,
    cancelRetry,
    snapshot,
  });
}

module.exports = { createApiErrorHost };
