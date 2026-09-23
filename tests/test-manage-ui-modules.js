'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createSandboxConsole } = require('./helpers/sandbox-console');

const ROOT = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function fakeElement(id = '') {
  return {
    id,
    value: '',
    checked: false,
    disabled: false,
    readOnly: false,
    textContent: '',
    placeholder: '',
    title: '',
    href: '',
    hidden: false,
    tabIndex: 0,
    className: '',
    style: {},
    children: [],
    scrollHeight: 0,
    scrollTop: 0,
    attrs: {},
    appendChild(child) { this.children.push(child); this.firstChild = this.children[0] || null; return child; },
    addEventListener() {},
    // Attributes are how the page states a role (a clickable commit row sets
    // role=button). They render nothing, so the escaping assertions here don't
    // read them — but a page that sets one must not crash the harness.
    classList: {
      values: new Set(),
      add(...values) { values.forEach(value => this.values.add(value)); },
      remove(...values) { values.forEach(value => this.values.delete(value)); },
      contains(value) { return this.values.has(value); },
    },
    setAttribute(name, value) { this.attrs[name] = String(value); },
    getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; },
    removeAttribute(name) {
      delete this.attrs[name];
      if (name === 'href') this.href = '';
    },
    removeChild(child) { this.children = this.children.filter(item => item !== child); this.firstChild = this.children[0] || null; },
    replaceChildren(...children) {
      this.children = children.flatMap(child => child && child.__fragment ? child.children : [child]);
      this.firstChild = this.children[0] || null;
    },
    get innerHTML() { return ''; },
    set innerHTML(_value) { throw new Error('unsafe innerHTML write'); },
    querySelector() { return null; },
    focus() { this.focused = true; },
    scrollIntoView(options) { this.scrolledIntoView = options || true; },
    remove() {},
  };
}

function browserContext() {
  const elements = new Map();
  const requests = [];
  const eventSources = [];
  const opened = [];
  const listeners = [];
  const timers = [];
  const createdTags = [];
  const context = {
    console: createSandboxConsole(),
    URLSearchParams,
    JSON,
    Date,
    Promise,
    Object,
    String,
    Number,
    encodeURIComponent,
    confirm: () => true,
    addEventListener(type, handler) { listeners.push({ type, handler }); },
    location: { protocol: 'http:', host: 'localhost:3000', origin: 'http://localhost:3000', search: '' },
    tokenQS: () => '',
    _urlToken: 'bootstrap-secret',
    escapeHtml: value => String(value),
    showToast() {},
    showConfirm: async () => true,
    getPushInfo: () => ({ permission: 'default', subscribed: false, endpoint: '', platform: 'test' }),
    setTimeout(callback, delay) {
      const timer = { id: timers.length + 1, callback, delay, cleared: false };
      timers.push(timer);
      return timer.id;
    },
    clearTimeout(id) { const timer = timers.find(item => item.id === id); if (timer) timer.cleared = true; },
    setInterval() { return 1; },
    clearInterval() {},
    qrcode: undefined,
    document: {
      visibilityState: 'visible',
      body: fakeElement('body'),
      addEventListener(type, handler) { listeners.push({ type, handler }); },
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, fakeElement(id));
        return elements.get(id);
      },
      querySelector(selector) {
        const value = selector.includes('codex') ? 'codex' : 'claude';
        return selector.includes(':checked') ? { value } : null;
      },
      createElement(tag) { createdTags.push(String(tag)); return fakeElement(tag); },
      createTextNode(text) { return { nodeType: 3, textContent: String(text) }; },
      createDocumentFragment() {
        return { __fragment: true, children: [], appendChild(child) { this.children.push(child); return child; } };
      },
    },
    EventSource: class EventSource {
      constructor(url) { this.url = url; this.closed = false; eventSources.push(this); }
      close() { this.closed = true; }
    },
    open(url, target) { opened.push({ url, target }); },
    async fetch(url, options = {}) {
      requests.push({ url: String(url), options });
      const pathname = String(url);
      let data = {};
      if (pathname.endsWith('/start')) data = { ok: true };
      else if (pathname === '/api/settings/official-oauth') data = { enabled: true };
      else if (pathname.endsWith('/gateway')) data = null;
      else if (pathname.endsWith('/status')) data = { configured: false, running: false, gateway: null };
      else if (pathname.endsWith('/config')) data = { configured: false };
      return { ok: true, status: 200, async json() { return data; } };
    },
  };
  context.window = context;
  vm.createContext(context);
  return {
    context, elements, requests, eventSources, opened, listeners, timers, createdTags,
    fireTimers({ includeCleared = false } = {}) {
      for (const timer of timers.splice(0)) {
        if (includeCleared || !timer.cleared) timer.callback();
      }
    },
  };
}

