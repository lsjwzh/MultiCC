'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  gitWorktreeAdd,
  gitWorktreeDetach,
  gitWorktreeValidate,
} = require('../src/git/service');
const { initializeSessionWorktrees } = require('../src/session/hibernation');
const { createSessionHibernation } = require('../src/session/hibernation-composition');
const { recordsOf, resetTaskState } = require('./helpers/session-records');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-hibernate-git-'));
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.invalid']);
  git(dir, ['config', 'user.name', 'MultiCC Test']);
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.env\napp/build/\n');
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'base\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'base']);
  return dir;
}

function wakeRuntime(t, dir, added, extra = {}) {
  const id = path.basename(added.worktreePath);
  const record = { id, dirId: 'dir', kind: 'chat', taskBoundTaskId: `tsk-${id}`,
    workspaceState: 'hibernated', worktreePath: added.worktreePath, branch: added.branch };
  const records = recordsOf([[id, record]]);
  const chat = { cwd: added.worktreePath };
  const events = [];
  const runtime = createSessionHibernation({
    records, directories: new Map([['dir', { path: dir, baseBranch: 'main', ...extra }]]),
    persistence: { mutate: (_source, update) => update(records) },
    gitWorktreeAdd, gitWorktreeDetach, gitWorktreeValidate,
    invalidSessions: new Map(), chatSessions: new Map([[id, chat]]),
    workspaceBroadcast: (_dir, event) => events.push(event),
    metrics: { inc() {} }, logger: { info() {}, warn() {} },
  });
  t.after(() => runtime.stop());
  return { id, record, runtime, chat, events };
}

function commitFile(dir, name, content, message = 'feat(fixture): advance base branch') {
  fs.writeFileSync(path.join(dir, name), content);
  git(dir, ['add', name]);
  git(dir, ['commit', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}

test('production wake fast-forwards a clean retained branch to the latest configured base', async t => {
  const dir = repo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, ['branch', '-m', 'develop']);
  const added = await gitWorktreeAdd(dir, 'wake-ff', 'develop');
  await gitWorktreeDetach(dir, added.worktreePath, added.branch);
  const latest = commitFile(dir, 'upstream.txt', 'new base\n');
  // Local edits on the base checkout must never be included or altered.
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'base checkout dirty\n');
  const { id, runtime, record, events } = wakeRuntime(t, dir, added, { baseBranch: 'develop' });
  assert.deepEqual(await runtime.ensureAwake(id), { ok: true, thawed: true });
  assert.equal(git(added.worktreePath, ['rev-parse', 'HEAD']), latest);
  assert.equal(git(added.worktreePath, ['status', '--porcelain']), '');
  assert.equal(fs.readFileSync(path.join(dir, 'tracked.txt'), 'utf8'), 'base checkout dirty\n');
  assert.equal(record.workspaceStateErrorCode, null);
  assert.ok(events.some(event => event.action === 'sync' && event.status === 'success'));
});

test('production wake rebases an unmerged hibernation snapshot and retains its original ref', async t => {
  const dir = repo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const added = await gitWorktreeAdd(dir, 'wake-rebase', 'main');
  fs.writeFileSync(path.join(added.worktreePath, 'local.bin'), Buffer.from([0, 1, 255]));
  const { snapshot } = await gitWorktreeDetach(dir, added.worktreePath, added.branch);
  git(dir, ['branch', 'retained-sibling', snapshot]);
  git(dir, ['config', 'rebase.updateRefs', 'true']);
  git(dir, ['config', 'rebase.autoStash', 'true']);
  commitFile(dir, 'upstream.txt', 'latest\n');
  const { id, runtime, record } = wakeRuntime(t, dir, added);
  assert.equal((await runtime.ensureAwake(id)).ok, true);
  assert.equal(git(added.worktreePath, ['rev-list', '--left-right', '--count', 'HEAD...main']), '1\t0');
  assert.equal(git(added.worktreePath, ['status', '--porcelain']), '');
  assert.deepEqual(fs.readFileSync(path.join(added.worktreePath, 'local.bin')), Buffer.from([0, 1, 255]));
  assert.equal(fs.readFileSync(path.join(added.worktreePath, 'upstream.txt'), 'utf8'), 'latest\n');
  assert.equal(git(dir, ['rev-parse', `refs/multicc/wake-backups/${added.branch}/${snapshot}`]), snapshot);
  assert.equal(git(dir, ['rev-parse', 'retained-sibling']), snapshot, 'rebase.updateRefs must not move sibling refs');
  assert.equal(record.workspaceStateErrorCode, null);
});

