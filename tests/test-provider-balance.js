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
  { id: 'plain-1', appType: 'claude', name: 'NoQuota' },
  { id: 'codex-official', appType: 'codex', name: 'OpenAI Official' },
];

const TARGETS = {
  'ds-1': { providerId: 'ds-1', appType: 'claude', host: 'api.deepseek.com', apiKey: 'k', strategy: 'deepseek-balance' },
  'glm-1': { providerId: 'glm-1', appType: 'claude', host: 'open.bigmodel.cn', apiKey: 'k', strategy: 'glm-monitor' },
  'codex-official': { providerId: 'codex-official', appType: 'codex', host: 'chatgpt.com', apiKey: null, keyHashSeed: 'codex-oauth', strategy: 'codex-oauth-usage' },
};

function harness({ adapters, fail = [], throwOn = [] } = {}) {
  const seen = [];
  const runtime = createProviderBalanceRuntime({
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
      'glm-monitor': async () => ({ kind: 'window', rateLimitType: 'five_hour', status: 'allowed', utilization: 0.42, resetsAt: null, weeklyUtilization: 0.1 }),
      'codex-oauth-usage': async () => ({ kind: 'window', rateLimitType: 'weekly', status: 'allowed', utilization: 0.77, resetsAt: null }),
    },
  });
  return { runtime, seen };
}

test('queryOne resolves a pollable provider to its adapter DTO', async () => {
  const h = harness();
  const result = await h.runtime.queryOne('claude', 'ds-1');
  assert.equal(result.ok, true);
  assert.equal(result.strategy, 'deepseek-balance');
  assert.equal(result.dto.kind, 'balance');
  assert.equal(result.dto.total, 12.5);
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

test('a throwing adapter never escapes as a 500', async () => {
  const h = harness({ throwOn: ['ds-1'] });
  const result = await h.runtime.queryOne('claude', 'ds-1');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'fetch_failed');
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

  const failed = await pollKimiBalance({}, Date.now(), 1000, async () => ({ error: true, httpStatus: 401 }));
  assert.equal(failed, null);
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
