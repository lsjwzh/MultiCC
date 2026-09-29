'use strict';
// Unit tests for the Air page task-completion notifier (public/air-task-notify.js).
//
// Runs the browser IIFE inside a fake window. Whether a task is unseen is the
// server's call (task.attention in the /api/air snapshot, see
// src/task-board/attention.js); what is tested here is how the page reads it:
//   - the row mark follows the snapshot, so opening a task anywhere clears it;
//   - the deck (③) mirrors those marks as well: one card per task that still
//     needs you, however long ago it was rung, so a reload or a second tab does
//     not empty the corner while the row is still marked (the real drawing is
//     covered by tests/test-air-notify-deck.js and test-air-notify-deck-cdp.js);
//   - only marks newer than what was already rung make a sound, so a reload, a
//     second tab or a tab that slept in the background stays quiet;
//   - the very first snapshot a browser ever sees rings nothing — it only sets
//     the ringing watermark; the marks it carries are still shown.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MODULE = fs.readFileSync(path.join(__dirname, '..', 'public', 'air-task-notify.js'), 'utf8');

// `navigatorLanguage` matters only where the module guesses a language for a
// page that has never been toggled; the default matches the machine these run on.
function loadModule({ navigatorLanguage = 'zh-CN' } = {}) {
  const store = new Map();
  const win = {
    localStorage: {
      getItem: key => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: key => store.delete(key),
    },
    navigator: { language: navigatorLanguage },
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

// Stands in for air-notify-deck.js (not loaded in this fake window) so a test
// can see WHAT lands on the deck without a real DOM. Opt-in: pass it and the
// controller draws its cards here instead of finding no deck module.
function deckStub() {
  const kinds = new Map();
  const cards = {
    ids: () => [...kinds.keys()],
    has: id => kinds.has(String(id)),
    size: () => kinds.size,
    upsert: (task, kind) => { kinds.set(String(task.id), kind); },
    remove: id => { kinds.delete(String(id)); },
    clear: () => kinds.clear(),
    isOpen: () => false,
    setOpen: () => {},
  };
  return { factory: { create: () => cards }, ids: () => [...kinds.keys()], kind: id => kinds.get(String(id)) || null };
}

const createController = (win, api, stub) => api.create({
  getCurrentTaskId: () => win._cur || null,
  openTask: () => {},
  window: win, document: win.document,
  setTimeout: win.setTimeout, clearTimeout: win.clearTimeout,
  ...(stub ? { deck: stub.factory } : {}),
});

const KIND = { done: 'completed', succeeded: 'completed', error: 'error', waiting: 'waiting' };
// A task as the snapshot carries it; `at` present → the server has a pending mark.
const T = (id, status, at, extra = {}) => ({
  id, status, ...(at ? { attention: { kind: KIND[status], at } } : {}), ...extra,
});

// The controller hands its translate() to the deck factory, and the deck
// (public/air-notify-deck.js) is what actually draws "Task complete" / "Open".
// Capturing that option is how a test reads the resolved wording with no DOM.
function captureTranslate(win, api) {
  const seen = { translate: null };
  const cards = {
    ids: () => [], has: () => false, size: () => 0,
    upsert() {}, remove() {}, clear() {}, isOpen: () => false, setOpen() {},
  };
  const ctrl = api.create({
    getCurrentTaskId: () => null,
    openTask: () => {},
    window: win, document: win.document,
    setTimeout: win.setTimeout, clearTimeout: win.clearTimeout,
    deck: { create: opts => { seen.translate = opts.translate; return cards; } },
  });
  // The deck is built lazily, on the first mark that has to be shown.
  ctrl.onSnapshot([T('t1', 'done', 50)], '');
  return seen;
}

test('a stored English choice survives a Chinese browser locale', () => {
  // The browser itself is zh-CN and the user switched this page to English.
  // Re-deriving the language from navigator.language made the completion toast
  // Chinese on exactly that machine.
  const { win, api } = loadModule({ navigatorLanguage: 'zh-CN' });
  win.localStorage.setItem('multicc_lang', 'en');
  const { translate } = captureTranslate(win, api);
  assert.equal(typeof translate, 'function', 'the deck factory receives translate()');
  assert.equal(translate('floatTitle'), 'Task complete');
  assert.equal(translate('floatOpen'), 'Open');
});

test('a stored Chinese choice survives an English browser locale', () => {
  const { win, api } = loadModule({ navigatorLanguage: 'en-US' });
  win.localStorage.setItem('multicc_lang', 'zh');
  const { translate } = captureTranslate(win, api);
  assert.equal(translate('floatTitle'), '任务已完成');
  assert.equal(translate('floatOpen'), '打开');
});

test('with nothing stored the browser locale decides', () => {
  const zh = loadModule({ navigatorLanguage: 'zh-CN' });
  assert.equal(captureTranslate(zh.win, zh.api).translate('floatTitle'), '任务已完成');
  const en = loadModule({ navigatorLanguage: 'en-US' });
  assert.equal(captureTranslate(en.win, en.api).translate('floatTitle'), 'Task complete');
});

test('first snapshot a browser ever sees is a baseline: marks show, nothing rings', () => {
  const { win, api } = loadModule();
  const deck = deckStub();
  const ctrl = createController(win, api, deck);
  const fired = ctrl.onSnapshot([T('t1', 'done', 50), T('t2', 'done'), T('t3', 'running')], '');
  assert.equal(fired, false, 'the baseline rings nothing');
  assert.equal(ctrl.isUnseen('t1'), true, 'the server says t1 was never opened');
  assert.equal(ctrl.isUnseen('t2'), false);
  assert.equal(ctrl.unseenCount(), 1);
  // The mark is shown though — the card is what the row says, not a sound.
  assert.deepEqual(ctrl.deckIds(), ['t1']);
  assert.equal(deck.kind('t1'), 'completed');
});

test('a new server mark fires once and marks the row unseen', () => {
  const { win, api } = loadModule();
  const ctrl = createController(win, api);
  ctrl.onSnapshot([T('t4', 'running')], '');
  assert.equal(ctrl.onSnapshot([T('t4', 'succeeded', 100)], ''), true);
  assert.equal(ctrl.isUnseen('t4'), true);
  assert.equal(ctrl.unseenKind('t4'), 'completed');
  assert.equal(ctrl.onSnapshot([T('t4', 'succeeded', 100)], ''), false, 'same mark never re-fires');
});

test('the task on screen is never unseen and never fires', () => {
  const { win, api } = loadModule();
  const ctrl = createController(win, api);
  ctrl.onSnapshot([T('t5', 'running')], 't5');
  assert.equal(ctrl.onSnapshot([T('t5', 'done', 100)], 't5'), false);
  assert.equal(ctrl.isUnseen('t5'), false);
});

test('reload: marks come back from the snapshot, but what was rung is not rung again', () => {
  const { win, api } = loadModule();
  const first = createController(win, api, deckStub());
  first.onSnapshot([T('t6', 'running')], '');
  assert.equal(first.onSnapshot([T('t6', 'done', 100)], ''), true);
  const reloadDeck = deckStub();
  const reload = createController(win, api, reloadDeck);
  assert.equal(reload.onSnapshot([T('t6', 'done', 100)], ''), false, 'a mark already rung is quiet');
  assert.equal(reload.isUnseen('t6'), true, 'still unseen after reload');
  // …and still shown: the row is marked, so the corner cannot be empty.
  assert.deepEqual(reloadDeck.ids(), ['t6']);
  // finished while the page was closed → a newer mark → announced on reload
  const again = createController(win, api, deckStub());
  assert.equal(again.onSnapshot([T('t6', 'done', 100), T('t7', 'done', 200)], ''), true);
  assert.deepEqual(again.deckIds(), ['t6', 't7']);
});

test('markOpened clears locally until the server catches up, then follows the server', () => {
  const { win, api } = loadModule();
  const ctrl = createController(win, api);
  ctrl.onSnapshot([], '');
  ctrl.onSnapshot([T('t8', 'error', 100)], '');
  assert.equal(ctrl.unseenKind('t8'), 'error');
  ctrl.markOpened('t8');
  assert.equal(ctrl.isUnseen('t8'), false);
  ctrl.onSnapshot([T('t8', 'error', 100)], '');     // /open not applied yet
  assert.equal(ctrl.isUnseen('t8'), false, 'an in-flight open is not undone');
  ctrl.onSnapshot([T('t8', 'error')], '');          // server cleared it
  assert.equal(ctrl.onSnapshot([T('t8', 'error', 300)], ''), true, 'a later outcome is new again');
  assert.equal(ctrl.isUnseen('t8'), true);
});

test('opened elsewhere (another tab, the App): the mark leaves the row', () => {
  const { win, api } = loadModule();
  const ctrl = createController(win, api);
  ctrl.onSnapshot([], '');
  ctrl.onSnapshot([T('t9', 'done', 100)], '');
  ctrl.onSnapshot([T('t9', 'done')], '');
  assert.equal(ctrl.isUnseen('t9'), false);
});

test('marks of an unknown kind are ignored', () => {
  const { win, api } = loadModule();
  const ctrl = api.create({
    getCurrentTaskId: () => null, openTask: () => {},
    window: win, document: win.document,
    setTimeout: win.setTimeout, clearTimeout: win.clearTimeout,
    statusOf: task => (task.runState === 'running' ? 'running' : task.status),
  });
  ctrl.onSnapshot([], '');
  ctrl.onSnapshot([{ id: 'x', status: 'done', attention: { kind: 'bogus', at: 100 } }, T('y', 'done', 100)], '');
  assert.equal(ctrl.isUnseen('x'), false);
  assert.equal(ctrl.isUnseen('y'), true);
});

test('legacy per-page copies are dropped on start', () => {
  const { win, api } = loadModule();
  win.localStorage.setItem('air:notify-unseen', '{"old":"completed"}');
  win.localStorage.setItem('air:notify-prev', '{"old":"done"}');
  createController(win, api);
  assert.equal(win.localStorage.getItem('air:notify-unseen'), null);
  assert.equal(win.localStorage.getItem('air:notify-prev'), null);
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
  h.ctrl.onSnapshot([T('a', 'running')], '');
  h.ctrl.onSnapshot([T('a', 'done', 100, { title: 'Alpha' })], '');
  h.advance(1000);
  assert.equal(h.dings.length, 1);
  assert.deepEqual(h.spoken, []);
});

test('away: ding + one sentence; several outcomes in one poll are one announcement', () => {
  const h = soundHarness({ away: true });
  h.ctrl.onSnapshot([], '');
  h.ctrl.onSnapshot([
    T('a', 'done', 100, { title: 'Alpha' }),
    T('b', 'error', 101, { title: 'Beta' }),
    T('c', 'done', 102, { title: 'Gamma' }),
  ], '');
  h.advance(1000);
  assert.equal(h.dings.length, 1, 'one ding for the batch');
  assert.deepEqual(h.spoken, ['任务「Beta」出错了，另有 2 个任务有新结果'], 'errors lead the sentence');
});

test('an outcome inside the cooldown is deferred and merged, never swallowed', () => {
  const h = soundHarness({ away: true });
  h.ctrl.onSnapshot([], '');
  h.ctrl.onSnapshot([T('a', 'done', 100, { title: 'Alpha' }), T('b', 'running')], '');
  h.advance(4000);
  h.ctrl.onSnapshot([T('a', 'done', 100, { title: 'Alpha' }), T('b', 'done', 200, { title: 'Beta' })], '');
  assert.equal(h.dings.length, 1, 'still inside the cooldown');
  h.advance(5000);
  assert.equal(h.dings.length, 2, 'the deferred one rings after the cooldown');
  h.advance(1000);
  assert.deepEqual(h.spoken, ['任务「Alpha」已完成', '任务「Beta」已完成']);
});

test('opening a task before its deferred sound plays drops it', () => {
  const h = soundHarness({ away: true });
  h.ctrl.onSnapshot([], '');
  h.ctrl.onSnapshot([T('a', 'done', 100)], '');
  h.ctrl.onSnapshot([T('a', 'done', 100), T('b', 'done', 200)], '');
  h.ctrl.markOpened('b');
  h.advance(10000);
  assert.equal(h.dings.length, 1);
});

test('away is read when the sound plays: coming back during the cooldown means ding only', () => {
  const h = soundHarness({ away: true });
  h.ctrl.onSnapshot([], '');
  h.ctrl.onSnapshot([T('a', 'done', 100)], '');
  h.ctrl.onSnapshot([T('a', 'done', 100), T('b', 'done', 200, { title: 'Beta' })], '');
  h.presence.away = false;
  h.advance(10000);
  assert.equal(h.dings.length, 2);
  assert.equal(h.spoken.length, 1, 'only the first (away) one was narrated');
});

function sharedStore() {
  const shared = new Map();
  return {
    getItem: k => (shared.has(k) ? shared.get(k) : null),
    setItem: (k, v) => shared.set(k, String(v)),
    removeItem: k => shared.delete(k),
  };
}

test('two Air tabs: one sound, both mark the row', () => {
  const store = sharedStore();
  const one = soundHarness({ away: true, store });
  const two = soundHarness({ away: true, store });
  for (const h of [one, two]) h.ctrl.onSnapshot([T('a', 'running')], '');
  for (const h of [one, two]) h.ctrl.onSnapshot([T('a', 'done', 100)], '');
  assert.equal(one.dings.length + two.dings.length, 1);
  assert.equal(two.ctrl.isUnseen('a'), true, 'the quiet tab still marks it');
});

test('two tabs racing the same poll: the claim keeps it to one sound', () => {
  const store = sharedStore();
  const one = soundHarness({ away: false, store });
  const two = soundHarness({ away: false, store });
  for (const h of [one, two]) h.ctrl.onSnapshot([], '');
  // both read the shared watermark before either wrote it back
  store.setItem('air:notify-heard', '0');
  one.ctrl.onSnapshot([T('a', 'done', 100)], '');
  store.setItem('air:notify-heard', '0');
  two.ctrl.onSnapshot([T('a', 'done', 100)], '');
  assert.equal(one.dings.length + two.dings.length, 1);
});

test('a tab frozen in the background does not re-report what another tab already did', () => {
  const store = sharedStore();
  const awake = soundHarness({ away: false, store });
  const frozen = soundHarness({ away: false, store });
  for (const h of [awake, frozen]) h.ctrl.onSnapshot([T('a', 'running')], '');
  awake.ctrl.onSnapshot([T('a', 'done', 100)], '');
  awake.ctrl.markOpened('a');
  // the server applied the open before the frozen tab wakes up
  assert.equal(frozen.ctrl.onSnapshot([T('a', 'done')], ''), false);
  assert.equal(frozen.ctrl.isUnseen('a'), false);
  assert.equal(frozen.dings.length, 0);
});

test('waiting: a question marks the row; answered elsewhere clears it; then done is new', () => {
  const h = soundHarness({ away: false });
  h.ctrl.onSnapshot([T('q', 'running')], '');
  assert.equal(h.ctrl.onSnapshot([T('q', 'waiting', 100)], ''), true);
  assert.equal(h.ctrl.unseenKind('q'), 'waiting');
  h.ctrl.onSnapshot([T('q', 'running')], '');
  assert.equal(h.ctrl.isUnseen('q'), false);
  assert.equal(h.ctrl.onSnapshot([T('q', 'done', 200)], ''), true);
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
