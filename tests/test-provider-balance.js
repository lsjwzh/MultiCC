'use strict';

// Explicit provider balance queries (manage page): one provider at a time and
// all at once. These pin the contract the UI renders from — "no balance API"
// is a normal ok:false answer, a dead adapter is fetch_failed rather than a
// thrown 500, and the bulk endpoint reports one row per provider.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createProviderBalanceRuntime,
  mountProviderBalanceRoutes,
  mountProviderRelayQuotaRoutes,
  pollKimiBalance,
  DEFAULT_ADAPTERS,
} = require('../src/routes/provider-balance');

const PROVIDERS = [
  { id: 'ds-1', appType: 'claude', name: 'DeepSeek' },
  { id: 'glm-1', appType: 'claude', name: 'GLM' },
  { id: 'codex-glm', appType: 'codex', name: 'GLM via Codex' },
  { id: 'plain-1', appType: 'claude', name: 'NoQuota' },
  { id: 'codex-official', appType: 'codex', name: 'OpenAI Official' },
];

const TARGETS = {
  'ds-1': { providerId: 'ds-1', appType: 'claude', host: 'api.deepseek.com', apiKey: 'k', strategy: 'deepseek-balance' },
  'glm-1': { providerId: 'glm-1', appType: 'claude', host: 'open.bigmodel.cn', apiKey: 'k', strategy: 'glm-monitor' },
  'codex-glm': { providerId: 'codex-glm', appType: 'codex', host: 'open.bigmodel.cn', apiKey: 'k', strategy: 'glm-monitor' },
  'codex-official': { providerId: 'codex-official', appType: 'codex', host: 'chatgpt.com', apiKey: null, keyHashSeed: 'codex-oauth', strategy: 'codex-oauth-usage' },
};

// `cached` stands in for provider-limit-cache: keys are `<appType>:<id>` (the
// same composite identity the real cache uses). Every runtime here is wired
// with a lookupCached, like the server's mountProviderBalanceRoutes is.
function harness({ adapters, fail = [], throwOn = [], cached = {}, lookupThrows = false } = {}) {
  const seen = [];
  const recorded = [];
  const runtime = createProviderBalanceRuntime({
    lookupCached: (appType, id) => {
      if (lookupThrows) throw new Error('cache exploded');
      return cached[`${appType}:${id}`] || null;
    },
    onResult: (appType, id, result) => { recorded.push({ appType, id, result }); },
    getProvider: (appType, id) => PROVIDERS.find(p => p.id === id && (!appType || p.appType === appType)) || null,
    listProviders: () => PROVIDERS,
    getProviderLimitTarget: (appType, id) => TARGETS[id] || null,
    adapters: adapters || {
      'deepseek-balance': async (target) => {
        seen.push(target.providerId);
        if (throwOn.includes(target.providerId)) throw new Error('boom');
        if (fail.includes(target.providerId)) return null;
        return { kind: 'balance', available: true, currency: 'CNY', total: 12.5, granted: 0, toppedUp: 12.5 };
      },
      'glm-monitor': async (target) => {
        seen.push(target.providerId);
        if (throwOn.includes(target.providerId)) throw new Error('boom');
        if (fail.includes(target.providerId)) return null;
        return { kind: 'window', provider: 'glm', rateLimitType: 'five_hour', status: 'allowed', utilization: 0.42, resetsAt: null, weeklyUtilization: 0.1 };
      },
      'codex-oauth-usage': async () => ({ kind: 'window', rateLimitType: 'weekly', status: 'allowed', utilization: 0.77, resetsAt: 1_700_003_600, tier: 'pro' }),
    },
  });
  return { runtime, seen, recorded };
}

