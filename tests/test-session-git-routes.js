'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createSessionGitRuntime, LOADING_MERGE_STATE } = require('../src/routes/session-git');

function createFakeApp() {
  const routes = new Map();
  const register = method => (path, handler) => {
    const key = `${method} ${path}`;
    assert.equal(routes.has(key), false, `route registered only once: ${key}`);
    routes.set(key, handler);
  };
  return { routes, get: register('GET'), post: register('POST') };
}

async function invoke(handler, { params = {}, query = {}, body = {} } = {}) {
  const response = { statusCode: 200, body: undefined };
  const res = {
    status(code) { response.statusCode = code; return this; },
    json(value) { response.body = value; return this; },
  };
  await handler({ params, query, body }, res);
  return response;
}

function tick() {
  return new Promise(resolve => setImmediate(resolve));
}

function createFixture(overrides = {}) {
  let clock = overrides.clock === undefined ? 1000 : overrides.clock;
  const records = overrides.records || new Map([
    ['s1', {
      id: 's1', dirId: 'd1', branch: 'multicc/s1', worktreePath: '/repo/wt-s1',
      taskState: { classifyState: 'D' },
    }],
  ]);
  const directories = overrides.directories || new Map([
    ['d1', { id: 'd1', path: '/repo', baseBranch: 'main' }],
  ]);
  const terminalSessions = overrides.terminalSessions || new Map();
  const chatSessions = overrides.chatSessions || new Map();
  const calls = {
    mergeState: [], baseBranch: [], run: [], merge: [], sync: [], rebase: [],
    events: [], broadcasts: [], logs: [], warnings: [],
  };
  const implementations = {
    gitWorktreeMergeState: async (dir, session) => {
      calls.mergeState.push([dir.id, session.id]);
      return { mergeReady: true, dirty: false, ahead: 0, behind: 0, id: session.id };
    },
    gitBaseBranch: async repo => { calls.baseBranch.push(repo); return 'fallback-main'; },
    gitRunQueued: async (repo, args, options) => {
      calls.run.push({ repo, args, options });
      return args.includes('--stat') ? '1 file changed' : '';
    },
    gitMergeBack: async (dir, session) => {
      calls.merge.push([dir.id, session.id]);
      return { ok: true, merged: false, commits: 0 };
    },
    gitSyncFromBase: async (dir, session, options) => {
      calls.sync.push({ dir: dir.id, session: session.id, options });
      return { ok: true, merged: false, commits: 0, baseBranch: dir.baseBranch };
    },
    gitRebaseResolve: async (dir, session, action, options) => {
      calls.rebase.push({ dir: dir.id, session: session.id, action, options });
      return { ok: true, done: true };
    },
    ...overrides.implementations,
  };
  const runtime = createSessionGitRuntime({
    records,
    directories,
    terminalSessions,
    chatSessions,
    ...implementations,
    appendEvent: (...args) => calls.events.push(args),
    workspaceBroadcast: (...args) => calls.broadcasts.push(args),
    existsSync: overrides.existsSync || (() => true),
    now: () => clock,
    random: () => 0,
    logger: {
      log: value => calls.logs.push(value),
      warn: value => calls.warnings.push(value),
    },
    cacheTtlMs: overrides.cacheTtlMs,
    cacheJitterMs: overrides.cacheJitterMs,
    maxDiffBytes: overrides.maxDiffBytes,
  });
  const app = createFakeApp();
  runtime.mountRoutes(app);
  return {
    runtime, app, records, directories, terminalSessions, chatSessions, calls,
    setClock(value) { clock = value; },
  };
}

