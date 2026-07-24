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
  createTurnLifecycle,
  createRunnerOwnership,
  ownsCurrentRunner,
  assignKillReason,
  recordResultEvent,
  recordCloseResult,
  recordPartialCheckpoint,
  hasMatchingPartialCheckpoint,
  claimDurableUsage,
  evaluatePostTurn,
  claimPostTurn,
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
  assert.deepEqual(turn.launch, { reason: 'request' });
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
  const continuedDispatch = request({ originDispatchId: 'd1', originContinue: true });
  assert.deepEqual(continuedDispatch.origin, { kind: 'dispatch', operationId: 'd1' });
  assert.deepEqual(continuedDispatch.launch, { reason: 'continue' });
  const continuedTrigger = request({ originTrigger: true, originContinue: true });
  assert.deepEqual(continuedTrigger.origin, { kind: 'trigger', operationId: null });
  assert.deepEqual(continuedTrigger.launch, { reason: 'continue' });
  assert.throws(() => request({ originDispatchId: 'd1', originTrigger: true }), /mutually exclusive/);
  assert.throws(() => request({ retry: { strategy: 'resume' } }), /cannot be a first turn/);
});

test('task context is explicit, trusted, and preserved only for routed task starts', () => {
  const request = normalizeTurnRequest({
    sessionId: 'worker-1',
    text: '【任务：新任务】\n完整正文',
    cli: 'codex',
    turnCount: 0,
    hasNativeSession: false,
    taskId: 'tsk-stable',
    taskStart: true,
    taskSource: 'task-board',
    taskText: '完整正文\n<script>alert(1)</script>',
  });
  assert.deepEqual(request.task, {
    id: 'tsk-stable',
    start: true,
    source: 'task-board',
    text: '完整正文\n<script>alert(1)</script>',
  });
  const routed = normalizeTurnRequest({
    sessionId: 'worker-1',
    text: 'tool-routed task',
    taskId: 'tsk-router',
    taskStart: true,
    taskSource: 'router-tool',
    taskText: 'tool-routed task',
  });
  assert.equal(routed.task.source, 'router-tool');
  const legacyCommanderRoute = normalizeTurnRequest({
    sessionId: 'worker-1',
    text: 'legacy Commander marker task',
    taskId: 'tsk-legacy-router',
    taskStart: true,
    taskSource: 'commander-route',
    taskText: 'legacy Commander marker task',
  });
  assert.equal(legacyCommanderRoute.task.source, 'commander',
    'persisted pre-1.2 Commander outbox items remain deliverable after restart');
  assert.throws(() => normalizeTurnRequest({
    sessionId: 'worker-1', text: 'x', taskStart: true, taskId: 'tsk-x',
  }), /trusted task source/);
  assert.throws(() => normalizeTurnRequest({
    sessionId: 'worker-1', text: 'x', taskText: 'body',
  }), /only valid on a task start/);
  const ordinary = normalizeTurnRequest({ sessionId: 'worker-1', text: '普通聊天' });
  assert.deepEqual(ordinary.task, { id: null, start: false, source: null, text: '' });
});

test('Claude host pre-allocation proof preserves legacy resume intent for existing history', () => {
  const turn = request({ cli: 'claude', turnCount: 3, hasNativeSession: true });
  assert.equal(turn.execution.isFirstTurn, false);
  assert.equal(turn.execution.resume, true);
  assert.equal(turn.execution.historyIntent, 'resume');
});

