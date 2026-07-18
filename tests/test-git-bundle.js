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
  gitWorktreeSnapshot,
  gitExportSessionBundle,
  gitImportSessionBundle,
} = require('../src/git');

const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return String(stdout || '').trim();
}

async function initRepo(root, name) {
  const repoPath = path.join(root, name);
  await fsp.mkdir(repoPath, { recursive: true });
  await git(repoPath, ['init', '-b', 'main']);
  await git(repoPath, ['config', 'user.email', 'test@multicc.local']);
  await git(repoPath, ['config', 'user.name', 'MultiCC Test']);
  await fsp.writeFile(path.join(repoPath, 'shared.txt'), 'base\n');
  await git(repoPath, ['add', '-A']);
  await git(repoPath, ['commit', '-m', 'initial']);
  return { id: name, path: repoPath, baseBranch: 'main' };
}

async function sessionIn(dir, id) {
  const added = await gitWorktreeAdd(dir.path, id, dir.baseBranch);
  return { id, worktreePath: added.worktreePath, branch: added.branch };
}

async function commitFile(worktreePath, relative, content, message) {
  const target = path.join(worktreePath, relative);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, content);
  await git(worktreePath, ['add', '-A']);
  await git(worktreePath, ['commit', '-m', message]);
}

test('worktree snapshot and export describe only session-unique commits', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'multicc-bundle-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const dir = await initRepo(root, 'repo');
  const session = await sessionIn(dir, 'source');
  await commitFile(session.worktreePath, 'feature.txt', 'one\n', 'feature one');
  await commitFile(session.worktreePath, 'nested/two.txt', 'two\n', 'feature two');

  const snapshot = await gitWorktreeSnapshot(session.worktreePath, session.branch);
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.branch, session.branch);
  assert.equal(snapshot.head, await git(session.worktreePath, ['rev-parse', 'HEAD']));
  assert.deepEqual(snapshot.changes, []);

  const bundlePath = path.join(root, 'source.bundle');
  const exported = await gitExportSessionBundle(dir, session, bundlePath, 10 * 1024 * 1024);
  assert.equal(exported.ok, true);
  assert.equal(exported.unique, 2);
  assert.equal(exported.bundlePath, bundlePath);
  assert(exported.size > 0);
  assert.equal(fs.existsSync(bundlePath), true);
  await git(dir.path, ['bundle', 'verify', bundlePath]);
  const heads = await git(dir.path, ['bundle', 'list-heads', bundlePath]);
  assert(heads.includes(`refs/heads/${session.branch}`));
});

test('export cleans stale/oversize output and reports sessions without unique commits', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'multicc-bundle-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const dir = await initRepo(root, 'repo');
  const empty = await sessionIn(dir, 'empty');
  const bundlePath = path.join(root, 'session.bundle');
  await fsp.writeFile(bundlePath, 'stale');

  const none = await gitExportSessionBundle(dir, empty, bundlePath, 1000);
  assert.equal(none.ok, true);
  assert.equal(none.unique, 0);
  assert.equal(none.bundlePath, null);
  assert.equal(fs.existsSync(bundlePath), false);

  await commitFile(empty.worktreePath, 'large.txt', 'x'.repeat(4096), 'large session commit');
  const oversized = await gitExportSessionBundle(dir, empty, bundlePath, 1);
  assert.equal(oversized.ok, false);
  assert.equal(oversized.tooLarge, true);
  assert(oversized.size > oversized.maxBytes);
  assert.equal(fs.existsSync(bundlePath), false);
});

