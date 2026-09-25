'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createHistoryView, parseSystemInject } = require('../public/chat-history-view');
const liveUiApi = require('../public/chat-live-ui');

const ROOT = path.join(__dirname, '..');
const VIEW_SOURCE = fs.readFileSync(path.join(ROOT, 'public/chat-history-view.js'), 'utf8');
const CHAT_SOURCE = fs.readFileSync(path.join(ROOT, 'public/chat.js'), 'utf8');
const EVENT_SOURCE = fs.readFileSync(path.join(ROOT, 'public/chat-event-controller.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'public/chat.html'), 'utf8');
const LIVE_UI_SOURCE = fs.readFileSync(path.join(ROOT, 'public/chat-live-ui.js'), 'utf8');

test('shell passive updates retain equal replies from different executions and replace live placeholders', () => {
  const { view, messagesEl } = fixture();
  const msg = (session, id, content) => ({ id: `${session}:${id}`, sourceSessionId: session,
    sourceMessageId: id, taskId: session, role: 'assistant', content });
  view.commitMessage(msg('a', 'one', 'identical reply across tasks'));
  view.commitMessage(msg('b', 'two', 'identical reply across tasks'));
  assert.ok(view.findById('a:one'));
  assert.ok(view.findById('b:two'));
  view.commitSourcePage('a', [msg('a', 'live-a', 'partial output')]);
  view.commitSourcePage('a', [msg('a', 'final', 'completed output with different text')]);
  assert.equal(view.findById('a:live-a'), null);
  assert.ok(view.findById('a:final'));
  assert.ok(view.findById('b:two'));
  assert.equal(messagesEl.querySelectorAll('.msg.assistant').length, 3);
  view.clearSource('a');
  assert.ok(view.findById('b:two'));
  assert.equal(messagesEl.querySelectorAll('.msg.assistant').length, 1);
});

class FakeClassList {
  constructor(element) { this.element = element; this.values = new Set(); }
  set(value) { this.values = new Set(String(value || '').split(/\s+/).filter(Boolean)); }
  add(...values) { values.forEach(value => this.values.add(value)); }
  remove(...values) { values.forEach(value => this.values.delete(value)); }
  contains(value) { return this.values.has(value); }
  toggle(value) {
    if (this.values.has(value)) { this.values.delete(value); return false; }
    this.values.add(value); return true;
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
  // :not(...) 里的条件由 notData/notClass 单独判定，不能又算进正向必选——
  // 否则 .msg.assistant:not([data-msg-id]) 对「没有 msgId 的节点」也会被
  // requiredData 拒掉，选择器永远匹配不到任何东西。
  const bare = selector.replace(/:not\([^)]*\)/g, ' ');
  const requiredData = [...bare.matchAll(/\[([^\]]+)\]/g)].map(match => match[1]);
  const classes = [...bare.matchAll(/\.([a-zA-Z0-9_-]+)/g)].map(match => match[1]);
  const tag = bare.match(/^[a-zA-Z][a-zA-Z0-9-]*/);
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
    this.onclick = null;
  }
  set className(value) { this.classList.set(value); }
  get className() { return this.classList.toString(); }
  set textContent(value) { this._textContent = String(value == null ? '' : value); this.children = []; }
  get textContent() { return this.children.length ? this.children.map(child => child.textContent).join('') : this._textContent; }
  set innerHTML(value) { this._innerHTML = String(value); this.children = []; }
  get innerHTML() { return this._innerHTML; }
  get firstElementChild() { return this.children[0] || null; }
  get scrollHeight() { return this.children.length * 20; }
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
  createElement(tagName) { return new FakeElement(tagName); }
  createDocumentFragment() { return new FakeElement('#fragment', 11); }
  // The live-UI module looks up its danmaku/error docks by id at construction;
  // this view fixture has no such chrome, so every lookup misses.
  getElementById() { return null; }
}

function fixture(overrides = {}) {
  const document = new FakeDocument();
  const messagesEl = document.createElement('div');
  const actions = [];
  const view = createHistoryView({
    document,
    messagesEl,
    safeMarkdown: { render: text => `<p>${String(text).replace(/</g, '&lt;')}</p>` },
    attachDeleteButton: node => actions.push(['delete', node.dataset.msgId]),
    attachForkButton: node => actions.push(['fork', node.dataset.msgId]),
    ...overrides,
  });
  return { document, messagesEl, view, actions };
}

test('view upserts persisted ids and keeps user content text-only', () => {
  const { messagesEl, view } = fixture();
  const first = {
    operations: [{ kind: 'append', id: 'u1', message: { id: 'u1', role: 'user', content: '<img onerror=boom>' } }],
    messages: [], hasMore: false, streamingTail: null,
  };
  view.applyPlan(first);
  assert.equal(messagesEl.children.length, 1);
  assert.equal(messagesEl.children[0].textContent, '<img onerror=boom>');

  view.applyPlan({ ...first, operations: [
    { kind: 'update', id: 'u1', message: { id: 'u1', role: 'user', content: 'authoritative' } },
  ] });
  assert.equal(messagesEl.children.length, 1, 'an id update must replace, never append');
  assert.equal(messagesEl.children[0].textContent, 'authoritative');
});

test('committed user message replaces its optimistic bubble and preserves per-turn controls', () => {
  const { document, messagesEl, view } = fixture();
  const optimistic = document.createElement('div');
  optimistic.className = 'msg user';
  optimistic.dataset.clientMsgId = 'browser-1';
  optimistic.textContent = 'send once';
  const autoCommit = document.createElement('label');
  autoCommit.className = 'msg-auto-commit';
  optimistic.appendChild(autoCommit);
  messagesEl.appendChild(optimistic);

  const committed = view.commitMessage({
    id: 'user-1',
    role: 'user',
    content: 'send once',
    clientMsgId: 'browser-1',
  }, { lastUserElement: optimistic });

  assert.equal(messagesEl.querySelectorAll('.msg.user').length, 1);
  assert.equal(committed.node.dataset.msgId, 'user-1');
  assert.equal(committed.node.dataset.clientMsgId, 'browser-1');
  assert.equal(committed.node.querySelector('.msg-auto-commit'), autoCommit);
  assert.equal(committed.lastUserElement, committed.node);
});

