'use strict';

const { monitorEventLoopDelay } = require('perf_hooks');
const { getNative } = require('./native/runtime');

// The text rules (secret field names, bearer/query/key=value secrets, provider
// route capabilities, exact secrets) are native/core/src/redaction.rs and
// exact_secret.rs; the object walk is native/addon/src/provider_scrub.rs.

// Rust also exports each rule's necessary anchors, so the walk only crosses
// into native code for a string that could change (most keys and stream text
// cannot). The text anchors match under ASCII-only case folding, as /i does.
let anchors = null;
function redactionAnchors() {
  if (!anchors) {
    const { route, text } = getNative().redactionAnchors();
    const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    anchors = Object.freeze({
      route: Object.freeze([...route]),
      text: new RegExp([...route, ...text].map(escape).join('|'), 'i'),
    });
  }
  return anchors;
}

function redactRouteText(text) {
  if (!redactionAnchors().route.some(anchor => text.includes(anchor))) return text;
  return getNative().redactionRouteCapability(text);
}

function redactText(text) {
  if (!redactionAnchors().text.test(text)) return text;
  return getNative().redactionRedactText(text);
}

// `SECRET_KEY.test(key)` did ToString(key).
function isSecretKey(key) {
  const text = typeof key === 'string' ? key : `${key}`;
  return redactionAnchors().text.test(text) && getNative().redactionSecretKey(text);
}

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

// Route redaction rewrites each string on its own (`String#replace` per value
// and per key), so a structure with no route anchor in any string cannot
// change. Two cases still change without an anchor and must take the native
// walk: NaN never compares equal, and a cyclic/shared node compares by
// identity against the copy being built. The scan is iterative with a WeakSet
// so it terminates, and the anchors themselves still come from Rust.
function maybeRouteCapability(value) {
  const stack = [value];
  const seen = new WeakSet();
  while (stack.length) {
    const item = stack.pop();
    if (typeof item === 'string') {
      if (redactionAnchors().route.some(anchor => item.includes(anchor))) return true;
      continue;
    }
    if (typeof item === 'number' && Number.isNaN(item)) return true;
    if (!item || typeof item !== 'object') continue;
    if (seen.has(item)) return true;
    seen.add(item);
    for (const key of Object.keys(item)) {
      stack.push(key);
      stack.push(item[key]);
    }
  }
  return false;
}

function redactProviderRouteCapability(value) {
  // A string without an anchor cannot change, and most stream text has none:
  // keep that check in JS so the hot string path never crosses the boundary.
  if (typeof value === 'string') return redactRouteText(value);
  if (!value || typeof value !== 'object') return value;
  if (!maybeRouteCapability(value)) return value;
  return getNative().redactionRouteCapabilityValue(value);
}

// Redact an exact secret even when one semantic structure distributes it over
// several independently stored strings (including object keys). Callers choose
// the semantic parts and their order; structural protocol fields are therefore
// never guessed or rewritten. Every participating part gets its own marker so
// no subset of retained fields can be concatenated to recover the capability
// (native/core/src/exact_secret.rs).
function redactExactSecretFragments(values, initialSecrets = []) {
  return getNative().redactionExactFragments(values, initialSecrets);
}

// Exact streaming DLP for the process capability. Stateless regex replacement
// cannot see a value deliberately split across token deltas, so this small
// transducer (native/core/src/exact_secret.rs) withholds only a suffix that
// could still become a known secret. It never releases a complete secret,
// regardless of chunk boundaries.
function createExactSecretStreamRedactor(initialSecrets = []) {
  const state = new (getNative().RustExactSecretStreamRedactor)(initialSecrets);
  return Object.freeze({
    push: chunk => state.push(chunk),
    setSecrets: values => state.setSecrets(values),
    flush: () => state.flush(),
    discard: () => state.discard(),
    pendingLength: () => state.pendingLength(),
  });
}

function redact(value, key = '') {
  if (isSecretKey(key)) return '[REDACTED]';
  if (typeof value === 'string') return redactText(value);
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
  redact, redactProviderRouteCapability, maybeRouteCapability, installConsoleRedaction,
};
