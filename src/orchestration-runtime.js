'use strict';

// Composition layer for the durable orchestration primitives.  The store,
// wait service and outbox deliberately know nothing about MultiCC chat.  This
// module owns the lifecycle and the one-way bridge from a durable outbox item
// to runChatTurn().

const crypto = require('crypto');
const { createOrchestrationStore } = require('./orchestration-store');
const { createOutbox } = require('./outbox');
const { createWaitService } = require('./wait-service');

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
  probe = async () => { throw new Error('poll probe is not configured'); },
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
    const result = await store.mutate(draft => {
      const at = Number(now());
      let cancelled = 0;
      let cancelledDeliveries = 0;
      for (const wait of Object.values(draft.waits)) {
        if (wait.sessionId !== sessionId || wait.status !== 'pending') continue;
        wait.status = 'cancelled';
        wait.cancelledAt = at;
        wait.updatedAt = at;
        cancelled++;
      }
      for (const item of Object.values(draft.outbox)) {
        if (item.sessionId !== sessionId || !['pending', 'leased'].includes(item.state)) continue;
        item.state = 'cancelled';
        item.updatedAt = at;
        item.leasedAt = null;
        item.leasedUntil = null;
        item.leaseOwner = null;
        item.leaseTokenHash = null;
        cancelledDeliveries++;
      }
      return { ok: true, cancelled, cancelledDeliveries };
    });
    pendingBySession.delete(sessionId);
    return result;
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
    if (typeof payload.deliveryText === 'string' && payload.deliveryText) return payload.deliveryText;
    const defaultPrefix = payload.mode === 'poll' ? '[轮询条件已满足]' : '[等待的数据已返回]';
    const prefix = payload.injectPrefix || defaultPrefix;
    return `${prefix}\n${renderData(payload.data)}`;
  }

  async function deliver(item) {
    const deliveryId = item.id;
    try {
      if (await hasPersistedDelivery(item.sessionId, deliveryId)) {
        return outbox.ack(item.id, item.leaseToken);
      }
      if (isBusy(item.sessionId)) {
        return outbox.fail(item.id, item.leaseToken, 'chat session is busy');
      }
      const accepted = await Promise.resolve(runChatTurn(
        item.sessionId,
        deliveryText(item),
        {
          originContinue: true,
          deliveryId,
          clientMsgId: deliveryId,
        },
      ));
      if (!accepted) {
        return outbox.fail(item.id, item.leaseToken, 'runChatTurn rejected delivery');
      }
      if (!await hasPersistedDelivery(item.sessionId, deliveryId)) {
        return outbox.fail(item.id, item.leaseToken, 'chat history did not persist delivery');
      }
      return outbox.ack(item.id, item.leaseToken);
    } catch (error) {
      log(`[orchestration] delivery ${item.id} failed: ${error.message}`);
      return outbox.fail(item.id, item.leaseToken, error);
    }
  }

  async function processOutbox() {
    const claimed = await outbox.claim({ workerId, limit: claimLimit });
    await Promise.all(claimed.map(deliver));
    return claimed.length;
  }

  async function runTick() {
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
    await tick();
    timer = setIntervalFn(() => { tick().catch(() => {}); }, workerIntervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    if (timer) clearIntervalFn(timer);
    timer = null;
    await tickTail;
    await store.flush();
  }

  return Object.freeze({
    store,
    outbox,
    waits,
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
  });
}

module.exports = { createOrchestrationRuntime, publicWait, DEFAULTS };
