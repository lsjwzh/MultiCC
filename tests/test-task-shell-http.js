'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { fixture } = require('./helpers/task-shell');
const { mountTaskShellRoutes } = require('../src/task-shell/routes');
const { createClient } = require('../public/task-shell-client');

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
  const denied = await api(`/api/task-shells/${f.b.id}/receipts/${first.data.receiptId}/retry`, {});
  assert.equal(denied.status, 404);
  assert.equal((await api(`/api/task-shells/${f.b.id}/links`, { taskId: first.data.taskId })).status, 200);
  const resolved = await api(`/api/task-shells/${f.b.id}/tasks/resolve`, { taskId: first.data.taskId });
  assert.equal(resolved.status, 200);
  assert.equal(f.runtime.view(f.b.id).currentTaskId, first.data.taskId);
  const detail = await api(`/api/task-shells/${f.b.id}/tasks/${first.data.taskId}`);
  assert.equal(detail.data.execution.busy, true);
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
