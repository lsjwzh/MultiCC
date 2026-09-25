'use strict';

// public/air-cli-update.js — 侧栏左上角那颗 CLI 待更新图标，以及点开后的升级浮层。
//
// 值得钉住的只有四件事：
//   ① 平时不吵（角标只在真有新版时出现），
//   ② 「查不到最新版」不能说成「已是最新」，
//   ③ 升级是个替换二进制的动作，必须先问过用户，并且在有会话正在用它时说清楚，
//   ④ 升级成功后角标必须消失 —— 靠 ?refresh=1 重探，而不是回放升级前的缓存。
//
// 与 tests/test-air-ops.js 同一套约定：手写 DOM shim，让模块原样跑；元素表从
// public/air.html 自己的 id 建，markup 里少了挂点会在这里红，而不是在浏览器里静默失效。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createSandboxConsole } = require('./helpers/sandbox-console');
const { t, getLocale } = require('./helpers/i18n-translator');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'public', 'air-cli-update.js'), 'utf8');
const AIR_HTML = fs.readFileSync(path.join(ROOT, 'public', 'air.html'), 'utf8');
// 页面先加载共享的 CLI 目录（air.html 的 <script src="provider-catalog.js">），浮层里的
// CLI 名字从它取。沙箱照页面的顺序来 —— 少了它，浮层渲染就只能在读 .cliDisplayName
// 时崩掉，而不是在这里红。
const CATALOG = require('../public/provider-catalog');

// ── Minimal DOM ────────────────────────────────────────────────────────────
class FakeClassList {
  constructor() { this.set = new Set(); }
  add(name) { this.set.add(name); }
  remove(name) { this.set.delete(name); }
  contains(name) { return this.set.has(name); }
  toggle(name, force) {
    const on = force === undefined ? !this.set.has(name) : !!force;
    if (on) this.set.add(name); else this.set.delete(name);
    return on;
  }
}

class FakeNode {
  constructor(tag) {
    this.tagName = String(tag || '').toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.className = '';
    this.classList = new FakeClassList();
    this.hidden = false;
    this.disabled = false;
    this.type = '';
    this.style = {};
    this.attributes = {};
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this._text = '';
    this.onclick = null;
    this._rect = { top: 0, bottom: 40, left: 12, right: 260 };
  }

  set textContent(value) {
    this.children.forEach(child => { child.parentNode = null; });
    this.children = [];
    this._text = String(value == null ? '' : value);
  }

  get textContent() {
    if (this.children.length) return this.children.map(child => child.textContent).join('');
    return this._text;
  }

  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  append(...nodes) { nodes.forEach(node => this.appendChild(node)); }

  replaceChildren(...nodes) {
    this.children.forEach(child => { child.parentNode = null; });
    this.children = [];
    nodes.forEach(node => this.appendChild(node));
  }

  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null; }

  getBoundingClientRect() { return this._rect; }

  contains(node) {
    if (node === this) return true;
    return this.children.some(child => child.contains(node));
  }

  descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
}

function registryFrom(html) {
  const registry = {};
  const re = /id="([^"]+)"/g;
  let match;
  while ((match = re.exec(html))) registry[match[1]] = new FakeNode('div');
  return registry;
}

// 界面上的文本都是 t() 出来的；这里按同一个词典翻，断言才不会被文案改写打穿。
const TXT = {
  upgrade: t('airCliUpdateUpgrade'),
  unknownSource: t('airCliUpdateUnknownSource'),
  current: t('airCliUpdateCurrent'),
  notInstalled: t('airCliUpdateNotInstalled'),
  allCurrent: t('airCliUpdateAllCurrent'),
  upgrading: t('airCliUpdateUpgrading'),
};

function entry(overrides = {}) {
  return {
    cmd: '/bin/x', available: true, version: '2.0.1', error: null,
    latest: null, updateAvailable: false, updateSource: 'npm', inUseCount: 0,
    ...overrides,
  };
}

function versionsBody(versions, updateCount) {
  return { ok: true, cached: false, checkedAt: '2026-09-21T10:00:00.000Z', updateCount, versions };
}

// 路由按「METHOD /path」查表；没写方法就是 GET。
function createFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const path = String(url);
    const method = (options && options.method) || 'GET';
    calls.push({ path, method });
    const handler = routes[`${method} ${path}`] || routes[path];
    if (!handler) throw new Error(`unexpected fetch: ${method} ${path}`);
    const result = typeof handler === 'function' ? handler(calls.length) : handler;
    const body = result && result.body !== undefined ? result.body : result;
    return {
      ok: !(result && result.ok === false),
      status: (result && result.status) || 200,
      text: async () => JSON.stringify(body === undefined ? {} : body),
    };
  };
  fetchImpl.calls = calls;
  fetchImpl.called = (method, path) => calls.some(call => call.method === method && call.path === path);
  return fetchImpl;
}

