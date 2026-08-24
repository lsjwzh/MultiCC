'use strict';

const { monitorEventLoopDelay } = require('perf_hooks');

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

// Redact an exact secret even when one semantic structure distributes it over
// several independently stored strings (including object keys). Callers choose
// the semantic parts and their order; structural protocol fields are therefore
// never guessed or rewritten. Every participating part gets its own marker so
// no subset of retained fields can be concatenated to recover the capability.
function redactExactSecretFragments(values, initialSecrets = []) {
  const parts = (Array.isArray(values) ? values : [values]).map(value => String(value || ''));
  const secrets = [...new Set((Array.isArray(initialSecrets) ? initialSecrets : [initialSecrets])
    .map(value => String(value || '')).filter(Boolean))]
    .sort((left, right) => right.length - left.length);
  if (!parts.length || !secrets.length) return parts;
  const offsets = [];
  let joined = '';
  for (const part of parts) {
    offsets.push(joined.length);
    joined += part;
  }
  const matches = [];
  let cursor = 0;
  while (cursor < joined.length) {
    let index = -1;
    let matched = '';
    for (const secret of secrets) {
      const candidate = joined.indexOf(secret, cursor);
      if (candidate >= 0 && (index < 0 || candidate < index
          || (candidate === index && secret.length > matched.length))) {
        index = candidate;
        matched = secret;
      }
    }
    if (index < 0) break;
    matches.push({ start: index, end: index + matched.length });
    cursor = index + matched.length;
  }
  if (!matches.length) return parts;
  const edits = parts.map(() => []);
  for (const match of matches) {
    for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
      const partStart = offsets[partIndex];
      const partEnd = partStart + parts[partIndex].length;
      const start = Math.max(match.start, partStart);
      const end = Math.min(match.end, partEnd);
      if (start >= end) continue;
      edits[partIndex].push({
        start: start - partStart,
        end: end - partStart,
        replacement: PROVIDER_ROUTE_REDACTION,
      });
    }
  }
  return parts.map((part, index) => edits[index]
    .sort((left, right) => right.start - left.start)
    .reduce((result, edit) => (
      result.slice(0, edit.start) + edit.replacement + result.slice(edit.end)
    ), part));
}

// Exact streaming DLP for the process capability. Stateless regex replacement
// cannot see a value deliberately split across token deltas, so this small
// transducer withholds only a suffix that could still become a known secret.
// It never releases a complete secret, regardless of chunk boundaries.
function createExactSecretStreamRedactor(initialSecrets = []) {
  let secrets = [];
  let pending = '';
  const setSecrets = values => {
    secrets = [...new Set((Array.isArray(values) ? values : [values])
      .map(value => String(value || '')).filter(Boolean))]
      .sort((left, right) => right.length - left.length);
  };
  setSecrets(initialSecrets);
  const longestPendingSuffix = value => {
    let best = 0;
    for (const secret of secrets) {
      const limit = Math.min(secret.length - 1, value.length);
      for (let length = limit; length > best; length -= 1) {
        if (secret.startsWith(value.slice(-length))) { best = length; break; }
      }
    }
    return best;
  };
  const push = chunk => {
    let input = pending + String(chunk || '');
    pending = '';
    let output = '';
    while (input) {
      let index = -1;
      let matched = '';
      for (const secret of secrets) {
        const candidate = input.indexOf(secret);
        if (candidate >= 0 && (index < 0 || candidate < index
            || (candidate === index && secret.length > matched.length))) {
          index = candidate;
          matched = secret;
        }
      }
      if (index >= 0) {
        output += input.slice(0, index) + PROVIDER_ROUTE_REDACTION;
        input = input.slice(index + matched.length);
        continue;
      }
      const keep = longestPendingSuffix(input);
      output += input.slice(0, input.length - keep);
      pending = keep ? input.slice(-keep) : '';
      break;
    }
    return redactProviderRouteCapability(output);
  };
  return Object.freeze({
    push,
    setSecrets,
    flush: () => {
      const output = redactProviderRouteCapability(pending);
      pending = '';
      return output;
    },
    discard: () => { pending = ''; },
    pendingLength: () => pending.length,
  });
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

function installConsoleRedaction(target = console) {
  if (!target || target.__multiccRedacted) return target;
  for (const name of ['log', 'info', 'warn', 'error', 'debug']) {
    if (typeof target[name] !== 'function') continue;
    const original = target[name].bind(target);
    target[name] = (...args) => original(...args.map(arg => redact(arg)));
  }
  Object.defineProperty(target, '__multiccRedacted', { value: true, configurable: false });
  return target;
}

function createLogger({ sink = console, service = 'multicc', now = () => new Date() } = {}) {
  function write(level, event, fields) {
    const record = redact({ ts: now().toISOString(), level, service, event: String(event || 'log'), ...(fields || {}) });
    const line = JSON.stringify(record);
    const fn = level === 'error' ? sink.error : level === 'warn' ? sink.warn : sink.log;
    try { (fn || sink.log).call(sink, line); } catch (_) {}
  }
  return {
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
  };
}

function metricName(name) {
  if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(name)) throw new TypeError(`invalid metric name: ${name}`);
  return name;
}

function createMetrics() {
  const values = new Map();
  return {
    inc(name, amount = 1) {
      metricName(name);
      values.set(name, (values.get(name) || 0) + amount);
    },
    set(name, value) {
      metricName(name);
      if (Number.isFinite(Number(value))) values.set(name, Number(value));
    },
    get: name => values.get(name) || 0,
    render(extra = {}) {
      const merged = new Map(values);
      for (const [name, value] of Object.entries(extra)) {
        metricName(name);
        if (Number.isFinite(Number(value))) merged.set(name, Number(value));
      }
      return [...merged.entries()].sort(([a], [b]) => a.localeCompare(b))
        .map(([name, value]) => `${name} ${value}`).join('\n') + '\n';
    },
  };
}

function createObservability(opts = {}) {
  const logger = createLogger(opts);
  const metrics = createMetrics();
  const lag = monitorEventLoopDelay({ resolution: 20 });
  lag.enable();
  return {
    logger,
    metrics,
    eventLoopMetrics() {
      return {
        multicc_event_loop_lag_mean_seconds: Number.isFinite(lag.mean) ? lag.mean / 1e9 : 0,
        multicc_event_loop_lag_max_seconds: Number.isFinite(lag.max) ? lag.max / 1e9 : 0,
      };
    },
    close() { lag.disable(); },
  };
}

module.exports = {
  createObservability, createLogger, createMetrics,
  createExactSecretStreamRedactor, redactExactSecretFragments,
  redact, redactProviderRouteCapability, installConsoleRedaction,
};
