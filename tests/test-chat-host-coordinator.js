'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  normalizeTurnRequest,
  createTurnLifecycle,
  createRunnerOwnership,
  createDeliveryProof,
  CHAT_HOST_PORTS,
  assertChatHostPorts,
  isCurrentTurnRunner,
  assistantCheckpointKey,
  decideRunnerFinality,
  createChatHostCoordinator,
  createChatHostRuntime,
} = require('../src/chat');

function makeRequest(overrides = {}) {
  return normalizeTurnRequest({
    sessionId: 'session-1',
    text: 'finish the task',
    cli: 'claude',
    turnCount: 0,
    hasNativeSession: false,
    ...overrides,
  });
}

function makeOwned(overrides = {}) {
  const request = makeRequest(overrides.request);
  const turn = createTurnLifecycle(request, { turnId: overrides.turnId || 'turn-1' });
  const runner = createRunnerOwnership(turn, {
    runnerId: overrides.runnerId || 'runner-1',
    kind: overrides.kind || (request.cli === 'claude' ? 'stream' : 'process'),
  });
  return { request, turn, runner, currentTurn: turn, currentRunner: runner };
}

function makePorts(overrides = {}) {
  return {
    history: { appendFinal: overrides.appendFinal || (() => true) },
    usage: {
      commit: overrides.commitUsage || (() => true),
      ...(overrides.afterUsageCommit ? { afterCommit: overrides.afterUsageCommit } : {}),
    },
    effects: { deliver: overrides.deliverEffect || (() => ({ ok: true })) },
  };
}

