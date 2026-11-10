'use strict';
// Frozen oracle for the migration of GET /api/providers/limit-history into the
// Rust front door. The route and the adapter half below are byte-for-byte
// copies of src/routes/provider-limit-history.js and the query/available logic
// of src/quota/provider-quota-history.js as they stood before the move, with
// only the require paths adapted. It stays in tests/ so the differential run
// and future readers keep a runnable Node reference after the production files
// are deleted (docs/gateway.md §9).
//
// It is NOT production code: nothing in src/ or server.js may require it.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const { getNative, runNative } = require(path.join(ROOT, 'src/native/runtime'));

const DEFAULT_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

function createLegacyProviderQuotaHistory({
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
    const addon = native || getNative();
    try {
      handle = new addon.RustQuotaHistory(file, Math.trunc(retentionMs));
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

const RANGE_MS = Object.freeze({
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
});
const MAX_POINTS = 240;
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const APP_TYPES = new Set(['claude', 'codex']);

function boundedText(value, max) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : '';
}

function providerIdentities(listProviders, { appType, id } = {}) {
  const wanted = APP_TYPES.has(appType) ? [appType] : ['claude', 'codex'];
  const identities = [];
  for (const type of wanted) {
    let rows = [];
    try { rows = listProviders(type) || []; } catch (_) { rows = []; }
    for (const row of rows) {
      if (!row || !row.id) continue;
      if (id && row.id !== id) continue;
      identities.push({ appType: row.appType || type, providerId: String(row.id) });
    }
  }
  return identities;
}

function mountLegacyProviderLimitHistoryRoutes(app, { history, providers, now = Date.now } = {}) {
  if (!app || typeof app.get !== 'function' || !history) return null;
  app.get('/api/providers/limit-history', async (req, res) => {
    const query = req.query || {};
    const range = boundedText(query.range, 8) || '24h';
    const requestedSince = Number(query.since);
    const points = Math.min(MAX_POINTS, Math.max(2, Math.trunc(Number(query.points)) || 48));
    const current = now();
    const sinceMs = Number.isFinite(requestedSince) && requestedSince > 0
      ? Math.max(requestedSince, current - MAX_AGE_MS)
      : current - (RANGE_MS[range] || RANGE_MS['24h']);
    res.setHeader('Cache-Control', 'no-store');
    if (!history.available()) {
      return res.json({
        available: false, reason: 'unavailable', generatedAt: current, sinceMs, points, providers: {},
      });
    }
    const identities = providerIdentities(
      typeof providers?.listProviders === 'function' ? providers.listProviders.bind(providers) : () => [],
      { appType: boundedText(query.appType, 32), id: boundedText(query.id, 80) },
    );
    try {
      const result = await history.query({ providers: identities, sinceMs, points });
      res.json({
        available: true,
        generatedAt: current,
        sinceMs,
        points,
        providers: (result && result.providers) || {},
      });
    } catch (error) {
      res.json({
        available: false,
        reason: 'query_failed',
        generatedAt: current,
        sinceMs,
        points,
        providers: {},
        error: String(error && error.message || error).slice(0, 200),
      });
    }
  });
  return { providerIdentities };
}

module.exports = {
  createLegacyProviderQuotaHistory,
  mountLegacyProviderLimitHistoryRoutes,
  providerIdentities,
  RANGE_MS,
  DEFAULT_RETENTION_MS,
};
