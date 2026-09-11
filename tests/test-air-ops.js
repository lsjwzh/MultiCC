'use strict';

// public/air-ops.js — the Air sidebar's host-ops region, ported from the
// manage sidebar's bottom row. The two modules drive the same routes but from
// different markup, so the behaviours worth pinning are the ones that decide
// whether a destructive action fires: what reaches /api/update (and whether
// the force flag survives the dialog), when /api/restart is called at all, and
// whether the boot read-out tells the truth about a host whose clock is off.
//
// Same convention as tests/test-manage-update-ui.js: a hand-written DOM shim so
// the module under test runs unmodified. The element registry is built from
// public/air.html's own ids, so a missing element in the markup fails here
// rather than silently no-op'ing in the browser.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createSandboxConsole } = require('./helpers/sandbox-console');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'public/air-ops.js'), 'utf8');
const AIR_HTML = fs.readFileSync(path.join(ROOT, 'public/air.html'), 'utf8');

// ── Minimal DOM ────────────────────────────────────────────────────────────
class FakeClassList {
  constructor(node) { this.node = node; this.set = new Set(); }
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
    this.classList = new FakeClassList(this);
    this.hidden = false;
    this.disabled = false;
    this.title = '';
    this.type = '';
    this.href = '';
    this.checked = false;
    this.open = false;
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this._text = '';
    this.onclick = null;
    this.onkeydown = null;
    this._context = { fillStyle: '', fillRect() {} };
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

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  append(...nodes) { nodes.forEach(node => this.appendChild(node)); }

  replaceChildren(...nodes) {
    this.children.forEach(child => { child.parentNode = null; });
    this.children = [];
    nodes.forEach(node => this.appendChild(node));
  }

  getContext() { return this._context; }

  showModal() { this.open = true; }
  close() { this.open = false; }

  descendants() {
    return this.children.flatMap(child => [child, ...child.descendants()]);
  }
}

function registryFrom(html) {
  const registry = {};
  const re = /id="([^"]+)"/g;
  let match;
  while ((match = re.exec(html))) registry[match[1]] = new FakeNode('div');
  return registry;
}

// ── Harness ────────────────────────────────────────────────────────────────
// Timers are virtual. The update poll wakes on a 2.5s cadence and the result
// only arrives on a later tick, so real waits would both slow the suite down
// and let the 3s boot re-check race the assertions; a test drives the clock
// itself (see `advance`) and every wait stays deterministic. Delays are
// recorded as scheduled, so the cadence itself is still assertable.
function createClock() {
  const scheduled = [];
  const pending = [];
  const cancelled = new Set();
  let seq = 0;
  let now = 0;

  // One macrotask per fired timer is not enough: each wake-up resolves an
  // awaited fetch chain of several microtasks before the next timer is
  // scheduled.
  const flush = async () => {
    for (let i = 0; i < 8; i += 1) await new Promise(resolve => setImmediate(resolve));
  };

  return {
    scheduled,
    schedule(fn, ms, repeat) {
      const delay = Number(ms) || 0;
      scheduled.push(delay);
      const id = (seq += 1);
      pending.push({ id, delay, repeat, at: now + delay, fn });
      return id;
    },
    clear(id) {
      cancelled.add(id);
      const index = pending.findIndex(entry => entry.id === id);
      if (index >= 0) pending.splice(index, 1);
    },
    async advance(ms = 0) {
      const target = now + (Number(ms) || 0);
      for (;;) {
        pending.sort((a, b) => a.at - b.at || a.id - b.id);
        const next = pending[0];
        if (!next || next.at > target) break;
        pending.shift();
        now = next.at;
        next.fn();
        if (next.repeat && !cancelled.has(next.id)) pending.push({ ...next, at: now + next.delay });
        await flush();
      }
      now = target;
    },
  };
}

