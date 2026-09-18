'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/task-shell');
const { createTaskOperations } = require('../src/task-shell/task-operations');
const { createAttributionDecisions } = require('../src/task-shell/attribution-decisions');
const { mountTaskShellRoutes } = require('../src/task-shell/routes');

const input = (clientMsgId, extra = {}) => ({ clientMsgId, text: clientMsgId, ...extra });

// A conversation with one turn (`turn-1`) already attributed to its first task.
// Everything below is about what the host is allowed to do with a verdict that
// says that turn belongs somewhere else.
async function setup(t, { mode = 'suggest', turnId = 'turn-1' } = {}) {
  const f = fixture(t);
  // Who is busy is what decides between "apply now" and "queue it"; tests flip
  // this instead of re-building the whole host.
  const busy = { value: false };
  // Adopting the session first is what makes the shell own a real execution:
  // the decision journal only ever speaks about turns a shell owns.
  f.runtime.adopt(f.a.id, 'a');
  const first = await f.runtime.send(f.a.id, input('work'));
  assert.equal(first.sessionId, 'a');
  const shell = f.runtime.view(f.a.id);
  const histories = new Map([['a', [{ id: 'a:m1', sourceSessionId: 'a', sourceMessageId: 'm1',
    turnId, taskId: first.taskId, role: 'user', content: 'work' }]]]);
  const overlay = createTaskOperations({
    store: f.store, revisionOf: () => 'rev-1',
    isTurnBusy: () => busy.value,
    resolveTarget: async (_scope, taskId) => f.store.get('task', taskId),
    taskTitle: taskId => f.store.get('task', taskId)?.title || null,
    effectiveTaskOf: (sessionId, id) => (histories.get(sessionId) || []).find(m => m.turnId === id)?.taskId ?? null,
  });
  const events = [];
  const decisions = createAttributionDecisions({
    store: f.store, operations: overlay,
    scopeOf: () => f.runtime.chatScope(f.a.id),
    settleAttribution: (...args) => f.runtime.settleAttribution(...args),
    restoreSettledCursor: (...args) => f.runtime.restoreSettledCursor(...args),
    isTurnBusy: () => busy.value,
    taskTitle: taskId => f.store.get('task', taskId)?.title || null,
    onAttributionChanged: (sessionId, detail) => events.push({ sessionId, ...detail }),
  });
  const record = (extra = {}) => decisions.record('a', first.receiptId,
    { mode, relation: 'same', taskName: 'Beta', turnId, ...extra });
  return { f, first, shell, histories, overlay, decisions, record, events, busy };
}

test('shadow records the verdict and changes nothing a reader can see', async t => {
  const { f, shell, decisions, record } = await setup(t, { mode: 'shadow' });
  const result = await record({ relation: 'new', taskId: 'tsk_candidate' });
  assert.equal(result.action, 'record');
  assert.deepEqual(decisions.list(f.a.id), [], 'shadow rows are not offered to users');
  const rows = decisions.list(f.a.id, { includeHidden: true });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].mode, 'shadow');
  assert.equal(rows[0].state, 'pending');
  assert.equal(f.runtime.view(f.a.id).currentTaskId, shell.currentTaskId, 'the cursor never moved');
  assert.equal((f.histories.get('a') || []).length, 0);
});

test('off is silent: no row, no hidden row, no change', async t => {
  const { f, decisions, record } = await setup(t, { mode: 'off' });
  assert.equal((await record({ relation: 'new', taskId: 'tsk_candidate' })).action, 'none');
  assert.deepEqual(decisions.list(f.a.id, { includeHidden: true }), []);
});

test('suggest offers the verdict, and accepting it re-attributes exactly one turn', async t => {
  const { f, decisions, record } = await setup(t);
  const second = await f.runtime.send(f.a.id, input('B', { newTask: true }));
  const cursorBefore = f.runtime.view(f.a.id).currentTaskId;
  const result = await record({ taskId: second.taskId });
  assert.equal(result.action, 'suggest');
  assert.equal(result.decision.path, 'overlay');
  assert.equal(decisions.list(f.a.id).length, 1);
  const accepted = await decisions.accept(f.a.id, result.decision.id, { clientMsgId: 'accept-1' });
  assert.equal(accepted.state, 'applied');
  assert.equal(accepted.apply.kind, 'overlay');
  assert.equal(f.runtime.view(f.a.id).currentTaskId, cursorBefore, 're-attribution is not an identity move');
  const moved = decisions.undo(f.a.id, result.decision.id);
  assert.equal(moved.state, 'reverted');
  // Undo is final for that row: re-applying is a deliberate act through the
  // attribution control, not a second accept of a suggestion already resolved.
  await assert.rejects(decisions.accept(f.a.id, result.decision.id, { clientMsgId: 'accept-2' }),
    { code: 'attribution_decision_resolved' });
});

