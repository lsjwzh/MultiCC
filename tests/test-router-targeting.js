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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-router-targeting-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createOrchestrationStore({ file: path.join(dir, 'orchestration.json') });
  let sequence = 0;
  const operations = createOperationService({
    store,
    idFactory: () => `op_tgt_${++sequence}`,
  });
  const records = new Map([
    ['master', { id: 'master', dirId: 'dir-a', kind: 'chat', type: 'worker' }],
    ['slave-idle', { id: 'slave-idle', dirId: 'dir-a', kind: 'chat', type: 'worker' }],
    ['slave-busy', { id: 'slave-busy', dirId: 'dir-a', kind: 'chat', type: 'worker' }],
    ['slave-new', { id: 'slave-new', dirId: 'dir-a', kind: 'chat', type: 'worker' }],
    ['other-dir', { id: 'other-dir', dirId: 'dir-b', kind: 'chat', type: 'worker' }],
    ['terminal-x', { id: 'terminal-x', dirId: 'dir-a', kind: 'terminal', type: null }],
    ['terminal-x-gw-chat', {
      id: 'terminal-x-gw-chat', dirId: 'dir-a', kind: 'chat',
      type: null, ephemeral: true, gatewayFor: 'terminal-x',
    }],
    ['commander', { id: 'commander', dirId: 'dir-a', kind: 'chat', type: 'commander' }],
    ['aux', { id: 'aux', dirId: 'dir-a', kind: 'chat', type: 'aux' }],
  ]);
  const admissions = [];
  const busySet = new Set(overrides.busyTargets || ['slave-busy']);
  const dispatchToSession = async (targetId, message, opts) => {
    const busy = busySet.has(targetId);
    admissions.push({ targetId, message, opts, busy });
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
      status: busy ? 'queued' : 'admitted',
      duplicate: admitted.idempotent,
      chatId: targetId,
    };
  };
  const runtime = createRouterToolRuntime({
    records,
    dispatchToSession,
    operations,
    completeDispatch: (id, result) => operations.completeDispatch(id, result),
    recordUserInput: async () => ({ ok: true, duplicate: false }),
    registerExternalWait: async () => ({ ok: true }),
    getExternalWait: async () => null,
    listExternalWaits: async () => [],
    cancelExternalWait: async () => ({ ok: true }),
    resolveContext: () => null,
    now: overrides.now || (() => Date.now()),
    setTimeoutFn: overrides.setTimeoutFn || undefined,
    clearTimeoutFn: overrides.clearTimeoutFn || undefined,
    pollIntervalMs: overrides.pollIntervalMs || 50,
  });
  return { dir, store, operations, runtime, admissions, records };
}

function nextTurn() {
  return new Promise(resolve => setImmediate(resolve));
}

// ── R8-R11: Target validation ────────────────────────────────────────────────

test('R8: placeholder targets are rejected with clear errors', async t => {
  const { runtime } = fixture(t);
  const cap = runtime.issueContext({ sessionId: 'master', turnId: 'turn-r8' });
  for (const placeholder of ['xxx', '...', 'SESSION_ID', 'worker-1', '<target>']) {
    await assert.rejects(
      runtime.execute(cap, 'route_task', { target_session_id: placeholder, message: 'test' }),
      error => {
        assert.ok(
          ['target_not_found', 'invalid_arguments'].includes(error.code),
          `placeholder "${placeholder}" got ${error.code}`,
        );
        return true;
      },
      `placeholder "${placeholder}" must be rejected`,
    );
  }
});

test('R9: label-instead-of-id is rejected (target_not_found)', async t => {
  const { runtime } = fixture(t);
  const cap = runtime.issueContext({ sessionId: 'master', turnId: 'turn-r9' });
  await assert.rejects(
    runtime.execute(cap, 'route_task', { target_session_id: 'Slave Idle', message: 'test' }),
    error => error.code === 'invalid_arguments' || error.code === 'target_not_found',
  );
});

test('R10: nonexistent id is rejected with target_not_found', async t => {
  const { runtime } = fixture(t);
  const cap = runtime.issueContext({ sessionId: 'master', turnId: 'turn-r10' });
  await assert.rejects(
    runtime.execute(cap, 'route_task', { target_session_id: 'no-such-session', message: 'test' }),
    error => error.code === 'target_not_found',
  );
});

test('R11: cross-directory id is rejected with cross_directory', async t => {
  const { runtime } = fixture(t);
  const cap = runtime.issueContext({ sessionId: 'master', turnId: 'turn-r11' });
  await assert.rejects(
    runtime.execute(cap, 'route_task', { target_session_id: 'other-dir', message: 'test' }),
    error => error.code === 'cross_directory',
  );
});

// ── R4-R6: State interaction ─────────────────────────────────────────────────

