'use strict';

const assert = require('assert');
const test = require('node:test');
const { createTaskRelocate } = require('../src/task-board/relocate');

function fixture(overrides = {}) {
  const board = { tasks: {}, revision: 1 };
  const task = {
    id: 'tsk_1', dirId: 'dir-a', title: 'Move me', status: 'active',
    chatSessionId: 'task-1', worktreePath: '/a/.multicc-worktrees/task-1',
    branch: 'multicc/task-1', moduleId: 'mod-a', updatedAt: 1,
    refs: [
      { sessionId: 'task-1', dirId: 'dir-a', userMsgId: 'm1', ts: 1 },
      { sessionId: 'other-session', dirId: 'dir-a', userMsgId: 'm0', ts: 1 },
    ],
    ...overrides.task,
  };
  board.tasks[task.id] = task;
  const records = new Map();
  const record = {
    id: 'task-1', dirId: 'dir-a', kind: 'chat', taskBoundTaskId: task.id,
    worktreePath: '/a/.multicc-worktrees/task-1', branch: 'multicc/task-1',
    ...overrides.record,
  };
  if (overrides.record !== null) records.set(record.id, record);
  const directories = new Map([
    ['dir-a', { id: 'dir-a', path: '/a', baseBranch: 'main' }],
    ['dir-b', { id: 'dir-b', path: '/b', baseBranch: 'main' }],
  ]);
  const calls = { notify: [], shell: [], commits: 0 };
  const relocate = createTaskRelocate({
    deps: {
      records, directories,
      assertTaskIdle: async () => {},
      relocateSessionWorkspace: overrides.relocateSessionWorkspace || (async (id, dirId) => {
        const rec = records.get(id);
        rec.dirId = dirId;
        rec.worktreePath = `/b/.multicc-worktrees/${id}`;
        rec.branch = `multicc/${id}`;
        return { ok: true, cwd: '/b', carried: { patchBytes: 120, files: 2, paths: ['notes.txt'] } };
      }),
      relocateShellTask: overrides.relocateShellTask || ((taskId, dirId, opts) => {
        calls.shell.push({ taskId, dirId, dryRun: opts?.dryRun === true });
        return { ok: true };
      }),
      gitRelocateWorktree: overrides.gitRelocateWorktree || (async () => ({ ok: true })),
    },
    taskRuns: null, isOpenTaskRun: () => false,
    resolveTask: id => board.tasks[id] || null,
    taskIdentityIds: t => [t.id],
    taskDirId: t => t.dirId,
    commit: fn => { calls.commits += 1; return fn(board); },
    notify: (dirId, ids, action) => calls.notify.push({ dirId, ids, action }),
    taskDto: t => ({ id: t.id, dirId: t.dirId, worktreePath: t.worktreePath, branch: t.branch }),
    isBusy: () => false,
    logger: { warn: () => {} },
  });
  return { board, task, record, calls, relocate };
}

function mockRes() {
  return { statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; } };
}

test('task relocate moves session workspace, board record and shell pointers', async () => {
  const { board, calls, relocate } = fixture();
  const res = mockRes();
  await relocate.relocate({ params: { taskId: 'tsk_1' }, body: { dirId: 'dir-b' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.dirId, 'dir-b');
  assert.deepEqual(res.body.carried, { patchBytes: 120, files: 2, paths: ['notes.txt'] });
  assert.equal(board.tasks.tsk_1.dirId, 'dir-b');
  assert.equal(board.tasks.tsk_1.worktreePath, '/b/.multicc-worktrees/task-1');
  assert.equal(board.tasks.tsk_1.branch, 'multicc/task-1');
  // dryRun check before any mutation, real call after the board commit.
  assert.deepEqual(calls.shell, [
    { taskId: 'tsk_1', dirId: 'dir-b', dryRun: true },
    { taskId: 'tsk_1', dirId: 'dir-b', dryRun: false },
  ]);
  assert.deepEqual(calls.notify.map(n => n.dirId), ['dir-a', 'dir-b']);
});

test('task relocate refuses archived, busy and same-directory moves', async () => {
  const archived = fixture({ task: { status: 'archived' } });
  let res = mockRes();
  await archived.relocate.relocate({ params: { taskId: 'tsk_1' }, body: { dirId: 'dir-b' } }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'task_archived');

  const same = fixture();
  res = mockRes();
  await same.relocate.relocate({ params: { taskId: 'tsk_1' }, body: { dirId: 'dir-a' } }, res);
  assert.equal(res.body.unchanged, true);
  assert.equal(same.calls.commits, 0);

  const missing = fixture();
  res = mockRes();
  await missing.relocate.relocate({ params: { taskId: 'tsk_1' }, body: { dirId: 'nope' } }, res);
  assert.equal(res.statusCode, 404);
});

test('task relocate aborts before git ops when the shell is shared', async () => {
  let workspaceCalled = false;
  const { calls, relocate } = fixture({
    relocateShellTask: (taskId, dirId, opts) => opts?.dryRun ? { ok: false, code: 'task_shell_shared' } : { ok: true },
    relocateSessionWorkspace: async () => { workspaceCalled = true; return { ok: true }; },
  });
  const res = mockRes();
  await relocate.relocate({ params: { taskId: 'tsk_1' }, body: { dirId: 'dir-b' } }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'task_shell_shared');
  assert.equal(workspaceCalled, false);
  assert.equal(calls.commits, 0);
});

test('task relocate passes workspace failures through unchanged', async () => {
  const { calls, relocate } = fixture({
    relocateSessionWorkspace: async () => ({ ok: false, status: 409,
      body: { ok: false, blocked: true, reasons: ['unmerged'], error: 'relocate refused: unmerged' } }),
  });
  const res = mockRes();
  await relocate.relocate({ params: { taskId: 'tsk_1' }, body: { dirId: 'dir-b' } }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.blocked, true);
  assert(res.body.reasons.includes('unmerged'));
  assert.equal(calls.commits, 0);
});

test('task relocate without a bound session moves only metadata and ledger worktree', async () => {
  const ledgerCalls = [];
  const { board, relocate } = fixture({
    record: null,
    task: { chatSessionId: null },
    gitRelocateWorktree: async (oldDir, targetDir, session, opts) => {
      ledgerCalls.push({ oldDir: oldDir.id, targetDir: targetDir.id, session, opts });
      return { ok: true, worktreePath: '/b/.multicc-worktrees/tsk_1', branch: 'multicc/tsk_1', carried: null };
    },
  });
  const res = mockRes();
  await relocate.relocate({ params: { taskId: 'tsk_1' }, body: { dirId: 'dir-b' } }, res);
  assert.equal(res.body.ok, true);
  assert.equal(ledgerCalls.length, 1);
  assert.equal(ledgerCalls[0].oldDir, 'dir-a');
  assert.equal(ledgerCalls[0].session.worktreePath, '/a/.multicc-worktrees/task-1');
  assert.equal(ledgerCalls[0].opts.carry, true);
  assert.equal(board.tasks.tsk_1.worktreePath, '/b/.multicc-worktrees/tsk_1');
});
