'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createProxyBroadcasters } = require('../src/chat/proxy-broadcast');
const { createProviderAttemptRuntime } = require('../src/chat/provider-attempt-runtime');

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

test('onDelta scrubs a model-echoed route capability before the wire boundary', () => {
  const { sent, chatBroadcast } = harness();
  const { onDelta } = createProxyBroadcasters(chatBroadcast);
  onDelta({
    type: 'text',
    text: 'pr1.c2Vzc2lvbi0x.cHJveHktcm91dGUtc2VjcmV0',
  }, { sessionId: 's1', role: 'main', model: 'claude-3' });
  assert.equal(sent.length, 1);
  assert.doesNotMatch(JSON.stringify(sent[0].msg), /pr1\./);
  assert.match(sent[0].msg.delta.text, /REDACTED_PROVIDER_ROUTE/);
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

test('onDelta attributes accepted main proxy deltas to the bound provider attempt', () => {
  const { sent, chatBroadcast } = harness();
  const observed = [];
  const attemptRuntime = {
    observeProxyDelta(delta, ctx) {
      observed.push({ delta, ctx });
      return {
        accepted: true,
        sessionId: 's1',
        runtimeEpoch: 'epoch-1',
        turnId: 'turn-1',
        decisionId: 'decision-1',
        routeAttemptId: 'attempt-1',
        routeGeneration: 3,
        attemptNo: 2,
        providerId: 'provider-actual',
        providerRevision: 'revision-7',
      };
    },
    scrubAttemptEvent(_attempt, event) { return event; },
  };
  const { onDelta } = createProxyBroadcasters(chatBroadcast, { attemptRuntime });
  const delta = { type: 'text', text: 'bound' };
  const ctx = {
    sessionId: 's1', role: 'main', model: 'model-actual', providerId: 'provider-actual',
  };

  onDelta(delta, ctx);

  assert.deepEqual(observed, [{ delta, ctx }]);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].msg, {
    type: 'part_delta',
    sessionId: 's1',
    role: 'main',
    model: 'model-actual',
    delta,
    providerRouteScope: 'attempt',
    runtimeEpoch: 'epoch-1',
    turnId: 'turn-1',
    decisionId: 'decision-1',
    routeAttemptId: 'attempt-1',
    routeGeneration: 3,
    attemptNo: 2,
    providerId: 'provider-actual',
    providerRevision: 'revision-7',
  });
});

test('onDelta fails closed and audits unbound, ambiguous, ended, or errored proxy deltas', () => {
  const { sent, chatBroadcast } = harness();
  const audited = [];
  const results = [
    { accepted: false, code: 'proxy_attempt_unbound' },
    { accepted: false, code: 'proxy_attempt_ambiguous' },
    { accepted: false, code: 'proxy_attempt_ended' },
  ];
  const attemptRuntime = {
    observeProxyDelta() {
      const result = results.shift();
      if (result) return result;
      throw new Error('runtime unavailable');
    },
  };
  const { onDelta } = createProxyBroadcasters(chatBroadcast, {
    attemptRuntime,
    audit: (sessionId, event) => audited.push({ sessionId, event }),
  });

  for (let i = 0; i < 4; i += 1) {
    onDelta({ type: 'text', text: `late-${i}` }, {
      sessionId: 's1', role: 'main', providerId: 'provider-a',
    });
  }

  assert.equal(sent.length, 0);
  assert.deepEqual(audited.map(entry => entry.event.code), [
    'proxy_attempt_unbound',
    'proxy_attempt_ambiguous',
    'proxy_attempt_ended',
    'attempt_runtime_error',
  ]);
  assert.ok(audited.every(entry => entry.sessionId === 's1'));
  assert.ok(audited.every(entry => entry.event.type === 'proxy_part_delta_dropped'));
});

test('onDelta never forwards subagent proxy deltas into the main chat stream', () => {
  const { sent, chatBroadcast } = harness();
  let observed = 0;
  const audited = [];
  const { onDelta } = createProxyBroadcasters(chatBroadcast, {
    attemptRuntime: { observeProxyDelta: () => { observed += 1; return { accepted: true }; } },
    audit: (sessionId, event) => audited.push({ sessionId, event }),
  });

  onDelta({ type: 'text', text: 'sub output' }, {
    sessionId: 's1', role: 'sub', providerId: 'provider-a',
  });

  assert.equal(observed, 0);
  assert.equal(sent.length, 0);
  assert.equal(audited[0].event.code, 'non_main_role');
});

