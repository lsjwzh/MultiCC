'use strict';

// 宿主端口（host port）：POST /api/__host/secrets-vault。
//
// 五条公开 /api/secrets* 路由已由 Rust 前门独占。Node 侧只剩保险箱的进程内事实与
// 副作用：entries 表、0600 store、secret audit、env overlay/digest。路径匹配、参数
// 校验与响应形状都在 Rust，所以本文件只断言 op 映射、审计上下文透传、错误码映射
// 以及「只有 reveal 带值」这条不变量。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createSecretsVaultHost,
  mountSecretsVaultHostRoute,
  metaOf,
  HOST_PATH,
} = require('../src/routes/secrets-vault-host');

function entry(overrides = {}) {
  return {
    name: 'A_KEY',
    value: 'sk-secret-value',
    description: 'desc',
    source: 'user',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

function fakeVault(overrides = {}) {
  const calls = [];
  const vault = {
    list(context) {
      calls.push(['list', context]);
      return [{ name: 'A_KEY', description: '', source: 'user', createdAt: null, updatedAt: null }];
    },
    upsert(input, context) {
      calls.push(['upsert', input, context]);
      return { entry: entry(), created: true };
    },
    rename(name, to, context) {
      calls.push(['rename', name, to, context]);
      return { entry: entry({ name: to }) };
    },
    remove(name, context) {
      calls.push(['remove', name, context]);
      return { ok: true };
    },
    reveal(name, context) {
      calls.push(['reveal', name, context]);
      return { entry: entry({ name }) };
    },
    ...overrides,
  };
  return { vault, calls };
}

function createApp() {
  const routes = new Map();
  const app = { routes };
  app.post = (routePath, handler) => routes.set(`POST ${routePath}`, handler);
  return app;
}

function mount(options = {}) {
  const app = createApp();
  mountSecretsVaultHostRoute(app, { isLocal: () => true, ...options });
  return app;
}

function respond(app, body) {
  const handler = app.routes.get(`POST ${HOST_PATH}`);
  assert.equal(typeof handler, 'function', `missing route POST ${HOST_PATH}`);
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

test('mounting registers exactly POST /api/__host/secrets-vault', () => {
  const { vault } = fakeVault();
  const app = mount({ vault });
  assert.deepEqual([...app.routes.keys()], [`POST ${HOST_PATH}`]);
  assert.throws(() => mount(), /vault is required/);
  assert.throws(() => createSecretsVaultHost(null), /vault is required/);
});

test('the host port only answers loopback requests and never touches the vault otherwise', async () => {
  const { vault, calls } = fakeVault();
  const app = mount({ vault, isLocal: () => false });
  for (const body of [{ op: 'list' }, { op: 'reveal', name: 'A_KEY' }]) {
    const response = await respond(app, body);
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.body, { error: 'not found' });
  }
  assert.deepEqual(calls, []);
});

test('each op calls the audited vault export with the http context', async () => {
  const { vault, calls } = fakeVault();
  const handle = createSecretsVaultHost(vault);

  assert.deepEqual(handle({ op: 'list' }), {
    ok: true,
    entries: [{ name: 'A_KEY', description: '', source: 'user', createdAt: null, updatedAt: null }],
  });
  assert.deepEqual(calls[0], ['list', { source: 'http' }]);

  const upsert = handle({
    op: 'upsert', name: 'A_KEY', value: 'v', source: 'agent', description: 'd', sessionId: 'chat-1',
  });
  assert.equal(upsert.ok, true);
  assert.equal(upsert.created, true);
  assert.deepEqual(calls[1], [
    'upsert',
    { name: 'A_KEY', value: 'v', source: 'agent', description: 'd', sessionId: 'chat-1' },
    { source: 'http', sessionId: 'chat-1' },
  ]);

  assert.deepEqual(handle({ op: 'rename', name: 'A_KEY', to: 'B_KEY' }),
    { ok: true, entry: metaOf(entry({ name: 'B_KEY' })) });
  assert.deepEqual(calls[2], ['rename', 'A_KEY', 'B_KEY', { source: 'http' }]);

  assert.deepEqual(handle({ op: 'remove', name: 'A_KEY' }), { ok: true });
  assert.deepEqual(calls[3], ['remove', 'A_KEY', { source: 'http' }]);

  assert.deepEqual(handle({ op: 'reveal', name: 'A_KEY' }),
    { ok: true, name: 'A_KEY', value: 'sk-secret-value' });
  assert.deepEqual(calls[4], ['reveal', 'A_KEY', { source: 'http' }]);

  // The routing-test reveal is the one caller that names its feature.
  await handle({ op: 'reveal', name: 'A_KEY', source: 'routing_test' });
  assert.deepEqual(calls[5], ['reveal', 'A_KEY', { source: 'routing_test' }]);
  await handle({ op: 'reveal', name: 'A_KEY', source: 'something-else' });
  assert.deepEqual(calls[6], ['reveal', 'A_KEY', { source: 'http' }]);
});

test('upsert only forwards description/sessionId when the request carries those keys', () => {
  const { vault, calls } = fakeVault();
  const handle = createSecretsVaultHost(vault);

  handle({ op: 'upsert', name: 'A_KEY', value: 'v' });
  const [, input, context] = calls[0];
  assert.deepEqual(Object.keys(input), ['name', 'value', 'source']);
  assert.equal(Object.prototype.hasOwnProperty.call(input, 'description'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(input, 'sessionId'), false);
  assert.equal(context.source, 'http');
  assert.equal(context.sessionId, undefined);

  handle({ op: 'upsert', name: 'A_KEY', value: 'v', description: '', sessionId: 's1' });
  const [, withKeys] = calls[1];
  assert.deepEqual(Object.keys(withKeys), ['name', 'value', 'source', 'description', 'sessionId']);
  assert.equal(withKeys.description, '', 'an explicit empty description is forwarded, not dropped');
  assert.equal(withKeys.sessionId, 's1');
});

test('metaOf reproduces the vault metadata projection in the same key order', () => {
  assert.deepEqual(Object.keys(metaOf(entry())),
    ['name', 'description', 'source', 'createdAt', 'updatedAt']);
  assert.deepEqual(Object.keys(metaOf(entry({ updatedBy: 'chat-1' }))),
    ['name', 'description', 'source', 'createdAt', 'updatedAt', 'updatedBy']);
  assert.deepEqual(metaOf({ name: 'A' }),
    { name: 'A', description: '', source: 'user', createdAt: null, updatedAt: null });
  assert.ok(!('value' in metaOf(entry())), 'values never enter the projection');
});

test('upsert maps the full/error outcomes', () => {
  let calls = 0;
  const handle = createSecretsVaultHost({
    upsert() {
      calls += 1;
      return calls === 1
        ? { error: 'vault is full', status: 409 }
        : { error: 'value is required and cannot exceed 65536 characters', status: 400 };
    },
  });
  assert.deepEqual(handle({ op: 'upsert', name: 'A', value: 'v' }), { ok: false, reason: 'full' });
  assert.deepEqual(handle({ op: 'upsert', name: 'A', value: 'v' }), { ok: false, reason: 'error' });
});

test('rename, remove and reveal map vault errors to the reason codes', () => {
  const cases = [
    { op: 'rename', body: { name: 'A', to: 'B' }, result: { error: 'entry not found', status: 404 }, reason: 'missing' },
    { op: 'rename', body: { name: 'A', to: 'B' }, result: { error: 'target name already exists', status: 409 }, reason: 'exists' },
    { op: 'rename', body: { name: 'A', to: 'B' }, result: { error: 'name must be a valid env var identifier', status: 400 }, reason: 'error' },
    { op: 'remove', body: { name: 'A' }, result: { error: 'entry not found', status: 404 }, reason: 'missing' },
    { op: 'remove', body: { name: 'A' }, result: { error: 'boom' }, reason: 'error' },
    { op: 'reveal', body: { name: 'A' }, result: { error: 'entry not found', status: 404 }, reason: 'missing' },
    { op: 'reveal', body: { name: 'A' }, result: { error: 'boom' }, reason: 'error' },
  ];
  for (const { op, body, result, reason } of cases) {
    const handle = createSecretsVaultHost({ [op]: () => result });
    assert.deepEqual(handle({ op, ...body }), { ok: false, reason }, `${op} ${JSON.stringify(result)}`);
  }
});

test('an unknown op answers ok:false and a non-object body never throws', () => {
  const { vault } = fakeVault();
  const handle = createSecretsVaultHost(vault);
  assert.deepEqual(handle({ op: 'nope' }), { ok: false });
  assert.deepEqual(handle({}), { ok: false });
  assert.deepEqual(handle(null), { ok: false });
  assert.deepEqual(handle({ op: 'toString' }), { ok: false }, 'prototype names are not ops');
});

test('a throwing vault operation surfaces as the host failure status', async () => {
  const { vault } = fakeVault({ list() { throw new Error('audit unavailable'); } });
  const response = await respond(mount({ vault }), { op: 'list' });
  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.body, { error: 'host operation failed' });
});

test('only reveal returns the value; list/upsert/rename strip it', async () => {
  const { vault } = fakeVault();
  const app = mount({ vault });

  const revealed = await respond(app, { op: 'reveal', name: 'A_KEY' });
  assert.equal(revealed.statusCode, 200);
  assert.equal(revealed.body.value, 'sk-secret-value');

  for (const body of [
    { op: 'upsert', name: 'A_KEY', value: 'sk-secret-value' },
    { op: 'rename', name: 'A_KEY', to: 'B_KEY' },
    { op: 'list' },
  ]) {
    const response = await respond(app, body);
    assert.equal(response.statusCode, 200, body.op);
    assert.ok(!JSON.stringify(response.body).includes('sk-secret-value'),
      `${body.op} must not echo the value`);
  }
});
