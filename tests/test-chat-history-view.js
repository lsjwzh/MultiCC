'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createHistoryView } = require('../public/chat-history-view');

const ROOT = path.join(__dirname, '..');
const VIEW_SOURCE = fs.readFileSync(path.join(ROOT, 'public/chat-history-view.js'), 'utf8');
const CHAT_SOURCE = fs.readFileSync(path.join(ROOT, 'public/chat.js'), 'utf8');
const EVENT_SOURCE = fs.readFileSync(path.join(ROOT, 'public/chat-event-controller.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'public/chat.html'), 'utf8');

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

test('script order is local purifier, parser, safety boundary, state, view, host', () => {
  const scripts = [
    'vendor/dompurify/purify.min.js',
    'https://cdn.jsdelivr.net/npm/marked@12.0.1/marked.min.js',
    'safe-markdown.js',
    'chat-history-store.js',
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
