'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const {
  TurnRequestError,
  normalizeTurnRequest,
  planTurnAdmission,
  createDurableMessageProof,
  createProviderRouteProof,
  evaluateSpawnGuard,
  decideRetry,
  routePostTurn,
  createDeliveryProof,
  acknowledgeDeliveredEffect,
  createTurnRuntimeStore,
  CHAT_TURN_PORTS,
  assertChatTurnPorts,
} = require('../src/chat');

function request(overrides = {}) {
  return normalizeTurnRequest({
    sessionId: 'session-1',
    text: '  complete the task  ',
    cli: 'claude',
    turnCount: 0,
    hasNativeSession: false,
    ...overrides,
  });
}

test('turn request normalizes identity/origin/history without native ids or secrets', () => {
  const turn = request({ deliveryId: ' delivery-1 ', bgTaskIds: ['a', 'a', 'b'] });
  assert.equal(turn.text, 'complete the task');
  assert.equal(turn.requestId, 'delivery-1');
  assert.deepEqual(turn.identity, { clientMsgId: 'delivery-1', deliveryId: 'delivery-1' });
  assert.deepEqual(turn.background.taskIds, ['a', 'b']);
  assert.deepEqual(turn.origin, { kind: 'user', operationId: null });
  assert.deepEqual(turn.execution, {
    transport: 'claude-stream', historyIntent: 'first', isFirstTurn: true,
    resume: false, forceFirstTurn: null,
  });
  const serialized = JSON.stringify(turn);
  assert.equal(serialized.includes('cliSessionId'), false);
  assert.equal(serialized.includes('nativeSessionId'), false);
  assert.equal(serialized.includes('secret'), false);
});

test('force-first/resume/retry/dispatch metadata is explicit and illegal combinations fail closed', () => {
  const turn = request({
    cli: 'codex', turnCount: 4, hasNativeSession: true,
    forceFirstTurn: false, resume: true,
    retry: { attempt: 2, reason: 'transport-disconnect', strategy: 'resume' },
    originDispatchId: 'operation-9', clientMsgId: 'client-9',
  });
  assert.deepEqual(turn.execution, {
    transport: 'cli-process', historyIntent: 'resume', isFirstTurn: false,
    resume: true, forceFirstTurn: false,
  });
  assert.deepEqual(turn.retry, { attempt: 2, reason: 'transport-disconnect', strategy: 'resume' });
  assert.deepEqual(turn.origin, { kind: 'dispatch', operationId: 'operation-9' });

  assert.throws(() => request({ cliSessionId: 'native-secret' }), error => (
    error instanceof TurnRequestError && error.code === 'secret_field_forbidden'
  ));
  assert.throws(() => request({ forceFirstTurn: true, resume: true }), /contradict/);
  assert.throws(() => request({ forceFirstTurn: false, resume: true, hasNativeSession: false }), /native session/);
  assert.throws(() => request({ originDispatchId: 'd1', originContinue: true }), /mutually exclusive/);
  assert.throws(() => request({ retry: { strategy: 'resume' } }), /cannot be a first turn/);
});

test('duplicate delivery is checked before interrupt and never emits interruption effects', () => {
  const turn = request({ deliveryId: 'delivery-1' });
  const duplicate = planTurnAdmission(turn, {
    duplicateSeen: true,
    duplicatePersisted: true,
    runningTurn: true,
  });
  assert.equal(duplicate.decision, 'duplicate');
  assert.equal(duplicate.accepted, true);
  assert.deepEqual(duplicate.trace, ['duplicate-check']);
  assert.deepEqual(duplicate.effects, []);

  const fresh = planTurnAdmission(turn, { sessionExists: true, runningTurn: true });
  assert.equal(fresh.decision, 'prepare');
  assert.deepEqual(fresh.effects.map(effect => effect.type), [
    'interrupt-running-turn', 'persist-user-message',
  ]);
});

test('system continuation is held during network failure while user turns remain admissible', () => {
  const system = request({ originContinue: true });
  const held = planTurnAdmission(system, { sessionExists: true, networkUnhealthy: true });
  assert.equal(held.decision, 'hold');
  assert.equal(held.effects[0].type, 'hold-turn');
  const user = request();
  assert.equal(planTurnAdmission(user, { sessionExists: true, networkUnhealthy: true }).decision, 'prepare');
});

