'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const { createEventController } = require('../public/chat-event-controller');
const { createHistoryView } = require('../public/chat-history-view');
const { createChatHistoryRuntime } = require('../src/routes/chat-history');

const ROOT = path.join(__dirname, '..');

class FakeClassList {
  constructor(element) { this.element = element; this.values = new Set(); }
  set(value) { this.values = new Set(String(value || '').split(/\s+/).filter(Boolean)); }
  add(...values) { values.forEach(value => this.values.add(value)); }
  remove(...values) { values.forEach(value => this.values.delete(value)); }
  contains(value) { return this.values.has(value); }
  toggle(value, force) {
    if (force === true) { this.values.add(value); return true; }
    if (force === false) { this.values.delete(value); return false; }
    if (this.values.has(value)) { this.values.delete(value); return false; }
    this.values.add(value);
    return true;
  }
  toString() { return [...this.values].join(' '); }
}

function dataKey(attribute) {
  return attribute.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function matchesSelector(element, selector) {
  if (!element || element.nodeType === 11) return false;
  if (selector.includes(' ')) {
    const parts = selector.trim().split(/\s+/);
    if (!matchesSelector(element, parts.pop())) return false;
    let parent = element.parentNode;
    while (parent) {
      if (matchesSelector(parent, parts.join(' '))) return true;
      parent = parent.parentNode;
    }
    return false;
  }
  const notData = selector.match(/:not\(\[([^\]]+)\]\)/);
  const notClass = selector.match(/:not\(\.([^)]+)\)/);
  const requiredData = [...selector.matchAll(/\[([^\]]+)\]/g)].map(match => match[1]);
  const classes = [...selector.matchAll(/\.([a-zA-Z0-9_-]+)/g)].map(match => match[1]);
  const tag = selector.match(/^[a-zA-Z][a-zA-Z0-9-]*/);
  if (tag && element.tagName !== tag[0].toUpperCase()) return false;
  if (classes.some(name => !element.classList.contains(name))) return false;
  if (requiredData.some(attribute => {
    if (!attribute.startsWith('data-')) return true;
    return !element.dataset[dataKey(attribute)];
  })) return false;
  if (notData && notData[1].startsWith('data-') && element.dataset[dataKey(notData[1])]) return false;
  if (notClass && element.classList.contains(notClass[1])) return false;
  return true;
}

