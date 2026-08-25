'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createProviderRevision,
  createProviderAttemptRuntime,
  fenceForEvent,
  markHostErrorEnvelope,
  scopeHostProviderEvent,
  tagProviderAttemptEvent,
} = require('../src/chat/provider-attempt-runtime');
const { createTaskRunProviderBridge } = require('../src/task-run-provider-bridge');
const { createUsageObserved } = require('../src/usage-observed');

function harness() {
  let sequence = 0;
  const events = [];
  const audit = [];
  const runtime = createProviderAttemptRuntime({
    runtimeEpoch: 'runtime-epoch-1',
    now: () => 1_000 + sequence,
    nextId: prefix => `${prefix}-${++sequence}`,
    emit: (sessionId, event) => events.push({ sessionId, event }),
    audit: (sessionId, event) => audit.push({ sessionId, event }),
  });
  return { runtime, events, audit };
}

test('route-sensitive host frames receive explicit scope without rewriting attempt frames', () => {
  const host = scopeHostProviderEvent({ type: 'result', total_cost_usd: null });
  assert.equal(host.providerRouteScope, 'host');
  const attempt = { type: 'result', providerRouteScope: 'attempt', routeAttemptId: 'a-1' };
  assert.equal(scopeHostProviderEvent(attempt), attempt);
  const unrelated = { type: 'notify', state: 'completed' };
  assert.equal(scopeHostProviderEvent(unrelated), unrelated);
  const capability = 'pr1.c2Vzc2lvbi0x.cHJveHktcm91dGUtc2VjcmV0';
  const toolResult = scopeHostProviderEvent({
    type: 'user', message: { content: [{ type: 'tool_result', content: capability }] },
  });
  assert.doesNotMatch(JSON.stringify(toolResult), /pr1\./,
    'the journal/client boundary must scrub a model-readable route capability');
});

function route(overrides = {}) {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    cli: 'codex',
    providerId: 'provider-a',
    providerName: 'Provider A',
    protocol: 'openai_responses',
    model: 'model-a',
    providerRevision: 'revision-a',
    attemptNo: 1,
    ...overrides,
  };
}

function proxy(runtime, attempt, overrides = {}) {
  return {
    sessionId: runtime.proxySessionId(attempt),
    role: 'main',
    providerId: attempt.providerId,
    ...overrides,
  };
}

test('a concrete attempt has immutable identity and a monotonic session generation', () => {
  const { runtime, events } = harness();
  const first = runtime.beginAttempt(route());
  assert.equal(first.providerId, 'provider-a');
  assert.equal(first.runtimeEpoch, 'runtime-epoch-1');
  assert.equal(first.attemptNo, 1);
  assert.equal(first.routeGeneration, 1);
  assert.equal(first.providerRevision, 'revision-a');
  assert.equal(first.replayFence, 'none');
  assert.equal(first.safeToReplay, true);
  assert.equal(Object.isFrozen(first), true);
  assert.deepEqual(events.map(item => item.event.phase), ['selected']);
  assert.equal(events[0].event.providerRouteScope, 'attempt');

  assert.equal(runtime.finishAttempt(first, { outcome: 'failed', errorCategory: 'billing_quota' }).ok, true);
  const second = runtime.beginAttempt(route({
    providerId: 'provider-b', providerName: 'Provider B', model: 'model-b', attemptNo: 2,
  }));
  assert.equal(second.routeGeneration, 2);
  assert.equal(second.decisionId, first.decisionId, 'one logical turn owns one route decision');
  assert.notEqual(second.routeAttemptId, first.routeAttemptId);
  assert.deepEqual(events.map(item => item.event.phase), ['selected', 'failed', 'switched']);
});

test('visible proxy deltas close the replay fence before authoritative CLI output arrives', () => {
  const { runtime } = harness();
  const attempt = runtime.beginAttempt(route());
  runtime.onProxyActivity(proxy(runtime, attempt, { phase: 'request' }));
  const observed = runtime.observeProxyDelta(
    { type: 'text', text: 'visible preview' },
    proxy(runtime, attempt, { model: 'model-a' }),
  );
  assert.equal(observed.accepted, true);
  assert.equal(observed.routeAttemptId, attempt.routeAttemptId);
  assert.equal(observed.routeGeneration, attempt.routeGeneration);
  assert.equal(observed.replayFence, 'visible_output');
  assert.equal(observed.safeToReplay, false);
  assert.equal(runtime.snapshot('session-1').visibleOutputObserved, true);

  runtime.onProxyActivity(proxy(runtime, attempt, { phase: 'end' }));
  assert.equal(runtime.observeProxyDelta(
    { type: 'text', text: 'late' },
    proxy(runtime, attempt, { model: 'model-a' }),
  ).accepted, false, 'a delta after the producer end cannot re-enter the chat stream');
});

