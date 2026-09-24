'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRoutingTest, SAMPLE_TEXT, MAX_TEXT_LENGTH } = require('../src/routes/auto-provider-routing-test');
const { NAME_RE } = require('../src/secrets-vault');

const KEY = 'vck_route_test_value_should_never_leak';

function fakeVault(entries = { 'vercel-api-key': KEY }) {
  return {
    NAME_RE,
    reveal(name) { return entries[name] ? { entry: { name, value: entries[name] } } : { error: 'entry not found', status: 404 }; },
  };
}

function fetchReturning({ status = 200, payload, reject } = {}, calls = []) {
  return async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    if (reject) throw reject;
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload) };
  };
}

const simpleVerdict = {
  answers: {
    tier: { type: 'choice', choice: 't1', probabilities: { t1: 0.9, t2: 0.1 } },
    complexity: { type: 'score', score: 0, probabilities: [0.9, 0.1] },
  },
  providerMetadata: { typesafe: { confidence: { tier: 0.9, complexity: 0.9 } } },
};

test('a working key returns only the verdict: the key is sent upstream but never echoed back', async () => {
  const calls = [];
  const routingTest = createRoutingTest({ vault: fakeVault(), fetchImpl: fetchReturning({ payload: simpleVerdict }, calls) });
  const result = await routingTest.run({ text: '改个错别字' });
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.body).sort(), ['latencyMs', 'ok', 'tier']);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.tier, 't1');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(JSON.stringify(result.body).includes(KEY), false);
});

test('empty text falls back to a sample and long text is capped', async () => {
  const calls = [];
  const routingTest = createRoutingTest({ vault: fakeVault(), fetchImpl: fetchReturning({ payload: simpleVerdict }, calls) });
  await routingTest.run({});
  await routingTest.run({ text: 'x'.repeat(MAX_TEXT_LENGTH + 500) });
  assert.match(JSON.stringify(calls[0].body.state), new RegExp(SAMPLE_TEXT));
  assert.equal(JSON.stringify(calls[1].body.state).includes('x'.repeat(MAX_TEXT_LENGTH + 1)), false);
});

test('failures come back as codes the editor can explain, with scrubbed details', async () => {
  const missing = await createRoutingTest({ vault: fakeVault({}), fetchImpl: fetchReturning() }).run({});
  assert.equal(missing.body.ok, false);
  assert.equal(missing.body.code, 'jev_key_missing');

  const rejected = await createRoutingTest({
    vault: fakeVault(),
    fetchImpl: fetchReturning({ status: 401, payload: { error: { message: 'Invalid API key provided' } } }),
  }).run({});
  assert.equal(rejected.body.code, 'jev_http_401');
  assert.equal(rejected.body.status, 401);
  assert.equal(JSON.stringify(rejected.body).includes(KEY), false);

  const offline = await createRoutingTest({ vault: fakeVault(), fetchImpl: fetchReturning({ reject: new Error('ECONNRESET') }) }).run({});
  assert.equal(offline.body.code, 'jev_network');
});

test('a malformed vault name is refused before anything is read', async () => {
  let revealed = false;
  const vault = { NAME_RE, reveal() { revealed = true; return {}; } };
  const result = await createRoutingTest({ vault, fetchImpl: fetchReturning() }).run({ apiKeyName: '../etc/passwd' });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'invalid_api_key_name');
  assert.equal(revealed, false);
});

test('the route answers over HTTP through the express-style mount', async () => {
  const routes = new Map();
  const app = { post(path, handler) { routes.set(path, handler); } };
  createRoutingTest({ vault: fakeVault(), fetchImpl: fetchReturning({ payload: simpleVerdict }) }).mount(app);
  const handler = routes.get('/api/auto-provider/routing/test');
  assert.ok(handler);
  const sent = {};
  await handler({ body: { text: 'hi' } }, {
    status(code) { sent.status = code; return this; },
    json(body) { sent.body = body; return this; },
  });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.ok, true);
});
