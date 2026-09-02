'use strict';

// Cross-instance Fleet sharing. A source instance issues a password-protected,
// bounded capability for one Fleet. A target instance stores a remote reference
// and a sanitized cache, then proxies Fleet-scoped operations back to the source.
// Imported Fleets deliberately do not enter directories.json: they have no local
// repository on the target and must never be mistaken for local worktrees.

const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const fs = require('node:fs');
const { atomicWriteJson } = require('./runtime-security');

const SCHEMA_VERSION = 1;
const TOKEN_RE = /^fleet_share_[A-Za-z0-9_-]{24,96}$/;
const MAX_PASSWORD_BYTES = 1024;
const MAX_REMOTE_BODY_BYTES = 1024 * 1024;
const MAX_PROXY_BODY_BYTES = 10 * 1024 * 1024;
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const GRANT_RE = /^[A-Za-z0-9_-]{43,128}$/;

class FleetSharingError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'FleetSharingError';
    this.code = code;
    this.status = status;
  }
}

function fail(code, message, status) {
  throw new FleetSharingError(code, message, status);
}

function cleanText(value, max, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : fallback;
}

function normalizePassword(value) {
  const password = typeof value === 'string' ? value : '';
  const bytes = Buffer.byteLength(password, 'utf8');
  if (bytes < 6) fail('INVALID_PASSWORD', '密码必须至少 6 位');
  if (bytes > MAX_PASSWORD_BYTES) fail('INVALID_PASSWORD', '密码过长');
  return password;
}

function passwordHash(password, salt) {
  return crypto.scryptSync(password, salt, 32).toString('hex');
}

function passwordMatches(password, record) {
  let candidate;
  try {
    candidate = Buffer.from(passwordHash(password, record.salt), 'hex');
  } catch (_) {
    return false;
  }
  const expected = Buffer.from(String(record.passwordHash || ''), 'hex');
  return candidate.length === 32 && expected.length === 32
    && crypto.timingSafeEqual(candidate, expected);
}

function secretMatches(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string' || !candidate || !expected) return false;
  const left = crypto.createHash('sha256').update(candidate).digest();
  const right = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(left, right);
}

function positiveInteger(value, { min, max, fallback, label }) {
  const number = value == null || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    fail('INVALID_SHARE_OPTIONS', `${label}必须是 ${min}-${max} 的整数`);
  }
  return number;
}

function loadObject(file, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch (_) { /* first boot / invalid legacy file: start from a safe empty state */ }
  return fallback;
}

function publicShare(record, now = Date.now()) {
  return {
    token: record.token,
    fleetId: record.fleetId,
    description: record.description || '',
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    maxAccesses: record.maxAccesses,
    accessCount: record.accessCount || 0,
    remainingAccesses: Math.max(0, record.maxAccesses - (record.accessCount || 0)),
    expired: now > record.expiresAt,
  };
}

function publicExternal(record) {
  return {
    id: record.id,
    name: record.alias || record.remoteName,
    alias: record.alias || '',
    remoteName: record.remoteName,
    description: record.description || '',
    sourceOrigin: record.sourceOrigin,
    shareUrl: record.shareUrl,
    sourceInstanceId: record.sourceInstanceId,
    sourceFleetId: record.sourceFleetId,
    sessions: (Array.isArray(record.sessions) ? record.sessions : []).map(session => ({ ...session })),
    sessionCount: Number.isInteger(record.sessionCount) ? record.sessionCount : 0,
    interactive: GRANT_RE.test(record.remoteGrant || '') && TOKEN_RE.test(record.remoteToken || ''),
    importedAt: record.importedAt,
    refreshedAt: record.refreshedAt,
  };
}

