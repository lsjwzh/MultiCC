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
const { getProviderUsageStats, readDailyWindows } = require('../src/providers');

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
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  writeJson(runtimePaths.tokenDailyFile, {
    [today]: {
      'provider-a': { inputTokens: 11, outputTokens: 7, turnCount: 2 },
      _default_: { inputTokens: 3, outputTokens: 2, turnCount: 1 },
    },
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
  assert.deepEqual(result.unattributed, { inputTokens: 0, outputTokens: 0, turnCount: 0 });
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

test('provider history stays with the event-time provider after a session switches', () => {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  writeJson(runtimePaths.sessionsFile, [{ id: 'session-a', provider: 'provider-new' }]);
  writeJson(runtimePaths.tokenUsageFile, {
    'session-a': { inputTokens: 100, outputTokens: 10, turnCount: 3 },
  });
  writeJson(runtimePaths.tokenDailyFile, {
    [today]: {
      'provider-a': { inputTokens: 80, outputTokens: 8, turnCount: 2 },
    },
  });

  const result = getProviderUsageStats();
  const historical = result.stats.find(entry => entry.providerId === 'provider-a');
  assert.equal(historical.inputTokens, 80);
  assert.equal(historical.outputTokens, 8);
  assert.equal(historical.sessionCount, 0);
  assert.equal(result.stats.some(entry => entry.providerId === 'provider-new'), false,
    'the current provider must not inherit unattributed session history');
  assert.deepEqual(result.unattributed, { inputTokens: 20, outputTokens: 2, turnCount: 1 });
});

test('daily windows ignore malformed dates and non-object day buckets', () => {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  writeJson(runtimePaths.tokenDailyFile, {
    invalid: { 'provider-bad-date': { inputTokens: 999 } },
    '2026-99-99': { 'provider-bad-calendar-date': { inputTokens: 999 } },
    '2026-01-01': null,
    [today]: {
      'provider-a': { inputTokens: 5, outputTokens: 1, turnCount: 1 },
    },
  });
  const windows = readDailyWindows();
  assert.deepEqual(Object.keys(windows.all), ['provider-a']);
  assert.equal(windows.today['provider-a'].inputTokens, 5);
});
