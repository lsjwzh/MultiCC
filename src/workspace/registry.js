'use strict';

const { createHash, randomUUID } = require('node:crypto');
const prefix = 'workspace:';
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 32);
const BACKPRESSURE = new Set([
  'workspace_busy',
  'workspace_execution_capacity',
  'workspace_restore_capacity',
  'workspace_resident_capacity',
]);
const fail = code => Object.assign(new Error(code), {
  code,
  status: 409,
  backpressure: BACKPRESSURE.has(code),
});
const ACTIVE = new Set(['reserved', 'materializing', 'starting', 'running', 'uncertain']);

// One SQLite transaction owns physical identity, capacity and the writer lease.
// Lease age never grants another writer access. Unknown launches remain pinned.
function createWorkspaceRegistry(store, { epoch = randomUUID(), executionLimit = 8, residentLimit = 128, restoreLimit = 2, now = Date.now } = {}) {
  for (const n of [executionLimit, residentLimit, restoreLimit]) if (!Number.isSafeInteger(n) || n < 1) throw new TypeError('positive workspace budgets required');
  const get = (kind, id) => store.get(prefix + kind, id);
  const put = (kind, id, value) => store.set(prefix + kind, id, value);
  const list = kind => store.list(prefix + kind);
  function register(input) {
    if (!input.ownerId || !input.dirId || !input.path || !input.branch) throw fail('workspace_identity_missing');
    const key = hash(input.path), id = 'ws_' + key;
    return store.transaction(() => {
      const previous = get('record', id);
      if (previous && (previous.dirId !== input.dirId || previous.branch !== input.branch)) throw fail('workspace_identity_conflict');
      // The id IS the worktree path, so an owner that legitimately moved to
      // another directory (relocate gives it a fresh worktree elsewhere)
      // computes a different id than the one it is bound to. Re-point the
      // binding then — otherwise the owner can never register again and every
      // later delivery is vetoed against a workspace nobody is writing to.
      // Re-pointing is allowed only when the move is provable (the bound
      // workspace belongs to a different directory) and nothing can be writing
      // to the one being left: a bound workspace holding an active lease is
      // exactly the abandonment this guard exists to refuse.
      const binding = get('binding', input.ownerId);
      if (binding && binding.workspaceId !== id) {
        const bound = get('record', binding.workspaceId);
        const lease = get('lease', binding.workspaceId);
        const moved = !!bound && bound.dirId !== input.dirId;
        const quiescent = !lease || !ACTIVE.has(lease.state);
        if (!moved || !quiescent) throw fail('workspace_binding_conflict');
      }
      const workspace = previous || { ...input, id, version: 1, pins: input.pins || [], createdAt: now(), residency: input.residency || 'planned' };
      if (!previous) put('record', id, workspace);
      put('binding', input.ownerId, { sessionId: input.ownerId, workspaceId: id });
      return workspace;
    });
  }
  function bind(sessionId, workspaceId) {
    return store.transaction(() => {
      if (!get('record', workspaceId)) throw fail('workspace_not_found');
      const old = get('binding', sessionId);
      if (old && old.workspaceId !== workspaceId) throw fail('workspace_binding_conflict');
      put('binding', sessionId, { sessionId, workspaceId });
    });
  }
  const leases = () => list('lease').filter(l => ACTIVE.has(l.state));
  function available(workspaceId) {
    const workspace = get('record', workspaceId);
    if (!workspace) return 'workspace_not_found';
    if (get('lease', workspaceId) && ACTIVE.has(get('lease', workspaceId).state)) return 'workspace_busy';
    if (leases().length >= executionLimit) return 'workspace_execution_capacity';
    if (workspace.residency !== 'resident') {
      const reserved = leases().filter(l => l.materializing).length;
      if (reserved >= restoreLimit) return 'workspace_restore_capacity';
      if (list('record').filter(w => ['resident', 'retained'].includes(w.residency)).length + reserved >= residentLimit) return 'workspace_resident_capacity';
    }
    return null;
  }
  function acquire(workspaceId, sessionId, requestId) {
    if (!requestId) throw fail('workspace_request_required');
    return store.transaction(() => {
      const key = hash(sessionId + '\0' + requestId), operation = get('operation', key);
      if (operation && operation.state !== 'released') throw fail('workspace_launch_unresolved');
      const code = available(workspaceId); if (code) throw fail(code);
      const workspace = get('record', workspaceId);
      const lease = { id: randomUUID(), workspaceId, sessionId, requestId, operationId: key, epoch,
        state: 'reserved', generation: (operation?.generation || 0) + 1, pid: null,
        materializing: workspace.residency !== 'resident', acquiredAt: now() };
      put('lease', workspaceId, lease); put('operation', key, lease);
      return lease;
    });
  }
  function transition(lease, state, fields = {}) {
    return store.transaction(() => {
      const current = get('lease', lease.workspaceId);
      if (!current || current.id !== lease.id || current.epoch !== epoch) throw fail('workspace_lease_stale');
      if (!ACTIVE.has(current.state)) throw fail('workspace_lease_released');
      const next = { ...current, ...fields, state, updatedAt: now() };
      put('lease', lease.workspaceId, next); put('operation', next.operationId, next);
      return next;
    });
  }
  function resident(lease, observed) {
    return store.transaction(() => {
      transition(lease, 'reserved', { materializing: false });
      const w = get('record', lease.workspaceId);
      if (!observed?.head || !observed.commonDir) throw fail('workspace_validation_required');
      const next = { ...w, ...observed, residency: 'resident', version: w.version + 1 };
      put('record', w.id, next); return next;
    });
  }
  function retain(lease, reason) {
    return store.transaction(() => {
      transition(lease, 'reserved', { materializing: false });
      const w = get('record', lease.workspaceId);
      put('record', w.id, { ...w, residency: 'retained', pins: [...new Set([...w.pins, reason])] });
    });
  }
  function release(lease, { stopped, reason = 'completed' } = {}) {
    if (stopped !== true) return transition(lease, 'uncertain', { reason: 'writer_stop_unverified' });
    return transition(lease, 'released', { reason, materializing: false });
  }
  function recover(observe) {
    return store.transaction(() => {
      for (const lease of leases()) {
        if (lease.epoch === epoch) continue;
        const stopped = observe(lease) === 'stopped';
        const next = { ...lease, epoch, state: stopped ? 'released' : 'uncertain',
          materializing: stopped ? false : lease.materializing, reason: stopped ? 'recovered_stopped' : 'launch_state_unknown' };
        put('lease', lease.workspaceId, next); put('operation', lease.operationId, next);
      }
    });
  }
  // 'resident' is a claim that the directory is on disk, and it is the claim
  // that spends the resident budget — so residency has to be able to go DOWN,
  // not only up. It could not: nothing demoted a record whose worktree went
  // away (a relocated session's old directory, a detached hibernation), so
  // every one of them kept spending budget for a directory that is gone and
  // the limit silently drifted. The host owns the filesystem, so it observes;
  // the store owns the change. Demotion discards nothing — the record keeps
  // the identity history and the directory keeps its files — and a pin does
  // not block it either: a pin keeps a *directory*, and residency only says
  // whether that directory is currently there. An active lease still refuses,
  // because a writer we cannot see may be inside it right now.
  function reclaim(observe) {
    return store.transaction(() => {
      const reclaimed = [];
      for (const record of list('record')) {
        if (record.residency !== 'resident') continue;
        const lease = get('lease', record.id);
        if (lease && ACTIVE.has(lease.state)) continue;
        if (observe(record) !== 'gone') continue;
        put('record', record.id, { ...record, residency: 'hibernated', version: record.version + 1, reclaimedAt: now() });
        reclaimed.push(record.id);
      }
      return reclaimed;
    });
  }
  return { register, bind, acquire, transition, resident, retain, release, recover, reclaim, available,
    workspace: id => get('record', id), binding: id => get('binding', id), lease: id => get('lease', id),
    snapshot: () => ({ workspaces: list('record'), leases: leases(), budgets: { executionLimit, residentLimit, restoreLimit } }), epoch };
}
module.exports = { createWorkspaceRegistry };
