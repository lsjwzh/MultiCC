'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  fetchZhipuUsage,
  siteLabel,
  mountZhipuQuotaRoutes,
} = require('../src/routes/zhipu-quota');
const {
  formatZhipuQuota,
  isZhipuBaseUrl,
} = require('../public/chat-rate-limit');

const ZAI = { host: 'api.z.ai', apiKey: 'k1', strategy: 'glm-monitor' };
const BIG = { host: 'open.bigmodel.cn', apiKey: 'k2', strategy: 'glm-monitor' };

test('siteLabel distinguishes the two official Zhipu sites', () => {
  assert.equal(siteLabel('api.z.ai'), 'Z.ai');
  assert.equal(siteLabel('z.ai'), 'Z.ai');
  assert.equal(siteLabel('open.bigmodel.cn'), 'BigModel');
  assert.equal(siteLabel('bigmodel.cn'), 'BigModel');
  assert.equal(siteLabel(''), 'BigModel');
});

test('fetchZhipuUsage reports not_configured when no targets exist', async () => {
  const result = await fetchZhipuUsage('', 1000, { targets: [], poll: async () => null });
  assert.equal(result.status, 'not_configured');
});

test('fetchZhipuUsage maps poller DTOs to a multi-site ok response', async () => {
  const poll = async (t) => (t.host === 'api.z.ai'
    ? { status: 'allowed', utilization: 0.123456, resetsAt: 2000, tier: 'lite' }
    : { status: 'allowed_warning', utilization: 0.876543, resetsAt: 3000, tier: 'pro' });
  const result = await fetchZhipuUsage('', 1000, { targets: [ZAI, BIG], poll });
  assert.equal(result.status, 'ok');
  assert.equal(result.fetchedAt, 1000);
  assert.equal(result.sites.length, 2);
  const zai = result.sites.find((s) => s.host === 'api.z.ai');
  assert.equal(zai.site, 'Z.ai');
  assert.equal(zai.ok, true);
  assert.equal(zai.usedPercent, 12.346);
  assert.equal(zai.windowStatus, 'allowed');
  assert.equal(zai.resetsAt, 2000);
  assert.equal(zai.tier, 'lite');
});

test('fetchZhipuUsage orders the preferred host first', async () => {
  const poll = async () => ({ status: 'allowed', utilization: 0.5, resetsAt: 1, tier: null });
  const result = await fetchZhipuUsage('open.bigmodel.cn', 1, { targets: [ZAI, BIG], poll });
  assert.equal(result.sites[0].host, 'open.bigmodel.cn');
});

test('fetchZhipuUsage is unavailable when every site fails', async () => {
  const result = await fetchZhipuUsage('', 1, {
    targets: [ZAI, BIG],
    poll: async () => { throw new Error('boom'); },
  });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.sites.every((s) => s.ok === false), true);
});

test('route maps status to HTTP code', async () => {
  const routes = {};
  const app = { get: (path, handler) => { routes[path] = handler; } };
  mountZhipuQuotaRoutes(app);
  assert.equal(typeof routes['/api/zhipu/quota'], 'function');

  // Drive the handler with a stubbed fetch by monkeypatching through deps is not
  // possible here (handler closes over the real fetch), so assert the wiring and
  // the not_configured path which needs no network when no provider is configured.
  const captured = {};
  const res = {
    status(code) { captured.code = code; return this; },
    json(body) { captured.body = body; return this; },
  };
  await routes['/api/zhipu/quota']({ query: {} }, res);
  // In the test environment no Zhipu provider is configured, or the live fetch
  // fails closed; either way it must not be a 200 ok with empty sites.
  assert.ok([404, 502, 500].includes(captured.code), `unexpected code ${captured.code}`);
  assert.ok(captured.body && typeof captured.body.status === 'string');
});

test('isZhipuBaseUrl gates on z.ai / bigmodel.cn hosts only', () => {
  assert.equal(isZhipuBaseUrl('https://api.z.ai/api/paas/v4'), true);
  assert.equal(isZhipuBaseUrl('https://open.bigmodel.cn/api/paas/v4'), true);
  assert.equal(isZhipuBaseUrl('https://ark.cn-beijing.volces.com/api/v3'), false);
  assert.equal(isZhipuBaseUrl('https://api.anthropic.com'), false);
  assert.equal(isZhipuBaseUrl(''), false);
  assert.equal(isZhipuBaseUrl('not a url'), false);
});

test('formatZhipuQuota renders idle, not_configured and ok states', () => {
  const idle = formatZhipuQuota(null);
  assert.match(idle.text, /Zhipu 余量/);
  assert.equal(idle.color, '#8b949e');

  const none = formatZhipuQuota({ status: 'not_configured' });
  assert.match(none.text, /未配置/);

  const ok = formatZhipuQuota({
    status: 'ok',
    fetchedAt: Date.now(),
    sites: [
      { host: 'api.z.ai', site: 'Z.ai', ok: true, usedPercent: 12.3456, resetsAt: null, tier: 'lite' },
      { host: 'open.bigmodel.cn', site: 'BigModel', ok: true, usedPercent: 91.5, resetsAt: null, tier: 'pro' },
    ],
  });
  // 2-decimal display, trailing zeros dropped.
  assert.match(ok.text, /Z\.ai 12\.35%/);
  assert.match(ok.text, /BigModel 91\.5%/);
  // >=90% trips the red color.
  assert.equal(ok.color, '#f85149');
});

test('formatZhipuQuota falls back to unavailable when no site has data', () => {
  const view = formatZhipuQuota({ status: 'ok', fetchedAt: Date.now(), sites: [{ host: 'api.z.ai', site: 'Z.ai', ok: false }] });
  assert.match(view.text, /暂不可用/);
});