test('a late committed user message inserts BEFORE the streaming assistant bubble', () => {
  // 复现 web 端「助手消息在用户消息上面」：队列消息 started 之后才回填的
  // chat_msg_meta（或 queued:false 广播丢失后的补画）晚于 message_start ——
  // 那时流式助手气泡已经在列表尾，盲 append 会把问题画到它自己的回答下面。
  const { document, messagesEl, view } = fixture();
  const earlier = view.renderMessage({ id: 'a0', role: 'assistant', content: 'previous answer' });
  const tail = view.renderMessage({ role: 'assistant', content: '', streaming: true });
  messagesEl.appendChild(earlier);
  messagesEl.appendChild(tail);

  const committed = view.commitMessage(
    { id: 'u1', role: 'user', content: 'late question' },
    { currentElement: tail },
  );

  assert.equal(messagesEl.children[0], earlier, '历史在前');
  assert.equal(messagesEl.children[1].textContent, 'late question', '迟到的问题必须插在流式回答之前');
  assert.equal(messagesEl.children[2], tail, '流式助手气泡仍是最后一个');
  assert.equal(committed.lastUserElement.dataset.msgId, 'u1');
});

test('a passively replayed user message also lands before the live tail', () => {
  // commitSourcePage 不带 currentElement：插入位要靠 DOM 里那个无持久 id 的
  // 助手气泡兜底找到。
  const { messagesEl, view } = fixture();
  const tail = view.renderMessage({ role: 'assistant', content: 'answering…', streaming: true });
  messagesEl.appendChild(tail);

  view.commitMessage({ id: 'u2', role: 'user', content: 'queued fill-in' }, { passive: true });

  assert.equal(messagesEl.children[0].textContent, 'queued fill-in');
  assert.equal(messagesEl.children[1], tail);
});

test('a reconnect page carrying the user message lands it before the live tail', () => {
  // 同一类错位的第四个落点：applyPlan 的 append 分支。重连后权威历史页带着
  // 本轮那条用户消息（队列消息按设计先不画气泡，气泡要等 chat_msg_meta 回填），
  // 而浏览器手里那个无持久 id 的流式助手气泡已经在列表尾 —— 盲 append 会把
  // 用户消息画到它自己的回答下面。commitMessage 与 chat.js addUserMsg 都已
  // 有这一个守卫，只有这里漏了。
  const { document, messagesEl, view } = fixture();
  const earlier = view.renderMessage({ id: 'a0', role: 'assistant', content: 'previous answer' });
  const tail = document.createElement('div');
  tail.className = 'msg assistant streaming-dot';
  messagesEl.appendChild(earlier);
  messagesEl.appendChild(tail);

  view.applyPlan({
    operations: [{ kind: 'append', id: 'u1', message: { id: 'u1', role: 'user', content: '继续' } }],
    messages: [], hasMore: false, streamingTail: null,
  }, { currentElement: tail });

  assert.equal(messagesEl.children[0], earlier, '历史在前');
  assert.equal(messagesEl.children[1].textContent, '继续', '重连补画的用户消息必须在流式回答之前');
  assert.equal(messagesEl.children[2], tail, '流式助手气泡仍是最后一个');
});

test('a late user message lands above the 正在处理 placeholder, not below it', () => {
  // 截图里那一条「错位」：占位不是 .msg.assistant，而是 chat-live-ui 的
  // .thinking-bubble（showThinking 画的「正在处理…」）。同一个
  // message_admission_progress 事件里既 showThinking 又 addUserMessage，
  // 只按 .msg.assistant 找锚点就漏掉占位，用户气泡被 append 到它后面 ——
  // 于是问题显示在自己那条回答的下面。
  const { document, messagesEl, view } = fixture();
  const earlier = view.renderMessage({ id: 'a0', role: 'assistant', content: '上一轮的回答' });
  const placeholder = document.createElement('div');
  placeholder.className = 'thinking-bubble';
  messagesEl.appendChild(earlier);
  messagesEl.appendChild(placeholder);

  assert.equal(view.pendingAnswerAnchor({}), placeholder, '待答锚点必须认出占位');

  view.commitMessage({ id: 'u9', role: 'user', content: '继续' }, {});

  assert.equal(messagesEl.children[0], earlier);
  assert.equal(messagesEl.children[1].textContent, '继续', '用户消息必须在占位之前');
  assert.equal(messagesEl.children[2], placeholder, '占位仍是最后一个');
});

test('the placeholder anchor also carries the applyPlan replay path', () => {
  const { document, messagesEl, view } = fixture();
  const placeholder = document.createElement('div');
  placeholder.className = 'thinking-bubble';
  messagesEl.appendChild(placeholder);

  view.applyPlan({
    operations: [{ kind: 'append', id: 'u1', message: { id: 'u1', role: 'user', content: '继续' } }],
    messages: [], hasMore: false, streamingTail: null,
  }, {});

  assert.equal(messagesEl.children[0].textContent, '继续', '重连补画同样要落在占位之前');
  assert.equal(messagesEl.children[1], placeholder);
});

test('the anchor is the later of the live bubble and the placeholder', () => {
  // 占位与真流式气泡理论上不同时在（占位在 message_start 时被摘掉），但重连
  // 回填的时序不保证顺序 —— 取靠后的那个才是列表尾上真正的待答代表。
  const { document, messagesEl, view } = fixture();
  const live = view.renderMessage({ role: 'assistant', content: '', streaming: true });
  const placeholder = document.createElement('div');
  placeholder.className = 'thinking-bubble';
  messagesEl.appendChild(placeholder);
  messagesEl.appendChild(live);

  assert.equal(view.pendingAnswerAnchor({}), live, '真气泡在后时锚点是真气泡');

  messagesEl.appendChild(placeholder);   // 占位被重新挂到尾上
  assert.equal(view.pendingAnswerAnchor({}), placeholder, '占位在后时锚点是占位');
});

test('chat.js addUserMsg delegates its anchor to the view instead of re-querying', () => {
  // chat.js 是浏览器脚本、不可 require：与既有 host 委托断言同一风格，锁住
  // 「锚点只由 view 给出」这一结构 —— 自己再抄一份 .msg.assistant 查询就是
  // 漏掉思考占位的那个 bug。
  assert.match(CHAT_SOURCE, /function addUserMsg[\s\S]{0,1200}?chatHistoryView\.pendingAnswerAnchor\?\.\(\{ currentElement: currentMsgEl \}\)/);
  assert.match(CHAT_SOURCE, /if \(streamingTail\) messagesEl\.insertBefore\(div, streamingTail\)/);
  assert.doesNotMatch(CHAT_SOURCE, /function addUserMsg[\s\S]{0,1200}?querySelectorAll\('\.msg\.assistant:not\(\[data-msg-id\]\)'\)/, '不得再自己查一遍助手气泡');
});