test('attempt delta scrubbing never releases a capability split at any byte boundary', () => {
  const { runtime } = harness();
  const attempt = runtime.beginAttempt(route({ cli: 'claude', protocol: 'anthropic' }));
  const capability = runtime.proxySessionId(attempt);
  const streamOutput = [...capability].map(char => runtime.scrubAttemptEvent(attempt, {
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: char } },
  }).event.delta.text).join('');
  assert.equal(streamOutput, '[REDACTED_PROVIDER_ROUTE]');

  const partOutput = [...capability].map(char => runtime.scrubAttemptEvent(attempt, {
    type: 'part_delta', delta: { type: 'text', text: char },
  }).delta.text).join('');
  assert.equal(partOutput, '[REDACTED_PROVIDER_ROUTE]');
  const rawToken = runtime.proxySessionId(attempt).split('.').at(-1);
  const decodedToken = Buffer.from(rawToken, 'base64url').toString('utf8');
  const tokenOutput = [...decodedToken].map(char => runtime.scrubAttemptEvent(attempt, {
    type: 'part_delta', delta: { type: 'text', text: char },
  }).delta.text).join('');
  assert.equal(tokenOutput, '[REDACTED_PROVIDER_ROUTE]');
});

test('attempt semantic scrubbing covers capability keys and key-value fragments without mutating input', () => {
  const { runtime } = harness();
  const attempt = runtime.beginAttempt(route({ cli: 'claude', protocol: 'anthropic' }));
  const capability = runtime.proxySessionId(attempt);
  const split = Math.floor(capability.length / 2);
  const decodedToken = Buffer.from(capability.split('.').at(-1), 'base64url').toString('utf8');
  const tokenSplit = Math.floor(decodedToken.length / 2);
  const event = {
    type: 'assistant',
    message: { content: [
      {
        type: 'tool_use', id: 'tool-key', name: 'Bash',
        input: { [capability]: 'ordinary', [decodedToken]: 'decoded' },
      },
      {
        type: 'tool_use', id: 'tool-split', name: 'Bash',
        input: { [capability.slice(0, split)]: capability.slice(split) },
      },
      {
        type: 'tool_use', id: 'tool-values', name: 'Bash',
        input: { first: capability.slice(0, split), second: capability.slice(split) },
      },
      {
        type: 'tool_use', id: 'tool-decoded', name: 'Bash',
        input: { [decodedToken.slice(0, tokenSplit)]: decodedToken.slice(tokenSplit) },
      },
    ] },
  };

  const safe = runtime.scrubAttemptStructure(attempt, event);
  const [fullKeyBlock, splitBlock, valuesBlock, decodedBlock] = safe.message.content;
  assert.doesNotMatch(Object.keys(fullKeyBlock.input)[0], /pr1\./);
  assert.match(Object.keys(fullKeyBlock.input)[0], /REDACTED_PROVIDER_ROUTE/);
  assert.equal(Object.keys(fullKeyBlock.input).length, 2);
  assert.deepEqual(Object.values(fullKeyBlock.input).sort(), ['decoded', 'ordinary'],
    'two secret keys that redact to one marker retain both values under collision-safe names');
  assert.notEqual(
    Object.keys(splitBlock.input)[0] + Object.values(splitBlock.input)[0],
    capability,
    'a consumer enumerating an input key followed by its value cannot rebuild the capability',
  );
  assert.match(Object.keys(splitBlock.input)[0], /REDACTED_PROVIDER_ROUTE/);
  assert.match(Object.values(splitBlock.input)[0], /REDACTED_PROVIDER_ROUTE/);
  assert.notEqual(Object.values(valuesBlock.input).join(''), capability,
    'consumers joining values from several input fields cannot rebuild the capability');
  assert.equal(Object.values(valuesBlock.input).every(value => (
    value.includes('[REDACTED_PROVIDER_ROUTE]')
  )), true);
  assert.notEqual(
    Object.keys(decodedBlock.input)[0] + Object.values(decodedBlock.input)[0],
    decodedToken,
    'the decoded proxy-route token follows the same semantic DLP boundary',
  );
  assert.match(Object.keys(decodedBlock.input)[0], /REDACTED_PROVIDER_ROUTE/);
  assert.match(Object.values(decodedBlock.input)[0], /REDACTED_PROVIDER_ROUTE/);
  assert.equal(Object.keys(event.message.content[0].input)[0], capability,
    'provider-owned events must remain immutable');
});