test('spawn requires durable message, provider route and runtime claim proofs', () => {
  const turn = request({ requestId: 'request-1' });
  const runtime = createTurnRuntimeStore({ now: () => 100 });
  assert.equal(runtime.claim(turn.sessionId, 'turn-1', {
    cli: turn.cli, transport: turn.execution.transport,
  }).ok, true);
  const route = createProviderRouteProof(turn, { resolved: true });
  const missing = evaluateSpawnGuard(turn, {
    message: createDurableMessageProof(turn, { persisted: false }),
    route,
    runtime: runtime.claimProof(turn.sessionId, 'turn-1'),
  });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missing, ['durable-user-message']);

  const ready = evaluateSpawnGuard(turn, {
    message: createDurableMessageProof(turn, { persisted: true }),
    route,
    runtime: runtime.claimProof(turn.sessionId, 'turn-1'),
  });
  assert.equal(ready.ok, true);
  assert.deepEqual(ready.effect, {
    type: 'spawn-turn', sessionId: 'session-1', turnId: 'turn-1', cli: 'claude',
    transport: 'claude-stream', historyIntent: 'first',
  });
});

test('runtime store blocks double turns and requires legal proof-bearing transitions', () => {
  let clock = 1_000;
  const store = createTurnRuntimeStore({ now: () => clock++ });
  assert.equal(store.claim('s1', 't1', { cli: 'codex', transport: 'cli-process' }).ok, true);
  assert.equal(store.claim('s1', 't2').code, 'turn_in_flight');
  assert.deepEqual(store.start('s1', 't1').missing, ['durable-user-message', 'provider-route']);
  assert.equal(store.markMessageDurable('s1', 't1').ok, true);
  assert.equal(store.markProviderRouteResolved('s1', 't1', { resolved: true }).ok, true);
  assert.equal(store.start('s1', 't1').state.phase, 'running');
  assert.equal(store.cleanup('s1', 't1').code, 'invalid_transition');
  assert.equal(store.beginCleanup('s1', 't1', { status: 'completed' }).state.phase, 'finishing');
  assert.equal(store.cleanup('s1', 't1').state.phase, 'idle');

  assert.equal(store.claim('s1', 't2', { cli: 'claude', transport: 'claude-stream' }).ok, true);
  assert.equal(store.cleanup('s1', 't1').code, 'stale_turn');
  assert.equal(store.snapshot('s1').turnId, 't2', 'stale cleanup must not erase the new turn');
});

test('provider route failure returns runtime to idle and never leaves running state', () => {
  const store = createTurnRuntimeStore({ now: () => 55 });
  store.claim('s1', 't1', { cli: 'codex', transport: 'cli-process' });
  store.markMessageDurable('s1', 't1');
  const failed = store.markProviderRouteResolved('s1', 't1', { resolved: false, reason: 'provider unavailable' });
  assert.equal(failed.ok, true);
  assert.equal(failed.state.phase, 'idle');
  assert.equal(failed.state.lastOutcome.status, 'failed');
  assert.equal(store.start('s1', 't1').code, 'stale_turn');

  store.claim('s1', 't2', { cli: 'claude', transport: 'claude-stream' });
  const persistenceFailure = store.abortPreparation('s1', 't2', 'message-not-durable');
  assert.equal(persistenceFailure.state.phase, 'idle');
  assert.equal(persistenceFailure.state.lastOutcome.reason, 'message-not-durable');
});

test('retry policy preserves current caps, delay and deterministic scheduling', () => {
  const deps = { now: () => 1_000, random: () => 0.5, jitterMs: 20 };
  const api = decideRetry({ event: 'api-error', cli: 'claude', attempts: { apiError: 999 } }, deps);
  assert.deepEqual(api, {
    action: 'resume', classification: 'api-error', attempt: 1000,
    delayMs: 10, scheduledAt: 1010, capped: false,
  });
  assert.equal(decideRetry({ event: 'api-error', attempts: {} }, { now: () => 10 }).delayMs, 0,
    'production default preserves API_RETRY_DELAY_MS=0');
  const interrupted = decideRetry({ event: 'interrupted', attempts: { interruptedResume: 9 } }, { now: () => 0 });
  assert.equal(interrupted.action, 'resume');
  assert.equal(interrupted.attempt, 10);
  assert.equal(decideRetry({ event: 'interrupted', attempts: { interruptedResume: 10 } }).reason, 'resume-cap-reached');
  assert.equal(decideRetry({ event: 'interrupted', userStopped: true }).reason, 'user-stopped');
  assert.equal(decideRetry({ event: 'interrupted', hasExplicitWait: true }).action, 'wait');

  const fresh = decideRetry({ event: 'empty-exit', cli: 'codex', attempts: {} }, { now: () => 5 });
  assert.equal(fresh.action, 'retry-fresh');
  assert.equal(fresh.attempt, 1);
  assert.equal(decideRetry({ event: 'empty-exit', cli: 'codex', isRetry: true }).reason, 'fresh-retry-exhausted');
  assert.equal(decideRetry({ event: 'empty-exit', cli: 'claude' }).reason, 'claude-stream-does-not-fresh-retry');
});

