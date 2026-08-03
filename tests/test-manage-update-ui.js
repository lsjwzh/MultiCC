'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'public/manage-update.js'), 'utf8');
const MANAGE_HTML = fs.readFileSync(path.join(ROOT, 'public/manage.html'), 'utf8');

// ── Minimal DOM ────────────────────────────────────────────────────────────
// Only what manage-update.js touches. Same convention as the other public/*
// tests in this suite: a hand-written shim, so the module under test runs
// unmodified rather than being refactored for testability.
class FakeNode {
  constructor(tag) {
    this.tagName = String(tag || '').toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.style = { cssText: '' };
    this._text = '';
    this.className = '';
    this.onclick = null;
    this.scrollHeight = 0;
    this.scrollTop = 0;
    this.clientHeight = 0;
  }

  set textContent(value) {
    this.children.forEach((child) => { child.parentNode = null; });
    this.children = [];
    this._text = String(value == null ? '' : value);
  }

  get textContent() {
    if (this.children.length) return this.children.map(child => child.textContent).join('');
    return this._text;
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter(node => node !== this);
    this.parentNode = null;
  }

  // Depth-first collection used by the assertions below.
  descendants() {
    return this.children.flatMap(child => [child, ...child.descendants()]);
  }
}

function buildContext({ fetchImpl, elements = {} }) {
  const body = new FakeNode('body');
  // The sidebar hint is the only progress the user sees once the dialog is
  // backgrounded, so every value it is given is recorded, not just the last.
  const hint = new FakeNode('div');
  const hintLog = [];
  Object.defineProperty(hint, 'textContent', {
    get() { return hintLog.length ? hintLog[hintLog.length - 1] : ''; },
    set(value) { hintLog.push(String(value == null ? '' : value)); },
  });
  const registry = { 'ver-hint': hint, ...elements };
  const reloads = [];
  const toasts = [];
  const document = {
    body,
    createElement: tag => new FakeNode(tag),
    getElementById: id => registry[id] || null,
    addEventListener() {},
    removeEventListener() {},
  };
  // Virtual clock: setTimeout fires on the next tick but still advances the
  // clock the module reads. Without this a poll loop that never reaches a
  // terminal state would spin forever here instead of hitting its own timeout.
  let virtualNow = Date.now();
  const context = {
    document,
    setTimeout: (fn, ms) => { virtualNow += Number(ms) || 0; setImmediate(fn); return 0; },
    Date: new Proxy(Date, { get: (target, prop) => (prop === 'now' ? () => virtualNow : Reflect.get(target, prop)) }),
    clearTimeout() {},
    fetch: fetchImpl,
    location: { reload: () => reloads.push(Date.now()) },
    showToast: (msg, isError) => toasts.push({ msg, isError }),
    console,
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(SOURCE, context, { filename: 'manage-update.js' });
  return { context, body, registry, reloads, toasts, hintLog };
}

// Scripted fetch: paths map to a queue of responses; the last one repeats.
function scriptedFetch(script) {
  const calls = [];
  const queues = new Map(Object.entries(script).map(([key, value]) => [key, value.slice()]));
  const impl = async (url, options = {}) => {
    const pathOnly = String(url).split('?')[0];
    calls.push({ url: pathOnly, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
    const queue = queues.get(pathOnly);
    if (!queue || !queue.length) throw new Error('unscripted fetch: ' + pathOnly);
    const entry = queue.length > 1 ? queue.shift() : queue[0];
    if (entry instanceof Error) throw entry;
    return {
      ok: entry.status == null || (entry.status >= 200 && entry.status < 300),
      status: entry.status || 200,
      json: async () => entry.json,
    };
  };
  impl.calls = calls;
  return impl;
}

function findButton(body, label) {
  return body.descendants().find(node => node.tagName === 'BUTTON' && node.textContent === label) || null;
}

function dialogText(body) {
  return body.descendants().map(node => node._text).join('\n');
}

// Lets the module's promise chain drain: each poll iteration awaits a fetch
// plus a collapsed setTimeout, so a handful of macrotask turns is enough.
function settle(turns = 40) {
  let chain = Promise.resolve();
  for (let i = 0; i < turns; i += 1) chain = chain.then(() => new Promise(resolve => setImmediate(resolve)));
  return chain;
}

test('clicking the version row confirms first, then updates and reloads once the server is back', async () => {
  const fetchImpl = scriptedFetch({
    '/api/update/status': [
      { json: { state: 'idle', running: false } },
      { json: { state: 'running', running: true, tail: 'Updating MultiCC (branch: main)...' } },
      { json: { state: 'succeeded', running: false, exitCode: 0, tail: 'Update complete (aaaaaaa → bbbbbbb).' } },
    ],
    '/api/version-check': [{ json: { current: '2.16.0', channel: 'dev', latest: 'v2.17.0', latestVersion: '2.17.0', updateAvailable: true } }],
    '/api/update': [{ status: 202, json: { ok: true, status: 'started', force: false, activeStreaming: 2 } }],
    '/api/server-info': [{ json: { uptimeMs: 900 } }],
  });
  const { context, body, registry, reloads, toasts } = buildContext({ fetchImpl });

  await context.onVersionBarClick();
  // Nothing has been started yet — the user has only been asked.
  assert.equal(fetchImpl.calls.some(call => call.url === '/api/update'), false);
  const text = dialogText(body);
  assert.match(text, /当前版本：v2\.16\.0（通道：dev）/);
  assert.match(text, /最新版本：v2\.17\.0/);
  assert.match(text, /完成后自动重启服务/);

  const confirm = findButton(body, '立即更新');
  assert.ok(confirm, 'the confirm dialog must offer to install the update');
  confirm.onclick();
  await settle();

  const post = fetchImpl.calls.find(call => call.url === '/api/update');
  assert.ok(post, 'confirming must start the update');
  assert.deepEqual(post.body, { force: false });
  assert.equal(post.method, 'POST');
  assert.ok(toasts.some(t => /2 个会话正在输出/.test(t.msg)), 'the user is warned which turns the restart interrupts');
  assert.equal(reloads.length, 1, 'the page reloads exactly once after the server comes back');
  assert.match(registry['ver-hint'].textContent, /更新完成|重载/);
});

test('the force checkbox is what reaches the API, not a separate button', async () => {
  const fetchImpl = scriptedFetch({
    '/api/update/status': [
      { json: { state: 'idle', running: false } },
      { json: { state: 'succeeded', running: false, exitCode: 0, tail: 'done' } },
    ],
    '/api/version-check': [{ json: { current: '2.16.0', channel: 'dev', latest: 'v2.16.0', updateAvailable: false } }],
    '/api/update': [{ status: 202, json: { ok: true, status: 'started', force: true, activeStreaming: 0 } }],
    '/api/server-info': [{ json: { uptimeMs: 900 } }],
  });
  const { context, body } = buildContext({ fetchImpl });

  await context.onVersionBarClick();
  // Already latest: the row still opens the dialog, but does not pretend a new
  // version exists.
  assert.match(dialogText(body), /当前已是最新/);
  const checkbox = body.descendants().find(node => node.type === 'checkbox');
  assert.ok(checkbox, 'the dialog must expose the force option');
  assert.match(dialogText(body), /本地改动会先备份到 git stash/);
  checkbox.checked = true;

  findButton(body, '仍要更新').onclick();
  await settle();

  const post = fetchImpl.calls.find(call => call.url === '/api/update');
  assert.deepEqual(post.body, { force: true });
});

test('a dropped connection during the restart is progress, not failure', async () => {
  const fetchImpl = scriptedFetch({
    '/api/update/status': [
      { json: { state: 'idle', running: false } },
      { json: { state: 'running', running: true, tail: 'Restarting to apply update...' } },
      new Error('Failed to fetch'),
      new Error('Failed to fetch'),
      { json: { state: 'succeeded', running: false, exitCode: 0, tail: 'Update complete.' } },
    ],
    '/api/version-check': [{ json: { current: '2.16.0', channel: 'dev', latest: 'v2.17.0', latestVersion: '2.17.0', updateAvailable: true } }],
    '/api/update': [{ status: 202, json: { ok: true, status: 'started', force: false, activeStreaming: 0 } }],
    '/api/server-info': [{ json: { uptimeMs: 800 } }],
  });
  const { context, body, reloads, hintLog } = buildContext({ fetchImpl });

  await context.onVersionBarClick();
  findButton(body, '立即更新').onclick();
  await settle(60);

  assert.equal(reloads.length, 1, 'the poll must survive the server going away and come back to a verdict');
  assert.equal(dialogText(body).includes('更新失败'), false);
  // The outage is named, not silently ridden out: "restarting" is the one
  // moment the user must not read as a hang.
  assert.ok(hintLog.some(line => /服务重启中/.test(line)), hintLog.join(' | '));
});

test('a failed update shows the log and offers the force retry it was missing', async () => {
  const fetchImpl = scriptedFetch({
    '/api/update/status': [
      { json: { state: 'idle', running: false } },
      {
        json: {
          state: 'failed',
          running: false,
          exitCode: 1,
          force: false,
          tail: 'Working tree has local changes — stashing them before update...\ngit stash failed',
        },
      },
    ],
    '/api/version-check': [{ json: { current: '2.16.0', channel: 'dev', latest: 'v2.17.0', latestVersion: '2.17.0', updateAvailable: true } }],
    '/api/update': [{ status: 202, json: { ok: true, status: 'started', activeStreaming: 0 } }],
    '/api/server-info': [{ json: {} }],
  });
  const { context, body, reloads } = buildContext({ fetchImpl });

  await context.onVersionBarClick();
  findButton(body, '立即更新').onclick();
  await settle();

  assert.equal(reloads.length, 0, 'a failed update must never reload as if it had worked');
  const text = dialogText(body);
  assert.match(text, /更新失败/);
  assert.match(text, /退出码 1/);
  assert.match(text, /git stash failed/);

  const retry = findButton(body, '强制更新重试');
  assert.ok(retry, 'the failure the force flag exists for must offer it');
  retry.onclick();
  await settle();
  const posts = fetchImpl.calls.filter(call => call.url === '/api/update');
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[1].body, { force: true });
});

test('an update already forced does not offer to force it again', async () => {
  const fetchImpl = scriptedFetch({
    '/api/update/status': [
      { json: { state: 'idle', running: false } },
      { json: { state: 'failed', running: false, exitCode: 1, force: true, tail: 'npm install failed' } },
    ],
    '/api/version-check': [{ json: { current: '2.16.0', channel: 'dev', latest: 'v2.17.0', latestVersion: '2.17.0', updateAvailable: true } }],
    '/api/update': [{ status: 202, json: { ok: true, status: 'started', activeStreaming: 0 } }],
  });
  const { context, body } = buildContext({ fetchImpl });

  await context.onVersionBarClick();
  findButton(body, '立即更新').onclick();
  await settle();

  assert.equal(findButton(body, '强制更新重试'), null);
  assert.ok(findButton(body, '关闭'));
});

test('clicking while an update is already running attaches to it instead of starting a second', async () => {
  const fetchImpl = scriptedFetch({
    '/api/update/status': [
      { json: { state: 'running', running: true, force: true, tail: 'Updating MultiCC...' } },
      { json: { state: 'succeeded', running: false, exitCode: 0, tail: 'Update complete.' } },
    ],
    '/api/server-info': [{ json: { uptimeMs: 700 } }],
  });
  const { context, body, reloads } = buildContext({ fetchImpl });

  await context.onVersionBarClick();
  await settle();

  assert.equal(fetchImpl.calls.some(call => call.url === '/api/update' && call.method === 'POST'), false);
  assert.equal(fetchImpl.calls.some(call => call.url === '/api/version-check'), false);
  assert.equal(reloads.length, 1);
  assert.match(dialogText(body), /更新完成|接管其进度/);
});

test('a run that never reaches a verdict gives up instead of spinning forever', async () => {
  const fetchImpl = scriptedFetch({
    // The log never appears: the child died before its first write.
    '/api/update/status': [{ json: { state: 'idle', running: false } }],
    '/api/version-check': [{ json: { current: '2.16.0', channel: 'dev', latest: 'v2.17.0', latestVersion: '2.17.0', updateAvailable: true } }],
    '/api/update': [{ status: 202, json: { ok: true, status: 'started', activeStreaming: 0 } }],
  });
  const { context, body, reloads } = buildContext({ fetchImpl });

  await context.onVersionBarClick();
  findButton(body, '立即更新').onclick();
  // 20 virtual minutes at 1.5s per poll is ~800 iterations.
  await settle(3000);

  assert.equal(reloads.length, 0);
  assert.match(dialogText(body), /更新超时/);
  assert.ok(findButton(body, '关闭'), 'the timed-out dialog must be dismissable');
});

test('the version row is wired to the update flow with a fallback to a plain check', () => {
  assert.match(MANAGE_HTML, /onclick="\(window\.onVersionBarClick\|\|window\.checkVersion\)\(\)"/);
  assert.match(MANAGE_HTML, /<script src="manage-update\.js"><\/script>/);
  // Load order matters: the module reads _urlToken, a top-level const in manage.js.
  assert.ok(
    MANAGE_HTML.indexOf('manage.js"></script>') < MANAGE_HTML.indexOf('manage-update.js"></script>'),
    'manage-update.js must load after manage.js',
  );
});
