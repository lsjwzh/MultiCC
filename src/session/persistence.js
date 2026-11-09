'use strict';

// Runtime-facing adapter over the single native session-record owner
// (native/addon/src/session_records.rs). The record table, the dirty/retry
// state, the transaction snapshot, the sessions.json writer, `.bak` rotation and
// fsyncs all live in Rust; this module only translates failures into the stable
// `PersistenceError` shape the HTTP layer and tests assert on.
//
// HTTP mutations use mutate(): Rust snapshots, runs one synchronous mutator,
// atomically saves the resulting payload, then retains that table state. A save
// failure restores the snapshot before the error leaves this module.
//
// Runtime/timer paths use bestEffort() explicitly. Those callers have already
// changed memory and cannot safely throw into an EventEmitter/timer callback, so
// failures mark the service dirty and schedule a bounded retry instead.

const { sessionRecordsOwner } = require('./records');

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

function createSessionPersistence({
  records,
  store,
  file,
  kind = 'sessions',
  root,
  onFailure = () => {},
  onState = () => {},
  retryDelayMs = 250,
  maxRetries = 3,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  if (!(records instanceof Map)) throw new TypeError('session persistence requires a records Map');
  const owner = sessionRecordsOwner(records);
  if (!owner) throw new TypeError('session persistence requires the native session record owner');
  if (store !== undefined && (!store || typeof store.save !== 'function')) {
    throw new TypeError('session persistence requires store.save');
  }
  if (store === undefined && (typeof file !== 'string' || file.length === 0)) {
    throw new TypeError('session persistence requires a durable file');
  }
  const ports = {
    stringify: JSON.stringify,
    onFailure,
    onState,
    setTimeout: setTimeoutFn,
    clearTimeout: clearTimeoutFn,
    retryTick: () => owner.retryTick(),
    retryDelayMs,
    maxRetries,
  };
  if (store !== undefined) {
    // Test seam: the historical store port receives a detached JSON snapshot.
    ports.storeSave = value => store.save(value);
  } else {
    ports.file = file;
    ports.kind = kind;
    if (typeof root === 'string' && root.length > 0) ports.root = root;
  }
  owner.configure(ports);

  function unexpected(status) {
    return new PersistenceError(`session persistence returned unexpected status ${status}`);
  }

  // Strong path. The mutator must be synchronous so no timer/request can
  // observe or persist a half-mutated table between snapshot and atomic save.
  function mutate(source, mutator) {
    if (typeof mutator !== 'function') {
      throw new TypeError('session persistence mutate requires a function');
    }
    const outcome = owner.mutate(source, records, mutator);
    switch (outcome.status) {
      case 'ok': return outcome.value;
      case 'nested':
        throw new PersistenceError('nested session persistence mutation', { source });
      case 'async':
        // The mutation is already rolled back natively.
        throw new TypeError('session persistence mutator must be synchronous');
      case 'snapshot':
        // A record that cannot be JSON-serialized: the raw TypeError, as before.
        throw outcome.error;
      case 'mutator':
        throw outcome.error;
      case 'required':
        throw new PersistenceError('session state could not be persisted', {
          source, cause: outcome.error,
        });
      default:
        throw unexpected(outcome.status);
    }
  }

  // Manual transaction for handlers that validate between the mutation and the
  // save. Mirrors the legacy frozen {commit, rollback} pair exactly.
  function begin(source) {
    const opened = owner.begin(source);
    if (opened.status === 'nested') {
      throw new PersistenceError('nested session persistence mutation', { source });
    }
    if (opened.status === 'snapshot') throw opened.error;
    if (opened.status !== 'ok') throw unexpected(opened.status);
    const token = opened.token;
    let active = true;
    return Object.freeze({
      commit() {
        if (!active) {
          throw new PersistenceError('session persistence transaction is closed', { source });
        }
        active = false;
        const outcome = owner.commit(token, source);
        if (outcome.status === 'ok') return;
        if (outcome.status === 'required') {
          throw new PersistenceError('session state could not be persisted', {
            source, cause: outcome.error,
          });
        }
        throw new PersistenceError('session persistence transaction is closed', { source });
      },
      rollback() {
        if (!active) return;
        active = false;
        owner.rollback(token);
      },
    });
  }

  // Runtime path. Never throws: retain the changed table, mark it dirty and
  // retry the newest complete snapshot a bounded number of times.
  function bestEffort(source = 'runtime') {
    return owner.bestEffort(source);
  }

  function status() {
    const snapshot = owner.status();
    return Object.freeze({
      dirty: snapshot.dirty,
      retryAttempt: snapshot.retryAttempt,
      retryScheduled: snapshot.retryScheduled,
      lastFailure: snapshot.lastFailure && { ...snapshot.lastFailure },
    });
  }

  function stop() {
    owner.stop();
  }

  return Object.freeze({ begin, mutate, bestEffort, status, stop });
}

module.exports = {
  PersistenceError,
  createSessionPersistence,
  jsonClone,
};
