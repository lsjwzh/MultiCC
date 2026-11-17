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
  gitRebaseResolve,
  gitWorktreeDetach,
  gitWorktreeMergeState,
  gitWorktreeCommitAll,
  gitRun,
} = require('../src/git/service');

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

async function configureIdentity(dir, identity) {
  await git(dir.path, ['config', '--local', 'user.name', identity.name]);
  await git(dir.path, ['config', '--local', 'user.email', identity.email]);
}

test('without a local policy, another repository uses its own Git identity', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'multicc-own-identity-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const dir = await initRepo(root, 'repo');
  await fsp.writeFile(path.join(dir.path, 'app.js'), 'module.exports = 2;\n');
  // A cloned legacy file must not impose another person's identity.
  await fsp.writeFile(path.join(dir.path, 'commit-policy.json'), JSON.stringify({ name: 'Previous Owner', email: 'previous@example.invalid' }));
  await gitWorktreeCommitAll(dir.path, 'fix: preserve the owner identity');
  assert.equal(await git(dir.path, ['log', '-1', '--format=%an|%ae|%cn|%ce']),
    'MultiCC Test|test@multicc.local|MultiCC Test|test@multicc.local');
});

test('Git accepts a configured email without an additional MultiCC format check', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'multicc-git-configured-email-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const dir = await initRepo(root, 'repo');
  await git(dir.path, ['config', 'user.email', 'local-account']);
  await gitRun(dir.path, ['commit', '--allow-empty', '-m', 'fix: use the configured Git email']);
  assert.equal(await git(dir.path, ['log', '-1', '--format=%ae|%ce']), 'local-account|local-account');
});

test('commit-all preserves a user-provided non-English message', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'multicc-git-english-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const dir = await initRepo(root, 'repo');
  await fsp.writeFile(path.join(dir.path, 'app.js'), 'module.exports = 2;\n');
  assert.equal(await gitWorktreeCommitAll(dir.path, '修复消息\n\n中文正文'), true);
  assert.equal(await git(dir.path, ['log', '-1', '--format=%B']), '修复消息\n\n中文正文');
});

test('merge-back accepts agent-authored messages in any language', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'multicc-merge-english-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const dir = await initRepo(root, 'repo');
  const session = await sessionIn(dir, 'english-guard');
  await fsp.writeFile(path.join(session.worktreePath, 'app.js'), 'module.exports = 2;\n');
  await git(session.worktreePath, ['add', '-A']);
  await git(session.worktreePath, ['commit', '-m', '修复消息\n\n中文正文']);
  const sourceHead = await git(session.worktreePath, ['rev-parse', 'HEAD']);
  assert.equal((await gitMergeBack(dir, session)).ok, true);
  assert.equal(await git(dir.path, ['show', '-s', '--format=%B', sourceHead]), '修复消息\n\n中文正文');
});

test('merge-back preserves an existing empty-message commit', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'multicc-empty-message-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const dir = await initRepo(root, 'repo');
  const session = await sessionIn(dir, 'empty-message');
  await git(session.worktreePath, ['commit', '--allow-empty', '--allow-empty-message', '-m', '']);
  assert.equal((await gitMergeBack(dir, session)).ok, true);
});

test('a user-provided commit message works without the default message generator', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'multicc-no-message-generator-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const dir = await initRepo(root, 'repo');
  await fsp.writeFile(path.join(dir.path, 'app.js'), 'module.exports = 2;\n');
  const script = `require('./src/git/service').gitWorktreeCommitAll(process.argv[1], '本地提交')
    .then(ok => process.exit(ok ? 0 : 2), () => process.exit(3));`;
  const result = await execFileAsync(process.execPath, ['-e', script, dir.path], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, MULTICC_RUST_ADDON: path.join(os.tmpdir(), 'missing-publication-addon.node') },
  });
  assert.equal(result.stderr, '');
});

test('Git identity follows explicit environment and command options', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'multicc-commit-identity-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const dir = await initRepo(root, 'repo');
  const expected = { name: 'account', email: 'account@example.invalid' };
  await configureIdentity(dir, expected);
  await fsp.writeFile(path.join(dir.path, 'app.js'), 'module.exports = 2;\n');
  await gitRun(dir.path, ['add', '-A']);
  await gitRun(dir.path, ['-c', 'user.name=bot', '-c', 'user.email=bot@local', 'commit', '-m', 'fix: preserve queued messages'], {
    env: { GIT_AUTHOR_NAME: 'leaked', GIT_AUTHOR_EMAIL: 'leaked@local', GIT_COMMITTER_NAME: 'leaked', GIT_COMMITTER_EMAIL: 'leaked@local' },
  });
  assert.equal(await git(dir.path, ['log', '-1', '--format=%an|%ae|%cn|%ce']),
    'leaked|leaked@local|leaked|leaked@local');
  await gitRun(dir.path, ['-c', 'user.name=bot', '-c', 'user.email=bot@local', 'commit', '--allow-empty', '-m', 'fix: preserve Git arguments']);
  assert.equal(await git(dir.path, ['log', '-1', '--format=%an|%ae|%cn|%ce']), 'bot|bot@local|bot|bot@local');
  const session = await sessionIn(dir, 'identity-merge');
  await fsp.writeFile(path.join(session.worktreePath, 'app.js'), 'module.exports = 3;\n');
  const result = await gitMergeBack(dir, session);
  assert.equal(result.ok, true);
  const identity = await git(dir.path, ['log', '-1', '--format=%an|%ae|%cn|%ce']);
  assert.equal(identity, 'account|account@example.invalid|account|account@example.invalid');
});

