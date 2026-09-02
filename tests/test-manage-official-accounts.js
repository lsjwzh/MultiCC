'use strict';

// Client-side guard for public/manage-official-accounts.js (官方账号多登录区块):
// manage.html must load it (plus quota-bar-view.js) before manage.js, the card
// container must exist, and the quota renderers must pin their remaining-%
// math and escaping — they display server data as innerHTML.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SOURCE_PATH = path.join(ROOT, 'public', 'manage-official-accounts.js');

function loadModule() {
  const context = vm.createContext({
    window: {},
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

test('manage.html wires the official-accounts card and loads the module before manage.js', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'manage.html'), 'utf8');
  assert.ok(html.includes('id="official-accounts-card"'), 'card container must exist');
  assert.ok(html.includes('id="official-accounts-body"'), 'list body must exist');
  assert.ok(html.includes('data-act="add" data-vendor="codex"'), 'codex add button must exist');
  assert.ok(html.includes('data-act="add" data-vendor="claude"'), 'claude add button must exist');
  const quotaView = html.indexOf('<script src="quota-bar-view.js"></script>');
  const mod = html.indexOf('<script src="manage-official-accounts.js"></script>');
  const manage = html.indexOf('<script src="manage.js"></script>');
  assert.ok(quotaView >= 0, 'quota-bar-view.js must be loaded (bar placeholder expansion)');
  assert.ok(mod > quotaView, 'module loads after quota-bar-view.js');
  assert.ok(manage > mod, 'module must be loaded before manage.js');
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
