'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PersistenceError,
  createSessionPersistence,
} = require('../src/session-persistence');

test('required mutation saves a detached snapshot before retaining memory changes', () => {
  const records = new Map([['s1', { id: 's1', label: 'before' }]]);
  const writes = [];
  const service = createSessionPersistence({ records, store: { save: value => writes.push(value) } });
  const result = service.mutate('http.patch-session', map => {
    map.get('s1').label = 'after';
    return 'committed';
  });
  assert.equal(result, 'committed');
  assert.equal(records.get('s1').label, 'after');
  assert.equal(writes[0][0].label, 'after');
  records.get('s1').label = 'later-memory-change';
  assert.equal(writes[0][0].label, 'after', 'store payload cannot retain mutable record references');
  assert.equal(service.status().dirty, false);
});

test('required save failure rolls back create, update and delete and throws stable PersistenceError', () => {
  for (const [name, mutate] of [
    ['create', map => map.set('s2', { id: 's2' })],
    ['update', map => { map.get('s1').label = 'changed'; }],
    ['delete', map => map.delete('s1')],
  ]) {
    const records = new Map([['s1', { id: 's1', label: 'before' }]]);
    const failures = [];
    const service = createSessionPersistence({
      records,
      store: { save() { throw new Error(`injected ${name} EIO`); } },
      onFailure: event => failures.push(event),
    });
    assert.throws(
      () => service.mutate(`http.${name}`, mutate),
      error => error instanceof PersistenceError
        && error.code === 'SESSION_PERSISTENCE_FAILED'
        && error.status === 500
        && error.source === `http.${name}`,
    );
    assert.deepEqual([...records.values()], [{ id: 's1', label: 'before' }]);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].mode, 'required');
    assert.equal(service.status().dirty, false, 'rolled-back HTTP failure does not create dirty memory');
  }
});

test('mutator failure rolls memory back without attempting a save', () => {
  const records = new Map([['s1', { id: 's1', nested: { value: 1 } }]]);
  let saves = 0;
  const service = createSessionPersistence({ records, store: { save() { saves += 1; } } });
  assert.throws(() => service.mutate('http.validation', map => {
    map.get('s1').nested.value = 2;
    throw new Error('validation failed');
  }), /validation failed/);
  assert.equal(records.get('s1').nested.value, 1);
  assert.equal(saves, 0);
});

test('manual transaction can roll back validation or commit only after response data is prepared', () => {
  const records = new Map([['s1', { id: 's1', label: 'before' }]]);
  const writes = [];
  const service = createSessionPersistence({ records, store: { save: value => writes.push(value) } });
  let tx = service.begin('http.patch.validation');
  records.get('s1').label = 'invalid-partial-change';
  tx.rollback();
  assert.equal(records.get('s1').label, 'before');
  assert.equal(writes.length, 0);

  tx = service.begin('http.patch.valid');
  records.get('s1').label = 'after';
  const response = { ...records.get('s1') };
  tx.commit();
  assert.equal(response.label, 'after');
  assert.equal(writes.length, 1);
});

test('best-effort failure remains dirty, logs every attempt and retries only to the bound', () => {
  const records = new Map([['s1', { id: 's1', captured: 'native-id' }]]);
  const scheduled = [];
  const failures = [];
  let saves = 0;
  const service = createSessionPersistence({
    records,
    store: { save() { saves += 1; throw new Error('disk unavailable'); } },
    onFailure: event => failures.push({ mode: event.mode, attempt: event.attempt }),
    setTimeoutFn: callback => { scheduled.push(callback); return { unref() {} }; },
    clearTimeoutFn: () => {},
    maxRetries: 2,
  });
  assert.equal(service.bestEffort('timer.capture-session-id'), false);
  assert.equal(service.status().dirty, true);
  assert.equal(scheduled.length, 1);
  scheduled.shift()();
  assert.equal(scheduled.length, 1);
  scheduled.shift()();
  assert.equal(scheduled.length, 0, 'retry queue is bounded');
  assert.equal(saves, 3, 'one initial attempt plus two retries');
  assert.deepEqual(failures, [
    { mode: 'best_effort', attempt: 0 },
    { mode: 'best_effort_retry', attempt: 1 },
    { mode: 'best_effort_retry', attempt: 2 },
  ]);
  assert.equal(service.status().dirty, true);
});

test('a later successful required mutation flushes prior dirty runtime state', () => {
  const records = new Map([['s1', { id: 's1', value: 1 }]]);
  let fail = true;
  const writes = [];
  const service = createSessionPersistence({
    records,
    store: { save(value) { if (fail) throw new Error('temporary'); writes.push(value); } },
    setTimeoutFn: () => ({ unref() {} }),
    clearTimeoutFn: () => {},
  });
  records.get('s1').value = 2;
  service.bestEffort('runtime');
  assert.equal(service.status().dirty, true);
  fail = false;
  service.mutate('http.patch', map => { map.get('s1').label = 'saved'; });
  assert.equal(service.status().dirty, false);
  assert.deepEqual(writes.at(-1), [{ id: 's1', value: 2, label: 'saved' }]);
});
