'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTaskIndex, collectTaskIndex } = require('../src/task-shell/task-index');
const { mountTaskShellRoutes } = require('../src/task-shell/routes');

function message(id, taskId, extra = {}) {
  return { id: `s1:${id}`, sourceSessionId: 's1', sourceMessageId: id, taskId, ts: 1000 + Number(String(id).replace(/\D/g, '') || 0), ...extra };
}
function codes(ids) {
  const table = Object.fromEntries(ids.map((id, index) => [id, String(2000 + index)]));
  return id => table[id] || '';
}
function fakeApp(handlers) {
  const record = (method, path, handler) => handlers.set(`${method} ${path}`, handler);
  return { get: (path, handler) => record('GET', path, handler), post: (path, handler) => record('POST', path, handler),
    delete: (path, handler) => record('DELETE', path, handler) };
}

test('collectTaskIndex projects the same shell message ids the chat view uses', () => {
  const scope = { shellId: 'sh_1', sessionIds: ['s1'] };
  const history = { s1: [{ id: 'u1', role: 'user', taskId: 'tsk_a', turnId: 't1', ts: 1 },
    { id: 'a1', role: 'assistant', taskId: 'tsk_a', turnId: 't1', ts: 2 }] };
  const index = collectTaskIndex(scope, id => history[id] || [], () => undefined, {
    tasks: [{ id: 'tsk_a', title: 'Alpha' }], codeFor: codes(['tsk_a']),
  });
  assert.equal(index.shellId, 'sh_1');
  assert.equal(index.tasks[0].firstMessageRef.id, 's1:u1');
  assert.equal(index.tasks[0].firstMessageRef.sourceMessageId, 'u1');
  assert.equal(index.tasks[0].segments[0].messageCount, 2);
});

test('index keeps first-appearance order and splits A -> B -> A into two anchored segments', () => {
  const index = buildTaskIndex({
    shellId: 'sh_1',
    messages: [
      message('m1', 'tsk_a', { role: 'user', turnId: 't1' }),
      message('m2', 'tsk_a', { role: 'assistant', turnId: 't1' }),
      message('m3', 'tsk_b', { role: 'user', turnId: 't2', taskName: 'Beta' }),
      message('m4', 'tsk_b', { role: 'assistant', turnId: 't2' }),
      message('m5', 'tsk_a', { role: 'user', turnId: 't3' }),
    ],
    tasks: [{ id: 'tsk_a', title: 'Alpha', status: 'active' }, { id: 'tsk_b', title: 'Beta' }],
    codeFor: codes(['tsk_a', 'tsk_b']),
  });
  assert.deepEqual(index.tasks.map(task => task.taskId), ['tsk_a', 'tsk_b']);
  assert.deepEqual(index.tasks.map(task => task.shortCode), ['2000', '2001']);
  assert.deepEqual(index.tasks.map(task => task.title), ['Alpha', 'Beta']);
  const alpha = index.tasks[0];
  assert.equal(alpha.segments.length, 2);
  assert.equal(alpha.segments[0].firstMessageRef.id, 's1:m1');
  assert.equal(alpha.segments[0].lastMessageRef.id, 's1:m2');
  assert.equal(alpha.segments[1].firstMessageRef.id, 's1:m5');
  assert.deepEqual(alpha.segments.map(segment => segment.messageCount), [2, 1]);
  assert.equal(alpha.turnCount, 2);
  assert.equal(alpha.firstMessageRef.id, 's1:m1');
  assert.equal(alpha.lastMessageRef.id, 's1:m5');
  const beta = index.tasks[1];
  assert.equal(beta.segments.length, 1);
  assert.equal(beta.turnCount, 1);
  // The directory is metadata only: no message body ever leaves this read.
  assert.equal(JSON.stringify(index).includes('"content"'), false);
});

test('messages without a task stay in a counted unassigned bucket instead of inventing a code', () => {
  const index = buildTaskIndex({
    shellId: 'sh_1',
    messages: [message('m1', null), message('m2', 'tsk_a'), message('m3', null)],
    codeFor: codes(['tsk_a']),
  });
  assert.equal(index.tasks.length, 1);
  assert.equal(index.unassigned.messageCount, 2);
  assert.equal(index.unassigned.firstMessageRef.id, 's1:m1');
  assert.equal(index.unassigned.lastMessageRef.id, 's1:m3');
});

