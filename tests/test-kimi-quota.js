'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  fetchKimiUsage,
  fetchKimiSubscriptionPage,
  summarizeSubscriptionText,
  subscriptionPanelReady,
  windowTokenForLabel,
  parseResetAfter,
  siteLabel,
  balanceHost,
  mountKimiQuotaRoutes,
} = require('../src/routes/kimi-quota');
const {
  formatKimiQuota,
  isKimiBaseUrl,
  formatQoderQuota,
  formatOpenCodeQuota,
  quotaBarClick,
  unifiedWindowSeg,
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
  const app = {
    get: (path, handler) => { routes[path] = handler; },
    post: (path, handler) => { routes[path] = handler; },
  };
  // console: null disables the membership-page fallback so this unit test
  // never spawns a managed Chrome.
  mountKimiQuotaRoutes(app, { usageDeps: { console: null } });
  assert.equal(typeof routes['/api/kimi/quota'], 'function');
  assert.equal(typeof routes['/api/kimi/quota/login'], 'function');

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
    // all-401 would otherwise fall back to the managed-browser scrape
    console: null,
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
  assert.match(view.text, /密钥不支持余额查询/);
  assert.match(view.title, /Kimi-for-Coding/);
});

test('formatKimiQuota shows cached balance even when no live value exists yet', () => {
  const cached = {
    status: 'ok', fetchedAt: Date.now() - 3600000,
    sites: [{ host: 'api.moonshot.cn', site: 'Moonshot', ok: true, available: 12.34, voucher: null, cash: 12.34, currency: 'CNY' }],
  };
  const view = formatKimiQuota(null, cached);
  assert.match(view.text, /Moonshot ¥12\.34/);
  assert.match(view.text, /上次/);
  assert.match(view.title, /缓存值/);
});

// ── subscription ("Kimi For Coding") membership-page fallback ─────────────

test('summarizeSubscriptionText picks percent lines with their nearest label', () => {
  const text = 'Kimi Code 会员\n5小时窗口\n12%\n周用量\n42.5%\n其他 99%';
  const sum = summarizeSubscriptionText(text);
  assert.equal(sum.length, 3);
  assert.deepEqual(sum[0], { window: '5h', label: '5小时窗口', usedPercent: 12, percent: 12, resetMs: null, line: '12%' });
  assert.deepEqual(sum[1], { window: '1wk', label: '周用量', usedPercent: 42.5, percent: 42.5, resetMs: null, line: '42.5%' });
  // The preceding line is itself a percentage value, so no label (and thus no
  // window token) for this one.
  assert.equal(sum[2].label, '');
  assert.equal(sum[2].window, null);
  assert.equal(sum[2].usedPercent, 99);
});

test('summarizeSubscriptionText returns null when there is no percentage', () => {
  assert.equal(summarizeSubscriptionText('请登录'), null);
  assert.equal(summarizeSubscriptionText(''), null);
});

// ── real-panel fixtures (sanitized structure observed on ?tab=quota, 2026-08) ──
// The sidebar renders first and already contains 订阅/额度 wording; the quota
// panel arrives seconds later with the percentages. Session titles are
// deliberately NOT part of this fixture.

const KIMI_SIDEBAR_TEXT = [
  '升级订阅',
  '权益额度将按月刷新',
  '订阅信息',
  '我的额度',
  '使用明细',
  '账单与发票',
].join('\n');

const KIMI_PANEL_TEXT = [
  '升级订阅',
  '权益额度将按月刷新',
  '下次自动续费时间：2026-08-19',
  '订阅信息',
  '我的额度',
  '使用明细',
  '账单与发票',
  '用量进度',
  '总使用量',
  '29.1%',
  'Kimi Code 2026-08-19 后重置',
  '5 小时用量',
  'Code',
  '1.31%',
  '08-04 06:28 后重置',
  '7 天用量',
  'Code',
  '4.59%',
  '08-10 21:28 后重置',
  '额度加油包 暂未开启',
].join('\n');

test('subscriptionPanelReady rejects the sidebar but accepts the real panel', () => {
  assert.equal(subscriptionPanelReady(KIMI_SIDEBAR_TEXT), false, 'sidebar words (订阅/额度) are not the panel');
  assert.equal(subscriptionPanelReady('电池 80%'), false, 'a stray percentage without panel markers is not the panel');
  assert.equal(subscriptionPanelReady('用量进度 暂无'), false, 'markers without any percentage are not the panel');
  assert.equal(subscriptionPanelReady(KIMI_PANEL_TEXT), true);
});

