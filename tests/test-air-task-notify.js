'use strict';
// Unit tests for the Air page task-completion notifier (public/air-task-notify.js).
//
// Runs the browser IIFE inside a fake window so the persistence + transition
// rules are tested deterministically without a browser:
//   - a task only fires a reminder when its completion transition is *observed*
//     (so pre-existing "done" tasks don't spam the page on first load);
//   - completion while the page is closed is detected on the next snapshot
//     because the last-observed status watermark is persisted;
//   - opening a task clears the "unseen" mark and persists that;
//   - error/cancelled are deliberately NOT "completed" reminders.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MODULE = fs.readFileSync(path.join(__dirname, '..', 'public', 'air-task-notify.js'), 'utf8');

function loadModule() {
  const store = new Map();
  const win = {
    localStorage: {
      getItem: key => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: key => store.delete(key),
    },
    navigator: { language: 'zh-CN' },
    setTimeout: () => 1,
    clearTimeout: () => {},
    // No audio / TTS in the fake browser — voice is a no-op but must not throw.
    AudioContext: null,
    webkitAudioContext: null,
    speechSynthesis: null,
    document: {
      get visibilityState() { return 'visible'; },
      createElement: () => ({
        className: '', textContent: '', hidden: false,
        classList: { add() {}, remove() {}, toggle() {} },
        setAttribute() {}, append() {}, appendChild() {},
      }),
      body: { appendChild() {} },
    },
    _cur: null,
  };
  // Evaluate the IIFE in the fake window scope.
  new Function('window', 'document', MODULE)(win, win.document);
  return { win, api: win.MultiCCTaskNotify };
}

const createController = (win, api) => api.create({
  getCurrentTaskId: () => win._cur || null,
  openTask: () => {},
  window: win, document: win.document,
  setTimeout: win.setTimeout, clearTimeout: win.clearTimeout,
});

test('baseline: tasks already "done" before the page ever saw them do not fire', () => {
  const { win, api } = loadModule();
  const ctrl = createController(win, api);
  const fired = ctrl.onSnapshot([
    { id: 't1', status: 'done' },
    { id: 't2', status: 'done' },
    { id: 't3', status: 'running' },
  ], '');
  assert.equal(fired, false);
  assert.equal(ctrl.unseenCount(), 0);
  assert.equal(ctrl.isUnseen('t1'), false);
});

test('a recently rerun old task retains its watermark beyond the 200-task cap', () => {
  const { win, api } = loadModule();
  const ctrl = createController(win, api);
  const active = { id: 'old-stock-task', status: 'running', updatedAt: 1000 };
  const tasks = [active, ...Array.from({ length: 240 }, (_, i) => ({ id: 'dormant-' + i, status: 'done', updatedAt: i }))];
  ctrl.onSnapshot(tasks, '');
  ctrl.onSnapshot(tasks, '');
  // Reload between snapshots, so the bound applies to persistence as well.
  const restored = createController(win, api);
  active.status = 'succeeded'; active.updatedAt = 1100;
  assert.equal(restored.onSnapshot(tasks, ''), true);
  assert.equal(restored.isUnseen(active.id), true);
  assert.equal(Object.keys(JSON.parse(win.localStorage.getItem('air:notify-prev'))).length, 200);
  assert.equal(restored.onSnapshot(tasks, ''), false);
});

test('observed running->succeeded transition for an unopened task fires and marks it unseen', () => {
  const { win, api } = loadModule();
  const ctrl = createController(win, api);
  ctrl.onSnapshot([{ id: 't4', status: 'running' }], '');
  const fired = ctrl.onSnapshot([{ id: 't4', status: 'succeeded' }], '');
  assert.equal(fired, true);
  assert.equal(ctrl.isUnseen('t4'), true);
  // Already-done tasks never re-fire on later snapshots.
  assert.equal(ctrl.onSnapshot([{ id: 't4', status: 'succeeded' }], ''), false);
});

test('a task that is currently open is never marked unseen', () => {
  const { win, api } = loadModule();
  const ctrl = createController(win, api);
  win._cur = 't5';
  ctrl.onSnapshot([{ id: 't5', status: 'running' }], 't5');
  const fired = ctrl.onSnapshot([{ id: 't5', status: 'done' }], 't5');
  assert.equal(fired, false);
  assert.equal(ctrl.isUnseen('t5'), false);
});

test('completion detected after a reload (page was closed during the run): watermark persisted', () => {
  const { win, api } = loadModule();
  const first = createController(win, api);
  first.onSnapshot([{ id: 't7', status: 'running' }], ''); // seen as running earlier
  // Simulate reload with a fresh controller: task flipped to done meanwhile.
  const second = createController(win, api);
  const fired = second.onSnapshot([{ id: 't7', status: 'done' }], '');
  assert.equal(fired, true);
  assert.equal(second.isUnseen('t7'), true);
});

test('onSnapshot persists "unseen" across controller instances and markOpened clears + persists it', () => {
  const { win, api } = loadModule();
  const first = createController(win, api);
  first.onSnapshot([{ id: 't6', status: 'running' }], '');
  first.onSnapshot([{ id: 't6', status: 'done' }], '');
  const reload = createController(win, api);
  assert.equal(reload.isUnseen('t6'), true, 'unseen survives reload');
  reload.markOpened('t6');
  assert.equal(reload.isUnseen('t6'), false, 'opening clears the mark');
  const reloadAgain = createController(win, api);
  assert.equal(reloadAgain.isUnseen('t6'), false, 'opened state also survives reload');
});

test('error fires an unseen mark of kind error; cancelled still does not', () => {
  const { win, api } = loadModule();
  const ctrl = createController(win, api);
  ctrl.onSnapshot([{ id: 't8', status: 'running' }], '');
  assert.equal(ctrl.onSnapshot([{ id: 't8', status: 'error' }, { id: 't9', status: 'queued' }], ''), true);
  assert.equal(ctrl.isUnseen('t8'), true);
  assert.equal(ctrl.unseenKind('t8'), 'error');
  ctrl.onSnapshot([{ id: 't10', status: 'running' }], '');
  assert.equal(ctrl.onSnapshot([{ id: 't10', status: 'cancelled' }], ''), false);
  assert.equal(ctrl.isUnseen('t10'), false);
});

test('error unseen mark survives reload (kind persisted) and markOpened clears it', () => {
  const { win, api } = loadModule();
  const first = createController(win, api);
  first.onSnapshot([{ id: 't11', status: 'running' }], '');
  first.onSnapshot([{ id: 't11', status: 'error' }], '');
  const reload = createController(win, api);
  assert.equal(reload.unseenKind('t11'), 'error', 'error kind survives reload');
  reload.markOpened('t11');
  assert.equal(reload.isUnseen('t11'), false);
});

test('statusOf fold decides attention, so lifecycle done + runState error reads as error', () => {
  const { win, api } = loadModule();
  const ctrl = api.create({
    getCurrentTaskId: () => null,
    openTask: () => {},
    window: win, document: win.document,
    setTimeout: win.setTimeout, clearTimeout: win.clearTimeout,
    statusOf: task => (task.status === 'done' && task.runState === 'error' ? 'error' : task.status),
  });
  ctrl.onSnapshot([{ id: 't12', status: 'active', runState: 'running' }], '');
  assert.equal(ctrl.onSnapshot([{ id: 't12', status: 'done', runState: 'error' }], ''), true);
  assert.equal(ctrl.unseenKind('t12'), 'error');
});