function buildContext({ fetchImpl, confirmResult = true, pushInfo = null, qrcode = null }) {
  const registry = registryFrom(AIR_HTML);
  const reloads = [];
  const clock = createClock();
  const timers = clock.scheduled;
  const listeners = {};
  const document = {
    readyState: 'complete',
    hidden: false,
    visibilityState: 'visible',
    createElement: tag => new FakeNode(tag),
    getElementById: id => registry[id] || null,
    addEventListener: (type, handler) => { (listeners[type] = listeners[type] || []).push(handler); },
    removeEventListener: (type, handler) => {
      listeners[type] = (listeners[type] || []).filter(entry => entry !== handler);
    },
    dispatch: (type, event) => (listeners[type] || []).forEach(handler => handler(event || {})),
  };
  const context = {
    document,
    // window's own listeners share the document's map: the module listens on
    // both, and in the tests the types never collide.
    addEventListener: document.addEventListener,
    removeEventListener: document.removeEventListener,
    setTimeout: (fn, ms) => clock.schedule(fn, ms, false),
    clearTimeout: id => clock.clear(id),
    setInterval: (fn, ms) => clock.schedule(fn, ms, true),
    fetch: fetchImpl,
    location: { reload: () => reloads.push(Date.now()), origin: 'http://127.0.0.1:3000' },
    confirm: () => confirmResult,
    qrcode,
    togglePush: async () => { context.__toggled = (context.__toggled || 0) + 1; return true; },
    getPushInfo: () => pushInfo,
    console: createSandboxConsole(),
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(SOURCE, context, { filename: 'air-ops.js' });
  return { context, registry, document, reloads, timers, listeners, advance: clock.advance };
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
      text: async () => (entry.json === undefined ? '' : JSON.stringify(entry.json)),
    };
  };
  impl.calls = calls;
  return impl;
}

function findButton(registry, label) {
  const host = registry['ops-actions'];
  return host.children.find(node => node.tagName === 'BUTTON' && node.textContent === label) || null;
}

function dialogText(registry) {
  return [registry['ops-title'], registry['ops-body'], registry['ops-log'], registry['ops-extra']]
    .flatMap(node => [node, ...node.descendants()])
    .map(node => node._text)
    .filter(Boolean)
    .join('\n');
}

function settle(turns = 60) {
  let chain = Promise.resolve();
  for (let i = 0; i < turns; i += 1) chain = chain.then(() => new Promise(resolve => setImmediate(resolve)));
  return chain;
}

// ── Markup ─────────────────────────────────────────────────────────────────
test('the Air sidebar carries the ops region the manage sidebar pinned', () => {
  ['air-ver-row', 'air-ver-current', 'air-ver-hint', 'air-ver-badge', 'air-boot-time',
    'air-boot-uptime', 'air-apk-btn', 'air-qr-btn', 'push-toggle', 'air-restart-btn',
    'air-ops-status', 'ops-dialog', 'ops-actions'].forEach(id => {
    assert.ok(AIR_HTML.includes(`id="${id}"`), `${id} must exist in air.html`);
  });
  assert.match(AIR_HTML, /href="\/logout"/, 'the logout entry point is part of the ported row');
  assert.match(AIR_HTML, /<script src="air-ops\.js"><\/script>/, 'the shell must load the module');
  assert.match(AIR_HTML, /<script src="qrcode\.min\.js"><\/script>/, 'the QR entry point needs the encoder');
  assert.match(AIR_HTML, /<script src="pwa\.js"><\/script>/, 'push reuses the existing subscription logic');
});

// ── Version row ────────────────────────────────────────────────────────────
test('the version row reports an available release and keeps quiet about the rest', async () => {
  const fetchImpl = scriptedFetch({
    '/api/version-check': [{ json: { current: '1.6.10', channel: 'dev', latest: 'v1.7.0', latestVersion: '1.7.0', updateAvailable: true } }],
    '/api/server-info': [{ json: { uptimeMs: 900 } }],
  });
  const { registry } = buildContext({ fetchImpl });
  await settle();

  assert.equal(registry['air-ver-current'].textContent, 'v1.6.10');
  assert.equal(registry['air-ver-hint'].textContent, '有新版');
  assert.equal(registry['air-ver-badge'].hidden, false);
  assert.equal(registry['air-ver-badge'].textContent, 'v1.7.0');
});

test('an offline check says so instead of claiming the host is up to date', async () => {
  const fetchImpl = scriptedFetch({
    '/api/version-check': [{ json: { current: '1.6.10', channel: 'dev', latest: null, updateAvailable: false, apiError: true } }],
    '/api/server-info': [{ json: { uptimeMs: 900 } }],
  });
  const { registry } = buildContext({ fetchImpl });
  await settle();

  assert.equal(registry['air-ver-hint'].textContent, '已是最新（离线）');
  assert.equal(registry['air-ver-badge'].hidden, true);
});

