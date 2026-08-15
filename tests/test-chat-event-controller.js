'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const liveUiApi = require('../public/chat-live-ui');
require('../public/chat-rate-limit'); // registers global.MultiCCChatRateLimit for the rate_limit_event case
require('../public/chat-session-queue');
const userInputCardApi = require('../public/chat-user-input-card');
const eventApi = require('../public/chat-event-controller');

const ROOT = path.join(__dirname, '..');

function classList() {
  const values = new Set();
  return {
    add(...names) { names.forEach(name => values.add(name)); },
    remove(...names) { names.forEach(name => values.delete(name)); },
    contains(name) { return values.has(name); },
    toggle(name, force) {
      if (force === true) values.add(name);
      else if (force === false) values.delete(name);
      else if (values.has(name)) values.delete(name);
      else values.add(name);
    },
  };
}

class FakeElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.className = '';
    this.classList = classList();
    this.style = {};
    this.textContent = '';
    this.dataset = {};
    this.parentNode = null;
  }

  append(...children) { children.forEach(child => this.appendChild(child)); }
  replaceChildren(...children) {
    this.children.forEach(child => { child.parentNode = null; });
    this.children = [];
    this.append(...children);
  }
  appendChild(child) {
    if (child == null) return child;
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  prepend(child) { child.parentNode = this; this.children.unshift(child); }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = null;
  }
  addEventListener(type, handler) {
    if (type === 'click') (this._onClick = this._onClick || []).push(handler);
  }
  click() { for (const fn of this._onClick || []) fn({ stopPropagation() {} }); }
  focus() {}
  select() {}
  querySelector(selector) {
    const className = selector.startsWith('.') ? selector.slice(1) : null;
    if (!className) return null;
    return this.walk().find(element => String(element.className || '').split(/\s+/).includes(className)) || null;
  }
  querySelectorAll(selector) {
    const className = selector.startsWith('.') ? selector.slice(1) : null;
    return className
      ? this.walk().filter(element => String(element.className || '').split(/\s+/).includes(className))
      : [];
  }
  walk() { return this.children.flatMap(child => [child, ...(child.walk ? child.walk() : [])]); }
}

function fakeDocument() {
  const ids = new Map();
  const document = {
    title: 'MultiCC Chat',
    body: new FakeElement('body'),
    createElement: tag => new FakeElement(tag),
    createTextNode(text) { const node = new FakeElement('#text'); node.textContent = text; return node; },
    getElementById: id => ids.get(id) || null,
    addEventListener() {},
    removeEventListener() {},
  };
  return { document, ids };
}

function controllerFixture() {
  const { document } = fakeDocument();
  const messages = new FakeElement('div');
  const rawLiveUi = liveUiApi.createLiveUi({
    document,
    messagesEl: messages,
    translate: key => key,
    maybeScrollToBottom() {},
    retryTransport() {},
    isRestarting: () => false,
    debug() {},
  });
  const progressCalls = [];
  const liveUi = {
    ...rawLiveUi,
    pushDanmaku: (...args) => progressCalls.push(args),
  };
  const calls = [];
  const debugCalls = [];
  let pendingInputId = null;
  const content = new FakeElement('div');
  content.className = 'msg-content';
  const bubble = new FakeElement('div');
  bubble.appendChild(content);
  const tools = [];
  const historyView = {
    createAssistantBubble() { calls.push('create-bubble'); return bubble; },
    createToolCard(name, id) { return { name, id }; },
    appendToolCard(_content, card) { tools.push(card); },
    updateToolInput(tool) { calls.push(['tool-input', tool.inputJson]); },
    addToolResult(tool, text, error) { calls.push(['tool-result', tool.id, text, !!error]); },
    tagLatestMessage(role, id) { calls.push(['tag', role, id]); },
    visibleIds() { return []; },
    clearMessages() { calls.push('clear'); },
  };
  const historyStore = {
    acceptHistory(message) { calls.push(['history', message.messages?.length || 0]); return { message }; },
  };
  const state = {
    sessionId: null,
    pendingCancel: false,
    isStreaming: false,
    sessionEffort: '',
    sessionEffectiveEffort: '',
    sessionProvider: '',
    sessionProviderDisplayName: '',
    sessionCliStates: {},
    cliAvailability: {},
    sessionAgent: '',
    pendingCliHandoff: null,
    sessionEffectiveModel: '',
    sessionModel: '',
    providerId: null,
    providerName: null,
    providerTokenWindows: null,
    claudeFiveHourRateLimit: null,
    roleTokens: { main: null, sub: null, subByProvider: [] },
    currentMsgEl: null,
    currentTextContent: '',
    currentToolCards: new Map(),
    activeContentType: null,
    activeContentIndex: -1,
    currentCli: 'claude',
    liveStreamUsage: null,
    turnStartMs: 0,
    turnMeta: null,
    sessionTokens: { input: 0, output: 0 },
    lastUserBubble: null,
    lastInitInfoLine: '',
  };
  const host = {
    debug(...args) { debugCalls.push(args); },
    warn(...args) { calls.push(['warn', ...args]); },
    translate: (key, params) => `${key}:${JSON.stringify(params || {})}`,
    getSessionName: () => 'session-1',
    refreshNotifyPreference() { calls.push('notify-pref'); },
    updateTabIdentity() {},
    updateCwdDisplay(value) { calls.push(['cwd', value]); },
    applyCliUi(value) { state.currentCli = value; calls.push(['cli', value]); },
    addSystemMsg(value) { calls.push(['system', value]); },
    addAgentNotes(value) { calls.push(['notes', value.length]); },
    updateEffortBtn() {},
    updateModelBtn() {},
    transportSend(value) { calls.push(['send', value]); return true; },
    startTitleAnimation() { calls.push('title-start'); },
    stopTitleAnimation() { calls.push('title-stop'); },
    updateUI() { calls.push('ui'); },
    loadSessionModel() {},
    applyCliSwitchState() {},
    cliMeta: { claude: { label: 'Claude' }, codex: { label: 'Codex' } },
    updateContextBar() { calls.push('context'); },
    autoCommitIfNeeded() {},
    resetHistoryPagination() {},
    applyHistoryPlan() {},
    removeHistoryMessageById() {},
    showNotifyToast(...args) { calls.push(['toast', ...args]); },
    speakNotify() {},
    maybeScrollToBottom() {},
    renderCurrentText() { calls.push(['render', state.currentTextContent]); },
    renderSessionQueue(items, metadata) {
      calls.push(['queue', items.map(item => item.text), metadata]);
    },
    renderPendingUserInput(message) {
      calls.push(['pending-input', message]);
      return true;
    },
    consumeUserInputRequestId(requestId) { calls.push(['consume-input', requestId]); },
    getUserInputRequestId: () => pendingInputId,
    rearmUnread() {},
  };
  const controller = eventApi.createEventController({ state, host, liveUi, historyStore, historyView });
  return {
    controller, state, calls, debugCalls, progressCalls, tools, bubble, content, liveUi,
    setPendingInputId(value) { pendingInputId = value; },
  };
}

