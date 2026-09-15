'use strict';

// 分享出去的页面就是聊天页本身（/share/<token> 送的是 public/chat.html），
// 所以「分享」这件事只允许有一份实现：public/chat-share-mode.js。
//
// 这个测试守两件事：
//   1. 那一份实现的每条判断（谁、能做什么、连接怎么带凭证、哪些界面要收起来）
//      都有确定答案，尤其是默认最小权限这条 —— 答复没到之前不能先亮出写权限。
//   2. chat.html 确实先加载它再加载 chat.js（chat.js 在顶层就按它分流），
//      并且管理员页面不受影响（类名机制只在 share-mode 下生效）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SHARE_MODE_SOURCE = fs.readFileSync(path.join(ROOT, 'public', 'chat-share-mode.js'), 'utf8');
const SHARE_MODE_CSS = fs.readFileSync(path.join(ROOT, 'public', 'chat-share-mode.css'), 'utf8');
const CHAT_HTML = fs.readFileSync(path.join(ROOT, 'public', 'chat.html'), 'utf8');

const jsonResponse = (body, status = 200) => ({
  ok: status < 300, status, json: async () => body,
});

// vm 里造出来的对象原型跟本 realm 不同，deepStrictEqual 会因为这个报错。
// 这些断言比的全是纯数据，过一遍 JSON 只去掉原型差异，不改任何值。
const plain = (value) => JSON.parse(JSON.stringify(value));

// 极简 DOM：只做这个模块真正用到的几件事，并且 querySelector 是按 innerHTML 里
// 写死的 id 去找的 —— 也就是说卡片里少写一个 id，测试会红，而不是被桩吞掉。
function createElement(id) {
  const element = {
    id,
    innerHTML: '',
    value: '',
    disabled: false,
    style: { cssText: '' },
    listeners: {},
    addEventListener(name, listener) {
      (element.listeners[name] = element.listeners[name] || []).push(listener);
    },
    focus() { element.focused = true; },
    async dispatch(name, event = {}) {
      for (const listener of element.listeners[name] || []) await listener(event);
    },
    // 先在 innerHTML 里确认这个 id 真的写出来了，再交出节点：卡片里少写一个
    // id，模块拿到的是 null、当场抛错，测试不会因为桩太宽容而放过。
    querySelector(selector) {
      const target = selector.startsWith('#') ? selector.slice(1) : selector;
      if (!new RegExp(`id="${target}"`).test(element.innerHTML)) return null;
      return nodeFor(target);
    },
  };
  return element;
}

const nodes = new Map();
function nodeFor(id) {
  if (!nodes.has(id)) nodes.set(id, createElement(id));
  return nodes.get(id);
}

function createHarness({ pathname = '/share/tok-1', injected = null, fetchImpl } = {}) {
  nodes.clear();
  const classes = new Set();
  const appended = [];
  const reloads = [];
  const calls = [];
  const document = {
    documentElement: {
      classList: {
        add: (name) => classes.add(name),
        toggle: (name, on) => { if (on) classes.add(name); else classes.delete(name); },
        contains: (name) => classes.has(name),
      },
    },
    body: { appendChild: (node) => appended.push(node) },
    getElementById: (id) => appended.find(node => node.id === id) || null,
    createElement: (tag) => {
      const element = createElement(tag);
      element.tag = tag;
      return element;
    },
  };
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return fetchImpl(url, init);
  };
  const window = {
    document,
    location: { pathname, reload: () => reloads.push(pathname) },
    fetch,
    ...(injected ? { __multiccShare: injected } : {}),
  };
  const context = { window, URL, URLSearchParams, encodeURIComponent, decodeURIComponent, console };
  vm.runInNewContext(SHARE_MODE_SOURCE, context);
  return { share: window.MultiCCShareMode, classes, appended, reloads, calls, window };
}

