'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

// Stub only the fixed native export so this exercises the production queue,
// SQLite/JSON transaction and promise boundary, without accepting callbacks as
// commands in the exposed API.
test('fixed native command commits synchronously and never assimilates its result', async t => {
  const runtime = require('../src/native/runtime');
  const original = runtime.getNative;
  const native = original();
  let behavior;
  runtime.getNative = () => new Proxy(native, {
    get(target, key, receiver) {
      if (key === 'waitResolveLive') return (...args) => behavior(...args);
      return Reflect.get(target, key, receiver);
    },
  });
  const { createOrchestrationStore } = require('../src/orchestration/store');
  const { createOrchestrationSqliteStore } = require('../src/orchestration/sqlite-store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-native-sync-'));
  const sqlite = path.join(dir, 'state.sqlite');
  const stores = [createOrchestrationStore({ file: path.join(dir, 'state.json') }),
    createOrchestrationSqliteStore({ file: sqlite })];
  const database = new Database(sqlite);
  t.after(async () => {
    runtime.getNative = original;
    database.close(); await stores[1].close({ exportRollback: false });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  for (const store of stores) {
    const order = [];
    let seenCommitted = false;
    let thenReads = 0;
    const result = { get then() { thenReads++; throw Error('must not assimilate'); } };
    behavior = draft => {
      order.push('command');
      draft.waits.w = { id: 'w', status: 'pending' };
      queueMicrotask(() => {
        order.push('microtask');
        seenCommitted = store.backend === 'sqlite'
          ? !!database.prepare('SELECT 1 FROM orchestration_waits WHERE id=?').get('w')
          : !!JSON.parse(fs.readFileSync(store.file, 'utf8')).waits.w;
      });
      return result;
    };
    const envelope = await store.runNativeCommandSync('waitResolve');
    assert.equal(Object.getPrototypeOf(envelope), null);
    assert.equal(envelope.value, result);
    assert.equal(thenReads, 0);
    assert.equal(seenCommitted, true, store.backend);
    assert.deepEqual(order, ['command', 'microtask']);
    const before = await store.snapshot();
    const sentinel = new Error('abort');
    behavior = draft => { draft.waits.x = { id: 'x' }; throw sentinel; };
    await assert.rejects(store.runNativeCommandSync('waitResolve'), error => error === sentinel);
    assert.deepEqual(await store.snapshot(), before);
    behavior = draft => { draft.waits.x = { id: 'x' }; return Promise.reject(new Error('rejected command')); };
    await assert.rejects(store.runNativeCommandSync('waitResolve'), /returned a promise/);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(await store.snapshot(), before);
    await assert.rejects(store.runNativeCommandSync('arbitrary', () => {}), /unknown synchronous orchestration command/);
  }
});
