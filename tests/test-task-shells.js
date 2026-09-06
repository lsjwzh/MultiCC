'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTaskShellStore } = require('../src/task-shell/store');
const { createTaskShellRuntime } = require('../src/task-shell/runtime');
const { snapshotHistory, verifySnapshot } = require('../src/task-shell/context');
const { createTaskShellHost } = require('../src/task-shell/host');

const { fixture } = require('./helpers/task-shell');
const input = (key, taskId = null, extra = {}) => ({ clientMsgId: key, taskId, intent: 'work', text: key, ...extra });

test('R01 R02: idle continues; occupied forks with new execution identity and no merge', async t => {
  const f = fixture(t);
  const first = await f.runtime.send(f.a.id, input('first'));
  const fork = await f.runtime.send(f.a.id, input('parallel', first.taskId));
  assert.notEqual(fork.taskId, first.taskId);
  const forkTask = f.store.get('task', fork.taskId);
  assert.equal(forkTask.parentTaskId, first.taskId);
  assert.notEqual(forkTask.sessionId, f.store.get('task', first.taskId).sessionId);
  f.statuses.set(forkTask.sessionId, { busy: false });
  const continued = await f.runtime.send(f.a.id, input('continue', fork.taskId));
  assert.equal(continued.taskId, fork.taskId);
  assert.equal(f.sends.at(-1).opts.originContinue, true, 'at-rest continuation must resume an E/W scheduler rather than park behind it');
  assert.equal(f.creations.length, 2);
});

test('R03 R04 R05: atomic reservations across shells and request-key isolation', async t => {
  const f = fixture(t);
  const first = await f.runtime.send(f.a.id, input('first'));
  f.runtime.link(f.b.id, first.taskId);
  f.statuses.clear();
  const [a, b] = await Promise.all([f.runtime.send(f.a.id, input('same-key', first.taskId)), f.runtime.send(f.b.id, input('same-key', first.taskId))]);
  assert.notEqual(a.taskId, b.taskId);
  assert.equal(a.taskId, first.taskId);
  const repeats = await Promise.all([f.runtime.send(f.b.id, input('same-key', first.taskId)), f.runtime.send(f.b.id, input('same-key', first.taskId))]);
  assert.equal(repeats[0].taskId, b.taskId);
  assert.equal(f.sends.length, 3);
  await assert.rejects(f.runtime.send(f.b.id, input('same-key', first.taskId, { text: 'different' })), { code: 'idempotency_conflict' });
});

test('C01 C02: immutable completed exchanges, provenance and tools; no active or failed output', () => {
  const history = [
    { id: 'u1', role: 'user', content: 'goal', turnId: 't1' },
    { id: 'a1', role: 'assistant', content: 'evidence', turnId: 't1', tools: [{ name: 'Read', result: 'proof' }] },
    { id: 'u2', role: 'user', content: 'live', turnId: 't2' },
    { id: 'a2', role: 'assistant', content: 'half', turnId: 't2', _interim: true },
    { id: 'a3', role: 'assistant', content: 'failed', turnId: 't2', partial: true },
  ];
  const snapshot = snapshotHistory('task1', history, { activeTurnId: 't2' });
  assert.deepEqual(snapshot.messages.map(m => m.id), ['u1', 'a1']);
  assert.equal(snapshot.messages[1].tools[0].result, 'proof');
  history[1].content = 'mutated';
  assert.equal(snapshot.messages[1].content, 'evidence');
  assert.equal(snapshot.hash.length, 64);
  assert.equal(verifySnapshot(snapshot, snapshot.hash), true);
  assert.equal(verifySnapshot({ ...snapshot, messages: [] }, snapshot.hash), false);
});

