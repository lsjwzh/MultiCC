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
    query: options.query || {},
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
      publicBaseUrl: record.publicBaseUrl || null,
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
        publicBaseUrl: options.publicBaseUrl || null,
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
        publicBaseUrl: options.publicBaseUrl || null,
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
  const historyPages = overrides.historyPages || [];
  const deps = {
    share: fakeShare,
    persistedSessions,
    loadChatHistory: overrides.loadChatHistory || ((id) => histories.get(id) || []),
    paginateChatHistory: overrides.paginateChatHistory || ((id, options) => {
      historyPages.push([id, options]);
      const messages = histories.get(id) || [];
      return { messages, hasMore: false };
    }),
    parseCookies: overrides.parseCookies || ((header) => Object.fromEntries(
      String(header || '').split(';').map((pair) => pair.trim()).filter(Boolean).map((pair) => {
        const index = pair.indexOf('=');
        return index < 0 ? [pair, ''] : [pair.slice(0, index), pair.slice(index + 1)];
      }),
    )),
    // 分享页就是聊天页本身，所以这里指的就是它，而不是另一份精简界面。
    chatPageFile: '/app/public/chat.html',
    serveHtml: overrides.serveHtml || ((file, res) => { res.sentFile = file; return res; }),
    logger: overrides.logger,
  };
  return { deps, fakeShare, histories, historyPages, persistedSessions };
}

