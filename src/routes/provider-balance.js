'use strict';

// GET /api/providers/:appType/:id/balance — query one provider's quota/balance
// GET /api/providers/balances             — query every pollable provider at once
//
// The chat page already shows quota bars fed by per-vendor routes, and the
// manage page paints last-known badges per vendor KIND. Neither answers "what
// does THIS provider's account have left, right now" — and money-balance
// vendors like DeepSeek have no badge at all. These endpoints resolve each
// provider to its limit target (providers.js getProviderLimitTarget) and run
// the SAME adapters the usage-limit poller uses, so one query path exists per
// vendor and the shapes stay the ones the front-end already understands.

const {
  pollGlmMonitor,
  pollDeepseekBalance,
  pollCodexUsage,
} = require('../usage-limit-poller');
const { fetchKimiBalance } = require('./kimi-quota');

// Kimi's balance fetcher predates the poller DTOs and returns its own shape;
// normalize it to a balance DTO so the caller handles one kind per strategy.
async function pollKimiBalance(target, nowMs, timeoutMs, fetchImpl = fetchKimiBalance) {
  const result = await fetchImpl(target, timeoutMs);
  if (!result || result.error) return null;
  if (typeof result.available !== 'number') return null;
  return {
    kind: 'balance',
    available: result.available,
    voucher: typeof result.voucher === 'number' ? result.voucher : null,
    cash: typeof result.cash === 'number' ? result.cash : null,
    currency: result.currency || 'CNY',
  };
}

const DEFAULT_ADAPTERS = Object.freeze({
  'glm-monitor': pollGlmMonitor,
  'deepseek-balance': pollDeepseekBalance,
  'codex-oauth-usage': pollCodexUsage,
  'kimi-balance': pollKimiBalance,
});

function createProviderBalanceRuntime(options = {}) {
  const { getProvider, listProviders, getProviderLimitTarget } = options;
  if (typeof getProvider !== 'function') throw new TypeError('getProvider required');
  if (typeof listProviders !== 'function') throw new TypeError('listProviders required');
  if (typeof getProviderLimitTarget !== 'function') throw new TypeError('getProviderLimitTarget required');
  const adapters = options.adapters || DEFAULT_ADAPTERS;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  // Optional persistence hook (appType, id, result) => void, fed every queryOne
  // outcome (successful DTO or ok:false) so the provider-limit cache stays warm
  // from on-demand queries, not just the background poller. Best-effort.
  const onResult = typeof options.onResult === 'function' ? options.onResult : null;

  // One provider → one result. Providers without a pollable surface resolve to
  // ok:false reason:'unsupported' rather than an HTTP error: "no balance API"
  // is a normal answer the UI must be able to display.
  async function queryOne(appType, id) {
    const provider = getProvider(appType, id);
    if (!provider) return { ok: false, reason: 'not_found' };
    const target = getProviderLimitTarget(appType, id);
    if (!target || !target.strategy || !adapters[target.strategy]) {
      return { ok: false, reason: 'unsupported', providerId: id, appType: provider.appType };
    }
    let dto = null;
    try {
      dto = await adapters[target.strategy](target, now());
    } catch (_) {
      dto = null;
    }
    if (!dto) {
      const failure = { ok: false, reason: 'fetch_failed', providerId: id, appType: provider.appType, strategy: target.strategy };
      if (onResult) { try { onResult(provider.appType, id, failure); } catch (_) {} }
      return failure;
    }
    const success = { ok: true, providerId: id, appType: provider.appType, strategy: target.strategy, dto };
    if (onResult) { try { onResult(provider.appType, id, success); } catch (_) {} }
    return success;
  }

  // Every provider at once, in parallel. Unpollable providers still appear in
  // the results so the UI can show one row per card without a second pass.
  async function queryAll() {
    const providers = listProviders();
    const results = await Promise.all(providers.map(async provider => {
      const result = await queryOne(provider.appType, provider.id);
      return { name: provider.name || '', ...result };
    }));
    return { ok: true, results };
  }

  return Object.freeze({ queryOne, queryAll, adapters });
}

function mountProviderBalanceRoutes(app, deps = {}) {
  if (!app || typeof app.get !== 'function') return null;
  const runtime = deps.runtime || createProviderBalanceRuntime(deps);
  // Registered before the per-provider route only for readability — the two
  // paths cannot collide (different segment counts).
  app.get('/api/providers/balances', async (req, res) => {
    try {
      res.json(await runtime.queryAll());
    } catch (_) {
      res.status(500).json({ ok: false, error: 'provider balances failed' });
    }
  });
  app.get('/api/providers/:appType/:id/balance', async (req, res) => {
    try {
      const result = await runtime.queryOne(req.params.appType, req.params.id);
      if (result.reason === 'not_found') return res.status(404).json(result);
      res.json(result);
    } catch (_) {
      res.status(500).json({ ok: false, error: 'provider balance failed' });
    }
  });
  return runtime;
}

module.exports = {
  createProviderBalanceRuntime,
  mountProviderBalanceRoutes,
  pollKimiBalance,
  DEFAULT_ADAPTERS,
};
