'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { getNative } = require('../src/native/runtime');
const { createWaitService } = require('../src/wait/service');
const { legacyWaitResolver } = require('./helpers/legacy-wait-resolution');
const { OutboxConflictError } = require('../src/outbox');
const { createOrchestrationSqliteStore } = require('../src/orchestration/sqlite-store');

function fixture(mode = 'callback', status = 'pending') {
  return { waits: { w: { id: 'w', sessionId: 's', mode, status, injectPrefix: 'prefix',
    callbackTokenHash: crypto.createHash('sha256').update('secret').digest('hex'),
    metadata: { taskId: 'task', originDispatchId: 'origin' } } }, outbox: {}, nextOutboxSequence: 1 };
}
async function runPair(mode, payload, options = {}, prepare = () => {}) {
  const states = [fixture(mode), fixture(mode)];
  for (const draft of states) prepare(draft);
  const old = legacyWaitResolver({ mutate: async fn => fn(states[0]) }, () => 1234);
  const params = mode === 'callback' ? { expectedMode: 'callback', callbackToken: options.token ?? 'secret', sessionWork: null }
    : { expectedMode: mode, deliveryText: options.deliveryText, sessionWork: options.sessionWork ?? null };
  let legacy, native, e1, e2;
  try { legacy = await old.resolveInternal('w', payload, params); } catch (error) { e1 = error; }
  try { native = getNative().waitResolveLive(states[1], 'w', payload, params, () => 1234, crypto, crypto, OutboxConflictError); } catch (error) { e2 = error; }
  assert.equal(e2?.message, e1?.message);
  if (!e1) assert.deepEqual(native, legacy);
  assert.deepEqual(states[1], states[0]);
}

test('Rust wait resolve matches original state and atomic outbox results', async () => {
  for (const mode of ['callback', 'poll', 'delay']) {
    await runPair(mode, { z: 1, text: '中文\ud83d', nested: [null, false] });
    await runPair(mode, 'value', { deliveryText: 'done' });
  }
  await runPair('callback', { data: 1 }, { token: 'wrong' });
  await runPair('delay', { data: 1 }, { sessionWork: { text: '  future task  ' } });
  await runPair('callback', { data: 1 }, {}, draft => { draft.waits.w.status = 'cancelled'; });
  await runPair('callback', { data: 1 }, {}, draft => { draft.waits.w.status = 'resolved'; draft.waits.w.resolutionPayloadHash = 'bad'; draft.waits.w.outboxId = 'wait:w'; });
  await runPair('callback', { data: 1 }, {}, draft => { draft.outbox['wait:w'] = { id: 'wait:w', sessionId: 'other', payloadHash: 'bad' }; });
});

test('callback hash validation and idempotency match legacy for malformed and valid tokens', async () => {
  const accepted = crypto.createHash('sha256').update('secret').digest('hex');
  for (const expectedHash of [null, '', 'a'.repeat(63), 'z'.repeat(64), accepted, accepted.toUpperCase()]) {
    for (const supplied of ['secret', 'wrong']) {
      await runPair('callback', { answer: 42 }, { token: supplied }, draft => {
        draft.waits.w.callbackTokenHash = expectedHash;
      });
    }
  }
  const oldDraft = fixture();
  const rustDraft = fixture();
  const old = legacyWaitResolver({ mutate: async fn => fn(oldDraft) }, () => 1234);
  const params = { expectedMode: 'callback', callbackToken: 'secret', sessionWork: null };
  const resolve = value => getNative().waitResolveLive(rustDraft, 'w', value, params,
    () => 1234, crypto, crypto, OutboxConflictError);
  for (const value of [{ answer: 1 }, { answer: 1 }, { answer: 2 }]) {
    assert.deepEqual(resolve(value), await old.resolveInternal('w', value, params));
    assert.deepEqual(rustDraft, oldDraft);
  }
});

test('Rust wait resolve authenticates before evaluating a payload getter', () => {
  const draft = fixture(); let reads = 0;
  const payload = { get privateValue() { reads++; throw Error('unauthenticated read'); } };
  const result = getNative().waitResolveLive(draft, 'w', payload,
    { expectedMode: 'callback', callbackToken: 'wrong', sessionWork: null },
    () => 1234, crypto, crypto, OutboxConflictError);
  assert.deepEqual(result, { ok: false, code: 'invalid_token' });
  assert.equal(reads, 0);
});

