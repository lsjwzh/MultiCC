'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTaskOperations } = require('../src/task-shell/task-operations');

function fakeStore() {
  const data = new Map();
  const key = (kind, id) => `${kind}\u0000${id}`;
  const clone = value => JSON.parse(JSON.stringify(value));
  return {
    get: (kind, id) => (data.has(key(kind, id)) ? clone(data.get(key(kind, id))) : null),
    set: (kind, id, value) => { data.set(key(kind, id), clone(value)); return value; },
    remove: (kind, id) => data.delete(key(kind, id)),
    list: kind => [...data.entries()].filter(([entry]) => entry.startsWith(`${kind}\u0000`)).map(([, value]) => clone(value)),
    transaction: callback => callback(),
  };
}

function setup(extra = {}) {
  const store = fakeStore();
  let revision = 'rev-1';
  const operations = createTaskOperations({ store, revisionOf: () => revision,
    isTurnBusy: extra.isTurnBusy || (() => false),
    resolveTarget: extra.resolveTarget || (async () => ({ id: 'tsk_b' })),
    taskTitle: id => (id === 'tsk_b' ? 'Beta' : 'Alpha') });
  const scope = { shellId: 'sh_1', sessionIds: ['s1'] };
  const turns = [{ sessionId: 's1', turnId: 't1' }];
  const target = { taskId: 'tsk_b' };
  return { store, operations, scope, turns, target, bump: () => { revision = 'rev-2'; } };
}

test('a whole-range selection is expanded on the server, in conversation order', async () => {
  const store = fakeStore();
  const operations = createTaskOperations({ store, revisionOf: () => 'rev-1',
    isTurnBusy: () => false, resolveTarget: async () => ({ id: 'tsk_b' }), taskTitle: () => 'Beta',
    turnOrderOf: sessionId => (sessionId === 's1' ? ['t1', 't2', 't3', 't4'] : []) });
  const scope = { shellId: 'sh_1', sessionIds: ['s1'] };
  // Range edges may be given in either direction; the resolved set is the same
  // whole segment, so a user clicking the wrong end cannot get half a change.
  const preview = operations.preview({ scope, range: { sessionId: 's1', fromTurnId: 't3', toTurnId: 't2' }, target: { taskId: 'tsk_b' } });
  assert.deepEqual(preview.effects.map(effect => effect.turnId), ['t2', 't3']);
  const applied = await operations.apply({ scope, clientMsgId: 'm1', range: { sessionId: 's1', fromTurnId: 't1', toTurnId: 't4' },
    target: { taskId: 'tsk_b' } });
  assert.deepEqual(applied.effects.map(effect => effect.turnId), ['t1', 't2', 't3', 't4']);
  assert.equal(operations.overlay.get('s1', 't4').taskId, 'tsk_b');
  await assert.rejects(async () => operations.apply({ scope, clientMsgId: 'm2',
    range: { sessionId: 's1', fromTurnId: 't1', toTurnId: 'gone' }, target: { taskId: 'tsk_b' } }), { code: 'range_not_found' });
  assert.throws(() => operations.preview({ scope, range: { sessionId: 's1', fromTurnId: 't1' }, target: { taskId: 'tsk_b' } }),
    { code: 'invalid_range' });
});

test('preview describes the change without writing anything', () => {
  const { store, operations, scope, turns, target } = setup();
  const preview = operations.preview({ scope, turns, target });
  assert.equal(preview.changed, 1);
  assert.deepEqual(preview.effects, [{ sessionId: 's1', turnId: 't1', fromTaskId: null, toTaskId: 'tsk_b', changed: true }]);
  assert.equal(preview.capabilities.applicable, true);
  assert.equal(preview.scopeRevision, 'rev-1');
  assert.equal(store.list('turn-attr').length, 0);
  assert.equal(store.list('task-op').length, 0);
});

