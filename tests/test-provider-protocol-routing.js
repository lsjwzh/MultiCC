'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-provider-protocol-'));
const dataDir = path.join(root, 'data');
const fakeHome = path.join(root, 'home');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.join(fakeHome, '.cc-switch'), { recursive: true });
process.env.MULTICC_DATA_DIR = dataDir;
process.env.HOME = fakeHome;

const ccDb = path.join(fakeHome, '.cc-switch', 'cc-switch.db');
const db = new Database(ccDb);
db.exec(`CREATE TABLE providers (
  id TEXT PRIMARY KEY,
  app_type TEXT NOT NULL,
  name TEXT NOT NULL,
  settings_config TEXT NOT NULL,
  sort_index INTEGER NOT NULL DEFAULT 0,
  meta TEXT
)`);
const insert = db.prepare('INSERT INTO providers (id, app_type, name, settings_config, sort_index, meta) VALUES (?, ?, ?, ?, ?, ?)');
insert.run(
  'cc-chat', 'codex', 'CC Chat',
  JSON.stringify({ auth: { OPENAI_API_KEY: 'chat-secret' }, config: 'model = "chat-model"\nbase_url = "https://chat.example/v1"\nwire_api = "responses"\n' }),
  1, JSON.stringify({ apiFormat: 'openai_chat' }),
);
insert.run(
  'cc-anthropic', 'claude', 'CC Anthropic',
  JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://anthropic.example', ANTHROPIC_AUTH_TOKEN: 'anthropic-secret', ANTHROPIC_MODEL: 'claude-test' } }),
  2, JSON.stringify({ apiFormat: 'anthropic' }),
);
db.close();

const providers = require('../src/providers/core');

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('CC-Switch import treats meta.apiFormat as the protocol source of truth', () => {
  const result = providers.importFromCcSwitch();
  assert.equal(result.imported, 2);

  // Legacy 'openai_chat' meta collapses into the responses pool: every
  // mainstream provider now speaks /responses natively, so the retired
  // chat-conversion bridge never reappears on re-import.
  const chat = providers.getProviderSummary('codex', 'cc-chat');
  assert.equal(chat.apiFormat, 'openai_responses');
  assert.equal(chat.wireApi, 'responses');
  assert.deepEqual(chat.compatibleClis, ['codex', 'codex-exp', 'opencode', 'zcode', 'kimi', 'grok']);
  assert.equal(chat.requiresConversionFor, undefined);

  const anthropic = providers.getProviderSummary('claude', 'cc-anthropic');
  assert.equal(anthropic.apiFormat, 'anthropic');
  assert.deepEqual(anthropic.compatibleClis, ['claude', 'claude-exp', 'opencode', 'zcode', 'dsh', 'grok']);
});

test('startup migration upgrades old provider records once and is byte-idempotent', () => {
  const storeFile = path.join(dataDir, 'providers.json');
  const legacy = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  for (const provider of legacy) delete provider.apiFormat;
  const chat = legacy.find(provider => provider.id === 'cc-chat');
  chat.settingsConfig = {
    auth: { OPENAI_API_KEY: 'chat-secret' },
    config: 'model = "chat-model"\nbase_url = "https://chat.example/v1"\nwire_api = "responses"\n',
  };
  fs.writeFileSync(storeFile, JSON.stringify(legacy, null, 2), { mode: 0o600 });

  const first = providers.migrateLegacyProviderProtocols();
  assert.deepEqual(first, { updated: 2, skipped: 0, total: 2 });
  const migratedBytes = fs.readFileSync(storeFile, 'utf8');
  const migrated = JSON.parse(migratedBytes);
  const migratedChat = migrated.find(provider => provider.id === 'cc-chat');
  assert.equal(migratedChat.apiFormat, 'openai_responses');
  assert.equal(migratedChat.settingsConfig.proxyTarget, undefined);
  assert.match(migratedChat.settingsConfig.config, /base_url\s*=\s*"https:\/\/chat\.example\/v1"/);
  assert.match(migratedChat.settingsConfig.config, /wire_api\s*=\s*"responses"/);
  assert.equal(migrated.find(provider => provider.id === 'cc-anthropic').apiFormat, 'anthropic');

  assert.deepEqual(providers.migrateLegacyProviderProtocols(), { updated: 0, skipped: 0, total: 2 });
  assert.equal(fs.readFileSync(storeFile, 'utf8'), migratedBytes);
});

