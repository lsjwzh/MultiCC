'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { createOrchestrationStore } = require('../src/orchestration/store');
const { createOutbox } = require('../src/outbox');
const { createOrchestrationSqliteStore } = require('../src/orchestration/sqlite-store');
const Database = require('better-sqlite3');
const crypto = require('node:crypto');

test('SQLite claim selects twice without running a queued microtask between passes', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-outbox-claim-synchronous-'));
  const store = createOrchestrationSqliteStore({ file: path.join(dir, 'state.sqlite') });
  t.after(async () => { await store.close({ exportRollback: false }); fs.rmSync(dir, { recursive: true, force: true }); });
  const outbox = createOutbox({ store });
  await outbox.enqueue({ id: 'a', sessionId: 's', payload: 'message' });
  const events = [];
  let passes = 0;
  const claimed = await outbox.claim({ workerId: 'worker', selectSessionItem(items) {
    events.push(`select-${++passes}`);
    if (passes === 1) queueMicrotask(() => events.push('microtask'));
    return items[0];
  }, sessionGroup(id) { events.push(`group-${passes}`); return id; } });
  assert.deepEqual(claimed.map(item => item.id), ['a']);
  assert.deepEqual(events, ['select-1', 'group-1', 'select-2', 'group-2', 'microtask']);
});

// Acceptance regression: the legacy claim awaits its mutator before commit,
// so this remains red until a nonblocking Rust claim commits in the same turn.
test('SQLite claim commits before a microtask queued by its second selection', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-outbox-claim-commit-order-'));
  const file = path.join(dir, 'state.sqlite');
  const store = createOrchestrationSqliteStore({ file });
  const db = new Database(file);
  t.after(async () => { db.close(); await store.close({ exportRollback: false }); fs.rmSync(dir, { recursive: true, force: true }); });
  const outbox = createOutbox({ store });
  await outbox.enqueue({ id: 'a', sessionId: 's', payload: 'message' });
  let passes = 0;
  let persistedAtMicrotask;
  const result = await outbox.claim({ workerId: 'worker', selectSessionItem(items) {
    if (++passes === 2) queueMicrotask(() => {
      persistedAtMicrotask = db.prepare('SELECT state FROM orchestration_outbox WHERE id=?').get('a').state;
    });
    return items[0];
  } });
  assert.equal(result[0].id, 'a');
  assert.equal(persistedAtMicrotask, 'leased');
});

test('SQLite claim captures host facts before a later microtask can make the host busy', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-outbox-claim-before-first-'));
  const store = createOrchestrationSqliteStore({ file: path.join(dir, 'state.sqlite') });
  t.after(async () => { await store.close({ exportRollback: false }); fs.rmSync(dir, { recursive: true, force: true }); });
  const outbox = createOutbox({ store });
  await outbox.enqueue({ id: 'a', sessionId: 's', payload: 'message' });
  let busy = false;
  const promise = outbox.claim({ workerId: 'worker',
    selectSessionItem: items => busy ? null : items[0] });
  queueMicrotask(() => { busy = true; });
  assert.deepEqual((await promise).map(item => item.id), ['a']);
});

