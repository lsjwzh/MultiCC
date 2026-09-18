'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { fixture } = require('./helpers/task-shell');
const { mountTaskShellRoutes, pageTaskHistory } = require('../src/task-shell/routes');
const { createTaskOperations } = require('../src/task-shell/task-operations');
const { createClient } = require('../public/task-shell-client');

test('read-only task history pages keep exact task messages and stable cursors', () => {
  const messages = Array.from({ length: 7 }, (_, index) => ({ id: `session:m${index}`, sourceMessageId: `m${index}`, role: 'assistant', content: `${index}` }));
  const latest = pageTaskHistory(messages, { limit: 3 });
  assert.deepEqual(latest.messages.map(message => message.id), ['session:m4', 'session:m5', 'session:m6']);
  assert.equal(latest.hasMore, true);
  const older = pageTaskHistory(messages, { before: 'session:m4', limit: 3 });
  assert.deepEqual(older.messages.map(message => message.id), ['session:m1', 'session:m2', 'session:m3']);
  assert.equal(older.hasMore, true);
  assert.deepEqual(pageTaskHistory(messages, { around: 'm0', limit: 3 }), {
    messages: messages.slice(0, 2), hasMore: false, found: true, hasNewer: true,
  });
  assert.deepEqual(pageTaskHistory(messages, { before: 'missing' }), { messages: [], hasMore: false, found: false });
});

test('HTTP routes execute and preserve structured errors, links and receipt ownership', async t => {
  const f = fixture(t), app = express(); app.use(express.json());
  mountTaskShellRoutes(app, { getRuntime: () => f.runtime });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (route, body) => {
    const response = await fetch(base + route, { method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  const bad = await api(`/api/task-shells/${f.a.id}/messages`, { text: 'invalid' });
  assert.equal(bad.status, 400); assert.equal(f.creations.length, 0);
  const first = await api(`/api/task-shells/${f.a.id}/messages`, { text: 'work', clientMsgId: 'first', intent: 'work' });
  assert.equal(first.status, 200); assert.equal(first.data.ok, true);
  const trace = await api(`/api/sessions/${first.data.sessionId}/context?traceId=${first.data.receiptId}`);
  assert.equal(trace.status, 200);
  assert.equal(trace.data.traceId, first.data.receiptId);
  assert.equal(trace.data.currentTask.taskId, first.data.taskId);
  const denied = await api(`/api/task-shells/${f.b.id}/receipts/${first.data.receiptId}/retry`, {});
  assert.equal(denied.status, 404);
  assert.equal((await api(`/api/task-shells/${f.b.id}/links`, { taskId: first.data.taskId })).status, 200);
  const resolved = await api(`/api/task-shells/${f.b.id}/tasks/resolve`, { taskId: first.data.taskId });
  assert.equal(resolved.status, 409);
  assert.equal(f.runtime.view(f.b.id).currentTaskId, null);
  const detail = await api(`/api/task-shells/${f.b.id}/tasks/${first.data.taskId}`);
  assert.equal(detail.data.execution.busy, true);
});

test('the shell scope hands the browser the input cursor as a display handle', async t => {
  const f = fixture(t, { taskShortCode: id => (id === '' ? '' : 'CURR') });
  const app = express(); app.use(express.json());
  mountTaskShellRoutes(app, { getRuntime: () => f.runtime });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const scope = async () => (await fetch(`${base}/api/task-shells/${f.a.id}/chat`)).json();
  const before = await scope();
  assert.equal(before.taskId, null, 'a shell with no current task has no cursor to show');
  assert.equal(before.taskShortCode, '');
  const sent = await (await fetch(`${base}/api/task-shells/${f.a.id}/messages`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'work', clientMsgId: 'first', intent: 'work' }) })).json();
  const after = await scope();
  assert.equal(after.taskId, sent.taskId, 'the cursor the chat page shows is the one a message is attributed to');
  assert.equal(after.taskShortCode, 'CURR');
});

