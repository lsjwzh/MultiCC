'use strict';

// Durable, provider-scoped credentials for cross-instance Provider relays.
// A relay credential is disclosed once inside the share code; disk keeps only
// a salted scrypt hash plus a short fingerprint for administrative inventory.

const crypto = require('node:crypto');
const { createStore } = require('./state-store');

const APP_TYPES = new Set(['claude', 'codex']);
const TOKEN_PREFIX = 'mcr1';
const MIN_SECRET_LENGTH = 8;
const MAX_SECRET_LENGTH = 128;

function clean(value) {
  return value == null ? '' : String(value).trim();
}

function failure(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeSecret(value) {
  const secret = clean(value);
  if (secret.length < MIN_SECRET_LENGTH || secret.length > MAX_SECRET_LENGTH
      || !/^[\x21-\x7e]+$/.test(secret)) {
    throw failure(
      `relay token must be ${MIN_SECRET_LENGTH}-${MAX_SECRET_LENGTH} printable ASCII characters without spaces`,
      'RELAY_TOKEN_INVALID',
    );
  }
  return secret;
}

function normalizeLabel(value) {
  const label = clean(value);
  if (label.length > 100 || /[\u0000-\u001f\u007f]/.test(label)) {
    throw failure('relay share label is invalid', 'RELAY_LABEL_INVALID');
  }
  return label || null;
}

function parseCredential(value) {
  const raw = clean(value);
  if (!raw.startsWith(`${TOKEN_PREFIX}.`)) return null;
  const first = raw.indexOf('.');
  const second = raw.indexOf('.', first + 1);
  if (second < 0) return null;
  const id = raw.slice(first + 1, second);
  const secret = raw.slice(second + 1);
  if (!/^[A-Za-z0-9_-]{16}$/.test(id)) return null;
  try { return { id, secret: normalizeSecret(secret) }; }
  catch (_) { return null; }
}

function routeTarget(pathname) {
  let segments;
  try {
    segments = new URL(clean(pathname), 'http://multicc.local').pathname
      .split('/').filter(Boolean).map(decodeURIComponent);
  } catch (_) {
    return null;
  }
  if (segments[0] === 'claude-proxy' && segments[1] && segments[2] === 'remote') {
    return { appType: 'claude', providerId: segments[1] };
  }
  if (segments[0] === 'codex-proxy' && segments[1]) {
    return { appType: 'codex', providerId: segments[1] };
  }
  return null;
}

function publicRecord(record) {
  return Object.freeze({
    id: record.id,
    appType: record.appType,
    providerId: record.providerId,
    providerName: record.providerName,
    label: record.label,
    publicBaseUrl: record.publicBaseUrl,
    relayBaseUrl: record.relayBaseUrl,
    tokenFingerprint: record.tokenFingerprint,
    status: record.revokedAt ? 'revoked' : 'active',
    createdAt: record.createdAt,
    revokedAt: record.revokedAt,
    accessCount: record.accessCount,
    lastUsedAt: record.lastUsedAt,
  });
}

function createProviderRelayShareStore(options = {}) {
  if (!options.file) throw new TypeError('provider relay share store requires { file }');
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const randomBytes = typeof options.randomBytes === 'function' ? options.randomBytes : crypto.randomBytes;
  const store = options.store || createStore({
    file: options.file,
    kind: 'provider-relay-shares',
    schemaVersion: 1,
    legacyIsArray: true,
  });
  const loaded = store.loadOrRecover();
  let records = loaded.present ? loaded.data : [];
  if (!Array.isArray(records)) throw new Error('provider relay share store data must be an array');
  records = records.map(record => ({ ...record }));

  function commit(next) {
    store.save(next);
    records = next;
  }

  function uniqueId() {
    for (let attempt = 0; attempt < 10; attempt++) {
      const id = randomBytes(12).toString('base64url');
      if (/^[A-Za-z0-9_-]{16}$/.test(id) && !records.some(record => record.id === id)) return id;
    }
    throw new Error('failed to allocate relay share id');
  }

  function create(input = {}) {
    const appType = clean(input.appType);
    const providerId = clean(input.providerId);
    const providerName = clean(input.providerName) || providerId;
    const publicBaseUrl = clean(input.publicBaseUrl);
    const relayBaseUrl = clean(input.relayBaseUrl);
    const secret = normalizeSecret(input.token);
    if (!APP_TYPES.has(appType)) throw new Error('relay share appType is invalid');
    if (!providerId || providerId.length > 256) throw new Error('relay share provider is invalid');
    if (!publicBaseUrl || !relayBaseUrl) throw new Error('relay share URL is invalid');
    const id = uniqueId();
    const salt = randomBytes(16).toString('hex');
    const credential = `${TOKEN_PREFIX}.${id}.${secret}`;
    const record = {
      id,
      appType,
      providerId,
      providerName,
      label: normalizeLabel(input.label),
      publicBaseUrl,
      relayBaseUrl,
      tokenSalt: salt,
      tokenHash: crypto.scryptSync(secret, salt, 32).toString('hex'),
      tokenFingerprint: crypto.createHash('sha256').update(credential).digest('hex').slice(0, 12),
      createdAt: Number(now()),
      revokedAt: null,
      accessCount: 0,
      lastUsedAt: null,
    };
    commit([...records, record]);
    return Object.freeze({ credential, share: publicRecord(record) });
  }

  function list(filter = {}) {
    const appType = clean(filter.appType);
    const providerId = clean(filter.providerId);
    return records
      .filter(record => (!appType || record.appType === appType)
        && (!providerId || record.providerId === providerId))
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(publicRecord);
  }

  function authorize(input = {}) {
    const parsed = parseCredential(input.credential);
    const target = routeTarget(input.pathname);
    if (!parsed || !target) return Object.freeze({ ok: false, code: 'invalid_relay_credential' });
    const index = records.findIndex(record => record.id === parsed.id);
    const record = index >= 0 ? records[index] : null;
    if (!record || record.revokedAt) return Object.freeze({ ok: false, code: 'relay_share_inactive' });
    if (record.appType !== target.appType || record.providerId !== target.providerId) {
      return Object.freeze({ ok: false, code: 'relay_share_scope_mismatch' });
    }
    const actual = crypto.scryptSync(parsed.secret, record.tokenSalt, 32);
    const expected = Buffer.from(record.tokenHash, 'hex');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      return Object.freeze({ ok: false, code: 'invalid_relay_credential' });
    }
    const usedAt = Number(now());
    const updated = {
      ...record,
      accessCount: Math.max(0, Number(record.accessCount) || 0) + 1,
      lastUsedAt: usedAt,
    };
    const next = records.slice();
    next[index] = updated;
    commit(next);
    return Object.freeze({ ok: true, code: null, shareId: record.id });
  }

  function revoke(id) {
    const target = clean(id);
    const index = records.findIndex(record => record.id === target);
    if (index < 0) return null;
    if (records[index].revokedAt) return publicRecord(records[index]);
    const next = records.slice();
    next[index] = { ...records[index], revokedAt: Number(now()) };
    commit(next);
    return publicRecord(next[index]);
  }

  function revokeProvider(appType, providerId) {
    const type = clean(appType);
    const id = clean(providerId);
    const revokedAt = Number(now());
    let count = 0;
    const next = records.map(record => {
      if (record.appType !== type || record.providerId !== id || record.revokedAt) return record;
      count += 1;
      return { ...record, revokedAt };
    });
    if (count) commit(next);
    return count;
  }

  return Object.freeze({ create, list, authorize, revoke, revokeProvider });
}

module.exports = {
  MAX_SECRET_LENGTH,
  MIN_SECRET_LENGTH,
  TOKEN_PREFIX,
  createProviderRelayShareStore,
  parseCredential,
  routeTarget,
};
