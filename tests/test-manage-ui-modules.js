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
  const qwen = html.indexOf('<script src="manage-qwen-audio.js"></script>');
  const page = html.indexOf('<script src="manage.js"></script>');
  const pwa = html.indexOf('<script src="pwa.js"></script>');
  assert.ok(pwa > 0 && pwa < bridge && bridge < host && host < qwen && qwen < page);
  assert.doesNotMatch(html, /<script[^>]+type=["']module["'][^>]+manage-(?:bridges|host-settings|qwen-audio)/i);
});

test('manage facade stays below the migration ceiling and no longer owns extracted domains', () => {
  const page = read('public/manage.js');
  const bridges = read('public/manage-bridges.js');
  const host = read('public/manage-host-settings.js');
  const qwen = read('public/manage-qwen-audio.js');
  assert.ok(page.split(/\r?\n/).length <= 5300, 'manage.js should stay at or below 5300 lines after this extraction');
  assert.ok(bridges.split(/\r?\n/).length < 2000);
  assert.ok(host.split(/\r?\n/).length < 2000);
  assert.ok(qwen.split(/\r?\n/).length < 1000);
  assert.doesNotMatch(page, /function\s+(?:wechat|feishu|bridge)[A-Z]/);
  assert.doesNotMatch(page, /function\s+(?:load|save)TunnelSettings/);
  assert.match(page, /MultiCCManageBridges\.initialize\(\)/);
  assert.match(page, /MultiCCManageHostSettings\.initialize\(\)/);
  assert.match(page, /MultiCCManageQwenAudio\.initialize\(/);
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

function catalogTranslator(locale = 'zh') {
  const catalog = JSON.parse(read(`app/assets/i18n/${locale}.json`));
  return (key, params) => {
    let text = catalog[key] || key;
    if (params) {
      text = text.replace(/\{(\w+)\}/g, (_, name) =>
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : `{${name}}`);
    }
    return text;
  };
}

function apkHarness(initialSteps = [], { now = Date.parse('2026-08-20T12:01:00.000Z'), locale = 'zh' } = {}) {
  const harness = browserContext();
  const steps = initialSteps.slice();
  harness.context.Date = class extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  };
  harness.context.t = catalogTranslator(locale);
  harness.context.fetch = async (url, options = {}) => {
    const request = { url: String(url), options };
    harness.requests.push(request);
    const step = steps.shift();
    if (!step) throw new Error(`unscripted fetch: ${request.url}`);
    if (step.url) assert.equal(request.url, step.url);
    if (step.error) throw step.error;
    const status = step.status || 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() { return step.body; },
    };
  };
  harness.enqueue = (...more) => steps.push(...more);
  harness.fireNextTimer = async () => {
    const index = harness.timers.findIndex(timer => !timer.cleared);
    assert.notEqual(index, -1, 'a retry/poll timer should be scheduled');
    const [timer] = harness.timers.splice(index, 1);
    await timer.callback();
  };
  vm.runInContext(read('public/manage-host-settings.js'), harness.context, { filename: 'manage-host-settings.js' });
  return harness;
}

test('APK management is download-only and explains the release fallback', () => {
  const html = read('public/manage.html');
  assert.match(html, /<a[^>]+id="apk-download-btn"[^>]+href="\/multicc\.apk"/);
  assert.doesNotMatch(html, /apk-build-btn|startApkBuild|apk-build-log/);
  assert.match(html, /id="apk-source-status"[^>]+role="status"[^>]+aria-live="polite"/);

  const zh = JSON.parse(read('app/assets/i18n/zh.json'));
  const en = JSON.parse(read('app/assets/i18n/en.json'));
  const apkKeys = Object.keys(zh).filter(key => key.startsWith('apk')).sort();
  assert.deepEqual(Object.keys(en).filter(key => key.startsWith('apk')).sort(), apkKeys);
  assert.ok(apkKeys.includes('apkArtifactRelease'));
  assert.ok(apkKeys.includes('apkArtifactLocal'));
  assert.equal(apkKeys.some(key => key.startsWith('apkBuild')), false);
});

test('APK management prefers a local package even when its version is stale', async () => {
  const harness = apkHarness([
    {
      url: '/api/apk-info',
      body: {
        exists: true, localExists: true, source: 'local', localCurrent: false,
        current: false, downloadUrl: '/multicc.apk', versionName: '2.1.0', versionCode: 10,
        targetVersionName: '2.2.0', targetVersionCode: 11, size: 1048576,
        mtime: '2026-08-20T11:00:00.000Z',
      },
    },
  ]);

  await harness.context.loadApkInfo();
  assert.deepEqual(harness.requests.map(request => request.url), ['/api/apk-info']);
  assert.equal(harness.context.document.getElementById('apk-download-btn').href, '/multicc.apk');
  assert.equal(harness.context.document.getElementById('apk-download-btn').getAttribute('aria-disabled'), null);
  assert.match(harness.context.document.getElementById('apk-artifact-summary').textContent, /本地/);
  assert.match(harness.context.document.getElementById('apk-artifact-summary').textContent, /2\.1\.0\+10/);
  assert.match(harness.context.document.getElementById('apk-source-status').textContent, /目标版本 2\.2\.0\+11/);
});

test('APK management uses the exact current-version GitHub Release when local is absent', async () => {
  const releaseUrl = 'https://github.com/lsjwzh/MultiCC/releases/download/v1.5.3/multicc.apk';
  const harness = apkHarness([
    {
      url: '/api/apk-info',
      body: {
        exists: true, localExists: false, source: 'release', releaseTag: 'v1.5.3',
        downloadUrl: releaseUrl, versionName: '2.30.0', versionCode: 120,
        targetVersionName: '2.30.1', targetVersionCode: 121, size: 62914560,
        mtime: '2026-08-20T12:00:00.000Z',
      },
    },
  ]);

  await harness.context.loadApkInfo();
  assert.equal(harness.context.document.getElementById('apk-download-btn').href, releaseUrl);
  assert.match(harness.context.document.getElementById('apk-artifact-summary').textContent, /GitHub Release v1\.5\.3/);
  assert.match(harness.context.document.getElementById('apk-card-hint').textContent, /线上/);
});

test('APK management stays honest when the current release has no verified asset', async () => {
  const harness = apkHarness([
    {
      url: '/api/apk-info',
      body: {
        exists: false, localExists: false, source: null, releaseTag: 'v1.5.2',
        targetVersionName: '2.29.7', targetVersionCode: 119,
        error: 'release_asset_missing',
      },
    },
  ]);

  await harness.context.loadApkInfo();
  const download = harness.context.document.getElementById('apk-download-btn');
  assert.equal(download.getAttribute('aria-disabled'), 'true');
  assert.equal(download.getAttribute('href'), null);
  assert.match(harness.context.document.getElementById('apk-artifact-summary').textContent, /v1\.5\.2/);
});

/**
 * The sidebar uptime read-out.
 *
 * Its whole value is that a restart moves it, so what is pinned here is that
 * the numbers come from the server's *uptime* rather than its wall clock: a
 * host running a few hours ahead of the browser would otherwise render a start
 * time in the future, which reads as a bug in the service the line is meant to
 * reassure you about.
 */
function bootHarness(payload, { now = Date.parse('2026-07-27T13:32:00+08:00') } = {}) {
  const harness = browserContext();
  harness.context.Date = class extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  };
  harness.context.fetch = async (url) => {
    const path = String(url);
    harness.requests.push({ url: path, options: {} });
    // initialize() wakes the other host panels too; they only need to not throw.
    const body = path === '/api/server-info' ? payload
      : path.startsWith('/api/push/health') ? { global: {}, subscriptions: [] }
      : {};
    return { ok: true, status: 200, async json() { return body; } };
  };
  vm.runInContext(read('public/manage-host-settings.js'), harness.context, { filename: 'manage-host-settings.js' });
  return harness;
}

