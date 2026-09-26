'use strict';
// Tests for src/docs-registry.js — the docs & web-services management table.
// Store-level (register/upsert/pin/validation) plus route-level through a fake
// express app, all against an isolated MULTICC_DATA_DIR so real state files
// are never touched (paths.assertTestDir rules are honoured by the temp dir).
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');
const test = require('node:test');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docsreg-test-'));
process.env.MULTICC_DATA_DIR = tmp;
const reg = require('../src/docs-registry');
const { assertTestDir } = require('../src/paths');
assertTestDir(tmp);

function reset() { reg._resetForTests([]); }

function fakeApp() {
  const handlers = [];
  return {
    handlers,
    get: (p, h) => handlers.push({ method: 'GET', p, h }),
    post: (p, h) => handlers.push({ method: 'POST', p, h }),
    patch: (p, h) => handlers.push({ method: 'PATCH', p, h }),
    delete: (p, h) => handlers.push({ method: 'DELETE', p, h }),
  };
}

function invoke(handler, { body, params, query } = {}) {
  const res = {
    statusCode: 200,
    body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(v) { this.body = v; return this; },
  };
  handler({ body: body || {}, params: params || {}, query: query || {} }, res);
  return res;
}

test('register creates an entry and re-registering the same URL upserts', () => {
  reset();
  const r1 = reg.register({ kind: 'page', title: '周报', url: '/artifacts/abc123/index.html', sessionId: 's1' });
  assert.equal(r1.created, true);
  assert.equal(r1.entry.artifactId, 'abc123');
  const r2 = reg.register({ kind: 'page', title: '周报 v2', url: '/artifacts/abc123/index.html' });
  assert.equal(r2.created, false);
  assert.equal(r2.entry.id, r1.entry.id);
  assert.equal(r2.entry.title, '周报 v2');
});

test('validation rejects bad urls and empty titles', () => {
  reset();
  assert.ok(reg.register({ title: 'x', url: 'javascript:alert(1)' }).error);
  assert.ok(reg.register({ title: 'x', url: 'data:text/html,<b>' }).error);
  assert.ok(reg.register({ title: 'x', url: 'ftp://host/f' }).error);
  assert.ok(reg.register({ title: '', url: '/artifacts/a/f.html' }).error);
  assert.ok(reg.register({ title: 'x', url: '/artifacts/a/../../etc/passwd' }).error);
  const defaulted = reg.register({ title: 'x', url: '/ok', kind: 'weird' });
  assert.equal(defaulted.entry.kind, 'page', 'unknown kind falls back to page');
  const ok = reg.register({ title: 'svc', url: 'http://127.0.0.1:5173/', kind: 'service' });
  assert.equal(ok.created, true);
});

test('only `permanent` feeds the artifact cleanup keep-list; 置顶 alone does not', () => {
  reset();
  reg.register({ kind: 'file', title: 'd.csv', url: '/artifacts/xyz789/data.csv?download=1', permanent: true, pinned: true });
  reg.register({ kind: 'page', title: 'p', url: '/artifacts/unpinned1/index.html' });
  reg.register({ kind: 'page', title: 'pin only', url: '/artifacts/pinonly1/index.html', pinned: true });
  reg.register({ kind: 'service', title: 'vite', url: 'http://127.0.0.1:5173/', permanent: true });
  assert.deepEqual(reg.listPermanentArtifactIds(), ['xyz789']);
});

test('a full registry evicts the oldest row that was not promised forever', () => {
  const filler = [];
  for (let i = 0; i < 497; i++) filler.push({ id: 'f' + i, kind: 'page', title: 'f' + i, url: '/u/' + i, createdAt: '2020-01-03T00:00:00Z' });
  reg._resetForTests([
    { id: 'perm1', kind: 'page', title: 'permanent', url: '/artifacts/p1/index.html', permanent: true, createdAt: '2020-01-01T00:00:00Z' },
    { id: 'pin1', kind: 'page', title: 'pinned', url: '/artifacts/pin1/index.html', pinned: true, createdAt: '2020-01-02T00:00:00Z' },
    { id: 'old1', kind: 'page', title: 'old', url: '/artifacts/o1/index.html', createdAt: '2020-01-04T00:00:00Z' },
    ...filler,
  ]);
  const r = reg.register({ kind: 'page', title: 'new', url: '/artifacts/new1/index.html' });
  assert.equal(r.created, true);
  const all = reg._entriesForTests();
  assert.equal(all.length, 500);
  assert.equal(all.some(e => e.id === 'perm1'), true, 'permanent row survives eviction');
  assert.equal(all.some(e => e.id === 'pin1'), false, 'a pin-only row is still evictable');
  assert.equal(all.some(e => e.id === 'old1'), true, 'newer non-permanent rows are untouched');
  reset();
});

