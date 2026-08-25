'use strict';

const FAILOVER_CATEGORIES = new Set([
  'billing_quota',
  'rate_limit',
  'provider_transient',
  'network',
  'timeout',
  'authentication_permission',
]);
const SAFE_PHASES = new Set(['connect', 'request', 'before_first_token']);

function limitState(entry, { now = Date.now(), staleAfterMs = 5 * 60_000 } = {}) {
  if (!entry || typeof entry !== 'object') return Object.freeze({ state: 'unknown', reason: 'limit_unknown' });
  const fetchedAt = Number(entry.fetchedAt);
  if (!Number.isFinite(fetchedAt) || now - fetchedAt > staleAfterMs) {
    return Object.freeze({ state: 'stale', reason: 'limit_stale' });
  }
  const status = String(entry.status || '').toLowerCase();
  if (['exhausted', 'quota_exhausted', 'blocked'].includes(status)) {
    return Object.freeze({ state: 'exhausted', reason: 'fresh_limit_exhausted' });
  }
  if (entry.status && status !== 'ok') return Object.freeze({ state: 'unknown', reason: 'limit_error' });
  const summary = entry.summary && typeof entry.summary === 'object' ? entry.summary : {};
  const text = String(entry.summaryText || '').toLowerCase();
  const numericBalance = typeof summary.available === 'number' ? summary.available
    : typeof summary.total === 'number' ? summary.total : null;
  const exhausted = summary.available === false
    || (numericBalance != null && numericBalance <= 0)
    || String(summary.status || '').toLowerCase() === 'rejected'
    || Number(summary.usedPercentage) >= 100
    || /(?:余额不足|insufficient (?:balance|quota)|quota exhausted|exhausted)/i.test(text);
  return exhausted
    ? Object.freeze({ state: 'exhausted', reason: 'fresh_limit_exhausted' })
    : Object.freeze({ state: 'available', reason: 'fresh_limit_available' });
}

function chooseCandidate({ candidates, attempted = new Set(), stickyProviderId = null } = {}) {
  const eligible = (Array.isArray(candidates) ? candidates : [])
    .filter(candidate => candidate && candidate.enabled !== false && !attempted.has(candidate.providerId));
  const skipped = eligible
    .filter(candidate => candidate.limitState === 'exhausted')
    .map(candidate => ({ providerId: candidate.providerId, reason: 'fresh_limit_exhausted' }));
  const usable = eligible.filter(candidate => candidate.limitState !== 'exhausted');
  usable.sort((left, right) => {
    if (left.providerId === stickyProviderId && right.providerId !== stickyProviderId) return -1;
    if (right.providerId === stickyProviderId && left.providerId !== stickyProviderId) return 1;
    return left.priority - right.priority || left.index - right.index;
  });
  return Object.freeze({ candidate: usable[0] || null, skipped: Object.freeze(skipped) });
}

function failoverSafety(decision, attempt) {
  const error = decision && decision.error;
  if (!error) return Object.freeze({ ok: false, reason: 'missing_error_decision' });
  if (!FAILOVER_CATEGORIES.has(error.category)) {
    return Object.freeze({ ok: false, reason: 'category_not_failoverable' });
  }
  if (!SAFE_PHASES.has(String(error.phase || ''))) {
    return Object.freeze({ ok: false, reason: 'unsafe_failure_phase' });
  }
  if (error.partialOutput || error.sideEffects) {
    return Object.freeze({ ok: false, reason: 'unsafe_replay_boundary' });
  }
  if (!attempt || attempt.replayFence !== 'none' || attempt.visibleOutputObserved
      || attempt.toolIntentObserved || attempt.sideEffectObserved) {
    return Object.freeze({ ok: false, reason: 'provider_replay_fence_closed' });
  }
  return Object.freeze({ ok: true, reason: `failover_${error.category}` });
}

module.exports = {
  FAILOVER_CATEGORIES,
  SAFE_PHASES,
  chooseCandidate,
  failoverSafety,
  limitState,
};
