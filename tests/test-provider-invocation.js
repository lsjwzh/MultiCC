'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createProviderBinding } = require('../src/providers/binding');
const {
  createProviderAttemptRuntime,
  createProviderRevision,
} = require('../src/chat/provider-attempt-runtime');
const { captureNativeSessionId } = require('./helpers/legacy-native-session-state');
const {
  createProviderInvocationFactory,
  providerRetryRouteOptions,
} = require('../src/native/binding').providerInvocation;
const { normalizeTurnRequest, createTurnLifecycle } = require('../src/chat');

function makeHarness(makeFactory = createProviderInvocationFactory) {
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
      // A provider-less route (OpenCode native) has no managed provider to
      // qualify a model through: the model stands as the selection gave it.
      if (!providerId) {
        return {
          providerName: null,
          qualifiedModel: overrides.model !== undefined ? overrides.model : session.model,
        };
      }
      return { providerName: summaries[providerId]?.name, qualifiedModel: `${providerId}-wire-model` };
    },
    getProviderSummary(_appType, providerId) { return summaries[providerId] || null; },
  };
  const attempts = createProviderAttemptRuntime({
    now: () => 10,
    runtimeEpoch: 'epoch-1', nextId: prefix => `${prefix}-${calls.length + 1}`,
  });
  const factory = makeFactory({
    providerRouterRuntime: router, providerAttemptRuntime: attempts,
    effectiveSessionModel: session => session.model,
  });
  return { calls, attempts, factory, router };
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

test('候选线路的 工作流与强度独立进入本次启动，原线路重试保留，换线路后回到会话设置', () => {
  const { attempts, factory } = makeHarness();
  const session = { id: 'session-1', cli: 'claude', provider: 'provider-a', effort: 'low' };
  const envelope = { userText: 'hello', suffix: '中文', historyHandle: {}, spawnOpts: { rawEffort: 'low' } };
  const input = { ...turnInput(), session, envelope, provider: { buildInvocation: e => ({ args: [e.spawnOpts.rawEffort, e.spawnOpts.ultracode === true], payload: e.suffix }) } };
  const first = factory.prepare({ ...input, attemptNo: 1, effort: 'medium', claudeWorkflow: true });
  assert.deepEqual(first.invocation.args, ['medium', true]);
  assert.equal(first.invocation.payload, '中文');
  const retry = providerRetryRouteOptions(first.attempt);
  assert.equal(retry.effort, 'medium');
  assert.equal(retry.claudeWorkflow, true);
  attempts.finishAttempt(first.attempt, { outcome: 'failed' });
  const next = factory.prepare({ ...input, attemptNo: 2, providerId: 'provider-b' });
  assert.deepEqual(next.invocation.args, ['low', false]);
  assert.equal(next.invocation.payload, '中文');
  assert.equal(session.effort, 'low');
});

test('a resident lane keeps one route capability across turns and follows the spawn contract', () => {
  const { attempts, factory } = makeHarness();
  const session = { id: 'session-1', cli: 'claude', provider: 'provider-a', model: 'sonnet' };
  const envelope = { userText: 'hello', spawnOpts: {}, historyHandle: {} };
  const { request, turn } = turnInput();
  const spawning = argv => ({ buildInvocation: () => ({ cmd: 'claude', args: argv }) });

  const first = factory.prepare({
    request, turn, session, provider: spawning(['-p', '--model', 'sonnet']), envelope, attemptNo: 1,
  });
  attempts.finishAttempt(first.attempt, { outcome: 'succeeded' });
  const warm = factory.prepare({
    request, turn: { ...turn, turnId: 'turn-2' }, session,
    provider: spawning(['-p', '--model', 'sonnet']), envelope, attemptNo: 1,
  });
  assert.equal(warm.proxySessionId, first.proxySessionId,
    'a warm resident child must keep routing on the capability it was spawned with');
  attempts.finishAttempt(warm.attempt, { outcome: 'succeeded' });
  const respawned = factory.prepare({
    request, turn: { ...turn, turnId: 'turn-3' }, session,
    provider: spawning(['-p', '--model', 'opus']), envelope, attemptNo: 1,
  });
  assert.notEqual(respawned.proxySessionId, warm.proxySessionId,
    'a new --model is baked at spawn, so the child respawns on a fresh capability');
});

