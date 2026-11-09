'use strict';

// Frozen oracle: the Node session-persistence lifecycle and task-state store as
// they were before the single native owner landed
// (src/session/persistence.js and src/routes/task-state-store.js at the parent
// commit). Do not edit to match new behaviour — the differential test exists to
// prove the native owner reproduces this exactly.
const { taskStatePayload: realTaskStatePayload } = require('../../src/chat/task-state-payload');

class LegacyPersistenceError extends Error {
  constructor(message, { source = 'unknown', cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'PersistenceError';
    this.code = 'SESSION_PERSISTENCE_FAILED';
    this.status = 500;
    this.source = source;
  }
}

function jsonClone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function snapshotMap(records) {
  return [...records.entries()].map(([key, value]) => [key, jsonClone(value)]);
}

function restoreMap(records, snapshot) {
  records.clear();
  for (const [key, value] of snapshot) records.set(key, jsonClone(value));
}

function payload(records) {
  return jsonClone([...records.values()]);
}

function createLegacySessionPersistence({
  records,
  store,
  onFailure = () => {},
  onState = () => {},
  retryDelayMs = 250,
  maxRetries = 3,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  if (!(records instanceof Map)) throw new TypeError('session persistence requires a records Map');
  if (!store || typeof store.save !== 'function') throw new TypeError('session persistence requires store.save');

  let dirty = false;
  let retryTimer = null;
  let retryAttempt = 0;
  let mutating = false;
  let lastFailure = null;

  function emitState() {
    try { onState({ dirty, retryAttempt, retryScheduled: !!retryTimer, lastFailure }); } catch (_) {}
  }

  function report(error, fields) {
    lastFailure = {
      at: new Date().toISOString(),
      source: fields.source,
      mode: fields.mode,
      attempt: fields.attempt || 0,
      message: error && error.message || String(error),
    };
    try { onFailure({ ...fields, dirty, error }); } catch (_) {}
    emitState();
  }

  function cancelRetry() {
    if (retryTimer) clearTimeoutFn(retryTimer);
    retryTimer = null;
    retryAttempt = 0;
  }

  function saveCurrent() {
    return store.save(payload(records));
  }

  function markClean() {
    dirty = false;
    lastFailure = null;
    cancelRetry();
    emitState();
  }

  function scheduleRetry(source) {
    if (retryTimer || retryAttempt >= maxRetries) return;
    retryTimer = setTimeoutFn(() => {
      retryTimer = null;
      retryAttempt += 1;
      try {
        saveCurrent();
        markClean();
      } catch (error) {
        dirty = true;
        report(error, { mode: 'best_effort_retry', source, attempt: retryAttempt });
        scheduleRetry(source);
      }
    }, retryDelayMs);
    if (retryTimer && typeof retryTimer.unref === 'function') retryTimer.unref();
    emitState();
  }

  function begin(source) {
    if (mutating) throw new LegacyPersistenceError('nested session persistence mutation', { source });
    const before = snapshotMap(records);
    const wasDirty = dirty;
    mutating = true;
    let active = true;
    function rollback() {
      if (!active) return;
      restoreMap(records, before);
      dirty = wasDirty;
      active = false;
      mutating = false;
      emitState();
    }
    function commit() {
      if (!active) throw new LegacyPersistenceError('session persistence transaction is closed', { source });
      try {
        saveCurrent();
        active = false;
        mutating = false;
        markClean();
      } catch (cause) {
        rollback();
        report(cause, { mode: 'required', source, attempt: 0 });
        throw new LegacyPersistenceError('session state could not be persisted', { source, cause });
      }
    }
    return Object.freeze({ commit, rollback });
  }

  function mutate(source, mutator) {
    if (typeof mutator !== 'function') throw new TypeError('session persistence mutate requires a function');
    const transaction = begin(source);
    let result;
    try {
      result = mutator(records);
      if (result && typeof result.then === 'function') {
        throw new TypeError('session persistence mutator must be synchronous');
      }
      transaction.commit();
      return result;
    } catch (error) {
      transaction.rollback();
      throw error;
    }
  }

  function bestEffort(source = 'runtime') {
    try {
      saveCurrent();
      markClean();
      return true;
    } catch (error) {
      dirty = true;
      report(error, { mode: 'best_effort', source, attempt: 0 });
      scheduleRetry(source);
      return false;
    }
  }

  function status() {
    return Object.freeze({ dirty, retryAttempt, retryScheduled: !!retryTimer, lastFailure: lastFailure && { ...lastFailure } });
  }

  function stop() {
    if (retryTimer) clearTimeoutFn(retryTimer);
    retryTimer = null;
    emitState();
  }

  return Object.freeze({ begin, mutate, bestEffort, status, stop });
}

const LEGACY_TASK_STATE_DEFAULTS = Object.freeze({
  goal: '', taskId: null, phase: 'idle', startedAt: null, endedAt: null,
  lastSummary: '', lastSummaryAt: null, lastTurnEndedAt: null,
  classifyState: null, goalState: null, pendingDispatches: [],
  classifyHistory: [],
  pendingUserInput: null, userInputSignalVersion: 0, userInputSignalTurnId: null,
  apiError: null,
  classifyUpdatedAt: null,
  cancelledAt: null, cancelReason: null, cancelSource: null,
  cancelOperationId: null,
});

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function createLegacyTaskStateStore(deps) {
  const {
    persistedSessions, saveBestEffort, chatBroadcast, workspaceBroadcast, bus,
    now = Date.now, taskStatePayload = realTaskStatePayload,
  } = deps;
  if (!bus || typeof bus.emit !== 'function') {
    throw new TypeError('[task-state-store] bus with emit() is required');
  }
  const TASK_STATE_DEFAULTS = LEGACY_TASK_STATE_DEFAULTS;

  function getTaskState(persisted) {
    if (!persisted) return { ...TASK_STATE_DEFAULTS };
    const ts = persisted.taskState || {};
    return { ...TASK_STATE_DEFAULTS, ...ts };
  }

  function setTaskState(sessionId, patch, opts = {}) {
    const persisted = persistedSessions.get(sessionId);
    if (!persisted) return null;
    const cur = getTaskState(persisted);
    const classifyChanged = hasOwn(patch, 'classifyState') && patch.classifyState !== cur.classifyState;
    const next = {
      ...cur,
      ...patch,
      ...(classifyChanged && !hasOwn(patch, 'classifyUpdatedAt') ? { classifyUpdatedAt: now() } : {}),
    };
    persisted.taskState = next;
    bus.emit('task:state-changed', sessionId, cur, next);
    if (opts.save !== false) saveBestEffort('runtime.task-state');
    const classifyPayload = taskStatePayload(next);
    try { chatBroadcast(sessionId, classifyPayload); } catch (_) {}
    if (persisted.dirId) {
      try { workspaceBroadcast(persisted.dirId, { ...classifyPayload, sessionId }); } catch (_) {}
    }
    return next;
  }

  return { getTaskState, setTaskState, TASK_STATE_DEFAULTS };
}

module.exports = {
  LegacyPersistenceError,
  createLegacySessionPersistence,
  createLegacyTaskStateStore,
  LEGACY_TASK_STATE_DEFAULTS,
  legacyJsonClone: jsonClone,
};
