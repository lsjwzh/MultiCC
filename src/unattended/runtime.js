'use strict';

// Server composition for the unattended supervisor. Kept out of server.js so the
// startup file only names ports; the persistence rule lives here with the host.
// Contract: docs/unattended-mode.md.

const { createUnattendedHost } = require('./host');
const kernel = require('./kernel');

const DURATION_DEFAULT = 120;
const MS_PER_MINUTE = 60_000;

function createUnattendedRuntime({
  persistedSessions,
  saveSessions,
  loadHistory,
  setTaskState,
  userInputSignalHost,
  getAuxQueue,
  taskContextHost,
  waitInjector,
  // Continuation admission for supervisor messages. When the server provides
  // `deliverInjection`, the host sees the scheduler admission result and can
  // withdraw a still-queued continuation on pause; the wait injector remains
  // the fallback for runtimes without the session delivery boundary.
  deliverInjection = null,
  withdrawQueued = null,
  triggerPush,
  chatBroadcast,
  logger,
  appendMessage = null,
  isRunActive = () => false,
  hasQueuedDeliveries = () => false,
  // Boot reconciliation (see host.reconcileStartup): the scheduler says whether
  // an interrupted turn still owns a slot, the task state names the cause.
  getTaskState = () => ({}),
  getSchedulerStatus = () => null,
  listSessionIds = () => [...persistedSessions.keys()],
}) {
  const getRecord = id => persistedSessions.get(id);
  function persistState(sessionId, next) {
    const record = getRecord(sessionId);
    if (!record) return null;
    if (next == null) delete record.unattended;
    else record.unattended = next;
    saveSessions('unattended.state');
    return record.unattended || null;
  }

  // A restart cannot have a verdict in flight: a persisted evaluating:true is
  // always stale and would leave every UI spinner stuck. Pre-v2 records also
  // predate `evaluating` / `pausedBy` / `stall.consecutiveFaults`; backfill them
  // once here so GET and the session schema always see the v2 shape.
  //
  // The round budget was replaced by a wall-clock deadline. Legacy records keep
  // `maxRounds` until this migration drops it (accepted-but-ignored on the wire,
  // never persisted again). An active record without a deadline gets a fresh
  // 120-minute window starting now; non-active records get a null-safe
  // startedAt/deadlineAt so the schema and DTO never see null.
  const clampMinutes = value => {
    const out = kernel.clampDuration({ maxDurationMinutes: value });
    return Number(out && out.maxDurationMinutes) || DURATION_DEFAULT;
  };
  const positive = value => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
  };
  let migrated = false;
  try {
    const at = Date.now();
    for (const record of persistedSessions.values()) {
      const state = record && record.unattended;
      if (!state || typeof state !== 'object') continue;
      if (state.evaluating !== false) {
        // Stale true from a crash, or missing on a pre-v2 record.
        state.evaluating = false;
        migrated = true;
      }
      if (state.pausedBy === undefined) { state.pausedBy = null; migrated = true; }
      if (state.stall && typeof state.stall === 'object' && state.stall.consecutiveFaults === undefined) {
        state.stall.consecutiveFaults = 0;
        migrated = true;
      }
      if ('maxRounds' in state) {
        delete state.maxRounds;
        migrated = true;
      }
      const minutes = clampMinutes(state.maxDurationMinutes);
      if (state.maxDurationMinutes !== minutes) {
        state.maxDurationMinutes = minutes;
        migrated = true;
      }
      if (state.status === 'active') {
        if (positive(state.deadlineAt) === null) {
          // A legacy active record: one full default window from boot.
          state.maxDurationMinutes = DURATION_DEFAULT;
          state.startedAt = at;
          state.deadlineAt = at + DURATION_DEFAULT * MS_PER_MINUTE;
          migrated = true;
        } else if (positive(state.startedAt) === null) {
          state.startedAt = positive(state.updatedAt) || at;
          migrated = true;
        }
      } else {
        const startedAt = positive(state.startedAt) || positive(state.updatedAt) || at;
        if (state.startedAt !== startedAt) {
          state.startedAt = startedAt;
          migrated = true;
        }
        if (positive(state.deadlineAt) === null) {
          state.deadlineAt = startedAt + state.maxDurationMinutes * MS_PER_MINUTE;
          migrated = true;
        }
      }
    }
  } catch (error) {
    logger.log?.(`[unattended] boot migration failed: ${error && error.message ? error.message : error}`);
  }
  if (migrated) {
    try { saveSessions('unattended.boot'); } catch (_) { /* best effort at boot */ }
  }

  const host = createUnattendedHost({
    getRecord,
    persistState,
    getHistory: id => loadHistory(id),
    setTaskState,
    getPendingQuestion: id => userInputSignalHost.pending(id),
    getAuxQueue,
    deliver: (...args) => taskContextHost.deliverSessionMessage(...args),
    inject: (id, text) => (typeof deliverInjection === 'function'
      ? deliverInjection(id, text)
      : waitInjector.injectSystemMsg(id, text, 0)),
    withdrawQueued: typeof withdrawQueued === 'function' ? withdrawQueued : null,
    notify: (...args) => triggerPush(...args),
    broadcast: (...args) => chatBroadcast(...args),
    appendMessage: appendMessage ? (id, message) => appendMessage(id, message) : null,
    hasQueuedDeliveries: id => hasQueuedDeliveries(id),
    isRunActive: id => isRunActive(id) === true,
    getTaskState: id => getTaskState(id),
    getSchedulerStatus: id => getSchedulerStatus(id),
    listSessionIds: () => listSessionIds(),
    log: message => logger.log?.(message) || console.log(message),
  });
  // Re-arm one expiry timer per persisted active session. A restart must still
  // expire a session whose deadline passes while no turn ever settles.
  for (const [sessionId, record] of persistedSessions.entries()) {
    if (record && record.unattended && record.unattended.status === 'active') host.rearmTimer(sessionId);
  }
  return host;
}

module.exports = { createUnattendedRuntime };
