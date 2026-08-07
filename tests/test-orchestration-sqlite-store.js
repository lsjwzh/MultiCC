'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { createOperationService } = require('../src/operation-service');
const { createOrchestrationRuntime } = require('../src/orchestration-runtime');
const { createOrchestrationStore } = require('../src/orchestration-store');
const {
  OrchestrationSqliteConflictError,
  OrchestrationSqliteError,
  createOrchestrationSqliteStore,
} = require('../src/orchestration-sqlite-store');
const { createWaitService } = require('../src/wait-service');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function tempPaths(t, name = 'orchestration') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-orchestration-sqlite-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    json: path.join(dir, `${name}.json`),
    sqlite: path.join(dir, `${name}.sqlite`),
  };
}

function waitRecord(id = 'wait-1') {
  return {
    id,
    sessionId: 'session-1',
    mode: 'poll',
    status: 'pending',
    metadata: { nextAt: 10, checks: 0, tags: ['a'] },
    createdAt: 1,
    updatedAt: 1,
  };
}

function outboxRecord(id = 'outbox-1', sequence = 1) {
  return {
    id,
    sessionId: 'session-1',
    sequence,
    state: 'pending',
    availableAt: 1,
    leasedUntil: null,
    updatedAt: 1,
  };
}

test('migrates legacy JSON exactly into normalized private SQLite tables', async t => {
  const files = tempPaths(t);
  const legacy = createOrchestrationStore({ file: files.json, now: () => 10 });
  await legacy.mutate(draft => {
    draft.waits['wait-1'] = waitRecord();
    draft.outbox['outbox-1'] = outboxRecord();
    draft.operations['op-1'] = {
      id: 'op-1', kind: 'dispatch', ownerSessionId: 'owner', status: 'admitted', updatedAt: 1,
    };
    draft.tasks['task-1'] = {
      id: 'task-1', parentSessionId: 'session-1', status: 'running', updatedAt: 1,
    };
    draft.sessionSchedules['session-1'] = {
      sessionId: 'session-1', state: 'queued', updatedAt: 1,
    };
    draft.customMigrationMarker = { preserved: true };
    draft.nextOutboxSequence = 2;
  });
  const before = await legacy.snapshot();

  const store = createOrchestrationSqliteStore({
    file: files.sqlite,
    legacyFile: files.json,
    now: () => 20,
  });
  assert.equal(store.backend, 'sqlite');
  assert.equal(store.migration.migrated, true);
  assert.deepEqual(await store.snapshot(), before);
  assert.equal(fs.statSync(files.sqlite).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(files.json), true, 'legacy snapshot remains as explicit rollback source');

  const db = new Database(files.sqlite, { readonly: true });
  for (const [table, count] of [
    ['orchestration_waits', 1],
    ['orchestration_outbox', 1],
    ['orchestration_operations', 1],
    ['orchestration_tasks', 1],
    ['orchestration_session_schedules', 1],
    ['orchestration_extras', 1],
  ]) {
    assert.equal(db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count, count, table);
  }
  db.close();
  await store.close();

  const reopened = createOrchestrationSqliteStore({
    file: files.sqlite,
    legacyFile: files.json,
  });
  assert.equal(reopened.migration.migrated, false, 'existing SQLite never re-imports stale JSON');
  assert.deepEqual(await reopened.snapshot(), before);
  await reopened.close();
});

test('copy-on-write draft preserves aliases, nested operations and enumeration semantics', async t => {
  const files = tempPaths(t);
  let clock = 100;
  const store = createOrchestrationSqliteStore({ file: files.sqlite, now: () => ++clock });
  let leakedProxy;

  const raw = {
    id: 'op-1',
    kind: 'dispatch',
    ownerSessionId: 'owner',
    status: 'admitted',
    spec: { message: 'secret', tags: ['one'] },
    updatedAt: 1,
  };
  const returned = await store.mutate(draft => {
    draft.waits['wait-1'] = waitRecord();
    draft.operations['op-1'] = raw;
    draft.extension = { nested: { count: 1 }, values: ['x', 'y'] };
    // Existing domain code relies on continuing through the raw reference
    // after insertion; this must update the row that will be committed.
    raw.status = 'running';
    raw.spec.message = 'changed after insert';
    return raw;
  });
  assert.equal(returned.status, 'running');
  assert.throws(() => { returned.status = 'bypass'; }, TypeError);

  const result = await store.mutate(draft => {
    const wait = draft.waits['wait-1'];
    leakedProxy = wait;
    const metadata = wait.metadata;
    metadata.checks += 1;
    metadata.tags.push('b');
    wait.metadata = metadata;
    delete draft.operations['op-1'].spec.message;
    assert.equal(Object.prototype.hasOwnProperty.call(draft.operations['op-1'].spec, 'message'), false);
    assert.deepEqual(Object.keys(draft.waits), ['wait-1']);
    assert.equal(Object.values(draft.operations)[0].status, 'running');
    draft.extension.nested.count += 1;
    assert.equal(Object.getOwnPropertyDescriptor(draft.extension.values, 'length').value, 2);
    draft.extension.values.push('z');
    assert.equal(Object.getOwnPropertyDescriptor(draft.extension.values, 'length').value, 3);
    return JSON.parse(JSON.stringify(wait));
  });
  assert.deepEqual(result.metadata, { nextAt: 10, checks: 1, tags: ['a', 'b'] });
  assert.throws(() => { leakedProxy.status = 'late write'; }, /no longer active/);

  const snapshot = await store.snapshot();
  assert.equal(snapshot.operations['op-1'].spec.message, undefined);
  assert.deepEqual(snapshot.waits['wait-1'].metadata.tags, ['a', 'b']);
  assert.deepEqual(snapshot.extension, { nested: { count: 2 }, values: ['x', 'y', 'z'] });
  await store.close();
});

