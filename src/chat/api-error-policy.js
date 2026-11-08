'use strict';

const { extractUpstreamError } = require('../upstream-error');
const { classifyProviderError } = require('../provider-error');
const { getNative } = require('../native/runtime');

// The policy lives in native/core/src/api_error_policy.rs. This module is the
// host bridge: it runs the two dependencies that are themselves host services
// (the provider classifier and the upstream extractor) and hands their results
// in, and it keeps the stateful runtime below (decision memory, logging and
// metrics) where the host owns it.

const native = () => getNative();

const FACTS = JSON.parse(native().apiErrorFacts());
const CATEGORIES = Object.freeze(FACTS.categories.slice());
const CATEGORY_SET = new Set(CATEGORIES);
const API_ERROR_SIGNATURES = Object.freeze(FACTS.apiErrorSignatures.slice());
const TRUSTED_TEXT_SOURCES = new Set(FACTS.trustedTextSources);

// Exported patterns. The source text comes once, from Rust.
const ERROR_ONLY_PREFIX_RE = new RegExp(FACTS.errorOnlyPrefixSource, 'i');
const TRAILING_ERROR_ENVELOPE_RE = new RegExp(FACTS.trailingErrorEnvelopeSource, 'i');

let signaturesQuotedCache = null;

function apiErrorSignaturesQuoted() {
  if (signaturesQuotedCache == null) {
    signaturesQuotedCache = native().apiErrorSignaturesQuoted();
  }
  return signaturesQuotedCache;
}

// Collapsed, redacted (native/core/src/redaction.rs), the fallback when
// nothing is left, capped at 240 UTF-16 units by default.
function sanitizeMessage(value, fallback, maxLength) {
  return native().apiSanitizeMessage(value, fallback, maxLength);
}

// The host's Rust proxy reports the rejection as a structured object. It
// crosses a process boundary, so it is untrusted input: only the contract's
// own keys, only known enum values, and free text capped so a malformed event
// can never inflate the attempt record or a client frame
// (native/addon/src/api_error_text.rs).
function normalizeRejection(value) {
  return native().apiNormalizeRejection(value);
}

// Everything `normalizeApiError` needs that only the host can compute: the
// classifier and extractor are host services, so they run here and their
// results travel to Rust as inputs. `apiErrorPrepare` reads the same
// `source` / `provider` / rejection chain the policy uses (and throws the same
// TypeError for a nullish receiver).
function prepareDeps(raw, context) {
  const prepared = native().apiErrorPrepare(raw, context);
  const { source, provider, rejection } = prepared;
  const trusted = TRUSTED_TEXT_SOURCES.has(source);
  const failure = trusted
    ? classifyProviderError({
      ...raw,
      ...(context.category ? { category: context.category } : {}),
      ...(context.code ? { code: context.code } : {}),
    }, { provider, source })
    : null;
  const upstream = trusted ? extractUpstreamError(raw) : {};
  return {
    source,
    provider,
    failure,
    upstream,
    rejection: normalizeRejection(rejection),
  };
}

// When the provider's text is the only evidence of an entitlement refusal, the
// policy synthesizes a rejection object. The Node implementation reused one
// module-level frozen object for it, so reproduce that: share the first one the
// policy returns instead of handing out a fresh copy per call. A structured
// rejection that merely looks the same stays an ordinary value.
let textEntitlementRejection = null;

// `normalizeRejection` freezes what it returns, but the lossless value bridge
// copies nested objects, so a policy result loses that freeze. Restore it for
// the values the policy itself built (`freeze`), and swap in the shared
// entitlement object when Rust reports the synthesized one. A caller-supplied
// rejection on the spread path is neither frozen nor replaced: the Node
// implementation handed that reference back untouched.
function shareRejection(value, flagged, freeze) {
  const holder = value.error && typeof value.error === 'object' ? value.error : value;
  const rejection = holder.rejection;
  if (!rejection || typeof rejection !== 'object') return value;
  if (flagged) {
    if (textEntitlementRejection == null) textEntitlementRejection = Object.freeze(rejection);
    holder.rejection = textEntitlementRejection;
  } else if (freeze && !Object.isFrozen(rejection)) {
    Object.freeze(rejection);
  }
  return value;
}