test('assistant Markdown uses the one safe boundary and tool cards stay text-only', () => {
  let markdownCalls = 0;
  const { view } = fixture({
    safeMarkdown: { render(text) { markdownCalls += 1; return `<p>safe:${text.length}</p>`; } },
  });
  const node = view.renderMessage({
    id: 'a1', role: 'assistant', content: '<script>bad()</script>',
    tools: [{ id: 't1', name: '<img>', input: { command: '<b>cmd</b>' }, result: '<svg>result</svg>' }],
  });
  assert.equal(markdownCalls, 1);
  assert.equal(node.querySelector('.message-markdown').innerHTML, '<p>safe:22</p>');
  assert.equal(node.querySelector('.tool-name').textContent, '<img>');
  assert.equal(node.querySelector('.tool-input').textContent, JSON.stringify({ command: '<b>cmd</b>' }, null, 2));
  assert.match(node.querySelector('.tool-body').textContent, /<svg>result<\/svg>/);
});

test('repeated tool results replace the owned result block', () => {
  const { view } = fixture();
  const card = view.createToolCard('Bash', 'tool-1');
  const state = { card, id: 'tool-1', inputJson: '{"command":"pwd"}' };
  view.updateToolInput(state);
  view.addToolResult(state, 'first', false);
  view.addToolResult(state, 'second', true);
  assert.equal(card.querySelectorAll('.tool-result-label').length, 1);
  assert.equal(card.querySelectorAll('.tool-result-owned').length, 2);
  assert.doesNotMatch(card.textContent, /first/);
  assert.match(card.textContent, /second/);
  assert.equal(card.querySelector('.tool-desc').textContent, 'failed');
});

test('tool duration is shown only when start and settle are measured', () => {
  const { view } = fixture();
  // Live tool: content_block_start stamped startedAt, tool_result stamped endedAt.
  // The wall-clock span is shown as a measured suffix (DSH provenance state).
  const live = { card: view.createToolCard('Bash', 'tool-1'), id: 'tool-1',
    inputJson: '{"command":"sleep 1"}', startedAt: 1000, endedAt: 2500 };
  view.addToolResult(live, 'ok', false);
  assert.equal(live.card.querySelector('.tool-desc').textContent, 'done · 1.5s');

  // A failure still tags its measured duration.
  const fast = { card: view.createToolCard('Bash', 'tool-2'), id: 'tool-2',
    inputJson: '{}', startedAt: 5000, endedAt: 5120 };
  view.addToolResult(fast, 'boom', true);
  assert.equal(fast.card.querySelector('.tool-desc').textContent, 'failed · 120ms');

  // Replay/hydrateTool has no timing — never fabricate "0ms"; show the bare label.
  const replay = { card: view.createToolCard('Read', 'r1'), id: 'r1', inputJson: '{}' };
  view.addToolResult(replay, 'ok', false);
  assert.equal(replay.card.querySelector('.tool-desc').textContent, 'done');

  // A clock skew (endedAt before startedAt) degrades to the unknown label.
  const skew = { card: view.createToolCard('Bash', 's1'), id: 's1', inputJson: '{}',
    startedAt: 9000, endedAt: 1000 };
  view.addToolResult(skew, 'ok', false);
  assert.equal(skew.card.querySelector('.tool-desc').textContent, 'done');
});

test('turn trajectory places each measured tool at its real offset', () => {
  const { document, view } = fixture();
  const content = document.createElement('div');

  // Two measured tools in a 0–10s window: tool A covers the first half,
  // tool B covers the last quarter. Positions are proportional facts, not
  // decorations — a mis-placed segment is a lying timeline.
  const strip = view.renderToolTrajectory(content, [
    { name: 'Bash', startedAt: 0, endedAt: 5000 },
    { name: 'Read', startedAt: 7500, endedAt: 10000, isError: true },
  ]);
  assert.ok(strip, 'two measured tools render a strip');
  const segs = strip.querySelectorAll('.tool-trajectory-seg');
  assert.equal(segs.length, 2);
  assert.equal(segs[0].style.left, '0%');
  assert.equal(segs[0].style.width, '50%');
  assert.equal(segs[1].style.left, '75%');
  assert.equal(segs[1].style.width, '25%');
  assert.ok(segs[1].classList.contains('error'), 'a failed tool marks its segment');
  assert.equal(segs[0].title, 'Bash · 5.0s');
  assert.equal(strip.querySelector('.tool-trajectory-label').textContent, '⏱ 2 tools · 10s wall-clock');

  // Re-render is an upsert, not an append — one bubble, one strip.
  const again = view.renderToolTrajectory(content, [
    { name: 'Bash', startedAt: 0, endedAt: 5000 },
    { name: 'Read', startedAt: 7500, endedAt: 10000, isError: true },
  ]);
  assert.equal(content.querySelectorAll('.tool-trajectory').length, 1);
  assert.equal(again, content.querySelector('.tool-trajectory'));

  // A sub-1% span stays visible as a sliver, and a sliver pushed against the
  // track's right edge is clamped so it never overflows past 100%.
  const sliver = view.renderToolTrajectory(content, [
    { name: 'A', startedAt: 0, endedAt: 1 },
    { name: 'B', startedAt: 4000, endedAt: 5000 },
  ]);
  const sliverSegs = sliver.querySelectorAll('.tool-trajectory-seg');
  assert.equal(sliverSegs[0].style.left, '0%');
  assert.equal(sliverSegs[0].style.width, '0.75%');
  assert.equal(sliverSegs[1].style.left, '80%');
  assert.equal(sliverSegs[1].style.width, '20%');
  const edge = view.renderToolTrajectory(content, [
    { name: 'A', startedAt: 0, endedAt: 1 },
    { name: 'B', startedAt: 9999, endedAt: 10000 },
  ]);
  const edgeSegs = edge.querySelectorAll('.tool-trajectory-seg');
  assert.ok(parseFloat(edgeSegs[1].style.width) < 0.76, 'right-edge sliver is clamped, not overflowing');
});

