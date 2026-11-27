'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createOrchestrationSqliteStore } = require('../src/native/binding').orchestrationSqlite;
const { addonPath, getNative } = require('../src/native/binding');
const { decodeRecoveryEvents } = require('../src/native/binding');

function ownerBinary() {
  return process.env.MULTICC_TEST_ORCHESTRATION_OWNER || path.join(path.dirname(addonPath()),
    process.platform === 'win32' ? 'multicc-gateway.exe' : 'multicc-gateway');
}

function projectRecoveryEvent(event) {
  return { type: event.type, sessionId: event.sessionId,
    entryId: event.entryId || null, taskId: event.taskId || null,
    queued: event.queued == null ? null : event.queued, queuedItems: event.queuedItems || [],
    freezeReason: event.type === 'frozen' ? (event.reason || event.freezeReason) : null,
    classifyState: event.classifyState || null, turnOutcome: event.turnOutcome || null };
}

function frozenScheduler() {
  const Module = require('node:module');
  const filename = path.resolve(__dirname, '../src/session-work/scheduler.js');
  const source = fs.readFileSync(path.join(__dirname, 'helpers/scheduler-before-domain-migration.js.txt'), 'utf8');
  assert.equal(crypto.createHash('sha256').update(source).digest('hex'), 'f2d34115aa9f3dff98bd49c19ad5d34f30a9fbeb3735b524ddf069eb0b32dbb9');
  const module = new Module(filename);
  module.filename = filename;
  module.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = module.require.bind(module);
  module.require = id => id === './user-input' ? require('./helpers/legacy-session-work-user-input') : originalRequire(id);
  module._compile(source, filename);
  return module.exports.createSessionWorkScheduler;
}

test('experimental Rust recovery transaction agrees with frozen scheduler state', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-recovery-rust-diff-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cases = ['D', 'W', 'B', 'E', 'P'].flatMap(classify => [false, true].map(missing => ({ classify, missing })));
  for (const [i, scenario] of cases.entries()) {
    const stores = ['rust', 'oracle'].map(name => createOrchestrationSqliteStore({
      file: path.join(root, `${i}-${name}.sqlite`), now: () => 2000, ownerBinary: ownerBinary(),
    }));
    const owner = new (getNative().RustIsolatedOrchestrationStore)(stores[0].file, null, 2000,
      { env: {}, policy: {} }, ownerBinary());
    try {
      for (const store of stores) await store.mutate(draft => {
        if (!scenario.missing) draft.sessionSchedules.s = { sessionId: 's', state: 'running', classifyState: 'P', active: { entryId: 'active', taskId: 'task', startedAt: 50 }, updatedAt: 50 };
        draft.outbox.a = { id: 'a', sessionId: 's', sequence: 1, state: 'pending', payload: { type: 'session.work', message: 'queued' } };
        draft.nextOutboxSequence = 2;
      });
      const observed = { classifyState: scenario.classify, taskId: 'task', startedAt: 50, endedAt: 80 };
      const emitted = [];
      const oracle = frozenScheduler()({ store: stores[1], now: () => 1000, onEvent: event => emitted.push(event) });
      const reference = await oracle.recover({ stateForSession: () => observed });
      const snapshot = owner.request('scheduleRecoverSnapshotExperimental', {});
      const actual = await owner.requestAsync('scheduleRecoverCommitExperimental', {
        expectedRevision: snapshot.state.revision, expectedDataVersion: snapshot.dataVersion,
        at: 1000, updatedAt: 2000,
        facts: snapshot.sessions.map(sessionId => ({ sessionId, stateJson: JSON.stringify(observed) })),
      });
      const events = decodeRecoveryEvents(actual.resultJson);
      assert.deepEqual({ ok: true, changes: events.length }, reference, JSON.stringify(scenario));
      assert.deepEqual(events.map(projectRecoveryEvent), emitted.map(projectRecoveryEvent), JSON.stringify(scenario));
      const [ours, theirs] = await Promise.all(stores.map(store => store.snapshot()));
      assert.deepEqual(ours.sessionSchedules, theirs.sessionSchedules, JSON.stringify(scenario));
      assert.deepEqual(ours.outbox, theirs.outbox, JSON.stringify(scenario));
    } finally {
      owner.request('close', {});
      for (const store of stores) await store.close({ exportRollback: false });
    }
  }
});

