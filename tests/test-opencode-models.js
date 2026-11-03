'use strict';

// GET /api/opencode/models — the configured providers lead the list, but they
// must not hide OpenCode's own preset providers. A user who configured the
// OpenCode Go plan (`opencodego`) in opencode.json used to lose every
// `opencode/*` (OpenCode Zen) model from the picker, because the config file
// short-circuited the CLI listing entirely.
//
// OpenAI-compatible providers also publish their catalog at `{baseURL}/models`;
// those lists are fetched on every cache miss / ?refresh=1 so upstream renames
// (deepseek-v4-flash → deepseek-v4.1-flash) stop freezing the picker. Failures
// keep the static config list (fail-open). The same cache powers
// validateOpenCodeModel(), which refuses a vanished model before spawn.

const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// readOpenCodeConfigProviders()/readOpenCodeJsonFallback() resolve the config
// through os.homedir(), which follows $HOME on every call — point it at a
// throwaway HOME so the suite never reads the developer's real opencode.json.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-models-'));
process.env.HOME = tmpHome;
after(() => fs.rmSync(tmpHome, { recursive: true, force: true }));

const modelsRoute = require('../src/routes/opencode-models.js');
const {
  mergeOpenCodeModels,
  parseOpenCodeStdout,
  listOpenCodeModels,
  validateOpenCodeModel,
  readOpenCodeConfigProviders,
  _setCacheForTest,
  _resetCacheForTest,
} = modelsRoute;
const { createOpencodeAdapter } = require('../src/cli-adapters/opencode.js');

const CLI = parseOpenCodeStdout([
  'opencode/big-pickle',
  'opencode/nemotron-3-ultra-free',
  'opencodego/glm-5.2',
  'opencodego/some-cli-only-model',
  'openrouter/~anthropic/claude-sonnet-latest',
  'deepseek/deepseek-chat',
].join('\n'));
const CONFIGURED = [{ provider: 'opencodego', model: 'glm-5.2', label: 'opencodego/glm-5.2 (GLM 5.2)' }];

test('OpenCode Zen presets are merged after the configured providers', () => {
  const labels = mergeOpenCodeModels(CONFIGURED, CLI).map(m => `${m.provider}/${m.model}`);
  assert.deepEqual(labels, ['opencodego/glm-5.2', 'opencode/big-pickle', 'opencode/nemotron-3-ultra-free']);
});

test('providers signed in through `opencode auth login` are kept too', () => {
  const labels = mergeOpenCodeModels(CONFIGURED, CLI, new Set(['deepseek'])).map(m => `${m.provider}/${m.model}`);
  assert.ok(labels.includes('deepseek/deepseek-chat'));
  assert.ok(!labels.some(label => label.startsWith('openrouter/')), 'unselected catalog providers stay out');
});

test('a configured provider keeps only its configured models', () => {
  const labels = mergeOpenCodeModels(CONFIGURED, CLI).map(m => `${m.provider}/${m.model}`);
  assert.ok(!labels.includes('opencodego/some-cli-only-model'));
});

test('without configured providers the full CLI listing is used', () => {
  assert.equal(mergeOpenCodeModels([], CLI).length, CLI.length);
});

test('merged Zen presets are labelled so the picker shows where they come from', () => {
  const zen = mergeOpenCodeModels(CONFIGURED, CLI).find(m => m.model === 'big-pickle');
  assert.equal(zen.label, 'opencode/big-pickle (OpenCode Zen)');
});

// ── Dynamic gateway lists ──────────────────────────────────────────────────

const CONFIG_DIR = path.join(tmpHome, '.config', 'opencode');

function writeConfig(providers) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(path.join(CONFIG_DIR, 'opencode.json'), JSON.stringify({ provider: providers }), 'utf8');
}

function clearConfig() {
  fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
}

const GO_CONFIG = {
  opencodego: {
    name: 'OpenCode Go',
    npm: '@ai-sdk/openai-compatible',
    options: { baseURL: 'https://gateway.example.test/v1', apiKey: 'test-key' },
    models: {
      'deepseek-v4-flash': { name: 'DeepSeek V4 Flash' },
      'glm-5.2': { name: 'GLM 5.2' },
    },
  },
};