test('merge preserves different author and committer identities', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'multicc-reject-identity-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const dir = await initRepo(root, 'repo');
  const policy = { name: 'account', email: 'account@example.invalid' };
  await configureIdentity(dir, policy);
  await gitWorktreeCommitAll(dir.path, 'chore: configure project commit identity');
  const session = await sessionIn(dir, 'wrong-committer');
  await execFileAsync('git', ['commit', '--allow-empty', '-m', 'fix: preserve queued messages'], {
    cwd: session.worktreePath,
    env: { ...process.env, GIT_AUTHOR_NAME: 'account', GIT_AUTHOR_EMAIL: 'account@example.invalid', GIT_COMMITTER_NAME: 'bot', GIT_COMMITTER_EMAIL: 'bot@local' },
  });
  const sourceHead = await git(session.worktreePath, ['rev-parse', 'HEAD']);
  assert.equal((await gitMergeBack(dir, session)).ok, true);
  assert.equal(await git(dir.path, ['show', '-s', '--format=%ae|%ce', sourceHead]), 'account@example.invalid|bot@local');
});

test('merge preserves fetched and local commit identities', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'multicc-remote-identity-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const dir = await initRepo(root, 'repo');
  await configureIdentity(dir, { name: 'account', email: 'account@example.invalid' });
  await gitWorktreeCommitAll(dir.path, 'chore: configure project commit identity');
  const session = await sessionIn(dir, 'remote-identity');
  await execFileAsync('git', ['commit', '--allow-empty', '-m', 'fix: accept a contributor change'], {
    cwd: session.worktreePath,
    env: { ...process.env, GIT_AUTHOR_NAME: 'contributor', GIT_AUTHOR_EMAIL: 'contributor@example.invalid', GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'noreply@github.com' },
  });
  const remoteCommit = await git(session.worktreePath, ['rev-parse', 'HEAD']);
  await git(dir.path, ['update-ref', 'refs/remotes/origin/main', remoteCommit]);
  await execFileAsync('git', ['commit', '--allow-empty', '-m', 'fix: preserve local identity'], {
    cwd: session.worktreePath,
    env: { ...process.env, GIT_AUTHOR_NAME: 'account alias', GIT_AUTHOR_EMAIL: 'account@example.invalid', GIT_COMMITTER_NAME: 'account alias', GIT_COMMITTER_EMAIL: 'account@example.invalid' },
  });
  const result = await gitMergeBack(dir, session);
  assert.equal(result.ok, true);
  assert.equal(await git(dir.path, ['show', '-s', '--format=%an|%ae|%cn|%ce', remoteCommit]),
    'contributor|contributor@example.invalid|GitHub|noreply@github.com');
});

test('merge does not reject local commits because of their identity', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'multicc-untrusted-identity-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const dir = await initRepo(root, 'repo');
  await configureIdentity(dir, { name: 'account', email: 'account@example.invalid' });
  await gitWorktreeCommitAll(dir.path, 'chore: configure project commit identity');
  const session = await sessionIn(dir, 'untrusted-identity');
  await execFileAsync('git', ['commit', '--allow-empty', '-m', 'fix: retain local identity'], {
    cwd: session.worktreePath,
    env: { ...process.env, GIT_AUTHOR_NAME: 'bot', GIT_AUTHOR_EMAIL: 'bot@example.invalid', GIT_COMMITTER_NAME: 'bot', GIT_COMMITTER_EMAIL: 'bot@example.invalid' },
  });
  await git(dir.path, ['update-ref', 'refs/remotes/origin/feature', await git(session.worktreePath, ['rev-parse', 'HEAD'])]);
  assert.equal((await gitMergeBack(dir, session)).ok, true);
});

