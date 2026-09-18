'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTaskRelations } = require('../src/task-shell/relations');
const { createTaskGraphRoutes } = require('../src/routes/task-graph');

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

function setup() {
  const store = fakeStore();
  store.set('shell', 'sh_1', { id: 'sh_1', dirId: 'dir_1', sourceSessionId: 'conv-1' });
  for (const id of ['tsk_a', 'tsk_b', 'tsk_c']) {
    store.set('task', id, { id, dirId: 'dir_1', title: id.slice(-1).toUpperCase(), sessionId: `s-${id}` });
  }
  store.set('task', 'tsk_other', { id: 'tsk_other', dirId: 'dir_2', title: 'Other', sessionId: 's-other' });
  const changed = [];
  const relations = createTaskRelations({ store, taskTitle: id => store.get('task', id)?.title || null,
    onChanged: id => changed.push(id) });
  return { store, relations, changed };
}

test('a relation is an audited edge and replays under the same operation id', () => {
  const { store, relations, changed } = setup();
  const created = relations.create('sh_1', { fromTaskId: 'tsk_a', toTaskId: 'tsk_b', clientMsgId: 'm1' });
  assert.equal(created.created, true);
  assert.equal(created.relation.kind, 'related');
  assert.equal(created.relation.fromTitle, 'A');
  assert.equal(created.relation.toTitle, 'B');
  const replay = relations.create('sh_1', { fromTaskId: 'tsk_a', toTaskId: 'tsk_b', clientMsgId: 'm1' });
  assert.equal(replay.created, false);
  assert.equal(replay.relation.id, created.relation.id);
  assert.equal(relations.list('sh_1').length, 1);
  assert.equal(changed.length, 1, 'a replay does not notify twice');
  // The same pair can also be declared as one group; the two edges coexist.
  const grouped = relations.create('sh_1', { kind: 'group', fromTaskId: 'tsk_a', toTaskId: 'tsk_b', clientMsgId: 'm2' });
  assert.equal(grouped.relation.kind, 'group');
  assert.equal(relations.list('sh_1').length, 2);
  // An operation id is a promise about one change, not a reusable key.
  assert.throws(() => relations.create('sh_1', { kind: 'group', fromTaskId: 'tsk_a', toTaskId: 'tsk_c', clientMsgId: 'm2' }),
    { code: 'idempotency_conflict' });
  assert.equal(store.list('relation').length, 2);
});

test('relations refuse self-edges, foreign projects and unknown tasks', () => {
  const { relations } = setup();
  assert.throws(() => relations.create('sh_1', { fromTaskId: 'tsk_a', toTaskId: 'tsk_a', clientMsgId: 'm1' }), { code: 'invalid_input' });
  assert.throws(() => relations.create('sh_1', { fromTaskId: 'tsk_a', toTaskId: 'tsk_other', clientMsgId: 'm2' }), { code: 'project_mismatch' });
  assert.throws(() => relations.create('sh_1', { fromTaskId: 'tsk_a', toTaskId: 'tsk_missing', clientMsgId: 'm3' }), { code: 'task_not_found' });
  assert.throws(() => relations.create('sh_1', { kind: 'owner', fromTaskId: 'tsk_a', toTaskId: 'tsk_b', clientMsgId: 'm4' }), { code: 'invalid_input' });
  assert.throws(() => relations.create('sh_missing', { fromTaskId: 'tsk_a', toTaskId: 'tsk_b', clientMsgId: 'm5' }), { code: 'task_shell_not_found' });
  assert.throws(() => relations.create('sh_1', { fromTaskId: 'tsk_a', toTaskId: 'tsk_b', clientMsgId: 'bad id!' }), { code: 'invalid_input' });
});

test('removing a relation restores the graph without touching attribution', () => {
  const { store, relations } = setup();
  const created = relations.create('sh_1', { kind: 'group', fromTaskId: 'tsk_a', toTaskId: 'tsk_b', clientMsgId: 'm1' });
  const removed = relations.remove('sh_1', { relationId: created.relation.id, clientMsgId: 'm2' });
  assert.equal(removed.removed, true);
  assert.deepEqual(relations.list('sh_1'), []);
  assert.equal(store.list('relation').length, 0);
  assert.equal(store.list('turn-attr').length, 0, 'relating never rewrites turn attribution');
  assert.equal(store.get('task', 'tsk_a').sessionId, 's-tsk_a', 'and never moves an execution');
  assert.throws(() => relations.remove('sh_1', { relationId: created.relation.id, clientMsgId: 'm3' }), { code: 'relation_not_found' });
});

test('the graph draws source and relation edges that carry no ownership', () => {
  const board = { tasks: { tsk_a: { id: 'tsk_a', title: 'A', dirId: 'dir_1' } }, taskGroups: {}, modules: {} };
  const shellState = {
    shells: [{ id: 'sh_1', sourceSessionId: 'conv-1', dirId: 'dir_1', currentTaskId: 'tsk_a', archivedAt: 0 }],
    tasks: [
      { id: 'tsk_a', dirId: 'dir_1', title: 'A', sessionId: 's-1', ownerShellId: 'sh_1', ready: true },
      { id: 'tsk_b', dirId: 'dir_1', title: 'B', sessionId: 's-2', ownerShellId: 'sh_1', ready: true,
        separatedFromTaskId: 'tsk_a', independentFrom: { sessionId: 's-2' } },
      { id: 'tsk_c', dirId: 'dir_1', title: 'C', sessionId: 's-3', ownerShellId: 'sh_1', ready: true,
        forkedFromTaskId: 'tsk_a' },
    ],
    links: [{ shellId: 'sh_1', taskId: 'tsk_a' }],
    relations: [{ id: 'rel_1', shellId: 'sh_1', kind: 'related', fromTaskId: 'tsk_b', toTaskId: 'tsk_c' }],
  };
  const routes = createTaskGraphRoutes({
    getBoard: () => board, taskGraphData: () => shellState,
    getRecord: id => (id === 'conv-1' ? { label: 'Conversation' } : null),
    directories: { get: id => (id === 'dir_1' ? { name: 'Project' } : null) },
    now: () => 0,
  });
  const graph = routes.buildTaskGraph('all');
  const types = graph.edges.map(edge => `${edge.source}->${edge.target}:${edge.type}`);
  assert.ok(types.includes('tsk_b->tsk_a:split_from'), `missing split edge in ${types.join(', ')}`);
  assert.ok(types.includes('tsk_c->tsk_a:fork_from'), `missing fork edge in ${types.join(', ')}`);
  assert.ok(types.includes('tsk_b->tsk_c:related'), `missing relation edge in ${types.join(', ')}`);
  const b = graph.nodes.find(node => node.id === 'tsk_b');
  assert.equal(b.independentFromSessionId, 's-2');
  assert.equal(b.parentTaskId, null, 'a source edge is not a parent edge');
});
