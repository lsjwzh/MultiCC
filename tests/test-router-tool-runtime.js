'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { createOperationService } = require('../src/operation-service');
const { createOrchestrationStore } = require('../src/orchestration-store');
const { createRouterToolRuntime } = require('../src/router-tool-runtime');

function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-router-tool-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createOrchestrationStore({ file: path.join(dir, 'orchestration.json') });
  let sequence = 0;
  const operations = createOperationService({
    store,
    idFactory: () => `op_router_${++sequence}`,
  });
  const records = new Map([
    ['caller', { id: 'caller', dirId: 'dir-a', kind: 'chat', type: 'worker' }],
    ['worker-a', { id: 'worker-a', dirId: 'dir-a', kind: 'chat', type: 'worker' }],
    ['worker-b', { id: 'worker-b', dirId: 'dir-b', kind: 'chat', type: 'worker' }],
    ['terminal-a', { id: 'terminal-a', dirId: 'dir-a', kind: 'terminal', type: null }],
    ['terminal-a-gw-chat', {
      id: 'terminal-a-gw-chat', dirId: 'dir-a', kind: 'chat',
      type: null, ephemeral: true, gatewayFor: 'terminal-a',
    }],
    ['commander', { id: 'commander', dirId: 'dir-a', kind: 'chat', type: 'commander' }],
    ['aux', { id: 'aux', dirId: 'dir-a', kind: 'chat', type: 'aux' }],
  ]);
  const admissions = [];
  const userInputSignals = [];
  const dispatchToSession = async (targetId, message, opts) => {
    admissions.push({ targetId, message, opts });
    const admitted = await operations.admitDispatch({
      ownerSessionId: opts.ownerSessionId,
      resultSessionId: opts.ownerSessionId,
      idempotencyKey: opts.idempotencyKey,
      spec: {
        targetId,
        targetLabel: targetId,
        chatId: targetId,
        message,
        replyTo: opts.replyTo || null,
        gateway: false,
        oneWay: opts.oneWay,
        resultMode: opts.resultMode,
        taskId: opts.taskId,
        taskStart: opts.taskStart,
        taskSource: opts.taskSource,
        taskText: opts.taskText || null,
      },
    });
    return {
      ok: true,
      operationId: admitted.id,
      status: admitted.status,
      duplicate: admitted.idempotent,
      chatId: targetId,
    };
  };
  const runtime = createRouterToolRuntime({
    records,
    dispatchToSession,
    operations,
    completeDispatch: (id, result) => operations.completeDispatch(id, result),
    recordUserInput: async signal => {
      const duplicate = userInputSignals.some(existing => existing.requestId === signal.requestId);
      if (!duplicate) userInputSignals.push(signal);
      return { ok: true, duplicate };
    },
    pollIntervalMs: 2,
    ...overrides,
  });
  return {
    admissions, dispatchToSession, operations, records, runtime, store,
    userInputSignals,
  };
}

async function nextTurn() {
  await new Promise(resolve => setImmediate(resolve));
}

test('preferred wait_for_user_answer and its legacy alias share one idempotent signal', async t => {
  const { runtime, userInputSignals } = fixture(t);
  const capability = runtime.issueContext({ sessionId: 'caller', turnId: 'turn-question' });
  const args = {
    question: '选择发布环境',
    reason: '两个环境的发布风险不同',
    options: ['测试环境', '生产环境'],
  };
  const first = await runtime.execute(capability, 'wait_for_user_answer', args);
  const duplicate = await runtime.execute(capability, 'request_user_input', args);
  assert.equal(first.status, 'waiting_reply_signal_recorded');
  assert.equal(first.request_id, duplicate.request_id);
  assert.equal(duplicate.duplicate, true);
  assert.equal(userInputSignals.length, 1);
  assert.deepEqual(userInputSignals[0].options, args.options);
  assert.equal(userInputSignals[0].turnId, 'turn-question');
});

