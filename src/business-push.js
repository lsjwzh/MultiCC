'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { sanitizePublicText } = require('./http/public-safety');
const { atomicWriteJson } = require('./runtime-security');

const RECEIPT_VERSION = 1;
const DEFAULT_RECEIPT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_RECEIPTS = 4096;
const ALLOWED_FIELDS = new Set(['title', 'body', 'type', 'tag', 'url', 'dedupeKey']);
const ALLOWED_TYPES = new Set(['strategy-actionable', 'strategy-test']);
const SAFE_TAG_RE = /^[A-Za-z0-9._:-]+$/;
const SAFE_DEDUPE_KEY_RE = /^[A-Za-z0-9._:+|-]+$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const TITLE_CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/u;
const BODY_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000d\u000e-\u001f\u007f-\u009f]/u;

class BusinessPushRequestError extends Error {
  constructor(code, field, message) {
    super(message || code);
    this.name = 'BusinessPushRequestError';
    this.code = code;
    this.field = field || undefined;
    this.statusCode = code === 'IDEMPOTENCY_KEY_REUSE' ? 409 : 400;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function codePointLength(value) {
  return Array.from(value).length;
}

function requireText(input, field, maxLength, controlPattern) {
  const value = input[field];
  if (typeof value !== 'string') {
    throw new BusinessPushRequestError('INVALID_FIELD_TYPE', field);
  }
  if (value !== value.trim() || value.length === 0) {
    throw new BusinessPushRequestError('INVALID_FIELD_VALUE', field);
  }
  if (codePointLength(value) > maxLength) {
    throw new BusinessPushRequestError('FIELD_TOO_LONG', field);
  }
  if (controlPattern.test(value)) {
    throw new BusinessPushRequestError('INVALID_CONTROL_CHARACTER', field);
  }
  return value;
}

function validateBusinessPushRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) {
    throw new BusinessPushRequestError('INVALID_REQUEST_BODY');
  }

  for (const field of Object.keys(input)) {
    if (!ALLOWED_FIELDS.has(field)) {
      throw new BusinessPushRequestError('UNKNOWN_FIELD', field);
    }
  }
  for (const field of ALLOWED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(input, field)) {
      throw new BusinessPushRequestError('MISSING_FIELD', field);
    }
  }

  const title = requireText(input, 'title', 80, TITLE_CONTROL_RE);
  const body = requireText(input, 'body', 2000, BODY_CONTROL_RE);
  const type = requireText(input, 'type', 64, TITLE_CONTROL_RE);
  const tag = requireText(input, 'tag', 128, TITLE_CONTROL_RE);
  const url = requireText(input, 'url', 64, TITLE_CONTROL_RE);
  const dedupeKey = requireText(input, 'dedupeKey', 256, TITLE_CONTROL_RE);

  if (!ALLOWED_TYPES.has(type)) {
    throw new BusinessPushRequestError('UNSUPPORTED_NOTIFICATION_TYPE', 'type');
  }
  if (!SAFE_TAG_RE.test(tag)) {
    throw new BusinessPushRequestError('INVALID_FIELD_VALUE', 'tag');
  }
  if (url !== '/manage') {
    throw new BusinessPushRequestError('UNSAFE_NOTIFICATION_URL', 'url');
  }
  if (!SAFE_DEDUPE_KEY_RE.test(dedupeKey)) {
    throw new BusinessPushRequestError('INVALID_FIELD_VALUE', 'dedupeKey');
  }

  return Object.freeze({ title, body, type, tag, url, dedupeKey });
}

function browserPayloadOf(request) {
  return Object.freeze({
    title: request.title,
    body: request.body,
    type: request.type,
    tag: request.tag,
    url: request.url,
  });
}

