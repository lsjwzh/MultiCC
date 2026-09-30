'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { fixture } = require('./helpers/task-shell');
const { createRouterToolRuntime } = require('../src/router-tool-runtime');
const { createGatewayHost } = require('../src/dispatch/gateway-host');
const { createTaskContextHost } = require('../src/task-context-host');
const { createOrchestrationRuntime } = require('../src/orchestration/runtime');

function integrated(t) {
  let gateway;
  const f = fixture(t, {
    unifiedAdmission: true, taskFirst: true,
    getDirectory: id => id === 'd1' ? { id } : null,
    createExecution: async (task, config) => {
      f.creations.push(task);
      f.records.set(task.sessionId, { ...config, id: task.sessionId, kind: 'chat', dirId: task.dirId, taskBoundTaskId: task.id });
      return { ok: true };
    },
    dispatch: (...args) => gateway.dispatchToSession(...args),
  });
  const persisted = new Set(), turns = [];
  let busy = false;
  const orchestration = createOrchestrationRuntime({
    file: path.join(path.dirname(f.file), 'operations.json'),
    isBusy: () => busy,
    runChatTurn: (id, text, options) => {
      const guard = f.runtime.guardAdmission(id, text, options);
      assert.equal(guard, null, 'real delivery must satisfy the unchanged shell guard');
      turns.push({ id, text, options }); persisted.add(options.deliveryId); return true;
    },
    hasPersistedDelivery: (_id, deliveryId) => persisted.has(deliveryId),
  });
  const context = createTaskContextHost({
    getTaskShells: () => ({ ...f.runtime, accepts: () => true }),
    getState: () => null, append: () => true, emitClients() {},
    getTaskBoard: () => ({}), containsDelivery: () => false, classifyDisplay() {},
    randomUUID: () => 'test-id', getRecord: id => f.records.get(id), runTurn() {},
  });
  gateway = createGatewayHost({
    persistedSessions: f.records, chatSessions: new Map(), directories: new Map([['d1', { id: 'd1' }]]),
    logger: { warn() {} }, appendEvent() {}, getSessionDelivery: () => ({}),
    normalizeEffort: value => value, dispatchTargetHintFor: () => '', cwdForSession: () => '/tmp',
    getSetSessionStatus: () => () => {}, isTargetBusy: () => busy,
    getOrchestrationRuntime: () => orchestration, getTaskContextHost: () => context,
    getCreateSessionRecord: () => () => { throw new Error('must use canonical createTask'); },
    appendChatMessage() {}, chatBroadcast() {},
  });
  const router = createRouterToolRuntime({ records: f.records,
    recordUserInput: () => ({ ok: true }),
    registerExternalWait: () => {}, getExternalWait: () => {},
    listExternalWaits: () => [], cancelExternalWait: () => {},
    dispatchToSession: (...args) => gateway.dispatchToSession(...args),
    createTask: input => f.runtime.createStandalone(input),
    operations: orchestration.operations,
    completeDispatch: (...args) => orchestration.operations.completeDispatch(...args),
    // Production polling timers are unref'ed because the server owns the
    // process lifecycle. This isolated fixture has no server handle, so keep
    // its awaited timer referenced and make cancellation unwrap it.
    setTimeoutFn: (callback, delay) => ({ timer: setTimeout(callback, delay) }),
    clearTimeoutFn: handle => clearTimeout(handle.timer),
  });
  const call = (args, turn = 'turn-1', tool = 'dispatch_master') => router.execute(
    router.issueContext({ sessionId: 'a', turnId: turn }), tool, args);
  return { ...f, router, orchestration, gateway, turns, call, restartShell: () => { f.runtime = require('../src/task-shell/runtime').createTaskShellRuntime(f.ports); }, setBusy: value => { busy = value; } };
}

test('new_task creates one canonical task/session and delivers a valid receipt through the real outbox', async t => {
  const f = integrated(t);
  const args = { new_task: { title: 'review plan', cli: 'codex', model: 'gpt-6-astra', effort: 'high' },
    message: 'Review the design.', idempotency_key: 'review-1', mode: 'async' };
  const result = await f.call(args);
  assert.equal(result.ok, true);
  assert.match(result.task_id, /^tsk_[a-f0-9]{32}$/);
  assert.equal(f.store.list('task').length, 1);
  assert.equal(f.creations.length, 1);
  assert.equal(f.turns.length, 1);
  assert.equal(f.turns[0].options.taskId, result.task_id);
  assert.equal(f.turns[0].options.originContinue, false, 'a real receipt passes without a continuation bypass');
  assert.equal(f.turns[0].options.clientMsgId, f.turns[0].options.taskShellReceiptId);
  assert.equal(f.records.get(result.execution_session_id).model, 'gpt-6-astra');
  assert.match(f.turns[0].text, new RegExp(result.operation_id));
  const retry = await f.call(args, 'turn-2');
  assert.equal(retry.duplicate, true);
  assert.equal(retry.operation_id, result.operation_id, 'async receipt address survives a new caller turn');
  assert.equal(f.turns.length, 1);
  assert.equal(f.store.list('task').length, 1);
  await assert.rejects(f.call({ ...args, message: 'different content' }), { code: 'idempotency_conflict' });
  await assert.rejects(f.call({ ...args, new_task: { title: 'different title' } }), { code: 'idempotency_conflict' });
});

