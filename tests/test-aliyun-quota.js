'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  fetchAliyunUsage,
  fetchAliyunConsolePage,
  summarizeAliyunUsageText,
  aliyunPanelReady,
  ALIYUN_CONSOLE_URL,
} = require('../src/routes/aliyun-quota');

// Console chrome (topbar / nav / menu) that loads before the usage panel.
// Carries the words 额度/用量 in menu entries but never a real percentage,
// so the two-condition gate must reject it.
const ALIYUN_NAV_TEXT = [
  '阿里云控制台',
  '产品与服务',
  '模型体验',
  '模型广场',
  '费用与成本',
  '免费额度',
  '用量查询',
  '账单管理',
].join('\n');

// The async usage panel once it paints (best-effort shape, pending a real
// logged-in verification — see the honest caveat in src/routes/aliyun-quota.js).
const ALIYUN_PANEL_TEXT = [
  '阿里云控制台',
  '费用与成本',
  '免费额度',
  'Coding Plan 用量',
  '总额度',
  '12.5%',
  '2026-09-01 后重置',
  '本月用量',
  'Coding',
  '80%',
  '09-01 00:00 后重置',
].join('\n');

test('aliyunPanelReady rejects the console chrome and accepts the usage panel', () => {
  assert.equal(aliyunPanelReady(ALIYUN_NAV_TEXT), false, 'nav words alone are not the panel');
  assert.equal(aliyunPanelReady('本月进度 100%'), false, 'a stray percent without a panel marker is not the panel');
  assert.equal(aliyunPanelReady('免费额度已用尽'), false, 'marker words without a percent are not the panel');
  assert.equal(aliyunPanelReady(ALIYUN_PANEL_TEXT), true);
  assert.equal(aliyunPanelReady(''), false);
});

test('summarizeAliyunUsageText pairs labels across plan-name and reset lines', () => {
  const sum = summarizeAliyunUsageText(ALIYUN_PANEL_TEXT);
  assert.ok(sum, 'the panel fixture must parse');
  assert.deepEqual(
    sum.map((h) => [h.label, h.percent]),
    [['总额度', 12.5], ['本月用量', 80]],
    'plan-name (Coding) and reset lines must not become labels',
  );
  assert.equal(summarizeAliyunUsageText('nothing here'), null);
});

// A page stand-in matching the chrome-cdp page surface.
function fakeAliyunPage({ hrefs, text = '' }) {
  let idx = 0;
  return {
    enable: async () => {},
    navigate: async () => {},
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

test('fetchAliyunConsolePage reports needs_login when the profile has no aliyun session', async () => {
  const result = await fetchAliyunConsolePage(fakeManaged({ cookies: [] }));
  assert.equal(result.status, 'needs_login');
  assert.match(result.error, /aliyun\.com/);
});

test('fetchAliyunConsolePage maps a browser failure to chrome_unavailable', async () => {
  const err = new Error('no Chrome binary found');
  err.code = 'chrome_unavailable';
  const result = await fetchAliyunConsolePage(fakeManaged({ attachError: err }));
  assert.equal(result.status, 'chrome_unavailable');
});

test('fetchAliyunConsolePage detects a session that expired into a login redirect', async () => {
  const page = fakeAliyunPage({ hrefs: ['https://signin.aliyun.com/login.htm?callback=bailian'] });
  const result = await fetchAliyunConsolePage(fakeManaged({ cookies: [{ name: 'a', value: 'b' }], page }));
  assert.equal(result.status, 'needs_login');
});

test('fetchAliyunConsolePage waits past the console chrome for the panel', async () => {
  let reads = 0;
  const page = fakeAliyunPage({ hrefs: [ALIYUN_CONSOLE_URL], text: ALIYUN_NAV_TEXT });
  const innerText = page.evaluate.bind(page);
  page.evaluate = async (expression) => {
    if (expression.includes('innerText')) {
      reads += 1;
      return reads <= 2 ? ALIYUN_NAV_TEXT : ALIYUN_PANEL_TEXT;
    }
    return innerText(expression);
  };
  const result = await fetchAliyunConsolePage(fakeManaged({ cookies: [{ name: 'a', value: 'b' }], page }));
  assert.equal(result.status, 'ok');
  assert.equal(result.source, 'console-page');
  assert.ok(reads >= 3, 'must keep polling after the nav text appears');
  assert.deepEqual(result.summary.map((h) => h.percent), [12.5, 80]);
});

test('fetchAliyunConsolePage reports unavailable when only the chrome ever renders', async () => {
  process.env.ALIYUN_QUOTA_PANEL_TIMEOUT_MS = '200';
  try {
    const page = fakeAliyunPage({ hrefs: [ALIYUN_CONSOLE_URL], text: ALIYUN_NAV_TEXT });
    const result = await fetchAliyunConsolePage(fakeManaged({ cookies: [{ name: 'a', value: 'b' }], page }));
    assert.equal(result.status, 'unavailable');
    assert.match(result.error, /用量面板/);
  } finally {
    delete process.env.ALIYUN_QUOTA_PANEL_TIMEOUT_MS;
  }
});

test('fetchAliyunUsage passes scrape results through and attaches the loginUrl on needs_login', async () => {
  const ok = await fetchAliyunUsage(7, { console: async () => ({ status: 'ok', fetchedAt: 3, summary: [{ label: 'x', percent: 1 }], text: '1%' }) });
  assert.equal(ok.status, 'ok');
  assert.equal(ok.fetchedAt, 3);

  const login = await fetchAliyunUsage(7, { console: async () => ({ status: 'needs_login', error: 'no session' }) });
  assert.equal(login.status, 'needs_login');
  assert.equal(login.loginUrl, ALIYUN_CONSOLE_URL);

  const down = await fetchAliyunUsage(7, { console: async () => ({ status: 'chrome_unavailable', error: 'no binary' }) });
  assert.equal(down.status, 'chrome_unavailable');
  assert.match(down.error, /no binary/);
});

test('mountAliyunQuotaRoutes maps statuses onto HTTP codes', async () => {
  const routes = {};
  const app = {
    get: (path, handler) => { routes[`GET ${path}`] = handler; },
    post: (path, handler) => { routes[`POST ${path}`] = handler; },
  };
  const { mountAliyunQuotaRoutes } = require('../src/routes/aliyun-quota');
  mountAliyunQuotaRoutes(app, { usageDeps: { console: async () => ({ status: 'needs_login', error: 'no session' }) } });
  assert.ok(routes['GET /api/aliyun/quota'], 'GET quota route mounted');
  assert.ok(routes['POST /api/aliyun/quota/login'], 'POST login route mounted');

  let statusCode = null; let body = null;
  const res = { status(c) { statusCode = c; return this; }, json(b) { body = b; return this; } };
  await routes['GET /api/aliyun/quota']({}, res);
  assert.equal(statusCode, 401);
  assert.equal(body.status, 'needs_login');
});
