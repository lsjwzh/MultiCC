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
const { createUsageObserved } = require('../src/usage-observed');
const { canPersistAdapterCompletion } = require('../src/chat/adapter-completion');
const { planTurnFinalization, resolveTurnFinalization } = require('../src/chat/finalize-plan');
const { resolveTurnState } = require('../src/classify/turn-state');
const { normalizeProxyOutcome } = require('../src/providers/proxy-outcome');

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

test('finalization marks the attempt before an injected clock can reenter', () => {
  let runtime;
  let inspect = false;
  let during;
  let sequence = 0;
  runtime = createProviderAttemptRuntime({ runtimeEpoch: 'epoch', nextId: prefix => `${prefix}-${++sequence}`,
    now: () => { if (inspect) { inspect = false; during = runtime.snapshot('session-1'); } return 1234; } });
  const attempt = runtime.beginAttempt(route());
  inspect = true;
  assert.equal(runtime.finishAttempt(attempt, { outcome: 'failed', errorCategory: 'network' }).ok, true);
  assert.equal(during.outcome, 'failed');
  assert.equal(during.errorCategory, 'network');
  assert.equal(during.finishedAt, null);
  assert.equal(runtime.finishAttempt(attempt, { outcome: 'succeeded' }).code, 'attempt_not_running');
});

test('same-session attempt creation cannot reenter before its record is installed', () => {
  let runtime;
  let entered = false;
  let nestedError;
  let other;
  let sequence = 0;
  runtime = createProviderAttemptRuntime({
    runtimeEpoch: 'epoch',
    nextId: prefix => `${prefix}-${++sequence}`,
    now: () => {
      if (!entered) {
        entered = true;
        try { runtime.beginAttempt(route({ turnId: 'nested' })); } catch (error) { nestedError = error; }
        other = runtime.beginAttempt(route({ sessionId: 'other' }));
      }
      return 1000;
    },
  });
  const outer = runtime.beginAttempt(route());
  assert.equal(nestedError?.code, 'PROVIDER_ATTEMPT_IN_FLIGHT');
  assert.equal(runtime.acceptEvent(outer), true);
  assert.equal(runtime.acceptEvent(other), true, 'independent sessions remain admissible');
});

test('attempt admission is released after a host callback throws', () => {
  let fail = true;
  let sequence = 0;
  const runtime = createProviderAttemptRuntime({
    runtimeEpoch: 'epoch',
    nextId: prefix => {
      if (fail) { fail = false; throw new Error('id callback failed'); }
      return `${prefix}-${++sequence}`;
    },
  });
  assert.throws(() => runtime.beginAttempt(route()), /id callback failed/);
  assert.equal(runtime.acceptEvent(runtime.beginAttempt(route())), true);
});

test('selection callback can finish the installed attempt and start its successor', () => {
  let runtime;
  let successor;
  let callbackError;
  let handled = false;
  let sequence = 0;
  runtime = createProviderAttemptRuntime({
    runtimeEpoch: 'epoch', nextId: prefix => `${prefix}-${++sequence}`,
    emit: (_, event) => {
      if (handled || event.routePhase !== 'selected') return;
      handled = true;
      runtime.finishAttempt(runtime.snapshot('session-1'), { outcome: 'failed' });
      try { successor = runtime.beginAttempt(route({ turnId: 'turn-2' })); }
      catch (error) { callbackError = error; }
    },
  });
  const original = runtime.beginAttempt(route());
  assert.equal(callbackError, undefined);
  assert.equal(runtime.acceptEvent(original), false);
  assert.equal(runtime.acceptEvent(successor), true);
  assert.equal(runtime.snapshot('session-1').turnId, 'turn-2');
});

test('native attempt generations preserve distinct UTF-16 session identities', () => {
  const { runtime } = harness();
  const first = runtime.beginAttempt(route({ sessionId: '\ud800' }));
  const second = runtime.beginAttempt(route({ sessionId: '\ud801' }));
  assert.equal(first.routeGeneration, 1);
  assert.equal(second.routeGeneration, 1);
  assert.equal(runtime.finishAttempt(first, { outcome: 'failed' }).ok, true);
  const next = runtime.beginAttempt(route({ sessionId: '\ud800', turnId: 'turn-2' }));
  assert.equal(next.routeGeneration, 2);
  assert.equal(runtime.acceptEvent(first), false);
  assert.equal(runtime.acceptEvent(second), true);
});

test('native background producer ledger matches Node accounting, receipt consumption and FIFO eviction', () => {
  const { RustNonMainProducers } = require('../src/native/runtime').getNative();
  const native = new RustNonMainProducers();
  const active = new Map();
  const ended = new Map();
  function expected(op, key) {
    if (op === 'start') {
      ended.delete(key);
      const producer = active.get(key);
      if (producer) { producer.count += 1; producer.ambiguous = true; }
      else active.set(key, { count: 1, ambiguous: false });
      return;
    }
    if (op === 'hasActive') return active.has(key);
    if (op === 'bindUsage') {
      const producer = active.get(key);
      if (producer && producer.count === 1 && !producer.ambiguous) return true;
      return ended.delete(key);
    }
    const producer = active.get(key);
    if (!producer) return false;
    producer.count = Math.max(0, producer.count - 1);
    if (producer.count === 0) {
      active.delete(key);
      if (!producer.ambiguous) {
        ended.set(key, true);
        if (ended.size > 2048) ended.delete(ended.keys().next().value);
      }
    }
    return true;
  }
  function apply(op, key) { assert.equal(native[op](key), expected(op, key), `${op} ${JSON.stringify(key)}`); }
  const keys = ['\ud800\0sub', '\ud801\0sub', 'session\0token\0background', 'session\0token\0aux'];
  let seed = 0x4657;
  for (let i = 0; i < 12000; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const key = keys[(seed >>> 3) % keys.length];
    const op = ['start', 'end', 'hasActive', 'bindUsage'][(seed >>> 11) % 4];
    apply(op, key);
  }
  for (let i = 0; i < 2055; i++) { apply('start', `fifo-${i}`); apply('end', `fifo-${i}`); }
  for (let i = 0; i < 2055; i++) apply('bindUsage', `fifo-${i}`);
});

test('native main producer registry preserves snapshot identity, UTF-16 keys and unbounded ended receipts', () => {
  const { RustMainProducers } = require('../src/native/runtime').getNative();
  const native = new RustMainProducers();
  const snapshot = Object.freeze({ routeAttemptId: 'a', turnId: '\ud800' });
  const key = '\ud800\0session';
  native.setActive(key, snapshot, '\ud801-token', 1, false, NaN);
  const captured = native.getActive(key);
  assert.equal(captured.attempt, snapshot);
  assert.equal(Object.isFrozen(captured.attempt), true);
  assert.equal(captured.proxyRouteToken, '\ud801-token');
  assert.equal(Number.isNaN(captured.lastRequestAt), true);
  assert.equal(native.getActive('\ud801\0session'), undefined);
  native.deleteActive(key);
  native.setActive(key, snapshot, 'next-token', 1, false, 10);
  captured.count += 1;
  captured.ambiguous = true;
  assert.equal(native.getActive(key).count, 1, 'a detached producer cannot mutate its replacement');
  assert.equal(captured.attempt, snapshot);
  native.setEnded(key, captured.attempt, captured.proxyRouteToken);
  for (let i = 0; i < 2200; i++) native.setEnded(`unrelated-${i}`, snapshot, 'token');
  const ended = native.getEnded(key);
  assert.equal(ended.attempt, snapshot);
  assert.equal(ended.proxyRouteToken, '\ud801-token');
  assert.equal(native.hasEnded(key), true);
  native.deleteEnded(key);
  assert.equal(native.hasEnded(key), false);
  assert.equal(ended.attempt, snapshot, 'a captured receipt outlives removal');
});

test('current attempt registry preserves identity and separates UTF-16 session keys', () => {
  const { RustCurrentAttempts } = require('../src/native/runtime').getNative();
  const registry = new RustCurrentAttempts();
  const old = { id: 'old' };
  const replacement = { id: 'new' };
  assert.equal(registry.beginAdmission('\ud800'), true);
  assert.equal(registry.beginAdmission('\ud800'), false);
  assert.equal(registry.beginAdmission('\ud801'), true);
  registry.endAdmission('\ud800');
  assert.equal(registry.beginAdmission('\ud800'), true);
  registry.endAdmission('\ud800');
  registry.endAdmission('\ud801');
  registry.set('\ud800', old);
  assert.equal(registry.get('\ud800'), old);
  assert.equal(registry.get('\ud801'), undefined);
  const captured = registry.get('\ud800');
  registry.set('\ud800', replacement);
  assert.equal(registry.get('\ud800'), replacement);
  captured.id = 'changed';
  assert.equal(replacement.id, 'new');
  assert.throws(() => registry.set('\ud800', null));
  assert.equal(registry.get('\ud800'), replacement, 'failed replacement retains current attempt');
  const reference = new Map();
  const keys = ['', 'session', '\ud800', '\ud801', 'a\0b'];
  let seed = 0x1267;
  for (let i = 0; i < 10000; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const key = keys[seed % keys.length];
    if (seed & 8) {
      const value = { i };
      registry.set(key, value);
      reference.set(key, value);
    } else if (reference.has(key) || key !== '\ud800') {
      assert.equal(registry.get(key), reference.get(key));
    }
  }
});

test('native producer and current attempt references survive worker environment teardown', async () => {
  const { Worker } = require('node:worker_threads');
  const source = `
    const { workerData, parentPort } = require('node:worker_threads');
    const { RustMainProducers, RustCurrentAttempts } = require(workerData.runtime).getNative();
    const retained = [];
    for (let i = 0; i < 200; i++) {
      const registry = new RustMainProducers();
      const attempts = new RustCurrentAttempts();
      attempts.beginAdmission('session');
      const snapshot = Object.freeze({ id: i });
      attempts.set('session', snapshot);
      if (attempts.get('session') !== snapshot) throw new Error('attempt identity lost');
      registry.setActive('session', snapshot, 'token', 1, false, i);
      const captured = registry.getActive('session');
      registry.deleteActive('session');
      registry.setEnded('session', captured.attempt, captured.proxyRouteToken);
      if (registry.getEnded('session').attempt !== snapshot) throw new Error('identity lost');
      if (i % 3 === 0) registry.deleteEnded('session');
      retained.push([registry, captured, attempts]);
    }
    globalThis.retained = retained;
    if (workerData.terminate) { parentPort.postMessage('ready'); setInterval(() => {}, 1000); }
  `;
  const runtime = require.resolve('../src/native/runtime');
  const natural = Array.from({ length: 4 }, () => new Worker(source, { eval: true, workerData: { runtime } }));
  const forced = Array.from({ length: 4 }, () => new Worker(source, { eval: true, workerData: { runtime, terminate: true } }));
  await Promise.all([
    ...natural.map(worker => new Promise((resolve, reject) => {
      worker.once('error', reject);
      worker.once('exit', code => code === 0 ? resolve() : reject(new Error(`worker exit ${code}`)));
    })),
    ...forced.map(worker => new Promise((resolve, reject) => {
      let terminating = false;
      worker.once('error', reject);
      worker.once('message', () => { terminating = true; worker.terminate().then(resolve, reject); });
      worker.once('exit', code => { if (!terminating) reject(new Error(`worker exited before termination: ${code}`)); });
    })),
  ]);
});

test('main end-before-usage ignores mismatched provider and token without consuming its receipt', () => {
  const { runtime } = harness();
  const attempt = runtime.beginAttempt(route());
  const context = proxy(runtime, attempt, { phase: 'request' });
  runtime.onProxyActivity(context);
  const ended = runtime.onProxyActivity({ ...context, phase: 'end' });
  assert.equal(Object.isFrozen(ended), true);
  const mismatchProvider = runtime.attributeProxyUsage({ ...context, providerId: 'wrong-provider', eventId: 'wrong-provider' });
  assert.equal(mismatchProvider.routeAttribution, 'ambiguous');
  const wrongSession = `pr1.${Buffer.from('session-1').toString('base64url')}.${Buffer.from('wrong-token').toString('base64url')}`;
  const mismatchToken = runtime.attributeProxyUsage({ ...context, sessionId: wrongSession, eventId: 'wrong-token' });
  assert.equal(mismatchToken.routeAttribution, 'ambiguous');
  const exact = runtime.attributeProxyUsage({ ...context, eventId: 'matching' });
  assert.equal(exact.routeAttribution, 'exact');
  assert.equal(exact.routeAttemptId, attempt.routeAttemptId);
  assert.equal(runtime.attributeProxyUsage({ ...context, eventId: 'duplicate' }).routeAttribution, 'ambiguous');
});

