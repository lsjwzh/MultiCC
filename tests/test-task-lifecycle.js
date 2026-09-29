'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mkRuntime } = require('./helpers/task-board-runtime');
const { fixture } = require('./helpers/task-shell');
const core = require('../src/task-board/core');
const { createTaskBoardRuntime } = require('../src/routes/task-board');
const { createTaskLifecycleHost } = require('../src/task-board/lifecycle-host');
const { createTaskRetention, retentionCandidates, lastInteraction } = require('../src/task-board/retention');
const { createTaskHistoryRetention } = require('../src/session/task-history-retention');
const { createChatHistoryService } = require('../src/session/chat-history-service');

function harness(t, overrides = {}) {
  const purged = [];
  const f = mkRuntime({ taskShellTaskAccess: () => ({ readOnly: true }),
    purgeTaskData: async (_task, ids) => purged.push(ids), ...overrides });
  t.after(() => fs.rmSync(path.dirname(f.file), { recursive: true, force: true }));
  const board = f.runtime.getBoard();
  board.tasks.old = { id: 'old', title: 'Historical task', status: 'active', origin: 'session', refs: [], areas: [] };
  const routes = new Map();
  f.runtime.mountRoutes(Object.fromEntries(['get', 'post', 'delete'].map(method => [method, (url, handler) => routes.set(`${method} ${url}`, handler)])));
  async function call(method, suffix = '', body = {}) {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
    await routes.get(`${method} /api/task-board/tasks/:taskId${suffix}`)({ params: { taskId: 'old' }, body }, res);
    return res;
  }
  return { ...f, board, purged, call };
}

test('historical read-only tasks can archive, reject execution and restore', async t => {
  const f = harness(t);
  assert.equal((await f.call('post', '/status', { status: 'archived' })).statusCode, 200);
  assert.equal(f.board.tasks.old.status, 'archived');
  assert.equal((await f.call('post', '/status', { status: 'done' })).body.error, 'task_archived');
  assert.equal((await f.call('post', '/relocate', { dirId: 'd' })).body.error, 'task_archived');
  assert.equal((await f.call('post', '/status', { status: 'active' })).statusCode, 200);
  assert.equal(f.board.tasks.old.status, 'active');
  assert.deepEqual(f.purged, []);
});

test('permanent deletion removes the task and prevents late messages recreating it after restart', async t => {
  const f = harness(t);
  assert.equal((await f.call('delete')).body.deleted, true);
  assert.equal(f.board.tasks.old, undefined);
  assert.deepEqual(f.purged, [['old']]);
  assert.equal((await f.call('delete')).body.deleted, true);
  const restarted = createTaskBoardRuntime(f.deps);
  assert.equal(restarted.getBoard().tasks.old, undefined);
  assert.equal(core.createPendingTask(restarted.getBoard(), { taskId: 'old', sessionId: 's1', taskText: 'late' }), null);
  assert.equal(restarted.registerShellTask({ id: 'old', sessionId: 's1' }).error, 'task_deleted');
});

