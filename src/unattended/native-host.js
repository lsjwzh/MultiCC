'use strict';

const { getNative } = require('../native/binding');
const STATUS = Object.freeze({
  ACTIVE: 'active', ACHIEVED: 'achieved', NEEDS_HUMAN: 'needs_human',
  EXHAUSTED: 'exhausted', STOPPED: 'stopped', ERROR: 'error',
});
let policy;
function kernel() {
  return policy ||= getNative().unattendedKernelApi();
}

// The native supervisor owns the run. These adapters sample host services at
// the same boundaries as the scheduler and expose live JS callbacks to N-API.
function createUnattendedHost(options = {}) {
  const {
    getRecord, persistState, getHistory = () => [], setTaskState,
    getPendingQuestion = () => null, getAuxQueue = () => null,
    deliver, inject, withdrawQueued = null, notify = () => {}, broadcast = () => {},
    appendMessage = null, hasQueuedDeliveries, isRunActive = () => false,
    getRetryNotBefore = () => null, getTaskState = () => ({}),
    getSchedulerStatus = () => null, listSessionIds = () => [], now = Date.now,
    setTimeout: arm = setTimeout, clearTimeout: clear = clearTimeout, log = () => {},
  } = options;
  const busy = id => {
    try { return isRunActive(id) === true; } catch { return false; }
  };
  const backlog = async id => {
    if (typeof hasQueuedDeliveries !== 'function') return false;
    try { return (await hasQueuedDeliveries(id)) === true; } catch { return false; }
  };
  return getNative().unattendedHostApi({
    getRecord, persistState, getHistory, setTaskState, getPendingQuestion, getAuxQueue,
    deliver, inject, withdrawQueued, notify, broadcast, appendMessage, getTaskState,
    getSchedulerStatus, listSessionIds, now, log, setTimeout: arm, clearTimeout: clear,
    immediate: setImmediate, kernel: options.kernel || kernel(), busy, backlog,
    async safeSchedulerStatus(id) {
      try { return await getSchedulerStatus(id); } catch { return null; }
    },
    async readEvaluationFacts(id) {
      return { busy: busy(id), backlogPending: await backlog(id),
        classifyState: getTaskState(id)?.classifyState, pendingQuestion: await getPendingQuestion(id) };
    },
    async readTurnFacts(id, kind) {
      const backlogPending = kind === 'settle' ? await backlog(id) : false;
      let retryNotBefore;
      if (typeof getRetryNotBefore === 'function') {
        try {
          const value = Number(await getRetryNotBefore(id));
          if (Number.isFinite(value) && value > 0) retryNotBefore = value;
        } catch (error) {
          log(`[unattended] retryNotBefore read failed for ${id}: ${error?.message || error}`);
        }
      }
      return { backlogPending, retryNotBefore };
    },
    formatClock(at) {
      const date = new Date(Number(at));
      if (!Number.isFinite(date.getTime())) return '';
      return [date.getHours(), date.getMinutes()].map(n => String(n).padStart(2, '0')).join(':');
    },
  });
}
module.exports = { createUnattendedHost, STATUS, get kernel() { return kernel(); } };
