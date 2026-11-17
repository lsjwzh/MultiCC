'use strict';
// Unit tests for the directory cluster's Node half.
//
// The decision tree that used to live in src/directory/service.js is now Rust:
// validation, the $HOME verdict, the duplicate-path rule, the reorder merge,
// the layout prune rules and the error envelopes are in
// native/core/src/directory_routes.rs and the routes in
// native/gateway/src/app/directory_routes.rs (unit + integration suites there,
// byte comparison in docs/rust-migration/differential/directory-routes.js).
//
// What is left in Node is the process-local world and its effect order:
//   src/routes/directory-host.js  the op envelope the front door calls
//   src/directory/repository.js   the directories.json facade over the native
//                                 table (repo.save() is the writer)
// These tests drive every op through in-memory fakes of the ports: no fs, no
// git subprocess, no server.

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createDirectoryHost, HOST_PATH } = require('../src/routes/directory-host');
const { createFsDirectoryRepository } = require('../src/directory/repository');
const { createDirectoryTable } = require('../src/directory/records');
const { createStateOwner } = require('../src/state/owner');

function makeWorld({
  dirs = [], sessions = [], fsDirs = new Set(), fsFiles = new Set(), mkdirError = null,
} = {}) {
  const calls = {
    saved: 0, seeded: [], destroyed: [], tx: [], events: [], gitReady: [], unmarked: [],
    writes: [], invalidated: [], layoutSaved: [],
  };
  const realPathOf = (p) => p; // identity: no symlinks in the fake fs
  const owner = createStateOwner().configure({ stringify: JSON.stringify });
  const table = createDirectoryTable(owner);
  for (const d of dirs) table.set(d.id, d);
  const repo = createFsDirectoryRepository({
    file: '/nonexistent/never-written.json', map: table, realPathOf, owner,
  });
  repo.save = () => { calls.saved++; }; // never touch the real fs here

  const git = {
    baseBranch: () => 'main',
    pushState: async () => ({ available: true, hasRemote: false, ahead: 0, behind: 0, dirty: 0 }),
    push: async () => { throw new Error('no remote'); },
    invalidatePushCache: (p, branch) => { calls.invalidated.push({ p, branch }); },
    statusPorcelain: async () => '',
    stageAll: async () => {},
    commit: async () => {},
    ensureReady: (dir) => { calls.gitReady.push(dir.id); return { ok: true }; },
    unmarkReady: (id) => { calls.unmarked.push(id); },
  };
  const sessionPort = {
    listByDir: (dirId) => sessions.filter(s => s.dirId === dirId),
    seedCommander: (dir) => { calls.seeded.push(dir.id); },
    destroyCascade: (session) => { calls.destroyed.push(session.id); return { ok: true }; },
  };
  const tx = {
    commitCrossFileWrite: (spec) => { calls.tx.push(spec); },
  };
  const events = {
    append: (dirId, type, detail) => { calls.events.push({ dirId, type, detail }); },
  };
  const fsPort = {
    homedir: () => '/home/u',
    sampleRoot: () => '/data/samples',
    exists: (p) => fsDirs.has(p) || fsFiles.has(p),
    isDirectory: (p) => fsDirs.has(p),
    mkdirp: (p) => { if (mkdirError) throw mkdirError; fsDirs.add(p); },
    readDirents: (p) => {
      if (!fsDirs.has(p)) throw new Error(`ENOENT: ${p}`);
      return [...fsDirs]
        .filter((entry) => path.dirname(entry) === p && entry !== p)
        .map((entry) => ({ name: path.basename(entry), isDirectory: true, isSymbolicLink: false }));
    },
    writeFileExclusive: (p, content) => {
      if (fsFiles.has(p)) return false;
      fsFiles.add(p); calls.writes.push({ path: p, content }); return true;
    },
  };
  const helpers = {
    resolveCwd: (cur, arg) => (arg.startsWith('/') ? arg : path.join(cur, arg)),
    isHomeOrAbove: (p) => p === '/home/u' || p === '/home' || p === '/',
    realPathOf,
    friendlyDirReason: (r) => `friendly:${r}`,
    dirReasonFix: (r) => (String(r).includes('git-error: ') ? 'open-ops-terminal' : null),
  };
  const uiLayout = {
    state: { present: false, corrupt: false, data: null },
    load() { return this.state; },
    save(doc) { calls.layoutSaved.push(doc); this.state = { present: true, corrupt: false, data: doc }; },
    known() {
      return {
        dirIds: [...table.keys()],
        sessionIds: Object.fromEntries([...table.keys()].map(id => [id,
          sessions.filter(s => s.dirId === id).map(s => s.id)])),
      };
    },
  };
  const logger = { warn() {}, error() {} };
  const host = createDirectoryHost({
    repo, git, sessions: sessionPort, events, fsPort, helpers, tx, uiLayout, logger,
    newId: () => 'id-1',
  });
  return { host, repo, table, git, fsPort, uiLayout, calls, sessions };
}

