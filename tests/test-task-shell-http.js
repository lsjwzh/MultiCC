'use strict';

// The task-shell public routes are served by the Rust front door now; this
// file drives the one loopback host port (/api/__host/task-shell) that still
// runs in Node. A successful op answers {ok:true, value}; a refusal carries the
// facts the retired `route()` catch arm used to project (code, message, the
// status Express would have sent, and the conflict/receipt fields). The
// front-door status codes and DTO key order are covered by
// native/gateway/tests/task_shell.rs and the migration differential.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/task-shell');
const { fakeApp, mountHost } = require('./helpers/task-shell-host');
const { createTaskOperations } = require('../src/task-shell/task-operations');
const { createClient } = require('../public/task-shell-client');
const { createOrchestrationRuntime } = require('../src/orchestration/runtime');
const { createQueuedTurnPreparation } = require('../src/chat/admission-progress');

test('真实发送接口在模型路由和工作区准备期间已经返回，重复请求只执行一次', async t => {
  let queue, releaseRouting, releaseWorkspace;
  const routingGate = new Promise(resolve => { releaseRouting = resolve; });
  const workspaceGate = new Promise(resolve => { releaseWorkspace = resolve; });
  const f = fixture(t, { getDirectory: id => ({ id }),
    send: (sessionId, text, options) => queue.admitSessionWork({ sessionId, text, options,
      source: 'task-shell', idempotencyKey: options.idempotencyKey }) });
  const deliveries = [], routing = [];
  const prepare = createQueuedTurnPreparation({ prepareRouting: async (...args) => {
    routing.push(args); await routingGate;
  } });
  queue = createOrchestrationRuntime({ file: `${f.file}.queue.json`, databaseFile: `${f.file}.queue.sqlite`,
    beforeDeliver: async descriptor => { await prepare(descriptor); await workspaceGate; },
    runChatTurn: (sessionId, text, opts) => { deliveries.push({ sessionId, text, opts }); return true; },
    hasPersistedDelivery: async (sessionId, id) => deliveries.some(d => d.sessionId === sessionId && d.opts.deliveryId === id),
  });
  const created = await f.runtime.createStandalone({ dirId: 'd1', title: '异步发送验证', cli: 'codex', clientMsgId: 'create' });
  const { ok } = mountHost(fakeApp(), { getRuntime: () => f.runtime });
  try {
    const send = () => ok({ op: 'task-message', taskId: created.taskId,
      body: { text: '请执行任务', clientMsgId: 'message-1', intent: 'work' } });
    const receipt = await send();
    assert.equal(receipt.ok, true);
    assert.equal(deliveries.length, 0, '准备尚未放行时，接口已经返回');
    assert.equal(f.store.get('receipt', receipt.receiptId).status, 'accepted');
    const rows = await queue.outbox.list({ sessionId: created.sessionId });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].payload.message, '请执行任务');
    assert.deepEqual(await send(), receipt);
    assert.equal(deliveries.length, 0);
    releaseRouting(); releaseWorkspace();
    await queue.tick();
    assert.equal(deliveries.length, 1);
    assert.equal(routing.length, 1);
    assert.equal(routing[0][2], receipt.receiptId);
    assert.equal((await queue.outbox.get(rows[0].id)).state, 'delivered');
    await send(); await queue.tick();
    assert.equal(deliveries.length, 1);
  } finally {
    releaseRouting(); releaseWorkspace();
    await queue.dispose();
  }
});

test('host port executes and preserves structured errors, links and receipt ownership', async t => {
  const f = fixture(t);
  const { ok, fail } = mountHost(fakeApp(), { getRuntime: () => f.runtime });
  const bad = await fail({ op: 'shell-message', shellId: f.a.id, body: { text: 'invalid' } });
  assert.equal(bad.status, 400); assert.equal(f.creations.length, 0);
  const first = await ok({ op: 'shell-message', shellId: f.a.id, body: { text: 'work', clientMsgId: 'first', intent: 'work' } });
  assert.equal(first.ok, true);
  const trace = await ok({ op: 'context', sessionId: first.sessionId, traceId: first.receiptId, includeMessages: false });
  assert.equal(trace.traceId, first.receiptId);
  assert.equal(trace.currentTask.taskId, first.taskId);
  const denied = await fail({ op: 'receipt-retry', shellId: f.b.id, receiptId: first.receiptId });
  assert.equal(denied.status, 404);
  await ok({ op: 'links', shellId: f.b.id, taskId: first.taskId });
  const resolved = await fail({ op: 'tasks-resolve', shellId: f.b.id, taskId: first.taskId });
  assert.equal(resolved.status, 409);
  assert.equal(f.runtime.view(f.b.id).currentTaskId, null);
  const detail = await ok({ op: 'detail', shellId: f.b.id, taskId: first.taskId });
  assert.equal(detail.execution.busy, true);
});

test('the shell scope hands the browser the input cursor as a display handle', async t => {
  const f = fixture(t, { taskShortCode: id => (id === '' ? '' : 'CURR') });
  const { ok } = mountHost(fakeApp(), { getRuntime: () => f.runtime });
  const scope = () => ok({ op: 'chat', shellId: f.a.id });
  const before = await scope();
  assert.equal(before.taskId, null, 'a shell with no current task has no cursor to show');
  assert.equal(before.taskShortCode, '');
  const sent = await ok({ op: 'shell-message', shellId: f.a.id, body: { text: 'work', clientMsgId: 'first', intent: 'work' } });
  const after = await scope();
  assert.equal(after.taskId, sent.taskId, 'the cursor the chat page shows is the one a message is attributed to');
  assert.equal(after.taskShortCode, 'CURR');
});

