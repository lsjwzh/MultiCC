'use strict';

// The commander-only「不派发给其他会话」switch: it must stay invisible and inert
// in ordinary sessions, and when it is live the sentence it appends has to reach
// both the staged bubble and the WebSocket payload as one identical string.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const HINT_SRC = fs.readFileSync(path.join(ROOT, 'public/chat-dispatch-hint.js'), 'utf8');
const COMPOSER_SRC = fs.readFileSync(path.join(ROOT, 'public/chat-composer.js'), 'utf8');

function fakeElement(id) {
  return {
    id,
    hidden: false,
    checked: false,
    listeners: {},
    addEventListener(type, handler) { (this.listeners[type] = this.listeners[type] || []).push(handler); },
    fire(type) { (this.listeners[type] || []).forEach(handler => handler({})); },
  };
}

function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { map.set(key, String(value)); },
  };
}

function loadHint(extraWindow = {}) {
  const label = fakeElement('no-dispatch-label');
  const check = fakeElement('no-dispatch-check');
  const document = {
    readyState: 'complete',
    getElementById(id) {
      if (id === 'no-dispatch-label') return label;
      if (id === 'no-dispatch-check') return check;
      return null;
    },
    addEventListener() {},
  };
  const window = Object.assign({
    document,
    // Auto-boot would fire a session fetch the tests never asked for.
    __multiccDispatchHintNoAutoBoot: true,
  }, extraWindow);
  const context = vm.createContext({ window, console, setTimeout, clearTimeout, Promise });
  vm.runInContext(HINT_SRC, context, { filename: 'chat-dispatch-hint.js' });
  return { api: window.MultiCCChatDispatchHint, window, document, label, check };
}

test('module exposes a frozen API and the two routing suffixes', () => {
  const { api } = loadHint();
  assert.equal(Object.isFrozen(api), true);
  assert.match(api.SUFFIX_SPREAD, /route_task/);
  // Suffixes are English on purpose — the model obeys English routing instructions.
  assert.match(api.SUFFIX_SPREAD, /dispatch this task to other sessions/i);
  assert.match(api.SUFFIX_KEEP, /do not dispatch this task/i);
  assert.match(api.SUFFIX_KEEP, /route_task/);
  assert.equal(api.STORE_PREFIX, 'multicc.noDispatch.');
});

// Each case drives its own DOM so nothing leaks between them.
function hintDocument() {
  const label = fakeElement('no-dispatch-label');
  const check = fakeElement('no-dispatch-check');
  return {
    getElementById(id) {
      if (id === 'no-dispatch-label') return label;
      if (id === 'no-dispatch-check') return check;
      return null;
    },
    label,
    check,
  };
}

test('an ordinary session keeps the switch hidden and never rewrites the prompt', async () => {
  const { api } = loadHint();
  const doc = hintDocument();
  const hint = api.createDispatchHint({
    document: doc,
    sessionId: 'multicc-claude-chat-05',
    storage: fakeStorage(),
    loadSession: async () => ({ id: 'multicc-claude-chat-05', type: null }),
  });
  assert.equal(await hint.mount(), false);
  assert.equal(hint.isEnabled(), false);
  assert.equal(doc.label.hidden, true);
  assert.equal(hint.decorate('修一下 diff 面板'), '修一下 diff 面板');
});

test('a commander session shows the switch and defaults to spreading the work', async () => {
  const { api } = loadHint();
  const doc = hintDocument();
  const hint = api.createDispatchHint({
    document: doc,
    sessionId: 'multicc-commander-01',
    storage: fakeStorage(),
    loadSession: async () => ({ id: 'multicc-commander-01', type: 'commander' }),
  });
  assert.equal(await hint.mount(), true);
  assert.equal(doc.label.hidden, false);
  assert.equal(doc.check.checked, false);
  assert.equal(hint.decorate('部署新版本'), '部署新版本' + api.SUFFIX_SPREAD);
});

