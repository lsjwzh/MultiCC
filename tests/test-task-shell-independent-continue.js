'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createIndependentContinuation } = require('../src/task-shell/independent-continue');

function fakeStore(seed = {}) {
  const data = new Map();
  const key = (kind, id) => `${kind}\u0000${id}`;
  const clone = value => JSON.parse(JSON.stringify(value));
  for (const [kind, rows] of Object.entries(seed)) {
    for (const [id, value] of Object.entries(rows)) data.set(key(kind, id), value);
  }
  let depth = 0;
  return {
    get: (kind, id) => (data.has(key(kind, id)) ? clone(data.get(key(kind, id))) : null),
    set: (kind, id, value) => { data.set(key(kind, id), clone(value)); return value; },
    remove: (kind, id) => data.delete(key(kind, id)),
    list: kind => [...data.entries()].filter(([entry]) => entry.startsWith(`${kind}\u0000`)).map(([, value]) => clone(value)),
    transaction: callback => { depth += 1; try { return callback(); } finally { depth -= 1; } },
    inTransaction: () => depth > 0,
  };
}

function setup(overrides = {}) {
  const store = fakeStore({
    task: { tsk_a: { id: 'tsk_a', dirId: 'dir_1', sessionId: 'conv-1', ownerShellId: 'sh_1', title: 'Alpha', ready: true } },
    shell: { sh_1: { id: 'sh_1', sourceSessionId: 'conv-1', dirId: 'dir_1', standalone: false, currentTaskId: 'tsk_a' } },
    link: { 'sh_1:tsk_a': { shellId: 'sh_1', taskId: 'tsk_a' } },
  });
  const created = [];
  const discarded = [];
  const events = [];
  const history = { 'conv-1': [
    { id: 'u1', role: 'user', content: 'one', taskId: 'tsk_a', ts: 1 },
    { id: 'a1', role: 'assistant', content: 'done', taskId: 'tsk_a', ts: 2 },
    { id: 'u9', role: 'user', content: 'other task', taskId: 'tsk_b', ts: 3 },
  ] };
  const execution = { busy: false, pending: null, queue: { queued: [] } };
  const baseline = { ok: true, commit: 'cafe1', branch: 'multicc/conv-1', dirty: false, ahead: 0,
    sourceSessionId: 'conv-1', sourceWorkspace: '/tmp/wt', baseBranch: 'main' };
  const records = new Map([['conv-1', { id: 'conv-1', dirId: 'dir_1', kind: 'chat' }]]);
  const runtime = createIndependentContinuation({
    store,
    getRecord: id => records.get(id) || null,
    getHistory: id => history[id] || [],
    getExecution: async () => ({ ...execution }),
    createExecution: async (task, source) => {
      created.push({ taskId: task.id, sessionId: task.sessionId, baseline: task.forkBaseline, source });
      records.set(task.sessionId, { id: task.sessionId, dirId: task.dirId, kind: 'chat', taskBoundTaskId: task.id,
        workspaceState: 'planned', worktreePath: `/tmp/${task.sessionId}`, branch: `multicc/${task.sessionId}` });
      return { ok: true, baseline: { commit: task.forkBaseline?.commit || null, branch: task.forkBaseline?.branch || null } };
    },
    indexTask: async () => ({ ok: true }),
    ownerOf: () => store.get('shell', 'sh_1'),
    roles: { snapshot: () => 'roles-1' },
    hasCapacity: async () => overrides.hasCapacity ? overrides.hasCapacity() : true,
    ports: {
      captureIndependentBaseline: async () => (overrides.baseline ? overrides.baseline() : { ...baseline }),
      onContinuationChanged: (taskId, id) => events.push({ taskId, id, state: store.get('independent', id)?.state }),
      discardExecution: async (sessionId, { taskId } = {}) => {
        discarded.push({ sessionId, taskId });
        if (overrides.discardRefused) return { ok: false, code: 'not_created_here' };
        records.delete(sessionId);
        return { ok: true };
      },
    },
  });
  return { store, runtime, created, discarded, events, execution, history, records };
}