test('summarizeSubscriptionText pairs window labels across plan-name and reset lines', () => {
  const sum = summarizeSubscriptionText(KIMI_PANEL_TEXT);
  assert.ok(sum, 'the real panel must parse');
  assert.deepEqual(
    sum.map((h) => [h.label, h.percent]),
    [['总使用量', 29.1], ['5 小时用量', 1.31], ['7 天用量', 4.59]],
    'plan-name lines (Code) and reset lines must not become labels',
  );
});

test('windowTokenForLabel maps scraped labels onto the standard window tokens', () => {
  assert.equal(windowTokenForLabel('总使用量'), '1m');
  assert.equal(windowTokenForLabel('5 小时用量'), '5h');
  assert.equal(windowTokenForLabel('7 天用量'), '1wk');
  assert.equal(windowTokenForLabel('周用量'), '1wk');
  assert.equal(windowTokenForLabel('本月用量'), '1m');
  assert.equal(windowTokenForLabel('看不懂的行'), null);
});

test('parseResetAfter handles absolute dates, year-less times, and year rollover', () => {
  const now = new Date(2026, 7, 4, 12, 0, 0).getTime(); // 2026-08-04 12:00 local
  assert.equal(parseResetAfter('Kimi Code 2026-08-19 后重置', now), new Date(2026, 7, 19).getTime());
  assert.equal(parseResetAfter('08-04 06:28 后重置', now), new Date(2026, 7, 4, 6, 28).getTime(), 'earlier same-day time stays in the current year');
  assert.equal(parseResetAfter('08-10 21:28 后重置', now), new Date(2026, 7, 10, 21, 28).getTime());
  // A year-less date already in the past rolls into next year.
  assert.equal(parseResetAfter('01-05 06:00 后重置', now), new Date(2027, 0, 5, 6, 0).getTime());
  assert.equal(parseResetAfter('没有重置信息'), null);
});

test('summarizeSubscriptionText emits standard window tokens with parsed resetMs', () => {
  const now = new Date(2026, 7, 4, 12, 0, 0).getTime();
  const sum = summarizeSubscriptionText(KIMI_PANEL_TEXT, now);
  assert.deepEqual(sum.map((h) => h.window), ['1m', '5h', '1wk'], 'raw labels must map to standard tokens');
  assert.deepEqual(sum.map((h) => h.usedPercent), [29.1, 1.31, 4.59]);
  assert.deepEqual(sum.map((h) => h.resetMs), [
    new Date(2026, 7, 19).getTime(),
    new Date(2026, 7, 4, 6, 28).getTime(),
    new Date(2026, 7, 10, 21, 28).getTime(),
  ], '后重置 times must reach the frontend so countdowns render');
});

test('fetchKimiSubscriptionPage waits past the sidebar for the panel', async () => {
  let reads = 0;
  const page = fakeKimiPage({
    hrefs: ['https://www.kimi.com/membership/subscription?tab=quota'],
    text: KIMI_SIDEBAR_TEXT,
  });
  const innerText = page.evaluate.bind(page);
  page.evaluate = async (expression) => {
    if (expression.includes('innerText')) {
      reads += 1;
      // First polls see only the sidebar; the panel paints later.
      return reads <= 2 ? KIMI_SIDEBAR_TEXT : KIMI_PANEL_TEXT;
    }
    return innerText(expression);
  };
  const result = await fetchKimiSubscriptionPage(fakeManaged({ cookies: [{ name: 'a', value: 'b' }], page }));
  assert.equal(result.status, 'ok');
  assert.ok(reads >= 3, 'must keep polling after the sidebar text appears');
  assert.deepEqual(result.summary.map((h) => h.percent), [29.1, 1.31, 4.59]);
});

test('fetchKimiSubscriptionPage reports unavailable when only the sidebar ever renders', async () => {
  process.env.KIMI_QUOTA_PANEL_TIMEOUT_MS = '200';
  try {
    const page = fakeKimiPage({
      hrefs: ['https://www.kimi.com/membership/subscription?tab=quota'],
      text: KIMI_SIDEBAR_TEXT,
    });
    const result = await fetchKimiSubscriptionPage(fakeManaged({ cookies: [{ name: 'a', value: 'b' }], page }));
    assert.equal(result.status, 'unavailable');
    assert.match(result.error, /用量面板/);
  } finally {
    delete process.env.KIMI_QUOTA_PANEL_TIMEOUT_MS;
  }
});

