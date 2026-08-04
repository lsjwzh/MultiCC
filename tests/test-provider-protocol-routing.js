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

const providers = require('../src/providers');

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('CC-Switch import treats meta.apiFormat as the protocol source of truth', () => {
  const result = providers.importFromCcSwitch();
  assert.equal(result.imported, 2);

  const chat = providers.getProviderSummary('codex', 'cc-chat');
  assert.equal(chat.apiFormat, 'openai_chat');
  assert.equal(chat.wireApi, 'chat_completions');
  assert.deepEqual(chat.compatibleClis, ['codex', 'opencode', 'zcode', 'kimi']);
  assert.deepEqual(chat.requiresConversionFor, ['codex']);

  const anthropic = providers.getProviderSummary('claude', 'cc-anthropic');
  assert.equal(anthropic.apiFormat, 'anthropic');
  assert.deepEqual(anthropic.compatibleClis, ['claude', 'opencode', 'zcode']);
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
  assert.equal(migrated.find(provider => provider.id === 'cc-chat').apiFormat, 'openai_chat');
  assert.equal(migrated.find(provider => provider.id === 'cc-chat').settingsConfig.proxyTarget.mode, 'chat-to-responses');
  assert.equal(migrated.find(provider => provider.id === 'cc-anthropic').apiFormat, 'anthropic');

  assert.deepEqual(providers.migrateLegacyProviderProtocols(), { updated: 0, skipped: 0, total: 2 });
  assert.equal(fs.readFileSync(storeFile, 'utf8'), migratedBytes);
});

test('Codex selects the Chat-to-Responses proxy only for Chat providers', () => {
  const spawn = providers.resolveSpawnEnv({ cli: 'codex', provider: 'cc-chat', model: 'chat-model' });
  assert.ok(spawn.codexHome.startsWith(fakeHome));
  const config = fs.readFileSync(path.join(spawn.codexHome, 'config.toml'), 'utf8');
  assert.match(config, /wire_api\s*=\s*"responses"/);
  assert.match(config, /base_url\s*=\s*"http:\/\/127\.0\.0\.1:3000\/codex-proxy\/cc-chat"/);
  const raw = providers.getProvider('codex', 'cc-chat');
  assert.equal(raw.settingsConfig.proxyTarget.mode, 'chat-to-responses');
  assert.equal(raw.settingsConfig.proxyTarget.baseUrl, 'https://chat.example/v1/chat/completions');
});

test('OpenCode maps all three protocols to their native AI SDK packages', () => {
  const responsesId = providers.createProvider({
    appType: 'codex', name: 'Responses', baseUrl: 'https://responses.example/v1',
    authToken: 'responses-secret', model: 'gpt-test', apiFormat: 'openai_responses',
  }).id;

  const cases = [
    ['cc-anthropic', '@ai-sdk/anthropic', 'claude-test'],
    ['cc-chat', '@ai-sdk/openai-compatible', 'chat-model'],
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

test('ZCode maps all three protocols to isolated native provider kinds', () => {
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
    ['cc-chat', 'openai-compatible', 'https://chat.example/v1', 'apiKey', 'chat-secret', 'chat-model'],
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
  assert.equal(providers.normalizeApiFormat(null, 'claude', {}), 'anthropic');
  assert.equal(providers.normalizeApiFormat(null, 'codex', {}), 'openai_responses');
  assert.equal(providers.normalizeApiFormat(null, 'codex', { proxyTarget: { mode: 'chat-to-responses' } }), 'openai_chat');
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
