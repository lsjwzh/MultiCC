'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/task-shell');
const { createTaskOperations } = require('../src/task-shell/task-operations');
const { createAttributionDecisions } = require('../src/task-shell/attribution-decisions');

const input = (clientMsgId, extra = {}) => ({ clientMsgId, text: clientMsgId, ...extra });

// A conversation with one turn (`turn-1`) already attributed to its first task.
// Everything below is about what the host is allowed to do with a verdict that
// says that turn belongs somewhere else.
async function setup(t, { mode = 'suggest', turnId = 'turn-1' } = {}) {
  const f = fixture(t);
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
    isTurnBusy: () => false,
    resolveTarget: async (_scope, taskId) => f.store.get('task', taskId),
    taskTitle: taskId => f.store.get('task', taskId)?.title || null,
    effectiveTaskOf: (sessionId, id) => (histories.get(sessionId) || []).find(m => m.turnId === id)?.taskId ?? null,
  });
  const decisions = createAttributionDecisions({
    store: f.store, operations: overlay,
    scopeOf: () => f.runtime.chatScope(f.a.id),
    settleAttribution: (...args) => f.runtime.settleAttribution(...args),
    restoreSettledCursor: (...args) => f.runtime.restoreSettledCursor(...args),
    isTurnBusy: () => false,
    taskTitle: taskId => f.store.get('task', taskId)?.title || null,
  });
  const record = (extra = {}) => decisions.record('a', first.receiptId,
    { mode, relation: 'same', taskName: 'Beta', turnId, ...extra });
  return { f, first, shell, histories, overlay, decisions, record };
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