test('graceful close refreshes a current JSON rollback snapshot outside the hot path', async t => {
  const files = tempPaths(t);
  const store = createOrchestrationSqliteStore({
    file: files.sqlite,
    legacyFile: files.json,
    now: () => 500,
  });
  await store.mutate(draft => { draft.waits.rollback = waitRecord('rollback'); });
  assert.equal(fs.existsSync(files.json), false, 'new installs do not dual-write every mutation');
  await store.close();

  const rollback = createOrchestrationStore({ file: files.json });
  const snapshot = await rollback.snapshot();
  assert.ok(snapshot.waits.rollback);
  assert.equal(snapshot.revision, 1);
  assert.equal(fs.statSync(files.json).mode & 0o777, 0o600);
});

test('runtime stop checkpoints but preserves post-stop reads until explicit dispose', async t => {
  const files = tempPaths(t);
  const runtime = createOrchestrationRuntime({
    file: files.json,
    databaseFile: files.sqlite,
    runChatTurn: async () => true,
    hasPersistedDelivery: async () => false,
  });
  await runtime.store.mutate(draft => { draft.waits.readable = waitRecord('readable'); });
  await runtime.stop();
  assert.ok((await runtime.store.snapshot()).waits.readable);
  assert.ok((await createOrchestrationStore({ file: files.json }).snapshot()).waits.readable);
  await runtime.dispose();
  await assert.rejects(runtime.store.snapshot(), /database is closed/);
});

test('async mutations serialize, rollback on failure, and same-value writes do not churn revision', async t => {
  const files = tempPaths(t);
  const store = createOrchestrationSqliteStore({ file: files.sqlite });
  await store.mutate(draft => { draft.customCounter = 0; });

  const failed = store.mutate(async draft => {
    draft.customCounter = 99;
    draft.waits.discarded = waitRecord('discarded');
    await delay(5);
    throw new Error('discard transaction');
  });
  const next = store.mutate(draft => {
    draft.customCounter += 1;
    draft.waits.kept = waitRecord('kept');
    return draft.customCounter;
  });
  await assert.rejects(failed, /discard transaction/);
  assert.equal(await next, 1);
  const committed = await store.snapshot();
  assert.equal(committed.customCounter, 1);
  assert.equal(committed.waits.discarded, undefined);
  assert.ok(committed.waits.kept);

  const revision = committed.revision;
  await store.mutate(draft => {
    draft.customCounter = 1;
    draft.waits.kept.status = 'pending';
  });
  assert.equal((await store.snapshot()).revision, revision);
  await store.close();
});

test('one IMMEDIATE transaction covers multiple collections and reloads both commit windows', async t => {
  const files = tempPaths(t);
  let beforeFail = false;
  let afterFail = false;
  const store = createOrchestrationSqliteStore({
    file: files.sqlite,
    hooks: {
      beforeCommit() { if (beforeFail) throw new Error('before commit'); },
      afterCommit() { if (afterFail) throw new Error('after commit'); },
    },
  });

  beforeFail = true;
  await assert.rejects(store.mutate(draft => {
    draft.waits.before = waitRecord('before');
    draft.outbox.before = outboxRecord('before', 1);
    draft.nextOutboxSequence = 2;
  }), /before commit/);
  beforeFail = false;
  let snapshot = await store.snapshot();
  assert.equal(snapshot.waits.before, undefined);
  assert.equal(snapshot.outbox.before, undefined);
  assert.equal(snapshot.nextOutboxSequence, 1);

  afterFail = true;
  await assert.rejects(store.mutate(draft => {
    draft.waits.after = waitRecord('after');
    draft.outbox.after = outboxRecord('after', 1);
    draft.nextOutboxSequence = 2;
  }), /after commit/);
  afterFail = false;
  snapshot = await store.snapshot();
  assert.ok(snapshot.waits.after, 'committed wait reloaded after ambiguous success');
  assert.ok(snapshot.outbox.after, 'committed outbox reloaded with wait');
  assert.equal(snapshot.nextOutboxSequence, 2);
  await store.close();
});

