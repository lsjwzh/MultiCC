'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createUsageObserved } = require('../src/usage-observed');
const {
  createRoleTokenTracker,
  usageObservedToRoleTokenInfo,
} = require('../src/role-token-tracker');

function observed(overrides = {}) {
  return createUsageObserved({
    eventId: 'proxy-event-1', occurredAt: 1_750_000_000_000,
    sessionId: 's1', providerId: 'p1', providerName: 'Provider One',
    roleKind: 'sub', agentRole: 'custom', routeName: 'reviewer',
    source: 'exact', coverage: 'observed', status: 'success',
    protocol: 'anthropic-messages', model: 'm1',
    tokens: { input: 10, output: 4, cacheRead: 3, cacheWrite: 2 },
    ...overrides,
  });
}

test('UsageObserved maps exactly to the legacy role-token shape', () => {
  assert.deepEqual(usageObservedToRoleTokenInfo(observed()), {
    sessionId: 's1', role: 'sub', providerId: 'p1', providerName: 'Provider One', model: 'm1',
    usage: { inputTokens: 10, outputTokens: 4, cacheWrite: 2, cacheRead: 3 },
  });
  assert.equal(usageObservedToRoleTokenInfo(observed({
    eventId: 'proxy-event-unobservable', coverage: 'unobservable', status: 'error', tokens: undefined,
  })), null);
});

test('standardized tracker entry preserves old snapshots and deduplicates stable eventId', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-role-token-'));
  try {
    const standard = createRoleTokenTracker({ filePath: path.join(dir, 'standard.json'), now: () => new Date('2026-07-18T12:00:00Z') });
    const legacy = createRoleTokenTracker({ filePath: path.join(dir, 'legacy.json'), now: () => new Date('2026-07-18T12:00:00Z') });
    const event = observed();
    assert.equal(standard.accumulateObserved(event), true);
    assert.equal(standard.accumulateObserved(event), false);
    assert.equal(legacy.accumulate(usageObservedToRoleTokenInfo(event)), true);
    assert.deepEqual(standard.snapshot('s1'), legacy.snapshot('s1'));
    assert.deepEqual(standard.readLedger(), legacy.readLedger());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('main usage keeps its legacy total and an additive exact provider split', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-role-main-provider-'));
  try {
    const tracker = createRoleTokenTracker({ filePath: path.join(dir, 'ledger.json') });
    tracker.accumulate({
      sessionId: 's1', role: 'main', providerId: 'provider-a', providerName: 'A', model: 'a',
      usage: { inputTokens: 10, outputTokens: 2, cacheWrite: 0, cacheRead: 1 },
    });
    tracker.accumulate({
      sessionId: 's1', role: 'main', providerId: 'provider-b', providerName: 'B', model: 'b',
      usage: { inputTokens: 3, outputTokens: 4, cacheWrite: 2, cacheRead: 0 },
    });
    const snapshot = tracker.snapshot('s1');
    assert.deepEqual(snapshot.main, {
      inputTokens: 13, outputTokens: 6, cacheWrite: 2, cacheRead: 1,
    });
    assert.deepEqual(snapshot.mainByProvider.map(item => item.providerId), ['provider-a', 'provider-b']);
    assert.equal(snapshot.mainByProvider.reduce((sum, item) => sum + item.outputTokens, 0),
      snapshot.main.outputTokens);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
