'use strict';

const path = require('node:path');
const { createHash } = require('node:crypto');
const values = value => value instanceof Map ? [...value.values()]
  : Array.isArray(value) ? value : Object.values(value || {});
const absolute = value => typeof value === 'string' && path.isAbsolute(value) ? path.normalize(value) : null;
const distinct = items => [...new Set(items.filter(Boolean))].sort();

// A metadata-only import preview. Observations are supplied by an independent
// read-only probe, never inferred from a task's succeeded/done state. No result
// grants adoption, deletion or lease authority, even when all observations agree.
function inventoryWorkspaces({ sessions = [], directories = [], observations = {} } = {}) {
  const rows = values(sessions);
  const byId = new Map();
  const directoryIds = new Set(values(directories).map(d => d.id));
  const issues = [];
  for (const row of rows) {
    if (!row?.id || typeof row.id !== 'string') { issues.push({ code: 'session_id_missing' }); continue; }
    if (byId.has(row.id)) issues.push({ sessionId: row.id, code: 'session_id_duplicate' });
    else byId.set(row.id, row);
  }
  function resolve(row) {
    const seen = new Set();
    let owner = row;
    while (owner.workspaceOwnerSessionId) {
      if (seen.has(owner.id)) return { error: 'owner_cycle', owner: row };
      seen.add(owner.id);
      const next = byId.get(owner.workspaceOwnerSessionId);
      if (!next) return { error: 'owner_missing', owner: row };
      owner = next;
    }
    return { owner };
  }
  const groups = new Map();
  const unallocated = [];
  for (const row of byId.values()) {
    const { owner, error } = resolve(row);
    const reasons = [];
    if (error) reasons.push(error);
    if (row.retiredWorktrees?.length) reasons.push('retired_workspaces_uninspected');
    if (!directoryIds.has(row.dirId)) reasons.push('directory_missing');
    if (row.dirId !== owner.dirId) reasons.push('owner_directory_mismatch');
    const declared = row.worktreePath || owner.worktreePath;
    const declaredPath = absolute(declared);
    if (declared && !declaredPath) reasons.push('path_not_absolute');
    if (row.worktreePath && owner.worktreePath && absolute(row.worktreePath) !== absolute(owner.worktreePath)) {
      reasons.push('owner_path_mismatch');
    }
    if (!declaredPath) {
      unallocated.push({ sessionId: row.id, taskId: row.taskBoundTaskId || null, reasons,
        state: reasons.length || declared || row.branch || owner.branch ? 'unresolved' : 'no_declared_worktree' });
      for (const code of reasons) issues.push({ sessionId: row.id, code });
      continue;
    }
    const observed = Object.hasOwn(observations, declaredPath) ? observations[declaredPath] : null;
    const canonicalPath = absolute(observed?.canonicalPath) || declaredPath;
    let group = groups.get(canonicalPath);
    if (!group) {
      group = { candidateId: 'inventory-' + createHash('sha256').update(canonicalPath).digest('hex').slice(0,24),
        path: canonicalPath, sessionIds: [], taskIds: [], directoryIds: [], branches: [], repositories: [],
        declaredPaths: [], reasons: ['not_adopted', 'writers_unverified'], canAdopt: false, canReclaim: false };
      groups.set(canonicalPath, group);
    }
    group.sessionIds.push(row.id); group.taskIds.push(row.taskBoundTaskId);
    group.directoryIds.push(row.dirId); group.branches.push(row.branch, owner.branch, observed?.branch);
    group.declaredPaths.push(declaredPath);
    group.repositories.push(absolute(observed?.gitCommonDir));
    group.reasons.push(...reasons);
    if (!observed) group.reasons.push('filesystem_unverified');
    else {
      if (observed.exists !== true) group.reasons.push(observed.exists === false ? 'checkout_absent' : 'filesystem_unverified');
      if (!absolute(observed.canonicalPath) || !absolute(observed.gitCommonDir)) group.reasons.push('git_identity_unverified');
      if (observed.dirty !== false) group.reasons.push(observed.dirty === true ? 'dirty' : 'dirty_unknown');
      if (observed.gitOperation !== false) group.reasons.push('git_operation_or_unknown');
      if (observed.ignoredAccounted !== true) group.reasons.push('ignored_files_unaccounted');
    }
    if (row.isStreaming || row.running || row.hasProcess || row.kind === 'terminal'
      || ['P', 'B', 'W'].includes(row.taskState?.classifyState)) group.reasons.push('execution_dependency');
  }
  const workspaces = [...groups.values()].sort((a,b) => a.path.localeCompare(b.path));
  for (const group of workspaces) {
    for (const key of ['sessionIds','taskIds','directoryIds','branches','repositories','declaredPaths']) group[key] = distinct(group[key]);
    if (group.branches.length > 1) group.reasons.push('branch_conflict');
    if (group.repositories.length > 1) group.reasons.push('repository_conflict');
    if (group.directoryIds.length > 1) group.reasons.push('directory_conflict');
    if (group.repositories.length === 0) group.reasons.push('repository_unknown');
  }
  const branchPaths = new Map();
  for (const group of workspaces) for (const repo of group.repositories) for (const branch of group.branches) {
    const key = JSON.stringify([repo, branch]);
    const matches = branchPaths.get(key) || []; matches.push(group); branchPaths.set(key, matches);
  }
  for (const matches of branchPaths.values()) if (matches.length > 1) {
    for (const group of matches) group.reasons.push('branch_multiple_paths');
  }
  for (const group of workspaces) group.reasons = distinct(group.reasons);
  return { schemaVersion: 1, mode: 'read-only-preview', coverage: ['declared-session-workspaces'],
    counts: { sessions: byId.size, workspaces: workspaces.length, unallocated: unallocated.length, issues: issues.length },
    workspaces, unallocated, issues };
}

module.exports = { inventoryWorkspaces };