test('attempt semantic scrubbing spans assistant and tool-result content blocks exactly', () => {
  const { runtime } = harness();
  const attempt = runtime.beginAttempt(route({ cli: 'claude', protocol: 'anthropic' }));
  const capability = runtime.proxySessionId(attempt);
  const split = Math.floor(capability.length / 2);
  const assistant = runtime.scrubAttemptStructure(attempt, {
    type: 'assistant', message: { content: [
      { type: 'text', text: `before ${capability.slice(0, split)}` },
      { type: 'text', text: `${capability.slice(split)} after` },
    ] },
  });
  const assistantText = assistant.message.content.map(block => block.text).join('');
  assert.equal(assistantText.includes(capability), false);
  assert.equal(assistant.message.content.every(block => (
    block.text.includes('[REDACTED_PROVIDER_ROUTE]')
  )), true, 'every fragment-bearing block is independently non-reconstructable');

  const toolResult = runtime.scrubAttemptStructure(attempt, {
    type: 'user', message: { content: [{
      type: 'tool_result', tool_use_id: 'tool-1', content: [
        { type: 'text', text: capability.slice(0, split) },
        { type: 'text', text: capability.slice(split) },
      ],
    }] },
  });
  const resultBlocks = toolResult.message.content[0].content;
  assert.equal(resultBlocks.map(block => block.text).join('').includes(capability), false);
  assert.equal(resultBlocks.every(block => block.text.includes('[REDACTED_PROVIDER_ROUTE]')), true);
});

test('tool intent and side effects are monotonic replay fences', () => {
  const { runtime } = harness();
  const attempt = runtime.beginAttempt(route());
  assert.equal(fenceForEvent({ type: 'reasoning', text: 'thinking' }), 'visible_output');
  assert.equal(fenceForEvent({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'answer' } },
  }), 'visible_output');
  assert.equal(fenceForEvent({
    type: 'stream_event',
    event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Bash' } },
  }), 'tool_intent');
  assert.equal(fenceForEvent({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{}' } },
  }), 'tool_intent');
  assert.equal(fenceForEvent({
    type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] },
  }), 'tool_intent');
  assert.equal(fenceForEvent({
    type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] },
  }), 'side_effect');

  runtime.observeEvent(attempt, { type: 'reasoning', text: 'thinking' });
  runtime.observeEvent(attempt, {
    type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] },
  });
  runtime.observeEvent(attempt, {
    type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] },
  });
  const state = runtime.snapshot('session-1');
  assert.equal(state.replayFence, 'side_effect');
  assert.equal(state.visibleOutputObserved, true);
  assert.equal(state.toolIntentObserved, true);
  assert.equal(state.sideEffectObserved, true);
  assert.equal(state.safeToReplay, false);
});

test('old attempt generations are rejected after a safe provider switch', () => {
  const { runtime, audit } = harness();
  const first = runtime.beginAttempt(route());
  runtime.finishAttempt(first, { outcome: 'failed', errorCategory: 'rate_limit' });
  const second = runtime.beginAttempt(route({
    providerId: 'provider-b', providerName: 'Provider B', model: 'model-b', attemptNo: 2,
  }));
  assert.equal(runtime.observeEvent(first, { type: 'assistant', message: { content: [{ type: 'text', text: 'secret-late-payload' }] } }).accepted, false);
  const ignored = audit.find(item => item.event.type === 'provider_attempt_late_ignored');
  assert.equal(ignored.event.operation, 'event');
  assert.equal(JSON.stringify(ignored).includes('secret-late-payload'), false,
    'audit-only suppression metadata must not retain payload content');
  assert.equal(runtime.observeEvent(second, { type: 'assistant', message: { content: [{ type: 'text', text: 'current' }] } }).accepted, true);
  assert.equal(runtime.snapshot('session-1').providerId, 'provider-b');
});

