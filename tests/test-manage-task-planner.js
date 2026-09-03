'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/manage.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'public/manage-task-planner.js'), 'utf8');
const taskBoardJs = fs.readFileSync(path.join(root, 'public/manage-taskboard.js'), 'utf8');
const dashboardJs = fs.readFileSync(path.join(root, 'public/manage-dashboard.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/manage-task-planner.css'), 'utf8');
const zh = JSON.parse(fs.readFileSync(path.join(root, 'app/assets/i18n/zh.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(root, 'app/assets/i18n/en.json'), 'utf8'));

function sourceSection(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing source section start: ${start}`);
  assert.notEqual(to, -1, `missing source section end: ${end}`);
  return source.slice(from, to);
}

function plannerSourceWithTestHooks() {
  const marker = '  window.MultiCCTaskPlanner = Object.freeze({';
  assert.ok(js.includes(marker), 'planner API marker must exist');
  return js.replace(marker, `  window.__plannerTestHooks = Object.freeze({
    taskTitleFromText,
    dialogDirectoryId,
    createTodoFromDialog,
    openStartNowDialog,
    closePlannerOverlay,
  });

${marker}`);
}

function fakePlannerRoot() {
  const classes = new Set();
  const listeners = new Map();
  let innerHTML = '';
  const innerHTMLWrites = [];
  return {
    get innerHTML() { return innerHTML; },
    set innerHTML(value) {
      innerHTML = String(value);
      innerHTMLWrites.push(innerHTML);
    },
    innerHTMLWrites,
    classList: {
      contains(name) { return classes.has(name); },
      toggle(name, force) {
        const enabled = force === undefined ? !classes.has(name) : !!force;
        if (enabled) classes.add(name);
        else classes.delete(name);
        return enabled;
      },
    },
    addEventListener(type, listener) { listeners.set(type, listener); },
    dispatch(type, event) {
      const listener = listeners.get(type);
      if (!listener) throw new Error(`missing ${type} listener`);
      return listener(event);
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
}

function dispatchPlannerAction(rootElement, action, dataset = {}) {
  const target = {
    dataset: { action, ...dataset },
    closest(selector) { return selector === '[data-action]' ? this : null; },
  };
  rootElement.dispatch('click', { target });
}

function articleTaskIds(htmlText, className) {
  const ids = [];
  const pattern = new RegExp(`<article class="${className}[^>]*data-task-id="([^"]+)"`, 'g');
  for (const match of htmlText.matchAll(pattern)) ids.push(match[1]);
  return ids.sort();
}

function createPlannerHarness(options = {}) {
  const globalRoot = fakePlannerRoot();
  const requests = [];
  const snapshot = {
    ok: true,
    revision: 1,
    modules: [],
    tasks: [
      {
        id: 'task-a', recordType: 'planned', status: 'active', runState: 'idle',
        origin: 'board',
        dirId: 'fleet-a', workflowStage: 'inbox', planningRevision: 1, rank: 1024,
        title: 'Alpha plan', description: 'Only Fleet A should show this task',
      },
      {
        id: 'task-b', recordType: 'planned', status: 'active', runState: 'idle',
        origin: 'board',
        dirId: 'fleet-b', workflowStage: 'ready', planningRevision: 1, rank: 1024,
        title: 'Beta plan', description: 'Only Fleet B should show this task',
      },
    ],
  };
  let directories = [
    { id: 'fleet-a', name: 'Fleet A' },
    { id: 'fleet-b', name: 'Fleet B' },
  ];
  let requestHandler = null;
  const storage = new Map([['multicc_lang', 'zh']]);
  const defaultDocument = {
    activeElement: null,
    body: { appendChild() {} },
    getElementById(id) { return id === 'task-planner-root' ? globalRoot : null; },
    querySelector() { return null; },
    addEventListener() {},
    createElement() { throw new Error('planner overlay was not expected in this test'); },
  };
  const document = typeof options.createDocument === 'function'
    ? options.createDocument(globalRoot) : defaultDocument;
  const context = {
    console,
    document,
    location: { search: '' },
    localStorage: {
      getItem(key) { return storage.has(key) ? storage.get(key) : null; },
      setItem(key, value) { storage.set(key, String(value)); },
    },
    URLSearchParams,
    setTimeout,
    clearTimeout,
    MultiCCApi: {
      async json(url, options) {
        requests.push({ url, options });
        if (requestHandler) {
          const handled = requestHandler(url, options);
          if (handled !== undefined) return handled;
        }
        if (url === '/api/task-board') return snapshot;
        if (url === '/api/directories') return directories;
        throw new Error(`unexpected request: ${url}`);
      },
    },
    setView() {},
    ...(options.globals || {}),
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(options.source || js, context, { filename: 'manage-task-planner.js' });
  return {
    context,
    document,
    globalRoot,
    requests,
    storage,
    setDirectories(value) { directories = value; },
    setRequestHandler(value) { requestHandler = value; },
  };
}

function createStartNowDocument(globalRoot) {
  const listeners = new Map();
  const document = {
    activeElement: null,
    overlay: null,
    getElementById(id) { return id === 'task-planner-root' ? globalRoot : null; },
    addEventListener(type, listener) { listeners.set(type, listener); },
    querySelector(selector) {
      if (selector === '.planner-overlay') {
        return this.overlay && this.overlay.isConnected ? this.overlay : null;
      }
      return null;
    },
  };
  const focusable = () => ({
    disabled: false,
    isConnected: true,
    offsetParent: {},
    listeners: new Map(),
    addEventListener(type, listener) { this.listeners.set(type, listener); },
    emit(type) { return this.listeners.get(type)?.({ target: this }); },
    focus() { document.activeElement = this; },
  });
  const returnFocus = focusable();
  const picker = focusable();
  picker.value = 'fleet-a';
  const closeButton = focusable();
  const input = focusable();
  const composerHost = {};
  document.activeElement = returnFocus;
  document.createElement = () => {
    const overlay = {
      className: '',
      dataset: {},
      innerHTML: '',
      isConnected: false,
      listeners: new Map(),
      addEventListener(type, listener) { this.listeners.set(type, listener); },
      querySelector(selector) {
        if (selector === '.planner-start-composer') return composerHost;
        if (selector === '[data-planner-dir]') return picker;
        if (selector === '.tb-input') return input;
        return null;
      },
      querySelectorAll(selector) {
        if (selector === '[data-overlay-close]') return [closeButton];
        if (selector.includes('button:not([disabled])')) return [closeButton, picker, input];
        return [];
      },
      remove() { this.isConnected = false; },
    };
    document.overlay = overlay;
    return overlay;
  };
  document.body = {
    appendChild(overlay) { overlay.isConnected = true; },
  };
  document.refs = { returnFocus, picker, closeButton, input, composerHost, listeners };
  return document;
}

async function settlePlannerLoad() {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}

test('manage shell exposes the first-class Task Center view', () => {
  assert.match(html, /manage-task-planner\.css/);
  assert.match(html, /class="nav-item" data-view="tasks"/);
  assert.match(html, /class="view planner-view" data-view="tasks"/);
  assert.match(html, /allowedViews = \[[^\]]*'tasks'/);
  assert.match(html, /manage-task-planner\.js/);
});

test('planner keeps persisted workflow identity separate from the derived TODO projection', () => {
  assert.match(js, /Object\.freeze\(\['inbox', 'ready', 'doing', 'review', 'done'\]\)/);
  assert.match(js, /Object\.freeze\(\['todo', 'board', 'activity'\]\)/);
  assert.match(js, /Object\.freeze\(\['all', 'board', 'session'\]\)/);
  assert.match(js, /Object\.freeze\(\['todo', 'attention', 'running', 'next', 'review'\]\)/);
  assert.match(js, /task\.recordType === 'planned'/);
  assert.match(js, /task\.recordType !== 'planned'/);
  assert.match(js, /statusUi\.taskStatus/);
  assert.match(js, /function workBucket\(task\)/);
  assert.match(js, /sourceTaskId: task\.id/);
});

test('planner mutations use task revisions and idempotent sends', () => {
  assert.match(js, /Math\.max\(1, Number\(task && task\.planningRevision\)/);
  assert.match(js, /const drawerContext = \{[\s\S]*?revision: Math\.max\(1, Number\(task\.planningRevision\)/);
  assert.match(js, /handleDrawerAction\(task\.id, action\.dataset\.drawerAction, action, drawerContext\)/);
  assert.match(js, /async function persistDrawerChanges[\s\S]*?expectedRevisionBody\(task, payload, context\.revision\)/);
  assert.match(js, /async function startTask[\s\S]*?persistDrawerChanges\(taskId, context\)[\s\S]*?expectedRevision: context\.revision[\s\S]*?handleConflict\(error\)/);
  assert.match(js, /async function setLifecycle[\s\S]*?persistDrawerChanges\(taskId, context\)[\s\S]*?expectedRevision: context\.revision/);
  assert.match(js, /\/api\/task-board\/tasks\/\$\{encodeURIComponent\(taskId\)\}\/move/);
  assert.match(js, /\/api\/task-board\/tasks\/\$\{encodeURIComponent\(taskId\)\}\/update/);
  assert.match(js, /async function createTodoFromDialog[\s\S]*?requestJson\('\/api\/task-board\/tasks'/);
  assert.match(js, /function bindPlannerRoot[\s\S]*?addEventListener\('click', handleRootClick\)[\s\S]*?addEventListener\('keydown', handleRootKeydown\)/);
  assert.doesNotMatch(js, /addEventListener\('(?:dragstart|dragover|drop|dragend)'/);
  assert.match(js, /function unmountFleetSurface\(\)[\s\S]*?closePlannerOverlay\(\)/);
  assert.match(js, /async function promoteObserved[\s\S]*?dirId: taskContextDirId\(task, moduleMap\)/);
  assert.match(js, /sendIdForTask\(taskId\)/);
  assert.match(js, /state\.sendIds\.delete/);
  assert.match(js, /isConflict\(error\)/);
  assert.match(js, /id="planner-edit-title" name="title" maxlength="40"/);
});

test('planner splits TODO capture from the chat-parity start-now entry', () => {
  assert.match(js, /data-action="new-todo"[^>]*>\$\{esc\(tr\('plannerNewTodo'\)\)\}/);
  assert.match(js, /data-action="start-new-now"[^>]*>\$\{esc\(tr\('plannerStartNewNow'\)\)\}/);
  assert.doesNotMatch(js, /data-action="new-task"/);
  assert.match(js, /kind === 'new-todo'\) openNewTodoDialog\(\)/);
  assert.match(js, /kind === 'start-new-now'\) openStartNowDialog\(\)/);

  const capture = sourceSection(js,
    'async function createTodoFromDialog', 'function openStartNowDialog');
  assert.match(capture, /requestJson\('\/api\/task-board\/tasks'/);
  assert.match(capture, /recordType: 'planned'/);
  assert.match(capture, /workflowStage: 'inbox'/);
  assert.doesNotMatch(capture, /\/api\/task-board\/send|\/tasks\/\$\{[^}]+\}\/send/,
    'capturing a TODO must not start an execution turn');

  const startNow = sourceSection(js,
    'function openStartNowDialog', 'function drawerFormPayload');
  assert.match(startNow, /window\.MultiCCTaskBoardComposer/);
  assert.match(startNow, /composerApi\.mount\(/);
  assert.match(startNow, /requestJson\('\/api\/task-board\/send'/);
  assert.doesNotMatch(startNow, /requestJson\('\/api\/task-board\/tasks'/,
    'start now must use the one-request board composer ingress');
});

test('both planner creation dialogs retain modal labels, focus, and cleanup contracts', () => {
  const captureDialog = sourceSection(js,
    'function openNewTodoDialog', 'async function createTodoFromDialog');
  assert.match(captureDialog,
    /id="planner-new-form" role="dialog" aria-modal="true" aria-labelledby="planner-new-todo-heading"/);
  assert.match(captureDialog,
    /<label[^>]*for="planner-new-todo"[\s\S]*?<textarea id="planner-new-todo" name="text"[^>]*required/);
  assert.match(captureDialog, /activateOverlay\(overlay, '\[name="text"\]'\)/);

  const startDialog = sourceSection(js,
    'function openStartNowDialog', 'function drawerFormPayload');
  assert.match(startDialog,
    /role="dialog" aria-modal="true" aria-labelledby="planner-start-now-heading"/);
  assert.match(startDialog, /<h2 id="planner-start-now-heading">/);
  assert.match(startDialog, /activateOverlay\(overlay, '\.tb-input'\)/);
  assert.match(startDialog, /overlay\.__plannerCleanup = \(\) => composer\.destroy\(\)/);
  assert.match(js,
    /function closePlannerOverlay\(expectedOverlay\)[\s\S]*?const cleanup = overlay\.__plannerCleanup[\s\S]*?typeof cleanup === 'function'[\s\S]*?cleanup\(\)[\s\S]*?overlay\.remove\(\)/);
});

test('the shared task-board composer has an explicit mount and destroy lifecycle', () => {
  assert.match(taskBoardJs,
    /window\.MultiCCTaskBoardComposer = Object\.freeze\(\{\s*mount: createTbComposer,\s*\}\)/);
  const lifecycle = sourceSection(taskBoardJs,
    'return {\n    reset() { clearMessageDraft(); },', '// Board-tab composer');
  assert.match(lifecycle, /destroy\(\) \{/);
  assert.match(lifecycle, /pickerEpoch \+= 1/);
  assert.match(lifecycle, /runtimeLoadEpoch \+= 1/);
  assert.match(lifecycle, /if \(closeActivePicker\) closeActivePicker\(\)/);
  assert.match(lifecycle, /recorder && recorder\.state === 'recording'[\s\S]*?recorder\.stop\(\)/);
  assert.match(lifecycle, /clearMessageDraft\(\)/);

  const taskBoardScript = html.indexOf('<script src="manage-taskboard.js"></script>');
  const plannerScript = html.indexOf('<script src="manage-task-planner.js"></script>');
  assert.ok(taskBoardScript > 0 && plannerScript > taskBoardScript,
    'the shared composer must load before the planner consumes it');
});

test('New TODO posts one Inbox record with a derived title and never starts a run', async () => {
  class FakeFormData {
    constructor(form) { this.values = form.values; }
    get(name) { return this.values[name]; }
  }
  const harness = createPlannerHarness({
    source: plannerSourceWithTestHooks(),
    globals: { FormData: FakeFormData },
  });
  harness.setRequestHandler((url) => {
    if (url === '/api/task-board/tasks') {
      return {
        ok: true,
        task: {
          id: 'todo-new', recordType: 'planned', origin: 'board', status: 'active',
          runState: 'idle', workflowStage: 'inbox', planningRevision: 1, dirId: 'fleet-b',
          title: 'A'.repeat(40), description: `${'A'.repeat(45)}\nKeep all of this context`,
        },
      };
    }
    return undefined;
  });
  harness.context.setView('tasks');
  await settlePlannerLoad();
  harness.requests.length = 0;

  const form = {
    values: { text: `${'A'.repeat(45)}\nKeep all of this context` },
    reportValidity() { throw new Error('valid form should not report'); },
  };
  const picker = { value: 'fleet-b' };
  const buttons = [{ disabled: false }];
  const overlay = {
    isConnected: false,
    querySelector(selector) {
      if (selector === 'form') return form;
      if (selector === '[data-planner-dir]') return picker;
      return null;
    },
    querySelectorAll(selector) { return selector === 'button' ? buttons : []; },
  };

  await harness.context.__plannerTestHooks.createTodoFromDialog(overlay, 'fleet-a');
  const writes = harness.requests.filter(request => request.options?.method === 'POST');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].url, '/api/task-board/tasks');
  assert.deepEqual(JSON.parse(JSON.stringify(writes[0].options.json)), {
    recordType: 'planned',
    title: 'A'.repeat(40),
    description: `${'A'.repeat(45)}\nKeep all of this context`,
    dirId: 'fleet-b',
    workflowStage: 'inbox',
    priority: null,
    dueAt: null,
    acceptanceCriteria: null,
  });
  assert.equal(harness.requests.some(request => request.url.includes('/send')), false);
});

test('Start now validates workspace, preserves its draft on workspace change, and uses one atomic send', async () => {
  let composerOptions = null;
  const contextChanges = [];
  let destroyCount = 0;
  const harness = createPlannerHarness({
    source: plannerSourceWithTestHooks(),
    createDocument: createStartNowDocument,
    globals: {
      MultiCCTaskBoardComposer: {
        mount(_host, options) {
          composerOptions = options;
          return {
            destroy() { destroyCount += 1; },
            setContext(...args) { contextChanges.push(args); },
          };
        },
      },
    },
  });
  harness.setRequestHandler((url) => (
    url === '/api/task-board/send' ? { ok: true, queued: true, taskId: 'started-now' } : undefined
  ));
  harness.context.setView('tasks');
  await settlePlannerLoad();
  harness.requests.length = 0;

  harness.context.__plannerTestHooks.openStartNowDialog();
  const firstOverlay = harness.document.overlay;
  const { picker, closeButton, returnFocus } = harness.document.refs;
  assert.ok(composerOptions, 'shared composer should mount');

  picker.value = '';
  await assert.rejects(
    () => composerOptions.submit({ text: 'Do it', clientMsgId: 'msg-1' }),
    /请输入 TODO 并选择工作区/,
  );
  assert.equal(harness.requests.some(request => request.options?.method === 'POST'), false);

  picker.value = 'fleet-b';
  picker.emit('change');
  assert.deepEqual(JSON.parse(JSON.stringify(contextChanges)), [
    ['fleet-b', { preserveDraft: true }],
  ]);
  composerOptions.onSendingChange(true);
  assert.equal(picker.disabled, true);
  assert.equal(closeButton.disabled, true);
  assert.equal(firstOverlay.dataset.plannerSending, 'true');
  composerOptions.onSendingChange(false);

  const payload = {
    text: 'Do it now', clientMsgId: 'msg-atomic', cli: 'codex', provider: 'provider-a',
    goal: true, goalLimits: { maxRounds: 12, maxBudget: 5000 },
  };
  await composerOptions.submit(payload);
  const writes = harness.requests.filter(request => request.options?.method === 'POST');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].url, '/api/task-board/send');
  assert.deepEqual(JSON.parse(JSON.stringify(writes[0].options.json)), { ...payload, dirId: 'fleet-b' });
  assert.equal(harness.requests.some(request => request.url === '/api/task-board/tasks'), false);
  assert.equal(firstOverlay.isConnected, false);
  assert.equal(destroyCount, 1);
  assert.equal(harness.document.activeElement, returnFocus);

  harness.context.__plannerTestHooks.openStartNowDialog();
  const newerOverlay = harness.document.overlay;
  harness.context.__plannerTestHooks.closePlannerOverlay(firstOverlay);
  assert.equal(newerOverlay.isConnected, true, 'a stale completion must not close a newer dialog');
  harness.context.__plannerTestHooks.closePlannerOverlay(newerOverlay);
  assert.equal(destroyCount, 2);
});

test('Fleet planner mount is isolated and unmount or global navigation restores every Fleet', async () => {
  const { context, globalRoot, requests, storage } = createPlannerHarness();
  const fleetRoot = fakePlannerRoot();

  dispatchPlannerAction(globalRoot, 'origin', { origin: 'all' });
  context.MultiCCTaskPlanner.mountFleet(fleetRoot, 'fleet-a');
  await settlePlannerLoad();

  assert.match(fleetRoot.innerHTML, /planner-fleet-lock/);
  assert.match(fleetRoot.innerHTML, /Fleet A/);
  assert.match(fleetRoot.innerHTML, /Alpha plan/);
  assert.doesNotMatch(fleetRoot.innerHTML, /Beta plan|id="planner-fleet-filter"/);
  assert.deepEqual(requests.map(request => request.url), ['/api/task-board', '/api/directories']);

  dispatchPlannerAction(fleetRoot, 'origin', { origin: 'session' });
  assert.equal(storage.get('multicc_task_center_origin'), 'session');

  context.MultiCCTaskPlanner.unmountFleet();
  assert.equal(storage.get('multicc_task_center_origin'), 'all');
  assert.equal(fleetRoot.innerHTML, '');
  assert.match(globalRoot.innerHTML, /id="planner-fleet-filter"/);
  assert.match(globalRoot.innerHTML, /Alpha plan/);
  assert.match(globalRoot.innerHTML, /Beta plan/);

  context.MultiCCTaskPlanner.mountFleet(fleetRoot, 'fleet-a');
  assert.doesNotMatch(fleetRoot.innerHTML, /Beta plan/);
  context.setView('tasks');
  assert.equal(fleetRoot.innerHTML, '');
  assert.match(globalRoot.innerHTML, /id="planner-fleet-filter"/);
  assert.match(globalRoot.innerHTML, /Alpha plan/);
  assert.match(globalRoot.innerHTML, /Beta plan/);
});

test('planner refresh and Fleet mount renew the directory catalog', async () => {
  const { context, requests, setDirectories } = createPlannerHarness();
  const fleetRoot = fakePlannerRoot();

  context.MultiCCTaskPlanner.mountFleet(fleetRoot, 'fleet-a');
  await settlePlannerLoad();
  assert.match(fleetRoot.innerHTML, /Fleet A/);

  setDirectories([
    { id: 'fleet-a', name: 'Fleet A renamed' },
    { id: 'fleet-c', name: 'Fleet C' },
  ]);
  await context.MultiCCTaskPlanner.refresh();
  assert.match(fleetRoot.innerHTML, /Fleet A renamed/);

  context.MultiCCTaskPlanner.mountFleet(fleetRoot, 'fleet-c');
  await settlePlannerLoad();
  assert.match(fleetRoot.innerHTML, /Fleet C/);
  assert.ok(requests.filter(request => request.url === '/api/directories').length >= 3);
});

test('a late directory refresh still renders after a newer board-only refresh', async () => {
  const { context, globalRoot, setRequestHandler } = createPlannerHarness();
  context.setView('tasks');
  await settlePlannerLoad();
  assert.match(globalRoot.innerHTML, /Fleet A/);

  let resolveDirectories;
  const lateDirectories = new Promise(resolve => { resolveDirectories = resolve; });
  setRequestHandler(url => {
    if (url === '/api/directories') return lateDirectories;
    return undefined;
  });

  const directoryRefresh = context.MultiCCTaskPlanner.refresh();
  context.onTaskBoardUpdate({ type: 'task_board_update' });
  await new Promise(resolve => setTimeout(resolve, 300));
  resolveDirectories([
    { id: 'fleet-a', name: 'Fleet A renamed after race' },
    { id: 'fleet-b', name: 'Fleet B' },
  ]);
  await directoryRefresh;
  await settlePlannerLoad();

  assert.match(globalRoot.innerHTML, /Fleet A renamed after race/);
});

test('switching Fleets on the same root clears stale DOM before rendering', async () => {
  const { context } = createPlannerHarness();
  const fleetRoot = fakePlannerRoot();
  context.MultiCCTaskPlanner.mountFleet(fleetRoot, 'fleet-a');
  await settlePlannerLoad();
  assert.match(fleetRoot.innerHTML, /Alpha plan/);

  fleetRoot.innerHTMLWrites.length = 0;
  context.MultiCCTaskPlanner.mountFleet(fleetRoot, 'fleet-b');

  assert.equal(fleetRoot.innerHTMLWrites[0], '');
  assert.match(fleetRoot.innerHTML, /Beta plan/);
  assert.doesNotMatch(fleetRoot.innerHTML, /Alpha plan/);
});

test('planner reconciles a newer task-board snapshot and ignores stale revisions', async () => {
  const { context, globalRoot } = createPlannerHarness();
  context.setView('tasks');
  await settlePlannerLoad();
  assert.match(globalRoot.innerHTML, /Alpha plan/);

  const reconciled = context.MultiCCTaskPlanner.reconcileSnapshot({
    ok: true,
    revision: 2,
    modules: [],
    tasks: [{
      id: 'task-new', recordType: 'planned', status: 'active', runState: 'idle',
      origin: 'board',
      dirId: 'fleet-a', workflowStage: 'doing', planningRevision: 1, rank: 1024,
      title: 'Polling reconciliation arrived',
    }],
  });
  assert.equal(reconciled, true);
  assert.match(globalRoot.innerHTML, /Polling reconciliation arrived/);
  assert.doesNotMatch(globalRoot.innerHTML, /Alpha plan/);

  const ignored = context.MultiCCTaskPlanner.reconcileSnapshot({
    ok: true,
    revision: 1,
    modules: [],
    tasks: [],
  });
  assert.equal(ignored, false);
  assert.match(globalRoot.innerHTML, /Polling reconciliation arrived/);
});

test('a superseded planner request cannot replace a reconciled snapshot with an error', async () => {
  const { context, globalRoot, setRequestHandler } = createPlannerHarness();
  let rejectOldBoardRequest;
  const oldBoardRequest = new Promise((resolve, reject) => {
    rejectOldBoardRequest = reject;
  });
  setRequestHandler(url => url === '/api/task-board' ? oldBoardRequest : undefined);
  context.setView('tasks');
  await settlePlannerLoad();

  const reconciled = context.MultiCCTaskPlanner.reconcileSnapshot({
    ok: true,
    revision: 2,
    modules: [],
    tasks: [{
      id: 'task-fresh', recordType: 'planned', status: 'active', runState: 'idle',
      origin: 'board',
      dirId: 'fleet-a', workflowStage: 'doing', planningRevision: 1, rank: 1024,
      title: 'Fresh snapshot survives',
    }],
  });
  assert.equal(reconciled, true);
  assert.match(globalRoot.innerHTML, /Fresh snapshot survives/);

  rejectOldBoardRequest(new Error('superseded request failed'));
  await settlePlannerLoad();

  assert.match(globalRoot.innerHTML, /Fresh snapshot survives/);
  assert.doesNotMatch(globalRoot.innerHTML, /planner-error/);
});

test('Fleet planner reconciles a newer snapshot without leaking other Fleets', async () => {
  const { context } = createPlannerHarness();
  const fleetRoot = fakePlannerRoot();
  context.MultiCCTaskPlanner.mountFleet(fleetRoot, 'fleet-a');
  await settlePlannerLoad();

  const reconciled = context.MultiCCTaskPlanner.reconcileSnapshot({
    ok: true,
    revision: 2,
    modules: [],
    tasks: [
      {
        id: 'task-a-new', recordType: 'planned', status: 'active', runState: 'idle',
        origin: 'board',
        dirId: 'fleet-a', workflowStage: 'review', planningRevision: 1, rank: 1024,
        title: 'Fleet A polling update',
      },
      {
        id: 'task-b-new', recordType: 'planned', status: 'active', runState: 'idle',
        origin: 'board',
        dirId: 'fleet-b', workflowStage: 'review', planningRevision: 1, rank: 1024,
        title: 'Fleet B must stay hidden',
      },
    ],
  });

  assert.equal(reconciled, true);
  assert.match(fleetRoot.innerHTML, /Fleet A polling update/);
  assert.doesNotMatch(fleetRoot.innerHTML, /Alpha plan|Fleet B must stay hidden/);
});

test('Fleet planner keeps body-only observed tasks in every referenced Fleet', async () => {
  const { context } = createPlannerHarness();
  const fleetRoot = fakePlannerRoot();
  context.MultiCCTaskPlanner.mountFleet(fleetRoot, 'fleet-b');
  await settlePlannerLoad();
  dispatchPlannerAction(fleetRoot, 'origin', { origin: 'all' });

  assert.equal(context.MultiCCTaskPlanner.reconcileSnapshot({
    ok: true,
    revision: 2,
    modules: [],
    tasks: [{
      id: 'multi-fleet-observed', recordType: 'observed', origin: 'session',
      status: 'active', runState: 'waiting', workflowStage: 'inbox',
      dirId: 'fleet-a', dirIds: ['fleet-a', 'fleet-b'], rank: 1,
      title: 'Shared observed task', description: '', body: 'Body-only searchable details',
    }],
  }), true);

  assert.match(fleetRoot.innerHTML, /Shared observed task/);
  assert.match(fleetRoot.innerHTML, /Body-only searchable details/);
  assert.match(fleetRoot.innerHTML, />Fleet B</);
  assert.doesNotMatch(fleetRoot.innerHTML, />Fleet A</);
});

test('TODO and Board share one five-bucket projection with explicit source filtering', async () => {
  const { context, globalRoot, storage } = createPlannerHarness();
  context.setView('tasks');
  await settlePlannerLoad();

  const tasks = [
    {
      id: 'todo-board', title: 'Todo board', origin: 'board', recordType: 'planned',
      status: 'active', runState: 'idle', workflowStage: 'inbox', dirId: 'fleet-a', rank: 1,
    },
    {
      id: 'attention-board', title: 'Attention board', origin: 'board', recordType: 'planned',
      status: 'active', runState: 'waiting', workflowStage: 'ready', dirId: 'fleet-a', rank: 2,
    },
    {
      id: 'attention-session', title: 'Attention session', origin: 'session', recordType: 'observed',
      status: 'active', runState: 'error', workflowStage: 'inbox', dirId: 'fleet-a', rank: 3,
    },
    {
      id: 'running-board', title: 'Running board', origin: 'board', recordType: 'planned',
      status: 'active', runState: 'running', workflowStage: 'doing', dirId: 'fleet-a', rank: 4,
    },
    {
      id: 'running-session', title: 'Running session', origin: 'session', recordType: 'observed',
      status: 'active', runState: 'queued', workflowStage: 'inbox', dirId: 'fleet-a', rank: 5,
    },
    {
      id: 'next-board', title: 'Next board', origin: 'board', recordType: 'planned',
      status: 'active', runState: 'idle', workflowStage: 'ready', dirId: 'fleet-a', rank: 6,
    },
    {
      id: 'reopened-board', title: 'Reopened board', origin: 'board', recordType: 'planned',
      status: 'active', runState: 'succeeded', workflowStage: 'ready', dirId: 'fleet-a', rank: 7,
    },
    {
      id: 'review-board', title: 'Review board', origin: 'board', recordType: 'planned',
      status: 'active', runState: 'idle', workflowStage: 'review', dirId: 'fleet-a', rank: 8,
    },
    {
      id: 'succeeded-board', title: 'Succeeded board', origin: 'board', recordType: 'planned',
      status: 'active', runState: 'succeeded', workflowStage: 'inbox', dirId: 'fleet-a', rank: 9,
    },
    {
      id: 'observed-succeeded', title: 'Observed succeeded archive only', origin: 'session', recordType: 'observed',
      status: 'active', runState: 'succeeded', workflowStage: 'inbox', dirId: 'fleet-a', rank: 10,
    },
    {
      id: 'observed-idle', title: 'Observed idle archive only', origin: 'session', recordType: 'observed',
      status: 'active', runState: 'idle', workflowStage: 'inbox', dirId: 'fleet-a', rank: 11,
    },
    {
      id: 'done-board', title: 'Done outside workspace', origin: 'board', recordType: 'planned',
      status: 'done', runState: 'running', workflowStage: 'doing', dirId: 'fleet-a', rank: 12,
    },
    {
      id: 'archived-board', title: 'Archived outside workspace', origin: 'board', recordType: 'planned',
      status: 'archived', runState: 'waiting', workflowStage: 'inbox', dirId: 'fleet-a', rank: 13,
    },
  ];
  assert.equal(context.MultiCCTaskPlanner.reconcileSnapshot({
    ok: true, revision: 2, modules: [], tasks,
  }), true);

  // Independent tasks are the default view; changing the source is persisted.
  assert.match(globalRoot.innerHTML, /Todo board/);
  assert.doesNotMatch(globalRoot.innerHTML, /Attention session/);
  dispatchPlannerAction(globalRoot, 'origin', { origin: 'session' });
  assert.equal(storage.get('multicc_task_center_origin'), 'session');
  assert.match(globalRoot.innerHTML, /Attention session/);
  assert.match(globalRoot.innerHTML, /Running session/);
  assert.doesNotMatch(globalRoot.innerHTML, /Todo board|Observed succeeded archive only|Observed idle archive only/);

  dispatchPlannerAction(globalRoot, 'origin', { origin: 'all' });
  const expectedIds = [
    'attention-board', 'attention-session', 'next-board', 'reopened-board',
    'review-board', 'running-board', 'running-session', 'succeeded-board', 'todo-board',
  ].sort();
  assert.deepEqual(articleTaskIds(globalRoot.innerHTML, 'planner-todo-row'), expectedIds);

  const groupHtml = bucket => {
    const match = globalRoot.innerHTML.match(new RegExp(
      `<section class="planner-todo-group" data-bucket="${bucket}">([\\s\\S]*?)<\\/section>`,
    ));
    return match ? match[1] : '';
  };
  const expectedByBucket = {
    todo: ['Todo board'],
    attention: ['Attention board', 'Attention session'],
    running: ['Running board', 'Running session'],
    next: ['Next board', 'Reopened board'],
    review: ['Review board', 'Succeeded board'],
  };
  for (const [bucket, titles] of Object.entries(expectedByBucket)) {
    const bucketMarkup = groupHtml(bucket);
    assert.ok(bucketMarkup, `missing ${bucket} group`);
    for (const title of titles) assert.match(bucketMarkup, new RegExp(title));
  }
  for (const task of tasks.filter(item => expectedIds.includes(item.id))) {
    assert.equal((globalRoot.innerHTML.match(new RegExp(`>${task.title}<`, 'g')) || []).length, 1,
      `${task.id} must belong to exactly one TODO bucket`);
  }

  // Switching presentation must not change membership or silently resurrect
  // completed/idle observed rows into the work queue.
  dispatchPlannerAction(globalRoot, 'mode', { mode: 'board' });
  assert.deepEqual(articleTaskIds(globalRoot.innerHTML, 'planner-card'), expectedIds);
  assert.doesNotMatch(globalRoot.innerHTML, /Observed succeeded archive only|Observed idle archive only/);
  dispatchPlannerAction(globalRoot, 'mode', { mode: 'activity' });
  assert.match(globalRoot.innerHTML, /Observed succeeded archive only/);
  assert.match(globalRoot.innerHTML, /Observed idle archive only/);
});

test('the 60-second task-board poll feeds its snapshot into the planner', async () => {
  const intervals = [];
  const reconciled = [];
  const snapshot = { ok: true, revision: 7, modules: [], tasks: [] };
  const context = {
    console,
    document: { visibilityState: 'visible' },
    fetch: async () => ({ json: async () => snapshot }),
    setInterval(callback, delay) {
      intervals.push({ callback, delay });
      return intervals.length;
    },
    setTimeout,
    clearTimeout,
    encodeURIComponent,
    MultiCCTaskBoardUi: { reconcileSnapshot(value) { return value; } },
    MultiCCTaskPlanner: { reconcileSnapshot(value) { reconciled.push(value); } },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(taskBoardJs, context, { filename: 'manage-taskboard.js' });
  await settlePlannerLoad();

  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].delay, 60000);
  reconciled.length = 0;
  intervals[0].callback();
  await settlePlannerLoad();

  assert.deepEqual(reconciled, [snapshot]);
});

test('planner preserves navigation context and keeps task actions in scope', () => {
  assert.match(js, /function captureRenderState\(\)[\s\S]*?boardLeft[\s\S]*?todoTop[\s\S]*?columnScroll[\s\S]*?searchFocused/);
  assert.match(js, /function restoreRenderState\(saved\)[\s\S]*?scrollLeft = saved\.boardLeft[\s\S]*?todoScroll\.scrollTop = saved\.todoTop[\s\S]*?list\.scrollTop = saved\.columnScroll\[bucket\]/);
  assert.match(js, /renderState: captureRenderState\(\)/);
  assert.match(js, /planner-card-attention-action[\s\S]*?data-action="open-chat"/);
  assert.match(js, /kind === 'open-chat'[\s\S]*?window\.open\(`\/chat\.html\?task=/);
  assert.match(js, /topbarRefresh\.onclick = \(\) => loadPlanner\(\{ refreshDirectories: true \}\)/);
  assert.match(html, /class="search planner-hide-on-tasks"/);
  assert.match(css, /body\[data-view="tasks"\] #topbar \.planner-hide-on-tasks\s*\{\s*display: none/);
});

test('planner columns scroll independently and dynamic regions have bounded announcements', () => {
  assert.match(css, /\.planner-board-scroll\s*\{[\s\S]*?overflow-x: auto;[\s\S]*?overflow-y: hidden;/);
  assert.match(css, /\.planner-card-list\s*\{[\s\S]*?overflow-y: auto;[\s\S]*?overscroll-behavior: contain;/);
  assert.doesNotMatch(html, /id="task-planner-root"[^>]*aria-live/);
  assert.doesNotMatch(dashboardJs, /fleet-task-planner-root[^']*aria-live/);
  assert.match(js, /id="planner-new-form" role="dialog" aria-modal="true" aria-labelledby="planner-new-todo-heading"/);
  assert.match(js, /const mainA11y = `role="tabpanel" aria-labelledby="planner-mode-\$\{state\.mode\}"`/);
  assert.match(js, /role="status" aria-live="polite" aria-atomic="true"/);
});

test('planner refresh and responsive access paths are wired', () => {
  assert.match(js, /const epoch = \+\+state\.loadEpoch/);
  assert.match(js, /incomingRevision < state\.revision/);
  assert.match(js, /window\.onTaskBoardUpdate/);
  assert.match(taskBoardJs, /typeof window\.MultiCCTaskPlanner\?\.reconcileSnapshot === 'function'[\s\S]*?window\.MultiCCTaskPlanner\.reconcileSnapshot\(d\)/);
  assert.match(taskBoardJs, /_dirDetailTab === 'tasks'[\s\S]*?refreshDirectoryDetailTaskTab\(_detailDirId\)/);
  assert.match(taskBoardJs, /else if \(typeof renderDirectoryDetailBody === 'function'\) \{\s*renderDirectoryDetailBody\(_detailDirId\);/);
  assert.match(js, /name="workflowStage"/);
  assert.match(css, /@media \(max-width: 760px\)/);
  assert.match(css, /\.planner-toolbar-group\.actions\s*\{[^}]*order: 2;[^}]*width: 100%;[^}]*justify-content: flex-end;/);
  assert.match(css, /\.planner-select\s*\{\s*min-width: 0;/);
  assert.match(css, /\.planner-board\s*\{\s*display: block;[\s\S]*?\.planner-column\s*\{\s*display: flex;/);
  assert.doesNotMatch(css, /\.planner-column\.is-mobile-active/);
});

test('planner copy is present in both generated source catalogs', () => {
  const required = [
    'plannerTaskCenter', 'plannerTodoList', 'plannerBoard', 'plannerHistory',
    'plannerSource', 'plannerSourceAll', 'plannerSourceBoard', 'plannerSourceSession',
    'plannerWorkOverview', 'plannerBucketTodo', 'plannerBucketAttention',
    'plannerBucketRunning', 'plannerBucketNext', 'plannerBucketReview',
    'plannerNewTodo', 'plannerStartNewNow', 'plannerNewTodoTitle',
    'plannerNewTodoSubtitle', 'plannerTodoInput', 'plannerTodoPlaceholder', 'plannerTodoHint',
    'plannerAddTodo', 'plannerStartNowTitle', 'plannerStartNowSubtitle',
    'plannerStartNowPlaceholder', 'plannerAcceptance',
    'plannerAnswerQuestion', 'plannerInspectError', 'plannerStartQuick', 'plannerCompleteQuick',
  ];
  for (const key of required) {
    assert.equal(typeof zh[key], 'string', `missing zh.${key}`);
    assert.equal(typeof en[key], 'string', `missing en.${key}`);
    assert.ok(zh[key].length > 0 && en[key].length > 0, `empty planner copy: ${key}`);
  }
  assert.equal(zh.plannerNewTodo, '＋ 新建 TODO');
  assert.equal(en.plannerNewTodo, '+ New TODO');
  assert.equal(zh.plannerStartNewNow, '▶ 立即开始新 TODO');
  assert.equal(en.plannerStartNewNow, '▶ Start new TODO now');
});