test('request_user_input validates bounded choices without dispatching work', async t => {
  const { admissions, runtime } = fixture(t);
  const capability = runtime.issueContext({ sessionId: 'caller', turnId: 'turn-invalid-question' });
  await assert.rejects(
    runtime.execute(capability, 'request_user_input', {
      question: '请选择',
      options: ['唯一选项'],
      allow_multiple: true,
    }),
    error => error.code === 'invalid_arguments',
  );
  assert.equal(admissions.length, 0);
});

test('route_task durably admits one-way work and is turn-idempotent', async t => {
  const { admissions, operations, runtime } = fixture(t);
  const capability = runtime.issueContext({ sessionId: 'caller', turnId: 'turn-1' });
  const first = await runtime.execute(capability, 'route_task', {
    target_session_id: 'worker-a',
    message: 'inspect the module',
  });
  const duplicate = await runtime.execute(capability, 'route_task', {
    target_session_id: 'worker-a',
    message: 'inspect the module',
  });
  assert.equal(first.ok, true);
  assert.equal(first.operation_id, duplicate.operation_id);
  assert.equal(duplicate.duplicate, true);
  assert.equal(admissions[0].opts.oneWay, true);
  assert.equal(admissions[0].opts.replyTo, null);
  assert.equal(admissions[0].opts.taskSource, 'router-tool');
  const operation = await operations.get(first.operation_id);
  assert.equal(operation.spec.resultMode, 'none');
  assert.equal(operation.spec.taskId, first.task_id);
});

test('route_task preserves an inherited logical task across follow-up turns', async t => {
  let active = {
    turnId: 'turn-task-start',
    taskId: 'tsk-canonical-upstream',
    taskStart: true,
    taskSource: 'task-board',
  };
  const { admissions, operations, runtime } = fixture(t, {
    resolveContext: () => active,
  });
  const capability = runtime.issueContext({ sessionId: 'caller', dynamic: true });
  const first = await runtime.execute(capability, 'route_task', {
    target_session_id: 'worker-a',
    message: 'initial work',
  });
  active = {
    turnId: 'turn-task-followup',
    taskId: 'tsk-canonical-upstream',
    taskStart: false,
    taskSource: 'task-board',
  };
  const followup = await runtime.execute(capability, 'route_task', {
    target_session_id: 'worker-a',
    message: 'follow-up details',
  });
  assert.equal(first.task_id, 'tsk-canonical-upstream');
  assert.equal(followup.task_id, first.task_id);
  assert.notEqual(followup.operation_id, first.operation_id);
  assert.equal(admissions.length, 2);
  assert.deepEqual(admissions.map(item => item.opts.taskStart), [true, false]);
  assert.deepEqual(admissions.map(item => item.opts.taskSource), ['task-board', 'task-board']);
  assert.equal((await operations.list({ kind: 'dispatch' })).length, 2);
});

test('explicit idempotency survives a fresh turn without creating a second logical task', async t => {
  const { admissions, operations, runtime } = fixture(t);
  const args = {
    target_session_id: 'worker-a',
    message: 'idempotent work',
    idempotency_key: 'delivery-stable-1',
  };
  const first = await runtime.execute(
    runtime.issueContext({ sessionId: 'caller', turnId: 'turn-retry-1' }),
    'route_task',
    args,
  );
  const replay = await runtime.execute(
    runtime.issueContext({ sessionId: 'caller', turnId: 'turn-retry-2' }),
    'route_task',
    args,
  );
  assert.equal(replay.task_id, first.task_id);
  assert.equal(replay.operation_id, first.operation_id);
  assert.equal(replay.duplicate, true);
  assert.equal((await operations.list({ kind: 'dispatch' })).length, 1);
  assert.equal(admissions.length, 2, 'both HTTP/tool attempts reach the canonical idempotent admission');
});

