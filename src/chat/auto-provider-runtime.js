'use strict';

const {
  protocolOf,
  trustDomainOf,
  validateProviderSelection,
} = require('../auto-provider-config');
const {
  chooseCandidate,
  failoverSafety,
  limitState,
} = require('./auto-provider-policy');
const { STALE_MS_DEFAULT } = require('../quota/provider-limit-cache');

class AutoProviderError extends Error {
  constructor(message, code = 'AUTO_PROVIDER_UNAVAILABLE') {
    super(message);
    this.name = 'AutoProviderError';
    this.code = code;
  }
}

function createAutoProviderRuntime(options = {}) {
  const providers = options.providers;
  if (!providers || typeof providers.listProviders !== 'function'
      || typeof providers.appTypeForCli !== 'function') {
    throw new TypeError('[auto-provider] providers catalog is required');
  }
  const limitCache = options.providerLimitCache || null;
  const staleAfterMs = Math.max(1_000, Number(options.limitCacheStaleMs) || STALE_MS_DEFAULT);
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const emit = typeof options.emit === 'function' ? options.emit : () => {};
  const logger = options.logger || { info() {}, warn() {} };
  const liveBackgroundGate = typeof options.hasLiveBackgroundTasks === 'function'
    ? options.hasLiveBackgroundTasks : null;
  const stickyBySession = new Map();
  const currentBySession = new Map();
  const selectionRefBySession = new Map();

  function catalogCandidates(session, selection) {
    const cli = session.cli || 'claude';
    const appType = providers.appTypeForCli(cli);
    const resolvedAppTypes = typeof providers.appTypesForCli === 'function'
      ? providers.appTypesForCli(cli)
      : (cli === 'opencode' || cli === 'zcode' ? ['claude', 'codex'] : (appType ? [appType] : []));
    const appTypes = Array.isArray(resolvedAppTypes) ? [...new Set(resolvedAppTypes)] : [];
    const catalog = appTypes.length
      ? appTypes.flatMap(type => providers.listProviders(type))
      : providers.listProviders(appType);
    const byId = new Map((Array.isArray(catalog) ? catalog : [])
      .map(provider => [String(provider.id), provider]));
    return selection.candidates.map((candidate, index) => {
      const provider = byId.get(candidate.providerId);
      let entry = null;
      if (limitCache && provider) {
        try { entry = limitCache.get(provider.appType, provider.id); } catch (_) { entry = null; }
      }
      const limit = limitState(entry, { now: Number(now()), staleAfterMs });
      return Object.freeze({
        ...candidate,
        index,
        provider,
        providerName: provider && provider.name || candidate.providerId,
        protocol: protocolOf(provider),
        trustDomain: trustDomainOf(provider),
        model: candidate.model || provider && provider.model || null,
        limitState: limit.state,
        limitReason: limit.reason,
      });
    });
  }

  function beginTurn({ session, turnId }) {
    const rawSelection = session && session.providerSelection;
    if (!rawSelection || rawSelection.mode !== 'auto') {
      if (session && session.id) clearSession(session.id);
      return Object.freeze({
        enabled: false,
        initial: () => Object.freeze({}),
        failover: () => null,
        recordSuccess: () => {},
      });
    }
    const validated = validateProviderSelection(rawSelection, {
      cli: session.cli || 'claude', providers,
    });
    if (!validated.ok) {
      throw new AutoProviderError(validated.error, validated.code || 'INVALID_AUTO_PROVIDER_CONFIG');
    }
    // A PATCH installs a new frozen selection object on the session. Reset
    // in-memory stickiness when that object changes, even if the new JSON is
    // textually identical after Auto was disabled and re-enabled.
    if (selectionRefBySession.get(session.id) !== rawSelection) {
      stickyBySession.delete(session.id);
      currentBySession.delete(session.id);
      selectionRefBySession.set(session.id, rawSelection);
    }
    const selection = validated.value;
    const candidates = catalogCandidates(session, selection);
    const attempted = new Set();
    let current = null;
    let physicalAttempt = 0;
    let selectionFailureReason = null;

    function publish(phase, candidate, details = {}) {
      const event = Object.freeze({
        type: 'provider_auto_route',
        version: 1,
        mode: 'auto',
        sessionId: session.id,
        turnId,
        protocol: selection.protocol,
        phase,
        providerId: candidate && candidate.providerId || null,
        providerName: candidate && candidate.providerName || null,
        model: candidate && candidate.model || null,
        trustDomain: candidate && candidate.trustDomain || null,
        fromTrustDomain: null,
        toTrustDomain: candidate && candidate.trustDomain || null,
        attemptNo: physicalAttempt,
        maxAttempts: selection.maxAttempts,
        ...details,
      });
      currentBySession.set(session.id, event);
      try { emit(session.id, event); } catch (_) {}
      logger.info?.('auto_provider_route', {
        sessionId: session.id, turnId, phase,
        providerId: event.providerId, fromProviderId: event.fromProviderId || null,
        trustDomain: event.trustDomain, fromTrustDomain: event.fromTrustDomain,
        toTrustDomain: event.toTrustDomain,
        reasonCode: event.reasonCode || null, attemptNo: physicalAttempt,
      });
      return event;
    }

    function select(reasonCode) {
      selectionFailureReason = null;
      if (physicalAttempt >= selection.maxAttempts) {
        selectionFailureReason = 'attempt_budget_exhausted';
        publish('exhausted', current, { reasonCode: selectionFailureReason });
        return null;
      }
      const picked = chooseCandidate({
        candidates,
        attempted,
        stickyProviderId: selection.sticky ? stickyBySession.get(session.id) : null,
      });
      if (!picked.candidate) {
        selectionFailureReason = 'candidate_pool_exhausted';
        publish('exhausted', current, {
          reasonCode: selectionFailureReason,
          skipped: picked.skipped,
        });
        return null;
      }
      const previous = current;
      current = picked.candidate;
      attempted.add(current.providerId);
      physicalAttempt += 1;
      publish(previous ? 'switched' : 'selected', current, {
        fromProviderId: previous && previous.providerId || null,
        fromProviderName: previous && previous.providerName || null,
        fromTrustDomain: previous && previous.trustDomain || null,
        toTrustDomain: current.trustDomain,
        reasonCode,
        skipped: picked.skipped,
      });
      return Object.freeze({
        providerId: current.providerId,
        model: current.model,
        reasonCode,
      });
    }

    function initial() {
      const result = select('auto_initial_selection');
      if (!result) {
        throw new AutoProviderError('Auto Provider has no eligible candidate', 'AUTO_PROVIDER_POOL_EXHAUSTED');
      }
      return result;
    }

    function terminalFailure(decision, reasonCode, attempt) {
      const terminalDecision = Object.freeze({
        ...decision,
        action: 'fail_fast',
        reason: reasonCode,
        delayMs: 0,
        retryAt: null,
      });
      return Object.freeze({
        invocationOptions: null,
        decision: terminalDecision,
        terminal: true,
        reasonCode,
        fromProviderName: candidates.find(item => item.providerId === attempt?.providerId)?.providerName
          || attempt?.providerId || current?.providerName || null,
        toProviderName: null,
      });
    }

    function failover(decision, attempt) {
      const safety = failoverSafety(decision, attempt);
      if (!safety.ok) {
        publish('blocked', current, { reasonCode: safety.reason });
        return null;
      }
      let backgroundActive = false;
      if (liveBackgroundGate) {
        try { backgroundActive = liveBackgroundGate(session.id) === true; }
        catch (_) { backgroundActive = true; }
      }
      if (backgroundActive) {
        publish('blocked', current, { reasonCode: 'background_tasks_active' });
        return terminalFailure(decision, 'auto_background_tasks_active', attempt);
      }
      const result = select(safety.reason);
      if (!result) {
        return terminalFailure(decision, `auto_${selectionFailureReason || 'provider_exhausted'}`, attempt);
      }
      const fromCandidate = candidates.find(item => item.providerId === attempt.providerId) || null;
      const retryDecision = Object.freeze({
        ...decision,
        action: 'retry',
        reason: 'provider_failover',
        delayMs: 0,
        retryAt: Number(now()),
        attempt: physicalAttempt - 1,
        providerFailover: Object.freeze({
          fromProviderId: attempt.providerId,
          toProviderId: result.providerId,
          fromTrustDomain: fromCandidate && fromCandidate.trustDomain || null,
          toTrustDomain: current.trustDomain,
          category: decision.error.category,
        }),
      });
      return Object.freeze({
        invocationOptions: result,
        decision: retryDecision,
        fromProviderName: fromCandidate && fromCandidate.providerName || attempt.providerId,
        toProviderName: current.providerName,
      });
    }

    function recordSuccess(attempt) {
      const providerId = attempt && attempt.providerId || current && current.providerId;
      if (!providerId) return;
      if (selection.sticky) stickyBySession.set(session.id, providerId);
      publish('succeeded', current, { reasonCode: 'turn_succeeded' });
    }

    return Object.freeze({ enabled: true, selection, initial, failover, recordSuccess });
  }

  function snapshot(sessionId) {
    const current = currentBySession.get(sessionId);
    return current ? Object.freeze({ ...current }) : null;
  }

  function clearSession(sessionId) {
    stickyBySession.delete(sessionId);
    currentBySession.delete(sessionId);
    selectionRefBySession.delete(sessionId);
  }

  return Object.freeze({ beginTurn, clearSession, snapshot });
}

module.exports = {
  AutoProviderError,
  createAutoProviderRuntime,
};