test('SQLite claim preserves detached selector records after the transaction and supports structuredClone', async t => {
  const { legacyClaimPreview } = require('./helpers/legacy-outbox-claim-preview');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-outbox-selector-record-'));
  const stores = [];
  t.after(async () => {
    for (const store of stores) await store.close({ exportRollback: false });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  async function observe(legacy) {
    const store = createOrchestrationSqliteStore({ file: path.join(dir, `${legacy}.sqlite`) });
    stores.push(store);
    const outbox = createOutbox({ store });
    await outbox.enqueue({ id: 'a', sessionId: 's', payload: { message: 'original' } });
    let escaped;
    let cloned;
    const select = items => {
      escaped = items[0];
      cloned = structuredClone(escaped);
      escaped.payload.message = 'local change';
      return null;
    };
    const result = legacy ? await legacyClaimPreview(store, select, Date.now())
      : await outbox.claim({ workerId: 'worker', selectSessionItem: select });
    return { result, cloned: cloned.payload.message, escaped: escaped.payload.message,
      persisted: (await store.snapshot()).outbox.a.payload.message };
  }
  const expected = await observe(true);
  assert.deepEqual(expected, { result: [], cloned: 'original', escaped: 'local change', persisted: 'original' });
  assert.deepEqual(await observe(false), expected);
});

test('SQLite claim sees expired lease recovery during selection and rolls the whole batch back on failure', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-outbox-claim-recovery-'));
  const file = path.join(dir, 'state.sqlite');
  const store = createOrchestrationSqliteStore({ file });
  const db = new Database(file);
  t.after(async () => { db.close(); await store.close({ exportRollback: false }); fs.rmSync(dir, { recursive: true, force: true }); });
  await store.mutate(draft => {
    draft.nextOutboxSequence = 2;
    draft.outbox.a = { id: 'a', sessionId: 's', sequence: 1, state: 'leased',
      attempts: 1, leasedUntil: 1, leaseTokenHash: 'old', payload: 'message' };
  });
  const outbox = createOutbox({ store, baseBackoffMs: 0, maxBackoffMs: 0 });
  const before = await store.snapshot();
  const observed = [];
  const options = { workerId: 'worker', selectSessionItem(items) {
    observed.push([items[0].state, items[0].leaseTokenHash, items[0].lastError]);
    return items[0];
  } };
  db.exec("CREATE TRIGGER fail_claim BEFORE UPDATE ON orchestration_outbox WHEN OLD.id='a' BEGIN SELECT RAISE(ABORT, 'blocked claim'); END");
  await assert.rejects(outbox.claim(options), /blocked claim/);
  assert.deepEqual(await store.snapshot(), before);
  assert.deepEqual(observed, [['pending', null, 'delivery lease expired']]);
  db.exec('DROP TRIGGER fail_claim');
  observed.length = 0;
  const [claimed] = await outbox.claim(options);
  assert.equal(claimed.id, 'a');
  assert.equal(claimed.attempts, 2);
  assert.deepEqual(observed, [['pending', null, 'delivery lease expired']]);
});

test('SQLite claim rejects a concurrent writer without persisting its lease', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-outbox-claim-revision-'));
  const file = path.join(dir, 'state.sqlite');
  const store = createOrchestrationSqliteStore({ file });
  const db = new Database(file);
  t.after(async () => { db.close(); await store.close({ exportRollback: false }); fs.rmSync(dir, { recursive: true, force: true }); });
  const outbox = createOutbox({ store });
  await outbox.enqueue({ id: 'a', sessionId: 's', payload: 'message' });
  let changed = false;
  await assert.rejects(outbox.claim({ workerId: 'worker', selectSessionItem(items) {
    if (!changed) {
      changed = true;
      db.prepare("UPDATE orchestration_meta SET value_json = CAST(value_json AS INTEGER) + 1 WHERE key='revision'").run();
    }
    return items[0];
  } }), error => error.code === 'ORCHESTRATION_SQLITE_CONFLICT');
  assert.equal((await store.snapshot()).outbox.a.state, 'pending');
});

test('SQLite claim sees external data changes that do not increment the revision', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-outbox-claim-external-'));
  const file = path.join(dir, 'state.sqlite');
  const store = createOrchestrationSqliteStore({ file });
  const db = new Database(file);
  t.after(async () => { db.close(); await store.close({ exportRollback: false }); fs.rmSync(dir, { recursive: true, force: true }); });
  const outbox = createOutbox({ store });
  await outbox.enqueue({ id: 'a', sessionId: 'old', payload: 'message' });
  assert.deepEqual(await outbox.claim({ workerId: 'worker', selectSessionItem: () => null }), []);
  const revision = db.prepare("SELECT value_json FROM orchestration_meta WHERE key='revision'").get().value_json;
  db.prepare("UPDATE orchestration_outbox SET session_id='new', data_json=json_set(data_json, '$.sessionId', 'new') WHERE id='a'").run();
  assert.equal(db.prepare("SELECT value_json FROM orchestration_meta WHERE key='revision'").get().value_json, revision);
  const sessions = [];
  const claimed = await outbox.claim({ workerId: 'worker', selectSessionItem(items) {
    sessions.push(items[0].sessionId);
    return items[0];
  } });
  assert.deepEqual(sessions, ['new', 'new']);
  assert.equal(claimed[0].sessionId, 'new');
});