test('a new identity is created only when accepted, and undo puts the cursor back', async t => {
  const { f, first, shell, decisions, record } = await setup(t);
  const result = await record({ relation: 'new', taskId: 'tsk_candidate', taskName: 'Beta' });
  assert.equal(result.action, 'suggest');
  assert.equal(result.decision.path, 'identity');
  assert.equal(f.runtime.view(f.a.id).currentTaskId, shell.currentTaskId);
  const accepted = await decisions.accept(f.a.id, result.decision.id, { clientMsgId: 'accept-identity' });
  assert.equal(accepted.state, 'applied');
  assert.equal(accepted.apply.kind, 'identity');
  assert.equal(f.runtime.view(f.a.id).currentTaskId, 'tsk_candidate');
  assert.ok(f.store.get('task', 'tsk_candidate'), 'accept creates the named task');
  const undone = decisions.undo(f.a.id, result.decision.id);
  assert.equal(undone.state, 'reverted');
  assert.equal(f.runtime.view(f.a.id).currentTaskId, first.taskId);
  assert.ok(f.store.get('task', 'tsk_candidate'), 'undo keeps the task, it only moves the cursor back');
});

test('auto applies the same verdict the other tiers only record', async t => {
  const { f, decisions, record } = await setup(t, { mode: 'auto' });
  const result = await record({ relation: 'new', taskId: 'tsk_auto', taskName: 'Auto' });
  assert.equal(result.action, 'apply');
  assert.equal(result.decision.state, 'applied');
  assert.equal(f.runtime.view(f.a.id).currentTaskId, 'tsk_auto');
  assert.equal(decisions.list(f.a.id).length, 1);
});

test('auto without an address stays a suggestion instead of inventing a task', async t => {
  const { f, shell, record } = await setup(t, { mode: 'auto' });
  const result = await record({ relation: 'new', taskId: null });
  assert.equal(result.action, 'suggest');
  assert.equal(result.decision.path, 'identity');
  assert.equal(f.runtime.view(f.a.id).currentTaskId, shell.currentTaskId);
});

test('recording the same turn twice is idempotent, and a resolved row is final', async t => {
  const { f, decisions, record } = await setup(t);
  const first = await record({ relation: 'new', taskId: 'tsk_candidate' });
  const second = await record({ relation: 'new', taskId: 'tsk_candidate' });
  assert.equal(first.decision.id, second.decision.id);
  assert.equal(decisions.list(f.a.id).length, 1);
  const dismissed = decisions.dismiss(f.a.id, first.decision.id);
  assert.equal(dismissed.state, 'dismissed');
  assert.equal(decisions.dismiss(f.a.id, first.decision.id).state, 'dismissed', 'dismiss is idempotent');
  await assert.rejects(decisions.accept(f.a.id, first.decision.id, { clientMsgId: 'late' }),
    { code: 'attribution_decision_resolved' });
});

test('an unreadable verdict is journalled as unclassified and cannot be accepted', async t => {
  const { f, decisions, record } = await setup(t);
  const cursor = f.runtime.view(f.a.id).currentTaskId;
  const recorded = await record({ unclassified: true });
  assert.equal(recorded.action, 'none');
  assert.equal(recorded.decision.state, 'unclassified');
  assert.equal(recorded.decision.path, 'none');
  assert.equal(recorded.decision.toTaskId, null);
  assert.equal(recorded.decision.hidden, false, 'it is visible, not a silent same');
  assert.equal(f.runtime.view(f.a.id).currentTaskId, cursor, 'nothing moved');
  const offered = decisions.list(f.a.id);
  assert.equal(offered.length, 1);
  await assert.rejects(decisions.accept(f.a.id, recorded.decision.id, { clientMsgId: 'accept-none' }),
    { code: 'attribution_verdict_unavailable' });
  assert.equal(decisions.dismiss(f.a.id, recorded.decision.id).state, 'dismissed');
  // A resolved row stays final: the same unreadable verdict cannot reopen it.
  const again = await record({ unclassified: true });
  assert.equal(again.decision.state, 'dismissed');
  assert.equal(decisions.list(f.a.id).filter(row => row.state === 'unclassified').length, 0,
    'a dismissed verdict is not offered again');
});

