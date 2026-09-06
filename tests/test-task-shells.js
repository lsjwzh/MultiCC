'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTaskShellStore } = require('../src/task-shell/store');
const { createTaskShellRuntime } = require('../src/task-shell/runtime');
const { renderLazyContextPrompt, snapshotHistory, verifySnapshot } = require('../src/task-shell/context');
const { createTaskShellHost } = require('../src/task-shell/host');

const { fixture } = require('./helpers/task-shell');
const input = (key, taskId = null, extra = {}) => ({ clientMsgId: key, taskId, intent: 'work', text: key, ...extra });

test('R01 R02: idle and occupied work both continue the server-authoritative current task', async t => {
  const f = fixture(t);
  const first = await f.runtime.send(f.a.id, input('first'));
  const queued = await f.runtime.send(f.a.id, input('parallel', first.taskId));
  assert.equal(queued.taskId, first.taskId);
  assert.equal(queued.decision, 'queued');
  assert.equal(f.sends.at(-1).opts.originContinue, true);
  f.statuses.set(first.sessionId, { busy: false });
  const continued = await f.runtime.send(f.a.id, input('continue'));
  assert.equal(continued.taskId, first.taskId);
  assert.equal(f.sends.at(-1).opts.originContinue, true, 'at-rest continuation must resume an E/W scheduler rather than park behind it');
  assert.equal(f.creations.length, 1);
});