test('a fetched default-branch commit may use a non-English message', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'multicc-remote-message-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const dir = await initRepo(root, 'repo');
  await configureIdentity(dir, { name: 'account', email: 'account@example.invalid' });
  await gitWorktreeCommitAll(dir.path, 'chore: configure project commit identity');
  const session = await sessionIn(dir, 'remote-message');
  await execFileAsync('git', ['commit', '--allow-empty', '-m', '修复问题'], {
    cwd: session.worktreePath,
    env: { ...process.env, GIT_AUTHOR_NAME: 'contributor', GIT_AUTHOR_EMAIL: 'contributor@example.invalid', GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'noreply@github.com' },
  });
  await git(dir.path, ['update-ref', 'refs/remotes/origin/main', await git(session.worktreePath, ['rev-parse', 'HEAD'])]);
  assert.equal((await gitMergeBack(dir, session)).ok, true);
});

test('a tracked legacy policy cannot override the local Git identity', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'multicc-target-identity-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const dir = await initRepo(root, 'repo');
  await configureIdentity(dir, { name: 'account', email: 'account@example.invalid' });
  await gitWorktreeCommitAll(dir.path, 'chore: configure project commit identity');
  const session = await sessionIn(dir, 'changed-policy');
  await fsp.writeFile(path.join(session.worktreePath, 'commit-policy.json'), JSON.stringify({ name: 'bot', email: 'bot@example.invalid' }));
  await gitWorktreeCommitAll(session.worktreePath, 'chore: change project commit identity');
  const sourceHead = await git(session.worktreePath, ['rev-parse', 'HEAD']);
  assert.equal(await git(session.worktreePath, ['show', '-s', '--format=%ae|%ce', sourceHead]), 'account@example.invalid|account@example.invalid');
  assert.equal((await gitMergeBack(dir, session)).ok, true);
});

test('write operations treat a reclaimed worktree as unavailable without spawning git', async () => {
  const missing = path.join(os.tmpdir(), `multicc-reclaimed-${process.pid}-${Date.now()}`);
  const dir = { id: 'repo', path: missing, baseBranch: 'main' };
  const session = {
    id: 'hibernated', branch: 'multicc/hibernated', worktreePath: path.join(missing, 'worktree'),
    workspaceState: 'hibernated',
  };
  const refused = { ok: false, code: 'worktree_missing', error: 'session has no worktree' };
  assert.deepEqual(await gitMergeBack(dir, session), refused);
  assert.deepEqual(await gitSyncFromBase(dir, session), refused);
  assert.deepEqual(await gitRebaseResolve(dir, session, 'continue'), refused);
  // The status payload names the reclaim and keeps branch/baseBranch, so the
  // chat page can say "hibernated" instead of drawing a checkout that is ready.
  const state = await gitWorktreeMergeState(dir, session);
  assert.deepEqual(state, {
    mergeReady: false, dirty: false, ahead: 0, behind: 0, reason: 'hibernated',
    worktreeMissing: true, baseBranch: 'main', branch: 'multicc/hibernated',
  });
});

test('a hibernated worktree reports no phantom behind and keeps its branch restorable', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'multicc-git-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const dir = await initRepo(root, 'repo');
  const session = await sessionIn(dir, 'reclaimed');
  session.workspaceState = 'hibernated';

  const detached = await gitWorktreeDetach(dir.path, session.worktreePath, session.branch, {
    sessionId: session.id,
  });
  assert.equal(detached.ok, true);
  assert.equal(fs.existsSync(session.worktreePath), false);

  // The base branch moves on while the workspace sleeps. The retained ref still
  // answers `main...<branch>`, so this used to read as an actionable
  // "behind N, sync now" for a session with no checkout to sync.
  await fsp.writeFile(path.join(dir.path, 'app.js'), 'module.exports = 3;\n');
  await git(dir.path, ['add', '-A']);
  await git(dir.path, ['commit', '-m', 'main moves on']);

  const state = await gitWorktreeMergeState(dir, session);
  assert.equal(state.worktreeMissing, true);
  assert.equal(state.reason, 'hibernated');
  assert.equal(state.behind, 0);
  assert.equal(state.ahead, 0);
  assert.equal(state.mergeReady, false);
  assert.equal(state.branch, session.branch, 'the retained branch keeps the workspace restorable');
  assert.equal(
    await git(dir.path, ['rev-parse', '--verify', `refs/heads/${session.branch}`]).then(() => true, () => false),
    true);
});

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