test('stale attempt usage does not consume the previous resident producer receipt', () => {
  const { runtime, audit } = harness();
  const resident = { cli: 'claude', protocol: 'anthropic', spawnKey: 'stable-spawn' };
  const first = runtime.beginAttempt(route(resident));
  const context = proxy(runtime, first, { phase: 'request' });
  runtime.onProxyActivity(context);
  runtime.onProxyActivity({ ...context, phase: 'end' });
  runtime.finishAttempt(first, { outcome: 'failed' });
  const second = runtime.beginAttempt(route({ ...resident, attemptNo: 2 }));
  assert.equal(runtime.proxySessionId(second), context.sessionId);
  runtime.finishAttempt(second, { outcome: 'succeeded' });
  for (const eventId of ['old-1', 'old-2']) {
    assert.equal(runtime.attributeProxyUsage({ ...context, eventId }).routeAttribution, 'ambiguous');
  }
  assert.equal(audit.filter(entry => entry.event.operation === 'proxy_usage').length, 2,
    'both stale events must see the unconsumed receipt and remain in the main attribution lane');
});

test('main request revision callback can replace a producer without the old lookup changing it', () => {
  let sequence = 0;
  let runtime;
  let reenter = false;
  let context;
  runtime = createProviderAttemptRuntime({
    runtimeEpoch: 'epoch', now: () => 1000, nextId: prefix => `${prefix}-${++sequence}`,
    resolveProviderRevision: () => {
      if (reenter) {
        reenter = false;
        assert.equal(runtime.forceReleaseProducers('session-1').released, 1);
        runtime.onProxyActivity(context);
      }
      return 'revision-a';
    },
  });
  const attempt = runtime.beginAttempt(route());
  context = proxy(runtime, attempt, { phase: 'request' });
  runtime.onProxyActivity(context);
  reenter = true;
  runtime.onProxyActivity(context);
  assert.equal(runtime.forceReleaseProducers('session-1').released, 1,
    'the outer callback must only update the detached producer');
});

test('an injected clock exception keeps the earlier ambiguous producer increments', () => {
  let sequence = 0;
  let failClock = false;
  const runtime = createProviderAttemptRuntime({
    runtimeEpoch: 'epoch',
    now: () => { if (failClock) throw new Error('clock failed'); return 1000; },
    nextId: prefix => `${prefix}-${++sequence}`,
  });
  const attempt = runtime.beginAttempt(route());
  runtime.onProxyActivity(proxy(runtime, attempt, { phase: 'request' }));
  const wrongSession = `pr1.${Buffer.from('session-1').toString('base64url')}.${Buffer.from('wrong-token').toString('base64url')}`;
  failClock = true;
  assert.throws(() => runtime.onProxyActivity({ sessionId: wrongSession, role: 'main', phase: 'request' }), /clock failed/);
  failClock = false;
  assert.equal(runtime.forceReleaseProducers('session-1').released, 2);
});

test('native identity checks retain JS short circuit and Number conversion', () => {
  const { RustProviderAttemptLifecycle } = require('../src/native/runtime').getNative();
  const identity = { runtimeEpoch: '\ud800', routeAttemptId: 'a', routeGeneration: 1, turnId: 't' };
  const state = new RustProviderAttemptLifecycle('none', false, false, false, null, 0, identity);
  assert.equal(state.matches({ runtimeEpoch: 'old', get routeAttemptId() { throw new Error('must not read'); } }), false);
  assert.equal(state.matches({ ...identity, routeGeneration: 1n }), true);
  assert.equal(state.matches({ ...identity, runtimeEpoch: '\ud801' }), false);
  assert.throws(() => state.matches({ ...identity, routeGeneration: Symbol('bad') }), TypeError);
});

test('native identity conversion calls a replaced Number with the strict-mode receiver', () => {
  const { RustProviderAttemptLifecycle } = require('../src/native/runtime').getNative();
  const identity = { runtimeEpoch: 'epoch', routeAttemptId: 'a', routeGeneration: 1, turnId: 't' };
  const state = new RustProviderAttemptLifecycle('none', false, false, false, null, 0, identity);
  const originalNumber = global.Number;
  let receiver = 'not called';
  try {
    global.Number = function (value) { 'use strict'; receiver = this; return originalNumber(value); };
    assert.equal(state.matches(identity), true);
    assert.equal(receiver, undefined);
  } finally {
    global.Number = originalNumber;
  }
});

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
  assert.deepEqual(events.map(item => item.event.routePhase), ['selected']);
  assert.equal(events[0].event.providerRouteScope, 'attempt');

  assert.equal(runtime.finishAttempt(first, { outcome: 'failed', errorCategory: 'billing_quota' }).ok, true);
  const second = runtime.beginAttempt(route({
    providerId: 'provider-b', providerName: 'Provider B', model: 'model-b', attemptNo: 2,
  }));
  assert.equal(second.routeGeneration, 2);
  assert.equal(second.decisionId, first.decisionId, 'one logical turn owns one route decision');
  assert.notEqual(second.routeAttemptId, first.routeAttemptId);
  assert.deepEqual(events.map(item => item.event.routePhase), ['selected', 'failed', 'switched']);
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

test('an exact main proxy 429 is retained as immutable attempt failure evidence', () => {
  const { runtime } = harness();
  const attempt = runtime.beginAttempt(route());
  const outcome = runtime.observeProxyOutcome({
    ...attempt,
    roleKind: 'main',
    routeAttribution: 'exact',
    status: 'error',
    statusCode: 429,
    errorCode: 'UPSTREAM_HTTP_ERROR',
  });
  assert.equal(outcome.accepted, true);
  assert.deepEqual(runtime.proxyFailure(attempt), {
    source: 'proxy_response',
    provider: 'codex',
    providerId: 'provider-a',
    providerName: 'Provider A',
    httpStatus: 429,
    code: 'UPSTREAM_HTTP_ERROR',
    message: 'upstream HTTP 429',
    observedAt: 1_003,
  });
  assert.equal(Object.isFrozen(runtime.proxyFailure(attempt)), true);
});

test('a 429 outcome carries only the validated structured rejection onto proxyFailure()', () => {
  const { runtime } = harness();
  const attempt = runtime.beginAttempt(route());
  const observe = rejection => runtime.observeProxyOutcome({
    ...attempt, roleKind: 'main', routeAttribution: 'exact',
    status: 'error', statusCode: 429, errorCode: 'UPSTREAM_HTTP_ERROR', rejection,
  });

  observe({
    kind: 'entitlement',
    scope: 'model',
    window: null,
    resetMs: null,
    code: 'usage_credits_required',
    model: 'fable-1',
    source: 'text',
    // Anything outside the contract must not survive into persisted state.
    injected: { secret: 'nope' },
    extra: 'nope',
  });
  const failure = runtime.proxyFailure(attempt);
  assert.deepEqual(failure.rejection, {
    kind: 'entitlement', scope: 'model', window: null, resetMs: null,
    code: 'usage_credits_required', model: 'fable-1', source: 'text',
  });
  assert.equal(Object.isFrozen(failure.rejection), true);
  assert.equal('injected' in failure.rejection, false);

  // Unknown enum values degrade to null instead of rejecting the verdict, and
  // free text is capped rather than trusted at whatever length it arrives.
  observe({
    kind: 'window', scope: 'galaxy', window: '5y', resetMs: -1,
    code: 'x'.repeat(200), model: 'm'.repeat(200), source: 'psychic',
  });
  assert.deepEqual(runtime.proxyFailure(attempt).rejection, {
    kind: 'window', scope: null, window: null, resetMs: null,
    code: 'x'.repeat(80), model: 'm'.repeat(80), source: null,
  });

  // A rejection without a valid kind cannot steer classification at all.
  observe({ kind: 'totally-unknown', scope: 'model' });
  assert.equal('rejection' in runtime.proxyFailure(attempt), false);
});

test('a non-429 outcome never stores a structured rejection', () => {
  const { runtime } = harness();
  const attempt = runtime.beginAttempt(route());
  runtime.observeProxyOutcome({
    ...attempt, roleKind: 'main', routeAttribution: 'exact',
    status: 'error', statusCode: 503, errorCode: 'UPSTREAM_HTTP_ERROR',
    rejection: { kind: 'transient', scope: 'request', window: null, resetMs: null, code: null, model: null, source: 'headers' },
  });
  assert.equal(runtime.proxyFailure(attempt).httpStatus, 503);
  assert.equal('rejection' in runtime.proxyFailure(attempt), false);
});

function downstreamOutcome() {
  return Object.freeze({ version: 1, requestId: 'request-1', requestKind: 'inference',
    termination: 'downstream_disconnect', httpStatus: null });
}

for (const cli of ['codex', 'claude', 'opencode']) {
  test(`a clean durable ${cli} result reconciles structural downstream teardown`, () => {
    const { runtime } = harness();
    const attempt = runtime.beginAttempt(route({ cli }));
    runtime.observeProxyOutcome({
      ...attempt, roleKind: 'main', routeAttribution: 'exact',
      status: 'error', statusCode: 200, errorCode: 'ARBITRARY_ADAPTER_CODE', proxyOutcome: downstreamOutcome(),
    });
    const failure = runtime.proxyFailure(attempt);
    assert.equal(failure.code, 'ARBITRARY_ADAPTER_CODE');
    assert.equal(runtime.proxyFailure(attempt, { resultDurable: true, completion: { version: 1, state: 'completed', settled: true } }), null);
    assert.deepEqual(runtime.proxyFailure(attempt), failure, 'raw proxy evidence remains available');
    const finalization = resolveTurnFinalization(planTurnFinalization({
      completion: { version: 1, state: 'completed', settled: true },
      current: true, runnerKind: 'process', cli, code: 0,
      hasOutput: true, resultEvent: true, resultDurable: true,
      apiError: !!runtime.proxyFailure(attempt, { resultDurable: true, completion: { version: 1, state: 'completed', settled: true } }),
    }));
    const boundary = finalization.effects.find(effect => effect.type === 'classify-turn-end').classification;
    assert.equal(boundary, 'succeeded');
    assert.equal(resolveTurnState({ liveness: { state: 'inactive' }, boundary }).state, 'D');
    assert.ok(finalization.effects.some(effect => effect.type === 'run-post-turn' && !effect.apiError));
    for (const facts of [
      {}, { resultDurable: true, cleanClose: true }, { resultDurable: true }, { completion: { version: 1, state: 'completed', settled: true } },
      { resultDurable: false, completion: { version: 1, state: 'completed', settled: true } },
      { resultDurable: true, completion: { version: 1, state: 'failed', settled: true } },
    ]) assert.deepEqual(runtime.proxyFailure(attempt, facts), failure,
      'partial output, failed persistence, and interrupted exits still fail');
  });
}

for (const errorCode of ['client_disconnected', 'CLIENT_ABORTED']) {
  test(`a later ${errorCode} cannot replace an earlier upstream failure in the same attempt`, () => {
    const { runtime } = harness();
    const attempt = runtime.beginAttempt(route());
    const identity = { ...attempt, roleKind: 'main', routeAttribution: 'exact', status: 'error' };
    runtime.observeProxyOutcome({ ...identity, statusCode: 429, errorCode: 'UPSTREAM_HTTP_ERROR' });
    runtime.observeProxyOutcome({ ...identity, statusCode: 200, errorCode, proxyOutcome: downstreamOutcome() });
    assert.equal(runtime.proxyFailure(attempt, { resultDurable: true, completion: { version: 1, state: 'completed', settled: true } }).httpStatus, 429);
  });
}