test('apply records an audited operation and the overlay drives every projection', async () => {
  const { store, operations, scope, turns, target } = setup();
  const preview = operations.preview({ scope, turns, target });
  const applied = await operations.apply({ scope, clientMsgId: 'm1', turns, target,
    previewToken: preview.previewToken, expectedRevision: preview.scopeRevision });
  assert.equal(applied.status, 'applied');
  assert.equal(applied.effects.length, 1);
  assert.deepEqual(store.list('turn-attr')[0], { sessionId: 's1', turnId: 't1', taskId: 'tsk_b',
    taskName: 'Beta', operationId: applied.id, updatedAt: store.list('turn-attr')[0].updatedAt });
  const messages = [{ id: 's1:u1', sourceSessionId: 's1', turnId: 't1', taskId: 'tsk_a' },
    { id: 's1:u2', sourceSessionId: 's1', turnId: 't2', taskId: 'tsk_a' }];
  const projected = operations.overlay.apply(messages);
  assert.equal(projected[0].taskId, 'tsk_b');
  assert.equal(projected[0].taskName, 'Beta');
  assert.equal(projected[0].attributionOverridden, true);
  assert.equal(projected[1].taskId, 'tsk_a');
  assert.equal(messages[0].taskId, 'tsk_a', 'the projection must not mutate its input');
});

test('the same operation id replays the same result but cannot be reused for another change', async () => {
  const { operations, scope, turns, target } = setup();
  const first = await operations.apply({ scope, clientMsgId: 'm1', turns, target });
  const replay = await operations.apply({ scope, clientMsgId: 'm1', turns, target });
  assert.equal(replay.id, first.id);
  assert.equal(operations.list('sh_1').length, 1);
  await assert.rejects(operations.apply({ scope, clientMsgId: 'm1', turns, target: { taskId: 'tsk_c' } }),
    { code: 'idempotency_conflict' });
});

test('a stale preview or revision, and a running turn, block the write', async () => {
  const { operations, scope, turns, target, bump } = setup();
  const preview = operations.preview({ scope, turns, target });
  bump();
  await assert.rejects(operations.apply({ scope, clientMsgId: 'm1', turns, target,
    previewToken: preview.previewToken, expectedRevision: 'rev-1' }), { code: 'scope_revision_conflict' });
  // With a fresh revision but the old preview token the change is still refused:
  // the preview described a different conversation state.
  await assert.rejects(operations.apply({ scope, clientMsgId: 'm2', previewToken: preview.previewToken,
    turns, target, expectedRevision: 'rev-2' }), { code: 'preview_stale' });
  const busy = setup({ isTurnBusy: () => true });
  assert.equal(busy.operations.preview({ scope: busy.scope, turns: busy.turns, target: busy.target }).capabilities.applicable, false);
  await assert.rejects(busy.operations.apply({ scope: busy.scope, clientMsgId: 'm3', turns: busy.turns, target: busy.target }),
    { code: 'turn_busy' });
});

test('undo restores the previous attribution and refuses to clobber later changes', async () => {
  const { operations, scope, turns, target } = setup();
  const applied = await operations.apply({ scope, clientMsgId: 'm1', turns, target });
  const undone = operations.undo({ operationId: applied.id, clientMsgId: 'u1' });
  assert.equal(undone.status, 'reverted');
  assert.equal(operations.overlay.apply([{ sourceSessionId: 's1', turnId: 't1', taskId: 'tsk_a' }])[0].taskId, 'tsk_a');
  assert.throws(() => operations.undo({ operationId: applied.id, clientMsgId: 'u2' }), { code: 'operation_not_applied' });

  const second = setup();
  const first = await second.operations.apply({ scope: second.scope, clientMsgId: 'm1', turns: second.turns, target: second.target });
  await second.operations.apply({ scope: second.scope, clientMsgId: 'm2', turns: second.turns, target: { taskId: 'tsk_c' } });
  assert.throws(() => second.operations.undo({ operationId: first.id, clientMsgId: 'u1' }), { code: 'undo_conflict' });
});

test('undo restores a turn that had its own overlay before the change', async () => {
  const { operations, store, scope, turns, target } = setup();
  store.set('turn-attr', 's1:t1', { sessionId: 's1', turnId: 't1', taskId: 'tsk_a', taskName: 'Alpha', operationId: 'seed' });
  const applied = await operations.apply({ scope, clientMsgId: 'm1', turns, target });
  assert.equal(store.get('turn-attr', 's1:t1').taskId, 'tsk_b');
  operations.undo({ operationId: applied.id, clientMsgId: 'u1' });
  assert.equal(store.get('turn-attr', 's1:t1').taskId, 'tsk_a');
  assert.equal(store.get('turn-attr', 's1:t1').taskName, 'Alpha', 'undo restores the title it replaced');
});