test('SQLite claim does not overwrite an external write without a revision change during selection', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-outbox-claim-external-race-'));
  const file = path.join(dir, 'state.sqlite');
  const store = createOrchestrationSqliteStore({ file });
  const db = new Database(file);
  t.after(async () => { db.close(); await store.close({ exportRollback: false }); fs.rmSync(dir, { recursive: true, force: true }); });
  const outbox = createOutbox({ store });
  await outbox.enqueue({ id: 'a', sessionId: 'old', payload: 'message' });
  let changed = false;
  await assert.rejects(outbox.claim({ workerId: 'worker', selectSessionItem(items) {
    if (!changed) {
      changed = true;
      db.prepare("UPDATE orchestration_outbox SET session_id='new', data_json=json_set(data_json, '$.sessionId', 'new') WHERE id='a'").run();
    }
    return items[0];
  } }));
  const row = db.prepare('SELECT state, session_id FROM orchestration_outbox WHERE id=?').get('a');
  assert.deepEqual(row, { state: 'pending', session_id: 'new' });
});

test('SQLite claim uses the second clock reading to recover leases before its second selection', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-outbox-claim-clock-'));
  let clock = 100;
  const store = createOrchestrationSqliteStore({ file: path.join(dir, 'state.sqlite'), now: () => clock });
  t.after(async () => { await store.close({ exportRollback: false }); fs.rmSync(dir, { recursive: true, force: true }); });
  await store.mutate(draft => {
    draft.nextOutboxSequence = 3;
    draft.outbox.a = { id: 'a', sessionId: 'a', sequence: 1, state: 'pending', attempts: 0, availableAt: 0 };
    draft.outbox.b = { id: 'b', sessionId: 'b', sequence: 2, state: 'leased', attempts: 1,
      leasedUntil: 150, leaseTokenHash: 'old' };
  });
  const observations = [];
  const outbox = createOutbox({ store, now: () => clock, baseBackoffMs: 0, maxBackoffMs: 0 });
  const claimed = await outbox.claim({ workerId: 'worker', limit: 2, selectSessionItem(items, _draft, at) {
    observations.push([items[0].id, items[0].state, at]);
    if (observations.length === 1) clock = 200;
    return items[0];
  } });
  assert.deepEqual(observations, [
    ['a', 'pending', 100], ['b', 'leased', 100],
    ['a', 'pending', 200], ['b', 'pending', 200],
  ]);
  assert.deepEqual(claimed.map(item => item.id), ['a', 'b']);
});

test('SQLite claim exposes recovered state through draft and preserves callback exceptions', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-outbox-claim-view-'));
  const store = createOrchestrationSqliteStore({ file: path.join(dir, 'state.sqlite') });
  t.after(async () => { await store.close({ exportRollback: false }); fs.rmSync(dir, { recursive: true, force: true }); });
  await store.mutate(draft => {
    draft.nextOutboxSequence = 2;
    draft.outbox.a = { id: 'a', sessionId: 's', sequence: 1, state: 'leased', attempts: 1,
      leasedUntil: 1, leaseTokenHash: 'old', payload: { text: 'hello\ud83d' } };
  });
  const outbox = createOutbox({ store, baseBackoffMs: 0, maxBackoffMs: 0 });
  const sentinel = new Error('selector failed');
  await assert.rejects(outbox.claim({ workerId: 'worker',
    selectSessionItem(items, draft) {
      assert.equal(items[0].state, 'pending');
      assert.equal(draft.outbox.a.state, 'pending');
      assert.equal(draft.outbox.a.payload.text, 'hello\ud83d');
      throw sentinel;
    } }), error => error === sentinel);
  assert.equal((await store.snapshot()).outbox.a.state, 'leased');
});

test('SQLite claim works with the production session scheduler and preserves payloads', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-outbox-claim-scheduler-'));
  const store = createOrchestrationSqliteStore({ file: path.join(dir, 'state.sqlite') });
  t.after(async () => { await store.close({ exportRollback: false }); fs.rmSync(dir, { recursive: true, force: true }); });
  const scheduler = require('../src/session-work/scheduler').createSessionWorkScheduler({ store });
  const outbox = createOutbox({ store });
  const message = 'message-data-'.repeat(8192) + '\ud83d';
  await outbox.enqueue({ id: 'a', sessionId: 's', payload: { type: 'session.work', workKind: 'task', message } });
  const [claimed] = await outbox.claim({ workerId: 'worker',
    selectSessionItem: (items, draft, at) => scheduler.selectSessionItem(items, draft, at) });
  assert.equal(claimed.id, 'a');
  assert.equal(claimed.payload.message, message);
  assert.equal((await outbox.get('a')).payload.message, message);
});

