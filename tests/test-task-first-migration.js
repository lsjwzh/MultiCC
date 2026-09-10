'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { fixture } = require('./helpers/task-shell');
const { createTaskShellRuntime } = require('../src/task-shell/runtime');
const { createShellWorkspaceHost } = require('../src/task-shell/workspace');

test('role sessions become task entries without changing native handles, pending input, history or dirty files', async t => {
  let indexed = 0;
  const f = fixture(t, { taskFirst: true, getDirectory: id => ({ id }), indexTask: () => { indexed++; return { ok: true }; } });
  const root = path.dirname(f.file), file = path.join(root, 'unmerged.txt'); fs.writeFileSync(file, 'unmerged work');
  Object.assign(f.records.get('a'), { type: 'worker', label: 'Designer', rolePrompt: 'Design role',
    worktreePath: root, branch: 'multicc/legacy', cliSessionId: 'native-a', cliStates: { codex: { cliSessionId: 'native-a' } },
    taskState: { pendingUserInput: { taskId: 'tsk_waiting', requestId: 'q1', turnId: 'run1', resolved: false } } });
  f.histories.set('a', [{ id: 'm', role: 'assistant', taskId: 'tsk_waiting', content: 'Existing work' }]);
  const before = JSON.stringify([...f.records]), history = JSON.stringify([...f.histories]);
  const result = await f.runtime.migrateTaskSessions([...f.records.values()]);
  assert.equal(result.ok, true);
  const task = f.runtime.owns('a'); assert.equal(task.id, 'tsk_waiting'); assert.equal(task.sessionId, 'a');
  assert.equal((await f.runtime.taskEntry(task.id)).readOnly, false);
  assert.equal(f.runtime.roles.current(task.id).bindings[0].prompt, 'Design role');
  assert.equal(JSON.stringify([...f.records]), before); assert.equal(JSON.stringify([...f.histories]), history);
  assert.equal(fs.readFileSync(file, 'utf8'), 'unmerged work'); assert.equal(f.creations.length, 0); assert.equal(f.sends.length, 0);
  const count = indexed, taskIds = f.store.list('task').map(t => t.id);
  await createTaskShellRuntime(f.ports).migrateTaskSessions([...f.records.values()]);
  assert.equal(indexed, count); assert.deepEqual(f.store.list('task').map(t => t.id), taskIds);
});

test('migration reports identity conflicts and failed indexes without deleting or hiding their evidence', async t => {
  let fail = true;
  const f = fixture(t, { getDirectory: id => ({ id }), indexTask: () => ({ ok: !fail, error: 'disk_full' }) });
  const first = await f.runtime.migrateTaskSessions([...f.records.values()]);
  assert.equal(first.ok, false); assert.equal(first.errors.length, 3); assert.equal(first.migrated.length, 0);
  assert.equal(f.records.size, 3); assert.equal(f.store.list('task').length, 3);
  fail = false;
  assert.equal((await f.runtime.migrateTaskSessions([...f.records.values()])).ok, true);
  const original = f.runtime.owns('a');
  f.records.set('conflict', { id: 'conflict', kind: 'chat', dirId: 'd1', taskBoundTaskId: original.id });
  const conflict = await f.runtime.migrateTaskSessions([...f.records.values()]);
  assert.equal(conflict.errors[0].code, 'task_identity_mismatch');
  assert.equal(f.records.has('conflict'), true); assert.equal(f.store.get('task', original.id).sessionId, 'a');
});

test('explicit task input can continue a migrated historical task without using another task cursor', async t => {
  const f = fixture(t, { taskFirst: true, getDirectory: id => ({ id }) });
  const a = f.runtime.adopt(f.a.id, 'a');
  const b = await f.runtime.send(f.a.id, { text: 'New goal', clientMsgId: 'b', newTask: true });
  f.statuses.set(b.sessionId, { busy: false });
  await f.runtime.migrateTaskSessions([...f.records.values()]);
  assert.equal((await f.runtime.taskEntry(a.id)).readOnly, false);
  const result = await f.runtime.sendExplicit(f.a.id, { text: 'Continue A', clientMsgId: 'a' }, { taskId: a.id, taskStart: true });
  assert.equal(result.taskId, a.id); assert.equal(result.sessionId, 'a');
  assert.equal(f.sends.at(-1).id, 'a');
});

test('task-first preparation retains existing workspace references instead of moving them into a role workspace', async () => {
  let touched = false;
  const host = createShellWorkspaceHost({ records: { get: () => { touched = true; throw new Error('must not rebind'); } } });
  await host.prepareExecution({ id: 't', taskFirst: true }, { sourceSessionId: 'old-role', standalone: false });
  assert.equal(touched, false);
});

test('opening a planned board task keeps its identity and creates metadata once without starting work', async t => {
  const board = { id: 'tsk_plan', dirId: 'd1', title: 'Implement task', origin: 'board', refs: [] };
  const f = fixture(t, { getDirectory: id => ({ id }), getTask: id => id === board.id ? board : null, defaultTaskRuntime: () => ({ cli: 'codex' }) });
  const [a, b] = await Promise.all([f.runtime.bindPlannedTask(board.id), f.runtime.bindPlannedTask(board.id)]);
  assert.equal(a.task.id, board.id); assert.deepEqual(a, b); assert.equal(f.creations.length, 1);
  assert.equal(a.readOnly, false); assert.equal(f.sends.length, 0);
  assert.equal(f.creations[0].source.cli, 'codex');
  assert.equal(f.store.get('task', board.id).taskFirst, true);
  assert.equal(f.store.get('task', board.id).ownerShellId, a.ownerShellId);
  await f.runtime.bindPlannedTask(board.id); assert.equal(f.creations.length, 1);
});

test('planned execution retries a failed task index without creating duplicate metadata', async t => {
  let fail = true, indexes = 0;
  const board = { id: 'tsk_retry', dirId: 'd1', title: 'Retry', origin: 'board' };
  const f = fixture(t, { getDirectory: id => ({ id }), getTask: id => id === board.id ? board : null,
    indexTask: () => { indexes++; return { ok: !fail }; } });
  await assert.rejects(f.runtime.bindPlannedTask(board.id), { code: 'task_index_failed' });
  assert.equal(f.store.get('task', board.id).bindingPending, true);
  fail = false;
  await f.runtime.bindPlannedTask(board.id);
  assert.equal(indexes, 2); assert.equal(f.creations.length, 1);
  assert.equal(f.store.get('task', board.id).bindingPending, undefined);
});

test('legacy commander is adopted as a task while its existing execution and role stay intact', async t => {
  const f = fixture(t, { taskFirst: true, getDirectory: id => ({ id }) });
  f.records.set('commander', { id: 'commander', kind: 'chat', type: 'commander', dirId: 'd1', rolePrompt: 'Coordinate tasks', cliSessionId: 'native-commander' });
  const result = await f.runtime.migrateTaskSessions([...f.records.values()]);
  assert.equal(result.ok, true);
  const task = f.runtime.owns('commander'); assert.ok(task);
  assert.equal((await f.runtime.taskEntry(task.id)).readOnly, false);
  assert.equal(f.runtime.roles.current(task.id).bindings[0].prompt, 'Coordinate tasks');
  assert.equal(f.records.get('commander').cliSessionId, 'native-commander');
  assert.equal(f.creations.length, 0);
});
