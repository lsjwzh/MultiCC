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

test('Air loads account actions before the Provider add flow and keeps accounts out of More connections', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'air.html'), 'utf8');
  const panel = fs.readFileSync(path.join(ROOT, 'public', 'air-provider-advanced.js'), 'utf8');
  const provider = fs.readFileSync(path.join(ROOT, 'public', 'air-provider.js'), 'utf8');
  assert.doesNotMatch(panel, /official-accounts-card|data-section = 'official'/);
  assert.match(provider, /data-provider-account="claude"/);
  assert.match(provider, /data-provider-account="codex"/);
  const quotaView = html.indexOf('<script src="quota-bar-view.js"></script>');
  const mod = html.indexOf('<script src="manage-official-accounts.js"></script>');
  const advanced = html.indexOf('<script src="air-provider-advanced.js"></script>');
  assert.ok(quotaView >= 0, 'quota-bar-view.js must be loaded (bar placeholder expansion)');
  assert.ok(mod > quotaView, 'module loads after quota-bar-view.js');
  assert.ok(advanced > mod, 'module must be loaded before the panel that mounts its card');
});

test('Codex add and relogin open the sign-in sheet with a callback box, not a terminal', async () => {
  const id = 'dddddddddddddddd';
  const oauthUrl = 'https://auth.openai.com/oauth/authorize?client_id=app_EMoamEEZ73f0CkXaXp7hrann&state=st';
  const calls = [];
  const h = signinHarness(async (url, options) => {
    calls.push({ url, method: options?.method || 'GET', body: options?.json });
    if (url === '/api/codex/accounts' && options?.method === 'POST') return { ok: true, accountId: id, oauthUrl };
    if (url === '/api/codex/accounts') return { accounts: [{ id, label: '小号', loggedIn: false, login: { state: 'pending', oauthUrl } }] };
    if (url === '/api/claude/accounts') return { accounts: [] };
    if (url.endsWith('/relogin')) return { ok: true, accountId: id, oauthUrl };
    if (url.endsWith('/login-status')) return { state: 'pending' };
    return { ok: true };
  });

  h.context.window.MultiCCOfficialAccounts.add('codex');
  const label = h.overlays[0];
  label.querySelector('[data-k="label"]').value = '小号';
  label.querySelector('[data-act="ok"]').onclick();
  await h.flush(); await h.flush();

  assert.deepEqual(h.opened, [], 'nothing opens by itself — no terminal page, no browser tab');
  const panel = h.overlays[1];
  assert.match(panel.innerHTML, /登录 Codex 账号 · 小号/);
  assert.match(panel.innerHTML, /127\.0\.0\.1:1455/, 'the paste hint names the Codex callback');
  assert.equal(panel.q('url').textContent, oauthUrl, 'the whole authorize link is shown');
  panel.q('close').onclick();

  h.click({ target: { closest: () => ({ dataset: { act: 'relogin', vendor: 'codex', id } }) } });
  await h.flush(); await h.flush();
  assert.ok(calls.some(c => c.url === `/api/codex/accounts/${id}/relogin` && c.method === 'POST'));
  const reopened = h.overlays[h.overlays.length - 1];
  assert.equal(reopened.q('url').textContent, oauthUrl, 'relogin reuses the same sheet');
});

test('the module evaluates cleanly and exposes its surface', () => {
  const ctx = loadModule();
  assert.equal(typeof ctx.window.MultiCCOfficialAccounts.load, 'function');
  assert.equal(typeof ctx.window.MultiCCOfficialAccounts.add, 'function');
  assert.equal(typeof ctx.window.MultiCCOfficialAccounts.relogin, 'function');
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
      five_hour: { utilization: 31, resets_at: inTwoHours },
      seven_day: { utilization: 98.5, resets_at: inTwoHours },
    },
  });
  assert.match(html, /5h 剩 69%/, 'five_hour utilization is a 0..100 percent: 31 → 69% remaining');
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
  const body = { innerHTML: '', querySelectorAll: () => [] }, status = {};
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
      addEventListener: (name, handler) => { if (name === 'click') click = handler; } },
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
  assert.match(body.innerHTML, new RegExp(`data-act="delete"[^>]*data-id="${id}"`));
  assert.match(status.textContent, /已全局切换/);
});

