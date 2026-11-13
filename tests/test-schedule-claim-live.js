'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { getNative } = require('../src/native/runtime');
const { createOrchestrationSqliteStore } = require('../src/orchestration/sqlite-store');
const { createSessionWorkScheduler } = require('../src/session-work/scheduler');

// Frozen pre-migration transition, retained only as a behavior oracle.
function legacy(draft, item, now, project) {
  const controls = new Set(['answer', 'approval', 'callback', 'continuation', 'retry', 'resume']);
  function kind(item) {
    const transfer = item?.turnLineage?.workKind;
    if (transfer) return transfer;
    const payload = item?.payload || {};
    if (payload.type === 'session.work') return payload.workKind || 'task';
    if (payload.type === 'dispatch.request') return payload.taskStart === false && payload.taskId ? 'continuation' : 'task';
    if (payload.type === 'wait.result' || payload.type === 'wait.callback' || payload.type === 'wait.resolved'
        || payload.type === 'detached.result' || payload.type === 'dispatch.result' || payload.type === 'task.interrupted') return 'callback';
    return payload.originContinue === true ? 'continuation' : 'task';
  }
  function ownPayload(item) { return item?.payload?.type === 'dispatch.result' ? null : item?.payload; }
  function task(item) { return item?.turnLineage?.taskId || ownPayload(item)?.taskId || null; }
  function origin(item) { return item?.turnLineage?.originDispatchId || item?.payload?.originDispatchId
    || (item?.payload?.type === 'dispatch.request' ? item.payload.operationId : null) || null; }
  function replay(schedule, item) {
    if (!schedule?.active || !item) return false;
    const active = schedule.active.deliveryId || schedule.active.entryId;
    return !!active && item.id === active;
  }
  function related(schedule, item) {
    if (!schedule?.active || !controls.has(kind(item))) return false;
    const payload = item.payload || {};
    if (payload.type === 'session.work') return true;
    if (payload.activeEntryId && payload.activeEntryId !== schedule.active.entryId) return false;
    const activeTask = () => schedule?.active?.taskId || null;
    if (payload.type !== 'task.interrupted' && payload.type !== 'dispatch.result' && payload.taskId
        && activeTask() && payload.taskId !== activeTask()) return false;
    if (kind(item) === 'answer' && schedule.awaitingRequestId && payload.requestId !== schedule.awaitingRequestId) return false;
    return true;
  }
  const current = draft.outbox[item.id];
  if (!current || current.state !== 'leased') return { ok: false, code: 'delivery_not_leased' };
  const at = Number(now());
  const sid = item.sessionId;
  if (!draft.sessionSchedules[sid]) draft.sessionSchedules[sid] = {
    sessionId: sid, state: 'idle', freezeReason: null, awaitingRequestId: null,
    classifyState: null, classifyStateAt: null, priorityEntryId: null, active: null, lastDecision: null, updatedAt: at,
  };
  const schedule = draft.sessionSchedules[sid];
  if (!schedule.active || schedule.state === 'idle') {
    schedule.active = { entryId: item.id, deliveryId: item.id, taskId: task(item), originDispatchId: origin(item),
      source: item.payload?.source || item.source?.type || 'legacy', workKind: kind(item), admittedAt: item.createdAt,
      claimedAt: at, startedAt: null, attempt: item.attempts };
    if (schedule.priorityEntryId === item.id) schedule.priorityEntryId = null;
  } else if (replay(schedule, item) || related(schedule, item)) {
    schedule.active.deliveryId = item.id;
    schedule.active.workKind = kind(item);
    schedule.active.attempt = item.attempts;
    if (!schedule.active.taskId && task(item)) schedule.active.taskId = task(item);
    if (!schedule.active.originDispatchId && origin(item)) schedule.active.originDispatchId = origin(item);
  } else return { ok: false, code: 'session_gate_closed' };
  schedule.state = 'starting'; schedule.freezeReason = null; schedule.updatedAt = at;
  return { ok: true, schedule: project(schedule) };
}

function instrument(value, log, cache = new WeakMap(), label = 'root') {
  if (!value || typeof value !== 'object') return value;
  if (cache.has(value)) return cache.get(value);
  const proxy = new Proxy(value, {
    get(target, key, receiver) {
      if (typeof key === 'symbol') return Reflect.get(target, key, receiver);
      log.push(`get:${label}.${key}`);
      return instrument(Reflect.get(target, key, receiver), log, cache, `${label}.${key}`);
    },
    set(target, key, next, receiver) { log.push(`set:${label}.${String(key)}`); return Reflect.set(target, key, next, receiver); },
  });
  cache.set(value, proxy);
  return proxy;
}

function runTransition(fn, input, schedule, current) {
  const log = [];
  const draft = instrument({ outbox: { e: current }, sessionSchedules: schedule ? { s: schedule } : {} }, log);
  const item = instrument(input, log, new WeakMap(), 'item');
  const now = () => { log.push('clock'); return 101; };
  const project = schedule => { log.push('project'); return schedule; };
  let result; let error;
  try { result = fn(draft, item, now, project); } catch (caught) { error = caught; }
  const reads = [...log];
  const serial = error ? { name: error.name, message: error.message } : JSON.parse(JSON.stringify(result));
  return { serial, reads, draft: JSON.parse(JSON.stringify(draft)) };
}

