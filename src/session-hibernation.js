'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_HIBERNATE_IDLE_MS = 7 * DAY_MS;
const DEFAULT_HIBERNATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_HIBERNATE_STARTUP_DELAY_MS = 30 * 1000;
const DEFAULT_HIBERNATE_BATCH_SIZE = 5;
const WORKSPACE_STATES = new Set(['awake', 'hibernating', 'hibernated', 'thawing']);
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
  nowMs = Date.now(), idleMs = DEFAULT_HIBERNATE_IDLE_MS, blockers = [],
} = {}) {
  const reasons = [];
  if (!record || record.kind !== 'chat') reasons.push('not_task_chat');
  if (!record?.taskBoundTaskId) reasons.push('not_task_bound');
  if (record?.taskExecutionSlot) reasons.push('task_execution_slot');
  if (record?.ephemeral) reasons.push('ephemeral');
  if (record?.experimental || record?.experimentalMode) reasons.push('experimental');
  if (record?.loginFlow) reasons.push('login_flow');
  if (record?.type && EXCLUDED_TYPES.has(record.type)) reasons.push(`type_${record.type}`);
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
  if (raw === 'WORKTREE_PATH_MISSING') return 'hibernate_path_missing';
  return /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(raw) ? raw : String(fallback || 'hibernate_failed');
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
  const batchSize = Math.max(1, Math.min(5, Number(options.batchSize) || DEFAULT_HIBERNATE_BATCH_SIZE));
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
      record.workspaceStateErrorCode = null;
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
    if (stateOf(record) === 'awake' && observed.pathExists && observed.valid !== false) return { ok: true, already: true };
    if (!observed.branchExists) {
      persistState(sessionId, 'runtime.thaw.branch-missing', current => {
        current.workspaceState = 'hibernated';
        current.workspaceStateErrorCode = 'hibernate_branch_missing';
      });
      publish('thaw', 'failure', sessionId, 'hibernate_branch_missing');
      return { ok: false, code: 'hibernate_branch_missing', workspaceUnavailable: true };
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

  async function hibernateUnlocked(sessionId, { eligibilityChecked = false } = {}) {
    const record = records.get(sessionId);
    if (!record) return { ok: false, code: 'session_not_found' };
    if (stateOf(record) === 'hibernated') return { ok: true, already: true };
    const preliminary = evaluateSessionEligibility(record, { nowMs: now(), idleMs });
    if (!eligibilityChecked && !preliminary.eligible) {
      publish('hibernate', 'skip', sessionId, preliminary.reasons[0] || 'ineligible');
      return { ok: false, skipped: true, code: preliminary.reasons[0] || 'ineligible' };
    }
    const blockers = await inspectBlockers(sessionId, record);
    const verdict = evaluateSessionEligibility(record, { nowMs: now(), idleMs, blockers });
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

  function sweep() {
    if (sweepPromise) return sweepPromise;
    const work = (async () => {
      const candidates = [];
      for (const record of records.values()) {
        const preliminary = evaluateSessionEligibility(record, { nowMs: now(), idleMs });
        if (!preliminary.eligible) {
          if (record?.taskBoundTaskId && record.kind === 'chat') publish('sweep', 'skip', record.id, preliminary.reasons[0] || 'ineligible');
          continue;
        }
        const blockers = await inspectBlockers(record.id, record);
        const verdict = evaluateSessionEligibility(record, { nowMs: now(), idleMs, blockers });
        if (verdict.eligible) candidates.push({ record, lastWorkMs: verdict.lastWorkMs });
        else if (record?.taskBoundTaskId && record.kind === 'chat') publish('sweep', 'skip', record.id, verdict.reasons[0] || 'ineligible');
      }
      candidates.sort((left, right) => left.lastWorkMs - right.lastWorkMs || left.record.id.localeCompare(right.record.id));
      let hibernated = 0;
      let failed = 0;
      for (const candidate of candidates.slice(0, batchSize)) {
        const result = await hibernate(candidate.record.id, { eligibilityChecked: true });
        if (result.ok && result.hibernated) hibernated += 1;
        else if (!result.skipped) failed += 1;
      }
      publish('sweep', 'success', null, null);
      return { ok: true, considered: candidates.length, hibernated, failed };
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
      if (!record?.taskBoundTaskId || record.kind !== 'chat') continue;
      const state = stateOf(record);
      if (state === 'awake') continue;
      const observed = await inspect(record);
      let next = state;
      let code = null;
      if (!observed.branchExists) {
        next = 'hibernated';
        code = 'hibernate_branch_missing';
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
    return serialized(sessionId, async () => {
      const awake = await ensureAwakeUnlocked(sessionId);
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
    await Promise.allSettled([...(sweepPromise ? [sweepPromise] : []), ...operations, ...tails.values()]);
  }

  function status() {
    return Object.freeze({ stopped, scheduled: !!timer, sweeping: !!sweepPromise, activeOperations: operations.size });
  }

  return Object.freeze({
    acquireDelivery,
    admit,
    assertAwake,
    ensureAwake,
    hibernate,
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
    if (['hibernated', 'hibernating'].includes(stateOf(session))) continue;
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