test('path facts stay in Node: tilde, relative resolution and lstat flags', async () => {
  const world = makeWorld({ fsDirs: new Set(['/home/u', '/home/u/p']) });
  assert.deepEqual(await world.host.invoke({ op: 'resolve-path', path: 'rel' }),
    { resolved: '/home/u/rel' });
  assert.deepEqual(await world.host.invoke({ op: 'resolve-path', path: '/abs' }),
    { resolved: '/abs' });
  assert.deepEqual(await world.host.invoke({ op: 'real-paths', paths: ['/a'] }),
    { real: ['/a'], home: '/home/u' });
  assert.deepEqual(await world.host.invoke({ op: 'path-facts', paths: ['/home/u', '/nope'] }),
    { exists: [true, false], isDirectory: [true, false] });
});

test('browse facts classify the typed path and the readdir order comes from localeCompare', async () => {
  const world = makeWorld({
    fsDirs: new Set(['/home/u', '/home/u/proj', '/home/u/prox', '/home/u/.hidden']),
  });
  assert.deepEqual(await world.host.invoke({ op: 'browse-facts' }), {
    base: '/home/u', prefix: '', baseIsDir: true, parentIsDir: false, parent: '/home',
    realBase: '/home/u', realHome: '/home/u',
  });
  assert.deepEqual(await world.host.invoke({ op: 'browse-facts', path: '~' }), {
    base: '/home/u', prefix: '', baseIsDir: true, parentIsDir: false, parent: '/home',
    realBase: '/home/u', realHome: '/home/u',
  });
  // A partial name completes against its parent directory.
  const partial = await world.host.invoke({ op: 'browse-facts', path: '/home/u/pro' });
  assert.equal(partial.base, '/home/u');
  assert.equal(partial.prefix, 'pro');
  assert.equal(partial.baseIsDir, false);
  assert.equal(partial.parentIsDir, true);
  assert.equal(partial.parent, '/home');

  const read = await world.host.invoke({ op: 'browse-read', base: '/home/u' });
  // `entries` keeps readdir order; `order` is the localeCompare permutation of
  // its indices (the engine, not the Rust kernel, owns collation).
  assert.deepEqual(read.entries.map(e => e.name), ['proj', 'prox', '.hidden']);
  const collated = [...read.entries]
    .sort((a, b) => a.name.localeCompare(b.name)).map(e => e.name);
  assert.deepEqual(read.order.map(i => read.entries[i].name), collated);
  assert.deepEqual(read.order, [2, 0, 1]);
  assert.deepEqual([...read.order].sort(), [0, 1, 2]);
  const missing = await world.host.invoke({ op: 'browse-read', base: '/nope' });
  assert.match(missing.error, /ENOENT/);
  assert.deepEqual(missing.entries, []);
});

