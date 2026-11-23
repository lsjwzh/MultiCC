'use strict';

// 宿主端口（host port）：POST /api/__host/share-machines。
//
// 分享 / 多电脑 / 工作区 21 条公开路由已由 Rust 前门独占
// （native/gateway/src/app/share_machine_routes.rs，规则在
// native/core/src/share_machine_routes.rs，集成测试在
// native/gateway/tests/share_machine_routes.rs）。路径匹配、参数解码、
// Express 自动 OPTIONS 并集、内部执行槽闸门、跨站闸门都在 Rust。
// Node 只剩运行时事实与副作用，所以本文件只断言 op 映射、回环闸门、
// 错误信封与三个退休模块真的注册在捕获应用上。
//
// 完全 hermetic：机器域走假 addon（只回答 machineOperation /
// authorizeMachineRequest / machineGrantActive），分享与工作区用内存假依赖，
// 不碰真实 data 根、不连任何远端机器、不起端口、不读时钟。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'share-machines-host-'));
const addonFile = path.join(tmp, 'fake-addon.js');
fs.writeFileSync(addonFile, `
'use strict';
const calls = [];
globalThis.__shareMachineCalls = calls;
const fail = operation => JSON.stringify({ status: 503, data: { code: 'machine_native_unavailable', error: '多电脑组件尚未就绪，请更新后手动重启服务' } });
module.exports = {
  protocolVersion: () => 1,
  buildSearchIndex() {}, computeUsage() {}, cprClaudeQuota() {},
  machineOperation(root, operation, raw) {
    const input = JSON.parse(raw);
    calls.push([operation, input]);
    if (process.env.FAKE_MACHINE_RESPONSE) return process.env.FAKE_MACHINE_RESPONSE;
    switch (operation) {
      case 'list': return JSON.stringify({ status: 200, data: { machines: [{ id: 'm-self' }], grants: [] } });
      case 'self': return JSON.stringify({ status: 200, data: { machine: { id: 'm-self' } } });
      case 'grants': return JSON.stringify({ status: 200, data: { grants: [{ id: 'g1', machineId: 'm1', active: true }] } });
      case 'pair': return JSON.stringify({ status: 200, data: { machine: { id: 'm1' }, grant: { id: 'g1' }, grantId: 'g1', echo: input } });
      case 'revoke': return JSON.stringify({ status: 200, data: { removed: input.id } });
      case 'add': return JSON.stringify({ status: 200, data: { machine: { id: 'm2' }, echo: input } });
      case 'rename': return JSON.stringify({ status: 200, data: { machine: { id: input.id }, echo: input } });
      case 'remove': return JSON.stringify({ status: 200, data: { removed: input.id } });
      case 'websocket': return JSON.stringify({ status: 200, data: { ticket: 'upstream-ticket', path: input.path, echo: input } });
      case 'proxy': return JSON.stringify({ status: 200, body: Buffer.from('proxied').toString('base64'), headers: { 'x-proxy': 'yes' } });
      default: return fail(operation);
    }
  },
  authorizeMachineRequest(root, credential) {
    return credential === 'grant-credential' ? 'grant-1' : false;
  },
  machineGrantActive() { return true; },
};
`);
process.env.MULTICC_RUST_ADDON = addonFile;

const { createShareMachinesHost, HOST_PATH, OPS } = require('../src/routes/share-machines-host');
const { createMachineRuntime } = require('../src/machines');

const SESSION = { id: 's1', label: 'Demo', cli: 'claude', type: 'chat' };

function fakeShareStore(seed = {}) {
  const records = new Map();
  for (const [token, record] of Object.entries(seed.records || {})) records.set(token, record);
  return {
    records,
    access(token, { cookies }) {
      const record = records.get(token);
      if (!record) return null;
      if (!record.hasPassword) return { access: 'view' };
      return cookies[`share_${token}`] ? { access: record.access || 'view' } : null;
    },
    authCookieValue: record => `sig-${record.token}`,
    cookieName: token => `share_${token}`,
    create(sessionId, options) {
      const record = {
        token: 'tok-new', sessionId, access: options.access || 'view', type: 'session',
        messageCount: 3, hasPassword: !!options.password, expiresAt: options.expiresAt || null,
        createdAt: '2026-01-01T00:00:00.000Z', label: options.label, publicBaseUrl: options.publicBaseUrl || null,
      };
      records.set(record.token, record);
      return record;
    },
    createMessageShare(sessionId, picked, options) {
      const record = {
        token: 'tok-msg', sessionId, access: 'view', type: 'messages', messageCount: picked.length,
        hasPassword: !!options.password, expiresAt: null, createdAt: '2026-01-01T00:00:00.000Z',
        label: options.label, messages: picked,
      };
      records.set(record.token, record);
      return record;
    },
    get: token => records.get(token) || null,
    listForSession: sessionId => [...records.values()].filter(record => record.sessionId === sessionId),
    remove: token => records.delete(token),
    verifyPassword: (token, password) => password === 'share-pass',
  };
}