// A tiny DOM for the sign-in panel: every overlay hands out one stub per
// data-k / data-act selector, so the test can drive the panel like a user.
function signinHarness(apiImpl) {
  const overlays = [], opened = [], copied = [], toasts = [], ticks = [], later = [];
  const stub = () => ({ value: '', textContent: '', disabled: false, style: {}, dataset: {} });
  const body = { innerHTML: '', querySelectorAll: () => [] };
  let click;
  const context = vm.createContext({
    window: { t, MultiCCApi: { json: apiImpl }, open: (url) => opened.push(url), isSecureContext: true,
      addEventListener() {}, removeEventListener() {} },
    navigator: { clipboard: { writeText: async (text) => { copied.push(text); } } },
    document: {
      body: { dataset: {}, appendChild() {} },
      getElementById: key => key === 'official-accounts-body' ? body : {},
      addEventListener: (name, handler) => { if (name === 'click') click = handler; },
      createElement: () => {
        const parts = {};
        const overlay = { style: {}, innerHTML: '', removed: false, remove() { this.removed = true; },
          querySelector: sel => parts[sel] || (parts[sel] = stub()) };
        overlay.q = k => overlay.querySelector('[data-k="' + k + '"]');
        overlays.push(overlay);
        return overlay;
      },
    },
    MutationObserver: class { observe() {} },
    setInterval: (fn) => { ticks.push(fn); return ticks.length; },
    clearInterval() {},
    setTimeout: (fn) => { later.push(fn); return later.length; },
    Date, escapeHtml: text => text, loadProviders() {}, showToast: (msg, err) => toasts.push({ msg, err: !!err }),
  });
  vm.runInContext(fs.readFileSync(SOURCE_PATH, 'utf8'), context);
  const flush = () => new Promise(resolve => setImmediate(resolve));
  return { context, overlays, opened, copied, toasts, ticks, later, body, flush, click: (...a) => click(...a) };
}

test('adding a Claude account shows the sign-in link and a callback box instead of opening claude.ai', async () => {
  const id = 'cccccccccccccccc';
  const oauthUrl = 'https://claude.ai/oauth/authorize?code=true&state=st';
  const calls = [];
  let status = 'pending';
  const h = signinHarness(async (url, options) => {
    calls.push({ url, method: options?.method || 'GET', body: options?.json });
    if (url === '/api/claude/accounts' && options?.method === 'POST') return { ok: true, accountId: id, oauthUrl };
    if (url === '/api/claude/accounts') return { accounts: [{ id, label: 'VPS号', login: { state: status } }] };
    if (url === '/api/codex/accounts') return { accounts: [] };
    if (url.endsWith('/login-callback')) {
      if (options.json.callback.includes('state=wrong')) throw new Error('回调 state 不匹配');
      return { ok: true, accepted: true };
    }
    if (url.endsWith('/login-status')) return { state: status, email: status === 'complete' ? 'me@example.com' : '' };
    return { ok: true };
  });
  h.context.window.MultiCCOfficialAccounts.add('claude');
  const label = h.overlays[0];
  label.querySelector('[data-k="label"]').value = 'VPS号';
  label.querySelector('[data-act="ok"]').onclick();
  await h.flush(); await h.flush();

  assert.deepEqual(h.opened, [], 'nothing opens by itself');
  const panel = h.overlays[1];
  assert.match(panel.innerHTML, /登录 Claude 账号 · VPS号/);
  assert.match(panel.innerHTML, /localhost:54545/);
  assert.equal(panel.q('url').textContent, oauthUrl, 'the whole link is shown');
  assert.equal(panel.q('submit').disabled, true, 'nothing to submit yet');

  panel.q('copy').onclick();
  await h.flush();
  assert.deepEqual(h.copied, [oauthUrl]);
  panel.q('open').onclick();
  assert.deepEqual(h.opened, [oauthUrl], 'opening is the user\'s own click');

  const input = panel.q('callback');
  input.value = 'http://localhost:54545/callback?code=bad&state=wrong';
  input.oninput();
  assert.equal(panel.q('submit').disabled, false);
  await panel.q('form').onsubmit({ preventDefault() {} });
  assert.equal(panel.q('error').textContent, '回调 state 不匹配', 'a rejected paste says why in place');
  assert.equal(input.disabled, false, 'and can be corrected');

  input.value = 'http://localhost:54545/callback?code=good&state=st';
  const first = panel.q('form').onsubmit({ preventDefault() {} });
  panel.q('form').onsubmit({ preventDefault() {} });
  await first;
  const pastes = calls.filter(c => c.url === `/api/claude/accounts/${id}/login-callback`);
  assert.equal(pastes.length, 2, 'the second submit while one is in flight is ignored');
  assert.equal(pastes[1].body.callback, 'http://localhost:54545/callback?code=good&state=st');
  assert.equal(panel.q('phase').textContent, '已接收回调，正在换取令牌…');
  assert.equal(input.disabled, true);

  status = 'complete';
  for (const tick of h.ticks) tick();
  await h.flush(); await h.flush();
  assert.equal(panel.q('phase').textContent, 'Claude 账号登录完成：me@example.com');
  assert.equal(h.toasts.filter(x => /登录完成/.test(x.msg)).length, 0, 'the panel reports it, not a second toast');
  for (const fn of h.later) fn();
  assert.equal(panel.removed, true, 'the panel closes once signed in');
});

