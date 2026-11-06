'use strict';

// Auto Provider route policy — how a cached limit reading reads now
// (limitState), which line of the pool to try next (chooseCandidate), and
// whether a failed attempt may move to another line (failoverSafety) — lives
// in native/core/src/auto_provider_policy.rs, with the rules' rationale.
//
// This bridge carries in only the fields those rules read, each exactly as
// JavaScript held it, and maps the native answer back onto the caller's own
// objects: chooseCandidate returns one of the candidates it was given, by
// identity. A field is read only where the rule reads it (a summary's fields
// only when it is an object, a price's `blended` only when there is a price),
// so a projection never touches what the rule never did.
const { getNative } = require('../native/runtime');

const native = getNative();
const FACTS = JSON.parse(native.autoProviderPolicyFacts());

const NON_FAILOVER_CATEGORIES = new Set(FACTS.nonFailoverCategories);
const SAFE_PHASES = new Set(FACTS.safePhases);
const NEAR_LIMIT_PERCENT = FACTS.nearLimitPercent;

const ENTRY_FIELDS = ['fetchedAt', 'status', 'summaryText'];
const SUMMARY_FIELDS = ['kind', 'revoked', 'blockedUntilMs', 'status', 'scope', 'model',
  'usedPercentage', 'resetsAtMs', 'available', 'total'];
const WINDOW_FIELDS = ['usedPercent', 'resetMs'];
const CANDIDATE_FIELDS = ['enabled', 'providerId', 'limitState', 'limitReason', 'tier', 'cli',
  'model', 'priority', 'index', 'usedPercent', 'trustDomain'];
const PIN_FIELDS = ['providerId', 'cli', 'model'];
const ERROR_FIELDS = ['retryBudgetExhausted', 'httpStatus', 'category', 'phase', 'partialOutput',
  'sideEffects'];
const ATTEMPT_FIELDS = ['replayFence', 'visibleOutputObserved', 'toolIntentObserved',
  'sideEffectObserved'];
// An array hole: no identity, so it equals nothing (indexOf skips holes).
const HOLE = Object.freeze({ $hole: 1 });

// One request's encoder. Strings, finite numbers, booleans and null cross as
// themselves; what JSON cannot spell is tagged — undefined, NaN/±Infinity, and
// any other value, with its identity in this request (so `===` between two
// fields still holds) and the String()/Number() a rule may coerce it with.
function encoder() {
  const ids = new Map();
  const number = value => (Number.isFinite(value) ? value : { $num: String(value) });
  function wire(value) {
    if (value === undefined) return { $u: 1 };
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') return number(value);
    if (!ids.has(value)) ids.set(value, ids.size);
    let text = '';
    let num = NaN;
    try { text = String(value); } catch (_) { /* a Symbol-like value has no text */ }
    try { num = Number(value); } catch (_) { /* nor a number */ }
    return { $js: ids.get(value), text, num: number(num) };
  }
  // The named fields of a value; an undefined field is simply absent.
  function fields(value, keys) {
    const out = {};
    for (const key of keys) {
      const field = value[key];
      if (field !== undefined) out[key] = wire(field);
    }
    return out;
  }
  return { wire, fields };
}

const isObject = value => !!value && typeof value === 'object';

function limitState(entry, { now = Date.now(), staleAfterMs, model } = {}) {
  const { wire, fields } = encoder();
  let projected = null;
  if (isObject(entry)) {
    projected = fields(entry, ENTRY_FIELDS);
    const summary = entry.summary;
    if (isObject(summary)) {
      projected.summary = fields(summary, SUMMARY_FIELDS);
      if (Array.isArray(summary.windows)) {
        projected.summary.windows = Array.from(summary.windows,
          window => (window ? fields(window, WINDOW_FIELDS) : null));
      }
    }
  }
  const request = { entry: projected, now: wire(now) };
  if (staleAfterMs !== undefined) request.staleAfterMs = wire(staleAfterMs);
  if (model !== undefined) request.model = wire(model);
  return Object.freeze(JSON.parse(native.autoProviderLimitState(JSON.stringify(request))));
}

function chooseCandidate({
  candidates, attempted = new Set(), stickyProviderId = null, preferredTier = null,
  ladder = null, pinned = null, preferCli = null, byPrice = false, byQuota = false,
} = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const { wire, fields } = encoder();
  const request = {
    candidates: Array.from(list, candidate => {
      if (!candidate) return null;
      const projected = fields(candidate, CANDIDATE_FIELDS);
      if (candidate.price) {
        projected.priced = true;
        if (candidate.price.blended !== undefined) projected.blended = wire(candidate.price.blended);
      }
      return projected;
    }),
    attempted: Array.from(attempted, id => wire(id)),
    stickyProviderId: wire(stickyProviderId),
    preferredTier: wire(preferredTier),
    ladder: Array.isArray(ladder)
      ? Array.from({ length: ladder.length }, (_, at) => (at in ladder ? wire(ladder[at]) : HOLE))
      : null,
    pinned: pinned ? fields(pinned, PIN_FIELDS) : null,
    preferCli: wire(preferCli),
    byPrice: wire(byPrice),
    byQuota: wire(byQuota),
  };
  const answer = JSON.parse(native.autoProviderChooseCandidate(JSON.stringify(request)));
  return Object.freeze({
    candidate: answer.candidate == null ? null : list[answer.candidate],
    // A null reason is the candidate's own limitReason.
    skipped: Object.freeze(answer.skipped.map(({ index, reason }) => ({
      providerId: list[index].providerId,
      reason: reason ?? list[index].limitReason,
    }))),
  });
}

function failoverSafety(decision, attempt) {
  const { fields } = encoder();
  const request = { decision: null, attempt: attempt ? fields(attempt, ATTEMPT_FIELDS) : null };
  if (decision) {
    request.decision = fields(decision, ['reason']);
    if (decision.error) request.decision.error = fields(decision.error, ERROR_FIELDS);
  }
  return Object.freeze(JSON.parse(native.autoProviderFailoverSafety(JSON.stringify(request))));
}

module.exports = {
  NON_FAILOVER_CATEGORIES,
  NEAR_LIMIT_PERCENT,
  SAFE_PHASES,
  chooseCandidate,
  failoverSafety,
  limitState,
};
