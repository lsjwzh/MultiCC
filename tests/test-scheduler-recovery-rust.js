'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createOrchestrationSqliteStore } = require('../src/orchestration/sqlite-store');
const { addonPath, getNative } = require('../src/native/runtime');
const { decodeRecoveryEvents } = require('../src/session-work/recovery-transport');

function ownerBinary() {
  return process.env.MULTICC_TEST_ORCHESTRATION_OWNER || path.join(path.dirname(addonPath()),
    process.platform === 'win32' ? 'multicc-gateway.exe' : 'multicc-gateway');
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
      const project = event => ({ type: event.type, sessionId: event.sessionId,
        entryId: event.entryId || null, taskId: event.taskId || null,
        queued: event.queued == null ? null : event.queued, queuedItems: event.queuedItems || [],
        freezeReason: event.type === 'frozen' ? (event.reason || event.freezeReason) : null,
        classifyState: event.classifyState || null, turnOutcome: event.turnOutcome || null });
      assert.deepEqual(events.map(project), emitted.map(project), JSON.stringify(scenario));
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