test('production wake aborts a conflicting rebase, preserves bytes, and admits the original workspace', async t => {
  const dir = repo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const added = await gitWorktreeAdd(dir, 'wake-conflict', 'main');
  fs.writeFileSync(path.join(added.worktreePath, 'tracked.txt'), 'local change\n');
  const { snapshot } = await gitWorktreeDetach(dir, added.worktreePath, added.branch);
  const base = commitFile(dir, 'tracked.txt', 'base change\n');
  const { id, runtime, record, chat, events } = wakeRuntime(t, dir, added);
  let admitted = false;
  await runtime.admit(id, async () => {
    admitted = true;
    assert.equal(git(added.worktreePath, ['rev-parse', 'HEAD']), snapshot);
    assert.equal(git(added.worktreePath, ['symbolic-ref', '--short', 'HEAD']), added.branch);
    assert.equal(git(added.worktreePath, ['status', '--porcelain']), '');
    assert.equal(fs.readFileSync(path.join(added.worktreePath, 'tracked.txt'), 'utf8'), 'local change\n');
    assert.equal(fs.existsSync(git(added.worktreePath, ['rev-parse', '--git-path', 'rebase-merge'])), false);
  });
  assert.equal(admitted, true);
  assert.equal(git(dir, ['rev-parse', 'main']), base);
  assert.equal(record.workspaceState, 'awake');
  assert.equal(record.workspaceStateErrorCode, 'wake_sync_conflict', 'admission touch retains the warning');
  assert.equal(chat.cwd, added.worktreePath);
  assert.ok(events.some(event => event.action === 'sync' && event.code === 'wake_sync_conflict'));
});

test('production wake preserves staged, unstaged and untracked changes in a resident checkout', async t => {
  const dir = repo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const added = await gitWorktreeAdd(dir, 'wake-dirty', 'main');
  const head = git(added.worktreePath, ['rev-parse', 'HEAD']);
  commitFile(dir, 'upstream.txt', 'new base\n');
  fs.writeFileSync(path.join(added.worktreePath, 'tracked.txt'), 'staged\n');
  git(added.worktreePath, ['add', 'tracked.txt']);
  fs.writeFileSync(path.join(added.worktreePath, 'tracked.txt'), 'unstaged\n');
  fs.writeFileSync(path.join(added.worktreePath, 'untracked.txt'), 'untracked\n');
  const before = git(added.worktreePath, ['status', '--porcelain']);
  const { id, runtime, record } = wakeRuntime(t, dir, added);
  assert.equal((await runtime.ensureAwake(id)).ok, true);
  assert.equal(record.workspaceStateErrorCode, 'wake_sync_dirty');
  assert.equal(git(added.worktreePath, ['rev-parse', 'HEAD']), head);
  assert.equal(git(added.worktreePath, ['status', '--porcelain']), before);
  assert.equal(git(added.worktreePath, ['show', ':tracked.txt']), 'staged');
  assert.equal(fs.readFileSync(path.join(added.worktreePath, 'tracked.txt'), 'utf8'), 'unstaged\n');
  assert.equal(fs.readFileSync(path.join(added.worktreePath, 'untracked.txt'), 'utf8'), 'untracked\n');
});

test('production wake keeps an existing Git operation untouched even when status is clean', async t => {
  const dir = repo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const added = await gitWorktreeAdd(dir, 'wake-operation', 'main');
  const head = git(added.worktreePath, ['rev-parse', 'HEAD']);
  commitFile(dir, 'upstream.txt', 'new base\n');
  const marker = git(added.worktreePath, ['rev-parse', '--git-path', 'MERGE_HEAD']);
  fs.writeFileSync(marker, `${head}\n`);
  const { id, runtime, record } = wakeRuntime(t, dir, added);
  assert.equal((await runtime.ensureAwake(id)).ok, true);
  assert.equal(record.workspaceStateErrorCode, 'wake_sync_git_operation_active');
  assert.equal(fs.readFileSync(marker, 'utf8'), `${head}\n`);
  assert.equal(git(added.worktreePath, ['rev-parse', 'HEAD']), head);
});