test('rows pinned before `permanent` existed are upgraded instead of losing their exemption', () => {
  fs.writeFileSync(path.join(tmp, 'docs_registry.json'), JSON.stringify([
    { id: 'legacy', kind: 'page', title: 'legacy', url: '/artifacts/legacy1/index.html', pinned: true, createdAt: '2020-01-01T00:00:00Z' },
    { id: 'plain', kind: 'page', title: 'plain', url: '/artifacts/plain1/index.html', createdAt: '2020-01-01T00:00:00Z' },
  ]));
  reg._loadForTests();
  assert.deepEqual(reg.listPermanentArtifactIds(), ['legacy1']);
  const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, 'docs_registry.json'), 'utf8'));
  assert.equal(onDisk[0].permanent, true, 'the upgrade is persisted');
  assert.equal(onDisk[1].permanent, undefined, 'untouched rows stay untouched');
  assert.equal(onDisk[0].pinned, true, '置顶 is kept as its own flag');
  reset();
});

test('permanent sorts above 置顶 and both above the rest, each group newest-first', () => {
  reset();
  reg._resetForTests([
    { id: 'a', kind: 'page', title: 'a', url: '/a', createdAt: '2026-01-03T00:00:00Z' },
    { id: 'b', kind: 'page', title: 'b', url: '/b', pinned: true, createdAt: '2026-01-02T00:00:00Z' },
    { id: 'c', kind: 'page', title: 'c', url: '/c', permanent: true, createdAt: '2020-01-01T00:00:00Z' },
    { id: 'd', kind: 'page', title: 'd', url: '/d', permanent: true, pinned: true, createdAt: '2020-01-02T00:00:00Z' },
    { id: 'e', kind: 'page', title: 'e', url: '/e', createdAt: '2026-01-01T00:00:00Z' },
  ]);
  const app = fakeApp();
  reg.mount(app, { artifactExists: () => true });
  const list = invoke(app.handlers.find(h => h.method === 'GET').h).body;
  assert.deepEqual(list.map(x => x.id), ['d', 'c', 'b', 'a', 'e']);
  reset();
});

test('directory grouping normalizes task worktrees and ?dir= scopes the list', () => {
  reset();
  const app = fakeApp();
  const root = path.join(tmp, 'project');
  reg.mount(app, {
    artifactExists: () => true,
    resolveDir: id => (id === 'exec-a' ? path.join(tmp, 'project2') : null),
  });
  const get = app.handlers.find(h => h.method === 'GET').h;
  const post = app.handlers.find(h => h.method === 'POST').h;
  const worktree = path.join(root, '.multicc-worktrees', 'task-abc12345');
  invoke(post, { body: { kind: 'page', title: 'wt', url: '/artifacts/w1/index.html', cwd: worktree } });
  invoke(post, { body: { kind: 'page', title: 'sess', url: '/artifacts/s1/index.html', sessionId: 'exec-a' } });
  invoke(post, { body: { kind: 'page', title: 'other', url: '/artifacts/o1/index.html', cwd: path.join(tmp, 'elsewhere') } });

  const all = invoke(get).body;
  const wt = all.find(e => e.title === 'wt');
  assert.equal(wt.dir, root, 'a worktree publication belongs to its project');
  assert.equal(wt.dirName, 'project');
  assert.equal(all.find(e => e.title === 'sess').dir, path.join(tmp, 'project2'), 'no cwd → the session directory');
  assert.equal(all.find(e => e.title === 'other').dir, path.join(tmp, 'elsewhere'));
  assert.equal(all.find(e => e.title === 'other').dirName, 'elsewhere');

  assert.deepEqual(invoke(get, { query: { dir: root } }).body.map(e => e.title), ['wt']);
  assert.deepEqual(invoke(get, { query: { dir: worktree } }).body.map(e => e.title), ['wt'], 'a worktree path scopes to its project');
  assert.deepEqual(invoke(get, { query: { dir: path.join(tmp, 'project2') } }).body.map(e => e.title), ['sess']);
  assert.deepEqual(invoke(get, { query: { dir: path.join(tmp, 'nope') } }).body, []);
  assert.deepEqual(invoke(get, { query: { dir: 'relative/path' } }).body, [],
    'an unscopable ?dir= answers [] instead of the whole registry');
  assert.equal(invoke(get).body.length, 3, 'no ?dir= lists everything');
  reset();
});