function normalizeApiError(raw = {}, context = {}, deps = {}) {
  const now = typeof deps.now === 'function' ? Number(deps.now()) : Date.now();
  const prepared = prepareDeps(raw, context);
  const { result, textEntitlement } = native().apiErrorNormalize(raw, context, { ...prepared, now });
  return Object.freeze(shareRejection(result, textEntitlement, true));
}

function decideApiErrorPolicy(rawError, context = {}, deps = {}) {
  const now = typeof deps.now === 'function' ? Number(deps.now()) : Date.now();
  const random = typeof deps.random === 'function' ? deps.random : Math.random;
  // `rawError && CATEGORY_SET.has(rawError.category)` short-circuits before the
  // host classifier runs, exactly as before.
  const known = !!rawError && CATEGORY_SET.has(rawError.category);
  const prepared = known
    ? { source: '', provider: '', failure: null, upstream: {}, rejection: null }
    : prepareDeps(rawError, context);
  const { result, textEntitlement } = native().apiErrorDecide(
    rawError, context, { ...prepared, now, known }, random,
  );
  // An already-normalized error keeps carrying the shared rejection; the value
  // bridge copies it, so restore the identity the spread used to preserve.
  const carried = !!rawError && textEntitlementRejection != null
    && rawError.rejection === textEntitlementRejection;
  // The spread path hands back the caller's own rejection. If that object was
  // frozen, the copy must be too — otherwise it stays a plain value, exactly as
  // the caller handed it in.
  const inputRejection = rawError && typeof rawError === 'object' ? rawError.rejection : undefined;
  const preserveFrozen = !!inputRejection && typeof inputRejection === 'object'
    && Object.isFrozen(inputRejection);
  const shared = shareRejection(result, textEntitlement || carried, !known || preserveFrozen);
  // The Node implementation froze the error object too (the spread in
  // `withMaxAttempts` produced a fresh frozen copy); the value bridge copies
  // it, so restore that.
  if (shared.error && typeof shared.error === 'object' && !Object.isFrozen(shared.error)) {
    Object.freeze(shared.error);
  }
  return Object.freeze(shared);
}

function parseRetryAfter(value, now = Date.now()) {
  return native().apiErrorParseRetryAfter(value, now);
}

function resetAfterFromText(value, now = Date.now()) {
  return native().apiErrorResetAfterFromText(value, now);
}

function retryNotice(decision) {
  return native().apiErrorRetryNotice(decision);
}

function isErrorOnlyText(value) {
  return native().apiErrorIsErrorOnlyText(value);
}

function splitTrailingErrorEnvelope(value) {
  const split = native().apiErrorSplitTrailingEnvelope(value);
  return split ? Object.freeze(split) : null;
}

function detectErrorEnvelope(provider, text) {
  const envelope = native().apiErrorDetectEnvelope(provider, text);
  return envelope ? Object.freeze(envelope) : null;
}

function claudeErrorEnvelope(provider, text) {
  const envelope = native().apiErrorClaudeEnvelope(provider, text);
  return envelope ? Object.freeze(envelope) : null;
}

function envelopeSourceFor(provider) {
  return native().apiErrorEnvelopeSourceFor(provider);
}

function isKnownHarmlessStderrLine(line) {
  return native().apiErrorIsKnownHarmlessStderrLine(line);
}

// ---------------------------------------------------------------------------
// Host runtime: decision memory, logging and metrics stay host state.
// ---------------------------------------------------------------------------

function metricToken(value) {
  return native().apiErrorMetricToken(value);
}

