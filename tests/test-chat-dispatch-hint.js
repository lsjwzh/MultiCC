'use strict';

// The commander-only dispatch-mode radio group: it must stay invisible and inert
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

const MODE_VALUES = ['dispatch_master', 'route_task', 'none'];

const MODE_UI = {
  dispatch_master: { icon: '⇄', short: '需回执', key: 'dispatchModeMasterShort' },
  route_task: { icon: '➤', short: '免回执', key: 'dispatchModeRouteShort' },
  none: { icon: '⊘', short: '不派发', key: 'dispatchModeNoneShort' },
};

function fakeNode(extra = {}) {
  return Object.assign({
    attributes: {},
    dataset: {},
    listeners: {},
    textContent: '',
    hidden: false,
    addEventListener(type, handler) { (this.listeners[type] = this.listeners[type] || []).push(handler); },
    fire(type, event = {}) { (this.listeners[type] || []).forEach(handler => handler(event)); },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; },
    hasAttribute(name) { return name in this.attributes; },
  }, extra);
}

// A segment is the <label> wrapping the radio; the pill copies its icon + text.
function fakeRadio(value) {
  const ui = MODE_UI[value];
  const icon = fakeNode({ className: 'dm-icon', textContent: ui.icon });
  const text = fakeNode({ className: 'dm-text', textContent: ui.short, dataset: { i18n: ui.key } });
  const label = fakeNode({
    querySelector(selector) {
      if (selector === '.dm-icon') return icon;
      if (selector === '.dm-text') return text;
      return null;
    },
  });
  const radio = fakeNode({ value, checked: false, parentNode: label });
  return radio;
}

function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { map.set(key, String(value)); },
  };
}

// Each case drives its own DOM so nothing leaks between them. `bare: true`
// drops the pill + sheet to prove the module still works without them.
function hintDocument({ bare = false } = {}) {
  const radios = MODE_VALUES.map(fakeRadio);
  const group = fakeNode({
    id: 'dispatch-mode-group',
    querySelectorAll(selector) {
      return selector === 'input[name="dispatch-mode"]' ? radios.slice() : [];
    },
  });
  const pillIcon = fakeNode({ textContent: '⇄' });
  const pillLabel = fakeNode({ textContent: '需回执', dataset: { i18n: 'dispatchModeMasterShort' } });
  const pill = fakeNode({ attributes: { 'aria-expanded': 'false' } });
  const sheetOpts = MODE_VALUES.map(value => fakeNode({
    className: 'dm-sheet-opt',
    attributes: { 'data-mode': value, 'aria-checked': value === 'dispatch_master' ? 'true' : 'false' },
  }));
  const backdrop = fakeNode({ attributes: { 'data-dm-close': '' } });
  const sheet = fakeNode({
    hidden: true,
    querySelectorAll(selector) { return selector === '.dm-sheet-opt' ? sheetOpts.slice() : []; },
  });
  const byId = bare
    ? { 'dispatch-mode-group': group }
    : {
      'dispatch-mode-group': group,
      'dispatch-mode-pill': pill,
      'dispatch-mode-pill-icon': pillIcon,
      'dispatch-mode-pill-label': pillLabel,
      'dispatch-mode-sheet': sheet,
    };
  const doc = fakeNode({
    getElementById(id) { return byId[id] || null; },
    readyState: 'complete',
    group,
    radios,
    pill,
    pillIcon,
    pillLabel,
    sheet,
    sheetOpts,
    backdrop,
    radio(value) { return radios.find(r => r.value === value); },
    sheetOpt(value) { return sheetOpts.find(o => o.getAttribute('data-mode') === value); },
    // What a real click does: the browser flips the group, then fires `change`.
    pick(value) {
      radios.forEach(r => { r.checked = (r.value === value); });
      radios.find(r => r.value === value).fire('change');
    },
  });
  return doc;
}

function loadHint(extraWindow = {}) {
  const document = hintDocument();
  const window = Object.assign({
    document,
    // Auto-boot would fire a session fetch the tests never asked for.
    __multiccDispatchHintNoAutoBoot: true,
  }, extraWindow);
  const context = vm.createContext({ window, console, setTimeout, clearTimeout, Promise });
  vm.runInContext(HINT_SRC, context, { filename: 'chat-dispatch-hint.js' });
  return { api: window.MultiCCChatDispatchHint, window, document };
}

