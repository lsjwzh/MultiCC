'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createSafeProgressReducer,
  createDispatchProgressSubscription,
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

test('dispatch progress subscription filters by session and operation lineage, then unsubscribes', () => {
  const handlers = new Set();
  const bus = {
    on: (topic, fn) => handlers.add(fn),
    off: (topic, fn) => handlers.delete(fn),
  };
  const turns = new Map([
    ['worker-1', { lineage: { kind: 'dispatch', operationId: 'op-9' } }],
    ['worker-2', { lineage: { kind: 'chat' } }],
  ]);
  const replays = new Map([
    ['worker-1', [{ type: 'assistant', message: { content: [{ type: 'text', text: 'early' }] } }]],
  ]);
  const subscribe = createDispatchProgressSubscription({
    bus,
    cliOf: () => 'claude',
    activeTurnOf: id => turns.get(id),
    streamReplayOf: id => replays.get(id),
  });

  const progress = [];
  const unsubscribe = subscribe({ operationId: 'op-9', targetSessionId: 'worker-1', onProgress: u => progress.push(u) });
  // Replay: the turn already belonged to op-9 when the listener attached, so
  // the buffered early deltas are delivered before any live event.
  assert.deepEqual(progress.map(u => u.message), ['early']);

  const emit = payload => { for (const h of handlers) h('worker-1', payload); };
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'live' }] } });
  assert.deepEqual(progress.map(u => u.message), ['early', 'live']);

  // Cross-session and cross-operation events never reach the reducer.
  turns.set('worker-1', { lineage: { kind: 'dispatch', operationId: 'op-other' } });
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'not mine' }] } });
  assert.deepEqual(progress.map(u => u.message), ['early', 'live']);

  unsubscribe();
  turns.set('worker-1', { lineage: { kind: 'dispatch', operationId: 'op-9' } });
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'after detach' }] } });
  assert.deepEqual(progress.map(u => u.message), ['early', 'live']);
});

test('dispatch progress subscription requires a real bus', () => {
  assert.throws(() => createDispatchProgressSubscription({}), /requires a bus/);
});
