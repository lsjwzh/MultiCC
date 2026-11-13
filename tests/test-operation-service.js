'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { createOperationService, OperationConflictError } = require('../src/operation-service');
const { createOrchestrationStore } = require('../src/orchestration/store');
const { createOrchestrationSqliteStore } = require('../src/orchestration/sqlite-store');
const Database = require('better-sqlite3');
const { createLegacyOperationAdmission } = require('./helpers/legacy-operation-admission');

function legacyAdmissionService(store, now = Date.now, cryptoImpl = require('node:crypto')) {
  const publicOperation = operation => {
    if (!operation) return null;
    const copy = JSON.parse(JSON.stringify(operation));
    delete copy.idempotencyKeyHash; delete copy.requestHash; delete copy.resultHash;
    return copy;
  };
  const old = createLegacyOperationAdmission({ now, cryptoImpl, OperationConflictError, publicOperation });
  return {
    admitDetached({ operationId, sessionId, idempotencyKey = null, spec } = {}) {
      if (!sessionId) throw new TypeError('detached operation requires sessionId');
      return store.mutate(draft => old.detached(draft, { operationId, sessionId, idempotencyKey, spec }));
    },
    admitDispatch({ operationId, ownerSessionId, resultSessionId, idempotencyKey = null, spec } = {}) {
      if (!ownerSessionId || !spec || !spec.chatId || !spec.targetId || !spec.message)
        throw new TypeError('dispatch operation requires owner, target chat and message');
      return store.mutate(draft => old.dispatch(draft, { operationId, ownerSessionId, resultSessionId, idempotencyKey, spec }));
    },
  };
}

test('Rust live admission matches the frozen Node oracle with injected clock and SQLite hooks', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-admit-live-oracle-'));
  const stores = [];
  t.after(async () => { for (const store of stores) await store.close({ exportRollback: false }); fs.rmSync(dir, { recursive: true, force: true }); });
  const outcomes = [];
  for (const oracle of [false, true]) {
    let clock = 1000;
    const now = () => ++clock;
    const store = createOrchestrationSqliteStore({ file: path.join(dir, `${oracle}.sqlite`), now, hooks: { beforeCommit() {} } });
    stores.push(store);
    const service = oracle ? legacyAdmissionService(store, now) : createOperationService({ store, now });
    const detached = await service.admitDetached({ operationId: 'op_live', sessionId: 'owner', idempotencyKey: 'key', spec: { command: 'echo', nested: { z: 2, a: 1 } } });
    const duplicate = await service.admitDetached({ operationId: 'op_other', sessionId: 'owner', idempotencyKey: 'key', spec: { nested: { a: 1, z: 2 }, command: 'echo' } });
    const dispatch = await service.admitDispatch({ operationId: 'op_dispatch', ownerSessionId: 'owner',
      spec: { chatId: 'target', targetId: 'agent', message: 'hello', taskStart: true } });
    outcomes.push({ detached, duplicate, dispatch, snapshot: await store.snapshot(), clock });
  }
  assert.deepEqual(outcomes[0], outcomes[1]);
});

test('Rust live admission preserves exotic IDs, owners, injected clock and crypto calls', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-admit-live-exotic-'));
  const stores = [];
  t.after(async () => { for (const store of stores) await store.close({ exportRollback: false }); fs.rmSync(dir, { recursive: true, force: true }); });
  const outcomes = [];
  for (const oracle of [false, true]) {
    const events = [];
    let clock = 1000;
    const now = () => { events.push('clock'); return ++clock; };
    const crypto = require('node:crypto');
    const cryptoImpl = { createHash(algorithm) {
      events.push(`hash:${algorithm}`);
      const hash = crypto.createHash(algorithm);
      return { update(value, encoding) { events.push(`update:${encoding || 'default'}`); hash.update(value, encoding); return this; },
        digest(encoding) { events.push(`digest:${encoding}`); return hash.digest(encoding); } };
    } };
    const store = createOrchestrationSqliteStore({ file: path.join(dir, `${oracle}.sqlite`), now, hooks: { beforeCommit() {} } });
    stores.push(store);
    const service = oracle ? legacyAdmissionService(store, now, cryptoImpl) : createOperationService({ store, now, cryptoImpl });
    const operationId = { [Symbol.toPrimitive](hint) { events.push(`id:${hint}`); return 'object-id'; } };
    const owner = { nested: 1 };
    const idempotencyKey = { toString() { events.push('key'); return 'key'; } };
    let admitted; let error;
    try { admitted = await service.admitDispatch({ operationId, ownerSessionId: owner, idempotencyKey,
      spec: { chatId: 'target', targetId: 'agent', get message() { events.push('spec'); return 'hello'; } } }); }
    catch (caught) { error = [caught.name, caught.message]; }
    let admittedStringOwner; let stringOwnerError;
    try { admittedStringOwner = await service.admitDispatch({ operationId, ownerSessionId: 'owner', idempotencyKey,
      spec: { chatId: 'target', targetId: 'agent', message: 'hello' } }); }
    catch (caught) { stringOwnerError = [caught.name, caught.message]; }
    const snapshot = await store.snapshot();
    outcomes.push({ admitted, error, admittedStringOwner, stringOwnerError, snapshot, events, clock });
  }
  assert.deepEqual(outcomes[0], outcomes[1]);
  assert.ok(outcomes[0].admittedStringOwner);
});

test('Rust live admission preserves malformed ID exception types and messages', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-admit-live-errors-'));
  const stores = [];
  t.after(async () => { for (const store of stores) await store.close({ exportRollback: false }); fs.rmSync(dir, { recursive: true, force: true }); });
  const outcomes = [];
  for (const oracle of [false, true]) {
    const store = createOrchestrationSqliteStore({ file: path.join(dir, `${oracle}.sqlite`), hooks: { beforeCommit() {} } });
    stores.push(store);
    const service = oracle ? legacyAdmissionService(store) : createOperationService({ store });
    const results = [];
    for (const operationId of [42, null, Symbol('detached'), {}]) {
      try { await service.admitDetached({ operationId, sessionId: 'owner', spec: { command: 'echo' } }); }
      catch (error) { results.push([error.name, error.message]); }
    }
    try { await service.admitDispatch({ operationId: Symbol('dispatch'), ownerSessionId: 'owner',
      spec: { chatId: 'target', targetId: 'agent', message: 'hello' } }); }
    catch (error) { results.push([error.name, error.message]); }
    outcomes.push(results);
  }
  assert.deepEqual(outcomes[0], outcomes[1]);
});

