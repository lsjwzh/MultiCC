'use strict';

// ── Session sharing: scoped external access to a single chat session ──
//
// A share is a long random token that grants access to ONE session at one of
// two levels, completely separate from the global ACCESS_TOKEN:
//   • view    — read-only (see messages). Optionally password-gated; with no
//               password it is a fully public link.
//   • operate — read-write (send messages / drive the conversation). Password
//               REQUIRED (operate = running code on the host via the session).
//
// Security model: a share token is only ever honored for its own session and
// its own access level. It cannot reach /manage, other sessions, the filesystem
// at large, or any admin endpoint — the server gates every share route on
// share.access() and never falls back to ACCESS_TOKEN for them.
//
// Passwords are salted+scrypt hashed. A correct password mints a per-share auth
// cookie (an opaque value derived from the share's own secret) so the recipient
// isn't re-prompted every request; the cookie proves nothing about any other
// share or about ACCESS_TOKEN.

const fs = require('fs');
const crypto = require('crypto');
const { createPaths } = require('./paths');
const { atomicWriteJson } = require('./runtime-security');
const { timingSafeEqualText } = require('./auth-security');

const FILE = createPaths({ dataDir: process.env.MULTICC_DATA_DIR }).sharesFile;
const MAX_SHARE_PASSWORD_BYTES = 4096;
let shares = {}; // token -> record

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    shares = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    shares = {};
  }
}

// Commit to disk before publishing the new in-memory snapshot. Admin create
// and revoke routes must never report success for a share that disappears on
// restart. Callers that intentionally use best-effort cleanup catch this error
// explicitly at their own lifecycle boundary.
function save(next) {
  atomicWriteJson(FILE, next);
  shares = next;
}

function logPersistenceFailure(operation, error) {
  const code = error && typeof error.code === 'string' ? error.code : 'UNKNOWN';
  console.error('[share] persistence failed', { operation, code });
}
load();

function normalizePassword(password) {
  if (password == null || password === '') return null;
  const value = String(password);
  if (Buffer.byteLength(value, 'utf8') > MAX_SHARE_PASSWORD_BYTES) {
    throw new Error('share password is too long');
  }
  return value;
}

function normalizeExpiresAt(expiresAt) {
  if (expiresAt == null || expiresAt === '') return null;
  const value = Number(expiresAt);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('invalid share expiry');
  }
  return value;
}

function hashPw(pw, salt) { return crypto.scryptSync(pw, salt, 32).toString('hex'); }

function publicRec(r) {
  return {
    token: r.token, sessionId: r.sessionId, access: r.access,
    type: r.type || 'session',
    messageCount: r.type === 'messages' ? (r.messages ? r.messages.length : 0) : undefined,
    hasPassword: !!r.pwHash, expiresAt: r.expiresAt || null,
    createdAt: r.createdAt, label: r.label || null,
  };
}

function isExpired(r) { return !!(r && r.expiresAt && Date.now() > r.expiresAt); }

// Create a share. access: 'view'|'operate'. operate requires a password.
function create(sessionId, { access, password, expiresAt, label } = {}) {
  const lvl = access === 'operate' ? 'operate' : 'view';
  const safePassword = normalizePassword(password);
  if (lvl === 'operate' && !safePassword) {
    throw new Error('operate share requires a password');
  }
  const token = crypto.randomBytes(18).toString('base64url');
  const rec = {
    token, sessionId, access: lvl,
    createdAt: Date.now(),
    expiresAt: normalizeExpiresAt(expiresAt),
    label: label || null,
    salt: null, pwHash: null, secret: crypto.randomBytes(16).toString('hex'),
  };
  if (safePassword) {
    rec.salt = crypto.randomBytes(16).toString('hex');
    rec.pwHash = hashPw(safePassword, rec.salt);
  }
  save({ ...shares, [token]: rec });
  return publicRec(rec);
}

