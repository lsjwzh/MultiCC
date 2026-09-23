'use strict';

const { gitWorktreeSplitOff } = require('../git/service');

// Task separation moves the source conversation's live checkout into the new
// task (see gitWorktreeSplitOff for the Git side of the move). This module owns
// the record side of it: the target session stops being “planned” and names the
// checkout it now owns, and the source session becomes “hibernated” with its
// branch kept — so the next message rebuilds that checkout from scratch instead
// of two tasks writing the same directory.
function createSeparationTransfer({ records, directories, persistence, splitOff = gitWorktreeSplitOff, now = Date.now, log = console } = {}) {
  return async function transferSeparationWorkspace({ sourceSessionId, targetSessionId, baseCommit = null } = {}) {
    const source = records.get(sourceSessionId), target = records.get(targetSessionId);
    const dir = source && directories.get(source.dirId);
    if (!source || !target || !dir || target.dirId !== source.dirId) {
      return { ok: false, code: 'workspace_transfer_identity_missing', error: 'source and target session must share one directory' };
    }
    if (!source.worktreePath || !source.branch) {
      return { ok: false, code: 'workspace_transfer_source_missing', error: 'the source session has no checkout to move' };
    }
    const result = await splitOff(dir.path, {
      sessionId: source.id,
      baseCommit,
      source: { worktreePath: source.worktreePath, branch: source.branch },
      target: { sessionId: target.id, worktreePath: target.worktreePath, branch: target.branch },
    });
    if (!result.ok) return result;
    if (result.sourceRetained) {
      log.warn?.('workspace_separation_source_retained', {
        sourceSessionId, targetSessionId, reason: result.sourceRetained.reason, count: result.sourceRetained.count,
      });
    }
    const at = new Date(now()).toISOString();
    persistence.mutate('workspace.separation-transfer', map => {
      const moved = map.get(target.id);
      if (moved) {
        Object.assign(moved, { workspaceState: 'awake', worktreePath: result.worktreePath, branch: result.branch,
          hibernatedAt: null, workspaceStateErrorCode: null, lastWorkAt: at });
      }
      if (!result.sourceRemoved) return;
      const origin = map.get(source.id);
      // The source keeps branch + worktreePath: those are exactly what the next
      // message needs to rebuild the checkout it just gave away.
      if (origin) Object.assign(origin, { workspaceState: 'hibernated', hibernatedAt: at, workspaceStateErrorCode: null });
    });
    return { ok: true, worktreePath: result.worktreePath, branch: result.branch,
      ...(result.carried ? { carried: result.carried } : {}),
      ...(result.sourceRetained ? { sourceRetained: result.sourceRetained } : {}) };
  };
}

module.exports = { createSeparationTransfer };