const settle = async () => { for (let i = 0; i < 12; i += 1) await new Promise(resolve => setImmediate(resolve)); };

function buildContext({ fetchImpl, confirmResult = true }) {
  const registry = registryFrom(AIR_HTML);
  const listeners = {};
  const document = {
    readyState: 'complete',
    createElement: tag => new FakeNode(tag),
    getElementById: id => registry[id] || null,
    addEventListener: (type, handler) => { (listeners[type] = listeners[type] || []).push(handler); },
    removeEventListener: (type, handler) => {
      listeners[type] = (listeners[type] || []).filter(entry => entry !== handler);
    },
  };
  const asked = [];
  const context = {
    document,
    addEventListener: document.addEventListener,
    removeEventListener: document.removeEventListener,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    innerWidth: 1440,
    fetch: fetchImpl,
    confirm: question => { asked.push(question); return confirmResult; },
    console: createSandboxConsole(),
    t,
    getLocale,
    MultiCCProviderCatalog: CATALOG,
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(SOURCE, context, { filename: 'air-cli-update.js' });
  return { context, registry, asked };
}

function openPopover(registry) {
  registry['cli-update-btn'].onclick();
  return registry['cli-update-pop'];
}

function rowButtons(registry) {
  return registry['cli-update-rows'].descendants()
    .filter(node => node.tagName === 'BUTTON' && node.textContent === TXT.upgrade);
}

function rowTexts(registry) {
  return registry['cli-update-rows'].children.map(row => row.textContent);
}

// ── Markup contract ────────────────────────────────────────────────────────
test('Air 侧栏带着待更新图标的挂点，并且脚本在 air.js 之前加载', () => {
  for (const id of ['cli-update-btn', 'cli-update-icon', 'cli-update-badge', 'cli-update-pop',
    'cli-update-rows', 'cli-update-log', 'cli-update-summary', 'cli-update-checked', 'cli-update-refresh']) {
    assert.match(AIR_HTML, new RegExp(`id="${id}"`), `air.html 少了 #${id}`);
  }
  const script = '<script src="air-cli-update.js"></script>';
  assert.ok(AIR_HTML.includes(script), 'air.html 没有加载 air-cli-update.js');
  assert.ok(AIR_HTML.indexOf(script) < AIR_HTML.indexOf('<script src="air.js"></script>'));
  // 浮层挂在 #sidebar 之外：窄屏侧栏是 transform 的定位容器，fixed 元素放在里面会被平移。
  assert.ok(AIR_HTML.indexOf('id="cli-update-pop"') > AIR_HTML.indexOf('</aside>'), '浮层必须在 #sidebar 之外');
});

// ── Badge ──────────────────────────────────────────────────────────────────
test('没有新版时图标保持安静，有新版才挂数量角标', async () => {
  const quiet = buildContext({
    fetchImpl: createFetch({ '/api/cli/versions': versionsBody({ claude: entry() }, 0) }),
  });
  await settle();
  assert.equal(quiet.registry['cli-update-badge'].hidden, true);
  assert.equal(quiet.registry['cli-update-icon'].textContent, '⇧');
  assert.equal(quiet.registry['cli-update-btn'].classList.contains('has-update'), false);

  const busy = buildContext({
    fetchImpl: createFetch({
      '/api/cli/versions': versionsBody({
        claude: entry({ latest: '2.0.2', updateAvailable: true }),
        codex: entry({ latest: '0.21.0', updateAvailable: true }),
        opencode: entry(),
      }, 2),
    }),
  });
  await settle();
  assert.equal(busy.registry['cli-update-badge'].hidden, false);
  assert.equal(busy.registry['cli-update-badge'].textContent, '2');
  assert.equal(busy.registry['cli-update-icon'].textContent, '🆕');
  assert.equal(busy.registry['cli-update-btn'].classList.contains('has-update'), true);
});

test('打不开版本接口时不假装「都是最新」', async () => {
  const context = buildContext({ fetchImpl: createFetch({}) });
  await settle();
  openPopover(context.registry);
  assert.notEqual(context.registry['cli-update-summary'].textContent, TXT.allCurrent);
  assert.equal(context.registry['cli-update-badge'].hidden, true);
});

// ── Popover content ────────────────────────────────────────────────────────
test('浮层把可升级的排在前面，并说清「查不到最新版」与「未安装」', async () => {
  const context = buildContext({
    fetchImpl: createFetch({
      '/api/cli/versions': versionsBody({
        claude: entry({ latest: '2.0.2', updateAvailable: true }),
        codex: entry({ version: '0.20.0', latest: '0.20.0' }),
        // qoder 没有可查的发布源：有当前版本，但没有 updateSource
        qoder: entry({ version: '1.1.4', updateSource: null, cmd: '/bin/qoderclicn' }),
        kimi: entry({ available: false, version: null }),
      }, 1),
    }),
  });
  await settle();
  openPopover(context.registry);

  const texts = rowTexts(context.registry);
  assert.equal(texts.length, 4);
  assert.match(context.registry['cli-update-summary'].textContent, /1/);
  // Claude Code 在最前：打开浮层就是为了看要升级的那个
  assert.match(texts[0], /Claude Code/);
  assert.match(texts[0], /v2\.0\.1 → v2\.0\.2/);
  assert.match(texts.find(text => text.includes('Codex')), new RegExp(TXT.current));
  // qoder 是「无法检测最新版」，不是「已是最新」
  const qoderRow = texts.find(text => text.includes('Qoder CN'));
  assert.match(qoderRow, new RegExp(TXT.unknownSource));
  assert.doesNotMatch(qoderRow, new RegExp(TXT.current));
  assert.match(texts.find(text => text.includes('Kimi Code')), new RegExp(TXT.notInstalled));
  assert.equal(rowButtons(context.registry).length, 1);
});

// ── Upgrade ────────────────────────────────────────────────────────────────
test('升级前必须问过用户；有会话在用该 CLI 时把风险说清楚', async () => {
  const fetchImpl = createFetch({
    '/api/cli/versions': versionsBody({
      claude: entry({ latest: '2.0.2', updateAvailable: true, inUseCount: 3 }),
    }, 1),
  });
  const refused = buildContext({ fetchImpl, confirmResult: false });
  await settle();
  openPopover(refused.registry);
  rowButtons(refused.registry)[0].onclick();
  await settle();
  assert.equal(refused.asked.length, 1);
  assert.match(refused.asked[0], /Claude Code/);
  assert.match(refused.asked[0], /3/, '要说出有几个会话正在用它');
  assert.deepEqual(fetchImpl.calls.map(call => call.path), ['/api/cli/versions'], '用户拒绝时不能发出升级请求');
});

test('确认后跑官方升级、轮询到完成，并用 ?refresh=1 让角标清零', async () => {
  const fetchImpl = createFetch({
    '/api/cli/versions': versionsBody({ claude: entry({ latest: '2.0.2', updateAvailable: true }) }, 1),
    '/api/cli/versions?refresh=1': versionsBody({ claude: entry({ version: '2.0.2', latest: '2.0.2' }) }, 0),
    'POST /api/cli/claude/upgrade': { status: 202, body: { ok: true, jobId: 'job_1', cli: 'claude' } },
    '/api/cli/install-status/job_1': {
      ok: true,
      body: { ok: true, job: { id: 'job_1', cli: 'claude', status: 'done', exitCode: 0, error: null, logTail: 'upgraded to 2.0.2\n' } },
    },
  });
  const context = buildContext({ fetchImpl, confirmResult: true });
  await settle();
  openPopover(context.registry);
  rowButtons(context.registry)[0].onclick();
  await settle();

  assert.ok(fetchImpl.called('POST', '/api/cli/claude/upgrade'), '升级要 POST 到 upgrade');
  assert.ok(fetchImpl.called('GET', '/api/cli/install-status/job_1'));
  assert.ok(fetchImpl.called('GET', '/api/cli/versions?refresh=1'), '升级成功后必须重探，而不是回放旧缓存');
  assert.equal(context.registry['cli-update-badge'].hidden, true, '升级完成角标要消失');
  assert.match(context.registry['cli-update-log'].textContent, /2\.0\.2/);
});

test('升级请求被拒时把错误说出来，不留下一个假装在跑的按钮', async () => {
  const fetchImpl = createFetch({
    '/api/cli/versions': versionsBody({ claude: entry({ latest: '2.0.2', updateAvailable: true }) }, 1),
    'POST /api/cli/claude/upgrade': { status: 409, ok: false, body: { ok: false, running: true, error: 'busy' } },
  });
  const context = buildContext({ fetchImpl });
  await settle();
  openPopover(context.registry);
  rowButtons(context.registry)[0].onclick();
  await settle();
  const button = rowButtons(context.registry)[0];
  assert.equal(button.disabled, false, '失败后按钮要恢复，不能永久禁用');
  assert.match(rowTexts(context.registry)[0], /busy/);
});

// 用户抱怨的「升级按钮一次只能点一个」: 不同 CLI 之间本来就没有冲突(服务端只对同一
// 个安装目标 409), 界面不该用一个全局开关把它们串起来。
test('两个 CLI 可以同时升级，完成的那一个不会擦掉另一个的进度', async () => {
  const codexStatus = { value: 'running' };
  const fetchImpl = createFetch({
    '/api/cli/versions': versionsBody({
      claude: entry({ latest: '2.0.2', updateAvailable: true }),
      codex: entry({ version: '0.20.0', latest: '0.21.0', updateAvailable: true }),
    }, 2),
    '/api/cli/versions?refresh=1': versionsBody({
      claude: entry({ version: '2.0.2', latest: '2.0.2' }),
      codex: entry({ version: '0.20.0', latest: '0.21.0', updateAvailable: true }),
    }, 1),
    'POST /api/cli/claude/upgrade': { status: 202, body: { ok: true, jobId: 'job_claude', cli: 'claude' } },
    'POST /api/cli/codex/upgrade': { status: 202, body: { ok: true, jobId: 'job_codex', cli: 'codex' } },
    '/api/cli/install-status/job_claude': {
      ok: true,
      body: { ok: true, job: { id: 'job_claude', cli: 'claude', status: 'done', exitCode: 0, error: null, logTail: 'claude upgraded\n' } },
    },
    '/api/cli/install-status/job_codex': () => ({
      ok: true,
      body: {
        ok: true,
        job: { id: 'job_codex', cli: 'codex', status: codexStatus.value, exitCode: null, error: null, logTail: 'installing codex\n' },
      },
    }),
  });
  const context = buildContext({ fetchImpl });
  await settle();
  openPopover(context.registry);
  const buttons = rowButtons(context.registry);
  assert.equal(buttons.length, 2, '两个 CLI 都该有升级按钮');
  buttons[0].onclick();
  buttons[1].onclick();
  await settle();
  assert.ok(fetchImpl.called('POST', '/api/cli/claude/upgrade'), '第二个升级不该被第一个挡住');
  assert.ok(fetchImpl.called('POST', '/api/cli/codex/upgrade'));

  // claude 已经完成并触发了一次刷新: 重建后的 codex 行必须还在「升级中」且按钮禁用
  const codexRow = rowTexts(context.registry).find(text => text.includes('Codex'));
  assert.match(codexRow, new RegExp(TXT.upgrading), '完成的那一个不能把另一个的进度擦掉');
  const disabled = rowButtons(context.registry).filter(button => button.disabled);
  assert.equal(disabled.length, 1, '只剩还在跑的那个按钮是禁用的');
  assert.notEqual(context.registry['cli-update-log'].textContent, '', '进度日志不能是空的');

  // 第二个跑完后一切归位: 角标清零, 按钮不再禁用
  codexStatus.value = 'done';
  await new Promise(resolve => setTimeout(resolve, 3000));
  assert.equal(rowButtons(context.registry).filter(button => button.disabled).length, 0);
  assert.match(context.registry['cli-update-log'].textContent, /installing codex/);
  // 角标数的是「还剩几个可升级」: claude 已完成, 桩里 codex 仍是旧版, 所以是 1。
  assert.equal(context.registry['cli-update-badge'].textContent, '1');
});

// 升级「命令成功但没作用到派生的二进制」这类失败, 服务端会带回具体原因(hint);
// 只显示一行退出码用户无从下手。
test('升级失败时把服务端查明的具体原因一并说出来', async () => {
  const hint = '新版本装到了另一个位置，multicc 实际派生的这个二进制没有变化。解决办法二选一：① 设置环境变量 CLAUDE_CMD …';
  const fetchImpl = createFetch({
    '/api/cli/versions': versionsBody({ claude: entry({ latest: '2.0.2', updateAvailable: true }) }, 1),
    'POST /api/cli/claude/upgrade': { status: 202, body: { ok: true, jobId: 'job_hint', cli: 'claude' } },
    '/api/cli/install-status/job_hint': {
      ok: true,
      body: {
        ok: true,
        job: {
          id: 'job_hint', cli: 'claude', status: 'error', exitCode: 0,
          error: '升级命令已完成，但 multicc 派生的 /bin/claude 仍是 v2.0.1',
          hint, logTail: 'changed 1 package\n',
        },
      },
    },
  });
  const context = buildContext({ fetchImpl });
  await settle();
  openPopover(context.registry);
  rowButtons(context.registry)[0].onclick();
  await settle();
  assert.match(rowTexts(context.registry)[0], /v2\.0\.1/);
  assert.match(context.registry['cli-update-log'].textContent, /CLAUDE_CMD/);
});
