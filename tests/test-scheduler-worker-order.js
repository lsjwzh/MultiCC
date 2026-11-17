'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createOrchestrationSqliteStore } = require('../src/orchestration/sqlite-store');
const { createSessionWorkScheduler } = require('../src/session-work/scheduler');

function frozenScheduler() {
  const Module = require('node:module');
  const filename = path.resolve(__dirname, '../src/session-work/scheduler.js');
  const module = new Module(filename);
  module.filename = filename;
  module.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = module.require.bind(module);
  module.require = id => id === './user-input'
    ? require('./helpers/legacy-session-work-user-input') : originalRequire(id);
  const snapshot = fs.readFileSync(path.join(__dirname, 'helpers/scheduler-before-domain-migration.js.txt'), 'utf8');
  assert.equal(require('node:crypto').createHash('sha256').update(snapshot).digest('hex'),
    'f2d34115aa9f3dff98bd49c19ad5d34f30a9fbeb3735b524ddf069eb0b32dbb9');
  module._compile(snapshot, filename);
  return module.exports.createSessionWorkScheduler;
}

function delayedMutator(store) {
  return {
    read: (...args) => store.read(...args),
    mutate: callback => store.mutate(async draft => {
      // Model waiting for a worker snapshot before the state-machine callback.
      await new Promise(resolve => setImmediate(resolve));
      return callback(draft);
    }),
  };
}
async function openStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-schedule-worker-order-'));
  const store = createOrchestrationSqliteStore({ file: path.join(dir, 'state.sqlite'), now: () => 1000 });
  t.after(async () => { await store.close({ exportRollback: false }); fs.rmSync(dir, { recursive: true, force: true }); });
  await store.sessionWorkState({ action: 'readOrInitialize', sessionId: 's', initial: {
    pendingQuestion: null, activeTurn: null, category: null,
  } });
  return store;
}

test('reorder reads a dynamic index before a caller microtask changes it', async t => {
  const store = await openStore(t);
  const seed = async () => store.mutate(draft => {
    draft.sessionSchedules.s = { sessionId: 's', state: 'idle', active: null };
    draft.outbox.a = { id: 'a', sessionId: 's', sequence: 1, state: 'pending', payload: { type: 'session.work', message: 'a' } };
    draft.outbox.b = { id: 'b', sessionId: 's', sequence: 2, state: 'pending', payload: { type: 'session.work', message: 'b' } };
    draft.nextOutboxSequence = 3;
  });
  const run = async worker => {
    let index = 0;
    const toIndex = { valueOf() { return index; } };
    const scheduler = (worker ? frozenScheduler() : createSessionWorkScheduler)({
      store: worker ? delayedMutator(store) : store, now: () => 1000,
    });
    const result = scheduler.reorderQueued('s', 'a', { toIndex });
    queueMicrotask(() => { index = 1; });
    return result;
  };
  await seed();
  assert.equal((await run(false)).unchanged, true);
  await seed();
  const delayed = await run(true);
  assert.equal(delayed.unchanged, false);
  assert.equal(delayed.reordered.to, 1);
  await seed();
  const slicedActor = await createSessionWorkScheduler({ store, now: () => 1000 })
    .reorderQueued('s', 'b', { toIndex: 0, actor: `${'a'.repeat(79)}😀` });
  assert.equal(slicedActor.reordered.actor, `${'a'.repeat(79)}\ud83d`);
  await seed();
  const before = await store.snapshot();
  const stateBefore = await store.sessionWorkState({ action: 'read', sessionId: 's' });
  const throwingIndex = { valueOf() { throw new Error('index observation failed'); } };
  const scheduler = createSessionWorkScheduler({ store, now: () => 1000 });
  assert.equal((await scheduler.reorderQueued('s', 'missing', { toIndex: throwingIndex })).code,
    'queued_entry_not_found');
  await assert.rejects(scheduler.reorderQueued('s', 'b', { toIndex: throwingIndex }), /index observation failed/);
  assert.deepEqual(await store.snapshot(), before);
  const db = new (require('better-sqlite3'))(store.file);
  try {
    db.exec("CREATE TRIGGER fail_reorder BEFORE UPDATE ON orchestration_outbox BEGIN SELECT RAISE(ABORT, 'blocked reorder'); END");
    await assert.rejects(createSessionWorkScheduler({ store, now: () => 1000 })
      .reorderQueued('s', 'b', { toIndex: 0 }), /blocked reorder/);
    assert.deepEqual(await store.snapshot(), before);
    assert.deepEqual(await store.sessionWorkState({ action: 'read', sessionId: 's' }), stateBefore);
    db.exec('DROP TRIGGER fail_reorder');
    await store.mutate(draft => { delete draft.sessionSchedules.s; });
    let ticks = 1100;
    const missingSchedule = await createSessionWorkScheduler({ store, now: () => ticks += 100 })
      .reorderQueued('s', 'a', { toIndex: 0 });
    assert.equal(missingSchedule.unchanged, true);
    assert.equal(missingSchedule.schedule.updatedAt, 1200);
    assert.equal(missingSchedule.reordered.at, 1300);
    assert.equal((await store.snapshot()).sessionSchedules.s.updatedAt, 1200);
    await store.mutate(draft => { delete draft.sessionSchedules.s; draft.outbox.b.state = 'leased'; });
    let guardTicks = 0;
    const guarded = await createSessionWorkScheduler({ store, now: () => ++guardTicks })
      .reorderQueued('s', 'b', { toIndex: throwingIndex });
    assert.equal(guarded.code, 'queued_entry_already_claimed');
    assert.equal(guardTicks, 1);
    assert.equal((await store.snapshot()).sessionSchedules.s.updatedAt, 1);
  } finally { db.close(); }
});

