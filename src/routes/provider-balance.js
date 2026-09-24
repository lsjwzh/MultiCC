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
  pollRelayQuota,
} = require('../usage-limit-poller');
const { fetchKimiBalance } = require('./kimi-quota');
const { balanceBar, renderQuotaBar, COLOR } = require('../quota/quota-bar-view');

function quotaBarFor(strategy, dto, fetchedAt) {
  if (!dto) return null;
  if (dto.kind === 'balance') return balanceBar(dto);
  if (dto.kind !== 'window') return null;
  const used = Number(dto.utilization) * 100;
  if (!Number.isFinite(used)) return null;
  const weekly = Number(dto.weeklyUtilization) * 100;
  // The provider decides the bar species, not the CLI/provider pool that happens
  // to carry it. A Codex-compatible provider may still be GLM, so appType ===
  // 'codex' must never turn its 5h + weekly GLM windows into a ChatGPT bar.
  if (strategy === 'codex-oauth-usage' || dto.provider === 'codex') {
    return renderQuotaBar('codex', {
      status: 'ok', fetchedAt, planType: dto.tier || null,
      // Poller DTO resetsAt is epoch seconds; codexBar owns the seconds→ms
      // conversion. Dividing here made every borrowed reset look like 1970.
      weekly: { usedPercent: used, remainingPercent: Math.max(0, 100 - used),
        resetsAt: dto.resetsAt || null },
    });
  }
  return renderQuotaBar('zhipu', {
    status: 'ok', fetchedAt,
    sites: [{ site: 'relay', host: 'relay', ok: true, usedPercent: used,
      resetsAt: dto.resetsAt || null,
      ...(Number.isFinite(weekly) ? { weeklyUsedPercent: weekly, weeklyResetsAt: dto.weeklyResetsAt || null } : {}) }],
  });
}

// Kimi's balance fetcher predates the poller DTOs and returns its own shape;
// normalize it to a balance DTO so the caller handles one kind per strategy.
async function pollKimiBalance(target, nowMs, timeoutMs, fetchImpl = fetchKimiBalance) {
  const result = await fetchImpl(target, timeoutMs);
  if (!result || result.error) {
    // Surface the concrete reason (auth_rejected / HTTP status / transport
    // errno chain) instead of flattening it into a bare fetch_failed.
    const detail = result && result.detail
      ? result.detail
      : `kimi balance fetch failed: ${(result && result.reason) || 'no result'}`
        + (result && result.httpStatus ? ` (HTTP ${result.httpStatus})` : '');
    const error = new Error(`limit fetch failed: ${detail}`);
    error.kind = 'limit_fetch_failed';
    error.detail = detail;
    throw error;
  }
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
  // 借道 provider：本机没有厂商凭据，转发给出借方的 relay quota 端点。
  'relay-quota': pollRelayQuota,
});

// The bar a last-known-good entry can still paint. The stored barText already
// carries its own {cd:}/{ago:} tokens (clients resolve them, so the deadlines
// stay real); what it cannot say is that it is no longer live — that is the
// muted color and the title's job.
function staleBar(entry, fetchedAt, detail) {
  const text = typeof entry.barText === 'string' ? entry.barText.trim() : '';
  if (!text) return null;
  // Renders that end with their own sync timestamp keep it (it is the same
  // time); only a text without one gets ours, so a stale bar never shows two
  // "X 前" segments.
  const stamp = fetchedAt !== null && !/\{ago:\d+\}/.test(text)
    ? ` · 上次同步 {ago:${fetchedAt}}`
    : '';
  return {
    text: `${text}${stamp}`,
    color: COLOR.gray,
    title: `实时查询失败，这是最近一次成功同步的余量，点击重试${detail ? `（${detail}）` : ''}`,
    action: null,
  };
}

