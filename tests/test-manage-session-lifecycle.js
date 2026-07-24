'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SOURCE_PATH = path.join(ROOT, 'public', 'manage-session-lifecycle.js');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function createHarness() {
  const apiCalls = [];
  const toasts = [];
  const prompts = [];
  let dashboardLoads = 0;
  const context = {
    console,
    Promise,
    Map,
    Object,
    String,
    Number,
    Date,
    encodeURIComponent,
    setTimeout,
    clearTimeout,
    Event: class Event { constructor(type) { this.type = type; } },
    CLAUDE_MODEL_OPTIONS: [],
    aliasTiersFromMap: () => [],
    formatAliasTierLabel: (tier) => tier,
    modelShortName: value => value,
    tt: key => key,
    _providerData: { providers: [] },
    _cachedSessions: [{ id: 'session/a b', label: 'before', provider: '', kind: 'chat', cli: 'claude' }],
    _cachedDirectories: [{ id: 'dir/a b', name: 'Fleet', rolePrompt: '' }],
    _expandedDirs: new Set(),
    showToast(message, isError) { toasts.push({ message, isError: !!isError }); },
    showPrompt: async () => prompts.shift(),
    loadDashboard: async () => { dashboardLoads += 1; },
    openSessionInline() {},
    document: {
      createElement() { throw new Error('DOM creation was not expected in this test'); },
      addEventListener() {},
      removeEventListener() {},
      body: { appendChild() {} },
    },
  };
  context.MultiCCApi = {
    async json(url, options) {
      apiCalls.push({ url, options });
      return {};
    },
    errorDisplay(error) {
      return {
        message: error && error.message || 'Request failed',
        status: error && error.status || 0,
        requestId: error && error.requestId || null,
      };
    },
  };
  context.MultiCCProviderCatalog = {
    findProvider() { return null; },
    normalizeCatalog(data) { return data; },
    groupByAppType() { return { claude: [], codex: [] }; },
    modelsFor() { return []; },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(SOURCE_PATH, 'utf8'), context, { filename: 'manage-session-lifecycle.js' });
  return {
    context,
    apiCalls,
    toasts,
    prompts,
    setApi(handler) { context.MultiCCApi.json = handler; },
    dashboardLoads() { return dashboardLoads; },
  };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

test('session lifecycle classic script loads before manage facade and stays within budget', () => {
  const html = read('public/manage.html');
  const api = html.indexOf('<script src="api-client.js"></script>');
  const catalog = html.indexOf('<script src="provider-catalog.js"></script>');
  const lifecycle = html.indexOf('<script src="manage-session-lifecycle.js"></script>');
  const page = html.indexOf('<script src="manage.js"></script>');
  assert.ok(api >= 0 && catalog > api && lifecycle > catalog && page > lifecycle);

  const facade = read('public/manage.js');
  const source = read('public/manage-session-lifecycle.js');
  assert.ok(facade.split(/\r?\n/).length < 5000, 'manage.js must stay below 5000 lines');
  assert.ok(source.split(/\r?\n/).length < 2000, 'lifecycle module must stay below 2000 lines');
  assert.doesNotMatch(facade, /function\s+(?:newSessionInDir|changeSessionModel|changeSessionRole|renameSession)\b/);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /tokenQS|[?&]token=/i);
  const innerHtmlWrites = source.split(/\r?\n/).filter(line => line.includes('.innerHTML'));
  assert.deepEqual(innerHtmlWrites.map(line => line.trim()), ["modelSelect.innerHTML = '';"]);
  assert.match(source, /opt\.textContent\s*=/);
  assert.match(source, /if \(cli === 'qoder'\) return QODER_MODEL_OPTIONS/);
  assert.match(source, /if \(cli === 'zcode'\) return ZCODE_MODEL_OPTIONS/);
  assert.match(source, /supportsManagedProvider\(cli\)/);
});

test('classic script exports every compatibility global used by inline handlers', () => {
  const { context } = createHarness();
  for (const name of [
    'newSessionInDir', 'changeSessionModel', 'changeSessionRole', 'changeDirectoryRole',
    'renameSession', 'showModelPicker', 'showRoleEditor', 'modelDisplayName',
  ]) {
    assert.equal(typeof context[name], 'function', `${name} should remain a window global`);
  }
});

test('session create payload preserves the legacy optional-field contract', () => {
  const { context } = createHarness();
  const body = context.buildSessionCreatePayload('codex', 'chat', {
    label: '  Reviewer  ',
    rolePrompt: '  Review only  ',
    provider: 'provider/one',
    model: 'gpt-5',
    effort: 'high',
  });
  assert.equal(JSON.stringify(body), JSON.stringify({
    cli: 'codex', kind: 'chat', label: 'Reviewer', model: 'gpt-5',
    provider: 'provider/one', effort: 'high', rolePrompt: 'Review only',
  }));
  const minimal = context.buildSessionCreatePayload('claude', 'terminal', {
    label: ' ', rolePrompt: '', provider: '', model: null, effort: '',
  });
  assert.equal(JSON.stringify(minimal), JSON.stringify({ cli: 'claude', kind: 'terminal' }));
});