test('schedule claim Rust transition matches legacy decisions and getter order', () => {
  const item = { id: 'e', sessionId: 's', attempts: 2, createdAt: 9,
    payload: { type: 'session.work', workKind: 'answer', requestId: 'r', taskId: 't', source: 'human' } };
  const cases = [
    [null, null],
    [null, { state: 'leased' }],
    [{ state: 'idle', active: null, priorityEntryId: 'e' }, { state: 'leased' }],
    [{ state: 'running', active: { entryId: 'e', deliveryId: 'e', taskId: null }, priorityEntryId: null }, { state: 'leased' }],
    [{ state: 'frozen', active: { entryId: 'old', deliveryId: 'old', taskId: 't' }, awaitingRequestId: 'r' }, { state: 'leased' }],
    [{ state: 'running', active: { entryId: 'old', deliveryId: 'old', taskId: 'other' } }, { state: 'leased' }],
  ];
  for (const [schedule, current] of cases) {
    const a = runTransition(legacy, structuredClone(item), structuredClone(schedule), structuredClone(current));
    const b = runTransition(getNative().scheduleClaimLive, structuredClone(item), structuredClone(schedule), structuredClone(current));
    assert.deepEqual(b, a);
  }
  for (const type of ['dispatch.request', 'wait.callback', 'unrecognized', 'dispatch.result']) {
    const input = { id: 'e', sessionId: 's', attempts: 1, payload: { type, taskId: 't', operationId: 'op' } };
    const a = runTransition(legacy, structuredClone(input), null, { state: 'leased' });
    const b = runTransition(getNative().scheduleClaimLive, structuredClone(input), null, { state: 'leased' });
    assert.deepEqual(b, a, type);
  }
  for (const [type, taskId, entryId] of [
    ['wait.callback', 't', 'old'], ['wait.callback', 'other', 'old'],
    ['task.interrupted', 'child', 'old'], ['dispatch.result', 'child', 'old'],
    ['wait.callback', 't', 'different'], ['unrecognized', 't', 'old'],
  ]) {
    const input = { id: 'e', sessionId: 's', attempts: 1, payload: { type, taskId, activeEntryId: entryId } };
    const schedule = { state: 'running', active: { entryId: 'old', deliveryId: 'old', taskId: 't' } };
    const a = runTransition(legacy, structuredClone(input), structuredClone(schedule), { state: 'leased' });
    const b = runTransition(getNative().scheduleClaimLive, structuredClone(input), structuredClone(schedule), { state: 'leased' });
    assert.deepEqual(b, a, `${type}/${taskId}/${entryId}`);
  }
});

test('schedule claim preserves dynamic getters and propagates the same thrown object', () => {
  function input(trace, shouldThrow = false) {
    let reads = 0;
    const payload = { taskStart: false, taskId: 't' };
    Object.defineProperty(payload, 'type', { enumerable: true, get() {
      trace.push(`type:${++reads}`);
      if (shouldThrow && reads === 3) throw new Error('payload getter failed');
      return reads < 3 ? 'other' : 'dispatch.request';
    } });
    return { id: 'e', sessionId: 's', attempts: 1, payload };
  }
  for (const shouldThrow of [false, true]) {
    const traces = [[], []];
    const a = runTransition(legacy, input(traces[0], shouldThrow), null, { state: 'leased' });
    const b = runTransition(getNative().scheduleClaimLive, input(traces[1], shouldThrow), null, { state: 'leased' });
    assert.deepEqual(b, a);
    assert.deepEqual(traces[1], traces[0]);
  }
  const sentinel = new Error('sentinel');
  const item = { id: 'e', sessionId: 's', get payload() { throw sentinel; } };
  const draft = { outbox: { e: { state: 'leased' } }, sessionSchedules: {} };
  assert.throws(() => getNative().scheduleClaimLive(draft, item, () => 1, value => value), error => error === sentinel);
});

test('schedule claim persists through SQLite and rolls back on database write failure', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-schedule-claim-'));
  const file = path.join(dir, 'state.sqlite');
  const store = createOrchestrationSqliteStore({ file, now: () => 100 });
  const db = new Database(file);
  t.after(async () => { db.close(); await store.close({ exportRollback: false }); fs.rmSync(dir, { recursive: true, force: true }); });
  await store.mutate(draft => {
    draft.outbox.e = { id: 'e', sessionId: 's', state: 'leased', sequence: 1, attempts: 1, payload: { type: 'session.work' } };
  });
  const scheduler = createSessionWorkScheduler({ store, now: () => 100 });
  const item = { id: 'e', sessionId: 's', attempts: 1, payload: { type: 'session.work' } };
  const before = await store.snapshot();
  db.exec("CREATE TRIGGER fail_schedule BEFORE INSERT ON orchestration_session_schedules BEGIN SELECT RAISE(ABORT,'blocked schedule'); END");
  await assert.rejects(scheduler.claim(item), /blocked schedule/);
  assert.deepEqual(await store.snapshot(), before);
  db.exec('DROP TRIGGER fail_schedule');
  const result = await scheduler.claim(item);
  assert.equal(result.ok, true);
  const snapshot = await store.snapshot();
  assert.equal(snapshot.sessionSchedules.s.state, 'starting');
  assert.equal(snapshot.sessionSchedules.s.active.deliveryId, 'e');
});