// 这两个经典模块（消息桥接、千问语音）比旧管理台活得久：旧页删了，air.html 把它们
// 原样引了进来，由 air-bridges.js / air-voice.js 当宿主。所以这里改断 Air 的加载顺序
// —— 宿主在 IIFE 之后才调 initialize()，模块必须先于宿主脚本登记。
test('Air loads the surviving classic modules before the panels that drive them', () => {
  const html = read('public/air.html');
  const bridges = html.indexOf('<script src="manage-bridges.js"></script>');
  const qwen = html.indexOf('<script src="manage-qwen-audio.js"></script>');
  const airBridges = html.indexOf('<script src="air-bridges.js"></script>');
  const airVoice = html.indexOf('<script src="air-voice.js"></script>');
  assert.ok(bridges > 0 && qwen > 0, 'air.html must still load both classic modules');
  assert.ok(qwen < airVoice, 'manage-qwen-audio.js must be registered before air-voice.js');
  assert.ok(bridges < airBridges, 'manage-bridges.js must be registered before air-bridges.js');
  assert.doesNotMatch(html, /<script[^>]+type=["']module["'][^>]+manage-(?:bridges|qwen-audio)/i);
});

test('the surviving classic modules stay bounded and keep their published surface', () => {
  const bridges = read('public/manage-bridges.js');
  const qwen = read('public/manage-qwen-audio.js');
  assert.ok(bridges.split(/\r?\n/).length < 2000);
  assert.ok(qwen.split(/\r?\n/).length < 1000);
  assert.match(bridges, /MultiCCManageBridges\s*=\s*Object\.freeze/);
  assert.doesNotMatch(qwen, /\.innerHTML\s*=|insertAdjacentHTML|document\.write/);
  assert.match(qwen, /textContent\s*=/);
  assert.match(qwen, /MultiCCManageQwenAudio\s*=\s*Object\.freeze/);
  assert.match(qwen, /Object\.freeze\(\{ initialize, loadPanel, openGlobalVoice \}\)/);
});

test('bridge controller keeps relative credential-free URLs and safe DOM log rendering', async () => {
  const source = read('public/manage-bridges.js');
  assert.doesNotMatch(source, /\.innerHTML\s*=/);
  assert.doesNotMatch(source, /[?&]token=/i);
  const harness = browserContext();
  vm.runInContext(source, harness.context, { filename: 'manage-bridges.js' });
  assert.equal(typeof harness.context.MultiCCManageBridges.initialize, 'function');
  assert.equal(typeof harness.context.bridgeStart, 'function');

  await harness.context.bridgeStart('telegram');
  const start = harness.requests.find(request => request.url === '/api/telegram/start');
  assert.equal(start.options.method, 'POST');
  assert.equal(harness.eventSources.at(-1).url, '/api/telegram/events');
  assert.ok(harness.requests.every(request => request.url.startsWith('/')));
  assert.ok(harness.requests.every(request => !/[?&]token=/i.test(request.url)));

  harness.context.bridgeGatewayOpen('telegram');
  assert.deepEqual(harness.opened.at(-1), { url: '/chat?session=__telegram_gateway__', target: '_blank' });
});

test('every bridge owns reconnect generation and cannot reconnect after stop', async () => {
  const source = read('public/manage-bridges.js');
  const cases = [
    { start: context => context.wechatStart(), stop: context => context.wechatStop(), eventUrl: '/api/wechat/events' },
    { start: context => context.feishuStart(), stop: context => context.feishuStop(), eventUrl: '/api/feishu/events' },
    { start: context => context.bridgeStart('telegram'), stop: context => context.bridgeStop('telegram'), eventUrl: '/api/telegram/events' },
  ];

  for (const item of cases) {
    const harness = browserContext();
    vm.runInContext(source, harness.context, { filename: 'manage-bridges.js' });
    await item.start(harness.context);
    const sourceBeforeStop = harness.eventSources.at(-1);
    assert.equal(sourceBeforeStop.url, item.eventUrl);
    sourceBeforeStop.onerror();
    assert.equal(harness.timers.filter(timer => !timer.cleared).length, 1, `${item.eventUrl} should own one reconnect timer`);
    await item.stop(harness.context);
    assert.equal(harness.timers.filter(timer => !timer.cleared).length, 0, `${item.eventUrl} stop must clear reconnect timer`);
    const countAfterStop = harness.eventSources.length;
    harness.fireTimers({ includeCleared: true });
    assert.equal(harness.eventSources.length, countAfterStop, `${item.eventUrl} stale timer must not reconnect`);
  }
});

// 安装包面板、开机时间读数、推送按钮这几组原本跑的是 manage-host-settings.js。
// 那个模块随旧页删掉了，Air 侧的同名功能在 air-ops.js，由 tests/test-air-ops.js 盯着
// （官方 OAuth 开关落在 air-global.js）。旧页那份 APK 面板比 Air 的多一层「本地没有就
// 去 GitHub Release 找」的回退，它跟着页面一起退场了 —— 不是搬家漏了，是一并删了。