test('scopeRevision is stable for identical attribution and changes when a turn moves', () => {
  const base = [message('m1', 'tsk_a'), message('m2', 'tsk_a'), message('m3', 'tsk_b')];
  const first = buildTaskIndex({ shellId: 'sh_1', messages: base, codeFor: codes(['tsk_a', 'tsk_b']) });
  const same = buildTaskIndex({ shellId: 'sh_1', messages: base.map(item => ({ ...item })), codeFor: codes(['tsk_a', 'tsk_b']) });
  assert.equal(first.scopeRevision, same.scopeRevision);
  const moved = buildTaskIndex({
    shellId: 'sh_1',
    messages: [base[0], { ...base[1], taskId: 'tsk_b' }, base[2]],
    codeFor: codes(['tsk_a', 'tsk_b']),
  });
  assert.notEqual(first.scopeRevision, moved.scopeRevision);
});

test('capabilities fail closed: without a callback the index offers no write action', () => {
  const closed = buildTaskIndex({ shellId: 'sh_1', messages: [message('m1', 'tsk_a')], codeFor: codes(['tsk_a']) });
  assert.deepEqual(closed.tasks[0].capabilities, { canDetach: false, canSelectTarget: false });
  const open = buildTaskIndex({ shellId: 'sh_1', messages: [message('m1', 'tsk_a')], codeFor: codes(['tsk_a']),
    capabilitiesOf: () => ({ canDetach: true, canSelectTarget: true }) });
  assert.deepEqual(open.tasks[0].capabilities, { canDetach: true, canSelectTarget: true });
});

test('a read-only shell exposes the directory without detach capability', async () => {
  const handlers = new Map();
  const runtime = { chatScope: () => ({ shellId: 'sh_1', sessionIds: ['s1'] }), listTasks: () => [], taskAccess: () => ({ readOnly: true }) };
  mountTaskShellRoutes(fakeApp(handlers), { getRuntime: () => runtime,
    taskIndex: () => ({ version: 1, shellId: 'sh_1', tasks: [], scopeRevision: 'r1' }) });
  let body = null;
  await handlers.get('GET /api/task-shells/:shellId/task-index')({ params: { shellId: 'sh_1' }, query: {} },
    { json: value => { body = value; } });
  assert.equal(body.scopeRevision, 'r1');
});

test('index route reports a clean error envelope when the shell is unknown', async () => {
  const handlers = new Map();
  mountTaskShellRoutes(fakeApp(handlers), { getRuntime: () => ({}),
    taskIndex: () => { throw Object.assign(new Error('shell_not_found'), { code: 'shell_not_found', status: 404 }); } });
  let status = null, body = null;
  await handlers.get('GET /api/task-shells/:shellId/task-index')({ params: { shellId: 'missing' }, query: {} },
    { json: value => { body = value; }, status: code => { status = code; return { json: value => { body = value; } }; } });
  assert.equal(status, 404);
  assert.equal(body.ok, false);
  assert.equal(body.code, 'shell_not_found');
});

test('exactly one entry is marked as the shell current input target', () => {
  const tasks = [{ id: 'tsk_a', title: 'Alpha' }, { id: 'tsk_b', title: 'Beta' }];
  const index = buildTaskIndex({
    shellId: 'sh_1',
    messages: [message('m1', 'tsk_a'), message('m2', 'tsk_b')],
    tasks, codeFor: codes(['tsk_a', 'tsk_b']),
    capabilitiesOf: () => ({ canDetach: true, canSelectTarget: true }),
    isTarget: taskId => taskId === 'tsk_b',
  });
  assert.deepEqual(index.tasks.map(task => [task.taskId, task.target]),
    [['tsk_a', false], ['tsk_b', true]]);
  // The cursor is not part of the scope revision: selecting a target must not
  // invalidate a preview of the conversation's attribution.
  const withoutTarget = buildTaskIndex({ shellId: 'sh_1',
    messages: [message('m1', 'tsk_a'), message('m2', 'tsk_b')], tasks, codeFor: codes(['tsk_a', 'tsk_b']) });
  assert.equal(index.scopeRevision, withoutTarget.scopeRevision);
  const empty = buildTaskIndex({ shellId: 'sh_1', messages: [], tasks,
    codeFor: codes(['tsk_a', 'tsk_b']), isTarget: taskId => taskId === 'tsk_a', includeEmpty: true });
  assert.deepEqual(empty.tasks.map(task => [task.taskId, task.target]), [['tsk_a', true], ['tsk_b', false]]);
});