test('Rust SQLite acknowledgement, failure and defer match the Node transaction', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-outbox-settle-'));
  const originalNow = Date.now;
  Date.now = () => 1000;
  const stores = [];
  t.after(async () => { Date.now = originalNow; for (const store of stores) await store.close({ exportRollback: false });
    fs.rmSync(dir, { recursive: true, force: true }); });
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  const scenarios = [
    ['ack', 'target', 'token', null, true], ['ack', 'target', 'wrong', null, true],
    ['ack', 'expired', 'token', null, true], ['ack', 'missing', 'token', null, true],
    ['fail', 'target', 'token', 'fail😀\ud83d', true], ['fail', 'target', 'token', '', false],
    ['defer', 'target', 'token', 'busy😀\ud83d', true],
  ];
  for (const [action, id, token, reason, retryable] of scenarios) {
    const results = [];
    for (const oracle of [false, true]) {
      const store = createOrchestrationSqliteStore({ file: path.join(dir, `${stores.length}.sqlite`), now: Date.now,
        ...(oracle ? { hooks: { beforeCommit() {} } } : {}) });
      stores.push(store);
      await store.mutate(draft => {
        draft.nextOutboxSequence = 3;
        draft.outbox.expired = { id: 'expired', sessionId: 's', sequence: 1, state: 'leased',
          leasedUntil: 999, leasedAt: 1, leaseOwner: 'w', leaseTokenHash: hash('token'), attempts: 1,
          payload: { body: '\ud83d' } };
        draft.outbox.target = { id: 'target', sessionId: 's', sequence: 2, state: 'leased',
          leasedUntil: 2000, leasedAt: 1, leaseOwner: 'w', leaseTokenHash: hash('token'), attempts: 1,
          payload: { body: '\ude00' } };
      });
      const outbox = createOutbox({ store, now: Date.now, maxAttempts: 3, baseBackoffMs: 10, maxBackoffMs: 100 });
      const result = action === 'ack' ? await outbox.ack(id, token)
        : action === 'fail' ? await outbox.fail(id, token, reason, { retryable })
          : await outbox.defer(id, token, reason, { delayMs: 25 });
      results.push([result, await store.snapshot()]);
    }
    assert.deepEqual(results[0], results[1], `${action} ${id} ${token}`);
  }
});

test('Rust SQLite settlement rolls back recovery when the target write fails', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-outbox-settle-atomic-'));
  const originalNow = Date.now;
  Date.now = () => 1000;
  const file = path.join(dir, 'state.sqlite');
  const store = createOrchestrationSqliteStore({ file, now: Date.now });
  const db = new Database(file);
  t.after(async () => { Date.now = originalNow; db.close(); await store.close({ exportRollback: false });
    fs.rmSync(dir, { recursive: true, force: true }); });
  await store.mutate(draft => {
    draft.nextOutboxSequence = 3;
    for (const [id, sequence, leasedUntil] of [['expired', 1, 1], ['target', 2, 2000]]) {
      draft.outbox[id] = { id, sessionId: 's', sequence, state: 'leased', attempts: 1, leasedUntil,
        leaseTokenHash: crypto.createHash('sha256').update('token').digest('hex') };
    }
  });
  const before = await store.snapshot();
  db.exec("CREATE TRIGGER fail_settle BEFORE UPDATE ON orchestration_outbox WHEN OLD.id='target' BEGIN SELECT RAISE(ABORT, 'blocked settlement'); END");
  await assert.rejects(createOutbox({ store, now: Date.now }).ack('target', 'token'), /blocked settlement/);
  assert.deepEqual(await store.snapshot(), before);
});