test('Codex materializes the provider as direct responses with no conversion bridge', () => {
  const spawn = providers.resolveSpawnEnv({ cli: 'codex', provider: 'cc-chat', model: 'chat-model' });
  assert.ok(spawn.codexHome.startsWith(fakeHome));
  const config = fs.readFileSync(path.join(spawn.codexHome, 'config.toml'), 'utf8');
  assert.match(config, /wire_api\s*=\s*"responses"/);
  assert.match(config, /base_url\s*=\s*"https:\/\/chat\.example\/v1"/);
  assert.doesNotMatch(config, /codex-proxy/);
  const raw = providers.getProvider('codex', 'cc-chat');
  assert.equal(raw.settingsConfig.proxyTarget, undefined);
});

test('OpenCode maps all protocols to their native AI SDK packages', () => {
  const responsesId = providers.createProvider({
    appType: 'codex', name: 'Responses', baseUrl: 'https://responses.example/v1',
    authToken: 'responses-secret', model: 'gpt-test', apiFormat: 'openai_responses',
  }).id;

  const cases = [
    ['cc-anthropic', '@ai-sdk/anthropic', 'claude-test'],
    // Legacy chat providers ride the plain OpenAI package now that the
    // chat-conversion bridge is retired.
    ['cc-chat', '@ai-sdk/openai', 'chat-model'],
    [responsesId, '@ai-sdk/openai', 'gpt-test'],
  ];
  for (const [providerId, expectedPackage, model] of cases) {
    const spawn = providers.resolveSpawnEnv({ cli: 'opencode', provider: providerId, model });
    const config = JSON.parse(spawn.env.OPENCODE_CONFIG_CONTENT);
    const routeId = config.enabled_providers[0];
    assert.equal(config.provider[routeId].npm, expectedPackage);
    assert.equal(spawn.qualifiedModel, `${routeId}/${model}`);
    assert.equal(providers.providerSupportsCli(providers.getProviderSummary(undefined, providerId), 'opencode'), true);
  }
});

test('OpenCode custom-provider models carry real limits (models.dev cache, safe fallback)', () => {
  const cacheDir = path.join(fakeHome, '.cache', 'opencode');
  fs.mkdirSync(cacheDir, { recursive: true });
  // Fixture mirrors the models.dev cache shape. Two providers expose the same
  // model id with different context sizes — the smaller must win (conservative).
  fs.writeFileSync(path.join(cacheDir, 'models.json'), JSON.stringify({
    'deepseek': { models: { 'deepseek-v4-flash': { limit: { context: 1000000, output: 384000 } } } },
    'other-relay': { models: { 'deepseek-v4-flash': { limit: { context: 512000, output: 16000 } } } },
    'gpt-host': { models: { 'gpt-test': { limit: { context: 200000, output: 32000 } } } },
  }));

  const spawn = providers.resolveSpawnEnv({ cli: 'opencode', provider: 'cc-chat', model: 'deepseek-v4-flash' });
  const config = JSON.parse(spawn.env.OPENCODE_CONFIG_CONTENT);
  const routeId = config.enabled_providers[0];
  const models = config.provider[routeId].models;
  // Catalogued model: exact conservative limits reach the generated config, so
  // OpenCode's auto-compaction has a real window to work with.
  assert.deepEqual(models['deepseek-v4-flash'].limit, { context: 512000, output: 16000 });
  // Unknown model: understated fallback, never a fabricated capability.
  assert.deepEqual(models['chat-model'].limit, { context: 128000, output: 8192 });
  // Model entries carry exactly {name, limit} — no credential material.
  assert.deepEqual(Object.keys(models['chat-model']).sort(), ['limit', 'name']);
  assert.equal(JSON.stringify(models).includes('chat-secret'), false);
});

