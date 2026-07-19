'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  SHARE_COOKIE_MAX_AGE_SECONDS,
  createShareRoutes,
  mountShareRoutes,
} = require('../src/routes/share');

function createApp() {
  const routes = new Map();
  const app = {};
  for (const method of ['get', 'post', 'delete']) {
    app[method] = (routePath, handler) => routes.set(`${method.toUpperCase()} ${routePath}`, handler);
  }
  return { app, routes };
}

function makeResponse() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    sentFile: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    sendFile(file) { this.sentFile = file; return this; },
  };
}

function invoke(handler, options = {}) {
  const req = {
    params: options.params || {},
    body: options.body,
    headers: options.headers || {},
    protocol: options.protocol || 'https',
    get(name) { return String(name).toLowerCase() === 'host' ? (options.host || 'chat.example.test') : undefined; },
  };
  const res = makeResponse();
  handler(req, res);
  return res;
}

function createFakeShare() {
  const records = new Map();
  const calls = [];
  let next = 1;

  function publicRecord(record) {
    return {
      token: record.token,
      sessionId: record.sessionId,
      access: record.access,
      type: record.type || 'session',
      messageCount: record.type === 'messages' ? record.messages.length : undefined,
      hasPassword: !!record.password,
      expiresAt: record.expiresAt || null,
      createdAt: record.createdAt,
      label: record.label || null,
    };
  }

  return {
    records,
    calls,
    create(sessionId, options) {
      calls.push(['create', sessionId, options]);
      if (options.access === 'operate' && !options.password) {
        throw new Error('operate share requires a password');
      }
      const record = {
        token: `token-${next++}`,
        sessionId,
        access: options.access === 'operate' ? 'operate' : 'view',
        label: options.label,
        password: options.password || null,
        expiresAt: options.expiresAt || null,
        createdAt: 123,
      };
      records.set(record.token, record);
      return publicRecord(record);
    },
    createMessageShare(sessionId, messages, options) {
      calls.push(['createMessageShare', sessionId, messages, options]);
      if (!messages.length) throw new Error('no messages to share');
      const record = {
        token: `token-${next++}`,
        sessionId,
        access: 'view',
        type: 'messages',
        messages: messages.map((message) => ({ ...message })),
        label: options.label,
        password: options.password || null,
        expiresAt: options.expiresAt || null,
        createdAt: 123,
      };
      records.set(record.token, record);
      return publicRecord(record);
    },
    get(token) { calls.push(['get', token]); return records.get(token) || null; },
    listForSession(sessionId) {
      calls.push(['listForSession', sessionId]);
      return [...records.values()].filter((record) => record.sessionId === sessionId).map(publicRecord);
    },
    remove(token) { calls.push(['remove', token]); return records.delete(token); },
    verifyPassword(token, password) {
      calls.push(['verifyPassword', token, password]);
      const record = records.get(token);
      return !!record && (!record.password || record.password === password);
    },
    authCookieValue(record) { return `proof-${record.token}`; },
    cookieName(token) { return `multicc_share_${token}`; },
    access(token, { cookies }) {
      calls.push(['access', token, cookies]);
      const record = records.get(token);
      if (!record) return null;
      if (!record.password || cookies[`multicc_share_${token}`] === `proof-${token}`) {
        return { access: record.access, sessionId: record.sessionId };
      }
      return null;
    },
  };
}

function createHarness(overrides = {}) {
  const fakeShare = overrides.share || createFakeShare();
  const persistedSessions = overrides.persistedSessions || new Map([
    ['s1', { id: 's1', label: 'Primary', cli: 'codex', type: 'chat' }],
    ['aux1', { id: 'aux1', label: 'Aux', cli: 'claude', type: 'aux' }],
  ]);
  const histories = overrides.histories || new Map([
    ['s1', [
      { role: 'user', content: 'one', ts: 1 },
      { role: 'assistant', content: 'two', ts: 2 },
      { role: 'assistant', content: 'three', ts: 3 },
    ]],
  ]);
  const deps = {
    share: fakeShare,
    persistedSessions,
    loadChatHistory: overrides.loadChatHistory || ((id) => histories.get(id) || []),
    parseCookies: overrides.parseCookies || ((header) => Object.fromEntries(
      String(header || '').split(';').map((pair) => pair.trim()).filter(Boolean).map((pair) => {
        const index = pair.indexOf('=');
        return index < 0 ? [pair, ''] : [pair.slice(0, index), pair.slice(index + 1)];
      }),
    )),
    sharePageFile: '/app/public/share.html',
    logger: overrides.logger,
  };
  return { deps, fakeShare, histories, persistedSessions };
}

