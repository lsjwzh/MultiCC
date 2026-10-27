'use strict';
// Adapter between the provider-limit cache and the Rust quota-history kernel.
//
// The kernel owns the samples table, dedupe/retention and downsampling; this
// file only marshals JSON and keeps the native handle lazy. A process without a
// matching native addon simply reports `available: false` — the provider cards
// then render without a trend instead of failing the providers API.

const fs = require('node:fs');
const { getNative, runNative } = require('../native/runtime');

const DEFAULT_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

function createProviderQuotaHistory({
  file,
  retentionMs = DEFAULT_RETENTION_MS,
  native = null,
  logger = console,
} = {}) {
  if (!file || typeof file !== 'string') {
    throw new TypeError('[provider-quota-history] createProviderQuotaHistory requires { file }');
  }
  let handle = null;
  let unavailable = false;
  let warned = false;
  let lastError = null;

  function ensure() {
    if (handle) return handle;
    if (unavailable) return null;
    let addon = native;
    if (!addon) {
      try { addon = getNative('quota_history'); } catch (_) { addon = null; }
    }
    const Constructor = addon && addon.RustQuotaHistory;
    if (typeof Constructor !== 'function') {
      unavailable = true;
      return null;
    }
    try {
      handle = new Constructor(file, Math.trunc(retentionMs));
      // SQLite derives the -wal/-shm modes from the database file; tighten the
      // main file before the first write so sidecars inherit 0600 too.
      try { fs.chmodSync(file, 0o600); } catch (_) { /* best effort */ }
    } catch (error) {
      unavailable = true;
      lastError = error;
      if (!warned) {
        warned = true;
        logger.warn?.(`[multicc/quota-history] 历史库不可用，趋势图将不显示：${error.message}`);
      }
    }
    return handle;
  }

  function call(method, payload) {
    const instance = ensure();
    if (!instance) return Promise.resolve(null);
    return runNative(() => instance[method](JSON.stringify(payload)))
      .then(result => JSON.parse(result.result))
      .catch(error => {
        lastError = error;
        if (!warned) {
          warned = true;
          logger.warn?.(`[multicc/quota-history] ${method} 失败，趋势图将暂时缺失：${error.message}`);
        }
        return null;
      });
  }

  // One cache entry → one sampling write. Availability cooldowns carry no
  // quota numbers and are skipped before crossing into the kernel.
  function recordEntry(entry) {
    if (!entry || !entry.appType || !entry.providerId || !entry.summary) return Promise.resolve(null);
    if (entry.summary.kind === 'availability') return Promise.resolve(null);
    return call('record', {
      appType: entry.appType,
      providerId: entry.providerId,
      sampledAt: entry.updatedAt || Date.now(),
      summary: entry.summary,
    });
  }

  function query({ providers, sinceMs, points } = {}) {
    if (!Array.isArray(providers) || !providers.length) return Promise.resolve(null);
    return call('query', {
      providers: providers.slice(0, 64),
      ...(Number.isFinite(Number(sinceMs)) ? { sinceMs: Math.trunc(Number(sinceMs)) } : {}),
      ...(Number.isFinite(Number(points)) ? { points: Math.trunc(Number(points)) } : {}),
    });
  }

  function available() {
    return !!ensure();
  }

  function status() {
    return { available: !!handle, lastError: lastError ? String(lastError.message || lastError) : null };
  }

  function close() {
    handle = null;
  }

  return Object.freeze({ available, recordEntry, query, status, close });
}

module.exports = { createProviderQuotaHistory, DEFAULT_RETENTION_MS };
