'use strict';

// Usage observation normalizer. The rules live in
// native/core/src/usage_observed.rs; this module keeps the exact export
// surface. Two non-pure edges remain here:
//   * `assertProviderBinding` (Symbol brand) runs before the kernel, and only
//     a plain field projection crosses into Rust;
//   * `normalizeProxyOutcome` runs here too. The kernel asks for it lazily
//     (after every earlier validation passed) so a bad proxy outcome still
//     throws its original TypeError before later UsageObservedError checks.
// Structured errors come back in an envelope and are rethrown as
// `UsageObservedError` with the same name/code/message.

const { assertProviderBinding } = require('./providers/binding');
const { normalizeProxyOutcome } = require('./providers/proxy-outcome');
const { getNative } = require('./native/runtime');

const native = getNative();
const CATALOG = JSON.parse(native.usageObservedCatalog());

const USAGE_OBSERVED_VERSION = CATALOG.version;

class UsageObservedError extends Error {
  constructor(message, code = 'INVALID_USAGE_OBSERVED') {
    super(message);
    this.name = 'UsageObservedError';
    this.code = code;
  }
}

function request(op, input) {
  // Direct value transport keeps nested NaN/Infinity, explicit `undefined`
  // properties and -0 that JSON.stringify/JSON.parse would rewrite.
  return native.usageObservedRequestValue(op, input);
}

// `Date.parse` stays in JS: it accepts engine-defined natural-language dates.
// `normalizeOccurredAt` throws "required" for a nullish/empty value and
// "must be a timestamp" for anything Date.parse cannot read.
function occurredAtMs(input) {
  const value = input.occurredAt != null ? input.occurredAt : input.timestamp;
  if (value == null || value === '') return undefined;
  return typeof value === 'number' ? value : Date.parse(value);
}

function createUsageObserved(input, binding = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new UsageObservedError('UsageObserved input must be an object');
  }
  const bound = binding == null ? null : assertProviderBinding(binding);
  const projected = bound && {
    sessionId: bound.sessionId ?? null,
    providerId: bound.providerId ?? null,
    roleKind: bound.roleKind ?? null,
    agentRole: bound.agentRole ?? null,
    routeName: bound.routeName ?? null,
  };
  const timestamp = occurredAtMs(input);
  let normalized;
  for (;;) {
    const payload = { value: input, binding: projected, occurredAtMs: timestamp };
    if (normalized !== undefined) {
      payload.proxyOutcome = normalized;
      payload.proxyOutcomeNormalized = true;
    }
    const result = request('create', payload);
    if (result.retry === 'proxyOutcome') {
      normalized = normalizeProxyOutcome(input.proxyOutcome);
      continue;
    }
    if (!result.ok) throw new UsageObservedError(result.message, result.code);
    const event = result.value;
    if (event.tokens) Object.freeze(event.tokens);
    if (event.proxyOutcome) Object.freeze(event.proxyOutcome);
    return Object.freeze(event);
  }
}

function stableUsageEventId(identity) {
  return request('stableEventId', { identity });
}

function validateUsageObserved(value) {
  return createUsageObserved(value);
}

module.exports = {
  USAGE_OBSERVED_VERSION,
  UsageObservedError,
  createUsageObserved,
  stableUsageEventId,
  validateUsageObserved,
};