test('Rust SQLite settlement treats falsy legacy records as absent', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-outbox-legacy-'));
  const originalNow = Date.now;
  Date.now = () => 1000;
  const store = createOrchestrationSqliteStore({ file: path.join(dir, 'state.sqlite'), now: Date.now });
  t.after(async () => { Date.now = originalNow; await store.close({ exportRollback: false });
    fs.rmSync(dir, { recursive: true, force: true }); });
  await store.mutate(draft => {
    draft.outbox.nullRecord = null; draft.outbox.falseRecord = false;
    draft.outbox.zeroRecord = 0; draft.outbox.emptyRecord = '';
  });
  const outbox = createOutbox({ store, now: Date.now });
  for (const id of ['nullRecord', 'falseRecord', 'zeroRecord', 'emptyRecord']) {
    assert.deepEqual(await outbox.ack(id, 'token'), { ok: false, code: 'not_found' });
    assert.deepEqual(await outbox.fail(id, 'token', 'error'), { ok: false, code: 'not_found' });
    assert.deepEqual(await outbox.defer(id, 'token', 'defer'), { ok: false, code: 'not_found' });
  }
});

test('Rust SQLite failure reads Error.message only after lease authentication', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-outbox-error-'));
  const store = createOrchestrationSqliteStore({ file: path.join(dir, 'state.sqlite') });
  t.after(async () => { await store.close({ exportRollback: false }); fs.rmSync(dir, { recursive: true, force: true }); });
  await store.mutate(draft => {
    draft.nextOutboxSequence = 2;
    draft.outbox.a = { id: 'a', sessionId: 's', sequence: 1, state: 'leased', attempts: 1,
      leasedUntil: Date.now() + 60_000, leaseTokenHash: crypto.createHash('sha256').update('token').digest('hex') };
  });
  let reads = 0;
  const error = new Error();
  Object.defineProperty(error, 'message', { get() { reads++; return 'error detail'; } });
  const outbox = createOutbox({ store });
  assert.equal((await outbox.fail('a', 'wrong', error)).code, 'lease_lost');
  assert.equal(reads, 0);
  assert.equal((await outbox.fail('a', 'token', error)).item.lastError, 'error detail');
  assert.equal(reads, 1);
});

test('Rust SQLite lease recovery matches Node including no-op and custom-backoff compatibility', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-outbox-recover-'));
  const originalNow = Date.now;
  let clock = 1000;
  Date.now = () => clock;
  const stores = [];
  t.after(async () => { Date.now = originalNow; for (const store of stores) await store.close({ exportRollback: false });
    fs.rmSync(dir, { recursive: true, force: true }); });
  const outcomes = [];
  for (const oracle of [false, true]) {
    const store = createOrchestrationSqliteStore({ file: path.join(dir, `${oracle}.sqlite`), now: Date.now,
      ...(oracle ? { hooks: { beforeCommit() {} } } : {}) });
    stores.push(store);
    await store.mutate(draft => {
      draft.nextOutboxSequence = 4;
      draft.outbox.a = { id: 'a', sessionId: 's', state: 'leased', sequence: 1, attempts: 1,
        leasedUntil: 900, leaseTokenHash: 'secret', payload: { text: '\ud83d' } };
      draft.outbox.b = { id: 'b', sessionId: 's', state: 'leased', sequence: 2, attempts: 2,
        leasedUntil: null, leaseTokenHash: 'secret', payload: { text: 'body' } };
      draft.outbox.c = { id: 'c', sessionId: 's', state: 'leased', sequence: 3, attempts: 1,
        leasedUntil: 2000, leaseTokenHash: 'secret' };
    });
    const outbox = createOutbox({ store, now: Date.now, maxAttempts: 2, baseBackoffMs: 100, maxBackoffMs: 500 });
    outcomes.push([await outbox.recoverExpired(), await outbox.recoverExpired(), await store.snapshot()]);
  }
  assert.deepEqual(outcomes[0], outcomes[1]);
  assert.deepEqual(outcomes[0][0], { recovered: 1, deadLettered: 1 });
  assert.deepEqual(outcomes[0][1], { recovered: 0, deadLettered: 0 });
  clock = 3000;
  let calls = 0;
  const custom = createOutbox({ store: stores[0], now: Date.now, backoff: () => { calls++; return 7; } });
  assert.deepEqual(await custom.recoverExpired(), { recovered: 1, deadLettered: 0 });
  assert.equal(calls, 1);
  assert.equal((await stores[0].snapshot()).outbox.c.availableAt, 3007);
});

