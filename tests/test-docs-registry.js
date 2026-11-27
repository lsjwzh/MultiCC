'use strict';
// Tests for src/docs-registry.js — the docs & web-services management table.
//
// The seven HTTP routes now belong to the Rust front door
// (native/gateway/src/app/docs_memory_routes.rs, rules in
// native/core/src/docs_memory_routes.rs); what is left here is the store plus
// the host port (src/routes/docs-memory-host.js) the front door drives it
// through. Path matching, ?dir= scoping, the view assembly (artifactId/taskId/
// dirName/expired) and validation all live in Rust, so these tests pin the
// Node half: upsert/pin/validation/eviction semantics, the ordering indices the
// front door sorts by, the fact arrays it renders and the op envelope.
// Everything runs against an isolated MULTICC_DATA_DIR so real state files are
// never touched (paths.assertTestDir rules are honoured by the temp dir).
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');
const test = require('node:test');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docsreg-test-'));
process.env.MULTICC_DATA_DIR = tmp;
const reg = require('../src/native/binding').docsRegistry;
const { assertTestDir } = require('../src/paths');
assertTestDir(tmp);

function reset() { reg._resetForTests([]); }

const { createDocsMemoryHost } = require('../src/native/binding').docsMemoryHost;

/** The host port the front door calls; `handle(body)` runs one operation. */
function host(overrides = {}) {
  return createDocsMemoryHost({
    docs: reg,
    logger: { error() {} },
    ...overrides,
  });
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

test('permanent sorts above 置顶 and both above the rest, each group newest-first', async () => {
  reset();
  reg._resetForTests([
    { id: 'a', kind: 'page', title: 'a', url: '/a', createdAt: '2026-01-03T00:00:00Z' },
    { id: 'b', kind: 'page', title: 'b', url: '/b', pinned: true, createdAt: '2026-01-02T00:00:00Z' },
    { id: 'c', kind: 'page', title: 'c', url: '/c', permanent: true, createdAt: '2020-01-01T00:00:00Z' },
    { id: 'd', kind: 'page', title: 'd', url: '/d', permanent: true, pinned: true, createdAt: '2020-01-02T00:00:00Z' },
    { id: 'e', kind: 'page', title: 'e', url: '/e', createdAt: '2026-01-01T00:00:00Z' },
  ]);
  // The front door sorts by the indices this store hands it.
  const listed = await host().handle({ op: 'docs-list' });
  const ids = listed.order.map(index => listed.entries[index].id);
  assert.deepEqual(ids, ['d', 'c', 'b', 'a', 'e']);
  reset();
});

test('directory normalization collapses worktrees and refuses relative paths', async () => {
  reset();
  const root = path.join(tmp, 'project');
  const worktree = path.join(root, '.multicc-worktrees', 'task-abc12345');
  // ?dir= scoping and the worktree collapse in the view are Rust's
  // (native/gateway/tests/docs_memory_routes.rs); the store-level pieces the
  // host port reports are the normalized directory of a session and the raw
  // cwd/dir fields the kernel normalizes.
  assert.equal(reg.normalizeDir(worktree), root, 'a worktree belongs to its project');
  assert.equal(reg.normalizeDir(root + '/'), root, 'trailing separators are dropped');
  assert.equal(reg.normalizeDir(path.sep), path.sep);
  assert.equal(reg.normalizeDir('relative/path'), null);
  assert.equal(reg.normalizeDir(''), null);
  assert.equal(reg.normalizeDir(undefined), null);

  const h = host({ resolveDir: id => (id === 'exec-a' ? path.join(tmp, 'project2') : null) });
  reg.register({ kind: 'page', title: 'wt', url: '/artifacts/w1/index.html', cwd: worktree });
  reg.register({ kind: 'page', title: 'sess', url: '/artifacts/s1/index.html', sessionId: 'exec-a' });
  reg.register({ kind: 'page', title: 'other', url: '/artifacts/o1/index.html', cwd: path.join(tmp, 'elsewhere') });
  const facts = await h.handle({ op: 'docs-facts', items: [{ sessionId: 'exec-a' }, { sessionId: 'none' }] });
  assert.deepEqual(facts.sessionDir, [path.join(tmp, 'project2'), null],
    'no cwd → the session directory the front door falls back to');
  assert.deepEqual(facts.exists, [null, null]);
  assert.deepEqual(facts.taskTitle, [null, null]);
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

test('host operations: register created/upserted, get, replace, remove, facts', async () => {
  reset();
  const h = host({ artifactExists: id => id === 'alive1' });

  const created = await h.handle({ op: 'docs-register', entry: { kind: 'page', title: 'A', url: '/artifacts/alive1/index.html' } });
  assert.equal(created.created, true);
  const id = created.entry.id;

  const dup = await h.handle({ op: 'docs-register', entry: { kind: 'page', title: 'A2', url: '/artifacts/alive1/index.html' } });
  assert.equal(dup.created, false);
  assert.equal(dup.entry.id, id);

  await h.handle({ op: 'docs-register', entry: { kind: 'page', title: 'B', url: '/artifacts/gone9/index.html' } });
  const listed = await h.handle({ op: 'docs-list' });
  assert.equal(listed.entries.length, 2);
  const facts = await h.handle({
    op: 'docs-facts',
    items: listed.entries.map(entry => ({ artifactId: entry.artifactId || null })),
  });
  assert.deepEqual(facts.exists, [true, false], 'the front door renders expired from these facts');

  // Validation is the kernel's; the store only sees the already-valid entries.
  assert.ok(reg.register({ title: 'x', url: 'javascript:x' }).error);

  assert.deepEqual(await h.handle({ op: 'docs-get', id }), { found: true, entry: reg.entryById(id) });
  assert.deepEqual(await h.handle({ op: 'docs-get', id: 'nope' }), { found: false, entry: null });

  const replaced = await h.handle({ op: 'docs-replace', id, entry: { ...reg.entryById(id), pinned: true } });
  assert.deepEqual(replaced, { found: true });
  assert.equal(reg.entryById(id).pinned, true);
  assert.deepEqual(await h.handle({ op: 'docs-replace', id: 'nope', entry: {} }), { found: false });

  const removed = await h.handle({ op: 'docs-delete', id });
  assert.equal(removed.found, true);
  assert.equal(removed.removed.id, id);
  assert.deepEqual(await h.handle({ op: 'docs-delete', id }), { found: false, removed: null });
  assert.equal((await h.handle({ op: 'docs-list' })).entries.length, 1);
  reset();
});

test('store persists to docs_registry.json under MULTICC_DATA_DIR', () => {
  reset();
  reg.register({ kind: 'service', title: 'svc', url: 'http://127.0.0.1:9999/' });
  const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, 'docs_registry.json'), 'utf8'));
  assert.equal(onDisk.length, 1);
  assert.equal(onDisk[0].title, 'svc');
  reset();
});