test('production wake leaves an already-current branch with local commits unchanged', async t => {
  const dir = repo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const added = await gitWorktreeAdd(dir, 'wake-current', 'main');
  const tip = commitFile(added.worktreePath, 'local.txt', 'local\n', 'feat(fixture): preserve local work');
  await gitWorktreeDetach(dir, added.worktreePath, added.branch);
  const { id, runtime } = wakeRuntime(t, dir, added);
  assert.equal((await runtime.ensureAwake(id)).ok, true);
  assert.equal(git(added.worktreePath, ['rev-parse', 'HEAD']), tip);
});

test('production wake skips a missing base without making the restored workspace unavailable', async t => {
  const dir = repo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const added = await gitWorktreeAdd(dir, 'wake-base-missing', 'main');
  await gitWorktreeDetach(dir, added.worktreePath, added.branch);
  const { id, runtime, record } = wakeRuntime(t, dir, added, { baseBranch: 'deleted-base' });
  assert.equal((await runtime.ensureAwake(id)).ok, true);
  assert.equal(record.workspaceState, 'awake');
  assert.equal(record.workspaceStateErrorCode, 'wake_sync_base_missing');
});

test('production wake refuses to replay non-English historical commits without rewriting them', async t => {
  const dir = repo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const added = await gitWorktreeAdd(dir, 'wake-policy', 'main');
  const tip = commitFile(added.worktreePath, 'local.txt', 'local\n', '旧提交');
  await gitWorktreeDetach(dir, added.worktreePath, added.branch);
  commitFile(dir, 'upstream.txt', 'base\n');
  const { id, runtime, record } = wakeRuntime(t, dir, added);
  assert.equal((await runtime.ensureAwake(id)).ok, true);
  assert.equal(record.workspaceStateErrorCode, 'wake_sync_publication_policy');
  assert.equal(git(added.worktreePath, ['rev-parse', 'HEAD']), tip);
});

test('production wake recognizes changes already absorbed by the base without losing the retained tip', async t => {
  const dir = repo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const added = await gitWorktreeAdd(dir, 'wake-absorbed', 'main');
  const tip = commitFile(added.worktreePath, 'local.txt', 'delivered\n', 'feat(fixture): deliver local change');
  await gitWorktreeDetach(dir, added.worktreePath, added.branch);
  git(dir, ['merge', '--squash', added.branch]);
  git(dir, ['commit', '-m', 'feat(fixture): absorb delivered change']);
  commitFile(dir, 'upstream.txt', 'later base\n');
  const { id, runtime } = wakeRuntime(t, dir, added);
  assert.equal((await runtime.ensureAwake(id)).ok, true);
  assert.equal(git(added.worktreePath, ['rev-list', '--left-right', '--count', 'HEAD...main']), '0\t0');
  assert.equal(git(dir, ['rev-parse', `refs/multicc/wake-backups/${added.branch}/${tip}`]), tip);
  assert.equal(fs.readFileSync(path.join(added.worktreePath, 'local.txt'), 'utf8'), 'delivered\n');
});

test('production wake uses directory commit-policy despite local policy edits and inherited Git identity', async t => {
  const dir = repo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const policy = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'commit-policy.json'), 'utf8'));
  git(dir, ['config', 'user.name', policy.name]);
  git(dir, ['config', 'user.email', policy.email]);
  commitFile(dir, 'commit-policy.json', JSON.stringify(policy), 'chore(fixture): configure commit identity');
  const added = await gitWorktreeAdd(dir, 'wake-identity', 'main');
  const localPolicy = { name: 'Local Override', email: 'local@example.invalid' };
  fs.writeFileSync(path.join(added.worktreePath, 'commit-policy.json'), JSON.stringify(localPolicy));
  git(added.worktreePath, ['add', 'commit-policy.json']);
  commitFile(added.worktreePath, 'local.txt', 'local\n', 'feat(fixture): preserve local change');
  await gitWorktreeDetach(dir, added.worktreePath, added.branch);
  commitFile(dir, 'upstream.txt', 'latest\n');
  const { id, runtime, record } = wakeRuntime(t, dir, added);
  const vars = { GIT_AUTHOR_NAME: 'Wrong Author', GIT_AUTHOR_EMAIL: 'wrong@example.invalid',
    GIT_COMMITTER_NAME: 'Wrong Committer', GIT_COMMITTER_EMAIL: 'wrong@example.invalid' };
  const previous = Object.fromEntries(Object.keys(vars).map(key => [key, process.env[key]]));
  Object.assign(process.env, vars);
  try {
    assert.equal((await runtime.ensureAwake(id)).ok, true);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  assert.equal(record.workspaceStateErrorCode, null);
  assert.equal(git(added.worktreePath, ['log', '-1', '--format=%an|%ae|%cn|%ce']),
    `${policy.name}|${policy.email}|${policy.name}|${policy.email}`);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(added.worktreePath, 'commit-policy.json'), 'utf8')), localPolicy);
  assert.equal(git(added.worktreePath, ['rev-list', '--left-right', '--count', 'HEAD...main']), '1\t0');
});

