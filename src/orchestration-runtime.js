'use strict';

// Composition layer for the durable orchestration primitives.  The store,
// wait service and outbox deliberately know nothing about MultiCC chat.  This
// module owns the lifecycle and the one-way bridge from a durable outbox item
// to runChatTurn().

const crypto = require('crypto');
const { createOrchestrationStore } = require('./orchestration-store');
const { createOrchestrationSqliteStore } = require('./orchestration-sqlite-store');
const { createOutbox } = require('./outbox');
const { createWaitService } = require('./wait-service');
const { createSessionWorkScheduler } = require('./session-work-scheduler');
const {
  TERMINAL_OPERATION_STATES,
  TERMINAL_TASK_STATES,
  createOperationService,
} = require('./operation-service');

const DEFAULTS = Object.freeze({
  intervalSec: 15,
  maxChecks: 40,
  timeoutSec: 1800,
  minIntervalSec: 3,
  minDelaySec: 1,
  maxDelaySec: 7 * 24 * 60 * 60,
});
const SCHEDULED_MESSAGE_KIND = 'scheduled_message';
const SCHEDULED_MESSAGE_MAX_CHARS = 256 * 1024;

function asFinite(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function renderData(value) {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); }
  catch (_) { return String(value); }
}

function publicWait(wait) {
  const metadata = wait.metadata || {};
  return {
    id: wait.id,
    session: wait.sessionId,
    sessionId: wait.sessionId,
    mode: wait.mode,
    status: wait.status,
    checks: metadata.checks || 0,
    maxChecks: metadata.maxChecks,
    intervalSec: metadata.intervalSec,
    pollCmd: metadata.pollCmd,
    pollUrl: metadata.pollUrl,
    untilContains: metadata.untilContains,
    untilRegex: metadata.untilRegex,
    dueAt: metadata.dueAt,
    reason: metadata.reason,
    createdAt: wait.createdAt,
    resolvedAt: wait.resolvedAt,
    cancelledAt: wait.cancelledAt,
  };
}

function scheduledMessageView(wait) {
  const metadata = wait?.metadata || {};
  return {
    id: wait.id,
    sessionId: wait.sessionId,
    message: metadata.scheduledMessageText || metadata.scheduledMessagePreview || '',
    dueAt: metadata.dueAt || null,
    delaySeconds: metadata.delaySec || null,
    status: wait.status,
    createdAt: wait.createdAt,
    resolvedAt: wait.resolvedAt || null,
    cancelledAt: wait.cancelledAt || null,
  };
}