test('a pending Claude row reopens the sign-in panel with its link', async () => {
  const id = 'bbbbbbbbbbbbbbbb';
  const oauthUrl = 'https://claude.ai/oauth/authorize?x=1';
  const h = signinHarness(async (url) => {
    if (url === '/api/claude/accounts') return { accounts: [{ id, label: '远程号', loggedIn: false, login: { state: 'pending', oauthUrl } }] };
    if (url === '/api/codex/accounts') return { accounts: [] };
    return { state: 'pending' };
  });
  await h.context.window.MultiCCOfficialAccounts.load();
  assert.match(h.body.innerHTML, /data-act="open-signin"/);
  assert.match(h.body.innerHTML, /继续登录/);
  assert.doesNotMatch(h.body.innerHTML, /data-k="claude-callback"/);
  h.click({ target: { closest: () => ({ dataset: { act: 'open-signin', vendor: 'claude', id } }) } });
  const panel = h.overlays[0];
  assert.equal(panel.q('url').textContent, oauthUrl);
  assert.deepEqual(h.opened, []);
  panel.q('close').onclick();
  assert.equal(panel.removed, true);
});

test('a pending Codex row pastes its callback back to the codex routes', async () => {
  const id = 'eeeeeeeeeeeeeeee';
  const oauthUrl = 'https://auth.openai.com/oauth/authorize?client_id=app_EMoamEEZ73f0CkXaXp7hrann&state=st';
  const calls = [];
  let status = 'pending';
  const h = signinHarness(async (url, options) => {
    calls.push({ url, method: options?.method || 'GET', body: options?.json });
    if (url === '/api/codex/accounts') return { accounts: [{ id, label: '小号', loggedIn: false, login: { state: status, oauthUrl } }] };
    if (url === '/api/claude/accounts') return { accounts: [] };
    if (url.endsWith('/login-callback')) {
      status = 'complete';
      return { ok: true, accepted: true };
    }
    if (url.endsWith('/login-status')) return { state: status, email: status === 'complete' ? 'codex@example.com' : '' };
    return { ok: true };
  });
  await h.context.window.MultiCCOfficialAccounts.load();
  h.click({ target: { closest: () => ({ dataset: { act: 'open-signin', vendor: 'codex', id } }) } });
  const panel = h.overlays[0];
  assert.match(panel.innerHTML, /登录 Codex 账号 · 小号/);
  assert.equal(panel.q('url').textContent, oauthUrl);

  const input = panel.q('callback');
  input.value = 'http://127.0.0.1:1455/auth/callback?code=good&state=st';
  input.oninput();
  await panel.q('form').onsubmit({ preventDefault() {} });
  const paste = calls.find(c => c.url === `/api/codex/accounts/${id}/login-callback`);
  assert.ok(paste, 'the paste goes to the codex route, not the claude one');
  assert.equal(paste.method, 'POST');

  for (const tick of h.ticks) tick();
  await h.flush(); await h.flush();
  assert.equal(panel.q('phase').textContent, 'Codex 账号登录完成：codex@example.com');
});