test('mount registers the seven established share routes and validates dependencies', () => {
  const { deps } = createHarness();
  const { app, routes } = createApp();
  mountShareRoutes(app, deps);
  assert.deepEqual([...routes.keys()], [
    'POST /api/sessions/:id/share',
    'GET /api/sessions/:id/shares',
    'DELETE /api/sessions/:id/share/:token',
    'POST /api/sessions/:id/share-messages',
    'GET /share/:token',
    'POST /api/share/:token/auth',
    'GET /api/share/:token/session',
  ]);
  assert.throws(() => createShareRoutes({}), /share\.access/);
  assert.throws(() => mountShareRoutes({}, deps), /app\.get/);
});

test('admin create keeps the legacy DTO, label fallback, URL, and system-session guards', () => {
  const { deps, fakeShare } = createHarness();
  const routes = createShareRoutes(deps);

  let res = invoke(routes.createSessionShare, { params: { id: 'missing' }, body: {} });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: 'session not found' });

  res = invoke(routes.createSessionShare, { params: { id: 'aux1' }, body: {} });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: 'cannot share system session' });

  res = invoke(routes.createSessionShare, {
    params: { id: 's1' },
    body: { access: 'operate', password: 'pw', expiresAt: 456 },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.access, 'operate');
  assert.equal(res.body.label, 'Primary');
  assert.equal(res.body.url, `https://chat.example.test/share/${res.body.token}`);
  assert.equal(Object.hasOwn(res.body, 'password'), false);
  assert.deepEqual(fakeShare.calls[0], [
    'create',
    's1',
    { access: 'operate', password: 'pw', expiresAt: 456, label: 'Primary' },
  ]);

  res = invoke(routes.createSessionShare, {
    params: { id: 's1' },
    body: { access: 'operate' },
  });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: 'operate share requires a password' });
});

test('admin list and revoke keep URLs, ownership checks, and idempotent missing-token result', () => {
  const { deps, fakeShare } = createHarness();
  const routes = createShareRoutes(deps);
  const created = invoke(routes.createSessionShare, { params: { id: 's1' }, body: {} }).body;

  let res = invoke(routes.listSessionShares, { params: { id: 's1' }, protocol: 'http', host: 'localhost:3000' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.shares.length, 1);
  assert.equal(res.body.shares[0].url, `http://localhost:3000/share/${created.token}`);

  fakeShare.records.set('foreign', {
    token: 'foreign', sessionId: 's2', access: 'view', label: 'Foreign', createdAt: 1,
  });
  res = invoke(routes.revokeSessionShare, { params: { id: 's1', token: 'foreign' } });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: 'token does not belong to this session' });
  assert.equal(fakeShare.records.has('foreign'), true);

  res = invoke(routes.revokeSessionShare, { params: { id: 's1', token: created.token } });
  assert.deepEqual(res.body, { ok: true });
  res = invoke(routes.revokeSessionShare, { params: { id: 's1', token: 'absent' } });
  assert.deepEqual(res.body, { ok: false });
});

test('message share copies selected history in requested order and retains snapshot DTO', () => {
  const { deps, fakeShare } = createHarness();
  const routes = createShareRoutes(deps);

  let res = invoke(routes.createMessageShare, { params: { id: 'missing' }, body: { indices: [0] } });
  assert.equal(res.statusCode, 404);

  res = invoke(routes.createMessageShare, { params: { id: 's1' }, body: { indices: [99] } });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: 'no valid messages selected' });

  res = invoke(routes.createMessageShare, {
    params: { id: 's1' },
    body: { indices: [2, 0, 2, -1], password: 'snap-pw', label: 'Excerpt' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.type, 'messages');
  assert.equal(res.body.messageCount, 3);
  assert.equal(res.body.hasPassword, true);
  assert.equal(res.body.label, 'Excerpt');
  const createCall = fakeShare.calls.find((call) => call[0] === 'createMessageShare');
  assert.deepEqual(createCall[2].map((message) => message.content), ['three', 'one', 'three']);
  assert.deepEqual(fakeShare.records.get(res.body.token).messages.map((message) => message.content), ['three', 'one', 'three']);
});

