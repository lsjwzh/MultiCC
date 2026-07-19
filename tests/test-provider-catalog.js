'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const catalog = require('../public/provider-catalog');

const ROOT = path.join(__dirname, '..');

test('provider summaries are whitelisted and credential material is discarded', () => {
  const provider = catalog.normalizeProvider({
    id: 'claude-local',
    appType: 'claude',
    protocol: 'malicious-route-override',
    wireApi: 'malicious-wire-override',
    name: 'Local relay',
    source: 'ccswitch',
    baseUrl: 'https://user:password@relay.test/anthropic?token=leak#secret',
    model: 'model-a',
    modelOptions: ['model-b', 'model-a', '', 'model-b'],
    aliasMap: {
      opus: { model: 'wire-opus', name: 'Friendly' },
      unknown: { model: 'must-drop' },
    },
    tokenMask: 'raw-token-must-drop',
    hasToken: true,
    authToken: 'raw-token',
    apiKey: 'raw-api-key',
    settingsConfig: { env: { ANTHROPIC_AUTH_TOKEN: 'nested-secret' } },
    headers: { Authorization: 'Bearer secret' },
  });

  assert.deepEqual(provider.modelOptions, ['model-a', 'model-b']);
  assert.deepEqual(provider.aliasMap, { opus: { model: 'wire-opus', name: 'Friendly' } });
  assert.equal(provider.baseUrl, 'https://relay.test/anthropic');
  assert.equal(provider.tokenMask, '');
  assert.equal(provider.hasToken, true);
  assert.equal(provider.authToken, undefined);
  assert.equal(provider.apiKey, undefined);
  assert.equal(provider.protocol, undefined);
  assert.equal(provider.wireApi, undefined);
  assert.equal(provider.settingsConfig, undefined);
  assert.equal(provider.headers, undefined);
  const serialized = JSON.stringify(provider);
  for (const secret of ['raw-token', 'raw-api-key', 'nested-secret', 'password']) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('catalog grouping, lookup and model options are deterministic', () => {
  const normalized = catalog.normalizeCatalog({
    available: true,
    ccSwitchAvailable: true,
    ccSwitchStatus: {
      available: true,
      dbFound: true,
      dbPath: '/private/home/.cc-switch/cc-switch.db',
      message: '',
    },
    defaults: { claude: 'c1', codex: 'x1', secret: 'drop' },
    providers: [
      { id: 'x1', appType: 'codex', name: 'Codex', model: 'gpt-a', models: ['gpt-b'] },
      { id: 'c1', appType: 'claude', name: 'Claude', modelOptions: ['sonnet', 'opus'] },
      { id: 'bad', appType: 'other', name: 'Drop me' },
    ],
    stats: [{
      providerId: 'c1',
      inputTokens: 10,
      freshInputTokens: 2,
      cacheReadTokens: 6,
      unattributedInputTokens: 2,
      breakdownKnown: true,
      today: {
        inputTokens: 10,
        freshInputTokens: 2,
        cacheReadTokens: 8,
        breakdownKnown: true,
        outputTokens: 2,
        secret: 'drop',
      },
      totalTokens: 12,
      turnCount: 1,
      sessionCount: 1,
    }],
    authToken: 'drop',
  });

  const groups = catalog.groupByAppType(normalized);
  assert.deepEqual(groups.claude.map(item => item.id), ['c1']);
  assert.deepEqual(groups.codex.map(item => item.id), ['x1']);
  assert.equal(catalog.findProvider(normalized, 'claude', 'c1').name, 'Claude');
  assert.equal(catalog.findProvider(normalized, 'codex', 'c1'), null);
  assert.deepEqual(catalog.modelsFor(catalog.findProvider(normalized, 'codex', 'x1')), ['gpt-a', 'gpt-b']);
  assert.deepEqual(normalized.defaults, { claude: 'c1', codex: 'x1' });
  assert.equal(normalized.ccSwitchStatus.dbPath, undefined);
  assert.equal(normalized.authToken, undefined);
  assert.equal(normalized.stats[0].today.inputTokens, 10);
  assert.equal(normalized.stats[0].today.cacheReadTokens, 8);
  assert.equal(normalized.stats[0].cacheReadTokens, 6);
  assert.equal(catalog.formatUsageWindow(normalized.stats[0].today), '新:2/缓读:8/缓写:0/出:2');
  assert.equal(catalog.formatUsageCumulative(normalized.stats[0]), '新 2 / 缓读 6 / 缓写 0 / 未分 2');
  assert.equal(catalog.formatUsageWindow({ inputTokens: 1200, outputTokens: 4 }), '入(含缓存):1.2K/出:4');
});

test('provider-in-use references become bounded display data', () => {
  const data = catalog.deleteReferenceDisplayData({
    details: {
      references: [
        { kind: 'main', sessionId: 's1', sessionName: 'Main chat', token: 'drop' },
        { kind: 'subagent', sessionId: 's2', sessionName: '' },
        { kind: 'default', cli: 'claude' },
        { kind: 'aux', protocol: 'openai' },
        { kind: 'unknown', value: 'drop' },
      ],
    },
  });

  assert.equal(data.count, 4);
  assert.deepEqual(data.kinds, ['main', 'subagent', 'default', 'aux']);
  assert.deepEqual(data.items[0], { kind: 'main', title: 'Main chat', detail: 's1' });
  assert.deepEqual(data.items[1], { kind: 'subagent', title: 's2', detail: 's2' });
  assert.deepEqual(data.items[2], { kind: 'default', title: 'claude', detail: '' });
  assert.deepEqual(data.items[3], { kind: 'aux', title: 'openai', detail: '' });
});

test('manage loads classic auth/API/catalog scripts in order and provider calls use the shared client', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'manage.html'), 'utf8');
  const manage = fs.readFileSync(path.join(ROOT, 'public', 'manage.js'), 'utf8');
  const headEnd = html.indexOf('</head>');
  const auth = html.indexOf('<script src="auth-client.js"></script>');
  const api = html.indexOf('<script src="api-client.js"></script>');
  const providers = html.indexOf('<script src="provider-catalog.js"></script>');
  const page = html.indexOf('<script src="manage.js"></script>');

  assert.ok(auth > 0 && auth < api && api < providers && providers < headEnd);
  assert.ok(providers < page);
  assert.doesNotMatch(html, /<script[^>]+type=["']module["'][^>]+(?:api-client|provider-catalog)/i);
  assert.match(manage, /providerApi\.json\('\/api\/providers'/);
  assert.match(manage, /providerCatalog\.normalizeCatalog/);
  assert.match(manage, /providerCatalog\.groupByAppType/);
  assert.match(manage, /providerCatalog\.deleteReferenceDisplayData/);
  assert.doesNotMatch(manage, /fetch\([^)]*[`'"]\/api\/providers/);
  assert.doesNotMatch(manage, /fetch\([^)]*[`'"]\/api\/provider-defaults/);
  assert.doesNotMatch(manage, /\/api\/providers[^\n]+tokenQS/);
});
