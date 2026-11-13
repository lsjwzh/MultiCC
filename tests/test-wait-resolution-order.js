'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createOrchestrationSqliteStore } = require('../src/orchestration/sqlite-store');
const { createWaitService } = require('../src/wait/service');
const { legacyWaitResolver } = require('./helpers/legacy-wait-resolution');

test('an extra asynchronous worker wait changes the legacy mutation clock observation', async () => {
  async function legacy() {
    let clock = 0;
    const readPayload = () => queueMicrotask(() => { clock = 1; queueMicrotask(() => { clock = 2; }); });
    await (readPayload(), undefined); // The existing store awaits its synchronous mutator once.
    return clock;
  }
  async function withExtraWorkerWait() {
    let clock = 0;
    const readPayload = () => queueMicrotask(() => { clock = 1; queueMicrotask(() => { clock = 2; }); });
    readPayload();
    // Model a worker completion that yields past the legacy continuation.
    await new Promise(resolve => setImmediate(resolve));
    return clock;
  }
  assert.equal(await legacy(), 1);
  assert.equal(await withExtraWorkerWait(), 2);
});

test('wait.resolve uses a Rust command and synchronous commit', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'wait', 'service.js'), 'utf8');
  const start = source.indexOf('  async function resolveInternal(');
  const end = source.indexOf('  async function resolveCallback(', start);
  assert.ok(start >= 0 && end > start, 'wait.resolve implementation is present');
  const body = source.slice(start, end);
  assert.match(body, /store\.runNativeCommandSync\s*\(/,
    'wait.resolve must execute a Rust command with synchronous commit');
  assert.match(body, /waitResolve/, 'wait.resolve must delegate its state transition to Rust');
  assert.doesNotMatch(body, /normalizeJson\s*\(|hashPayload\s*\(/,
    'wait.resolve must not retain Node-owned canonicalization or payload hashing');
});

async function testOrdering(t, useLegacy) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-wait-order-'));
  let clock = 100;
  const store = createOrchestrationSqliteStore({ file: path.join(dir, 'state.sqlite'), now: () => clock });
  t.after(async () => { await store.close({ exportRollback: false }); fs.rmSync(dir, { recursive: true, force: true }); });
  await store.mutate(draft => {
    draft.waits.w = { id: 'w', sessionId: 's', mode: 'callback', status: 'pending', injectPrefix: '',
      callbackTokenHash: crypto.createHash('sha256').update('secret').digest('hex') };
  });
  clock = 0;
  let reads = 0;
  const payload = { get value() {
    reads++;
    queueMicrotask(() => { clock = 1; queueMicrotask(() => { clock = 2; }); });
    return 'result';
  } };
  const waits = createWaitService({ store, now: () => clock });
  const legacy = legacyWaitResolver(store, () => clock);
  const resolve = (token, data) => useLegacy
    ? legacy.resolveInternal('w', data, { callbackToken: token, expectedMode: 'callback' })
    : waits.resolveCallback('w', token, data);
  assert.deepEqual(await resolve('wrong', payload), { ok: false, code: 'invalid_token' });
  assert.equal(reads, 0);
  assert.equal(clock, 0);
  const resolved = await resolve('secret', payload);
  assert.equal(resolved.ok, true);
  const snapshot = await store.snapshot();
  assert.equal(reads, 1);
  assert.equal(snapshot.waits.w.resolvedAt, 0);
  assert.equal(snapshot.updatedAt, useLegacy ? 1 : 0);
  assert.equal(clock, 2);
  assert.equal(snapshot.outbox['wait:w'].payload.data.value, 'result');
}

test('legacy SQLite wait commit observes one payload microtask', t => testOrdering(t, true));
test('Rust SQLite wait commits before payload microtasks', t => testOrdering(t, false));

test('SQLite legacy and Rust wait report 4 MiB event-loop delay on the same addon', async t => {
  const { performance } = require('node:perf_hooks');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-wait-large-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const delays = [];
  const results = [];
  for (const useLegacy of [true, false]) {
    const store = createOrchestrationSqliteStore({ file: path.join(dir, `${useLegacy}.sqlite`), now: () => 1234 });
    await store.mutate(draft => {
      draft.waits.w = { id: 'w', sessionId: 's', mode: 'poll', status: 'pending', injectPrefix: '' };
    });
    const payload = { message: 'x'.repeat(4 * 1024 * 1024) };
    const resolve = useLegacy
      ? () => legacyWaitResolver(store, () => 1234).resolveInternal('w', payload, { expectedMode: 'poll', sessionWork: null })
      : () => createWaitService({ store, now: () => 1234 }).resolvePoll('w', payload);
    const started = performance.now();
    let delay;
    const timeout = new Promise(done => setTimeout(() => { delay = performance.now() - started; done(); }, 0));
    results.push(await resolve());
    await timeout;
    const saved = await store.read(draft => draft.outbox['wait:w'].payload.data.message.length);
    assert.equal(saved, payload.message.length);
    delays.push(delay);
    await store.close({ exportRollback: false });
  }
  assert.deepEqual(results[0], results[1]);
  assert.equal(results[0].ok, true);
  t.diagnostic(`4 MiB payload zero-delay timer: legacy ${delays[0].toFixed(1)} ms; Rust ${delays[1].toFixed(1)} ms`);
});