function createApiErrorPolicyRuntime(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const random = typeof options.random === 'function' ? options.random : Math.random;
  const logger = options.logger || { info() {}, warn() {}, error() {} };
  const metrics = options.metrics || { inc() {}, set() {} };
  const decisions = new Map();

  function remember(key, value) {
    if (!key) return;
    decisions.set(key, value);
    if (decisions.size > 1_000) decisions.delete(decisions.keys().next().value);
  }

  function logDecision(decision, context, duplicate = false) {
    if (duplicate) return;
    const error = decision.error;
    const fields = {
      category: error.category,
      provider: error.provider,
      providerId: error.providerId,
      providerName: error.providerName,
      providerRouteScope: error.providerRouteScope,
      runtimeEpoch: error.runtimeEpoch,
      decisionId: error.decisionId,
      routeAttemptId: error.routeAttemptId,
      routeGeneration: error.routeGeneration,
      attemptNo: error.attemptNo,
      providerRevision: error.providerRevision,
      code: error.code,
      httpStatus: error.httpStatus,
      phase: error.phase,
      partialOutput: error.partialOutput,
      sideEffects: error.sideEffects,
      safeToRetry: error.safeToRetry,
      retryable: error.retryable,
      action: decision.action,
      reason: decision.reason,
      delayMs: decision.delayMs || 0,
      attempt: decision.attempt || 0,
      maxAttempts: error.maxAttempts,
      rootCause: error.rootCause,
      turnElapsedMs: Math.max(0, Number(context.turnElapsedMs || 0) || 0),
      budgetExhaustedBy: decision.budgetExhaustedBy || null,
      sessionId: context.sessionId || null,
      turnId: context.turnId || null,
      requestId: error.requestId,
    };
    const method = decision.action === 'retry' ? 'warn' : 'info';
    logger[method]('api_error_policy_decision', fields);
    metrics.inc(`multicc_api_error_${metricToken(error.category)}_total`);
    metrics.inc(`multicc_api_error_provider_${metricToken(error.provider)}_total`);
    metrics.inc(`multicc_api_error_decision_${metricToken(decision.action)}_total`);
    if (decision.action === 'retry') metrics.inc('multicc_api_error_retry_attempted_total');
    if (decision.action === 'fail_fast') metrics.inc('multicc_api_error_fail_fast_total');
    if (decision.reason === 'retry_budget_exhausted') metrics.inc('multicc_api_error_retry_exhausted_total');
  }

  function evaluate(raw, context = {}) {
    const key = context.idempotencyKey ? String(context.idempotencyKey) : '';
    if (key && decisions.has(key)) {
      return Object.freeze({ ...decisions.get(key), duplicate: true });
    }
    const at = Number(now());
    const normalized = normalizeApiError(raw, context, { now: () => at });
    const decision = decideApiErrorPolicy(normalized, context, { now: () => at, random });
    remember(key, decision);
    logDecision(decision, context);
    return decision;
  }

  function recordSuccess(_provider, context = {}) {
    if (context.retryAttempt) metrics.inc('multicc_api_error_retry_succeeded_total');
  }

  function snapshot() {
    return {
      // Kept as an empty compatibility field for diagnostics consumers from
      // older releases. API failures no longer create cross-request gates.
      circuits: [],
      idempotencyEntries: decisions.size,
    };
  }

  return Object.freeze({ evaluate, recordSuccess, snapshot });
}

module.exports = {
  CATEGORIES,
  normalizeApiError,
  decideApiErrorPolicy,
  createApiErrorPolicyRuntime,
  parseRetryAfter,
  resetAfterFromText,
  retryNotice,
  sanitizeMessage,
  isErrorOnlyText,
  ERROR_ONLY_PREFIX_RE,
  TRAILING_ERROR_ENVELOPE_RE,
  splitTrailingErrorEnvelope,
  detectErrorEnvelope,
  claudeErrorEnvelope,
  envelopeSourceFor,
  normalizeRejection,
  isKnownHarmlessStderrLine,
  API_ERROR_SIGNATURES,
  apiErrorSignaturesQuoted,
};
