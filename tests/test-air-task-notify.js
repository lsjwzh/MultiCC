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

// ── Sound policy (see public/shared/user-presence.js for the table) ──────────
function soundHarness({ away = false, store } = {}) {
  const { win, api } = loadModule();
  if (store) win.localStorage = store;
  const timers = new Map();
  let nextId = 1;
  let clock = 100000;
  const dings = [];
  const spoken = [];
  win.AudioContext = function FakeAudio() {
    return {
      currentTime: 0, destination: {},
      createOscillator: () => ({ frequency: {}, connect: x => x, start() {}, stop() {} }),
      createGain: () => ({ gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: x => x }),
      close() {},
    };
  };
  const origCtor = win.AudioContext;
  win.AudioContext = function Counted() { dings.push(clock); return origCtor(); };
  win.SpeechSynthesisUtterance = function Utterance(text) { this.text = text; };
  win.speechSynthesis = { speak: u => spoken.push(u.text), cancel() {} };
  const presence = { away, isAway() { return this.away; }, onReturn() { return () => {}; } };
  const setT = (fn, delay) => { const id = nextId++; timers.set(id, { fn, at: clock + delay }); return id; };
  const clearT = id => timers.delete(id);
  const advance = ms => {
    clock += ms;
    for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
      if (t.at <= clock && timers.has(id)) { timers.delete(id); t.fn(); }
    }
  };
  const ctrl = api.create({
    getCurrentTaskId: () => null, openTask: () => {},
    window: win, document: win.document,
    setTimeout: setT, clearTimeout: clearT, now: () => clock, presence,
  });
  return { ctrl, dings, spoken, presence, advance, win };
}

test('present: a completion dings but is not narrated', () => {
  const h = soundHarness({ away: false });
  h.ctrl.onSnapshot([{ id: 'a', status: 'running' }], '');
  h.ctrl.onSnapshot([{ id: 'a', status: 'done', title: 'Alpha' }], '');
  h.advance(1000);
  assert.equal(h.dings.length, 1);
  assert.deepEqual(h.spoken, []);
});

test('away: ding + one sentence; several completions in one poll are one announcement', () => {
  const h = soundHarness({ away: true });
  h.ctrl.onSnapshot([{ id: 'a', status: 'running' }, { id: 'b', status: 'running' }, { id: 'c', status: 'running' }], '');
  h.ctrl.onSnapshot([
    { id: 'a', status: 'done', title: 'Alpha' },
    { id: 'b', status: 'error', title: 'Beta' },
    { id: 'c', status: 'done', title: 'Gamma' },
  ], '');
  h.advance(1000);
  assert.equal(h.dings.length, 1, 'one ding for the batch');
  assert.deepEqual(h.spoken, ['任务「Beta」出错了，另有 2 个任务有新结果'], 'errors lead the sentence');
});

test('a completion inside the cooldown is deferred and merged, never swallowed', () => {
  const h = soundHarness({ away: true });
  h.ctrl.onSnapshot([{ id: 'a', status: 'running' }, { id: 'b', status: 'running' }], '');
  h.ctrl.onSnapshot([{ id: 'a', status: 'done', title: 'Alpha' }, { id: 'b', status: 'running' }], '');
  h.advance(4000);
  h.ctrl.onSnapshot([{ id: 'a', status: 'done', title: 'Alpha' }, { id: 'b', status: 'done', title: 'Beta' }], '');
  assert.equal(h.dings.length, 1, 'still inside the cooldown');
  h.advance(5000);
  assert.equal(h.dings.length, 2, 'the deferred one rings after the cooldown');
  h.advance(1000);
  assert.deepEqual(h.spoken, ['任务「Alpha」已完成', '任务「Beta」已完成']);
});

test('opening a task before its deferred sound plays drops it', () => {
  const h = soundHarness({ away: true });
  h.ctrl.onSnapshot([{ id: 'a', status: 'running' }, { id: 'b', status: 'running' }], '');
  h.ctrl.onSnapshot([{ id: 'a', status: 'done' }, { id: 'b', status: 'running' }], '');
  h.ctrl.onSnapshot([{ id: 'a', status: 'done' }, { id: 'b', status: 'done' }], '');
  h.ctrl.markOpened('b');
  h.advance(10000);
  assert.equal(h.dings.length, 1);
});