test('Rust recovery snapshot observes session facts in the same order as the live SQLite scheduler', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-recovery-order-diff-'));
  const store = createOrchestrationSqliteStore({
    file: path.join(root, 'state.sqlite'), now: () => 2000, ownerBinary: ownerBinary(),
  });
  let owner;
  t.after(async () => {
    try { if (owner) owner.request('close', {}); await store.close({ exportRollback: false }); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  await store.mutate(draft => {
    for (const sessionId of ['\ue000', '𐀀', '10', '2']) {
      draft.sessionSchedules[sessionId] = { sessionId, state: 'idle', active: null };
    }
    let sequence = 0;
    for (const [id, sessionId] of [['out-\ue000', 'out-1'], ['out-𐀀', 'out-2']]) {
      draft.outbox[id] = { id, sessionId, state: 'pending', sequence: ++sequence,
        payload: { type: 'session.work' } };
    }
    draft.nextOutboxSequence = 3;
  });
  owner = new (getNative().RustIsolatedOrchestrationStore)(store.file, null, 2000,
    { env: {}, policy: {} }, ownerBinary());
  const rustOrder = owner.request('scheduleRecoverSnapshotExperimental', {}).sessions;
  const observed = [];
  await frozenScheduler()({ store, now: () => 1000 }).recover({
    stateForSession: sessionId => { observed.push(sessionId); return null; },
  });
  assert.deepEqual(rustOrder, observed);
  assert.deepEqual(observed, ['10', '2', '\ue000', '𐀀', 'out-1', 'out-2']);
});

test('experimental recovery reads owned facts and matches the frozen scheduler', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-owned-recovery-diff-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cases = [
    { type: 'gateway', classify: 'P', expected: 'D' },
    { type: 'gateway', classify: 'C', expected: 'D' },
    { type: 'worker', classify: 'P', expected: 'P' },
    { type: 'gateway', classify: 'W', expected: 'W' },
    { type: 'gateway', classify: 'D', expected: 'D' },
    { type: 'worker', classify: 'E', expected: 'E' },
    { type: null, classify: null, expected: null },
  ];
  for (const [i, scenario] of cases.entries()) {
    const stores = ['rust', 'oracle'].map(name => createOrchestrationSqliteStore({
      file: path.join(root, `${i}-${name}.sqlite`), now: () => 2000, ownerBinary: ownerBinary(),
    }));
    let owner;
    try {
      for (const store of stores) await store.mutate(draft => {
        draft.sessionSchedules.s = { sessionId: 's', state: 'running', classifyState: 'P',
          active: { entryId: 'active', taskId: 'task', startedAt: 50 }, updatedAt: 50 };
        draft.outbox.a = { id: 'a', sessionId: 's', sequence: 1, state: 'pending',
          payload: { type: 'session.work', message: 'queued' } };
        draft.nextOutboxSequence = 2;
      });
      owner = new (getNative().RustIsolatedOrchestrationStore)(stores[0].file, null, 2000,
        { env: {}, policy: {} }, ownerBinary());
      owner.request('sessionWorkState', { action: 'readOrInitialize', sessionId: 's', initial: {
        pendingQuestion: null, activeTurn: { _currentTaskId: 'task' },
        category: { recoveryRecordType: scenario.type, classifyState: scenario.classify,
          startedAt: 50, endedAt: 70 },
      } });
      const events = [];
      const oracle = frozenScheduler()({ store: stores[1], now: () => 1000, onEvent: event => events.push(event) });
      const reference = await oracle.recover({ stateForSession: () => ({
        classifyState: scenario.expected, startedAt: 50, endedAt: 70, taskId: 'task',
      }) });
      const snapshot = await owner.requestAsync('scheduleRecoverOwnedSnapshotExperimental', {});
      assert.equal(Object.hasOwn(snapshot.facts[0], 'stateJson'), false);
      const result = await owner.requestAsync('scheduleRecoverOwnedCommitExperimental', {
        expectedRevision: snapshot.state.revision, expectedDataVersion: snapshot.dataVersion,
        at: 1000, updatedAt: 2000, facts: snapshot.facts,
      });
      const recoveredEvents = decodeRecoveryEvents(result.resultJson);
      assert.deepEqual({ ok: true, changes: recoveredEvents.length }, reference);
      const [actual, expected] = await Promise.all(stores.map(store => store.snapshot()));
      assert.deepEqual(actual.sessionSchedules, expected.sessionSchedules, JSON.stringify(scenario));
      assert.deepEqual(actual.outbox, expected.outbox, JSON.stringify(scenario));
      assert.deepEqual(recoveredEvents.map(projectRecoveryEvent), events.map(projectRecoveryEvent), JSON.stringify(scenario));
    } finally {
      if (owner) owner.request('close', {});
      for (const store of stores) await store.close({ exportRollback: false });
    }
  }
});

test('owned recovery rejects a stale snapshot after a versioned fact update', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-owned-recovery-version-'));
  const store = createOrchestrationSqliteStore({
    file: path.join(root, 'state.sqlite'), now: () => 2000, ownerBinary: ownerBinary(),
  });
  let owner;
  t.after(async () => {
    try { if (owner) owner.request('close', {}); await store.close({ exportRollback: false }); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  await store.mutate(draft => {
    draft.sessionSchedules.s = { sessionId: 's', state: 'running', classifyState: 'P',
      active: { entryId: 'active', taskId: 'task', startedAt: 50 }, updatedAt: 50 };
  });
  owner = new (getNative().RustIsolatedOrchestrationStore)(store.file, null, 2000,
    { env: {}, policy: {} }, ownerBinary());
  await owner.requestAsync('sessionWorkState', { action: 'readOrInitialize', sessionId: 's', initial: {
    pendingQuestion: null, activeTurn: { _currentTaskId: 'task' },
    category: { recoveryRecordType: 'gateway', classifyState: 'P', startedAt: 50, endedAt: 70 },
  } });
  const captured = await owner.requestAsync('scheduleRecoverOwnedSnapshotExperimental', {});
  const update = { action: 'patchFacts', sessionId: 's',
    categoryPatch: { recoveryRecordType: 'worker', classifyState: 'W' } };
  await owner.requestAsync('sessionWorkQuestionExperimental', { requestJson: JSON.stringify(update) });
  const args = { expectedRevision: captured.state.revision, expectedDataVersion: captured.dataVersion,
    at: 1000, updatedAt: 2000, facts: captured.facts };
  await assert.rejects(owner.requestAsync('scheduleRecoverOwnedCommitExperimental', args),
    /recovery fact version conflict/);
  assert.equal((await store.snapshot()).sessionSchedules.s.state, 'running');
  const fresh = await owner.requestAsync('scheduleRecoverOwnedSnapshotExperimental', {});
  const freshArgs = {
    ...args, expectedRevision: fresh.state.revision, expectedDataVersion: fresh.dataVersion, facts: fresh.facts,
  };
  await assert.rejects(owner.requestAsync('scheduleRecoverOwnedCommitExperimental', {
    ...freshArgs, facts: fresh.facts.map(fact => ({ ...fact, classifyState: 'D' })),
  }), /only session id and version/);
  assert.equal((await store.snapshot()).sessionSchedules.s.state, 'running');
  await owner.requestAsync('scheduleRecoverOwnedCommitExperimental', freshArgs);
  const saved = (await store.snapshot()).sessionSchedules.s;
  assert.equal(saved.state, 'frozen');
  assert.equal(saved.freezeReason, 'classify_waiting');
});