test('C03 C04: explicitly selected contexts are frozen; unfinished dependencies cannot run', async t => {
  const f = fixture(t);
  const a = await f.runtime.send(f.a.id, input('one'));
  const b = await f.runtime.send(f.a.id, input('two', a.taskId));
  for (const r of [a, b]) {
    const task = f.store.get('task', r.taskId);
    f.histories.set(task.sessionId, [{ id: 'u-' + r.taskId, role: 'user', content: 'question' }, { id: 'a-' + r.taskId, role: 'assistant', content: r.taskId }]);
  }
  await assert.rejects(f.runtime.send(f.a.id, input('dependent', null, { dependsOn: [a.taskId] })), { code: 'dependency_not_ready' });
  f.statuses.clear();
  const c = await f.runtime.send(f.a.id, input('three', null, { contextTaskIds: [a.taskId, b.taskId] }));
  const task = f.store.get('task', c.taskId);
  assert.equal(task.snapshotIds.length, 2);
  assert.ok(f.sends.at(-1).opts.taskContextSeed.includes(a.taskId));
  assert.ok(f.sends.at(-1).opts.taskContextSeed.includes(b.taskId));
  assert.equal(task.parentTaskId, null);
});

test('I01 I02: controls target exact turn/question; competing answers conflict, never fork', async t => {
  const f = fixture(t);
  const a = await f.runtime.send(f.a.id, input('one'));
  f.runtime.link(f.b.id, a.taskId);
  const task = f.store.get('task', a.taskId);
  f.statuses.set(task.sessionId, { busy: true, turnId: 'turn1', pending: { taskId: a.taskId, requestId: 'q1', turnId: 'turn1', question: 'Choose' } });
  await assert.rejects(f.runtime.send(f.a.id, input('stale', a.taskId, { intent: 'answer', requestId: 'old', turnId: 'turn1' })), { code: 'stale_control' });
  const answer = await f.runtime.send(f.a.id, input('answer', a.taskId, { intent: 'answer', requestId: 'q1', turnId: 'turn1' }));
  assert.equal(answer.taskId, a.taskId);
  await assert.rejects(f.runtime.send(f.b.id, input('different-answer', a.taskId, { intent: 'answer', requestId: 'q1', turnId: 'turn1' })), { code: 'answer_already_reserved' });
  assert.equal(f.creations.length, 1);
  await assert.rejects(f.runtime.send(f.a.id, input('cancel', a.taskId, { intent: 'cancel', turnId: 'old' })), { code: 'stale_control' });
});

test('F01 F03: creation failure and restart retain target and error; same-key retry repairs', async t => {
  let fail = true;
  const f = fixture(t, { createExecution: async task => {
    if (fail) throw new Error('worktree disk full');
    return { ok: true, baseline: { commit: 'abc' } };
  } });
  await assert.rejects(f.runtime.send(f.a.id, input('one')), /worktree disk full/);
  const before = f.store.list('receipt')[0];
  assert.equal(before.error.message, 'worktree disk full');
  const reopened = createTaskShellStore(f.file);
  const runtime = createTaskShellRuntime({ ...f.ports, store: reopened });
  fail = false;
  const result = await runtime.send(f.a.id, input('one'));
  assert.equal(result.taskId, before.taskId);
  assert.equal(reopened.list('task').length, 1);
  reopened.close();
});

test('S01 S02 S03: project boundary, detach preserves tasks, disabled experiment rejects writes', async t => {
  const f = fixture(t);
  const first = await f.runtime.send(f.a.id, input('one'));
  const other = f.runtime.open('other');
  assert.throws(() => f.runtime.link(other.id, first.taskId), { code: 'project_mismatch' });
  f.runtime.link(f.b.id, first.taskId);
  f.runtime.remove(f.a.id);
  assert.ok(f.store.get('task', first.taskId));
  assert.equal(f.runtime.view(f.b.id).tasks.length, 1);
  const disabled = createTaskShellRuntime({ ...f.ports, enabled: () => false });
  await assert.rejects(disabled.send(f.b.id, input('disabled')), { code: 'experiment_disabled' });
  assert.equal(disabled.view(f.b.id).tasks.length, 1);
});

