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
    try {
      const stat = await fsp.stat(worktreePath);
      if (stat.isDirectory()) return { ok: true, worktreePath, branch, existing: true };
    } catch (_) {}
    let branchExists = false;
    try { await execGit(dirPath, ['rev-parse', '--verify', branch]); branchExists = true; } catch (_) {}
    progress('create', { worktreePath, branch });
    await execGit(dirPath, branchExists
      ? ['worktree', 'add', worktreePath, branch]
      : ['worktree', 'add', worktreePath, '-b', branch, baseBranch]);
    return { ok: true, worktreePath, branch, existing: false };
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
    let backup = null;
    if (opts.force) {
      progress('backup');
      backup = await backupBeforeForce(execGit, dirPath, worktreePath, branch, sessionId, id);
    }
    progress('remove');
    if (worktreePath && fs.existsSync(worktreePath)) {
      await execGit(dirPath, ['worktree', 'remove', ...(opts.force ? ['--force'] : []), worktreePath]);
    }
    if (branch) {
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
  gitEnsureExcluded,
  gitWorktreeAdd,
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
