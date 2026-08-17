'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { mountQuotaBarRoutes, createQuotaBarRuntime } = require('../src/routes/quota-bars');
const { createQuotaBarCache } = require('../src/quota/quota-bar-cache');

function appHarness() {
  const handlers = new Map();
  return {
    app: {
      get(route, handler) { handlers.set(`GET ${route}`, handler); },
      post(route, handler) { handlers.set(`POST ${route}`, handler); },
    },
    async invoke(method, route, req = {}) {
      const handler = handlers.get(`${method} ${route}`);
      assert.equal(typeof handler, 'function', `missing ${method} ${route}`);
      const res = {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
      };
      await handler({ body: {}, query: {}, ...req }, res);
      return res;
    },
  };
}

function tmpCache() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-quota-bar-cache-test-'));
  return createQuotaBarCache({ file: path.join(dir, 'quota-bar-cache.json'), now: () => 1700000000000 });
}

function bar(kind) {
  return { text: `${kind} 50%`, color: '#58a6ff', title: `${kind} title`, action: null };
}

test('unified quota refresh fetches, renders and stores a server-side bar', async () => {
  const cache = tmpCache();
  const calls = [];
  const runtime = createQuotaBarRuntime({
    quotaBarCache: cache,
    fetchOpenCodeUsage: async () => {
      calls.push('opencode');
      return { status: 'ok', fetchedAt: 123, usage: { rolling: { usagePercent: 50 } } };
    },
    renderQuotaBar: (kind, value) => ({ ...bar(kind), title: String(value.fetchedAt) }),
  });

  const result = await runtime.refresh({ kind: 'opencode' });
  assert.equal(result.httpStatus, 200);
  assert.deepEqual(calls, ['opencode']);
  assert.equal(result.body.bar.text, 'opencode 50%');
  assert.equal(result.body.cached.bar.text, 'opencode 50%');
  assert.equal(cache.get('opencode').bar.text, 'opencode 50%');
});

test('unified quota refresh records provider-scoped vendor results when identity exists', async () => {
  const recorded = [];
  const runtime = createQuotaBarRuntime({
    fetchZhipuUsage: async (host) => ({ status: 'ok', fetchedAt: 456, host }),
    renderQuotaBar: (kind) => bar(kind),
    recordVendor: (entry) => recorded.push(entry),
  });

  const result = await runtime.refresh({ kind: 'zhipu', host: 'bigmodel.cn' });
  assert.equal(result.httpStatus, 200);
  assert.equal(result.body.bar.text, 'zhipu 50%');
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].kind, 'zhipu');
  assert.equal(recorded[0].host, 'bigmodel.cn');
});

test('quota bar routes expose idle, state and refresh without vendor URLs in the client contract', async () => {
  const cache = tmpCache();
  const h = appHarness();
  mountQuotaBarRoutes(h.app, {
    quotaBarCache: cache,
    fetchCodexUsage: async () => ({ status: 'ok', fetchedAt: 789 }),
    renderQuotaBar: (kind) => bar(kind),
  });

  let res = await h.invoke('GET', '/api/quota/bars/idle');
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.bars.codex);

  res = await h.invoke('POST', '/api/quota/bars/refresh', { body: { kind: 'codex' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.bar.text, 'codex 50%');

  res = await h.invoke('GET', '/api/quota/bars/state');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.bars.codex.bar.text, 'codex 50%');
});
