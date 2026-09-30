'use strict';

// Client-side guard for public/manage-official-accounts.js (官方账号多登录区块):
// 旧管理台整页删掉之后，画这张卡的是 Air 的「Provider · 高级」面板 —— air.html must
// load it (plus quota-bar-view.js) before air-provider-advanced.js, the card
// container it queries by id must exist, and the quota renderers must pin their
// remaining-% math and escaping — they display server data as innerHTML.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SOURCE_PATH = path.join(ROOT, 'public', 'manage-official-accounts.js');

// 旧页删掉之后这个模块只剩 Air 在用，文案全部搬进词典（tr → window.t）。下面几条断的
// 还是渲染出来的中文，所以沙箱要装一个真正查 zh.json 的 t()，而不是回退成 key。
const zh = JSON.parse(fs.readFileSync(path.join(ROOT, 'app', 'assets', 'i18n', 'zh.json'), 'utf8'));
const t = (key, params) => String(zh[key] == null ? key : zh[key])
  .replace(/\{(\w+)\}/g, (whole, name) => (params && params[name] != null ? String(params[name]) : whole));

function loadModule() {
  const context = vm.createContext({
    window: { t },
    document: {
      body: { dataset: {}, appendChild() {} },
      getElementById: () => null,
      addEventListener() {},
      createElement: () => ({ style: {}, querySelector: () => null }),
    },
    MutationObserver: class { observe() {} },
    setInterval,
    clearInterval,
    Date,
  });
  context.window.MutationObserver = context.MutationObserver;
  vm.runInContext(fs.readFileSync(SOURCE_PATH, 'utf8'), context, { filename: 'manage-official-accounts.js' });
  return context;
}

test('Air draws the official-accounts card the module expects, and loads it in order', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'air.html'), 'utf8');
  const panel = fs.readFileSync(path.join(ROOT, 'public', 'air-provider-advanced.js'), 'utf8');
  assert.ok(panel.includes("'official-accounts-card'"), 'card container must exist');
  assert.ok(panel.includes("body.id = 'official-accounts-body'"), 'list body must exist');
  // 模块只认 data-act="add" + data-vendor 的事件委托，骨架用 dataset 把这两颗按钮标出来。
  assert.match(panel, /control\.dataset\.act = 'add'/, 'the add buttons must carry data-act="add"');
  assert.match(panel, /control\.dataset\.vendor = vendor/, 'the add buttons must carry data-vendor');
  assert.match(panel, /\['codex', [^\]]*\], \['claude', /, 'both vendors must get an add button');
  const quotaView = html.indexOf('<script src="quota-bar-view.js"></script>');
  const mod = html.indexOf('<script src="manage-official-accounts.js"></script>');
  const advanced = html.indexOf('<script src="air-provider-advanced.js"></script>');
  assert.ok(quotaView >= 0, 'quota-bar-view.js must be loaded (bar placeholder expansion)');
  assert.ok(mod > quotaView, 'module loads after quota-bar-view.js');
  assert.ok(advanced > mod, 'module must be loaded before the panel that mounts its card');
});

test('Codex add and relogin open the terminal client with its id parameter', async () => {
  for (const act of ['add', 'relogin']) {
    let click;
    const opened = [];
    const nodes = new Map();
    const overlay = {
      style: {}, remove() {},
      querySelector(selector) {
        if (!nodes.has(selector)) nodes.set(selector, { value: 'test account' });
        return nodes.get(selector);
      },
    };
    const sessionId = 'codex-acct-login-test';
    const context = vm.createContext({
      window: {
        t,
        MultiCCApi: { json: async () => ({ loginSessionId: sessionId }) },
        open: (url, target) => opened.push({ url, target }),
      },
      document: {
        body: { dataset: {}, appendChild() {} },
        getElementById: () => null,
        addEventListener: (name, handler) => { if (name === 'click') click = handler; },
        createElement: () => overlay,
      },
      MutationObserver: class { observe() {} },
      setInterval, clearInterval, Date,
    });
    vm.runInContext(fs.readFileSync(SOURCE_PATH, 'utf8'), context);
    click({ target: { closest: () => ({ dataset: { act, vendor: 'codex', id: 'test' } }) } });
    if (act === 'add') await nodes.get('[data-act="ok"]').onclick();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(opened, [{ url: 'index.html?id=' + sessionId, target: '_blank' }], act);
  }
});

