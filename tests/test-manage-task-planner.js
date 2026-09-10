'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createSandboxConsole } = require('./helpers/sandbox-console');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/manage.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'public/manage-task-planner.js'), 'utf8');
const taskBoardJs = fs.readFileSync(path.join(root, 'public/manage-taskboard.js'), 'utf8');
const dashboardJs = fs.readFileSync(path.join(root, 'public/manage-dashboard.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/manage-task-planner.css'), 'utf8');
const taskBoardUi = require(path.join(root, 'public/task-board-ui.js'));
const zh = JSON.parse(fs.readFileSync(path.join(root, 'app/assets/i18n/zh.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(root, 'app/assets/i18n/en.json'), 'utf8'));

function sourceSection(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing source section start: ${start}`);
  assert.notEqual(to, -1, `missing source section end: ${end}`);
  return source.slice(from, to);
}

// The planner root hosts two persistent children: the re-rendered shell host
// and the quick-create composer host. Setting innerHTML on a real element
// detaches its children; these fakes reproduce that so layout invariants are
// exercised the same way they run in the browser.
function fakePlannerElement(tag) {
  const element = {
    tagName: tag || 'div',
    className: '',
    style: {},
    dataset: {},
    parentNode: null,
    children: [],
    _innerHTML: '',
    get innerHTML() { return element._innerHTML; },
    set innerHTML(value) {
      element._innerHTML = String(value);
      for (const child of element.children) child.parentNode = null;
      element.children = [];
    },
    appendChild(child) {
      element.children.push(child);
      child.parentNode = element;
      return child;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
  return element;
}

function fakePlannerRoot() {
  const classes = new Set();
  const listeners = new Map();
  const innerHTMLWrites = [];
  const element = fakePlannerElement('div');
  let ownHtml = '';
  Object.defineProperty(element, 'innerHTML', {
    get() {
      return ownHtml + element.children.map(child => child.innerHTML).join('');
    },
    set(value) {
      ownHtml = String(value);
      innerHTMLWrites.push(ownHtml);
      for (const child of element.children) child.parentNode = null;
      element.children = [];
    },
  });
  element.innerHTMLWrites = innerHTMLWrites;
  element.classList = {
    contains(name) { return classes.has(name); },
    toggle(name, force) {
      const enabled = force === undefined ? !classes.has(name) : !!force;
      if (enabled) classes.add(name);
      else classes.delete(name);
      return enabled;
    },
  };
  element.addEventListener = (type, listener) => { listeners.set(type, listener); };
  element.dispatch = (type, event) => {
    const listener = listeners.get(type);
    if (!listener) throw new Error(`missing ${type} listener`);
    return listener(event);
  };
  return element;
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
    createElement(tag) { return fakePlannerElement(tag); },
  };
  const document = typeof options.createDocument === 'function'
    ? options.createDocument(globalRoot) : defaultDocument;
  const context = {
    console: createSandboxConsole(),
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

// Quick-create document: the composer bar markup is a string in the host's
// innerHTML, so the fake host resolves the Fleet picker and mount point from a
// refs registry instead of real DOM parsing.
function createQuickCreateDocument(globalRoot, refs) {
  return {
    activeElement: null,
    body: { appendChild() {} },
    getElementById(id) { return id === 'task-planner-root' ? globalRoot : null; },
    querySelector() { return null; },
    addEventListener() {},
    createElement(tag) {
      const element = fakePlannerElement(tag);
      element.querySelector = selector => {
        if (selector === '[data-control="composer-fleet"]') return refs.picker || null;
        if (selector === '.planner-quick-composer') return refs.composerHost || null;
        return null;
      };
      return element;
    },
  };
}

async function settlePlannerLoad() {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}

test('archive filter is explicit and all task origins expose lifecycle actions', async () => {
  const { context, globalRoot } = createPlannerHarness();
  context.setView('tasks');
  await settlePlannerLoad();
  context.MultiCCTaskPlanner.reconcileSnapshot({ ok: true, revision: 200, modules: [], tasks: [
    { id: 'observed', title: 'Visible historical task', origin: 'session', recordType: 'observed', status: 'done', dirId: 'fleet-a' },
    { id: 'normal', title: 'Visible normal task', origin: 'board', recordType: 'planned', status: 'active', workflowStage: 'inbox', dirId: 'fleet-a' },
    { id: 'archived', title: 'Hidden archived task', origin: 'session', recordType: 'observed', status: 'archived', dirId: 'fleet-a' },
  ] });
  dispatchPlannerAction(globalRoot, 'origin', { origin: 'all' });
  dispatchPlannerAction(globalRoot, 'mode', { mode: 'activity' });
  assert.doesNotMatch(globalRoot.innerHTML, /Hidden archived task/);
  for (const id of ['observed', 'normal']) {
    assert.match(globalRoot.innerHTML, new RegExp(`data-action="task-archive" data-task-id="${id}"`));
    assert.match(globalRoot.innerHTML, new RegExp(`data-action="task-delete" data-task-id="${id}"`));
  }
  dispatchPlannerAction(globalRoot, 'archive-filter', { archived: '1' });
  assert.match(globalRoot.innerHTML, /Hidden archived task/);
  assert.doesNotMatch(globalRoot.innerHTML, /Visible historical task|Visible normal task/);
  assert.match(globalRoot.innerHTML, /data-action="task-restore" data-task-id="archived"/);
  assert.doesNotMatch(globalRoot.innerHTML, /data-action="promote" data-task-id="archived"/);
  dispatchPlannerAction(globalRoot, 'archive-filter', { archived: '0' });
  assert.doesNotMatch(globalRoot.innerHTML, /Hidden archived task/);
});

test('manage shell exposes the first-class Task Center view', () => {
  assert.match(html, /manage-task-planner\.css/);
  assert.match(html, /class="nav-item" data-view="tasks"/);
  assert.match(html, /class="view planner-view" data-view="tasks"/);
  assert.match(html, /allowedViews = \[[^\]]*'tasks'/);
  assert.match(html, /manage-task-planner\.js/);
  assert.match(html, /tasks: \['任务中心', '按模块查看、筛选与派发任务'\]/);
  assert.doesNotMatch(html, /TODO、执行与验收|Unified TODO \/ task center/);
});

test('planner keeps persisted workflow identity separate from derived status projections', () => {
  assert.match(js, /Object\.freeze\(\['inbox', 'ready', 'doing', 'review', 'done'\]\)/);
  assert.match(js, /Object\.freeze\(\['tasks', 'activity'\]\)/);
  assert.match(js, /Object\.freeze\(\['all', 'board', 'session'\]\)/);
  assert.match(js, /Object\.freeze\(\['attention', 'running', 'review', 'error'\]\)/);
  assert.match(js, /task\.recordType === 'planned'/);
  assert.match(js, /task\.recordType !== 'planned'/);
  assert.match(js, /statusUi\.taskStatus/);
  assert.match(js, /function workBucket\(task\)/);
  assert.match(js, /function statusFilterKey\(task\)/);
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
  assert.match(js, /function bindPlannerRoot[\s\S]*?addEventListener\('click', handleRootClick\)[\s\S]*?addEventListener\('keydown', handleRootKeydown\)/);
  assert.doesNotMatch(js, /addEventListener\('(?:dragstart|dragover|drop|dragend)'/);
  assert.match(js, /function unmountFleetSurface\(\)[\s\S]*?closePlannerOverlay\(\)/);
  assert.match(js, /sendIdForTask\(taskId\)/);
  assert.match(js, /state\.sendIds\.delete/);
  assert.match(js, /isConflict\(error\)/);
  assert.match(js, /id="planner-edit-title" name="title" maxlength="40"/);
});

test('planner creates tasks only through the embedded quick-create composer', () => {
  assert.match(js, /window\.MultiCCTaskBoardComposer/);
  assert.match(js, /composerApi\.mount\(/);
  assert.match(js, /requestJson\('\/api\/task-board\/send'/);
  assert.doesNotMatch(js, /requestJson\('\/api\/task-board\/tasks'/,
    'no direct record creation: quick create must use the one-request board composer ingress');
  assert.doesNotMatch(js, /data-action="new-todo"|data-action="start-new-now"|data-action="promote"/);
});

test('planner drawer and overlay retain modal labels and cleanup contracts', () => {
  assert.match(js,
    /<aside class="planner-drawer" role="dialog" aria-modal="true" aria-labelledby="planner-drawer-title">/);
  assert.match(js, /<h2 id="planner-drawer-title">/);
  assert.match(js,
    /function closePlannerOverlay\(expectedOverlay\)[\s\S]*?const cleanup = overlay\.__plannerCleanup[\s\S]*?typeof cleanup === 'function'[\s\S]*?overlay\.remove\(\)/);
  assert.match(js, /function activateOverlay\(overlay, initialSelector\)/);
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

test('the quick-create composer is a persistent sibling destroyed before every root wipe', () => {
  assert.match(js, /quickComposerHost\.className = 'planner-quick-create-host'/);
  assert.match(js, /function destroyQuickComposer\(\)[\s\S]*?quickComposer\.destroy\(\)/);
  const wipes = [...js.matchAll(/root\.innerHTML = ''/g)];
  assert.ok(wipes.length >= 3, 'expected the layout and both surface switches to wipe the root');
  for (const wipe of wipes) {
    const before = js.slice(Math.max(0, wipe.index - 420), wipe.index);
    assert.ok(before.includes('destroyQuickComposer'),
      'every root wipe must first destroy the live composer (draft, attachments, pickers)');
  }
  assert.match(css, /\.planner-quick-create-host\s*\{[\s\S]*?flex: 0 0 auto;/);
  assert.match(js, /const mountedHost = quickComposerHost/);
  assert.match(js, /if \(mountedHost !== quickComposerHost\) return;[\s\S]*?mountedHost\.dataset\.plannerSending/);
  assert.match(js, /const mountedFleetDirId = embedded \? lockedDirId : ''/);
  assert.match(js, /!visible[\s\S]*?quickComposer\.dismissOverlays\(\)/);
});

test('quick create waits for directories, refreshes them, preserves drafts, and uses one atomic send', async () => {
  const mounts = [];
  const contextChanges = [];
  const refs = {
    picker: {
      value: 'fleet-a',
      disabled: false,
      matches(selector) { return selector === '[data-control="composer-fleet"]'; },
    },
    composerHost: {},
  };
  const harness = createPlannerHarness({
    createDocument: globalRoot => createQuickCreateDocument(globalRoot, refs),
    globals: {
      MultiCCTaskBoardComposer: {
        mount(_host, options) {
          const record = { options, destroyed: false, dismissals: 0 };
          mounts.push(record);
          return {
            reset() {},
            focus() {},
            dismissOverlays() { record.dismissals += 1; },
            setContext(...args) { contextChanges.push(args); },
            destroy() { record.destroyed = true; },
          };
        },
      },
    },
  });
  harness.setRequestHandler((url) => (
    url === '/api/task-board/send' ? { ok: true, queued: true, taskId: 'started-now' } : undefined
  ));
  assert.equal(mounts.length, 0, 'the composer must not mount before its directory catalog loads');
  harness.context.setView('tasks');
  await settlePlannerLoad();

  assert.equal(mounts.length, 1, 'the composer mounts once the task list is visible');
  const composerOptions = mounts[0].options;
  assert.equal(composerOptions.contextKey, 'fleet-a');
  harness.requests.length = 0;

  refs.picker.value = '';
  await assert.rejects(
    () => composerOptions.submit({ text: 'Do it', clientMsgId: 'msg-1' }),
    /请选择任务工作区/,
  );
  assert.equal(harness.requests.some(request => request.options?.method === 'POST'), false);

  refs.picker.value = 'fleet-b';
  harness.globalRoot.dispatch('change', { target: refs.picker });
  assert.deepEqual(JSON.parse(JSON.stringify(contextChanges)), [
    ['fleet-b', { preserveDraft: true }],
  ]);

  const composerBar = harness.globalRoot.children[1];
  composerOptions.onSendingChange(true);
  assert.equal(refs.picker.disabled, true);
  assert.equal(composerBar.dataset.plannerSending, 'true');
  composerOptions.onSendingChange(false);
  assert.equal(refs.picker.disabled, false);

  const payload = {
    text: 'Do it now', clientMsgId: 'msg-atomic', cli: 'codex', provider: 'provider-a',
    goal: true, goalLimits: { maxRounds: 12, maxBudget: 5000 },
  };
  const message = await composerOptions.submit(payload);
  assert.equal(message, '新任务已开始');
  const writes = harness.requests.filter(request => request.options?.method === 'POST');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].url, '/api/task-board/send');
  assert.deepEqual(JSON.parse(JSON.stringify(writes[0].options.json)), { ...payload, dirId: 'fleet-b' });

  await settlePlannerLoad();
  assert.equal(mounts.length, 1, 'board refreshes must not remount (and wipe) the live composer');
  assert.equal(mounts[0].destroyed, false);

  refs.picker.value = 'fleet-b';
  harness.setDirectories([
    { id: 'fleet-a', name: 'Fleet A renamed' },
    { id: 'fleet-c', name: 'Fleet C' },
  ]);
  await harness.context.MultiCCTaskPlanner.refresh();
  assert.match(refs.picker.innerHTML, /Fleet A renamed/);
  assert.match(refs.picker.innerHTML, /Fleet C/);
  assert.doesNotMatch(refs.picker.innerHTML, /Fleet B/);
  assert.equal(refs.picker.value, '', 'a removed workspace must not keep routing new tasks');
  assert.equal(mounts.length, 1, 'directory refreshes preserve the mounted composer and its draft');

  dispatchPlannerAction(harness.globalRoot, 'mode', { mode: 'activity' });
  assert.equal(composerBar.style.display, 'none', 'quick create only belongs to the task list');
  assert.equal(mounts[0].dismissals, 1, 'hiding the composer must close any Auto Provider overlay');
  dispatchPlannerAction(harness.globalRoot, 'mode', { mode: 'tasks' });
  assert.equal(composerBar.style.display, '');
  assert.equal(mounts.length, 1);
});

test('Fleet quick create locks routing to its Fleet and remounts cleanly when the Fleet changes', async () => {
  const mounts = [];
  const refs = { picker: { value: 'wrong-fleet', disabled: false }, composerHost: {} };
  const harness = createPlannerHarness({
    createDocument: globalRoot => createQuickCreateDocument(globalRoot, refs),
    globals: {
      MultiCCTaskBoardComposer: {
        mount(_host, options) {
          const record = { options, destroyed: false };
          mounts.push(record);
          return {
            reset() {}, focus() {}, dismissOverlays() {}, setContext() {},
            destroy() { record.destroyed = true; },
          };
        },
      },
    },
  });
  harness.setRequestHandler(url => (
    url === '/api/task-board/send' ? { ok: true, queued: true, taskId: 'fleet-task' } : undefined
  ));
  const fleetRoot = fakePlannerRoot();
  harness.context.MultiCCTaskPlanner.mountFleet(fleetRoot, 'fleet-b');
  await settlePlannerLoad();

  assert.equal(mounts.length, 1);
  assert.equal(mounts[0].options.contextKey, 'fleet-b');
  assert.doesNotMatch(fleetRoot.innerHTML, /planner-quick-create-workspace/);
  assert.match(fleetRoot.innerHTML, /data-mode="tasks"/);
  assert.match(fleetRoot.innerHTML, /data-mode="activity"/);
  assert.doesNotMatch(fleetRoot.innerHTML, /data-mode="(?:todo|board)"/);

  await mounts[0].options.submit({ text: 'Fleet-scoped task', clientMsgId: 'fleet-msg' });
  const write = harness.requests.find(request => request.url === '/api/task-board/send');
  assert.deepEqual(JSON.parse(JSON.stringify(write.options.json)), {
    text: 'Fleet-scoped task', clientMsgId: 'fleet-msg', dirId: 'fleet-b',
  });

  harness.context.MultiCCTaskPlanner.mountFleet(fleetRoot, 'fleet-a');
  assert.equal(mounts[0].destroyed, true);
  assert.equal(mounts.length, 2);
  assert.equal(mounts[1].options.contextKey, 'fleet-a');
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

test('task list groups by module and status filters are multi-select', async () => {
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
      id: 'done-board', title: 'Done remains visible', origin: 'board', recordType: 'planned',
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

  const visibleIds = ['attention-board', 'attention-session', 'done-board', 'next-board',
    'observed-idle', 'observed-succeeded', 'reopened-board', 'review-board', 'running-board',
    'running-session', 'succeeded-board', 'todo-board'].sort();

  // All non-archived tasks land in one module group, regardless of origin or
  // record type; only the archived row stays out.
  assert.deepEqual(articleTaskIds(globalRoot.innerHTML, 'planner-task-row'), visibleIds);
  assert.match(globalRoot.innerHTML, /data-module-id="__unassigned__"/);
  assert.match(globalRoot.innerHTML, /1 个模块 · 12 个任务/);
  assert.doesNotMatch(globalRoot.innerHTML, /Archived outside workspace/);

  // Status chips carry live counts over the unfiltered (but scoped) list.
  assert.match(globalRoot.innerHTML, /data-status-filter="attention"><span>[^<]*<\/span><strong>1<\/strong>/);
  assert.match(globalRoot.innerHTML, /data-status-filter="running"><span>[^<]*<\/span><strong>2<\/strong>/);
  assert.match(globalRoot.innerHTML, /data-status-filter="review"><span>[^<]*<\/span><strong>2<\/strong>/);
  assert.match(globalRoot.innerHTML, /data-status-filter="error"><span>[^<]*<\/span><strong>1<\/strong>/);

  // Origin switching is persisted and re-filters the same list.
  dispatchPlannerAction(globalRoot, 'origin', { origin: 'session' });
  assert.equal(storage.get('multicc_task_center_origin'), 'session');
  assert.deepEqual(articleTaskIds(globalRoot.innerHTML, 'planner-task-row'),
    ['attention-session', 'observed-idle', 'observed-succeeded', 'running-session'].sort());
  dispatchPlannerAction(globalRoot, 'origin', { origin: 'all' });

  // Multi-select: waiting lives under "attention", hard errors under "error".
  dispatchPlannerAction(globalRoot, 'status-filter', { statusFilter: 'attention' });
  assert.deepEqual(articleTaskIds(globalRoot.innerHTML, 'planner-task-row'), ['attention-board']);
  assert.match(globalRoot.innerHTML, /aria-pressed="true" data-action="status-filter" data-status-filter="attention"/);
  dispatchPlannerAction(globalRoot, 'status-filter', { statusFilter: 'error' });
  assert.deepEqual(articleTaskIds(globalRoot.innerHTML, 'planner-task-row'),
    ['attention-board', 'attention-session']);
  dispatchPlannerAction(globalRoot, 'status-filter', { statusFilter: 'attention' });
  assert.deepEqual(articleTaskIds(globalRoot.innerHTML, 'planner-task-row'), ['attention-session']);
  dispatchPlannerAction(globalRoot, 'status-filter', { statusFilter: 'error' });
  assert.deepEqual(articleTaskIds(globalRoot.innerHTML, 'planner-task-row'), visibleIds);

  // The record view keeps completed/idle observed rows for audit.
  dispatchPlannerAction(globalRoot, 'mode', { mode: 'activity' });
  assert.match(globalRoot.innerHTML, /Observed succeeded archive only/);
  assert.match(globalRoot.innerHTML, /Observed idle archive only/);
  assert.doesNotMatch(globalRoot.innerHTML, /Archived outside workspace/);
});

test('activity coalesces missing and stale module identities into one unassigned group', async () => {
  const { context, globalRoot } = createPlannerHarness();
  context.setView('tasks');
  await settlePlannerLoad();
  assert.equal(context.MultiCCTaskPlanner.reconcileSnapshot({
    ok: true,
    revision: 2,
    modules: [{ id: 'module-a', name: 'Module A', dirId: 'fleet-a' }],
    tasks: [
      { id: 'known', title: 'Known module', moduleId: 'module-a', dirId: 'fleet-a', status: 'active' },
      { id: 'missing', title: 'Missing module', dirId: 'fleet-a', status: 'active' },
      { id: 'stale-a', title: 'Stale module A', moduleId: 'removed-a', dirId: 'fleet-a', status: 'active' },
      { id: 'stale-b', title: 'Stale module B', moduleId: 'removed-b', dirId: 'fleet-a', status: 'active' },
    ],
  }), true);

  dispatchPlannerAction(globalRoot, 'mode', { mode: 'activity' });
  assert.equal((globalRoot.innerHTML.match(/class="planner-history-group"/g) || []).length, 2);
  assert.equal((globalRoot.innerHTML.match(/<summary><span>未分模块<\/span>/g) || []).length, 1);
  assert.match(globalRoot.innerHTML, /2 个模块 · 4 条记录/);
});

test('task list reuses shared module sorting, task sorting, related groups, and identity partitioning', async () => {
  const { context, globalRoot } = createPlannerHarness({
    globals: { MultiCCTaskBoardUi: taskBoardUi },
  });
  context.setView('tasks');
  await settlePlannerLoad();
  assert.equal(context.MultiCCTaskPlanner.reconcileSnapshot({
    ok: true,
    revision: 2,
    modules: [
      { id: 'zulu', name: 'Zulu', dirId: 'fleet-a' },
      { id: 'alpha', name: 'Alpha', dirId: 'fleet-a' },
      { id: 'pending', name: '待归类', source: 'classify', dirId: 'fleet-a' },
    ],
    taskGroups: [{ id: 'related', title: 'Related pair', taskIds: ['alpha-old', 'alpha-new'] }],
    tasks: [
      { id: 'zulu-old', title: 'Zulu old', moduleId: 'zulu', dirId: 'fleet-a', status: 'active', runState: 'idle', lastTs: 10 },
      { id: 'zulu-new', title: 'Zulu new', moduleId: 'zulu', dirId: 'fleet-a', status: 'active', runState: 'idle', lastTs: 20 },
      { id: 'alpha-old', title: 'Alpha old', moduleId: 'alpha', dirId: 'fleet-a', status: 'active', runState: 'idle', lastTs: 30 },
      { id: 'alpha-new', title: 'Alpha new', moduleId: 'alpha', dirId: 'fleet-a', status: 'active', runState: 'idle', lastTs: 40 },
      { id: 'legacy', title: 'Legacy identity', moduleId: 'alpha', dirId: 'fleet-a', status: 'active', runState: 'idle', identityState: 'legacy_unresolved', lastTs: 50 },
      { id: 'pending-task', title: 'Pending classify', moduleId: 'pending', dirId: 'fleet-a', status: 'active', runState: 'idle', lastTs: 60 },
      { id: 'orphan', title: 'No module', moduleId: 'removed', dirId: 'fleet-a', status: 'active', runState: 'idle', lastTs: 70 },
    ],
  }), true);

  const markup = globalRoot.innerHTML;
  const modulePositions = ['pending', 'alpha', 'zulu', '__unassigned__']
    .map(id => markup.indexOf(`data-module-id="${id}"`));
  assert.ok(modulePositions.every(position => position >= 0));
  assert.deepEqual([...modulePositions].sort((a, b) => a - b), modulePositions);
  assert.ok(markup.indexOf('data-task-id="zulu-new"') < markup.indexOf('data-task-id="zulu-old"'));
  assert.match(markup, /Related pair/);
  assert.match(markup, /历史身份待确认/);
  for (const id of ['zulu-old', 'zulu-new', 'alpha-old', 'alpha-new', 'legacy', 'pending-task', 'orphan']) {
    const pattern = new RegExp(`<article class="planner-task-row[^>]*data-task-id="${id}"`, 'g');
    assert.equal((markup.match(pattern) || []).length, 1, `${id} must render exactly once`);
  }
});

test('the 60-second task-board poll feeds its snapshot into the planner', async () => {
  const intervals = [];
  const reconciled = [];
  const snapshot = { ok: true, revision: 7, modules: [], tasks: [] };
  const context = {
    console: createSandboxConsole(),
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
  assert.match(js, /function captureRenderState\(\)[\s\S]*?historyTop[\s\S]*?taskTop[\s\S]*?searchFocused/);
  assert.match(js, /function restoreRenderState\(saved\)[\s\S]*?scrollTop = saved\.historyTop[\s\S]*?scrollTop = saved\.taskTop/);
  assert.match(js, /renderState: captureRenderState\(\)/);
  assert.match(js, /planner-task-primary[\s\S]*?data-action="open-chat"/);
  assert.match(js, /kind === 'open-chat'[\s\S]*?window\.open\(`\/chat\.html\?task=/);
  assert.match(js, /handleRootKeydown[\s\S]*?task\.status !== 'archived' && !task\.deleting/);
  assert.match(js, /topbarRefresh\.onclick = \(\) => loadPlanner\(\{ refreshDirectories: true \}\)/);
  assert.match(html, /class="search planner-hide-on-tasks"/);
  assert.match(css, /body\[data-view="tasks"\] #topbar \.planner-hide-on-tasks\s*\{\s*display: none/);
});

test('the task list scrolls in its own region and dynamic regions have bounded announcements', () => {
  assert.match(css, /\.planner-shell-host\s*\{[\s\S]*?min-height: 0;/);
  assert.match(css, /\.planner-task-list\s*\{[\s\S]*?overflow: auto;/);
  assert.match(css, /\.planner-status-filter\s*\{[\s\S]*?overflow-x: auto;/);
  assert.doesNotMatch(html, /id="task-planner-root"[^>]*aria-live/);
  assert.doesNotMatch(dashboardJs, /fleet-task-planner-root[^']*aria-live/);
  assert.match(js, /<aside class="planner-drawer" role="dialog" aria-modal="true"/);
  assert.match(js, /const mainA11y = `role="tabpanel" aria-labelledby="planner-mode-\$\{state\.mode\}"`/);
  assert.match(js, /role="status" aria-live="polite" aria-atomic="true"/);
});

test('planner refresh and responsive access paths are wired', () => {
  assert.match(js, /const epoch = \+\+state\.loadEpoch/);
  assert.match(js, /incomingRevision < state\.revision/);
  assert.match(js, /window\.onTaskBoardUpdate/);
  assert.match(js, /async function refreshTaskSurfaces[\s\S]*?window\.refreshTaskBoard\(true\)[\s\S]*?loadPlanner\(\{ quiet: true \}\)/);
  assert.match(taskBoardJs, /typeof window\.MultiCCTaskPlanner\?\.reconcileSnapshot === 'function'[\s\S]*?window\.MultiCCTaskPlanner\.reconcileSnapshot\(d\)/);
  assert.match(taskBoardJs, /_dirDetailTab === 'tasks'[\s\S]*?refreshDirectoryDetailTaskTab\(_detailDirId\)/);
  assert.match(taskBoardJs, /else if \(typeof renderDirectoryDetailBody === 'function'\) \{\s*renderDirectoryDetailBody\(_detailDirId\);/);
  assert.match(js, /name="workflowStage"/);
  assert.match(css, /@media \(max-width: 760px\)/);
  assert.match(css, /\.planner-toolbar-group\.actions\s*\{[^}]*order: 2;[^}]*width: 100%;[^}]*justify-content: flex-end;/);
  assert.match(css, /\.planner-select\s*\{\s*min-width: 0;/);
  assert.match(css, /\.planner-task-row\s*\{\s*grid-template-columns: 8px minmax\(0, 1fr\);/);
  assert.match(css, /\.planner-quick-create\s*\{\s*padding-inline: 10px;/);
  assert.doesNotMatch(css, /\.planner-todo-|\.planner-board|\.planner-column|\.planner-card[\s,{.]|\.planner-work-bucket|\.planner-start-|\.planner-dialog/);
  assert.doesNotMatch(css, /\.planner-overlay\.centered|\.planner-badge\.(?:priority|due-|module)/);
  assert.doesNotMatch(js, /function duePresentation\(/);
});

test('planner copy is present in both generated source catalogs', () => {
  const required = [
    'plannerTaskCenter', 'plannerTasks', 'plannerHistory',
    'plannerSource', 'plannerSourceAll', 'plannerSourceBoard', 'plannerSourceSession',
    'plannerStatusFilter', 'plannerFilterAttention', 'plannerFilterRunning',
    'plannerFilterReview', 'plannerFilterError',
    'plannerQuickCreate', 'plannerQuickCreateHint', 'plannerQuickCreatePlaceholder',
    'plannerQuickCreateWorkspace',
    'plannerTaskSummary', 'plannerTaskEmptyTitle', 'plannerTaskEmptyBody',
    'plannerRelatedTasks', 'plannerLegacyTasks', 'plannerAcceptance',
    'plannerAnswerQuestion', 'plannerInspectError', 'plannerStartQuick', 'plannerCompleteQuick',
  ];
  for (const key of required) {
    assert.equal(typeof zh[key], 'string', `missing zh.${key}`);
    assert.equal(typeof en[key], 'string', `missing en.${key}`);
    assert.ok(zh[key].length > 0 && en[key].length > 0, `empty planner copy: ${key}`);
  }
  // The two source catalogs must carry identical planner key sets.
  const zhPlanner = Object.keys(zh).filter(key => key.startsWith('planner')).sort();
  const enPlanner = Object.keys(en).filter(key => key.startsWith('planner')).sort();
  assert.deepEqual(zhPlanner, enPlanner);
  // Retired TODO/board copy stays out of the catalogs.
  for (const dead of ['plannerTodoList', 'plannerBoard', 'plannerNewTodo', 'plannerStartNewNow',
    'plannerWorkOverview', 'plannerBucketTodo', 'plannerAddTodo', 'plannerPromoted']) {
    assert.equal(zh[dead], undefined, `retired copy still in zh: ${dead}`);
    assert.equal(en[dead], undefined, `retired copy still in en: ${dead}`);
  }
  assert.equal(zh.plannerTasks, '任务');
  assert.equal(en.plannerTasks, 'Tasks');
  assert.equal(zh.plannerFilterAttention, '需要我');
  assert.equal(en.plannerFilterAttention, 'Needs me');
  assert.equal(zh.plannerQuickCreate, '快速新建任务');
  assert.equal(en.plannerQuickCreate, 'Quick task');
});