test('a codex app-server resident child keys its route on the binding, not on per-turn argv', () => {
  let sequence = 0;
  const attempts = createProviderAttemptRuntime({
    runtimeEpoch: 'epoch-1', nextId: prefix => `${prefix}-${++sequence}`,
  });
  const router = {
    createBinding(session, overrides = {}) {
      return createProviderBinding({
        sessionId: session.id, cli: session.cli, providerId: session.provider,
        model: overrides.model !== undefined ? overrides.model : session.model,
        roleKind: 'main', routeName: 'main',
      });
    },
    resolveSpawnEnv() {
      return {
        providerName: 'Codex A', providerModel: 'gpt-5-codex',
        providerModels: ['gpt-5-codex'], skipDefaultModel: true,
      };
    },
    getProviderSummary() { return { id: 'provider-a', name: 'Codex A', apiFormat: 'openai_responses' }; },
  };
  const factory = createProviderInvocationFactory({
    providerRouterRuntime: router, providerAttemptRuntime: attempts,
    effectiveSessionModel: session => session.model,
  });
  const request = normalizeTurnRequest({
    sessionId: 'session-1', text: 'hello', cli: 'codex-exp',
    hasNativeHistory: false, forceFirst: true,
  });
  const turn = createTurnLifecycle(request, { turnId: 'turn-1' });
  const session = { id: 'session-1', cli: 'codex-exp', provider: 'provider-a', model: 'gpt-5-codex' };
  const envelope = { userText: 'hello', spawnOpts: { rawModel: 'gpt-5-codex' }, historyHandle: {} };
  const spawning = argv => ({
    buildInvocation: () => ({
      cmd: 'codex', args: argv, streamArgs: [...argv, '--resident'],
      streamBackend: 'app-server', nativeKey: 'cliSessionId', clientAllocatesNativeId: false,
      turnOptions: { model: null, effort: null },
    }),
  });

  const first = factory.prepare({
    request, turn, session, provider: spawning(['bridge', '--model', 'gpt-5-codex']),
    envelope, attemptNo: 1,
  });
  attempts.finishAttempt(first.attempt, { outcome: 'succeeded' });
  const second = factory.prepare({
    request, turn: { ...turn, turnId: 'turn-2' }, session,
    provider: spawning(['bridge', '--model', 'gpt-5-codex', '--effort', 'high']),
    envelope, attemptNo: 1,
  });
  assert.equal(second.proxySessionId, first.proxySessionId,
    'the app-server takes model/effort per turn, so argv is not part of its spawn contract');
  attempts.finishAttempt(second.attempt, { outcome: 'succeeded' });
  session.model = 'other-main-model';
  const third = factory.prepare({ request, turn: { ...turn, turnId: 'turn-3' }, session,
    provider: spawning(['bridge', '--model', session.model]), envelope, attemptNo: 1 });
  assert.equal(third.proxySessionId, first.proxySessionId, 'a per-turn model change does not invalidate the home');
});

