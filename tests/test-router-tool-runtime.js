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
  const externalWaits = new Map();
  const externalWaitRegistrations = [];
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
    registerExternalWait: async spec => {
      externalWaitRegistrations.push(spec);
      if (externalWaits.has(spec.id)) {
        const error = new Error('wait already exists');
        error.code = 'WAIT_ALREADY_EXISTS';
        throw error;
      }
      const at = 10_000;
      const metadata = {
        source: spec.source,
        reason: spec.reason,
        registrationFingerprint: spec.registrationFingerprint,
        ...(spec.mode === 'callback'
          ? { timeoutSec: spec.timeoutSec, expireAt: at + spec.timeoutSec * 1000 }
          : { delaySec: spec.delaySec, dueAt: at + spec.delaySec * 1000 }),
      };
      const wait = {
        id: spec.id,
        sessionId: spec.session,
        mode: spec.mode,
        status: 'pending',
        metadata,
        createdAt: at,
        resolvedAt: null,
        cancelledAt: null,
      };
      externalWaits.set(wait.id, wait);
      return {
        ...wait,
        token: spec.mode === 'callback' ? 'callback-secret' : null,
        callbackUrl: null,
        dueAt: metadata.dueAt || null,
      };
    },
    getExternalWait: async id => externalWaits.get(id) || null,
    listExternalWaits: async sessionId => [...externalWaits.values()]
      .filter(wait => wait.sessionId === sessionId && wait.status === 'pending'),
    cancelExternalWait: async id => {
      const wait = externalWaits.get(id);
      if (!wait) return { ok: false, code: 'not_found' };
      if (wait.status === 'cancelled') return { ok: true, idempotent: true };
      if (wait.status !== 'pending') {
        return { ok: false, code: 'not_pending', status: wait.status };
      }
      wait.status = 'cancelled';
      wait.cancelledAt = 11_000;
      return { ok: true, idempotent: false };
    },
    pollIntervalMs: 2,
    ...overrides,
  });
  return {
    admissions, dispatchToSession, externalWaitRegistrations, externalWaits,
    operations, records, runtime, store, userInputSignals,
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

test('external callback wait is session-bound, at-most-once, and never exposes raw injection controls', async t => {
  const { externalWaitRegistrations, runtime } = fixture(t);
  const capability = runtime.issueContext({
    sessionId: 'caller',
    turnId: 'turn-callback',
    baseUrl: 'http://127.0.0.1:3000',
  });
  const args = {
    mode: 'callback',
    reason: '等待 CI 发布结果',
    timeout_seconds: 300,
    idempotency_key: 'ci-release-42',
  };
  const first = await runtime.execute(capability, 'wait_for_external_result', args);
  assert.equal(first.ok, true);
  assert.equal(first.duplicate, false);
  assert.match(
    first.callback_url,
    /^http:\/\/127\.0\.0\.1:3000\/api\/wait\/wait-router-[a-f0-9]{24}\/resolve\?token=callback-secret$/,
  );
  assert.equal('token' in first, false);
  assert.deepEqual(externalWaitRegistrations[0], {
    id: first.wait_id,
    session: 'caller',
    mode: 'callback',
    reason: '等待 CI 发布结果',
    source: 'router-mcp',
    registrationFingerprint: externalWaitRegistrations[0].registrationFingerprint,
    timeoutSec: 300,
  });
  assert.equal('pollCmd' in externalWaitRegistrations[0], false);
  assert.equal('pollUrl' in externalWaitRegistrations[0], false);
  assert.equal('injectPrefix' in externalWaitRegistrations[0], false);

  const replay = await runtime.execute(capability, 'wait_for_external_result', args);
  assert.equal(replay.wait_id, first.wait_id);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.callback_url, null);
  assert.equal(replay.callback_url_unavailable, true);
  assert.equal(externalWaitRegistrations.length, 1);

  await assert.rejects(
    runtime.execute(capability, 'wait_for_external_result', {
      ...args,
      reason: 'same key, different purpose',
    }),
    error => error.code === 'idempotency_conflict',
  );
  await assert.rejects(
    runtime.execute(capability, 'wait_for_external_result', {
      mode: 'delay',
      reason: 'same key, different mode',
      delay_seconds: 30,
      idempotency_key: args.idempotency_key,
    }),
    error => error.code === 'idempotency_conflict',
  );
});

