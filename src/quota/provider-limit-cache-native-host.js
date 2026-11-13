'use strict';

// Async lifecycle and callback adapter only. Rust owns SQLite, import,
// transactions and cache mutation policy. Operations run in submission order
// so callbacks observe committed rows in the same order as their callers.
const { getNative, runNative } = require('../native/runtime');

function createNativeProviderLimitCache({ file, legacyJsonFile = null, now = Date.now,
  onRecord = null, logger = console } = {}) {
  if (!file || typeof file !== 'string') {
    throw new TypeError('[provider-limit-cache] createProviderLimitCache requires { file }');
  }
  if (typeof now !== 'function') throw new TypeError('[provider-limit-cache] now must be a function');
  const addon = getNative();
  if (typeof addon.RustProviderLimitStore !== 'function') {
    throw new Error('[provider-limit-cache] Rust storage unavailable; rebuild the native module');
  }
  const handle = new addon.RustProviderLimitStore();
  const listeners = new Set();
  let closed = false;
  let migration = null;
  let tail = Promise.resolve();
  const invoke = (op, input) => runNative(() => handle.requestAsync(op, input));
  const opening = invoke('open', { file, legacyFile: legacyJsonFile, now: Number(now()) })
    .then(result => {
      migration = Object.freeze({ ...result });
      if (result.migrated && logger?.log) {
        logger.log(`[multicc/provider-limit-cache] imported ${result.legacyEntryCount} legacy entries into ${file}`);
      }
      return migration;
    });
  // The server awaits ready before accepting work. Attach a rejection handler
  // immediately so a startup error is not reported as an unhandled promise.
  opening.catch(() => {});

  function enqueue(op) {
    if (closed) return Promise.reject(new Error(`[provider-limit-cache] database is closed: ${file}`));
    const result = tail.then(() => opening).then(op);
    tail = result.then(() => undefined, () => undefined);
    return result;
  }
  function notify(entry) {
    for (const listener of listeners) {
      try { listener(entry); } catch (_) { /* a listener cannot roll back a committed write */ }
    }
  }
  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
  const key = (appType, id) => `${String(appType)}:${String(id)}`;
  const identity = (appType, id) => ({ appType: String(appType), providerId: String(id) });
  function get(appType, id) {
    const input = identity(appType, id);
    return enqueue(() => invoke('get', input));
  }
  function record(appType, id, entry) {
    if (!entry || typeof entry !== 'object') return Promise.resolve(null);
    const input = { ...identity(appType, id), now: Number(now()),
      entry: { kind: entry.kind, summary: entry.summary, summaryText: entry.summaryText,
        barText: entry.barText, fetchedAt: entry.fetchedAt } };
    return enqueue(async () => {
      const plan = await invoke('record', input);
      if (!plan.write) return plan.entry;
      notify(plan.entry);
      if (typeof onRecord === 'function') {
        try { Promise.resolve(onRecord(plan.entry)).catch(() => {}); } catch (_) { /* trend is optional */ }
      }
      return plan.entry;
    });
  }
  function recordFailure(appType, id, meta = {}) {
    const input = { ...identity(appType, id), now: Number(now()),
      meta: { error: meta.error ? String(meta.error) : null, code: meta.code ? String(meta.code) : null } };
    return enqueue(async () => {
      const entry = await invoke('recordFailure', input);
      notify(entry);
      return entry;
    });
  }
  function recordDerived(appType, id, operation, args, at = now()) {
    const input = { ...identity(appType, id), operation, arguments: args, now: Number(at) };
    return enqueue(async () => {
      const plan = await invoke('recordDerived', input);
      if (!plan.write) return plan.entry;
      notify(plan.entry);
      if (typeof onRecord === 'function') {
        try { Promise.resolve(onRecord(plan.entry)).catch(() => {}); } catch (_) { /* trend is optional */ }
      }
      return plan.entry;
    });
  }
  function transitionAvailability(appType, id, args, at = now()) {
    const input = { ...identity(appType, id), arguments: args, now: Number(at) };
    return enqueue(async () => {
      const plan = await invoke('transitionAvailability', input);
      if (plan.write) {
        notify(plan.entry);
        if (typeof onRecord === 'function') {
          try { Promise.resolve(onRecord(plan.entry)).catch(() => {}); } catch (_) { /* trend is optional */ }
        }
      }
      return plan;
    });
  }
  function recordVirtualFailure(appType, id, args, at = now()) {
    const input = { ...identity(appType, id), arguments: args, now: Number(at) };
    return enqueue(async () => {
      const plan = await invoke('recordVirtualFailure', input);
      if (plan.write) {
        notify(plan.entry);
        if (typeof onRecord === 'function') {
          try { Promise.resolve(onRecord(plan.entry)).catch(() => {}); } catch (_) { /* trend is optional */ }
        }
      }
      return plan.entry;
    });
  }
  const snapshot = () => enqueue(() => invoke('snapshot', {}));
  const prune = liveKeys => enqueue(() => invoke('prune', { liveKeys: Array.from(liveKeys) }));
  function close() {
    if (closed) return tail;
    closed = true;
    const result = tail.then(() => opening).then(() => invoke('close', {}));
    tail = result.then(() => undefined, () => undefined);
    return result.finally(() => listeners.clear());
  }
  return Object.freeze({
    file, legacyJsonFile, isAsync: true, key, subscribe, get, record, recordDerived, recordFailure, transitionAvailability, recordVirtualFailure, snapshot, prune, close,
    ready: () => opening,
    idle: () => tail.then(() => opening),
    get migration() { return migration; },
  });
}

module.exports = { createNativeProviderLimitCache };