test('at the directory cap, eviction removes the oldest safe completed task through normal lifecycle', async t => {
  let full = true;
  const calls = [];
  const f = harness(t, {
    getPinnedTaskIds: () => ['pinned'],
    prepareTaskDelete: async (task, ids, options) => {
      calls.push(['prepare', task.id, ids, options]);
      if (task.id === 'unsafe') throw Object.assign(new Error('dirty'), { code: 'task_workspace_dirty' });
    },
    purgeTaskData: async (task, ids, options) => {
      calls.push(['purge', task.id, ids, options]);
      full = false;
    },
  });
  delete f.board.tasks.old;
  for (const [id, at] of [['unsafe', 10], ['safe', 20], ['pinned', 5], ['active', 1], ['never', 0]]) {
    f.board.tasks[id] = { id, dirId: 'dir-1', title: id, status: id === 'active' ? 'active' : 'done',
      refs: id === 'never' ? [] : [{ sessionId: `s-${id}`, userMsgId: `u-${id}`, ts: at }] };
    f.deps.records.set(`s-${id}`, { id: `s-${id}`, dirId: 'dir-1', taskBoundTaskId: id,
      lastWorkAt: new Date(at || 1000).toISOString() });
  }
  const shellTasks = Object.keys(f.board.tasks).map(id => ({ id, dirId: 'dir-1', sessionId: `s-${id}`, ready: true }));
  const result = await f.runtime.evictOldestSafeTask('dir-1', () => shellTasks, () => full);
  assert.deepEqual(result, { evicted: true, taskId: 'safe' });
  assert.equal(f.board.tasks.safe, undefined);
  assert.ok(f.board.deletedTaskIds.includes('safe'));
  assert.ok(f.board.tasks.unsafe && f.board.tasks.pinned && f.board.tasks.active && f.board.tasks.never);
  assert.deepEqual(calls, [
    ['prepare', 'unsafe', ['unsafe'], { force: false, automatic: true }],
    ['prepare', 'safe', ['safe'], { force: false, automatic: true }],
    ['prepare', 'safe', ['safe'], { force: false, automatic: true }],
    ['purge', 'safe', ['safe'], { force: false, automatic: true }],
  ]);
});

test('at the cap, no safe completed candidate refuses admission without deleting anything', async t => {
  const f = harness(t, { getPinnedTaskIds: () => ['old'] });
  f.board.tasks.old.dirId = 'dir-1';
  f.board.tasks.old.status = 'done';
  f.deps.records.set('s-old', { id: 's-old', dirId: 'dir-1', taskBoundTaskId: 'old', lastWorkAt: new Date(1).toISOString() });
  await assert.rejects(f.runtime.evictOldestSafeTask('dir-1',
    () => [{ id: 'old', dirId: 'dir-1', sessionId: 's-old', ready: true }], () => true),
  { code: 'task_shell_task_limit', status: 409 });
  assert.ok(f.board.tasks.old);
  assert.deepEqual(f.purged, []);
});

test('retention excludes unfinished archives, live sessions, shared executions and the source task', () => {
  const specs = [
    ['done', { status: 'done' }, 's-done'],
    ['archive-done', { status: 'archived', archivedFromStatus: 'done' }, 's-archive-done'],
    ['archive-active', { status: 'archived', archivedFromStatus: 'active' }, 's-archive-active'],
    ['running', { status: 'done' }, 's-running'],
    ['shared', { status: 'done' }, 's-shared'],
    ['source', { status: 'done' }, 's-source'],
  ];
  const board = { tasks: Object.fromEntries(specs.map(([id, patch, sessionId]) => [id, {
    id, dirId: 'd', refs: [{ sessionId, userMsgId: `u-${id}`, ts: 2 }], ...patch,
  }])) };
  const records = new Map(specs.map(([id, , sessionId]) => [sessionId, {
    id: sessionId, dirId: 'd', taskBoundTaskId: id === 'shared' ? null : id,
    lastWorkAt: new Date(id === 'source' ? 1 : 2).toISOString(),
  }]));
  const result = retentionCandidates({ board, records, dirId: 'd', pinnedIds: [], excludedIds: ['source'],
    shellTasks: specs.map(([id, , sessionId]) => ({ id, dirId: 'd', ready: true, sessionId })),
    getRunState: id => id === 's-running' ? 'running' : 'succeeded',
    isSessionBusy: () => false, taskDirId: task => task.dirId, taskLineageIds: task => [task.id],
  });
  assert.deepEqual(result.map(item => item.id), ['archive-done', 'done']);
  assert.equal(lastInteraction({ refs: [{ sessionId: 's-done', userMsgId: 'u', ts: 42 }] },
    { id: 's-done', lastWorkAt: new Date(9999).toISOString() }), 42,
  'workspace housekeeping must not change the last actual interaction');
});