test('module exposes a frozen API and the three routing suffixes', () => {
  const { api } = loadHint();
  assert.equal(Object.isFrozen(api), true);
  // Suffixes are English on purpose — the model obeys English routing
  // instructions more reliably — and each names the exact tool to call.
  assert.match(api.SUFFIX_DISPATCH_MASTER, /dispatch_master/);
  assert.match(api.SUFFIX_DISPATCH_MASTER, /flow back.*asynchronously/i);
  assert.match(api.SUFFIX_ROUTE_TASK, /route_task/);
  assert.match(api.SUFFIX_ROUTE_TASK, /fire-and-forget/i);
  assert.match(api.SUFFIX_NONE, /do not dispatch/i);
  // The "no dispatch" wording must not name a tool the model could then call.
  assert.equal(/dispatch_master|route_task/.test(api.SUFFIX_NONE), false);
  assert.equal(api.MODE_DISPATCH_MASTER, 'dispatch_master');
  assert.equal(api.MODE_ROUTE_TASK, 'route_task');
  assert.equal(api.MODE_NONE, 'none');
  assert.equal(api.STORE_PREFIX, 'multicc.dispatchMode.');
});

test('an ordinary session keeps the group hidden and never rewrites the prompt', async () => {
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
  assert.equal(doc.group.hidden, true);
  assert.equal(hint.decorate('修一下 diff 面板'), '修一下 diff 面板');
});

test('a commander session shows the group and defaults to dispatch_master', async () => {
  const { api } = loadHint();
  const doc = hintDocument();
  const hint = api.createDispatchHint({
    document: doc,
    sessionId: 'multicc-commander-01',
    storage: fakeStorage(),
    loadSession: async () => ({ id: 'multicc-commander-01', type: 'commander' }),
  });
  assert.equal(await hint.mount(), true);
  assert.equal(doc.group.hidden, false);
  assert.equal(hint.getMode(), 'dispatch_master');
  assert.equal(doc.radio('dispatch_master').checked, true);
  assert.equal(doc.radio('route_task').checked, false);
  assert.equal(doc.radio('none').checked, false);
  assert.equal(hint.decorate('部署新版本'), '部署新版本' + api.SUFFIX_DISPATCH_MASTER);
});

test('picking a mode swaps the appended sentence, exclusively, and persists it', async () => {
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

  doc.pick('route_task');
  assert.equal(hint.getMode(), 'route_task');
  assert.equal(hint.decorate('部署新版本'), '部署新版本' + api.SUFFIX_ROUTE_TASK);
  assert.equal(storage.getItem('multicc.dispatchMode.multicc-commander-01'), 'route_task');
  assert.deepEqual(doc.radios.filter(r => r.checked).map(r => r.value), ['route_task']);

  doc.pick('none');
  assert.equal(hint.decorate('部署新版本'), '部署新版本' + api.SUFFIX_NONE);
  assert.equal(storage.getItem('multicc.dispatchMode.multicc-commander-01'), 'none');
  assert.deepEqual(doc.radios.filter(r => r.checked).map(r => r.value), ['none']);

  doc.pick('dispatch_master');
  assert.equal(hint.decorate('部署新版本'), '部署新版本' + api.SUFFIX_DISPATCH_MASTER);
  assert.equal(storage.getItem('multicc.dispatchMode.multicc-commander-01'), 'dispatch_master');
  assert.deepEqual(doc.radios.filter(r => r.checked).map(r => r.value), ['dispatch_master']);
});

test('a stored choice is restored on the next load of the same session only', async () => {
  const { api } = loadHint();
  const storage = fakeStorage({ 'multicc.dispatchMode.multicc-commander-01': 'none' });

  const same = hintDocument();
  const restored = api.createDispatchHint({
    document: same, sessionId: 'multicc-commander-01', storage,
    loadSession: async () => ({ type: 'commander' }),
  });
  await restored.mount();
  assert.equal(restored.getMode(), 'none');
  assert.equal(same.radio('none').checked, true);

  const other = hintDocument();
  const fresh = api.createDispatchHint({
    document: other, sessionId: 'multicc-commander-02', storage,
    loadSession: async () => ({ type: 'commander' }),
  });
  await fresh.mount();
  assert.equal(fresh.getMode(), 'dispatch_master');
});