function normalizeShareUrl(value) {
  let url;
  try { url = new URL(String(value || '').trim()); }
  catch (_) { fail('INVALID_SHARE_URL', '分享链接无效'); }
  if (!['http:', 'https:'].includes(url.protocol)) {
    fail('INVALID_SHARE_URL', '分享链接只支持 HTTP 或 HTTPS');
  }
  if (url.username || url.password) fail('INVALID_SHARE_URL', '分享链接不能包含登录凭据');
  const pageMatch = /^\/fleet-share\/(fleet_share_[A-Za-z0-9_-]+)\/?$/.exec(url.pathname);
  const apiMatch = /^\/api\/fleet-shares\/(fleet_share_[A-Za-z0-9_-]+)\/import\/?$/.exec(url.pathname);
  const token = (pageMatch || apiMatch || [])[1];
  if (!TOKEN_RE.test(token || '')) fail('INVALID_SHARE_URL', '分享链接格式无效');
  url.pathname = `/api/fleet-shares/${token}/import`;
  url.search = '';
  url.hash = '';
  return { token, apiUrl: url.toString(), origin: url.origin, hostname: url.hostname };
}

function blockedAddress(address) {
  const value = String(address || '').toLowerCase();
  if (!value) return true;
  if (value.includes(':')) {
    if (value === '::' || value.startsWith('fe8') || value.startsWith('fe9')
      || value.startsWith('fea') || value.startsWith('feb') || value.startsWith('ff')) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
    return mapped ? blockedAddress(mapped[1]) : false;
  }
  const parts = value.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  return parts[0] === 0 || (parts[0] === 169 && parts[1] === 254) || parts[0] >= 224;
}

async function assertSafeRemoteTarget(hostname, lookupHost) {
  const normalized = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (['metadata.google.internal', 'metadata.google', 'instance-data'].includes(normalized)) {
    fail('UNSAFE_SHARE_URL', '该分享地址不允许访问', 400);
  }
  let addresses;
  try { addresses = await lookupHost(normalized, { all: true, verbatim: true }); }
  catch (_) { fail('REMOTE_UNAVAILABLE', '无法解析分享地址', 502); }
  if (!Array.isArray(addresses) || !addresses.length || addresses.some(item => blockedAddress(item.address))) {
    fail('UNSAFE_SHARE_URL', '该分享地址不允许访问', 400);
  }
}

function normalizeRemoteSessions(value) {
  const sourceSessions = Array.isArray(value) ? value.slice(0, 500) : [];
  return sourceSessions.map(session => ({
    id: cleanText(session && session.id, 180),
    label: cleanText(session && session.label, 120, '未命名会话'),
    cli: ['claude', 'codex', 'opencode', 'zcode', 'qoder', 'kimi', 'codebuddy', 'dsh'].includes(session && session.cli)
      ? session.cli : 'other',
    kind: session && session.kind === 'terminal' ? 'terminal' : 'chat',
    type: session && session.type === 'commander' ? 'commander' : 'worker',
    createdAt: cleanText(session && session.createdAt, 64) || null,
    active: session && session.active === true,
    model: cleanText(session && session.model, 120) || null,
    effectiveModel: cleanText(session && session.effectiveModel, 120) || null,
    provider: cleanText(session && session.provider, 180) || null,
  })).filter(session => session.id);
}

function validateFleetPayload(value) {
  if (!value || value.schemaVersion !== SCHEMA_VERSION || typeof value.instanceId !== 'string'
    || !value.fleet || typeof value.fleet !== 'object') {
    fail('INVALID_REMOTE_RESPONSE', '远端返回了不兼容的 Fleet 数据', 502);
  }
  const fleet = value.fleet;
  const sourceInstanceId = cleanText(value.instanceId, 128);
  const sourceFleetId = cleanText(fleet.id, 128);
  const remoteName = cleanText(fleet.name, 120);
  if (!sourceInstanceId || !sourceFleetId || !remoteName) {
    fail('INVALID_REMOTE_RESPONSE', '远端 Fleet 数据不完整', 502);
  }
  const sessions = normalizeRemoteSessions(fleet.sessions);
  const remoteToken = cleanText(value.capability && value.capability.token, 160);
  const remoteGrant = cleanText(value.capability && value.capability.grant, 180);
  if (!TOKEN_RE.test(remoteToken) || !GRANT_RE.test(remoteGrant)) {
    fail('INVALID_REMOTE_RESPONSE', '远端 Fleet 未提供可操作授权', 502);
  }
  return {
    sourceInstanceId,
    sourceFleetId,
    remoteName,
    description: cleanText(fleet.description, 500),
    sessions,
    sessionCount: sessions.length,
    remoteToken,
    remoteGrant,
  };
}