function createOrchestrationRuntime({
  file,
  databaseFile = null,
  runChatTurn,
  isBusy = () => false,
  isSlotUnavailable = () => false,
  hasPersistedDelivery = async () => false,
  beforeDeliver = async () => {},
  deliverOutbox = null,
  probe = async () => { throw new Error('poll probe is not configured'); },
  detachedAdapter = null,
  recoverDispatchResult = async () => null,
  replayRecoveredDispatchEffects = async () => {},
  getSessionRecoveryState = () => null,
  beforeFirstTick = async () => {},
  onSchedulerEvent = () => {},
  now = Date.now,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  workerIntervalMs = 1000,
  pollLeaseMs = 30_000,
  claimLimit = 8,
  workerId = `multicc-${process.pid}-${crypto.randomBytes(6).toString('hex')}`,
  log = () => {},
  storeOptions = {},
  outboxOptions = {},
  waitOptions = {},
} = {}) {
  if ((!file || typeof file !== 'string')
      && (!databaseFile || typeof databaseFile !== 'string')) {
    throw new TypeError('[orchestration-runtime] file or databaseFile is required');
  }
  if (typeof runChatTurn !== 'function') {
    throw new TypeError('[orchestration-runtime] runChatTurn is required');
  }
  if (typeof hasPersistedDelivery !== 'function') {
    throw new TypeError('[orchestration-runtime] hasPersistedDelivery must be a function');
  }
  if (typeof beforeDeliver !== 'function') {
    throw new TypeError('[orchestration-runtime] beforeDeliver must be a function');
  }
  if (typeof beforeFirstTick !== 'function') {
    throw new TypeError('[orchestration-runtime] beforeFirstTick must be a function');
  }

  // Production selects the normalized SQLite backend. Keeping the JSON path
  // injectable preserves isolated compatibility tests and provides a narrow
  // rollback reader without making stale JSON an automatic runtime fallback.
  const store = databaseFile
    ? createOrchestrationSqliteStore({
      file: databaseFile,
      legacyFile: file || null,
      now,
      ...storeOptions,
    })
    : createOrchestrationStore({ file, now, ...storeOptions });
  if (store.migration?.migrated) {
    log(`[orchestration] migrated legacy JSON to SQLite (${store.file})`);
  }
  const outbox = createOutbox({
    store,
    now,
    leaseMs: 30_000,
    maxAttempts: 20,
    baseBackoffMs: 1000,
    maxBackoffMs: 60_000,
    ...outboxOptions,
  });
  const waits = createWaitService({ store, now, ...waitOptions });
  const operations = createOperationService({ store, now });
  const sessionScheduler = createSessionWorkScheduler({
    store,
    now,
    onEvent: onSchedulerEvent,
    getClassifyState: sessionId => getSessionRecoveryState(sessionId)?.classifyState || null,
    getPendingUserInput: sessionId => getSessionRecoveryState(sessionId)?.pendingUserInput || null,
    log,
  });
  const pendingBySession = new Map();
  let timer = null;
  let started = false;
  let stopped = false;
  let tickTail = Promise.resolve();

  function addPending(sessionId, id) {
    const ids = pendingBySession.get(sessionId) || new Set();
    ids.add(id);
    pendingBySession.set(sessionId, ids);
  }

  function removePending(sessionId, id) {
    const ids = pendingBySession.get(sessionId);
    if (!ids) return;
    ids.delete(id);
    if (ids.size === 0) pendingBySession.delete(sessionId);
  }

  function isBlockingWait(wait) {
    return wait?.metadata?.kind !== SCHEDULED_MESSAGE_KIND;
  }

  async function refreshPending() {
    const pending = await waits.list({ status: 'pending' });
    pendingBySession.clear();
    for (const wait of pending) {
      if (isBlockingWait(wait)) addPending(wait.sessionId, wait.id);
    }
    return pending;
  }

  function hasPending(sessionId) {
    return !!pendingBySession.get(sessionId)?.size;
  }

  function pendingCount() {
    let count = 0;
    for (const ids of pendingBySession.values()) count += ids.size;
    return count;
  }

  async function register(spec = {}) {
    const mode = ['callback', 'poll', 'delay'].includes(spec.mode)
      ? spec.mode : 'poll';
    const at = Number(now());
    const registrationMetadata = {
      ...(spec.source ? { source: String(spec.source).slice(0, 64) } : {}),
      ...(spec.reason ? { reason: String(spec.reason).slice(0, 4096) } : {}),
      ...(spec.registrationFingerprint
        ? { registrationFingerprint: String(spec.registrationFingerprint).slice(0, 128) }
        : {}),
      ...(spec.taskId ? { taskId: String(spec.taskId).slice(0, 128) } : {}),
      ...(spec.taskRunId ? {
        taskRunId: String(spec.taskRunId).slice(0, 128),
        leaseEpoch: Number(spec.leaseEpoch),
      } : {}),
      ...(spec.originDispatchId
        ? { originDispatchId: String(spec.originDispatchId).slice(0, 128) }
        : {}),
      ...(spec.scheduledMessageText ? {
        kind: SCHEDULED_MESSAGE_KIND,
        scheduledMessageText: String(spec.scheduledMessageText).slice(0, SCHEDULED_MESSAGE_MAX_CHARS),
        scheduledMessagePreview: String(spec.scheduledMessageText).slice(0, 240),
        scheduledMessageFingerprint: String(spec.scheduledMessageFingerprint || '').slice(0, 64),
        clientScheduleId: String(spec.clientScheduleId || '').slice(0, 128),
      } : {}),
    };
    if (registrationMetadata.taskRunId
        && (!Number.isSafeInteger(registrationMetadata.leaseEpoch)
          || registrationMetadata.leaseEpoch < 1)) {
      throw new TypeError('task-run wait requires a positive leaseEpoch');
    }
    let metadata;
    if (mode === 'poll') {
      if (!spec.pollCmd && !spec.pollUrl) throw new Error('poll mode needs pollCmd or pollUrl');
      if (!spec.untilContains && !spec.untilRegex) {
        throw new Error('poll mode needs untilContains or untilRegex');
      }
      const intervalSec = Math.max(
        DEFAULTS.minIntervalSec,
        asFinite(spec.intervalSec, DEFAULTS.intervalSec),
      );
      metadata = {
        cwd: spec.cwd || process.cwd(),
        pollCmd: spec.pollCmd || null,
        pollUrl: spec.pollUrl || null,
        untilContains: spec.untilContains || null,
        untilRegex: spec.untilRegex || null,
        intervalSec,
        maxChecks: Math.max(1, Math.floor(asFinite(spec.maxChecks, DEFAULTS.maxChecks))),
        checks: 0,
        nextAt: at + intervalSec * 1000,
        pollLeaseId: null,
        pollLeasedUntil: null,
        ...registrationMetadata,
      };
    } else if (mode === 'callback') {
      const timeoutSec = Math.max(10, asFinite(spec.timeoutSec, DEFAULTS.timeoutSec));
      metadata = {
        timeoutSec,
        expireAt: at + timeoutSec * 1000,
        ...registrationMetadata,
      };
    } else {
      const delaySec = Math.min(
        DEFAULTS.maxDelaySec,
        Math.max(DEFAULTS.minDelaySec, asFinite(spec.delaySec ?? spec.delaySeconds, 1)),
      );
      metadata = {
        delaySec,
        dueAt: at + delaySec * 1000,
        delayLeaseId: null,
        delayLeasedUntil: null,
        ...registrationMetadata,
      };
    }

    const registered = await waits.register({
      id: spec.id,
      sessionId: spec.session || spec.sessionId,
      mode,
      injectPrefix: spec.injectPrefix || '',
      metadata,
    });
    if (isBlockingWait({ metadata })) addPending(registered.sessionId, registered.id);
    return {
      ...registered,
      token: registered.token || null,
      callbackUrl: registered.callbackUrl || null,
      session: registered.sessionId,
      status: 'pending',
      dueAt: metadata.dueAt || null,
    };
  }

  async function resolveCallback(id, token, payload) {
    const result = await waits.resolveCallback(id, token, payload);
    if (result.ok) {
      const wait = await waits.get(id);
      if (wait) removePending(wait.sessionId, id);
    }
    return { ...result, status: result.ok ? 'resolved' : result.status };
  }

  async function cancel(id) {
    const before = await waits.get(id);
    const result = await waits.cancel(id);
    if (result.ok && before) removePending(before.sessionId, id);
    return { ...result, status: result.ok ? 'cancelled' : result.status };
  }

  async function scheduleMessage(spec = {}) {
    const sessionId = String(spec.sessionId || spec.session || '').trim();
    const message = String(spec.message || '').trim();
    const delaySeconds = Number(spec.delaySeconds ?? spec.delaySec);
    if (!sessionId) throw new TypeError('sessionId is required');
    if (!message) throw new TypeError('message is required');
    if (message.length > SCHEDULED_MESSAGE_MAX_CHARS) {
      throw new RangeError(`message is too long (max ${SCHEDULED_MESSAGE_MAX_CHARS} chars)`);
    }
    if (!Number.isSafeInteger(delaySeconds)
        || delaySeconds < DEFAULTS.minDelaySec
        || delaySeconds > DEFAULTS.maxDelaySec) {
      throw new RangeError(`delaySeconds must be an integer between ${DEFAULTS.minDelaySec} and ${DEFAULTS.maxDelaySec}`);
    }
    const clientScheduleId = String(spec.clientScheduleId || crypto.randomUUID()).trim().slice(0, 128);
    if (!clientScheduleId) throw new TypeError('clientScheduleId is required');
    const identity = crypto.createHash('sha256')
      .update(`${sessionId}\0${clientScheduleId}`, 'utf8').digest('hex').slice(0, 40);
    const fingerprint = crypto.createHash('sha256')
      .update(`${sessionId}\0${message}\0${delaySeconds}`, 'utf8').digest('hex');
    const id = `scheduled:${identity}`;
    try {
      const registered = await register({
        id,
        session: sessionId,
        mode: 'delay',
        delaySec: delaySeconds,
        source: 'chat-composer',
        scheduledMessageText: message,
        scheduledMessageFingerprint: fingerprint,
        clientScheduleId,
      });
      const wait = await waits.get(registered.id);
      return { ...scheduledMessageView(wait), duplicate: false };
    } catch (error) {
      if (error?.code !== 'WAIT_ALREADY_EXISTS') throw error;
      const existing = await waits.get(id);
      if (existing?.metadata?.kind !== SCHEDULED_MESSAGE_KIND
          || existing.metadata.scheduledMessageFingerprint !== fingerprint) {
        const conflict = new Error('clientScheduleId already belongs to another scheduled message');
        conflict.code = 'SCHEDULED_MESSAGE_CONFLICT';
        conflict.statusCode = 409;
        throw conflict;
      }
      return { ...scheduledMessageView(existing), duplicate: true };
    }
  }

  async function listScheduledMessages(sessionId) {
    const list = await waits.list({ sessionId: String(sessionId || '').trim(), status: 'pending' });
    return list.filter(wait => wait.metadata?.kind === SCHEDULED_MESSAGE_KIND)
      .sort((a, b) => Number(a.metadata?.dueAt) - Number(b.metadata?.dueAt))
      .map(scheduledMessageView);
  }

  async function cancelScheduledMessage(sessionId, id) {
    const wait = await waits.get(String(id || '').trim());
    if (!wait || wait.sessionId !== String(sessionId || '').trim()
        || wait.metadata?.kind !== SCHEDULED_MESSAGE_KIND) {
      return { ok: false, code: 'not_found' };
    }
    return cancel(wait.id);
  }

  async function cancelForSession(sessionId) {
    const targetDispatches = await operations.list({ kind: 'dispatch' });
    for (const operation of targetDispatches) {
      if (TERMINAL_OPERATION_STATES.has(operation.status)) continue;
      if (operation.ownerSessionId === sessionId) continue;
      if (operation.spec.chatId !== sessionId && operation.spec.targetId !== sessionId) continue;
      await operations.completeDispatch(operation.id, {
        status: 'interrupted',
        error: 'dispatch target session was deleted',
      });
    }

    const result = await store.mutate(draft => {
      const at = Number(now());
      let cancelled = 0;
      let cancelledDeliveries = 0;
      let cancelledOperations = 0;
      let cancelledTasks = 0;
      const detachedExternalIds = [];
      const ownedOperationIds = new Set(Object.values(draft.operations)
        .filter(operation => operation.ownerSessionId === sessionId)
        .map(operation => operation.id));
      for (const wait of Object.values(draft.waits)) {
        if (wait.sessionId !== sessionId || wait.status !== 'pending') continue;
        wait.status = 'cancelled';
        wait.cancelledAt = at;
        wait.updatedAt = at;
        cancelled++;
      }
      for (const item of Object.values(draft.outbox)) {
        const belongsToOwnedOperation = item.source?.type === 'operation'
          && ownedOperationIds.has(item.source.operationId);
        if ((item.sessionId !== sessionId && !belongsToOwnedOperation)
            || !['pending', 'leased'].includes(item.state)) continue;
        item.state = 'cancelled';
        item.updatedAt = at;
        item.leasedAt = null;
        item.leasedUntil = null;
        item.leaseOwner = null;
        item.leaseTokenHash = null;
        cancelledDeliveries++;
      }
      for (const operation of Object.values(draft.operations)) {
        if (operation.ownerSessionId !== sessionId || TERMINAL_OPERATION_STATES.has(operation.status)) continue;
        operation.status = 'cancelled';
        operation.cancelledAt = at;
        operation.updatedAt = at;
        if (operation.kind === 'detached' && operation.externalId) {
          detachedExternalIds.push(operation.externalId);
        }
        cancelledOperations++;
      }
      for (const task of Object.values(draft.tasks)) {
        if (task.parentSessionId !== sessionId || TERMINAL_TASK_STATES.has(task.status)) continue;
        task.status = 'cancelled';
        task.completedAt = at;
        task.updatedAt = at;
        cancelledTasks++;
      }
      if (draft.sessionSchedules[sessionId]) {
        delete draft.sessionSchedules[sessionId];
      }
      return {
        ok: true,
        cancelled,
        cancelledDeliveries,
        cancelledOperations,
        cancelledTasks,
        detachedExternalIds,
      };
    });
    pendingBySession.delete(sessionId);
    if (detachedAdapter && typeof detachedAdapter.cancel === 'function') {
      for (const externalId of result.detachedExternalIds) {
        try { await Promise.resolve(detachedAdapter.cancel(externalId)); }
        catch (error) { log(`[orchestration] cancel detached ${externalId} failed: ${error.message}`); }
      }
    }
    const { detachedExternalIds, ...visible } = result;
    return visible;
  }

  async function listForSession(sessionId) {
    const list = await waits.list({ sessionId, status: 'pending' });
    return list.map(publicWait);
  }

  async function stats() {
    return store.read(snapshot => {
      const allWaits = Object.values(snapshot.waits);
      const allOutbox = Object.values(snapshot.outbox);
      return {
        backend: store.backend || 'json',
        waits: allWaits.filter(wait => wait.status === 'pending').length,
        resolvedWaits: allWaits.filter(wait => wait.status === 'resolved').length,
        pendingDeliveries: allOutbox.filter(item => item.state === 'pending' || item.state === 'leased').length,
        deadLetters: allOutbox.filter(item => item.state === 'dead-letter').length,
      };
    });
  }

  async function hasSessionActivity(sessionId) {
    const id = String(sessionId || '').trim();
    if (!id) return false;
    return store.read((draft) => {
      if (Object.values(draft.waits).some(wait => wait.sessionId === id && wait.status === 'pending')) return true;
      if (Object.values(draft.outbox).some(item => item.sessionId === id && ['pending', 'leased'].includes(item.state))) return true;
      if (Object.values(draft.operations).some(operation => !TERMINAL_OPERATION_STATES.has(operation.status)
          && (operation.ownerSessionId === id || operation.spec?.chatId === id || operation.spec?.targetId === id))) return true;
      if (Object.values(draft.tasks).some(task => task.parentSessionId === id && !TERMINAL_TASK_STATES.has(task.status))) return true;
      const schedule = draft.sessionSchedules[id];
      const waitingOnly = schedule?.active && (schedule.classifyState === 'W'
        || ['awaiting_user_input', 'classify_waiting'].includes(schedule.freezeReason));
      return !!(schedule?.active && !waitingOnly);
    });
  }

  function matches(metadata, output) {
    if (metadata.untilContains) return output.includes(metadata.untilContains);
    if (metadata.untilRegex) {
      try { return new RegExp(metadata.untilRegex).test(output); }
      catch (_) { return false; }
    }
    return false;
  }

  function hasDueWaitWork(draft, at) {
    return Object.values(draft.waits).some(wait => {
      if (wait.status !== 'pending') return false;
      const metadata = wait.metadata || {};
      if (wait.mode === 'callback') {
        return Number.isFinite(metadata.expireAt) && metadata.expireAt <= at;
      }
      if (wait.mode === 'delay') {
        const leaseActive = metadata.delayLeaseId
          && Number.isFinite(metadata.delayLeasedUntil)
          && metadata.delayLeasedUntil > at;
        return !leaseActive && Number.isFinite(metadata.dueAt) && metadata.dueAt <= at;
      }
      const leaseActive = metadata.pollLeaseId
        && Number.isFinite(metadata.pollLeasedUntil)
        && metadata.pollLeasedUntil > at;
      return !leaseActive && Number.isFinite(metadata.nextAt) && metadata.nextAt <= at;
    });
  }

  function claimDueWaitsDraft(draft) {
    const at = Number(now());
    const claims = [];
    const expired = [];
    for (const wait of Object.values(draft.waits)) {
      if (wait.status !== 'pending') continue;
      const metadata = wait.metadata || {};
      if (wait.mode === 'callback') {
        if (Number.isFinite(metadata.expireAt) && metadata.expireAt <= at) {
          wait.status = 'cancelled';
          wait.cancelledAt = at;
          wait.updatedAt = at;
          expired.push({ sessionId: wait.sessionId, id: wait.id });
        }
        continue;
      }
      if (wait.mode === 'delay') {
        const leaseActive = metadata.delayLeaseId
          && Number.isFinite(metadata.delayLeasedUntil)
          && metadata.delayLeasedUntil > at;
        if (leaseActive || !Number.isFinite(metadata.dueAt) || metadata.dueAt > at) continue;
        const delayLeaseId = crypto.randomBytes(16).toString('hex');
        metadata.delayLeaseId = delayLeaseId;
        metadata.delayLeasedUntil = at + pollLeaseMs;
        wait.metadata = metadata;
        wait.updatedAt = at;
        claims.push({
          id: wait.id,
          mode: 'delay',
          sessionId: wait.sessionId,
          delayLeaseId,
          metadata: JSON.parse(JSON.stringify(metadata)),
        });
        continue;
      }
      const leaseActive = metadata.pollLeaseId
        && Number.isFinite(metadata.pollLeasedUntil)
        && metadata.pollLeasedUntil > at;
      if (leaseActive || !Number.isFinite(metadata.nextAt) || metadata.nextAt > at) continue;
      const pollLeaseId = crypto.randomBytes(16).toString('hex');
      metadata.pollLeaseId = pollLeaseId;
      metadata.pollLeasedUntil = at + pollLeaseMs;
      wait.metadata = metadata;
      wait.updatedAt = at;
      claims.push({
        id: wait.id,
        mode: 'poll',
        sessionId: wait.sessionId,
        pollLeaseId,
        metadata: JSON.parse(JSON.stringify(metadata)),
      });
    }
    return { claims, expired };
  }

  async function claimDuePolls() {
    const result = await store.mutateIf(
      draft => hasDueWaitWork(draft, Number(now())),
      claimDueWaitsDraft,
      () => ({ claims: [], expired: [] }),
    );
    // The in-memory guard is updated only after the atomic rename succeeds.
    for (const wait of result.expired) removePending(wait.sessionId, wait.id);
    return result.claims;
  }

  async function finishPollAttempt(claim, { output = '', error = null } = {}) {
    const outcome = await store.mutate(draft => {
      const wait = draft.waits[claim.id];
      if (!wait || wait.status !== 'pending') return { action: 'gone' };
      const metadata = wait.metadata || {};
      if (metadata.pollLeaseId !== claim.pollLeaseId) return { action: 'lease_lost' };
      const at = Number(now());
      metadata.checks = (Number(metadata.checks) || 0) + 1;
      metadata.pollLeaseId = null;
      metadata.pollLeasedUntil = null;
      wait.updatedAt = at;
      if (!error && matches(metadata, output)) return { action: 'resolve', output };
      if (metadata.checks >= metadata.maxChecks) {
        return { action: 'timeout', checks: metadata.checks };
      }
      metadata.nextAt = at + metadata.intervalSec * 1000;
      wait.metadata = metadata;
      return { action: 'retry', error: error ? String(error.message || error) : null };
    });

    if (outcome.action === 'resolve') {
      const result = await waits.resolvePoll(claim.id, outcome.output);
      if (result.ok) removePending(claim.sessionId, claim.id);
    } else if (outcome.action === 'timeout') {
      const text = `[轮询超时] 等待的条件在 ${outcome.checks} 次检查后仍未满足，请决定是继续等待还是改用其它方式。`;
      const result = await waits.resolvePoll(claim.id, text, { deliveryText: text });
      if (result.ok) removePending(claim.sessionId, claim.id);
    }
    return outcome;
  }

  async function processPolls() {
    const claims = await claimDuePolls();
    await Promise.allSettled(claims.map(async claim => {
      if (claim.mode === 'delay') {
        if (claim.metadata.kind === SCHEDULED_MESSAGE_KIND) {
          const message = String(claim.metadata.scheduledMessageText || '').trim();
          if (!message) {
            log(`[orchestration] scheduled message ${claim.id} has no durable payload; cancelling`);
            await waits.cancel(claim.id);
            return;
          }
          const result = await waits.resolveDelay(
            claim.id,
            { dueAt: claim.metadata.dueAt, scheduledMessage: true },
            { sessionWork: { text: message } },
          );
          if (result.ok) {
            removePending(claim.sessionId, claim.id);
            try {
              const notice = await sessionScheduler.noteQueued(result.outboxId);
              if (!notice?.ok) log(`[orchestration] scheduled message queue notice failed: ${notice?.code || 'unknown'}`);
            } catch (error) {
              // Resolution and outbox admission are already one durable commit;
              // a UI-notice failure must not replay or drop that message.
              log(`[orchestration] scheduled message queue notice failed: ${error.message}`);
            }
          }
          return;
        }
        const reason = String(claim.metadata.reason || '').trim();
        const text = reason
          ? `🔇【延迟条件已到】${reason}`
          : '🔇【延迟条件已到】请检查当前状态并继续处理。';
        const result = await waits.resolveDelay(
          claim.id,
          { dueAt: claim.metadata.dueAt, reason },
          { deliveryText: text },
        );
        if (result.ok) removePending(claim.sessionId, claim.id);
        return;
      }
      try {
        const output = String(await probe(claim.metadata));
        await finishPollAttempt(claim, { output: output.slice(0, 1024 * 1024) });
      } catch (error) {
        log(`[orchestration] poll ${claim.id} failed: ${error.message}`);
        try { await finishPollAttempt(claim, { error }); }
        catch (finishError) {
          log(`[orchestration] poll ${claim.id} state update failed: ${finishError.message}`);
        }
      }
    }));
    // Covers the after-rename crash window: the wait may be durably resolved
    // even when the resolving caller observed an exception.
    await refreshPending();
  }

  function deliveryText(item) {
    const payload = item.payload || {};
    if (payload.type === 'session.work') return String(payload.message || '');
    if (payload.type === 'dispatch.request') return String(payload.message || '');
    if (typeof payload.deliveryText === 'string' && payload.deliveryText) return payload.deliveryText;
    const defaultPrefix = payload.mode === 'poll' ? '[轮询条件已满足]'
      : payload.mode === 'delay' ? '[延迟条件已到]'
        : '[等待的数据已返回]';
    const prefix = payload.injectPrefix || defaultPrefix;
    return `${prefix}\n${renderData(payload.data)}`;
  }

  function itemTurnLineage(item) {
    return item?.turnLineage && typeof item.turnLineage === 'object'
      ? item.turnLineage : {};
  }

  function itemTaskId(item) {
    const lineage = itemTurnLineage(item);
    return lineage.taskId || item?.payload?.taskId || item?.payload?.options?.taskId || null;
  }

  function itemTaskRunId(item) {
    const lineage = itemTurnLineage(item);
    return lineage.taskRunId
      || item?.payload?.taskRunId
      || item?.payload?.options?.taskRunId
      || null;
  }

  function itemLeaseEpoch(item) {
    const lineage = itemTurnLineage(item);
    const parsed = Number(lineage.leaseEpoch
      ?? item?.payload?.leaseEpoch
      ?? item?.payload?.options?.leaseEpoch);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }

  function itemOriginDispatchId(item) {
    const lineage = itemTurnLineage(item);
    return lineage.originDispatchId
      || item?.payload?.originDispatchId
      || (item?.payload?.type === 'dispatch.request' ? item.payload.operationId : null)
      || null;
  }

  // Compatibility recovery for entries admitted before full turn lineage was
  // persisted. A task id is only authoritative when it identifies exactly one
  // live dispatch for this target session. Ambiguity intentionally returns no
  // owner: completing the wrong dispatch is worse than leaving one inspectable.
  async function resolveSessionWorkLineage(item) {
    if (item?.payload?.type !== 'session.work' || itemOriginDispatchId(item)) return item;
    const taskId = itemTaskId(item);
    if (!taskId) return item;
    const live = await operations.list({ kind: 'dispatch', statuses: ['running'] });
    const matches = live.filter(operation => (
      operation.spec?.chatId === item.sessionId
      && operation.spec?.taskId === taskId
    ));
    if (matches.length !== 1) {
      if (matches.length > 1) {
        log(`[orchestration] dispatch_lineage_ambiguous ${JSON.stringify({
          sessionId: item.sessionId,
          taskId,
          matches: matches.map(operation => operation.id),
        })}`);
      }
      return item;
    }
    item.turnLineage = {
      ...itemTurnLineage(item),
      taskId,
      taskRunId: matches[0].spec?.taskRunId || null,
      leaseEpoch: matches[0].spec?.leaseEpoch || null,
      originDispatchId: matches[0].id,
      workKind: 'continuation',
      inheritedBy: 'unique_live_task_match',
    };
    log(`[orchestration] dispatch_lineage_recovered ${JSON.stringify({
      sessionId: item.sessionId,
      taskId,
      operationId: matches[0].id,
    })}`);
    return item;
  }

  function deliveryOptions(item) {
    const payload = item.payload || {};
    if (payload.type === 'session.work') {
      const lineage = itemTurnLineage(item);
      const effectiveWorkKind = lineage.workKind || payload.workKind || 'task';
      return {
        ...(payload.options || {}),
        taskId: itemTaskId(item) || undefined,
        taskRunId: itemTaskRunId(item) || undefined,
        leaseEpoch: itemLeaseEpoch(item) || undefined,
        originDispatchId: itemOriginDispatchId(item) || undefined,
        originContinue: effectiveWorkKind !== 'task',
        deliveryId: item.id,
        // Keep the browser correlation key so chat_msg_meta can replace the
        // optimistic user bubble. The durable outbox id remains deliveryId.
        clientMsgId: payload.options?.clientMsgId || item.id,
        schedulerEntryId: lineage.activeEntryId || payload.activeEntryId || item.id,
        schedulerWorkKind: effectiveWorkKind,
        directUserInput: payload.source === 'direct',
        userInputRequestId: payload.requestId || undefined,
      };
    }
    if (payload.type === 'dispatch.request') {
      return {
        originDispatchId: payload.operationId,
        originContinue: false,
        deliveryId: item.id,
        clientMsgId: item.id,
        taskId: payload.taskId || undefined,
        taskRunId: payload.taskRunId || undefined,
        leaseEpoch: itemLeaseEpoch(item) || undefined,
        isFirstTurn: !!payload.taskRunId,
        taskStart: payload.taskStart === true,
        taskSource: payload.taskSource || undefined,
        taskText: payload.taskText || undefined,
      };
    }
    return {
      originContinue: true,
      deliveryId: item.id,
      clientMsgId: item.id,
      taskId: itemTaskId(item) || undefined,
      taskRunId: itemTaskRunId(item) || undefined,
      leaseEpoch: itemLeaseEpoch(item) || undefined,
      originDispatchId: itemOriginDispatchId(item) || undefined,
    };
  }

  async function acknowledgeDelivery(item) {
    const acknowledged = await outbox.ack(item.id, item.leaseToken);
    if (acknowledged.ok && item.payload?.type === 'dispatch.request') {
      await operations.markRunning(item.payload.operationId);
    }
    if (acknowledged.ok
        && (item.payload?.type === 'session.work' || item.payload?.type === 'dispatch.request')) {
      // Once canonical chat history proves the delivery, retain only a stable
      // reference in orchestration state. The original payload hash stays
      // untouched so an idempotent retry can still be compared without keeping
      // a second drifting copy of the user task body.
      await store.mutate(draft => {
        const saved = draft.outbox[item.id];
        if (!saved || saved.state !== 'delivered') return false;
        if (Object.prototype.hasOwnProperty.call(saved.payload, 'message')) {
          delete saved.payload.message;
          saved.payload.messageRef = {
            sessionId: item.sessionId,
            deliveryId: item.id,
          };
          saved.updatedAt = Number(now());
        }
        if (item.payload?.operationId) {
          const operation = draft.operations[item.payload.operationId];
          if (operation?.kind === 'dispatch' && operation.spec) {
            delete operation.spec.message;
            delete operation.spec.taskText;
            operation.spec.messageRef = {
              sessionId: item.sessionId,
              deliveryId: item.id,
            };
            operation.updatedAt = Number(now());
          }
        }
        return true;
      });
    }
    return acknowledged;
  }

  async function deliver(item) {
    const deliveryId = item.id;
    let schedulerClaimed = false;
    let deliveryGuard = null;
    let deliveryOutcome = { accepted: false, durable: false };
    try {
      await resolveSessionWorkLineage(item);
      // The host-busy read must happen before our own claim: claiming emits
      // 'claimed', which projects queueState 'running' onto the session
      // record, so a post-claim isBusy would read its own claim as busy and
      // defer forever. Slot-lease conflicts are re-checked after the claim
      // because only the claim reveals the retained run lineage.
      if (isBusy(item.sessionId, item)) {
        return outbox.defer(item.id, item.leaseToken, 'chat session is busy', {
          delayMs: 0,
        });
      }
      const schedulerClaim = await sessionScheduler.claim(item);
      if (!schedulerClaim.ok) {
        return outbox.defer(item.id, item.leaseToken, schedulerClaim.code || 'session gate closed', {
          delayMs: 0,
        });
      }
      schedulerClaimed = true;
      const claimedActive = schedulerClaim.schedule?.active || {};
      if (!itemTaskRunId(item) && claimedActive.taskRunId) {
        item.turnLineage = {
          ...itemTurnLineage(item),
          taskId: itemTaskId(item) || claimedActive.taskId || null,
          taskRunId: claimedActive.taskRunId,
          leaseEpoch: claimedActive.leaseEpoch || null,
          originDispatchId: itemOriginDispatchId(item)
            || claimedActive.originDispatchId || null,
        };
      }
      if (isSlotUnavailable(item.sessionId, item)) {
        await sessionScheduler.releaseClaim(item, 'host_busy_after_claim');
        schedulerClaimed = false;
        return outbox.defer(item.id, item.leaseToken, 'task execution slot is leased to another run', {
          delayMs: 0,
        });
      }
      if (await hasPersistedDelivery(item.sessionId, deliveryId)) {
        const acknowledged = await acknowledgeDelivery(item);
        const recovered = getSessionRecoveryState(item.sessionId) || {};
        await sessionScheduler.settlePersistedDelivery(item, recovered);
        return acknowledged;
      }
      const descriptor = {
        item,
        sessionId: item.sessionId,
        text: deliveryText(item),
        opts: deliveryOptions(item),
        taskId: itemTaskId(item),
        taskRunId: itemTaskRunId(item),
        leaseEpoch: itemLeaseEpoch(item),
      };
      deliveryGuard = await Promise.resolve(beforeDeliver(descriptor));
      const accepted = await Promise.resolve(
        typeof deliverOutbox === 'function'
          ? deliverOutbox(descriptor)
          : runChatTurn(descriptor.sessionId, descriptor.text, descriptor.opts),
      );
      if (!accepted) {
        // Delivery is transport state, never FIFO/classify state. Roll back the
        // lease-side claim and retry this item without freezing the session.
        await sessionScheduler.releaseClaim(item, 'delivery_deferred');
        return outbox.fail(item.id, item.leaseToken, 'runChatTurn rejected delivery', {
          retryable: true,
        });
      }
      if (!await hasPersistedDelivery(item.sessionId, deliveryId)) {
        await sessionScheduler.releaseClaim(item, 'message_not_durable');
        return outbox.fail(item.id, item.leaseToken, 'chat history did not persist delivery', {
          retryable: true,
        });
      }
      deliveryOutcome = { accepted: true, durable: true };
      const acknowledged = await acknowledgeDelivery(item);
      if (acknowledged.ok) await sessionScheduler.started(item);
      return acknowledged;
    } catch (error) {
      log(`[orchestration] delivery ${item.id} failed: ${error.message}`);
      if (schedulerClaimed) {
        await sessionScheduler.releaseClaim(item, 'delivery_error').catch(() => {});
      }
      return outbox.fail(item.id, item.leaseToken, error, { retryable: true });
    } finally {
      if (deliveryGuard && typeof deliveryGuard.complete === 'function') {
        await Promise.resolve(deliveryGuard.complete(deliveryOutcome)).catch(error => {
          log(`[orchestration] delivery guard ${item.id} cleanup failed: ${error.message}`);
        });
      }
    }
  }

  async function processOutbox() {
    const selectRunnableSessionItem = (items, draft, at) => {
      const item = sessionScheduler.selectSessionItem(items, draft, at);
      const projected = item && sessionScheduler.projectItemLineage(item, draft);
      // Do not create a durable lease merely to discover the host process is
      // busy and immediately defer it. The next 1s tick will reconsider it.
      return item && !isBusy(item.sessionId, projected) ? item : null;
    };
    const claimed = await outbox.claim({
      workerId,
      limit: claimLimit,
      selectSessionItem: selectRunnableSessionItem,
    });
    await Promise.all(claimed.map(deliver));
    return claimed.length;
  }

  async function ensureDetachedOperation(operation) {
    if (!detachedAdapter) return null;
    let state = await Promise.resolve(detachedAdapter.status(operation.externalId));
    if (!state || state.started === false) {
      await Promise.resolve(detachedAdapter.launch({
        id: operation.externalId,
        command: operation.spec.command,
        cwd: operation.spec.cwd,
        label: operation.spec.label,
      }));
      state = await Promise.resolve(detachedAdapter.status(operation.externalId));
    }
    if (state && state.done) {
      await operations.completeDetached(operation.id, {
        status: state.exitCode === 0 ? 'completed' : 'failed',
        exitCode: state.exitCode,
        logTail: state.logTail || '',
      });
    } else if (state && state.running) {
      await operations.markRunning(operation.id, { externalId: operation.externalId, pid: state.pid });
    } else if (state && state.started && !state.running) {
      await operations.completeDetached(operation.id, {
        status: 'interrupted',
        error: 'detached process is no longer alive and no completion marker exists',
        exitCode: null,
        logTail: state.logTail || '',
        deliveryText: `🔇【后台任务已中断】${operation.spec.label || operation.spec.command.slice(0, 60)} 的进程已不存在，且没有完成标记；系统未自动重跑，以避免重复外部副作用。`,
      });
    }
    return state;
  }

  async function reconcileDetached() {
    if (!detachedAdapter) return;
    const active = await operations.list({
      kind: 'detached',
      statuses: ['admitted', 'running'],
    });
    for (const operation of active) {
      try { await ensureDetachedOperation(operation); }
      catch (error) { log(`[orchestration] detached ${operation.id} reconcile failed: ${error.message}`); }
    }
  }

  async function reconcileDispatchesOnStartup() {
    const active = await operations.list({
      kind: 'dispatch',
      statuses: ['admitted', 'running'],
    });
    for (const operation of active) {
      const request = operation.requestOutboxId
        ? await outbox.get(operation.requestOutboxId)
        : null;
      // A crash may occur after runChatTurn durably saved the dispatch user
      // message but before the request lease was acknowledged. Treat that as
      // delivered evidence during startup reconciliation; the regular outbox
      // tick below will independently recover/ack the lease without replaying
      // the target turn because hasPersistedDelivery() is the same guard.
      const requestPersisted = request && ['pending', 'leased'].includes(request.state)
        ? await hasPersistedDelivery(request.sessionId, request.id)
        : false;
      if (request && ['pending', 'leased'].includes(request.state) && !requestPersisted) continue;
      if (request && request.state === 'dead-letter') {
        await operations.completeDispatch(operation.id, {
          status: 'interrupted',
          error: 'dispatch request delivery exhausted retries',
        });
        continue;
      }
      if ((!request || request.state !== 'delivered') && !requestPersisted) continue;
      let recovered = null;
      try { recovered = await recoverDispatchResult(operation); }
      catch (error) { log(`[orchestration] dispatch ${operation.id} history recovery failed: ${error.message}`); }
      if (recovered && recovered.completed) {
        await replayRecoveredDispatchEffects(operation, recovered);
        await operations.completeDispatch(operation.id, {
          status: 'completed',
          text: recovered.text || '',
          recovered: true,
        });
      } else {
        await operations.completeDispatch(operation.id, {
          status: 'interrupted',
          error: 'service restarted before a recoverable dispatch result was persisted',
          lastOutput: recovered?.lastOutput || '',
        });
      }
    }
  }

  async function startDetached(spec = {}) {
    if (!detachedAdapter) throw new Error('detached adapter is not configured');
    const operation = await operations.admitDetached(spec);
    if (!TERMINAL_OPERATION_STATES.has(operation.status)) {
      await ensureDetachedOperation(operation);
    }
    const current = await operations.get(operation.id);
    const state = await Promise.resolve(detachedAdapter.status(operation.externalId));
    return { operation: current, state, idempotent: operation.idempotent };
  }

  // `operations.admitDispatch` writes the operation and its request outbox row in
  // one atomic mutation — that write *is* the admission commit point. Everything
  // after it is an observer of already-durable work.
  //
  // noteQueued only refreshes the in-memory queue projection and emits a
  // `queued` UI event; it owns no durability. So a failure there must never turn
  // a committed admission into a rejected call — the caller would report "not
  // submitted" for work that is in fact queued and will run. Log it, keep the
  // admitted operation as-is, and let the next tick/recover() rebuild the same
  // projection from the store.
  async function admitDispatch(spec) {
    const admitted = await operations.admitDispatch(spec);
    if (admitted.requestOutboxId && !admitted.idempotent) {
      // The operation is durable the moment operations.admitDispatch returns.
      // A scheduler that then fails to record the queue entry has cost the
      // immediate wake-up and nothing more — the regular tick still claims the
      // work. Rethrowing would report committed work as rejected, and the caller
      // would submit it a second time.
      try {
        const notice = await sessionScheduler.noteQueued(admitted.requestOutboxId);
        if (!notice?.ok) {
          const message = `queue notice failed: ${notice?.code || 'unknown'}`;
          log(`[orchestration] admission_queue_projection_degraded ${JSON.stringify({
            operationId: admitted.id,
            entryId: admitted.requestOutboxId,
            sessionId: spec?.spec?.chatId || spec?.ownerSessionId || null,
            error: message,
          })}`);
          return { ...admitted, wakeupError: message };
        }
      } catch (error) {
        log(`[orchestration] admission_queue_projection_degraded ${JSON.stringify({
          operationId: admitted.id,
          entryId: admitted.requestOutboxId,
          sessionId: spec?.spec?.chatId || spec?.ownerSessionId || null,
          error: error?.message || String(error),
        })}`);
        return { ...admitted, wakeupError: error?.message || String(error) };
      }
    }
    return admitted;
  }

  async function admitSessionWork(spec) {
    const admitted = await sessionScheduler.admit(spec);
    if (admitted.ok) await tick();
    const current = admitted.ok ? await sessionScheduler.status(spec.sessionId) : admitted.schedule;
    return {
      ...admitted,
      status: current?.state || null,
      queued: admitted.ok ? admitted.queued : false,
      schedule: current,
    };
  }

  async function completeDispatch(id, result) {
    const completed = await operations.completeDispatch(id, result);
    if (completed && completed.ok) await tick();
    return completed;
  }

  async function interruptDispatch(id, {
    reason = 'dispatch target turn was interrupted without a successor',
    source = 'session_cancel',
  } = {}) {
    const current = await operations.get(id);
    if (!current || current.kind !== 'dispatch') return { ok: false, code: 'not_found' };
    if (TERMINAL_OPERATION_STATES.has(current.status)) {
      return {
        ok: true,
        idempotent: true,
        status: current.status,
        operation: current,
      };
    }
    return completeDispatch(id, {
      status: 'interrupted',
      error: String(reason || 'dispatch interrupted').slice(0, 2000),
      source: String(source || 'session_cancel').slice(0, 80),
    });
  }

  async function observeTask(observation) {
    return operations.observeTask(observation);
  }

  async function runTick() {
    await reconcileDetached();
    await processPolls();
    return processOutbox();
  }

  function tick() {
    const operation = tickTail.then(runTick, runTick);
    tickTail = operation.catch(error => {
      log(`[orchestration] worker tick failed: ${error.message}`);
    });
    return operation;
  }

  async function start() {
    if (started) return;
    if (stopped) throw new Error('[orchestration-runtime] cannot restart a stopped runtime');
    started = true;
    await outbox.recoverExpired();
    await refreshPending();
    await operations.interruptActiveTasks();
    // recover() reads only stateForSession — the persisted classify/queue state.
    // It never consulted isBusy/hasPendingWait, so they are not passed.
    await sessionScheduler.recover({ stateForSession: getSessionRecoveryState });
    await beforeFirstTick({ sessionScheduler, operations, outbox });
    await reconcileDispatchesOnStartup();
    await reconcileDetached();
    await tick();
    timer = setIntervalFn(() => { tick().catch(() => {}); }, workerIntervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    if (timer) clearIntervalFn(timer);
    timer = null;
    // Graceful shutdown kills CLI-owned Agent/Task subprocesses. Record that
    // fact before flushing; the notification remains in the same durable
    // outbox and is delivered after the next start. Detached OS jobs and
    // dispatches are intentionally left active for their dedicated reconcile.
    await operations.interruptActiveTasks();
    await tickTail;
    await store.flush();
    if (typeof store.exportLegacy === 'function') await store.exportLegacy();
  }

  async function dispose() {
    await stop();
    if (typeof store.close === 'function') await store.close({ exportRollback: false });
  }

  return Object.freeze({
    store,
    outbox,
    waits,
    operations,
    sessionScheduler,
    start,
    stop,
    dispose,
    tick,
    register,
    scheduleMessage,
    listScheduledMessages,
    cancelScheduledMessage,
    resolveCallback,
    cancel,
    cancelForSession,
    listForSession,
    hasSessionActivity,
    stats,
    hasPending,
    pendingCount,
    refreshPending,
    startDetached,
    admitDispatch,
    admitSessionWork,
    completeDispatch,
    interruptDispatch,
    observeTask,
  });
}

module.exports = { createOrchestrationRuntime, publicWait, DEFAULTS };
