'use strict';

function exactLease(item) {
  return {
    slotId: item.slotId,
    runId: item.runId,
    leaseEpoch: item.leaseEpoch,
  };
}

function matchesProjection(record, item) {
  return record?.taskRunLease?.runId === item.runId
    && Number(record.taskRunLease.leaseEpoch) === Number(item.leaseEpoch);
}

function clearMatchingProjection(record, item) {
  if (!record || !matchesProjection(record, item)) return false;
  delete record.taskRunLease;
  delete record.taskRunUsageError;
  delete record.taskRunQuarantined;
  return true;
}

function terminalRecoveryProof(status, item) {
  if (!status) return { action: 'none' };
  if (status.active) {
    const exactActive = status.active.taskRunId === item.runId
      && Number(status.active.leaseEpoch) === Number(item.leaseEpoch);
    return exactActive
      ? { action: 'none' }
      : { action: 'quarantine', code: 'TASK_RUN_SCHEDULER_LEASE_MISMATCH' };
  }
  const classifyState = String(status.classifyState || '');
  if (!['D', 'E', 'W', 'B'].includes(classifyState)) return { action: 'none' };
  const decision = status.lastDecision && typeof status.lastDecision === 'object'
    ? status.lastDecision : {};
  const exact = (!status.sessionId || status.sessionId === item.slotId)
    && ['complete', 'superseded'].includes(decision.action)
    && decision.taskRunId === item.runId
    && Number(decision.leaseEpoch) === Number(item.leaseEpoch);
  if (!exact) {
    return { action: 'quarantine', code: 'TASK_RUN_SCHEDULER_LEASE_MISMATCH' };
  }
  if (classifyState === 'W' || classifyState === 'B') return { action: 'retained' };
  return {
    action: 'recover',
    event: {
      type: 'completed',
      sessionId: item.slotId,
      entryId: decision.entryId || null,
      taskId: decision.taskId || item.taskId || null,
      taskRunId: item.runId,
      leaseEpoch: Number(item.leaseEpoch),
      classifyState,
      turnOutcome: classifyState === 'D' ? 'succeeded' : 'failed',
      reason: decision.reason || `recovered_${classifyState}`,
      attemptOutcome: decision.action === 'superseded' ? 'superseded' : null,
      at: Number(decision.at || status.updatedAt) || Date.now(),
      recovered: true,
    },
  };
}

function assertPorts(options) {
  if (!options?.store || typeof options.store.planSlotLeaseRecovery !== 'function'
      || typeof options.store.releaseSlotLease !== 'function'
      || typeof options.store.quarantineSlotLease !== 'function') {
    throw new TypeError('[task-run-recovery] authoritative store ports required');
  }
  if (!(options.records instanceof Map)) {
    throw new TypeError('[task-run-recovery] records Map required');
  }
  if (typeof options.persistRecords !== 'function') {
    throw new TypeError('[task-run-recovery] persistRecords port required');
  }
  const hasSchedulerStatus = options.getSchedulerStatus != null;
  const hasTerminalRecovery = options.recoverTerminal != null;
  if (hasSchedulerStatus !== hasTerminalRecovery
      || (hasSchedulerStatus && typeof options.getSchedulerStatus !== 'function')
      || (hasTerminalRecovery && typeof options.recoverTerminal !== 'function')) {
    throw new TypeError('[task-run-recovery] scheduler status and terminal recovery ports must be paired');
  }
}