test('Rust SQLite lease recovery is atomic and rejects stale revisions', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-outbox-recover-atomic-'));
  const originalNow = Date.now;
  Date.now = () => 1000;
  const file = path.join(dir, 'state.sqlite');
  const store = createOrchestrationSqliteStore({ file, now: Date.now });
  const stale = createOrchestrationSqliteStore({ file, now: Date.now });
  const db = new Database(file);
  t.after(async () => { Date.now = originalNow; db.close(); await store.close({ exportRollback: false });
    await stale.close({ exportRollback: false }); fs.rmSync(dir, { recursive: true, force: true }); });
  await store.mutate(draft => {
    draft.nextOutboxSequence = 3;
    for (const [id, sequence] of [['a', 1], ['b', 2]]) {
      draft.outbox[id] = { id, sessionId: 's', state: 'leased', sequence, attempts: 1, leasedUntil: 1 };
    }
  });
  const before = await store.snapshot();
  const outbox = createOutbox({ store, now: Date.now });
  db.exec("CREATE TRIGGER fail_recovery BEFORE UPDATE ON orchestration_outbox WHEN OLD.id='b' BEGIN SELECT RAISE(ABORT, 'blocked recovery'); END");
  await assert.rejects(outbox.recoverExpired(), /blocked recovery/);
  assert.deepEqual(await store.snapshot(), before);
  db.exec('DROP TRIGGER fail_recovery');
  await assert.rejects(createOutbox({ store: stale, now: Date.now }).recoverExpired(),
    error => error.code === 'ORCHESTRATION_SQLITE_CONFLICT');
  assert.deepEqual(await store.snapshot(), before);
  assert.deepEqual(await outbox.recoverExpired(), { recovered: 2, deadLettered: 0 });
  assert.equal((await store.snapshot()).revision, before.revision + 1);
});

function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-outbox-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'orchestration.json');
  const clock = { value: 1_000 };
  let token = 0;
  const store = createOrchestrationStore({
    file,
    now: () => clock.value,
    hooks: options.hooks || {},
  });
  const outbox = createOutbox({
    store,
    now: () => clock.value,
    idFactory: () => `generated-${++token}`,
    leaseTokenFactory: () => `lease-${++token}`,
    leaseMs: 100,
    maxAttempts: 3,
    backoff: options.backoff || (attempt => attempt * 100),
  });
  return { file, clock, store, outbox };
}

test('same-session order is strict while different sessions are claimable together', async t => {
  const { outbox } = fixture(t);
  await outbox.enqueue({ id: 'a1', sessionId: 'A', payload: { n: 1 } });
  await outbox.enqueue({ id: 'a2', sessionId: 'A', payload: { n: 2 } });
  await outbox.enqueue({ id: 'b1', sessionId: 'B', payload: { n: 3 } });

  const first = await outbox.claim({ workerId: 'worker-1', limit: 10 });
  assert.deepEqual(first.map(item => item.id), ['a1', 'b1']);
  assert.equal(first.some(item => item.id === 'a2'), false);

  assert.deepEqual(await outbox.claim({ workerId: 'worker-2', limit: 10 }), []);
  assert.equal((await outbox.ack('a1', first[0].leaseToken)).ok, true);

  // B remains leased, but acknowledging A's head releases A2 immediately.
  const next = await outbox.claim({ workerId: 'worker-2', limit: 10 });
  assert.deepEqual(next.map(item => item.id), ['a2']);
  assert.equal((await outbox.ack('b1', first[1].leaseToken)).ok, true);
  assert.equal((await outbox.ack('a2', next[0].leaseToken)).ok, true);
});

test('concurrent claim calls never lease the same item', async t => {
  const { outbox } = fixture(t);
  await outbox.enqueue({ id: 'a1', sessionId: 'A', payload: 'one' });
  await outbox.enqueue({ id: 'b1', sessionId: 'B', payload: 'two' });

  const [left, right] = await Promise.all([
    outbox.claim({ workerId: 'left', limit: 1 }),
    outbox.claim({ workerId: 'right', limit: 1 }),
  ]);
  assert.equal(left.length, 1);
  assert.equal(right.length, 1);
  assert.notEqual(left[0].id, right[0].id);
});