test('checking the box flips the appended sentence and persists per session', async () => {
  const { api } = loadHint();
  const doc = hintDocument();
  const storage = fakeStorage();
  const hint = api.createDispatchHint({
    document: doc,
    sessionId: 'multicc-commander-01',
    storage,
    loadSession: async () => ({ type: 'commander' }),
  });
  await hint.mount();

  doc.check.checked = true;
  doc.check.fire('change');
  assert.equal(hint.isNoDispatch(), true);
  assert.equal(hint.decorate('部署新版本'), '部署新版本' + api.SUFFIX_KEEP);
  assert.equal(storage.getItem('multicc.noDispatch.multicc-commander-01'), '1');

  doc.check.checked = false;
  doc.check.fire('change');
  assert.equal(hint.decorate('部署新版本'), '部署新版本' + api.SUFFIX_SPREAD);
  assert.equal(storage.getItem('multicc.noDispatch.multicc-commander-01'), '0');
});

test('a stored choice is restored on the next load of the same session only', async () => {
  const { api } = loadHint();
  const storage = fakeStorage({ 'multicc.noDispatch.multicc-commander-01': '1' });

  const same = hintDocument();
  const restored = api.createDispatchHint({
    document: same, sessionId: 'multicc-commander-01', storage,
    loadSession: async () => ({ type: 'commander' }),
  });
  await restored.mount();
  assert.equal(restored.isNoDispatch(), true);
  assert.equal(same.check.checked, true);

  const other = hintDocument();
  const fresh = api.createDispatchHint({
    document: other, sessionId: 'multicc-commander-02', storage,
    loadSession: async () => ({ type: 'commander' }),
  });
  await fresh.mount();
  assert.equal(fresh.isNoDispatch(), false);
});

test('an unreadable session role fails closed: hidden switch, untouched prompt', async () => {
  const { api } = loadHint();
  const doc = hintDocument();
  const hint = api.createDispatchHint({
    document: doc, sessionId: 'multicc-commander-01', storage: fakeStorage(),
    roleMaxRetries: 0,
    loadSession: async () => { throw new Error('offline'); },
  });
  assert.equal(await hint.mount(), false);
  assert.equal(doc.label.hidden, true);
  assert.equal(hint.decorate('部署新版本'), '部署新版本');
});

test('a transient boot-time failure retries and then reveals the switch', async () => {
  const { api } = loadHint();
  const doc = hintDocument();
  let attempts = 0;
  const hint = api.createDispatchHint({
    document: doc, sessionId: 'multicc-commander-01', storage: fakeStorage(),
    roleMaxRetries: 3, roleRetryDelayMs: 1,
    loadSession: async () => {
      attempts += 1;
      if (attempts < 2) throw new Error('transient');
      return { id: 'multicc-commander-01', type: 'commander' };
    },
  });
  assert.equal(await hint.mount(), true);
  assert.equal(attempts, 2);
  assert.equal(doc.label.hidden, false);
});

test('blank and non-string input is passed through untouched', async () => {
  const { api } = loadHint();
  const hint = api.createDispatchHint({
    document: hintDocument(), sessionId: 's', storage: fakeStorage(),
    loadSession: async () => ({ type: 'commander' }),
  });
  await hint.mount();
  assert.equal(hint.decorate('   '), '   ');
  assert.equal(hint.decorate(''), '');
  assert.equal(hint.decorate(null), null);
});

test('the composer sends and stages the very same decorated string', () => {
  const decorated = [];
  const window = {
    document: { activeElement: null, getElementById: () => null, createTextNode: text => ({ textContent: text }) },
    navigator: { userAgent: 'test', mediaDevices: null },
    location: { protocol: 'http:', host: 'localhost:3000' },
    setTimeout,
    clearTimeout,
    MultiCCChatDispatchHint: {
      decorate(text) { decorated.push(text); return text + '\n\n[派发要求] 不要派发给其它会话。'; },
    },
  };
  const context = vm.createContext({ window, console, setTimeout, clearTimeout });
  vm.runInContext(COMPOSER_SRC, context, { filename: 'chat-composer.js' });

  const sent = [];
  const staged = [];
  const inputEl = { value: '部署新版本', style: {}, scrollHeight: 32 };
  const composer = window.MultiCCChatComposer.createComposer({
    window,
    document: window.document,
    navigator: window.navigator,
    location: window.location,
    autoBind: false,
    elements: { input: inputEl },
    isSocketOpen: () => true,
    transportSend: payload => { sent.push(payload); return true; },
    stageUserMessage: text => staged.push(text),
    debug() {},
    updateUi() {},
  });

  assert.equal(composer.send(), true);
  assert.deepEqual(decorated, ['部署新版本']);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, '部署新版本\n\n[派发要求] 不要派发给其它会话。');
  // Divergence here would show one message in the bubble and send another.
  assert.deepEqual(staged, [sent[0].text]);
});

