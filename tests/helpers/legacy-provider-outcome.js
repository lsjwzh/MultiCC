'use strict';
// Frozen pre-migration behavior of attributeProxyUsage, observeProxyOutcome and
// proxyFailure (src/chat/provider-attempt-runtime.js). Test-only differential
// oracle; never imported by product code. It shares only primitives that had
// already moved to Rust when it was frozen (bound attempt, non-main key,
// background lingering, completion checks), called the way the runtime did.
function legacyOutcomeOperations(port) {
  const native = require('../../src/native/runtime').getNative();
  const { runtimeEpoch, proxyProducers, nonMainProxyProducers, currentBySession,
    snapshot, auditOnly, now, proxyContext } = port;
  const { sanitizeMessage, normalizeRejection } = require('./legacy-api-error-text');
  const clean = value => value == null ? '' : String(value).trim();
  const sameAttempt = (record, reference) => !!(record && reference && record.lifecycle.matches(reference));
  const backgroundLingers = record => native.providerBackgroundLingers(record);
  const boundProxyAttempt = (input = {}) => native.providerBoundProxyAttempt(input, proxyContext(input), port);
  const nonMainProducerKey = (context, event, role) => native.providerNonMainProducerKey(context, event, role);
  const snapshotSession = sessionId => snapshot(currentBySession.get(clean(sessionId)));
  const isCompleted = outcome => native.cliIsCompleted(outcome);
  const isProxyFailureCompatibleWithCompletion = (failure, outcome) => native.cliProxyFailureCompatible(failure, outcome);

  function reattributedUsage(event, facts) {
    const source = { ...event };
    if (/^uo_[a-f0-9]{32}$/.test(clean(source.eventId))) delete source.eventId;
    return Object.freeze({ ...source, ...facts });
  }

  function attributeProxyUsage(event = {}) {
    const context = proxyContext(event);
    const sessionId = context.sessionId;
    let role = clean(event.role || event.roleKind).toLowerCase();
    if (role === 'main' && context.exact && backgroundLingers(context.record)
        && !boundProxyAttempt(event) && !proxyProducers.hasEnded(sessionId)) role = 'background';
    if (role !== 'main') {
      const key = nonMainProducerKey(context, event, role);
      const producerBound = nonMainProxyProducers.bindUsage(key);
      return reattributedUsage(event, {
        sessionId, routeAttribution: 'ambiguous', producerBound,
      });
    }
    let attempt = boundProxyAttempt(event);
    if (!attempt) {
      const ended = proxyProducers.getEnded(sessionId);
      const record = currentBySession.get(sessionId);
      if (ended && context.token === ended.proxyRouteToken
          && sameAttempt(record, ended.attempt)
          && (!clean(event.providerId) || clean(event.providerId) === ended.attempt.providerId)) {
        attempt = ended.attempt;
        proxyProducers.deleteEnded(sessionId);
      }
    }
    if (!attempt) {
      auditOnly(sessionId, {
        type: 'provider_attempt_late_ignored', operation: 'proxy_usage',
        runtimeEpoch, turnId: null, routeAttemptId: null, routeGeneration: null,
        providerId: clean(event.providerId) || null,
        currentRouteAttemptId: snapshotSession(sessionId)?.routeAttemptId || null,
        currentRouteGeneration: snapshotSession(sessionId)?.routeGeneration || null,
      });
      return reattributedUsage(event, {
        sessionId,
        routeAttribution: 'ambiguous',
      });
    }
    return reattributedUsage(event, {
      sessionId,
      turnId: attempt.turnId,
      runtimeEpoch: attempt.runtimeEpoch,
      decisionId: attempt.decisionId,
      routeAttemptId: attempt.routeAttemptId,
      routeGeneration: attempt.routeGeneration,
      attemptNo: attempt.attemptNo,
      routeAttribution: 'exact',
      providerRevision: attempt.providerRevision,
    });
  }

  function observeProxyOutcome(event = {}) {
    const sessionId = clean(event.sessionId);
    const record = currentBySession.get(sessionId);
    const role = clean(event.roleKind || event.role || 'main').toLowerCase();
    if (role !== 'main' || event.routeAttribution !== 'exact'
        || !sameAttempt(record, event)
        || record.decisionId !== clean(event.decisionId)
        || record.attemptNo !== Number(event.attemptNo)
        || record.providerId !== clean(event.providerId)
        || record.providerRevision !== clean(event.providerRevision)
        || !record.lifecycle.running()) {
      auditOnly(sessionId, {
        type: 'provider_attempt_late_ignored', operation: 'proxy_outcome',
        runtimeEpoch: clean(event.runtimeEpoch) || null,
        turnId: clean(event.turnId) || null,
        routeAttemptId: clean(event.routeAttemptId) || null,
        routeGeneration: Number(event.routeGeneration) || null,
        currentRouteAttemptId: record ? record.routeAttemptId : null,
        currentRouteGeneration: record ? record.routeGeneration : null,
      });
      return Object.freeze({ accepted: false, code: 'proxy_attempt_unbound' });
    }
    const proxyOutcome = event.proxyOutcome || null;
    if (proxyOutcome && proxyOutcome.requestKind !== 'inference') {
      return Object.freeze({ accepted: true, code: 'non_inference_request', failure: null });
    }
    if (clean(event.status).toLowerCase() !== 'error') {
      if (proxyOutcome?.termination === 'completed') {
        record.lifecycle.completed();
      }
      if (proxyOutcome?.termination === 'completed'
          && record.proxyFailure
          && record.proxyFailure.recovered !== true) {
        record.proxyFailure = Object.freeze({
          ...record.proxyFailure, recovered: true, recoveredAt: Number(now()),
        });
        auditOnly(sessionId, {
          type: 'provider_attempt_proxy_failure_recovered', operation: 'proxy_outcome',
          runtimeEpoch: clean(event.runtimeEpoch) || null,
          turnId: clean(event.turnId) || null,
          routeAttemptId: clean(event.routeAttemptId) || null,
          routeGeneration: Number(event.routeGeneration) || null,
          currentRouteAttemptId: record.routeAttemptId,
          currentRouteGeneration: record.routeGeneration,
        });
      }
      return Object.freeze({ accepted: true, code: null, failure: null });
    }
    const status = Number(event.statusCode);
    const httpStatus = Number.isInteger(status) && status >= 400 && status <= 599
      ? status : null;
    auditOnly(sessionId, {
      type: 'provider_attempt_proxy_failure_observed', operation: 'proxy_outcome',
      runtimeEpoch: record.runtimeEpoch, turnId: record.turnId,
      routeAttemptId: record.routeAttemptId, routeGeneration: record.routeGeneration,
      providerId: record.providerId, httpStatus,
      code: sanitizeMessage(clean(event.errorCode) || 'UPSTREAM_HTTP_ERROR'),
      requestId: proxyOutcome?.requestId || null,
      termination: proxyOutcome?.termination || null,
    });
    if (httpStatus == null && proxyOutcome?.termination === 'downstream_disconnect'
        && record.proxyFailure) {
      return Object.freeze({ accepted: true, code: null, failure: record.proxyFailure });
    }
    const budgeted = record.lifecycle.observeFailure(
      Number.isFinite(event.requestDeadlineAt) ? event.requestDeadlineAt : NaN,
      proxyOutcome?.termination === 'upstream_failure', httpStatus || 0);
    if (event.modelProgress === true) {
      record.lifecycle.advance('visible_output');
    }
    const failureCode = clean(event.errorCode) || 'UPSTREAM_HTTP_ERROR';
    const budgetExhausted = budgeted && (record.lifecycle.stallRetryExhausted(failureCode)
      || record.lifecycle.deadlineReached(Number(now())));
    const rejection = httpStatus === 429 ? normalizeRejection(event.rejection) : null;
    record.proxyFailure = Object.freeze({
      source: 'proxy_response',
      ...(budgeted ? { requestDeadlineAt: record.lifecycle.budget().requestDeadlineAt,
        retryBudgetExhausted: budgetExhausted } : {}),
      ...(event.modelProgress === true ? { partialOutput: true } : {}),
      provider: record.cli,
      providerId: record.providerId,
      providerName: record.providerName,
      httpStatus,
      ...(rejection ? { rejection } : {}),
      code: failureCode,
      message: httpStatus ? `upstream HTTP ${httpStatus}`
        : proxyOutcome?.termination === 'downstream_disconnect'
          ? 'downstream response connection closed' : 'upstream request failed',
      observedAt: Number(now()),
      ...(proxyOutcome ? { proxyOutcome, requestId: proxyOutcome.requestId } : {}),
    });
    if (record.lifecycle.retireIfStalled(record.proxyFailure.code, budgetExhausted)) {
      auditOnly(sessionId, {
        type: 'provider_attempt_stalled', operation: 'proxy_outcome',
        runtimeEpoch: record.runtimeEpoch, turnId: record.turnId,
        routeAttemptId: record.routeAttemptId, routeGeneration: record.routeGeneration,
        providerId: record.providerId, code: record.proxyFailure.code,
        requestId: record.proxyFailure.requestId || null,
      });
    }
    return Object.freeze({ accepted: true, code: null, failure: record.proxyFailure });
  }

  function proxyFailure(reference, facts = {}) {
    const record = currentBySession.get(clean(reference && reference.sessionId));
    if (!sameAttempt(record, reference) || !record.proxyFailure) return null;
    if (facts.resultDurable === true && isCompleted(facts.completion)
        && isProxyFailureCompatibleWithCompletion(record.proxyFailure, facts.completion)) return null;
    return Object.freeze({ ...record.proxyFailure });
  }

  return { attributeProxyUsage, observeProxyOutcome, proxyFailure };
}

module.exports = { legacyOutcomeOperations };
