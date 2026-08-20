'use strict';

const crypto = require('crypto');
const {
  admitOutboxItem,
  hashPayload,
  hashSecret,
  normalizeJson,
  timingSafeHashEqual,
} = require('./outbox');

function publicWait(wait) {
  const copy = JSON.parse(JSON.stringify(wait));
  delete copy.callbackTokenHash;
  delete copy.resolutionPayloadHash;
  return copy;
}

function createWaitService({
  store,
  now = Date.now,
  cryptoImpl = crypto,
  idFactory = () => `wait_${cryptoImpl.randomUUID()}`,
  callbackTokenFactory = () => cryptoImpl.randomBytes(32).toString('base64url'),
  callbackBaseUrl = '',
  callbackUrlFactory,
} = {}) {
  if (!store || typeof store.mutate !== 'function' || typeof store.read !== 'function') {
    throw new TypeError('[wait-service] create requires an orchestration store');
  }

  function callbackUrl(id, token) {
    if (typeof callbackUrlFactory === 'function') return callbackUrlFactory({ id, token });
    if (!callbackBaseUrl) return null;
    const base = String(callbackBaseUrl).replace(/\/+$/, '');
    return `${base}/api/orchestration/waits/${encodeURIComponent(id)}/callback?token=${encodeURIComponent(token)}`;
  }

  async function register({
    id = idFactory(),
    sessionId,
    mode = 'callback',
    injectPrefix = '',
    metadata = null,
  } = {}) {
    if (!id || typeof id !== 'string') throw new TypeError('[wait-service] wait id is required');
    if (!sessionId || typeof sessionId !== 'string') {
      throw new TypeError('[wait-service] sessionId is required');
    }
    if (!['callback', 'poll', 'delay'].includes(mode)) {
      throw new TypeError('[wait-service] mode must be callback, poll or delay');
    }

    const token = mode === 'callback' ? String(callbackTokenFactory()) : null;
    if (mode === 'callback' && !token) {
      throw new Error('[wait-service] callbackTokenFactory returned an empty token');
    }
    const callbackTokenHash = token ? hashSecret(token, cryptoImpl) : null;
    const normalizedMetadata = metadata === null ? null : normalizeJson(metadata);

    const result = await store.mutate(draft => {
      if (draft.waits[id]) {
        const error = new Error(`wait ${id} already exists`);
        error.code = 'WAIT_ALREADY_EXISTS';
        error.statusCode = 409;
        throw error;
      }
      const at = Number(now());
      const wait = {
        id,
        sessionId,
        mode,
        status: 'pending',
        injectPrefix: String(injectPrefix || ''),
        metadata: normalizedMetadata,
        callbackTokenHash,
        createdAt: at,
        updatedAt: at,
        resolvedAt: null,
        cancelledAt: null,
        resolutionPayloadHash: null,
        outboxId: null,
      };
      draft.waits[id] = wait;
      return publicWait(wait);
    });

    return {
      ...result,
      ...(token ? { token, callbackUrl: callbackUrl(id, token) } : {}),
    };
  }

  async function resolveInternal(id, payload, {
    callbackToken,
    expectedMode,
    deliveryText,
    sessionWork = null,
  } = {}) {
    if (!id || typeof id !== 'string') {
      throw new TypeError('[wait-service] resolve requires wait id');
    }
    return store.mutate(draft => {
      const wait = draft.waits[id];
      if (!wait) return { ok: false, code: 'not_found' };
      if (expectedMode && wait.mode !== expectedMode) {
        return { ok: false, code: 'mode_mismatch' };
      }
      if (wait.mode === 'callback'
          && !timingSafeHashEqual(wait.callbackTokenHash, callbackToken, cryptoImpl)) {
        return { ok: false, code: 'invalid_token' };
      }
      // Authenticate callback capabilities before normalizing or hashing an
      // attacker-controlled payload.  The mutation remains serialized and the
      // token comparison still always uses equal-length buffers.
      const normalizedPayload = normalizeJson(payload);
      const payloadHash = hashPayload(normalizedPayload, cryptoImpl);
      if (wait.status === 'resolved') {
        if (wait.resolutionPayloadHash === payloadHash) {
          return {
            ok: true,
            idempotent: true,
            waitId: wait.id,
            outboxId: wait.outboxId,
          };
        }
        return {
          ok: false,
          code: 'payload_conflict',
          statusCode: 409,
          waitId: wait.id,
          outboxId: wait.outboxId,
        };
      }
      if (wait.status !== 'pending') {
        return { ok: false, code: 'not_pending', status: wait.status };
      }

      const at = Number(now());
      const outboxId = `wait:${wait.id}`;
      const sessionWorkText = typeof sessionWork?.text === 'string'
        ? sessionWork.text.trim() : '';
      const outboxPayload = sessionWorkText
        ? {
          type: 'session.work',
          // A timer represents user-authored future work, not an internal
          // callback/continuation. Keeping it as task work makes an active P
          // turn stage it in the ordinary FIFO instead of crossing that turn.
          workKind: 'task',
          message: sessionWorkText,
          options: {
            originContinue: false,
            clientMsgId: outboxId,
            scheduledMessageId: wait.id,
            receivedAt: at,
          },
          source: 'scheduled',
          taskId: null,
          taskRunId: null,
          leaseEpoch: null,
          requestId: null,
          activeEntryId: null,
        }
        : {
          type: 'wait.resolved',
          waitId: wait.id,
          mode: wait.mode,
          injectPrefix: wait.injectPrefix,
          data: normalizedPayload,
          deliveryText: typeof deliveryText === 'string' ? deliveryText : null,
          ...(wait.metadata?.taskId ? { taskId: wait.metadata.taskId } : {}),
          ...(wait.metadata?.taskRunId ? {
            taskRunId: wait.metadata.taskRunId,
            leaseEpoch: wait.metadata.leaseEpoch,
          } : {}),
          ...(wait.metadata?.originDispatchId
            ? { originDispatchId: wait.metadata.originDispatchId }
            : {}),
        };
      const admitted = admitOutboxItem(draft, {
        id: outboxId,
        sessionId: wait.sessionId,
        payload: outboxPayload,
        source: { type: 'wait', waitId: wait.id },
        now: at,
      });
      // A scheduled user message behaves like a normal direct submission once
      // its clock expires: W/B/E at-rest verdicts must not strand it. While a P
      // turn is active, task work remains in the ordinary FIFO.
      if (sessionWorkText && draft.outbox[admitted.item.id]) {
        draft.outbox[admitted.item.id].directRun = true;
      }

      wait.status = 'resolved';
      wait.resolvedAt = at;
      wait.updatedAt = at;
      wait.resolutionPayloadHash = payloadHash;
      wait.outboxId = admitted.item.id;

      return {
        ok: true,
        idempotent: admitted.idempotent,
        waitId: wait.id,
        outboxId: admitted.item.id,
      };
    });
  }

  async function resolveCallback(id, token, payload) {
    return resolveInternal(id, payload, { callbackToken: token, expectedMode: 'callback' });
  }

  async function resolvePoll(id, payload, options = {}) {
    return resolveInternal(id, payload, { expectedMode: 'poll', deliveryText: options.deliveryText });
  }

  async function resolveDelay(id, payload, options = {}) {
    return resolveInternal(id, payload, {
      expectedMode: 'delay',
      deliveryText: options.deliveryText,
      sessionWork: options.sessionWork,
    });
  }

  async function cancel(id) {
    return store.mutate(draft => {
      const wait = draft.waits[id];
      if (!wait) return { ok: false, code: 'not_found' };
      if (wait.status === 'cancelled') return { ok: true, idempotent: true };
      if (wait.status !== 'pending') {
        return { ok: false, code: 'not_pending', status: wait.status };
      }
      const at = Number(now());
      wait.status = 'cancelled';
      wait.cancelledAt = at;
      wait.updatedAt = at;
      return { ok: true, idempotent: false };
    });
  }

  async function cancelForSession(sessionId) {
    return store.mutate(draft => {
      const at = Number(now());
      let cancelled = 0;
      for (const wait of Object.values(draft.waits)) {
        if (wait.sessionId !== sessionId || wait.status !== 'pending') continue;
        wait.status = 'cancelled';
        wait.cancelledAt = at;
        wait.updatedAt = at;
        cancelled++;
      }
      return { ok: true, cancelled };
    });
  }

  async function get(id) {
    return store.read(draft => draft.waits[id] ? publicWait(draft.waits[id]) : null);
  }

  async function list({ sessionId, status } = {}) {
    return store.read(draft => Object.values(draft.waits)
      .filter(wait => !sessionId || wait.sessionId === sessionId)
      .filter(wait => !status || wait.status === status)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .map(publicWait));
  }

  return Object.freeze({
    register,
    resolveCallback,
    resolvePoll,
    resolveDelay,
    cancel,
    cancelForSession,
    get,
    list,
  });
}

module.exports = { createWaitService };