test('a failed send restores what the user typed, not the decorated copy', () => {
  const window = {
    document: { activeElement: null, getElementById: () => null, createTextNode: text => ({ textContent: text }) },
    navigator: { userAgent: 'test', mediaDevices: null },
    location: { protocol: 'http:', host: 'localhost:3000' },
    setTimeout,
    clearTimeout,
    MultiCCChatDispatchHint: { decorate: text => text + ' [SUFFIX]' },
  };
  const context = vm.createContext({ window, console, setTimeout, clearTimeout });
  vm.runInContext(COMPOSER_SRC, context, { filename: 'chat-composer.js' });

  const inputEl = { value: '部署新版本', style: {}, scrollHeight: 32 };
  const composer = window.MultiCCChatComposer.createComposer({
    window,
    document: window.document,
    navigator: window.navigator,
    location: window.location,
    autoBind: false,
    elements: { input: inputEl },
    isSocketOpen: () => true,
    transportSend: () => false,
    addSystemMessage() {},
    debug() {},
    updateUi() {},
  });

  assert.equal(composer.send(), false);
  assert.equal(inputEl.value, '部署新版本');
});

test('a session without the hint module keeps the prompt byte-identical', () => {
  const window = {
    document: { activeElement: null, getElementById: () => null, createTextNode: text => ({ textContent: text }) },
    navigator: { userAgent: 'test', mediaDevices: null },
    location: { protocol: 'http:', host: 'localhost:3000' },
    setTimeout,
    clearTimeout,
  };
  const context = vm.createContext({ window, console, setTimeout, clearTimeout });
  vm.runInContext(COMPOSER_SRC, context, { filename: 'chat-composer.js' });

  const sent = [];
  const inputEl = { value: 'hello', style: {}, scrollHeight: 32 };
  const composer = window.MultiCCChatComposer.createComposer({
    window, document: window.document, navigator: window.navigator, location: window.location,
    autoBind: false, elements: { input: inputEl },
    isSocketOpen: () => true,
    transportSend: payload => { sent.push(payload); return true; },
    debug() {}, updateUi() {},
  });
  assert.equal(composer.send(), true);
  assert.equal(sent[0].text, 'hello');
});

test('the chat host ships the switch: markup, hidden rule, and script order', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/chat.html'), 'utf8');
  const scripts = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map(match => match[1]);
  assert.ok(scripts.indexOf('chat-dispatch-hint.js') > scripts.indexOf('chat-ai-config.js'));
  assert.ok(scripts.indexOf('chat-dispatch-hint.js') < scripts.indexOf('chat.js'));

  const bar = html.slice(html.indexOf('<div id="pre-input-bar">'), html.indexOf('</div>', html.indexOf('<div id="pre-input-bar">')) + 6);
  assert.match(bar, /id="no-dispatch-label"[\s\S]*hidden/);
  assert.match(bar, /id="no-dispatch-check"/);
  assert.match(bar, /不派发给其他会话/);
  // display:flex on the label would otherwise defeat the hidden attribute.
  assert.match(html, /#no-dispatch-label\[hidden\]\s*\{\s*display:\s*none;\s*\}/);
});

test('the session detail endpoint carries the role the switch keys off', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src/routes/session-admin.js'), 'utf8');
  const start = source.indexOf('function legacySessionDetailPresenter');
  assert.ok(start > 0);
  const presenter = source.slice(start, source.indexOf('\n  }\n', start));
  assert.match(presenter, /type: record\.type \|\| null/);
});
