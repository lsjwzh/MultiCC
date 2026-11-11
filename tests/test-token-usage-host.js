'use strict';

// 宿主端口（host port）：POST /api/__host/token-usage。
//
// 公开的 GET /api/token-usage/by-role 已由 Rust 前门独占。这里只断言 op 映射、
// 空快照回落、ledger 透传、错误不外泄，以及「只有回环请求能打到 tracker」。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createTokenUsageHost,
  mountTokenUsageHostRoute,
  EMPTY_ROLE_SNAPSHOT,
  HOST_PATH,
} = require('../src/routes/token-usage-host');

function fakeTracker(overrides = {}) {
  const calls = [];
  const tracker = {
    snapshot(sessionId) {
      calls.push(['snapshot', sessionId]);
      return overrides.snapshot ? overrides.snapshot(sessionId) : null;
    },
    readLedger() {
      calls.push(['ledger']);
      return overrides.readLedger ? overrides.readLedger() : {};
    },
  };
  return { tracker, calls };
}

function createApp() {
  const routes = new Map();
  const app = { routes };
  app.post = (routePath, handler) => routes.set(`POST ${routePath}`, handler);
  return app;
}

function mount(options = {}) {
  const app = createApp();
  mountTokenUsageHostRoute(app, { isLocal: () => true, ...options });
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

test('mounting registers exactly POST /api/__host/token-usage', () => {
  const { tracker } = fakeTracker();
  const app = mount({ tracker });
  assert.deepEqual([...app.routes.keys()], [`POST ${HOST_PATH}`]);
  assert.throws(() => mount(), /tracker is required/);
  assert.throws(() => createTokenUsageHost(null), /tracker is required/);
  assert.throws(
    () => mountTokenUsageHostRoute({}, { tracker }),
    /Express-compatible app is required/,
  );
});

test('the host port only answers loopback requests and never touches the tracker otherwise', async () => {
  const { tracker, calls } = fakeTracker();
  const app = mount({ tracker, isLocal: () => false });
  for (const body of [{ op: 'snapshot', session: 'session-a' }, { op: 'ledger' }]) {
    const response = await respond(app, body);
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.body, { error: 'not found' });
  }
  assert.deepEqual(calls, []);
});

test('snapshot answers the exact tracker object and falls back to the fixed empty snapshot', async () => {
  const snapshot = { main: { inputTokens: 3 }, sub: null, subByProvider: [] };
  const { tracker, calls } = fakeTracker({ snapshot: sessionId => (sessionId === 'session-a' ? snapshot : null) });
  const app = mount({ tracker });

  const response = await respond(app, { op: 'snapshot', session: 'session-a' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { ok: true, payload: snapshot });

  const missing = await respond(app, { op: 'snapshot', session: 'missing' });
  assert.deepEqual(missing.body, {
    ok: true,
    payload: { main: null, sub: null, subByProvider: [] },
  });
  assert.deepEqual(missing.body.payload, EMPTY_ROLE_SNAPSHOT);
  assert.deepEqual(calls, [['snapshot', 'session-a'], ['snapshot', 'missing']]);
});

test('ledger answers the tracked ledger object', async () => {
  const ledger = { '2026-07-19': { main: {} } };
  const { tracker, calls } = fakeTracker({ readLedger: () => ledger });
  const response = await respond(mount({ tracker }), { op: 'ledger' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { ok: true, payload: ledger });
  assert.deepEqual(calls, [['ledger']]);
});

test('unknown or missing ops answer ok:false without touching the tracker', async () => {
  const { tracker, calls } = fakeTracker();
  const handle = createTokenUsageHost({ tracker });
  assert.deepEqual(handle({ op: 'nope' }), { ok: false });
  assert.deepEqual(handle({}), { ok: false });
  assert.deepEqual(handle(null), { ok: false });
  assert.deepEqual(handle({ op: 'toString' }), { ok: false });
  assert.deepEqual(calls, []);

  const response = await respond(mount({ tracker }), { op: 'nope' });
  assert.deepEqual(response.body, { ok: false });
});

test('a throwing tracker logs the failure and answers ok:false without leaking the error', async () => {
  const error = new Error('credential=top-secret /private/ledger.json');
  const logged = [];
  const handle = createTokenUsageHost({
    tracker: {
      snapshot() { throw error; },
      readLedger() { throw error; },
    },
    logFailure: (...args) => logged.push(args),
  });
  assert.deepEqual(handle({ op: 'snapshot', session: 's' }), { ok: false });
  assert.deepEqual(handle({ op: 'ledger' }), { ok: false });
  assert.deepEqual(logged, [
    ['token_usage_role_read_failed', error],
    ['token_usage_role_read_failed', error],
  ]);

  const response = await respond(mount({
    tracker: { snapshot() { throw error; }, readLedger() { throw error; } },
    logFailure: (...args) => logged.push(args),
  }), { op: 'ledger' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { ok: false });
  assert.equal(JSON.stringify(response.body).includes('top-secret'), false);

  const quiet = createTokenUsageHost({ tracker: { readLedger() { throw error; } } });
  assert.deepEqual(quiet({ op: 'ledger' }), { ok: false });
});

test('non-object bodies answer ok:false and never reach the tracker', () => {
  const { tracker, calls } = fakeTracker();
  const handle = createTokenUsageHost({ tracker });
  for (const body of [undefined, null, [], ['snapshot'], 'ledger', 0, 1, true, false]) {
    assert.deepEqual(handle(body), { ok: false }, `body: ${JSON.stringify(body)}`);
  }
  assert.deepEqual(calls, []);
});
