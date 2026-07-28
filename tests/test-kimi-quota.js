'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  fetchKimiUsage,
  siteLabel,
  balanceHost,
  mountKimiQuotaRoutes,
} = require('../src/routes/kimi-quota');
const {
  formatKimiQuota,
  isKimiBaseUrl,
} = require('../public/chat-rate-limit');

const MOONSHOT = { host: 'api.moonshot.cn', apiKey: 'k1', strategy: 'kimi-balance' };
const KIMI = { host: 'api.kimi.com', apiKey: 'k2', strategy: 'kimi-balance' };

test('siteLabel distinguishes kimi vs moonshot hosts', () => {
  assert.equal(siteLabel('api.kimi.com'), 'Kimi');
  assert.equal(siteLabel('api.moonshot.cn'), 'Moonshot');
  assert.equal(siteLabel(''), 'Moonshot');
});

test('balanceHost routes rebrand inference hosts to the canonical billing host', () => {
  // api.kimi.com 404s on /v1/users/me/balance; the balance lives on api.moonshot.cn.
  assert.equal(balanceHost('api.kimi.com'), 'api.moonshot.cn');
  assert.equal(balanceHost('api.kimi.ai'), 'api.moonshot.cn');
  assert.equal(balanceHost('api.moonshot.com'), 'api.moonshot.cn');
  // A moonshot.cn provider stays on its own host.
  assert.equal(balanceHost('api.moonshot.cn'), 'api.moonshot.cn');
});

test('fetchKimiUsage reports not_configured when no targets exist', async () => {
  const result = await fetchKimiUsage('', 1000, { targets: [], poll: async () => null });
  assert.equal(result.status, 'not_configured');
});

test('fetchKimiUsage maps balance responses to a multi-site ok DTO', async () => {
  const poll = async (t) => (t.host === 'api.moonshot.cn'
    ? { available: 49.58894, voucher: 46.58893, cash: 3.00001, currency: 'CNY' }
    : { available: 12.34, voucher: null, cash: 12.34, currency: 'CNY' });
  const result = await fetchKimiUsage('', 1000, { targets: [MOONSHOT, KIMI], poll });
  assert.equal(result.status, 'ok');
  assert.equal(result.fetchedAt, 1000);
  assert.equal(result.sites.length, 2);
  const moon = result.sites.find((s) => s.host === 'api.moonshot.cn');
  assert.equal(moon.site, 'Moonshot');
  assert.equal(moon.ok, true);
  assert.equal(moon.available, 49.58894);
  assert.equal(moon.voucher, 46.58893);
  assert.equal(moon.cash, 3.00001);
  assert.equal(moon.currency, 'CNY');
});

test('fetchKimiUsage orders the preferred host first', async () => {
  const poll = async () => ({ available: 1, voucher: null, cash: 1, currency: 'CNY' });
  const result = await fetchKimiUsage('api.kimi.com', 1, { targets: [MOONSHOT, KIMI], poll });
  assert.equal(result.sites[0].host, 'api.kimi.com');
});

test('fetchKimiUsage is unavailable when every site fails', async () => {
  const result = await fetchKimiUsage('', 1, {
    targets: [MOONSHOT, KIMI],
    poll: async () => { throw new Error('boom'); },
  });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.sites.every((s) => s.ok === false), true);
});

test('route maps status to HTTP code', async () => {
  const routes = {};
  const app = { get: (path, handler) => { routes[path] = handler; } };
  mountKimiQuotaRoutes(app);
  assert.equal(typeof routes['/api/kimi/quota'], 'function');

  const captured = {};
  const res = {
    status(code) { captured.code = code; return this; },
    json(body) { captured.body = body; return this; },
  };
  await routes['/api/kimi/quota']({ query: {} }, res);
  // No Kimi provider configured in the test env (or live fetch fails closed):
  // either way it must not be a 200 ok with empty sites.
  assert.ok([404, 502, 500].includes(captured.code), `unexpected code ${captured.code}`);
  assert.ok(captured.body && typeof captured.body.status === 'string');
});

