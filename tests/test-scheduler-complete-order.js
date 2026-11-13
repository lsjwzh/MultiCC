'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createOrchestrationStore } = require('../src/orchestration/store');
const { createOrchestrationSqliteStore } = require('../src/orchestration/sqlite-store');
const { createSessionWorkScheduler } = require('../src/session-work/scheduler');

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
    const scheduler = createSessionWorkScheduler({ store, now: () => 1000, getPendingUserInput() {
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
    const withWorkerYield = createSessionWorkScheduler({ store: workerStore, now: () => 1000, getPendingUserInput() {
      queueMicrotask(() => { phase = 1; queueMicrotask(() => { phase = 2; }); });
      return { requestId: 'question' };
    } });
    observe = true;
    assert.equal((await withWorkerYield.complete('s', { expectedTaskId: 'task', classifyState: 'W' })).ok, true);
    assert.equal(seen[0], 2, `${kind}: an extra worker yield changes the observable clock value`);
  }
});