test('fetchKimiUsage falls back to the membership page when every site is 401', async () => {
  const result = await fetchKimiUsage('', 1, {
    targets: [KIMI],
    poll: async () => ({ error: true, httpStatus: 401, reason: 'auth_rejected' }),
    console: async () => ({
      status: 'ok', fetchedAt: 2, source: 'subscription-page',
      summary: [{ label: '5小时窗口', percent: 10, line: '10%' }], text: '10%',
    }),
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.source, 'subscription-page');
  assert.ok(Array.isArray(result.sites), 'the failed balance sites stay attached for context');
});

test('fetchKimiUsage surfaces needs_login with the loginUrl when the profile has no session', async () => {
  const result = await fetchKimiUsage('', 1, {
    targets: [KIMI],
    poll: async () => ({ error: true, httpStatus: 401, reason: 'auth_rejected' }),
    console: async () => ({ status: 'needs_login', error: 'no session' }),
  });
  assert.equal(result.status, 'needs_login');
  assert.match(result.loginUrl, /kimi\.com\/membership\/subscription/);
});

test('fetchKimiUsage reports the combined failure when the scrape also fails', async () => {
  const result = await fetchKimiUsage('', 1, {
    targets: [KIMI],
    poll: async () => ({ error: true, httpStatus: 401, reason: 'auth_rejected' }),
    console: async () => ({ status: 'chrome_unavailable', error: 'no binary' }),
  });
  assert.equal(result.status, 'unavailable');
  assert.match(result.error, /401/);
  assert.match(result.error, /no binary/);
});

test('non-401 failures skip the console fallback entirely', async () => {
  let called = false;
  const result = await fetchKimiUsage('', 1, {
    targets: [KIMI],
    poll: async () => ({ error: true, httpStatus: 500, reason: 'http_error' }),
    console: async () => { called = true; return { status: 'ok' }; },
  });
  assert.equal(result.status, 'unavailable');
  assert.equal(called, false);
});

// A page stand-in matching the chrome-cdp page surface.
function fakeKimiPage({ hrefs, text = '' }) {
  let idx = 0;
  return {
    navigated: [],
    enable: async () => {},
    navigate: async (url) => {},
    async evaluate(expression) {
      if (expression.includes('location.href')) return hrefs[Math.min(idx++, hrefs.length - 1)];
      if (expression.includes('readyState')) return 'complete';
      if (expression.includes('innerText')) return text;
      return '';
    },
    async waitFor(predicate, { timeoutMs = 500, intervalMs = 1 } = {}) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        let hit = null;
        try { hit = await predicate(); } catch (_) { hit = null; }
        if (hit) return hit;
        if (Date.now() >= deadline) return null;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    },
    responses: [],
  };
}

function fakeManaged({ cookies = [], page = null, attachError = null }) {
  return {
    attachManaged: async () => {
      if (attachError) throw attachError;
      return { close() {} };
    },
    getCookies: async () => cookies,
    withPage: async (fn) => fn(page),
  };
}

test('fetchKimiSubscriptionPage reports needs_login when the profile has no kimi session', async () => {
  const result = await fetchKimiSubscriptionPage(fakeManaged({ cookies: [] }));
  assert.equal(result.status, 'needs_login');
});

test('fetchKimiSubscriptionPage maps a browser failure to chrome_unavailable', async () => {
  const err = new Error('no Chrome binary found');
  err.code = 'chrome_unavailable';
  const result = await fetchKimiSubscriptionPage(fakeManaged({ attachError: err }));
  assert.equal(result.status, 'chrome_unavailable');
});

test('fetchKimiSubscriptionPage detects a session that expired into a login redirect', async () => {
  const page = fakeKimiPage({ hrefs: ['https://www.kimi.com/login?next=/membership'] });
  const result = await fetchKimiSubscriptionPage(fakeManaged({ cookies: [{ name: 'a', value: 'b' }], page }));
  assert.equal(result.status, 'needs_login');
});

test('fetchKimiSubscriptionPage scrapes usage text from the settled page', async () => {
  const page = fakeKimiPage({
    hrefs: ['https://www.kimi.com/membership/subscription'],
    text: 'Kimi Code 会员\n5小时窗口\n12%\n周用量\n3%',
  });
  const result = await fetchKimiSubscriptionPage(fakeManaged({ cookies: [{ name: 'a', value: 'b' }], page }));
  assert.equal(result.status, 'ok');
  assert.equal(result.source, 'subscription-page');
  assert.equal(result.summary.length, 2);
  assert.equal(result.summary[0].percent, 12);
});

