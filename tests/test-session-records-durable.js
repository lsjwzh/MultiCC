'use strict';

// Durable side of the native session-record owner: byte layout, backup
// rotation, legacy/corrupt/partial fixtures, restart reload, reentrancy and
// object identity. Everything runs in an isolated temp root.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { createSessionPersistence, PersistenceError } = require('../src/session/persistence');
const { createTaskStateStore } = require('../src/routes/task-state-store');
const { createStore, CorruptedStateError } = require('../src/state/store');
const { createSessionRecords, recordsOf, appendClassifyHistory, resetTaskState } = require('./helpers/session-records');

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-records-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function filePersistence(records, file, extra = {}) {
  return createSessionPersistence({
    records,
    file,
    kind: 'sessions',
    root: path.dirname(file),
    retryDelayMs: 1,
    maxRetries: 1,
    setTimeoutFn: callback => { const handle = { callback, unref() {} }; return handle; },
    clearTimeoutFn: () => {},
    ...extra,
  });
}

function normalizeTimestamps(text) {
  return text.replace(/"writtenAt": "[^"]*"/g, '"writtenAt": "<ts>"');
}

test('file save is byte-identical to JSON.stringify(envelope, null, 2)', t => {
  const root = tempRoot(t);
  const nativeFile = path.join(root, 'native', 'sessions.json');
  const legacyFile = path.join(root, 'legacy', 'sessions.json');
  const data = [
    { id: 'a', dirId: 'd1', label: '中文 "quoted" \\ backslash \n tab\t', createdAt: 1 },
    { id: 'b', dirId: 'd1', nested: { list: [1, -0, 1e21, null, true, ''] }, classifyState: 'D' },
    { id: 'c', dirId: 'd2', empty: {}, none: [], surrogate: '\ud800' },
  ];
  const records = recordsOf(data.map(record => [record.id, record]));
  const service = filePersistence(records, nativeFile);
  service.mutate('http.save', map => map.get('a').label = map.get('a').label);
  createStore({ file: legacyFile, kind: 'sessions' }).save(JSON.parse(JSON.stringify(data)));

  const nativeText = fs.readFileSync(nativeFile, 'utf8');
  const legacyText = fs.readFileSync(legacyFile, 'utf8');
  assert.equal(normalizeTimestamps(nativeText), normalizeTimestamps(legacyText));
  assert.equal(nativeText.endsWith('\n'), false, 'no trailing newline, as before');
  assert.equal(fs.statSync(nativeFile).mode & 0o777, 0o600);
  const writtenAt = /"writtenAt": "([^"]+)"/.exec(nativeText)[1];
  assert.match(writtenAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.deepEqual(JSON.parse(nativeText).data, JSON.parse(JSON.stringify(data)));
});

test('backup rotation keeps three rungs of the previous payloads', t => {
  const root = tempRoot(t);
  const file = path.join(root, 'data', 'sessions.json');
  const records = recordsOf([['a', { id: 'a', version: 0 }]]);
  const service = filePersistence(records, file);
  for (let version = 1; version <= 5; version += 1) {
    service.mutate('http.save', map => { map.get('a').version = version; });
  }
  for (const rung of [1, 2, 3]) {
    const backup = `${file}.bak${rung}`;
    assert.ok(fs.existsSync(backup), `bak${rung}`);
    assert.equal(fs.statSync(backup).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(backup, 'utf8')).data[0].version, 5 - rung);
  }
  assert.equal(fs.existsSync(`${file}.bak4`), false);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).data[0].version, 5);
});

test('a legacy bare-array file loads through the boot adapter and saves as the new envelope', t => {
  const root = tempRoot(t);
  const file = path.join(root, 'sessions.json');
  const legacyData = [{ id: 'old', cwd: '/tmp/x', createdAt: 7 }];
  fs.writeFileSync(file, JSON.stringify(legacyData));
  const loaded = createStore({ file, kind: 'sessions' }).load();
  assert.equal(loaded.present, true);
  assert.deepEqual(loaded.data, legacyData);
  const records = createSessionRecords(new Map(loaded.data.map(record => [record.id, record])));
  filePersistence(records, file).mutate('http.migrate', map => map.get('old').kind = 'terminal');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(saved), ['__multiccSchema', 'data']);
  assert.equal(saved.__multiccSchema.kind, 'sessions');
  assert.equal(saved.__multiccSchema.version, 1);
  assert.equal(saved.data[0].kind, 'terminal');
  assert.equal(fs.readFileSync(`${file}.bak1`, 'utf8').startsWith('[{'), true, 'the legacy array is the first backup');
});

