'use strict';

// GET /api/providers/:id/models — live catalog for a relay (借道) provider.
//
// The picker must be able to show models the upstream actually serves today,
// while never letting the CLIENT decide which URL is dialed (SSRF) and never
// leaking the stored credential. A gateway outage is a fallback, not an error.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createProviderModelsRuntime,
  mountProviderModelRoutes,
  modelsFromPayload,
} = require('../src/routes/provider-models');

const FAKE_KEY = 'fake-relay-key-do-not-leak';

function providerFixture(overrides = {}) {
  const record = {
    id: 'relay-1', appType: 'codex', source: 'local',
    settingsConfig: { auth: { OPENAI_API_KEY: FAKE_KEY }, config: 'base_url = "https://relay.example/v1"' },
    ...(overrides.record || {}),
  };
  const summary = {
    id: record.id, appType: 'codex', apiFormat: 'openai_responses',
    baseUrl: 'https://relay.example/v1', model: 'relay-old',
    modelOptions: ['relay-old', 'relay-static'], isOfficial: false,
    ...(overrides.summary || {}),
  };
  const providers = {
    getProvider(_appType, id) { return id === record.id ? record : null; },
    summarize() { return summary; },
    getRelayImportToken() { return overrides.token === undefined ? FAKE_KEY : overrides.token; },
  };
  return { record, summary, providers };
}

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
  };
}

function runtimeFor(fixture, fetchImpl) {
  return createProviderModelsRuntime({ providers: fixture.providers, fetch: fetchImpl });
}

function mount(app, runtime) {
  app.get = (path, handler) => { app.routes.set(path, handler); };
  mountProviderModelRoutes(app, { runtime });
  return app.routes.get('/api/providers/:id/models');
}

function fakeRes() {
  const res = {
    statusCode: 200, body: undefined,
    status(code) { this.statusCode = code; return this; },
    set() {},
    json(body) { this.body = body; return this; },
  };
  return res;
}

test('?refresh=1 pulls the live catalog from the provider base URL with its stored key', async () => {
  const fixture = providerFixture();
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return response(200, { data: [{ id: 'live-a', name: 'Live A' }, { id: 'live-b' }] });
  };
  const body = (await runtimeFor(fixture, fetchImpl).listProviderModels('relay-1', { refresh: true })).body;
  assert.equal(body.source, 'live');
  assert.deepEqual(body.models.map(entry => entry.model), ['live-a', 'live-b']);
  assert.equal(body.models[0].label, 'Live A');
  assert.equal(calls[0].url, 'https://relay.example/v1/models');
  assert.equal(calls[0].options.headers.authorization, `Bearer ${FAKE_KEY}`);
});

test('a failing gateway returns the static modelOptions with a 200, never a 5xx', async () => {
  const fixture = providerFixture();
  const result = await runtimeFor(fixture, async () => response(500, {})).listProviderModels('relay-1', { refresh: true });
  assert.equal(result.status, 200);
  assert.equal(result.body.source, 'fallback');
  assert.deepEqual(result.body.models.map(entry => entry.model), ['relay-old', 'relay-static']);
});

test('live results are cached for an hour; refresh=1 bypasses the cache', async () => {
  const fixture = providerFixture();
  let version = 'first';
  const fetches = [];
  const fetchImpl = async () => {
    fetches.push(version);
    return response(200, { data: [{ id: version }] });
  };
  const runtime = runtimeFor(fixture, fetchImpl);
  assert.equal((await runtime.listProviderModels('relay-1')).body.models[0].model, 'first');
  version = 'second';
  assert.equal((await runtime.listProviderModels('relay-1')).body.models[0].model, 'first');
  assert.equal(fetches.length, 1);
  const fresh = (await runtime.listProviderModels('relay-1', { refresh: true })).body;
  assert.equal(fresh.models[0].model, 'second');
  assert.equal(fetches.length, 2);
});

test('an unknown provider is a 404', async () => {
  const fixture = providerFixture();
  const result = await runtimeFor(fixture, async () => response(200, {})).listProviderModels('missing');
  assert.equal(result.status, 404);
  assert.match(result.body.error, /not found/i);
});

test('the query string cannot redirect the fetch (SSRF) and the key never comes back', async () => {
  const fixture = providerFixture();
  const calls = [];
  const app = { routes: new Map() };
  const handler = mount(app, runtimeFor(fixture, async url => {
    calls.push(url);
    return response(200, { models: [{ id: 'safe-model' }] });
  }));
  const res = fakeRes();
  await handler({
    params: { id: 'relay-1' },
    query: { refresh: '1', baseURL: 'https://evil.example', url: 'https://evil.example' },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls, ['https://relay.example/v1/models']);
  assert.equal(JSON.stringify(res.body).includes(FAKE_KEY), false);
  assert.equal(JSON.stringify(res.body).includes('evil.example'), false);
});

test('a 401 with the stored key retries unauthenticated before falling back', async () => {
  const fixture = providerFixture();
  const seen = [];
  const fetchImpl = async (_url, options) => {
    seen.push({ ...options.headers });
    return seen.length === 1 ? response(401, {}) : response(200, { models: [{ id: 'anon-model' }] });
  };
  const body = (await runtimeFor(fixture, fetchImpl).listProviderModels('relay-1', { refresh: true })).body;
  assert.equal(body.source, 'live');
  assert.equal(body.models[0].model, 'anon-model');
  assert.equal(seen[0].authorization, `Bearer ${FAKE_KEY}`);
  assert.equal(seen[1].authorization, undefined);
});

test('Anthropic-format providers send x-api-key + anthropic-version', async () => {
  const fixture = providerFixture({
    record: { id: 'relay-a', appType: 'claude' },
    summary: { id: 'relay-a', appType: 'claude', apiFormat: 'anthropic', baseUrl: 'https://relay.example/anthropic' },
  });
  let headers;
  const fetchImpl = async (_url, options) => {
    headers = options.headers;
    return response(200, { data: [{ id: 'claude-live', display_name: 'Claude Live' }] });
  };
  const body = (await runtimeFor(fixture, fetchImpl).listProviderModels('relay-a', { refresh: true })).body;
  assert.equal(body.models[0].model, 'claude-live');
  assert.equal(body.models[0].label, 'Claude Live');
  assert.equal(headers['x-api-key'], FAKE_KEY);
  assert.equal(headers['anthropic-version'], '2023-06-01');
});

test('payload normalization accepts arrays, data and models shapes', () => {
  assert.deepEqual(modelsFromPayload([{ id: 'a' }, 'b']).map(entry => entry.model), ['a', 'b']);
  assert.deepEqual(modelsFromPayload({ data: [{ model: 'c', label: 'C' }] }).map(entry => entry.model), ['c']);
  assert.deepEqual(modelsFromPayload({ models: [{ id: 'd' }] }).map(entry => entry.model), ['d']);
});
