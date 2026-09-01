'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/manage.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'public/manage-task-planner.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/manage-task-planner.css'), 'utf8');
const zh = JSON.parse(fs.readFileSync(path.join(root, 'app/assets/i18n/zh.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(root, 'app/assets/i18n/en.json'), 'utf8'));

function fakePlannerRoot() {
  const classes = new Set();
  const listeners = new Map();
  return {
    innerHTML: '',
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
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
}

function createPlannerHarness() {
  const globalRoot = fakePlannerRoot();
  const requests = [];
  const snapshot = {
    ok: true,
    revision: 1,
    modules: [],
    tasks: [
      {
        id: 'task-a', recordType: 'planned', status: 'active', runState: 'idle',
        dirId: 'fleet-a', workflowStage: 'inbox', planningRevision: 1, rank: 1024,
        title: 'Alpha plan', description: 'Only Fleet A should show this task',
      },
      {
        id: 'task-b', recordType: 'planned', status: 'active', runState: 'idle',
        dirId: 'fleet-b', workflowStage: 'ready', planningRevision: 1, rank: 1024,
        title: 'Beta plan', description: 'Only Fleet B should show this task',
      },
    ],
  };
  const directories = [
    { id: 'fleet-a', name: 'Fleet A' },
    { id: 'fleet-b', name: 'Fleet B' },
  ];
  const document = {
    activeElement: null,
    body: { appendChild() {} },
    getElementById(id) { return id === 'task-planner-root' ? globalRoot : null; },
    querySelector() { return null; },
    addEventListener() {},
    createElement() { throw new Error('planner overlay was not expected in this test'); },
  };
  const context = {
    console,
    document,
    location: { search: '' },
    localStorage: { getItem() { return 'zh'; } },
    URLSearchParams,
    setTimeout,
    clearTimeout,
    MultiCCApi: {
      async json(url, options) {
        requests.push({ url, options });
        if (url === '/api/task-board') return snapshot;
        if (url === '/api/directories') return directories;
        throw new Error(`unexpected request: ${url}`);
      },
    },
    setView() {},
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(js, context, { filename: 'manage-task-planner.js' });
  return { context, globalRoot, requests };
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

test('planner keeps workflow, runtime, and history identity independent', () => {
  assert.match(js, /Object\.freeze\(\['inbox', 'ready', 'doing', 'review', 'done'\]\)/);
  assert.match(js, /task\.recordType === 'planned'/);
  assert.match(js, /task\.recordType !== 'planned'/);
  assert.match(js, /statusUi\.taskStatus/);
  assert.match(js, /sourceTaskId: task\.id/);
});

test('planner mutations use task revisions and idempotent sends', () => {
  assert.match(js, /Math\.max\(1, Number\(task && task\.planningRevision\)/);
  assert.match(js, /const openRevision = Math\.max\(1, Number\(task\.planningRevision\)/);
  assert.match(js, /handleDrawerAction\(task\.id, action\.dataset\.drawerAction, action, openRevision\)/);
  assert.match(js, /expectedRevisionBody\(task, \{[\s\S]*?workflowStage: targetStage,[\s\S]*?\}, openRevision\)/);
  assert.match(js, /\/api\/task-board\/tasks\/\$\{encodeURIComponent\(taskId\)\}\/move/);
  assert.match(js, /\/api\/task-board\/tasks\/\$\{encodeURIComponent\(taskId\)\}\/update/);
  assert.match(js, /async function createFromDialog[\s\S]*?requestJson\('\/api\/task-board\/tasks'/);
  assert.match(js, /function bindPlannerRoot[\s\S]*?addEventListener\('click', handleRootClick\)[\s\S]*?addEventListener\('drop', handleDrop\)/);
  assert.match(js, /function unmountFleetSurface\(\)[\s\S]*?closePlannerOverlay\(\)/);
  assert.match(js, /sendIdForTask\(taskId\)/);
  assert.match(js, /state\.sendIds\.delete/);
  assert.match(js, /isConflict\(error\)/);
  assert.match(js, /id="planner-edit-title" name="title" maxlength="40"/);
});

test('Fleet planner mount is isolated and unmount or global navigation restores every Fleet', async () => {
  const { context, globalRoot, requests } = createPlannerHarness();
  const fleetRoot = fakePlannerRoot();

  context.MultiCCTaskPlanner.mountFleet(fleetRoot, 'fleet-a');
  await settlePlannerLoad();

  assert.match(fleetRoot.innerHTML, /planner-fleet-lock/);
  assert.match(fleetRoot.innerHTML, /Fleet A/);
  assert.match(fleetRoot.innerHTML, /Alpha plan/);
  assert.doesNotMatch(fleetRoot.innerHTML, /Beta plan|id="planner-fleet-filter"/);
  assert.deepEqual(requests.map(request => request.url), ['/api/task-board', '/api/directories']);

  context.MultiCCTaskPlanner.unmountFleet();
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

test('planner refresh and responsive access paths are wired', () => {
  assert.match(js, /const epoch = \+\+state\.loadEpoch/);
  assert.match(js, /incomingRevision < state\.revision/);
  assert.match(js, /window\.onTaskBoardUpdate/);
  assert.match(js, /name="workflowStage"/);
  assert.match(css, /@media \(max-width: 760px\)/);
  assert.match(css, /\.planner-column\.is-mobile-active/);
});

test('planner copy is present in both generated source catalogs', () => {
  const required = [
    'plannerTaskCenter', 'plannerBoard', 'plannerHistory', 'plannerNeedsMe',
    'plannerNewTask', 'plannerSaveInbox', 'plannerSaveStart', 'plannerAcceptance',
  ];
  for (const key of required) {
    assert.equal(typeof zh[key], 'string', `missing zh.${key}`);
    assert.equal(typeof en[key], 'string', `missing en.${key}`);
    assert.ok(zh[key].length > 0 && en[key].length > 0, `empty planner copy: ${key}`);
  }
});