test('mount registers the nine established share routes and validates dependencies', () => {
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
    'GET /api/share/:token/entry',
    'GET /api/share/:token/history',
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

test('create builds the link on the named root instead of the caller Host', () => {
  const { deps, fakeShare } = createHarness();
  const routes = createShareRoutes(deps);

  // 管理页多半开在 127.0.0.1 上：不指定根域时，生成的链接对方根本打不开。
  let res = invoke(routes.createSessionShare, {
    params: { id: 's1' },
    protocol: 'http',
    host: '127.0.0.1:3000',
    body: { access: 'view', publicBaseUrl: 'https://mac.tail94695a.ts.net/' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.url, `https://mac.tail94695a.ts.net/share/${res.body.token}`);
  // 存的是剥掉路径和尾斜杠的根域，不是用户粘进来的原串。
  assert.equal(res.body.publicBaseUrl, 'https://mac.tail94695a.ts.net');
  assert.equal(fakeShare.calls[0][2].publicBaseUrl, 'https://mac.tail94695a.ts.net');

  // 重新列出来还得是同一条链接。否则管理员关掉再打开对话框，会看到另一个地址，
  // 分不清哪条才是发出去的。
  res = invoke(routes.listSessionShares, { params: { id: 's1' }, protocol: 'http', host: '127.0.0.1:3000' });
  assert.equal(res.body.shares[0].url, `https://mac.tail94695a.ts.net/share/${res.body.shares[0].token}`);
});

test('message-snapshot shares accept the same link root', () => {
  const { deps } = createHarness();
  const routes = createShareRoutes(deps);
  const res = invoke(routes.createMessageShare, {
    params: { id: 's1' },
    protocol: 'http',
    host: '127.0.0.1:3000',
    body: { indices: [0, 2], publicBaseUrl: 'https://abc.vicp.fun' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.url, `https://abc.vicp.fun/share/${res.body.token}`);
});

test('create rejects a link root that is not a bare http(s) origin', () => {
  const { deps, fakeShare } = createHarness();
  const routes = createShareRoutes(deps);
  const rejected = [
    'javascript:alert(1)',
    'ftp://files.example.test',
    'not a url',
    'https://user:pw@share.example.test',
    `https://${'a'.repeat(3000)}.example.test`,
  ];
  for (const publicBaseUrl of rejected) {
    const res = invoke(routes.createSessionShare, { params: { id: 's1' }, body: { publicBaseUrl } });
    assert.equal(res.statusCode, 400, `must reject ${publicBaseUrl.slice(0, 40)}`);
    assert.deepEqual(res.body, { error: 'publicBaseUrl must be an http(s) URL' });
  }
  // 一个坏根域不能被悄悄忽略掉换成 Host：那样用户会拿到一条看着成功、
  // 实际指向 localhost 的链接。
  assert.equal(fakeShare.calls.length, 0, 'a rejected root must not create a share');
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

test('page route serves the chat renderer itself, so a share is the same page', () => {
  const { deps } = createHarness();
  const routes = createShareRoutes(deps);
  const res = invoke(routes.serveSharePage, { params: { token: 'anything' } });
  // 分享出去的必须就是管理员用的那一份文档。指到另一份精简页面上，两边就会各自
  // 演化 —— 这正是这次要修掉的东西。
  assert.equal(res.sentFile, '/app/public/chat.html');
});

test('recipient entry answers who the link is and how much it may do', () => {
  const { deps, fakeShare } = createHarness();
  const routes = createShareRoutes(deps);
  const live = invoke(routes.createSessionShare, {
    params: { id: 's1' }, body: { access: 'operate', password: 'pw' },
  }).body;

  let res = invoke(routes.readShareEntry, { params: { token: 'missing' } });
  assert.equal(res.statusCode, 404);
  res = invoke(routes.readShareEntry, { params: { token: live.token } });
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { needPassword: true });

  res = invoke(routes.readShareEntry, {
    params: { token: live.token },
    headers: { cookie: `multicc_share_${live.token}=proof-${live.token}` },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { access: 'operate', type: 'session', sessionId: 's1', label: 'Primary', cli: 'codex' });
  // 启动答复里不能带整份历史：长会话会让页面为了知道一个 session id 先下几 MB。
  assert.equal(Object.hasOwn(res.body, 'messages'), false);

  const snapshot = invoke(routes.createMessageShare, {
    params: { id: 's1' }, body: { indices: [1], label: '' },
  }).body;
  res = invoke(routes.readShareEntry, { params: { token: snapshot.token } });
  assert.equal(res.statusCode, 200);
  // 快照没有活会话可取，内容只能随启动答复一起给。
  assert.deepEqual(res.body, {
    access: 'view',
    type: 'messages',
    label: 'Primary',
    messages: [{ role: 'assistant', content: 'two', ts: 2 }],
  });

  // 链接自己的名字优先于会话当前的名字：会话后来改名了，接收方手里的链接还是
  // 当初那个名字，否则他没有任何办法知道这是哪一段对话。
  fakeShare.records.get(live.token).label = '链接自己的名字';
  res = invoke(routes.readShareEntry, {
    params: { token: live.token },
    headers: { cookie: `multicc_share_${live.token}=proof-${live.token}` },
  });
  assert.equal(res.body.label, '链接自己的名字');

  fakeShare.records.get(live.token).password = null;
  fakeShare.records.get(live.token).sessionId = 'gone';
  res = invoke(routes.readShareEntry, { params: { token: live.token } });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: 'session no longer exists' });
});

test('recipient history pages a shared session and never reveals hidden messages', () => {
  const { deps, historyPages } = createHarness();
  const routes = createShareRoutes(deps);
  const live = invoke(routes.createSessionShare, {
    params: { id: 's1' }, body: { access: 'view', password: 'pw' },
  }).body;
  const authorized = { cookie: `multicc_share_${live.token}=proof-${live.token}` };

  let res = invoke(routes.readSharedHistory, { params: { token: live.token } });
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { needPassword: true });
  res = invoke(routes.readSharedHistory, { params: { token: 'missing' } });
  assert.equal(res.statusCode, 404);
  // 密码不对的请求一次分页都不该发生。
  assert.equal(historyPages.length, 0);

  res = invoke(routes.readSharedHistory, { params: { token: live.token }, headers: authorized });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.messages.length, 3);
  assert.equal(res.body.hasMore, false);
  assert.deepEqual(historyPages[0], ['s1', {
    includeHidden: false, before: undefined, around: undefined, limit: undefined,
  }]);

  // 往下翻页用 before/limit；around 是「跳到某条消息」用的，要带回 found/hasNewer。
  res = invoke(routes.readSharedHistory, {
    params: { token: live.token },
    headers: authorized,
    query: { before: 'm3', limit: '2' },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(historyPages[1], ['s1', {
    includeHidden: false, before: 'm3', around: undefined, limit: '2',
  }]);

  res = invoke(routes.readSharedHistory, {
    params: { token: live.token },
    headers: authorized,
    query: { around: 'm2' },
  });
  assert.equal(res.body.found, false);
  assert.equal(res.body.hasNewer, false);
  assert.equal(historyPages[2][1].around, 'm2');

  // 接收方请求里带 historyScope=archive 也不能把管理员删掉的消息透出去：
  // 分享的是对方看到的那一份。
  res = invoke(routes.readSharedHistory, {
    params: { token: live.token },
    headers: authorized,
    query: { historyScope: 'archive' },
  });
  assert.equal(historyPages[3][1].includeHidden, false);

  // 消息快照已经在启动答复里给全了，没有更老的页可翻 —— 这里回空页而不是报错，
  // 页面滚到顶端时看到的是「已是最早消息」，不是一个错误。
  const snapshot = invoke(routes.createMessageShare, {
    params: { id: 's1' }, body: { indices: [1], label: '' },
  }).body;
  res = invoke(routes.readSharedHistory, { params: { token: snapshot.token } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { messages: [], hasMore: false });
  assert.equal(historyPages.length, 4);
});

test('unexpected failures never expose paths or credentials', () => {
  const logs = [];
  const { deps, fakeShare } = createHarness({
    logger: { error: (...args) => logs.push(args) },
  });
  const routes = createShareRoutes(deps);

  fakeShare.listForSession = () => {
    throw new Error('password=top-secret at /Users/private/shares.json');
  };
  let res = invoke(routes.listSessionShares, { params: { id: 's1' } });
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: 'share listing failed' });
  assert.equal(JSON.stringify(res.body).includes('top-secret'), false);
  assert.equal(JSON.stringify(res.body).includes('/Users/private'), false);
  assert.equal(JSON.stringify(logs).includes('top-secret'), false);
  assert.equal(JSON.stringify(logs).includes('/Users/private'), false);

  fakeShare.get = () => {
    throw new Error('Bearer sk-secret /tmp/store.json');
  };
  res = invoke(routes.readShareEntry, { params: { token: 't' } });
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: 'shared entry read failed' });
  assert.equal(JSON.stringify(res.body).includes('sk-secret'), false);

  fakeShare.get = (token) => fakeShare.records.get(token) || null;
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
