'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createOrchestrationSqliteStore } = require('../src/orchestration/sqlite-store');
const { createSessionWorkScheduler } = require('../src/session-work/scheduler');

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
    const scheduler = createSessionWorkScheduler({ store: worker ? delayedMutator(store) : store, now: () => 1000 });
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
