'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const { createTaskShellStore } = require('../task-shell/store');
const { createWorkspaceRegistry } = require('./registry');
const { WORKTREE_SUBDIR } = require('../git/service');
const { captureCodeRevision } = require('../task-routing/code-revision');
const BACKPRESSURE_CODES = new Set([
  'workspace_busy',
  'workspace_lease_unavailable',
]);
const failure = code => Object.assign(new Error(code), {
  code,
  status: 409,
  // Capacity/contention can heal without changing the request and therefore
  // must not consume its delivery budget. Identity/materialization failures
  // use the bounded outbox retry path instead of cycling forever in FIFO.
  backpressure: BACKPRESSURE_CODES.has(code),
});
const processAlive = proc => !!proc && proc.exitCode == null && proc.signalCode == null;

const DEFAULT_STALE_UNCERTAIN_MS = 5 * 60 * 1000;

function createWorkspaceAdmission(deps) {
  const store = createTaskShellStore(deps.file);
  const registry = createWorkspaceRegistry(store, deps.budgets);
  const evidence = require('../task-routing/evidence').createDeliveryEvidence(store, {
    onIntegrationPublished: deps.onIntegrationPublished,
  });
  const permits = new WeakSet(), active = new Map();
  let closed = false;
  const settleTimer = setInterval(() => {
    for (const [id, permit] of active) if (permit.terminal) void drain(id, permit);
    reapStaleUncertainLeases();
  }, 1000);
  settleTimer.unref();
  const applicable = record => record?.kind === 'chat' && !['aux', 'gateway'].includes(record.type) && !record.taskExecutionSlot && !record.experimentalMode;
  function owner(id) {
    const seen = new Set(); let record = deps.records.get(id);
    while (record?.workspaceOwnerSessionId) {
      if (seen.has(record.id)) throw failure('workspace_owner_cycle');
      seen.add(record.id); record = deps.records.get(record.workspaceOwnerSessionId);
    }
    if (!record) throw failure('workspace_owner_missing');
    return record;
  }
  function identify(id) {
    const record = deps.records.get(id);
    if (!applicable(record)) return null;
    const source = owner(id), dir = deps.directories.get(source.dirId);
    if (!dir) throw failure('workspace_directory_missing');
    const canonicalRoot = fs.realpathSync(dir.path);
    const declared = source.worktreePath || path.join(canonicalRoot, WORKTREE_SUBDIR || '.multicc-worktrees', source.id);
    let parent = path.resolve(declared); const tail = [];
    while (!fs.existsSync(parent)) { tail.unshift(path.basename(parent)); const next = path.dirname(parent); if (next === parent) throw failure('workspace_path_unresolved'); parent = next; }
    const location = path.join(fs.realpathSync(parent), ...tail);
    const workspace = registry.register({ ownerId: source.id, dirId: dir.id, path: location,
      branch: source.branch || `multicc/${source.id}`, baseRef: dir.baseBranch,
      residency: source.workspaceState === 'planned' ? 'planned' : fs.existsSync(location) ? 'resident' : 'hibernated',
      // Legacy/external writers are not proven quiescent. This pin prohibits
      // automatic reclamation; it does not discard existing working files.
      pins: source.workspaceState === 'planned' ? [] : ['legacy_resident_retained'] });
    registry.bind(id, workspace.id);
    return workspace;
  }
  function isLive(id) {
    const state = deps.getState(id);
    return !!(state?.isStreaming || processAlive(state?.claudeProc) || processAlive(state?._cancelledProc)
      || state?._activeRunner || deps.hasBackground(id) || deps.streamBusy(id));
  }
  function occupied(id) {
    for (const [sid, permit] of active) if (permit.terminal) void drain(sid, permit);
    // Not being able to identify a workspace is not the same answer as a
    // workspace that is busy. Collapsing every failure into `true` reported an
    // identity failure under the same word as a running writer, and — because
    // no lease exists to reap — it wedged the session's delivery permanently
    // under a reason that read as normal occupancy. The caller still fails
    // closed (it vetoes on any reason), but it now names the real code.
    const workspace = identify(id);
    if (!workspace) return false;
    const source = owner(id);
    for (const record of deps.records.values()) {
      if (record.id === id || !applicable(record)) continue;
      if ((record.workspaceOwnerSessionId || record.id) === source.id && isLive(record.id)) return true;
    }
    return !!registry.available(workspace.id);
  }
  async function materialize(id, lease) {
    const source = owner(id), dir = deps.directories.get(source.dirId);
    if (source.workspaceState === 'planned') {
      registry.transition(lease, 'materializing');
      const ready = await deps.ensureDir(dir);
      if (!ready.ok) throw failure('workspace_repository_not_ready');
      // gitWorktreeAdd resumes the same branch/path after an interrupted create;
      // it never rotates a fixed slot or overwrites another task's directory.
      const result = await deps.addWorktree(dir.path, source.id, source.workspaceBaseCommit || dir.baseBranch);
      deps.persistence.mutate('workspace.materialize', records => {
        const current = records.get(source.id);
        Object.assign(current, result, { workspaceState: 'awake', workspaceId: lease.workspaceId });
      });
    } else {
      const awake = await deps.hibernation().ensureAwake(source.id);
      if (!awake.ok) throw failure(awake.code || 'workspace_restore_failed');
    }
    const current = owner(id);
    const valid = await deps.validate(dir.path, current.worktreePath, current.branch, { sessionId: current.id });
    // A detached or wrong-branch checkout commonly means the session is in the
    // middle of resolving a merge/rebase. The configured owner path still
    // exists, so keep the conversation running in place and let the agent
    // finish or re-register the Git checkout. A physically missing path still
    // fails closed.
    const usableDegradedWorktree = valid.pathExists
      && ['WORKTREE_BRANCH_MISMATCH', 'WORKTREE_NOT_REGISTERED'].includes(valid.code);
    if (!valid.ok && !usableDegradedWorktree) throw failure('workspace_materialization_unverified');
    if (usableDegradedWorktree) {
      deps.log('workspace_git_state_degraded_continuing', {
        sessionId: id,
        ownerId: current.id,
        code: valid.code,
      });
    }
    const git = args => exec('git', args, { cwd: current.worktreePath, timeout: 15000 }).then(r => r.stdout.trim());
    const [head, common] = await Promise.all([git(['rev-parse', 'HEAD']), git(['rev-parse', '--git-common-dir'])]);
    registry.resident(lease, { head, commonDir: fs.realpathSync(path.resolve(current.worktreePath, common)) });
    deps.updateCwd(id, current.worktreePath);
    return current;
  }
  async function beforeDeliver(descriptor) {
    const workspace = identify(descriptor.sessionId);
    if (!workspace) return null;
    const source = owner(descriptor.sessionId);
    for (const record of deps.records.values()) if (record.id !== descriptor.sessionId
      && (record.workspaceOwnerSessionId || record.id) === source.id && isLive(record.id)) throw failure('workspace_busy');
    const lease = registry.acquire(workspace.id, descriptor.sessionId, descriptor.item.id);
    const permit = { lease, sessionId: descriptor.sessionId, deliveryId: descriptor.item.id };
    permits.add(permit); active.set(descriptor.sessionId, permit);
    try {
      await materialize(descriptor.sessionId, lease);
      try { permit.startCode = await captureCodeRevision(workspace.path); }
      catch (error) { permit.startObservationError = /^code_[a-z_]+$/.test(error.message) ? error.message : 'code_observation_failed'; }
      await require('../task-shell/role-bindings').prepareRoleContext(store, descriptor, deps);
      descriptor.opts.workspacePermit = permit;
      return { complete(outcome) {
        if (outcome.accepted && registry.lease(workspace.id)?.state !== 'reserved') {
          if (registry.lease(workspace.id)?.state === 'starting') registry.transition(lease, 'running');
          return;
        }
        // A launched writer is retained on response loss. Only known pre-launch
        // rejection can release the claim for a transport retry.
        const current = registry.lease(workspace.id);
        if (current?.state === 'reserved' || current?.state === 'materializing') {
          registry.release(lease, { stopped: true, reason: 'prelaunch_rejected' });
          if (active.get(descriptor.sessionId) === permit) active.delete(descriptor.sessionId);
        } else if (current && current.state !== 'released') registry.transition(lease, 'uncertain');
      } };
    } catch (error) {
      if (fs.existsSync(workspace.path)) registry.retain(lease, 'materialization_failed');
      registry.release(lease, { stopped: true, reason: 'materialization_failed' });
      active.delete(descriptor.sessionId); throw error;
    }
  }
  function assertPermit(id, opts = {}) {
    if (!applicable(deps.records.get(id))) return;
    const permit = opts?.workspacePermit;
    if (!permits.has(permit) || permit.sessionId !== id || permit.deliveryId !== opts.deliveryId
      || registry.lease(permit.lease.workspaceId)?.id !== permit.lease.id) throw failure('workspace_admission_required');
    const lease = registry.lease(permit.lease.workspaceId);
    if (!['reserved', 'starting', 'running'].includes(lease.state)) throw failure('workspace_lease_unavailable');
  }
  function starting(id, opts, attemptId) {
    assertPermit(id, opts); const permit = active.get(id);
    if (permit) {
      if (attemptId && permit.evidenceBound) evidence.attempt(permit.turnId, attemptId);
      permit.attemptId = attemptId || null;
      registry.transition(permit.lease, 'starting');
    }
  }
  function spawned(id, proc) {
    const permit = active.get(id); if (permit) registry.transition(permit.lease, 'running', { pid: proc?.pid || null });
  }
  function bindTurn(id, opts, turnId, taskId) {
    assertPermit(id, opts); const permit = active.get(id);
    if (permit) {
      permit.turnId = turnId;
      if (taskId) {
        const w = registry.workspace(permit.lease.workspaceId), source = owner(id);
        evidence.begin({ sessionId: id, turnId, taskId, receiptId: opts.taskShellReceiptId || null, roleSnapshotId: opts.taskRoleSnapshotId || null,
          workspaceId: w.id, workspacePath: w.path, baseRef: w.baseRef || deps.directories.get(source.dirId).baseBranch || 'main',
          startCodeRevision: permit.startCode?.revision || null, startHead: permit.startCode?.head || null,
          startDirty: permit.startCode?.dirty ?? null, startObservationError: permit.startObservationError || null });
        permit.evidenceBound = true;
      }
    }
  }
  function finalized(context, resolved) {
    const permit = active.get(context.sessionName);
    if (!permit?.evidenceBound || permit.turnId !== context.turn?.turnId || permit.evidencePending) return;
    const succeeded = !context.terminalBlocked && resolved.effects.some(e => e.type === 'classify-turn-end' && e.classification === 'succeeded');
    const pending = deps.pendingInput?.(context.sessionName);
    const outcome = pending ? 'waiting' : succeeded ? 'succeeded'
      : ['user_cancel', 'new_user_message'].includes(resolved.facts.killReason) || resolved.facts.completion?.state === 'cancelled' ? 'cancelled'
        : resolved.facts.completion?.state === 'failed' || resolved.facts.apiError || resolved.facts.adapterError ? 'failed' : 'unknown';
    permit.evidencePending = evidence.finalize(permit.turnId, { attemptId: context.runner.providerAttempt?.routeAttemptId,
      outcome, pendingInput: !!pending, resultDurable: context.turn.resultDurable === true, usageDurable: context.usageDurable === true })
      .catch(error => deps.log('delivery_evidence_failed', { sessionId: context.sessionName, code: error.code || 'evidence_write_failed' }))
      .finally(() => { permit.evidencePending = null; void drain(context.sessionName, permit); });
  }
  function optionsForTurn(id, turn) {
    const permit = active.get(id);
    if (applicable(deps.records.get(id)) && (!permit || permit.turnId !== turn?.turnId)) throw failure('workspace_turn_mismatch');
    return { workspacePermit: permit, deliveryId: permit?.deliveryId };
  }
  async function drain(id, permit) {
    if (closed || active.get(id) !== permit || !permit.terminal || permit.draining || permit.evidencePending || isLive(id)) return;
    permit.draining = true;
    try {
      // A warm native process also owns its directory. Close and confirm it
      // before releasing this run; background work prevents this path.
      const stopped = await deps.closePersistent?.(id);
      if (closed || stopped?.closed !== true || active.get(id) !== permit || isLive(id)) return;
      if (permit.evidenceBound) {
        try {
          const code = await captureCodeRevision(permit.lease.workspaceId && registry.workspace(permit.lease.workspaceId)?.path);
          evidence.recordWriterBarrier({ sessionId: id, turnId: permit.turnId, workspaceId: permit.lease.workspaceId,
            leaseId: permit.lease.id, generation: permit.lease.generation, code });
        } catch (error) { deps.log('writer_barrier_not_recorded', { sessionId: id, code: error.code || error.message }); }
      }
      registry.release(permit.lease, { stopped: true, reason: permit.terminal.status || 'stopped' });
      active.delete(id);
    } catch (error) { deps.log('workspace_release_retained', { sessionId: id, code: error.code }); }
    finally { permit.draining = false; }
  }
  function settled(id, outcome) {
    const permit = active.get(id); if (!permit) return;
    permit.terminal = outcome || { status: 'stopped' };
    queueMicrotask(() => {
      // Forced cancellation may never reach the normal runner finalizer. It
      // can record cancellation, but cannot turn scheduler completion into success.
      if (permit.evidenceBound && permit.attemptId && !permit.evidencePending
        && ['cancelled', 'failed'].includes(permit.terminal.status) && !evidence.deliveryFinalized?.(permit.turnId)) {
        permit.evidencePending = evidence.finalize(permit.turnId, { attemptId: permit.attemptId,
          outcome: permit.terminal.status, resultDurable: false, usageDurable: false, pendingInput: !!deps.pendingInput?.(id) })
          .catch(error => deps.log('delivery_evidence_failed', { sessionId: id, code: error.code || 'evidence_write_failed' }))
          .finally(() => { permit.evidencePending = null; void drain(id, permit); });
      }
      void drain(id, permit);
    });
  }
  function initialize() {
    for (const record of deps.records.values()) {
      try { identify(record.id); } catch (error) { deps.log('workspace_identity_unresolved', { sessionId: record.id, code: error.code }); }
    }
    // PID absence does not prove descendant/background writers stopped.
    registry.recover(() => 'unknown');
  }

  // A writer that vanished without a verified stop leaves its lease
  // 'uncertain' (startup recovery deliberately keeps it: PID absence does not
  // prove descendant writers stopped). But 'uncertain' blocks every later
  // delivery for the workspace (occupied() reports busy), and only a
  // delivery's own permit cycle releases a lease — so without a reclaim path
  // one crashed turn wedges the workspace and its queued "insert now"
  // forever. Reclaim when the recorded writer process is provably dead, or
  // when nothing bound to the workspace has been live for a generous window —
  // the same isLive evidence the pre-acquire sibling check requires.
  function writerPidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    try { process.kill(pid, 0); return true; }
    catch (error) { return error?.code === 'EPERM' ? true : false; }
  }
  function staleUncertainLimit() {
    const value = Number(deps.budgets?.staleUncertainMs);
    return Number.isFinite(value) && value >= 0 ? value : DEFAULT_STALE_UNCERTAIN_MS;
  }
  function reapStaleUncertainLeases() {
    if (closed) return;
    const at = Date.now();
    for (const lease of registry.snapshot().leases) {
      if (lease.state !== 'uncertain') continue;
      const workspace = registry.workspace(lease.workspaceId);
      if (!workspace) continue;
      const writers = [...deps.records.values()].filter(record => applicable(record)
        && (record.workspaceOwnerSessionId || record.id) === workspace.ownerId);
      if (writers.some(record => isLive(record.id))) continue;
      const age = at - Number(lease.updatedAt || lease.acquiredAt || 0);
      if (writerPidAlive(lease.pid) !== false && age < staleUncertainLimit()) continue;
      try {
        registry.release(lease, { stopped: true, reason: 'reclaimed_stale_uncertain' });
        deps.log('workspace_uncertain_lease_reclaimed', { workspaceId: lease.workspaceId, sessionId: lease.sessionId, ageMs: age });
      } catch (error) {
        deps.log('workspace_uncertain_lease_reclaim_failed', { workspaceId: lease.workspaceId, code: error.code });
      }
    }
  }
  async function withSeparationBarrier({ sessionId, turnId, separationId }, work) {
    if (!sessionId || !turnId || !separationId || typeof work !== 'function') throw failure('separation_barrier_input_required');
    const workspace = identify(sessionId);
    const source = owner(sessionId);
    const siblingLive = () => [...deps.records.values()].some(record => applicable(record)
      && (record.workspaceOwnerSessionId || record.id) === source.id && isLive(record.id));
    if (!workspace || active.has(sessionId) || siblingLive()) throw failure('workspace_busy');
    const lease = registry.acquire(workspace.id, sessionId, `separation:${separationId}`);
    let stopped = false;
    try {
      await materialize(sessionId, lease);
      const closedPersistent = await deps.closePersistent?.(sessionId);
      if (closedPersistent?.closed !== true || siblingLive()) throw failure('workspace_busy');
      stopped = true;
      const code = await captureCodeRevision(workspace.path);
      const barrier = evidence.recordWriterBarrier({ sessionId, turnId, separationId,
        workspaceId: workspace.id, leaseId: lease.id, generation: lease.generation, code });
      return await work({ barrier, code, workspace: registry.workspace(workspace.id), lease });
    } finally {
      const current = registry.lease(workspace.id);
      if (current?.id === lease.id && current.state !== 'released') {
        registry.release(lease, { stopped: stopped || !isLive(sessionId), reason: stopped ? 'separation_barrier_complete' : 'separation_barrier_failed' });
      }
    }
  }
  return { identify, occupied, beforeDeliver, assertPermit, starting, spawned, settled, bindTurn, finalized, optionsForTurn, initialize,
    mergeHooks: id => evidence.hooks(id), recoverEvidence: id => evidence.recover(id),
    deliveryEvidence: (id, turnId) => evidence.summary(id, turnId), verifyBaseline: (receipt, cwd) => evidence.verifyBaseline(receipt, cwd),
    withSeparationBarrier, recordSeparationApplication: input => evidence.recordSeparationApplication(input),
    capacityReason: id => registry.available(id), snapshot: () => registry.snapshot(), close: () => { closed = true; clearInterval(settleTimer); store.close(); } };
}
module.exports = { createWorkspaceAdmission };
