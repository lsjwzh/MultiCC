'use strict';

function clean(value) { return value == null ? '' : String(value).trim(); }

function capturedLease(record) {
  const value = record && record.taskRunLease;
  const runId = clean(value && value.runId);
  const leaseEpoch = Number(value && value.leaseEpoch);
  return runId && Number.isSafeInteger(leaseEpoch) && leaseEpoch > 0
    ? Object.freeze({ runId, leaseEpoch })
    : null;
}

function sameLease(left, right) {
  if (!left || !right) return left === right;
  return left.runId === right.runId && left.leaseEpoch === right.leaseEpoch;
}

function drainError(message, code, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

function createTaskRunProviderBridge(options = {}) {
  const {
    records,
    recordActivity,
    recordLegacyUsage,
    recordTaskRunUsage,
    scheduleMicrotask = queueMicrotask,
  } = options;
  if (!(records instanceof Map)) throw new TypeError('[task-run-provider-bridge] records Map required');
  for (const [name, port] of Object.entries({ recordActivity, recordLegacyUsage, recordTaskRunUsage, scheduleMicrotask })) {
    if (typeof port !== 'function') throw new TypeError(`[task-run-provider-bridge] ${name} port required`);
  }

  const active = new Map();
  let generation = 0;

  function onActivity(event = {}) {
    const result = recordActivity(event);
    const sessionId = clean(event.sessionId);
    if (!sessionId) return result;
    if (event.phase === 'request') {
      const lease = capturedLease(records.get(sessionId));
      const previous = active.get(sessionId);
      if (previous && previous.count > 0) {
        previous.count += 1;
        if (!sameLease(previous.lease, lease)) previous.ambiguous = true;
      } else {
        active.set(sessionId, { lease, count: 1, generation: ++generation, ambiguous: false });
      }
    } else if (event.phase === 'end') {
      const current = active.get(sessionId);
      if (current) {
        current.count = Math.max(0, current.count - 1);
        if (current.count === 0) {
          const expected = current.generation;
          scheduleMicrotask(() => {
            const latest = active.get(sessionId);
            if (latest && latest.count === 0 && latest.generation === expected) active.delete(sessionId);
          });
        }
      }
    }
    return result;
  }

  function onUsageObserved(event = {}) {
    const legacy = recordLegacyUsage(event);
    const current = active.get(clean(event.sessionId));
    if (!current || !current.lease || current.ambiguous) {
      return Object.freeze({ legacy, taskRun: null });
    }
    const taskRunLease = { ...current.lease };
    const taskRun = recordTaskRunUsage({
      ...event,
      taskRunId: taskRunLease.runId,
      leaseEpoch: taskRunLease.leaseEpoch,
      taskRunLease,
    });
    return Object.freeze({ legacy, taskRun });
  }

  function drainState(sessionIdValue, expectedLease = null) {
    const sessionId = clean(sessionIdValue);
    const current = active.get(sessionId);
    if (!current) return Object.freeze({ drained: true, active: 0, ambiguous: false });
    const expected = expectedLease && {
      runId: clean(expectedLease.runId || expectedLease.taskRunId),
      leaseEpoch: Number(expectedLease.leaseEpoch),
    };
    const leaseMismatch = expected && (!expected.runId
      || !Number.isSafeInteger(expected.leaseEpoch) || expected.leaseEpoch < 1
      || !sameLease(current.lease, expected));
    const ambiguous = current.ambiguous || !!leaseMismatch;
    return Object.freeze({
      drained: current.count === 0 && !ambiguous,
      active: current.count,
      ambiguous,
    });
  }

  async function waitForDrain(sessionId, expectedLease, options = {}) {
    const timeoutMs = Number(options.timeoutMs ?? 5_000);
    const pollMs = Number(options.pollMs ?? 25);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0
        || !Number.isFinite(pollMs) || pollMs < 1) {
      throw new TypeError('[task-run-provider-bridge] valid drain timeout and poll interval required');
    }
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const state = drainState(sessionId, expectedLease);
      if (state.ambiguous) {
        throw drainError('provider producer lease is ambiguous',
          'TASK_RUN_PRODUCERS_DRAIN_AMBIGUOUS', { state });
      }
      if (state.drained) return state;
      if (Date.now() >= deadline) {
        throw drainError('provider producers did not drain before the deadline',
          'TASK_RUN_PRODUCERS_DRAIN_TIMEOUT', { state });
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(pollMs,
        Math.max(1, deadline - Date.now()))));
    }
  }

  return Object.freeze({ onActivity, onUsageObserved, drainState, waitForDrain });
}

module.exports = { capturedLease, createTaskRunProviderBridge };