test('terminal attempts reject decoded events before any caller mutation can run', () => {
  const { runtime, audit } = harness();
  const attempt = runtime.beginAttempt(route());
  let mutations = 0;
  if (runtime.acceptEvent(attempt)) mutations += 1;
  runtime.finishAttempt(attempt, { outcome: 'failed', errorCategory: 'cancel_shutdown' });
  if (runtime.acceptEvent(attempt)) mutations += 1;
  assert.equal(mutations, 1);
  assert.equal(audit.at(-1).event.operation, 'event_admission');
});

test('proxy usage is attributed to the bound attempt and ambiguity fails closed', () => {
  const { runtime } = harness();
  const attempt = runtime.beginAttempt(route());
  runtime.onProxyActivity(proxy(runtime, attempt, { phase: 'request' }));
  const attributed = runtime.attributeProxyUsage(proxy(runtime, attempt, {
    eventId: 'usage-1', roleKind: 'main',
  }));
  assert.equal(attributed.routeAttemptId, attempt.routeAttemptId);
  assert.equal(attributed.routeGeneration, attempt.routeGeneration);
  assert.equal(attributed.turnId, 'turn-1');

  runtime.onProxyActivity(proxy(runtime, attempt, { phase: 'request' }));
  const ambiguous = runtime.attributeProxyUsage(proxy(runtime, attempt, {
    eventId: 'usage-2', roleKind: 'main',
  }));
  assert.equal(ambiguous.routeAttemptId, undefined,
    'overlapping main requests must not be guessed into one attempt');
  assert.equal(ambiguous.routeAttribution, 'ambiguous');
});

test('non-main proxy usage keeps a real session but never borrows a main attempt tuple', () => {
  const { runtime } = harness();
  const attempt = runtime.beginAttempt(route({ cli: 'claude', protocol: 'anthropic' }));
  const usage = runtime.attributeProxyUsage(proxy(runtime, attempt, {
    role: 'sub', roleKind: 'sub', providerId: 'sub-provider', eventId: 'sub-usage-1',
  }));
  assert.equal(usage.sessionId, 'session-1');
  assert.equal(usage.providerId, 'sub-provider');
  assert.equal(usage.routeAttribution, 'ambiguous');
  for (const field of [
    'runtimeEpoch', 'turnId', 'decisionId', 'routeAttemptId', 'routeGeneration',
    'attemptNo', 'providerRevision',
  ]) assert.equal(usage[field], undefined, `${field} must not be guessed for sub usage`);
});

test('sub producer ownership survives main terminal state and drains the captured TaskRun lease', () => {
  const { runtime } = harness();
  const legacy = [];
  const taskRun = [];
  const bridge = createTaskRunProviderBridge({
    records: new Map([['session-1', {
      taskRunLease: { runId: 'run-1', leaseEpoch: 2 },
    }]]),
    recordActivity: event => event,
    recordLegacyUsage: event => { legacy.push(event); return true; },
    recordTaskRunUsage: event => { taskRun.push(event); return true; },
    scheduleMicrotask: fn => fn(),
  });
  const attempt = runtime.beginAttempt(route({
    cli: 'claude', protocol: 'anthropic', subagentProviderId: 'provider-sub',
  }));
  const request = proxy(runtime, attempt, {
    role: 'sub', roleKind: 'sub', providerId: 'provider-sub', phase: 'request',
  });
  const started = runtime.onProxyActivity(request);
  bridge.onActivity({ ...request, sessionId: started.sessionId });
  assert.deepEqual(bridge.drainState('session-1'), {
    drained: false, active: 1, ambiguous: false,
  });
  const usage = runtime.attributeProxyUsage(proxy(runtime, attempt, {
    role: 'sub', roleKind: 'sub', providerId: 'provider-sub', eventId: 'sub-usage',
  }));
  assert.equal(usage.producerBound, true);
  bridge.onUsageObserved(usage);
  assert.equal(legacy.length, 1);
  assert.equal(taskRun[0].taskRunId, 'run-1');
  assert.equal(taskRun[0].routeAttemptId, undefined);

  runtime.finishAttempt(attempt, { outcome: 'succeeded' });
  const ended = runtime.onProxyActivity({ ...request, phase: 'end' });
  assert.equal(ended.sessionId, 'session-1');
  bridge.onActivity({ ...request, phase: 'end', sessionId: ended.sessionId });
  assert.deepEqual(bridge.drainState('session-1'), {
    drained: true, active: 0, ambiguous: false,
  });
});

