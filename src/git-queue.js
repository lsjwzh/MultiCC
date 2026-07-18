'use strict';

// Back-compatible facade over the per-repository actor. Commands in worktrees
// belonging to the same repository are serialized; unrelated repositories run
// concurrently. High-level transactions in src/git.js use the actor directly
// so their multi-command critical sections cannot interleave.
const { defaultRepoActor } = require('./repo-actor');

function runGit(cwd, args, opts = {}) {
  return defaultRepoActor.runGit(cwd, args, opts);
}

function queueDepth(cwd) { return defaultRepoActor.queueDepth(cwd); }

function operationStatus(operationId) { return defaultRepoActor.status(operationId); }

// ── Tiny synchronous TTL memo, with per-key jitter so a batch of entries
// populated in the same tick don't all expire on the same future tick (which
// would make one unlucky poll pay the full recompute cost). Used to wrap
// synchronous git helpers (e.g. worktree merge-state) that are called once per
// item across large lists on every poll.
function makeTtlCache(baseTtlMs, jitterMs = 0) {
  const store = new Map();   // key -> { value, expiry }
  return {
    // compute() is only called on a miss; its result is cached until expiry.
    get(key, compute) {
      const now = Date.now();
      const hit = store.get(key);
      if (hit && hit.expiry > now) return hit.value;
      const value = compute();
      const ttl = baseTtlMs + (jitterMs ? Math.floor(Math.random() * jitterMs) : 0);
      store.set(key, { value, expiry: now + ttl });
      return value;
    },
    set(key, value) {
      const ttl = baseTtlMs + (jitterMs ? Math.floor(Math.random() * jitterMs) : 0);
      store.set(key, { value, expiry: Date.now() + ttl });
    },
    delete(key) { store.delete(key); },
    clear() { store.clear(); },
  };
}

module.exports = { runGit, queueDepth, operationStatus, makeTtlCache };
