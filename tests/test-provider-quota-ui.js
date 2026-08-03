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
