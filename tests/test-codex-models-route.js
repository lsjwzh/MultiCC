'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const vm = require('node:vm');

const {
  createCodexModelsRuntime,
  discoverCodexModels,
  mountCodexModelRoutes,
  normalizeModels,
} = require('../src/routes/codex-models');

function model(id, displayName = id, extra = {}) {
  return { id, model: id, displayName, hidden: false, ...extra };
}

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function fakeAppServer(pages) {
  return () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let input = '';
    child.kill = () => true;
    child.stdin.on('data', chunk => {
      input += chunk.toString('utf8');
      let newline;
      while ((newline = input.indexOf('\n')) >= 0) {
        const line = input.slice(0, newline);
        input = input.slice(newline + 1);
        if (!line.trim()) continue;
        const request = JSON.parse(line);
        if (request.method === 'initialize') {
          child.stdout.write(`${JSON.stringify({
            id: request.id,
            result: { userAgent: 'codex_cli_rs/0.153.4 (test)' },
          })}\n`);
        } else if (request.method === 'model/list') {
          const page = pages.shift() || { data: [], nextCursor: null };
          child.stdout.write(`${JSON.stringify({ id: request.id, result: page })}\n`);
        }
      }
    });
    return child;
  };
}

test('Codex app-server model/list keeps display names separate from entitled wire ids', async () => {
  const result = await discoverCodexModels({
    codexBin: '/fake/codex',
    spawn: fakeAppServer([
      {
        data: [model('gpt-future', 'GPT Future'), model('hidden', 'Hidden', { hidden: true })],
        nextCursor: 'page-2',
      },
      { data: [model('gpt-next', 'GPT Next')], nextCursor: null },
    ]),
    timeoutMs: 1000,
  });
  assert.equal(result.cliVersion, '0.153.4');
  assert.deepEqual(result.models, [
    { model: 'gpt-future', label: 'GPT Future', isDefault: false },
    { model: 'gpt-next', label: 'GPT Next', isDefault: false },
  ]);
});

test('normalization rejects hidden, malformed and duplicate model rows', () => {
  assert.deepEqual(normalizeModels([
    model('gpt-ok', 'Friendly'),
    model('gpt-ok', 'Duplicate'),
    model('space is invalid'),
    model('gpt-hidden', 'Hidden', { hidden: true }),
  ]), [{ model: 'gpt-ok', label: 'Friendly', isDefault: false }]);
});

test('normalization accepts the Codex disk-cache slug/display_name shape', () => {
  assert.deepEqual(normalizeModels([
    { slug: 'gpt-cached', display_name: 'GPT Cached', visibility: 'list' },
  ]), [{ model: 'gpt-cached', label: 'GPT Cached', isDefault: false }]);
});

test('runtime caches briefly and force refresh surfaces a newly entitled model', async () => {
  let now = 1000;
  let calls = 0;
  const catalogs = [
    { models: [model('gpt-old', 'GPT Old')], cliVersion: '0.153.4' },
    { models: [model('gpt-new', 'GPT New')], cliVersion: '0.153.4' },
  ];
  const runtime = createCodexModelsRuntime({
    now: () => now,
    discover: async () => { calls += 1; return catalogs.shift(); },
    readDisk: () => ({ models: [], fetchedAt: 0, cliVersion: '' }),
  });
  const first = await runtime.list();
  assert.equal(first.source, 'cli');
  assert.deepEqual(first.models.map(entry => entry.model), ['gpt-old']);

  now += 500;
  const cached = await runtime.list();
  assert.equal(cached.source, 'memory_cache');
  assert.equal(calls, 1);

  const refreshed = await runtime.list({ forceRefresh: true });
  assert.equal(refreshed.source, 'cli');
  assert.deepEqual(refreshed.models.map(entry => entry.model), ['gpt-new']);
  assert.equal(calls, 2);
});

test('authoritative empty account catalog invalidates a previous entitlement', async () => {
  let calls = 0;
  const runtime = createCodexModelsRuntime({
    discover: async () => (++calls === 1
      ? { models: [model('gpt-old')], cliVersion: '0.153.4' }
      : { models: [], cliVersion: '0.153.4' }),
    readDisk: () => ({ models: [model('gpt-old')], fetchedAt: Date.now(), cliVersion: '0.153.4' }),
  });
  await runtime.list();
  const revoked = await runtime.list({ forceRefresh: true });
  assert.equal(revoked.available, false);
  assert.equal(revoked.diagnostic.code, 'account_no_models');
  assert.deepEqual(revoked.models, []);
  assert.deepEqual((await runtime.list()).models, []);
});