test('password auth keeps status codes and exact per-share cookie attributes', () => {
  const { deps } = createHarness();
  const routes = createShareRoutes(deps);
  const created = invoke(routes.createSessionShare, {
    params: { id: 's1' },
    body: { access: 'view', password: 'pw' },
  }).body;

  let res = invoke(routes.authenticateShare, { params: { token: 'missing' }, body: { password: 'pw' } });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: 'share not found or expired' });

  res = invoke(routes.authenticateShare, { params: { token: created.token }, body: { password: 'wrong' } });
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: '密码错误' });

  res = invoke(routes.authenticateShare, { params: { token: created.token }, body: { password: 'pw' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, access: 'view' });
  assert.equal(
    res.headers['set-cookie'],
    `multicc_share_${created.token}=proof-${created.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SHARE_COOKIE_MAX_AGE_SECONDS}`,
  );
  assert.equal(res.headers['set-cookie'].includes('pw'), false);
});

test('recipient session read preserves password gate, live history, and independent snapshots', () => {
  const { deps, fakeShare, persistedSessions } = createHarness();
  const routes = createShareRoutes(deps);
  const live = invoke(routes.createSessionShare, {
    params: { id: 's1' }, body: { access: 'operate', password: 'pw' },
  }).body;

  let res = invoke(routes.readSharedSession, { params: { token: 'missing' } });
  assert.equal(res.statusCode, 404);
  res = invoke(routes.readSharedSession, { params: { token: live.token } });
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { needPassword: true });

  res = invoke(routes.readSharedSession, {
    params: { token: live.token },
    headers: { cookie: `multicc_share_${live.token}=proof-${live.token}` },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    access: 'operate',
    type: 'session',
    sessionId: 's1',
    label: 'Primary',
    cli: 'codex',
    messages: [
      { role: 'user', content: 'one', ts: 1 },
      { role: 'assistant', content: 'two', ts: 2 },
      { role: 'assistant', content: 'three', ts: 3 },
    ],
  });

  const snapshot = invoke(routes.createMessageShare, {
    params: { id: 's1' }, body: { indices: [1], label: '' },
  }).body;
  persistedSessions.delete('s1');
  res = invoke(routes.readSharedSession, { params: { token: snapshot.token } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    access: 'view',
    type: 'messages',
    label: 'Primary',
    messages: [{ role: 'assistant', content: 'two', ts: 2 }],
  });

  fakeShare.records.get(live.token).password = null;
  res = invoke(routes.readSharedSession, { params: { token: live.token } });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: 'session no longer exists' });
});

test('page route serves the injected file and unexpected failures never expose paths or credentials', () => {
  const logs = [];
  const { deps, fakeShare } = createHarness({
    logger: { error: (...args) => logs.push(args) },
  });
  const routes = createShareRoutes(deps);
  let res = invoke(routes.serveSharePage, { params: { token: 'anything' } });
  assert.equal(res.sentFile, '/app/public/share.html');

  fakeShare.listForSession = () => {
    throw new Error('password=top-secret at /Users/private/shares.json');
  };
  res = invoke(routes.listSessionShares, { params: { id: 's1' } });
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: 'share listing failed' });
  assert.equal(JSON.stringify(res.body).includes('top-secret'), false);
  assert.equal(JSON.stringify(res.body).includes('/Users/private'), false);
  assert.equal(JSON.stringify(logs).includes('top-secret'), false);
  assert.equal(JSON.stringify(logs).includes('/Users/private'), false);

  fakeShare.create = () => {
    throw new Error('Bearer sk-secret /tmp/store.json');
  };
  res = invoke(routes.createSessionShare, { params: { id: 's1' }, body: {} });
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: 'share creation failed' });

  fakeShare.create = () => {
    throw new Error('invalid share expiry');
  };
  res = invoke(routes.createSessionShare, { params: { id: 's1' }, body: {} });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: 'invalid share expiry' });
});

test('route DTO is an explicit whitelist even if a store adapter returns extra fields', () => {
  const share = createFakeShare();
  share.create = () => ({
    token: 'safe-token', sessionId: 's1', access: 'view', type: 'session',
    messageCount: undefined, hasPassword: false, expiresAt: null, createdAt: 123,
    label: 'Safe', secret: 'must-not-leak', password: 'must-not-leak', path: '/private/store',
  });
  const { deps } = createHarness({ share });
  const routes = createShareRoutes(deps);
  const res = invoke(routes.createSessionShare, { params: { id: 's1' }, body: {} });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.token, 'safe-token');
  assert.equal(Object.hasOwn(res.body, 'secret'), false);
  assert.equal(Object.hasOwn(res.body, 'password'), false);
  assert.equal(Object.hasOwn(res.body, 'path'), false);
});
