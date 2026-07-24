'use strict';

const assert = require('assert');
const { test } = require('node:test');
const poller = require('../src/usage-limit-poller');

// Swap global fetch with a scripted stub for the duration of one call.
async function withFetch(handler, fn) {
  const orig = global.fetch;
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return handler(url, opts, calls.length);
  };
  try { return await fn(calls); } finally { global.fetch = orig; }
}

function okJson(obj) {
  return { ok: true, status: 200, json: async () => obj };
}

test('GLM adapter maps first TOKENS_LIMIT to five_hour window utilization', async () => {
  await withFetch(
    (url, opts) => {
      assert.ok(url.includes('/api/monitor/usage/quota/limit'), 'hits monitor endpoint');
      assert.strictEqual(opts.headers.Authorization, 'raw-key-no-bearer', 'raw key, no Bearer');
      return okJson({
        code: 200, success: true,
        data: { level: 'pro', limits: [
          { type: 'TIME_LIMIT', percentage: 7, usage: 1000 },
          { type: 'TOKENS_LIMIT', percentage: 44, nextResetTime: 1_800_000_000_000 },
          { type: 'TOKENS_LIMIT', percentage: 53 },
        ] },
      });
    },
    async () => {
      const dto = await poller.pollGlmMonitor({ host: 'open.bigmodel.cn', apiKey: 'raw-key-no-bearer', strategy: 'glm-monitor' }, 0);
      assert.strictEqual(dto.kind, 'window');
      assert.strictEqual(dto.rateLimitType, 'five_hour');
      assert.strictEqual(dto.status, 'allowed');
      assert.ok(Math.abs(dto.utilization - 0.44) < 1e-9, 'utilization = 44%');
      assert.strictEqual(dto.resetsAt, 1_800_000_000_000);
      assert.strictEqual(dto.tier, 'pro');
    },
  );
});

test('GLM adapter: warning >=80%, rejected >=100%', async () => {
  const mk = (pct) => withFetch(
    () => okJson({ data: { limits: [{ type: 'TOKENS_LIMIT', percentage: pct }] } }),
    () => poller.pollGlmMonitor({ host: 'open.bigmodel.cn', apiKey: 'k' }, 0),
  );
  assert.strictEqual((await mk(85)).status, 'allowed_warning');
  assert.strictEqual((await mk(100)).status, 'rejected');
});

test('GLM adapter tolerates shape drift → null (never throws)', async () => {
  const nullCases = [
    () => okJson({ nope: true }),
    () => okJson({ data: { limits: [{ type: 'TIME_LIMIT', percentage: 5 }] } }), // no TOKENS_LIMIT
    () => okJson({ data: { limits: 'not-an-array' } }),
    () => ({ ok: false, status: 401, json: async () => ({}) }),
  ];
  for (const h of nullCases) {
    await withFetch(h, async () => {
      const dto = await poller.pollGlmMonitor({ host: 'open.bigmodel.cn', apiKey: 'k' }, 0);
      assert.strictEqual(dto, null);
    });
  }
});

test('DeepSeek adapter maps prepaid balance with Bearer auth', async () => {
  await withFetch(
    (url, opts) => {
      assert.ok(url.endsWith('/user/balance'));
      assert.strictEqual(opts.headers.Authorization, 'Bearer ds-key');
      return okJson({
        is_available: true,
        balance_infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }],
      });
    },
    async () => {
      const dto = await poller.pollDeepseekBalance({ host: 'api.deepseek.com', apiKey: 'ds-key', strategy: 'deepseek-balance' }, 0);
      assert.deepStrictEqual(dto, { kind: 'balance', available: true, currency: 'CNY', total: 110, granted: 10, toppedUp: 100 });
    },
  );
});

test('DeepSeek adapter: exhausted balance surfaces available:false', async () => {
  await withFetch(
    () => okJson({ is_available: false, balance_infos: [{ currency: 'USD', total_balance: '0.00' }] }),
    async () => {
      const dto = await poller.pollDeepseekBalance({ host: 'api.deepseek.com', apiKey: 'k' }, 0);
      assert.strictEqual(dto.available, false);
      assert.strictEqual(dto.total, 0);
    },
  );
});

test('poller dedups by (provider,key): concurrent turns → one fetch; TTL caps staleness', async () => {
  let clock = 1000;
  const target = { providerId: 'glm-1', appType: 'codex', host: 'open.bigmodel.cn', apiKey: 'shared-key', strategy: 'glm-monitor' };
  await withFetch(
    () => okJson({ data: { limits: [{ type: 'TOKENS_LIMIT', percentage: 10 }] } }),
    async (calls) => {
      const broadcasts = [];
      const p = poller.createUsageLimitPoller({
        resolveTarget: () => target,
        broadcast: (sid, dto) => broadcasts.push({ sid, dto }),
        now: () => clock,
      });
      // Two sessions on the same account fire concurrently at a turn boundary.
      await Promise.all([p.onTurnComplete('sess-A'), p.onTurnComplete('sess-B')]);
      assert.strictEqual(calls.length, 1, 'shared in-flight request → exactly one fetch');
      assert.strictEqual(broadcasts.length, 2, 'both sessions get a broadcast');
      assert.strictEqual(broadcasts[0].dto.utilization, 0.1);

      // Within TTL → served from cache, no new fetch.
      clock += 30_000;
      await p.onTurnComplete('sess-A');
      assert.strictEqual(calls.length, 1, 'still one fetch inside TTL');

      // Past TTL → one refresh.
      clock += 40_000; // now 70s > 60s glm TTL
      await p.onTurnComplete('sess-A');
      assert.strictEqual(calls.length, 2, 'refetched after TTL expiry');
    },
  );
});

test('poller: non-pollable target → no fetch, no broadcast', async () => {
  await withFetch(
    () => { throw new Error('should not be called'); },
    async (calls) => {
      const broadcasts = [];
      const p = poller.createUsageLimitPoller({
        resolveTarget: () => null,           // e.g. Qoder/ZCode/unknown host
        broadcast: (sid, dto) => broadcasts.push({ sid, dto }),
        now: () => 0,
      });
      await p.onTurnComplete('sess-X');
      assert.strictEqual(calls.length, 0);
      assert.strictEqual(broadcasts.length, 0);
    },
  );
});

test('poller: adapter failure caches null briefly (no per-turn hammering)', async () => {
  let clock = 0;
  const target = { providerId: 'glm-2', host: 'open.bigmodel.cn', apiKey: 'k', strategy: 'glm-monitor' };
  await withFetch(
    () => ({ ok: false, status: 500, json: async () => ({}) }),
    async (calls) => {
      const p = poller.createUsageLimitPoller({
        resolveTarget: () => target,
        broadcast: () => {},
        now: () => clock,
      });
      await p.onTurnComplete('s1');
      await p.onTurnComplete('s1'); // immediate retry within TTL
      assert.strictEqual(calls.length, 1, 'null result cached → not refetched every turn');
    },
  );
});