test('latest session mutation owns UI effects when responses arrive out of order', async () => {
  const harness = createHarness();
  const pending = [];
  harness.setApi((url, options) => {
    const item = deferred();
    pending.push({ url, options, ...item });
    return item.promise;
  });
  harness.prompts.push('first', 'second');

  const first = harness.context.renameSession('session/a b');
  await settle();
  const second = harness.context.renameSession('session/a b');
  await settle();
  assert.equal(pending.length, 2);
  assert.equal(pending[0].url, '/api/sessions/session%2Fa%20b');
  assert.equal(JSON.stringify(pending[0].options), JSON.stringify({ method: 'PATCH', json: { label: 'first' } }));
  assert.equal(JSON.stringify(pending[1].options), JSON.stringify({ method: 'PATCH', json: { label: 'second' } }));

  pending[1].resolve({ ok: true });
  await second;
  pending[0].resolve({ ok: true });
  await first;

  assert.deepEqual(harness.toasts.map(item => item.message), ['Renamed to second']);
  assert.equal(harness.dashboardLoads(), 1);
});

test('different session fields retain independent response ownership', async () => {
  const harness = createHarness();
  const pending = [];
  harness.setApi((url, options) => {
    const item = deferred();
    pending.push({ url, options, ...item });
    return item.promise;
  });
  const lifecycle = harness.context.MultiCCManageSessionLifecycle;
  const model = lifecycle.ownedJson('session:s1:model', '/api/sessions/s1', {
    method: 'PATCH', json: { model: 'm1' },
  });
  const role = lifecycle.ownedJson('session:s1:role', '/api/sessions/s1', {
    method: 'PATCH', json: { rolePrompt: 'r1' },
  });
  pending[1].resolve({ rolePrompt: 'r1' });
  pending[0].resolve({ model: 'm1' });
  assert.equal((await role).owned, true);
  assert.equal((await model).owned, true);

  const source = read('public/manage-session-lifecycle.js');
  for (const suffix of ['model', 'role', 'label']) {
    assert.match(source, new RegExp('ownedJson\\(`session:\\$\\{id\\}:' + suffix + '`'));
  }
  assert.match(source, /ownedJson\(`directory:\$\{id\}:role`/);
});

test('owned 409 failures preserve safe status and request metadata', async () => {
  const harness = createHarness();
  harness.prompts.push('blocked');
  harness.setApi(async () => {
    const error = new Error('Session is active');
    error.status = 409;
    error.requestId = 'req-safe-1';
    throw error;
  });

  await harness.context.renameSession('session/a b');
  assert.equal(harness.toasts.length, 1);
  assert.equal(harness.toasts[0].isError, true);
  assert.match(harness.toasts[0].message, /Session is active/);
  assert.match(harness.toasts[0].message, /HTTP 409/);
  assert.match(harness.toasts[0].message, /request req-safe-1/);
  assert.equal(harness.dashboardLoads(), 0);
});

test('agent preset index coalesces concurrent reads through MultiCCApi', async () => {
  const harness = createHarness();
  const item = deferred();
  let calls = 0;
  harness.setApi((url) => {
    calls += 1;
    assert.equal(url, '/api/agent-presets');
    return item.promise;
  });
  const first = harness.context.fetchAgentPresetIndex();
  const second = harness.context.fetchAgentPresetIndex();
  assert.equal(calls, 1);
  item.resolve({ presets: [{ id: 'reviewer' }] });
  assert.equal(JSON.stringify(await first), JSON.stringify({ presets: [{ id: 'reviewer' }] }));
  assert.equal(JSON.stringify(await second), JSON.stringify({ presets: [{ id: 'reviewer' }] }));
  await harness.context.fetchAgentPresetIndex();
  assert.equal(calls, 1, 'resolved catalog should remain cached');
});

test('create dialog guards every late preset continuation after close', () => {
  const source = read('public/manage-session-lifecycle.js');
  assert.match(source, /fetchAgentPresetIndex\(\)\.then\(\(idx\) => \{\s*if \(closed\) return;/);
  assert.match(source, /const requestEpoch = \+\+presetRequestEpoch;/);
  assert.match(source, /if \(closed \|\| requestEpoch !== presetRequestEpoch\) return;/);
  assert.match(source, /closed = true;\s*presetRequestEpoch\+\+;\s*document\.removeEventListener/);
});