test('Codex disconnect continuation remains distinct from Claude and is capped at two', () => {
  const base = {
    event: 'codex-stream-disconnect', hasOutput: true, resultSaved: false,
    hasNativeSession: true, attempts: { codexDisconnect: 1 },
  };
  const codex = decideRetry({ ...base, cli: 'codex' }, { now: () => 0 });
  assert.equal(codex.action, 'resume');
  assert.equal(codex.attempt, 2);
  assert.equal(decideRetry({ ...base, cli: 'codex', attempts: { codexDisconnect: 2 } }).reason,
    'codex-continuation-cap-reached');
  assert.equal(decideRetry({ ...base, cli: 'claude' }).reason, 'codex-continuation-not-applicable');
});

test('origin dispatch return wins routing and exactly-once receipt prevents redispatch', () => {
  const first = routePostTurn({
    turnId: 't1', sessionId: 'worker', sessionType: 'normal',
    originDispatchId: 'dispatch-1',
    finalText: 'done\n<<dispatch target="another">must not run</dispatch>',
  });
  assert.equal(first.route, 'dispatch-return');
  assert.deepEqual(first.effects.map(effect => effect.type), ['complete-dispatch']);
  assert.equal(first.effects.some(effect => effect.type === 'inspect-dispatch-markers'), false);
  const repeated = routePostTurn({
    turnId: 't1', sessionId: 'worker', sessionType: 'normal',
    originDispatchId: 'dispatch-1', finalText: 'done',
    receipts: ['dispatch-return:dispatch-1'],
  });
  assert.deepEqual(repeated.effects, []);
});

test('dispatch/outbox acknowledgement requires matching durable delivery proof', () => {
  const routed = routePostTurn({
    turnId: 't1', sessionId: 'worker', originDispatchId: 'dispatch-1', finalText: 'done',
  });
  const effect = routed.effects[0];
  assert.equal(acknowledgeDeliveredEffect(effect, null).code, 'delivery_proof_required');
  assert.equal(acknowledgeDeliveredEffect(effect, createDeliveryProof({
    effectId: 'wrong', deliveryId: 'outbox-1', durable: true, delivered: true,
  })).code, 'delivery_proof_required');
  const ack = acknowledgeDeliveredEffect(effect, createDeliveryProof({
    effectId: effect.effectId, deliveryId: 'outbox-1', durable: true, delivered: true,
  }));
  assert.deepEqual(ack, {
    ok: true,
    receipt: { type: 'ack-delivery', effectId: 'dispatch-return:dispatch-1', deliveryId: 'outbox-1' },
  });
});

test('handoff, gateway, aux and normal post-turn routes remain explicit', () => {
  const handoff = routePostTurn({
    turnId: 't1', sessionId: 's1', sessionType: 'normal', finalText: 'ok',
    handoff: { id: 'h1', status: 'pending', completed: true },
  });
  assert.deepEqual(handoff.effects.map(effect => effect.type), ['ack-handoff', 'inspect-dispatch-markers']);
  const handoffRepeated = routePostTurn({
    turnId: 't1', sessionId: 's1', sessionType: 'normal', finalText: 'ok',
    handoff: { id: 'h1', status: 'pending', completed: true }, receipts: ['handoff:h1'],
  });
  assert.equal(handoffRepeated.effects.some(effect => effect.type === 'ack-handoff'), false);
  assert.equal(routePostTurn({ handoffResumeFailure: true }).route, 'handoff-failed');
  assert.equal(routePostTurn({ turnId: 't2', sessionId: 'g', sessionType: 'gateway' }).route, 'gateway');
  assert.equal(routePostTurn({ turnId: 't3', sessionId: 'a', sessionType: 'aux' }).route, 'aux');
  assert.equal(routePostTurn({ turnId: 't4', sessionId: 'n', sessionType: 'normal' }).route, 'normal');
});

test('chat turn ports are narrow and pure modules import no runtime I/O dependencies', () => {
  const calls = [];
  const ports = {};
  for (const [name, methods] of Object.entries(CHAT_TURN_PORTS)) {
    ports[name] = Object.fromEntries(methods.map(method => [method, () => calls.push(`${name}.${method}`)]));
  }
  assert.equal(assertChatTurnPorts(ports), ports);
  assert.throws(() => assertChatTurnPorts({}), /port missing/);

  for (const file of ['turn-request.js', 'retry-policy.js', 'post-turn-router.js', 'runtime-store.js', 'ports.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'chat', file), 'utf8');
    assert.equal(/require\(['"](?:fs|child_process|express|ws)['"]\)/.test(source), false, `${file} must stay pure`);
  }
});