async function reconcileTaskRunSlotLeases(options = {}) {
  assertPorts(options);
  const {
    store,
    records,
    persistRecords,
    resumeCleanup = null,
    resetSlot = null,
    getSchedulerStatus = null,
    recoverTerminal = null,
    log = () => {},
  } = options;
  const plan = store.planSlotLeaseRecovery();
  const summary = {
    restored: 0, reset: 0, released: 0, resumed: 0, terminalRecovered: 0,
    quarantined: 0, changed: false,
  };
  const plannedSlots = new Map();

  const markRecordQuarantined = (record) => {
    if (!record) return;
    record.taskRunQuarantined = true;
    summary.changed = true;
  };
  const quarantine = (item, code) => {
    const input = { ...exactLease(item), code: code || item.quarantineCode || 'RECOVERY_AMBIGUOUS' };
    if (item.action === 'quarantine_unleased') {
      if (typeof store.quarantineUnleasedRun === 'function') {
        store.quarantineUnleasedRun(input);
      }
    } else {
      const lease = store.getSlotLease(item.slotId);
      if (lease && lease.state !== 'released') store.quarantineSlotLease(input);
    }
    markRecordQuarantined(records.get(item.slotId));
    summary.quarantined += 1;
  };

  for (const item of plan) {
    const record = records.get(item.slotId);
    if (item.action !== 'quarantine_unleased') plannedSlots.set(item.slotId, item);
    if (item.action === 'restore_projection') {
      if (!record?.taskExecutionSlot) {
        quarantine(item, 'TASK_RUN_SLOT_RECORD_MISSING');
      } else if (record.taskRunQuarantined
          || (record.taskRunLease && !matchesProjection(record, item))) {
        quarantine(item, 'TASK_RUN_PROJECTION_CONFLICT');
      } else {
        record.taskRunLease = { runId: item.runId, leaseEpoch: item.leaseEpoch };
        delete record.taskRunQuarantined;
        summary.restored += 1;
        summary.changed = true;
        if (getSchedulerStatus && item.leaseState === 'active' && item.phase === 'ready') {
          let proof;
          try {
            proof = terminalRecoveryProof(await getSchedulerStatus(item.slotId), item);
          } catch (error) {
            proof = {
              action: 'quarantine',
              code: error?.code || 'TASK_RUN_SCHEDULER_STATUS_UNAVAILABLE',
            };
          }
          if (proof.action === 'quarantine') {
            quarantine(item, proof.code);
          } else if (proof.action === 'recover') {
            let result;
            try {
              result = await recoverTerminal(proof.event);
            } catch (error) {
              result = { ok: false, code: error?.code || 'TASK_RUN_TERMINAL_RECOVERY_FAILED' };
            }
            if (result?.ok === true) {
              summary.terminalRecovered += 1;
            } else {
              quarantine(item, result?.code || 'TASK_RUN_TERMINAL_RECOVERY_FAILED');
            }
          }
        }
      }
      continue;
    }
    if (item.action === 'reset_barrier') {
      if (!record?.taskExecutionSlot || typeof resetSlot !== 'function') {
        quarantine(item, !record?.taskExecutionSlot
          ? 'TASK_RUN_SLOT_RECORD_MISSING'
          : 'TASK_RUN_RESET_PORT_MISSING');
        continue;
      }
      if (record.taskRunQuarantined
          || (record.taskRunLease && !matchesProjection(record, item))) {
        quarantine(item, 'TASK_RUN_PROJECTION_CONFLICT');
        continue;
      }
      try {
        await resetSlot(item);
        store.markSlotLeaseReady(exactLease(item));
        record.taskRunLease = { runId: item.runId, leaseEpoch: item.leaseEpoch };
        delete record.taskRunQuarantined;
        summary.reset += 1;
        summary.restored += 1;
        summary.changed = true;
      } catch (error) {
        quarantine(item, error?.code || 'TASK_RUN_RESET_RECOVERY_FAILED');
        try { log(`[task-run] recovery reset quarantined ${item.runId}`); } catch (_) {}
      }
      continue;
    }
    if (item.action === 'release_stale') {
      store.releaseSlotLease(exactLease(item));
      clearMatchingProjection(record, item);
      summary.released += 1;
      summary.changed = true;
      continue;
    }
    if (item.action === 'resume_cleanup') {
      if (!record?.taskExecutionSlot || typeof resumeCleanup !== 'function') {
        quarantine(item, !record?.taskExecutionSlot
          ? 'TASK_RUN_SLOT_RECORD_MISSING'
          : 'TASK_RUN_CLEANUP_RESUMER_MISSING');
        continue;
      }
      if (record.taskRunLease && !matchesProjection(record, item)) {
        quarantine(item, 'TASK_RUN_PROJECTION_CONFLICT');
        continue;
      }
      record.taskRunLease = { runId: item.runId, leaseEpoch: item.leaseEpoch };
      try {
        await resumeCleanup(item);
        const run = store.getRun(item.runId);
        if (run?.cleanupState !== 'done') {
          quarantine(item, 'TASK_RUN_CLEANUP_NOT_DURABLE');
          continue;
        }
        store.releaseSlotLease(exactLease(item));
        clearMatchingProjection(record, item);
        summary.resumed += 1;
        summary.released += 1;
        summary.changed = true;
      } catch (error) {
        quarantine(item, error?.code || 'TASK_RUN_CLEANUP_RESUME_FAILED');
        try { log(`[task-run] recovery cleanup quarantined ${item.runId}`); } catch (_) {}
      }
      continue;
    }
    quarantine(item, item.quarantineCode || 'RECOVERY_AMBIGUOUS');
  }

  for (const [slotId, record] of records) {
    if (!record?.taskExecutionSlot || !record.taskRunLease || plannedSlots.has(slotId)) continue;
    const projection = {
      slotId,
      runId: record.taskRunLease.runId,
      leaseEpoch: Number(record.taskRunLease.leaseEpoch),
      action: 'quarantine_unleased',
    };
    let durableLease = null;
    let durableRun = null;
    try {
      durableLease = store.getSlotLease(slotId);
      durableRun = store.getRun(projection.runId);
    } catch (_) { /* ambiguity remains fail-closed below */ }
    const releasedExact = durableLease?.state === 'released'
      && durableLease.runId === projection.runId
      && Number(durableLease.leaseEpoch) === projection.leaseEpoch;
    const noDurableOwner = !durableLease;
    if (durableRun?.cleanupState === 'done' && (releasedExact || noDurableOwner)) {
      clearMatchingProjection(record, projection);
      summary.changed = true;
      continue;
    }
    try {
      if (typeof store.quarantineUnleasedRun === 'function') {
        store.quarantineUnleasedRun({ ...exactLease(projection), code: 'TASK_RUN_RECORD_ONLY_LEASE' });
      }
    } catch (_) { /* a missing historical run is still quarantined in the projection */ }
    markRecordQuarantined(record);
    summary.quarantined += 1;
  }

  if (summary.changed) await Promise.resolve(persistRecords('task-run-lease-recovery'));
  return summary;
}

module.exports = {
  reconcileTaskRunSlotLeases,
  terminalRecoveryProof,
};