const GO_LIVE = {
  object: 'list',
  data: [
    { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
    { id: 'glm-5.2', name: 'GLM 5.2' },
    { id: 'kimi-k2-thinking', name: 'Kimi K2 Thinking' },
  ],
};

const noCli = (cb) => setImmediate(() => cb(new Error('opencode models unavailable'), []));

function listWith(opts) {
  return new Promise((resolve) => {
    listOpenCodeModels((err, models, source) => resolve({ err, models, source }), opts);
  });
}

function okJson(payload) {
  return { ok: true, status: 200, json: async () => payload };
}

function recordingFetch(handler) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, headers: init.headers || {} });
    return handler(url, init, calls.length);
  };
  impl.calls = calls;
  return impl;
}

test('dynamic list replaces the static config whitelist for a baseURL provider', async () => {
  clearConfig();
  writeConfig(GO_CONFIG);
  _resetCacheForTest();
  const fetchImpl = recordingFetch(() => okJson(GO_LIVE));
  const { err, models, source } = await listWith({ refresh: true, fetchImpl, cliLister: noCli });
  assert.equal(err, null);
  assert.equal(source, 'config');
  const keys = models.map(m => `${m.provider}/${m.model}`);
  assert.deepEqual(keys, [
    'opencodego/deepseek-v4.1-flash',
    'opencodego/glm-5.2',
    'opencodego/kimi-k2-thinking',
  ]);
  assert.ok(!keys.includes('opencodego/deepseek-v4-flash'), 'the renamed-away id is gone');
  const live = models.find(m => m.model === 'deepseek-v4.1-flash');
  assert.equal(live.label, 'opencodego/deepseek-v4.1-flash (DeepSeek V4.1 Flash)');
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, 'https://gateway.example.test/v1/models');
  assert.equal(fetchImpl.calls[0].headers.authorization, 'Bearer test-key');
});

test('gateway failure falls back to the static config list (fail-open)', async () => {
  clearConfig();
  writeConfig(GO_CONFIG);
  _resetCacheForTest();
  const failingFetch = recordingFetch(() => { throw new Error('gateway down'); });
  const { err, models } = await listWith({ refresh: true, fetchImpl: failingFetch, cliLister: noCli });
  assert.equal(err, null);
  const keys = models.map(m => `${m.provider}/${m.model}`);
  assert.deepEqual(keys, ['opencodego/deepseek-v4-flash', 'opencodego/glm-5.2']);

  _resetCacheForTest();
  const http500 = recordingFetch(() => ({ ok: false, status: 500, json: async () => ({}) }));
  const second = await listWith({ refresh: true, fetchImpl: http500, cliLister: noCli });
  assert.equal(second.err, null);
  assert.deepEqual(second.models.map(m => `${m.provider}/${m.model}`),
    ['opencodego/deepseek-v4-flash', 'opencodego/glm-5.2']);
});

test('refresh=1 refetches, plain calls use the cache', async () => {
  clearConfig();
  writeConfig(GO_CONFIG);
  _resetCacheForTest();
  const firstFetch = recordingFetch(() => okJson({ data: [{ id: 'deepseek-v4.1-flash', name: 'V4.1' }] }));
  const first = await listWith({ refresh: true, fetchImpl: firstFetch, cliLister: noCli });
  assert.deepEqual(first.models.map(m => m.model), ['deepseek-v4.1-flash']);

  const secondFetch = recordingFetch(() => okJson({ data: [{ id: 'deepseek-v4.2-flash', name: 'V4.2' }] }));
  const second = await listWith({ refresh: true, fetchImpl: secondFetch, cliLister: noCli });
  assert.equal(secondFetch.calls.length, 1, 'refresh re-polls the gateway');
  assert.deepEqual(second.models.map(m => m.model), ['deepseek-v4.2-flash']);

  const cached = await listWith({ refresh: false, fetchImpl: secondFetch, cliLister: noCli });
  assert.equal(cached.source, 'cache');
  assert.equal(secondFetch.calls.length, 1, 'a warm cache never fetches again');
  assert.deepEqual(cached.models.map(m => m.model), ['deepseek-v4.2-flash']);
});