// A last-known-good entry as provider-limit-cache stores one: the structured
// summary the clients dispatch on plus the bar text with its {cd:} tokens.
const CACHED_WINDOW = {
  'claude:glm-1': {
    appType: 'claude', providerId: 'glm-1', kind: 'window', status: 'ok',
    summary: { kind: 'window', provider: 'glm', status: 'allowed', usedPercentage: 58, resetsAtMs: 1_700_003_600_000, observedAtMs: 1_700_000_000_000 },
    summaryText: '5h 58%', barText: '5h 58% {cd:1700003600000} ⟳',
    fetchedAt: 1_700_000_000_000, lastError: null,
  },
  'claude:ds-1': {
    appType: 'claude', providerId: 'ds-1', kind: 'balance', status: 'ok',
    summary: { kind: 'balance', provider: 'deepseek', available: 87.69, total: 100, currency: 'CNY' },
    summaryText: '¥87.69', barText: 'DeepSeek 余额 · ¥87.69 · {ago:1700000000000}',
    fetchedAt: 1_700_000_000_000, lastError: null,
  },
};

test('queryOne resolves a pollable provider to its adapter DTO', async () => {
  const h = harness();
  const result = await h.runtime.queryOne('claude', 'ds-1');
  assert.equal(result.ok, true);
  assert.equal(result.strategy, 'deepseek-balance');
  assert.equal(result.dto.kind, 'balance');
  assert.equal(result.dto.total, 12.5);
});

test('Codex-compatible GLM provider renders GLM windows, not the host Codex account', async () => {
  const result = await harness().runtime.queryOne('codex', 'codex-glm');
  assert.equal(result.ok, true);
  assert.equal(result.dto.provider, 'glm');
  assert.match(result.bar.text, /^5h 58%/);
  assert.doesNotMatch(result.bar.text, /^1wk /);
});

test('queryOne on an unknown provider reports not_found', async () => {
  const h = harness();
  const result = await h.runtime.queryOne('claude', 'missing');
  assert.deepEqual(result, { ok: false, reason: 'not_found' });
});

test('a provider without a pollable surface is unsupported, not an error', async () => {
  const h = harness();
  const result = await h.runtime.queryOne('claude', 'plain-1');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unsupported');
});

test('an adapter returning null reads as fetch_failed', async () => {
  const h = harness({ fail: ['ds-1'] });
  const result = await h.runtime.queryOne('claude', 'ds-1');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'fetch_failed');
  assert.equal(result.strategy, 'deepseek-balance');
});

test('a throwing adapter never escapes as a 500, and its cause is surfaced', async () => {
  const h = harness({ throwOn: ['ds-1'] });
  const result = await h.runtime.queryOne('claude', 'ds-1');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'fetch_failed');
  // The generic Error('boom') has no .detail, but its message must survive.
  assert.equal(result.detail, 'boom');
  // A limit_fetch_failed from the poller layer carries the layered root cause.
  const h2 = harness({ adapters: {
    'deepseek-balance': async () => {
      const error = new Error('limit fetch failed: HTTP 401 denied');
      error.kind = 'limit_fetch_failed';
      error.detail = 'HTTP 401 denied';
      throw error;
    },
  } });
  const result2 = await h2.runtime.queryOne('claude', 'ds-1');
  assert.equal(result2.reason, 'fetch_failed');
  assert.equal(result2.detail, 'HTTP 401 denied');
});

// ── last-known-good fallback (transient failures only) ──────────────────────
//
// A borrowed (借道) provider's live query crosses the network to the lender on
// every request, so it fails far more often than a local vendor API. The cache
// keeps the last bar that DID answer; serving it — clearly marked stale — is
// what keeps the bar on a freshly loaded page instead of vanishing.