// ── render priority: a top-level actionable status outranks sites[].reason ──
//
// The bug this pins: a Kimi-for-Coding key ALWAYS 401s the balance API, so the
// live DTO is `{status:'needs_login', sites:[{reason:'auth_rejected'}]}`. The bar
// rendered the site reason ("密钥不支持余额查询") over the top-level status,
// telling the user their key was unsupported — a dead end — when one click on a
// login window would have fixed it.

const NEEDS_LOGIN_DTO = Object.freeze({
  status: 'needs_login',
  error: '托管浏览器中没有 kimi.com 登录态，点余量徽标可打开登录窗口',
  loginUrl: 'https://www.kimi.com/membership/subscription',
  sites: [{ host: 'api.kimi.com', site: 'Kimi', ok: false, httpStatus: 401, reason: 'auth_rejected' }],
});

test('formatKimiQuota renders needs_login over a per-site auth_rejected reason', () => {
  const view = formatKimiQuota(NEEDS_LOGIN_DTO);
  assert.match(view.text, /需登录/);
  assert.doesNotMatch(view.text, /密钥不支持余额查询/, 'the site reason must not be the headline');
  assert.doesNotMatch(view.text, /暂不可用/);
  assert.equal(view.action, 'login', 'the click must open a login window, not refetch');
  assert.equal(view.color, '#f85149');
  // The site reason survives as secondary context in the tooltip.
  assert.match(view.title, /Kimi-for-Coding/);
  assert.match(view.title, /登录/);
});

test('formatKimiQuota keeps needs_login on top even when a stale cached balance exists', () => {
  const cached = {
    status: 'ok', fetchedAt: Date.now() - 3600000,
    sites: [{ host: 'api.moonshot.cn', site: 'Moonshot', ok: true, available: 42.5, voucher: null, cash: 42.5, currency: 'CNY' }],
  };
  const view = formatKimiQuota(NEEDS_LOGIN_DTO, cached);
  assert.match(view.text, /需登录/);
  assert.equal(view.action, 'login');
  // The cached number is context, not a reason to hide the actionable state.
  assert.match(view.title, /42\.5/);
});

test('formatKimiQuota renders chrome_unavailable as an actionable state too', () => {
  const view = formatKimiQuota({
    status: 'chrome_unavailable', error: 'no Chrome binary found',
    sites: [{ host: 'api.kimi.com', ok: false, reason: 'auth_rejected' }],
  });
  assert.match(view.text, /无可用浏览器/);
  assert.doesNotMatch(view.text, /密钥不支持余额查询/);
  assert.equal(view.action, 'login');
  assert.equal(view.color, '#d29922');
});

test('formatKimiQuota renders a successful membership-page scrape as usage, not "余额暂不可用"', () => {
  // Every balance site is still ok:false here — that is normal for a
  // subscription key. Falling through to the sites-only path would make the
  // login the bar just asked for look like it changed nothing.
  const view = formatKimiQuota({
    status: 'ok', source: 'subscription-page', fetchedAt: Date.now(),
    summary: [{ label: '5小时窗口', percent: 12, line: '12%' }, { label: '周用量', percent: 90, line: '90%' }],
    text: '12%\n90%',
    sites: [{ host: 'api.kimi.com', ok: false, httpStatus: 401, reason: 'auth_rejected' }],
  });
  assert.doesNotMatch(view.text, /暂不可用/);
  assert.doesNotMatch(view.text, /密钥不支持余额查询/);
  // Unified convention: bars show REMAINING, so 90% used renders as 10%.
  assert.match(view.text, /5小时窗口 88%/);
  assert.match(view.text, /周用量 10%/);
  // Coloured by the worst window's remaining (10% → red).
  assert.equal(view.color, '#f85149');
  assert.match(view.title, /已用 90%/);
});