test('the sidebar shows when the service last started, derived from uptime not the host clock', async () => {
  // The host's clock is a full day ahead of the browser's. Reading startedAt
  // would put the start in the future; uptime cannot.
  const harness = bootHarness({
    uptimeMs: 8100000,                              // 2h 15m
    startedAt: '2026-07-28T03:17:00.000Z',
  });
  await harness.context.loadBootTime();

  assert.equal(harness.requests.at(-1).url, '/api/server-info');
  assert.equal(harness.context.document.getElementById('boot-time').textContent, '07-27 11:17');
  assert.equal(harness.context.document.getElementById('boot-uptime').textContent, '2h 15m');
});

test('the uptime line is translated, and the short clock keeps the full instant in its tooltip', async () => {
  const harness = bootHarness({ uptimeMs: 8100000 });
  harness.context.t = (key, params) => `${key}:${params.duration}`;
  await harness.context.loadBootTime();
  assert.equal(harness.context.document.getElementById('boot-uptime').textContent, 'uptimeDuration:2h 15m');
  assert.ok(harness.context.document.getElementById('boot-time').title, 'the year is dropped on screen, so it must survive in the title');
});

test('uptime is coarse, and a server that just came up says so rather than showing 0', async () => {
  const cases = [
    [30 * 1000, '<1m'],
    [90 * 1000, '1m'],
    [59 * 60 * 1000, '59m'],
    [3600 * 1000, '1h 0m'],
    [8100 * 1000, '2h 15m'],
    [26 * 3600 * 1000, '1d 2h'],
    [48 * 3600 * 1000, '2d'],
  ];
  for (const [uptimeMs, expected] of cases) {
    const harness = bootHarness({ uptimeMs });
    await harness.context.loadBootTime();
    assert.equal(harness.context.document.getElementById('boot-uptime').textContent, expected, `${uptimeMs}ms`);
  }
});

test('a server-info response without uptime leaves the placeholder rather than printing a wrong time', async () => {
  for (const payload of [{}, { uptimeMs: null }, { uptimeMs: 'soon' }]) {
    const harness = bootHarness(payload);
    harness.context.document.getElementById('boot-time').textContent = '—';
    await harness.context.loadBootTime();
    assert.equal(harness.context.document.getElementById('boot-time').textContent, '—');
  }
});

test('the read-out is re-fetched when the tab comes back, since only a restart changes it', () => {
  const harness = bootHarness({ uptimeMs: 1000 });
  harness.context.MultiCCManageHostSettings.initialize();
  const before = harness.requests.filter(item => item.url === '/api/server-info').length;
  assert.equal(before, 1, 'one read on load');

  const visibility = harness.listeners.filter(item => item.type === 'visibilitychange');
  assert.equal(visibility.length, 1, 'exactly one visibility listener, not one per repaint');
  harness.context.document.hidden = true;
  visibility[0].handler({});
  assert.equal(harness.requests.filter(item => item.url === '/api/server-info').length, before,
    'a tab going away is not a reason to poll');
  harness.context.document.hidden = false;
  visibility[0].handler({});
  assert.equal(harness.requests.filter(item => item.url === '/api/server-info').length, before + 1);
});
