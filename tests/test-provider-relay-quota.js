'use strict';

// Stub the shared outbound transport: no test can accidentally use live credentials.
let testFetch = async () => { throw new Error('unexpected outbound request'); };
require('node:test').mock.method(require('../src/network/outbound'), 'outboundFetch',
  (...args) => testFetch(...args));

// 保留 provider target 解析与后台 poller 的借道错误契约。公开出借方路由与
// 厂商查询已迁 Rust；本文件不再用旧 Node 端点模拟新前门。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { assertTestDir, createPaths } = require('../src/paths');

const dataDir = assertTestDir(fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-relay-quota-')));
process.env.MULTICC_DATA_DIR = dataDir;
const runtimePaths = createPaths({ dataDir });
const { getProviderLimitTarget } = require('../src/providers/core');
const poller = require('../src/usage-limit-poller');

const RELAY_CREDENTIAL = 'mcr1.abcdefghijklmnop.secret-token-1';

function writeProviders(rows) {
  fs.writeFileSync(runtimePaths.providersFile, JSON.stringify(rows, null, 2));
}

test.after(() => {
  assertTestDir(dataDir);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('claude relay provider resolves to strategy relay-quota with the canonical relay URL', () => {
  writeProviders([
    {
      id: 'relay-glm', appType: 'claude', name: 'GLM · 借道', source: 'local',
      settingsConfig: {
        env: {
          ANTHROPIC_BASE_URL: 'https://relay.example:3000/claude-proxy/glm/remote',
          ANTHROPIC_AUTH_TOKEN: RELAY_CREDENTIAL,
        },
      },
    },
  ]);
  const target = getProviderLimitTarget('claude', 'relay-glm');
  assert.deepEqual(target, {
    providerId: 'relay-glm',
    appType: 'claude',
    relayUrl: 'https://relay.example:3000/claude-proxy/glm/remote',
    apiKey: RELAY_CREDENTIAL,
    strategy: 'relay-quota',
  });
});

test('official Claude quota target retains the shared account identity', () => {
  writeProviders([{ id: 'official-shared', appType: 'claude', settingsConfig: {
    env: {}, officialAccount: { id: 'account-a' },
  } }]);
  assert.deepEqual(getProviderLimitTarget('claude', 'official-shared'), {
    providerId: 'official-shared', appType: 'claude', host: 'api.anthropic.com', apiKey: null,
    officialAccountId: 'account-a', strategy: 'claude-oauth-usage',
  });
});

test('codex relay provider (local proxyTarget wrap) resolves through originalBaseUrl', () => {
  // 导入 codex 借道分享码时，本机会把中转地址包进自己的 codex-proxy：
  // config.toml 的 base_url 指向 127.0.0.1，真实中转地址留在
  // proxyTarget.originalBaseUrl —— 解析必须取到它，而不是本地包装。
  writeProviders([
    {
      id: 'relay-cx', appType: 'codex', name: 'Official · 借道', source: 'local',
      settingsConfig: {
        auth: { OPENAI_API_KEY: RELAY_CREDENTIAL },
        config: 'model_provider = "custom"\n\n[model_providers.custom]\nname = "custom"\nbase_url = "http://127.0.0.1:3000/codex-proxy/relay-cx"\nwire_api = "responses"\n',
        proxyTarget: {
          baseUrl: 'https://relay.example:3000/codex-proxy/official/responses',
          apiKey: RELAY_CREDENTIAL,
          originalBaseUrl: 'https://relay.example:3000/codex-proxy/official',
          mode: 'responses-compat',
        },
      },
    },
  ]);
  const target = getProviderLimitTarget('codex', 'relay-cx');
  assert.equal(target.strategy, 'relay-quota');
  assert.equal(target.relayUrl, 'https://relay.example:3000/codex-proxy/official');
  assert.equal(target.apiKey, RELAY_CREDENTIAL);
});

test('loopback codex-proxy plumbing is NOT a relay; plain GLM provider keeps glm-monitor', () => {
  writeProviders([
    {
      id: 'local-cx', appType: 'codex', name: 'Local wrap', source: 'local',
      settingsConfig: {
        auth: { OPENAI_API_KEY: 'sk-local' },
        config: 'model_provider = "custom"\n\n[model_providers.custom]\nname = "custom"\nbase_url = "http://127.0.0.1:3000/codex-proxy/local-cx"\nwire_api = "responses"\n',
        proxyTarget: {
          baseUrl: 'http://127.0.0.1:3000/codex-proxy/local-cx',
          apiKey: 'sk-local',
          originalBaseUrl: 'http://127.0.0.1:3000/codex-proxy/local-cx',
          mode: 'responses-compat',
        },
      },
    },
    {
      id: 'glm-1', appType: 'claude', name: 'GLM', source: 'local',
      settingsConfig: {
        env: {
          ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/paas/v4',
          ANTHROPIC_AUTH_TOKEN: 'raw-key',
        },
      },
    },
  ]);
  // 本机 CPR 包装（loopback）绝不会被当成借道，也没有可查的厂商 host → null。
  assert.equal(getProviderLimitTarget('codex', 'local-cx'), null);
  // 普通厂商 provider 的解析不受借道分支影响。
  const glm = getProviderLimitTarget('claude', 'glm-1');
  assert.equal(glm.strategy, 'glm-monitor');
  assert.equal(glm.host, 'open.bigmodel.cn');
});

test('an unsupported lender exposes its reason instead of silently dropping quota', async () => {
  const originalFetch = testFetch;
  testFetch = async () => ({ ok: true, json: async () => ({ ok: false, reason: 'unsupported' }) });
  try {
    await assert.rejects(poller.pollRelayQuota({ relayUrl: 'https://lender.example/codex-proxy/p', apiKey: RELAY_CREDENTIAL }),
      /lender: unsupported/);
  } finally { testFetch = originalFetch; }
});