test('expired lease is reclaimed after reconstruction and old token loses ownership', async t => {
  const { file, clock, outbox } = fixture(t, { backoff: () => 0 });
  await outbox.enqueue({ id: 'a1', sessionId: 'A', payload: { task: 1 } });
  const [first] = await outbox.claim({ workerId: 'crashed-worker' });
  assert.equal(first.attempts, 1);
  assert.equal(fs.readFileSync(file, 'utf8').includes(first.leaseToken), false);

  clock.value += 101;
  const rebuiltStore = createOrchestrationStore({ file, now: () => clock.value });
  let token = 100;
  const rebuilt = createOutbox({
    store: rebuiltStore,
    now: () => clock.value,
    leaseMs: 100,
    maxAttempts: 3,
    backoff: () => 0,
    leaseTokenFactory: () => `rebuilt-${++token}`,
  });

  const recovered = await rebuilt.recoverExpired();
  assert.deepEqual(recovered, { recovered: 1, deadLettered: 0 });
  const [second] = await rebuilt.claim({ workerId: 'replacement' });
  assert.equal(second.id, 'a1');
  assert.equal(second.attempts, 2);
  assert.equal((await rebuilt.ack('a1', first.leaseToken)).code, 'lease_lost');
  assert.equal((await rebuilt.ack('a1', second.leaseToken)).ok, true);
});

test('claim committed before worker crash is recovered after its lost lease expires', async t => {
  let crash = false;
  const hooks = {
    afterRename() {
      if (crash) throw new Error('worker crashed before receiving claim');
    },
  };
  const { file, clock, outbox } = fixture(t, { hooks, backoff: () => 0 });
  await outbox.enqueue({ id: 'a1', sessionId: 'A', payload: { task: 1 } });

  crash = true;
  await assert.rejects(
    outbox.claim({ workerId: 'lost-worker' }),
    /worker crashed before receiving claim/,
  );
  crash = false;

  const rebuiltStore = createOrchestrationStore({ file, now: () => clock.value });
  const persisted = await rebuiltStore.snapshot();
  assert.equal(persisted.outbox.a1.state, 'leased');
  assert.equal(persisted.outbox.a1.attempts, 1);

  clock.value += 101;
  const rebuilt = createOutbox({
    store: rebuiltStore,
    now: () => clock.value,
    leaseMs: 100,
    maxAttempts: 3,
    backoff: () => 0,
    leaseTokenFactory: () => 'replacement-token',
  });
  const [replacement] = await rebuilt.claim({ workerId: 'replacement-worker' });
  assert.equal(replacement.id, 'a1');
  assert.equal(replacement.attempts, 2);
  assert.equal((await rebuilt.ack('a1', replacement.leaseToken)).ok, true);
});

test('retry respects backoff and reaches dead-letter at max attempts', async t => {
  const { clock, outbox } = fixture(t);
  await outbox.enqueue({ id: 'a1', sessionId: 'A', payload: 'first' });
  await outbox.enqueue({ id: 'a2', sessionId: 'A', payload: 'second' });

  const [attempt1] = await outbox.claim({ workerId: 'w1' });
  const retry1 = await outbox.fail('a1', attempt1.leaseToken, new Error('failure one'));
  assert.equal(retry1.retry, true);
  assert.equal(retry1.availableAt, 1_100);
  assert.deepEqual(await outbox.claim({ workerId: 'early' }), []);

  clock.value = 1_100;
  const [attempt2] = await outbox.claim({ workerId: 'w2' });
  assert.equal(attempt2.id, 'a1');
  assert.equal(attempt2.attempts, 2);
  const retry2 = await outbox.fail('a1', attempt2.leaseToken, 'failure two');
  assert.equal(retry2.availableAt, 1_300);

  clock.value = 1_299;
  assert.deepEqual(await outbox.claim({ workerId: 'still-early' }), []);
  clock.value = 1_300;
  const [attempt3] = await outbox.claim({ workerId: 'w3' });
  assert.equal(attempt3.attempts, 3);
  const terminal = await outbox.fail('a1', attempt3.leaseToken, 'failure three');
  assert.equal(terminal.deadLetter, true);
  assert.equal((await outbox.get('a1')).state, 'dead-letter');

  // A dead letter is terminal, so the next item for that session can proceed.
  const [next] = await outbox.claim({ workerId: 'w4' });
  assert.equal(next.id, 'a2');
});

