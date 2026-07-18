'use strict';

const assert = require('assert');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const test = require('node:test');
const { execFile } = require('child_process');
const { promisify } = require('util');
const {
  gitWorktreeAdd,
  gitWorktreeRemove,
  gitRelocateWorktree,
  gitMergeBack,
  gitSyncFromBase,
} = require('../src/git');

const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return String(stdout || '').trim();
}

async function initRepo(root, name) {
  const dir = path.join(root, name);
  await fsp.mkdir(dir, { recursive: true });
  await git(dir, ['init', '-b', 'main']);
  await git(dir, ['config', 'user.email', 'test@multicc.local']);
  await git(dir, ['config', 'user.name', 'MultiCC Test']);
  await fsp.writeFile(path.join(dir, 'app.js'), 'module.exports = 1;\n');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-m', 'initial']);
  return { id: name, path: dir, baseBranch: 'main' };
}

async function sessionIn(dir, id) {
  const added = await gitWorktreeAdd(dir.path, id, dir.baseBranch);
  return { id, dirId: dir.id, worktreePath: added.worktreePath, branch: added.branch };
}

test('dirty worktree removal is refused by default and forced removal is recoverable', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'multicc-git-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const dir = await initRepo(root, 'repo');
  const session = await sessionIn(dir, 'dirty');
  await fsp.writeFile(path.join(session.worktreePath, 'app.js'), 'module.exports = 2;\n');
  await fsp.mkdir(path.join(session.worktreePath, 'notes'), { recursive: true });
  await fsp.writeFile(path.join(session.worktreePath, 'notes', 'new.txt'), 'recover me\n');

  const refused = await gitWorktreeRemove(dir.path, session.worktreePath, session.branch, {
    sessionId: session.id, baseBranch: dir.baseBranch,
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.blocked, true);
  assert(refused.reasons.includes('dirty'));
  assert.equal(fs.existsSync(session.worktreePath), true);
  assert.equal(await git(dir.path, ['show-ref', '--verify', '--quiet', `refs/heads/${session.branch}`]).then(() => true, () => false), true);

  const forced = await gitWorktreeRemove(dir.path, session.worktreePath, session.branch, {
    sessionId: session.id, baseBranch: dir.baseBranch, force: true,
  });
  assert.equal(forced.ok, true);
  assert(forced.operationId);
  assert(forced.backup.ref.startsWith('refs/multicc/backups/dirty/'));
  assert.equal(fs.existsSync(forced.backup.bundle), true);
  assert.equal(await git(dir.path, ['bundle', 'verify', forced.backup.bundle]).then(() => true, () => false), true);
  assert.equal(fs.existsSync(forced.backup.patch), true);
  assert.equal(await fsp.readFile(path.join(forced.backup.backupDir, 'untracked', 'notes', 'new.txt'), 'utf8'), 'recover me\n');
  assert.equal(await git(dir.path, ['rev-parse', '--verify', forced.backup.ref]).then(() => true, () => false), true);
  assert.equal(fs.existsSync(session.worktreePath), false);
});

test('active check and unmerged commits block destructive removal', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'multicc-git-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const dir = await initRepo(root, 'repo');
  const active = await sessionIn(dir, 'active');
  const activeError = await gitWorktreeRemove(dir.path, active.worktreePath, active.branch, {
    sessionId: active.id,
    activeCheck: async () => true,
  }).then(() => null, error => error);
  assert(activeError);
  assert.equal(activeError.code, 'SESSION_ACTIVE');
  assert.equal(fs.existsSync(active.worktreePath), true);

  await fsp.writeFile(path.join(active.worktreePath, 'feature.txt'), 'feature\n');
  await git(active.worktreePath, ['add', '-A']);
  await git(active.worktreePath, ['commit', '-m', 'feature']);
  const refused = await gitWorktreeRemove(dir.path, active.worktreePath, active.branch, {
    sessionId: active.id, baseBranch: dir.baseBranch,
  });
  assert.equal(refused.ok, false);
  assert(refused.reasons.includes('unmerged'));
  assert.equal(fs.existsSync(active.worktreePath), true);
});

