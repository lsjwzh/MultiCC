'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const { createTaskShellStore } = require('../task-shell/store');
const { createWorkspaceRegistry } = require('./registry');
const { createWriterEscalation } = require('./writer-escalation');
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
const ACTIVE_LEASE_STATES = new Set(['reserved', 'materializing', 'starting', 'running', 'uncertain']);

const DEFAULT_STALE_UNCERTAIN_MS = 5 * 60 * 1000;

// How long a *waiting delivery* may stay vetoed by a completed turn's own lease
// before that condition is named as stuck, and how quiet the pinning background
// work must have been for the same window. Deliberately long: this is a
// threshold for *reporting*, never for acting — a build that keeps printing is
// never called stuck, and even a stuck one is only ever reported.
const DEFAULT_STUCK_BLOCKED_MS = 30 * 60 * 1000;
const DEFAULT_STUCK_SILENCE_MS = 10 * 60 * 1000;
// The stop is only believed once the host agrees nothing is live any more.
const ESCALATION_SETTLE_MS = 2000;

// Residency is a filesystem fact and the filesystem is not this layer's to
// trust blindly, so it is re-observed rather than assumed. Not every tick: the
// answer barely changes and the record set only grows.
const DEFAULT_RESIDENCY_RECLAIM_MS = 60 * 1000;