test('native operation admission matches the legacy transaction and commits dispatch atomically', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-operation-admit-parity-'));
  const stores = [];
  t.after(async () => {
    for (const store of stores) await store.close({ exportRollback: false });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const outcomes = [];
  for (const oracle of [false, true]) {
    const store = createOrchestrationSqliteStore({ file: path.join(dir, `${oracle}.sqlite`),
      ...(oracle ? { hooks: { beforeCommit() {} } } : {}) });
    stores.push(store);
    const serviceStore = oracle ? store : { ...store, mutate() { throw Error('unexpected legacy mutation'); } };
    const operations = oracle ? legacyAdmissionService(store) : createOperationService({ store: serviceStore });
    const detachedSpec = { command: 'echo hello', z: '\ud83d', '10': 1, '2': 2, nested: { z: 3, a: 1 } };
    const detached = await operations.admitDetached({ operationId: 'op_detached', sessionId: 'owner',
      idempotencyKey: 'key', spec: detachedSpec });
    const duplicate = await operations.admitDetached({ operationId: 'op_other', sessionId: 'owner',
      idempotencyKey: 'key', spec: { nested: { a: 1, z: 3 }, '2': 2, '10': 1, z: '\ud83d', command: 'echo hello' } });
    let conflict;
    try { await operations.admitDetached({ operationId: 'op_new', sessionId: 'owner', idempotencyKey: 'key', spec: { command: 'different' } }); }
    catch (error) { conflict = { name: error.name, code: error.code, message: error.message, operationId: error.operationId }; }
    const dispatch = await operations.admitDispatch({ operationId: 'op_dispatch', ownerSessionId: 'owner',
      resultSessionId: 'reply', idempotencyKey: 'dispatch-key', spec: { chatId: 'target', targetId: 'agent', message: 'hello', taskStart: true } });
    const retry = await operations.admitDispatch({ operationId: 'op_unused', ownerSessionId: 'owner',
      resultSessionId: 'reply', idempotencyKey: 'dispatch-key', spec: { message: 'hello', targetId: 'agent', chatId: 'target', taskStart: true } });
    const withoutClock = value => {
      if (Array.isArray(value)) return value.map(withoutClock);
      if (!value || typeof value !== 'object') return value;
      return Object.fromEntries(Object.entries(value).map(([key, item]) =>
        [key, ['createdAt', 'updatedAt', 'availableAt'].includes(key) && item != null ? 0 : withoutClock(item)]));
    };
    outcomes.push(withoutClock({ detached, duplicate, conflict, dispatch, retry, snapshot: await store.snapshot() }));
  }
  assert.deepEqual(outcomes[0], outcomes[1]);
  assert.equal(outcomes[0].snapshot.outbox['operation:op_dispatch:request'].payload.message, 'hello');
  assert.equal(outcomes[0].snapshot.nextOutboxSequence, 2);
});

test('native dispatch admission rolls back operation, outbox, and sequence on failure', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-admit-atomic-'));
  const file = path.join(dir, 'state.sqlite');
  const store = createOrchestrationSqliteStore({ file });
  const db = new Database(file);
  t.after(async () => { db.close(); await store.close({ exportRollback: false }); fs.rmSync(dir, { recursive: true, force: true }); });
  const before = await store.snapshot();
  db.exec("CREATE TRIGGER fail_operation_admit BEFORE INSERT ON orchestration_operations BEGIN SELECT RAISE(ABORT, 'blocked operation'); END");
  await assert.rejects(createOperationService({ store }).admitDispatch({ operationId: 'op_bad', ownerSessionId: 'owner',
    spec: { chatId: 'target', targetId: 'agent', message: 'hello' } }), /blocked operation/);
  assert.deepEqual(await store.snapshot(), before);
});

test('native admission permits a stale idempotent retry but rejects a stale new write', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-admit-conflict-'));
  const file = path.join(dir, 'state.sqlite');
  const stores = [createOrchestrationSqliteStore({ file }), createOrchestrationSqliteStore({ file })];
  t.after(async () => { for (const store of stores) await store.close({ exportRollback: false }); fs.rmSync(dir, { recursive: true, force: true }); });
  const [first, second] = stores.map(store => createOperationService({ store }));
  const request = { operationId: 'op_one', ownerSessionId: 'owner', idempotencyKey: 'same',
    spec: { chatId: 'target', targetId: 'agent', message: 'hello' } };
  await first.admitDispatch(request);
  assert.equal((await second.admitDispatch({ ...request, operationId: 'op_unused' })).idempotent, true);
  await assert.rejects(second.admitDispatch({ ...request, operationId: 'op_two', idempotencyKey: 'other' }),
    error => error.code === 'ORCHESTRATION_SQLITE_CONFLICT');
  const state = await stores[0].snapshot();
  assert.equal(Object.keys(state.operations).length, 1);
  assert.equal(Object.keys(state.outbox).length, 1);
});

test('native admission preserves proxy/getter canonicalization and invalid-value errors', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-admit-live-'));
  const stores = [false, true].map(oracle => createOrchestrationSqliteStore({
    file: path.join(dir, `${oracle}.sqlite`), ...(oracle ? { hooks: { beforeCommit() {} } } : {}),
  }));
  t.after(async () => { for (const store of stores) await store.close({ exportRollback: false }); fs.rmSync(dir, { recursive: true, force: true }); });
  const outcomes = [];
  for (const [index, store] of stores.entries()) {
    const events = [];
    const spec = new Proxy({ z: 3, get a() { events.push('getter a'); return '\ud83d'; } }, {
      ownKeys(target) { events.push('keys'); return Reflect.ownKeys(target); },
      getPrototypeOf(target) { events.push('prototype'); return Reflect.getPrototypeOf(target); },
      get(target, key, receiver) { events.push(`get ${String(key)}`); return Reflect.get(target, key, receiver); },
    });
    const serviceStore = index ? store : { ...store, mutate() { throw Error('unexpected legacy mutation'); } };
    const service = index ? legacyAdmissionService(store) : createOperationService({ store: serviceStore });
    const result = await service.admitDetached({ operationId: 'op_live', sessionId: 'owner', spec });
    const invalid = [];
    for (const value of [{ x: undefined }, { x: Infinity }, { x() {} }, (() => { const x = {}; x.self = x; return x; })()]) {
      try { await service.admitDetached({ operationId: 'op_invalid', sessionId: 'owner', spec: value }); }
      catch (error) { invalid.push([error.name, error.message]); }
    }
    outcomes.push({ spec: result.spec, events, invalid });
  }
  assert.deepEqual(outcomes[0], outcomes[1]);
});

test('native admission transports a literal isolated surrogate produced by an overridden join', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-admit-join-surrogate-'));
  const stores = [false, true].map(oracle => createOrchestrationSqliteStore({
    file: path.join(dir, `${oracle}.sqlite`), ...(oracle ? { hooks: { beforeCommit() {} } } : {}),
  }));
  t.after(async () => { for (const store of stores) await store.close({ exportRollback: false }); fs.rmSync(dir, { recursive: true, force: true }); });
  const results = [];
  for (const [index, store] of stores.entries()) {
    const serviceStore = index ? store : { ...store, mutate() { throw Error('unexpected legacy mutation'); } };
    const service = index ? legacyAdmissionService(store) : createOperationService({ store: serviceStore });
    const spec = Object.assign([1], { map: () => ({ join: () => '"\ud83d"' }) });
    const admitted = await service.admitDetached({ operationId: 'op_join', sessionId: 'owner', spec });
    results.push(admitted.spec);
  }
  assert.deepEqual(results[0], results[1]);
  assert.equal(results[0][0].charCodeAt(0), 0xd83d);
});