test('an old sub producer ends against its captured capability without binding a retry', () => {
  const { runtime } = harness();
  const first = runtime.beginAttempt(route({
    cli: 'claude', protocol: 'anthropic', subagentProviderId: 'provider-sub',
  }));
  const oldContext = proxy(runtime, first, {
    role: 'sub', roleKind: 'sub', providerId: 'provider-sub',
  });
  runtime.onProxyActivity({ ...oldContext, phase: 'request' });
  runtime.finishAttempt(first, { outcome: 'failed', errorCategory: 'transport' });
  const second = runtime.beginAttempt(route({
    cli: 'claude', protocol: 'anthropic', subagentProviderId: 'provider-sub', attemptNo: 2,
  }));
  assert.notEqual(runtime.proxySessionId(second), oldContext.sessionId);
  assert.equal(runtime.onProxyActivity({ ...oldContext, phase: 'end' }).sessionId, 'session-1');
  const usage = runtime.attributeProxyUsage({
    ...oldContext, eventId: 'old-sub-usage', phase: undefined,
  });
  assert.equal(usage.producerBound, true);
  assert.equal(usage.routeAttemptId, undefined);
  assert.equal(runtime.acceptEvent(second), true);
});

test('Codex end-before-usage ordering consumes the exact request-start attempt once', () => {
  const { runtime, audit } = harness();
  const attempt = runtime.beginAttempt(route());
  runtime.onProxyActivity(proxy(runtime, attempt, { phase: 'request' }));
  runtime.onProxyActivity(proxy(runtime, attempt, { phase: 'end' }));
  const usage = runtime.attributeProxyUsage(proxy(runtime, attempt, {
    eventId: 'usage-after-end', roleKind: 'main',
  }));
  assert.equal(usage.routeAttribution, 'exact');
  assert.equal(usage.routeAttemptId, attempt.routeAttemptId);
  const duplicate = runtime.attributeProxyUsage(proxy(runtime, attempt, {
    eventId: 'usage-after-end-duplicate', roleKind: 'main',
  }));
  assert.equal(duplicate.routeAttribution, 'ambiguous');
  assert.equal(duplicate.routeAttemptId, undefined);
  assert.equal(audit.at(-1).event.operation, 'proxy_usage');
});

test('port-normalized usage is re-keyed after capability decode for main, end-first and sub paths', () => {
  const normalizedUsage = (sessionId, overrides = {}) => createUsageObserved({
    eventId: overrides.sourceEventId || 'upstream-usage',
    occurredAt: 1_750_000_000_000,
    sessionId,
    providerId: overrides.providerId || 'provider-a',
    providerName: 'Provider',
    roleKind: overrides.roleKind || 'main',
    routeName: overrides.routeName || overrides.roleKind || 'main',
    ...(overrides.agentRole ? { agentRole: overrides.agentRole } : {}),
    source: 'exact', coverage: 'observed', status: 'success',
    protocol: 'anthropic-messages', model: 'model-a',
    tokens: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
  });

  for (const endBeforeUsage of [false, true]) {
    const { runtime } = harness();
    const attempt = runtime.beginAttempt(route());
    const context = proxy(runtime, attempt, { phase: 'request' });
    runtime.onProxyActivity(context);
    if (endBeforeUsage) runtime.onProxyActivity({ ...context, phase: 'end' });
    const portEvent = normalizedUsage(context.sessionId, {
      sourceEventId: `main-${endBeforeUsage}`,
    });
    const tagged = runtime.attributeProxyUsage(portEvent);
    const validated = createUsageObserved(tagged);
    assert.equal(validated.sessionId, 'session-1');
    assert.equal(validated.routeAttemptId, attempt.routeAttemptId);
    assert.notEqual(validated.eventId, portEvent.eventId);
  }

  const { runtime } = harness();
  const attempt = runtime.beginAttempt(route({
    cli: 'claude', protocol: 'anthropic', subagentProviderId: 'provider-sub',
  }));
  const context = proxy(runtime, attempt, {
    role: 'sub', roleKind: 'sub', providerId: 'provider-sub', phase: 'request',
  });
  runtime.onProxyActivity(context);
  const portEvent = normalizedUsage(context.sessionId, {
    sourceEventId: 'sub-usage', providerId: 'provider-sub',
    roleKind: 'sub', routeName: 'worker', agentRole: 'worker',
  });
  const tagged = runtime.attributeProxyUsage(portEvent);
  const validated = createUsageObserved(tagged);
  assert.equal(validated.sessionId, 'session-1');
  assert.equal(validated.routeAttemptId, undefined);
  assert.equal(tagged.producerBound, true);
});