test('a transient failure answers with the last-known-good bar, marked stale', async () => {
  const h = harness({ fail: ['glm-1'], cached: CACHED_WINDOW });
  const result = await h.runtime.queryOne('claude', 'glm-1');
  assert.equal(result.ok, true);
  assert.equal(result.cached, true);
  assert.equal(result.stale, true);
  assert.equal(result.detail, undefined);
  // The species survives: clients dispatch on dto.kind (window bar vs chip).
  assert.equal(result.dto.kind, 'window');
  assert.equal(result.dto.usedPercentage, 58);
  assert.equal(result.fetchedAt, 1_700_000_000_000);
  // The stored text keeps its own deadline token; the sync stamp is added
  // because this render has none.
  assert.equal(result.bar.text, '5h 58% {cd:1700003600000} ⟳ · 上次同步 {ago:1700000000000}');
  assert.equal(result.bar.color, '#8b949e');
  assert.match(result.bar.title, /实时查询失败/);
  assert.equal(result.bar.action, null);
});

test('a stale balance chip comes back as a balance dto, not a window', async () => {
  const h = harness({ fail: ['ds-1'], cached: CACHED_WINDOW });
  const result = await h.runtime.queryOne('claude', 'ds-1');
  assert.equal(result.ok, true);
  assert.equal(result.cached, true);
  assert.equal(result.dto.kind, 'balance');
  // This stored render already carries its own sync time — never two of them.
  assert.equal(result.bar.text, 'DeepSeek 余额 · ¥87.69 · {ago:1700000000000}');
});

test('a stale fallback still records the FAILURE, never a fresh success', async () => {
  const h = harness({ fail: ['glm-1'], cached: CACHED_WINDOW });
  await h.runtime.queryOne('claude', 'glm-1');
  assert.equal(h.recorded.length, 1);
  const { appType, id, result } = h.recorded[0];
  assert.equal(appType, 'claude');
  assert.equal(id, 'glm-1');
  // ok:false is the contract that makes the recorder stamp lastError only —
  // passing the fallback (ok:true + dto) would re-date the cached data and make
  // a stale window look freshly fetched, and would defeat the cache's
  // never-overwrite-on-failure guarantee.
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'fetch_failed');
});

test('the failure detail is carried into the stale title', async () => {
  const h = harness({
    cached: CACHED_WINDOW,
    adapters: {
      'glm-monitor': async () => {
        const error = new Error('limit fetch failed: Connect Timeout');
        error.kind = 'limit_fetch_failed';
        error.detail = 'Connect Timeout';
        throw error;
      },
    },
  });
  const result = await h.runtime.queryOne('claude', 'glm-1');
  assert.equal(result.ok, true);
  assert.equal(result.cached, true);
  assert.equal(result.detail, 'Connect Timeout');
  assert.match(result.bar.title, /Connect Timeout/);
});

test('unsupported and never-answered providers get no fallback', async () => {
  // 'unsupported' is a permanent answer, not a transient one: a provider with no
  // quota surface must not resurrect an unrelated cached bar. (plain-1 has no
  // entry either, and neither does the failing ds-1 below.)
  const noSurface = await harness({ cached: { 'claude:plain-1': CACHED_WINDOW['claude:glm-1'] } })
    .runtime.queryOne('claude', 'plain-1');
  assert.equal(noSurface.ok, false);
  assert.equal(noSurface.reason, 'unsupported');

  const neverAnswered = await harness({ fail: ['ds-1'] }).runtime.queryOne('claude', 'ds-1');
  assert.equal(neverAnswered.ok, false);
  assert.equal(neverAnswered.reason, 'fetch_failed');
});

test('a cache lookup that throws leaves the plain failure intact', async () => {
  const h = harness({ fail: ['glm-1'], cached: CACHED_WINDOW, lookupThrows: true });
  const result = await h.runtime.queryOne('claude', 'glm-1');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'fetch_failed');
});

test('only window / balance entries are served as fallbacks', async () => {
  // 'claude' (usage scrape) and 'availability' (cooldown) entries are other
  // producers' business — they carry no dto the balance clients could use.
  for (const kind of ['claude', 'availability', 'quota']) {
    const h = harness({
      fail: ['glm-1'],
      cached: { 'claude:glm-1': { ...CACHED_WINDOW['claude:glm-1'], kind, summary: { kind, status: 'ok' } } },
    });
    const result = await h.runtime.queryOne('claude', 'glm-1');
    assert.equal(result.ok, false, kind);
    assert.equal(result.reason, 'fetch_failed', kind);
  }
});