test('operation admission uses Rust live path when a getter changes canonicalization methods', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-admit-canonical-mutation-'));
  const stores = [false, true].map(oracle => createOrchestrationSqliteStore({
    file: path.join(dir, `${oracle}.sqlite`), ...(oracle ? { hooks: { beforeCommit() {} } } : {}),
  }));
  t.after(async () => { for (const store of stores) await store.close({ exportRollback: false }); fs.rmSync(dir, { recursive: true, force: true }); });
  const outcomes = [];
  for (const [index, store] of stores.entries()) {
    const original = Array.prototype.map;
    const events = [];
    const spec = { get a() {
      events.push('getter');
      Array.prototype.map = function (callback, ...args) {
        if (this.length === 1 && this[0] === 'a') return [];
        return Reflect.apply(original, this, [callback, ...args]);
      };
      return 1;
    } };
    try {
      const service = index ? legacyAdmissionService(store) : createOperationService({ store });
      const result = await service.admitDetached({ operationId: 'op_live_map', sessionId: 'owner', spec });
      const snapshot = await store.snapshot();
      outcomes.push({ spec: result.spec, hash: snapshot.operations.op_live_map.requestHash, events });
    } finally { Array.prototype.map = original; }
  }
  assert.deepEqual(outcomes[0], outcomes[1]);
  assert.deepEqual(outcomes[0].events, ['getter']);
});

test('operation admission never invokes hidden toJSON during input normalization', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-admit-hidden-tojson-'));
  const stores = [false, true].map(oracle => createOrchestrationSqliteStore({
    file: path.join(dir, `${oracle}.sqlite`), ...(oracle ? { hooks: { beforeCommit() {} } } : {}),
  }));
  t.after(async () => { for (const store of stores) await store.close({ exportRollback: false }); fs.rmSync(dir, { recursive: true, force: true }); });
  const outcomes = [];
  for (const [index, store] of stores.entries()) {
    const calls = [];
    const spec = { chatId: 'target', targetId: 'agent', message: 'safe', nested: { value: 1 }, array: [1, 2] };
    for (const [name, value] of [['root', spec], ['nested', spec.nested], ['array', spec.array]]) {
      Object.defineProperty(value, 'toJSON', { configurable: true, get() {
        calls.push(name); return () => ({ chatId: 'evil', targetId: 'agent', message: 'changed' });
      } });
    }
    const service = index ? legacyAdmissionService(store) : createOperationService({ store });
    const result = await service.admitDispatch({ operationId: 'op_hidden', ownerSessionId: 'owner', spec });
    const state = await store.snapshot();
    outcomes.push({ calls, message: state.outbox[result.requestOutboxId].payload.message, spec: result.spec });
  }
  assert.deepEqual(outcomes[0], outcomes[1]);
  assert.deepEqual(outcomes[0].calls, []);
  assert.equal(outcomes[0].message, 'safe');
});

test('operation admission does not invoke inherited toJSON on the original input', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-admit-inherited-tojson-'));
  const stores = [false, true].map(oracle => createOrchestrationSqliteStore({
    file: path.join(dir, `${oracle}.sqlite`), ...(oracle ? { hooks: { beforeCommit() {} } } : {}),
  }));
  t.after(async () => { for (const store of stores) await store.close({ exportRollback: false }); fs.rmSync(dir, { recursive: true, force: true }); });
  const original = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
  const outcomes = [];
  for (const [index, store] of stores.entries()) {
    const spec = { chatId: 'target', targetId: 'agent', message: 'safe', nested: { value: 1 } };
    let calls = 0;
    try {
      Object.defineProperty(Object.prototype, 'toJSON', { configurable: true, get() {
        if (this === spec || this === spec.nested) { calls++; return () => ({ chatId: 'evil', message: 'changed' }); }
        return undefined;
      } });
      const service = index ? legacyAdmissionService(store) : createOperationService({ store });
      const result = await service.admitDispatch({ operationId: 'op_inherited', ownerSessionId: 'owner', spec });
      outcomes.push({ calls, message: (await store.snapshot()).outbox[result.requestOutboxId].payload.message });
    } finally {
      if (original) Object.defineProperty(Object.prototype, 'toJSON', original);
      else delete Object.prototype.toJSON;
    }
  }
  assert.deepEqual(outcomes[0], outcomes[1]);
  assert.equal(outcomes[0].calls, 0);
  assert.equal(outcomes[0].message, 'safe');
});

test('native admission byte transport rejects invalid data and snapshots buffer input', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-admit-buffer-'));
  const native = require('../src/native/runtime').getNative();
  const store = new native.RustOrchestrationStore(path.join(dir, 'state.sqlite'), null, Date.now(), { env: {}, policy: {} });
  t.after(async () => { await store.requestAsync('close', {}); fs.rmSync(dir, { recursive: true, force: true }); });
  const input = { id: 'op_buffer', idValueJson: '"op_buffer"', kind: 'detached',
    ownerValueJson: '"owner"', resultValueJson: '"owner"', expectedRevision: 0 };
  assert.throws(() => store.requestAdmissionAsync('unknown', input, Buffer.from('{}')), /invalid admission operation/);
  store.request('begin', {});
  await assert.rejects(store.requestAdmissionAsync('operationAdmitPlan', input, Buffer.from([0xff])), /invalid admission spec UTF-8/);
  store.request('begin', {});
  await assert.rejects(store.requestAdmissionAsync('operationAdmitPlan', input, Buffer.from('{bad')), /ORCHESTRATION_STORE_CORRUPT/);
  store.request('begin', {});
  const bytes = Buffer.from('{"command":"ok"}');
  const pending = store.requestAdmissionAsync('operationAdmitPlan', input, bytes);
  bytes.fill(0);
  assert.equal((await pending).pending, true);
  const committed = await store.requestAdmissionAsync('operationAdmit', input, Buffer.from('{"command":"ok"}'));
  assert.ok(Buffer.isBuffer(committed.resultBuffer));
  assert.equal(JSON.parse(committed.resultBuffer.toString('utf8')).id, 'op_buffer');
});

test('operation admission preserves a dynamically overridden operation ID replace method', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-admit-replace-'));
  const stores = [false, true].map(oracle => createOrchestrationSqliteStore({
    file: path.join(dir, `${oracle}.sqlite`), ...(oracle ? { hooks: { beforeCommit() {} } } : {}),
  }));
  t.after(async () => { for (const store of stores) await store.close({ exportRollback: false }); fs.rmSync(dir, { recursive: true, force: true }); });
  const original = String.prototype.replace;
  const outcomes = [];
  for (const [index, store] of stores.entries()) {
    const sentinel = new Error('replacement sentinel');
    try {
      String.prototype.replace = function (...args) {
        if (String(this) === 'op_replace_sentinel') throw sentinel;
        return Reflect.apply(original, this, args);
      };
      const service = index ? legacyAdmissionService(store) : createOperationService({ store });
      try { await service.admitDetached({ operationId: 'op_replace_sentinel', sessionId: 'owner', spec: { command: 'echo' } }); }
      catch (error) { outcomes[index] = error === sentinel; }
    } finally { String.prototype.replace = original; }
  }
  assert.deepEqual(outcomes, [true, true]);
});