test('the legacy boolean switch migrates to the matching mode', async () => {
  const { api } = loadHint();

  const kept = hintDocument();
  const keeper = api.createDispatchHint({
    document: kept, sessionId: 'legacy-on', storage: fakeStorage({ 'multicc.noDispatch.legacy-on': '1' }),
    loadSession: async () => ({ type: 'commander' }),
  });
  await keeper.mount();
  assert.equal(keeper.getMode(), 'none');

  const spread = hintDocument();
  const spreader = api.createDispatchHint({
    document: spread, sessionId: 'legacy-off', storage: fakeStorage({ 'multicc.noDispatch.legacy-off': '0' }),
    loadSession: async () => ({ type: 'commander' }),
  });
  await spreader.mount();
  assert.equal(spreader.getMode(), 'dispatch_master');
});

test('an unknown stored value falls back to the default instead of throwing', async () => {
  const { api } = loadHint();
  const doc = hintDocument();
  const hint = api.createDispatchHint({
    document: doc, sessionId: 'c', storage: fakeStorage({ 'multicc.dispatchMode.c': 'broadcast' }),
    loadSession: async () => ({ type: 'commander' }),
  });
  await hint.mount();
  assert.equal(hint.getMode(), 'dispatch_master');
  assert.equal(hint.decorate('x'), 'x' + api.SUFFIX_DISPATCH_MASTER);
});

test('an unreadable session role fails closed: hidden group, untouched prompt', async () => {
  const { api } = loadHint();
  const doc = hintDocument();
  const hint = api.createDispatchHint({
    document: doc, sessionId: 'multicc-commander-01', storage: fakeStorage(),
    roleMaxRetries: 0,
    loadSession: async () => { throw new Error('offline'); },
  });
  assert.equal(await hint.mount(), false);
  assert.equal(doc.group.hidden, true);
  assert.equal(hint.decorate('部署新版本'), '部署新版本');
});

test('a transient boot-time failure retries and then reveals the group', async () => {
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
  assert.equal(doc.group.hidden, false);
});

test('the narrow-screen pill mirrors the segment that is selected', async () => {
  const { api } = loadHint();
  const doc = hintDocument();
  const hint = api.createDispatchHint({
    document: doc, sessionId: 'c', storage: fakeStorage(),
    loadSession: async () => ({ type: 'commander' }),
  });
  await hint.mount();
  assert.equal(doc.pill.getAttribute('data-mode'), 'dispatch_master');
  assert.equal(doc.pillIcon.textContent, '⇄');
  assert.equal(doc.pillLabel.textContent, '需回执');

  doc.pick('none');
  assert.equal(doc.pill.getAttribute('data-mode'), 'none');
  assert.equal(doc.pillIcon.textContent, '⊘');
  assert.equal(doc.pillLabel.textContent, '不派发');
  // Carrying the key over keeps the pill translatable like any other label.
  assert.equal(doc.pillLabel.dataset.i18n, 'dispatchModeNoneShort');
});

test('the pill opens the sheet and a sheet choice applies everywhere at once', async () => {
  const { api } = loadHint();
  const doc = hintDocument();
  const storage = fakeStorage();
  const hint = api.createDispatchHint({
    document: doc, sessionId: 'c', storage,
    loadSession: async () => ({ type: 'commander' }),
  });
  await hint.mount();
  assert.equal(doc.sheet.hidden, true);

  doc.pill.fire('click');
  assert.equal(doc.sheet.hidden, false);
  assert.equal(doc.pill.getAttribute('aria-expanded'), 'true');

  doc.sheetOpt('route_task').fire('click');
  assert.equal(hint.getMode(), 'route_task');
  assert.equal(hint.decorate('部署'), '部署' + api.SUFFIX_ROUTE_TASK);
  // One choice, three surfaces: sheet ticks, segmented radios, and the pill.
  assert.equal(doc.sheetOpt('route_task').getAttribute('aria-checked'), 'true');
  assert.equal(doc.sheetOpt('dispatch_master').getAttribute('aria-checked'), 'false');
  assert.deepEqual(doc.radios.filter(r => r.checked).map(r => r.value), ['route_task']);
  assert.equal(doc.pillLabel.textContent, '免回执');
  assert.equal(storage.getItem('multicc.dispatchMode.c'), 'route_task');
  assert.equal(doc.sheet.hidden, true);
  assert.equal(doc.pill.getAttribute('aria-expanded'), 'false');
});

