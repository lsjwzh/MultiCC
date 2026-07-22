'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createSessionGitRuntime, LOADING_MERGE_STATE, parseDiffFiles } = require('../src/routes/session-git');

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

test('mountRoutes installs the nine routes once per app', () => {
  const fixture = createFixture();
  fixture.runtime.mountRoutes(fixture.app);
  assert.deepEqual(Object.keys(fixture.runtime).sort(), [
    'isWorktreeActive', 'mergeStateCached', 'mountRoutes',
  ]);
  assert.deepEqual([...fixture.app.routes.keys()].sort(), [
    'GET /api/git/commit-diff',
    'GET /api/git/log',
    'GET /api/sessions/:id/diff',
    'GET /api/sessions/:id/diff/file',
    'GET /api/sessions/:id/diff/files',
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
    '/api/sessions/:id/merge-status', '/api/sessions/:id/diff',
    '/api/sessions/:id/diff/files', '/api/sessions/:id/diff/file',
    '/api/git/log', '/api/git/commit-diff',
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

test('commit-diff validates hash, resolves directory, and returns diff/stat', async () => {
  const fixture = createFixture({
    implementations: {
      gitRunQueued: async (repo, args, options) => {
        fixture.calls.run.push({ repo, args, options });
        if (args.includes('--stat')) return '1 file changed, 2 insertions(+)';
        if (args.includes('--patch')) return 'diff --git a/foo b/foo\n+hello';
        return '';
      },
    },
  });

  // invalid hash (non-hex and injection attempts) -> 400
  const nonHex = await invoke(fixture.app.routes.get('GET /api/git/commit-diff'), {
    query: { dirId: 'd1', hash: 'zzz' },
  });
  assert.equal(nonHex.statusCode, 400);
  assert.deepEqual(nonHex.body, { error: 'invalid hash' });

  const injection = await invoke(fixture.app.routes.get('GET /api/git/commit-diff'), {
    query: { dirId: 'd1', hash: '--output=x' },
  });
  assert.equal(injection.statusCode, 400);
  assert.deepEqual(injection.body, { error: 'invalid hash' });

  // missing dirId / unknown dir -> 404
  const missingDirId = await invoke(fixture.app.routes.get('GET /api/git/commit-diff'), {
    query: { hash: 'abcdef0' },
  });
  assert.equal(missingDirId.statusCode, 404);
  assert.deepEqual(missingDirId.body, { error: 'directory not found' });

  const unknownDir = await invoke(fixture.app.routes.get('GET /api/git/commit-diff'), {
    query: { dirId: 'nope', hash: 'abcdef0' },
  });
  assert.equal(unknownDir.statusCode, 404);
  assert.deepEqual(unknownDir.body, { error: 'directory not found' });

  // valid hash -> 200 with diff/stat
  const response = await invoke(fixture.app.routes.get('GET /api/git/commit-diff'), {
    query: { dirId: 'd1', hash: 'abcdef0123' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.hash, 'abcdef0123');
  assert.equal(response.body.diff, 'diff --git a/foo b/foo\n+hello');
  assert.equal(response.body.stat, '1 file changed, 2 insertions(+)');
  assert.equal(response.body.truncated, false);
  assert.equal(response.body.error, null);
  assert.deepEqual(fixture.calls.run[0].args, ['show', '--format=', '--patch', 'abcdef0123']);
  assert.deepEqual(fixture.calls.run[1].args, ['show', '--format=', '--stat', 'abcdef0123']);
});

test('commit-diff falls back to diff range for empty show and truncates large diffs', async () => {
  let showPatchCalls = 0;
  const fixture = createFixture({
    maxDiffBytes: 10,
    implementations: {
      gitRunQueued: async (repo, args, options) => {
        fixture.calls.run.push({ repo, args, options });
        if (args.includes('--stat')) return '1 file changed';
        if (args[0] === 'show' && args.includes('--patch')) {
          showPatchCalls += 1;
          return ''; // merge commit: empty show patch
        }
        if (args[0] === 'diff' && args.includes('--patch')) {
          return 'fallback diff content here';
        }
        return '';
      },
    },
  });
  const response = await invoke(fixture.app.routes.get('GET /api/git/commit-diff'), {
    query: { dirId: 'd1', hash: 'abcdef0' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(showPatchCalls, 1);
  assert.equal(response.body.diff.length, 10);
  assert.equal(response.body.truncated, true);
  assert.equal(response.body.error, null);
  assert.deepEqual(fixture.calls.run[1].args, ['rev-parse', '--verify', '--quiet', 'abcdef0~1']);
  assert.deepEqual(fixture.calls.run[2].args, ['diff', '--patch', 'abcdef0~1', 'abcdef0']);
});

test('commit-diff treats maxBuffer overflow as a truncated placeholder, not an error', async () => {
  const fixture = createFixture({
    implementations: {
      gitRunQueued: async (repo, args, options) => {
        fixture.calls.run.push({ repo, args, options });
        if (args[0] === 'show' && args.includes('--patch')) {
          const err = new Error('stdio maxBuffer exceeded');
          err.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
          throw err;
        }
        if (args.includes('--stat')) return '1 file changed';
        return '';
      },
    },
  });
  const response = await invoke(fixture.app.routes.get('GET /api/git/commit-diff'), {
    query: { dirId: 'd1', hash: 'abcdef0123' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.truncated, true);
  assert.ok(String(response.body.diff).includes('exceeds'),
    'maxBuffer overflow should surface the exceeds placeholder');
  assert.equal(response.body.error, null);
  // placeholder diff is non-empty -> parent-range fallback is skipped entirely
  assert.equal(fixture.calls.run.filter(c => c.args[0] === 'diff').length, 0);
  assert.equal(fixture.calls.run.filter(c => c.args[0] === 'rev-parse').length, 0);
});

test('commit-diff returns a clean empty diff for root commits (no parent)', async () => {
  const fixture = createFixture({
    implementations: {
      gitRunQueued: async (repo, args, options) => {
        fixture.calls.run.push({ repo, args, options });
        if (args[0] === 'show' && args.includes('--patch')) return ''; // empty commit
        if (args[0] === 'rev-parse') {
          // root commit has no parent -> hash~1 does not resolve
          throw new Error("fatal: bad revision 'abcdef0~1'");
        }
        if (args.includes('--stat')) return '';
        return '';
      },
    },
  });
  const response = await invoke(fixture.app.routes.get('GET /api/git/commit-diff'), {
    query: { dirId: 'd1', hash: 'abcdef0' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.diff, '');
  assert.equal(response.body.error, null);
  assert.equal(response.body.truncated, false);
  // rev-parse failed -> parent-range diff is never attempted
  assert.equal(fixture.calls.run.filter(c => c.args[0] === 'diff').length, 0);
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

test('parseDiffFiles handles M/A/D, binary, rename, spaces and non-ASCII paths', () => {
  const numstat = [
    '10\t5\tsrc/foo.js',
    '-\t-\tsrc/binary.png',
    '20\t3\t',
    'old/path.js',
    'new/path.js',
    '1\t1\tsrc/my file.js',
    '2\t2\t中文/路径.js',
  ].join('\0') + '\0';
  const nameStatus = [
    'M', 'src/foo.js',
    'A', 'src/binary.png',
    'R100', 'old/path.js', 'new/path.js',
    'M', 'src/my file.js',
    'D', '中文/路径.js',
  ].join('\0') + '\0';
  const files = parseDiffFiles(numstat, nameStatus);
  assert.equal(files.length, 5);
  assert.deepEqual(files[0], {
    path: 'src/foo.js', oldPath: null, status: 'M',
    additions: 10, deletions: 5, binary: false,
  });
  assert.deepEqual(files[1], {
    path: 'src/binary.png', oldPath: null, status: 'A',
    additions: 0, deletions: 0, binary: true,
  });
  assert.deepEqual(files[2], {
    path: 'new/path.js', oldPath: 'old/path.js', status: 'R',
    additions: 20, deletions: 3, binary: false,
  });
  assert.deepEqual(files[3], {
    path: 'src/my file.js', oldPath: null, status: 'M',
    additions: 1, deletions: 1, binary: false,
  });
  assert.deepEqual(files[4], {
    path: '中文/路径.js', oldPath: null, status: 'D',
    additions: 2, deletions: 2, binary: false,
  });
});

test('parseDiffFiles returns empty array for empty input and falls back to M for missing status', () => {
  assert.deepEqual(parseDiffFiles('', ''), []);
  assert.deepEqual(parseDiffFiles('1\t1\tonly.js\0', ''), [
    { path: 'only.js', oldPath: null, status: 'M', additions: 1, deletions: 1, binary: false },
  ]);
});

test('diff/files aggregates numstat and name-status into a bounded file list', async () => {
  const fixture = createFixture({
    implementations: {
      gitRunQueued: async (repo, args, options) => {
        fixture.calls.run.push({ repo, args, options });
        if (args.includes('--numstat')) {
          return ['10\t5\tsrc/foo.js', '-\t-\tsrc/binary.png'].join('\0') + '\0';
        }
        if (args.includes('--name-status')) {
          return ['M', 'src/foo.js', 'A', 'src/binary.png'].join('\0') + '\0';
        }
        return '';
      },
    },
  });
  const response = await invoke(fixture.app.routes.get('GET /api/sessions/:id/diff/files'), {
    params: { id: 's1' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.baseBranch, 'main');
  assert.equal(response.body.branch, 'multicc/s1');
  assert.equal(response.body.totalFiles, 2);
  assert.equal(response.body.totalAdditions, 10);
  assert.equal(response.body.totalDeletions, 5);
  assert.equal(response.body.truncated, false);
  assert.equal(response.body.error, null);
  assert.deepEqual(response.body.files, [
    { path: 'src/foo.js', oldPath: null, status: 'M', additions: 10, deletions: 5, binary: false },
    { path: 'src/binary.png', oldPath: null, status: 'A', additions: 0, deletions: 0, binary: true },
  ]);
  assert.deepEqual(fixture.calls.run[0].args,
    ['-c', 'core.quotepath=false', 'diff', '--numstat', '--no-color', '-z', 'main']);
  assert.deepEqual(fixture.calls.run[1].args,
    ['-c', 'core.quotepath=false', 'diff', '--name-status', '--no-color', '-z', 'main']);
});

test('diff/files truncates at 500 files but reports the full total', async () => {
  const numstatEntries = [];
  const nameStatusEntries = [];
  for (let i = 0; i < 501; i++) {
    numstatEntries.push(`1\t1\tfile${i}.js`);
    nameStatusEntries.push('M', `file${i}.js`);
  }
  const fixture = createFixture({
    implementations: {
      gitRunQueued: async (repo, args) => {
        if (args.includes('--numstat')) return numstatEntries.join('\0') + '\0';
        if (args.includes('--name-status')) return nameStatusEntries.join('\0') + '\0';
        return '';
      },
    },
  });
  const response = await invoke(fixture.app.routes.get('GET /api/sessions/:id/diff/files'), {
    params: { id: 's1' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.totalFiles, 501);
  assert.equal(response.body.files.length, 500);
  assert.equal(response.body.truncated, true);
  assert.equal(response.body.totalAdditions, 501);
  assert.equal(response.body.totalDeletions, 501);
});

test('diff/files preserves missing-worktree error and maps git errors', async () => {
  const missing = createFixture({ existsSync: () => false });
  const missingResponse = await invoke(missing.app.routes.get('GET /api/sessions/:id/diff/files'), {
    params: { id: 's1' },
  });
  assert.equal(missingResponse.statusCode, 400);
  assert.deepEqual(missingResponse.body, { error: 'worktree missing' });

  const fixture = createFixture({
    implementations: {
      gitRunQueued: async (repo, args) => {
        if (args.includes('--numstat')) throw new Error('git failed');
        return '';
      },
    },
  });
  const response = await invoke(fixture.app.routes.get('GET /api/sessions/:id/diff/files'), {
    params: { id: 's1' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.error, 'git failed');
  assert.deepEqual(response.body.files, []);
  assert.equal(response.body.totalFiles, 0);
});

test('diff routes return 500 instead of hanging when gitBaseBranch rejects', async () => {
  const fixture = createFixture({
    directories: new Map([['d1', { id: 'd1', path: '/repo', baseBranch: null }]]),
    implementations: {
      gitBaseBranch: async () => { throw new Error('no remote HEAD'); },
    },
  });
  for (const [routeName, query] of [
    ['GET /api/sessions/:id/diff', {}],
    ['GET /api/sessions/:id/diff/files', {}],
    ['GET /api/sessions/:id/diff/file', { path: 'src/foo.js' }],
  ]) {
    const response = await invoke(fixture.app.routes.get(routeName), {
      params: { id: 's1' }, query,
    });
    assert.equal(response.statusCode, 500, `${routeName} returns 500`);
    assert.equal(response.body.error, 'no remote HEAD', `${routeName} surfaces error text`);
    assert.equal(fixture.calls.run.length, 0, `${routeName} does not invoke gitRunQueued`);
  }
});

test('diff/file validates path, separates args with --, and truncates large patches', async () => {
  const fixture = createFixture();
  const noPath = await invoke(fixture.app.routes.get('GET /api/sessions/:id/diff/file'), {
    params: { id: 's1' },
  });
  assert.equal(noPath.statusCode, 400);
  assert.match(noPath.body.error, /path required/);

  const dashed = await invoke(fixture.app.routes.get('GET /api/sessions/:id/diff/file'), {
    params: { id: 's1' }, query: { path: '-evil' },
  });
  assert.equal(dashed.statusCode, 400);
  assert.match(dashed.body.error, /must not start/);

  const longPath = await invoke(fixture.app.routes.get('GET /api/sessions/:id/diff/file'), {
    params: { id: 's1' }, query: { path: 'a'.repeat(501) },
  });
  assert.equal(longPath.statusCode, 400);

  const missing = createFixture({ existsSync: () => false });
  const missingResponse = await invoke(missing.app.routes.get('GET /api/sessions/:id/diff/file'), {
    params: { id: 's1' }, query: { path: 'src/foo.js' },
  });
  assert.equal(missingResponse.statusCode, 400);
  assert.deepEqual(missingResponse.body, { error: 'worktree missing' });

  const patchFixture = createFixture({
    implementations: {
      gitRunQueued: async (repo, args, options) => {
        patchFixture.calls.run.push({ repo, args, options });
        return 'diff --git a/foo b/foo\n+hello';
      },
    },
  });
  const response = await invoke(patchFixture.app.routes.get('GET /api/sessions/:id/diff/file'), {
    params: { id: 's1' }, query: { path: 'src/foo.js' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.path, 'src/foo.js');
  assert.equal(response.body.patch, 'diff --git a/foo b/foo\n+hello');
  assert.equal(response.body.truncated, false);
  assert.equal(response.body.error, null);
  assert.deepEqual(patchFixture.calls.run[0].args,
    ['diff', '--no-color', 'main', '--', 'src/foo.js']);

  const largeFixture = createFixture({
    implementations: {
      gitRunQueued: async () => 'x'.repeat(256 * 1024 + 100),
    },
  });
  const large = await invoke(largeFixture.app.routes.get('GET /api/sessions/:id/diff/file'), {
    params: { id: 's1' }, query: { path: 'src/big.js' },
  });
  assert.equal(large.body.truncated, true);
  assert.equal(large.body.patch.length, 256 * 1024);

  const errorFixture = createFixture({
    implementations: {
      gitRunQueued: async () => { throw new Error('diff failed'); },
    },
  });
  const errored = await invoke(errorFixture.app.routes.get('GET /api/sessions/:id/diff/file'), {
    params: { id: 's1' }, query: { path: 'src/foo.js' },
  });
  assert.equal(errored.body.patch, '');
  assert.equal(errored.body.error, 'diff failed');
});
