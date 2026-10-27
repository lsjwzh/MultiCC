'use strict';

// Provider 卡片余量走势（public/air-provider-trend.js）：
// 归一化、迷你曲线几何、斜率预测、内联渲染与详情弹层。用最薄的 DOM 替身跑真模块。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { t, getLocale } = require('./helpers/i18n-translator');

const ROOT = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this._text = '';
    this.className = '';
    this.dataset = {};
    this.style = {};
    this.attributes = {};
    this.parentNode = null;
    this.removed = false;
    this.open = false;
    this.onclick = null;
    this.onclose = null;
  }

  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this._text = value == null ? '' : String(value); this.children = []; }

  append(...nodes) {
    for (const node of nodes) { node.parentNode = this; this.children.push(node); }
  }

  replaceChildren(...nodes) {
    this._text = '';
    this.children = [];
    this.append(...nodes);
  }

  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null; }

  showModal() { this.open = true; }
  close() {
    this.open = false;
    if (typeof this.onclose === 'function') this.onclose();
  }
  remove() {
    this.removed = true;
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = null;
  }

  querySelectorAll(selector) {
    const found = [];
    const walk = node => {
      for (const child of node.children) {
        if (selector.startsWith('.') ? child.className.split(/\s+/).includes(selector.slice(1)) : child.tagName === selector.toUpperCase()) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function createDocument() {
  return {
    body: new FakeElement('body'),
    createElement(tag) { return new FakeElement(tag); },
    createElementNS(_namespace, tag) { return new FakeElement(tag); },
  };
}

function loadModule(document) {
  const sandbox = { document, t, getLocale, console };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('public/air-provider-trend.js'), sandbox, { filename: 'air-provider-trend.js' });
  return sandbox.MultiCCProviderTrend;
}

const PROVIDER = { appType: 'claude', id: 'glm', name: 'GLM' };
const RESPONSE = {
  available: true,
  generatedAt: 2_400_000,
  providers: {
    'claude:glm': {
      updatedAt: 2_200_000,
      series: {
        '1wk': {
          label: '1wk', unit: 'percent', resetAt: 9_000_000,
          points: [[1_600_000, 70], [2_200_000, 66]],
        },
        '5h': {
          label: '5h', unit: 'percent', resetAt: 9_000_000,
          points: [[2_200_000, 45], [1_000_000, 100], [1_600_000, 60]],
        },
      },
    },
  },
};

test('normalizeResponse sorts points, drops junk, and orders series', () => {
  const trend = loadModule(createDocument());
  const junk = {
    available: true,
    providers: {
      'claude:glm': {
        series: {
          '5h': { points: [[2_200_000, 45], [1_000_000, 100], [1_600_000, 60], ['x', 3], [0, 10]], unit: 'percent' },
          '1wk': { points: [[1_600_000, 70]], unit: 'percent' },
          bad: { points: 'nope' },
        },
      },
      'claude:none': { series: {} },
    },
  };
  const normalized = trend.normalizeResponse(junk);
  assert.deepEqual([...normalized.keys()], ['claude:glm']);
  const entry = trend.entryFor(normalized, PROVIDER);
  // vm 沙箱里的数组原型与外部不同，比较前做一次纯数据化。
  assert.deepEqual(JSON.parse(JSON.stringify(entry.series['5h'].points)),
    [[1_000_000, 100], [1_600_000, 60], [2_200_000, 45]]);
  assert.deepEqual(Array.from(trend.orderedSeriesList(entry), item => item.name), ['5h', '1wk']);
  assert.equal(entry.series['5h'].last, 45);
});

test('normalizeResponse reports nothing when the endpoint is unavailable', () => {
  const trend = loadModule(createDocument());
  assert.equal(trend.normalizeResponse({ available: false, providers: {} }).size, 0);
  assert.equal(trend.normalizeResponse(null).size, 0);
});

test('sparklinePath maps values to the y axis without inventing points', () => {
  const trend = loadModule(createDocument());
  const path = trend.sparklinePath([[0, 100], [100, 0]], { width: 100, height: 30, min: 0, max: 100 });
  assert.equal(path, 'M0.00,0.00 L100.00,30.00');
  assert.equal(trend.sparklinePath([], { width: 10, height: 10 }), '');
  assert.equal(trend.sparklinePath([[5, 50]], { width: 100, height: 30, min: 0, max: 100 }), 'M100.00,15.00');
});

test('projectExhaustion estimates an eta from a falling percent line', () => {
  const trend = loadModule(createDocument());
  const item = {
    name: '5h', unit: 'percent',
    points: [[0, 100], [600_000, 97], [1_200_000, 94], [1_800_000, 91]],
  };
  const projection = trend.projectExhaustion(item, { nowMs: 1_800_000 });
  assert.ok(projection);
  // -0.3%/min → 91% lasts ~303 minutes.
  assert.ok(Math.abs(projection.etaMs - (1_800_000 + 91 / 0.3 * 60_000)) < 1000);
  assert.equal(trend.projectExhaustion({ ...item, unit: 'amount' }, { nowMs: 1_800_000 }), null);
  assert.equal(trend.projectExhaustion({ ...item, resetAt: 2_000_000 }, { nowMs: 1_800_000 }), null);
  assert.equal(trend.projectExhaustion({ ...item, points: [[0, 50], [600_000, 60], [1_200_000, 70]] }, { nowMs: 1_200_000 }), null);
});

test('renderInline draws one path per series with the card values', () => {
  const document = createDocument();
  const trend = loadModule(document);
  const entry = trend.entryFor(trend.normalizeResponse(RESPONSE), PROVIDER);
  const node = trend.renderInline(PROVIDER, entry);
  assert.ok(node, 'a series must render a block');
  assert.equal(node.className, 'air-provider-trend');
  assert.equal(node.dataset.trend, 'claude:glm');
  assert.match(node.textContent, /5 小时 45%/);
  assert.match(node.textContent, /7 天 66%/);
  const paths = node.querySelectorAll('path');
  assert.ok(paths.length >= 2, 'both series need a polyline');
  assert.equal(trend.renderInline(PROVIDER, null), null);

  let opened = 0;
  const interactive = trend.renderInline(PROVIDER, entry, { onOpen: () => { opened += 1; } });
  assert.equal(interactive.getAttribute('role'), 'button');
  interactive.onclick({ stopPropagation() {} });
  assert.equal(opened, 1);
});

test('openDetail paints a chart and replaces 24h data with the 7d answer', async () => {
  const document = createDocument();
  const trend = loadModule(document);
  const calls = [];
  const dialog = trend.openDetail(PROVIDER, trend.entryFor(trend.normalizeResponse(RESPONSE), PROVIDER), {
    api: async request => { calls.push(request); return RESPONSE; },
    name: 'GLM',
    now: 2_400_000,
  });
  assert.ok(dialog.open, 'the dialog opens immediately with the inline data');
  assert.equal(document.body.children.includes(dialog), true);
  assert.equal(dialog.querySelector('h2').textContent, 'GLM · 最近 24 小时');
  assert.match(dialog.textContent, /5 小时/);
  assert.ok(dialog.querySelector('svg'), 'the detail view needs the big chart');
  assert.match(String(calls[0]), /appType=claude&id=glm&range=7d&points=120/);

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(dialog.querySelector('h2').textContent, 'GLM · 最近 7 天');
  dialog.close();
  assert.equal(dialog.removed, true);
});

test('openDetail explains the empty state instead of drawing nothing', () => {
  const document = createDocument();
  const trend = loadModule(document);
  const dialog = trend.openDetail(PROVIDER, null, { name: 'GLM' });
  assert.match(dialog.textContent, /还没有足够的历史采样/);
});

test('the provider page loads and wires the trend module', () => {
  const page = read('public/air-provider.js');
  assert.match(page, /MultiCCProviderTrend\?\.entryFor/);
  assert.match(page, /MultiCCProviderTrend\?\.renderInline/);
  assert.match(page, /\/api\/providers\/limit-history\?range=24h&points=40/);
  assert.match(read('public/air.html'), /<script src="air-provider-trend\.js"><\/script>/);
});