test('formatKimiQuota renders the unified window shape with standard tokens and countdown', () => {
  const now = Date.now();
  const view = formatKimiQuota({
    status: 'ok', source: 'subscription-page', fetchedAt: now,
    summary: [
      { window: '1m', label: '总使用量', usedPercent: 29.1, percent: 29.1, resetMs: now + 15 * 86400000 + 3660000 },
      { window: '5h', label: '5 小时用量', usedPercent: 1.31, percent: 1.31, resetMs: now + 5 * 3600000 + 120000 },
      { window: '1wk', label: '7 天用量', usedPercent: 4.59, percent: 4.59, resetMs: now + 6 * 86400000 + 3660000 },
    ],
    text: '…',
  });
  // Standard tokens + REMAINING percent + humanized countdown — exactly the
  // shared template every other provider renders through.
  assert.match(view.text, /1m 71% 15d 1h/);
  assert.match(view.text, /5h 99% 5h/);
  assert.match(view.text, /1wk 95% 6d 1h/);
  assert.doesNotMatch(view.text, /总使用量|小时用量/, 'raw scraped labels must not surface');
  // Cross-check against the template itself.
  assert.equal(unifiedWindowSeg('1m', 29.1, 15 * 86400000 + 3600000), '1m 71% 15d 1h');
});

test('formatKimiQuota still renders pre-upgrade {label, percent} cache entries without crashing', () => {
  const view = formatKimiQuota({
    status: 'ok', source: 'subscription-page', fetchedAt: Date.now(),
    summary: [{ label: '总使用量', percent: 29.1, line: '29.1%' }],
    text: '…',
  });
  assert.match(view.text, /总使用量 71%/);
  assert.doesNotMatch(view.text, /NaN|undefined/);
});

test('formatKimiQuota says so when the scrape succeeds but parses to nothing', () => {
  const view = formatKimiQuota({
    status: 'ok', source: 'subscription-page', fetchedAt: Date.now(), summary: [], text: '会员中心',
    sites: [{ host: 'api.kimi.com', ok: false, reason: 'auth_rejected' }],
  });
  assert.match(view.text, /已登录，未解析出用量/);
  assert.match(view.title, /会员中心/);
});

test('the plain auth_rejected failure keeps its own reason when the top level is not actionable', () => {
  // Regression guard for the other direction: sites[].reason is still the right
  // thing to show when the top-level status carries no user-fixable action.
  const view = formatKimiQuota({ status: 'unavailable', sites: [{ host: 'api.kimi.com', ok: false, reason: 'auth_rejected' }] });
  assert.match(view.text, /密钥不支持余额查询/);
  assert.equal(view.action, undefined);
});

test('qoder and opencode actionable states carry the same login action', () => {
  for (const format of [formatQoderQuota, formatOpenCodeQuota]) {
    const login = format({ status: 'needs_login' });
    assert.match(login.text, /需登录/);
    assert.equal(login.action, 'login');
    assert.equal(login.color, '#f85149');

    const noChrome = format({ status: 'chrome_unavailable' });
    // Opening the visible login window is also how a managed Chrome gets started.
    assert.equal(noChrome.action, 'login');
    assert.match(noChrome.text, /点击/);
  }
});

test('quotaBarClick posts to the login route for an actionable view and refetches otherwise', async () => {
  const origFetch = globalThis.fetch;
  const origSetTimeout = globalThis.setTimeout;
  const calls = [];
  const delayed = [];
  globalThis.fetch = async (url, opts) => { calls.push({ url, method: opts && opts.method }); return { ok: true }; };
  globalThis.setTimeout = (fn, ms) => { delayed.push({ fn, ms }); return 0; };
  try {
    let refetched = 0;
    const reFetch = () => { refetched += 1; };

    quotaBarClick('kimi', { action: 'login' }, reFetch);
    await new Promise((resolve) => origSetTimeout(resolve, 0));
    assert.deepEqual(calls, [{ url: '/api/kimi/quota/login', method: 'POST' }]);
    assert.equal(refetched, 0, 'the re-poll waits for the human to finish logging in');
    assert.equal(delayed.length, 1);
    assert.equal(delayed[0].ms, 3000);
    delayed[0].fn();
    assert.equal(refetched, 1, 'and then re-fetches on its own');

    // A non-actionable view is a plain forced refresh — no POST.
    quotaBarClick('kimi', { text: 'Kimi ¥1.00' }, reFetch);
    assert.equal(refetched, 2);
    assert.equal(calls.length, 1);

    // An unknown bar kind degrades to a refetch rather than posting nowhere.
    quotaBarClick('zhipu', { action: 'login' }, reFetch);
    assert.equal(refetched, 3);
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = origFetch;
    globalThis.setTimeout = origSetTimeout;
  }
});

test('every bar kind that renders action:login has a login route', () => {
  for (const format of [formatKimiQuota, formatQoderQuota, formatOpenCodeQuota]) {
    for (const status of ['needs_login', 'chrome_unavailable']) {
      assert.equal(format({ status }).action, 'login', `${status} must stay actionable`);
    }
  }
});
