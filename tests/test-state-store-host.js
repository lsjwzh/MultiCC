'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const store = require('../src/native/binding').stateStore;

function target(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-state-host-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'state.json');
}

test('a throwing beforeRename keeps the primary and the original error object', t => {
  const file = target(t);
  const calls = [];
  const failure = new Error('callback failure');
  fs.writeFileSync(file, 'old');
  store.setFailureReporter((err, meta) => { calls.push([err, meta]); throw new Error('reporter'); });
  t.after(() => store.setFailureReporter(null));
  assert.throws(() => store.writeTextAtomic(file, 'new', { beforeRename() {
    assert.equal(fs.readFileSync(file, 'utf8'), 'old');
    throw failure;
  } }), err => err === failure);
  assert.deepEqual(calls, [[failure, { operation: 'atomic_write', target: file }]]);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['state.json']);
  assert.equal(fs.readFileSync(file, 'utf8'), 'old');
});

test('a failed final rename keeps a readable primary after backup rotation', t => {
  const file = target(t);
  store.writeJsonAtomic(file, { revision: 1 });
  const rename = fs.renameSync;
  const failure = new Error('injected rename failure');
  t.mock.method(fs, 'renameSync', function (src, dst) {
    if (dst === file) throw failure;
    return rename(src, dst);
  });
  assert.throws(() => store.writeJsonAtomic(file, { revision: 2 }), err => err === failure);
  assert.deepEqual(store.readJson(file).data, { revision: 1 });
  assert.deepEqual(store.readJson(file + '.bak1').data, { revision: 1 });
  assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ['state.json', 'state.json.bak1']);
});

test('raw diagnostics keep the V8 parse message and first 200 UTF-16 units', t => {
  const file = target(t);
  const raw = ' '.repeat(199) + '😀';
  fs.writeFileSync(file, raw);
  let detail;
  try { JSON.parse(raw); } catch (error) { detail = error.message; }
  assert.throws(() => store.createStore({ file }).loadOrRecover(), err =>
    err instanceof store.CorruptedStateError && err.file === file &&
    err.raw === raw.slice(0, 200) && err.message === 'corrupt JSON in ' + file + ': ' + detail);
});
