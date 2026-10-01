'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { fitHistoryFrame } = require('../src/chat/history-frame-budget');
const { DEFAULTS, installWsBackpressure } = require('../src/ws-backpressure');

const big = n => 'x'.repeat(n);
const bytes = messages => Buffer.byteLength(JSON.stringify(messages));

test('a page under budget passes through untouched', () => {
  const messages = [{ id: 'a', role: 'user', content: 'hi' }];
  const fitted = fitHistoryFrame(messages, false);
  assert.equal(fitted.messages, messages);
  assert.deepEqual([fitted.hasMore, fitted.dropped, fitted.clipped], [false, 0, false]);
});

test('oldest messages go first and hasMore tells the page to fetch them', () => {
  const messages = [
    { id: 'a', role: 'assistant', content: big(600) },
    { id: 'b', role: 'user', content: 'q' },
    { id: 'c', role: 'assistant', content: big(300) },
  ];
  const fitted = fitHistoryFrame(messages, false, { maxBytes: 500 });
  assert.deepEqual(fitted.messages.map(m => m.id), ['b', 'c']);
  assert.equal(fitted.hasMore, true);
  assert.equal(fitted.clipped, false);
});

test('a single oversize turn keeps its prose and clips only tool strings, never the source', () => {
  const tool = { name: 'Thinking', id: 't', input: { text: big(5000) }, result: big(5000) };
  const message = { id: 'a', role: 'assistant', content: 'answer', tools: [tool] };
  const fitted = fitHistoryFrame([message], false, { maxBytes: 1000, toolStringChars: 100 });
  assert.equal(fitted.messages.length, 1);
  assert.equal(fitted.clipped, true);
  assert.equal(fitted.messages[0].content, 'answer');
  assert.match(fitted.messages[0].tools[0].input.text, /truncated 4900 chars/);
  assert.equal(tool.input.text.length, 5000, 'persisted message must not be mutated');
});

test('the 2026-10-01 shape (4 messages, 9MB of tools) fits under the WS frame cap', () => {
  const tools = Array.from({ length: 150 }, (_, i) => ({ name: 'Thinking', id: `t${i}`, input: { text: big(40000) } }));
  const page = [
    { id: 'u1', role: 'user', content: 'q1' },
    { id: 'a1', role: 'assistant', content: 'r1', tools },
    { id: 'u2', role: 'user', content: 'q2' },
    { id: 'a2', role: 'assistant', content: 'r2', tools },
  ];
  assert.ok(bytes(page) > DEFAULTS.maxFrameBytes);
  const fitted = fitHistoryFrame(page, false);
  const frame = JSON.stringify({ type: 'chat_history', messages: fitted.messages, hasMore: fitted.hasMore });
  let closed = null;
  const ws = { send: (d, o, cb) => cb && setImmediate(cb), close: code => { closed = code; }, bufferedAmount: 0 };
  installWsBackpressure(ws);
  ws.send(frame);
  assert.equal(closed, null);
  assert.equal(fitted.hasMore, true);
  assert.equal(fitted.messages.at(-1).id, 'a2', 'newest turn is always kept');
});