function fakeDeps(overrides = {}) {
  const calls = [];
  const share = fakeShareStore(overrides.seed);
  const deps = {
    express: { json: () => (() => {}), raw: () => (() => {}) },
    machines: createMachineRuntime({
      root: path.join(tmp, 'data-root'),
      authSecurity: {
        verifyAccessToken: token => token === 'target-pass',
        // The real RustAuthSecurity answers exactly these three keys, in this order.
        issueWsTicket: (ticketPath) => ({ ticket: 'ws-ticket', expiresAt: 1750000000000, path: ticketPath }),
      },
      getWss: () => null,
    }),
    share: {
      share,
      persistedSessions: { get: id => (id === SESSION.id ? SESSION : undefined) },
      loadChatHistory: id => { calls.push(['loadChatHistory', id]); return [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }]; },
      viewChatHistory: id => { calls.push(['viewChatHistory', id]); return [{ id: 'm1' }]; },
      paginateChatHistory: (id, options) => {
        calls.push(['paginateChatHistory', id, options]);
        return { messages: [{ id: 'm1' }], hasMore: true, found: true, hasNewer: false };
      },
      parseCookies: header => Object.fromEntries(String(header || '').split(';')
        .map(pair => pair.trim().split('='))
        .filter(pair => pair[0])),
      logger: { error: (...args) => calls.push(['logger.error', ...args]) },
    },
    workspaces: {
      records: overrides.records || new Map(),
      directories: overrides.directories || new Map(),
      getHibernation: () => overrides.hibernation || null,
      getOrphanScanner: () => overrides.orphanScanner || null,
    },
    ...overrides.deps,
  };
  return { deps, calls, share };
}

function mount(options = {}) {
  const { deps, calls, share } = fakeDeps(options);
  const routes = new Map();
  const app = { post: (routePath, handler) => routes.set(`POST ${routePath}`, handler) };
  const host = createShareMachinesHost(deps);
  host.mountRoute(app, { isLocal: () => true });
  const handler = routes.get(`POST ${HOST_PATH}`);
  assert.equal(typeof handler, 'function', `missing route POST ${HOST_PATH}`);
  return { handler, calls, share, host };
}

function respond(handler, body) {
  let settle;
  const responded = new Promise(resolve => { settle = resolve; });
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; settle(this); return this; },
  };
  handler({ body }, res);
  return responded;
}

const PARAM_KEYS = ['id', 'token', 'machineId', 'grantId'];

/** 一条 op 的最小“够用”载荷：参数 + 分享/机器域需要的事实。 */
function payloadFor(op, extra = {}) {
  const spec = OPS[op];
  const body = { op, method: spec.method, originalUrl: spec.path, query: {}, headers: { host: 'mac.local:7800' }, body: {} };
  for (const name of spec.params) body[name] = name === 'id' ? 's1' : `${name}-1`;
  if (op === 'machines-ws-ticket') { body.machineId = 'm1'; body.body = { path: '/api/status' }; }
  return { ...body, ...extra };
}

test('the host port rejects a request forwarded from a real client', async () => {
  const { deps } = fakeDeps();
  const routes = new Map();
  createShareMachinesHost(deps).mountRoute(
    { post: (routePath, handler) => routes.set(routePath, handler) },
    { isLocal: () => false },
  );
  const res = await respond(routes.get(HOST_PATH), { op: 'machines-list' });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: 'not found' });
});

test('an unknown or malformed body is a 400, never a silent success', async () => {
  const { handler } = mount();
  for (const body of [{ op: 'nope' }, {}, null, []]) {
    const res = await respond(handler, body);
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.deepEqual(res.body, { error: 'unknown host operation' });
  }
});

