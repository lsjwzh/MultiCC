'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { normalizeJson } = require('../src/outbox');
const { createOrchestrationSqliteStore } = require('../src/orchestration/sqlite-store');
const { createSessionWorkScheduler } = require('../src/session-work/scheduler');
const kinds = new Set(['answer', 'approval', 'callback', 'continuation', 'retry', 'resume']);

// Frozen pre-migration preparation, retained only as a differential oracle.
function legacyPrepare({ sessionId, text, options = {}, source = null, requestedKind = null,
  requestId = null, activeEntryId = null, idempotencyKey = null }, cryptoImpl) {
  const cleanSessionId = String(sessionId || '').trim();
  const cleanText = String(text || '').trim();
  if (!cleanSessionId) throw new TypeError('session work requires sessionId');
  if (!cleanText) throw new TypeError('session work requires text');
  const inferredKind = requestedKind || (requestId ? 'answer' : options.retry ? 'retry'
    : options.originContinue === true ? 'continuation' : 'task');
  if (inferredKind !== 'task' && !kinds.has(inferredKind)) throw new TypeError(`invalid session work kind: ${inferredKind}`);
  function compact(value) {
    const out = {};
    for (const [key, child] of Object.entries(value || {})) if (child !== undefined) out[key] = child;
    return normalizeJson(out);
  }
  const normalizedOptions = compact(options);
  const payload = compact({ type: 'session.work', workKind: inferredKind, message: cleanText,
    options: normalizedOptions, source: source || options.taskSource || (options.originTrigger ? 'trigger' : 'direct'),
    taskId: options.taskId || null, originDispatchId: options.originDispatchId || undefined,
    requestId: requestId || null, activeEntryId: activeEntryId || null });
  const key = idempotencyKey || options.deliveryId || options.clientMsgId || options.requestId || null;
  const identity = key ? `key:${key}` : `new:${cryptoImpl.randomUUID()}:${JSON.stringify(payload).length}`;
  const suffix = cryptoImpl.createHash('sha256').update(`${cleanSessionId}\0${identity}`, 'utf8').digest('hex').slice(0, 40);
  return { cleanSessionId, cleanText, inferredKind, normalizedOptions, payload, id: `session-work:${suffix}`, options, requestId };
}
function customCrypto(trace) {
  return {
    randomUUID() { trace.push('uuid'); return 'deterministic-id'; },
    createHash(name) { trace.push(`hash:${name}`); const hash = crypto.createHash(name); return {
      update(...args) { trace.push(`update:${args[1] || ''}`); hash.update(...args); return this; },
      digest(encoding) { trace.push(`digest:${encoding}`); return hash.digest(encoding); },
    }; },
  };
}
function tracedOptions(values, trace) {
  return new Proxy(values, { get(target, key, receiver) {
    if (typeof key === 'string') trace.push(`options:${key}`);
    return Reflect.get(target, key, receiver);
  }, ownKeys(target) { trace.push('options:keys'); return Reflect.ownKeys(target); },
  getOwnPropertyDescriptor(target, key) { trace.push(`options:descriptor:${String(key)}`); return Reflect.getOwnPropertyDescriptor(target, key); } });
}
test('session admission preserves stable IDs, normalized payload and input getter order', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-schedule-admit-baseline-'));
  const store = createOrchestrationSqliteStore({ file: path.join(dir, 'state.sqlite'), now: () => 100 });
  t.after(async () => { await store.close({ exportRollback: false }); fs.rmSync(dir, { recursive: true, force: true }); });
  const cases = [
    { sessionId: ' s ', text: ' hello ', options: {}, idempotencyKey: 'key' },
    { sessionId: 's', text: 'message\ud83d', options: { taskId: 't', originDispatchId: 'o', retry: true } },
    { sessionId: 's', text: 'hello', options: { originContinue: true, taskSource: 'task-shell', taskShellReceiptId: 'receipt' } },
    { sessionId: 's', text: 'hello', options: { requestId: 'r', nested: { b: 2, a: 1 } }, requestId: 'r' },
  ];
  for (const value of cases) {
    const expectedTrace = [];
    const expectedOptions = tracedOptions(structuredClone(value.options), expectedTrace);
    const expected = legacyPrepare({ ...value, options: expectedOptions }, customCrypto(expectedTrace));
    const trace = [];
    const options = tracedOptions(structuredClone(value.options), trace);
    const scheduler = createSessionWorkScheduler({ store, now: () => 100, cryptoImpl: customCrypto(trace) });
    const result = await scheduler.admit({ ...value, options });
    assert.equal(result.entry.id, expected.id);
    assert.deepEqual(result.entry.payload, expected.payload);
    assert.deepEqual(trace.slice(0, expectedTrace.length), expectedTrace);
  }
});

test('session admission keeps SQLite schedule and outbox atomic under retries and failures', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-schedule-admit-'));
  const file = path.join(dir, 'state.sqlite');
  const store = createOrchestrationSqliteStore({ file, now: () => 100 });
  const db = new Database(file);
  t.after(async () => { db.close(); await store.close({ exportRollback: false }); fs.rmSync(dir, { recursive: true, force: true }); });
  const scheduler = createSessionWorkScheduler({ store, now: () => 100 });
  const spec = { sessionId: 's', text: 'hello', idempotencyKey: 'key', options: { taskId: 't' } };
  const first = await scheduler.admit(spec);
  assert.equal(first.ok, true);
  const before = await store.snapshot();
  assert.equal(before.outbox[first.entry.id].payload.message, 'hello');
  assert.equal(before.sessionSchedules.s.updatedAt, 100);
  const second = await scheduler.admit(spec);
  assert.equal(second.duplicate, true);
  assert.equal(second.entry.id, first.entry.id);
  assert.deepEqual(await store.snapshot(), before);
  await assert.rejects(scheduler.admit({ ...spec, text: 'different' }), error => error.code === 'OUTBOX_PAYLOAD_CONFLICT');
  assert.deepEqual(await store.snapshot(), before);
  db.exec("CREATE TRIGGER fail_admit BEFORE INSERT ON orchestration_outbox BEGIN SELECT RAISE(ABORT,'blocked admission'); END");
  await assert.rejects(scheduler.admit({ sessionId: 'other', text: 'new', idempotencyKey: 'new' }), /blocked admission/);
  assert.deepEqual(await store.snapshot(), before);
});