test('a request waits for a boundary, then prepares an execution on a frozen baseline', async () => {
  const asked = setup();
  asked.execution.busy = true;
  const waiting = await asked.runtime.request('sh_1', 'tsk_a', { clientMsgId: 'm1' });
  assert.equal(waiting.state, 'waiting');
  assert.equal(waiting.reason, 'turn_busy');
  assert.equal(asked.created.length, 0, 'a waiting request creates nothing');
  assert.equal(asked.store.list('independent').length, 1, 'but the request itself is durable');

  asked.execution.busy = false;
  await asked.runtime.tick();
  const ready = (await asked.runtime.advance(waiting.id));
  assert.equal(ready.state, 'ready');
  assert.equal(ready.phase, 'ready');
  assert.equal(asked.created.length, 1);
  // Only this task's records are authorized into the new context.
  assert.deepEqual(ready.manifest.importedMessages, ['conv-1:u1', 'conv-1:a1']);
  assert.equal(ready.manifest.codeCommit, 'cafe1');
  assert.equal(ready.manifest.roleSnapshotId, 'roles-1');
  assert.equal(asked.store.list('snapshot')[0].taskId, 'tsk_a');
});

test('uncommitted, undelivered and capacity blocks are waiting reasons, not failures', async () => {
  const dirty = setup({ baseline: () => ({ ok: true, commit: 'c1', dirty: true, ahead: 0, sourceSessionId: 'conv-1' }) });
  const dirtyOp = await dirty.runtime.request('sh_1', 'tsk_a', { clientMsgId: 'm1' });
  assert.deepEqual([dirtyOp.state, dirtyOp.reason], ['waiting', 'uncommitted_changes']);

  const ahead = setup({ baseline: () => ({ ok: true, commit: 'c1', dirty: false, ahead: 2, sourceSessionId: 'conv-1' }) });
  const aheadOp = await ahead.runtime.request('sh_1', 'tsk_a', { clientMsgId: 'm1' });
  assert.deepEqual([aheadOp.state, aheadOp.reason], ['waiting', 'undelivered_changes']);

  const full = setup({ hasCapacity: () => false });
  const fullOp = await full.runtime.request('sh_1', 'tsk_a', { clientMsgId: 'm1' });
  assert.deepEqual([fullOp.state, fullOp.reason], ['waiting', 'capacity']);

  const missing = setup({ baseline: () => ({ ok: false, reason: 'workspace_missing' }) });
  const missingOp = await missing.runtime.request('sh_1', 'tsk_a', { clientMsgId: 'm1' });
  assert.deepEqual([missingOp.state, missingOp.reason], ['waiting', 'workspace_missing']);
});

test('apply switches the execution binding, keeps the identity, and is idempotent', async () => {
  const { store, runtime, created } = setup();
  const op = await runtime.request('sh_1', 'tsk_a', { clientMsgId: 'm1' });
  assert.equal(op.state, 'ready');
  const applied = await runtime.apply(op.id);
  assert.equal(applied.state, 'applied');
  const task = store.get('task', 'tsk_a');
  assert.equal(task.sessionId, op.targetSessionId);
  assert.equal(task.id, 'tsk_a', 'the logical task and its short code are unchanged');
  assert.equal(task.executionEpoch, 1);
  assert.deepEqual(task.previousExecutions, [{ sessionId: 'conv-1', at: task.previousExecutions[0].at, reason: 'independent-continue' }]);
  assert.equal(task.independentFrom.codeCommit, 'cafe1');
  assert.equal(created.length, 1);
  assert.equal((await runtime.apply(op.id)).state, 'applied');
  assert.equal(created.length, 1, 'a replayed apply never creates a second execution');

  // The same idempotency key replays the same request; a new request for a task
  // that already has its own execution is refused instead of prepared twice.
  assert.equal((await runtime.request('sh_1', 'tsk_a', { clientMsgId: 'm1' })).id, op.id);
  await assert.rejects(async () => runtime.request('sh_1', 'tsk_a', { clientMsgId: 'm2' }), { code: 'already_independent' });
});

test('apply refuses to switch while the task is running or answered-not-yet', async () => {
  const running = setup();
  const op = await running.runtime.request('sh_1', 'tsk_a', { clientMsgId: 'm1' });
  running.execution.busy = true;
  await assert.rejects(async () => running.runtime.apply(op.id), { code: 'turn_busy' });
  assert.equal(running.store.get('task', 'tsk_a').sessionId, 'conv-1');

  const asked = setup();
  const askedOp = await asked.runtime.request('sh_1', 'tsk_a', { clientMsgId: 'm1' });
  asked.execution.pending = { requestId: 'r1', resolved: false };
  await assert.rejects(async () => asked.runtime.apply(askedOp.id), { code: 'turn_busy' });
});

