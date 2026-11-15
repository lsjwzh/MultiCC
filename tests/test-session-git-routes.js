'use strict';

// session/git 的 16 条公开路由现由 Rust 前门独占。Node 只保留宿主事实与
// 副作用端口，本文件逐 op 约束该端口契约（回环门禁、未知 op、输入/输出形状），
// 以及仍然留在 Node 的运行态行为：merge-state 缓存、isWorktreeActive、
// autoCommitTurn 与两个 git 输出解析器。HTTP 状态码与 DTO 键序由
// native/gateway/tests/session_git.rs 覆盖。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  createSessionGitRuntime, LOADING_MERGE_STATE, parseDiffFiles, parseCommitFiles,
} = require('../src/routes/session-git');
const { HOST_PATH } = require('../src/routes/session-git-host');

function createFakeApp() {
  const routes = new Map();
  const register = method => (routePath, handler) => {
    const key = `${method} ${routePath}`;
    assert.equal(routes.has(key), false, `route registered only once: ${key}`);
    routes.set(key, handler);
  };
  return { routes, get: register('GET'), post: register('POST') };
}

function createFakeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

async function callHandler(handler, request = {}) {
  const res = createFakeRes();
  await handler({ body: {}, query: {}, params: {}, ...request }, res);
  return res;
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
    events: [], broadcasts: [], logs: [], warnings: [], chatBroadcasts: [],
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
    resolveTaskWorktree: overrides.resolveTaskWorktree,
    cleanupTaskWorktree: overrides.cleanupTaskWorktree,
    ...implementations,
    appendEvent: (...args) => calls.events.push(args),
    workspaceBroadcast: (...args) => calls.broadcasts.push(args),
    chatBroadcast: (...args) => calls.chatBroadcasts.push(args),
    existsSync: overrides.existsSync || (() => true),
    now: () => clock,
    random: () => 0,
    asyncHandler: handler => handler,
    readFile: overrides.readFile || (async () => Buffer.from('')),
    isLocalRequest: overrides.isLocalRequest || (() => true),
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
  async function host(body, request = {}) {
    const handler = app.routes.get(`POST ${HOST_PATH}`);
    assert.equal(typeof handler, 'function', 'host route must be mounted');
    return callHandler(handler, { ...request, body });
  }
  return {
    runtime, app, records, directories, terminalSessions, chatSessions, calls, host,
    setClock(value) { clock = value; },
  };
}

test('mountRoutes installs the host port once per app', () => {
  const fixture = createFixture();
  fixture.runtime.mountRoutes(fixture.app);
  assert.deepEqual(Object.keys(fixture.runtime).sort(), [
    'autoCommitTurn', 'isWorktreeActive', 'mergeStateCached', 'mountRoutes',
  ]);
  assert.deepEqual([...fixture.app.routes.keys()], [`POST ${HOST_PATH}`]);
});

