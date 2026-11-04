'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  catalogRevision,
  createProviderRelayModelCatalogRuntime,
  mountProviderRelayModelCatalogRoutes,
  normalizeModels,
} = require('../src/providers/relay-model-catalog');
const { applyProviderRelayModelCatalog, summarize } = require('../src/providers/core');

function response(body, status = 200) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => String(name).toLowerCase() === 'content-length' ? String(Buffer.byteLength(text)) : null },
    text: async () => text,
  };
}

function chunkedResponse(chunks, status = 200) {
  let index = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    body: {
      getReader() {
        return {
          async read() {
            if (index >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: Buffer.from(chunks[index++]) };
          },
          async cancel() { index = chunks.length; },
          releaseLock() {},
        };
      },
    },
  };
}

function providerRuntime(overrides = {}) {
  const updates = [];
  const providers = {
    getProviderSummary: (appType, id) => ({
      id, appType, name: 'Relay', isOfficial: false,
      model: 'gpt-6-astra', modelOptions: ['gpt-6-astra'],
    }),
    getProviderLimitTarget: (appType, id) => ({
      appType, providerId: id, strategy: 'relay-quota',
      relayUrl: `https://lender.test/${appType === 'codex' ? 'codex-proxy' : 'claude-proxy'}/${id}`,
      apiKey: 'mcr1.abcdefghijklmnop.secret-value',
    }),
    listProviders: appType => [{ id: 'borrowed', appType: appType || 'codex' }],
    providerSupportsCli: () => true,
    updateProviderRelayModelCatalog(appType, id, catalog) {
      updates.push({ appType, id, catalog });
      return { changed: true, model: 'gpt-6-astra', syncedAt: 1234 };
    },
    ...overrides,
  };
  return { providers, updates };
}

test('relay model normalization is bounded, ordered and accepts current model-id syntax', () => {
  assert.deepEqual(normalizeModels([
    'gpt-6.1-sol', 'gpt-6.1-sol', 'glm-5.2[1M]', 'vendor/model:v2', '', 'bad model',
  ]), ['gpt-6.1-sol', 'glm-5.2[1M]', 'vendor/model:v2']);
});

test('a Claude official account exposes the CLI fallback catalog instead of an empty one', async () => {
  const { providers } = providerRuntime({
    getProviderSummary: (appType, id) => ({
      id, appType, name: 'Claude Official', isOfficial: true, model: '', modelOptions: [],
    }),
  });
  const runtime = createProviderRelayModelCatalogRuntime({
    providers,
    now: () => 5000,
    fetch: async () => { throw new Error('unused'); },
  });
  const catalog = await runtime.sourceCatalog('claude', 'claude-official-aaaaaaaaaaaaaaaa');
  assert.equal(catalog.ok, true);
  assert.ok(catalog.models.includes('claude-haiku-4-5'));
  assert.ok(catalog.models.includes('claude-sonnet-5'));
  assert.equal(catalog.preferredModel, catalog.models[0]);
});