test('detach snapshots dirty and untracked files, preserves branch, reclaims cache and thaws bytes', async t => {
  const dir = repo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const added = await gitWorktreeAdd(dir, 'bound-1', 'main');
  fs.writeFileSync(path.join(added.worktreePath, 'tracked.txt'), 'changed\n');
  fs.writeFileSync(path.join(added.worktreePath, 'new.txt'), Buffer.from([0, 1, 2, 255]));
  fs.mkdirSync(path.join(added.worktreePath, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(added.worktreePath, 'node_modules', 'pkg', 'cache.bin'), 'cache');

  const detached = await gitWorktreeDetach(dir, added.worktreePath, added.branch, {
    sessionId: 'bound-1',
  });
  assert.equal(detached.ok, true);
  assert.equal(detached.detached, true);
  assert.equal(fs.existsSync(added.worktreePath), false);
  assert.equal(git(dir, ['show-ref', '--verify', `refs/heads/${added.branch}`]).length > 0, true);
  assert.equal(git(dir, ['show', `${added.branch}:tracked.txt`]), 'changed');
  assert.equal(Buffer.from(git(dir, ['show', `${added.branch}:new.txt`]), 'binary').length > 0, true);

  const thawed = await gitWorktreeAdd(dir, 'bound-1', 'main', { requireExistingBranch: true });
  assert.equal(thawed.existing, false);
  assert.equal(fs.readFileSync(path.join(thawed.worktreePath, 'tracked.txt'), 'utf8'), 'changed\n');
  assert.deepEqual(fs.readFileSync(path.join(thawed.worktreePath, 'new.txt')), Buffer.from([0, 1, 2, 255]));
  assert.equal(fs.existsSync(path.join(thawed.worktreePath, 'node_modules')), false);
  assert.equal((await gitWorktreeValidate(dir, thawed.worktreePath, thawed.branch)).ok, true);
});

test('detach deletes unknown ignored files and returns an audit manifest', async t => {
  const dir = repo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const added = await gitWorktreeAdd(dir, 'bound-secret', 'main');
  fs.writeFileSync(path.join(added.worktreePath, '.env'), 'SECRET=goes-away\n');
  const detached = await gitWorktreeDetach(dir, added.worktreePath, added.branch, { sessionId: 'bound-secret' });
  assert.equal(detached.ok, true);
  assert.equal(detached.detached, true);
  assert.equal(fs.existsSync(added.worktreePath), false);
  const entry = detached.removedUnknownIgnored.find(item => item.path === '.env');
  assert.ok(entry, 'manifest records the deleted unknown ignored file');
  assert.equal(entry.bytes, Buffer.byteLength('SECRET=goes-away\n'));
  assert.ok(entry.mtime);
  // The branch is retained, so a thaw still works — only the ignored file is gone.
  const thawed = await gitWorktreeAdd(dir, 'bound-secret', 'main', { requireExistingBranch: true });
  assert.equal(fs.existsSync(path.join(thawed.worktreePath, '.env')), false);
});

test('detach refuses a clean checkout with an in-progress Git operation', async t => {
  const dir = repo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const added = await gitWorktreeAdd(dir, 'bound-merge', 'main');
  const marker = git(added.worktreePath, ['rev-parse', '--git-path', 'MERGE_HEAD']);
  fs.writeFileSync(path.isAbsolute(marker) ? marker : path.resolve(added.worktreePath, marker),
    `${git(added.worktreePath, ['rev-parse', 'HEAD'])}\n`);
  await assert.rejects(
    gitWorktreeDetach(dir, added.worktreePath, added.branch, { sessionId: 'bound-merge' }),
    error => error.code === 'HIBERNATE_GIT_OPERATION_ACTIVE' && error.operation === 'merge',
  );
  assert.equal(fs.existsSync(added.worktreePath), true);
  assert.equal(git(added.worktreePath, ['status', '--porcelain']), '');
});

test('requireExistingBranch never recreates a missing session branch from main', async t => {
  const dir = repo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(
    gitWorktreeAdd(dir, 'missing-bound', 'main', { requireExistingBranch: true }),
    error => error.code === 'WORKTREE_BRANCH_MISSING',
  );
  assert.throws(() => git(dir, ['show-ref', '--verify', 'refs/heads/multicc/missing-bound']));
});

test('path and branch validation rejects a checkout registered to another branch', async t => {
  const dir = repo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const added = await gitWorktreeAdd(dir, 'bound-a', 'main');
  git(dir, ['branch', 'multicc/bound-b', 'main']);
  const result = await gitWorktreeValidate(dir, added.worktreePath, 'multicc/bound-b');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'WORKTREE_BRANCH_MISMATCH');
  assert.equal(result.branchExists, true,
    'a checkout mismatch must not be misreported as an absent session branch');
});