test('production host delegates the route surface to the Rust front door', () => {
  const root = path.join(__dirname, '..');
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const source = fs.readFileSync(path.join(root, 'src/routes/session-git.js'), 'utf8');
  assert.match(server, /createSessionGitRuntime\s*\(\s*\{/);
  assert.match(server, /sessionGitRuntime\.mountRoutes\(app\)/);
  assert.match(source, /require\('\.\/session-git-host'\)\.mountSessionGitHostRoute/);
  // No Express route literals remain in the runtime module.
  assert.doesNotMatch(source, /app\.get\('\/api\//);
  assert.doesNotMatch(source, /app\.post\('\/api\//);
});

test('the host port only answers loopback callers', async () => {
  const fixture = createFixture({ isLocalRequest: () => false });
  const response = await fixture.host({ op: 'session', sessionId: 's1' });
  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.body, { error: 'not found' });
});

test('an unknown host operation is a 400', async () => {
  const fixture = createFixture();
  const response = await fixture.host({ op: 'nope' });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.body, { error: 'unknown host operation' });
});

test('session resolves the workspace owner and reports worktree existence', async () => {
  const records = new Map([
    ['slot-1', { id: 'slot-1', dirId: 'd1', workspaceOwnerSessionId: 's1' }],
    ['s1', { id: 's1', dirId: 'd1', branch: 'multicc/s1', worktreePath: '/repo/wt-s1', workspaceState: 'active' }],
  ]);
  const fixture = createFixture({ records });
  const response = await fixture.host({ op: 'session', sessionId: 'slot-1' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.session, {
    id: 's1', worktreePath: '/repo/wt-s1', branch: 'multicc/s1', workspaceState: 'active',
  });
  assert.deepEqual(response.body.dir, { id: 'd1', path: '/repo', baseBranch: 'main' });
  assert.equal(response.body.worktreeExists, true);

  assert.deepEqual((await fixture.host({ op: 'session', sessionId: 'missing' })).body,
    { error: 'session not found' });
  const noDir = createFixture({ directories: new Map() });
  assert.deepEqual((await noDir.host({ op: 'session', sessionId: 's1' })).body,
    { error: 'directory not found' });
});

test('session reports a missing physical worktree', async () => {
  const fixture = createFixture({ existsSync: target => target === '/repo' });
  const response = await fixture.host({ op: 'session', sessionId: 's1' });
  assert.equal(response.body.worktreeExists, false);
});

test('lookup reads the raw maps without owner resolution', async () => {
  const fixture = createFixture();
  const response = await fixture.host({ op: 'lookup', sessionId: 's1', dirId: 'd1' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.session, {
    id: 's1', worktreePath: '/repo/wt-s1', branch: 'multicc/s1',
  });
  assert.deepEqual(response.body.dir, { id: 'd1', path: '/repo', baseBranch: 'main' });
  assert.equal(response.body.sessionWorktreeExists, true);
  assert.equal(response.body.dirPathExists, true);
  const none = await fixture.host({ op: 'lookup', sessionId: null, dirId: null });
  assert.deepEqual(none.body, {
    session: null, dir: null, sessionWorktreeExists: false, dirPathExists: false,
  });
});

test('merge-state serves the cache, fresh bypasses it, and task identity keys it', async () => {
  let calls = 0;
  const fixture = createFixture({
    implementations: {
      gitWorktreeMergeState: async () => {
        calls += 1;
        return { mergeReady: calls > 1, dirty: false, ahead: calls - 1, behind: 0 };
      },
    },
  });
  const cached = await fixture.host({ op: 'merge-state', sessionId: 's1', refresh: false });
  assert.deepEqual(cached.body.value, LOADING_MERGE_STATE);
  await tick();
  const fresh = await fixture.host({ op: 'merge-state', sessionId: 's1', refresh: true });
  assert.equal(fresh.body.value.mergeReady, true);
  assert.equal(calls, 2);
  assert.deepEqual((await fixture.host({ op: 'merge-state', sessionId: 'missing' })).body,
    { error: 'session not found' });

  const taskInfo = { dir: fixture.directories.get('d1'), worktreePath: '/repo/wt-t1', branch: 'task/t1', token: 't1' };
  const task = createFixture({ resolveTaskWorktree: id => (id === 't1' ? taskInfo : null) });
  // A task identity is not a record key, so the background sweep declines to
  // compute it: the cache stays "loading" until an explicit fresh read fills it
  // (the task merge route does exactly that for its broadcast).
  const pending = await task.host({ op: 'merge-state', taskId: 't1' });
  assert.equal(pending.statusCode, 200);
  assert.deepEqual(pending.body.value, LOADING_MERGE_STATE);
  await tick();
  assert.deepEqual((await task.host({ op: 'merge-state', taskId: 't1' })).body.value, LOADING_MERGE_STATE);
  assert.deepEqual(task.calls.mergeState, [], 'the sweep never runs git for an unknown record key');
  const freshTask = await task.host({ op: 'merge-state', taskId: 't1', refresh: true });
  assert.equal(freshTask.body.value.mergeReady, true);
  assert.deepEqual(task.calls.mergeState, [['d1', 't1']], 'identity id is the task token');
  assert.equal((await task.host({ op: 'merge-state', taskId: 't1' })).body.value.mergeReady, true);
  assert.deepEqual((await task.host({ op: 'merge-state', taskId: 'gone' })).body,
    { error: 'task_not_found' });
});

test('base-branch delegates to the repo actor probe', async () => {
  const fixture = createFixture();
  const response = await fixture.host({ op: 'base-branch', dirPath: '/repo' });
  assert.deepEqual(response.body, { ok: true, baseBranch: 'fallback-main' });
  assert.deepEqual(fixture.calls.baseBranch, ['/repo']);
});

test('git runs through the queue with the given options and reports failure facts', async () => {
  const fixture = createFixture();
  const ok = await fixture.host({ op: 'git', repo: '/repo', args: ['status', '--porcelain'], maxBuffer: 4096, raw: true });
  assert.deepEqual(ok.body, { ok: true, stdout: '' });
  assert.deepEqual(fixture.calls.run[0], {
    repo: '/repo', args: ['status', '--porcelain'], options: { maxBuffer: 4096, raw: true },
  });

  const failing = createFixture({
    implementations: {
      gitRunQueued: async () => {
        const error = new Error('Command failed: git diff');
        error.stderr = 'fatal: bad revision';
        throw error;
      },
    },
  });
  const bad = await failing.host({ op: 'git', repo: '/repo', args: ['diff'], maxBuffer: 1024, raw: false });
  assert.deepEqual(bad.body, {
    ok: false, stderr: 'fatal: bad revision', message: 'Command failed: git diff', maxBuffer: false,
  });

  const overflow = createFixture({
    implementations: {
      gitRunQueued: async () => {
        const error = new Error('maxBuffer exceeded');
        error.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
        throw error;
      },
    },
  });
  const huge = await overflow.host({ op: 'git', repo: '/repo', args: ['show'], maxBuffer: 1024, raw: false });
  assert.equal(huge.body.maxBuffer, true);
});

test('read-facts counts the lines of an untracked text file and flags binaries', async () => {
  const files = new Map([
    ['/repo/wt-s1/a.txt', Buffer.from('one\ntwo\n')],
    ['/repo/wt-s1/bin', Buffer.from([0, 1, 2])],
  ]);
  const fixture = createFixture({
    readFile: async target => {
      if (!files.has(target)) throw new Error('ENOENT');
      return files.get(target);
    },
  });
  const response = await fixture.host({
    op: 'read-facts', worktree: '/repo/wt-s1', paths: ['a.txt', 'bin', 'missing'],
  });
  assert.deepEqual(response.body.facts, [
    { path: 'a.txt', additions: 2, binary: false },
    { path: 'bin', additions: 0, binary: true },
    { path: 'missing', additions: 0, binary: false },
  ]);
});

test('read-text returns the decoded contents or a binary/missing marker', async () => {
  const fixture = createFixture({
    readFile: async target => {
      if (target.endsWith('/bin')) return Buffer.from([0, 9]);
      if (target.endsWith('/text')) return Buffer.from('hi\nthere');
      throw new Error('ENOENT');
    },
  });
  assert.deepEqual((await fixture.host({ op: 'read-text', worktree: '/w', path: 'text' })).body,
    { exists: true, binary: false, text: 'hi\nthere' });
  assert.deepEqual((await fixture.host({ op: 'read-text', worktree: '/w', path: 'bin' })).body,
    { exists: true, binary: true, text: '' });
  assert.deepEqual((await fixture.host({ op: 'read-text', worktree: '/w', path: 'gone' })).body,
    { exists: false, binary: false, text: '' });
});

test('task-worktree resolves the board worktree or reports a miss', async () => {
  const info = {
    dir: { id: 'd1', path: '/repo', baseBranch: 'main' },
    worktreePath: '/repo/wt-t1', branch: 'task/t1', token: 't1',
  };
  const fixture = createFixture({ resolveTaskWorktree: id => (id === 't1' ? info : null) });
  const found = await fixture.host({ op: 'task-worktree', taskId: 't1' });
  assert.equal(found.body.worktreeExists, true);
  assert.deepEqual(found.body.info, info);
  assert.deepEqual((await fixture.host({ op: 'task-worktree', taskId: 'gone' })).body, { info: null });

  const incomplete = createFixture({ resolveTaskWorktree: () => ({ dir: { id: 'd1' }, branch: 'x' }) });
  assert.deepEqual((await incomplete.host({ op: 'task-worktree', taskId: 't9' })).body, { info: null });
});

test('sync-gate-facts reports activity and the classify letter', async () => {
  const terminalSessions = new Map([['s1', {}]]);
  const fixture = createFixture({ terminalSessions });
  assert.deepEqual((await fixture.host({ op: 'sync-gate-facts', sessionId: 's1' })).body,
    { active: true, classifyState: 'D' });
  delete fixture.records.get('s1').taskState;
  assert.deepEqual((await fixture.host({ op: 'sync-gate-facts', sessionId: 's1' })).body,
    { active: true, classifyState: null });
});

test('session-merge runs the merge flow and reports the result', async () => {
  const fixture = createFixture();
  const response = await fixture.host({ op: 'session-merge', sessionId: 's1' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.result, { ok: true, merged: false, commits: 0 });
  assert.equal(fixture.calls.merge.length, 1);
  assert.equal(fixture.calls.broadcasts.at(-1)[1].type, 'merge_status');

  const failing = createFixture({
    implementations: {
      gitMergeBack: async () => {
        const error = new Error('boom');
        error.code = 'SESSION_ACTIVE';
        throw error;
      },
    },
  });
  // executeMergeBack converts a thrown git failure into failedGitResult itself.
  const failed = await failing.host({ op: 'session-merge', sessionId: 's1' });
  assert.equal(failed.body.result.ok, false);
  assert.equal(failed.body.result.blocked, true);
  assert.deepEqual(failed.body.result.reasons, ['active']);
});

test('session-sync broadcasts conflicts, maps success, and passes force through', async () => {
  const conflict = createFixture({
    implementations: {
      gitSyncFromBase: async () => ({ ok: false, conflicts: ['a.js', 'b.js'] }),
    },
  });
  const conflicted = await conflict.host({ op: 'session-sync', sessionId: 's1', force: false });
  assert.deepEqual(conflicted.body.result.conflicts, ['a.js', 'b.js']);
  assert.equal(conflict.calls.broadcasts.at(-1)[1].type, 'merge_status');
  assert.equal(conflict.calls.events.some(([, event]) => event === 'sync_conflict'), true);

  const fixture = createFixture();
  const ok = await fixture.host({ op: 'session-sync', sessionId: 's1', force: true });
  assert.deepEqual(ok.body.result, { ok: true, merged: false, commits: 0, baseBranch: 'main' });
  assert.equal(fixture.calls.sync[0].options.force, true);
  assert.equal(fixture.calls.sync[0].options.activeCheck, null);
  assert.equal(fixture.calls.events.some(([, event]) => event === 'synced'), true);

  const throwing = createFixture({
    implementations: { gitSyncFromBase: async () => { throw new Error('lease lost'); } },
  });
  const failed = await throwing.host({ op: 'session-sync', sessionId: 's1', force: true });
  assert.equal(failed.body.error.message, 'lease lost');
});

test('session-rebase maps action/force, broadcasts state, and reports the result', async () => {
  const fixture = createFixture();
  const response = await fixture.host({
    op: 'session-rebase', sessionId: 's1', action: 'abort', force: true,
  });
  assert.deepEqual(response.body.result, { ok: true, done: true });
  assert.deepEqual(fixture.calls.rebase[0], {
    dir: 'd1', session: 's1', action: 'abort', options: { activeCheck: null },
  });
  assert.equal(fixture.calls.broadcasts.at(-1)[1].type, 'merge_status');
  assert.equal(fixture.calls.events.at(-1)[1], 'synced');
});

test('session-rebase still broadcasts when the git transaction throws', async () => {
  // 退役的 Express handler 用 .catch(blockedGitResult) 接住 SESSION_ACTIVE，
  // 广播在 err 分支之后照样执行；宿主端口把错误交回前门渲染 blocked DTO 时
  // 也必须留着这次广播，否则 rebase 被拒后前端收不到状态刷新。
  const fixture = createFixture({
    implementations: {
      gitRebaseResolve: async () => { throw Object.assign(new Error('busy'), { code: 'SESSION_ACTIVE' }); },
    },
  });
  const response = await fixture.host({ op: 'session-rebase', sessionId: 's1', action: 'continue' });
  assert.equal(response.body.error.code, 'SESSION_ACTIVE');
  assert.equal(fixture.calls.broadcasts.length, 1);
  assert.equal(fixture.calls.broadcasts[0][1].type, 'merge_status');
  assert.equal(fixture.calls.events.length, 0);
});

test('task merge merges the task identity and reports a missing worktree', async () => {
  const info = { dir: { id: 'd1', path: '/repo', baseBranch: 'main' }, worktreePath: '/repo/wt-t1', branch: 'task/t1', token: 't1' };
  const fixture = createFixture({
    resolveTaskWorktree: id => (id === 't1' ? info : null),
    implementations: {
      gitMergeBack: async (dir, identity) => {
        fixture.calls.merge.push([dir.id, identity.id]);
        return { ok: true, merged: true, commits: 1 };
      },
    },
  });
  const response = await fixture.host({ op: 'task-merge', taskId: 't1' });
  assert.deepEqual(response.body.result, { ok: true, merged: true, commits: 1 });
  assert.deepEqual(fixture.calls.merge, [['d1', 't1']]);
  assert.equal(fixture.calls.broadcasts.at(-1)[1].taskId, 't1');

  assert.deepEqual((await fixture.host({ op: 'task-merge', taskId: 'gone' })).body, { missing: true });
});

test('task cleanup delegates to the board service and reports blocked/missing outcomes', async () => {
  const info = { dir: { id: 'd1', path: '/repo', baseBranch: 'main' }, worktreePath: '/repo/wt-t1', branch: 'task/t1', token: 't1' };
  const calls = [];
  const fixture = createFixture({
    resolveTaskWorktree: id => (id === 't1' ? info : null),
    cleanupTaskWorktree: async (id, opts) => {
      calls.push([id, opts]);
      return { ok: true, removed: true };
    },
  });
  const ok = await fixture.host({ op: 'task-cleanup', taskId: 't1', force: true });
  assert.deepEqual(ok.body.result, { ok: true, removed: true });
  assert.deepEqual(calls, [['t1', { force: true }]]);
  assert.equal(fixture.calls.events.some(([, event]) => event === 'worktree_cleanup'), true);
  assert.equal(fixture.calls.broadcasts.at(-1)[1].type, 'task_board_update');

  const blocked = createFixture({
    resolveTaskWorktree: () => info,
    cleanupTaskWorktree: async () => ({ ok: false, blocked: true }),
  });
  assert.deepEqual((await blocked.host({ op: 'task-cleanup', taskId: 't1', force: false })).body,
    { result: { ok: false, blocked: true } });

  const missing = createFixture({ resolveTaskWorktree: () => null });
  assert.deepEqual((await missing.host({ op: 'task-cleanup', taskId: 'gone', force: false })).body,
    { missing: true });
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

  const fresh = await fixture.host({ op: 'merge-state', sessionId: 's1', refresh: true });
  assert.equal(fresh.statusCode, 200);
  assert.equal(fixture.runtime.mergeStateCached(dir, session).ahead, 3);
});

test('active and classify gates are computed from live facts', () => {
  const terminalSessions = new Map([['s1', {}]]);
  const fixture = createFixture({ terminalSessions });
  assert.equal(fixture.runtime.isWorktreeActive('s1'), true);
  terminalSessions.delete('s1');
  assert.equal(fixture.runtime.isWorktreeActive('s1'), false);
  // A busy sibling in the same workspace counts; an unrelated one does not.
  const records = new Map([
    ['owner', { id: 'owner', dirId: 'd1' }],
    ['m1', { id: 'm1', dirId: 'd1', workspaceOwnerSessionId: 'owner' }],
    ['x1', { id: 'x1', dirId: 'd1', workspaceOwnerSessionId: 'other' }],
  ]);
  const chat = new Map([['m1', { isStreaming: true }]]);
  const shared = createFixture({ records, chatSessions: chat });
  assert.equal(shared.runtime.isWorktreeActive('owner'), true);
});

test('autoCommitTurn merges a ready worktree and reports the result to the chat', async () => {
  const fixture = createFixture({
    implementations: {
      gitMergeBack: async (dir, session) => {
        fixture.calls.merge.push([dir.id, session.id]);
        return { ok: true, merged: true, commits: 2, committed: true };
      },
    },
  });
  const result = await fixture.runtime.autoCommitTurn('s1');
  assert.equal(result.ok, true);
  assert.equal(result.merged, true);
  assert.deepEqual(fixture.calls.merge, [['d1', 's1']]);
  assert.equal(fixture.calls.logs.some(line => line.includes('auto-commit merge')), true);
  assert.equal(fixture.calls.events.some(([, event]) => event === 'merged'), true);
  assert.equal(fixture.calls.broadcasts.some(([, payload]) => payload.type === 'merge_status'
    && payload.sessionId === 's1'), true);
  assert.deepEqual(fixture.calls.chatBroadcasts, [['s1', {
    type: 'system', subtype: 'auto_commit',
    message: '✓ 自动提交完成：已合并 2 个提交回基分支（含本次自动提交）',
  }]]);
});

test('autoCommitTurn resolves the workspace owner before checking the switch', async () => {
  const records = new Map([
    ['slot-1', { id: 'slot-1', dirId: 'd1', workspaceOwnerSessionId: 's1' }],
    ['s1', { id: 's1', dirId: 'd1', branch: 'multicc/s1', worktreePath: '/repo/wt-s1' }],
  ]);
  const on = createFixture({ records });
  const merged = await on.runtime.autoCommitTurn('slot-1');
  assert.equal(merged.ok, true);
  assert.equal(on.calls.merge.length, 1, 'owner identity drives the merge');
  assert.equal(on.calls.chatBroadcasts[0][0], 's1', 'notice goes to the owner session');

  records.get('s1').autoCommit = false;
  const off = createFixture({ records });
  const skipped = await off.runtime.autoCommitTurn('slot-1');
  assert.deepEqual(skipped, { ok: false, skipped: true, reason: 'auto_commit_off' });
  assert.equal(off.calls.merge.length, 0);
  assert.equal(off.calls.chatBroadcasts.length, 0);
});

test('autoCommitTurn skips missing switch targets without touching git', async () => {
  const fixture = createFixture();
  assert.deepEqual(await fixture.runtime.autoCommitTurn('missing'),
    { ok: false, skipped: true, reason: 'session_not_found' });

  fixture.records.get('s1').worktreePath = null;
  assert.deepEqual(await fixture.runtime.autoCommitTurn('s1'),
    { ok: false, skipped: true, reason: 'no_worktree' });

  fixture.records.get('s1').worktreePath = '/repo/wt-s1';
  fixture.records.get('s1').workspaceState = 'hibernated';
  assert.deepEqual(await fixture.runtime.autoCommitTurn('s1'),
    { ok: false, skipped: true, reason: 'hibernated' });
  assert.equal(fixture.calls.merge.length, 0);
  assert.equal(fixture.calls.mergeState.length, 0, 'cheap gates run before any git read');
  assert.equal(fixture.calls.chatBroadcasts.length, 0);

  const gone = createFixture({ existsSync: () => false });
  assert.deepEqual(await gone.runtime.autoCommitTurn('s1'),
    { ok: false, skipped: true, reason: 'no_worktree' });
});

test('autoCommitTurn stays silent when the worktree has nothing to merge', async () => {
  const fixture = createFixture({
    implementations: {
      gitWorktreeMergeState: async () => ({ mergeReady: false, dirty: false, ahead: 0, behind: 0 }),
    },
  });
  const result = await fixture.runtime.autoCommitTurn('s1');
  assert.deepEqual(result, { ok: true, merged: false, skipped: true, reason: 'nothing_to_merge' });
  assert.equal(fixture.calls.merge.length, 0);
  assert.equal(fixture.calls.chatBroadcasts.length, 0, 'a clean worktree commits nothing and says nothing');
});

test('autoCommitTurn reports an empty merge and conflicts as chat system messages', async () => {
  const empty = createFixture({
    implementations: { gitMergeBack: async () => ({ ok: true, merged: false, commits: 0 }) },
  });
  await empty.runtime.autoCommitTurn('s1');
  assert.equal(empty.calls.chatBroadcasts.at(-1)[1].message, '✓ 自动提交：没有新提交需要合并');

  const conflicted = createFixture({
    implementations: { gitMergeBack: async () => ({ ok: false, conflicts: ['a.js', 'b.js'] }) },
  });
  const result = await conflicted.runtime.autoCommitTurn('s1');
  assert.equal(result.ok, false);
  assert.equal(conflicted.calls.chatBroadcasts.at(-1)[1].message,
    '⚠️ 自动提交冲突：请先手动合并。冲突文件：a.js, b.js');

  const failed = createFixture({
    implementations: { gitMergeBack: async () => ({ ok: false, error: 'spawn git ENOENT' }) },
  });
  await failed.runtime.autoCommitTurn('s1');
  assert.equal(failed.calls.chatBroadcasts.at(-1)[1].message, '自动提交失败：spawn git ENOENT');
});

test('autoCommitTurn tells the chat why a blocked merge did not land', async () => {
  const dirty = createFixture({
    implementations: { gitMergeBack: async () => ({ ok: false, blocked: true, reasons: ['base-dirty'],
      dirtyFiles: ['src/a.js', 'app/b.dart'], error: 'base worktree is dirty' }) },
  });
  const result = await dirty.runtime.autoCommitTurn('s1');
  assert.equal(result.blocked, true);
  const notice = dirty.calls.chatBroadcasts.at(-1)[1];
  assert.equal(notice.subtype, 'auto_commit');
  assert.match(notice.message, /^⚠️ 自动提交未合并：主仓库/);
  assert.match(notice.message, /src\/a\.js, app\/b\.dart/);
  assert.equal(dirty.calls.warnings.some(line => /blocked: base-dirty/.test(line)), true);

  const many = createFixture({
    implementations: { gitMergeBack: async () => ({ ok: false, blocked: true, reasons: ['base-dirty'],
      dirtyFiles: Array.from({ length: 10 }, (_, i) => `f${i}.js`) }) },
  });
  await many.runtime.autoCommitTurn('s1');
  assert.match(many.calls.chatBroadcasts.at(-1)[1].message, /f7\.js 等 10 个/);

  const detached = createFixture({
    implementations: { gitMergeBack: async () => ({ ok: false, blocked: true, reasons: ['base-not-checked-out'] }) },
  });
  await detached.runtime.autoCommitTurn('s1');
  assert.match(detached.calls.chatBroadcasts.at(-1)[1].message, /没有切在 .+ 分支上/);
});

test('autoCommitTurn runs once per session while a merge is in flight', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const fixture = createFixture({
    implementations: {
      gitMergeBack: async (dir, session) => {
        fixture.calls.merge.push([dir.id, session.id]);
        return gate;
      },
    },
  });
  const first = fixture.runtime.autoCommitTurn('s1');
  await tick();
  const second = await fixture.runtime.autoCommitTurn('s1');
  assert.deepEqual(second, { ok: false, skipped: true, reason: 'inflight' });
  release({ ok: true, merged: true, commits: 1 });
  const result = await first;
  assert.equal(result.merged, true);
  assert.equal(fixture.calls.merge.length, 1);
});

test('autoCommitTurn contains unexpected git failures', async () => {
  const fixture = createFixture({
    implementations: {
      gitMergeBack: async () => { throw new Error('boom'); },
    },
  });
  const result = await fixture.runtime.autoCommitTurn('s1');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'git_operation_failed');
  assert.equal(fixture.calls.warnings.length > 0, true);
  assert.equal(fixture.calls.chatBroadcasts.at(-1)[1].subtype, 'auto_commit');
});

test('parseDiffFiles handles M/A/D, binary, rename, spaces and non-ASCII paths', () => {
  // `git diff --numstat -z`: `add\\tdel\\tpath\\0`, or for renames
  // `add\\tdel\\t\\0old\\0new\\0`. `git diff --name-status -z` keeps status
  // and paths in their own NUL tokens.
  const numstat = [
    '10\t5\tsrc/foo.js',
    '3\t0\timage.png',
    '-\t-\tbin.dat',
    '2\t2\t', 'old name.js', 'renamed.js',
    '7\t1\tdir with space/file name.js',
    '1\t0\t中文路径.js',
    '',
  ].join('\0');
  const nameStatus = [
    'M', 'src/foo.js',
    'A', 'image.png',
    'M', 'bin.dat',
    'R100', 'old name.js', 'renamed.js',
    'M', 'dir with space/file name.js',
    'A', '中文路径.js',
    '',
  ].join('\0');
  const files = parseDiffFiles(numstat, nameStatus);
  assert.deepEqual(files, [
    { path: 'src/foo.js', oldPath: null, status: 'M', additions: 10, deletions: 5, binary: false },
    { path: 'image.png', oldPath: null, status: 'A', additions: 3, deletions: 0, binary: false },
    { path: 'bin.dat', oldPath: null, status: 'M', additions: 0, deletions: 0, binary: true },
    { path: 'renamed.js', oldPath: 'old name.js', status: 'R', additions: 2, deletions: 2, binary: false },
    { path: 'dir with space/file name.js', oldPath: null, status: 'M', additions: 7, deletions: 1, binary: false },
    { path: '中文路径.js', oldPath: null, status: 'A', additions: 1, deletions: 0, binary: false },
  ]);
  assert.deepEqual(parseCommitFiles('M\0README.md\0R100\0old name.txt\0new name.txt\0'), [
    { status: 'M', path: 'README.md' },
    { status: 'R100', oldPath: 'old name.txt', path: 'new name.txt' },
  ]);
});

test('parseDiffFiles returns empty array for empty input and falls back to M for missing status', () => {
  assert.deepEqual(parseDiffFiles('', ''), []);
  assert.deepEqual(parseDiffFiles('1\t1\tonly.js\0', ''), [
    { path: 'only.js', oldPath: null, status: 'M', additions: 1, deletions: 1, binary: false },
  ]);
});
