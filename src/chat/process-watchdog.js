'use strict';

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_START_GRACE_MS = 12_000;
const DEFAULT_DEAD_CONFIRM_MS = 5_000;

function assertFunction(value, name) {
  if (typeof value !== 'function') {
    throw new TypeError(`[processing-watchdog] ${name} must be a function`);
  }
}

function createProcessingWatchdog(deps = {}) {
  for (const name of [
    'listRecords', 'getTaskState', 'getChatSession', 'getStreamStatus',
    'getPreparation', 'getSchedulerStatus', 'isPidAlive', 'cancelTurn',
  ]) assertFunction(deps[name], name);

  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const startGraceMs = Math.max(0, Number(deps.startGraceMs) || DEFAULT_START_GRACE_MS);
  const deadConfirmMs = Math.max(0, Number(deps.deadConfirmMs) || DEFAULT_DEAD_CONFIRM_MS);
  const logger = deps.logger || console;
  const suspects = new Map();
  let sweeping = false;

  function clearSuspect(sessionId) {
    suspects.delete(sessionId);
  }

  function childIsAlive(child) {
    if (!child || child.killed === true || child.exitCode !== null || child.signalCode != null) {
      return false;
    }
    return Number.isInteger(child.pid) && child.pid > 0 && deps.isPidAlive(child.pid);
  }

  async function inspect(sessionId, record, at) {
    const task = deps.getTaskState(record) || {};
    if (task.classifyState !== 'P') {
      clearSuspect(sessionId);
      return { sessionId, action: 'skip', reason: 'not_processing' };
    }
    if (task.cancelledAt) {
      clearSuspect(sessionId);
      return { sessionId, action: 'skip', reason: 'already_cancelled' };
    }

    const enteredAt = Number(task.classifyUpdatedAt || task.startedAt || 0);
    if (enteredAt > 0 && at - enteredAt < startGraceMs) {
      clearSuspect(sessionId);
      return { sessionId, action: 'skip', reason: 'start_grace' };
    }

    let scheduler;
    try {
      scheduler = await deps.getSchedulerStatus(sessionId);
    } catch (error) {
      clearSuspect(sessionId);
      return { sessionId, action: 'skip', reason: 'scheduler_unavailable' };
    }
    // At a durable turn boundary the process is expected to be gone while Aux
    // decides the final classify letter. That is not a dead P process.
    if (scheduler && ['assessing', 'frozen'].includes(scheduler.state)) {
      clearSuspect(sessionId);
      return { sessionId, action: 'skip', reason: 'awaiting_classify' };
    }

    const preparation = deps.getPreparation(sessionId) || {};
    if (preparation.phase && preparation.phase !== 'idle') {
      clearSuspect(sessionId);
      return { sessionId, action: 'alive', reason: `preparation_${preparation.phase}` };
    }

    const chat = deps.getChatSession(sessionId) || null;
    const stream = deps.getStreamStatus(sessionId) || null;
    const childAlive = childIsAlive(chat?.claudeProc);
    const streamAlive = !!(stream?.busy && stream?.alive
      && Number.isInteger(stream.pid) && deps.isPidAlive(stream.pid));
    if (childAlive || streamAlive) {
      clearSuspect(sessionId);
      return {
        sessionId,
        action: 'alive',
        reason: childAlive ? 'child_process' : 'persistent_stream',
      };
    }

    const firstSeenAt = suspects.get(sessionId);
    if (firstSeenAt == null) {
      suspects.set(sessionId, at);
      return { sessionId, action: 'suspect', reason: 'no_live_runner' };
    }
    if (at - firstSeenAt < deadConfirmMs) {
      return { sessionId, action: 'suspect', reason: 'confirming_dead_runner' };
    }

    suspects.delete(sessionId);
    const result = await deps.cancelTurn(sessionId, {
      reason: 'process_watchdog',
      killReason: 'process_watchdog',
      // Not a manual cancel: same canonical transition, different attribution,
      // so the recorded cancelSource can tell a user stop from a dead runner.
      source: 'process_watchdog',
    });
    logger.warn?.('processing_watchdog_cancelled_dead_turn', {
      sessionId,
      schedulerState: scheduler?.state || null,
      result: result?.code || (result?.ok ? 'ok' : 'unknown'),
    });
    return { sessionId, action: 'cancelled', reason: 'dead_runner', result };
  }

  async function sweep() {
    if (sweeping) return { ok: false, code: 'sweep_in_progress', results: [] };
    sweeping = true;
    const at = now();
    const results = [];
    try {
      for (const [sessionId, record] of deps.listRecords()) {
        if (!record || record.kind !== 'chat' || record.type === 'aux' || record.type === 'gateway') {
          clearSuspect(sessionId);
          continue;
        }
        try {
          results.push(await inspect(sessionId, record, at));
        } catch (error) {
          logger.warn?.('processing_watchdog_session_failed', {
            sessionId,
            error: error?.message || String(error),
          });
          results.push({ sessionId, action: 'error', reason: 'inspection_failed' });
        }
      }
      return { ok: true, results };
    } finally {
      sweeping = false;
    }
  }

  return Object.freeze({ sweep, inspect, clearSuspect });
}

module.exports = {
  createProcessingWatchdog,
  PROCESS_WATCHDOG_INTERVAL_MS: DEFAULT_INTERVAL_MS,
  PROCESS_WATCHDOG_START_GRACE_MS: DEFAULT_START_GRACE_MS,
  PROCESS_WATCHDOG_DEAD_CONFIRM_MS: DEFAULT_DEAD_CONFIRM_MS,
};