test('changing only the Codex subagent model rotates its baked route', () => {
  const { factory, attempts } = makeHarness();
  const session = { id: 'session-1', cli: 'codex-exp', provider: 'provider-a', model: 'main',
    subagent: { providerId: 'provider-b', model: 'child-old' } };
  const request = normalizeTurnRequest({ sessionId: session.id, text: 'hello', cli: session.cli, forceFirst: true });
  const provider = { buildInvocation: () => ({ cmd: 'node', streamArgs: ['bridge', '--resident'], payload: 'hello' }) };
  const prepare = n => factory.prepare({ request, turn: createTurnLifecycle(request, { turnId: `turn-${n}` }),
    session, provider, envelope: { userText: 'hello', spawnOpts: {}, historyHandle: {} }, attemptNo: 1 });
  const first = prepare(1);
  attempts.finishAttempt(first.attempt, { outcome: 'succeeded' });
  session.subagent.model = 'child-new';
  const second = prepare(2);
  assert.notEqual(second.proxySessionId, first.proxySessionId);
  attempts.finishAttempt(second.attempt, { outcome: 'succeeded' });
  assert.equal(prepare(3).proxySessionId, second.proxySessionId);
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

test('legacy failover replaces the original envelope model with the selected candidate model', () => {
  const emitted = [];
  const attempts = createProviderAttemptRuntime({
    runtimeEpoch: 'epoch-1',
    nextId: prefix => `${prefix}-${emitted.length + 1}`,
    emit: (_sessionId, event) => emitted.push(event),
  });
  const summaries = {
    'provider-a': { id: 'provider-a', name: 'Provider A', apiFormat: 'anthropic' },
    'provider-b': { id: 'provider-b', name: 'Provider B', apiFormat: 'anthropic' },
  };
  const router = {
    createBinding(session, overrides = {}) {
      return createProviderBinding({
        sessionId: session.id,
        cli: session.cli,
        providerId: overrides.providerId !== undefined ? overrides.providerId : session.provider,
        model: overrides.model !== undefined ? overrides.model : session.model,
        roleKind: 'main',
        routeName: 'main',
      });
    },
    resolveSpawnEnv(session, overrides = {}) {
      const providerId = overrides.providerId ?? session.provider;
      const model = overrides.model ?? session.model;
      return {
        providerName: summaries[providerId].name,
        providerModel: model,
        providerModels: [model],
        skipDefaultModel: true,
      };
    },
    getProviderSummary(_appType, providerId) { return summaries[providerId]; },
  };
  const factory = createProviderInvocationFactory({
    providerRouterRuntime: router,
    providerAttemptRuntime: attempts,
    effectiveSessionModel: session => session.model,
  });
  const { request, turn } = turnInput();
  const session = {
    id: 'session-1', cli: 'claude', provider: 'provider-a', model: 'primary-model',
  };
  let capturedRawModel = null;
  const prepared = factory.prepare({
    request,
    turn,
    session,
    provider: {
      buildInvocation: envelope => {
        capturedRawModel = envelope.spawnOpts.rawModel;
        return { cmd: 'claude', args: ['--model', capturedRawModel], payload: envelope.userText };
      },
    },
    envelope: {
      userText: 'hello',
      spawnOpts: { rawModel: 'primary-model' },
      historyHandle: {},
    },
    attemptNo: 1,
    providerId: 'provider-b',
    model: 'backup-model',
    reasonCode: 'failover_billing_quota',
  });

  assert.equal(capturedRawModel, 'backup-model');
  assert.equal(prepared.attempt.model, 'backup-model');
  assert.equal(prepared.usageAttribution.model, 'backup-model');
  assert.equal(emitted.at(-1).model, 'backup-model');
});

test('a default-model failover never inherits the session or previous candidate model', () => {
  const emitted = [];
  const attempts = createProviderAttemptRuntime({
    runtimeEpoch: 'epoch-1',
    nextId: prefix => `${prefix}-${emitted.length + 1}`,
    emit: (_sessionId, event) => emitted.push(event),
  });
  const summaries = {
    'provider-a': { id: 'provider-a', name: 'Provider A', apiFormat: 'anthropic' },
    'provider-b': { id: 'provider-b', name: 'Provider B', apiFormat: 'anthropic' },
  };
  const router = {
    createBinding(session, overrides = {}) {
      return createProviderBinding({
        sessionId: session.id,
        cli: session.cli,
        providerId: overrides.providerId !== undefined ? overrides.providerId : session.provider,
        model: overrides.model !== undefined ? overrides.model : session.model,
        roleKind: 'main',
        routeName: 'main',
      });
    },
    resolveSpawnEnv(session, overrides = {}) {
      const providerId = overrides.providerId !== undefined
        ? overrides.providerId : session.provider;
      const model = overrides.model !== undefined ? overrides.model : session.model;
      return {
        providerName: summaries[providerId].name,
        qualifiedModel: model,
        providerModel: null,
        providerModels: [],
        skipDefaultModel: false,
      };
    },
    getProviderSummary(_appType, providerId) { return summaries[providerId]; },
  };
  const factory = createProviderInvocationFactory({
    providerRouterRuntime: router,
    providerAttemptRuntime: attempts,
    effectiveSessionModel: session => session.model,
  });
  const { request, turn } = turnInput();
  const session = {
    id: 'session-1', cli: 'claude', provider: 'provider-a', model: 'primary-model',
  };
  let capturedRawModel = 'not-called';
  const prepared = factory.prepare({
    request,
    turn,
    session,
    provider: {
      buildInvocation: envelope => {
        capturedRawModel = envelope.spawnOpts.rawModel;
        return {
          cmd: 'claude',
          args: capturedRawModel ? ['--model', capturedRawModel] : [],
          payload: envelope.userText,
        };
      },
    },
    envelope: {
      userText: 'hello',
      spawnOpts: { rawModel: 'primary-model' },
      historyHandle: {},
    },
    attemptNo: 1,
    providerId: 'provider-b',
    model: null,
    reasonCode: 'failover_billing_quota',
  });

  const expectedRevision = createProviderRevision({
    cli: 'claude',
    providerId: 'provider-b',
    protocol: 'anthropic',
    model: '_default_',
    summary: summaries['provider-b'],
  });
  assert.equal(capturedRawModel, null, 'spawn must let the selected provider choose its default');
  assert.deepEqual(prepared.invocation.args, []);
  assert.deepEqual(prepared.routeOverrides, { providerId: 'provider-b', model: null });
  assert.equal(prepared.binding.model, '_default_');
  assert.equal(prepared.routeProof.route.model, '_default_');
  assert.equal(prepared.attempt.model, '_default_');
  assert.equal(prepared.attempt.providerRevision, expectedRevision);
  assert.equal(prepared.baseUsageAttribution.model, '_default_');
  assert.equal(prepared.usageAttribution.model, '_default_');
  assert.equal(emitted.at(-1).model, '_default_');
  assert.equal(session.model, 'primary-model');
});

test('a fresh Auto fallback replaces the failed attempt native thread id', () => {
  const record = { cli: 'codex', cliSessionId: null };
  assert.deepEqual(captureNativeSessionId(record, 'thread-a', { fresh: true }), {
    changed: true, previous: null, current: 'thread-a',
  });
  assert.deepEqual(captureNativeSessionId(record, 'thread-b', { fresh: true }), {
    changed: true, previous: 'thread-a', current: 'thread-b',
  });
  assert.equal(record.cliSessionId, 'thread-b');
  assert.deepEqual(captureNativeSessionId(record, 'unexpected-resume-thread', { fresh: false }), {
    changed: false, previous: 'thread-b', current: 'thread-b',
    mismatch: true, incoming: 'unexpected-resume-thread',
  });
  assert.equal(record.cliSessionId, 'thread-b');
});

test('retry route options decode only the physical default-model sentinel', () => {
  assert.deepEqual(providerRetryRouteOptions({
    providerId: 'provider-official', model: '_default_',
  }), {
    providerId: 'provider-official', model: null,
  });
  assert.deepEqual(providerRetryRouteOptions({
    providerId: 'provider-custom', model: 'explicit-wire-model',
  }), {
    providerId: 'provider-custom', model: 'explicit-wire-model',
  });
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
    bareText: 'continue only', firstTurn: false, attemptNo: 1, effort: 'medium', claudeWorkflow: true,
  });
  assert.equal(captured.spawnOpts.rawEffort, 'medium');
  assert.equal(captured.spawnOpts.ultracode, true);
  assert.equal(captured.userText, 'continue only');
  assert.deepEqual(captured.contextLayers, []);
  assert.equal(captured.suffix, '');
  assert.equal(captured.historyHandle.cliSessionId, 'native-1');
});