test('a pin added during preflight prevents eviction', async () => {
  let pinned = [], deleted = 0;
  const board = { tasks: { old: { id: 'old', dirId: 'd', status: 'done',
    refs: [{ sessionId: 's-old', userMsgId: 'u-old', ts: 1 }] } } };
  const records = new Map([['s-old', { id: 's-old', dirId: 'd', taskBoundTaskId: 'old', lastWorkAt: new Date(1).toISOString() }]]);
  const retention = createTaskRetention({ getBoard: () => board, records, getPinnedTaskIds: () => pinned,
    getRunState: () => 'succeeded', taskDirId: task => task.dirId, taskLineageIds: task => [task.id],
    prepareDelete: async () => { pinned = ['old']; }, deleteById: async () => { deleted += 1; },
  });
  await assert.rejects(retention.evict('d', () => [{ id: 'old', dirId: 'd', sessionId: 's-old', ready: true }], () => true),
    { code: 'task_shell_task_limit' });
  assert.equal(deleted, 0);
});

test('parallel admissions share one eviction and recheck capacity', async () => {
  let full = true, deletions = 0, entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const board = { tasks: { old: { id: 'old', dirId: 'd', status: 'done',
    refs: [{ sessionId: 's-old', userMsgId: 'u-old', ts: 1 }] } } };
  const records = new Map([['s-old', { id: 's-old', dirId: 'd', taskBoundTaskId: 'old', lastWorkAt: new Date(1).toISOString() }]]);
  const retention = createTaskRetention({ getBoard: () => board, records,
    getPinnedTaskIds: () => [], getRunState: () => 'succeeded', taskDirId: task => task.dirId,
    taskLineageIds: task => [task.id],
    prepareDelete: async () => { entered(); await gate; },
    deleteById: async () => { deletions += 1; full = false; delete board.tasks.old; },
  });
  const list = () => [{ id: 'old', dirId: 'd', sessionId: 's-old', ready: true }];
  const first = retention.evict('d', list, () => full);
  await started;
  const second = retention.evict('d', list, () => full);
  release();
  assert.deepEqual(await Promise.all([first, second]), [
    { evicted: true, taskId: 'old' }, { evicted: false },
  ]);
  assert.equal(deletions, 1);
});

test('deletion marks and removes every merged identity before history cleanup', async t => {
  const f = harness(t, { purgeTaskData: async (_task, ids) => {
    assert.deepEqual(ids, ['old', 'alias']);
    assert.equal(f.board.tasks.old.deleting, true);
    assert.equal(f.board.tasks.alias.deleting, true);
  } });
  f.board.tasks.alias = { id: 'alias', mergedInto: 'old', status: 'archived', refs: [] };
  assert.equal((await f.call('delete')).body.deleted, true);
  assert.deepEqual(f.board.deletedTaskIds, ['old', 'alias']);
  assert.equal(f.board.tasks.alias, undefined);
});

test('delete reports every workspace risk, then forwards explicit force to cleanup', async t => {
  const calls = [];
  const f = harness(t, {
    prepareTaskDelete: async (_task, _ids, options) => {
      calls.push(['prepare', options]);
      if (!options.force) throw Object.assign(new Error('task_workspace_dirty'), {
        code: 'task_workspace_dirty', reasons: ['task_workspace_dirty', 'task_workspace_unmerged'],
      });
    },
    purgeTaskData: async (_task, ids, options) => calls.push(['purge', ids, options]),
  });
  const refused = await f.call('delete');
  assert.equal(refused.body.error, 'task_workspace_dirty');
  assert.deepEqual(refused.body.reasons, ['task_workspace_dirty', 'task_workspace_unmerged']);
  assert.equal(f.board.tasks.old.deleting, undefined);
  assert.equal(f.board.tasks.old.title, 'Historical task');
  assert.deepEqual(calls, [['prepare', { force: false }]]);

  assert.equal((await f.call('delete', '', { force: true })).body.deleted, true);
  assert.deepEqual(calls, [
    ['prepare', { force: false }],
    ['prepare', { force: true }],
    ['purge', ['old'], { force: true }],
  ]);
});