test('dirs-annotated pairs registry rows with their sessions and push state', async () => {
  const world = makeWorld({
    dirs: [{ id: 'd1', name: 'one', path: '/p/1' }],
    sessions: [{ id: 's1', dirId: 'd1', cli: 'codex', kind: 'chat' }],
  });
  const answer = await world.host.invoke({ op: 'dirs-annotated' });
  assert.deepEqual(answer.dirs, [{ id: 'd1', name: 'one', path: '/p/1' }]);
  assert.deepEqual(answer.sessions, [[{ cli: 'codex', kind: 'chat' }]]);
  assert.deepEqual(answer.pushStates, [{ ok: true, value: {
    available: true, hasRemote: false, ahead: 0, behind: 0, dirty: 0,
  } }]);
  // A failing pushState degrades to the reason, never to a rejected op.
  world.git.pushState = async () => { throw new Error('kaput'); };
  const degraded = await world.host.invoke({ op: 'dirs-annotated' });
  assert.deepEqual(degraded.pushStates, [{ ok: false, error: 'kaput' }]);
});

test('registration ops persist once, seed the commander and roll back on refusal', async () => {
  const world = makeWorld({ fsDirs: new Set(['/p']) });
  const dir = { id: 'id-1', name: 'x', path: '/p/x', createdAt: '2026-01-01T00:00:00.000Z' };
  assert.deepEqual(await world.host.invoke({ op: 'new-id' }), { id: 'id-1' });
  await world.host.invoke({ op: 'register-add', dir });
  assert.deepEqual(await world.host.invoke({ op: 'dir-get', id: 'id-1' }), { dir });
  assert.deepEqual(await world.host.invoke({ op: 'ensure-ready', id: 'id-1' }), { ok: true });
  assert.deepEqual(world.calls.gitReady, ['id-1']);

  const committed = await world.host.invoke({ op: 'register-commit', id: 'id-1' });
  assert.equal(world.calls.saved, 1);
  assert.deepEqual(world.calls.seeded, ['id-1']);
  assert.deepEqual(committed, { dir });

  // ensure-ready on an unknown id is a reason, not a throw.
  assert.deepEqual(await world.host.invoke({ op: 'ensure-ready', id: 'gone' }),
    { ok: false, reason: 'path-missing' });
  // A readiness refusal is a reason the Rust kernel turns into a 400 + fix.
  world.git.ensureReady = () => ({ ok: false, reason: 'git-error: fatal' });
  assert.deepEqual(await world.host.invoke({ op: 'ensure-ready', id: 'id-1' }),
    { ok: false, reason: 'git-error: fatal' });

  await world.host.invoke({ op: 'register-rollback', id: 'id-1' });
  assert.deepEqual(await world.host.invoke({ op: 'dir-get', id: 'id-1' }), { dir: null });
});

test('mutation ops keep the directory table and its readiness flags in step', async () => {
  const world = makeWorld({ dirs: [{ id: 'd1', name: 'old', path: '/p/a' }] });
  await world.host.invoke({ op: 'dir-set-name', id: 'd1', name: 'new' });
  await world.host.invoke({ op: 'dir-set-role', id: 'd1', value: 'role' });
  assert.deepEqual((await world.host.invoke({ op: 'dir-get', id: 'd1' })).dir,
    { id: 'd1', name: 'new', path: '/p/a', rolePrompt: 'role' });

  // A path change unmarks the readiness cache and reports the new facts.
  assert.deepEqual(await world.host.invoke({ op: 'dir-set-path', id: 'd1', path: '/p/b' }),
    {});
  assert.deepEqual(world.calls.unmarked, ['d1']);
  assert.deepEqual(await world.host.invoke({ op: 'realpath-equal', id: 'd1', path: '/p/b' }),
    { equal: true });
  assert.deepEqual(await world.host.invoke({ op: 'realpath-equal', id: 'd1', path: '/p/c' }),
    { equal: false });

  assert.deepEqual(await world.host.invoke({ op: 'find-by-path', path: '/p/b' }),
    { found: { id: 'd1', name: 'new', path: '/p/b', rolePrompt: 'role' } });
  assert.deepEqual(await world.host.invoke({ op: 'find-by-path', path: '/p/b', excludeId: 'd1' }),
    { found: null });
  assert.deepEqual(await world.host.invoke({ op: 'dir-save' }), {});
  assert.equal(world.calls.saved, 1);
  assert.deepEqual(await world.host.invoke({ op: 'dir-remove', id: 'd1' }), {});
  assert.deepEqual(await world.host.invoke({ op: 'dir-get', id: 'd1' }), { dir: null });
});