test('live failure uses only a recent account cache and rejects an expired one', async () => {
  let now = 20 * 60 * 1000;
  const recent = createCodexModelsRuntime({
    now: () => now,
    discover: async () => { throw failure('cli_timeout'); },
    readDisk: () => ({ models: [model('gpt-recent')], fetchedAt: now - 1000, cliVersion: '0.151.0' }),
  });
  const fallback = await recent.list();
  assert.equal(fallback.source, 'disk_cache');
  assert.deepEqual(fallback.models.map(entry => entry.model), ['gpt-recent']);
  assert.equal(fallback.cliVersion, '0.151.0');

  const expired = createCodexModelsRuntime({
    now: () => now,
    staleMaxMs: 10 * 60 * 1000,
    discover: async () => { throw failure('cli_timeout'); },
    readDisk: () => ({ models: [model('gpt-expired')], fetchedAt: 1, cliVersion: '0.120.0' }),
  });
  const unavailable = await expired.list();
  assert.equal(unavailable.source, 'fallback');
  assert.equal(unavailable.fallback, 'codex_default');
  assert.deepEqual(unavailable.models, []);
});

test('login failure never exposes a previous account disk catalog', async () => {
  const runtime = createCodexModelsRuntime({
    discover: async () => { throw failure('login_required'); },
    readDisk: () => ({ models: [model('gpt-other-account')], fetchedAt: Date.now(), cliVersion: '0.153.4' }),
  });
  const result = await runtime.list();
  assert.equal(result.available, false);
  assert.equal(result.diagnostic.code, 'login_required');
  assert.deepEqual(result.models, []);
});

test('route supports explicit refresh without exposing process diagnostics', async () => {
  const calls = [];
  const runtime = {
    async list(options) {
      calls.push(options);
      return {
        models: [{ model: 'gpt-future', label: 'GPT Future', isDefault: true }],
        source: 'cli', cached: false, stale: false, available: true,
        fetchedAt: 123, cliVersion: '0.153.4',
        diagnostic: { code: 'ok', message: 'verified' }, fallback: 'codex_default',
      };
    },
  };
  const routes = new Map();
  mountCodexModelRoutes({ get: (route, handler) => routes.set(route, handler) }, runtime);
  const handler = routes.get('/api/codex/models');
  let body;
  await handler({ query: { refresh: '1' } }, { json(value) { body = value; } });
  assert.deepEqual(calls, [{ forceRefresh: true }]);
  assert.equal(body.models[0].model, 'gpt-future');
  assert.equal(JSON.stringify(body).includes('token'), false);
});

test('Web picker keeps only a short memory catalog and explicit refresh replaces it', async () => {
  const responses = [
    { available: true, source: 'cli', models: [{ model: 'gpt-old', label: 'GPT Old' }] },
    { available: true, source: 'cli', models: [{ model: 'gpt-new', label: 'GPT New' }] },
  ];
  const calls = [];
  const context = {
    Date, Promise, String, Set,
    tt: value => value,
    window: {
      localStorage: {
        getItem() { throw new Error('Codex must not read localStorage'); },
        setItem() { throw new Error('Codex must not write localStorage'); },
      },
      async fetch(url) {
        calls.push(url);
        const body = responses.shift();
        return { ok: true, async json() { return body; } };
      },
    },
  };
  context.window.window = context.window;
  context.window.Date = Date;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'shared', 'models.js'), 'utf8'), context);

  const first = await context.window.loadCodexModels();
  assert.deepEqual(JSON.parse(JSON.stringify(first.models)), [
    { model: 'gpt-old', label: 'GPT Old', isDefault: false },
  ]);
  await context.window.loadCodexModels();
  assert.equal(calls.length, 1, 'warm one-minute memory cache should coalesce picker reads');
  const refreshed = await context.window.loadCodexModels({ forceRefresh: true });
  assert.deepEqual(JSON.parse(JSON.stringify(refreshed.models)), [
    { model: 'gpt-new', label: 'GPT New', isDefault: false },
  ]);
  assert.deepEqual(calls, ['/api/codex/models', '/api/codex/models?refresh=1']);
  assert.equal(context.window.codexModelLabel('gpt-new'), 'GPT New');
});

test('Web and App consume the same endpoint and contain no production Astra guess', () => {
  const files = [
    'public/shared/models.js',
    'public/manage-session-lifecycle.js',
    'app/lib/services/codex_models_service.dart',
    'app/lib/widgets/create_session_dialog.dart',
    'app/lib/widgets/ai_config_sheet.dart',
  ];
  const sources = files.map(file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));
  assert.match(sources[0], /\/api\/codex\/models/);
  assert.match(sources[2], /\/api\/codex\/models/);
  assert.match(sources[1], /forceRefresh: true/);
  assert.match(sources[2], /forceRefresh/);
  for (let index = 0; index < sources.length; index += 1) {
    assert.equal(sources[index].includes('gpt-6-astra'), false, files[index]);
  }
  const manage = fs.readFileSync(path.join(__dirname, '..', 'public', 'manage.js'), 'utf8');
  assert.match(manage, /key: 'codex-official'[^\n]+model: '', models: ''/);
});
