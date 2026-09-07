'use strict';

const { runGit } = require('../../src/git/queue');

async function gitTry(cwd, args) {
  try { return (await runGit(cwd, args)).trim(); }
  catch (_) { return ''; }
}

async function refExists(cwd, ref) {
  try { await runGit(cwd, ['rev-parse', '--verify', ref]); return true; }
  catch (_) { return false; }
}

async function countRange(cwd, range) {
  const value = parseInt(await gitTry(cwd, ['rev-list', '--count', range]) || '0', 10);
  return Number.isFinite(value) ? value : 0;
}

async function computePushState(dirPath, requestedBranch) {
  if (await gitTry(dirPath, ['rev-parse', '--is-inside-work-tree']) !== 'true') {
    return { available: false, hasRemote: false, ahead: 0, behind: 0, dirty: 0, reason: 'not-a-git-repository' };
  }

  // Uncommitted files on the main working tree (dir.path). Surfaced on the
  // directory card so users commit/discard before merging session worktree
  // branches back into a dirty main — which would otherwise tangle the merge
  // with unrelated local edits. --porcelain is one git call; count its lines.
  const statusOut = await gitTry(dirPath, ['status', '--porcelain']);
  const dirty = statusOut ? statusOut.split('\n').filter(Boolean).length : 0;

  const branch = requestedBranch || await gitTry(dirPath, ['symbolic-ref', '--short', 'HEAD']);
  if (!branch || !(await refExists(dirPath, `refs/heads/${branch}`))) {
    return { available: false, hasRemote: false, ahead: 0, behind: 0, dirty, reason: 'no-branch' };
  }

  const remotes = (await gitTry(dirPath, ['remote'])).split('\n').filter(Boolean);
  if (remotes.length === 0) {
    return { available: true, hasRemote: false, branch, ahead: 0, behind: 0, dirty, reason: 'no-remote' };
  }

  const upstream = await gitTry(dirPath, [
    'for-each-ref',
    '--format=%(upstream:short)',
    `refs/heads/${branch}`,
  ]);
  const remote = upstream ? upstream.split('/')[0] : (remotes.includes('origin') ? 'origin' : remotes[0]);
  const remoteBranch = upstream ? upstream.slice(remote.length + 1) : branch;
  const remoteRef = upstream || `${remote}/${remoteBranch}`;
  const remoteBranchExists = await refExists(dirPath, remoteRef);
  const ahead = remoteBranchExists
    ? await countRange(dirPath, `${remoteRef}..${branch}`)
    : await countRange(dirPath, branch);
  const behind = remoteBranchExists ? await countRange(dirPath, `${branch}..${remoteRef}`) : 0;

  return {
    available: true,
    hasRemote: true,
    branch,
    remote,
    remoteBranch,
    upstream: upstream || null,
    upstreamConfigured: !!upstream,
    remoteBranchExists,
    ahead,
    behind,
    dirty,
  };
}

// ── Cache: push-state is read on every /api/directories poll (once per directory,
// per open client). Computing it fires ~8 git subprocesses, so without caching a
// page full of pollers forks git continuously. Strategy: serve a fresh value
// (< TTL) instantly; serve a stale value instantly while ONE background refresh
// runs (stale-while-revalidate); only block when there is nothing cached at all.
// In-flight de-duplication collapses N simultaneous cold misses into one compute.
const CACHE_TTL_MS = 10000;
const cache = new Map();      // key -> { value, ts }
const inflight = new Map();   // key -> Promise

function cacheKey(dirPath, branch) { return dirPath + '\0' + (branch || ''); }

function refresh(key, dirPath, requestedBranch) {
  let p = inflight.get(key);
  if (p) return p;
  p = computePushState(dirPath, requestedBranch)
    .then(value => { cache.set(key, { value, ts: Date.now() }); inflight.delete(key); return value; })
    .catch(err => { inflight.delete(key); throw err; });
  inflight.set(key, p);
  return p;
}

// Returns a Promise<pushState>. opts.force bypasses the cache and waits for a
// fresh compute (used by pushDirectory, which must act on accurate ahead/behind).
function directoryPushState(dirPath, requestedBranch, opts = {}) {
  const key = cacheKey(dirPath, requestedBranch);
  if (opts.force) return refresh(key, dirPath, requestedBranch);

  const hit = cache.get(key);
  const fresh = hit && (Date.now() - hit.ts < CACHE_TTL_MS);
  if (fresh) return Promise.resolve(hit.value);

  const p = refresh(key, dirPath, requestedBranch);
  if (hit) {
    // Stale value available — return it immediately, let the refresh finish in
    // the background. Swallow its rejection since nobody awaits it here.
    p.catch(() => {});
    return Promise.resolve(hit.value);
  }
  // Cold: nothing cached yet, must wait for the first compute.
  return p;
}

function invalidate(dirPath, requestedBranch) {
  cache.delete(cacheKey(dirPath, requestedBranch));
}

async function pushDirectory(dirPath, requestedBranch) {
  const before = await directoryPushState(dirPath, requestedBranch, { force: true });
  if (!before.available) throw new Error('当前目录没有可推送的分支');
  if (!before.hasRemote) throw new Error('未设置 remote');
  if (before.ahead === 0) return { pushed: false, before, after: before };

  const args = before.upstreamConfigured
    ? ['push', before.remote, `${before.branch}:${before.remoteBranch}`]
    : ['push', '--set-upstream', before.remote, before.branch];
  try {
    await runGit(dirPath, args);
  } catch (error) {
    const detail = String(error.stderr || error.message || '').trim();
    throw new Error(detail || 'git push failed');
  }

  return {
    pushed: true,
    before,
    after: await directoryPushState(dirPath, before.branch, { force: true }),
  };
}

module.exports = { directoryPushState, pushDirectory, invalidate };
