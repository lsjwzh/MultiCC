'use strict';

// Composition layer for the durable orchestration primitives.  The store,
// wait service and outbox deliberately know nothing about MultiCC chat.  This
// module owns the lifecycle and the one-way bridge from a durable outbox item
// to runChatTurn().

const crypto = require('crypto');
const { createOrchestrationStore } = require('./orchestration-store');
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
});

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
    createdAt: wait.createdAt,
    resolvedAt: wait.resolvedAt,
    cancelledAt: wait.cancelledAt,
  };
}

function createOrchestrationRuntime({
  file,
  runChatTurn,
  isBusy = () => false,
  hasPersistedDelivery = async () => false,
  deliverOutbox = null,
  probe = async () => { throw new Error('poll probe is not configured'); },
  detachedAdapter = null,
  recoverDispatchResult = async () => null,
  replayRecoveredDispatchEffects = async () => {},
  getSessionRecoveryState = () => null,
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
  if (!file || typeof file !== 'string') throw new TypeError('[orchestration-runtime] file is required');
  if (typeof runChatTurn !== 'function') {
    throw new TypeError('[orchestration-runtime] runChatTurn is required');
  }
  if (typeof hasPersistedDelivery !== 'function') {
    throw new TypeError('[orchestration-runtime] hasPersistedDelivery must be a function');
  }

  const store = createOrchestrationStore({ file, now, ...storeOptions });
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

  async function refreshPending() {
    const pending = await waits.list({ status: 'pending' });
    pendingBySession.clear();
    for (const wait of pending) addPending(wait.sessionId, wait.id);
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
    const mode = spec.mode === 'callback' ? 'callback' : 'poll';
    const at = Number(now());
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
      };
    } else {
      const timeoutSec = Math.max(10, asFinite(spec.timeoutSec, DEFAULTS.timeoutSec));
      metadata = { timeoutSec, expireAt: at + timeoutSec * 1000 };
    }

    const registered = await waits.register({
      sessionId: spec.session || spec.sessionId,
      mode,
      injectPrefix: spec.injectPrefix || '',
      metadata,
    });
    addPending(registered.sessionId, registered.id);
    return {
      ...registered,
      token: registered.token || null,
      callbackUrl: registered.callbackUrl || null,
      session: registered.sessionId,
      status: 'pending',
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
    const snapshot = await store.snapshot();
    const allWaits = Object.values(snapshot.waits);
    const allOutbox = Object.values(snapshot.outbox);
    return {
      waits: allWaits.filter(wait => wait.status === 'pending').length,
      resolvedWaits: allWaits.filter(wait => wait.status === 'resolved').length,
      pendingDeliveries: allOutbox.filter(item => item.state === 'pending' || item.state === 'leased').length,
      deadLetters: allOutbox.filter(item => item.state === 'dead-letter').length,
    };
  }

  function matches(metadata, output) {
    if (metadata.untilContains) return output.includes(metadata.untilContains);
    if (metadata.untilRegex) {
      try { return new RegExp(metadata.untilRegex).test(output); }
      catch (_) { return false; }
    }
    return false;
  }

  async function claimDuePolls() {
    const result = await store.mutate(draft => {
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
        const leaseActive = metadata.pollLeaseId
          && Number.isFinite(metadata.pollLeasedUntil)
          && metadata.pollLeasedUntil > at;
        if (leaseActive || !Number.isFinite(metadata.nextAt) || metadata.nextAt > at) continue;
        const pollLeaseId = crypto.randomBytes(16).toString('hex');
        metadata.pollLeaseId = pollLeaseId;
        metadata.pollLeasedUntil = at + pollLeaseMs;
        wait.metadata = metadata;
        wait.updatedAt = at;
        claims.push({ id: wait.id, sessionId: wait.sessionId, pollLeaseId, metadata: JSON.parse(JSON.stringify(metadata)) });
      }
      return { claims, expired };
    });
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
    const defaultPrefix = payload.mode === 'poll' ? '[轮询条件已满足]' : '[等待的数据已返回]';
    const prefix = payload.injectPrefix || defaultPrefix;
    return `${prefix}\n${renderData(payload.data)}`;
  }

  function deliveryOptions(item) {
    const payload = item.payload || {};
    if (payload.type === 'session.work') {
      return {
        ...(payload.options || {}),
        originContinue: payload.workKind !== 'task',
        deliveryId: item.id,
        // Keep the browser correlation key so chat_msg_meta can replace the
        // optimistic user bubble. The durable outbox id remains deliveryId.
        clientMsgId: payload.options?.clientMsgId || item.id,
        schedulerEntryId: payload.activeEntryId || item.id,
        schedulerWorkKind: payload.workKind || 'task',
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
        taskStart: payload.taskStart === true,
        taskSource: payload.taskSource || undefined,
        taskText: payload.taskText || undefined,
      };
    }
    return {
      originContinue: true,
      deliveryId: item.id,
      clientMsgId: item.id,
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
    try {
      if (isBusy(item.sessionId)) {
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
      };
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
      const acknowledged = await acknowledgeDelivery(item);
      if (acknowledged.ok) await sessionScheduler.started(item);
      return acknowledged;
    } catch (error) {
      log(`[orchestration] delivery ${item.id} failed: ${error.message}`);
      if (schedulerClaimed) {
        await sessionScheduler.releaseClaim(item, 'delivery_error').catch(() => {});
      }
      return outbox.fail(item.id, item.leaseToken, error, { retryable: true });
    }
  }

  async function processOutbox() {
    const claimed = await outbox.claim({
      workerId,
      limit: claimLimit,
      selectSessionItem: sessionScheduler.selectSessionItem,
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

  async function admitDispatch(spec) {
    const admitted = await operations.admitDispatch(spec);
    if (admitted.requestOutboxId && !admitted.idempotent) {
      await sessionScheduler.noteQueued(admitted.requestOutboxId);
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
      queued: !!current?.active && current.active.entryId !== admitted.entry?.id,
      schedule: current,
    };
  }

  async function completeDispatch(id, result) {
    return operations.completeDispatch(id, result);
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
    await sessionScheduler.recover({
      stateForSession: getSessionRecoveryState,
      isBusy,
      hasPendingWait: hasPending,
    });
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
  }

  return Object.freeze({
    store,
    outbox,
    waits,
    operations,
    sessionScheduler,
    start,
    stop,
    tick,
    register,
    resolveCallback,
    cancel,
    cancelForSession,
    listForSession,
    stats,
    hasPending,
    pendingCount,
    refreshPending,
    startDetached,
    admitDispatch,
    admitSessionWork,
    completeDispatch,
    observeTask,
  });
}

module.exports = { createOrchestrationRuntime, publicWait, DEFAULTS };
