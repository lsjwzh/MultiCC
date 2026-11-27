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
} = require('../src/native/binding').roleTokenTracker;

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

test('a failed role ledger write preserves the snapshot and passes the original error to the host', () => {
  const error = new Error('disk full');
  const errors = [];
  const tracker = createRoleTokenTracker({
    filePath: 'ledger.json',
    fsImpl: {
      readFileSync: () => '{}', mkdirSync() {}, unlinkSync() {},
      writeFileSync() { throw error; },
    },
    onError: err => errors.push(err),
  });
  assert.equal(tracker.accumulateObserved(observed()), true);
  assert.deepEqual(tracker.snapshot('s1').sub, { inputTokens: 10, outputTokens: 4, cacheWrite: 2, cacheRead: 3 });
  assert.equal(errors.length, 1);
  assert.equal(errors[0], error);
  tracker.reset('s1');
  assert.equal(tracker.snapshot('s1'), null);
  assert.equal(tracker.accumulateObserved(observed()), false);
});

test('an error callback that throws leaves the event eligible for retry', () => {
  const error = new Error('write failed');
  let failing = true;
  const tracker = createRoleTokenTracker({
    filePath: 'ledger.json',
    fsImpl: { readFileSync: () => '{}', mkdirSync() {}, unlinkSync() {}, renameSync() {},
      writeFileSync() { if (failing) throw error; } },
    onError: err => { throw err; },
  });
  assert.throws(() => tracker.accumulateObserved(observed()), err => err === error);
  failing = false;
  assert.equal(tracker.accumulateObserved(observed()), true);
  assert.equal(tracker.snapshot('s1').sub.inputTokens, 20);
  assert.equal(tracker.accumulateObserved(observed()), false);
});

test('role tracker keeps the newest 50000 distinct event IDs in insertion order', () => {
  const { RustRoleTokenTracker } = require('../src/native/binding').getNative();
  const anchor = {};
  const owner = new RustRoleTokenTracker(anchor);
  for (let i = 0; i < 50_000; i++) owner.remember(String(i));
  owner.remember('0');
  owner.remember('50000');
  assert.equal(owner.seen('0'), false);
  assert.equal(owner.seen('1'), true);
  assert.equal(owner.seen('50000'), true);
});

test('the native role ledger creates private ancestors and keeps existing directory modes', {
  skip: process.platform === 'win32',
}, t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-role-modes-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  fs.chmodSync(parent, 0o750);
  const file = path.join(parent, 'new', 'nested', 'ledger.json');
  const tracker = createRoleTokenTracker({ filePath: file });
  assert.equal(tracker.accumulateObserved(observed()), true);
  const mode = file => fs.statSync(file).mode & 0o777;
  assert.equal(mode(parent), 0o750);
  assert.equal(mode(path.join(parent, 'new')), 0o700);
  assert.equal(mode(path.dirname(file)), 0o700);
  assert.equal(mode(file), 0o600);
});

test('native ledger matches injected write, rename and cleanup failures and Date-like coercion', () => {
  const before = require('./helpers/frozen-state-leaves/role-token-tracker');
  const after = require('../src/native/binding').roleTokenTracker;
  function trace(api, failure) {
    const calls = [];
    const error = Error('injected write failure');
    const save = (kind, file, value) => {
      const dest = file === 'ledger.json' ? file : '<temporary>';
      calls.push([kind, dest, value]);
      if (kind === failure) throw error;
    };
    const tracker = api.createRoleTokenTracker({
      filePath: 'ledger.json',
      now: () => ({ getFullYear: () => 2026, getMonth: () => 0, getDate: () => 9 }),
      fsImpl: {
        mkdirSync: (dir, options) => calls.push(['mkdir', dir, options]),
        readFileSync: () => '{}', writeFileSync: (file, text) => save('write', file, text),
        renameSync: (file, dest) => save('rename', file, dest), unlinkSync: file => save('unlink', file),
      },
      onError: caught => calls.push(['error', caught === error]),
    });
    const event = observed();
    const result = [tracker.accumulateObserved(event), tracker.accumulateObserved(event)];
    return { calls, result, snapshot: tracker.snapshot('s1') };
  }
  for (const failure of ['', 'write', 'rename', 'unlink']) {
    assert.deepEqual(trace(after, failure), trace(before, failure));
  }
});