test('delete cascade uses the session record it was given and one cross-file transaction', async () => {
  const world = makeWorld({
    dirs: [{ id: 'd1', name: 'one', path: '/p/a' }],
    sessions: [{ id: 's1', dirId: 'd1' }, { id: 's2', dirId: 'd1' }],
  });
  assert.deepEqual(await world.host.invoke({ op: 'sessions-by-dir', id: 'd1' }),
    { sessions: [{ id: 's1', dirId: 'd1' }, { id: 's2', dirId: 'd1' }] });
  // The front door sends the record it already has; the host must not re-list.
  const sent = { id: 's2', dirId: 'd1' };
  await world.host.invoke({ op: 'destroy-cascade', sessionId: 's2', session: sent, dirId: 'd1', force: true });
  assert.deepEqual(world.calls.destroyed, ['s2']);
  // Without a record it falls back to the table.
  await world.host.invoke({ op: 'destroy-cascade', sessionId: 's1', dirId: 'd1', force: false });
  assert.deepEqual(world.calls.destroyed, ['s2', 's1']);
  await world.host.invoke({ op: 'tx-commit', id: 'd1', force: true });
  assert.deepEqual(world.calls.tx, [{ kind: 'delete-directory', reason: 'dir=d1 force=true' }]);
  // No dirId -> the cascade reports "nothing to cascade", not a crash.
  assert.deepEqual(await world.host.invoke({ op: 'destroy-cascade', dirId: 'gone', sessionId: 'x' }),
    { result: null });
});

test('git ops: status, force-refreshed facts, staging, commit, invalidation and push', async () => {
  const world = makeWorld({ dirs: [{ id: 'd1', name: 'one', path: '/p/a' }] });
  world.git.statusPorcelain = async () => ' M src/app.js\n';
  assert.deepEqual(await world.host.invoke({ op: 'status-porcelain', id: 'd1' }),
    { out: ' M src/app.js\n' });
  assert.deepEqual(await world.host.invoke({ op: 'commit-facts', id: 'd1' }),
    { pushState: { available: true, hasRemote: false, ahead: 0, behind: 0, dirty: 0 } });
  assert.deepEqual(await world.host.invoke({ op: 'commit-validate', message: 'chore: tidy' }),
    { ok: true });
  assert.deepEqual(await world.host.invoke({ op: 'commit-validate', message: '修复正文' }),
    { ok: true });

  const staged = [];
  world.git.stageAll = async (p) => { staged.push(['stage', p]); };
  world.git.commit = async (p, m) => { staged.push(['commit', p, m]); };
  world.git.pushState = async (p, branch, opts) => {
    staged.push(['pushState', p, branch, opts && opts.force === true]);
    return { dirty: 0, ahead: 3 };
  };
  assert.deepEqual(await world.host.invoke({ op: 'commit-run', id: 'd1', message: 'chore: tidy' }),
    { pushState: { dirty: 0, ahead: 3 } });
  assert.deepEqual(staged, [
    ['stage', '/p/a'],
    ['commit', '/p/a', 'chore: tidy'],
    ['pushState', '/p/a', 'main', true],
  ]);
  assert.deepEqual(world.calls.invalidated, [{ p: '/p/a', branch: 'main' }]);

  world.git.push = async (p, branch) => { staged.push(['push', p, branch]); return { pushed: true }; };
  assert.deepEqual(await world.host.invoke({ op: 'git-push', id: 'd1' }),
    { result: { pushed: true } });
  assert.deepEqual(staged.at(-1), ['push', '/p/a', 'main']);
  world.git.push = async () => { throw new Error('no remote'); };
  assert.deepEqual(await world.host.invoke({ op: 'git-push', id: 'd1' }), { error: 'no remote' });

  await world.host.invoke({ op: 'events-append', dirId: 'd1', kind: 'pushed', text: '1 个提交 → origin/main' });
  assert.deepEqual(world.calls.events, [{ dirId: 'd1', type: 'pushed', detail: '1 个提交 → origin/main' }]);
  // Unknown ids never reach a git subprocess.
  assert.deepEqual(await world.host.invoke({ op: 'commit-facts', id: 'gone' }),
    { error: 'directory not found' });
});

