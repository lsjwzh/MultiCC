'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const DASHBOARD_PATH = path.join(ROOT, 'public', 'manage-dashboard.js');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function createHarness(overrides = {}) {
  const storage = new Map();
  const context = {
    console,
    Map,
    Set,
    URLSearchParams,
    Date,
    Promise,
    Object,
    String,
    Number,
    Math,
    JSON,
    encodeURIComponent,
    decodeURIComponent,
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval() {},
    location: { protocol: 'http:', host: 'localhost:3000' },
    localStorage: {
      getItem(key) { return storage.has(key) ? storage.get(key) : null; },
      setItem(key, value) { storage.set(key, String(value)); },
    },
    document: {
      visibilityState: 'visible',
      hidden: false,
      querySelectorAll() { return []; },
      querySelector() { return null; },
      getElementById() { return null; },
      createElement() {
        return {
          style: {},
          classList: { add() {}, remove() {} },
          appendChild() {},
          addEventListener() {},
          setAttribute() {},
          querySelector() { return null; },
          querySelectorAll() { return []; },
        };
      },
      body: { appendChild() {}, classList: { contains() { return false; }, remove() {} } },
      addEventListener() {},
      removeEventListener() {},
    },
    navigator: {},
    WebSocket: function WebSocket() {},
    SpeechSynthesisUtterance: function SpeechSynthesisUtterance() {},
    _cachedSessions: [],
    _focusedSessionId: null,
    _providerData: { available: true, providers: [] },
    _auxConfig: {},
    _workspaceStatus: new Map(),
    _workspaceQueues: new Map(),
    _workspaceClassify: new Map(),
    _workspaceNotes: new Map(),
    _workspaceSummaries: new Map(),
    _workspaceEvents: new Map(),
    _workspaceSockets: new Map(),
    _cronTasksCache: [],
    NOTIFY_EXISTING_SESSIONS_MIGRATION_KEY: 'dashboard-migration-test',
    CLAUDE_MODEL_OPTIONS: [],
    modelDisplayName(value) { return value || ''; },
    tt(key) { return key; },
    tokenQS() { throw new Error('dashboard must not request a token query string'); },
    showToast() {},
    showPrompt: async () => null,
    loadProviders: async () => {},
    loadAuxConfig: async () => {},
    enableTaskNotifyForSessions() {},
    openSessionInline() {},
    openSessionChat() {},
    openSessionNewTab() {},
    mergeSession() {},
    showSyncConflictHelp() {},
    newSessionInDir() {},
    openMemo() {},
    pushDirectory() {},
    renameDirectory() {},
    deleteDirectory() {},
    window: null,
    ...overrides,
  };
  context.window = context;
  context.innerWidth = overrides.innerWidth || 1200;
  context.addEventListener = () => {};
  context.speechSynthesis = { speak() {}, cancel() {} };
  vm.createContext(context);
  // manage.html loads the status registry before the dashboard script; the
  // harness mirrors that so session cards resolve their badges the same way.
  vm.runInContext(read('public/status-presentation.js'), context, {
    filename: 'status-presentation.js',
  });
  vm.runInContext(read('public/manage-dashboard.js'), context, {
    filename: 'manage-dashboard.js',
  });
  return { context, storage };
}

