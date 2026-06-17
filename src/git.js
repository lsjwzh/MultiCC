// Git + worktree operations. Pure functions: every input arrives as an argument
// (dirPath / dir / session), nothing reads global state. server.js keeps the
// stateful bits (gitReadyDirs, invalidSessions) and the directory-suitability
// helpers; it imports these by destructuring, so existing call sites are unchanged.
//
// Every session runs in an isolated git worktree under
// <dir>/.multicc-worktrees/<sessionId> on its own branch `multicc/<sessionId>`.
// Work is collected back via an explicit merge.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const WORKTREE_SUBDIR = '.multicc-worktrees';

function gitRun(cwd, args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function gitIsRepo(dirPath) {
  try { return gitRun(dirPath, ['rev-parse', '--is-inside-work-tree']) === 'true'; }
  catch { return false; }
}

function gitHasCommit(dirPath) {
  try { gitRun(dirPath, ['rev-parse', 'HEAD']); return true; }
  catch { return false; }
}

function gitBaseBranch(dirPath) {
  try {
    const b = gitRun(dirPath, ['symbolic-ref', '--short', 'HEAD']);
    if (b) return b;
  } catch (_) {}
  try {
    const b = gitRun(dirPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (b && b !== 'HEAD') return b;
  } catch (_) {}
  return 'main';
}

// Add `.multicc-worktrees/` to .git/info/exclude (does not touch the user's tracked .gitignore).
function gitEnsureExcluded(dirPath) {
  try {
    const gitDir = gitRun(dirPath, ['rev-parse', '--git-dir']);
    const absGitDir = path.isAbsolute(gitDir) ? gitDir : path.join(dirPath, gitDir);
    const excludeFile = path.join(absGitDir, 'info', 'exclude');
    let content = '';
    try { content = fs.readFileSync(excludeFile, 'utf8'); } catch (_) {}
    if (!content.split('\n').some(l => l.trim() === WORKTREE_SUBDIR + '/')) {
      fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
      fs.appendFileSync(excludeFile, (content && !content.endsWith('\n') ? '\n' : '') + WORKTREE_SUBDIR + '/\n');
    }
  } catch (e) {
    console.warn('[multicc] gitEnsureExcluded failed:', e.message);
  }
}

// Create (or re-attach) the worktree for a session. Returns { worktreePath, branch }.
function gitWorktreeAdd(dirPath, sessionId, baseBranch) {
  const wtPath = path.join(dirPath, WORKTREE_SUBDIR, sessionId);
  const branch = `multicc/${sessionId}`;
  fs.mkdirSync(path.join(dirPath, WORKTREE_SUBDIR), { recursive: true });
  try { gitRun(dirPath, ['worktree', 'prune']); } catch (_) {}
  if (fs.existsSync(wtPath)) return { worktreePath: wtPath, branch };  // already there
  let branchExists = false;
  try { gitRun(dirPath, ['rev-parse', '--verify', branch]); branchExists = true; } catch (_) {}
  if (branchExists) {
    gitRun(dirPath, ['worktree', 'add', wtPath, branch]);
  } else {
    gitRun(dirPath, ['worktree', 'add', wtPath, '-b', branch, baseBranch]);
  }
  return { worktreePath: wtPath, branch };
}

function gitWorktreeRemove(dirPath, worktreePath, branch) {
  try { gitRun(dirPath, ['worktree', 'remove', '--force', worktreePath]); }
  catch (e) { console.warn('[multicc] worktree remove failed:', e.message); }
  if (branch) { try { gitRun(dirPath, ['branch', '-D', branch]); } catch (_) {} }
  try { gitRun(dirPath, ['worktree', 'prune']); } catch (_) {}
}

// Stage + commit everything in a worktree. Returns true if a commit was actually made.
function gitWorktreeCommitAll(worktreePath, message) {
  gitRun(worktreePath, ['add', '-A']);
  try {
    gitRun(worktreePath, ['diff', '--cached', '--quiet']);
    return false;  // exit 0 → nothing staged
  } catch (_) { /* exit 1 → there are staged changes */ }
  gitRun(worktreePath, ['-c', 'user.email=multicc@local', '-c', 'user.name=multicc',
    'commit', '-m', message]);
  return true;
}

function gitWorktreeMergeState(dir, session) {
  if (!dir || !session || !session.worktreePath || !session.branch) {
    return { mergeReady: false, dirty: false, ahead: 0, reason: 'no-worktree' };
  }
  const wtPath = session.worktreePath;
  const baseBranch = dir.baseBranch || gitBaseBranch(dir.path);
  let dirty = false;
  let ahead = 0;
  let baseCheckedOut = true;

  try {
    dirty = fs.existsSync(wtPath) && gitRun(wtPath, ['status', '--porcelain']).length > 0;
  } catch (_) {}
  try {
    ahead = parseInt(gitRun(dir.path, ['rev-list', '--count', `${baseBranch}..${session.branch}`]) || '0', 10);
  } catch (_) {}
  try {
    baseCheckedOut = gitBaseBranch(dir.path) === baseBranch;
  } catch (_) {}

  return {
    mergeReady: dirty || ahead > 0,
    dirty,
    ahead,
    baseBranch,
    branch: session.branch,
    baseCheckedOut,
  };
}

// Commit pending work in the worktree, then merge its branch into the base branch.
function gitMergeBack(dir, session) {
  const dirPath = dir.path;
  const branch = session.branch;
  const baseBranch = dir.baseBranch || gitBaseBranch(dirPath);
  const wtPath = session.worktreePath;
  if (!branch || !wtPath) return { ok: false, error: 'session has no worktree' };

  let committed = false;
  if (fs.existsSync(wtPath)) {
    try {
      committed = gitWorktreeCommitAll(wtPath,
        `multicc: session ${session.id} @ ${new Date().toISOString()}`);
    } catch (e) {
      return { ok: false, error: `commit failed: ${e.message}` };
    }
  }

  const curBranch = gitBaseBranch(dirPath);
  if (curBranch !== baseBranch) {
    return { ok: false, error:
      `base branch '${baseBranch}' is not checked out in the main directory (currently on '${curBranch}'); merge manually` };
  }

  let ahead = 0;
  try { ahead = parseInt(gitRun(dirPath, ['rev-list', '--count', `${baseBranch}..${branch}`]) || '0', 10); }
  catch (_) {}
  if (ahead === 0) return { ok: true, merged: false, committed, message: '没有新提交需要合并' };

  try {
    gitRun(dirPath, ['merge', '--no-ff', '-m', `multicc: merge ${branch}`, branch]);
    return { ok: true, merged: true, committed, commits: ahead };
  } catch (e) {
    let conflicts = [];
    let conflictDiff = '';
    let conflictDiffTruncated = false;
    try {
      conflicts = gitRun(dirPath, ['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean);
    } catch (_) {}
    if (conflicts.length > 0) {
      const maxDiff = 1024 * 1024;
      try {
        conflictDiff = execFileSync('git', ['diff', '--no-color', '--diff-filter=U'], {
          cwd: dirPath, encoding: 'utf8', maxBuffer: maxDiff + 16 * 1024,
        });
        if (conflictDiff.length > maxDiff) {
          conflictDiff = conflictDiff.slice(0, maxDiff);
          conflictDiffTruncated = true;
        }
      } catch (diffErr) {
        conflictDiffTruncated = diffErr.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
        conflictDiff = conflictDiffTruncated
          ? '(conflict diff exceeds 1MB cap — too large to display in browser)'
          : '';
      }
    }
    try { gitRun(dirPath, ['merge', '--abort']); } catch (_) {}
    if (conflicts.length > 0) {
      return {
        ok: false,
        conflicts,
        conflictDiff,
        conflictDiffTruncated,
        error: '合并冲突 — 已 abort，基分支未改动',
      };
    }
    const details = e.stderr ? String(e.stderr).trim() : e.message;
    return { ok: false, error: details || 'merge failed' };
  }
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
  gitWorktreeCommitAll,
  gitWorktreeMergeState,
  gitMergeBack,
};