test('native dispatch admission keeps an existing conflicting outbox and inserts nothing', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-admit-outbox-conflict-'));
  const store = createOrchestrationSqliteStore({ file: path.join(dir, 'state.sqlite') });
  t.after(async () => { await store.close({ exportRollback: false }); fs.rmSync(dir, { recursive: true, force: true }); });
  await store.mutate(draft => {
    draft.outbox['operation:op_conflict:request'] = { id: 'operation:op_conflict:request',
      sessionId: 'different', payloadHash: 'bad', sequence: draft.nextOutboxSequence++, state: 'pending' };
  });
  const before = await store.snapshot();
  await assert.rejects(createOperationService({ store }).admitDispatch({ operationId: 'op_conflict', ownerSessionId: 'owner',
    spec: { chatId: 'target', targetId: 'agent', message: 'hello' } }),
  error => error.code === 'OUTBOX_PAYLOAD_CONFLICT' && error.outboxId === 'operation:op_conflict:request');
  assert.deepEqual(await store.snapshot(), before);
});

test('native admission normalizes non-string idempotency keys in the legacy order', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-admit-key-'));
  const stores = [false, true].map(oracle => createOrchestrationSqliteStore({
    file: path.join(dir, `${oracle}.sqlite`), ...(oracle ? { hooks: { beforeCommit() {} } } : {}),
  }));
  t.after(async () => { for (const store of stores) await store.close({ exportRollback: false }); fs.rmSync(dir, { recursive: true, force: true }); });
  const outcomes = [];
  for (const [index, store] of stores.entries()) {
    const events = [];
    const spec = { get command() { events.push('spec getter'); return 'echo ok'; } };
    const idempotencyKey = { toString() { events.push('key conversion'); return '\ud83d'; } };
    const serviceStore = index ? store : { ...store, mutate() { throw Error('unexpected legacy mutation'); } };
    const service = index ? legacyAdmissionService(store) : createOperationService({ store: serviceStore });
    await service.admitDetached({ operationId: 'op_key', sessionId: 'owner', idempotencyKey, spec });
    const duplicate = await service.admitDetached({ operationId: 'op_other', sessionId: 'owner',
      idempotencyKey: '\ufffd', spec: { command: 'echo ok' } });
    outcomes.push({ events, id: duplicate.id, idempotent: duplicate.idempotent });
  }
  assert.deepEqual(outcomes[0], outcomes[1]);
  assert.deepEqual(outcomes[0].events, ['spec getter', 'key conversion']);
  assert.equal(outcomes[0].idempotent, true);
});

test('native admission reads a snapshot established before a spec getter writes concurrently', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-admit-snapshot-'));
  const file = path.join(dir, 'state.sqlite');
  const store = createOrchestrationSqliteStore({ file });
  const db = new Database(file);
  t.after(async () => { db.close(); await store.close({ exportRollback: false }); fs.rmSync(dir, { recursive: true, force: true }); });
  const { hashPayload, hashSecret } = require('../src/outbox');
  const spec = { get command() {
    const operation = { id: 'op_external', kind: 'detached', ownerSessionId: 'owner', status: 'admitted',
      idempotencyKeyHash: hashSecret('key'), requestHash: hashPayload({ command: 'echo ok' }),
      spec: { command: 'echo ok' }, requestOutboxId: null };
    db.prepare('INSERT INTO orchestration_operations(id,data_json,kind,owner_session_id,status) VALUES(?,?,?,?,?)')
      .run(operation.id, JSON.stringify(operation), operation.kind, operation.ownerSessionId, operation.status);
    db.prepare("UPDATE orchestration_meta SET value_json='1' WHERE key='revision'").run();
    return 'echo ok';
  } };
  await assert.rejects(createOperationService({ store }).admitDetached({ operationId: 'op_local', sessionId: 'owner',
    idempotencyKey: 'key', spec }), error => error.code === 'ORCHESTRATION_SQLITE_CONFLICT');
  const state = await store.snapshot();
  assert.ok(state.operations.op_external);
  assert.equal(state.operations.op_local, undefined);
});

test('native dispatch admission preserves primitive operation IDs in records and errors', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-admit-primitive-'));
  const stores = [false, true].map(oracle => createOrchestrationSqliteStore({
    file: path.join(dir, `${oracle}.sqlite`), ...(oracle ? { hooks: { beforeCommit() {} } } : {}),
  }));
  t.after(async () => { for (const store of stores) await store.close({ exportRollback: false }); fs.rmSync(dir, { recursive: true, force: true }); });
  const outcomes = [];
  for (const [index, store] of stores.entries()) {
    const serviceStore = index ? store : { ...store, mutate() { throw Error('unexpected legacy mutation'); } };
    const service = index ? legacyAdmissionService(store) : createOperationService({ store: serviceStore });
    const results = [];
    for (const operationId of [7, true, null, '']) {
      const request = { operationId, ownerSessionId: 'owner', spec: { chatId: 'target', targetId: 'agent', message: 'hello' } };
      const admitted = await service.admitDispatch(request);
      let conflict;
      try { await service.admitDispatch(request); }
      catch (error) { conflict = { name: error.name, code: error.code, message: error.message, id: error.operationId }; }
      const entry = await store.read(state => state.outbox[`operation:${operationId}:request`]);
      results.push({ id: admitted.id, requestOutboxId: admitted.requestOutboxId, conflict,
        payloadId: entry.payload.operationId, sourceId: entry.source.operationId });
    }
    outcomes.push(results);
  }
  assert.deepEqual(outcomes[0], outcomes[1]);
});

test('native admission preserves primitive owner types and idempotency isolation', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-admit-owner-'));
  const stores = [false, true].map(oracle => createOrchestrationSqliteStore({
    file: path.join(dir, `${oracle}.sqlite`), ...(oracle ? { hooks: { beforeCommit() {} } } : {}),
  }));
  t.after(async () => { for (const store of stores) await store.close({ exportRollback: false }); fs.rmSync(dir, { recursive: true, force: true }); });
  const outcomes = [];
  for (const [index, store] of stores.entries()) {
    const serviceStore = index ? store : { ...store, mutate() { throw Error('unexpected legacy mutation'); } };
    const service = index ? legacyAdmissionService(store) : createOperationService({ store: serviceStore });
    const results = [];
    for (const [operationId, sessionId] of [['op_num', 1], ['op_bool', true], ['op_str', '1']]) {
      const request = { operationId, sessionId, idempotencyKey: 'same', spec: { command: 'echo ok' } };
      const admitted = await service.admitDetached(request);
      const retry = await service.admitDetached({ ...request, operationId: `${operationId}_retry` });
      results.push({ id: admitted.id, owner: admitted.ownerSessionId, result: admitted.resultSessionId,
        retryId: retry.id, retryOwner: retry.ownerSessionId, idempotent: retry.idempotent });
    }
    outcomes.push(results);
  }
  assert.deepEqual(outcomes[0], outcomes[1]);
});