// Last-known-good fallback for the TRANSIENT failure path (see queryOne).
//
// The provider-limit cache is built so a failed fetch never overwrites a good
// entry, so when the live query dies (lender offline, 403, Connect Timeout) that
// cache still holds the last window/balance that actually answered. Serving it
// is the difference between "the bar is gone" and "the bar with an honest
// 上次同步" on a freshly loaded page — the borrowed-provider (借道) case above
// all, where every query crosses the network to the lender.
//
// Deliberately NOT used for reason:'unsupported': that is a permanent answer
// ("this provider exposes no quota surface"), not a transient one, and reviving
// a stale bar under a provider that can never refresh it would be a lie. A
// provider that never answered has no entry either, so this cannot invent one.
function staleFallback(lookupCached, provider, target, id, failure) {
  if (!lookupCached) return null;
  let entry = null;
  try { entry = lookupCached(provider.appType, id); } catch (_) { return null; }
  if (!entry || typeof entry !== 'object') return null;
  const summary = entry.summary;
  if (!summary || typeof summary !== 'object') return null;
  // Only the two species the balance endpoints own. 'claude' / 'quota' /
  // 'availability' summaries are other producers' business and have no dto the
  // clients could dispatch on.
  if (summary.kind !== 'window' && summary.kind !== 'balance') return null;
  const fetchedAt = Number.isFinite(Number(entry.fetchedAt)) ? Number(entry.fetchedAt) : null;
  const bar = staleBar(entry, fetchedAt, failure.detail);
  if (!bar) return null;
  return {
    ok: true,
    // `dto.kind` is what both clients dispatch on (window bar vs balance chip),
    // so the fallback keeps the species of the value it stands in for. The dto
    // is the stored summary, not the failed live one — it is what the bar shows.
    dto: summary,
    bar,
    fetchedAt,
    cached: true,
    stale: true,
    providerId: id,
    appType: provider.appType,
    strategy: target.strategy,
    ...(failure.detail ? { detail: failure.detail } : {}),
  };
}

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
  // Optional (appType, id) => entry|null last-known-good lookup, backed by
  // provider-limit-cache. Only the balance routes get one: the 借道 lender
  // routes (mountProviderRelayQuotaRoutes) must keep answering with a REAL
  // query result, never a stash of their own.
  const lookupCached = typeof options.lookupCached === 'function' ? options.lookupCached : null;

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
    let failureDetail = null;
    try {
      dto = await adapters[target.strategy](target, now());
    } catch (error) {
      dto = null;
      // Preserve the layered root cause (HTTP status + body / OS errno chain)
      // instead of flattening every failure to an opaque "fetch_failed".
      failureDetail = error && error.kind === 'limit_fetch_failed' && error.detail
        ? error.detail
        : String((error && error.message) || error).slice(0, 300);
    }
    if (!dto) {
      const failure = {
        ok: false, reason: 'fetch_failed', providerId: id, appType: provider.appType, strategy: target.strategy,
        ...(failureDetail ? { detail: failureDetail } : {}),
      };
      // The failure is still recorded as a failure (diagnostics only — the
      // cache's last good data survives), then the stale stand-in goes out.
      if (onResult) { try { onResult(provider.appType, id, failure); } catch (_) {} }
      return staleFallback(lookupCached, provider, target, id, failure) || failure;
    }
    const fetchedAt = now();
    const success = { ok: true, providerId: id, appType: provider.appType, strategy: target.strategy, dto,
      bar: quotaBarFor(target.strategy, dto, fetchedAt), fetchedAt };
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

// ── 借道余量查询端点（出借方）──────────────────────────────────────────────
//
//   GET/POST /claude-proxy/:id/remote/quota
//   GET/POST /codex-proxy/:id/quota
//
// 供导入借道 provider 的另一台 multicc 透传调用（对端适配器见 usage-limit-poller
// 的 pollRelayQuota）。鉴权不在这一层：请求先经过 auth 中间件的借道凭据校验
// （x-api-key / Bearer mcr1.*，src/routes/auth.js isProxyRelayRequest），到达
// 这里即代表这条 share 对该 provider 有效且未撤销，访问计数也已 +1。
//
// 语义：每次收到请求都触发一次对厂商的真实余量查询（queryOne 直达适配器，
// 不经过任何 TTL 缓存），异步等待查询完成后返回最新 DTO；查询失败返回
// ok:false，绝不伪造。并发去重：同一 provider 的并发查询共享一次真实请求，
// 避免多台借用方同时刷新时重复打厂商端点。
//
// 挂载顺序（见 server.js）：必须在 mountProtocolProxies 之前注册——协议代理
// 同样挂在这些路径前缀下，后注册的精确路由可能被遮蔽。
const RELAY_QUOTA_ROUTES = Object.freeze([
  { appType: 'claude', path: '/claude-proxy/:id/remote/quota' },
  { appType: 'codex', path: '/codex-proxy/:id/quota' },
]);

function mountProviderRelayQuotaRoutes(app, options = {}) {
  if (!app || typeof app.get !== 'function') return null;
  // lookupCached is blanked out on purpose: the lender side must answer with a
  // real query result or an explicit ok:false, so the "never fabricate" contract
  // is enforced here rather than left to how the caller wires the options.
  const runtime = options.runtime
    || createProviderBalanceRuntime({ ...options, lookupCached: null });
  const inflight = new Map();
  const relayQuotaResult = (appType, id) => {
    const key = `${appType}:${id}`;
    if (inflight.has(key)) return inflight.get(key);
    const promise = (async () => {
      try {
        return await runtime.queryOne(appType, id);
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, promise);
    return promise;
  };
  for (const { appType, path } of RELAY_QUOTA_ROUTES) {
    const handler = async (req, res) => {
      res.set('Cache-Control', 'no-store');
      try {
        const result = await relayQuotaResult(appType, req.params.id);
        if (result && result.reason === 'not_found') return res.status(404).json(result);
        return res.json(result);
      } catch (_) {
        return res.status(500).json({ ok: false, reason: 'fetch_failed' });
      }
    };
    app.get(path, handler);
    if (typeof app.post === 'function') app.post(path, handler);
  }
  return runtime;
}

module.exports = {
  createProviderBalanceRuntime,
  mountProviderBalanceRoutes,
  mountProviderRelayQuotaRoutes,
  pollKimiBalance,
  DEFAULT_ADAPTERS,
};