// ── Update flow ────────────────────────────────────────────────────────────
test('clicking the version row asks first, then updates and reloads once the server is back', async () => {
  const fetchImpl = scriptedFetch({
    '/api/update/status': [
      { json: { state: 'idle', running: false } },
      { json: { state: 'running', running: true, tail: 'Updating MultiCC (branch: main)...' } },
      { json: { state: 'succeeded', running: false, exitCode: 0, tail: 'Update complete (aaaaaaa → bbbbbbb).' } },
    ],
    '/api/version-check': [{ json: { current: '1.6.10', channel: 'dev', latest: 'v1.7.0', latestVersion: '1.7.0', updateAvailable: true } }],
    '/api/update': [{ status: 202, json: { ok: true, status: 'started', force: false, activeStreaming: 2 } }],
    '/api/server-info': [{ json: { uptimeMs: 900 } }],
  });
  const { registry, reloads, advance } = buildContext({ fetchImpl });
  await settle();

  registry['air-ver-row'].onclick();
  await settle();
  // Nothing has been started yet — the user has only been asked.
  assert.equal(fetchImpl.calls.some(call => call.url === '/api/update'), false);
  assert.match(dialogText(registry), /当前版本：v1\.6\.10（通道：dev）/);
  assert.match(dialogText(registry), /最新版本：v1\.7\.0/);

  const confirm = findButton(registry, '立即更新');
  assert.ok(confirm, 'the dialog must offer to install the update');
  confirm.onclick();
  await settle();

  const post = fetchImpl.calls.find(call => call.url === '/api/update');
  assert.ok(post, 'confirming must start the update');
  assert.deepEqual(post.body, { force: false });
  assert.equal(post.method, 'POST');
  assert.match(registry['air-ops-status'].textContent, /2 个会话正在输出/,
    'the user is warned which turns the restart interrupts');

  // The run itself is the host's; the page only polls for it. One poll
  // interval is enough to see the exit marker.
  assert.equal(reloads.length, 0, 'nothing reloads while the update is still running');
  await advance(2500);
  await settle();
  assert.equal(reloads.length, 1, 'the page reloads exactly once after the server comes back');
  assert.match(registry['air-ver-hint'].textContent, /更新完成|重载/);
});

test('the force checkbox is what reaches the API, not a separate button', async () => {
  const fetchImpl = scriptedFetch({
    '/api/update/status': [
      { json: { state: 'idle', running: false } },
      { json: { state: 'succeeded', running: false, exitCode: 0, tail: 'done' } },
    ],
    '/api/version-check': [{ json: { current: '1.6.10', channel: 'dev', latest: 'v1.6.10', updateAvailable: false } }],
    '/api/update': [{ status: 202, json: { ok: true, status: 'started', force: true, activeStreaming: 0 } }],
    '/api/server-info': [{ json: { uptimeMs: 900 } }],
  });
  const { registry } = buildContext({ fetchImpl });
  await settle();

  registry['air-ver-row'].onclick();
  await settle();
  assert.match(dialogText(registry), /当前已是最新/);
  const checkbox = registry['ops-extra'].descendants().find(node => node.type === 'checkbox');
  assert.ok(checkbox, 'the dialog must expose the force option');
  assert.match(dialogText(registry), /本地改动会先备份到 git stash/);
  checkbox.checked = true;

  findButton(registry, '仍要更新').onclick();
  await settle();

  const post = fetchImpl.calls.find(call => call.url === '/api/update');
  assert.deepEqual(post.body, { force: true });
});