test('cancel reclaims only the execution it created and left unused', async () => {
  const unused = setup();
  const op = await unused.runtime.request('sh_1', 'tsk_a', { clientMsgId: 'm1' });
  const cancelled = await unused.runtime.cancel(op.id);
  assert.deepEqual([cancelled.state, cancelled.cleanup], ['cancelled', 'removed']);
  assert.deepEqual(unused.discarded, [{ sessionId: op.targetSessionId, taskId: 'tsk_a' }]);
  assert.equal(unused.records.has(op.targetSessionId), false);
  assert.equal(unused.store.get('task', 'tsk_a').sessionId, 'conv-1', 'a cancelled request never moves the task');
  await assert.rejects(async () => unused.runtime.apply(op.id), { code: 'continuation_not_ready' });

  const used = setup();
  const usedOp = await used.runtime.request('sh_1', 'tsk_a', { clientMsgId: 'm1' });
  used.history[usedOp.targetSessionId] = [{ id: 'x1', role: 'user', content: 'already working here' }];
  const kept = await used.runtime.cancel(usedOp.id);
  assert.equal(kept.cleanup, 'kept');
  assert.deepEqual(used.discarded, [], 'work that exists is never deleted');
  assert.equal(used.records.has(usedOp.targetSessionId), true);
});

test('a restart during preparation re-reads the world and never creates twice', async () => {
  const first = setup();
  const op = await first.runtime.request('sh_1', 'tsk_a', { clientMsgId: 'm1' });
  assert.equal(first.created.length, 1);
  // Simulate a crash after the row was written but before `ready`: the same
  // store is reopened and preparation runs again.
  first.store.set('independent', op.id, { ...first.store.get('independent', op.id), state: 'preparing', phase: 'preparing' });
  const restarted = createIndependentContinuation({
    store: first.store,
    getRecord: id => first.records.get(id) || null,
    getHistory: id => first.history[id] || [],
    getExecution: async () => ({ busy: false, pending: null, queue: { queued: [] } }),
    createExecution: async () => { throw new Error('must not be called again'); },
    indexTask: async () => ({ ok: true }),
    ownerOf: () => first.store.get('shell', 'sh_1'),
    roles: { snapshot: () => 'roles-1' },
    hasCapacity: async () => true,
    ports: { captureIndependentBaseline: async () => ({ ok: true, commit: 'cafe1', branch: 'b', dirty: false, ahead: 0,
      sourceSessionId: 'conv-1', sourceWorkspace: '/tmp/wt', baseBranch: 'main' }) },
  });
  await restarted.tick();
  assert.equal(first.store.get('independent', op.id).state, 'ready');
  assert.equal(first.created.length, 1);
});

test('a shared execution is refused, a linked-but-foreign task is not addressable', async () => {
  const { runtime, store } = setup();
  await assert.rejects(async () => runtime.request('sh_1', 'tsk_missing', { clientMsgId: 'm1' }), { code: 'task_not_linked' });
  await assert.rejects(async () => runtime.request('sh_9', 'tsk_a', { clientMsgId: 'm1' }), { code: 'task_shell_not_found' });
  await assert.rejects(async () => runtime.request('sh_1', 'tsk_a', { clientMsgId: 'bad id!' }), { code: 'invalid_input' });
  store.set('task', 'tsk_a', { ...store.get('task', 'tsk_a'), sessionId: 'task-own' });
  await assert.rejects(async () => runtime.request('sh_1', 'tsk_a', { clientMsgId: 'm9' }), { code: 'already_independent' });
});

test('a running turn that ends later is picked up by the server-side tick', async () => {
  const { runtime, store, created, execution } = setup();
  execution.busy = true;
  const op = await runtime.request('sh_1', 'tsk_a', { clientMsgId: 'm1' });
  assert.equal(op.state, 'waiting');
  assert.equal(created.length, 0);
  execution.busy = false;
  await runtime.tick();
  assert.equal(store.get('independent', op.id).state, 'ready');
  assert.equal(created.length, 1);
});