test('a legacy planned task deletes its own clean worktree without a chat session', async t => {
  const { execFile } = require('node:child_process');
  const exec = require('node:util').promisify(execFile);
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'multicc-task-delete-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => exec('git', args, { cwd: root });
  await git('init', '-b', 'main');
  await git('-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '--allow-empty', '-m', 'initial');
  const worktreePath = path.join(root, 'task-worktree');
  await git('worktree', 'add', '-b', 'task-branch', worktreePath);
  const task = { id: 'old', dirId: 'd', refs: [], worktreePath, branch: 'task-branch', deleting: true };
  const host = createTaskLifecycleHost({ records: new Map(), getBoard: () => ({ tasks: { old: task }, modules: {} }),
    getShell: () => ({ purgeTasks() {} }), getHistory: () => [], getState: () => null, getRunState: () => 'idle',
    getHistoryService: () => null, destroySession: () => assert.fail('no dedicated chat'),
    directories: new Map([['d', { id: 'd', path: root, baseBranch: 'main' }]]), persist() {} });
  await host.purgeTaskData(task, ['old']);
  assert.equal(fs.existsSync(worktreePath), false);
  assert.equal((await git('branch', '--list', 'task-branch')).stdout.trim(), '');
});

test('automatic eviction refuses ignored data even when Git reports a clean merged worktree', async t => {
  const { execFile } = require('node:child_process');
  const exec = require('node:util').promisify(execFile);
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'multicc-task-auto-evict-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => exec('git', args, { cwd: root });
  await git('init', '-b', 'main');
  fs.writeFileSync(path.join(root, '.gitignore'), 'private-data/\n');
  await git('add', '.gitignore');
  await git('-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-m', 'initial');
  const worktreePath = path.join(root, 'task-worktree');
  await git('worktree', 'add', '-b', 'task-branch', worktreePath);
  fs.mkdirSync(path.join(worktreePath, 'private-data'));
  fs.writeFileSync(path.join(worktreePath, 'private-data', 'draft.txt'), 'keep me');
  const task = { id: 'old', dirId: 'd', refs: [], worktreePath, branch: 'task-branch' };
  const host = createTaskLifecycleHost({ records: new Map(), getBoard: () => ({ tasks: { old: task }, modules: {} }),
    getShell: () => ({ stateTarget: () => ({}) }), getState: () => null, getRunState: () => 'idle',
    directories: new Map([['d', { id: 'd', path: root, baseBranch: 'main' }]]) });
  await assert.rejects(host.prepareTaskDelete(task, ['old'], { automatic: true }), { code: 'task_workspace_ignored' });
  assert.equal(fs.readFileSync(path.join(worktreePath, 'private-data', 'draft.txt'), 'utf8'), 'keep me');
  task.worktreePath = path.join(root, 'missing-checkout');
  await assert.rejects(host.prepareTaskDelete(task, ['old'], { automatic: true }), { code: 'task_workspace_unverifiable' });
  task.worktreePath = worktreePath;
  fs.writeFileSync(path.join(worktreePath, 'new-code.txt'), 'unmerged work');
  await exec('git', ['add', 'new-code.txt'], { cwd: worktreePath });
  await exec('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-m', 'not merged'], { cwd: worktreePath });
  await assert.rejects(host.prepareTaskDelete(task, ['old'], { automatic: true }), { code: 'task_workspace_unmerged' });
});

