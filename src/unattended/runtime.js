'use strict';

// Server composition for the unattended supervisor. Kept out of server.js so the
// startup file only names ports; the persistence rule lives here with the host.
// Contract: docs/unattended-mode.md.

const { createUnattendedHost } = require('./host');

function createUnattendedRuntime({
  persistedSessions,
  saveSessions,
  loadHistory,
  setTaskState,
  userInputSignalHost,
  getAuxQueue,
  taskContextHost,
  waitInjector,
  triggerPush,
  chatBroadcast,
  logger,
  appendMessage = null,
  isRunActive = () => false,
  hasQueuedDeliveries = () => false,
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
  let migrated = false;
  try {
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
    }
  } catch (error) {
    logger.log?.(`[unattended] boot migration failed: ${error && error.message ? error.message : error}`);
  }
  if (migrated) {
    try { saveSessions('unattended.boot'); } catch (_) { /* best effort at boot */ }
  }

  return createUnattendedHost({
    getRecord,
    persistState,
    getHistory: id => loadHistory(id),
    setTaskState,
    getPendingQuestion: id => userInputSignalHost.pending(id),
    getAuxQueue,
    deliver: (...args) => taskContextHost.deliverSessionMessage(...args),
    inject: (id, text) => waitInjector.injectSystemMsg(id, text, 0),
    notify: (...args) => triggerPush(...args),
    broadcast: (...args) => chatBroadcast(...args),
    appendMessage: appendMessage ? (id, message) => appendMessage(id, message) : null,
    hasQueuedDeliveries: id => hasQueuedDeliveries(id),
    isRunActive: id => isRunActive(id) === true,
    log: message => logger.log?.(message) || console.log(message),
  });
}

module.exports = { createUnattendedRuntime };