test('away is read when the sound plays: coming back during the cooldown means ding only', () => {
  const h = soundHarness({ away: true });
  h.ctrl.onSnapshot([{ id: 'a', status: 'running' }, { id: 'b', status: 'running' }], '');
  h.ctrl.onSnapshot([{ id: 'a', status: 'done' }, { id: 'b', status: 'running' }], '');
  h.ctrl.onSnapshot([{ id: 'a', status: 'done' }, { id: 'b', status: 'done', title: 'Beta' }], '');
  h.presence.away = false;
  h.advance(10000);
  assert.equal(h.dings.length, 2);
  assert.equal(h.spoken.length, 1, 'only the first (away) one was narrated');
});

test('two Air tabs: only the first to see a transition makes a sound', () => {
  const shared = new Map();
  const store = {
    getItem: k => (shared.has(k) ? shared.get(k) : null),
    setItem: (k, v) => shared.set(k, String(v)),
    removeItem: k => shared.delete(k),
  };
  const one = soundHarness({ away: true, store });
  const two = soundHarness({ away: true, store });
  for (const h of [one, two]) h.ctrl.onSnapshot([{ id: 'a', status: 'running', updatedAt: 1 }], '');
  for (const h of [one, two]) h.ctrl.onSnapshot([{ id: 'a', status: 'done', updatedAt: 2 }], '');
  assert.equal(one.dings.length + two.dings.length, 1);
  assert.equal(two.ctrl.isUnseen('a'), true, 'the quiet tab still marks it');
});

test('waiting is an attention kind; answered elsewhere clears the mark', () => {
  const h = soundHarness({ away: false });
  h.ctrl.onSnapshot([{ id: 'q', status: 'running' }], '');
  assert.equal(h.ctrl.onSnapshot([{ id: 'q', status: 'waiting' }], ''), true);
  assert.equal(h.ctrl.unseenKind('q'), 'waiting');
  h.ctrl.onSnapshot([{ id: 'q', status: 'running' }], '');
  assert.equal(h.ctrl.isUnseen('q'), false);
  // waiting → done is a new outcome, not a repeat
  h.ctrl.onSnapshot([{ id: 'q', status: 'waiting' }], '');
  assert.equal(h.ctrl.onSnapshot([{ id: 'q', status: 'done' }], ''), true);
  assert.equal(h.ctrl.unseenKind('q'), 'completed');
});

// ── shared/user-presence.js ────────────────────────────────────────────────
const Presence = require('../public/shared/user-presence.js');

function presenceHarness(store) {
  const shared = store || new Map();
  let clock = 1000000;
  const listeners = new Map();
  const target = () => ({
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type) { listeners.delete(type); },
  });
  const doc = Object.assign(target(), { visibilityState: 'visible' });
  const win = target();
  const storage = {
    getItem: k => (shared.has(k) ? shared.get(k) : null),
    setItem: (k, v) => shared.set(k, String(v)),
  };
  const docListeners = new Map();
  doc.addEventListener = (type, fn) => docListeners.set(type, fn);
  const p = Presence.create({ window: win, document: doc, storage, now: () => clock });
  return {
    p, doc, shared, listeners, docListeners,
    tick: ms => { clock += ms; },
  };
}

test('presence: present until 5 min without input, hidden is always away', () => {
  const h = presenceHarness();
  assert.equal(h.p.state(), 'present');
  h.tick(Presence.IDLE_MS - 1);
  assert.equal(h.p.isAway(), false);
  h.tick(1);
  assert.equal(h.p.state(), 'idle');
  h.listeners.get('keydown')({ type: 'keydown' });
  assert.equal(h.p.state(), 'present');
  h.doc.visibilityState = 'hidden';
  assert.equal(h.p.state(), 'hidden');
});

test('presence: input in another frame/tab (shared storage) keeps this page present', () => {
  const store = new Map();
  const shell = presenceHarness(store);
  const frame = presenceHarness(store);
  shell.tick(Presence.IDLE_MS + 10);
  frame.tick(Presence.IDLE_MS + 10);
  assert.equal(shell.p.state(), 'idle');
  frame.listeners.get('pointerdown')({ type: 'pointerdown' });
  assert.equal(shell.p.state(), 'present', 'the Air shell sees the chat frame activity');
});

test('presence: onReturn fires on activity after idle and on becoming visible', () => {
  const h = presenceHarness();
  const reasons = [];
  h.p.onReturn(r => reasons.push(r));
  h.listeners.get('keydown')({ type: 'keydown' });
  assert.deepEqual(reasons, [], 'activity while present is not a return');
  h.tick(Presence.IDLE_MS + 1);
  h.listeners.get('keydown')({ type: 'keydown' });
  h.doc.visibilityState = 'hidden';
  h.docListeners.get('visibilitychange')();
  h.doc.visibilityState = 'visible';
  h.docListeners.get('visibilitychange')();
  assert.deepEqual(reasons, ['active', 'visible']);
});
