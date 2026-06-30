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
  let behind = 0;
  let baseCheckedOut = true;

  try {
    dirty = fs.existsSync(wtPath) && gitRun(wtPath, ['status', '--porcelain']).length > 0;
  } catch (_) {}
  try {
    // ahead = commits on the worktree branch not yet in base; behind = commits on
    // base not yet in the worktree branch (i.e. how stale this worktree is vs main).
    const counts = gitRun(dir.path, ['rev-list', '--left-right', '--count', `${baseBranch}...${session.branch}`]);
    const m = counts.split(/\s+/);
    behind = parseInt(m[0] || '0', 10);   // base has, branch lacks
    ahead = parseInt(m[1] || '0', 10);    // branch has, base lacks
  } catch (_) {}
  try {
    baseCheckedOut = gitBaseBranch(dir.path) === baseBranch;
  } catch (_) {}

  // mergeReady requires combined with the ability to actually merge.
  // If base is not checked out in the main dir no merge can succeed despite
  // dirty or ahead changes; gate it so the UI indicator is truthful.
  const canMerge = dirty || ahead > 0;
  return {
    mergeReady: canMerge && baseCheckedOut,
    dirty,
    ahead,
    behind,
    baseBranch,
    branch: session.branch,
    baseCheckedOut,
  };
}