test('native dispatch admission preserves malformed outbox-input errors and rollback', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-admit-invalid-dispatch-'));
  const stores = [false, true].map(oracle => createOrchestrationSqliteStore({
    file: path.join(dir, `${oracle}.sqlite`), ...(oracle ? { hooks: { beforeCommit() {} } } : {}),
  }));
  t.after(async () => { for (const store of stores) await store.close({ exportRollback: false }); fs.rmSync(dir, { recursive: true, force: true }); });
  const outcomes = [];
  for (const [index, store] of stores.entries()) {
    const serviceStore = index ? store : { ...store, mutate() { throw Error('unexpected legacy mutation'); } };
    const service = index ? legacyAdmissionService(store) : createOperationService({ store: serviceStore });
    const errors = [];
    for (const spec of [{ chatId: 42, targetId: 'agent', message: 'hello' },
      { chatId: 'target', targetId: 'agent', message: 'hello', taskShellReceiptId: 'receipt' }]) {
      try { await service.admitDispatch({ operationId: 'op_invalid', ownerSessionId: 'owner', spec }); }
      catch (error) { errors.push([error.name, error.message]); }
    }
    outcomes.push({ errors, snapshot: await store.snapshot() });
  }
  // Initialization timestamps vary; only the database contents and revision matter.
  for (const outcome of outcomes) outcome.snapshot.updatedAt = 0;
  assert.deepEqual(outcomes[0], outcomes[1]);
  assert.equal(outcomes[0].snapshot.revision, 0);
});

test('native dispatch admission stores an isolated-surrogate target session losslessly', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-admit-surrogate-session-'));
  const stores = [false, true].map(oracle => createOrchestrationSqliteStore({
    file: path.join(dir, `${oracle}.sqlite`), ...(oracle ? { hooks: { beforeCommit() {} } } : {}),
  }));
  t.after(async () => { for (const store of stores) await store.close({ exportRollback: false }); fs.rmSync(dir, { recursive: true, force: true }); });
  const outcomes = [];
  for (const [index, store] of stores.entries()) {
    const serviceStore = index ? store : { ...store, mutate() { throw Error('unexpected legacy mutation'); } };
    const admitted = await (index ? legacyAdmissionService(store) : createOperationService({ store: serviceStore })).admitDispatch({ operationId: 'op_surrogate',
      ownerSessionId: 'owner', spec: { chatId: '\ud83d', targetId: 'agent', message: 'hello' } });
    const outbox = (await store.snapshot()).outbox[admitted.requestOutboxId];
    outcomes.push({ sessionId: outbox.sessionId, targetId: outbox.payload.targetId });
  }
  assert.deepEqual(outcomes[0], outcomes[1]);
  assert.equal(outcomes[0].sessionId, '\ud83d');
});

test('native dispatch admission preserves symbol IDs and idempotent retries', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-admit-symbol-'));
  const stores = [false, true].map(oracle => createOrchestrationSqliteStore({
    file: path.join(dir, `${oracle}.sqlite`), ...(oracle ? { hooks: { beforeCommit() {} } } : {}),
  }));
  t.after(async () => { for (const store of stores) await store.close({ exportRollback: false }); fs.rmSync(dir, { recursive: true, force: true }); });
  const outcomes = [];
  for (const [index, store] of stores.entries()) {
    const serviceStore = index ? store : { ...store, mutate() { throw Error('unexpected legacy mutation'); } };
    const service = index ? legacyAdmissionService(store) : createOperationService({ store: serviceStore });
    const base = { ownerSessionId: 'owner', spec: { chatId: 'target', targetId: 'agent', message: 'hello' } };
    let error;
    try { await service.admitDispatch({ ...base, operationId: Symbol('new') }); }
    catch (caught) { error = [caught.name, caught.message]; }
    await service.admitDispatch({ ...base, operationId: 'op_first', idempotencyKey: 'key' });
    const retry = await service.admitDispatch({ ...base, operationId: Symbol('retry'), idempotencyKey: 'key' });
    outcomes.push({ error, id: retry.id, idempotent: retry.idempotent });
  }
  assert.deepEqual(outcomes[0], outcomes[1]);
  assert.equal(outcomes[0].idempotent, true);
});

test('native detached admission handles symbol owners with legacy JSON omission', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-admit-symbol-owner-'));
  const stores = [false, true].map(oracle => createOrchestrationSqliteStore({
    file: path.join(dir, `${oracle}.sqlite`), ...(oracle ? { hooks: { beforeCommit() {} } } : {}),
  }));
  t.after(async () => { for (const store of stores) await store.close({ exportRollback: false }); fs.rmSync(dir, { recursive: true, force: true }); });
  const outcomes = [];
  for (const [index, store] of stores.entries()) {
    const serviceStore = index ? store : { ...store, mutate() { throw Error('unexpected legacy mutation'); } };
    const service = index ? legacyAdmissionService(store) : createOperationService({ store: serviceStore });
    const sessionId = Symbol('owner');
    const first = await service.admitDetached({ operationId: 'op_a', sessionId, idempotencyKey: 'same', spec: { command: 'echo' } });
    const second = await service.admitDetached({ operationId: 'op_b', sessionId, idempotencyKey: 'same', spec: { command: 'echo' } });
    outcomes.push([Object.hasOwn(first, 'ownerSessionId'), Object.hasOwn(first, 'resultSessionId'),
      first.id, second.id, second.idempotent]);
  }
  assert.deepEqual(outcomes[0], outcomes[1]);
});

test('native admission evaluates inherited operation IDs after spec canonicalization', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-admit-prototype-'));
  const stores = [false, true].map(oracle => createOrchestrationSqliteStore({
    file: path.join(dir, `${oracle}.sqlite`), ...(oracle ? { hooks: { beforeCommit() {} } } : {}),
  }));
  t.after(async () => { for (const store of stores) await store.close({ exportRollback: false }); fs.rmSync(dir, { recursive: true, force: true }); });
  const outcomes = [];
  for (const [index, store] of stores.entries()) {
    const events = [];
    Object.defineProperty(Object.prototype, 'multiccAdmissionInherited', {
      configurable: true, get() { events.push('prototype'); return true; },
    });
    try {
      const serviceStore = index ? store : { ...store, mutate() { throw Error('unexpected legacy mutation'); } };
      const service = index ? legacyAdmissionService(store) : createOperationService({ store: serviceStore });
      let error;
      try { await service.admitDetached({ operationId: 'multiccAdmissionInherited', sessionId: 'owner',
        spec: { get command() { events.push('spec'); return 'echo'; } } }); }
      catch (caught) { error = [caught.name, caught.code, caught.message]; }
      outcomes.push({ error, events });
    } finally { delete Object.prototype.multiccAdmissionInherited; }
  }
  assert.deepEqual(outcomes[0], outcomes[1]);
  assert.deepEqual(outcomes[0].events, ['spec', 'prototype']);
});

