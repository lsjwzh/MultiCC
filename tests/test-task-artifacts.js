'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { collectTaskArtifacts } = require('../src/task-shell/artifacts');
const { fixture } = require('./helpers/task-shell');
const { fakeApp, mountHost } = require('./helpers/task-shell-host');
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

test('task artifact host ops follow the shell cursor, read historical tasks and do not start execution', async t => {
  const f = fixture(t);
  const first = await f.runtime.send(f.a.id, { text: 'First', intent: 'work', clientMsgId: 'first' });
  f.statuses.set(first.sessionId, { busy: false });
  const second = await f.runtime.send(f.a.id, { text: 'Second', newTask: true, intent: 'work', clientMsgId: 'second' });
  f.histories.set(first.sessionId, [message('/artifacts/first/index.html', { taskId: first.taskId })]);
  f.histories.set(second.sessionId, [message('/artifacts/second/index.html', { taskId: second.taskId })]);
  const before = { sends: f.sends.length, creations: f.creations.length, view: f.runtime.view(f.a.id) };
  const { ok, fail } = mountHost(fakeApp(), { getRuntime: () => f.runtime,
    artifacts: async id => collectTaskArtifacts(await f.runtime.taskEntry(id), [], () => true) });
  const scope = await ok({ op: 'shell-artifacts-scope', shellId: f.a.id });
  assert.equal(scope.taskId, second.taskId);
  assert.deepEqual((await ok({ op: 'artifacts', taskId: scope.taskId })).items.map(i => i.artifactId), ['second']);
  assert.deepEqual((await ok({ op: 'artifacts', taskId: first.taskId })).items.map(i => i.artifactId), ['first']);
  assert.equal((await fail({ op: 'artifacts', taskId: 'missing' })).status, 404);
  assert.equal((await ok({ op: 'shell-artifacts-scope', shellId: f.b.id })).taskId, null);
  assert.deepEqual({ sends: f.sends.length, creations: f.creations.length, view: f.runtime.view(f.a.id) }, before);
});

test('task artifacts expose registry controls and sort permanent and pinned outputs above newer ones', () => {
  const result = collectTaskArtifacts(entry([message('/artifacts/unregistered/index.html')]), [
    row('plain', { id: 'plain-id', taskId: 'tsk_a', createdAt: '2026-10-16' }),
    row('pinned', { id: 'pin-id', taskId: 'tsk_a', pinned: true, createdAt: '2026-10-14' }),
    row('kept', { id: 'kept-id', taskId: 'tsk_a', permanent: true, createdAt: '2026-10-13' }),
    row('input', { id: 'input-id', taskId: 'tsk_a', retained: true, createdAt: '2026-10-12' }),
  ]);
  assert.deepEqual(result.items.slice(0, 3).map(i => i.artifactId), ['kept', 'pinned', 'plain']);
  assert.equal(result.items[0].registryId, 'kept-id');
  assert.equal(result.items[1].pinned, true);
  assert.equal(result.items.find(i => i.artifactId === 'input').retained, true);
  assert.equal(result.items.find(i => i.artifactId === 'unregistered').registryId, null);
});

test('artifact ops coalesce in-flight collects and memoize briefly per task', async () => {
  let collects = 0; let release; const gate = new Promise(done => { release = done; });
  const { ok } = mountHost(fakeApp(), {
    getRuntime: () => null,
    artifacts: async id => { collects += 1; if (collects === 1) await gate; return { taskId: id, title: '', items: [] }; },
    artifactsMemoMs: 60,
  });
  const inflight = [ok({ op: 'artifacts', taskId: 'tsk_a' }), ok({ op: 'artifacts', taskId: 'tsk_a' })];
  release();
  await Promise.all(inflight);
  assert.equal(collects, 1, '进行中的采集要合并成一个');
  await ok({ op: 'artifacts', taskId: 'tsk_a' });
  assert.equal(collects, 1, '完成后的短窗口内直接复用同一份结果');
  await new Promise(done => setTimeout(done, 70));
  await ok({ op: 'artifacts', taskId: 'tsk_a' });
  assert.equal(collects, 2, '窗口过后重新采集');
  await ok({ op: 'artifacts', taskId: 'tsk_b' });
  assert.equal(collects, 3, '不同任务各自采集');
});

test('a failed artifact collect is not memoized', async () => {
  let fails = true;
  const { ok, fail } = mountHost(fakeApp(), {
    getRuntime: () => null,
    artifacts: async id => { if (fails) throw Object.assign(new Error('boom'), { status: 500 }); return { taskId: id, title: '', items: [id] }; },
    artifactsMemoMs: 10_000,
  });
  const failed = await fail({ op: 'artifacts', taskId: 'tsk_b' });
  assert.equal(failed.status, 500);
  fails = false;
  const recovered = await ok({ op: 'artifacts', taskId: 'tsk_b' });
  assert.deepEqual(recovered.items, ['tsk_b'], '失败不能落缓存，下一轮要能恢复');
});

test('registry task titles are readable before the shell runtime has started', t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { createTaskShellHost } = require('../src/task-shell/host');
  const { createTaskShellStore } = require('../src/task-shell/store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-artifact-task-title-'));
  const file = path.join(dir, 'shell.sqlite');
  const store = createTaskShellStore(file);
  store.set('task', 'tsk_saved', { id: 'tsk_saved', title: 'Saved title' }); store.close();
  const host = createTaskShellHost({ file, records: new Map() });
  t.after(() => { host.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.equal(host.artifactTaskTitle('tsk_saved'), 'Saved title');
  assert.equal(host.artifactTaskTitle('tsk_missing'), null);
});