test('isKimiBaseUrl gates on moonshot/kimi hosts only', () => {
  assert.equal(isKimiBaseUrl('https://api.moonshot.cn/v1'), true);
  assert.equal(isKimiBaseUrl('https://api.kimi.com/v1'), true);
  assert.equal(isKimiBaseUrl('https://api.moonshot.com/v1'), true);
  assert.equal(isKimiBaseUrl('https://api.z.ai/api/paas/v4'), false);
  assert.equal(isKimiBaseUrl('https://api.anthropic.com'), false);
  assert.equal(isKimiBaseUrl(''), false);
  assert.equal(isKimiBaseUrl('not a url'), false);
});

test('formatKimiQuota renders idle, not_configured and ok money states', () => {
  const idle = formatKimiQuota(null);
  assert.match(idle.text, /Kimi 余量/);
  assert.equal(idle.color, '#8b949e');

  const none = formatKimiQuota({ status: 'not_configured' });
  assert.match(none.text, /未配置/);

  const ok = formatKimiQuota({
    status: 'ok',
    fetchedAt: Date.now(),
    sites: [
      { host: 'api.moonshot.cn', site: 'Moonshot', ok: true, available: 49.58894, voucher: 46.58893, cash: 3.00001, currency: 'CNY' },
    ],
  });
  // 2-decimal money display.
  assert.match(ok.text, /Moonshot ¥49\.59/);
  // Healthy balance is blue.
  assert.equal(ok.color, '#58a6ff');
});

test('formatKimiQuota colors low and zero balances as warnings', () => {
  const low = formatKimiQuota({
    status: 'ok', fetchedAt: Date.now(),
    sites: [{ host: 'api.moonshot.cn', site: 'Moonshot', ok: true, available: 3, voucher: null, cash: 3, currency: 'CNY' }],
  });
  assert.equal(low.color, '#d29922');

  const zero = formatKimiQuota({
    status: 'ok', fetchedAt: Date.now(),
    sites: [{ host: 'api.moonshot.cn', site: 'Moonshot', ok: true, available: 0, voucher: 0, cash: 0, currency: 'CNY' }],
  });
  assert.equal(zero.color, '#f85149');
});

test('formatKimiQuota falls back to unavailable when no site has data', () => {
  const view = formatKimiQuota({ status: 'ok', fetchedAt: Date.now(), sites: [{ host: 'api.moonshot.cn', site: 'Moonshot', ok: false }] });
  assert.match(view.text, /暂不可用/);
});

test('fetchKimiUsage propagates httpStatus and reason in failed sites', async () => {
  const result = await fetchKimiUsage('', 1, {
    targets: [KIMI],
    poll: async () => ({ error: true, httpStatus: 401, reason: 'auth_rejected' }),
  });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.sites[0].ok, false);
  assert.equal(result.sites[0].httpStatus, 401);
  assert.equal(result.sites[0].reason, 'auth_rejected');
});

test('formatKimiQuota shows cached value with stale indicator when fetch fails', () => {
  const cached = {
    status: 'ok', fetchedAt: Date.now() - 3600000,
    sites: [{ host: 'api.moonshot.cn', site: 'Moonshot', ok: true, available: 42.5, voucher: null, cash: 42.5, currency: 'CNY' }],
  };
  const view = formatKimiQuota({ status: 'unavailable', error: 'all kimi fetches failed', sites: [{ host: 'api.kimi.com', ok: false, reason: 'auth_rejected' }] }, cached);
  assert.match(view.text, /Moonshot ¥42\.5/);
  assert.match(view.text, /上次/);
  assert.match(view.title, /缓存值/);
  assert.match(view.title, /Kimi-for-Coding/);
});

test('formatKimiQuota shows specific reason for auth_rejected without cache', () => {
  const view = formatKimiQuota({ status: 'unavailable', sites: [{ host: 'api.kimi.com', ok: false, reason: 'auth_rejected' }] });
  assert.match(view.text, /暂不可用/);
  assert.match(view.title, /Kimi-for-Coding/);
});