test('only a /share/<token> path is a share page, and the token is read exactly once', () => {
  for (const pathname of ['/chat.html', '/manage', '/', '/sharing/x', '/share']) {
    const { share } = createHarness({ pathname, fetchImpl: () => jsonResponse({}) });
    assert.equal(share.active(), false, `${pathname} must not be a share page`);
    assert.equal(share.token(), '');
  }
  const { share } = createHarness({ pathname: '/share/tok-1/', fetchImpl: () => jsonResponse({}) });
  assert.equal(share.active(), true);
  assert.equal(share.token(), 'tok-1');
  // 带编码的 token 要还原，否则请求会打到另一个链接上。
  const encoded = createHarness({ pathname: '/share/a%2Fb', fetchImpl: () => jsonResponse({}) });
  assert.equal(encoded.share.token(), 'a/b');
  // 服务端注进文档的 token 优先于路径（预留给后续免请求启动）。
  const injected = createHarness({ pathname: '/chat.html', injected: { token: 'from-doc' }, fetchImpl: () => jsonResponse({}) });
  assert.equal(injected.share.active(), true);
  assert.equal(injected.share.token(), 'from-doc');
});

test('permission is asked once, and nothing is granted before the answer arrives', async () => {
  let resolveFetch;
  const pending = createHarness({ fetchImpl: () => new Promise((resolve) => { resolveFetch = resolve; }) });
  const asked = pending.share.prepare();
  // 答复没到：默认最小权限。先亮出写权限再收回，比多等一下危险得多。
  assert.equal(pending.share.isReady(), false);
  assert.equal(pending.share.canOperate(), false);
  assert.equal(pending.share.isSnapshot(), false);
  const url = new URL('http://127.0.0.1:3000/chat.html?session=s1');
  assert.equal(pending.share.decorateWsUrl(url).searchParams.get('share'), null);
  pending.share.applyChrome();
  assert.equal(pending.classes.has('share-mode'), true);
  assert.equal(pending.classes.has('share-view-only'), true, '未确认权限时输入区必须收起');

  resolveFetch(jsonResponse({ access: 'operate', type: 'session', label: 'L', sessionId: 's1' }));
  await asked;
  assert.equal(pending.share.canOperate(), true);
  assert.equal(pending.share.isReady(), true);
  // 问第二遍不能再发请求：两个答案会让页面自相矛盾。
  await pending.share.prepare();
  assert.equal(pending.calls.length, 1);
  assert.equal(pending.calls[0].url, '/api/share/tok-1/entry');
  assert.equal(pending.calls[0].init.credentials, 'same-origin');
  assert.equal(pending.calls[0].init.cache, 'no-store');
});

test('entry answer classifies into ok / locked / gone / error without ever guessing', async () => {
  const ok = createHarness({ fetchImpl: () => jsonResponse({ access: 'view', type: 'session', label: '标题', sessionId: 's9' }) });
  const resolved = await ok.share.prepare();
  assert.deepEqual(plain(resolved), {
    state: 'ok', token: 'tok-1', access: 'view', type: 'session', label: '标题', sessionId: 's9', messages: [],
  });
  // 服务端没说 access 就是只读，不是可写。
  const vague = createHarness({ fetchImpl: () => jsonResponse({ sessionId: 's9' }) });
  assert.equal((await vague.share.prepare()).access, 'view');
  assert.equal(vague.share.canOperate(), false);
  // 快照分享把消息内联给全，页面不再需要第二个来源。
  const snapshot = createHarness({
    fetchImpl: () => jsonResponse({ access: 'view', type: 'messages', label: '片段', messages: [{ id: 'm1' }] }),
  });
  const snapshotInfo = await snapshot.share.prepare();
  assert.equal(snapshotInfo.type, 'messages');
  assert.equal(snapshot.share.isSnapshot(), true);
  assert.deepEqual([...snapshotInfo.messages], [{ id: 'm1' }]);

  const locked = createHarness({ fetchImpl: () => jsonResponse({ needPassword: true }, 401) });
  assert.equal((await locked.share.prepare()).state, 'locked');
  const gone = createHarness({ fetchImpl: () => jsonResponse({ error: 'gone' }, 404) });
  assert.equal((await gone.share.prepare()).state, 'gone');
  // 网络不通 / 5xx / 答复不可解析都不是「链接失效」：链接还在，只是这次没问到。
  const offline = createHarness({ fetchImpl: () => { throw new Error('ECONNREFUSED'); } });
  assert.equal((await offline.share.prepare()).state, 'error');
  const broken = createHarness({ fetchImpl: () => jsonResponse({}, 503) });
  assert.match((await broken.share.prepare()).message, /503/);
  const garbage = createHarness({ fetchImpl: () => ({ ok: true, status: 200, json: async () => { throw new Error('not json'); } }) });
  assert.equal((await garbage.share.prepare()).state, 'error');
  // 没有 token 就没有链接可言，也不该发请求。
  const unknown = createHarness({ pathname: '/chat.html', fetchImpl: () => jsonResponse({}) });
  assert.equal((await unknown.share.prepare()).state, 'gone');
  assert.equal(unknown.calls.length, 0);
});