test('a re-attribution over a running turn is queued and can be taken back over HTTP', async t => {
  const f = fixture(t);
  const operations = createTaskOperations({
    store: f.store, revisionOf: () => 'rev-1', isTurnBusy: () => true,
    resolveTarget: async () => ({ id: 'tsk_x' }), taskTitle: id => `Task ${id}`,
    scopeOf: shellId => f.runtime.chatScope(shellId),
  });
  const app = express(); app.use(express.json());
  mountTaskShellRoutes(app, { getRuntime: () => f.runtime, taskOperations: () => operations });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (route, body) => {
    const response = await fetch(base + route, { method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  const turns = [{ sessionId: 'a', turnId: 'turn-1' }], target = { taskId: 'tsk_x' };
  const refused = await api(`/api/task-shells/${f.a.id}/task-operations`, { turns, target, clientMsgId: 'm1' });
  assert.equal(refused.status, 409);
  assert.equal(refused.data.code, 'turn_busy', 'without `queue` the caller still gets a refusal');
  const queued = await api(`/api/task-shells/${f.a.id}/task-operations`, { turns, target, clientMsgId: 'm1', queue: true });
  assert.equal(queued.status, 200);
  assert.equal(queued.data.status, 'queued');
  assert.equal(queued.data.queuedAt > 0, true);
  assert.deepEqual(f.store.list('turn-attr'), [], 'queueing writes no attribution');
  const listed = await api(`/api/task-shells/${f.a.id}/task-operations`);
  assert.deepEqual(listed.data.operations.map(row => row.status), ['queued']);
  const cancelled = await api(`/api/task-operations/${queued.data.id}/cancel`, { clientMsgId: 'c1' });
  assert.equal(cancelled.data.status, 'cancelled');
  assert.equal((await api(`/api/task-operations/${queued.data.id}/cancel`, {})).data.status, 'cancelled');
});

test('browser transport preserves payload and key after timeout/reload; no silent reroute', async () => {
  const values = new Map(), requests = [];
  const storage = { getItem: k => values.get(k), setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) };
  let fail = true;
  const opts = { storage, key: 'shell-a', randomId: () => 'm1', request: async (url, body) => {
    requests.push({ url, body }); if (fail) throw new Error('lost response'); return { taskId: 'fork' };
  } };
  const client = createClient(opts);
  await assert.rejects(client.send('shell', { taskId: 'original', text: 'answer', intent: 'answer', requestId: 'q1', turnId: 'turn1' }));
  await assert.rejects(client.send('shell', { text: 'another' }), /pending_delivery/);
  fail = false;
  const reopened = createClient(opts);
  await reopened.retry('shell');
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(reopened.pending(), null);
});

test('browser transport allows correcting a definitively rejected unreserved request', async () => {
  const storage = { getItem: () => null, setItem() {}, removeItem() {} };
  const client = createClient({ storage, key: 'test', randomId: () => 'm1', request: async () => {
    throw Object.assign(new Error('dependency_not_ready'), { notReserved: true });
  } });
  await assert.rejects(client.send('shell', { text: 'work' }));
  assert.equal(client.pending(), null);
});

test('the index can move the next-input target with a cursor CAS, and never by accident', async t => {
  const f = fixture(t), app = express(); app.use(express.json());
  mountTaskShellRoutes(app, { getRuntime: () => f.runtime });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (route, body) => {
    const response = await fetch(base + route, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    return { status: response.status, data: await response.json() };
  };
  const first = await api(`/api/task-shells/${f.a.id}/messages`, { text: 'work', clientMsgId: 'w1', intent: 'work' });
  const second = await api(`/api/task-shells/${f.a.id}/messages`, { text: 'other', clientMsgId: 'w2', intent: 'work', newTask: true });
  const secondTaskId = second.data.taskId;
  assert.notEqual(first.data.taskId, secondTaskId, 'the second message really is another task');
  assert.equal(f.runtime.view(f.a.id).currentTaskId, secondTaskId);

  const moved = await api(`/api/task-shells/${f.a.id}/select-target`, { taskId: first.data.taskId });
  assert.equal(moved.status, 200);
  assert.equal(moved.data.ok, true);
  assert.equal(moved.data.changed, true);
  assert.equal(f.runtime.view(f.a.id).currentTaskId, first.data.taskId);
  // The cursor CAS is what keeps two open pages from overwriting each other.
  const stale = await api(`/api/task-shells/${f.a.id}/select-target`,
    { taskId: secondTaskId, expectedCursorVersion: moved.data.cursorVersion - 1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.code, 'stale_shell_cursor');
  assert.equal(f.runtime.view(f.a.id).currentTaskId, first.data.taskId, 'a stale write changes nothing');
  const same = await api(`/api/task-shells/${f.a.id}/select-target`, { taskId: first.data.taskId });
  assert.equal(same.data.changed, false, 'choosing the current target is a no-op, not a cursor bump');
  assert.equal(f.runtime.view(f.a.id).cursorVersion, moved.data.cursorVersion);

  // Identity, attribution and the task itself are untouched: this is a cursor.
  const other = await api(`/api/task-shells/${f.b.id}/select-target`, { taskId: first.data.taskId });
  assert.equal(other.status, 403);
  assert.equal(other.data.code, 'task_not_linked');
  const missing = await api(`/api/task-shells/${f.a.id}/select-target`, { taskId: 'tsk_missing' });
  assert.equal(missing.status, 403);
});