test('SQLite operation running command matches the JSON store across retries and terminal states', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-running-parity-'));
  const stores = [];
  t.after(async () => {
    for (const store of stores) if (store.backend === 'sqlite') await store.close({ exportRollback: false });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const outcomes = [];
  for (const kind of ['json', 'sqlite-constant', 'sqlite', 'sqlite-oracle']) {
    let clock = 1000;
    const now = ['json', 'sqlite-constant'].includes(kind) ? () => 1000 : () => ++clock;
    const store = kind === 'json'
      ? createOrchestrationStore({ file: path.join(dir, 'legacy.json'), now })
      : createOrchestrationSqliteStore({ file: path.join(dir, `${kind}.sqlite`), now,
        ...(kind === 'sqlite-oracle' ? { hooks: { beforeCommit() {} } } : {}) });
    stores.push(store);
    await store.mutate(draft => {
      draft.operations.job = { id: 'job', status: 'admitted', startedAt: null,
        requestHash: 'private', spec: { text: '\ud83d', body: '正文' } };
      draft.operations.done = { id: 'done', status: 'completed', resultHash: 'private',
        result: { text: '\ude00' } };
    });
    const operations = createOperationService({ store, now });
    const outcome = [
      await operations.markRunning('missing'),
      await operations.markRunning('done', { pid: '20' }),
      await operations.markRunning('job', { pid: '20', externalId: '\ud83d' }),
      await operations.markRunning('job', { pid: 20, externalId: '\ud83d' }),
      await operations.markRunning('job', { pid: 'not a number', externalId: '' }),
      await operations.markRunning('job', { pid: 21 }),
      await store.snapshot(),
    ];
    if (['json', 'sqlite-constant'].includes(kind)) outcomes.push(outcome);
    else outcomes.push([outcome, clock]);
  }
  assert.deepEqual(outcomes[0], outcomes[1]);
  assert.deepEqual(outcomes[2], outcomes[3]);
  // JSON store consumes a clock tick for its temporary filename, so compare
  // the same state machine under a constant clock in a separate fixture.
});

test('SQLite operation running command preserves atomicity and rejects stale snapshots', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-running-atomic-'));
  const file = path.join(dir, 'state.sqlite');
  const store = createOrchestrationSqliteStore({ file, now: () => 2000 });
  const other = createOrchestrationSqliteStore({ file, now: () => 2000 });
  const db = new Database(file);
  t.after(async () => { db.close(); await store.close({ exportRollback: false });
    await other.close({ exportRollback: false }); fs.rmSync(dir, { recursive: true, force: true }); });
  await store.mutate(draft => { draft.operations.job = { id: 'job', status: 'admitted' }; });
  const before = await store.snapshot();
  const operations = createOperationService({ store, now: () => 1000 });
  await assert.rejects(createOperationService({ store, now: () => { throw Error('clock failed'); } }).markRunning('job'), /clock failed/);
  assert.deepEqual(await store.snapshot(), before);
  db.exec("CREATE TRIGGER fail_running BEFORE UPDATE ON orchestration_operations BEGIN SELECT RAISE(ABORT, 'blocked update'); END");
  await assert.rejects(operations.markRunning('job'), /blocked update/);
  assert.deepEqual(await store.snapshot(), before);
  db.exec('DROP TRIGGER fail_running');
  await assert.rejects(createOperationService({ store: other, now: () => 1000 }).markRunning('job'),
    error => error.code === 'ORCHESTRATION_SQLITE_CONFLICT');
  assert.deepEqual(await store.snapshot(), before);
  assert.equal((await operations.markRunning('job')).operation.startedAt, 1000);
  assert.equal((await store.snapshot()).revision, before.revision + 1);
});

test('SQLite operation running reads mutable patches when the queued mutation executes', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-running-queue-'));
  const results = [];
  for (const oracle of [false, true]) {
    const store = createOrchestrationSqliteStore({ file: path.join(dir, `${oracle}.sqlite`),
      now: () => 1000, ...(oracle ? { hooks: { beforeCommit() {} } } : {}) });
    t.after(async () => { await store.close({ exportRollback: false }); });
    await store.mutate(draft => { draft.operations.job = { id: 'job', status: 'admitted' }; });
    let unblock;
    const gate = new Promise(resolve => { unblock = resolve; });
    const previous = store.mutate(async draft => { await gate; draft.tasks.blocker = { id: 'blocker' }; });
    const patch = { pid: 1, externalId: 'old' };
    const pending = createOperationService({ store, now: () => 1000 }).markRunning('job', patch);
    patch.pid = 2; patch.externalId = 'new';
    unblock();
    await previous;
    results.push(await pending);
  }
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(results[0], results[1]);
  assert.equal(results[0].operation.pid, 2);
  assert.equal(results[0].operation.externalId, 'new');
});

test('SQLite operation running defers Proxy and accessor handling until needed', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-running-proxy-'));
  const store = createOrchestrationSqliteStore({ file: path.join(dir, 'state.sqlite'), now: () => 1000 });
  t.after(async () => { await store.close({ exportRollback: false }); fs.rmSync(dir, { recursive: true, force: true }); });
  await store.mutate(draft => {
    draft.operations.done = { id: 'done', status: 'completed' };
    draft.operations.job = { id: 'job', status: 'admitted' };
    draft.operations.other = { id: 'other', status: 'admitted' };
  });
  const service = createOperationService({ store, now: () => 1000 });
  const hostile = new Proxy({}, {
    get() { throw new Error('unexpected get'); },
    ownKeys() { throw new Error('unexpected ownKeys'); },
    getPrototypeOf() { throw new Error('unexpected getPrototypeOf'); },
  });
  assert.deepEqual(await service.markRunning('missing', hostile), { ok: false, code: 'not_found' });
  assert.equal((await service.markRunning('done', hostile)).idempotent, true);
  const result = await service.markRunning('job', { get pid() { return 9; } });
  assert.equal(result.operation.pid, 9);
  const patch = { pid: 1 };
  const id = { [Symbol.toPrimitive]() { patch.pid = 5; return 'other'; } };
  assert.equal((await service.markRunning(id, patch)).operation.pid, 5);
});

test('SQLite operation running preserves inherited JavaScript property keys', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-running-key-'));
  const stores = [false, true].map(oracle => createOrchestrationSqliteStore({
    file: path.join(dir, `${oracle}.sqlite`), now: () => 1000,
    ...(oracle ? { hooks: { beforeCommit() {} } } : {}),
  }));
  t.after(async () => { for (const store of stores) await store.close({ exportRollback: false });
    fs.rmSync(dir, { recursive: true, force: true }); });
  const original = Object.getOwnPropertyDescriptor(Object.prototype, 'status');
  Object.defineProperty(Object.prototype, 'status', { value: 'completed', configurable: true });
  try {
    const outcomes = [];
    for (const store of stores) {
      const service = createOperationService({ store, now: () => 1000 });
      const result = [];
      for (const id of ['toString', '__proto__', 'constructor', Symbol.iterator]) {
        try { result.push({ value: await service.markRunning(id) }); }
        catch (error) { result.push({ name: error.name, message: error.message }); }
      }
      outcomes.push(result);
    }
    assert.deepEqual(outcomes[0], outcomes[1]);
  } finally {
    if (original) Object.defineProperty(Object.prototype, 'status', original);
    else delete Object.prototype.status;
  }
});