// Syntax gate for merges. Every JS file changed by a merge must parse with
// `node --check`; otherwise a session that commits a broken server.js (missing
// paren, duplicate declaration, …) would silently crash multicc on its next
// restart — and the base branch is exactly what multicc runs from. Returns a
// (possibly empty) list of { file, error }. JS-only by design; non-JS changes
// and non-Node projects pass through untouched. A tooling failure (can't list
// diff / file vanished) never blocks a merge — only a real parse error does.
function checkMergedJsSyntax(dirPath, fromRef, toRef) {
  let changed = [];
  try {
    changed = gitRun(dirPath, ['diff', '--name-only', '--diff-filter=ACMR', fromRef, toRef])
      .split('\n').map(s => s.trim()).filter(Boolean)
      .filter(f => /\.(c|m)?js$/.test(f) && !f.includes('node_modules/') && !f.includes(WORKTREE_SUBDIR + '/'));
  } catch (_) { return []; }
  const errors = [];
  for (const rel of changed) {
    const abs = path.join(dirPath, rel);
    if (!fs.existsSync(abs)) continue;          // deleted/renamed-away — nothing to parse
    try {
      execFileSync(process.execPath, ['--check', abs], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      const out = (e.stderr ? String(e.stderr) : e.message || '');
      const line = out.split('\n').map(l => l.trim()).find(l => /SyntaxError|Error:/.test(l)) || 'parse failed';
      errors.push({ file: rel, error: line });
    }
  }
  return errors;
}

// Commit pending work in the worktree, then merge its branch into the base branch.
// ⚠️ Validation runs FIRST so a failing precondition (wrong base checked out, etc.)
// never leaves orphaned commits on the worktree branch with no path to merge.
function gitMergeBack(dir, session) {
  const dirPath = dir.path;
  const branch = session.branch;
  const baseBranch = dir.baseBranch || gitBaseBranch(dirPath);
  const wtPath = session.worktreePath;
  if (!branch || !wtPath) return { ok: false, error: 'session has no worktree' };

  // ── Phase 1: validate preconditions (no side effects yet) ──
  const curBranch = gitBaseBranch(dirPath);
  if (curBranch !== baseBranch) {
    return { ok: false, error:
      `base branch '${baseBranch}' is not checked out in the main directory (currently on '${curBranch}'); merge manually` };
  }

  // ── Phase 2: commit local work into the session branch ──
  let committed = false;
  if (fs.existsSync(wtPath)) {
    try {
      committed = gitWorktreeCommitAll(wtPath,
        `multicc: session ${session.id} @ ${new Date().toISOString()}`);
    } catch (e) {
      return { ok: false, error: `commit failed: ${e.message}` };
    }
  }

  // ── Phase 3: count ahead; early exit if nothing to merge ──
  let ahead = 0;
  try { ahead = parseInt(gitRun(dirPath, ['rev-list', '--count', `${baseBranch}..${branch}`]) || '0', 10); }
  catch (_) {}
  if (ahead === 0) return { ok: true, merged: false, committed, message: '没有新提交需要合并' };

  // ── Phase 4: merge & validate ──
  let preMergeHead = '';
  try { preMergeHead = gitRun(dirPath, ['rev-parse', 'HEAD']); } catch (_) {}

  try {
    gitRun(dirPath, ['merge', '--no-ff', '-m', `multicc: merge ${branch}`, branch]);

    // Syntax gate: a session that committed code that won't parse must not land
    // on base (which multicc itself runs from). If anything is broken, undo the
    // merge so base stays exactly as it was, and report back to the author.
    const syntaxErrors = preMergeHead ? checkMergedJsSyntax(dirPath, preMergeHead, 'HEAD') : [];
    if (syntaxErrors.length > 0) {
      try { gitRun(dirPath, ['reset', '--hard', preMergeHead]); } catch (_) {}
      return {
        ok: false,
        syntaxErrors,
        error: `合并被拒绝：${syntaxErrors.length} 个文件语法错误，base 分支未改动。请在 worktree 修好再合并：\n` +
          syntaxErrors.map(e => `  · ${e.file}: ${e.error}`).join('\n'),
      };
    }
    // Merge succeeded. The base now has a merge commit the worktree branch lacks,
    // so the session would immediately show as "behind base" and require a manual
    // sync click. Auto-pull it back so the worktree stays in lock-step with base.
    // The worktree branch is a strict ancestor of the new merge commit, so this is
    // always a conflict-free fast-forward; treat any failure as non-fatal.
    let syncedBack = false;
    try {
      const s = gitSyncFromBase(dir, session);
      syncedBack = !!(s && s.ok && s.merged);
    } catch (_) {}
    return { ok: true, merged: true, committed, commits: ahead, syncedBack };
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

// Pull the base branch INTO the session's worktree branch (the inverse of
// gitMergeBack): brings a stale worktree up to date with main. Runs entirely
// inside the worktree, so it does NOT require base to be checked out in the main
// dir. Auto-commits dirty changes first so nothing is lost and a dirty tree
// doesn't block the merge. On conflict it aborts and leaves the worktree clean.
function gitSyncFromBase(dir, session) {
  const dirPath = dir.path;
  const branch = session.branch;
  const baseBranch = dir.baseBranch || gitBaseBranch(dirPath);
  const wtPath = session.worktreePath;
  if (!branch || !wtPath || !fs.existsSync(wtPath)) {
    return { ok: false, error: 'session has no worktree' };
  }

  // Stash-free safety: commit any uncommitted work first.
  let committed = false;
  try {
    committed = gitWorktreeCommitAll(wtPath,
      `multicc: auto-commit before sync @ ${new Date().toISOString()}`);
  } catch (e) {
    return { ok: false, error: `commit failed: ${e.message}` };
  }

  // How many commits is the worktree behind base?
  let behind = 0;
  try { behind = parseInt(gitRun(dirPath, ['rev-list', '--count', `${branch}..${baseBranch}`]) || '0', 10); }
  catch (_) {}
  if (behind === 0) return { ok: true, merged: false, committed, message: '已是最新，无需同步' };

  try {
    gitRun(wtPath, ['-c', 'user.email=multicc@local', '-c', 'user.name=multicc',
      'merge', '--no-edit', baseBranch]);
    return { ok: true, merged: true, committed, commits: behind, baseBranch };
  } catch (e) {
    let conflicts = [];
    try {
      conflicts = gitRun(wtPath, ['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean);
    } catch (_) {}
    try { gitRun(wtPath, ['merge', '--abort']); } catch (_) {}
    if (conflicts.length > 0) {
      return {
        ok: false,
        conflicts,
        error: `与 ${baseBranch} 存在冲突（${conflicts.length} 个文件）— 已 abort，worktree 未改动，请手动同步`,
      };
    }
    const details = e.stderr ? String(e.stderr).trim() : e.message;
    return { ok: false, error: details || 'sync failed' };
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
  gitSyncFromBase,
};