test('an official Provider card still opens the editor, because the egress-IP allowlist lives only there', () => {
  const provider = fs.readFileSync(path.join(ROOT, 'public', 'air-provider.js'), 'utf8');
  // The editor is the only place the egress-IP allowlist can be set, and the
  // server's official branch of updateProvider accepts exactly that one field. A card
  // that hides "Edit" for official lines (it once did, in favour of "Re-login")
  // leaves the restriction unreachable for the accounts that need it most.
  assert.doesNotMatch(provider, /if \(!provider\.isOfficial\) actions\.append\(button\(t\('airProviderEdit'\)/,
    'the edit button must not be gated on !isOfficial');
  assert.match(provider, /actions\.append\(button\(t\('airProviderEdit'\), \(\) => openEditor\(provider\)\)\)/);
  // Re-login also covers the terminal-login official lines (no account-library
  // entry yet, which is exactly the 401 case), so the gate is account || terminal.
  assert.match(provider, /if \(account \|\| terminal\) actions\.append\(button\(t\('airProviderRelogin'\)/,
    're-login stays, as an extra action next to edit');
  // And the editor keeps its official mode: identity read-only, only the allowlist is written.
  assert.match(provider, /if \(form\.dataset\.official === '1'\) \{[^}]*body = \{ egressIpAllowlist \};/s);
});

// 账号是在「加账号」这一步注册的：登录链接与换码都从这台机器发出，出口必须在这里
// 就选好，而不是登录完再去线路编辑器里补。
test('the add-account sheet picks the egress before the login link is generated', async () => {
  const id = 'ffffffffffffffff';
  const calls = [];
  const h = signinHarness(async (url, options) => {
    calls.push({ url, method: options?.method || 'GET', body: options?.json });
    if (url === '/api/plugins') return { plugins: [{ id: 'chrome-proxy-launcher', engine: { available: true } }] };
    if (url === '/api/plugins/chrome-proxy-launcher/run') return { ok: true, profiles: [{ id: 'us-home', name: 'US Home', egressText: '203.0.113.7' }] };
    if (url === '/api/claude/accounts' && options?.method === 'POST') return { ok: true, accountId: id, oauthUrl: 'https://claude.ai/oauth/authorize?x=1' };
    if (url === '/api/claude/accounts') return { accounts: [] };
    if (url === '/api/codex/accounts') return { accounts: [] };
    return { state: 'pending' };
  });
  h.context.window.MultiCCOfficialAccounts.add('claude');
  const sheet = h.overlays[0];
  await h.flush(); await h.flush(); await h.flush();
  const select = sheet.querySelector('[data-k="egress"]');
  assert.match(select.innerHTML, /US Home · 203\.0\.113\.7/);
  assert.equal(select.value, 'us-home', 'a new account starts on the first egress profile');
  assert.equal(sheet.querySelector('[data-act="open-plugin"]').style.display, 'none');
  sheet.querySelector('[data-k="label"]').value = '出口号';
  sheet.querySelector('[data-act="ok"]').onclick();
  await h.flush(); await h.flush();
  const create = calls.find(c => c.url === '/api/claude/accounts' && c.method === 'POST');
  // 跨 vm realm 的对象原型不同，deepStrictEqual 会拿原型说事，按 JSON 比较。
  assert.deepEqual(JSON.parse(JSON.stringify(create.body)), {
    label: '出口号',
    egressBinding: { pluginId: 'chrome-proxy-launcher', profileId: 'us-home' },
  });
});

test('with no egress profile the sheet says so and points at the isolation plugin', async () => {
  const h = signinHarness(async (url) => {
    if (url === '/api/plugins') return { plugins: [{ id: 'chrome-proxy-launcher', engine: { available: true } }] };
    if (url === '/api/plugins/chrome-proxy-launcher/run') return { ok: true, profiles: [] };
    if (url === '/api/claude/accounts') return { accounts: [] };
    if (url === '/api/codex/accounts') return { accounts: [] };
    return { state: 'pending' };
  });
  h.context.window.MultiCCOfficialAccounts.add('codex');
  const sheet = h.overlays[0];
  await h.flush(); await h.flush(); await h.flush();
  assert.match(sheet.querySelector('[data-k="egress-hint"]').textContent, /还没有身份/);
  assert.equal(sheet.querySelector('[data-k="egress"]').disabled, true);
  const open = sheet.querySelector('[data-act="open-plugin"]');
  assert.notEqual(open.style.display, 'none');
  open.onclick();
  assert.deepEqual(h.opened, ['/air?view=plugins']);
});