function createWorkspaceAdmission(deps) {
  const store = createTaskShellStore(deps.file);
  const registry = createWorkspaceRegistry(store, deps.budgets);
  const evidence = require('../task-routing/evidence').createDeliveryEvidence(store, {
    onIntegrationPublished: deps.onIntegrationPublished,
  });
  const permits = new WeakSet(), active = new Map();
  // Armed by a delivery the host refused, disarmed by the delivery that finally
  // gets through. The lease alone says a writer exists, not that anyone is
  // waiting on it, so this is the only evidence escalation reacts to.
  const blockedSince = new Map(), escalating = new Set(), stuckNoticed = new Set();
  const writers = deps.writerEscalation || createWriterEscalation({ log: (event, data) => deps.log(event, data) });
  let closed = false, lastResidencyReclaimAt = 0;
  const settleTimer = setInterval(() => {
    for (const [id, permit] of active) if (permit.terminal) void drain(id, permit);
    reapStaleUncertainLeases();
    reclaimGoneWorkspaces();
    noticeStuckBlocked();
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
      // Preserve the legacy provenance for diagnostics. Safety is decided by
      // the live blocker inspection, while residency follows the filesystem.
      pins: source.workspaceState === 'planned' ? [] : ['legacy_resident_retained'] });
    registry.bind(id, workspace.id);
    return workspace;
  }
  function isLive(id) {
    const state = deps.getState(id);
    return !!(state?.isStreaming || processAlive(state?.claudeProc) || processAlive(state?._cancelledProc)
      || state?._activeRunner || deps.hasBackground(id) || deps.streamBusy(id));
  }
  function hasActiveLease(id) {
    const workspace = identify(id);
    if (!workspace) return false;
    return ['reserved', 'materializing', 'starting', 'running', 'uncertain']
      .includes(registry.lease(workspace.id)?.state);
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
    const reason = registry.available(workspace.id);
    // Resident pressure has an asynchronous recovery path in beforeDeliver().
    // Let the scheduler enter that path instead of classifying the target as a
    // permanently occupied writer and retrying the same synchronous probe.
    return !!reason && reason !== 'workspace_resident_capacity';
  }

  function reclaimGoneWorkspaces(force = false) {
    if (closed) return [];
    const at = Date.now();
    if (!force && at - lastResidencyReclaimAt < residencyReclaimLimit()) return [];
    lastResidencyReclaimAt = at;
    let reclaimed = [];
    try {
      reclaimed = registry.reclaim(record => (fs.existsSync(record.path) ? 'present' : 'gone'));
    } catch (error) {
      deps.log('workspace_residency_reclaim_failed', { code: error.code });
      return [];
    }
    for (const workspaceId of reclaimed) deps.log('workspace_residency_reclaimed', { workspaceId });
    return reclaimed;
  }

  async function acquireWithResidentRelief(workspace, sessionId, requestId) {
    try { return registry.acquire(workspace.id, sessionId, requestId); }
    catch (error) {
      if (error?.code !== 'workspace_resident_capacity') throw error;
      const runtime = deps.hibernation?.();
      if (typeof runtime?.reclaimForCapacity !== 'function') throw error;
      const relief = await runtime.reclaimForCapacity({
        dirId: workspace.dirId,
        excludeSessionIds: [owner(sessionId).id],
        count: 1,
      });
      const reclaimed = reclaimGoneWorkspaces(true);
      deps.log('workspace_capacity_relief', {
        sessionId, dirId: workspace.dirId,
        considered: relief?.considered || 0,
        hibernated: relief?.hibernated || 0,
        reclaimed: reclaimed.length,
      });
      return registry.acquire(workspace.id, sessionId, requestId);
    }
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
    // Hibernation persists this transition before its final blocker check.
    // Refusing new acquisition during that small window closes the race where
    // a checkout could otherwise be detached immediately after a lease starts.
    if (['hibernating', 'thawing'].includes(source.workspaceState)) throw failure('workspace_busy');
    for (const record of deps.records.values()) if (record.id !== descriptor.sessionId
      && (record.workspaceOwnerSessionId || record.id) === source.id && isLive(record.id)) throw failure('workspace_busy');
    const lease = await acquireWithResidentRelief(workspace, descriptor.sessionId, descriptor.item.id);
    const permit = { lease, sessionId: descriptor.sessionId, deliveryId: descriptor.item.id };
    permits.add(permit); active.set(descriptor.sessionId, permit);
    let materialized = false;
    try {
      // The execution lease is ours now; retire another session's parked child
      // on this checkout before restoring or delivering to its next writer.
      await deps.claimPersistent?.(descriptor.sessionId, workspace);
      await materialize(descriptor.sessionId, lease);
      materialized = true;
      try { permit.startCode = await captureCodeRevision(workspace.path); }
      catch (error) { permit.startObservationError = /^code_[a-z_]+$/.test(error.message) ? error.message : 'code_observation_failed'; }
      await require('../task-shell/role-bindings').prepareRoleContext(store, descriptor, deps);
      // This delivery got through, so nothing is blocked behind the workspace any
      // more: the next refusal arms a fresh window.
      blockedSince.delete(descriptor.sessionId);
      stuckNoticed.delete(descriptor.sessionId);
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
      // Role/context preparation happens after the checkout has already been
      // validated and marked resident. Do not mislabel those failures as a Git
      // materialization failure or permanently pin an otherwise healthy tree.
      const reason = materialized ? 'prelaunch_failed' : 'materialization_failed';
      if (!materialized && error.code !== 'workspace_busy' && fs.existsSync(workspace.path)) registry.retain(lease, reason);
      registry.release(lease, { stopped: true, reason });
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
    if (permit.draining) return permit.drainPromise || null;
    if (closed || active.get(id) !== permit || !permit.terminal || permit.evidencePending || isLive(id)) return null;
    permit.draining = true;
    const release = (async () => {
      try {
        // Parked residency cannot accept new sends without the next execution
        // lease. Unknown/per-turn backends retain the verified-close fallback.
        const workspace = registry.workspace(permit.lease.workspaceId);
        const residency = deps.parkPersistent?.(id, workspace);
        // A busy/queued/recycling resident refused to park: retain its lease,
        // never turn that refusal into a destructive close fallback.
        if (residency && residency.parked !== true) return;
        const parked = residency?.parked === true;
        const stopped = parked ? null : await deps.closePersistent?.(id);
        if (closed || (!parked && stopped?.closed !== true) || active.get(id) !== permit || isLive(id)) return;
        if (permit.evidenceBound) {
          try {
            const code = await captureCodeRevision(permit.lease.workspaceId && registry.workspace(permit.lease.workspaceId)?.path);
            evidence.recordWriterBarrier({ sessionId: id, turnId: permit.turnId, workspaceId: permit.lease.workspaceId,
              leaseId: permit.lease.id, generation: permit.lease.generation, code });
          } catch (error) { deps.log('writer_barrier_not_recorded', { sessionId: id, code: error.code || error.message }); }
        }
        if (closed || active.get(id) !== permit || isLive(id)) return;
        registry.release(permit.lease, { stopped: true, reason: permit.terminal.status || 'stopped' });
        active.delete(id);
      } catch (error) { deps.log('workspace_release_retained', { sessionId: id, code: error.code }); }
      finally { permit.draining = false; }
    })();
    permit.drainPromise = release;
    try { return await release; }
    finally { if (permit.drainPromise === release) permit.drainPromise = null; }
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
  // ── A stuck delivery: reported, never reclaimed ────────────────────────────
  // `drain()` refuses to release while anything bound to the session is live,
  // because a live background task may still be writing the checkout. That stays
  // exactly as it is: no lease is force-released on a timer, and nothing on this
  // path signals a process. What was missing is the *reporting* — a lease a
  // completed turn will not let go looked identical to ordinary occupancy, so a
  // queue that could never advance named only "workspace_occupied" and left the
  // user to guess. Stopping the writer stays a user decision, and the two
  // explicit intents that mean it (cancel, insert now) escalate on demand.
  function noteBlockedDelivery(sessionId) {
    if (closed || !sessionId || blockedSince.has(sessionId)) return;
    blockedSince.set(sessionId, Date.now());
  }
  function window(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  }
  // The full condition: someone is waiting on this session, the turn that owns
  // the lease is over, the pin is still live, and (if that pin reports progress
  // at all) it has gone quiet for the window. Silence is only a signal when
  // there is background work to be silent: no live background work means the pin
  // is the writer process itself, which is just as stuck and worth naming.
  function stuckSince(sessionId) {
    const since = blockedSince.get(sessionId);
    if (!since || Date.now() - since < window(deps.budgets?.stuckBlockedMs, DEFAULT_STUCK_BLOCKED_MS)) return null;
    // The condition is gone (the turn moved on, or the writer died and the
    // normal drain owns it): forget the arm so a later wedge reports again.
    const forget = () => { blockedSince.delete(sessionId); stuckNoticed.delete(sessionId); return null; };
    const permit = active.get(sessionId);
    if (permit && !permit.terminal) return forget();
    if (!isLive(sessionId)) return forget();
    if (typeof deps.backgroundSilence !== 'function') return null;
    let silence = Infinity;
    try { silence = Number(deps.backgroundSilence(sessionId)); } catch (_) { silence = Infinity; }
    const quiet = !silence || silence >= window(deps.budgets?.stuckSilenceMs, DEFAULT_STUCK_SILENCE_MS);
    return quiet ? { since, silence } : null;
  }
  // Once per armed window, so a wedge does not log every second while it lasts.
  function noticeStuckBlocked() {
    if (closed) return;
    for (const sessionId of [...blockedSince.keys()]) {
      const stuck = stuckSince(sessionId);
      if (!stuck || stuckNoticed.has(sessionId)) continue;
      stuckNoticed.add(sessionId);
      let leaseId = null;
      try { leaseId = registry.lease(identify(sessionId)?.id)?.id || null; } catch (_) { leaseId = null; }
      deps.log('workspace_delivery_stuck', { sessionId, leaseId, blockedMs: Date.now() - stuck.since,
        silenceMs: Number.isFinite(stuck.silence) ? stuck.silence : null,
        // Reported, not repaired: the message stays queued until the user stops
        // the writer (cancel / insert now) — this line exists to tell them why.
        hint: 'stop_the_writer_manually' });
    }
  }
  // Surfaced to the host as an extra busy reason, so the queue's own diagnostics
  // (`delivery_skipped`, and insert-now's `holdReasons`) say what is wrong
  // instead of reporting plain occupancy forever.
  function stuckHint(id) {
    if (closed || !blockedSince.has(id)) return null;
    return stuckSince(id) ? 'workspace_stuck_background' : null;
  }
  async function escalate(id, { reason = 'force_release', source = 'host', trusted = false } = {}) {
    if (closed) return { ok: false, escalated: false, released: false, code: 'admission_closed' };
    if (escalating.has(id)) return { ok: false, escalated: false, released: false, code: 'escalation_in_progress' };
    if (!trusted && !blockedSince.has(id)) return { ok: false, escalated: false, released: false, code: 'no_blocked_delivery' };
    let workspace = null;
    try { workspace = identify(id); }
    catch (error) { return { ok: false, escalated: false, released: false, code: error.code || 'workspace_identity_unresolved' }; }
    const lease = workspace && registry.lease(workspace.id);
    if (!lease || !ACTIVE_LEASE_STATES.has(lease.state)) return { ok: false, escalated: false, released: false, code: 'no_active_lease' };
    // Shared checkout does not grant cancellation authority over its writer.
    if (lease.sessionId !== id) return { ok: false, escalated: false, released: false, code: 'workspace_owned_by_other_session' };
    const permit = active.get(id);
    if (permit && !permit.terminal) return { ok: false, escalated: false, released: false, code: 'turn_still_running' };
    escalating.add(id);
    try {
      // Descendants first: they hold the checkout and the hung handle, and they
      // are what the managed close below cannot reach on its own.
      const descendants = await writers.stopDescendants(lease.pid, { reason });
      let reaped = 0;
      try { reaped = deps.reapBackground?.(id, { reason: `escalated:${reason}` }) || 0; }
      catch (error) { deps.log('workspace_escalation_reap_failed', { sessionId: id, code: error.code || 'reap_failed' }); }
      // The managed close is preferred for the writer itself: it is the only path
      // that also settles the stream state. A writer that refuses it gets the
      // same ladder its descendants just got.
      let closedOk = false;
      try { closedOk = (await deps.closePersistent?.(id))?.closed === true; }
      catch (error) { deps.log('workspace_escalation_close_failed', { sessionId: id, code: error.code || 'close_failed' }); }
      let killed = descendants.killed, survivors = [...descendants.survivors];
      if (!closedOk && lease.pid) {
        const hard = await writers.stopWriter(lease.pid, { reason });
        closedOk = hard.ok;
        killed += hard.killed;
        survivors = [...new Set([...survivors, ...hard.survivors])];
      }
      const deadline = Date.now() + ESCALATION_SETTLE_MS;
      while (isLive(id) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
      const stillLive = isLive(id);
      const outcome = { reason, source, killed, reaped, closed: closedOk, live: stillLive,
        stop: descendants.code, survivors };
      // Nothing is released on a stop that was not confirmed. An unverified
      // writer is precisely what the lease exists to refuse, and a release
      // granted on hope is how two writers end up in one checkout.
      if (survivors.length || !closedOk || stillLive) {
        deps.log('workspace_escalation_incomplete', { sessionId: id, leaseId: lease.id, ...outcome });
        return { ok: false, escalated: true, released: false, ...outcome };
      }
      blockedSince.delete(id);
      stuckNoticed.delete(id);
      // A permit releases through drain() so the evidence barrier and the writer
      // barrier still run. A lease no delivery owns (a crash leftover) has no
      // permit path and is released directly, exactly like the stale sweep.
      if (permit) await drain(id, permit);
      else registry.release(lease, { stopped: true, reason: `escalated:${reason}` });
      const released = !ACTIVE_LEASE_STATES.has(registry.lease(workspace.id)?.state);
      deps.log(released ? 'workspace_lease_escalated' : 'workspace_escalation_release_pending', { sessionId: id, leaseId: lease.id, ...outcome });
      return { ok: released, escalated: true, released, ...outcome };
    } finally { escalating.delete(id); }
  }
  // A worktree can go away without the registry ever being told: relocate
  // detaches the old one, hibernation detaches the current one, and a session
  // deleted by hand takes its directory with it. The record left behind still
  // said 'resident', and 'resident' is what spends the resident budget — so
  // the limit drifted upward, one abandoned worktree at a time, until a
  // workspace that genuinely needed restoring could be refused for capacity
  // that nothing was using. Demote on observation; the registry never deletes
  // the record, so the identity history (and the lease that may pin it) stays.
  function residencyReclaimLimit() {
    const value = Number(deps.budgets?.residencyReclaimMs);
    return Number.isFinite(value) && value >= 0 ? value : DEFAULT_RESIDENCY_RECLAIM_MS;
  }
  async function withSeparationBarrier({ sessionId, turnId, separationId }, work) {
    if (!sessionId || !turnId || !separationId || typeof work !== 'function') throw failure('separation_barrier_input_required');
    const workspace = identify(sessionId);
    const source = owner(sessionId);
    const siblingLive = () => [...deps.records.values()].some(record => applicable(record)
      && (record.workspaceOwnerSessionId || record.id) === source.id && isLive(record.id));
    // A wait_for_user_answer turn is terminal from the writer's point of view,
    // but its lease can still be awaiting the asynchronous evidence flush when
    // the user clicks “separate”.  Drain that terminal lease here rather than
    // reporting it as a live writer.  We never do this for a running process:
    // isLive remains the hard boundary against concurrent filesystem writes.
    const terminal = active.get(sessionId);
    if (terminal?.terminal && !isLive(sessionId)) {
      // `settled()` also schedules drain().  drain() exposes the in-flight
      // release promise, so this waits for that exact close/verification pass
      // rather than mistaking a short evidence write for a live writer.
      if (terminal.evidencePending) await terminal.evidencePending;
      if (active.get(sessionId) === terminal && !isLive(sessionId)) await drain(sessionId, terminal);
    }
    if (!workspace || active.has(sessionId) || siblingLive()) throw failure('workspace_busy');
    const lease = await acquireWithResidentRelief(workspace, sessionId, `separation:${separationId}`);
    let stopped = false;
    try {
      await materialize(sessionId, lease);
      await deps.claimPersistent?.(sessionId, workspace, { exclusive: true });
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
  return { identify, occupied, hasActiveLease, beforeDeliver, assertPermit, starting, spawned, settled, bindTurn, finalized, optionsForTurn, initialize,
    noteBlockedDelivery, escalate, noticeStuckBlocked, stuckHint,
    mergeHooks: id => evidence.hooks(id), recoverEvidence: id => evidence.recover(id),
    deliveryEvidence: (id, turnId) => evidence.summary(id, turnId), verifyBaseline: (receipt, cwd) => evidence.verifyBaseline(receipt, cwd),
    withSeparationBarrier, recordSeparationApplication: input => evidence.recordSeparationApplication(input),
    capacityReason: id => registry.available(id), snapshot: () => registry.snapshot(),
    reconcileResidency: () => reclaimGoneWorkspaces(true),
    close: () => { closed = true; clearInterval(settleTimer); store.close(); } };
}
module.exports = { createWorkspaceAdmission };