test('re-attribution cannot reach a conversation outside this shell', async () => {
  const store = fakeStore();
  const operations = createTaskOperations({ store, revisionOf: () => 'rev-1', isTurnBusy: () => false,
    resolveTarget: async () => ({ id: 'tsk_b' }), taskTitle: () => 'Beta',
    effectiveTaskOf: (sessionId, turnId) => ({ s1: { t1: 'tsk_a' }, s2: { x1: 'tsk_z' } }[sessionId]?.[turnId] ?? null),
    turnOrderOf: sessionId => ({ s1: ['t1'], s2: ['x1'] }[sessionId] || []) });
  const scope = { shellId: 'sh_1', sessionIds: ['s1'] };
  // The overlay is keyed by sessionId:turnId globally, so naming another
  // conversation must be refused before anything is written.
  assert.throws(() => operations.preview({ scope, turns: [{ sessionId: 's2', turnId: 'x1' }], target: { taskId: 'tsk_b' } }),
    { code: 'task_not_linked' });
  await assert.rejects(operations.apply({ scope, clientMsgId: 'm1',
    turns: [{ sessionId: 's2', turnId: 'x1' }], target: { taskId: 'tsk_b' } }), { code: 'task_not_linked' });
  // A range carries its own session id, so it needs the same check.
  assert.throws(() => operations.preview({ scope, range: { sessionId: 's2', fromTurnId: 'x1', toTurnId: 'x1' },
    target: { taskId: 'tsk_b' } }), { code: 'task_not_linked' });
  assert.equal(store.list('turn-attr').length, 0, 'a refused write leaves no overlay behind');
  assert.equal(store.list('task-op').length, 0);
  // A caller that forgot to scope the conversation must not be treated as global.
  assert.throws(() => operations.preview({ scope: { shellId: 'sh_1' },
    turns: [{ sessionId: 's1', turnId: 't1' }], target: { taskId: 'tsk_b' } }), { code: 'scope_incomplete' });
  // The in-scope write is unaffected.
  const ok = await operations.apply({ scope, clientMsgId: 'm2', turns: [{ sessionId: 's1', turnId: 't1' }],
    target: { taskId: 'tsk_b' } });
  assert.equal(ok.status, 'applied');
});

test('a whole-range selection is bounded as a segment, not as a hand-picked list', async () => {
  const store = fakeStore();
  const order = Array.from({ length: 600 }, (_, index) => `t${index}`);
  const operations = createTaskOperations({ store, revisionOf: () => 'rev-1', isTurnBusy: () => false,
    resolveTarget: async () => ({ id: 'tsk_b' }), taskTitle: () => 'B',
    effectiveTaskOf: () => 'tsk_a', turnOrderOf: () => order });
  const scope = { shellId: 'sh_1', sessionIds: ['s1'] };
  const long = operations.preview({ scope, range: { sessionId: 's1', fromTurnId: 't0', toTurnId: 't119' },
    target: { taskId: 'tsk_b' } });
  assert.equal(long.effects.length, 120, 'a long segment is a normal selection, not invalid input');
  assert.equal(long.capabilities.applicable, true);
  assert.throws(() => operations.preview({ scope, range: { sessionId: 's1', fromTurnId: 't0', toTurnId: 't599' },
    target: { taskId: 'tsk_b' } }), { code: 'range_too_large', detail: { turns: 600, max: 500 } });
  const many = Array.from({ length: 51 }, (_, index) => ({ sessionId: 's1', turnId: `t${index}` }));
  assert.throws(() => operations.preview({ scope, turns: many, target: { taskId: 'tsk_b' } }), { code: 'invalid_turns' });
});

test('deleting a conversation reclaims its journal and only its own overlays', async () => {
  const { operations, store, scope, turns, target } = setup();
  await operations.apply({ scope, clientMsgId: 'm1', turns, target });
  // Another shell's overlay on an unrelated turn must survive: overlays are
  // matched by the operation id that wrote them, not by session.
  store.set('turn-attr', 's9:z9', { sessionId: 's9', turnId: 'z9', taskId: 'tsk_other', operationId: 'op_other' });
  const purged = operations.purgeShell('sh_1');
  assert.equal(purged.operations, 1);
  assert.equal(purged.overlays, 1);
  assert.equal(store.list('task-op').length, 0);
  assert.equal(store.get('turn-attr', 's1:t1'), null);
  assert.equal(store.get('turn-attr', 's9:z9').operationId, 'op_other');
});

