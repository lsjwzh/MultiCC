'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createProviderBinding } = require('../src/provider-binding');
const { createProviderAttemptRuntime } = require('../src/chat/provider-attempt-runtime');
const { createProviderInvocationFactory } = require('../src/chat/provider-invocation');
const { normalizeTurnRequest, createTurnLifecycle } = require('../src/chat');

function makeHarness() {
  const calls = [];
  const summaries = {
    'provider-a': { id: 'provider-a', name: 'Provider A', appType: 'claude', apiFormat: 'anthropic', baseUrl: 'https://a.example.test', aliasMap: {} },
    'provider-b': { id: 'provider-b', name: 'Provider B', appType: 'claude', apiFormat: 'anthropic', baseUrl: 'https://b.example.test', aliasMap: {} },
  };
  const router = {
    createBinding(session, overrides = {}) {
      return createProviderBinding({
        sessionId: session.id, cli: session.cli,
        providerId: overrides.providerId !== undefined ? overrides.providerId : session.provider,
        model: overrides.model !== undefined ? overrides.model : session.model,
        roleKind: 'main', routeName: 'main',
      });
    },
    resolveSpawnEnv(session, overrides = {}) {
      const providerId = overrides.providerId ?? session.provider;
      calls.push({ method: 'resolve', providerId });
      return { providerName: summaries[providerId]?.name, qualifiedModel: `${providerId}-wire-model` };
    },
    getProviderSummary(_appType, providerId) { return summaries[providerId] || null; },
  };
  const attempts = createProviderAttemptRuntime({
    runtimeEpoch: 'epoch-1', nextId: prefix => `${prefix}-${calls.length + 1}`,
  });
  const factory = createProviderInvocationFactory({
    providerRouterRuntime: router, providerAttemptRuntime: attempts,
    effectiveSessionModel: session => session.model,
  });
  return { calls, attempts, factory };
}

function turnInput() {
  const request = normalizeTurnRequest({
    sessionId: 'session-1', text: 'hello', cli: 'claude',
    hasNativeHistory: false, forceFirst: true,
  });
  return { request, turn: createTurnLifecycle(request, { turnId: 'turn-1' }) };
}

test('each physical invocation resolves and proves one immutable concrete provider route', () => {
  const { calls, attempts, factory } = makeHarness();
  const session = { id: 'session-1', cli: 'claude', provider: 'provider-a', model: 'sonnet' };
  const provider = { buildInvocation: envelope => ({ cmd: 'claude', args: ['--json'], payload: envelope.userText }) };
  const envelope = { userText: 'hello', spawnOpts: {}, historyHandle: {} };
  const { request, turn } = turnInput();
  const first = factory.prepare({ request, turn, session, provider, envelope, attemptNo: 1 });

  assert.equal(first.attempt.providerId, 'provider-a');
  assert.equal(first.attempt.model, 'provider-a-wire-model');
  assert.equal(first.routeProof.turnId, 'turn-1');
  assert.equal(first.routeProof.route.routeAttemptId, first.attempt.routeAttemptId);
  assert.equal(first.binding.model, 'provider-a-wire-model');
  assert.match(first.proxySessionId, /^pr1\./);
  assert.equal(JSON.stringify(first.routeProof).includes(first.proxySessionId), false,
    'the proxy process capability stays outside public route proof DTOs');
  assert.deepEqual(first.routeOverrides, {
    providerId: 'provider-a', model: 'sonnet',
  }, 'child env rebuild keeps the raw selected model instead of re-resolving a wire model');
  assert.equal(first.usageAttribution.routeGeneration, 1);
  assert.equal(session.provider, 'provider-a');

  attempts.finishAttempt(first.attempt, { outcome: 'failed', errorCategory: 'rate_limit' });
  const second = factory.prepare({
    request, turn, session, provider, envelope, attemptNo: 2,
    providerId: 'provider-b', reasonCode: 'same_turn_test',
  });
  assert.equal(second.attempt.providerId, 'provider-b');
  assert.equal(second.attempt.routeGeneration, 2);
  assert.notEqual(second.attempt.providerRevision, first.attempt.providerRevision);
  assert.deepEqual(calls.map(call => call.providerId), ['provider-a', 'provider-b']);
  assert.equal(session.provider, 'provider-a', 'route resolution never mutates the preferred session provider');
});

test('child env route overrides do not qualify an OpenCode-style wire model twice', () => {
  const attempts = createProviderAttemptRuntime({
    runtimeEpoch: 'epoch-1', nextId: prefix => `${prefix}-1`,
  });
  const router = {
    createBinding(session, overrides = {}) {
      return createProviderBinding({
        sessionId: session.id,
        cli: session.cli,
        providerId: overrides.providerId !== undefined ? overrides.providerId : session.provider,
        model: overrides.model !== undefined ? overrides.model : session.model,
        roleKind: 'main', routeName: 'main',
      });
    },
    resolveSpawnEnv(session, overrides = {}) {
      const providerId = overrides.providerId ?? session.provider;
      const rawModel = overrides.model ?? session.model;
      return {
        providerName: 'Provider A',
        qualifiedModel: rawModel ? `multicc-${providerId}/${rawModel}` : null,
        providerModel: rawModel,
        providerModels: rawModel ? [rawModel] : [],
      };
    },
    getProviderSummary() {
      return { name: 'Provider A', apiFormat: 'openai_chat' };
    },
  };
  const factory = createProviderInvocationFactory({
    providerRouterRuntime: router,
    providerAttemptRuntime: attempts,
    effectiveSessionModel: session => session.model,
  });
  const request = normalizeTurnRequest({
    sessionId: 'session-1', text: 'hello', cli: 'opencode',
    hasNativeHistory: false, forceFirst: true,
  });
  const turn = createTurnLifecycle(request, { turnId: 'turn-1' });
  const session = {
    id: 'session-1', cli: 'opencode', provider: 'provider-a', model: 'deepseek-chat',
  };
  const prepared = factory.prepare({
    request,
    turn,
    session,
    provider: {
      buildInvocation: envelope => ({
        cmd: 'opencode', args: ['--model', envelope.spawnOpts.rawModel], payload: envelope.userText,
      }),
    },
    envelope: { userText: 'hello', spawnOpts: {}, historyHandle: {} },
    attemptNo: 1,
  });

  assert.equal(prepared.attempt.model, 'multicc-provider-a/deepseek-chat');
  assert.equal(prepared.invocation.args[1], 'multicc-provider-a/deepseek-chat');
  assert.equal(
    router.resolveSpawnEnv(session, prepared.routeOverrides).qualifiedModel,
    'multicc-provider-a/deepseek-chat',
  );
});

test('bare retries rebuild invocation text without replaying composition layers', () => {
  const { factory } = makeHarness();
  const session = { id: 'session-1', cli: 'claude', provider: 'provider-a', model: 'sonnet', cliSessionId: 'native-1' };
  let captured;
  const provider = { buildInvocation: envelope => { captured = envelope; return { cmd: 'claude', args: [], payload: envelope.userText }; } };
  const { request, turn } = turnInput();
  factory.prepare({
    request, turn, session, provider,
    envelope: { userText: 'original', contextLayers: ['delivered-note'], suffix: 'suffix', spawnOpts: {}, historyHandle: {} },
    bareText: 'continue only', firstTurn: false, attemptNo: 1,
  });
  assert.equal(captured.userText, 'continue only');
  assert.deepEqual(captured.contextLayers, []);
  assert.equal(captured.suffix, '');
  assert.equal(captured.historyHandle.cliSessionId, 'native-1');
});