test('the sheet dismisses on the scrim and on Escape without changing the mode', async () => {
  const { api } = loadHint();
  const doc = hintDocument();
  const hint = api.createDispatchHint({
    document: doc, sessionId: 'c', storage: fakeStorage(),
    loadSession: async () => ({ type: 'commander' }),
  });
  await hint.mount();

  doc.pill.fire('click');
  doc.sheet.fire('click', { target: doc.backdrop });
  assert.equal(doc.sheet.hidden, true);
  assert.equal(hint.getMode(), 'dispatch_master');

  doc.pill.fire('click');
  doc.fire('keydown', { key: 'Escape' });
  assert.equal(doc.sheet.hidden, true);

  // A click inside the panel must not close it out from under the user.
  doc.pill.fire('click');
  doc.sheet.fire('click', { target: fakeNode() });
  assert.equal(doc.sheet.hidden, false);
});

test('losing the commander role closes an open sheet', async () => {
  const { api } = loadHint();
  const doc = hintDocument();
  const hint = api.createDispatchHint({
    document: doc, sessionId: 'c', storage: fakeStorage(),
    loadSession: async () => ({ type: 'commander' }),
  });
  await hint.mount();
  doc.pill.fire('click');
  hint.setEnabled(false);
  assert.equal(doc.sheet.hidden, true);
  assert.equal(doc.group.hidden, true);
});