test('the retention sweep drops reverted journal rows and keeps live ones', async () => {
  const { operations, store, scope, turns, target } = setup();
  const applied = await operations.apply({ scope, clientMsgId: 'm1', turns, target });
  assert.equal(operations.expireOlderThan(Date.now() + 1000), 0,
    'an applied operation is still the audit trail for a live attribution');
  operations.undo({ operationId: applied.id, clientMsgId: 'u1' });
  assert.equal(operations.list('sh_1').length, 1);
  assert.equal(operations.expireOlderThan(Date.now() + 1000), 1);
  assert.equal(operations.list('sh_1').length, 0);
  assert.equal(store.list('task-op').length, 0);
});

// ── 在途轮次的排队（§6.1）：请求不再被 409 直接拒掉，而是落成 pending 行，
//    由服务端在轮次结束后重验并应用。
function queueFixture(extra = {}) {
  const store = fakeStore();
  const scope = { shellId: 'sh_1', sessionIds: ['s1'] };
  const turns = [{ sessionId: 's1', turnId: 't1' }], target = { taskId: 'tsk_b' };
  const state = { busy: extra.busy !== false, clock: 1000 };
  const operations = createTaskOperations({
    store, revisionOf: () => 'rev-1',
    isTurnBusy: extra.isTurnBusy || (() => state.busy),
    effectiveTaskOf: extra.effectiveTaskOf,
    resolveTarget: async () => ({ id: 'tsk_b' }),
    taskTitle: id => (id === 'tsk_b' ? 'Beta' : 'Alpha'),
    scopeOf: () => scope,
    now: () => state.clock,
  });
  return { store, operations, scope, turns, target, state };
}

test('a running turn queues the re-attribution instead of refusing it', async () => {
  const { store, operations, scope, turns, target } = queueFixture();
  await assert.rejects(operations.apply({ scope, clientMsgId: 'm1', turns, target }), { code: 'turn_busy' });
  const queued = await operations.apply({ scope, clientMsgId: 'm1', turns, target, queue: true });
  assert.equal(queued.status, 'queued');
  assert.deepEqual(queued.blocked, [{ sessionId: 's1', turnId: 't1', reason: 'turn_busy' }]);
  assert.equal(queued.queuedAt, 1000);
  assert.equal(queued.effects, null);
  assert.equal(store.list('turn-attr').length, 0, 'queueing writes no attribution');
  // The same request replayed is one row, not two.
  const again = await operations.apply({ scope, clientMsgId: 'm1', turns, target, queue: true });
  assert.equal(again.id, queued.id);
  assert.equal(operations.list('sh_1').length, 1);
  // A different selection under the same operation id is still a conflict.
  await assert.rejects(operations.apply({ scope, clientMsgId: 'm1',
    turns: [{ sessionId: 's1', turnId: 't2' }], target, queue: true }), { code: 'idempotency_conflict' });
});

test('the queue advances on its own once the turn is free, and re-derives the change', async () => {
  const { operations, scope, turns, target, state } = queueFixture();
  const queued = await operations.apply({ scope, clientMsgId: 'm1', turns, target, queue: true });
  state.busy = true;
  assert.deepEqual(await operations.drain(), { applied: 0, expired: 0, failed: 0, waiting: 1 });
  assert.equal(operations.get(queued.id).status, 'queued', 'still not the moment');
  state.busy = false;
  assert.deepEqual(await operations.drain(), { applied: 1, expired: 0, failed: 0, waiting: 0 });
  const applied = operations.get(queued.id);
  assert.equal(applied.status, 'applied');
  assert.equal(applied.queuedAt, queued.queuedAt, 'the queue time stays on the audit trail');
  assert.deepEqual(applied.previous, [{ sessionId: 's1', turnId: 't1', taskId: null, taskName: null }]);
  assert.equal(operations.overlay.get('s1', 't1').taskId, 'tsk_b');
  assert.deepEqual(await operations.drain(), { applied: 0, expired: 0, failed: 0, waiting: 0 });
  // Undo works on a queued-then-applied change like on any other.
  assert.equal(operations.undo({ operationId: applied.id, clientMsgId: 'u1' }).status, 'reverted');
  assert.equal(operations.overlay.get('s1', 't1'), null);
});