test('queryAll carries the stale fallback into its per-provider rows', async () => {
  const h = harness({ fail: ['glm-1'], cached: CACHED_WINDOW });
  const all = await h.runtime.queryAll();
  const row = all.results.find(r => r.providerId === 'glm-1');
  assert.equal(row.ok, true);
  assert.equal(row.cached, true);
  assert.equal(row.name, 'GLM');
});

test('queryAll reports one row per provider, including unpollable ones', async () => {
  const h = harness();
  const all = await h.runtime.queryAll();
  assert.equal(all.ok, true);
  assert.equal(all.results.length, PROVIDERS.length);
  const byId = Object.fromEntries(all.results.map(r => [r.providerId, r]));
  assert.equal(byId['ds-1'].ok, true);
  assert.equal(byId['ds-1'].name, 'DeepSeek');
  assert.equal(byId['glm-1'].dto.utilization, 0.42);
  assert.equal(byId['codex-official'].dto.rateLimitType, 'weekly');
  assert.match(byId['codex-official'].bar.text, /\{cd:1700003600000\}/,
    'epoch seconds are converted to milliseconds exactly once');
  assert.match(byId['codex-official'].bar.title, /套餐: pro/);
  assert.match(byId['codex-official'].bar.title, /剩余 23%/);
  assert.equal(byId['plain-1'].ok, false);
  assert.equal(byId['plain-1'].reason, 'unsupported');
});

test('queryAll runs providers in parallel, not serially', async () => {
  let active = 0;
  let maxActive = 0;
  const adapters = {
    'deepseek-balance': async () => new Promise(resolve => {
      active += 1; maxActive = Math.max(maxActive, active);
      setTimeout(() => { active -= 1; resolve({ kind: 'balance', total: 1 }); }, 20);
    }),
    'glm-monitor': async () => ({ kind: 'window', utilization: 0 }),
    'codex-oauth-usage': async () => ({ kind: 'window', utilization: 0 }),
  };
  const h = harness({ adapters });
  await h.runtime.queryAll();
  assert.ok(maxActive >= 1, 'at least the pollable adapters ran');
});

test('pollKimiBalance normalizes the kimi shape into a balance DTO', async () => {
  const fakeFetch = async () => ({ available: 3.21, voucher: 1, cash: 2.21, currency: 'CNY' });
  const dto = await pollKimiBalance({ host: 'api.moonshot.cn', apiKey: 'k' }, Date.now(), 1000, fakeFetch);
  assert.deepEqual(dto, { kind: 'balance', available: 3.21, voucher: 1, cash: 2.21, currency: 'CNY' });

  // Fetcher failure now throws a limit_fetch_failed carrying the kimi reason,
  // so the route layer can surface the root cause instead of bare fetch_failed.
  await assert.rejects(
    pollKimiBalance({}, Date.now(), 1000, async () => ({ error: true, httpStatus: 401, reason: 'auth_rejected' })),
    (error) => error.kind === 'limit_fetch_failed' && /auth_rejected/.test(error.detail) && /HTTP 401/.test(error.detail),
  );
  const noMoney = await pollKimiBalance({}, Date.now(), 1000, async () => ({ voucher: 1 }));
  assert.equal(noMoney, null);
});

test('the default adapter table covers every strategy getProviderLimitTarget can emit', () => {
  assert.deepEqual(Object.keys(DEFAULT_ADAPTERS).sort(),
    ['codex-oauth-usage', 'deepseek-balance', 'glm-monitor', 'kimi-balance', 'relay-quota']);
});