test('turn trajectory is absent unless two tools are measured', () => {
  const { document, view } = fixture();
  const content = document.createElement('div');

  // Replay has no tool timing — no strip, never a fabricated flat bar.
  assert.equal(view.renderToolTrajectory(content, [
    { name: 'Read' }, { name: 'Bash' },
  ]), null);
  // A lone measured tool adds nothing the "done · Xs" suffix doesn't say.
  assert.equal(view.renderToolTrajectory(content, [
    { name: 'Bash', startedAt: 0, endedAt: 500 }, { name: 'Read' },
  ]), null);
  // Clock-skewed stamps are unmeasurable, same as replay.
  assert.equal(view.renderToolTrajectory(content, [
    { name: 'A', startedAt: 0, endedAt: 100 }, { name: 'B', startedAt: 900, endedAt: 100 },
  ]), null);
  assert.equal(content.querySelectorAll('.tool-trajectory').length, 0);
  // Defensive: null container / null list never throw.
  assert.equal(view.renderToolTrajectory(null, [{ name: 'A', startedAt: 0, endedAt: 1 }]), null);
  assert.equal(view.renderToolTrajectory(content, null), null);
});

test('history replay shows measured durations and a trajectory when the server stamped tools', () => {
  const { view } = fixture();
  // Turn persisted after the server-side stamping: each tool carries
  // startedAt/endedAt, so replay upgrades from unknown to measured.
  const stamped = view.renderMessage({
    id: 'a1', role: 'assistant', content: 'done',
    tools: [
      { id: 't1', name: 'Bash', input: { command: 'ls' }, result: 'ok', is_error: false, startedAt: 1000, endedAt: 2500 },
      { id: 't2', name: 'Read', input: { file_path: '/a' }, result: 'x', is_error: true, startedAt: 3000, endedAt: 3120 },
    ],
  });
  const descs = stamped.querySelectorAll('.tool-desc');
  assert.equal(descs[0].textContent, 'done · 1.5s');
  assert.equal(descs[1].textContent, 'failed · 120ms');
  // Two measured tools also render the trajectory strip on replay.
  const strip = stamped.querySelector('.tool-trajectory');
  assert.ok(strip, 'stamped replay renders the trajectory');
  assert.equal(strip.querySelectorAll('.tool-trajectory-seg').length, 2);
  assert.ok(strip.querySelectorAll('.tool-trajectory-seg')[1].classList.contains('error'));

  // Turns persisted before stamping keep the bare label and no strip — the
  // unknown state, never a fabricated duration.
  const legacy = view.renderMessage({
    id: 'a2', role: 'assistant', content: 'old',
    tools: [
      { id: 't3', name: 'Bash', input: { command: 'ls' }, result: 'ok', is_error: false },
      { id: 't4', name: 'Read', input: { file_path: '/a' }, result: 'x', is_error: false },
    ],
  });
  assert.equal(legacy.querySelectorAll('.tool-desc')[0].textContent, 'done');
  assert.equal(legacy.querySelector('.tool-trajectory'), null);
});

// The token line and the wall-clock line are built by the live-UI module and
// appended by the view. Wiring the real builders covers that seam; the default
// fixture stubs them out, which is exactly where a "usage vanished" regression
// could hide.
function usageAwareFixture() {
  const liveUi = liveUiApi.createLiveUi({
    document: new FakeDocument(),
    messagesEl: new FakeElement('div'),
    translate: key => key,
    maybeScrollToBottom() {}, retryTransport() {}, isRestarting: () => false, debug() {},
  });
  return fixture({
    buildUsageLine: liveUi.buildUsageLine,
    buildTimingLine: liveUi.buildTimingLine,
  });
}

test('token usage and wall-clock timing render as independent sibling lines', () => {
  const { view } = usageAwareFixture();
  const usageOf = node => node.querySelectorAll('.msg-usage');
  const timingOf = node => node.querySelectorAll('.msg-timing');

  const both = view.renderMessage({
    id: 'a1', role: 'assistant', content: 'done',
    usage: {
      input_tokens: 9273, output_tokens: 1752,
      cache_read_input_tokens: 609536, cache_creation_input_tokens: 18432,
    },
    ts: 1_700_000_000_000, durationMs: 71014,
  });
  assert.equal(usageOf(both).length, 1, 'adding wall clock must not drop the token line');
  assert.equal(timingOf(both).length, 1);
  assert.match(usageOf(both)[0].textContent, /主↑入 9\.3k↓出 1\.8k♻读 609\.5k♻写 18\.4k/, 'history uses the unified 主 row');
  assert.match(usageOf(both)[0].title, /缓存读 609,536/, 'tooltip keeps exact counts');
  // 分与秒之间有一个空格 —— 与 web 另一处（chat-live-ui 的 fmtDuration）以及 App
  // 里同一个 formatDuration 输出一致（原来这一处是「1m11s」）。
  assert.match(timingOf(both)[0].textContent, /⏱ 1m 11s/);
  // Siblings under .msg-content: stacked block lines, so neither can clip or
  // overlay the other however long the numbers get.
  assert.equal(usageOf(both)[0].parentNode, timingOf(both)[0].parentNode);
  assert.equal(usageOf(both)[0].parentNode.className, 'msg-content');

  // Either half missing never hides the other half.
  const usageOnly = view.renderMessage({
    id: 'a2', role: 'assistant', content: 'u',
    usage: { input_tokens: 12, output_tokens: 3 },
  });
  assert.equal(usageOf(usageOnly).length, 1);
  assert.equal(timingOf(usageOnly).length, 0);
  const timingOnly = view.renderMessage({
    id: 'a3', role: 'assistant', content: 't', durationMs: 45000,
  });
  assert.equal(usageOf(timingOnly).length, 0);
  assert.equal(timingOf(timingOnly).length, 1);
  // All-zero usage is "no data", not a row of zeros.
  const zeroUsage = view.renderMessage({
    id: 'a4', role: 'assistant', content: 'z',
    usage: { input_tokens: 0, output_tokens: 0 }, durationMs: 10,
  });
  assert.equal(usageOf(zeroUsage).length, 0);
  assert.equal(timingOf(zeroUsage).length, 1);
});