test('the module evaluates cleanly and exposes its surface', () => {
  const ctx = loadModule();
  assert.equal(typeof ctx.window.MultiCCOfficialAccounts.load, 'function');
  assert.equal(typeof ctx.window.MultiCCOfficialAccounts.renderCodexQuota, 'function');
  assert.equal(typeof ctx.window.MultiCCOfficialAccounts.renderClaudeQuota, 'function');
});

test('renderClaudeQuota renders remaining percent per window and escapes resets', () => {
  const ctx = loadModule();
  ctx.window.QuotaBarView = { humanizeCountdown: () => '2h' };
  const { renderClaudeQuota } = ctx.window.MultiCCOfficialAccounts;
  const inTwoHours = new Date(Date.now() + 2 * 3600e3).toISOString();
  const html = renderClaudeQuota({
    status: 'ok',
    usage: {
      five_hour: { utilization: 0.31, resets_at: inTwoHours },
      seven_day: { utilization: 0.985, resets_at: inTwoHours },
    },
  });
  assert.match(html, /5h 剩 69%/, 'five_hour utilization 0.31 → 69% remaining');
  assert.match(html, /周 剩 2%/, 'seven_day rounds to 2% remaining');
  assert.match(html, /#f85149/, 'nearly-exhausted window renders red');
  assert.match(html, /2h/, 'reset countdown is humanized');
});

test('renderClaudeQuota degrades on a foreign usage shape', () => {
  const ctx = loadModule();
  const { renderClaudeQuota } = ctx.window.MultiCCOfficialAccounts;
  assert.match(renderClaudeQuota({ status: 'ok', usage: {} }), /余量不可用/);
});

test('renderCodexQuota paints the server-rendered bar verbatim with plan and credits', () => {
  const ctx = loadModule();
  ctx.window.QuotaBarView = {
    resolveQuotaBar: (bar) => ({
      text: bar.text.replace('{cd:1}', '3d 5h'),
      color: bar.color,
      title: bar.title,
    }),
  };
  const { renderCodexQuota } = ctx.window.MultiCCOfficialAccounts;
  const html = renderCodexQuota({
    status: 'ok',
    planType: 'plus',
    credits: { hasCredits: true, balance: '12.50' },
    bar: { text: '1wk 剩 42% {cd:1}', color: '#58a6ff', title: 'Codex 额度' },
  });
  assert.match(html, /1wk 剩 42% 3d 5h/);
  assert.match(html, /套餐 plus/);
  assert.match(html, /credits \$12\.50/);
  assert.match(html, /#58a6ff/);
});

test('renderCodexQuota never trusts a missing bar', () => {
  const ctx = loadModule();
  const { renderCodexQuota } = ctx.window.MultiCCOfficialAccounts;
  assert.match(renderCodexQuota({ status: 'ok' }), /余量不可用/);
});

test('global account controls switch via account API and retain the singleton provider', async () => {
  let click;
  const body = { innerHTML: '' }, status = {};
  const calls = [];
  let active = 'global';
  const id = 'aaaaaaaaaaaaaaaa';
  const context = vm.createContext({
    window: { t, MultiCCApi: { json: async (url, options) => {
      calls.push({ url, method: options?.method || 'GET' });
      if (url.endsWith('/activate')) { active = id; return { ok: true }; }
      if (url.endsWith('/accounts')) return { accounts: [
        { id: 'global', global: true, active: active === 'global' },
        { id, label: '工作账号', active: active === id, providerName: '官方' },
      ] };
      return { status: 'ok' };
    } } },
    document: { body: { dataset: {} }, getElementById: key => key === 'official-accounts-body' ? body : status,
      addEventListener: (_, handler) => { click = handler; } },
    MutationObserver: class { observe() {} }, setInterval, clearInterval, Date,
    escapeHtml: text => text, loadProviders() {},
  });
  vm.runInContext(fs.readFileSync(SOURCE_PATH, 'utf8'), context);
  await context.window.MultiCCOfficialAccounts.load();
  assert.match(body.innerHTML, /当前使用/);
  assert.match(body.innerHTML, /切换使用/);
  assert.doesNotMatch(body.innerHTML, /data-act="delete"[^>]*data-id="global"/);
  click({ target: { closest: () => ({ dataset: { act: 'activate', vendor: 'codex', id } }) } });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(calls.some(c => c.url === `/api/codex/accounts/${id}/activate` && c.method === 'POST'));
  assert.doesNotMatch(body.innerHTML, new RegExp(`data-act="delete"[^>]*data-id="${id}"`));
  assert.match(status.textContent, /已全局切换/);
});