test('dispatch_master waits for the durable slave result without a result outbox', async t => {
  const { admissions, operations, runtime, store } = fixture(t);
  const masterCapability = runtime.issueContext({ sessionId: 'caller', turnId: 'turn-master' });
  const pending = runtime.execute(masterCapability, 'dispatch_master', {
    target_session_id: 'worker-a',
    message: 'run deterministic checks',
    idempotency_key: 'master-1',
    timeout_seconds: 5,
  });
  await nextTurn();
  assert.equal(admissions.length, 1);
  const operationId = (await operations.list({ kind: 'dispatch' }))[0].id;
  const slaveCapability = runtime.issueContext({
    sessionId: 'worker-a',
    turnId: 'turn-slave',
    originDispatchId: operationId,
  });
  const slave = await runtime.execute(slaveCapability, 'dispatch_slave', {
    result: 'checks passed',
  });
  const result = await pending;
  assert.equal(slave.accepted, true);
  assert.equal(result.ok, true);
  assert.equal(result.result.text, 'checks passed');
  assert.equal(result.result.source, 'dispatch_slave');
  const snapshot = await store.snapshot();
  assert.equal(snapshot.outbox[`operation:${operationId}:result`], undefined);
});

test('dispatch_master timeout is non-destructive and retry reattaches idempotently', async t => {
  const clock = { value: 1_000 };
  const fakeTimer = (fn, ms) => {
    const timer = { unref() {} };
    queueMicrotask(() => {
      clock.value += ms;
      fn();
    });
    return timer;
  };
  const { admissions, operations, runtime } = fixture(t, {
    now: () => clock.value,
    setTimeoutFn: fakeTimer,
    clearTimeoutFn: () => {},
    pollIntervalMs: 250,
  });
  const capability = runtime.issueContext({ sessionId: 'caller', turnId: 'turn-timeout' });
  const args = {
    target_session_id: 'worker-a',
    message: 'slow task',
    idempotency_key: 'slow-1',
    timeout_seconds: 1,
  };
  const timedOut = await runtime.execute(capability, 'dispatch_master', args);
  assert.equal(timedOut.status, 'timed_out');
  assert.equal((await operations.get(timedOut.operation_id)).status, 'admitted');
  const retry = runtime.execute(capability, 'dispatch_master', {
    ...args,
    timeout_seconds: 5,
  });
  await operations.completeDispatch(timedOut.operation_id, {
    status: 'completed', text: 'late result',
  });
  const completed = await retry;
  assert.equal(admissions.length, 2);
  assert.equal(admissions[1].opts.idempotencyKey, admissions[0].opts.idempotencyKey);
  assert.equal(completed.operation_id, timedOut.operation_id);
  assert.equal(completed.result.text, 'late result');
});

