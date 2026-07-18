'use strict';

const crypto = require('crypto');
const { assertProviderBinding } = require('./provider-binding');

const USAGE_OBSERVED_VERSION = 1;
const ROLE_KINDS = new Set(['main', 'sub', 'aux']);
const AGENT_ROLES = new Set(['default', 'worker', 'explorer', 'custom']);
const SOURCES = new Set(['exact', 'reconciled']);
const COVERAGE = new Set(['observed', 'unobservable']);
const STATUSES = new Set(['success', 'error', 'unobservable']);

class UsageObservedError extends Error {
  constructor(message, code = 'INVALID_USAGE_OBSERVED') {
    super(message);
    this.name = 'UsageObservedError';
    this.code = code;
  }
}

function requiredString(value, label, max = 256) {
  const text = String(value == null ? '' : value).trim();
  if (!text) throw new UsageObservedError(`${label} is required`);
  if (text.length > max || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new UsageObservedError(`${label} is invalid`);
  }
  return text;
}

function optionalString(value, max = 256) {
  if (value == null || value === '') return '';
  const text = String(value).trim();
  if (text.length > max || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new UsageObservedError('usage string field is invalid');
  }
  return text;
}

function nonNegative(value, label) {
  const number = Number(value == null ? 0 : value);
  if (!Number.isFinite(number) || number < 0) {
    throw new UsageObservedError(`${label} must be a non-negative number`);
  }
  return number;
}

function firstValue(object, keys) {
  for (const key of keys) if (object[key] != null) return object[key];
  return undefined;
}

function normalizeTokens(raw, coverage) {
  if (coverage === 'unobservable') {
    if (raw != null) throw new UsageObservedError('unobservable usage must not contain token counts');
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new UsageObservedError('tokens are required for observed usage');
  }
  const tokens = {
    input: nonNegative(firstValue(raw, ['input', 'inputTokens', 'input_tokens']), 'tokens.input'),
    output: nonNegative(firstValue(raw, ['output', 'outputTokens', 'output_tokens']), 'tokens.output'),
    cacheRead: nonNegative(firstValue(raw, ['cacheRead', 'cache_read', 'cache_read_input_tokens']), 'tokens.cacheRead'),
    cacheWrite: nonNegative(firstValue(raw, ['cacheWrite', 'cache_write', 'cache_creation_input_tokens']), 'tokens.cacheWrite'),
  };
  tokens.total = tokens.input + tokens.output;
  return Object.freeze(tokens);
}

function normalizeOccurredAt(value) {
  if (value == null || value === '') throw new UsageObservedError('occurredAt is required for a stable eventId');
  const number = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(number) || number <= 0) throw new UsageObservedError('occurredAt must be a timestamp');
  return Math.floor(number);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function stableUsageEventId(identity) {
  return `uo_${crypto.createHash('sha256').update(stableStringify(identity)).digest('hex').slice(0, 32)}`;
}

function bindingValue(rawValue, bindingValue, label) {
  const raw = rawValue == null || rawValue === '' ? null : String(rawValue).trim();
  const bound = bindingValue == null || bindingValue === '' ? null : String(bindingValue).trim();
  if (raw && bound && raw !== bound) {
    throw new UsageObservedError(`${label} conflicts with ProviderBinding`, 'USAGE_BINDING_MISMATCH');
  }
  return raw || bound;
}

