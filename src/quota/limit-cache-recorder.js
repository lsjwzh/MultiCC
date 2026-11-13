'use strict';

// Rust owns observation policy. This adapter retains injected stores, clocks,
// callback ordering and the identity of cache results until those hosts migrate.
const { getNative } = require('../native/runtime');
const request = (op, input) => getNative().limitCacheRecorderRequestValue(op, input);
const { PROVIDER_FAILURE_COOLDOWN_MS, AUTH_REVOKED_BLOCKED_UNTIL_MS } = request('constants', {});
const isRevokedCategory = category => request('isRevokedCategory', { category });
const summaryOf = entry => entry && { summary: entry.summary };

function createLimitRecorder({ cache, persistedSessions, providers, now = Date.now } = {}) {
  if (!cache || !persistedSessions || !providers) {
    throw new TypeError('[limit-cache-recorder] requires { cache, persistedSessions, providers }');
  }
  function appTypeForSession(sessionName) {
    const key = request('identityKey', { value: sessionName });
    if (key === null) return null;
    const rec = persistedSessions.get(key);
    const cli = request('sessionCli', { provider: rec?.provider, cli: rec?.cli });
    if (cli === null) return null;
    return request('sessionIdentity', { appType: providers.appTypeForCli(cli), provider: rec.provider });
  }
  function explicitProviderIdentity(providerId) {
    const key = request('identityKey', { value: providerId });
    if (key === null || typeof providers.getProvider !== 'function') return null;
    let provider;
    try { provider = providers.getProvider(undefined, key); } catch (_) { return null; }
    // Credentials/settings are not part of an identity query.
    return request('providerIdentity', { id: provider?.id, appType: provider?.appType,
      activeAccountId: provider?.activeAccountId });
  }
  function previousOptional(appType, providerId) {
    try { return cache.get(appType, providerId); } catch (_) { return null; }
  }
  function recordDto(appType, providerId, dto) {
    if (!request('validDto', { dto })) return null;
    const at = now();
    const stage = request('dtoPrepare', { dto, now: at });
    if (!stage) return null;
    if (typeof cache.recordDerived === 'function') {
      return cache.recordDerived(appType, providerId, 'dtoFinish', { dto, now: at, stage }, now());
    }
    let previous = null;
    if (stage.previous === 'strict') previous = cache.get(appType, providerId);
    else if (stage.previous === 'optional') previous = previousOptional(appType, providerId);
    const value = request('dtoFinish', { dto, now: at, stage, previous: summaryOf(previous) });
    return value ? cache.record(appType, providerId, value) : null;
  }
  function recordSession(sessionName, dto, providerId) {
    const id = providerId ? explicitProviderIdentity(providerId) : appTypeForSession(sessionName);
    return id ? recordDto(id.appType, id.providerId, dto) : null;
  }
  function recordProvider(appType, providerId, result) {
    const plan = request('providerPlan', { providerId, result });
    if (!plan) return null;
    if (plan.action === 'failure') {
      const recorded = cache.recordFailure(appType, providerId, plan.value);
      return typeof cache.recordDerived === 'function' ? Promise.resolve(recorded).then(() => null) : null;
    }
    if (plan.action === 'dto') return recordDto(appType, providerId, result.dto);
    return cache.record(appType, providerId, request('providerRecord', {
      result, now: plan.needsNow ? now() : undefined,
    }));
  }
  let refreshProvider = null;
  function setRefresher(fn) { refreshProvider = typeof fn === 'function' ? fn : null; }
  function recordProviderFailure({ sessionId, providerId, category, httpStatus, blockedUntilMs, rejection } = {}) {
    const identity = providerId ? explicitProviderIdentity(providerId) : appTypeForSession(sessionId);
    if (!identity) return null;
    if (typeof cache.transitionAvailability === 'function') {
      const target = providers.getProviderLimitTarget?.(identity.appType, identity.providerId);
      const raw = rejection && typeof rejection === 'object' && !Array.isArray(rejection)
        ? { kind: rejection.kind, scope: rejection.scope, window: rejection.window,
          resetMs: rejection.resetMs, code: rejection.code, model: rejection.model, source: rejection.source } : null;
      return cache.transitionAvailability(identity.appType, identity.providerId, {
        category, httpStatus, blockedUntilMs, rejection: raw, hasRejection: !!rejection, targetKind: target?.strategy,
      }, now()).then(plan => {
        if (refreshProvider && plan.refresh) {
          try { Promise.resolve(refreshProvider(identity.appType, identity.providerId)).catch(() => {}); } catch (_) {}
        }
        return plan.entry;
      });
    }
    const previous = cache.get(identity.appType, identity.providerId);
    const target = providers.getProviderLimitTarget?.(identity.appType, identity.providerId);
    const policy = request('failurePolicy', { httpStatus, targetKind: target?.strategy,
      previous: summaryOf(previous), now: now() });
    // Only the normalized upstream rejection contract crosses this boundary;
    // unrelated response payloads may contain credentials or cyclic objects.
    const revoked = isRevokedCategory(category);
    const raw = !revoked && rejection && typeof rejection === 'object' && !Array.isArray(rejection)
      ? { kind: rejection.kind, scope: rejection.scope, window: rejection.window,
        resetMs: rejection.resetMs, code: rejection.code, model: rejection.model, source: rejection.source } : null;
    const park = revoked ? null : request('rejectionPark', { rejection: raw, now: Number(now()) });
    const action = request('failureCheck', { category, previous: summaryOf(previous), policy, park,
      rejection: !!rejection, blockedUntilMs });
    if (action === 'preserve') return previous;
    if (action === 'checkLong' && request('longPark', { previous: summaryOf(previous), now: now() })) return previous;
    const observedAtMs = Number(now());
    const plan = request('cooldown', { category, httpStatus, blockedUntilMs, park, now: observedAtMs });
    let recorded;
    if (plan.needsPrevious) {
      const current = cache.get(identity.appType, identity.providerId);
      recorded = request('keepsAccountPark', { previous: summaryOf(current), now: observedAtMs, modelUntil: plan.until })
        ? current : cache.record(identity.appType, identity.providerId, plan.value);
    } else recorded = cache.record(identity.appType, identity.providerId, plan.value);
    if (refreshProvider && policy?.refresh !== false) {
      try { Promise.resolve(refreshProvider(identity.appType, identity.providerId)).catch(() => {}); } catch (_) {}
    }
    return recorded;
  }
  function releaseProviderFailure({ providerId } = {}) {
    const identity = explicitProviderIdentity(providerId);
    if (!identity) return null;
    if (typeof cache.transitionAvailability === 'function') {
      return cache.transitionAvailability(identity.appType, identity.providerId, { release: true }, now())
        .then(plan => plan.write ? plan.entry : null);
    }
    let entry;
    try { entry = cache.get(identity.appType, identity.providerId); } catch (_) { return null; }
    if (!request('releaseEligible', { entry: summaryOf(entry) })) return null;
    return cache.record(identity.appType, identity.providerId, request('releaseRecord', { now: now() }));
  }
  function resolveByHost(host) {
    const query = request('resolveQuery', { kind: 'host', value: host });
    if (query === null) return [];
    const ids = [];
    for (const appType of ['claude', 'codex']) for (const p of providers.listProviders(appType)) {
      const target = providers.getProviderLimitTarget(appType, p.id);
      if (request('hostMatches', { query, host: target?.host })) ids.push({ appType, providerId: p.id });
    }
    return ids;
  }
  function resolveByBaseUrl(baseUrl) {
    const query = request('resolveQuery', { kind: 'baseUrl', value: baseUrl });
    if (query === null) return [];
    const ids = [];
    for (const appType of ['claude', 'codex']) for (const p of providers.listProviders(appType)) {
      if (request('baseMatches', { query, baseUrl: p.baseUrl })) ids.push({ appType, providerId: p.id });
    }
    return ids;
  }
  function recordVendor({ kind, result, session = '', baseUrl = '', host = '', opts }) {
    if (!result) return 0;
    const matches = [];
    if (session) { const id = appTypeForSession(session); if (id) matches.push(id); }
    if (host) matches.push(...resolveByHost(host));
    if (baseUrl) matches.push(...resolveByBaseUrl(baseUrl));
    const ids = request('mergeIdentities', { ids: matches });
    if (!ids.length) return 0;
    const plan = request('vendorPlan', { result });
    if (plan.action === 'failure') {
      if (ids.length === 1 && session) {
        const recorded = cache.recordFailure(ids[0].appType, ids[0].providerId, plan.value);
        if (typeof cache.recordDerived === 'function') return Promise.resolve(recorded).then(() => 0);
      }
      return 0;
    }
    let bar = null;
    try { bar = request('vendorRender', { kind, result, baseUrl, opts, now: now() }); } catch (_) {}
    const reported = request('vendorWindows', { kind, result, baseUrl });
    if (typeof cache.recordDerived === 'function') {
      return Promise.all(ids.map(id => {
        const mergeNow = reported.length ? now() : undefined;
        const at = now();
        return cache.recordDerived(id.appType, id.providerId, 'vendorRecord', {
          kind, result, bar, reported, mergeNow, now: result.fetchedAt ? undefined : at,
        }, at);
      })).then(() => ids.length);
    }
    let count = 0;
    for (const id of ids) {
      const previous = previousOptional(id.appType, id.providerId);
      const mergeNow = reported.length ? now() : undefined;
      cache.record(id.appType, id.providerId, request('vendorRecord', { kind, result, bar, reported,
        previous: summaryOf(previous), mergeNow, now: result.fetchedAt ? undefined : now() }));
      count += 1;
    }
    return count;
  }
  function recordClaude(session, result, barText) {
    const id = appTypeForSession(session);
    if (!id) return null;
    const plan = request('claudePlan', { result });
    if (plan.action === 'failure') {
      const recorded = cache.recordFailure(id.appType, id.providerId, plan.value);
      return typeof cache.recordDerived === 'function' ? Promise.resolve(recorded).then(() => null) : null;
    }
    return cache.record(id.appType, id.providerId, request('claudeRecord', { result, barText,
      summaryNow: plan.needsNow ? now() : undefined, now: plan.needsNow ? now() : undefined }));
  }
  function recordOfficialWindows(appType, providerId, { windows, fetchedAt } = {}) {
    if (!request('officialValid', { providerId, windows })) return null;
    const at = fetchedAt || now();
    if (typeof cache.recordDerived === 'function') {
      return cache.recordDerived(appType, providerId, 'officialRecord', { appType, windows, at }, now());
    }
    const previous = previousOptional(appType, providerId);
    return cache.record(appType, providerId, request('officialRecord', {
      appType, windows, at, previous: summaryOf(previous),
    }));
  }
  function liveKeys() {
    const set = new Set();
    for (const appType of ['claude', 'codex']) for (const p of providers.listProviders(appType)) set.add(cache.key(appType, p.id));
    return set;
  }
  return Object.freeze({ appTypeForSession, recordSession, recordDto, recordProvider, recordProviderFailure,
    releaseProviderFailure, setRefresher, recordVendor, recordClaude, recordOfficialWindows,
    resolveByHost, resolveByBaseUrl, liveKeys });
}
module.exports = { createLimitRecorder, PROVIDER_FAILURE_COOLDOWN_MS, AUTH_REVOKED_BLOCKED_UNTIL_MS, isRevokedCategory };