test('existing bound target keeps its identity and rejects foreign identities before operation admission', async t => {
  const f = integrated(t);
  const target = await f.runtime.createStandalone({ dirId: 'd1', title: 'existing review', cli: 'codex', clientMsgId: 'existing' });
  f.setBusy(true);
  const result = await f.call({ target_session_id: target.sessionId, message: 'Review details', mode: 'async', idempotency_key: 'existing-dispatch' });
  assert.equal(result.task_id, target.taskId);
  assert.equal(result.execution_session_id, target.sessionId);
  assert.equal(result.queue_state, 'queued');
  assert.equal(f.store.list('task').length, 1);
  assert.equal(f.turns.length, 0);
  await assert.rejects(f.gateway.dispatchToSession(target.sessionId, 'bad', {
    ownerSessionId: 'a', oneWay: true, taskId: 'tsk-router-old', idempotencyKey: 'bad',
  }), { code: 'task_identity_mismatch' });
  assert.equal((await f.orchestration.operations.list({ kind: 'dispatch' })).length, 1);
  f.setBusy(false);
  await f.orchestration.tick();
  assert.equal(f.turns.length, 1);
  const retry = await f.call({ target_session_id: target.sessionId, message: 'Review details', mode: 'async', idempotency_key: 'existing-dispatch' }, 'another-turn');
  assert.equal(retry.queue_state, 'started', 'duplicate gets live queue status, not the cached queued hint');
  assert.equal(f.turns.length, 1);
});

test('new_task rejects ambiguous targets and invalid configuration without creating a task', async t => {
  const f = integrated(t);
  for (const args of [
    { target_session_id: 'b', new_task: { title: 'x' } },
    {}, { new_task: { title: 'x', dirId: 'd2' } },
    { new_task: { title: 'x' }, allow_terminal: true },
    { new_task: { title: 'x' }, timeout_seconds: 1 },
  ]) {
    await assert.rejects(f.call({ message: 'work', mode: 'async', ...args }), { code: 'invalid_arguments' });
  }
  assert.equal(f.store.list('task').length, 0);
});

test('large MCP messages keep their dispatch allowance without widening user message limits', async t => {
  const f = integrated(t);
  const result = await f.call({ target_session_id: 'b', message: 'x'.repeat(40000), mode: 'async' });
  assert.equal(result.ok, true);
  assert.equal(f.turns.length, 1);
  const receipt = f.store.list('receipt')[0];
  const replay = await f.runtime.retry(receipt.shellId, receipt.id);
  assert.equal(replay.duplicate, true, 'receipt retry preserves internal dispatch metadata and length allowance');
  assert.equal(f.turns.length, 1);
  await assert.rejects(f.runtime.send(f.b.id, { clientMsgId: 'public', text: 'x'.repeat(40000) }), { code: 'invalid_text' });
});

test('lost acknowledgment replays the same operation after shell reconstruction', async t => {
  const f = integrated(t);
  const realDispatch = f.ports.dispatch;
  let loseAcknowledgment = true;
  f.ports.dispatch = async (...args) => {
    const result = await realDispatch(...args);
    if (loseAcknowledgment) { loseAcknowledgment = false; throw new Error('simulated lost acknowledgment'); }
    return result;
  };
  const args = { new_task: { title: 'recoverable review' }, message: 'review once', idempotency_key: 'lost-ack' };
  await assert.rejects(f.call(args, 'turn-1', 'route_task'), /simulated lost acknowledgment/);
  assert.equal(f.turns.length, 1);
  const [original] = await f.orchestration.operations.list({ kind: 'dispatch' });
  f.restartShell();
  const retry = await f.call(args, 'turn-2', 'route_task');
  assert.equal(retry.duplicate, true);
  assert.equal(retry.operation_id, original.id);
  assert.equal(f.turns.length, 1);
  assert.equal(f.store.list('task').length, 1);
});

test('explicit retry keys cannot be silently reused for a different target', async t => {
  const f = integrated(t);
  f.records.set('c', { id: 'c', dirId: 'd1', kind: 'chat' });
  f.setBusy(true);
  const args = { target_session_id: 'b', message: 'review', idempotency_key: 'same-owner-key', mode: 'async' };
  await f.call(args);
  await assert.rejects(f.call({ ...args, target_session_id: 'c' }), { code: 'OPERATION_CONFLICT', statusCode: 409 });
  assert.equal((await f.orchestration.operations.list({ kind: 'dispatch' })).length, 1);
});

test('sync dispatch attaches to canonical task and returns the completed result inline', async t => {
  const f = integrated(t);
  let completed;
  const pending = f.call({ new_task: { title: 'sync review' }, message: 'review now', mode: 'sync', timeout_seconds: 5 });
  for (let i = 0; i < 100 && !f.turns.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  const [operation] = await f.orchestration.operations.list({ kind: 'dispatch' });
  assert.ok(operation);
  await f.orchestration.operations.completeDispatch(operation.id, { status: 'completed', text: 'review complete' });
  completed = await pending;
  assert.equal(completed.ok, true);
  assert.equal(completed.status, 'completed');
  assert.equal(f.turns.length, 1);
  assert.equal(f.store.list('task').length, 1);
});
