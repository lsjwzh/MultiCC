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
      removeItem(key) { storage.delete(key); },
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
  // The saved drag-and-drop arrangement is a hard dependency of the dashboard's
  // ordering now that it lives on the server, so load it in the page's order.
  vm.runInContext(read('public/ui-layout-store.js'), context, {
    filename: 'ui-layout-store.js',
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

test('dashboard completion alert prefers the task-aware voice message', () => {
  const { context } = createHarness();
  const spoken = [];
  context.SpeechSynthesisUtterance = class SpeechSynthesisUtterance {
    constructor(text) { this.text = text; }
  };
  context.speechSynthesis.speak = utterance => spoken.push(utterance.text);
  context.alertSession(
    'worker-1', 'succeeded', '执行成功：修复配额显示',
    '任务 7K2M，修复配额显示，本轮执行成功',
  );
  assert.deepEqual(spoken, ['任务 7K2M，修复配额显示，本轮执行成功']);
});

test('dashboard module has no credential or token-query boundary', () => {
  const source = read('public/manage-dashboard.js');
  assert.doesNotMatch(source, /tokenQS|[?&]token=|authToken|apiKey|settingsConfig|authorization/i);
  assert.doesNotMatch(source, /MultiCCProviderCatalog|normalizeCatalog|rawProvider/i);
  assert.match(source, /_providerData\.providers/);
});

test('classic script preserves compatibility globals and pure formatting behavior', async () => {
  const puts = [];
  const { context } = createHarness({
    fetch: async (url, init) => {
      puts.push({ url, body: JSON.parse(init.body) });
      return { ok: true, json: async () => ({ ok: true, layout: { dirOrder: ['d2', 'd1'], sessionOrder: {} } }) };
    },
  });
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

  // The arrangement goes to the server, not to this browser's localStorage —
  // that is what makes it survive a switch of browser or device.
  await context.reorderDirectories(['d2', 'd1']);
  assert.equal(puts.length, 1);
  assert.equal(puts[0].url, '/api/ui-layout/dir-order');
  assert.equal(JSON.stringify(puts[0].body.order), '["d2","d1"]');
  const order = context.getDirOrder();
  order.push('mutated-copy');
  assert.equal(JSON.stringify(context.getDirOrder()), '["d2","d1"]');
});

test('task-board activity lights the outer Fleet card like a running session', () => {
  const running = createHarness({ taskBoardRunningCountForDir: dirId => dirId === 'fleet-running' ? 1 : 0 });
  const activeHtml = running.context.renderDirectoryBlock({
    id: 'fleet-running', name: 'Running Fleet', path: '/fleet-running',
  }, []);
  const idleHtml = running.context.renderDirectoryBlock({
    id: 'fleet-idle', name: 'Idle Fleet', path: '/fleet-idle',
  }, []);
  assert.match(activeHtml, /dir-block dir-card card-border-rainbow/);
  assert.match(activeHtml, /dir-task-running/);
  assert.match(activeHtml, /data-status="running"/);
  assert.match(activeHtml, /· 1 个任务/);
  assert.doesNotMatch(idleHtml, /card-border-rainbow/);
  assert.doesNotMatch(idleHtml, /dir-task-running/);
  assert.equal(running.context.isAnyWorkInDirRunning('fleet-running'), true);
  assert.equal(running.context.isAnyWorkInDirRunning('fleet-idle'), false);
});

test('Fleet parent activity reuses the task board origin-aware running aggregate', () => {
  const taskBoardSource = read('public/manage-taskboard.js');
  const dashboardSource = read('public/manage-dashboard.js');

  // Directory membership and board/session origin policy stay behind one read
  // port. Dashboard consumers must not independently count raw runState values.
  assert.match(taskBoardSource,
    /function taskBoardRunningCountForDir\(dirId\)\s*\{\s*return window\.MultiCCTaskBoardUi\.runningTaskCount\(_tbTasksForDir\(dirId\)\);\s*\}/);
  assert.match(dashboardSource,
    /function isAnyWorkInDirRunning\(dirId\)[\s\S]*?taskBoardRunningCountForDir\(dirId\)/);
  assert.match(dashboardSource,
    /function renderDirPreview\(dirId, dirSessions\)[\s\S]*?taskBoardRunningCountForDir\(dirId\)/);
  assert.match(dashboardSource,
    /function renderDirectoryDetailBody\(dirId\)[\s\S]*?taskBoardRunningCountForDir\(dirId\)/);
});

test('unified Fleet task tab renders and clears the shared running animation', () => {
  let runningTaskCount = 2;
  const plannerRoot = {};
  const mounts = [];
  const tabClasses = new Set();
  const taskTab = {
    innerHTML: '',
    classList: {
      toggle(name, enabled) {
        if (enabled) tabClasses.add(name);
        else tabClasses.delete(name);
      },
    },
  };
  const fleetTasks = [
    { recordType: 'planned', status: 'active', runState: 'idle', workflowStage: 'inbox' },
    { recordType: 'observed', status: 'active', runState: 'running', workflowStage: 'inbox' },
    { recordType: 'observed', status: 'active', runState: 'waiting', workflowStage: 'inbox' },
    { recordType: 'observed', status: 'active', runState: 'succeeded', workflowStage: 'inbox' },
    { recordType: 'observed', status: 'active', runState: 'idle', workflowStage: 'inbox' },
    { recordType: 'planned', status: 'done', runState: 'running', workflowStage: 'doing' },
    { recordType: 'planned', status: 'archived', runState: 'waiting', workflowStage: 'inbox' },
  ];
  const { context } = createHarness({
    taskBoardRunningCountForDir: () => runningTaskCount,
    _tbTasksForDir: () => fleetTasks,
    renderTaskBoardSection: () => '<div class="legacy-board">unused</div>',
    syncTaskBoardDirComposer() {},
    MultiCCTaskPlanner: {
      mountFleet(element, dirId) { mounts.push({ element, dirId }); },
      unmountFleet() {},
    },
  });
  const body = {
    innerHTML: '',
    querySelector(selector) {
      if (selector === '.fleet-task-planner-root') return plannerRoot;
      if (selector === '.dd-tab[data-dir-detail-tab="tasks"]') return taskTab;
      return null;
    },
    querySelectorAll() { return []; },
  };
  context.document.getElementById = id => id === 'dir-detail-body' ? body : null;
  vm.runInContext(`
    _cachedDirectories = [{ id: 'fleet-1', name: 'Fleet 1' }];
    _dirDetailTab = 'tasks';
  `, context);

  assert.equal(context.directoryWorkTaskCount(fleetTasks), 3);
  context.renderDirectoryDetailBody('fleet-1');
  assert.equal((body.innerHTML.match(/<button class="dd-tab/g) || []).length, 2);
  assert.match(body.innerHTML, /dd-tab on has-running/);
  assert.match(body.innerHTML, /dd-tab-running/);
  assert.match(body.innerHTML, /data-status="running"/);
  assert.match(body.innerHTML, /📋 任务 \(3\)/);
  assert.deepEqual(mounts, [{ element: plannerRoot, dirId: 'fleet-1' }]);

  context.refreshDirectoryDetailTaskTab('fleet-1');
  assert.equal(tabClasses.has('has-running'), true);
  assert.match(taskTab.innerHTML, /📋 任务 \(3\)[\s\S]*dd-tab-running/);

  runningTaskCount = 0;
  context.refreshDirectoryDetailTaskTab('fleet-1');
  assert.equal(tabClasses.has('has-running'), false);
  assert.equal(taskTab.innerHTML, '📋 任务 (3)');

  const css = read('public/manage.html');
  assert.match(css, /\.dd-tab\.has-running::after[\s\S]*?ddTabRunningSweep/);
  assert.match(css, /prefers-reduced-motion:reduce[\s\S]*?\.card-border-rainbow\{animation:none/);
});

test('Fleet detail exposes one task tab and maps legacy task routes onto it', () => {
  const mounts = [];
  let unmounts = 0;
  const composerStates = [];
  const plannerRoot = {};
  const body = {
    innerHTML: '',
    querySelector(selector) {
      return selector === '.fleet-task-planner-root' ? plannerRoot : null;
    },
    querySelectorAll() { return []; },
  };
  const modalClasses = new Set();
  const modal = {
    classList: {
      toggle(name, enabled) {
        if (enabled) modalClasses.add(name);
        else modalClasses.delete(name);
      },
    },
  };
  const { context } = createHarness({
    _tbTasksForDir: dirId => [{
      id: `planned-${dirId}`, recordType: 'planned', status: 'active',
    }],
    renderEventTimeline: () => '<div class="timeline">timeline</div>',
    renderTaskBoardSection: () => '<div class="board">board</div>',
    syncTaskBoardDirComposer(dirId, active) { composerStates.push({ dirId, active }); },
    MultiCCTaskPlanner: {
      mountFleet(element, dirId) { mounts.push({ element, dirId }); },
      unmountFleet() { unmounts += 1; },
    },
  });
  context.document.getElementById = id => {
    if (id === 'dir-detail-body') return body;
    if (id === 'dir-detail-modal') return modal;
    return null;
  };
  vm.runInContext(`
    _cachedDirectories = [
      { id: 'fleet-a', name: 'Fleet A' },
      { id: 'fleet-b', name: 'Fleet B' },
    ];
    _detailDirId = 'fleet-a';
  `, context);

  context.switchDirDetailTab('planner');
  assert.equal(vm.runInContext('_dirDetailTab', context), 'tasks');
  assert.equal((body.innerHTML.match(/<button class="dd-tab/g) || []).length, 2);
  assert.match(body.innerHTML, /class="dd-tab on"[^>]*onclick="switchDirDetailTab\('tasks'\)"[^>]*>📋 任务 \(1\)/);
  assert.doesNotMatch(body.innerHTML, /任务板|计划看板/);
  assert.equal(mounts.length, 1);
  assert.equal(mounts[0].element, plannerRoot);
  assert.equal(mounts[0].dirId, 'fleet-a');
  assert.equal(modalClasses.has('fleet-planner-open'), true);
  assert.deepEqual(composerStates.at(-1), { dirId: 'fleet-a', active: false });

  vm.runInContext("_detailDirId = 'fleet-b'", context);
  context.renderDirectoryDetailBody('fleet-b');
  assert.deepEqual(mounts.map(call => call.dirId), ['fleet-a', 'fleet-b']);

  context.switchDirDetailTab('sessions');
  assert.equal(unmounts, 1);
  assert.equal(modalClasses.has('fleet-planner-open'), false);
  assert.deepEqual(composerStates.at(-1), { dirId: 'fleet-b', active: false });
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

test('a dragged fleet order overrides creation order without unpinning the commander', async () => {
  const puts = [];
  const { context } = createHarness({
    fetch: async (url, init) => {
      const body = init && init.body ? JSON.parse(init.body) : null;
      puts.push({ url, order: body && body.order });
      return { ok: true, json: async () => ({ ok: true, layout: { dirOrder: [], sessionOrder: { 'dir-1': body.order } } }) };
    },
  });
  const iso = (day) => `2026-03-${String(day).padStart(2, '0')}T00:00:00.000Z`;
  const sessions = [
    { id: 'a', kind: 'chat', cli: 'claude', createdAt: iso(1) },
    { id: 'b', kind: 'chat', cli: 'claude', createdAt: iso(2) },
    { id: 'cmdr', kind: 'chat', cli: 'claude', type: 'commander', createdAt: iso(3) },
  ];
  const idsIn = (html) => (html.match(/data-id="([^"]+)"/g) || [])
    .map(m => m.slice('data-id="'.length, -1));

  // Without a saved order: commander pinned, the rest oldest-first.
  assert.deepEqual(idsIn(context.renderDirSessionGroups(sessions, 'dir-1')), ['cmdr', 'a', 'b']);

  await context.MultiCCUiLayout.saveSessionOrder('dir-1', ['b', 'a']);
  assert.equal(puts[0].url, '/api/ui-layout/session-order/dir-1');
  assert.deepEqual(idsIn(context.renderDirSessionGroups(sessions, 'dir-1')), ['cmdr', 'b', 'a']);

  // A fleet the user never dragged is unaffected, and the grid carries the fleet
  // id so a drop can only ever reorder within its own fleet.
  assert.deepEqual(idsIn(context.renderDirSessionGroups(sessions, 'dir-2')), ['cmdr', 'a', 'b']);
  assert.match(context.renderDirSessionGroups(sessions, 'dir-1'), /sess-card-grid" data-dir-id="dir-1"/);

  // A session created after the last drag is unranked, so it lands at the end
  // rather than at some arbitrary position.
  const withNew = [...sessions, { id: 'fresh', kind: 'chat', cli: 'claude', createdAt: iso(9) }];
  assert.deepEqual(idsIn(context.renderDirSessionGroups(withNew, 'dir-1')), ['cmdr', 'b', 'a', 'fresh']);
});

test('the pre-server localStorage arrangement is lifted once, then forgotten', async () => {
  const puts = [];
  const { context, storage } = createHarness({
    fetch: async (url, init) => {
      if (url === '/api/ui-layout') return { ok: true, json: async () => ({ ok: true, layout: { dirOrder: [], sessionOrder: {} } }) };
      puts.push({ url, order: JSON.parse(init.body).order });
      return { ok: true, json: async () => ({ ok: true, layout: { dirOrder: ['d9', 'd8'], sessionOrder: {} } }) };
    },
  });
  storage.set('multicc_dir_order', '["d9","d8"]');

  await context.MultiCCUiLayout.load();
  assert.deepEqual(puts, [{ url: '/api/ui-layout/dir-order', order: ['d9', 'd8'] }]);
  assert.equal(storage.has('multicc_dir_order'), false, 'the per-device copy must not linger');
  assert.deepEqual(context.getDirOrder(), ['d9', 'd8']);
});

test('arranging one group in a fleet does not discard the other group order', () => {
  const { context } = createHarness();
  // A fleet stores ONE flat list for chats + terminals, so a drag inside the
  // chat grid must carry the terminal ids over. Writing only the dragged
  // group's order back would silently reset the other group to creation order.
  assert.deepEqual(
    context.MultiCCUiLayout.mergeGroupOrder(['t2', 't1'], ['c2', 'c1']),
    ['c2', 'c1', 't2', 't1']);
  // Re-dragging the same group replaces its entries rather than duplicating.
  assert.deepEqual(context.MultiCCUiLayout.mergeGroupOrder(['c1', 'c2'], ['c2', 'c1']), ['c2', 'c1']);
});

test('a server arrangement wins over whatever this browser last had locally', async () => {
  const { context, storage } = createHarness({
    fetch: async (url) => {
      assert.equal(url, '/api/ui-layout', 'nothing may be uploaded when the server already has an order');
      return { ok: true, json: async () => ({ ok: true, layout: { dirOrder: ['from-server'], sessionOrder: {} } }) };
    },
  });
  storage.set('multicc_dir_order', '["stale-local"]');
  await context.MultiCCUiLayout.load();
  assert.deepEqual(context.getDirOrder(), ['from-server']);
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
      if (url === '/api/ui-layout') return { ok: true, json: async () => ({ ok: true, layout: { dirOrder: [], sessionOrder: {} } }) };
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