test('a re-judged turn refreshes its pending suggestion instead of stacking a second one', async t => {
  const { f, decisions, record } = await setup(t);
  const first = await record({ relation: 'new', taskId: 'tsk_candidate', taskName: 'First' });
  const second = await record({ relation: 'new', taskId: 'tsk_candidate', taskName: 'Second' });
  assert.equal(second.decision.id, first.decision.id);
  assert.equal(second.decision.revisions, 1);
  assert.equal(second.decision.taskName, 'Second');
  assert.equal(second.decision.createdAt, first.decision.createdAt, 'the row keeps its origin');
  assert.equal(decisions.list(f.a.id).length, 1, 'one turn never asks twice');
});

test('a postponed suggestion stays open across re-judging and still tells other pages', async t => {
  const { f, decisions, record, events } = await setup(t);
  const first = await record({ relation: 'new', taskId: 'tsk_candidate', taskName: 'Beta' });
  const deferred = decisions.defer(f.a.id, first.decision.id);
  assert.equal(deferred.state, 'deferred');
  assert.ok(deferred.deferredAt, 'the postponement is durable, not just hidden');
  assert.equal(decisions.list(f.a.id).length, 1, 'a postponed row stays in the directory');
  assert.deepEqual(events.at(-1), { sessionId: 'a', decisionId: first.decision.id, state: 'deferred', kind: 'deferred' });
  // Deferring twice is a no-op, and a fresh verdict for the same turn must not
  // reopen a row the user already postponed.
  assert.equal(decisions.defer(f.a.id, first.decision.id).state, 'deferred');
  const again = await record({ relation: 'new', taskId: 'tsk_candidate', taskName: 'Beta' });
  assert.equal(again.decision.state, 'deferred');
  assert.equal(decisions.list(f.a.id).length, 1);
  // "Later" is not a decision: the user can still accept it, and the broadcast
  // says exactly what happened so another page knows whether to re-read history.
  const accepted = await decisions.accept(f.a.id, first.decision.id, { clientMsgId: 'accept-deferred' });
  assert.equal(accepted.state, 'applied');
  assert.deepEqual(events.at(-1), { sessionId: 'a', decisionId: first.decision.id, state: 'applied',
    kind: 'applied', toTaskId: 'tsk_candidate', fromTaskId: first.decision.fromTaskId });
});

test('a resolved suggestion cannot be postponed', async t => {
  const { f, decisions, record } = await setup(t);
  const first = await record({ relation: 'new', taskId: 'tsk_candidate' });
  decisions.dismiss(f.a.id, first.decision.id);
  assert.throws(() => decisions.defer(f.a.id, first.decision.id), { code: 'attribution_decision_resolved' });
});

test('the decisions HTTP surface exposes the defer route', async () => {
  const handlers = new Map();
  const app = { get: (path, handler) => handlers.set(`GET ${path}`, handler),
    post: (path, handler) => handlers.set(`POST ${path}`, handler),
    delete: (path, handler) => handlers.set(`DELETE ${path}`, handler) };
  const calls = [];
  const decisions = { list: () => [], accept: () => ({}), dismiss: () => ({}), undo: () => ({}),
    defer: (shellId, decisionId) => { calls.push([shellId, decisionId]); return { id: decisionId, state: 'deferred' }; } };
  mountTaskShellRoutes(app, { getRuntime: () => ({}), attributionDecisions: () => decisions });
  let body = null;
  await handlers.get('POST /api/task-shells/:shellId/attribution-decisions/:decisionId/defer')(
    { params: { shellId: 'sh_1', decisionId: 'dec_1' }, body: {} }, { json: value => { body = value; } });
  assert.deepEqual(calls, [['sh_1', 'dec_1']]);
  assert.equal(body.state, 'deferred');
});