test('R03 R04 R05: atomic reservations across shells and request-key isolation', async t => {
  const f = fixture(t);
  const first = await f.runtime.send(f.a.id, input('first'));
  f.runtime.link(f.b.id, first.taskId);
  f.statuses.clear();
  const [a, b] = await Promise.all([f.runtime.send(f.a.id, input('same-key', first.taskId)), f.runtime.send(f.b.id, input('same-key', first.taskId))]);
  assert.equal(a.taskId, b.taskId);
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

test('lazy context prompt requires evidence on demand and preserves side-effect ownership', () => {
  const prompt = renderLazyContextPrompt('tsk_current');
  assert.match(prompt, /get_task_context/);
  assert.match(prompt, /不要猜测缺失上下文/);
  assert.match(prompt, /副作用操作/);
  assert.match(prompt, /tsk_current/);
});

test('C03 C04: explicitly selected contexts are frozen; unfinished dependencies cannot run', async t => {
  const f = fixture(t);
  const a = await f.runtime.send(f.a.id, input('one'));
  const b = await f.runtime.send(f.a.id, input('two', null, { newTask: true }));
  for (const r of [a, b]) {
    const task = f.store.get('task', r.taskId);
    f.histories.set(task.sessionId, [{ id: 'u-' + r.taskId, role: 'user', content: 'question' }, { id: 'a-' + r.taskId, role: 'assistant', content: r.taskId }]);
  }
  await assert.rejects(f.runtime.send(f.a.id, input('dependent', null, { dependsOn: [a.taskId] })), { code: 'dependency_not_ready' });
  f.statuses.clear();
  const c = await f.runtime.send(f.a.id, input('three', null, { newTask: true, contextTaskIds: [a.taskId, b.taskId] }));
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

test('S01 S02 S03: project boundary and detach preserve tasks', async t => {
  const f = fixture(t);
  const first = await f.runtime.send(f.a.id, input('one'));
  const other = f.runtime.open('other');
  assert.throws(() => f.runtime.link(other.id, first.taskId), { code: 'project_mismatch' });
  f.runtime.link(f.b.id, first.taskId);
  f.runtime.remove(f.a.id);
  assert.ok(f.store.get('task', first.taskId));
  assert.equal(f.runtime.view(f.b.id).tasks.length, 1);
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
  await f.runtime.send(f.a.id, input('two', null, { newTask: true }));
  await assert.rejects(f.runtime.send(f.a.id, input('three', null, { newTask: true })), { code: 'task_shell_capacity' });
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

test('adoption preserves native identity/history and continues through a receipt without a new execution', async t => {
  const f = fixture(t);
  f.records.get('a').cli = 'zcode';
  f.records.get('a').cliSessionId = 'sess_real_native';
  f.histories.set('a', [
    { id: 'u1', role: 'user', content: 'old question', taskId: 'tsk_old', taskName: '真实历史任务' },
    { id: 'a1', role: 'assistant', content: 'old result', taskId: 'tsk_old', taskName: '真实历史任务' },
  ]);
  const before = structuredClone({ record: f.records.get('a'), history: f.histories.get('a') });
  const task = f.runtime.adopt(f.a.id, 'a');
  assert.equal(task.id, 'tsk_old');
  assert.equal(task.title, '真实历史任务');
  assert.equal(task.sessionId, 'a');
  assert.equal(f.runtime.adopt(f.a.id, 'a').id, task.id);
  assert.equal(f.runtime.view(f.a.id).defaultTaskId, task.id);
  const sent = await f.runtime.send(f.a.id, input('continue-old', task.id));
  assert.equal(sent.sessionId, 'a');
  assert.equal(sent.decision, 'continue');
  assert.equal(f.creations.length, 0);
  assert.equal(f.sends[0].opts.taskShellReceiptId, sent.receiptId);
  assert.deepEqual({ record: f.records.get('a'), history: f.histories.get('a') }, before);
  const queued = await f.runtime.send(f.a.id, input('additional-work', task.id));
  assert.equal(queued.decision, 'queued');
  assert.equal(queued.sessionId, 'a');
  assert.equal(f.creations.length, 0);
});

test('trusted task delivery auto-locates by task id or creates that exact task identity', async t => {
  const boardTasks = {
    'tsk-routed': { id: 'tsk-routed', title: '路由任务标题' },
  };
  const f = fixture(t, { getTask: id => boardTasks[id] || null });
  f.runtime.adopt(f.a.id, 'a');
  const result = await f.runtime.sendExplicit(f.a.id, input('routed-message'), {
    taskId: 'tsk-routed', taskStart: true, taskSource: 'router-tool', taskText: '完整任务信息',
  });
  assert.equal(result.taskId, 'tsk-routed');
  assert.equal(f.runtime.view(f.a.id).currentTaskId, 'tsk-routed');
  assert.equal(f.store.get('task', 'tsk-routed').title, '路由任务标题');
  assert.equal(f.creations.at(-1).task.id, 'tsk-routed');
  assert.equal(f.sends.at(-1).opts.taskShellAutoClassify, false);
  assert.equal(f.sends.at(-1).opts.taskSource, 'task-shell');
  assert.equal(f.sends.at(-1).opts.taskText, '完整任务信息');
  assert.equal(f.runtime.locateOrCreate(f.b.id, {
    taskId: 'tsk-routed', taskText: '不会覆盖任务板标题',
  }).sessionId, result.sessionId);
});

test('current task advances only through explicit new work or settled attribution', async t => {
  const f = fixture(t);
  const first = await f.runtime.send(f.a.id, input('first'));
  f.statuses.set(first.sessionId, { busy: false });
  const second = await f.runtime.send(f.a.id, input('second', null, { newTask: true }));
  assert.notEqual(second.taskId, first.taskId);
  assert.equal(f.runtime.view(f.a.id).currentTaskId, second.taskId);
  f.histories.set(second.sessionId, [
    { id: 'u-next', role: 'user', content: 'different topic', taskId: 'tsk_classified', turnId: 'turn-next' },
    { id: 'a-next', role: 'assistant', content: 'result', taskId: 'tsk_classified', turnId: 'turn-next' },
  ]);
  const settled = f.runtime.settleAttribution(second.sessionId, second.receiptId, {
    taskId: 'tsk_classified', taskName: 'Classified task', relation: 'new',
  });
  assert.equal(settled.changed, true);
  assert.equal(f.runtime.view(f.a.id).currentTaskId, 'tsk_classified');
  assert.equal(f.store.get('task', 'tsk_classified').snapshotIds.length, 1);
});

test('lazy shell context refill returns provenance and clears the displayed token saving', async t => {
  const f = fixture(t);
  const first = await f.runtime.send(f.a.id, input('first'));
  f.histories.set(first.sessionId, [
    { id: 'u1', role: 'user', content: 'old requirement', taskId: first.taskId, turnId: 't1' },
    { id: 'a1', role: 'assistant', content: 'old result', taskId: first.taskId, turnId: 't1' },
  ]);
  f.statuses.set(first.sessionId, { busy: false });
  const second = await f.runtime.send(f.a.id, input('second', null, { newTask: true }));
  assert.doesNotMatch(f.sends.at(-1).opts.taskContextSeed, /old result/,
    'the lazy arm must not preload another task history');
  const before = f.runtime.view(f.a.id).tokenSavings;
  assert.ok(before.estimatedTokens > 0);
  assert.equal(before.contextRefilled, false);
  const refill = f.runtime.refillContext(second.sessionId, { receiptId: second.receiptId });
  assert.deepEqual(refill.task_ids, [first.taskId]);
  assert.match(refill.context, /old result/);
  assert.deepEqual(f.runtime.refillContext(second.sessionId, { receiptId: second.receiptId }), refill,
    'repeated read-only refill must be idempotent');
  const after = f.runtime.view(f.a.id).tokenSavings;
  assert.equal(after.contextRefilled, true);
  assert.equal(after.estimatedTokens, 0);
  assert.equal(after.originalEstimatedTokens, before.estimatedTokens);
});

test('adoption preserves a pending question identity and rejects stale controls', async t => {
  const f = fixture(t);
  const pending = { taskId: 'tsk_pending', requestId: 'question1', turnId: 'turn1' };
  f.records.get('a').taskState = { pendingUserInput: pending };
  f.statuses.set('a', { busy: true, turnId: pending.turnId, pending });
  const task = f.runtime.adopt(f.a.id, 'a');
  assert.equal(task.id, pending.taskId);
  await assert.rejects(f.runtime.send(f.a.id, input('old-answer', task.id, { intent: 'answer', requestId: 'old', turnId: 'turn1' })), { code: 'stale_control' });
  const answer = await f.runtime.send(f.a.id, input('answer', task.id, { intent: 'answer', requestId: pending.requestId, turnId: pending.turnId }));
  assert.equal(answer.sessionId, 'a');
  assert.equal(f.creations.length, 0);
  assert.equal(f.runtime.guardAdmission('a', 'old durable message', { receivedAt: task.createdAt - 1 }), null);
  assert.equal(f.runtime.guardAdmission('a', 'new bypass', { receivedAt: task.createdAt + 1 }).code, 'task_shell_route_required');
});

test('missing or zero legacy switch cannot disable the host', t => {
  const f = fixture(t), previous = process.env.MULTICC_TASK_SHELLS;
  t.after(() => { if (previous === undefined) delete process.env.MULTICC_TASK_SHELLS; else process.env.MULTICC_TASK_SHELLS = previous; });
  for (const value of [undefined, '0']) {
    if (value === undefined) delete process.env.MULTICC_TASK_SHELLS; else process.env.MULTICC_TASK_SHELLS = value;
    const host = createTaskShellHost({ file: f.file, records: f.records, loadHistory: id => f.histories.get(id) || [] });
    try { assert.equal(host.open('a').enabled, true); } finally { host.close(); }
  }
});

test('goal limits survive normalized receipt retry without changing the message key', async t => {
  let fail = true;
  const seen = [];
  const f = fixture(t, { send: async (_id, _text, options) => {
    seen.push(options);
    if (fail) throw new Error('response lost');
    return { ok: true };
  } });
  await assert.rejects(f.runtime.send(f.a.id, input('goal', null, { goal: true, goalLimits: { maxRounds: 4, maxBudget: 1000 } })));
  const receipt = f.store.list('receipt')[0];
  fail = false;
  await f.runtime.retry(f.a.id, receipt.id);
  assert.deepEqual(seen[0].goalLimits, { maxRounds: 4, maxBudget: 1000 });
  assert.deepEqual(seen[1].goalLimits, seen[0].goalLimits);
  assert.equal(seen[1].idempotencyKey, seen[0].idempotencyKey);
});