test('event module exports a frozen narrow API and codex reconnect classifier', () => {
  assert.equal(Object.isFrozen(eventApi), true);
  assert.equal(eventApi.isRecoverableCodexReconnectErrorText(
    'Codex 出错：Reconnecting... 1/5 (stream disconnected before completion)',
  ), true);
  assert.equal(eventApi.isRecoverableCodexReconnectErrorText('permission denied'), false);
});

test('progress heartbeat formatter exposes only safe bounded status fields', () => {
  assert.equal(eventApi.formatProgressHeartbeat({
    phase: 'tool', elapsedMs: 150_900, toolKind: 'subagent',
    prompt: 'secret prompt', output: 'secret output', token: 'sk-secret',
  }), '正在调用工具 · 2m 30s · 子 Agent');
  assert.equal(eventApi.formatProgressHeartbeat({ phase: 'unknown', elapsedMs: -1 }), '仍在执行 · 0s');
});

test('turn and monitor progress update stable rows and terminal events close the turn row', () => {
  const fixture = controllerFixture();
  const generation = fixture.controller.beginGeneration();
  fixture.controller.handleEvent({
    type: 'progress_heartbeat', turnId: 'turn-1', phase: 'tool', elapsedMs: 31_000, toolKind: 'process',
  }, generation);
  fixture.controller.handleEvent({
    type: 'progress_heartbeat', turnId: 'turn-1', phase: 'thinking', elapsedMs: 61_000,
  }, generation);
  fixture.controller.handleEvent({
    type: 'monitor_progress', task_id: 'task-1', description: '后台测试仍在执行', background: true,
  }, generation);
  fixture.controller.handleEvent({ type: 'result' }, generation);
  assert.deepEqual(fixture.progressCalls, [
    ['progress', '正在调用工具 · 31s · 命令执行', 'turn:turn-1'],
    ['progress', '正在处理 · 1m 1s', 'turn:turn-1'],
    ['progress', '后台测试仍在执行', 'task-1'],
    ['done', '本轮已完成', 'turn:turn-1'],
  ]);
});

test('interrupted monitor_done (incl. post-restart journal replay) renders stale, not done', () => {
  const fixture = controllerFixture();
  const generation = fixture.controller.beginGeneration();
  fixture.controller.handleEvent({
    type: 'monitor_done', task_id: 'task-r', status: 'interrupted',
    summary: '重启前运行中 · 已随服务重启中断：子任务 B', background: true, replayed: true,
  }, generation);
  fixture.controller.handleEvent({
    type: 'monitor_done', task_id: 'task-f', status: 'failed', summary: 'x', background: true,
  }, generation);
  fixture.controller.handleEvent({
    type: 'monitor_done', task_id: 'task-ok', status: 'completed', summary: 'y', background: true,
  }, generation);
  assert.deepEqual(fixture.progressCalls, [
    ['stale', '重启前运行中 · 已随服务重启中断：子任务 B', 'task-r'],
    ['fail', 'x', 'task-f'],
    ['done', 'y', 'task-ok'],
  ]);
});

test('connection generation rejects stale late events before any host mutation', () => {
  const fixture = controllerFixture();
  assert.equal(fixture.controller.handleEvent({ type: 'system', message: 'missing-generation' }), false);
  assert.equal(fixture.calls.length, 0);
  assert.equal(fixture.debugCalls.length, 0);
  const old = fixture.controller.beginGeneration();
  fixture.controller.invalidateGeneration();
  assert.equal(fixture.controller.handleEvent({ type: 'system', message: 'stale' }, old), false);
  assert.equal(fixture.calls.length, 0);
  const current = fixture.controller.beginGeneration();
  assert.equal(fixture.controller.handleEvent({ type: 'system', message: 'fresh' }, current), true);
  assert.deepEqual(fixture.calls, [['system', 'fresh']]);
});