test('persisted roleUsage replays the 辅 row only for a separately routed sub model', () => {
  const { view } = usageAwareFixture();
  const rows = node => node.querySelectorAll('.u-row').map(row => row.textContent);
  const roleUsage = (subProvider) => ({
    main: { inputTokens: 56, outputTokens: 5156, cacheRead: 2698338, cacheWrite: 238716 },
    mainByProvider: [{ providerId: 'glm', model: 'glm-5' }],
    sub: { inputTokens: 10, outputTokens: 900, cacheRead: 40000, cacheWrite: 0 },
    subByProvider: [{ providerId: subProvider, model: subProvider === 'glm' ? 'glm-5' : 'ds-4' }],
  });
  const routed = view.renderMessage({ id: 'r1', role: 'assistant', content: 'x', usage: { input_tokens: 1 }, roleUsage: roleUsage('ds') });
  assert.deepEqual(rows(routed), ['主↑入 56↓出 5.2k♻读 2.70M♻写 238.7k', '辅↑入 10↓出 900♻读 40.0k♻写 0']);
  const sameModel = view.renderMessage({ id: 'r2', role: 'assistant', content: 'x', roleUsage: roleUsage('glm') });
  assert.deepEqual(rows(sameModel), ['主↑入 66↓出 6.1k♻读 2.74M♻写 238.7k'], 'sub work on the main model folds into 主');
});

test('both metric lines wrap instead of overflowing a narrow bubble', () => {
  // Layout contract, matching the Flutter side (app/lib/widgets/message_bubble.dart
  // renders both lines with Wrap, covered by app/test/usage_timing_line_test.dart).
  const usageCss = HTML.slice(HTML.indexOf('.msg-usage {'));
  assert.match(usageCss.slice(0, usageCss.indexOf('}')), /flex-wrap:\s*wrap/);
  const timingStyle = LIVE_UI_SOURCE.match(/line\.style\.cssText\s*=\s*'([^']*msg-timing[^']*|[^']*6e7681[^']*)'/);
  assert.ok(timingStyle, 'timing line still sets its inline layout');
  assert.match(timingStyle[1], /display:flex/);
  assert.match(timingStyle[1], /flex-wrap:wrap/);
});

test('typed tool input renders by tool name, not as a JSON blob', () => {
  const { view } = fixture();
  function inputFor(name, input) {
    const card = view.createToolCard(name, 'x');
    const state = { card, name, id: 'x', inputJson: JSON.stringify(input) };
    view.updateToolInput(state);
    return card.querySelector('.tool-input').textContent;
  }
  assert.equal(inputFor('Bash', { command: 'ls -la' }), '$ ls -la');
  assert.equal(inputFor('Read', { file_path: '/a/b.ts' }), '/a/b.ts');
  assert.equal(inputFor('Read', { file_path: '/a', offset: 10, limit: 5 }), '/a\n(offset: 10, limit: 5)');
  assert.equal(inputFor('Grep', { pattern: 'foo', path: 'src', include: '*.js' }), '/foo/  src --include=*.js');
  assert.equal(inputFor('Glob', { pattern: '**/*.md', path: 'docs' }), '**/*.md\nin docs');
  assert.equal(inputFor('WebFetch', { url: 'http://x', prompt: 'sum' }), 'http://x\nsum');
  assert.equal(inputFor('Edit', { file_path: '/a', old_string: 'x', new_string: 'y' }), '/a\n--- old\nx\n+++ new\ny');
  assert.equal(inputFor('Write', { file_path: '/a', content: 'hi' }), '/a\nhi');
  assert.equal(inputFor('Agent', { description: 'find bugs', prompt: 'go' }), 'find bugs\ngo');
  // Unknown tool name still falls back to pretty JSON.
  assert.equal(inputFor('MysteryTool', { a: 1 }), JSON.stringify({ a: 1 }, null, 2));
  // Markup in tool content stays text — never parsed as HTML (XSS guard).
  assert.equal(inputFor('Bash', { command: '<b>hi</b>' }), '$ <b>hi</b>');
  assert.equal(inputFor('Write', { file_path: '/a', content: '<img onerror=boom>' }), '/a\n<img onerror=boom>');
});

test('streaming-tail reconciliation owns one bubble and hydrates tool identity', () => {
  const { messagesEl, view } = fixture();
  const plan = {
    operations: [{
      kind: 'stream-tail', id: null,
      message: { role: 'assistant', content: 'partial', streaming: true, tools: [{ id: 't1', name: 'Read', input: { file_path: '/tmp/a' } }] },
    }],
    messages: [{ role: 'assistant', content: 'partial', streaming: true, tools: [{ id: 't1', name: 'Read', input: { file_path: '/tmp/a' } }] }],
    hasMore: false,
    streamingTail: { id: null, content: 'partial' },
  };
  const first = view.applyPlan(plan);
  const second = view.applyPlan(plan, { currentElement: first.streamingTail.element });
  assert.equal(messagesEl.querySelectorAll('.msg.assistant').length, 1);
  assert.equal(second.streamingTail.element, messagesEl.children[0]);
  assert.equal(second.streamingTail.toolCards.get('history:t1').id, 't1');
});

test('older-page hydration deduplicates page and visible ids while preserving scroll anchor', () => {
  const { messagesEl, view } = fixture();
  messagesEl.appendChild(view.renderMessage({ id: 'new', role: 'user', content: 'new' }));
  messagesEl.scrollTop = 7;
  const count = view.prependMessages([
    { id: 'old', role: 'user', content: 'old' },
    { id: 'old', role: 'user', content: 'duplicate' },
    { id: 'new', role: 'user', content: 'already visible' },
  ]);
  assert.equal(count, 1);
  assert.deepEqual(view.visibleIds(), ['old', 'new']);
  assert.equal(messagesEl.scrollTop, 27);
});

test('missing Markdown boundary fails closed to textContent', () => {
  const { view } = fixture({ safeMarkdown: null });
  const node = view.renderMessage({ role: 'assistant', content: '<img src=x onerror=boom>' });
  const markdown = node.querySelector('.message-markdown');
  assert.equal(markdown.textContent, '<img src=x onerror=boom>');
  assert.equal(markdown.innerHTML, '');
});