// ---------------------------------------------------------------------------
// The Auto-only idle budget handed to the proxy stall watchdog
// ---------------------------------------------------------------------------

function prepareFor(session, input = {}) {
  const { attempts, factory } = makeHarness();
  const provider = { buildInvocation: envelope => ({ cmd: 'claude', payload: envelope.userText }) };
  const { request, turn } = turnInput();
  const invocation = factory.prepare({
    request, turn, session, provider,
    envelope: { userText: 'hello', spawnOpts: {}, historyHandle: {} },
    attemptNo: 1, ...input,
  });
  return { attempts, invocation };
}

test('Auto and fixed-provider sessions share the reviewed model request budget', () => {
  const auto = { id: 'session-1', cli: 'claude', provider: 'provider-a', model: 'sonnet',
    providerSelection: { version: 1, mode: 'auto', protocol: 'anthropic', candidates: [] } };
  assert.equal(prepareFor(auto).invocation.attempt.stallTimeoutMs, 300_000);
  assert.equal(prepareFor(auto, { env: {} }).invocation.attempt.stallTimeoutMs, 300_000);
  // 固定供应商也受同一预算保护。
  const manual = { id: 'session-1', cli: 'claude', provider: 'provider-a', model: 'sonnet',
    providerSelection: { version: 1, mode: 'manual', candidates: [] } };
  assert.equal(prepareFor(manual).invocation.attempt.stallTimeoutMs, 300_000);
  assert.equal(prepareFor(manual, { env: { MULTICC_AUTO_STALL_TIMEOUT_MS: '45000' } })
    .invocation.attempt.stallTimeoutMs, 300_000, 'legacy Auto override does not affect a fixed session');
  assert.equal(prepareFor({ id: 'session-1', cli: 'claude', provider: 'provider-a', model: 'sonnet' })
    .invocation.attempt.stallTimeoutMs, 300_000);
});

