'use strict';

const assert = require('node:assert/strict');
const nodeCrypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { createOrchestrationStore } = require('../src/orchestration-store');
const { createWaitService } = require('../src/wait-service');

function tempFile(t, name = 'orchestration.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-wait-service-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, name);
}

function serviceFixture(t, { hooks = {}, file = tempFile(t), cryptoImpl = nodeCrypto } = {}) {
  let id = 0;
  let token = 0;
  const clock = { value: 10_000 };
  const store = createOrchestrationStore({ file, now: () => clock.value, hooks });
  const waits = createWaitService({
    store,
    now: () => clock.value,
    cryptoImpl,
    idFactory: () => `wait-${++id}`,
    callbackTokenFactory: () => `raw-callback-secret-${++token}`,
    callbackBaseUrl: 'https://callbacks.example.test/',
  });
  return { file, clock, store, waits };
}

test('callback token is returned once, stored only as hash, and checked safely', async t => {
  let safeComparisons = 0;
  const cryptoImpl = {
    ...nodeCrypto,
    timingSafeEqual(left, right) {
      safeComparisons++;
      assert.equal(left.length, right.length);
      return nodeCrypto.timingSafeEqual(left, right);
    },
  };
  const { file, store, waits } = serviceFixture(t, { cryptoImpl });
  const registered = await waits.register({
    sessionId: 'session-A',
    mode: 'callback',
    injectPrefix: '[external]',
  });

  assert.equal(registered.token, 'raw-callback-secret-1');
  assert.match(registered.callbackUrl, /wait-1/);
  assert.match(registered.callbackUrl, /raw-callback-secret-1/);
  const raw = fs.readFileSync(file, 'utf8');
  assert.equal(raw.includes(registered.token), false);

  const durable = await store.snapshot();
  assert.match(durable.waits['wait-1'].callbackTokenHash, /^[a-f0-9]{64}$/);
  assert.equal(durable.waits['wait-1'].token, undefined);

  const beforeRevision = durable.revision;
  const bad = await waits.resolveCallback('wait-1', 'wrong-secret', { answer: 7 });
  assert.deepEqual(bad, { ok: false, code: 'invalid_token' });
  assert.equal(safeComparisons, 1);
  assert.equal((await store.snapshot()).revision, beforeRevision);
});

test('resolution and outbox admission are one mutation with payload idempotency', async t => {
  const { file, store, waits } = serviceFixture(t);
  const registered = await waits.register({ sessionId: 'session-A', mode: 'callback' });
  const before = await store.snapshot();

  const first = await waits.resolveCallback(
    registered.id,
    registered.token,
    { beta: 2, alpha: 1 },
  );
  assert.equal(first.ok, true);
  assert.equal(first.idempotent, false);

  const after = await store.snapshot();
  assert.equal(after.revision, before.revision + 1);
  assert.equal(after.waits[registered.id].status, 'resolved');
  assert.equal(after.waits[registered.id].outboxId, `wait:${registered.id}`);
  assert.equal(after.outbox[`wait:${registered.id}`].state, 'pending');
  assert.deepEqual(after.outbox[`wait:${registered.id}`].payload.data, { alpha: 1, beta: 2 });
  assert.equal(fs.readFileSync(file, 'utf8').includes(registered.token), false);

  // Canonical JSON treats object key reordering as the same callback payload.
  const duplicate = await waits.resolveCallback(
    registered.id,
    registered.token,
    { alpha: 1, beta: 2 },
  );
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.idempotent, true);
  assert.equal((await store.snapshot()).revision, after.revision);

  const conflict = await waits.resolveCallback(
    registered.id,
    registered.token,
    { alpha: 1, beta: 999 },
  );
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'payload_conflict');
  assert.equal(conflict.statusCode, 409);
  assert.equal((await store.snapshot()).revision, after.revision);
});

test('concurrent duplicate callbacks admit exactly one outbox item', async t => {
  const { store, waits } = serviceFixture(t);
  const registered = await waits.register({ sessionId: 'session-A' });
  const results = await Promise.all([
    waits.resolveCallback(registered.id, registered.token, { done: true }),
    waits.resolveCallback(registered.id, registered.token, { done: true }),
    waits.resolveCallback(registered.id, registered.token, { done: true }),
  ]);

  assert.equal(results.filter(result => result.idempotent === false).length, 1);
  assert.equal(results.filter(result => result.idempotent === true).length, 2);
  const snapshot = await store.snapshot();
  assert.equal(Object.keys(snapshot.outbox).length, 1);
});

