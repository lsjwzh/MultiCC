'use strict';
// GET /api/providers/limit-history — remaining-quota trend series for the
// provider cards. Samples are written by the Rust quota-history kernel whenever
// a provider limit reading is recorded (src/quota/provider-limit-cache.js).
//
//   ?range=24h|7d|30d   (default 24h; bounded by the kernel's retention)
//   ?since=<epoch ms>    explicit start, wins over range
//   ?points=<2..240>     max points per series (bucket-last downsample)
//   ?appType=&id=        narrow to one provider
//
// The answer is always 200: a process without the native kernel reports
// `available: false` and the UI simply omits the trend instead of surfacing an
// error on every card.

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

function mountProviderLimitHistoryRoutes(app, { history, providers, now = Date.now } = {}) {
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

module.exports = { mountProviderLimitHistoryRoutes, providerIdentities, RANGE_MS };
