'use strict';

// Air 的「用量统计」。
//
// 这一块以前只在 /manage.html 的「Provider → 统计 / 用量」子页里，Air 的 Provider
// 页把它整个留在默认折叠的「高级连接」iframe 中 —— 打开 Provider 页看不到任何
// token 统计。这个文件既守「功能一条不减」，也守它真的被挂回 Provider 页上。
//
// 用最薄的 DOM 替身直接跑真模块（同 tests/test-manage-provider-view-init.js 的
// 做法）：断言的是一张表真的按窗口/口径重算了，而不是源码里出现过某几个字符串。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createSandboxConsole } = require('./helpers/sandbox-console');
// 页面上的 t() 由 i18n.js 提供；沙箱里没有它，模块一取文案就会 ReferenceError。
const { t, getLocale } = require('./helpers/i18n-translator');

const ROOT = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const catalog = require('../public/provider-catalog');

// ── 最小 DOM 替身 ──────────────────────────────────────────────────────────

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this._text = '';
    this.className = '';
    this.dataset = {};
    this.style = {};
    this.id = '';
    this.onclick = null;
  }

  get textContent() {
    return this._text + this.children.map(child => child.textContent).join('');
  }

  get text() { return this.textContent; }

  set textContent(value) {
    this._text = value == null ? '' : String(value);
    this.children = [];
  }

  get classList() {
    const names = () => this.className.split(/\s+/).filter(Boolean);
    const write = list => { this.className = list.join(' '); };
    return {
      add: name => { if (!names().includes(name)) write([...names(), name]); },
      remove: name => write(names().filter(item => item !== name)),
      contains: name => names().includes(name),
      toggle: (name, force) => {
        const has = names().includes(name);
        const next = force === undefined ? !has : !!force;
        if (next && !has) write([...names(), name]);
        else if (!next && has) write(names().filter(item => item !== name));
        return next;
      },
    };
  }

  append(...nodes) {
    for (const node of nodes) this.children.push(node);
  }

  replaceChildren(...nodes) {
    this._text = '';
    this.children = [];
    this.append(...nodes);
  }

  querySelectorAll(selector) {
    const match = node => (selector.startsWith('.')
      ? node.className.split(/\s+/).includes(selector.slice(1))
      : node.tagName === selector.toUpperCase());
    const found = [];
    const walk = node => {
      for (const child of node.children) {
        if (match(child)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function createDocument() {
  const all = [];
  return {
    _all: all,
    createElement(tag) { const node = new FakeElement(tag); all.push(node); return node; },
    getElementById(id) { return all.find(node => node.id === id) || null; },
  };
}

// ── 驱动模块 ──────────────────────────────────────────────────────────────

function loadModule(document) {
  const sandbox = { document, MultiCCProviderCatalog: catalog, console: createSandboxConsole(), t, getLocale };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('public/air-usage.js'), sandbox, { filename: 'air-usage.js' });
  return sandbox.MultiCCAirUsage;
}

const GLOBAL_USAGE = {
  generatedAt: '2026-09-14T09:30:00.000Z',
  responses: 12,
  windows: {
    today: { 'claude-opus-5': { inputTokens: 7, outputTokens: 3, cacheWrite: 0, cacheRead: 0, msgs: 1 } },
    week: {},
    month: {
      'claude-opus-5': { inputTokens: 100, outputTokens: 20, cacheWrite: 5, cacheRead: 500, msgs: 3 },
      'deepseek-chat': { inputTokens: 200, outputTokens: 40, cacheWrite: 0, cacheRead: 0, msgs: 2 },
    },
    all: { 'claude-opus-5': { inputTokens: 100, outputTokens: 20, cacheWrite: 5, cacheRead: 500, msgs: 3 } },
  },
  byDay: { '2026-09-14': { 'claude-opus-5': 625 } },
  byDayFresh: { '2026-09-14': { 'claude-opus-5': 120 } },
};

const ROLE_LEDGER = {
  '2000-01-01': { sub: { p2: { inputTokens: 100, outputTokens: 50, cacheWrite: 0, cacheRead: 0 } } },
};

function dayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/// 装好一个面板，并把请求过的路径记下来交给用例断言。
async function mount({ global = GLOBAL_USAGE, role = ROLE_LEDGER, failGlobal = false } = {}) {
  const document = createDocument();
  const usage = loadModule(document);
  const requests = [];
  const context = {
    async api(url) {
      requests.push(url);
      if (url.startsWith('/api/token-usage/global')) {
        if (failGlobal) throw new Error('扫描失败');
        return global;
      }
      return role;
    },
  };
  const host = document.createElement('div');
  await usage.render(host, context);
  lastMounted = document;
  return { document, usage, host, requests };
}

const lastTable = document => document._all.filter(node => node.tagName === 'TABLE').pop();
const headerCells = table => table.children[0].children[0].children.map(cell => cell.textContent);
const bodyRows = table => table.children[1].children.map(row => row.children.map(cell => cell.textContent));
const footCells = table => table.children[2].children[0].children.map(cell => cell.textContent);

// 每个用例 mount 的都是新的一份假 document，用它来找面板上的文字。
let lastMounted = { getElementById: () => null };
const panelText = id => (lastMounted.getElementById(id) || { textContent: '' }).textContent;

function tab(document, label) {
  const found = document._all.find(node => node.tagName === 'BUTTON' && node.textContent === label);
  assert.ok(found, `找不到按钮「${label}」`);
  found.onclick();
}

test('默认这个月、新鲜口径：按模型明细 + 合计 + 汇总', async () => {
  const { document } = await mount();
  const table = lastTable(document);
  assert.deepEqual(headerCells(table), ['模型', '新鲜输入', '输出', '缓存写', '缓存读', '新鲜总计']);
  // 明细按**当前口径**降序：新鲜口径下 deepseek 的 240 排在 claude 的 120 前面
  // （claude 那 500 是缓存读，不进新鲜总计）。旧页排的也是这个 total。
  assert.deepEqual(bodyRows(table), [
    ['deepseek-chat', '200', '40', '0', '0', '240'],
    ['claude-opus-5', '100', '20', '5', '500', '120'],
  ]);
  assert.deepEqual(footCells(table), ['合计', '300', '60', '5', '500', '360']);
  const summary = panelText('air-usage-global');
  assert.match(summary, /当前口径（新鲜总计）：360/);
  assert.match(summary, /新鲜：360 · 含缓存：865 · 5 次响应/);
});

test('Claude 官方模型挑出来标色，别的模型不冒充', async () => {
  const { document } = await mount();
  const table = lastTable(document);
  const named = Object.fromEntries(table.children[1].children.map(row => [row.children[0].textContent, row.children[0].className]));
  assert.match(named['claude-opus-5'], /official/, 'claude-opus-5 应标为官方模型');
  assert.match(named['deepseek-chat'], /other/, 'deepseek-chat 不该标成官方模型');
});

test('切口径：末列换成含缓存总计，数值跟着变', async () => {
  const { document } = await mount();
  tab(document, '含缓存 Token');
  const table = lastTable(document);
  assert.equal(headerCells(table).at(-1), '含缓存总计');
  assert.deepEqual(bodyRows(table).map(row => row.at(-1)), ['625', '240']);
  assert.equal(footCells(table).at(-1), '865');
  assert.match(panelText('air-usage-global'), /当前口径（含缓存总计）：865/);
  // 行序也跟着口径走：含缓存后 claude 的 625 反超 deepseek 的 240。
  assert.deepEqual(bodyRows(table).map(row => row[0]), ['claude-opus-5', 'deepseek-chat']);
});

test('切换口径会重排行序，而不是只换末列的标签', async () => {
  const { document } = await mount();
  const order = () => bodyRows(lastTable(document)).map(row => row[0]);
  assert.deepEqual(order(), ['deepseek-chat', 'claude-opus-5'], '新鲜口径：240 > 120');
  tab(document, '含缓存 Token');
  assert.deepEqual(order(), ['claude-opus-5', 'deepseek-chat'], '含缓存口径：625 > 240');
  tab(document, '新鲜 Token');
  assert.deepEqual(order(), ['deepseek-chat', 'claude-opus-5'], '切回来还得是新鲜序');
});

test('切窗口：换成今天那份数据', async () => {
  const { document } = await mount();
  tab(document, '今天');
  const table = lastTable(document);
  assert.deepEqual(bodyRows(table), [['claude-opus-5', '7', '3', '0', '0', '10']]);
  assert.equal(footCells(table).at(-1), '10');
});

test('该时段没有任何记录时说清楚，而不是画一张空表', async () => {
  const { document } = await mount();
  tab(document, '本周');
  assert.match(panelText('air-usage-global'), /该时段暂无数据/);
});

test('趋势用新鲜序列；旧服务没有 byDayFresh 时退回含缓存并写明回退', async () => {
  await mount();
  assert.match(panelText('air-usage-global'), /近 1 个有活动的日子（新鲜 token\/天（输入\+输出））/);
  assert.match(panelText('air-usage-global'), /120/);

  // 老服务只给 byDay（含缓存）。把含缓存的数据冒称「新鲜」是最不该有的那种错，
  // 所以这里既要退回序列，也要把回退写在标签里。
  await mount({
    global: { generatedAt: GLOBAL_USAGE.generatedAt, windows: GLOBAL_USAGE.windows, byDay: GLOBAL_USAGE.byDay },
  });
  const text = panelText('air-usage-global');
  assert.match(text, /含缓存 token\/天（旧服务兼容回退）/);
  assert.match(text, /625/);
});

test('重新扫描按钮强制重扫，普通打开走缓存', async () => {
  const { document, requests } = await mount();
  assert.deepEqual(requests, ['/api/token-usage/global', '/api/token-usage/by-role']);
  tab(document, '重新扫描');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.at(-1), '/api/token-usage/global?refresh=1');
});

test('读取失败说人话，不把面板整个打没', async () => {
  await mount({ failGlobal: true });
  assert.match(panelText('air-usage-global'), /加载失败：扫描失败/);
  // 另一半（省主模型 Token）不该被牵连。
  assert.match(panelText('air-usage-role'), /今天/);
});

test('省主模型 Token：只算子任务那部分，主模型的不掺进来', async () => {
  await mount({
    role: {
      [dayKey(new Date())]: {
        main: { inputTokens: 9999, outputTokens: 9999, cacheWrite: 0, cacheRead: 0 },
        sub: { p1: { inputTokens: 10, outputTokens: 5, cacheWrite: 0, cacheRead: 0 } },
      },
      ...ROLE_LEDGER,
    },
  });
  const tiles = lastMounted.getElementById('air-usage-role').children[0].children;
  const shown = Object.fromEntries(tiles.map(tile => [tile.children[0].textContent, tile.children[1].textContent]));
  assert.deepEqual(Object.keys(shown), ['今天', '本周', '本月', '全部']);
  assert.equal(shown['今天'], '15', 'main 的用量不算省下来的');
  assert.equal(shown['本月'], '15');
  assert.equal(shown['全部'], '165', '2000 年那笔只进「全部」');
});

test('账本为空时说暂无数据', async () => {
  await mount({ role: {} });
  assert.match(panelText('air-usage-role'), /暂无数据/);
});

// ── 接线：真的挂在 Provider 页上，且不是又一次「暂沿用原控制器」 ────────────

test('Air 加载这个模块，并挂到 Provider 页上', () => {
  const html = read('public/air.html');
  assert.match(html, /<script src="air-usage\.js"><\/script>/);
  assert.ok(
    html.indexOf('src="air-usage.js"') < html.indexOf('src="air-provider.js"'),
    'air-usage.js 要先于 air-provider.js 加载：Provider 页渲染时会用到它',
  );
  const provider = read('public/air-provider.js');
  assert.match(provider, /root\.MultiCCAirUsage\?\.render\(page, context\)/);
  // 顶栏「刷新」也要把用量带上，否则按了像没生效。
  assert.match(provider, /root\.MultiCCAirUsage\?\.reload\(\)/);
  // 这块已经原生搬回来了，就不能再在「高级连接」里说它还在旧控制器。
  assert.doesNotMatch(provider, /完整用量统计/);
});

test('旧页那份统计/用量还在，两边功能对得上', () => {
  const html = read('public/manage.html');
  const js = read('public/manage.js');
  for (const window_ of ['today', 'week', 'month', 'all']) {
    assert.match(html, new RegExp(`data-w="${window_}"`), `旧页少了 ${window_} 窗口`);
  }
  for (const metric of ['fresh', 'inclusive']) {
    assert.match(html, new RegExp(`data-metric="${metric}"`), `旧页少了 ${metric} 口径`);
  }
  assert.match(html, /id="global-usage-body"/);
  assert.match(html, /id="by-role-card-body"/);
  assert.match(js, /api\/token-usage\/global/);
  assert.match(js, /api\/token-usage\/by-role/);

  // 新页面用的是同一对接口，同一套窗口与口径 —— 同一个数字两处不该有两个说法。
  const air = read('public/air-usage.js');
  assert.match(air, /api\/token-usage\/global/);
  assert.match(air, /api\/token-usage\/by-role/);
  assert.match(air, /token_by_role\.json/);
  assert.match(air, /byDayFresh/);
});
