'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { createOrchestrationStore } = require('../src/orchestration-store');
const { createOutbox } = require('../src/outbox');

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
