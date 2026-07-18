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
let shares = {}; // token -> record

function load() { try { shares = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { shares = {}; } }
function save() { try { atomicWriteJson(FILE, shares); } catch (e) { console.error('[share] save failed:', e.message); } }
load();

function hashPw(pw, salt) { return crypto.scryptSync(String(pw), salt, 32).toString('hex'); }

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
  if (lvl === 'operate' && !password) {
    throw new Error('operate share requires a password');
  }
  const token = crypto.randomBytes(18).toString('base64url');
  const rec = {
    token, sessionId, access: lvl,
    createdAt: Date.now(),
    expiresAt: expiresAt ? Number(expiresAt) : null,
    label: label || null,
    salt: null, pwHash: null, secret: crypto.randomBytes(16).toString('hex'),
  };
  if (password) { rec.salt = crypto.randomBytes(16).toString('hex'); rec.pwHash = hashPw(password, rec.salt); }
  shares[token] = rec;
  save();
  return publicRec(rec);
}

// Create a read-only snapshot share of selected messages. The messages are
// COPIED at share time, so the link is stable even if the session later changes
// or is deleted, and it never exposes the live session. access is always 'view'.
function createMessageShare(sessionId, messages, { password, expiresAt, label } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) throw new Error('no messages to share');
  const token = crypto.randomBytes(18).toString('base64url');
  const rec = {
    token, sessionId, access: 'view', type: 'messages',
    messages: messages.map(m => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: typeof m.content === 'string' ? m.content : '',
      tools: Array.isArray(m.tools) ? m.tools.map(t => ({ name: t.name, input: t.input })) : undefined,
      ts: m.ts || null,
    })),
    createdAt: Date.now(), expiresAt: expiresAt ? Number(expiresAt) : null,
    label: label || null, salt: null, pwHash: null, secret: crypto.randomBytes(16).toString('hex'),
  };
  if (password) { rec.salt = crypto.randomBytes(16).toString('hex'); rec.pwHash = hashPw(password, rec.salt); }
  shares[token] = rec;
  save();
  return publicRec(rec);
}

function get(token) {
  const r = shares[token];
  if (!r) return null;
  if (isExpired(r)) { delete shares[token]; save(); return null; }
  return r;
}

function listForSession(sessionId) {
  return Object.values(shares).filter(r => r.sessionId === sessionId && !isExpired(r)).map(publicRec);
}

function remove(token) { const had = !!shares[token]; if (had) { delete shares[token]; save(); } return had; }

// Drop a session's LIVE shares when the session is deleted. Message snapshots
// are independent copies (their content lives in the share record), so they
// survive — the shared excerpt link keeps working after the session is gone.
function removeForSession(sessionId) {
  let n = 0;
  for (const t of Object.keys(shares)) {
    if (shares[t].sessionId === sessionId && (shares[t].type || 'session') !== 'messages') { delete shares[t]; n++; }
  }
  if (n) save();
  return n;
}

function verifyPassword(token, pw) {
  const r = get(token);
  if (!r) return false;
  if (!r.pwHash) return true; // public
  if (!pw) return false;
  const a = Buffer.from(hashPw(pw, r.salt));
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
  create, createMessageShare, get, publicRec, listForSession, remove, removeForSession,
  verifyPassword, authCookieValue, access,
  cookieName: (token) => `multicc_share_${token}`,
};