test('a bubble carries the subtask it came from, for the quote action to read', () => {
  const { messagesEl, view, actions } = fixture({
    attachQuoteButton: node => actions.push(['quote', node.dataset.msgId]),
  });
  const node = view.renderMessage({
    id: 'sess-1:m_abc',
    role: 'assistant',
    content: '已改完',
    sourceSessionId: 'sess-1',
    sourceMessageId: 'm_abc',
    taskId: 'tsk_1',
    taskName: '修登录页',
    turnId: 'turn_9',
    auxRunId: 'run_3',
    ts: 1757000000000,
  });
  messagesEl.appendChild(node);
  assert.equal(node.dataset.taskId, 'tsk_1');
  assert.equal(node.dataset.taskName, '修登录页');
  assert.equal(node.dataset.turnId, 'turn_9');
  assert.equal(node.dataset.auxRunId, 'run_3');
  assert.equal(node.dataset.sourceSessionId, 'sess-1');
  assert.equal(node.dataset.sourceMessageId, 'm_abc');
  assert.equal(node.dataset.ts, '1757000000000');
  assert.deepEqual(actions, [['delete', 'sess-1:m_abc'], ['fork', 'sess-1:m_abc'], ['quote', 'sess-1:m_abc']]);
});

test('a message with no provenance is left unstamped rather than stamped with blanks', () => {
  const { view } = fixture();
  const node = view.renderMessage({ id: 'm1', role: 'user', content: '你好' });
  assert.equal(node.dataset.taskId, undefined);
  assert.equal(node.dataset.taskName, undefined);
  assert.equal(node.dataset.ts, undefined);
});

test('late task attribution is patched onto the bubbles already on screen', () => {
  const { messagesEl, view } = fixture();
  const assistant = view.renderMessage({ id: 'sess-1:m_abc', role: 'assistant', content: '已改完', sourceMessageId: 'm_abc' });
  // A shell bubble is addressed by the composite `<sessionId>:<messageId>` while
  // the annotation can still arrive carrying the source session's raw id — for a
  // shell whose id is not resolved yet, `event()` passes the record through
  // unmapped. Hence the sourceMessageId fallback below.
  const user = view.renderMessage({ id: 'sess-1:m_def', role: 'user', content: '继续', sourceMessageId: 'm_def' });
  messagesEl.appendChild(user);
  messagesEl.appendChild(assistant);
  const assistantNodeBefore = assistant;

  // The turn's task is decided when the turn ends — after these bubbles were
  // rendered — so the annotation arrives as a separate, id-addressed patch.
  const applied = view.annotateAttribution([
    { id: 'sess-1:m_abc', turnId: 'turn_9', taskId: 'tsk_1', taskName: '修登录页面并补回归', taskShortCode: 'A1B2', auxRunId: 'run_3' },
    { id: 'm_def', turnId: 'turn_9', taskId: 'tsk_1', taskName: '修登录页面并补回归', taskShortCode: 'A1B2' },
  ]);

  assert.equal(applied, 2);
  assert.equal(messagesEl.children.length, 2, 'patching must not re-render the list');
  assert.equal(assistant.dataset.taskId, 'tsk_1');
  assert.equal(assistant.dataset.auxRunId, 'run_3');
  assert.equal(messagesEl.children[1], assistantNodeBefore, 'the visible bubble is patched, not replaced');
  assert.equal(assistant.querySelector('.msg-task-tail').textContent, '#A1B2 · 修登录页面并补回归');
  assert.equal(user.dataset.taskId, 'tsk_1');
  assert.equal(user.dataset.taskName, '修登录页面并补回归');
  assert.equal(user.dataset.turnId, 'turn_9');
  assert.equal(user.querySelector('.msg-task-tail').textContent, '#A1B2 · 修登录页面并补回归');
});

test('task tails stay absent until the server supplies its registry code', () => {
  const { view } = fixture();
  const unresolved = view.renderMessage({ id: 'm1', role: 'user', content: '继续', taskId: 'tsk_1', taskName: '任务一' });
  const attributed = view.renderMessage({ id: 'm2', role: 'assistant', content: '完成', taskId: 'tsk_2', taskName: '很长的任务名称用于验证省略规则', taskShortCode: 'z9x8' });
  assert.equal(unresolved.querySelector('.msg-task-tail'), null);
  assert.equal(attributed.querySelector('.msg-task-tail').textContent, '#Z9X8 · 很长的任务名称用于验…');
  assert.equal(attributed.querySelector('.msg-task-tail').title, '#Z9X8 · 很长的任务名称用于验证省略规则');
});

test('an annotation for a message that is not on screen is ignored, not fatal', () => {
  const { view } = fixture();
  view.renderMessage({ id: 'm1', role: 'user', content: '你好' });
  assert.equal(view.annotateAttribution([{ id: 'gone', taskId: 'tsk_1' }, { taskId: 'tsk_2' }, null]), 0);
  assert.equal(view.annotateAttribution(undefined), 0);
});

test('the host wires the quote action and routes late attribution to the view', () => {
  // The view would silently accept a missing quote wiring — its default is a
  // noop — so the two ends of the feature are asserted here: the host injects
  // the button, and the controller hands the annotation to the in-place patch
  // rather than a re-render.
  assert.match(CHAT_SOURCE, /attachQuoteButton,/);
  assert.match(CHAT_SOURCE, /window\.MultiCCChatQuote\.quoteInto\(msgEl, document\)/);
  // No composer, no quote action: the alternative is a button that reports the
  // wrong reason when clicked.
  assert.match(CHAT_SOURCE, /if \(!document\.getElementById\('input'\)\) return;/);
  assert.match(EVENT_SOURCE, /case 'chat_history_annotation':/);
  assert.match(EVENT_SOURCE, /annotateAttribution\?\.\(message\.messages\)/);
  // The view must hand the composer a bubble that has a durable id; an interim
  // bubble has none, and the host says so instead of quoting a dead handle.
  assert.match(CHAT_SOURCE, /msgEl\.dataset\.shellInterim === '1' \|\| !msgEl\.dataset\.msgId/);
});