test('concurrent store snapshots fail on stale revision instead of losing rows', async t => {
  const files = tempPaths(t);
  const first = createOrchestrationSqliteStore({ file: files.sqlite });
  const second = createOrchestrationSqliteStore({ file: files.sqlite });
  await first.mutate(draft => { draft.waits.first = waitRecord('first'); });
  await assert.rejects(
    second.mutate(draft => { draft.waits.second = waitRecord('second'); }),
    error => error instanceof OrchestrationSqliteConflictError
      && error.expectedRevision === 0
      && error.actualRevision === 1,
  );
  assert.ok((await second.snapshot()).waits.first, 'conflicting store reloads committed authority');
  await second.mutate(draft => { draft.waits.second = waitRecord('second'); });
  await first.close();
  await second.close();

  const rebuilt = createOrchestrationSqliteStore({ file: files.sqlite });
  const snapshot = await rebuilt.snapshot();
  assert.ok(snapshot.waits.first);
  assert.ok(snapshot.waits.second);
  assert.equal(snapshot.revision, 2);
  await rebuilt.close();
});

test('existing wait and operation services retain their cross-row transactions on SQLite', async t => {
  const files = tempPaths(t);
  let clock = 1_000;
  const store = createOrchestrationSqliteStore({ file: files.sqlite, now: () => ++clock });
  const waits = createWaitService({
    store,
    now: () => ++clock,
    idFactory: () => 'wait-service-1',
    callbackTokenFactory: () => 'callback-secret',
  });
  const operations = createOperationService({
    store,
    now: () => ++clock,
    idFactory: () => 'operation-service-1',
  });

  const registered = await waits.register({ sessionId: 'worker', mode: 'callback' });
  await waits.resolveCallback(registered.id, registered.token, { ok: true });
  const admitted = await operations.admitDispatch({
    ownerSessionId: 'commander',
    resultSessionId: 'commander',
    spec: {
      targetId: 'worker',
      chatId: 'worker',
      message: 'do the work',
      resultMode: 'async',
    },
  });
  await operations.completeDispatch(admitted.id, { status: 'completed', text: 'done' });

  const snapshot = await store.snapshot();
  assert.equal(snapshot.waits[registered.id].status, 'resolved');
  assert.ok(snapshot.outbox[`wait:${registered.id}`]);
  assert.equal(snapshot.operations[admitted.id].requestOutboxId,
    `operation:${admitted.id}:request`, 'raw operation alias update was persisted');
  assert.equal(snapshot.operations[admitted.id].status, 'completed');
  assert.ok(snapshot.outbox[`operation:${admitted.id}:request`]);
  assert.ok(snapshot.outbox[`operation:${admitted.id}:result`]);
  await store.close();
});

test('scrubbed task bodies are removed from both the database and truncated WAL', async t => {
  const files = tempPaths(t);
  const secret = 'SENSITIVE-DISPATCH-BODY-7ebf6c7d';
  let checkpoints = 0;
  const store = createOrchestrationSqliteStore({
    file: files.sqlite,
    hooks: { afterRedactionCheckpoint() { checkpoints += 1; } },
  });
  await store.mutate(draft => {
    draft.outbox.delivery = {
      id: 'delivery', sessionId: 'worker', sequence: 1, state: 'delivered',
      payload: { type: 'dispatch.request', message: secret }, updatedAt: 1,
    };
    draft.nextOutboxSequence = 2;
  });
  await store.mutate(draft => {
    delete draft.outbox.delivery.payload.message;
    draft.outbox.delivery.payload.messageRef = { sessionId: 'worker', deliveryId: 'delivery' };
  });
  assert.equal(checkpoints, 1);
  await store.mutate(draft => { draft.outbox.delivery.updatedAt = 2; });
  assert.equal(checkpoints, 1, 'later status changes do not repeat a redaction checkpoint');
  await store.flush();
  for (const file of [files.sqlite, `${files.sqlite}-wal`, `${files.sqlite}-shm`]) {
    if (!fs.existsSync(file)) continue;
    assert.equal(fs.readFileSync(file).includes(Buffer.from(secret)), false, file);
  }
  await store.close();
});