test('a queued change whose turn disappeared fails instead of waiting forever', async () => {
  const { operations, scope, turns, target } = queueFixture({ effectiveTaskOf: () => null });
  const queued = await operations.apply({ scope, clientMsgId: 'm1', turns, target, queue: true });
  assert.deepEqual(await operations.drain(), { applied: 0, expired: 0, failed: 1, waiting: 0 });
  assert.equal(operations.get(queued.id).status, 'failed');
  assert.equal(operations.get(queued.id).lastError, 'turn_not_found');
});

test('a queued request that outlives its window stops looking pending', async () => {
  const { operations, scope, turns, target, state } = queueFixture();
  const queued = await operations.apply({ scope, clientMsgId: 'm1', turns, target, queue: true });
  state.clock = 1000 + 24 * 60 * 60 * 1000 + 1;
  assert.deepEqual(await operations.drain(), { applied: 0, expired: 1, failed: 0, waiting: 0 });
  assert.equal(operations.get(queued.id).status, 'queued_expired');
  assert.equal(operations.get(queued.id).lastError, 'queued_expired');
  state.busy = false;
  assert.deepEqual(await operations.drain(), { applied: 0, expired: 0, failed: 0, waiting: 0 });
  assert.equal(operations.overlay.get('s1', 't1'), null, 'an expired request never lands late');
});

test('cancelling takes a queued request back and leaves applied ones to undo', async () => {
  const { operations, scope, turns, target, state } = queueFixture();
  const queued = await operations.apply({ scope, clientMsgId: 'm1', turns, target, queue: true });
  state.busy = false;
  const applied = await operations.apply({ scope, clientMsgId: 'm2', turns, target });
  assert.throws(() => operations.cancel({ operationId: applied.id }), { code: 'operation_not_queued' });
  assert.equal(operations.cancel({ operationId: queued.id }).status, 'cancelled');
  assert.equal(operations.cancel({ operationId: queued.id }).status, 'cancelled', 'cancel is idempotent');
  assert.throws(() => operations.cancel({ operationId: 'nope' }), { code: 'operation_not_found' });
  assert.equal(operations.overlay.get('s1', 't1').taskId, 'tsk_b', 'only the applied row wrote');
  // Cancelled rows are terminal: never applied later, and the sweep may drop them.
  assert.equal(operations.expireOlderThan(1000 + 31 * 24 * 60 * 60 * 1000), 1);
  assert.deepEqual(operations.list('sh_1').map(row => row.status), ['applied'],
    'a live attribution keeps its audit row');
});

test('a queued change that finally lands announces itself to the open pages', async () => {
  const { store, operations, scope, turns, target, state } = queueFixture();
  const notes = [];
  const withNotify = createTaskOperations({ store, revisionOf: () => 'rev-1', isTurnBusy: () => state.busy,
    resolveTarget: async () => ({ id: 'tsk_b' }), taskTitle: () => 'Beta', scopeOf: () => scope,
    notify: (sessionId, detail) => notes.push({ sessionId, detail }) });
  await withNotify.apply({ scope, clientMsgId: 'm1', turns, target, queue: true });
  assert.deepEqual(notes, [], 'queueing is not a change yet');
  state.busy = false;
  await withNotify.drain();
  assert.equal(notes.length, 1, 'the page that asked keeps its history in sync without a reload');
  assert.equal(notes[0].sessionId, 's1');
  assert.equal(notes[0].detail.kind, 'applied');
  assert.equal(notes[0].detail.operationId, operations.list('sh_1')[0].id);
});

test('the queue is advanced by the server, so a closed page cannot lose a request', async () => {
  const { operations, scope, turns, target, state } = queueFixture();
  await operations.apply({ scope, clientMsgId: 'm1', turns, target, queue: true });
  state.busy = false;
  await operations.start(1000);
  assert.equal(operations.list('sh_1')[0].status, 'applied', 'mount drains before the first interval');
  operations.stop();
});