test('a 401 response is retried once without credentials', async () => {
  clearConfig();
  writeConfig({
    opencodego: {
      options: { baseURL: 'https://gateway.example.test/v1', apiKey: '{env:OPENCODE_TEST_KEY}' },
      models: {},
    },
  });
  process.env.OPENCODE_TEST_KEY = 'expired-key';
  _resetCacheForTest();
  const fetchImpl = recordingFetch((url, init, call) => (
    call === 1
      ? { ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) }
      : okJson({ data: [{ id: 'kimi-k2-thinking', name: 'Kimi K2 Thinking' }] })
  ));
  const { err, models } = await listWith({ refresh: true, fetchImpl, cliLister: noCli });
  delete process.env.OPENCODE_TEST_KEY;
  assert.equal(err, null);
  assert.equal(fetchImpl.calls.length, 2, 'one authenticated attempt plus one anonymous retry');
  assert.equal(fetchImpl.calls[0].headers.authorization, 'Bearer expired-key');
  assert.equal(fetchImpl.calls[1].headers.authorization, undefined);
  assert.deepEqual(models.map(m => m.model), ['kimi-k2-thinking']);
});

test('readOpenCodeConfigProviders keeps options the flattened fallback drops', () => {
  clearConfig();
  writeConfig(GO_CONFIG);
  const providers = readOpenCodeConfigProviders();
  assert.equal(providers.opencodego.options.baseURL, 'https://gateway.example.test/v1');
  clearConfig();
});

// ── validateOpenCodeModel ──────────────────────────────────────────────────

const LIVE_CACHE = [
  { provider: 'opencodego', model: 'deepseek-v4.1-flash', label: 'opencodego/deepseek-v4.1-flash (DeepSeek V4.1 Flash)' },
  { provider: 'opencodego', model: 'glm-5.2', label: 'opencodego/glm-5.2 (GLM 5.2)' },
  { provider: 'opencode', model: 'big-pickle', label: 'opencode/big-pickle (OpenCode Zen)' },
];

test('validateOpenCodeModel accepts a model present in the cache', () => {
  _setCacheForTest(Date.now(), LIVE_CACHE);
  assert.equal(validateOpenCodeModel('opencodego/deepseek-v4.1-flash'), null);
});

test('validateOpenCodeModel is fail-open on a cold cache', () => {
  _resetCacheForTest();
  assert.equal(validateOpenCodeModel('opencodego/deepseek-v4-flash'), null);
});

test('validateOpenCodeModel suggests the renamed id for a retired model', () => {
  _setCacheForTest(Date.now(), LIVE_CACHE);
  const verdict = validateOpenCodeModel('opencodego/deepseek-v4-flash');
  assert.deepEqual(verdict, { valid: false, suggestion: 'opencodego/deepseek-v4.1-flash' });
});

test('validateOpenCodeModel does not invent a suggestion for unrelated ids', () => {
  _setCacheForTest(Date.now(), LIVE_CACHE);
  const verdict = validateOpenCodeModel('opencodego/totally-unrelated-model-xyz');
  assert.deepEqual(verdict, { valid: false, suggestion: null });
});

test('validateOpenCodeModel leaves unknown providers and bare ids alone', () => {
  _setCacheForTest(Date.now(), LIVE_CACHE);
  assert.equal(validateOpenCodeModel('managed-route/glm-9'), null, 'provider not in this list');
  assert.equal(validateOpenCodeModel('glm-5.2'), null, 'unqualified ids belong to managed routes');
});

// ── spawn-time guard (adapter mount point) ─────────────────────────────────

function envelopeFor(rawModel) {
  return {
    spawnOpts: { rawModel, rawEffort: null, rawAgent: null },
    historyHandle: { isFirstTurn: true, cliSessionId: null },
    contextLayers: [], userText: 'hello', suffix: '', rolePrompt: '',
  };
}

