'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createProxyBroadcasters } = require('../src/chat/proxy-broadcast');

function harness() {
  const sent = [];
  const chatBroadcast = (sessionId, msg) => sent.push({ sessionId, msg });
  return { sent, chatBroadcast };
}

test('onDelta broadcasts a part_delta to the originating session', () => {
  const { sent, chatBroadcast } = harness();
  const { onDelta } = createProxyBroadcasters(chatBroadcast);
  onDelta({ type: 'text', text: 'hi' }, { sessionId: 's1', role: 'main', model: 'claude-3' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sessionId, 's1');
  assert.equal(sent[0].msg.type, 'part_delta');
  assert.equal(sent[0].msg.delta.text, 'hi');
});

test('onDelta ignores malformed payloads and swallows broadcast errors', () => {
  const { sent, chatBroadcast } = harness();
  const { onDelta } = createProxyBroadcasters(chatBroadcast);
  onDelta(null, { sessionId: 's1' });
  onDelta({ type: 'text' }, null);
  onDelta({ type: 'text' }, { sessionId: '' });
  const boom = createProxyBroadcasters(() => { throw new Error('boom'); });
  boom.onDelta({ type: 'text' }, { sessionId: 's1' });
  assert.equal(sent.length, 0);
});

test('onRateLimit broadcasts the 5h rate-limit DTO to the originating session', () => {
  const { sent, chatBroadcast } = harness();
  const { onRateLimit } = createProxyBroadcasters(chatBroadcast);
  onRateLimit({ sessionId: 's1', rateLimitInfo: { rateLimitType: 'five_hour', status: 'allowed', utilization: 0.5, resetsAt: 123 } });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sessionId, 's1');
  assert.equal(sent[0].msg.type, 'rate_limit_event');
  assert.deepEqual(sent[0].msg.rate_limit_info, { rateLimitType: 'five_hour', status: 'allowed', utilization: 0.5, resetsAt: 123 });
});

test('onRateLimit ignores payloads missing sessionId or rateLimitInfo', () => {
  const { sent, chatBroadcast } = harness();
  const { onRateLimit } = createProxyBroadcasters(chatBroadcast);
  onRateLimit({ sessionId: 's1' });
  onRateLimit({ rateLimitInfo: { status: 'allowed' } });
  onRateLimit(null);
  const boom = createProxyBroadcasters(() => { throw new Error('boom'); });
  boom.onRateLimit({ sessionId: 's1', rateLimitInfo: { status: 'allowed' } });
  assert.equal(sent.length, 0);
});
