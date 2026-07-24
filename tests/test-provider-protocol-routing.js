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
  assert.deepEqual(chat.compatibleClis, ['codex', 'opencode']);
  assert.deepEqual(chat.requiresConversionFor, ['codex']);

  const anthropic = providers.getProviderSummary('claude', 'cc-anthropic');
  assert.equal(anthropic.apiFormat, 'anthropic');
  assert.deepEqual(anthropic.compatibleClis, ['claude', 'opencode']);
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

test('protocol compatibility keeps vendor CLIs providerless and old providers readable', () => {
  assert.deepEqual(providers.appTypesForCli('opencode'), ['claude', 'codex']);
  assert.deepEqual(providers.appTypesForCli('qoder'), []);
  assert.deepEqual(providers.appTypesForCli('zcode'), []);
  assert.equal(providers.normalizeApiFormat(null, 'claude', {}), 'anthropic');
  assert.equal(providers.normalizeApiFormat(null, 'codex', {}), 'openai_responses');
  assert.equal(providers.normalizeApiFormat(null, 'codex', { proxyTarget: { mode: 'chat-to-responses' } }), 'openai_chat');
  assert.equal(providers.providerSupportsCli({ appType: 'claude' }, 'codex'), false);
  assert.equal(providers.providerSupportsCli({ appType: 'codex' }, 'claude'), false);
});