function normalizeDeliveryStats(value) {
  if (!value || typeof value !== 'object') return null;
  const names = [
    'subscriberCount', 'deliveryCount', 'failureCount', 'staleCount',
    'remainingSubscriberCount',
  ];
  const stats = {};
  for (const name of names) {
    if (!Number.isSafeInteger(value[name]) || value[name] < 0) return null;
    stats[name] = value[name];
  }
  if (stats.deliveryCount + stats.failureCount !== stats.subscriberCount) return null;
  if (stats.staleCount > stats.failureCount) return null;
  if (stats.remainingSubscriberCount > stats.subscriberCount) return null;
  return stats;
}

function publicStats(stats) {
  return {
    subscriber_count: stats.subscriberCount,
    delivery_count: stats.deliveryCount,
    failure_count: stats.failureCount,
    stale_count: stats.staleCount,
    remaining_subscriber_count: stats.remainingSubscriberCount,
  };
}

function errorResult(statusCode, error, stats = null, extra = {}) {
  const fallback = {
    subscriberCount: 0,
    deliveryCount: 0,
    failureCount: 0,
    staleCount: 0,
    remainingSubscriberCount: 0,
  };
  return {
    statusCode,
    body: {
      ok: false,
      delivered: false,
      deduped: false,
      ...publicStats(stats || fallback),
      error,
      ...extra,
    },
  };
}