test('ZCode maps all protocols to isolated native provider kinds', () => {
  const responsesId = providers.createProvider({
    appType: 'codex', name: 'ZCode Responses', baseUrl: 'https://responses-zcode.example/v1',
    authToken: 'zcode-responses-secret', model: 'gpt-zcode', apiFormat: 'openai_responses',
  }).id;
  const anthropicApiKeyId = providers.createProvider({
    appType: 'claude',
    name: 'ZCode Anthropic API Key',
    apiFormat: 'anthropic',
    settingsConfig: {
      env: {
        ANTHROPIC_BASE_URL: 'https://anthropic-api-key.example',
        ANTHROPIC_API_KEY: 'anthropic-api-key-secret',
        ANTHROPIC_MODEL: 'claude-api-key-test',
      },
      modelCatalog: { models: [{ model: 'claude-api-key-test' }] },
    },
  }).id;
  const cases = [
    ['cc-anthropic', 'anthropic', 'https://anthropic.example/v1', 'apiKey', 'anthropic-secret', 'claude-test'],
    [anthropicApiKeyId, 'anthropic', 'https://anthropic-api-key.example/v1', 'apiKey', 'anthropic-api-key-secret', 'claude-api-key-test'],
    ['cc-chat', 'openai', 'https://chat.example/v1', 'apiKey', 'chat-secret', 'chat-model'],
    [responsesId, 'openai', 'https://responses-zcode.example/v1', 'apiKey', 'zcode-responses-secret', 'gpt-zcode'],
  ];

  const configPaths = new Set();
  for (const [providerId, kind, baseURL, credentialField, credential, model] of cases) {
    const spawn = providers.resolveSpawnEnv({
      id: `zcode-${kind}-${providerId}`,
      cli: 'zcode',
      provider: providerId,
      model,
    });
    assert.ok(spawn.env.ZCODE_DATA_BASE_DIR.startsWith(fakeHome));
    assert.equal(spawn.env.HOME, spawn.env.ZCODE_DATA_BASE_DIR);
    assert.ok(spawn.env.ZCODE_SETTINGS.startsWith(spawn.env.ZCODE_DATA_BASE_DIR));
    assert.equal(spawn.qualifiedModel.endsWith(`/${model}`), true);
    const config = JSON.parse(fs.readFileSync(spawn.env.ZCODE_SETTINGS, 'utf8'));
    const routeId = config.model.slice(0, config.model.indexOf('/'));
    assert.equal(config.provider[routeId].kind, kind);
    assert.equal(config.provider[routeId].options.baseURL, baseURL);
    assert.equal(config.provider[routeId].options[credentialField], credential);
    const otherCredential = credentialField === 'apiKey' ? 'authToken' : 'apiKey';
    assert.equal(config.provider[routeId].options[otherCredential], undefined);
    assert.deepEqual(config.provider[routeId].models[model], { id: model });
    assert.equal(fs.statSync(spawn.env.ZCODE_SETTINGS).mode & 0o777, 0o600);
    // Engine >=0.16.9 registry: same provider in v2/provider_config.json, the
    // session model first so it is the engine's default.
    const personalFile = path.join(spawn.env.ZCODE_DATA_BASE_DIR, '.zcode', 'v2', 'provider_config.json');
    const [rule] = JSON.parse(fs.readFileSync(personalFile, 'utf8')).config.providerConfigRules.providerRules;
    assert.equal(rule.providerId, routeId);
    assert.equal(rule.config.api.type, kind === 'anthropic' ? 'anthropic-messages' : 'openai-responses');
    assert.equal(rule.config.api.baseUrl, baseURL);
    assert.deepEqual(rule.config.access, { type: 'api-key', apiKey: credential });
    assert.equal(rule.config.personalModelIds[0], model);
    assert.equal(fs.statSync(personalFile).mode & 0o777, 0o600);
    configPaths.add(spawn.env.ZCODE_SETTINGS);
  }
  assert.equal(configPaths.size, 4, 'each session receives an isolated ZCode config tree');

  const native = providers.resolveSpawnEnv({ id: 'zcode-native', cli: 'zcode', provider: null });
  assert.deepEqual(native.env, {}, 'provider-less ZCode keeps its official/native Coding Plan state');
});