test('only server init synchronizes streaming state and pending cancel ownership', () => {
  const fixture = controllerFixture();
  const generation = fixture.controller.beginGeneration();
  fixture.controller.handleEvent({ type: 'system', subtype: 'init', session_id: 'cli-only' }, generation);
  assert.equal(fixture.state.sessionId, null);
  fixture.state.pendingCancel = true;
  fixture.controller.handleEvent({
    type: 'system', subtype: 'init', session_id: 'server', cli: 'claude', cwd: '/tmp/project',
    is_streaming: true, providerId: 'p1', providerName: 'Provider', providerTokenWindows: { today: 1 },
  }, generation);
  assert.equal(fixture.state.sessionId, 'server');
  assert.equal(fixture.state.pendingCancel, false);
  assert.deepEqual(fixture.calls.find(call => Array.isArray(call) && call[0] === 'send'), ['send', { type: 'cancel' }]);
  assert.equal(fixture.state.providerTokenWindows.today, 1);
});

test('user_input_resolved tears down the wait_user prompt in every window', () => {
  const fixture = controllerFixture();
  const generation = fixture.controller.beginGeneration();
  fixture.controller.handleEvent({
    type: 'user_input_required', requestId: 'usrq-1', question: '发布？', options: ['是', '否'],
  }, generation);
  assert.equal(fixture.state.pendingUserInputRequestId, 'usrq-1');

  // Another window consumed the prompt: the resolved broadcast must reach every
  // window and clear the card.
  fixture.controller.handleEvent({ type: 'user_input_resolved', requestId: 'usrq-1' }, generation);
  assert.deepEqual(fixture.calls.at(-1), ['consume-input', 'usrq-1']);
  // Idempotent: a late/duplicate resolved is still forwarded (the host's
  // consumeUserInputRequestId is itself idempotent, so this is a safe replay).
  fixture.controller.handleEvent({ type: 'user_input_resolved', requestId: 'usrq-1' }, generation);
  assert.equal(
    fixture.calls.filter(c => Array.isArray(c) && c[0] === 'consume-input').length,
    2,
  );
});

test('chat_msg_meta carrying answeredQuestionId tears down the wait_user card from the message itself', () => {
  const fixture = controllerFixture();
  const generation = fixture.controller.beginGeneration();
  fixture.controller.handleEvent({
    type: 'user_input_required', requestId: 'usrq-7', question: '部署？', options: ['是', '否'],
  }, generation);
  assert.equal(fixture.state.pendingUserInputRequestId, 'usrq-7');

  // The answering user message is broadcast with answeredQuestionId metadata.
  // A window that missed the fire-and-forget user_input_resolved event still
  // tears the card down when the committed answer message reaches it.
  fixture.controller.handleEvent({
    type: 'chat_msg_meta',
    id: 'msg-1', role: 'user', ts: 1234, clientMsgId: 'c1',
    message: {
      id: 'msg-1', role: 'user', content: '是', ts: 1234,
      clientMsgId: 'c1', answeredQuestionId: 'usrq-7',
    },
  }, generation);
  assert.deepEqual(
    fixture.calls.filter(call => Array.isArray(call) && call[0] === 'consume-input').at(-1),
    ['consume-input', 'usrq-7'],
  );
});

test('chat_msg_meta without answeredQuestionId leaves the wait_user card untouched', () => {
  const fixture = controllerFixture();
  const generation = fixture.controller.beginGeneration();
  fixture.controller.handleEvent({
    type: 'user_input_required', requestId: 'usrq-8', question: '继续？', options: ['ok'],
  }, generation);
  const before = fixture.calls
    .filter(call => Array.isArray(call) && call[0] === 'consume-input').length;
  fixture.controller.handleEvent({
    type: 'chat_msg_meta',
    id: 'msg-2', role: 'user', ts: 1234,
    message: { id: 'msg-2', role: 'user', content: '普通消息', ts: 1234 },
  }, generation);
  const after = fixture.calls
    .filter(call => Array.isArray(call) && call[0] === 'consume-input').length;
  assert.equal(after, before);
});

test('structured user-input and FIFO events expose correlation and honest frozen state', () => {
  const fixture = controllerFixture();
  const generation = fixture.controller.beginGeneration();
  fixture.controller.handleEvent({
    type: 'user_input_required',
    requestId: 'usrq-1',
    question: '<img src=x onerror=alert(1)> 是否继续？',
    options: ['继续', '取消'],
  }, generation);
  assert.equal(fixture.state.pendingUserInputRequestId, 'usrq-1');
  assert.deepEqual(fixture.calls.at(-1), [
    'pending-input',
    {
      type: 'user_input_required',
      requestId: 'usrq-1',
      question: '<img src=x onerror=alert(1)> 是否继续？',
      options: ['继续', '取消'],
    },
  ]);

  fixture.controller.handleEvent({
    type: 'session_queue',
    event: 'frozen',
    state: 'frozen',
    freezeReason: 'awaiting_user_input',
    items: [{ position: 1, text: '<img src=x onerror=alert(2)>' }],
  }, generation);
  fixture.controller.handleEvent({
    type: 'session_queue',
    event: 'queued',
    queuePosition: 2,
    state: 'running',
    items: [{ position: 1, text: '<b>literal staged body</b>' }],
  }, generation);
  fixture.controller.handleEvent({
    type: 'session_queue',
    event: 'queued',
    queued: false,
    entryId: 'immediate',
    queuePosition: 1,
    state: 'frozen',
    freezeReason: 'classify_error',
    items: [
      { entryId: 'older-staged', text: 'older staged' },
      { entryId: 'immediate', text: 'must never flash' },
    ],
  }, generation);
  fixture.controller.handleEvent({
    type: 'session_queue',
    event: 'snapshot',
    state: 'frozen',
    freezeReason: 'classify_error',
    items: [],
  }, generation);
  assert.deepEqual(
    fixture.calls.filter(call => Array.isArray(call) && call[0] === 'queue'),
    [
      ['queue', ['<img src=x onerror=alert(2)>'], {
        state: 'frozen', freezeReason: 'awaiting_user_input',
      }],
      ['queue', ['<b>literal staged body</b>'], {
        state: 'running', freezeReason: null,
      }],
      ['queue', ['older staged'], {
        state: 'frozen', freezeReason: 'classify_error',
      }],
      ['queue', [], {
        state: 'frozen', freezeReason: 'classify_error',
      }],
    ],
  );
  assert.ok(fixture.calls.some(call => Array.isArray(call)
    && call[0] === 'system' && call[1] === '队列已冻结：awaiting_user_input'));
  assert.ok(fixture.calls.some(call => Array.isArray(call)
    && call[0] === 'toast' && call[1] === '消息已排队（第 2 位）'));
  assert.equal(fixture.calls.filter(call => Array.isArray(call)
    && call[0] === 'toast' && call[1].startsWith('消息已')).length, 1);
  assert.equal(fixture.calls.some(call => Array.isArray(call)
    && call[0] === 'system' && call[1].startsWith('队列保持冻结')), false);
});