function createBusinessPushService(options = {}) {
  if (typeof options.sendPushToAll !== 'function') {
    throw new TypeError('business push requires sendPushToAll');
  }
  const sendPushToAll = options.sendPushToAll;
  const receiptsFile = options.receiptsFile || '';
  const now = options.now || Date.now;
  const logger = options.logger || console;
  const writeJson = options.writeJson || atomicWriteJson;
  const ttlMs = options.ttlMs ?? DEFAULT_RECEIPT_TTL_MS;
  const maxReceipts = options.maxReceipts ?? DEFAULT_MAX_RECEIPTS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError('business push ttlMs must be positive');
  if (!Number.isSafeInteger(maxReceipts) || maxReceipts <= 0) {
    throw new TypeError('business push maxReceipts must be a positive integer');
  }

  const receipts = new Map();
  const inFlight = new Map();

  function warn(label, error) {
    const safe = sanitizePublicText(error && error.message, label);
    try { logger.warn(`[multicc/push] ${label}: ${safe}`); } catch (_) {}
  }

  function prune(timestamp = now()) {
    for (const [key, receipt] of receipts) {
      if (!Number.isFinite(receipt.deliveredAt)
          || receipt.deliveredAt > timestamp + 5 * 60 * 1000
          || timestamp - receipt.deliveredAt > ttlMs) {
        receipts.delete(key);
      }
    }
    if (receipts.size <= maxReceipts) return;
    const oldest = [...receipts.entries()]
      .sort((left, right) => left[1].deliveredAt - right[1].deliveredAt)
      .slice(0, receipts.size - maxReceipts);
    for (const [key] of oldest) receipts.delete(key);
  }

  function loadReceipts() {
    if (!receiptsFile || !fs.existsSync(receiptsFile)) return;
    try {
      const document = JSON.parse(fs.readFileSync(receiptsFile, 'utf8'));
      if (!document || document.version !== RECEIPT_VERSION
          || !document.receipts || typeof document.receipts !== 'object'
          || Array.isArray(document.receipts)) {
        throw new Error('invalid receipt document');
      }
      for (const [keyHash, value] of Object.entries(document.receipts)) {
        const stats = normalizeDeliveryStats(value && value.stats);
        if (!HASH_RE.test(keyHash) || !value || !HASH_RE.test(value.payloadHash || '')
            || !Number.isFinite(value.deliveredAt) || !stats
            || stats.subscriberCount === 0 || stats.failureCount !== 0
            || stats.deliveryCount !== stats.subscriberCount) continue;
        receipts.set(keyHash, {
          payloadHash: value.payloadHash,
          deliveredAt: value.deliveredAt,
          stats,
          persisted: true,
        });
      }
      prune();
    } catch (error) {
      warn('ignored invalid notification receipt store', error);
      receipts.clear();
    }
  }

  function persistReceipts() {
    if (!receiptsFile) return false;
    prune();
    const stored = {};
    for (const [keyHash, receipt] of receipts) {
      stored[keyHash] = {
        payloadHash: receipt.payloadHash,
        deliveredAt: receipt.deliveredAt,
        stats: receipt.stats,
      };
    }
    writeJson(receiptsFile, { version: RECEIPT_VERSION, receipts: stored });
    for (const receipt of receipts.values()) receipt.persisted = true;
    return true;
  }

  function duplicateResult(receipt) {
    let persisted = receipt.persisted === true;
    if (!persisted) {
      try { persisted = persistReceipts(); }
      catch (error) { warn('failed to persist notification receipt', error); }
    }
    return {
      statusCode: 200,
      body: {
        ok: true,
        delivered: true,
        deduped: true,
        dedupe_persisted: persisted,
        ...publicStats(receipt.stats),
      },
    };
  }

  async function deliver(request, keyHash, payloadHash) {
    let stats;
    try {
      stats = normalizeDeliveryStats(await sendPushToAll(browserPayloadOf(request)));
    } catch (error) {
      warn('business notification transport failed', error);
      return errorResult(502, 'PUSH_DELIVERY_ERROR');
    }
    if (!stats) return errorResult(502, 'INVALID_DELIVERY_RESULT');
    if (stats.subscriberCount === 0) {
      return errorResult(503, 'NO_PUSH_SUBSCRIBERS', stats);
    }
    if (stats.failureCount !== 0 || stats.deliveryCount !== stats.subscriberCount) {
      return errorResult(502, 'PUSH_DELIVERY_INCOMPLETE', stats, {
        partial: stats.deliveryCount > 0,
      });
    }

    const receipt = {
      payloadHash,
      deliveredAt: now(),
      stats,
      persisted: false,
    };
    receipts.set(keyHash, receipt);
    prune();
    let persisted = false;
    try { persisted = persistReceipts(); }
    catch (error) { warn('failed to persist notification receipt', error); }
    return {
      statusCode: 200,
      body: {
        ok: true,
        delivered: true,
        deduped: false,
        dedupe_persisted: persisted,
        ...publicStats(stats),
      },
    };
  }

  async function notify(input) {
    const request = validateBusinessPushRequest(input);
    prune();
    const payload = browserPayloadOf(request);
    const keyHash = sha256(request.dedupeKey);
    const payloadHash = sha256(JSON.stringify(payload));
    const receipt = receipts.get(keyHash);
    if (receipt) {
      if (receipt.payloadHash !== payloadHash) {
        throw new BusinessPushRequestError('IDEMPOTENCY_KEY_REUSE', 'dedupeKey');
      }
      return duplicateResult(receipt);
    }

    const pending = inFlight.get(keyHash);
    if (pending) {
      if (pending.payloadHash !== payloadHash) {
        throw new BusinessPushRequestError('IDEMPOTENCY_KEY_REUSE', 'dedupeKey');
      }
      const result = await pending.promise;
      if (!result.body.delivered) return { ...result, body: { ...result.body, deduped: true } };
      const completed = receipts.get(keyHash);
      return completed
        ? duplicateResult(completed)
        : { ...result, body: { ...result.body, deduped: true } };
    }

    const promise = deliver(request, keyHash, payloadHash);
    inFlight.set(keyHash, { payloadHash, promise });
    try { return await promise; }
    finally {
      if (inFlight.get(keyHash)?.promise === promise) inFlight.delete(keyHash);
    }
  }

  loadReceipts();
  return Object.freeze({ notify });
}

module.exports = {
  ALLOWED_FIELDS,
  ALLOWED_TYPES,
  BusinessPushRequestError,
  DEFAULT_MAX_RECEIPTS,
  DEFAULT_RECEIPT_TTL_MS,
  browserPayloadOf,
  createBusinessPushService,
  normalizeDeliveryStats,
  validateBusinessPushRequest,
};
