'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const providers = require('../src/providers');

test('vendor-auth CLIs stay providerless while ZCode resolves both MultiCC provider pools', () => {
  assert.equal(providers.appTypeForCli('claude'), 'claude');
  assert.equal(providers.appTypeForCli('opencode'), 'claude');
  assert.equal(providers.appTypeForCli('codex'), 'codex');
  assert.equal(providers.appTypeForCli('qoder'), null);
  assert.equal(providers.appTypeForCli('kimi'), null);
  assert.equal(providers.appTypeForCli('codebuddy'), null);
  assert.equal(providers.appTypeForCli('dsh'), null);
  assert.equal(providers.appTypeForCli('zcode'), null);
  assert.deepEqual(providers.appTypesForCli('qoder'), []);
  assert.deepEqual(providers.appTypesForCli('codebuddy'), []);
  assert.deepEqual(providers.appTypesForCli('dsh'), []);
  assert.deepEqual(providers.appTypesForCli('zcode'), ['claude', 'codex']);
});

test('stale vendor provider ids cannot silently fall through to another account', () => {
  assert.deepEqual(providers.resolveSpawnEnv({ cli: 'qoder', provider: 'stale-provider' }), {
    env: {},
    skipDefaultModel: false,
    aliasOnly: false,
    providerModel: null,
    providerModels: [],
    providerName: null,
  });
  assert.deepEqual(providers.resolveSpawnEnv({ cli: 'codebuddy', provider: 'stale-provider' }), {
    env: {},
    skipDefaultModel: false,
    aliasOnly: false,
    providerModel: null,
    providerModels: [],
    providerName: null,
  });
  assert.deepEqual(providers.resolveSpawnEnv({ cli: 'dsh', provider: 'stale-provider' }), {
    env: {},
    skipDefaultModel: false,
    aliasOnly: false,
    providerModel: null,
    providerModels: [],
    providerName: null,
  });
  assert.throws(
    () => providers.resolveSpawnEnv({ cli: 'zcode', provider: 'stale-provider' }),
    /Provider 不存在、协议不兼容或缺少可用的 HTTP 凭证/,
  );
  assert.throws(
    () => providers.buildChildEnv(
      { PATH: '/usr/bin' },
      { cli: 'zcode', provider: 'stale-provider' },
      { MULTICC_SESSION_ID: 'zcode-session' },
    ),
    /Provider 不存在、协议不兼容或缺少可用的 HTTP 凭证/,
  );
});

test('host spawn paths route proxies by explicit provider capability', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
assert.match(source, /appType === 'claude'/);
assert.match(source, /appType === 'codex'/);
  assert.doesNotMatch(source, /persisted\.cli !== 'qoder'\)\s*providers\.applyClaudeProxyEnv/);
  assert.doesNotMatch(source, /persisted\.cli !== 'codex' && persisted\.cli !== 'qoder'/);
});