test('duplicate delivery wins and a fresh busy runner rejects without interruption effects', () => {
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
  assert.equal(fresh.decision, 'reject');
  assert.equal(fresh.reason, 'session-busy');
  assert.deepEqual(fresh.effects, []);
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

test('preparation lease settles after runner handoff and releases every failure phase', () => {
  const store = createTurnRuntimeStore({ now: () => 77 });
  assert.equal(store.claim('s1', 'failed-before-spawn').ok, true);
  const failed = store.settle('s1', 'failed-before-spawn', {
    status: 'failed', reason: 'message-not-durable',
  });
  assert.equal(failed.ok, true);
  assert.equal(failed.state.phase, 'idle');
  assert.deepEqual(failed.state.lastOutcome, {
    turnId: 'failed-before-spawn', status: 'failed', reason: 'message-not-durable', at: 77,
  });

  assert.equal(store.claim('s1', 'delegated', { cli: 'codex', transport: 'cli-process' }).ok, true);
  store.markMessageDurable('s1', 'delegated');
  store.markProviderRouteResolved('s1', 'delegated', { resolved: true });
  assert.equal(store.start('s1', 'delegated').ok, true);
  const delegated = store.settle('s1', 'delegated', {
    status: 'delegated', reason: 'cli-process',
  });
  assert.equal(delegated.ok, true);
  assert.equal(delegated.state.phase, 'idle');
  assert.equal(store.claim('s1', 'next-turn').ok, true,
    'the preparation lease must not replace the established runner lifecycle');
});

test('production cutover keeps duplicate, proof and runner ordering explicit', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const start = source.indexOf('function runChatTurn(sessionName, text, opts = {})');
  const end = source.indexOf("bus.on('chat:run'", start);
  assert.ok(start >= 0 && end > start, 'runChatTurn host boundary must exist');
  const body = source.slice(start, end);
  const at = (needle) => {
    const index = body.indexOf(needle);
    assert.ok(index >= 0, `production turn boundary must include ${needle}`);
    return index;
  };

  const normalized = at('normalizeTurnRequest({');
  const futureClaudeProof = at('const willAllocateClaudeNativeSession =');
  const admission = at('planTurnAdmission(turnRequest');
  const duplicateReturn = at("admission.decision === 'duplicate'");
  const nativeAllocation = at('persisted.cliSessionId = crypto.randomUUID()');
  const claim = at('chatTurnPreparationRuntime.claim(');
  const append = at('const userMessageSaved = appendChatMessage(');
  const durable = at('createDurableMessageProof(turnRequest');
  const route = at('providerRouterRuntime.resolveSpawnEnv(persisted)');
  const guard = at('evaluateSpawnGuard(turnRequest');
  const authorize = at('chatTurnPreparationRuntime.start(');
  const claudeRunner = at('runChatTurnStreaming(sessionName');
  const codexRunner = at('cs.claudeProc = spawnChat(args, false)');
  const failureRelease = at('if (preparationOpen)');

  assert.ok(futureClaudeProof < normalized && normalized < admission);
  assert.ok(admission < duplicateReturn && duplicateReturn < nativeAllocation,
    'duplicate delivery must not allocate or mutate a native session');
  assert.ok(duplicateReturn < claim);
  assert.doesNotMatch(body, /New user_message while claude pid=|interrupting previous/,
    'the canonical turn boundary must reject busy races instead of interrupting an active turn');
  assert.ok(claim < append && append < durable && durable < route);
  assert.ok(route < guard && guard < authorize);
  assert.ok(authorize < claudeRunner && authorize < codexRunner);
  assert.ok(codexRunner < failureRelease, 'finally must release a failed preparation lease');
});

test('retry policy bounds API failures and keeps deterministic scheduling', () => {
  const deps = { now: () => 1_000, random: () => 0 };
  const api = decideRetry({
    event: 'api-error',
    error: { httpStatus: 503, source: 'claude_result', provider: 'claude' },
    context: { source: 'claude_result', provider: 'claude', phase: 'before_first_token' },
    attempts: { apiError: 0 },
  }, deps);
  assert.equal(api.action, 'retry-api');
  assert.equal(api.attempt, 1);
  assert.equal(api.delayMs, 1000);
  assert.equal(api.capped, true);
  const exhausted = decideRetry({
    event: 'api-error',
    error: { httpStatus: 503, source: 'claude_result', provider: 'claude' },
    context: { source: 'claude_result', provider: 'claude', phase: 'before_first_token' },
    attempts: { apiError: 2 },
  }, deps);
  assert.equal(exhausted.action, 'fail');
  assert.equal(exhausted.reason, 'retry_budget_exhausted');
  const interrupted = decideRetry({ event: 'interrupted', attempts: { interruptedResume: 9 } }, { now: () => 0 });
  assert.equal(interrupted.action, 'resume');
  assert.equal(interrupted.attempt, 10);
  assert.equal(decideRetry({ event: 'interrupted', attempts: { interruptedResume: 10 } }).reason, 'resume-cap-reached');
  assert.equal(decideRetry({ event: 'interrupted', userStopped: true }).reason, 'user-stopped');
  assert.equal(decideRetry({ event: 'interrupted', killReason: 'shutdown' }).reason, 'explicit-lifecycle-stop');
  assert.equal(decideRetry({ event: 'interrupted', killReason: 'session_delete' }).action, 'fail');
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

test('typed Commander cannot fan out through assistant markers', () => {
  // A Commander-originated turn now goes through the marker scanner so its
  // <<route>> markers get executed one-way. It carries no originDispatchId, so
  // there is no result 回流 (that branch returned above for dispatched workers).
  const direct = routePostTurn({
    turnId: 'commander-direct', sessionId: 'commander-1', sessionType: 'commander',
    finalText: '<<route target="worker-1">do the work</route>>',
  });
  assert.equal(direct.route, 'commander');
  assert.deepEqual(direct.effects.map(effect => effect.type), ['inspect-dispatch-markers']);
  assert.equal(direct.effects[0].effectId, 'commander-turn:commander-direct');
  assert.equal(direct.effects[0].requiresDeliveryProof, false);
  const directRepeated = routePostTurn({
    turnId: 'commander-direct', sessionId: 'commander-1', sessionType: 'commander',
    finalText: 'same', receipts: ['commander-turn:commander-direct'],
  });
  assert.deepEqual(directRepeated.effects, []);

  const first = routePostTurn({
    turnId: 'commander-turn', sessionId: 'commander-1', sessionType: 'commander',
    originDispatchId: 'taskboard-dispatch-1',
    finalText: '<<dispatch target="worker-1">do the work</dispatch>>',
  });
  assert.equal(first.route, 'dispatch-return');
  assert.deepEqual(first.effects.map(effect => effect.type), ['complete-dispatch']);
  assert.equal(first.effects[0].effectId, 'dispatch-return:taskboard-dispatch-1');

  const repeated = routePostTurn({
    turnId: 'commander-turn', sessionId: 'commander-1', sessionType: 'commander',
    originDispatchId: 'taskboard-dispatch-1', finalText: 'same',
    receipts: ['dispatch-return:taskboard-dispatch-1'],
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

test('assistant append failure never becomes durable and suppresses every post-turn effect', () => {
  const normalized = request({ originDispatchId: 'dispatch-1', originContinue: true });
  const turn = createTurnLifecycle(normalized, { turnId: 'turn-1' });
  const runner = createRunnerOwnership(turn, { runnerId: 'proc-1' });
  const cs = { _activeTurn: turn, _activeRunner: runner };
  const append = () => false; // fault injection: disk append failed
  const persisted = append({ role: 'assistant', content: 'done' });
  const proof = recordResultEvent(turn, runner, {
    current: ownsCurrentRunner(cs._activeTurn, cs._activeRunner, turn, runner),
    persisted,
  });
  assert.equal(proof.ok, false);
  assert.equal(proof.resultDurable, false);
  assert.equal(turn.resultDurable, false);
  assert.equal(evaluatePostTurn(turn, runner, {
    currentTurn: cs._activeTurn, currentRunner: cs._activeRunner,
  }).code, 'result_not_durable');
  assert.deepEqual(turn.lineage, { kind: 'dispatch', operationId: 'dispatch-1' },
    'failed persistence must retain dispatch lineage for recovery');
});

test('superseded and cancelled runners own their kill reason and cannot contaminate a new turn', () => {
  const first = createTurnLifecycle(request(), { turnId: 'turn-old' });
  const oldRunner = createRunnerOwnership(first, { runnerId: 'proc-old' });
  assignKillReason(oldRunner, 'new_user_message');

  const next = createTurnLifecycle(request(), { turnId: 'turn-new' });
  const newRunner = createRunnerOwnership(next, { runnerId: 'proc-new' });
  const cs = { _activeTurn: next, _activeRunner: newRunner };
  assert.equal(recordResultEvent(first, oldRunner, {
    current: ownsCurrentRunner(cs._activeTurn, cs._activeRunner, first, oldRunner),
    persisted: true,
  }).code, 'stale_runner');
  assert.equal(claimPostTurn(first, oldRunner, {
    currentTurn: cs._activeTurn, currentRunner: cs._activeRunner,
  }).code, 'stale_runner');
  assert.equal(newRunner.killReason, null);

  assignKillReason(newRunner, 'user_cancel');
  const afterCancel = createTurnLifecycle(request(), { turnId: 'turn-after-cancel' });
  const afterCancelRunner = createRunnerOwnership(afterCancel, { runnerId: 'proc-after-cancel' });
  cs._activeTurn = afterCancel;
  cs._activeRunner = afterCancelRunner;
  assert.equal(afterCancelRunner.killReason, null);
  assert.equal(evaluatePostTurn(next, newRunner, {
    currentTurn: cs._activeTurn, currentRunner: cs._activeRunner,
  }).code, 'stale_runner');
});

test('API error and planned retry suppress post-turn while preserving dispatch/trigger lineage', () => {
  for (const lineage of [
    { originDispatchId: 'dispatch-9' },
    { originTrigger: true },
  ]) {
    const normalized = request({ ...lineage, originContinue: true });
    const turn = createTurnLifecycle(normalized, { turnId: `turn-${normalized.origin.kind}` });
    const runner = createRunnerOwnership(turn, { runnerId: `runner-${normalized.origin.kind}` });
    const current = { _activeTurn: turn, _activeRunner: runner };
    recordResultEvent(turn, runner, { current: true, persisted: true });
    assert.equal(evaluatePostTurn(turn, runner, {
      currentTurn: current._activeTurn, currentRunner: current._activeRunner, apiError: true,
    }).code, 'api_error_retry_pending');
    runner.retryPlanned = true;
    assert.equal(evaluatePostTurn(turn, runner, {
      currentTurn: current._activeTurn, currentRunner: current._activeRunner,
    }).code, 'retry_pending');
    assert.equal(turn.lineage.kind, normalized.origin.kind);
    assert.equal(turn.launchReason, 'continue');
  }
});

test('only one current durable final result can claim dispatch return', () => {
  const normalized = request({ originDispatchId: 'dispatch-once' });
  const turn = createTurnLifecycle(normalized, { turnId: 'turn-once' });
  const runner = createRunnerOwnership(turn, { runnerId: 'runner-once' });
  const facts = { currentTurn: turn, currentRunner: runner };
  assert.equal(recordCloseResult(turn, runner, { current: true, persisted: true, final: false }).code,
    'not_final_result');
  assert.equal(turn.resultDurable, false, 'partial close persistence is not a final-result proof');
  assert.equal(recordCloseResult(turn, runner, { current: true, persisted: true, final: true }).ok, true);
  let returns = 0;
  if (claimPostTurn(turn, runner, facts).ok) returns++;
  if (claimPostTurn(turn, runner, facts).ok) returns++;
  assert.equal(returns, 1);
  assert.equal(turn.postTurnClaimed, true);
});

test('usage is recorded once when close persistence recovers an initial result append failure', () => {
  const turn = createTurnLifecycle(request(), { turnId: 'turn-usage' });
  const runner = createRunnerOwnership(turn, { runnerId: 'runner-usage' });
  recordResultEvent(turn, runner, { current: true, persisted: false });
  assert.equal(claimDurableUsage(runner, { resultDurable: turn.resultDurable }).code,
    'result_not_durable');
  recordCloseResult(turn, runner, { current: true, persisted: true, final: true });
  let usageWrites = 0;
  if (claimDurableUsage(runner, { resultDurable: turn.resultDurable }).ok) usageWrites++;
  if (claimDurableUsage(runner, { resultDurable: turn.resultDurable }).ok) usageWrites++;
  assert.equal(usageWrites, 1);
  assert.equal(runner.usageRecorded, true);
});

test('failed authoritative usage write leaves the once claim open for a synchronous retry', () => {
  const turn = createTurnLifecycle(request(), { turnId: 'turn-usage-write' });
  const runner = createRunnerOwnership(turn, { runnerId: 'runner-usage-write' });
  recordCloseResult(turn, runner, { current: true, persisted: true, final: true });
  const writeResults = [false, true];
  let writes = 0;
  const record = () => {
    if (runner.usageRecorded) return false;
    const written = writeResults[writes++];
    if (!written) return false;
    return claimDurableUsage(runner, { resultDurable: turn.resultDurable }).ok;
  };
  assert.equal(record(), false);
  assert.equal(runner.usageRecorded, undefined, 'failed disk write must not burn the once claim');
  assert.equal(record(), true);
  assert.equal(runner.usageRecorded, true);
  assert.equal(record(), false);
  assert.equal(writes, 2, 'already-recorded usage must not write a third time');
});

test('result event is runner-owned and cannot promote a retry runner partial to final', () => {
  const turn = createTurnLifecycle(request({ cli: 'codex' }), { turnId: 'turn-retry-owner' });
  const first = createRunnerOwnership(turn, { runnerId: 'runner-first' });
  recordResultEvent(turn, first, { current: true, persisted: false });
  assert.equal(first.resultEvent, true);
  assert.equal(turn.resultDurable, false);

  const retry = createRunnerOwnership(turn, { runnerId: 'runner-retry' });
  assert.equal(retry.resultEvent, false, 'runner-local result evidence must not cross retry attempts');
  const partial = recordCloseResult(turn, retry, { current: true, persisted: true, final: retry.resultEvent });
  assert.equal(partial.code, 'not_final_result');
  assert.equal(turn.resultDurable, false);
  assert.equal(turn.resultRunnerId, null);
});

test('shutdown partial checkpoint is durable but never a final result proof', () => {
  const turn = createTurnLifecycle(request(), { turnId: 'turn-checkpoint' });
  const runner = createRunnerOwnership(turn, { runnerId: 'runner-checkpoint' });
  const checkpoint = recordPartialCheckpoint(turn, runner, {
    current: true, persisted: true, checkpointKey: 'sha256-partial-v1',
  });
  assert.equal(checkpoint.ok, true);
  assert.equal(hasMatchingPartialCheckpoint(runner, 'sha256-partial-v1'), true);
  assert.equal(hasMatchingPartialCheckpoint(runner, 'sha256-new-output'), false);
  assert.equal(turn.resultDurable, false);
  assert.equal(evaluatePostTurn(turn, runner, {
    currentTurn: turn, currentRunner: runner,
  }).code, 'result_not_durable');
});

test('production lifecycle uses append return, runner ownership and one guarded post-turn boundary', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.equal(source.includes('cs._killReason'), false, 'kill reason must not be session-global');
  assert.doesNotMatch(source, /function (?:persistFinalAssistantResult|recordDurableTurnUsage|runDurablePostTurn)\(/,
    'host lifecycle composition must live outside the God file');
  assert.match(source, /createChatHostRuntime\(\{/,
    'server must consume the extracted host runtime through narrow ports');
  const finalizeHostSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'chat', 'finalize-host.js'), 'utf8');
  assert.match(finalizeHostSource, /context\.appendPersisted = ports\.persistAssistant\(context, plan\.append\) === true/,
    'the shared finalize executor must use the real append return value');
  assert.match(source, /persistAssistant\(context, append\) \{[\s\S]{0,120}persistFinalAssistantResult\(/,
    'server composition must inject the authoritative assistant writer');
  assert.match(source, /const resultDurable = persistFinalAssistantResult\(/);
  assert.match(source, /if \(saved\) \{[\s\S]{0,500}cs\._resultSaved = true;/);
  assert.match(source, /runPostTurn\(context, entry\) \{[\s\S]{0,160}runDurablePostTurn\(/);
  assert.match(source, /isCurrentTurnRunner\(cs, turn, runner\)/);
  assert.equal((source.match(/runnerHandedOff = true;/g) || []).length, 2,
    'both streaming and process runners must be marked handed off before lease release');
  const catchAt = source.indexOf('if (runnerHandedOff) {', source.indexOf('function runChatTurn('));
  const falsePreparationErrorAt = source.indexOf('turn preparation failed before runner handoff', catchAt);
  assert.ok(catchAt >= 0 && falsePreparationErrorAt > catchAt,
    'a handed-off runner must bypass the pre-runner failure response');
  assert.equal((finalizeHostSource.match(/回复已生成但未能持久化，已停止回流和后续动作。/g) || []).length, 1,
    'stream and process finalizers must share one durable-result failure effect');
  assert.equal(source.includes('turn.resultEvent'), false, 'result events must be runner-owned');
  assert.equal((source.match(/sameDurablePartial: hasMatchingPartialCheckpoint\(runner,/g) || []).length, 2,
    'both runner paths must pass checkpoint evidence into the shared planner');
  assert.equal((source.match(/planTurnFinalization\(\{/g) || []).length, 2,
    'process and stream paths must both use the pure finalization plan');
  assert.equal((source.match(/turnFinalizationExecutor\.execute\((?:finalizePlan|plan),/g) || []).length, 2,
    'process and stream paths must both use the shared host effect executor');
  assert.match(source, /createChatHostRuntime\(\{[\s\S]{0,500}persistUsage: accumulateTokenUsage/,
    'production host must inject the authoritative usage writer into the coordinator');
  const hostSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'chat', 'host-coordinator.js'), 'utf8');
  const usageStart = hostSource.indexOf('function commitUsage(');
  const usageEnd = hostSource.indexOf('\n  function finalize(', usageStart);
  const usageBody = hostSource.slice(usageStart, usageEnd);
  assert.ok(usageBody.indexOf('ports.usage.commit(') < usageBody.indexOf('claimDurableUsage(runner'),
    'main token usage must commit before the in-memory once claim');
  const tokenSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'token-usage.js'), 'utf8');
  const accumulateStart = tokenSource.indexOf('function accumulateTokenUsage(');
  const accumulateEnd = tokenSource.indexOf('\n  function seedTokenUsageFromHistory(', accumulateStart);
  const accumulateBody = tokenSource.slice(accumulateStart, accumulateEnd);
  assert.ok(accumulateBody.indexOf('deps.atomicWriteJson(deps.tokenUsageFile, data)')
    < accumulateBody.indexOf('accumulateTokenDaily(sessionId, usage)'),
  'daily aggregation must derive only after the main usage file commits');
  assert.match(accumulateBody,
    /catch \(error\) \{[\s\S]{0,120}logFailure\('token_usage_write_failed', error\);[\s\S]{0,80}return false;/,
    'a failed cumulative write must release the durable usage claim for retry');
  const finalizeSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'chat', 'finalize-plan.js'), 'utf8');
  assert.match(finalizeSource, /if \(!facts\.killReason\) \{[\s\S]{0,180}freeze-interrupted/,
    'unknown interruptions must freeze until an explicit user decision');
  assert.match(finalizeSource, /if \(durableAfterAppend\) \{[\s\S]{0,220}classify-turn-end/,
    'clean streaming completion must still classify immediately');
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
  assert.equal(routePostTurn({ turnId: 't3c', sessionId: 'c', sessionType: 'commander' }).route, 'commander');
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

  for (const file of [
    'turn-request.js', 'retry-policy.js', 'post-turn-router.js',
    'runtime-store.js', 'turn-lifecycle.js', 'finalize-plan.js',
    'finalize-host.js', 'ports.js',
  ]) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'chat', file), 'utf8');
    assert.equal(/require\(['"](?:fs|child_process|express|ws)['"]\)/.test(source), false, `${file} must stay pure`);
  }
});
