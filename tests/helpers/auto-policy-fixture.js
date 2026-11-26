'use strict';

function exercise(api, input) {
  if (input.method === 'limit') {
    const result = api.limitState({ status: ['ok', 'quota_exhausted', 'error'][input.mode], fetchedAt: 990000,
      summary: { kind: 'claude', status: 'ok', windows: [{ usedPercent: input.used, resetMs: 2000000 }] } },
    { now: 1000000, staleAfterMs: 60000 });
    return { result, frozen: Object.isFrozen(result) };
  }
  if (input.method === 'choose') {
    const candidates = [{ providerId: 'first', enabled: true, priority: 0, index: 0,
      limitState: ['available', 'near_limit', 'exhausted'][input.mode], limitReason: 'fixture-limit', usedPercent: input.used, price: { blended: 1 } },
    { providerId: 'second', enabled: true, priority: 1, index: 1, limitState: 'available', usedPercent: 40, price: { blended: 2 } }];
    const result = api.chooseCandidate({ candidates, byQuota: input.byQuota, byPrice: input.mode === 1 });
    return { result, candidateIndex: candidates.indexOf(result.candidate), frozen: Object.isFrozen(result), skippedFrozen: Object.isFrozen(result.skipped) };
  }
  const result = api.failoverSafety({ reason: 'fixture', error: { category: ['network', 'billing_quota', 'provider_transient'][input.mode],
    phase: 'before_first_token', partialOutput: input.used === 100, httpStatus: 503 } },
  { replayFence: 'none', sideEffectObserved: input.byQuota });
  return { result, frozen: Object.isFrozen(result) };
}
module.exports = { exercise };
