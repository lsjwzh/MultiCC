'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/task-shell');
const { createTaskShellRuntime } = require('../src/task-shell/runtime');
const input = (clientMsgId, extra = {}) => ({ clientMsgId, text: clientMsgId, ...extra });

test('SW01: A -> B -> A -> B keeps each native identity and routes normal followups to the selected task', async t => {
  const f = fixture(t);
  const a = f.runtime.adopt(f.a.id, 'a');
  await f.runtime.send(f.a.id, input('A-first'));
  f.statuses.set('a', { busy: false });
  const b = await f.runtime.send(f.a.id, input('B-first', { newTask: true }));
  f.statuses.set(b.sessionId, { busy: false });
  for (const [taskId, sessionId, key] of [[a.id, 'a', 'A-again'], [b.taskId, b.sessionId, 'B-again']]) {
    f.runtime.resolveTask(f.a.id, { taskId });
    const sent = await f.runtime.send(f.a.id, input(key));
    assert.equal(sent.taskId, taskId); assert.equal(sent.sessionId, sessionId);
    assert.equal(f.sends.at(-1).id, sessionId);
    f.statuses.set(sessionId, { busy: false });
  }
  assert.equal(f.creations.length, 1, 'switching must not create extra execution sessions');
  const restarted = createTaskShellRuntime(f.ports);
  const resumed = await restarted.send(f.a.id, input('B-after-restart'));
  assert.equal(resumed.taskId, b.taskId); assert.equal(resumed.sessionId, b.sessionId);
});

test('SW02: previewing old task A while B is selected cannot change B or reserve work', async t => {
  const f = fixture(t), a = f.runtime.adopt(f.a.id, 'a');
  f.histories.set('a', [{ id: 'a1', role: 'user', taskId: a.id, content: 'A evidence' }]);
  const b = await f.runtime.send(f.a.id, input('B', { newTask: true }));
  const cursor = f.runtime.view(f.a.id).cursorVersion;
  const entry = await f.runtime.taskEntry(a.id);
  assert.equal(entry.readOnly, true); assert.equal(entry.messages[0].content, 'A evidence');
  assert.equal(f.runtime.view(f.a.id).currentTaskId, b.taskId);
  assert.equal(f.runtime.view(f.a.id).cursorVersion, cursor);
  assert.throws(() => f.runtime.assertBoardWritable(a.id), { code: 'task_board_read_only' });
  assert.equal(f.sends.length, 1);
});

test('FK01: fork old A while B is selected; original A/B remain usable and fork snapshot is immutable', async t => {
  const f = fixture(t, { captureForkBaseline: async () => ({ commit: 'a'.repeat(40) }) });
  const a = f.runtime.adopt(f.a.id, 'a');
  f.histories.set('a', [{ id: 'a1', role: 'user', taskId: a.id, content: 'A before fork' }]);
  const b = await f.runtime.send(f.a.id, input('B', { newTask: true }));
  f.statuses.set(b.sessionId, { busy: false });
  const fork = await f.runtime.forkTask(a.id, { clientMsgId: 'fork-A' });
  assert.equal(f.runtime.view(f.a.id).currentTaskId, b.taskId);
  assert.equal(f.sends.length, 1, 'fork creation must not invoke the model');
  const forkTask = f.store.get('task', fork.taskId);
  const frozen = f.store.get('snapshot', forkTask.snapshotIds[0]);
  f.runtime.resolveTask(f.a.id, { taskId: a.id });
  const original = await f.runtime.send(f.a.id, input('A-after-fork'));
  f.histories.get('a').push({ id: 'a2', role: 'user', taskId: a.id, content: 'A after fork' });
  assert.equal(original.sessionId, 'a');
  const independent = await f.runtime.sendExplicit(fork.shellId, input('fork-continue'), { taskId: fork.taskId, taskStart: true });
  assert.equal(independent.sessionId, fork.sessionId); assert.notEqual(independent.sessionId, original.sessionId);
  assert.equal(f.runtime.taskAccess(a.id).readOnly, true);
  assert.equal(f.runtime.taskAccess(fork.taskId).readOnly, false);
  assert.deepEqual(f.store.get('snapshot', forkTask.snapshotIds[0]), frozen);
  assert.equal((await f.runtime.taskEntry(fork.taskId)).messages.some(m => m.content === 'A after fork'), false);
  const restarted = createTaskShellRuntime(f.ports);
  assert.deepEqual(await restarted.forkTask(a.id, { clientMsgId: 'fork-A' }), fork);
  assert.equal(f.store.list('task').length, 3, 'retry after restart must not add another task');
});

test('Task Center can read historical tasks whose source is an internal execution slot or experimental session', async t => {
  const f = fixture(t);
  for (const [id, flags] of [['slot', { taskExecutionSlot: true }], ['experimental', { experimentalMode: 'legacy' }]]) {
    f.records.set(id, { id, kind: 'chat', dirId: 'd1', ...flags });
    const task = { id: `tsk_${id}`, refs: [{ sessionId: id }] };
    const shellsBefore = f.store.list('shell').length;
    assert.equal(f.runtime.taskAccess(task).ownerShellId, null);
    assert.equal(f.runtime.taskAccess(task).readOnly, true);
    assert.equal(f.store.list('shell').length, shellsBefore, 'reading an unsupported source must not create a shell');
    assert.throws(() => f.runtime.open(id), { code: 'unsupported_source' }, 'execution entry remains restricted');
  }
  assert.equal(f.runtime.taskAccess({ id: 'tsk_ordinary', refs: [{ sessionId: 'a' }] }).ownerShellId, f.a.id);
});