test('lease expiry at max attempts dead-letters instead of retrying forever', async t => {
  const { clock, outbox } = fixture(t, { backoff: () => 0 });
  await outbox.enqueue({ id: 'x', sessionId: 'X', payload: true });

  for (let attempt = 1; attempt <= 3; attempt++) {
    const [claim] = await outbox.claim({ workerId: `worker-${attempt}` });
    assert.equal(claim.attempts, attempt);
    clock.value += 101;
    const recovered = await outbox.recoverExpired();
    if (attempt < 3) assert.equal(recovered.recovered, 1);
    else assert.equal(recovered.deadLettered, 1);
  }
  assert.equal((await outbox.get('x')).state, 'dead-letter');
});


test('one claim admits one member per workspace and independent workspaces concurrently', async t => {
  const { outbox } = fixture(t);
  await outbox.enqueue({ id: 'a', sessionId: 'shell', payload: 'a' });
  await outbox.enqueue({ id: 'b', sessionId: 'child', payload: 'b' });
  await outbox.enqueue({ id: 'c', sessionId: 'independent', payload: 'c' });
  const options = { workerId: 'w', limit: 10, sessionGroup: id => id === 'child' ? 'shell' : id };
  const first = await outbox.claim(options);
  assert.deepEqual(first.map(i => i.id), ['a', 'c']);
  await outbox.ack('a', first[0].leaseToken);
  assert.deepEqual((await outbox.claim(options)).map(i => i.id), ['b']);
});

test('delivery-state projection does not read payload and full reads remain complete and isolated', async t => {
  const { store, outbox } = fixture(t);
  const body = 'retained-payload:'.repeat(4096);
  await outbox.enqueue({ id: 'item', sessionId: 'session', payload: { body, detail: { value: 1 } } });
  assert.deepEqual(await outbox.getDeliveryState('item'), { id: 'item', sessionId: 'session', state: 'pending' });
  assert.equal(await outbox.getDeliveryState('absent'), null);
  const item = await outbox.get('item');
  assert.equal(item.payload.body, body);
  assert.equal('leaseTokenHash' in item, false);
  item.payload.detail.value = 2;
  const [listed] = await outbox.list({ sessionId: 'session' });
  assert.equal(listed.payload.detail.value, 1);
  listed.payload.body = 'changed';
  assert.equal((await outbox.get('item')).payload.body, body);
  const nativeOutbox = createOutbox({ store: {
    read() { throw new Error('loaded payload through full read'); }, mutate: store.mutate,
    async select(collection, { where, fields, limit }) {
      assert.equal(collection, 'outbox');
      assert.deepEqual(where, { id: 'item' });
      assert.deepEqual(fields, ['id', 'sessionId', 'state']);
      assert.equal(limit, 1);
      return [{ id: 'item', sessionId: 'session', state: 'delivered' }];
    },
  } });
  assert.equal((await nativeOutbox.getDeliveryState('item')).state, 'delivered');
});

test('indexed claim preserves unknown-state FIFO blockers without scanning terminal history', async () => {
  const rows = [
    { id: 'unknown', state: 'legacy-unknown', sessionId: 'blocked', sequence: 1 },
    { id: 'behind', state: 'pending', sessionId: 'blocked', sequence: 2, availableAt: 1, attempts: 0 },
    { id: 'ready', state: 'pending', sessionId: 'independent', sequence: 3, availableAt: 1, attempts: 0 },
    { id: 'expired', state: 'leased', sessionId: 'expired-session', sequence: 4, leasedUntil: 1, attempts: 1 },
  ];
  const draft = { outbox: new Proxy({}, { ownKeys() { throw new Error('scanned terminal outbox'); } }),
    select(collection, { where }) {
      assert.equal(collection, 'outbox');
      if (where.state === 'leased') return rows.filter(row => row.state === 'leased');
      assert.deepEqual(where.state.$nin, ['delivered', 'dead-letter', 'cancelled']);
      return rows;
    } };
  const outbox = createOutbox({ now: () => 100, backoff: () => 0, store: {
    read: async fn => fn(draft), mutate: async fn => fn(draft),
  } });
  const claims = await outbox.claim({ workerId: 'worker', limit: 10 });
  assert.deepEqual(claims.map(row => row.id), ['ready', 'expired']);
  assert.equal(rows[1].state, 'pending');
  assert.equal(rows[3].attempts, 2);
  assert.equal(rows[3].lastError, 'delivery lease expired');
});