test('a completion without protocol evidence cannot hide HTTP, upstream-stream, or unstructured failures', () => {
  for (const failure of [
    { errorCode: 'UPSTREAM_HTTP_ERROR', statusCode: 429 },
    { errorCode: 'UPSTREAM_HTTP_ERROR', statusCode: 404 },
    { errorCode: 'CLIENT_DISCONNECTED', statusCode: 502 },
    { errorCode: 'CLIENT_ABORTED', statusCode: 502 },
    { errorCode: 'UPSTREAM_CONNECT_FAILED' },
    { errorCode: 'UPSTREAM_STREAM_FAILED' },
    { errorCode: 'CLIENT_DISCONNECTED', cli: 'claude' },
    { errorCode: 'CLIENT_ABORTED', cli: 'claude' },
  ]) {
    const { runtime } = harness();
    const attempt = runtime.beginAttempt(route({ cli: failure.cli || 'codex' }));
    runtime.observeProxyOutcome({
      ...attempt, roleKind: 'main', routeAttribution: 'exact', status: 'error',
      errorCode: failure.errorCode, statusCode: failure.statusCode,
    });
    assert.ok(runtime.proxyFailure(attempt, { resultDurable: true, completion: { version: 1, state: 'completed', settled: true } }));
  }
});

// A mid-turn upstream cut that the CLI retried internally must not flip the
// turn to E once the protocol says the turn completed — the 2026-09-10 codex
// false-positive class (4 cases in 18h of production logs, all with
// task_complete in the rollout). Request recovery remains diagnostic; the
// protocol-attested final outcome determines whether the turn recovered.
function completedInferenceOutcome(requestId = 'request-ok') {
  return Object.freeze({ version: 1, requestId, requestKind: 'inference',
    termination: 'completed', httpStatus: null });
}
function upstreamCutOutcome(requestId) {
  return Object.freeze({ version: 1, requestId, requestKind: 'inference',
    termination: 'upstream_failure', httpStatus: null });
}

test('a recovered mid-turn upstream failure reconciles with a protocol completion', () => {
  const { runtime, audit } = harness();
  const attempt = runtime.beginAttempt(route());
  const identity = { ...attempt, roleKind: 'main', routeAttribution: 'exact' };
  runtime.observeProxyOutcome({ ...identity, status: 'error', statusCode: 200,
    errorCode: 'UPSTREAM_STREAM_FAILED', proxyOutcome: upstreamCutOutcome('request-cut') });
  assert.equal(runtime.proxyFailure(attempt).code, 'UPSTREAM_STREAM_FAILED');
  runtime.observeProxyOutcome({ ...identity, status: 'ok', statusCode: 200,
    proxyOutcome: completedInferenceOutcome() });
  const recovered = runtime.proxyFailure(attempt);
  assert.equal(recovered.recovered, true, 'later clean inference marks the stain recovered');
  assert.ok(audit.some(item => item.event.type === 'provider_attempt_proxy_failure_recovered'));
  for (const source of ['protocol', 'protocol_and_exit']) {
    assert.equal(runtime.proxyFailure(attempt, { resultDurable: true,
      completion: { version: 1, state: 'completed', settled: true, source } }), null,
      `recovered stain is reconciled for ${source} completions`);
  }
  assert.ok(runtime.proxyFailure(attempt), 'raw proxy evidence remains available');
});

test('host-guessed completions never forgive a recovered upstream failure', () => {
  const { runtime } = harness();
  const attempt = runtime.beginAttempt(route());
  const identity = { ...attempt, roleKind: 'main', routeAttribution: 'exact' };
  runtime.observeProxyOutcome({ ...identity, status: 'error', statusCode: 200,
    errorCode: 'UPSTREAM_STREAM_FAILED', proxyOutcome: upstreamCutOutcome('request-cut') });
  runtime.observeProxyOutcome({ ...identity, status: 'ok', statusCode: 200,
    proxyOutcome: completedInferenceOutcome() });
  for (const source of ['exit_fallback', 'host', undefined]) {
    assert.ok(runtime.proxyFailure(attempt, { resultDurable: true,
      completion: { version: 1, state: 'completed', settled: true, source } }),
      `completion source ${source} keeps the veto`);
  }
});

test('protocol completion proves recovery even without a later proxy success callback', () => {
  const { runtime } = harness();
  const attempt = runtime.beginAttempt(route());
  runtime.observeProxyOutcome({ ...attempt, roleKind: 'main', routeAttribution: 'exact',
    status: 'error', statusCode: 200, errorCode: 'UPSTREAM_STREAM_FAILED',
    proxyOutcome: upstreamCutOutcome('request-cut') });
  assert.equal(runtime.proxyFailure(attempt, { resultDurable: true,
    completion: { version: 1, state: 'completed', settled: true, source: 'protocol' } }), null);
  assert.equal(runtime.proxyFailure(attempt).code, 'UPSTREAM_STREAM_FAILED',
    'the original diagnostic is retained');
});

for (const httpStatus of [400, 401, 403, 404, 408, 429, 500, 502, 503, 504]) {
  test(`HTTP ${httpStatus} remains diagnostic after the workflow completes`, () => {
    const { runtime, audit } = harness();
    const attempt = runtime.beginAttempt(route());
    const identity = { ...attempt, roleKind: 'main', routeAttribution: 'exact' };
    runtime.observeProxyOutcome({ ...identity, status: 'error', statusCode: httpStatus,
      errorCode: 'UPSTREAM_HTTP_ERROR', proxyOutcome: normalizeProxyOutcome({
        version: 1, requestId: 'request-http-error', requestKind: 'inference',
        termination: 'upstream_http_error', httpStatus,
      }) });
    const failure = runtime.proxyFailure(attempt);
    for (const source of ['protocol', 'protocol_and_exit']) {
      const completed = { version: 1, state: 'completed', settled: true, source };
      assert.equal(canPersistAdapterCompletion(completed, failure), true);
      assert.equal(runtime.proxyFailure(attempt, { resultDurable: true, completion: completed }), null);
      assert.deepEqual(runtime.proxyFailure(attempt), failure);
      assert.ok(runtime.proxyFailure(attempt, { resultDurable: false, completion: completed }));
      for (const invalid of [
        { ...completed, state: 'failed' }, { ...completed, state: 'cancelled' },
        { ...completed, state: 'unknown' }, { ...completed, settled: false },
        { ...completed, source: 'exit_fallback' },
      ]) {
        assert.equal(canPersistAdapterCompletion(invalid, failure), false);
        assert.ok(runtime.proxyFailure(attempt, { resultDurable: true, completion: invalid }));
      }
      assert.equal(canPersistAdapterCompletion(completed, failure, { message: 'terminal error' }), false);
    }
    runtime.observeProxyOutcome({ ...identity, status: 'ok', statusCode: 200,
      proxyOutcome: completedInferenceOutcome() });
    assert.equal(runtime.proxyFailure(attempt).recovered, true, 'request recovery also remains visible');
    assert.equal(runtime.proxyFailure(attempt).httpStatus, httpStatus);
    assert.ok(audit.some(item => item.event.type === 'provider_attempt_proxy_failure_observed'
      && item.event.httpStatus === httpStatus && item.event.requestId === 'request-http-error'));
  });
}

test('a failure after the recovery replaces the record and drops the marker', () => {
  const { runtime } = harness();
  const attempt = runtime.beginAttempt(route());
  const identity = { ...attempt, roleKind: 'main', routeAttribution: 'exact' };
  runtime.observeProxyOutcome({ ...identity, status: 'error', statusCode: 200,
    errorCode: 'UPSTREAM_STREAM_FAILED', proxyOutcome: upstreamCutOutcome('request-cut-1') });
  runtime.observeProxyOutcome({ ...identity, status: 'ok', statusCode: 200,
    proxyOutcome: completedInferenceOutcome() });
  assert.equal(runtime.proxyFailure(attempt).recovered, true);
  runtime.observeProxyOutcome({ ...identity, status: 'error', statusCode: 200,
    errorCode: 'UPSTREAM_STREAM_FAILED', proxyOutcome: upstreamCutOutcome('request-cut-2') });
  const failure = runtime.proxyFailure(attempt);
  assert.equal(failure.proxyOutcome.requestId, 'request-cut-2');
  assert.equal(failure.recovered, undefined);
  assert.ok(runtime.proxyFailure(attempt, { resultDurable: true,
    completion: { version: 1, state: 'failed', settled: true, source: 'protocol' } }),
    'a request retry succeeding does not override a later failed workflow');
});

test('the persist gate and the close-time reconciliation share one predicate', () => {
  const done = source => ({ version: 1, state: 'completed', settled: true, source });
  const cut = { source: 'proxy_response', httpStatus: null,
    proxyOutcome: { termination: 'upstream_failure' } };
  assert.equal(canPersistAdapterCompletion(done('protocol'), null, null), true);
  assert.equal(canPersistAdapterCompletion(done('protocol'), cut, null), true,
    'protocol completion proves workflow recovery without a proxy recovery marker');
  assert.equal(canPersistAdapterCompletion(done('protocol'), { ...cut, recovered: true }, null), true,
    'recovered cut + protocol completion persists');
  assert.equal(canPersistAdapterCompletion(done('exit_fallback'), { ...cut, recovered: true }, null), false,
    'recovered cut + host-guessed completion still vetoes');
  assert.equal(canPersistAdapterCompletion(done('protocol'),
    { ...cut, httpStatus: 500, recovered: true }, null), true, 'HTTP errors follow the workflow outcome');
  assert.equal(canPersistAdapterCompletion(done('protocol'),
    { source: 'proxy_response', httpStatus: null,
      proxyOutcome: { termination: 'downstream_disconnect' } }, null), true,
    'downstream teardown after completion stays forgivable');
  assert.equal(canPersistAdapterCompletion(
    { version: 1, state: 'failed', settled: true, source: 'protocol' },
    { ...cut, recovered: true }, null), false, 'a failed completion never persists');
});

test('non-inference failures cannot poison or erase the model attempt outcome', () => {
  const { runtime } = harness();
  const attempt = runtime.beginAttempt(route({ cli: 'claude' }));
  const identity = { ...attempt, roleKind: 'main', routeAttribution: 'exact', status: 'error', statusCode: 404 };
  for (const requestKind of ['probe', 'auxiliary']) {
    const probe = { ...identity, proxyOutcome: {
      version: 1, requestId: 'probe-1', requestKind, termination: 'upstream_http_error', httpStatus: 404,
    } };
    runtime.observeProxyOutcome(probe);
    assert.equal(runtime.proxyFailure(attempt), null);
  }
  runtime.observeProxyOutcome({ ...identity, statusCode: 429 });
  runtime.observeProxyOutcome({ ...identity, proxyOutcome: {
    version: 1, requestId: 'probe-2', requestKind: 'probe', termination: 'upstream_http_error', httpStatus: 404,
  } });
  assert.equal(runtime.proxyFailure(attempt).httpStatus, 429);
});

