'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { fixture } = require('./helpers/task-shell');
function airFixture(t) {
  const f = fixture(t, { getDirectory: id => id === 'd1' ? { id } : null, unifiedAdmission: true });
  f.ports.createExecution = async task => {
    f.creations.push(task.id); f.records.set(task.sessionId, { id: task.sessionId, kind: 'chat', dirId: task.dirId,
      cli: task.runtime.cli, taskBoundTaskId: task.id, workspaceState: 'planned' });
    return { ok: true, baseline: null };
  };
  // Runtime captured the original factory: use its fixture implementation,
  // then annotate the created metadata as production's planned factory does.
  const { createTaskShellRuntime } = require('../src/task-shell/runtime');
  f.runtime = createTaskShellRuntime(f.ports); return f;
}
test('Air creates canonical standalone task metadata and repeated requests return the same task', async t => {
  const f = airFixture(t), input = { dirId: 'd1', title: 'New UI', cli: 'codex', clientMsgId: 'create-1' };
  const [a, b] = await Promise.all([f.runtime.createStandalone(input), f.runtime.createStandalone(input)]);
  assert.deepEqual(a, b); assert.equal(f.creations.length, 1); assert.equal(f.sends.length, 0);
  const entry = await f.runtime.taskEntry(a.taskId); assert.equal(entry.readOnly, false);
  assert.equal(entry.task.title, 'New UI'); assert.equal(f.records.get(a.sessionId).workspaceState, 'planned');
  assert.equal(f.store.get('task', a.taskId).baseline, null);
  await assert.rejects(f.runtime.createStandalone({ ...input, title: 'Changed' }), { code: 'idempotency_conflict' });
});
test('Air tasks accept queued work through the existing canonical receipt protocol', async t => {
  const f = airFixture(t), created = await f.runtime.createStandalone({ dirId: 'd1', title: 'Task', clientMsgId: 'a' });
  const input = { text: 'Implement', taskId: created.taskId, clientMsgId: 'message-1', intent: 'work' };
  const result = await f.runtime.send(created.shellId, input);
  assert.equal(result.taskId, created.taskId); assert.equal(f.sends[0].opts.taskId, created.taskId);
  await f.runtime.send(created.shellId, input); assert.equal(f.sends.length, 1);
});
test('invalid directory/title cannot create tasks or execution records', async t => {
  const f = airFixture(t);
  for (const input of [{ dirId: 'unknown', title: 'X' }, { dirId: 'd1', title: '' }, { dirId: 'd1', title: 'x'.repeat(121) }]) {
    await assert.rejects(f.runtime.createStandalone({ ...input, clientMsgId: 'invalid' }), { code: 'invalid_input' });
  }
  assert.equal(f.creations.length, 0); assert.equal(f.store.list('task').length, 0);
});
test('many Air task records do not start any work and retain separate roles', async t => {
  const f = airFixture(t);
  for (let i = 0; i < 20; i++) await f.runtime.createStandalone({ dirId: 'd1', title: `Task ${i}`, clientMsgId: `a-${i}`, rolePrompt: `Role ${i}` });
  assert.equal(f.store.list('task').length, 20); assert.equal(f.sends.length, 0);
  assert.equal(f.store.list('task')[1].runtime.rolePrompt, 'Role 1');
});
test('online attribution candidates do not create task B or rewrite the original receipt', async t => {
  const f = airFixture(t), created = await f.runtime.createStandalone({ dirId: 'd1', title: 'Source', clientMsgId: 'src' });
  const sent = await f.runtime.send(created.shellId, { text: 'Work', taskId: created.taskId, intent: 'work', clientMsgId: 'm' });
  const { createCandidateStore } = require('../src/task-routing/candidates'), candidates = createCandidateStore(f.store);
  const before = f.runtime.view(created.shellId), original = f.store.get('receipt', sent.receiptId);
  const candidate = candidates.propose(created.sessionId, sent.receiptId, { taskId: 'tsk_new_candidate', taskName: 'New goal', turnId: 'turn1' });
  assert.equal(candidate.pending, true); assert.equal(candidate.candidate.state, 'pending');
  assert.equal(f.store.get('task', 'tsk_new_candidate'), null);
  assert.deepEqual(f.store.get('receipt', sent.receiptId), original);
  assert.equal(f.runtime.view(created.shellId).currentTaskId, before.currentTaskId);
  await f.runtime.send(created.shellId, { text: 'New input', taskId: created.taskId, intent: 'work', clientMsgId: 'm2' });
  assert.equal(candidates.latest(created.taskId).state, 'stale');
});
test('Air list resolves legacy reference directories and never includes provider credentials', async () => {
  const { mountAirRoutes } = require('../src/workspace/air-routes');
  const handlers = new Map(), app = { get: (p, fn) => handlers.set(p, fn), post() {} };
  mountAirRoutes(app, { admission: { snapshot: () => ({ workspaces: [], leases: [], budgets: {} }) },
    records: new Map([['s', { id: 's', dirId: 'd1', kind: 'chat', providerSecret: 'private' }]]),
    directories: new Map([['d1', { id: 'd1', name: 'Repo', path: '/repo' }]]),
    getBoard: () => ({ modules: {}, tasks: { t: { id: 't', chatSessionId: 's', title: 'Legacy', refs: [{ sessionId: 's', dirId: 'd1' }] } } }),
    clis: ['codex'], shell: { taskAccess: () => ({ readOnly: true }) } });
  let response; await handlers.get('/api/air')({}, { json: v => { response = v; }, status() { return this; } });
  assert.equal(response.tasks[0].dirId, 'd1'); assert.equal(JSON.stringify(response).includes('private'), false);
});
