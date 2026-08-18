'use strict';

const crypto = require('node:crypto');
const { createUsageObserved, validateUsageObserved } = require('./usage-observed');
const { assertProviderBinding } = require('./provider-binding');
const { isTaskRunWrapperText } = require('./task-run-context');
const { describeRunFailure, recordRunError } = require('./task-run-errors');

const TASK_RUN_CLIS = new Set(['claude', 'codex']);
const TERMINAL_EXECUTION_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

function clean(value) { return value == null ? '' : String(value).trim(); }

function plainTextOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(block => block && block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('\n');
  }
  return '';
}

function stableMessageId(runId, message) {
  if (message?.id) return String(message.id).slice(0, 256);
  const material = JSON.stringify([
    runId, message?.role || '', message?.ts || 0, message?.content ?? '',
  ]);
  return `message:${crypto.createHash('sha256').update(material).digest('hex').slice(0, 32)}`;
}

function stableMainUsageEventId(payload = {}) {
  const material = [
    clean(payload.taskRunId || payload.runId), clean(payload.sessionId), clean(payload.turnId),
    clean(payload.runnerId), clean(payload.idempotencyKey),
  ].join('\u0000');
  return `tru_${crypto.createHash('sha256').update(material).digest('hex').slice(0, 32)}`;
}

function executionStatus(event) {
  if (event?.attemptOutcome === 'cancelled' || event?.reason === 'cancelled') return 'cancelled';
  if (event?.turnOutcome === 'failed' || event?.classifyState === 'E') return 'failed';
  return 'succeeded';
}

function explicitUsageLease(event = {}) {
  const nested = event.taskRunLease && typeof event.taskRunLease === 'object'
    ? event.taskRunLease
    : {};
  const directTaskRunId = clean(event.taskRunId);
  const directAliasRunId = clean(event.runId);
  const directRunId = directTaskRunId || directAliasRunId;
  const nestedRunId = clean(nested.runId || nested.taskRunId);
  const directEpoch = event.leaseEpoch == null ? null : Number(event.leaseEpoch);
  const nestedEpoch = nested.leaseEpoch == null ? null : Number(nested.leaseEpoch);
  if ((directTaskRunId && directAliasRunId && directTaskRunId !== directAliasRunId)
      || (directRunId && nestedRunId && directRunId !== nestedRunId)
      || (directEpoch != null && nestedEpoch != null && directEpoch !== nestedEpoch)) {
    return Object.freeze({ ok: false, code: 'task_run_usage_lease_conflict' });
  }
  const runId = directRunId || nestedRunId;
  const leaseEpoch = directEpoch == null ? nestedEpoch : directEpoch;
  if (!runId || !Number.isSafeInteger(leaseEpoch) || leaseEpoch < 1) {
    return Object.freeze({ ok: false, code: 'task_run_usage_lease_required' });
  }
  return Object.freeze({ ok: true, runId, leaseEpoch });
}

function cliForUsage(event, protocol) {
  const explicit = clean(event && event.cli).toLowerCase();
  if (explicit) return explicit;
  const normalized = clean(protocol).toLowerCase();
  if (normalized.includes('anthropic')) return 'claude';
  if (normalized.includes('openai')) return 'codex';
  return '';
}

function taskRunUsageEvent(event, observed) {
  const rawTokens = event && event.tokens && typeof event.tokens === 'object'
    ? event.tokens
    : {};
  const tokens = observed.tokens == null ? null : Object.freeze({
    input: observed.tokens.input,
    output: observed.tokens.output,
    cacheRead: observed.tokens.cacheRead,
    cacheWrite: observed.tokens.cacheWrite,
    reasoning: Number.isSafeInteger(Number(rawTokens.reasoning)) && Number(rawTokens.reasoning) >= 0
      ? Number(rawTokens.reasoning)
      : 0,
  });
  return Object.freeze({
    eventId: observed.eventId,
    sourceEventId: observed.sourceEventId,
    occurredAt: observed.occurredAt,
    providerId: observed.providerId,
    providerName: observed.providerName || observed.providerId,
    cli: cliForUsage(event, observed.protocol),
    protocol: observed.protocol,
    model: observed.model,
    roleKind: observed.roleKind,
    agentRole: observed.agentRole,
    routeName: observed.routeName,
    source: observed.source,
    coverage: observed.coverage,
    status: observed.status,
    tokens,
    ...(observed.latencyMs ? { latencyMs: observed.latencyMs } : {}),
    ...(observed.statusCode == null ? {} : { statusCode: observed.statusCode }),
    ...(observed.errorCode ? { errorCode: observed.errorCode } : {}),
  });
}

