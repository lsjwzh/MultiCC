'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHibernationReclaimer } = require('./hibernation-reclaimer');

const DAY_MS = 24 * 60 * 60 * 1000;
// Idle gate for the periodic sweep. The LRU resident budget (awakeLimit) is
// the primary convergence mechanism; six hours keeps same-day follow-ups warm
// without letting yesterday's tasks pile up.
const DEFAULT_HIBERNATE_IDLE_MS = 6 * 60 * 60 * 1000;
const DEFAULT_HIBERNATE_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_HIBERNATE_STARTUP_DELAY_MS = 30 * 1000;
const DEFAULT_HIBERNATE_BATCH_SIZE = 16;
// Per-directory budget of awake (on-disk) task worktrees. Worker's slots and
// task chats share one LRU: past the budget the least-recently-worked session
// hibernates regardless of idle time. 0 disables the budget.
const DEFAULT_AWAKE_LIMIT = 16;
const WORKSPACE_STATES = new Set(['planned', 'awake', 'hibernating', 'hibernated', 'thawing']);
const EXCLUDED_TYPES = new Set(['commander', 'gateway', 'worker', 'aux', 'system']);

function millis(value) {
  if (value == null || value === '') return null;
  const number = typeof value === 'number' ? value : new Date(value).getTime();
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function iso(value) {
  const number = millis(value);
  return number == null ? null : new Date(number).toISOString();
}

function taskTimes(value, out = []) {
  if (!value || typeof value !== 'object') return out;
  for (const [key, child] of Object.entries(value)) {
    if (/(?:At|Ts)$/i.test(key)) {
      const parsed = millis(child);
      if (parsed != null) out.push(parsed);
    } else if (child && typeof child === 'object') taskTimes(child, out);
  }
  return out;
}

function inferLastWorkAt(record = {}, history = []) {
  const candidates = [millis(record.createdAt) || 0];
  for (const message of Array.isArray(history) ? history : []) {
    if (!message || message._interim || message.interim || message.partial) continue;
    const timestamp = millis(message.ts ?? message.createdAt ?? message.updatedAt);
    if (timestamp != null) candidates.push(timestamp);
  }
  taskTimes(record.taskState, candidates);
  taskTimes(record.currentTask, candidates);
  return iso(Math.max(...candidates));
}

function stateOf(record) {
  return WORKSPACE_STATES.has(record?.workspaceState) ? record.workspaceState : 'awake';
}

function evaluateSessionEligibility(record, {
  nowMs = Date.now(), idleMs = DEFAULT_HIBERNATE_IDLE_MS, blockers = [], allowTypes = [],
} = {}) {
  const reasons = [];
  if (!record || record.kind !== 'chat') reasons.push('not_task_chat');
  if (!record?.taskBoundTaskId) reasons.push('not_task_bound');
  if (record?.workspaceOwnerSessionId) reasons.push('shared_shell_workspace');
  if (record?.taskExecutionSlot) reasons.push('task_execution_slot');
  if (record?.ephemeral) reasons.push('ephemeral');
  if (record?.experimental || record?.experimentalMode) reasons.push('experimental');
  if (record?.loginFlow) reasons.push('login_flow');
  // The LRU budget pass deliberately reclaims idle worker slots (their home
  // worktree is pure weight); every other excluded type stays excluded.
  if (record?.type && EXCLUDED_TYPES.has(record.type) && !allowTypes.includes(record.type)) reasons.push(`type_${record.type}`);
  if (Array.isArray(record?.triggers) && record.triggers.some(trigger => trigger?.enabled)) reasons.push('enabled_trigger');
  if (stateOf(record) !== 'awake') reasons.push(`state_${stateOf(record)}`);
  if (record?.rebaseInProgress || record?.conflicts?.length || record?.mergeInProgress) reasons.push('git_transition');
  if (record?.taskState?.runState === 'running' || record?.taskState?.queueState === 'running') reasons.push('running_task');
  for (const blocker of Array.isArray(blockers) ? blockers : []) {
    const safe = String(blocker || '').replace(/[^a-z0-9_.-]/gi, '_').slice(0, 80);
    if (safe) reasons.push(safe);
  }
  const lastWorkMs = millis(record?.lastWorkAt) ?? millis(record?.createdAt) ?? Number(nowMs);
  if (Number(nowMs) - lastWorkMs < Number(idleMs)) reasons.push('not_idle');
  return Object.freeze({ eligible: reasons.length === 0, reasons: Object.freeze(reasons), lastWorkMs });
}

function safeErrorCode(error, fallback) {
  const raw = String(error?.code || fallback || 'hibernate_failed');
  if (raw === 'WORKTREE_BRANCH_MISSING') return 'hibernate_branch_missing';
  if (raw === 'WORKTREE_BRANCH_MISMATCH') return 'hibernate_branch_mismatch';
  if (raw === 'WORKTREE_NOT_REGISTERED') return 'hibernate_worktree_unregistered';
  if (raw === 'WORKTREE_PATH_MISSING') return 'hibernate_path_missing';
  return /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(raw) ? raw : String(fallback || 'hibernate_failed');
}

// A registered worktree can remain useful while Git is detached or resolving a
// merge/rebase conflict. That is a degraded repository state, not an unavailable
// chat workspace: the session must be allowed to enter it and finish the repair.
function degradedResidentCode(observed = {}) {
  if (!observed.pathExists) return null;
  if (observed.code === 'WORKTREE_BRANCH_MISMATCH') return 'workspace_branch_mismatch';
  if (observed.code === 'WORKTREE_NOT_REGISTERED') return 'workspace_worktree_unregistered';
  return null;
}

function numericOption(value, fallback) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function createSessionHibernationRuntime(options = {}) {
  const {
    records,
    directories,
    persistence,
    git,
    loadHistory = () => [],
    inspectBlockers = async () => [],
    closePersistent = async () => ({ closed: true }),
    updateChatCwd = () => {},
    pathExists = record => !!record?.worktreePath && fs.existsSync(record.worktreePath),
    now = Date.now,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    onEvent = () => {},
    metric = () => {},
    logger = console,
  } = options;
  if (!(records instanceof Map) || !(directories instanceof Map)) throw new TypeError('hibernation requires record and directory maps');
  if (!persistence || typeof persistence.mutate !== 'function') throw new TypeError('hibernation requires required persistence');
  for (const name of ['inspect', 'detach', 'thaw']) {
    if (typeof git?.[name] !== 'function') throw new TypeError(`hibernation git.${name} port is required`);
  }
  const idleMs = numericOption(options.idleMs, DEFAULT_HIBERNATE_IDLE_MS);
  const intervalMs = numericOption(options.intervalMs, DEFAULT_HIBERNATE_INTERVAL_MS);
  const startupDelayMs = numericOption(options.startupDelayMs, DEFAULT_HIBERNATE_STARTUP_DELAY_MS);
  const batchSize = Math.max(1, Math.min(64, Number(options.batchSize) || DEFAULT_HIBERNATE_BATCH_SIZE));
  const awakeLimit = Math.max(0, Math.min(1024, Number(numericOption(options.awakeLimit, DEFAULT_AWAKE_LIMIT)) || 0));
  const tails = new Map();
  const operations = new Set();
  let sweepPromise = null;
  let timer = null;
  let stopped = false;

  function publish(action, status, sessionId, code = null) {
    const event = Object.freeze({ type: 'session_workspace', action, status, sessionId, code });
    try { onEvent(event); } catch (_) {}
    try { metric(`session_hibernation_${action}_${status}`, 1); } catch (_) {}
  }

  function persistState(sessionId, source, updater) {
    return persistence.mutate(source, (map) => {
      const record = map.get(sessionId);
      if (!record) return null;
      updater(record);
      record.workspaceStateUpdatedAt = iso(now());
      return record;
    });
  }

  async function acquireKey(sessionId) {
    const previous = tails.get(sessionId) || Promise.resolve();
    let releaseGate;
    const gate = new Promise(resolve => { releaseGate = resolve; });
    const current = previous.catch(() => {}).then(() => gate);
    tails.set(sessionId, current);
    await previous.catch(() => {});
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseGate();
      current.finally(() => { if (tails.get(sessionId) === current) tails.delete(sessionId); });
    };
  }

  // True while this session's key is held (admission, delivery, terminal touch).
  // The outbox worker reads it BEFORE claiming: admitChatWork holds the key for
  // the whole admission, and that admission awaits runtime.tick(), so a worker
  // that claimed and then blocked on acquireDelivery would wait for a key whose
  // holder is waiting for that very tick — a deadlock that freezes the single
  // tick chain for every session, not just this one. Skipping the claim keeps
  // the tick short; the next one delivers once the key is free.
  function isLocked(sessionId) {
    return tails.has(sessionId);
  }

  async function serialized(sessionId, operation) {
    const release = await acquireKey(sessionId);
    const promise = Promise.resolve().then(operation);
    operations.add(promise);
    try { return await promise; }
    finally { operations.delete(promise); release(); }
  }

  function touchUnlocked(sessionId, source = 'runtime.hibernate.touch') {
    return persistState(sessionId, source, (record) => {
      record.lastWorkAt = iso(now());
      // Keep a visible warning while the resident checkout is detached or on a
      // different branch. A later successful inspection clears it.
      if (!['workspace_branch_mismatch', 'workspace_worktree_unregistered']
        .includes(record.workspaceStateErrorCode)) {
        record.workspaceStateErrorCode = null;
      }
    });
  }

  async function inspect(record) {
    const directory = directories.get(record.dirId);
    if (!directory) return { pathExists: pathExists(record), branchExists: false, valid: false, code: 'directory_missing' };
    const value = await git.inspect(directory, record);
    return value && typeof value === 'object' ? value : {};
  }

  async function ensureAwakeUnlocked(sessionId) {
    const record = records.get(sessionId);
    if (!record) return { ok: false, code: 'session_not_found' };
    const observed = await inspect(record);
    if (stateOf(record) === 'awake' && observed.pathExists && observed.valid !== false) {
      if (['workspace_branch_mismatch', 'workspace_worktree_unregistered']
        .includes(record.workspaceStateErrorCode)) {
        persistState(sessionId, 'runtime.workspace.degraded-cleared', current => {
          current.workspaceStateErrorCode = null;
        });
      }
      return { ok: true, already: true };
    }
    const degradedCode = degradedResidentCode(observed);
    if (degradedCode) {
      persistState(sessionId, 'runtime.workspace.degraded', current => {
        current.workspaceState = 'awake';
        current.workspaceStateErrorCode = degradedCode;
      });
      updateChatCwd(sessionId, record.worktreePath);
      publish('thaw', 'degraded', sessionId, degradedCode);
      return { ok: true, already: true, degraded: true, code: degradedCode };
    }
    persistState(sessionId, 'runtime.thaw.preparing', current => {
      current.workspaceState = 'thawing';
      current.workspaceStateErrorCode = null;
    });
    try {
      const directory = directories.get(record.dirId);
      const result = await git.thaw(directory, record);
      persistState(sessionId, 'runtime.thaw.complete', current => {
        current.workspaceState = 'awake';
        current.worktreePath = result.worktreePath || current.worktreePath;
        current.branch = result.branch || current.branch;
        current.hibernatedAt = null;
        current.workspaceStateErrorCode = null;
      });
      updateChatCwd(sessionId, records.get(sessionId).worktreePath);
      publish('thaw', 'success', sessionId);
      return { ok: true, thawed: true };
    } catch (error) {
      const code = safeErrorCode(error, 'thaw_failed');
      persistState(sessionId, 'runtime.thaw.failed', current => {
        current.workspaceState = 'hibernated';
        current.workspaceStateErrorCode = code;
      });
      publish('thaw', 'failure', sessionId, code);
      return { ok: false, code, workspaceUnavailable: true };
    }
  }

  async function ensureAwake(sessionId) {
    return serialized(sessionId, () => ensureAwakeUnlocked(sessionId));
  }

  async function hibernateUnlocked(sessionId, { eligibilityChecked = false, ignoreIdle = false, allowTypes = [] } = {}) {
    const record = records.get(sessionId);
    if (!record) return { ok: false, code: 'session_not_found' };
    if (stateOf(record) === 'hibernated') return { ok: true, already: true };
    const effectiveIdleMs = ignoreIdle ? 0 : idleMs;
    const preliminary = evaluateSessionEligibility(record, { nowMs: now(), idleMs: effectiveIdleMs, allowTypes });
    if (!eligibilityChecked && !preliminary.eligible) {
      publish('hibernate', 'skip', sessionId, preliminary.reasons[0] || 'ineligible');
      return { ok: false, skipped: true, code: preliminary.reasons[0] || 'ineligible' };
    }
    const blockers = await inspectBlockers(sessionId, record);
    const verdict = evaluateSessionEligibility(record, { nowMs: now(), idleMs: effectiveIdleMs, blockers, allowTypes });
    if (!verdict.eligible) {
      publish('hibernate', 'skip', sessionId, verdict.reasons[0] || 'ineligible');
      return { ok: false, skipped: true, code: verdict.reasons[0] || 'ineligible' };
    }
    if (blockers.length) {
      publish('hibernate', 'skip', sessionId, blockers[0]);
      return { ok: false, skipped: true, code: blockers[0] };
    }
    persistState(sessionId, 'runtime.hibernate.preparing', current => {
      current.workspaceState = 'hibernating';
      current.workspaceStateErrorCode = null;
    });
    try {
      await closePersistent(sessionId, record);
      const lateBlockers = await inspectBlockers(sessionId, record);
      if (lateBlockers.length) {
        const error = new Error('session became active while preparing');
        error.code = 'hibernate_became_active';
        throw error;
      }
      const directory = directories.get(record.dirId);
      const result = await git.detach(directory, record);
      persistState(sessionId, 'runtime.hibernate.complete', current => {
        current.workspaceState = 'hibernated';
        current.hibernatedAt = iso(now());
        current.hibernateSnapshot = result.snapshot || null;
        // Audit trail for unknown ignored files deleted with the checkout
        // (paths/sizes/mtimes only — never contents).
        if (Array.isArray(result.removedUnknownIgnored) && result.removedUnknownIgnored.length) {
          current.hibernateRemovedIgnored = { at: iso(now()), entries: result.removedUnknownIgnored };
        }
        current.workspaceStateErrorCode = null;
      });
      publish('hibernate', 'success', sessionId);
      return { ok: true, hibernated: true };
    } catch (error) {
      const code = safeErrorCode(error, 'hibernate_failed');
      const observed = await inspect(record).catch(() => ({ pathExists: true, branchExists: true }));
      const detachedDespiteError = !observed.pathExists && observed.branchExists;
      persistState(sessionId, 'runtime.hibernate.failed', current => {
        current.workspaceState = detachedDespiteError ? 'hibernated' : 'awake';
        if (detachedDespiteError && !current.hibernatedAt) current.hibernatedAt = iso(now());
        current.workspaceStateErrorCode = code;
      });
      publish('hibernate', 'failure', sessionId, code);
      logger.warn?.('session_hibernation_failed', { sessionId, code });
      return { ok: false, code, hibernated: detachedDespiteError };
    }
  }

  function hibernate(sessionId, options) {
    return serialized(sessionId, () => hibernateUnlocked(sessionId, options));
  }

  const reclaimer = createHibernationReclaimer({
    records, now, idleMs, batchSize, eligible: evaluateSessionEligibility,
    hibernate, publish, isStopped: () => stopped,
  });

  // LRU resident budget: per directory, awake on-disk task workspaces beyond
  // awakeLimit hibernate oldest-first regardless of idle time. Eligibility is
  // asserted here (this pass deliberately includes worker slots, whose idle
  // home worktree is pure weight); runtime blockers still re-check inside
  // hibernate(), so anything actively writing is left alone.
  function budgetCandidates() {
    const awake = [];
    for (const record of records.values()) {
      if (record?.kind !== 'chat' || !record.taskBoundTaskId || record.workspaceOwnerSessionId) continue;
      if (record.ephemeral || record.experimental || record.experimentalMode) continue;
      if (stateOf(record) !== 'awake' || !pathExists(record)) continue;
      if (Array.isArray(record.triggers) && record.triggers.some(trigger => trigger?.enabled)) continue;
      if (record.taskState?.runState === 'running' || record.taskState?.queueState === 'running') continue;
      if (record.rebaseInProgress || record.conflicts?.length || record.mergeInProgress) continue;
      awake.push(record);
    }
    const byDir = new Map();
    for (const record of awake) {
      const list = byDir.get(record.dirId) || [];
      list.push(record);
      byDir.set(record.dirId, list);
    }
    const excess = [];
    for (const list of byDir.values()) {
      if (list.length <= awakeLimit) continue;
      list.sort((left, right) =>
        (millis(left.lastWorkAt) ?? millis(left.createdAt) ?? 0) - (millis(right.lastWorkAt) ?? millis(right.createdAt) ?? 0)
        || left.id.localeCompare(right.id));
      excess.push(...list.slice(0, list.length - awakeLimit));
    }
    return excess;
  }

  async function enforceAwakeBudget() {
    if (!awakeLimit) return { considered: 0, hibernated: 0 };
    const excess = budgetCandidates();
    let hibernated = 0;
    for (const record of excess) {
      let result;
      try { result = await hibernate(record.id, { eligibilityChecked: true, ignoreIdle: true, allowTypes: ['worker'] }); }
      catch (_) { continue; }
      if (result?.ok && result.hibernated) hibernated += 1;
    }
    if (excess.length) publish('budget', 'success', null, null);
    return { considered: excess.length, hibernated };
  }

  function sweep() {
    if (sweepPromise) return sweepPromise;
    const work = (async () => {
      const candidates = reclaimer.candidatesFor();
      const result = await reclaimer.runCandidates(candidates);
      const budget = await enforceAwakeBudget();
      publish('sweep', 'success', null, null);
      return { ok: true, considered: candidates.length, ...result, budget };
    })();
    sweepPromise = work.finally(() => { sweepPromise = null; });
    return sweepPromise;
  }

  async function reconcileStartup() {
    const missing = [];
    for (const record of records.values()) {
      if (record?.kind === 'chat' && record.taskBoundTaskId && !record.lastWorkAt) {
        let history = [];
        try { history = loadHistory(record.id) || []; } catch (_) {}
        missing.push([record.id, inferLastWorkAt(record, history)]);
      }
    }
    if (missing.length) persistence.mutate('startup.hibernate-last-work-backfill', (map) => {
      for (const [id, lastWorkAt] of missing) if (map.get(id) && !map.get(id).lastWorkAt) map.get(id).lastWorkAt = lastWorkAt;
    });
    for (const record of records.values()) {
      if (!record?.taskBoundTaskId || record.kind !== 'chat' || record.workspaceOwnerSessionId) continue;
      const state = stateOf(record);
      if (state === 'planned') continue;
      if (state === 'awake') continue;
      const observed = await inspect(record);
      let next = state;
      let code = null;
      const degradedCode = degradedResidentCode(observed);
      if (degradedCode) {
        next = 'awake';
        code = degradedCode;
      } else if (state === 'hibernating') next = observed.pathExists ? 'awake' : 'hibernated';
      else if (state === 'thawing') next = observed.pathExists ? 'awake' : 'hibernated';
      else if (state === 'hibernated' && observed.pathExists && observed.valid !== false) next = 'awake';
      persistState(record.id, 'startup.hibernate-reconcile', current => {
        current.workspaceState = next;
        current.workspaceStateErrorCode = code;
        if (next === 'awake') current.hibernatedAt = null;
      });
      publish('reconcile', 'success', record.id, code);
    }
    return { ok: true };
  }

  async function admit(sessionId, admission) {
    const ownerId = records.get(sessionId)?.workspaceOwnerSessionId || sessionId;
    return serialized(ownerId, async () => {
      const awake = await ensureAwakeUnlocked(ownerId);
      if (!awake.ok) return awake;
      const result = await admission();
      if (result && result.ok !== false) touchUnlocked(sessionId, 'runtime.hibernate.admission');
      return result;
    });
  }

  async function acquireDelivery(sessionId) {
    const release = await acquireKey(sessionId);
    let awake;
    try { awake = await ensureAwakeUnlocked(sessionId); }
    catch (error) { release(); throw error; }
    if (!awake.ok) {
      release();
      const error = new Error('session workspace could not be restored');
      error.code = awake.code;
      throw error;
    }
    let completed = false;
    return Object.freeze({
      async complete(outcome = {}) {
        if (completed) return;
        completed = true;
        try {
          if (outcome.accepted && outcome.durable) touchUnlocked(sessionId, 'runtime.hibernate.delivery');
        } finally { release(); }
      },
    });
  }

  function touchTerminal(sessionId, completion = {}) {
    if (completion.interim || completion._interim) return Promise.resolve(false);
    if (!records.get(sessionId)?.taskBoundTaskId) return Promise.resolve(false);
    return serialized(sessionId, () => {
      touchUnlocked(sessionId, 'runtime.hibernate.terminal');
      return true;
    });
  }

  function assertAwake(sessionId) {
    const record = records.get(sessionId);
    if (!record) {
      const error = new Error('session not found');
      error.code = 'SESSION_NOT_FOUND';
      throw error;
    }
    if (stateOf(record) !== 'awake' || !pathExists(record)) {
      const error = new Error('session workspace is hibernated');
      error.code = 'SESSION_HIBERNATED';
      throw error;
    }
    return true;
  }

  function schedule(delay) {
    if (stopped || idleMs <= 0 || intervalMs <= 0) return;
    timer = setTimeoutFn(async () => {
      try { await sweep(); }
      catch (error) { logger.warn?.('session_hibernation_sweep_failed', { code: safeErrorCode(error, 'sweep_failed') }); }
      timer = null;
      schedule(intervalMs);
    }, delay);
    timer?.unref?.();
  }

  function start() {
    if (timer || stopped || idleMs <= 0 || intervalMs <= 0) return false;
    schedule(Math.max(0, startupDelayMs));
    return true;
  }

  async function stop() {
    stopped = true;
    if (timer) clearTimeoutFn(timer);
    timer = null;
    await Promise.allSettled([...(sweepPromise ? [sweepPromise] : []), reclaimer.settleCapacity(), ...operations, ...tails.values()]);
  }

  function status() {
    return Object.freeze({ stopped, scheduled: !!timer, sweeping: !!sweepPromise,
      awakeLimit, idleMs,
      capacityReclaims: reclaimer.pendingCapacity(), activeOperations: operations.size });
  }

  return Object.freeze({
    acquireDelivery,
    admit,
    assertAwake,
    ensureAwake,
    enforceAwakeBudget,
    hibernate,
    isLocked,
    reclaimForCapacity: reclaimer.reclaimForCapacity,
    reconcileStartup,
    start,
    status,
    stop,
    sweep,
    touchTerminal,
  });
}

