'use strict';

// Transactional persistence boundary for the shared persistedSessions Map.
// HTTP mutations use mutate(): snapshot memory, apply one synchronous mutation,
// atomically save the resulting payload, then commit by retaining that Map
// state. A save failure restores the snapshot and throws PersistenceError.
//
// Runtime/timer paths use bestEffort() explicitly. Those callers have already
// changed memory and cannot safely throw into an EventEmitter/timer callback, so
// failures mark the service dirty and schedule a bounded retry instead.

class PersistenceError extends Error {
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

function createSessionPersistence({
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
    if (mutating) throw new PersistenceError('nested session persistence mutation', { source });
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
      if (!active) throw new PersistenceError('session persistence transaction is closed', { source });
      try {
        saveCurrent();
        active = false;
        mutating = false;
        markClean();
      } catch (cause) {
        rollback();
        report(cause, { mode: 'required', source, attempt: 0 });
        throw new PersistenceError('session state could not be persisted', { source, cause });
      }
    }
    return Object.freeze({ commit, rollback });
  }

  // Strong path. The mutator must be synchronous so no timer/request can
  // observe or persist a half-mutated Map between snapshot and atomic save.
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

  // Runtime path. Never throws: retain the changed Map, mark it dirty and retry
  // the newest complete snapshot a bounded number of times.
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

module.exports = {
  PersistenceError,
  createSessionPersistence,
  jsonClone,
};