test('structured answer card is above messages and never overlays the composer', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'chat.html'), 'utf8');
  const card = html.indexOf('id="pending-user-input-card"');
  const messages = html.indexOf('id="messages"');
  const composer = html.indexOf('id="input-bar"');
  assert.ok(card >= 0 && card < messages && messages < composer);
  assert.match(
    html,
    /#pending-user-input-card\s*\{[^}]*max-height:[^}]*overflow:\s*auto/s,
  );
  const styles = html.slice(
    html.indexOf('#pending-user-input-card'),
    html.indexOf('/* Fixed overlay'),
  );
  assert.doesNotMatch(styles, /position:\s*fixed/);
});

test('structured answer card submits selected and free-text values without HTML rendering', () => {
  const { document } = fakeDocument();
  const elements = {
    root: new FakeElement('section'),
    question: new FakeElement('div'),
    reason: new FakeElement('div'),
    options: new FakeElement('div'),
    textInput: new FakeElement('textarea'),
    submitButton: new FakeElement('button'),
  };
  const answers = [];
  const card = userInputCardApi.createController({
    document,
    elements,
    isConnected: () => true,
    submitAnswer: (answer, requestId) => {
      answers.push([answer, requestId]);
      return true;
    },
  });
  assert.equal(card.render({
    requestId: 'usrq-1',
    question: '<img src=x onerror=alert(1)>',
    reason: '<b>literal reason</b>',
    options: ['模型', '队列'],
    allowMultiple: true,
  }), true);
  assert.equal(elements.root.hidden, false);
  assert.equal(elements.question.textContent, '<img src=x onerror=alert(1)>');
  assert.equal(elements.reason.textContent, '<b>literal reason</b>');

  const checkboxes = elements.options.walk().filter(node => node.tagName === 'INPUT');
  checkboxes[1].checked = true;
  elements.textInput.value = '补充说明';
  elements.submitButton.click();
  assert.deepEqual(answers, [['队列, 补充说明', 'usrq-1']]);
  assert.equal(elements.root.hidden, true);
});

test('structured answer card option click submits the correlated request directly', () => {
  const { document } = fakeDocument();
  const elements = {
    root: new FakeElement('section'),
    question: new FakeElement('div'),
    reason: new FakeElement('div'),
    options: new FakeElement('div'),
    textInput: new FakeElement('textarea'),
    submitButton: new FakeElement('button'),
  };
  const answers = [];
  const card = userInputCardApi.createController({
    document,
    elements,
    isConnected: () => true,
    submitAnswer: (answer, requestId) => {
      answers.push([answer, requestId]);
      return true;
    },
  });
  card.render({
    requestId: 'usrq-option',
    question: '请选择环境',
    options: ['测试环境', '生产环境'],
  });
  elements.options.children[1].click();
  assert.deepEqual(answers, [['生产环境', 'usrq-option']]);
  assert.equal(elements.root.hidden, true);
});

