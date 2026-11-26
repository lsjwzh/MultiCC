'use strict';

const { extractUpstreamError } = require('../upstream-error');
const { errorFields } = require('../provider-error');
const { getNative } = require('../native/binding');

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

// The two projections share one synthesized entitlement object; V8 owns the
// user clock and metadata extractors, Rust owns normalization and the decision.
const policyPorts = { categories: CATEGORY_SET, trusted: TRUSTED_TEXT_SOURCES,
  shared: null, errorFields, extract: extractUpstreamError };

function normalizeApiError(raw = {}, context = {}, deps = {}) {
  return native().apiPolicyNormalized(policyPorts, raw, context, deps);
}

function decideApiErrorPolicy(rawError, context = {}, deps = {}) {
  return native().apiPolicyDecision(policyPorts, rawError, context, deps);
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
  policyPorts,
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