test('mountRoutes installs the six legacy routes once per app', () => {
  const fixture = createFixture();
  fixture.runtime.mountRoutes(fixture.app);
  assert.deepEqual(Object.keys(fixture.runtime).sort(), [
    'isWorktreeActive', 'mergeStateCached', 'mountRoutes',
  ]);
  assert.deepEqual([...fixture.app.routes.keys()].sort(), [
    'GET /api/git/log',
    'GET /api/sessions/:id/diff',
    'GET /api/sessions/:id/merge-status',
    'POST /api/sessions/:id/merge',
    'POST /api/sessions/:id/rebase',
    'POST /api/sessions/:id/sync',
  ].sort());
});

test('production host delegates the complete Git route surface through narrow ports', () => {
  const root = path.join(__dirname, '..');
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const source = fs.readFileSync(path.join(root, 'src/routes/session-git.js'), 'utf8');
  assert.match(server, /createSessionGitRuntime\s*\(\s*\{/);
  assert.match(server, /sessionGitRuntime\.mountRoutes\(app\)/);
  assert.doesNotMatch(server, /function\s+(?:sessionWorktreeActive|sessionSyncGate|autoSyncSiblingWorktrees)\b/);
  for (const route of [
    '/api/sessions/:id/merge-status', '/api/sessions/:id/diff', '/api/git/log',
    '/api/sessions/:id/merge', '/api/sessions/:id/sync', '/api/sessions/:id/rebase',
  ]) {
    assert.equal(server.includes(route), false, `${route} is no longer inline in the host`);
    assert.equal(source.includes(route), true, `${route} is owned by the bounded route module`);
  }
  assert.doesNotMatch(source, /require\(['"](?:\.\.\/)+server/);
});

test('merge-state cache is single-flight, bounded, and fresh refreshes immediately', async () => {
  let resolveFirst;
  let count = 0;
  const first = new Promise(resolve => { resolveFirst = resolve; });
  const fixture = createFixture({
    cacheTtlMs: 10,
    cacheJitterMs: 0,
    implementations: {
      gitWorktreeMergeState: async () => {
        count += 1;
        if (count === 1) return first;
        return { mergeReady: true, dirty: false, ahead: count, behind: 0 };
      },
    },
  });
  const dir = fixture.directories.get('d1');
  const session = fixture.records.get('s1');
  assert.deepEqual(fixture.runtime.mergeStateCached(dir, session), LOADING_MERGE_STATE);
  assert.deepEqual(fixture.runtime.mergeStateCached(dir, session), LOADING_MERGE_STATE);
  await tick();
  assert.equal(count, 1, 'concurrent cache misses share one computation');
  resolveFirst({ mergeReady: true, dirty: false, ahead: 1, behind: 0 });
  await tick();
  assert.equal(fixture.runtime.mergeStateCached(dir, session).ahead, 1);

  fixture.setClock(1011);
  assert.equal(fixture.runtime.mergeStateCached(dir, session).ahead, 1, 'expired cache serves stale while refreshing');
  await tick();
  assert.equal(count, 2);
  assert.equal(fixture.runtime.mergeStateCached(dir, session).ahead, 2);

  const fresh = await invoke(fixture.app.routes.get('POST /api/sessions/:id/merge'), {
    params: { id: 's1' },
  });
  assert.equal(fresh.statusCode, 200);
  assert.equal(fixture.runtime.mergeStateCached(dir, session).ahead, 3);
});

test('diff preserves missing-worktree errors, truncation and best-effort stat', async () => {
  const missing = createFixture({ existsSync: () => false });
  const missingResponse = await invoke(missing.app.routes.get('GET /api/sessions/:id/diff'), {
    params: { id: 's1' },
  });
  assert.equal(missingResponse.statusCode, 400);
  assert.deepEqual(missingResponse.body, { error: 'worktree missing' });

  let runCount = 0;
  const fixture = createFixture({
    maxDiffBytes: 5,
    directories: new Map([['d1', { id: 'd1', path: '/repo', baseBranch: null }]]),
    implementations: {
      gitRunQueued: async (repo, args, options) => {
        runCount += 1;
        fixture.calls.run.push({ repo, args, options });
        if (args.includes('--stat')) throw new Error('stat unavailable');
        return 'abcdefgh';
      },
    },
  });
  const response = await invoke(fixture.app.routes.get('GET /api/sessions/:id/diff'), {
    params: { id: 's1' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.baseBranch, 'fallback-main');
  assert.equal(response.body.diff, 'abcde');
  assert.equal(response.body.truncated, true);
  assert.equal(response.body.stat, '');
  assert.equal(response.body.error, null);
  assert.equal(runCount, 2);
  assert.deepEqual(fixture.calls.run[0].args, ['diff', '--no-color', 'fallback-main']);
});

test('diff maps max-buffer and ordinary errors without failing the response', async () => {
  const maxBuffer = createFixture({
    implementations: {
      gitRunQueued: async (_repo, args) => {
        if (args.includes('--stat')) return '';
        const error = new Error('large');
        error.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
        throw error;
      },
    },
  });
  const tooLarge = await invoke(maxBuffer.app.routes.get('GET /api/sessions/:id/diff'), {
    params: { id: 's1' },
  });
  assert.equal(tooLarge.body.truncated, true);
  assert.match(tooLarge.body.diff, /exceeds 1MB/);

  const failed = createFixture({
    implementations: {
      gitRunQueued: async (_repo, args) => {
        if (args.includes('--stat')) return '';
        const error = new Error('fallback');
        error.stderr = 'private git failure'.repeat(40);
        throw error;
      },
    },
  });
  const ordinary = await invoke(failed.app.routes.get('GET /api/sessions/:id/diff'), {
    params: { id: 's1' },
  });
  assert.equal(ordinary.body.diff, '');
  assert.equal(ordinary.body.error.length, 400);
});

test('git log bounds limit, supports all branches, and parses NUL records', async () => {
  const fixture = createFixture({
    implementations: {
      gitRunQueued: async (repo, args, options) => {
        fixture.calls.run.push({ repo, args, options });
        return [
          ['hash1', 'short1', 'Alice', '2026-01-01T00:00:00Z', 'Subject one', ', HEAD -> main'].join('\x00'),
          ['hash2', 'short2', 'Bob', '2026-01-02T00:00:00Z', 'Subject two', 'tag: v1'].join('\x00'),
        ].join('\n');
      },
    },
  });
  const response = await invoke(fixture.app.routes.get('GET /api/git/log'), {
    query: { sessionId: 's1', limit: '500', all: '1' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.repoPath, '/repo/wt-s1');
  assert.equal(response.body.commits.length, 2);
  assert.equal(response.body.commits[0].refs, 'HEAD -> main');
  assert.deepEqual(fixture.calls.run[0].args, [
    'log', '-100', '--format=%H%x00%h%x00%an%x00%aI%x00%s%x00%D', '--no-color', '--all',
  ]);

  const invalid = await invoke(fixture.app.routes.get('GET /api/git/log'));
  assert.equal(invalid.statusCode, 400);
  assert.deepEqual(invalid.body, { error: 'dirId or sessionId required' });
});

test('active and classify gates block sync while force bypasses both', async () => {
  const terminalSessions = new Map([['s1', {}]]);
  const fixture = createFixture({ terminalSessions });
  assert.equal(fixture.runtime.isWorktreeActive('s1'), true);
  const blocked = await invoke(fixture.app.routes.get('POST /api/sessions/:id/sync'), {
    params: { id: 's1' },
  });
  assert.equal(blocked.statusCode, 409);
  assert.deepEqual(blocked.body.reasons, ['busy']);
  assert.equal(blocked.body.classifyState, 'running');
  assert.equal(fixture.calls.sync.length, 0);

  terminalSessions.delete('s1');
  fixture.records.get('s1').taskState.classifyState = 'B';
  const classified = await invoke(fixture.app.routes.get('POST /api/sessions/:id/sync'), {
    params: { id: 's1' },
  });
  assert.equal(classified.statusCode, 409);
  assert.equal(classified.body.classifyState, 'B');

  terminalSessions.set('s1', {});
  const forced = await invoke(fixture.app.routes.get('POST /api/sessions/:id/sync'), {
    params: { id: 's1' }, query: { force: '1' },
  });
  assert.equal(forced.statusCode, 200);
  assert.equal(fixture.calls.sync.length, 1);
  assert.equal(fixture.calls.sync[0].options.force, true);
  assert.equal(fixture.calls.sync[0].options.activeCheck, null);
  assert.equal(fixture.calls.broadcasts.at(-1)[1].type, 'merge_status');
});

test('merge reports sibling active, dirty, unmerged, conflicts and successful sync', async () => {
  const records = new Map([
    ['s1', { id: 's1', dirId: 'd1', branch: 'b1', worktreePath: '/wt/1' }],
    ['active', { id: 'active', dirId: 'd1', branch: 'ba', worktreePath: '/wt/a' }],
    ['dirty', { id: 'dirty', dirId: 'd1', branch: 'bd', worktreePath: '/wt/d' }],
    ['ahead', { id: 'ahead', dirId: 'd1', branch: 'bh', worktreePath: '/wt/h' }],
    ['conflict', { id: 'conflict', dirId: 'd1', branch: 'bc', worktreePath: '/wt/c' }],
    ['good', { id: 'good', dirId: 'd1', branch: 'bg', worktreePath: '/wt/g' }],
    ['other', { id: 'other', dirId: 'd2', branch: 'bo', worktreePath: '/wt/o' }],
  ]);
  const fixture = createFixture({
    records,
    terminalSessions: new Map([['active', {}]]),
    implementations: {
      gitMergeBack: async () => ({ ok: true, merged: true, commits: 2 }),
      gitWorktreeMergeState: async (_dir, session) => {
        fixture.calls.mergeState.push(session.id);
        if (session.id === 'dirty') return { dirty: true, ahead: 0 };
        if (session.id === 'ahead') return { dirty: false, ahead: 2 };
        return { dirty: false, ahead: 0, mergeReady: true };
      },
      gitSyncFromBase: async (_dir, session, options) => {
        fixture.calls.sync.push({ session: session.id, options });
        if (session.id === 'conflict') return { ok: false, conflicts: ['same.js'] };
        return { ok: true, merged: true, commits: 3 };
      },
    },
  });
  const response = await invoke(fixture.app.routes.get('POST /api/sessions/:id/merge'), {
    params: { id: 's1' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.merged, true);
  assert.deepEqual(response.body.siblingsSynced, [
    { id: 'active', skipped: true, reason: 'active' },
    { id: 'dirty', skipped: true, reason: 'dirty' },
    { id: 'ahead', skipped: true, reason: 'unmerged' },
    { id: 'conflict', conflict: true, files: ['same.js'] },
    { id: 'good', commits: 3 },
  ]);
  assert.deepEqual(fixture.calls.sync.map(call => call.session), ['conflict', 'good']);
  assert.equal(typeof fixture.calls.sync[0].options.activeCheck, 'function');
  assert.equal(fixture.calls.broadcasts.some(([, event]) => event.sessionId === 'dirty'), true);
  assert.equal(fixture.calls.broadcasts.some(([, event]) => event.sessionId === 'ahead'), true);
  assert.equal(fixture.calls.broadcasts.some(([, event]) => event.sessionId === 'conflict'), true);
  assert.equal(fixture.calls.broadcasts.some(([, event]) => event.sessionId === 'good'), true);
});

test('merge preserves conflict and non-conflict legacy status codes', async () => {
  const conflict = createFixture({
    implementations: { gitMergeBack: async () => ({ ok: false, conflicts: ['a.js'] }) },
  });
  const response409 = await invoke(conflict.app.routes.get('POST /api/sessions/:id/merge'), {
    params: { id: 's1' },
  });
  assert.equal(response409.statusCode, 409);

  const blocked = createFixture({
    implementations: { gitMergeBack: async () => ({ ok: false, blocked: true, reasons: ['dirty'] }) },
  });
  const response400 = await invoke(blocked.app.routes.get('POST /api/sessions/:id/merge'), {
    params: { id: 's1' },
  });
  assert.equal(response400.statusCode, 400);
});

test('sync maps actor rejection metadata and conflict response broadcasts state', async () => {
  const rejected = createFixture({
    implementations: {
      gitSyncFromBase: async () => {
        const error = new Error('lease busy');
        error.code = 'SESSION_LEASED';
        error.operationId = 'op-sync';
        error.queueDepth = 4;
        throw error;
      },
    },
  });
  const blocked = await invoke(rejected.app.routes.get('POST /api/sessions/:id/sync'), {
    params: { id: 's1' },
  });
  assert.equal(blocked.statusCode, 400);
  assert.equal(blocked.body.operationId, 'op-sync');
  assert.equal(blocked.body.queueDepth, 4);
  assert.deepEqual(blocked.body.reasons, ['leased']);

  const conflict = createFixture({
    implementations: {
      gitSyncFromBase: async () => ({ ok: false, conflicts: ['one.js', 'two.js'] }),
    },
  });
  const response = await invoke(conflict.app.routes.get('POST /api/sessions/:id/sync'), {
    params: { id: 's1' },
  });
  assert.equal(response.statusCode, 409);
  assert.equal(conflict.calls.events.at(-1)[1], 'sync_conflict');
  assert.equal(conflict.calls.broadcasts.at(-1)[1].type, 'merge_status');
});

test('rebase maps action, force, conflict and actor operation metadata while always broadcasting', async () => {
  const conflict = createFixture({
    implementations: {
      gitRebaseResolve: async (_dir, _session, action, options) => {
        conflict.calls.rebase.push({ action, options });
        return { ok: false, conflicts: ['one.js'] };
      },
    },
  });
  const response = await invoke(conflict.app.routes.get('POST /api/sessions/:id/rebase'), {
    params: { id: 's1' }, body: { action: 'abort', force: true },
  });
  assert.equal(response.statusCode, 409);
  assert.equal(conflict.calls.rebase[0].action, 'abort');
  assert.equal(conflict.calls.rebase[0].options.activeCheck, null);
  assert.equal(conflict.calls.broadcasts.length, 1);

  const rejected = createFixture({
    implementations: {
      gitRebaseResolve: async () => {
        const error = new Error('active');
        error.code = 'SESSION_ACTIVE';
        error.operationId = 'op-rebase';
        error.queueDepth = 2;
        throw error;
      },
    },
  });
  const blocked = await invoke(rejected.app.routes.get('POST /api/sessions/:id/rebase'), {
    params: { id: 's1' },
  });
  assert.equal(blocked.statusCode, 400);
  assert.equal(blocked.body.operationId, 'op-rebase');
  assert.equal(blocked.body.queueDepth, 2);
  assert.deepEqual(blocked.body.reasons, ['active']);
  assert.equal(rejected.calls.broadcasts.length, 1);
});

test('route lookups preserve legacy 404/400 DTOs', async () => {
  const fixture = createFixture();
  const missingSession = await invoke(fixture.app.routes.get('GET /api/sessions/:id/merge-status'), {
    params: { id: 'missing' },
  });
  assert.equal(missingSession.statusCode, 404);
  assert.deepEqual(missingSession.body, { error: 'session not found' });

  fixture.records.get('s1').worktreePath = null;
  const noWorktree = await invoke(fixture.app.routes.get('POST /api/sessions/:id/merge'), {
    params: { id: 's1' },
  });
  assert.equal(noWorktree.statusCode, 400);
  assert.deepEqual(noWorktree.body, { error: '该会话没有 worktree，无需合并' });
});
