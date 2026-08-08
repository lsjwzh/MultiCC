'use strict';

// Regression tests for the provider-card quota badge UX fix:
//   • providers without a quota endpoint say so honestly (no fake「正在加载…」)
//   • real loading / no-data / result states are distinct
//   • clicking the badge force-refreshes, bypassing the 60s throttle
//   • automatic re-renders within the throttle window do not refetch

const test = require('node:test');
const assert = require('node:assert/strict');

const catalog = require('../public/provider-catalog');

function makeEl(id) {
  return {
    attrs: { 'data-quota-id': id },
    getAttribute(key) { return this.attrs[key]; },
    textContent: '',
    style: {},
    title: '',
    onclick: null,
  };
}

function withWindow(elements, fn) {
  const store = new Map();
  global.window = {
    document: { querySelectorAll: sel => (sel === '[data-quota-id]' ? elements : []) },
    localStorage: {
      getItem: key => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, value),
    },
  };
  try { return fn(); } finally { delete global.window; }
}

async function flush() {
  for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
}

const ZHIPU_OK = { status: 'ok', fetchedAt: 1, sites: [{ site: 'BigModel', ok: true, period: '5h', usedPercent: 12, weeklyUsedPercent: 40 }] };

test('provider without a quota endpoint shows an honest「无余量接口」and never fetches', async () => {
  const el = makeEl('p-null');
  let fetches = 0;
  await withWindow([el], () => {
    catalog.injectProviderQuotas(
      { providers: [{ id: 'p-null', appType: 'claude', baseUrl: 'https://relay.example.test/v1' }] },
      async () => { fetches++; return {}; },
    );
  });
  await flush();
  assert.equal(el.textContent, '余量 —（无余量接口）');
  assert.match(el.title, /未提供余量查询接口/);
  assert.equal(el.onclick, null);
  assert.equal(fetches, 0, 'no endpoint means no fetch');
});

test('known kind shows pending, then the fetched badge with credential-source tooltip', async () => {
  const el = makeEl('p-zhipu');
  let fetches = 0;
  await withWindow([el], async () => {
    catalog.injectProviderQuotas(
      { providers: [{ id: 'p-zhipu', appType: 'claude', baseUrl: 'https://open.bigmodel.cn/api' }] },
      async () => { fetches++; return ZHIPU_OK; },
    );
    assert.equal(el.textContent, '余量 查询中…', 'loading state while the fetch is in flight');
    await flush();
  });
  assert.equal(fetches, 1);
  assert.match(el.textContent, /^余量 BigModel/);
  assert.match(el.title, /服务端配置的同厂商凭证/);
  assert.match(el.title, /点击重新查询/);
  assert.equal(typeof el.onclick, 'function');
});

test('clicking the badge force-refreshes and bypasses the throttle; re-render alone does not', async () => {
  const el = makeEl('p-kimi');
  let fetches = 0;
  await withWindow([el], async () => {
    const jsonFn = async () => { fetches++; return ZHIPU_OK; };
    const providerList = { providers: [{ id: 'p-kimi', appType: 'claude', baseUrl: 'https://api.kimi.com/v1' }] };
    catalog.injectProviderQuotas(providerList, jsonFn);
    await flush();
    assert.equal(fetches, 1);
    // A re-render within the 60s window must not refetch automatically.
    catalog.injectProviderQuotas(providerList, jsonFn);
    await flush();
    assert.equal(fetches, 1, 'throttled automatic refresh');
    // But an explicit user click always refetches.
    el.onclick();
    await flush();
    assert.equal(fetches, 2, 'manual click bypasses the throttle');
  });
});

test('failed fetch renders the failure badge, never a stuck loading text', async () => {
  const el = makeEl('p-ark');
  await withWindow([el], async () => {
    catalog.injectProviderQuotas(
      { providers: [{ id: 'p-ark', appType: 'claude', baseUrl: 'https://ark.cn-beijing.volces.com/api/coding' }] },
      async () => { throw Object.assign(new Error('boom'), { details: { status: 'unavailable', error: 'all fetches failed' } }); },
    );
    await flush();
  });
  assert.match(el.textContent, /暂不可用/);
  assert.match(el.title, /all fetches failed/);
});

test('kimi membership-page scrape renders through the unified window template', () => {
  const now = Date.now();
  const view = catalog.formatProviderQuotaBadge('kimi', {
    status: 'ok', source: 'subscription-page', fetchedAt: 1,
    summary: [
      { window: '5h', label: '5小时窗口', usedPercent: 12, percent: 12, resetMs: now + 2 * 3600000 + 60000, line: '12%' },
      { window: '1wk', label: '周用量', usedPercent: 81, percent: 81, resetMs: now + 3 * 86400000 + 3660000, line: '81%' },
    ],
    text: 'Kimi Code 会员\n5小时窗口\n12%',
  });
  // Standard tokens + REMAINING percent + countdown, not raw labels/used%.
  assert.match(view.text, /5h 88% 2h/);
  assert.match(view.text, /1wk 19% 3d 1h/);
  assert.doesNotMatch(view.text, /5小时窗口|周用量/);
  assert.match(view.title, /会员页抓取/);
  // 81% used crosses the 70% warning threshold.
  assert.equal(view.color, '#d29922');
});

test('needs_login badge invites a click and explains the login window', () => {
  const view = catalog.formatProviderQuotaBadge('qoder', { status: 'needs_login', error: '没有登录态' });
  assert.match(view.text, /点击登录/);
  assert.match(view.title, /拉起一个 Chrome 登录窗口/);
});

test('clicking a needs_login badge opens the login window instead of refetching', async () => {
  // Uses qoder (not kimi) — the throttle map is module-level and the kimi
  // kind was already fetched by an earlier test in this process.
  const el = makeEl('p-qoder');
  const calls = [];
  await withWindow([el], async () => {
    catalog.injectProviderQuotas(
      { providers: [{ id: 'p-qoder', appType: 'claude', baseUrl: 'https://www.qoder.com.cn/' }] },
      async (url, options) => {
        calls.push({ url, options });
        if (options && options.method === 'POST') return { ok: true, message: '已打开' };
        return { status: 'needs_login', error: '没有 qoder.com.cn 登录态' };
      },
    );
    await flush();
    assert.equal(calls.length, 1, 'the initial quota fetch');
    assert.match(el.textContent, /需登录/);

    el.onclick();
    await flush();
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, '/api/qoder/quota/login');
  assert.equal(calls[1].options.method, 'POST');
  assert.match(el.textContent, /已打开登录窗口/);
});