test('relocate carry takes uncommitted changes and untracked files along', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'multicc-git-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const oldDir = await initRepo(root, 'old');
  const targetDir = await initRepo(root, 'target');
  const session = await sessionIn(oldDir, 'carry-me');
  await fsp.writeFile(path.join(session.worktreePath, 'app.js'), 'module.exports = 2;\n');
  await fsp.mkdir(path.join(session.worktreePath, 'notes'), { recursive: true });
  await fsp.writeFile(path.join(session.worktreePath, 'notes', 'new.txt'), 'carry me\n');

  const moved = await gitRelocateWorktree(oldDir, targetDir, session, { carry: true });
  assert.equal(moved.ok, true);
  assert(moved.carried);
  assert(moved.carried.patchBytes > 0);
  assert.equal(moved.carried.files, 1);
  assert.equal(fs.existsSync(session.worktreePath), false);
  assert.equal(await fsp.readFile(path.join(moved.worktreePath, 'app.js'), 'utf8'), 'module.exports = 2;\n');
  assert.equal(await fsp.readFile(path.join(moved.worktreePath, 'notes', 'new.txt'), 'utf8'), 'carry me\n');
  // Carried state stays uncommitted in the new worktree — the user reviews and
  // commits it there, exactly where the task now lives.
  const status = await git(moved.worktreePath, ['status', '--porcelain']);
  assert(status.includes('M app.js'));
  assert(status.includes('?? notes/'));
});

test('relocate carry rolls the target back when the patch cannot apply', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'multicc-git-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const oldDir = await initRepo(root, 'old');
  const targetDir = await initRepo(root, 'target');
  // Diverge the target's app.js so the carried patch context cannot match.
  await fsp.writeFile(path.join(targetDir.path, 'app.js'), 'console.log("unrelated");\n');
  await git(targetDir.path, ['add', '-A']);
  await git(targetDir.path, ['commit', '-m', 'diverged']);
  const session = await sessionIn(oldDir, 'incompatible');
  await fsp.writeFile(path.join(session.worktreePath, 'app.js'), 'module.exports = 99;\n');
  const targetPath = path.join(targetDir.path, '.multicc-worktrees', session.id);

  const result = await gitRelocateWorktree(oldDir, targetDir, session, { carry: true });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'carry_apply_failed');
  assert.equal(result.rolledBack, true);
  // Source untouched: the dirty file and the worktree are exactly where they were.
  assert.equal(fs.existsSync(session.worktreePath), true);
  assert.equal(await fsp.readFile(path.join(session.worktreePath, 'app.js'), 'utf8'), 'module.exports = 99;\n');
  assert.equal(fs.existsSync(targetPath), false);
});

test('relocate carry still refuses unmerged commits without force', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'multicc-git-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const oldDir = await initRepo(root, 'old');
  const targetDir = await initRepo(root, 'target');
  const session = await sessionIn(oldDir, 'ahead');
  await fsp.writeFile(path.join(session.worktreePath, 'committed.js'), 'module.exports = 1;\n');
  await git(session.worktreePath, ['add', '-A']);
  await git(session.worktreePath, ['commit', '-m', 'ahead commit']);
  await fsp.writeFile(path.join(session.worktreePath, 'app.js'), 'dirty\n');
  const result = await gitRelocateWorktree(oldDir, targetDir, session, { carry: true });
  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert(result.reasons.includes('unmerged'));
  // Dirty alone is not a refusal under carry — only the ahead commits block.
  assert(!result.reasons.includes('dirty'));
  assert.equal(fs.existsSync(session.worktreePath), true);
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

test('removal survives a wiped and re-inited base repo (stale fleet cleanup)', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'multicc-git-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const dir = await initRepo(root, 'repo');
  const session = await sessionIn(dir, 'stale');

  // Simulate the user deleting the directory contents on disk, after which
  // something re-creates an empty repo shell: no commits, no session refs,
  // no worktrees. Forced removal used to fatal in backupBeforeForce
  // (update-ref on an unresolvable branch) and surface as a 500.
  await fsp.rm(dir.path, { recursive: true, force: true });
  await fsp.mkdir(dir.path, { recursive: true });
  await git(dir.path, ['init', '-b', 'main']);

  const forced = await gitWorktreeRemove(dir.path, session.worktreePath, session.branch, {
    sessionId: session.id, baseBranch: dir.baseBranch, force: true,
  });
  assert.equal(forced.ok, true);
  assert.equal(forced.backup, null);

  const unforced = await gitWorktreeRemove(dir.path, session.worktreePath, session.branch, {
    sessionId: session.id, baseBranch: dir.baseBranch,
  });
  assert.equal(unforced.ok, true);
});

test('removal tolerates a worktree dir the re-inited repo no longer tracks', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'multicc-git-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const dir = await initRepo(root, 'repo');
  const session = await sessionIn(dir, 'stray');

  // Wipe only the base .git and re-init: the worktree directory survives on
  // disk but the fresh repo knows nothing about it. Removal must not throw;
  // the stray directory is left for the user rather than force-deleted.
  await fsp.rm(path.join(dir.path, '.git'), { recursive: true, force: true });
  await git(dir.path, ['init', '-b', 'main']);

  const forced = await gitWorktreeRemove(dir.path, session.worktreePath, session.branch, {
    sessionId: session.id, baseBranch: dir.baseBranch, force: true,
  });
  assert.equal(forced.ok, true);
  assert.equal(fs.existsSync(session.worktreePath), true);
});
