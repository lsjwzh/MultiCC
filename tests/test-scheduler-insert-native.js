'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { createOrchestrationSqliteStore } = require('../src/orchestration/sqlite-store');
const { createSessionWorkScheduler } = require('../src/session-work/scheduler');

test('immediate insertion persists active-task lineage and keeps the admitted payload unchanged', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-schedule-insert-'));
  const store = createOrchestrationSqliteStore({ file: path.join(dir, 'state.sqlite'), now: () => 1000 });
  t.after(async () => { await store.close({ exportRollback: false }); fs.rmSync(dir, { recursive: true, force: true }); });
  const payload = { type: 'session.work', taskId: 'task', originDispatchId: 'op', message: 'hello' };
  await store.mutate(draft => {
    draft.sessionSchedules.s = { sessionId: 's', state: 'running', active: { entryId: 'active', deliveryId: 'active', taskId: 'task', originDispatchId: 'op' } };
    draft.outbox.queued = { id: 'queued', sessionId: 's', sequence: 1, state: 'pending', attempts: 0, payload, payloadHash: 'original' };
    draft.nextOutboxSequence = 2;
  });
  const scheduler = createSessionWorkScheduler({ store, now: () => 1000, getPendingUserInput: () => ({ requestId: 'question' }) });
  const result = await scheduler.insertQueued('s', 'queued', { actor: 'tester' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.inserted, { entryId: 'queued', actor: 'tester', taskId: 'task', originDispatchId: 'op', inheritedLineage: true, at: 1000 });
  const state = await store.snapshot();
  assert.deepEqual(state.outbox.queued.payload, payload);
  assert.equal(state.outbox.queued.payloadHash, 'original');
  assert.deepEqual(state.outbox.queued.turnLineage, { activeEntryId: 'active', inheritedAt: 1000, inheritedBy: 'insert_queued', originDispatchId: 'op', taskId: 'task', workKind: 'continuation' });
  assert.equal(state.outbox.queued.directRun, true);
  assert.equal(state.outbox.queued.userInputOverrideId, 'question');
  assert.equal(state.sessionSchedules.s.active.supersededByEntryId, 'queued');
  assert.equal(state.sessionSchedules.s.active.supersededOriginTransferred, true);
  assert.equal(state.sessionSchedules.s.priorityEntryId, 'queued');
});

test('immediate insertion rolls back both queue and active task on SQLite write failure', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-schedule-insert-rollback-'));
  const file = path.join(dir, 'state.sqlite');
  const store = createOrchestrationSqliteStore({ file, now: () => 1000 });
  const db = new Database(file);
  t.after(async () => { db.close(); await store.close({ exportRollback: false }); fs.rmSync(dir, { recursive: true, force: true }); });
  await store.mutate(draft => {
    draft.sessionSchedules.s = { sessionId: 's', state: 'running', active: { entryId: 'active', deliveryId: 'active', taskId: 'task' } };
    draft.outbox.queued = { id: 'queued', sessionId: 's', sequence: 1, state: 'pending', attempts: 0, payload: { type: 'session.work', message: 'hello' } };
    draft.nextOutboxSequence = 2;
  });
  const before = await store.snapshot();
  db.exec("CREATE TRIGGER block_schedule BEFORE UPDATE ON orchestration_session_schedules BEGIN SELECT RAISE(ABORT, 'blocked schedule'); END");
  const scheduler = createSessionWorkScheduler({ store, now: () => 1000 });
  await assert.rejects(scheduler.insertQueued('s', 'queued'), /blocked schedule/);
  assert.deepEqual(await store.snapshot(), before);
});

test('immediate insertion preserves payload getter and pending-input order on exceptions', async () => {
  const events = [];
  const sentinel = new Error('payload getter failed');
  let reads = 0;
  const item = { id: 'queued', sessionId: 's', sequence: 1, state: 'pending' };
  Object.defineProperty(item, 'payload', { get() { events.push('payload'); if (++reads === 2) throw sentinel; return { type: 'session.work' }; } });
  const draft = { sessionSchedules: { s: { sessionId: 's', state: 'running', active: { entryId: 'active', deliveryId: 'active' } } }, outbox: { queued: item } };
  const store = { mutate: async callback => callback(draft), read: async callback => callback(draft) };
  const scheduler = createSessionWorkScheduler({ store, now() { events.push('clock'); return 1000; }, getPendingUserInput() { events.push('pending'); return null; } });
  await assert.rejects(scheduler.insertQueued('s', 'queued'), error => error === sentinel);
  assert.deepEqual(events, ['clock', 'clock', 'payload', 'payload']);
  assert.equal(item.directRun, undefined);
});

test('an actor coercion error rolls back immediate insertion', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-schedule-insert-actor-'));
  const store = createOrchestrationSqliteStore({ file: path.join(dir, 'state.sqlite'), now: () => 1000 });
  t.after(async () => { await store.close({ exportRollback: false }); fs.rmSync(dir, { recursive: true, force: true }); });
  await store.mutate(draft => {
    draft.sessionSchedules.s = { sessionId: 's', state: 'running', active: { entryId: 'active', deliveryId: 'active' } };
    draft.outbox.queued = { id: 'queued', sessionId: 's', sequence: 1, state: 'pending', payload: { type: 'session.work' } };
    draft.nextOutboxSequence = 2;
  });
  const before = await store.snapshot();
  const sentinel = new Error('actor coercion failed');
  const actor = { toString() { throw sentinel; } };
  const scheduler = createSessionWorkScheduler({ store, now: () => 1000 });
  await assert.rejects(scheduler.insertQueued('s', 'queued', { actor }), error => error === sentinel);
  assert.deepEqual(await store.snapshot(), before);
});
