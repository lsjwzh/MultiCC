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
  const summary = entry.summary && typeof entry.summary === 'object' ? entry.summary : {};
  if (summary.kind === 'availability') {
    const blockedUntilMs = Number(summary.blockedUntilMs);
    if (String(summary.status || '').toLowerCase() === 'rejected'
        && Number.isFinite(blockedUntilMs) && blockedUntilMs > now) {
      return Object.freeze({ state: 'exhausted', reason: 'provider_cooldown_active' });
    }
    return Object.freeze({ state: 'stale', reason: 'provider_cooldown_expired' });
  }
  const fetchedAt = Number(entry.fetchedAt);
  if (!Number.isFinite(fetchedAt) || now - fetchedAt > staleAfterMs) {
    return Object.freeze({ state: 'stale', reason: 'limit_stale' });
  }
  const status = String(entry.status || '').toLowerCase();
  if (['exhausted', 'quota_exhausted', 'blocked'].includes(status)) {
    return Object.freeze({ state: 'exhausted', reason: 'fresh_limit_exhausted' });
  }
  if (entry.status && status !== 'ok') return Object.freeze({ state: 'unknown', reason: 'limit_error' });
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

// `preferredTier` is the difficulty verdict for THIS turn (see jev-client).
// It outranks stickiness: a follow-up that got harder must not stay pinned to
// the weak model that answered the previous turn. It is a preference, never a
// filter — when every candidate of that tier has already been attempted, the
// remaining pool is still eligible, so a dead weak route can fail over upward
// instead of wedging the turn. A null tier preserves the legacy ordering.
//
// The remaining keys only exist for cross-CLI and price-tiered pools and are
// inert when absent, so a legacy pool orders exactly as before:
//   ladder    — the tier keys weakest first; with it, a miss on the preferred
//               tier climbs before it descends (the nearer stronger tier first).
//   pinned    — a reserved line ({providerId, model}) from a handoff or a
//               planned lane switch; it outranks stickiness.
//   preferCli — the session's current lane; a tie stays on it, since leaving
//               it costs a handoff.
//   byPrice   — price-tiered pools prefer the cheaper line inside a tier.
function tierRank(candidate, preferredTier, ladder) {
  if (!preferredTier) return 0;
  if (candidate.tier === preferredTier) return 0;
  if (!Array.isArray(ladder) || !ladder.length) return 1;
  const want = ladder.indexOf(preferredTier);
  const have = ladder.indexOf(candidate.tier);
  if (want < 0 || have < 0) return ladder.length * 2;
  return have > want ? have - want : ladder.length + (want - have);
}

function chooseCandidate({
  candidates, attempted = new Set(), stickyProviderId = null, preferredTier = null,
  ladder = null, pinned = null, preferCli = null, byPrice = false,
} = {}) {
  const eligible = (Array.isArray(candidates) ? candidates : [])
    .filter(candidate => candidate && candidate.enabled !== false && !attempted.has(candidate.providerId));
  const skipped = eligible
    .filter(candidate => candidate.limitState === 'exhausted')
    .map(candidate => ({
      providerId: candidate.providerId,
      reason: candidate.limitReason || 'fresh_limit_exhausted',
    }));
  const usable = eligible.filter(candidate => candidate.limitState !== 'exhausted');
  const isPinned = candidate => !!pinned && candidate.providerId === pinned.providerId
    && (!pinned.cli || candidate.cli === pinned.cli)
    && (pinned.model == null || candidate.model === pinned.model);
  const priceOf = candidate => (candidate.price ? candidate.price.blended : Infinity);
  usable.sort((left, right) => {
    const tierOrder = tierRank(left, preferredTier, ladder) - tierRank(right, preferredTier, ladder);
    if (tierOrder !== 0) return tierOrder;
    if (pinned) {
      const pinOrder = (isPinned(left) ? 0 : 1) - (isPinned(right) ? 0 : 1);
      if (pinOrder !== 0) return pinOrder;
    }
    if (left.providerId === stickyProviderId && right.providerId !== stickyProviderId) return -1;
    if (right.providerId === stickyProviderId && left.providerId !== stickyProviderId) return 1;
    if (preferCli) {
      const laneOrder = (left.cli === preferCli ? 0 : 1) - (right.cli === preferCli ? 0 : 1);
      if (laneOrder !== 0) return laneOrder;
    }
    if (byPrice) {
      const leftPrice = priceOf(left), rightPrice = priceOf(right);
      if (leftPrice !== rightPrice) return leftPrice < rightPrice ? -1 : 1;
    }
    return left.priority - right.priority || left.index - right.index;
  });
  return Object.freeze({ candidate: usable[0] || null, skipped: Object.freeze(skipped) });
}

function failoverSafety(decision, attempt) {
  const error = decision && decision.error;
  if (!error) return Object.freeze({ ok: false, reason: 'missing_error_decision' });
  const httpStatus = Number(error.httpStatus);
  const upstream4xx = Number.isInteger(httpStatus) && httpStatus >= 400 && httpStatus <= 499;
  // A locally-owned cancellation must never be replayed, even if an adapter
  // happens to attach a synthetic 4xx status to it.
  if (error.category === 'cancel_shutdown') {
    return Object.freeze({ ok: false, reason: 'category_not_failoverable' });
  }
  if (!FAILOVER_CATEGORIES.has(error.category) && !upstream4xx) {
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
  return Object.freeze({
    ok: true,
    reason: FAILOVER_CATEGORIES.has(error.category)
      ? `failover_${error.category}` : 'failover_http_4xx',
  });
}

module.exports = {
  FAILOVER_CATEGORIES,
  SAFE_PHASES,
  chooseCandidate,
  failoverSafety,
  limitState,
};