test('classic host delegates persisted and streaming DOM ownership to the view', () => {
  assert.match(CHAT_SOURCE, /MultiCCChatHistoryView\.createHistoryView/);
  assert.match(CHAT_SOURCE, /chatHistoryView\.applyPlan\(plan/);
  assert.match(CHAT_SOURCE, /chatHistoryView\.renderCurrentText/);
  assert.match(CHAT_SOURCE, /chatHistoryView\.prependMessages/);
  assert.match(EVENT_SOURCE, /historyView\.createToolCard/);
  for (const removed of ['renderHistoryAssistantNode', 'renderHistoryUserNode', 'renderHistoryMessageNode', 'hydrateStreamingTools']) {
    assert.doesNotMatch(CHAT_SOURCE, new RegExp(`function ${removed}\\b`));
  }
  assert.doesNotMatch(CHAT_SOURCE, /contentEl\.innerHTML\s*=\s*renderMarkdown/);
  assert.equal((VIEW_SOURCE.match(/\.innerHTML\s*=/g) || []).length, 1, 'one reviewed safe Markdown sink');
  assert.match(VIEW_SOURCE, /const safeHtml = safeMarkdown\.render\(text\)/);
});

test('script order is local purifier, parser, safety boundary, state, quote, view, host', () => {
  const scripts = [
    'vendor/dompurify/purify.min.js',
    'vendor/marked/marked.min.js',
    'safe-markdown.js',
    'chat-history-store.js',
    'chat-quote.js',
    'chat-history-view.js',
    '<script src="chat.js"></script>',
  ];
  for (let index = 1; index < scripts.length; index += 1) {
    assert.ok(HTML.indexOf(scripts[index - 1]) < HTML.indexOf(scripts[index]), scripts[index]);
  }
  assert.doesNotMatch(HTML, /cdn\.jsdelivr\.net\/npm\/dompurify/i);
  assert.match(CHAT_SOURCE, /async function enforceFirstRunPassword\(\)/,
    'the first-run forced-password gate must survive host refactors');
  assert.match(CHAT_SOURCE, /showFirstRunPasswordGate\(\)/);
});

test('vendored DOMPurify bytes and license match recorded official npm provenance', () => {
  const directory = path.join(ROOT, 'public', 'vendor', 'dompurify');
  const hash = name => crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, name))).digest('hex');
  assert.equal(hash('purify.min.js'), '89e1fa7647cb495370d3a997ace4387f5d15d9f4c5af12352c53daa400956287');
  assert.equal(hash('purify.min.js.map'), '7b84044ac434c25404177624d4a1d54e8b2078386339e11bc46db8f97ad7c1ad');
  assert.equal(hash('LICENSE'), '1b02e03c3fb4f87d476c128f0eb9def1f5a1709d28b180465228bd41574623b7');
  const provenance = fs.readFileSync(path.join(directory, 'README.md'), 'utf8');
  assert.match(provenance, /dompurify\/-\/dompurify-3\.2\.6\.tgz/);
  assert.match(provenance, /sha512-\/2GogDQlohXPZe6D6NOgQvXLPSYBqIWMnZ8zzOhn09REE4ey/);
  assert.match(provenance, /No local\s+changes were made/);
});

test('a persisted Auto route note renders through the live formatter and adopts the live line', () => {
  const zh = JSON.parse(fs.readFileSync(path.join(ROOT, 'app/assets/i18n/zh.json'), 'utf8'));
  const translate = (key, params) => String(zh[key] ?? key)
    .replace(/\{(\w+)\}/g, (_, name) => (params && name in params ? String(params[name]) : `{${name}}`));
  const { document, messagesEl, view } = fixture({ translate });
  const autoRoute = {
    phase: 'selected', providerId: 'deepseek', providerName: 'DeepSeek', model: 'deepseek-v4-flash',
    tier: 't1', preferredTier: 't1',
    routing: { source: 'jev', code: 'jev_choice', tierIndex: 0, tierCount: 2, latencyMs: 400 },
  };
  const note = view.renderMessage({
    id: 'n1', role: 'system', kind: 'auto_route', content: 'Auto → DeepSeek · deepseek-v4-flash',
    clientMsgId: 'auto-route-t1-1', autoRoute,
  });
  assert.equal(note.textContent, '🧭 Jev 判定为简单任务 · 选用 DeepSeek（deepseek-v4-flash） · 用时 0.4 秒');
  assert.equal(note.dataset.clientMsgId, 'auto-route-t1-1');
  assert.equal(note.hidden, undefined);
  // A verdict the formatter has nothing to say about keeps its slot but draws nothing.
  const silent = view.renderMessage({ id: 'n2', role: 'system', autoRoute: { ...autoRoute, routing: { source: 'jev' } } });
  assert.equal(silent.textContent, '');
  assert.equal(silent.hidden, true);

  // The live line (no id yet) is adopted by the replayed record instead of doubled.
  const live = document.createElement('div');
  live.className = 'msg system-msg';
  live.textContent = 'live verdict';
  live.dataset.clientMsgId = 'auto-route-t1-1';
  messagesEl.appendChild(live);
  view.applyPlan({
    operations: [{ kind: 'append', id: 'n1', message: {
      id: 'n1', role: 'system', clientMsgId: 'auto-route-t1-1', autoRoute,
    } }],
    messages: [], hasMore: false, streamingTail: null,
  });
  assert.equal(messagesEl.querySelectorAll('.msg.system-msg').length, 1);
  assert.equal(view.findById('n1').textContent, note.textContent);
});

// ── 🔇 system-injected messages (src/session/delivery.js SYSTEM_PREFIX) ──
// They are persisted as role=user but nobody typed them. The card keeps the
// `user` class for the backtracking selectors; `system-inject` marks it as
// "not a user turn" for everything else.

test('injected message parsing splits the 【…】 title from its body', () => {
  const done = parseSystemInject('🔇【后台任务完成】你之前启动的后台任务（x）已结束（状态：completed）。');
  assert.deepEqual({ label: done.label, body: done.body },
    { label: '后台任务完成', body: '你之前启动的后台任务（x）已结束（状态：completed）。' });

  const multi = parseSystemInject('🔇【后台任务完成 ×2】多个任务已结束：\n- a\n- b');
  assert.equal(multi.label, '后台任务完成 ×2');
  assert.equal(multi.body, '多个任务已结束：\n- a\n- b', '正文的换行必须原样保留');

  // autoContinue / bgCheck ship no bracket label on a single line: that line is
  // the whole title, and there is no body to expand.
  assert.deepEqual(
    { ...parseSystemInject('🔇继续：如果已经可以推进就继续。') },
    { label: '继续：如果已经可以推进就继续。', body: '' });
  const labelled = parseSystemInject('  🔇[后台进程检查] 请现在处理\n第二行');
  assert.equal(labelled.label, '[后台进程检查] 请现在处理');
  assert.equal(labelled.body, '第二行');

  // Not injected at all — including a bare prefix with nothing after it.
  assert.equal(parseSystemInject('普通用户消息'), null);
  assert.equal(parseSystemInject('🔇'), null);
});