test('R4: dispatch to a running/busy target queues without interrupting (ok:true, queued:true)', async t => {
  const { runtime, admissions } = fixture(t, { busyTargets: ['slave-busy'] });
  const cap = runtime.issueContext({ sessionId: 'master', turnId: 'turn-r4' });
  const result = await runtime.execute(cap, 'route_task', {
    target_session_id: 'slave-busy',
    message: 'queue this',
  });
  assert.equal(result.ok, true);
  assert.equal(result.queued, true);
  assert.equal(admissions.length, 1);
  assert.equal(admissions[0].busy, true);
});

test('R5: dispatch to a waiting_user target enters FIFO (ok:true)', async t => {
  const { runtime, admissions } = fixture(t, { busyTargets: [] });
  const cap = runtime.issueContext({ sessionId: 'master', turnId: 'turn-r5' });
  const result = await runtime.execute(cap, 'route_task', {
    target_session_id: 'slave-idle',
    message: 'into fifo',
  });
  assert.equal(result.ok, true);
  assert.equal(result.queued, true);
  assert.equal(admissions.length, 1);
});

test('R6: dispatch to a brand-new session delivers (ok:true, regression)', async t => {
  const { runtime, admissions } = fixture(t, { busyTargets: [] });
  const cap = runtime.issueContext({ sessionId: 'master', turnId: 'turn-r6' });
  const result = await runtime.execute(cap, 'route_task', {
    target_session_id: 'slave-new',
    message: 'spawn and deliver',
  });
  assert.equal(result.ok, true);
  assert.equal(result.queued, true);
  assert.equal(result.target_session_id, 'slave-new');
  assert.equal(admissions.length, 1);
  assert.equal(admissions[0].targetId, 'slave-new');
});

// ── R12-R13: Dedup ───────────────────────────────────────────────────────────

test('R12: explicit idempotency_key duplicate returns duplicate=true', async t => {
  const { runtime, operations } = fixture(t);
  const args = {
    target_session_id: 'slave-idle',
    message: 'dedup work',
    idempotency_key: 'stable-key-r12',
  };
  const first = await runtime.execute(
    runtime.issueContext({ sessionId: 'master', turnId: 'turn-r12a' }),
    'route_task', args,
  );
  const second = await runtime.execute(
    runtime.issueContext({ sessionId: 'master', turnId: 'turn-r12b' }),
    'route_task', args,
  );
  assert.equal(first.duplicate, undefined || false);
  assert.equal(second.duplicate, true);
  assert.equal(second.operation_id, first.operation_id);
  assert.equal((await operations.list({ kind: 'dispatch' })).length, 1);
});

test('R13: same-turn repeat route is turn-idempotent (duplicate)', async t => {
  const { runtime, operations } = fixture(t);
  const cap = runtime.issueContext({ sessionId: 'master', turnId: 'turn-r13' });
  const args = { target_session_id: 'slave-idle', message: 'repeat me' };
  const first = await runtime.execute(cap, 'route_task', args);
  const second = await runtime.execute(cap, 'route_task', args);
  assert.equal(second.duplicate, true);
  assert.equal(second.operation_id, first.operation_id);
  assert.equal((await operations.list({ kind: 'dispatch' })).length, 1);
});

// ── R14-R16: Constraints ─────────────────────────────────────────────────────

test('R14: terminal target rejected by default', async t => {
  const { runtime } = fixture(t);
  const cap = runtime.issueContext({ sessionId: 'master', turnId: 'turn-r14' });
  await assert.rejects(
    runtime.execute(cap, 'route_task', { target_session_id: 'terminal-x', message: 'test' }),
    error => error.code === 'terminal_target_requires_explicit_opt_in',
  );
});