function createUsageObserved(input, binding = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new UsageObservedError('UsageObserved input must be an object');
  }
  const bound = binding == null ? null : assertProviderBinding(binding);
  const occurredAt = normalizeOccurredAt(input.occurredAt != null ? input.occurredAt : input.timestamp);
  const sessionId = requiredString(bindingValue(
    input.sessionId != null ? input.sessionId : input.externalSessionId,
    bound && bound.sessionId,
    'sessionId',
  ), 'sessionId');
  const providerId = requiredString(bindingValue(input.providerId, bound && bound.providerId, 'providerId'), 'providerId');
  const roleKind = requiredString(bindingValue(
    input.roleKind != null ? input.roleKind : input.role,
    bound && bound.roleKind,
    'roleKind',
  ), 'roleKind', 16).toLowerCase();
  if (!ROLE_KINDS.has(roleKind)) throw new UsageObservedError('roleKind must be main, sub, or aux');

  let agentRole = bindingValue(input.agentRole, bound && bound.agentRole, 'agentRole');
  let routeName = bindingValue(input.routeName, bound && bound.routeName, 'routeName');
  if (roleKind === 'sub') {
    agentRole = requiredString(agentRole || 'default', 'agentRole', 32).toLowerCase();
    if (!AGENT_ROLES.has(agentRole)) {
      throw new UsageObservedError('sub agentRole must be default, worker, explorer, or custom');
    }
    routeName = requiredString(routeName || agentRole, 'routeName', 64).toLowerCase();
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(routeName)) {
      throw new UsageObservedError('routeName must be a valid agent route');
    }
  } else {
    if (agentRole) throw new UsageObservedError('agentRole is only valid for sub usage');
    agentRole = null;
    routeName = requiredString(routeName || roleKind, 'routeName', 64).toLowerCase();
    if (routeName !== roleKind) throw new UsageObservedError(`${roleKind} routeName must be ${roleKind}`);
  }

  const source = requiredString(input.source, 'source', 32).toLowerCase();
  if (!SOURCES.has(source)) throw new UsageObservedError('source must be exact or reconciled');
  const coverage = requiredString(input.coverage, 'coverage', 32).toLowerCase();
  if (!COVERAGE.has(coverage)) throw new UsageObservedError('coverage must be observed or unobservable');
  const status = requiredString(input.status || (coverage === 'unobservable' ? 'unobservable' : 'success'), 'status', 32).toLowerCase();
  if (!STATUSES.has(status)) throw new UsageObservedError('status must be success, error, or unobservable');
  if (coverage === 'observed' && status === 'unobservable') {
    throw new UsageObservedError('observed coverage cannot use unobservable status');
  }
  if (coverage === 'unobservable' && status !== 'unobservable' && status !== 'error') {
    throw new UsageObservedError('unobservable coverage requires unobservable or error status');
  }
  const protocol = requiredString(input.protocol, 'protocol', 64);
  const tokens = normalizeTokens(input.tokens != null ? input.tokens : input.usage, coverage);
  const inputEventId = optionalString(input.eventId, 256);
  const sourceEventId = optionalString(
    input.sourceEventId || (/^uo_[a-f0-9]{32}$/.test(inputEventId) ? '' : inputEventId),
    256,
  ) || null;

  const eventContent = {
    version: USAGE_OBSERVED_VERSION,
    sourceEventId,
    occurredAt,
    sessionId,
    providerId,
    roleKind,
    agentRole,
    routeName,
    source,
    coverage,
    status,
    protocol,
    model: optionalString(input.model, 256),
    tokens,
  };
  // An upstream event id is the stable observation identity; mutable delivery
  // details (normalizer timestamp, latency, or corrected token counts) must not
  // create a second host event. Without one, hash the complete observation.
  const identity = sourceEventId ? {
    version: USAGE_OBSERVED_VERSION,
    sourceEventId,
    sessionId,
    providerId,
    roleKind,
    agentRole,
    routeName,
    source,
  } : eventContent;
  const eventId = stableUsageEventId(identity);
  if (/^uo_[a-f0-9]{32}$/.test(inputEventId) && inputEventId !== eventId) {
    throw new UsageObservedError('eventId does not match UsageObserved content', 'USAGE_EVENT_ID_MISMATCH');
  }
  const event = {
    version: USAGE_OBSERVED_VERSION,
    eventId,
    sourceEventId,
    occurredAt,
    sessionId,
    providerId,
    providerName: optionalString(input.providerName, 256),
    roleKind,
    agentRole,
    routeName,
    source,
    coverage,
    status,
    protocol,
    model: eventContent.model,
    tokens,
    latencyMs: nonNegative(input.latencyMs, 'latencyMs'),
    ...(input.statusCode == null ? {} : { statusCode: nonNegative(input.statusCode, 'statusCode') }),
    ...(input.errorCode ? { errorCode: optionalString(input.errorCode, 128) } : {}),
  };
  return Object.freeze(event);
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
