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
    log: message => logger.log?.(message) || console.log(message),
  });
}

module.exports = { createUnattendedRuntime };