test('the environment overrides the Auto budget and can switch the watchdog off', () => {
  const auto = { id: 'session-1', cli: 'claude', provider: 'provider-a', model: 'sonnet',
    providerSelection: { version: 1, mode: 'auto', protocol: 'anthropic', candidates: [] } };
  const budget = env => prepareFor(auto, { env }).invocation.attempt.stallTimeoutMs;
  assert.equal(budget({ MULTICC_AUTO_STALL_TIMEOUT_MS: '45000' }), 45_000);
  assert.equal(budget({ MULTICC_AUTO_STALL_TIMEOUT_MS: '0' }), 0, 'zero disables the watchdog');
  assert.equal(budget({ MULTICC_AUTO_STALL_TIMEOUT_MS: '1000' }), 15_000, 'clamped up to the floor');
  assert.equal(budget({ MULTICC_AUTO_STALL_TIMEOUT_MS: '3600000' }), 600_000, 'clamped down to the ceiling');
  assert.equal(budget({ MULTICC_AUTO_STALL_TIMEOUT_MS: 'later' }), 300_000, 'unparseable keeps the default');
});

test('the budget travels with every physical attempt, the failover one included', () => {
  const { attempts, factory } = makeHarness();
  const auto = { id: 'session-1', cli: 'claude', provider: 'provider-a', model: 'sonnet',
    providerSelection: { version: 1, mode: 'auto', protocol: 'anthropic', candidates: [] } };
  const provider = { buildInvocation: envelope => ({ cmd: 'claude', payload: envelope.userText }) };
  const envelope = { userText: 'hello', spawnOpts: {}, historyHandle: {} };
  const { request, turn } = turnInput();
  const env = { MULTICC_AUTO_STALL_TIMEOUT_MS: '45000' };
  const first = factory.prepare({
    request, turn, session: auto, provider, envelope, attemptNo: 1, env,
  });
  assert.equal(first.attempt.stallTimeoutMs, 45_000);
  assert.equal(first.attempt.providerId, 'provider-a');
  attempts.finishAttempt(first.attempt, { outcome: 'failed', errorCategory: 'timeout' });
  const next = factory.prepare({
    request, turn, session: auto, provider, envelope, attemptNo: 2, env,
    providerId: 'provider-b', reasonCode: 'auto_failover',
  });
  assert.equal(next.attempt.providerId, 'provider-b');
  assert.equal(next.attempt.stallTimeoutMs, 45_000,
    'the switched line gets its own idle budget, not the failed attempt\'s leftovers');
});

test('WorkBuddy uses vendor login and carries the selected quota identity through proof and retry', () => {
  const { calls, factory } = makeHarness();
  const session = { id: 'session-1', cli: 'codebuddy' };
  const request = normalizeTurnRequest({ sessionId: session.id, cli: session.cli, text: 'hello' });
  const turn = createTurnLifecycle(request, { turnId: 'turn-1' });
  const providerId = 'codebuddy-native:codebuddy';
  const prepared = factory.prepare({
    session, request, turn, attemptNo: 1, providerId, model: 'deepseek-v4.1-flash',
    envelope: { userText: 'hello', spawnOpts: {}, historyHandle: {} },
    provider: { buildInvocation: () => ({ cmd: 'codebuddy', args: [] }) },
  });
  assert.deepEqual(calls.map(call => call.providerId), ['']);
  assert.equal(prepared.binding.providerId, null);
  assert.equal(prepared.attempt.providerName, 'WorkBuddy');
  assert.equal(prepared.attempt.providerId, providerId);
  assert.equal(prepared.routeProof.route.providerId, providerId);
  assert.equal(prepared.usageAttribution.providerId, providerId);
  assert.equal(providerRetryRouteOptions(prepared.attempt).providerId, providerId);
});