test('confirmed task deletion backs up and removes a dirty, ahead worktree', async t => {
  const { execFile } = require('node:child_process');
  const exec = require('node:util').promisify(execFile);
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'multicc-task-force-delete-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => exec('git', args, { cwd: root });
  await git('init', '-b', 'main');
  await git('-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '--allow-empty', '-m', 'initial');
  const worktreePath = path.join(root, 'task-worktree');
  await git('worktree', 'add', '-b', 'task-branch', worktreePath);
  const gitInWorktree = (...args) => exec('git', args, { cwd: worktreePath });
  fs.writeFileSync(path.join(worktreePath, 'committed.txt'), 'committed\n');
  fs.writeFileSync(path.join(worktreePath, '.gitignore'), 'ignored-repo/\n');
  await gitInWorktree('add', 'committed.txt', '.gitignore');
  await gitInWorktree('-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-m', 'task commit');
  fs.appendFileSync(path.join(worktreePath, 'committed.txt'), 'dirty\n');
  fs.writeFileSync(path.join(worktreePath, 'draft.txt'), 'untracked\n');
  const ignoredRepo = path.join(worktreePath, 'ignored-repo');
  fs.mkdirSync(ignoredRepo);
  await exec('git', ['init'], { cwd: ignoredRepo });
  fs.writeFileSync(path.join(ignoredRepo, 'ignored-local-code.txt'), 'not backed up\n');

  const task = { id: 'old', dirId: 'd', refs: [], worktreePath, branch: 'task-branch', deleting: true };
  const host = createTaskLifecycleHost({ records: new Map(), getBoard: () => ({ tasks: { old: task }, modules: {} }),
    getShell: () => ({ purgeTasks() {} }), getHistory: () => [], getState: () => null, getRunState: () => 'idle',
    getHistoryService: () => null, destroySession: () => assert.fail('no dedicated chat'),
    directories: new Map([['d', { id: 'd', path: root, baseBranch: 'main' }]]), persist() {} });

  await assert.rejects(host.prepareTaskDelete(task, ['old']), error => {
    assert.deepEqual(error.reasons, ['task_workspace_dirty', 'task_workspace_unmerged']);
    return true;
  });
  await host.purgeTaskData(task, ['old'], { force: true });

  assert.equal(fs.existsSync(worktreePath), false);
  assert.equal((await git('branch', '--list', 'task-branch')).stdout.trim(), '');
  const backupRoot = path.join(root, '.git', 'multicc-backups');
  const [operationId] = fs.readdirSync(backupRoot);
  const backup = path.join(backupRoot, operationId);
  assert.equal(fs.existsSync(path.join(backup, 'repository.bundle')), true);
  assert.match(fs.readFileSync(path.join(backup, 'dirty.patch'), 'utf8'), /dirty/);
  assert.equal(fs.readFileSync(path.join(backup, 'untracked', 'draft.txt'), 'utf8'), 'untracked\n');
});

test('manual task title sync updates only its bound session and broadcasts both planes', () => {
  const records = new Map([
    ['bound', { id: 'bound', dirId: 'd1', taskBoundTaskId: 'task-1', label: '旧标题' }],
    ['other', { id: 'other', dirId: 'd1', taskBoundTaskId: 'task-2', label: '别的任务' }],
  ]);
  const workspace = [], chat = [], mutations = [];
  const host = createTaskLifecycleHost({
    records,
    mutate(source, operation) { mutations.push(source); operation(records); },
    workspaceBroadcast: (dirId, event) => workspace.push([dirId, event]),
    chatBroadcast: (sessionId, event) => chat.push([sessionId, event]),
  });

  host.syncTaskTitle({ id: 'task-1', title: '新标题' });

  assert.deepEqual(mutations, ['task.title-rename']);
  assert.equal(records.get('bound').label, '新标题');
  assert.equal(records.get('other').label, '别的任务');
  const event = { type: 'session_updated', sessionId: 'bound', label: '新标题' };
  assert.deepEqual(workspace, [['d1', event]]);
  assert.deepEqual(chat, [['bound', event]]);
});

test('busy tasks are unchanged and failed deletion stays blocked until cleanup retry succeeds', async t => {
  let busy = true, fail = true;
  const f = harness(t, { assertTaskIdle: async () => { if (busy) throw Object.assign(new Error('busy'), { code: 'task_busy' }); },
    purgeTaskData: async () => { if (fail) throw Object.assign(new Error('disk'), { code: 'disk_failure' }); } });
  assert.equal((await f.call('post', '/status', { status: 'archived' })).body.error, 'task_busy');
  assert.equal((await f.call('delete')).body.error, 'task_busy');
  assert.equal((await f.call('delete', '', { force: true })).body.error, 'task_busy');
  assert.equal(f.board.tasks.old.deleting, undefined);
  busy = false;
  assert.equal((await f.call('delete')).body.error, 'disk_failure');
  assert.equal(f.board.tasks.old.deleting, true);
  assert.equal((await f.call('post', '/relocate', { dirId: 'd' })).body.error, 'task_deleting');
  fail = false;
  assert.equal((await f.call('delete')).body.deleted, true);
});

test('a permanent purge refusal rolls back the deleting barrier and names the pinning tasks', async t => {
  const f = harness(t, { purgeTaskData: async () => {
    throw Object.assign(new Error('task-linked history must be retained with its task archive'), {
      code: 'TASK_HISTORY_REFERENCED',
      tasks: [{ id: 'keep', title: '同壳任务', via: 'messages' }],
      taskIds: ['keep'],
    });
  } });
  const res = await f.call('delete');
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'TASK_HISTORY_REFERENCED');
  assert.deepEqual(res.body.taskIds, ['keep']);
  assert.deepEqual(res.body.tasks, [{ id: 'keep', title: '同壳任务', via: 'messages' }]);
  assert.match(res.body.message, /同一对话中的任务：「同壳任务」/);
  assert.equal(f.board.tasks.old.deleting, undefined, 'barrier rolled back — the card is not wedged');
  assert.equal((await f.call('post', '/status', { status: 'archived' })).statusCode, 200, 'task stays operable');
});

