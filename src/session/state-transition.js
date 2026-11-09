'use strict';

// Compatibility surface; the vocabulary and transition policy have one Rust owner.
const { getNative } = require('../native/runtime');
const native = getNative();
const catalog = native.sessionStateCatalog();
const RUNNING_STATUSES = new Set(catalog.runningStatuses);
const SESSION_STATUSES = new Set(catalog.sessionStatuses);
function initialSessionState() { return native.sessionStateInitial(); }
function isRunningStatus(status) { return native.sessionStateIsRunning(status); }
function transitionSessionState(previous, patch = {}, { now = Date.now(), pendingWork = false } = {}) {
  return native.sessionStateTransition(previous, patch, now, pendingWork);
}

function createSessionStateService({ clock = Date.now, hasPendingWork = () => false } = {}) {
  if (typeof clock !== 'function' || typeof hasPendingWork !== 'function') {
    throw new TypeError('[session] clock and hasPendingWork must be functions');
  }
  return Object.freeze({
    initial: initialSessionState,
    transition(sessionId, previous, patch) {
      return transitionSessionState(previous, patch, {
        now: clock(),
        pendingWork: !!hasPendingWork(sessionId),
      });
    },
  });
}

module.exports = { RUNNING_STATUSES, SESSION_STATUSES, createSessionStateService,
  initialSessionState, isRunningStatus, transitionSessionState };
