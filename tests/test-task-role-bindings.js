'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { fixture } = require('./helpers/task-shell');
const { createRoleBindings, prepareRoleContext } = require('../src/task-shell/role-bindings');

async function setup(t) {
  const f = fixture(t, { getDirectory: id => ({ id, rolePrompt: 'project role' }), unifiedAdmission: true });
  const task = await f.runtime.createStandalone({ dirId: 'd1', title: 'Task', clientMsgId: 'new', rolePrompt: 'initial role' });
  const send = id => f.runtime.send(task.shellId, { taskId: task.taskId, text: id, intent: 'work', clientMsgId: id });
  const roles = f.runtime.roles;
  return { ...f, task, roles, send };
}

test('role updates version once, preserve retry identity and do not create sessions or workspaces', async t => {
  const f = await setup(t), before = f.creations.length;
  const input = { expectedVersion: 0, clientMsgId: 'r1', bindings: [{ name: 'Reviewer', prompt: 'Review changes' }] };
  const result = f.roles.update(f.task.taskId, input);
  assert.equal(result.version, 1); assert.deepEqual(f.roles.update(f.task.taskId, input), result);
  assert.equal(f.creations.length, before); assert.equal(f.sends.length, 0);
  const other = createRoleBindings(f.store, f.ports);
  assert.throws(() => other.update(f.task.taskId, { ...input, clientMsgId: 'other' }), { code: 'role_version_conflict' });
  assert.throws(() => f.roles.update(f.task.taskId, { ...input, bindings: [] }), { code: 'idempotency_conflict' });
  assert.throws(() => f.roles.update(f.task.taskId, { ...input, bindings: [{ name: '', prompt: 'x' }] }), { code: 'invalid_role_binding' });
});

test('already queued messages retain their role snapshots while future messages get the new version', async t => {
  const f = await setup(t), one = await f.send('one');
  const first = f.store.get('receipt', one.receiptId);
  f.roles.update(f.task.taskId, { expectedVersion: 0, clientMsgId: 'r1', bindings: [{ name: 'New', prompt: 'new role' }] });
  const two = await f.send('two'), second = f.store.get('receipt', two.receiptId);
  assert.notEqual(first.roleSnapshotId, second.roleSnapshotId);
  assert.match(f.store.get('task-role:snapshot', first.roleSnapshotId).prompt, /initial role/);
  assert.match(f.store.get('task-role:snapshot', second.roleSnapshotId).prompt, /new role/);
  assert.deepEqual(f.store.get('receipt', one.receiptId), first);
});

test('native rotation preserves old handles, project memory and a bounded task history checkpoint', async t => {
  const f = await setup(t), sent = await f.send('one'), record = f.records.get(f.task.sessionId);
  Object.assign(record, { cliSessionId: 'old-native', _streamSessionId: 'old-stream', cliStates: { codex: { cliSessionId: 'old-native', model: 'model' }, claude: { cliSessionId: 'old-claude' } }, memory: ['keep memory'] });
  const live = { chatTurnCount: 5 }, calls = { closes: 0, mutations: 0 };
  const deps = { records: f.records, getState: () => live, hasBackground: () => false,
    closePersistent: async () => { calls.closes++; return { closed: true }; },
    persistence: { mutate: (_key, fn) => { calls.mutations++; fn(f.records); } },
    loadHistory: () => [{ id: 'u', role: 'user', taskId: f.task.taskId, content: 'keep context', turnId: 'old' }, { id: 'a', role: 'assistant', taskId: f.task.taskId, content: 'done context', turnId: 'old' }] };
  const descriptor = { sessionId: record.id, opts: { taskShellReceiptId: sent.receiptId } };
  await prepareRoleContext(f.store, descriptor, deps);
  assert.equal(record.cliSessionId, null); assert.equal(record.cliStates.claude.cliSessionId, null);
  assert.equal(record.cliStates.codex.model, 'model'); assert.deepEqual(record.memory, ['keep memory']);
  assert.equal(f.store.list('task-role:native-archive')[0].cliSessionId, 'old-native');
  assert.match(descriptor.opts.taskContextSeed, /keep context/); assert.equal(live.chatTurnCount, 0);
  record.cliSessionId = 'new-native'; live.chatTurnCount = 1;
  const same = { sessionId: record.id, opts: { taskShellReceiptId: sent.receiptId } };
  await prepareRoleContext(f.store, same, deps);
  assert.equal(calls.mutations, 1); assert.equal(record.cliSessionId, 'new-native'); assert.equal(same.opts.taskContextSeed, undefined);
  const next = await f.send('two');
  assert.equal(f.store.get('receipt', next.receiptId).roleSnapshotId, descriptor.opts.taskRoleSnapshotId,
    'compiled execution prompt cannot create a new role version on every message');
});

test('failed native close or background activity cannot mutate the active role/session', async t => {
  const f = await setup(t), sent = await f.send('one'), record = f.records.get(f.task.sessionId);
  record.cliSessionId = 'keep'; const descriptor = { sessionId: record.id, opts: { taskShellReceiptId: sent.receiptId } };
  const deps = { records: f.records, hasBackground: () => false, closePersistent: async () => ({ closed: false }), persistence: { mutate() { assert.fail('must not mutate'); } } };
  await assert.rejects(prepareRoleContext(f.store, descriptor, deps), { code: 'role_native_close_unverified' });
  deps.hasBackground = () => true;
  await assert.rejects(prepareRoleContext(f.store, descriptor, deps), { code: 'role_writer_busy' });
  assert.equal(record.cliSessionId, 'keep'); assert.equal(f.store.list('task-role:native-archive').length, 0);
});

test('removing all roles creates an explicit empty snapshot and does not re-inherit a directory role', async t => {
  const f = await setup(t); f.roles.update(f.task.taskId, { expectedVersion: 0, clientMsgId: 'clear', bindings: [] });
  const sent = await f.send('empty'), receipt = f.store.get('receipt', sent.receiptId);
  assert.equal(f.store.get('task-role:snapshot', receipt.roleSnapshotId).prompt, '');
  const record = f.records.get(f.task.sessionId);
  await prepareRoleContext(f.store, { sessionId: record.id, opts: { taskShellReceiptId: sent.receiptId } }, {
    records: f.records, getState: () => null, hasBackground: () => false, closePersistent: async () => ({ closed: true }),
    persistence: { mutate: (_key, fn) => fn(f.records) },
  });
  assert.doesNotMatch(record.rolePrompt, /initial role|project role/);
});

test('answers keep the role of the original pending run after newer work is queued', async t => {
  const f = await setup(t), first = await f.send('one');
  const oldRole = f.store.get('receipt', first.receiptId).roleSnapshotId;
  f.store.set('delivery:run', 'pending-turn', { binding: { receiptId: first.receiptId } });
  f.roles.update(f.task.taskId, { expectedVersion: 0, clientMsgId: 'r1', bindings: [{ name: 'New', prompt: 'new role' }] });
  await f.send('two');
  f.statuses.set(f.task.sessionId, { busy: true, turnId: 'pending-turn', pending: { taskId: f.task.taskId, requestId: 'question' } });
  const answer = await f.runtime.send(f.task.shellId, { taskId: f.task.taskId, text: 'answer', intent: 'answer', turnId: 'pending-turn', requestId: 'question', clientMsgId: 'answer' });
  assert.equal(f.store.get('receipt', answer.receiptId).roleSnapshotId, oldRole);
});
