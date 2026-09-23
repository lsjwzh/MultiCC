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
  assert.equal((await f.call('post', '/send', { text: 'continue' })).body.error, 'task_archived');
  assert.equal((await f.call('post', '/answer', { text: 'answer' })).body.error, 'task_archived');
  assert.equal((await f.call('post', '/status', { status: 'active' })).statusCode, 200);
  assert.equal(f.board.tasks.old.status, 'active');
  assert.deepEqual(f.purged, []);
});

test('permanent deletion removes the task and prevents late messages recreating it after restart', async t => {
  const f = harness(t);
  assert.equal((await f.call('delete')).body.deleted, true);
  assert.equal(f.board.tasks.old, undefined);
  assert.equal((await f.call('get')).statusCode, 404);
  assert.deepEqual(f.purged, [['old']]);
  assert.equal((await f.call('delete')).body.deleted, true);
  const restarted = createTaskBoardRuntime(f.deps);
  assert.equal(restarted.getBoard().tasks.old, undefined);
  assert.equal(core.createPendingTask(restarted.getBoard(), { taskId: 'old', sessionId: 's1', taskText: 'late' }), null);
  assert.equal(restarted.registerShellTask({ id: 'old', sessionId: 's1' }).error, 'task_deleted');
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
  assert.equal((await f.call('post', '/send', { text: 'no' })).body.error, 'task_deleting');
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