test('an injected 🔇 message renders as a collapsed card, not a user bubble', () => {
  const content = '🔇【后台任务完成 ×2】多个后台任务已结束，请一并推进：\n- 构建\n- 部署';
  const { view } = fixture();
  const node = view.renderMessage({ id: 'u1', role: 'user', content, clientMsgId: 'c1' });
  assert.equal(node.classList.contains('user'), true, '回溯选择器仍按 .msg.user 找节点');
  assert.equal(node.classList.contains('system-inject'), true);
  assert.equal(node.dataset.clientMsgId, 'c1');
  assert.equal(node.querySelector('.system-inject-label').textContent, '后台任务完成 ×2');
  assert.equal(node.querySelector('.system-inject-body').textContent, '多个后台任务已结束，请一并推进：\n- 构建\n- 部署');
  // The 🔇 glyph stays the leading icon, so the text-based detector still reads
  // this node as injected even without the modifier class.
  assert.equal(node.textContent.trimStart().startsWith('🔇'), true);
  assert.equal(node.querySelector('.system-inject-icon').textContent, '🔇');
  assert.equal(node.querySelector('.system-inject-body').innerHTML, '', '正文只能是文本节点');

  // Collapsed by default; the title line toggles the body open. Same affordance
  // as a tool card (chat-history-view's own header.onclick pattern).
  assert.equal(node.classList.contains('open'), false);
  node.querySelector('.system-inject-head').onclick();
  assert.equal(node.classList.contains('open'), true);
  node.querySelector('.system-inject-head').onclick();
  assert.equal(node.classList.contains('open'), false);

  // A label-less one-liner has nothing to expand: no arrow, no click handler.
  const single = view.renderMessage({ id: 'u2', role: 'user', content: '🔇继续：请继续未完成的任务' });
  assert.equal(single.querySelector('.system-inject-body'), null);
  assert.equal(single.querySelector('.system-inject-arrow'), null);
  assert.equal(single.querySelector('.system-inject-head').onclick, null);
  assert.equal(single.querySelector('.system-inject-label').textContent, '继续：请继续未完成的任务');
});

test('an injected card never becomes the last-user anchor', () => {
  const { view, messagesEl } = fixture();
  const real = view.commitMessage({ id: 'u1', role: 'user', content: 'real question' });
  assert.equal(real.lastUserElement.dataset.msgId, 'u1');

  const injected = view.commitMessage(
    { id: 'u2', role: 'user', content: '🔇【内置任务已中断】Task x 仍未结束。' },
    { lastUserElement: real.lastUserElement },
  );
  assert.equal(injected.node.classList.contains('system-inject'), true);
  assert.equal(injected.lastUserElement.dataset.msgId, 'u1',
    '注入卡不能顶掉「最后一条用户消息」——自动提交勾选、重发取原文都挂在这个锚点上');

  // The history-replay path must not anchor on it either.
  const plan = view.applyPlan({
    operations: [{ kind: 'append', id: 'u3', message: {
      id: 'u3', role: 'user', content: '🔇【延迟条件已到】请检查当前状态并继续。',
    } }],
    messages: [], hasMore: false, streamingTail: null,
  });
  assert.equal(plan.lastUserElement, null);
  assert.equal(messagesEl.children.length, 3);
  assert.equal(messagesEl.children[2].classList.contains('system-inject'), true);

  // …and a role-tagged commit with no body never lands on the card: the taggable
  // selector skips `.system-inject` entirely (here it falls back to the earlier
  // real bubble instead).
  const card = messagesEl.children[2];
  assert.equal(card.querySelector('.system-inject-label').textContent, '延迟条件已到');
  assert.notEqual(view.tagLatestMessage('user', 'u9', 'client-9'), card);
  const later = view.commitMessage({ id: 'u4', role: 'user', content: 'another real question' });
  assert.equal(view.tagLatestMessage('user', 'u10', 'client-10'), later.node, '真用户气泡照旧可被认领');
  assert.equal(later.lastUserElement.dataset.msgId, 'u4');
});

test('duplicate detection still backtracks across an injected card', () => {
  const { view, messagesEl } = fixture();
  const answer = 'the same reply to the same turn, long enough to be contained';
  view.commitMessage({ id: 'a1', role: 'assistant', content: answer });
  view.commitMessage({ id: 'u1', role: 'user', content: '🔇继续：你上一轮提到的外部结果可以推进了。' });
  view.commitMessage({ id: 'a2', role: 'assistant', content: answer + ' (retried)' });
  // If the card were read as a real user turn the walk would stop there and the
  // older copy would survive as a duplicate.
  assert.equal(messagesEl.querySelectorAll('.msg.assistant').length, 1, '🔇 nudge 不是真用户轮，去重照旧');
  assert.ok(view.findById('a2'));
  assert.equal(messagesEl.querySelectorAll('.msg.user').length, 1, '卡片仍带 user 类');
  assert.equal(messagesEl.querySelectorAll('.msg.user:not(.system-inject)').length, 0);
});

test('the rest of the chat UI treats an injected card as a system line', () => {
  const autoCommitSource = fs.readFileSync(path.join(ROOT, 'public/chat-auto-commit-choice.js'), 'utf8');
  assert.match(autoCommitSource, /contains\('system-inject'\)\) return null/,
    '注入卡不挂自动提交勾选');
  const quoteSource = fs.readFileSync(path.join(ROOT, 'public/chat-quote.js'), 'utf8');
  assert.match(quoteSource, /contains\('system-inject'\)\) return 'system'/,
    '引用注入卡时角色算系统，不算「我」');
  // Both live creation paths go through the view's single user-node producer.
  assert.match(CHAT_SOURCE, /const div = chatHistoryView\.createUserNode\(text, clientMsgId\)/);
  assert.match(VIEW_SOURCE, /createUserNode,/);
  // The card styles must land after chat-air.css: they win over
  // `.air-chat .msg.user` on load order, not on specificity.
  assert.ok(HTML.indexOf('chat-air.css') < HTML.indexOf('chat-system-inject.css'));
});
