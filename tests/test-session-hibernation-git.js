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
} = require('../src/git');

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

test('detach fails closed on unknown ignored files and leaves checkout untouched', async t => {
  const dir = repo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const added = await gitWorktreeAdd(dir, 'bound-secret', 'main');
  fs.writeFileSync(path.join(added.worktreePath, '.env'), 'SECRET=must-stay\n');
  await assert.rejects(
    gitWorktreeDetach(dir, added.worktreePath, added.branch, { sessionId: 'bound-secret' }),
    error => error.code === 'HIBERNATE_UNKNOWN_IGNORED',
  );
  assert.equal(fs.existsSync(added.worktreePath), true);
  assert.equal(fs.readFileSync(path.join(added.worktreePath, '.env'), 'utf8'), 'SECRET=must-stay\n');
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
  const result = await gitWorktreeValidate(dir, added.worktreePath, 'multicc/bound-b');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'WORKTREE_BRANCH_MISMATCH');
});