test('dashboard classic script stays ordered, bounded, and outside the manage facade', () => {
  const html = read('public/manage.html');
  const auth = html.indexOf('<script src="auth-client.js"></script>');
  const api = html.indexOf('<script src="api-client.js"></script>');
  const catalog = html.indexOf('<script src="provider-catalog.js"></script>');
  const lifecycle = html.indexOf('<script src="manage-session-lifecycle.js"></script>');
  const dashboard = html.indexOf('<script src="manage-dashboard.js"></script>');
  const manage = html.indexOf('<script src="manage.js"></script>');
  assert.ok(auth >= 0 && auth < api && api < catalog);
  assert.ok(catalog < lifecycle && lifecycle < dashboard && dashboard < manage);
  assert.doesNotMatch(html, /<script[^>]+type=["']module["'][^>]+manage-dashboard/i);

  const facade = read('public/manage.js');
  const source = read('public/manage-dashboard.js');
  assert.ok(facade.split(/\r?\n/).length <= 3200, 'manage.js should stay near the 3200-line target');
  assert.ok(source.split(/\r?\n/).length < 2000, 'dashboard module should stay below 2000 lines');
  for (const name of [
    'loadDashboard', 'renderDashboard', 'renderDirectoryBlock', 'renderSessionRow',
    'openNewDirectoryModal', 'startMonitor',
  ]) {
    assert.doesNotMatch(facade, new RegExp('function\\s+' + name + '\\b'));
    assert.match(source, new RegExp('function\\s+' + name + '\\b'));
  }
});

test('dashboard module has no credential or token-query boundary', () => {
  const source = read('public/manage-dashboard.js');
  assert.doesNotMatch(source, /tokenQS|[?&]token=|authToken|apiKey|settingsConfig|authorization/i);
  assert.doesNotMatch(source, /MultiCCProviderCatalog|normalizeCatalog|rawProvider/i);
  assert.match(source, /_providerData\.providers/);
});

test('classic script preserves compatibility globals and pure formatting behavior', () => {
  const { context, storage } = createHarness();
  for (const name of [
    'loadSessions', 'loadDashboard', 'renderDashboard', 'renderDirectoryBlock',
    'renderSessionRow', 'openDirectoryDetail', 'openNewDirectoryModal',
    'showSessionMenu', 'showWaitingSessions', 'startMonitor',
  ]) {
    assert.equal(typeof context[name], 'function', name + ' should remain a classic-script global');
  }

  assert.equal(context.directoryGridTemplate(), 'repeat(auto-fill, minmax(400px, 1fr))');
  context.innerWidth = 700;
  assert.equal(context.directoryGridTemplate(), 'minmax(0, 1fr)');
  assert.equal(context.formatDuration(3661), '1h1m');
  assert.equal(context.formatRunDuration(3661000), '1时01分');
  assert.equal(context.stripAnsi('\u001b[31mred\u001b[0m'), 'red');
  assert.equal(context.matchesWaiting('Would you like to proceed?'), true);
  assert.equal(context.isInProgress('Thinking…'), true);

  context.reorderDirectories(['d2', 'd1']);
  assert.equal(storage.get('multicc_dir_order'), '["d2","d1"]');
  const order = context.getDirOrder();
  order.push('mutated-copy');
  assert.equal(JSON.stringify(context.getDirOrder()), '["d2","d1"]');
});

test('session card consumes provider summary fields without rendering credential material', () => {
  const { context } = createHarness({
    _providerData: {
      available: true,
      providers: [{
        id: 'provider-safe',
        name: 'Safe relay',
        authToken: 'must-not-render',
        apiKey: 'must-not-render-either',
        settingsConfig: { env: { SECRET: 'nested-secret' } },
      }],
    },
  });
  const html = context.renderSessionRow({
    id: 'session-1',
    kind: 'chat',
    cli: 'claude',
    provider: 'provider-safe',
    effectiveModel: 'model-a',
    active: false,
    createdAt: new Date().toISOString(),
  });
  assert.match(html, /Safe relay/);
  assert.doesNotMatch(html, /must-not-render|nested-secret/);
});

test('fleet session groups stay in creation order no matter what the live activity says', () => {
  const { context } = createHarness();
  const iso = (day) => `2026-03-${String(day).padStart(2, '0')}T00:00:00.000Z`;
  const sessions = [
    { id: 'newest', kind: 'chat', cli: 'claude', createdAt: iso(3) },
    { id: 'oldest', kind: 'chat', cli: 'claude', createdAt: iso(1) },
    { id: 'cmdr', kind: 'chat', cli: 'claude', type: 'commander', createdAt: iso(9) },
    { id: 'middle', kind: 'chat', cli: 'claude', createdAt: iso(2) },
  ];
  const idsIn = (html) => (html.match(/data-id="([^"]+)"/g) || [])
    .map(m => m.slice('data-id="'.length, -1));

  // Commander first (it is pinned and does not compete on age), then the rest
  // oldest-first — the exact opposite of what recency ordering would produce.
  const expected = ['cmdr', 'oldest', 'middle', 'newest'];
  assert.deepEqual(idsIn(context.renderDirSessionGroups(sessions)), expected);

  // The bug this replaces: activity used to drive the order, so a session that
  // streamed one token jumped to the top. Now it must not move at all.
  context._workspaceStatus.set('newest', { lastActivity: Date.now() });
  context._workspaceStatus.set('oldest', { lastActivity: 1 });
  assert.deepEqual(idsIn(context.renderDirSessionGroups(sessions)), expected);

  // Nor does the input order leak through, and same-createdAt ties break on id
  // rather than on whatever order the API happened to return.
  const shuffled = [sessions[2], sessions[0], sessions[3], sessions[1]];
  assert.deepEqual(idsIn(context.renderDirSessionGroups(shuffled)), expected);
  const tied = [
    { id: 'b', kind: 'chat', cli: 'claude', createdAt: iso(5) },
    { id: 'a', kind: 'chat', cli: 'claude', createdAt: iso(5) },
  ];
  assert.deepEqual(idsIn(context.renderDirSessionGroups(tied)), ['a', 'b']);
});

test('fleet session card shows bounded FIFO depth while waiting-user work stays queued', () => {
  const { context } = createHarness();
  context._workspaceQueues.set('session-queued', {
    depth: 2,
    state: 'idle',
    classifyState: 'W',
    updatedAt: 100,
    text: 'must not render',
  });
  context._workspaceClassify.set('session-queued', { classifyState: 'W' });
  const html = context.renderSessionRow({
    id: 'session-queued',
    kind: 'chat',
    cli: 'codex',
    active: false,
    createdAt: new Date().toISOString(),
  });
  assert.match(html, /📥 FIFO 2/);
  assert.match(html, /目标会话正在等待用户回复/);
  assert.match(html, /之后按 FIFO 执行/);
  assert.doesNotMatch(html, /must not render/);
});

test('dashboard loader keeps the two legacy summary endpoints token-free', async () => {
  const calls = [];
  const rendered = [];
  const { context } = createHarness({
    fetch: async (url) => {
      calls.push(url);
      if (url === '/api/directories') return { json: async () => [{ id: 'dir-1', name: 'Fleet' }] };
      if (url === '/api/sessions') return { json: async () => [{ id: 's1', dirId: 'dir-1', active: false }] };
      if (url === '/api/aux/config') return { ok: true, json: async () => ({ protocol: 'anthropic' }) };
      throw new Error('unexpected URL ' + url);
    },
  });
  context.renderDashboard = (directories, sessions) => rendered.push({ directories, sessions });
  context.refreshAllCardBorders = () => {};
  context.syncMonitors = () => {};
  context.startRuntimeTicker = () => {};

  await context.loadDashboard();
  assert.equal(JSON.stringify(calls.slice(0, 2)), JSON.stringify(['/api/directories', '/api/sessions']));
  assert.equal(calls.every(url => !/[?&]token=/.test(url)), true);
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].directories[0].id, 'dir-1');
  assert.equal(rendered[0].sessions[0].id, 's1');
  assert.equal(vm.runInContext('_cachedDirectories[0].id', context), 'dir-1');
  assert.equal(context._cachedSessions[0].id, 's1');
});