test('启动缺失任务分支后，经生产唤醒组合恢复原会话工作区', async t => {
  const dir = repo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const id = 'startup-missing-bound';
  const original = await gitWorktreeAdd(dir, id, 'main');
  git(dir, ['worktree', 'remove', original.worktreePath]);
  git(dir, ['branch', '-d', original.branch]);
  const record = {
    id, dirId: 'dir', kind: 'chat', taskBoundTaskId: 'task-original',
    cliSessionId: 'native-original', workspaceState: 'awake',
    worktreePath: original.worktreePath, branch: original.branch,
  };
  const records = recordsOf([[id, record]]);
  const directories = new Map([['dir', { id: 'dir', path: dir, baseBranch: 'main' }]]);
  const invalidSessions = new Map();
  const chat = { cwd: original.worktreePath };
  const result = await initializeSessionWorktrees({
    records, directories, invalidSessions,
    realPathOf: value => fs.realpathSync(value), isHomeOrAbove: () => false,
    ensureDirGitReady: async () => ({ ok: true }), addWorktree: gitWorktreeAdd,
    tmuxHasSession: async () => false, tmuxKillSession: async () => {},
    saveDirectories: () => {}, saveSessions: () => {}, log: { log() {} },
  });
  assert.deepEqual(result, { built: 0, invalid: 0 });
  assert.equal(record.workspaceState, 'hibernated');
  assert.equal(fs.existsSync(original.worktreePath), false);
  assert.equal(git(dir, ['branch', '--list', original.branch]), '');

  const runtime = createSessionHibernation({
    records, directories, invalidSessions,
    persistence: { mutate: (_source, update) => update(records) },
    gitWorktreeAdd, gitWorktreeDetach, gitWorktreeValidate,
    chatSessions: new Map([[id, chat]]),
    workspaceBroadcast: () => {}, metrics: { inc() {} }, logger: { info() {}, warn() {} },
  });
  t.after(() => runtime.stop());
  const awake = await runtime.ensureAwake(id);
  assert.deepEqual(awake, { ok: true, thawed: true });
  assert.equal((await gitWorktreeValidate(dir, original.worktreePath, original.branch)).ok, true);
  assert.equal(git(original.worktreePath, ['rev-parse', 'HEAD']), git(dir, ['rev-parse', 'main']));
  assert.equal(record.id, id);
  assert.equal(record.taskBoundTaskId, 'task-original');
  assert.equal(record.cliSessionId, 'native-original');
  assert.equal(record.worktreePath, original.worktreePath);
  assert.equal(record.branch, original.branch);
  assert.equal(record.workspaceState, 'awake');
  assert.equal(record.workspaceStateErrorCode, null);
  assert.equal(chat.cwd, original.worktreePath);
  assert.equal(invalidSessions.has(id), false);
});