test('I03: unmanaged delivery is rejected; original-task host continuations and validated receipts pass', async t => {
  const f = fixture(t), first = await f.runtime.send(f.a.id, input('work'));
  assert.equal(f.runtime.guardAdmission(first.sessionId, 'bypass', {}).code, 'task_shell_route_required');
  assert.equal(f.runtime.guardAdmission(first.sessionId, 'bypass', { taskId: 'another', originContinue: true }).code, 'task_identity_mismatch');
  const options = { originContinue: true };
  assert.equal(f.runtime.guardAdmission(first.sessionId, 'callback', options), null);
  assert.equal(options.taskId, first.taskId);
  const delivered = f.sends[0];
  assert.equal(f.runtime.guardAdmission(first.sessionId, delivered.text, delivered.opts), null);
  assert.equal(f.runtime.guardAdmission(first.sessionId, 'modified', delivered.opts).code, 'task_shell_route_required');
});

test('F02: lost acceptance uses the same downstream idempotency key across restart', async t => {
  const accepted = new Set(), attempts = [];
  let lost = true;
  const f = fixture(t, { send: async (_id, _text, opts) => {
    attempts.push(opts.idempotencyKey); accepted.add(opts.idempotencyKey);
    if (lost) throw new Error('acceptance response lost');
    return { ok: true };
  } });
  await assert.rejects(f.runtime.send(f.a.id, input('work')), /acceptance response lost/);
  const receipt = f.store.list('receipt')[0]; lost = false;
  const restarted = createTaskShellRuntime(f.ports);
  const result = await restarted.retry(f.a.id, receipt.id);
  assert.equal(result.taskId, receipt.taskId);
  assert.equal(accepted.size, 1); assert.equal(attempts.length, 2);
  assert.equal(f.creations.length, 1);
});

test('reserved answer blocks a simultaneous different answer before asynchronous delivery', async t => {
  const f = fixture(t), task = await f.runtime.send(f.a.id, input('work'));
  f.runtime.link(f.b.id, task.taskId);
  f.statuses.set(task.sessionId, { busy: true, turnId: 't1', pending: { requestId: 'q1', taskId: task.taskId, turnId: 't1' } });
  const answers = await Promise.allSettled([
    f.runtime.send(f.a.id, input('yes', task.taskId, { intent: 'answer', turnId: 't1', requestId: 'q1' })),
    f.runtime.send(f.b.id, input('no', task.taskId, { intent: 'answer', turnId: 't1', requestId: 'q1' })),
  ]);
  assert.equal(answers.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(answers.find(r => r.status === 'rejected').reason.code, 'answer_already_reserved');
});

test('bounded concurrent work retains a capacity-rejected receipt for same-target retry', async t => {
  const f = fixture(t, { maxConcurrent: 2 });
  await f.runtime.send(f.a.id, input('one'));
  await f.runtime.send(f.a.id, input('two'));
  await assert.rejects(f.runtime.send(f.a.id, input('three')), { code: 'task_shell_capacity' });
  const receipt = f.store.list('receipt').find(r => r.payload.text === 'three');
  assert.equal(f.creations.length, 2);
  f.statuses.clear();
  const retried = await f.runtime.retry(f.a.id, receipt.id);
  assert.equal(retried.taskId, receipt.taskId);
  assert.equal(f.creations.length, 3);
});

test('missing experiment state blocks native writes only for experiment-owned execution IDs', t => {
  const f = fixture(t);
  const previous = process.env.MULTICC_TASK_SHELLS;
  delete process.env.MULTICC_TASK_SHELLS;
  t.after(() => { if (previous === undefined) delete process.env.MULTICC_TASK_SHELLS; else process.env.MULTICC_TASK_SHELLS = previous; });
  const sid = 'task-1234567890abcdef1234567890abcdef';
  f.records.set(sid, { taskBoundTaskId: 'tsk_1234567890abcdef1234567890abcdef' });
  const host = createTaskShellHost({ file: f.file + '.missing', records: f.records });
  assert.equal(host.guardAdmission(sid, 'bypass', {}).code, 'task_shell_state_unavailable');
  assert.ok(host.owns(sid));
  assert.equal(host.guardAdmission('a', 'ordinary', {}), null);
  assert.throws(() => host.contextSeed(sid, '', true), { code: 'task_shell_state_unavailable' });
  host.close();
});
