'use strict';

const RUNNING_STATUSES = new Set(['thinking', 'editing', 'running']);
const SESSION_STATUSES = new Set([
  ...RUNNING_STATUSES, 'idle', 'waiting', 'succeeded', 'completed', 'error',
]);

function initialSessionState() {
  return Object.freeze({
    status: 'idle',
    lastActivity: 0,
    runStartedAt: null,
    runEndedAt: null,
  });
}

function isRunningStatus(status) {
  return RUNNING_STATUSES.has(status);
}

function normalizePrevious(previous) {
  if (!previous || typeof previous !== 'object') return initialSessionState();
  return {
    status: SESSION_STATUSES.has(previous.status) ? previous.status : 'idle',
    lastActivity: Math.max(0, Number(previous.lastActivity) || 0),
    runStartedAt: Number.isFinite(Number(previous.runStartedAt)) ? Number(previous.runStartedAt) : null,
    runEndedAt: Number.isFinite(Number(previous.runEndedAt)) ? Number(previous.runEndedAt) : null,
  };
}

function transitionSessionState(previous, patch = {}, { now = Date.now(), pendingWork = false } = {}) {
  const prev = normalizePrevious(previous);
  const requested = patch.status === undefined ? prev.status : patch.status;
  if (!SESSION_STATUSES.has(requested)) {
    throw new TypeError(`[session] unsupported status: ${requested}`);
  }
  const at = Number(now);
  if (!Number.isFinite(at) || at < 0) throw new TypeError('[session] transition time must be finite');

  const wasRunning = !!prev.runStartedAt && !prev.runEndedAt;
  let runStartedAt = prev.runStartedAt;
  let runEndedAt = prev.runEndedAt;
  if (isRunningStatus(requested)) {
    if (!wasRunning) {
      runStartedAt = at;
      runEndedAt = null;
    }
  } else if (wasRunning) {
    runEndedAt = at;
  }

  const status = pendingWork && !isRunningStatus(requested) && requested !== 'waiting'
    ? 'waiting'
    : requested;
  const state = Object.freeze({ status, lastActivity: at, runStartedAt, runEndedAt });
  return Object.freeze({
    state,
    changed: state.status !== prev.status,
    enteredRunning: !wasRunning && isRunningStatus(requested),
    leftRunning: wasRunning && !isRunningStatus(requested),
  });
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

module.exports = {
  RUNNING_STATUSES,
  SESSION_STATUSES,
  createSessionStateService,
  initialSessionState,
  isRunningStatus,
  transitionSessionState,
};