test('a corrupt primary recovers from .bak1 and the next save rotates it intact', t => {
  const root = tempRoot(t);
  const file = path.join(root, 'sessions.json');
  const good = { __multiccSchema: { kind: 'sessions', version: 1, writtenAt: 'x' }, data: [{ id: 'kept' }] };
  fs.writeFileSync(`${file}.bak1`, JSON.stringify(good));
  fs.writeFileSync(file, '{"__multiccSchema":{"kind":"sessions","version":1},"data":[{"id":'); // damaged tail
  const store = createStore({ file, kind: 'sessions' });
  assert.throws(() => store.load(), CorruptedStateError, 'fail-closed on a corrupt primary');
  const recovered = store.loadOrRecover();
  assert.equal(recovered.recovered, true);
  assert.deepEqual(recovered.data, [{ id: 'kept' }]);
  fs.writeFileSync(file, JSON.stringify({ __multiccSchema: { kind: 'sessions', version: 1, writtenAt: 'x' }, data: recovered.data }));
  const records = createSessionRecords(new Map(recovered.data.map(record => [record.id, record])));
  filePersistence(records, file).mutate('http.save', map => map.get('kept').note = 'restored');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).data[0].note, 'restored');
  assert.equal(JSON.parse(fs.readFileSync(`${file}.bak1`, 'utf8')).data[0].note, undefined,
    'bak1 is the pre-save primary');
  assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.bak2`, 'utf8')).data, [{ id: 'kept' }],
    'bak2 is the backup the recovery came from');
});

test('a partially written file with no backup fails closed and never silently starts empty', t => {
  const root = tempRoot(t);
  const file = path.join(root, 'sessions.json');
  fs.writeFileSync(file, '[{"id":"a","label":"trunc');
  const store = createStore({ file, kind: 'sessions' });
  assert.throws(() => store.loadOrRecover(), CorruptedStateError);
  assert.equal(fs.readFileSync(file, 'utf8'), '[{"id":"a","label":"trunc', 'nothing rewrote the damaged file');
});

test('restart reload reproduces the same table and keeps saving identical payloads', t => {
  const root = tempRoot(t);
  const file = path.join(root, 'sessions.json');
  const first = recordsOf([
    ['a', { id: 'a', dirId: 'd', taskState: { classifyState: 'P', pendingDispatches: [1, 2] } }],
    ['b', { id: 'b', dirId: 'd', label: '中文' }],
  ]);
  const persistence = filePersistence(first, file);
  persistence.mutate('http.save', map => { map.get('b').label = 'round-1'; });

  const reloaded = JSON.parse(fs.readFileSync(file, 'utf8')).data;
  const second = createSessionRecords(new Map(reloaded.map(record => [record.id, record])));
  assert.deepEqual([...second.entries()], [...first.entries()]);
  assert.deepEqual([...second.keys()], ['a', 'b'], 'insertion order survives the reload');

  const secondPersistence = filePersistence(second, file);
  secondPersistence.mutate('http.save', map => { map.get('b').label = 'round-2'; });
  const third = createSessionRecords(new Map(JSON.parse(fs.readFileSync(file, 'utf8')).data.map(r => [r.id, r])));
  assert.deepEqual([...third.values()], [...second.values()]);
});

test('reentrancy: nested mutate/begin and reused handles fail exactly like the Node lifecycle', t => {
  const root = tempRoot(t);
  const file = path.join(root, 'sessions.json');
  const records = recordsOf([['a', { id: 'a', value: 1 }]]);
  const service = filePersistence(records, file);

  assert.throws(() => service.mutate('http.outer', () => service.mutate('http.inner', () => {})), error =>
    error instanceof PersistenceError && error.code === 'SESSION_PERSISTENCE_FAILED'
    && /nested session persistence mutation/.test(error.message) && error.source === 'http.inner',
  'the inner begin() is the one that refuses');
  assert.deepEqual([...records.values()], [{ id: 'a', value: 1 }], 'the nested failure rolled back nothing');

  assert.throws(() => service.mutate('http.async', async () => 'later'), /mutator must be synchronous/);
  assert.deepEqual([...records.values()], [{ id: 'a', value: 1 }]);

  const tx = service.begin('http.tx');
  assert.throws(() => service.begin('http.tx2'), /nested session persistence mutation/);
  tx.rollback();
  tx.rollback();
  assert.throws(() => tx.commit(), /transaction is closed/);
  assert.equal(Object.isFrozen(tx), true);
});

test('record identity and ordering: the live objects are the table values', t => {
  const root = tempRoot(t);
  const file = path.join(root, 'sessions.json');
  const a = { id: 'a', dirId: 'd' };
  const b = { id: 'b', dirId: 'd' };
  const records = recordsOf([['a', a], ['b', b]]);
  assert.ok(records instanceof Map);
  assert.equal(records.get('a'), a, 'same object, not a clone');
  assert.equal(records.get('b'), b);
  const seen = [];
  records.forEach((value, key) => seen.push([key, value]));
  assert.deepEqual(seen, [['a', a], ['b', b]]);
  assert.deepEqual([...records.values()], [a, b]);
  assert.deepEqual(records.listByDir('d'), [a, b]);
  assert.deepEqual(records.listByDir('other'), []);

  const service = filePersistence(records, file);
  service.mutate('http.delete', map => map.delete('a'));
  assert.equal(records.has('a'), false);
  records.set('a', a);
  assert.deepEqual([...records.keys()], ['b', 'a'], 'a re-added id lands at the end, as Map does');
  assert.equal(records.get('a'), a, 'the re-added value is still the caller object');
  assert.equal(records.size, 2);
});

test('task-state writes and the three direct writers all go through the owner', t => {
  const root = tempRoot(t);
  const file = path.join(root, 'sessions.json');
  const records = recordsOf([['s', { id: 's', dirId: 'd', taskState: { classifyState: 'P', classifyHistory: [{ at: 1, state: 'P' }] } }]]);
  const persistence = filePersistence(records, file);
  const bus = new EventEmitter();
  const busEvents = [];
  bus.on('task:state-changed', (id, prev, next) => busEvents.push([id, prev.classifyState, next.classifyState]));
  const taskStates = createTaskStateStore({ persistedSessions: records, bus, now: () => 1234 });

  assert.equal(taskStates.getTaskState(null).phase, 'idle');
  assert.equal(taskStates.setTaskState('missing', { classifyState: 'D' }), null);

  const next = taskStates.setTaskState('s', { classifyState: 'D' });
  assert.equal(next.classifyUpdatedAt, 1234);
  assert.deepEqual(busEvents, [['s', 'P', 'D']]);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).data[0].taskState.classifyState, 'D');

  // classify history: the 7-day window keeps the entry it is given.
  appendClassifyHistory(records, 's', { at: 5000, state: 'D' }, 4000);
  appendClassifyHistory(records, 's', { at: 3000, state: 'O' }, 4500);
  // Old rows are filtered; the new row is appended unconditionally, as before.
  assert.deepEqual(records.get('s').taskState.classifyHistory.map(entry => entry.at), [5000, 3000]);

  // task deletion resets the state without a save (the caller persists).
  resetTaskState(records, 's');
  assert.deepEqual(records.get('s').taskState, {});
  assert.equal(persistence.status().dirty, false);
});

test('best-effort marker failure rolls back a required mutation with the original error code', t => {
  const root = tempRoot(t);
  const file = path.join(root, 'sessions.json');
  const records = recordsOf([['a', { id: 'a', value: 1 }]]);
  const service = filePersistence(records, file);
  const marker = path.join(root, 'fail');
  fs.writeFileSync(marker, '');
  const previous = process.env.MULTICC_TEST_SESSION_PERSISTENCE_FAIL_FILE;
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  process.env.MULTICC_TEST_SESSION_PERSISTENCE_FAIL_FILE = marker;
  try {
    assert.throws(() => service.mutate('http.save', map => { map.get('a').value = 2; }), error =>
      error instanceof PersistenceError && error.code === 'SESSION_PERSISTENCE_FAILED'
      && error.source === 'http.save' && error.cause && error.cause.code === 'EIO');
    assert.equal(records.get('a').value, 1, 'memory rolled back to the snapshot');
    assert.equal(service.status().dirty, false);
    assert.equal(fs.existsSync(file), false);
  } finally {
    if (previous === undefined) delete process.env.MULTICC_TEST_SESSION_PERSISTENCE_FAIL_FILE;
    else process.env.MULTICC_TEST_SESSION_PERSISTENCE_FAIL_FILE = previous;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

test('GC: a deleted record is not retained by the owner', async () => {
  if (typeof global.gc !== 'function') return; // run with --expose-gc to check
  const records = recordsOf([]);
  let record = { id: 'gone', big: 'x'.repeat(1024) };
  const ref = new WeakRef(record);
  records.set('gone', record);
  records.delete('gone');
  record = null;
  for (let attempt = 0; attempt < 10 && ref.deref() !== undefined; attempt += 1) {
    global.gc();
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(ref.deref(), undefined, 'no strong reference survives delete()');
});
