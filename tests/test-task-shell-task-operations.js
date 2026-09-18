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
});