test('R15: terminal target allowed only with allow_terminal + explicit user naming', async t => {
  const { runtime } = fixture(t);
  const genericCap = runtime.issueContext({
    sessionId: 'master', turnId: 'turn-r15a', userText: '帮我跑个命令',
  });
  await assert.rejects(
    runtime.execute(genericCap, 'route_task', {
      target_session_id: 'terminal-x', message: 'run cmd', allow_terminal: true,
    }),
    error => error.code === 'terminal_target_not_explicitly_requested',
  );
  const explicitCap = runtime.issueContext({
    sessionId: 'master', turnId: 'turn-r15b', userText: '请把这个任务派给 terminal-x',
  });
  const result = await runtime.execute(explicitCap, 'route_task', {
    target_session_id: 'terminal-x', message: 'run cmd', allow_terminal: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.execution_session_id, 'terminal-x');
});

test('R16: no multi-session broadcast (single target_session_id required)', async t => {
  const { runtime } = fixture(t);
  const cap = runtime.issueContext({ sessionId: 'master', turnId: 'turn-r16' });
  await assert.rejects(
    runtime.execute(cap, 'route_task', { message: 'broadcast' }),
    error => error.code === 'invalid_arguments',
  );
});

// ── E1-E4: Receipt contract ──────────────────────────────────────────────────

test('E1: idle slave dispatch returns {ok:true, queued:true}', async t => {
  const { runtime } = fixture(t, { busyTargets: [] });
  const cap = runtime.issueContext({ sessionId: 'master', turnId: 'turn-e1' });
  const result = await runtime.execute(cap, 'route_task', {
    target_session_id: 'slave-idle', message: 'idle task',
  });
  assert.equal(result.ok, true);
  assert.equal(result.queued, true);
  assert.equal(result.status, 'admitted');
});

test('E2: busy/processing slave dispatch returns {ok:true, queued:true} — not misjudged failure', async t => {
  const { runtime } = fixture(t, { busyTargets: ['slave-busy'] });
  const cap = runtime.issueContext({ sessionId: 'master', turnId: 'turn-e2' });
  const result = await runtime.execute(cap, 'route_task', {
    target_session_id: 'slave-busy', message: 'busy task',
  });
  assert.equal(result.ok, true, 'busy target must still return ok:true');
  assert.equal(result.queued, true);
});

test('E3: receipt always contains queued field consistent with FIFO admission', async t => {
  const { runtime } = fixture(t, { busyTargets: ['slave-busy'] });
  for (const [target, turnId] of [['slave-idle', 'turn-e3a'], ['slave-busy', 'turn-e3b']]) {
    const cap = runtime.issueContext({ sessionId: 'master', turnId });
    const result = await runtime.execute(cap, 'route_task', {
      target_session_id: target, message: `task for ${target}`,
    });
    assert.equal(typeof result.queued, 'boolean', `${target} receipt must have boolean queued`);
    assert.equal(result.queued, true, `${target} always enters FIFO`);
  }
});

test('E4: dispatch_master receipt contains queued field (contract parity with route_task)', async t => {
  const { runtime, operations } = fixture(t, { busyTargets: [] });
  const cap = runtime.issueContext({ sessionId: 'master', turnId: 'turn-e4' });
  const pending = runtime.execute(cap, 'dispatch_master', {
    target_session_id: 'slave-idle',
    message: 'e4 check',
    idempotency_key: 'e4-key',
    timeout_seconds: 5,
  });
  await nextTurn();
  const ops = await operations.list({ kind: 'dispatch' });
  const slaveCap = runtime.issueContext({
    sessionId: 'slave-idle', turnId: 'turn-e4-slave', originDispatchId: ops[0].id,
  });
  await runtime.execute(slaveCap, 'dispatch_slave', { result: 'done' });
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(typeof result.queued, 'boolean', 'dispatch_master receipt must have queued field');
  assert.equal(result.queued, true);
});

// ── S1-S2: Prompt assertion (dispatch_slave callback instruction) ────────────

test('S1: dispatch_master message to slave contains dispatch_slave callback instruction', async t => {
  const { runtime, admissions, operations } = fixture(t, { busyTargets: [] });
  const cap = runtime.issueContext({ sessionId: 'master', turnId: 'turn-s1' });
  const pending = runtime.execute(cap, 'dispatch_master', {
    target_session_id: 'slave-idle',
    message: 'implement feature X',
    idempotency_key: 's1-key',
    timeout_seconds: 5,
  });
  await nextTurn();
  assert.equal(admissions.length, 1);
  const delivered = admissions[0].message;
  assert.match(delivered, /implement feature X/, 'original message preserved');
  assert.match(delivered, /dispatch_slave/, 'must mention dispatch_slave tool');
  assert.match(delivered, /回传/, 'must contain callback instruction keyword');
  assert.match(delivered, /status:"completed"/, 'must show completed status example');
  assert.match(delivered, /status:"failed"/, 'must show failed status example');
  assert.match(delivered, /master 会一直等待/, 'must warn about master waiting');
  // Resolve to avoid dangling promise
  const ops = await operations.list({ kind: 'dispatch' });
  const slaveCap = runtime.issueContext({
    sessionId: 'slave-idle', turnId: 'turn-s1-slave', originDispatchId: ops[0].id,
  });
  await runtime.execute(slaveCap, 'dispatch_slave', { result: 'ok' });
  await pending;
});

test('S2: route_task (one-way) message does NOT contain dispatch_slave callback instruction', async t => {
  const { runtime, admissions } = fixture(t, { busyTargets: [] });
  const cap = runtime.issueContext({ sessionId: 'master', turnId: 'turn-s2' });
  await runtime.execute(cap, 'route_task', {
    target_session_id: 'slave-idle',
    message: 'one-way work',
  });
  assert.equal(admissions.length, 1);
  const delivered = admissions[0].message;
  assert.equal(delivered, 'one-way work', 'route_task message must be passed through unchanged');
  assert.doesNotMatch(delivered, /dispatch_slave/);
  assert.doesNotMatch(delivered, /回传要求/);
});
