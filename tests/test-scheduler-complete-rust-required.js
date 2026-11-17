'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const test = require('node:test');
const Database = require('better-sqlite3');
const { createOrchestrationSqliteStore } = require('../src/orchestration/sqlite-store');
const { createSessionWorkScheduler } = require('../src/session-work/scheduler');

test('real SQLite exposes the pending-queue event-loop cost of W completion', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-complete-acceptance-'));
  const file = path.join(dir, 'state.sqlite');
  const store = createOrchestrationSqliteStore({ file, now: () => 1000 });
  t.after(async () => {
    await store.close({ exportRollback: false });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await store.sessionWorkState({ action: 'readOrInitialize', sessionId: 's', initial: {
    pendingQuestion: { requestId: 'question' }, activeTurn: null, category: 'W',
  } });
  await store.mutate(draft => {
    draft.sessionSchedules.s = { sessionId: 's', active: { entryId: 'active', deliveryId: 'active', taskId: 'task' },
      state: 'running', classifyState: 'P' };
  });
  // Seed directly through an isolated SQLite connection so the benchmark
  // measures completion rather than the cost of creating its test records.
  const db = new Database(file);
  const insert = db.prepare('INSERT INTO orchestration_outbox(id,data_json,session_id,state,sequence,available_at,updated_at) VALUES(?,?,?,?,?,?,?)');
  db.transaction(() => {
    for (let i = 0; i < 1000; i++) {
      const id = `q${i}`;
      const item = { id, sessionId: 's', state: 'pending', sequence: i + 1, availableAt: 1, createdAt: 1,
        payload: { type: 'session.work', workKind: 'task', message: 'x' } };
      insert.run(id, JSON.stringify(item), 's', 'pending', i + 1, 1, 1);
    }
  })();
  db.close();
  const scheduler = createSessionWorkScheduler({ store, now: () => 1000,
    getPendingUserInput: () => ({ requestId: 'question' }) });
  const start = performance.now();
  let delay;
  const timer = new Promise(resolve => setTimeout(() => { delay = performance.now() - start; resolve(); }, 0));
  const result = await scheduler.complete('s', { expectedTaskId: 'task', classifyState: 'W' });
  await timer;
  assert.equal(result.ok, true);
  assert.equal(result.schedule.queued.length, 1000);
  t.diagnostic(`1,000 pending rows: zero-delay timer waited ${delay.toFixed(1)} ms`);
  assert.ok(delay < 750, `1,000 pending rows blocked the event loop for ${delay.toFixed(1)} ms`);
});

test('isolated Rust completion handles 1,000 queued records without stalling Node', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-complete-rust-latency-'));
  const file = path.join(dir, 'state.sqlite');
  const store = createOrchestrationSqliteStore({ file, now: () => 1000 });
  t.after(async () => {
    try { await store.close({ exportRollback: false }); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  await store.sessionWorkState({ action: 'readOrInitialize', sessionId: 's', initial: {
    pendingQuestion: { requestId: 'question', taskId: 'task', resolved: false },
    activeTurn: null, category: 'W',
  } });
  await store.mutate(draft => {
    draft.sessionSchedules.s = { sessionId: 's', active: { entryId: 'active', taskId: 'task' },
      state: 'running', classifyState: 'P' };
  });
  const db = new Database(file);
  try {
    const insert = db.prepare('INSERT INTO orchestration_outbox(id,data_json,session_id,state,sequence,available_at,updated_at) VALUES(?,?,?,?,?,?,?)');
    db.transaction(() => {
      for (let i = 0; i < 1000; i++) {
        const id = `q${i}`;
        const item = { id, sessionId: 's', state: 'pending', sequence: i + 1, availableAt: 1,
          payload: { type: 'session.work', workKind: 'task', message: 'x' } };
        insert.run(id, JSON.stringify(item), 's', 'pending', i + 1, 1, 1);
      }
    })();
  } finally { db.close(); }
  const events = [];
  const scheduler = createSessionWorkScheduler({ store, now: () => 1000, rustQuestionOwner: true,
    getPendingUserInput() { throw new Error('owned questions must not be read from Node'); },
    onEvent: event => events.push(event) });
  const start = performance.now();
  let delay;
  const timer = new Promise(resolve => setTimeout(() => { delay = performance.now() - start; resolve(); }, 0));
  const result = await scheduler.complete('s', { expectedTaskId: 'task', classifyState: 'W' });
  await timer;
  assert.equal(result.ok, true);
  assert.equal(result.schedule.queued.length, 1000);
  assert.equal(events.filter(event => event.type === 'completed').length, 1);
  assert.ok(delay < 750, `isolated Rust completion blocked the event loop for ${delay.toFixed(1)} ms`);
  const verify = new Database(file, { readonly: true });
  try {
    assert.equal(verify.prepare("SELECT count(*) AS n FROM orchestration_outbox WHERE json_extract(data_json,'$.blockedByUserInput')='question'").get().n, 1000);
  } finally { verify.close(); }
  t.diagnostic(`isolated Rust completion: timer ${delay.toFixed(1)} ms, total ${(performance.now() - start).toFixed(1)} ms`);
});

// Intentional failing acceptance guard until the entire W completion, including
// the pending-outbox updates, runs in Rust and commits in the same synchronous
// host callback. Moving the existing loop to synchronous N-API is insufficient:
// a real SQLite run with 1,000 pending rows delayed a zero-delay timer by 1.39 s.
// A worker yield between the pending-user-input callback and commit changes the
// clock observation; see test-scheduler-complete-order.js for that regression.
test('scheduler completion is a Rust command with no JavaScript domain mutation', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/session-work/scheduler.js'), 'utf8');
  const start = source.indexOf('  async function complete(');
  const end = source.indexOf('  async function settlePersistedDelivery(', start);
  assert.ok(start >= 0 && end > start, 'cannot locate scheduler completion');
  const body = source.slice(start, end);
  assert.equal(/\b(?:schedule|item)\.[\w$]+\s*=(?!=)|draft\.select\s*\(/.test(body), false,
    'scheduler.complete still mutates schedule/outbox and scans pending rows in Node; a synchronous Rust port alone would keep the unbounded event-loop stall');
  assert.match(body, /(?:getNative\(\)\.scheduleComplete\w*\(|store\.executeScheduleComplete\()/,
    'scheduler.complete must call a Rust domain command');
  assert.match(body, /(?:store\.mutateSync\(|store\.executeScheduleComplete\()/,
    'the command must commit within the same synchronous host callback');
});
