'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { collectTaskArtifacts } = require('../src/task-shell/artifacts');
const { fixture } = require('./helpers/task-shell');
const { mountTaskShellRoutes } = require('../src/task-shell/routes');
const entry = messages => ({ task: { id: 'tsk_a', title: 'Task A' }, sessionId: 'task-a', messages });
const message = (content, extra = {}) => ({ role: 'assistant', taskId: 'tsk_a', content, ts: 1000, ...extra });
const row = (artifact, extra = {}) => ({ kind: 'page', title: artifact, url: `/artifacts/${artifact}/index.html`, ...extra });

test('task artifacts merge registry metadata and full transcript references without duplicates', () => {
  const messages = [message('[Report](/artifacts/report/index.html) /artifacts/report/index.html?view=all'),
    message('/artifacts/report/chart.png', { ts: 2000 }),
    message('', { tools: [{ result: 'published /artifacts/tool/data.csv' }] })];
  const result = collectTaskArtifacts(entry(messages), [row('report', { title: 'Report title', createdAt: '2026-09-11T01:00:00Z' }), row('early', { taskId: 'tsk_a' })], () => true);
  assert.equal(result.items.length, 4);
  assert.equal(result.items[0].title, 'Report title');
  assert.equal(result.items.find(i => i.url.endsWith('chart.png')).kind, 'file');
  assert.ok(result.items.some(i => i.artifactId === 'early'), 'registered before the final reply');
  assert.equal(result.items.some(i => i.expired), false);
});

test('task scope excludes other tasks, user references, inherited context and tool input examples', () => {
  const messages = [message('/artifacts/own/index.html'), message('/artifacts/foreign/index.html', { taskId: 'tsk_b' }),
    message('/artifacts/user/index.html', { role: 'user' }), message('/artifacts/inherited/index.html', { inherited: true }),
    message('', { tools: [{ input: '/artifacts/input/index.html', result: '/artifacts/error/index.html', is_error: true }] })];
  const result = collectTaskArtifacts(entry(messages), [row('other-task', { taskId: 'tsk_b', sessionId: 'task-a' }),
    row('shared', { sessionId: 'shared-shell' }), row('legacy', { sessionId: 'task-a' }),
    row('service', { taskId: 'tsk_a', kind: 'service' })]);
  assert.deepEqual(result.items.map(i => i.artifactId).sort(), ['legacy', 'own']);
  assert.deepEqual(collectTaskArtifacts({ ...entry([]), sessionId: 'shared-shell' }, [row('shared', { sessionId: 'shared-shell' })]).items, []);
});

test('missing files remain visible and traversal or external lookalikes are rejected', () => {
  const messages = [message('/artifacts/gone/index.html /artifacts/live/index.html https://other.test/artifacts/external/index.html /artifacts/live/../../private')];
  const result = collectTaskArtifacts(entry(messages), [], id => id !== 'gone');
  assert.equal(result.items.length, 2);
  assert.equal(result.items.find(i => i.artifactId === 'gone').expired, true);
  assert.equal(result.items.find(i => i.artifactId === 'live').expired, false);
});

test('registered URL parameters survive collection and invalid legacy timestamps do not break the list', () => {
  const result = collectTaskArtifacts(entry([message('/artifacts/report/index.html', { ts: 1e30, tools: {} })]),
    [row('report', { url: '/artifacts/report/index.html?view=directories', taskId: 'tsk_a' })]);
  assert.equal(result.items[0].url, '/artifacts/report/index.html?view=directories');
  assert.equal(result.items[0].createdAt, null);
});

test('task artifact routes follow the shell cursor, read historical tasks and do not start execution', async t => {
  const f = fixture(t), express = require('express'), app = express();
  const first = await f.runtime.send(f.a.id, { text: 'First', intent: 'work', clientMsgId: 'first' });
  f.statuses.set(first.sessionId, { busy: false });
  const second = await f.runtime.send(f.a.id, { text: 'Second', newTask: true, intent: 'work', clientMsgId: 'second' });
  f.histories.set(first.sessionId, [message('/artifacts/first/index.html', { taskId: first.taskId })]);
  f.histories.set(second.sessionId, [message('/artifacts/second/index.html', { taskId: second.taskId })]);
  const before = { sends: f.sends.length, creations: f.creations.length, view: f.runtime.view(f.a.id) };
  mountTaskShellRoutes(app, { getRuntime: () => f.runtime,
    artifacts: async id => collectTaskArtifacts(await f.runtime.taskEntry(id), [], () => true) });
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  t.after(() => new Promise(r => { server.close(r); server.closeAllConnections(); }));
  const get = async path => { const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`); return { status: res.status, body: await res.json() }; };
  const current = await get(`/api/task-shells/${f.a.id}/artifacts`);
  assert.equal(current.body.taskId, second.taskId);
  assert.deepEqual(current.body.items.map(i => i.artifactId), ['second']);
  assert.deepEqual((await get(`/api/task-shell-tasks/${first.taskId}/artifacts`)).body.items.map(i => i.artifactId), ['first']);
  assert.equal((await get('/api/task-shell-tasks/missing/artifacts')).status, 404);
  assert.deepEqual((await get(`/api/task-shells/${f.b.id}/artifacts`)).body.items, []);
  assert.deepEqual({ sends: f.sends.length, creations: f.creations.length, view: f.runtime.view(f.a.id) }, before);
});