test('the share connection carries the token, and a snapshot never opens one', async () => {
  const live = createHarness({ fetchImpl: () => jsonResponse({ access: 'operate', type: 'session', sessionId: 's1' }) });
  await live.share.prepare();
  const url = new URL('http://127.0.0.1:3000/chat.html');
  live.share.decorateWsUrl(url);
  assert.equal(url.searchParams.get('share'), 'tok-1');
  // 会话由链接决定，不由接收方的本地状态决定。
  assert.equal(url.searchParams.get('session'), 's1');

  const noSession = createHarness({ fetchImpl: () => jsonResponse({ access: 'view', type: 'session' }) });
  await noSession.share.prepare();
  const bare = new URL('http://127.0.0.1:3000/chat.html?session=local');
  noSession.share.decorateWsUrl(bare);
  assert.equal(bare.searchParams.get('share'), 'tok-1');
  assert.equal(bare.searchParams.get('session'), 'local', '服务端没给会话时不要清掉原有的');

  const snapshot = createHarness({ fetchImpl: () => jsonResponse({ access: 'view', type: 'messages', messages: [] }) });
  await snapshot.share.prepare();
  const untouched = new URL('http://127.0.0.1:3000/chat.html');
  snapshot.share.decorateWsUrl(untouched);
  assert.equal(untouched.searchParams.get('share'), null, '快照没有活会话，不该建连接');
});

