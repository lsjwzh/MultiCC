'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');
const { createOperationService } = require('../src/operation-service');
const { createOrchestrationRuntime } = require('../src/orchestration/runtime');
const { createOrchestrationStore } = require('../src/orchestration/store');
const {
  OrchestrationSqliteConflictError,
  OrchestrationSqliteError,
  createOrchestrationSqliteStore,
} = require('../src/orchestration/sqlite-store');
const { createWaitService } = require('../src/wait/service');

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
  assert.equal(store.migration.legacyDigest, require('./helpers/orchestration-sqlite-oracle')._stateDigest(before));
  assert.deepEqual(await store.snapshot(), before);
  // Windows exposes synthetic POSIX mode bits; owner-only mode is a POSIX contract.
  if (process.platform !== 'win32') assert.equal(fs.statSync(files.sqlite).mode & 0o777, 0o600);
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

test('assigning a spread of a draft record materialises nested proxies instead of leaking them', async t => {
  const files = tempPaths(t);
  const store = createOrchestrationSqliteStore({ file: files.sqlite, now: () => 100 });
  await store.mutate(draft => {
    draft.outbox['outbox-1'] = {
      ...outboxRecord(),
      payload: {
        type: 'session.work',
        message: 'old text',
        options: { clientMsgId: 'c-1', attachments: [{ name: 'a.txt' }] },
      },
    };
  });

  // Editing a queued message rebuilds the payload by spreading the draft record:
  // nested members arrive as draft proxies. Storing them used to wrap a proxy in
  // another proxy, and the next read recursed until "Maximum call stack size
  // exceeded" (the edit always failed while other queue actions still worked).
  const result = await store.mutate(draft => {
    const item = draft.outbox['outbox-1'];
    const payload = { ...item.payload, message: 'new text' };
    item.payload = payload;
    return payload;
  });
  assert.equal(result.message, 'new text');

  const snapshot = await store.snapshot();
  assert.deepEqual(snapshot.outbox['outbox-1'].payload, {
    type: 'session.work',
    message: 'new text',
    options: { clientMsgId: 'c-1', attachments: [{ name: 'a.txt' }] },
  });
  // A later mutation must be able to read and write the record again.
  await store.mutate(draft => { draft.outbox['outbox-1'].payload.message = 'newer text'; });
  assert.equal((await store.snapshot()).outbox['outbox-1'].payload.message, 'newer text');
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
  // Windows exposes synthetic POSIX mode bits; owner-only mode is a POSIX contract.
  if (process.platform !== 'win32') assert.equal(fs.statSync(files.json).mode & 0o777, 0o600);
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

test('native store rejects injected JavaScript database and filesystem ports', t => {
  const files = tempPaths(t);
  for (const [name, value] of [['Database', Database], ['fsImpl', fs], ['pathImpl', path]]) {
    assert.throws(
      () => createOrchestrationSqliteStore({ file: files.sqlite, [name]: value }),
      error => error instanceof TypeError && error.message.includes(name)
        && /unsupported by the Rust store/.test(error.message),
    );
  }
  assert.equal(fs.existsSync(files.sqlite), false);
});

test('native database creation fails closed when its directory is not writable', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, t => {
  const files = tempPaths(t);
  fs.chmodSync(files.dir, 0o500);
  try {
    assert.throws(
      () => createOrchestrationSqliteStore({ file: files.sqlite }),
      error => error instanceof OrchestrationSqliteError && /permission denied/i.test(error.message),
    );
    assert.equal(fs.existsSync(files.sqlite), false);
  } finally { fs.chmodSync(files.dir, 0o700); }
});

test('storage uses the Rust driver; the npm addon remains a development oracle', () => {
  const root = path.join(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  assert.equal(manifest.dependencies['better-sqlite3'], undefined,
    'a compiled addon must not be a production dependency: it is what forced every bundle to match an ABI');
  // Kept as a devDependency on purpose: tests/test-sqlite-driver.js runs the
  // same statements through both engines, so a behavior change in the built-in
  // SQLite shows up as a failure instead of as silently different data.
  assert.ok(manifest.devDependencies['better-sqlite3'], 'the cross-driver oracle must stay available to tests');

  const driver = fs.readFileSync(path.join(root, 'src/sqlite/driver.js'), 'utf8');
  assert.match(driver, /RustDatabase/);
  assert.doesNotMatch(driver, /require\('node:sqlite'\)/);
  for (const file of ['src/task-shell/store.js',
    'src/orchestration/sqlite-store.js', 'src/sqlite-runtime.js']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    // task-shell 仓储迁移后不再经 JS 打开 SQLite：整个 store 由原生
    // RustTaskStore 承载，同属“只用 Rust、绝不碰 npm addon”的边界。
    assert.match(source, /sqlite\/driver|RustTaskStore|RustOrchestrationStore/, `${file} must use the shared driver or the native Rust store`);
    assert.doesNotMatch(source, /require\('better-sqlite3'\)/, `${file} must not require the addon`);
  }

  // The quota compatibility facade delegates to a Node lifecycle adapter, but
  // the adapter must submit storage operations to the Rust-owned store. Keep
  // both dependency boundaries explicit so a Node SQLite fallback cannot hide
  // behind either module.
  const quotaFacade = fs.readFileSync(path.join(root, 'src/quota/provider-limit-cache.js'), 'utf8');
  const quotaHost = fs.readFileSync(path.join(root, 'src/quota/provider-limit-cache-native-host.js'), 'utf8');
  const dependencies = source => [...source.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)]
    .map(match => match[1]);
  assert.deepEqual(dependencies(quotaFacade), ['./provider-limit-cache-native-host']);
  assert.deepEqual(dependencies(quotaHost), ['../native/runtime']);
  assert.equal(require('../src/quota/provider-limit-cache').createProviderLimitCache,
    require('../src/quota/provider-limit-cache-native-host').createNativeProviderLimitCache);
  assert.match(quotaHost, /new\s+addon\.RustProviderLimitStore\s*\(/);
  assert.match(quotaHost, /handle\.requestAsync\s*\(\s*op\s*,\s*input\s*\)/);
  for (const source of [quotaFacade, quotaHost]) {
    assert.doesNotMatch(source, /(?:node:sqlite|better-sqlite3|sqlite\/driver)/,
      'quota facade and host must not use a Node SQLite driver');
  }
  const quotaAddon = fs.readFileSync(path.join(root, 'native/addon/src/provider_limit_store.rs'), 'utf8');
  const quotaCore = fs.readFileSync(path.join(root, 'native/core/src/provider_limit_store.rs'), 'utf8');
  assert.match(quotaAddon, /provider_limit_store::Store/);
  assert.match(quotaAddon, /Store::open\s*\(/);
  assert.match(quotaCore, /use\s+rusqlite::/);

  // install.sh and the ./multicc manager used to carry a "rebuild the native
  // binding" hatch. Nothing is compiled any more, so that repair path would
  // have been a lie told to whoever hit it.
  const installer = fs.readFileSync(path.join(root, 'install.sh'), 'utf8');
  const manager = fs.readFileSync(path.join(root, 'multicc'), 'utf8');
  for (const [file, text] of [['install.sh', installer], ['multicc', manager]]) {
    assert.doesNotMatch(text, /npm rebuild better-sqlite3/,
      `${file} must not advertise a rebuild that cannot help`);
  }
  // The standalone installer only downloads a package containing its own Node
  // runtime. The installed manager is the component that actually executes the
  // SQLite capability probe, so it owns the actionable runtime diagnostic.
  assert.match(installer, /package carries its own Node runtime/);
  assert.match(manager, /SQLite/, 'the manager must explain what its runtime check failed on');
  const sqliteCheck = fs.readFileSync(path.join(root, 'scripts/check-sqlite-runtime.js'), 'utf8');
  assert.match(sqliteCheck, /new Database\(':memory:'\)/);
});

test('native selectors preserve missing/null and numeric types, projection and read-your-writes', async t => {
  const files = tempPaths(t);
  const store = createOrchestrationSqliteStore({ file: files.sqlite });
  await store.mutate(draft => {
    draft.tasks.a = { id: 'a', status: 'running', n: 0, spec: { chatId: 's', message: 'not projected' } };
    draft.tasks.b = { id: 'b', status: null, n: '0' };
    draft.tasks.c = { id: 'c' };
    draft.tasks.done = { id: 'done', status: 'completed' };
  });
  assert.deepEqual(await store.select('tasks', { where: { status: null }, fields: ['id'] }), [{ id: 'b' }]);
  assert.deepEqual(await store.select('tasks', { where: { status: { $nin: [null, 'completed'] } }, fields: ['id'] }), [{ id: 'a' }, { id: 'c' }]);
  assert.deepEqual(await store.select('tasks', { where: { n: { $lte: 0 } }, fields: ['id', 'spec.chatId'] }), [{ id: 'a', spec: { chatId: 's' } }]);
  assert.equal(await store.read(state => Object.getOwnPropertyDescriptor(state.tasks.a, 'status').value), 'running');
  let leaked;
  await store.mutate(draft => {
    assert.equal(Object.keys(draft).includes('select'), false);
    assert.equal(Object.keys(draft).includes('count'), false);
    const [row] = draft.select('tasks', { where: { status: 'running' } });
    leaked = row;
    row.status = 'completed';
    draft.tasks.new = { id: 'new', status: 'running' };
    delete draft.tasks.c;
    assert.equal(draft.count('tasks', { status: 'running' }), 1);
    assert.deepEqual(draft.select('tasks', { where: { status: 'running' } }).map(task => task.id), ['new']);
    assert.equal(draft.count('tasks', { status: 'completed' }), 2);
  });
  assert.throws(() => leaked.status, /no longer active/);
  assert.throws(() => Object.keys(leaked), /no longer active/);
  const snapshot = await store.snapshot();
  assert.equal(Object.hasOwn(snapshot, 'select'), false);
  assert.equal(Object.hasOwn(snapshot, 'count'), false);
  await store.close();
});

test('streaming native rollback export preserves metadata and refuses live database targets', async t => {
  const files = tempPaths(t);
  const store = createOrchestrationSqliteStore({ file: files.sqlite });
  await store.mutate(draft => {
    draft.tasks['10'] = { id: '10', status: 'completed', result: 'preserved result body', nested: { z: 2, a: 1 } };
    draft.tasks['2'] = { id: '2', status: 'running' };
    draft.extra = { '10': true, '2': false, z: 'last', a: ['first'] };
  });
  const before = await store.snapshot();
  await assert.rejects(store.exportLegacy(files.sqlite), /export target/);
  await assert.rejects(store.exportLegacy(`${files.sqlite}-wal`), /export target/);
  if (process.platform !== 'win32') {
    const link = path.join(files.dir, 'database-alias.json');
    fs.linkSync(files.sqlite, link);
    await assert.rejects(store.exportLegacy(link), /export target/);
    fs.unlinkSync(link);
  }
  const report = require('../scripts/export-orchestration-sqlite').exportSnapshot({
    databaseFile: files.sqlite, targetFile: files.json,
  });
  assert.equal(report.databaseFile, files.sqlite);
  assert.equal(report.targetFile, files.json);
  assert.equal(report.revision, before.revision);
  assert.equal(report.digest, require('./helpers/orchestration-sqlite-oracle')._stateDigest(before));
  assert.deepEqual(JSON.parse(fs.readFileSync(files.json, 'utf8')), before);
  const oracle = new Database(files.sqlite, { readonly: true });
  try {
    assert.deepEqual(require('./helpers/orchestration-sqlite-oracle')._loadDatabaseState(oracle, files.sqlite), before);
  } finally { oracle.close(); }
  await store.close();
});

test('large terminal history opens and selects active candidates under a bounded Node heap', async t => {
  const files = tempPaths(t);
  const empty = createOrchestrationSqliteStore({ file: files.sqlite });
  await empty.close();
  // Seed outside the child process. No real database is read or modified.
  const seed = new Database(files.sqlite);
  const insert = seed.prepare('INSERT INTO orchestration_tasks(id,data_json,parent_session_id,status,updated_at) VALUES (?,?,?,?,?)');
  const payload = 'historical output '.repeat(1400);
  seed.transaction(() => {
    for (let i = 0; i < 6000; i++) {
      const id = `history-${i}`;
      insert.run(id, JSON.stringify({ id, status: 'completed', result: payload, updatedAt: 1 }), null, 'completed', 1);
    }
    insert.run('active', JSON.stringify({ id: 'active', status: 'running', updatedAt: 1 }), null, 'running', 1);
  })();
  seed.close();
  const script = String.raw`
    const assert = require('node:assert/strict');
    const { createOrchestrationSqliteStore } = require('./src/orchestration/sqlite-store');
    (async () => {
      const store = createOrchestrationSqliteStore({ file: process.argv[1] });
      assert.equal(await store.count('tasks', {}), 6001);
      assert.deepEqual(await store.select('tasks', {
        where: { status: { $nin: ['completed', 'failed', 'cancelled'] } }, fields: ['id', 'status'],
      }), [{ id: 'active', status: 'running' }]);
      await store.mutate(draft => {
        const [row] = draft.select('tasks', { where: { status: 'running' } });
        row.status = 'completed';
      });
      assert.equal(await store.read(state => state.tasks.active.status), 'completed');
      assert.ok(store.metrics().multicc_orchestration_sqlite_materialized_bytes_total < 512 * 1024);
      await store.close();
      process.stdout.write('bounded-history-ok');
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const child = spawnSync(process.execPath, ['--max-old-space-size=80', '-e', script, files.sqlite], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 90_000,
    env: { ...process.env }, maxBuffer: 1024 * 1024,
  });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  assert.match(child.stdout, /bounded-history-ok/);
});


test('native JSON boundaries preserve sliced UTF-16 strings and nested property names', async t => {
  const files = tempPaths(t);
  const legacy = createOrchestrationStore({ file: files.json, now: () => 10 });
  const high = '😀'.slice(0, 1);
  const low = '😀'.slice(1);
  const record = { id: 'utf16', status: 'running', lastLine: high,
    nested: { [low]: [high, low, '完整😀'], 'quoted"key': low, '10': high, '2': low } };
  await legacy.mutate(draft => { draft.tasks.utf16 = record; draft.extra = { [high]: low }; });
  const before = await legacy.snapshot();
  const store = createOrchestrationSqliteStore({ file: files.sqlite, legacyFile: files.json });
  assert.deepEqual(await store.snapshot(), before);
  assert.equal(store.migration.legacyDigest, require('./helpers/orchestration-sqlite-oracle')._stateDigest(before));
  assert.equal(await store.read(state => state.tasks.utf16.nested[low][0]), high);
  assert.equal(await store.read(state => state.tasks.utf16.nested['quoted"key']), low);
  assert.deepEqual(await store.select('tasks', { fields: ['id', 'status', 'lastLine', 'nested'] }), [record]);
  assert.equal(await store.count('tasks', { lastLine: high }), 1);
  assert.equal(await store.count('tasks', { lastLine: '�' }), 0);
  await store.mutate(draft => {
    draft.tasks.utf16.lastLine = low;
    draft.tasks.utf16.nested[low].push(high);
    assert.equal(draft.count('tasks', { lastLine: low }), 1);
    assert.equal(draft.select('tasks', { fields: ['lastLine'] })[0].lastLine, low);
  });
  const expected = await store.snapshot();
  const exported = await store.exportLegacy(files.json);
  assert.equal(exported.digest, require('./helpers/orchestration-sqlite-oracle')._stateDigest(expected));
  assert.deepEqual(JSON.parse(fs.readFileSync(files.json, 'utf8')), expected);
  await store.close({ exportRollback: false });
  const reopened = createOrchestrationSqliteStore({ file: files.sqlite });
  assert.deepEqual(await reopened.snapshot(), expected);
  await reopened.close();
});


test('capacity maintenance runs early but preserves recent receipts until the retention horizon', async t => {
  const files = tempPaths(t);
  let clock = 1_800_000_000_000;
  const store = createOrchestrationSqliteStore({ file: files.sqlite, now: () => clock,
    retention: { maxRecords: 2 } });
  await store.mutate(draft => {
    for (const id of ['a', 'b']) draft.tasks[id] = { id, status: 'completed',
      completedAt: clock - 1, updatedAt: clock - 1 };
  });
  const first = await store.pruneRetained();
  assert.equal(first.deletedTasks, 0);
  assert.equal(first.capacityTriggered, false);
  clock += 1;
  await store.mutate(draft => { draft.tasks.newest = { id: 'newest', status: 'completed',
    completedAt: clock, updatedAt: clock }; });
  clock += 60_000; // Still well before the one-hour expiry interval.
  const capacity = await store.pruneRetained();
  assert.equal(capacity.capacityTriggered, true);
  assert.equal(capacity.deletedTasks, 0);
  assert.equal(await store.count('tasks'), 3);
  assert.equal(await store.read(state => state.tasks.newest.id), 'newest');
  clock += 1;
  await store.mutate(draft => { draft.tasks.newest.lastLine = 'revision refreshed after maintenance'; });
  clock += 31 * 24 * 60 * 60 * 1000;
  const expired = await store.pruneRetained();
  assert.equal(expired.capacityTriggered, true);
  assert.equal(expired.deletedTasks, 3, 'expiry cleanup is not limited to the one-row capacity excess');
  assert.equal(await store.count('tasks'), 0);
  await store.close();
});