function fixture(t, { hooks = {}, clock = { value: 1_000 } } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-operation-data-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const file = path.join(dataDir, 'orchestration.json');
  const store = createOrchestrationStore({ file, now: () => ++clock.value, hooks });
  let sequence = 0;
  const service = createOperationService({
    store,
    now: () => ++clock.value,
    idFactory: () => `op_test_${++sequence}`,
  });
  return { dataDir, file, store, service, clock };
}

test('detached admission stores only an idempotency hash and rejects key reuse with different content', async t => {
  const { file, service } = fixture(t);
  const spec = { command: 'build --safe', cwd: '/tmp/project', label: 'build' };
  const first = await service.admitDetached({
    sessionId: 'parent-A',
    idempotencyKey: 'raw-detached-secret',
    spec,
  });
  const duplicate = await service.admitDetached({
    sessionId: 'parent-A',
    idempotencyKey: 'raw-detached-secret',
    spec: { label: 'build', cwd: '/tmp/project', command: 'build --safe' },
  });

  assert.equal(duplicate.id, first.id);
  assert.equal(duplicate.idempotent, true);
  assert.equal(first.externalId.startsWith('d_'), true);
  await assert.rejects(
    service.admitDetached({
      sessionId: 'parent-A',
      idempotencyKey: 'raw-detached-secret',
      spec: { ...spec, command: 'deploy --unsafe' },
    }),
    error => error instanceof OperationConflictError && error.statusCode === 409,
  );

  const disk = fs.readFileSync(file, 'utf8');
  assert.equal(disk.includes('raw-detached-secret'), false);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('detached completion and result delivery survive an after-rename crash as one mutation', async t => {
  let crashAfterRename = false;
  const { file, service } = fixture(t, {
    hooks: {
      afterRename() {
        if (crashAfterRename) throw new Error('simulated crash after rename');
      },
    },
  });
  const admitted = await service.admitDetached({
    sessionId: 'parent-A',
    spec: { command: 'compile', cwd: '/tmp', label: 'compile' },
  });

  crashAfterRename = true;
  await assert.rejects(
    service.completeDetached(admitted.id, { exitCode: 0, logTail: 'DONE' }),
    /simulated crash after rename/,
  );
  crashAfterRename = false;

  const rebuiltStore = createOrchestrationStore({ file });
  const rebuilt = createOperationService({ store: rebuiltStore });
  const operation = await rebuilt.get(admitted.id);
  const snapshot = await rebuiltStore.snapshot();
  assert.equal(operation.status, 'completed');
  assert.equal(operation.result.exitCode, 0);
  assert.equal(snapshot.outbox[`operation:${admitted.id}:result`].state, 'pending');
  assert.equal(snapshot.outbox[`operation:${admitted.id}:result`].sessionId, 'parent-A');
});

test('dispatch request/result outboxes are atomic and duplicate results are payload-idempotent', async t => {
  const { store, service } = fixture(t);
  const admitted = await service.admitDispatch({
    ownerSessionId: 'commander',
    resultSessionId: 'commander',
    idempotencyKey: 'dispatch-42',
    spec: {
      targetId: 'worker',
      targetLabel: 'Worker',
      chatId: 'worker-chat',
      message: 'inspect module',
      replyTo: 'commander',
      gateway: false,
      taskId: 'tsk-stable',
      taskStart: true,
      taskSource: 'task-board',
      taskText: '完整真实正文',
    },
  });
  let snapshot = await store.snapshot();
  assert.equal(snapshot.operations[admitted.id].requestOutboxId, `operation:${admitted.id}:request`);
  assert.equal(snapshot.outbox[`operation:${admitted.id}:request`].payload.type, 'dispatch.request');
  assert.deepEqual(
    {
      taskId: snapshot.outbox[`operation:${admitted.id}:request`].payload.taskId,
      taskStart: snapshot.outbox[`operation:${admitted.id}:request`].payload.taskStart,
      taskSource: snapshot.outbox[`operation:${admitted.id}:request`].payload.taskSource,
      taskText: snapshot.outbox[`operation:${admitted.id}:request`].payload.taskText,
    },
    {
      taskId: 'tsk-stable',
      taskStart: true,
      taskSource: 'task-board',
      taskText: '完整真实正文',
    },
  );

  const first = await service.completeDispatch(admitted.id, {
    status: 'completed', text: 'all clear', details: { b: 2, a: 1 },
  });
  const duplicate = await service.completeDispatch(admitted.id, {
    details: { a: 1, b: 2 }, text: 'all clear', status: 'completed',
  });
  assert.equal(first.idempotent, false);
  assert.equal(duplicate.idempotent, true);
  await assert.rejects(
    service.completeDispatch(admitted.id, { status: 'completed', text: 'different' }),
    error => error instanceof OperationConflictError && error.statusCode === 409,
  );

  snapshot = await store.snapshot();
  assert.deepEqual(
    Object.keys(snapshot.outbox).filter(id => id.includes(admitted.id)).sort(),
    [`operation:${admitted.id}:request`, `operation:${admitted.id}:result`],
  );
});

test('one-way Commander dispatch completes durably without a result outbox', async t => {
  const { store, service } = fixture(t);
  const admitted = await service.admitDispatch({
    ownerSessionId: 'commander',
    resultSessionId: 'commander',
    idempotencyKey: 'one-way-1',
    spec: {
      targetId: 'worker', chatId: 'worker', message: 'implement',
      replyTo: null, gateway: false, oneWay: true,
    },
  });
  const completed = await service.completeDispatch(admitted.id, {
    status: 'completed', text: 'done',
  });
  assert.equal(completed.ok, true);
  const operation = await service.get(admitted.id);
  const snapshot = await store.snapshot();
  assert.equal(operation.status, 'completed');
  assert.equal(operation.resultOutboxId, null);
  assert.equal(snapshot.outbox[`operation:${admitted.id}:request`].payload.type, 'dispatch.request');
  assert.equal(snapshot.outbox[`operation:${admitted.id}:result`], undefined);
});

test('async dispatch completes durably and emits a backflow outbox entry', async t => {
  const { store, service } = fixture(t);
  const admitted = await service.admitDispatch({
    ownerSessionId: 'master',
    resultSessionId: 'master',
    idempotencyKey: 'async-return-1',
    spec: {
      targetId: 'worker', chatId: 'worker', message: 'implement',
      replyTo: 'master', gateway: false, oneWay: false, resultMode: 'async',
      taskId: 'task-1',
    },
  });
  await service.completeDispatch(admitted.id, {
    status: 'completed', text: 'done', source: 'dispatch_slave',
  });
  const operation = await service.get(admitted.id);
  const snapshot = await store.snapshot();
  assert.equal(operation.status, 'completed');
  assert.equal(operation.result.text, 'done');
  const outboxEntry = snapshot.outbox[`operation:${admitted.id}:result`];
  assert.ok(outboxEntry, 'backflow outbox entry must exist for resultMode=async');
  assert.equal(outboxEntry.payload.type, 'dispatch.result');
  // The result runs as the dispatcher's own turn; carrying the worker task's
  // identity here pinned the worker card to 执行中 and wedged the dispatcher.
  assert.equal(outboxEntry.payload.taskId, undefined);
  assert.match(outboxEntry.payload.deliveryText, /📜 dispatch 结果回流/);
  assert.match(outboxEntry.payload.deliveryText, /done/);
});

test('sync dispatch completes durably without inserting a result message', async t => {
  const { store, service } = fixture(t);
  const admitted = await service.admitDispatch({
    ownerSessionId: 'master',
    resultSessionId: 'master',
    idempotencyKey: 'sync-return-1',
    spec: {
      targetId: 'worker', chatId: 'worker', message: 'implement',
      replyTo: 'master', gateway: false, oneWay: false, resultMode: 'sync',
    },
  });
  await service.completeDispatch(admitted.id, {
    status: 'completed', text: 'inline result', source: 'post_turn',
  });
  const operation = await service.get(admitted.id);
  const snapshot = await store.snapshot();
  assert.equal(operation.result.text, 'inline result');
  assert.equal(operation.resultOutboxId, null);
  assert.equal(snapshot.outbox[`operation:${admitted.id}:result`], undefined);
});

test('task ledger records terminal output and interrupts only unproven active tasks', async t => {
  const { store, service } = fixture(t);
  await service.observeTask({
    sessionId: 'parent', taskId: 'done-1', status: 'running',
    detail: { kind: 'agent-task', description: 'finished task' },
  });
  await service.observeTask({
    sessionId: 'parent', taskId: 'done-1', status: 'completed',
    detail: { lastOutput: 'verified output' },
  });
  await service.observeTask({
    sessionId: 'parent', taskId: 'done-1', status: 'failed',
    detail: { error: 'late contradictory event' },
  });
  await service.observeTask({
    sessionId: 'parent', taskId: 'live-1', status: 'running',
    detail: { kind: 'background-task', description: 'unproven task' },
  });

  const interrupted = await service.interruptActiveTasks();
  assert.deepEqual(interrupted.map(entry => entry.taskId), ['live-1']);
  const tasks = await service.listTasks({ sessionId: 'parent' });
  assert.equal(tasks.find(entry => entry.taskId === 'done-1').status, 'completed');
  assert.equal(tasks.find(entry => entry.taskId === 'done-1').lastOutput, 'verified output');
  assert.equal(tasks.find(entry => entry.taskId === 'done-1').error, null);
  assert.equal(tasks.find(entry => entry.taskId === 'live-1').status, 'interrupted');

  const snapshot = await store.snapshot();
  const notifications = Object.values(snapshot.outbox)
    .filter(item => item.payload.type === 'task.interrupted');
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].sessionId, 'parent');
});

