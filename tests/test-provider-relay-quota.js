'use strict';

// 借道余量透传（relay-quota）端到端契约：
//   1. 导入方识别 —— core.getProviderLimitTarget 把 baseUrl 指向另一台 multicc
//      中转端点的 provider 解析成 strategy 'relay-quota'（识别来自
//      relay-share-store 的 relayRouteFromBaseUrl）；
//   2. 透传链路 —— usage-limit-poller 的 pollRelayQuota POST 出借方的
//      mountProviderRelayQuotaRoutes 端点，出借方收到后触发真实厂商查询并把
//      最新 DTO 传回，导入方原样透传。
// 这里用 stub 的 global.fetch 把两端在进程内桥接起来，等价于一次真实 HTTP
// 往返（URL / method / Authorization / 响应体全部走真实代码路径）。

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
const { mountProviderRelayQuotaRoutes } = require('../src/routes/provider-balance');

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

test('end-to-end: borrower detection → relay adapter → lender endpoint → fresh DTO pass-through', async () => {
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

  // ── 出借方（A 机）：真实厂商查询在此触发，慢查询模拟 inflight 去重窗口 ──
  const lenderRoutes = {};
  const lenderApp = {
    get: (p, h) => { lenderRoutes[`GET ${p}`] = h; },
    post: (p, h) => { lenderRoutes[`POST ${p}`] = h; },
  };
  let vendorRuns = 0;
  mountProviderRelayQuotaRoutes(lenderApp, {
    getProvider: (appType, id) => ({ id, appType, name: 'GLM' }),
    listProviders: () => [],
    getProviderLimitTarget: (appType, id) => ({
      providerId: id, appType, host: 'open.bigmodel.cn', apiKey: 'vendor-key', strategy: 'glm-monitor',
    }),
    adapters: {
      'glm-monitor': () => new Promise(resolve => {
        vendorRuns += 1;
        setTimeout(() => resolve({
          kind: 'window', provider: 'glm', rateLimitType: 'five_hour',
          status: 'allowed', utilization: 0.42, resetsAt: null,
        }), 25);
      }),
    },
  });

  // ── 桥接层：把 B 端适配器的 fetch 直接投递给 A 端已注册的路由处理器 ──
  const seenRequests = [];
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    seenRequests.push({ url, opts });
    const u = new URL(url);
    assert.equal(opts.method, 'POST', 'relay adapter always POSTs');
    assert.equal(u.pathname, '/claude-proxy/glm/remote/quota');
    const res = {
      statusCode: 200, body: null,
      set() { return this; },
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    await lenderRoutes['POST /claude-proxy/:id/remote/quota']({ params: { id: 'glm' } }, res);
    return {
      ok: res.statusCode >= 200 && res.statusCode < 300,
      status: res.statusCode,
      json: async () => res.body,
    };
  };
  try {
    // 并发两次透传查询 → 共享一次出借方真实查询（inflight 去重）。
    const [a, b] = await Promise.all([
      poller.pollRelayQuota(target, 0),
      poller.pollRelayQuota(target, 0),
    ]);
    assert.equal(vendorRuns, 1, 'concurrent borrower queries share one real vendor fetch');
    assert.equal(a.utilization, 0.42);
    assert.equal(b.utilization, 0.42);
    assert.equal(seenRequests.length, 2, 'both borrower requests reached the lender endpoint');
    assert.equal(seenRequests[0].opts.headers.Authorization, `Bearer ${RELAY_CREDENTIAL}`);

    // 串行的下一场查询（前一次已结束）→ 出借方再次触发真实查询：
    // 端点没有 TTL 缓存，语义就是「接到请求 → 触发真实查询 → 返回最新结果」。
    const again = await poller.pollRelayQuota(target, 0);
    assert.equal(again.utilization, 0.42);
    assert.equal(vendorRuns, 2, 'each settled request triggers a fresh real query (no TTL cache)');
  } finally {
    global.fetch = origFetch;
  }
});
