'use strict';

const { monitorEventLoopDelay } = require('perf_hooks');

const SECRET_KEY = /(?:token|secret|password|authorization|cookie|api[-_]?key)/i;
const SECRET_TEXT = /((?:token|secret|password|authorization|cookie|api[-_]?key)["']?\s*[=:]\s*["']?)([^"'\s,;}&]+)/ig;
const BEARER_TEXT = /(\bBearer\s+)([A-Za-z0-9._~+\/-]+=*)/ig;
const QUERY_SECRET = /([?&](?:token|access_token|api_key)=)([^&#\s]+)/ig;

function redact(value, key = '') {
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') {
    return value.replace(BEARER_TEXT, '$1[REDACTED]').replace(QUERY_SECRET, '$1[REDACTED]').replace(SECRET_TEXT, '$1[REDACTED]');
  }
  if (Array.isArray(value)) return value.map(v => redact(v));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redact(v, k);
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

module.exports = { createObservability, createLogger, createMetrics, redact, installConsoleRedaction };
