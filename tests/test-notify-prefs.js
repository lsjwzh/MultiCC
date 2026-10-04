'use strict';
// Unit tests for the unified notification preferences (public/shared/notify-prefs.js)
// and how the two sound controllers honour them:
//   - air-task-notify.js: 铃声跟提醒开关，朗读跟三档（off / away / always）；
//   - chat-notifications.js: 同一份档位管聊天帧的铃声与朗读。
// The legacy boolean key (air:notify-voice) must migrate once, not fight the new one.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PREFS_MODULE = fs.readFileSync(path.join(__dirname, '..', 'public', 'shared', 'notify-prefs.js'), 'utf8');
const AIR_MODULE = fs.readFileSync(path.join(__dirname, '..', 'public', 'air-task-notify.js'), 'utf8');
const CHAT_MODULE = fs.readFileSync(path.join(__dirname, '..', 'public', 'chat-notifications.js'), 'utf8');

// A fake window good enough for all three modules: storage, events, timers the
// tests can fire on demand, and constructors that record instead of play.
function fakeWindow() {
  const store = new Map();
  const timers = [];
  const listeners = {};
  const spoken = [];
  const dings = [];
  class FakeCtx {
    constructor() { dings.push(this); }
    get currentTime() { return 0; }
    createOscillator() {
      return { connect: target => target, start() {}, stop() {}, type: '', frequency: { value: 0 } };
    }
    createGain() {
      return { connect: target => target, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } };
    }
    close() {}
  }
  const win = {
    localStorage: {
      getItem: key => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: key => store.delete(key),
    },
    navigator: { language: 'zh-CN' },
    setTimeout: fn => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener: (type, fn) => {
      const list = listeners[type] || [];
      const at = list.indexOf(fn);
      if (at >= 0) list.splice(at, 1);
    },
    dispatchEvent: () => true,
    Event: function Event(type) { this.type = type; },
    AudioContext: FakeCtx,
    webkitAudioContext: FakeCtx,
    speechSynthesis: {
      speak: utterance => spoken.push(utterance._text),
      cancel() {},
    },
    SpeechSynthesisUtterance: function SpeechSynthesisUtterance(text) { this._text = text; },
    _visibility: 'visible',
    document: {
      get visibilityState() { return win._visibility; },
      createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, append() {}, appendChild() {} }),
      createTextNode: text => ({ text }),
      addEventListener() {},
      removeEventListener() {},
      body: { appendChild() {} },
    },
    location: { pathname: '/chat.html', search: '' },
    _store: store, _timers: timers, _spoken: spoken, _dings: dings, _listeners: listeners,
  };
  return win;
}

function load(win, source) {
  new Function('window', 'document', source)(win, win.document);
}

function flushTimers(win) {
  const pending = win._timers.splice(0);
  for (const fn of pending) fn();
}

// ── the preference store itself ─────────────────────────────────────────────
test('legacy air:notify-voice migrates once into the three-mode key', () => {
  const win = fakeWindow();
  load(win, PREFS_MODULE);
  const prefs = win.MultiCCNotifyPrefs;

  win.localStorage.setItem('air:notify-voice', '1');
  assert.equal(prefs.getVoice(), 'away');       // 旧默认：只在离开时念
  assert.equal(win.localStorage.getItem('air:notify-voice'), null, '旧 key 迁移完就删');

  prefs.__resetForTest();
  win.localStorage.setItem('air:notify-voice', '0');
  assert.equal(prefs.getVoice(), 'off');

  prefs.__resetForTest();
  win.localStorage.setItem('multicc:notify:voice', 'always');
  win.localStorage.setItem('air:notify-voice', '0');
  assert.equal(prefs.getVoice(), 'always', '新 key 已有值时不被旧 key 覆盖');
  assert.equal(win.localStorage.getItem('air:notify-voice'), '0', '也不动它（别处还可能在读）');
});

test('shouldSpeak encodes the three modes in one place', () => {
  const win = fakeWindow();
  load(win, PREFS_MODULE);
  const prefs = win.MultiCCNotifyPrefs;
  prefs.setVoice('off');
  assert.equal(prefs.shouldSpeak(true), false);
  assert.equal(prefs.shouldSpeak(false), false);
  prefs.setVoice('away');
  assert.equal(prefs.shouldSpeak(true), true);
  assert.equal(prefs.shouldSpeak(false), false);
  prefs.setVoice('always');
  assert.equal(prefs.shouldSpeak(true), true);
  assert.equal(prefs.shouldSpeak(false), true);
  prefs.setVoice('nonsense');                   // 不认得的值不写入
  assert.equal(prefs.getVoice(), 'always');
});

test('remind defaults to on and survives without storage', () => {
  const win = fakeWindow();
  load(win, PREFS_MODULE);
  const prefs = win.MultiCCNotifyPrefs;
  assert.equal(prefs.remindEnabled(), true);
  prefs.setRemind(false);
  assert.equal(prefs.remindEnabled(), false);
});

// ── air-task-notify.js honouring the modes ─────────────────────────────────
function airController(win) {
  load(win, PREFS_MODULE);
  load(win, AIR_MODULE);
  const kinds = new Map();
  const deck = {
    ids: () => [...kinds.keys()],
    upsert: (task, kind) => kinds.set(String(task.id), kind),
    remove: id => kinds.delete(String(id)),
    clear: () => kinds.clear(),
    isOpen: () => false, setOpen: () => {},
  };
  const ctrl = win.MultiCCTaskNotify.create({
    getCurrentTaskId: () => null,
    openTask: () => {},
    window: win, document: win.document,
    setTimeout: win.setTimeout, clearTimeout: win.clearTimeout,
    deck: { create: () => deck },
  });
  return { ctrl, deckIds: () => [...kinds.keys()] };
}