test('a re-attribution over a running turn is queued and can be taken back through the host port', async t => {
  const f = fixture(t);
  const operations = createTaskOperations({
    store: f.store, revisionOf: () => 'rev-1', isTurnBusy: () => true,
    resolveTarget: async () => ({ id: 'tsk_x' }), taskTitle: id => `Task ${id}`,
    scopeOf: shellId => f.runtime.chatScope(shellId),
  });
  const { ok, fail } = mountHost(fakeApp(), { getRuntime: () => f.runtime, taskOperations: () => operations });
  const turns = [{ sessionId: 'a', turnId: 'turn-1' }], target = { taskId: 'tsk_x' };
  const refused = await fail({ op: 'task-operations-apply', shellId: f.a.id, turns, target, clientMsgId: 'm1' });
  assert.equal(refused.status, 409);
  assert.equal(refused.code, 'turn_busy', 'without `queue` the caller still gets a refusal');
  const queued = await ok({ op: 'task-operations-apply', shellId: f.a.id, turns, target, clientMsgId: 'm1', queue: true });
  assert.equal(queued.status, 'queued');
  assert.equal(queued.queuedAt > 0, true);
  assert.deepEqual(f.store.list('turn-attr'), [], 'queueing writes no attribution');
  const listed = await ok({ op: 'task-operations-list', shellId: f.a.id });
  assert.deepEqual(listed.map(row => row.status), ['queued']);
  const cancelled = await ok({ op: 'task-operations-cancel', operationId: queued.id, clientMsgId: 'c1' });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal((await ok({ op: 'task-operations-cancel', operationId: queued.id })).status, 'cancelled');
});

test('browser transport preserves payload and key after timeout/reload; no silent reroute', async () => {
  const values = new Map(), requests = [];
  const storage = { getItem: k => values.get(k), setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) };
  let fail = true;
  const opts = { storage, key: 'shell-a', randomId: () => 'm1', request: async (url, body) => {
    requests.push({ url, body }); if (fail) throw new Error('lost response'); return { taskId: 'fork' };
  } };
  const client = createClient(opts);
  await assert.rejects(client.send('shell', { taskId: 'original', text: 'answer', intent: 'answer', requestId: 'q1', turnId: 'turn1' }));
  await assert.rejects(client.send('shell', { text: 'another' }), /pending_delivery/);
  fail = false;
  const reopened = createClient(opts);
  await reopened.retry('shell');
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(reopened.pending(), null);
});

test('browser transport allows correcting a definitively rejected unreserved request', async () => {
  const storage = { getItem: () => null, setItem() {}, removeItem() {} };
  const client = createClient({ storage, key: 'test', randomId: () => 'm1', request: async () => {
    throw Object.assign(new Error('dependency_not_ready'), { notReserved: true });
  } });
  await assert.rejects(client.send('shell', { text: 'work' }));
  assert.equal(client.pending(), null);
});

test('the index can move the next-input target with a cursor CAS, and never by accident', async t => {
  const f = fixture(t);
  const { ok, fail } = mountHost(fakeApp(), { getRuntime: () => f.runtime });
  const first = await ok({ op: 'shell-message', shellId: f.a.id, body: { text: 'work', clientMsgId: 'w1', intent: 'work' } });
  const second = await ok({ op: 'shell-message', shellId: f.a.id, body: { text: 'other', clientMsgId: 'w2', intent: 'work', newTask: true } });
  const secondTaskId = second.taskId;
  assert.notEqual(first.taskId, secondTaskId, 'the second message really is another task');
  assert.equal(f.runtime.view(f.a.id).currentTaskId, secondTaskId);

  const moved = await ok({ op: 'select-target', shellId: f.a.id, taskId: first.taskId });
  assert.equal(moved.ok, true);
  assert.equal(moved.changed, true);
  assert.equal(f.runtime.view(f.a.id).currentTaskId, first.taskId);
  // The cursor CAS is what keeps two open pages from overwriting each other.
  const stale = await fail({ op: 'select-target', shellId: f.a.id,
    taskId: secondTaskId, expectedCursorVersion: moved.cursorVersion - 1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.code, 'stale_shell_cursor');
  assert.equal(f.runtime.view(f.a.id).currentTaskId, first.taskId, 'a stale write changes nothing');
  const same = await ok({ op: 'select-target', shellId: f.a.id, taskId: first.taskId });
  assert.equal(same.changed, false, 'choosing the current target is a no-op, not a cursor bump');
  assert.equal(f.runtime.view(f.a.id).cursorVersion, moved.cursorVersion);

  // Identity, attribution and the task itself are untouched: this is a cursor.
  const other = await fail({ op: 'select-target', shellId: f.b.id, taskId: first.taskId });
  assert.equal(other.status, 403);
  assert.equal(other.code, 'task_not_linked');
  const missing = await fail({ op: 'select-target', shellId: f.a.id, taskId: 'tsk_missing' });
  assert.equal(missing.status, 403);
});
