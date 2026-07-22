'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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
    className: '',
    style: {},
    children: [],
    scrollHeight: 0,
    scrollTop: 0,
    appendChild(child) { this.children.push(child); this.firstChild = this.children[0] || null; return child; },
    addEventListener() {},
    removeChild(child) { this.children = this.children.filter(item => item !== child); this.firstChild = this.children[0] || null; },
    replaceChildren(...children) {
      this.children = children.flatMap(child => child && child.__fragment ? child.children : [child]);
      this.firstChild = this.children[0] || null;
    },
    get innerHTML() { return ''; },
    set innerHTML(_value) { throw new Error('unsafe innerHTML write'); },
    querySelector() { return null; },
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
    console,
    URLSearchParams,
    JSON,
    Date,
    Promise,
    Object,
    String,
    Number,
    encodeURIComponent,
    confirm: () => true,
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
      else if (pathname === '/api/settings/proxy') data = { enabled: true };
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

test('manage loads extracted classic modules before page bootstrap', () => {
  const html = read('public/manage.html');
  const bridge = html.indexOf('<script src="manage-bridges.js"></script>');
  const host = html.indexOf('<script src="manage-host-settings.js"></script>');
  const page = html.indexOf('<script src="manage.js"></script>');
  const pwa = html.indexOf('<script src="pwa.js"></script>');
  assert.ok(pwa > 0 && pwa < bridge && bridge < host && host < page);
  assert.doesNotMatch(html, /<script[^>]+type=["']module["'][^>]+manage-(?:bridges|host-settings)/i);
});

test('manage facade stays below the migration ceiling and no longer owns extracted domains', () => {
  const page = read('public/manage.js');
  const bridges = read('public/manage-bridges.js');
  const host = read('public/manage-host-settings.js');
  assert.ok(page.split(/\r?\n/).length <= 5300, 'manage.js should stay at or below 5300 lines after this extraction');
  assert.ok(bridges.split(/\r?\n/).length < 2000);
  assert.ok(host.split(/\r?\n/).length < 2000);
  assert.doesNotMatch(page, /function\s+(?:wechat|feishu|bridge)[A-Z]/);
  assert.doesNotMatch(page, /function\s+(?:load|save)TunnelSettings/);
  assert.match(page, /MultiCCManageBridges\.initialize\(\)/);
  assert.match(page, /MultiCCManageHostSettings\.initialize\(\)/);
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

test('Git tree renders every API field as text even for hostile payloads', async () => {
  const html = read('public/manage.html');
  const marker = '<script>\n    window._gitTreeDir = null;';
  const start = html.indexOf(marker);
  const end = html.indexOf('</script>', start);
  assert.ok(start > 0 && end > start);
  const source = html.slice(start + '<script>'.length, end);
  assert.doesNotMatch(source, /\.innerHTML\s*=/);
  assert.doesNotMatch(source, /\bhtml\s*\+=/);

  const harness = browserContext();
  let payload = {
    repoPath: '<img src=x onerror=repo()>',
    commits: [{
      short: '<svg onload=short()>',
      date: '<script>date()</script>',
      author: '<img src=x onerror=author()>',
      subject: '<script>subject()</script>',
      refs: 'tag: <img src=x onerror=ref()>',
    }],
  };
  harness.context.fetch = async () => ({ async json() { return payload; } });
  vm.runInContext(source, harness.context, { filename: 'manage-git-tree-inline.js' });
  harness.context.openGitTree('dir-1');
  await new Promise(resolve => setImmediate(resolve));

  const collectText = node => String(node && node.textContent || '')
    + (node && node.children || []).map(collectText).join('');
  const body = harness.context.document.getElementById('git-tree-body');
  const rendered = collectText(body);
  assert.match(rendered, /<svg onload=short\(\)>/);
  assert.match(rendered, /<img src=x onerror=author\(\)>/);
  assert.match(rendered, /<script>subject\(\)<\/script>/);
  assert.match(rendered, /<img src=x onerror=ref\(\)>/);
  assert.equal(harness.context.document.getElementById('git-tree-path').textContent, payload.repoPath);
  assert.deepEqual([...new Set(harness.createdTags)].sort(), ['div', 'span']);

  payload = { error: '<img src=x onerror=error()>' };
  harness.context.openGitTree('dir-2');
  await new Promise(resolve => setImmediate(resolve));
  assert.match(collectText(body), /错误: <img src=x onerror=error\(\)>/);
});

test('host settings preserve bootstrap header auth without credential query parameters', async () => {
  const source = read('public/manage-host-settings.js');
  assert.doesNotMatch(source, /\.innerHTML\s*=/);
  assert.doesNotMatch(source, /[?&]token=/i);
  assert.doesNotMatch(source, /fetch\(\s*[`'"]https?:\/\//i);
  const harness = browserContext();
  const toggle = harness.context.document.getElementById('cc-proxy-enabled');
  toggle.checked = true;
  vm.runInContext(source, harness.context, { filename: 'manage-host-settings.js' });
  assert.equal(typeof harness.context.MultiCCManageHostSettings.initialize, 'function');
  assert.equal(typeof harness.context.saveProxySetting, 'function');

  await harness.context.saveProxySetting();
  const request = harness.requests.find(item => item.url === '/api/settings/proxy');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['X-Access-Token'], 'bootstrap-secret');
  assert.equal(JSON.parse(request.options.body).enabled, true);
  assert.doesNotMatch(request.url, /token/i);
});
