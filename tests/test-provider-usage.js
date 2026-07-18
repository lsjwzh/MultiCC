'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { assertTestDir, createPaths } = require('../src/paths');

const dataDir = assertTestDir(fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-provider-usage-')));
process.env.MULTICC_DATA_DIR = dataDir;

const runtimePaths = createPaths({ dataDir });
const { getProviderUsageStats } = require('../src/providers');

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function seedUsage() {
  writeJson(runtimePaths.providersFile, [
    { id: 'provider-a', name: 'Provider A', appType: 'claude', settingsConfig: {} },
  ]);
  writeJson(runtimePaths.tokenUsageFile, {
    'session-a': { inputTokens: 11, outputTokens: 7, turnCount: 2 },
    'session-default': { inputTokens: 3, outputTokens: 2, turnCount: 1 },
  });
}

function assertMappedUsage() {
  const result = getProviderUsageStats();
  const provider = result.stats.find(entry => entry.providerId === 'provider-a');
  const fallback = result.stats.find(entry => entry.providerId === '_default_');
  assert.deepEqual(
    { inputTokens: provider.inputTokens, outputTokens: provider.outputTokens, sessionCount: provider.sessionCount },
    { inputTokens: 11, outputTokens: 7, sessionCount: 1 },
  );
  assert.equal(provider.providerName, 'Provider A');
  assert.deepEqual(
    { inputTokens: fallback.inputTokens, outputTokens: fallback.outputTokens, sessionCount: fallback.sessionCount },
    { inputTokens: 3, outputTokens: 2, sessionCount: 1 },
  );
}

test.before(() => {
  seedUsage();
});

test.after(() => {
  assertTestDir(dataDir);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('provider usage maps sessions from the legacy bare-array document', () => {
  writeJson(runtimePaths.sessionsFile, [
    { id: 'session-a', provider: 'provider-a' },
    { id: 'session-default', provider: null },
  ]);
  assertMappedUsage();
});

test('provider usage maps sessions from the StateStore envelope', () => {
  writeJson(runtimePaths.sessionsFile, {
    __multiccSchema: { version: 1, kind: 'sessions', writtenAt: new Date(0).toISOString() },
    data: [
      { id: 'session-a', provider: 'provider-a' },
      { id: 'session-default', provider: null },
    ],
  });
  assertMappedUsage();
});
