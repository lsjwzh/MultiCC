'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const quote = require('../public/chat-quote');

const ROOT = path.join(__dirname, '..');
const zh = JSON.parse(fs.readFileSync(path.join(ROOT, 'app/assets/i18n/zh.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'app/assets/i18n/en.json'), 'utf8'));

// The real translator substitutes {name} placeholders; the module only ever
// asks for the keys this file declares, so a two-line stand-in keeps the
// assertions about wording and not about the i18n runtime.
function catalogT(catalog) {
  return (key, params) => {
    const value = catalog[key];
    assert.ok(typeof value === 'string', `missing catalog key ${key}`);
    return String(value).replace(/\{(\w+)\}/g, (_, name) => String(params?.[name] ?? ''));
  };
}
const zhT = catalogT(zh);
const enT = catalogT(en);

const TS = new Date(2026, 8, 14, 1, 56).getTime();

function attributed(overrides = {}) {
  return {
    role: 'assistant',
    ts: TS,
    taskId: 'tsk_36ec81e8',
    taskName: '完善登录页面',
    sourceSessionId: 'codex-claude-chat-06',
    sourceMessageId: 'm_abc123',
    text: '登录接口已经改成走统一网关。',
    ...overrides,
  };
}

// ── formatQuote ──────────────────────────────────────────────────────────────

test('a quote carries the subtask, not just the words', () => {
  const block = quote.formatQuote(attributed(), zhT);
  const [header, body] = block.split('\n');
  assert.equal(header, '> 【引用】任务「完善登录页面」（tsk_36ec81e8） · 助手 · 09-14 01:56 · codex-claude-chat-06:m_abc123');
  assert.equal(body, '> 登录接口已经改成走统一网关。');
});

test('the message identity is the handle the task-context reader takes', () => {
  const block = quote.formatQuote(attributed(), zhT);
  // `<sessionId>:<messageId>` — exactly what /context?message_id= resolves.
  assert.ok(block.includes('codex-claude-chat-06:m_abc123'), block);
});

test('each line of the body is quoted on its own', () => {
  const block = quote.formatQuote(attributed({ text: '第一行\n\n第三行' }), zhT);
  assert.deepEqual(block.split('\n').slice(1), ['> 第一行', '>', '> 第三行']);
});

test('a quote from a plain conversation does not invent a task', () => {
  const block = quote.formatQuote(attributed({ taskId: undefined, taskName: undefined }), zhT);
  assert.ok(block.startsWith('> 【引用】本会话 · 助手 · '), block);
  assert.ok(!block.includes('任务'), block);
});

test('a named task without an id still names the task', () => {
  const block = quote.formatQuote(attributed({ taskId: undefined }), zhT);
  assert.ok(block.includes('任务「完善登录页面」 ·'), block);
});

test('an unpersisted message says so instead of pointing at nothing', () => {
  const block = quote.formatQuote(attributed({ sourceSessionId: undefined, sourceMessageId: undefined }), zhT);
  assert.ok(block.includes('· 未落库'), block);
});

test('roles are labelled for the reader and the model', () => {
  assert.ok(quote.formatQuote(attributed({ role: 'user' }), zhT).includes('· 你 ·'));
  assert.ok(quote.formatQuote(attributed({ role: 'assistant' }), zhT).includes('· 助手 ·'));
  assert.ok(quote.formatQuote(attributed({ role: 'system' }), zhT).includes('· 系统 ·'));
});

test('the block is written in the reader\'s language', () => {
  const block = quote.formatQuote(attributed({ role: 'user' }), enT);
  assert.equal(block.split('\n')[0],
    '> [quote] task "完善登录页面" (tsk_36ec81e8) · you · 09-14 01:56 · codex-claude-chat-06:m_abc123');
});

test('a long message is clipped and the clip is stated', () => {
  const text = 'x'.repeat(quote.MAX_CHARS + 250);
  const block = quote.formatQuote(attributed({ text }), zhT);
  assert.ok(block.includes('x'.repeat(quote.MAX_CHARS)), 'keeps the head');
  assert.ok(!block.includes('x'.repeat(quote.MAX_CHARS + 1)), 'drops the tail');
  assert.ok(block.includes(`（引用已截断，原文共 ${text.length} 字）`), block.slice(-80));
});

test('a message right at the limit is quoted whole and not flagged', () => {
  const text = 'y'.repeat(quote.MAX_CHARS);
  const block = quote.formatQuote(attributed({ text }), zhT);
  assert.ok(block.includes('y'.repeat(quote.MAX_CHARS)));
  assert.ok(!block.includes('截断'), block);
});

test('there is nothing to quote when there is nothing to say', () => {
  assert.equal(quote.formatQuote(attributed({ text: '   \n  ' }), zhT), '');
  assert.equal(quote.formatQuote(attributed({ text: '' }), zhT), '');
  assert.equal(quote.formatQuote(null, zhT), '');
  assert.equal(quote.formatQuote('not a message', zhT), '');
});

test('a message with no timestamp still quotes, just without a clock', () => {
  const block = quote.formatQuote(attributed({ ts: undefined, text: '没有时间戳' }), zhT);
  assert.ok(block.includes('· 助手 ·  · codex-claude-chat-06:m_abc123'), block);
});

// ── fromNode / insert ────────────────────────────────────────────────────────

class FakeClassList {
  constructor(values) { this.values = new Set(values); }
  contains(value) { return this.values.has(value); }
}

function matchesSelector(node, selector) {
  return selector.startsWith('.')
    ? node.classList.contains(selector.slice(1))
    : node.tagName === selector.toUpperCase();
}

// Faithful enough to be worth testing against: textContent is computed from the
// tree (so removing a button really removes its glyph) and the tree is what
// querySelector walks. A stub with a static textContent would have passed even
// when the buttons leaked into the quote.
function fakeNode({ tagName = 'div', classes = [], dataset = {}, children = [], text = '' } = {}) {
  const node = {
    tagName,
    classList: new FakeClassList(classes),
    dataset: { ...dataset },
    children,
    parent: null,
    get textContent() {
      return this.children.length ? this.children.map(child => child.textContent).join('') : text;
    },
    cloneNode() {
      return fakeNode({
        tagName,
        classes,
        dataset,
        children: children.map(child => child.cloneNode()),
        text,
      });
    },
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    querySelectorAll(selector) {
      const out = [];
      const visit = list => list.forEach(child => {
        if (matchesSelector(child, selector)) out.push(child);
        visit(child.children);
      });
      visit(this.children);
      return out;
    },
  };
  for (const child of children) child.parent = node;
  return node;
}

test('a bubble is read off its own DOM: provenance plus the text without the buttons', () => {
  // The delete/fork/quote buttons live inside the bubble, so their glyphs are in
  // the bubble's textContent and must not end up in the quote.
  const markdown = fakeNode({ classes: ['message-markdown'], text: '被引用的正文' });
  const content = fakeNode({ classes: ['msg-content'], children: [markdown] });
  const del = fakeNode({ tagName: 'button', classes: ['msg-del'], text: '✕' });
  const fork = fakeNode({ tagName: 'button', classes: ['msg-fork'], text: '⧉' });
  const node = fakeNode({
    classes: ['msg', 'assistant'],
    dataset: { msgId: 'codex-claude-chat-06:m_abc123', taskId: 'tsk_36ec81e8', taskName: '完善登录页面',
      sourceSessionId: 'codex-claude-chat-06', sourceMessageId: 'm_abc123', ts: String(TS) },
    children: [content, del, fork],
  });
  assert.equal(node.textContent, '被引用的正文✕⧉', 'the buttons really are inside the bubble');
  const block = quote.fromNode(node, zhT);
  assert.equal(block.split('\n')[0],
    '> 【引用】任务「完善登录页面」（tsk_36ec81e8） · 助手 · 09-14 01:56 · codex-claude-chat-06:m_abc123');
  assert.equal(block.split('\n')[1], '> 被引用的正文');
  assert.ok(!block.includes('✕') && !block.includes('⧉'), 'action buttons are not part of the quote');
});

test('an assistant bubble quotes its exact source, not the rendered markdown', () => {
  const content = fakeNode({ classes: ['msg-content'], text: '加粗 的正文' });
  const node = fakeNode({
    classes: ['msg', 'assistant'],
    dataset: { msgId: 'm1', role: 'assistant', rawText: '**加粗** 的正文' },
    children: [content],
  });
  assert.equal(quote.fromNode(node, zhT).split('\n')[1], '> **加粗** 的正文');
});

test('a bubble with no provenance still quotes as the current conversation', () => {
  const node = fakeNode({ classes: ['msg', 'user'], dataset: { msgId: 'm1' }, text: '就这样' });
  const block = quote.fromNode(node, zhT);
  assert.ok(block.startsWith('> 【引用】本会话 · 你 · '), block);
  assert.equal(block.split('\n').slice(1).join('\n'), '> 就这样');
});

test('an empty bubble produces no quote at all', () => {
  assert.equal(quote.fromNode(fakeNode({ classes: ['msg', 'user'], dataset: { msgId: 'm1' }, text: '  ' }), zhT), '');
  assert.equal(quote.fromNode(null, zhT), '');
});

function fakeDoc(input) {
  return { getElementById: id => (id === 'input' ? input : null) };
}

test('quoting lands above the draft instead of replacing it', () => {
  const seen = [];
  const input = {
    value: '顺便把审核也做了',
    dispatchEvent(event) { seen.push(event.type); },
    focus() { this.focused = true; },
    setSelectionRange(start, end) { this.caret = [start, end]; },
  };
  const ok = quote.insert('> 引用块', fakeDoc(input));
  assert.equal(ok, true);
  assert.equal(input.value, '> 引用块\n\n顺便把审核也做了');
  // The composer grows the textarea and the Air host stores the per-task draft
  // from a real input event — assigning .value fires nothing.
  assert.deepEqual(seen, ['input']);
  assert.equal(input.focused, true);
  assert.deepEqual(input.caret, [input.value.length, input.value.length]);
});

test('an empty box gets the quote and a place to type', () => {
  const input = { value: '', dispatchEvent() {}, focus() {}, setSelectionRange() {} };
  quote.insert('> 引用块', fakeDoc(input));
  assert.equal(input.value, '> 引用块\n\n');
});

test('a leading blank line in the draft is not doubled', () => {
  const input = { value: '\n\n草稿', dispatchEvent() {}, focus() {}, setSelectionRange() {} };
  quote.insert('> 引用块', fakeDoc(input));
  assert.equal(input.value, '> 引用块\n\n草稿');
});

test('no composer means no quote, and no throw', () => {
  assert.equal(quote.insert('> 引用块', { getElementById: () => null }), false);
  assert.equal(quote.insert(''), false);
  const input = { value: 'draft', dispatchEvent() {}, focus() {}, setSelectionRange() {} };
  assert.equal(quote.quoteInto(fakeNode({ classes: ['msg', 'user'], dataset: {}, text: '' }), fakeDoc(input)), false);
  assert.equal(input.value, 'draft', 'an unquotable bubble must not disturb the draft');
});