test('every op maps to exactly one Node fact and the front door keeps the envelope', async () => {
  const { handler } = mount();
  assert.equal(Object.keys(OPS).length, 20, 'the op table is the whole cluster');
  for (const op of Object.keys(OPS)) {
    const res = await respond(handler, payloadFor(op));
    assert.equal(res.statusCode, 200, `${op}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.ok, true, op);
    const value = res.body.value;
    assert.equal(typeof value.status, 'number', `${op} answers a rendered status`);
    assert.ok('body' in value, `${op} answers a rendered body`);
  }
});

test('machine answers keep the retired no-store header and the pairing/revoke side effects', async () => {
  const { handler, calls } = mount();
  let res = await respond(handler, payloadFor('machines-list'));
  assert.deepEqual(res.body.value.body, { machines: [{ id: 'm-self' }], grants: [] });
  assert.deepEqual(res.body.value.headers, [['Cache-Control', 'no-store']]);

  // pair：目标访问密码不对 → 403，未到 operate。
  calls.length = 0;
  res = await respond(handler, payloadFor('machines-pair', { headers: {} }));
  assert.deepEqual(res.body.value, { status: 403, body: { error: '目标电脑访问密码不正确，或尚未设置访问密码' }, headers: [] });
  assert.equal(calls.some(([name]) => name === 'operate'), false);

  // pair 成功：形状来自底下的 machines 内核，端口原样回放。
  globalThis.__shareMachineCalls.length = 0;
  res = await respond(handler, payloadFor('machines-pair', { headers: { 'x-access-token': 'target-pass' } }));
  assert.deepEqual(res.body.value.headers, [['Cache-Control', 'no-store']]);
  assert.equal(res.body.value.body.echo.url, undefined);
  assert.equal(globalThis.__shareMachineCalls[0][0], 'pair');

  // 授权撤销：x-multicc-machine-grant 由 authorize 重新解析成 grantId。
  globalThis.__shareMachineCalls.length = 0;
  res = await respond(handler, payloadFor('machines-connection-delete', {
    headers: { 'x-multicc-machine-grant': 'grant-credential' },
  }));
  assert.deepEqual(res.body.value.body, { removed: 'grant-1' });
  assert.deepEqual(globalThis.__shareMachineCalls.at(-1), ['revoke', { id: 'grant-1' }]);
});

test('ws-ticket keeps the retired key order and mints through the injected auth runtime', async () => {
  const { handler } = mount();
  const res = await respond(handler, payloadFor('machines-ws-ticket'));
  const value = res.body.value;
  assert.equal(value.status, 200);
  assert.deepEqual(Object.keys(value.body), ['ticket', 'expiresAt', 'path', 'proxyPath']);
  assert.equal(value.body.ticket, 'ws-ticket');
  assert.equal(value.body.path, '/api/status');
  assert.equal(value.body.proxyPath, '/ws/machines/m1');
  assert.deepEqual(value.headers, [['Cache-Control', 'no-store']]);
});

test('the retired share-page host operation is rejected', async () => {
  const { handler } = mount();
  const res = await respond(handler, { op: 'share-page', token: 'tok-1' });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: 'unknown host operation' });
});

test('share links are built from the forwarded host and proto, not the internal port', async () => {
  const { handler } = mount();
  let res = await respond(handler, payloadFor('session-share-create', {
    headers: { host: 'mac.local:7800', 'x-forwarded-proto': 'https' },
    body: { access: 'view', label: 'Handoff' },
  }));
  let value = res.body.value.body;
  assert.equal(value.ok, true);
  assert.equal(value.url, 'https://mac.local:7800/share/tok-new');
  assert.deepEqual(Object.keys(value).slice(0, 4), ['ok', 'token', 'sessionId', 'access']);

  res = await respond(handler, payloadFor('session-share-create', {
    body: { publicBaseUrl: 'https://share.example.com', label: 'Handoff' },
  }));
  value = res.body.value.body;
  assert.equal(value.url, 'https://share.example.com/share/tok-new');
  assert.equal(value.publicBaseUrl, 'https://share.example.com');

  res = await respond(handler, payloadFor('session-share-create', { body: { publicBaseUrl: 'ftp://x' } }));
  assert.deepEqual(res.body.value, { status: 400, body: { error: 'publicBaseUrl must be an http(s) URL' }, headers: [] });

  res = await respond(handler, payloadFor('session-share-create', { id: 'ghost' }));
  assert.deepEqual(res.body.value.body, { error: 'session not found' });
});

test('share auth sets the password cookie and refusals stay distinguishable', async () => {
  const { handler, share } = mount({ seed: { records: {
    'tok-1': { token: 'tok-1', sessionId: 's1', access: 'view', type: 'session', hasPassword: true, createdAt: 'x', label: null },
  } } });
  share.records.get('tok-1').hasPassword = true;
  let res = await respond(handler, payloadFor('share-auth', { token: 'tok-1', body: { password: 'wrong' } }));
  assert.deepEqual(res.body.value, { status: 403, body: { error: '密码错误' }, headers: [] });

  res = await respond(handler, payloadFor('share-auth', { token: 'tok-1', body: { password: 'share-pass' } }));
  assert.deepEqual(res.body.value.headers, [[
    'Set-Cookie',
    'share_tok-1=sig-tok-1; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800',
  ]]);
  assert.deepEqual(res.body.value.body, { ok: true, access: 'view' });

  // 不存在的 token → 404，而不是 401（页面据此分辨“没了”和“要密码”）。
  res = await respond(handler, payloadFor('share-entry', { token: 'gone' }));
  assert.deepEqual(res.body.value, { status: 404, body: { error: 'share not found or expired' }, headers: [] });
});

test('shared history forwards only the query keys the retired handler read', async () => {
  const { handler, calls } = mount({ seed: { records: {
    'tok-1': { token: 'tok-1', sessionId: 's1', access: 'view', type: 'session', hasPassword: false, createdAt: 'x' },
  } } });
  const res = await respond(handler, payloadFor('share-history', {
    token: 'tok-1',
    query: { before: '10', around: 'm2', limit: '5', orphans: '1' },
  }));
  assert.deepEqual(res.body.value.body, { messages: [{ id: 'm1' }], hasMore: true, found: true, hasNewer: false });
  assert.deepEqual(calls.at(-1), ['paginateChatHistory', 's1', {
    includeHidden: false, before: '10', around: 'm2', limit: '5',
  }]);
});

test('workspace sweep is an outcome, not an exception, when the runtime is missing', async () => {
  const { handler } = mount();
  let res = await respond(handler, payloadFor('workspaces-overview'));
  assert.deepEqual(res.body.value.body, {
    status: null, totals: { awake: 0, hibernated: 0 }, directories: [], removedIgnoredAudit: [], orphans: null,
  });
  res = await respond(handler, payloadFor('workspaces-sweep'));
  assert.deepEqual(res.body.value, { status: 503, body: { error: 'hibernation runtime not ready' }, headers: [] });
});

test('a handler that throws outside its own try crosses as a structured envelope', async () => {
  const { deps } = fakeDeps();
  const { handler } = mount({
    deps: {
      share: { ...deps.share, persistedSessions: { get() { throw new Error('session table exploded'); } } },
    },
  });
  const res = await respond(handler, payloadFor('session-share-create'));
  assert.deepEqual(res.body, { ok: true, value: {
    threw: true, status: 500, code: 'internal_error', message: 'internal_error',
  } });
});

test('the real machine runtime registers exactly the ten claimed paths', () => {
  const registered = [];
  const app = {
    get: (routePath) => registered.push(`GET ${routePath}`),
    post: (routePath) => registered.push(`POST ${routePath}`),
    patch: (routePath) => registered.push(`PATCH ${routePath}`),
    delete: (routePath) => registered.push(`DELETE ${routePath}`),
    use: () => {},
  };
  const machines = createMachineRuntime({ root: tmp, authSecurity: {}, getWss: () => null });
  machines.mountRoutes(app, { json: () => (() => {}) });
  const expected = Object.values(OPS)
    .filter(spec => spec.path.startsWith('/api/machines'))
    .map(spec => `${spec.method} ${spec.path}`)
    .sort();
  assert.deepEqual(registered.slice().sort(), expected);
  assert.equal(registered.includes('GET /api/machines/:machineId/proxy'), false,
    'the binary proxy is not part of the host port');
});

test('dependencies are validated at mount time', () => {
  const { deps } = fakeDeps();
  assert.throws(() => createShareMachinesHost({}), /express is required/);
  assert.throws(() => createShareMachinesHost({ express: deps.express }), /machines runtime is required/);
  assert.throws(() => createShareMachinesHost({ express: deps.express, machines: deps.machines },
  ), /share route dependencies are required/);
  assert.throws(() => createShareMachinesHost({
    express: deps.express, machines: deps.machines, share: deps.share,
  }), /workspace route dependencies are required/);
});

test.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