// Create a read-only snapshot share of selected messages. The messages are
// COPIED at share time, so the link is stable even if the session later changes
// or is deleted, and it never exposes the live session. access is always 'view'.
function createMessageShare(sessionId, messages, { password, expiresAt, label } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) throw new Error('no messages to share');
  const safePassword = normalizePassword(password);
  const token = crypto.randomBytes(18).toString('base64url');
  const rec = {
    token, sessionId, access: 'view', type: 'messages',
    messages: messages.map(m => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: typeof m.content === 'string' ? m.content : '',
      tools: Array.isArray(m.tools) ? m.tools.map(t => ({ name: t.name, input: t.input })) : undefined,
      ts: m.ts || null,
    })),
    createdAt: Date.now(), expiresAt: normalizeExpiresAt(expiresAt),
    label: label || null, salt: null, pwHash: null, secret: crypto.randomBytes(16).toString('hex'),
  };
  if (safePassword) {
    rec.salt = crypto.randomBytes(16).toString('hex');
    rec.pwHash = hashPw(safePassword, rec.salt);
  }
  save({ ...shares, [token]: rec });
  return publicRec(rec);
}

function get(token) {
  const r = shares[token];
  if (!r) return null;
  if (isExpired(r)) {
    const next = { ...shares };
    delete next[token];
    try { save(next); }
    catch (error) { logPersistenceFailure('expire', error); }
    return null;
  }
  return r;
}

function listForSession(sessionId) {
  return Object.values(shares).filter(r => r.sessionId === sessionId && !isExpired(r)).map(publicRec);
}

function remove(token) {
  if (!shares[token]) return false;
  const next = { ...shares };
  delete next[token];
  save(next);
  return true;
}

// Drop a session's LIVE shares when the session is deleted. Message snapshots
// are independent copies (their content lives in the share record), so they
// survive — the shared excerpt link keeps working after the session is gone.
function removeForSession(sessionId) {
  const next = { ...shares };
  let n = 0;
  for (const token of Object.keys(next)) {
    const record = next[token];
    if (record.sessionId === sessionId && (record.type || 'session') !== 'messages') {
      delete next[token];
      n++;
    }
  }
  if (!n) return 0;
  try {
    save(next);
    return n;
  } catch (error) {
    // Session deletion has already torn down external resources by this point.
    // Keep cleanup best-effort so a share-file IO failure cannot leave a ghost
    // session record whose worktree is gone. Live reads still fail closed once
    // the owning session disappears from persistedSessions.
    logPersistenceFailure('remove-for-session', error);
    return 0;
  }
}

function verifyPassword(token, pw) {
  const r = get(token);
  if (!r) return false;
  if (!r.pwHash) return true; // public
  let safePassword;
  try { safePassword = normalizePassword(pw); }
  catch (_) { return false; }
  if (!safePassword) return false;
  const a = Buffer.from(hashPw(safePassword, r.salt));
  const b = Buffer.from(r.pwHash, 'hex').length === 32 ? Buffer.from(r.pwHash) : Buffer.from(r.pwHash);
  try { return a.length === b.length && crypto.timingSafeEqual(a, b); } catch { return false; }
}

// Opaque cookie value minted after a correct password — derived from the
// share's own secret so it is unforgeable and useless for any other share.
function authCookieValue(r) {
  return crypto.createHmac('sha256', r.secret).update(r.token).digest('hex');
}

// Does this request carry valid access to `token`? Returns null or {access}.
// cookies: parsed cookie map. provided: a password supplied inline (optional).
function access(token, { cookies = {}, password } = {}) {
  const r = get(token);
  if (!r) return null;
  if (!r.pwHash) return { access: r.access, sessionId: r.sessionId }; // public link
  // Password-gated: accept a valid auth cookie or a correct inline password.
  const cookieName = `multicc_share_${token}`;
  if (cookies[cookieName] && timingSafeEqualText(cookies[cookieName], authCookieValue(r))) return { access: r.access, sessionId: r.sessionId };
  if (password && verifyPassword(token, password)) return { access: r.access, sessionId: r.sessionId };
  return null;
}

module.exports = {
  MAX_SHARE_PASSWORD_BYTES,
  create, createMessageShare, get, publicRec, listForSession, remove, removeForSession,
  verifyPassword, authCookieValue, access,
  normalizeExpiresAt, normalizePassword,
  cookieName: (token) => `multicc_share_${token}`,
};
