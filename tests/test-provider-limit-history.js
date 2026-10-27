'use strict';

// GET /api/providers/limit-history：参数边界、provider 过滤、内核不可用/失败时的降级。
// 这里用假 history 与假 app，不需要原生模块。

const test = require('node:test');
const assert = require('node:assert/strict');

const { mountProviderLimitHistoryRoutes, providerIdentities } = require('../src/routes/provider-limit-history');

function harness(overrides = {}) {
  const routes = new Map();
  const app = { get: (route, handler) => routes.set(route, handler) };
  const calls = [];
  const history = {
    available: () => overrides.available !== false,
    query: async payload => {
      calls.push(payload);
      if (overrides.fail) throw new Error('kernel exploded');
      return { providers: { 'claude:glm': { series: { '5h': { points: [[1, 2]] } } } } };
    },
  };
  const providers = overrides.providers || {
    listProviders: type => (type === 'claude'
      ? [{ id: 'glm', appType: 'claude' }, { id: 'deepseek', appType: 'claude' }]
      : [{ id: 'codex-official', appType: 'codex' }]),
  };
  const now = () => 10_000_000_000;
  mountProviderLimitHistoryRoutes(app, { history, providers, now });
  const invoke = async query => {
    const res = {
      statusCode: 200,
      headers: {},
      body: null,
      setHeader(name, value) { this.headers[name] = value; },
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    await routes.get('/api/providers/limit-history')({ query }, res);
    return res;
  };
  return { routes, calls, invoke, history, providers };
}

test('registers the documented route', () => {
  const { routes } = harness();
  assert.deepEqual([...routes.keys()], ['/api/providers/limit-history']);
});

test('defaults to 24 hours, 48 points and every provider', async () => {
  const { invoke, calls } = harness();
  const res = await invoke({});
  assert.equal(res.body.available, true);
  assert.equal(res.body.points, 48);
  assert.equal(res.body.sinceMs, 10_000_000_000 - 24 * 60 * 60 * 1000);
  assert.deepEqual(calls[0].providers.map(p => `${p.appType}:${p.providerId}`),
    ['claude:glm', 'claude:deepseek', 'codex:codex-official']);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.ok(res.body.providers['claude:glm']);
});

test('honours range, points caps and single-provider filters', async () => {
  const { invoke, calls } = harness();
  const res = await invoke({ range: '7d', points: '9999', appType: 'claude', id: 'glm' });
  assert.equal(res.body.sinceMs, 10_000_000_000 - 7 * 24 * 60 * 60 * 1000);
  assert.equal(res.body.points, 240);
  assert.deepEqual(calls[0].providers, [{ appType: 'claude', providerId: 'glm' }]);
});

test('explicit since wins and is bounded to the retention horizon', async () => {
  const { invoke, calls } = harness();
  const res = await invoke({ since: '123' });
  assert.equal(res.body.sinceMs, 10_000_000_000 - 90 * 24 * 60 * 60 * 1000);
  const recent = await invoke({ since: '9999999999' });
  assert.equal(recent.body.sinceMs, 9_999_999_999);
  assert.equal(calls.length, 2);
});

test('degrades to available:false without a native kernel', async () => {
  const { invoke } = harness({ available: false });
  const res = await invoke({});
  assert.equal(res.body.available, false);
  assert.equal(res.body.reason, 'unavailable');
  assert.deepEqual(res.body.providers, {});
});

test('a failing query is reported, not thrown', async () => {
  const { invoke } = harness({ fail: true });
  const res = await invoke({});
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.available, false);
  assert.equal(res.body.reason, 'query_failed');
  assert.match(res.body.error, /kernel exploded/);
});

test('providerIdentities ignores unknown app types', () => {
  const rows = providerIdentities(type => [{ id: `${type}-1` }], { appType: 'bogus', id: '' });
  assert.deepEqual(rows.map(row => row.appType), ['claude', 'codex']);
});