test('reorder rewrites the registry order and reports the ids it holds', async () => {
  const world = makeWorld({
    dirs: ['a', 'b', 'c', 'd'].map(id => ({ id, name: id, path: `/p/${id}` })),
  });
  const answer = await world.host.invoke({ op: 'dirs-reorder', order: ['c', 'a', 'b', 'd'] });
  assert.deepEqual(answer, { ids: ['c', 'a', 'b', 'd'] });
  assert.deepEqual([...world.table.keys()], ['c', 'a', 'b', 'd']);
  assert.equal(world.calls.saved, 1);
  assert.deepEqual(await world.host.invoke({ op: 'dir-ids' }),
    { ids: ['c', 'a', 'b', 'd'] });
});

test('the readiness prose and its one-click fix stay in the shared vocabulary', async () => {
  const world = makeWorld();
  assert.deepEqual(await world.host.invoke({ op: 'dir-reason', reason: 'path-missing' }),
    { detail: 'friendly:path-missing', fix: null });
  assert.deepEqual(await world.host.invoke({ op: 'dir-reason', reason: 'git-error: fatal' }),
    { detail: 'friendly:git-error: fatal', fix: 'open-ops-terminal' });
  // `body.reason || null`: an empty reason reaches the vocabulary as null.
  assert.deepEqual(await world.host.invoke({ op: 'dir-reason', reason: '' }),
    { detail: 'friendly:null', fix: null });
});

test('sample workspace creation is bounded to the managed sample root', async () => {
  const world = makeWorld({ fsDirs: new Set(['/data/samples']) });
  const first = await world.host.invoke({ op: 'sample-ensure' });
  assert.deepEqual(first, {
    name: 'MultiCC 入门示例',
    path: '/data/samples/getting-started',
    createdFiles: ['README.md', 'index.html', 'styles.css', 'TASKS.md'],
  });
  // A second call reuses existing files instead of overwriting them.
  const second = await world.host.invoke({ op: 'sample-ensure' });
  assert.deepEqual(second.createdFiles, []);
  assert.equal(world.calls.writes.length, 4);

  world.table.set('d1', { id: 'd1', name: 'sample', path: first.path });
  const marked = await world.host.invoke({ op: 'sample-mark', id: 'd1' });
  assert.equal(marked.dir.sample, true);
  assert.equal(world.calls.saved, 1);
  assert.deepEqual(await world.host.invoke({ op: 'sample-mark', id: 'gone' }),
    { error: 'directory not found' });
});

test('layout ops are the store, never a second normalizer', async () => {
  const world = makeWorld({ dirs: [{ id: 'd1', name: 'one', path: '/p/a' }] });
  assert.deepEqual(await world.host.invoke({ op: 'layout-load' }),
    { present: false, corrupt: false, data: null });
  const doc = { dirOrder: ['d1'], sessionOrder: { d1: ['s1'] }, updatedAt: '2026-01-01T00:00:00.000Z' };
  assert.deepEqual(await world.host.invoke({ op: 'layout-save', doc }), {});
  assert.deepEqual(world.calls.layoutSaved, [doc]);
  assert.deepEqual(await world.host.invoke({ op: 'layout-load' }),
    { present: true, corrupt: false, data: doc });
  assert.deepEqual(await world.host.invoke({ op: 'layout-known' }),
    { dirIds: ['d1'], sessionIds: { d1: [] } });
});