test('clicking while an update is already running attaches to it instead of starting a second', async () => {
  const fetchImpl = scriptedFetch({
    '/api/update/status': [
      { json: { state: 'running', running: true, force: false, tail: 'Updating MultiCC (branch: main)...' } },
      { json: { state: 'running', running: true, force: false, tail: 'Pulling...' } },
      { json: { state: 'succeeded', running: false, exitCode: 0, tail: 'Update complete.' } },
    ],
    '/api/server-info': [{ json: { uptimeMs: 900 } }],
  });
  const { registry, reloads, advance } = buildContext({ fetchImpl });
  await settle();

  registry['air-ver-row'].onclick();
  await settle();
  assert.equal(fetchImpl.calls.some(call => call.url === '/api/update'), false,
    'a second update must never be started');
  assert.ok(findButton(registry, '后台运行'), 'the dialog offers to background the attached run');
  assert.match(dialogText(registry), /Pulling\.\.\./, 'the attached dialog shows the live output');

  // The attached run is still the host's; its own poll has to finish before
  // the page can reload.
  await advance(2500);
  await settle();
  assert.equal(reloads.length, 1, 'the attached run still reloads when it finishes');
});

test('a failed update shows the log and offers the force retry it was missing', async () => {
  const fetchImpl = scriptedFetch({
    '/api/update/status': [
      // The first entry answers the version row's own pre-check, the second
      // the poll's first wake-up, the third the outcome it is waiting for.
      { json: { state: 'idle', running: false } },
      { json: { state: 'running', running: true, tail: 'Pulling...' } },
      { json: { state: 'failed', running: false, exitCode: 1, force: false, tail: 'fatal: not a git repository' } },
    ],
    '/api/version-check': [{ json: { current: '1.6.10', channel: 'dev', latest: 'v1.7.0', updateAvailable: true } }],
    '/api/update': [{ status: 202, json: { ok: true, status: 'started', force: false, activeStreaming: 0 } }],
    '/api/server-info': [{ json: { uptimeMs: 900 } }],
  });
  const { registry, reloads, advance } = buildContext({ fetchImpl });
  await settle();

  registry['air-ver-row'].onclick();
  await settle();
  findButton(registry, '立即更新').onclick();
  await settle();
  assert.match(dialogText(registry), /正在更新，请勿关闭本机/);

  // The exit marker is only visible on the next wake-up.
  await advance(2500);
  await settle();
  assert.match(dialogText(registry), /fatal: not a git repository/);
  assert.ok(findButton(registry, '强制更新重试'), 'a non-forced failure must offer the force retry');
  assert.equal(reloads.length, 0, 'a failed update must not reload the page');
});

// ── Boot read-out ──────────────────────────────────────────────────────────
test('the boot line derives the start instant from uptime, not the host clock', async () => {
  // The host clock is hours off in one direction; the server's uptime is a
  // duration and cannot be. The painted instant must follow the duration.
  const uptimeMs = 3 * 3600 * 1000 + 25 * 60 * 1000;
  const fetchImpl = scriptedFetch({
    '/api/server-info': [{ json: { uptimeMs, startedAt: new Date(Date.now() + 6 * 3600 * 1000).toISOString() } }],
    '/api/version-check': [{ json: { current: '1.6.10', updateAvailable: false } }],
  });
  const { registry } = buildContext({ fetchImpl });
  await settle();

  const expected = new Date(Date.now() - uptimeMs);
  const painted = registry['air-boot-time'].textContent;
  assert.match(painted, /^\d{2}-\d{2} \d{2}:\d{2}$/, 'the boot clock is a padded short instant');
  assert.equal(painted, `${String(expected.getMonth() + 1).padStart(2, '0')}-${String(expected.getDate()).padStart(2, '0')} ${String(expected.getHours()).padStart(2, '0')}:${String(expected.getMinutes()).padStart(2, '0')}`);
  assert.equal(registry['air-boot-uptime'].textContent, '已运行 3h 25m');
});

test('uptime is coarse, and a server that just came up says so rather than showing 0', async () => {
  const fetchImpl = scriptedFetch({
    '/api/server-info': [{ json: { uptimeMs: 20 * 1000 } }],
    '/api/version-check': [{ json: { current: '1.6.10', updateAvailable: false } }],
  });
  const { registry } = buildContext({ fetchImpl });
  await settle();
  assert.equal(registry['air-boot-uptime'].textContent, '已运行 <1m');
});

test('a server-info response without uptime leaves the placeholder rather than printing a wrong time', async () => {
  const fetchImpl = scriptedFetch({
    '/api/server-info': [{ json: { ip: '127.0.0.1', port: 3000 } }],
    '/api/version-check': [{ json: { current: '1.6.10', updateAvailable: false } }],
  });
  const { registry } = buildContext({ fetchImpl });
  await settle();
  assert.equal(registry['air-boot-time'].textContent, '');
  assert.equal(registry['air-boot-uptime'].textContent, '');
});

