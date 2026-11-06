'use strict';

// Migration bridge only. The worktree-add repository lease stays held while
// Rust checks the checkout, preserves its tip, and synchronizes local refs.
// The existing hibernation host still calls Node ports; remove this adapter
// when that lifecycle and its repository actor move to Rust.
const { getNative } = require('../native/runtime');

async function syncWorktreeOnWake(dirPath, worktree, baseBranch) {
  try {
    const native = getNative();
    if (typeof native.syncWorktreeOnWake !== 'function') {
      return { ok: false, code: 'wake_sync_unavailable' };
    }
    return JSON.parse(await native.syncWorktreeOnWake(dirPath, worktree.worktreePath,
      worktree.branch, baseBranch || undefined));
  } catch (_) {
    return { ok: false, code: 'wake_sync_failed' };
  }
}

module.exports = { syncWorktreeOnWake };