test('lender catalog reads cached Codex models without refreshing and mounts both scoped paths', async () => {
  const { providers } = providerRuntime({
    getProviderSummary: (appType, id) => id === 'missing' ? null : ({
      id, appType, name: 'Official', isOfficial: appType === 'codex',
      model: '', modelOptions: appType === 'codex'
        ? ['gpt-6.1-sol', 'gpt-6-astra'] : ['claude-opus-5'],
    }),
  });
  let nudges = 0;
  const runtime = createProviderRelayModelCatalogRuntime({
    providers,
    now: () => 5000,
    codexModelsRuntime: {
      syncIfDue: () => { nudges += 1; },
      peek: () => ({
        models: [{ model: 'gpt-6.1-sol' }, { model: 'gpt-6-astra' }],
        catalogFetchedAt: 4900,
      }),
    },
    fetch: async () => { throw new Error('unused'); },
  });
  const catalog = await runtime.sourceCatalog('codex', 'official');
  assert.equal(catalog.ok, true);
  assert.deepEqual(catalog.models, ['gpt-6.1-sol', 'gpt-6-astra']);
  assert.equal(catalog.preferredModel, 'gpt-6.1-sol');
  assert.equal(catalog.catalogFetchedAt, 4900);
  assert.equal(nudges, 0, '借道读取不额外触发模型刷新');
  assert.equal(catalog.revision, catalogRevision('gpt-6.1-sol', catalog.models));

  const routes = {};
  mountProviderRelayModelCatalogRoutes({
    get: (path, handler) => { routes[path] = handler; },
  }, runtime);
  assert.equal(typeof routes['/claude-proxy/:id/remote/models'], 'function');
  assert.equal(typeof routes['/codex-proxy/:id/models'], 'function');
  const res = {
    statusCode: 200, headers: {}, body: null,
    set(key, value) { this.headers[key] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await routes['/codex-proxy/:id/models']({ params: { id: 'official' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.ok(res.body.models.includes('gpt-6.1-sol'));

  const missing = { ...res, statusCode: 200, body: null, headers: {} };
  await routes['/codex-proxy/:id/models']({ params: { id: 'missing' } }, missing);
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.body.reason, 'not_found');
});

test('borrower automatically persists new models, dedupes by TTL, and never exposes the relay secret', async () => {
  let now = 1000;
  let requests = 0;
  const { providers, updates } = providerRuntime();
  const runtime = createProviderRelayModelCatalogRuntime({
    providers,
    now: () => now,
    syncIntervalMs: 60000,
    fetch: async (url, init) => {
      requests += 1;
      assert.equal(url, 'https://lender.test/codex-proxy/borrowed/models');
      assert.equal(init.headers.Authorization, 'Bearer mcr1.abcdefghijklmnop.secret-value');
      return response({
        ok: true, appType: 'codex', preferredModel: 'gpt-6.1-sol',
        models: ['gpt-6.1-sol', 'gpt-6-astra'], revision: 'revision-one', generatedAt: 900,
      });
    },
    logger: { warn() {} },
  });

  const first = await runtime.syncProvider('codex', 'borrowed');
  assert.equal(first.ok, true);
  assert.equal(first.changed, true);
  assert.deepEqual(first.models, ['gpt-6.1-sol', 'gpt-6-astra']);
  assert.equal(JSON.stringify(first).includes('secret-value'), false);
  assert.equal(requests, 1);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].catalog.preferredModel, 'gpt-6.1-sol');

  const cached = await runtime.syncProvider('codex', 'borrowed');
  assert.deepEqual(cached, {
    ok: true, skipped: true, reason: 'fresh', appType: 'codex', providerId: 'borrowed',
  });
  assert.equal(requests, 1);

  now += 60001;
  const refreshed = await runtime.refreshDue({ appType: 'codex', cli: 'codex' });
  assert.equal(refreshed.checked, 1);
  assert.equal(refreshed.updated, 1);
  assert.equal(requests, 2);
});

test('old/offline lenders leave the imported snapshot intact and are retry-throttled', async () => {
  let now = 1000;
  let requests = 0;
  const { providers, updates } = providerRuntime();
  const runtime = createProviderRelayModelCatalogRuntime({
    providers,
    now: () => now,
    retryIntervalMs: 30000,
    fetch: async () => { requests += 1; return response({ error: 'not found' }, 404); },
    logger: { warn() {} },
  });
  const first = await runtime.syncProvider('codex', 'borrowed');
  assert.equal(first.ok, false);
  assert.equal(first.reason, 'remote_http_404');
  assert.equal(updates.length, 0, 'last-known-good snapshot must not be overwritten');
  const throttled = await runtime.syncProvider('codex', 'borrowed');
  assert.equal(throttled.skipped, true);
  assert.equal(requests, 1);
  now += 30001;
  await runtime.syncProvider('codex', 'borrowed');
  assert.equal(requests, 2);
});

test('editing a relay invalidates its TTL and an in-flight old lender cannot overwrite the new one', async () => {
  let current = 'old';
  let releaseOld;
  const oldResponse = new Promise(resolve => { releaseOld = resolve; });
  const { providers, updates } = providerRuntime({
    getProviderLimitTarget: (appType, id) => ({
      appType, providerId: id, strategy: 'relay-quota',
      relayUrl: `https://${current}.lender.test/codex-proxy/${id}`,
      apiKey: `mcr1.abcdefghijklmnop.${current}-secret`,
    }),
  });
  const requests = [];
  const runtime = createProviderRelayModelCatalogRuntime({
    providers,
    syncIntervalMs: 60000,
    fetch: async url => {
      requests.push(url);
      if (url.startsWith('https://old.')) return oldResponse;
      return response({
        ok: true, appType: 'codex', preferredModel: 'new-model',
        models: ['new-model'], revision: 'new-revision',
      });
    },
    logger: { warn() {} },
  });

  const oldSync = runtime.syncProvider('codex', 'borrowed');
  current = 'new';
  const newSync = runtime.syncProvider('codex', 'borrowed');
  releaseOld(response({
    ok: true, appType: 'codex', preferredModel: 'old-model',
    models: ['old-model'], revision: 'old-revision',
  }));

  assert.equal((await oldSync).reason, 'relay_changed');
  assert.equal((await newSync).ok, true);
  assert.deepEqual(requests, [
    'https://old.lender.test/codex-proxy/borrowed/models',
    'https://new.lender.test/codex-proxy/borrowed/models',
  ]);
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].catalog.models, ['new-model']);

  current = 'third';
  await runtime.syncProvider('codex', 'borrowed');
  assert.equal(requests.length, 3, 'a changed target bypasses the previous successful TTL');
});