test('durable delay can be inspected and cancelled only by its owning session', async t => {
  const { externalWaits, runtime } = fixture(t);
  const capability = runtime.issueContext({
    sessionId: 'caller',
    turnId: 'turn-delay',
    baseUrl: 'http://127.0.0.1:3000',
  });
  const created = await runtime.execute(capability, 'wait_for_external_result', {
    mode: 'delay',
    reason: '十分钟后复查部署',
    delay_seconds: 600,
  });
  assert.equal(created.ok, true);
  assert.equal(created.duplicate, false);
  assert.equal(created.due_at, 610_000);

  const duplicate = await runtime.execute(capability, 'wait_for_external_result', {
    mode: 'delay',
    reason: '十分钟后复查部署',
    delay_seconds: 600,
  });
  assert.equal(duplicate.wait_id, created.wait_id);
  assert.equal(duplicate.duplicate, true);

  const status = await runtime.execute(capability, 'get_external_wait', {
    wait_id: created.wait_id,
  });
  assert.equal(status.status, 'pending');
  assert.equal(status.reason, '十分钟后复查部署');

  const otherSession = runtime.issueContext({
    sessionId: 'worker-a',
    turnId: 'turn-other',
  });
  await assert.rejects(
    runtime.execute(otherSession, 'get_external_wait', { wait_id: created.wait_id }),
    error => error.code === 'external_wait_not_found',
  );
  externalWaits.set('wait_system_internal', {
    id: 'wait_system_internal',
    sessionId: 'caller',
    mode: 'delay',
    status: 'pending',
  });
  await assert.rejects(
    runtime.execute(capability, 'cancel_external_wait', {
      wait_id: 'wait_system_internal',
    }),
    error => error.code === 'external_wait_not_found',
  );

  const cancelled = await runtime.execute(capability, 'cancel_external_wait', {
    wait_id: created.wait_id,
  });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.duplicate, false);
  const replayedCancel = await runtime.execute(capability, 'cancel_external_wait', {
    wait_id: created.wait_id,
  });
  assert.equal(replayedCancel.duplicate, true);

  const replayedRegistration = await runtime.execute(capability, 'wait_for_external_result', {
    mode: 'delay',
    reason: '十分钟后复查部署',
    delay_seconds: 600,
  });
  assert.equal(replayedRegistration.wait_id, created.wait_id);
  assert.equal(replayedRegistration.status, 'cancelled');
  assert.match(replayedRegistration.instruction, /already cancelled/);
});

test('external wait rejects unsupported modes, ambiguous timing, and per-session overflow', async t => {
  const { runtime } = fixture(t);
  const capability = runtime.issueContext({
    sessionId: 'caller',
    turnId: 'turn-wait-bounds',
    baseUrl: 'http://127.0.0.1:3000',
  });
  for (const [args, code] of [
    [{ mode: 'poll', reason: 'run a command' }, 'invalid_arguments'],
    [{ mode: 'delay', reason: 'missing duration' }, 'invalid_arguments'],
    [{
      mode: 'callback', reason: 'ambiguous', delay_seconds: 10,
    }, 'invalid_arguments'],
    [{
      mode: 'delay', reason: 'ambiguous', delay_seconds: 10, timeout_seconds: 20,
    }, 'invalid_arguments'],
    [{
      mode: 'delay',
      reason: 'must not accept host controls',
      delay_seconds: 10,
      session_id: 'worker-a',
      pollCmd: 'echo unsafe',
    }, 'invalid_arguments'],
  ]) {
    await assert.rejects(
      runtime.execute(capability, 'wait_for_external_result', args),
      error => error.code === code,
    );
  }
  for (let index = 0; index < 8; index++) {
    const wait = await runtime.execute(capability, 'wait_for_external_result', {
      mode: 'delay',
      reason: `bounded ${index}`,
      delay_seconds: index + 1,
      idempotency_key: `bounded-${index}`,
    });
    assert.equal(wait.ok, true);
  }
  await assert.rejects(
    runtime.execute(capability, 'wait_for_external_result', {
      mode: 'delay',
      reason: 'one too many',
      delay_seconds: 20,
      idempotency_key: 'bounded-overflow',
    }),
    error => error.code === 'external_wait_limit',
  );
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

test('dispatch_master returns admitted immediately and backflow outbox is emitted on completion', async t => {
  const { admissions, operations, runtime, store } = fixture(t);
  const masterCapability = runtime.issueContext({ sessionId: 'caller', turnId: 'turn-master' });
  const result = await runtime.execute(masterCapability, 'dispatch_master', {
    target_session_id: 'worker-a',
    message: 'run deterministic checks',
    idempotency_key: 'master-1',
  });
  assert.equal(result.ok, true);
  assert.equal(result.admitted, true);
  assert.equal(result.status, 'admitted');
  assert.equal(result.queued, true);
  assert.equal(result.result, undefined);
  assert.equal(admissions.length, 1);
  const operationId = result.operation_id;
  const slaveCapability = runtime.issueContext({
    sessionId: 'worker-a',
    turnId: 'turn-slave',
    originDispatchId: operationId,
  });
  const slave = await runtime.execute(slaveCapability, 'dispatch_slave', {
    result: 'checks passed',
  });
  assert.equal(slave.accepted, true);
  const snapshot = await store.snapshot();
  const outboxEntry = snapshot.outbox[`operation:${operationId}:result`];
  assert.ok(outboxEntry, 'backflow outbox entry must exist');
  assert.equal(outboxEntry.payload.type, 'dispatch.result');
  assert.match(outboxEntry.payload.deliveryText, /📜 dispatch 结果回流/);
  assert.match(outboxEntry.payload.deliveryText, /checks passed/);
});

test('dispatch_master retry reattaches idempotently without duplicate operations', async t => {
  const { admissions, operations, runtime } = fixture(t);
  const capability = runtime.issueContext({ sessionId: 'caller', turnId: 'turn-retry' });
  const args = {
    target_session_id: 'worker-a',
    message: 'slow task',
    idempotency_key: 'slow-1',
  };
  const first = await runtime.execute(capability, 'dispatch_master', args);
  assert.equal(first.ok, true);
  assert.equal(first.admitted, true);
  assert.equal(first.status, 'admitted');
  assert.equal((await operations.get(first.operation_id)).status, 'admitted');
  const retry = await runtime.execute(capability, 'dispatch_master', args);
  assert.equal(retry.ok, true);
  assert.equal(retry.operation_id, first.operation_id);
  assert.equal(retry.duplicate, true);
  assert.equal(admissions.length, 2);
  assert.equal(admissions[1].opts.idempotencyKey, admissions[0].opts.idempotencyKey);
  assert.equal((await operations.list({ kind: 'dispatch' })).length, 1);
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