test('the host route only answers loopback with the documented envelopes', async () => {
  const handlers = {};
  const app = { post: (routePath, handler) => { handlers[routePath] = handler; } };
  const logged = [];
  const world = makeWorld();
  const host = createDirectoryHost({
    repo: world.repo, git: world.git, sessions: {}, events: {}, fsPort: world.fsPort,
    helpers: { resolveCwd: (c, a) => a, realPathOf: p => p, friendlyDirReason: r => String(r), dirReasonFix: () => null },
    tx: {}, uiLayout: world.uiLayout, isLocal: () => true,
    logger: { warn() {}, error: (...args) => logged.push(args) },
  });
  host.mount(app);
  assert.equal(typeof handlers[HOST_PATH], 'function');

  const run = async (body, { local = true } = {}) => {
    let status = 200;
    let payload;
    const res = {
      status(code) { status = code; return this; },
      json(value) { payload = value; return this; },
    };
    const deps = host.mount === app.post ? null : null;
    void deps;
    const remote = createDirectoryHost({
      repo: world.repo, git: world.git, sessions: {}, events: {}, fsPort: world.fsPort,
      helpers: { resolveCwd: (c, a) => a, realPathOf: p => p, friendlyDirReason: r => String(r), dirReasonFix: () => null },
      tx: {}, uiLayout: world.uiLayout, isLocal: () => local,
      logger: { warn() {}, error: (...args) => logged.push(args) },
    });
    const captured = {};
    remote.mount({ post: (routePath, handler) => { captured.route = routePath; captured.handler = handler; } });
    await captured.handler({ body }, res);
    return { status, payload };
  };

  assert.deepEqual(await run({ op: 'dir-ids' }, { local: false }),
    { status: 404, payload: { error: 'not found' } });
  assert.deepEqual(await run({ op: 'nope' }),
    { status: 400, payload: { error: 'unknown host operation' } });
  assert.deepEqual(await run({ op: 'dir-ids' }),
    { status: 200, payload: { ok: true, value: { ids: [] } } });
  assert.deepEqual(await run({}),
    { status: 400, payload: { error: 'unknown host operation' } });

  const throwing = createDirectoryHost({
    repo: { list() { throw new Error('boom'); } }, git: {}, sessions: {}, events: {},
    fsPort: {}, helpers: {}, tx: {},
    uiLayout: world.uiLayout, isLocal: () => true,
    logger: { warn() {}, error: (...args) => logged.push(args) },
  });
  const captured = {};
  throwing.mount({ post: (routePath, handler) => { captured.route = routePath; captured.handler = handler; } });
  let status = 200;
  let payload;
  await captured.handler({ body: { op: 'dir-ids' } }, {
    status(code) { status = code; return this; },
    json(value) { payload = value; return this; },
  });
  assert.deepEqual({ status, payload }, { status: 500, payload: { error: 'host operation failed' } });
  assert.equal(logged.length, 1);
  assert.equal(logged[0][1], 'dir-ids');
});

test('registerDefaultDirectory is the one boot-time registry path', async () => {
  const world = makeWorld();
  const denied = await world.host.registerDefaultDirectory({ name: 'x', path: '/home/u' });
  assert.deepEqual(denied, { ok: false, message: '不允许选择 $HOME 或更高层目录' });

  const created = await world.host.registerDefaultDirectory({ name: '  Default ', path: '/data/ws' });
  assert.equal(created.ok, true);
  assert.equal(created.data.id, 'id-1');
  assert.equal(created.data.name, 'Default');
  assert.equal(created.data.path, '/data/ws');
  assert.equal(world.fsPort.exists('/data/ws'), true);
  assert.equal(world.calls.saved, 1);
  assert.deepEqual(world.calls.seeded, ['id-1']);

  // Idempotent: an already-registered path answers the existing record.
  const again = await world.host.registerDefaultDirectory({ name: 'Default', path: '/data/ws' });
  assert.deepEqual(again, { ok: true, data: created.data });

  // A failed readiness probe removes the fresh record and never saves.
  world.git.ensureReady = () => ({ ok: false, reason: 'git-error: boom' });
  const failed = await world.host.registerDefaultDirectory({ name: 'B', path: '/data/ws2' });
  assert.deepEqual(failed, { ok: false, message: 'friendly:git-error: boom' });
  assert.equal(world.calls.saved, 1);
});