test('share chrome hides administrator controls and the composer only when read-only', async () => {
  const writable = createHarness({ fetchImpl: () => jsonResponse({ access: 'operate', type: 'session', sessionId: 's1' }) });
  await writable.share.prepare();
  writable.share.applyChrome();
  assert.equal(writable.classes.has('share-mode'), true);
  assert.equal(writable.classes.has('share-view-only'), false);

  const readOnly = createHarness({ fetchImpl: () => jsonResponse({ access: 'view', type: 'session', sessionId: 's1' }) });
  await readOnly.share.prepare();
  readOnly.share.applyChrome();
  assert.equal(readOnly.classes.has('share-view-only'), true);

  // 「允许继续对话」是权限，不是界面状态：同一份页面，只有这个类名在变。
  assert.match(SHARE_MODE_CSS, /\.share-mode \.session-only\s*\{\s*display:\s*none\s*!important/);
  assert.match(SHARE_MODE_CSS, /\.share-mode\.share-view-only #input-bar/);
  // 管理员页面不带这个类名，收起来的东西一件都不能少。
  assert.doesNotMatch(SHARE_MODE_CSS, /^\s*(html|body)?\s*\.session-only\s*\{/m);
});

test('a share that cannot be opened explains itself instead of showing a broken chat page', async () => {
  const ok = createHarness({ fetchImpl: () => jsonResponse({ access: 'view', type: 'session', sessionId: 's1' }) });
  await ok.share.prepare();
  assert.equal(ok.share.mountOverlay(), null, '正常分享不该有覆盖层');

  const locked = createHarness({ fetchImpl: () => jsonResponse({ needPassword: true }, 401) });
  await locked.share.prepare();
  const gate = locked.share.mountOverlay();
  assert.equal(gate.id, 'share-gate');
  assert.match(gate.innerHTML, /需要访问密码/);
  const password = nodeFor('share-pw');
  const message = nodeFor('share-msg');
  const submit = nodeFor('share-go');
  assert.equal(password.focused, true, '密码框应直接聚焦');

  // 空密码不发请求，只提示。
  await submit.dispatch('click');
  assert.equal(message.textContent, '请输入密码');
  assert.equal(locked.calls.length, 1);

  // 密码错了要说清楚，并且允许再试。
  const rejected = createHarness({ fetchImpl: () => jsonResponse({ error: '密码错误' }, 401) });
  await rejected.share.prepare();
  rejected.share.mountOverlay();
  nodeFor('share-pw').value = 'wrong';
  await nodeFor('share-go').dispatch('click');
  assert.equal(nodeFor('share-msg').textContent, '密码错误');
  assert.equal(nodeFor('share-go').disabled, false);
  assert.deepEqual(plain(rejected.calls.at(-1)), {
    url: '/api/share/tok-1/auth',
    init: {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'wrong' }),
    },
  });

  // 密码对了：不再猜权限，重载让页面带着新 cookie 重问一遍。
  const retry = createHarness({
    fetchImpl: (url) => (url.endsWith('/auth')
      ? jsonResponse({ ok: true }, 200)
      : jsonResponse({ needPassword: true }, 401)),
  });
  await retry.share.prepare();
  retry.share.mountOverlay();
  nodeFor('share-pw').value = 'pw';
  await nodeFor('share-go').dispatch('click');
  assert.deepEqual(retry.reloads, ['/share/tok-1']);

  const gone = createHarness({ fetchImpl: () => jsonResponse({}, 404) });
  await gone.share.prepare();
  assert.match(gone.share.mountOverlay().innerHTML, /链接无效/);

  const offline = createHarness({ fetchImpl: () => { throw new Error('offline'); } });
  await offline.share.prepare();
  const error = offline.share.mountOverlay();
  assert.match(error.innerHTML, /暂时打不开/);
  await nodeFor('share-retry').dispatch('click');
  assert.deepEqual(offline.reloads, ['/share/tok-1'], '「这次没问到」要能重试');
});

test('the share view stands in for a task shell so the same renderer can boot', async () => {
  const { share } = createHarness({ fetchImpl: () => jsonResponse({ access: 'operate', type: 'session', sessionId: 's1' }) });
  const sessions = [];
  const view = share.createView({ onSession: (id) => sessions.push(id) });
  // 分享页没有 shell：不能因为缺 shell 就让渲染器走别的分支。
  assert.equal(view.shellId, null);
  assert.equal(view.activeSessionId, '');
  assert.equal(await view.prepare(), 's1');
  assert.deepEqual(sessions, ['s1']);
  assert.equal(view.activeSessionId, 's1');
  // 事件原样过：没有 shell 就没有来源重映射。
  assert.deepEqual(view.event({ type: 'message' }), { type: 'message' });
  // 历史分页走分享端点，接收方不需要管理员的历史接口权限。
  assert.equal(view.historyUrl(), '/api/share/tok-1/history');

  const dead = createHarness({ fetchImpl: () => jsonResponse({}, 404) });
  const deadView = dead.share.createView({});
  assert.equal(await deadView.prepare(), '');
  assert.equal(dead.share.createView({}).shellId, null);
});

test('chat.html loads the share strategy before chat.js and keeps one chat renderer', () => {
  // chat.js 在顶层就判断这一页是不是分享页，模块必须已经在。
  assert.ok(
    CHAT_HTML.indexOf('src="chat-share-mode.js"') < CHAT_HTML.indexOf('src="chat.js"'),
    'chat-share-mode.js must load before chat.js',
  );
  assert.match(CHAT_HTML, /href="chat-share-mode\.css"/);
  // /share/<token> 底下相对路径会解析到 /share/，base 让两种入口读同一批资源。
  assert.match(CHAT_HTML, /<base href="\/" \/>/);
  assert.ok(
    CHAT_HTML.indexOf('<base href="/" />') < CHAT_HTML.indexOf('<script src='),
    'base must be set before any resource is resolved',
  );
  // 分享页不再是另一份页面：chat.js 里不该再有通往第二套渲染器的分支。
  const chatJs = fs.readFileSync(path.join(ROOT, 'public', 'chat.js'), 'utf8');
  assert.doesNotMatch(chatJs, /share\.html/);
  assert.match(chatJs, /const SHARE_MODE = !!\(window\.MultiCCShareMode && window\.MultiCCShareMode\.active\(\)\);/);
  // 分享页的启动推迟到权限确定之后，但走的是同一条 connect 路径。
  const boot = fs.readFileSync(path.join(ROOT, 'public', 'chat-task-boot.js'), 'utf8');
  const bootChatEntry = boot.indexOf('async function bootChatEntry()');
  const delegated = boot.indexOf('bootShareEntry()', bootChatEntry);
  const readOnlyBranch = boot.indexOf("_params.get('readOnly')", bootChatEntry);
  assert.ok(delegated > bootChatEntry && delegated < readOnlyBranch,
    'bootChatEntry must delegate to bootShareEntry before any other entry route');
});
