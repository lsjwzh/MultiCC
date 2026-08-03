'use strict';

// One-way migration of pre-existing project memos onto the memory store.
//
// Legacy layout wrote `<project>/multicc.memo.md`. Nothing in multicc ever
// added that name to the project's own .gitignore, so in a repository without
// one the file sits in `git status --porcelain` forever — and src/git.js treats
// any non-empty porcelain output on the base worktree as `base-dirty` and
// blocks the merge. A scratch note could therefore strand a session's work.
//
// Deleting the legacy file is only safe when git does not track it. Removing a
// tracked file turns a clean repository dirty, which is precisely the failure
// being fixed, so tracked leftovers are reported and left in place for the user
// to remove and commit themselves.

const { execFile } = require('child_process');
const path = require('path');

const { MEMO_FILENAME, LEGACY_PROJECT_MEMO_FILENAME } = require('./controller');

// 'tracked' | 'untracked' | 'unknown'. Anything we cannot positively classify
// is 'unknown', and 'unknown' never deletes. Async because production request
// paths may not block on a child process.
function createGitTrackPort({ run } = {}) {
  const exec = run || ((dirPath, relPath) => new Promise((resolve) => {
    execFile(
      'git', ['-C', dirPath, 'ls-files', '--', relPath],
      { encoding: 'utf8', timeout: 10000 },
      (error, stdout, stderr) => resolve({ error, stdout, stderr }),
    );
  }));
  return Object.freeze({
    async isTracked(dirPath, relPath) {
      let result;
      try { result = await exec(dirPath, relPath); } catch (_) { return 'unknown'; }
      if (!result) return 'unknown';
      if (!result.error) return String(result.stdout || '').trim() ? 'tracked' : 'untracked';
      // A plain (non-git) folder has nothing to track; deleting there is safe.
      if (/not a git repository/i.test(String(result.stderr || ''))) return 'untracked';
      return 'unknown';
    },
  });
}

// Copies run synchronously (before the first await) so a memo read immediately
// after boot already sees the migrated content; only the git-tracked check and
// the delete are deferred.
function migrateProjectMemos({
  directories = [],
  files,
  memoRoot,
  git = createGitTrackPort(),
  pathPort = path,
  log = () => {},
} = {}) {
  const report = {
    found: 0, moved: 0, alreadyStored: 0, removed: 0,
    keptTracked: [], conflicts: [], failed: [],
  };
  const pending = [];
  if (!files || !memoRoot) return { report, done: Promise.resolve(report) };

  for (const value of directories) {
    const dirPath = value && value.path;
    const id = value && value.id;
    if (!dirPath || !id) continue;
    const legacy = pathPort.join(dirPath, LEGACY_PROJECT_MEMO_FILENAME);
    let present = false;
    try { present = files.exists(legacy); } catch (_) { present = false; }
    if (!present) continue;
    report.found++;
    try {
      const legacyText = files.readText(legacy);
      const targetDir = pathPort.join(memoRoot, String(id));
      const target = pathPort.join(targetDir, MEMO_FILENAME);
      if (files.exists(target)) {
        // Both sides have content. Silently picking one would lose a memo, so
        // keep the legacy file and let the user reconcile.
        if (files.readText(target) !== legacyText) {
          report.conflicts.push({ id, legacy, target });
          log(`[memo] conflict: ${legacy} differs from ${target}; legacy file kept, reconcile manually`);
          continue;
        }
        report.alreadyStored++;
      } else {
        files.ensureDir(targetDir);
        files.writeAtomic(target, legacyText);
        report.moved++;
      }
      pending.push({ id, dirPath, legacy, target });
    } catch (error) {
      report.failed.push({ id, legacy, error: describe(error) });
      log(`[memo] migration failed for ${legacy}: ${describe(error)}`);
    }
  }

  const done = (async () => {
    for (const entry of pending) {
      try {
        const tracked = await git.isTracked(entry.dirPath, LEGACY_PROJECT_MEMO_FILENAME);
        if (tracked === 'untracked') {
          files.remove(entry.legacy);
          report.removed++;
        } else {
          report.keptTracked.push({ id: entry.id, legacy: entry.legacy, tracked });
          log(`[memo] ${entry.legacy} is ${tracked} in git; content copied to ${entry.target}, `
            + 'legacy file left in place');
        }
      } catch (error) {
        report.failed.push({ id: entry.id, legacy: entry.legacy, error: describe(error) });
        log(`[memo] migration failed for ${entry.legacy}: ${describe(error)}`);
      }
    }
    if (report.found) {
      log(`[memo] legacy project memos: ${report.found} found, ${report.moved} copied to the memory store, `
        + `${report.alreadyStored} already stored, ${report.removed} removed from project trees, `
        + `${report.keptTracked.length} kept (git-tracked), ${report.conflicts.length} conflicts, `
        + `${report.failed.length} failed`);
    }
    return report;
  })();

  return { report, done };
}

function describe(error) {
  return error && error.message ? error.message : String(error);
}

module.exports = { createGitTrackPort, migrateProjectMemos };