function createFleetSharing({
  sharesFile,
  externalFleetsFile,
  getDirectory,
  listSessions,
  fetchImpl = globalThis.fetch,
  lookupHost = dns.lookup.bind(dns),
  now = () => Date.now(),
  randomBytes = crypto.randomBytes,
  fetchTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
} = {}) {
  if (!sharesFile || !externalFleetsFile) throw new TypeError('fleet sharing files are required');
  if (typeof getDirectory !== 'function' || typeof listSessions !== 'function') {
    throw new TypeError('fleet sharing directory/session ports are required');
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('fleet sharing fetch implementation is required');

  const loadedShares = loadObject(sharesFile, {});
  let shareState = {
    schemaVersion: SCHEMA_VERSION,
    instanceId: cleanText(loadedShares.instanceId, 128) || `instance_${randomBytes(12).toString('base64url')}`,
    shares: loadedShares.shares && typeof loadedShares.shares === 'object' && !Array.isArray(loadedShares.shares)
      ? loadedShares.shares : {},
  };
  const loadedExternal = loadObject(externalFleetsFile, {});
  let externalState = {
    schemaVersion: SCHEMA_VERSION,
    fleets: loadedExternal.fleets && typeof loadedExternal.fleets === 'object' && !Array.isArray(loadedExternal.fleets)
      ? loadedExternal.fleets : {},
  };

  function saveShares(next) { atomicWriteJson(sharesFile, next); shareState = next; }
  function saveExternal(next) { atomicWriteJson(externalFleetsFile, next); externalState = next; }

  function createShare(fleetId, options = {}) {
    const directory = getDirectory(fleetId);
    if (!directory) fail('FLEET_NOT_FOUND', 'Fleet 不存在', 404);
    const password = normalizePassword(options.password);
    const expiresInDays = positiveInteger(options.expiresInDays, {
      min: 1, max: 365, fallback: 7, label: '有效天数',
    });
    const maxAccesses = positiveInteger(options.maxAccesses, {
      min: 1, max: 10_000, fallback: 10, label: '访问次数',
    });
    const description = cleanText(options.description, 500);
    const token = `fleet_share_${randomBytes(24).toString('base64url')}`;
    const salt = randomBytes(16).toString('hex');
    const createdAt = now();
    const record = {
      token,
      fleetId,
      description,
      createdAt,
      expiresAt: createdAt + expiresInDays * 86400_000,
      maxAccesses,
      accessCount: 0,
      accessGrant: randomBytes(32).toString('base64url'),
      salt,
      passwordHash: passwordHash(password, salt),
    };
    saveShares({ ...shareState, shares: { ...shareState.shares, [token]: record } });
    return publicShare(record, now());
  }

  function activeRecord(token) {
    const record = shareState.shares[token];
    if (!record) fail('SHARE_NOT_FOUND', '分享不存在或已失效', 404);
    if (now() > record.expiresAt) fail('SHARE_NOT_FOUND', '分享不存在或已失效', 404);
    return record;
  }

  function listShares(fleetId) {
    return Object.values(shareState.shares)
      .filter(record => record.fleetId === fleetId)
      .map(record => publicShare(record, now()))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  function revokeShare(fleetId, token) {
    const record = shareState.shares[token];
    if (!record) return false;
    if (record.fleetId !== fleetId) fail('SHARE_FLEET_MISMATCH', '分享不属于该 Fleet');
    const nextShares = { ...shareState.shares };
    delete nextShares[token];
    saveShares({ ...shareState, shares: nextShares });
    return true;
  }

  function sharedFleetPayload(record, token) {
    const directory = getDirectory(record.fleetId);
    if (!directory) fail('FLEET_NOT_FOUND', 'Fleet 已不存在', 404);
    const sessions = listSessions(directory.id).slice(0, 500).map(session => ({
      id: cleanText(session.id, 180),
      label: cleanText(session.label || session.id, 120, '未命名会话'),
      cli: ['claude', 'codex', 'opencode', 'zcode', 'qoder', 'kimi', 'codebuddy', 'dsh'].includes(session.cli)
        ? session.cli : 'other',
      kind: session.kind === 'terminal' ? 'terminal' : 'chat',
      type: session.type === 'commander' ? 'commander' : 'worker',
      createdAt: cleanText(String(session.createdAt || ''), 64) || null,
      active: session.active === true,
      model: cleanText(session.model, 120) || null,
      effectiveModel: cleanText(session.effectiveModel, 120) || null,
      provider: cleanText(session.provider, 180) || null,
    })).filter(session => session.id);
    return {
      schemaVersion: SCHEMA_VERSION,
      instanceId: shareState.instanceId,
      exportedAt: new Date(now()).toISOString(),
      capability: { token, grant: record.accessGrant },
      fleet: {
        id: directory.id,
        name: cleanText(directory.name, 120, '未命名 Fleet'),
        description: record.description,
        createdAt: cleanText(String(directory.createdAt || ''), 64) || null,
        sessionCount: sessions.length,
        sessions,
      },
    };
  }

  function accessSharedFleet(token, password) {
    const record = activeRecord(token);
    let safePassword;
    try { safePassword = normalizePassword(password); }
    catch (_) { fail('WRONG_PASSWORD', '密码错误', 403); }
    if (!passwordMatches(safePassword, record)) fail('WRONG_PASSWORD', '密码错误', 403);
    if ((record.accessCount || 0) >= record.maxAccesses) {
      fail('SHARE_EXHAUSTED', '分享访问次数已用完', 410);
    }
    if (!getDirectory(record.fleetId)) fail('FLEET_NOT_FOUND', 'Fleet 已不存在', 404);
    const updated = {
      ...record,
      accessCount: (record.accessCount || 0) + 1,
      accessGrant: GRANT_RE.test(record.accessGrant || '')
        ? record.accessGrant : randomBytes(32).toString('base64url'),
    };
    saveShares({ ...shareState, shares: { ...shareState.shares, [token]: updated } });
    return sharedFleetPayload(updated, token);
  }

  function readSharedFleet(token, grant) {
    const record = activeRecord(token);
    if (!secretMatches(grant, record.accessGrant)) fail('FLEET_SCOPE_FORBIDDEN', 'Fleet 授权无效', 403);
    return sharedFleetPayload(record, token);
  }

  async function requestRemoteFleet(parsedUrl, password) {
    await assertSafeRemoteTarget(parsedUrl.hostname, lookupHost);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), fetchTimeoutMs);
    let response;
    try {
      response = await fetchImpl(parsedUrl.apiUrl, {
        method: 'POST',
        redirect: 'manual',
        signal: controller.signal,
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
    } catch (_) {
      fail('REMOTE_UNAVAILABLE', '无法连接分享来源', 502);
    } finally {
      clearTimeout(timer);
    }
    if (response.status >= 300 && response.status < 400) {
      fail('REMOTE_REDIRECT_REJECTED', '分享来源返回了不安全的重定向', 502);
    }
    const declaredLength = Number(response.headers && response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REMOTE_BODY_BYTES) {
      fail('REMOTE_RESPONSE_TOO_LARGE', '远端 Fleet 数据过大', 502);
    }
    let text;
    try { text = await response.text(); }
    catch (_) { fail('INVALID_REMOTE_RESPONSE', '无法读取远端 Fleet 数据', 502); }
    if (Buffer.byteLength(text, 'utf8') > MAX_REMOTE_BODY_BYTES) {
      fail('REMOTE_RESPONSE_TOO_LARGE', '远端 Fleet 数据过大', 502);
    }
    if (!response.ok) {
      if (response.status === 403) fail('WRONG_PASSWORD', '密码错误', 403);
      if (response.status === 404) fail('SHARE_NOT_FOUND', '分享不存在或已失效', 404);
      if (response.status === 410) fail('SHARE_EXHAUSTED', '分享访问次数已用完', 410);
      if (response.status === 429) fail('SHARE_RATE_LIMITED', '尝试过于频繁，请稍后再试', 429);
      fail('REMOTE_UNAVAILABLE', '分享来源暂时不可用', 502);
    }
    try { return JSON.parse(text); }
    catch (_) { fail('INVALID_REMOTE_RESPONSE', '远端返回了无效数据', 502); }
  }

  async function importExternal({ shareUrl, password, alias } = {}) {
    const safePassword = normalizePassword(password);
    const parsedUrl = normalizeShareUrl(shareUrl);
    const remote = validateFleetPayload(await requestRemoteFleet(parsedUrl, safePassword));
    const safeAlias = cleanText(alias, 120);
    const existing = Object.values(externalState.fleets).find(record =>
      record.sourceInstanceId === remote.sourceInstanceId && record.sourceFleetId === remote.sourceFleetId);
    const timestamp = now();
    const record = {
      id: existing ? existing.id : `external_${randomBytes(12).toString('base64url')}`,
      alias: safeAlias || (existing && existing.alias) || '',
      remoteName: remote.remoteName,
      description: remote.description,
      sourceOrigin: parsedUrl.origin,
      shareUrl: String(shareUrl).trim(),
      sourceInstanceId: remote.sourceInstanceId,
      sourceFleetId: remote.sourceFleetId,
      remoteToken: remote.remoteToken,
      remoteGrant: remote.remoteGrant,
      sessions: remote.sessions,
      sessionCount: remote.sessionCount,
      importedAt: existing ? existing.importedAt : timestamp,
      refreshedAt: timestamp,
    };
    saveExternal({ ...externalState, fleets: { ...externalState.fleets, [record.id]: record } });
    return publicExternal(record);
  }

  function authorizeRequest({ token, grant, method, pathname } = {}) {
    let record;
    try { record = activeRecord(token); }
    catch (_) { return false; }
    if (!secretMatches(grant, record.accessGrant)) return false;
    const verb = String(method || 'GET').toUpperCase();
    let requestUrl;
    try { requestUrl = new URL(String(pathname || ''), 'http://multicc.local'); }
    catch (_) { return false; }
    const requestPath = requestUrl.pathname;
    if (verb === 'GET' && requestPath === `/api/fleet-shares/${token}/state`) return true;
    if (verb === 'GET' && /^\/api\/git\/(?:log|commit-diff)$/.test(requestPath)) {
      return requestUrl.searchParams.get('dirId') === record.fleetId;
    }
    // Relocation accepts a destination Fleet in the request body. Authentication
    // runs before body validation, so it cannot prove that destination remains
    // inside the shared Fleet; keep this one operation closed.
    if (/^\/api\/sessions\/[^/]+\/relocate$/.test(requestPath)) return false;
    let match = /^\/api\/directories\/([^/]+)(?:\/.*)?$/.exec(requestPath);
    if (match) {
      try { return decodeURIComponent(match[1]) === record.fleetId; }
      catch (_) { return false; }
    }
    match = /^\/api\/sessions\/([^/]+)(?:\/.*)?$/.exec(requestPath);
    if (match) {
      let sessionId;
      try { sessionId = decodeURIComponent(match[1]); }
      catch (_) { return false; }
      return listSessions(record.fleetId).some(session => session.id === sessionId);
    }
    if (verb !== 'GET') return false;
    return [
      /^\/api\/providers$/,
      /^\/api\/v1\/providers$/,
      /^\/api\/provider-defaults$/,
      /^\/api\/agent-presets(?:\/[^/]+)?$/,
      /^\/api\/(?:claude|qoder|opencode)\/models$/,
    ].some(pattern => pattern.test(requestPath));
  }

  function authorizeWebSocket({ token, grant, pathname, sessionId, directoryId } = {}) {
    let record;
    try { record = activeRecord(token); }
    catch (_) { return false; }
    if (!secretMatches(grant, record.accessGrant)) return false;
    if (pathname === '/ws/workspace') return directoryId === record.fleetId;
    if (pathname !== '/ws/chat' && pathname !== '/') return false;
    return listSessions(record.fleetId).some(session => session.id === sessionId);
  }

  function externalAuthority(id) {
    const record = externalState.fleets[id];
    if (!record || !TOKEN_RE.test(record.remoteToken || '') || !GRANT_RE.test(record.remoteGrant || '')) {
      fail('EXTERNAL_FLEET_NOT_INTERACTIVE', '该外部 Fleet 需要重新导入后才能操作', 409);
    }
    return {
      id: record.id,
      name: record.alias || record.remoteName,
      remoteName: record.remoteName,
      sourceOrigin: record.sourceOrigin,
      sourceFleetId: record.sourceFleetId,
      token: record.remoteToken,
      grant: record.remoteGrant,
      sessions: (Array.isArray(record.sessions) ? record.sessions : []).map(session => ({ ...session })),
    };
  }

  async function requestExternalRaw(record, { method = 'GET', pathname, headers = {}, body } = {}) {
    const remote = new URL(String(pathname || ''), `${record.sourceOrigin}/`);
    if (remote.origin !== record.sourceOrigin || !remote.pathname.startsWith('/api/')) {
      fail('INVALID_REMOTE_PATH', '远端 Fleet 请求路径无效');
    }
    await assertSafeRemoteTarget(remote.hostname, lookupHost);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), fetchTimeoutMs);
    let response;
    try {
      const streamedBody = body && typeof body.pipe === 'function';
      response = await fetchImpl(remote, {
        method,
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          accept: cleanText(headers.accept, 200, 'application/json'),
          ...(headers['content-type'] ? { 'content-type': cleanText(headers['content-type'], 200) } : {}),
          'x-multicc-fleet-token': record.token,
          'x-multicc-fleet-grant': record.grant,
        },
        ...(body !== undefined && !['GET', 'HEAD'].includes(method) ? { body } : {}),
        ...(streamedBody ? { duplex: 'half' } : {}),
      });
    } catch (_) {
      fail('REMOTE_UNAVAILABLE', '无法连接外部 Fleet', 502);
    } finally {
      clearTimeout(timer);
    }
    if (response.status >= 300 && response.status < 400) {
      fail('REMOTE_REDIRECT_REJECTED', '外部 Fleet 返回了不安全的重定向', 502);
    }
    const declaredLength = Number(response.headers && response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_PROXY_BODY_BYTES) {
      fail('REMOTE_RESPONSE_TOO_LARGE', '外部 Fleet 响应过大', 502);
    }
    let buffer;
    try { buffer = Buffer.from(await response.arrayBuffer()); }
    catch (_) { fail('INVALID_REMOTE_RESPONSE', '无法读取外部 Fleet 响应', 502); }
    if (buffer.length > MAX_PROXY_BODY_BYTES) fail('REMOTE_RESPONSE_TOO_LARGE', '外部 Fleet 响应过大', 502);
    return {
      status: response.status,
      body: buffer,
      contentType: cleanText(response.headers && response.headers.get('content-type'), 200),
      cacheControl: cleanText(response.headers && response.headers.get('cache-control'), 200),
    };
  }

  async function proxyExternal(id, request = {}) {
    const authority = externalAuthority(id);
    const result = await requestExternalRaw(authority, request);
    const method = String(request.method || 'GET').toUpperCase();
    if (result.status >= 200 && result.status < 300 && !['GET', 'HEAD'].includes(method)) {
      try { await refreshExternal(id); }
      catch (_) { /* the operation succeeded; a later dashboard refresh can retry */ }
    }
    return result;
  }

  async function refreshExternal(id) {
    const authority = externalAuthority(id);
    const result = await requestExternalRaw(authority, {
      method: 'GET',
      pathname: `/api/fleet-shares/${encodeURIComponent(authority.token)}/state`,
      headers: { accept: 'application/json' },
    });
    let payload;
    try { payload = JSON.parse(result.body.toString('utf8')); }
    catch (_) { fail('INVALID_REMOTE_RESPONSE', '远端返回了无效的 Fleet 数据', 502); }
    if (result.status !== 200) {
      fail('REMOTE_UNAVAILABLE', payload && payload.error || '无法刷新外部 Fleet', result.status || 502);
    }
    const remote = validateFleetPayload(payload);
    const current = externalState.fleets[id];
    if (!current) fail('EXTERNAL_FLEET_NOT_FOUND', '外部 Fleet 不存在', 404);
    if (remote.sourceInstanceId !== current.sourceInstanceId || remote.sourceFleetId !== current.sourceFleetId) {
      fail('INVALID_REMOTE_RESPONSE', '远端 Fleet 身份发生变化', 502);
    }
    const updated = {
      ...current,
      remoteName: remote.remoteName,
      description: remote.description,
      sessions: remote.sessions,
      sessionCount: remote.sessionCount,
      refreshedAt: now(),
    };
    saveExternal({ ...externalState, fleets: { ...externalState.fleets, [id]: updated } });
    return publicExternal(updated);
  }

  async function issueExternalWsTicket(id, { pathname, sessionId, directoryId } = {}) {
    const authority = externalAuthority(id);
    const result = await requestExternalRaw(authority, {
      method: 'POST',
      pathname: `/api/fleet-shares/${encodeURIComponent(authority.token)}/ws-ticket`,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ pathname, sessionId, directoryId }),
    });
    let payload;
    try { payload = JSON.parse(result.body.toString('utf8')); }
    catch (_) { fail('INVALID_REMOTE_RESPONSE', '远端返回了无效的 WebSocket 凭证', 502); }
    if (result.status !== 200 || !payload || typeof payload.ticket !== 'string' || typeof payload.wsOrigin !== 'string') {
      fail('REMOTE_UNAVAILABLE', payload && payload.error || '无法创建远端 WebSocket 凭证', result.status || 502);
    }
    return payload;
  }

  function listExternal() {
    return Object.values(externalState.fleets)
      .map(publicExternal)
      .sort((a, b) => b.refreshedAt - a.refreshedAt);
  }

  function removeExternal(id) {
    if (!externalState.fleets[id]) return false;
    const fleets = { ...externalState.fleets };
    delete fleets[id];
    saveExternal({ ...externalState, fleets });
    return true;
  }

  return Object.freeze({
    accessSharedFleet,
    authorizeRequest,
    authorizeWebSocket,
    createShare,
    externalAuthority,
    importExternal,
    issueExternalWsTicket,
    listExternal,
    listShares,
    proxyExternal,
    readSharedFleet,
    refreshExternal,
    removeExternal,
    revokeShare,
  });
}

module.exports = {
  DEFAULT_FETCH_TIMEOUT_MS,
  FleetSharingError,
  MAX_PASSWORD_BYTES,
  MAX_PROXY_BODY_BYTES,
  MAX_REMOTE_BODY_BYTES,
  GRANT_RE,
  SCHEMA_VERSION,
  TOKEN_RE,
  assertSafeRemoteTarget,
  blockedAddress,
  createFleetSharing,
  normalizeShareUrl,
  validateFleetPayload,
};