test('生产任务清理删除已合并分支后，重启及唤醒保留会话与历史', async t => {
  const { gitWorktreeRemove, gitMergeBack, gitWorktreeMergeState } = require('../src/git/service');
  const { defaultRepoActor } = require('../src/repo-actor');
  const { createTaskLifecycleHost } = require('../src/task-board/lifecycle-host');
  const { createSessionPersistence } = require('../src/session/persistence');
  const { mkRuntime } = require('./helpers/task-board-runtime');
  const dirPath = repo();
  t.after(() => fs.rmSync(dirPath, { recursive: true, force: true }));
  const id = 'cleanup-bound', taskId = 'tsk-cleanup';
  const added = await gitWorktreeAdd(dirPath, id, 'main');
  fs.writeFileSync(path.join(added.worktreePath, 'tracked.txt'), 'delivered\n');
  const history = [{ id: 'message-original', role: 'user', content: '保留历史' }];
  const record = { id, dirId: 'dir-1', kind: 'chat', taskBoundTaskId: taskId,
    cliSessionId: 'native-original', workspaceState: 'awake', worktreePath: added.worktreePath, branch: added.branch };
  const records = recordsOf([[id, record]]);
  const directories = new Map([['dir-1', { id: 'dir-1', path: dirPath, baseBranch: 'main' }]]);
  let persisted;
  const persistence = createSessionPersistence({ records, store: { save: value => { persisted = structuredClone(value); } } });
  const invalidSessions = new Map();
  const chatSessions = new Map([[id, { cwd: added.worktreePath }]]);
  const runtime = createSessionHibernation({ records, directories, persistence, invalidSessions,
    gitWorktreeAdd, gitWorktreeRemove, gitWorktreeValidate, gitWorktreeDetach, gitWorktreeMergeState,
    defaultRepoActor, chatSessions,
    chatStream: { status: () => ({}), closeAndWait: async () => ({ closed: true }) },
    backgroundTaskRuntime: { hasProcessBackgroundTasks: () => false }, waitInjector: { hasWait: () => false },
    sessionWorkHost: { isRunActive: () => false }, getWorkspaceAdmission: () => null,
    workspaceBroadcast() {}, metrics: { inc() {} }, logger: { info() {}, warn() {} }, loadHistory: () => history });
  let board;
  const hooks = createTaskLifecycleHost({ records, getBoard: () => board.runtime.getBoard(),
    getShell: () => ({ stateTarget: () => ({}) }), getState: () => ({}), getRunState: () => 'idle',
    isSessionBusy: sid => !!defaultRepoActor.isLeased(sid), getHibernation: () => runtime });
  board = mkRuntime({ records, directories, ...hooks, gitWorktreeAdd, gitWorktreeRemove, gitMergeBack });
  t.after(async () => { await runtime.stop(); persistence.stop(); fs.rmSync(path.dirname(board.file), { recursive: true, force: true }); });
  board.runtime.getBoard().tasks[taskId] = { id: taskId, dirId: 'dir-1', chatSessionId: id,
    worktreePath: added.worktreePath, branch: added.branch };
  let cleanup;
  await defaultRepoActor.run(dirPath, 'publication-fixture', async () => {
    assert.ok(defaultRepoActor.isLeased(id));
    cleanup = require('../src/task-worktree').cleanupAfterPublication({
      repoActor: defaultRepoActor, dirPath, taskId, cleanup: board.runtime.taskWorktree.cleanupWorktree });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(records.get(id).workspaceState, 'awake');
    assert.equal(fs.existsSync(added.worktreePath), true);
  }, { sessionId: id });
  const result = await cleanup;
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(added.worktreePath), false);
  assert.equal(git(dirPath, ['branch', '--list', added.branch]), '');
  assert.equal(persisted[0].workspaceState, 'hibernated');
  assert.equal(board.runtime.getBoard().tasks[taskId].worktreePath, null);
  assert.equal(git(dirPath, ['show', 'main:tracked.txt']), 'delivered');
  records.set(id, structuredClone(persisted[0]));
  const startup = await initializeSessionWorktrees({ records, directories, invalidSessions,
    realPathOf: value => fs.realpathSync(value), isHomeOrAbove: () => false,
    ensureDirGitReady: async () => ({ ok: true }), addWorktree: gitWorktreeAdd,
    tmuxHasSession: async () => false, tmuxKillSession: async () => {},
    saveDirectories() {}, saveSessions() {}, log: { log() {} } });
  assert.equal(startup.invalid, 0);
  assert.equal((await runtime.ensureAwake(id)).ok, true);
  assert.equal(records.get(id).id, id);
  assert.equal(records.get(id).cliSessionId, 'native-original');
  assert.equal(records.get(id).taskBoundTaskId, taskId);
  assert.deepEqual(history, [{ id: 'message-original', role: 'user', content: '保留历史' }]);
  assert.equal(fs.readFileSync(path.join(added.worktreePath, 'tracked.txt'), 'utf8'), 'delivered\n');
  assert.equal((await gitWorktreeValidate(dirPath, added.worktreePath, added.branch)).ok, true);
});
