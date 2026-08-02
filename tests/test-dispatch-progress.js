'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createSafeProgressReducer,
  reasoningDeltaFromPart,
  textDeltaFromPart,
} = require('../src/dispatch/progress');

test('sync dispatch progress forwards text and safe tool names but never tool payloads', () => {
  const progress = [];
  const reducer = createSafeProgressReducer(update => progress.push(update));
  reducer.push({
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'checking' },
        { type: 'tool_use', name: 'Read', input: { secret: 'must-not-leak' } },
      ],
    },
  });
  reducer.push({
    type: 'assistant',
    message: { textSnapshot: true, content: [{ type: 'text', text: 'checking done' }] },
  });
  assert.deepEqual(progress, [
    { kind: 'text', message: 'checking' },
    { kind: 'tool', message: '正在执行：Read' },
    { kind: 'text', message: ' done' },
  ]);
  assert.doesNotMatch(JSON.stringify(progress), /must-not-leak/);
});

test('proxy text deltas use an allow-list instead of recursively exposing JSON', () => {
  assert.equal(textDeltaFromPart({ type: 'text', text: 'normalized' }), 'normalized');
  assert.equal(textDeltaFromPart({
    type: 'content_block_delta', delta: { type: 'text_delta', text: 'delta' },
  }), 'delta');
  assert.equal(textDeltaFromPart({
    type: 'tool_delta', input: { token: 'secret' },
  }), '');
});

test('sync dispatch streams normalized and Claude reasoning without private metadata', () => {
  const progress = [];
  const reducer = createSafeProgressReducer(update => progress.push(update));

  reducer.push({
    type: 'part_delta',
    delta: { type: 'reasoning', text: 'inspect ', raw: { apiKey: 'sidecar-secret' } },
  });
  reducer.push({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: { type: 'thinking_delta', thinking: 'the contract', signature: 'delta-signature' },
    },
  });
  reducer.push({
    type: 'assistant',
    message: {
      content: [{
        type: 'thinking',
        thinking: 'inspect the contract',
        signature: 'final-signature',
      }],
    },
  });

  assert.deepEqual(progress, [
    { kind: 'reasoning', message: 'inspect ' },
    { kind: 'reasoning', message: 'the contract' },
  ]);
  assert.doesNotMatch(JSON.stringify(progress), /sidecar-secret|signature/);
});

test('completed adapter reasoning is forwarded when no live delta was available', () => {
  const progress = [];
  const reducer = createSafeProgressReducer(update => progress.push(update));
  reducer.push({ type: 'reasoning', id: 'reason-1', text: 'verify the fallback', snapshot: true });
  reducer.push({
    type: 'assistant',
    message: {
      content: [{
        type: 'tool_use', name: 'Thinking', id: 'reason-1',
        input: { text: 'verify the fallback', secret: 'must-not-cross' },
      }],
    },
  });
  reducer.push({ type: 'reasoning', id: 'reason-1', text: 'verify the fallback', snapshot: true });
  assert.deepEqual(progress, [
    { kind: 'reasoning', message: 'verify the fallback' },
  ]);
  assert.doesNotMatch(JSON.stringify(progress), /must-not-cross/);
});

test('reasoning allow-list ignores redacted blocks, signatures, and arbitrary objects', () => {
  assert.equal(reasoningDeltaFromPart({
    type: 'content_block_delta',
    delta: { type: 'thinking_delta', thinking: 'visible', signature: 'secret' },
  }), 'visible');
  assert.equal(reasoningDeltaFromPart({
    type: 'content_block_delta',
    delta: { type: 'signature_delta', signature: 'secret' },
  }), '');
  assert.equal(reasoningDeltaFromPart({
    type: 'redacted_thinking', data: 'secret',
  }), '');
  assert.equal(reasoningDeltaFromPart({
    type: 'reasoning', text: { nested: 'secret' },
  }), '');
});

test('Claude sync progress uses native stream events and drops duplicate proxy sidecars', () => {
  const progress = [];
  const reducer = createSafeProgressReducer(update => progress.push(update), { cli: 'claude' });
  reducer.push({
    type: 'part_delta', delta: { type: 'reasoning', text: 'duplicate thought' },
  });
  reducer.push({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: { type: 'thinking_delta', thinking: 'native thought' },
    },
  });
  assert.deepEqual(progress, [
    { kind: 'reasoning', message: 'native thought' },
  ]);
});