test('a page without the pill or sheet still selects modes through the segments', async () => {
  const { api } = loadHint();
  const doc = hintDocument({ bare: true });
  const hint = api.createDispatchHint({
    document: doc, sessionId: 'c', storage: fakeStorage(),
    loadSession: async () => ({ type: 'commander' }),
  });
  await hint.mount();
  doc.pick('none');
  assert.equal(hint.getMode(), 'none');
  assert.equal(hint.decorate('x'), 'x' + api.SUFFIX_NONE);
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
      decorate(text) { decorated.push(text); return text + '\n\n[Dispatch] Do not dispatch to other sessions this turn.'; },
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
  assert.equal(sent[0].text, '部署新版本\n\n[Dispatch] Do not dispatch to other sessions this turn.');
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

test('the chat host ships the radio group: markup, hidden rule, and script order', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/chat.html'), 'utf8');
  const scripts = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map(match => match[1]);
  assert.ok(scripts.indexOf('chat-dispatch-hint.js') > scripts.indexOf('chat-ai-config.js'));
  assert.ok(scripts.indexOf('chat-dispatch-hint.js') < scripts.indexOf('chat.js'));

  const barStart = html.indexOf('<div id="pre-input-bar">');
  const bar = html.slice(barStart, html.indexOf('<!-- Messages durably staged', barStart));
  assert.match(bar, /id="dispatch-mode-group"\s+hidden/);
  // One radio per mode, all in the same group so the browser enforces exclusivity.
  for (const value of MODE_VALUES) {
    assert.match(bar, new RegExp(`type="radio"\\s+name="dispatch-mode"\\s+value="${value}"`));
  }
  assert.match(bar, /value="dispatch_master"\s+checked/);
  // Segments read as one picker: a caption plus a labelled radiogroup.
  assert.match(bar, /class="dm-title" data-i18n="dispatchModeTitle"/);
  assert.match(bar, /class="dm-segments" role="radiogroup"/);
  for (const key of ['dispatchModeMasterShort', 'dispatchModeRouteShort', 'dispatchModeNoneShort']) {
    assert.match(bar, new RegExp(`class="dm-text" data-i18n="${key}"`));
  }
  assert.match(bar, /id="dispatch-mode-pill"[^>]*aria-haspopup="dialog"/);
  // display:inline-flex on the group would otherwise defeat the hidden attribute.
  assert.match(html, /#dispatch-mode-group\[hidden\]\s*\{\s*display:\s*none;\s*\}/);
});

test('the narrow-screen layout swaps the segments for the pill', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/chat.html'), 'utf8');
  // The swap has to sit inside a narrow-screen media query, not at top level.
  const swap = html.indexOf('#dispatch-mode-pill { display: inline-flex; }');
  assert.ok(swap > 0, 'the pill must be revealed somewhere');
  const query = html.lastIndexOf('@media (max-width: 760px)', swap);
  assert.ok(query > 0 && html.indexOf('@media', query + 10) > swap,
    'the swap must live inside the max-width:760px query');
  assert.match(html.slice(query, swap), /#dispatch-mode-group \.dm-segments \{ display: none; \}/);
  // Off the narrow layout the pill must stay out of the way.
  assert.match(html, /#dispatch-mode-pill \{\s*display: none;/);
});

test('the bottom sheet offers all three modes with tappable rows', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/chat.html'), 'utf8');
  const start = html.indexOf('<div id="dispatch-mode-sheet"');
  assert.ok(start > 0, 'the sheet markup must exist');
  const sheet = html.slice(start, html.indexOf('<!-- Voice panel -->', start));
  assert.match(sheet, /role="dialog" aria-modal="true"/);
  assert.match(sheet, /class="dm-sheet-list" role="radiogroup"/);
  for (const value of MODE_VALUES) {
    assert.match(sheet, new RegExp(`role="radio"[^>]*\\n?[^>]*data-mode="${value}"`));
  }
  // Long label + one-line description, per mode.
  for (const key of ['dispatchModeMasterLabel', 'dispatchModeRouteLabel', 'dispatchModeNoneLabel',
    'dispatchModeMasterDesc', 'dispatchModeRouteDesc', 'dispatchModeNoneDesc']) {
    assert.match(sheet, new RegExp(`data-i18n="${key}"`));
  }
  assert.match(sheet, /data-dm-close/);
  // Touch targets on the sheet must clear the 44px floor.
  const minHeight = /#dispatch-mode-sheet \.dm-sheet-opt \{[^}]*min-height: (\d+)px/.exec(html);
  assert.ok(minHeight && Number(minHeight[1]) >= 44, 'sheet rows need a >=44px touch target');
});

test('every new dispatch string is translated in both locales', () => {
  const zh = JSON.parse(fs.readFileSync(path.join(ROOT, 'app/assets/i18n/zh.json'), 'utf8'));
  const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'app/assets/i18n/en.json'), 'utf8'));
  const keys = ['dispatchModeTitle', 'dispatchModeSheetTitle',
    'dispatchModeMasterShort', 'dispatchModeRouteShort', 'dispatchModeNoneShort',
    'dispatchModeMasterDesc', 'dispatchModeRouteDesc', 'dispatchModeNoneDesc'];
  for (const key of keys) {
    assert.ok(zh[key], `zh.json is missing ${key}`);
    assert.ok(en[key], `en.json is missing ${key}`);
    assert.notEqual(zh[key], en[key], `${key} looks untranslated`);
  }
  // The web catalog is generated from those two files; a stale one ships the
  // page with missing labels.
  const catalog = fs.readFileSync(path.join(ROOT, 'public/i18n-catalog.js'), 'utf8');
  for (const key of keys) assert.ok(catalog.includes(`"${key}"`), `i18n-catalog.js is stale: ${key}`);
});

test('the task panel input does not carry the dispatch-mode group', () => {
  for (const file of ['public/index.html', 'public/chat.js']) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.equal(source.includes('dispatch-mode-group'), false, `${file} must not host the group`);
  }
});

test('the session detail endpoint carries the role the group keys off', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src/routes/session-admin.js'), 'utf8');
  const start = source.indexOf('function legacySessionDetailPresenter');
  assert.ok(start > 0);
  const presenter = source.slice(start, source.indexOf('\n  }\n', start));
  assert.match(presenter, /type: record\.type \|\| null/);
});
