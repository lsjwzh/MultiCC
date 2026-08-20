'use strict';

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { defaultRepoActor, DEFAULT_TIMEOUT_MS } = require('./repo-actor');

const execFileAsync = promisify(execFile);
const WORKTREE_SUBDIR = '.multicc-worktrees';

function lines(value) {
  return String(value || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

function errorText(error) {
  return String(error && error.stderr || error && error.message || error || '').trim();
}

async function gitRun(cwd, args, opts = {}) {
  return defaultRepoActor.runGit(cwd, args, opts);
}

async function gitIsRepo(dirPath) {
  try { return await gitRun(dirPath, ['rev-parse', '--is-inside-work-tree']) === 'true'; }
  catch (_) { return false; }
}

async function gitHasCommit(dirPath) {
  try { await gitRun(dirPath, ['rev-parse', 'HEAD']); return true; }
  catch (_) { return false; }
}

async function baseBranchWith(execGit, dirPath) {
  try {
    const branch = await execGit(dirPath, ['symbolic-ref', '--short', 'HEAD']);
    if (branch) return branch;
  } catch (_) {}
  try {
    const branch = await execGit(dirPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (branch && branch !== 'HEAD') return branch;
  } catch (_) {}
  return 'main';
}

async function gitBaseBranch(dirPath) {
  return defaultRepoActor.run(dirPath, 'base-branch', async ({ execGit }) => ({
    ok: true,
    branch: await baseBranchWith(execGit, dirPath),
  })).then(result => result.branch);
}

async function gitWorktreeSnapshot(worktreePath, branch = null) {
  if (!worktreePath) throw new Error('worktreePath is required');
  return defaultRepoActor.run(worktreePath, 'worktree-snapshot', async ({ execGit }) => {
    const resolvedBranch = branch || await baseBranchWith(execGit, worktreePath);
    const head = await execGit(worktreePath, ['rev-parse', 'HEAD']);
    const changes = String(await execGit(worktreePath, ['status', '--short']) || '')
      .split(/\r?\n/)
      .map(line => line.trimEnd())
      .filter(Boolean)
      .slice(0, 100);
    return { ok: true, branch: resolvedBranch, head, changes };
  });
}

async function gitExportSessionBundle(dir, session, tmpPath, maxBytes = Infinity) {
  if (!dir || !dir.path) throw new Error('dir.path is required');
  if (!session || !session.branch) throw new Error('session.branch is required');
  if (!tmpPath) throw new Error('tmpPath is required');
  const limit = Number.isFinite(Number(maxBytes)) && Number(maxBytes) >= 0
    ? Number(maxBytes)
    : Infinity;

  return defaultRepoActor.run(dir.path, 'session-bundle-export', async ({ execGit, progress }) => {
    const baseBranch = dir.baseBranch || await baseBranchWith(execGit, dir.path);
    const unique = parseInt(await execGit(dir.path,
      ['rev-list', '--count', `${baseBranch}..${session.branch}`]) || '0', 10);
    if (!unique) {
      await fsp.rm(tmpPath, { force: true }).catch(() => {});
      return {
        ok: true,
        bundlePath: null,
        baseBranch,
        branch: session.branch,
        unique: 0,
        size: 0,
        note: 'no unique commits',
      };
    }

    progress('bundle-create', { branch: session.branch, baseBranch, unique });
    await fsp.mkdir(path.dirname(tmpPath), { recursive: true });
    await fsp.rm(tmpPath, { force: true });
    try {
      // Naming the branch (rather than only a raw commit hash) ensures the
      // bundle contains a fetchable refs/heads/<branch> entry. Excluding the
      // base keeps the payload limited to commits unique to this session.
      await execGit(dir.path, ['bundle', 'create', tmpPath, session.branch, `^${baseBranch}`]);
      const stat = await fsp.stat(tmpPath);
      if (stat.size > limit) {
        await fsp.rm(tmpPath, { force: true });
        return {
          ok: false,
          tooLarge: true,
          bundlePath: null,
          baseBranch,
          branch: session.branch,
          unique,
          size: stat.size,
          maxBytes: limit,
          note: 'bundle exceeds size limit',
        };
      }
      return {
        ok: true,
        bundlePath: tmpPath,
        baseBranch,
        branch: session.branch,
        unique,
        size: stat.size,
        note: null,
      };
    } catch (error) {
      await fsp.rm(tmpPath, { force: true }).catch(() => {});
      throw error;
    }
  }, { sessionId: session.id });
}

async function gitImportSessionBundle(dir, session, tmpBundle, sourceBranch) {
  if (!dir || !dir.path) throw new Error('dir.path is required');
  if (!session || !session.worktreePath) throw new Error('session.worktreePath is required');
  if (!tmpBundle) throw new Error('tmpBundle is required');
  if (!sourceBranch) throw new Error('sourceBranch is required');

  return defaultRepoActor.run(dir.path, 'session-bundle-import', async ({ execGit, progress, operationId: id }) => {
    const worktreePath = session.worktreePath;
    const originalHead = await execGit(worktreePath, ['rev-parse', 'HEAD']);
    const initialStatus = await execGit(worktreePath, ['status', '--porcelain']);
    if (initialStatus) {
      return { ok: false, blocked: true, reasons: ['dirty'], restored: false,
        error: 'bundle import requires a clean target worktree' };
    }

    const safeId = String(id).replace(/[^A-Za-z0-9._/-]/g, '-');
    const incomingRef = `refs/multicc/import/${safeId}`;
    const sourceRef = String(sourceBranch).startsWith('refs/')
      ? String(sourceBranch)
      : `refs/heads/${sourceBranch}`;
    let cherryPickStarted = false;
    let mergeStarted = false;
    let commits = [];
    try {
      progress('bundle-fetch', { sourceRef, incomingRef });
      await execGit(dir.path, ['fetch', '--no-tags', tmpBundle, `+${sourceRef}:${incomingRef}`]);
      const mergeBase = await execGit(worktreePath, ['merge-base', 'HEAD', incomingRef]);
      commits = lines(await execGit(worktreePath, ['rev-list', '--reverse', `${mergeBase}..${incomingRef}`]));
      if (!commits.length) {
        return { ok: true, restored: false, commits: 0, mergeBase, originalHead,
          note: 'bundle has no commits to import' };
      }

      const mergeCommits = lines(await execGit(worktreePath,
        ['rev-list', '--min-parents=2', `${mergeBase}..${incomingRef}`]));
      let strategy = 'cherry-pick';
      if (mergeCommits.length) {
        // A cherry-pick sequence cannot assign a different mainline to each
        // merge commit. Preserve that topology with one non-fast-forward merge
        // instead; `merge --abort` has the same all-or-nothing property.
        strategy = 'merge';
        progress('merge', { commits: commits.length, mergeCommits: mergeCommits.length });
        mergeStarted = true;
        await execGit(worktreePath, ['-c', 'user.email=multicc@local', '-c', 'user.name=multicc',
          'merge', '--no-ff', '--no-edit', incomingRef]);
        mergeStarted = false;
      } else {
        progress('cherry-pick', { commits: commits.length });
        cherryPickStarted = true;
        // Execute the whole sequence in one command so `cherry-pick --abort`
        // restores the exact pre-import HEAD even when a later commit conflicts.
        await execGit(worktreePath, ['-c', 'user.email=multicc@local', '-c', 'user.name=multicc',
          'cherry-pick', ...commits]);
        cherryPickStarted = false;
      }
      return {
        ok: true,
        restored: true,
        commits: commits.length,
        strategy,
        mergeBase,
        originalHead,
        head: await execGit(worktreePath, ['rev-parse', 'HEAD']),
      };
    } catch (error) {
      let abortError = null;
      if (cherryPickStarted || mergeStarted) {
        try { await execGit(worktreePath, [mergeStarted ? 'merge' : 'cherry-pick', '--abort']); }
        catch (abortFailure) { abortError = errorText(abortFailure); }
      }
      const head = await execGit(worktreePath, ['rev-parse', 'HEAD']).catch(() => '');
      const status = await execGit(worktreePath, ['status', '--porcelain']).catch(() => '');
      return {
        ok: false,
        restored: false,
        commits: commits.length,
        originalHead,
        head,
        clean: !status,
        aborted: (cherryPickStarted || mergeStarted) && !abortError,
        abortError,
        error: errorText(error) || 'bundle import failed',
      };
    } finally {
      try { await execGit(dir.path, ['update-ref', '-d', incomingRef]); } catch (_) {}
    }
  }, { sessionId: session.id });
}

async function ensureExcludedWith(execGit, dirPath) {
  const gitDir = await execGit(dirPath, ['rev-parse', '--git-dir']);
  const absGitDir = path.isAbsolute(gitDir) ? gitDir : path.join(dirPath, gitDir);
  const excludeFile = path.join(absGitDir, 'info', 'exclude');
  let content = '';
  try { content = await fsp.readFile(excludeFile, 'utf8'); } catch (_) {}
  if (!content.split(/\r?\n/).some(line => line.trim() === `${WORKTREE_SUBDIR}/`)) {
    await fsp.mkdir(path.dirname(excludeFile), { recursive: true });
    await fsp.appendFile(excludeFile, `${content && !content.endsWith('\n') ? '\n' : ''}${WORKTREE_SUBDIR}/\n`);
  }
}

async function gitEnsureExcluded(dirPath) {
  try {
    return await defaultRepoActor.run(dirPath, 'ensure-excluded', async ({ execGit }) => {
      await ensureExcludedWith(execGit, dirPath);
      return { ok: true };
    });
  } catch (error) {
    console.warn('[multicc] gitEnsureExcluded failed:', error.message);
    return { ok: false, error: error.message };
  }
}

async function commitAllWith(execGit, worktreePath, message) {
  await execGit(worktreePath, ['add', '-A']);
  try {
    await execGit(worktreePath, ['diff', '--cached', '--quiet']);
    return false;
  } catch (_) {}
  await execGit(worktreePath, ['-c', 'user.email=multicc@local', '-c', 'user.name=multicc',
    'commit', '-m', message]);
  return true;
}

async function gitWorktreeCommitAll(worktreePath, message, opts = {}) {
  return defaultRepoActor.run(worktreePath, 'commit-all', async ({ execGit, progress }) => {
    progress('commit');
    return { ok: true, committed: await commitAllWith(execGit, worktreePath, message) };
  }, opts).then(result => opts.withMetadata ? result : result.committed);
}

async function gitWorktreeAdd(dirPath, sessionId, baseBranch, opts = {}) {
  const worktreePath = path.join(dirPath, WORKTREE_SUBDIR, sessionId);
  const branch = `multicc/${sessionId}`;
  return defaultRepoActor.run(dirPath, 'worktree-add', async ({ execGit, progress }) => {
    progress('prepare');
    await ensureExcludedWith(execGit, dirPath);
    await fsp.mkdir(path.join(dirPath, WORKTREE_SUBDIR), { recursive: true });
    try { await execGit(dirPath, ['worktree', 'prune']); } catch (_) {}
    let branchExists = false;
    try { await execGit(dirPath, ['rev-parse', '--verify', branch]); branchExists = true; } catch (_) {}
    if (opts.requireExistingBranch && !branchExists) {
      const error = new Error('session branch is missing');
      error.code = 'WORKTREE_BRANCH_MISSING';
      throw error;
    }
    try {
      const stat = await fsp.stat(worktreePath);
      if (stat.isDirectory()) {
        if (opts.requireExistingBranch) {
          const validation = await worktreeValidationWith(execGit, dirPath, worktreePath, branch);
          if (!validation.ok) {
            const error = new Error('existing worktree does not match the session branch');
            error.code = validation.code;
            throw error;
          }
        }
        return { ok: true, worktreePath, branch, existing: true };
      }
    } catch (error) {
      if (error && error.code && error.code.startsWith('WORKTREE_')) throw error;
    }
    progress('create', { worktreePath, branch });
    await execGit(dirPath, branchExists
      ? ['worktree', 'add', worktreePath, branch]
      : ['worktree', 'add', worktreePath, '-b', branch, baseBranch]);
    return { ok: true, worktreePath, branch, existing: false };
  }, { ...opts, sessionId });
}

function worktreeBlocks(raw) {
  return String(raw || '').split(/\n\s*\n/).map((block) => {
    const item = {};
    for (const line of block.split('\n')) {
      const space = line.indexOf(' ');
      if (space > 0) item[line.slice(0, space)] = line.slice(space + 1);
    }
    return item;
  }).filter(item => item.worktree);
}

async function worktreeValidationWith(execGit, dirPath, worktreePath, branch) {
  const canonical = (value) => {
    try { return fs.realpathSync(value); } catch (_) { return path.resolve(value); }
  };
  const expectedPath = canonical(worktreePath);
  const expectedRef = `refs/heads/${branch}`;
  const pathExists = fs.existsSync(worktreePath);
  const rows = worktreeBlocks(await execGit(dirPath, ['worktree', 'list', '--porcelain']).catch(() => ''));
  const registered = rows.find(row => canonical(row.worktree) === expectedPath) || null;
  if (registered && registered.branch !== expectedRef) {
    return { ok: false, code: 'WORKTREE_BRANCH_MISMATCH', pathExists, branchExists: false };
  }
  let branchExists = false;
  try {
    await execGit(dirPath, ['rev-parse', '--verify', '--quiet', `${expectedRef}^{commit}`]);
    branchExists = true;
  } catch (_) {}
  if (!branchExists) return { ok: false, code: 'WORKTREE_BRANCH_MISSING', pathExists, branchExists };
  if (!registered) return { ok: false, code: 'WORKTREE_NOT_REGISTERED', pathExists, branchExists };
  return { ok: pathExists, code: pathExists ? null : 'WORKTREE_PATH_MISSING', pathExists, branchExists };
}

async function gitWorktreeValidate(dirPath, worktreePath, branch, opts = {}) {
  return defaultRepoActor.run(dirPath, 'worktree-validate', async ({ execGit }) => ({
    ...(await worktreeValidationWith(execGit, dirPath, worktreePath, branch)),
  }), opts);
}

const RECLAIMABLE_IGNORED_PREFIXES = Object.freeze([
  'node_modules/', '.dart_tool/', 'build/', '.gradle/',
  'app/node_modules/', 'app/.dart_tool/', 'app/build/', 'app/.gradle/',
  'android/.gradle/', 'app/android/.gradle/',
]);

function reclaimableIgnored(relative) {
  const value = String(relative || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!value || value.startsWith('/') || value.split('/').includes('..')) return false;
  if (RECLAIMABLE_IGNORED_PREFIXES.some(prefix => value === prefix.slice(0, -1) || value.startsWith(prefix))) return true;
  return /^(?:app\/)?(?:build\/[^/]+\/)*multicc[^/]*\.apk$/i.test(value)
    || /^app\/build\/app\/outputs\/flutter-apk\/[^/]+\.apk$/i.test(value);
}

async function worktreeOperationInProgress(execGit, worktreePath) {
  const markers = [
    ['MERGE_HEAD', 'merge'],
    ['CHERRY_PICK_HEAD', 'cherry_pick'],
    ['REVERT_HEAD', 'revert'],
    ['BISECT_START', 'bisect'],
    ['rebase-merge', 'rebase'],
    ['rebase-apply', 'rebase'],
  ];
  for (const [marker, operation] of markers) {
    let gitPath;
    try { gitPath = await execGit(worktreePath, ['rev-parse', '--git-path', marker]); }
    catch (_) { continue; }
    const target = path.isAbsolute(gitPath) ? gitPath : path.resolve(worktreePath, gitPath);
    if (fs.existsSync(target)) return operation;
  }
  return null;
}

// Hibernate-only primitive: snapshot every Git-visible change, delete only
// explicitly-regenerable ignored files, remove the checkout, and retain the
// session branch. This intentionally does not call gitWorktreeRemove(), whose
// lifecycle contract includes deleting the branch.
async function gitWorktreeDetach(dirPath, worktreePath, branch, opts = {}) {
  const sessionId = opts.sessionId || path.basename(worktreePath || branch || 'session');
  return defaultRepoActor.run(dirPath, 'worktree-detach', async ({ execGit, progress }) => {
    const validation = await worktreeValidationWith(execGit, dirPath, worktreePath, branch);
    if (!validation.ok) {
      const error = new Error('session worktree validation failed');
      error.code = validation.code;
      throw error;
    }
    const activeOperation = await worktreeOperationInProgress(execGit, worktreePath);
    if (activeOperation) {
      const error = new Error('worktree has an active Git operation');
      error.code = 'HIBERNATE_GIT_OPERATION_ACTIVE';
      error.operation = activeOperation;
      throw error;
    }
    const ignoredRaw = await execGit(worktreePath, [
      'ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--directory',
    ]).catch(() => '');
    const ignored = String(ignoredRaw || '').split('\0').filter(Boolean);
    const unknown = ignored.filter(relative => !reclaimableIgnored(relative));
    if (unknown.length) {
      const error = new Error('worktree contains ignored user files');
      error.code = 'HIBERNATE_UNKNOWN_IGNORED';
      error.count = unknown.length;
      throw error;
    }
    progress('snapshot');
    const committed = await commitAllWith(execGit, worktreePath,
      `[multicc] hibernate snapshot ${sessionId}`);
    const snapshot = await execGit(worktreePath, ['rev-parse', 'HEAD']);
    for (const relative of ignored) {
      const target = path.resolve(worktreePath, relative);
      const root = `${path.resolve(worktreePath)}${path.sep}`;
      if (!target.startsWith(root)) {
        const error = new Error('ignored cache path escaped worktree');
        error.code = 'HIBERNATE_CACHE_PATH_INVALID';
        throw error;
      }
      await fsp.rm(target, { recursive: true, force: true });
    }
    const dirty = await execGit(worktreePath, ['status', '--porcelain']);
    if (dirty) {
      const error = new Error('worktree remained dirty after snapshot');
      error.code = 'HIBERNATE_SNAPSHOT_DIRTY';
      throw error;
    }
    progress('detach');
    await execGit(dirPath, ['worktree', 'remove', worktreePath]);
    await execGit(dirPath, ['worktree', 'prune']).catch(() => '');
    if (fs.existsSync(worktreePath)) {
      const error = new Error('worktree checkout still exists after detach');
      error.code = 'HIBERNATE_PATH_REMAINS';
      throw error;
    }
    await execGit(dirPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
    return { ok: true, detached: true, committed, snapshot };
  }, { ...opts, sessionId });
}

// Compensation used only while creating a brand-new session. Unlike forced
// user deletion it intentionally creates no backup: these resources did not
// exist before the failed transaction. Absence is verified before success.
async function gitWorktreeRollbackCreate(dirPath, worktreePath, branch, opts = {}) {
  const sessionId = opts.sessionId || path.basename(worktreePath || branch || 'session');
  return defaultRepoActor.run(dirPath, 'worktree-create-rollback', async ({ execGit, progress }) => {
    const errors = [];
    progress('remove');
    if (worktreePath && fs.existsSync(worktreePath)) {
      try { await execGit(dirPath, ['worktree', 'remove', '--force', worktreePath]); }
      catch (error) { errors.push(errorText(error) || 'worktree remove failed'); }
    }
    if (branch) {
      let exists = false;
      try { await execGit(dirPath, ['rev-parse', '--verify', branch]); exists = true; } catch (_) {}
      if (exists) {
        try { await execGit(dirPath, ['branch', '-D', branch]); }
        catch (error) { errors.push(errorText(error) || 'branch remove failed'); }
      }
    }
    try { await execGit(dirPath, ['worktree', 'prune']); } catch (_) {}
    const worktreeExists = !!(worktreePath && fs.existsSync(worktreePath));
    let branchExists = false;
    if (branch) {
      try { await execGit(dirPath, ['rev-parse', '--verify', branch]); branchExists = true; } catch (_) {}
    }
    if (worktreeExists) errors.push('worktree still exists');
    if (branchExists) errors.push('branch still exists');
    if (errors.length) {
      const error = new Error(`session creation rollback incomplete: ${errors.join('; ')}`);
      error.code = 'SESSION_CREATE_ROLLBACK_FAILED';
      throw error;
    }
    return { ok: true, removed: true };
  }, { ...opts, sessionId });
}

async function rebaseConflictsWith(execGit, worktreePath) {
  if (!worktreePath || !fs.existsSync(worktreePath)) return null;
  let inProgress = false;
  try {
    for (const which of ['rebase-merge', 'rebase-apply']) {
      const gitPath = await execGit(worktreePath, ['rev-parse', '--git-path', which]);
      const absolute = path.isAbsolute(gitPath) ? gitPath : path.join(worktreePath, gitPath);
      if (fs.existsSync(absolute)) { inProgress = true; break; }
    }
  } catch (_) { return null; }
  if (!inProgress) return null;
  try { return lines(await execGit(worktreePath, ['diff', '--name-only', '--diff-filter=U'])); }
  catch (_) { return []; }
}

async function gitRebaseConflicts(worktreePath) {
  return defaultRepoActor.run(worktreePath, 'rebase-state', async ({ execGit }) => ({
    ok: true,
    conflicts: await rebaseConflictsWith(execGit, worktreePath),
  })).then(result => result.conflicts);
}

async function worktreeSafetyWith(execGit, dirPath, worktreePath, branch, baseBranch) {
  let dirty = false;
  let unmerged = 0;
  let ahead = 0;
  if (worktreePath && fs.existsSync(worktreePath)) {
    try { dirty = (await execGit(worktreePath, ['status', '--porcelain'])).length > 0; } catch (_) {}
  }
  if (branch) {
    try { ahead = parseInt(await execGit(dirPath, ['rev-list', '--count', `${baseBranch}..${branch}`]) || '0', 10); } catch (_) {}
    unmerged = ahead;
  }
  return { dirty, ahead, unmerged, baseBranch };
}

function backupName(sessionId, operationId) {
  const safe = String(sessionId || 'session').replace(/[^A-Za-z0-9._-]/g, '-');
  const op = String(operationId || 'operation').replace(/[^A-Za-z0-9._-]/g, '-');
  return `refs/multicc/backups/${safe}/${new Date().toISOString().replace(/[:.]/g, '-')}-${op}`;
}

async function backupBeforeForce(execGit, dirPath, worktreePath, branch, sessionId, operationId) {
  const ref = backupName(sessionId, operationId);
  const source = branch || (worktreePath ? 'HEAD' : null);
  if (source) await execGit(dirPath, ['update-ref', ref, source]);
  const commonDirRaw = await execGit(dirPath, ['rev-parse', '--git-common-dir']);
  const commonDir = path.isAbsolute(commonDirRaw) ? commonDirRaw : path.resolve(dirPath, commonDirRaw);
  const backupDir = path.join(commonDir, 'multicc-backups', operationId);
  await fsp.mkdir(backupDir, { recursive: true });
  let bundle = null;
  if (source) {
    bundle = path.join(backupDir, 'repository.bundle');
    await execGit(dirPath, ['bundle', 'create', bundle, ref]);
  }
  let patch = null;
  if (worktreePath && fs.existsSync(worktreePath)) {
    const diff = await execGit(worktreePath, ['diff', '--binary', 'HEAD']).catch(() => '');
    if (diff) {
      patch = path.join(backupDir, 'dirty.patch');
      await fsp.writeFile(patch, diff, 'utf8');
    }
    const untracked = await execGit(worktreePath, ['ls-files', '--others', '--exclude-standard']).catch(() => '');
    if (untracked) {
      const untrackedFiles = lines(untracked);
      await fsp.writeFile(path.join(backupDir, 'untracked-files.txt'), `${untrackedFiles.join('\n')}\n`, 'utf8');
      const untrackedDir = path.join(backupDir, 'untracked');
      for (const relative of untrackedFiles) {
        // Git paths are repository-relative. Still reject traversal/absolute
        // input before copying so a malformed index cannot escape backupDir.
        if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) continue;
        const sourcePath = path.join(worktreePath, relative);
        const backupPath = path.join(untrackedDir, relative);
        try {
          await fsp.mkdir(path.dirname(backupPath), { recursive: true });
          await fsp.cp(sourcePath, backupPath, { recursive: true, force: false });
        } catch (_) {}
      }
    }
  }
  return { ref, bundle, patch, backupDir };
}

async function gitWorktreeRemove(dirPath, worktreePath, branch, opts = {}) {
  const sessionId = opts.sessionId || path.basename(worktreePath || branch || 'session');
  return defaultRepoActor.run(dirPath, 'worktree-remove', async ({ execGit, progress, operationId: id }) => {
    const baseBranch = opts.baseBranch || await baseBranchWith(execGit, dirPath);
    const safety = await worktreeSafetyWith(execGit, dirPath, worktreePath, branch, baseBranch);
    const reasons = [];
    if (safety.dirty) reasons.push('dirty');
    if (safety.unmerged > 0) reasons.push('unmerged');
    if (reasons.length && !opts.force) {
      return { ok: false, blocked: true, reasons, safety, error: `worktree removal refused: ${reasons.join(', ')}` };
    }
    const resolvesToCommit = (ref) => execGit(dirPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
      .then(out => out.length > 0).catch(() => false);
    let backup = null;
    if (opts.force) {
      progress('backup');
      // A wiped/re-inited base repo (user deleted the directory contents on
      // disk) has none of the session's refs left; update-ref/bundle would
      // fatal on the unresolvable source and turn fleet deletion into a 500.
      // Nothing exists to back up in that state — skip instead of throw.
      const source = branch || (worktreePath && fs.existsSync(worktreePath) ? 'HEAD' : null);
      if (source && await resolvesToCommit(source)) {
        backup = await backupBeforeForce(execGit, dirPath, worktreePath, branch, sessionId, id);
      }
    }
    progress('remove');
    if (worktreePath && fs.existsSync(worktreePath)) {
      try {
        await execGit(dirPath, ['worktree', 'remove', ...(opts.force ? ['--force'] : []), worktreePath]);
      } catch (error) {
        // Tolerate a worktree the repo no longer tracks (base .git re-created
        // underneath us): leave the stray directory on disk and carry on so
        // the stale session record can still be deleted. A worktree git DOES
        // track failing to remove is still fatal.
        const registered = await execGit(dirPath, ['worktree', 'list', '--porcelain'])
          .then(out => out.split('\n').some(l => l === `worktree ${path.resolve(worktreePath)}`))
          .catch(() => false);
        if (registered) throw error;
      }
    }
    if (branch && await resolvesToCommit(`refs/heads/${branch}`)) {
      try { await execGit(dirPath, ['branch', opts.force ? '-D' : '-d', branch]); } catch (error) {
        if (!opts.force) return { ok: false, blocked: true, reasons: ['unmerged'], backup, error: errorText(error) };
        throw error;
      }
    }
    try { await execGit(dirPath, ['worktree', 'prune']); } catch (_) {}
    return { ok: true, removed: true, backup, safety };
  }, { ...opts, sessionId });
}

// Cross-repository relocate with create-before-delete semantics. The target is
// created first; any refusal/failure while removing the source rolls the target
// back and leaves the caller's persisted session fields untouched.
async function gitRelocateWorktree(oldDir, targetDir, session, opts = {}) {
  if (!oldDir || !targetDir || !session) return { ok: false, error: 'oldDir, targetDir and session are required' };
  const state = await gitWorktreeMergeState(oldDir, session);
  const reasons = [];
  if (opts.active) reasons.push('active');
  if (state.dirty) reasons.push('dirty');
  if (state.ahead > 0) reasons.push('unmerged');
  if (reasons.length && !opts.force) {
    return { ok: false, blocked: true, reasons, mergeState: state, error: `relocate refused: ${reasons.join(', ')}` };
  }

  let created;
  try {
    created = await gitWorktreeAdd(targetDir.path, session.id, targetDir.baseBranch, opts);
    if (typeof opts.beforeRemove === 'function') await opts.beforeRemove(created);
    const removed = await gitWorktreeRemove(oldDir.path, session.worktreePath, session.branch, {
      ...opts, sessionId: session.id, baseBranch: oldDir.baseBranch,
    });
    if (!removed.ok) throw Object.assign(new Error(removed.error || 'source removal refused'), { result: removed });
    return {
      ok: true,
      worktreePath: created.worktreePath,
      branch: created.branch,
      createdOperationId: created.operationId,
      operationId: removed.operationId,
      queueDepth: Math.max(created.queueDepth || 0, removed.queueDepth || 0),
      backup: removed.backup || null,
    };
  } catch (error) {
    let rollback = null;
    if (created) {
      rollback = await gitWorktreeRemove(targetDir.path, created.worktreePath, created.branch, {
        sessionId: `${session.id}-relocate-rollback`, baseBranch: targetDir.baseBranch,
        activeCheck: null,
      }).catch(rollbackError => ({ ok: false, error: errorText(rollbackError) }));
      if (!rollback.ok) {
        rollback = await gitWorktreeRemove(targetDir.path, created.worktreePath, created.branch, {
          sessionId: `${session.id}-relocate-rollback`, baseBranch: targetDir.baseBranch,
          force: true, activeCheck: null,
        }).catch(rollbackError => ({ ok: false, error: errorText(rollbackError) }));
      }
    }
    const leaseReason = error.code === 'SESSION_ACTIVE' ? 'active'
      : (error.code === 'SESSION_LEASED' ? 'leased' : null);
    return {
      ...(error.result || {}),
      ok: false,
      blocked: error.result?.blocked || !!leaseReason,
      reasons: error.result?.reasons || (leaseReason ? [leaseReason] : undefined),
      rolledBack: !!created && !!rollback?.ok,
      rollbackError: created && !rollback?.ok ? rollback?.error || 'target rollback failed' : undefined,
      operationId: error.result?.operationId || error.operationId,
      queueDepth: error.result?.queueDepth || error.queueDepth,
      error: error.result?.error || errorText(error),
    };
  }
}

async function mergeStateWith(execGit, dir, session) {
  if (!dir || !session || !session.worktreePath || !session.branch) {
    return { mergeReady: false, dirty: false, ahead: 0, behind: 0, reason: 'no-worktree' };
  }
  const worktreePath = session.worktreePath;
  const baseBranch = dir.baseBranch || await baseBranchWith(execGit, dir.path);
  const conflictFiles = await rebaseConflictsWith(execGit, worktreePath);
  if (conflictFiles) {
    return { mergeReady: false, dirty: true, ahead: 0, behind: 0, baseBranch,
      branch: session.branch, baseCheckedOut: true, conflict: true, conflictFiles };
  }
  const safety = await worktreeSafetyWith(execGit, dir.path, worktreePath, session.branch, baseBranch);
  let behind = 0;
  try {
    const [left] = String(await execGit(dir.path, ['rev-list', '--left-right', '--count', `${baseBranch}...${session.branch}`])).split(/\s+/);
    behind = parseInt(left || '0', 10);
  } catch (_) {}
  const current = await baseBranchWith(execGit, dir.path);
  let hasContentDiff = safety.ahead > 0;
  if (safety.ahead > 0) {
    try { await execGit(dir.path, ['diff', '--quiet', `${baseBranch}...${session.branch}`]); hasContentDiff = false; }
    catch (_) { hasContentDiff = true; }
  }
  return {
    mergeReady: (safety.dirty || (safety.ahead > 0 && hasContentDiff)) && current === baseBranch,
    dirty: safety.dirty, ahead: safety.ahead, behind, baseBranch, branch: session.branch,
    baseCheckedOut: current === baseBranch, conflict: false,
  };
}

async function gitWorktreeMergeState(dir, session, opts = {}) {
  if (!dir || !session) return { mergeReady: false, dirty: false, ahead: 0, reason: 'no-worktree' };
  return defaultRepoActor.run(dir.path, 'merge-state', async ({ execGit }) => ({
    ok: true,
    state: await mergeStateWith(execGit, dir, session),
  }), opts).then(result => result.state);
}

async function checkMergedJsSyntax(worktreePath, fromRef, toRef, execGit) {
  let changed = [];
  try {
    changed = lines(await execGit(worktreePath, ['diff', '--name-only', '--diff-filter=ACMR', fromRef, toRef]))
      .filter(file => /\.(c|m)?js$/.test(file) && !file.includes('node_modules/') && !file.includes(`${WORKTREE_SUBDIR}/`));
  } catch (_) { return []; }
  const errors = [];
  for (const relative of changed) {
    const absolute = path.join(worktreePath, relative);
    if (!fs.existsSync(absolute)) continue;
    try {
      await execFileAsync(process.execPath, ['--check', absolute], {
        encoding: 'utf8', timeout: DEFAULT_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
      });
    } catch (error) {
      const line = errorText(error).split(/\r?\n/).map(s => s.trim()).find(s => /SyntaxError|Error:/.test(s)) || 'parse failed';
      errors.push({ file: relative, error: line });
    }
  }
  return errors;
}

async function gitMergeBack(dir, session, opts = {}) {
  if (!dir || !session || !session.branch || !session.worktreePath) return { ok: false, error: 'session has no worktree' };
  return defaultRepoActor.run(dir.path, 'merge-back', async ({ execGit, progress, operationId: id }) => {
    const dirPath = dir.path;
    const branch = session.branch;
    const worktreePath = session.worktreePath;
    const baseBranch = dir.baseBranch || await baseBranchWith(execGit, dirPath);
    if (await baseBranchWith(execGit, dirPath) !== baseBranch) {
      return { ok: false, blocked: true, reasons: ['base-not-checked-out'], error: `base branch '${baseBranch}' is not checked out` };
    }
    const mainDirty = (await execGit(dirPath, ['status', '--porcelain'])).length > 0;
    if (mainDirty) return { ok: false, blocked: true, reasons: ['base-dirty'], error: 'base worktree is dirty' };

    progress('commit-session');
    const committed = await commitAllWith(execGit, worktreePath,
      `multicc: session ${session.id} @ ${new Date().toISOString()}`);
    const ahead = parseInt(await execGit(dirPath, ['rev-list', '--count', `${baseBranch}..${branch}`]) || '0', 10);
    if (!ahead) return { ok: true, merged: false, committed, message: '没有新提交需要合并' };

    const baseHead = await execGit(dirPath, ['rev-parse', baseBranch]);
    const tempRef = `refs/multicc/integration/${id}`;
    const integrationPath = path.join(os.tmpdir(), `multicc-integration-${id}`);
    let integrationAdded = false;
    try {
      progress('integration-prepare');
      await execGit(dirPath, ['update-ref', tempRef, baseHead]);
      await execGit(dirPath, ['worktree', 'add', '--detach', integrationPath, tempRef]);
      integrationAdded = true;
      progress('integration-merge');
      await execGit(integrationPath, ['-c', 'user.email=multicc@local', '-c', 'user.name=multicc',
        'merge', '--no-ff', '-m', `multicc: merge ${branch}`, branch]);
      const integrationHead = await execGit(integrationPath, ['rev-parse', 'HEAD']);
      progress('validate');
      const syntaxErrors = await checkMergedJsSyntax(integrationPath, baseHead, integrationHead, execGit);
      if (syntaxErrors.length) {
        return { ok: false, syntaxErrors, integrationRef: tempRef,
          error: `合并被拒绝：${syntaxErrors.length} 个文件语法错误；用户主工作区未改动` };
      }
      progress('publish');
      await execGit(dirPath, ['merge', '--ff-only', integrationHead]);
      let syncedBack = false;
      try {
        await execGit(worktreePath, ['merge', '--ff-only', baseBranch]);
        syncedBack = true;
      } catch (_) {}
      return { ok: true, merged: true, committed, commits: ahead, syncedBack, integrationRef: tempRef };
    } catch (error) {
      let conflicts = [];
      let conflictDiff = '';
      if (integrationAdded) {
        try { conflicts = lines(await execGit(integrationPath, ['diff', '--name-only', '--diff-filter=U'])); } catch (_) {}
        if (conflicts.length) {
          try { conflictDiff = (await execGit(integrationPath, ['diff', '--no-color', '--diff-filter=U'], { maxBuffer: 1024 * 1024 })).slice(0, 1024 * 1024); } catch (_) {}
        }
      }
      return { ok: false, conflicts, conflictDiff, error: conflicts.length
        ? '合并冲突仅发生在 integration worktree；用户主工作区未改动'
        : errorText(error) || 'merge failed' };
    } finally {
      if (integrationAdded) {
        try { await execGit(dirPath, ['worktree', 'remove', '--force', integrationPath]); } catch (_) { await fsp.rm(integrationPath, { recursive: true, force: true }); }
      }
      try { await execGit(dirPath, ['update-ref', '-d', tempRef]); } catch (_) {}
    }
  }, { ...opts, sessionId: session.id });
}

async function gitSyncFromBase(dir, session, opts = {}) {
  if (!dir || !session || !session.branch || !session.worktreePath || !fs.existsSync(session.worktreePath)) {
    return { ok: false, error: 'session has no worktree' };
  }
  return defaultRepoActor.run(dir.path, 'sync-from-base', async ({ execGit, progress, operationId: id }) => {
    const worktreePath = session.worktreePath;
    const baseBranch = dir.baseBranch || await baseBranchWith(execGit, dir.path);
    const parked = await rebaseConflictsWith(execGit, worktreePath);
    if (parked) return { ok: false, conflicts: parked, rebaseInProgress: true, error: 'worktree 仍处于 rebase 冲突中' };
    const safety = await worktreeSafetyWith(execGit, dir.path, worktreePath, session.branch, baseBranch);
    const reasons = [];
    if (safety.dirty) reasons.push('dirty');
    if (safety.unmerged > 0) reasons.push('unmerged');
    if (reasons.length && !opts.force) {
      return { ok: false, skipped: true, blocked: true, reasons, safety,
        error: `sync/rebase refused: ${reasons.join(', ')}` };
    }
    let backup = null;
    let committed = false;
    if (reasons.length && opts.force) {
      backup = await backupBeforeForce(execGit, dir.path, worktreePath, session.branch, session.id, id);
      if (safety.dirty) {
        committed = await commitAllWith(execGit, worktreePath, `multicc: forced sync backup @ ${new Date().toISOString()}`);
      }
    }
    const behind = parseInt(await execGit(dir.path, ['rev-list', '--count', `${session.branch}..${baseBranch}`]) || '0', 10);
    if (!behind) return { ok: true, merged: false, committed, backup, message: '已是最新，无需同步' };
    try {
      progress('rebase');
      await execGit(worktreePath, ['-c', 'user.email=multicc@local', '-c', 'user.name=multicc', 'rebase', baseBranch]);
      return { ok: true, merged: true, committed, commits: behind, baseBranch, backup };
    } catch (error) {
      const conflicts = lines(await execGit(worktreePath, ['diff', '--name-only', '--diff-filter=U']).catch(() => ''));
      if (conflicts.length && !opts.abortOnConflict) {
        return { ok: false, conflicts, rebaseInProgress: true, committed, backup, error: `与 ${baseBranch} 存在冲突，rebase 已暂停` };
      }
      try { await execGit(worktreePath, ['rebase', '--abort']); } catch (_) {}
      return { ok: false, conflicts, rebaseInProgress: false, committed, backup,
        error: conflicts.length ? `与 ${baseBranch} 存在冲突，已 abort` : errorText(error) };
    }
  }, { ...opts, sessionId: session.id });
}

async function gitRebaseResolve(dir, session, action, opts = {}) {
  if (!dir || !session || !session.worktreePath || !fs.existsSync(session.worktreePath)) {
    return { ok: false, error: 'session has no worktree' };
  }
  return defaultRepoActor.run(dir.path, 'rebase-resolve', async ({ execGit }) => {
    const worktreePath = session.worktreePath;
    if (!await rebaseConflictsWith(execGit, worktreePath)) return { ok: false, error: '当前没有进行中的 rebase' };
    if (action === 'abort') {
      await execGit(worktreePath, ['rebase', '--abort']);
      return { ok: true, aborted: true };
    }
    await execGit(worktreePath, ['add', '-A']);
    const conflicts = lines(await execGit(worktreePath, ['diff', '--name-only', '--diff-filter=U']).catch(() => ''));
    if (conflicts.length) return { ok: false, conflicts, rebaseInProgress: true, error: '仍有冲突文件' };
    try {
      await execGit(worktreePath, ['-c', 'user.email=multicc@local', '-c', 'user.name=multicc', 'rebase', '--continue'],
        { env: { GIT_EDITOR: 'true' } });
    } catch (error) {
      const next = lines(await execGit(worktreePath, ['diff', '--name-only', '--diff-filter=U']).catch(() => ''));
      return { ok: false, conflicts: next, rebaseInProgress: true, error: errorText(error) };
    }
    return { ok: true, continued: true, done: !await rebaseConflictsWith(execGit, worktreePath) };
  }, { ...opts, sessionId: session.id });
}

module.exports = {
  WORKTREE_SUBDIR,
  gitRun,
  gitIsRepo,
  gitHasCommit,
  gitBaseBranch,
  gitWorktreeSnapshot,
  gitExportSessionBundle,
  gitImportSessionBundle,
  gitEnsureExcluded,
  gitWorktreeAdd,
  gitWorktreeDetach,
  gitWorktreeValidate,
  gitWorktreeRollbackCreate,
  gitWorktreeRemove,
  gitRelocateWorktree,
  gitWorktreeCommitAll,
  gitWorktreeMergeState,
  gitMergeBack,
  gitSyncFromBase,
  gitRebaseConflicts,
  gitRebaseResolve,
  checkMergedJsSyntax,
  defaultRepoActor,
};