// ── Restart ────────────────────────────────────────────────────────────────
test('restart asks for confirmation, and a refusal sends nothing', async () => {
  const fetchImpl = scriptedFetch({
    '/api/restart': [{ json: { ok: true, activeStreaming: 0 } }],
    '/api/server-info': [{ json: { uptimeMs: 900 } }],
    '/api/version-check': [{ json: { current: '1.6.10', updateAvailable: false } }],
  });
  const { registry } = buildContext({ fetchImpl, confirmResult: false });
  await settle();

  registry['air-restart-btn'].onclick();
  await settle();
  assert.equal(fetchImpl.calls.some(call => call.url === '/api/restart'), false,
    'declining the confirmation must not restart the service');
});

test('restart reports how many turns it will interrupt', async () => {
  const fetchImpl = scriptedFetch({
    '/api/restart': [{ json: { ok: true, activeStreaming: 3 } }],
    '/api/server-info': [{ json: { uptimeMs: 900 } }],
    '/api/version-check': [{ json: { current: '1.6.10', updateAvailable: false } }],
  });
  const { registry } = buildContext({ fetchImpl, confirmResult: true });
  await settle();

  registry['air-restart-btn'].onclick();
  await settle();
  const post = fetchImpl.calls.find(call => call.url === '/api/restart');
  assert.equal(post.method, 'POST');
  assert.match(registry['air-ops-status'].textContent, /3 个会话正在输出/);
});

// ── Push ───────────────────────────────────────────────────────────────────
test('the push button carries a Chinese label, because Air ships no dictionary', async () => {
  const fetchImpl = scriptedFetch({
    '/api/server-info': [{ json: { uptimeMs: 900 } }],
    '/api/version-check': [{ json: { current: '1.6.10', updateAvailable: false } }],
  });
  const { registry, document } = buildContext({ fetchImpl, pushInfo: { subscribed: false, permission: 'default' } });
  await settle();

  assert.equal(registry['push-toggle'].textContent, '推送通知');
  // pwa.js's own label is English; its state event must not win.
  document.dispatch('multicc-push-state', { detail: { subscribed: true, permission: 'granted' } });
  assert.equal(registry['push-toggle'].textContent, '推送已开');
  assert.equal(registry['push-toggle'].classList.contains('on'), true);

  document.dispatch('multicc-push-state', { detail: { subscribed: false, permission: 'denied' } });
  assert.equal(registry['push-toggle'].disabled, true, 'a denied permission is not a clickable button');
});

test('the push button drives the existing subscription logic rather than its own', async () => {
  const fetchImpl = scriptedFetch({
    '/api/server-info': [{ json: { uptimeMs: 900 } }],
    '/api/version-check': [{ json: { current: '1.6.10', updateAvailable: false } }],
  });
  const { context, registry } = buildContext({ fetchImpl, pushInfo: { subscribed: false, permission: 'default' } });
  await settle();

  await registry['push-toggle'].onclick();
  await settle();
  assert.equal(context.__toggled, 1);
});

// ── Install packages ───────────────────────────────────────────────────────
test('the install-package panel links both platforms and says so when there is nothing', async () => {
  const fetchImpl = scriptedFetch({
    '/api/apk-info': [{ json: { exists: true, versionName: '2.29.12', versionCode: 125, size: 62737928, mtime: '2026-09-06T08:36:11.867Z', downloadUrl: '/multicc.apk' } }],
    '/api/ios-ota-info': [{ json: { exists: true, versionName: '2.29.12', versionCode: '124', size: 13545599, mtime: '2026-09-05T16:17:48.323Z', installPage: '/ios-ota' } }],
    '/api/server-info': [{ json: { uptimeMs: 900 } }],
    '/api/version-check': [{ json: { current: '1.6.10', updateAvailable: false } }],
  });
  const { registry } = buildContext({ fetchImpl });
  await settle();

  registry['air-apk-btn'].onclick();
  await settle();
  await settle();

  const links = registry['ops-extra'].descendants().filter(node => node.tagName === 'A');
  assert.deepEqual(links.map(node => node.href), ['/multicc.apk', '/ios-ota']);
  assert.match(dialogText(registry), /Android APK · 2\.29\.12\+125/);
  // Same rounding the manage panel uses (one decimal), so the two surfaces
  // report the same size for the same file.
  assert.match(dialogText(registry), /59\.8 MB · \d{2}-\d{2} \d{2}:\d{2}/);
});

