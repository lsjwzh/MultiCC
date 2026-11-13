'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createOrchestrationStore } = require('../src/orchestration/store');
const { createOrchestrationSqliteStore } = require('../src/orchestration/sqlite-store');
const { createSessionWorkScheduler } = require('../src/session-work/scheduler');

test('noteQueued creates the schedule and returns the same queue event on JSON and SQLite', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-schedule-note-'));
  const stores = [];
  t.after(async () => { for (const store of stores) if (store.close) await store.close({ exportRollback: false }); fs.rmSync(dir, { recursive: true, force: true }); });
  const results = [];
  for (const kind of ['json', 'sqlite']) {
    const now = () => 1000;
    const store = kind === 'json' ? createOrchestrationStore({ file: path.join(dir, 'legacy.json'), now })
      : createOrchestrationSqliteStore({ file: path.join(dir, 'native.sqlite'), now });
    stores.push(store);
    await store.mutate(draft => {
      draft.outbox.q = { id: 'q', sessionId: 's', sequence: 1, state: 'pending', attempts: 0,
        payload: { type: 'session.work', message: 'hello', options: { clientMsgId: 'client' } }, source: { type: 'chat' } };
      draft.nextOutboxSequence = 2;
    });
    const events = [];
    const scheduler = createSessionWorkScheduler({ store, now, onEvent: event => events.push(event) });
    const result = await scheduler.noteQueued('q');
    results.push({ result, events, state: await store.snapshot() });
  }
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(results[0].result, { ok: true, position: 1 });
  assert.equal(results[0].events[0].queued, false);
  assert.equal(results[0].events[0].message, 'hello');
  assert.equal(results[0].state.sessionSchedules.s.state, 'idle');
});

test('noteQueued preserves clock, selection and clone error order without emitting', async () => {
  const events = [];
  const sentinel = new Error('clone failed');
  const item = { id: 'q', sessionId: 's', sequence: 1, state: 'pending', payload: { type: 'session.work', message: 'x' },
    toJSON() { events.push('clone'); throw sentinel; } };
  const draft = { sessionSchedules: { s: { sessionId: 's', state: 'idle', active: null } }, outbox: { q: item } };
  const store = { mutate: async callback => callback(draft), read: async callback => callback(draft) };
  const scheduler = createSessionWorkScheduler({ store,
    now() { events.push('clock'); return 1000; },
    getPendingUserInput() { events.push('pending'); return null; },
    onEvent() { events.push('emit'); },
  });
  await assert.rejects(scheduler.noteQueued('q'), error => error === sentinel);
  assert.deepEqual(events, ['clock', 'pending', 'clone']);
});

test('noteQueued does not sample the clock or create a schedule for a missing entry', async () => {
  const draft = { sessionSchedules: {}, outbox: {} };
  const store = { mutate: async callback => callback(draft), read: async callback => callback(draft) };
  const scheduler = createSessionWorkScheduler({ store, now() { throw new Error('clock called'); } });
  assert.deepEqual(await scheduler.noteQueued('missing'), { ok: false, code: 'entry_not_found' });
  assert.deepEqual(draft.sessionSchedules, {});
});
