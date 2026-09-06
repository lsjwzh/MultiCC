'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');

const {
  summarize,
  readCodexOfficialModels,
  CODEX_OFFICIAL_MODELS_FALLBACK,
  modelValidForProvider,
} = require('../src/providers');

// A cache shaped exactly like ~/.codex/models_cache.json (codex client 0.144.x).
function writeCache(dir, models) {
  const file = path.join(dir, 'models_cache.json');
  fs.writeFileSync(file, JSON.stringify({
    fetched_at: '2026-07-20T12:05:34.533030Z',
    etag: 'test-etag',
    client_version: '0.144.6',
    models,
  }));
  return file;
}

const CACHE_MODELS = [
  { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', visibility: 'list', supported_in_api: true, priority: 1 },
  { slug: 'gpt-5.6-terra', display_name: 'GPT-5.6-Terra', visibility: 'list', supported_in_api: true, priority: 2 },
  { slug: 'gpt-5.6-luna', display_name: 'GPT-5.6-Luna', visibility: 'list', supported_in_api: true, priority: 3 },
  { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', supported_in_api: true, priority: 7 },
  { slug: 'gpt-5.4', display_name: 'GPT-5.4', visibility: 'hide', supported_in_api: true, priority: 16 },
  { slug: 'gpt-5.4-mini', display_name: 'GPT-5.4-Mini', visibility: 'hide', supported_in_api: true, priority: 23 },
  { slug: 'gpt-5.3-codex-spark', display_name: 'GPT-5.3-Codex-Spark', visibility: 'list', supported_in_api: false, priority: 26 },
];

const VISIBLE = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.3-codex-spark'];

test('readCodexOfficialModels surfaces visibility=list slugs in priority order, hiding the rest', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-models-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = writeCache(dir, CACHE_MODELS);
  assert.deepEqual(readCodexOfficialModels(file), VISIBLE);
});

test('readCodexOfficialModels falls back to no concrete id when entitlement cache is unavailable', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-models-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  assert.deepEqual(readCodexOfficialModels(path.join(dir, 'does-not-exist.json')), [...CODEX_OFFICIAL_MODELS_FALLBACK]);
  const broken = path.join(dir, 'broken.json');
  fs.writeFileSync(broken, '{ not valid json');
  assert.deepEqual(readCodexOfficialModels(broken), [...CODEX_OFFICIAL_MODELS_FALLBACK]);
  // Cache present but models array empty/absent -> also fall back.
  const empty = path.join(dir, 'empty.json');
  fs.writeFileSync(empty, JSON.stringify({ fetched_at: 'x', models: [] }));
  assert.deepEqual(readCodexOfficialModels(empty), [...CODEX_OFFICIAL_MODELS_FALLBACK]);
  assert.deepEqual(CODEX_OFFICIAL_MODELS_FALLBACK, [],
    'the safe fallback leaves model unset so Codex picks an entitled default');
});

test('summarize fills the Official codex provider modelOptions from the cache and never overrides a custom provider', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-models-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const cache = writeCache(dir, CACHE_MODELS);

  const official = summarize({
    id: 'official', appType: 'codex', source: 'ccswitch', name: 'OpenAI Official',
    settingsConfig: { auth: { auth_mode: 'chatgpt' } },
  }, { codexCachePath: cache });
  assert.equal(official.isOfficial, true);
  assert.deepEqual(official.modelOptions, VISIBLE);
  // baseUrl must stay empty (that's what makes it Official) and no model claimed.
  assert.equal(official.baseUrl, '');
  assert.equal(official.model, '');

  // An old static official-provider catalog is overridden, while its saved
  // current/unknown model string remains intact for the Custom field.
  const oldOfficial = summarize({
    id: 'old-official', appType: 'codex', source: 'local', name: 'OpenAI Official',
    settingsConfig: {
      auth: { auth_mode: 'chatgpt' },
      config: 'model = "gpt-user-saved"\n',
      modelCatalog: { models: [{ model: 'gpt-stale-hardcoded' }] },
    },
  }, { codexCachePath: cache });
  assert.equal(oldOfficial.model, 'gpt-user-saved');
  assert.deepEqual(oldOfficial.modelOptions, VISIBLE);

  // A custom relay that declares its own model is never overridden.
  const custom = summarize({
    id: 'my-codex', appType: 'codex', source: 'local', name: 'My Codex',
    settingsConfig: {
      auth: { OPENAI_API_KEY: 'sk-test' },
      config: 'model_provider = "custom"\nmodel = "astron-x"\n[model_providers.custom]\nname = "custom"\nbase_url = "https://relay.test/v1"\nwire_api = "responses"\n',
    },
  }, { codexCachePath: cache });
  assert.equal(custom.isOfficial, false);
  assert.deepEqual(custom.modelOptions, ['astron-x']);
});

test('modelValidForProvider stays lenient for Official codex (no false rejection from the curated list) but strict for custom codex', () => {
  const officialSummary = { isOfficial: true, modelOptions: VISIBLE };
  // A hidden-but-valid OpenAI tier (gpt-5.4) must NOT be rejected now that the
  // picker list is non-empty — the ChatGPT login can still serve it.
  assert.equal(modelValidForProvider('codex', 'official', 'gpt-5.4', officialSummary), true);
  assert.equal(modelValidForProvider('codex', 'official', 'gpt-5.6-sol', officialSummary), true);
  assert.equal(modelValidForProvider('codex', 'official', 'gpt-5.3-codex-spark', officialSummary), true);

  // A custom codex provider with a declared model stays restricted to what it serves.
  const customSummary = { isOfficial: false, modelOptions: ['astron-x'] };
  assert.equal(modelValidForProvider('codex', 'my-codex', 'astron-x', customSummary), true);
  assert.equal(modelValidForProvider('codex', 'my-codex', 'gpt-99', customSummary), false);

  // Falsy/empty model short-circuit still holds.
  assert.equal(modelValidForProvider('codex', 'official', '', officialSummary), true);
  assert.equal(modelValidForProvider('codex', 'official', undefined, officialSummary), true);
});