function resolveSessionCwd(session, {
  directories,
  dataRoot,
  existsSync = fs.existsSync,
  homeDir = os.homedir,
  moduleDir = __dirname,
} = {}) {
  if (!session) return homeDir();
  if (session.type === 'aux') return session.cwd || moduleDir;
  if (session.type === 'gateway') return session.cwd || path.join(homeDir(), '.multicc', 'gateway');
  if (stateOf(session) === 'awake' && session.worktreePath && existsSync(session.worktreePath)) return session.worktreePath;
  const safeId = String(session.id || 'unknown').replace(/[^A-Za-z0-9._-]/g, '-');
  return path.join(dataRoot, 'unavailable-workspaces', safeId);
}

async function initializeSessionWorktrees(options = {}) {
  const {
    records, directories, invalidSessions, realPathOf, isHomeOrAbove,
    ensureDirGitReady, addWorktree, existsSync = fs.existsSync,
    tmuxHasSession, tmuxKillSession, saveDirectories, saveSessions,
    auxSessionId, log = console,
  } = options;
  const seenPaths = new Map();
  const duplicateDirectories = new Set();
  for (const directory of [...directories.values()].sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))) {
    const resolved = realPathOf(directory.path);
    if (seenPaths.has(resolved)) duplicateDirectories.add(directory.id);
    else seenPaths.set(resolved, directory.id);
  }
  let built = 0;
  for (const session of records.values()) {
    if (session.type === 'aux' || session.id === auxSessionId || session.type === 'gateway') continue;
    if (session.workspaceOwnerSessionId) continue;
    if (['planned', 'hibernated', 'hibernating'].includes(stateOf(session))) continue;
    const directory = directories.get(session.dirId);
    if (!directory) { invalidSessions.set(session.id, 'no directory'); continue; }
    if (duplicateDirectories.has(directory.id)) { invalidSessions.set(session.id, 'duplicate directory path'); continue; }
    if (isHomeOrAbove(directory.path)) { invalidSessions.set(session.id, 'directory is $HOME or above'); continue; }
    if (session.worktreePath && existsSync(session.worktreePath)) continue;
    const ready = await ensureDirGitReady(directory);
    if (!ready.ok) { invalidSessions.set(session.id, `git not ready: ${ready.reason}`); continue; }
    try {
      const created = await addWorktree(directory.path, session.id, directory.baseBranch, {
        ...(session.taskBoundTaskId && session.branch ? { requireExistingBranch: true } : {}),
      });
      session.worktreePath = created.worktreePath;
      session.branch = created.branch;
      built += 1;
      if (session.kind === 'terminal' && await tmuxHasSession(session.id)) await tmuxKillSession(session.id);
    } catch (error) {
      invalidSessions.set(session.id, `worktree create failed: ${safeErrorCode(error, 'git_error')}`);
    }
  }
  if (built > 0 || invalidSessions.size > 0) { saveDirectories(); saveSessions('startup.worktree-migration'); }
  log.log?.(`[multicc] worktrees: ${built} built, ${invalidSessions.size} session(s) invalid`);
  return { built, invalid: invalidSessions.size };
}

module.exports = {
  DEFAULT_AWAKE_LIMIT,
  DEFAULT_HIBERNATE_BATCH_SIZE,
  DEFAULT_HIBERNATE_IDLE_MS,
  DEFAULT_HIBERNATE_INTERVAL_MS,
  DEFAULT_HIBERNATE_STARTUP_DELAY_MS,
  WORKSPACE_STATES,
  createSessionHibernationRuntime,
  evaluateSessionEligibility,
  inferLastWorkAt,
  initializeSessionWorktrees,
  resolveSessionCwd,
};