test('Rust wait command commits both records before a payload microtask and rolls back on failure', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-wait-live-sqlite-'));
  const file = path.join(dir, 'state.sqlite');
  const store = createOrchestrationSqliteStore({ file, now: () => 1234 });
  const stale = createOrchestrationSqliteStore({ file, now: () => 1234 });
  const db = new Database(file);
  t.after(async () => { db.close(); await store.close({ exportRollback: false }); await stale.close({ exportRollback: false }); fs.rmSync(dir, { recursive: true, force: true }); });
  await store.mutate(draft => { draft.waits.w = fixture('poll').waits.w; });
  let observed;
  const payload = { get value() {
    queueMicrotask(() => { observed = db.prepare("SELECT status FROM orchestration_waits WHERE id='w'").get()?.status; });
    return 'hello';
  } };
  const input = { expectedMode: 'poll', sessionWork: null };
  await assert.rejects(stale.runNativeCommandSync('waitResolve', 'w', payload, input,
    () => 1234, crypto, crypto, OutboxConflictError), error => error.code === 'ORCHESTRATION_SQLITE_CONFLICT');
  db.exec("CREATE TRIGGER fail_wait_outbox BEFORE INSERT ON orchestration_outbox BEGIN SELECT RAISE(ABORT, 'blocked wait outbox'); END");
  await assert.rejects(store.runNativeCommandSync('waitResolve', 'w', payload, input,
    () => 1234, crypto, crypto, OutboxConflictError), /blocked wait outbox/);
  assert.equal((await store.snapshot()).waits.w.status, 'pending');
  db.exec('DROP TRIGGER fail_wait_outbox');
  const { value } = await store.runNativeCommandSync('waitResolve', 'w', payload, input,
    () => 1234, crypto, crypto, OutboxConflictError);
  assert.equal(value.ok, true);
  assert.equal(observed, 'resolved');
  const snapshot = await store.snapshot();
  assert.equal(snapshot.waits.w.status, 'resolved');
  assert.equal(snapshot.outbox['wait:w'].payload.data.value, 'hello');
});

test('payload must be captured before a caller microtask mutates it', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-wait-capture-'));
  const store = createOrchestrationSqliteStore({ file: path.join(dir, 'state.sqlite'), now: () => 1234 });
  t.after(async () => { await store.close({ exportRollback: false }); fs.rmSync(dir, { recursive: true, force: true }); });
  await store.mutate(draft => { draft.waits.w = fixture('poll').waits.w; });
  const service = createWaitService({ store, now: () => 1234 });
  const payload = { message: 'before' };
  const pending = service.resolvePoll('w', payload);
  queueMicrotask(() => { payload.message = 'after'; });
  assert.equal((await pending).ok, true);
  assert.equal((await store.snapshot()).outbox['wait:w'].payload.data.message, 'before');
});

test('live command does not pre-read hidden payload getters and preserves getter order', async () => {
  function payloadFor(log) {
    const value = {};
    Object.defineProperties(value, {
      z: { enumerable: true, get() { log.push('z'); return 2; } },
      a: { enumerable: true, get() { log.push('a'); return { nested: 1 }; } },
      hidden: { enumerable: false, get() { log.push('hidden'); throw new Error('hidden read'); } },
    });
    return value;
  }
  const legacyLog = [], rustLog = [];
  const oldDraft = fixture();
  const rustDraft = fixture();
  const old = legacyWaitResolver({ mutate: async fn => fn(oldDraft) }, () => 1234);
  const input = { expectedMode: 'callback', callbackToken: 'secret', sessionWork: null };
  const legacy = await old.resolveInternal('w', payloadFor(legacyLog), input);
  const result = getNative().waitResolveLive(rustDraft, 'w', payloadFor(rustLog), input,
    () => 1234, crypto, crypto, OutboxConflictError);
  assert.deepEqual(result, legacy);
  assert.deepEqual(rustLog, legacyLog);
  assert.deepEqual(rustDraft, oldDraft);
  assert.equal(rustLog.includes('hidden'), false);
  const dangerous = new Proxy({}, { ownKeys() { throw new Error('payload read before auth'); },
    get() { throw new Error('payload read before auth'); }, getPrototypeOf() { throw new Error('payload read before auth'); } });
  for (const [draft, params, code] of [
    [fixture(), { ...input, callbackToken: 'wrong' }, 'invalid_token'],
    [fixture('poll'), input, 'mode_mismatch'],
    [{ waits: {} }, input, 'not_found'],
  ]) {
    assert.equal(getNative().waitResolveLive(draft, 'w', dangerous, params,
      () => 1234, crypto, crypto, OutboxConflictError).code, code);
  }
});
