'use strict';

// SQLite supplies indexed candidates inside this read/write snapshot. The JSON
// compatibility store keeps the old scan; callers retain their exact predicates.
function candidateRows(draft, collection, where) {
  return typeof draft.select === 'function'
    ? draft.select(collection, { where }) : Object.values(draft[collection]);
}

const crypto = require('crypto');
const { getNative } = require('../native/runtime');
const {
  OutboxConflictError,
  hashSecret,
  normalizeJson,
} = require('../outbox');

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
    const input = { callbackToken, expectedMode, deliveryText, sessionWork };
    const args = [id, payload, input, now, cryptoImpl, crypto, OutboxConflictError];
    if (typeof store.runNativeCommandSync === 'function') {
      const { value } = await store.runNativeCommandSync('waitResolve', ...args);
      return value;
    }
    // Custom stores still supply the synchronous transaction callback. Rust
    // owns the transition; this is only the compatibility transport.
    return store.mutate(draft => getNative().waitResolveLive(draft, ...args));
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
    const mutate = draft => getNative().waitCancelLive(draft, id, now);
    if (typeof store.cancelWait === 'function') return store.cancelWait(id, now, mutate);
    return store.mutate(mutate);
  }

  async function cancelForSession(sessionId) {
    return store.mutate(draft => {
      const at = Number(now());
      let cancelled = 0;
      for (const wait of candidateRows(draft, 'waits', { sessionId, status: 'pending' })) {
        if (wait.sessionId !== sessionId || wait.status !== 'pending') continue;
        wait.status = 'cancelled';
        wait.cancelledAt = at;
        wait.updatedAt = at;
        cancelled++;
      }
      return { ok: true, cancelled };
    });
  }

  function waitProjection(wait) {
    if (!wait) return null;
    const copy = { ...wait };
    delete copy.callbackTokenHash;
    delete copy.resolutionPayloadHash;
    return copy;
  }

  async function get(id) {
    return store.read(draft => waitProjection(draft.waits[id]));
  }

  async function list({ sessionId, status } = {}) {
    return store.read(draft => candidateRows(draft, 'waits', {
      ...(sessionId ? { sessionId } : {}), ...(status ? { status } : {}),
    })
      .filter(wait => !sessionId || wait.sessionId === sessionId)
      .filter(wait => !status || wait.status === status)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .map(waitProjection));
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