test('crash before atomic rename preserves a pending wait with no outbox', async t => {
  let crash = false;
  const hooks = {
    beforeRename() {
      if (crash) throw new Error('injected before-rename crash');
    },
  };
  const { file, waits } = serviceFixture(t, { hooks });
  const registered = await waits.register({ sessionId: 'session-A' });

  crash = true;
  await assert.rejects(
    waits.resolveCallback(registered.id, registered.token, { result: 42 }),
    /before-rename crash/,
  );
  crash = false;

  const rebuiltStore = createOrchestrationStore({ file });
  const rebuilt = await rebuiltStore.snapshot();
  assert.equal(rebuilt.waits[registered.id].status, 'pending');
  assert.equal(Object.keys(rebuilt.outbox).length, 0);

  const rebuiltWaits = createWaitService({ store: rebuiltStore });
  const retry = await rebuiltWaits.resolveCallback(
    registered.id,
    registered.token,
    { result: 42 },
  );
  assert.equal(retry.ok, true);
  assert.equal(retry.idempotent, false);
});

test('crash after atomic rename reconstructs resolved wait and idempotent outbox', async t => {
  let crash = false;
  const hooks = {
    afterRename() {
      if (crash) throw new Error('injected after-rename crash');
    },
  };
  const { file, waits } = serviceFixture(t, { hooks });
  const registered = await waits.register({ sessionId: 'session-A' });

  crash = true;
  await assert.rejects(
    waits.resolveCallback(registered.id, registered.token, { result: 42 }),
    /after-rename crash/,
  );
  crash = false;

  const rebuiltStore = createOrchestrationStore({ file });
  const rebuilt = await rebuiltStore.snapshot();
  assert.equal(rebuilt.waits[registered.id].status, 'resolved');
  assert.equal(Object.keys(rebuilt.outbox).length, 1);

  const rebuiltWaits = createWaitService({ store: rebuiltStore });
  const duplicate = await rebuiltWaits.resolveCallback(
    registered.id,
    registered.token,
    { result: 42 },
  );
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.idempotent, true);

  const conflict = await rebuiltWaits.resolveCallback(
    registered.id,
    registered.token,
    { result: 43 },
  );
  assert.equal(conflict.code, 'payload_conflict');
});

test('poll waits resolve through the same atomic outbox path without a token', async t => {
  const { store, waits } = serviceFixture(t);
  const registered = await waits.register({ sessionId: 'session-P', mode: 'poll' });
  assert.equal('token' in registered, false);

  const resolved = await waits.resolvePoll(registered.id, 'poll output');
  assert.equal(resolved.ok, true);
  const snapshot = await store.snapshot();
  assert.equal(snapshot.waits[registered.id].status, 'resolved');
  assert.equal(snapshot.outbox[`wait:${registered.id}`].payload.data, 'poll output');
});

test('delay waits resolve through the same atomic outbox path without a callback token', async t => {
  const { store, waits } = serviceFixture(t);
  const registered = await waits.register({ sessionId: 'session-D', mode: 'delay' });
  assert.equal('token' in registered, false);

  const resolved = await waits.resolveDelay(
    registered.id,
    { dueAt: 12_345, reason: 'check deployment' },
    { deliveryText: '【延迟条件已到】check deployment' },
  );
  assert.equal(resolved.ok, true);
  const duplicate = await waits.resolveDelay(
    registered.id,
    { reason: 'check deployment', dueAt: 12_345 },
    { deliveryText: '【延迟条件已到】check deployment' },
  );
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.idempotent, true);

  const snapshot = await store.snapshot();
  assert.equal(snapshot.waits[registered.id].status, 'resolved');
  assert.equal(snapshot.outbox[`wait:${registered.id}`].payload.mode, 'delay');
  assert.equal(
    snapshot.outbox[`wait:${registered.id}`].payload.deliveryText,
    '【延迟条件已到】check deployment',
  );
});
