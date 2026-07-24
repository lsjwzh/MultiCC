'use strict';

const crypto = require('crypto');

const TERMINAL_STATES = new Set(['delivered', 'dead-letter', 'cancelled']);

class OutboxConflictError extends Error {
  constructor(id) {
    super(`outbox item ${id} already exists with different content`);
    this.name = 'OutboxConflictError';
    this.code = 'OUTBOX_PAYLOAD_CONFLICT';
    this.statusCode = 409;
    this.outboxId = id;
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Canonical JSON makes callback retry equality independent of object key order.
// It intentionally rejects values JSON would silently discard (undefined,
// functions, symbols, cycles, non-finite numbers), because those values cannot
// be reconstructed from the durable file.
function canonicalize(value, seen = new Set()) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('outbox payload numbers must be finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError('outbox payload cannot contain cycles');
    seen.add(value);
    try {
      return `[${value.map(item => canonicalize(item, seen)).join(',')}]`;
    } finally {
      seen.delete(value);
    }
  }
  if (isPlainObject(value)) {
    if (seen.has(value)) throw new TypeError('outbox payload cannot contain cycles');
    seen.add(value);
    try {
      return `{${Object.keys(value).sort().map(key => (
        `${JSON.stringify(key)}:${canonicalize(value[key], seen)}`
      )).join(',')}}`;
    } finally {
      seen.delete(value);
    }
  }
  throw new TypeError(`outbox payload contains unsupported ${typeof value}`);
}

function normalizeJson(value) {
  return JSON.parse(canonicalize(value));
}

function hashPayload(value, cryptoImpl = crypto) {
  return cryptoImpl.createHash('sha256').update(canonicalize(value)).digest('hex');
}

function hashSecret(value, cryptoImpl = crypto) {
  return cryptoImpl.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function timingSafeHashEqual(expectedHex, rawValue, cryptoImpl = crypto) {
  const actual = cryptoImpl.createHash('sha256').update(String(rawValue), 'utf8').digest();
  let expected = Buffer.alloc(actual.length);
  let valid = false;
  if (typeof expectedHex === 'string' && /^[a-f0-9]{64}$/i.test(expectedHex)) {
    expected = Buffer.from(expectedHex, 'hex');
    valid = expected.length === actual.length;
  }
  // Always compare equal-length buffers so malformed records and wrong tokens
  // follow the same constant-time primitive.
  const equal = cryptoImpl.timingSafeEqual(actual, valid ? expected : Buffer.alloc(actual.length));
  return valid && equal;
}

function assertDraft(draft) {
  if (!draft || typeof draft !== 'object' || !draft.outbox || typeof draft.outbox !== 'object') {
    throw new TypeError('outbox mutation requires an orchestration-store draft');
  }
  if (!Number.isSafeInteger(draft.nextOutboxSequence) || draft.nextOutboxSequence < 1) {
    throw new TypeError('outbox draft has an invalid sequence');
  }
}

function admitOutboxItem(draft, {
  id,
  sessionId,
  payload,
  source = null,
  now,
  availableAt = now,
} = {}) {
  assertDraft(draft);
  if (!id || typeof id !== 'string') throw new TypeError('outbox item requires id');
  if (!sessionId || typeof sessionId !== 'string') {
    throw new TypeError('outbox item requires sessionId');
  }
  if (!Number.isFinite(now) || !Number.isFinite(availableAt)) {
    throw new TypeError('outbox timestamps must be finite numbers');
  }

  const normalizedPayload = normalizeJson(payload);
  const payloadHash = hashPayload(normalizedPayload);
  const normalizedSource = source === null ? null : normalizeJson(source);
  const existing = draft.outbox[id];
  if (existing) {
    if (existing.sessionId === sessionId && existing.payloadHash === payloadHash) {
      return { item: existing, idempotent: true };
    }
    throw new OutboxConflictError(id);
  }

  const item = {
    id,
    sessionId,
    sequence: draft.nextOutboxSequence++,
    state: 'pending',
    payload: normalizedPayload,
    payloadHash,
    source: normalizedSource,
    attempts: 0,
    availableAt,
    createdAt: now,
    updatedAt: now,
    leasedAt: null,
    leasedUntil: null,
    leaseOwner: null,
    leaseTokenHash: null,
    deliveredAt: null,
    deadLetterAt: null,
    lastError: null,
  };
  draft.outbox[id] = item;
  return { item, idempotent: false };
}

function publicItem(item) {
  const copy = JSON.parse(JSON.stringify(item));
  delete copy.leaseTokenHash;
  return copy;
}

function clearLease(item) {
  item.leasedAt = null;
  item.leasedUntil = null;
  item.leaseOwner = null;
  item.leaseTokenHash = null;
}

function errorText(error) {
  const text = error instanceof Error ? error.message : String(error || 'delivery failed');
  return text.slice(0, 2000);
}

function createOutbox({
  store,
  now = Date.now,
  cryptoImpl = crypto,
  idFactory = () => `outbox_${cryptoImpl.randomUUID()}`,
  leaseTokenFactory = () => cryptoImpl.randomBytes(24).toString('base64url'),
  leaseMs = 30_000,
  maxAttempts = 5,
  baseBackoffMs = 1_000,
  maxBackoffMs = 60_000,
  backoff = attempt => Math.min(
    maxBackoffMs,
    baseBackoffMs * (2 ** Math.max(0, attempt - 1)),
  ),
} = {}) {
  if (!store || typeof store.mutate !== 'function' || typeof store.read !== 'function') {
    throw new TypeError('[outbox] create requires an orchestration store');
  }
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new TypeError('[outbox] leaseMs must be > 0');
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError('[outbox] maxAttempts must be a positive integer');
  }

  function retryDelay(attempt) {
    const delay = Number(backoff(attempt));
    if (!Number.isFinite(delay) || delay < 0) {
      throw new TypeError('[outbox] backoff must return a non-negative finite number');
    }
    return delay;
  }

  function recoverExpiredDraft(draft, at) {
    let recovered = 0;
    let deadLettered = 0;
    const ordered = Object.values(draft.outbox).sort((a, b) => a.sequence - b.sequence);
    for (const item of ordered) {
      if (item.state !== 'leased' || item.leasedUntil > at) continue;
      item.lastError = 'delivery lease expired';
      item.updatedAt = at;
      clearLease(item);
      if (item.attempts >= maxAttempts) {
        item.state = 'dead-letter';
        item.deadLetterAt = at;
        deadLettered++;
      } else {
        item.state = 'pending';
        item.availableAt = at + retryDelay(item.attempts);
        recovered++;
      }
    }
    return { recovered, deadLettered };
  }

  async function enqueue({ id = idFactory(), sessionId, payload, source, availableAt } = {}) {
    return store.mutate(draft => {
      const at = Number(now());
      const admitted = admitOutboxItem(draft, {
        id,
        sessionId,
        payload,
        source,
        now: at,
        availableAt: availableAt === undefined ? at : Number(availableAt),
      });
      return { ...publicItem(admitted.item), idempotent: admitted.idempotent };
    });
  }

  async function claim({
    workerId,
    limit = 1,
    leaseForMs = leaseMs,
    selectSessionItem = null,
  } = {}) {
    if (!workerId || typeof workerId !== 'string') {
      throw new TypeError('[outbox] claim requires workerId');
    }
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new TypeError('[outbox] claim limit must be a positive integer');
    }
    if (!Number.isFinite(leaseForMs) || leaseForMs <= 0) {
      throw new TypeError('[outbox] leaseForMs must be > 0');
    }

    return store.mutate(draft => {
      const at = Number(now());
      recoverExpiredDraft(draft, at);

      // Only the oldest non-terminal item for a session may be admitted. A
      // leased item or a retry in backoff blocks later items in that session,
      // while another session remains independently claimable.
      const itemsBySession = new Map();
      const ordered = Object.values(draft.outbox).sort((a, b) => a.sequence - b.sequence);
      for (const item of ordered) {
        if (TERMINAL_STATES.has(item.state)) continue;
        if (!itemsBySession.has(item.sessionId)) itemsBySession.set(item.sessionId, []);
        itemsBySession.get(item.sessionId).push(item);
      }

      const selected = [...itemsBySession.values()]
        .map(items => typeof selectSessionItem === 'function'
          ? selectSessionItem(items, draft, at)
          : items[0])
        .filter(Boolean);
      const candidates = selected
        .filter(item => item.state === 'pending' && item.availableAt <= at)
        .sort((a, b) => a.sequence - b.sequence)
        .slice(0, limit);

      return candidates.map(item => {
        const leaseToken = String(leaseTokenFactory());
        if (!leaseToken) throw new Error('[outbox] leaseTokenFactory returned an empty token');
        item.state = 'leased';
        item.attempts += 1;
        item.leasedAt = at;
        item.leasedUntil = at + Number(leaseForMs);
        item.leaseOwner = workerId;
        item.leaseTokenHash = hashSecret(leaseToken, cryptoImpl);
        item.updatedAt = at;
        return { ...publicItem(item), leaseToken };
      });
    });
  }

