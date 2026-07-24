'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const liveUiApi = require('../public/chat-live-ui');
require('../public/chat-rate-limit'); // registers global.MultiCCChatRateLimit for the rate_limit_event case
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
    costText: '',
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
    showNotifyToast() {},
    speakNotify() {},
    maybeScrollToBottom() {},
    renderCurrentText() { calls.push(['render', state.currentTextContent]); },
    rearmUnread() {},
  };
  const controller = eventApi.createEventController({ state, host, liveUi, historyStore, historyView });
  return { controller, state, calls, debugCalls, progressCalls, tools, bubble, content, liveUi };
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

test('Claude five-hour limit consumes the structured SDK event without retaining billing fields', () => {
  const fixture = controllerFixture();
  const generation = fixture.controller.beginGeneration();
  fixture.controller.handleEvent({
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'allowed_warning',
      rateLimitType: 'five_hour',
      utilization: 0.72,
      resetsAt: Math.floor(Date.now() / 1000) + 60,
      overageDisabledReason: 'out_of_credits',
    },
  }, generation);
  assert.equal(fixture.state.claudeFiveHourRateLimit.usedPercentage, 72);
  assert.equal('overageDisabledReason' in fixture.state.claudeFiveHourRateLimit, false);
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
  assert.equal(fixture.state.currentTextContent, '<b>literal</b>');
  assert.deepEqual(fixture.calls.find(call => Array.isArray(call) && call[0] === 'tool-result'),
    ['tool-result', 'tool-1', '<img onerror=boom>', false]);
  assert.equal(fixture.state.liveStreamUsage.inputTokens, 12);
  assert.equal(fixture.state.liveStreamUsage.cacheRead, 3);
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

test('classify bar reveals the manual mark-done button only while waiting for user', () => {
  const { document, ids } = fakeDocument();
  const bar = new FakeElement('div'); ids.set('aux-classify-bar', bar);
  ids.set('ac-goal', new FakeElement('span'));
  ids.set('ac-phase', new FakeElement('span'));
  ids.set('ac-state', new FakeElement('span'));
  const markBtn = new FakeElement('button'); ids.set('ac-mark-done', markBtn);
  const marks = [];
  const liveUi = liveUiApi.createLiveUi({
    document, messagesEl: new FakeElement('div'), onMarkTaskDone: () => marks.push(1),
  });

  liveUi.renderAuxClassify('实现登录', 'implementing', 'W');
  assert.equal(bar.classList.contains('show'), true);
  assert.equal(bar.classList.contains('can-mark-done'), true);

  markBtn.click();
  assert.deepEqual(marks, [1]);
  assert.equal(markBtn.disabled, true);

  liveUi.renderAuxClassify('实现登录', 'implementing', 'P');
  assert.equal(bar.classList.contains('can-mark-done'), false);

  liveUi.renderAuxClassify('', 'idle', 'W');
  assert.equal(bar.classList.contains('show'), false);
  assert.equal(bar.classList.contains('can-mark-done'), false);
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

test('chat host loads new controllers before chat and reaches the 3000-line budget', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/chat.html'), 'utf8');
  const chat = fs.readFileSync(path.join(ROOT, 'public/chat.js'), 'utf8');
  const live = fs.readFileSync(path.join(ROOT, 'public/chat-live-ui.js'), 'utf8');
  const events = fs.readFileSync(path.join(ROOT, 'public/chat-event-controller.js'), 'utf8');
  for (const script of ['chat-live-ui.js', 'chat-event-controller.js']) {
    assert.ok(html.indexOf(`<script src="${script}"></script>`) < html.indexOf('<script src="chat.js"></script>'));
  }
  assert.ok(chat.split(/\r?\n/).length <= 3000, 'chat host must stay within the hard migration target');
  assert.match(chat, /MultiCCChatEventController\.createEventController/);
  assert.match(chat, /MultiCCChatLiveUi\.createLiveUi/);
  for (const source of [live, events]) {
    assert.doesNotMatch(source, /\.innerHTML\s*=/);
    assert.doesNotMatch(source, /\bfetch\s*\(/);
    assert.doesNotMatch(source, /new\s+WebSocket\s*\(/);
    assert.doesNotMatch(source, /[?&](?:token|access_token)=/i);
  }
});