test('relocate creates target first, rolls it back on failure, and preserves source', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'multicc-git-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const oldDir = await initRepo(root, 'old');
  const targetDir = await initRepo(root, 'target');
  const session = await sessionIn(oldDir, 'move-me');
  const targetPath = path.join(targetDir.path, '.multicc-worktrees', session.id);
  let targetWasPresent = false;

  const injected = await gitRelocateWorktree(oldDir, targetDir, session, {
    beforeRemove: async created => {
      targetWasPresent = fs.existsSync(created.worktreePath);
      throw new Error('injected after create');
    },
  });
  assert.equal(targetWasPresent, true);
  assert.equal(injected.ok, false);
  assert.equal(injected.rolledBack, true);
  assert.equal(fs.existsSync(session.worktreePath), true);
  assert.equal(fs.existsSync(targetPath), false);

  const moved = await gitRelocateWorktree(oldDir, targetDir, session);
  assert.equal(moved.ok, true);
  assert.equal(fs.existsSync(session.worktreePath), false);
  assert.equal(fs.existsSync(moved.worktreePath), true);
});

test('relocate refuses active or dirty source before creating the target', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'multicc-git-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const oldDir = await initRepo(root, 'old');
  const targetDir = await initRepo(root, 'target');
  const session = await sessionIn(oldDir, 'blocked');
  const targetPath = path.join(targetDir.path, '.multicc-worktrees', session.id);
  const active = await gitRelocateWorktree(oldDir, targetDir, session, { active: true });
  assert.equal(active.blocked, true);
  assert(active.reasons.includes('active'));
  assert.equal(fs.existsSync(targetPath), false);
  const racedActive = await gitRelocateWorktree(oldDir, targetDir, session, {
    activeCheck: async () => true,
  });
  assert.equal(racedActive.blocked, true);
  assert(racedActive.reasons.includes('active'));
  assert.equal(fs.existsSync(targetPath), false);
  await fsp.writeFile(path.join(session.worktreePath, 'app.js'), 'dirty\n');
  const dirty = await gitRelocateWorktree(oldDir, targetDir, session);
  assert.equal(dirty.blocked, true);
  assert(dirty.reasons.includes('dirty'));
  assert.equal(fs.existsSync(targetPath), false);
});

test('merge validates in integration worktree and leaves main unchanged on failure', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'multicc-git-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const dir = await initRepo(root, 'repo');
  const session = await sessionIn(dir, 'bad-merge');
  const before = await git(dir.path, ['rev-parse', 'HEAD']);
  await fsp.writeFile(path.join(session.worktreePath, 'bad.js'), 'function broken( {\n');
  const result = await gitMergeBack(dir, session);
  assert.equal(result.ok, false);
  assert.equal(result.syntaxErrors.length, 1);
  assert.equal(await git(dir.path, ['rev-parse', 'HEAD']), before);
  assert.equal((await git(dir.path, ['status', '--porcelain'])), '');
  assert.equal(fs.existsSync(session.worktreePath), true);
  assert.equal((await git(dir.path, ['for-each-ref', '--format=%(refname)', 'refs/multicc/integration/'])), '');
});

test('sync refuses dirty worktree unless explicitly forced and produces backup', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'multicc-git-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const dir = await initRepo(root, 'repo');
  const session = await sessionIn(dir, 'sync');
  await fsp.writeFile(path.join(session.worktreePath, 'app.js'), 'module.exports = 3;\n');
  const refused = await gitSyncFromBase(dir, session);
  assert.equal(refused.blocked, true);
  assert(refused.reasons.includes('dirty'));
  const forced = await gitSyncFromBase(dir, session, { force: true });
  assert.equal(forced.ok, true);
  assert(forced.backup && fs.existsSync(forced.backup.bundle));
});

test('sync/rebase refuses clean unmerged commits unless forced and backs them up', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'multicc-git-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const dir = await initRepo(root, 'repo');
  const session = await sessionIn(dir, 'ahead-sync');
  await fsp.writeFile(path.join(session.worktreePath, 'feature.txt'), 'session feature\n');
  await git(session.worktreePath, ['add', '-A']);
  await git(session.worktreePath, ['commit', '-m', 'session feature']);
  await fsp.writeFile(path.join(dir.path, 'main.txt'), 'main update\n');
  await git(dir.path, ['add', '-A']);
  await git(dir.path, ['commit', '-m', 'main update']);

  const refused = await gitSyncFromBase(dir, session);
  assert.equal(refused.blocked, true);
  assert(refused.reasons.includes('unmerged'));
  const branchBefore = await git(dir.path, ['rev-parse', session.branch]);

  const forced = await gitSyncFromBase(dir, session, { force: true });
  assert.equal(forced.ok, true);
  assert.equal(forced.merged, true);
  assert(forced.backup && fs.existsSync(forced.backup.bundle));
  assert.equal(await git(dir.path, ['rev-parse', forced.backup.ref]), branchBefore);
});