function hasRoleCoverage(usage, roleKind) {
  return Array.isArray(usage && usage.dimensions) && usage.dimensions.some(dimension => (
    dimension && dimension.roleKind === roleKind
    && (Number(dimension.observedEvents || 0) > 0
      || Number(dimension.unobservableEvents || 0) > 0)
  ));
}

function createTaskRunHost(options = {}) {
  const {
    store,
    records,
    closeNative,
    clearNativeState,
    deleteChatHistory,
    resetChatState,
    resetRoleUsage,
    persistRecords,
    providerSnapshot = () => ({}),
    finalizeRun = null,
    cleanupRun = null,
    onRunUpdated = () => {},
    getTaskState = () => null,
    onRunFailed = null,
    log = () => {},
  } = options;
  if (!store || typeof store.getRun !== 'function' || typeof store.bindRunSlot !== 'function'
      || typeof store.observeUsage !== 'function') {
    throw new TypeError('[task-run-host] store port required');
  }
  if (!(records instanceof Map)) throw new TypeError('[task-run-host] records Map required');
  if (finalizeRun != null && typeof finalizeRun !== 'function') {
    throw new TypeError('[task-run-host] finalizeRun port must be a function');
  }
  if (typeof onRunUpdated !== 'function') {
    throw new TypeError('[task-run-host] onRunUpdated port must be a function');
  }
  if (typeof getTaskState !== 'function') {
    throw new TypeError('[task-run-host] getTaskState port must be a function');
  }
  if (onRunFailed != null && typeof onRunFailed !== 'function') {
    throw new TypeError('[task-run-host] onRunFailed port must be a function');
  }
  for (const [name, value] of Object.entries({
    closeNative, clearNativeState, deleteChatHistory, resetChatState,
    resetRoleUsage, persistRecords,
  })) {
    if (typeof value !== 'function') throw new TypeError(`[task-run-host] ${name} port required`);
  }

  async function resetSlot(sessionId, record) {
    await Promise.resolve(closeNative(sessionId));
    await Promise.resolve(clearNativeState(record));
    await Promise.resolve(deleteChatHistory(sessionId));
    await Promise.resolve(resetChatState(sessionId));
    await Promise.resolve(resetRoleUsage(sessionId));
  }

  const finalizers = new Map();
  const finalizerStatuses = new Map();

  async function notifyRunUpdated(runId, taskId, state) {
    try {
      await Promise.resolve(onRunUpdated({ runId, taskId, ...state }));
    } catch (error) {
      log(`[task-run] update notification failed ${error?.code || error?.message || 'unknown'}`);
    }
  }

  function taskIdForUpdate(runId, event) {
    if (event?.taskId) return event.taskId;
    try { return store.getRun(runId).taskId || null; } catch (_) { return null; }
  }

  async function beforeDeliver(descriptor = {}) {
    const runId = String(descriptor.taskRunId || '').trim();
    if (!runId) return { ok: true, skipped: true };
    const sessionId = String(descriptor.sessionId || '').trim();
    const record = records.get(sessionId);
    if (!record) throw Object.assign(new Error('task execution slot not found'), { code: 'TASK_RUN_SLOT_NOT_FOUND' });
    if (record.taskExecutionSlot !== true) {
      throw Object.assign(new Error('TaskRun delivery requires an internal execution slot'), {
        code: 'TASK_RUN_SLOT_REQUIRED',
      });
    }
    if (!TASK_RUN_CLIS.has(clean(record.cli).toLowerCase())) {
      throw Object.assign(new Error('TaskRun execution slot CLI is unsupported'), {
        code: 'TASK_RUN_CLI_UNSUPPORTED',
      });
    }
    const run = store.getRun(runId);
    if (run.taskId !== descriptor.taskId) {
      throw Object.assign(new Error('task run identity mismatch'), { code: 'TASK_RUN_TASK_MISMATCH' });
    }
    if (run.executionStatus !== 'running' || run.usageStatus !== 'collecting'
        || run.cleanupState !== 'blocked') {
      throw Object.assign(new Error('task run is already terminal'), { code: 'TASK_RUN_CLOSED' });
    }
    const leaseEpoch = Number(descriptor.leaseEpoch);
    if (!Number.isSafeInteger(leaseEpoch) || leaseEpoch < 1) {
      throw Object.assign(new Error('task run lease epoch invalid'), { code: 'TASK_RUN_LEASE_INVALID' });
    }
    if (Number.isSafeInteger(Number(run.leaseEpoch)) && Number(run.leaseEpoch) !== leaseEpoch) {
      throw Object.assign(new Error('task run lease epoch is stale'), {
        code: 'TASK_RUN_LEASE_STALE',
      });
    }
    if (record.taskRunQuarantined) {
      throw Object.assign(new Error('task execution slot is quarantined'), { code: 'TASK_RUN_SLOT_QUARANTINED' });
    }
    const current = record.taskRunLease;
    const sameProjection = current?.runId === runId && current?.leaseEpoch === leaseEpoch;
    if (current && !sameProjection) {
      const prior = store.getRun(current.runId);
      if (prior.cleanupState !== 'done') {
        throw Object.assign(new Error('previous task run has not completed cleanup'), {
          code: 'TASK_RUN_SLOT_CLEANUP_PENDING',
        });
      }
    }
    const exactLease = { runId, slotId: sessionId, leaseEpoch };
    let authoritative;
    let leaseAcquired = false;
    try {
      authoritative = typeof store.acquireSlotLease === 'function'
        ? store.acquireSlotLease(exactLease)
        : (store.bindRunSlot({ runId, slotId: sessionId }), {
          ...exactLease, phase: current?.runId === runId ? 'ready' : 'acquired',
        });
      leaseAcquired = true;
      if (authoritative?.phase === 'ready') {
        record.taskRunLease = { runId, leaseEpoch };
        const persisted = await Promise.resolve(persistRecords('task-run-slot-lease'));
        if (persisted !== true) {
          throw Object.assign(new Error('slot lease projection was not durable'), {
            code: 'TASK_RUN_SLOT_PROJECTION_PERSIST_FAILED',
          });
        }
        return { ok: true, duplicate: true };
      }
      if (authoritative?.phase !== 'acquired') {
        throw Object.assign(new Error('slot reset barrier is invalid'), {
          code: 'TASK_RUN_SLOT_BARRIER_INVALID',
        });
      }
      await resetSlot(sessionId, record);
      if (typeof store.markSlotLeaseReady === 'function') {
        authoritative = store.markSlotLeaseReady(exactLease);
        if (authoritative?.phase !== 'ready') {
          throw Object.assign(new Error('slot reset barrier was not persisted'), {
            code: 'TASK_RUN_SLOT_BARRIER_NOT_READY',
          });
        }
      }
      record.taskRunLease = { runId, leaseEpoch };
      const persisted = await Promise.resolve(persistRecords('task-run-slot-lease'));
      if (persisted !== true) {
        throw Object.assign(new Error('slot lease projection was not durable'), {
          code: 'TASK_RUN_SLOT_PROJECTION_PERSIST_FAILED',
        });
      }
      return { ok: true, runId, sessionId, leaseEpoch };
    } catch (error) {
      if (leaseAcquired) record.taskRunLease = { runId, leaseEpoch };
      record.taskRunQuarantined = true;
      if (leaseAcquired && typeof store.quarantineSlotLease === 'function') {
        try {
          store.quarantineSlotLease({ ...exactLease,
            code: error?.code || 'TASK_RUN_FRESH_BARRIER_FAILED' });
        } catch (_) {}
      }
      await Promise.resolve(persistRecords('task-run-slot-quarantine')).catch(() => {});
      throw error;
    }
  }

  function recordMessage(sessionId, message = {}) {
    const runId = String(message.taskRunId || '').trim();
    if (!runId) return false;
    const run = store.getRun(runId);
    const record = records.get(sessionId);
    const leaseEpoch = Number(message.leaseEpoch);
    if (!Number.isSafeInteger(leaseEpoch) || leaseEpoch < 1) {
      throw Object.assign(new Error('task run message lease epoch invalid'), {
        code: 'TASK_RUN_MESSAGE_LEASE_REQUIRED',
      });
    }
    if (!record?.taskRunLease || record.taskRunLease.runId !== runId
        || Number(record.taskRunLease.leaseEpoch) !== leaseEpoch) {
      throw Object.assign(new Error('task run message lease is stale'), {
        code: 'TASK_RUN_MESSAGE_LEASE_STALE',
      });
    }
    if (run.slotId !== sessionId) {
      throw Object.assign(new Error('task run message belongs to another slot'), {
        code: 'TASK_RUN_MESSAGE_SLOT_MISMATCH',
      });
    }
    if (run.executionStatus !== 'running' || run.usageStatus !== 'collecting'
        || run.cleanupState !== 'blocked') {
      throw Object.assign(new Error('task run message arrived after terminal state'), {
        code: 'TASK_RUN_MESSAGE_CLOSED',
      });
    }
    if (message.taskId && run.taskId !== message.taskId) {
      throw Object.assign(new Error('task run message task mismatch'), { code: 'TASK_RUN_MESSAGE_TASK_MISMATCH' });
    }
    const existing = store.getRunMessages(runId);
    if (message.role === 'user' && message.taskStart === true
        && existing.some(item => item.kind === 'admission')) return true;
    // Transport wrappers (compiled context wall / routed scaffold) are marked
    // at write time so every reader — board projection, next-turn compile —
    // can exclude them structurally instead of re-parsing text.
    const wrapper = message.role === 'user'
      && isTaskRunWrapperText(plainTextOf(message.content));
    store.appendMessage({
      runId,
      messageId: stableMessageId(runId, message),
      role: message.role || 'unknown',
      kind: message.kind || 'message',
      content: message.content ?? '',
      metadata: {
        leaseEpoch,
        deliveryId: message.deliveryId || null,
        ...(wrapper ? { wrapper: true } : {}),
        // A partial checkpoint is a draft, not a final answer; keep the flag
        // so the conversation view can render it as interrupted output.
        ...(message.partial === true ? { partial: true } : {}),
      },
      createdAt: Number.isSafeInteger(Number(message.ts)) ? Number(message.ts) : Date.now(),
    });
    return true;
  }

  function persistFencedUsage(event, observed, usageEvent) {
    const lease = explicitUsageLease(event);
    if (!lease.ok) return { ok: false, code: lease.code };
    const record = records.get(observed.sessionId);
    const current = record && record.taskRunLease;
    if (!current || current.runId !== lease.runId || current.leaseEpoch !== lease.leaseEpoch) {
      return { ok: false, code: 'stale_task_run_lease' };
    }

    let run;
    try {
      run = store.getRun(lease.runId);
    } catch (error) {
      return { ok: false, code: error?.code || 'TASK_RUN_NOT_FOUND' };
    }
    if (run.slotId !== observed.sessionId
        || run.executionStatus !== 'running'
        || run.usageStatus !== 'collecting'
        || run.cleanupState !== 'blocked') {
      return { ok: false, code: 'task_run_usage_closed' };
    }
    if (event.taskId && run.taskId !== event.taskId) {
      return { ok: false, code: 'task_run_usage_task_mismatch' };
    }

    try {
      const result = store.observeUsage({ runId: lease.runId, event: usageEvent }) || {};
      return {
        ok: true,
        runId: lease.runId,
        eventId: usageEvent.eventId,
        revision: result.revision,
        inserted: result.inserted === true,
        duplicate: result.duplicate === true,
        corrected: result.corrected === true,
      };
    } catch (error) {
      const code = error?.code || 'TASK_RUN_USAGE_STORE_FAILED';
      record.taskRunUsageError = { runId: lease.runId, leaseEpoch: lease.leaseEpoch, code };
      try { Promise.resolve(persistRecords('task-run-usage-error')).catch(() => {}); } catch (_) {}
      log(`[task-run] observed usage rejected ${code}`);
      return { ok: false, code };
    }
  }

  function recordObservedUsage(event = {}) {
    let observed;
    try {
      observed = validateUsageObserved(event);
    } catch (error) {
      return { ok: false, code: error?.code || 'INVALID_USAGE_OBSERVED' };
    }
    // Root-turn usage is reconciled by chat finalization. Provider proxy
    // observations are only an independent source for sub/aux producers.
    if (observed.roleKind === 'main') {
      return { ok: true, skipped: true, code: 'main_usage_owned_by_chat_final' };
    }
    return persistFencedUsage(event, observed, taskRunUsageEvent(event, observed));
  }

  function recordMainUsage(payload = {}) {
    const rawEvent = payload.event && typeof payload.event === 'object' ? payload.event : {};
    let binding;
    let observed;
    try {
      binding = assertProviderBinding(payload.providerBinding);
      if (clean(rawEvent.cli).toLowerCase() !== binding.cli) {
        return { ok: false, code: 'USAGE_BINDING_MISMATCH' };
      }
      observed = createUsageObserved({
        ...rawEvent,
        sessionId: payload.sessionId,
      }, binding);
    } catch (error) {
      return { ok: false, code: error?.code || 'INVALID_USAGE_OBSERVED' };
    }
    if (observed.roleKind !== 'main') {
      return { ok: false, code: 'TASK_RUN_MAIN_USAGE_ROLE_INVALID' };
    }
    const eventId = clean(payload.eventId || rawEvent.eventId);
    if (!eventId || eventId !== stableMainUsageEventId(payload)
        || (payload.eventId && rawEvent.eventId && payload.eventId !== rawEvent.eventId)) {
      return { ok: false, code: 'TASK_RUN_USAGE_EVENT_ID_INVALID' };
    }
    const usageEvent = Object.freeze({
      ...taskRunUsageEvent(rawEvent, observed),
      eventId,
      sourceEventId: clean(rawEvent.sourceEventId) || null,
    });
    return persistFencedUsage(payload, observed, usageEvent);
  }

  async function finalizeTerminal(event, record, sessionId, runId, leaseEpoch) {
    let permit = null;
    try {
      const usageError = record.taskRunUsageError;
      if (usageError?.runId === runId && usageError?.leaseEpoch === leaseEpoch) {
        throw Object.assign(new Error('task run usage was not durably persisted'), {
          code: 'TASK_RUN_USAGE_PERSIST_FAILED', causeCode: usageError.code,
        });
      }
      if (!finalizeRun) {
        throw Object.assign(new Error('task run finalizer is unavailable'), {
          code: 'TASK_RUN_FINALIZER_REQUIRED',
        });
      }
      const evidence = await Promise.resolve(finalizeRun({
        runId, slotId: sessionId, leaseEpoch, record, event,
      }));
      if (evidence?.outcomeDurable !== true || evidence?.producersDrained !== true
          || evidence?.nativeTranscriptChecked !== true) {
        throw Object.assign(new Error('task run finalization evidence is incomplete'), {
          code: 'TASK_RUN_FINALIZATION_EVIDENCE_INCOMPLETE',
        });
      }
      const status = executionStatus(event);
      // A terminal failure must explain itself in the ledger before the run
      // seals: the slot transcript is scrubbed right after, so this system
      // entry is the only durable record of *why* the run failed. It is
      // best-effort — a visibility write must never block finalization.
      let failure = null;
      if (status === 'failed') {
        let apiError = null;
        try {
          apiError = getTaskState(record)?.apiError || null;
        } catch (_) { apiError = null; }
        failure = describeRunFailure({ event, apiError });
        try {
          recordRunError(store, {
            runId,
            code: failure.code,
            category: failure.category,
            retryable: failure.retryable,
            message: failure.text,
            createdAt: Number(event.at) || Date.now(),
          });
        } catch (error) {
          log(`[task-run] error entry failed ${error?.code || 'unknown'}`);
        }
      }
      const usage = store.getRunUsage(runId);
      if (!hasRoleCoverage(usage, 'main')) {
        const snapshot = providerSnapshot(sessionId) || {};
        store.observeUsage({
          runId,
          event: {
            eventId: `usage-unobservable:${runId}`,
            sourceEventId: event.entryId || null,
            occurredAt: Number(event.at) || Date.now(),
            providerId: snapshot.providerId || 'unknown',
            providerName: snapshot.providerName || snapshot.providerId || 'Unknown',
            cli: snapshot.cli || record.cli || '',
            protocol: snapshot.protocol || '',
            model: snapshot.model || record.model || '',
            roleKind: 'main',
            routeName: 'main',
            source: 'reconciled',
            coverage: 'unobservable',
            status: 'unobservable',
            tokens: null,
            errorCode: 'USAGE_NOT_OBSERVED',
          },
        });
      }
      store.sealUsage({
        runId,
        executionStatus: status,
        outcomeDurable: evidence.outcomeDurable,
        producersDrained: evidence.producersDrained,
        nativeTranscriptChecked: evidence.nativeTranscriptChecked,
      });
      permit = store.getCleanupPermit(runId);
      if (!permit) throw Object.assign(new Error('cleanup permit unavailable'), { code: 'TASK_RUN_CLEANUP_BLOCKED' });
      if (record.taskExecutionSlot === true && cleanupRun) {
        await Promise.resolve(cleanupRun({
          runId, slotId: sessionId, permit, record, nativeRefs: evidence.nativeRefs,
        }));
      } else {
        store.markCleanup({ runId, permit, state: 'deleting' });
        if (record.taskExecutionSlot === true) await resetSlot(sessionId, record);
        store.markCleanup({ runId, permit, state: 'done' });
      }
      if (typeof store.releaseSlotLease === 'function') {
        store.releaseSlotLease({ slotId: sessionId, runId, leaseEpoch });
      }
      delete record.taskRunLease;
      delete record.taskRunUsageError;
      delete record.taskRunQuarantined;
      delete record.taskRunFinalization;
      await Promise.resolve(persistRecords('task-run-slot-release'));
      await notifyRunUpdated(runId, taskIdForUpdate(runId, event), {
        executionStatus: status, cleanupState: 'done', quarantined: false,
      });
      // A retryable failure gets one bounded automatic retry, admitted by the
      // Task Board as a brand-new run (new lease, compiled context includes
      // the failure entry). The port runs after cleanup so the freed slot can
      // immediately take the retry; it must never fail finalization itself.
      if (status === 'failed' && typeof onRunFailed === 'function') {
        try {
          await Promise.resolve(onRunFailed({
            runId,
            taskId: taskIdForUpdate(runId, event),
            slotId: sessionId,
            code: failure?.code || 'TURN_FAILED',
            retryable: failure?.retryable === true,
          }));
        } catch (error) {
          log(`[task-run] onRunFailed failed ${error?.code || error?.message || 'unknown'}`);
        }
      }
      return { ok: true, runId };
    } catch (error) {
      record.taskRunQuarantined = true;
      if (typeof store.quarantineSlotLease === 'function') {
        try {
          store.quarantineSlotLease({ slotId: sessionId, runId, leaseEpoch,
            code: error?.code || 'TASK_RUN_CLEANUP_FAILED' });
        } catch (_) {}
      }
      if (permit) {
        try {
          store.markCleanup({
            runId, permit, state: 'error', errorCode: error?.code || 'TASK_RUN_CLEANUP_FAILED',
          });
        } catch (_) { /* stale permits remain fail-closed */ }
      }
      await Promise.resolve(persistRecords('task-run-slot-quarantine')).catch(() => {});
      await notifyRunUpdated(runId, taskIdForUpdate(runId, event), {
        executionStatus: executionStatus(event), cleanupState: 'error', quarantined: true,
        errorCode: error?.code || 'TASK_RUN_CLEANUP_FAILED',
      });
      log(`[task-run] cleanup failed ${error?.code || 'TASK_RUN_CLEANUP_FAILED'}`);
      return { ok: false, code: error?.code || 'TASK_RUN_CLEANUP_FAILED' };
    }
  }

  function onSchedulerEvent(event = {}) {
    if (event.type !== 'completed' || !event.taskRunId) {
      return Promise.resolve({ ok: true, skipped: true });
    }
    const sessionId = String(event.sessionId || '');
    const record = records.get(sessionId);
    const leaseEpoch = Number(event.leaseEpoch);
    if (!record?.taskRunLease
        || record.taskRunLease.runId !== event.taskRunId
        || record.taskRunLease.leaseEpoch !== leaseEpoch) {
      return Promise.resolve({ ok: false, code: 'stale_task_run_lease' });
    }
    const runId = event.taskRunId;
    if (event.classifyState === 'W' || event.classifyState === 'B') {
      return Promise.resolve({ ok: true, waiting: true, runId });
    }
    const requestedStatus = executionStatus(event);
    const existing = finalizers.get(runId);
    if (existing) {
      if (finalizerStatuses.get(runId) !== requestedStatus) {
        return Promise.resolve({ ok: false, code: 'TASK_RUN_EXECUTION_STATUS_CONFLICT' });
      }
      return existing;
    }
    let tracked;
    tracked = finalizeTerminal(event, record, sessionId, runId, leaseEpoch).finally(() => {
      if (finalizers.get(runId) === tracked) {
        finalizers.delete(runId);
        finalizerStatuses.delete(runId);
      }
    });
    finalizers.set(runId, tracked);
    finalizerStatuses.set(runId, requestedStatus);
    return tracked;
  }

  async function terminateNeverDelivered(run, input) {
    const runId = run.runId;
    const taskId = run.taskId;
    try {
      if (TERMINAL_EXECUTION_STATUSES.has(run.executionStatus)) {
        if (run.executionStatus !== 'cancelled') {
          return { ok: false, code: 'TASK_RUN_EXECUTION_STATUS_CONFLICT' };
        }
        if (run.cleanupState === 'done') {
          return { ok: true, duplicate: true, runId };
        }
      } else {
        if (run.executionStatus !== 'running' || run.usageStatus !== 'collecting'
            || run.cleanupState !== 'blocked') {
          return { ok: false, code: 'TASK_RUN_NEVER_DELIVERED_STATE_INVALID' };
        }
        const usage = store.getRunUsage(runId);
        if (!hasRoleCoverage(usage, 'main')) {
          const requestedAt = Number(input.at);
          const occurredAt = Number.isSafeInteger(requestedAt) && requestedAt >= 0
            ? requestedAt
            : (Number.isSafeInteger(Number(run.startedAt)) ? Number(run.startedAt) : 0);
          store.observeUsage({
            runId,
            event: {
              eventId: `usage-not-started:${runId}`,
              sourceEventId: null,
              occurredAt,
              providerId: 'not-started',
              providerName: 'Not started',
              cli: '',
              protocol: '',
              model: '',
              roleKind: 'main',
              routeName: 'main',
              source: 'reconciled',
              coverage: 'observed',
              status: 'cancelled',
              tokens: {
                freshInput: 0,
                cacheRead: 0,
                cacheWrite: 0,
                output: 0,
                reasoning: 0,
              },
            },
          });
        }
        store.sealUsage({
          runId,
          executionStatus: 'cancelled',
          // No producer or native session ever existed for an unbound run.
          outcomeDurable: true,
          producersDrained: true,
          nativeTranscriptChecked: true,
        });
      }
      const permit = store.getCleanupPermit(runId);
      if (!permit) {
        return { ok: false, code: 'TASK_RUN_NEVER_DELIVERED_CLEANUP_BLOCKED' };
      }
      store.markCleanup({ runId, permit, state: 'deleting' });
      store.markCleanup({ runId, permit, state: 'done' });
      await notifyRunUpdated(runId, taskId, {
        executionStatus: 'cancelled', cleanupState: 'done', quarantined: false,
      });
      return { ok: true, runId };
    } catch (error) {
      log(`[task-run] never-delivered termination failed ${error?.code || 'unknown'}`);
      return { ok: false, code: error?.code || 'TASK_RUN_NEVER_DELIVERED_TERMINATE_FAILED' };
    }
  }

  /**
   * `neverDelivered: true` is an attestation by the caller that it has already
   * durably closed the public task/queue admission path for this exact identity.
   * The host independently requires an authoritative unbound run (`slotId=null`)
   * before using the ledger-only cancellation path.
   */
  async function terminateRun(input = {}) {
    const taskId = clean(input.taskId);
    const runId = clean(input.runId || input.taskRunId);
    const slotId = clean(input.slotId || input.sessionId);
    const leaseEpoch = Number(input.leaseEpoch);
    if (!taskId || !runId || !Number.isSafeInteger(leaseEpoch) || leaseEpoch < 1) {
      return { ok: false, code: 'TASK_RUN_TERMINATE_INVALID' };
    }
    let run;
    try { run = store.getRun(runId); } catch (_) {
      return { ok: false, code: 'TASK_RUN_TERMINATE_RUN_MISSING' };
    }
    if (run.taskId !== taskId || Number(run.leaseEpoch) !== leaseEpoch) {
      return { ok: false, code: 'stale_task_run_lease' };
    }
    if (run.slotId == null) {
      if (slotId) return { ok: false, code: 'stale_task_run_lease' };
      if (input.neverDelivered !== true) {
        return { ok: false, code: 'TASK_RUN_NEVER_DELIVERED_PROOF_REQUIRED' };
      }
      return terminateNeverDelivered(run, input);
    }
    if (!slotId || run.slotId !== slotId) {
      return { ok: false, code: 'stale_task_run_lease' };
    }
    const record = records.get(slotId);
    if (!record?.taskExecutionSlot || !TASK_RUN_CLIS.has(clean(record.cli).toLowerCase())) {
      return { ok: false, code: 'stale_task_run_lease' };
    }
    if (typeof store.getSlotLease !== 'function') {
      return { ok: false, code: 'TASK_RUN_TERMINATE_LEASE_PORT_MISSING' };
    }
    let authoritative;
    try { authoritative = store.getSlotLease(slotId); } catch (_) {
      return { ok: false, code: 'stale_task_run_lease' };
    }
    const exactAuthoritative = authoritative?.runId === runId
      && Number(authoritative.leaseEpoch) === leaseEpoch;
    const projection = record.taskRunLease;
    const exactProjection = projection?.runId === runId
      && Number(projection.leaseEpoch) === leaseEpoch;
    if (TERMINAL_EXECUTION_STATUSES.has(run.executionStatus)) {
      if (run.executionStatus !== 'cancelled') {
        return { ok: false, code: 'TASK_RUN_EXECUTION_STATUS_CONFLICT' };
      }
      if (run.cleanupState === 'done' && exactAuthoritative
          && authoritative.state === 'released'
          && (!projection || exactProjection)) {
        return { ok: true, duplicate: true, runId };
      }
      return { ok: false, code: 'stale_task_run_lease' };
    }
    if (run.executionStatus !== 'running' || run.usageStatus !== 'collecting'
        || run.cleanupState !== 'blocked'
        || !exactAuthoritative || authoritative.state !== 'active'
        || authoritative.phase !== 'ready' || !exactProjection) {
      return { ok: false, code: 'stale_task_run_lease' };
    }
    return onSchedulerEvent({
      type: 'completed',
      sessionId: slotId,
      taskId,
      taskRunId: runId,
      leaseEpoch,
      classifyState: 'E',
      turnOutcome: 'failed',
      attemptOutcome: 'cancelled',
      reason: clean(input.reason) || 'user_cancelled',
      at: Number.isSafeInteger(Number(input.at)) ? Number(input.at) : Date.now(),
      explicitTermination: true,
    });
  }

  function cancelRun(input = {}) {
    return terminateRun(input);
  }

  async function recoverTerminal(event = {}) {
    const sessionId = clean(event.sessionId);
    const runId = clean(event.taskRunId);
    const leaseEpoch = Number(event.leaseEpoch);
    if (event.recovered !== true || event.type !== 'completed'
        || !['D', 'E'].includes(event.classifyState)
        || !sessionId || !runId
        || !Number.isSafeInteger(leaseEpoch) || leaseEpoch < 1) {
      return { ok: false, code: 'TASK_RUN_TERMINAL_RECOVERY_INVALID' };
    }
    let run;
    try { run = store.getRun(runId); } catch (_) {
      return { ok: false, code: 'TASK_RUN_TERMINAL_RECOVERY_RUN_MISSING' };
    }
    if (run.slotId !== sessionId || Number(run.leaseEpoch) !== leaseEpoch
        || (event.taskId && run.taskId !== event.taskId)) {
      return { ok: false, code: 'stale_task_run_lease' };
    }
    if (typeof store.getSlotLease !== 'function') {
      return { ok: false, code: 'TASK_RUN_TERMINAL_RECOVERY_LEASE_PORT_MISSING' };
    }
    const authoritative = store.getSlotLease(sessionId);
    const exactAuthoritative = authoritative?.runId === runId
      && Number(authoritative.leaseEpoch) === leaseEpoch;
    if (run.cleanupState === 'done'
        && ['succeeded', 'failed', 'cancelled'].includes(run.executionStatus)
        && exactAuthoritative && authoritative.state === 'released') {
      if (run.executionStatus !== executionStatus(event)) {
        return { ok: false, code: 'TASK_RUN_EXECUTION_STATUS_CONFLICT' };
      }
      return { ok: true, duplicate: true, runId };
    }
    if (!exactAuthoritative || authoritative.state !== 'active'
        || authoritative.phase !== 'ready') {
      return { ok: false, code: 'stale_task_run_lease' };
    }
    const record = records.get(sessionId);
    if (!record?.taskExecutionSlot || !record.taskRunLease || record.taskRunLease.runId !== runId
        || Number(record.taskRunLease.leaseEpoch) !== leaseEpoch
        || run.executionStatus !== 'running' || run.usageStatus !== 'collecting'
        || run.cleanupState !== 'blocked') {
      return { ok: false, code: 'stale_task_run_lease' };
    }
    return onSchedulerEvent(event);
  }

  async function waitForFinalizers() {
    while (finalizers.size) {
      await Promise.allSettled([...finalizers.values()]);
    }
  }

  async function resetSlotForRecovery(item = {}) {
    const sessionId = clean(item.slotId || item.sessionId);
    const record = records.get(sessionId);
    if (!record?.taskExecutionSlot) {
      throw Object.assign(new Error('task execution slot not found'), {
        code: 'TASK_RUN_SLOT_NOT_FOUND',
      });
    }
    await resetSlot(sessionId, record);
    return { ok: true, slotId: sessionId };
  }

  function isSlotUnavailable(sessionId, lineage = {}) {
    const record = records.get(sessionId);
    if (!record?.taskExecutionSlot) return false;
    if (record.taskRunQuarantined) return true;
    const lease = record.taskRunLease;
    if (!lease) return false;
    const payload = lineage.payload || {};
    const turnLineage = lineage.turnLineage || {};
    const runId = clean(lineage.taskRunId || lineage.runId || turnLineage.taskRunId
      || payload.taskRunId || payload.options?.taskRunId);
    const leaseEpoch = Number(lineage.leaseEpoch ?? turnLineage.leaseEpoch
      ?? payload.leaseEpoch ?? payload.options?.leaseEpoch);
    return runId !== lease.runId || leaseEpoch !== lease.leaseEpoch;
  }

  return Object.freeze({
    beforeDeliver,
    recordMessage,
    recordObservedUsage,
    recordMainUsage,
    onSchedulerEvent,
    terminateRun,
    cancelRun,
    recoverTerminal,
    waitForFinalizers,
    resetSlotForRecovery,
    isSlotUnavailable,
  });
}

module.exports = {
  createTaskRunHost, stableMessageId, stableMainUsageEventId, executionStatus, hasRoleCoverage,
};