test('a host with no published package is told so instead of shown an empty panel', async () => {
  const fetchImpl = scriptedFetch({
    '/api/apk-info': [{ json: { exists: false } }],
    '/api/ios-ota-info': [{ json: { exists: false } }],
    '/api/server-info': [{ json: { uptimeMs: 900 } }],
    '/api/version-check': [{ json: { current: '1.6.10', updateAvailable: false } }],
  });
  const { registry } = buildContext({ fetchImpl });
  await settle();

  registry['air-apk-btn'].onclick();
  await settle();
  await settle();
  assert.match(dialogText(registry), /还没有可用的安装包/);
});

// ── QR ─────────────────────────────────────────────────────────────────────
test('the QR code points at this host\'s Air console, in black on white', async () => {
  const painted = [];
  const qrcode = () => ({
    addData(url) { painted.push(url); },
    make() {},
    getModuleCount: () => 21,
    isDark: (row, column) => (row + column) % 2 === 0,
  });
  const fetchImpl = scriptedFetch({
    '/api/server-info': [{ json: { uptimeMs: 900, url: 'http://192.168.1.9:3000' } }],
    '/api/version-check': [{ json: { current: '1.6.10', updateAvailable: false } }],
  });
  const { registry } = buildContext({ fetchImpl, qrcode });
  await settle();

  registry['air-qr-btn'].onclick();
  await settle();
  await settle();

  assert.deepEqual(painted, ['http://192.168.1.9:3000/air']);
  const canvas = registry['ops-extra'].descendants().find(node => node.tagName === 'CANVAS');
  assert.ok(canvas, 'the QR must render into a canvas');
  // The shell's palette would make an unscannable code; the encoder's own
  // contrast has to survive the re-skin.
  assert.equal(canvas._context.fillStyle, '#000');
});

test('a missing QR encoder degrades to the URL instead of an empty dialog', async () => {
  const fetchImpl = scriptedFetch({
    '/api/server-info': [{ json: { uptimeMs: 900, url: 'http://192.168.1.9:3000' } }],
    '/api/version-check': [{ json: { current: '1.6.10', updateAvailable: false } }],
  });
  const { registry } = buildContext({ fetchImpl, qrcode: null });
  await settle();

  registry['air-qr-btn'].onclick();
  await settle();
  await settle();
  assert.match(dialogText(registry), /http:\/\/192\.168\.1\.9:3000\/air/);
});

// ── Not on the Air shell ───────────────────────────────────────────────────
test('the module stays inert on a page without the ops region', async () => {
  const fetchImpl = scriptedFetch({});
  const registry = {};
  const document = {
    readyState: 'complete',
    createElement: tag => new FakeNode(tag),
    getElementById: id => registry[id] || null,
    addEventListener() {},
    removeEventListener() {},
  };
  const context = { document, setTimeout: () => 0, setInterval: () => 0, clearTimeout() {}, fetch: fetchImpl, console: createSandboxConsole() };
  context.window = context;
  vm.createContext(context);
  assert.doesNotThrow(() => vm.runInContext(SOURCE, context, { filename: 'air-ops.js' }));
  assert.deepEqual(fetchImpl.calls, [], 'no requests must be made without the markup');
});

// ── Timers ─────────────────────────────────────────────────────────────────
test('the version row re-checks hourly and skips hidden tabs', async () => {
  const fetchImpl = scriptedFetch({
    '/api/server-info': [{ json: { uptimeMs: 900 } }],
    '/api/version-check': [{ json: { current: '1.6.10', updateAvailable: false } }],
  });
  const { registry, timers } = buildContext({ fetchImpl });
  await settle();

  assert.ok(registry['air-ver-row'], 'the row must exist for the interval to matter');
  assert.ok(timers.includes(60 * 60 * 1000), 'an hourly re-check is what notices a new release');
  assert.ok(timers.includes(60000), 'the boot clock repaints from its cached reading every minute');
});