test('a retry is refused after any replay fence has been crossed', () => {
  const { runtime } = harness();
  const attempt = runtime.beginAttempt(route());
  runtime.observeEvent(attempt, { type: 'part_delta', delta: { type: 'reasoning', text: 'seen' } });
  assert.throws(() => runtime.beginAttempt(route({ attemptNo: 2 })), error => (
    error && error.code === 'PROVIDER_REPLAY_FENCE_CLOSED'
  ));
});

test('a host-marked whole-message provider error never becomes model output', () => {
  const { runtime } = harness();
  const first = runtime.beginAttempt(route());
  const marked = markHostErrorEnvelope({
    type: 'assistant', message: { content: [{ type: 'text', text: 'API Error: 402 insufficient balance' }] },
  });
  assert.equal(Object.getOwnPropertySymbols(marked).length, 1);
  assert.deepEqual(Object.keys(marked), ['type', 'message']);
  assert.equal(JSON.stringify(marked).includes('hostErrorEnvelope'), false);
  runtime.observeEvent(first, marked);
  assert.equal(runtime.snapshot('session-1').replayFence, 'none');
  assert.equal(runtime.snapshot('session-1').visibleOutputObserved, false);
  runtime.finishAttempt(first, { outcome: 'failed', errorCategory: 'billing_quota' });
  assert.equal(runtime.beginAttempt(route({
    providerId: 'provider-backup', model: 'backup-model', attemptNo: 2,
  })).routeGeneration, 2);
});

test('raw data cannot forge the host marker and earlier deltas can never be reopened', () => {
  const { runtime } = harness();
  const first = runtime.beginAttempt(route());
  runtime.observeEvent(first, {
    type: 'assistant', hostErrorEnvelope: true,
    message: { content: [{ type: 'text', text: 'API Error: 402 insufficient balance' }] },
  });
  assert.equal(runtime.snapshot('session-1').replayFence, 'visible_output');
  runtime.finishAttempt(first, { outcome: 'failed' });
  assert.throws(() => runtime.beginAttempt(route({ attemptNo: 2 })), error => (
    error && error.code === 'PROVIDER_REPLAY_FENCE_CLOSED'
  ));

  const second = runtime.beginAttempt(route({ sessionId: 'session-2', turnId: 'turn-2' }));
  runtime.observeEvent(second, {
    type: 'stream_event', event: {
      type: 'content_block_delta', delta: { type: 'text_delta', text: 'earlier output' },
    },
  });
  runtime.observeEvent(second, markHostErrorEnvelope({
    type: 'assistant', message: { content: [{ type: 'text', text: 'API Error: 402 insufficient balance' }] },
  }));
  assert.equal(runtime.snapshot('session-2').replayFence, 'visible_output');
});

test('thinking and tools remain irreversible even if a host marker is present', () => {
  const { runtime } = harness();
  const thinking = runtime.beginAttempt(route());
  runtime.observeEvent(thinking, markHostErrorEnvelope({
    type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'private reasoning' }] },
  }));
  assert.equal(runtime.snapshot('session-1').replayFence, 'visible_output');

  const tool = runtime.beginAttempt(route({ sessionId: 'session-tool', turnId: 'turn-tool' }));
  runtime.observeEvent(tool, markHostErrorEnvelope({
    type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
  }));
  assert.equal(runtime.snapshot('session-tool').replayFence, 'tool_intent');
});

test('a new attempt waits until the old proxy producer has drained', () => {
  const { runtime } = harness();
  const first = runtime.beginAttempt(route());
  runtime.onProxyActivity(proxy(runtime, first, { phase: 'request' }));
  runtime.finishAttempt(first, { outcome: 'failed', errorCategory: 'rate_limit' });
  assert.throws(() => runtime.beginAttempt(route({ attemptNo: 2 })), error => (
    error && error.code === 'PROVIDER_PRODUCER_NOT_DRAINED'
  ));
  runtime.onProxyActivity(proxy(runtime, first, { phase: 'end' }));
  assert.equal(runtime.beginAttempt(route({ attemptNo: 2 })).routeGeneration, 2);
});