test('chunked remote catalogs are rejected as soon as they exceed the byte limit', async () => {
  const { providers, updates } = providerRuntime();
  const runtime = createProviderRelayModelCatalogRuntime({
    providers,
    fetch: async () => chunkedResponse([
      '{"ok":true,"appType":"codex","models":["',
      'x'.repeat(128 * 1024),
      '"]}',
    ]),
    logger: { warn() {} },
  });
  const result = await runtime.syncProvider('codex', 'borrowed');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'remote_response_too_large');
  assert.equal(updates.length, 0);
});

test('catalog application changes only model fields and preserves a still-valid local default', () => {
  const provider = {
    id: 'borrowed', appType: 'codex', name: 'MACPRO · 借道', source: 'local',
    settingsConfig: {
      auth: { OPENAI_API_KEY: 'relay-secret' },
      config: 'model_provider = "custom"\nmodel = "gpt-6-astra"\n[model_providers.custom]\nbase_url = "https://relay.test/codex-proxy/official"\nenv_key = "OPENAI_API_KEY"\nwire_api = "responses"\n',
      modelCatalog: { models: [{ model: 'gpt-6-astra' }, { model: 'gpt-5.5' }] },
    },
  };
  const updated = applyProviderRelayModelCatalog(provider, {
    preferredModel: 'gpt-6.1-sol',
    models: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol'],
    revision: 'new-revision',
  }, 1000);
  assert.equal(updated.changed, true);
  assert.equal(updated.model, 'gpt-6-astra', 'a still-served local default must not silently change');
  assert.equal(provider.settingsConfig.auth.OPENAI_API_KEY, 'relay-secret');
  assert.match(provider.settingsConfig.config, /base_url = "https:\/\/relay\.test\/codex-proxy\/official"/);
  assert.deepEqual(provider.settingsConfig.modelCatalog.models.map(item => item.model), [
    'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol',
  ]);
  assert.deepEqual(summarize(provider).modelOptions, [
    'gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol',
  ]);

  const unchanged = applyProviderRelayModelCatalog(provider, {
    preferredModel: 'gpt-6.1-sol',
    models: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol'],
    revision: 'new-revision',
  }, 2000);
  assert.equal(unchanged.changed, false, 'a newer sync timestamp is not a model-catalog change');

  provider.settingsConfig.config = provider.settingsConfig.config.replace('gpt-6-astra', 'gpt-5.5');
  const removed = applyProviderRelayModelCatalog(provider, {
    preferredModel: 'gpt-6.1-sol', models: ['gpt-6.1-sol', 'gpt-6-sol'], revision: 'next',
  }, 3000);
  assert.equal(removed.model, 'gpt-6.1-sol', 'removed defaults fall back to the lender preference');
});