test('bundle import preserves a newer target base and applies session commits in order', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'multicc-bundle-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const dir = await initRepo(root, 'repo');
  const source = await sessionIn(dir, 'source');
  await commitFile(source.worktreePath, 'feature.txt', 'feature\n', 'session feature');
  await commitFile(source.worktreePath, 'second.txt', 'second\n', 'session second');
  const bundlePath = path.join(root, 'source.bundle');
  const exported = await gitExportSessionBundle(dir, source, bundlePath, 10 * 1024 * 1024);
  assert.equal(exported.ok, true);

  await commitFile(dir.path, 'main-new.txt', 'newer base\n', 'newer main');
  const target = await sessionIn(dir, 'target');
  const before = await git(target.worktreePath, ['rev-parse', 'HEAD']);
  const imported = await gitImportSessionBundle(dir, target, bundlePath, source.branch);

  assert.equal(imported.ok, true);
  assert.equal(imported.restored, true);
  assert.equal(imported.commits, 2);
  assert.notEqual(imported.head, before);
  assert.equal(await fsp.readFile(path.join(target.worktreePath, 'main-new.txt'), 'utf8'), 'newer base\n');
  assert.equal(await fsp.readFile(path.join(target.worktreePath, 'feature.txt'), 'utf8'), 'feature\n');
  assert.equal(await fsp.readFile(path.join(target.worktreePath, 'second.txt'), 'utf8'), 'second\n');
  assert.equal(await git(target.worktreePath, ['status', '--porcelain']), '');
  assert.equal(await git(dir.path, ['for-each-ref', '--format=%(refname)', 'refs/multicc/import/']), '');
});

test('bundle import preserves source merge topology without resetting the target', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'multicc-bundle-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const dir = await initRepo(root, 'repo');
  const source = await sessionIn(dir, 'source');
  await commitFile(source.worktreePath, 'source-root.txt', 'root\n', 'source root');
  await git(source.worktreePath, ['switch', '-c', 'bundle-side']);
  await commitFile(source.worktreePath, 'side.txt', 'side\n', 'side commit');
  await git(source.worktreePath, ['switch', source.branch]);
  await commitFile(source.worktreePath, 'mainline.txt', 'mainline\n', 'mainline commit');
  await git(source.worktreePath, ['merge', '--no-ff', 'bundle-side', '-m', 'source merge']);

  const bundlePath = path.join(root, 'source-merge.bundle');
  assert.equal((await gitExportSessionBundle(dir, source, bundlePath, 10 * 1024 * 1024)).ok, true);
  await commitFile(dir.path, 'target-base.txt', 'new target base\n', 'target base');
  const target = await sessionIn(dir, 'target');
  const originalHead = await git(target.worktreePath, ['rev-parse', 'HEAD']);

  const imported = await gitImportSessionBundle(dir, target, bundlePath, source.branch);
  assert.equal(imported.ok, true);
  assert.equal(imported.restored, true);
  assert.equal(imported.strategy, 'merge');
  assert.notEqual(imported.head, originalHead);
  for (const file of ['source-root.txt', 'side.txt', 'mainline.txt', 'target-base.txt']) {
    assert.equal(fs.existsSync(path.join(target.worktreePath, file)), true, file);
  }
  assert.equal(await git(target.worktreePath, ['status', '--porcelain']), '');
  assert.equal(await git(dir.path, ['for-each-ref', '--format=%(refname)', 'refs/multicc/import/']), '');
});

test('conflicting bundle import aborts to the original clean target without reset --hard', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'multicc-bundle-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const dir = await initRepo(root, 'repo');
  const source = await sessionIn(dir, 'source');
  await commitFile(source.worktreePath, 'shared.txt', 'source change\n', 'source conflict');
  const bundlePath = path.join(root, 'source.bundle');
  assert.equal((await gitExportSessionBundle(dir, source, bundlePath, 10 * 1024 * 1024)).ok, true);

  await commitFile(dir.path, 'shared.txt', 'target change\n', 'target conflict');
  const target = await sessionIn(dir, 'target');
  const originalHead = await git(target.worktreePath, ['rev-parse', 'HEAD']);
  const imported = await gitImportSessionBundle(dir, target, bundlePath, source.branch);

  assert.equal(imported.ok, false);
  assert.equal(imported.aborted, true);
  assert.equal(imported.abortError, null);
  assert.equal(imported.originalHead, originalHead);
  assert.equal(imported.head, originalHead);
  assert.equal(imported.clean, true);
  assert.equal(await git(target.worktreePath, ['status', '--porcelain']), '');
  assert.equal(await fsp.readFile(path.join(target.worktreePath, 'shared.txt'), 'utf8'), 'target change\n');
  assert.equal(await git(dir.path, ['for-each-ref', '--format=%(refname)', 'refs/multicc/import/']), '');

  const sourceText = await fsp.readFile(path.join(__dirname, '..', 'src', 'git.js'), 'utf8');
  assert.equal(/['"]reset['"][\s\S]{0,40}['"]--hard['"]/.test(sourceText), false);
});