test('Flutter keeps the pending answer card above the message lane, not in the bottom input bar', () => {
  const screen = fs.readFileSync(
    path.join(ROOT, 'app', 'lib', 'screens', 'chat_screen.dart'),
    'utf8',
  );
  const inputBar = fs.readFileSync(
    path.join(ROOT, 'app', 'lib', 'widgets', 'input_bar.dart'),
    'utf8',
  );
  // The expanded card guards on !collapsed (a collapsed turn renders the
  // floating-ball variant instead); either way it must precede the lane.
  const pending = screen.indexOf('if (provider.pendingUserInput != null &&');
  const messages = screen.indexOf('child: _MessageList(');
  assert.ok(pending >= 0 && pending < messages);
  assert.match(screen, /maxHeight:\s*MediaQuery\.sizeOf\(context\)\.height \* 0\.38/);
  assert.doesNotMatch(inputBar, /PendingUserInputPanel\s*\(/);
});

test('staged-message dock renders canonical text with textContent only', () => {
  const { document, ids } = fakeDocument();
  const dock = new FakeElement('details');
  const count = new FakeElement('strong');
  const hint = new FakeElement('span');
  const list = new FakeElement('div');
  ids.set('session-queue-dock', dock);
  ids.set('session-queue-count', count);
  ids.set('session-queue-hint', hint);
  ids.set('session-queue-list', list);
  global.MultiCCChatSessionQueue.render([
    { position: 1, text: '<img src=x onerror=alert(1)>\n真实正文' },
  ], { state: 'running' }, document);
  assert.equal(dock.hidden, false);
  assert.equal(count.textContent, '1');
  assert.equal(list.children[0].children[1].textContent,
    '<img src=x onerror=alert(1)>\n真实正文');
  assert.equal(list.children[0].children.length, 2);
});

test('staged-message dock exposes close icon and immediate insert only for pending entries', async () => {
  const { document, ids } = fakeDocument();
  const dock = new FakeElement('details');
  const count = new FakeElement('strong');
  const hint = new FakeElement('span');
  const list = new FakeElement('div');
  ids.set('session-queue-dock', dock);
  ids.set('session-queue-count', count);
  ids.set('session-queue-hint', hint);
  ids.set('session-queue-list', list);
  const cancelled = [];
  const inserted = [];
  global.MultiCCChatSessionQueue.render([
    { entryId: 'pending-1', position: 1, state: 'pending', text: '可以移除' },
    { entryId: 'leased-2', position: 2, state: 'leased', text: '已经领取' },
  ], {
    state: 'frozen',
    freezeReason: 'awaiting_user_input',
    async onCancel(entryId) { cancelled.push(entryId); },
    async onInsert(entryId) { inserted.push(entryId); },
  }, document);

  // ⏸️ = canonical `waiting` glyph: awaiting_user_input is a pause, not a fault.
  assert.equal(hint.textContent, '⏸️ 已暂停：awaiting_user_input');
  assert.equal(list.children[0].children.length, 3);
  assert.equal(list.children[1].children.length, 2);
  const actions = list.children[0].children[2];
  assert.equal(actions.children.length, 2);
  const insert = actions.children[0];
  const close = actions.children[1];
  assert.equal(insert.textContent, '立刻插入');
  assert.equal(close.textContent, '×');
  await insert._onClick[0]({ stopPropagation() {} });
  assert.deepEqual(inserted, ['pending-1']);
  assert.equal(insert.disabled, true);
  assert.equal(insert.textContent, '插入中…');
  await close._onClick[0]({ stopPropagation() {} });
  assert.deepEqual(cancelled, ['pending-1']);
  assert.equal(close.disabled, true);
  assert.equal(close.textContent, '…');
});

test('queue cancellation handler sends the confirmed entry-scoped action', async () => {
  const requests = [];
  const notices = [];
  const handler = global.MultiCCChatSessionQueue.createCancelHandler({
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
    withToken: url => `/tokenized${url}`,
    getSessionName: () => 'session/1',
    notify: (...args) => notices.push(args),
  });
  await handler('entry-1');
  assert.equal(requests[0].url, '/tokenized/api/sessions/session%2F1/queue/action');
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    action: 'cancel_queued',
    entryId: 'entry-1',
    confirm: true,
    reason: 'removed from chat queue',
  });
  assert.deepEqual(notices, [['已移除暂存消息', 'completed']]);
});

test('queue immediate insert handler executes the selected entry now', async () => {
  const requests = [];
  const notices = [];
  const handler = global.MultiCCChatSessionQueue.createInsertHandler({
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
    withToken: url => `/tokenized${url}`,
    getSessionName: () => 'session/1',
    notify: (...args) => notices.push(args),
  });
  await handler('entry-2');
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    action: 'insert_queued',
    entryId: 'entry-2',
    confirm: true,
  });
  assert.deepEqual(notices, [['已停止当前回复并直接执行所选消息', 'completed']]);
});

test('rate_limit_event forwards the server bar to the quota module and stores {provider, bar}', () => {
  const fixture = controllerFixture();
  const generation = fixture.controller.beginGeneration();
  // The bar is rendered server-side; the controller only forwards it together
  // with the raw rate_limit_info (used for gating/timing). Billing-sensitive
  // fields live only in rate_limit_info and are never retained on state — the
  // server's renderer is what strips them before they reach a `bar`.
  const bar = { kind: 'claude', text: '5h 28% 1h · 1wk - · ⟳ 刷新', color: '#d29922', title: '', action: null };
  fixture.controller.handleEvent({
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'allowed_warning', rateLimitType: 'five_hour',
      utilization: 0.72, resetsAt: Math.floor(Date.now() / 1000) + 60,
      overageDisabledReason: 'out_of_credits',
    },
    bar,
  }, generation);
  assert.deepEqual(fixture.state.claudeFiveHourRateLimit, { provider: 'claude', bar });
  // No billing fields leak onto the stored state object.
  assert.equal(JSON.stringify(fixture.state.claudeFiveHourRateLimit).includes('overageDisabledReason'), false);
});

test('api_error_policy renders into the api-error bar and clears on the next stream', () => {
  // The bar element lives in chat.html; inject it into a fake document so the
  // liveUi module can find it by id, then drive both render and clear paths.
  const { document: doc, ids } = fakeDocument();
  const bar = new FakeElement('div');
  ids.set('api-error-bar', bar);
  const liveUi = liveUiApi.createLiveUi({
    document: doc,
    messagesEl: new FakeElement('div'),
    translate: key => key,
    maybeScrollToBottom() {},
    debug() {},
  });
  liveUi.renderApiError({
    state: 'retry_wait',
    provider: 'claude',
    category: 'rate_limit',
    httpStatus: 429,
    message: '上游 429，已排队重试',
    action: 'retry',
  });
  assert.equal(bar.style.display, '');
  assert.equal(bar.textContent, 'API claude · rate_limit · HTTP 429 · 上游 429，已排队重试');
  liveUi.clearApiError();
  assert.equal(bar.style.display, 'none');
});