test('a mismatched overlapping request cannot overwrite producer count or fake drain', () => {
  const { runtime } = harness();
  const first = runtime.beginAttempt(route());
  runtime.onProxyActivity(proxy(runtime, first, { phase: 'request' }));
  runtime.onProxyActivity(proxy(runtime, first, {
    providerId: 'provider-old', phase: 'request',
  }));
  runtime.finishAttempt(first, { outcome: 'failed' });
  runtime.onProxyActivity(proxy(runtime, first, { phase: 'end' }));
  assert.throws(() => runtime.beginAttempt(route({ attemptNo: 2 })), error => (
    error && error.code === 'PROVIDER_PRODUCER_NOT_DRAINED'
  ));
  runtime.onProxyActivity(proxy(runtime, first, {
    providerId: 'provider-old', phase: 'end',
  }));
  assert.equal(runtime.beginAttempt(route({ attemptNo: 2 })).routeGeneration, 2);
});

test('proxy preflight rejects a live provider revision change before upstream I/O', () => {
  const audit = [];
  const runtime = createProviderAttemptRuntime({
    runtimeEpoch: 'epoch-revision', nextId: prefix => `${prefix}-revision`,
    resolveProviderRevision: () => 'revision-edited',
    audit: (sessionId, event) => audit.push({ sessionId, event }),
  });
  const attempt = runtime.beginAttempt(route());
  const decision = runtime.authorizeProxyRequest(proxy(runtime, attempt));
  assert.equal(decision.ok, false);
  assert.equal(decision.code, 'provider_revision_mismatch');
  assert.equal(runtime.observeProxyDelta(
    { type: 'text', text: 'must-not-cross' },
    proxy(runtime, attempt),
  ).accepted, false);
  assert.equal(runtime.snapshot('session-1').outcome, 'failed');
  assert.equal(runtime.acceptEvent(attempt), false,
    'a live revision mismatch poisons authoritative CLI output as well as sidecars');
  assert.ok(audit.some(item => item.event.operation === 'proxy_preflight'));
  assert.ok(audit.some(item => item.event.operation === 'proxy_delta'));
});

