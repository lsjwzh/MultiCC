'use strict';

// Durable, provider-scoped credentials for cross-instance Provider relays.
// Verification uses only a salted scrypt hash plus a short fingerprint. So the
// owner can copy an existing share code again, each new record also keeps the
// credential sealed with AES-256-GCM under a 0600 key file next to the store;
// the plaintext never reaches disk and list() never returns it.
//
// Rust-first exception (AGENTS.md): this store, its authorize path and the
// routes are Node-only today with no Rust counterpart, so this stays a minimal
// addition to the existing module. Migrate it with the rest of the relay-share
// store when the provider routes move to Rust.

const crypto = require('node:crypto');
const fs = require('node:fs');
const { createStore } = require('../state/store');
const { atomicWriteText } = require('../runtime-security');

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

// 借道链接识别（导入方视角）：baseUrl 指向另一台 multicc 的中转端点
// （…/claude-proxy/<id>/remote 或 …/codex-proxy/<id>）时，本机没有上游厂商
// 凭据可查余量，余量查询应转发给出借方（见 usage-limit-poller 的
// pollRelayQuota 与 provider-balance 的 relay quota 路由）。
//
// loopback host 一律不算借道：本机自己的 CPR 管线同样挂在
// 127.0.0.1:<port>/codex-proxy/<id>（见 core.js buildSettingsConfig），那不是
// 远端中转端点，绝不能被改写成余量转发。返回的 url 是规范化后的中转端点
// 本身（截掉多余子路径/尾斜杠），余量查询地址 = `${url}/quota`。
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function relayRouteFromBaseUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(clean(rawUrl));
  } catch (_) {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (LOOPBACK_HOSTNAMES.has(parsed.hostname.toLowerCase())) return null;
  let segments;
  try {
    segments = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch (_) {
    return null;
  }
  if (segments[0] === 'claude-proxy' && segments[1] && segments[2] === 'remote') {
    return {
      appType: 'claude',
      providerId: segments[1],
      url: `${parsed.origin}/claude-proxy/${encodeURIComponent(segments[1])}/remote`,
    };
  }
  if (segments[0] === 'codex-proxy' && segments[1]) {
    return {
      appType: 'codex',
      providerId: segments[1],
      url: `${parsed.origin}/codex-proxy/${encodeURIComponent(segments[1])}`,
    };
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
    // True when the credential can be copied again (sealed at creation time).
    recoverable: !record.revokedAt && !!record.credentialSealed,
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

  const keyFile = options.keyFile || `${options.file}.key`;
  let sealKey = null;
  // Lazily load (or create) the sealing key. Any failure returns null so a
  // share can still be created and used; it just cannot be copied again.
  function loadSealKey(create) {
    if (sealKey) return sealKey;
    try {
      const hex = fs.readFileSync(keyFile, 'utf8').trim();
      if (/^[0-9a-f]{64}$/.test(hex)) return (sealKey = Buffer.from(hex, 'hex'));
    } catch (_) { /* missing key file */ }
    if (!create) return null;
    try {
      const fresh = randomBytes(32);
      atomicWriteText(keyFile, fresh.toString('hex'));
      return (sealKey = fresh);
    } catch (_) { return null; }
  }

  function seal(credential, id) {
    const key = loadSealKey(true);
    if (!key) return null;
    const iv = randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(id));
    const data = Buffer.concat([cipher.update(credential, 'utf8'), cipher.final()]);
    return { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
  }

  function unseal(sealed, id) {
    const key = loadSealKey(false);
    if (!key || !sealed || sealed.v !== 1) return null;
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
      decipher.setAAD(Buffer.from(id));
      decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]).toString('utf8');
    } catch (_) { return null; }
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
      credentialSealed: seal(credential, id),
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

  // Re-disclose an active share's credential to the owner. The unsealed value
  // is re-verified against the stored scrypt hash, so a tampered or mismatched
  // record is refused instead of handing out a credential that cannot work.
  function getCredential(id) {
    const record = records.find(item => item.id === clean(id));
    if (!record) return Object.freeze({ ok: false, code: 'not_found' });
    if (record.revokedAt) return Object.freeze({ ok: false, code: 'revoked' });
    const credential = unseal(record.credentialSealed, record.id);
    const parsed = credential ? parseCredential(credential) : null;
    if (!parsed || parsed.id !== record.id) return Object.freeze({ ok: false, code: 'not_recoverable' });
    const actual = crypto.scryptSync(parsed.secret, record.tokenSalt, 32);
    const expected = Buffer.from(record.tokenHash, 'hex');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      return Object.freeze({ ok: false, code: 'not_recoverable' });
    }
    return Object.freeze({ ok: true, credential, share: publicRecord(record) });
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

  return Object.freeze({ create, list, getCredential, authorize, revoke, revokeProvider });
}

module.exports = {
  MAX_SECRET_LENGTH,
  MIN_SECRET_LENGTH,
  TOKEN_PREFIX,
  createProviderRelayShareStore,
  parseCredential,
  relayRouteFromBaseUrl,
  routeTarget,
};