test('Claude stream reuses one bubble and binds tool input/result without HTML interpretation', () => {
  const fixture = controllerFixture();
  const generation = fixture.controller.beginGeneration();
  fixture.controller.handleEvent({ type: 'stream_event', event: {
    type: 'message_start', message: { usage: { input_tokens: 12, cache_read_input_tokens: 3 } },
  } }, generation);
  fixture.controller.handleEvent({ type: 'stream_event', event: {
    type: 'content_block_start', index: 0, content_block: { type: 'text' },
  } }, generation);
  fixture.controller.handleEvent({ type: 'stream_event', event: {
    type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '<b>literal</b>' },
  } }, generation);
  fixture.controller.handleEvent({
    type: 'part_delta', delta: { type: 'text', text: '<b>literal</b>' },
  }, generation);
  fixture.controller.handleEvent({ type: 'stream_event', event: {
    type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool-1', name: 'Read' },
  } }, generation);
  fixture.controller.handleEvent({ type: 'stream_event', event: {
    type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"x"}' },
  } }, generation);
  fixture.controller.handleEvent({
    type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: '<img onerror=boom>' }] },
  }, generation);
  assert.equal(fixture.calls.filter(call => call === 'create-bubble').length, 1);
  assert.equal(fixture.state.currentTextContent, '<b>literal</b>',
    'Claude must consume native stream-json once and ignore the duplicate proxy sidecar');
  assert.deepEqual(fixture.calls.find(call => Array.isArray(call) && call[0] === 'tool-result'),
    ['tool-result', 'tool-1', '<img onerror=boom>', false]);
  assert.equal(fixture.state.liveStreamUsage.inputTokens, 12);
  assert.equal(fixture.state.liveStreamUsage.cacheRead, 3);
});

test('Codex still consumes proxy text deltas for token-level rendering', () => {
  const fixture = controllerFixture();
  fixture.state.currentCli = 'codex';
  const generation = fixture.controller.beginGeneration();
  fixture.controller.handleEvent({
    type: 'part_delta', delta: { type: 'text', text: 'token' },
  }, generation);
  assert.equal(fixture.state.currentTextContent, 'token');
  assert.equal(fixture.calls.filter(call => call === 'create-bubble').length, 1);
});

test('Codex assistant path appends text and materializes tool cards without Claude stream events', () => {
  const fixture = controllerFixture();
  fixture.state.currentCli = 'codex';
  const generation = fixture.controller.beginGeneration();
  fixture.controller.handleEvent({ type: 'assistant', message: { content: [
    { type: 'text', text: 'done' },
    { type: 'tool_use', id: 'codex-tool', name: 'shell', input: { cmd: 'pwd' } },
  ] } }, generation);
  assert.equal(fixture.state.currentTextContent, 'done');
  assert.equal(fixture.tools.length, 1);
  assert.equal(fixture.state.currentToolCards.get('id:codex-tool').inputJson, '{"cmd":"pwd"}');
  // Timing parity with the claude path: codex tools skip content_block_start,
  // so their creation site must stamp startedAt and tool_result stamps endedAt
  // — otherwise live codex tool durations are unknown until history reload.
  const t0 = fixture.state.currentToolCards.get('id:codex-tool').startedAt;
  assert.ok(Number.isFinite(t0), 'codex tool creation stamps startedAt');
  fixture.controller.handleEvent({
    type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'codex-tool', content: 'ok' }] },
  }, generation);
  const tool = fixture.state.currentToolCards.get('id:codex-tool');
  assert.ok(Number.isFinite(tool.endedAt) && tool.endedAt >= t0, 'tool_result stamps endedAt');
  assert.equal(tool.isError, false);
});

test('OpenCode cumulative assistant snapshots render every text part without a refresh', () => {
  const fixture = controllerFixture();
  fixture.state.currentCli = 'opencode';
  const generation = fixture.controller.beginGeneration();
  fixture.controller.handleEvent({
    type: 'assistant',
    message: { textSnapshot: true, content: [{ type: 'text', text: 'first' }] },
  }, generation);
  fixture.controller.handleEvent({
    type: 'assistant',
    message: { textSnapshot: true, content: [{ type: 'text', text: 'first\n\nsecond' }] },
  }, generation);
  assert.equal(fixture.state.currentTextContent, 'first\n\nsecond');
  assert.equal(fixture.calls.filter(call => call === 'create-bubble').length, 1);
});

test('authoritative assistant snapshot reconciles a partial proxy preview', () => {
  const fixture = controllerFixture();
  fixture.state.currentCli = 'opencode';
  const generation = fixture.controller.beginGeneration();
  fixture.controller.handleEvent({
    type: 'part_delta', delta: { type: 'text', text: 'partial' },
  }, generation);
  fixture.controller.handleEvent({
    type: 'assistant',
    message: { textSnapshot: true, content: [{ type: 'text', text: 'complete answer' }] },
  }, generation);
  assert.equal(fixture.state.currentTextContent, 'complete answer');
});