test('a relative or over-long working directory is refused, never stored', () => {
  reset();
  const r = reg.register({ kind: 'page', title: 'x', url: '/artifacts/r1/index.html', cwd: 'relative/path' });
  assert.equal(r.entry.dir, undefined);
  const r2 = reg.register({ kind: 'page', title: 'y', url: '/artifacts/r2/index.html', dir: 'nope' });
  assert.equal(r2.entry.dir, undefined);
  reset();
});

test('routes: GET lists newest-first, POST 201/200, PATCH, DELETE, expired flag', () => {
  reset();
  const app = fakeApp();
  reg.mount(app, { artifactExists: (id) => id === 'alive1' });
  const get = app.handlers.find(h => h.method === 'GET').h;
  const post = app.handlers.find(h => h.method === 'POST').h;
  const patch = app.handlers.find(h => h.method === 'PATCH').h;
  const del = app.handlers.find(h => h.method === 'DELETE').h;

  const created = invoke(post, { body: { kind: 'page', title: 'A', url: '/artifacts/alive1/index.html' } });
  assert.equal(created.statusCode, 201);
  const id = created.body.id;

  const dup = invoke(post, { body: { kind: 'page', title: 'A2', url: '/artifacts/alive1/index.html' } });
  assert.equal(dup.statusCode, 200);

  invoke(post, { body: { kind: 'page', title: 'B', url: '/artifacts/gone9/index.html' } });
  const list = invoke(get).body;
  assert.equal(list.length, 2);
  assert.equal(list.find(e => e.id === id).expired, false);
  assert.equal(list.find(e => e.title === 'B').expired, true);

  const bad = invoke(post, { body: { title: 'x', url: 'javascript:x' } });
  assert.equal(bad.statusCode, 400);

  const patched = invoke(patch, { params: { id }, body: { pinned: true } });
  assert.equal(patched.body.pinned, true);
  assert.equal(invoke(patch, { params: { id: 'nope' }, body: {} }).statusCode, 404);

  const removed = invoke(del, { params: { id } });
  assert.equal(removed.body.ok, true);
  assert.equal(invoke(del, { params: { id } }).statusCode, 404);
  assert.equal(invoke(get).body.length, 1);
});

test('store persists to docs_registry.json under MULTICC_DATA_DIR', () => {
  reset();
  reg.register({ kind: 'service', title: 'svc', url: 'http://127.0.0.1:9999/' });
  const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, 'docs_registry.json'), 'utf8'));
  assert.equal(onDisk.length, 1);
  assert.equal(onDisk[0].title, 'svc');
  reset();
});

test('publication records its generating task and keeps it when an unscoped update arrives', () => {
  reset();
  const app = fakeApp();
  reg.mount(app, { artifactExists: () => true, resolveTaskId: id => id === 'execution-a' ? 'tsk_a' : null });
  const post = app.handlers.find(h => h.method === 'POST').h;
  const body = { kind: 'page', title: 'Task output', url: '/artifacts/scoped/index.html', sessionId: 'execution-a' };
  const created = invoke(post, { body }).body;
  assert.equal(created.taskId, 'tsk_a');
  invoke(post, { body: { title: 'Updated title', url: body.url } });
  const stored = JSON.parse(fs.readFileSync(path.join(tmp, 'docs_registry.json'), 'utf8'))[0];
  assert.equal(stored.taskId, 'tsk_a');
  assert.equal(stored.sessionId, 'execution-a');
  const list = reg.list(); list[0].title = 'not persistent';
  assert.equal(reg.list()[0].title, 'Updated title');
  reset();
});

test('service supervision: probe flips status, lsof adopts the listener pid', async () => {
  reset();
  const net = require('net');
  const srv = net.createServer(() => {});
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;

  const r = reg.register({ kind: 'service', title: 'probe-me', url: `http://127.0.0.1:${port}/` });
  assert.equal(r.entry.port, undefined, 'port not supplied at register time');
  await reg.probeAllServices();
  let e = reg._entriesForTests()[0];
  assert.equal(e.status, 'up');
  assert.equal(e.port, port, 'port derived from url');
  assert.equal(e.pid, process.pid, 'lsof resolves this test process as the listener');
  assert.equal(e.pidSource, 'observed');

  srv.close();
  await new Promise(res => setTimeout(res, 50));
  await reg.probeAllServices();
  e = reg._entriesForTests()[0];
  assert.equal(e.status, 'down');
  reset();
});