test('host ports are narrow and coordinator imports no runtime I/O', () => {
  assert.deepEqual(CHAT_HOST_PORTS, {
    history: ['appendFinal'], usage: ['commit'], effects: [],
  });
  const ports = makePorts();
  assert.equal(assertChatHostPorts(ports), ports);
  assert.throws(() => assertChatHostPorts({}), /port missing/);
  assert.throws(() => assertChatHostPorts({
    ...ports, usage: { ...ports.usage, afterCommit: true },
  }), /usage\.afterCommit/);
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'chat', 'host-coordinator.js'), 'utf8');
  assert.equal(/require\(['"](?:fs|child_process|express|ws)['"]\)/.test(source), false);
});

test('production helper surface exposes ownership and byte-compatible assistant checkpoint keys', () => {
  const owned = makeOwned();
  assert.equal(isCurrentTurnRunner({
    currentTurn: owned.turn, currentRunner: owned.runner,
  }, owned.turn, owned.runner), true);
  assert.equal(isCurrentTurnRunner({
    currentTurn: owned.turn, currentRunner: {},
  }, owned.turn, owned.runner), false);
  assert.equal(isCurrentTurnRunner({
    _activeTurn: owned.turn, _activeRunner: owned.runner,
  }, owned.turn, owned.runner), true, 'server chat-session field names are accepted directly');
  const output = { text: 'answer', tools: [{ name: 'Read', id: 'tool-1' }], cost: 0.5 };
  const legacy = crypto.createHash('sha256').update(JSON.stringify({
    text: output.text, tools: output.tools, cost: output.cost,
  })).digest('hex');
  assert.equal(assistantCheckpointKey(output), legacy);
  assert.equal(assistantCheckpointKey({
    currentAssistantText: output.text,
    currentToolCalls: output.tools,
    currentCost: output.cost,
  }), legacy, 'server chat-session output fields remain byte compatible');
  assert.equal(createChatHostCoordinator(makePorts()).assistantCheckpointKey(output), legacy);
});

test('Claude stream and process runners keep different finality contracts', () => {
  const stream = makeOwned({ kind: 'stream' }).runner;
  const processRunner = makeOwned({ kind: 'process', request: { cli: 'codex' } }).runner;
  assert.deepEqual(decideRunnerFinality(stream, { normalExit: true }), {
    final: false, code: 'stream_result_event_required',
  });
  assert.deepEqual(decideRunnerFinality(processRunner, { normalExit: true }), {
    final: true, code: null,
  });
  assert.equal(decideRunnerFinality(processRunner, { normalExit: true, isRetry: true }).final, false);
  stream.resultEvent = true;
  assert.equal(decideRunnerFinality(stream, {}).final, true);
});

test('stale runner cannot append, commit usage, reserve effects or mutate current turn', () => {
  let calls = 0;
  const coordinator = createChatHostCoordinator(makePorts({
    appendFinal: () => { calls++; return true; },
    commitUsage: () => { calls++; return true; },
    deliverEffect: () => { calls++; return { ok: true }; },
  }));
  const old = makeOwned({ turnId: 'turn-old', runnerId: 'runner-old' });
  const current = makeOwned({ turnId: 'turn-new', runnerId: 'runner-new' });
  const facts = {
    ...old,
    currentTurn: current.turn,
    currentRunner: current.runner,
    boundary: 'result',
    message: { role: 'assistant', content: 'late' },
    usage: { input_tokens: 1 },
  };
  const result = coordinator.finalize(facts);
  assert.equal(result.code, 'stale_runner');
  assert.equal(old.turn.resultDurable, false);
  assert.equal(old.runner.resultEvent, false);
  assert.equal(coordinator.reservePostTurn(facts).code, 'stale_runner');
  assert.equal(calls, 0);
});

test('result append and close retry can both fail without creating durable proof or post-turn effects', () => {
  let appendCalls = 0;
  const owned = makeOwned({ request: { originDispatchId: 'dispatch-failure' } });
  const coordinator = createChatHostCoordinator(makePorts({
    appendFinal: () => { appendCalls++; return false; },
  }));
  const first = coordinator.finalize({
    ...owned,
    boundary: 'result',
    message: { role: 'assistant', content: 'generated' },
    facts: {},
  });
  assert.equal(first.append.code, 'result_not_durable');
  assert.equal(owned.runner.resultEvent, true);
  const close = coordinator.finalize({
    ...owned,
    boundary: 'close',
    message: { role: 'assistant', content: 'generated' },
    facts: { normalExit: true },
  });
  assert.equal(close.append.code, 'result_not_durable');
  assert.equal(close.postTurn.code, 'result_not_durable');
  assert.equal(owned.turn.resultDurable, false);
  assert.equal(owned.turn.postTurnClaimed, false);
  assert.equal(owned.turn.lineage.operationId, 'dispatch-failure');
  assert.equal(appendCalls, 2, 'close must get one recovery attempt after result append failure');
});

test('explicit lifecycle kill persists only a checkpoint and never promotes or routes it', () => {
  const appends = [];
  const owned = makeOwned({ kind: 'stream' });
  const coordinator = createChatHostCoordinator(makePorts({
    appendFinal: input => { appends.push(input); return true; },
  }));
  const result = coordinator.finalize({
    ...owned,
    boundary: 'close',
    checkpointKey: 'partial-sha',
    message: { role: 'assistant', content: 'partial' },
    facts: { killReason: 'shutdown', interrupted: true, normalExit: true },
  });
  assert.equal(result.append.persisted, true);
  assert.equal(result.append.partial, true);
  assert.equal(result.append.durable, false);
  assert.equal(result.postTurn.code, 'result_not_durable');
  assert.equal(owned.runner.killReason, 'shutdown');
  assert.equal(appends[0].final, false);
  assert.equal(appends[0].partial, true);

  const repeated = coordinator.appendResult({
    ...owned,
    boundary: 'close',
    checkpointKey: 'partial-sha',
    message: { role: 'assistant', content: 'partial' },
    facts: { killReason: 'shutdown' },
  });
  assert.equal(repeated.code, 'partial_already_durable');
  assert.equal(appends.length, 1, 'same durable partial must not be appended twice');
});

test('retry runner preserves dispatch lineage but cannot inherit an earlier result event', () => {
  const owned = makeOwned({
    kind: 'process',
    request: { cli: 'codex', originDispatchId: 'dispatch-retry', originContinue: true },
  });
  let appendAttempt = 0;
  const coordinator = createChatHostCoordinator(makePorts({
    appendFinal: () => ++appendAttempt > 1,
  }));
  const failed = coordinator.finalize({
    ...owned,
    boundary: 'result',
    message: { role: 'assistant', content: 'attempt one' },
    facts: { retryPlanned: true },
  });
  assert.equal(failed.postTurn.code, 'result_not_durable');
  assert.equal(owned.runner.retryPlanned, true);
  assert.equal(owned.turn.lineage.operationId, 'dispatch-retry');
  assert.equal(owned.turn.launchReason, 'continue');

  // A retry is a new runner for the same logical turn. It keeps immutable
  // lineage but receives no result evidence from the previous process.
  const retry = createRunnerOwnership(owned.turn, { runnerId: 'runner-retry', kind: 'process' });
  const retryHost = { ...owned, currentRunner: retry, runner: retry };
  assert.equal(retry.resultEvent, false);
  const retryClose = coordinator.finalize({
    ...retryHost,
    boundary: 'close',
    message: { role: 'assistant', content: 'partial retry output' },
    facts: { normalExit: true, isRetry: true },
  });
  assert.equal(retryClose.append.partial, true);
  assert.equal(retryClose.append.durable, false);
  assert.equal(owned.turn.lineage.operationId, 'dispatch-retry');
});

test('authoritative usage commit is retriable, runner-owned and claimed exactly once', () => {
  const owned = makeOwned({ kind: 'process', request: { cli: 'codex' } });
  const writes = [false, true];
  let commitCalls = 0;
  let observerCalls = 0;
  const coordinator = createChatHostCoordinator(makePorts({
    commitUsage: input => {
      assert.equal(input.idempotencyKey, 'usage:turn-1:runner-1');
      return writes[commitCalls++];
    },
    afterUsageCommit: () => { observerCalls++; throw new Error('derived stats unavailable'); },
  }));
  const final = coordinator.appendResult({
    ...owned,
    boundary: 'result',
    message: { role: 'assistant', content: 'done' },
  });
  assert.equal(final.durable, true);
  assert.equal(coordinator.commitUsage({ ...owned, usage: { input_tokens: 4 } }).code, 'usage_commit_failed');
  assert.equal(owned.runner.usageRecorded, undefined);
  const recovered = coordinator.commitUsage({ ...owned, usage: { input_tokens: 4 } });
  assert.equal(recovered.committed, true);
  assert.equal(recovered.observerError, 'derived stats unavailable');
  assert.equal(owned.runner.usageRecorded, true);
  assert.equal(coordinator.commitUsage({ ...owned, usage: { input_tokens: 4 } }).code, 'usage_already_recorded');
  assert.equal(commitCalls, 2);
  assert.equal(observerCalls, 1);
});

test('dispatch return is claimed only after matching durable delivery proof', async () => {
  const owned = makeOwned({ request: { originDispatchId: 'dispatch-proof' } });
  let proofMode = false;
  let deliveries = 0;
  const coordinator = createChatHostCoordinator(makePorts({
    deliverEffect: effect => {
      deliveries++;
      return proofMode
        ? createDeliveryProof({
          effectId: effect.effectId,
          deliveryId: 'outbox-1',
          durable: true,
          delivered: true,
        })
        : { ok: true };
    },
  }), { nextReservationId: (() => { let n = 0; return () => `reservation-${++n}`; })() });
  coordinator.appendResult({
    ...owned,
    boundary: 'result',
    message: { role: 'assistant', content: 'done' },
  });

  const firstPlan = coordinator.reservePostTurn({
    ...owned, sessionType: 'normal', finalText: 'done',
  });
  assert.equal(firstPlan.route, 'dispatch-return');
  const rejected = await coordinator.deliverPostTurn(firstPlan, owned);
  assert.equal(rejected.code, 'delivery_proof_required');
  assert.equal(owned.turn.postTurnClaimed, false);
  assert.equal(owned.turn.postTurnReservation, null);

  proofMode = true;
  const retryPlan = coordinator.reservePostTurn({
    ...owned, sessionType: 'normal', finalText: 'done',
  });
  const delivered = await coordinator.deliverPostTurn(retryPlan, owned);
  assert.equal(delivered.ok, true);
  assert.equal(delivered.route, 'dispatch-return');
  assert.deepEqual(delivered.receipts, [{
    type: 'ack-delivery',
    effectId: 'dispatch-return:dispatch-proof',
    deliveryId: 'outbox-1',
  }]);
  assert.equal(owned.turn.postTurnClaimed, true);
  assert.equal(coordinator.reservePostTurn({ ...owned, finalText: 'done' }).code,
    'post_turn_already_claimed');
  assert.equal(deliveries, 2);
});

test('production sync claim/plan preserves port order and never fabricates delivery proof', () => {
  const order = [];
  const owned = makeOwned({ request: { originDispatchId: 'dispatch-sync-plan' } });
  const coordinator = createChatHostCoordinator(makePorts({
    appendFinal: () => { order.push('history.appendFinal'); return true; },
    commitUsage: () => { order.push('usage.commit'); return true; },
    afterUsageCommit: () => { order.push('usage.afterCommit'); },
    deliverEffect: () => { order.push('effects.deliver'); return { ok: true }; },
  }));
  const result = coordinator.finalize({
    ...owned,
    boundary: 'result',
    message: { role: 'assistant', content: 'done' },
    usage: { input_tokens: 3 },
    facts: {},
  });
  assert.equal(result.ok, true);
  assert.deepEqual(order, ['history.appendFinal', 'usage.commit', 'usage.afterCommit']);

  const plan = coordinator.claimPostTurnPlan({
    ...owned, sessionType: 'normal', finalText: 'done',
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.route, 'dispatch-return');
  assert.equal(plan.deliveryProven, false);
  assert.deepEqual(plan.effects.map(effect => effect.type), [
    'consume-cli-handoff', 'turn-complete', 'complete-dispatch',
  ]);
  const dispatchEffect = plan.effects[2];
  assert.equal(dispatchEffect.requiresDeliveryProof, true,
    'legacy bus execution must not be mislabeled as a durable delivery');
  assert.equal(order.includes('effects.deliver'), false,
    'sync production plan must not invoke an async bus/effect adapter');
  assert.equal(owned.turn.postTurnClaimed, true);
});

test('future proof-aware delivery fails closed when no effect adapter is configured', async () => {
  const owned = makeOwned({ request: { originDispatchId: 'dispatch-no-port' } });
  const ports = makePorts();
  delete ports.effects;
  const coordinator = createChatHostCoordinator(ports);
  coordinator.appendFinal({
    ...owned, boundary: 'result', message: { role: 'assistant', content: 'done' },
  });
  const plan = coordinator.reservePostTurn({ ...owned, finalText: 'done' });
  const result = await coordinator.deliverPostTurn(plan, owned);
  assert.equal(result.code, 'effects_port_missing');
  assert.equal(owned.turn.postTurnClaimed, false);
  assert.equal(owned.turn.postTurnReservation, null);
});

test('ownership is rechecked after asynchronous effect delivery', async () => {
  const owned = makeOwned({ request: { originDispatchId: 'dispatch-stale' } });
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const coordinator = createChatHostCoordinator(makePorts({
    deliverEffect: async effect => {
      await waiting;
      return createDeliveryProof({
        effectId: effect.effectId, deliveryId: 'outbox-stale', durable: true, delivered: true,
      });
    },
  }));
  coordinator.appendResult({ ...owned, boundary: 'result', message: { role: 'assistant', content: 'done' } });
  const plan = coordinator.reservePostTurn({ ...owned, finalText: 'done' });
  const current = { turn: owned.turn, runner: owned.runner };
  const delivery = coordinator.deliverPostTurn(plan, {
    ...owned,
    get currentTurn() { return current.turn; },
    get currentRunner() { return current.runner; },
  });
  current.turn = makeOwned({ turnId: 'new-turn' }).turn;
  current.runner = makeOwned({ turnId: 'new-turn-2' }).runner;
  release();
  const result = await delivery;
  assert.equal(result.code, 'stale_runner');
  assert.equal(owned.turn.postTurnClaimed, false);
});

test('host runtime composes production ports without leaking effect switches back to server', () => {
  const owned = makeOwned();
  const state = {
    _activeTurn: owned.turn,
    _activeRunner: owned.runner,
    _continuationLineage: { turnId: owned.turn.turnId },
    _resultSaved: false,
  };
  const events = [];
  const runtime = createChatHostRuntime({
    appendMessage: (sessionId, message) => {
      events.push(['append', sessionId, message.content]);
      return true;
    },
    persistUsage: (sessionId, usage) => {
      events.push(['usage', sessionId, usage.input_tokens]);
      return true;
    },
    afterUsageCommit: sessionId => events.push(['usage-observed', sessionId]),
    getSessionState: () => state,
    consumeHandoff: sessionId => events.push(['handoff', sessionId]),
    emitTurnComplete: (sessionId, host, completion) => {
      assert.equal(host, state);
      events.push(['turn-complete', sessionId, completion.turnId]);
    },
    emitDispatchComplete: () => { throw new Error('unexpected dispatch'); },
    emitGatewayComplete: () => { throw new Error('unexpected gateway'); },
    inspectDispatchMarkers: (sessionId, text) => events.push(['inspect', sessionId, text]),
    logSuppressed: detail => events.push(['suppressed', detail.reason]),
  });

  assert.equal(runtime.persistFinalAssistantResult(
    'session-1', state, owned.turn, owned.runner,
    { role: 'assistant', content: 'done' },
    { resultEvent: true },
  ), true);
  assert.equal(state._resultSaved, true);
  assert.equal(runtime.recordDurableTurnUsage('session-1', owned.runner, { input_tokens: 3 }), true);
  assert.equal(runtime.runDurablePostTurn(
    'session-1', state, { type: 'normal' }, owned.turn, owned.runner, 'done', {},
  ), true);
  assert.deepEqual(events, [
    ['append', 'session-1', 'done'],
    ['usage', 'session-1', 3],
    ['usage-observed', 'session-1'],
    ['handoff', 'session-1'],
    ['turn-complete', 'session-1', 'turn-1'],
    ['inspect', 'session-1', 'done'],
  ]);
  assert.equal(state._continuationLineage, null);
});
