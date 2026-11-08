'use strict';
// Frozen pre-migration text rules, copied verbatim from the last commit that
// had them in JS: redact / redactProviderRouteCapability (with the helpers
// they use) from src/observability.js, normalizeRejection / sanitizeMessage
// from src/chat/api-error-policy.js. Test-only differential oracle; never
// imported by product code.

const SECRET_KEY = /(?:token|secret|password|authorization|cookie|api[-_]?key)/i;
const SECRET_TEXT = /((?:token|secret|password|authorization|cookie|api[-_]?key)["']?\s*[=:]\s*["']?)([^"'\s,;}&]+)/ig;
const BEARER_TEXT = /(\bBearer\s+)([A-Za-z0-9._~+\/-]+=*)/ig;
const QUERY_SECRET = /([?&](?:token|access_token|api_key)=)([^&#\s]+)/ig;
const PROVIDER_ROUTE_CAPABILITY = /pr1\.[A-Za-z0-9_-]{1,344}\.[A-Za-z0-9_-]{1,344}/g;
const PROVIDER_ROUTE_TOKEN = /proxy-route[-_][A-Za-z0-9_-]{1,344}/g;
const PROVIDER_ROUTE_REDACTION = '[REDACTED_PROVIDER_ROUTE]';

function defineEnumerableValue(target, key, value) {
  Object.defineProperty(target, key, {
    value, enumerable: true, configurable: true, writable: true,
  });
}

function collisionSafeKey(target, requested) {
  if (!Object.prototype.hasOwnProperty.call(target, requested)) return requested;
  let counter = 2;
  let candidate = `${requested}#${counter}`;
  while (Object.prototype.hasOwnProperty.call(target, candidate)) {
    counter += 1;
    candidate = `${requested}#${counter}`;
  }
  return candidate;
}

function redactProviderRouteCapability(value, seen = new WeakMap()) {
  if (typeof value === 'string') {
    return value.replace(PROVIDER_ROUTE_CAPABILITY, PROVIDER_ROUTE_REDACTION)
      .replace(PROVIDER_ROUTE_TOKEN, PROVIDER_ROUTE_REDACTION);
  }
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  const output = Array.isArray(value) ? [] : {};
  seen.set(value, output);
  let changed = false;
  for (const [key, item] of Object.entries(value)) {
    const redactedKey = key.replace(PROVIDER_ROUTE_CAPABILITY, PROVIDER_ROUTE_REDACTION)
      .replace(PROVIDER_ROUTE_TOKEN, PROVIDER_ROUTE_REDACTION);
    const outputKey = collisionSafeKey(output, redactedKey);
    const outputValue = redactProviderRouteCapability(item, seen);
    defineEnumerableValue(output, outputKey, outputValue);
    if (outputKey !== key || outputValue !== item) changed = true;
  }
  if (changed) return output;
  seen.set(value, value);
  return value;
}

function redact(value, key = '') {
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') {
    return redactProviderRouteCapability(value).replace(BEARER_TEXT, '$1[REDACTED]').replace(QUERY_SECRET, '$1[REDACTED]').replace(SECRET_TEXT, '$1[REDACTED]');
  }
  if (Array.isArray(value)) return value.map(v => redact(v));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const safeKey = collisionSafeKey(out, redactProviderRouteCapability(k));
      defineEnumerableValue(out, safeKey, redact(v, k));
    }
    return out;
  }
  return value;
}

const REJECTION_KINDS = new Set(['transient', 'window', 'entitlement', 'billing']);
const REJECTION_SCOPES = new Set(['request', 'model', 'account']);
const REJECTION_WINDOWS = new Set(['5h', '1d', '1wk', '1m']);
const REJECTION_SOURCES = new Set(['headers', 'code', 'text', 'status']);
const REJECTION_TEXT_MAX = 80;

function rejectionText(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text.slice(0, REJECTION_TEXT_MAX) : null;
}

function normalizeRejection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const kind = String(value.kind || '').trim().toLowerCase();
  if (!REJECTION_KINDS.has(kind)) return null;
  const scope = String(value.scope || '').trim().toLowerCase();
  const window = value.window == null ? null : String(value.window).trim().toLowerCase();
  const source = String(value.source || '').trim().toLowerCase();
  const resetMs = Number(value.resetMs);
  return Object.freeze({
    kind,
    scope: REJECTION_SCOPES.has(scope) ? scope : null,
    window: window != null && REJECTION_WINDOWS.has(window) ? window : null,
    resetMs: Number.isFinite(resetMs) && resetMs > 0 && resetMs <= Number.MAX_SAFE_INTEGER
      ? Math.round(resetMs) : null,
    code: rejectionText(value.code),
    model: rejectionText(value.model),
    source: REJECTION_SOURCES.has(source) ? source : null,
  });
}

const MAX_SANITIZED_MESSAGE = 240;

function sanitizeMessage(value, fallback = 'Upstream API request failed', maxLength = MAX_SANITIZED_MESSAGE) {
  let message = String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  message = String(redact(message));
  message = message
    .replace(/(?:sk|sess|key|token|cookie|auth)[-_A-Za-z0-9.]{8,}/ig, '[REDACTED]')
    .replace(/\b[A-Fa-f0-9]{24,}\b/g, '[ID]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[ID]')
    .replace(/[A-Z]:\\[^\s]+|\/(?:Users|home|var|tmp)\/[^\s]+/g, '[PATH]')
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '[ACCOUNT]');
  if (!message) message = fallback;
  return message.slice(0, maxLength);
}

module.exports = {
  SECRET_KEY, PROVIDER_ROUTE_REDACTION, redact, redactProviderRouteCapability,
  normalizeRejection, sanitizeMessage,
};