test('startService spawns detached, stopService kills the process group', async () => {
  reset();
  const net = require('net');
  // Grab a free port, then release it for the child to bind.
  const srv = net.createServer(() => {});
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  await new Promise(r => srv.close(r));

  const r = reg.register({
    kind: 'service', title: 'spawn-me', url: `http://127.0.0.1:${port}/`,
    startCmd: `${process.execPath} -e "require('net').createServer(()=>{}).listen(${port},'127.0.0.1')"`,
    cwd: tmp,
  });
  assert.equal(r.created, true);
  const started = reg.startService(r.entry.id);
  assert.ok(started.entry, started.error);
  assert.equal(started.entry.pidSource, 'spawned');
  assert.equal(started.entry.status, 'starting');

  // Wait for the child to bind, then probe: up with our pid.
  let up = false;
  for (let i = 0; i < 30 && !up; i++) {
    await new Promise(res => setTimeout(res, 200));
    await reg.probeAllServices();
    up = reg._entriesForTests()[0].status === 'up';
  }
  assert.equal(up, true, 'spawned service came up');
  assert.ok(fs.existsSync(path.join(tmp, 'docs-registry-logs', `${r.entry.id}.log`)), 'log file created');

  const stopped = await reg.stopService(r.entry.id);
  assert.ok(stopped.entry, stopped.error);
  assert.equal(stopped.entry.status, 'down');
  assert.equal(stopped.entry.pid, null);
  await new Promise(res => setTimeout(res, 300));
  await reg.probeAllServices();
  assert.equal(reg._entriesForTests()[0].status, 'down', 'stays down after kill');
  reset();
});

test('startService refuses entries without startCmd and unknown ids', () => {
  reset();
  const r = reg.register({ kind: 'service', title: 'no-cmd', url: 'http://127.0.0.1:1/' });
  assert.equal(reg.startService(r.entry.id).status, 400);
  assert.equal(reg.startService('nope').status, 404);
  reset();
});

// ── Web loopback URL rewrite (public/docs-registry.js, pure function) ────────
// The panel opens registry URLs recorded from the server's own view; browsing
// from another machine must swap loopback hosts for the browsing host.
const { rewriteLoopbackUrl: rewriteWeb, isLoopbackHost } = require('../public/docs-registry');

test('web rewriteLoopbackUrl swaps loopback host, keeps port/path/query/protocol', () => {
  assert.equal(rewriteWeb('http://127.0.0.1:8770/', '192.168.1.5'), 'http://192.168.1.5:8770/');
  assert.equal(rewriteWeb('http://127.0.0.1:8770/x?a=1', '192.168.1.5'), 'http://192.168.1.5:8770/x?a=1');
  assert.equal(rewriteWeb('https://localhost:5173/', 'macbook.tail94695a.ts.net'), 'https://macbook.tail94695a.ts.net:5173/');
  assert.equal(rewriteWeb('http://LOCALHOST:8770/', '192.168.1.5'), 'http://192.168.1.5:8770/');
  assert.equal(rewriteWeb('http://[::1]:8770/', '192.168.1.5'), 'http://192.168.1.5:8770/');
});

test('web rewriteLoopbackUrl leaves non-loopback, relative and local-view URLs untouched', () => {
  assert.equal(rewriteWeb('http://example.com:8080/', '192.168.1.5'), 'http://example.com:8080/');
  assert.equal(rewriteWeb('https://192.168.1.9:443/', '192.168.1.5'), 'https://192.168.1.9:443/');
  assert.equal(rewriteWeb('/artifacts/abc/report.html', '192.168.1.5'), '/artifacts/abc/report.html');
  assert.equal(rewriteWeb('ftp://127.0.0.1:21/', '192.168.1.5'), 'ftp://127.0.0.1:21/', 'non-http scheme untouched');
  // Local (loopback) browsing keeps the URL exactly as recorded.
  assert.equal(rewriteWeb('http://127.0.0.1:8770/', 'localhost'), 'http://127.0.0.1:8770/');
  assert.equal(rewriteWeb('http://127.0.0.1:8770/', '127.0.0.1'), 'http://127.0.0.1:8770/');
  assert.equal(rewriteWeb('http://127.0.0.1:8770/', '[::1]'), 'http://127.0.0.1:8770/');
  // Degenerate inputs pass through untouched.
  assert.equal(rewriteWeb('', '192.168.1.5'), '');
  assert.equal(rewriteWeb('http://127.0.0.1:8770/', ''), 'http://127.0.0.1:8770/');
  assert.equal(rewriteWeb('not a url', '192.168.1.5'), 'not a url');
});

test('web isLoopbackHost recognizes the loopback family only', () => {
  for (const h of ['localhost', '127.0.0.1', '::1', '[::1]', 'LOCALHOST']) {
    assert.equal(isLoopbackHost(h), true, h);
  }
  for (const h of ['192.168.1.5', 'example.com', '[fd00::5]', '127.0.0.2']) {
    assert.equal(isLoopbackHost(h), false, h);
  }
});