test('protocol compatibility gives ZCode both pools while Qoder stays providerless', () => {
  assert.deepEqual(providers.appTypesForCli('opencode'), ['claude', 'codex']);
  assert.deepEqual(providers.appTypesForCli('qoder'), []);
  assert.deepEqual(providers.appTypesForCli('zcode'), ['claude', 'codex']);
  assert.deepEqual(providers.appTypesForCli('dsh'), ['claude']);
  assert.deepEqual(providers.appTypesForCli('grok'), ['claude', 'codex']);
  assert.equal(providers.providerSupportsCli({
    appType: 'claude', apiFormat: 'anthropic',
    baseUrl: 'https://anthropic.example', hasToken: true,
  }, 'dsh'), true);
  assert.equal(providers.providerSupportsCli({
    appType: 'claude', apiFormat: 'anthropic', isOfficial: true,
  }, 'dsh'), false, 'DSH cannot replay a Claude OAuth subscription');
  assert.equal(providers.providerSupportsCli({
    appType: 'codex', apiFormat: 'openai_responses',
    baseUrl: 'https://responses.example/v1', hasToken: true,
  }, 'grok'), true);
  assert.equal(providers.providerSupportsCli({
    appType: 'claude', apiFormat: 'anthropic',
    baseUrl: 'https://anthropic.example', hasToken: true,
  }, 'grok'), true);
  assert.equal(providers.normalizeApiFormat(null, 'claude', {}), 'anthropic');
  assert.equal(providers.normalizeApiFormat(null, 'codex', {}), 'openai_responses');
  assert.equal(providers.normalizeApiFormat(null, 'codex', { proxyTarget: { mode: 'chat-to-responses' } }), 'openai_responses');
  assert.equal(providers.providerSupportsCli({ appType: 'claude' }, 'codex'), false);
  assert.equal(providers.providerSupportsCli({ appType: 'codex' }, 'claude'), false);
  assert.equal(providers.providerSupportsCli({
    appType: 'claude', apiFormat: 'anthropic',
    baseUrl: 'https://anthropic.example', hasToken: true,
  }, 'zcode'), true);
  assert.equal(providers.providerSupportsCli({
    appType: 'codex', apiFormat: 'openai_responses',
    baseUrl: 'https://responses.example/v1', hasToken: true,
  }, 'zcode'), true);
  assert.equal(providers.providerSupportsCli({
    appType: 'codex', apiFormat: 'openai_responses',
    baseUrl: '', hasToken: false, isOfficial: true,
  }, 'zcode'), false, 'another CLI cannot replay Codex OAuth');
});

