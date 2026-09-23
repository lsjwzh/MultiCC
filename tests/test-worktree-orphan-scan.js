'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createWorktreeOrphanScanner, parseWorktreeList } = require('../src/workspace/orphan-scan');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-orphan-scan-'));
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.invalid']);
  git(dir, ['config', 'user.name', 'MultiCC Test']);
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'base\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'base']);
  return dir;
}

const repoActor = {
  run: async (dirPath, _op, fn) => fn({
    execGit: async (cwd, args) => git(cwd, args),
  }),
};

function addWorktree(dir, name) {
  const target = path.join(dir, '.multicc-worktrees', name);
  git(dir, ['worktree', 'add', '-b', `multicc/${name}`, target, 'main']);
  return target;
}

test('parseWorktreeList reads paths, branches and detached state', () => {
  const entries = parseWorktreeList('worktree /repo\nbranch refs/heads/main\n\nworktree /repo/.multicc-worktrees/a\ndetached\n');
  assert.deepEqual(entries, [
    { path: '/repo', branch: 'main', detached: false },
    { path: '/repo/.multicc-worktrees/a', branch: null, detached: true },
  ]);
});

test('scan reports worktrees no session or task claims, never touches claimed ones', async t => {
  const dir = repo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const claimed = addWorktree(dir, 'claimed');
  const orphan = addWorktree(dir, 'orphan');
  const records = new Map([['s1', { id: 's1', worktreePath: claimed }]]);
  const directories = new Map([['d1', { id: 'd1', path: dir, baseBranch: 'main' }]]);
  const scanner = createWorktreeOrphanScanner({ records, directories, repoActor, logger: { warn() {} } });
  const report = await scanner.scan();
  assert.equal(report.total, 1);
  assert.equal(report.orphans[0].path, fs.realpathSync(orphan));
  assert.equal(report.orphans[0].removed, false, 'report-only by default');
  assert.ok(fs.existsSync(orphan));
  assert.equal(scanner.report().at, report.at);
});

test('delete pass removes only clean, fully-merged orphans', async t => {
  const dir = repo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const merged = addWorktree(dir, 'merged');
  const ahead = addWorktree(dir, 'ahead');
  git(ahead, ['config', 'user.email', 'test@example.invalid']);
  fs.writeFileSync(path.join(ahead, 'work.txt'), 'unmerged\n');
  git(ahead, ['add', '.']);
  git(ahead, ['commit', '-m', 'unmerged work']);
  const directories = new Map([['d1', { id: 'd1', path: dir, baseBranch: 'main' }]]);
  const scanner = createWorktreeOrphanScanner({
    records: new Map(), directories, repoActor, logger: { warn() {} }, deleteOrphans: true,
  });
  const report = await scanner.scan();
  assert.equal(report.total, 2);
  assert.equal(report.removed, 1);
  assert.equal(fs.existsSync(merged), false, 'clean merged orphan removed');
  assert.equal(fs.existsSync(ahead), true, 'orphan with unmerged commits is never removed');
  const kept = report.orphans.find(o => o.path === fs.realpathSync(ahead));
  assert.equal(kept.ahead, 1);
});

test('task ledger paths are claimed', async t => {
  const dir = repo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const taskPath = addWorktree(dir, 'task-abc12345');
  const directories = new Map([['d1', { id: 'd1', path: dir, baseBranch: 'main' }]]);
  const scanner = createWorktreeOrphanScanner({
    records: new Map(), directories, repoActor, logger: { warn() {} },
    listTaskWorktreePaths: () => [taskPath],
  });
  const report = await scanner.scan();
  assert.equal(report.total, 0);
});