class FakeElement {
  constructor(tagName = 'div', nodeType = 1) {
    this.tagName = String(tagName).toUpperCase();
    this.nodeType = nodeType;
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.style = {};
    this.classList = new FakeClassList(this);
    this._textContent = '';
    this._innerHTML = '';
    this.scrollTop = 0;
  }
  set className(value) { this.classList.set(value); }
  get className() { return this.classList.toString(); }
  set textContent(value) { this._textContent = String(value == null ? '' : value); this.children = []; }
  get textContent() {
    return this.children.length ? this.children.map(child => child.textContent).join('') : this._textContent;
  }
  set innerHTML(value) { this._innerHTML = String(value); this.children = []; }
  get innerHTML() { return this._innerHTML; }
  get firstElementChild() { return this.children[0] || null; }
  get scrollHeight() { return this.children.length * 20; }
  append(...children) { children.forEach(child => this.appendChild(child)); }
  appendChild(child) {
    if (child.nodeType === 11) {
      for (const nested of [...child.children]) this.appendChild(nested);
      child.children = [];
      return child;
    }
    if (child.parentNode) child.remove();
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  insertBefore(child, reference) {
    if (child.nodeType === 11) {
      for (const nested of [...child.children]) this.insertBefore(nested, reference);
      child.children = [];
      return child;
    }
    if (child.parentNode) child.remove();
    const index = reference ? this.children.indexOf(reference) : -1;
    child.parentNode = this;
    if (index < 0) this.children.push(child);
    else this.children.splice(index, 0, child);
    return child;
  }
  replaceWith(replacement) {
    if (!this.parentNode) return;
    const parent = this.parentNode;
    const index = parent.children.indexOf(this);
    if (replacement.parentNode) replacement.remove();
    parent.children[index] = replacement;
    replacement.parentNode = parent;
    this.parentNode = null;
  }
  replaceChildren(...children) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    children.forEach(child => this.appendChild(child));
  }
  remove() {
    if (!this.parentNode) return;
    const index = this.parentNode.children.indexOf(this);
    if (index >= 0) this.parentNode.children.splice(index, 1);
    this.parentNode = null;
  }
  querySelectorAll(selector) {
    const results = [];
    const visit = node => {
      for (const child of node.children || []) {
        if (matchesSelector(child, selector)) results.push(child);
        visit(child);
      }
    };
    visit(this);
    return results;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

class FakeDocument {
  constructor() { this.activeElement = null; }
  createElement(tagName) { return new FakeElement(tagName); }
  createDocumentFragment() { return new FakeElement('#fragment', 11); }
  createTextNode(text) { const node = new FakeElement('#text'); node.textContent = text; return node; }
  getElementById() { return null; }
}

function viewFixture() {
  const document = new FakeDocument();
  const messagesEl = document.createElement('div');
  const view = createHistoryView({
    document,
    messagesEl,
    safeMarkdown: { render: text => `<p>${String(text)}</p>` },
  });
  return { document, messagesEl, view };
}

function operation(kind, message) {
  return { kind, id: message.id, message };
}

function plan(messages, operations) {
  return {
    mode: 'reconcile',
    messages,
    operations,
    hasMore: false,
    streamingTail: null,
  };
}

function eventController(view, state = {}) {
  const liveUi = {
    pushDanmaku() {}, hideThinking() {}, showThinking() {},
    classifyDisplay() { return {}; }, renderAuxClassify() {},
  };
  const host = { debug() {}, applyHistoryPlan() {} };
  const historyStore = { acceptHistory(message) { return message; } };
  return createEventController({ state, host, liveUi, historyStore, historyView: view });
}

function loadComposer(window) {
  const context = vm.createContext({ window, console, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/chat-composer.js'), 'utf8'), context, {
    filename: 'chat-composer.js',
  });
  return window.MultiCCChatComposer;
}

function committedEvent(message) {
  const broadcasts = [];
  const records = new Map([['s1', []]]);
  const history = {
    read(sessionId) { return JSON.parse(JSON.stringify(records.get(sessionId) || [])); },
    write(sessionId, messages) { records.set(sessionId, JSON.parse(JSON.stringify(messages))); },
    deleteSession(sessionId) { return records.delete(sessionId); },
    hasPersistedDelivery(sessionId, deliveryId) {
      return (records.get(sessionId) || []).some(candidate =>
        candidate.clientMsgId === deliveryId || candidate.deliveryId === deliveryId);
    },
  };
  let sequence = 0;
  const runtime = createChatHistoryRuntime({
    history,
    persistedSessions: new Map([['s1', { id: 's1', kind: 'chat', cli: 'claude' }]]),
    chatSessions: new Map([['s1', {}]]),
    idFactory: () => `persisted-${++sequence}`,
    now: () => 123,
    chatBroadcast(_sessionId, event) { broadcasts.push(JSON.parse(JSON.stringify(event))); },
    distillHistoryIntoMemory() { return Promise.resolve(); },
    maybeSchedulePeriodicMemoryReview() {},
    async cliSwitchGitSnapshot() { return {}; },
    chatStream: { close() {} },
    clearAllNativeCliStates() { return 0; },
    buildHandoffCheckpoint() { return {}; },
    rememberActiveCliState() {},
    saveBestEffort() {},
    trackPendingMemoryDistill(_sessionId, promise) { return promise; },
    setImmediate() { return { unref() {} }; },
    setTimeout() { return { unref() {} }; },
    clearTimeout() {},
    logger: { warn() {} },
  });
  assert.equal(runtime.appendMessage('s1', { ...message }), true);
  assert.equal(broadcasts.length, 1);
  return broadcasts[0];
}

test('authoritative history order moves an existing assistant after an earlier missing user', () => {
  const { messagesEl, view } = viewFixture();
  const authoritative = [
    { id: 'u1', role: 'user', content: 'missing in this tab', ts: 100 },
    { id: 'a1', role: 'assistant', content: 'first answer', ts: 200 },
    { id: 'u2', role: 'user', content: 'already visible user', ts: 300 },
    { id: 'a2', role: 'assistant', content: 'second answer', ts: 400 },
  ];
  // This is the observed broken-window shape: assistant frames kept arriving,
  // while the earlier user message existed only in another browser window.
  for (const id of ['a1', 'a2', 'u2']) {
    messagesEl.appendChild(view.renderMessage(authoritative.find(message => message.id === id)));
  }

  view.applyPlan(plan(authoritative, authoritative.map(message =>
    operation(message.id === 'u1' ? 'append' : 'update', message))));

  assert.deepEqual(view.visibleIds(), authoritative.map(message => message.id));
});

test('updated keyed nodes move to authoritative positions without duplicate DOM ids', () => {
  const { messagesEl, view } = viewFixture();
  messagesEl.appendChild(view.renderMessage({ id: 'a2', role: 'assistant', content: 'stale assistant' }));
  messagesEl.appendChild(view.renderMessage({ id: 'u1', role: 'user', content: 'stale user' }));
  const authoritative = [
    { id: 'u1', role: 'user', content: 'fresh user', ts: 10 },
    { id: 'a2', role: 'assistant', content: 'fresh assistant', ts: 20 },
  ];

  view.applyPlan(plan(authoritative, authoritative.map(message => operation('update', message))));

  const ids = view.visibleIds();
  assert.deepEqual(ids, ['u1', 'a2']);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(messagesEl.querySelectorAll('.msg[data-msg-id]').length, 2);
  assert.equal(view.findById('u1').textContent, 'fresh user');
});

test('authoritative reorder preserves older history and non-message UI slots', () => {
  const { document, messagesEl, view } = viewFixture();
  const old = view.renderMessage({ id: 'old', role: 'user', content: 'older page' });
  const system = document.createElement('div');
  system.className = 'msg system-msg';
  system.textContent = 'reconnected';
  const loading = document.createElement('div');
  loading.className = 'msg system-msg history-loading-hint';
  loading.textContent = 'loading';
  const a2 = view.renderMessage({ id: 'a2', role: 'assistant', content: 'answer' });
  const u1 = view.renderMessage({ id: 'u1', role: 'user', content: 'question' });
  messagesEl.append(old, system, a2, loading, u1);

  const authoritative = [
    { id: 'u1', role: 'user', content: 'question' },
    { id: 'a2', role: 'assistant', content: 'answer' },
  ];
  view.applyPlan(plan(authoritative, authoritative.map(message => operation('update', message))));

  assert.deepEqual(messagesEl.children.map(node => node.dataset.msgId || node.textContent), [
    'old', 'reconnected', 'u1', 'loading', 'a2',
  ]);
});

test('an id-less streaming tail remains after newly recovered persisted messages', () => {
  const { messagesEl, view } = viewFixture();
  messagesEl.appendChild(view.renderMessage({ id: 'a1', role: 'assistant', content: 'older answer' }));
  const tail = view.createAssistantBubble(true);
  const authoritative = [
    { id: 'a1', role: 'assistant', content: 'older answer' },
    { id: 'u2', role: 'user', content: 'missing user' },
    { role: 'assistant', content: 'streaming answer', streaming: true },
  ];
  const result = view.applyPlan({
    ...plan(authoritative, [
      operation('update', authoritative[0]),
      operation('append', authoritative[1]),
      { kind: 'stream-tail', id: null, message: authoritative[2] },
    ]),
    streamingTail: { id: null, content: 'streaming answer' },
  }, { currentElement: tail });

  assert.deepEqual(messagesEl.children.map(node => node.dataset.msgId || node.className), [
    'a1', 'u2', 'msg assistant',
  ]);
  assert.equal(result.streamingTail.element, messagesEl.children[2]);
});

test('authoritative reconciliation removes stale duplicate DOM ids', () => {
  const { messagesEl, view } = viewFixture();
  messagesEl.appendChild(view.renderMessage({ id: 'u1', role: 'user', content: 'stale one' }));
  messagesEl.appendChild(view.renderMessage({ id: 'u1', role: 'user', content: 'stale duplicate' }));
  const authoritative = [{ id: 'u1', role: 'user', content: 'canonical' }];

  view.applyPlan(plan(authoritative, [operation('update', authoritative[0])]));

  assert.deepEqual(view.visibleIds(), ['u1']);
  assert.equal(messagesEl.children[0].textContent, 'canonical');
});

test('a full chat_msg_meta creates the committed user bubble in another window', () => {
  const { messagesEl, view } = viewFixture();
  const controller = eventController(view, { currentMsgEl: null, lastUserBubble: null });
  const generation = controller.beginGeneration();
  const event = committedEvent({
    role: 'user',
    content: 'sent from the other window',
    clientMsgId: 'client-tab-a',
    ts: 123,
    deliveryId: 'private-delivery-id',
    originDispatchId: 'private-dispatch-id',
    token: 'private-token',
  });

  assert.equal(event.type, 'chat_msg_meta');
  assert.equal(event.message.clientMsgId, 'client-tab-a');
  for (const privateField of ['deliveryId', 'originDispatchId', 'token']) {
    assert.equal(Object.hasOwn(event.message, privateField), false,
      `committed user DTO must omit ${privateField}`);
  }
  controller.handleEvent(event, generation);

  assert.deepEqual(view.visibleIds(), [event.message.id]);
  assert.equal(messagesEl.children[0].textContent, 'sent from the other window');

  const assistantEvent = committedEvent({
    role: 'assistant', content: 'not duplicated through metadata', ts: 124,
    token: 'private-assistant-token',
  });
  assert.equal(Object.hasOwn(assistantEvent, 'message'), false,
    'assistant frames keep the legacy metadata-only event');
});

test('clientMsgId binds the acknowledgement to its optimistic bubble, never the latest same-role bubble', () => {
  const { document, messagesEl, view } = viewFixture();
  const sent = [];
  const optimistic = [];
  const input = { value: 'same role first', style: {}, scrollHeight: 20 };
  const window = {
    document,
    navigator: { userAgent: 'test' },
    location: { protocol: 'http:', host: 'localhost:3000' },
    setTimeout,
    clearTimeout,
  };
  const composer = loadComposer(window).createComposer({
    window,
    document,
    navigator: window.navigator,
    location: window.location,
    autoBind: false,
    elements: { input },
    isSocketOpen: () => true,
    transportSend(payload) { sent.push(payload); return true; },
    addUserMessage(text, clientMsgId) {
      const node = document.createElement('div');
      node.className = 'msg user';
      node.textContent = text;
      node.dataset.clientMsgId = clientMsgId;
      messagesEl.appendChild(node);
      optimistic.push(node);
    },
  });

  assert.equal(composer.send(), true);
  input.value = 'same role second';
  assert.equal(composer.send(), true);
  assert.equal(sent.length, 2);
  assert.equal(optimistic[0].dataset.clientMsgId, sent[0].clientMsgId);
  assert.equal(optimistic[1].dataset.clientMsgId, sent[1].clientMsgId);
  assert.notEqual(sent[0].clientMsgId, sent[1].clientMsgId);

  const controller = eventController(view, { currentMsgEl: null, lastUserBubble: optimistic[1] });
  const generation = controller.beginGeneration();
  controller.handleEvent({
    type: 'chat_msg_meta',
    id: 'persisted-first',
    role: 'user',
    clientMsgId: sent[0].clientMsgId,
  }, generation);

  assert.equal(optimistic[0].dataset.msgId, 'persisted-first');
  assert.equal(optimistic[1].dataset.msgId, undefined);
});