test('an OpenCode-native line spawns as a provider-less opencode session on its own model', () => {
  const { calls, factory } = makeHarness();
  // The session keeps its own provider/model; only this attempt's route changes.
  const session = { id: 'session-1', cli: 'opencode', provider: 'zen-managed', model: 'zen-model' };
  const provider = { buildInvocation: envelope => ({ cmd: 'opencode', payload: envelope.userText }) };
  const envelope = { userText: 'hello', spawnOpts: {}, historyHandle: {} };
  const request = normalizeTurnRequest({
    sessionId: 'session-1', text: 'hello', cli: 'opencode',
    hasNativeHistory: false, forceFirst: true,
  });
  const turn = createTurnLifecycle(request, { turnId: 'turn-1' });
  const first = factory.prepare({
    request, turn, session, provider, envelope, attemptNo: 1,
    providerId: 'opencode-native:opencode', model: 'opencode/big-pickle',
  });
  // `opencode-native:<id>` is not a MultiCC route: it must resolve exactly like a
  // provider-less opencode session, so '' goes down to the router (OpenCode
  // reads its own config and credentials) while the candidate's `<id>/<model>`
  // stays the wire model.
  assert.deepEqual(calls.map(call => call.providerId), ['']);
  assert.equal(first.binding.providerId, null);
  assert.equal(first.binding.cli, 'opencode');
  assert.equal(first.binding.model, 'opencode/big-pickle');
  assert.equal(first.attempt.providerId, 'opencode-native:opencode');
  assert.equal(first.attempt.providerName, 'OpenCode Zen');
  assert.equal(first.routeProof.route.providerId, first.attempt.providerId);
  assert.equal(first.usageAttribution.providerId, first.attempt.providerId);
  assert.equal(providerRetryRouteOptions(first.attempt).providerId, first.attempt.providerId);
  assert.equal(first.routeOverrides.model, 'opencode/big-pickle');
  assert.equal(session.provider, 'zen-managed', 'the session provider is never rewritten');
  assert.equal(session.model, 'zen-model');
});

test('OpenCode 自选默认模型或实际模型属于另一家时不归因给候选账号', () => {
  for (const model of [null, '另一个模型', 'other/some-model']) {
    const { factory } = makeHarness();
    const session = { id: '冷缓存', cli: 'opencode' };
    const request = normalizeTurnRequest({ sessionId: session.id, text: '测试', cli: session.cli });
    const prepared = factory.prepare({
      session, request, turn: createTurnLifecycle(request, { turnId: '冷缓存' }),
      providerId: 'opencode-native:opencode', model, attemptNo: 1,
      envelope: { userText: '测试', spawnOpts: {}, historyHandle: {} },
      provider: { buildInvocation: () => ({ cmd: 'opencode' }) },
    });
    assert.equal(prepared.attempt.providerId, '_default_');
  }
});

test('a managed provider id is passed through to the router unchanged', () => {
  const { calls, factory } = makeHarness();
  const session = { id: 'session-1', cli: 'claude', provider: 'provider-a', model: 'sonnet' };
  const provider = { buildInvocation: envelope => ({ cmd: 'claude', payload: envelope.userText }) };
  const envelope = { userText: 'hello', spawnOpts: {}, historyHandle: {} };
  const { request, turn } = turnInput();
  const prepared = factory.prepare({
    request, turn, session, provider, envelope, attemptNo: 1,
    providerId: 'provider-b', model: 'b-model',
  });
  assert.deepEqual(calls.map(call => call.providerId), ['provider-b']);
  assert.equal(prepared.binding.providerId, 'provider-b');
});

function frozenInvocationFactory() {
  const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
  const Module = require('node:module');
  const source = fs.readFileSync(path.join(__dirname, 'helpers/legacy-provider-invocation.js.txt'), 'utf8');
  assert.equal(crypto.createHash('sha256').update(source).digest('hex'), '0d687ef19c0b429d594518f0b26368a0c5575eb3b48a37064e5a54bbcc9f72fd');
  const filename = path.resolve(__dirname, '../src/chat/provider-invocation.js');
  const legacy = new Module(filename);
  legacy.filename = filename;
  legacy.paths = Module._nodeModulePaths(path.dirname(filename));
  legacy.require = name => {
    if (name === '../providers/native-opencode') return require('./helpers/frozen-native-opencode');
    if (name === './model-request-policy') return require('./helpers/legacy-model-request-policy');
    return Module.prototype.require.call(legacy, name);
  };
  legacy._compile(source, filename);
  return legacy.exports.createProviderInvocationFactory;
}