test('onRateLimit broadcasts the 5h rate-limit DTO to the originating session', () => {
  const { sent, chatBroadcast } = harness();
  const { onRateLimit } = createProxyBroadcasters(chatBroadcast);
  onRateLimit({ sessionId: 's1', providerId: 'provider-actual', rateLimitInfo: { rateLimitType: 'five_hour', status: 'allowed', utilization: 0.5, resetsAt: 123 } });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sessionId, 's1');
  assert.equal(sent[0].msg.type, 'rate_limit_event');
  assert.equal(sent[0].msg.providerId, 'provider-actual');
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

test('onRateLimit uses the exact active attempt and drops an unbound producer', () => {
  const { sent, chatBroadcast } = harness();
  const audited = [];
  let bound = true;
  const attemptRuntime = {
    attributeProxyUsage(info) {
      if (!bound) return info;
      return {
        ...info, routeAttribution: 'exact', runtimeEpoch: 'epoch-1', turnId: 'turn-1',
        decisionId: 'decision-1', routeAttemptId: 'attempt-1', routeGeneration: 7,
        attemptNo: 3, providerId: 'provider-actual', providerRevision: 'revision-7',
      };
    },
  };
  const { onRateLimit } = createProxyBroadcasters(chatBroadcast, {
    attemptRuntime,
    audit: (sessionId, event) => audited.push({ sessionId, event }),
  });
  const info = {
    sessionId: 's1', role: 'main', providerId: 'provider-actual',
    rateLimitInfo: { rateLimitType: 'five_hour', status: 'allowed', utilization: 0.2 },
  };

  onRateLimit(info);
  assert.equal(sent.length, 1);
  assert.deepEqual({
    providerRouteScope: sent[0].msg.providerRouteScope,
    runtimeEpoch: sent[0].msg.runtimeEpoch,
    routeAttemptId: sent[0].msg.routeAttemptId,
    routeGeneration: sent[0].msg.routeGeneration,
    providerId: sent[0].msg.providerId,
  }, {
    providerRouteScope: 'attempt', runtimeEpoch: 'epoch-1',
    routeAttemptId: 'attempt-1', routeGeneration: 7, providerId: 'provider-actual',
  });

  bound = false;
  onRateLimit(info);
  assert.equal(sent.length, 1);
  assert.equal(audited.at(-1).event.code, 'rate_limit_attempt_unbound');
});

test('attempt capability is consumed server-side and never becomes a client/cache session id', () => {
  const { sent, chatBroadcast } = harness();
  const recorded = [];
  const audited = [];
  let sequence = 0;
  const attemptRuntime = createProviderAttemptRuntime({
    runtimeEpoch: 'epoch-1', nextId: prefix => `${prefix}-${++sequence}`,
  });
  const attempt = attemptRuntime.beginAttempt({
    sessionId: 's1', turnId: 'turn-1', cli: 'claude', providerId: 'provider-a',
    providerName: 'Provider A', protocol: 'anthropic', model: 'model-a',
    providerRevision: 'revision-a', subagentProviderId: 'provider-sub', attemptNo: 1,
  });
  const proxySessionId = attemptRuntime.proxySessionId(attempt);
  assert.equal(attemptRuntime.authorizeProxyRequest({
    sessionId: proxySessionId, providerId: 'provider-a', role: 'main',
  }).ok, true);
  attemptRuntime.onProxyActivity({
    sessionId: proxySessionId, providerId: 'provider-a', role: 'main', phase: 'request',
  });
  const { onDelta, onRateLimit } = createProxyBroadcasters(chatBroadcast, {
    attemptRuntime,
    recordLimit: (...args) => recorded.push(args),
    audit: (sessionId, event) => audited.push({ sessionId, event }),
  });

  onDelta({ type: 'text', text: 'hello' }, {
    sessionId: proxySessionId, providerId: 'provider-a', role: 'main', model: 'model-a',
  });
  onRateLimit({
    sessionId: proxySessionId, providerId: 'provider-a', role: 'main',
    rateLimitInfo: { rateLimitType: 'five_hour', status: 'allowed', utilization: 0.1 },
  });

  assert.deepEqual(sent.map(item => item.sessionId), ['s1', 's1']);
  assert.equal(sent.every(item => item.msg.sessionId === 's1'), true);
  assert.deepEqual(recorded.map(args => args[0]), ['s1']);
  assert.equal(JSON.stringify({ sent, recorded, audited }).includes(proxySessionId), false);

  attemptRuntime.onProxyActivity({
    sessionId: proxySessionId, providerId: 'provider-sub', role: 'sub', phase: 'request',
  });
  onRateLimit({
    sessionId: proxySessionId, providerId: 'provider-sub', role: 'sub',
    rateLimitInfo: { rateLimitType: 'five_hour', status: 'allowed', utilization: 0.2 },
  });
  assert.equal(sent.length, 2, 'sub quota is provider-wide cache data, not a main-turn UI frame');
  assert.deepEqual(recorded.at(-1).slice(0, 3), [
    's1', { rateLimitType: 'five_hour', status: 'allowed', utilization: 0.2 }, 'provider-sub',
  ]);
});

test('proxy broadcaster scrubs a capability even when every delta carries one byte', () => {
  const { sent, chatBroadcast } = harness();
  let sequence = 0;
  const attemptRuntime = createProviderAttemptRuntime({
    runtimeEpoch: 'epoch-1', nextId: prefix => `${prefix}-${++sequence}`,
  });
  const attempt = attemptRuntime.beginAttempt({
    sessionId: 's1', turnId: 'turn-1', cli: 'claude', providerId: 'provider-a',
    providerName: 'Provider A', protocol: 'anthropic', model: 'model-a',
    providerRevision: 'revision-a', attemptNo: 1,
  });
  const capability = attemptRuntime.proxySessionId(attempt);
  const ctx = {
    sessionId: capability, providerId: 'provider-a', role: 'main', model: 'model-a',
  };
  attemptRuntime.onProxyActivity({ ...ctx, phase: 'request' });
  const { onDelta } = createProxyBroadcasters(chatBroadcast, { attemptRuntime });

  for (const char of capability) onDelta({ type: 'text', text: char }, ctx);

  assert.equal(sent.map(item => item.msg.delta.text).join(''), '[REDACTED_PROVIDER_ROUTE]');
  assert.equal(JSON.stringify(sent).includes(capability), false);
});