test('Flutter forwards and reconciles non-Claude assistant snapshots too', () => {
  const service = fs.readFileSync(
    path.join(ROOT, 'app', 'lib', 'services', 'chat_service.dart'), 'utf8');
  const provider = fs.readFileSync(
    path.join(ROOT, 'app', 'lib', 'providers', 'chat_provider.dart'), 'utf8');
  assert.match(service, /case 'assistant':[\s\S]{0,240}_emit\('assistant'/);
  assert.match(service, /case 'part_delta':[\s\S]{0,100}_emit\('part_delta'/);
  assert.match(provider, /case 'assistant':[\s\S]{0,120}_onAssistantSnapshot/);
  assert.match(provider, /message\['textSnapshot'\] == true[\s\S]{0,100}_currentMsg!\.content = text/);
  assert.match(provider, /void _onPartDelta[\s\S]{0,180}SessionCli\.claude/);
});

test('recoverable reconnect errors stay quiet while real errors finish the owned turn', () => {
  const fixture = controllerFixture();
  const generation = fixture.controller.beginGeneration();
  fixture.state.isStreaming = true;
  fixture.controller.handleEvent({
    type: 'error', error: 'Codex 出错：Reconnecting... 2/5 (response.completed not received)',
  }, generation);
  assert.equal(fixture.state.isStreaming, true);
  fixture.controller.handleEvent({ type: 'error', error: 'fatal' }, generation);
  assert.equal(fixture.state.isStreaming, false);
  assert.ok(fixture.calls.some(call => Array.isArray(call) && call[0] === 'system' && call[1] === 'Error: fatal'));
});

test('diagnostic sinks never receive raw provider errors or credentials', () => {
  const fixture = controllerFixture();
  const generation = fixture.controller.beginGeneration();
  const secret = 'Authorization: Bearer sk-secret?token=url-secret cwd=/private/project';
  fixture.controller.handleEvent({ type: 'error', error: secret }, generation);
  const diagnosticText = JSON.stringify({
    debug: fixture.debugCalls,
    warnings: fixture.calls.filter(call => Array.isArray(call) && call[0] === 'warn'),
  });
  assert.doesNotMatch(diagnosticText, /sk-secret|url-secret|\/private\/project/);
  assert.match(diagnosticText, /redacted/);
});

test('live UI renders token and timing nodes through textContent only', () => {
  const fixture = controllerFixture();
  const line = fixture.liveUi.buildUsageLine(null, {
    main: { inputTokens: 10, outputTokens: 2, cacheRead: 1, cacheWrite: 0 },
    sub: { inputTokens: 5, outputTokens: 1, cacheRead: 0, cacheWrite: 0 },
    subByProvider: [{ name: '<img onerror=boom>', model: 'm', inputTokens: 5, outputTokens: 1 }],
  });
  assert.equal(line.className, 'msg-usage');
  assert.ok(line.children.some(child => child.textContent === '主 ↑10 ↓2'));
  assert.ok(line.children.some(child => child.textContent === '辅 ↑5 ↓1'));
  assert.doesNotMatch(line.title, /合计/);
  assert.match(line.title, /非会话累计/);
  assert.match(line.title, /<img onerror=boom>/, 'tooltip remains inert text');
  const timing = fixture.liveUi.buildTimingLine({ ts: 1_700_000_000_000, durationMs: 1234 });
  assert.equal(timing.children.at(-1).textContent, '⏱ 1.2s');
});

test('live UI progress refreshes one stable row until the terminal update', () => {
  const { document, ids } = fakeDocument();
  for (const id of [
    'danmaku-panel', 'danmaku-head', 'danmaku-body', 'danmaku-title',
    'danmaku-count', 'danmaku-dot', 'danmaku-collapse-btn',
  ]) ids.set(id, new FakeElement('div'));
  let timerId = 0;
  const liveUi = liveUiApi.createLiveUi({
    document,
    messagesEl: new FakeElement('div'),
    setTimeout: () => ++timerId,
    clearTimeout() {},
  });
  liveUi.pushDanmaku('progress', '正在启动 · 30s', 'turn:1');
  liveUi.pushDanmaku('progress', '正在调用工具 · 1m 0s', 'turn:1');
  const body = ids.get('danmaku-body');
  assert.equal(body.children.length, 1);
  assert.equal(body.children[0].querySelector('.dm-txt').textContent, '正在调用工具 · 1m 0s');
  assert.equal(body.children[0].className, 'dm-row dm-start');
  liveUi.pushDanmaku('done', '本轮已完成', 'turn:1');
  assert.equal(body.children.length, 1);
  assert.equal(body.children[0].className, 'dm-row dm-done');
});

test('classify bar reveals turn-success for W and cancel-task for P', () => {
  const { document, ids } = fakeDocument();
  const bar = new FakeElement('div'); ids.set('aux-classify-bar', bar);
  ids.set('ac-goal', new FakeElement('span'));
  ids.set('ac-phase', new FakeElement('span'));
  ids.set('ac-state', new FakeElement('span'));
  const markBtn = new FakeElement('button'); ids.set('ac-mark-done', markBtn);
  const cancelBtn = new FakeElement('button'); ids.set('ac-cancel-task', cancelBtn);
  const marks = [];
  const cancels = [];
  const liveUi = liveUiApi.createLiveUi({
    document,
    messagesEl: new FakeElement('div'),
    onMarkTurnSucceeded: () => marks.push(1),
    onCancelTask: () => cancels.push(1),
  });

  liveUi.renderAuxClassify('实现登录', 'implementing', 'W');
  assert.equal(bar.classList.contains('show'), true);
  assert.equal(bar.classList.contains('can-mark-done'), true);
  assert.equal(bar.classList.contains('can-cancel-task'), false);

  markBtn.click();
  assert.deepEqual(marks, [1]);
  assert.equal(markBtn.disabled, true);

  liveUi.renderAuxClassify('实现登录', 'implementing', 'P');
  assert.equal(bar.classList.contains('can-mark-done'), false);
  assert.equal(bar.classList.contains('can-cancel-task'), true);
  cancelBtn.click();
  assert.deepEqual(cancels, [1]);
  assert.equal(cancelBtn.disabled, true);

  liveUi.renderAuxClassify('', 'idle', 'W');
  assert.equal(bar.classList.contains('show'), false);
  assert.equal(bar.classList.contains('can-mark-done'), false);
  assert.equal(bar.classList.contains('can-cancel-task'), false);
});

function makeDanmakuUi(extra = {}) {
  const { document, ids } = fakeDocument();
  for (const id of [
    'danmaku-panel', 'danmaku-head', 'danmaku-body', 'danmaku-title',
    'danmaku-count', 'danmaku-dot', 'danmaku-collapse-btn',
  ]) ids.set(id, new FakeElement('div'));
  let timerId = 0;
  const liveUi = liveUiApi.createLiveUi({
    document,
    messagesEl: new FakeElement('div'),
    setTimeout: () => ++timerId,
    clearTimeout() {},
    ...extra,
  });
  return { liveUi, body: ids.get('danmaku-body') };
}

test('danmaku keeps a confirmed background task across turn end, then settles it when it leaves the active set', () => {
  const { liveUi, body } = makeDanmakuUi();
  liveUi.pushDanmaku('start', '子任务 A', 'task-1');
  assert.equal(body.children[0].className, 'dm-row dm-start');
  // A background_tasks snapshot lists it: confirm it is a real background task.
  liveUi.reconcileDanmakuTasks(['task-1']);
  // The turn ends but a confirmed background task legitimately keeps spinning.
  liveUi.settleTurnScopedDanmaku();
  assert.equal(body.children[0].className, 'dm-row dm-start');
  // A later snapshot no longer lists it (finished): settle even if monitor_done was lost.
  liveUi.reconcileDanmakuTasks([]);
  assert.equal(body.children[0].className, 'dm-row dm-stale');
});

test('the danmaku ✕ button removes the row and asks the host to cancel the task', () => {
  const dismissed = [];
  const { liveUi, body } = makeDanmakuUi({ onDanmakuDismiss: id => dismissed.push(id) });
  liveUi.pushDanmaku('start', '卡住的后台任务', 'task-9');
  assert.equal(body.children.length, 1);
  const row = body.children[0];
  const closeBtn = row.querySelector('.dm-close');
  assert.ok(closeBtn, 'row carries a ✕ dismiss button');
  closeBtn.click();
  assert.equal(body.children.length, 0, 'clicking ✕ removes the row');
  assert.deepEqual(dismissed, ['task-9'], 'host is asked to cancel the underlying task id');
});

test('turn end settles a spinner never confirmed as a background task (misclassified sync tool)', () => {
  const { liveUi, body } = makeDanmakuUi();
  liveUi.pushDanmaku('start', 'Merge worktree branch back to main via API', 'task-sync');
  assert.equal(body.children[0].className, 'dm-row dm-start');
  liveUi.settleTurnScopedDanmaku();
  assert.equal(body.children[0].className, 'dm-row dm-stale');
});

test('dropStaleUserInput consumes the locally pending card id on socket close', () => {
  const f = controllerFixture();
  f.setPendingInputId('usrq-web-stale');
  f.controller.dropStaleUserInput();
  assert.deepEqual(f.calls.find(call => call[0] === 'consume-input'), ['consume-input', 'usrq-web-stale']);
  f.setPendingInputId(null);
  const before = f.calls.length;
  f.controller.dropStaleUserInput();
  assert.equal(f.calls.length, before, 'nothing to drop → no host calls');
});

test('chat host loads new controllers before chat and reaches the 3000-line budget', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/chat.html'), 'utf8');
  const chat = fs.readFileSync(path.join(ROOT, 'public/chat.js'), 'utf8');
  const live = fs.readFileSync(path.join(ROOT, 'public/chat-live-ui.js'), 'utf8');
  const events = fs.readFileSync(path.join(ROOT, 'public/chat-event-controller.js'), 'utf8');
  const inputCard = fs.readFileSync(path.join(ROOT, 'public', 'chat-user-input-card.js'), 'utf8');
  for (const script of [
    'chat-live-ui.js',
    'chat-session-queue.js',
    'chat-user-input-card.js',
    'chat-event-controller.js',
  ]) {
    assert.ok(html.indexOf(`<script src="${script}"></script>`) < html.indexOf('<script src="chat.js"></script>'));
  }
  assert.ok(chat.split(/\r?\n/).length <= 3000, 'chat host must stay within the hard migration target');
  assert.match(chat, /MultiCCChatEventController\.createEventController/);
  assert.match(chat, /MultiCCChatLiveUi\.createLiveUi/);
  for (const source of [live, events, inputCard]) {
    assert.doesNotMatch(source, /\.innerHTML\s*=/);
    assert.doesNotMatch(source, /\bfetch\s*\(/);
    assert.doesNotMatch(source, /new\s+WebSocket\s*\(/);
    assert.doesNotMatch(source, /[?&](?:token|access_token)=/i);
  }
});