  async function acknowledge(id, leaseToken) {
    return store.mutate(draft => {
      const at = Number(now());
      recoverExpiredDraft(draft, at);
      const item = draft.outbox[id];
      if (!item) return { ok: false, code: 'not_found' };
      if (item.state !== 'leased'
          || !timingSafeHashEqual(item.leaseTokenHash, leaseToken, cryptoImpl)) {
        return { ok: false, code: 'lease_lost' };
      }
      item.state = 'delivered';
      item.deliveredAt = at;
      item.updatedAt = at;
      clearLease(item);
      return { ok: true, item: publicItem(item) };
    });
  }

  async function fail(id, leaseToken, error, { retryable = true } = {}) {
    return store.mutate(draft => {
      const at = Number(now());
      recoverExpiredDraft(draft, at);
      const item = draft.outbox[id];
      if (!item) return { ok: false, code: 'not_found' };
      if (item.state !== 'leased'
          || !timingSafeHashEqual(item.leaseTokenHash, leaseToken, cryptoImpl)) {
        return { ok: false, code: 'lease_lost' };
      }

      item.lastError = errorText(error);
      item.updatedAt = at;
      clearLease(item);
      if (retryable && item.attempts < maxAttempts) {
        item.state = 'pending';
        item.availableAt = at + retryDelay(item.attempts);
        return { ok: true, retry: true, availableAt: item.availableAt, item: publicItem(item) };
      }

      item.state = 'dead-letter';
      item.deadLetterAt = at;
      return { ok: true, retry: false, deadLetter: true, item: publicItem(item) };
    });
  }