test('publication records its generating task and keeps it when an unscoped update arrives', async () => {
  reset();
  const h = host({ artifactExists: () => true, resolveTaskId: id => (id === 'execution-a' ? 'tsk_a' : null) });
  assert.deepEqual(await h.handle({ op: 'docs-task-id', sessionId: 'execution-a' }), { taskId: 'tsk_a' });
  assert.deepEqual(await h.handle({ op: 'docs-task-id', sessionId: 'other' }), { taskId: null });

  // The kernel prefills taskId from that fact before the store write.
  const created = (await h.handle({
    op: 'docs-register',
    entry: { kind: 'page', title: 'Task output', url: '/artifacts/scoped/index.html', sessionId: 'execution-a', taskId: 'tsk_a' },
  })).entry;
  assert.equal(created.taskId, 'tsk_a');
  await h.handle({ op: 'docs-register', entry: { title: 'Updated title', url: '/artifacts/scoped/index.html' } });
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
  assert.equal(rewriteWeb('https://localhost:5173/', 'macbook.example-host.ts.net'), 'https://macbook.example-host.ts.net:5173/');
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

test('related entries survive eviction and expose inherited retention independently from their own flags', async () => {
  reset();
  const parent = reg.register({ title: 'Final', url: '/artifacts/final-keep/index.html', permanent: true, relatedArtifactIds: ['input-keep'] }).entry;
  const input = reg.register({ title: 'Input', url: '/artifacts/input-keep/data.csv', pinned: false }).entry;
  assert.ok(reg.listPermanentArtifactIds().includes('input-keep'));
  // The set the front door turns into `retained: true` on the input's view.
  let listed = await host().handle({ op: 'docs-list' });
  assert.ok(listed.retained.includes('input-keep'));
  const inputRow = listed.entries.find(entry => entry.id === input.id);
  assert.equal(inputRow.permanent, undefined);
  assert.equal(inputRow.pinned, false);
  const filler = Array.from({ length: 498 }, (_, i) => ({ id: 'fill-' + i, title: 'Filler', kind: 'page', url: '/filler/' + i }));
  reg._resetForTests([input, parent, ...filler]);
  assert.equal(reg.register({ title: 'new', url: '/new' }).created, true);
  assert.ok(reg.list().some(row => row.id === input.id), 'the intermediate row cannot be evicted');
  const h = host();
  assert.deepEqual(await h.handle({ op: 'docs-replace', id: parent.id, entry: { ...reg.entryById(parent.id), permanent: false } }), { found: true });
  listed = await h.handle({ op: 'docs-list' });
  assert.equal(listed.retained.includes('input-keep'), false);
  reset();
});

test('task facts resolve saved titles and never infer ownership from a reused session cursor', async () => {
  reset();
  const h = host({
    artifactExists: () => true,
    resolveTaskId: () => 'tsk_wrong-current-task',
    resolveTaskTitle: id => (id === 'tsk_original' ? 'Original task' : null),
  });
  reg.register({ title: 'report', url: '/artifacts/task-report/index.html', taskId: 'tsk_original', sessionId: 'reused' });
  reg.register({ title: 'legacy', url: '/artifacts/legacy-report/index.html', sessionId: 'reused' });
  reg.register({ title: 'dedicated', url: '/artifacts/dedicated-report/index.html', sessionId: 'task-' + 'a'.repeat(32) });
  const entries = reg.entriesSnapshot();
  const facts = await h.handle({ op: 'docs-facts', items: entries.map(entry => ({ taskId: entry.taskId || null })) });
  assert.deepEqual(facts.taskTitle, ['Original task', null, null],
    'the title comes from the stored task id; a reused session cursor never supplies one');
  assert.equal(entries.find(entry => entry.title === 'legacy').taskId, undefined);
  assert.equal(entries.find(entry => entry.title === 'dedicated').taskId, undefined,
    'the dedicated-session task id is inferred by the kernel, not stored');
  reset();
});

test('an incomplete dependency scan pauses cleanup but keeps list and unkeep actions usable', async () => {
  reset();
  const dir = path.join(tmp, 'artifacts', 'oversized-graph'); fs.mkdirSync(dir, { recursive: true });
  const fd = fs.openSync(path.join(dir, 'large.js'), 'w'); fs.ftruncateSync(fd, 65 * 1024 * 1024); fs.closeSync(fd);
  try {
    const row = reg.register({ title: 'large', url: '/artifacts/oversized-graph/index.html', permanent: true }).entry;
    assert.throws(() => reg.listPermanentArtifactIds(), /byte limit/);
    assert.equal(reg.list()[0].permanent, true);
    const h = host({ artifactExists: () => true });
    assert.equal((await h.handle({ op: 'docs-list' })).entries.length, 1);
    const replaced = await h.handle({ op: 'docs-replace', id: row.id, entry: { ...reg.entryById(row.id), permanent: false } });
    assert.deepEqual(replaced, { found: true });
    assert.equal(reg.entryById(row.id).permanent, false);
    assert.deepEqual(reg.listPermanentArtifactIds(), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); reset(); }
});

test('registering a permanent root into a full table preserves its incoming dependency graph', () => {
  reset();
  const input = { id: 'input-row', title: 'Input', kind: 'file', url: '/artifacts/new-input/data.csv', relatedArtifactIds: ['new-source'] };
  const source = { id: 'source-row', title: 'Source', kind: 'file', url: '/artifacts/new-source/data.csv' };
  const filler = Array.from({ length: 498 }, (_, i) => ({ id: 'fill-' + i, title: 'Filler', kind: 'page', url: '/filler/' + i }));
  reg._resetForTests([input, source, ...filler]);
  try {
    const result = reg.register({ title: 'Final', url: '/artifacts/new-final/index.html', permanent: true, relatedArtifactIds: ['new-input'] });
    assert.equal(result.created, true);
    assert.equal(reg.list().length, 500);
    assert.deepEqual(reg.listPermanentArtifactIds().sort(), ['new-final', 'new-input', 'new-source']);
    assert.equal(reg.list().find(row => row.id === input.id).retained, true);
    assert.equal(reg.list().find(row => row.id === source.id).retained, true);
    assert.equal(reg.list().some(row => row.id === 'fill-0'), false, 'eviction selects an unrelated row');
  } finally { reset(); }
});