test('a bounded mutation serializes only its dirty row, not the full registry', async t => {
  const files = tempPaths(t);
  let observed = null;
  const store = createOrchestrationSqliteStore({
    file: files.sqlite,
    hooks: { beforeCommit({ change }) { observed = change; } },
  });
  await store.mutate(draft => {
    for (let index = 0; index < 2_000; index++) {
      draft.waits[`wait-${index}`] = waitRecord(`wait-${index}`);
    }
  });
  observed = null;
  await store.mutate(draft => { draft.waits['wait-1000'].status = 'resolved'; });
  assert.ok(observed);
  assert.equal(observed.persisted.collections.waits.size, 1);
  assert.equal(observed.persisted.collections.outbox.size, 0);
  assert.equal(observed.persisted.collections.operations.size, 0);
  assert.equal(observed.persisted.collections.tasks.size, 0);
  assert.equal(observed.persisted.collections.sessionSchedules.size, 0);
  const metrics = store.metrics();
  assert.equal(metrics.multicc_orchestration_sqlite_mutations_total, 2);
  assert.equal(metrics.multicc_orchestration_sqlite_dirty_rows_total, 2_001);
  assert.ok(metrics.multicc_orchestration_sqlite_serialized_bytes_total > 0);
  assert.ok(metrics.multicc_orchestration_sqlite_commit_ms_max >= 0);
  await store.close();
});

test('corrupt SQLite fails closed and never falls back to legacy JSON', async t => {
  const files = tempPaths(t);
  fs.writeFileSync(files.json, JSON.stringify({ harmless: true }), { mode: 0o600 });
  fs.writeFileSync(files.sqlite, 'not a sqlite database', { mode: 0o600 });
  assert.throws(
    () => createOrchestrationSqliteStore({ file: files.sqlite, legacyFile: files.json }),
    error => error instanceof OrchestrationSqliteError || error.code === 'ORCHESTRATION_STORE_CORRUPT',
  );
});

test('an existing database with a missing domain table fails closed instead of recreating it empty', async t => {
  const files = tempPaths(t);
  const store = createOrchestrationSqliteStore({ file: files.sqlite });
  await store.mutate(draft => { draft.tasks.proof = { id: 'proof', status: 'running' }; });
  await store.close();
  const db = new Database(files.sqlite);
  db.exec('DROP TABLE orchestration_tasks');
  db.close();

  assert.throws(
    () => createOrchestrationSqliteStore({ file: files.sqlite }),
    error => error.code === 'ORCHESTRATION_STORE_CORRUPT'
      && /orchestration_tasks/.test(error.message),
  );
  const verify = new Database(files.sqlite, { readonly: true });
  const table = verify.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='orchestration_tasks'",
  ).get();
  verify.close();
  assert.equal(table, undefined, 'open did not silently heal data loss');
});

test('the outbox sequence uniqueness index is part of the validated schema contract', async t => {
  const files = tempPaths(t);
  const store = createOrchestrationSqliteStore({ file: files.sqlite });
  await store.close();
  const db = new Database(files.sqlite);
  db.exec('DROP INDEX idx_orchestration_outbox_sequence');
  db.close();
  assert.throws(
    () => createOrchestrationSqliteStore({ file: files.sqlite }),
    error => error.code === 'ORCHESTRATION_STORE_CORRUPT'
      && /idx_orchestration_outbox_sequence/.test(error.message),
  );
});

test('private file permissions fail closed instead of being silently ignored', async t => {
  const files = tempPaths(t);
  const store = createOrchestrationSqliteStore({ file: files.sqlite });
  await store.close();
  const fsImpl = new Proxy(fs, {
    get(target, property) {
      if (property === 'chmodSync') {
        return file => {
          const error = new Error(`permission denied: ${file}`);
          error.code = 'EACCES';
          throw error;
        };
      }
      return Reflect.get(target, property);
    },
  });
  assert.throws(
    () => createOrchestrationSqliteStore({ file: files.sqlite, fsImpl }),
    error => error instanceof OrchestrationSqliteError && /permission denied/.test(error.message),
  );
});

test('better-sqlite3 is a direct dependency with install/update self-healing guards', () => {
  const root = path.join(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  assert.ok(manifest.dependencies['better-sqlite3']);
  assert.equal(
    lock.packages[''].dependencies['better-sqlite3'],
    manifest.dependencies['better-sqlite3'],
  );

  const installer = fs.readFileSync(path.join(root, 'install.sh'), 'utf8');
  const launcher = fs.readFileSync(path.join(root, 'multicc'), 'utf8');
  const nativeCheck = fs.readFileSync(path.join(root, 'scripts/check-native-deps.js'), 'utf8');
  assert.match(installer, /npm install/);
  assert.match(installer, /npm rebuild better-sqlite3 --foreground-scripts/);
  assert.match(launcher, /npm install/);
  assert.match(launcher, /npm rebuild better-sqlite3 --foreground-scripts/);
  assert.match(nativeCheck, /new Database\(':memory:'\)/);
});