test('the mounted routes answer the two endpoints', async () => {
  const routes = {};
  const app = { get: (path, handler) => { routes[path] = handler; } };
  const h = harness();
  mountProviderBalanceRoutes(app, { runtime: h.runtime });
  assert.ok(routes['/api/providers/balances']);
  assert.ok(routes['/api/providers/:appType/:id/balance']);

  let payload = null;
  let status = 200;
  const res = {
    json: (body) => { payload = body; },
    status: (code) => { status = code; return { json: (body) => { payload = body; } }; },
  };

  await routes['/api/providers/balances']({}, res);
  assert.equal(payload.ok, true);
  assert.equal(payload.results.length, PROVIDERS.length);

  await routes['/api/providers/:appType/:id/balance']({ params: { appType: 'claude', id: 'ds-1' } }, res);
  assert.equal(payload.ok, true);
  assert.equal(payload.dto.total, 12.5);

  await routes['/api/providers/:appType/:id/balance']({ params: { appType: 'claude', id: 'missing' } }, res);
  assert.equal(status, 404);
  assert.equal(payload.reason, 'not_found');
});

// ── 借道余量查询端点（出借方）：mountProviderRelayQuotaRoutes ────────────────

function relayHarness() {
  const routes = {};
  const app = {
    get: (path, handler) => { routes[`GET ${path}`] = handler; },
    post: (path, handler) => { routes[`POST ${path}`] = handler; },
  };
  const runtime = mountProviderRelayQuotaRoutes(app, {
    getProvider: (appType, id) => (id === 'glm' ? { id: 'glm', appType, name: 'GLM' } : null),
    listProviders: () => [],
    getProviderLimitTarget: (appType, id) => (id === 'glm'
      ? { providerId: id, appType, host: 'open.bigmodel.cn', apiKey: 'k', strategy: 'glm-monitor' }
      : null),
    adapters: {
      'glm-monitor': async () => ({ kind: 'window', rateLimitType: 'five_hour', status: 'allowed', utilization: 0.3, resetsAt: null }),
    },
  });
  const res = () => {
    const out = { statusCode: 200, headers: {}, body: null };
    out.set = (k, v) => { out.headers[k] = v; return out; };
    out.status = (code) => { out.statusCode = code; return out; };
    out.json = (body) => { out.body = body; return out; };
    return out;
  };
  return { routes, runtime, res };
}

test('relay quota routes answer both protocols with the fresh DTO', async () => {
  const h = relayHarness();
  for (const key of ['GET /claude-proxy/:id/remote/quota', 'POST /codex-proxy/:id/quota']) {
    assert.ok(h.routes[key], `${key} registered`);
    const r = h.res();
    await h.routes[key]({ params: { id: 'glm' } }, r);
    assert.equal(r.statusCode, 200, key);
    assert.equal(r.headers['Cache-Control'], 'no-store', key);
    assert.equal(r.body.ok, true, key);
    assert.equal(r.body.strategy, 'glm-monitor', key);
    assert.equal(r.body.dto.utilization, 0.3, key);
  }
});

test('relay quota: unknown provider 404, unpollable provider ok:false', async () => {
  const h = relayHarness();
  const missing = h.res();
  await h.routes['POST /claude-proxy/:id/remote/quota']({ params: { id: 'nope' } }, missing);
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.body.reason, 'not_found');

  // Provider exists but has no pollable surface → normal ok:false, not an error.
  const routes2 = {};
  const app2 = { get: (p, hdl) => { routes2[p] = hdl; }, post: (p, hdl) => { routes2[p] = hdl; } };
  mountProviderRelayQuotaRoutes(app2, {
    getProvider: () => ({ id: 'plain', appType: 'claude', name: 'Plain' }),
    listProviders: () => [],
    getProviderLimitTarget: () => null,
  });
  const unpollable = { statusCode: 200, headers: {}, body: null };
  unpollable.set = (k, v) => { unpollable.headers[k] = v; return unpollable; };
  unpollable.status = (code) => { unpollable.statusCode = code; return unpollable; };
  unpollable.json = (body) => { unpollable.body = body; return unpollable; };
  await routes2['/claude-proxy/:id/remote/quota']({ params: { id: 'plain' } }, unpollable);
  assert.equal(unpollable.statusCode, 200);
  assert.deepEqual(unpollable.body, { ok: false, reason: 'unsupported', providerId: 'plain', appType: 'claude' });
});