const T = (id, status, at) => ({ id, status, attention: { kind: status, at } });

// The first snapshot only sets the ringing watermark; a newer mark on the next
// one is what actually sounds. Returns whether the second snapshot rang.
function ringNewMark(ctrl, at) {
  ctrl.onSnapshot([T('t1', 'completed', at - 50)], '');
  return ctrl.onSnapshot([T('t1', 'completed', at)], '');
}

test('always narrates even while the person is watching', () => {
  const win = fakeWindow();
  const { ctrl } = airController(win);
  win.MultiCCNotifyPrefs.setVoice('always');
  win._visibility = 'visible';                  // present: the old behaviour was ding-only
  assert.equal(ringNewMark(ctrl, 200), true);
  assert.equal(win._dings.length, 1, '提醒开着 → 铃声照旧');
  flushTimers(win);
  assert.equal(win._spoken.length, 1, 'always → 人在也念');
});

test('voice off keeps the ding but never narrates', () => {
  const win = fakeWindow();
  const { ctrl } = airController(win);
  win.MultiCCNotifyPrefs.setVoice('off');
  win._visibility = 'hidden';
  assert.equal(ringNewMark(ctrl, 200), true);
  assert.equal(win._dings.length, 1);
  flushTimers(win);
  assert.equal(win._spoken.length, 0, 'off → 不念');
});

test('remind off silences the ding and keeps new cards off the deck', () => {
  const win = fakeWindow();
  const { ctrl, deckIds } = airController(win);
  win.MultiCCNotifyPrefs.setRemind(false);
  win._visibility = 'hidden';
  ringNewMark(ctrl, 200);
  assert.equal(win._dings.length, 0, '提醒关了 → 没有铃声');
  assert.equal(win._spoken.length, 0, '朗读也压在同一个提醒下不出（等档位单独试）');
  assert.deepEqual(deckIds(), [], '新卡片不再上桌');
});

test('without the prefs module the old behaviour stands (away narrates, present dings)', () => {
  const win = fakeWindow();
  load(win, AIR_MODULE);                        // 老缓存页面：没加载 notify-prefs.js
  const ctrl = win.MultiCCTaskNotify.create({
    getCurrentTaskId: () => null, openTask: () => {},
    window: win, document: win.document,
    setTimeout: win.setTimeout, clearTimeout: win.clearTimeout,
  });
  win._visibility = 'hidden';
  ringNewMark(ctrl, 200);
  assert.equal(win._dings.length, 1);
  flushTimers(win);
  assert.equal(win._spoken.length, 1, '默认档 away：人不在 → 念');
});

// ── chat-notifications.js honouring the same modes ─────────────────────────
function chatController(win) {
  load(win, PREFS_MODULE);
  load(win, CHAT_MODULE);
  const toast = {
    style: {}, textContent: '', className: '',
    querySelector: () => null,
    appendChild() {},
    addEventListener() {}, removeEventListener() {},
  };
  return win.MultiCCChatNotifications.createNotificationController({
    window: win, document: win.document,
    notifyBtn: null, notifyToast: toast,
    getSessionId: () => 's1',
    getTaskNotifyEnabled: () => true,
    setTaskNotifyEnabled: () => {},
    presence: null,                             // → isAway falls back to visibility
  });
}

test('chat frame: always narrates while visible, remind off removes the ding', () => {
  const win = fakeWindow();
  const chat = chatController(win);
  win.MultiCCNotifyPrefs.setVoice('always');
  win._visibility = 'visible';
  assert.equal(chat.speak('任务「a」已完成', 'succeeded'), true);
  assert.equal(win._dings.length, 1);
  flushTimers(win);
  assert.equal(win._spoken.length, 1, 'always → 可见时也念');

  win.MultiCCNotifyPrefs.setRemind(false);
  win.MultiCCNotifyPrefs.setVoice('off');
  assert.equal(chat.speak('任务「b」出错了', 'error'), true);
  assert.equal(win._dings.length, 1, '提醒关了 → 第二次没有新铃声');
  flushTimers(win);
  assert.equal(win._spoken.length, 1, 'off → 不再念');
});

test('chat frame: voice off still shows the away toast (silence is not blindness)', () => {
  const win = fakeWindow();
  const toast = { style: {}, textContent: '', className: '', querySelector: () => null, appendChild() {}, addEventListener() {}, removeEventListener() {} };
  load(win, PREFS_MODULE);
  load(win, CHAT_MODULE);
  const chat = win.MultiCCChatNotifications.createNotificationController({
    window: win, document: win.document, notifyBtn: null, notifyToast: toast,
    getSessionId: () => 's1', getTaskNotifyEnabled: () => true, setTaskNotifyEnabled: () => {},
    presence: null,
  });
  win.MultiCCNotifyPrefs.setVoice('off');
  win._visibility = 'hidden';
  assert.equal(chat.speak('任务「c」已完成', 'succeeded'), true);
  assert.equal(win._spoken.length, 0);
  // 不 flush：showToast 自己排的 15s dismiss 也在同一队列里，跑掉会把提示条收走。
  assert.equal(toast.style.display, 'block', '人不在 → 提示条仍然出现');
});