function runBlockedInvocation(invocation) {
  const stdout = execFileSync(process.execPath, [...invocation.args, invocation.payload], {
    encoding: 'utf8', timeout: 5000,
  });
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1, 'exactly one adapter event is emitted');
  return JSON.parse(lines[0]);
}

test('ACP lane refuses a retired model before spawning the agent', () => {
  _setCacheForTest(Date.now(), LIVE_CACHE);
  const adapter = createOpencodeAdapter({ cmd: 'opencode', env: {} });
  const invocation = adapter.buildInvocation(envelopeFor('opencodego/deepseek-v4-flash'));
  assert.equal(invocation.cmd, process.execPath);
  assert.equal(invocation.args[0], '-e', 'a throwaway node process, not opencode acp');
  assert.equal(invocation.payload, '');

  const raw = runBlockedInvocation(invocation);
  const decoded = adapter.decodeEvent(raw);
  assert.equal(decoded.length, 1, 'the user sees one error, not a retry loop');
  const [event] = decoded;
  assert.equal(event.type, 'error');
  assert.equal(event.kind, 'provider');
  assert.equal(event.error.category, 'invalid_request_model', 'non-retryable category');
  assert.equal(event.error.code, 'invalid_request_model');
  assert.match(event.message, /模型 opencodego\/deepseek-v4-flash 已不在可用列表中（可能已下架或改名）。建议改用 opencodego\/deepseek-v4\.1-flash。/);

  const tracker = adapter.createCompletionTracker();
  tracker.observe(raw, decoded);
  tracker.finish({ kind: 'process', code: 0 });
  assert.equal(tracker.snapshot().state, 'failed');

  // The structured category is what keeps the turn from being retried: an
  // unclassified ("unknown") error is retryable and would loop every ~20s.
  const { normalizeApiError } = require('../src/chat/api-error-policy.js');
  const classified = normalizeApiError(event.error, {
    source: 'opencode_event', provider: 'opencode', phase: 'before_first_token',
  });
  assert.equal(classified.category, 'invalid_request_model');
  assert.equal(classified.retryable, false);
});

test('ACP lane lets a live model spawn normally', () => {
  _setCacheForTest(Date.now(), LIVE_CACHE);
  const adapter = createOpencodeAdapter({ cmd: 'opencode', env: {} });
  const invocation = adapter.buildInvocation(envelopeFor('opencodego/deepseek-v4.1-flash'));
  assert.equal(invocation.cmd, process.execPath);
  assert.ok(String(invocation.args[0]).endsWith('acp-bridge.cjs'), 'the real ACP bridge is used');
  assert.equal(invocation.payload, 'hello');
});

test('cold cache never blocks a spawn', () => {
  _resetCacheForTest();
  const adapter = createOpencodeAdapter({ cmd: 'opencode', env: {} });
  const invocation = adapter.buildInvocation(envelopeFor('opencodego/deepseek-v4-flash'));
  assert.ok(String(invocation.args[0]).endsWith('acp-bridge.cjs'));
});

test('legacy JSON lane refuses a retired model through its own error shape', () => {
  _setCacheForTest(Date.now(), LIVE_CACHE);
  const adapter = createOpencodeAdapter({ cmd: 'opencode', env: { MULTICC_OPENCODE_LEGACY_JSON: '1' } });
  const invocation = adapter.buildInvocation(envelopeFor('opencodego/deepseek-v4-flash'));
  assert.equal(invocation.args[0], '-e');
  const raw = runBlockedInvocation(invocation);
  const decoded = adapter.decodeEvent(raw);
  assert.equal(decoded.length, 1);
  assert.equal(decoded[0].type, 'error');
  assert.equal(decoded[0].error.category, 'invalid_request_model');
  assert.match(decoded[0].message, /建议改用 opencodego\/deepseek-v4\.1-flash/);

  const live = createOpencodeAdapter({ cmd: 'opencode', env: { MULTICC_OPENCODE_LEGACY_JSON: '1' } })
    .buildInvocation(envelopeFor('opencodego/deepseek-v4.1-flash'));
  assert.equal(live.cmd, 'opencode', 'a live model still spawns the real CLI');
});