test('relay quota never serves the last-known-good cache, even if handed one', async () => {
  // The lender side is the one place a cached value must never appear: a
  // borrower asking "what does this account have left" has to receive the
  // result of a REAL query, or an explicit ok:false — never this host's stash.
  const routes = {};
  const app = { get: (p, hdl) => { routes[p] = hdl; }, post: (p, hdl) => { routes[p] = hdl; } };
  mountProviderRelayQuotaRoutes(app, {
    getProvider: (appType, id) => ({ id, appType, name: 'GLM' }),
    listProviders: () => [],
    getProviderLimitTarget: (appType, id) => ({ providerId: id, appType, strategy: 'glm-monitor' }),
    adapters: { 'glm-monitor': async () => null },
    lookupCached: () => CACHED_WINDOW['claude:glm-1'],
  });
  const r = { statusCode: 200, body: null };
  r.set = () => r; r.status = c => { r.statusCode = c; return r; }; r.json = b => { r.body = b; return r; };
  await routes['/claude-proxy/:id/remote/quota']({ params: { id: 'glm' } }, r);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.reason, 'fetch_failed');
  assert.equal(r.body.cached, undefined);
});

test('relay quota dedups concurrent queries for the same provider', async () => {
  const order = [];
  const routes = {};
  const app = { get: (p, hdl) => { routes[p] = hdl; }, post: (p, hdl) => { routes[p] = hdl; } };
  mountProviderRelayQuotaRoutes(app, {
    getProvider: (appType, id) => ({ id, appType, name: 'GLM' }),
    listProviders: () => [],
    getProviderLimitTarget: (appType, id) => ({ providerId: id, appType, strategy: 'glm-monitor' }),
    adapters: {
      'glm-monitor': () => new Promise(resolve => {
        order.push('start');
        setTimeout(() => { order.push('end'); resolve({ kind: 'window', utilization: 0.1 }); }, 30);
      }),
    },
  });
  const mk = () => {
    const r = { statusCode: 200, body: null };
    r.set = () => r; r.status = c => { r.statusCode = c; return r; }; r.json = b => { r.body = b; return r; };
    return r;
  };
  const [a, b] = await Promise.all([
    routes['/claude-proxy/:id/remote/quota']({ params: { id: 'glm' } }, mk()),
    routes['/codex-proxy/:id/quota']({ params: { id: 'claude' } }, mk()),
  ]);
  // Different provider ids → two separate real queries (claude vs glm key).
  assert.equal(a.body.ok, true);
  assert.equal(b.body.ok, true);
  assert.deepEqual(order, ['start', 'start', 'end', 'end']);

  // Same provider twice concurrently → exactly one adapter run.
  let runs = 0;
  const routes3 = {};
  const app3 = { get: (p, hdl) => { routes3[p] = hdl; }, post: (p, hdl) => { routes3[p] = hdl; } };
  mountProviderRelayQuotaRoutes(app3, {
    getProvider: (appType, id) => ({ id, appType, name: 'GLM' }),
    listProviders: () => [],
    getProviderLimitTarget: (appType, id) => ({ providerId: id, appType, strategy: 'glm-monitor' }),
    adapters: {
      'glm-monitor': () => new Promise(resolve => {
        runs += 1;
        setTimeout(() => resolve({ kind: 'window', utilization: 0.2 }), 30);
      }),
    },
  });
  const [c, d] = await Promise.all([
    routes3['/claude-proxy/:id/remote/quota']({ params: { id: 'glm' } }, mk()),
    routes3['/claude-proxy/:id/remote/quota']({ params: { id: 'glm' } }, mk()),
  ]);
  assert.equal(runs, 1, 'one shared real query for the same provider');
  assert.equal(c.body.ok, true);
  assert.equal(d.body.ok, true);
});