test('schema v1 wait/outbox state migrates without losing existing records', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-operation-v1-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const file = path.join(dataDir, 'orchestration.json');
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    revision: 3,
    updatedAt: 10,
    nextOutboxSequence: 2,
    waits: { old: { id: 'old' } },
    outbox: { old: { id: 'old' } },
  }), { mode: 0o600 });

  const store = createOrchestrationStore({ file });
  const before = await store.snapshot();
  assert.equal(before.schemaVersion, 3);
  assert.equal(before.waits.old.id, 'old');
  assert.deepEqual(before.operations, {});
  assert.deepEqual(before.sessionSchedules, {});
  await store.mutate(draft => { draft.migrated = true; });
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(disk.schemaVersion, 3);
  assert.equal(disk.outbox.old.id, 'old');
});

test('recovery references omit message and result bodies while public operation reads remain isolated', async t => {
  const { service } = fixture(t);
  const message = 'large-dispatch-body:'.repeat(4096);
  const operation = await service.admitDispatch({ ownerSessionId: 'parent', idempotencyKey: 'private-key',
    spec: { chatId: 'child', targetId: 'target', taskId: 'task', message, resultMode: 'sync', oneWay: true } });
  await service.completeDispatch(operation.id, { status: 'completed', text: message, detail: { value: 7 } });
  const [reference] = await service.listReferences({ kind: 'dispatch', ownerSessionId: 'parent' });
  assert.equal(reference.id, operation.id);
  assert.deepEqual(reference.spec, { chatId: 'child', targetId: 'target', taskId: 'task', resultMode: 'sync', oneWay: true });
  assert.equal('result' in reference, false);
  assert.equal('idempotencyKeyHash' in reference, false);
  assert.equal(typeof reference.completedAt, 'number');
  assert.equal(typeof reference.updatedAt, 'number');
  assert.deepEqual(await service.listReferences({ statuses: ['completed'], excludeTerminal: true }), []);
  const full = await service.get(operation.id);
  assert.equal(full.spec.message, message);
  assert.equal(full.result.text, message);
  assert.equal('requestHash' in full, false);
  full.spec.message = 'changed by reader';
  full.result.detail.value = 8;
  const [listed] = await service.list({ ownerSessionId: 'parent' });
  assert.equal(listed.spec.message, message);
  assert.equal(listed.result.detail.value, 7);
  listed.result.detail.value = 9;
  assert.equal((await service.get(operation.id)).result.detail.value, 7);
});

test('native recovery references never access heavy bodies and still exclude requested terminal states', async () => {
  const body = { chatId: 'child', targetId: 'target', taskId: 'task', resultMode: 'sync', oneWay: false };
  Object.defineProperty(body, 'message', { enumerable: true, get() { throw new Error('read dispatch body'); } });
  const rows = [
    { id: 'active', kind: 'dispatch', ownerSessionId: 'parent', status: 'running', createdAt: 2, spec: body },
    { id: 'finished', kind: 'dispatch', ownerSessionId: 'parent', status: 'completed', createdAt: 1, spec: body },
  ];
  for (const row of rows) Object.defineProperty(row, 'result', { enumerable: true, get() { throw new Error('read result body'); } });
  const service = createOperationService({ store: {
    mutate() { throw new Error('unexpected write'); }, read() { throw new Error('full collection read'); },
    async select(collection, { fields }) {
      assert.equal(collection, 'operations');
      return rows.map(row => {
        const result = {};
        for (const field of fields) {
          const [root, child] = field.split('.');
          if (child) (result[root] ||= {})[child] = row[root]?.[child];
          else result[root] = row[root];
        }
        return result;
      });
    },
  } });
  assert.deepEqual((await service.listReferences({ statuses: ['running', 'completed'], excludeTerminal: true }))
    .map(row => row.id), ['active']);
});

test('startup task interruption uses indexed active rows without enumerating terminal history', async () => {
  const active = { id: 'live', taskId: 'cli-task', parentSessionId: 'parent', status: 'running' };
  const history = new Proxy({}, { ownKeys() { throw new Error('enumerated historical tasks'); } });
  const draft = { tasks: history, outbox: {}, nextOutboxSequence: 1,
    select(collection, { where }) {
      assert.equal(collection, 'tasks');
      assert.deepEqual(where.status.$nin, ['completed', 'failed', 'interrupted', 'cancelled']);
      return [active];
    } };
  const service = createOperationService({ now: () => 100, store: {
    mutate: async fn => fn(draft), read: async fn => fn(draft),
  } });
  assert.equal((await service.interruptActiveTasks())[0].status, 'interrupted');
  assert.equal(draft.outbox['task:live:interrupted'].payload.taskId, 'cli-task');
  assert.equal(active.completedAt, 100);
});
