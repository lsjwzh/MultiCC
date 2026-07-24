'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const providers = require('../src/providers');

test('Qoder and ZCode have no MultiCC provider pool while existing CLIs stay compatible', () => {
  assert.equal(providers.appTypeForCli('claude'), 'claude');
  assert.equal(providers.appTypeForCli('opencode'), 'claude');
  assert.equal(providers.appTypeForCli('codex'), 'codex');
  assert.equal(providers.appTypeForCli('qoder'), null);
  assert.equal(providers.appTypeForCli('zcode'), null);
});

test('stale vendor provider ids cannot produce routing environment', () => {
  for (const cli of ['qoder', 'zcode']) {
    assert.deepEqual(providers.resolveSpawnEnv({ cli, provider: 'stale-provider' }), {
      env: {},
      skipDefaultModel: false,
      aliasOnly: false,
      providerModel: null,
      providerModels: [],
      providerName: null,
    });
    const child = providers.buildChildEnv(
      { PATH: '/usr/bin' },
      { cli, provider: 'stale-provider' },
      { MULTICC_SESSION_ID: `${cli}-session` },
    );
    assert.deepEqual(child.env, {
      PATH: '/usr/bin',
      MULTICC_SESSION_ID: `${cli}-session`,
    });
  }
});

test('host spawn paths route proxies by explicit provider capability', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
assert.match(source, /appType === 'claude'/);
assert.match(source, /appType === 'codex'/);
  assert.doesNotMatch(source, /persisted\.cli !== 'qoder'\)\s*providers\.applyClaudeProxyEnv/);
  assert.doesNotMatch(source, /persisted\.cli !== 'codex' && persisted\.cli !== 'qoder'/);
});