test('archive blocks shell controls and direct admission; purge clears cursor and links without affecting siblings', async t => {
  const tasks = new Map();
  const f = fixture(t, { getTask: id => tasks.get(id) });
  const task = f.runtime.adopt(f.a.id, 'a');
  const sibling = f.runtime.adopt(f.b.id, 'b');
  tasks.set(task.id, { id: task.id, status: 'archived' });
  await assert.rejects(f.runtime.send(f.a.id, { text: 'no', clientMsgId: 'no' }), { code: 'task_archived' });
  assert.equal(f.runtime.guardAdmission('a', 'no', { originContinue: true }).code, 'task_archived');
  assert.equal((await f.runtime.taskEntry(task.id)).readOnly, true);
  f.runtime.purgeTasks([task.id]);
  assert.equal(f.store.get('task', task.id), null);
  assert.equal(f.runtime.chatScope(f.a.id).taskId, null);
  assert.equal(f.runtime.chatScope(f.b.id).taskId, sibling.id);
});

test('purging task history retains messages jointly owned by another task and leaves the source session', async () => {
  const board = { tasks: { old: { id: 'old', deleting: true, refs: [{ sessionId: 's', userMsgId: 'u' }] },
    keep: { id: 'keep', refs: [{ sessionId: 's', userMsgId: 'shared' }] } } };
  const data = new Map([['s', [{ id: 'u', role: 'user', taskId: 'old', content: 'remove' },
    { id: 'shared', role: 'assistant', taskId: 'old', content: 'joint evidence' },
    { id: 'other', role: 'user', taskId: 'keep', content: 'keep' }]]]);
  const records = new Map([['s', { id: 's', kind: 'chat', taskState: { taskId: 'old' } }]]);
  const retention = createTaskHistoryRetention({ getBoard: () => board, getRecord: id => records.get(id), loadHistory: id => data.get(id) });
  const service = createChatHistoryService({ ...retention, idFactory: () => 'generated',
    history: { read: id => data.get(id), write: (id, ms) => data.set(id, ms), deleteSession: id => data.delete(id), hasPersistedDelivery: () => false } });
  const host = createTaskLifecycleHost({ records, getBoard: () => board, getShell: () => ({ stateTarget: () => ({}), purgeTasks() {} }),
    getHistory: id => service.read(id), getState: () => null, getRunState: () => 'idle', getHistoryService: () => service,
    destroySession: () => assert.fail('source session must remain'), directories: new Map(), persist() {} });
  await host.purgeTaskData(board.tasks.old, ['old']);
  assert.deepEqual(service.read('s').map(m => m.id), ['shared', 'other']);
  assert.equal(records.has('s'), true);
});