test('target and slave lineage validation fail closed', async t => {
  const { operations, runtime } = fixture(t);
  const capability = runtime.issueContext({ sessionId: 'caller', turnId: 'turn-guard' });
  for (const [target, code] of [
    ['caller', 'self_dispatch'],
    ['worker-b', 'cross_directory'],
    ['commander', 'invalid_target'],
    ['aux', 'invalid_target'],
    ['terminal-a', 'terminal_target_requires_explicit_opt_in'],
    ['terminal-a-gw-chat', 'terminal_gateway_not_direct_target'],
    ['missing', 'target_not_found'],
  ]) {
    await assert.rejects(
      runtime.execute(capability, 'route_task', {
        target_session_id: target, message: 'x',
      }),
      error => error.code === code,
    );
  }
  await assert.rejects(
    runtime.execute(capability, 'dispatch_master', {
      target_session_id: 'terminal-a',
      message: 'must not reach a terminal by default',
      timeout_seconds: 1,
    }),
    error => error.code === 'terminal_target_requires_explicit_opt_in',
  );
  const genericTerminalCapability = runtime.issueContext({
    sessionId: 'caller',
    turnId: 'turn-terminal-generic',
    userText: '给我安装好 zcode 和 qoder 终端',
  });
  await assert.rejects(
    runtime.execute(genericTerminalCapability, 'route_task', {
      target_session_id: 'terminal-a',
      message: 'install terminal software',
      allow_terminal: true,
    }),
    error => error.code === 'terminal_target_not_explicitly_requested',
  );
  const terminalCapability = runtime.issueContext({
    sessionId: 'caller',
    turnId: 'turn-terminal-explicit',
    userText: '请把这个任务派给 terminal-a',
  });
  const terminal = await runtime.execute(terminalCapability, 'route_task', {
    target_session_id: 'terminal-a',
    message: 'run the explicitly requested command',
    allow_terminal: true,
  });
  assert.equal(terminal.ok, true);
  assert.equal(terminal.execution_session_id, 'terminal-a');
  const admitted = await operations.admitDispatch({
    ownerSessionId: 'caller',
    resultSessionId: 'caller',
    spec: {
      targetId: 'worker-a',
      chatId: 'worker-a',
      message: 'x',
      resultMode: 'tool',
    },
  });
  const wrongWorker = runtime.issueContext({
    sessionId: 'caller',
    turnId: 'turn-wrong',
    originDispatchId: admitted.id,
  });
  await assert.rejects(
    runtime.execute(wrongWorker, 'dispatch_slave', { result: 'spoofed' }),
    error => error.code === 'dispatch_lineage_mismatch',
  );
  await assert.rejects(
    runtime.execute(capability, 'dispatch_slave', { result: 'no lineage' }),
    error => error.code === 'dispatch_lineage_required',
  );
});

test('slave completion is exactly-once and capabilities revoke or expire', async t => {
  const clock = { value: 10 };
  const { operations, runtime } = fixture(t, {
    now: () => clock.value,
    capabilityTtlMs: 10,
  });
  const admitted = await operations.admitDispatch({
    ownerSessionId: 'caller',
    resultSessionId: 'caller',
    spec: {
      targetId: 'worker-a',
      chatId: 'worker-a',
      message: 'x',
      resultMode: 'tool',
    },
  });
  const slave = runtime.issueContext({
    sessionId: 'worker-a',
    turnId: 'turn-once',
    originDispatchId: admitted.id,
  });
  const first = await runtime.execute(slave, 'dispatch_slave', { result: 'first' });
  const duplicate = await runtime.execute(slave, 'dispatch_slave', { result: 'second' });
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal((await operations.get(admitted.id)).result.text, 'first');

  const revoked = runtime.issueContext({ sessionId: 'caller', turnId: 'turn-revoke' });
  runtime.revoke(revoked);
  await assert.rejects(
    runtime.execute(revoked, 'route_task', {
      target_session_id: 'worker-a', message: 'x',
    }),
    error => error.code === 'invalid_capability',
  );
  const expired = runtime.issueContext({ sessionId: 'caller', turnId: 'turn-expire' });
  clock.value += 11;
  await assert.rejects(
    runtime.execute(expired, 'route_task', {
      target_session_id: 'worker-a', message: 'x',
    }),
    error => error.code === 'expired_capability',
  );
});

test('persistent CLI capability resolves the active turn dynamically', async t => {
  let active = null;
  const { admissions, runtime } = fixture(t, {
    resolveContext: () => active,
  });
  const capability = runtime.issueContext({
    sessionId: 'caller',
    dynamic: true,
  });
  await assert.rejects(
    runtime.execute(capability, 'route_task', {
      target_session_id: 'worker-a', message: 'queued work',
    }),
    error => error.code === 'turn_not_active',
  );
  active = { turnId: 'turn-dynamic-1', originDispatchId: null };
  const first = await runtime.execute(capability, 'route_task', {
    target_session_id: 'worker-a', message: 'queued work',
  });
  active = { turnId: 'turn-dynamic-2', originDispatchId: null };
  const second = await runtime.execute(capability, 'route_task', {
    target_session_id: 'worker-a', message: 'queued work',
  });
  assert.notEqual(first.operation_id, second.operation_id);
  assert.equal(admissions.length, 2);
});
