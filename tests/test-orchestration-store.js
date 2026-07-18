'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const {
  OrchestrationStoreCorruptError,
  createOrchestrationStore,
} = require('../src/orchestration-store');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function tempFile(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-orchestration-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, name);
}

test('mutations serialize, persist privately, and survive reconstruction', async t => {
  const file = tempFile(t, 'state.json');
  let clock = 1_000;
  const store = createOrchestrationStore({ file, now: () => ++clock });

  const operations = Array.from({ length: 20 }, (_, index) => store.mutate(async draft => {
    const observed = draft.counter || 0;
    await delay(index % 3);
    draft.counter = observed + 1;
    return draft.counter;
  }));
  const values = await Promise.all(operations);

  assert.deepEqual(values, Array.from({ length: 20 }, (_, index) => index + 1));
  const snapshot = await store.snapshot();
  assert.equal(snapshot.counter, 20);
  assert.equal(snapshot.revision, 20);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  const rebuilt = createOrchestrationStore({ file, now: () => ++clock });
  assert.equal((await rebuilt.snapshot()).counter, 20);
  await rebuilt.mutate(draft => { draft.counter += 1; });
  assert.equal((await rebuilt.snapshot()).counter, 21);
});

test('a failure before rename leaves the previous durable snapshot', async t => {
  const file = tempFile(t, 'before-rename.json');
  let fail = false;
  const hooks = {
    beforeRename() {
      if (fail) throw new Error('crash before rename');
    },
  };
  const store = createOrchestrationStore({ file, hooks });
  await store.mutate(draft => { draft.marker = 'old'; });

  fail = true;
  await assert.rejects(
    store.mutate(draft => { draft.marker = 'new'; }),
    /crash before rename/,
  );
  fail = false;

  const rebuilt = createOrchestrationStore({ file });
  assert.equal((await rebuilt.snapshot()).marker, 'old');
  const names = fs.readdirSync(path.dirname(file));
  assert.equal(names.some(name => name.includes('.tmp.')), false);
});

test('a failure after rename is recovered as a committed mutation', async t => {
  const file = tempFile(t, 'after-rename.json');
  let fail = false;
  const hooks = {
    afterRename() {
      if (fail) throw new Error('crash after rename');
    },
  };
  const store = createOrchestrationStore({ file, hooks });
  await store.mutate(draft => { draft.marker = 'old'; });

  fail = true;
  await assert.rejects(
    store.mutate(draft => { draft.marker = 'new'; }),
    /crash after rename/,
  );
  fail = false;

  // Both the current process and a reconstructed one reload the renamed file.
  assert.equal((await store.snapshot()).marker, 'new');
  const rebuilt = createOrchestrationStore({ file });
  assert.equal((await rebuilt.snapshot()).marker, 'new');
});

test('failed mutation releases the queue and committed state cannot leak mutable references', async t => {
  const file = tempFile(t, 'queue-recovery.json');
  const store = createOrchestrationStore({ file });
  const failed = store.mutate(async draft => {
    draft.value = 'discarded';
    await delay(5);
    throw new Error('mutator failed');
  });
  const next = store.mutate(draft => {
    draft.nested = { value: 'durable' };
    return draft.nested;
  });

  await assert.rejects(failed, /mutator failed/);
  const returned = await next;
  assert.throws(() => { returned.value = 'bypass'; }, TypeError);
  assert.equal((await store.snapshot()).nested.value, 'durable');
  assert.equal((await store.snapshot()).value, undefined);
});

test('corrupt state fails closed instead of resetting orchestration', t => {
  const file = tempFile(t, 'corrupt.json');
  fs.writeFileSync(file, '{broken json', { mode: 0o600 });
  assert.throws(
    () => createOrchestrationStore({ file }),
    error => error instanceof OrchestrationStoreCorruptError,
  );
});