test('Rust reorder initializes live facts in its transaction and rolls back on failure', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-reorder-lazy-facts-'));
  const file = path.join(dir, 'state.sqlite');
  const store = createOrchestrationSqliteStore({ file, now: () => 1000 });
  const db = new (require('better-sqlite3'))(file);
  t.after(async () => {
    try { db.close(); await store.close({ exportRollback: false }); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  await store.mutate(draft => {
    draft.sessionSchedules.s = { sessionId: 's', state: 'idle', active: null };
    draft.outbox.a = { id: 'a', sessionId: 's', sequence: 1, state: 'pending', payload: { type: 'session.work', message: 'a' } };
    draft.outbox.b = { id: 'b', sessionId: 's', sequence: 2, state: 'pending', payload: { type: 'session.work', message: 'b' } };
    draft.nextOutboxSequence = 3;
  });
  const command = { sessionId: 's', entryId: 'b', toIndex: 0, actor: 'user', now: () => 1000 };
  await assert.rejects(store.mutateSync('scheduleReorder', command), /backfill requires a trusted snapshot/);
  await assert.rejects(store.mutateSync('scheduleReorder', { ...command,
    initialState: { pendingQuestion: null, category: 'W' } }), /backfill requires activeTurn/);
  assert.equal((await store.sessionWorkState({ action: 'read', sessionId: 's' })).exists, false);
  const initialState = { pendingQuestion: { requestId: 'q' }, activeTurn: null, category: 'W' };
  db.exec("CREATE TRIGGER reject_reorder BEFORE UPDATE ON orchestration_outbox BEGIN SELECT RAISE(ABORT, 'reject lazy reorder'); END");
  await assert.rejects(store.mutateSync('scheduleReorder', { ...command, initialState }), /reject lazy reorder/);
  assert.equal((await store.sessionWorkState({ action: 'read', sessionId: 's' })).exists, false);
  db.exec('DROP TRIGGER reject_reorder');
  const result = await store.mutateSync('scheduleReorder', { ...command, initialState });
  assert.equal(result.ok, true);
  assert.equal(result.reordered.to, 0);
  const saved = await store.sessionWorkState({ action: 'read', sessionId: 's' });
  assert.equal(saved.version, 1);
  assert.deepEqual(saved.pendingQuestion, initialState.pendingQuestion);
});

test('recovery reads classify facts before a caller microtask changes them', async t => {
  const store = await openStore(t);
  const seed = async () => store.mutate(draft => {
    delete draft.sessionSchedules.s;
    draft.outbox.a = { id: 'a', sessionId: 's', sequence: 1, state: 'pending', payload: { type: 'session.work', message: 'a' } };
    draft.nextOutboxSequence = 2;
  });
  const run = async worker => {
    let classify = 'W';
    const scheduler = createSessionWorkScheduler({ store: worker ? delayedMutator(store) : store, now: () => 1000 });
    const result = scheduler.recover({ stateForSession: () => ({ classifyState: classify }) });
    queueMicrotask(() => { classify = 'D'; });
    await result;
    return (await store.snapshot()).sessionSchedules.s;
  };
  await seed();
  const original = await run(false);
  assert.equal(original.classifyState, 'W');
  assert.equal(original.state, 'frozen');
  await seed();
  const delayed = await run(true);
  assert.equal(delayed.classifyState, 'D');
  assert.equal(delayed.state, 'idle');
});

test('reorder uses Rust with a synchronous commit and nonblocking queue preparation', () => {
  // The SQLite regression above proves that awaiting a worker before the
  // mutator changes the observed index. A real SQLite run with 160 pending
  // rows delayed a zero-delay timer by 117 ms, so moving the existing scan to
  // a synchronous NAPI command is not a nonblocking migration either.
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'session-work', 'scheduler.js'), 'utf8');
  const start = source.indexOf('  async function reorderQueued(');
  const end = source.indexOf('  async function editQueued(', start);
  assert.ok(start >= 0 && end > start, 'reorderQueued implementation is present');
  const body = source.slice(start, end);
  assert.ok(!/candidate\.queueOrder\s*=/.test(body),
    'reorderQueued still owns the Node queue mutation; worker preparation must preserve the current synchronous index observation');
  assert.ok(/store\.mutateSync\s*\(/.test(body),
    'reorderQueued must commit synchronously without an intervening microtask');
});

test('recovery uses Rust with a synchronous commit and nonblocking session preparation', () => {
  // The SQLite regression above shows worker preparation before the callback
  // changes the observed classify fact. A real SQLite run with 1000 sessions
  // delayed a zero-delay timer by 210 ms on the current synchronous scan.
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'session-work', 'scheduler.js'), 'utf8');
  const start = source.indexOf('  async function recover({');
  const end = source.indexOf('\n  return Object.freeze(', start);
  assert.ok(start >= 0 && end > start, 'recover implementation is present');
  const body = source.slice(start, end);
  assert.ok(!/schedule\.(?:active|state|classifyState)\s*=/.test(body),
    'recover still owns Node state transitions; worker preparation must preserve synchronous classify observations');
  assert.ok(/store\.mutateSync\s*\(/.test(body),
    'recover must commit synchronously without an intervening microtask');
});
