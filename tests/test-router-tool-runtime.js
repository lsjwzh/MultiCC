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
    ['commander', { id: 'commander', dirId: 'dir-a', kind: 'chat', type: 'commander' }],
    ['aux', { id: 'aux', dirId: 'dir-a', kind: 'chat', type: 'aux' }],
  ]);
  const admissions = [];
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
        taskText: opts.taskText,
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
    pollIntervalMs: 2,
    ...overrides,
  });
  return { admissions, dispatchToSession, operations, records, runtime, store };
}

async function nextTurn() {
  await new Promise(resolve => setImmediate(resolve));
}

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
  const terminal = await runtime.execute(capability, 'route_task', {
    target_session_id: 'terminal-a',
    message: 'run the explicitly requested command',
    allow_terminal: true,
  });
  assert.equal(terminal.ok, true);
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
