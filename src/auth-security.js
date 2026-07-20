'use strict';

const crypto = require('crypto');

const COOKIE_VERSION = 1;
const DEFAULT_COOKIE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_TICKET_TTL_MS = 30 * 1000;

function timingSafeEqualText(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function normalizeRedirect(value, fallback = '/') {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return fallback;
  if (/[\\\r\n\0]/.test(value)) return fallback;
  try {
    const parsed = new URL(value, 'http://multicc.local');
    if (parsed.origin !== 'http://multicc.local') return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}` || fallback;
  } catch (_) {
    return fallback;
  }
}

function escapeHtmlAttribute(value) {
  return String(value).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function normalizeWsPath(value) {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value, 'http://multicc.local');
    if (parsed.origin !== 'http://multicc.local') return null;
    return parsed.pathname || '/';
  } catch (_) {
    return null;
  }
}

function normalizeDownloadTarget(value) {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value, 'http://multicc.local');
    if (parsed.origin !== 'http://multicc.local' || parsed.pathname !== '/api/download') return null;
    const allowed = new Set(['path', 'inline', 'download_ticket']);
    for (const key of parsed.searchParams.keys()) {
      if (!allowed.has(key)) return null;
    }
    const paths = parsed.searchParams.getAll('path');
    const inlineValues = parsed.searchParams.getAll('inline');
    if (paths.length !== 1 || !paths[0] || paths[0].includes('\0') || inlineValues.length > 1) return null;
    if (inlineValues.length === 1 && inlineValues[0] !== '1') return null;
    const query = new URLSearchParams({ path: paths[0] });
    if (inlineValues[0] === '1') query.set('inline', '1');
    return `/api/download?${query.toString()}`;
  } catch (_) {
    return null;
  }
}

function createAuthSecurity({
  getSecret,
  now = () => Date.now(),
  randomBytes = crypto.randomBytes,
  cookieTtlMs = DEFAULT_COOKIE_TTL_MS,
  ticketTtlMs = DEFAULT_TICKET_TTL_MS,
  maxTickets = 2048,
} = {}) {
  if (typeof getSecret !== 'function') throw new TypeError('createAuthSecurity requires getSecret()');
  const tickets = new Map();
  const downloadTickets = new Map();

  function secret() {
    const value = getSecret();
    return typeof value === 'string' ? value : '';
  }

  function sign(payload) {
    const key = secret();
    if (!key) return '';
    return crypto.createHmac('sha256', key).update(payload).digest('base64url');
  }

  function createCookie() {
    const issuedAt = now();
    const iat = Math.floor(issuedAt / 1000);
    const exp = Math.floor((issuedAt + cookieTtlMs) / 1000);
    const body = Buffer.from(JSON.stringify({ v: COOKIE_VERSION, iat, exp, n: randomBytes(8).toString('base64url') })).toString('base64url');
    return `${body}.${sign(body)}`;
  }

  function verifyCookie(cookie) {
    if (!secret() || typeof cookie !== 'string') return false;
    const parts = cookie.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
    const expected = sign(parts[0]);
    if (!timingSafeEqualText(parts[1], expected)) return false;
    let claims;
    try { claims = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); }
    catch (_) { return false; }
    const current = Math.floor(now() / 1000);
    if (!claims || claims.v !== COOKIE_VERSION || !Number.isInteger(claims.iat) || !Number.isInteger(claims.exp)) return false;
    if (claims.iat > current + 60 || claims.exp <= current || claims.exp <= claims.iat) return false;
    if ((claims.exp - claims.iat) * 1000 > cookieTtlMs + 1000) return false;
    return true;
  }

  function verifyAccessToken(candidate) {
    const key = secret();
    return !!key && timingSafeEqualText(candidate, key);
  }

  function pruneTickets() {
    const current = now();
    for (const [hash, record] of tickets) {
      if (record.expiresAt <= current) tickets.delete(hash);
    }
    for (const [hash, record] of downloadTickets) {
      if (record.expiresAt <= current) downloadTickets.delete(hash);
    }
    while (tickets.size + downloadTickets.size >= maxTickets) {
      const wsKey = tickets.keys().next().value;
      if (wsKey !== undefined) tickets.delete(wsKey);
      else downloadTickets.delete(downloadTickets.keys().next().value);
    }
  }

  function issueWsTicket(pathname, metadata = {}) {
    const scope = normalizeWsPath(pathname);
    if (!scope) throw new TypeError('invalid WebSocket ticket path');
    pruneTickets();
    const ticket = randomBytes(24).toString('base64url');
    const hash = crypto.createHash('sha256').update(ticket).digest('base64url');
    const expiresAt = now() + ticketTtlMs;
    tickets.set(hash, { path: scope, expiresAt, metadata: { ...metadata } });
    return { ticket, expiresAt, path: scope };
  }

  function consumeWsTicket(ticket, pathname) {
    if (typeof ticket !== 'string' || !ticket) return null;
    const scope = normalizeWsPath(pathname);
    if (!scope) return null;
    const hash = crypto.createHash('sha256').update(ticket).digest('base64url');
    const record = tickets.get(hash);
    if (!record) return null;
    tickets.delete(hash); // one attempt consumes it, including a wrong-scope attempt
    if (record.expiresAt <= now() || record.path !== scope) return null;
    return { ...record.metadata, path: record.path, expiresAt: record.expiresAt };
  }

  function issueDownloadTicket(target, metadata = {}) {
    const scope = normalizeDownloadTarget(target);
    if (!scope) throw new TypeError('invalid download ticket target');
    pruneTickets();
    const ticket = randomBytes(24).toString('base64url');
    const hash = crypto.createHash('sha256').update(ticket).digest('base64url');
    const expiresAt = now() + ticketTtlMs;
    downloadTickets.set(hash, { target: scope, expiresAt, metadata: { ...metadata } });
    return { ticket, expiresAt, target: scope };
  }

  // Download clients may make a small number of range/retry requests while
  // opening a file. Keep the opaque capability reusable only for its short TTL;
  // unlike the WebSocket ticket it is narrowly bound to one canonical target.
  function verifyDownloadTicket(ticket, target) {
    if (typeof ticket !== 'string' || !ticket) return false;
    const scope = normalizeDownloadTarget(target);
    if (!scope) return false;
    const hash = crypto.createHash('sha256').update(ticket).digest('base64url');
    const record = downloadTickets.get(hash);
    if (!record) return false;
    if (record.expiresAt <= now()) {
      downloadTickets.delete(hash);
      return false;
    }
    return record.target === scope;
  }

  return {
    createCookie,
    verifyCookie,
    verifyAccessToken,
    issueWsTicket,
    consumeWsTicket,
    issueDownloadTicket,
    verifyDownloadTicket,
    pruneTickets,
    ticketCount: () => tickets.size + downloadTickets.size,
  };
}

module.exports = {
  COOKIE_VERSION,
  DEFAULT_COOKIE_TTL_MS,
  DEFAULT_TICKET_TTL_MS,
  createAuthSecurity,
  timingSafeEqualText,
  normalizeRedirect,
  escapeHtmlAttribute,
  normalizeWsPath,
  normalizeDownloadTarget,
};