test('ambiguous, non-main, and stale proxy outcomes cannot contaminate the current attempt', () => {
  const { runtime } = harness();
  const first = runtime.beginAttempt(route());
  for (const event of [
    { ...first, roleKind: 'main', routeAttribution: 'ambiguous' },
    { ...first, roleKind: 'sub', routeAttribution: 'exact' },
  ]) {
    assert.equal(runtime.observeProxyOutcome({
      ...event, status: 'error', statusCode: 429,
    }).accepted, false);
  }
  assert.equal(runtime.proxyFailure(first), null);
  runtime.finishAttempt(first, { outcome: 'failed' });
  const second = runtime.beginAttempt(route({
    providerId: 'provider-b', providerName: 'Provider B', model: 'model-b', attemptNo: 2,
  }));
  assert.equal(runtime.observeProxyOutcome({
    ...first, roleKind: 'main', routeAttribution: 'exact', status: 'error', statusCode: 429,
  }).accepted, false);
  assert.equal(runtime.proxyFailure(second), null);
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

test('an old sub producer ends against its captured capability without binding a retry', () => {
  const { runtime } = harness();
  const residentRetry = {
    cli: 'claude', protocol: 'anthropic', subagentProviderId: 'provider-sub',
  };
  const first = runtime.beginAttempt(route({ ...residentRetry, spawnKey: 'spawn-1' }));
  const oldContext = proxy(runtime, first, {
    role: 'sub', roleKind: 'sub', providerId: 'provider-sub',
  });
  runtime.onProxyActivity({ ...oldContext, phase: 'request' });
  runtime.finishAttempt(first, { outcome: 'failed', errorCategory: 'transport' });
  const second = runtime.beginAttempt(route({
    ...residentRetry, spawnKey: 'spawn-1', attemptNo: 2,
  }));
  // A resident lane keeps the route across a same-contract retry, so the old sub
  // producer ends against a capability that still authorizes today's attempt.
  // What must not survive is the attempt binding: its usage stays ambiguous and
  // carries no routeAttemptId, because the attempt that opened it is gone.
  assert.equal(runtime.proxySessionId(second), oldContext.sessionId);
  assert.notEqual(second.routeAttemptId, first.routeAttemptId);
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

test('raw data cannot forge the host marker; only a host-proved final envelope reopens text deltas', () => {
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
  assert.equal(runtime.snapshot('session-2').replayFence, 'none');
  assert.equal(runtime.snapshot('session-2').visibleOutputObserved, false);
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

test('a resident lane keeps its capability while the spawn contract holds, and rotates when it moves', () => {
  const { runtime } = harness();
  const claudeRoute = {
    cli: 'claude', protocol: 'anthropic', providerRevision: 'claude-revision',
    spawnKey: 'argv-model-a',
  };
  const first = runtime.beginAttempt(route(claudeRoute));
  const warmCapability = runtime.proxySessionId(first);
  runtime.finishAttempt(first, { outcome: 'succeeded' });
  const second = runtime.beginAttempt(route({
    ...claudeRoute, turnId: 'turn-2', attemptNo: 1,
  }));
  assert.equal(runtime.proxySessionId(second), warmCapability,
    'the warm child routes on the capability it was spawned with');
  assert.equal(runtime.authorizeProxyRequest({
    sessionId: warmCapability, role: 'main', providerId: 'provider-a',
  }).ok, true, 'residency requires the capability to survive a result boundary');
  runtime.finishAttempt(second, { outcome: 'succeeded' });
  // Same provider, new --model: what the child baked at spawn moved, so the
  // capability must move with it or the warm process keeps the old model.
  const respawned = runtime.beginAttempt(route({
    ...claudeRoute, turnId: 'turn-3', attemptNo: 1, spawnKey: 'argv-model-b',
  }));
  const respawnedCapability = runtime.proxySessionId(respawned);
  assert.notEqual(respawnedCapability, warmCapability,
    'a moved spawn contract respawns the child on a fresh capability');
  assert.equal(runtime.authorizeProxyRequest({
    sessionId: warmCapability, role: 'main', providerId: 'provider-a',
  }).ok, false, 'the replaced capability stops authorizing');
  runtime.finishAttempt(respawned, { outcome: 'failed', errorCategory: 'transport' });
  const retry = runtime.beginAttempt(route({
    ...claudeRoute, turnId: 'turn-3', attemptNo: 2, spawnKey: 'argv-model-b',
  }));
  assert.equal(runtime.proxySessionId(retry), respawnedCapability,
    'a same-contract retry reuses the route; attempt identity is routeAttemptId');
  assert.notEqual(retry.routeAttemptId, respawned.routeAttemptId);
  assert.equal(runtime.snapshot('session-1').outcome, 'running');
});

test('a caller that cannot prove its spawn contract gets no residency, and a per-turn lane never keeps one', () => {
  const { runtime } = harness();
  const unproven = runtime.beginAttempt(route({
    cli: 'claude', protocol: 'anthropic', providerRevision: 'claude-revision',
  }));
  const unprovenCapability = runtime.proxySessionId(unproven);
  runtime.finishAttempt(unproven, { outcome: 'succeeded' });
  const next = runtime.beginAttempt(route({
    cli: 'claude', protocol: 'anthropic', providerRevision: 'claude-revision',
    turnId: 'turn-2', attemptNo: 1,
  }));
  assert.notEqual(runtime.proxySessionId(next), unprovenCapability,
    'without a spawn contract the safe answer is the historical per-attempt rotation');
  runtime.finishAttempt(next, { outcome: 'succeeded' });
  const perTurnRoute = {
    cli: 'codex', protocol: 'openai_responses', providerRevision: 'codex-revision',
    spawnKey: 'argv-model-a',
  };
  const first = runtime.beginAttempt(route({ ...perTurnRoute, turnId: 'turn-3', attemptNo: 1 }));
  const firstCapability = runtime.proxySessionId(first);
  runtime.finishAttempt(first, { outcome: 'succeeded' });
  const second = runtime.beginAttempt(route({
    ...perTurnRoute, turnId: 'turn-4', attemptNo: 1,
  }));
  assert.notEqual(runtime.proxySessionId(second), firstCapability,
    'a per-turn lane has no warm process to protect, so the old route ends with the turn');
  assert.equal(runtime.authorizeProxyRequest({
    sessionId: firstCapability, role: 'main', providerId: 'provider-a',
  }).ok, false, 'the closed attempt route is revoked before the next turn starts');
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
  assert.equal(events.at(-1).event.routePhase, 'continued');
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

function clockHarness(options = {}) {
  let sequence = 0;
  let clock = options.startAt || 1_000;
  const events = [];
  const audit = [];
  const runtime = createProviderAttemptRuntime({
    runtimeEpoch: 'runtime-epoch-1',
    now: () => clock,
    nextId: prefix => `${prefix}-${++sequence}`,
    emit: (sessionId, event) => events.push({ sessionId, event }),
    audit: (sessionId, event) => audit.push({ sessionId, event }),
    ...options.runtime,
  });
  return { runtime, events, audit, advance: ms => { clock += ms; } };
}

test('an orphaned producer past the stale grace is force-drained, not a permanent wedge', () => {
  const { runtime, audit, advance } = clockHarness();
  const first = runtime.beginAttempt(route());
  runtime.onProxyActivity(proxy(runtime, first, { phase: 'request' }));
  runtime.finishAttempt(first, { outcome: 'failed', errorCategory: 'rate_limit' });
  // Fresh producer: still rejected, exactly as before.
  assert.throws(() => runtime.beginAttempt(route({ attemptNo: 2 })), error => (
    error && error.code === 'PROVIDER_PRODUCER_NOT_DRAINED'
  ));
  // No proxy 'end' ever arrives (dead CLI consumer); past the grace the entry
  // is orphaned and beginAttempt force-drains it instead of wedging forever.
  advance(30_000);
  assert.equal(runtime.beginAttempt(route({ attemptNo: 2 })).routeGeneration, 2);
  const drained = audit.find(item => item.event.type === 'provider_producer_force_drained');
  assert.equal(drained && drained.event.reason, 'stale_producer_grace');
  assert.equal(drained && drained.sessionId, 'session-1');
  assert.equal(drained && drained.event.graceMs, 30_000);
  assert.equal(drained && drained.event.count, 1);
});

test('producerStaleGraceMs is honoured and clamped to at least five seconds', () => {
  const { runtime, advance } = clockHarness({
    runtime: { producerStaleGraceMs: 5_000 },
  });
  const first = runtime.beginAttempt(route());
  runtime.onProxyActivity(proxy(runtime, first, { phase: 'request' }));
  runtime.finishAttempt(first, { outcome: 'failed' });
  advance(4_999);
  assert.throws(() => runtime.beginAttempt(route({ attemptNo: 2 })), error => (
    error && error.code === 'PROVIDER_PRODUCER_NOT_DRAINED'
  ));
  advance(1);
  assert.equal(runtime.beginAttempt(route({ attemptNo: 2 })).routeGeneration, 2);
});

test('forceReleaseProducers releases main producers immediately and is idempotent', () => {
  const { runtime, audit } = clockHarness();
  const first = runtime.beginAttempt(route());
  runtime.onProxyActivity(proxy(runtime, first, { phase: 'request' }));
  runtime.onProxyActivity(proxy(runtime, first, { phase: 'request' }));
  runtime.finishAttempt(first, { outcome: 'failed' });

  assert.equal(runtime.forceReleaseProducers('session-1', 'cancel:user_cancel').released, 2);
  const drained = audit.find(item => item.event.type === 'provider_producer_force_drained');
  assert.equal(drained && drained.event.reason, 'cancel:user_cancel');
  // The next attempt no longer needs to wait for the grace window.
  assert.equal(runtime.beginAttempt(route({ attemptNo: 2 })).routeGeneration, 2);
  // Idempotent on a drained session and defensive on bad input.
  assert.equal(runtime.forceReleaseProducers('session-1').code, 'no_producers');
  assert.equal(runtime.forceReleaseProducers('').code, 'invalid_session');
});

test('a resident lane keeps admitting background sub requests after its turn succeeds', () => {
  const { runtime } = harness();
  const residentRoute = {
    cli: 'claude-exp', protocol: 'anthropic', providerRevision: 'claude-revision',
    subagentProviderId: 'provider-sub', spawnKey: 'argv-model-a',
  };
  const attempt = runtime.beginAttempt(route(residentRoute));
  const capability = runtime.proxySessionId(attempt);
  runtime.finishAttempt(attempt, { outcome: 'succeeded' });

  const sub = runtime.authorizeProxyRequest({
    sessionId: capability, role: 'sub', providerId: 'provider-sub',
  });
  assert.equal(sub.ok, true, 'a run_in_background subagent outlives the main result');
  assert.equal(sub.background, true);
  assert.equal(runtime.authorizeProxyRequest({
    sessionId: capability, role: 'sub', providerId: 'provider-other',
  }).code, 'provider_subroute_not_allowed');
  assert.equal(runtime.authorizeProxyRequest({
    sessionId: capability, role: 'main', providerId: 'provider-a',
  }).ok, true, 'without a subagent provider the background agent rides the main route');
  assert.equal(runtime.authorizeProxyRequest({
    sessionId: capability, role: 'main', providerId: 'provider-sub',
  }).code, 'provider_route_mismatch');
  assert.equal(runtime.snapshot('session-1').outcome, 'succeeded',
    'background admission never reopens the attempt');

  // The background producer never gates the next turn.
  runtime.onProxyActivity({ sessionId: capability, role: 'sub', providerId: 'provider-sub', phase: 'request' });
  const next = runtime.beginAttempt(route({ ...residentRoute, turnId: 'turn-2' }));
  assert.equal(runtime.proxySessionId(next), capability);
});

test('background admission ends with a cancelled turn, a moved spawn contract or a per-turn lane', () => {
  const { runtime } = harness();
  const residentRoute = {
    cli: 'claude-exp', protocol: 'anthropic', providerRevision: 'claude-revision',
    subagentProviderId: 'provider-sub', spawnKey: 'argv-model-a',
  };
  const sub = capability => runtime.authorizeProxyRequest({
    sessionId: capability, role: 'sub', providerId: 'provider-sub',
  }).code;
  const cancelled = runtime.beginAttempt(route(residentRoute));
  const warm = runtime.proxySessionId(cancelled);
  runtime.finishAttempt(cancelled, { outcome: 'released' });
  assert.equal(sub(warm), 'proxy_attempt_not_running');

  const second = runtime.beginAttempt(route({ ...residentRoute, turnId: 'turn-2' }));
  runtime.finishAttempt(second, { outcome: 'succeeded' });
  runtime.beginAttempt(route({ ...residentRoute, turnId: 'turn-3', spawnKey: 'argv-model-b' }));
  assert.equal(sub(warm), 'proxy_route_capability_mismatch', 'a respawned child revokes the old one');

  const perTurn = runtime.beginAttempt(route({
    sessionId: 'session-2', subagentProviderId: 'provider-sub', spawnKey: 'argv-model-a',
  }));
  const perTurnCapability = runtime.proxySessionId(perTurn);
  runtime.finishAttempt(perTurn, { outcome: 'succeeded' });
  assert.equal(sub(perTurnCapability), 'proxy_attempt_not_running');
});

test('background traffic on the main route never holds the next turn or binds to an attempt', () => {
  const { runtime } = harness();
  const residentRoute = {
    cli: 'claude', protocol: 'anthropic', providerRevision: 'claude-revision', spawnKey: 'argv-model-a',
  };
  const attempt = runtime.beginAttempt(route(residentRoute));
  const capability = runtime.proxySessionId(attempt);
  runtime.finishAttempt(attempt, { outcome: 'succeeded' });

  const request = { sessionId: capability, role: 'main', providerId: 'provider-a' };
  assert.equal(runtime.onProxyActivity({ ...request, phase: 'request' }).sessionId, 'session-1',
    'the background request is still reported to the TaskRun fence');
  assert.equal(runtime.snapshot('session-1').outcome, 'succeeded', 'no poisoning, no reopening');
  const usage = runtime.attributeProxyUsage({ ...request, eventId: 'bg-usage' });
  assert.equal(usage.routeAttribution, 'ambiguous');
  assert.equal(usage.routeAttemptId, undefined);
  assert.equal(usage.producerBound, true);

  const next = runtime.beginAttempt(route({ ...residentRoute, turnId: 'turn-2' }));
  assert.equal(next.outcome, 'running', 'an in-flight background request does not hold the next turn');
  assert.equal(runtime.onProxyActivity({ ...request, phase: 'end' }).sessionId, 'session-1',
    'the late end drains the background ledger, not the new turn');
  runtime.onProxyActivity({ ...request, phase: 'request' });
  assert.equal(runtime.onProxyActivity({ ...request, phase: 'end' }).routeAttemptId, next.routeAttemptId,
    'once a turn runs again, main-route traffic is that turn\'s own');
});

// ---------------------------------------------------------------------------
// Auto Provider stall watchdog: the attempt-side contract
// ---------------------------------------------------------------------------

function inflow(attempt, overrides = {}) {
  return Object.freeze({
    version: 1, requestId: 'request-1', requestKind: 'inference',
    termination: 'upstream_failure', httpStatus: null,
  });
}

test('the stall budget is part of the immutable attempt snapshot', () => {
  const { runtime } = harness();
  const withBudget = runtime.beginAttempt(route({ stallTimeoutMs: 90_000 }));
  assert.equal(withBudget.stallTimeoutMs, 90_000);
  assert.equal(withBudget.stalled, false);
  assert.equal(Object.isFrozen(withBudget), true, 'a snapshot can never be edited after the spawn');
  // A caller that states nothing, or states garbage, gets today's behaviour: no
  // budget, so the proxy never arms a watchdog for the attempt.
  runtime.finishAttempt(withBudget, { outcome: 'failed', errorCategory: 'transport' });
  assert.equal(runtime.beginAttempt(route({ attemptNo: 2 })).stallTimeoutMs, 0);
  runtime.finishAttempt(runtime.snapshot('session-1'), { outcome: 'failed', errorCategory: 'transport' });
  assert.equal(runtime.beginAttempt(route({ attemptNo: 3, stallTimeoutMs: 'soon' })).stallTimeoutMs, 0);
});

test('a proved stall retires the attempt and refuses every later re-dial', () => {
  const { runtime, audit } = harness();
  const attempt = runtime.beginAttempt(route({ stallTimeoutMs: 60_000 }));
  assert.equal(runtime.authorizeProxyRequest(proxy(runtime, attempt)).ok, true);

  const observed = runtime.observeProxyOutcome({
    ...attempt, roleKind: 'main', routeAttribution: 'exact',
    status: 'error', errorCode: 'stream_idle_timeout', proxyOutcome: inflow(attempt),
  });
  assert.equal(observed.accepted, true);
  assert.equal(observed.failure.code, 'stream_idle_timeout');
  assert.equal(runtime.snapshot('session-1').stalled, true);
  assert.ok(audit.some(item => item.event.type === 'provider_attempt_stalled'));

  // The CLI's own retry (codex re-dials the same stream several times) is
  // refused with a code that names the proven cause, and it is not a poisoning
  // of the attempt: the failure category stays the stall.
  const refused = runtime.authorizeProxyRequest(proxy(runtime, attempt));
  assert.deepEqual(refused, { ok: false, code: 'attempt_stalled', sessionId: 'session-1' });
  assert.equal(runtime.snapshot('session-1').outcome, 'running',
    'a stalled attempt is retired by the turn, not killed out from under it');
  assert.equal(runtime.proxyFailure(attempt).code, 'stream_idle_timeout');
});

test('the socket teardown the watchdog causes cannot replace the stall it recorded', () => {
  const { runtime } = harness();
  const attempt = runtime.beginAttempt(route({ stallTimeoutMs: 60_000 }));
  runtime.observeProxyOutcome({
    ...attempt, roleKind: 'main', routeAttribution: 'exact',
    status: 'error', errorCode: 'response_stalled_before_response', proxyOutcome: inflow(attempt),
  });
  const disconnect = runtime.observeProxyOutcome({
    ...attempt, roleKind: 'main', routeAttribution: 'exact',
    status: 'error', errorCode: 'DOWNSTREAM_DISCONNECT', proxyOutcome: downstreamOutcome(),
  });
  assert.equal(disconnect.accepted, true);
  assert.equal(disconnect.failure.code, 'response_stalled_before_response',
    'a teardown is an effect of the stall, never evidence that replaces it');
  assert.equal(runtime.proxyFailure(attempt).code, 'response_stalled_before_response');
  assert.equal(runtime.snapshot('session-1').stalled, true);
  // An unrelated code is not a stall: the route stays replayable.
  const { runtime: other } = harness();
  const clean = other.beginAttempt(route({ stallTimeoutMs: 60_000 }));
  other.observeProxyOutcome({
    ...clean, roleKind: 'main', routeAttribution: 'exact',
    status: 'error', errorCode: 'UPSTREAM_HTTP_ERROR', statusCode: 503,
  });
  assert.equal(other.snapshot('session-1').stalled, false);
  assert.equal(other.authorizeProxyRequest(proxy(other, clean)).ok, true);
});

// Frozen pre-migration oracle; never loaded by the product.
const legacyEventPolicy = (() => {
  const clean = value => value == null ? '' : String(value).trim();
function contentBlocks(event) {
  const content = event && event.message && event.message.content;
  return Array.isArray(content) ? content : [];
}

function fenceForEvent(event, HOST_ERROR_ENVELOPE) {
  if (!event || typeof event !== 'object') return 'none';
  if (event.type === 'stream_event' && event.event && typeof event.event === 'object') {
    const nested = event.event;
    const block = nested.content_block;
    const delta = nested.delta;
    if (nested.type === 'content_block_start' && block && block.type === 'tool_use') {
      return 'tool_intent';
    }
    if (nested.type === 'content_block_delta' && delta) {
      if (delta.type === 'input_json_delta') return 'tool_intent';
      if ((delta.type === 'text_delta' || delta.type === 'thinking_delta')
          && clean(delta.text || delta.thinking)) return 'visible_output';
    }
  }
  if (event.type === 'part_delta') {
    const delta = event.delta && typeof event.delta === 'object' ? event.delta : event;
    if (delta.type === 'tool' || delta.tool || delta.toolId) return 'tool_intent';
    if (delta.type === 'text' || delta.type === 'reasoning' || delta.type === 'source') {
      return 'visible_output';
    }
    return 'none';
  }
  if (event.type === 'reasoning' && clean(event.text)) return 'visible_output';
  if (event.type === 'assistant_text' && clean(event.text)) return 'visible_output';
  if (event.type === 'tool_start' || event.type === 'tool_update') return 'tool_intent';
  if (event.type === 'tool_result') return 'side_effect';
  if (event.type === 'assistant') {
    const blocks = contentBlocks(event);
    if (blocks.length > 0 && blocks.every(block => block && block.type === 'text')
        && event[HOST_ERROR_ENVELOPE] === true) return 'none';
    if (blocks.some(block => block && block.type === 'tool_use')) return 'tool_intent';
    if (blocks.some(block => block && block.type === 'thinking'
        && clean(block.thinking || block.text))) return 'visible_output';
    if (blocks.some(block => block && block.type === 'text' && clean(block.text))) return 'visible_output';
  }
  if (event.type === 'user'
      && contentBlocks(event).some(block => block && block.type === 'tool_result')) {
    return 'side_effect';
  }
  return 'none';
}

  return { fenceForEvent, trusted(event, marker) { return event[marker] === true && contentBlocks(event).length > 0 && contentBlocks(event).every(block => block && block.type === 'text'); } };
})();

test('native replay fence matches legacy protocol events, sparse arrays and host-only authority', () => {
  const native = require('../src/native/runtime').getNative();
  const marker = Symbol('test-only-host-authority');
  const types = ['assistant', 'user', 'reasoning', 'assistant_text', 'tool_start', 'tool_update', 'tool_result', 'part_delta', 'stream_event'];
  const blockTypes = ['text', 'thinking', 'tool_use', 'tool_result', 'reasoning', 'source', 'tool', undefined];
  const texts = [undefined, null, false, true, 0, 1, 1n, Symbol('text'), '', ' \t\n', '\ufeff', '\u200b', '\ud800', {}, [], 'visible'];
  let seed = 0x721389;
  const pick = list => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return list[seed % list.length]; };
  for (let i = 0; i < 6000; i++) {
    const content = Array.from({ length: i % 5 }, () => ({ type: pick(blockTypes), text: pick(texts), thinking: pick(texts) }));
    if (i % 3 === 0 && content.length) delete content[0];
    if (i % 4 === 0 && content.length) content[0] = null;
    const event = { type: pick(types), text: pick(texts), message: { content },
      [marker]: i % 4 === 0,
      delta: { type: pick(blockTypes), tool: i % 13 === 0, toolId: i % 17 ? '' : 'tool' },
      event: { type: pick(['content_block_start', 'content_block_delta', 'other']),
        content_block: { type: pick(blockTypes) },
        delta: { type: pick(['input_json_delta', 'text_delta', 'thinking_delta']), text: pick(texts), thinking: pick(texts) } } };
    assert.equal(native.providerEventFence(event, marker), legacyEventPolicy.fenceForEvent(event, marker));
    assert.equal(native.providerHostTextEnvelope(event, marker), legacyEventPolicy.trusted(event, marker));
  }
  const fake = { type: 'assistant', message: { content: [{ type: 'text', text: 'visible' }] },
    'multicc.hostErrorEnvelope': true, [Symbol('multicc.hostErrorEnvelope')]: true };
  assert.equal(fenceForEvent(fake), 'visible_output', 'wire fields cannot forge host authority');
  assert.equal(fenceForEvent(markHostErrorEnvelope(fake)), 'none');
  assert.equal(fenceForEvent(markHostErrorEnvelope({ ...fake, message: { content: [{ type: 'tool_use' }] } })), 'tool_intent');
});

test('native replay fence preserves lazy getters, exceptions and array callbacks that outlive evaluation', () => {
  const native = require('../src/native/runtime').getNative();
  const marker = Symbol('authority'), sentinel = new Error('event getter failed');
  const execute = (fn, sample, throwAt) => {
    const reads = [];
    const wrap = (value, path = '') => value && typeof value === 'object' ? new Proxy(value, {
      get(object, key) { const name = `${path}.${String(key)}`; reads.push(name); if (name === throwAt) throw sentinel; return wrap(Reflect.get(object, key), name); },
      has(object, key) { reads.push(`${path}.has:${String(key)}`); return key in object; },
      ownKeys() { throw new Error('event was enumerated'); },
    }) : value;
    try { return { result: fn(wrap(sample), marker), reads }; }
    catch (error) { return { error, reads }; }
  };
  const samples = [
    { type: 'assistant', [marker]: true, message: { content: [null, { type: 'thinking', thinking: 'trace' }, { type: 'text', text: 'text' }] } },
    { type: 'assistant', [marker]: true, message: { content: [{ type: 'text', text: 'error' }] } },
    { type: 'user', message: { content: [,, { type: 'tool_result' }] } },
    { type: 'part_delta', delta: { type: 'text' } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'thought' } } },
  ];
  for (const [actual, expected] of [[native.providerEventFence, legacyEventPolicy.fenceForEvent],
    [native.providerHostTextEnvelope, legacyEventPolicy.trusted]]) {
    for (const sample of samples) {
      for (const throwAt of [null, '.type', '.message', '.message.content', '.message.content.1.type', '.event.delta']) {
        assert.deepEqual(execute(actual, sample, throwAt), execute(expected, sample, throwAt));
      }
    }
  }
  const capture = fn => {
    const callbacks = [];
    const content = [{ type: 'text', text: 'visible' }];
    content.every = callback => { callbacks.push(callback); return false; };
    content.some = callback => { callbacks.push(callback); return false; };
    assert.equal(fn({ type: 'assistant', message: { content } }, marker), 'none');
    return callbacks.map(callback => [callback(), callback(null), callback(0), callback({ type: 'text', text: ' trimmed ' }), callback({ type: 'thinking', thinking: ' thought ' })]);
  };
  assert.deepEqual(capture(native.providerEventFence), capture(legacyEventPolicy.fenceForEvent));
  for (const length of [0n, 1n, { valueOf() { return 1n; } }, { [Symbol.toPrimitive](hint) { assert.equal(hint, 'number'); return 1n; } }]) {
    const content = new Proxy([{ type: 'text', text: 'visible' }], {
      get(target, key) {
        if (key === 'length') return length;
        if (key === 'every') return () => true;
        if (key === 'some') return () => false;
        return Reflect.get(target, key);
      },
    });
    const frame = { type: 'assistant', message: { content }, [marker]: true };
    assert.equal(native.providerEventFence(frame, marker), legacyEventPolicy.fenceForEvent(frame, marker));
    assert.equal(native.providerHostTextEnvelope(frame, marker), legacyEventPolicy.trusted(frame, marker));
  }
  const event = { type: 'reasoning', text: { [Symbol.toPrimitive](hint) {
    assert.equal(hint, 'string');
    assert.equal(fenceForEvent({ type: 'tool_result' }), 'side_effect');
    return 'nested';
  } } };
  assert.equal(fenceForEvent(event), 'visible_output');
});

// Frozen Node identity and capability rules; test-only reference.
const legacyAttemptIdentity = (() => {
const crypto = require('node:crypto');
const { ProviderAttemptError } = require('../src/chat/provider-attempt-runtime');
const clean = value => value == null ? '' : String(value).trim();
function required(value, label) {
  const text = clean(value);
  if (!text || text.length > 256 || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new ProviderAttemptError(`${label} is required`, 'PROVIDER_ATTEMPT_IDENTITY_INVALID');
  }
  return text;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new ProviderAttemptError(`${label} must be a positive integer`, 'PROVIDER_ATTEMPT_IDENTITY_INVALID');
  }
  return number;
}

function stallTimeoutBudget(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function createProviderRevision(input = {}) {
  const summary = input.summary && typeof input.summary === 'object' ? input.summary : {};
  const aliasMap = summary.aliasMap && typeof summary.aliasMap === 'object'
    ? Object.fromEntries(Object.keys(summary.aliasMap).sort().map(key => [key, summary.aliasMap[key]]))
    : {};
  const safeRoute = {
    cli: required(input.cli, 'cli').toLowerCase(),
    providerId: required(input.providerId, 'providerId'),
    protocol: required(input.protocol, 'protocol'),
    model: required(input.model, 'model'),
    appType: clean(summary.appType) || null,
    baseUrl: clean(summary.baseUrl) || null,
    source: clean(summary.source) || null,
    apiFormat: clean(summary.apiFormat) || null,
    wireApi: clean(summary.wireApi) || null,
    aliasMap,
    isOfficial: summary.isOfficial === true,
  };
  return `prv_${crypto.createHash('sha256').update(JSON.stringify(safeRoute)).digest('hex').slice(0, 24)}`;
}

function providerAttemptFields(reference) {
  if (!reference || typeof reference !== 'object') {
    throw new ProviderAttemptError('provider attempt is required', 'PROVIDER_ATTEMPT_IDENTITY_INVALID');
  }
  return Object.freeze({
    providerRouteProtocolVersion: 1,
    providerRouteScope: 'attempt',
    cli: required(reference.cli, 'cli'),
    runtimeEpoch: required(reference.runtimeEpoch, 'runtimeEpoch'),
    turnId: required(reference.turnId, 'turnId'),
    decisionId: required(reference.decisionId, 'decisionId'),
    routeAttemptId: required(reference.routeAttemptId, 'routeAttemptId'),
    routeGeneration: positiveInteger(reference.routeGeneration, 'routeGeneration'),
    attemptNo: positiveInteger(reference.attemptNo, 'attemptNo'),
    providerId: required(reference.providerId, 'providerId'),
    providerRevision: required(reference.providerRevision, 'providerRevision'),
  });
}

function encodeProxySessionId(sessionId, token) {
  const encode = value => Buffer.from(String(value), 'utf8').toString('base64url');
  return `pr1.${encode(sessionId)}.${encode(token)}`;
}

function decodeProxySessionId(value) {
  const raw = clean(value);
  if (!raw.startsWith('pr1.')) return { sessionId: raw, token: null, encoded: false };
  const parts = raw.split('.');
  if (parts.length !== 3 || !parts[1] || !parts[2]) return { sessionId: '', token: null, encoded: true };
  try {
    const sessionId = Buffer.from(parts[1], 'base64url').toString('utf8');
    const token = Buffer.from(parts[2], 'base64url').toString('utf8');
    if (!sessionId || !token || sessionId.length > 256 || token.length > 256
        || /[\u0000-\u001f\u007f]/.test(sessionId + token)) {
      return { sessionId: '', token: null, encoded: true };
    }
    return { sessionId, token, encoded: true };
  } catch (_) {
    return { sessionId: '', token: null, encoded: true };
  }
}

return { required, positiveInteger, stallTimeoutBudget, createProviderRevision, providerAttemptFields, encodeProxySessionId, decodeProxySessionId };
})();

test('Rust attempt identity validation preserves coercions, bounds and public error classes', () => {
  const native = require('../src/native/runtime').getNative();
  const { ProviderAttemptError, providerAttemptFields } = require('../src/chat/provider-attempt-runtime');
  const values = [undefined, null, false, true, '', ' ', '\n', '\u0000', '\u007f', ' \ufeffvalid ', '\ud800', '😀'.repeat(128),
    '😀'.repeat(129), 'a'.repeat(257), 0, -0, NaN, Infinity, 1, 1.5, -1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1,
    1n, 9007199254740993n, Symbol('id'), [], [' a '], {}, { toString() { return 'custom'; } }, { valueOf() { return 7; } }];
  const check = (actual, expected) => {
    let result, error;
    try { result = expected(); } catch (e) { error = e; }
    if (error) assert.throws(actual, e => e.constructor === error.constructor && e.code === error.code
      && (!(error instanceof ProviderAttemptError) || e.message === error.message));
    else assert.deepEqual(actual(), result);
  };
  for (const value of values) {
    check(() => native.providerRequiredIdentity(value, 'identity', ProviderAttemptError), () => legacyAttemptIdentity.required(value, 'identity'));
    check(() => native.providerPositiveInteger(value, 'number', ProviderAttemptError), () => legacyAttemptIdentity.positiveInteger(value, 'number'));
    check(() => native.providerTimeoutBudget(value), () => legacyAttemptIdentity.stallTimeoutBudget(value));
    const reference = { cli: 'codex', runtimeEpoch: 'epoch', turnId: 'turn', decisionId: 'decision', routeAttemptId: 'attempt',
      routeGeneration: 1, attemptNo: 1, providerId: 'provider', providerRevision: 'revision' };
    for (const key of Object.keys(reference)) {
      const input = { ...reference, [key]: value };
      check(() => providerAttemptFields(input), () => legacyAttemptIdentity.providerAttemptFields(input));
    }
  }
});

test('Rust provider revision keeps ordered alias hashing and lazy getter/JSON behavior', () => {
  const sentinel = new Error('identity getter failed');
  const execute = (fn, throwAt, make) => {
    const reads = [];
    const wrap = (object, prefix = '') => object && typeof object === 'object' ? new Proxy(object, {
      get(target, key) { const event = `${prefix}.${String(key)}`; reads.push(event); if (event === throwAt) throw sentinel; return wrap(Reflect.get(target, key), event); },
      ownKeys(target) { reads.push(`${prefix}.keys`); return Reflect.ownKeys(target); },
      getOwnPropertyDescriptor(target, key) { reads.push(`${prefix}.descriptor:${String(key)}`); return Reflect.getOwnPropertyDescriptor(target, key); },
    }) : object;
    try { return { value: fn(wrap(make(reads))), reads }; }
    catch (error) { return { error, reads }; }
  };
  const make = reads => ({ cli: ' CODEX ', providerId: ' p ', protocol: ' responses ', model: ' m ',
    summary: { aliasMap: JSON.parse('{"z":{"model":"m"},"a":"alias","2":"second","10":"tenth","__proto__":{"raw":true}}'),
      appType: { [Symbol.toPrimitive](hint) { reads.push(hint); return 'app'; } }, source: 'test', isOfficial: true } });
  for (const throwAt of [null, '.summary', '.summary.aliasMap', '.summary.aliasMap.a', '.cli', '.model', '.summary.appType', '.summary.isOfficial']) {
    assert.deepEqual(execute(createProviderRevision, throwAt, make), execute(legacyAttemptIdentity.createProviderRevision, throwAt, make));
  }
  const reasons = ['model', '\ud800', '😀', '', null, undefined, { toJSON() { return 'normalized'; } }];
  for (let i = 0; i < 300; i++) {
    const aliasMap = Object.fromEntries(['z', '2', '10', 'a', '😀', '\ud800'].slice(i % 4).map((key, n) => [key, reasons[(i + n) % reasons.length]]));
    const input = { cli: i % 2 ? 'ClAuDe' : 'İCODEX', providerId: 'provider', protocol: 'anthropic', model: 'm',
      summary: { aliasMap, isOfficial: i % 3 === 0, baseUrl: i % 2 ? ' https://example.test ' : null } };
    assert.equal(createProviderRevision(input), legacyAttemptIdentity.createProviderRevision(input));
  }
});

test('Rust proxy capabilities match Node base64url and UTF-8 malformed-input behavior', () => {
  const native = require('../src/native/runtime').getNative();
  const cases = ['plain', '', ' pr1.c2Vzc2lvbg.dG9rZW4 ', 'pr1.AA.AA', 'pr1.YWJj.YWJj',
    'pr1.Y😀WJj.YWJj', 'pr1.ＹＷＪｊ.YWJj', 'pr1..YQ', 'pr1.YQ.', 'pr1.YQ.YQ.extra',
    'pr1._-__.+/8=', 'pr1.4KC.4KC', 'pr1.Zm!9v.**YmFy===ignored', 'pr1.ŁA.YWJj'];
  let seed = 183111;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  const alphabet = 'ABCDEFabcdef0123456789+/_-=.!\n ŁＹ😀Ā';
  for (let i = 0; i < 5000; i++) {
    const randomText = () => Array.from({ length: next() % 30 }, () => alphabet[next() % alphabet.length]).join('');
    cases.push(`pr1.${randomText()}.${randomText()}`);
    const session = i % 4 ? randomText() : '😀'.repeat(i % 140), token = randomText();
    const encoded = native.providerEncodeProxySession(session, token);
    assert.equal(encoded, legacyAttemptIdentity.encodeProxySessionId(session, token));
    cases.push(encoded);
  }
  for (const raw of cases) {
    assert.deepEqual(native.providerDecodeProxySession(raw), legacyAttemptIdentity.decodeProxySessionId(raw), JSON.stringify(raw));
  }
});

function legacyAttemptTransition(previous, previousFence, { turnId, continuation, providerId, model, protocol, attemptNo }, ProviderAttemptError) {
    if (previous && previous.turnId === turnId
        && previousFence.replayFence !== 'none' && !continuation) {
      throw new ProviderAttemptError(
        'provider attempt cannot be replayed after observable output or tool intent',
        'PROVIDER_REPLAY_FENCE_CLOSED',
      );
    }
    if (previous && previous.lifecycle.running()) {
      throw new ProviderAttemptError('provider attempt is still running', 'PROVIDER_ATTEMPT_IN_FLIGHT');
    }
    if (previous && previous.turnId === turnId) {
      if (previous.lifecycle.succeeded()) {
        throw new ProviderAttemptError(
          'a succeeded turn cannot start another provider attempt',
          'PROVIDER_TURN_ALREADY_SUCCEEDED',
        );
      }
      if (continuation && (previous.providerId !== providerId
          || previous.model !== model || previous.protocol !== protocol)) {
        throw new ProviderAttemptError(
          'a continuation must retain the concrete provider route',
          'PROVIDER_CONTINUATION_ROUTE_CHANGED',
        );
      }
      if (attemptNo <= previous.attemptNo) {
        throw new ProviderAttemptError('attemptNo must increase within one turn', 'PROVIDER_ATTEMPT_SEQUENCE_INVALID');
      }
    }

}

test('Rust attempt transition preserves replay, finality, continuation and sequence priorities', () => {
  const native = require('../src/native/runtime').getNative();
  const { ProviderAttemptError } = require('../src/chat/provider-attempt-runtime');
  for (let i = 0; i < 800; i++) {
    const facts = { turnId: 'turn', continuation: i % 2 === 0, providerId: 'provider', model: 'model', protocol: 'protocol', attemptNo: i % 4 + 1 };
    const previous = i % 19 ? { turnId: i % 7 ? 'turn' : 'other', providerId: i % 11 ? 'provider' : 'other',
      model: i % 13 ? 'model' : 'other', protocol: i % 17 ? 'protocol' : 'other', attemptNo: 2,
      lifecycle: { running: () => i % 5 === 0, succeeded: () => i % 3 === 0 } } : null;
    const fence = { replayFence: ['none', 'visible_output', 'tool_intent', 'side_effect'][i % 4] };
    let expected;
    try { legacyAttemptTransition(previous, fence, facts, ProviderAttemptError); }
    catch (error) { expected = error; }
    const actual = () => native.providerValidateAttemptTransition(previous, fence, facts, ProviderAttemptError);
    if (expected) assert.throws(actual, error => error instanceof ProviderAttemptError && error.code === expected.code && error.message === expected.message);
    else assert.equal(actual(), undefined);
  }
});

test('Rust attempt transition keeps lazy previous-record reads and lifecycle reentry', () => {
  const native = require('../src/native/runtime').getNative();
  const { ProviderAttemptError } = require('../src/chat/provider-attempt-runtime');
  const sentinel = new Error('previous record getter');
  for (const reenter of [false, true]) {
    for (const throwAt of [null, 'turnId', 'lifecycle', 'providerId', 'attemptNo']) {
      const execute = fn => {
        const reads = [];
        const state = { turnId: 'turn', providerId: 'provider', model: 'model', protocol: 'protocol', attemptNo: 1 };
        const lifecycle = {
          running() { assert.equal(this, lifecycle); reads.push('running'); if (reenter) state.turnId = 'moved'; return false; },
          succeeded() { assert.equal(this, lifecycle); reads.push('succeeded'); return false; },
        };
        state.lifecycle = lifecycle;
        const previous = new Proxy(state, { get(target, key) { reads.push(key); if (key === throwAt) throw sentinel; return target[key]; } });
        const facts = { turnId: 'turn', continuation: true, providerId: 'provider', model: 'model', protocol: 'protocol', attemptNo: 2 };
        try { return { result: fn(previous, { replayFence: 'tool_intent' }, facts, ProviderAttemptError), reads }; }
        catch (error) { return { error, reads }; }
      };
      assert.deepEqual(execute(native.providerValidateAttemptTransition), execute(legacyAttemptTransition));
    }
  }
});

// Frozen pre-migration proxy authorization, used only as a differential oracle.
  function legacyAuthorizeProxyRequest(input, context, port) {
    const clean = value => value == null ? '' : String(value).trim();
    const { runtimeEpoch, quotaGuard, resolveTerminalRoute, resolveProviderRevision, snapshot, auditOnly, poisonProxyAttempt } = port;
    const backgroundLingers = record => !!(record && record.lifecycle.succeeded() && record.spawnKey && require('../src/cli/cli-capability').isResident(record.cli));
    const { sessionId, record } = context;
    const reject = (code, poison = false) => {
      if (poison) poisonProxyAttempt(record, code);
      auditOnly(sessionId, {
        type: 'provider_proxy_request_rejected', operation: 'proxy_preflight', code,
        runtimeEpoch: record ? record.runtimeEpoch : runtimeEpoch,
        turnId: record ? record.turnId : null,
        routeAttemptId: record ? record.routeAttemptId : null,
        routeGeneration: record ? record.routeGeneration : null,
        providerId: clean(input.providerId) || null,
      });
      return Object.freeze({ ok: false, code, sessionId: sessionId || null });
    };
    const role = clean(input.role || input.roleKind || 'main').toLowerCase();
    // Account protection comes before route bookkeeping: the question is not
    // "does this caller own the route" but "may this account be spent any
    // further". Connectivity probes (HEAD /api/hello) and plain reads are not
    // inference and must still answer, or a guarded account would look offline.
    const method = clean(input.method).toUpperCase();
    if (quotaGuard && (!method || method === 'POST')) {
      let verdict = null;
      try {
        verdict = quotaGuard.check({ providerId: clean(input.providerId) });
      } catch (_) {
        verdict = null;
      }
      if (verdict && verdict.blocked) {
        return reject(`quota_guard:${verdict.window}:${Math.round(verdict.usedPercent)}pct`);
      }
    }
    // 终端会话没有回合：它在 currentBySession 里本来就没有记录，能力在会话记录上。
    // 判定必须发生在 attempt 那套判断之前 —— 那些判断问的正是「有没有一条在跑的
    // 回合」，对长活终端永远是否。放行的条件与常驻车道同一口径（主线路必须就是这条
    // 会话自己的 provider，子线路必须在它声明的集合里），只是没有 revision 这一层：
    // 终端的配置是进程启动时写死的一次性快照，拿它去比「当前 provider 配置」只会让
    // 一个活着的终端在用户改完 provider 之后莫名失联。
    if (!record && sessionId && resolveTerminalRoute) {
      const terminal = resolveTerminalRoute(sessionId);
      if (terminal) {
        if (!context.encoded || clean(context.token) !== clean(terminal.token)) {
          return reject('proxy_route_capability_mismatch');
        }
        const requested = clean(input.providerId);
        if (role === 'main' && requested && requested !== clean(terminal.providerId)) {
          return reject('provider_route_mismatch');
        }
        if (role !== 'main' && role !== 'aux' && requested
            && !terminal.allowedSubProviderIds.includes(requested)) {
          return reject('provider_subroute_not_allowed');
        }
        auditOnly(sessionId, {
          type: 'provider_proxy_terminal_route_allowed', operation: 'proxy_preflight',
          runtimeEpoch, providerId: requested || clean(terminal.providerId), role,
        });
        return Object.freeze({ ok: true, code: null, sessionId, attempt: null, terminal: true });
      }
    }
    if (!sessionId || !context.exact) return reject('proxy_route_capability_mismatch');
    if (backgroundLingers(record)) {
      if (role === 'main' && clean(input.providerId)
          && clean(input.providerId) !== record.providerId) {
        return reject('provider_route_mismatch');
      }
      if (role !== 'main' && clean(input.providerId)
          && !record.allowedSubProviderIds.includes(clean(input.providerId))) {
        return reject('provider_subroute_not_allowed');
      }
      if (resolveProviderRevision) {
        let revisionMatches = false;
        try { revisionMatches = clean(resolveProviderRevision(record, input)) === record.providerRevision; }
        catch (_) {}
        if (!revisionMatches) return reject('provider_revision_mismatch');
      }
      return Object.freeze({
        ok: true, code: null, sessionId, attempt: snapshot(record), background: true,
      });
    }
    if (!record || !record.lifecycle.running()) return reject('proxy_attempt_not_running');
    // The host already proved this route went silent and is retiring it. A CLI
    // that re-dials it (codex retries the same stream several times before it
    // gives up) would only hold the turn open on a line that cannot answer, and
    // would deny Auto the chance to switch. Not poisoned: the attempt's failure
    // category is the stall, which the turn's error decision already owns.
    if (record.lifecycle.budget().stalled) return reject('attempt_stalled');
    if (role === 'main' && clean(input.providerId)
        && clean(input.providerId) !== record.providerId) {
      return reject('provider_route_mismatch', true);
    }
    if (role !== 'main' && role !== 'aux' && clean(input.providerId)
        && !record.allowedSubProviderIds.includes(clean(input.providerId))) {
      return reject('provider_subroute_not_allowed', true);
    }
    if (resolveProviderRevision) {
      let revisionMatches = false;
      try { revisionMatches = clean(resolveProviderRevision(record, input)) === record.providerRevision; }
      catch (_) {}
      if (!revisionMatches) return reject('provider_revision_mismatch', true);
    }
    return Object.freeze({ ok: true, code: null, sessionId, attempt: snapshot(record) });
  }


const authorizationSentinel = new Error('authorization host failure');
const authorizationSnapshot = Object.freeze({ identity: 'original snapshot' });

function compareAuthorization(options) {
  function execute(fn) {
    const trace = [];
    const wrap = (label, object) => new Proxy(object, {
      get(target, key, receiver) {
        if (typeof key === 'string') trace.push(`${label}.${key}`);
        if (`${label}.${key}` === options.throwAt) throw authorizationSentinel;
        return Reflect.get(target, key, receiver);
      },
    });
    const lifecycle = wrap('lifecycle', {
      succeeded() { assert.equal(this, lifecycle); trace.push('succeeded()'); return options.state === 'succeeded'; },
      running() { assert.equal(this, lifecycle); trace.push('running()'); return options.state === 'running'; },
      budget() { assert.equal(this, lifecycle); trace.push('budget()'); return wrap('budget', { stalled: options.stalled }); },
    });
    const allowed = wrap('allowed', ['provider-b']);
    const raw = { lifecycle, spawnKey: options.spawnKey ?? 'spawn', cli: options.cli ?? 'claude-exp',
      providerId: 'provider-a', providerRevision: 'revision-a', allowedSubProviderIds: allowed,
      runtimeEpoch: 'epoch', turnId: 'turn', routeAttemptId: 'attempt', routeGeneration: 2 };
    const record = options.state === 'absent' ? null : wrap('record', raw);
    const input = wrap('input', { role: options.role, roleKind: options.roleKind, method: options.method, providerId: options.providerId });
    const context = { record, sessionId: options.noSession ? '' : 'session',
      exact: options.exact ?? true, encoded: options.encoded ?? true, token: options.token ?? 'token' };
    const terminal = options.terminal && wrap('terminal', { token: 'token', providerId: 'provider-a', allowedSubProviderIds: allowed });
    const port = Object.freeze({
      runtimeEpoch: 'fallback-epoch',
      quotaGuard: options.quota === 'none' ? null : wrap('quota', {
        check(args) {
          trace.push(['check()', args]);
          if (options.quota === 'throw') throw options.thrown;
          return wrap('verdict', { blocked: options.quota === 'blocked', window: options.window ?? 'weekly', usedPercent: options.usedPercent ?? 93.5 });
        },
      }),
      resolveTerminalRoute(sessionId) {
        assert.equal(this, undefined); trace.push(['terminal()', sessionId]);
        if (options.terminalThrow) throw authorizationSentinel;
        return terminal;
      },
      resolveProviderRevision: options.revision === 'none' ? null : function (r, i) {
        assert.equal(this, undefined); assert.equal(r, record); assert.equal(i, input);
        trace.push('revision()');
        if (options.revision === 'throw') throw options.thrown;
        if (options.reenter) {
          const nested = fn({ method: 'GET' }, { sessionId: '', record: null, exact: false }, port);
          trace.push(['nested', nested.code]);
          raw.providerRevision = 'revision-new';
        }
        return options.revision === 'mismatch' ? 'revision-other' : options.reenter ? 'revision-new' : ' revision-a ';
      },
      snapshot(r) { assert.equal(this, undefined); assert.equal(r, record); trace.push('snapshot()'); return authorizationSnapshot; },
      poisonProxyAttempt(r, code) { assert.equal(this, undefined); assert.equal(r, record); trace.push(['poison()', code]); raw.turnId = 'poisoned-turn'; },
      auditOnly(sessionId, event) { assert.equal(this, undefined); trace.push(['audit()', sessionId, event, Object.keys(event)]); },
    });
    try {
      const result = fn(input, context, port);
      if (result.attempt) assert.equal(result.attempt, authorizationSnapshot);
      return { result, frozen: Object.isFrozen(result), keys: Object.keys(result), trace };
    } catch (error) {
      return { threw: true, sentinel: error === authorizationSentinel, error: error instanceof Error ? [error.name, error.message] : error, trace };
    }
  }
  const native = require('../src/native/runtime').getNative();
  assert.deepEqual(execute(native.providerAuthorizeProxyRequest), execute(legacyAuthorizeProxyRequest), JSON.stringify(options));
}

test('Rust proxy authorization matches the legacy route, quota, terminal and background matrix', () => {
  for (const state of ['absent', 'running', 'succeeded', 'failed']) {
    for (const role of [undefined, 'main', 'subagent', 'aux', ' BACKGROUND ']) {
      for (const method of [undefined, 'post', 'HEAD', 'GET']) {
        for (const providerId of ['', 'provider-a', 'provider-b', 'unknown']) {
          for (const quota of ['none', 'blocked', 'clear']) {
            for (const revision of ['none', 'match', 'mismatch']) {
              compareAuthorization({ state, role, method, providerId, quota, revision, terminal: state === 'absent' });
            }
          }
        }
      }
    }
  }
});

test('Rust proxy authorization keeps invalid capabilities, stalled routes and nonresident finality closed', () => {
  for (const extra of [{ noSession: true }, { exact: false }, { encoded: false }, { token: 'bad' },
    { stalled: true }, { spawnKey: '' }, { cli: 'kimi' }, { cli: '\ufeffCLAUDE-EXP\ufeff' }, { cli: '\u0085claude-exp' }]) {
    for (const state of ['absent', 'running', 'succeeded', 'failed']) {
      for (const role of ['main', 'subagent', 'aux']) {
        compareAuthorization({ state, role, providerId: 'provider-a', terminal: true, ...extra });
      }
    }
  }
});

test('Rust proxy authorization preserves callback exceptions, lazy getters and reentry', () => {
  for (const thrown of [authorizationSentinel, Symbol('thrown'), null, undefined, 42]) {
    compareAuthorization({ state: 'running', quota: 'throw', thrown });
    compareAuthorization({ state: 'running', revision: 'throw', thrown });
    compareAuthorization({ state: 'succeeded', revision: 'throw', thrown });
  }
  for (const state of ['absent', 'running', 'succeeded']) {
    for (const throwAt of ['input.role', 'input.method', 'input.providerId', 'quota.check', 'verdict.blocked',
      'verdict.window', 'verdict.usedPercent', 'record.lifecycle', 'record.providerRevision', 'record.providerId',
      'lifecycle.succeeded', 'lifecycle.running', 'lifecycle.budget', 'budget.stalled', 'allowed.includes', 'terminal.token']) {
      for (const quota of ['clear', 'blocked']) {
        compareAuthorization({ state, quota, throwAt, terminal: true, role: 'subagent', providerId: 'provider-b' });
      }
    }
  }
  compareAuthorization({ state: 'absent', terminalThrow: true });
  compareAuthorization({ state: 'running', reenter: true });
  compareAuthorization({ state: 'succeeded', reenter: true });
  compareAuthorization({ state: 'running', quota: 'blocked', window: Symbol('window') });
  compareAuthorization({ state: 'running', quota: 'blocked', usedPercent: -0.5 });
  compareAuthorization({ state: 'running' }); // No swallowed exception can leak into the next call.
});

// Exercise complete traces against the saved Node orchestration, sharing only
// the already-migrated storage primitives. Compare state after every operation.
function compareProducerTrace(steps, options = {}) {
  const native = require('../src/native/runtime').getNative();
  const { legacyProducerOperations } = require('./helpers/legacy-provider-producers');
  const { ProviderAttemptError } = require('../src/chat/provider-attempt-runtime');
  const attempt = Object.freeze({ turnId: 'turn', providerId: 'provider-a', routeAttemptId: 'attempt' });
  function execute(useNative) {
    const trace = [], results = [];
    const main = new native.RustMainProducers(), nonMain = new native.RustNonMainProducers();
    let context, state = options.state || 'running', tick = options.tick ?? 1000, hookUsed = false, ops;
    const wrap = (label, object) => new Proxy(object, { get(target, prop, receiver) {
      trace.push(`${label}.${String(prop)}`);
      if (`${label}.${String(prop)}` === options.throwAt) throw authorizationSentinel;
      return Reflect.get(target, prop, receiver);
    } });
    const lifecycle = wrap('lifecycle', {
      succeeded() { assert.equal(this, lifecycle); trace.push('succeeded()'); return state === 'succeeded'; },
      running() { assert.equal(this, lifecycle); trace.push('running()'); return state === 'running'; },
      matches(value) { assert.equal(this, lifecycle); trace.push('matches()'); return value === attempt; },
    });
    const record = wrap('record', { lifecycle, cli: options.cli || 'claude-exp', spawnKey: 'spawn',
      providerId: 'provider-a', providerRevision: 'revision-a', proxyRouteToken: 'token' });
    function hook(where) {
      if (options.throwHook === where) throw authorizationSentinel;
      if (options.reenter === where && !hookUsed) {
        hookUsed = true;
        trace.push(['nestedRelease', ops.forceReleaseProducers('session', 'reentry')]);
        main.setActive('session', attempt, 'token', 1, false, 333);
      }
    }
    const port = Object.freeze({ runtimeEpoch: 'epoch', proxyProducers: main, nonMainProxyProducers: nonMain,
      now() { assert.equal(this, undefined); trace.push('now()'); hook('clock'); return tick; },
      snapshot(value) { assert.equal(this, undefined); assert.equal(value, record); trace.push('snapshot()'); hook('snapshot'); return attempt; },
      resolveProviderRevision: options.revision === 'none' ? null : function (value) {
        assert.equal(this, undefined); assert.equal(value, record); trace.push('revision()'); hook('revision');
        return options.revision === 'mismatch' ? 'changed' : 'revision-a';
      },
      poisonProxyAttempt(value, code) { assert.equal(this, undefined); assert.equal(value, context.record); trace.push(['poison()', code]); hook('poison'); },
      auditOnly(id, event) { assert.equal(this, undefined); trace.push(['audit()', id, event, Object.keys(event)]); hook('audit'); },
      producerStaleGraceMs: 5000, ProviderAttemptError,
      proxyContext: () => context,
    });
    ops = useNative ? {
      onProxyActivity: event => native.providerProxyActivity(event, context, port),
      boundProxyAttempt: event => native.providerBoundProxyAttempt(event, context, port),
      forceReleaseProducers: (id, reason = 'force_release') => native.providerForceReleaseProducers(id, reason, port),
      drainStaleProducers: (id, turn, producer) => native.providerDrainStaleProducers(id, turn, producer, port),
      nonMainProducerKey: (ctx, event, role) => native.providerNonMainProducerKey(ctx, event, role),
    } : legacyProducerOperations(port);
    if (options.count != null) main.setActive('session', attempt, 'token', options.count, false, options.last ?? 1000);
    const mainState = entry => entry && { count: entry.count, ambiguous: entry.ambiguous, last: entry.lastRequestAt,
      token: entry.proxyRouteToken, attempt: entry.attempt, sameIdentity: entry.attempt === attempt };
    for (const step of steps) {
      if (step.state) state = step.state;
      if ('tick' in step) tick = step.tick;
      context = { sessionId: step.noSession ? '' : 'session', record: state === 'absent' ? null : record,
        token: step.token ?? 'token', exact: step.exact ?? true };
      const event = wrap('event', { role: step.role ?? 'main', roleKind: step.roleKind,
        providerId: step.providerId ?? 'provider-a', phase: step.phase });
      let value;
      try {
        if (step.op === 'release') value = ops.forceReleaseProducers(step.id ?? 'session', step.reason);
        else if (step.op === 'drain') value = ops.drainStaleProducers('session', 'next-turn', main.getActive('session'));
        else if (step.op === 'bound') value = ops.boundProxyAttempt(event);
        else if (step.op === 'usage') value = nonMain.bindUsage(ops.nonMainProducerKey(context, event, step.role));
        else value = ops.onProxyActivity(event);
        results.push({ value, frozen: value != null && typeof value === 'object' ? Object.isFrozen(value) : null,
          identity: value === attempt });
      } catch (error) {
        results.push({ threw: true, sentinel: error === authorizationSentinel, class: error instanceof ProviderAttemptError,
          error: [error.name, error.code, error.message] });
      }
      results.push({ active: mainState(main.getActive('session')), ended: mainState(main.getEnded('session')) });
    }
    return { trace, results };
  }
  assert.deepEqual(execute(true), execute(false), JSON.stringify({ steps, options }, (_, value) => typeof value === 'bigint' ? `${value}n` : value));
}

test('Rust producer orchestration matches overlapping, cancelled, late-end and background traces', () => {
  for (let seed = 1; seed <= 40; seed++) {
    let n = seed;
    const pick = list => { n = (Math.imul(n, 1664525) + 1013904223) >>> 0; return list[(n >>> 16) % list.length]; };
    const steps = [];
    for (let i = 0; i < 100; i++) steps.push({
      op: pick(['activity', 'activity', 'activity', 'bound', 'release', 'drain', 'usage']),
      phase: pick(['request', 'end', 'progress', '']), role: pick(['main', 'subagent', 'aux', 'background', '']),
      providerId: pick(['provider-a', 'provider-b', '']), exact: pick([true, true, false]),
      token: pick(['token', 'old-token']), state: pick(['running', 'succeeded', 'failed', 'absent']), tick: i * 1000,
    });
    compareProducerTrace(steps, { count: seed % 3, revision: seed % 3 ? 'match' : 'mismatch' });
  }
  // A completed background's late end must not settle the new main producer.
  compareProducerTrace([
    { phase: 'request', state: 'succeeded' }, { phase: 'request', state: 'running' },
    { phase: 'end' }, { op: 'bound' }, { phase: 'end' }, { role: 'background', op: 'usage' },
  ]);
});

test('Rust producer draining preserves grace boundaries, exceptional clocks and audit ordering', () => {
  for (const tick of [0, 5999, 6000, 6001, NaN, Infinity, -Infinity, 6000n]) {
    for (const last of [0, 1000, NaN]) {
      compareProducerTrace([{ op: 'drain' }, { op: 'release' }, { op: 'release' }], { count: 2, tick, last });
    }
  }
  for (const count of [0, 1, 2, NaN, -1]) {
    compareProducerTrace([{ op: 'release', id: '' }, { op: 'release', reason: '' }, { phase: 'end' }], { count });
  }
  for (const throwHook of ['clock', 'audit', 'revision', 'snapshot', 'poison']) {
    compareProducerTrace([{ phase: 'request' }, { op: 'bound' }, { phase: 'end' }, { op: 'release' }, { op: 'drain' }], { count: 1, throwHook });
  }
  for (const reenter of ['clock', 'audit', 'revision', 'snapshot']) {
    compareProducerTrace([{ phase: 'request' }, { op: 'bound' }, { phase: 'end' }, { op: 'release' }], { count: 1, reenter });
  }
});

test('Rust producer callbacks preserve lazy reads and propagated exception identity', () => {
  for (const throwAt of ['event.role', 'event.roleKind', 'event.phase', 'event.providerId', 'record.lifecycle',
    'record.providerId', 'record.providerRevision', 'record.proxyRouteToken', 'lifecycle.succeeded', 'lifecycle.running', 'lifecycle.matches']) {
    for (const role of ['', 'main', 'aux', 'subagent']) {
      compareProducerTrace([{ phase: 'request', role }, { op: 'bound', role }, { phase: 'end', role }, { op: 'release' }], { count: 1, throwAt });
    }
  }
});