test('Rust preparation matches the frozen owner across CLI, model, bare retry and subagent routes', () => {
  const frozen = frozenInvocationFactory();
  for (const cli of ['claude', 'codex', 'opencode']) {
    const request = normalizeTurnRequest({ sessionId: 'session-1', text: 'hello', cli, hasNativeHistory: false, forceFirst: true });
    const turn = createTurnLifecycle(request, { turnId: 'turn-1' });
    for (const bare of [false, true]) for (const subagent of [false, true]) for (const explicit of [false, true]) {
      const run = makeFactory => {
        const h = makeHarness(makeFactory);
        const session = { id: 'session-1', cli, provider: 'provider-a', model: 'sonnet', cliSessionId: 'native-1',
          ...(subagent ? { subagent: { providerId: 'provider-b', model: 'worker-model' } } : {}) };
        const provider = { buildInvocation: envelope => ({ cmd: cli, args: ['--model', envelope.spawnOpts.rawModel], payload: envelope.userText }) };
        const result = h.factory.prepare({ request, turn, attemptNo: 1, session, provider,
          envelope: { userText: 'hello', spawnOpts: {}, historyHandle: {}, contextLayers: ['history'] },
          ...(bare ? { bareText: 'continue', firstTurn: true } : {}),
          ...(explicit ? { providerId: 'provider-b', model: null } : {}), env: {} });
        return { result, calls: h.calls };
      };
      assert.deepEqual(run(createProviderInvocationFactory), run(frozen), JSON.stringify({ cli, bare, subagent, explicit }));
    }
  }
});

test('Rust preparation preserves lazy resolution reads and visits the complete model list', () => {
  const frozen = frozenInvocationFactory();
  const { request, turn } = turnInput();
  const run = makeFactory => {
    const h = makeHarness(makeFactory), reads = [];
    const models = ['one', 'two'].map(value => ({ toString() { reads.push(value); return value; } }));
    h.router.resolveSpawnEnv = () => new Proxy({ qualifiedModel: 'wire', providerModels: models }, {
      get(target, key, receiver) { reads.push(String(key)); return Reflect.get(target, key, receiver); },
    });
    const result = h.factory.prepare({ request, turn, attemptNo: 1,
      session: { id: 'session-1', cli: 'claude', provider: 'provider-a', model: null },
      provider: { buildInvocation: () => ({ cmd: 'claude', args: [] }) },
      envelope: { spawnOpts: {}, historyHandle: {} }, env: {} });
    return { reads, selected: result.routeOverrides.model, spawnKey: result.attempt.spawnKey };
  };
  const oracle = run(frozen);
  assert.ok(oracle.reads.includes('one') && oracle.reads.includes('two'));
  assert.deepEqual(run(createProviderInvocationFactory), oracle);
});

test('Rust preparation cleans up a failed proof once and rethrows the same exception', () => {
  for (const makeFactory of [frozenInvocationFactory(), createProviderInvocationFactory]) {
    const fault = new Error('proxy capability failed'), finished = [];
    const h = makeHarness(options => makeFactory({ ...options, providerAttemptRuntime: {
      ...options.providerAttemptRuntime,
      finishAttempt(...args) { finished.push(args); return options.providerAttemptRuntime.finishAttempt(...args); },
      proxySessionId() { throw fault; },
    } }));
    const { request, turn } = turnInput();
    assert.throws(() => h.factory.prepare({ request, turn, attemptNo: 1,
      session: { id: 'session-1', cli: 'claude', provider: 'provider-a', model: 'sonnet' },
      provider: { buildInvocation: () => ({ args: [] }) }, envelope: { spawnOpts: {}, historyHandle: {} } }), error => error === fault);
    assert.equal(finished.length, 1);
    assert.deepEqual(finished[0][1], { outcome: 'failed', errorCategory: 'route_proof', reasonCode: 'route_proof_rejected' });
  }
});