  // Expected session contention is not a delivery failure. Release the lease
  // without consuming the retry budget so a long-running Commander turn
  // cannot dead-letter a safely queued task merely by remaining busy.
  async function defer(id, leaseToken, reason = 'delivery deferred', { delayMs = baseBackoffMs } = {}) {
    const delay = Number(delayMs);
    if (!Number.isFinite(delay) || delay < 0) throw new TypeError('[outbox] defer delayMs must be non-negative');
    return store.mutate(draft => {
      const at = Number(now());
      recoverExpiredDraft(draft, at);
      const item = draft.outbox[id];
      if (!item) return { ok: false, code: 'not_found' };
      if (item.state !== 'leased'
          || !timingSafeHashEqual(item.leaseTokenHash, leaseToken, cryptoImpl)) {
        return { ok: false, code: 'lease_lost' };
      }
      item.lastError = errorText(reason);
      item.updatedAt = at;
      item.attempts = Math.max(0, item.attempts - 1);
      clearLease(item);
      item.state = 'pending';
      item.availableAt = at + delay;
      return { ok: true, deferred: true, availableAt: item.availableAt, item: publicItem(item) };
    });
  }

  async function recoverExpired() {
    return store.mutate(draft => recoverExpiredDraft(draft, Number(now())));
  }

  async function list({ sessionId, states } = {}) {
    const wanted = states === undefined
      ? null
      : new Set(Array.isArray(states) ? states : [states]);
    return store.read(draft => Object.values(draft.outbox)
      .filter(item => !sessionId || item.sessionId === sessionId)
      .filter(item => !wanted || wanted.has(item.state))
      .sort((a, b) => a.sequence - b.sequence)
      .map(publicItem));
  }

  async function get(id) {
    return store.read(draft => draft.outbox[id] ? publicItem(draft.outbox[id]) : null);
  }

  return Object.freeze({
    enqueue,
    claim,
    acknowledge,
    ack: acknowledge,
    fail,
    defer,
    recoverExpired,
    list,
    get,
  });
}

module.exports = {
  OutboxConflictError,
  createOutbox,
  admitOutboxItem,
  canonicalize,
  normalizeJson,
  hashPayload,
  hashSecret,
  timingSafeHashEqual,
};