test('DSH route injects DEEPSEEK_* env only; Grok materializes a private GROK_HOME', () => {
  // DSH: Anthropic-format provider → env-only route, model passed through as a
  // bare wire id, provider credential never written to disk.
  const dshSpawn = providers.resolveSpawnEnv({
    id: 'dsh-route-test', cli: 'dsh', provider: 'cc-anthropic', model: 'claude-test',
  });
  assert.equal(dshSpawn.env.DEEPSEEK_BASE_URL, 'https://anthropic.example');
  assert.equal(dshSpawn.env.DEEPSEEK_API_KEY, 'anthropic-secret');
  assert.equal(dshSpawn.qualifiedModel, 'claude-test');
  assert.equal(dshSpawn.providerModel, 'claude-test');
  assert.equal(dshSpawn.grokHome, undefined);
  assert.ok(!Object.keys(dshSpawn.env).some(k => /GROK_HOME|ZCODE_DATA/.test(k)), 'DSH route touches no home tree');

  // Grok on an Anthropic provider: private home + config.toml api_backend=messages,
  // key travels via env_key, never into the file.
  const grokAnthropic = providers.resolveSpawnEnv({
    id: 'grok-anthropic-test', cli: 'grok', provider: 'cc-anthropic', model: 'claude-test',
  });
  assert.ok(grokAnthropic.env.GROK_HOME.startsWith(providers.GROK_HOMES_DIR));
  assert.equal(grokAnthropic.env.MULTICC_GROK_API_KEY, 'anthropic-secret');
  assert.equal(grokAnthropic.qualifiedModel, 'claude-test');
  const grokToml = fs.readFileSync(path.join(grokAnthropic.env.GROK_HOME, 'config.toml'), 'utf8');
  assert.match(grokToml, /api_backend\s*=\s*"messages"/);
  assert.match(grokToml, /base_url\s*=\s*"https:\/\/anthropic\.example"/);
  assert.match(grokToml, /env_key\s*=\s*"MULTICC_GROK_API_KEY"/);
  assert.equal(grokToml.includes('anthropic-secret'), false, 'API key never lands in config.toml');
  assert.equal(fs.statSync(path.join(grokAnthropic.env.GROK_HOME, 'config.toml')).mode & 0o777, 0o600);

  // Grok on a Responses provider: same home layout, api_backend=responses.
  const grokResponses = providers.resolveSpawnEnv({
    id: 'grok-responses-test', cli: 'grok', provider: 'cc-chat', model: 'chat-model',
  });
  const grokResponsesToml = fs.readFileSync(path.join(grokResponses.env.GROK_HOME, 'config.toml'), 'utf8');
  assert.match(grokResponsesToml, /api_backend\s*=\s*"responses"/);
  assert.match(grokResponsesToml, /base_url\s*=\s*"https:\/\/chat\.example\/v1"/);
  assert.equal(grokResponsesToml.includes('chat-secret'), false);
  assert.notEqual(grokResponses.env.GROK_HOME, grokAnthropic.env.GROK_HOME, 'each session gets an isolated GROK_HOME');
});

test('the pool fixes the protocol: contradictory apiFormat is rejected, legacy mislabels are repaired', () => {
  assert.throws(() => providers.createProvider({
    appType: 'codex', name: 'Codex Anthropic', baseUrl: 'https://api.deepseek.com/anthropic',
    authToken: 'k', model: 'deepseek-v4-pro', apiFormat: 'anthropic',
  }), /Codex 线路只能用 OpenAI Responses/);
  assert.throws(() => providers.createProvider({
    appType: 'claude', name: 'Claude Responses', baseUrl: 'https://api.deepseek.com',
    authToken: 'k', model: 'deepseek-v4-pro', apiFormat: 'openai_responses',
  }), /Claude 线路只能用 Anthropic Messages/);
  // Legacy spellings that mean the pool's own format stay accepted.
  const legacyId = providers.createProvider({
    appType: 'codex', name: 'Legacy chat label', baseUrl: 'https://legacy.example/v1',
    authToken: 'k', model: 'm', apiFormat: 'openai_chat',
  }).id;
  assert.equal(providers.getProviderSummary('codex', legacyId).apiFormat, 'openai_responses');
  assert.throws(() => providers.updateProvider('codex', legacyId, { apiFormat: 'anthropic' }), /Codex 线路只能用/);

  assert.equal(providers.normalizeApiFormat('anthropic', 'codex', {}), 'openai_responses');
  assert.equal(providers.normalizeApiFormat('openai_responses', 'claude', {}), 'anthropic');

  // A row the old form stored as Codex + Anthropic: read as responses, never
  // offered to Claude Code, and the store label is repaired on migration.
  const storeFile = path.join(dataDir, 'providers.json');
  const list = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  const row = list.find(provider => provider.id === legacyId);
  row.apiFormat = 'anthropic';
  fs.writeFileSync(storeFile, JSON.stringify(list, null, 2), { mode: 0o600 });
  const summary = providers.getProviderSummary('codex', legacyId);
  assert.equal(summary.apiFormat, 'openai_responses');
  assert.equal(summary.compatibleClis.includes('claude'), false);
  assert.equal(summary.compatibleClis.includes('codex'), true);
  assert.equal(providers.providerSupportsCli({ ...row }, 'claude'), false);
  providers.migrateLegacyProviderProtocols();
  const repaired = JSON.parse(fs.readFileSync(storeFile, 'utf8')).find(provider => provider.id === legacyId);
  assert.equal(repaired.apiFormat, 'openai_responses');
});
