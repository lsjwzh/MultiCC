'use strict';

// Orphan worktree reconciliation: cross-checks `git worktree list` against
// every session's declared (and retired) worktree paths plus the task ledger.
// Anything on disk under <dir>/.multicc-worktrees that nobody claims is an
// orphan — typically left behind by invalid sessions, deleted directories or
// crashed cleanups. Report-only by default; deletion is opt-in and limited
// to orphans that are clean AND fully merged into the directory base branch
// (no uncommitted or unmerged work can ever be removed by this scanner).

const path = require('node:path');
const fs = require('node:fs');

const DAY_MS = 24 * 60 * 60 * 1000;

// git reports realpaths (/private/var/… on macOS) while session records may
// carry the symlinked spelling — both sides must canonicalize the same way
// before comparison or every claimed worktree looks like an orphan.
function canon(value) {
  try { return fs.realpathSync(value); } catch (_) { return path.normalize(value); }
}

function parseWorktreeList(porcelain) {
  const entries = [];
  let current = null;
  for (const line of String(porcelain || '').split('\n')) {
    if (line.startsWith('worktree ')) { current = { path: line.slice(9).trim(), branch: null, detached: false }; entries.push(current); }
    else if (current && line.startsWith('branch ')) current.branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
    else if (current && line.trim() === 'detached') current.detached = true;
  }
  return entries;
}

function createWorktreeOrphanScanner(deps = {}) {
  const {
    records, directories, repoActor, logger = console, now = Date.now,
    deleteOrphans = false, setTimeoutFn = setTimeout, setIntervalFn = setInterval,
    startupDelayMs = 45_000, intervalMs = DAY_MS, listTaskWorktreePaths = () => [],
  } = deps;
  if (!(records instanceof Map) || !(directories instanceof Map)) throw new TypeError('orphan scan requires record and directory maps');
  if (!repoActor || typeof repoActor.run !== 'function') throw new TypeError('orphan scan requires a repo actor');
  let lastReport = null;
  let running = null;
  let stopped = false;
  const timers = [];

  function declaredPaths() {
    const claimed = new Set();
    for (const record of records.values()) {
      if (record?.worktreePath) claimed.add(canon(record.worktreePath));
      for (const retired of record?.retiredWorktrees || []) {
        if (retired?.worktreePath) claimed.add(canon(retired.worktreePath));
      }
    }
    for (const claimedPath of listTaskWorktreePaths() || []) {
      if (claimedPath) claimed.add(canon(claimedPath));
    }
    return claimed;
  }

  async function scanDirectory(dir, claimed) {
    const root = path.join(canon(dir.path), '.multicc-worktrees');
    return repoActor.run(dir.path, 'worktree-orphan-scan', async ({ execGit }) => {
      const out = await execGit(dir.path, ['worktree', 'list', '--porcelain']);
      const rows = [];
      for (const entry of parseWorktreeList(out)) {
        if (!entry.path.startsWith(root + path.sep)) continue;
        if (claimed.has(canon(entry.path))) continue;
        const ahead = Number(await execGit(entry.path, ['rev-list', '--count', `${dir.baseBranch || 'main'}..HEAD`]).catch(() => '0')) || 0;
        const dirty = !!(await execGit(entry.path, ['status', '--porcelain']).catch(() => ''));
        rows.push({ dirId: dir.id, path: entry.path, branch: entry.branch, ahead, dirty, removed: false });
      }
      return rows;
    });
  }

  async function scan() {
    if (running) return running;
    running = (async () => {
      const claimed = declaredPaths();
      const orphans = [];
      for (const dir of directories.values()) {
        if (!dir?.path) continue;
        try { orphans.push(...await scanDirectory(dir, claimed)); }
        catch (error) { logger.warn?.('worktree_orphan_scan_failed', { dirId: dir.id, code: error?.code || 'scan_failed' }); }
      }
      if (deleteOrphans) {
        for (const orphan of orphans) {
          if (orphan.dirty || orphan.ahead > 0) continue;
          const dir = directories.get(orphan.dirId);
          if (!dir) continue;
          try {
            await repoActor.run(dir.path, 'worktree-orphan-remove', async ({ execGit }) => {
              await execGit(dir.path, ['worktree', 'remove', orphan.path]);
              await execGit(dir.path, ['worktree', 'prune']).catch(() => '');
            });
            orphan.removed = true;
          } catch (error) { orphan.removeError = error?.code || 'remove_failed'; }
        }
      }
      lastReport = Object.freeze({
        at: new Date(now()).toISOString(), deleteOrphans, total: orphans.length,
        removed: orphans.filter(o => o.removed).length, orphans,
      });
      if (orphans.length) {
        logger.warn?.('worktree_orphans_found', { count: orphans.length, removed: lastReport.removed });
      }
      return lastReport;
    })().finally(() => { running = null; });
    return running;
  }

  function start() {
    if (stopped || timers.length) return false;
    timers.push(setTimeoutFn(() => { scan().catch(() => {}); }, startupDelayMs));
    timers.push(setIntervalFn(() => { scan().catch(() => {}); }, intervalMs));
    for (const timer of timers) timer?.unref?.();
    return true;
  }

  function stop() { stopped = true; for (const timer of timers) clearTimeout(timer); timers.length = 0; }

  return Object.freeze({ scan, start, stop, report: () => lastReport });
}

module.exports = { createWorktreeOrphanScanner, parseWorktreeList };