test('accepting a suggestion for a running turn queues the change instead of refusing it', async t => {
  const { f, decisions, record, busy, events } = await setup(t);
  const second = await f.runtime.send(f.a.id, input('B', { newTask: true }));
  const result = await record({ taskId: second.taskId });
  busy.value = true;
  const queued = await decisions.accept(f.a.id, result.decision.id, { clientMsgId: 'accept-queued' });
  assert.equal(queued.state, 'queued', 'the decision is durable, not an error');
  assert.equal(queued.queuedAt > 0, true);
  assert.equal(decisions.list(f.a.id).filter(item => item.state === 'queued').length, 1,
    'a queued change stays visible');
  assert.equal(queued.apply, null, 'nothing was written while the turn is running');
  assert.equal(events.some(event => event.kind === 'queued'), true, 'other pages are told');

  // The turn closes and the server-side queue applies what the user accepted.
  busy.value = false;
  const drained = await decisions.drain();
  assert.equal(drained.applied, 1);
  const settled = decisions.list(f.a.id).find(item => item.id === result.decision.id);
  assert.equal(settled.state, 'applied');
  assert.equal(settled.apply.kind, 'overlay');
});

test('a queued change can be withdrawn, and a lost race stays queued instead of failing', async t => {
  const { f, decisions, record, busy } = await setup(t);
  const second = await f.runtime.send(f.a.id, input('B', { newTask: true }));
  const result = await record({ taskId: second.taskId });
  busy.value = true;
  const queued = await decisions.accept(f.a.id, result.decision.id, { clientMsgId: 'accept-race' });
  assert.equal(queued.state, 'queued');
  // A turn that started again between the gate and the write is "not yet".
  await decisions.drain();
  assert.equal(decisions.list(f.a.id).find(item => item.id === result.decision.id).state, 'queued');
  const dismissed = decisions.dismiss(f.a.id, result.decision.id);
  assert.equal(dismissed.state, 'dismissed');
  await decisions.drain();
  assert.equal(decisions.list(f.a.id).find(item => item.id === result.decision.id).state, 'dismissed',
    'a withdrawn change is never applied later');
});

test('a turn that starts again between the gate and the write stays queued, not failed', async t => {
  const { f, decisions, record, busy, overlay } = await setup(t);
  const second = await f.runtime.send(f.a.id, input('B', { newTask: true }));
  const result = await record({ taskId: second.taskId });
  busy.value = true;
  await decisions.accept(f.a.id, result.decision.id, { clientMsgId: 'accept-restart' });
  // The gate says "free" but the write itself meets a running turn: the request
  // must go back to waiting, not be reported as a failure the user has to redo.
  const realApply = overlay.apply;
  overlay.apply = async () => { throw Object.assign(new Error('turn_busy'), { code: 'turn_busy' }); };
  busy.value = false;
  await decisions.drain();
  const stillQueued = decisions.list(f.a.id).find(item => item.id === result.decision.id);
  assert.equal(stillQueued.state, 'queued');
  assert.equal(stillQueued.queueAttempts, 1);
  overlay.apply = realApply;
  await decisions.drain();
  assert.equal(decisions.list(f.a.id).find(item => item.id === result.decision.id).state, 'applied');
});

test('a queued change that never becomes possible expires visibly', async t => {
  const { f, decisions, record, busy } = await setup(t);
  const second = await f.runtime.send(f.a.id, input('B', { newTask: true }));
  const result = await record({ taskId: second.taskId });
  busy.value = true;
  await decisions.accept(f.a.id, result.decision.id, { clientMsgId: 'accept-expire' });
  const row = f.store.get('attr-decision', result.decision.id);
  f.store.set('attr-decision', row.id, { ...row, queuedAt: Date.now() - (25 * 60 * 60 * 1000) });
  busy.value = false;
  const drained = await decisions.drain();
  assert.equal(drained.expired, 1);
  const settled = decisions.list(f.a.id).find(item => item.id === result.decision.id);
  assert.equal(settled.state, 'failed');
  assert.equal(settled.lastError, 'queued_expired');
});

test('starting the queue advances what an earlier page left behind', async t => {
  const { f, decisions, record, busy } = await setup(t);
  const second = await f.runtime.send(f.a.id, input('B', { newTask: true }));
  const result = await record({ taskId: second.taskId });
  busy.value = true;
  const queued = await decisions.accept(f.a.id, result.decision.id, { clientMsgId: 'accept-boot' });
  assert.equal(queued.state, 'queued');
  // Nobody reopens the page: the server owns the wait, and its first pass runs
  // as soon as the queue is started (which the host does at mount).
  busy.value = false;
  await decisions.start(60 * 60 * 1000);
  decisions.stop();
  assert.equal(decisions.list(f.a.id).find(item => item.id === result.decision.id).state, 'applied');
});