test('a late physical request capability cannot bind to the next provider attempt', () => {
  const { runtime, audit } = harness();
  const first = runtime.beginAttempt(route());
  const firstProxySessionId = runtime.proxySessionId(first);
  assert.match(firstProxySessionId, /^pr1\./);
  assert.equal(JSON.stringify(first).includes('proxy-route'), false,
    'the private process capability is not part of the public attempt snapshot');
  runtime.finishAttempt(first, { outcome: 'failed', errorCategory: 'transport' });
  const second = runtime.beginAttempt(route({ attemptNo: 2 }));
  assert.notEqual(runtime.proxySessionId(second), firstProxySessionId);

  const rejected = runtime.authorizeProxyRequest({
    sessionId: firstProxySessionId, role: 'main', providerId: 'provider-a',
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'proxy_route_capability_mismatch');
  assert.equal(runtime.snapshot('session-1').outcome, 'running',
    'a guard can reject a provably stale request without sacrificing the current attempt');
  assert.equal(runtime.acceptEvent(second), true);

  assert.equal(runtime.onProxyActivity({
    sessionId: firstProxySessionId, role: 'main', providerId: 'provider-a', phase: 'request',
  }), null);
  assert.equal(runtime.snapshot('session-1').outcome, 'failed');
  assert.equal(runtime.acceptEvent(second), false);
  assert.equal(JSON.stringify(audit).includes(firstProxySessionId), false,
    'audit metadata never persists the opaque process capability');
});

test('an attempt capability authorizes only its frozen main and configured sub Providers', () => {
  const { runtime } = harness();
  const attempt = runtime.beginAttempt(route({ subagentProviderId: 'provider-sub' }));
  const sessionId = runtime.proxySessionId(attempt);
  assert.equal(runtime.authorizeProxyRequest({
    sessionId, role: 'sub', providerId: 'provider-sub',
  }).ok, true);
  const rejected = runtime.authorizeProxyRequest({
    sessionId, role: 'sub', providerId: 'provider-unplanned',
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'provider_subroute_not_allowed');
  assert.equal(runtime.snapshot('session-1').outcome, 'failed');
});

test('Claude rotates its capability at every attempt, including successful serial turns', () => {
  const { runtime } = harness();
  const claudeRoute = {
    cli: 'claude', protocol: 'anthropic', providerRevision: 'claude-revision',
  };
  const first = runtime.beginAttempt(route(claudeRoute));
  const warmCapability = runtime.proxySessionId(first);
  runtime.finishAttempt(first, { outcome: 'succeeded' });
  const second = runtime.beginAttempt(route({
    ...claudeRoute, turnId: 'turn-2', attemptNo: 1,
  }));
  const secondCapability = runtime.proxySessionId(second);
  assert.notEqual(secondCapability, warmCapability,
    'a clean result boundary cannot keep an old attempt capability live');
  assert.equal(runtime.authorizeProxyRequest({
    sessionId: warmCapability, role: 'main', providerId: 'provider-a',
  }).ok, false, 'the prior process route is revoked before the next turn starts');
  runtime.finishAttempt(second, { outcome: 'failed', errorCategory: 'transport' });
  const retry = runtime.beginAttempt(route({
    ...claudeRoute, turnId: 'turn-2', attemptNo: 2,
  }));
  assert.notEqual(runtime.proxySessionId(retry), secondCapability,
    'a same-turn retry also gets a distinct physical capability');
});

test('a succeeded logical turn cannot open another provider attempt', () => {
  const { runtime } = harness();
  const first = runtime.beginAttempt(route());
  runtime.finishAttempt(first, { outcome: 'succeeded' });
  assert.throws(() => runtime.beginAttempt(route({ attemptNo: 2 })), error => (
    error && error.code === 'PROVIDER_TURN_ALREADY_SUCCEEDED'
  ));
  assert.equal(runtime.finishAttempt(first, { outcome: 'succeeded' }).code, 'attempt_not_running');
});

test('an explicit same-route continuation inherits the closed replay fence', () => {
  const { runtime, events } = harness();
  const first = runtime.beginAttempt(route());
  runtime.observeEvent(first, { type: 'assistant_text', text: 'partial' });
  runtime.finishAttempt(first, { outcome: 'failed', errorCategory: 'transport' });
  const second = runtime.beginAttempt(route({ attemptNo: 2, continuation: true }));
  assert.equal(second.routeGeneration, 2);
  assert.equal(second.replayFence, 'visible_output');
  assert.equal(second.safeToReplay, false);
  assert.equal(events.at(-1).event.phase, 'continued');
  runtime.finishAttempt(second, { outcome: 'failed' });
  assert.throws(() => runtime.beginAttempt(route({
    providerId: 'provider-b', model: 'model-b', providerRevision: 'revision-b',
    attemptNo: 3, continuation: true,
  })), error => error && error.code === 'PROVIDER_CONTINUATION_ROUTE_CHANGED');
});

test('provider revision hashes only safe route configuration and tagged frames are immutable', () => {
  const base = {
    cli: 'claude', providerId: 'provider-a', protocol: 'anthropic', model: 'model-a',
    summary: {
      appType: 'claude', baseUrl: 'https://api.example.test', apiFormat: 'anthropic',
      aliasMap: { sonnet: { model: 'model-a' } }, authToken: 'secret-one',
    },
  };
  const revision = createProviderRevision(base);
  assert.equal(revision, createProviderRevision({
    ...base, summary: { ...base.summary, authToken: 'secret-two' },
  }), 'credentials are deliberately outside the observable revision identity');
  assert.notEqual(revision, createProviderRevision({
    ...base, summary: { ...base.summary, baseUrl: 'https://other.example.test' },
  }));
  const { runtime } = harness();
  const attempt = runtime.beginAttempt(route({ providerRevision: revision }));
  const tagged = tagProviderAttemptEvent({
    type: 'assistant_text',
    text: 'ok pr1.c2Vzc2lvbi0x.cHJveHktcm91dGUtc2VjcmV0',
  }, attempt);
  assert.equal(tagged.providerRouteProtocolVersion, 1);
  assert.equal(tagged.providerRouteScope, 'attempt');
  assert.equal(tagged.routeAttemptId, attempt.routeAttemptId);
  assert.doesNotMatch(tagged.text, /pr1\./);
  assert.equal(Object.isFrozen(tagged), true);
});
