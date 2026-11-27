'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createOrchestrationStore } = require('../src/native/binding').orchestrationJson;
const { createOrchestrationSqliteStore } = require('../src/native/binding').orchestrationSqlite;

function frozenScheduler() {
  const Module = require('node:module');
  const filename = path.resolve(__dirname, '../src/session-work/scheduler.js');
  const module = new Module(filename);
  module.filename = filename;
  module.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = module.require.bind(module);
  module.require = id => id === './user-input'
    ? require('./helpers/legacy-session-work-user-input') : originalRequire(id);
  const source = fs.readFileSync(path.join(__dirname, 'helpers/scheduler-before-domain-migration.js.txt'), 'utf8');
  assert.equal(require('node:crypto').createHash('sha256').update(source).digest('hex'),
    'f2d34115aa9f3dff98bd49c19ad5d34f30a9fbeb3735b524ddf069eb0b32dbb9');
  module._compile(source, filename);
  return module.exports.createSessionWorkScheduler;
}

test('completion samples the store clock after exactly the original mutator boundary', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-complete-order-'));
  const stores = [];
  t.after(async () => { for (const store of stores) if (store.close) await store.close({ exportRollback: false }); fs.rmSync(dir, { recursive: true, force: true }); });
  for (const kind of ['json', 'sqlite']) {
    let phase = 0;
    let observe = false;
    const seen = [];
    const storeNow = () => { if (observe) seen.push(phase); return 1200; };
    const store = kind === 'json' ? createOrchestrationStore({ file: path.join(dir, 'legacy.json'), now: storeNow })
      : createOrchestrationSqliteStore({ file: path.join(dir, 'native.sqlite'), now: storeNow });
    stores.push(store);
    await store.mutate(draft => {
      draft.sessionSchedules.s = { sessionId: 's', state: 'running', active: { entryId: 'entry', taskId: 'task' }, classifyState: 'P' };
    });
    const scheduler = frozenScheduler()({ store, now: () => 1000, getPendingUserInput() {
      queueMicrotask(() => { phase = 1; queueMicrotask(() => { phase = 2; }); });
      return { requestId: 'question' };
    } });
    observe = true;
    const result = await scheduler.complete('s', { expectedTaskId: 'task', classifyState: 'W' });
    assert.equal(result.ok, true);
    assert.equal(seen[0], 1, `${kind}: store clock must run before the nested microtask`);
    assert.equal((await store.snapshot()).sessionSchedules.s.classifyState, 'W');

    // A worker-like yield inserted before the draft finishes changes when the
    // actual store samples its injected clock, even when no data races occur.
    observe = false;
    phase = 0;
    seen.length = 0;
    await store.mutate(draft => {
      draft.sessionSchedules.s = { sessionId: 's', state: 'running', active: { entryId: 'entry', taskId: 'task' }, classifyState: 'P' };
    });
    const workerStore = {
      read: (...args) => store.read(...args),
      mutate: fn => store.mutate(async draft => {
        const result = fn(draft);
        await new Promise(resolve => setImmediate(resolve));
        return result;
      }),
    };
    const withWorkerYield = frozenScheduler()({ store: workerStore, now: () => 1000, getPendingUserInput() {
      queueMicrotask(() => { phase = 1; queueMicrotask(() => { phase = 2; }); });
      return { requestId: 'question' };
    } });
    observe = true;
    assert.equal((await withWorkerYield.complete('s', { expectedTaskId: 'task', classifyState: 'W' })).ok, true);
    assert.equal(seen[0], 2, `${kind}: an extra worker yield changes the observable clock value`);
  }
});

test('Rust completion bridge preserves clock ordering and skips the clock on guard rejection', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-complete-bridge-order-'));
  let phase = 0;
  let observe = false;
  const seen = [];
  const store = createOrchestrationSqliteStore({ file: path.join(dir, 'state.sqlite'),
    now: () => { if (observe) seen.push(phase); return 1200; } });
  t.after(async () => {
    try { await store.close({ exportRollback: false }); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  await store.sessionWorkState({ action: 'readOrInitialize', sessionId: 's', initial: {
    pendingQuestion: { requestId: 'q', taskId: 'task' }, activeTurn: null, category: null,
  } });
  await store.mutate(draft => {
    draft.sessionSchedules.s = { sessionId: 's', state: 'running',
      active: { entryId: 'entry', taskId: 'task' }, classifyState: 'P' };
  });
  let clockCalls = 0;
  const clock = () => {
    clockCalls++;
    queueMicrotask(() => { phase = 1; queueMicrotask(() => { phase = 2; }); });
    return 1000;
  };
  observe = true;
  assert.deepEqual(await store.executeScheduleComplete({ sessionId: 's', expectedTaskId: 'other', clock }),
    { ok: false, code: 'active_task_mismatch' });
  assert.deepEqual(await store.executeScheduleComplete({ sessionId: 'missing', clock }),
    { ok: false, code: 'no_active_task' });
  assert.equal(clockCalls, 0);
  assert.deepEqual(seen, []);
  assert.equal((await store.executeScheduleComplete({ sessionId: 's', expectedTaskId: 'task',
    classifyState: 'W', clock })).ok, true);
  assert.equal(clockCalls, 1);
  assert.equal(seen[0], 1, 'store clock runs before the nested microtask');
});

test('Rust completion initializes live facts in the same transaction and rolls back on failure', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-complete-lazy-facts-'));
  const file = path.join(dir, 'state.sqlite');
  const store = createOrchestrationSqliteStore({ file, now: () => 1200 });
  const db = new (require('better-sqlite3'))(file);
  t.after(async () => {
    try { db.close(); await store.close({ exportRollback: false }); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  await store.mutate(draft => {
    draft.sessionSchedules.s = { sessionId: 's', state: 'running', classifyState: 'P',
      active: { entryId: 'entry', taskId: 'task' } };
    draft.outbox.a = { id: 'a', sessionId: 's', state: 'pending', sequence: 1,
      payload: { type: 'session.work', message: 'queued' }, directRun: true };
    draft.nextOutboxSequence = 2;
  });
  const command = { sessionId: 's', expectedTaskId: 'task', classifyState: 'W', clock: () => 1000 };
  await assert.rejects(store.executeScheduleComplete(command), /backfill requires a trusted snapshot/);
  await assert.rejects(store.executeScheduleComplete({ ...command,
    initialState: { pendingQuestion: null, activeTurn: null } }), /backfill requires category/);
  assert.equal((await store.sessionWorkState({ action: 'read', sessionId: 's' })).exists, false);
  const initialState = { pendingQuestion: { requestId: 'q', taskId: 'task', question: '\ud800' },
    activeTurn: null, category: { classifyState: 'W' } };
  db.exec("CREATE TRIGGER reject_completion BEFORE UPDATE ON orchestration_session_schedules BEGIN SELECT RAISE(ABORT, 'reject lazy completion'); END");
  await assert.rejects(store.executeScheduleComplete({ ...command, initialState }), /reject lazy completion/);
  assert.equal((await store.sessionWorkState({ action: 'read', sessionId: 's' })).exists, false);
  assert.equal((await store.snapshot()).outbox.a.directRun, true);
  db.exec('DROP TRIGGER reject_completion');
  const result = await store.executeScheduleComplete({ ...command, initialState });
  assert.equal(result.ok, true);
  const saved = await store.sessionWorkState({ action: 'read', sessionId: 's' });
  assert.equal(saved.version, 1);
  assert.deepEqual(saved.pendingQuestion, initialState.pendingQuestion);
  assert.equal((await store.snapshot()).outbox.a.blockedByUserInput, 'q');
});
